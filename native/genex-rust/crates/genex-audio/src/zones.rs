//! Reverb zones: which zone holds the listener (the smallest by volume, ties to registration
//! order) and how much of a voice it sends (Godot's amount and uniformity). Bodies are AU-3's;
//! until then no zone holds the listener and nothing is sent.

use crate::ops::{ReverbZone, ZoneId};
use glam::Vec3;

/// A send level that is silence, in dB (kira's floor).
pub const SEND_OFF_DB: f32 = -60.0;

/// The index in `zones` of the zone holding `listener`, or `None`.
pub fn active_zone(zones: &[(ZoneId, ReverbZone)], listener: Vec3) -> Option<usize> {
    let _ = (zones, listener);
    None
}

/// A voice's reverb send in `zone`, given its dry distance attenuation in dB.
pub fn send_db(zone: &ReverbZone, dry_attenuation_db: f32) -> f32 {
    let _ = (zone, dry_attenuation_db);
    SEND_OFF_DB
}
