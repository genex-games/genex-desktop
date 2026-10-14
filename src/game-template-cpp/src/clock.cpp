// The simulation clock declared in clock.h. raylib-free.
#include "clock.h"

#include <cmath>
#include <cstddef>

namespace studio {

namespace {

/** Slack for a sum of float steps that lands a hair under a whole tick (250 / (1000/60) is 14.999…). */
constexpr double TICK_EPSILON_MS = 1e-6;

}  // namespace

int stepTicks(double ms, double stepMs) {
  if (!(stepMs > 0)) return 1;
  double ticks = std::round(ms / stepMs);
  if (std::isnan(ticks) || ticks < 1) return 1;
  if (ticks > MAX_STEP_TICKS) return MAX_STEP_TICKS;
  return static_cast<int>(ticks);
}

int FrameClock::advance(double frameMs) {
  if (std::isnan(frameMs) || frameMs <= 0) return 0;
  carry_ += frameMs < MAX_FRAME_MS ? frameMs : MAX_FRAME_MS;
  int ticks = 0;
  while (carry_ + TICK_EPSILON_MS >= stepMs_) {
    carry_ -= stepMs_;
    ++ticks;
  }
  if (carry_ < 0) carry_ = 0;
  return ticks;
}

void FpsMeter::frame(double nowMs) {
  if (std::isnan(nowMs)) return;
  if (started_ && nowMs > last_) {
    intervals_[static_cast<std::size_t>(next_)] = nowMs - last_;
    next_ = (next_ + 1) % FPS_WINDOW;
    if (count_ < FPS_WINDOW) ++count_;
  }
  started_ = true;
  last_ = nowMs;
}

double FpsMeter::fps() const {
  double total = 0;
  for (int i = 0; i < count_; ++i) total += intervals_[static_cast<std::size_t>(i)];
  return total > 0 ? count_ * 1000.0 / total : 0;
}

}  // namespace studio
