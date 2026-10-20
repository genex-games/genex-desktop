//! Detour-style surface queries on an archipelago: a raycast along the mesh surface, sliding a
//! point along the surface, a random point around a circle, and the distance to the nearest wall.
//!
//! Ported and altered from recastnavigation's `DetourNavMeshQuery.cpp` (Zlib; Copyright (c)
//! 2009-2010 Mikko Mononen): `dtNavMeshQuery::raycast` with `dtIntersectSegmentPoly2D`,
//! `moveAlongSurface` (the bounded breadth-first search with its `MAX_STACK` of 48 kept),
//! `findRandomPointAroundCircle` with `dtRandomPointInConvexPoly` (area-weighted reservoir pick),
//! and `findDistanceToWall`. This is an altered version, not the original software. Changed:
//!
//! - the queries walk the archipelago's islands: in-mesh neighbours across a polygon's edges,
//!   and the boundary links that stitch islands (Detour's tile portals), in world space;
//! - a wall is a polygon edge with no neighbour, the part of a boundary edge no boundary link
//!   covers (the archipelago's modified nodes), or a portal to an area the filter or the gates
//!   shut; animation links are never walked (Detour skips off-mesh connections the same way);
//! - polygons are counter-clockwise in the standard frame's xy plane (Z up), so the 2D tests read
//!   x and y; a result's height comes from the polygon (or its height mesh) under it;
//! - random numbers come only from genex-core's [`Pcg32`]: one `unit()` per polygon the search
//!   visits, then two for the point (no global generator); the search is breadth-first, in
//!   neighbour order, within [`DETOUR_NODES_MAX`] polygons;
//! - hostile input (a non-finite point, a reach or radius that is not above zero, a point off
//!   every island, navigation data changed since the last update) answers `None`, never a panic.

use std::collections::VecDeque;

use genex_core::map::Set;
use genex_core::rng::Pcg32;
use glam::{Vec2, Vec3, Vec3Swizzles};

use super::archipelago::Archipelago;
use super::coords::{CoordinateSystem, CorePointSampleDistance, PointSampleDistance};
use super::nav_data::{KindedOffMeshLink, NavigationData, NodeRef};
use super::nav_mesh::Connectivity;
use crate::filter::{Gates, NavFilter};

/// The most polygons `move_along` keeps queued (Detour's `MAX_STACK`).
pub const MOVE_ALONG_STACK_MAX: usize = 48;
/// The most polygons a raycast, random-point or wall search visits.
pub const DETOUR_NODES_MAX: usize = 2048;
/// How far outside a polygon edge a point still counts as on it, in metres.
const ON_EDGE: f32 = 1e-4;
/// Below this, a segment is parallel to an edge (Detour's `EPS`).
const PARALLEL: f32 = 1e-8;
/// Detour's margin on the search circle of `move_along`.
const MOVE_ALONG_MARGIN: f32 = 0.001;

/// Where a raycast along the surface stopped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavRay<C> {
    /// The hit point, or the end point when nothing was in the way, on the surface.
    pub position: C,
    /// The wall's normal, horizontal and pointing back into the walkable side; zero when clear.
    pub normal: C,
    /// How far along the ray the hit is, in [0, 1]; 1 when clear.
    pub fraction: f32,
    /// Whether a wall stopped the ray.
    pub blocked: bool,
    /// The polygon the ray ended on.
    pub node: NodeRef,
}

/// Where a slide along the surface ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavMove<C> {
    /// The point on the surface nearest the target the search reached.
    pub position: C,
    /// Its polygon.
    pub node: NodeRef,
    /// The polygons the search visited.
    pub visited: usize,
}

/// A random point on the surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavRandomPoint<C> {
    /// The point.
    pub position: C,
    /// Its polygon.
    pub node: NodeRef,
    /// The polygon's type index (area).
    pub type_index: usize,
    /// The polygons the search visited (each took one random number; the point took two more).
    pub visited: usize,
}

/// The nearest wall around a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavWall<C> {
    /// The distance to it, or the search radius when none is within it.
    pub distance: f32,
    /// The nearest point on it (the query point when none was found).
    pub position: C,
    /// From the wall toward the query point, horizontal; zero when none was found.
    pub normal: C,
    /// Whether a wall is within the radius.
    pub found: bool,
}

/// A way out of a polygon: the neighbour and the portal (in world xy) on the polygon's `edge`.
#[derive(Clone, Copy, Debug)]
struct Portal {
    to: NodeRef,
    a: Vec2,
    b: Vec2,
    edge: usize,
}

/// One polygon in world space, with its ways out and its walls.
struct Poly {
    /// Counter-clockwise, world xy.
    vertices: Vec<Vec2>,
    portals: Vec<Portal>,
    walls: Vec<(Vec2, Vec2)>,
}

/// The read-only view the queries walk: the navigation data and what the filter and gates shut.
struct Surface<'a, CS: CoordinateSystem> {
    nav_data: &'a NavigationData<CS>,
    gates: Gates,
    link_reach: f32,
}

impl<CS: CoordinateSystem> Surface<'_, CS> {
    fn type_index(&self, node: NodeRef) -> Option<usize> {
        let island = self.nav_data.get_island(node.island_id)?;
        island.nav_mesh.polygons.get(node.polygon_index).map(|polygon| polygon.type_index)
    }

    fn open(&self, node: NodeRef) -> bool {
        self.type_index(node).is_some_and(|type_index| !self.gates.is_area_shut(type_index))
    }

    /// The polygon's vertices in world xy.
    fn vertices(&self, node: NodeRef) -> Option<Vec<Vec2>> {
        let island = self.nav_data.get_island(node.island_id)?;
        let polygon = island.nav_mesh.polygons.get(node.polygon_index)?;
        let mesh = &island.nav_mesh.vertices;
        Some(polygon.vertices.iter().map(|&index| island.transform.apply(mesh[index]).xy()).collect())
    }

    /// The polygon with its open portals and its walls.
    fn poly(&self, node: NodeRef) -> Option<Poly> {
        let vertices = self.vertices(node)?;
        let island = self.nav_data.get_island(node.island_id)?;
        let polygon = island.nav_mesh.polygons.get(node.polygon_index)?;
        let count = vertices.len();
        let mut portals = Vec::new();
        let mut walls = Vec::new();
        for (edge, connectivity) in polygon.connectivity.iter().enumerate() {
            let (a, b) = (vertices[edge], vertices[(edge + 1) % count]);
            let Some(connectivity) = connectivity else { continue };
            let to = NodeRef { island_id: node.island_id, polygon_index: connectivity.polygon_index };
            if self.open(to) {
                portals.push(Portal { to, a, b, edge });
            } else {
                walls.push((a, b));
            }
        }
        self.boundary_links(node, &vertices, &mut portals, &mut walls);
        self.boundary_walls(node, &vertices, polygon.connectivity.as_slice(), &mut walls);
        Some(Poly { vertices, portals, walls })
    }

    /// The boundary links out of `node`: open ones are portals on the edge they lie on, shut
    /// ones walls.
    fn boundary_links(&self, node: NodeRef, vertices: &[Vec2], portals: &mut Vec<Portal>, walls: &mut Vec<(Vec2, Vec2)>) {
        let Some(links) = self.nav_data.node_to_off_mesh_link_ids.get(&node) else { return };
        for link_id in links {
            let Some(link) = self.nav_data.off_mesh_links.get(*link_id) else { continue };
            if !matches!(link.kinded, KindedOffMeshLink::BoundaryLink { .. }) {
                continue;
            }
            let (a, b) = (link.portal.0.xy(), link.portal.1.xy());
            if !self.open(link.destination_node) {
                walls.push((a, b));
                continue;
            }
            let count = vertices.len();
            let on_edge = (0..count).find(|&edge| {
                let segment = (vertices[edge], vertices[(edge + 1) % count]);
                distance_to_segment(a, segment) <= self.link_reach && distance_to_segment(b, segment) <= self.link_reach
            });
            if let Some(edge) = on_edge {
                portals.push(Portal { to: link.destination_node, a, b, edge });
            }
        }
    }

    /// The walls on `node`'s boundary edges: what boundary links left of them (the modified
    /// node), or the whole edges when no link touches the node.
    fn boundary_walls(&self, node: NodeRef, vertices: &[Vec2], connectivity: &[Option<Connectivity>], walls: &mut Vec<(Vec2, Vec2)>) {
        let count = vertices.len();
        let Some(modified) = self.nav_data.modified_nodes.get(&node) else {
            let open_edges = (0..count).filter(|&edge| connectivity.get(edge).is_some_and(Option::is_none));
            walls.extend(open_edges.map(|edge| (vertices[edge], vertices[(edge + 1) % count])));
            return;
        };
        let Some(island) = self.nav_data.get_island(node.island_id) else { return };
        let mesh = &island.nav_mesh.vertices;
        let point = |index: usize| match mesh.get(index) {
            Some(&vertex) => Some(island.transform.apply(vertex).xy()),
            None => modified.new_vertices.get(index - mesh.len()).copied(),
        };
        for &(left, right) in &modified.new_boundary {
            if let (Some(a), Some(b)) = (point(left), point(right)) {
                walls.push((a, b));
            }
        }
    }

    /// The point on `node`'s surface under `at` (world xy, `z` a height guess), in world space.
    fn on_node(&self, node: NodeRef, at: Vec2, z: f32) -> Option<Vec3> {
        let island = self.nav_data.get_island(node.island_id)?;
        let local = island.transform.apply_inverse(Vec3::new(at.x, at.y, z));
        Some(island.transform.apply(island.nav_mesh.sample_point_on_node(local, node.polygon_index)))
    }
}

/// `cross(u, v)` in the xy plane: positive when `v` is counter-clockwise of `u`.
fn cross(u: Vec2, v: Vec2) -> f32 {
    u.x * v.y - u.y * v.x
}

/// The distance from `p` to the segment, and the closest point's parameter along it.
fn closest_on_segment(p: Vec2, (a, b): (Vec2, Vec2)) -> (f32, f32) {
    let ab = b - a;
    let length_squared = ab.length_squared();
    let t = if length_squared > 0.0 { ((p - a).dot(ab) / length_squared).clamp(0.0, 1.0) } else { 0.0 };
    ((a + ab * t).distance(p), t)
}

fn distance_to_segment(p: Vec2, segment: (Vec2, Vec2)) -> f32 {
    closest_on_segment(p, segment).0
}

/// Whether `p` is inside the counter-clockwise polygon, within [`ON_EDGE`].
fn contains(vertices: &[Vec2], p: Vec2) -> bool {
    let count = vertices.len();
    (0..count).all(|edge| {
        let (a, b) = (vertices[edge], vertices[(edge + 1) % count]);
        let length = a.distance(b);
        length == 0.0 || cross(b - a, p - a) >= -ON_EDGE * length
    })
}

/// Where the segment from `start` along `delta` leaves the counter-clockwise polygon: the
/// parameter and the edge, or `None` for the edge when the end is inside (`dtIntersectSegmentPoly2D`).
/// `None` overall when the segment misses the polygon.
fn exit_of(vertices: &[Vec2], start: Vec2, delta: Vec2) -> Option<(f32, Option<usize>)> {
    let count = vertices.len();
    let (mut t_min, mut t_max, mut exit) = (0.0_f32, 1.0_f32, None);
    for edge in 0..count {
        let (a, b) = (vertices[edge], vertices[(edge + 1) % count]);
        let e = b - a;
        let n = cross(e, start - a);
        let d = cross(e, delta);
        if d.abs() < PARALLEL {
            if n < -ON_EDGE * e.length() {
                return None;
            }
            continue;
        }
        let t = -n / d;
        if d > 0.0 {
            t_min = t_min.max(t);
        } else if t < t_max {
            t_max = t;
            exit = Some(edge);
        }
        if t_min > t_max {
            return None;
        }
    }
    Some((t_max, exit))
}

/// The inward unit normal of the counter-clockwise edge from `a` to `b`.
fn inward_normal(a: Vec2, b: Vec2) -> Vec2 {
    let e = b - a;
    Vec2::new(-e.y, e.x).normalize_or_zero()
}

/// The polygon's area (a counter-clockwise fan from its first vertex).
fn fan_areas(vertices: &[Vec2]) -> Vec<f32> {
    let origin = vertices[0];
    (2..vertices.len()).map(|at| cross(vertices[at - 1] - origin, vertices[at] - origin) * 0.5).collect()
}

/// A point of the convex polygon from two uniform numbers (`dtRandomPointInConvexPoly`).
fn point_in_polygon(vertices: &[Vec2], areas: &[f32], s: f32, t: f32) -> Vec2 {
    let total: f32 = areas.iter().sum();
    let threshold = s * total;
    let (mut acc, mut u, mut triangle) = (0.0_f32, 1.0_f32, vertices.len() - 1);
    for (at, &area) in areas.iter().enumerate() {
        if threshold >= acc && threshold < acc + area {
            u = (threshold - acc) / area;
            triangle = at + 2;
            break;
        }
        acc += area;
    }
    let v = t.sqrt();
    let (a, b, c) = (1.0 - v, (1.0 - u) * v, u * v);
    vertices[0] * a + vertices[triangle - 1] * b + vertices[triangle] * c
}

fn finite(v: Vec3) -> bool {
    v.is_finite()
}

fn positive(value: f32) -> bool {
    value.is_finite() && value > 0.0
}

impl<CS: CoordinateSystem> Archipelago<CS> {
    /// The surface view under `filter`, or `None` while the navigation data is dirty.
    fn surface(&self, filter: &NavFilter) -> Option<Surface<'_, CS>> {
        if self.nav_data.dirty {
            return None;
        }
        let link_reach = self.archipelago_options.edge_link_distance.max(0.0) + ON_EDGE;
        Some(Surface { nav_data: &self.nav_data, gates: filter.gates_with(self.gates()), link_reach })
    }

    /// The open node under `point` within `reach` (horizontally and vertically) and the point on it.
    fn start_on(&self, surface: &Surface<'_, CS>, point: Vec3, reach: f32) -> Option<(Vec3, NodeRef)> {
        if !finite(point) || !positive(reach) {
            return None;
        }
        let ratio = self.archipelago_options.point_sample_distance.vertical_preference_ratio();
        let distance = CorePointSampleDistance {
            horizontal_distance: reach,
            distance_above: reach,
            distance_below: reach,
            vertical_preference_ratio: ratio,
        };
        let (sampled, node) = surface.nav_data.sample_point(point, &distance)?;
        surface.open(node).then_some((sampled, node))
    }

    /// Walk the surface straight from `from` (sampled within `reach`) toward `to`: where a wall
    /// stops it, its normal and the fraction, or the end when nothing is in the way.
    pub fn raycast(&self, from: CS::Coordinate, to: CS::Coordinate, reach: f32, filter: &NavFilter) -> Option<NavRay<CS::Coordinate>> {
        let surface = self.surface(filter)?;
        let end = CS::to_landmass(&to);
        let (start, start_node) = self.start_on(&surface, CS::to_landmass(&from), reach)?;
        if !finite(end) {
            return None;
        }
        let (origin, delta) = (start.xy(), end.xy() - start.xy());
        let mut node = start_node;
        let mut previous_t = 0.0_f32;
        for _ in 0..DETOUR_NODES_MAX {
            let poly = surface.poly(node)?;
            let Some((t, exit)) = exit_of(&poly.vertices, origin, delta) else {
                return Self::ray_result(&surface, node, origin + delta * previous_t, (start, end), previous_t, None);
            };
            let Some(edge) = exit else {
                return Self::ray_result(&surface, node, end.xy(), (start, end), 1.0, None);
            };
            let crossing = origin + delta * t;
            let next = poly.portals.iter().find(|portal| {
                portal.edge == edge && distance_to_segment(crossing, (portal.a, portal.b)) <= surface.link_reach
            });
            let count = poly.vertices.len();
            let wall = (poly.vertices[edge], poly.vertices[(edge + 1) % count]);
            let Some(next) = next.filter(|_| t >= previous_t) else {
                return Self::ray_result(&surface, node, crossing, (start, end), t, Some(wall));
            };
            previous_t = t;
            node = next.to;
        }
        None
    }

    /// The ray's result at `at` on `node`, `fraction` along `(start, end)`, stopped by `wall`.
    fn ray_result(
        surface: &Surface<'_, CS>,
        node: NodeRef,
        at: Vec2,
        (start, end): (Vec3, Vec3),
        fraction: f32,
        wall: Option<(Vec2, Vec2)>,
    ) -> Option<NavRay<CS::Coordinate>> {
        let fraction = fraction.clamp(0.0, 1.0);
        let z = start.z + (end.z - start.z) * fraction;
        let position = surface.on_node(node, at, z)?;
        let normal = wall.map_or(Vec2::ZERO, |(a, b)| inward_normal(a, b));
        Some(NavRay {
            position: CS::from_landmass(&position),
            normal: CS::from_landmass(&Vec3::new(normal.x, normal.y, 0.0)),
            fraction,
            blocked: wall.is_some(),
            node,
        })
    }

    /// Slide from `from` (sampled within `reach`) toward `to` along the surface: the end when it
    /// is reachable within the search circle, otherwise the nearest point on a wall the search
    /// reached (keeps a player on the mesh).
    pub fn move_along(&self, from: CS::Coordinate, to: CS::Coordinate, reach: f32, filter: &NavFilter) -> Option<NavMove<CS::Coordinate>> {
        let surface = self.surface(filter)?;
        let target = CS::to_landmass(&to);
        let (start, start_node) = self.start_on(&surface, CS::to_landmass(&from), reach)?;
        if !finite(target) {
            return None;
        }
        let end = target.xy();
        let search_centre = (start.xy() + end) * 0.5;
        let search_radius = start.xy().distance(end) * 0.5 + MOVE_ALONG_MARGIN;
        let (mut best, mut best_distance, mut best_node) = (start.xy(), f32::INFINITY, start_node);
        let mut queue = VecDeque::from([start_node]);
        let mut seen: Set<NodeRef> = Set::default();
        seen.insert(start_node);
        let mut visited = 0;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            let poly = surface.poly(node)?;
            if contains(&poly.vertices, end) {
                (best, best_node) = (end, node);
                break;
            }
            for &wall in &poly.walls {
                let (distance, t) = closest_on_segment(end, wall);
                if distance < best_distance {
                    (best, best_distance, best_node) = (wall.0 + (wall.1 - wall.0) * t, distance, node);
                }
            }
            for portal in &poly.portals {
                let near = distance_to_segment(search_centre, (portal.a, portal.b)) <= search_radius;
                if near && queue.len() < MOVE_ALONG_STACK_MAX && seen.insert(portal.to) {
                    queue.push_back(portal.to);
                }
            }
        }
        let position = surface.on_node(best_node, best, start.z)?;
        Some(NavMove { position: CS::from_landmass(&position), node: best_node, visited })
    }

    /// A random point on the polygons reachable from `around` (sampled within `reach`) whose
    /// portals come within `radius` of it, each polygon weighted by its area. Draws one `unit()`
    /// per polygon visited, then two for the point.
    pub fn random_point(
        &self,
        rng: &mut Pcg32,
        around: CS::Coordinate,
        radius: f32,
        reach: f32,
        filter: &NavFilter,
    ) -> Option<NavRandomPoint<CS::Coordinate>> {
        let surface = self.surface(filter)?;
        let (centre, start_node) = self.start_on(&surface, CS::to_landmass(&around), reach)?;
        if !positive(radius) {
            return None;
        }
        let mut picked: Option<(NodeRef, Vec<Vec2>, Vec<f32>)> = None;
        let mut area_sum = 0.0_f32;
        let mut visited = 0;
        self.breadth_first(&surface, start_node, centre.xy(), radius, |node, poly| {
            visited += 1;
            let areas = fan_areas(&poly.vertices);
            let area: f32 = areas.iter().sum();
            area_sum += area;
            if rng.unit() * area_sum <= area {
                picked = Some((node, poly.vertices.clone(), areas));
            }
            radius
        })?;
        let (node, vertices, areas) = picked?;
        let (s, t) = (rng.unit(), rng.unit());
        let at = point_in_polygon(&vertices, &areas, s, t);
        let position = surface.on_node(node, at, centre.z)?;
        let type_index = surface.type_index(node)?;
        Some(NavRandomPoint { position: CS::from_landmass(&position), node, type_index, visited })
    }

    /// The nearest wall within `radius` of `at` (sampled within `reach`), over the polygons the
    /// surface reaches from it.
    pub fn distance_to_wall(&self, at: CS::Coordinate, radius: f32, reach: f32, filter: &NavFilter) -> Option<NavWall<CS::Coordinate>> {
        let surface = self.surface(filter)?;
        let (centre, start_node) = self.start_on(&surface, CS::to_landmass(&at), reach)?;
        if !positive(radius) {
            return None;
        }
        let point = centre.xy();
        let mut nearest: Option<(f32, Vec2)> = None;
        self.breadth_first(&surface, start_node, point, radius, |_, poly| {
            for &wall in &poly.walls {
                let (distance, t) = closest_on_segment(point, wall);
                if distance < nearest.map_or(radius, |(best, _)| best) {
                    nearest = Some((distance, wall.0 + (wall.1 - wall.0) * t));
                }
            }
            nearest.map_or(radius, |(best, _)| best)
        })?;
        let Some((distance, hit)) = nearest else {
            let position = CS::from_landmass(&centre);
            return Some(NavWall { distance: radius, position, normal: CS::from_landmass(&Vec3::ZERO), found: false });
        };
        let normal = (point - hit).normalize_or_zero();
        let position = Vec3::new(hit.x, hit.y, centre.z);
        Some(NavWall {
            distance,
            position: CS::from_landmass(&position),
            normal: CS::from_landmass(&Vec3::new(normal.x, normal.y, 0.0)),
            found: true,
        })
    }

    /// Visit the open polygons reachable from `start` through portals within the radius `visit`
    /// returns (it may shrink as the search goes), breadth first, at most [`DETOUR_NODES_MAX`].
    fn breadth_first(
        &self,
        surface: &Surface<'_, CS>,
        start: NodeRef,
        centre: Vec2,
        radius: f32,
        mut visit: impl FnMut(NodeRef, &Poly) -> f32,
    ) -> Option<()> {
        let mut queue = VecDeque::from([start]);
        let mut seen: Set<NodeRef> = Set::default();
        seen.insert(start);
        let mut reach = radius;
        let mut visited = 0;
        while let Some(node) = queue.pop_front() {
            let poly = surface.poly(node)?;
            reach = visit(node, &poly).min(reach);
            visited += 1;
            for portal in &poly.portals {
                let near = distance_to_segment(centre, (portal.a, portal.b)) <= reach;
                if near && visited + queue.len() < DETOUR_NODES_MAX && seen.insert(portal.to) {
                    queue.push_back(portal.to);
                }
            }
        }
        Some(())
    }
}
