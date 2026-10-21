//! NAV-12 through the facade: a 600-tick game of 32 agents, a ladder, a door shut and opened, a
//! carved crate and a player body, all in `sim.nav`. Seeded from 1 twice in one runtime, and again
//! after seed 2, it gives equal `state()` checksums and equal nav probe digests every 60 ticks
//! (owner determinism rule 4: `seed(2)` then `seed(1)` equals a fresh `seed(1)`).
//!
//! New behaviour (section 0 of the game systems plan): agents did not exist in `sim.nav` before.
//! The agent types come from genex-nav directly until the facade's `nav` module re-exports them.

use genex::nav::{NavArea, NavConfig, NavInput, NavMesh, NavObstacle};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime};
use genex_nav::agents_api::{NavAgent, NavBody, NavStatus};
use genex_nav::filter::NavFilter;
use genex_nav::links::{NavLink, NavLinkKind};
use genex_nav::{AgentId, NavBodyId};

const AGENTS: usize = 32;
const TICKS: u64 = 600;
const CLIMB_TICKS: u64 = 45;

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// What the game keeps beside `sim.nav`.
#[derive(Default)]
struct World {
    agents: Vec<AgentId>,
    climbing: Vec<Option<(Vec3, u64)>>,
    player: Option<NavBodyId>,
}

fn quad(input: NavInput, (x0, z0, x1, z1): (f32, f32, f32, f32), y: f32, area: NavArea) -> NavInput {
    let vertices = [vec3(x0, y, z0), vec3(x1, y, z0), vec3(x1, y, z1), vec3(x0, y, z1)];
    input.with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], area).expect("a quad")
}

/// Two rooms joined by a DOOR doorway, and a deck 3 m up reached by a ladder.
fn scene_input() -> NavInput {
    let input = quad(NavInput::new(), (0.0, 0.0, 16.0, 16.0), 0.0, NavArea::WALK);
    let input = quad(input, (16.0, 6.0, 18.0, 10.0), 0.0, NavArea::DOOR);
    let input = quad(input, (18.0, 0.0, 34.0, 16.0), 0.0, NavArea::WALK);
    quad(input, (2.0, 20.0, 10.0, 26.0), 3.0, NavArea::WALK)
}

fn random_target(nav: &genex::nav::Nav, rng: &mut impl genex::GameRng) -> Vec3 {
    let around = if rng.below(4) == 0 { vec3(6.0, 3.0, 23.0) } else { vec3(17.0, 0.0, 8.0) };
    nav.random_point(rng, around, 30.0, &NavFilter::new()).map_or(around, |point| point.position)
}

fn reset(sim: &mut Sim<World>, rng: &mut Pcg32) {
    let mesh = NavMesh::bake(&scene_input(), &walker()).expect("the scene bakes");
    sim.nav.add_mesh(&mesh).expect("the tiles");
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    let foot = sim.nav.closest_point(vec3(6.0, 0.0, 15.0), 1.0).expect("room A").position;
    let top = sim.nav.closest_point(vec3(6.0, 3.0, 21.0), 1.0).expect("the deck").position;
    sim.nav.add_link(NavLink::between(foot, top, NavLinkKind::Ladder).both_ways()).expect("the ladder");
    sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
    // `random_point` in a reset draws from the reset's Pcg32.
    for _ in 0..AGENTS {
        let start = sim.nav.random_point(rng, vec3(17.0, 0.0, 8.0), 30.0, &NavFilter::new()).expect("a start").position;
        let agent = sim.nav.add_agent(NavAgent::new(start).with_speed(1.4 + rng.unit() * 0.4, 2.4)).expect("an agent");
        let target = random_target(&sim.nav, rng);
        sim.nav.move_to(agent, target);
        sim.world.agents.push(agent);
    }
    sim.world.climbing = vec![None; AGENTS];
    sim.world.player = sim.nav.add_body(NavBody { position: vec3(8.0, 0.0, 8.0), velocity: Vec3::ZERO, radius: 0.5 }).ok();
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    match ctx.tick {
        100 => {
            let crate_box = Mat4::from_scale_rotation_translation(vec3(2.0, 1.0, 2.0), Quat::IDENTITY, vec3(26.0, 0.5, 8.0));
            sim.nav.add_obstacle(NavObstacle::CarveBox { transform: crate_box }).expect("the crate");
        }
        200 => {
            sim.nav.set_area_open(NavArea::DOOR, false);
        }
        400 => {
            sim.nav.set_area_open(NavArea::DOOR, true);
        }
        _ => {}
    }
    let sweep = ((ctx.tick % 240) as f32 / 30.0 - 4.0).abs();
    if let Some(player) = sim.world.player {
        sim.nav.set_body(player, vec3(4.0 + sweep * 2.0, 0.0, 8.0), Vec3::ZERO);
    }
    sim.nav.update(ctx.dt);
    for index in 0..sim.world.agents.len() {
        move_agent(sim, ctx, index);
    }
}

fn move_agent(sim: &mut Sim<World>, ctx: &Ctx<'_>, index: usize) {
    let agent = sim.world.agents[index];
    if let Some((end, done)) = sim.world.climbing[index] {
        if ctx.tick >= done {
            sim.nav.set_position(agent, end, Vec3::ZERO);
            sim.nav.finish_link(agent);
            sim.world.climbing[index] = None;
        }
        return;
    }
    match sim.nav.status(agent) {
        Some(NavStatus::AtLink) => {
            let link = sim.nav.take_link(agent).expect("the link it reached");
            sim.world.climbing[index] = Some((link.end, ctx.tick + CLIMB_TICKS));
        }
        Some(NavStatus::Arrived | NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle) => {
            // `random_point` in a tick draws from `ctx.rng`.
            let target = random_target(&sim.nav, &mut &ctx.rng);
            sim.nav.move_to(agent, target);
        }
        _ => {
            let velocity = sim.nav.desired_velocity(agent);
            let position = sim.nav.position(agent).unwrap_or_default() + velocity * ctx.dt;
            sim.nav.set_position(agent, position, velocity);
        }
    }
}

fn crowd_game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.navigation(walker());
    game.on_reset(|sim, _, rng, _| reset(sim, rng));
    game.on_update(update);
    game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()));
    game
}

/// (tick, checksum, nav probe) every 60 ticks of a seed.
fn trace(runtime: &mut Runtime<World>, seed: u32) -> Vec<(u64, String, serde_json::Value)> {
    runtime.seed(seed);
    let mut out = Vec::new();
    for _ in 0..TICKS {
        runtime.step(FIXED_STEP_MS);
        if runtime.tick().is_multiple_of(60) {
            out.push((runtime.tick(), runtime.checksum(), runtime.probes()["nav"].clone()));
        }
    }
    out
}

#[test]
fn seed_one_twice_and_after_seed_two_gives_equal_checksums_and_probes() {
    let mut runtime = Runtime::new(crowd_game()).expect("installs");
    assert!(runtime.start(), "the runtime runs");
    let first = trace(&mut runtime, 1);
    assert_eq!(first.len(), (TICKS / 60) as usize);
    let last = &first.last().expect("a trace").2;
    assert_eq!(last["agents"], serde_json::json!(AGENTS), "{last}");
    assert_eq!((last["obstacles"].clone(), last["pending"].clone()), (serde_json::json!(1), serde_json::json!(0)), "the crate settled: {last}");
    let digests: std::collections::BTreeSet<String> = first.iter().map(|(_, _, probe)| probe["digest"].to_string()).collect();
    assert!(digests.len() > 5, "the agents moved: {digests:?}");
    assert_eq!(trace(&mut runtime, 1), first, "seed 1 again in the same runtime");
    let other = trace(&mut runtime, 2);
    assert_ne!(other, first, "seed 2 is another crowd");
    assert_eq!(trace(&mut runtime, 1), first, "seed 1 after seed 2 equals a fresh seed 1");
}
