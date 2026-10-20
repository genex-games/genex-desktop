//! Spatial math, on libm only: distance attenuation (the Web Audio PannerNode models), the
//! equal-power pan, the distance low-pass and Doppler (Godot's formula). Bodies are AU-3's; until
//! then a spatial voice is flat: 0 dB, centred, open, at pitch 1.

use crate::ops::{Listener, Spatial};
use glam::Vec3;

/// The low-pass cut-off of a voice nothing darkens, in Hz.
pub const CUTOFF_OPEN_HZ: f32 = 20_000.0;
/// The low-pass cut-off at `max_distance` with `lowpass_by_distance`, in Hz.
pub const CUTOFF_FAR_HZ: f32 = 2_000.0;
/// Metres per second; Doppler's `c`.
pub const SPEED_OF_SOUND_M_S: f32 = 343.0;
/// Doppler's slowest playback rate.
pub const DOPPLER_RATE_MIN: f32 = 0.125;
/// Doppler's fastest playback rate.
pub const DOPPLER_RATE_MAX: f32 = 8.0;

/// The gain of a voice `distance` metres away, in dB (0 at or inside `ref_distance`).
pub fn attenuation_db(spatial: &Spatial, distance: f32) -> f32 {
    let _ = (spatial, distance);
    0.0
}

/// The pan of a voice at `at` heard by `listener`, -1..=1 (0 at the listener's position).
pub fn pan(listener: &Listener, at: Vec3, panning: f32) -> f32 {
    let _ = (listener, at, panning);
    0.0
}

/// The low-pass cut-off of a voice `distance` metres away, in Hz.
pub fn distance_cutoff_hz(spatial: &Spatial, distance: f32) -> f32 {
    let _ = (spatial, distance);
    CUTOFF_OPEN_HZ
}

/// The playback rate from emitter and listener velocities (m/s) along `toward_listener`,
/// clamped to [`DOPPLER_RATE_MIN`]..=[`DOPPLER_RATE_MAX`]; 1 when `strength` is 0.
pub fn doppler_rate(emitter_velocity: Vec3, listener_velocity: Vec3, toward_listener: Vec3, strength: f32) -> f32 {
    let _ = (emitter_velocity, listener_velocity, toward_listener, strength);
    1.0
}
