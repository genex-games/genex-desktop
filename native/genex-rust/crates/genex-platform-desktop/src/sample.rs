//! Real input sampled once per displayed frame into the protocol's shape: held keys by DOM
//! `code`, taps faster than a frame, pointer as a fraction of the world frame, look, wheel and
//! committed text. A port of the C++ runtime's `sampleInput` (`platform.cpp`); the merger, not
//! the shell, turns `held` changes into edges. Mouse1 also drives one emulated touch
//! ([`crate::touch`]), and the windowed loop fills `pads` from gilrs on exports only.

use crate::letterbox::Letterbox;
use crate::touch::{MouseTouch, SampledTouch};
use genex_core::input::PadStates;
use std::collections::BTreeSet;
use winit::event::{ElementState, MouseButton, MouseScrollDelta};
use winit::keyboard::KeyCode;

/// One wheel notch, in pixels (the C++ runtime's `WHEEL_PIXELS_PER_NOTCH`).
pub const WHEEL_PIXELS_PER_NOTCH: f32 = 100.0;
/// The most committed text one frame carries, in characters.
pub const MAX_TEXT_CHARS: usize = 256;
/// Where the pointer is before the cursor ever moved: the frame's centre.
const POINTER_CENTRE: [f32; 2] = [0.5, 0.5];

/// winit's physical keys the protocol names, with their DOM `code` (the facade's `Key` table).
const KEYS: [(KeyCode, &str); 80] = [
    (KeyCode::KeyA, "KeyA"), (KeyCode::KeyB, "KeyB"), (KeyCode::KeyC, "KeyC"), (KeyCode::KeyD, "KeyD"),
    (KeyCode::KeyE, "KeyE"), (KeyCode::KeyF, "KeyF"), (KeyCode::KeyG, "KeyG"), (KeyCode::KeyH, "KeyH"),
    (KeyCode::KeyI, "KeyI"), (KeyCode::KeyJ, "KeyJ"), (KeyCode::KeyK, "KeyK"), (KeyCode::KeyL, "KeyL"),
    (KeyCode::KeyM, "KeyM"), (KeyCode::KeyN, "KeyN"), (KeyCode::KeyO, "KeyO"), (KeyCode::KeyP, "KeyP"),
    (KeyCode::KeyQ, "KeyQ"), (KeyCode::KeyR, "KeyR"), (KeyCode::KeyS, "KeyS"), (KeyCode::KeyT, "KeyT"),
    (KeyCode::KeyU, "KeyU"), (KeyCode::KeyV, "KeyV"), (KeyCode::KeyW, "KeyW"), (KeyCode::KeyX, "KeyX"),
    (KeyCode::KeyY, "KeyY"), (KeyCode::KeyZ, "KeyZ"),
    (KeyCode::Digit0, "Digit0"), (KeyCode::Digit1, "Digit1"), (KeyCode::Digit2, "Digit2"),
    (KeyCode::Digit3, "Digit3"), (KeyCode::Digit4, "Digit4"), (KeyCode::Digit5, "Digit5"),
    (KeyCode::Digit6, "Digit6"), (KeyCode::Digit7, "Digit7"), (KeyCode::Digit8, "Digit8"),
    (KeyCode::Digit9, "Digit9"),
    (KeyCode::Space, "Space"), (KeyCode::Enter, "Enter"), (KeyCode::Escape, "Escape"), (KeyCode::Tab, "Tab"),
    (KeyCode::Backspace, "Backspace"),
    (KeyCode::ArrowUp, "ArrowUp"), (KeyCode::ArrowDown, "ArrowDown"), (KeyCode::ArrowLeft, "ArrowLeft"),
    (KeyCode::ArrowRight, "ArrowRight"),
    (KeyCode::ShiftLeft, "ShiftLeft"), (KeyCode::ShiftRight, "ShiftRight"),
    (KeyCode::ControlLeft, "ControlLeft"), (KeyCode::ControlRight, "ControlRight"),
    (KeyCode::AltLeft, "AltLeft"), (KeyCode::AltRight, "AltRight"),
    (KeyCode::Minus, "Minus"), (KeyCode::Equal, "Equal"), (KeyCode::Comma, "Comma"), (KeyCode::Period, "Period"),
    (KeyCode::Slash, "Slash"), (KeyCode::Semicolon, "Semicolon"), (KeyCode::Quote, "Quote"),
    (KeyCode::BracketLeft, "BracketLeft"), (KeyCode::BracketRight, "BracketRight"),
    (KeyCode::Backquote, "Backquote"), (KeyCode::Backslash, "Backslash"),
    (KeyCode::F1, "F1"), (KeyCode::F2, "F2"), (KeyCode::F3, "F3"), (KeyCode::F4, "F4"), (KeyCode::F5, "F5"),
    (KeyCode::F6, "F6"), (KeyCode::F7, "F7"), (KeyCode::F8, "F8"), (KeyCode::F9, "F9"), (KeyCode::F10, "F10"),
    (KeyCode::F11, "F11"), (KeyCode::F12, "F12"),
    (KeyCode::Delete, "Delete"), (KeyCode::Home, "Home"), (KeyCode::End, "End"), (KeyCode::PageUp, "PageUp"),
    (KeyCode::PageDown, "PageDown"), (KeyCode::Insert, "Insert"),
];

/// Mouse buttons the protocol names.
const MOUSE_BUTTONS: [(MouseButton, &str); 3] =
    [(MouseButton::Left, "Mouse1"), (MouseButton::Right, "Mouse2"), (MouseButton::Middle, "Mouse3")];

/// The DOM `code` the protocol uses for a physical key, if it names one.
pub fn key_name(code: KeyCode) -> Option<&'static str> {
    KEYS.iter().find(|(key, _)| *key == code).map(|(_, name)| *name)
}

fn button_name(button: MouseButton) -> Option<&'static str> {
    MOUSE_BUTTONS.iter().find(|(b, _)| *b == button).map(|(_, name)| *name)
}

/// One frame's real input, in the protocol's shape.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameSample {
    /// Keys and mouse buttons down when the frame was sampled, sorted.
    pub held: Vec<String>,
    /// Keys pressed and released within the frame (a tap faster than a frame), sorted.
    pub pressed: Vec<String>,
    /// The same taps: every pressed entry was also released.
    pub released: Vec<String>,
    /// Raw mouse movement this frame, in pixels; it counts as look only under pointer lock.
    pub look: [f32; 2],
    /// Wheel movement this frame, in pixels (y down, as the DOM reports it).
    pub wheel: [f32; 2],
    /// The pointer as a fraction of the world frame.
    pub pointer: [f32; 2],
    /// Whether the pointer is locked (the game asked and the window granted it).
    pub pointer_lock: bool,
    /// Text committed this frame.
    pub text: String,
    /// The touch Mouse1 emulates: this frame's steps, in order.
    pub touches: Vec<SampledTouch>,
    /// Real gamepads in the standard order; all disconnected unless gilrs is on (exports).
    pub pads: PadStates,
}

impl Default for FrameSample {
    fn default() -> FrameSample {
        FrameSample {
            held: Vec::new(),
            pressed: Vec::new(),
            released: Vec::new(),
            look: [0.0, 0.0],
            wheel: [0.0, 0.0],
            pointer: POINTER_CENTRE,
            pointer_lock: false,
            text: String::new(),
            touches: Vec::new(),
            pads: PadStates::default(),
        }
    }
}

/// Collects winit's input events between frames.
#[derive(Clone, Debug)]
pub struct InputSampler {
    held: BTreeSet<&'static str>,
    went_down: BTreeSet<&'static str>,
    tapped: BTreeSet<&'static str>,
    cursor: Option<[f32; 2]>,
    pointer: [f32; 2],
    look: [f32; 2],
    wheel: [f32; 2],
    text: String,
    touch: MouseTouch,
    pointer_lock: bool,
}

impl Default for InputSampler {
    fn default() -> InputSampler {
        InputSampler {
            held: BTreeSet::new(),
            went_down: BTreeSet::new(),
            tapped: BTreeSet::new(),
            cursor: None,
            pointer: POINTER_CENTRE,
            look: [0.0, 0.0],
            wheel: [0.0, 0.0],
            text: String::new(),
            touch: MouseTouch::default(),
            pointer_lock: false,
        }
    }
}

impl InputSampler {
    /// A physical key changed; keys the protocol does not name are ignored.
    pub fn key(&mut self, code: KeyCode, state: ElementState) {
        if let Some(name) = key_name(code) {
            self.button(name, state);
        }
    }

    /// A mouse button changed; buttons past the third are ignored. Mouse1 also drives the
    /// emulated touch.
    pub fn mouse_button(&mut self, button: MouseButton, state: ElementState) {
        if button == MouseButton::Left {
            match state {
                ElementState::Pressed => self.touch.press(self.cursor),
                ElementState::Released => self.touch.release(self.cursor),
            }
        }
        if let Some(name) = button_name(button) {
            self.button(name, state);
        }
    }

    fn button(&mut self, name: &'static str, state: ElementState) {
        match state {
            ElementState::Pressed => {
                if self.held.insert(name) {
                    self.went_down.insert(name);
                }
            }
            ElementState::Released => {
                if self.held.remove(name) && self.went_down.contains(name) {
                    self.tapped.insert(name);
                }
            }
        }
    }

    /// The window lost focus: nothing stays held (its key-up events go elsewhere), the emulated
    /// touch ends where the cursor last was, and the pointer lock is gone.
    pub fn focus_lost(&mut self) {
        self.held.clear();
        self.went_down.clear();
        self.touch.release(self.cursor);
        self.pointer_lock = false;
    }

    /// The cursor moved to this window position, in physical pixels.
    pub fn cursor_moved(&mut self, position: [f32; 2]) {
        self.cursor = Some(position);
        self.touch.cursor_moved(position);
    }

    /// Whether the window holds the pointer locked now (the windowed loop reports what the
    /// window granted, not what the game asked for).
    pub fn set_pointer_lock(&mut self, locked: bool) {
        self.pointer_lock = locked;
    }

    /// Raw mouse motion, in pixels.
    pub fn mouse_motion(&mut self, delta: [f32; 2]) {
        if delta.iter().all(|d| d.is_finite()) {
            self.look = [self.look[0] + delta[0], self.look[1] + delta[1]];
        }
    }

    /// Wheel movement: lines count [`WHEEL_PIXELS_PER_NOTCH`] each; y is flipped to the DOM's
    /// direction, as the C++ runtime does.
    pub fn wheel(&mut self, delta: MouseScrollDelta) {
        let [x, y] = match delta {
            MouseScrollDelta::LineDelta(x, y) => [x * WHEEL_PIXELS_PER_NOTCH, -y * WHEEL_PIXELS_PER_NOTCH],
            MouseScrollDelta::PixelDelta(position) => [position.x as f32, -(position.y as f32)],
        };
        if x.is_finite() && y.is_finite() {
            self.wheel = [self.wheel[0] + x, self.wheel[1] + y];
        }
    }

    /// Committed text; control characters are dropped and a frame keeps at most
    /// [`MAX_TEXT_CHARS`] characters.
    pub fn text(&mut self, text: &str) {
        let room = MAX_TEXT_CHARS.saturating_sub(self.text.chars().count());
        self.text.extend(text.chars().filter(|c| !c.is_control()).take(room));
    }

    /// The frame's sample, with the pointer mapped through `letterbox`; edges and deltas restart.
    pub fn take(&mut self, letterbox: Letterbox) -> FrameSample {
        if let Some(cursor) = self.cursor {
            self.pointer = letterbox.fraction(cursor);
        }
        let taps: Vec<String> = self.tapped.difference(&self.held).map(|k| (*k).to_owned()).collect();
        let sample = FrameSample {
            held: self.held.iter().map(|k| (*k).to_owned()).collect(),
            pressed: taps.clone(),
            released: taps,
            look: self.look,
            wheel: self.wheel,
            pointer: self.pointer,
            pointer_lock: self.pointer_lock,
            text: std::mem::take(&mut self.text),
            touches: self.touch.take(letterbox, self.pointer),
            pads: PadStates::default(),
        };
        self.went_down.clear();
        self.tapped.clear();
        self.look = [0.0, 0.0];
        self.wheel = [0.0, 0.0];
        sample
    }
}
