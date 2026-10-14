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
//!   down). winit 0.30 delivers only pointer motion, so [`ANDROID_AXES`] waits for a direct
//!   android-activity reader. TODO(M5-F2): read joystick motion (sticks, triggers, hat) before
//!   winit, per device id.

use genex_platform_ios::mobile::gamepad::{PhoneAxis, PhoneButton};
use winit::keyboard::NativeKeyCode;

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
}
