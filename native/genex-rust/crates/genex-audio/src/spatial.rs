//! Spatial math, on libm only: distance attenuation (the Web Audio PannerNode models), the
//! equal-power pan, the distance low-pass and Doppler (Godot's formula). Every function is pure
//! and uses basic f32 operations plus libm, so a table of their answers is bit-equal on every
//! destination.
//!
//! Formula provenance (formulas only, no code transcribed):
//! - Distance models and equal-power panning: the W3C Web Audio API, `PannerNode` "Distance
//!   effects" and "Equal-power panning". The distance is clamped to `ref..=max` for every model
//!   (OpenAL's clamped models), so gain stops falling past `max_distance`.
//! - Doppler: Godot Engine (MIT), `scene/3d/audio_stream_player_3d.cpp`,
//!   `speed_of_sound / (speed_of_sound + velocity · approaching)` clamped to `[1/8, 8]`.

use crate::ops::{Listener, Spatial};
use crate::vocab::Attenuation;
use crate::zones::SEND_OFF_DB;
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
/// The shortest reference distance the models divide by, in metres.
const REF_DISTANCE_MIN: f32 = 1e-3;
/// Below this length a direction is no direction (a source at the listener).
const DIRECTION_EPSILON: f32 = 1e-6;

/// `ref`, `max` and `rolloff` made safe to divide by: finite, `ref > 0`, `max >= ref`,
/// `rolloff >= 0`.
fn falloff_bounds(spatial: &Spatial) -> (f32, f32, f32) {
    let finite_or = |value: f32, fallback: f32| if value.is_finite() { value } else { fallback };
    let reference = finite_or(spatial.ref_distance, 1.0).max(REF_DISTANCE_MIN);
    let max = finite_or(spatial.max_distance, reference).max(reference);
    let rolloff = finite_or(spatial.rolloff, 1.0).max(0.0);
    (reference, max, rolloff)
}

/// The linear gain of a voice `distance` metres away (1 at or inside `ref_distance`).
fn attenuation_gain(spatial: &Spatial, distance: f32) -> f32 {
    let (reference, max, rolloff) = falloff_bounds(spatial);
    let distance = if distance.is_nan() { reference } else { distance.clamp(reference, max) };
    match spatial.attenuation {
        Attenuation::Inverse => reference / (reference + rolloff * (distance - reference)),
        Attenuation::Linear => {
            let span = max - reference;
            if span <= 0.0 {
                return 1.0;
            }
            1.0 - rolloff.min(1.0) * (distance - reference) / span
        }
        Attenuation::Exponential => libm::powf(distance / reference, -rolloff),
        Attenuation::Off => 1.0,
    }
}

/// Linear gain in dB, floored at [`SEND_OFF_DB`] (silence; never `-inf` or NaN).
pub(crate) fn gain_to_db(gain: f32) -> f32 {
    if gain.is_nan() || gain <= 0.0 {
        return SEND_OFF_DB;
    }
    (20.0 * libm::log10f(gain)).max(SEND_OFF_DB)
}

/// The gain of a voice `distance` metres away, in dB (0 at or inside `ref_distance`, flat past
/// `max_distance`, floored at [`SEND_OFF_DB`]).
pub fn attenuation_db(spatial: &Spatial, distance: f32) -> f32 {
    // Never above 0 dB, whatever log10f(1) rounds to.
    gain_to_db(attenuation_gain(spatial, distance)).min(0.0)
}

/// The pan of a voice at `at` heard by `listener`, -1..=1 (0 at the listener's position).
///
/// It is the sine of the azimuth in the listener's horizontal plane times `panning`: a source
/// behind mirrors the one in front, and one straight above (or at the ears) is centred.
pub fn pan(listener: &Listener, at: Vec3, panning: f32) -> f32 {
    let forward = listener.forward.normalize_or_zero();
    let right = forward.cross(listener.up).normalize_or_zero();
    let offset = at - listener.position;
    let x = offset.dot(right);
    let z = offset.dot(forward);
    let horizontal = (x * x + z * z).sqrt();
    let unusable = !horizontal.is_finite() || horizontal <= DIRECTION_EPSILON || right == Vec3::ZERO;
    if unusable {
        return 0.0;
    }
    let strength = if panning.is_finite() { panning.clamp(0.0, 1.0) } else { 1.0 };
    (x / horizontal * strength).clamp(-1.0, 1.0)
}

/// The equal-power gains `(left, right)` of `pan`, the law kira's panning renders (without its
/// constant √2): `left² + right² = 1`.
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let pan = if pan.is_nan() { 0.0 } else { pan.clamp(-1.0, 1.0) };
    let mix = (pan + 1.0) * 0.5;
    ((1.0 - mix).sqrt(), mix.sqrt())
}

/// The low-pass cut-off of a voice `distance` metres away, in Hz: log-linear from
/// [`CUTOFF_OPEN_HZ`] at the listener to [`CUTOFF_FAR_HZ`] at `max_distance`, flat past it.
pub fn distance_cutoff_hz(spatial: &Spatial, distance: f32) -> f32 {
    if !spatial.lowpass_by_distance {
        return CUTOFF_OPEN_HZ;
    }
    let (_, max, _) = falloff_bounds(spatial);
    let t = if distance.is_nan() { 0.0 } else { (distance / max).clamp(0.0, 1.0) };
    if t == 0.0 {
        return CUTOFF_OPEN_HZ;
    }
    CUTOFF_OPEN_HZ * libm::powf(CUTOFF_FAR_HZ / CUTOFF_OPEN_HZ, t)
}

/// The playback rate from emitter and listener velocities (m/s) along `toward_listener` (the
/// unit direction from the emitter to the listener), clamped to
/// [`DOPPLER_RATE_MIN`]..=[`DOPPLER_RATE_MAX`]; 1 when `strength` is 0 or a value is not finite.
pub fn doppler_rate(emitter_velocity: Vec3, listener_velocity: Vec3, toward_listener: Vec3, strength: f32) -> f32 {
    let relative = emitter_velocity - listener_velocity;
    let approaching = relative.dot(toward_listener) * strength;
    let off = strength == 0.0 || !approaching.is_finite();
    if off {
        return 1.0;
    }
    let denominator = SPEED_OF_SOUND_M_S - approaching;
    if denominator <= 0.0 {
        return DOPPLER_RATE_MAX;
    }
    (SPEED_OF_SOUND_M_S / denominator).clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX)
}
