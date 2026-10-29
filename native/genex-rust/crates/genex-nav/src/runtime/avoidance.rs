//! Local avoidance for agents: each agent's desired velocity bent by ORCA ([`super::dodgy`])
//! around nearby agents, bodies and obstacles. Ported from landmass 0.9.3's `avoidance.rs`
//! (MIT OR Apache-2.0), the part that gathers neighbours and calls dodgy; the nav-mesh border
//! obstacles landmass also builds come from the nav data and reach this step through
//! `obstacles` (NAV-7 builds them).
//!
//! Changed from landmass (P10): its k-d tree and `HashMap`s become a uniform grid over sorted
//! cell keys, and each agent's neighbours are sorted by (distance, key) before dodgy sees them.
//! ORCA's linear program depends on the order of its constraints, so this makes the result the
//! same on every run and destination.
//!
//! Positions are genex world space (Y up). Avoidance runs in the ground plane as landmass's Y-up
//! coordinate system maps it: a point `(x, y, z)` is `(x, −z)` to dodgy, so obstacle polygons
//! keep landmass's winding. Velocities come back horizontal (`y` = 0).

use std::borrow::Cow;

use glam::{Vec2, Vec3};

use crate::runtime::dodgy::{Agent, AvoidanceOptions, Obstacle};

/// The avoidance responsibility landmass gives an agent that has reached its target, so moving
/// agents step around it more than it steps aside.
pub const REACHED_RESPONSIBILITY: f32 = 0.1;

/// One agent taking part in avoidance.
#[derive(Clone, Debug, PartialEq)]
pub struct AvoidanceAgent {
    /// Unique among the agents and bodies of one step, stable across ticks.
    pub key: u64,
    /// Where it stands.
    pub position: Vec3,
    /// How it moved last tick.
    pub velocity: Vec3,
    /// How it wants to move (toward its next corner).
    pub desired_velocity: Vec3,
    /// Its radius.
    pub radius: f32,
    /// Its top speed: the avoiding velocity is never longer.
    pub max_speed: f32,
    /// Its share of each avoidance, against another agent's (1 for a moving agent,
    /// [`REACHED_RESPONSIBILITY`] for one that has arrived).
    pub responsibility: f32,
}

/// Something agents avoid but that takes no share of the avoidance (a character the game moves).
#[derive(Clone, Debug, PartialEq)]
pub struct AvoidanceBody {
    /// Unique among the agents and bodies of one step, stable across ticks.
    pub key: u64,
    /// Where it stands.
    pub position: Vec3,
    /// How it moves.
    pub velocity: Vec3,
    /// Its radius.
    pub radius: f32,
}

/// How far and how far ahead agents look (landmass's `ArchipelagoOptions` defaults).
#[derive(Clone, Debug, PartialEq)]
pub struct AvoidanceSettings {
    /// Extra distance past an agent's radius in which others count as neighbours.
    pub neighbourhood: f32,
    /// Seconds ahead an agent avoids other agents and bodies.
    pub time_horizon: f32,
    /// Seconds ahead an agent avoids obstacles.
    pub obstacle_time_horizon: f32,
}

impl Default for AvoidanceSettings {
    fn default() -> AvoidanceSettings {
        AvoidanceSettings { neighbourhood: 5.0, time_horizon: 1.0, obstacle_time_horizon: 0.5 }
    }
}

/// One entry of the neighbour grid: a cell and the agent or body in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CellEntry {
    cell: (i32, i32),
    index: u32,
}

/// A neighbour found for one agent, before sorting.
#[derive(Clone, Copy, Debug)]
struct Near {
    distance_squared: f32,
    key: u64,
    index: usize,
}

/// The avoidance step, with its grids and scratch kept between ticks.
#[derive(Clone, Debug, Default)]
pub struct Avoidance {
    agent_grid: Vec<CellEntry>,
    body_grid: Vec<CellEntry>,
    near_agents: Vec<Near>,
    near_bodies: Vec<Near>,
}

impl Avoidance {
    /// An empty step.
    pub fn new() -> Avoidance {
        Avoidance::default()
    }

    /// Every agent's avoiding velocity into `out` (one per agent, in agent order). Agent `i`
    /// avoids the obstacles in `obstacles[i]` (none past the slice's end). A `dt` that is not
    /// positive and finite counts as 1 s, as landmass does for a zero step.
    pub fn step(&mut self, agents: &[AvoidanceAgent], bodies: &[AvoidanceBody], obstacles: &[Vec<Obstacle>], settings: &AvoidanceSettings, dt: f32, out: &mut Vec<Vec3>) {
        let time_step = if dt.is_finite() && dt > 0.0 { dt } else { 1.0 };
        let max_radius = agents.iter().map(|agent| agent.radius).fold(0.0f32, f32::max);
        let reach = (max_radius + settings.neighbourhood).max(f32::MIN_POSITIVE);
        fill_grid(&mut self.agent_grid, agents.iter().map(|agent| agent.position), reach);
        fill_grid(&mut self.body_grid, bodies.iter().map(|body| body.position), reach);
        let dodgy_agents: Vec<Agent> = agents.iter().map(to_dodgy).collect();
        let dodgy_bodies: Vec<Agent> = bodies.iter().map(body_to_dodgy).collect();
        let options = AvoidanceOptions { obstacle_margin: 0.0, time_horizon: settings.time_horizon, obstacle_time_horizon: settings.obstacle_time_horizon };
        out.clear();
        // One neighbour and one wall list for every agent, refilled (R-19: no allocation per agent).
        let mut neighbours: Vec<Cow<'_, Agent>> = Vec::new();
        let mut walls: Vec<Cow<'_, Obstacle>> = Vec::new();
        for (index, agent) in agents.iter().enumerate() {
            self.gather(index, agents, bodies, settings, reach);
            neighbours.clear();
            neighbours.extend(self.near_agents.iter().map(|near| Cow::Borrowed(&dodgy_agents[near.index])));
            neighbours.extend(self.near_bodies.iter().map(|near| Cow::Borrowed(&dodgy_bodies[near.index])));
            walls.clear();
            walls.extend(obstacles.get(index).into_iter().flatten().map(Cow::Borrowed));
            let velocity = dodgy_agents[index].compute_avoiding_velocity(&neighbours, &walls, to_plane(agent.desired_velocity), agent.max_speed.max(0.0), time_step, &options);
            out.push(from_plane(velocity));
        }
    }

    /// Agent `index`'s neighbours into `near_agents` and `near_bodies`, each sorted by
    /// (distance, key): agents within the neighbourhood past their own radius, bodies within the
    /// neighbourhood past the largest agent radius (landmass's two rules).
    fn gather(&mut self, index: usize, agents: &[AvoidanceAgent], bodies: &[AvoidanceBody], settings: &AvoidanceSettings, reach: f32) {
        let origin = agents[index].position;
        self.near_agents.clear();
        for other in cells_around(&self.agent_grid, origin, reach) {
            let neighbour = &agents[other];
            let distance_squared = origin.distance_squared(neighbour.position);
            let limit = settings.neighbourhood + neighbour.radius;
            if other != index && distance_squared < limit * limit {
                self.near_agents.push(Near { distance_squared, key: neighbour.key, index: other });
            }
        }
        self.near_bodies.clear();
        for other in cells_around(&self.body_grid, origin, reach) {
            let body = &bodies[other];
            let distance_squared = origin.distance_squared(body.position);
            if distance_squared < reach * reach {
                self.near_bodies.push(Near { distance_squared, key: body.key, index: other });
            }
        }
        let order = |a: &Near, b: &Near| a.distance_squared.total_cmp(&b.distance_squared).then(a.key.cmp(&b.key));
        self.near_agents.sort_unstable_by(order);
        self.near_bodies.sort_unstable_by(order);
    }
}

/// The grid cell of a world point, in the ground plane.
fn cell_of(position: Vec3, size: f32) -> (i32, i32) {
    ((position.x / size).floor() as i32, (position.z / size).floor() as i32)
}

/// `grid` rebuilt for `positions`: one entry per point, sorted by cell then index.
fn fill_grid(grid: &mut Vec<CellEntry>, positions: impl Iterator<Item = Vec3>, size: f32) {
    grid.clear();
    grid.extend(positions.enumerate().map(|(index, position)| CellEntry { cell: cell_of(position, size), index: index as u32 }));
    grid.sort_unstable();
}

/// The indices in the 3 × 3 cells around `origin`'s cell: everything within `size` of it.
fn cells_around(grid: &[CellEntry], origin: Vec3, size: f32) -> impl Iterator<Item = usize> + '_ {
    let (cx, cz) = cell_of(origin, size);
    (-1..=1).flat_map(move |dx| {
        let row = cx.saturating_add(dx);
        let from = grid.partition_point(|entry| entry.cell < (row, cz.saturating_sub(1)));
        let to = grid.partition_point(|entry| entry.cell <= (row, cz.saturating_add(1)));
        grid[from..to.max(from)].iter().map(|entry| entry.index as usize)
    })
}

/// A world vector in dodgy's plane: `(x, −z)`.
fn to_plane(v: Vec3) -> Vec2 {
    Vec2::new(v.x, -v.z)
}

/// A dodgy velocity back in world space, horizontal.
fn from_plane(v: Vec2) -> Vec3 {
    Vec3::new(v.x, 0.0, -v.y)
}

/// An agent as dodgy sees it.
fn to_dodgy(agent: &AvoidanceAgent) -> Agent {
    Agent {
        position: to_plane(agent.position),
        velocity: to_plane(agent.velocity),
        radius: agent.radius,
        avoidance_responsibility: agent.responsibility.max(0.0),
        key: agent.key,
    }
}

/// A body as dodgy sees it: an agent with no share of the avoidance.
fn body_to_dodgy(body: &AvoidanceBody) -> Agent {
    Agent { position: to_plane(body.position), velocity: to_plane(body.velocity), radius: body.radius, avoidance_responsibility: 0.0, key: body.key }
}
