#include "gxf_channel.h"

#include <IOSurface/IOSurfaceRef.h>
#include <servers/bootstrap.h>

#include <algorithm>
#include <climits>
#include <cstring>
#include <ctime>

namespace gxf {

namespace {

constexpr mach_msg_option_t kReceiveOptions =
    MACH_RCV_MSG | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT);

uint32_t Clamp32(size_t value) { return value > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(value); }

// Metadata only: none of these calls locks or maps the surface.
gxf_surface_info Describe(IOSurfaceRef surface) {
  gxf_surface_info info{};
  info.surface_id = IOSurfaceGetID(surface);
  info.width = Clamp32(IOSurfaceGetWidth(surface));
  info.height = Clamp32(IOSurfaceGetHeight(surface));
  info.pixel_format = IOSurfaceGetPixelFormat(surface);
  info.plane_count = Clamp32(IOSurfaceGetPlaneCount(surface));
  info.bytes_per_element = Clamp32(IOSurfaceGetBytesPerElement(surface));
  info.element_width = Clamp32(IOSurfaceGetElementWidth(surface));
  info.element_height = Clamp32(IOSurfaceGetElementHeight(surface));
  info.bytes_per_row = IOSurfaceGetBytesPerRow(surface);
  info.alloc_size = IOSurfaceGetAllocSize(surface);
  return info;
}

bool IsRunIdChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
}

}  // namespace

uint64_t MonotonicMicros() { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000; }

uint64_t RealtimeMicros() {
  timespec ts{};
  clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000000u + static_cast<uint64_t>(ts.tv_nsec) / 1000u;
}

bool ValidRunId(const std::string& run_id) {
  if (run_id.size() < GXF_RUN_ID_MIN || run_id.size() > GXF_RUN_ID_MAX) return false;
  return std::all_of(run_id.begin(), run_id.end(), IsRunIdChar);
}

Channel::~Channel() { Close(); }

kern_return_t Channel::Open(const std::string& run_id, uint32_t max_fps, uint32_t burst, Clock clock) {
  std::lock_guard<std::mutex> lock(mu_);
  if (open_) return KERN_FAILURE;
  if (!ValidRunId(run_id)) return KERN_INVALID_ARGUMENT;
  gxf_state_init(&state_, max_fps, burst);
  clock_ = clock != nullptr ? clock : MonotonicMicros;
  service_name_ = std::string(GXF_SERVICE_PREFIX) + run_id;
  const mach_port_t task = mach_task_self();
  kern_return_t kr = bootstrap_check_in(bootstrap_port, service_name_.c_str(), &service_);
  if (kr != KERN_SUCCESS) {
    service_ = MACH_PORT_NULL;
    return kr;
  }
  mach_port_limits_t limits{kQueueLimit};
  kr = mach_port_set_attributes(task, service_, MACH_PORT_LIMITS_INFO, reinterpret_cast<mach_port_info_t>(&limits),
                                MACH_PORT_LIMITS_INFO_COUNT);
  if (kr == KERN_SUCCESS) kr = mach_port_allocate(task, MACH_PORT_RIGHT_RECEIVE, &wake_);
  if (kr == KERN_SUCCESS) kr = mach_port_insert_right(task, wake_, wake_, MACH_MSG_TYPE_MAKE_SEND);
  if (kr == KERN_SUCCESS) kr = mach_port_allocate(task, MACH_PORT_RIGHT_PORT_SET, &set_);
  if (kr == KERN_SUCCESS) kr = mach_port_insert_member(task, service_, set_);
  if (kr == KERN_SUCCESS) kr = mach_port_insert_member(task, wake_, set_);
  open_ = true;
  if (kr != KERN_SUCCESS) {
    std::vector<IOSurfaceRef> none;
    CloseLocked(&none);
  }
  return kr;
}

bool Channel::SetPeer(pid_t pid) {
  std::lock_guard<std::mutex> lock(mu_);
  if (pid <= 0) return false;
  if (state_.peer_pid != 0 && state_.peer_pid != pid) return false;
  state_.peer_pid = pid;
  return true;
}

gxf_ring_error Channel::ExpectRing(uint32_t generation, uint32_t width, uint32_t height, uint32_t slots) {
  size_t aligned = 0;
  if (width > 0 && width <= GXF_MAX_SIDE)
    aligned = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, static_cast<size_t>(width) * GXF_BYTES_PER_PIXEL);
  gxf_ring_expect ring{};
  gxf_ring_error error = gxf_ring_expect_init(&ring, generation, width, height, slots, aligned);
  if (error != GXF_RING_OK) return error;
  std::lock_guard<std::mutex> lock(mu_);
  if (generation <= state_.last_generation) return GXF_RING_BAD_GENERATION;
  size_t held = static_cast<size_t>(
      std::count_if(std::begin(held_), std::end(held_), [](IOSurfaceRef s) { return s != nullptr; }));
  if (retired_.size() + held > kMaxRetiredHeld) return GXF_RING_TOO_MANY_HELD;
  for (uint16_t slot = 0; slot < GXF_MAX_SLOTS; slot++) {
    if (held_[slot] == nullptr) continue;
    retired_.push_back(Retired{state_.ring.generation, slot, state_.slots[slot].held_seq, held_[slot]});
    held_[slot] = nullptr;
  }
  return gxf_state_set_ring(&state_, &ring);
}

Event Channel::ReceiveOne(mach_msg_timeout_t timeout_ms) {
  mach_port_t set = MACH_PORT_NULL;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!open_) return Event{};
    set = set_;
  }
  gxf_receive_buffer buffer;
  std::memset(&buffer, 0, sizeof buffer);
  mach_msg_option_t options = kReceiveOptions;
  if (timeout_ms != MACH_MSG_TIMEOUT_NONE) options |= MACH_RCV_TIMEOUT;
  kern_return_t kr = mach_msg(&buffer.msg.header, options, 0, sizeof buffer, set, timeout_ms, MACH_PORT_NULL);
  if (kr == MACH_RCV_TIMED_OUT || kr == MACH_RCV_INTERRUPTED) return Event{};
  std::lock_guard<std::mutex> lock(mu_);
  if (kr == MACH_RCV_TOO_LARGE) {
    // Without MACH_RCV_LARGE the kernel dequeued and destroyed the message and its rights.
    state_.counters.received++;
    return Refuse(GXF_E_OVERSIZE, nullptr);
  }
  if (kr != MACH_MSG_SUCCESS) return Refuse(GXF_E_RECEIVE_FAILED, nullptr);
  if (buffer.msg.header.msgh_local_port == wake_) {
    mach_msg_destroy(&buffer.msg.header);
    Event woken;
    woken.kind = Event::Kind::kWoken;
    return woken;
  }
  Event event = Handle(&buffer);
  // Drops the surface send right (and anything a refused message carried); the lookup holds
  // its own reference.
  mach_msg_destroy(&buffer.msg.header);
  return event;
}

Event Channel::Handle(gxf_receive_buffer* buffer) {
  state_.counters.received++;
  if (state_.fault != GXF_OK) {
    state_.counters.dropped++;
    Event dropped;
    dropped.kind = Event::Kind::kDropped;
    dropped.code = state_.fault;
    return dropped;
  }
  gxf_frame_meta meta{};
  gxf_code code = gxf_parse(buffer, sizeof *buffer, &meta);
  if (code != GXF_OK) return Refuse(code, nullptr);
  code = gxf_check_frame(&state_, &meta, clock_());
  if (code != GXF_OK) return Refuse(code, &meta);
  return Accept(meta);
}

Event Channel::Accept(const gxf_frame_meta& meta) {
  IOSurfaceRef surface = IOSurfaceLookupFromMachPort(meta.port);
  if (surface == nullptr) return Refuse(GXF_E_NOT_IOSURFACE, &meta);
  gxf_surface_info info = Describe(surface);
  gxf_code code = gxf_check_surface(&state_, &meta, &info);
  if (code != GXF_OK) {
    CFRelease(surface);
    return Refuse(code, &meta);
  }
  gxf_commit_frame(&state_, &meta, &info);
  held_[meta.slot] = surface;
  Event event;
  event.kind = Event::Kind::kFrame;
  event.has_slot = true;
  event.generation = meta.generation;
  event.slot = meta.slot;
  event.frame = Frame{meta.generation, meta.slot,   meta.seq,        meta.ts_us, RealtimeMicros(),
                      info.width,      info.height, info.surface_id, surface};
  return event;
}

Event Channel::Refuse(gxf_code code, const gxf_frame_meta* meta) {
  const bool was_faulted = state_.fault != GXF_OK;
  gxf_state_refuse(&state_, code);
  Event event;
  event.code = code;
  event.kind = gxf_code_is_fatal(code) && !was_faulted ? Event::Kind::kError : Event::Kind::kDropped;
  if (meta != nullptr) {
    event.has_slot = true;
    event.generation = meta->generation;
    event.slot = meta->slot;
  }
  return event;
}

bool Channel::Release(uint32_t generation, uint16_t slot, uint64_t seq) {
  IOSurfaceRef surface = nullptr;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (gxf_state_release(&state_, generation, slot, seq)) {
      surface = held_[slot];
      held_[slot] = nullptr;
    } else {
      auto it = std::find_if(retired_.begin(), retired_.end(), [&](const Retired& r) {
        return r.generation == generation && r.slot == slot && r.seq == seq;
      });
      if (it != retired_.end()) {
        surface = it->surface;
        retired_.erase(it);
        state_.counters.released++;
      }
    }
  }
  if (surface != nullptr) CFRelease(surface);
  return surface != nullptr;
}

void Channel::Wake() {
  mach_port_t wake = MACH_PORT_NULL;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!open_) return;
    wake = wake_;
  }
  mach_msg_header_t header{};
  header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  header.msgh_size = sizeof header;
  header.msgh_remote_port = wake;
  mach_msg(&header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof header, 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
}

void Channel::Fault(gxf_code code) {
  std::lock_guard<std::mutex> lock(mu_);
  gxf_state_refuse(&state_, code);
}

void Channel::CloseLocked(std::vector<IOSurfaceRef>* surfaces) {
  open_ = false;
  for (IOSurfaceRef& s : held_) {
    if (s != nullptr) surfaces->push_back(s);
    s = nullptr;
  }
  for (const Retired& r : retired_) surfaces->push_back(r.surface);
  retired_.clear();
  const mach_port_t task = mach_task_self();
  if (set_ != MACH_PORT_NULL) mach_port_mod_refs(task, set_, MACH_PORT_RIGHT_PORT_SET, -1);
  // Destroying the receive right ends the service: launchd forgets the name, and messages still
  // queued are destroyed with their rights.
  if (service_ != MACH_PORT_NULL) mach_port_mod_refs(task, service_, MACH_PORT_RIGHT_RECEIVE, -1);
  if (wake_ != MACH_PORT_NULL) mach_port_destruct(task, wake_, -1, 0);
  set_ = service_ = wake_ = MACH_PORT_NULL;
}

void Channel::Close() {
  std::vector<IOSurfaceRef> surfaces;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (!open_ && service_ == MACH_PORT_NULL) return;
    CloseLocked(&surfaces);
  }
  for (IOSurfaceRef s : surfaces) CFRelease(s);
}

Stats Channel::GetStats() {
  std::lock_guard<std::mutex> lock(mu_);
  Stats stats;
  stats.counters = state_.counters;
  stats.generation = state_.has_ring ? state_.ring.generation : 0;
  for (uint32_t slot = 0; slot < GXF_MAX_SLOTS; slot++) {
    if (held_[slot] != nullptr) stats.held_mask |= 1u << slot;
  }
  stats.retired_held = retired_.size();
  stats.fault = state_.fault;
  stats.peer = state_.peer_pid;
  stats.open = open_;
  return stats;
}

}  // namespace gxf
