//! Shape builders for [`MeshData`] (AAA review WP-8): the shapes a box cannot make without reading
//! as a box. A [`Profile`] is a 2D outline (a polygon or a polyline, metres) whose corners
//! [`Profile::bevel`] rounds; [`MeshData::extrude`] pushes one along z with bevelled caps,
//! [`MeshData::lathe`] turns one about y, [`MeshData::sweep`] carries one along a path and
//! [`MeshData::tube`] is a sweep of a circle. [`MeshData::rounded_cuboid`] is a box with every edge
//! and corner rounded (one facet a side: a chamfer).
//!
//! Every builder appends to the mesh, writes its own normals (smooth where the outline turns less
//! than [`PROFILE_SMOOTH_DEGREES`], hard where it turns more) and its UVs in tiles of `metres`
//! along the surface (u round the outline, v along the length), so a texture keeps its real size
//! on every face. Trigonometry is the facade's libm math, so the same call builds the same bytes on
//! every destination. Numbers out of range are clamped, never refused: a radius past half the
//! shape's size rounds as far as it can, a segment count is held to its range, and a profile that
//! is not finite reaches `gfx.mesh` as `mesh-not-finite`.

use crate::math::{self, Vec2, Vec3};
use crate::mesh::{MeshData, box_faces};

/// The most facets across one rounded corner or edge ([`Profile::bevel`],
/// [`MeshData::rounded_cuboid`]).
pub const ROUND_SEGMENTS_MAX: u32 = 16;
/// The most segments round a lathe, a circle or a tube.
pub const LATHE_SEGMENTS_MAX: u32 = 256;
/// An outline that turns less than this many degrees at a point is smooth there (one normal);
/// a sharper turn keeps a hard edge.
pub const PROFILE_SMOOTH_DEGREES: f32 = 35.0;
/// The facets of an extrusion's rounded cap edge ([`MeshData::extrude`]'s `bevel`).
pub const EXTRUDE_BEVEL_SEGMENTS: u32 = 3;
/// How far a sweep may widen its profile at a sharp bend of its path (the mitre).
const MITRE_MAX: f32 = 4.0;
/// Lengths and areas under this are none.
const EPSILON: f32 = 1.0e-6;

/// A 2D outline in metres: a closed polygon (counter-clockwise; [`Profile::polygon`] turns a
/// clockwise one round) or an open polyline. Its outside, the side its normals face, is on the
/// right as you walk it: a counter-clockwise polygon faces out, a lathe profile walked from the
/// bottom to the top at positive x faces away from the axis.
///
/// ```
/// use genex::prelude::*;
/// use genex::{MeshData, Profile};
///
/// // A 9 x 4.5 cm bench slat with 8 mm rounded edges, 1.6 m long, its cut ends bevelled 4 mm.
/// let slat = Profile::rect(0.09, 0.045).bevel(0.008, 4);
/// let mut bench = MeshData::new();
/// bench.extrude(&slat, 1.6, 0.004, 1.0);
/// assert!(bench.check().is_ok());
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Profile {
    /// The outline's points, in order.
    pub points: Vec<Vec2>,
    /// Whether the last point joins the first.
    pub closed: bool,
}

impl Profile {
    /// A closed polygon through `points` (made counter-clockwise; repeated points dropped).
    pub fn polygon(points: impl Into<Vec<Vec2>>) -> Profile {
        let mut profile = Profile { points: deduplicated(points.into(), true), closed: true };
        if signed_area(&profile.points) < 0.0 {
            profile.points.reverse();
        }
        profile
    }

    /// An open polyline through `points` (repeated points dropped).
    pub fn polyline(points: impl Into<Vec<Vec2>>) -> Profile {
        Profile { points: deduplicated(points.into(), false), closed: false }
    }

    /// A `width` x `height` rectangle centred on the origin.
    pub fn rect(width: f32, height: f32) -> Profile {
        let (x, y) = (width.abs() / 2.0, height.abs() / 2.0);
        Profile::polygon(vec![Vec2::new(-x, -y), Vec2::new(x, -y), Vec2::new(x, y), Vec2::new(-x, y)])
    }

    /// A circle of `radius` round the origin, `segments` sides (3 to [`LATHE_SEGMENTS_MAX`]),
    /// its first point on +x.
    pub fn circle(radius: f32, segments: u32) -> Profile {
        let sides = segments.clamp(3, LATHE_SEGMENTS_MAX);
        let points = (0..sides).map(|k| turned(Vec2::new(radius.abs(), 0.0), math::TAU * k as f32 / sides as f32)).collect::<Vec<_>>();
        Profile { points, closed: true }
    }

    /// A `width` x `height` rectangle with corners rounded to `radius` in `segments` facets.
    pub fn rounded_rect(width: f32, height: f32, radius: f32, segments: u32) -> Profile {
        Profile::rect(width, height).bevel(radius, segments)
    }

    /// The outline with every corner rounded to `radius` in `segments` facets (1: a chamfer; up
    /// to [`ROUND_SEGMENTS_MAX`]); an open polyline keeps its two ends. A radius too big for a
    /// corner's edges rounds as far as half the shorter one allows; 0 or not finite changes
    /// nothing.
    pub fn bevel(&self, radius: f32, segments: u32) -> Profile {
        let count = self.points.len();
        if !(radius.is_finite() && radius > 0.0) || count < 3 {
            return self.clone();
        }
        let facets = segments.clamp(1, ROUND_SEGMENTS_MAX);
        let mut points = Vec::with_capacity(count * (facets as usize + 1));
        for at in 0..count {
            let end = !self.closed && (at == 0 || at == count - 1);
            let corner = self.points[at];
            if end {
                points.push(corner);
                continue;
            }
            let (before, after) = (self.points[(at + count - 1) % count], self.points[(at + 1) % count]);
            round_corner(&mut points, [before, corner, after], radius, facets);
        }
        Profile { points: deduplicated(points, self.closed), closed: self.closed }
    }

    /// The outline's length (with the closing edge of a polygon).
    pub fn length(&self) -> f32 {
        self.edges().map(|(a, b)| self.points[a].distance(self.points[b])).sum()
    }

    /// Each edge as the indices of its two points.
    fn edges(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        let count = self.points.len();
        let edges = if self.closed && count > 2 { count } else { count.saturating_sub(1) };
        (0..edges).map(move |at| (at, (at + 1) % count))
    }

    /// Each edge's outward unit normal (the right of its direction).
    fn edge_normals(&self) -> Vec<Vec2> {
        self.edges()
            .map(|(a, b)| {
                let d = self.points[b] - self.points[a];
                Vec2::new(d.y, -d.x).normalize_or(Vec2::Y)
            })
            .collect()
    }

    /// Each edge's two ends as the side of a shape samples them: (point, normal, distance round
    /// the outline), the normal shared with the neighbouring edge where the outline is smooth.
    fn side_samples(&self) -> Vec<[(Vec2, Vec2, f32); 2]> {
        let normals = self.edge_normals();
        let edges: Vec<(usize, usize)> = self.edges().collect();
        let count = edges.len();
        let smooth_dot = math::cos(math::to_radians(PROFILE_SMOOTH_DEGREES));
        // The normal at an edge's end `point`, from `edge` and its neighbour `other` (if any).
        let at_end = |edge: usize, other: Option<usize>| match other {
            Some(other) if normals[edge].dot(normals[other]) >= smooth_dot => (normals[edge] + normals[other]).normalize_or(normals[edge]),
            _ => normals[edge],
        };
        let mut travelled = 0.0;
        let mut out = Vec::with_capacity(count);
        for (at, (a, b)) in edges.iter().copied().enumerate() {
            let previous = if at > 0 { Some(at - 1) } else { self.closed.then_some(count - 1) };
            let next = if at + 1 < count { Some(at + 1) } else { self.closed.then_some(0) };
            let length = self.points[a].distance(self.points[b]);
            out.push([(self.points[a], at_end(at, previous), travelled), (self.points[b], at_end(at, next), travelled + length)]);
            travelled += length;
        }
        out
    }

    /// The points pushed `inset` metres inwards (against their normals), each corner's mitre
    /// held to [`MITRE_MAX`] times the inset.
    fn inset(&self, inset: f32) -> Vec<Vec2> {
        if inset == 0.0 {
            return self.points.clone();
        }
        let normals = self.edge_normals();
        let count = self.points.len();
        let edges = normals.len();
        (0..count)
            .map(|at| {
                let before = if at > 0 { Some(at - 1) } else { self.closed.then_some(edges - 1) };
                let after = (at < edges).then_some(at);
                let mitre = match (before, after) {
                    (Some(b), Some(a)) => mitre(normals[b], normals[a]),
                    (Some(only), None) | (None, Some(only)) => normals[only],
                    (None, None) => Vec2::ZERO,
                };
                self.points[at] - mitre * inset
            })
            .collect()
    }
}

/// The offset direction that moves both edges of a corner one unit along their normals.
fn mitre(a: Vec2, b: Vec2) -> Vec2 {
    let sum = a + b;
    let along = 1.0 + a.dot(b);
    if along < EPSILON {
        return a;
    }
    let m = sum / along;
    if m.length() > MITRE_MAX { m.normalize_or(a) * MITRE_MAX } else { m }
}

/// `points` without repeats in a row (nor, closed, a last point on the first).
fn deduplicated(points: Vec<Vec2>, closed: bool) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::with_capacity(points.len());
    for point in points {
        if out.last().is_none_or(|last| last.distance(point) > EPSILON) {
            out.push(point);
        }
    }
    let wraps = closed && out.len() > 1 && out[0].distance(out[out.len() - 1]) <= EPSILON;
    if wraps {
        out.pop();
    }
    out
}

/// Twice the polygon's signed area (positive counter-clockwise).
fn signed_area(points: &[Vec2]) -> f32 {
    let count = points.len();
    (0..count).map(|at| points[at].perp_dot(points[(at + 1) % count])).sum()
}

/// `v` turned `radians` counter-clockwise.
fn turned(v: Vec2, radians: f32) -> Vec2 {
    let (s, c) = math::sin_cos(radians);
    Vec2::new(c * v.x - s * v.y, s * v.x + c * v.y)
}

/// Push the arc that rounds `corner` between `before` and `after`.
fn round_corner(points: &mut Vec<Vec2>, [before, corner, after]: [Vec2; 3], radius: f32, facets: u32) {
    let (to_before, to_after) = (before - corner, after - corner);
    let (d1, d2) = (to_before.normalize_or_zero(), to_after.normalize_or_zero());
    let cos_angle = d1.dot(d2).clamp(-1.0, 1.0);
    let straight = d1 == Vec2::ZERO || d2 == Vec2::ZERO || cos_angle < -1.0 + EPSILON;
    if straight {
        points.push(corner);
        return;
    }
    let half = math::acos(cos_angle) / 2.0;
    let reach = (radius / math::tan(half)).min(to_before.length().min(to_after.length()) / 2.0);
    let centre = corner + (d1 + d2).normalize_or_zero() * (reach / math::cos(half));
    let (start, end) = (corner + d1 * reach - centre, corner + d2 * reach - centre);
    let sweep = math::atan2(start.perp_dot(end), start.dot(end));
    for k in 0..=facets {
        points.push(centre + turned(start, sweep * k as f32 / facets as f32));
    }
}

/// The triangles of a simple counter-clockwise polygon (ear clipping), as indices into it; a
/// polygon with no ear left fans the rest.
fn triangulate(points: &[Vec2]) -> Vec<[usize; 3]> {
    let mut left: Vec<usize> = (0..points.len()).collect();
    let mut out = Vec::with_capacity(points.len().saturating_sub(2));
    while left.len() > 3 {
        let Some(ear) = find_ear(points, &left) else { break };
        let count = left.len();
        out.push([left[(ear + count - 1) % count], left[ear], left[(ear + 1) % count]]);
        left.remove(ear);
    }
    for at in 1..left.len().saturating_sub(1) {
        out.push([left[0], left[at], left[at + 1]]);
    }
    out
}

/// A convex corner of the polygon `left` with no other point inside its triangle.
fn find_ear(points: &[Vec2], left: &[usize]) -> Option<usize> {
    let count = left.len();
    (0..count).find(|&at| {
        let (a, b, c) = (points[left[(at + count - 1) % count]], points[left[at]], points[left[(at + 1) % count]]);
        if (b - a).perp_dot(c - b) <= 0.0 {
            return false;
        }
        let inside = |p: Vec2| (b - a).perp_dot(p - a) >= 0.0 && (c - b).perp_dot(p - b) >= 0.0 && (a - c).perp_dot(p - c) >= 0.0;
        !left.iter().any(|&other| {
            let p = points[other];
            p != a && p != b && p != c && inside(p)
        })
    })
}

/// The stops along one axis of a rounded box from `a` to `b`: the flat span's ends and, towards
/// each edge, `steps` stops spaced so the facets turn evenly round the face's half of the edge.
fn round_stops(a: f32, b: f32, radius: f32, steps: u32) -> Vec<f32> {
    let mut stops = vec![a];
    for k in (1..steps).rev() {
        stops.push(a + radius - radius * math::tan(math::FRAC_PI_4 * k as f32 / steps as f32));
    }
    stops.extend([a + radius, b - radius]);
    for k in 1..steps {
        stops.push(b - radius + radius * math::tan(math::FRAC_PI_4 * k as f32 / steps as f32));
    }
    stops.push(b);
    stops.dedup_by(|later, earlier| *later - *earlier <= EPSILON);
    stops
}

/// The index of `v`'s largest component.
fn major_axis(v: Vec3) -> usize {
    let a = v.abs();
    if a.x >= a.y && a.x >= a.z {
        return 0;
    }
    if a.y >= a.z { 1 } else { 2 }
}

/// A sweep's frame at a path point: where it is, its forward, right and up, and how far the
/// profile widens along `bend` at a corner.
#[derive(Clone, Copy)]
struct Frame {
    at: Vec3,
    forward: Vec3,
    right: Vec3,
    up: Vec3,
    bend: Vec3,
    widen: f32,
}

impl Frame {
    fn place(&self, p: Vec2) -> Vec3 {
        let offset = self.right * p.x + self.up * p.y;
        self.at + offset + self.bend * (offset.dot(self.bend) * (self.widen - 1.0))
    }

    fn turn(&self, n: Vec2) -> Vec3 {
        (self.right * n.x + self.up * n.y).normalize_or(self.up)
    }
}

/// The path without repeated points.
fn path_points(path: &[Vec3]) -> Vec<Vec3> {
    let mut out: Vec<Vec3> = Vec::with_capacity(path.len());
    for point in path {
        if out.last().is_none_or(|last| last.distance(*point) > EPSILON) {
            out.push(*point);
        }
    }
    out
}

/// Rotation-minimising frames along `path` (double reflection), starting upright: up is the
/// world's +y laid across the first segment (+x when that segment is vertical).
fn frames(path: &[Vec3]) -> Vec<Frame> {
    let count = path.len();
    let direction = |at: usize| (path[at + 1] - path[at]).normalize_or(Vec3::NEG_Z);
    let tangents: Vec<Vec3> = (0..count)
        .map(|at| match at {
            0 => direction(0),
            _ if at == count - 1 => direction(at - 1),
            _ => (direction(at - 1) + direction(at)).normalize_or(direction(at)),
        })
        .collect();
    let first = tangents[0];
    let seed_up = if first.dot(Vec3::Y).abs() > 0.99 { Vec3::X } else { Vec3::Y };
    let mut up = (seed_up - first * first.dot(seed_up)).normalize_or(Vec3::Y);
    let mut out = Vec::with_capacity(count);
    for at in 0..count {
        if at > 0 {
            up = reflected_up(path[at] - path[at - 1], tangents[at - 1], tangents[at], up);
        }
        let forward = tangents[at];
        let (bend, widen) = bend_at(path, at, forward);
        out.push(Frame { at: path[at], forward, right: forward.cross(up).normalize_or(Vec3::X), up, bend, widen });
    }
    out
}

/// The next frame's up by double reflection across the segment `step`.
fn reflected_up(step: Vec3, tangent: Vec3, next_tangent: Vec3, up: Vec3) -> Vec3 {
    let c1 = step.dot(step);
    if c1 < EPSILON {
        return up;
    }
    let up_l = up - step * (2.0 / c1 * step.dot(up));
    let tangent_l = tangent - step * (2.0 / c1 * step.dot(tangent));
    let v2 = next_tangent - tangent_l;
    let c2 = v2.dot(v2);
    let reflected = if c2 < EPSILON { up_l } else { up_l - v2 * (2.0 / c2 * v2.dot(up_l)) };
    (reflected - next_tangent * next_tangent.dot(reflected)).normalize_or(up)
}

/// At an inner path point, the direction the path bends towards and how much the profile widens
/// along it to keep its thickness through the corner (1 elsewhere).
fn bend_at(path: &[Vec3], at: usize, forward: Vec3) -> (Vec3, f32) {
    if at == 0 || at + 1 >= path.len() {
        return (Vec3::ZERO, 1.0);
    }
    let incoming = (path[at] - path[at - 1]).normalize_or(forward);
    let outgoing = (path[at + 1] - path[at]).normalize_or(forward);
    let cos_half = forward.dot(incoming);
    let bend = (outgoing - incoming).normalize_or_zero();
    if bend == Vec3::ZERO || cos_half <= EPSILON {
        return (Vec3::ZERO, 1.0);
    }
    (bend, (1.0 / cos_half).min(MITRE_MAX))
}

/// A valid tile size: 0, negative or not finite reads as 1 m.
pub(crate) fn tile_metres(metres: f32) -> f32 {
    if metres.is_finite() && metres > 0.0 { metres } else { 1.0 }
}

impl MeshData {
    /// Add a quad of four vertices of its own facing the way `normals` point on average, from
    /// `corners` in order round it; a triangle with no area is left out (a lathe's pole).
    pub(crate) fn facing_quad(&mut self, corners: [Vec3; 4], normals: [Vec3; 4], uvs: [Vec2; 4]) -> &mut MeshData {
        let facing = normals.iter().copied().sum::<Vec3>();
        let first = self.positions.len() as u32;
        for at in 0..4 {
            self.vertex(corners[at], normals[at], uvs[at]);
        }
        for [a, b, c] in [[0, 1, 2], [0, 2, 3]] {
            self.facing_triangle(first, [a, b, c], facing);
        }
        self
    }

    /// Add the triangle of the vertices `first + corners`, wound to face `facing`, unless it has
    /// no area.
    pub(crate) fn facing_triangle(&mut self, first: u32, [a, b, c]: [u32; 3], facing: Vec3) {
        let at = |k: u32| self.positions[(first + k) as usize];
        let cross = (at(b) - at(a)).cross(at(c) - at(a));
        if cross.length_squared() <= EPSILON * EPSILON {
            return;
        }
        if cross.dot(facing) >= 0.0 {
            self.triangle(first + a, first + b, first + c);
        } else {
            self.triangle(first + a, first + c, first + b);
        }
    }

    /// Add the box from `min` to `max` with every edge and corner rounded to `radius` (held to
    /// half its smallest side) in `segments` facets across each edge (even, 2 the least; up to
    /// [`ROUND_SEGMENTS_MAX`]): a chamfer at 2, a soft cushion at 8. The flat parts keep exact
    /// normals; the UVs are each face's in tiles of `metres` (as [`MeshData::cuboid`]'s). A radius
    /// of 0 builds the plain cuboid.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::MeshData;
    ///
    /// // A 0.6 x 0.45 x 0.05 m table top with 1 cm rounded edges.
    /// let mut top = MeshData::new();
    /// top.rounded_cuboid(vec3(-0.3, 0.7, -0.225), vec3(0.3, 0.75, 0.225), 0.01, 4, 1.0);
    /// assert!(top.check().is_ok());
    /// ```
    pub fn rounded_cuboid(&mut self, min: Vec3, max: Vec3, radius: f32, segments: u32, metres: f32) -> &mut MeshData {
        let (a, b) = (min.min(max), min.max(max));
        let largest = ((b - a).min_element() / 2.0).max(0.0);
        let radius = if radius.is_finite() { radius.clamp(0.0, largest) } else { 0.0 };
        if radius <= EPSILON {
            return self.cuboid(a, b, metres);
        }
        let steps = segments.clamp(2, ROUND_SEGMENTS_MAX).div_ceil(2);
        let stops = [round_stops(a.x, b.x, radius, steps), round_stops(a.y, b.y, radius, steps), round_stops(a.z, b.z, radius, steps)];
        let tile = tile_metres(metres);
        let (inner_lo, inner_hi) = (a + Vec3::splat(radius), b - Vec3::splat(radius));
        for corners in box_faces(a, b) {
            self.rounded_face(corners, &stops, (inner_lo, inner_hi, radius), tile);
        }
        self
    }

    /// One face of a rounded box: a grid on the face's stops, each point pulled onto the rounded
    /// surface round the inner box.
    fn rounded_face(&mut self, [bottom_left, bottom_right, _, top_left]: [Vec3; 4], stops: &[Vec<f32>; 3], (lo, hi, radius): (Vec3, Vec3, f32), tile: f32) {
        let (u_axis, v_axis) = (major_axis(bottom_right - bottom_left), major_axis(top_left - bottom_left));
        let across = (bottom_right - bottom_left).normalize_or(Vec3::X);
        let down = (bottom_left - top_left).normalize_or(Vec3::NEG_Y);
        let face_normal = across.cross(-down);
        let rounded = |u: f32, v: f32| {
            let mut p = bottom_left;
            p[u_axis] = u;
            p[v_axis] = v;
            let centre = p.clamp(lo, hi);
            let offset = p - centre;
            let normal = offset.normalize_or(face_normal);
            // On a flat part (rounded along one axis or none) the point is exact.
            let flat = offset.cmpne(Vec3::ZERO).bitmask().count_ones() <= 1;
            let position = if flat { p } else { centre + normal * radius };
            let uv = Vec2::new((position - top_left).dot(across), (position - top_left).dot(down)) / tile;
            (position, normal, uv)
        };
        let (us, vs) = (&stops[u_axis], &stops[v_axis]);
        for v in vs.windows(2) {
            for u in us.windows(2) {
                let cell = [rounded(u[0], v[0]), rounded(u[1], v[0]), rounded(u[1], v[1]), rounded(u[0], v[1])];
                self.facing_quad(cell.map(|c| c.0), cell.map(|c| c.1), cell.map(|c| c.2));
            }
        }
    }

    /// Add `profile` (in the xy plane) pushed along +z from z = 0 to `depth`: a beam, a slat, a
    /// moulding, a kerb. A polygon gets caps at both ends, their edges rounded over `bevel` metres
    /// (held to half the depth; 0: hard cap edges) in [`EXTRUDE_BEVEL_SEGMENTS`] facets, the cap
    /// pulled in by the bevel; an open polyline makes one sheet (no caps, no bevel). Round the
    /// profile's corners with [`Profile::bevel`] first for an edge that is soft lengthways too.
    /// UVs: the sides u round the outline and v along z, the caps x and -y, in tiles of `metres`.
    pub fn extrude(&mut self, profile: &Profile, depth: f32, bevel: f32, metres: f32) -> &mut MeshData {
        if profile.points.len() < 2 {
            return self;
        }
        let depth = if depth.is_finite() { depth.abs() } else { 0.0 };
        let bevel = if profile.closed && bevel.is_finite() { bevel.clamp(0.0, depth.abs() / 2.0) } else { 0.0 };
        let tile = tile_metres(metres);
        // Each ring: how far the outline is pulled in, its z, and its normal's share along z.
        let mut rings: Vec<(f32, f32, f32)> = Vec::new();
        if bevel > 0.0 {
            for k in 0..=EXTRUDE_BEVEL_SEGMENTS {
                let (s, c) = math::sin_cos(math::FRAC_PI_2 * k as f32 / EXTRUDE_BEVEL_SEGMENTS as f32);
                rings.push((bevel - bevel * s, bevel - bevel * c, -c));
            }
            for k in (0..=EXTRUDE_BEVEL_SEGMENTS).rev() {
                let (s, c) = math::sin_cos(math::FRAC_PI_2 * k as f32 / EXTRUDE_BEVEL_SEGMENTS as f32);
                rings.push((bevel - bevel * s, depth - bevel + bevel * c, c));
            }
        } else {
            rings = vec![(0.0, 0.0, 0.0), (0.0, depth, 0.0)];
        }
        let samples = profile.side_samples();
        let insets: Vec<Vec<Vec2>> = rings.iter().map(|ring| profile.inset(ring.0)).collect();
        let edges: Vec<(usize, usize)> = profile.edges().collect();
        for pair in 0..rings.len() - 1 {
            for (edge, [(_, na, ua), (_, nb, ub)]) in samples.iter().enumerate() {
                let (a, b) = edges[edge];
                let at = |ring: usize, point: usize, n: Vec2, u: f32| {
                    let (_, z, along) = rings[ring];
                    let side = (1.0 - along * along).max(0.0).sqrt();
                    let p = insets[ring][point];
                    (Vec3::new(p.x, p.y, z), Vec3::new(n.x * side, n.y * side, along).normalize_or(Vec3::Z), Vec2::new(u, z) / tile)
                };
                let quad = [at(pair, a, *na, *ua), at(pair, b, *nb, *ub), at(pair + 1, b, *nb, *ub), at(pair + 1, a, *na, *ua)];
                self.facing_quad(quad.map(|q| q.0), quad.map(|q| q.1), quad.map(|q| q.2));
            }
        }
        if profile.closed {
            let triangles = triangulate(&profile.points);
            self.cap(&insets[0], &triangles, 0.0, -1.0, tile);
            self.cap(&insets[rings.len() - 1], &triangles, depth, 1.0, tile);
        }
        self
    }

    /// A flat cap of `points` at `z`, facing `sign` along z.
    fn cap(&mut self, points: &[Vec2], triangles: &[[usize; 3]], z: f32, sign: f32, tile: f32) {
        let normal = Vec3::new(0.0, 0.0, sign);
        let first = self.positions.len() as u32;
        for p in points {
            self.vertex(Vec3::new(p.x, p.y, z), normal, Vec2::new(p.x, -p.y) / tile);
        }
        for [a, b, c] in triangles {
            self.facing_triangle(first, [*a as u32, *b as u32, *c as u32], normal);
        }
    }

    /// Add `profile` turned round the y axis in `segments` steps (3 to [`LATHE_SEGMENTS_MAX`]):
    /// its x is the radius, its y the height. Walk a vase, a column, a bottle, a lamp shade or a
    /// table leg from the bottom to the top at positive x; a point on the axis (x = 0) closes it
    /// there. UVs: u round in metres at the profile's widest radius, v along the profile, in tiles
    /// of `metres`.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::{MeshData, Profile};
    ///
    /// // A turned table leg: a foot, a swelling and a neck, 72 cm tall.
    /// let leg = Profile::polyline(vec![vec2(0.0, 0.0), vec2(0.03, 0.0), vec2(0.03, 0.04), vec2(0.022, 0.08),
    ///     vec2(0.035, 0.3), vec2(0.02, 0.55), vec2(0.025, 0.72), vec2(0.0, 0.72)]).bevel(0.008, 3);
    /// let mut mesh = MeshData::new();
    /// mesh.lathe(&leg, 24, 1.0);
    /// assert!(mesh.check().is_ok());
    /// ```
    pub fn lathe(&mut self, profile: &Profile, segments: u32, metres: f32) -> &mut MeshData {
        if profile.points.len() < 2 {
            return self;
        }
        let steps = segments.clamp(3, LATHE_SEGMENTS_MAX);
        let tile = tile_metres(metres);
        let widest = profile.points.iter().map(|p| p.x.abs()).fold(0.0f32, f32::max);
        let round = math::TAU * widest;
        // The turn of step k; the last step is the first again, so the seam closes exactly.
        let turn = |k: u32| math::sin_cos(math::TAU * (k % steps) as f32 / steps as f32);
        let place = |p: Vec2, (s, c): (f32, f32)| Vec3::new(p.x * c, p.y, -p.x * s);
        let samples = profile.side_samples();
        for k in 0..steps {
            let (t0, t1) = (turn(k), turn(k + 1));
            let (u0, u1) = (round * k as f32 / steps as f32, round * (k + 1) as f32 / steps as f32);
            for &[(pa, na, va), (pb, nb, vb)] in &samples {
                let corners = [place(pa, t0), place(pb, t0), place(pb, t1), place(pa, t1)];
                let normals = [place(na, t0), place(nb, t0), place(nb, t1), place(na, t1)].map(|n| n.normalize_or(Vec3::Y));
                let uvs = [Vec2::new(u0, va), Vec2::new(u0, vb), Vec2::new(u1, vb), Vec2::new(u1, va)].map(|uv| uv / tile);
                self.facing_quad(corners, normals, uvs);
            }
        }
        self
    }

    /// Add `profile` carried along `path` (at least two points, metres): a pipe, a rail, a cable,
    /// a gutter, a kerb along a street, a moulding round a room. The profile's x is the path's
    /// right and its y the path's up (the world's up laid across the first segment, then turned as
    /// little as possible), and it widens through a sharp corner so its thickness holds. A polygon
    /// gets flat caps at the two ends. Smooth a path with [`crate::Spline::points`] first. UVs: u
    /// round the outline, v along the path, in tiles of `metres`.
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::{MeshData, Profile};
    ///
    /// // A handrail: a 5 x 4 cm rounded section along a path up a stair.
    /// let rail = Profile::rounded_rect(0.05, 0.04, 0.012, 3);
    /// let path = [vec3(0.0, 0.9, 0.0), vec3(0.0, 0.9, -0.5), vec3(0.0, 2.1, -2.5), vec3(0.0, 2.1, -3.0)];
    /// let mut mesh = MeshData::new();
    /// mesh.sweep(&rail, &path, 1.0);
    /// assert!(mesh.check().is_ok());
    /// ```
    pub fn sweep(&mut self, profile: &Profile, path: &[Vec3], metres: f32) -> &mut MeshData {
        let path = path_points(path);
        if profile.points.len() < 2 || path.len() < 2 {
            return self;
        }
        let tile = tile_metres(metres);
        let frames = frames(&path);
        let mut travelled = vec![0.0f32];
        for step in path.windows(2) {
            travelled.push(travelled[travelled.len() - 1] + step[0].distance(step[1]));
        }
        let samples = profile.side_samples();
        for at in 0..frames.len() - 1 {
            let (f0, f1) = (frames[at], frames[at + 1]);
            let (v0, v1) = (travelled[at], travelled[at + 1]);
            for [(pa, na, ua), (pb, nb, ub)] in &samples {
                let corners = [f0.place(*pa), f0.place(*pb), f1.place(*pb), f1.place(*pa)];
                let normals = [f0.turn(*na), f0.turn(*nb), f1.turn(*nb), f1.turn(*na)];
                let uvs = [Vec2::new(*ua, v0), Vec2::new(*ub, v0), Vec2::new(*ub, v1), Vec2::new(*ua, v1)].map(|uv| uv / tile);
                self.facing_quad(corners, normals, uvs);
            }
        }
        if profile.closed {
            let triangles = triangulate(&profile.points);
            for (frame, sign) in [(frames[0], -1.0), (frames[frames.len() - 1], 1.0)] {
                let normal = frame.forward * sign;
                let first = self.positions.len() as u32;
                for p in &profile.points {
                    self.vertex(frame.place(*p), normal, Vec2::new(p.x, -p.y) / tile);
                }
                for [a, b, c] in &triangles {
                    self.facing_triangle(first, [*a as u32, *b as u32, *c as u32], normal);
                }
            }
        }
        self
    }

    /// Add a round tube of `radius` with `sides` sides (3 to [`LATHE_SEGMENTS_MAX`]) along
    /// `path`, capped at both ends: [`MeshData::sweep`] of [`Profile::circle`].
    ///
    /// ```
    /// use genex::prelude::*;
    /// use genex::MeshData;
    ///
    /// // A radiator's feed pipe: up from the floor, along the wall and into the radiator.
    /// let mut pipe = MeshData::new();
    /// pipe.tube(&[vec3(0.0, 0.0, 0.1), vec3(0.0, 0.25, 0.1), vec3(0.3, 0.25, 0.1)], 0.016, 12, 1.0);
    /// assert!(pipe.check().is_ok());
    /// ```
    pub fn tube(&mut self, path: &[Vec3], radius: f32, sides: u32, metres: f32) -> &mut MeshData {
        self.sweep(&Profile::circle(radius, sides), path, metres)
    }
}
