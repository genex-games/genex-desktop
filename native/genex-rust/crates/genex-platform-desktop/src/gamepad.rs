//! Gamepads on desktop exports: gilrs mapped onto the standard order (the W3C "standard" gamepad
//! layout genex-core's `PadButton`/`PadAxis` name). A Studio run never opens gilrs: its pads come
//! only from the host's `input` op, so a pad on the person's desk cannot change a judged run, and
//! a headless run has no pads at all.

use crate::mode::ShellMode;
use genex_core::input::{MAX_PADS, PadAxis, PadButton, PadState, PadStates};
use gilrs::{Axis, Button, EventType};

/// A d-pad reported as an axis presses its direction past this much.
const DPAD_AXIS_THRESHOLD: f32 = 0.5;

/// Whether a run reads real gamepads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum GamepadPolicy {
    /// No gilrs: Studio runs, headless runs, and anything that did not ask.
    #[default]
    Off,
    /// gilrs, mapped onto the standard order (desktop exports).
    Gilrs,
}

impl GamepadPolicy {
    /// Real pads only for a windowed run outside Studio.
    pub const fn for_run(mode: ShellMode, studio: bool) -> GamepadPolicy {
        match (mode, studio) {
            (ShellMode::Windowed, false) => GamepadPolicy::Gilrs,
            _ => GamepadPolicy::Off,
        }
    }

    /// The policy's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            GamepadPolicy::Off => "off",
            GamepadPolicy::Gilrs => "gilrs",
        }
    }
}

const fn slot(index: i32) -> Option<usize> {
    Some(index as usize)
}

/// The standard-order button a gilrs button is, if any (`C`, `Z` and unknown buttons are none).
pub const fn standard_button(button: Button) -> Option<usize> {
    match button {
        Button::South => slot(PadButton::A),
        Button::East => slot(PadButton::B),
        Button::West => slot(PadButton::X),
        Button::North => slot(PadButton::Y),
        Button::LeftTrigger => slot(PadButton::LEFT_BUMPER),
        Button::RightTrigger => slot(PadButton::RIGHT_BUMPER),
        Button::LeftTrigger2 => slot(PadButton::LEFT_TRIGGER),
        Button::RightTrigger2 => slot(PadButton::RIGHT_TRIGGER),
        Button::Select => slot(PadButton::BACK),
        Button::Start => slot(PadButton::START),
        Button::LeftThumb => slot(PadButton::LEFT_STICK),
        Button::RightThumb => slot(PadButton::RIGHT_STICK),
        Button::DPadUp => slot(PadButton::UP),
        Button::DPadDown => slot(PadButton::DOWN),
        Button::DPadLeft => slot(PadButton::LEFT),
        Button::DPadRight => slot(PadButton::RIGHT),
        Button::Mode => slot(PadButton::HOME),
        Button::C | Button::Z | Button::Unknown => None,
    }
}

/// The standard-order axis a gilrs axis is, with the sign that turns gilrs' direction into the
/// standard's (gilrs' y points up, the standard's down). The d-pad axes drive buttons instead
/// ([`PadSlots::apply`]); `LeftZ`, `RightZ` and unknown axes are none.
pub const fn standard_axis(axis: Axis) -> Option<(usize, f32)> {
    let (index, sign) = match axis {
        Axis::LeftStickX => (PadAxis::LEFT_X, 1.0),
        Axis::LeftStickY => (PadAxis::LEFT_Y, -1.0),
        Axis::RightStickX => (PadAxis::RIGHT_X, 1.0),
        Axis::RightStickY => (PadAxis::RIGHT_Y, -1.0),
        Axis::LeftZ | Axis::RightZ | Axis::DPadX | Axis::DPadY | Axis::Unknown => return None,
    };
    Some((index as usize, sign))
}

/// What happened to one pad, in the shell's terms (gilrs' event without its platform codes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PadEvent {
    /// The pad appeared.
    Connected,
    /// The pad went away.
    Disconnected,
    /// A button's value, 0 to 1.
    Button(Button, f32),
    /// An axis's value, -1 to 1 in gilrs' direction.
    Axis(Axis, f32),
}

impl PadEvent {
    /// The shell's view of a gilrs event, if it changes a pad.
    pub fn from_gilrs(event: EventType) -> Option<PadEvent> {
        Some(match event {
            EventType::Connected => PadEvent::Connected,
            EventType::Disconnected => PadEvent::Disconnected,
            EventType::ButtonPressed(button, _) => PadEvent::Button(button, 1.0),
            EventType::ButtonReleased(button, _) => PadEvent::Button(button, 0.0),
            EventType::ButtonChanged(button, value, _) => PadEvent::Button(button, value),
            EventType::AxisChanged(axis, value, _) => PadEvent::Axis(axis, value),
            _ => return None,
        })
    }
}

/// A finite value inside `lo..=hi`; anything else reads as rest (0).
fn bounded(value: f32, lo: f32, hi: f32) -> f32 {
    if value.is_finite() { value.clamp(lo, hi) } else { 0.0 }
}

/// Pads in their slots, in the order they first showed up; a slot frees when its pad leaves.
#[derive(Clone, Debug, Default)]
pub struct PadSlots {
    owners: [Option<usize>; MAX_PADS],
    states: PadStates,
}

impl PadSlots {
    /// The slot `gamepad` holds, taking the first free one for a pad not seen yet; none when every
    /// slot is taken.
    fn slot_of(&mut self, gamepad: usize) -> Option<usize> {
        if let Some(held) = self.owners.iter().position(|owner| *owner == Some(gamepad)) {
            return Some(held);
        }
        let free = self.owners.iter().position(Option::is_none)?;
        self.owners[free] = Some(gamepad);
        self.states[free] = PadState { connected: true, ..PadState::default() };
        Some(free)
    }

    /// Apply one event from the pad gilrs calls `gamepad`.
    pub fn apply(&mut self, gamepad: usize, event: PadEvent) {
        if event == PadEvent::Disconnected {
            if let Some(held) = self.owners.iter().position(|owner| *owner == Some(gamepad)) {
                self.owners[held] = None;
                self.states[held] = PadState::default();
            }
            return;
        }
        let Some(index) = self.slot_of(gamepad) else { return };
        let pad = &mut self.states[index];
        match event {
            PadEvent::Button(button, value) => {
                if let Some(button) = standard_button(button) {
                    pad.buttons[button] = bounded(value, 0.0, 1.0);
                }
            }
            PadEvent::Axis(Axis::DPadX, value) => dpad(pad, value, PadButton::RIGHT, PadButton::LEFT),
            PadEvent::Axis(Axis::DPadY, value) => dpad(pad, value, PadButton::UP, PadButton::DOWN),
            PadEvent::Axis(axis, value) => {
                if let Some((axis, sign)) = standard_axis(axis) {
                    pad.axes[axis] = bounded(value, -1.0, 1.0) * sign;
                }
            }
            PadEvent::Connected | PadEvent::Disconnected => {}
        }
    }

    /// Every slot's state.
    pub fn states(&self) -> PadStates {
        self.states
    }
}

/// A d-pad axis in gilrs' direction: past the threshold on the positive side presses `positive`.
fn dpad(pad: &mut PadState, value: f32, positive: i32, negative: i32) {
    let value = bounded(value, -1.0, 1.0);
    pad.buttons[positive as usize] = f32::from(u8::from(value > DPAD_AXIS_THRESHOLD));
    pad.buttons[negative as usize] = f32::from(u8::from(value < -DPAD_AXIS_THRESHOLD));
}

/// The run's gamepads: gilrs when the policy allows it and it opens, nothing otherwise.
pub struct Gamepads {
    gilrs: Option<gilrs::Gilrs>,
    slots: PadSlots,
}

impl Gamepads {
    /// Open gamepads under `policy`; gilrs failing to start leaves the run without pads.
    pub fn open(policy: GamepadPolicy) -> Gamepads {
        let gilrs = match policy {
            GamepadPolicy::Off => None,
            GamepadPolicy::Gilrs => gilrs::Gilrs::new()
                .inspect_err(|error| log::warn!("genex-platform-desktop: no gamepads: {error}"))
                .ok(),
        };
        Gamepads { gilrs, slots: PadSlots::default() }
    }

    /// Whether gilrs is open.
    pub fn is_open(&self) -> bool {
        self.gilrs.is_some()
    }

    /// Drain gilrs' events and answer every slot's state.
    pub fn poll(&mut self) -> PadStates {
        if let Some(gilrs) = self.gilrs.as_mut() {
            while let Some(event) = gilrs.next_event() {
                if let Some(pad_event) = PadEvent::from_gilrs(event.event) {
                    self.slots.apply(usize::from(event.id), pad_event);
                }
            }
        }
        self.slots.states()
    }
}

impl std::fmt::Debug for Gamepads {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gamepads").field("open", &self.is_open()).field("slots", &self.slots).finish()
    }
}
