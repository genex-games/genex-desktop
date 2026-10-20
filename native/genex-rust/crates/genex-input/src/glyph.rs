//! Prompt glyphs: what a binding looks like on screen ("Space", "Cross", "WASD", "LMB"), so
//! a prompt reads "Press Cross to jump" on a PlayStation pad and "Press Space" on a keyboard. A
//! glyph is a text label plus a shape (a key cap, a face button, a stick); it is display only and
//! never feeds back into evaluation, the bindings digest or a checksum.
//!
//! Keys are labelled from their DOM `code` (`KeyW` reads "W"). A keyboard layout map from the
//! shell ([`KeyLabels`]: the browser's `navigator.keyboard.getLayoutMap()` or winit's logical key)
//! overrides the label only, so on AZERTY `KeyW` reads "Z" while the binding, the tick input and
//! the action state stay exactly the same.
//!
//! Pad face labels follow the pad family (genex-core's `PadFamily`, filled per platform). The face
//! button table is ported from SDL3's `SDL_GetGamepadButtonLabelForFaceStyle` and
//! `SDL_GetGamepadFaceStyleForGamepadType` in `src/joystick/SDL_gamepad.c`
//! (<https://github.com/libsdl-org/SDL>, commit b9d64c45a965edc4b003c160ab446426363e192d,
//! Copyright (C) 1997-2026 Sam Lantinga, zlib licence). This is an altered version: SDL's face
//! styles are folded into genex's families (Sony shapes for PlayStation, BAYX for Nintendo, ABXY
//! for Xbox and Steam), the GameCube style is left out (no family), an unknown pad reads position
//! names (South, East) instead of SDL's ABXY default, and the label enum became text. Shoulder,
//! trigger, menu and stick-press labels are genex's own (SDL has no label for them).
//!
//! The zlib notice, as the licence requires:
//!
//! > This software is provided 'as-is', without any express or implied warranty. In no event will
//! > the authors be held liable for any damages arising from the use of this software.
//! >
//! > Permission is granted to anyone to use this software for any purpose, including commercial
//! > applications, and to alter it and redistribute it freely, subject to the following
//! > restrictions:
//! >
//! > 1. The origin of this software must not be misrepresented; you must not claim that you wrote
//! >    the original software. If you use this software in a product, an acknowledgment in the
//! >    product documentation would be appreciated but is not required.
//! > 2. Altered source versions must be plainly marked as such, and must not be misrepresented as
//! >    being the original software.
//! > 3. This notice may not be removed or altered from any source distribution.
//!
//! Labels are letters and shape names only: no platform logo, product or brand name.

use std::collections::BTreeMap;

use crate::binding::{Binding, ChordInput, KeyCode, PadAxis, PadButton, PadFamily, Sign, Stick, wire_enum};
use crate::id::ActionId;
use crate::map::ActionMap;
use crate::state::Device;

/// The most keys a layout map relabels (a full keyboard is about 100).
pub const KEY_LABELS_MAX: usize = 256;
/// The longest key label a layout map may set, in bytes.
pub const KEY_LABEL_BYTES_MAX: usize = 16;

/// The words a glyph prints besides key and button names.
struct Message {
    unbound: &'static str,
    arrows: &'static str,
    mouse_look: &'static str,
    wheel: &'static str,
    dpad: &'static str,
    left_stick: &'static str,
    right_stick: &'static str,
    up: &'static str,
    down: &'static str,
    left: &'static str,
    right: &'static str,
    /// Between a keyboard and a pad label in a hint ("Space · Cross").
    hint_separator: &'static str,
}

const MESSAGE: Message = Message {
    unbound: "Unbound",
    arrows: "Arrows",
    mouse_look: "Mouse",
    wheel: "Wheel",
    dpad: "D-pad",
    left_stick: "Left Stick",
    right_stick: "Right Stick",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    hint_separator: " · ",
};

wire_enum!(
    /// What a glyph is drawn as: the cap or button outline around its label.
    GlyphShape {
        /// A keyboard key cap.
        Key = "key",
        /// A mouse button, mouse look or the wheel.
        Mouse = "mouse",
        /// A face button, or a menu or system button.
        FaceButton = "faceButton",
        /// A shoulder bumper.
        Shoulder = "shoulder",
        /// An analog trigger.
        Trigger = "trigger",
        /// A stick, a stick direction or a stick press.
        Stick = "stick",
        /// The d-pad or one of its directions.
        Dpad = "dpad",
        /// An on-screen touch control.
        Touch = "touch",
        /// Inputs held together.
        Chord = "chord",
    }
);

/// A binding as a prompt shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Glyph {
    /// The text on the cap ("Space", "Cross", "WASD").
    pub label: String,
    /// The cap it is drawn in.
    pub shape: GlyphShape,
    /// The device the binding belongs to (a pad carries its family).
    pub device: Device,
}

/// A keyboard layout's labels by DOM key code, from the shell: display only. Rows that are not a
/// canonical code with a short printable label are dropped, never applied.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyLabels {
    labels: BTreeMap<KeyCode, String>,
    dropped: usize,
}

impl KeyLabels {
    /// No relabelling: every key reads its own name.
    pub fn new() -> KeyLabels {
        KeyLabels::default()
    }

    /// Labels from `(code, label)` rows. The first row for a code wins; a single-letter label is
    /// shown upper case (the browser's layout map answers "z"). At most [`KEY_LABELS_MAX`] rows
    /// apply; every other row is counted in [`KeyLabels::dropped`].
    pub fn from_pairs<'a>(rows: impl IntoIterator<Item = (&'a str, &'a str)>) -> KeyLabels {
        let mut labels = KeyLabels::default();
        for (code, label) in rows {
            labels.insert(code, label);
        }
        labels
    }

    /// How many keys are relabelled.
    pub fn len(&self) -> usize {
        self.labels.len()
    }

    /// Whether no key is relabelled.
    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }

    /// How many rows were refused (bad code, bad label, repeated code, over the cap).
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// The layout's label for `key`, if it sets one.
    pub fn get(&self, key: KeyCode) -> Option<&str> {
        self.labels.get(&key).map(String::as_str)
    }

    fn insert(&mut self, code: &str, label: &str) {
        // DOM codes are case-sensitive and start upper case (`KeyW`, `Digit1`, `F5`): `keyw` names no key.
        let dom_code = code.starts_with(|c: char| c.is_ascii_uppercase());
        let key = KeyCode::parse(code).ok().filter(|key| dom_code && key.as_str() == code);
        let room = self.labels.len() < KEY_LABELS_MAX;
        match key {
            Some(key) if room && label_ok(label) && !self.labels.contains_key(&key) => {
                self.labels.insert(key, shown(label));
            }
            _ => self.dropped += 1,
        }
    }
}

/// 1 to [`KEY_LABEL_BYTES_MAX`] bytes, no control characters and no invisible formatting (bidi
/// overrides, zero-width marks), so a label cannot hide or reorder the text around it.
fn label_ok(label: &str) -> bool {
    let invisible =
        |c: char| matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}');
    let printable = label.chars().all(|c| !c.is_control() && !invisible(c));
    let sized = !label.is_empty() && label.len() <= KEY_LABEL_BYTES_MAX;
    sized && printable && !label.trim().is_empty()
}

/// A single letter upper case, anything longer as given.
fn shown(label: &str) -> String {
    let mut chars = label.chars();
    match (chars.next(), chars.next()) {
        (Some(only), None) => only.to_uppercase().collect(),
        _ => label.to_owned(),
    }
}

/// DOM codes whose label is not derived from the code's own spelling.
const NAMED_KEYS: [(&str, &str); 44] = [
    ("Space", "Space"),
    ("Enter", "Enter"),
    ("NumpadEnter", "Num Enter"),
    ("Escape", "Esc"),
    ("Tab", "Tab"),
    ("Backspace", "Backspace"),
    ("CapsLock", "Caps Lock"),
    ("ShiftLeft", "Shift"),
    ("ShiftRight", "Shift"),
    ("ControlLeft", "Ctrl"),
    ("ControlRight", "Ctrl"),
    ("AltLeft", "Alt"),
    ("AltRight", "Alt"),
    ("MetaLeft", "Meta"),
    ("MetaRight", "Meta"),
    ("ArrowUp", "Up"),
    ("ArrowDown", "Down"),
    ("ArrowLeft", "Left"),
    ("ArrowRight", "Right"),
    ("Minus", "-"),
    ("Equal", "="),
    ("BracketLeft", "["),
    ("BracketRight", "]"),
    ("Backslash", "\\"),
    ("Semicolon", ";"),
    ("Quote", "'"),
    ("Backquote", "`"),
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
    ("Insert", "Ins"),
    ("Delete", "Del"),
    ("Home", "Home"),
    ("End", "End"),
    ("PageUp", "PgUp"),
    ("PageDown", "PgDn"),
    ("ContextMenu", "Menu"),
    ("NumpadAdd", "Num +"),
    ("NumpadSubtract", "Num -"),
    ("NumpadMultiply", "Num *"),
    ("NumpadDivide", "Num /"),
    ("Mouse1", "LMB"),
    ("Mouse2", "RMB"),
    ("Mouse3", "MMB"),
];

/// The arrow keys, in a `keys4`'s up, down, left, right order.
const ARROW_KEYS: [&str; 4] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/// A key's label: the layout's, else the named table, else the code's letter or digit, else the
/// code itself (`F5`).
pub fn key_label(key: KeyCode, labels: &KeyLabels) -> String {
    if let Some(label) = labels.get(key) {
        return label.to_owned();
    }
    let code = key.as_str();
    if let Some((_, label)) = NAMED_KEYS.iter().find(|(named, _)| *named == code) {
        return (*label).to_owned();
    }
    let one_char = |rest: &&str| rest.len() == 1;
    if let Some(letter) = code.strip_prefix("Key").filter(one_char) {
        return letter.to_owned();
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(one_char) {
        return digit.to_owned();
    }
    if let Some(digit) = code.strip_prefix("Numpad").filter(one_char) {
        return format!("Num {digit}");
    }
    code.to_owned()
}

fn is_mouse(key: KeyCode) -> bool {
    key.as_str().starts_with("Mouse")
}

/// Face labels by family, in South, East, West, North order (SDL3's face styles, altered; see the
/// module notes).
fn face_labels(family: PadFamily) -> [&'static str; 4] {
    match family {
        PadFamily::Xbox | PadFamily::Steam => ["A", "B", "X", "Y"],
        PadFamily::PlayStation => ["Cross", "Circle", "Square", "Triangle"],
        PadFamily::Nintendo => ["B", "A", "Y", "X"],
        PadFamily::Generic => ["South", "East", "West", "North"],
    }
}

/// Shoulder, trigger, menu and stick-press labels by family (genex's own table), in the order
/// LeftShoulder, RightShoulder, LeftTrigger, RightTrigger, Select, Start, LeftStickPress,
/// RightStickPress.
fn other_labels(family: PadFamily) -> [&'static str; 8] {
    match family {
        PadFamily::Xbox => ["LB", "RB", "LT", "RT", "View", "Menu", "LS", "RS"],
        PadFamily::Steam => ["L1", "R1", "L2", "R2", "View", "Menu", "L3", "R3"],
        PadFamily::PlayStation => ["L1", "R1", "L2", "R2", "Share", "Options", "L3", "R3"],
        PadFamily::Nintendo => ["L", "R", "ZL", "ZR", "Minus", "Plus", "LS", "RS"],
        PadFamily::Generic => [
            "Left Shoulder",
            "Right Shoulder",
            "Left Trigger",
            "Right Trigger",
            "Select",
            "Start",
            "Left Stick Press",
            "Right Stick Press",
        ],
    }
}

/// A pad button's label on a pad of `family`.
pub fn pad_label(button: PadButton, family: PadFamily) -> &'static str {
    let [south, east, west, north] = face_labels(family);
    let [lb, rb, lt, rt, select, start, ls, rs] = other_labels(family);
    match button {
        PadButton::South => south,
        PadButton::East => east,
        PadButton::West => west,
        PadButton::North => north,
        PadButton::LeftShoulder => lb,
        PadButton::RightShoulder => rb,
        PadButton::LeftTrigger => lt,
        PadButton::RightTrigger => rt,
        PadButton::Select => select,
        PadButton::Start => start,
        PadButton::LeftStickPress => ls,
        PadButton::RightStickPress => rs,
        PadButton::DpadUp => "D-pad Up",
        PadButton::DpadDown => "D-pad Down",
        PadButton::DpadLeft => "D-pad Left",
        PadButton::DpadRight => "D-pad Right",
        PadButton::Home => "Home",
    }
}

fn pad_shape(button: PadButton) -> GlyphShape {
    match button {
        PadButton::LeftShoulder | PadButton::RightShoulder => GlyphShape::Shoulder,
        PadButton::LeftTrigger | PadButton::RightTrigger => GlyphShape::Trigger,
        PadButton::LeftStickPress | PadButton::RightStickPress => GlyphShape::Stick,
        PadButton::DpadUp | PadButton::DpadDown | PadButton::DpadLeft | PadButton::DpadRight => GlyphShape::Dpad,
        _ => GlyphShape::FaceButton,
    }
}

fn stick_name(stick: Stick) -> &'static str {
    match stick {
        Stick::Left => MESSAGE.left_stick,
        Stick::Right => MESSAGE.right_stick,
    }
}

/// "Left Stick Up": the stick and the direction its half axis pushes (y is down-positive).
fn half_axis_label(axis: PadAxis, sign: Sign) -> String {
    let is_x = matches!(axis, PadAxis::LeftX | PadAxis::RightX);
    let direction = match (is_x, sign) {
        (true, Sign::Negative) => MESSAGE.left,
        (true, Sign::Positive) => MESSAGE.right,
        (false, Sign::Negative) => MESSAGE.up,
        (false, Sign::Positive) => MESSAGE.down,
    };
    format!("{} {direction}", stick_name(axis.stick()))
}

/// The device a binding belongs to; a chord with any pad button is a pad chord.
fn binding_device(binding: &Binding, family: PadFamily) -> Device {
    match binding {
        Binding::Key(_) | Binding::Keys2 { .. } | Binding::Keys4 { .. } | Binding::Look | Binding::Wheel => {
            Device::KeyboardMouse
        }
        Binding::Pad(_) | Binding::PadAxis(..) | Binding::Stick(_) | Binding::Dpad => Device::Pad(family),
        Binding::Touch(_) => Device::Touch,
        Binding::Chord(_) => {
            let pad_member = binding.chord_inputs().iter().any(|input| matches!(input, ChordInput::Pad(_)));
            if pad_member { Device::Pad(family) } else { Device::KeyboardMouse }
        }
    }
}

/// "WASD" when every key reads one character (up, left, down, right, the order players say it),
/// "Arrows" for the arrow keys, else the four labels joined by "/".
fn keys4_label(keys: [KeyCode; 4], labels: &KeyLabels) -> String {
    let [up, down, left, right] = keys;
    let arrows = keys.iter().zip(ARROW_KEYS).all(|(key, arrow)| key.as_str() == arrow);
    if arrows && keys.iter().all(|key| labels.get(*key).is_none()) {
        return MESSAGE.arrows.to_owned();
    }
    let spoken = [up, left, down, right].map(|key| key_label(key, labels));
    if spoken.iter().all(|label| label.chars().count() == 1) {
        return spoken.concat();
    }
    spoken.join("/")
}

fn chord_member_label(input: &ChordInput, family: PadFamily, labels: &KeyLabels) -> String {
    match input {
        ChordInput::Key(key) => key_label(*key, labels),
        ChordInput::Pad(button) => pad_label(*button, family).to_owned(),
    }
}

/// How `binding` looks on a pad of `family` (ignored for keys) with the layout's `labels`.
pub fn binding_glyph(binding: &Binding, family: PadFamily, labels: &KeyLabels) -> Glyph {
    let (label, shape) = match binding {
        Binding::Key(key) => {
            let shape = if is_mouse(*key) { GlyphShape::Mouse } else { GlyphShape::Key };
            (key_label(*key, labels), shape)
        }
        Binding::Pad(button) => (pad_label(*button, family).to_owned(), pad_shape(*button)),
        Binding::PadAxis(axis, sign) => (half_axis_label(*axis, *sign), GlyphShape::Stick),
        Binding::Stick(stick) => (stick_name(*stick).to_owned(), GlyphShape::Stick),
        Binding::Keys2 { negative, positive } => {
            (format!("{}/{}", key_label(*negative, labels), key_label(*positive, labels)), GlyphShape::Key)
        }
        Binding::Keys4 { up, down, left, right } => (keys4_label([*up, *down, *left, *right], labels), GlyphShape::Key),
        Binding::Dpad => (MESSAGE.dpad.to_owned(), GlyphShape::Dpad),
        Binding::Chord(_) => {
            let parts: Vec<String> =
                binding.chord_inputs().iter().map(|input| chord_member_label(input, family, labels)).collect();
            (parts.join("+"), GlyphShape::Chord)
        }
        Binding::Touch(control) => (control.name().to_owned(), GlyphShape::Touch),
        Binding::Look => (MESSAGE.mouse_look.to_owned(), GlyphShape::Mouse),
        Binding::Wheel => (MESSAGE.wheel.to_owned(), GlyphShape::Mouse),
    };
    Glyph { label, shape, device: binding_device(binding, family) }
}

fn same_device(a: Device, b: Device) -> bool {
    matches!(
        (a, b),
        (Device::KeyboardMouse, Device::KeyboardMouse)
            | (Device::Pad(_), Device::Pad(_))
            | (Device::Touch, Device::Touch)
    )
}

fn family_of(device: Device) -> PadFamily {
    match device {
        Device::Pad(family) => family,
        Device::KeyboardMouse | Device::Touch => PadFamily::Generic,
    }
}

/// The glyph for `action` on `device` (the action state's last device): its first binding of
/// that device, else its first binding on its own device, else "Unbound". An id the map does not
/// declare reads "Unbound" too.
pub fn action_glyph(map: &ActionMap, action: ActionId, device: Device, labels: &KeyLabels) -> Glyph {
    let family = family_of(device);
    let bindings = map.bindings(action);
    let on_device = bindings.iter().find(|binding| same_device(binding_device(binding, family), device));
    match on_device.or_else(|| bindings.first()) {
        Some(binding) => binding_glyph(binding, family, labels),
        None => Glyph { label: MESSAGE.unbound.to_owned(), shape: GlyphShape::Key, device },
    }
}

/// A one-line hint for `state().__input.hints`: the first keyboard label and the first pad label
/// on a pad of `family`, joined ("Space · Cross"); empty when the action has neither.
pub fn hint(map: &ActionMap, action: ActionId, family: PadFamily, labels: &KeyLabels) -> String {
    let bindings = map.bindings(action);
    let first = |device: Device| {
        bindings
            .iter()
            .find(|binding| same_device(binding_device(binding, family), device))
            .map(|binding| binding_glyph(binding, family, labels).label)
    };
    let parts: Vec<String> = [first(Device::KeyboardMouse), first(Device::Pad(family))].into_iter().flatten().collect();
    parts.join(MESSAGE.hint_separator)
}
