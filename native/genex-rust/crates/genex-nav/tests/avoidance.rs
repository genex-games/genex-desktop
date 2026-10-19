//! NAV-6: ORCA local avoidance, the dodgy_2d port. Upstream dodgy_2d picks a direction with
//! `rand::random()` when two agents sit on the same spot with no relative velocity, so replicas
//! of one scene diverge and the crate pulls in `rand` and `getrandom`. The port picks that
//! direction from the two agents' keys: replicas are bit-equal, the crate graph has no `rand`,
//! and a ring of agents swapping places never overlaps.

use std::collections::BTreeSet;
use std::path::PathBuf;

use genex_nav::runtime::avoidance::{Avoidance, AvoidanceAgent, AvoidanceBody, AvoidanceSettings};
use genex_nav::runtime::dodgy::Obstacle;
use glam::{Vec2, Vec3};

/// The sim's fixed step (genex-core's `FIXED_STEP_MS`).
const DT: f32 = 1.0 / 60.0;

/// The velocity toward `goal` at up to `max_speed`, arriving in one tick when it is close.
fn toward(position: Vec3, goal: Vec3, max_speed: f32) -> Vec3 {
    let offset = Vec3::new(goal.x - position.x, 0.0, goal.z - position.z);
    let distance = offset.length();
    if distance <= max_speed * DT {
        return offset / DT;
    }
    offset * (max_speed / distance)
}

/// One tick: every agent's avoiding velocity, then every agent moves by it.
fn tick(avoidance: &mut Avoidance, agents: &mut [AvoidanceAgent], goals: &[Vec3], velocities: &mut Vec<Vec3>) {
    tick_with(avoidance, agents, goals, velocities, &AvoidanceSettings::default());
}

fn tick_with(avoidance: &mut Avoidance, agents: &mut [AvoidanceAgent], goals: &[Vec3], velocities: &mut Vec<Vec3>, settings: &AvoidanceSettings) {
    for (agent, goal) in agents.iter_mut().zip(goals) {
        agent.desired_velocity = toward(agent.position, *goal, agent.max_speed);
    }
    avoidance.step(agents, &[], &[], settings, DT, velocities);
    for (agent, velocity) in agents.iter_mut().zip(velocities.iter()) {
        agent.velocity = *velocity;
        agent.position += *velocity * DT;
    }
}

fn agent(key: u64, position: Vec3) -> AvoidanceAgent {
    AvoidanceAgent { key, position, velocity: Vec3::ZERO, desired_velocity: Vec3::ZERO, radius: 0.5, max_speed: 2.0, responsibility: 1.0 }
}

/// Every velocity of every tick of one run, as bits.
fn stacked_run() -> Vec<[u32; 6]> {
    let spot = Vec3::new(3.0, 0.0, -2.0);
    let mut agents = vec![agent(7, spot), agent(11, spot)];
    let goals = [spot, spot];
    let mut avoidance = Avoidance::new();
    let mut velocities = Vec::new();
    let mut trace = Vec::new();
    for _ in 0..120 {
        tick(&mut avoidance, &mut agents, &goals, &mut velocities);
        let [a, b] = [velocities[0], velocities[1]];
        trace.push([a.x, a.y, a.z, b.x, b.y, b.z].map(f32::to_bits));
    }
    trace
}

#[test]
fn stacked_agents_replay_bit_equal_in_32_replicas() {
    let first = stacked_run();
    for replica in 1..32 {
        assert_eq!(stacked_run(), first, "replica {replica} diverged");
    }
    let [a, b] = [Vec2::new(f32::from_bits(first[0][0]), f32::from_bits(first[0][2])), Vec2::new(f32::from_bits(first[0][3]), f32::from_bits(first[0][5]))];
    assert!(a != Vec2::ZERO, "stacked agents push apart on the first tick");
    assert!(a.dot(b) < 0.0, "the two agents push in opposite directions: {a} {b}");
}

#[test]
fn stacked_agents_separate() {
    let spot = Vec3::new(3.0, 0.0, -2.0);
    let mut agents = vec![agent(7, spot), agent(11, spot)];
    let mut avoidance = Avoidance::new();
    let mut velocities = Vec::new();
    for _ in 0..120 {
        tick(&mut avoidance, &mut agents, &[spot, spot], &mut velocities);
    }
    let gap = agents[0].position.distance(agents[1].position);
    assert!(gap >= 1.0 - 0.01, "two stacked agents end at least 2r apart, gap {gap}");
}

/// 16 agents on a circle of radius 8 m walk to the opposite point for `ticks` ticks: the
/// closest any pair came and how many arrived.
fn ring_swap(settings: &AvoidanceSettings, ticks: usize) -> (f32, usize) {
    const AGENTS: usize = 16;
    const RING: f32 = 8.0;
    let mut agents: Vec<AvoidanceAgent> = Vec::new();
    let mut goals = Vec::new();
    for index in 0..AGENTS {
        let turn = Vec2::from_angle(std::f32::consts::TAU * index as f32 / AGENTS as f32) * RING;
        agents.push(agent(index as u64 + 1, Vec3::new(turn.x, 0.0, turn.y)));
        goals.push(Vec3::new(-turn.x, 0.0, -turn.y));
    }
    let mut avoidance = Avoidance::new();
    let mut velocities = Vec::new();
    let mut closest = f32::INFINITY;
    for _ in 0..ticks {
        tick_with(&mut avoidance, &mut agents, &goals, &mut velocities, settings);
        for i in 0..AGENTS {
            for j in (i + 1)..AGENTS {
                closest = closest.min(agents[i].position.distance(agents[j].position));
            }
        }
    }
    let arrived = agents.iter().zip(&goals).filter(|(agent, goal)| agent.position.distance(**goal) < 0.05).count();
    (closest, arrived)
}

#[test]
fn a_ring_of_16_agents_swaps_places_without_overlapping() {
    let limit = 2.0 * 0.5 - 0.01;
    let looking_ahead = AvoidanceSettings { time_horizon: 4.0, ..AvoidanceSettings::default() };
    let (closest, arrived) = ring_swap(&looking_ahead, 1_800);
    println!("NAV-6 ring swap, 4 s horizon: closest pair {closest:.4} m (limit {limit:.4} m), {arrived}/16 arrived in 30 s");
    assert!(closest >= limit, "a pair came within {closest} m");
    assert_eq!(arrived, 16, "every agent reaches the far side");
    // landmass's default 1 s horizon jams the perfectly symmetric ring at the centre: the agents
    // touch and stop, but never overlap.
    let (closest, arrived) = ring_swap(&AvoidanceSettings::default(), 1_800);
    println!("NAV-6 ring swap, default 1 s horizon: closest pair {closest:.4} m, {arrived}/16 arrived in 30 s");
    assert!(closest >= limit, "a pair came within {closest} m");
}

#[test]
fn bodies_are_avoided_but_take_no_share() {
    let mut walker = agent(1, Vec3::new(-3.0, 0.0, 0.0));
    walker.desired_velocity = Vec3::new(2.0, 0.0, 0.0);
    let body = AvoidanceBody { key: 2, position: Vec3::new(0.0, 0.0, 0.0), velocity: Vec3::ZERO, radius: 0.5 };
    let mut avoidance = Avoidance::new();
    let mut out = Vec::new();
    let mut clear = walker.clone();
    avoidance.step(std::slice::from_ref(&clear), &[], &[], &AvoidanceSettings::default(), DT, &mut out);
    assert_eq!(out[0], Vec3::new(2.0, 0.0, 0.0), "nothing near: the desired velocity");
    clear.position = Vec3::new(-1.5, 0.0, 0.0);
    walker.position = clear.position;
    avoidance.step(std::slice::from_ref(&walker), std::slice::from_ref(&body), &[], &AvoidanceSettings::default(), DT, &mut out);
    assert!(out[0].z.abs() > 1e-3 || out[0].x < 2.0 - 1e-3, "a body in the way bends the velocity: {}", out[0]);
    assert_eq!(out[0].y, 0.0, "avoidance is horizontal");
}

#[test]
fn obstacles_bend_the_velocity() {
    let mut walker = agent(1, Vec3::new(0.0, 0.0, 0.0));
    walker.desired_velocity = Vec3::new(2.0, 0.0, 0.0);
    let mut avoidance = Avoidance::new();
    let mut free = Vec::new();
    avoidance.step(std::slice::from_ref(&walker), &[], &[], &AvoidanceSettings::default(), DT, &mut free);
    // A wall across the path 0.6 m ahead, in the avoidance plane (x, −z).
    // Open obstacles are solid on the left of each edge: walking −y keeps +x solid.
    let wall = Obstacle::Open { vertices: vec![Vec2::new(0.6, 5.0), Vec2::new(0.6, -5.0)] };
    let mut blocked = Vec::new();
    avoidance.step(std::slice::from_ref(&walker), &[], &[vec![wall]], &AvoidanceSettings::default(), DT, &mut blocked);
    assert!(blocked[0].x < free[0].x, "the wall slows the approach: {} vs {}", blocked[0], free[0]);
}

/// The packages `root` reaches in `Cargo.lock`.
fn lock_closure(root: &str) -> BTreeSet<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    let text = std::fs::read_to_string(&path).expect("the workspace lock");
    let mut packages: Vec<(String, Vec<String>)> = Vec::new();
    for block in text.split("[[package]]").skip(1) {
        let name = block.lines().find_map(|line| line.strip_prefix("name = \"")).map(|rest| rest.trim_end_matches('"').to_owned()).unwrap_or_default();
        let dependencies = match block.split_once("dependencies = [") {
            Some((_, rest)) => rest.split(']').next().unwrap_or("").split('"').skip(1).step_by(2).map(|dep| dep.split(' ').next().unwrap_or(dep).to_owned()).collect(),
            None => Vec::new(),
        };
        packages.push((name, dependencies));
    }
    let mut reached = BTreeSet::new();
    let mut stack = vec![root.to_owned()];
    while let Some(name) = stack.pop() {
        if !reached.insert(name.clone()) {
            continue;
        }
        for (package, dependencies) in &packages {
            if *package == name {
                stack.extend(dependencies.iter().cloned());
            }
        }
    }
    reached
}

#[test]
fn the_crate_graph_has_no_rand_or_getrandom() {
    let reached = lock_closure("genex-nav");
    assert!(reached.contains("glam"), "the closure walks dependencies: {reached:?}");
    let refused: Vec<&String> = reached.iter().filter(|name| name.starts_with("rand") || name.starts_with("getrandom")).collect();
    assert!(refused.is_empty(), "genex-nav reaches {refused:?}");
}
