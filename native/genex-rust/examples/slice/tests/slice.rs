//! EP-V1: the vertical slice's rows (new behaviour: the example is new). Over [`TICKS`] the walker
//! walks to the far end and back, the anchor follows it, and the cells behind it stream out and
//! back in with their colliders and nav islands.
//!
//! - two runs, a 1-worker and an 8-worker stream pool and the inline pool (the web's) give equal
//!   checksums every 60 ticks, and equal probes at the end;
//! - villagers whose cell streams out go `off-mesh` and freeze (neither their agent nor their
//!   capsule moves while frozen), and walk on when it streams back (every freeze resumes, and they
//!   arrive at spots again after it);
//! - with `GENEX_SLICE_PARITY_OUT`, the checksums and final probes are written for the web
//!   headless comparison;
//! - the walker follows the documented loop with root motion: it reaches the far end and gets
//!   home, and its clip moved it.
//!
//! Run in release:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p slice --release --offline --test slice

use std::sync::Arc;

use genex::{FIXED_STEP_MS, Runtime};
use genex_render::jobs::Pool;
use slice_game::{ASSETS, SliceTotals, World, game};

/// Ticks the rows run (80 s of play: the walk out and back takes about a minute).
const TICKS: u64 = 4800;
/// Ticks between checksums.
const EVERY: u64 = 60;

struct Run {
    checksums: Vec<String>,
    totals: SliceTotals,
    probes: String,
}

fn run(pool: Pool) -> Run {
    let mut runtime = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    assert!(runtime.start());
    runtime.seed(1);
    let mut checksums = Vec::new();
    for tick in 1..=TICKS {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            checksums.push(runtime.checksum());
        }
    }
    let world: &World = &runtime.sim().world;
    Run { checksums, totals: world.totals(), probes: genex::Value::Object(runtime.probes()).to_string() }
}

#[test]
fn two_runs_and_1_8_and_inline_workers_give_equal_checksums() {
    let first = run(Pool::new(8));
    let second = run(Pool::new(8));
    let one = run(Pool::new(1));
    let inline = run(Pool::inline());
    println!("totals {:?}", first.totals);
    println!("probes {}", first.probes);
    println!("final checksum {}", first.checksums.last().expect("checksums"));
    assert_eq!(first.checksums, second.checksums, "two runs, equal checksums every {EVERY} ticks");
    assert_eq!(first.checksums, one.checksums, "8 workers vs 1");
    assert_eq!(first.checksums, inline.checksums, "workers vs inline (the web's pool)");
    assert_eq!(first.probes, one.probes);
    assert_eq!(first.probes, inline.probes);
    // The cross-target record (the web headless run compares its own against it).
    if let Some(path) = std::env::var_os("GENEX_SLICE_PARITY_OUT") {
        let record = genex::json!({ "format": "genex-slice-parity/1", "every": EVERY, "checksums": first.checksums, "probes": first.probes });
        std::fs::write(path, record.to_string()).expect("the parity record writes");
    }
}

#[test]
fn villagers_freeze_off_mesh_when_their_cell_streams_out_and_walk_on_when_it_returns() {
    let t = run(Pool::new(8)).totals;
    println!("totals {t:?}");
    assert_eq!(t.sim_misses, 0, "the 3 x 3 cells round the anchor are simulated on every tick");
    assert!((9..=15).contains(&t.active_peak), "3 x 3 cells simulated, and up to a row more that hysteresis keeps ({})", t.active_peak);
    assert!(t.islands_left > 0 && t.islands_entered > t.islands_left, "islands streamed out and in ({} in, {} out)", t.islands_entered, t.islands_left);
    assert!(t.freezes > 0, "villagers' cells streamed out under them");
    assert_eq!(t.freeze_breaks, 0, "a frozen villager stays off the mesh and nothing of it moves ({} frozen ticks)", t.frozen_ticks);
    assert_eq!(t.resumes, t.freezes, "every frozen villager walked on when its cell came back");
    assert!(t.arrivals_after_resume > 0, "villagers arrive at spots again after the resume");
}

#[test]
fn the_nav_driven_walker_goes_out_and_home_with_root_motion() {
    let t = run(Pool::new(8)).totals;
    let far = t.far_tick.expect("the walker reached the far end");
    let home = t.home_tick.expect("the walker got home");
    println!("far at {far}, home at {home}, clip moved it {:.2} m", t.rooted);
    assert!(home > far);
    assert!(t.rooted > 10.0, "the walk's root motion moved the walker ({:.2} m)", t.rooted);
}
