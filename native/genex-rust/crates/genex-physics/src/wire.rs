//! The authority wire's body rows (PROTOCOL §17.10 *State*; contract 1.1 draft): what a body's
//! state becomes on the wire and what a client reads back, so a world can be canonicalized onto
//! exactly the values a client imports (`canonicalize({ quantize })`, `importWire`).
//!
//! A row is [`WIRE_STRIDE`] numbers: the position as it is (float32, −0 sent as 0), the rotation's
//! four components and the linear and angular velocity's three each as 16-bit integers over a
//! symmetric range ([`WIRE_SPAN`] steps, out-of-range values clamped, NaN as 0), the sleep flag (0
//! or 1) and the sleep timer as a whole number of inner steps. Linear velocity crosses in caller
//! units per second divided by `lengthUnit`; angular velocity in rad/s. Integers decode in float64
//! exactly as `physics-draw.reference.mjs` decodes them; the core then rounds each to f32 on entry
//! (§4.1) and renormalises the rotation in f32 (§9.2).

/// Numbers per body in a wire row: p(3), q(4), lv(3), av(3), sleep(1), rest(1).
pub const WIRE_STRIDE: usize = 15;
/// Integer steps across a quantized field's range (2^16 − 2), so 0 is exact.
pub const WIRE_SPAN: u32 = 65_534;
/// The rotation components' range.
pub const WIRE_ORIENTATION: WireRange = WireRange { min: -1.0, max: 1.0 };
/// The velocities' range: metres per second (linear velocity over `lengthUnit`) and rad/s.
pub const WIRE_VELOCITY: WireRange = WireRange { min: -64.0, max: 64.0 };
/// The largest sleep timer a row carries, in inner steps.
pub const WIRE_REST_MAX: u32 = 65_535;

/// A quantized field's range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WireRange {
    /// The value of integer 0.
    pub min: f64,
    /// The value of integer [`WIRE_SPAN`].
    pub max: f64,
}

/// The integer a field sends for `v`: clamped to the range, NaN as 0 (the host's
/// `quantizeBodyValue`, operation for operation).
pub fn quantize(v: f64, range: WireRange) -> u32 {
    if v.is_nan() {
        return 0;
    }
    let clamped = v.clamp(range.min, range.max);
    (((clamped - range.min) / (range.max - range.min)) * f64::from(WIRE_SPAN) + 0.5).floor() as u32
}

/// The value a client decodes from integer `q`, in float64 (`dequantizeBodyValue`).
pub fn dequantize(q: u32, range: WireRange) -> f64 {
    range.min + (f64::from(q) / f64::from(WIRE_SPAN)) * (range.max - range.min)
}

/// The sleep timer `rest` (seconds) in whole inner steps of `inner_dt`, rounded, at most
/// [`WIRE_REST_MAX`]; computed in float64 from the f32 values.
pub fn rest_steps(rest: f32, inner_dt: f32) -> u32 {
    let steps = (f64::from(rest) / f64::from(inner_dt) + 0.5).floor();
    match steps.is_nan() || steps < 0.0 {
        true => 0,
        false => steps.min(f64::from(WIRE_REST_MAX)) as u32,
    }
}

/// The sleep timer of `steps` whole inner steps: `steps · inner_dt` in f32.
pub fn rest_of(steps: u32, inner_dt: f32) -> f32 {
    steps as f32 * inner_dt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_clamps_and_maps_nan_to_zero() {
        assert_eq!(quantize(f64::NAN, WIRE_VELOCITY), 0);
        assert_eq!(quantize(-1e9, WIRE_ORIENTATION), 0);
        assert_eq!(quantize(1e9, WIRE_ORIENTATION), WIRE_SPAN);
        assert_eq!(quantize(0.0, WIRE_VELOCITY), WIRE_SPAN / 2);
        assert_eq!(dequantize(WIRE_SPAN / 2, WIRE_VELOCITY), 0.0, "0 is exact");
    }

    #[test]
    fn rest_steps_round_and_cap() {
        let dt = 1.0f32 / 60.0;
        assert_eq!(rest_steps(rest_of(30, dt), dt), 30);
        assert_eq!(rest_steps(1e9, dt), WIRE_REST_MAX);
        assert_eq!(rest_steps(-1.0, dt), 0);
    }
}
