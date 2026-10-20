//! Agents, links, bodies and queries on [`Nav`], stepped by [`Nav::update`] (NAV-12), and the
//! nav's probe and save.
//!
//! The game moves its agents: after `nav.update(dt)` it reads [`Nav::desired_velocity`], moves the
//! body (by hand, a character controller or root motion) and tells the nav where it went with
//! [`Nav::set_position`]. Every call that names an agent, link or body answers `false` or `None`
//! for an id that was never handed out or was removed, and changes nothing; ids are generational,
//! so a removed id stays dead.
//!
//! Queries read the mesh as of the last update (a mesh changed since answers `None` until the next
//! one). [`Nav::random_point`] draws from any [`GameRng`]: a reset's `Pcg32` or a tick's
//! `ctx.rng`; it draws one `unit()` per polygon its search visits, then two for the point.
//!
//! [`Nav::snapshot`] and [`Nav::restore`] cover the agents (targets, paths, status, the search
//! queue), the bodies, the obstacles, the link and area state, and the id counters, every float as
//! its bits. Meshes and links are inputs: a game re-adds them (as at reset) before it restores, and
//! the restore refuses a nav whose resident tiles or links differ. A carving rebuild still queued
//! when the snapshot was taken finishes at once on restore.
//!
//! Ideas from Godot's `NavigationAgent3D` vocabulary (MIT, no code): the target reached, the next
//! corner, a desired velocity the game applies.

use genex_core::cell::CellId;
use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from, hex64};
use genex_core::json::Value;
use genex_core::map::Map;
use genex_core::rng::GameRng;
use glam::{Mat4, Vec3};

use crate::arena::{Arena, ArenaKey};
use crate::carve::NavObstacle;
use crate::error::NavError;
use crate::filter::NavFilter;
use crate::ids::{AgentId, NavBodyId, NavLinkId, NavObstacleId};
use crate::input::NavArea;
use crate::links::{self, NavLink, NavLinkKind};
use crate::runtime::agent::{Agent, AgentId as RuntimeAgentId, AgentState, ReachedAnimationLink, TargetReachedCondition};
use crate::runtime::character::{Character, CharacterId};
use crate::runtime::coords::{CoordinateSystem, CorePointSampleDistance, GenexCoords, PointSampleDistance};
use crate::runtime::island::IslandId;
use crate::runtime::link::{AnimationLinkId, PermittedAnimationLinks};
use crate::runtime::nav_data::{KindedOffMeshLink, NavigationData, NodeRef};
use crate::runtime::path::{IslandSegment, OffMeshLinkSegment, Path};
use crate::runtime::query::PathStep;
use crate::world::Nav;

/// Agents one nav holds.
pub const NAV_AGENTS_MAX: usize = 1024;
/// Bodies one nav holds.
pub const NAV_BODIES_MAX: usize = 1024;
/// The speed a new agent prefers, in metres per second.
pub const NAV_SPEED_DEFAULT: f32 = 1.4;
/// A new agent's top speed, in metres per second (it speeds up to give way).
pub const NAV_SPEED_MAX_DEFAULT: f32 = 2.0;
/// Snapshot format version [`Nav::snapshot`] writes and [`Nav::restore`] reads.
pub const NAV_SNAPSHOT_VERSION: u32 = 1;
/// How far (in walker heights) a query point may be from the mesh and still start on it.
const QUERY_REACH_HEIGHTS: f32 = 1.0;

/// An agent to add: where it stands and how it walks.
#[derive(Clone, Debug, PartialEq)]
pub struct NavAgent {
    position: Vec3,
    radius: Option<f32>,
    desired_speed: f32,
    max_speed: f32,
    reach: Option<f32>,
    links: Option<Vec<NavLinkKind>>,
    area_costs: Vec<(NavArea, f32)>,
}

impl NavAgent {
    /// An agent at `position` with the nav's walker radius, walking [`NAV_SPEED_DEFAULT`] (top
    /// speed [`NAV_SPEED_MAX_DEFAULT`]).
    pub fn new(position: Vec3) -> NavAgent {
        NavAgent { position, radius: None, desired_speed: NAV_SPEED_DEFAULT, max_speed: NAV_SPEED_MAX_DEFAULT, reach: None, links: None, area_costs: Vec::new() }
    }

    /// The speed it prefers and its top speed, in metres per second.
    pub fn with_speed(mut self, desired: f32, max: f32) -> NavAgent {
        self.desired_speed = desired;
        self.max_speed = max;
        self
    }

    /// Its radius, in metres (default: the nav's walker radius).
    pub fn with_radius(mut self, radius: f32) -> NavAgent {
        self.radius = Some(radius);
        self
    }

    /// The target counts as reached within `metres` (default: the radius).
    pub fn with_reach(mut self, metres: f32) -> NavAgent {
        self.reach = Some(metres);
        self
    }

    /// Only links of these kinds (default: every kind).
    pub fn with_links(mut self, kinds: &[NavLinkKind]) -> NavAgent {
        self.links = Some(kinds.to_vec());
        self
    }

    /// This agent's own cost per metre for an area (a soldier who avoids WATER).
    pub fn with_area_cost(mut self, area: NavArea, cost: f32) -> NavAgent {
        self.area_costs.push((area, cost));
        self
    }

    /// What is wrong with the agent's numbers, as a refusal.
    fn refusal(&self) -> Option<NavError> {
        let speeds = self.desired_speed.is_finite() && self.max_speed.is_finite() && self.desired_speed >= 0.0 && self.max_speed >= self.desired_speed;
        let radius = self.radius.is_none_or(positive);
        let reach = self.reach.is_none_or(positive);
        if !(self.position.is_finite() && speeds && radius && reach) {
            return Some(NavError::input_invalid("an agent needs a finite position, 0 <= desired speed <= max speed, and a radius and reach above zero"));
        }
        let bad_cost = self.area_costs.iter().find(|(area, cost)| *area == NavArea::NONE || !positive(*cost));
        bad_cost.map(|(area, cost)| NavError::cost_invalid(format!("an agent cost of {cost} for area {}", area.raw())))
    }
}

/// What an agent is doing after the last update (wire spellings for probes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NavStatus {
    /// No target.
    Idle,
    /// Following its path.
    Moving,
    /// Needs a new path; the tick's search budget is spent, so it waits its turn.
    Waiting,
    /// At its target.
    Arrived,
    /// At a link on its path: [`Nav::take_link`] starts the crossing.
    AtLink,
    /// Crossing a link, until [`Nav::finish_link`].
    OnLink,
    /// Nothing joins it to its target.
    NoPath,
    /// Not on any resident tile (streamed out, or off the mesh): it stands still.
    OffMesh,
    /// Its target is not on any resident tile.
    TargetOffMesh,
}

impl NavStatus {
    /// Every status, in declaration order.
    pub const ALL: [NavStatus; 9] = [
        NavStatus::Idle,
        NavStatus::Moving,
        NavStatus::Waiting,
        NavStatus::Arrived,
        NavStatus::AtLink,
        NavStatus::OnLink,
        NavStatus::NoPath,
        NavStatus::OffMesh,
        NavStatus::TargetOffMesh,
    ];

    /// The status's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            NavStatus::Idle => "idle",
            NavStatus::Moving => "moving",
            NavStatus::Waiting => "waiting",
            NavStatus::Arrived => "arrived",
            NavStatus::AtLink => "at-link",
            NavStatus::OnLink => "on-link",
            NavStatus::NoPath => "no-path",
            NavStatus::OffMesh => "off-mesh",
            NavStatus::TargetOffMesh => "target-off-mesh",
        }
    }

    fn of(state: AgentState) -> NavStatus {
        match state {
            AgentState::Idle | AgentState::Paused => NavStatus::Idle,
            AgentState::ReachedTarget => NavStatus::Arrived,
            AgentState::ReachedAnimationLink => NavStatus::AtLink,
            AgentState::UsingAnimationLink => NavStatus::OnLink,
            AgentState::Moving => NavStatus::Moving,
            AgentState::Waiting => NavStatus::Waiting,
            AgentState::AgentNotOnNavMesh => NavStatus::OffMesh,
            AgentState::TargetNotOnNavMesh => NavStatus::TargetOffMesh,
            AgentState::NoPath => NavStatus::NoPath,
        }
    }
}

/// A link an agent reached: where the crossing starts and ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavLinkReached {
    /// The link.
    pub link: NavLinkId,
    /// How it is crossed.
    pub kind: NavLinkKind,
    /// Where the crossing starts.
    pub start: Vec3,
    /// Where it lands.
    pub end: Vec3,
}

/// A body agents steer around that the nav does not move (the player, a vehicle).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavBody {
    /// Where it stands.
    pub position: Vec3,
    /// How it moves, in metres per second.
    pub velocity: Vec3,
    /// Its radius, in metres.
    pub radius: f32,
}

/// A point on the mesh.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavPoint {
    /// Where it is.
    pub position: Vec3,
    /// The area of the polygon under it.
    pub area: NavArea,
}

/// One step along a path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NavStep {
    /// Walk straight to this corner.
    Corner(Vec3),
    /// Walk to the link's start, cross it, land at its end.
    Link(NavLinkReached),
}

/// A path from [`Nav::path`].
#[derive(Clone, Debug, PartialEq)]
pub struct NavPath {
    /// The steps after the start, the last one at the end.
    pub steps: Vec<NavStep>,
    /// Metres along the steps (a link counts its straight span).
    pub length: f32,
    /// Whether it ends at the reachable point nearest the end instead of the end.
    pub partial: bool,
}

/// Where a [`Nav::raycast`] stopped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavHit {
    /// Where the ray stopped (the end when nothing was in the way).
    pub position: Vec3,
    /// The wall's normal, pointing back at the ray (zero when nothing was in the way).
    pub normal: Vec3,
    /// How far along `from`..`to` it stopped, 0 to 1.
    pub fraction: f32,
    /// Whether a wall stopped it.
    pub blocked: bool,
}

fn positive(value: f32) -> bool {
    value.is_finite() && value > 0.0
}

fn runtime_agent(id: AgentId) -> RuntimeAgentId {
    key_of(id.0)
}

fn runtime_body(id: NavBodyId) -> CharacterId {
    key_of(id.0)
}

fn runtime_link(id: NavLinkId) -> AnimationLinkId {
    key_of(id.0)
}

/// The arena key a raw id names: index low, generation high.
fn key_of<K: ArenaKey>(raw: u64) -> K {
    K::from_parts(raw as u32, (raw >> 32) as u32)
}

/// The avoid obstacles as discs (centre, radius) for the next update's avoidance.
pub(crate) fn avoid_discs(nav: &Nav) -> Vec<(Vec3, f32)> {
    nav.obstacles()
        .filter_map(|(_, obstacle)| match *obstacle {
            NavObstacle::Avoid { position, radius } => Some((position, radius)),
            NavObstacle::CarveCylinder { .. } | NavObstacle::CarveBox { .. } => None,
        })
        .collect()
}

// Agents.
impl Nav {
    /// Add an agent. Refused, with nothing changed: `nav-input-invalid` for a position that is
    /// not finite, speeds outside 0 <= desired <= max, or a radius or reach not above zero;
    /// `nav-cost-invalid` for an area cost not finite and above zero, or for the null area;
    /// `nav-too-large` past [`NAV_AGENTS_MAX`].
    pub fn add_agent(&mut self, agent: NavAgent) -> Result<AgentId, NavError> {
        if let Some(refusal) = agent.refusal() {
            return Err(refusal);
        }
        if self.archipelago.agents.len() >= NAV_AGENTS_MAX {
            return Err(NavError::too_large(format!("a nav holds at most {NAV_AGENTS_MAX} agents")));
        }
        let radius = agent.radius.unwrap_or(self.config.radius());
        let mut runtime = Agent::<GenexCoords>::create(agent.position, Vec3::ZERO, radius, agent.desired_speed, agent.max_speed);
        runtime.target_reached_condition = TargetReachedCondition::Distance(agent.reach);
        if let Some(kinds) = &agent.links {
            runtime.permitted_animation_links = PermittedAnimationLinks::kinds(kinds.iter().map(|kind| kind.code()));
        }
        for (area, cost) in &agent.area_costs {
            runtime.override_type_index_cost(usize::from(area.raw()), *cost);
        }
        Ok(AgentId(self.archipelago.add_agent(runtime).raw()))
    }

    /// Remove an agent; false for an unknown id.
    pub fn remove_agent(&mut self, agent: AgentId) -> bool {
        self.archipelago.remove_agent(runtime_agent(agent))
    }

    /// Send an agent to `target` (it repaths at the next update, or keeps its path while the
    /// target stays in its corridor); false for an unknown id or a target that is not finite.
    pub fn move_to(&mut self, agent: AgentId, target: Vec3) -> bool {
        let Some(runtime) = self.archipelago.get_agent_mut(runtime_agent(agent)).filter(|_| target.is_finite()) else {
            return false;
        };
        runtime.current_target = Some(target);
        true
    }

    /// Drop an agent's target: it goes idle at the next update. False for an unknown id.
    pub fn stop(&mut self, agent: AgentId) -> bool {
        let Some(runtime) = self.archipelago.get_agent_mut(runtime_agent(agent)) else {
            return false;
        };
        runtime.current_target = None;
        true
    }

    /// Where the game put the agent this tick and how it moved; false for an unknown id or a
    /// value that is not finite.
    pub fn set_position(&mut self, agent: AgentId, position: Vec3, velocity: Vec3) -> bool {
        let finite = position.is_finite() && velocity.is_finite();
        let Some(runtime) = self.archipelago.get_agent_mut(runtime_agent(agent)).filter(|_| finite) else {
            return false;
        };
        runtime.position = position;
        runtime.velocity = velocity;
        true
    }

    /// The velocity the agent wants after the last update (zero for an unknown id, or one that
    /// stands still: arrived, waiting with no path, off the mesh, on a link).
    pub fn desired_velocity(&self, agent: AgentId) -> Vec3 {
        self.archipelago.get_agent(runtime_agent(agent)).map_or(Vec3::ZERO, |runtime| *runtime.get_desired_velocity())
    }

    /// Where the agent stands.
    pub fn position(&self, agent: AgentId) -> Option<Vec3> {
        self.archipelago.get_agent(runtime_agent(agent)).map(|runtime| runtime.position)
    }

    /// Where the agent is going.
    pub fn target(&self, agent: AgentId) -> Option<Vec3> {
        self.archipelago.get_agent(runtime_agent(agent)).and_then(|runtime| runtime.current_target)
    }

    /// What the agent is doing after the last update.
    pub fn status(&self, agent: AgentId) -> Option<NavStatus> {
        self.archipelago.get_agent(runtime_agent(agent)).map(|runtime| NavStatus::of(runtime.state()))
    }

    /// The next corner of the agent's path (a link's start when a link is next), from where it
    /// stands. `None` for an unknown id, an agent with no path or off the mesh.
    pub fn next_corner(&self, agent: AgentId) -> Option<Vec3> {
        let runtime = self.archipelago.get_agent(runtime_agent(agent))?;
        let path = runtime.current_path.as_ref()?;
        let nav_data = &self.archipelago.nav_data;
        let (point, node) = nav_data.sample_point(GenexCoords::to_landmass(&runtime.position), &self.agent_reach())?;
        let index = path.find_index_of_node(node)?;
        let (_, step) = path.find_next_point_in_straight_path(nav_data, index, point, path.last_index(), path.end_point);
        let corner = match step {
            crate::runtime::path::StraightPathStep::Waypoint(corner) => corner,
            crate::runtime::path::StraightPathStep::AnimationLink { start_point, .. } => start_point,
        };
        Some(GenexCoords::from_landmass(&corner))
    }

    /// Start crossing the link the agent reached at the last update, and say which; `None`
    /// (nothing changes) for an unknown id or an agent at no link.
    pub fn take_link(&mut self, agent: AgentId) -> Option<NavLinkReached> {
        let reached = links::take_link(&mut self.archipelago, runtime_agent(agent))?;
        Some(self.link_reached(&reached))
    }

    /// End the agent's crossing: it follows its path again from the next update. False for an
    /// unknown id or an agent that was not crossing.
    pub fn finish_link(&mut self, agent: AgentId) -> bool {
        links::finish_link(&mut self.archipelago, runtime_agent(agent))
    }

    /// Every agent, in the order added.
    pub fn agents(&self) -> impl Iterator<Item = AgentId> + '_ {
        self.archipelago.get_agent_ids().map(|id| AgentId(id.raw()))
    }

    /// How many agents the nav holds.
    pub fn agent_count(&self) -> usize {
        self.archipelago.agents.len()
    }

    fn link_reached(&self, reached: &ReachedAnimationLink<GenexCoords>) -> NavLinkReached {
        let kind = self.archipelago.get_animation_link(reached.link_id).and_then(|link| NavLinkKind::from_code(link.kind)).unwrap_or(NavLinkKind::Custom(0));
        NavLinkReached { link: NavLinkId(reached.link_id.raw()), kind, start: reached.start_point, end: reached.end_point }
    }

    /// The reach agents are sampled onto the mesh with.
    fn agent_reach(&self) -> CorePointSampleDistance {
        CorePointSampleDistance::new(&self.archipelago.archipelago_options.point_sample_distance)
    }
}

// Links and bodies.
impl Nav {
    /// Add an off-mesh link. Refused, with nothing changed: `nav-link-invalid` for an end or cost
    /// that is not finite, a negative cost, or an end too far from every resident tile;
    /// `nav-too-large` past [`links::NAV_LINKS_MAX`].
    pub fn add_link(&mut self, link: NavLink) -> Result<NavLinkId, NavError> {
        links::add_link(&mut self.archipelago, &link).map(|id| NavLinkId(id.raw()))
    }

    /// Remove a link; agents whose path takes it repath. False for an unknown id.
    pub fn remove_link(&mut self, link: NavLinkId) -> bool {
        let id = runtime_link(link);
        let removed = self.archipelago.remove_animation_link(id);
        if removed {
            self.archipelago.gates_mut().forget_link(id);
        }
        removed
    }

    /// Open or close a link for every agent and query (a locked door); agents whose path takes a
    /// newly closed link repath at the next update. False for an unknown id.
    pub fn set_link_open(&mut self, link: NavLinkId, open: bool) -> bool {
        let id = runtime_link(link);
        if self.archipelago.get_animation_link(id).is_none() {
            return false;
        }
        self.archipelago.gates_mut().set_link_open(id, open);
        true
    }

    /// Whether a link is open; `None` for an unknown id.
    pub fn link_open(&self, link: NavLinkId) -> Option<bool> {
        let id = runtime_link(link);
        self.archipelago.get_animation_link(id).map(|_| !self.archipelago.gates().is_link_closed(id))
    }

    /// Every link, in the order added.
    pub fn links(&self) -> impl Iterator<Item = NavLinkId> + '_ {
        self.archipelago.get_animation_link_ids().map(|id| NavLinkId(id.raw()))
    }

    /// Add a body agents steer around. Refused `nav-input-invalid` for a value that is not finite
    /// or a radius not above zero, `nav-too-large` past [`NAV_BODIES_MAX`], with nothing changed.
    pub fn add_body(&mut self, body: NavBody) -> Result<NavBodyId, NavError> {
        let usable = body.position.is_finite() && body.velocity.is_finite() && positive(body.radius);
        if !usable {
            return Err(NavError::input_invalid("a body needs a finite position and velocity and a radius above zero"));
        }
        if self.archipelago.characters.len() >= NAV_BODIES_MAX {
            return Err(NavError::too_large(format!("a nav holds at most {NAV_BODIES_MAX} bodies")));
        }
        let character = Character { position: body.position, velocity: body.velocity, radius: body.radius };
        Ok(NavBodyId(self.archipelago.add_character(character).raw()))
    }

    /// Where a body is this tick and how it moves; false for an unknown id or a value that is
    /// not finite.
    pub fn set_body(&mut self, body: NavBodyId, position: Vec3, velocity: Vec3) -> bool {
        let finite = position.is_finite() && velocity.is_finite();
        let Some(character) = self.archipelago.get_character_mut(runtime_body(body)).filter(|_| finite) else {
            return false;
        };
        character.position = position;
        character.velocity = velocity;
        true
    }

    /// Remove a body; false for an unknown id.
    pub fn remove_body(&mut self, body: NavBodyId) -> bool {
        self.archipelago.remove_character(runtime_body(body))
    }

    /// A body.
    pub fn body(&self, body: NavBodyId) -> Option<NavBody> {
        self.archipelago.get_character(runtime_body(body)).map(|c| NavBody { position: c.position, velocity: c.velocity, radius: c.radius })
    }

    /// Every body, in the order added.
    pub fn bodies(&self) -> impl Iterator<Item = NavBodyId> + '_ {
        self.archipelago.get_character_ids().map(|id| NavBodyId(id.raw()))
    }
}

// Queries.
impl Nav {
    fn query_reach(&self) -> f32 {
        self.config.height() * QUERY_REACH_HEIGHTS
    }

    fn area_of(&self, node: NodeRef) -> NavArea {
        let type_index = self.archipelago.nav_data.get_island(node.island_id).map_or(0, |island| island.nav_mesh.polygons[node.polygon_index].type_index);
        NavArea::from_raw(u8::try_from(type_index).unwrap_or(0))
    }

    /// The nearest point on the mesh within `reach` metres of `near`.
    pub fn closest_point(&self, near: Vec3, reach: f32) -> Option<NavPoint> {
        if !(near.is_finite() && positive(reach)) {
            return None;
        }
        let ratio = self.archipelago.archipelago_options.point_sample_distance.vertical_preference_ratio();
        let distance = CorePointSampleDistance { horizontal_distance: reach, distance_above: reach, distance_below: reach, vertical_preference_ratio: ratio };
        let (point, node) = self.archipelago.nav_data.sample_point(GenexCoords::to_landmass(&near), &distance)?;
        Some(NavPoint { position: GenexCoords::from_landmass(&point), area: self.area_of(node) })
    }

    /// A path from `from` to `to` under `filter` and the nav's gates, within the search budget's
    /// node cap: `None` when an end is off the mesh, the filter has a cost not above zero, the
    /// mesh changed since the last update, or nothing joins them.
    pub fn path(&self, from: Vec3, to: Vec3, filter: &NavFilter) -> Option<NavPath> {
        let reach = self.agent_reach();
        let start = self.archipelago.sample_point_core(from, &reach).ok()?;
        let end = self.archipelago.sample_point_core(to, &reach).ok()?;
        let found = self.archipelago.find_path(&start, &end, filter).ok()?;
        let mut steps = Vec::with_capacity(found.steps.len());
        let mut length = 0.0;
        let mut at = start.point();
        for step in found.steps.iter().skip(1) {
            let next = match step {
                PathStep::Waypoint(corner) => {
                    length += at.distance(*corner);
                    at = *corner;
                    NavStep::Corner(*corner)
                }
                PathStep::AnimationLink { start_point, end_point, link_id } => {
                    length += at.distance(*start_point) + start_point.distance(*end_point);
                    at = *end_point;
                    let reached = ReachedAnimationLink { link_id: *link_id, start_point: *start_point, end_point: *end_point };
                    NavStep::Link(self.link_reached(&reached))
                }
            };
            steps.push(next);
        }
        Some(NavPath { steps, length, partial: found.partial })
    }

    /// Walk the mesh surface straight from `from` toward `to`: where a wall stops it, or `to`.
    pub fn raycast(&self, from: Vec3, to: Vec3, filter: &NavFilter) -> Option<NavHit> {
        let ray = self.archipelago.raycast(from, to, self.query_reach(), filter)?;
        Some(NavHit { position: ray.position, normal: ray.normal, fraction: ray.fraction, blocked: ray.blocked })
    }

    /// Slide from `from` toward `to` along the surface (keep a player on the mesh).
    pub fn move_along(&self, from: Vec3, to: Vec3, filter: &NavFilter) -> Option<NavPoint> {
        let moved = self.archipelago.move_along(from, to, self.query_reach(), filter)?;
        Some(NavPoint { position: moved.position, area: self.area_of(moved.node) })
    }

    /// A random point on the mesh reachable from `around` whose polygons come within `radius`,
    /// weighted by area. Draws from `rng` one `unit()` per polygon the search visits, then two
    /// for the point; nothing when `around` is off the mesh.
    pub fn random_point(&self, rng: &mut impl GameRng, around: Vec3, radius: f32, filter: &NavFilter) -> Option<NavPoint> {
        let point = self.archipelago.random_point(rng, around, radius, self.query_reach(), filter)?;
        Some(NavPoint { position: point.position, area: NavArea::from_raw(u8::try_from(point.type_index).unwrap_or(0)) })
    }

    /// The distance from `at` to the nearest wall within `reach` metres (`None` when there is none
    /// that near, or `at` is off the mesh).
    pub fn distance_to_wall(&self, at: Vec3, reach: f32) -> Option<f32> {
        let wall = self.archipelago.distance_to_wall(at, reach, self.query_reach(), &NavFilter::new())?;
        wall.found.then_some(wall.distance)
    }
}

// Probe and digest.
impl Nav {
    /// A small summary for a probe, a few hundred bytes whatever the agent count: agents by status
    /// (only statuses some agent has), tiles, links, bodies, obstacles, pending rebuilds, and the
    /// agents' state digest.
    pub fn probe(&self) -> Value {
        let mut counts = [0u32; NavStatus::ALL.len()];
        for (_, agent) in self.archipelago.agents.iter() {
            let status = NavStatus::of(agent.state());
            counts[NavStatus::ALL.iter().position(|s| *s == status).unwrap_or(0)] += 1;
        }
        let mut status = Value::object();
        for (index, count) in counts.iter().enumerate().filter(|(_, count)| **count > 0) {
            status.set(NavStatus::ALL[index].wire(), Value::from(*count));
        }
        let mut out = Value::object();
        out.set("agents", Value::from(self.archipelago.agents.len() as u64));
        out.set("status", status);
        out.set("tiles", Value::from(self.tile_count() as u64));
        out.set("links", Value::from(self.links().count() as u64));
        out.set("bodies", Value::from(self.archipelago.characters.len() as u64));
        out.set("obstacles", Value::from(self.obstacles().count() as u64));
        out.set("pending", Value::from(self.pending_rebuilds() as u64));
        out.set("digest", Value::from(hex64(self.agents_digest())));
        out
    }

    /// FNV-1a 64 of every agent in order: id, position, velocity, desired move, target, status
    /// and path nodes, floats as bits. Equal digests on two runs mean the agents agree bit for bit.
    pub fn agents_digest(&self) -> u64 {
        let mut hash = FNV_OFFSET_BASIS;
        let mut put = |bytes: &[u8]| hash = fnv1a64_from(bytes, hash);
        for (id, agent) in self.archipelago.agents.iter() {
            put(&id.raw().to_le_bytes());
            for v in [agent.position, agent.velocity, agent.current_desired_move, agent.current_target.unwrap_or(Vec3::NAN)] {
                for x in v.to_array() {
                    put(&x.to_bits().to_le_bytes());
                }
            }
            put(NavStatus::of(agent.state()).wire().as_bytes());
            for node in agent.current_path.iter().flat_map(Path::nodes) {
                put(&node.island_id.raw().to_le_bytes());
                put(&(node.polygon_index as u64).to_le_bytes());
            }
        }
        hash
    }
}

// Save and restore.
impl Nav {
    /// The nav's game state as a value, every float as its bits; see the module docs for what it
    /// covers. [`Nav::restore`] on a nav with the same tiles and links continues exactly here.
    pub fn snapshot(&self) -> Value {
        let islands: Map<IslandId, CellId> = self.tiles.iter().filter_map(|(cell, resident)| resident.island.map(|island| (island, *cell))).collect();
        let mut out = Value::object();
        out.set("version", Value::from(NAV_SNAPSHOT_VERSION));
        out.set("config", Value::from(hex64(self.config.digest())));
        out.set("cells", Value::Array(self.sorted_cells().into_iter().map(cell_value).collect()));
        out.set("links", Value::Array(self.links().map(|id| Value::from(hex64(id.raw()))).collect()));
        out.set("costs", Value::Array(self.archipelago.get_type_index_costs().map(|(index, cost)| pair(index as u64, cost)).collect()));
        let gates = self.archipelago.gates();
        out.set("shut", Value::Array(gates.shut_areas().map(|index| Value::from(index as u64)).collect()));
        out.set("closed", Value::Array(gates.closed_links().map(|id| Value::from(hex64(id.raw()))).collect()));
        let next_obstacle = self.carving.as_ref().map_or(0, crate::carve::Carving::next_id);
        out.set("next_obstacle", Value::from(hex64(next_obstacle)));
        out.set("obstacles", Value::Array(self.obstacles().map(|(id, obstacle)| obstacle_value(id, obstacle)).collect()));
        out.set("bodies", arena_value(&self.archipelago.characters, |c| floats_value(&[c.position.x, c.position.y, c.position.z, c.velocity.x, c.velocity.y, c.velocity.z, c.radius])));
        let context = SaveContext { islands, nav_data: &self.archipelago.nav_data };
        out.set("agents", arena_value(&self.archipelago.agents, |agent| agent_value(agent, &context)));
        out.set("queue", Value::Array(self.archipelago.repath_queue.iter().map(|id| Value::from(hex64(id.raw()))).collect()));
        out
    }

    /// Restore a [`Nav::snapshot`] onto this nav, whose meshes and links the game has re-added as
    /// at reset. Refused `nav-input-invalid`, with the nav unchanged: not a snapshot of this
    /// version or walker config, other resident tiles or links, a field missing or of the wrong
    /// kind, a float that is not finite where one must be, an id layout that does not hold
    /// together, or an obstacle [`Nav::add_obstacle`] refuses.
    pub fn restore(&mut self, snapshot: &Value) -> Result<(), NavError> {
        let parsed = self.parse_snapshot(snapshot).map_err(|problem| NavError::input_invalid(format!("nav snapshot: {problem}")))?;
        if let Some(carving) = self.carving.as_mut() {
            carving.restore(&parsed.obstacles, parsed.next_obstacle)?;
        }
        self.settle_carving();
        let vertical = self.archipelago.archipelago_options.point_sample_distance.animation_link_max_vertical_distance();
        let edge = self.archipelago.archipelago_options.edge_link_distance;
        self.archipelago.nav_data.update(edge, vertical);
        let stale: Vec<usize> = self.archipelago.get_type_index_costs().map(|(index, _)| index).collect();
        for index in stale {
            let _ = self.archipelago.set_type_index_cost(index, 1.0);
        }
        for (index, cost) in &parsed.costs {
            let _ = self.archipelago.set_type_index_cost(*index, *cost);
        }
        self.archipelago.gates_mut().restore(parsed.shut, parsed.closed);
        self.archipelago.characters = parsed.bodies;
        self.restore_agents(parsed.agents, &parsed.queue);
        Ok(())
    }

    /// Finish every queued carving rebuild now.
    fn settle_carving(&mut self) {
        let pending = self.pending_rebuilds();
        for _ in 0..=pending {
            if self.pending_rebuilds() == 0 {
                break;
            }
            let units = u32::try_from(self.pending_rebuilds().saturating_add(1)).unwrap_or(u32::MAX).saturating_mul(crate::carve::NAV_REBUILD_STAGES);
            self.advance_carving(units);
        }
    }

    fn sorted_cells(&self) -> Vec<CellId> {
        let mut cells: Vec<CellId> = self.tiles().collect();
        cells.sort_unstable();
        cells
    }

    fn restore_agents(&mut self, agents: ParsedArena<ParsedAgent>, queue: &[RuntimeAgentId]) {
        let cells: Map<CellId, IslandId> = self.tiles.iter().filter_map(|(cell, resident)| resident.island.map(|island| (*cell, island))).collect();
        let live: Vec<(RuntimeAgentId, Agent<GenexCoords>)> = agents.live.into_iter().map(|(id, parsed)| (id, self.agent_from(parsed, &cells))).collect();
        if let Some(arena) = Arena::from_layout(&agents.generations, &agents.free, live) {
            self.archipelago.agents = arena;
        }
        self.archipelago.repath_queue = queue.iter().copied().collect();
        self.archipelago.queued = queue.iter().copied().collect();
    }

    fn agent_from(&self, parsed: ParsedAgent, cells: &Map<CellId, IslandId>) -> Agent<GenexCoords> {
        let mut agent = parsed.agent;
        agent.current_path = parsed.path.and_then(|path| self.path_from(path, cells));
        agent.current_animation_link = parsed.link.filter(|link| self.archipelago.get_animation_link(link.link_id).is_some());
        agent
    }

    /// A saved path on this nav's islands; `None` (the agent repaths) when a part no longer fits.
    fn path_from(&self, saved: SavedPath, cells: &Map<CellId, IslandId>) -> Option<Path> {
        let nav_data = &self.archipelago.nav_data;
        let mut island_segments = Vec::with_capacity(saved.segments.len());
        for (cell, corridor, portals) in saved.segments {
            let island_id = *cells.get(&cell)?;
            let island = nav_data.get_island(island_id)?;
            let fits = !corridor.is_empty() && portals.len() + 1 == corridor.len();
            let in_mesh = corridor.iter().zip(portals.iter().chain([&0])).all(|(&polygon, &edge)| island.nav_mesh.polygons.get(polygon).is_some_and(|p| edge < p.vertices.len()));
            if !(fits && in_mesh) {
                return None;
            }
            island_segments.push(IslandSegment { island_id, corridor, portal_edge_index: portals });
        }
        let mut off_mesh_link_segments = Vec::with_capacity(saved.links.len());
        for link in saved.links {
            let starting_node = node_on(cells, link.from)?;
            let end_node = node_on(cells, link.to)?;
            let candidates = nav_data.node_to_off_mesh_link_ids.get(&starting_node)?;
            let matches = |id: &&crate::runtime::nav_data::OffMeshLinkId, exact: bool| {
                nav_data.off_mesh_links.get(**id).is_some_and(|found| {
                    let kind = match (&found.kinded, link.animation) {
                        (KindedOffMeshLink::BoundaryLink { .. }, None) => true,
                        (KindedOffMeshLink::AnimationLink { animation_link, .. }, Some(saved)) => *animation_link == saved,
                        _ => false,
                    };
                    let portal = [found.portal.0, found.portal.1].iter().flat_map(|v| v.to_array()).map(f32::to_bits).eq(link.portal.iter().copied());
                    found.destination_node == end_node && kind && (portal || !exact)
                })
            };
            let off_mesh_link = *candidates.iter().find(|id| matches(id, true)).or_else(|| candidates.iter().find(|id| matches(id, false)))?;
            off_mesh_link_segments.push(OffMeshLinkSegment { starting_node, end_node, off_mesh_link });
        }
        if off_mesh_link_segments.len() + 1 != island_segments.len() {
            return None;
        }
        Some(Path { island_segments, off_mesh_link_segments, start_point: saved.start, end_point: saved.end })
    }
}

fn node_on(cells: &Map<CellId, IslandId>, (cell, polygon_index): (CellId, usize)) -> Option<NodeRef> {
    Some(NodeRef { island_id: *cells.get(&cell)?, polygon_index })
}

// Snapshot encoding: floats as their bits, 64-bit ids as hex strings, so a value written as JSON
// text and read back restores exactly.

fn floats_value(numbers: &[f32]) -> Value {
    Value::Array(numbers.iter().map(|number| Value::from(number.to_bits())).collect())
}

fn vec3_value(v: Vec3) -> Value {
    floats_value(&v.to_array())
}

fn pair(index: u64, cost: f32) -> Value {
    Value::Array(vec![Value::from(index), Value::from(cost.to_bits())])
}

fn cell_value(cell: CellId) -> Value {
    Value::Array(vec![Value::from(cell.x), Value::from(cell.z)])
}

fn optional<T>(value: Option<T>, encode: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, encode)
}

fn obstacle_value(id: NavObstacleId, obstacle: &NavObstacle) -> Value {
    let (kind, numbers): (&str, Vec<f32>) = match *obstacle {
        NavObstacle::Avoid { position, radius } => ("avoid", vec![position.x, position.y, position.z, radius]),
        NavObstacle::CarveCylinder { base, radius, height } => ("cylinder", vec![base.x, base.y, base.z, radius, height]),
        NavObstacle::CarveBox { transform } => ("box", transform.to_cols_array().to_vec()),
    };
    let mut out = Value::object();
    out.set("id", Value::from(hex64(id.raw())));
    out.set("kind", Value::from(kind));
    out.set("shape", floats_value(&numbers));
    out
}

fn arena_value<K: ArenaKey, V>(arena: &Arena<K, V>, encode: impl Fn(&V) -> Value) -> Value {
    let (generations, free) = arena.layout();
    let mut out = Value::object();
    out.set("generations", Value::Array(generations.into_iter().map(Value::from).collect()));
    out.set("free", Value::Array(free.into_iter().map(Value::from).collect()));
    let live = arena.iter().map(|(key, value)| Value::Array(vec![Value::from(hex64(key.raw())), encode(value)]));
    out.set("live", Value::Array(live.collect()));
    out
}

const fn state_code(state: AgentState) -> u32 {
    match state {
        AgentState::Idle => 0,
        AgentState::ReachedTarget => 1,
        AgentState::ReachedAnimationLink => 2,
        AgentState::UsingAnimationLink => 3,
        AgentState::Moving => 4,
        AgentState::Waiting => 5,
        AgentState::AgentNotOnNavMesh => 6,
        AgentState::TargetNotOnNavMesh => 7,
        AgentState::NoPath => 8,
        AgentState::Paused => 9,
    }
}

const STATES: [AgentState; 10] = [
    AgentState::Idle,
    AgentState::ReachedTarget,
    AgentState::ReachedAnimationLink,
    AgentState::UsingAnimationLink,
    AgentState::Moving,
    AgentState::Waiting,
    AgentState::AgentNotOnNavMesh,
    AgentState::TargetNotOnNavMesh,
    AgentState::NoPath,
    AgentState::Paused,
];

fn reached_value(condition: TargetReachedCondition) -> Value {
    let (kind, distance) = match condition {
        TargetReachedCondition::Distance(distance) => (0u32, distance),
        TargetReachedCondition::VisibleAtDistance(distance) => (1, distance),
        TargetReachedCondition::StraightPathDistance(distance) => (2, distance),
    };
    Value::Array(vec![Value::from(kind), optional(distance, |d| Value::from(d.to_bits()))])
}

/// What encoding a path needs: the cell of each island, and the links it takes.
struct SaveContext<'a> {
    islands: Map<IslandId, CellId>,
    nav_data: &'a NavigationData<GenexCoords>,
}

fn agent_value(agent: &Agent<GenexCoords>, context: &SaveContext<'_>) -> Value {
    let mut out = Value::object();
    out.set("position", vec3_value(agent.position));
    out.set("velocity", vec3_value(agent.velocity));
    out.set("move", vec3_value(agent.current_desired_move));
    out.set("speeds", floats_value(&[agent.radius, agent.desired_speed, agent.max_speed]));
    out.set("target", optional(agent.current_target, vec3_value));
    out.set("reached", reached_value(agent.target_reached_condition));
    out.set("link_reach", optional(agent.animation_link_reached_distance, |d| Value::from(d.to_bits())));
    let permitted = match &agent.permitted_animation_links {
        PermittedAnimationLinks::All => Value::Null,
        PermittedAnimationLinks::Kinds(kinds) => Value::Array(kinds.iter().map(|kind| Value::from(*kind as u64)).collect()),
    };
    out.set("permitted", permitted);
    out.set("costs", Value::Array(agent.get_type_index_cost_overrides().map(|(index, cost)| pair(index as u64, cost)).collect()));
    out.set("flags", Value::Array(vec![Value::from(agent.paused), Value::from(agent.using_animation_link)]));
    out.set("state", Value::from(state_code(agent.state())));
    let link = agent.current_animation_link.as_ref().map(|link| {
        Value::Array(vec![Value::from(hex64(link.link_id.raw())), vec3_value(link.start_point), vec3_value(link.end_point)])
    });
    out.set("at_link", link.unwrap_or(Value::Null));
    out.set("path", agent.current_path.as_ref().and_then(|path| path_value(path, context)).unwrap_or(Value::Null));
    out
}

fn node_value(node: NodeRef, islands: &Map<IslandId, CellId>) -> Option<Value> {
    let cell = islands.get(&node.island_id)?;
    Some(Value::Array(vec![Value::from(cell.x), Value::from(cell.z), Value::from(node.polygon_index as u64)]))
}

fn path_value(path: &Path, context: &SaveContext<'_>) -> Option<Value> {
    let islands = &context.islands;
    let mut segments = Vec::with_capacity(path.island_segments.len());
    for segment in &path.island_segments {
        let cell = islands.get(&segment.island_id)?;
        let corridor = Value::Array(segment.corridor.iter().map(|&p| Value::from(p as u64)).collect());
        let portals = Value::Array(segment.portal_edge_index.iter().map(|&e| Value::from(e as u64)).collect());
        segments.push(Value::Array(vec![cell_value(*cell), corridor, portals]));
    }
    let mut links = Vec::with_capacity(path.off_mesh_link_segments.len());
    for segment in &path.off_mesh_link_segments {
        let found = path_link_parts(segment, context)?;
        links.push(found);
    }
    let mut out = Value::object();
    out.set("segments", Value::Array(segments));
    out.set("links", Value::Array(links));
    out.set("start", vec3_value(path.start_point));
    out.set("end", vec3_value(path.end_point));
    Some(out)
}

/// An off-mesh link of a path, named by what it joins (its ends, its animation link and its
/// portal): its id is regenerated whenever islands stitch.
fn path_link_parts(segment: &OffMeshLinkSegment, context: &SaveContext<'_>) -> Option<Value> {
    let link = context.nav_data.off_mesh_links.get(segment.off_mesh_link)?;
    let animation = match &link.kinded {
        KindedOffMeshLink::BoundaryLink { .. } => Value::Null,
        KindedOffMeshLink::AnimationLink { animation_link, .. } => Value::from(hex64(animation_link.raw())),
    };
    let portal = floats_value(&[link.portal.0.to_array(), link.portal.1.to_array()].concat());
    Some(Value::Array(vec![node_value(segment.starting_node, &context.islands)?, node_value(segment.end_node, &context.islands)?, animation, portal]))
}

/// What a snapshot holds, checked before anything changes.
struct Parsed {
    costs: Vec<(usize, f32)>,
    shut: Vec<usize>,
    closed: Vec<AnimationLinkId>,
    obstacles: Vec<(NavObstacleId, NavObstacle)>,
    next_obstacle: u64,
    bodies: Arena<CharacterId, Character<GenexCoords>>,
    agents: ParsedArena<ParsedAgent>,
    queue: Vec<RuntimeAgentId>,
}

/// An arena's layout and live values, whose layout has been checked.
struct ParsedArena<V> {
    generations: Vec<u32>,
    free: Vec<u32>,
    live: Vec<(RuntimeAgentId, V)>,
}

/// An agent read back, its path still on cells (islands are mapped at restore).
struct ParsedAgent {
    agent: Agent<GenexCoords>,
    path: Option<SavedPath>,
    link: Option<ReachedAnimationLink<GenexCoords>>,
}

/// A path read back: segments on cells and the links between them.
struct SavedPath {
    segments: Vec<(CellId, Vec<usize>, Vec<usize>)>,
    links: Vec<SavedLink>,
    start: Vec3,
    end: Vec3,
}

/// An off-mesh link of a saved path, named by its ends (and portal, kind).
struct SavedLink {
    from: (CellId, usize),
    to: (CellId, usize),
    animation: Option<AnimationLinkId>,
    portal: [u32; 6],
}

type Problem = String;

/// An arena's generations, free slots and live entries, as a snapshot holds them.
type ArenaParts<K, V> = (Vec<u32>, Vec<u32>, Vec<(K, V)>);

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, Problem> {
    value.get(key).ok_or_else(|| format!("{key} is missing"))
}

fn items<'a>(value: &'a Value, what: &str) -> Result<&'a [Value], Problem> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{what} is not a list")),
    }
}

fn read_u64(value: &Value, what: &str) -> Result<u64, Problem> {
    match value {
        Value::Number(number) if number.fract() == 0.0 && *number >= 0.0 && *number <= 9_007_199_254_740_992.0 => Ok(*number as u64),
        _ => Err(format!("{what} is not a whole number")),
    }
}

fn read_u32(value: &Value, what: &str) -> Result<u32, Problem> {
    u32::try_from(read_u64(value, what)?).map_err(|_| format!("{what} does not fit 32 bits"))
}

fn read_i32(value: &Value, what: &str) -> Result<i32, Problem> {
    match value {
        Value::Number(number) if number.fract() == 0.0 && *number >= f64::from(i32::MIN) && *number <= f64::from(i32::MAX) => Ok(*number as i32),
        _ => Err(format!("{what} is not a 32-bit whole number")),
    }
}

fn read_hex(value: &Value, what: &str) -> Result<u64, Problem> {
    match value {
        Value::String(_) => u64::from_str_radix(value.as_str(), 16).map_err(|_| format!("{what} is not a hex id")),
        _ => Err(format!("{what} is not a hex id")),
    }
}

fn read_bool(value: &Value, what: &str) -> Result<bool, Problem> {
    match value {
        Value::Bool(flag) => Ok(*flag),
        _ => Err(format!("{what} is not true or false")),
    }
}

fn read_f32(value: &Value, what: &str) -> Result<f32, Problem> {
    Ok(f32::from_bits(read_u32(value, what)?))
}

fn read_finite(value: &Value, what: &str) -> Result<f32, Problem> {
    let number = read_f32(value, what)?;
    if number.is_finite() { Ok(number) } else { Err(format!("{what} is not finite")) }
}

fn read_floats(value: &Value, what: &str, count: usize) -> Result<Vec<f32>, Problem> {
    let list = items(value, what)?;
    if list.len() != count {
        return Err(format!("{what} holds {} numbers, not {count}", list.len()));
    }
    list.iter().map(|item| read_finite(item, what)).collect()
}

fn read_vec3(value: &Value, what: &str) -> Result<Vec3, Problem> {
    let numbers = read_floats(value, what, 3)?;
    Ok(Vec3::new(numbers[0], numbers[1], numbers[2]))
}

fn read_cell(value: &Value, what: &str) -> Result<CellId, Problem> {
    let parts = items(value, what)?;
    if parts.len() != 2 {
        return Err(format!("{what} is not a cell"));
    }
    Ok(CellId { x: read_i32(&parts[0], what)?, z: read_i32(&parts[1], what)? })
}

fn read_node(value: &Value, what: &str) -> Result<(CellId, usize), Problem> {
    let parts = items(value, what)?;
    if parts.len() != 3 {
        return Err(format!("{what} is not a node"));
    }
    let cell = CellId { x: read_i32(&parts[0], what)?, z: read_i32(&parts[1], what)? };
    Ok((cell, read_u64(&parts[2], what)? as usize))
}

fn read_optional<T>(value: &Value, read: impl FnOnce(&Value) -> Result<T, Problem>) -> Result<Option<T>, Problem> {
    if value.is_null() { Ok(None) } else { read(value).map(Some) }
}

fn read_pairs(value: &Value, what: &str) -> Result<Vec<(usize, f32)>, Problem> {
    let mut out = Vec::new();
    for item in items(value, what)? {
        let parts = items(item, what)?;
        let cost = parts.get(1).map(|cost| read_f32(cost, what)).transpose()?.filter(|cost| positive(*cost));
        let (Some(index), Some(cost)) = (parts.first(), cost) else {
            return Err(format!("{what} holds a cost that is not an (area, cost above zero) pair"));
        };
        out.push((read_u64(index, what)? as usize, cost));
    }
    Ok(out)
}

fn read_obstacle(value: &Value) -> Result<(NavObstacleId, NavObstacle), Problem> {
    let id = NavObstacleId(read_hex(field(value, "id")?, "obstacle id")?);
    let shape = field(value, "shape")?;
    let obstacle = match field(value, "kind")?.as_str() {
        "avoid" => {
            let n = read_floats(shape, "avoid obstacle", 4)?;
            NavObstacle::Avoid { position: Vec3::new(n[0], n[1], n[2]), radius: n[3] }
        }
        "cylinder" => {
            let n = read_floats(shape, "cylinder obstacle", 5)?;
            NavObstacle::CarveCylinder { base: Vec3::new(n[0], n[1], n[2]), radius: n[3], height: n[4] }
        }
        "box" => {
            let n = read_floats(shape, "box obstacle", 16)?;
            let mut columns = [0.0; 16];
            columns.copy_from_slice(&n);
            NavObstacle::CarveBox { transform: Mat4::from_cols_array(&columns) }
        }
        other => return Err(format!("obstacle kind {other:?}")),
    };
    Ok((id, obstacle))
}

/// An arena's layout and live values from a snapshot, the layout checked with `from_layout`.
fn read_arena<K: ArenaKey, V>(value: &Value, what: &str, read: impl Fn(&Value) -> Result<V, Problem>) -> Result<ArenaParts<K, V>, Problem> {
    let generations = items(field(value, "generations")?, what)?.iter().map(|g| read_u32(g, what)).collect::<Result<Vec<_>, _>>()?;
    let free = items(field(value, "free")?, what)?.iter().map(|f| read_u32(f, what)).collect::<Result<Vec<_>, _>>()?;
    let mut live = Vec::new();
    for item in items(field(value, "live")?, what)? {
        let parts = items(item, what)?;
        if parts.len() != 2 {
            return Err(format!("{what} holds an entry that is not (id, value)"));
        }
        live.push((key_of::<K>(read_hex(&parts[0], what)?), read(&parts[1])?));
    }
    let keys: Vec<(K, ())> = live.iter().map(|(key, _)| (*key, ())).collect();
    if Arena::from_layout(&generations, &free, keys).is_none() {
        return Err(format!("the {what} id layout does not hold together"));
    }
    Ok((generations, free, live))
}

fn read_body(value: &Value) -> Result<Character<GenexCoords>, Problem> {
    let n = read_floats(value, "body", 7)?;
    if !positive(n[6]) {
        return Err("a body radius is not above zero".to_owned());
    }
    Ok(Character { position: Vec3::new(n[0], n[1], n[2]), velocity: Vec3::new(n[3], n[4], n[5]), radius: n[6] })
}

fn read_reached(value: &Value) -> Result<TargetReachedCondition, Problem> {
    let parts = items(value, "reached")?;
    let (Some(kind), Some(distance)) = (parts.first(), parts.get(1)) else {
        return Err("reached is not (kind, distance)".to_owned());
    };
    let distance = read_optional(distance, |d| read_finite(d, "reached distance"))?;
    match read_u32(kind, "reached kind")? {
        0 => Ok(TargetReachedCondition::Distance(distance)),
        1 => Ok(TargetReachedCondition::VisibleAtDistance(distance)),
        2 => Ok(TargetReachedCondition::StraightPathDistance(distance)),
        other => Err(format!("reached kind {other}")),
    }
}

fn read_saved_link(value: &Value) -> Result<ReachedAnimationLink<GenexCoords>, Problem> {
    let parts = items(value, "at_link")?;
    if parts.len() != 3 {
        return Err("at_link is not (link, start, end)".to_owned());
    }
    Ok(ReachedAnimationLink { link_id: key_of(read_hex(&parts[0], "at_link")?), start_point: read_vec3(&parts[1], "at_link")?, end_point: read_vec3(&parts[2], "at_link")? })
}

fn read_path(value: &Value) -> Result<SavedPath, Problem> {
    let mut segments = Vec::new();
    for segment in items(field(value, "segments")?, "path segments")? {
        let parts = items(segment, "path segment")?;
        if parts.len() != 3 {
            return Err("a path segment is not (cell, corridor, portals)".to_owned());
        }
        let numbers = |list: &Value| items(list, "path segment").and_then(|list| list.iter().map(|n| read_u64(n, "path segment").map(|n| n as usize)).collect::<Result<Vec<_>, _>>());
        segments.push((read_cell(&parts[0], "path cell")?, numbers(&parts[1])?, numbers(&parts[2])?));
    }
    let mut links = Vec::new();
    for link in items(field(value, "links")?, "path links")? {
        let parts = items(link, "path link")?;
        if parts.len() != 4 {
            return Err("a path link is not (from, to, animation, portal)".to_owned());
        }
        let animation = read_optional(&parts[2], |id| read_hex(id, "path link").map(key_of))?;
        let portal_bits: Vec<u32> = items(&parts[3], "path link")?.iter().map(|b| read_u32(b, "path link")).collect::<Result<_, _>>()?;
        let portal: [u32; 6] = portal_bits.try_into().map_err(|_| "a path link portal is not six numbers".to_owned())?;
        links.push(SavedLink { from: read_node(&parts[0], "path link")?, to: read_node(&parts[1], "path link")?, animation, portal });
    }
    Ok(SavedPath { segments, links, start: read_vec3(field(value, "start")?, "path start")?, end: read_vec3(field(value, "end")?, "path end")? })
}

fn read_agent(value: &Value) -> Result<ParsedAgent, Problem> {
    let speeds = read_floats(field(value, "speeds")?, "speeds", 3)?;
    let mut agent = Agent::<GenexCoords>::create(read_vec3(field(value, "position")?, "position")?, read_vec3(field(value, "velocity")?, "velocity")?, speeds[0], speeds[1], speeds[2]);
    agent.current_desired_move = read_vec3(field(value, "move")?, "move")?;
    agent.current_target = read_optional(field(value, "target")?, |t| read_vec3(t, "target"))?;
    agent.target_reached_condition = read_reached(field(value, "reached")?)?;
    agent.animation_link_reached_distance = read_optional(field(value, "link_reach")?, |d| read_finite(d, "link_reach"))?;
    let permitted = read_optional(field(value, "permitted")?, |kinds| items(kinds, "permitted")?.iter().map(|k| read_u64(k, "permitted").map(|k| k as usize)).collect::<Result<Vec<_>, _>>())?;
    agent.permitted_animation_links = permitted.map_or(PermittedAnimationLinks::All, PermittedAnimationLinks::kinds);
    for (index, cost) in read_pairs(field(value, "costs")?, "agent costs")? {
        agent.override_type_index_cost(index, cost);
    }
    let flags = items(field(value, "flags")?, "flags")?;
    let (Some(paused), Some(using)) = (flags.first(), flags.get(1)) else {
        return Err("flags is not (paused, on link)".to_owned());
    };
    agent.paused = read_bool(paused, "paused")?;
    agent.using_animation_link = read_bool(using, "on link")?;
    let state = read_u32(field(value, "state")?, "state")? as usize;
    agent.state = *STATES.get(state).ok_or_else(|| format!("agent state {state}"))?;
    let link = read_optional(field(value, "at_link")?, read_saved_link)?;
    let path = read_optional(field(value, "path")?, read_path)?;
    Ok(ParsedAgent { agent, path, link })
}

impl Nav {
    fn parse_snapshot(&self, snapshot: &Value) -> Result<Parsed, Problem> {
        if !matches!(snapshot, Value::Object(_)) {
            return Err("not an object".to_owned());
        }
        let version = read_u32(field(snapshot, "version")?, "version")?;
        if version != NAV_SNAPSHOT_VERSION {
            return Err(format!("version {version}, this build reads {NAV_SNAPSHOT_VERSION}"));
        }
        if read_hex(field(snapshot, "config")?, "config")? != self.config.digest() {
            return Err("taken from a nav of another walker config".to_owned());
        }
        let cells = items(field(snapshot, "cells")?, "cells")?.iter().map(|c| read_cell(c, "cells")).collect::<Result<Vec<_>, _>>()?;
        if cells != self.sorted_cells() {
            return Err("taken over other resident tiles: re-add the meshes first".to_owned());
        }
        let links = items(field(snapshot, "links")?, "links")?.iter().map(|l| read_hex(l, "links")).collect::<Result<Vec<_>, _>>()?;
        if !links.iter().copied().eq(self.links().map(NavLinkId::raw)) {
            return Err("taken with other links: re-add the links first".to_owned());
        }
        let closed: Vec<AnimationLinkId> = items(field(snapshot, "closed")?, "closed")?.iter().map(|l| read_hex(l, "closed").map(key_of)).collect::<Result<_, _>>()?;
        if closed.iter().any(|id| self.archipelago.get_animation_link(*id).is_none()) {
            return Err("a closed link is not one of this nav's".to_owned());
        }
        let obstacles = items(field(snapshot, "obstacles")?, "obstacles")?.iter().map(read_obstacle).collect::<Result<Vec<_>, _>>()?;
        let (body_generations, body_free, body_live) = read_arena::<CharacterId, _>(field(snapshot, "bodies")?, "bodies", read_body)?;
        let bodies = Arena::from_layout(&body_generations, &body_free, body_live).ok_or("the bodies' id layout does not hold together")?;
        let (generations, free, live) = read_arena::<RuntimeAgentId, _>(field(snapshot, "agents")?, "agents", read_agent)?;
        let queue: Vec<RuntimeAgentId> = items(field(snapshot, "queue")?, "queue")?.iter().map(|q| read_hex(q, "queue").map(key_of)).collect::<Result<_, _>>()?;
        let queue_ok = queue.iter().all(|id| live.iter().any(|(key, _)| key == id)) && queue.iter().collect::<genex_core::map::Set<_>>().len() == queue.len();
        if !queue_ok {
            return Err("the search queue names an agent twice or one that is not live".to_owned());
        }
        Ok(Parsed {
            costs: read_pairs(field(snapshot, "costs")?, "costs")?,
            shut: items(field(snapshot, "shut")?, "shut")?.iter().map(|s| read_u64(s, "shut").map(|s| s as usize)).collect::<Result<_, _>>()?,
            closed,
            obstacles,
            next_obstacle: read_hex(field(snapshot, "next_obstacle")?, "next_obstacle")?,
            bodies,
            agents: ParsedArena { generations, free, live },
            queue,
        })
    }
}
