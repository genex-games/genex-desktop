//! Shape validation (CONTRACT.md §6.2, §6.3): numbers, degenerate shapes (`BadShape`), and each
//! shape in the core's Y-up frame, the heightfield's rows reversed for `upAxis: "z"`.

use crate::axes::{axis_in, extent_in, vec_in};
use crate::backend::ShapeSpec;
use crate::body::Shape;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::limits::Limits;
use crate::num::{finite, finite_vec, integer, non_negative};
use crate::types::{UpAxis, Vec3};

/// The fewest points a hull takes.
pub const HULL_POINTS_MIN: usize = 4;
/// The fewest rows or columns of a heightfield.
pub const HEIGHTFIELD_SIDE_MIN: u32 = 2;
/// How far from a plane, relative to a hull's extent, its points must reach to make a volume.
const FLAT_TOLERANCE: f64 = 1e-6;

/// What a body's shapes add up to, for the limits and the memory model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ShapeFacts {
    /// The most points of any one hull.
    pub hull_points_max: usize,
    /// Hull points over every hull.
    pub hull_points: usize,
    /// Trimesh vertices.
    pub trimesh_vertices: usize,
    /// Trimesh triangles.
    pub triangles: usize,
    /// Heightfield samples.
    pub heightfield_samples: usize,
}

/// Checks `shape` and maps it to the core's frame, adding to `facts`.
pub(crate) fn validate_shape(
    shape: &Shape,
    up: UpAxis,
    limits: &Limits,
    facts: &mut ShapeFacts,
) -> Result<ShapeSpec, PhysicsFailure> {
    match shape {
        Shape::Box { half } => Ok(ShapeSpec::Cuboid { half: extent_in(up, sizes(*half, "half")?) }),
        Shape::Sphere { radius } => Ok(ShapeSpec::Ball { radius: extent(*radius, "radius")? }),
        Shape::Capsule { half_height, radius, axis } => {
            let half_height = non_negative(*half_height, "halfHeight")?;
            let radius = extent(*radius, "radius")?;
            Ok(ShapeSpec::Capsule { half_height, radius, axis: axis_in(up, *axis) })
        }
        Shape::Hull { points } => hull(points, up, facts),
        Shape::Trimesh { vertices, indices } => trimesh(vertices, indices, up, facts),
        Shape::Heightfield { rows, cols, heights, size } => {
            heightfield(HeightfieldDesc { rows: *rows, cols: *cols, heights, size: *size }, up, limits, facts)
        }
    }
}

/// A size that must be above 0: negative is `OutOfRange`, zero `BadShape`.
fn extent(x: f64, what: &str) -> Result<f32, PhysicsFailure> {
    let value = non_negative(x, what)?;
    if value == 0.0 {
        return fail(PhysicsError::BadShape, format!("{what} is zero"));
    }
    Ok(value)
}

/// Three sizes that must each be above 0.
fn sizes(v: Vec3, what: &str) -> Result<[f32; 3], PhysicsFailure> {
    let values = [non_negative(v[0], what)?, non_negative(v[1], what)?, non_negative(v[2], what)?];
    if values.contains(&0.0) {
        return fail(PhysicsError::BadShape, format!("{what} has a zero extent"));
    }
    Ok(values)
}

fn points_in(points: &[Vec3], up: UpAxis, what: &str) -> Result<Vec<[f32; 3]>, PhysicsFailure> {
    points.iter().map(|p| Ok(vec_in(up, finite_vec(*p, what)?))).collect()
}

fn hull(points: &[Vec3], up: UpAxis, facts: &mut ShapeFacts) -> Result<ShapeSpec, PhysicsFailure> {
    let points = points_in(points, up, "hull point")?;
    if points.len() < HULL_POINTS_MIN || is_flat(&points) {
        return fail(PhysicsError::BadShape, "a hull needs 4 points that are not all in one plane");
    }
    facts.hull_points_max = facts.hull_points_max.max(points.len());
    facts.hull_points += points.len();
    Ok(ShapeSpec::Hull { points })
}

fn trimesh(
    vertices: &[Vec3],
    indices: &[[f64; 3]],
    up: UpAxis,
    facts: &mut ShapeFacts,
) -> Result<ShapeSpec, PhysicsFailure> {
    let vertices = points_in(vertices, up, "trimesh vertex")?;
    let last = u32::try_from(vertices.len()).unwrap_or(u32::MAX).checked_sub(1);
    let mut triangles = Vec::with_capacity(indices.len());
    for triangle in indices {
        let Some(last) = last else {
            return fail(PhysicsError::OutOfRange, "a trimesh index names no vertex");
        };
        let index = |i: usize| integer(triangle[i], "trimesh index", 0, last);
        triangles.push([index(0)?, index(1)?, index(2)?]);
    }
    if !triangles.iter().any(|triangle| has_area(&vertices, *triangle)) {
        return fail(PhysicsError::BadShape, "a trimesh needs a triangle with an area");
    }
    facts.trimesh_vertices += vertices.len();
    facts.triangles += triangles.len();
    Ok(ShapeSpec::Trimesh { vertices, indices: triangles })
}

/// Whether a triangle's corners span an area: its edges' cross product is not zero in f64, where
/// each product of two f32 differences is exact enough to tell zero from not.
fn has_area(vertices: &[[f32; 3]], triangle: [u32; 3]) -> bool {
    let corner = |i: usize| vertices.get(triangle[i] as usize).map_or([0.0; 3], |v| v.map(f64::from));
    let (a, b, c) = (corner(0), corner(1), corner(2));
    norm_squared(cross(sub(b, a), sub(c, a))) > 0.0
}

/// A heightfield as given, before checks.
struct HeightfieldDesc<'a> {
    rows: f64,
    cols: f64,
    heights: &'a [f64],
    size: Vec3,
}

fn heightfield(
    desc: HeightfieldDesc<'_>,
    up: UpAxis,
    limits: &Limits,
    facts: &mut ShapeFacts,
) -> Result<ShapeSpec, PhysicsFailure> {
    let samples_max = limits.heightfield_samples;
    let rows = integer(desc.rows, "rows", HEIGHTFIELD_SIDE_MIN, samples_max)? as usize;
    let cols = integer(desc.cols, "cols", HEIGHTFIELD_SIDE_MIN, samples_max)? as usize;
    let samples = rows.saturating_mul(cols);
    if samples > samples_max as usize {
        return fail(PhysicsError::OutOfRange, "rows × cols is above limits.heightfieldSamples");
    }
    if desc.heights.len() != samples {
        return fail(PhysicsError::OutOfRange, "heights does not hold rows × cols values");
    }
    let heights: Vec<f32> = desc.heights.iter().map(|h| finite(*h, "height")).collect::<Result<_, _>>()?;
    let scale = extent_in(up, sizes(desc.size, "size")?);
    facts.heightfield_samples += samples;
    let heights = match up {
        UpAxis::Y => heights,
        UpAxis::Z => reverse_rows(&heights, cols),
    };
    Ok(ShapeSpec::Heightfield { rows, cols, heights, scale })
}

/// The grid with its row order reversed (§6.3): caller row r is internal row rows − 1 − r.
fn reverse_rows(heights: &[f32], cols: usize) -> Vec<f32> {
    heights.chunks(cols).rev().flatten().copied().collect()
}

/// Whether every point lies in one plane (or on one line, or at one point), to within
/// `FLAT_TOLERANCE` of the points' extent.
fn is_flat(points: &[[f32; 3]]) -> bool {
    let wide: Vec<[f64; 3]> = points.iter().map(|p| p.map(f64::from)).collect();
    let Some(origin) = wide.first().copied() else { return true };
    let rel = |p: &[f64; 3]| sub(*p, origin);
    let far = farthest(&wide, |p| dot(rel(p), rel(p)));
    let reach = dot(rel(&far), rel(&far)).sqrt();
    if reach == 0.0 {
        return true;
    }
    let edge = rel(&far);
    let side = farthest(&wide, |p| norm_squared(cross(edge, rel(p))));
    let normal = cross(edge, rel(&side));
    let normal_length = norm_squared(normal).sqrt();
    if normal_length == 0.0 {
        return true;
    }
    let depth = wide.iter().map(|p| dot(normal, rel(p)).abs() / normal_length).fold(0.0, f64::max);
    depth <= FLAT_TOLERANCE * reach
}

fn farthest(points: &[[f64; 3]], measure: impl Fn(&[f64; 3]) -> f64) -> [f64; 3] {
    let Some((first, rest)) = points.split_first() else { return [0.0; 3] };
    let mut best = *first;
    let mut best_value = measure(&best);
    for point in rest {
        let value = measure(point);
        if value > best_value {
            best = *point;
            best_value = value;
        }
    }
    best
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm_squared(a: [f64; 3]) -> f64 {
    dot(a, a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_hulls_are_found_and_volumes_are_not() {
        let square = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.5, 0.5, 0.0]];
        assert!(is_flat(&square));
        let line = [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0]];
        assert!(is_flat(&line));
        assert!(is_flat(&[[2.0, 2.0, 2.0]; 4]));
        let tetrahedron = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        assert!(!is_flat(&tetrahedron));
    }

    #[test]
    fn rows_reverse_and_columns_keep_their_order() {
        let grid = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert_eq!(reverse_rows(&grid, 3), vec![4.0, 5.0, 6.0, 1.0, 2.0, 3.0]);
    }
}
