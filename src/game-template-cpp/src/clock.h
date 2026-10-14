// The simulation clock: fixed 1/60 s ticks, a frame clamped to 250 ms so a stall never turns into
// a burst of catch-up ticks, and the tick count of a scripted step(ms). GetFrameTime only paces
// live play through FrameClock; nothing in a simulation reads a wall clock. raylib-free.
#pragma once

#include <array>

namespace studio {

/** One simulation tick, in milliseconds. */
inline constexpr double FIXED_STEP_MS = 1000.0 / 60.0;
/** The most wall time one rendered frame may feed the simulation. */
inline constexpr double MAX_FRAME_MS = 250.0;
/** The most ticks one step(ms) runs: ten minutes of simulation. */
inline constexpr int MAX_STEP_TICKS = 36000;
/** Frame intervals state().fps averages over. */
inline constexpr int FPS_WINDOW = 60;

/** The ticks step(ms) runs: max(1, round(ms / stepMs)), capped at MAX_STEP_TICKS. */
int stepTicks(double ms, double stepMs = FIXED_STEP_MS);

/** Turns rendered frames' wall time into whole ticks, carrying the remainder. */
class FrameClock {
 public:
  explicit FrameClock(double stepMs = FIXED_STEP_MS) : stepMs_(stepMs) {}
  /** The ticks this frame is worth. NaN and negative frames are worth nothing; a frame counts at most MAX_FRAME_MS. */
  int advance(double frameMs);
  /** Forget the carried remainder (seed and start do). */
  void reset() { carry_ = 0; }
  /** Time carried towards the next tick, in milliseconds. */
  double carry() const { return carry_; }
  double stepMs() const { return stepMs_; }

 private:
  double stepMs_;
  double carry_ = 0;
};

/**
 * The live frame rate, from the loop's own frame times: frames drawn for a verb (a step, a
 * capture) are not live frames and never reach it. A volatile figure, never compared.
 */
class FpsMeter {
 public:
  /** One live frame at `nowMs`; a clock that stands still, runs backwards or is NaN adds no interval. */
  void frame(double nowMs);
  /** Frames per second over the last FPS_WINDOW intervals; 0 before the first interval. */
  double fps() const;
  void reset() { *this = FpsMeter(); }

 private:
  std::array<double, FPS_WINDOW> intervals_{};
  int count_ = 0;
  int next_ = 0;
  bool started_ = false;
  double last_ = 0;
};

}  // namespace studio
