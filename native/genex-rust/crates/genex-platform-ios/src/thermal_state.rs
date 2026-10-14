//! iOS's thermal state: `NSProcessInfo.processInfo.thermalState`, read through the Objective-C
//! runtime when the shell's [`ThermalWatch`](crate::mobile::thermal::ThermalWatch) polls (at most
//! once a second). Off iOS there is nothing to read.

use crate::mobile::thermal::Thermal;

/// `NSProcessInfoThermalState`'s raw values, in order (nominal 0 .. critical 3).
pub const IOS_THERMAL_STATES: [(isize, Thermal); 4] =
    [(0, Thermal::Nominal), (1, Thermal::Fair), (2, Thermal::Serious), (3, Thermal::Critical)];

/// The shell's state for an `NSProcessInfoThermalState` value; an unknown one reads as the
/// hottest known (a future level is never cooler than critical).
pub fn thermal_of(raw: isize) -> Thermal {
    IOS_THERMAL_STATES.iter().find(|(known, _)| *known == raw).map_or(Thermal::Critical, |(_, state)| *state)
}

/// This build's thermal read: the process's thermal state on iOS, nothing elsewhere.
#[cfg(target_os = "ios")]
pub fn read() -> Option<Thermal> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let class = AnyClass::get(c"NSProcessInfo")?;
    // SAFETY: +[NSProcessInfo processInfo] answers the process's shared instance (never nil).
    let info: *mut AnyObject = unsafe { msg_send![class, processInfo] };
    // SAFETY: the shared instance lives for the whole process.
    let info = unsafe { info.as_ref() }?;
    // SAFETY: -thermalState (iOS 11+) answers an NSInteger.
    let raw: isize = unsafe { msg_send![info, thermalState] };
    Some(thermal_of(raw))
}

/// This build's thermal read: the process's thermal state on iOS, nothing elsewhere.
#[cfg(not(target_os = "ios"))]
pub fn read() -> Option<Thermal> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ios_thermal_state_maps_in_order_and_unknown_reads_hot() {
        assert_eq!(IOS_THERMAL_STATES.map(|(raw, _)| raw), [0, 1, 2, 3]);
        assert_eq!(thermal_of(0), Thermal::Nominal);
        assert_eq!(thermal_of(2), Thermal::Serious);
        assert_eq!(thermal_of(9), Thermal::Critical);
        assert_eq!(thermal_of(-1), Thermal::Critical);
        if cfg!(not(target_os = "ios")) {
            assert_eq!(read(), None, "the host has no thermal state to read");
        }
    }
}
