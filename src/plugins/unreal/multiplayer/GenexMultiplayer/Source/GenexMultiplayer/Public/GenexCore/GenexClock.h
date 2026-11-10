// GenexCore time: double milliseconds. `Clock::NowMs()` is the monotonic clock every session,
// interpolator and timeout reads (std::chrono::steady_clock; its origin is the first call in the
// process, so values start near 0 and stay exact in a double for centuries). `Clock::EpochMs()` is
// the wall clock (system_clock, ms since 1970) for the rare stamp that must be comparable across
// machines; it can jump, so never measure an interval with it. A test stepping the process on a
// virtual clock (Clock::SetVirtualMsForTests) makes NowMs() read that clock instead.
//
// A session may carry a fixed test skew (the conformance driver's `skew` capability):
// `SessionClock::Now()` is that session's view, `SessionClock::Real()` the unskewed clock.
#pragma once

#include "GenexCore/GenexConfig.h"

namespace genex {

struct GENEX_CORE_API Clock {
  /** Monotonic milliseconds since the first call in this process (never goes backwards). */
  static double NowMs();
  /** Alias of NowMs(): real (unskewed) monotonic time. */
  static double Now() { return NowMs(); }
  /** Wall-clock milliseconds since the Unix epoch. */
  static double EpochMs();
  /** TEST SEAM (the conformance driver's `virtualClock`, netcode-bench DRIVER.md §Virtual clock):
   *  from this call on NowMs() reads `ms` and moves only when it is set again (the driver points the
   *  Colyseus C core's room clocks at it too; this file stays free of the C core, which the Godot
   *  physics extension compiles it without). Never in a game. */
  static void SetVirtualMsForTests(double ms);
  /** Whether SetVirtualMsForTests was called; `ms` (when not null) receives the virtual reading. */
  static bool VirtualMsForTests(double* ms);
};

struct SessionClock {
  /** Added to every Now() reading. 0 outside tests. */
  double skewMs = 0.0;

  /** This session's clock: real monotonic time plus the skew. */
  double Now() const { return Clock::NowMs() + skewMs; }
  /** Real monotonic time, ignoring the skew. */
  double Real() const { return Clock::NowMs(); }
};

}  // namespace genex
