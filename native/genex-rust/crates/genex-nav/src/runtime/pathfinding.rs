//! The A* problem over an archipelago's navigation data: node edges, boundary links and animation
//! links, with per-agent type costs, permitted link kinds and gates.
//!
//! Ported from landmass 0.9.3 `src/pathfinding.rs` (MIT OR Apache-2.0, used under Apache 2.0;
//! crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed:
//! - P1: the cost overrides are a `Map`; a node's off-mesh links come from the nav data's `Set`
//!   (insertion order); `PathNode` is `Ord` for the A* tie rule (P11).
//! - P12: [`find_path`] takes a node cap; a capped search hands back the partial path to the
//!   explored node nearest the target, flagged `partial` (Detour's `DT_PARTIAL_RESULT`).
//! - P14 (NAV-8): shut areas and closed animation links are skipped, as a non-finite cost is.

use std::borrow::Cow;

use genex_core::map::{Map, Set};
use glam::Vec3;

use super::astar::{self, AStarProblem, PathStats};
use super::coords::CoordinateSystem;
use super::link::PermittedAnimationLinks;
use super::nav_data::{KindedOffMeshLink, NavigationData, NodeRef, OffMeshLinkId};
use super::nav_mesh::MeshEdgeRef;
use super::path::{IslandSegment, OffMeshLinkSegment, Path};
use super::util::FloatOrd;
use crate::filter::Gates;

/// What a search may walk and at what cost.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SearchRules<'a> {
    /// Replacement costs for the nav data's type costs.
    pub(crate) override_type_index_to_cost: &'a Map<usize, f32>,
    /// The animation-link kinds the searcher may take.
    pub(crate) permitted_animation_links: &'a PermittedAnimationLinks,
    /// Shut areas and closed links.
    pub(crate) gates: &'a Gates,
    /// The most nodes the search may expand.
    pub(crate) max_explored: u32,
}

/// The A* problem for one search.
struct ArchipelagoPathProblem<'a, CS: CoordinateSystem> {
    nav_data: &'a NavigationData<CS>,
    start_node: NodeRef,
    start_point: Vec3,
    end_node: NodeRef,
    end_point: Vec3,
    /// The cheapest finite type cost, for an admissible heuristic.
    cheapest_type_index_cost: f32,
    rules: SearchRules<'a>,
}

/// An action of the path.
#[derive(Clone, Copy, Debug)]
enum PathStep {
    /// Head straight to the end (only inside the end node).
    GoToEnd,
    /// Cross the current node's edge with this index.
    NodeConnection(usize),
    /// Take this off-mesh link from the current node.
    OffMeshLink(OffMeshLinkId),
}

/// A state of the search, usually an edge of a node.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
enum PathNode {
    /// The start.
    Start,
    /// The end.
    End,
    /// A node entered through one of its edges.
    NodeEdge {
        /// The node now entered.
        node: NodeRef,
        /// The edge it was entered by.
        start_edge: usize,
    },
    /// An off-mesh link taken.
    OffMeshLink(OffMeshLinkId),
}

impl<CS: CoordinateSystem> ArchipelagoPathProblem<'_, CS> {
    /// The cost per metre of entering `type_index`: infinite for a shut area.
    fn type_index_to_cost(&self, type_index: usize) -> f32 {
        if self.rules.gates.is_area_shut(type_index) {
            return f32::INFINITY;
        }
        self.walk_cost(type_index)
    }

    /// The cost per metre of walking `type_index`, shut or not: a searcher already standing in a
    /// shut area may still walk out of it.
    fn walk_cost(&self, type_index: usize) -> f32 {
        self.rules
            .override_type_index_to_cost
            .get(&type_index)
            .copied()
            .unwrap_or_else(|| self.nav_data.get_type_index_cost(type_index).unwrap_or(1.0))
    }

    /// Where `state` stands in the world: its node, the point, and the step to not undo.
    fn state_origin(&self, state: &PathNode) -> (NodeRef, Vec3, Option<PathStep>) {
        match state {
            PathNode::Start => (self.start_node, self.start_point, None),
            PathNode::NodeEdge { node, start_edge } => {
                let island = self.nav_data.get_island(node.island_id).expect("a searched node's island");
                let polygon = &island.nav_mesh.polygons[node.polygon_index];
                let (i, j) = polygon.get_edge_indices(*start_edge);
                let local_midpoint = island.nav_mesh.vertices[i].midpoint(island.nav_mesh.vertices[j]);
                (*node, island.transform.apply(local_midpoint), Some(PathStep::NodeConnection(*start_edge)))
            }
            PathNode::OffMeshLink(link) => {
                let link = self.nav_data.off_mesh_links.get(*link).expect("a searched link");
                let (portal, ignore_step) = match &link.kinded {
                    KindedOffMeshLink::BoundaryLink { reverse_link } => (link.portal, Some(PathStep::OffMeshLink(*reverse_link))),
                    KindedOffMeshLink::AnimationLink { destination_portal, .. } => (*destination_portal, None),
                };
                (link.destination_node, portal.0.midpoint(portal.1), ignore_step)
            }
            PathNode::End => unreachable!("the goal is never expanded"),
        }
    }
}

impl<CS: CoordinateSystem> AStarProblem for ArchipelagoPathProblem<'_, CS> {
    type ActionType = PathStep;
    type StateType = PathNode;

    fn initial_state(&self) -> PathNode {
        PathNode::Start
    }

    fn successors(&self, state: &PathNode) -> Vec<(f32, PathStep, PathNode)> {
        let (node_ref, point, ignore_step) = self.state_origin(state);
        let island = self.nav_data.get_island(node_ref.island_id).expect("a searched node's island");
        let polygon = &island.nav_mesh.polygons[node_ref.polygon_index];
        let current_node_cost = self.walk_cost(polygon.type_index);
        if node_ref == self.end_node {
            return vec![(point.distance(self.end_point) * current_node_cost, PathStep::GoToEnd, PathNode::End)];
        }
        let empty = Set::default();
        let off_mesh_links = self.nav_data.node_to_off_mesh_link_ids.get(&node_ref).map_or(Cow::Owned(empty), Cow::Borrowed);

        let edges = polygon.connectivity.iter().enumerate().filter_map(|(edge_index, conn)| {
            let conn = conn.as_ref()?;
            if matches!(ignore_step, Some(PathStep::NodeConnection(ignore)) if ignore == edge_index) {
                return None;
            }
            if !self.type_index_to_cost(island.nav_mesh.polygons[conn.polygon_index].type_index).is_finite() {
                return None;
            }
            let (i, j) = polygon.get_edge_indices(edge_index);
            let local_midpoint = island.nav_mesh.vertices[i].midpoint(island.nav_mesh.vertices[j]);
            let cost = point.distance(island.transform.apply(local_midpoint)) * current_node_cost;
            let next = NodeRef { island_id: node_ref.island_id, polygon_index: conn.polygon_index };
            Some((cost, PathStep::NodeConnection(edge_index), PathNode::NodeEdge { node: next, start_edge: conn.reverse_edge }))
        });
        let links = off_mesh_links.iter().filter_map(|&link_id| {
            if matches!(ignore_step, Some(PathStep::OffMeshLink(ignore)) if ignore == link_id) {
                return None;
            }
            let link = self.nav_data.off_mesh_links.get(link_id).expect("a node's link");
            if !self.type_index_to_cost(link.destination_type_index).is_finite() {
                return None;
            }
            let link_cost = match link.kinded {
                // Boundary links cost nothing beyond the walk.
                KindedOffMeshLink::BoundaryLink { .. } => 0.0,
                KindedOffMeshLink::AnimationLink { cost, kind, animation_link, .. } => {
                    if !self.rules.permitted_animation_links.is_permitted(kind) || self.rules.gates.is_link_closed(animation_link) {
                        return None;
                    }
                    cost
                }
            };
            let cost = point.distance(link.portal.0.midpoint(link.portal.1)) * current_node_cost + link_cost;
            Some((cost, PathStep::OffMeshLink(link_id), PathNode::OffMeshLink(link_id)))
        });
        edges.chain(links).collect()
    }

    fn heuristic(&self, state: &PathNode) -> f32 {
        let world_point = match state {
            PathNode::Start => self.start_point,
            PathNode::End => return 0.0,
            PathNode::NodeEdge { node, start_edge } => {
                let island = self.nav_data.get_island(node.island_id).expect("a searched node's island");
                let edge = island.nav_mesh.get_edge_points(MeshEdgeRef { polygon_index: node.polygon_index, edge_index: *start_edge });
                island.transform.apply(edge.0.midpoint(edge.1))
            }
            PathNode::OffMeshLink(link) => {
                let off_mesh_link = self.nav_data.off_mesh_links.get(*link).expect("a searched link");
                let portal = match &off_mesh_link.kinded {
                    KindedOffMeshLink::BoundaryLink { .. } => off_mesh_link.portal,
                    KindedOffMeshLink::AnimationLink { destination_portal, .. } => *destination_portal,
                };
                portal.0.midpoint(portal.1)
            }
        };
        world_point.distance(self.end_point) * self.cheapest_type_index_cost
    }

    fn is_goal_state(&self, state: &PathNode) -> bool {
        matches!(state, PathNode::End)
    }
}

/// The result of a search.
#[derive(Debug)]
pub(crate) struct PathResult {
    /// Statistics about the search.
    pub(crate) stats: PathStats,
    /// The path: to the target, or (when `partial`) to the explored node nearest it.
    pub(crate) path: Option<Path>,
    /// Whether the search hit its node cap and `path` stops short.
    pub(crate) partial: bool,
}

/// The cheapest finite type cost after overrides (1 when no cost is set lower). As upstream, an
/// override of a type with no nav-wide cost does not count.
fn cheapest_cost<CS: CoordinateSystem>(nav_data: &NavigationData<CS>, overrides: &Map<usize, f32>) -> f32 {
    nav_data
        .get_type_index_costs()
        .map(|(type_index, cost)| overrides.get(&type_index).copied().unwrap_or(cost))
        .filter(|cost| cost.is_finite())
        .map(FloatOrd)
        .chain(core::iter::once(FloatOrd(1.0)))
        .min()
        .map_or(1.0, |cost| cost.0)
}

/// A path in `nav_data` from `start_point` in `start_node` to `end_point` in `end_node` (world
/// space, each inside its node), under `rules`.
pub(crate) fn find_path<CS: CoordinateSystem>(
    nav_data: &NavigationData<CS>,
    start_node: NodeRef,
    start_point: Vec3,
    end_node: NodeRef,
    end_point: Vec3,
    rules: SearchRules<'_>,
) -> PathResult {
    if !nav_data.are_nodes_connected(start_node, end_node, rules.permitted_animation_links.clone()) {
        return PathResult { stats: PathStats { explored_nodes: 0, capped: false }, path: None, partial: false };
    }
    let problem = ArchipelagoPathProblem {
        nav_data,
        start_node,
        start_point,
        end_node,
        end_point,
        cheapest_type_index_cost: cheapest_cost(nav_data, rules.override_type_index_to_cost),
        rules,
    };
    let result = astar::find_path_capped(&problem, rules.max_explored);
    if let Some(steps) = result.path {
        return PathResult { stats: result.stats, path: Some(build_path(nav_data, start_node, start_point, end_point, &steps)), partial: false };
    }
    let Some(steps) = result.partial else {
        return PathResult { stats: result.stats, path: None, partial: false };
    };
    let mut path = build_path(nav_data, start_node, start_point, end_point, &steps);
    path.end_point = partial_end(&problem, &path, &steps);
    PathResult { stats: result.stats, path: Some(path), partial: true }
}

/// Where a partial path ends: the point of the state its last step reached, on that node.
fn partial_end<CS: CoordinateSystem>(problem: &ArchipelagoPathProblem<'_, CS>, path: &Path, steps: &[PathStep]) -> Vec3 {
    let Some(last) = steps.last() else {
        return problem.start_point;
    };
    let segment = path.island_segments.last().expect("a path has a segment");
    let node = NodeRef { island_id: segment.island_id, polygon_index: *segment.corridor.last().expect("a corridor has a node") };
    let state = match *last {
        PathStep::NodeConnection(_) => {
            let previous = segment.corridor[segment.corridor.len() - 2];
            let island = problem.nav_data.get_island(node.island_id).expect("a path's island");
            let edge = island.nav_mesh.polygons[previous].connectivity[segment.portal_edge_index[segment.portal_edge_index.len() - 1]]
                .as_ref()
                .expect("a crossed edge connects");
            PathNode::NodeEdge { node, start_edge: edge.reverse_edge }
        }
        PathStep::OffMeshLink(link) => PathNode::OffMeshLink(link),
        PathStep::GoToEnd => return problem.end_point,
    };
    problem.state_origin(&state).1
}

/// The path the A* steps describe.
fn build_path<CS: CoordinateSystem>(
    nav_data: &NavigationData<CS>,
    start_node: NodeRef,
    start_point: Vec3,
    end_point: Vec3,
    steps: &[PathStep],
) -> Path {
    let mut path = Path { island_segments: Vec::new(), off_mesh_link_segments: Vec::new(), start_point, end_point };
    let first = IslandSegment { island_id: start_node.island_id, corridor: vec![start_node.polygon_index], portal_edge_index: Vec::new() };
    path.island_segments.push(first);
    for step in steps {
        let last_segment = path.island_segments.last_mut().expect("a path has a segment");
        let previous_node = *last_segment.corridor.last().expect("a corridor has a node");
        match *step {
            // The previous step already entered the end node.
            PathStep::GoToEnd => {}
            PathStep::NodeConnection(edge_index) => {
                let nav_mesh = &nav_data.get_island(last_segment.island_id).expect("a path's island").nav_mesh;
                let connectivity = nav_mesh.polygons[previous_node].connectivity[edge_index].as_ref().expect("a crossed edge connects");
                last_segment.corridor.push(connectivity.polygon_index);
                last_segment.portal_edge_index.push(edge_index);
            }
            PathStep::OffMeshLink(off_mesh_link_id) => {
                let starting_node = NodeRef { island_id: last_segment.island_id, polygon_index: previous_node };
                let off_mesh_link = nav_data.off_mesh_links.get(off_mesh_link_id).expect("a path's link");
                path.off_mesh_link_segments.push(OffMeshLinkSegment {
                    starting_node,
                    end_node: off_mesh_link.destination_node,
                    off_mesh_link: off_mesh_link_id,
                });
                path.island_segments.push(IslandSegment {
                    island_id: off_mesh_link.destination_node.island_id,
                    corridor: vec![off_mesh_link.destination_node.polygon_index],
                    portal_edge_index: Vec::new(),
                });
            }
        }
    }
    path
}

#[cfg(test)]
#[path = "pathfinding_test.rs"]
mod test;
