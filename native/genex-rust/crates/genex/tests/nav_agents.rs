//! NAV-12 through the facade: agents in `sim.nav` walk a corridor game by game rules (the game
//! moves them by `desired_velocity` and reports back with `set_position`), the probe counts them
//! by status, and a snapshot restored mid-game (through JSON text) leaves every later checksum
//! equal to the run that never restored.
//!
//! New behaviour (section 0 of the game systems plan). The agent types come from genex-nav
//! directly until the facade's `nav` module re-exports them.

use genex::nav::{NavArea, NavConfig, NavInput, NavMesh};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime};
use genex_nav::AgentId;
use genex_nav::agents_api::{NavAgent, NavStatus};
use serde_json::json;

const WALKERS: usize = 4;

#[derive(Default)]
struct World {
    agents: Vec<AgentId>,
    restore_at: Option<u64>,
}

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A corridor 24 m by 3 m; agents walk single file from its west end to its east end.
fn corridor_game(restore_at: Option<u64>) -> Game<World> {
    let mut game = Game::new(World { agents: Vec::new(), restore_at });
    game.navigation(walker());
    game.on_reset(|sim, _, _, _| {
        let vertices = [vec3(0.0, 0.0, 0.0), vec3(24.0, 0.0, 0.0), vec3(24.0, 0.0, 3.0), vec3(0.0, 0.0, 3.0)];
        let input = NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the corridor");
        sim.nav.add_mesh(&NavMesh::bake(&input, &walker()).expect("the mesh")).expect("the tiles");
        sim.world.agents.clear();
        for index in 0..WALKERS {
            // Single file: each walks from its own start to its own end, 1 m behind the next.
            let lane = index as f32 * 1.2;
            let agent = sim.nav.add_agent(NavAgent::new(vec3(1.0 + lane, 0.0, 1.5)).with_reach(0.5)).expect("an agent");
            sim.nav.move_to(agent, vec3(18.0 + lane, 0.0, 1.5));
            sim.world.agents.push(agent);
        }
    });
    game.on_update(|sim, ctx| {
        if sim.world.restore_at == Some(ctx.tick) {
            let text = sim.nav.snapshot().dump();
            let snapshot = genex_core::json::parse(&text).expect("the snapshot reads back");
            sim.nav.restore(&snapshot).expect("restores onto its own nav");
        }
        sim.nav.update(ctx.dt);
        for agent in sim.world.agents.clone() {
            let velocity = sim.nav.desired_velocity(agent);
            let position = sim.nav.position(agent).unwrap_or_default() + velocity * ctx.dt;
            sim.nav.set_position(agent, position, velocity);
        }
    });
    game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()));
    game
}

fn checksums(restore_at: Option<u64>) -> (Vec<String>, serde_json::Value) {
    let mut runtime = Runtime::new(corridor_game(restore_at)).expect("installs");
    assert!(runtime.start());
    runtime.seed(1);
    let mut out = Vec::new();
    for _ in 0..900 {
        runtime.step(FIXED_STEP_MS);
        out.push(runtime.checksum());
    }
    let agents = runtime.sim().world.agents.clone();
    for agent in agents {
        assert_eq!(runtime.sim().nav.status(agent), Some(NavStatus::Arrived), "{agent:?} at {:?}", runtime.sim().nav.position(agent));
    }
    (out, runtime.probes()["nav"].clone())
}

#[test]
fn agents_walk_the_corridor_and_the_probe_counts_them_arrived() {
    let (_, probe) = checksums(None);
    assert_eq!(probe["agents"], json!(WALKERS));
    assert_eq!(probe["status"], json!({ "arrived": WALKERS }), "{probe}");
    assert_eq!(probe["tiles"], json!(3));
}

#[test]
fn a_snapshot_restored_mid_walk_leaves_every_checksum_equal() {
    let (plain, _) = checksums(None);
    let (restored, _) = checksums(Some(120));
    assert_eq!(restored, plain, "restore at tick 120 changes nothing later");
}

#[test]
fn moving_and_walking_statuses_show_in_the_probe_mid_walk() {
    let mut runtime = Runtime::new(corridor_game(None)).expect("installs");
    assert!(runtime.start());
    runtime.seed(1);
    for _ in 0..60 {
        runtime.step(FIXED_STEP_MS);
    }
    let probe = runtime.probes()["nav"].clone();
    assert_eq!(probe["status"], json!({ "moving": WALKERS }), "{probe}");
    let first = runtime.sim().world.agents[0];
    let corner = runtime.sim().nav.next_corner(first).expect("a corner ahead");
    assert!(corner.x > runtime.sim().nav.position(first).expect("an agent").x, "{corner}");
}
