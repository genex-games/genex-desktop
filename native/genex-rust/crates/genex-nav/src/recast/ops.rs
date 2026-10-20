//! The float operations the Recast stages call, with the same bits on every destination.
//!
//! Upstream copies bevy_math's `ops.rs` and routes every operation through libm when its `libm`
//! feature is on. Here only the operations the stages use are kept: `floor`, `ceil` and `abs` are
//! exact under IEEE 754, so the core forms already agree everywhere, and `cos` goes through glam's
//! `Vec2::from_angle`, which runs libm's `sincosf` under the workspace's scalar-math + libm glam
//! (the same route as `TileInput::clear_steep`), so the crate needs no libm dependency of its own.

use glam::Vec2;

/// The largest integer at or below `x` (exact).
#[inline(always)]
pub(crate) fn floor(x: f32) -> f32 {
    x.floor()
}

/// The smallest integer at or above `x` (exact).
#[inline(always)]
pub(crate) fn ceil(x: f32) -> f32 {
    x.ceil()
}

/// The absolute value of `x` (exact).
#[inline(always)]
pub(crate) fn abs(x: f32) -> f32 {
    x.abs()
}

/// The cosine of `x` radians, through libm (the same bits on every destination).
#[inline(always)]
pub(crate) fn cos(x: f32) -> f32 {
    Vec2::from_angle(x).x
}
