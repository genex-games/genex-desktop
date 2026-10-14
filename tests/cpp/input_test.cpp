// Rows for src/input.*: key names, the per-tick merge of real and injected input, gamepads,
// committed text and the `input` argument parser. Run with no argument for every row, or with a
// row name for one.
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "input.h"
#include "json.h"

namespace {

using studio::Injection;
using studio::InputMerger;
namespace PadAxis = studio::PadAxis;
namespace PadButton = studio::PadButton;
using studio::TickInput;

void canonicalKeys() {
  const char* table[][2] = {
      {"w", "KeyW"},         {"W", "KeyW"},       {"KeyW", "KeyW"},       {"7", "Digit7"},
      {" ", "Space"},        {"Spacebar", "Space"}, {"Enter", "Enter"},    {"Return", "Enter"},
      {"Esc", "Escape"},     {"Up", "ArrowUp"},   {"ArrowLeft", "ArrowLeft"}, {"Shift", "ShiftLeft"},
      {"Control", "ControlLeft"}, {"Ctrl", "ControlLeft"}, {"Mouse1", "Mouse1"}, {"F5", "F5"},
  };
  for (const auto& row : table) assert(studio::canonicalKey(row[0]) == row[1]);
  assert(studio::canonicalKey("").empty());
  assert(studio::canonicalKey(std::string(200, 'x')).empty());
}

void edgesFirstTick() {
  InputMerger merger;
  Injection down;
  down.down = {"w"};
  merger.inject(down);
  TickInput first = merger.next();
  TickInput second = merger.next();
  assert(first.keys.down("KeyW") && first.keys.pressed("KeyW") && first.keys.pressed("w"));
  assert(second.keys.down("KeyW") && !second.keys.pressed("KeyW"));
  Injection up;
  up.up = {"KeyW"};
  merger.inject(up);
  TickInput third = merger.next();
  TickInput fourth = merger.next();
  assert(!third.keys.down("KeyW") && third.keys.released("KeyW"));
  assert(!fourth.keys.released("KeyW"));
  assert(merger.held().empty());
}

void tap() {
  InputMerger merger;
  Injection tap;
  tap.tap = {"KeyE"};
  merger.inject(tap);
  TickInput first = merger.next();
  TickInput second = merger.next();
  assert(first.keys.pressed("KeyE") && first.keys.released("KeyE") && !first.keys.down("KeyE"));
  assert(!second.keys.pressed("KeyE") && !second.keys.released("KeyE"));
}

void realEdges() {
  InputMerger merger;
  studio::FrameSample frame;
  frame.held = {"KeyA"};
  frame.look = {3, -4};
  frame.pointerLock = true;
  merger.sample(frame);
  TickInput first = merger.next();
  TickInput second = merger.next();
  assert(first.keys.pressed("KeyA") && first.look.x == 3 && first.look.y == -4);
  assert(second.keys.down("KeyA") && !second.keys.pressed("KeyA") && second.look.x == 0 && second.look.y == 0);
  Injection extra;
  extra.down = {"KeyB"};
  merger.inject(extra);
  std::vector<std::string> held = merger.held();
  assert((held == std::vector<std::string>{"KeyA", "KeyB"}));
}

/** A sampled frame whose only content is mouse movement. */
studio::FrameSample moved(studio::Vec2 look, bool locked, studio::Vec2 wheel = {}) {
  studio::FrameSample frame;
  frame.look = look;
  frame.wheel = wheel;
  frame.pointerLock = locked;
  return frame;
}

void lockGatesLook() {
  // Unlocked, the mouse is a cursor: hovering across the slot must not turn a mouse-look camera.
  InputMerger merger;
  merger.sample(moved({5, -2}, false, {0, 100}));
  TickInput unlocked = merger.next();
  assert(unlocked.look.x == 0 && unlocked.look.y == 0 && !unlocked.pointerLock);
  assert(unlocked.wheel.y == 100);
  merger.sample(moved({5, -2}, true));
  TickInput locked = merger.next();
  assert(locked.look.x == 5 && locked.look.y == -2 && locked.pointerLock);
}

void lookEchoes() {
  // One injected look also arrives as the page's synthetic move and, attended, a trusted one: the
  // runtime counts it once.
  InputMerger merger;
  Injection look;
  look.look = {5, 0};
  merger.inject(look);
  merger.sample(moved({5, 0}, true));
  assert(merger.next().look.x == 5);
  merger.sample(moved({0, 0}, true));  // a still frame is no echo and spends nothing
  merger.sample(moved({5, 0}, true));
  assert(merger.next().look.x == 0);
  merger.sample(moved({7, 0}, true));  // the echoes are spent: real movement counts again
  assert(merger.next().look.x == 7);
  // A new injection restarts the count instead of adding to it, so two injections never swallow four moves.
  merger.inject(look);
  merger.inject(look);
  merger.sample(moved({5, 0}, true));
  merger.sample(moved({5, 0}, true));
  merger.sample(moved({3, 0}, true));
  assert(merger.next().look.x == 13);
  Injection wheel;
  wheel.wheel = {0, 3};
  merger.inject(wheel);
  merger.sample(moved({}, false, {0, 3}));
  assert(merger.next().wheel.y == 3);
}

void injectedPointer() {
  InputMerger merger;
  studio::FrameSample resting;
  resting.pointer = {0.3f, 0.3f};
  merger.sample(resting);
  Injection move;
  move.hasPointer = true;
  move.pointer = {0.1f, 0.2f};
  merger.inject(move);
  merger.sample(resting);  // the real mouse has not moved: the injected position stands
  TickInput injected = merger.next();
  assert(injected.pointer.x == 0.1f && injected.pointer.y == 0.2f);
  studio::FrameSample person;
  person.pointer = {0.9f, 0.8f};
  merger.sample(person);  // a person moved the real mouse: it is the pointer again
  TickInput real = merger.next();
  assert(real.pointer.x == 0.9f && real.pointer.y == 0.8f);
  merger.sample(person);
  assert(merger.next().pointer.x == 0.9f);
}

void deltas() {
  InputMerger merger;
  Injection first;
  first.look = {1, 2};
  first.wheel = {0, 3};
  merger.inject(first);
  Injection second;
  second.look = {10, 20};
  merger.inject(second);
  TickInput tick = merger.next();
  assert(tick.look.x == 11 && tick.look.y == 22 && tick.wheel.y == 3);
  TickInput after = merger.next();
  assert(after.look.x == 0 && after.wheel.y == 0);
}

void pads() {
  InputMerger merger;
  studio::FrameSample frame;
  frame.pads[0].connected = true;
  frame.pads[0].buttons[PadButton::A] = 1;
  frame.pads[0].axes[PadAxis::LeftX] = 0.25f;
  merger.sample(frame);
  Injection injected;
  studio::PadState pad;
  pad.connected = true;
  pad.axes[PadAxis::LeftX] = -0.75f;
  pad.buttons[PadButton::Start] = 1;
  injected.pads.push_back({0, pad});
  studio::PadState second;
  second.connected = true;
  second.buttons[PadButton::B] = 0.9f;
  injected.pads.push_back({3, second});
  merger.inject(injected);
  TickInput tick = merger.next();
  assert(tick.pads.connected(0) && tick.pads.connected(3) && !tick.pads.connected(1));
  assert(tick.pads.count() == 2);
  assert(tick.pads.down(0, PadButton::A) && tick.pads.pressed(0, PadButton::A));
  assert(tick.pads.down(0, PadButton::Start));
  assert(tick.pads.axis(0, PadAxis::LeftX) == -0.75f);
  assert(tick.pads.pressed(3, PadButton::B));
  TickInput next = merger.next();
  assert(next.pads.down(0, PadButton::A) && !next.pads.pressed(0, PadButton::A));
  // Hostile indices answer "not connected" instead of reading outside the table.
  assert(!tick.pads.down(-1, 0) && !tick.pads.down(4, 0) && !tick.pads.down(0, 17) && tick.pads.axis(0, 99) == 0);
}

void triggers() {
  // raylib reads a trigger axis as -1 (released) to 1 (pulled). A browser's standard-mapping pad
  // has four axes, so raylib never writes the trigger axes there and they read 0: at rest that is
  // not half pulled, and the button is the trigger.
  constexpr int LEFT_TRIGGER_AXIS = 4;
  constexpr int RIGHT_TRIGGER_AXIS = 5;
  const int webAxes = studio::PAD_AXES;
  assert(studio::triggerValue(false, webAxes, LEFT_TRIGGER_AXIS, 0.0f) == 0);
  assert(studio::triggerValue(true, webAxes, RIGHT_TRIGGER_AXIS, 0.0f) == 1);
  // A desktop pad reports six axes: the analog reading counts, and the button still pulls it fully.
  const int desktopAxes = 6;
  assert(studio::triggerValue(false, desktopAxes, LEFT_TRIGGER_AXIS, -1.0f) == 0);
  assert(studio::triggerValue(false, desktopAxes, LEFT_TRIGGER_AXIS, 0.0f) == 0.5f);
  assert(studio::triggerValue(false, desktopAxes, RIGHT_TRIGGER_AXIS, 1.0f) == 1);
  assert(studio::triggerValue(true, desktopAxes, LEFT_TRIGGER_AXIS, -1.0f) == 1);
  // A reading outside -1..1 or not a number is clamped or ignored, never passed on.
  assert(studio::triggerValue(false, desktopAxes, LEFT_TRIGGER_AXIS, std::nanf("")) == 0);
  assert(studio::triggerValue(false, desktopAxes, LEFT_TRIGGER_AXIS, 9.0f) == 1);
  assert(studio::triggerValue(false, desktopAxes, -1, 1.0f) == 0);
}

void text() {
  InputMerger merger;
  Injection typed;
  typed.text = std::string(300, 'a');
  merger.inject(typed);
  TickInput first = merger.next();
  assert(first.text.size() == studio::MAX_TEXT_UNITS);
  assert(merger.next().text.empty());
  // The cap counts UTF-16 units, as the host does: an emoji is two, and one that would straddle
  // the cap is left out whole, so the text stays valid UTF-8.
  Injection accented;
  accented.text = std::string(255, 'b') + "\xc3\xa9";
  merger.inject(accented);
  assert(merger.next().text == std::string(255, 'b') + "\xc3\xa9");
  Injection straddling;
  straddling.text = std::string(255, 'b') + "\xf0\x9f\x98\x80";
  merger.inject(straddling);
  assert(merger.next().text == std::string(255, 'b'));
  Injection broken;
  broken.text = "a\xff\xc3" "b\x80" "c";
  merger.inject(broken);
  assert(merger.next().text == "abc");
  // Overlong (E0 80 AF), a UTF-16 surrogate (ED A0 80) and past U+10FFFF (F4 90 80 80) are not
  // UTF-8; the edges of each range (U+0800, U+D7FF, U+10000, U+10FFFF) are.
  Injection invalid;
  invalid.text = "a\xe0\x80\xaf" "b\xed\xa0\x80" "c\xf4\x90\x80\x80" "d";
  merger.inject(invalid);
  assert(merger.next().text == "abcd");
  const std::string edges = "\xe0\xa0\x80\xed\x9f\xbf\xf0\x90\x80\x80\xf4\x8f\xbf\xbf";
  Injection valid;
  valid.text = edges;
  merger.inject(valid);
  assert(merger.next().text == edges);
  Injection parts;
  parts.text = "h";
  merger.inject(parts);
  parts.text = "i";
  merger.inject(parts);
  assert(merger.next().text == "hi");
}

void parseInjection() {
  json::Value simple =
      json::parse(
          R"({"down":["w"],"up":["KeyS"],"look":{"x":1,"y":2},"wheel":{"y":3},)"
          R"("pointer":{"x":0.25,"y":0.5},"text":"hi",)"
          R"("pads":[{"index":1,"buttons":[1,0,0.5],"axes":[0.5,-0.5]}]})")
          .value;
  Injection parsed = studio::parseInjection(simple);
  assert((parsed.down == std::vector<std::string>{"KeyW"}) && (parsed.up == std::vector<std::string>{"KeyS"}));
  assert(parsed.look.x == 1 && parsed.look.y == 2 && parsed.wheel.y == 3);
  assert(parsed.hasPointer && parsed.pointer.x == 0.25f && parsed.pointer.y == 0.5f);
  assert(parsed.text == "hi");
  assert(parsed.pads.size() == 1 && parsed.pads[0].first == 1 && parsed.pads[0].second.buttons[2] == 0.5f);

  json::Value actions =
      json::parse(
          R"({"actions":[{"type":"down","keys":["ArrowUp"]},{"type":"tap","keys":["e"]},{"type":"look","dx":4,"dy":5},)"
          R"({"type":"scroll","dy":-2},{"type":"mousedown","button":"right"},{"type":"move","x":0.1,"y":0.9},)"
          R"({"type":"text","text":"ok"},{"type":"gamepad","index":0,"buttons":[0,1],"axes":[1]},)"
          R"({"type":"wait","ms":5}]})")
          .value;
  Injection fromActions = studio::parseInjection(actions);
  assert((fromActions.down == std::vector<std::string>{"ArrowUp", "Mouse2"}));
  assert((fromActions.tap == std::vector<std::string>{"KeyE"}));
  assert(fromActions.look.x == 4 && fromActions.look.y == 5 && fromActions.wheel.y == -2);
  assert(fromActions.hasPointer && fromActions.pointer.y == 0.9f);
  assert(fromActions.text == "ok");
  assert(fromActions.pads.size() == 1 && fromActions.pads[0].second.buttons[PadButton::B] == 1);
  assert(fromActions.ignored == 1);
}

void hostileInjection() {
  json::Value hostile =
      json::parse(
          R"({"down":[1,null,"",{"k":1}],"look":{"x":"9","y":1e400},"pointer":{"x":-5,"y":9},"text":7,)"
          R"("pads":[{"index":7,"buttons":[1]},{"index":-1},{"index":0.5},{"index":2,"buttons":[)"
          R"(1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"axes":[9,-9,"x"]}]})")
          .value;
  Injection parsed = studio::parseInjection(hostile);
  assert(parsed.down.empty());
  assert(parsed.look.x == 0 && parsed.look.y == 0);
  assert(parsed.hasPointer && parsed.pointer.x == 0 && parsed.pointer.y == 1);
  assert(parsed.text.empty());
  assert(parsed.pads.size() == 1 && parsed.pads[0].first == 2);
  const studio::PadState& clamped = parsed.pads[0].second;
  assert(clamped.axes[0] == 1 && clamped.axes[1] == -1 && clamped.axes[2] == 0);
  assert(studio::parseInjection(json::Value(3)).down.empty());
  // A thousand distinct, valid names: the cap, not deduplication, is what stops them.
  std::string many = R"({"down":[)";
  for (int i = 0; i < 1000; ++i) {
    many += (i ? ",\"Key" : "\"Key");
    many += static_cast<char>('A' + i % 26);
    many += std::to_string(i) + "\"";
  }
  many += "]}";
  assert(studio::parseInjection(json::parse(many).value).down.size() == studio::MAX_INJECTED_KEYS);
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"canonical-keys", canonicalKeys},
    {"edges-first-tick", edgesFirstTick},
    {"tap", tap},
    {"real-edges", realEdges},
    {"lock-gates-look", lockGatesLook},
    {"look-echoes", lookEchoes},
    {"injected-pointer", injectedPointer},
    {"deltas", deltas},
    {"pads", pads},
    {"triggers", triggers},
    {"text", text},
    {"parse-injection", parseInjection},
    {"hostile-injection", hostileInjection},
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
