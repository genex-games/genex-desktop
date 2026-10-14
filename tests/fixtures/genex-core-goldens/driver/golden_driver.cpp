// The characterization driver behind tests/fixtures/genex-core-goldens: it runs one unit's
// scenarios (scenarios/<unit>.json) through the C++ template's own sources and prints each case
// with the answers those sources gave. scripts/spike/rust-wgpu/extract-goldens.ts compiles it
// against src/game-template-cpp/src and writes <unit>.golden.json; genex-core's tests replay the
// same cases through the Rust port and require the same answers, bit for bit.
//
// Encodings shared with the Rust side (crates/genex-core/tests/golden/mod.rs):
// - a double is written as "0x" + its 16 hex bit digits; read from a number, "nan", "inf",
//   "-inf", "-0" or that bit form;
// - a float is written as its 32 bits, a JSON integer;
// - bytes that may not be UTF-8 are written as lowercase hex; a text spec is a string, {"hex"},
//   {"repeat": spec, "count"} or an array of specs, concatenated.
#include <cinttypes>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "clock.h"
#include "digest.h"
#include "input.h"
#include "json.h"
#include "paths.h"
#include "protocol.h"
#include "rng.h"
#include "session.h"

namespace {

using json::Value;

// ---------------------------------------------------------------------------------------------
// Encodings.

std::string bitsOf(double value) {
  std::uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof bits);
  char out[24];
  std::snprintf(out, sizeof out, "0x%016" PRIx64, bits);
  return out;
}

Value floatBits(float value) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof bits);
  return Value(bits);
}

std::string hexOf(std::string_view bytes) {
  static constexpr char DIGITS[] = "0123456789abcdef";
  std::string out;
  for (char c : bytes) {
    auto byte = static_cast<unsigned char>(c);
    out += DIGITS[byte >> 4];
    out += DIGITS[byte & 0xF];
  }
  return out;
}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::string bytesOfHex(std::string_view hex) {
  std::string out;
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
    out += static_cast<char>(hexDigit(hex[i]) * 16 + hexDigit(hex[i + 1]));
  }
  return out;
}

std::uint64_t u64Of(const Value& value) {
  if (value.is(json::Kind::Number)) return static_cast<std::uint64_t>(value.asNumber());
  const std::string& text = value.asString();
  return std::strtoull(text.c_str(), nullptr, 16);
}

double realOf(const Value& value) {
  if (value.is(json::Kind::Number)) return value.asNumber();
  const std::string& text = value.asString();
  if (text == "nan") return std::numeric_limits<double>::quiet_NaN();
  if (text == "inf") return std::numeric_limits<double>::infinity();
  if (text == "-inf") return -std::numeric_limits<double>::infinity();
  if (text == "-0") return -0.0;
  std::uint64_t bits = std::strtoull(text.c_str(), nullptr, 16);
  double out = 0;
  std::memcpy(&out, &bits, sizeof out);
  return out;
}

float floatOf(const Value& value) { return static_cast<float>(realOf(value)); }

std::string textOf(const Value& spec) {
  if (spec.is(json::Kind::String)) return spec.asString();
  if (spec.is(json::Kind::Array)) {
    std::string out;
    for (const Value& part : spec.items()) out += textOf(part);
    return out;
  }
  if (spec.find("hex")) return bytesOfHex(spec["hex"].asString());
  if (spec.find("repeat")) {
    std::string unit = textOf(spec["repeat"]);
    std::string out;
    auto count = static_cast<std::size_t>(spec["count"].asNumber());
    for (std::size_t i = 0; i < count; ++i) out += unit;
    return out;
  }
  return {};
}

Value strings(const std::vector<std::string>& list) {
  Value out = Value::array();
  for (const std::string& item : list) out.push(item);
  return out;
}

std::vector<std::string> stringList(const Value& value) {
  std::vector<std::string> out;
  for (const Value& item : value.items()) out.push_back(textOf(item));
  return out;
}

Value vec2(studio::Vec2 v) {
  Value out = Value::array();
  out.push(floatBits(v.x));
  out.push(floatBits(v.y));
  return out;
}

studio::Vec2 vec2Of(const Value& value, studio::Vec2 fallback = {}) {
  if (!value.is(json::Kind::Array)) return fallback;
  return {floatOf(value.items()[0]), floatOf(value.items()[1])};
}

/** 64 random bits from a scenario's stream: the high draw first. */
std::uint64_t draw64(studio::Rng& rng) {
  std::uint64_t high = rng.next();
  return (high << 32) | rng.next();
}

// ---------------------------------------------------------------------------------------------
// clock

Value clockUnit(const Value& scenario) {
  Value out = Value::object();
  Value ticks = Value::array();
  for (const Value& row : scenario["stepTicks"].items()) {
    double ms = realOf(row["ms"]);
    double stepMs = row.find("stepMs") ? realOf(row["stepMs"]) : studio::FIXED_STEP_MS;
    Value item = Value::object();
    item.set("ms", bitsOf(ms));
    item.set("stepMs", bitsOf(stepMs));
    item.set("ticks", studio::stepTicks(ms, stepMs));
    ticks.push(std::move(item));
  }
  out.set("stepTicks", std::move(ticks));

  Value clocks = Value::array();
  auto runClock = [&clocks](double stepMs, const std::vector<double>& frames, int resetAt) {
    studio::FrameClock clock(stepMs);
    Value item = Value::object();
    Value inputs = Value::array();
    Value counts = Value::array();
    Value carries = Value::array();
    for (std::size_t i = 0; i < frames.size(); ++i) {
      if (static_cast<int>(i) == resetAt) clock.reset();
      inputs.push(bitsOf(frames[i]));
      counts.push(clock.advance(frames[i]));
      carries.push(bitsOf(clock.carry()));
    }
    item.set("stepMs", bitsOf(stepMs));
    item.set("resetAt", resetAt);
    item.set("frames", std::move(inputs));
    item.set("ticks", std::move(counts));
    item.set("carry", std::move(carries));
    clocks.push(std::move(item));
  };
  for (const Value& row : scenario["frameClocks"].items()) {
    std::vector<double> frames;
    for (const Value& frame : row["frames"].items()) frames.push_back(realOf(frame));
    double stepMs = row.find("stepMs") ? realOf(row["stepMs"]) : studio::FIXED_STEP_MS;
    runClock(stepMs, frames, static_cast<int>(row["resetAt"].asNumber(-1)));
  }
  const Value& generated = scenario["generatedClocks"];
  studio::Rng rng(u64Of(generated["seed"]));
  for (int c = 0; c < static_cast<int>(generated["count"].asNumber()); ++c) {
    std::vector<double> frames;
    for (int f = 0; f < 40; ++f) frames.push_back(static_cast<double>(rng.below(40000)) / 1000.0);
    runClock(studio::FIXED_STEP_MS, frames, -1);
  }
  out.set("frameClocks", std::move(clocks));

  Value meters = Value::array();
  for (const Value& row : scenario["fpsMeters"].items()) {
    studio::FpsMeter meter;
    Value item = Value::object();
    Value times = Value::array();
    Value fps = Value::array();
    int resetAt = static_cast<int>(row["resetAt"].asNumber(-1));
    std::vector<double> nows;
    for (const Value& t : row["times"].items()) nows.push_back(realOf(t));
    if (row.find("ramp")) {
      const Value& ramp = row["ramp"];
      double start = realOf(ramp["start"]);
      double every = realOf(ramp["every"]);
      for (int i = 0; i < static_cast<int>(ramp["count"].asNumber()); ++i) {
        double offset = i * every;
        nows.push_back(start + offset);
      }
    }
    for (std::size_t i = 0; i < nows.size(); ++i) {
      if (static_cast<int>(i) == resetAt) meter.reset();
      meter.frame(nows[i]);
      times.push(bitsOf(nows[i]));
      fps.push(bitsOf(meter.fps()));
    }
    item.set("resetAt", resetAt);
    item.set("times", std::move(times));
    item.set("fps", std::move(fps));
    meters.push(std::move(item));
  }
  out.set("fpsMeters", std::move(meters));
  return out;
}

// ---------------------------------------------------------------------------------------------
// rng

Value rngUnit(const Value& scenario) {
  Value out = Value::array();
  for (const Value& stream : scenario["streams"].items()) {
    studio::Rng rng;
    if (stream.find("seed")) {
      std::uint64_t sequence = stream.find("sequence") ? u64Of(stream["sequence"]) : studio::Rng::DEFAULT_SEQUENCE;
      rng = studio::Rng(u64Of(stream["seed"]), sequence);
    }
    Value results = Value::array();
    for (const Value& op : stream["ops"].items()) {
      const Value::Array& args = op.items();
      const std::string& name = args[0].asString();
      Value got = Value::array();
      if (name == "reseed") {
        rng.reseed(u64Of(args[1]), args.size() > 2 ? u64Of(args[2]) : studio::Rng::DEFAULT_SEQUENCE);
      } else if (name == "next") {
        for (int i = 0; i < static_cast<int>(args[1].asNumber()); ++i) got.push(rng.next());
      } else if (name == "below") {
        auto bound = static_cast<std::uint32_t>(u64Of(args[1]));
        for (int i = 0; i < static_cast<int>(args[2].asNumber()); ++i) got.push(rng.below(bound));
      } else if (name == "nextInt") {
        int lo = static_cast<int>(args[1].asNumber());
        int hi = static_cast<int>(args[2].asNumber());
        for (int i = 0; i < static_cast<int>(args[3].asNumber()); ++i) got.push(rng.nextInt(lo, hi));
      } else if (name == "unit") {
        for (int i = 0; i < static_cast<int>(args[1].asNumber()); ++i) got.push(floatBits(rng.unit()));
      } else if (name == "nextFloat") {
        float lo = floatOf(args[1]);
        float hi = floatOf(args[2]);
        for (int i = 0; i < static_cast<int>(args[3].asNumber()); ++i) got.push(floatBits(rng.nextFloat(lo, hi)));
      } else if (name == "chance") {
        float p = floatOf(args[1]);
        for (int i = 0; i < static_cast<int>(args[2].asNumber()); ++i) got.push(rng.chance(p));
      }
      results.push(std::move(got));
    }
    Value item = Value::object();
    if (stream.find("seed")) item.set("seed", stream["seed"]);
    if (stream.find("sequence")) item.set("sequence", stream["sequence"]);
    item.set("ops", stream["ops"]);
    item.set("results", std::move(results));
    out.push(std::move(item));
  }
  Value wrapped = Value::object();
  wrapped.set("streams", std::move(out));
  return wrapped;
}

// ---------------------------------------------------------------------------------------------
// fnv

Value fnvUnit(const Value& scenario) {
  Value out = Value::object();
  Value digests = Value::array();
  for (const Value& spec : scenario["texts"].items()) {
    std::string bytes = textOf(spec);
    Value item = Value::object();
    item.set("hex", hexOf(bytes));
    item.set("digest", studio::hex64(studio::fnv1a64(std::string_view(bytes))));
    digests.push(std::move(item));
  }
  out.set("texts", std::move(digests));
  Value chained = Value::array();
  for (const Value& row : scenario["chained"].items()) {
    std::string bytes = textOf(row["text"]);
    auto split = static_cast<std::size_t>(row["split"].asNumber());
    std::uint64_t half = studio::fnv1a64(bytes.data(), split);
    Value item = Value::object();
    item.set("hex", hexOf(bytes));
    item.set("split", static_cast<double>(split));
    item.set("half", studio::hex64(half));
    item.set("whole", studio::hex64(studio::fnv1a64(bytes.data() + split, bytes.size() - split, half)));
    chained.push(std::move(item));
  }
  out.set("chained", std::move(chained));
  // digest_test.cpp's `print` row: 4096 bytes, byte i = (i * 31 + 7) mod 256.
  std::vector<unsigned char> pattern(4096);
  for (std::size_t i = 0; i < pattern.size(); ++i) pattern[i] = static_cast<unsigned char>((i * 31 + 7) % 256);
  out.set("pattern4096", studio::hex64(studio::fnv1a64(pattern.data(), pattern.size())));
  Value hexes = Value::array();
  for (const Value& value : scenario["hex64"].items()) {
    Value item = Value::object();
    item.set("value", value);
    item.set("text", studio::hex64(u64Of(value)));
    hexes.push(std::move(item));
  }
  out.set("hex64", std::move(hexes));
  return out;
}

// ---------------------------------------------------------------------------------------------
// json

std::string_view errorName(json::ParseError error) {
  switch (error) {
    case json::ParseError::None:
      return "none";
    case json::ParseError::Syntax:
      return "syntax";
    case json::ParseError::TooDeep:
      return "too-deep";
  }
  return "?";
}

Value jsonUnit(const Value& scenario) {
  Value out = Value::object();
  Value parses = Value::array();
  for (const Value& spec : scenario["parse"].items()) {
    json::Parsed parsed = json::parse(textOf(spec));
    Value item = Value::object();
    item.set("text", spec);
    item.set("error", errorName(parsed.error));
    item.set("dump", hexOf(parsed.value.dump()));
    parses.push(std::move(item));
  }
  out.set("parse", std::move(parses));
  Value depths = Value::array();
  for (const Value& row : scenario["depthLimits"].items()) {
    json::Parsed parsed = json::parse(textOf(row["text"]), static_cast<int>(row["maxDepth"].asNumber()));
    Value item = Value::object();
    item.set("text", row["text"]);
    item.set("maxDepth", row["maxDepth"]);
    item.set("error", errorName(parsed.error));
    depths.push(std::move(item));
  }
  out.set("depthLimits", std::move(depths));
  Value numbers = Value::array();
  auto number = [&numbers](double value) {
    Value item = Value::object();
    item.set("bits", bitsOf(value));
    item.set("text", json::formatNumber(value));
    numbers.push(std::move(item));
  };
  for (const Value& value : scenario["numbers"].items()) number(realOf(value));
  const Value& generated = scenario["generatedNumbers"];
  studio::Rng rng(u64Of(generated["seed"]));
  for (int i = 0; i < static_cast<int>(generated["count"].asNumber()); ++i) {
    std::uint64_t bits = draw64(rng);
    double raw = 0;
    std::memcpy(&raw, &bits, sizeof raw);
    if (std::isfinite(raw)) number(raw);
    // Values a probe holds: game-sized decimals, floats widened to double, integers past 2^53.
    number(static_cast<double>(static_cast<std::int32_t>(rng.next())) / 1000.0);
    number(static_cast<double>(rng.nextFloat(-1000.0f, 1000.0f)));
    number(static_cast<double>(bits >> 9));
  }
  out.set("numbers", std::move(numbers));
  Value quotes = Value::array();
  for (const Value& spec : scenario["quote"].items()) {
    std::string bytes = textOf(spec);
    Value item = Value::object();
    item.set("hex", hexOf(bytes));
    item.set("quoted", hexOf(json::quote(bytes)));
    quotes.push(std::move(item));
  }
  out.set("quote", std::move(quotes));
  return out;
}

// ---------------------------------------------------------------------------------------------
// input

Value padsOf(const studio::Pads& pads) {
  Value out = Value::array();
  for (int p = 0; p < studio::MAX_PADS; ++p) {
    const studio::PadState& state = pads.states()[static_cast<std::size_t>(p)];
    Value pad = Value::object();
    pad.set("connected", state.connected);
    Value buttons = Value::array();
    for (float button : state.buttons) buttons.push(floatBits(button));
    Value axes = Value::array();
    for (float axis : state.axes) axes.push(floatBits(axis));
    Value down = Value::array();
    Value pressed = Value::array();
    Value released = Value::array();
    for (int b = 0; b < studio::PAD_BUTTONS; ++b) {
      if (pads.down(p, b)) down.push(b);
      if (pads.pressed(p, b)) pressed.push(b);
      if (pads.released(p, b)) released.push(b);
    }
    pad.set("buttons", std::move(buttons));
    pad.set("axes", std::move(axes));
    pad.set("down", std::move(down));
    pad.set("pressed", std::move(pressed));
    pad.set("released", std::move(released));
    out.push(std::move(pad));
  }
  return out;
}

/** Queries a game might make with a hostile pad or button index. */
Value hostilePadQueries(const studio::Pads& pads) {
  Value out = Value::array();
  for (int pad : {-1, 0, 3, 4, 99}) {
    for (int index : {-1, 0, 16, 17, 99}) {
      out.push(pads.down(pad, index));
      out.push(pads.pressed(pad, index));
      out.push(pads.released(pad, index));
      out.push(floatBits(pads.value(pad, index)));
      out.push(floatBits(pads.axis(pad, index)));
    }
    out.push(pads.connected(pad));
  }
  out.push(pads.count());
  return out;
}

Value tickOf(const studio::TickInput& tick, const std::vector<std::string>& queries) {
  Value out = Value::object();
  out.set("held", strings(tick.keys.held()));
  Value down = Value::array();
  Value pressed = Value::array();
  Value released = Value::array();
  for (const std::string& key : queries) {
    if (tick.keys.down(key)) down.push(key);
    if (tick.keys.pressed(key)) pressed.push(key);
    if (tick.keys.released(key)) released.push(key);
  }
  out.set("down", std::move(down));
  out.set("pressed", std::move(pressed));
  out.set("released", std::move(released));
  out.set("look", vec2(tick.look));
  out.set("wheel", vec2(tick.wheel));
  out.set("pointer", vec2(tick.pointer));
  out.set("pointerLock", tick.pointerLock);
  out.set("text", hexOf(tick.text));
  out.set("pads", padsOf(tick.pads));
  out.set("hostilePads", hostilePadQueries(tick.pads));
  return out;
}

Value injectionOf(const studio::Injection& injection) {
  Value out = Value::object();
  out.set("down", strings(injection.down));
  out.set("up", strings(injection.up));
  out.set("tap", strings(injection.tap));
  out.set("look", vec2(injection.look));
  out.set("wheel", vec2(injection.wheel));
  out.set("hasPointer", injection.hasPointer);
  out.set("pointer", vec2(injection.pointer));
  Value pads = Value::array();
  for (const auto& [index, state] : injection.pads) {
    Value pad = Value::object();
    pad.set("index", index);
    pad.set("connected", state.connected);
    Value buttons = Value::array();
    for (float button : state.buttons) buttons.push(floatBits(button));
    Value axes = Value::array();
    for (float axis : state.axes) axes.push(floatBits(axis));
    pad.set("buttons", std::move(buttons));
    pad.set("axes", std::move(axes));
    pads.push(std::move(pad));
  }
  out.set("pads", std::move(pads));
  out.set("text", hexOf(injection.text));
  out.set("ignored", injection.ignored);
  return out;
}

/** A scenario's injection: parsed from `inject`, then raw fields set directly, as code may build one. */
studio::Injection injectionFrom(const Value& step) {
  studio::Injection injection = studio::parseInjection(step["inject"]);
  if (step.find("rawText")) injection.text = textOf(step["rawText"]);
  if (step.find("rawDown")) injection.down = stringList(step["rawDown"]);
  if (step.find("rawUp")) injection.up = stringList(step["rawUp"]);
  if (step.find("rawTap")) injection.tap = stringList(step["rawTap"]);
  return injection;
}

studio::PadStates padStatesOf(const Value& list) {
  studio::PadStates pads{};
  for (const Value& pad : list.items()) {
    auto index = static_cast<std::size_t>(pad["index"].asNumber());
    studio::PadState& state = pads[index];
    state.connected = pad["connected"].asBool(true);
    const Value::Array& buttons = pad["buttons"].items();
    for (std::size_t i = 0; i < buttons.size() && i < state.buttons.size(); ++i) state.buttons[i] = floatOf(buttons[i]);
    const Value::Array& axes = pad["axes"].items();
    for (std::size_t i = 0; i < axes.size() && i < state.axes.size(); ++i) state.axes[i] = floatOf(axes[i]);
  }
  return pads;
}

studio::FrameSample sampleOf(const Value& frame) {
  studio::FrameSample sample;
  sample.held = stringList(frame["held"]);
  sample.pressed = stringList(frame["pressed"]);
  sample.released = stringList(frame["released"]);
  sample.look = vec2Of(frame["look"]);
  sample.wheel = vec2Of(frame["wheel"]);
  sample.pointer = vec2Of(frame["pointer"], {0.5f, 0.5f});
  sample.pointerLock = frame["pointerLock"].asBool();
  sample.pads = padStatesOf(frame["pads"]);
  sample.text = textOf(frame["text"]);
  return sample;
}

Value inputUnit(const Value& scenario) {
  Value out = Value::object();
  Value canonical = Value::array();
  for (const Value& spec : scenario["canonical"].items()) {
    Value item = Value::object();
    item.set("name", spec);
    item.set("key", studio::canonicalKey(textOf(spec)));
    canonical.push(std::move(item));
  }
  out.set("canonical", std::move(canonical));

  Value texts = Value::array();
  for (const Value& row : scenario["appendText"].items()) {
    std::string into = textOf(row["into"]);
    studio::appendText(into, textOf(row["text"]));
    Value item = Value::object();
    item.set("into", row["into"]);
    item.set("text", row["text"]);
    item.set("result", hexOf(into));
    texts.push(std::move(item));
  }
  out.set("appendText", std::move(texts));

  Value triggers = Value::array();
  for (const Value& row : scenario["triggers"].items()) {
    Value item = Value::object();
    item.set("down", row["down"]);
    item.set("axisCount", row["axisCount"]);
    item.set("axis", row["axis"]);
    item.set("reading", bitsOf(realOf(row["reading"])));
    float value = studio::triggerValue(row["down"].asBool(), static_cast<int>(row["axisCount"].asNumber()),
                                       static_cast<int>(row["axis"].asNumber()), floatOf(row["reading"]));
    item.set("value", floatBits(value));
    triggers.push(std::move(item));
  }
  out.set("triggers", std::move(triggers));

  Value parses = Value::array();
  for (const Value& spec : scenario["parse"].items()) {
    json::Parsed parsed = json::parse(textOf(spec));
    Value item = Value::object();
    item.set("arg", spec);
    item.set("injection", injectionOf(studio::parseInjection(parsed.value)));
    parses.push(std::move(item));
  }
  out.set("parse", std::move(parses));

  Value merges = Value::array();
  for (const Value& scene : scenario["merges"].items()) {
    studio::InputMerger merger;
    std::vector<std::string> queries = stringList(scene["keys"]);
    Value results = Value::array();
    for (const Value& step : scene["steps"].items()) {
      if (step.find("inject")) {
        merger.inject(injectionFrom(step));
        results.push(Value());
      } else if (step.find("sample")) {
        merger.sample(sampleOf(step["sample"]));
        results.push(Value());
      } else if (step.find("next")) {
        results.push(tickOf(merger.next(), queries));
      } else if (step.find("held")) {
        results.push(strings(merger.held()));
      } else if (step.find("clear")) {
        merger.clear();
        results.push(Value());
      }
    }
    Value item = Value::object();
    item.set("name", scene["name"]);
    item.set("keys", scene["keys"]);
    item.set("steps", scene["steps"]);
    item.set("results", std::move(results));
    merges.push(std::move(item));
  }
  out.set("merges", std::move(merges));
  return out;
}

// ---------------------------------------------------------------------------------------------
// session: a toy game the Rust side mirrors (crates/genex-core/tests/golden/toy.rs).

struct Toy {
  std::uint32_t seed = 0;
  double x = 0;
  double wheel = 0;
  int jumps = 0;
  int walked = 0;
  int rolls = 0;
  double drift = 0;
  int textBytes = 0;
  int padPresses = 0;
  double pointerX = 0;
  int lastTick = -1;
  int resets = 0;
};

Value toyProbes(const Toy& toy) {
  Value probes = Value::object();
  probes.set("x", toy.x);
  probes.set("wheel", toy.wheel);
  probes.set("jumps", toy.jumps);
  probes.set("walked", toy.walked);
  probes.set("rolls", toy.rolls);
  probes.set("drift", toy.drift);
  probes.set("textBytes", toy.textBytes);
  probes.set("padPresses", toy.padPresses);
  probes.set("pointerX", toy.pointerX);
  probes.set("lastTick", toy.lastTick);
  probes.set("resets", toy.resets);
  // A probe that names a runtime key: the snapshot keeps the runtime's, the checksum keeps both.
  probes.set("frame", 999);
  Value wall = Value::object();
  wall.set("ms", toy.lastTick * 0.25);
  probes.set("volatile", std::move(wall));
  return probes;
}

Value sessionUnit(const Value& scenario) {
  Value out = Value::object();
  Value sessions = Value::array();
  for (const Value& scene : scenario["sessions"].items()) {
    Toy toy;
    studio::Session* live = nullptr;
    studio::SessionHooks hooks;
    hooks.reset = [&toy](std::uint32_t seed) {
      int resets = toy.resets + 1;
      toy = Toy();
      toy.seed = seed;
      toy.resets = resets;
    };
    hooks.tick = [&toy, &live](const studio::TickInput& input, int tick) {
      studio::Rng& rng = live->rng();
      toy.x += input.look.x;
      toy.wheel += input.wheel.y;
      if (input.keys.pressed("Space")) ++toy.jumps;
      if (input.keys.down("w")) ++toy.walked;
      toy.rolls += rng.nextInt(1, 6);
      toy.drift += rng.nextFloat(-0.5f, 0.5f);
      toy.textBytes += static_cast<int>(input.text.size());
      if (input.pads.pressed(0, studio::PadButton::A)) ++toy.padPresses;
      toy.pointerX = input.pointer.x;
      toy.lastTick = tick;
    };
    double stepMs = scene.find("stepMs") ? realOf(scene["stepMs"]) : studio::FIXED_STEP_MS;
    studio::Session session(hooks, stepMs);
    live = &session;
    Value results = Value::array();
    for (const Value& step : scene["steps"].items()) {
      Value result;
      if (step.find("seed")) {
        result = Value(session.seed(static_cast<std::uint32_t>(u64Of(step["seed"]))));
      } else if (step.find("start")) {
        result = Value(session.start());
      } else if (step.find("pause")) {
        result = Value(session.pause());
      } else if (step.find("step")) {
        studio::StepResult stepped = session.step(realOf(step["step"]));
        result = Value::object();
        result.set("ticks", stepped.ticks);
        result.set("frame", stepped.frame);
        result.set("simulatedMs", bitsOf(stepped.simulatedMs));
      } else if (step.find("frame")) {
        result = Value(session.frame(realOf(step["frame"])));
      } else if (step.find("inject")) {
        result = strings(session.inject(injectionFrom(step)));
      } else if (step.find("sample")) {
        session.sample(sampleOf(step["sample"]));
      } else if (step.find("takeRender")) {
        result = Value(session.takeRender());
      } else if (step.find("requestRender")) {
        session.requestRender();
      } else if (step.find("snapshot")) {
        const Value& extrasSpec = step["snapshot"];
        studio::StateExtras extras;
        extras.fps = extrasSpec.find("fps") ? realOf(extrasSpec["fps"]) : 0;
        if (extrasSpec.find("camera")) extras.camera = extrasSpec["camera"].asString();
        extras.probes = toyProbes(toy);
        extras.hud = extrasSpec["hud"];
        extras.render = extrasSpec["render"];
        extras.assets = extrasSpec["assets"];
        extras.error = extrasSpec["error"].asString();
        extras.player = extrasSpec["player"];
        result = Value::object();
        result.set("state", studio::snapshot(session, extras).dump());
        result.set("checksum", studio::checksum(session.seedValue(), session.tick(), extras.probes));
        result.set("last", tickOf(session.last(), stringList(scene["keys"])));
      }
      results.push(std::move(result));
    }
    Value item = Value::object();
    item.set("name", scene["name"]);
    if (scene.find("stepMs")) item.set("stepMs", bitsOf(stepMs));
    item.set("keys", scene["keys"]);
    item.set("steps", scene["steps"]);
    item.set("results", std::move(results));
    sessions.push(std::move(item));
  }
  out.set("sessions", std::move(sessions));

  Value checksums = Value::array();
  for (const Value& row : scenario["checksums"].items()) {
    json::Parsed probes = json::parse(textOf(row["probes"]));
    Value item = Value::object();
    item.set("seed", row["seed"]);
    item.set("tick", row["tick"]);
    item.set("probes", row["probes"]);
    item.set("checksum", studio::checksum(static_cast<std::uint32_t>(u64Of(row["seed"])),
                                          static_cast<int>(row["tick"].asNumber()), probes.value));
    checksums.push(std::move(item));
  }
  out.set("checksums", std::move(checksums));

  Value timings = Value::array();
  for (const Value& row : scenario["timings"].items()) {
    studio::FrameTiming timing;
    for (const Value& frame : row["frames"].items()) {
      timing.record(realOf(frame.items()[0]), realOf(frame.items()[1]), realOf(frame.items()[2]));
    }
    if (row.find("generated")) {
      studio::Rng rng(u64Of(row["generated"]["seed"]));
      for (int i = 0; i < static_cast<int>(row["generated"]["count"].asNumber()); ++i) {
        double frameMs = static_cast<double>(rng.below(50000)) / 1000.0;
        double updateMs = static_cast<double>(rng.below(8000)) / 1000.0;
        double drawMs = static_cast<double>(rng.below(12000)) / 1000.0;
        timing.record(frameMs, updateMs, drawMs);
      }
    }
    studio::Timings got = timing.timings();
    Value item = Value::object();
    item.set("frames", row["frames"]);
    if (row.find("generated")) item.set("generated", row["generated"]);
    item.set("frameMs", bitsOf(got.frameMs));
    item.set("updateMs", bitsOf(got.updateMs));
    item.set("drawMs", bitsOf(got.drawMs));
    item.set("count", static_cast<double>(got.frames));
    timings.push(std::move(item));
  }
  out.set("timings", std::move(timings));

  Value audio = Value::array();
  for (const Value& row : scenario["audio"].items()) {
    studio::AudioMeter meter;
    studio::Rng rng(u64Of(row["seed"]));
    float amplitude = floatOf(row["amplitude"]);
    Value levels = Value::array();
    for (const Value& frames : row["feeds"].items()) {
      std::vector<float> samples;
      auto count = static_cast<std::size_t>(frames.asNumber());
      for (std::size_t i = 0; i < count * 2; ++i) samples.push_back(rng.nextFloat(-amplitude, amplitude));
      if (row["poison"].asBool() && !samples.empty()) {
        samples[0] = std::numeric_limits<float>::quiet_NaN();
        samples[samples.size() - 1] = 7.0f;
      }
      meter.feed(samples.data(), count);
      studio::AudioLevel level = meter.level(realOf(row["rate"]));
      Value item = Value::object();
      item.set("rms", bitsOf(level.rms));
      item.set("centroid", bitsOf(level.centroid));
      levels.push(std::move(item));
    }
    Value item = Value::object();
    item.set("seed", row["seed"]);
    item.set("amplitude", row["amplitude"]);
    item.set("rate", row["rate"]);
    item.set("poison", row["poison"].asBool());
    item.set("feeds", row["feeds"]);
    item.set("levels", std::move(levels));
    audio.push(std::move(item));
  }
  out.set("audio", std::move(audio));
  return out;
}

// ---------------------------------------------------------------------------------------------
// paths

using studio::paths::Destination;
using studio::paths::SaveRefusal;

std::optional<Destination> destinationNamed(std::string_view name) {
  if (name == "genex-run") return Destination::GenexRun;
  if (name == "web") return Destination::Web;
  if (name == "mac") return Destination::Mac;
  if (name == "windows") return Destination::Windows;
  if (name == "linux") return Destination::Linux;
  return std::nullopt;
}

std::string_view refusalName(SaveRefusal refusal) {
  switch (refusal) {
    case SaveRefusal::None:
      return "none";
    case SaveRefusal::NoStateDir:
      return "no-state-dir";
    case SaveRefusal::NoHome:
      return "no-home";
    case SaveRefusal::NoAppData:
      return "no-app-data";
    case SaveRefusal::BadName:
      return "bad-name";
    case SaveRefusal::BadBundleId:
      return "bad-bundle-id";
  }
  return "?";
}

std::string_view destinationName(Destination where) {
  switch (where) {
    case Destination::GenexRun:
      return "genex-run";
    case Destination::Web:
      return "web";
    case Destination::Mac:
      return "mac";
    case Destination::Windows:
      return "windows";
    case Destination::Linux:
      return "linux";
  }
  return "?";
}

studio::paths::Env envOf(const Value& vars) {
  std::map<std::string, std::string> table;
  for (const Value::Member& member : vars.members()) table[member.key] = textOf(member.value);
  return [table](std::string_view name) -> std::optional<std::string> {
    auto found = table.find(std::string(name));
    if (found == table.end()) return std::nullopt;
    return found->second;
  };
}

Value pathsUnit(const Value& scenario) {
  Value out = Value::object();
  Value roots = Value::array();
  for (const Value& row : scenario["saveRoots"].items()) {
    std::string name = textOf(row["name"]);
    std::string bundle = textOf(row["bundleId"]);
    std::optional<Destination> where = destinationNamed(row["destination"].asString());
    if (!where) continue;
    studio::paths::SaveRoot root = studio::paths::saveRoot(*where, envOf(row["env"]), {name, bundle});
    Value item = Value::object();
    item.set("destination", row["destination"]);
    item.set("env", row["env"]);
    item.set("name", row["name"]);
    item.set("bundleId", row["bundleId"]);
    item.set("refusal", refusalName(root.refusal));
    item.set("path", root.path);
    roots.push(std::move(item));
  }
  out.set("saveRoots", std::move(roots));

  Value assets = Value::array();
  for (const Value& spec : scenario["assetPaths"].items()) {
    Value item = Value::object();
    item.set("path", spec);
    item.set("safe", studio::paths::isSafeAssetPath(textOf(spec)));
    assets.push(std::move(item));
  }
  out.set("assetPaths", std::move(assets));

  Value claims = Value::array();
  for (const Value& row : scenario["assetClaims"].items()) {
    Value item = Value::object();
    item.set("file", row["file"]);
    item.set("root", row["root"]);
    item.set("claim", studio::paths::assetClaim(textOf(row["file"]), textOf(row["root"])));
    claims.push(std::move(item));
  }
  out.set("assetClaims", std::move(claims));

  Value captures = Value::array();
  for (const Value& row : scenario["captures"].items()) {
    std::string root = textOf(row["root"]);
    auto seq = static_cast<std::uint32_t>(u64Of(row["seq"]));
    Value item = Value::object();
    item.set("root", row["root"]);
    item.set("seq", row["seq"]);
    item.set("folder", studio::paths::captureFolder(root));
    item.set("path", studio::paths::capturePath(root, seq));
    captures.push(std::move(item));
  }
  out.set("captures", std::move(captures));

  Value logs = Value::array();
  for (const Value& row : scenario["claimedFiles"].items()) {
    Value item = Value::object();
    item.set("informational", row["informational"]);
    item.set("line", row["line"]);
    item.set("saveRoot", row["saveRoot"]);
    std::string line = textOf(row["line"]);
    std::string saveRoot = textOf(row["saveRoot"]);
    item.set("file", std::string(studio::paths::claimedFile(row["informational"].asBool(), line, saveRoot)));
    logs.push(std::move(item));
  }
  out.set("claimedFiles", std::move(logs));

  Value environments = Value::array();
  for (const Value& env : scenario["environments"].items()) {
    Value item = Value::object();
    item.set("env", env);
    item.set("prefersX11", studio::paths::prefersX11(envOf(env)));
    item.set("destination", destinationName(studio::paths::destinationOf(envOf(env))));
    environments.push(std::move(item));
  }
  out.set("environments", std::move(environments));

  Value identities = Value::array();
  for (const Value& row : scenario["identities"].items()) {
    std::string name = textOf(row["saveName"]);
    std::string bundle = textOf(row["runningBundleId"]);
    studio::paths::GameIdentity identity = studio::paths::identityOf(name, bundle);
    Value item = Value::object();
    item.set("saveName", row["saveName"]);
    item.set("runningBundleId", row["runningBundleId"]);
    item.set("name", std::string(identity.name));
    item.set("bundleId", std::string(identity.bundleId));
    identities.push(std::move(item));
  }
  out.set("identities", std::move(identities));
  return out;
}

// ---------------------------------------------------------------------------------------------
// protocol

class Chunks : public studio::protocol::ByteSource {
 public:
  explicit Chunks(std::vector<std::string> chunks) : chunks_(std::move(chunks)) {}
  long read(char* into, std::size_t capacity) override {
    while (next_ < chunks_.size() && offset_ == chunks_[next_].size()) {
      ++next_;
      offset_ = 0;
    }
    if (next_ == chunks_.size()) return 0;
    const std::string& chunk = chunks_[next_];
    std::size_t count = std::min(capacity, chunk.size() - offset_);
    std::memcpy(into, chunk.data() + offset_, count);
    offset_ += count;
    return static_cast<long>(count);
  }

 private:
  std::vector<std::string> chunks_;
  std::size_t next_ = 0;
  std::size_t offset_ = 0;
};

/** A framed line: its bytes when short, its length and digest when long. */
Value lineOf(const studio::protocol::NextLine& line) {
  Value out = Value::object();
  if (line.status == studio::protocol::LineStatus::TooLong) {
    out.set("status", "too-long");
    return out;
  }
  out.set("status", "line");
  if (line.text.size() <= 256) {
    out.set("hex", hexOf(line.text));
  } else {
    out.set("length", static_cast<double>(line.text.size()));
    out.set("digest", studio::hex64(studio::fnv1a64(std::string_view(line.text))));
  }
  return out;
}

/** protocol_test.cpp's dispatcher, plus `echo`, which answers its argument (a dump round trip). */
studio::protocol::Dispatcher dispatcher() {
  studio::protocol::Dispatcher calls;
  calls.on("state", [](const Value&) { return studio::protocol::answer(Value::object()); });
  calls.on("seed", [](const Value& arg) {
    Value result = Value::object();
    result.set("seed", arg["seed"].asNumber());
    return studio::protocol::answer(result);
  });
  calls.on("demo", [](const Value&) { return studio::protocol::refuse("no-such-demo"); });
  calls.on("echo", [](const Value& arg) { return studio::protocol::answer(arg); });
  return calls;
}

Value protocolUnit(const Value& scenario) {
  Value out = Value::object();
  Value framings = Value::array();
  for (const Value& row : scenario["framing"].items()) {
    std::vector<std::string> chunks;
    for (const Value& chunk : row["chunks"].items()) chunks.push_back(textOf(chunk));
    Chunks source(chunks);
    std::size_t cap =
        row.find("cap") ? static_cast<std::size_t>(row["cap"].asNumber()) : studio::protocol::MAX_LINE_BYTES;
    studio::protocol::LineReader reader(source, cap);
    Value lines = Value::array();
    for (;;) {
      studio::protocol::NextLine next = reader.next();
      if (next.status == studio::protocol::LineStatus::End) break;
      lines.push(lineOf(next));
    }
    // After the end the reader keeps answering End.
    bool endStays = reader.next().status == studio::protocol::LineStatus::End;
    Value item = Value::object();
    item.set("name", row["name"]);
    item.set("chunks", row["chunks"]);
    if (row.find("cap")) item.set("cap", row["cap"]);
    item.set("lines", std::move(lines));
    item.set("endStays", endStays);
    framings.push(std::move(item));
  }
  out.set("framing", std::move(framings));

  studio::protocol::Dispatcher calls = dispatcher();
  Value replies = Value::array();
  for (const Value& spec : scenario["handle"].items()) {
    Value item = Value::object();
    item.set("line", spec);
    item.set("reply", hexOf(calls.handle(textOf(spec))));
    replies.push(std::move(item));
  }
  out.set("handle", std::move(replies));
  out.set("lineTooLong", calls.lineTooLong());
  out.set("ops", strings(calls.ops()));

  Value direct = Value::array();
  for (const Value& row : scenario["call"].items()) {
    Value item = Value::object();
    item.set("op", row["op"]);
    item.set("arg", row["arg"]);
    item.set("reply", calls.call(row["op"].asString(), row["arg"]));
    direct.push(std::move(item));
  }
  out.set("call", std::move(direct));

  Value events = Value::array();
  for (const Value& row : scenario["events"].items()) {
    Value item = Value::object();
    item.set("name", row["name"]);
    item.set("fields", row["fields"]);
    item.set("line", studio::protocol::event(row["name"].asString(), row["fields"]));
    events.push(std::move(item));
  }
  out.set("events", std::move(events));
  return out;
}

// ---------------------------------------------------------------------------------------------

struct Unit {
  const char* name;
  Value (*run)(const Value& scenario);
};

const Unit UNITS[] = {
    {"clock", clockUnit}, {"rng", rngUnit},         {"fnv", fnvUnit},     {"json", jsonUnit},
    {"input", inputUnit}, {"session", sessionUnit}, {"paths", pathsUnit}, {"protocol", protocolUnit},
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: golden_driver <unit> <scenario.json>\n");
    return 2;
  }
  std::ifstream file(argv[2], std::ios::binary);
  std::stringstream text;
  text << file.rdbuf();
  json::Parsed scenario = json::parse(text.str(), 64);
  if (!scenario.ok()) {
    std::fprintf(stderr, "scenario %s does not parse\n", argv[2]);
    return 2;
  }
  for (const Unit& unit : UNITS) {
    if (std::strcmp(unit.name, argv[1]) != 0) continue;
    Value golden = Value::object();
    golden.set("unit", unit.name);
    golden.set("cases", unit.run(scenario.value));
    std::string out = golden.dump();
    std::fwrite(out.data(), 1, out.size(), stdout);
    std::fputc('\n', stdout);
    return 0;
  }
  std::fprintf(stderr, "no unit named %s\n", argv[1]);
  return 2;
}
