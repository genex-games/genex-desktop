//! STR-28: the streamed simulation state has one checksum on every destination. A 3000-tick anchor
//! walk loops over a field of 16 m cells; each cell streams in its static colliders (a ground slab
//! and seeded boxes and balls, through `game.stream_colliders()`) and its offline nav island (real
//! genex-nav tiles, through a `StreamCommit` over `StreamedNav`), and six nav agents walk to
//! targets the tick rng draws on whatever islands are in, freezing where their cells stream out. A
//! ball rolls over the streamed slabs.
//!
//! Every 300 ticks the runtime's checksum is taken; the ten are pinned here as one digest
//! ([`PINNED_WALK`]). Whatever target runs this file must reach it:
//!
//! - aarch64 macOS with 1 and 8 workers and with inline builds (the web's pool);
//! - x86_64 macOS under Rosetta (`--target x86_64-apple-darwin`);
//! - wasm32 in the headless libtest runner, inline;
//! - Linux, Windows, iOS and Android on their own runners (named at the gates, not claimed here).
//!
//! Owner determinism rule 4: `seed(2)` then `seed(1)` replays a fresh `seed(1)` checkpoint for
//! checkpoint.
//!
//! Every row is new behaviour (section 0 of the game systems plan). A game built without physics
//! has no colliders to stream: this file is not compiled then.

#![cfg(feature = "physics-raw")]

use std::collections::BTreeMap;
use std::sync::Arc;

use genex::nav::{NavArea, NavConfig, NavInput};
use genex::physics::{ColliderBuilder, RigidBodyBuilder, RigidBodyHandle, Vector};
use genex::prelude::*;
use genex::{CellBuild, CellColliders, CellId, CellInputs, CellPart, EnteredCell, FIXED_STEP_MS, Runtime, StreamColliders, StreamCommit, Streaming};
use genex_core::digest::{fnv1a64, hex64};
use genex_nav::AgentId;
use genex_nav::agents_api::{NavAgent, NavStatus};
use genex_nav::filter::NavFilter;
use genex_nav::stream::{NavIsland, NavIslands, StreamedNav};
use genex_render::jobs::Pool;
use genex_stream::nav::commit;
use serde_json::json;

/// The cell size, metres.
const CELL: f32 = 16.0;
/// Cells of ground (and nav) along x and z; the walk also reaches a cell past each edge.
const GROUND_CELLS_X: i32 = 10;
const GROUND_CELLS_Z: i32 = 3;
/// Ticks of the walk.
const WALK_TICKS: u64 = 3000;
/// Ticks between two checkpoints of the checksum.
const CHECKPOINT_TICKS: u64 = 300;
/// Ticks of one lap along x (out and back) and of one sweep across z.
const LAP_X_TICKS: u64 = 1200;
const LAP_Z_TICKS: u64 = 700;
/// Nav agents the walk spawns once the first islands are in.
const AGENTS: usize = 6;
/// How far from the anchor an agent's next target is drawn, metres.
const TARGET_RADIUS: f32 = 20.0;
/// The seed of the pinned walk.
const SEED: u32 = 1;
/// The pinned FNV-1a 64 of the ten checkpoint checksums of the walk seeded [`SEED`].
const PINNED_WALK: &str = "a9c7e5cdbe4b6076";

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// Flat ground over the ground cells.
fn ground() -> NavInput {
    let (x1, z1) = (GROUND_CELLS_X as f32 * CELL, GROUND_CELLS_Z as f32 * CELL);
    let vertices = [vec3(0.0, 0.0, 0.0), vec3(x1, 0.0, 0.0), vec3(x1, 0.0, z1), vec3(0.0, 0.0, z1)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the ground")
}

/// The offline bake: every ground cell's island as the bytes `bakeAssets` kind `nav` would store.
fn offline_bake() -> Arc<BTreeMap<CellId, Vec<u8>>> {
    let input = ground();
    let mut out = BTreeMap::new();
    for z in 0..GROUND_CELLS_Z {
        for x in 0..GROUND_CELLS_X {
            let cell = CellId { x, z };
            let island = NavIsland::bake_cell(&input, &walker(), cell, CELL).expect("the cell bakes");
            out.insert(cell, island.to_bytes(&walker()));
        }
    }
    Arc::new(out)
}

/// A cell's island, carried as a part.
struct IslandPart(NavIsland);

impl CellPart for IslandPart {}

/// The commit hook of the islands: leaving cells' tiles out, entering cells' in, through
/// genex-stream's nav slot over the real genex-nav.
struct IslandCommit;

impl StreamCommit<World> for IslandCommit {
    fn leave(&self, sim: &mut Sim<World>, cell: CellId) {
        let islands = sim.facets.get_mut::<NavIslands>();
        commit(&mut StreamedNav { nav: &mut sim.nav, islands }, &[cell], &[]);
    }

    fn enter(&self, sim: &mut Sim<World>, cell: &EnteredCell) {
        let island = cell.parts::<IslandPart>().next().map(|part| part.0.clone()).unwrap_or_default();
        let islands = sim.facets.get_mut::<NavIslands>();
        commit(&mut StreamedNav { nav: &mut sim.nav, islands }, &[], &[(cell.cell(), &island)]);
    }
}

#[derive(Default)]
struct World {
    agents: Vec<AgentId>,
    ball: Option<RigidBodyHandle>,
}

/// A cell's colliders from the seed and the cell alone: a ground slab and seeded boxes and balls.
fn cell_colliders(inputs: &CellInputs) -> CellColliders {
    let mut rng = inputs.rng();
    let (min, _) = inputs.bounds();
    let half = CELL * 0.5;
    let slab = ColliderBuilder::cuboid(half, 0.5, half).translation(Vector::new(min.x + half, -0.5, min.y + half));
    let mut colliders = CellColliders::new().with(slab);
    for i in 0..2 + rng.below(4) {
        let at = Vector::new(min.x + rng.range_f32(1.0, CELL - 1.0), rng.range_f32(0.2, 2.0), min.y + rng.range_f32(1.0, CELL - 1.0));
        let collider = if i % 2 == 0 { ColliderBuilder::cuboid(0.5, rng.range_f32(0.2, 1.5), 0.5) } else { ColliderBuilder::ball(rng.range_f32(0.2, 0.8)) };
        colliders.push(collider.translation(at));
    }
    colliders
}

/// A triangle wave from 0 up to 1 and back over `period` ticks.
fn triangle(tick: u64, period: u64) -> f32 {
    let phase = (tick % period) as f32 / period as f32;
    1.0 - (2.0 * phase - 1.0).abs()
}

/// The anchor at `tick`: along x from the field's first cell to one past its last and back every
/// [`LAP_X_TICKS`], across z from one cell before the field to its last every [`LAP_Z_TICKS`].
fn anchor_at(tick: u64) -> Vec3 {
    let x = -0.5 * CELL + triangle(tick, LAP_X_TICKS) * (GROUND_CELLS_X as f32 + 1.0) * CELL;
    let z = -0.5 * CELL + triangle(tick, LAP_Z_TICKS) * GROUND_CELLS_Z as f32 * CELL;
    vec3(x, 0.0, z)
}

/// `at` held inside the ground's cells, where the islands are.
fn on_ground(at: Vec3) -> Vec3 {
    let (x1, z1) = (GROUND_CELLS_X as f32 * CELL, GROUND_CELLS_Z as f32 * CELL);
    vec3(at.x.clamp(1.0, x1 - 1.0), 0.0, at.z.clamp(1.0, z1 - 1.0))
}

/// Spawn the agents near the anchor once islands are in, then walk each to a target the tick rng
/// draws near the anchor whenever it has none to walk to.
fn walk_agents(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let anchor = on_ground(anchor_at(ctx.tick));
    let filter = NavFilter::new();
    sim.nav.update(ctx.dt);
    if sim.world.agents.is_empty() && sim.nav.tile_count() > 0 {
        let starts: Vec<Vec3> = (0..AGENTS).filter_map(|_| sim.nav.random_point(&mut &ctx.rng, anchor, TARGET_RADIUS, &filter)).map(|point| point.position).collect();
        if starts.len() == AGENTS {
            for start in starts {
                let agent = sim.nav.add_agent(NavAgent::new(start).with_speed(1.4, 3.0)).expect("an agent");
                sim.world.agents.push(agent);
            }
        }
    }
    for at in 0..sim.world.agents.len() {
        let agent = sim.world.agents[at];
        match sim.nav.status(agent) {
            Some(NavStatus::Arrived | NavStatus::NoPath | NavStatus::TargetOffMesh | NavStatus::Idle) => {
                if let Some(target) = sim.nav.random_point(&mut &ctx.rng, anchor, TARGET_RADIUS, &filter) {
                    sim.nav.move_to(agent, target.position);
                }
            }
            _ => {
                let velocity = sim.nav.desired_velocity(agent);
                let position = sim.nav.position(agent).unwrap_or_default() + velocity * ctx.dt;
                sim.nav.set_position(agent, position, velocity);
            }
        }
    }
}

/// The FNV-1a 64 of a float list's bits.
fn bits_digest(values: impl IntoIterator<Item = f32>) -> serde_json::Value {
    let bytes: Vec<u8> = values.into_iter().flat_map(|value| value.to_bits().to_le_bytes()).collect();
    json!(hex64(fnv1a64(&bytes)))
}

fn walking_game() -> Game<World> {
    let bake = offline_bake();
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1));
    game.navigation(walker());
    game.cell_content(move |cell: CellId, inputs: &CellInputs| {
        let island = bake.get(&cell).map(|bytes| NavIsland::from_bytes(bytes).expect("the offline bake reads"));
        CellBuild::<u32>::default().thing(cell.x.unsigned_abs() + cell.z.unsigned_abs()).part(cell_colliders(inputs)).part(IslandPart(island.unwrap_or_default()))
    });
    game.stream_colliders();
    game.facet_state::<NavIslands>();
    game.stream_commit(IslandCommit);
    game.on_reset(|sim, _, _, _| {
        sim.stream.set_anchor("player", anchor_at(0)).expect("anchor");
        let ball = RigidBodyBuilder::dynamic().translation(Vector::new(8.0, 3.0, 8.0)).linvel(Vector::new(4.0, 0.0, 1.0));
        let (body, _) = sim.physics.insert(ball, ColliderBuilder::ball(0.5));
        sim.world.ball = Some(body);
    });
    game.on_update(|sim, ctx| {
        walk_agents(sim, ctx);
        sim.stream.set_anchor("player", anchor_at(ctx.tick + 1)).expect("anchor");
    });
    game.probe("colliders", |sim| json!(hex64(fnv1a64(&serde_json::to_vec(&sim.physics.colliders).expect("the collider set serializes")))));
    game.probe("streamed", |sim| json!(hex64(sim.facets.get::<StreamColliders>().digest(&sim.physics))));
    game.probe("islands", |sim| json!(hex64(sim.facets.get::<NavIslands>().digest(&sim.nav))));
    game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()));
    game.probe("agents", |sim| bits_digest(sim.world.agents.iter().flat_map(|agent| sim.nav.position(*agent).unwrap_or_default().to_array())));
    game.probe("ball", |sim| {
        let at = sim.world.ball.map(|ball| {
            let at = sim.physics.bodies[ball].translation();
            [at.x, at.y, at.z]
        });
        bits_digest(at.unwrap_or_default())
    });
    game
}

/// The walk on `runtime` from `seed`: the checksum every [`CHECKPOINT_TICKS`].
fn checkpoints(runtime: &mut Runtime<World>, seed: u32) -> Vec<String> {
    runtime.seed(seed);
    (0..WALK_TICKS / CHECKPOINT_TICKS)
        .map(|_| {
            runtime.step(FIXED_STEP_MS * CHECKPOINT_TICKS as f64);
            runtime.checksum()
        })
        .collect()
}

/// A runtime of the walk over `pool`.
fn runtime_on(pool: Pool) -> Runtime<World> {
    let mut runtime = Runtime::new(walking_game()).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    runtime
}

/// The one digest of a walk's checkpoints.
fn walk_digest(checkpoints: &[String]) -> String {
    hex64(fnv1a64(checkpoints.join(",").as_bytes()))
}

/// New behaviour: the walk streams colliders and islands in and out all along (so the pin covers
/// streamed state, not an empty world), and its agents walk.
#[test]
fn the_walk_streams_colliders_and_islands_and_its_agents_walk() {
    let mut runtime = runtime_on(Pool::inline());
    let mut tiles = Vec::new();
    runtime.seed(SEED);
    for _ in 0..WALK_TICKS / CHECKPOINT_TICKS {
        runtime.step(FIXED_STEP_MS * CHECKPOINT_TICKS as f64);
        tiles.push(runtime.sim().nav.tile_count());
    }
    let sim = runtime.sim();
    assert_eq!(sim.world.agents.len(), AGENTS, "the agents spawned");
    assert!(tiles.iter().all(|count| *count > 0), "islands are in at every checkpoint: {tiles:?}");
    assert!(tiles.iter().any(|count| *count != tiles[0]), "islands streamed in and out: {tiles:?}");
    let ledger = sim.facets.get::<StreamColliders>();
    assert_eq!(ledger.cells().collect::<Vec<_>>(), sim.stream.active().collect::<Vec<_>>(), "every active cell's colliders are in");
    let moved = sim.world.agents.iter().filter(|agent| sim.nav.status(**agent) != Some(NavStatus::Idle)).count();
    assert!(moved > 0, "the agents walk");
}

/// New behaviour: the walk's ten checkpoints have the pinned digest with inline builds (the web's
/// pool): on aarch64, on x86_64 under Rosetta and on wasm32, the same bits.
#[test]
fn the_3000_tick_walk_has_the_pinned_checksum_inline() {
    let walk = checkpoints(&mut runtime_on(Pool::inline()), SEED);
    assert_eq!(walk_digest(&walk), PINNED_WALK, "checkpoints: {walk:?}");
}

/// New behaviour: 1 and 8 workers give the inline walk's checkpoints (native only: the web has no
/// worker threads).
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn the_walk_with_1_and_8_workers_matches_the_inline_walk() {
    let inline = checkpoints(&mut runtime_on(Pool::inline()), SEED);
    assert_eq!(checkpoints(&mut runtime_on(Pool::new(1)), SEED), inline, "1 worker vs inline");
    assert_eq!(checkpoints(&mut runtime_on(Pool::new(8)), SEED), inline, "8 workers vs inline");
}

/// New behaviour (owner determinism rule 4): `seed(2)` then `seed(1)` on one runtime replays a
/// fresh `seed(1)` walk checkpoint for checkpoint.
#[test]
fn seed_2_then_seed_1_replays_the_fresh_walk() {
    let fresh = checkpoints(&mut runtime_on(Pool::inline()), SEED);
    let mut runtime = runtime_on(Pool::inline());
    let other = checkpoints(&mut runtime, 2);
    assert_ne!(other, fresh, "another seed walks another world");
    assert_eq!(checkpoints(&mut runtime, SEED), fresh, "seed 1 after seed 2");
}
