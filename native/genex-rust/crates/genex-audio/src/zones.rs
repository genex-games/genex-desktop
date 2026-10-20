//! Reverb zones: which zone holds the listener (the smallest by volume, ties to registration
//! order) and how much of a voice it sends (Godot's Area reverb amount and uniformity, MIT,
//! `scene/3d/audio_stream_player_3d.cpp` `_calc_reverb_vol`: the formula only).

use crate::ops::{ReverbZone, ZoneId, ZoneShape};
use glam::Vec3;

/// A send level that is silence, in dB (kira's floor).
pub const SEND_OFF_DB: f32 = -60.0;
/// `4/3 · π`, a sphere's volume over its radius cubed.
const SPHERE_VOLUME_FACTOR: f32 = 4.0 / 3.0 * core::f32::consts::PI;

/// Whether `shape` holds `point` (its boundary included; a NaN point is in no shape).
fn contains(shape: &ZoneShape, point: Vec3) -> bool {
    match *shape {
        ZoneShape::Box { min, max } => point.cmpge(min).all() && point.cmple(max).all(),
        ZoneShape::Sphere { center, radius } => (point - center).length_squared() <= radius * radius,
    }
}

/// The shape's volume, the tie-break between nested zones.
fn volume(shape: &ZoneShape) -> f32 {
    match *shape {
        ZoneShape::Box { min, max } => {
            let size = (max - min).max(Vec3::ZERO);
            size.x * size.y * size.z
        }
        ZoneShape::Sphere { radius, .. } => SPHERE_VOLUME_FACTOR * radius * radius * radius,
    }
}

/// The index in `zones` of the zone holding `listener`, or `None`: the smallest by volume, ties
/// to the earliest registered.
pub fn active_zone(zones: &[(ZoneId, ReverbZone)], listener: Vec3) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    for (index, (_, zone)) in zones.iter().enumerate() {
        if !contains(&zone.shape, listener) {
            continue;
        }
        let size = volume(&zone.shape);
        if best.is_none_or(|(_, smallest)| size < smallest) {
            best = Some((index, size));
        }
    }
    best.map(|(index, _)| index)
}

/// A voice's reverb send in `zone`, given its dry distance attenuation in dB:
/// `send_db + (1 − uniformity) · dry`, uniformity clamped to 0..=1, floored at [`SEND_OFF_DB`].
/// At uniformity 1 a far voice keeps its full wet signal (a cave); at 0 it falls with the dry one.
pub fn send_db(zone: &ReverbZone, dry_attenuation_db: f32) -> f32 {
    let uniformity = if zone.uniformity.is_nan() { 0.0 } else { zone.uniformity.clamp(0.0, 1.0) };
    let send = zone.send_db + (1.0 - uniformity) * dry_attenuation_db;
    if send.is_nan() { SEND_OFF_DB } else { send.max(SEND_OFF_DB) }
}
