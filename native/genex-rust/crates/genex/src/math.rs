//! The only transcendental math a simulation may use: libm-backed `f32` functions with the same
//! bits on every target, plus glam's vector types (scalar, libm-backed in this workspace).
//!
//! The lane's clippy gate (M0a.9) refuses std's `f32::sin` and friends in game code, because
//! their results may differ across platforms and so break cross-target parity.

pub use core::f32::consts::{E, FRAC_PI_2, FRAC_PI_4, PI, TAU};
pub use glam::{IVec2, IVec3, Mat3, Mat4, Quat, UVec2, Vec2, Vec3, Vec4, ivec2, uvec2, vec2, vec3, vec4};

/// Sine of `x` radians.
pub fn sin(x: f32) -> f32 {
    libm::sinf(x)
}

/// Cosine of `x` radians.
pub fn cos(x: f32) -> f32 {
    libm::cosf(x)
}

/// Sine and cosine of `x` radians.
pub fn sin_cos(x: f32) -> (f32, f32) {
    libm::sincosf(x)
}

/// Tangent of `x` radians.
pub fn tan(x: f32) -> f32 {
    libm::tanf(x)
}

/// Arcsine, in radians.
pub fn asin(x: f32) -> f32 {
    libm::asinf(x)
}

/// Arccosine, in radians.
pub fn acos(x: f32) -> f32 {
    libm::acosf(x)
}

/// Arctangent, in radians.
pub fn atan(x: f32) -> f32 {
    libm::atanf(x)
}

/// The angle of the point `(x, y)`, in radians.
pub fn atan2(y: f32, x: f32) -> f32 {
    libm::atan2f(y, x)
}

/// `e` raised to `x`.
pub fn exp(x: f32) -> f32 {
    libm::expf(x)
}

/// `2` raised to `x`.
pub fn exp2(x: f32) -> f32 {
    libm::exp2f(x)
}

/// Natural logarithm.
pub fn ln(x: f32) -> f32 {
    libm::logf(x)
}

/// Base-2 logarithm.
pub fn log2(x: f32) -> f32 {
    libm::log2f(x)
}

/// Base-10 logarithm.
pub fn log10(x: f32) -> f32 {
    libm::log10f(x)
}

/// `x` raised to `y`.
pub fn pow(x: f32, y: f32) -> f32 {
    libm::powf(x, y)
}

/// Square root.
pub fn sqrt(x: f32) -> f32 {
    libm::sqrtf(x)
}

/// Cube root.
pub fn cbrt(x: f32) -> f32 {
    libm::cbrtf(x)
}

/// `sqrt(x² + y²)` without intermediate overflow.
pub fn hypot(x: f32, y: f32) -> f32 {
    libm::hypotf(x, y)
}

/// Hyperbolic sine.
pub fn sinh(x: f32) -> f32 {
    libm::sinhf(x)
}

/// Hyperbolic cosine.
pub fn cosh(x: f32) -> f32 {
    libm::coshf(x)
}

/// Hyperbolic tangent.
pub fn tanh(x: f32) -> f32 {
    libm::tanhf(x)
}

/// Inverse hyperbolic sine.
pub fn asinh(x: f32) -> f32 {
    libm::asinhf(x)
}

/// Inverse hyperbolic cosine.
pub fn acosh(x: f32) -> f32 {
    libm::acoshf(x)
}

/// Inverse hyperbolic tangent.
pub fn atanh(x: f32) -> f32 {
    libm::atanhf(x)
}

/// `e^x - 1`, accurate for small `x`.
pub fn exp_m1(x: f32) -> f32 {
    libm::expm1f(x)
}

/// `ln(1 + x)`, accurate for small `x`.
pub fn ln_1p(x: f32) -> f32 {
    libm::log1pf(x)
}

/// Largest integer value not above `x`.
pub fn floor(x: f32) -> f32 {
    libm::floorf(x)
}

/// Smallest integer value not below `x`.
pub fn ceil(x: f32) -> f32 {
    libm::ceilf(x)
}

/// Nearest integer value, halves away from zero.
pub fn round(x: f32) -> f32 {
    libm::roundf(x)
}

/// Linear interpolation from `a` to `b` by `t`.
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Degrees to radians.
pub fn to_radians(degrees: f32) -> f32 {
    degrees * (PI / 180.0)
}
