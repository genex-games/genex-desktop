//! Numbers on entry (CONTRACT.md §4.1): every number is rounded to f32 (round to nearest, ties to
//! even, as `Math.fround`), and every check applies to the rounded value.

use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::types::{Quat, Vec3};

/// How far |q| may lie from 1 before a rotation is refused (§6.1).
pub(crate) const QUAT_NORM_TOLERANCE: f64 = 1e-4;

/// `x` rounded to f32 as `Math.fround` does (Rust's `as` rounds to nearest, ties to even).
pub(crate) fn fround(x: f64) -> f32 {
    x as f32
}

/// `x` with −0 read as +0 (§4.1).
pub(crate) fn unsigned_zero(x: f32) -> f32 {
    if x == 0.0 { 0.0 } else { x }
}

/// `x` rounded to f32, or `NonFinite`.
pub(crate) fn finite(x: f64, what: &str) -> Result<f32, PhysicsFailure> {
    let rounded = fround(x);
    if !rounded.is_finite() {
        return fail(PhysicsError::NonFinite, format!("{what} is not finite as f32"));
    }
    Ok(rounded)
}

/// A vector rounded to f32, or `NonFinite`.
pub(crate) fn finite_vec(v: Vec3, what: &str) -> Result<[f32; 3], PhysicsFailure> {
    Ok([finite(v[0], what)?, finite(v[1], what)?, finite(v[2], what)?])
}

/// A size-like number: finite and at least 0, with −0 read as 0.
pub(crate) fn non_negative(x: f64, what: &str) -> Result<f32, PhysicsFailure> {
    let value = unsigned_zero(finite(x, what)?);
    if value < 0.0 {
        return fail(PhysicsError::OutOfRange, format!("{what} is negative"));
    }
    Ok(value)
}

/// A finite number strictly above 0.
pub(crate) fn positive(x: f64, what: &str) -> Result<f32, PhysicsFailure> {
    let value = finite(x, what)?;
    if value <= 0.0 {
        return fail(PhysicsError::OutOfRange, format!("{what} must be above 0"));
    }
    Ok(value)
}

/// An integer field (§4.1): finite, whole once rounded, and within `min..=max`.
pub(crate) fn integer(x: f64, what: &str, min: u32, max: u32) -> Result<u32, PhysicsFailure> {
    let value = unsigned_zero(finite(x, what)?);
    let whole = value.fract() == 0.0;
    let in_range = value >= min as f32 && value <= max as f32;
    if !(whole && in_range) {
        return fail(PhysicsError::OutOfRange, format!("{what} must be an integer in {min}..={max}"));
    }
    Ok(value as u32)
}

/// A rotation rounded to f32, refused unless |q| is within 1e-4 of 1, then renormalised in f32 in
/// the caller frame (§6.1).
pub(crate) fn unit_quat(q: Quat, what: &str) -> Result<[f32; 4], PhysicsFailure> {
    let rounded = [finite(q[0], what)?, finite(q[1], what)?, finite(q[2], what)?, finite(q[3], what)?];
    let [x, y, z, w] = rounded;
    let norm = (x * x + y * y + z * z + w * w).sqrt();
    if (f64::from(norm) - 1.0).abs() > QUAT_NORM_TOLERANCE {
        return fail(PhysicsError::OutOfRange, format!("{what} is not a unit quaternion"));
    }
    Ok([x / norm, y / norm, z / norm, w / norm])
}

/// The squared length of a vector, in f64 (each f32 square is exact there).
pub(crate) fn length_squared(v: [f32; 3]) -> f64 {
    v.iter().map(|c| f64::from(*c) * f64::from(*c)).sum()
}

/// An f32 the core holds, widened for a caller.
pub(crate) fn out(x: f32) -> f64 {
    f64::from(x)
}

/// A vector the core holds, widened for a caller.
pub(crate) fn out_vec(v: [f32; 3]) -> Vec3 {
    [out(v[0]), out(v[1]), out(v[2])]
}

/// A quaternion the core holds, widened for a caller.
pub(crate) fn out_quat(q: [f32; 4]) -> Quat {
    [out(q[0]), out(q[1]), out(q[2]), out(q[3])]
}
