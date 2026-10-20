//! Read-only queries on an archipelago: sample a point onto the meshes, and find a straight-line
//! path between two sampled points (for probes and decisions, not for moving agents).
//!
//! Ported from landmass 0.9.3 `src/query.rs` (MIT OR Apache-2.0, used under Apache 2.0; crates.io
//! sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed: the query
//! takes a [`NavFilter`] (cost overrides, shut areas and link kinds; NAV-8) in place of a cost
//! `HashMap` and permitted links; the search is capped at the archipelago's `search_nodes` and a
//! capped search returns the path to the nearest reached node with `partial` set (P12); a dirty
//! archipelago refuses instead of asserting; errors implement `Display` by hand.

use core::marker::PhantomData;

use super::archipelago::Archipelago;
use super::coords::{CoordinateSystem, CorePointSampleDistance};
use super::island::IslandId;
use super::link::AnimationLinkId;
use super::nav_data::NodeRef;
use super::path::{PathIndex, StraightPathStep};
use super::pathfinding::{self, SearchRules};
use crate::filter::NavFilter;

/// A point on the navigation meshes, valid while the archipelago is borrowed.
pub struct SampledPoint<'archipelago, CS: CoordinateSystem> {
    point: CS::Coordinate,
    node_ref: NodeRef,
    type_index: usize,
    marker: PhantomData<&'archipelago ()>,
}

impl<CS: CoordinateSystem> Clone for SampledPoint<'_, CS> {
    fn clone(&self) -> Self {
        Self { point: self.point.clone(), node_ref: self.node_ref, type_index: self.type_index, marker: self.marker }
    }
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for SampledPoint<'_, CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SampledPoint").field("point", &self.point).field("node_ref", &self.node_ref).field("type_index", &self.type_index).finish()
    }
}

impl<CS: CoordinateSystem> SampledPoint<'_, CS> {
    /// The point on the meshes.
    pub fn point(&self) -> CS::Coordinate {
        self.point.clone()
    }

    /// The island it is on.
    pub fn island(&self) -> IslandId {
        self.node_ref.island_id
    }

    /// The node it is on.
    pub fn node(&self) -> NodeRef {
        self.node_ref
    }

    /// The type index (area) under it.
    pub fn type_index(&self) -> usize {
        self.type_index
    }
}

/// Why a point could not be sampled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SamplePointError {
    /// Too far from every island.
    OutOfRange,
    /// The navigation data changed since the last update.
    NavDataDirty,
}

impl core::fmt::Display for SamplePointError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::OutOfRange => f.write_str("the sample point is too far from any island"),
            Self::NavDataDirty => f.write_str("the navigation data changed since the last update"),
        }
    }
}

impl core::error::Error for SamplePointError {}

/// Why a path query failed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FindPathError {
    /// A filter cost was not above zero (type index, cost).
    NonPositiveTypeIndexCost(usize, f32),
    /// No path joins the points.
    NoPathFound,
}

impl core::fmt::Display for FindPathError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NonPositiveTypeIndexCost(type_index, cost) => write!(f, "type index {type_index} had a cost of {cost}, which is not above zero"),
            Self::NoPathFound => f.write_str("no path joins the start and end points"),
        }
    }
}

impl core::error::Error for FindPathError {}

/// One step of a path.
pub enum PathStep<CS: CoordinateSystem> {
    /// A point to walk straight to.
    Waypoint(CS::Coordinate),
    /// An animation link: walk to `start_point`, take the link, arrive near `end_point`.
    AnimationLink {
        /// Where the link starts.
        start_point: CS::Coordinate,
        /// Where taking the link should lead.
        end_point: CS::Coordinate,
        /// The link.
        link_id: AnimationLinkId,
    },
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for PathStep<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Waypoint(point) => f.debug_tuple("Waypoint").field(point).finish(),
            Self::AnimationLink { start_point, end_point, link_id } => f
                .debug_struct("AnimationLink")
                .field("start_point", start_point)
                .field("end_point", end_point)
                .field("link_id", link_id)
                .finish(),
        }
    }
}

impl<CS: CoordinateSystem> Clone for PathStep<CS> {
    fn clone(&self) -> Self {
        match self {
            Self::Waypoint(point) => Self::Waypoint(point.clone()),
            Self::AnimationLink { start_point, end_point, link_id } => {
                Self::AnimationLink { start_point: start_point.clone(), end_point: end_point.clone(), link_id: *link_id }
            }
        }
    }
}

impl<CS: CoordinateSystem<Coordinate: PartialEq>> PartialEq for PathStep<CS> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Waypoint(left), Self::Waypoint(right)) => left == right,
            (
                Self::AnimationLink { start_point: left_start, end_point: left_end, link_id: left_link },
                Self::AnimationLink { start_point: right_start, end_point: right_end, link_id: right_link },
            ) => left_start == right_start && left_end == right_end && left_link == right_link,
            _ => false,
        }
    }
}

/// A found path: its steps (the start first), and whether the search stopped at its node cap
/// short of the end.
pub struct FoundPath<CS: CoordinateSystem> {
    /// The steps, starting with the start point.
    pub steps: Vec<PathStep<CS>>,
    /// Whether the path ends at the reached node nearest the end instead of the end.
    pub partial: bool,
}

impl<CS: CoordinateSystem> Archipelago<CS> {
    /// The nearest point on the meshes to `point`, within `point_sample_distance`.
    ///
    /// # Errors
    ///
    /// [`SamplePointError::NavDataDirty`] before the update that follows a change;
    /// [`SamplePointError::OutOfRange`] when no island is near enough.
    pub fn sample_point(&self, point: CS::Coordinate, point_sample_distance: &CS::SampleDistance) -> Result<SampledPoint<'_, CS>, SamplePointError> {
        self.sample_point_core(point, &CorePointSampleDistance::new(point_sample_distance))
    }

    /// [`Self::sample_point`] with an evaluated sample distance.
    pub(crate) fn sample_point_core(
        &self,
        point: CS::Coordinate,
        distance: &CorePointSampleDistance,
    ) -> Result<SampledPoint<'_, CS>, SamplePointError> {
        if self.nav_data.dirty {
            return Err(SamplePointError::NavDataDirty);
        }
        let Some((point, node_ref)) = self.nav_data.sample_point(CS::to_landmass(&point), distance) else {
            return Err(SamplePointError::OutOfRange);
        };
        let island = self.nav_data.get_island(node_ref.island_id).ok_or(SamplePointError::OutOfRange)?;
        let type_index = island.nav_mesh.polygons[node_ref.polygon_index].type_index;
        Ok(SampledPoint { point: CS::from_landmass(&point), node_ref, type_index, marker: PhantomData })
    }

    /// A straight-line path from `start_point` to `end_point` (both sampled from this
    /// archipelago) under `filter` and the archipelago's gates, capped at the budget's
    /// `search_nodes`.
    ///
    /// # Errors
    ///
    /// [`FindPathError::NonPositiveTypeIndexCost`] for a filter cost not above zero;
    /// [`FindPathError::NoPathFound`] when nothing joins them within the cap.
    pub fn find_path(
        &self,
        start_point: &SampledPoint<'_, CS>,
        end_point: &SampledPoint<'_, CS>,
        filter: &NavFilter,
    ) -> Result<FoundPath<CS>, FindPathError> {
        if let Some((type_index, cost)) = filter.invalid_cost() {
            return Err(FindPathError::NonPositiveTypeIndexCost(type_index, cost));
        }
        let gates = filter.gates_with(self.gates());
        let rules = SearchRules {
            override_type_index_to_cost: filter.costs(),
            permitted_animation_links: filter.links(),
            gates: &gates,
            max_explored: self.archipelago_options.budget.search_nodes,
        };
        let start = CS::to_landmass(&start_point.point);
        let end = CS::to_landmass(&end_point.point);
        let result = pathfinding::find_path(&self.nav_data, start_point.node_ref, start, end_point.node_ref, end, rules);
        let Some(path) = result.path else {
            return Err(FindPathError::NoPathFound);
        };
        let last_point = if result.partial { path.end_point } else { end };
        let last_index = path.last_index();
        let mut current_index = PathIndex::from_corridor_index(0, 0);
        let mut current_point = start;
        let mut steps = vec![PathStep::Waypoint(start_point.point())];
        if current_index == last_index {
            steps.push(PathStep::Waypoint(CS::from_landmass(&last_point)));
            return Ok(FoundPath { steps, partial: result.partial });
        }
        // Until the last index; once more when the last step was a link, to reach the end point.
        while current_index != last_index || matches!(steps.last(), Some(PathStep::AnimationLink { .. })) {
            let next_step;
            (current_index, next_step) = path.find_next_point_in_straight_path(&self.nav_data, current_index, current_point, last_index, last_point);
            let step;
            (current_point, step) = match next_step {
                StraightPathStep::Waypoint(point) => (point, PathStep::Waypoint(CS::from_landmass(&point))),
                // Taking the link leads to its end point.
                StraightPathStep::AnimationLink { start_point, end_point, link_id, .. } => {
                    let step = PathStep::AnimationLink { start_point: CS::from_landmass(&start_point), end_point: CS::from_landmass(&end_point), link_id };
                    (end_point, step)
                }
            };
            steps.push(step);
        }
        Ok(FoundPath { steps, partial: result.partial })
    }
}

#[cfg(test)]
#[path = "query_test.rs"]
mod test;
