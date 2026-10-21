//! NAV-17: the nav-crowd scene's probes over 3,600 ticks (new behaviour: the example is new).
//!
//! - no agent is stuck (NAV-13's stall rule: 120 ticks in a row wanting to move above 0.5 m/s and
//!   moving under 1 mm, or off the mesh) and every agent arrives at least 5 times;
//! - links are crossed (ladder and drop), the door shut and opened;
//! - the crate is carved in at tick 600 (its collider once its spot is clear), its tiles
//!   rebuild, the nav settles (no rebuild pending) and stays settled, and 1 tick after it settles no
//!   agent heads for a corner inside the crate;
//! - two runs give equal checksums every 60 ticks, and the parity record (checksums and the final
//!   totals) is byte-identical; with `GENEX_NAV_PARITY_OUT` it is written for the cross-target
//!   comparison (`parity.sh`).
//!
//! Run in release (200 capsules for 3,600 ticks):
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p nav-crowd --release --offline --test crowd

use genex::{FIXED_STEP_MS, Runtime};
use nav_crowd_game::{AGENTS, CRATE_TICK, CrowdTotals, STALL_TICKS, World, game};

/// Ticks the rows run (a minute of play).
const TICKS: u64 = 3600;
/// Ticks between checksums.
const EVERY: u64 = 60;
/// Arrivals every agent makes at least.
const ARRIVALS_MIN: u32 = 5;
/// The crate's collider may wait this long after [`CRATE_TICK`] for its spot to clear.
const CRATE_WAIT_MAX: u64 = 120;

struct Run {
    checksums: Vec<String>,
    totals: CrowdTotals,
    /// Ticks after the crate settled on which a rebuild was pending again.
    unsettled_after: u32,
    final_probe: String,
}

fn run() -> Run {
    let mut runtime = Runtime::new(game()).expect("installs");
    assert!(runtime.start());
    runtime.seed(1);
    let mut checksums = Vec::new();
    let mut unsettled_after = 0;
    for tick in 1..=TICKS {
        runtime.step(FIXED_STEP_MS);
        let sim = runtime.sim();
        if sim.world.totals().settled_tick.is_some_and(|settled| tick > settled) && sim.nav.pending_rebuilds() > 0 {
            unsettled_after += 1;
        }
        if tick % EVERY == 0 {
            checksums.push(runtime.checksum());
        }
    }
    let world: &World = &runtime.sim().world;
    let final_probe = genex::json!({ "nav": genex::Value::from(&runtime.sim().nav.probe()) }).to_string();
    Run { checksums, totals: world.totals(), unsettled_after, final_probe }
}

#[test]
fn a_minute_of_the_crowd_has_no_stuck_agent_and_every_agent_arrives_five_times() {
    let run = run();
    let t = run.totals;
    println!("totals {t:?}");
    println!("final {}", run.final_probe);
    assert_eq!(t.stuck, 0, "no agent stalls {STALL_TICKS} ticks (longest {})", t.longest_stall);
    assert!(t.arrivals_min >= ARRIVALS_MIN, "every agent arrives {ARRIVALS_MIN} times (fewest {}, all {})", t.arrivals_min, t.arrivals_total);
    assert!(t.links_taken > 0, "agents take the ladder and the drop");
    assert!(t.doors_shut >= 2, "the east gate's door shut every other period ({} times)", t.doors_shut);
    assert_eq!(t.crate_tick, Some(CRATE_TICK), "the crate is carved in at tick {CRATE_TICK}");
    let solid = t.crate_solid_tick.expect("the crate's collider went in");
    assert!(solid <= CRATE_TICK + CRATE_WAIT_MAX, "the crate's collider went in at {solid}");
    assert!(t.pending_peak > 0, "the crate rebuilt tiles");
    let settled = t.settled_tick.expect("the nav settled after the crate");
    println!("crate carved at {CRATE_TICK}, solid at {solid}, pending peak {}, settled at {settled}", t.pending_peak);
    assert_eq!(run.unsettled_after, 0, "no rebuild pends after the nav settled");
    assert_eq!(t.corners_in_crate, Some(0), "1 tick after it settled no agent heads into the crate");
    assert_eq!(AGENTS, 200);
}

#[test]
fn two_runs_give_equal_checksums_and_a_byte_identical_parity_record() {
    let record = |run: &Run| {
        let t = run.totals;
        genex::json!({
            "format": "genex-nav-crowd-parity/1",
            "checksums": run.checksums,
            "arrivals": t.arrivals_total,
            "longestStall": t.longest_stall,
            "links": t.links_taken,
            "crateTick": t.crate_tick,
            "settledTick": t.settled_tick,
            "final": run.final_probe,
        })
        .to_string()
    };
    let (first, second) = (run(), run());
    assert_eq!(first.checksums, second.checksums, "two runs, equal checksums every {EVERY} ticks");
    let bytes = record(&first);
    assert_eq!(bytes, record(&second), "the parity record is byte-identical");
    println!("parity digest {:016x}", fnv(bytes.as_bytes()));
    if let Some(path) = std::env::var_os("GENEX_NAV_PARITY_OUT") {
        std::fs::write(path, &bytes).expect("the parity record writes");
    }
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3))
}
