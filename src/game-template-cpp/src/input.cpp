// The input merge declared in input.h. raylib-free.
#include "input.h"

#include <algorithm>
#include <cmath>
#include <iterator>

namespace studio {

namespace {

using Keys = std::vector<std::string>;

/** `key` names with one meaning, and the DOM code each stands for. */
struct Alias {
  std::string_view name;
  std::string_view code;
};

constexpr Alias ALIASES[] = {
    {" ", "Space"},          {"Spacebar", "Space"},      {"Return", "Enter"},       {"Esc", "Escape"},
    {"Up", "ArrowUp"},       {"Down", "ArrowDown"},      {"Left", "ArrowLeft"},     {"Right", "ArrowRight"},
    {"Shift", "ShiftLeft"},  {"Control", "ControlLeft"}, {"Ctrl", "ControlLeft"},   {"Alt", "AltLeft"},
    {"Option", "AltLeft"},   {"Meta", "MetaLeft"},       {"Cmd", "MetaLeft"},       {"Command", "MetaLeft"},
    {"Del", "Delete"},       {",", "Comma"},             {".", "Period"},           {"/", "Slash"},
    {";", "Semicolon"},      {"'", "Quote"},             {"[", "BracketLeft"},      {"]", "BracketRight"},
    {"\\", "Backslash"},     {"-", "Minus"},             {"=", "Equal"},            {"`", "Backquote"},
};

/** The preview's mouse button names, in DOM order: left is Mouse1. */
constexpr std::string_view MOUSE_BUTTONS[][2] = {{"left", "Mouse1"}, {"right", "Mouse2"}, {"middle", "Mouse3"}};

bool isAsciiLetter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool isAsciiDigit(char c) { return c >= '0' && c <= '9'; }
bool isAlnum(char c) { return isAsciiLetter(c) || isAsciiDigit(c); }

/** Sort and deduplicate. */
Keys normalized(Keys keys) {
  std::sort(keys.begin(), keys.end());
  keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
  return keys;
}

Keys unionOf(const Keys& a, const Keys& b) {
  Keys out;
  std::set_union(a.begin(), a.end(), b.begin(), b.end(), std::back_inserter(out));
  return out;
}

Keys difference(const Keys& a, const Keys& b) {
  Keys out;
  std::set_difference(a.begin(), a.end(), b.begin(), b.end(), std::back_inserter(out));
  return out;
}

bool sortedContains(const Keys& keys, std::string_view name) {
  std::string key = canonicalKey(name);
  return !key.empty() && std::binary_search(keys.begin(), keys.end(), key);
}

void insertSorted(Keys& keys, const std::string& key) {
  auto at = std::lower_bound(keys.begin(), keys.end(), key);
  if (at == keys.end() || *at != key) keys.insert(at, key);
}

void eraseSorted(Keys& keys, const std::string& key) {
  auto at = std::lower_bound(keys.begin(), keys.end(), key);
  if (at != keys.end() && *at == key) keys.erase(at);
}

/** A finite number from `value`, or `fallback`. */
float finite(const json::Value& value, float fallback = 0) {
  double number = value.asNumber(fallback);
  return std::isfinite(number) ? static_cast<float>(number) : fallback;
}

float clamp(float value, float lo, float hi) { return std::min(std::max(value, lo), hi); }

/** `{x, y}` or `{dx, dy}` as a clamped delta. */
Vec2 delta(const json::Value& value) {
  float x = finite(value.find("dx") ? value["dx"] : value["x"]);
  float y = finite(value.find("dy") ? value["dy"] : value["y"]);
  return {clamp(x, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA), clamp(y, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA)};
}

void addDelta(Vec2& into, Vec2 more) {
  into.x = clamp(into.x + more.x, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA);
  into.y = clamp(into.y + more.y, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA);
}

/** Append the canonical, not yet listed keys of a JSON array of names, up to the cap. */
void addKeys(Keys& into, const json::Value& names) {
  for (const json::Value& name : names.items()) {
    if (into.size() >= MAX_INJECTED_KEYS) return;
    std::string key = canonicalKey(name.asString());
    if (!key.empty() && std::find(into.begin(), into.end(), key) == into.end()) into.push_back(key);
  }
}

void addKey(Keys& into, std::string_view name) {
  std::string key = canonicalKey(name);
  bool fits = !key.empty() && into.size() < MAX_INJECTED_KEYS;
  if (fits && std::find(into.begin(), into.end(), key) == into.end()) into.push_back(key);
}

std::string_view mouseButton(const json::Value& button) {
  std::string_view name = button.is(json::Kind::String) ? std::string_view(button.asString()) : "left";
  for (const auto& entry : MOUSE_BUTTONS) {
    if (entry[0] == name) return entry[1];
  }
  return MOUSE_BUTTONS[0][1];
}

/** A pad from `{index, buttons, axes, connected?}`, or index -1 when the index is not 0..3. */
std::pair<int, PadState> padFrom(const json::Value& value) {
  double index = value["index"].asNumber(-1);
  bool valid = std::isfinite(index) && index >= 0 && index < MAX_PADS && std::floor(index) == index;
  PadState pad;
  pad.connected = value["connected"].asBool(true);
  const json::Value::Array& buttons = value["buttons"].items();
  for (std::size_t i = 0; i < buttons.size() && i < pad.buttons.size(); ++i) {
    float pressedValue = buttons[i].is(json::Kind::Bool) ? (buttons[i].asBool() ? 1.0f : 0.0f) : finite(buttons[i]);
    pad.buttons[i] = clamp(pressedValue, 0, 1);
  }
  const json::Value::Array& axes = value["axes"].items();
  for (std::size_t i = 0; i < axes.size() && i < pad.axes.size(); ++i) pad.axes[i] = clamp(finite(axes[i]), -1, 1);
  return {valid ? static_cast<int>(index) : -1, pad};
}

void addPad(Injection& injection, const json::Value& value) {
  std::pair<int, PadState> pad = padFrom(value);
  if (pad.first < 0) return;
  for (auto& known : injection.pads) {
    if (known.first == pad.first) {
      known.second = pad.second;
      return;
    }
  }
  injection.pads.push_back(pad);
}

/** A pointer position given as fractions; pixel positions need a frame size this side does not know. */
void pointerFrom(Injection& injection, const json::Value& action) {
  if (action["px"].asBool()) {
    ++injection.ignored;
    return;
  }
  injection.hasPointer = true;
  injection.pointer = {clamp(finite(action["x"]), 0, 1), clamp(finite(action["y"]), 0, 1)};
}

/** "ctrl+s" as the keys it names. */
void addCombo(Keys& into, std::string_view combo) {
  while (!combo.empty()) {
    std::size_t plus = combo.find('+', 1);
    addKey(into, combo.substr(0, plus));
    if (plus == std::string_view::npos) return;
    combo.remove_prefix(plus + 1);
  }
}

bool actionWithPosition(Injection& injection, std::string_view type, const json::Value& action) {
  if (type == "move") {
    pointerFrom(injection, action);
    return true;
  }
  if (type == "click") {
    if (action.find("x") && action.find("y")) pointerFrom(injection, action);
    addKey(injection.tap, mouseButton(action["button"]));
    return true;
  }
  return false;
}

bool actionWithKeys(Injection& injection, std::string_view type, const json::Value& action) {
  if (type == "down") {
    addKeys(injection.down, action["keys"]);
  } else if (type == "up") {
    addKeys(injection.up, action["keys"]);
  } else if (type == "tap") {
    addKeys(injection.tap, action["keys"]);
  } else if (type == "press") {
    addCombo(injection.tap, action["combo"].asString());
  } else if (type == "mousedown") {
    addKey(injection.down, mouseButton(action["button"]));
  } else if (type == "mouseup") {
    addKey(injection.up, mouseButton(action["button"]));
  } else {
    return false;
  }
  return true;
}

void addAction(Injection& injection, const json::Value& action) {
  std::string_view type = action["type"].asString();
  if (actionWithKeys(injection, type, action) || actionWithPosition(injection, type, action)) return;
  if (type == "look") {
    addDelta(injection.look, delta(action));
  } else if (type == "scroll") {
    addDelta(injection.wheel, delta(action));
  } else if (type == "type" || type == "text") {
    appendText(injection.text, action["text"].asString());
  } else if (type == "gamepad") {
    addPad(injection, action);
  } else {
    ++injection.ignored;
  }
}

/** Real and injected pads as one: buttons at the larger value, axes at the larger magnitude. */
PadStates mergePads(const PadStates& real, const PadStates& injected) {
  PadStates merged{};
  for (int i = 0; i < MAX_PADS; ++i) {
    const PadState& a = real[static_cast<std::size_t>(i)];
    const PadState& b = injected[static_cast<std::size_t>(i)];
    PadState& out = merged[static_cast<std::size_t>(i)];
    out.connected = a.connected || b.connected;
    for (std::size_t k = 0; k < out.buttons.size(); ++k) out.buttons[k] = std::max(a.buttons[k], b.buttons[k]);
    for (std::size_t k = 0; k < out.axes.size(); ++k) {
      out.axes[k] = std::fabs(b.axes[k]) > std::fabs(a.axes[k]) ? b.axes[k] : a.axes[k];
    }
  }
  return merged;
}

/** The length of the UTF-8 sequence a lead byte starts, or 0 for a byte no sequence starts with. */
std::size_t sequenceLength(unsigned char lead) {
  if (lead < 0x80) return 1;
  if (lead >= 0xC2 && lead <= 0xDF) return 2;
  if (lead >= 0xE0 && lead <= 0xEF) return 3;
  if (lead >= 0xF0 && lead <= 0xF4) return 4;
  return 0;
}

/** The range a sequence's second byte must fall in: narrower after the leads that could start an overlong form, a surrogate or a code point past U+10FFFF. */
std::pair<unsigned char, unsigned char> secondByteRange(unsigned char lead) {
  switch (lead) {
    case 0xE0:
      return {0xA0, 0xBF};  // below is an overlong form of U+0000..U+07FF
    case 0xED:
      return {0x80, 0x9F};  // above is a UTF-16 surrogate, U+D800..U+DFFF
    case 0xF0:
      return {0x90, 0xBF};  // below is an overlong form of U+0000..U+FFFF
    case 0xF4:
      return {0x80, 0x8F};  // above is past U+10FFFF
    default:
      return {0x80, 0xBF};
  }
}

bool isContinuation(unsigned char byte) { return (byte & 0xC0) == 0x80; }

/** The length of the well-formed UTF-8 sequence `text` starts with, or 0 when it starts with none. */
std::size_t validSequence(std::string_view text) {
  auto lead = static_cast<unsigned char>(text[0]);
  std::size_t length = sequenceLength(lead);
  if (length == 1) return 1;
  if (length == 0 || text.size() < length) return 0;
  auto [low, high] = secondByteRange(lead);
  auto second = static_cast<unsigned char>(text[1]);
  if (second < low || second > high) return 0;
  for (std::size_t k = 2; k < length; ++k) {
    if (!isContinuation(static_cast<unsigned char>(text[k]))) return 0;
  }
  return length;
}

bool isZero(Vec2 delta) { return delta.x == 0 && delta.y == 0; }

/** Add a real delta, unless it is an echo of an injected one (`echoes` counts how many may still arrive). */
void addReal(Vec2& into, Vec2 real, int& echoes) {
  if (isZero(real)) return;
  if (echoes > 0) {
    --echoes;
    return;
  }
  addDelta(into, real);
}

/** UTF-16 units already in a valid UTF-8 string. */
std::size_t utf16Units(std::string_view text) {
  std::size_t units = 0;
  for (std::size_t i = 0; i < text.size();) {
    std::size_t length = std::max<std::size_t>(1, sequenceLength(static_cast<unsigned char>(text[i])));
    units += length == 4 ? 2 : 1;
    i += length;
  }
  return units;
}

}  // namespace

std::string canonicalKey(std::string_view name) {
  if (name.empty() || name.size() > MAX_KEY_NAME) return {};
  for (const Alias& alias : ALIASES) {
    if (alias.name == name) return std::string(alias.code);
  }
  if (name.size() == 1 && isAsciiLetter(name[0])) {
    return std::string("Key") + static_cast<char>(name[0] >= 'a' ? name[0] - 'a' + 'A' : name[0]);
  }
  if (name.size() == 1 && isAsciiDigit(name[0])) return std::string("Digit") + name[0];
  bool codeName = std::all_of(name.begin(), name.end(), isAlnum) && isAsciiLetter(name[0]);
  return codeName ? std::string(name) : std::string();
}

void appendText(std::string& into, std::string_view text) {
  std::size_t units = utf16Units(into);
  for (std::size_t i = 0; i < text.size();) {
    std::size_t length = validSequence(text.substr(i));
    if (length == 0) {
      ++i;  // a byte no valid sequence starts here: drop it and resynchronize on the next one
      continue;
    }
    std::size_t cost = length == 4 ? 2 : 1;
    if (units + cost > MAX_TEXT_UNITS) return;
    into.append(text.substr(i, length));
    units += cost;
    i += length;
  }
}

bool Input::down(std::string_view key) const { return sortedContains(held_, key); }
bool Input::pressed(std::string_view key) const { return sortedContains(pressed_, key); }
bool Input::released(std::string_view key) const { return sortedContains(released_, key); }

void Input::assign(std::vector<std::string> held, std::vector<std::string> pressed, std::vector<std::string> released) {
  held_ = normalized(std::move(held));
  pressed_ = normalized(std::move(pressed));
  released_ = normalized(std::move(released));
}

bool Pads::connected(int pad) const {
  return pad >= 0 && pad < MAX_PADS && now_[static_cast<std::size_t>(pad)].connected;
}

int Pads::count() const {
  return static_cast<int>(std::count_if(now_.begin(), now_.end(), [](const PadState& pad) { return pad.connected; }));
}

float Pads::value(int pad, int button) const {
  if (!connected(pad) || button < 0 || button >= PAD_BUTTONS) return 0;
  return now_[static_cast<std::size_t>(pad)].buttons[static_cast<std::size_t>(button)];
}

float Pads::axis(int pad, int axis) const {
  if (!connected(pad) || axis < 0 || axis >= PAD_AXES) return 0;
  return now_[static_cast<std::size_t>(pad)].axes[static_cast<std::size_t>(axis)];
}

bool Pads::down(int pad, int button) const { return value(pad, button) > PAD_PRESS_THRESHOLD; }

bool Pads::pressed(int pad, int button) const {
  if (!down(pad, button)) return false;
  const PadState& before = before_[static_cast<std::size_t>(pad)];
  return !before.connected || before.buttons[static_cast<std::size_t>(button)] <= PAD_PRESS_THRESHOLD;
}

bool Pads::released(int pad, int button) const {
  if (pad < 0 || pad >= MAX_PADS || button < 0 || button >= PAD_BUTTONS || down(pad, button)) return false;
  const PadState& before = before_[static_cast<std::size_t>(pad)];
  return before.connected && before.buttons[static_cast<std::size_t>(button)] > PAD_PRESS_THRESHOLD;
}

void Pads::assign(const PadStates& now, const PadStates& before) {
  now_ = now;
  before_ = before;
}

float triggerValue(bool buttonDown, int axisCount, int axis, float reading) {
  float digital = buttonDown ? 1.0f : 0.0f;
  bool analog = axis >= 0 && axis < axisCount && std::isfinite(reading);
  if (!analog) return digital;
  return std::max(digital, clamp((reading + 1.0f) / 2.0f, 0, 1));
}

Injection parseInjection(const json::Value& arg) {
  Injection injection;
  if (!arg.is(json::Kind::Object)) return injection;
  addKeys(injection.down, arg["down"]);
  addKeys(injection.up, arg["up"]);
  addKeys(injection.tap, arg["tap"]);
  if (arg.find("look")) addDelta(injection.look, delta(arg["look"]));
  if (arg.find("wheel")) addDelta(injection.wheel, delta(arg["wheel"]));
  if (arg["pointer"].is(json::Kind::Object)) pointerFrom(injection, arg["pointer"]);
  appendText(injection.text, arg["text"].asString());
  for (const json::Value& pad : arg["pads"].items()) addPad(injection, pad);
  for (const json::Value& action : arg["actions"].items()) addAction(injection, action);
  return injection;
}

void InputMerger::inject(const Injection& injection) {
  // An injection may be built in code as well as parsed, so its names are made canonical here too.
  Keys down;
  Keys up;
  Keys tap;
  for (const std::string& key : injection.down) addKey(down, key);
  for (const std::string& key : injection.up) addKey(up, key);
  for (const std::string& key : injection.tap) addKey(tap, key);
  for (const std::string& key : down) insertSorted(injectedHeld_, key);
  for (const std::string& key : up) {
    // Down and up in one injection is a tap: without this it would cancel out and fire nothing.
    if (std::find(down.begin(), down.end(), key) != down.end()) tap.push_back(key);
    eraseSorted(injectedHeld_, key);
  }
  for (const std::string& key : tap) {
    insertSorted(pendingPressed_, key);
    insertSorted(pendingReleased_, key);
  }
  addDelta(pendingLook_, injection.look);
  addDelta(pendingWheel_, injection.wheel);
  if (!isZero(injection.look)) lookEchoes_ = INJECTED_ECHOES;
  if (!isZero(injection.wheel)) wheelEchoes_ = INJECTED_ECHOES;
  if (injection.hasPointer) {
    injectedPointer_ = true;
    pointer_ = injection.pointer;
    pointerAtInjection_ = realPointer_;
  }
  for (const auto& pad : injection.pads) injectedPads_[static_cast<std::size_t>(pad.first)] = pad.second;
  appendText(pendingText_, injection.text);
}

void InputMerger::sample(const FrameSample& sample) {
  Keys held;
  for (const std::string& key : sample.held) addKey(held, key);
  realHeld_ = normalized(std::move(held));
  for (const std::string& key : sample.pressed) insertSorted(pendingPressed_, canonicalKey(key));
  for (const std::string& key : sample.released) insertSorted(pendingReleased_, canonicalKey(key));
  eraseSorted(pendingPressed_, "");
  eraseSorted(pendingReleased_, "");
  // Unlocked, the mouse is a cursor: its moves are the pointer's, never a camera's.
  if (sample.pointerLock) addReal(pendingLook_, sample.look, lookEchoes_);
  addReal(pendingWheel_, sample.wheel, wheelEchoes_);
  bool personMoved = sample.pointer.x != pointerAtInjection_.x || sample.pointer.y != pointerAtInjection_.y;
  if (personMoved) injectedPointer_ = false;
  realPointer_ = sample.pointer;
  pointerLock_ = sample.pointerLock;
  realPads_ = sample.pads;
  appendText(pendingText_, sample.text);
}

TickInput InputMerger::next() {
  Keys held = unionOf(realHeld_, injectedHeld_);
  Keys pressed = unionOf(difference(held, previousHeld_), pendingPressed_);
  Keys released = unionOf(difference(previousHeld_, held), pendingReleased_);
  TickInput tick;
  tick.keys.assign(held, std::move(pressed), std::move(released));
  tick.look = pendingLook_;
  tick.wheel = pendingWheel_;
  tick.pointer = injectedPointer_ ? pointer_ : realPointer_;
  tick.pointerLock = pointerLock_;
  PadStates pads = mergePads(realPads_, injectedPads_);
  tick.pads.assign(pads, previousPads_);
  tick.text = std::move(pendingText_);
  previousHeld_ = std::move(held);
  previousPads_ = pads;
  pendingPressed_.clear();
  pendingReleased_.clear();
  pendingLook_ = {};
  pendingWheel_ = {};
  pendingText_.clear();
  return tick;
}

std::vector<std::string> InputMerger::held() const { return unionOf(realHeld_, injectedHeld_); }

void InputMerger::clear() { *this = InputMerger(); }

}  // namespace studio
