//! Gamepads on a phone, mapped onto the standard order (the W3C "standard" gamepad layout
//! genex-core's `PadButton`/`PadAxis` name, the order desktop exports map gilrs to).
//!
//! Both phones name the same controller elements: iOS's `GCExtendedGamepad` (`buttonA`,
//! `leftShoulder`, `dpad`, ...) and Android's `KEYCODE_BUTTON_*` keys and `AXIS_*` motion axes.
//! Each platform crate turns its own events into [`PadChange`]s on a [`PhoneButton`] or
//! [`PhoneAxis`] (its table lives beside its platform code); everything after that is one copy:
//! [`PhoneButton::standard`] and [`PhoneAxis::target`] place an element in the standard order, and
//! [`PhonePads`] keeps up to [`MAX_PADS`] controllers in slots, in the order they showed up, and
//! answers the facade input that carries the slots that changed.
//!
//! A phone run is never a Studio run (Studio runs the desktop or web build), so real pads are
//! always read here; injected pads (a demo's `inject`) still merge over them in genex-core.
//!
//! A [`PadChange::Family`] names a slot's family (which face labels the controller wears: iOS's
//! `productCategory`, Android's `InputDevice` vendor and product ids). It is display-only and never
//! changes a reading.

use genex::Input;
use genex_core::input::{Injection, MAX_PADS, PadAxis, PadButton, PadState, PadStates};
use genex_core::pad_family::PadFamily;
use std::hash::{DefaultHasher, Hash, Hasher};

/// A d-pad reported as a hat axis presses its direction past this much.
pub const HAT_THRESHOLD: f32 = 0.5;

/// A controller button both phones name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhoneButton {
    /// Bottom face button (`buttonA`, `KEYCODE_BUTTON_A`).
    A,
    /// Right face button.
    B,
    /// Left face button.
    X,
    /// Top face button.
    Y,
    /// Left shoulder (`leftShoulder`, `KEYCODE_BUTTON_L1`).
    LeftShoulder,
    /// Right shoulder.
    RightShoulder,
    /// Left trigger (`leftTrigger`, `KEYCODE_BUTTON_L2`; analog on most pads).
    LeftTrigger,
    /// Right trigger.
    RightTrigger,
    /// Options / select / back (`buttonOptions`, `KEYCODE_BUTTON_SELECT`).
    Options,
    /// Menu / start (`buttonMenu`, `KEYCODE_BUTTON_START`).
    Menu,
    /// Left stick press (`leftThumbstickButton`, `KEYCODE_BUTTON_THUMBL`).
    LeftThumb,
    /// Right stick press.
    RightThumb,
    /// D-pad up.
    DpadUp,
    /// D-pad down.
    DpadDown,
    /// D-pad left.
    DpadLeft,
    /// D-pad right.
    DpadRight,
    /// Home / guide (`buttonHome`, `KEYCODE_BUTTON_MODE`).
    Home,
}

impl PhoneButton {
    /// Every button, in standard order.
    pub const ALL: [PhoneButton; 17] = [
        PhoneButton::A,
        PhoneButton::B,
        PhoneButton::X,
        PhoneButton::Y,
        PhoneButton::LeftShoulder,
        PhoneButton::RightShoulder,
        PhoneButton::LeftTrigger,
        PhoneButton::RightTrigger,
        PhoneButton::Options,
        PhoneButton::Menu,
        PhoneButton::LeftThumb,
        PhoneButton::RightThumb,
        PhoneButton::DpadUp,
        PhoneButton::DpadDown,
        PhoneButton::DpadLeft,
        PhoneButton::DpadRight,
        PhoneButton::Home,
    ];

    /// The button's index in the standard order.
    pub const fn standard(self) -> usize {
        let index = match self {
            PhoneButton::A => PadButton::A,
            PhoneButton::B => PadButton::B,
            PhoneButton::X => PadButton::X,
            PhoneButton::Y => PadButton::Y,
            PhoneButton::LeftShoulder => PadButton::LEFT_BUMPER,
            PhoneButton::RightShoulder => PadButton::RIGHT_BUMPER,
            PhoneButton::LeftTrigger => PadButton::LEFT_TRIGGER,
            PhoneButton::RightTrigger => PadButton::RIGHT_TRIGGER,
            PhoneButton::Options => PadButton::BACK,
            PhoneButton::Menu => PadButton::START,
            PhoneButton::LeftThumb => PadButton::LEFT_STICK,
            PhoneButton::RightThumb => PadButton::RIGHT_STICK,
            PhoneButton::DpadUp => PadButton::UP,
            PhoneButton::DpadDown => PadButton::DOWN,
            PhoneButton::DpadLeft => PadButton::LEFT,
            PhoneButton::DpadRight => PadButton::RIGHT,
            PhoneButton::Home => PadButton::HOME,
        };
        index as usize
    }
}

/// A controller axis both phones name, its value already in the standard's direction: sticks -1
/// (left, up) to 1 (right, down), triggers 0 to 1, hats -1 to 1 like the sticks. The platform
/// tables flip a y axis that points up (GCController's, never Android's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PhoneAxis {
    /// Left stick, x.
    LeftX,
    /// Left stick, y.
    LeftY,
    /// Right stick, x.
    RightX,
    /// Right stick, y.
    RightY,
    /// Left trigger as an axis (`AXIS_LTRIGGER`, `AXIS_BRAKE`).
    LeftTrigger,
    /// Right trigger as an axis (`AXIS_RTRIGGER`, `AXIS_GAS`).
    RightTrigger,
    /// The d-pad as a hat, x (`AXIS_HAT_X`).
    HatX,
    /// The d-pad as a hat, y.
    HatY,
}

/// Where an axis lands in the standard order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxisTarget {
    /// A standard axis.
    Axis(usize),
    /// An analog standard button (a trigger).
    Button(usize),
    /// Two standard d-pad buttons: below `-HAT_THRESHOLD` presses `negative`, above it `positive`.
    Hat {
        /// Pressed by a negative value (left, up).
        negative: usize,
        /// Pressed by a positive value (right, down).
        positive: usize,
    },
}

impl PhoneAxis {
    /// Every axis.
    pub const ALL: [PhoneAxis; 8] = [
        PhoneAxis::LeftX,
        PhoneAxis::LeftY,
        PhoneAxis::RightX,
        PhoneAxis::RightY,
        PhoneAxis::LeftTrigger,
        PhoneAxis::RightTrigger,
        PhoneAxis::HatX,
        PhoneAxis::HatY,
    ];

    /// Where the axis lands in the standard order.
    pub const fn target(self) -> AxisTarget {
        match self {
            PhoneAxis::LeftX => AxisTarget::Axis(PadAxis::LEFT_X as usize),
            PhoneAxis::LeftY => AxisTarget::Axis(PadAxis::LEFT_Y as usize),
            PhoneAxis::RightX => AxisTarget::Axis(PadAxis::RIGHT_X as usize),
            PhoneAxis::RightY => AxisTarget::Axis(PadAxis::RIGHT_Y as usize),
            PhoneAxis::LeftTrigger => AxisTarget::Button(PadButton::LEFT_TRIGGER as usize),
            PhoneAxis::RightTrigger => AxisTarget::Button(PadButton::RIGHT_TRIGGER as usize),
            PhoneAxis::HatX => AxisTarget::Hat { negative: PadButton::LEFT as usize, positive: PadButton::RIGHT as usize },
            PhoneAxis::HatY => AxisTarget::Hat { negative: PadButton::UP as usize, positive: PadButton::DOWN as usize },
        }
    }
}

/// What happened to one controller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PadChange {
    /// It appeared.
    Connected,
    /// It went away.
    Disconnected,
    /// A button's value, 0 to 1.
    Button(PhoneButton, f32),
    /// An axis's value, in the standard's direction.
    Axis(PhoneAxis, f32),
    /// Its family, display-only.
    Family(PadFamily),
}

/// A finite value inside `lo..=hi`; anything else reads as rest (0).
fn bounded(value: f32, lo: f32, hi: f32) -> f32 {
    if value.is_finite() { value.clamp(lo, hi) } else { 0.0 }
}

/// The controller id a key event's device is: winit's opaque `DeviceId` (Android's `InputDevice`
/// id, so each controller's buttons keep a slot of their own), hashed to the `u64` the slots hold.
/// Ids are only compared, never shown or stored.
pub fn controller_id(device: &impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    device.hash(&mut hasher);
    hasher.finish()
}

/// Controllers in their slots, in the order they first showed up; a slot frees when its
/// controller leaves. The platform's ids are opaque (an object address on iOS, a device id on
/// Android).
#[derive(Clone, Debug, Default)]
pub struct PhonePads {
    owners: [Option<u64>; MAX_PADS],
    states: PadStates,
    changed: [bool; MAX_PADS],
}

impl PhonePads {
    /// The slot `pad` holds, taking the first free one for a controller not seen yet; none when
    /// every slot is taken (a fifth controller is ignored).
    fn slot_of(&mut self, pad: u64) -> Option<usize> {
        if let Some(held) = self.owners.iter().position(|owner| *owner == Some(pad)) {
            return Some(held);
        }
        let free = self.owners.iter().position(Option::is_none)?;
        self.owners[free] = Some(pad);
        self.states[free] = PadState { connected: true, ..PadState::default() };
        self.changed[free] = true;
        Some(free)
    }

    /// Apply one change from the controller the platform calls `pad`.
    pub fn apply(&mut self, pad: u64, change: PadChange) {
        if change == PadChange::Disconnected {
            if let Some(held) = self.owners.iter().position(|owner| *owner == Some(pad)) {
                self.owners[held] = None;
                self.states[held] = PadState::default();
                self.changed[held] = true;
            }
            return;
        }
        let Some(index) = self.slot_of(pad) else { return };
        let before = self.states[index];
        let state = &mut self.states[index];
        match change {
            PadChange::Button(button, value) => state.buttons[button.standard()] = bounded(value, 0.0, 1.0),
            PadChange::Axis(axis, value) => match axis.target() {
                AxisTarget::Axis(at) => state.axes[at] = bounded(value, -1.0, 1.0),
                AxisTarget::Button(at) => state.buttons[at] = bounded(value, 0.0, 1.0),
                AxisTarget::Hat { negative, positive } => {
                    let value = bounded(value, -1.0, 1.0);
                    state.buttons[negative] = f32::from(u8::from(value < -HAT_THRESHOLD));
                    state.buttons[positive] = f32::from(u8::from(value > HAT_THRESHOLD));
                }
            },
            PadChange::Family(family) => state.family = family,
            PadChange::Connected | PadChange::Disconnected => {}
        }
        if self.states[index] != before {
            self.changed[index] = true;
        }
    }

    /// Every slot's state.
    pub fn states(&self) -> PadStates {
        self.states
    }

    /// The facade input carrying every slot that changed since the last call (full states, as the
    /// `input` verb's `pads` carries them), or `None` when nothing changed.
    pub fn take_input(&mut self) -> Option<Input> {
        let pads: Vec<(usize, PadState)> =
            (0..MAX_PADS).filter(|slot| self.changed[*slot]).map(|slot| (slot, self.states[slot])).collect();
        if pads.is_empty() {
            return None;
        }
        self.changed = [false; MAX_PADS];
        Some(Input::from_injection(Injection { pads, ..Injection::default() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_core::input::{PAD_AXES, PAD_BUTTONS};

    #[test]
    fn every_standard_button_is_one_phone_button_exactly() {
        let mut seen = [0_u32; PAD_BUTTONS];
        for button in PhoneButton::ALL {
            seen[button.standard()] += 1;
        }
        assert_eq!(seen, [1; PAD_BUTTONS], "each standard index is reached once");
        assert_eq!(PhoneButton::A.standard(), PadButton::A as usize);
        assert_eq!(PhoneButton::Options.standard(), PadButton::BACK as usize);
        assert_eq!(PhoneButton::Menu.standard(), PadButton::START as usize);
        assert_eq!(PhoneButton::Home.standard(), PadButton::HOME as usize);
    }

    #[test]
    fn every_standard_axis_and_the_trigger_and_dpad_buttons_have_a_phone_axis() {
        let mut axes = [0_u32; PAD_AXES];
        let mut buttons = Vec::new();
        for axis in PhoneAxis::ALL {
            match axis.target() {
                AxisTarget::Axis(at) => axes[at] += 1,
                AxisTarget::Button(at) => buttons.push(at),
                AxisTarget::Hat { negative, positive } => buttons.extend([negative, positive]),
            }
        }
        assert_eq!(axes, [1; PAD_AXES]);
        buttons.sort_unstable();
        let expected = [PadButton::LEFT_TRIGGER, PadButton::RIGHT_TRIGGER, PadButton::UP, PadButton::DOWN, PadButton::LEFT, PadButton::RIGHT];
        let mut expected = expected.map(|at| at as usize);
        expected.sort_unstable();
        assert_eq!(buttons, expected);
        assert_eq!(PhoneAxis::HatY.target(), AxisTarget::Hat { negative: PadButton::UP as usize, positive: PadButton::DOWN as usize });
    }

    #[test]
    fn controllers_take_slots_in_arrival_order_and_a_fifth_is_ignored() {
        let mut pads = PhonePads::default();
        for pad in [70, 50, 90, 10, 30] {
            pads.apply(pad, PadChange::Button(PhoneButton::A, 1.0));
        }
        let states = pads.states();
        assert!(states.iter().all(|state| state.connected && state.buttons[PadButton::A as usize] == 1.0));
        pads.apply(50, PadChange::Disconnected);
        assert!(!pads.states()[1].connected, "the slot frees");
        pads.apply(30, PadChange::Connected);
        assert!(pads.states()[1].connected, "the waiting controller takes the free slot");
    }

    #[test]
    fn values_are_bounded_and_hats_press_the_dpad() {
        let mut pads = PhonePads::default();
        pads.apply(1, PadChange::Axis(PhoneAxis::LeftX, 3.0));
        pads.apply(1, PadChange::Axis(PhoneAxis::LeftY, f32::NAN));
        pads.apply(1, PadChange::Axis(PhoneAxis::RightTrigger, 0.25));
        pads.apply(1, PadChange::Button(PhoneButton::B, -2.0));
        pads.apply(1, PadChange::Axis(PhoneAxis::HatY, -1.0));
        let pad = pads.states()[0];
        assert_eq!(pad.axes[PadAxis::LEFT_X as usize], 1.0);
        assert_eq!(pad.axes[PadAxis::LEFT_Y as usize], 0.0);
        assert_eq!(pad.buttons[PadButton::RIGHT_TRIGGER as usize], 0.25);
        assert_eq!(pad.buttons[PadButton::B as usize], 0.0);
        assert_eq!(pad.buttons[PadButton::UP as usize], 1.0);
        assert_eq!(pad.buttons[PadButton::DOWN as usize], 0.0);
        pads.apply(1, PadChange::Axis(PhoneAxis::HatY, 0.0));
        assert_eq!(pads.states()[0].buttons[PadButton::UP as usize], 0.0, "the hat at rest lets go");
    }

    #[test]
    fn only_slots_that_changed_reach_the_game() {
        let mut pads = PhonePads::default();
        assert!(pads.take_input().is_none());
        pads.apply(7, PadChange::Button(PhoneButton::Y, 1.0));
        let input = pads.take_input().expect("a new controller");
        assert_eq!(input.injection().pads.len(), 1);
        assert_eq!(input.injection().pads[0].0, 0);
        pads.apply(7, PadChange::Button(PhoneButton::Y, 1.0));
        assert!(pads.take_input().is_none(), "the same value is no change");
        pads.apply(7, PadChange::Disconnected);
        let gone = pads.take_input().expect("a disconnect");
        assert_eq!(gone.injection().pads, vec![(0, PadState::default())]);
    }

    #[test]
    fn two_controllers_key_events_take_two_slots() {
        let (first, second) = (controller_id(&7_u32), controller_id(&8_u32));
        assert_ne!(first, second, "each device keeps its own id");
        assert_eq!(first, controller_id(&7_u32), "one device, one id");
        let mut pads = PhonePads::default();
        pads.apply(first, PadChange::Button(PhoneButton::A, 1.0));
        pads.apply(second, PadChange::Button(PhoneButton::B, 1.0));
        let states = pads.states();
        assert_eq!(states[0].buttons[PadButton::A as usize], 1.0);
        assert_eq!(states[1].buttons[PadButton::B as usize], 1.0);
        assert_eq!(states[0].buttons[PadButton::B as usize], 0.0, "the second pad's button stays in its own slot");
    }

    #[derive(Default)]
    struct Start {
        pressed: bool,
    }

    #[test]
    fn the_game_reads_a_phone_pad_through_the_merged_input() {
        let mut game = genex::Game::new(Start::default());
        game.on_update(|sim, ctx| sim.world.pressed |= ctx.pads.pressed(0, PadButton::START as usize));
        game.probe("start", |sim| genex::json!(sim.world.pressed));
        let mut runtime = genex::Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        let mut pads = PhonePads::default();
        pads.apply(42, PadChange::Button(PhoneButton::Menu, 1.0));
        runtime.inject(pads.take_input().expect("input"));
        runtime.step(genex::FIXED_STEP_MS);
        assert_eq!(runtime.probes()["start"], genex::json!(true));
    }
}

#[cfg(test)]
mod family_tests {
    use super::*;
    use genex_core::pad_family::PadFamily;

    #[test]
    fn a_family_change_names_the_slots_family_and_reaches_the_game() {
        let mut pads = PhonePads::default();
        pads.apply(9, PadChange::Connected);
        pads.take_input();
        pads.apply(9, PadChange::Family(PadFamily::PlayStation));
        assert_eq!(pads.states()[0].family, PadFamily::PlayStation);
        let input = pads.take_input().expect("a family change is a change");
        assert_eq!(input.injection().pads[0].1.family, PadFamily::PlayStation);
        pads.apply(9, PadChange::Family(PadFamily::PlayStation));
        assert!(pads.take_input().is_none(), "the same family is no change");
    }

    #[test]
    fn a_family_never_changes_a_reading_and_leaves_with_its_slot() {
        let mut named = PhonePads::default();
        let mut plain = PhonePads::default();
        for pads in [&mut named, &mut plain] {
            pads.apply(4, PadChange::Button(PhoneButton::A, 1.0));
            pads.apply(4, PadChange::Axis(PhoneAxis::LeftX, 0.5));
        }
        named.apply(4, PadChange::Family(PadFamily::Xbox));
        let (a, b) = (named.states()[0], plain.states()[0]);
        assert_eq!((a.connected, a.buttons, a.axes), (b.connected, b.buttons, b.axes));
        named.apply(4, PadChange::Disconnected);
        assert_eq!(named.states()[0], PadState::default());
    }
}
