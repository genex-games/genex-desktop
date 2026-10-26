//! The static world import (CONTRACT.md §6.5): PROTOCOL §17.7's *World* validated exactly as §17.7
//! does, then one fixed body per solid, keyed `static:box:NNNN` or `static:ramp:NNNN`.
//!
//! Codes (§6.5 names the three; which rule gives which is this core's reading): a count past
//! §17.7's caps, an entry of the wrong length, a value that is not a float32 or is above 1e9 in
//! magnitude, and a ramp `axis` other than 0 or 1 give `OutOfRange`; a value that is not finite
//! as f32 gives `NonFinite`; `min >= max` on an axis, or a ramp whose `lo`, `hi` and `maxZ`
//! break §17.7's rules, gives `BadShape`.

use crate::axes::{extent_in, vec_in};
use crate::backend::{BodySpec, ColliderSpec, MassSpec, ShapeSpec};
use crate::body::{DEFAULT_DENSITY, DEFAULT_FRICTION, DEFAULT_RESTITUTION, GROUPS_ALL};
use crate::canon::Canon;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::num::{fround, unsigned_zero};
use crate::shape::ShapeFacts;
use crate::types::{BodyType, UpAxis};

/// §17.7's most boxes.
pub const STATIC_BOXES_MAX: usize = 4096;
/// §17.7's most ramps.
pub const STATIC_RAMPS_MAX: usize = 512;
/// §17.7's largest magnitude of any value.
pub const STATIC_MAGNITUDE_MAX: f32 = 1e9;
/// The numbers of one box: `[minX, minY, minZ, maxX, maxY, maxZ]`.
pub const BOX_VALUES: usize = 6;
/// The numbers of one ramp: a box, then `axis, lo, hi`.
pub const RAMP_VALUES: usize = 9;
/// The digits of a piece's index in its key.
const INDEX_DIGITS: usize = 4;

/// PROTOCOL §17.7's World, z-up: boxes `[minX, minY, minZ, maxX, maxY, maxZ]`; ramps add
/// `axis` (0: rising along x, 1: along y), `lo` (height at that axis's min end) and `hi`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticWorld {
    /// The boxes, solids 0..B.
    pub boxes: Vec<Vec<f64>>,
    /// The ramps, solids B..B+R.
    pub ramps: Vec<Vec<f64>>,
}

/// One static piece in the core's frame.
#[derive(Clone, Debug)]
pub(crate) struct StaticPiece {
    pub key: String,
    pub spec: BodySpec,
    pub facts: ShapeFacts,
}

/// A static world that passed §17.7's rules.
#[derive(Clone, Debug)]
pub(crate) struct ValidStatic {
    pub pieces: Vec<StaticPiece>,
    /// The world as given, for `physicsHash` (§10.2).
    pub canon: Canon,
}

/// The empty static world's canonical form, `{"boxes":[],"ramps":[]}`.
pub(crate) fn empty_canon() -> Canon {
    Canon::object([("boxes", Canon::Arr(Vec::new())), ("ramps", Canon::Arr(Vec::new()))])
}

/// Checks `world` by §17.7's rules and builds its pieces for a z-up world.
pub(crate) fn validate_static(world: &StaticWorld) -> Result<ValidStatic, PhysicsFailure> {
    if world.boxes.len() > STATIC_BOXES_MAX || world.ramps.len() > STATIC_RAMPS_MAX {
        return fail(PhysicsError::OutOfRange, "more than 4096 boxes or 512 ramps");
    }
    let boxes = world.boxes.iter().map(|v| entry(v, BOX_VALUES)).collect::<Result<Vec<_>, _>>()?;
    let ramps = world.ramps.iter().map(|v| entry(v, RAMP_VALUES)).collect::<Result<Vec<_>, _>>()?;
    let mut pieces = Vec::with_capacity(boxes.len() + ramps.len());
    for (index, values) in boxes.iter().enumerate() {
        check_bounds(values)?;
        pieces.push(box_piece(index, values));
    }
    for (index, values) in ramps.iter().enumerate() {
        check_bounds(values)?;
        check_ramp(values)?;
        pieces.push(ramp_piece(index, values));
    }
    let rows = |entries: &[Vec<f32>]| Canon::Arr(entries.iter().map(|v| Canon::numbers(v)).collect());
    let canon = Canon::object([("boxes", rows(&boxes)), ("ramps", rows(&ramps))]);
    Ok(ValidStatic { pieces, canon })
}

/// One entry's values: exactly `len` float32s of magnitude at most 1e9, −0 read as 0.
fn entry(values: &[f64], len: usize) -> Result<Vec<f32>, PhysicsFailure> {
    if values.len() != len {
        return fail(PhysicsError::OutOfRange, format!("a static entry holds exactly {len} numbers"));
    }
    values.iter().map(|v| float32(*v)).collect()
}

fn float32(value: f64) -> Result<f32, PhysicsFailure> {
    let rounded = fround(value);
    if !rounded.is_finite() {
        return fail(PhysicsError::NonFinite, "a static value is not finite as f32");
    }
    if f64::from(rounded) != value || rounded.abs() > STATIC_MAGNITUDE_MAX {
        return fail(PhysicsError::OutOfRange, "a static value is not a float32 of magnitude <= 1e9");
    }
    Ok(unsigned_zero(rounded))
}

/// `min < max` on every axis.
fn check_bounds(values: &[f32]) -> Result<(), PhysicsFailure> {
    if (0..3).any(|axis| values[axis] >= values[axis + 3]) {
        return fail(PhysicsError::BadShape, "a static solid needs min < max on every axis");
    }
    Ok(())
}

/// A ramp's `axis` is 0 or 1, `minZ <= lo`, `minZ <= hi` and `maxZ = max(lo, hi)`.
fn check_ramp(values: &[f32]) -> Result<(), PhysicsFailure> {
    let [min_z, max_z, axis, lo, hi] = [values[2], values[5], values[6], values[7], values[8]];
    if axis != 0.0 && axis != 1.0 {
        return fail(PhysicsError::OutOfRange, "a ramp's axis is 0 or 1");
    }
    let heights_ok = min_z <= lo && min_z <= hi && max_z == lo.max(hi);
    if !heights_ok {
        return fail(PhysicsError::BadShape, "a ramp needs minZ <= lo, minZ <= hi and maxZ = max(lo, hi)");
    }
    Ok(())
}

fn piece_key(kind: &str, index: usize) -> String {
    format!("static:{kind}:{index:0INDEX_DIGITS$}")
}

/// The middle of a solid's bounds, in the caller frame.
fn middle(values: &[f32]) -> [f32; 3] {
    [0, 1, 2].map(|axis| (values[axis] + values[axis + 3]) * 0.5)
}

fn box_piece(index: usize, values: &[f32]) -> StaticPiece {
    let half = [0, 1, 2].map(|axis| (values[axis + 3] - values[axis]) * 0.5);
    let shape = ShapeSpec::Cuboid { half: extent_in(UpAxis::Z, half) };
    StaticPiece { key: piece_key("box", index), spec: fixed_body(middle(values), shape), facts: ShapeFacts::default() }
}

fn ramp_piece(index: usize, values: &[f32]) -> StaticPiece {
    let centre = middle(values);
    let points: Vec<[f32; 3]> = ramp_corners(values)
        .into_iter()
        .map(|p| vec_in(UpAxis::Z, [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]))
        .collect();
    let facts = ShapeFacts { hull_points_max: points.len(), hull_points: points.len(), ..ShapeFacts::default() };
    let spec = fixed_body(centre, ShapeSpec::Hull { points });
    StaticPiece { key: piece_key("ramp", index), spec, facts }
}

/// A ramp's hull points in the caller frame (§6.5): the 4 bottom corners at `minZ`, then the 2 top
/// corners at the axis's min end at `lo` and the 2 at its max end at `hi`; a top corner that
/// coincides with a bottom one (`lo` or `hi` equal to `minZ`) is merged away.
fn ramp_corners(values: &[f32]) -> Vec<[f32; 3]> {
    let [x0, y0, z0, x1, y1, _, axis, lo, hi] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(|i| values[i]);
    let mut corners = vec![[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0]];
    let ends = if axis == 0.0 {
        [[[x0, y0, lo], [x0, y1, lo]], [[x1, y0, hi], [x1, y1, hi]]]
    } else {
        [[[x0, y0, lo], [x1, y0, lo]], [[x0, y1, hi], [x1, y1, hi]]]
    };
    for (height, end) in [lo, hi].into_iter().zip(ends) {
        if height != z0 {
            corners.extend(end);
        }
    }
    corners
}

/// A fixed body at `centre` (caller frame, z-up) with one collider of `shape`.
fn fixed_body(centre: [f32; 3], shape: ShapeSpec) -> BodySpec {
    let collider = ColliderSpec {
        shape,
        translation: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        mass: MassSpec::Density(DEFAULT_DENSITY),
        friction: DEFAULT_FRICTION,
        restitution: DEFAULT_RESTITUTION,
        member: GROUPS_ALL as u16,
        collides: GROUPS_ALL as u16,
        sensor: false,
        events: false,
    };
    BodySpec {
        body_type: BodyType::Fixed,
        translation: vec_in(UpAxis::Z, centre),
        rotation: [0.0, 0.0, 0.0, 1.0],
        linvel: [0.0; 3],
        angvel: [0.0; 3],
        linear_damping: 0.0,
        angular_damping: 0.0,
        gravity_scale: 1.0,
        locked_rotations: [false; 3],
        ccd: false,
        can_sleep: true,
        colliders: vec![collider],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piece_keys_are_zero_padded_to_four_digits() {
        assert_eq!(piece_key("box", 0), "static:box:0000");
        assert_eq!(piece_key("ramp", 511), "static:ramp:0511");
        assert_eq!(piece_key("box", 4095), "static:box:4095");
    }

    #[test]
    fn a_ramp_has_eight_corners_or_six_when_one_end_is_on_the_floor() {
        let full = [0.0, 0.0, 0.0, 4.0, 2.0, 3.0, 0.0, 1.0, 3.0];
        assert_eq!(ramp_corners(&full).len(), 8);
        let wedge = [0.0, 0.0, 0.0, 4.0, 2.0, 3.0, 0.0, 0.0, 3.0];
        let corners = ramp_corners(&wedge);
        assert_eq!(corners.len(), 6);
        assert!(corners.contains(&[4.0, 0.0, 3.0]) && corners.contains(&[4.0, 2.0, 3.0]));
        let falling_along_y = [0.0, 0.0, 0.0, 4.0, 2.0, 3.0, 1.0, 3.0, 0.0];
        let corners = ramp_corners(&falling_along_y);
        assert_eq!(corners.len(), 6);
        assert!(corners.contains(&[0.0, 0.0, 3.0]) && corners.contains(&[4.0, 0.0, 3.0]));
    }
}
