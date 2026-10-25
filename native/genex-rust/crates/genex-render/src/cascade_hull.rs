//! The sides of a cascade's cull view seen along the light (lane FQ): the light-space polygon of
//! the receivers that read the cascade, not the box around it.
//!
//! Horde 10k (HZ-1) held each cascade's cull view to the light-space box of its receivers' frustum
//! (the camera's frustum from its near plane to the cascade's end), widened by the lookups' reach.
//! Seen along the light that frustum is a convex polygon of up to six sides, and when the camera
//! looks across the light's axes the box around it holds up to twice its area: at 10,000 ghouls
//! the crowd beside and behind the camera was drawn into cascades whose receivers it could not
//! shadow, and the casters' triangles were the cascades' cost. A caster whose light-space
//! footprint misses the polygon widened by the reach cannot shadow a receiver inside it at any
//! depth (each edge is a plane along the light), so the cull drops it and the picture holds.
//!
//! A cull view keeps six planes (`[[f32; 4]; 6]`): its far plane and five sides, the box's four
//! slots and the open near plane's (pancaking keeps the near side open whatever fills that slot).
//! The sides are chosen greedily from the polygon's widened edges and the box's sides, each pick
//! the one that leaves the least of the map's neighbourhood: exactly the polygon (cut to the box)
//! when it has five sides or fewer, a little more otherwise. Every side moves outward by whole
//! steps, so a camera moving within a step keeps its cull view (and the static cache's key).

use glam::{Vec2, Vec3};

/// The sides a cascade's cull view holds besides its far plane.
pub const SIDES_MAX: usize = 5;
/// The neighbourhood of the map (light NDC) whose area the chosen sides are measured by: the map
/// and as much again around it, so a side left open costs what it lets in.
const NEIGHBOURHOOD: f32 = 2.0;
/// Below this a polygon edge is no edge (light NDC units).
const DEGENERATE: f32 = 1e-6;

/// The convex hull of `points`, counter-clockwise, without collinear points (Andrew's monotone
/// chain). Fewer than three distinct points give what there is.
pub fn hull(points: &[Vec2]) -> Vec<Vec2> {
    let mut sorted: Vec<Vec2> = points.iter().copied().filter(|p| p.is_finite()).collect();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    sorted.dedup();
    if sorted.len() < 3 {
        return sorted;
    }
    let cross = |o: Vec2, a: Vec2, b: Vec2| (a - o).perp_dot(b - o);
    let mut lower: Vec<Vec2> = Vec::with_capacity(sorted.len());
    for &p in &sorted {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<Vec2> = Vec::with_capacity(sorted.len());
    for &p in sorted.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// A side: the half-plane `a x + b y + c >= 0` of light NDC (`(a, b)` a unit inward normal).
pub type Side = Vec3;

/// The inward sides of counter-clockwise `polygon`, each moved outward by `reach` and then to
/// the next whole `step`.
fn widened_edges(polygon: &[Vec2], reach: f32, step: f32) -> Vec<Side> {
    let mut sides = Vec::with_capacity(polygon.len());
    for (i, &from) in polygon.iter().enumerate() {
        let to = polygon[(i + 1) % polygon.len()];
        let along = to - from;
        let length = along.length();
        if length <= DEGENERATE {
            continue;
        }
        let inward = along.perp() / length;
        sides.push(Vec3::new(inward.x, inward.y, outward(-inward.dot(from) + reach, step)));
    }
    sides
}

/// `c` moved outward (up) to the next whole `step`.
fn outward(c: f32, step: f32) -> f32 {
    if step > 0.0 { libm::ceilf(c / step) * step } else { c }
}

/// `region` (a convex polygon) cut by `side` (Sutherland and Hodgman).
fn cut(region: &[Vec2], side: Side) -> Vec<Vec2> {
    let inside = |p: Vec2| side.x * p.x + side.y * p.y + side.z;
    let mut out = Vec::with_capacity(region.len() + 1);
    for (i, &a) in region.iter().enumerate() {
        let b = region[(i + 1) % region.len()];
        let (da, db) = (inside(a), inside(b));
        if da >= 0.0 {
            out.push(a);
        }
        if (da >= 0.0) != (db >= 0.0) {
            out.push(a + (b - a) * (da / (da - db)));
        }
    }
    out
}

/// The area of convex `polygon`.
fn area(polygon: &[Vec2]) -> f32 {
    let mut twice = 0.0;
    for (i, &a) in polygon.iter().enumerate() {
        twice += a.perp_dot(polygon[(i + 1) % polygon.len()]);
    }
    0.5 * twice.abs()
}

/// Up to [`SIDES_MAX`] sides holding the receivers whose light-space points are `points` (light
/// NDC), widened by `reach` and stepped by `step`, chosen from the hull's edges and `boxed` (the
/// box's sides, already widened, stepped and held to the map): each pick leaves the least of the
/// map's neighbourhood. Every point within `reach` of the hull is inside every side.
pub fn sides(points: &[Vec2], boxed: &[Side], reach: f32, step: f32) -> Vec<Side> {
    let polygon = hull(points);
    let mut candidates: Vec<Side> = boxed.to_vec();
    if polygon.len() >= 3 {
        candidates.extend(widened_edges(&polygon, reach, step));
    }
    let n = NEIGHBOURHOOD;
    let mut region = vec![Vec2::new(-n, -n), Vec2::new(n, -n), Vec2::new(n, n), Vec2::new(-n, n)];
    let mut chosen = Vec::with_capacity(SIDES_MAX);
    while chosen.len() < SIDES_MAX && !candidates.is_empty() {
        let left = area(&region);
        let (best, best_area) = candidates
            .iter()
            .enumerate()
            .map(|(i, side)| (i, area(&cut(&region, *side))))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap_or((0, left));
        if best_area >= left {
            break;
        }
        let side = candidates.swap_remove(best);
        region = cut(&region, side);
        chosen.push(side);
    }
    chosen
}
