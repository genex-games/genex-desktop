// The receive core against the real kernel: check-in, frames from the sender library, hostile
// messages built with raw mach_msg, slot ownership across a resize, wake, close, and no leaked
// port rights. Runs unsandboxed in one process (the sender is this process, so the peer is
// getpid()). Built with ASan and UBSan.
#include <IOSurface/IOSurfaceRef.h>
#include <servers/bootstrap.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "gxf_channel.h"
#include "gxf_sender.h"

namespace {

int failures = 0;
int checks = 0;

#define EXPECT(cond, label)                                                    \
  do {                                                                         \
    checks++;                                                                  \
    if (!(cond)) {                                                             \
      failures++;                                                              \
      std::fprintf(stderr, "FAIL %s: %s (line %d)\n", label, #cond, __LINE__); \
    }                                                                          \
  } while (0)

constexpr uint32_t kW = 256;
constexpr uint32_t kH = 128;

std::string RandomRunId() {
  unsigned char bytes[6];
  arc4random_buf(bytes, sizeof bytes);
  char hex[13];
  for (int i = 0; i < 6; i++) std::snprintf(hex + i * 2, 3, "%02x", bytes[i]);
  return std::string("test-") + hex;
}

mach_msg_type_number_t PortNameCount() {
  mach_port_name_array_t names = nullptr;
  mach_port_type_array_t types = nullptr;
  mach_msg_type_number_t name_count = 0, type_count = 0;
  mach_port_names(mach_task_self(), &names, &name_count, &types, &type_count);
  vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(names), name_count * sizeof *names);
  vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(types), type_count * sizeof *types);
  return name_count;
}

IOSurfaceRef CreateSurface(uint32_t width, uint32_t height, uint32_t format, uint32_t bytes_per_row) {
  CFMutableDictionaryRef props =
      CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  auto set = [&](CFStringRef key, int32_t value) {
    CFNumberRef number = CFNumberCreate(nullptr, kCFNumberSInt32Type, &value);
    CFDictionarySetValue(props, key, number);
    CFRelease(number);
  };
  set(kIOSurfaceWidth, static_cast<int32_t>(width));
  set(kIOSurfaceHeight, static_cast<int32_t>(height));
  set(kIOSurfaceBytesPerElement, 4);
  set(kIOSurfacePixelFormat, static_cast<int32_t>(format));
  if (bytes_per_row != 0) set(kIOSurfaceBytesPerRow, static_cast<int32_t>(bytes_per_row));
  IOSurfaceRef surface = IOSurfaceCreate(props);
  CFRelease(props);
  return surface;
}

// An open channel with a ring announced, a connected sender and the ring created.
struct Fixture {
  gxf::Channel channel;
  gxf_sender sender{};
  gxf_ring ring{};
  uint64_t seq = 0;

  explicit Fixture(bool announce = true, uint32_t max_fps = 240, uint32_t burst = 6) {
    kern_return_t kr = channel.Open(RandomRunId(), max_fps, burst);
    EXPECT(kr == KERN_SUCCESS, "fixture: check-in");
    channel.SetPeer(getpid());
    if (announce) EXPECT(channel.ExpectRing(1, kW, kH, 3) == GXF_RING_OK, "fixture: ring");
    EXPECT(gxf_sender_connect(&sender, channel.service_name().c_str()) == KERN_SUCCESS, "fixture: look-up");
    EXPECT(gxf_ring_create(&ring, 1, kW, kH, 3) == 0, "fixture: surfaces");
  }
  ~Fixture() {
    channel.Close();
    gxf_ring_destroy(&ring);
    gxf_sender_disconnect(&sender);
  }
  kern_return_t Send(uint32_t slot) { return gxf_send_frame(&sender, &ring, slot, ++seq, gxf_realtime_us(), 100); }
  gxf::Event Receive() { return channel.ReceiveOne(1000); }
  kern_return_t SendRaw(mach_msg_header_t* header, mach_msg_size_t size) {
    header->msgh_remote_port = sender.service;
    header->msgh_size = size;
    return mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, size, 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
  }
  // The hostile message is refused with `code`, and the run is faulted afterwards.
  void ExpectRefusal(gxf_code code, const char* label) {
    gxf::Event event = Receive();
    char text[200];
    std::snprintf(text, sizeof text, "%s: refused as %s (got kind %d code %s)", label, gxf_code_name(code),
                  static_cast<int>(event.kind), gxf_code_name(event.code));
    EXPECT(event.kind == gxf::Event::Kind::kError && event.code == code, text);
    EXPECT(Send(0) == KERN_SUCCESS, label);
    gxf::Event after = Receive();
    std::snprintf(text, sizeof text, "%s: nothing accepted after the fault", label);
    EXPECT(after.kind == gxf::Event::Kind::kDropped, text);
    EXPECT(channel.GetStats().fault == code && channel.GetStats().held_mask == 0, label);
  }
};

void TestRunIds() {
  const char* bad[] = {"",
                       "short",
                       "has.dot-12345",
                       "has/slash12345",
                       "spaces 1234567",
                       "\xc3\xbcnicode12345",
                       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" /* 65 */};
  for (const char* id : bad) {
    gxf::Channel channel;
    EXPECT(channel.Open(id, 0, 0) == KERN_INVALID_ARGUMENT, id);
  }
  EXPECT(gxf::ValidRunId("abcdef12"), "8 characters");
  EXPECT(gxf::ValidRunId(std::string(64, 'a')), "64 characters");
}

void TestHappyPathAndResize() {
  Fixture f;
  for (uint32_t slot = 0; slot < 3; slot++) {
    EXPECT(f.Send(slot) == KERN_SUCCESS, "send");
    gxf::Event event = f.Receive();
    EXPECT(event.kind == gxf::Event::Kind::kFrame, "frame accepted");
    EXPECT(event.frame.slot == slot && event.frame.generation == 1 && event.frame.seq == slot + 1, "frame fields");
    EXPECT(event.frame.surface_id == IOSurfaceGetID(f.ring.surfaces[slot]), "same IOSurface");
    EXPECT(event.frame.width == kW && event.frame.height == kH, "size");
    EXPECT(event.frame.surface != nullptr && IOSurfaceGetID(event.frame.surface) == event.frame.surface_id,
           "usable IOSurfaceRef");
  }
  EXPECT(f.channel.GetStats().held_mask == 0x7, "three held");
  EXPECT(!f.channel.Release(1, 0, 2), "release naming another frame");
  EXPECT(f.channel.Release(1, 0, 1), "release");
  EXPECT(!f.channel.Release(1, 0, 1), "release twice");
  EXPECT(!f.channel.Release(2, 1, 2), "release a generation that does not exist");
  EXPECT(f.Send(0) == KERN_SUCCESS, "reuse slot 0");
  EXPECT(f.Receive().kind == gxf::Event::Kind::kFrame, "slot 0 again");
  EXPECT(!f.channel.Release(1, 0, 1), "a stale release keeps the newer frame (seq 4) held");

  // Resize with slots 0..2 held: they move to the retired list and stay retained.
  EXPECT(f.channel.ExpectRing(1, 64, 64, 3) == GXF_RING_BAD_GENERATION, "generation must grow");
  EXPECT(f.channel.ExpectRing(2, 64, 64, 3) == GXF_RING_OK, "resize");
  gxf::Stats stats = f.channel.GetStats();
  EXPECT(stats.retired_held == 3 && stats.held_mask == 0 && stats.generation == 2, "old slots retired");
  // A frame of the old ring in flight during the resize is dropped, not fatal.
  EXPECT(f.Send(1) == KERN_SUCCESS, "old-ring frame");
  gxf::Event stale = f.Receive();
  EXPECT(stale.kind == gxf::Event::Kind::kDropped && stale.code == GXF_E_STALE_GENERATION, "stale dropped");
  gxf_ring ring2{};
  EXPECT(gxf_ring_create(&ring2, 2, 64, 64, 3) == 0, "new surfaces");
  EXPECT(gxf_send_frame(&f.sender, &ring2, 0, ++f.seq, 0, 100) == KERN_SUCCESS, "new-ring frame");
  gxf::Event fresh = f.Receive();
  EXPECT(fresh.kind == gxf::Event::Kind::kFrame && fresh.frame.width == 64, "new ring accepted");
  const uint64_t retired_seq[3] = {4, 2, 3};
  for (uint16_t slot = 0; slot < 3; slot++) EXPECT(!f.channel.Release(1, slot, 99), "retired: wrong seq");
  for (uint16_t slot = 0; slot < 3; slot++)
    EXPECT(f.channel.Release(1, slot, retired_seq[slot]), "retired slot released");
  EXPECT(f.channel.Release(2, 0, 6), "new slot released");
  stats = f.channel.GetStats();
  EXPECT(stats.retired_held == 0 && stats.held_mask == 0 && stats.fault == GXF_OK, "nothing held, no fault");
  EXPECT(stats.counters.accepted == 5 && stats.counters.released == 5, "counters");
  gxf_ring_destroy(&ring2);

  // Resize storms that never release are bounded (rate cap raised so it does not interfere).
  Fixture g(true, 10000, 64);
  uint32_t generation = 1;
  bool refused = false;
  for (int round = 0; round < 8 && !refused; round++) {
    gxf_ring r{};
    gxf_ring_create(&r, generation, kW, kH, 3);
    for (uint32_t slot = 0; slot < 3; slot++) {
      gxf_send_frame(&g.sender, &r, slot, ++g.seq, 0, 100);
      g.Receive();
    }
    gxf_ring_destroy(&r);
    refused = g.channel.ExpectRing(++generation, kW, kH, 3) == GXF_RING_TOO_MANY_HELD;
  }
  EXPECT(refused, "too many held slots across resizes");
}

void TestCloseForgetsName() {
  gxf::Channel channel;
  EXPECT(channel.Open(RandomRunId(), 0, 0) == KERN_SUCCESS, "open");
  std::string name = channel.service_name();
  mach_port_t port = MACH_PORT_NULL;
  EXPECT(bootstrap_look_up(bootstrap_port, name.c_str(), &port) == KERN_SUCCESS, "registered");
  mach_port_deallocate(mach_task_self(), port);
  gxf::Channel twin;
  std::string suffix = name.substr(std::strlen(GXF_SERVICE_PREFIX));
  EXPECT(twin.Open(suffix, 0, 0) != KERN_SUCCESS, "the same name cannot be checked in twice");
  channel.Close();
  kern_return_t kr = KERN_SUCCESS;
  for (int i = 0; i < 40 && kr == KERN_SUCCESS; i++) {
    kr = bootstrap_look_up(bootstrap_port, name.c_str(), &port);
    if (kr == KERN_SUCCESS) {
      mach_port_deallocate(mach_task_self(), port);
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  }
  EXPECT(kr != KERN_SUCCESS, "launchd forgot the name after close");
  channel.Close();
}

void TestWake() {
  gxf::Channel channel;
  channel.Open(RandomRunId(), 0, 0);
  gxf::Event::Kind kind = gxf::Event::Kind::kTimeout;
  std::thread receiver([&] { kind = channel.ReceiveOne(MACH_MSG_TIMEOUT_NONE).kind; });
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  auto start = std::chrono::steady_clock::now();
  channel.Wake();
  receiver.join();
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
  EXPECT(kind == gxf::Event::Kind::kWoken && ms < 100, "wake returns a blocked receive");
}

struct RawFrame {
  gxf_frame_msg msg;
};

void FillPayload(gxf_frame_payload* p, uint16_t slot, uint64_t seq) {
  std::memset(p, 0, sizeof *p);
  p->magic = GXF_MAGIC;
  p->version = GXF_WIRE_VERSION;
  p->slot = slot;
  p->generation = 1;
  p->width = kW;
  p->height = kH;
  p->pixel_format = GXF_PIXEL_FORMAT_BGRA;
  p->seq = seq;
}

// Runs one hostile case and checks it left no port right behind (sender and receiver are this
// process, so a right the channel failed to destroy shows up here).
template <typename Fn>
void NoLeak(const char* label, Fn fn) {
  const mach_msg_type_number_t before = PortNameCount();
  fn();
  const mach_msg_type_number_t after = PortNameCount();
  char text[200];
  std::snprintf(text, sizeof text, "%s: port names %u -> %u", label, before, after);
  EXPECT(after == before, text);
}

void TestHostileKernelMessages() {
  NoLeak("oversize", [&] {
    Fixture f;
    struct {
      mach_msg_header_t header;
      mach_msg_body_t body;
      mach_msg_port_descriptor_t port;
      unsigned char extra[4096];
    } big{};
    big.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    big.header.msgh_id = GXF_MSG_ID_FRAME;
    big.body.msgh_descriptor_count = 1;
    big.port.name = IOSurfaceCreateMachPort(f.ring.surfaces[0]);
    big.port.disposition = MACH_MSG_TYPE_MOVE_SEND;
    big.port.type = MACH_MSG_PORT_DESCRIPTOR;
    EXPECT(f.SendRaw(&big.header, sizeof big) == KERN_SUCCESS, "oversize sent");
    f.ExpectRefusal(GXF_E_OVERSIZE, "oversize (4 KiB payload)");
  });
  NoLeak("missing port", [&] {
    Fixture f;
    RawFrame raw{};
    raw.msg.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
    raw.msg.header.msgh_id = GXF_MSG_ID_FRAME;
    FillPayload(&raw.msg.payload, 0, 1);
    EXPECT(f.SendRaw(&raw.msg.header, sizeof raw.msg) == KERN_SUCCESS, "simple sent");
    f.ExpectRefusal(GXF_E_MISSING_PORT, "missing port (simple message)");
  });
  auto port_message = [](Fixture& f, mach_port_t name, mach_msg_type_name_t disposition, mach_msg_id_t id,
                         uint16_t slot) {
    RawFrame raw{};
    raw.msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    raw.msg.header.msgh_id = id;
    raw.msg.body.msgh_descriptor_count = 1;
    raw.msg.surface.name = name;
    raw.msg.surface.disposition = disposition;
    raw.msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    FillPayload(&raw.msg.payload, slot, ++f.seq);
    return f.SendRaw(&raw.msg.header, sizeof raw.msg);
  };
  NoLeak("wrong msgh_id", [&] {
    Fixture f;
    EXPECT(port_message(f, IOSurfaceCreateMachPort(f.ring.surfaces[0]), MACH_MSG_TYPE_MOVE_SEND, GXF_MSG_ID_FRAME + 7,
                        0) == KERN_SUCCESS,
           "sent");
    f.ExpectRefusal(GXF_E_WRONG_MSG_ID, "wrong msgh_id");
  });
  NoLeak("not an IOSurface", [&] {
    Fixture f;
    mach_port_t plain = MACH_PORT_NULL;
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &plain);
    EXPECT(port_message(f, plain, MACH_MSG_TYPE_MAKE_SEND, GXF_MSG_ID_FRAME, 0) == KERN_SUCCESS, "sent");
    auto start = std::chrono::steady_clock::now();
    f.ExpectRefusal(GXF_E_NOT_IOSURFACE, "a send right that is not an IOSurface");
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
    EXPECT(ms < 500, "the IOSurface look-up does not block on a user port");
    mach_port_mod_refs(mach_task_self(), plain, MACH_PORT_RIGHT_RECEIVE, -1);
  });
  NoLeak("receive right", [&] {
    Fixture f;
    mach_port_t right = MACH_PORT_NULL;
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &right);
    EXPECT(port_message(f, right, MACH_MSG_TYPE_MOVE_RECEIVE, GXF_MSG_ID_FRAME, 0) == KERN_SUCCESS, "sent");
    f.ExpectRefusal(GXF_E_BAD_DISPOSITION, "a receive right");
  });
  NoLeak("send-once right", [&] {
    Fixture f;
    mach_port_t right = MACH_PORT_NULL;
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &right);
    EXPECT(port_message(f, right, MACH_MSG_TYPE_MAKE_SEND_ONCE, GXF_MSG_ID_FRAME, 0) == KERN_SUCCESS, "sent");
    f.ExpectRefusal(GXF_E_BAD_DISPOSITION, "a send-once right");
    mach_port_mod_refs(mach_task_self(), right, MACH_PORT_RIGHT_RECEIVE, -1);
  });
  NoLeak("reply port", [&] {
    Fixture f;
    mach_port_t reply = MACH_PORT_NULL;
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply);
    RawFrame raw{};
    raw.msg.header.msgh_bits =
        MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE, 0, MACH_MSGH_BITS_COMPLEX);
    raw.msg.header.msgh_local_port = reply;
    raw.msg.header.msgh_id = GXF_MSG_ID_FRAME;
    raw.msg.body.msgh_descriptor_count = 1;
    raw.msg.surface.name = IOSurfaceCreateMachPort(f.ring.surfaces[0]);
    raw.msg.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    raw.msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    FillPayload(&raw.msg.payload, 0, 1);
    EXPECT(f.SendRaw(&raw.msg.header, sizeof raw.msg) == KERN_SUCCESS, "sent");
    f.ExpectRefusal(GXF_E_BAD_HEADER, "a reply port");
    mach_port_mod_refs(mach_task_self(), reply, MACH_PORT_RIGHT_RECEIVE, -1);
  });
  NoLeak("out-of-line memory", [&] {
    Fixture f;
    vm_address_t region = 0;
    vm_allocate(mach_task_self(), &region, 1 << 20, VM_FLAGS_ANYWHERE);
    struct {
      mach_msg_header_t header;
      mach_msg_body_t body;
      mach_msg_ool_descriptor_t ool;
      unsigned char pad[80 - sizeof(mach_msg_header_t) - sizeof(mach_msg_body_t) - sizeof(mach_msg_ool_descriptor_t)];
    } ool{};
    ool.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    ool.header.msgh_id = GXF_MSG_ID_FRAME;
    ool.body.msgh_descriptor_count = 1;
    ool.ool.address = reinterpret_cast<void*>(region);
    ool.ool.size = 1 << 20;
    ool.ool.copy = MACH_MSG_VIRTUAL_COPY;
    ool.ool.type = MACH_MSG_OOL_DESCRIPTOR;
    EXPECT(f.SendRaw(&ool.header, sizeof ool) == KERN_SUCCESS, "sent");
    f.ExpectRefusal(GXF_E_BAD_DESCRIPTOR, "out-of-line memory (1 MiB)");
    vm_deallocate(mach_task_self(), region, 1 << 20);
  });
  NoLeak("slot 3", [&] {
    Fixture f;
    EXPECT(port_message(f, IOSurfaceCreateMachPort(f.ring.surfaces[0]), MACH_MSG_TYPE_MOVE_SEND, GXF_MSG_ID_FRAME, 3) ==
               KERN_SUCCESS,
           "sent");
    f.ExpectRefusal(GXF_E_UNKNOWN_SLOT, "slot 3 (a 4th slot)");
  });
  struct SurfaceCase {
    const char* label;
    uint32_t width, height, format, bytes_per_row;
    gxf_code want;
  };
  const SurfaceCase surfaces[] = {
      {"surface format RGBA", kW, kH, 0x52474241u, 0, GXF_E_FORMAT_MISMATCH},
      {"surface smaller than announced", kW / 2, kH, GXF_PIXEL_FORMAT_BGRA, 0, GXF_E_SIZE_MISMATCH},
      {"surface larger than announced", kW, kH * 8, GXF_PIXEL_FORMAT_BGRA, 0, GXF_E_SIZE_MISMATCH},
      {"surface rows padded to 2x", kW, kH, GXF_PIXEL_FORMAT_BGRA, kW * 8, GXF_E_ALLOC_MISMATCH},
  };
  for (const SurfaceCase& c : surfaces)
    NoLeak(c.label, [&] {
      Fixture f;
      IOSurfaceRef surface = CreateSurface(c.width, c.height, c.format, c.bytes_per_row);
      EXPECT(surface != nullptr, c.label);
      gxf_frame_payload payload;
      gxf_payload_for(&payload, &f.ring, 0, ++f.seq, 0);
      EXPECT(gxf_send_surface(&f.sender, surface, &payload, 100) == KERN_SUCCESS, c.label);
      f.ExpectRefusal(c.want, c.label);
      CFRelease(surface);
    });
  NoLeak("a 4th surface", [&] {
    Fixture f;
    for (uint32_t slot = 0; slot < 3; slot++) {
      f.Send(slot);
      f.Receive();
    }
    f.channel.Release(1, 0, 1);
    IOSurfaceRef fourth = CreateSurface(kW, kH, GXF_PIXEL_FORMAT_BGRA, 0);
    gxf_frame_payload payload;
    gxf_payload_for(&payload, &f.ring, 0, ++f.seq, 0);
    gxf_send_surface(&f.sender, fourth, &payload, 100);
    f.channel.Release(1, 1, 2);
    f.channel.Release(1, 2, 3);
    gxf::Event event = f.Receive();
    EXPECT(event.kind == gxf::Event::Kind::kError && event.code == GXF_E_RING_OVERFLOW, "a 4th surface");
    CFRelease(fourth);
  });
  NoLeak("slot busy", [&] {
    Fixture f;
    f.Send(0);
    f.Send(0);
    EXPECT(f.Receive().kind == gxf::Event::Kind::kFrame, "first");
    gxf::Event event = f.Receive();
    EXPECT(event.kind == gxf::Event::Kind::kError && event.code == GXF_E_SLOT_BUSY, "slot still held");
  });
  NoLeak("rate cap", [&] {
    Fixture f(true, 5, 2);
    gxf::Event last;
    for (int i = 0; i < 3; i++) {
      f.Send(0);
      last = f.Receive();
      f.channel.Release(1, 0, f.seq);
    }
    EXPECT(last.kind == gxf::Event::Kind::kError && last.code == GXF_E_RATE, "rate cap (5 fps, burst 2)");
  });
  NoLeak("no ring", [&] {
    Fixture f(false);
    f.Send(0);
    gxf::Event event = f.Receive();
    EXPECT(event.kind == gxf::Event::Kind::kError && event.code == GXF_E_NO_RING, "frame before the ring");
  });
  NoLeak("foreign sender", [&] {
    Fixture f;
    gxf::Channel other;
    other.Open(RandomRunId(), 0, 0);
    // A second channel whose peer is not us: our frames there are foreign and only dropped.
    other.SetPeer(getppid());
    other.ExpectRing(1, kW, kH, 3);
    gxf_sender s{};
    gxf_sender_connect(&s, other.service_name().c_str());
    gxf_send_frame(&s, &f.ring, 0, 1, 0, 100);
    gxf::Event event = other.ReceiveOne(1000);
    EXPECT(event.kind == gxf::Event::Kind::kDropped && event.code == GXF_E_FOREIGN_SENDER, "foreign pid dropped");
    EXPECT(other.GetStats().fault == GXF_OK && other.GetStats().counters.dropped == 1, "no fault");
    gxf_sender_disconnect(&s);
    other.Close();
  });
  NoLeak("queue limit and close with queued messages", [&] {
    Fixture f;
    int sent = 0;
    for (int i = 0; i < 20; i++) {
      gxf_frame_payload payload;
      gxf_payload_for(&payload, &f.ring, 0, ++f.seq, 0);
      if (gxf_send_surface(&f.sender, f.ring.surfaces[0], &payload, 0) == KERN_SUCCESS) sent++;
    }
    EXPECT(sent == static_cast<int>(gxf::kQueueLimit), "the service queue holds kQueueLimit messages");
    // Closing with queued messages destroys them and their rights (checked by the leak count).
  });
}

}  // namespace

// First use of IOSurface and bootstrap allocates long-lived ports; take the baseline after it.
void WarmUp() {
  IOSurfaceRef surface = CreateSurface(16, 16, GXF_PIXEL_FORMAT_BGRA, 0);
  mach_port_t port = IOSurfaceCreateMachPort(surface);
  IOSurfaceRef looked_up = IOSurfaceLookupFromMachPort(port);
  if (looked_up != nullptr) CFRelease(looked_up);
  mach_port_deallocate(mach_task_self(), port);
  CFRelease(surface);
  gxf::Channel channel;
  channel.Open(RandomRunId(), 0, 0);
  channel.Close();
}

int main() {
  WarmUp();
  const mach_msg_type_number_t before = PortNameCount();
  const struct {
    const char* name;
    void (*run)();
  } sections[] = {{"run ids", TestRunIds},
                  {"happy path and resize", TestHappyPathAndResize},
                  {"close forgets the name", TestCloseForgetsName},
                  {"wake", TestWake},
                  {"hostile kernel messages", TestHostileKernelMessages}};
  for (const auto& section : sections) {
    const mach_msg_type_number_t start = PortNameCount();
    section.run();
    std::printf("  %-26s port names %u -> %u\n", section.name, start, PortNameCount());
  }
  const mach_msg_type_number_t after = PortNameCount();
  std::printf("port names: %u before, %u after\n", before, after);
  EXPECT(after == before, "no leaked port rights");
  std::printf("test_channel: %d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
