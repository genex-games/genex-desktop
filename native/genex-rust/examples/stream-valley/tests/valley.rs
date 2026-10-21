//! STR-26a: the stream-valley world (new behaviour: the example is new).
//!
//! - the built-in cell pack reads (every listed cell's size and digest checked) and holds what the
//!   C-28 compile of `world/valley.cells.json` placed; every model it names is in the asset table;
//! - a drive along the ring road streams a 5 x 5 sim set (and the hysteresis ring behind it), villages, waystones, hut colliders and
//!   the terrain tiles' colliders, with ground under the anchor;
//! - two runs give equal checksums every 60 ticks and equal final probes, on 1 and on 8 stream
//!   threads (the sim set never depends on the pool);
//! - in release, `--ignored full_loop`: a whole lap of the road (about 15,000 ticks) sees all ten
//!   villages and all 40 waystones.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley --offline --test valley
//!
//! That the committed pack is the compile's own output is `node world/compile.ts --check`.

use std::collections::BTreeSet;
use std::sync::Arc;

use genex::{FIXED_STEP_MS, Runtime, Value};
use genex_render::jobs::Pool;
use stream_valley_game::valley::{ANCHOR_SPEED, KIND_STONE, KIND_TOWER, KIND_VILLAGE, RING_RADIUS, World};
use stream_valley_game::{assets, game, packs};

/// Ticks of the drive rows (30 s: 900 m of road).
const TICKS: u64 = 1800;
/// Ticks between checksums.
const EVERY: u64 = 60;
/// What the C-28 compile of the placement file reports (`node world/compile.ts`).
const PACK_CELLS: usize = 107;
const PACK_THINGS: usize = 51;
const PACK_MODELS: usize = 91;
const PACK_COLLIDERS: usize = 51;
const PACK_INSTANCES: usize = 240;

struct Run {
    checksums: Vec<String>,
    probe: Value,
}

fn drive(threads: usize, ticks: u64) -> Run {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    let pool = if threads == 1 { Pool::inline() } else { Pool::new(threads) };
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(1);
    assert!(runtime.start());
    let mut checksums = Vec::new();
    for tick in 1..=ticks {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            checksums.push(runtime.checksum());
        }
    }
    let probe = runtime.state()["valley"].clone();
    Run { checksums, probe }
}

fn world_of(runtime: &Runtime<World>) -> &World {
    &runtime.sim().world
}

#[test]
fn the_built_in_pack_reads_and_holds_the_compiled_placements() {
    let packs = packs().expect("the built-in pack reads");
    assert_eq!(packs.world.cell_size(), 64);
    assert_eq!(packs.cells.len(), PACK_CELLS);
    let things: usize = packs.cells.values().map(|cell| cell.things.len()).sum();
    let models: usize = packs.cells.values().map(|cell| cell.models.len()).sum();
    let colliders: usize = packs.cells.values().map(|cell| cell.colliders.len()).sum();
    let instances: usize = packs.cells.values().flat_map(|cell| &cell.groups).map(|group| group.instances.len()).sum();
    assert_eq!((things, models, colliders, instances), (PACK_THINGS, PACK_MODELS, PACK_COLLIDERS, PACK_INSTANCES));
    let table: BTreeSet<&str> = assets().iter().map(|(path, _)| *path).collect();
    for cell in packs.cells.values() {
        let named = cell.models.iter().map(|m| m.path.as_str()).chain(cell.groups.iter().map(|g| g.model.as_str()));
        for path in named {
            assert!(table.contains(path), "{path} is in the asset table");
        }
    }
}

#[test]
fn the_drive_streams_villages_waystones_and_colliders() {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.use_stream_pool(Arc::new(Pool::inline()));
    runtime.seed(1);
    assert!(runtime.start());
    for _ in 0..TICKS {
        runtime.step(FIXED_STEP_MS);
    }
    let probe = runtime.state()["valley"].clone();
    println!("valley {probe}");
    let active = probe["active"].as_u64().expect("a count");
    assert!((25..=49).contains(&active), "the 5 x 5 sim set and the hysteresis ring behind it ({active})");
    let world = world_of(&runtime);
    assert!(world.kinds.get(&KIND_VILLAGE).copied().unwrap_or(0) >= 1, "a village entered");
    assert!(world.kinds.get(&KIND_STONE).copied().unwrap_or(0) >= 2, "waystones entered");
    assert_eq!(world.kinds.get(&KIND_TOWER), None, "the tower is 1,190 m away");
    assert!(world.entered >= 25, "cells entered as the anchor drove");
    let colliders = probe["colliders"].as_u64().expect("a count");
    assert!(colliders > 25, "every active tile's collider and the village's huts ({colliders})");
    assert!(!probe["ground"].is_null(), "ground under the anchor");
    let state = runtime.state();
    let stream = &state["__stream"];
    assert_eq!(stream["active"].as_u64(), Some(active), "the runtime key agrees: {stream}");
}

#[test]
fn two_drives_replay_equal_on_one_and_eight_threads() {
    let first = drive(1, TICKS);
    let second = drive(1, TICKS);
    let eight = drive(8, TICKS);
    assert_eq!(first.checksums.len(), (TICKS / EVERY) as usize);
    assert_eq!(first.checksums, second.checksums, "two runs on one thread");
    assert_eq!(first.probe, second.probe);
    assert_eq!(first.checksums, eight.checksums, "one thread against eight");
    assert_eq!(first.probe, eight.probe);
    println!("checksum at {TICKS}: {}", first.checksums.last().expect("checksums"));
}

#[test]
#[ignore = "a whole lap: run in release with --ignored full_loop"]
fn full_loop_sees_every_village_and_waystone() {
    let lap_seconds = std::f32::consts::TAU * RING_RADIUS / ANCHOR_SPEED;
    let ticks = (lap_seconds * 1000.0 / FIXED_STEP_MS as f32) as u64 + 120;
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.use_stream_pool(Arc::new(Pool::new(8)));
    runtime.seed(1);
    assert!(runtime.start());
    for _ in 0..ticks {
        runtime.step(FIXED_STEP_MS);
    }
    let world = world_of(&runtime);
    println!("lap of {ticks} ticks: {} cells entered, kinds {:?}, checksum {}", world.entered, world.kinds, runtime.checksum());
    assert_eq!(world.villages.len(), 10, "all ten villages");
    assert!(world.kinds.get(&KIND_STONE).copied().unwrap_or(0) >= 40, "all 40 waystones");
}
