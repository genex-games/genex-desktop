//! Android's thermal status: `PowerManager.getCurrentThermalStatus()` (API 29, the floor), read
//! through the JNI bridge when the shell's thermal watch polls (at most once a second), folded
//! onto the shell's four levels. Off Android there is nothing to read.

use genex_platform_ios::mobile::thermal::Thermal;

/// `PowerManager.THERMAL_STATUS_*` values, in order, and the level each folds onto: throttling
/// starts at `moderate`, before the system's own throttling hurts the frame rate.
pub const ANDROID_THERMAL_STATUSES: [(i32, Thermal); 7] = [
    (0, Thermal::Nominal),  // THERMAL_STATUS_NONE
    (1, Thermal::Fair),     // THERMAL_STATUS_LIGHT
    (2, Thermal::Serious),  // THERMAL_STATUS_MODERATE
    (3, Thermal::Critical), // THERMAL_STATUS_SEVERE
    (4, Thermal::Critical), // THERMAL_STATUS_CRITICAL
    (5, Thermal::Critical), // THERMAL_STATUS_EMERGENCY
    (6, Thermal::Critical), // THERMAL_STATUS_SHUTDOWN
];

/// The shell's level for a thermal status; an unknown one reads as the hottest (a future status
/// is never cooler than shutdown).
pub fn thermal_of(status: i32) -> Thermal {
    ANDROID_THERMAL_STATUSES.iter().find(|(known, _)| *known == status).map_or(Thermal::Critical, |(_, level)| *level)
}

/// This build's thermal read: the PowerManager's status on Android, nothing elsewhere.
#[cfg(target_os = "android")]
pub fn read() -> Option<Thermal> {
    crate::jni_bridge::thermal_status().map(thermal_of)
}

/// This build's thermal read: the PowerManager's status on Android, nothing elsewhere.
#[cfg(not(target_os = "android"))]
pub fn read() -> Option<Thermal> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_android_status_folds_in_order_and_unknown_reads_hot() {
        assert_eq!(ANDROID_THERMAL_STATUSES.map(|(status, _)| status), [0, 1, 2, 3, 4, 5, 6]);
        let levels = ANDROID_THERMAL_STATUSES.map(|(_, level)| level);
        assert!(levels.windows(2).all(|pair| pair[0] <= pair[1]), "never cooler as the status rises");
        assert_eq!(thermal_of(2), Thermal::Serious);
        assert_eq!(thermal_of(42), Thermal::Critical);
        if cfg!(not(target_os = "android")) {
            assert_eq!(read(), None);
        }
    }
}
