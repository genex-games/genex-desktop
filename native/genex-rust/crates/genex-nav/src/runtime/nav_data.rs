//! The navigation data of an archipelago: its islands and animation links, the off-mesh links
//! that stitch touching islands together (boundary links) and attach animation links to nodes,
//! the nodes whose open boundary those links cut ("modified nodes"), and which regions connect.
//!
//! Ported from landmass 0.9.3 `src/nav_data.rs` (MIT OR Apache-2.0, used under Apache 2.0;
//! crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`).
//! Changed (the patch list, NAV-4):
//! - P1: every std `HashMap`/`HashSet` is a `Map`/`Set` (insertion order), and slotmap's
//!   `SlotMap`/`DenseSlotMap` are [`crate::arena::Arena`]s. Upstream walks dirty islands and each
//!   node's link set in a per-process hash order, so which link gets which id, which nodes are
//!   re-cut first and which region gets which number differed from run to run; here they follow
//!   the calls made. (`node_to_off_mesh_link_ids.retain` now visits nodes in insertion order.)
//! - P2: the `geo` union and inverted clip in `update_modified_node` are [`super::clip`].
//! - P3: the `kdtree` vertex snap is a [`super::grid::PointGrid`] (ties go to the earlier vertex).
//! - P4/P5: `Mutex<disjoint::DisjointSet>` is a plain [`super::disjoint::DisjointSet`].
//! - P7: the edge-link distance is the caller's ([`DEFAULT_EDGE_LINK_DISTANCE`], upstream's
//!   hard-coded 0.01 m with a TODO at `lib.rs:273`).
//! - A point animation link no longer widens to a NaN strip in `update_modified_node` (upstream
//!   normalizes a zero portal); a zero-length portal cuts nothing.
//! - Read-only accessors for probes and tests (`off_mesh_links_by_node`, `modified_nodes`,
//!   `region_numbers`, `region_root`).

use std::collections::VecDeque;
use std::ops::{Deref, DerefMut};

use genex_core::map::{FastMap, Map, Set};
use glam::{Vec2, Vec3, Vec3Swizzles};

use super::clip::{portal_strip, subtract_strips};
use super::coords::{CoordinateSystem, CorePointSampleDistance};
use super::disjoint::DisjointSet;
use super::geometry::edge_intersection;
use super::grid::PointGrid;
use super::island::{Island, IslandId};
use super::link::{AnimationLink, AnimationLinkId, AnimationLinkState, NodePortal, PermittedAnimationLinks};
use super::nav_mesh::{MeshEdgeRef, nav_mesh_node_bbh};
use super::util::{BoundingBox, BoundingBoxHierarchy, RaySegment};
use crate::arena::Arena;

/// How close two islands' boundary edges must be to stitch, in metres (landmass's fixed value).
pub const DEFAULT_EDGE_LINK_DISTANCE: f32 = 0.01;

/// The squared distance within which a cut boundary's end snaps back to an original polygon
/// vertex (landmass's k-d tree filter, `distance < 0.01` on squared distances).
const VERTEX_SNAP_DISTANCE_SQUARED: f32 = 0.01;

/// The grid cell for vertex snapping: the snap reach, so a query looks at 3 × 3 cells at most.
const VERTEX_SNAP_CELL: f32 = 0.1;

/// A node of the navigation data: a polygon of an island.
#[derive(PartialEq, Eq, Debug, Clone, Copy, Hash, PartialOrd, Ord)]
pub struct NodeRef {
    /// The node's island.
    pub island_id: IslandId,
    /// The polygon in the island's mesh.
    pub polygon_index: usize,
}

crate::arena_key! {
    /// The id of an off-mesh link.
    pub struct OffMeshLinkId;
}

/// A link between two nodes that is not part of either mesh.
#[derive(PartialEq, Debug, Clone)]
pub struct OffMeshLink {
    /// The node the link leads to.
    pub destination_node: NodeRef,
    /// The destination node's type index (stable once the link exists).
    pub destination_type_index: usize,
    /// The portal on the source node, in world space: left to right from the source node's
    /// centre for a boundary link, in no particular order for an animation link.
    pub portal: (Vec3, Vec3),
    /// What kind of link it is.
    pub kinded: KindedOffMeshLink,
}

/// The kind-specific part of an [`OffMeshLink`].
#[derive(PartialEq, Debug, Clone)]
pub enum KindedOffMeshLink {
    /// One side of a stitch between two islands' boundary edges.
    BoundaryLink {
        /// The link back from the destination node.
        reverse_link: OffMeshLinkId,
    },
    /// A part of an animation link attached to a node.
    AnimationLink {
        /// Where the link lands, in world space, in `portal`'s order.
        destination_portal: (Vec3, Vec3),
        /// The cost of taking the link.
        cost: f32,
        /// The animation link's kind.
        kind: usize,
        /// The animation link this came from.
        animation_link: AnimationLinkId,
    },
}

/// A node whose open boundary boundary links cut: what is left of it.
#[derive(PartialEq, Debug, Clone, Default)]
pub struct ModifiedNode {
    /// The remaining boundary edges, counter-clockwise like the polygons, as vertex indices:
    /// below the mesh's vertex count they are mesh vertices, above it they index `new_vertices`.
    pub new_boundary: Vec<(usize, usize)>,
    /// New 2D world-space vertices for cut ends; each serves one boundary edge.
    pub new_vertices: Vec<Vec2>,
}

/// A link that could connect two regions, if an agent may take its kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PossibleRegionLink {
    link_kind: usize,
    /// The root region the link leads to.
    destination_region: usize,
}

/// The navigation data of a whole archipelago (its static features).
pub struct NavigationData<CS: CoordinateSystem> {
    islands: Arena<IslandId, Island<CS>>,
    animation_links: Arena<AnimationLinkId, AnimationLinkState<CS>>,
    /// The default cost per type index (a missing one costs 1).
    type_index_to_cost: Map<usize, f32>,
    /// Whether anything changed since the last update; read nothing while it is set.
    pub(crate) dirty: bool,
    /// Region id (island, region in its mesh) → region number in `region_connections`.
    region_id_to_number: Map<(IslandId, usize), usize>,
    /// Which region numbers boundary links join.
    region_connections: DisjointSet,
    /// Root region number → the animation links that could join it to another region.
    root_region_number_to_possible_links: Map<usize, Vec<PossibleRegionLink>>,
    /// The off-mesh links.
    pub(crate) off_mesh_links: Arena<OffMeshLinkId, OffMeshLink>,
    /// The links that can be taken from each node.
    pub(crate) node_to_off_mesh_link_ids: FastMap<NodeRef, Set<OffMeshLinkId>>,
    /// The nodes boundary links cut.
    pub(crate) modified_nodes: Map<NodeRef, ModifiedNode>,
    deleted_islands: Set<IslandId>,
    new_animation_links: Set<AnimationLinkId>,
    deleted_animation_links: Set<AnimationLinkId>,
}

impl<CS: CoordinateSystem> Default for NavigationData<CS> {
    fn default() -> Self {
        Self::new()
    }
}

/// Why a type-index cost was refused.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SetTypeIndexCostError {
    /// The cost was zero, negative or NaN.
    NonPositiveCost(f32),
}

impl core::fmt::Display for SetTypeIndexCostError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NonPositiveCost(cost) => {
                write!(f, "The provided cost {cost} is non-positive. Type index costs must be positive.")
            }
        }
    }
}

impl core::error::Error for SetTypeIndexCostError {}

/// Sorts `start` and `end` for a link: a point start collapses the end to its midpoint, and a
/// two-way link with a point end collapses the start too.
fn collapse_link_edges<CS: CoordinateSystem>(link: &AnimationLink<CS>) -> ((Vec3, Vec3), (Vec3, Vec3)) {
    let mut start_edge = (CS::to_landmass(&link.start_edge.0), CS::to_landmass(&link.start_edge.1));
    let mut end_edge = (CS::to_landmass(&link.end_edge.0), CS::to_landmass(&link.end_edge.1));
    if start_edge.0 == start_edge.1 {
        // A point start with a full end edge: fall back to the end's midpoint.
        let end_midpoint = end_edge.0.midpoint(end_edge.1);
        end_edge = (end_midpoint, end_midpoint);
    } else if link.bidirectional && end_edge.0 == end_edge.1 {
        // A two-way link's end is also a start, so a point end collapses the start.
        let start_midpoint = start_edge.0.midpoint(start_edge.1);
        start_edge = (start_midpoint, start_midpoint);
    }
    (start_edge, end_edge)
}

fn portal_segment(portal: (Vec3, Vec3), interval: (f32, f32)) -> (Vec3, Vec3) {
    (portal.0.lerp(portal.1, interval.0), portal.0.lerp(portal.1, interval.1))
}

/// Where off-mesh links are written.
struct LinkSink<'a> {
    off_mesh_links: &'a mut Arena<OffMeshLinkId, OffMeshLink>,
    node_to_off_mesh_link_ids: &'a mut FastMap<NodeRef, Set<OffMeshLinkId>>,
}

impl LinkSink<'_> {
    fn add(&mut self, source: NodeRef, link: OffMeshLink) -> OffMeshLinkId {
        let id = self.off_mesh_links.insert(link);
        self.node_to_off_mesh_link_ids.entry(source).or_default().insert(id);
        id
    }
}

/// One animation link's portals and edges, attached as off-mesh links between node portals.
struct LinkAttach<'a, CS: CoordinateSystem> {
    id: AnimationLinkId,
    link: &'a AnimationLink<CS>,
    start_edge: (Vec3, Vec3),
    end_edge: (Vec3, Vec3),
}

impl<CS: CoordinateSystem> LinkAttach<'_, CS> {
    fn type_index(islands: &Arena<IslandId, Island<CS>>, node: NodeRef) -> usize {
        islands.get(node.island_id).map_or(0, |island| island.nav_mesh.polygons[node.polygon_index].type_index)
    }

    /// Links `start_portal` to `end_portal` over the part of the link both cover (and back, for a
    /// two-way link).
    fn connect(
        &self,
        start_portal: &NodePortal,
        end_portal: &NodePortal,
        islands: &Arena<IslandId, Island<CS>>,
        sink: &mut LinkSink<'_>,
    ) {
        let intersection = (start_portal.interval.0.max(end_portal.interval.0), start_portal.interval.1.min(end_portal.interval.1));
        if intersection.1 <= intersection.0 {
            return;
        }
        let start_edge = portal_segment(self.start_edge, intersection);
        let end_edge = portal_segment(self.end_edge, intersection);
        let animation = |destination_portal| KindedOffMeshLink::AnimationLink {
            destination_portal,
            cost: self.link.cost,
            kind: self.link.kind,
            animation_link: self.id,
        };
        sink.add(
            start_portal.node,
            OffMeshLink {
                portal: start_edge,
                destination_node: end_portal.node,
                destination_type_index: Self::type_index(islands, end_portal.node),
                kinded: animation(end_edge),
            },
        );
        if self.link.bidirectional {
            sink.add(
                end_portal.node,
                OffMeshLink {
                    portal: end_edge,
                    destination_node: start_portal.node,
                    destination_type_index: Self::type_index(islands, start_portal.node),
                    kinded: animation(start_edge),
                },
            );
        }
    }
}

/// What one update dropped and changed.
type UpdateChanges = (Set<OffMeshLinkId>, Set<IslandId>, Set<NodeRef>);

impl<CS: CoordinateSystem> NavigationData<CS> {
    /// Empty navigation data.
    pub fn new() -> Self {
        Self {
            islands: Arena::new(),
            animation_links: Arena::new(),
            type_index_to_cost: Map::default(),
            // Nothing to update yet.
            dirty: false,
            region_id_to_number: Map::default(),
            region_connections: DisjointSet::new(),
            root_region_number_to_possible_links: Map::default(),
            off_mesh_links: Arena::new(),
            node_to_off_mesh_link_ids: FastMap::default(),
            modified_nodes: Map::default(),
            deleted_islands: Set::default(),
            new_animation_links: Set::default(),
            deleted_animation_links: Set::default(),
        }
    }

    /// Sets the cost per metre of `type_index`.
    ///
    /// # Errors
    ///
    /// [`SetTypeIndexCostError::NonPositiveCost`] for a cost that is not above zero.
    pub fn set_type_index_cost(&mut self, type_index: usize, cost: f32) -> Result<(), SetTypeIndexCostError> {
        if cost.is_nan() || cost <= 0.0 {
            return Err(SetTypeIndexCostError::NonPositiveCost(cost));
        }
        self.type_index_to_cost.insert(type_index, cost);
        Ok(())
    }

    /// The cost of `type_index`, when one was set.
    pub fn get_type_index_cost(&self, type_index: usize) -> Option<f32> {
        self.type_index_to_cost.get(&type_index).copied()
    }

    /// The type indices with a cost, in the order they were first set.
    pub fn get_type_index_costs(&self) -> impl Iterator<Item = (usize, f32)> + '_ {
        self.type_index_to_cost.iter().map(|(&type_index, &cost)| (type_index, cost))
    }

    /// Adds an island.
    pub fn add_island(&mut self, island: Island<CS>) -> IslandId {
        self.dirty = true;
        self.islands.insert(island)
    }

    /// The island `id` names.
    pub fn get_island(&self, id: IslandId) -> Option<&Island<CS>> {
        self.islands.get(id)
    }

    /// The island `id` names, mutably (changing it marks the data dirty).
    pub fn get_island_mut(&mut self, id: IslandId) -> Option<IslandMut<'_, CS>> {
        self.islands.get_mut(id).map(|island| IslandMut { id, island, dirty_flag: &mut self.dirty })
    }

    /// The live islands, oldest first.
    pub fn get_island_ids(&self) -> impl Iterator<Item = IslandId> + '_ {
        self.islands.keys()
    }

    /// Removes an island; returns whether it was live.
    pub fn remove_island(&mut self, island_id: IslandId) -> bool {
        if self.islands.remove(island_id).is_none() {
            return false;
        }
        self.dirty = true;
        self.deleted_islands.insert(island_id);
        true
    }

    /// Adds an animation link.
    pub fn add_animation_link(&mut self, link: AnimationLink<CS>) -> AnimationLinkId {
        self.dirty = true;
        let link_id = self.animation_links.insert(AnimationLinkState::new(link));
        self.new_animation_links.insert(link_id);
        link_id
    }

    /// Removes an animation link; returns whether it was live.
    pub fn remove_animation_link(&mut self, link_id: AnimationLinkId) -> bool {
        if self.animation_links.remove(link_id).is_none() {
            return false;
        }
        self.dirty = true;
        self.new_animation_links.shift_remove(&link_id);
        self.deleted_animation_links.insert(link_id);
        true
    }

    /// The animation link `link_id` names.
    pub fn get_animation_link(&self, link_id: AnimationLinkId) -> Option<&AnimationLink<CS>> {
        self.animation_links.get(link_id).map(|state| &state.main_link)
    }

    /// The live animation links, oldest first.
    pub fn get_animation_link_ids(&self) -> impl Iterator<Item = AnimationLinkId> + '_ {
        self.animation_links.keys()
    }

    /// The off-mesh link `id` names.
    pub fn off_mesh_link(&self, id: OffMeshLinkId) -> Option<&OffMeshLink> {
        self.off_mesh_links.get(id)
    }

    /// Every off-mesh link with the node it starts from, in the data's own order (nodes in the
    /// order they first got a link, each node's links in the order they were made).
    pub fn off_mesh_links_by_node(&self) -> impl Iterator<Item = (NodeRef, OffMeshLinkId, &OffMeshLink)> + '_ {
        self.node_to_off_mesh_link_ids.iter().flat_map(move |(&node, links)| {
            links.iter().filter_map(move |&id| self.off_mesh_links.get(id).map(|link| (node, id, link)))
        })
    }

    /// The nodes boundary links cut, with what is left of their boundary.
    pub fn modified_nodes(&self) -> impl Iterator<Item = (NodeRef, &ModifiedNode)> + '_ {
        self.modified_nodes.iter().map(|(&node, modified)| (node, modified))
    }

    /// Region id (island, region of its mesh) → region number, for regions some off-mesh link
    /// touches.
    pub fn region_numbers(&self) -> impl Iterator<Item = ((IslandId, usize), usize)> + '_ {
        self.region_id_to_number.iter().map(|(&id, &number)| (id, number))
    }

    /// The root of a region number's connected set.
    ///
    /// # Panics
    ///
    /// When `number` is not a region number of the last update.
    pub fn region_root(&self, number: usize) -> usize {
        self.region_connections.root_of(number)
    }

    /// The node nearest to `point` within the sample distance on any island, and the point on
    /// it. Ties keep the older island.
    pub fn sample_point(&self, point: Vec3, point_sample_distance: &CorePointSampleDistance) -> Option<(Vec3, NodeRef)> {
        let h = point_sample_distance.horizontal_distance;
        let mut best_point: Option<(f32, (Vec3, NodeRef))> = None;
        for (island_id, island) in self.islands.iter() {
            let relative_point = island.transform.apply_inverse(point);
            // The box grows down by distance_above: sampling up from the point is the box growing down.
            let reach = island.nav_mesh.mesh_bounds.add_to_corners(
                Vec3::new(-h, -h, -point_sample_distance.distance_above),
                Vec3::new(h, h, point_sample_distance.distance_below),
            );
            if !reach.contains_point(relative_point) {
                continue;
            }
            let Some((sampled_point, sampled_node)) = island.nav_mesh.sample_point(relative_point, point_sample_distance)
            else {
                continue;
            };
            let distance = relative_point.distance_squared(sampled_point);
            if best_point.as_ref().is_some_and(|(best, _)| distance >= *best) {
                continue;
            }
            best_point = Some((
                distance,
                (island.transform.apply(sampled_point), NodeRef { island_id, polygon_index: sampled_node }),
            ));
        }
        best_point.map(|(_, b)| b)
    }


    /// Drops the links that start on or lead to a changed island, or came from a deleted
    /// animation link, and the changed islands' portals from the animation links that lost a
    /// link. Returns the dropped links and the nodes that lost a boundary link.
    fn drop_stale_links(&mut self, changed_islands: &Set<IslandId>) -> (Set<OffMeshLinkId>, Set<NodeRef>) {
        let mut dropped_links = Set::default();
        let mut changed_animation_links: Set<AnimationLinkId> = Set::default();
        let mut modified_node_refs_to_update = Set::default();
        let off_mesh_links = &mut self.off_mesh_links;
        let deleted_animation_links = &self.deleted_animation_links;
        self.node_to_off_mesh_link_ids.retain(|node_ref, links| {
            let mut has_dropped_boundary_link = false;
            if changed_islands.contains(&node_ref.island_id) {
                for &link in links.iter() {
                    has_dropped_boundary_link |= drop_link(off_mesh_links, link, &mut changed_animation_links);
                }
                if has_dropped_boundary_link {
                    modified_node_refs_to_update.insert(*node_ref);
                }
                dropped_links.extend(links.iter().copied());
                return false;
            }
            links.retain(|&link_id| {
                let Some(link) = off_mesh_links.get(link_id) else {
                    return false;
                };
                let leads_to_changed = changed_islands.contains(&link.destination_node.island_id);
                let from_deleted = matches!(
                    &link.kinded,
                    KindedOffMeshLink::AnimationLink { animation_link, .. } if deleted_animation_links.contains(animation_link)
                );
                if !leads_to_changed && !from_deleted {
                    return true;
                }
                has_dropped_boundary_link |= drop_link(off_mesh_links, link_id, &mut changed_animation_links);
                dropped_links.insert(link_id);
                false
            });
            if has_dropped_boundary_link {
                // A node with a different set of boundary links is re-cut.
                modified_node_refs_to_update.insert(*node_ref);
            }
            !links.is_empty()
        });

        for &animation_link_id in &changed_animation_links {
            // A deleted animation link has nothing left to update.
            let Some(state) = self.animation_links.get_mut(animation_link_id) else {
                continue;
            };
            state.start_portals.retain(|portal| !changed_islands.contains(&portal.node.island_id));
            state.end_portals.retain(|portal| !changed_islands.contains(&portal.node.island_id));
        }
        (dropped_links, modified_node_refs_to_update)
    }

    fn update_islands(&mut self, edge_link_distance: f32, animation_link_distance: f32) -> UpdateChanges {
        let mut dirty_islands: Set<IslandId> = Set::default();
        self.islands.for_each_mut(|island_id, island| {
            if island.dirty {
                island.dirty = false;
                dirty_islands.insert(island_id);
            }
        });
        let changed_islands: Set<IslandId> = self.deleted_islands.union(&dirty_islands).copied().collect();

        let something_to_drop =
            !self.deleted_islands.is_empty() || !dirty_islands.is_empty() || !self.deleted_animation_links.is_empty();
        let (dropped_links, mut modified_node_refs_to_update) =
            if something_to_drop { self.drop_stale_links(&changed_islands) } else { (Set::default(), Set::default()) };
        self.deleted_islands.clear();
        self.deleted_animation_links.clear();

        if dirty_islands.is_empty() && self.new_animation_links.is_empty() {
            // Nothing new to link.
            return (dropped_links, changed_islands, modified_node_refs_to_update);
        }
        // New links stop being new whatever happens next.
        let new_animation_links = core::mem::take(&mut self.new_animation_links);

        let mut island_bounds = self
            .islands
            .iter()
            .filter(|(_, island)| !island.transformed_bounds.is_empty())
            .map(|(island_id, island)| (island.transformed_bounds, Some(island_id)))
            .collect::<Vec<_>>();
        if island_bounds.is_empty() {
            // No island has nav data: nothing to link (and the hierarchy needs one box).
            return (dropped_links, changed_islands, modified_node_refs_to_update);
        }
        let island_bbh = BoundingBoxHierarchy::new(&mut island_bounds);

        self.create_boundary_links(&island_bbh, &dirty_islands, edge_link_distance, &mut modified_node_refs_to_update);
        self.create_off_mesh_links_for_animation_links(
            &new_animation_links,
            &changed_islands,
            &island_bbh,
            animation_link_distance,
        );
        (dropped_links, changed_islands, modified_node_refs_to_update)
    }

    fn create_boundary_links(
        &mut self,
        island_bbh: &BoundingBoxHierarchy<IslandId>,
        dirty_islands: &Set<IslandId>,
        edge_link_distance: f32,
        modified_node_refs_to_update: &mut Set<NodeRef>,
    ) {
        for &dirty_island_id in dirty_islands {
            let Some(dirty_island) = self.islands.get(dirty_island_id) else {
                continue;
            };
            if dirty_island.nav_mesh.boundary_edges.is_empty() {
                continue;
            }
            let query = dirty_island.transformed_bounds.expand_by_size(Vec3::ONE * edge_link_distance);
            let candidate_islands = island_bbh.query_box(query);
            // Only the dirty island itself: nothing to link.
            if candidate_islands.len() <= 1 {
                continue;
            }
            let dirty_island_edge_bbh = island_edges_bbh(dirty_island);
            for &candidate_island_id in candidate_islands {
                // Linking goes both ways, so a pair of dirty islands is linked once (lower id second).
                let pair_done = dirty_islands.contains(&candidate_island_id) && candidate_island_id < dirty_island_id;
                if candidate_island_id == dirty_island_id || pair_done {
                    continue;
                }
                let Some(candidate_island) = self.islands.get(candidate_island_id) else {
                    continue;
                };
                let mut sink = LinkSink {
                    off_mesh_links: &mut self.off_mesh_links,
                    node_to_off_mesh_link_ids: &mut self.node_to_off_mesh_link_ids,
                };
                link_edges_between_islands(
                    (dirty_island_id, dirty_island),
                    (candidate_island_id, candidate_island),
                    &dirty_island_edge_bbh,
                    edge_link_distance,
                    &mut sink,
                    modified_node_refs_to_update,
                );
            }
        }
    }

    fn create_off_mesh_links_for_animation_links(
        &mut self,
        new_animation_links: &Set<AnimationLinkId>,
        changed_islands: &Set<IslandId>,
        island_bbh: &BoundingBoxHierarchy<IslandId>,
        max_vertical_distance: f32,
    ) {
        let mut island_to_node_bbh: Map<IslandId, BoundingBoxHierarchy<usize>> = Map::default();
        for &animation_link_id in new_animation_links {
            let Some(state) = self.animation_links.get_mut(animation_link_id) else {
                continue;
            };
            let (start_edge, end_edge) = collapse_link_edges(&state.main_link);
            state.start_portals = world_portal_to_node_portals(
                start_edge,
                island_bbh,
                &self.islands,
                &mut island_to_node_bbh,
                max_vertical_distance,
            );
            state.end_portals =
                world_portal_to_node_portals(end_edge, island_bbh, &self.islands, &mut island_to_node_bbh, max_vertical_distance);
            let attach = LinkAttach { id: animation_link_id, link: &state.main_link, start_edge, end_edge };
            let mut sink = LinkSink {
                off_mesh_links: &mut self.off_mesh_links,
                node_to_off_mesh_link_ids: &mut self.node_to_off_mesh_link_ids,
            };
            for start_portal in &state.start_portals {
                for end_portal in &state.end_portals {
                    attach.connect(start_portal, end_portal, &self.islands, &mut sink);
                }
            }
        }

        for &island_id in changed_islands {
            // A deleted island is "changed" too.
            let Some(island) = self.islands.get(island_id) else {
                continue;
            };
            if island.nav_mesh.polygons.is_empty() {
                continue;
            }
            let mut node_bbh = None;
            let link_ids: Vec<AnimationLinkId> = self.animation_links.keys().collect();
            for animation_link_id in link_ids {
                // New links were attached above; doing it again would duplicate their links.
                if new_animation_links.contains(&animation_link_id) {
                    continue;
                }
                let Some(state) = self.animation_links.get_mut(animation_link_id) else {
                    continue;
                };
                let (start_edge, end_edge) = collapse_link_edges(&state.main_link);
                if node_bbh.is_none() {
                    let near = intersects(start_edge, &island.transformed_bounds)
                        || intersects(end_edge, &island.transformed_bounds);
                    if !near {
                        continue;
                    }
                    node_bbh =
                        Some(nav_mesh_node_bbh(island.nav_mesh.as_ref(), Vec3::new(0.0, 0.0, max_vertical_distance)));
                }
                let Some(node_bbh) = node_bbh.as_ref() else {
                    continue;
                };
                let new_start_portals = sample_portal_edge(start_edge, island_id, island, node_bbh, max_vertical_distance);
                let new_end_portals = sample_portal_edge(end_edge, island_id, island, node_bbh, max_vertical_distance);

                let attach = LinkAttach { id: animation_link_id, link: &state.main_link, start_edge, end_edge };
                let mut sink = LinkSink {
                    off_mesh_links: &mut self.off_mesh_links,
                    node_to_off_mesh_link_ids: &mut self.node_to_off_mesh_link_ids,
                };
                for start_portal in &new_start_portals {
                    for end_portal in state.end_portals.iter().chain(new_end_portals.iter()) {
                        attach.connect(start_portal, end_portal, &self.islands, &mut sink);
                    }
                }
                for end_portal in &new_end_portals {
                    for start_portal in &state.start_portals {
                        attach.connect(start_portal, end_portal, &self.islands, &mut sink);
                    }
                }
                state.start_portals.extend(new_start_portals);
                state.end_portals.extend(new_end_portals);
            }
        }
    }

    /// Re-cuts `node_ref`'s open boundary by its boundary links (or forgets it when it has none).
    fn update_modified_node(&mut self, node_ref: NodeRef, edge_link_distance: f32) {
        // A node of a deleted island, or one without links, is no longer modified.
        let (Some(island), Some(link_ids)) =
            (self.islands.get(node_ref.island_id), self.node_to_off_mesh_link_ids.get(&node_ref))
        else {
            self.modified_nodes.shift_remove(&node_ref);
            return;
        };
        let links: Vec<&OffMeshLink> = link_ids.iter().filter_map(|id| self.off_mesh_links.get(*id)).collect();
        if !links.iter().any(|link| matches!(link.kinded, KindedOffMeshLink::BoundaryLink { .. })) {
            self.modified_nodes.shift_remove(&node_ref);
            return;
        }

        let polygon = &island.nav_mesh.polygons[node_ref.polygon_index];
        let world = |vertex: usize| island.transform.apply(island.nav_mesh.vertices[vertex]).xy();

        // The open boundary as runs of consecutive unconnected edges, in world space.
        let mut runs: Vec<Vec<Vec2>> = Vec::new();
        let mut current: Vec<Vec2> = Vec::new();
        for (i, &vertex) in polygon.vertices.iter().enumerate() {
            if polygon.connectivity[i].is_some() {
                if !current.is_empty() {
                    // The right end of the previous edge.
                    current.push(world(vertex));
                    runs.push(core::mem::take(&mut current));
                }
                continue;
            }
            current.push(world(vertex));
        }
        if !current.is_empty() {
            // The closing edge is open: finish it at the first vertex.
            current.push(world(polygon.vertices[0]));
            runs.push(current);
        }

        // Every link's portal (animation links' too, as upstream) widened into a strip.
        let strips: Vec<[Vec2; 4]> =
            links.iter().map(|link| portal_strip((link.portal.0.xy(), link.portal.1.xy()), edge_link_distance)).collect();

        let mut original_vertices = PointGrid::new(VERTEX_SNAP_CELL);
        for &index in &polygon.vertices {
            original_vertices.insert(world(index), index);
        }
        let polygon_center = island.transform.apply(polygon.center).xy();
        let vertex_count = island.nav_mesh.vertices.len();

        let mut modified_node = ModifiedNode::default();
        for run in &runs {
            for pair in run.windows(2) {
                for (start, end) in subtract_strips((pair[0], pair[1]), &strips) {
                    let start_index = original_vertices.nearest_within(start, VERTEX_SNAP_DISTANCE_SQUARED).copied();
                    let end_index = original_vertices.nearest_within(end, VERTEX_SNAP_DISTANCE_SQUARED).copied();
                    // Both ends on one vertex: a degenerate edge.
                    if let (Some(s), Some(e)) = (start_index, end_index)
                        && s == e
                    {
                        continue;
                    }
                    let mut index_or_new = |index: Option<usize>, point: Vec2| {
                        index.unwrap_or_else(|| {
                            modified_node.new_vertices.push(point);
                            vertex_count + modified_node.new_vertices.len() - 1
                        })
                    };
                    let mut start_index = index_or_new(start_index, start);
                    let mut end_index = index_or_new(end_index, end);
                    // Keep the polygons' winding.
                    if (start - polygon_center).perp_dot(end - polygon_center) < 0.0 {
                        core::mem::swap(&mut start_index, &mut end_index);
                    }
                    modified_node.new_boundary.push((start_index, end_index));
                }
            }
        }
        self.modified_nodes.insert(node_ref, modified_node);
    }

    fn node_to_region_id(&self, node_ref: NodeRef) -> (IslandId, usize) {
        let region = self
            .islands
            .get(node_ref.island_id)
            .map_or(0, |island| island.nav_mesh.polygons[node_ref.polygon_index].region);
        (node_ref.island_id, region)
    }

    /// Whether some path may join `node_1` and `node_2`, using only the permitted animation links.
    pub fn are_nodes_connected(
        &self,
        node_1: NodeRef,
        node_2: NodeRef,
        permitted_animation_links: PermittedAnimationLinks,
    ) -> bool {
        let region_id_1 = self.node_to_region_id(node_1);
        let region_id_2 = self.node_to_region_id(node_2);
        if region_id_1 == region_id_2 {
            return true;
        }
        // A region no off-mesh link touches connects to nothing else.
        let (Some(&region_number_1), Some(&region_number_2)) =
            (self.region_id_to_number.get(&region_id_1), self.region_id_to_number.get(&region_id_2))
        else {
            return false;
        };
        let region_number_1 = self.region_connections.root_of(region_number_1);
        let region_number_2 = self.region_connections.root_of(region_number_2);
        if region_number_1 == region_number_2 {
            return true;
        }

        // Otherwise breadth-first over the links that could join regions.
        let mut seen_regions: Set<usize> = Set::default();
        let mut region_queue = VecDeque::new();
        seen_regions.insert(region_number_1);
        region_queue.push_back(region_number_1);
        while let Some(region_number) = region_queue.pop_front() {
            if region_number == region_number_2 {
                return true;
            }
            let Some(possible_links) = self.root_region_number_to_possible_links.get(&region_number) else {
                continue;
            };
            for &PossibleRegionLink { link_kind, destination_region } in possible_links {
                if permitted_animation_links.is_permitted(link_kind) && seen_regions.insert(destination_region) {
                    region_queue.push_back(destination_region);
                }
            }
        }
        false
    }

    /// The region number of `node`'s region, numbering it when new.
    fn region_number(&mut self, node: NodeRef) -> usize {
        let region_id = self.node_to_region_id(node);
        if let Some(&number) = self.region_id_to_number.get(&region_id) {
            return number;
        }
        let number = self.region_connections.add_singleton();
        self.region_id_to_number.insert(region_id, number);
        number
    }

    fn update_regions(&mut self) {
        self.region_id_to_number.clear();
        self.root_region_number_to_possible_links.clear();
        self.region_connections.clear();

        // (source, destination, animation link kind or None for a boundary link).
        let links: Vec<(NodeRef, NodeRef, Option<usize>)> = self
            .off_mesh_links_by_node()
            .map(|(node, _, link)| {
                let kind = match &link.kinded {
                    KindedOffMeshLink::BoundaryLink { .. } => None,
                    KindedOffMeshLink::AnimationLink { kind, .. } => Some(*kind),
                };
                (node, link.destination_node, kind)
            })
            .collect();

        // Boundary links join regions for sure.
        for &(start, end, kind) in &links {
            if kind.is_some() {
                continue;
            }
            let (start, end) = (self.region_number(start), self.region_number(end));
            self.region_connections.join(start, end);
        }
        // Animation links join them only for agents allowed their kind.
        for &(start, end, kind) in &links {
            let Some(link_kind) = kind else {
                continue;
            };
            let (start, end) = (self.region_number(start), self.region_number(end));
            if self.region_connections.is_joined(start, end) {
                continue;
            }
            let start = self.region_connections.root_of(start);
            let destination_region = self.region_connections.root_of(end);
            self.root_region_number_to_possible_links
                .entry(start)
                .or_default()
                .push(PossibleRegionLink { link_kind, destination_region });
        }
    }

    /// Re-stitches what changed since the last update. Returns the off-mesh links it dropped and
    /// the islands that changed (agents on them repath).
    pub fn update(&mut self, edge_link_distance: f32, animation_link_distance: f32) -> (Set<OffMeshLinkId>, Set<IslandId>) {
        if !self.dirty {
            return (Set::default(), Set::default());
        }
        self.dirty = false;
        let animation_links_changed = !self.new_animation_links.is_empty() || !self.deleted_animation_links.is_empty();
        let (dropped_links, changed_islands, modified_node_refs_to_update) =
            self.update_islands(edge_link_distance, animation_link_distance);
        for node_ref in modified_node_refs_to_update {
            self.update_modified_node(node_ref, edge_link_distance);
        }
        if animation_links_changed || !changed_islands.is_empty() {
            self.update_regions();
        }
        (dropped_links, changed_islands)
    }
}

/// Removes `link_id`; returns whether it was a boundary link, and records an animation link's
/// source as changed.
fn drop_link(
    off_mesh_links: &mut Arena<OffMeshLinkId, OffMeshLink>,
    link_id: OffMeshLinkId,
    changed_animation_links: &mut Set<AnimationLinkId>,
) -> bool {
    match off_mesh_links.remove(link_id).map(|link| link.kinded) {
        Some(KindedOffMeshLink::BoundaryLink { .. }) => true,
        Some(KindedOffMeshLink::AnimationLink { animation_link, .. }) => {
            changed_animation_links.insert(animation_link);
            false
        }
        None => false,
    }
}

/// A mutable borrow of an island; changing it marks the navigation data dirty.
pub struct IslandMut<'nav_data, CS: CoordinateSystem> {
    id: IslandId,
    island: &'nav_data mut Island<CS>,
    dirty_flag: &'nav_data mut bool,
}

impl<CS: CoordinateSystem> Deref for IslandMut<'_, CS> {
    type Target = Island<CS>;

    fn deref(&self) -> &Self::Target {
        self.island
    }
}

impl<CS: CoordinateSystem> DerefMut for IslandMut<'_, CS> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        *self.dirty_flag = true;
        self.island
    }
}

impl<CS: CoordinateSystem> IslandMut<'_, CS> {
    /// The borrowed island's id.
    pub fn id(&self) -> IslandId {
        self.id
    }
}

fn edge_ref_to_world_edge<CS: CoordinateSystem>(edge: MeshEdgeRef, island: &Island<CS>) -> (Vec3, Vec3) {
    let (a, b) = island.nav_mesh.get_edge_points(edge);
    (island.transform.apply(a), island.transform.apply(b))
}

fn edge_to_bbox(edge: (Vec3, Vec3)) -> BoundingBox {
    BoundingBox::new_box(edge.0, edge.0).expand_to_point(edge.1)
}

/// A hierarchy over an island's boundary edges in world space (the island has some).
fn island_edges_bbh<CS: CoordinateSystem>(island: &Island<CS>) -> BoundingBoxHierarchy<MeshEdgeRef> {
    let mut edge_bounds = island
        .nav_mesh
        .boundary_edges
        .iter()
        .map(|&edge| (edge_to_bbox(edge_ref_to_world_edge(edge, island)), Some(edge)))
        .collect::<Vec<_>>();
    BoundingBoxHierarchy::new(&mut edge_bounds)
}

/// Stitches island 2's boundary edges to the island 1 edges they overlap: a pair of boundary
/// links per portal.
fn link_edges_between_islands<CS: CoordinateSystem>(
    (island_id_1, island_1): (IslandId, &Island<CS>),
    (island_id_2, island_2): (IslandId, &Island<CS>),
    island_1_edge_bbh: &BoundingBoxHierarchy<MeshEdgeRef>,
    edge_link_distance: f32,
    sink: &mut LinkSink<'_>,
    modified_node_refs_to_update: &mut Set<NodeRef>,
) {
    let edge_link_distance_squared = edge_link_distance * edge_link_distance;
    for &island_2_edge_ref in &island_2.nav_mesh.boundary_edges {
        let island_2_edge = edge_ref_to_world_edge(island_2_edge_ref, island_2);
        let island_2_edge_bbox = edge_to_bbox(island_2_edge).expand_by_size(Vec3::ONE * edge_link_distance);
        for &island_1_edge_ref in island_1_edge_bbh.query_box(island_2_edge_bbox) {
            let island_1_edge = edge_ref_to_world_edge(island_1_edge_ref, island_1);
            let Some(portal) = edge_intersection(island_1_edge, island_2_edge, edge_link_distance_squared) else {
                continue;
            };
            if portal.0.distance_squared(portal.1) < edge_link_distance_squared {
                continue;
            }
            let node_1 = NodeRef { island_id: island_id_1, polygon_index: island_1_edge_ref.polygon_index };
            let node_2 = NodeRef { island_id: island_id_2, polygon_index: island_2_edge_ref.polygon_index };
            let type_1 = island_1.nav_mesh.polygons[island_1_edge_ref.polygon_index].type_index;
            let type_2 = island_2.nav_mesh.polygons[island_2_edge_ref.polygon_index].type_index;

            // The reverse id is patched in once the second link exists.
            let id_1 = sink.add(
                node_1,
                OffMeshLink {
                    destination_node: node_2,
                    destination_type_index: type_2,
                    portal,
                    kinded: KindedOffMeshLink::BoundaryLink { reverse_link: OffMeshLinkId::default() },
                },
            );
            let id_2 = sink.add(
                node_2,
                OffMeshLink {
                    destination_node: node_1,
                    destination_type_index: type_1,
                    portal: (portal.1, portal.0),
                    kinded: KindedOffMeshLink::BoundaryLink { reverse_link: id_1 },
                },
            );
            if let Some(link) = sink.off_mesh_links.get_mut(id_1) {
                link.kinded = KindedOffMeshLink::BoundaryLink { reverse_link: id_2 };
            }
            modified_node_refs_to_update.insert(node_1);
            modified_node_refs_to_update.insert(node_2);
        }
    }
}

/// Whether a portal (a segment, or a point when its ends are equal) touches `bounds`.
fn intersects(portal: (Vec3, Vec3), bounds: &BoundingBox) -> bool {
    if portal.0 == portal.1 {
        bounds.contains_point(portal.0)
    } else {
        bounds.intersects_ray_segment(&RaySegment::new(portal.0, portal.1))
    }
}

/// The animation-link vertical reach as a point sample distance (straight up and down only).
fn link_sample_distance(max_vertical_distance: f32) -> CorePointSampleDistance {
    CorePointSampleDistance {
        distance_above: max_vertical_distance,
        distance_below: max_vertical_distance,
        horizontal_distance: 0.0,
        vertical_preference_ratio: 1.0,
    }
}

/// A world portal (or point) sampled on one island's nodes.
fn sample_portal_edge<CS: CoordinateSystem>(
    edge: (Vec3, Vec3),
    island_id: IslandId,
    island: &Island<CS>,
    node_bbh: &BoundingBoxHierarchy<usize>,
    max_vertical_distance: f32,
) -> Vec<NodePortal> {
    if edge.0 == edge.1 {
        let point = island.transform.apply_inverse(edge.0);
        return island
            .nav_mesh
            .sample_point(point, &link_sample_distance(max_vertical_distance))
            .map(|(_, node)| NodePortal { interval: (0.0, 1.0), node: NodeRef { island_id, polygon_index: node } })
            .into_iter()
            .collect();
    }
    let edge = (island.transform.apply_inverse(edge.0), island.transform.apply_inverse(edge.1));
    island
        .nav_mesh
        .sample_edge(edge, node_bbh, max_vertical_distance)
        .into_iter()
        .map(|edge| NodePortal { interval: edge.interval, node: NodeRef { island_id, polygon_index: edge.node } })
        .collect()
}

/// A world portal sampled on the nodes of every island near it (in no particular point order).
fn world_portal_to_node_portals<CS: CoordinateSystem>(
    portal: (Vec3, Vec3),
    island_bbh: &BoundingBoxHierarchy<IslandId>,
    islands: &Arena<IslandId, Island<CS>>,
    island_to_node_bbh: &mut Map<IslandId, BoundingBoxHierarchy<usize>>,
    max_vertical_distance: f32,
) -> Vec<NodePortal> {
    if portal.0 == portal.1 {
        return sample_animation_link_point(portal.0, island_bbh, islands, max_vertical_distance)
            .into_iter()
            .map(|node| NodePortal { node, interval: (0.0, 1.0) })
            .collect();
    }
    let mut node_portals = vec![];
    let query_box = BoundingBox::Empty
        .expand_to_point(portal.0)
        .expand_to_point(portal.1)
        .expand_by_size(Vec3::new(0.0, 0.0, max_vertical_distance));
    for &island_id in island_bbh.query_box(query_box) {
        let Some(island) = islands.get(island_id) else {
            continue;
        };
        // An empty island has no nodes to sample (and the hierarchy needs one).
        if island.nav_mesh.polygons.is_empty() {
            continue;
        }
        let node_bbh = island_to_node_bbh.entry(island_id).or_insert_with(|| {
            nav_mesh_node_bbh(island.nav_mesh.as_ref(), Vec3::new(0.0, 0.0, max_vertical_distance))
        });
        let local_portal = (island.transform.apply_inverse(portal.0), island.transform.apply_inverse(portal.1));
        node_portals.extend(island.nav_mesh.sample_edge(local_portal, node_bbh, max_vertical_distance).into_iter().map(
            |edge| NodePortal { node: NodeRef { island_id, polygon_index: edge.node }, interval: edge.interval },
        ));
    }
    node_portals
}

/// The node straight above or below `point` on the nearest island (ties keep the first found).
fn sample_animation_link_point<CS: CoordinateSystem>(
    point: Vec3,
    island_bbh: &BoundingBoxHierarchy<IslandId>,
    islands: &Arena<IslandId, Island<CS>>,
    max_vertical_distance: f32,
) -> Option<NodeRef> {
    let reach = Vec3::new(0.0, 0.0, max_vertical_distance);
    let query_box = BoundingBox::new_box(point - reach, point + reach);
    let mut best_point: Option<(f32, NodeRef)> = None;
    for &island_id in island_bbh.query_box(query_box) {
        let Some(island) = islands.get(island_id) else {
            continue;
        };
        let relative_point = island.transform.apply_inverse(point);
        let Some((sampled_point, sampled_node)) =
            island.nav_mesh.sample_point(relative_point, &link_sample_distance(max_vertical_distance))
        else {
            continue;
        };
        let distance = relative_point.distance_squared(sampled_point);
        if best_point.is_some_and(|(best, _)| distance >= best) {
            continue;
        }
        best_point = Some((distance, NodeRef { island_id, polygon_index: sampled_node }));
    }
    best_point.map(|(_, node)| node)
}

#[cfg(test)]
#[path = "nav_data_test.rs"]
mod test;
