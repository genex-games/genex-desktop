//! Agents: what the archipelago steers. Each has a position, a target, a path and a desired
//! velocity the game applies.
//!
//! Ported from landmass 0.9.3 `src/agent.rs` (MIT OR Apache-2.0, used under Apache 2.0; crates.io
//! sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed (NAV-7):
//! - the id is a [`crate::arena`] key; the cost overrides a `Map` (P1);
//! - `PermittedAnimationLinks` lives in [`super::link`] (a `Set` of kinds, P13);
//! - [`AgentState::Waiting`]: the agent needs a new path but the tick's search budget is spent
//!   (P12); it keeps following a still-valid old corridor meanwhile;
//! - the thiserror errors implement `Display` by hand (no dependency added).

use genex_core::map::{Map, Set};
use glam::Vec3;

use super::coords::CoordinateSystem;
use super::island::IslandId;
use super::link::{AnimationLinkId, PermittedAnimationLinks};
use super::nav_data::{NavigationData, NodeRef, OffMeshLinkId};
use super::path::{Path, PathIndex, StraightPathStep};

crate::arena_key! {
    /// The id of an [`Agent`].
    pub struct AgentId;
}

/// What an agent is doing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentState {
    /// No target. The agent still steps aside for others.
    Idle,
    /// At the target; it moves again if the target moves.
    ReachedTarget,
    /// At an animation link on its path ([`Agent::reached_animation_link`]).
    ReachedAnimationLink,
    /// Taking an animation link.
    UsingAnimationLink,
    /// Following a path to the target.
    Moving,
    /// Needs a new path; the tick's search budget is spent, so it waits its turn (FIFO).
    Waiting,
    /// Not on any navigation mesh.
    AgentNotOnNavMesh,
    /// The target is not on any navigation mesh.
    TargetNotOnNavMesh,
    /// No path reaches the target (or the search hit its node cap).
    NoPath,
    /// Paused by the game.
    Paused,
}

/// An agent in an archipelago.
pub struct Agent<CS: CoordinateSystem> {
    /// Where it stands.
    pub position: CS::Coordinate,
    /// How it moves.
    pub velocity: CS::Coordinate,
    /// Its radius.
    pub radius: f32,
    /// The speed it prefers, below [`Self::max_speed`] so it can speed up to give way.
    pub desired_speed: f32,
    /// Its top speed.
    pub max_speed: f32,
    /// Where it is going. Changing it every tick is fine: a path is reused while the target
    /// stays in its corridor.
    pub current_target: Option<CS::Coordinate>,
    /// When the target counts as reached.
    pub target_reached_condition: TargetReachedCondition,
    /// How close counts as at an animation link (default: the target-reached distance).
    pub animation_link_reached_distance: Option<f32>,
    /// The animation-link kinds it may take. A change applies to the next path.
    pub permitted_animation_links: PermittedAnimationLinks,
    /// Paused agents neither avoid nor repath; their path is kept consistent for later.
    pub paused: bool,
    pub(crate) override_type_index_to_cost: Map<usize, f32>,
    pub(crate) current_path: Option<Path>,
    pub(crate) current_desired_move: CS::Coordinate,
    pub(crate) state: AgentState,
    pub(crate) current_animation_link: Option<ReachedAnimationLink<CS>>,
    pub(crate) using_animation_link: bool,
}

/// An animation link an agent reached.
pub struct ReachedAnimationLink<CS: CoordinateSystem> {
    /// The link.
    pub link_id: AnimationLinkId,
    /// Where the link starts.
    pub start_point: CS::Coordinate,
    /// Where taking the link should lead.
    pub end_point: CS::Coordinate,
}

impl<CS: CoordinateSystem> Clone for ReachedAnimationLink<CS> {
    fn clone(&self) -> Self {
        Self { link_id: self.link_id, start_point: self.start_point.clone(), end_point: self.end_point.clone() }
    }
}

impl<CS: CoordinateSystem<Coordinate: core::fmt::Debug>> core::fmt::Debug for ReachedAnimationLink<CS> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ReachedAnimationLink")
            .field("link_id", &self.link_id)
            .field("start_point", &self.start_point)
            .field("end_point", &self.end_point)
            .finish()
    }
}

/// When an agent counts as at its target (and stops).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TargetReachedCondition {
    /// Within this straight-line distance (default: the radius).
    Distance(Option<f32>),
    /// Within this distance and in straight sight along the mesh (default: the radius).
    VisibleAtDistance(Option<f32>),
    /// Within this distance along the straight path, around corners (default: the radius).
    StraightPathDistance(Option<f32>),
}

impl Default for TargetReachedCondition {
    fn default() -> Self {
        Self::Distance(None)
    }
}

/// `start_animation_link` without a reached link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotReachedAnimationLinkError;

impl core::fmt::Display for NotReachedAnimationLinkError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("the agent has not reached an animation link, so it cannot start one")
    }
}

impl core::error::Error for NotReachedAnimationLinkError {}

/// `end_animation_link` while not taking one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotUsingAnimationLinkError;

impl core::fmt::Display for NotUsingAnimationLinkError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("the agent is not using an animation link, so it cannot end one")
    }
}

impl core::error::Error for NotUsingAnimationLinkError {}

impl<CS: CoordinateSystem> Agent<CS> {
    /// A new agent.
    pub fn create(position: CS::Coordinate, velocity: CS::Coordinate, radius: f32, desired_speed: f32, max_speed: f32) -> Self {
        Self {
            position,
            velocity,
            radius,
            desired_speed,
            max_speed,
            current_target: None,
            target_reached_condition: TargetReachedCondition::Distance(None),
            animation_link_reached_distance: None,
            permitted_animation_links: PermittedAnimationLinks::All,
            paused: false,
            override_type_index_to_cost: Map::default(),
            current_path: None,
            current_desired_move: CS::from_landmass(&Vec3::ZERO),
            state: AgentState::Idle,
            current_animation_link: None,
            using_animation_link: false,
        }
    }

    /// This agent's own cost for `type_index`. Returns false (and changes nothing) for a cost
    /// that is not above zero.
    pub fn override_type_index_cost(&mut self, type_index: usize, cost: f32) -> bool {
        if cost.is_nan() || cost <= 0.0 {
            return false;
        }
        self.override_type_index_to_cost.insert(type_index, cost);
        true
    }

    /// Drops this agent's cost for `type_index`. Returns whether there was one.
    pub fn remove_overridden_type_index_cost(&mut self, type_index: usize) -> bool {
        self.override_type_index_to_cost.shift_remove(&type_index).is_some()
    }

    /// This agent's cost overrides, in the order they were set.
    pub fn get_type_index_cost_overrides(&self) -> impl Iterator<Item = (usize, f32)> + '_ {
        self.override_type_index_to_cost.iter().map(|(&type_index, &cost)| (type_index, cost))
    }

    /// The velocity the agent wants this tick (set by `Archipelago::update`).
    pub fn get_desired_velocity(&self) -> &CS::Coordinate {
        &self.current_desired_move
    }

    /// What the agent is doing (set by `Archipelago::update`).
    pub fn state(&self) -> AgentState {
        self.state
    }

    /// The animation link reached at the last update, if any (none while paused or taking one).
    pub fn reached_animation_link(&self) -> Option<&ReachedAnimationLink<CS>> {
        self.current_animation_link.as_ref()
    }

    /// Starts taking the reached animation link; the agent pauses until
    /// [`Self::end_animation_link`].
    ///
    /// # Errors
    ///
    /// [`NotReachedAnimationLinkError`] when no link was reached.
    pub fn start_animation_link(&mut self) -> Result<(), NotReachedAnimationLinkError> {
        if self.current_animation_link.is_none() {
            return Err(NotReachedAnimationLinkError);
        }
        self.using_animation_link = true;
        Ok(())
    }

    /// Finishes taking an animation link.
    ///
    /// # Errors
    ///
    /// [`NotUsingAnimationLinkError`] when the agent was not taking one.
    pub fn end_animation_link(&mut self) -> Result<(), NotUsingAnimationLinkError> {
        if !self.using_animation_link {
            return Err(NotUsingAnimationLinkError);
        }
        self.using_animation_link = false;
        Ok(())
    }

    /// Whether the agent is taking an animation link.
    pub fn is_using_animation_link(&self) -> bool {
        self.using_animation_link
    }

    /// Whether the agent holds a path (for probes and tests).
    pub fn has_path(&self) -> bool {
        self.current_path.is_some()
    }

    /// The agent's path, if any (for debug draws).
    pub fn path(&self) -> Option<&Path> {
        self.current_path.as_ref()
    }

    /// The distance at which an animation link counts as reached.
    pub(crate) fn animation_link_reached_distance(&self) -> f32 {
        if let Some(distance) = self.animation_link_reached_distance {
            return distance;
        }
        match self.target_reached_condition {
            TargetReachedCondition::Distance(distance)
            | TargetReachedCondition::VisibleAtDistance(distance)
            | TargetReachedCondition::StraightPathDistance(distance) => distance.unwrap_or(self.radius),
        }
    }

    /// Whether the agent at `sampled_point` has reached its target, given the next waypoint and
    /// the target waypoint (each a path index and point).
    pub(crate) fn has_reached_target(
        &self,
        path: &Path,
        nav_data: &NavigationData<CS>,
        sampled_point: Vec3,
        next_waypoint: (PathIndex, StraightPathStep),
        target_waypoint: (PathIndex, Vec3),
    ) -> bool {
        match self.target_reached_condition {
            TargetReachedCondition::Distance(distance) => {
                let distance = distance.unwrap_or(self.radius);
                sampled_point.distance_squared(target_waypoint.1) < distance * distance
            }
            TargetReachedCondition::VisibleAtDistance(distance) => {
                let distance = distance.unwrap_or(self.radius);
                // Past a link there is no straight walkable line, so the target is not in sight.
                let StraightPathStep::Waypoint(next_point) = next_waypoint.1 else {
                    return false;
                };
                next_waypoint.0 == target_waypoint.0 && sampled_point.distance_squared(next_point) < distance * distance
            }
            TargetReachedCondition::StraightPathDistance(distance) => {
                straight_path_within(path, nav_data, sampled_point, next_waypoint, target_waypoint, distance.unwrap_or(self.radius))
            }
        }
    }
}

/// Whether the straight path from `sampled_point` to the target is shorter than `distance`.
fn straight_path_within<CS: CoordinateSystem>(
    path: &Path,
    nav_data: &NavigationData<CS>,
    sampled_point: Vec3,
    next_waypoint: (PathIndex, StraightPathStep),
    target_waypoint: (PathIndex, Vec3),
    distance: f32,
) -> bool {
    // The straight-line distance first: no path walking when the agent is not even close.
    if sampled_point.distance_squared(target_waypoint.1) > distance * distance {
        return false;
    }
    // The next waypoint is the target: its distance is already the straight-line one.
    if next_waypoint.0 == target_waypoint.0 {
        return true;
    }
    // An animation link is not a straight path.
    let StraightPathStep::Waypoint(next_point) = next_waypoint.1 else {
        return false;
    };
    let mut straight_line_distance = sampled_point.distance(next_point);
    let mut current_waypoint = (next_waypoint.0, next_point);
    while current_waypoint.0 != target_waypoint.0 && straight_line_distance < distance {
        let next = path.find_next_point_in_straight_path(nav_data, current_waypoint.0, current_waypoint.1, target_waypoint.0, target_waypoint.1);
        let StraightPathStep::Waypoint(next_point) = next.1 else {
            return false;
        };
        straight_line_distance += current_waypoint.1.distance(next_point);
        current_waypoint = (next.0, next_point);
    }
    straight_line_distance < distance
}

/// What to do about an agent's path this tick.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum RepathResult {
    /// Nothing.
    DoNothing,
    /// Follow the current path: the agent's node index and the target's.
    FollowPath(PathIndex, PathIndex),
    /// Drop the path: there is no target.
    ClearPathNoTarget,
    /// Drop the path: the agent is off the mesh.
    ClearPathBadAgent,
    /// Drop the path: the target is off the mesh.
    ClearPathBadTarget,
    /// Search for a new path.
    NeedsRepath,
}

/// Decides [`RepathResult`] for `agent` standing on `agent_node` aiming at `target_node`.
pub(crate) fn does_agent_need_repath<CS: CoordinateSystem>(
    agent: &Agent<CS>,
    agent_node: Option<NodeRef>,
    target_node: Option<NodeRef>,
    invalidated_off_mesh_links: &Set<OffMeshLinkId>,
    invalidated_islands: &Set<IslandId>,
) -> RepathResult {
    if agent.current_target.is_none() {
        return if agent.current_path.is_some() { RepathResult::ClearPathNoTarget } else { RepathResult::DoNothing };
    }
    let Some(agent_node) = agent_node else {
        return RepathResult::ClearPathBadAgent;
    };
    let Some(target_node) = target_node else {
        return RepathResult::ClearPathBadTarget;
    };
    let Some(current_path) = &agent.current_path else {
        return RepathResult::NeedsRepath;
    };
    if !current_path.is_valid(invalidated_off_mesh_links, invalidated_islands) {
        return RepathResult::NeedsRepath;
    }
    let Some(agent_index) = current_path.find_index_of_node(agent_node) else {
        return RepathResult::NeedsRepath;
    };
    let Some(target_index) = current_path.find_index_of_node_rev(target_node) else {
        return RepathResult::NeedsRepath;
    };
    if agent_index > target_index {
        return RepathResult::NeedsRepath;
    }
    RepathResult::FollowPath(agent_index, target_index)
}

#[cfg(test)]
#[path = "agent_test.rs"]
mod test;
