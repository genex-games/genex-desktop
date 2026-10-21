//! What an update or UI hook reads besides the simulation: one tick's merged input, the seeded
//! rng and the fixed clock. Game code reads nothing else (no wall clock, no direct winit input).

use crate::rng::Pcg32;
use genex_core::saves::Saves;
use glam::Vec2;
use std::cell::Cell;

macro_rules! keys {
    ($($variant:ident => $code:literal),* $(,)?) => {
        /// A key, mouse button or touch-emulating button by its DOM `code` name, the protocol's
        /// spelling ("KeyW", "Space", "Mouse1").
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[non_exhaustive]
        pub enum Key {
            $(
                #[doc = concat!("`", $code, "`")]
                $variant,
            )*
        }

        impl Key {
            /// Every key, in declaration order.
            pub const ALL: &'static [Key] = &[$(Key::$variant),*];

            /// The DOM `code` name.
            pub const fn code(self) -> &'static str {
                match self {
                    $(Key::$variant => $code,)*
                }
            }

            /// The key with this DOM `code` name.
            pub fn from_code(code: &str) -> Option<Key> {
                match code {
                    $($code => Some(Key::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

keys! {
    KeyA => "KeyA", KeyB => "KeyB", KeyC => "KeyC", KeyD => "KeyD", KeyE => "KeyE", KeyF => "KeyF",
    KeyG => "KeyG", KeyH => "KeyH", KeyI => "KeyI", KeyJ => "KeyJ", KeyK => "KeyK", KeyL => "KeyL",
    KeyM => "KeyM", KeyN => "KeyN", KeyO => "KeyO", KeyP => "KeyP", KeyQ => "KeyQ", KeyR => "KeyR",
    KeyS => "KeyS", KeyT => "KeyT", KeyU => "KeyU", KeyV => "KeyV", KeyW => "KeyW", KeyX => "KeyX",
    KeyY => "KeyY", KeyZ => "KeyZ",
    Digit0 => "Digit0", Digit1 => "Digit1", Digit2 => "Digit2", Digit3 => "Digit3", Digit4 => "Digit4",
    Digit5 => "Digit5", Digit6 => "Digit6", Digit7 => "Digit7", Digit8 => "Digit8", Digit9 => "Digit9",
    Space => "Space", Enter => "Enter", Escape => "Escape", Tab => "Tab", Backspace => "Backspace",
    ArrowUp => "ArrowUp", ArrowDown => "ArrowDown", ArrowLeft => "ArrowLeft", ArrowRight => "ArrowRight",
    ShiftLeft => "ShiftLeft", ShiftRight => "ShiftRight", ControlLeft => "ControlLeft",
    ControlRight => "ControlRight", AltLeft => "AltLeft", AltRight => "AltRight",
    Minus => "Minus", Equal => "Equal", Comma => "Comma", Period => "Period", Slash => "Slash",
    Semicolon => "Semicolon", Quote => "Quote", BracketLeft => "BracketLeft",
    BracketRight => "BracketRight", Backquote => "Backquote", Backslash => "Backslash",
    F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4", F5 => "F5", F6 => "F6", F7 => "F7", F8 => "F8",
    F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
    Mouse1 => "Mouse1", Mouse2 => "Mouse2", Mouse3 => "Mouse3",
}

/// Keys this tick: held, and the edges that fired on it. Edges fire on the first tick after the
/// input arrived, so a k-tick step never presses a key k times.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Keys {
    pub(crate) held: Vec<String>,
    pub(crate) pressed: Vec<String>,
    pub(crate) released: Vec<String>,
}

/// The mouse buttons among the keys: a HUD widget's keyboard focus never takes them from the game.
const MOUSE_BUTTONS: [Key; 3] = [Key::Mouse1, Key::Mouse2, Key::Mouse3];

impl Keys {
    /// These keys with only the mouse buttons left: what the update hooks see while a HUD widget
    /// holds the keyboard ([`genex_hud::keys_taken`]).
    pub(crate) fn mouse_buttons_only(&self) -> Keys {
        let mouse = |list: &[String]| -> Vec<String> {
            list.iter().filter(|code| MOUSE_BUTTONS.iter().any(|button| button.code() == code.as_str())).cloned().collect()
        };
        Keys { held: mouse(&self.held), pressed: mouse(&self.pressed), released: mouse(&self.released) }
    }

    /// Whether `key` is held.
    pub fn down(&self, key: Key) -> bool {
        self.down_code(key.code())
    }

    /// Whether `key` went down on this tick.
    pub fn pressed(&self, key: Key) -> bool {
        self.pressed_code(key.code())
    }

    /// Whether `key` went up on this tick.
    pub fn released(&self, key: Key) -> bool {
        self.released.iter().any(|k| k == key.code())
    }

    /// Whether the key with this DOM code is held (for codes [`Key`] does not name).
    pub fn down_code(&self, code: &str) -> bool {
        self.held.iter().any(|k| k == code)
    }

    /// Whether the key with this DOM code went down on this tick.
    pub fn pressed_code(&self, code: &str) -> bool {
        self.pressed.iter().any(|k| k == code)
    }

    /// Held keys, canonical and sorted.
    pub fn held(&self) -> &[String] {
        &self.held
    }
}

/// Where a touch is in its life on this tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    /// It went down on this tick.
    Began,
    /// It is down.
    Held,
    /// It went up on this tick.
    Ended,
    /// It went down and up before this tick (a tap).
    Tapped,
}

/// One touch, in world pixels (y down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    /// Stable while the finger is down; desktop's Mouse1 emulation is touch 0.
    pub id: u32,
    /// World position.
    pub position: Vec2,
    /// Its phase on this tick.
    pub phase: TouchPhase,
}

/// The touches of one tick.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Touches {
    pub(crate) list: Vec<Touch>,
}

impl Touches {
    /// Every touch this tick.
    pub fn all(&self) -> &[Touch] {
        &self.list
    }

    /// Whether any touch was tapped (down and up) or ended on this tick.
    pub fn tapped(&self) -> bool {
        self.list.iter().any(|t| matches!(t.phase, TouchPhase::Tapped | TouchPhase::Ended))
    }

    /// Whether any touch began on this tick.
    pub fn began(&self) -> bool {
        self.list.iter().any(|t| matches!(t.phase, TouchPhase::Began | TouchPhase::Tapped))
    }
}

/// Up to four gamepads in the standard mapping, merged from real and injected pad state by
/// genex-core (`input` verb `pads`, `gamepad` actions). A Studio run reads only the host's input.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pads {
    core: genex_core::input::Pads,
}

/// A pad, button or axis index as genex-core's tables take it; anything past them reads as absent.
fn index(value: usize) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

impl Pads {
    pub(crate) fn from_core(core: genex_core::input::Pads) -> Pads {
        Pads { core }
    }

    /// Whether pad `index` is connected.
    pub fn connected(&self, pad: usize) -> bool {
        self.core.connected(index(pad))
    }

    /// Connected pads.
    pub fn count(&self) -> u32 {
        self.core.count()
    }

    /// Whether `button` (standard mapping) is down on pad `pad`.
    pub fn down(&self, pad: usize, button: usize) -> bool {
        self.core.down(index(pad), index(button))
    }

    /// Whether `button` went down on this tick.
    pub fn pressed(&self, pad: usize, button: usize) -> bool {
        self.core.pressed(index(pad), index(button))
    }

    /// Whether `button` went up on this tick.
    pub fn released(&self, pad: usize, button: usize) -> bool {
        self.core.released(index(pad), index(button))
    }

    /// A button's analog value in `[0, 1]`, 0 when absent.
    pub fn value(&self, pad: usize, button: usize) -> f32 {
        self.core.value(index(pad), index(button))
    }

    /// An axis in `[-1, 1]`, 0 when absent.
    pub fn axis(&self, pad: usize, axis: usize) -> f32 {
        self.core.axis(index(pad), index(axis))
    }
}

/// The seeded rng as an update hook sees it: shared through `&Ctx`, advanced on every draw.
#[derive(Debug)]
pub struct CtxRng<'a> {
    cell: &'a Cell<Pcg32>,
}

impl<'a> CtxRng<'a> {
    pub(crate) fn new(cell: &'a Cell<Pcg32>) -> CtxRng<'a> {
        CtxRng { cell }
    }

    fn with<T>(&self, draw: impl FnOnce(&mut Pcg32) -> T) -> T {
        let mut rng = self.cell.get();
        let value = draw(&mut rng);
        self.cell.set(rng);
        value
    }

    /// The next 32 random bits.
    pub fn next_u32(&self) -> u32 {
        self.with(Pcg32::next_u32)
    }

    /// Uniform in `[0, bound)`; 0 when `bound` is 0.
    pub fn below(&self, bound: u32) -> u32 {
        self.with(|rng| rng.below(bound))
    }

    /// Uniform in `[lo, hi]`.
    pub fn range_i32(&self, lo: i32, hi: i32) -> i32 {
        self.with(|rng| rng.range_i32(lo, hi))
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&self) -> f32 {
        self.with(Pcg32::unit)
    }

    /// Uniform in `[lo, hi)`.
    pub fn range_f32(&self, lo: f32, hi: f32) -> f32 {
        self.with(|rng| rng.range_f32(lo, hi))
    }

    /// True with probability `p`.
    pub fn chance(&self, p: f32) -> bool {
        self.with(|rng| rng.chance(p))
    }
}

/// One tick's context.
#[derive(Debug)]
pub struct Ctx<'a> {
    /// Keys and mouse buttons.
    pub keys: &'a Keys,
    /// Touches in world pixels; desktop emulates touch 0 from Mouse1.
    pub touches: &'a Touches,
    /// Gamepads.
    pub pads: &'a Pads,
    /// Cursor position as a fraction of the frame, y down.
    pub pointer: Vec2,
    /// Mouse movement since the last tick, in pixels (locked pointer or injected).
    pub look: Vec2,
    /// Wheel movement since the last tick.
    pub wheel: Vec2,
    /// Whether the pointer is locked.
    pub pointer_lock: bool,
    /// Text committed this tick (UTF-8), often empty.
    pub text: &'a str,
    /// The only randomness a simulation may use.
    pub rng: CtxRng<'a>,
    /// The fixed tick, in seconds (1/60).
    pub dt: f32,
    /// Ticks since the last seed, before this one.
    pub tick: u64,
    /// The world target size in pixels.
    pub world_size: [u32; 2],
    /// The game's save folder.
    pub saves: &'a Saves,
    /// The tick's evaluated input actions (`game.input`): `ctx.actions.pressed(JUMP)`. Without
    /// `game.input` every action reads false.
    pub actions: &'a crate::actions::Actions,
    /// What the tick's hooks play through (G6 contract stub until AU-7 makes it game API).
    #[expect(dead_code, reason = "AU-7 makes ctx.audio game API")]
    pub(crate) audio: crate::audio::CtxAudio<'a>,
    /// The save slots as of this tick's start (`game.saves`).
    pub(crate) slots: crate::saves::Slots<'a>,
}

impl Ctx<'_> {
    /// Save `bytes` as `file` in the game's save folder (a safe relative name; folders are made);
    /// false, with nothing written, otherwise. Synchronous, as `studio::save` is.
    pub fn save(&self, file: &str, bytes: &[u8]) -> bool {
        self.saves.save(file, bytes)
    }

    /// The bytes saved as `file`, or None.
    pub fn load(&self, file: &str) -> Option<Vec<u8>> {
        self.saves.load(file)
    }

    /// The save slots (`game.saves`): list them, and queue a save (written after this tick), a
    /// load (restored before the next one) or a delete.
    pub fn slots(&self) -> crate::saves::Slots<'_> {
        self.slots
    }
}
