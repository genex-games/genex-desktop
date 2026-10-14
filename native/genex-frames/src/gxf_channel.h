// Host receive core: checks in the per-run service, receives frame messages, validates them
// (gxf_validate), looks the IOSurface up and keeps slot ownership. No Node or Electron here, so
// tests drive it directly against the kernel. Never maps, locks or reads pixels.
#ifndef GXF_CHANNEL_H
#define GXF_CHANNEL_H

#include <IOSurface/IOSurfaceRef.h>
#include <mach/mach.h>

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "gxf_validate.h"

namespace gxf {

/** Older rings may keep at most this many held slots (a resize storm that never releases). */
constexpr size_t kMaxRetiredHeld = 12;
/** Queue limit of the service port. */
constexpr mach_port_msgcount_t kQueueLimit = 8;

/** One accepted frame. `surface` is borrowed: valid until Release(generation, slot, seq) or Close(). */
struct Frame {
  uint32_t generation = 0;
  uint16_t slot = 0;
  uint64_t seq = 0;
  uint64_t ts_us = 0;
  uint64_t received_us = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t surface_id = 0;
  IOSurfaceRef surface = nullptr;
};

/** What one receive produced. */
struct Event {
  enum class Kind { kFrame, kError, kDropped, kTimeout, kWoken };
  Kind kind = Kind::kTimeout;
  gxf_code code = GXF_OK;
  bool has_slot = false;
  uint32_t generation = 0;
  uint16_t slot = 0;
  Frame frame;
};

/** Counters and slot ownership for leak checks. */
struct Stats {
  gxf_counters counters{};
  uint32_t generation = 0;
  uint32_t held_mask = 0;
  size_t retired_held = 0;
  gxf_code fault = GXF_OK;
  pid_t peer = 0;
  bool open = false;
};

/** Microsecond clock; injectable for tests. */
using Clock = uint64_t (*)();
uint64_t MonotonicMicros();
uint64_t RealtimeMicros();

/** Whether `run_id` may form a service name: [A-Za-z0-9-], 8 to 64 characters. */
bool ValidRunId(const std::string& run_id);

class Channel {
 public:
  Channel() = default;
  Channel(const Channel&) = delete;
  Channel& operator=(const Channel&) = delete;
  ~Channel();

  /** Checks in games.genex.frames.<run_id>; KERN_INVALID_ARGUMENT for a bad run id. */
  kern_return_t Open(const std::string& run_id, uint32_t max_fps, uint32_t burst, Clock clock = nullptr);
  const std::string& service_name() const { return service_name_; }
  /** Sets the only pid allowed to send; false when a different pid was already set. */
  bool SetPeer(pid_t pid);
  /** Announces the ring the host asked the game for. Held slots of the old ring stay retained
   * until released. */
  gxf_ring_error ExpectRing(uint32_t generation, uint32_t width, uint32_t height, uint32_t slots);
  /** Receives one message (timeout_ms = MACH_MSG_TIMEOUT_NONE blocks) and validates it. */
  Event ReceiveOne(mach_msg_timeout_t timeout_ms);
  /** Returns the slot held by frame `seq`; false when that frame does not hold it. */
  bool Release(uint32_t generation, uint16_t slot, uint64_t seq);
  /** Makes a blocked ReceiveOne return kWoken. Safe from any thread. */
  void Wake();
  /** Marks the channel faulted (for faults found outside ReceiveOne, like a full event queue). */
  void Fault(gxf_code code);
  /** Releases every surface and the service (launchd forgets the name). Call after the
   * receiving thread stopped. Idempotent. */
  void Close();
  Stats GetStats();

 private:
  struct Retired {
    uint32_t generation;
    uint16_t slot;
    uint64_t seq;
    IOSurfaceRef surface;
  };
  Event Refuse(gxf_code code, const gxf_frame_meta* meta);
  Event Handle(gxf_receive_buffer* buffer);
  Event Accept(const gxf_frame_meta& meta);
  void CloseLocked(std::vector<IOSurfaceRef>* surfaces);

  std::mutex mu_;
  gxf_state state_{};
  IOSurfaceRef held_[GXF_MAX_SLOTS] = {nullptr, nullptr, nullptr};
  std::vector<Retired> retired_;
  Clock clock_ = nullptr;
  std::string service_name_;
  mach_port_t service_ = MACH_PORT_NULL;
  mach_port_t wake_ = MACH_PORT_NULL;
  mach_port_t set_ = MACH_PORT_NULL;
  bool open_ = false;
};

}  // namespace gxf

#endif
