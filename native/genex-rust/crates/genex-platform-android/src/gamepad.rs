//! Android gamepads: `InputEvent`s mapped onto the phone shell's [`PhoneButton`]s and
//! [`PhoneAxis`]es (and from there onto the standard order), the rows Chrome's Android gamepad
//! mapping uses.
//!
//! - Buttons are `KEYCODE_BUTTON_*` key events. winit hands the ones it cannot name to the shell
//!   as `PhysicalKey::Unidentified(NativeKeyCode::Android(keycode))`, and [`pad_key`] reads them;
//!   each controller's buttons land in its own slot (the shell keys the slot by the event's
//!   device id). The d-pad's `KEYCODE_DPAD_*` rows are in the table, but winit turns those keys
//!   into the arrow keys, so a d-pad that sends keys reaches the game as held arrow keys (the
//!   shell injects them), not as the pad's d-pad buttons.
//! - Axes are `AXIS_*` values of joystick motion events, already pointing the standard's way (y
//!   down). [`JoystickReader`] reads them per device id: the sticks, the triggers (the larger of
//!   each trigger's two spellings) and the hat, which [`PhonePads`] turns into d-pad presses past
//!   its threshold. Only the changes are queued ([`read_motion`]), keyed like that controller's
//!   buttons, and the shell's `pads` hook takes them each frame ([`take_axes`]).
//! - winit 0.30 turns every motion event into touches (a joystick's stick reads as finger 0
//!   moving), so on a device the reader has to see joystick events before winit does:
//!   [`read_activity_motion`] is that step for an android-activity `MotionEvent`. winit drains
//!   the activity's input queue itself and offers no filter, so nothing calls it on a device
//!   yet: TODO(M5-F2b) route joystick-class motion to it ahead of winit's touch conversion.
//!
//! [`PhonePads`]: genex_platform_ios::mobile::gamepad::PhonePads

use genex_platform_ios::mobile::gamepad::{PadChange, PhoneAxis, PhoneButton, controller_id};
use std::sync::{Mutex, PoisonError};
use winit::keyboard::NativeKeyCode;

/// `InputDevice.SOURCE_CLASS_JOYSTICK`: the source class bit of stick, trigger and hat motion.
pub const SOURCE_CLASS_JOYSTICK: u32 = 0x10;

/// Changes the reader queued for the shell's next `pads` poll, at most this many (a phone
/// paused with a pad wiggling keeps no backlog: the oldest changes go first).
const QUEUED_CHANGES_MAX: usize = 256;

/// `KeyEvent` keycodes, by `KEYCODE_*` value.
pub const ANDROID_BUTTONS: [(u32, PhoneButton); 17] = [
    (96, PhoneButton::A),              // KEYCODE_BUTTON_A
    (97, PhoneButton::B),              // KEYCODE_BUTTON_B
    (99, PhoneButton::X),              // KEYCODE_BUTTON_X
    (100, PhoneButton::Y),             // KEYCODE_BUTTON_Y
    (102, PhoneButton::LeftShoulder),  // KEYCODE_BUTTON_L1
    (103, PhoneButton::RightShoulder), // KEYCODE_BUTTON_R1
    (104, PhoneButton::LeftTrigger),   // KEYCODE_BUTTON_L2
    (105, PhoneButton::RightTrigger),  // KEYCODE_BUTTON_R2
    (109, PhoneButton::Options),       // KEYCODE_BUTTON_SELECT
    (108, PhoneButton::Menu),          // KEYCODE_BUTTON_START
    (106, PhoneButton::LeftThumb),     // KEYCODE_BUTTON_THUMBL
    (107, PhoneButton::RightThumb),    // KEYCODE_BUTTON_THUMBR
    (19, PhoneButton::DpadUp),         // KEYCODE_DPAD_UP
    (20, PhoneButton::DpadDown),       // KEYCODE_DPAD_DOWN
    (21, PhoneButton::DpadLeft),       // KEYCODE_DPAD_LEFT
    (22, PhoneButton::DpadRight),      // KEYCODE_DPAD_RIGHT
    (110, PhoneButton::Home),          // KEYCODE_BUTTON_MODE
];

/// `MotionEvent` axes, by `AXIS_*` value (triggers have two spellings each).
pub const ANDROID_AXES: [(u32, PhoneAxis); 10] = [
    (0, PhoneAxis::LeftX),         // AXIS_X
    (1, PhoneAxis::LeftY),         // AXIS_Y
    (11, PhoneAxis::RightX),       // AXIS_Z
    (14, PhoneAxis::RightY),       // AXIS_RZ
    (17, PhoneAxis::LeftTrigger),  // AXIS_LTRIGGER
    (23, PhoneAxis::LeftTrigger),  // AXIS_BRAKE
    (18, PhoneAxis::RightTrigger), // AXIS_RTRIGGER
    (22, PhoneAxis::RightTrigger), // AXIS_GAS
    (15, PhoneAxis::HatX),         // AXIS_HAT_X
    (16, PhoneAxis::HatY),         // AXIS_HAT_Y
];

/// The phone button a keycode is, if any.
pub fn button_of(keycode: u32) -> Option<PhoneButton> {
    ANDROID_BUTTONS.iter().find(|(known, _)| *known == keycode).map(|(_, button)| *button)
}

/// The phone axis a motion axis is, if any.
pub fn axis_of(axis: u32) -> Option<PhoneAxis> {
    ANDROID_AXES.iter().find(|(known, _)| *known == axis).map(|(_, phone)| *phone)
}

/// The shell's `pad_key` hook: a key winit could not name, as a gamepad button.
pub fn pad_key(code: &NativeKeyCode) -> Option<PhoneButton> {
    match code {
        NativeKeyCode::Android(keycode) => button_of(*keycode),
        _ => None,
    }
}

/// The controller id of Android input device `device`: the same id the shell gives that
/// device's key events (winit's `DeviceId` wraps the `i32` and hashes as it), so a pad's axes
/// and buttons share one slot.
pub fn device_pad(device: i32) -> u64 {
    controller_id(&device)
}

/// One joystick `MotionEvent`, as the reader needs it: the device, the source bits and the
/// `AXIS_*` values the event carries (pointer 0's; axes it lacks may be left out and read as 0).
#[derive(Clone, Copy, Debug)]
pub struct JoystickMotion<'a> {
    /// `InputEvent.getDeviceId()`.
    pub device: i32,
    /// `InputEvent.getSource()`.
    pub source: u32,
    /// `(AXIS_*, value)` pairs.
    pub axes: &'a [(u32, f32)],
}

impl JoystickMotion<'_> {
    /// Whether the event comes from a joystick-class source (sticks, triggers, hat).
    pub fn is_joystick(&self) -> bool {
        self.source & SOURCE_CLASS_JOYSTICK != 0
    }

    /// The value `phone` reads: the larger of its spellings' values (a trigger has two), 0 for
    /// an axis the event lacks. Values are taken as given; [`PhonePads`] bounds them.
    ///
    /// [`PhonePads`]: genex_platform_ios::mobile::gamepad::PhonePads
    fn value(&self, phone: PhoneAxis) -> f32 {
        let spellings = ANDROID_AXES.iter().filter(|(_, known)| *known == phone).map(|(axis, _)| *axis);
        let values = spellings.flat_map(|axis| self.axes.iter().filter(move |(carried, _)| *carried == axis).map(|(_, value)| *value));
        values.fold(None, |best: Option<f32>, value| Some(best.map_or(value, |held| larger(held, value)))).unwrap_or(0.0)
    }
}

/// The larger of two readings, a finite one winning over one that is not.
fn larger(held: f32, value: f32) -> f32 {
    match (held.is_finite(), value.is_finite()) {
        (true, true) => held.max(value),
        (false, true) => value,
        _ => held,
    }
}

/// The last axis values read per device, so only changes reach the slots.
#[derive(Clone, Debug, Default)]
pub struct JoystickReader {
    devices: Vec<(i32, [f32; PhoneAxis::ALL.len()])>,
}

impl JoystickReader {
    /// Read one motion event: a joystick-class event appends a `Connected` the first time its
    /// device is seen, then an `Axis` change for every axis whose value moved, and answers true
    /// (the event is the reader's); any other source (touch, mouse) is left alone and answers false.
    pub fn read(&mut self, motion: &JoystickMotion<'_>, out: &mut Vec<(u64, PadChange)>) -> bool {
        if !motion.is_joystick() {
            return false;
        }
        let pad = device_pad(motion.device);
        let held = match self.devices.iter().position(|(device, _)| *device == motion.device) {
            Some(index) => index,
            None => {
                self.devices.push((motion.device, [0.0; PhoneAxis::ALL.len()]));
                out.push((pad, PadChange::Connected));
                self.devices.len() - 1
            }
        };
        let last = &mut self.devices[held].1;
        for (slot, phone) in PhoneAxis::ALL.into_iter().enumerate() {
            let value = motion.value(phone);
            if value.to_bits() != last[slot].to_bits() {
                last[slot] = value;
                out.push((pad, PadChange::Axis(phone, value)));
            }
        }
        true
    }
}

/// The process's reader and the changes it queued for the shell's next `pads` poll.
struct Queued {
    reader: JoystickReader,
    changes: Vec<(u64, PadChange)>,
}

static READER: Mutex<Queued> = Mutex::new(Queued { reader: JoystickReader { devices: Vec::new() }, changes: Vec::new() });

/// Read one motion event into the queue the `pads` hook drains; true when it was a joystick's.
pub fn read_motion(motion: &JoystickMotion<'_>) -> bool {
    let mut guard = READER.lock().unwrap_or_else(PoisonError::into_inner);
    let Queued { reader, changes } = &mut *guard;
    let read = reader.read(motion, changes);
    let over = changes.len().saturating_sub(QUEUED_CHANGES_MAX);
    changes.drain(..over);
    read
}

/// The shell's `pads` hook: hand over every change queued since the last poll.
pub fn take_axes(out: &mut Vec<(u64, PadChange)>) {
    let mut guard = READER.lock().unwrap_or_else(PoisonError::into_inner);
    out.append(&mut guard.changes);
}

/// Read an android-activity `MotionEvent` (pointer 0's axes from the table); true when it was a
/// joystick's, and then winit must not turn it into touches.
#[cfg(target_os = "android")]
pub fn read_activity_motion(event: &android_activity::input::MotionEvent<'_>) -> bool {
    use android_activity::input::Axis;
    if event.pointer_count() == 0 {
        return false;
    }
    let pointer = event.pointer_at_index(0);
    let axes = ANDROID_AXES.map(|(axis, _)| (axis, pointer.axis_value(Axis::from(axis))));
    read_motion(&JoystickMotion { device: event.device_id(), source: u32::from(event.source()), axes: &axes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_phone_button_is_one_keycode() {
        for button in PhoneButton::ALL {
            let rows = ANDROID_BUTTONS.iter().filter(|(_, known)| *known == button).count();
            assert_eq!(rows, 1, "{button:?}");
        }
        let mut keycodes = ANDROID_BUTTONS.map(|(keycode, _)| keycode);
        keycodes.sort_unstable();
        assert!(keycodes.windows(2).all(|pair| pair[0] != pair[1]), "a keycode maps once");
    }

    #[test]
    fn every_phone_axis_has_an_android_axis() {
        for axis in PhoneAxis::ALL {
            assert!(ANDROID_AXES.iter().any(|(_, known)| *known == axis), "{axis:?}");
        }
        assert_eq!(axis_of(14), Some(PhoneAxis::RightY));
        assert_eq!(axis_of(2), None, "AXIS_PRESSURE is not a pad axis");
    }

    #[test]
    fn only_android_gamepad_keycodes_are_pad_keys() {
        assert_eq!(pad_key(&NativeKeyCode::Android(96)), Some(PhoneButton::A));
        assert_eq!(pad_key(&NativeKeyCode::Android(110)), Some(PhoneButton::Home));
        assert_eq!(pad_key(&NativeKeyCode::Android(98)), None, "KEYCODE_BUTTON_C has no standard place");
        assert_eq!(pad_key(&NativeKeyCode::Android(29)), None, "KEYCODE_A is a letter");
        assert_eq!(pad_key(&NativeKeyCode::Unidentified), None);
    }

    /// `AINPUT_SOURCE_JOYSTICK | AINPUT_SOURCE_GAMEPAD`, what a phone pad's stick events carry.
    const PAD_SOURCE: u32 = 0x0100_0010 | 0x0000_0401;

    fn standard_axis(axis: PhoneAxis) -> usize {
        match axis.target() {
            genex_platform_ios::mobile::gamepad::AxisTarget::Axis(at) => at,
            other => panic!("{axis:?} is not a standard axis: {other:?}"),
        }
    }

    fn standard_button(axis: PhoneAxis) -> usize {
        match axis.target() {
            genex_platform_ios::mobile::gamepad::AxisTarget::Button(at) => at,
            other => panic!("{axis:?} is not an analog button: {other:?}"),
        }
    }

    #[test]
    fn a_joystick_motion_table_reaches_the_standard_axes_triggers_and_hat_dpad() {
        // A fake joystick MotionEvent for device 7: every AXIS_* the table reads.
        let axes = [
            (0, 0.5),   // AXIS_X
            (1, -0.25), // AXIS_Y
            (11, 0.75), // AXIS_Z
            (14, 1.0),  // AXIS_RZ
            (17, 0.6),  // AXIS_LTRIGGER
            (18, 0.0),  // AXIS_RTRIGGER
            (22, 0.9),  // AXIS_GAS (the right trigger's other spelling)
            (15, -1.0), // AXIS_HAT_X: d-pad left
            (16, 1.0),  // AXIS_HAT_Y: d-pad down
        ];
        let mut reader = JoystickReader::default();
        let mut changes = Vec::new();
        assert!(reader.read(&JoystickMotion { device: 7, source: PAD_SOURCE, axes: &axes }, &mut changes), "a joystick event is read");
        let mut pads = genex_platform_ios::mobile::gamepad::PhonePads::default();
        for (pad, change) in changes {
            assert_eq!(pad, device_pad(7), "every change lands on device 7's controller");
            pads.apply(pad, change);
        }
        let pad = pads.states()[0];
        assert!(pad.connected);
        assert_eq!(pad.axes[standard_axis(PhoneAxis::LeftX)], 0.5);
        assert_eq!(pad.axes[standard_axis(PhoneAxis::LeftY)], -0.25, "Android's y already points down");
        assert_eq!(pad.axes[standard_axis(PhoneAxis::RightX)], 0.75);
        assert_eq!(pad.axes[standard_axis(PhoneAxis::RightY)], 1.0);
        assert_eq!(pad.buttons[standard_button(PhoneAxis::LeftTrigger)], 0.6);
        assert_eq!(pad.buttons[standard_button(PhoneAxis::RightTrigger)], 0.9, "the larger of RTRIGGER and GAS");
        let hat = |axis: PhoneAxis| match axis.target() {
            genex_platform_ios::mobile::gamepad::AxisTarget::Hat { negative, positive } => (negative, positive),
            other => panic!("{other:?}"),
        };
        let (left, right) = hat(PhoneAxis::HatX);
        let (up, down) = hat(PhoneAxis::HatY);
        assert_eq!((pad.buttons[left], pad.buttons[right]), (1.0, 0.0), "the hat presses d-pad left");
        assert_eq!((pad.buttons[up], pad.buttons[down]), (0.0, 1.0), "the hat presses d-pad down");
    }

    #[test]
    fn each_device_keeps_its_own_values_and_only_changes_are_reported() {
        let mut reader = JoystickReader::default();
        let mut changes = Vec::new();
        reader.read(&JoystickMotion { device: 3, source: PAD_SOURCE, axes: &[(0, 0.5)] }, &mut changes);
        assert_eq!(changes, vec![(device_pad(3), PadChange::Connected), (device_pad(3), PadChange::Axis(PhoneAxis::LeftX, 0.5))]);
        changes.clear();
        reader.read(&JoystickMotion { device: 3, source: PAD_SOURCE, axes: &[(0, 0.5)] }, &mut changes);
        assert!(changes.is_empty(), "the same value again is no change");
        reader.read(&JoystickMotion { device: 4, source: PAD_SOURCE, axes: &[(0, 0.5)] }, &mut changes);
        assert_eq!(changes, vec![(device_pad(4), PadChange::Connected), (device_pad(4), PadChange::Axis(PhoneAxis::LeftX, 0.5))]);
        changes.clear();
        reader.read(&JoystickMotion { device: 3, source: PAD_SOURCE, axes: &[(0, 0.0)] }, &mut changes);
        assert_eq!(changes, vec![(device_pad(3), PadChange::Axis(PhoneAxis::LeftX, 0.0))], "device 3 recentres alone");
    }

    #[test]
    fn touch_and_mouse_motion_is_left_to_winit() {
        let mut reader = JoystickReader::default();
        let mut changes = Vec::new();
        let touchscreen = 0x0000_1002;
        let mouse = 0x0000_2002;
        for source in [touchscreen, mouse, 0] {
            assert!(!reader.read(&JoystickMotion { device: 1, source, axes: &[(0, 0.5)] }, &mut changes), "{source:#x}");
        }
        assert!(changes.is_empty());
    }

    #[test]
    fn hostile_axis_values_read_as_rest_or_the_bound() {
        let mut reader = JoystickReader::default();
        let mut changes = Vec::new();
        let axes = [(0, f32::NAN), (1, f32::INFINITY), (11, -7.0), (17, -0.5), (2, 0.8), (u32::MAX, 1.0)];
        reader.read(&JoystickMotion { device: 9, source: PAD_SOURCE, axes: &axes }, &mut changes);
        let mut pads = genex_platform_ios::mobile::gamepad::PhonePads::default();
        for (pad, change) in changes {
            pads.apply(pad, change);
        }
        let pad = pads.states()[0];
        assert_eq!(pad.axes[standard_axis(PhoneAxis::LeftX)], 0.0, "NaN is rest");
        assert_eq!(pad.axes[standard_axis(PhoneAxis::LeftY)], 0.0, "infinity is rest");
        assert_eq!(pad.axes[standard_axis(PhoneAxis::RightX)], -1.0, "clamped");
        assert_eq!(pad.buttons[standard_button(PhoneAxis::LeftTrigger)], 0.0, "a trigger is never negative");
    }

    #[test]
    fn the_pads_hook_hands_over_what_the_reader_queued_once() {
        let mut queued = Vec::new();
        take_axes(&mut queued);
        queued.clear();
        assert!(read_motion(&JoystickMotion { device: 12, source: PAD_SOURCE, axes: &[(14, -0.5)] }));
        take_axes(&mut queued);
        assert!(queued.contains(&(device_pad(12), PadChange::Axis(PhoneAxis::RightY, -0.5))), "{queued:?}");
        queued.clear();
        take_axes(&mut queued);
        assert!(queued.iter().all(|(pad, _)| *pad != device_pad(12)), "handed over once");
    }
}
