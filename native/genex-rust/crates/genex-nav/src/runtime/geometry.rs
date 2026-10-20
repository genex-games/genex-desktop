//! Edge geometry for stitching and links: where two boundary edges overlap, an edge clipped to a
//! triangle within a vertical distance, and a point projected onto a segment.
//!
//! Ported from landmass 0.9.3 `src/geometry.rs` (MIT OR Apache-2.0, used under Apache 2.0).
//! Changed: formatting only.

use glam::{FloatExt, Vec2, Vec3, Vec3Swizzles};

/// The overlap of two (anti-parallel, touching) edges, when each end of the overlap on one edge is
/// within `sqrt(intersection_distance_squared)` of the other edge. The portal comes back in
/// `edge_1`'s direction.
pub(crate) fn edge_intersection(
    edge_1: (Vec3, Vec3),
    edge_2: (Vec3, Vec3),
    intersection_distance_squared: f32,
) -> Option<(Vec3, Vec3)> {
    let edge_1_dir = edge_1.1 - edge_1.0;
    let edge_2_on_edge_1_t = (
        (edge_1_dir.dot(edge_2.0 - edge_1.0) / edge_1_dir.length_squared()).clamp(0.0, 1.0),
        (edge_1_dir.dot(edge_2.1 - edge_1.0) / edge_1_dir.length_squared()).clamp(0.0, 1.0),
    );
    if edge_2_on_edge_1_t.0 <= edge_2_on_edge_1_t.1 {
        return None;
    }

    let edge_2_dir = edge_2.1 - edge_2.0;
    let edge_1_on_edge_2_t = (
        (edge_2_dir.dot(edge_1.0 - edge_2.0) / edge_2_dir.length_squared()).clamp(0.0, 1.0),
        (edge_2_dir.dot(edge_1.1 - edge_2.0) / edge_2_dir.length_squared()).clamp(0.0, 1.0),
    );
    if edge_1_on_edge_2_t.0 <= edge_1_on_edge_2_t.1 {
        return None;
    }

    let edge_2_on_edge_1 =
        (edge_2_on_edge_1_t.0 * edge_1_dir + edge_1.0, edge_2_on_edge_1_t.1 * edge_1_dir + edge_1.0);
    let edge_1_on_edge_2 =
        (edge_1_on_edge_2_t.0 * edge_2_dir + edge_2.0, edge_1_on_edge_2_t.1 * edge_2_dir + edge_2.0);

    let too_far = edge_2_on_edge_1.1.distance_squared(edge_1_on_edge_2.0) > intersection_distance_squared
        || edge_2_on_edge_1.0.distance_squared(edge_1_on_edge_2.1) > intersection_distance_squared;
    if too_far {
        return None;
    }
    Some(((edge_2_on_edge_1.1 + edge_1_on_edge_2.0) * 0.5, (edge_2_on_edge_1.0 + edge_1_on_edge_2.1) * 0.5))
}

/// Where `t` along `d1` (from the origin) crosses the line through `off` along `d2`; infinite for
/// parallel lines.
fn intersection_t(d1: Vec2, d2: Vec2, off: Vec2) -> f32 {
    let determinant = -d1.perp_dot(d2);
    if determinant == 0.0 {
        return f32::INFINITY;
    }
    Vec2::new(-d2.y, d2.x).dot(off) / determinant
}

/// Clips `edge` to `triangle` horizontally, keeping only the part within `max_vertical_distance`
/// of the triangle. Returns the interval of `edge`'s parameter that remains, or `None` when the
/// edge misses the triangle or is everywhere too far above or below it.
pub(crate) fn clip_edge_to_triangle(
    triangle: (Vec3, Vec3, Vec3),
    edge: (Vec3, Vec3),
    max_vertical_distance: f32,
) -> Option<(f32, f32)> {
    let triangle_2d = (triangle.0.xy(), triangle.1.xy(), triangle.2.xy());
    let edge_2d = (edge.0.xy(), edge.1.xy());

    let triangle_deltas =
        (triangle_2d.1 - triangle_2d.0, triangle_2d.2 - triangle_2d.1, triangle_2d.0 - triangle_2d.2);
    let edge_delta = edge_2d.1 - edge_2d.0;
    let triangle_off = (triangle_2d.0 - edge_2d.0, triangle_2d.1 - edge_2d.0, triangle_2d.2 - edge_2d.0);

    // Similar to https://gamedev.stackexchange.com/a/63203
    let v0 = triangle_deltas.0;
    let v1 = triangle_deltas.2;
    let denominator = v0.perp_dot(v1);
    let estimate_height = |point: Vec2| {
        let v2 = point - triangle_2d.0;
        let v = v2.perp_dot(v1) / denominator;
        let w = v2.perp_dot(v0) / denominator;
        let u = 1.0 - v - w;
        triangle.0.z * u + triangle.1.z * v + triangle.2.z * w
    };
    let triangle_height_at_edge = (estimate_height(edge_2d.0), estimate_height(edge_2d.1));

    let edge_t = [
        intersection_t(edge_delta, triangle_deltas.0, triangle_off.0),
        intersection_t(edge_delta, triangle_deltas.1, triangle_off.1),
        intersection_t(edge_delta, triangle_deltas.2, triangle_off.2),
    ];
    let deltas = [triangle_deltas.0, triangle_deltas.1, triangle_deltas.2];
    let offs = [triangle_off.0, triangle_off.1, triangle_off.2];

    let mut edge_tmin: f32 = 0.0;
    let mut edge_tmax: f32 = 1.0;
    for side in 0..3 {
        if edge_t[side].is_infinite() {
            if offs[side].perp_dot(deltas[side]) < 0.0 {
                return None;
            }
        } else if edge_delta.perp_dot(deltas[side]) < 0.0 {
            edge_tmin = edge_tmin.max(edge_t[side]);
        } else {
            edge_tmax = edge_tmax.min(edge_t[side]);
        }
    }
    if edge_tmin >= 1.0 || edge_tmax <= 0.0 {
        return None;
    }

    let triangle_height_tmin = triangle_height_at_edge.0.lerp(triangle_height_at_edge.1, edge_tmin);
    let triangle_height_tmax = triangle_height_at_edge.0.lerp(triangle_height_at_edge.1, edge_tmax);
    let edge_height_tmin = edge.0.z.lerp(edge.1.z, edge_tmin);
    let edge_height_tmax = edge.0.z.lerp(edge.1.z, edge_tmax);
    let height_slope = (edge_height_tmax - edge_height_tmin) - (triangle_height_tmax - triangle_height_tmin);

    if height_slope == 0.0 {
        return ((triangle_height_tmin - edge_height_tmin).abs() < max_vertical_distance)
            .then_some((edge_tmin, edge_tmax));
    }

    let t0 = (max_vertical_distance - edge_height_tmin + triangle_height_tmin) / height_slope;
    let t1 = (-max_vertical_distance - edge_height_tmin + triangle_height_tmin) / height_slope;
    let (t0, t1) = (t0.min(t1), t0.max(t1));
    if t0 >= 1.0 || t1 <= 0.0 {
        return None;
    }
    let (t0, t1) = (t0.max(0.0), t1.min(1.0));
    Some((edge_tmin.lerp(edge_tmax, t0), edge_tmin.lerp(edge_tmax, t1)))
}

/// Projects `point` onto the segment; returns the projection and its fraction along the segment.
pub(crate) fn project_point_to_line_segment(point: Vec3, (start, end): (Vec3, Vec3)) -> (Vec3, f32) {
    let dir = end - start;
    let dir_length_squared = dir.length_squared();
    if dir_length_squared == 0.0 {
        return (start, 0.0);
    }
    let fraction = ((point - start).dot(dir) / dir_length_squared).clamp(0.0, 1.0);
    (dir * fraction + start, fraction)
}
