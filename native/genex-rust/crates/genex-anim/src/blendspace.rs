//! Blend spaces: 1D, directional and cartesian (Delaunay triangulation).
//!
//! A blend space places clips at points of a parameter space and answers, for a position, one
//! weight per clip, summing to 1. Weights come out in the order the points were declared.
//!
//! - [`BlendSpace1D`]: clips on a line (speed). Between two neighbours the weights are linear;
//!   outside the range the nearest end plays alone.
//! - [`BlendSpace2D::cartesian`]: clips at free 2D points (aim pitch and yaw). The points are
//!   triangulated once with spade's robust Delaunay (MIT OR Apache-2.0); inside a triangle the
//!   weights are barycentric, outside the hull the position is projected onto the nearest hull
//!   edge, and points that are all on one line fall back to that nearest edge (Fyrox's
//!   blend-space rule, MIT; the rules only, no code copied). Barycentric weights on a
//!   triangulation are piecewise linear, so a thin triangle never makes them jump.
//! - [`BlendSpace2D::directional`]: clips at velocities (direction × speed), the Meshy 8-way walk
//!   and run set. Weights are Johansen's polar gradient-band interpolation ("Automated
//!   Semi-Procedural Animation for Character Locomotion", 2009; new code from the paper): each
//!   clip's influence is the smallest, over every other clip, of how far the position still is
//!   on its side of the band between the two, measured in speed ratio and in angle (times
//!   [`ANGLE_WEIGHT`]). Only angular and speed neighbours get weight, and the weights change
//!   continuously as the heading sweeps around.
//!
//! Evaluation allocates nothing and takes plain f32 arithmetic with glam's libm `atan2`, so the
//! same position gives the same bits on every destination.

use glam::Vec2;
use spade::{DelaunayTriangulation, HasPosition, Point2, Triangulation};

use crate::error::AnimationError;
use crate::ids::ClipId;

/// Points one blend space may have.
pub const MAX_BLEND_POINTS: usize = 32;
/// How much an angle (in radians) counts against a speed ratio in a directional space
/// (Johansen's polar gradient band).
pub const ANGLE_WEIGHT: f32 = 2.0;
/// The largest query coordinate; a position beyond it (or infinite) is clamped to it.
pub const MAX_QUERY: f32 = 1.0e6;
/// How far below 0 a barycentric weight may be and still count as inside its triangle.
const INSIDE_TOLERANCE: f32 = 1.0e-6;

/// Clips on a line.
#[derive(Clone, Debug, PartialEq)]
pub struct BlendSpace1D {
    positions: Vec<f32>,
    clips: Vec<ClipId>,
    /// Point indices by ascending position.
    order: Vec<u8>,
}

impl BlendSpace1D {
    /// Clips at positions on a line. Refused `animation-graph-invalid`: no point, more than
    /// [`MAX_BLEND_POINTS`], a position that is not finite, or two clips at one position.
    pub fn new(points: &[(f32, ClipId)]) -> Result<BlendSpace1D, AnimationError> {
        check_count(points.len())?;
        if points.iter().any(|(position, _)| !position.is_finite()) {
            return Err(AnimationError::graph_invalid("a blend space point is not finite"));
        }
        let mut order: Vec<u8> = (0..points.len() as u8).collect();
        order.sort_by(|a, b| points[usize::from(*a)].0.total_cmp(&points[usize::from(*b)].0));
        if order.windows(2).any(|pair| points[usize::from(pair[0])].0 == points[usize::from(pair[1])].0) {
            return Err(AnimationError::graph_invalid("two blend space points share one position"));
        }
        Ok(BlendSpace1D { positions: points.iter().map(|(position, _)| *position).collect(), clips: points.iter().map(|(_, clip)| *clip).collect(), order })
    }

    /// Points.
    pub fn len(&self) -> usize {
        self.positions.len()
    }

    /// It has no point (never true for a built space).
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Clips, in declaration order.
    pub fn clips(&self) -> &[ClipId] {
        &self.clips
    }

    /// Each clip's weight at `x` into `out` (declaration order). Outside the range, and for a
    /// NaN (the lowest point), the nearest end plays alone. An `out` shorter than the space is
    /// left as it was.
    pub fn weights(&self, x: f32, out: &mut [f32]) {
        let Some(out) = out.get_mut(..self.len()) else { return };
        out.fill(0.0);
        let position = |rank: usize| self.positions[usize::from(self.order[rank])];
        let last = self.len() - 1;
        if x.is_nan() || x <= position(0) {
            out[usize::from(self.order[0])] = 1.0;
            return;
        }
        if x >= position(last) {
            out[usize::from(self.order[last])] = 1.0;
            return;
        }
        let upper = (1..=last).find(|rank| x < position(*rank)).unwrap_or(last);
        let (low, high) = (position(upper - 1), position(upper));
        let t = (x - low) / (high - low);
        out[usize::from(self.order[upper - 1])] = 1.0 - t;
        out[usize::from(self.order[upper])] = t;
    }
}

/// One triangle with what barycentric weights need, precomputed.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Triangle {
    corners: [u8; 3],
    origin: Vec2,
    edge_b: Vec2,
    edge_c: Vec2,
    inverse_area: f32,
}

/// The two ways a 2D space weighs its points.
#[derive(Clone, Debug, PartialEq)]
enum Layout {
    /// Triangles inside the hull; outside, the hull edge or vertex nearest the position.
    Cartesian { triangles: Vec<Triangle>, hull: Vec<HullEdge> },
    /// Points on one line: the position projected onto it, weighed as a 1D space.
    Line { start: Vec2, axis: Vec2, along: BlendSpace1D },
    /// Polar gradient bands: per point its speed and direction, per ordered pair its band.
    Directional { speeds: Vec<f32>, directions: Vec<Vec2>, bands: Vec<Band> },
}

/// An edge of the hull with its outward normal.
#[derive(Clone, Copy, Debug, PartialEq)]
struct HullEdge {
    ends: [u8; 2],
    outward: Vec2,
}

/// The gradient band from point `i` toward point `j`, in polar terms.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Band {
    /// `2 / (speed_i + speed_j)`: speeds count as ratios of the pair's mean.
    inverse_mean: f32,
    /// The speed component of `i → j`.
    radial: f32,
    /// The angle component of `i → j` (times [`ANGLE_WEIGHT`]).
    angle: f32,
    /// `1 / |i → j|²`.
    inverse_length_squared: f32,
}

/// Clips at 2D points.
#[derive(Clone, Debug, PartialEq)]
pub struct BlendSpace2D {
    points: Vec<Vec2>,
    clips: Vec<ClipId>,
    layout: Layout,
}

/// A point handed to spade, carrying its declaration index.
struct Site {
    position: Point2<f64>,
    index: u8,
}

impl HasPosition for Site {
    type Scalar = f64;

    fn position(&self) -> Point2<f64> {
        self.position
    }
}

fn check_count(count: usize) -> Result<(), AnimationError> {
    if count == 0 || count > MAX_BLEND_POINTS {
        return Err(AnimationError::graph_invalid(format!("a blend space of {count} points (1 to {MAX_BLEND_POINTS})")));
    }
    Ok(())
}

fn check_points(points: &[(Vec2, ClipId)]) -> Result<(), AnimationError> {
    check_count(points.len())?;
    if points.iter().any(|(position, _)| !position.is_finite()) {
        return Err(AnimationError::graph_invalid("a blend space point is not finite"));
    }
    for (index, (position, _)) in points.iter().enumerate() {
        if points[..index].iter().any(|(earlier, _)| earlier == position) {
            return Err(AnimationError::graph_invalid(format!("two blend space points share {position}")));
        }
    }
    Ok(())
}

/// A query position made finite and bounded: NaN is 0, beyond [`MAX_QUERY`] is clamped.
fn bounded(at: Vec2) -> Vec2 {
    let axis = |value: f32| if value.is_nan() { 0.0 } else { value.clamp(-MAX_QUERY, MAX_QUERY) };
    Vec2::new(axis(at.x), axis(at.y))
}

/// The signed angle from `from` to `to`, in `[-π, π]` (libm `atan2`).
fn angle_between(from: Vec2, to: Vec2) -> f32 {
    Vec2::new(from.dot(to), from.perp_dot(to)).to_angle()
}

impl BlendSpace2D {
    /// Clips at free 2D points, triangulated. Refused `animation-graph-invalid`: no point, more
    /// than [`MAX_BLEND_POINTS`], a coordinate that is not finite or that spade cannot place, or
    /// two clips at one point.
    pub fn cartesian(points: &[(Vec2, ClipId)]) -> Result<BlendSpace2D, AnimationError> {
        check_points(points)?;
        let positions: Vec<Vec2> = points.iter().map(|(position, _)| *position).collect();
        let mut delaunay: DelaunayTriangulation<Site> = DelaunayTriangulation::new();
        for (index, position) in positions.iter().enumerate() {
            let site = Site { position: Point2::new(f64::from(position.x), f64::from(position.y)), index: index as u8 };
            delaunay.insert(site).map_err(|error| AnimationError::graph_invalid(format!("blend space point {position} cannot be triangulated: {error:?}")))?;
        }
        let triangles: Vec<Triangle> = delaunay
            .inner_faces()
            .map(|face| face.vertices().map(|vertex| vertex.data().index))
            .filter_map(|corners| triangle(&positions, corners))
            .collect();
        let clips: Vec<ClipId> = points.iter().map(|(_, clip)| *clip).collect();
        let layout = if triangles.is_empty() { line(&positions, &clips)? } else { Layout::Cartesian { hull: hull(&positions, &triangles), triangles } };
        Ok(BlendSpace2D { points: positions, clips, layout })
    }

    /// Clips at velocities (direction × speed; at most one at the origin), weighed by polar
    /// gradient bands. Refused like [`BlendSpace2D::cartesian`].
    pub fn directional(points: &[(Vec2, ClipId)]) -> Result<BlendSpace2D, AnimationError> {
        check_points(points)?;
        let positions: Vec<Vec2> = points.iter().map(|(position, _)| *position).collect();
        let speeds: Vec<f32> = positions.iter().map(|position| position.length()).collect();
        let directions: Vec<Vec2> = positions.iter().map(|position| position.normalize_or_zero()).collect();
        let count = positions.len();
        let mut bands = Vec::with_capacity(count * count);
        for i in 0..count {
            for j in 0..count {
                bands.push(band(speeds[i], directions[i], speeds[j], directions[j]));
            }
        }
        Ok(BlendSpace2D { points: positions, clips: points.iter().map(|(_, clip)| *clip).collect(), layout: Layout::Directional { speeds, directions, bands } })
    }

    /// Points.
    pub fn len(&self) -> usize {
        self.points.len()
    }

    /// It has no point (never true for a built space).
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Points, in declaration order.
    pub fn points(&self) -> &[Vec2] {
        &self.points
    }

    /// Clips, in declaration order.
    pub fn clips(&self) -> &[ClipId] {
        &self.clips
    }

    /// Triangles of a cartesian space (0 when its points are on one line, and for a directional
    /// space).
    pub fn triangle_count(&self) -> usize {
        match &self.layout {
            Layout::Cartesian { triangles, .. } => triangles.len(),
            Layout::Line { .. } | Layout::Directional { .. } => 0,
        }
    }

    /// Each clip's weight at `at` into `out` (declaration order), summing to 1. A NaN coordinate
    /// counts as 0 and one beyond [`MAX_QUERY`] as that bound. An `out` shorter than the space is
    /// left as it was.
    pub fn weights(&self, at: Vec2, out: &mut [f32]) {
        let Some(out) = out.get_mut(..self.len()) else { return };
        out.fill(0.0);
        let at = bounded(at);
        if self.len() == 1 {
            out[0] = 1.0;
            return;
        }
        match &self.layout {
            Layout::Cartesian { triangles, hull } => cartesian_weights(&self.points, triangles, hull, at, out),
            Layout::Line { start, axis, along } => along.weights((at - *start).dot(*axis), out),
            Layout::Directional { speeds, directions, bands } => directional_weights(&self.points, speeds, directions, bands, at, out),
        }
    }
}

/// A triangle of three declared points, or `None` when f32 cannot weigh it (a sliver whose area
/// rounds to 0).
fn triangle(points: &[Vec2], corners: [u8; 3]) -> Option<Triangle> {
    let origin = points[usize::from(corners[0])];
    let edge_b = points[usize::from(corners[1])] - origin;
    let edge_c = points[usize::from(corners[2])] - origin;
    let inverse_area = 1.0 / edge_b.perp_dot(edge_c);
    inverse_area.is_finite().then_some(Triangle { corners, origin, edge_b, edge_c, inverse_area })
}

/// The edges that belong to exactly one triangle (the convex hull of a Delaunay
/// triangulation), sorted, each with its outward normal (away from its triangle's third corner).
fn hull(points: &[Vec2], triangles: &[Triangle]) -> Vec<HullEdge> {
    let mut edges: Vec<([u8; 2], u8)> = triangles
        .iter()
        .flat_map(|triangle| {
            let [a, b, c] = triangle.corners;
            [([a, b], c), ([b, c], a), ([c, a], b)]
        })
        .map(|([a, b], inner)| ([a.min(b), a.max(b)], inner))
        .collect();
    edges.sort_unstable_by_key(|(ends, _)| *ends);
    let mut out = Vec::new();
    let mut index = 0;
    while index < edges.len() {
        let run = edges[index..].iter().take_while(|(ends, _)| *ends == edges[index].0).count();
        if run == 1 {
            let ([a, b], inner) = edges[index];
            let (a_at, b_at, inner_at) = (points[usize::from(a)], points[usize::from(b)], points[usize::from(inner)]);
            let normal = (b_at - a_at).perp();
            let outward = if normal.dot(inner_at - a_at) > 0.0 { -normal } else { normal };
            out.push(HullEdge { ends: [a, b], outward });
        }
        index += run;
    }
    out
}

/// Points on one line as a 1D space along it (from the first point toward the farthest one).
fn line(points: &[Vec2], clips: &[ClipId]) -> Result<Layout, AnimationError> {
    let start = points[0];
    let far = points.iter().copied().fold(start, |best, point| if point.distance_squared(start) > best.distance_squared(start) { point } else { best });
    let axis = (far - start) / (far - start).length_squared();
    let along: Vec<(f32, ClipId)> = points.iter().zip(clips).map(|(point, clip)| ((*point - start).dot(axis), *clip)).collect();
    Ok(Layout::Line { start, axis, along: BlendSpace1D::new(&along)? })
}

fn cartesian_weights(points: &[Vec2], triangles: &[Triangle], hull: &[HullEdge], at: Vec2, out: &mut [f32]) {
    for triangle in triangles {
        let offset = at - triangle.origin;
        let b = offset.perp_dot(triangle.edge_c) * triangle.inverse_area;
        let c = triangle.edge_b.perp_dot(offset) * triangle.inverse_area;
        let a = 1.0 - b - c;
        if a >= -INSIDE_TOLERANCE && b >= -INSIDE_TOLERANCE && c >= -INSIDE_TOLERANCE {
            let (a, b, c) = (a.max(0.0), b.max(0.0), c.max(0.0));
            let total = a + b + c;
            for (corner, weight) in triangle.corners.iter().zip([a, b, c]) {
                out[usize::from(*corner)] = weight / total;
            }
            return;
        }
    }
    outside_hull(points, hull, at, out);
}

/// Weights for a position outside the hull, from the nearest point of the hull's boundary. The
/// outside splits into strips (beyond an edge, projecting inside it) and wedges (beyond a
/// vertex), which never overlap on a convex hull: a strip weighs the edge's ends by where the
/// position projects, a wedge gives its vertex alone. At a strip's side the projection is at the
/// vertex, so the weights meet without comparing distances (whose f32 rounding would switch
/// edges a little early and make the weights step).
fn outside_hull(points: &[Vec2], hull: &[HullEdge], at: Vec2, out: &mut [f32]) {
    for edge in hull {
        let (a, b) = (points[usize::from(edge.ends[0])], points[usize::from(edge.ends[1])]);
        let along = b - a;
        let t = (at - a).dot(along) / along.length_squared();
        if edge.outward.dot(at - a) > 0.0 && (0.0..=1.0).contains(&t) {
            out[usize::from(edge.ends[0])] = 1.0 - t;
            out[usize::from(edge.ends[1])] = t;
            return;
        }
    }
    let vertices = hull.iter().flat_map(|edge| edge.ends);
    let nearest = vertices.min_by(|a, b| points[usize::from(*a)].distance_squared(at).total_cmp(&points[usize::from(*b)].distance_squared(at))).map_or(0, usize::from);
    out[nearest] = 1.0;
}

/// The band from point `i` (speed, direction) toward point `j`.
fn band(speed_i: f32, direction_i: Vec2, speed_j: f32, direction_j: Vec2) -> Band {
    let mean = speed_i + speed_j;
    let inverse_mean = if mean > 0.0 { 2.0 / mean } else { 0.0 };
    let radial = (speed_j - speed_i) * inverse_mean;
    let angle = if speed_i > 0.0 && speed_j > 0.0 { angle_between(direction_i, direction_j) * ANGLE_WEIGHT } else { 0.0 };
    let length_squared = radial * radial + angle * angle;
    let inverse_length_squared = if length_squared > 0.0 { 1.0 / length_squared } else { 0.0 };
    Band { inverse_mean, radial, angle, inverse_length_squared }
}

fn directional_weights(points: &[Vec2], speeds: &[f32], directions: &[Vec2], bands: &[Band], at: Vec2, out: &mut [f32]) {
    let count = points.len();
    let speed = at.length();
    let mut total = 0.0;
    for i in 0..count {
        let angle = if speeds[i] > 0.0 && speed > 0.0 { angle_between(directions[i], at) * ANGLE_WEIGHT } else { 0.0 };
        let mut influence: f32 = 1.0;
        for (j, band) in bands[i * count..(i + 1) * count].iter().enumerate() {
            if j == i {
                continue;
            }
            let radial = (speed - speeds[i]) * band.inverse_mean;
            let reach = (radial * band.radial + angle * band.angle) * band.inverse_length_squared;
            influence = influence.min(1.0 - reach);
            if influence <= 0.0 {
                break;
            }
        }
        out[i] = influence.max(0.0);
        total += out[i];
    }
    if total > f32::MIN_POSITIVE {
        out.iter_mut().for_each(|weight| *weight /= total);
        return;
    }
    // Every band excludes the position (a gap Johansen's bands leave only with odd layouts):
    // the nearest point plays alone.
    let nearest = points.iter().enumerate().fold(0, |best, (index, point)| if point.distance_squared(at) < points[best].distance_squared(at) { index } else { best });
    out.fill(0.0);
    out[nearest] = 1.0;
}
