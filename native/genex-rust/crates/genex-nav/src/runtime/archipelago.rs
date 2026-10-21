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
//!   its maps as `Map`/`Set` and its explore heap ordered by (distance, node)).
//! - P14 (NAV-8): [`Gates`] shut areas and close links; on the update after a gate shuts, every
//!   corridor through it is dropped and its agent repaths.
//! - A paused agent, or one taking an animation link, wants no move (upstream kept its last one).

use std::collections::{BinaryHeap, VecDeque};

use genex_core::map::{Map, Set};
use glam::{Vec2, Vec3, Vec3Swizzles};

use super::agent::{Agent, AgentId, AgentState, ReachedAnimationLink, RepathResult, does_agent_need_repath};
use super::avoidance::{Avoidance, AvoidanceAgent, AvoidanceBody, AvoidanceSettings};
use super::character::{Character, CharacterId};
use super::coords::{CoordinateSystem, CorePointSampleDistance, FromAgentRadius, GenexCoords, PointSampleDistance};
use super::dodgy::{Obstacle, VisibilitySet};
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
}

/// Where each agent and target was sampled this update.
struct Sampled {
    agent_nodes: Map<AgentId, (Vec3, NodeRef)>,
    target_nodes: Map<AgentId, (Vec3, NodeRef)>,
    character_points: Map<CharacterId, Vec3>,
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
        let mut follow: Map<AgentId, (PathIndex, PathIndex)> = Map::default();
        let mut needs_search: Set<AgentId> = Set::default();
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
        let mut sampled = Sampled { agent_nodes: Map::default(), target_nodes: Map::default(), character_points: Map::default() };
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
    fn run_searches(&mut self, sampled: &Sampled, needs_search: &Set<AgentId>, follow: &mut Map<AgentId, (PathIndex, PathIndex)>) {
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
    fn wait_or_follow_old(&mut self, sampled: &Sampled, needs_search: &Set<AgentId>, follow: &mut Map<AgentId, (PathIndex, PathIndex)>) {
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
    fn steer(&mut self, sampled: &Sampled, follow: &Map<AgentId, (PathIndex, PathIndex)>) {
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
        let mut obstacles = Vec::with_capacity(sampled.agent_nodes.len());
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
            obstacles.push(border_obstacles((point, node), &self.nav_data, options.neighbourhood));
            ids.push(agent_id);
        }
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

/// The mesh borders near the agent as dodgy obstacles, seen from the agent's node so floors above
/// and below never count (landmass's `nav_mesh_borders_to_dodgy_obstacles`).
fn border_obstacles<CS: CoordinateSystem>(agent_node: (Vec3, NodeRef), nav_data: &NavigationData<CS>, distance_limit: f32) -> Vec<Obstacle> {
    let distance_limit = distance_limit * distance_limit;
    let mut visibility_set = VisibilitySet::new();
    let mut border_edges: Map<u32, (BorderVertex, BorderVertex)> = Map::default();
    let mut new_vertices: Vec<Vec2> = Vec::new();
    let mut explored: Set<NodeRef> = Set::default();
    let mut next_nodes = BinaryHeap::new();
    next_nodes.push(explore_node(0.0, agent_node.1));
    let agent_point = agent_node.0.xy();
    let relative = |island: &Island<CS>, index: usize, origin: Vec2| island.transform.apply(island.nav_mesh.vertices[index]).xy() - origin;

    while let Some(ExploreNode { node, .. }) = next_nodes.pop() {
        if !explored.insert(node) {
            continue;
        }
        let Some(island) = nav_data.get_island(node.island_id) else {
            continue;
        };
        let polygon = &island.nav_mesh.polygons[node.polygon_index];
        let mut remaining_edges: Set<usize> = (0..polygon.vertices.len()).collect();
        // Crossings out of the node: dodgy's solid side is the left, so each edge is reversed
        // to keep the node's outside solid.
        let mut crossings: Vec<(Vec2, Vec2, NodeRef)> = Vec::new();
        for (edge_index, connectivity) in polygon.connectivity.iter().enumerate() {
            let Some(connectivity) = connectivity else {
                continue;
            };
            remaining_edges.shift_remove(&edge_index);
            let (vertex_1, vertex_2) = polygon.get_edge_indices(edge_index);
            let next = NodeRef { island_id: node.island_id, polygon_index: connectivity.polygon_index };
            crossings.push((relative(island, vertex_2, agent_point), relative(island, vertex_1, agent_point), next));
        }
        if let Some(links) = nav_data.node_to_off_mesh_link_ids.get(&node) {
            for link in links.iter().filter_map(|id| nav_data.off_mesh_links.get(*id)) {
                // Only boundary links count for visibility.
                if matches!(link.kinded, KindedOffMeshLink::BoundaryLink { .. }) {
                    crossings.push((link.portal.1.xy() - agent_point, link.portal.0.xy() - agent_point, link.destination_node));
                }
            }
        }
        for (vertex_1, vertex_2, next) in crossings {
            if !visibility_set.is_line_visible(vertex_1, vertex_2) {
                continue;
            }
            let score = vertex_1.length_squared().min(vertex_2.length_squared());
            if score < distance_limit {
                next_nodes.push(explore_node(score, next));
            }
        }
        let modified_node = nav_data.modified_nodes.get(&node);
        add_borders(&mut visibility_set, &mut border_edges, &mut new_vertices, (node, island), modified_node, &remaining_edges, agent_point);
    }
    build_obstacles(nav_data, &visibility_set, &border_edges, &new_vertices)
}

/// Adds one node's border edges to the visibility set: a modified node's new boundary, or the
/// node's unconnected edges.
fn add_borders<CS: CoordinateSystem>(
    visibility_set: &mut VisibilitySet,
    border_edges: &mut Map<u32, (BorderVertex, BorderVertex)>,
    new_vertices: &mut Vec<Vec2>,
    (node, island): (NodeRef, &Island<CS>),
    modified_node: Option<&ModifiedNode>,
    remaining_edges: &Set<usize>,
    agent_point: Vec2,
) {
    let mesh_vertices = island.nav_mesh.vertices.len();
    let world = |index: usize| island.transform.apply(island.nav_mesh.vertices[index]).xy();
    let Some(modified_node) = modified_node else {
        let polygon = &island.nav_mesh.polygons[node.polygon_index];
        for &border_edge in remaining_edges {
            // Reversed, so the outside of the node is solid.
            let (border_vertex_2, border_vertex_1) = polygon.get_edge_indices(border_edge);
            let line = visibility_set.add_line(world(border_vertex_1) - agent_point, world(border_vertex_2) - agent_point);
            if let Some(line) = line {
                border_edges.insert(line, ((Some(node.island_id), border_vertex_1), (Some(node.island_id), border_vertex_2)));
            }
        }
        return;
    };
    let endpoint = |index: usize, new_vertices: &mut Vec<Vec2>| -> (Vec2, BorderVertex) {
        if index >= mesh_vertices {
            let vertex = modified_node.new_vertices[index - mesh_vertices];
            new_vertices.push(vertex);
            return (vertex - agent_point, (None, new_vertices.len() - 1));
        }
        (world(index) - agent_point, (Some(node.island_id), index))
    };
    for &(left, right) in &modified_node.new_boundary {
        let (left_point, left_index) = endpoint(left, new_vertices);
        let (right_point, right_index) = endpoint(right, new_vertices);
        if let Some(line) = visibility_set.add_line(left_point, right_point) {
            border_edges.insert(line, (left_index, right_index));
        }
    }
}

/// Joins the visible border edges into loops: closed loops and open chains, as dodgy obstacles.
fn build_obstacles<CS: CoordinateSystem>(
    nav_data: &NavigationData<CS>,
    visibility_set: &VisibilitySet,
    border_edges: &Map<u32, (BorderVertex, BorderVertex)>,
    new_vertices: &[Vec2],
) -> Vec<Obstacle> {
    let mut finished_loops: Vec<Vec<BorderVertex>> = Vec::new();
    let mut unfinished_loops: Vec<Vec<BorderVertex>> = Vec::new();
    for line_id in visibility_set.get_visible_line_ids() {
        let Some(&edge) = border_edges.get(&line_id) else {
            continue;
        };
        let left_loop = unfinished_loops.iter().position(|edge_loop| edge_loop[edge_loop.len() - 1] == edge.0);
        let right_loop = unfinished_loops.iter().position(|edge_loop| edge_loop[0] == edge.1);
        match (left_loop, right_loop) {
            (None, None) => unfinished_loops.push(vec![edge.0, edge.1]),
            (Some(left), None) => unfinished_loops[left].push(edge.1),
            (None, Some(right)) => unfinished_loops[right].insert(0, edge.0),
            (Some(left), Some(right)) if left == right => finished_loops.push(unfinished_loops.remove(left)),
            (Some(left), Some(right)) => {
                let mut left_loop = unfinished_loops.swap_remove(left);
                // swap_remove moved the last loop into `left`'s slot.
                let right = if right == unfinished_loops.len() { left } else { right };
                let right_loop = unfinished_loops.swap_remove(right);
                left_loop.extend(right_loop);
                unfinished_loops.push(left_loop);
            }
        }
    }
    let to_vec = |(island_id, index): BorderVertex| match island_id {
        None => new_vertices[index],
        Some(island_id) => nav_data.get_island(island_id).map_or(Vec2::ZERO, |island| island.transform.apply(island.nav_mesh.vertices[index]).xy()),
    };
    let closed = finished_loops.into_iter().map(|edge_loop| Obstacle::Closed { vertices: edge_loop.into_iter().rev().map(to_vec).collect() });
    let open = unfinished_loops.into_iter().map(|edge_loop| Obstacle::Open { vertices: edge_loop.into_iter().rev().map(to_vec).collect() });
    closed.chain(open).collect()
}

#[cfg(test)]
#[path = "archipelago_test.rs"]
mod test;
