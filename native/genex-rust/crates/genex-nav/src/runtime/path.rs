//! A path on the navigation data (a corridor of nodes per island, joined by off-mesh links) and
//! the funnel that turns it into the next straight-line waypoint.
//!
//! Ported from landmass 0.9.3 `src/path.rs` (MIT OR Apache-2.0, used under Apache 2.0; crates.io
//! sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed (NAV-7):
//! P1, the invalidation sets are `Set`s; NAV-8 adds [`Path::crosses_closed`], which says whether
//! a corridor walks a shut area or takes a closed link (P14). The funnel itself is upstream's,
//! line for line, so its output matches upstream's fixtures (`path_test.rs`).

use core::cmp::Ordering;

use genex_core::map::Set;
use glam::{Vec3, Vec3Swizzles};

use super::coords::CoordinateSystem;
use super::geometry::project_point_to_line_segment;
use super::island::IslandId;
use super::link::AnimationLinkId;
use super::nav_data::{KindedOffMeshLink, NavigationData, NodeRef, OffMeshLinkId};
use crate::filter::Gates;

/// A path computed on the navigation data.
#[derive(PartialEq, Clone, Debug)]
pub struct Path {
    /// The segments on islands, joined by [`Path::off_mesh_link_segments`]. An island used only
    /// to take another off-mesh link still has its segment.
    pub(crate) island_segments: Vec<IslandSegment>,
    /// The off-mesh links between island segments: one fewer than the island segments.
    pub(crate) off_mesh_link_segments: Vec<OffMeshLinkSegment>,
    /// Where the path started (for debugging).
    pub(crate) start_point: Vec3,
    /// Where the path was going: the target, or the nearest reached node for a partial path.
    pub(crate) end_point: Vec3,
}

/// Part of a path on one island.
#[derive(PartialEq, Eq, Clone, Debug)]
pub(crate) struct IslandSegment {
    /// The island the nodes belong to.
    pub(crate) island_id: IslandId,
    /// The nodes, as polygon indices; at least one.
    pub(crate) corridor: Vec<usize>,
    /// The edge crossed out of each node: one fewer than the corridor.
    pub(crate) portal_edge_index: Vec<usize>,
}

/// Part of a path taking an off-mesh link.
#[derive(PartialEq, Eq, Clone, Debug)]
pub(crate) struct OffMeshLinkSegment {
    /// The node the link starts from.
    pub(crate) starting_node: NodeRef,
    /// The node the link ends at.
    pub(crate) end_node: NodeRef,
    /// The link.
    pub(crate) off_mesh_link: OffMeshLinkId,
}

/// A portal of a segment, in world space.
enum Portal {
    /// A walkable portal, left to right from the node it leaves.
    Walkable(Vec3, Vec3),
    /// An animation link's portal.
    AnimationLink {
        /// The edge to reach to take the link (order undefined).
        start_portal: (Vec3, Vec3),
        /// Where the link lands, in `start_portal`'s order.
        end_portal: (Vec3, Vec3),
        /// The animation link.
        link_id: AnimationLinkId,
        /// The node the link starts from.
        start_node: NodeRef,
        /// The node the link ends at.
        end_node: NodeRef,
    },
}

impl IslandSegment {
    fn get_portal_endpoints<CS: CoordinateSystem>(&self, portal_index: usize, nav_data: &NavigationData<CS>) -> Portal {
        let polygon_index = self.corridor[portal_index];
        let edge = self.portal_edge_index[portal_index];
        let island = nav_data.get_island(self.island_id).expect("only called while the path is valid");
        let (left_vertex, right_vertex) = island.nav_mesh.polygons[polygon_index].get_edge_indices(edge);
        Portal::Walkable(
            island.transform.apply(island.nav_mesh.vertices[left_vertex]),
            island.transform.apply(island.nav_mesh.vertices[right_vertex]),
        )
    }
}

impl OffMeshLinkSegment {
    fn get_portal_endpoints<CS: CoordinateSystem>(&self, nav_data: &NavigationData<CS>) -> Portal {
        let off_mesh_link = nav_data.off_mesh_links.get(self.off_mesh_link).expect("only called while the path is valid");
        let portal = off_mesh_link.portal;
        match &off_mesh_link.kinded {
            KindedOffMeshLink::BoundaryLink { .. } => Portal::Walkable(portal.0, portal.1),
            KindedOffMeshLink::AnimationLink { destination_portal, animation_link, .. } => Portal::AnimationLink {
                start_portal: portal,
                end_portal: *destination_portal,
                link_id: *animation_link,
                start_node: self.starting_node,
                end_node: self.end_node,
            },
        }
    }
}

/// An index in a path: a segment and a portal in its corridor. A corridor's last index is the
/// off-mesh link to the next segment, or the target node.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) struct PathIndex {
    segment_index: usize,
    portal_index: usize,
}

impl PathIndex {
    /// The index of `corridor_index` in island segment `island_segment_index`.
    pub(crate) fn from_corridor_index(island_segment_index: usize, corridor_index: usize) -> Self {
        Self { segment_index: island_segment_index, portal_index: corridor_index }
    }

    fn next(&self, path: &Path) -> Self {
        let new_portal_index = self.portal_index + 1;
        match new_portal_index.cmp(&path.island_segments[self.segment_index].portal_edge_index.len()) {
            Ordering::Less | Ordering::Equal => Self { segment_index: self.segment_index, portal_index: new_portal_index },
            Ordering::Greater if self.segment_index + 1 < path.island_segments.len() => {
                Self { segment_index: self.segment_index + 1, portal_index: 0 }
            }
            // Only the last segment may step past its end, so a range can include the end index.
            Ordering::Greater => Self { segment_index: self.segment_index, portal_index: new_portal_index },
        }
    }
}

/// A step of a straight-line path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum StraightPathStep {
    /// Walk straight to this point.
    Waypoint(Vec3),
    /// Take this animation link (walking to its start first).
    AnimationLink {
        /// Where to walk to take the link.
        start_point: Vec3,
        /// Where the link should lead (an approximation for straight paths).
        end_point: Vec3,
        /// The animation link.
        link_id: AnimationLinkId,
        /// The node the start point is in.
        start_node: NodeRef,
        /// The node the end point is in.
        end_node: NodeRef,
    },
}

/// Where the funnel ends for one step: the end point, or an animation link on the way.
enum EndOfPath {
    Point(Vec3),
    AnimationLink { start_point: Vec3, end_point: Vec3, link_id: AnimationLinkId, start_node: NodeRef, end_node: NodeRef },
}

/// Twice the signed area of the triangle in the ground plane (positive counter-clockwise).
fn triangle_area_2(point_0: Vec3, point_1: Vec3, point_2: Vec3) -> f32 {
    (point_1.xy() - point_0.xy()).perp_dot(point_2.xy() - point_0.xy())
}

/// The animation-link step for a portal reached from `apex`.
fn link_step(apex: Vec3, start_portal: (Vec3, Vec3), end_portal: (Vec3, Vec3)) -> (Vec3, Vec3) {
    let (start_point, fraction) = project_point_to_line_segment(apex, start_portal);
    (start_point, end_portal.0.lerp(end_portal.1, fraction))
}

impl Path {
    fn get_portal_endpoints<CS: CoordinateSystem>(&self, path_index: PathIndex, nav_data: &NavigationData<CS>) -> Portal {
        let segment = &self.island_segments[path_index.segment_index];
        if path_index.portal_index == segment.portal_edge_index.len() {
            self.off_mesh_link_segments[path_index.segment_index].get_portal_endpoints(nav_data)
        } else {
            segment.get_portal_endpoints(path_index.portal_index, nav_data)
        }
    }

    /// The next point along the path the agent can walk straight to, from `start_point` in node
    /// `start_index` toward `end_point` in node `end_index`: its index and the step. Feed the
    /// result back in to walk the whole straight path.
    pub(crate) fn find_next_point_in_straight_path<CS: CoordinateSystem>(
        &self,
        nav_data: &NavigationData<CS>,
        start_index: PathIndex,
        start_point: Vec3,
        end_index: PathIndex,
        end_point: Vec3,
    ) -> (PathIndex, StraightPathStep) {
        let apex = start_point;
        let (mut left_index, mut right_index) = (start_index, start_index);
        let mut end_index = end_index;
        let mut end_of_path = EndOfPath::Point(end_point);

        let (mut current_left, mut current_right) = if start_index == end_index {
            (end_point, end_point)
        } else {
            match self.get_portal_endpoints(start_index, nav_data) {
                Portal::Walkable(left, right) => (left, right),
                Portal::AnimationLink { start_portal, end_portal, link_id, start_node, end_node } => {
                    let (start_point, end_point) = link_step(apex, start_portal, end_portal);
                    // Skip to the index after the link.
                    let step = StraightPathStep::AnimationLink { start_point, end_point, link_id, start_node, end_node };
                    return (start_index.next(self), step);
                }
            }
        };

        let mut portal_index = start_index.next(self);
        while portal_index <= end_index {
            let (portal_left, portal_right) = if portal_index == end_index {
                (end_point, end_point)
            } else {
                match self.get_portal_endpoints(portal_index, nav_data) {
                    Portal::Walkable(left, right) => (left, right),
                    Portal::AnimationLink { start_portal, end_portal, link_id, start_node, end_node } => {
                        let (start_point, end_point) = link_step(apex, start_portal, end_portal);
                        // The link ends this step's funnel. Not a `break`: the funnel still decides
                        // whether the link's start is visible, or a corner comes first.
                        end_of_path = EndOfPath::AnimationLink { start_point, end_point, link_id, start_node, end_node };
                        end_index = portal_index;
                        (start_point, start_point)
                    }
                }
            };

            // Upstream's comparisons exactly (a NaN area returns the corner, as upstream does).
            if triangle_area_2(apex, current_right, portal_right) >= 0.0 {
                if triangle_area_2(apex, current_left, portal_right) <= 0.0 {
                    right_index = portal_index;
                    current_right = portal_right;
                } else {
                    return (left_index, StraightPathStep::Waypoint(current_left));
                }
            }

            if triangle_area_2(apex, current_left, portal_left) <= 0.0 {
                if triangle_area_2(apex, current_right, portal_left) >= 0.0 {
                    left_index = portal_index;
                    current_left = portal_left;
                } else {
                    return (right_index, StraightPathStep::Waypoint(current_right));
                }
            }

            portal_index = portal_index.next(self);
        }

        match end_of_path {
            EndOfPath::Point(end_point) => (end_index, StraightPathStep::Waypoint(end_point)),
            // Skip over the link: `portal_index` already stepped past it.
            EndOfPath::AnimationLink { start_point, end_point, link_id, start_node, end_node } => {
                (portal_index, StraightPathStep::AnimationLink { start_point, end_point, link_id, start_node, end_node })
            }
        }
    }

    /// The index of the path's last node.
    pub(crate) fn last_index(&self) -> PathIndex {
        let segment_index = self.island_segments.len() - 1;
        PathIndex { segment_index, portal_index: self.island_segments[segment_index].portal_edge_index.len() }
    }

    /// Whether the path still holds: no island it crosses changed and no off-mesh link it takes
    /// was dropped.
    pub(crate) fn is_valid(&self, invalidated_off_mesh_links: &Set<OffMeshLinkId>, invalidated_islands: &Set<IslandId>) -> bool {
        let island_changed = self.island_segments.iter().any(|segment| invalidated_islands.contains(&segment.island_id));
        let link_dropped =
            self.off_mesh_link_segments.iter().any(|segment| invalidated_off_mesh_links.contains(&segment.off_mesh_link));
        !island_changed && !link_dropped
    }

    /// Whether the path walks a node of a shut area or takes a closed animation link (P14).
    pub(crate) fn crosses_closed<CS: CoordinateSystem>(&self, nav_data: &NavigationData<CS>, gates: &Gates) -> bool {
        if gates.is_open_everywhere() {
            return false;
        }
        let shut_node = self.island_segments.iter().any(|segment| {
            let Some(island) = nav_data.get_island(segment.island_id) else {
                return false;
            };
            segment.corridor.iter().any(|&polygon| gates.is_area_shut(island.nav_mesh.polygons[polygon].type_index))
        });
        let closed_link = self.off_mesh_link_segments.iter().any(|segment| {
            nav_data.off_mesh_links.get(segment.off_mesh_link).is_some_and(|link| match &link.kinded {
                KindedOffMeshLink::BoundaryLink { .. } => gates.is_area_shut(link.destination_type_index),
                KindedOffMeshLink::AnimationLink { animation_link, .. } => {
                    gates.is_link_closed(*animation_link) || gates.is_area_shut(link.destination_type_index)
                }
            })
        });
        shut_node || closed_link
    }

    /// The index of `node` in the path, searching from the start.
    pub(crate) fn find_index_of_node(&self, node: NodeRef) -> Option<PathIndex> {
        self.island_segments.iter().enumerate().filter(|(_, segment)| segment.island_id == node.island_id).find_map(
            |(segment_index, segment)| {
                let portal_index = segment.corridor.iter().position(|&polygon| polygon == node.polygon_index)?;
                Some(PathIndex { segment_index, portal_index })
            },
        )
    }

    /// The index of `node` in the path, searching from the end (the target is usually near it).
    pub(crate) fn find_index_of_node_rev(&self, node: NodeRef) -> Option<PathIndex> {
        self.island_segments.iter().enumerate().rev().filter(|(_, segment)| segment.island_id == node.island_id).find_map(
            |(segment_index, segment)| {
                let portal_index = segment.corridor.iter().rposition(|&polygon| polygon == node.polygon_index)?;
                Some(PathIndex { segment_index, portal_index })
            },
        )
    }

    /// The nodes of the path, in order (for debug draws and probes).
    pub fn nodes(&self) -> impl Iterator<Item = NodeRef> + '_ {
        self.island_segments.iter().flat_map(|segment| {
            segment.corridor.iter().map(move |&polygon_index| NodeRef { island_id: segment.island_id, polygon_index })
        })
    }
}

#[cfg(test)]
#[path = "path_test.rs"]
mod test;
