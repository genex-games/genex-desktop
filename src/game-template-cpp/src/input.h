// The one input path. Real input (raylib, sampled once per rendered frame by platform.cpp) and
// injected input (the studio's `input` op) are merged into one TickInput per simulation tick, and
// game code reads nothing else. Edges (pressed/released), look, wheel and committed text are
// applied on the first tick after they arrive, so a k-tick step never presses a key k times.
// Keys are DOM `code` names ("KeyW", "Space", "ArrowUp"), mouse buttons "Mouse1".."Mouse3", and
// gamepads the Gamepad API's standard mapping. raylib-free.
#pragma once

#include <array>
#include <cstddef>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "json.h"

namespace studio {

/** Gamepads the runtime tracks. */
inline constexpr int MAX_PADS = 4;
/** Buttons per pad in the standard mapping. */
inline constexpr int PAD_BUTTONS = 17;
/** Axes per pad in the standard mapping. */
inline constexpr int PAD_AXES = 4;
/** A button counts as down above this value (triggers are analog). */
inline constexpr float PAD_PRESS_THRESHOLD = 0.5f;
/** Committed text one tick may carry, in UTF-16 units, as the host counts them. */
inline constexpr std::size_t MAX_TEXT_UNITS = 256;
/** Keys one injection may name in each list. */
inline constexpr std::size_t MAX_INJECTED_KEYS = 64;
/** The longest key name accepted. */
inline constexpr std::size_t MAX_KEY_NAME = 32;
/** The largest look or wheel delta one injection may carry, in pixels. */
inline constexpr float MAX_INJECTED_DELTA = 100000.0f;
/**
 * Real moves an injected look or wheel may still arrive as. The preview hands the page each beat by
 * up to three roads (the contract's `injectInput`, a synthetic DOM move, and in an attended window
 * the browser's own trusted one); the injection already counted it, so that many real moves after
 * it are the same beat again. Each injection restarts the count, so a stale one swallows at most
 * the moves of the beat after it (the web template's studio.js counts the same way).
 */
inline constexpr int INJECTED_ECHOES = 2;

/** A raylib-free 2D vector (studio.cpp turns it into raylib's Vector2 for ctx). */
struct Vec2 {
  float x = 0;
  float y = 0;
};

/** Standard-mapping button indices (the Gamepad API's order). */
namespace PadButton {
inline constexpr int A = 0;
inline constexpr int B = 1;
inline constexpr int X = 2;
inline constexpr int Y = 3;
inline constexpr int LeftBumper = 4;
inline constexpr int RightBumper = 5;
inline constexpr int LeftTrigger = 6;
inline constexpr int RightTrigger = 7;
inline constexpr int Back = 8;
inline constexpr int Start = 9;
inline constexpr int LeftStick = 10;
inline constexpr int RightStick = 11;
inline constexpr int Up = 12;
inline constexpr int Down = 13;
inline constexpr int Left = 14;
inline constexpr int Right = 15;
inline constexpr int Home = 16;
}  // namespace PadButton

/** Standard-mapping axis indices. */
namespace PadAxis {
inline constexpr int LeftX = 0;
inline constexpr int LeftY = 1;
inline constexpr int RightX = 2;
inline constexpr int RightY = 3;
}  // namespace PadAxis

/** One pad's full state: button values in [0, 1], axes in [-1, 1]. */
struct PadState {
  bool connected = false;
  std::array<float, PAD_BUTTONS> buttons{};
  std::array<float, PAD_AXES> axes{};
};
using PadStates = std::array<PadState, MAX_PADS>;

/**
 * The canonical name of a key: DOM `code` names stay as they are, a `key` name with one meaning
 * becomes its code ("w" is "KeyW", " " is "Space", "Up" is "ArrowUp"), and anything that is not a
 * plausible key name becomes "".
 */
std::string canonicalKey(std::string_view name);

/** Keys this tick: held, and the edges that fired on it. Queries take either spelling of a key. */
class Input {
 public:
  bool down(std::string_view key) const;
  bool pressed(std::string_view key) const;
  bool released(std::string_view key) const;
  /** Held keys, canonical and sorted. */
  const std::vector<std::string>& held() const { return held_; }
  /** Replace the state (canonical, sorted lists; the merger's job). */
  void assign(std::vector<std::string> held, std::vector<std::string> pressed, std::vector<std::string> released);

 private:
  std::vector<std::string> held_;
  std::vector<std::string> pressed_;
  std::vector<std::string> released_;
};

/** Up to four pads this tick. Out-of-range indices answer "not connected", never read past the table. */
class Pads {
 public:
  bool connected(int pad) const;
  /** How many pads are connected. */
  int count() const;
  bool down(int pad, int button) const;
  bool pressed(int pad, int button) const;
  bool released(int pad, int button) const;
  /** A button's analog value, 0 when absent. */
  float value(int pad, int button) const;
  /** An axis, 0 when absent. */
  float axis(int pad, int axis) const;
  const PadStates& states() const { return now_; }
  /** Replace the state; `before` is the previous tick's, for the edges. */
  void assign(const PadStates& now, const PadStates& before);

 private:
  PadStates now_{};
  PadStates before_{};
};

/** Everything one tick's update() reads besides the clock and the rng. */
struct TickInput {
  Input keys;
  Vec2 look;
  Vec2 wheel;
  /** Cursor position as a fraction of the frame, y down. */
  Vec2 pointer{0.5f, 0.5f};
  bool pointerLock = false;
  Pads pads;
  /** Text committed since the last tick (UTF-8). */
  std::string text;
};

/** What the studio's `input` op asks for, already checked. */
struct Injection {
  std::vector<std::string> down;
  std::vector<std::string> up;
  /** Pressed and released before the next tick (a tap, a click). */
  std::vector<std::string> tap;
  Vec2 look;
  Vec2 wheel;
  bool hasPointer = false;
  Vec2 pointer;
  /** Full pad states by index. */
  std::vector<std::pair<int, PadState>> pads;
  std::string text;
  /** Actions this runtime does not take itself (timed ones the host expands: hold, wait, drag). */
  int ignored = 0;
};

/** Real input, sampled from raylib once per rendered frame by the platform layer. */
struct FrameSample {
  std::vector<std::string> held;
  /** Keys pressed and released within the frame (a tap faster than a frame). */
  std::vector<std::string> pressed;
  std::vector<std::string> released;
  /** raylib's mouse delta; it counts as look only while `pointerLock` holds. */
  Vec2 look;
  Vec2 wheel;
  Vec2 pointer{0.5f, 0.5f};
  bool pointerLock = false;
  PadStates pads{};
  std::string text;
};

/**
 * A trigger's value in [0, 1]: raylib's analog reading of axis `axis` (-1 released, 1 pulled)
 * when the pad has that axis, and never below the digital button. A browser's standard-mapping
 * pad has four axes, so raylib never writes its trigger axes and they read 0, which is not half
 * pulled: there the button is the trigger.
 */
float triggerValue(bool buttonDown, int axisCount, int axis, float reading);

/**
 * Read an `input` argument: `{down, up, tap, look, wheel, pointer, text, pads}` and/or
 * `{actions: [...]}` in the preview's action shape. Hostile values are dropped or clamped:
 * non-strings, unknown key names, NaN, pads outside 0..3, extra buttons and axes.
 */
Injection parseInjection(const json::Value& arg);

/** Append `text` to `into`, dropping invalid UTF-8 and stopping whole at MAX_TEXT_UNITS UTF-16 units. */
void appendText(std::string& into, std::string_view text);

/** Merges real and injected input into one TickInput per tick. */
class InputMerger {
 public:
  /** Held changes apply now; edges, deltas and text wait for the next tick. An injected pointer stands until the real mouse moves. */
  void inject(const Injection& injection);
  /** The real state for the ticks of the frame about to run; look only while the pointer is locked, echoes of an injection left out. */
  void sample(const FrameSample& sample);
  /** The next tick's input; consumes the pending edges, deltas and text. */
  TickInput next();
  /** Real and injected held keys, canonical and sorted. */
  std::vector<std::string> held() const;
  /** Forget everything held or pending (seed does). */
  void clear();

 private:
  std::vector<std::string> injectedHeld_;
  std::vector<std::string> realHeld_;
  std::vector<std::string> previousHeld_;
  std::vector<std::string> pendingPressed_;
  std::vector<std::string> pendingReleased_;
  Vec2 pendingLook_;
  Vec2 pendingWheel_;
  int lookEchoes_ = 0;
  int wheelEchoes_ = 0;
  bool injectedPointer_ = false;
  Vec2 pointer_{0.5f, 0.5f};
  /** Where the real mouse was when the pointer was injected: moving it from there takes the pointer back. */
  Vec2 pointerAtInjection_{0.5f, 0.5f};
  Vec2 realPointer_{0.5f, 0.5f};
  bool pointerLock_ = false;
  PadStates injectedPads_{};
  PadStates realPads_{};
  PadStates previousPads_{};
  std::string pendingText_;
};

}  // namespace studio
