// Rows for src/clock.*: the fixed 1/60 s tick, the 250 ms frame clamp and `step(ms)` rounding.
// Run with no argument for every row, or with a row name for one.
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

#include "clock.h"

namespace {

using studio::FrameClock;
using studio::stepTicks;

void clamp() {
  FrameClock clock;
  assert(clock.advance(250) == 15);
  FrameClock stalled;
  // A one-second stall (a debugger, a hidden tab) is worth 250 ms of simulation, never 60 ticks.
  assert(stalled.advance(1000) == 15);
  assert(stalled.advance(60000) == 15);
  assert(studio::MAX_FRAME_MS == 250);
}

void accumulates() {
  FrameClock clock;
  assert(clock.advance(10) == 0);
  assert(clock.advance(10) == 1);
  assert(std::fabs(clock.carry() - (20 - studio::FIXED_STEP_MS)) < 1e-9);
  int total = 0;
  for (int frame = 0; frame < 600; ++frame) total += clock.advance(1000.0 / 60.0);
  assert(total == 600);
  clock.reset();
  assert(clock.carry() == 0);
}

void hostileFrames() {
  FrameClock clock;
  assert(clock.advance(std::numeric_limits<double>::quiet_NaN()) == 0);
  assert(clock.advance(-50) == 0);
  assert(clock.carry() == 0);
  assert(clock.advance(std::numeric_limits<double>::infinity()) == 15);
}

void stepRounding() {
  const double step = studio::FIXED_STEP_MS;
  assert(stepTicks(0) == 1);
  assert(stepTicks(1) == 1);
  assert(stepTicks(step) == 1);
  assert(stepTicks(24) == 1);
  assert(stepTicks(26) == 2);
  assert(stepTicks(100) == 6);
  assert(stepTicks(1000) == 60);
  assert(stepTicks(-5) == 1);
  assert(stepTicks(std::numeric_limits<double>::quiet_NaN()) == 1);
  assert(stepTicks(1e12) == studio::MAX_STEP_TICKS);
  assert(stepTicks(std::numeric_limits<double>::infinity()) == studio::MAX_STEP_TICKS);
  assert(stepTicks(100, 50) == 2);
}

void fpsMeter() {
  studio::FpsMeter meter;
  assert(meter.fps() == 0);
  meter.frame(1000);
  assert(meter.fps() == 0);  // one frame is no interval yet
  for (int i = 1; i <= 30; ++i) meter.frame(1000 + i * 20.0);
  assert(std::fabs(meter.fps() - 50) < 1e-9);
  // Only the last FPS_WINDOW intervals count: a slow start is forgotten.
  for (int i = 1; i <= studio::FPS_WINDOW; ++i) meter.frame(1600 + i * 10.0);
  assert(std::fabs(meter.fps() - 100) < 1e-9);
  // A clock that stands still or runs backwards adds no interval.
  studio::FpsMeter still;
  still.frame(5);
  still.frame(5);
  still.frame(4);
  still.frame(std::numeric_limits<double>::quiet_NaN());
  assert(still.fps() == 0);
  meter.reset();
  assert(meter.fps() == 0);
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"clamp", clamp},
    {"accumulates", accumulates},
    {"hostile-frames", hostileFrames},
    {"step-rounding", stepRounding},
    {"fps-meter", fpsMeter},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
