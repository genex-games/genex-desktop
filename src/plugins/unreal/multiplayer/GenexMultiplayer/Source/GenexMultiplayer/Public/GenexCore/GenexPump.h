// The one frame driver of GenexCore. The Colyseus C core runs polled (colyseus_set_polled(true)),
// and colyseus_poll() is PROCESS-WIDE: it drives every client and room in the process. So exactly
// one caller pumps per frame: Pump::Frame(nowMs, frameId) polls the C core once, then calls
// Update(nowMs) on every registered object (sessions), in registration order. Sessions never call
// colyseus_poll() themselves.
//
// Process-wide and single-threaded: Register, Unregister and Frame must all run on the thread that
// owns the GenexCore objects (UE's game thread; a tool's main loop). Nothing here locks.
//
// In UE the plugin module owns the one pump and calls Frame from its ticker with GFrameCounter as
// `frameId`, so several PIE worlds ticking in one engine frame still poll exactly once.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstdint>

namespace genex {

class GENEX_CORE_API IPumped {
 public:
  virtual ~IPumped();
  /** Called once per pumped frame, after the C core was polled. */
  virtual void Update(double nowMs) = 0;
  /** Called once per pumped frame, right before the C core is polled (default: nothing). */
  virtual void BeforePoll() {}
};

class GENEX_CORE_API Pump {
 public:
  /** Add `object` (no-op when already registered or null). Registering inside an Update is fine:
   *  the new object is first updated on the NEXT frame. Also latches polled mode (EnsurePolled). */
  static void Register(IPumped* object);
  /** Remove `object` (no-op when absent). Safe inside an Update, including the object's own: a
   *  removed object is never called again, even later in the same frame. Call it before the
   *  object is destroyed. */
  static void Unregister(IPumped* object);
  /** Run one frame: on the first ever call, colyseus_set_polled(true); then, once per distinct
   *  `frameId`, colyseus_poll() and Update(nowMs) on each registered object. A second call with
   *  the same `frameId` as the previous call does nothing at all. A call from inside an Update
   *  (re-entrant) does nothing. */
  static void Frame(double nowMs, std::uint64_t frameId);
  /** The `nowMs` of the frame being pumped (its instant: taken before the poll decoded anything), NaN outside one. A
   *  session draws at it, not at the clock after the poll's work (decodes, keyframe replays). */
  static double FrameNowMs();
  /** colyseus_set_polled(true), once per process. The C core latches the mode when each socket,
   *  request and room STARTS, so call this before creating any colyseus client (sessions do). On Windows
   *  it also gives the core's room clocks a clock finer than a frame (GenexRoomClock.h). */
  static void EnsurePolled();
  /** Registered objects (removed-but-not-yet-compacted ones excluded). */
  static std::uint64_t Count();
};

}  // namespace genex
