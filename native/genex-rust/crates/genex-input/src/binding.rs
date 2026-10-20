//! Bindings: which device input drives an action. A binding has one wire spelling
//! (`key:Space`, `pad:south`, `axis:leftY-`, `stick:left`, `keys4:KeyW,KeyS,KeyA,KeyD`,
//! `chord:key:ShiftLeft+key:KeyE`, `touch:jump`, `dpad`, `look`, `wheel`), which the bindings
//! file stores and the controls panel prints.
//!
//! Keys are DOM `code` names, the same canonical spelling genex-core's merger produces; pad
//! buttons and axes are the standard-mapping order the merger fills on every destination.

use genex_core::input::{MAX_KEY_NAME, PAD_AXES, PAD_BUTTONS, canonical_key};

use crate::error::{InputError, InputErrorCode};
use crate::id::ControlId;

/// The most inputs one chord combines.
pub const CHORD_INPUTS_MAX: usize = 3;
/// The longest binding wire spelling accepted, in bytes (a `keys4` of four long key names fits).
pub const BINDING_WIRE_MAX: usize = 4 * MAX_KEY_NAME + 16;

/// A vocabulary enum with `ALL`, `as_str` and `from_wire` over exact wire spellings.
macro_rules! wire_enum {
    ($(#[$doc:meta])* $name:ident { $($(#[$vdoc:meta])* $variant:ident = $wire:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $($(#[$vdoc])* $variant),+
        }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// The wire spelling.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $wire),+
                }
            }

            /// The value a wire spelling names; an unknown spelling answers `None`.
            pub fn from_wire(name: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|value| value.as_str() == name)
            }
        }
    };
}
pub(crate) use wire_enum;

wire_enum!(
    /// A pad button, in the standard mapping's order (`index()` is the Gamepad API index).
    PadButton {
        /// Bottom face button (Xbox A, PlayStation Cross, Nintendo B).
        South = "south",
        /// Right face button (Xbox B, PlayStation Circle, Nintendo A).
        East = "east",
        /// Left face button (Xbox X, PlayStation Square, Nintendo Y).
        West = "west",
        /// Top face button (Xbox Y, PlayStation Triangle, Nintendo X).
        North = "north",
        /// Left bumper.
        LeftShoulder = "leftShoulder",
        /// Right bumper.
        RightShoulder = "rightShoulder",
        /// Left trigger (analog).
        LeftTrigger = "leftTrigger",
        /// Right trigger (analog).
        RightTrigger = "rightTrigger",
        /// Back, View, Share or Minus.
        Select = "select",
        /// Start, Menu, Options or Plus.
        Start = "start",
        /// Left stick click.
        LeftStickPress = "leftStickPress",
        /// Right stick click.
        RightStickPress = "rightStickPress",
        /// D-pad up.
        DpadUp = "dpadUp",
        /// D-pad down.
        DpadDown = "dpadDown",
        /// D-pad left.
        DpadLeft = "dpadLeft",
        /// D-pad right.
        DpadRight = "dpadRight",
        /// The system button (reserved outside the `ui` context).
        Home = "home",
    }
);

impl PadButton {
    /// The standard-mapping index, `0..PAD_BUTTONS`.
    pub fn index(self) -> usize {
        // Declaration order is the standard mapping's order.
        let at = PadButton::ALL.iter().position(|button| *button == self).unwrap_or(0);
        debug_assert!(at < PAD_BUTTONS);
        at
    }

    /// The button at a standard-mapping index.
    pub fn from_index(index: usize) -> Option<PadButton> {
        PadButton::ALL.get(index).copied()
    }
}

wire_enum!(
    /// A stick axis in the standard mapping (y is down-positive, like the merger's).
    PadAxis {
        /// Left stick, x.
        LeftX = "leftX",
        /// Left stick, y.
        LeftY = "leftY",
        /// Right stick, x.
        RightX = "rightX",
        /// Right stick, y.
        RightY = "rightY",
    }
);

impl PadAxis {
    /// The standard-mapping index, `0..PAD_AXES`.
    pub fn index(self) -> usize {
        let at = PadAxis::ALL.iter().position(|axis| *axis == self).unwrap_or(0);
        debug_assert!(at < PAD_AXES);
        at
    }

    /// The axis at a standard-mapping index.
    pub fn from_index(index: usize) -> Option<PadAxis> {
        PadAxis::ALL.get(index).copied()
    }

    /// The stick this axis belongs to.
    pub fn stick(self) -> Stick {
        match self {
            PadAxis::LeftX | PadAxis::LeftY => Stick::Left,
            PadAxis::RightX | PadAxis::RightY => Stick::Right,
        }
    }
}

wire_enum!(
    /// Which half of an axis a half-axis binding reads.
    Sign {
        /// The positive half (right, down).
        Positive = "+",
        /// The negative half (left, up).
        Negative = "-",
    }
);

impl Sign {
    /// +1 or -1.
    pub fn factor(self) -> f32 {
        match self {
            Sign::Positive => 1.0,
            Sign::Negative => -1.0,
        }
    }
}

wire_enum!(
    /// A pad stick.
    Stick {
        /// The left stick.
        Left = "left",
        /// The right stick.
        Right = "right",
    }
);

impl Stick {
    /// Its x and y axes.
    pub fn axes(self) -> (PadAxis, PadAxis) {
        match self {
            Stick::Left => (PadAxis::LeftX, PadAxis::LeftY),
            Stick::Right => (PadAxis::RightX, PadAxis::RightY),
        }
    }

    /// 0 for left, 1 for right (the index of per-stick accessibility settings).
    pub fn slot(self) -> usize {
        match self {
            Stick::Left => 0,
            Stick::Right => 1,
        }
    }

    /// The other stick.
    pub fn other(self) -> Stick {
        match self {
            Stick::Left => Stick::Right,
            Stick::Right => Stick::Left,
        }
    }
}

/// A pad's family, which picks the face labels and the `ui` context's confirm button. Display and
/// layout only: it never changes what an input is bound to outside the `ui` context. genex-core
/// owns the vocabulary (one table, with the per-platform family fill); this crate re-exports it.
pub use genex_core::pad_family::PadFamily;

/// A key, by its DOM `code` name (`KeyW`, `Space`, `ShiftLeft`, `Mouse1`). Stored inline so a
/// binding is `Copy` and a const (`Binding::WASD`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct KeyCode {
    len: u8,
    bytes: [u8; MAX_KEY_NAME],
}

impl KeyCode {
    /// A key from a canonical DOM code known when the game is written. In a const it fails the
    /// build when `code` is not a plausible code name (ASCII letters and digits, starting with a
    /// letter, at most 32 bytes).
    pub const fn of(code: &'static str) -> KeyCode {
        let src = code.as_bytes();
        assert!(!src.is_empty() && src.len() <= MAX_KEY_NAME, "a key code is 1 to 32 bytes");
        assert!(src[0].is_ascii_alphabetic(), "a key code starts with a letter");
        let mut bytes = [0u8; MAX_KEY_NAME];
        let mut i = 0;
        while i < src.len() {
            assert!(src[i].is_ascii_alphanumeric(), "a key code is ASCII letters and digits");
            bytes[i] = src[i];
            i += 1;
        }
        KeyCode { len: src.len() as u8, bytes }
    }

    /// A key from either spelling the merger accepts (`w` is `KeyW`, `" "` is `Space`).
    pub fn parse(name: &str) -> Result<KeyCode, InputError> {
        let code = canonical_key(name);
        if code.is_empty() {
            return Err(InputError::new(InputErrorCode::BindingsInvalid, format!("not a key name: {name:?}")));
        }
        let mut bytes = [0u8; MAX_KEY_NAME];
        bytes[..code.len()].copy_from_slice(code.as_bytes());
        Ok(KeyCode { len: code.len() as u8, bytes })
    }

    /// The canonical DOM code.
    pub fn as_str(&self) -> &str {
        // Only ASCII is ever stored.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)]).unwrap_or("")
    }
}

impl std::fmt::Debug for KeyCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KeyCode({:?})", self.as_str())
    }
}

/// One input of a chord: a key or a pad button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ChordInput {
    /// A key.
    Key(KeyCode),
    /// A pad button.
    Pad(PadButton),
}

impl ChordInput {
    fn wire(&self) -> String {
        match self {
            ChordInput::Key(key) => format!("key:{}", key.as_str()),
            ChordInput::Pad(button) => format!("pad:{}", button.as_str()),
        }
    }

    fn source(&self) -> Source {
        match self {
            ChordInput::Key(key) => Source::Key(*key),
            ChordInput::Pad(button) => Source::Button(*button),
        }
    }
}

/// What a binding's value means to an action: a button, a signed 1D axis or a 2D axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ActionKind {
    /// Down or up (an analog source counts as down past its press threshold).
    Button,
    /// One signed axis in [-1, 1].
    Axis1,
    /// Two axes (x right, y down), length at most 1 for sticks and keys.
    Axis2,
}

impl ActionKind {
    /// Every kind.
    pub const ALL: [ActionKind; 3] = [ActionKind::Button, ActionKind::Axis1, ActionKind::Axis2];

    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ActionKind::Button => "button",
            ActionKind::Axis1 => "axis1",
            ActionKind::Axis2 => "axis2",
        }
    }
}

/// A device input bound to an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Binding {
    /// A key (`key:Space`): 0 or 1.
    Key(KeyCode),
    /// A pad button (`pad:south`): its analog value in [0, 1].
    Pad(PadButton),
    /// One half of a stick axis (`axis:leftY-`): in [0, 1].
    PadAxis(PadAxis, Sign),
    /// A whole stick (`stick:left`): a 2D value with the radial dead zone.
    Stick(Stick),
    /// Two keys as a 1D axis (`keys2:KeyQ,KeyE`): -1, 0 or 1.
    Keys2 {
        /// The key for -1.
        negative: KeyCode,
        /// The key for +1.
        positive: KeyCode,
    },
    /// Four keys as a 2D axis (`keys4:KeyW,KeyS,KeyA,KeyD`), diagonals normalized.
    Keys4 {
        /// The key for y = -1.
        up: KeyCode,
        /// The key for y = +1.
        down: KeyCode,
        /// The key for x = -1.
        left: KeyCode,
        /// The key for x = +1.
        right: KeyCode,
    },
    /// The d-pad as a 2D axis (`dpad`).
    Dpad,
    /// Two or three keys or pad buttons held together (`chord:key:ShiftLeft+key:KeyE`). In one
    /// context a longer chord takes its inputs from shorter bindings.
    Chord([Option<ChordInput>; CHORD_INPUTS_MAX]),
    /// An on-screen touch control (`touch:jump`).
    Touch(ControlId),
    /// Mouse-look movement in pixels while the pointer is locked (`look`).
    Look,
    /// Wheel movement (`wheel`).
    Wheel,
}

/// One device input a binding reads, so contexts can consume it and rebinding can find clashes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Source {
    Key(KeyCode),
    Button(PadButton),
    /// One half of a stick axis: `leftY-` and `leftY+` are two inputs.
    Half(PadAxis, Sign),
    Look,
    Wheel,
    Touch(ControlId),
}

const DPAD: [PadButton; 4] = [PadButton::DpadUp, PadButton::DpadDown, PadButton::DpadLeft, PadButton::DpadRight];

impl Binding {
    /// W, A, S, D as a 2D axis.
    pub const WASD: Binding = Binding::Keys4 {
        up: KeyCode::of("KeyW"),
        down: KeyCode::of("KeyS"),
        left: KeyCode::of("KeyA"),
        right: KeyCode::of("KeyD"),
    };
    /// The arrow keys as a 2D axis.
    pub const ARROWS: Binding = Binding::Keys4 {
        up: KeyCode::of("ArrowUp"),
        down: KeyCode::of("ArrowDown"),
        left: KeyCode::of("ArrowLeft"),
        right: KeyCode::of("ArrowRight"),
    };

    /// A key binding from either key spelling.
    pub fn key(code: &str) -> Result<Binding, InputError> {
        KeyCode::parse(code).map(Binding::Key)
    }

    /// A chord of two or three distinct inputs.
    pub fn chord(inputs: &[ChordInput]) -> Result<Binding, InputError> {
        let mut members = [None; CHORD_INPUTS_MAX];
        if inputs.len() < 2 || inputs.len() > CHORD_INPUTS_MAX {
            return Err(InputError::new(InputErrorCode::BindingMismatch, "a chord holds two or three inputs"));
        }
        for (at, input) in inputs.iter().enumerate() {
            if inputs[..at].contains(input) {
                return Err(InputError::new(InputErrorCode::BindingMismatch, "a chord repeats an input"));
            }
            members[at] = Some(*input);
        }
        Ok(Binding::Chord(members))
    }

    /// The chord's inputs (empty for any other binding).
    pub fn chord_inputs(&self) -> Vec<ChordInput> {
        match self {
            Binding::Chord(members) => members.iter().flatten().copied().collect(),
            _ => Vec::new(),
        }
    }

    /// Whether this binding can drive an action of `kind`.
    pub fn accepts(&self, kind: ActionKind) -> bool {
        match self {
            Binding::Key(_) | Binding::Pad(_) | Binding::PadAxis(..) => kind != ActionKind::Axis2,
            Binding::Chord(_) => kind == ActionKind::Button,
            Binding::Keys2 { .. } | Binding::Wheel => kind == ActionKind::Axis1,
            Binding::Stick(_) | Binding::Keys4 { .. } | Binding::Dpad | Binding::Look => kind == ActionKind::Axis2,
            // A touch control is a button or a stick; its kind is checked with the controls (IN-8).
            Binding::Touch(_) => true,
        }
    }

    /// The wire spelling.
    pub fn wire(&self) -> String {
        match self {
            Binding::Key(key) => format!("key:{}", key.as_str()),
            Binding::Pad(button) => format!("pad:{}", button.as_str()),
            Binding::PadAxis(axis, sign) => format!("axis:{}{}", axis.as_str(), sign.as_str()),
            Binding::Stick(stick) => format!("stick:{}", stick.as_str()),
            Binding::Keys2 { negative, positive } => format!("keys2:{},{}", negative.as_str(), positive.as_str()),
            Binding::Keys4 { up, down, left, right } => {
                format!("keys4:{},{},{},{}", up.as_str(), down.as_str(), left.as_str(), right.as_str())
            }
            Binding::Dpad => "dpad".to_owned(),
            Binding::Chord(members) => {
                let parts: Vec<String> = members.iter().flatten().map(ChordInput::wire).collect();
                format!("chord:{}", parts.join("+"))
            }
            Binding::Touch(control) => format!("touch:{}", control.name()),
            Binding::Look => "look".to_owned(),
            Binding::Wheel => "wheel".to_owned(),
        }
    }

    /// The binding a wire spelling names. `touch:` bindings need the game's control ids, so
    /// they are refused here; see [`Binding::from_wire_with`].
    pub fn from_wire(text: &str) -> Result<Binding, InputError> {
        Binding::from_wire_with(text, |_| None)
    }

    /// The binding a wire spelling names, resolving `touch:<id>` through `control`.
    pub fn from_wire_with(text: &str, control: impl Fn(&str) -> Option<ControlId>) -> Result<Binding, InputError> {
        let invalid = || InputError::new(InputErrorCode::BindingsInvalid, format!("not a binding: {:?}", clip(text)));
        if text.len() > BINDING_WIRE_MAX {
            return Err(invalid());
        }
        match text {
            "dpad" => return Ok(Binding::Dpad),
            "look" => return Ok(Binding::Look),
            "wheel" => return Ok(Binding::Wheel),
            _ => {}
        }
        let (kind, rest) = text.split_once(':').ok_or_else(invalid)?;
        let key = |name: &str| strict_key(name).ok_or_else(invalid);
        match kind {
            "key" => Ok(Binding::Key(key(rest)?)),
            "pad" => PadButton::from_wire(rest).map(Binding::Pad).ok_or_else(invalid),
            "axis" => parse_half_axis(rest).ok_or_else(invalid),
            "stick" => Stick::from_wire(rest).map(Binding::Stick).ok_or_else(invalid),
            "keys2" => match rest.split(',').collect::<Vec<_>>().as_slice() {
                [negative, positive] => Ok(Binding::Keys2 { negative: key(negative)?, positive: key(positive)? }),
                _ => Err(invalid()),
            },
            "keys4" => match rest.split(',').collect::<Vec<_>>().as_slice() {
                [up, down, left, right] => {
                    Ok(Binding::Keys4 { up: key(up)?, down: key(down)?, left: key(left)?, right: key(right)? })
                }
                _ => Err(invalid()),
            },
            "chord" => {
                let inputs = rest.split('+').map(parse_chord_input).collect::<Option<Vec<_>>>().ok_or_else(invalid)?;
                Binding::chord(&inputs)
            }
            "touch" => control(rest).map(Binding::Touch).ok_or_else(invalid),
            _ => Err(invalid()),
        }
    }

    /// Every device input this binding reads.
    pub(crate) fn sources(&self) -> Vec<Source> {
        match self {
            Binding::Key(key) => vec![Source::Key(*key)],
            Binding::Pad(button) => vec![Source::Button(*button)],
            Binding::PadAxis(axis, sign) => vec![Source::Half(*axis, *sign)],
            Binding::Stick(stick) => {
                let (x, y) = stick.axes();
                [x, y]
                    .into_iter()
                    .flat_map(|axis| [Sign::Negative, Sign::Positive].map(|sign| Source::Half(axis, sign)))
                    .collect()
            }
            Binding::Keys2 { negative, positive } => vec![Source::Key(*negative), Source::Key(*positive)],
            Binding::Keys4 { up, down, left, right } => {
                vec![Source::Key(*up), Source::Key(*down), Source::Key(*left), Source::Key(*right)]
            }
            Binding::Dpad => DPAD.iter().map(|button| Source::Button(*button)).collect(),
            Binding::Chord(members) => members.iter().flatten().map(ChordInput::source).collect(),
            Binding::Touch(control) => vec![Source::Touch(*control)],
            Binding::Look => vec![Source::Look],
            Binding::Wheel => vec![Source::Wheel],
        }
    }

    /// Whether two bindings in one context would read the same input. A chord shares inputs with
    /// the shorter bindings it is meant to beat, so a chord clashes only with an equal chord.
    pub(crate) fn clashes(&self, other: &Binding) -> bool {
        let chords = matches!(self, Binding::Chord(_)) || matches!(other, Binding::Chord(_));
        if chords {
            return same_chord(self, other);
        }
        let mine = self.sources();
        other.sources().iter().any(|source| mine.contains(source))
    }

    /// Whether the system keeps this binding outside the `ui` context.
    pub fn is_reserved(&self) -> bool {
        let reserved_input = |source: &Source| match source {
            Source::Key(key) => key.as_str() == RESERVED_KEY,
            Source::Button(button) => *button == PadButton::Home,
            _ => false,
        };
        self.sources().iter().any(reserved_input)
    }
}

/// The key that always opens or closes the system menu.
const RESERVED_KEY: &str = "Escape";

fn same_chord(a: &Binding, b: &Binding) -> bool {
    let (Binding::Chord(_), Binding::Chord(_)) = (a, b) else { return false };
    let mut left = a.chord_inputs();
    let mut right = b.chord_inputs();
    left.sort();
    right.sort();
    left == right
}

/// A key name in the bindings file must already be canonical, so one spelling round-trips.
fn strict_key(name: &str) -> Option<KeyCode> {
    let key = KeyCode::parse(name).ok()?;
    (key.as_str() == name).then_some(key)
}

fn parse_half_axis(rest: &str) -> Option<Binding> {
    let split = rest.len().checked_sub(1)?;
    let (axis, sign) = (rest.get(..split)?, rest.get(split..)?);
    Some(Binding::PadAxis(PadAxis::from_wire(axis)?, Sign::from_wire(sign)?))
}

fn parse_chord_input(part: &str) -> Option<ChordInput> {
    let (kind, name) = part.split_once(':')?;
    match kind {
        "key" => strict_key(name).map(ChordInput::Key),
        "pad" => PadButton::from_wire(name).map(ChordInput::Pad),
        _ => None,
    }
}

/// A refused spelling, cut short for a detail line.
fn clip(text: &str) -> String {
    text.chars().take(48).collect()
}
