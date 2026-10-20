//! The one input path, ported from the C++ template's `input.h`. Real input (sampled once per
//! rendered frame by the platform layer) and injected input (the studio's `input` verb) are merged
//! into one [`TickInput`] per simulation tick, and game code reads nothing else. Edges
//! (pressed/released), look, wheel and committed text apply on the first tick after they arrive,
//! so a k-tick step never presses a key k times. Keys are DOM `code` names ("KeyW", "Space",
//! "ArrowUp"), mouse buttons "Mouse1".."Mouse3", and gamepads the Gamepad API's standard mapping.

use crate::json::Value;
use crate::pad_family::{PadFamily, family_from_web_id};

/// Gamepads the runtime tracks.
pub const MAX_PADS: usize = 4;
/// Buttons per pad in the standard mapping.
pub const PAD_BUTTONS: usize = 17;
/// Axes per pad in the standard mapping.
pub const PAD_AXES: usize = 4;
/// A button counts as down above this value (triggers are analog).
pub const PAD_PRESS_THRESHOLD: f32 = 0.5;
/// Committed text one tick may carry, in UTF-16 units, as the host counts them.
pub const MAX_TEXT_UNITS: usize = 256;
/// Keys one injection may name in each list.
pub const MAX_INJECTED_KEYS: usize = 64;
/// The longest key name accepted.
pub const MAX_KEY_NAME: usize = 32;
/// The largest look or wheel delta one injection may carry, in pixels.
pub const MAX_INJECTED_DELTA: f32 = 100_000.0;
/// Real moves an injected look or wheel may still arrive as. The preview hands the page each beat
/// by up to three roads (the contract's `injectInput`, a synthetic DOM move, and in an attended
/// window the browser's own trusted one); the injection already counted it, so that many real
/// moves after it are the same beat again. Each injection restarts the count, so a stale one
/// swallows at most the moves of the beat after it.
pub const INJECTED_ECHOES: u32 = 2;

/// The most fingers down at once; a start past them is dropped.
pub const MAX_TOUCHES: usize = 10;
/// The most `touch` actions one injection takes; later ones count as ignored.
pub const MAX_TOUCH_ACTIONS: usize = 64;
/// The largest whole number a touch id takes (contract v2: a uint32).
const MAX_TOUCH_ID: f64 = 4_294_967_295.0;

/// `key` names with one meaning, and the DOM code each stands for.
const ALIASES: [(&str, &str); 28] = [
    (" ", "Space"),
    ("Spacebar", "Space"),
    ("Return", "Enter"),
    ("Esc", "Escape"),
    ("Up", "ArrowUp"),
    ("Down", "ArrowDown"),
    ("Left", "ArrowLeft"),
    ("Right", "ArrowRight"),
    ("Shift", "ShiftLeft"),
    ("Control", "ControlLeft"),
    ("Ctrl", "ControlLeft"),
    ("Alt", "AltLeft"),
    ("Option", "AltLeft"),
    ("Meta", "MetaLeft"),
    ("Cmd", "MetaLeft"),
    ("Command", "MetaLeft"),
    ("Del", "Delete"),
    (",", "Comma"),
    (".", "Period"),
    ("/", "Slash"),
    (";", "Semicolon"),
    ("'", "Quote"),
    ("[", "BracketLeft"),
    ("]", "BracketRight"),
    ("\\", "Backslash"),
    ("-", "Minus"),
    ("=", "Equal"),
    ("`", "Backquote"),
];

/// The preview's mouse button names, in DOM order: left is Mouse1.
const MOUSE_BUTTONS: [(&str, &str); 3] = [("left", "Mouse1"), ("right", "Mouse2"), ("middle", "Mouse3")];

/// A 2D vector of the input path (the facade turns it into its own math type).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    /// Right.
    pub x: f32,
    /// Down.
    pub y: f32,
}

impl Vec2 {
    /// The middle of the frame, where a pointer rests before anyone moves it.
    pub const CENTER: Vec2 = Vec2 { x: 0.5, y: 0.5 };

    fn is_zero(self) -> bool {
        self.x == 0.0 && self.y == 0.0
    }
}

/// Standard-mapping button indices (the Gamepad API's order).
#[derive(Clone, Copy, Debug)]
pub struct PadButton;

impl PadButton {
    /// Bottom face button.
    pub const A: i32 = 0;
    /// Right face button.
    pub const B: i32 = 1;
    /// Left face button.
    pub const X: i32 = 2;
    /// Top face button.
    pub const Y: i32 = 3;
    /// Left shoulder.
    pub const LEFT_BUMPER: i32 = 4;
    /// Right shoulder.
    pub const RIGHT_BUMPER: i32 = 5;
    /// Left trigger (analog).
    pub const LEFT_TRIGGER: i32 = 6;
    /// Right trigger (analog).
    pub const RIGHT_TRIGGER: i32 = 7;
    /// Back / select.
    pub const BACK: i32 = 8;
    /// Start.
    pub const START: i32 = 9;
    /// Left stick press.
    pub const LEFT_STICK: i32 = 10;
    /// Right stick press.
    pub const RIGHT_STICK: i32 = 11;
    /// D-pad up.
    pub const UP: i32 = 12;
    /// D-pad down.
    pub const DOWN: i32 = 13;
    /// D-pad left.
    pub const LEFT: i32 = 14;
    /// D-pad right.
    pub const RIGHT: i32 = 15;
    /// Home / guide.
    pub const HOME: i32 = 16;
}

/// Standard-mapping axis indices.
#[derive(Clone, Copy, Debug)]
pub struct PadAxis;

impl PadAxis {
    /// Left stick, x.
    pub const LEFT_X: i32 = 0;
    /// Left stick, y (down is positive).
    pub const LEFT_Y: i32 = 1;
    /// Right stick, x.
    pub const RIGHT_X: i32 = 2;
    /// Right stick, y (down is positive).
    pub const RIGHT_Y: i32 = 3;
}

/// One pad's full state: button values in [0, 1], axes in [-1, 1].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PadState {
    /// Whether a pad is in this slot.
    pub connected: bool,
    /// Button values by standard-mapping index.
    pub buttons: [f32; PAD_BUTTONS],
    /// Axis values by standard-mapping index.
    pub axes: [f32; PAD_AXES],
    /// The face-label family; display-only, never part of a reading.
    pub family: PadFamily,
}

/// Every pad slot.
pub type PadStates = [PadState; MAX_PADS];

fn is_alnum(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

/// The canonical name of a key: DOM `code` names stay as they are, a `key` name with one meaning
/// becomes its code ("w" is "KeyW", " " is "Space", "Up" is "ArrowUp"), and anything that is not
/// a plausible key name becomes "".
pub fn canonical_key(name: impl AsRef<[u8]>) -> String {
    let name = name.as_ref();
    if name.is_empty() || name.len() > MAX_KEY_NAME {
        return String::new();
    }
    if let Some((_, code)) = ALIASES.iter().find(|(alias, _)| alias.as_bytes() == name) {
        return (*code).to_owned();
    }
    let first = name[0];
    if name.len() == 1 && first.is_ascii_alphabetic() {
        return format!("Key{}", char::from(first.to_ascii_uppercase()));
    }
    if name.len() == 1 && first.is_ascii_digit() {
        return format!("Digit{}", char::from(first));
    }
    let code_name = name.iter().copied().all(is_alnum) && first.is_ascii_alphabetic();
    // All ASCII here, so the bytes are a string.
    if code_name { String::from_utf8_lossy(name).into_owned() } else { String::new() }
}

/// Sort and deduplicate.
fn normalized(mut keys: Vec<String>) -> Vec<String> {
    keys.sort();
    keys.dedup();
    keys
}

/// The sorted union of two sorted, deduplicated lists.
fn union_of(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = a.iter().chain(b).cloned().collect();
    out.sort();
    out.dedup();
    out
}

/// What is in sorted `a` and not in sorted `b`.
fn difference(a: &[String], b: &[String]) -> Vec<String> {
    a.iter().filter(|key| b.binary_search(key).is_err()).cloned().collect()
}

fn sorted_contains(keys: &[String], name: &[u8]) -> bool {
    let key = canonical_key(name);
    !key.is_empty() && keys.binary_search(&key).is_ok()
}

fn insert_sorted(keys: &mut Vec<String>, key: &str) {
    if let Err(at) = keys.binary_search_by(|probe| probe.as_str().cmp(key)) {
        keys.insert(at, key.to_owned());
    }
}

fn erase_sorted(keys: &mut Vec<String>, key: &str) {
    if let Ok(at) = keys.binary_search_by(|probe| probe.as_str().cmp(key)) {
        keys.remove(at);
    }
}

/// Keys this tick: held, and the edges that fired on it. Queries take either spelling of a key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Keys {
    held: Vec<String>,
    pressed: Vec<String>,
    released: Vec<String>,
}

impl Keys {
    /// Whether `key` is held.
    pub fn down(&self, key: impl AsRef<[u8]>) -> bool {
        sorted_contains(&self.held, key.as_ref())
    }

    /// Whether `key` went down on this tick.
    pub fn pressed(&self, key: impl AsRef<[u8]>) -> bool {
        sorted_contains(&self.pressed, key.as_ref())
    }

    /// Whether `key` came up on this tick.
    pub fn released(&self, key: impl AsRef<[u8]>) -> bool {
        sorted_contains(&self.released, key.as_ref())
    }

    /// Held keys, canonical and sorted.
    pub fn held(&self) -> &[String] {
        &self.held
    }

    /// Keys pressed on this tick, canonical and sorted.
    pub fn pressed_keys(&self) -> &[String] {
        &self.pressed
    }

    /// Keys released on this tick, canonical and sorted.
    pub fn released_keys(&self) -> &[String] {
        &self.released
    }

    /// Replace the state (canonical lists; the merger's job).
    pub fn assign(&mut self, held: Vec<String>, pressed: Vec<String>, released: Vec<String>) {
        self.held = normalized(held);
        self.pressed = normalized(pressed);
        self.released = normalized(released);
    }
}

/// Up to four pads this tick. Out-of-range indices answer "not connected", never read past the
/// table.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pads {
    now: PadStates,
    before: PadStates,
}

/// `index` as a slot of a table of `len`, when it is one.
fn slot(index: i32, len: usize) -> Option<usize> {
    usize::try_from(index).ok().filter(|&at| at < len)
}

impl Pads {
    /// Whether pad `pad` is connected.
    pub fn connected(&self, pad: i32) -> bool {
        slot(pad, MAX_PADS).is_some_and(|at| self.now[at].connected)
    }

    /// How many pads are connected.
    pub fn count(&self) -> u32 {
        self.now.iter().filter(|pad| pad.connected).count() as u32
    }

    /// Whether `button` is held on `pad`.
    pub fn down(&self, pad: i32, button: i32) -> bool {
        self.value(pad, button) > PAD_PRESS_THRESHOLD
    }

    /// Whether `button` went down on `pad` this tick.
    pub fn pressed(&self, pad: i32, button: i32) -> bool {
        if !self.down(pad, button) {
            return false;
        }
        // `down` held, so both indices are in range.
        let (Some(p), Some(b)) = (slot(pad, MAX_PADS), slot(button, PAD_BUTTONS)) else { return false };
        let before = &self.before[p];
        !before.connected || before.buttons[b] <= PAD_PRESS_THRESHOLD
    }

    /// Whether `button` came up on `pad` this tick.
    pub fn released(&self, pad: i32, button: i32) -> bool {
        let (Some(p), Some(b)) = (slot(pad, MAX_PADS), slot(button, PAD_BUTTONS)) else { return false };
        if self.down(pad, button) {
            return false;
        }
        let before = &self.before[p];
        before.connected && before.buttons[b] > PAD_PRESS_THRESHOLD
    }

    /// A button's analog value, 0 when absent.
    pub fn value(&self, pad: i32, button: i32) -> f32 {
        if !self.connected(pad) {
            return 0.0;
        }
        match (slot(pad, MAX_PADS), slot(button, PAD_BUTTONS)) {
            (Some(p), Some(b)) => self.now[p].buttons[b],
            _ => 0.0,
        }
    }

    /// An axis, 0 when absent.
    pub fn axis(&self, pad: i32, axis: i32) -> f32 {
        if !self.connected(pad) {
            return 0.0;
        }
        match (slot(pad, MAX_PADS), slot(axis, PAD_AXES)) {
            (Some(p), Some(a)) => self.now[p].axes[a],
            _ => 0.0,
        }
    }

    /// The face-label family of `pad`, Generic when it is not connected.
    pub fn family(&self, pad: i32) -> PadFamily {
        slot(pad, MAX_PADS).filter(|&at| self.now[at].connected).map_or(PadFamily::Generic, |at| self.now[at].family)
    }

    /// Every slot's state this tick.
    pub fn states(&self) -> &PadStates {
        &self.now
    }

    /// Replace the state; `before` is the previous tick's, for the edges.
    pub fn assign(&mut self, now: PadStates, before: PadStates) {
        self.now = now;
        self.before = before;
    }
}

/// Everything one tick's update reads besides the clock and the rng.
#[derive(Clone, Debug, PartialEq)]
pub struct TickInput {
    /// Keys held and their edges.
    pub keys: Keys,
    /// Mouse-look movement, in pixels (only while the pointer is locked).
    pub look: Vec2,
    /// Wheel movement.
    pub wheel: Vec2,
    /// Cursor position as a fraction of the frame, y down.
    pub pointer: Vec2,
    /// Whether the pointer is locked to the window.
    pub pointer_lock: bool,
    /// The gamepads.
    pub pads: Pads,
    /// Text committed since the last tick.
    pub text: String,
    /// The fingers down or lifted on this tick, by id.
    pub touches: Vec<TouchPoint>,
}

impl Default for TickInput {
    fn default() -> Self {
        TickInput {
            keys: Keys::default(),
            look: Vec2::default(),
            wheel: Vec2::default(),
            pointer: Vec2::CENTER,
            pointer_lock: false,
            pads: Pads::default(),
            text: String::new(),
            touches: Vec::new(),
        }
    }
}

/// One step of one finger in a `touch` action (contract v2's `TouchPhase`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchStep {
    /// The finger went down (`start`).
    Start,
    /// The finger moved (`move`).
    Move,
    /// The finger lifted (`end`).
    End,
}

impl TouchStep {
    /// The step for a wire phase name.
    pub fn from_wire(name: &[u8]) -> Option<TouchStep> {
        match name {
            b"start" => Some(TouchStep::Start),
            b"move" => Some(TouchStep::Move),
            b"end" => Some(TouchStep::End),
            _ => None,
        }
    }
}

/// A checked `touch` action: a uint32 id and a finite position in world pixels (y down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchAction {
    /// Ties a start to its moves and end.
    pub id: u32,
    /// What the finger did.
    pub step: TouchStep,
    /// World x.
    pub x: f32,
    /// World y.
    pub y: f32,
}

/// Where a finger is in its touch on one tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    /// It went down on this tick.
    Began,
    /// It is down.
    Held,
    /// It went up on this tick.
    Ended,
    /// It went down and up before this tick.
    Tapped,
}

/// One finger on one tick, in world pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchPoint {
    /// The finger's id.
    pub id: u32,
    /// World x.
    pub x: f32,
    /// World y.
    pub y: f32,
    /// Its phase on this tick.
    pub phase: TouchPhase,
}

/// What the studio's `input` verb asks for, already checked.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Injection {
    /// Keys to press and hold.
    pub down: Vec<String>,
    /// Keys to release.
    pub up: Vec<String>,
    /// Keys pressed and released before the next tick (a tap, a click).
    pub tap: Vec<String>,
    /// Mouse-look movement.
    pub look: Vec2,
    /// Wheel movement.
    pub wheel: Vec2,
    /// A pointer position, as fractions of the frame.
    pub pointer: Option<Vec2>,
    /// Full pad states by slot.
    pub pads: Vec<(usize, PadState)>,
    /// Committed text; code may build it from any bytes, the merger keeps only valid UTF-8.
    pub text: Vec<u8>,
    /// Fingers' steps, in order.
    pub touches: Vec<TouchAction>,
    /// Actions this runtime does not take itself (timed ones the host expands: hold, wait, drag).
    pub ignored: u32,
}

/// Real input, sampled once per rendered frame by the platform layer.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameSample {
    /// Keys held at the sample.
    pub held: Vec<String>,
    /// Keys pressed within the frame (a tap faster than a frame).
    pub pressed: Vec<String>,
    /// Keys released within the frame.
    pub released: Vec<String>,
    /// Raw mouse movement; it counts as look only while `pointer_lock` holds.
    pub look: Vec2,
    /// Wheel movement.
    pub wheel: Vec2,
    /// Cursor position as a fraction of the frame.
    pub pointer: Vec2,
    /// Whether the pointer is locked.
    pub pointer_lock: bool,
    /// The pads.
    pub pads: PadStates,
    /// Committed text bytes.
    pub text: Vec<u8>,
}

impl Default for FrameSample {
    fn default() -> Self {
        FrameSample {
            held: Vec::new(),
            pressed: Vec::new(),
            released: Vec::new(),
            look: Vec2::default(),
            wheel: Vec2::default(),
            pointer: Vec2::CENTER,
            pointer_lock: false,
            pads: PadStates::default(),
            text: Vec::new(),
        }
    }
}

fn clamp(value: f32, lo: f32, hi: f32) -> f32 {
    // std::min(std::max(value, lo), hi), which passes a NaN through as `lo`... never reached:
    // every caller hands a finite value.
    let raised = if value < lo { lo } else { value };
    if hi < raised { hi } else { raised }
}

/// A finite number from `value`, or `fallback`.
fn finite(value: &Value, fallback: f32) -> f32 {
    let number = value.as_f64_or(f64::from(fallback));
    if number.is_finite() { number as f32 } else { fallback }
}

/// `{x, y}` or `{dx, dy}` as a clamped delta.
fn delta(value: &Value) -> Vec2 {
    let x = finite(value.get("dx").unwrap_or(&value["x"]), 0.0);
    let y = finite(value.get("dy").unwrap_or(&value["y"]), 0.0);
    Vec2 {
        x: clamp(x, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA),
        y: clamp(y, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA),
    }
}

fn add_delta(into: &mut Vec2, more: Vec2) {
    into.x = clamp(into.x + more.x, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA);
    into.y = clamp(into.y + more.y, -MAX_INJECTED_DELTA, MAX_INJECTED_DELTA);
}

/// Append the canonical, not yet listed keys of a JSON array of names, up to the cap.
fn add_keys(into: &mut Vec<String>, names: &Value) {
    for name in names.items() {
        if into.len() >= MAX_INJECTED_KEYS {
            return;
        }
        let key = canonical_key(name.as_bytes());
        if !key.is_empty() && !into.contains(&key) {
            into.push(key);
        }
    }
}

fn add_key(into: &mut Vec<String>, name: impl AsRef<[u8]>) {
    let key = canonical_key(name);
    let fits = !key.is_empty() && into.len() < MAX_INJECTED_KEYS;
    if fits && !into.contains(&key) {
        into.push(key);
    }
}

fn mouse_button(button: &Value) -> &'static str {
    let name: &[u8] = match button {
        Value::String(bytes) => bytes,
        _ => b"left",
    };
    MOUSE_BUTTONS.iter().find(|(dom, _)| dom.as_bytes() == name).map_or(MOUSE_BUTTONS[0].1, |(_, key)| key)
}

/// A pad's family: a string `family` names it (an unknown one is Generic); without one, the web
/// shell's `id` (the browser's `Gamepad.id`) names it; anything else is Generic.
fn family_from(value: &Value) -> PadFamily {
    match (&value["family"], &value["id"]) {
        (Value::String(name), _) => std::str::from_utf8(name).ok().and_then(PadFamily::from_wire).unwrap_or_default(),
        (_, Value::String(id)) => std::str::from_utf8(id).map_or(PadFamily::Generic, family_from_web_id),
        _ => PadFamily::Generic,
    }
}

/// A pad from `{index, buttons, axes, connected?, family?, id?}`, or none when the index is not
/// 0..3; [`family_from`] reads its family.
fn pad_from(value: &Value) -> (Option<usize>, PadState) {
    let index = value["index"].as_f64_or(-1.0);
    let valid = index.is_finite() && index >= 0.0 && index < MAX_PADS as f64 && index.floor() == index;
    let family = family_from(value);
    let mut pad = PadState { connected: value["connected"].as_bool_or(true), family, ..PadState::default() };
    for (slot, button) in pad.buttons.iter_mut().zip(value["buttons"].items()) {
        let pressed = match button {
            Value::Bool(flag) => f32::from(u8::from(*flag)),
            other => finite(other, 0.0),
        };
        *slot = clamp(pressed, 0.0, 1.0);
    }
    for (slot, axis) in pad.axes.iter_mut().zip(value["axes"].items()) {
        *slot = clamp(finite(axis, 0.0), -1.0, 1.0);
    }
    (valid.then_some(index as usize), pad)
}

fn add_pad(injection: &mut Injection, value: &Value) {
    let (Some(index), pad) = pad_from(value) else { return };
    match injection.pads.iter_mut().find(|(known, _)| *known == index) {
        Some(known) => known.1 = pad,
        None => injection.pads.push((index, pad)),
    }
}

/// A pointer position given as fractions; pixel positions need a frame size this side does not
/// know.
fn pointer_from(injection: &mut Injection, action: &Value) {
    if action["px"].as_bool() {
        injection.ignored += 1;
        return;
    }
    injection.pointer =
        Some(Vec2 { x: clamp(finite(&action["x"], 0.0), 0.0, 1.0), y: clamp(finite(&action["y"], 0.0), 0.0, 1.0) });
}

/// "ctrl+s" as the keys it names (a leading `+` is a key, not a separator).
fn add_combo(into: &mut Vec<String>, combo: &[u8]) {
    let mut rest = combo;
    while !rest.is_empty() {
        let plus = rest.iter().skip(1).position(|&byte| byte == b'+').map(|at| at + 1);
        let Some(plus) = plus else {
            add_key(into, rest);
            return;
        };
        add_key(into, &rest[..plus]);
        rest = &rest[plus + 1..];
    }
}

fn action_with_position(injection: &mut Injection, kind: &[u8], action: &Value) -> bool {
    match kind {
        b"move" => pointer_from(injection, action),
        b"click" => {
            if action.get("x").is_some() && action.get("y").is_some() {
                pointer_from(injection, action);
            }
            add_key(&mut injection.tap, mouse_button(&action["button"]));
        }
        _ => return false,
    }
    true
}

fn action_with_keys(injection: &mut Injection, kind: &[u8], action: &Value) -> bool {
    match kind {
        b"down" => add_keys(&mut injection.down, &action["keys"]),
        b"up" => add_keys(&mut injection.up, &action["keys"]),
        b"tap" => add_keys(&mut injection.tap, &action["keys"]),
        b"press" => add_combo(&mut injection.tap, action["combo"].as_bytes()),
        b"mousedown" => add_key(&mut injection.down, mouse_button(&action["button"])),
        b"mouseup" => add_key(&mut injection.up, mouse_button(&action["button"])),
        _ => return false,
    }
    true
}

fn add_action(injection: &mut Injection, action: &Value) {
    let kind = action["type"].as_bytes();
    if action_with_keys(injection, kind, action) || action_with_position(injection, kind, action) {
        return;
    }
    match kind {
        b"look" => add_delta(&mut injection.look, delta(action)),
        b"scroll" => add_delta(&mut injection.wheel, delta(action)),
        b"type" | b"text" => append_text_bytes(&mut injection.text, action["text"].as_bytes()),
        b"gamepad" => add_pad(injection, action),
        b"touch" => add_touch(injection, action),
        _ => injection.ignored += 1,
    }
}

/// A finite JSON number, or None.
fn finite_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) if number.is_finite() => Some(*number),
        _ => None,
    }
}

/// A `touch` action as the host's `parseNativeInput` accepts it, or None: a known phase, a whole
/// id in 0..=u32::MAX and finite world coordinates.
fn touch_from(action: &Value) -> Option<TouchAction> {
    let step = match &action["phase"] {
        Value::String(name) => TouchStep::from_wire(name)?,
        _ => return None,
    };
    let id = finite_number(&action["id"]).filter(|id| id.fract() == 0.0 && (0.0..=MAX_TOUCH_ID).contains(id))?;
    let x = finite_number(&action["x"])?;
    let y = finite_number(&action["y"])?;
    let bound = f64::from(MAX_INJECTED_DELTA);
    // Whole and in u32 range; coordinates clamped into f32's comfortable range.
    Some(TouchAction { id: id as u32, step, x: x.clamp(-bound, bound) as f32, y: y.clamp(-bound, bound) as f32 })
}

fn add_touch(injection: &mut Injection, action: &Value) {
    match touch_from(action) {
        Some(touch) if injection.touches.len() < MAX_TOUCH_ACTIONS => injection.touches.push(touch),
        _ => injection.ignored += 1,
    }
}

/// The family of a merged slot: a connected injected pad's named family, else the connected real
/// pad's, so an injection without a family never hides the pad on the desk.
fn merged_family(real: &PadState, injected: &PadState) -> PadFamily {
    if injected.connected && injected.family != PadFamily::Generic {
        return injected.family;
    }
    if real.connected { real.family } else { PadFamily::Generic }
}

/// Real and injected pads as one: buttons at the larger value, axes at the larger magnitude.
fn merge_pads(real: &PadStates, injected: &PadStates) -> PadStates {
    let mut merged = PadStates::default();
    for ((out, a), b) in merged.iter_mut().zip(real).zip(injected) {
        out.connected = a.connected || b.connected;
        out.family = merged_family(a, b);
        for ((button, x), y) in out.buttons.iter_mut().zip(&a.buttons).zip(&b.buttons) {
            // std::max(a, b): `a < b ? b : a`.
            *button = if x < y { *y } else { *x };
        }
        for ((axis, x), y) in out.axes.iter_mut().zip(&a.axes).zip(&b.axes) {
            *axis = if y.abs() > x.abs() { *y } else { *x };
        }
    }
    merged
}

/// The length of the UTF-8 sequence a lead byte starts, or 0 for a byte no sequence starts with.
fn sequence_length(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 0,
    }
}

/// The range a sequence's second byte must fall in: narrower after the leads that could start an
/// overlong form, a surrogate or a code point past U+10FFFF.
fn second_byte_range(lead: u8) -> (u8, u8) {
    match lead {
        0xE0 => (0xA0, 0xBF), // below is an overlong form of U+0000..U+07FF
        0xED => (0x80, 0x9F), // above is a UTF-16 surrogate, U+D800..U+DFFF
        0xF0 => (0x90, 0xBF), // below is an overlong form of U+0000..U+FFFF
        0xF4 => (0x80, 0x8F), // above is past U+10FFFF
        _ => (0x80, 0xBF),
    }
}

fn is_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

/// The length of the well-formed UTF-8 sequence `text` starts with, or 0 when it starts with none.
fn valid_sequence(text: &[u8]) -> usize {
    let lead = text[0];
    let length = sequence_length(lead);
    if length == 1 {
        return 1;
    }
    if length == 0 || text.len() < length {
        return 0;
    }
    let (low, high) = second_byte_range(lead);
    if !(low..=high).contains(&text[1]) {
        return 0;
    }
    if !text[2..length].iter().copied().all(is_continuation) {
        return 0;
    }
    length
}

/// UTF-16 units already in a string.
fn utf16_units(text: &[u8]) -> usize {
    let mut units = 0;
    let mut i = 0;
    while i < text.len() {
        let length = sequence_length(text[i]).max(1);
        units += if length == 4 { 2 } else { 1 };
        i += length;
    }
    units
}

/// Append the well-formed sequences of `text` to `into`, stopping whole at [`MAX_TEXT_UNITS`].
fn append_text_bytes(into: &mut Vec<u8>, text: &[u8]) {
    let mut units = utf16_units(into);
    let mut i = 0;
    while i < text.len() {
        let length = valid_sequence(&text[i..]);
        if length == 0 {
            i += 1; // a byte no valid sequence starts here: drop it and resynchronize on the next one
            continue;
        }
        let cost = if length == 4 { 2 } else { 1 };
        if units + cost > MAX_TEXT_UNITS {
            return;
        }
        into.extend_from_slice(&text[i..i + length]);
        units += cost;
        i += length;
    }
}

/// Append `text` to `into`, dropping invalid UTF-8 and stopping whole at [`MAX_TEXT_UNITS`]
/// UTF-16 units.
pub fn append_text(into: &mut String, text: &[u8]) {
    let mut bytes = std::mem::take(into).into_bytes();
    append_text_bytes(&mut bytes, text);
    // Only well-formed sequences were appended to a string that was valid.
    *into = String::from_utf8(bytes).unwrap_or_default();
}

/// A trigger's value in [0, 1]: the platform's analog reading of axis `axis` (-1 released, 1
/// pulled) when the pad has that axis, and never below the digital button. A browser's
/// standard-mapping pad has four axes, so its trigger axes read 0, which is not half pulled: there
/// the button is the trigger.
pub fn trigger_value(button_down: bool, axis_count: i32, axis: i32, reading: f32) -> f32 {
    let digital = if button_down { 1.0 } else { 0.0 };
    let analog = axis >= 0 && axis < axis_count && reading.is_finite();
    if !analog {
        return digital;
    }
    let pulled = clamp((reading + 1.0) / 2.0, 0.0, 1.0);
    if digital < pulled { pulled } else { digital }
}

/// Read an `input` argument: `{down, up, tap, look, wheel, pointer, text, pads}` and/or
/// `{actions: [...]}` in the preview's action shape. Hostile values are dropped or clamped:
/// non-strings, unknown key names, NaN, pads outside 0..3, extra buttons and axes.
pub fn parse_injection(arg: &Value) -> Injection {
    let mut injection = Injection::default();
    if !matches!(arg, Value::Object(_)) {
        return injection;
    }
    add_keys(&mut injection.down, &arg["down"]);
    add_keys(&mut injection.up, &arg["up"]);
    add_keys(&mut injection.tap, &arg["tap"]);
    if let Some(look) = arg.get("look") {
        add_delta(&mut injection.look, delta(look));
    }
    if let Some(wheel) = arg.get("wheel") {
        add_delta(&mut injection.wheel, delta(wheel));
    }
    if matches!(arg["pointer"], Value::Object(_)) {
        pointer_from(&mut injection, &arg["pointer"]);
    }
    append_text_bytes(&mut injection.text, arg["text"].as_bytes());
    for pad in arg["pads"].items() {
        add_pad(&mut injection, pad);
    }
    for action in arg["actions"].items() {
        add_action(&mut injection, action);
    }
    injection
}

/// Merges real and injected input into one [`TickInput`] per tick.
#[derive(Clone, Debug, PartialEq)]
pub struct InputMerger {
    injected_held: Vec<String>,
    real_held: Vec<String>,
    previous_held: Vec<String>,
    pending_pressed: Vec<String>,
    pending_released: Vec<String>,
    pending_look: Vec2,
    pending_wheel: Vec2,
    look_echoes: u32,
    wheel_echoes: u32,
    injected_pointer: bool,
    pointer: Vec2,
    /// Where the real mouse was when the pointer was injected: moving it from there takes the
    /// pointer back.
    pointer_at_injection: Vec2,
    real_pointer: Vec2,
    pointer_lock: bool,
    injected_pads: PadStates,
    real_pads: PadStates,
    previous_pads: PadStates,
    pending_text: Vec<u8>,
    /// Fingers down, by id, with their last position.
    fingers: Vec<(u32, f32, f32)>,
    /// Fingers that went down since the last tick.
    began: Vec<u32>,
    /// Fingers that lifted since the last tick, with where.
    lifted: Vec<(u32, f32, f32)>,
}

impl Default for InputMerger {
    fn default() -> Self {
        InputMerger {
            injected_held: Vec::new(),
            real_held: Vec::new(),
            previous_held: Vec::new(),
            pending_pressed: Vec::new(),
            pending_released: Vec::new(),
            pending_look: Vec2::default(),
            pending_wheel: Vec2::default(),
            look_echoes: 0,
            wheel_echoes: 0,
            injected_pointer: false,
            pointer: Vec2::CENTER,
            pointer_at_injection: Vec2::CENTER,
            real_pointer: Vec2::CENTER,
            pointer_lock: false,
            injected_pads: PadStates::default(),
            real_pads: PadStates::default(),
            previous_pads: PadStates::default(),
            pending_text: Vec::new(),
            fingers: Vec::new(),
            began: Vec::new(),
            lifted: Vec::new(),
        }
    }
}

/// Add a real delta, unless it is an echo of an injected one (`echoes` counts how many may still
/// arrive).
fn add_real(into: &mut Vec2, real: Vec2, echoes: &mut u32) {
    if real.is_zero() {
        return;
    }
    if *echoes > 0 {
        *echoes -= 1;
        return;
    }
    add_delta(into, real);
}

impl InputMerger {
    /// Held changes apply now; edges, deltas and text wait for the next tick. An injected pointer
    /// stands until the real mouse moves.
    pub fn inject(&mut self, injection: &Injection) {
        // An injection may be built in code as well as parsed, so its names are made canonical here too.
        let (mut down, mut up, mut tap) = (Vec::new(), Vec::new(), Vec::new());
        injection.down.iter().for_each(|key| add_key(&mut down, key));
        injection.up.iter().for_each(|key| add_key(&mut up, key));
        injection.tap.iter().for_each(|key| add_key(&mut tap, key));
        for key in &down {
            insert_sorted(&mut self.injected_held, key);
        }
        for key in &up {
            // Down and up in one injection is a tap: without this it would cancel out and fire nothing.
            if down.contains(key) {
                tap.push(key.clone());
            }
            erase_sorted(&mut self.injected_held, key);
        }
        for key in &tap {
            insert_sorted(&mut self.pending_pressed, key);
            insert_sorted(&mut self.pending_released, key);
        }
        add_delta(&mut self.pending_look, injection.look);
        add_delta(&mut self.pending_wheel, injection.wheel);
        if !injection.look.is_zero() {
            self.look_echoes = INJECTED_ECHOES;
        }
        if !injection.wheel.is_zero() {
            self.wheel_echoes = INJECTED_ECHOES;
        }
        if let Some(pointer) = injection.pointer {
            self.injected_pointer = true;
            self.pointer = pointer;
            self.pointer_at_injection = self.real_pointer;
        }
        for (index, pad) in &injection.pads {
            if let Some(slot) = self.injected_pads.get_mut(*index) {
                *slot = *pad;
            }
        }
        append_text_bytes(&mut self.pending_text, &injection.text);
        for touch in &injection.touches {
            self.touch(touch);
        }
    }

    /// One finger's step: a start past [`MAX_TOUCHES`], or a move or end for a finger that is not
    /// down, changes nothing.
    fn touch(&mut self, touch: &TouchAction) {
        let known = self.fingers.iter().position(|(id, _, _)| *id == touch.id);
        match (touch.step, known) {
            (TouchStep::Start, None) if self.fingers.len() < MAX_TOUCHES => {
                let at = self.fingers.partition_point(|(id, _, _)| *id < touch.id);
                self.fingers.insert(at, (touch.id, touch.x, touch.y));
                self.began.push(touch.id);
            }
            (TouchStep::Start | TouchStep::Move, Some(at)) => self.fingers[at] = (touch.id, touch.x, touch.y),
            (TouchStep::End, Some(at)) => {
                self.fingers.remove(at);
                self.lifted.push((touch.id, touch.x, touch.y));
            }
            _ => {}
        }
    }

    /// The fingers of the next tick, by id; consumes the starts and ends.
    fn next_touches(&mut self) -> Vec<TouchPoint> {
        let began = std::mem::take(&mut self.began);
        let lifted = std::mem::take(&mut self.lifted);
        let phase = |id: u32, began_phase: TouchPhase, otherwise: TouchPhase| {
            if began.contains(&id) { began_phase } else { otherwise }
        };
        let mut points: Vec<TouchPoint> = self
            .fingers
            .iter()
            .map(|&(id, x, y)| TouchPoint { id, x, y, phase: phase(id, TouchPhase::Began, TouchPhase::Held) })
            .collect();
        for (id, x, y) in lifted {
            points.push(TouchPoint { id, x, y, phase: phase(id, TouchPhase::Tapped, TouchPhase::Ended) });
        }
        points.sort_by_key(|point| point.id);
        points
    }

    /// The real state for the ticks of the frame about to run; look only while the pointer is
    /// locked, echoes of an injection left out.
    pub fn sample(&mut self, sample: &FrameSample) {
        let mut held = Vec::new();
        sample.held.iter().for_each(|key| add_key(&mut held, key));
        self.real_held = normalized(held);
        for key in &sample.pressed {
            insert_sorted(&mut self.pending_pressed, &canonical_key(key));
        }
        for key in &sample.released {
            insert_sorted(&mut self.pending_released, &canonical_key(key));
        }
        erase_sorted(&mut self.pending_pressed, "");
        erase_sorted(&mut self.pending_released, "");
        // Unlocked, the mouse is a cursor: its moves are the pointer's, never a camera's.
        if sample.pointer_lock {
            add_real(&mut self.pending_look, sample.look, &mut self.look_echoes);
        }
        add_real(&mut self.pending_wheel, sample.wheel, &mut self.wheel_echoes);
        let person_moved = sample.pointer != self.pointer_at_injection;
        if person_moved {
            self.injected_pointer = false;
        }
        self.real_pointer = sample.pointer;
        self.pointer_lock = sample.pointer_lock;
        self.real_pads = sample.pads;
        append_text_bytes(&mut self.pending_text, &sample.text);
    }

    /// The next tick's input; consumes the pending edges, deltas and text.
    pub fn next_tick(&mut self) -> TickInput {
        let held = union_of(&self.real_held, &self.injected_held);
        let pressed = union_of(&difference(&held, &self.previous_held), &self.pending_pressed);
        let released = union_of(&difference(&self.previous_held, &held), &self.pending_released);
        let mut tick = TickInput::default();
        tick.keys.assign(held.clone(), pressed, released);
        tick.look = self.pending_look;
        tick.wheel = self.pending_wheel;
        tick.pointer = if self.injected_pointer { self.pointer } else { self.real_pointer };
        tick.pointer_lock = self.pointer_lock;
        let pads = merge_pads(&self.real_pads, &self.injected_pads);
        tick.pads.assign(pads, self.previous_pads);
        // Only well-formed sequences ever reach the pending text.
        tick.text = String::from_utf8(std::mem::take(&mut self.pending_text)).unwrap_or_default();
        tick.touches = self.next_touches();
        self.previous_held = held;
        self.previous_pads = pads;
        self.pending_pressed.clear();
        self.pending_released.clear();
        self.pending_look = Vec2::default();
        self.pending_wheel = Vec2::default();
        tick
    }

    /// Real and injected held keys, canonical and sorted.
    pub fn held(&self) -> Vec<String> {
        union_of(&self.real_held, &self.injected_held)
    }

    /// Forget everything held or pending (seed does).
    pub fn clear(&mut self) {
        *self = InputMerger::default();
    }
}
