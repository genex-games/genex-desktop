//! The archipelago: islands, animation links, agents and characters, stepped by
//! [`Archipelago::update`] once per tick.
//!
//! Ported from landmass 0.9.3 `src/lib.rs` (`Archipelago`, `ArchipelagoOptions`,
//! `PathingResult`) and the nav-mesh border obstacles of `src/avoidance.rs` (MIT OR Apache-2.0,
//! used under Apache 2.0; crates.io sha256
//! `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`). Changed (NAV-7):
//! - P1: agents and characters live in [`crate::arena`]s; every per-update table is a `Map`/`Set`.
//! - P7: the edge-link distance is an option ([`ArchipelagoOptions::edge_link_distance`]).
//! - P12: repaths are budgeted in work units ([`SearchBudget`]): at most `searches_per_tick`
//!   searches per update, each capped at `search_nodes` expansions. Agents over budget queue in
//!   FIFO order (agents that need a path on the same tick enter in agent order), say
//!   [`AgentState::Waiting`], and keep following an old corridor that is still valid. A capped
//!   search counts as `NoPath` for an agent.
//! - Avoidance is NAV-6's [`Avoidance`] step (sorted neighbours, no k-d tree); this file builds
//!   its inputs and the border obstacles (landmass's `nav_mesh_borders_to_dodgy_obstacles`, with
//!   its maps as `Map`/`Set` and its explore heap ordered by (distance, node)). GE (NAV-18): the
//!   border tables it only looks up are genex-core `FastMap`/`FastSet`, and a node's unconnected
//!   edges and crossings reuse one buffer each (the same edges in the same ascending order).
//!   R-19 (the same bits): a walk asks a crossing's visibility only when the node could still be
//!   queued nearer; each island's world vertices are made once per update and each vertex's ray
//!   once per walk; the explored and queued sets are per-polygon walk tags; visible edges are
//!   indexed by line id and carry their world points; the walk's buffers and every agent's
//!   obstacles are kept across updates; and the per-update agent tables are `FastMap`s.
//! - P14 (NAV-8): [`Gates`] shut areas and close links; on the update after a gate shuts, every
//!   corridor through it is dropped and its agent repaths.
//! - A paused agent, or one taking an animation link, wants no move (upstream kept its last one).

use std::collections::{BinaryHeap, VecDeque};

use genex_core::map::{FastMap, FastSet, Set};
use glam::{Vec2, Vec3, Vec3Swizzles};

use super::agent::{Agent, AgentId, AgentState, ReachedAnimationLink, RepathResult, does_agent_need_repath};
use super::avoidance::{Avoidance, AvoidanceAgent, AvoidanceBody, AvoidanceSettings};
use super::character::{Character, CharacterId};
use super::coords::{CoordinateSystem, CorePointSampleDistance, FromAgentRadius, GenexCoords, PointSampleDistance};
use super::dodgy::{ConeRay, Obstacle, VisibilitySet};
use super::island::{Island, IslandId};
use super::link::{AnimationLink, AnimationLinkId};
use super::nav_data::{DEFAULT_EDGE_LINK_DISTANCE, IslandMut, KindedOffMeshLink, ModifiedNode, NavigationData, NodeRef, SetTypeIndexCostError};
use super::path::{Path, PathIndex, StraightPathStep};
use super::pathfinding::{self, SearchRules};
use crate::arena::{Arena, ArenaKey};
use crate::filter::Gates;

/// The default node cap of one search (A* expansions).
pub const SEARCH_NODES_DEFAULT: u32 = 2048;
/// The default number of searches one update may run.
pub const SEARCHES_PER_TICK_DEFAULT: u32 = 8;
/// The bit that keeps a character's avoidance key apart from every agent's.
const CHARACTER_KEY_BIT: u64 = 1 << 63;
/// The bits that keep an avoid disc's key apart from every agent's and character's.
const AVOID_DISC_KEY_BITS: u64 = (1 << 63) | (1 << 62);

/// The search work one update may do, in work units (never time), so a tick costs the same on
/// every destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchBudget {
    /// The most path searches one update runs; agents past it wait their turn.
    pub searches_per_tick: u32,
    /// The most nodes one search expands; past it the search gives up (`NoPath`).
    pub search_nodes: u32,
}

impl Default for SearchBudget {
    fn default() -> Self {
        Self { searches_per_tick: SEARCHES_PER_TICK_DEFAULT, search_nodes: SEARCH_NODES_DEFAULT }
    }
}

/// Options for the whole archipelago.
pub struct ArchipelagoOptions<CS: CoordinateSystem> {
    /// How far agent and target points are sampled onto the meshes.
    pub point_sample_distance: CS::SampleDistance,
    /// How far past its radius an agent looks for others to avoid.
    pub neighbourhood: f32,
    /// Seconds ahead collisions with agents and characters are avoided.
    pub avoidance_time_horizon: f32,
    /// Seconds ahead collisions with mesh borders are avoided.
    pub obstacle_avoidance_time_horizon: f32,
    /// The avoidance share of an agent at its target (0 < value ≤ 1).
    pub reached_destination_avoidance_responsibility: f32,
    /// How close two islands' boundary edges must be to stitch, in metres (P7).
    pub edge_link_distance: f32,
    /// The search work per update (P12).
    pub budget: SearchBudget,
}

impl<CS: CoordinateSystem<SampleDistance: FromAgentRadius>> FromAgentRadius for ArchipelagoOptions<CS> {
    fn from_agent_radius(radius: f32) -> Self {
        Self {
            point_sample_distance: CS::SampleDistance::from_agent_radius(radius),
            neighbourhood: 10.0 * radius,
            avoidance_time_horizon: 0.5,
            obstacle_avoidance_time_horizon: 0.25,
            reached_destination_avoidance_responsibility: 0.1,
            edge_link_distance: DEFAULT_EDGE_LINK_DISTANCE,
            budget: SearchBudget::default(),
        }
    }
}

/// One search an update ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathingResult {
    /// The agent that searched.
    pub agent: AgentId,
    /// Whether a path was found.
    pub success: bool,
    /// The nodes the search expanded (0 when the ends are known to be disconnected).
    pub explored_nodes: u32,
}

/// Islands, links, agents and characters.
pub struct Archipelago<CS: CoordinateSystem> {
    /// The options; changes apply from the next update.
    pub archipelago_options: ArchipelagoOptions<CS>,
    pub(crate) nav_data: NavigationData<CS>,
    pub(crate) agents: Arena<AgentId, Agent<CS>>,
    pub(crate) characters: Arena<CharacterId, Character<CS>>,
    pathing_results: Vec<PathingResult>,
    /// Agents waiting for a search, oldest first; `queued` mirrors it for lookups.
    pub(crate) repath_queue: VecDeque<AgentId>,
    pub(crate) queued: Set<AgentId>,
    gates: Gates,
    avoidance: Avoidance,
    /// Discs agents steer around this update, in genex world space (centre, radius): the nav's
    /// avoid obstacles (NAV-12), set before each update.
    pub(crate) avoid_discs: Vec<(Vec3, f32)>,
    /// The border walk's buffers, kept across updates so a tick allocates nothing for them
    /// (R-19, NAV-18's update budget).
    borders: BorderScratch,
    /// Each agent's border obstacles from the last update, reused in place.
    border_obstacles: Vec<Vec<Obstacle>>,
}

/// Where each agent and target was sampled this update. The tables are only filled in agent
/// order and looked up, so their hash never reaches a result (R-19: `FastMap`, not `Map`).
struct Sampled {
    agent_nodes: FastMap<AgentId, (Vec3, NodeRef)>,
    target_nodes: FastMap<AgentId, (Vec3, NodeRef)>,
    character_points: FastMap<CharacterId, Vec3>,
}

impl<CS: CoordinateSystem> Archipelago<CS> {
    /// An empty archipelago.
    pub fn new(archipelago_options: ArchipelagoOptions<CS>) -> Self {
        Self {
            archipelago_options,
            nav_data: NavigationData::new(),
            agents: Arena::new(),
            characters: Arena::new(),
            pathing_results: Vec::new(),
            repath_queue: VecDeque::new(),
            queued: Set::default(),
            gates: Gates::new(),
            avoidance: Avoidance::new(),
            avoid_discs: Vec::new(),
            borders: BorderScratch::default(),
            border_obstacles: Vec::new(),
        }
    }

    /// Adds an agent.
    pub fn add_agent(&mut self, agent: Agent<CS>) -> AgentId {
        self.agents.insert(agent)
    }

    /// Removes an agent. Returns whether it was there (upstream panicked on a dead id).
    pub fn remove_agent(&mut self, agent_id: AgentId) -> bool {
        self.queued.shift_remove(&agent_id);
        self.agents.remove(agent_id).is_some()
    }

    /// An agent.
    pub fn get_agent(&self, agent_id: AgentId) -> Option<&Agent<CS>> {
        self.agents.get(agent_id)
    }

    /// An agent, to change.
    pub fn get_agent_mut(&mut self, agent_id: AgentId) -> Option<&mut Agent<CS>> {
        self.agents.get_mut(agent_id)
    }

    /// Every agent, in insertion order.
    pub fn get_agent_ids(&self) -> impl Iterator<Item = AgentId> + '_ {
        self.agents.keys()
    }

    /// Adds a character.
    pub fn add_character(&mut self, character: Character<CS>) -> CharacterId {
        self.characters.insert(character)
    }

    /// Removes a character. Returns whether it was there.
    pub fn remove_character(&mut self, character_id: CharacterId) -> bool {
        self.characters.remove(character_id).is_some()
    }

    /// A character.
    pub fn get_character(&self, character_id: CharacterId) -> Option<&Character<CS>> {
        self.characters.get(character_id)
    }

    /// A character, to change.
    pub fn get_character_mut(&mut self, character_id: CharacterId) -> Option<&mut Character<CS>> {
        self.characters.get_mut(character_id)
    }

    /// Every character, in insertion order.
    pub fn get_character_ids(&self) -> impl Iterator<Item = CharacterId> + '_ {
        self.characters.keys()
    }

    /// Adds an island (stitched at the next update).
    pub fn add_island(&mut self, island: Island<CS>) -> IslandId {
        self.nav_data.add_island(island)
    }

    /// Removes an island. Returns whether it was there.
    pub fn remove_island(&mut self, island_id: IslandId) -> bool {
        self.nav_data.remove_island(island_id)
    }

    /// An island.
    pub fn get_island(&self, island_id: IslandId) -> Option<&Island<CS>> {
        self.nav_data.get_island(island_id)
    }

    /// An island, to change.
    pub fn get_island_mut(&mut self, island_id: IslandId) -> Option<IslandMut<'_, CS>> {
        self.nav_data.get_island_mut(island_id)
    }

    /// Every island, in insertion order.
    pub fn get_island_ids(&self) -> impl Iterator<Item = IslandId> + '_ {
        self.nav_data.get_island_ids()
    }

    /// Adds an animation link (attached at the next update, and re-attached whenever the islands
    /// under its ends come back).
    pub fn add_animation_link(&mut self, link: AnimationLink<CS>) -> AnimationLinkId {
        self.nav_data.add_animation_link(link)
    }

    /// Removes an animation link. Returns whether it was there.
    pub fn remove_animation_link(&mut self, link_id: AnimationLinkId) -> bool {
        self.gates.forget_link(link_id);
        self.nav_data.remove_animation_link(link_id)
    }

    /// An animation link.
    pub fn get_animation_link(&self, link_id: AnimationLinkId) -> Option<&AnimationLink<CS>> {
        self.nav_data.get_animation_link(link_id)
    }

    /// Every animation link, in insertion order.
    pub fn get_animation_link_ids(&self) -> impl Iterator<Item = AnimationLinkId> + '_ {
        self.nav_data.get_animation_link_ids()
    }

    /// Whether an animation link is attached to a node at its start (its start island is in).
    pub fn is_animation_link_attached(&self, link_id: AnimationLinkId) -> bool {
        self.nav_data.off_mesh_links.iter().any(|(_, link)| {
            matches!(link.kinded, KindedOffMeshLink::AnimationLink { animation_link, .. } if animation_link == link_id)
        })
    }

    /// Sets the cost per metre of `type_index`; agents prefer cheap ground.
    ///
    /// # Errors
    ///
    /// [`SetTypeIndexCostError::NonPositiveCost`] for a cost not above zero.
    pub fn set_type_index_cost(&mut self, type_index: usize, cost: f32) -> Result<(), SetTypeIndexCostError> {
        self.nav_data.set_type_index_cost(type_index, cost)
    }

    /// The cost of `type_index`, when set.
    pub fn get_type_index_cost(&self, type_index: usize) -> Option<f32> {
        self.nav_data.get_type_index_cost(type_index)
    }

    /// Every set type cost.
    pub fn get_type_index_costs(&self) -> impl Iterator<Item = (usize, f32)> + '_ {
        self.nav_data.get_type_index_costs()
    }

    /// The shut areas and closed links.
    pub fn gates(&self) -> &Gates {
        &self.gates
    }

    /// The shut areas and closed links, to change; corridors through a newly shut one are dropped
    /// at the next update.
    pub fn gates_mut(&mut self) -> &mut Gates {
        &mut self.gates
    }

    /// The navigation data (read-only, for queries and debug draws).
    pub fn nav_data(&self) -> &NavigationData<CS> {
        &self.nav_data
    }

    /// The searches the last update ran, in the order it ran them.
    pub fn get_pathing_results(&self) -> &[PathingResult] {
        &self.pathing_results
    }

    /// How many agents wait for a search.
    pub fn waiting_for_search(&self) -> usize {
        self.queued.len()
    }

    fn sample_distance(&self) -> CorePointSampleDistance {
        CorePointSampleDistance::new(&self.archipelago_options.point_sample_distance)
    }

    /// One tick: stitch what changed, sample agents, repath within the budget, walk the funnel to
    /// each agent's next corner, then bend the moves around each other (avoidance).
    pub fn update(&mut self, delta_time: f32) {
        self.pathing_results.clear();
        let vertical = self.archipelago_options.point_sample_distance.animation_link_max_vertical_distance();
        let (invalidated_links, invalidated_islands) = self.nav_data.update(self.archipelago_options.edge_link_distance, vertical);
        let gates_shut = self.gates.take_newly_shut();
        let sampled = self.sample();

        // Classify every agent, keeping or dropping paths; queue the ones that need a search.
        let mut follow: FastMap<AgentId, (PathIndex, PathIndex)> = FastMap::default();
        let mut needs_search: FastSet<AgentId> = FastSet::default();
        let nav_data = &self.nav_data;
        let gates = &self.gates;
        self.agents.for_each_mut(|agent_id, agent| {
            // Cleared whether paused or not; re-set below when the link is still reached.
            agent.current_animation_link = None;
            let path_broken = |path: &Path| {
                let gate_shut_on_it = gates_shut && path.crosses_closed(nav_data, gates);
                !path.is_valid(&invalidated_links, &invalidated_islands) || gate_shut_on_it
            };
            if agent.paused || agent.using_animation_link {
                agent.state = if agent.paused { AgentState::Paused } else { AgentState::UsingAnimationLink };
                if agent.current_path.as_ref().is_some_and(path_broken) {
                    agent.current_path = None;
                }
                return;
            }
            if agent.current_path.as_ref().is_some_and(path_broken) {
                agent.current_path = None;
            }
            let agent_node = sampled.agent_nodes.get(&agent_id).map(|(_, node)| *node);
            let target_node = sampled.target_nodes.get(&agent_id).map(|(_, node)| *node);
            match does_agent_need_repath(agent, agent_node, target_node, &invalidated_links, &invalidated_islands) {
                RepathResult::DoNothing => {}
                RepathResult::FollowPath(agent_index, target_index) => {
                    follow.insert(agent_id, (agent_index, target_index));
                }
                RepathResult::ClearPathNoTarget => clear(agent, AgentState::Idle),
                RepathResult::ClearPathBadAgent => clear(agent, AgentState::AgentNotOnNavMesh),
                RepathResult::ClearPathBadTarget => clear(agent, AgentState::TargetNotOnNavMesh),
                RepathResult::NeedsRepath => {
                    needs_search.insert(agent_id);
                }
            }
        });
        for &agent_id in &needs_search {
            if self.queued.insert(agent_id) {
                self.repath_queue.push_back(agent_id);
            }
        }
        self.run_searches(&sampled, &needs_search, &mut follow);
        self.wait_or_follow_old(&sampled, &needs_search, &mut follow);
        self.steer(&sampled, &follow);
        self.avoid(&sampled, delta_time);
    }

    /// Samples every active agent, its target and every character onto the meshes.
    fn sample(&self) -> Sampled {
        let distance = self.sample_distance();
        let mut sampled = Sampled { agent_nodes: FastMap::default(), target_nodes: FastMap::default(), character_points: FastMap::default() };
        for (agent_id, agent) in self.agents.iter() {
            if agent.paused || agent.using_animation_link {
                continue;
            }
            let Some(agent_node) = self.nav_data.sample_point(CS::to_landmass(&agent.position), &distance) else {
                continue;
            };
            sampled.agent_nodes.insert(agent_id, agent_node);
            let Some(target) = &agent.current_target else {
                continue;
            };
            if let Some(target_node) = self.nav_data.sample_point(CS::to_landmass(target), &distance) {
                sampled.target_nodes.insert(agent_id, target_node);
            }
        }
        for (character_id, character) in self.characters.iter() {
            if let Some((point, _)) = self.nav_data.sample_point(CS::to_landmass(&character.position), &distance) {
                sampled.character_points.insert(character_id, point);
            }
        }
        sampled
    }

    /// Runs up to `searches_per_tick` searches for the oldest queued agents that still need one.
    fn run_searches(&mut self, sampled: &Sampled, needs_search: &FastSet<AgentId>, follow: &mut FastMap<AgentId, (PathIndex, PathIndex)>) {
        let budget = self.archipelago_options.budget;
        let mut searches = 0;
        while searches < budget.searches_per_tick {
            let Some(agent_id) = self.repath_queue.pop_front() else {
                break;
            };
            self.queued.shift_remove(&agent_id);
            // Removed, or no longer needing a path (target dropped, path still good): free.
            if !needs_search.contains(&agent_id) {
                continue;
            }
            let Some(agent) = self.agents.get_mut(agent_id) else {
                continue;
            };
            searches += 1;
            let (agent_point, agent_node) = sampled.agent_nodes[&agent_id];
            let (target_point, target_node) = sampled.target_nodes[&agent_id];
            let rules = SearchRules {
                override_type_index_to_cost: &agent.override_type_index_to_cost,
                permitted_animation_links: &agent.permitted_animation_links,
                gates: &self.gates,
                max_explored: budget.search_nodes,
            };
            let result = pathfinding::find_path(&self.nav_data, agent_node, agent_point, target_node, target_point, rules);
            let found = if result.partial { None } else { result.path };
            self.pathing_results.push(PathingResult { agent: agent_id, success: found.is_some(), explored_nodes: result.stats.explored_nodes });
            let Some(path) = found else {
                clear(agent, AgentState::NoPath);
                continue;
            };
            follow.insert(agent_id, (PathIndex::from_corridor_index(0, 0), path.last_index()));
            agent.current_path = Some(path);
            // No longer waiting; `steer` refines this (arrived, at a link).
            agent.state = AgentState::Moving;
        }
    }

    /// Agents still queued after the searches wait: they follow an old, still-valid corridor
    /// toward its old end, or stand still.
    fn wait_or_follow_old(&mut self, sampled: &Sampled, needs_search: &FastSet<AgentId>, follow: &mut FastMap<AgentId, (PathIndex, PathIndex)>) {
        for &agent_id in needs_search {
            if !self.queued.contains(&agent_id) {
                continue;
            }
            let Some(agent) = self.agents.get_mut(agent_id) else {
                continue;
            };
            agent.state = AgentState::Waiting;
            let agent_node = sampled.agent_nodes.get(&agent_id).map(|(_, node)| *node);
            let old_index = agent
                .current_path
                .as_ref()
                .zip(agent_node)
                .and_then(|(path, node)| path.find_index_of_node(node).map(|index| (index, path.last_index())));
            match old_index {
                Some(indices) => {
                    follow.insert(agent_id, indices);
                }
                None => agent.current_path = None,
            }
        }
    }

    /// Each agent's desired move toward its next corner, its state, and any reached link.
    fn steer(&mut self, sampled: &Sampled, follow: &FastMap<AgentId, (PathIndex, PathIndex)>) {
        let nav_data = &self.nav_data;
        self.agents.for_each_mut(|agent_id, agent| {
            let Some(path) = &agent.current_path else {
                agent.current_desired_move = CS::from_landmass(&Vec3::ZERO);
                return;
            };
            // A paused agent (or one taking a link) keeps its path but was not sampled. Changed
            // from upstream, which kept its last move: it wants no move while the game owns it.
            if agent.paused || agent.using_animation_link {
                agent.current_desired_move = CS::from_landmass(&Vec3::ZERO);
                return;
            }
            let Some(&(agent_point, _)) = sampled.agent_nodes.get(&agent_id) else {
                return;
            };
            let Some(&(agent_index, target_index)) = follow.get(&agent_id) else {
                return;
            };
            let waiting = agent.state == AgentState::Waiting;
            // A waiting agent walks its old corridor to the old end; others to the target.
            let target_point = match sampled.target_nodes.get(&agent_id) {
                Some(&(point, _)) if !waiting => point,
                _ => path.end_point,
            };
            let next = path.find_next_point_in_straight_path(nav_data, agent_index, agent_point, target_index, target_point);
            if !waiting && agent.has_reached_target(path, nav_data, agent_point, next, (target_index, target_point)) {
                agent.current_desired_move = CS::from_landmass(&Vec3::ZERO);
                agent.state = AgentState::ReachedTarget;
                return;
            }
            let waypoint = match next.1 {
                StraightPathStep::Waypoint(point) => {
                    set_unless_waiting(agent, AgentState::Moving);
                    point
                }
                StraightPathStep::AnimationLink { start_point, end_point, link_id, start_node, end_node } => {
                    // Refine the link's ends onto the mesh.
                    let start_point = on_node(nav_data, start_point, start_node);
                    let end_point = on_node(nav_data, end_point, end_node);
                    if !waiting && agent_point.distance(start_point) <= agent.animation_link_reached_distance() {
                        agent.state = AgentState::ReachedAnimationLink;
                        let (start_point, end_point) = (CS::from_landmass(&start_point), CS::from_landmass(&end_point));
                        let link = ReachedAnimationLink { link_id, start_point, end_point };
                        agent.current_animation_link = Some(link);
                    } else {
                        set_unless_waiting(agent, AgentState::Moving);
                    }
                    start_point
                }
            };
            let desired_move = (waypoint - CS::to_landmass(&agent.position)).xy().normalize_or_zero() * agent.desired_speed;
            agent.current_desired_move = CS::from_landmass(&desired_move.extend(0.0));
        });
    }

    /// Bends every sampled agent's desired move around its neighbours, the characters and the
    /// mesh borders (NAV-6's ORCA step, in genex world space).
    fn avoid(&mut self, sampled: &Sampled, delta_time: f32) {
        let options = &self.archipelago_options;
        let mut ids = Vec::with_capacity(sampled.agent_nodes.len());
        let mut agents = Vec::with_capacity(sampled.agent_nodes.len());
        // Last update's buffers: the walk's, and each agent's obstacles to refill in place.
        let mut scratch = std::mem::take(&mut self.borders);
        scratch.islands.clear();
        let mut obstacles = std::mem::take(&mut self.border_obstacles);
        let mut walked = 0;
        for (agent_id, agent) in self.agents.iter() {
            let Some(&(point, node)) = sampled.agent_nodes.get(&agent_id) else {
                continue;
            };
            let responsibility = if agent.state == AgentState::ReachedTarget { options.reached_destination_avoidance_responsibility } else { 1.0 };
            agents.push(AvoidanceAgent {
                key: agent_id.raw(),
                position: GenexCoords::from_landmass(&point),
                velocity: GenexCoords::from_landmass(&CS::to_landmass(&agent.velocity)),
                desired_velocity: GenexCoords::from_landmass(&CS::to_landmass(&agent.current_desired_move)),
                radius: agent.radius,
                max_speed: agent.max_speed,
                responsibility,
            });
            if obstacles.len() == walked {
                obstacles.push(Vec::new());
            }
            border_obstacles((point, node), &self.nav_data, options.neighbourhood, &mut scratch, &mut obstacles[walked]);
            walked += 1;
            ids.push(agent_id);
        }
        obstacles.truncate(walked);
        let mut bodies: Vec<AvoidanceBody> = self
            .characters
            .iter()
            .filter_map(|(id, character)| {
                let point = sampled.character_points.get(&id)?;
                Some(AvoidanceBody {
                    key: id.raw() | CHARACTER_KEY_BIT,
                    position: GenexCoords::from_landmass(point),
                    velocity: GenexCoords::from_landmass(&CS::to_landmass(&character.velocity)),
                    radius: character.radius,
                })
            })
            .collect();
        // Avoid obstacles are still bodies; their keys sit past every character's.
        for (index, &(position, radius)) in self.avoid_discs.iter().enumerate() {
            bodies.push(AvoidanceBody { key: AVOID_DISC_KEY_BITS | index as u64, position, velocity: Vec3::ZERO, radius });
        }
        let settings = AvoidanceSettings {
            neighbourhood: options.neighbourhood,
            time_horizon: options.avoidance_time_horizon,
            obstacle_time_horizon: options.obstacle_avoidance_time_horizon,
        };
        let mut velocities = Vec::with_capacity(agents.len());
        self.avoidance.step(&agents, &bodies, &obstacles, &settings, delta_time, &mut velocities);
        self.borders = scratch;
        self.border_obstacles = obstacles;
        for (agent_id, velocity) in ids.into_iter().zip(velocities) {
            if let Some(agent) = self.agents.get_mut(agent_id) {
                agent.current_desired_move = CS::from_landmass(&GenexCoords::to_landmass(&velocity));
            }
        }
    }
}

/// Drops `agent`'s path and sets `state`.
fn clear<CS: CoordinateSystem>(agent: &mut Agent<CS>, state: AgentState) {
    agent.state = state;
    agent.current_path = None;
}

/// Sets `state` unless the agent waits for a search (it still says `Waiting`).
fn set_unless_waiting<CS: CoordinateSystem>(agent: &mut Agent<CS>, state: AgentState) {
    if agent.state != AgentState::Waiting {
        agent.state = state;
    }
}

/// `point` moved onto `node`'s surface (world space).
fn on_node<CS: CoordinateSystem>(nav_data: &NavigationData<CS>, point: Vec3, node: NodeRef) -> Vec3 {
    let Some(island) = nav_data.get_island(node.island_id) else {
        return point;
    };
    let local = island.transform.apply_inverse(point);
    island.transform.apply(island.nav_mesh.sample_point_on_node(local, node.polygon_index))
}

/// A node to explore for border obstacles. The max-heap pops the nearest first, ties by the
/// smaller node, so the walk never depends on push order.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct ExploreNode {
    /// (distance squared's bits, node), both reversed: a non-negative float's bits order as it.
    key: (core::cmp::Reverse<u32>, core::cmp::Reverse<NodeRef>),
    node: NodeRef,
}

/// `distance_squared` (never negative) as a max-heap key that pops the nearest first.
fn explore_node(distance_squared: f32, node: NodeRef) -> ExploreNode {
    ExploreNode { key: (core::cmp::Reverse(distance_squared.max(0.0).to_bits()), core::cmp::Reverse(node)), node }
}

/// A vertex of an island (or a modified node's new vertex) a border edge ends at.
type BorderVertex = (Option<IslandId>, usize);

/// A border edge's end: which vertex (what loops join on) and where it is in world space.
type BorderEnd = (BorderVertex, Vec2);

/// One island's vertices as a border walk sees them: in world space (made once per tick, the bits
/// `Transform::apply` gives) and, per walk, as rays from the agent (made once per walk).
#[derive(Default)]
struct IslandBorders {
    /// Every vertex of the island's mesh, world space, ground plane.
    world: Vec<Vec2>,
    /// Each vertex's ray from the walking agent, tagged with the walk that made it (a tag that is
    /// not the current walk's is stale, so no walk clears the table).
    rays: Vec<(u32, ConeRay)>,
    /// Each polygon's walk tags: the walk's explored and queued sets, without hashing.
    nodes: Vec<NodeTag>,
}

/// One polygon's place in the walks: explored in walk `explored`; queued in walk `queued` at the
/// nearest score `bits` (a non-negative float's bits). A tag of an older walk means not yet.
#[derive(Clone, Copy, Default)]
struct NodeTag {
    explored: u32,
    queued: u32,
    bits: u32,
}

impl IslandBorders {
    /// The island's world vertices and empty ray and node tables.
    fn new<CS: CoordinateSystem>(island: &Island<CS>) -> IslandBorders {
        let apply = island.transform.applier();
        let world: Vec<Vec2> = island.nav_mesh.vertices.iter().map(|&vertex| apply(vertex).xy()).collect();
        let rays = vec![(0, ConeRay::default()); world.len()];
        let nodes = vec![NodeTag::default(); island.nav_mesh.polygons.len()];
        IslandBorders { world, rays, nodes }
    }

    /// Vertex `index`'s ray from `agent_point` in walk `walk`, made at its first use in the walk.
    fn ray(&mut self, walk: u32, index: usize, agent_point: Vec2) -> ConeRay {
        let (tag, ray) = &mut self.rays[index];
        if *tag != walk {
            *tag = walk;
            *ray = ConeRay::from_point(self.world[index] - agent_point);
        }
        *ray
    }
}

/// A crossing out of an explored node: its ends relative to the agent (dodgy's solid side on the
/// left) and, for a mesh edge, the ends' vertex indices in the node's island.
type Crossing = (Vec2, Vec2, Option<(usize, usize)>, NodeRef);

/// The buffers [`border_obstacles`] fills for one agent, kept across a tick's agents so each walk
/// reuses their memory (GE fix r2, NAV-18's update budget). Every walk starts them empty, except
/// the per-island vertex tables, which hold for the whole tick (R-19).
#[derive(Default)]
struct BorderScratch {
    visibility_set: VisibilitySet,
    /// Each visible line's edge, indexed by its line id (the set hands out ids 0, 1, 2, ...).
    border_edges: Vec<(BorderEnd, BorderEnd)>,
    new_vertices: Vec<Vec2>,
    remaining_edges: Vec<usize>,
    crossings: Vec<Crossing>,
    next_nodes: BinaryHeap<ExploreNode>,
    /// Each island a walk reached this tick: world vertices, rays and node tags (emptied once per
    /// update).
    islands: FastMap<IslandId, IslandBorders>,
    /// The loops [`build_obstacles`] joins, and spare buffers for them.
    loops: LoopBuffers,
    /// The current walk's tag for [`IslandBorders::rays`] and [`IslandBorders::nodes`] (0 is never
    /// a walk).
    walk: u32,
}

impl BorderScratch {
    /// Empty every per-walk buffer, keeping its memory, and start a new walk tag.
    fn clear(&mut self) {
        self.visibility_set.clear();
        self.border_edges.clear();
        self.new_vertices.clear();
        self.remaining_edges.clear();
        self.crossings.clear();
        self.next_nodes.clear();
        self.walk += 1;
    }
}

/// The mesh borders near the agent as dodgy obstacles into `out` (its old obstacles' buffers are
/// reused), seen from the agent's node so floors above and below never count (landmass's
/// `nav_mesh_borders_to_dodgy_obstacles`), walked in `scratch`.
fn border_obstacles<CS: CoordinateSystem>(agent_node: (Vec3, NodeRef), nav_data: &NavigationData<CS>, distance_limit: f32, scratch: &mut BorderScratch, out: &mut Vec<Obstacle>) {
    let distance_limit = distance_limit * distance_limit;
    scratch.clear();
    let BorderScratch { visibility_set, border_edges, new_vertices, remaining_edges, crossings, next_nodes, islands, loops, walk } = scratch;
    let walk = *walk;
    next_nodes.push(explore_node(0.0, agent_node.1));
    let agent_point = agent_node.0.xy();

    while let Some(ExploreNode { node, .. }) = next_nodes.pop() {
        // A node of a missing island is never explored, so it is never queued either.
        let Some(island) = nav_data.get_island(node.island_id) else {
            continue;
        };
        let slot = island_slot(islands, node.island_id, island);
        let tag = &mut islands[slot].nodes[node.polygon_index];
        if tag.explored == walk {
            continue;
        }
        tag.explored = walk;
        let polygon = &island.nav_mesh.polygons[node.polygon_index];
        // The node's unconnected edges, ascending.
        remaining_edges.clear();
        remaining_edges.extend((0..polygon.vertices.len()).filter(|&edge| !matches!(polygon.connectivity.get(edge), Some(Some(_)))));
        // Crossings out of the node: dodgy's solid side is the left, so each edge is reversed
        // to keep the node's outside solid.
        crossings.clear();
        let world = &islands[slot].world;
        for (edge_index, connectivity) in polygon.connectivity.iter().enumerate() {
            let Some(connectivity) = connectivity else {
                continue;
            };
            let (vertex_1, vertex_2) = polygon.get_edge_indices(edge_index);
            let next = NodeRef { island_id: node.island_id, polygon_index: connectivity.polygon_index };
            crossings.push((world[vertex_2] - agent_point, world[vertex_1] - agent_point, Some((vertex_2, vertex_1)), next));
        }
        if let Some(links) = nav_data.node_to_off_mesh_link_ids.get(&node) {
            for link in links.iter().filter_map(|id| nav_data.off_mesh_links.get(*id)) {
                // Only boundary links count for visibility.
                if matches!(link.kinded, KindedOffMeshLink::BoundaryLink { .. }) {
                    crossings.push((link.portal.1.xy() - agent_point, link.portal.0.xy() - agent_point, None, link.destination_node));
                }
            }
        }
        for &(vertex_1, vertex_2, indices, next) in crossings.iter() {
            // The cheap tests first: a crossing past the limit, into an explored node or into a
            // node already queued at least as near is never explored from here, so its
            // visibility (the costly test) is never asked.
            let score = vertex_1.length_squared().min(vertex_2.length_squared());
            if score >= distance_limit {
                continue;
            }
            let next_slot = if next.island_id == node.island_id {
                slot
            } else {
                let Some(next_island) = nav_data.get_island(next.island_id) else {
                    continue;
                };
                island_slot(islands, next.island_id, next_island)
            };
            let bits = score.max(0.0).to_bits();
            let next_tag = islands[next_slot].nodes[next.polygon_index];
            if next_tag.explored == walk || (next_tag.queued == walk && next_tag.bits <= bits) {
                continue;
            }
            let (ray_1, ray_2) = match indices {
                Some((index_1, index_2)) => (islands[slot].ray(walk, index_1, agent_point), islands[slot].ray(walk, index_2, agent_point)),
                None => (ConeRay::from_point(vertex_1), ConeRay::from_point(vertex_2)),
            };
            if !visibility_set.is_ray_line_visible(ray_1, ray_2) {
                continue;
            }
            islands[next_slot].nodes[next.polygon_index] = NodeTag { queued: walk, bits, ..next_tag };
            next_nodes.push(explore_node(score, next));
        }
        // Most meshes carry no carved node: skip the lookup's hash then.
        let modified_node = if nav_data.modified_nodes.is_empty() { None } else { nav_data.modified_nodes.get(&node) };
        let walker = BorderWalker { walk, agent_point, borders: &mut islands[slot] };
        add_borders(visibility_set, border_edges, new_vertices, (node, island), modified_node, remaining_edges, walker);
    }
    build_obstacles(visibility_set, border_edges, loops, out);
}

/// `id`'s slot in `islands`, its tables made at its first walk of the update.
fn island_slot<CS: CoordinateSystem>(islands: &mut FastMap<IslandId, IslandBorders>, id: IslandId, island: &Island<CS>) -> usize {
    let entry = islands.entry(id);
    let slot = entry.index();
    entry.or_insert_with(|| IslandBorders::new(island));
    slot
}

/// The agent a walk is for, and the island it is in.
struct BorderWalker<'a> {
    walk: u32,
    agent_point: Vec2,
    borders: &'a mut IslandBorders,
}

/// Adds one node's border edges to the visibility set: a modified node's new boundary, or the
/// node's unconnected edges.
fn add_borders<CS: CoordinateSystem>(
    visibility_set: &mut VisibilitySet,
    border_edges: &mut Vec<(BorderEnd, BorderEnd)>,
    new_vertices: &mut Vec<Vec2>,
    (node, island): (NodeRef, &Island<CS>),
    modified_node: Option<&ModifiedNode>,
    remaining_edges: &[usize],
    walker: BorderWalker<'_>,
) {
    let BorderWalker { walk, agent_point, borders } = walker;
    let mesh_vertices = island.nav_mesh.vertices.len();
    let Some(modified_node) = modified_node else {
        let polygon = &island.nav_mesh.polygons[node.polygon_index];
        for &border_edge in remaining_edges {
            // Reversed, so the outside of the node is solid.
            let (border_vertex_2, border_vertex_1) = polygon.get_edge_indices(border_edge);
            let line = visibility_set.add_ray_line(borders.ray(walk, border_vertex_1, agent_point), borders.ray(walk, border_vertex_2, agent_point));
            if let Some(line) = line {
                let end = |index: usize| ((Some(node.island_id), index), borders.world[index]);
                record_edge(border_edges, line, (end(border_vertex_1), end(border_vertex_2)));
            }
        }
        return;
    };
    let mut endpoint = |index: usize, new_vertices: &mut Vec<Vec2>| -> (ConeRay, BorderEnd) {
        if index >= mesh_vertices {
            let vertex = modified_node.new_vertices[index - mesh_vertices];
            new_vertices.push(vertex);
            return (ConeRay::from_point(vertex - agent_point), ((None, new_vertices.len() - 1), vertex));
        }
        (borders.ray(walk, index, agent_point), ((Some(node.island_id), index), borders.world[index]))
    };
    for &(left, right) in &modified_node.new_boundary {
        let (left_ray, left_index) = endpoint(left, new_vertices);
        let (right_ray, right_index) = endpoint(right, new_vertices);
        if let Some(line) = visibility_set.add_ray_line(left_ray, right_ray) {
            record_edge(border_edges, line, (left_index, right_index));
        }
    }
}

/// Records visible line `line`'s edge: the set hands out ids in order, so it is the next index.
fn record_edge(border_edges: &mut Vec<(BorderEnd, BorderEnd)>, line: u32, edge: (BorderEnd, BorderEnd)) {
    debug_assert_eq!(border_edges.len(), line as usize, "line ids come in order");
    border_edges.push(edge);
}

/// The border loops [`build_obstacles`] joins, and spare buffers so a walk allocates nothing once
/// the first walks have grown them.
#[derive(Default)]
struct LoopBuffers {
    /// The visible line ids, ascending.
    line_ids: Vec<u32>,
    finished: Vec<Vec<BorderEnd>>,
    unfinished: Vec<Vec<BorderEnd>>,
    /// Empty loop buffers.
    spare: Vec<Vec<BorderEnd>>,
    /// Empty obstacle vertex buffers.
    vertex_spare: Vec<Vec<Vec2>>,
}

/// Joins the visible border edges into loops: closed loops and open chains, as dodgy obstacles
/// into `out` (emptied first; its vertex buffers are reused).
fn build_obstacles(
    visibility_set: &VisibilitySet,
    border_edges: &[(BorderEnd, BorderEnd)],
    loops: &mut LoopBuffers,
    out: &mut Vec<Obstacle>,
) {
    let LoopBuffers { line_ids, finished, unfinished, spare, vertex_spare } = loops;
    for obstacle in out.drain(..) {
        let (Obstacle::Closed { mut vertices } | Obstacle::Open { mut vertices }) = obstacle;
        vertices.clear();
        vertex_spare.push(vertices);
    }
    visibility_set.visible_line_ids_into(line_ids);
    for line_id in line_ids.iter() {
        let Some(&edge) = border_edges.get(*line_id as usize) else {
            continue;
        };
        let left_loop = unfinished.iter().position(|edge_loop| edge_loop[edge_loop.len() - 1].0 == edge.0.0);
        let right_loop = unfinished.iter().position(|edge_loop| edge_loop[0].0 == edge.1.0);
        match (left_loop, right_loop) {
            (None, None) => {
                let mut edge_loop = spare.pop().unwrap_or_default();
                edge_loop.extend([edge.0, edge.1]);
                unfinished.push(edge_loop);
            }
            (Some(left), None) => unfinished[left].push(edge.1),
            (None, Some(right)) => unfinished[right].insert(0, edge.0),
            (Some(left), Some(right)) if left == right => finished.push(unfinished.remove(left)),
            (Some(left), Some(right)) => {
                let mut left_loop = unfinished.swap_remove(left);
                // swap_remove moved the last loop into `left`'s slot.
                let right = if right == unfinished.len() { left } else { right };
                let mut right_loop = unfinished.swap_remove(right);
                left_loop.append(&mut right_loop);
                spare.push(right_loop);
                unfinished.push(left_loop);
            }
        }
    }
    // Closed loops first, then open chains, each in the order it was made.
    let closed = finished.drain(..).map(|edge_loop| (true, edge_loop));
    for (is_closed, mut edge_loop) in closed.chain(unfinished.drain(..).map(|edge_loop| (false, edge_loop))) {
        let mut vertices = vertex_spare.pop().unwrap_or_default();
        vertices.extend(edge_loop.iter().rev().map(|&(_, point)| point));
        out.push(if is_closed { Obstacle::Closed { vertices } } else { Obstacle::Open { vertices } });
        edge_loop.clear();
        spare.push(edge_loop);
    }
}

#[cfg(test)]
#[path = "archipelago_test.rs"]
mod test;
