// Rows for src/session.* (the runtime's state machine) and src/rng.h. Run with no argument for
// every row, or with a row name for one.
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "input.h"
#include "json.h"
#include "rng.h"
#include "session.h"

namespace {

using studio::Injection;
namespace PadButton = studio::PadButton;
using studio::Session;
using studio::TickInput;

/** What the hooks saw: every reset seed and every tick's merged input. */
struct Record {
  std::vector<std::uint32_t> resets;
  std::vector<TickInput> ticks;
  std::vector<int> tickNumbers;
};

Session recording(Record& record) {
  studio::SessionHooks hooks;
  hooks.reset = [&record](std::uint32_t seed) { record.resets.push_back(seed); };
  hooks.tick = [&record](const TickInput& input, int tick) {
    record.ticks.push_back(input);
    record.tickNumbers.push_back(tick);
  };
  return Session(hooks);
}

void stepRounding() {
  Record record;
  Session session = recording(record);
  session.seed(1);
  studio::StepResult one = session.step(0);
  assert(one.ticks == 1 && one.frame == 1);
  studio::StepResult six = session.step(100);
  assert(six.ticks == 6 && six.frame == 7);
  assert(std::abs(six.simulatedMs - 7 * studio::FIXED_STEP_MS) < 1e-9);
  assert(session.step(1000).ticks == 60);
  assert(record.ticks.size() == 67);
  assert(record.tickNumbers.front() == 0 && record.tickNumbers.back() == 66);
}

void edgesFirstTickOfStep() {
  Record record;
  Session session = recording(record);
  session.seed(1);
  Injection press;
  press.down = {"KeyW"};
  press.look = {5, 0};
  assert((session.inject(press) == std::vector<std::string>{"KeyW"}));
  session.step(50);
  assert(record.ticks.size() == 3);
  assert(record.ticks[0].keys.pressed("KeyW") && record.ticks[0].look.x == 5);
  for (int i = 1; i < 3; ++i) {
    assert(record.ticks[i].keys.down("KeyW"));
    assert(!record.ticks[i].keys.pressed("KeyW"));
    assert(record.ticks[i].look.x == 0);
  }
  session.step(50);
  assert(!record.ticks[3].keys.pressed("KeyW") && record.ticks[3].keys.down("KeyW"));
}

void seedResets() {
  Record record;
  Session session = recording(record);
  session.start();
  Injection press;
  press.down = {"Space"};
  session.inject(press);
  session.step(100);
  (void)session.takeRender();
  // Pending input a seed must drop: a tap, a look, a wheel, text and a held key, none of them spent yet.
  Injection pending;
  pending.tap = {"KeyE"};
  pending.down = {"KeyQ"};
  pending.look = {4, 4};
  pending.wheel = {0, 2};
  pending.text = "abc";
  session.inject(pending);
  studio::FrameSample real;
  real.pressed = {"KeyR"};
  real.released = {"KeyR"};
  real.look = {3, 3};
  real.pointerLock = true;
  session.sample(real);
  assert(session.seed(7) == 7);
  assert(record.resets.back() == 7);
  assert(!session.running());
  assert(session.held().empty());
  assert(session.tick() == 0 && session.simulatedMs() == 0 && session.seedValue() == 7);
  assert(session.takeRender());
  assert(!session.takeRender());
  studio::Rng fresh(7);
  assert(session.rng().next() == fresh.next());
  session.step(0);
  const TickInput& first = record.ticks.back();
  assert(!first.keys.down("Space") && !first.keys.down("KeyQ"));
  assert(!first.keys.pressed("KeyE") && !first.keys.released("KeyE") && !first.keys.pressed("KeyQ"));
  assert(!first.keys.pressed("KeyR") && !first.keys.released("KeyR"));
  assert(first.look.x == 0 && first.look.y == 0 && first.wheel.y == 0 && first.text.empty());
}

void liveFrames() {
  Record record;
  Session session = recording(record);
  session.seed(3);
  assert(session.frame(100) == 0);
  assert(record.ticks.empty());
  assert(session.start());
  assert(session.frame(1000) == 15);
  assert(session.pause() == false);
  assert(session.frame(1000) == 0);
  assert(record.ticks.size() == 15);
}

void padsAndText() {
  Record record;
  Session session = recording(record);
  session.seed(1);
  Injection input;
  studio::PadState pad;
  pad.connected = true;
  pad.buttons[PadButton::A] = 1;
  input.pads.push_back({2, pad});
  input.text = "\xe2\x9c\x93 go";
  session.inject(input);
  session.step(34);
  assert(record.ticks.size() == 2);
  assert(record.ticks[0].pads.pressed(2, PadButton::A) && record.ticks[0].text == "\xe2\x9c\x93 go");
  assert(record.ticks[1].pads.down(2, PadButton::A) && !record.ticks[1].pads.pressed(2, PadButton::A));
  assert(record.ticks[1].text.empty());
}

void pcg32() {
  // The reference output of pcg32-demo: pcg32_srandom_r(&rng, 42, 54), then six draws.
  studio::Rng rng(42, 54);
  const std::uint32_t expected[] = {0xa15c02b7u, 0x7b47f409u, 0xba1d3330u, 0x83d2f293u, 0xbfa4784bu, 0xcbed606eu};
  for (std::uint32_t value : expected) assert(rng.next() == value);
  studio::Rng bounded(9);
  for (int i = 0; i < 1000; ++i) {
    int roll = bounded.nextInt(-3, 3);
    assert(roll >= -3 && roll <= 3);
    float unit = bounded.unit();
    assert(unit >= 0.0f && unit < 1.0f);
  }
  assert(bounded.nextInt(5, 5) == 5);
}

void snapshotChecksum() {
  Record record;
  Session session = recording(record);
  session.seed(11);
  session.step(50);
  studio::StateExtras extras;
  extras.fps = 60;
  extras.camera = "default";
  extras.probes = json::Value::object();
  extras.probes.set("score", 3);
  extras.probes.set("frame", 999);
  json::Value first = studio::snapshot(session, extras);
  assert(first["seed"].asNumber() == 11 && first["frame"].asNumber() == 3);
  assert(first["score"].asNumber() == 3);
  assert(first["running"].is(json::Kind::Bool) && !first["running"].asBool());
  assert(first["volatile"]["fps"].asNumber() == 60 && first["fps"].asNumber() == 60);
  assert(first["checksum"].asString().size() == 16);
  extras.fps = 12;
  json::Value slower = studio::snapshot(session, extras);
  assert(slower["checksum"].asString() == first["checksum"].asString());
  extras.probes.set("score", 4);
  json::Value scored = studio::snapshot(session, extras);
  assert(scored["checksum"].asString() != first["checksum"].asString());
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"step-rounding", stepRounding}, {"edges-first-tick-of-step", edgesFirstTickOfStep},
    {"seed-resets", seedResets},     {"live-frames", liveFrames},
    {"pads-and-text", padsAndText},  {"pcg32", pcg32},
    {"snapshot-checksum", snapshotChecksum},
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
