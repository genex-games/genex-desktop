//! NAV-7: agents, A*, the funnel and the repath budget on the ported landmass archipelago.
//!
//! - A crowd replays bit for bit: 32 replicas of 64 agents crossing a 4-island mesh for 600 ticks
//!   agree on every tick's digest of desired-velocity bits, state and reached link.
//! - Repaths are budgeted in work units: 100 agents handed new targets on one tick with
//!   `searches_per_tick = 8` run exactly 8 searches that tick, wait in FIFO order, and all have a
//!   path by tick 13.
//! - A search is capped at `search_nodes` expansions: an unreachable target on a 20k-polygon maze
//!   gives `NoPath` within the cap (behind a wall of impassable cost, and in a walled-off region).
//! - `update` cost for 100 agents on a 1k-polygon mesh is recorded (printed; NAV-18 gates it).

use std::sync::Arc;

use genex_core::digest::fnv1a64_from;
use genex_nav::arena::ArenaKey;
use genex_nav::runtime::agent::{Agent, AgentId, AgentState};
use genex_nav::runtime::archipelago::{Archipelago, ArchipelagoOptions, SearchBudget};
use genex_nav::runtime::coords::{FromAgentRadius, GenexCoords};
use genex_nav::runtime::island::Island;
use genex_nav::runtime::nav_mesh::NavigationMesh;
use genex_nav::runtime::util::Transform;
use glam::Vec3;

const DT: f32 = 1.0 / 60.0;
const RADIUS: f32 = 0.25;
const REPLICAS: usize = 32;

/// A `cols` × `rows` grid of `cell`-metre squares from (`x0`, `z0`) toward +x and −z (genex Y-up,
/// counter-clockwise from above). `kind(i, j)` is a cell's type index, or `None` for a hole.
fn grid_mesh(x0: f32, z0: f32, cell: f32, cols: usize, rows: usize, kind: impl Fn(usize, usize) -> Option<usize>) -> NavigationMesh<GenexCoords> {
    let mut vertices = Vec::with_capacity((cols + 1) * (rows + 1));
    for j in 0..=rows {
        for i in 0..=cols {
            vertices.push(Vec3::new(x0 + i as f32 * cell, 0.0, z0 - j as f32 * cell));
        }
    }
    let at = |i: usize, j: usize| j * (cols + 1) + i;
    let mut polygons = Vec::new();
    let mut polygon_type_indices = Vec::new();
    for j in 0..rows {
        for i in 0..cols {
            if let Some(type_index) = kind(i, j) {
                polygons.push(vec![at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
                polygon_type_indices.push(type_index);
            }
        }
    }
    NavigationMesh { vertices, polygons, polygon_type_indices, height_mesh: None }
}

fn island(mesh: NavigationMesh<GenexCoords>) -> Island<GenexCoords> {
    Island::new(Transform::default(), Arc::new(mesh.validate().expect("a valid grid mesh")))
}

fn archipelago(budget: SearchBudget) -> Archipelago<GenexCoords> {
    let mut options = ArchipelagoOptions::<GenexCoords>::from_agent_radius(RADIUS);
    options.budget = budget;
    Archipelago::new(options)
}

/// Moves every agent by its desired velocity for one tick (a stand-in for the game's mover).
fn integrate(archipelago: &mut Archipelago<GenexCoords>) {
    let ids: Vec<AgentId> = archipelago.get_agent_ids().collect();
    for id in ids {
        let agent = archipelago.get_agent_mut(id).expect("a live agent");
        let velocity = *agent.get_desired_velocity();
        agent.velocity = velocity;
        agent.position += velocity * DT;
    }
}

const fn state_code(state: AgentState) -> u8 {
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

/// The tick's digest: per agent in id order, desired-velocity bits, state and reached link.
fn tick_digest(archipelago: &Archipelago<GenexCoords>) -> u64 {
    let mut hash = fnv1a64_from(&[], 0xcbf2_9ce4_8422_2325);
    for id in archipelago.get_agent_ids() {
        let agent = archipelago.get_agent(id).expect("a live agent");
        let velocity = agent.get_desired_velocity();
        for bits in [velocity.x.to_bits(), velocity.y.to_bits(), velocity.z.to_bits()] {
            hash = fnv1a64_from(&bits.to_le_bytes(), hash);
        }
        hash = fnv1a64_from(&[state_code(agent.state())], hash);
        let link = agent.reached_animation_link().map_or(u64::MAX, |link| link.link_id.raw());
        hash = fnv1a64_from(&link.to_le_bytes(), hash);
    }
    hash
}

/// One crowd replica: 4 touching 8 × 8 islands (16 × 16 m), 64 agents on a ring, each walking to
/// the opposite point; the digest of every tick.
fn crowd_replica() -> Vec<u64> {
    let mut archipelago = archipelago(SearchBudget::default());
    for (x0, z0) in [(0.0, 0.0), (8.0, 0.0), (0.0, -8.0), (8.0, -8.0)] {
        archipelago.add_island(island(grid_mesh(x0, z0, 1.0, 8, 8, |_, _| Some(0))));
    }
    let centre = Vec3::new(8.0, 0.0, -8.0);
    for k in 0..64 {
        let angle = k as f32 / 64.0 * core::f32::consts::TAU;
        let direction = glam::Vec2::from_angle(angle);
        let offset = Vec3::new(direction.x, 0.0, direction.y) * 6.5;
        let mut agent = Agent::create(centre + offset, Vec3::ZERO, RADIUS, 1.4, 2.0);
        agent.current_target = Some(centre - offset);
        archipelago.add_agent(agent);
    }
    let mut digests = Vec::with_capacity(600);
    for _ in 0..600 {
        archipelago.update(DT);
        digests.push(tick_digest(&archipelago));
        integrate(&mut archipelago);
    }
    digests
}

#[test]
fn a_crowd_replays_bit_for_bit_in_every_replica() {
    // Replicas run on threads only to keep the row quick; each is a whole, separate simulation
    // (and with per-process hash keys, each map would hash differently in each one).
    let replicas: Vec<Vec<u64>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..REPLICAS).map(|_| scope.spawn(crowd_replica)).collect();
        handles.into_iter().map(|handle| handle.join().expect("a replica ran")).collect()
    });
    let first = &replicas[0];
    for (replica, digests) in replicas.iter().enumerate().skip(1) {
        let diverged = digests.iter().zip(first).position(|(a, b)| a != b);
        assert_eq!(diverged, None, "replica {replica} diverged at tick index {diverged:?}");
    }
    let moving = first.windows(2).filter(|pair| pair[0] != pair[1]).count();
    assert!(moving > 300, "the crowd moved on most ticks ({moving} of 599 changed)");
    println!("crowd digest at tick 600: {:016x}", first[599]);
}

#[test]
fn repaths_run_within_the_tick_budget_in_fifo_order() {
    let budget = SearchBudget { searches_per_tick: 8, search_nodes: 2048 };
    let mut archipelago = archipelago(budget);
    archipelago.add_island(island(grid_mesh(0.0, 0.0, 1.0, 40, 40, |_, _| Some(0))));
    let mut ids = Vec::new();
    for k in 0..100 {
        let (i, j) = (k % 10, k / 10);
        let position = Vec3::new(2.0 + i as f32 * 1.5, 0.0, -2.0 - j as f32 * 1.5);
        ids.push(archipelago.add_agent(Agent::create(position, Vec3::ZERO, RADIUS, 1.4, 2.0)));
    }
    archipelago.update(DT);
    assert!(archipelago.get_pathing_results().is_empty(), "no agent has a target yet");
    for &id in &ids {
        let agent = archipelago.get_agent_mut(id).expect("a live agent");
        agent.current_target = Some(agent.position + Vec3::new(18.0, 0.0, -18.0));
    }
    let mut searched_order = Vec::new();
    for tick in 1..=13 {
        archipelago.update(DT);
        let results = archipelago.get_pathing_results();
        let expected = if tick < 13 { 8 } else { 4 };
        assert_eq!(results.len(), expected, "tick {tick} ran {} searches", results.len());
        assert!(results.iter().all(|result| result.success && result.explored_nodes <= budget.search_nodes));
        searched_order.extend(results.iter().map(|result| result.agent));
        let waiting = ids.iter().filter(|id| archipelago.get_agent(**id).is_some_and(|agent| agent.state() == AgentState::Waiting)).count();
        assert_eq!(waiting, 100 - searched_order.len(), "tick {tick}: every agent not yet searched says Waiting");
    }
    assert_eq!(searched_order, ids, "searches ran in FIFO order by agent");
    for &id in &ids {
        let state = archipelago.get_agent(id).expect("a live agent").state();
        assert_eq!(state, AgentState::Moving, "every agent has a path by tick 13");
    }
    archipelago.update(DT);
    assert!(archipelago.get_pathing_results().is_empty(), "paths are reused once found");
}

/// A 160 × 160 maze (about 21k polygons) whose target cell sits inside a ring of `ring` cells.
fn maze(ring: Option<usize>) -> NavigationMesh<GenexCoords> {
    grid_mesh(0.0, 0.0, 1.0, 160, 160, |i, j| {
        let on_ring = ((i == 120 || i == 130) && (120..=130).contains(&j)) || ((j == 120 || j == 130) && (120..=130).contains(&i));
        // Corridor walls every 4 columns, open at alternating ends: a serpentine maze.
        let wall = i % 4 == 3 && i < 116 && if (i / 4) % 2 == 0 { j > 2 } else { j < 157 };
        if on_ring {
            return ring;
        }
        if wall { None } else { Some(0) }
    })
}

fn no_path_within_the_cap(ring: Option<usize>, impassable: bool) -> (AgentState, u32) {
    let budget = SearchBudget { searches_per_tick: 1, search_nodes: 2048 };
    let mut archipelago = archipelago(budget);
    let mesh = maze(ring);
    assert!(mesh.polygons.len() > 20_000, "a 20k-polygon maze ({})", mesh.polygons.len());
    archipelago.add_island(island(mesh));
    if impassable {
        archipelago.set_type_index_cost(1, f32::INFINITY).expect("an impassable cost");
    }
    let mut agent = Agent::create(Vec3::new(0.5, 0.0, -0.5), Vec3::ZERO, RADIUS, 1.4, 2.0);
    agent.current_target = Some(Vec3::new(125.5, 0.0, -125.5));
    let id = archipelago.add_agent(agent);
    archipelago.update(DT);
    let explored = archipelago.get_pathing_results().iter().map(|result| result.explored_nodes).sum();
    assert!(archipelago.get_pathing_results().iter().all(|result| !result.success));
    (archipelago.get_agent(id).expect("a live agent").state(), explored)
}

#[test]
fn an_unreachable_target_gives_no_path_within_the_node_cap() {
    // Behind a ring of impassable cost: the regions connect, so A* runs and stops at the cap.
    let (state, explored) = no_path_within_the_cap(Some(1), true);
    assert_eq!(state, AgentState::NoPath);
    assert_eq!(explored, 2048, "the search stopped at search_nodes");
    // Inside a walled-off region: known disconnected before any expansion.
    let (state, explored) = no_path_within_the_cap(None, false);
    assert_eq!(state, AgentState::NoPath);
    assert_eq!(explored, 0);
}

#[test]
fn a_reachable_target_past_the_cap_is_found_with_a_larger_cap() {
    let mut archipelago = archipelago(SearchBudget { searches_per_tick: 1, search_nodes: u32::MAX });
    archipelago.add_island(island(maze(Some(0))));
    let mut agent = Agent::create(Vec3::new(0.5, 0.0, -0.5), Vec3::ZERO, RADIUS, 1.4, 2.0);
    agent.current_target = Some(Vec3::new(125.5, 0.0, -125.5));
    let id = archipelago.add_agent(agent);
    archipelago.update(DT);
    let explored: u32 = archipelago.get_pathing_results().iter().map(|result| result.explored_nodes).sum();
    assert_eq!(archipelago.get_agent(id).expect("a live agent").state(), AgentState::Moving);
    assert!(explored > 2048, "the serpentine path needs more than the default cap ({explored})");
}

/// Wall-clock cost of `update` (debug or release, as the test runs). Recorded, not asserted.
#[test]
#[expect(clippy::disallowed_types, reason = "a timing row in a test: the simulation itself never reads a clock")]
fn update_cost_for_100_agents_on_a_1k_polygon_mesh_is_recorded() {
    use std::time::Instant;
    let mut archipelago = archipelago(SearchBudget::default());
    archipelago.add_island(island(grid_mesh(0.0, 0.0, 1.0, 32, 32, |_, _| Some(0))));
    let mut ids = Vec::new();
    for k in 0..100 {
        let (i, j) = (k % 10, k / 10);
        let position = Vec3::new(1.0 + i as f32 * 3.0, 0.0, -1.0 - j as f32 * 3.0);
        ids.push(archipelago.add_agent(Agent::create(position, Vec3::ZERO, RADIUS, 1.4, 2.0)));
    }
    let mut samples = Vec::new();
    for tick in 0..600u32 {
        if tick % 120 == 0 {
            for (n, &id) in ids.iter().enumerate() {
                let agent = archipelago.get_agent_mut(id).expect("a live agent");
                let k = (n as u32 * 7 + tick / 120 * 13) % 100;
                agent.current_target = Some(Vec3::new(1.0 + (k % 10) as f32 * 3.0, 0.0, -1.0 - (k / 10) as f32 * 3.0));
            }
        }
        let start = Instant::now();
        archipelago.update(DT);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        integrate(&mut archipelago);
    }
    samples.sort_by(f64::total_cmp);
    let p95 = samples[samples.len() * 95 / 100];
    let p50 = samples[samples.len() / 2];
    println!("nav update, 100 agents, 1024 polygons: p50 {p50:.4} ms, p95 {p95:.4} ms, max {:.4} ms", samples[samples.len() - 1]);
}

#[test]
fn hostile_agents_and_steps_change_nothing_else_and_never_panic() {
    let mut archipelago = archipelago(SearchBudget::default());
    archipelago.add_island(island(grid_mesh(0.0, 0.0, 1.0, 8, 8, |_, _| Some(0))));
    let walker = {
        let mut agent = Agent::create(Vec3::new(1.5, 0.0, -1.5), Vec3::ZERO, RADIUS, 1.4, 2.0);
        agent.current_target = Some(Vec3::new(6.5, 0.0, -6.5));
        archipelago.add_agent(agent)
    };
    let nan = Vec3::splat(f32::NAN);
    let lost = archipelago.add_agent(Agent::create(nan, nan, RADIUS, 1.4, 2.0));
    let bad_target = {
        let mut agent = Agent::create(Vec3::new(2.5, 0.0, -2.5), Vec3::ZERO, RADIUS, 1.4, 2.0);
        agent.current_target = Some(Vec3::new(f32::INFINITY, 0.0, 0.0));
        archipelago.add_agent(agent)
    };
    for dt in [DT, 0.0, -1.0, f32::NAN, f32::INFINITY] {
        archipelago.update(dt);
    }
    let state = |id| archipelago.get_agent(id).expect("a live agent").state();
    assert_eq!(state(walker), AgentState::Moving);
    assert!(archipelago.get_agent(walker).expect("live").get_desired_velocity().is_finite());
    assert_eq!(state(lost), AgentState::Idle, "no target: idle, never sampled into avoidance");
    archipelago.get_agent_mut(lost).expect("live").current_target = Some(Vec3::new(1.0, 0.0, -1.0));
    archipelago.update(DT);
    let state = |id| archipelago.get_agent(id).expect("a live agent").state();
    assert_eq!(state(lost), AgentState::AgentNotOnNavMesh);
    assert_eq!(state(bad_target), AgentState::TargetNotOnNavMesh);
    // A removed id stays dead: every call on it is a no-op.
    assert!(archipelago.remove_agent(lost));
    assert!(!archipelago.remove_agent(lost));
    assert!(archipelago.get_agent(lost).is_none());
    archipelago.update(DT);
    assert_eq!(archipelago.get_agent_ids().count(), 2);
}
