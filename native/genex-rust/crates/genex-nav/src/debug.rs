//! Debug drawing (NAV-16): the nav as line segments for `frame.nav_debug`, which draws them as one
//! `frame.lines` batch (one logical draw).
//!
//! Ported from landmass 0.9.3 `src/debug.rs` (MIT OR Apache-2.0, used under Apache 2.0): its line
//! kinds (boundary edges, connectivity edges, boundary links, the agent's corridor) and its rule
//! that a node cut by boundary links draws what is left of its boundary. Changed: lines are
//! returned in genex world space instead of going to a `DebugDrawer`; points are not drawn; a
//! stitch draws once (landmass draws both of its directed links), and so does each inner edge.
//!
//! Islands draw in the data's island order and polygons in mesh order, so the same nav gives the
//! same segments in the same order. Until the update after a change has stitched the islands,
//! tile seams draw as each tile's own border.

use glam::{Vec2, Vec3, Vec3Swizzles};

use crate::runtime::coords::{CoordinateSystem, CorePointSampleDistance, GenexCoords};
use crate::runtime::island::Island;
use crate::runtime::nav_data::{KindedOffMeshLink, ModifiedNode, NodeRef};
use crate::runtime::path::StraightPathStep;
use crate::world::Nav;

/// Corners one agent's drawn path may have; a longer path draws its first corners only.
const PATH_CORNERS_MAX: usize = 256;

/// What `frame.nav_debug` draws. The default draws nothing; start from [`NavDebug::mesh`],
/// [`NavDebug::borders`] or [`NavDebug::everything`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavDebug {
    edges: bool,
    borders: bool,
    links: bool,
    paths: bool,
}

impl NavDebug {
    /// The walkable surface: every polygon edge, the borders and the tile seams.
    pub const fn mesh() -> NavDebug {
        NavDebug { edges: true, borders: true, links: false, paths: false }
    }

    /// The outline only: the borders and the tile seams.
    pub const fn borders() -> NavDebug {
        NavDebug { edges: false, borders: true, links: false, paths: false }
    }

    /// The mesh, the off-mesh links and every agent's path.
    pub const fn everything() -> NavDebug {
        NavDebug { edges: true, borders: true, links: true, paths: true }
    }

    /// Also draw the off-mesh links (jumps, drops, ladders, doors, teleports).
    pub const fn with_links(self) -> NavDebug {
        NavDebug { links: true, ..self }
    }

    /// Also draw each agent's path, from where it stands through its corners to its target.
    pub const fn with_paths(self) -> NavDebug {
        NavDebug { paths: true, ..self }
    }
}

/// What a drawn segment is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NavDebugLine {
    /// An edge between two polygons of one tile.
    Edge,
    /// An edge of the walkable surface's border.
    Border,
    /// A stretch of a seam where two tiles are stitched (a boundary link).
    Seam,
    /// An off-mesh link: its start edge, its end edge and the jump between their midpoints.
    Link,
    /// A stretch of an agent's path.
    Path,
}

/// The segments that draw `nav` as `debug` asks, as pairs of points in world space.
pub fn segments(nav: &Nav, debug: NavDebug) -> Vec<[Vec3; 2]> {
    lines(nav, debug).into_iter().map(|(_, segment)| segment).collect()
}

/// [`segments`] with what each segment is: the surface (edges, borders, seams) island by island,
/// then the links, then the paths agent by agent.
pub fn lines(nav: &Nav, debug: NavDebug) -> Vec<(NavDebugLine, [Vec3; 2])> {
    let mut out = Vec::new();
    if debug.edges || debug.borders {
        surface(nav, debug, &mut out);
    }
    if debug.links {
        links(nav, &mut out);
    }
    if debug.paths {
        paths(nav, &mut out);
    }
    out
}

/// A landmass-frame point in genex world space.
fn world(point: Vec3) -> Vec3 {
    GenexCoords::from_landmass(&point)
}

/// Every polygon's inner edges and borders, then each stitch once.
fn surface(nav: &Nav, debug: NavDebug, out: &mut Vec<(NavDebugLine, [Vec3; 2])>) {
    let nav_data = &nav.archipelago.nav_data;
    // Before the update stitches a change, the links and cuts describe the old islands.
    let stitched = !nav_data.dirty;
    for island_id in nav_data.get_island_ids() {
        let Some(island) = nav_data.get_island(island_id) else { continue };
        for polygon_index in 0..island.nav_mesh.polygons.len() {
            let node = NodeRef { island_id, polygon_index };
            let modified = if stitched { nav_data.modified_nodes.get(&node) } else { None };
            polygon_lines(island, polygon_index, modified, debug, out);
        }
    }
    if !(debug.borders && stitched) {
        return;
    }
    for (source, _, link) in nav_data.off_mesh_links_by_node() {
        // Each stitch is two directed links; the one from the lower node draws it.
        let from_lower = source < link.destination_node;
        if matches!(link.kinded, KindedOffMeshLink::BoundaryLink { .. }) && from_lower {
            out.push((NavDebugLine::Seam, [world(link.portal.0), world(link.portal.1)]));
        }
    }
}

/// One polygon's lines: inner edges once (from the lower polygon), and its border, or what boundary
/// links left of it.
fn polygon_lines(
    island: &Island<GenexCoords>,
    polygon_index: usize,
    modified: Option<&ModifiedNode>,
    debug: NavDebug,
    out: &mut Vec<(NavDebugLine, [Vec3; 2])>,
) {
    let mesh = &island.nav_mesh;
    let polygon = &mesh.polygons[polygon_index];
    let corner = |vertex: usize| island.transform.apply(mesh.vertices[vertex]);
    for (edge, connectivity) in polygon.connectivity.iter().enumerate() {
        let (left, right) = polygon.get_edge_indices(edge);
        match connectivity {
            Some(across) if debug.edges && polygon_index < across.polygon_index => {
                out.push((NavDebugLine::Edge, [world(corner(left)), world(corner(right))]));
            }
            None if debug.borders && modified.is_none() => {
                out.push((NavDebugLine::Border, [world(corner(left)), world(corner(right))]));
            }
            _ => {}
        }
    }
    let Some(modified) = modified.filter(|_| debug.borders) else { return };
    let polygon_corners: Vec<Vec3> = polygon.vertices.iter().map(|&vertex| corner(vertex)).collect();
    let point = |index: usize| match index.checked_sub(mesh.vertices.len()) {
        None => corner(index),
        Some(new) => lift(modified.new_vertices[new], &polygon_corners),
    };
    for &(left, right) in &modified.new_boundary {
        out.push((NavDebugLine::Border, [world(point(left)), world(point(right))]));
    }
}

/// A cut end (a 2D point on one of the polygon's edges) at the height of the edge it sits on.
fn lift(point: Vec2, corners: &[Vec3]) -> Vec3 {
    let mut best = (f32::INFINITY, point.extend(corners.first().map_or(0.0, |c| c.z)));
    for (index, &start) in corners.iter().enumerate() {
        let end = corners[(index + 1) % corners.len()];
        let run = end.xy() - start.xy();
        let t = if run.length_squared() > 0.0 { ((point - start.xy()).dot(run) / run.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
        let on_edge = start.lerp(end, t);
        let distance = on_edge.xy().distance_squared(point);
        if distance < best.0 {
            best = (distance, point.extend(on_edge.z));
        }
    }
    best.1
}

/// Each off-mesh link: its start edge, its end edge (a point edge draws nothing) and a jump from
/// the start's midpoint to the end's.
fn links(nav: &Nav, out: &mut Vec<(NavDebugLine, [Vec3; 2])>) {
    let nav_data = &nav.archipelago.nav_data;
    for link_id in nav_data.get_animation_link_ids() {
        let Some(link) = nav_data.get_animation_link(link_id) else { continue };
        for (a, b) in [link.start_edge, link.end_edge] {
            if a != b {
                out.push((NavDebugLine::Link, [a, b]));
            }
        }
        let start = link.start_edge.0.midpoint(link.start_edge.1);
        let end = link.end_edge.0.midpoint(link.end_edge.1);
        out.push((NavDebugLine::Link, [start, end]));
    }
}

/// Each agent's straight path from where it stands, corner by corner, to its target (or to the
/// start of the next off-mesh link and across it).
fn paths(nav: &Nav, out: &mut Vec<(NavDebugLine, [Vec3; 2])>) {
    let archipelago = &nav.archipelago;
    let nav_data = &archipelago.nav_data;
    if nav_data.dirty {
        return;
    }
    let reach = CorePointSampleDistance::new(&archipelago.archipelago_options.point_sample_distance);
    for (_, agent) in archipelago.agents.iter() {
        let Some(path) = agent.current_path.as_ref() else { continue };
        let Some((mut point, node)) = nav_data.sample_point(GenexCoords::to_landmass(&agent.position), &reach) else { continue };
        let Some(mut index) = path.find_index_of_node(node) else { continue };
        let last = path.last_index();
        // The first stretch starts at the agent's feet, not at the point sampled on the mesh.
        let mut drawn_from = agent.position;
        for _ in 0..PATH_CORNERS_MAX {
            let (next, step) = path.find_next_point_in_straight_path(nav_data, index, point, last, path.end_point);
            let (reached, landed) = match step {
                StraightPathStep::Waypoint(corner) => (corner, corner),
                StraightPathStep::AnimationLink { start_point, end_point, .. } => (start_point, end_point),
            };
            out.push((NavDebugLine::Path, [drawn_from, world(reached)]));
            if landed != reached {
                out.push((NavDebugLine::Path, [world(reached), world(landed)]));
            }
            if landed == path.end_point || (next == index && landed == point) {
                break;
            }
            (point, index, drawn_from) = (landed, next, world(landed));
        }
    }
}
