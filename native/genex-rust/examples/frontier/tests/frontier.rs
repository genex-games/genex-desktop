//! EP-X1: the frontier's rows (new behaviour: the example is new; red side: the base tree has no
//! `examples/frontier`, so `cargo build -p frontier` fails there). Over the 120 s ride
//! ([`RIDE_TICKS`]) the rider leaves the town, the town's cells stream out with their colliders and
//! offline nav islands, and stream back in when it returns.
//!
//! - two runs, a 1-worker and an 8-worker stream pool and the inline pool (the web's) give equal
//!   checksums every 60 ticks and equal probes at the end; with `GENEX_FRONTIER_PARITY_OUT` the
//!   checksums and final probes are written for the web headless comparison;
//! - agents whose cell streams out go `off-mesh` and freeze (neither agent nor capsule moves), and
//!   walk on when it streams back (owner call X1);
//! - the 20 agents follow the documented loop with root motion, the climber crosses the ladder
//!   link playing `Climb` only between `take_link` and `finish_link`, and the door swings;
//! - a static-world save at tick 3,000, restored into a run with another history at that tick,
//!   replays the saved run's checksums to the end.
//!
//! Run in release:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p frontier --release --offline --test frontier

use std::sync::Arc;

use frontier_game::{AGENTS, RIDE_TICKS, Saved, Totals, World, assets, game, game_salted, restore, save};
use genex::{FIXED_STEP_MS, Game, Runtime};
use genex_render::jobs::Pool;

/// Ticks between checksums.
const EVERY: u64 = 60;
/// The ride plus a few seconds in the town after it.
const TICKS: u64 = RIDE_TICKS + 600;
/// The tick the save row saves and restores at.
const SAVE_AT: u64 = 3000;

struct Run {
    checksums: Vec<(u64, String)>,
    totals: Totals,
    probes: String,
}

fn runtime(game: Game<World>, pool: Pool) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game, Box::new(assets())).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    assert!(runtime.start());
    runtime.seed(1);
    runtime
}

fn finish(mut runtime: Runtime<World>, from: u64, mut checksums: Vec<(u64, String)>) -> Run {
    for tick in from..=TICKS {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            checksums.push((tick, runtime.checksum()));
        }
    }
    let world: &World = &runtime.sim().world;
    Run { checksums, totals: world.totals(), probes: genex::Value::Object(runtime.probes()).to_string() }
}

fn run(pool: Pool) -> Run {
    finish(runtime(game(), pool), 1, Vec::new())
}

#[test]
fn two_runs_and_1_8_and_inline_workers_give_equal_checksums() {
    let first = run(Pool::new(8));
    let second = run(Pool::new(8));
    let one = run(Pool::new(1));
    let inline = run(Pool::inline());
    println!("totals {:?}", first.totals);
    println!("probes {}", first.probes);
    println!("final checksum {:?}", first.checksums.last().expect("checksums"));
    assert_eq!(first.checksums, second.checksums, "two runs, equal checksums every {EVERY} ticks");
    assert_eq!(first.checksums, one.checksums, "8 workers vs 1");
    assert_eq!(first.checksums, inline.checksums, "workers vs inline (the web's pool)");
    assert_eq!(first.probes, one.probes);
    assert_eq!(first.probes, inline.probes);
    if let Some(path) = std::env::var_os("GENEX_FRONTIER_PARITY_OUT") {
        let sums: Vec<&str> = first.checksums.iter().map(|(_, sum)| sum.as_str()).collect();
        let record = genex::json!({ "format": "genex-frontier-parity/1", "every": EVERY, "checksums": sums, "probes": first.probes });
        std::fs::write(path, record.to_string()).expect("the parity record writes");
    }
}

#[test]
fn agents_freeze_off_mesh_when_the_town_streams_out_and_walk_on_when_it_returns() {
    let t = run(Pool::new(8)).totals;
    println!("totals {t:?}");
    assert_eq!(t.agents, AGENTS);
    assert!(t.islands_left > 0 && t.islands_entered > t.islands_left, "islands streamed out and in ({} in, {} out)", t.islands_entered, t.islands_left);
    assert!(t.freezes >= AGENTS as u32, "every agent froze when the town streamed out ({})", t.freezes);
    assert_eq!(t.freeze_breaks, 0, "a frozen agent stays off the mesh and nothing of it moves ({} frozen ticks)", t.frozen_ticks);
    assert_eq!(t.resumes, t.freezes, "every frozen agent walked on when the town came back");
    assert!(t.arrivals_after_resume > 0, "agents arrive at spots again after the resume");
}

#[test]
fn agents_walk_by_root_motion_the_climber_takes_the_ladder_and_the_door_swings() {
    let t = run(Pool::new(8)).totals;
    println!("totals {t:?}");
    assert!(t.rooted > 100.0, "the walk's and run's root motion moved the agents ({:.1} m)", t.rooted);
    assert!(t.arrivals > AGENTS as u32, "agents arrive at their spots ({})", t.arrivals);
    assert!(t.taken >= 2 && t.finished >= 2, "the climber went up and down the ladder (taken {}, finished {})", t.taken, t.finished);
    assert_eq!(t.climbing_outside, 0, "Climb plays only on the ladder");
    assert!(t.climbing_ticks * 10 >= t.crossing_ticks * 7, "Climb plays through most of each crossing ({} of {})", t.climbing_ticks, t.crossing_ticks);
    assert!(t.door_opens > 0, "the door swung open for an agent");
    assert_eq!((t.huts, t.towers), (12, 2), "the town's huts and tower entered twice (out and back)");
    assert!(t.stones >= 9, "the road's waystones entered ({})", t.stones);
}

#[test]
fn a_static_world_save_at_tick_3000_restores_into_another_history_and_replays_equal() {
    let mut saved_run = runtime(game(), Pool::new(8));
    for _ in 1..=SAVE_AT {
        saved_run.step(FIXED_STEP_MS);
    }
    let saved: Saved = save(saved_run.sim());
    let saved_digest = saved_run.sim().world.agents_digest();
    let before = finish(saved_run, SAVE_AT + 1, Vec::new());
    // Another history: the agents picked other spots for 3,000 ticks.
    let mut other = runtime(game_salted(5), Pool::new(8));
    for _ in 1..=SAVE_AT {
        other.step(FIXED_STEP_MS);
    }
    let diverged = other.sim().world.agents_digest() != saved_digest;
    restore(other.sim_mut(), &saved).expect("the save restores");
    let after = finish(other, SAVE_AT + 1, Vec::new());
    println!("diverged before the restore: {diverged}; final {:?}", before.checksums.last());
    assert!(diverged, "the other history differs before the restore (the row can fail)");
    assert_eq!(before.checksums, after.checksums, "the restored run replays the saved run's checksums");
    assert_eq!(before.probes, after.probes);
}
