//! iOS gamepads: `GCController`'s extended gamepads, polled every drawn frame and mapped onto the
//! phone shell's [`PhoneButton`]s and [`PhoneAxis`]es (and from there onto the standard order).
//!
//! The tables are the mapping: one row per `GCExtendedGamepad` element, by its property name, so
//! the host tests hold them exhaustive. On iOS the poll reads each connected controller's
//! elements through the Objective-C runtime; an element a controller (or an older iOS) does not
//! have is skipped (`respondsToSelector:` first), and a missing class answers no pads, never a
//! panic. Controllers are told apart by their object's address, stable while connected.
//!
//! GameController's y axes point up; the standard's point down, so the stick rows flip them.
//!
//! A controller's family comes from its `productCategory` (iOS 13+), by [`GC_FAMILIES`]: the
//! category names GameController gives the pads it knows (the names SDL's MFi driver tells apart).
//! Any other category, or none, is Generic.

use crate::mobile::gamepad::{PhoneAxis, PhoneButton};
use genex_core::pad_family::PadFamily;
use std::ffi::CStr;

/// `GCController.productCategory` values with a family; matched exactly.
pub const GC_FAMILIES: [(&str, PadFamily); 7] = [
    ("DualSense", PadFamily::PlayStation),
    ("DualShock 4", PadFamily::PlayStation),
    ("Xbox One", PadFamily::Xbox),
    ("Switch Pro Controller", PadFamily::Nintendo),
    ("Nintendo Switch Joy-Con (L)", PadFamily::Nintendo),
    ("Nintendo Switch Joy-Con (R)", PadFamily::Nintendo),
    ("Nintendo Switch Joy-Con (L/R)", PadFamily::Nintendo),
];

/// The family a `productCategory` names.
pub fn family_of_category(category: &str) -> PadFamily {
    GC_FAMILIES.iter().find(|(known, _)| *known == category).map_or(PadFamily::Generic, |(_, family)| *family)
}

/// `GCExtendedGamepad` buttons, by property.
pub const GC_BUTTONS: [(&CStr, PhoneButton); 13] = [
    (c"buttonA", PhoneButton::A),
    (c"buttonB", PhoneButton::B),
    (c"buttonX", PhoneButton::X),
    (c"buttonY", PhoneButton::Y),
    (c"leftShoulder", PhoneButton::LeftShoulder),
    (c"rightShoulder", PhoneButton::RightShoulder),
    (c"leftTrigger", PhoneButton::LeftTrigger),
    (c"rightTrigger", PhoneButton::RightTrigger),
    (c"buttonOptions", PhoneButton::Options),
    (c"buttonMenu", PhoneButton::Menu),
    (c"leftThumbstickButton", PhoneButton::LeftThumb),
    (c"rightThumbstickButton", PhoneButton::RightThumb),
    (c"buttonHome", PhoneButton::Home),
];

/// The `dpad` element's buttons, by property.
pub const GC_DPAD: [(&CStr, PhoneButton); 4] =
    [(c"up", PhoneButton::DpadUp), (c"down", PhoneButton::DpadDown), (c"left", PhoneButton::DpadLeft), (c"right", PhoneButton::DpadRight)];

/// The sticks' axes: stick property, axis property, the phone axis and the sign that turns
/// GameController's direction into the standard's.
pub const GC_STICKS: [(&CStr, &CStr, PhoneAxis, f32); 4] = [
    (c"leftThumbstick", c"xAxis", PhoneAxis::LeftX, 1.0),
    (c"leftThumbstick", c"yAxis", PhoneAxis::LeftY, -1.0),
    (c"rightThumbstick", c"xAxis", PhoneAxis::RightX, 1.0),
    (c"rightThumbstick", c"yAxis", PhoneAxis::RightY, -1.0),
];

/// Values one controller reports per poll: the buttons, the d-pad, then the stick axes.
pub const GC_ELEMENTS: usize = GC_BUTTONS.len() + GC_DPAD.len() + GC_STICKS.len();

/// This build's gamepad poll: GCController on iOS, nothing elsewhere.
#[cfg(target_os = "ios")]
pub use ios::poll;

/// This build's gamepad poll: GCController on iOS, nothing elsewhere.
#[cfg(not(target_os = "ios"))]
pub fn poll(_changes: &mut Vec<(u64, crate::mobile::gamepad::PadChange)>) {}

/// The changes between a controller's previous values and its current ones (`None`: missing).
pub fn diff(before: &[Option<f32>; GC_ELEMENTS], now: &[Option<f32>; GC_ELEMENTS], out: &mut Vec<crate::mobile::gamepad::PadChange>) {
    use crate::mobile::gamepad::PadChange;
    let buttons = GC_BUTTONS.iter().chain(GC_DPAD.iter()).map(|(_, button)| *button);
    for (at, button) in buttons.enumerate() {
        if let Some(value) = now[at].filter(|value| Some(*value) != before[at]) {
            out.push(PadChange::Button(button, value));
        }
    }
    let first_axis = GC_BUTTONS.len() + GC_DPAD.len();
    for (offset, (_, _, axis, sign)) in GC_STICKS.iter().enumerate() {
        let at = first_axis + offset;
        if let Some(value) = now[at].filter(|value| Some(*value) != before[at]) {
            out.push(PadChange::Axis(*axis, value * sign));
        }
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use super::{GC_BUTTONS, GC_DPAD, GC_ELEMENTS, GC_STICKS, diff, family_of_category};
    use crate::mobile::gamepad::PadChange;
    use genex_core::pad_family::PadFamily;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, MessageReceiver, Sel};
    use std::ffi::CStr;
    use std::sync::Mutex;

    #[link(name = "GameController", kind = "framework")]
    unsafe extern "C" {}

    /// The controllers seen at the last poll and their values.
    static SEEN: Mutex<Vec<(u64, [Option<f32>; GC_ELEMENTS])>> = Mutex::new(Vec::new());

    /// `object.property` for an object-valued property, or `None` (missing or nil).
    fn child<'a>(object: &'a AnyObject, property: &CStr) -> Option<&'a AnyObject> {
        let sel = Sel::register(property);
        // SAFETY: -respondsToSelector: takes a selector and answers a BOOL.
        let responds: bool = unsafe { msg_send![object, respondsToSelector: sel] };
        if !responds {
            return None;
        }
        // SAFETY: the GameController element properties read here take no arguments and answer
        // an object owned by their controller, alive while the controller is.
        let value: *mut AnyObject = unsafe { MessageReceiver::send_message(object, sel, ()) };
        // SAFETY: non-null objects from the controller outlive this poll.
        unsafe { value.as_ref() }
    }

    /// A button or axis input's `value` (a float).
    fn value(input: &AnyObject) -> f32 {
        // SAFETY: GCControllerButtonInput and GCControllerAxisInput both answer `float value`.
        unsafe { msg_send![input, value] }
    }

    fn read(pad: &AnyObject) -> [Option<f32>; GC_ELEMENTS] {
        let mut values = [None; GC_ELEMENTS];
        for (at, (property, _)) in GC_BUTTONS.iter().enumerate() {
            values[at] = child(pad, property).map(value);
        }
        let dpad = child(pad, c"dpad");
        for (offset, (property, _)) in GC_DPAD.iter().enumerate() {
            values[GC_BUTTONS.len() + offset] = dpad.and_then(|dpad| child(dpad, property)).map(value);
        }
        let first_axis = GC_BUTTONS.len() + GC_DPAD.len();
        for (offset, (stick, axis, _, _)) in GC_STICKS.iter().enumerate() {
            values[first_axis + offset] = child(pad, stick).and_then(|stick| child(stick, axis)).map(value);
        }
        values
    }

    /// The controller's family from its `productCategory` (an NSString, iOS 13+); Generic when
    /// the property is missing, nil or not UTF-8.
    fn family(controller: &AnyObject) -> PadFamily {
        let Some(category) = child(controller, c"productCategory") else { return PadFamily::Generic };
        // SAFETY: -[NSString UTF8String] answers a NUL-terminated C string owned by the string
        // (or null), alive while the string is, which outlives this read.
        let text: *const std::ffi::c_char = unsafe { msg_send![category, UTF8String] };
        if text.is_null() {
            return PadFamily::Generic;
        }
        // SAFETY: non-null and NUL-terminated, as above.
        unsafe { CStr::from_ptr(text) }.to_str().map_or(PadFamily::Generic, family_of_category)
    }

    /// The extended gamepads connected now, with their controller's address and family.
    fn connected() -> Vec<(u64, PadFamily, [Option<f32>; GC_ELEMENTS])> {
        let Some(class) = AnyClass::get(c"GCController") else { return Vec::new() };
        // SAFETY: +[GCController controllers] answers an NSArray of the connected controllers.
        let list: *mut AnyObject = unsafe { msg_send![class, controllers] };
        // SAFETY: a non-null array lives for this poll (autoreleased into the run loop's pool).
        let Some(list) = (unsafe { list.as_ref() }) else { return Vec::new() };
        // SAFETY: -[NSArray count] answers an NSUInteger.
        let count: usize = unsafe { msg_send![list, count] };
        (0..count)
            .filter_map(|index| {
                // SAFETY: index < count; -objectAtIndex: answers the controller.
                let controller: *mut AnyObject = unsafe { msg_send![list, objectAtIndex: index] };
                // SAFETY: the array holds the controller for this poll.
                let controller = unsafe { controller.as_ref() }?;
                let pad = child(controller, c"extendedGamepad")?;
                Some((std::ptr::from_ref(controller) as u64, family(controller), read(pad)))
            })
            .collect()
    }

    /// Append what changed since the last poll.
    pub fn poll(changes: &mut Vec<(u64, PadChange)>) {
        let now = connected();
        let Ok(mut seen) = SEEN.lock() else { return };
        for (id, _) in seen.iter().filter(|(id, _)| now.iter().all(|(current, _, _)| current != id)) {
            changes.push((*id, PadChange::Disconnected));
        }
        let mut found = Vec::new();
        for (id, family, values) in &now {
            let before = seen.iter().find(|(known, _)| known == id).map(|(_, values)| *values);
            if before.is_none() {
                changes.push((*id, PadChange::Connected));
                changes.push((*id, PadChange::Family(*family)));
            }
            diff(&before.unwrap_or([None; GC_ELEMENTS]), values, &mut found);
            changes.extend(found.drain(..).map(|change| (*id, change)));
        }
        *seen = now.into_iter().map(|(id, _, values)| (id, values)).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::gamepad::PadChange;

    #[test]
    fn every_phone_button_is_one_gamecontroller_element() {
        let mut named: Vec<PhoneButton> = GC_BUTTONS.iter().chain(GC_DPAD.iter()).map(|(_, button)| *button).collect();
        assert_eq!(named.len(), PhoneButton::ALL.len());
        for button in PhoneButton::ALL {
            let at = named.iter().position(|known| *known == button).unwrap_or_else(|| panic!("{button:?} has no element"));
            named.remove(at);
        }
        assert!(named.is_empty(), "no element named twice");
    }

    #[test]
    fn every_stick_axis_is_read_and_the_y_axes_are_flipped_to_point_down() {
        let axes: Vec<PhoneAxis> = GC_STICKS.iter().map(|(_, _, axis, _)| *axis).collect();
        assert_eq!(axes, [PhoneAxis::LeftX, PhoneAxis::LeftY, PhoneAxis::RightX, PhoneAxis::RightY]);
        for (_, property, axis, sign) in GC_STICKS {
            assert_eq!(sign, if property == c"yAxis" { -1.0 } else { 1.0 }, "{axis:?}");
        }
    }

    #[test]
    fn only_values_that_changed_and_exist_become_changes() {
        let before = [Some(0.0); GC_ELEMENTS];
        let mut now = before;
        now[0] = Some(1.0); // buttonA pressed
        now[GC_BUTTONS.len()] = None; // no d-pad up on this controller
        now[GC_BUTTONS.len() + GC_DPAD.len() + 1] = Some(0.5); // left stick pushed up
        let mut out = Vec::new();
        diff(&before, &now, &mut out);
        assert_eq!(out, vec![PadChange::Button(PhoneButton::A, 1.0), PadChange::Axis(PhoneAxis::LeftY, -0.5)]);
    }

    #[test]
    fn host_builds_poll_no_controllers() {
        let mut changes = Vec::new();
        poll(&mut changes);
        assert!(changes.is_empty());
    }
}

#[cfg(test)]
mod family_tests {
    use super::*;
    use genex_core::pad_family::PadFamily;

    #[test]
    fn product_categories_name_their_family() {
        let rows = [
            ("DualSense", PadFamily::PlayStation),
            ("DualShock 4", PadFamily::PlayStation),
            ("Xbox One", PadFamily::Xbox),
            ("Switch Pro Controller", PadFamily::Nintendo),
            ("Nintendo Switch Joy-Con (L)", PadFamily::Nintendo),
            ("Nintendo Switch Joy-Con (R)", PadFamily::Nintendo),
            ("Nintendo Switch Joy-Con (L/R)", PadFamily::Nintendo),
            ("MFi", PadFamily::Generic),
            ("Siri Remote (2nd Generation)", PadFamily::Generic),
            ("", PadFamily::Generic),
            ("dualsense", PadFamily::Generic),
            ("DualSense\0", PadFamily::Generic),
        ];
        for (category, family) in rows {
            assert_eq!(family_of_category(category), family, "{category:?}");
        }
        assert_eq!(family_of_category(&"DualSense".repeat(1000)), PadFamily::Generic);
    }
}
