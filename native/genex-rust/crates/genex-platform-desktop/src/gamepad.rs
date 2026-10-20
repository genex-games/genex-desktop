//! Gamepads on desktop exports: gilrs mapped onto the standard order (the W3C "standard" gamepad
//! layout genex-core's `PadButton`/`PadAxis` name). A Studio run never opens gilrs: its pads come
//! only from the host's `input` op, so a pad on the person's desk cannot change a judged run, and
//! a headless run has no pads at all.
//!
//! Each slot also carries the pad's family (which face labels it wears), named by its USB vendor
//! and product ids through genex-core's SDL table when gilrs reports them. The family is
//! display-only: it never changes a reading.

use crate::mode::ShellMode;
use genex_core::input::{MAX_PADS, PadAxis, PadButton, PadState, PadStates};
use genex_core::pad_family::{PadFamily, pad_family};
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

    /// Whether the pad gilrs calls `gamepad` holds a slot.
    fn holds(&self, gamepad: usize) -> bool {
        self.owners.contains(&Some(gamepad))
    }

    /// Name the family of the pad gilrs calls `gamepad` from its USB ids. A pad without a slot
    /// takes none; ids the platform does not report, or the table does not know, leave it Generic.
    pub fn identify(&mut self, gamepad: usize, vendor: Option<u16>, product: Option<u16>) {
        let Some(held) = self.owners.iter().position(|owner| *owner == Some(gamepad)) else { return };
        let family = match (vendor, product) {
            (Some(vendor), Some(product)) => pad_family(vendor, product),
            _ => PadFamily::Generic,
        };
        self.states[held].family = family;
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
                let Some(pad_event) = PadEvent::from_gilrs(event.event) else { continue };
                let gamepad = usize::from(event.id);
                let seen = self.slots.holds(gamepad);
                self.slots.apply(gamepad, pad_event);
                // A pad's ids are read once, when it takes its slot.
                if !seen && let Some(pad) = gilrs.connected_gamepad(event.id) {
                    self.slots.identify(gamepad, pad.vendor_id(), pad.product_id());
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

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::pad_family::PadFamily;

    #[test]
    fn a_connected_pad_takes_the_family_its_usb_ids_name() {
        let mut slots = PadSlots::default();
        slots.apply(40, PadEvent::Connected);
        slots.identify(40, Some(0x054c), Some(0x0ce6));
        assert_eq!(slots.states()[0].family, PadFamily::PlayStation);
        slots.apply(41, PadEvent::Connected);
        slots.identify(41, Some(0x045e), Some(0x0b13));
        assert_eq!(slots.states()[1].family, PadFamily::Xbox);
    }

    #[test]
    fn unknown_or_missing_ids_and_pads_without_a_slot_stay_generic() {
        let mut slots = PadSlots::default();
        slots.apply(1, PadEvent::Connected);
        slots.identify(1, None, Some(0x0ce6));
        slots.identify(1, Some(0x1234), Some(0x5678));
        assert_eq!(slots.states()[0].family, PadFamily::Generic);
        slots.identify(99, Some(0x054c), Some(0x0ce6));
        assert!(slots.states().iter().skip(1).all(|pad| !pad.connected && pad.family == PadFamily::Generic), "no slot taken");
    }

    #[test]
    fn a_pad_that_leaves_frees_its_family_with_its_slot() {
        let mut slots = PadSlots::default();
        slots.apply(7, PadEvent::Connected);
        slots.identify(7, Some(0x057e), Some(0x2009));
        slots.apply(7, PadEvent::Disconnected);
        assert_eq!(slots.states()[0], PadState::default());
        slots.apply(8, PadEvent::Connected);
        assert_eq!(slots.states()[0].family, PadFamily::Generic, "the next pad starts generic");
    }

    #[test]
    fn a_family_never_changes_a_reading() {
        let mut named = PadSlots::default();
        let mut plain = PadSlots::default();
        for slots in [&mut named, &mut plain] {
            slots.apply(3, PadEvent::Button(Button::South, 1.0));
            slots.apply(3, PadEvent::Axis(Axis::LeftStickY, 0.5));
        }
        named.identify(3, Some(0x28de), Some(0x1205));
        let (a, b) = (named.states()[0], plain.states()[0]);
        assert_eq!(a.family, PadFamily::Steam);
        assert_eq!((a.connected, a.buttons, a.axes), (b.connected, b.buttons, b.axes));
    }

    #[test]
    fn studio_and_headless_runs_read_no_pads_and_no_family() {
        let mut pads = Gamepads::open(GamepadPolicy::for_run(ShellMode::Windowed, true));
        assert!(!pads.is_open());
        assert_eq!(pads.poll(), PadStates::default());
        let mut headless = Gamepads::open(GamepadPolicy::for_run(ShellMode::Headless, false));
        assert_eq!(headless.poll(), PadStates::default());
    }
}
