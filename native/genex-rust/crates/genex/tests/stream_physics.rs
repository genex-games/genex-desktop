//! STR-10: streamed colliders through the commit slot. A cell builder carries genex-stream's
//! colliders as a cell part, and a `StreamCommit` hook inserts them when the cell enters (cells
//! ascending, build order) and removes them when it leaves (cells descending, reverse build
//! order), keeping its ledger in facet state so a reseed starts it fresh with the physics world.
//! An anchor walk then gives the same `ColliderHandle`s and the same Rapier collider set (its
//! serde form, hashed into a probe and so into the checksum) with 1 or 8 workers, inline builds
//! and scrambled completion.
//!
//! `game.stream_colliders()` is that hook in the facade: a builder adds `CellColliders` as a part
//! and the runtime streams them the same way.
//!
//! Every row is new behaviour (section 0 of the game systems plan). A game built without physics
//! has no colliders to stream: this file, like genex-stream's `physics` module, is not compiled.

#![cfg(feature = "physics-raw")]

use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

use genex::physics::{ColliderBuilder, RigidBodyBuilder, RigidBodyHandle, Vector};
use genex::prelude::*;
use genex::{
    CellBuild, CellColliders, CellId, CellInputs, CellPart, EnteredCell, FIXED_STEP_MS, Runtime, STREAM_CELL_COLLIDERS_MAX, Sim, StreamColliders,
    StreamCommit, StreamErrorCode, Streaming,
};
use genex_core::digest::{fnv1a64, hex64};
use genex_render::jobs::Pool;
use serde_json::json;

const CELL: f32 = 32.0;
/// Cells the anchor walks out along x before it walks back.
const WALK_CELLS: u64 = 20;
/// Ticks the anchor stays in each cell.
const TICKS_PER_CELL: u64 = 3;
/// Ticks of a whole walk, out and back, plus a few to settle.
const WALK_TICKS: u64 = (2 * WALK_CELLS + 1) * TICKS_PER_CELL + 4;

/// genex-stream's colliders carried as a cell part (they count toward the cell's collider cap).
struct Colliders(CellColliders);

impl CellPart for Colliders {
    fn colliders(&self) -> u32 {
        self.0.len() as u32
    }
}

/// The commit hook that streams the colliders; `inverted` removes in build order, the wrong order.
struct ColliderCommit {
    inverted: bool,
}

impl StreamCommit<World> for ColliderCommit {
    fn leave(&self, sim: &mut Sim<World>, cell: CellId) {
        let ledger = sim.facets.get_mut::<StreamColliders>();
        if self.inverted {
            ledger.leave_in_build_order(&mut sim.physics, cell);
        } else {
            ledger.leave(&mut sim.physics, cell);
        }
    }

    fn enter(&self, sim: &mut Sim<World>, cell: &EnteredCell) {
        let colliders = cell.parts::<Colliders>().flat_map(|part| part.0.iter());
        sim.facets.get_mut::<StreamColliders>().enter(&mut sim.physics, cell.cell(), colliders);
    }
}

/// One cell the commit entered: the tick, the cell and its colliders' handles.
type Heard = (u64, CellId, Vec<(u32, u32)>);

#[derive(Default)]
struct World {
    heard: Vec<Heard>,
    ball: Option<RigidBodyHandle>,
}

/// A cell's colliders from the seed and the cell alone: a ground slab and seeded boxes and balls,
/// carried in this file's own part for its own hook.
fn cell_colliders(cell: CellId, inputs: &CellInputs) -> CellBuild<u32> {
    let (thing, colliders) = cell_parts(cell, inputs);
    CellBuild::default().thing(thing).part(Colliders(colliders))
}

/// The same colliders as `CellColliders`, the part `game.stream_colliders()` streams.
fn cell_colliders_part(cell: CellId, inputs: &CellInputs) -> CellBuild<u32> {
    let (thing, colliders) = cell_parts(cell, inputs);
    CellBuild::default().thing(thing).part(colliders)
}

/// A cell's thing and its colliders.
fn cell_parts(cell: CellId, inputs: &CellInputs) -> (u32, CellColliders) {
    let mut rng = inputs.rng();
    let (min, _) = inputs.bounds();
    let half = CELL * 0.5;
    let slab = ColliderBuilder::cuboid(half, 0.5, half).translation(Vector::new(min.x + half, -0.5, min.y + half));
    let mut colliders = CellColliders::new().with(slab);
    let count = 2 + rng.below(5);
    for i in 0..count {
        let at = Vector::new(min.x + rng.range_f32(1.0, CELL - 1.0), rng.range_f32(0.2, 2.0), min.y + rng.range_f32(1.0, CELL - 1.0));
        let collider = if i % 2 == 0 {
            ColliderBuilder::cuboid(0.5, rng.range_f32(0.2, 1.5), 0.5)
        } else {
            ColliderBuilder::ball(rng.range_f32(0.2, 0.8))
        };
        colliders.push(collider.translation(at));
    }
    (count + (cell.x + cell.z).unsigned_abs(), colliders)
}

/// The anchor's cell along x at `tick`: 20 cells out, then back.
fn walk_x(tick: u64) -> f32 {
    let step = (tick / TICKS_PER_CELL).min(2 * WALK_CELLS);
    let cell = if step <= WALK_CELLS { step } else { 2 * WALK_CELLS - step };
    cell as f32 * CELL + 10.0
}

/// The FNV-1a 64 of Rapier's collider set in its serde form: the arena with its free slots.
fn collider_set_hash(sim: &Sim<World>) -> serde_json::Value {
    let bytes = serde_json::to_vec(&sim.physics.colliders).expect("the collider set serializes");
    json!(hex64(fnv1a64(&bytes)))
}

fn walking_game(inverted: bool) -> Game<World> {
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1));
    game.cell_content(cell_colliders);
    game.facet_state::<StreamColliders>();
    game.stream_commit(ColliderCommit { inverted });
    walk(&mut game);
    game
}

/// The walk through the facade's own commit hook.
fn facade_walking_game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1));
    game.cell_content(cell_colliders_part);
    game.stream_colliders();
    walk(&mut game);
    game
}

/// The anchor walk, the ball, what the commit entered each tick, and the probes.
fn walk(game: &mut Game<World>) {
    game.on_reset(|sim, _, _, _| {
        sim.stream.set_anchor("player", vec3(walk_x(0), 0.0, 10.0)).expect("anchor");
        let ball = RigidBodyBuilder::dynamic().translation(Vector::new(10.0, 3.0, 10.0)).linvel(Vector::new(6.0, 0.0, 0.0));
        let (body, _) = sim.physics.insert(ball, ColliderBuilder::ball(0.5));
        sim.world.ball = Some(body);
    });
    game.on_update(|sim, ctx| {
        let ledger = sim.facets.get::<StreamColliders>();
        let heard: Vec<Heard> = sim
            .stream
            .entered()
            .iter()
            .map(|entered| (ctx.tick, entered.cell(), ledger.handles(entered.cell()).iter().map(|handle| handle.into_raw_parts()).collect()))
            .collect();
        sim.world.heard.extend(heard);
        sim.stream.set_anchor("player", vec3(walk_x(ctx.tick + 1), 0.0, 10.0)).expect("anchor");
    });
    game.probe("colliders", collider_set_hash);
    game.probe("streamed", |sim| json!(hex64(sim.facets.get::<StreamColliders>().digest(&sim.physics))));
    game.probe("ball", |sim| {
        let at = sim.world.ball.map(|ball| sim.physics.bodies[ball].translation());
        json!(at.map(|at| [at.x.to_bits(), at.y.to_bits(), at.z.to_bits()]))
    });
}

fn run(game: Game<World>, pool: Pool, seed: u32) -> Runtime<World> {
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(seed);
    runtime.step(FIXED_STEP_MS * WALK_TICKS as f64);
    runtime
}

/// `state()` without `volatile` (stalls and held time are display state).
fn sim_state(runtime: &Runtime<World>) -> serde_json::Value {
    let mut state = runtime.state();
    state.as_object_mut().expect("object").remove("volatile");
    state
}

#[test]
fn the_walk_streams_every_active_cells_colliders_in_and_no_other() {
    // New behaviour.
    let runtime = run(walking_game(false), Pool::new(2), 7);
    let sim = runtime.sim();
    let ledger = sim.facets.get::<StreamColliders>();
    let active: Vec<CellId> = sim.stream.active().collect();
    assert_eq!(ledger.cells().collect::<Vec<_>>(), active, "every active cell's colliders are in, no other");
    assert_eq!(sim.physics.colliders.len(), ledger.len() + 1, "the streamed colliders and the ball's");
    let entered = sim.world.heard.len();
    assert!(entered > 3 * WALK_CELLS as usize, "{entered} cell entries over the walk");
    assert!(sim.world.heard.iter().all(|(_, _, handles)| handles.len() >= 3), "each cell inserted its slab and boxes");
    let reused = sim.world.heard.iter().flat_map(|(_, _, handles)| handles.iter()).any(|(_, generation)| *generation > 0);
    assert!(reused, "cells that left freed slots the walk back reused");
}

// Native only: worker threads and a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn an_anchor_walk_across_20_cells_and_back_gives_equal_handles_and_collider_set_with_shuffled_completion() {
    // New behaviour.
    let scrambled = || {
        let mut game = walking_game(false);
        // A second builder that sleeps by cell, so builds finish in a scrambled order.
        game.cell_content(|cell: CellId, _: &CellInputs| {
            let micros = (cell.x.unsigned_abs() * 37 + cell.z.unsigned_abs() * 101) % 1500;
            std::thread::sleep(Duration::from_micros(u64::from(micros)));
            CellBuild::<&'static str>::default().thing("rock")
        });
        game
    };
    let one = run(walking_game(false), Pool::new(1), 7);
    let eight = run(scrambled(), Pool::new(8), 7);
    let inline = run(walking_game(false), Pool::inline(), 7);
    assert_eq!(one.sim().world.heard, eight.sim().world.heard, "handles: 1 vs 8 workers, scrambled completion");
    assert_eq!(one.sim().world.heard, inline.sim().world.heard, "handles: threads vs inline (the web's pool)");
    let probes = |runtime: &Runtime<World>| {
        let state = sim_state(runtime);
        (state["colliders"].clone(), state["streamed"].clone(), state["ball"].clone())
    };
    assert_eq!(probes(&one), probes(&eight), "the Rapier collider set, the ledger and the ball");
    assert_eq!(probes(&one), probes(&inline));
    assert_eq!(one.checksum(), inline.checksum());
}

#[test]
fn game_stream_colliders_streams_cell_colliders_parts_as_the_hand_written_hook_does() {
    // New behaviour: the facade's hook and part.
    let hand_written = run(walking_game(false), Pool::inline(), 7);
    let facade = run(facade_walking_game(), Pool::inline(), 7);
    assert!(!facade.sim().world.heard.is_empty(), "the facade's hook entered cells");
    assert_eq!(hand_written.sim().world.heard, facade.sim().world.heard, "the same handles, cell by cell");
    assert_eq!(sim_state(&hand_written), sim_state(&facade), "the collider set, the ledger and the ball");
    assert_eq!(hand_written.checksum(), facade.checksum());
}

#[test]
fn an_inverted_removal_order_changes_the_collider_set_and_the_checksum() {
    // New behaviour: proves the walk row can fail.
    let canonical = run(walking_game(false), Pool::inline(), 7);
    let inverted = run(walking_game(true), Pool::inline(), 7);
    assert_ne!(canonical.sim().world.heard, inverted.sim().world.heard, "later cells take other slots");
    assert_ne!(sim_state(&canonical)["colliders"], sim_state(&inverted)["colliders"]);
    assert_ne!(canonical.checksum(), inverted.checksum());
}

#[test]
fn seed_2_then_seed_1_rebuilds_the_same_colliders() {
    // New behaviour: the ledger is facet state, so a reseed starts it fresh with the physics world.
    let fresh = run(walking_game(false), Pool::inline(), 1);
    let mut reseeded = run(walking_game(false), Pool::inline(), 2);
    assert_ne!(sim_state(&fresh)["colliders"], sim_state(&reseeded)["colliders"], "the seed reaches the builders");
    reseeded.seed(1);
    reseeded.step(FIXED_STEP_MS * WALK_TICKS as f64);
    assert_eq!(fresh.sim().world.heard, reseeded.sim().world.heard);
    assert_eq!(sim_state(&fresh), sim_state(&reseeded));
    assert_eq!(fresh.checksum(), reseeded.checksum());
}

#[test]
fn a_cell_over_the_collider_cap_enters_empty_and_inserts_nothing() {
    // New behaviour: the cap STR-9 checks counts the real colliders.
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(0).hysteresis(0));
    game.cell_content(|_: CellId, _: &CellInputs| {
        let ball = |i: u32| ColliderBuilder::ball(0.5).translation(Vector::new(i as f32, 0.0, 0.0));
        let colliders = (0..=STREAM_CELL_COLLIDERS_MAX).fold(CellColliders::new(), |colliders, i| colliders.with(ball(i)));
        CellBuild::<u32>::default().part(Colliders(colliders))
    });
    game.facet_state::<StreamColliders>();
    game.stream_commit(ColliderCommit { inverted: false });
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(10.0, 0.0, 10.0)).expect("anchor"));
    let runtime = run(game, Pool::inline(), 3);
    assert_eq!(runtime.sim().physics.colliders.len(), 0, "nothing of the refused cell was inserted");
    let state = runtime.state();
    assert_eq!(state["volatile"]["__stream"]["refused"][0]["code"], json!(StreamErrorCode::Invalid.wire()), "{}", state["volatile"]);
}
