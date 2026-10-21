//! STR-12: saving and restoring streamed state (owner call S5, canonical rebuild).
//!
//! `sim.stream.snapshot()` saves the anchors, the kept cells and the active cells; a restore makes
//! the saved active set the base of the next commit, which leaves what the snapshot does not hold
//! and enters what it does through the commit hooks, so `game.stream_colliders()` rebuilds the
//! streamed colliders in canonical order. The rows:
//! - a static-collider scene with a kinematic character, saved at tick 300 of 600 and restored at
//!   tick 300 into a run whose first 300 ticks streamed somewhere else, gives the uninterrupted
//!   run's checksum on every later tick;
//! - two restores of one save in a scene with a dynamic body replay equal to each other, collider
//!   handles included;
//! - a kept cell never leaves, wherever the anchor goes, and leaves once released;
//! - a snapshot that is truncated, oversized or for another registration refuses
//!   `stream-snapshot-invalid` and changes nothing.
//!
//! Every row is new behaviour (section 0 of the game systems plan); the restore row's equality to
//! the uninterrupted run is the S5 promise, which excludes Rapier's arena generations.

#![cfg(feature = "physics")]

use std::sync::Arc;

use genex::physics::{ColliderBuilder, QueryFilter, Ray, RigidBodyBuilder, RigidBodyHandle, Vector};
use genex::prelude::*;
use genex::{CellBuild, CellColliders, CellId, CellInputs, FIXED_STEP_MS, Runtime, Sim, StreamColliders, StreamErrorCode, Streaming};
use genex_core::digest::{fnv1a64, fnv1a64_from, hex64};
use genex_render::jobs::Pool;
use serde_json::json;

const CELL: f32 = 32.0;
/// Ticks of a run.
const TICKS: u64 = 600;
/// The tick the uninterrupted run saves at and the restored run restores at.
const SAVE_AT: u64 = 300;
/// Ticks the anchor stays in each cell.
const TICKS_PER_CELL: u64 = 6;
/// Cells the walk goes out along x before it comes back.
const WALK_CELLS: u64 = 40;
/// Where a restored run's anchor waits before the restore: far from the walk, so its first ticks
/// stream other cells and churn Rapier's arena differently.
const PARKED_X: f32 = -4000.0;
/// The kept-cell game keeps this cell.
const KEPT: CellId = CellId::new(0, 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scene {
    /// Static streamed colliders and a kinematic character.
    Static,
    /// Static streamed colliders and a dynamic ball rolling over them.
    Dynamic,
}

/// What the game saves at [`SAVE_AT`]: the streaming snapshot as JSON text and its body's state
/// (translation, rotation, linear and angular velocity, as bits).
#[derive(Clone, Debug, Default, PartialEq)]
struct Saved {
    stream: Vec<u8>,
    body: Vec<u32>,
}

/// A run's setup, captured by its hooks (every seed rebuilds the world from `W::default()`).
#[derive(Clone, Debug)]
struct Setup {
    scene: Scene,
    /// Restore this save at [`SAVE_AT`] (the anchor waits at [`PARKED_X`] until then).
    restore: Option<Saved>,
    /// Restore only the body, not the streaming snapshot (the control that proves the row can fail).
    body_only: bool,
}

#[derive(Default)]
struct World {
    saved: Option<Saved>,
    body: Option<RigidBodyHandle>,
    /// The streamed-collider ledger digest (cells, handles and bounds) after each tick's commit.
    handles: Vec<u64>,
}

/// The anchor's x at `tick`: 40 cells out, then back.
fn walk_x(tick: u64) -> f32 {
    let step = (tick / TICKS_PER_CELL).min(2 * WALK_CELLS);
    let cell = if step <= WALK_CELLS { step } else { 2 * WALK_CELLS - step };
    cell as f32 * CELL + 10.0
}

/// Where the anchor (and the kinematic character) is at `tick` in this run.
fn anchor_x(setup: &Setup, tick: u64) -> f32 {
    if setup.restore.is_some() && tick < SAVE_AT { PARKED_X } else { walk_x(tick) }
}

/// A cell's colliders from the seed and the cell alone: a ground slab and seeded boxes and balls.
fn cell_colliders(cell: CellId, inputs: &CellInputs) -> CellBuild<u32> {
    let mut rng = inputs.rng();
    let (min, _) = inputs.bounds();
    let half = CELL * 0.5;
    let slab = ColliderBuilder::cuboid(half, 0.5, half).translation(Vector::new(min.x + half, -0.5, min.y + half));
    let mut colliders = CellColliders::new().with(slab);
    for i in 0..2 + rng.below(5) {
        let at = Vector::new(min.x + rng.range_f32(1.0, CELL - 1.0), rng.range_f32(0.2, 2.0), min.y + rng.range_f32(1.0, CELL - 1.0));
        let collider = if i % 2 == 0 { ColliderBuilder::cuboid(0.5, rng.range_f32(0.2, 1.5), 0.5) } else { ColliderBuilder::ball(rng.range_f32(0.2, 0.8)) };
        colliders.push(collider.translation(at));
    }
    CellBuild::default().thing((cell.x + cell.z).unsigned_abs()).part(colliders)
}

fn body_bits(sim: &Sim<World>) -> Vec<u32> {
    let Some(body) = sim.world.body.map(|handle| &sim.physics.bodies[handle]) else { return Vec::new() };
    let (t, r, v, w) = (body.translation(), *body.rotation(), body.linvel(), body.angvel());
    [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z].map(f32::to_bits).to_vec()
}

fn set_body(sim: &mut Sim<World>, bits: &[u32]) {
    let Some(handle) = sim.world.body else { return };
    let [tx, ty, tz, rx, ry, rz, rw, vx, vy, vz, wx, wy, wz] = <[u32; 13]>::try_from(bits).expect("13 numbers").map(f32::from_bits);
    let body = &mut sim.physics.bodies[handle];
    body.set_translation(Vector::new(tx, ty, tz), true);
    body.set_rotation(genex::physics::Rotation::from_xyzw(rx, ry, rz, rw), true);
    body.set_linvel(Vector::new(vx, vy, vz), true);
    body.set_angvel(Vector::new(wx, wy, wz), true);
}

/// The streamed colliders without their handles: cells ascending, each collider's world bounds.
fn shapes_digest(sim: &Sim<World>) -> u64 {
    let ledger = sim.facets.get::<StreamColliders>();
    ledger.cells().fold(fnv1a64(&(ledger.len() as u64).to_le_bytes()), |hash, cell| {
        let hash = fnv1a64_from(&cell.z.to_le_bytes(), fnv1a64_from(&cell.x.to_le_bytes(), hash));
        ledger.handles(cell).iter().fold(hash, |hash, handle| {
            let bounds = sim.physics.colliders[*handle].compute_aabb();
            let corners = [bounds.mins.x, bounds.mins.y, bounds.mins.z, bounds.maxs.x, bounds.maxs.y, bounds.maxs.z];
            corners.iter().fold(hash, |hash, value| fnv1a64_from(&value.to_bits().to_le_bytes(), hash))
        })
    })
}

/// Rays straight down around the anchor: what a character standing there would stand on.
fn ground(sim: &Sim<World>, x: f32) -> serde_json::Value {
    let hits: Vec<Option<u32>> = [-12.0_f32, -4.0, 4.0, 12.0]
        .iter()
        .flat_map(|dx| [4.0_f32, 16.0].map(move |z| (x + dx, z)))
        .map(|(x, z)| {
            let ray = Ray::new(Vector::new(x, 10.0, z), Vector::new(0.0, -1.0, 0.0));
            sim.physics.cast_ray(&ray, 20.0, true, QueryFilter::default()).map(|(_, toi)| toi.to_bits())
        })
        .collect();
    json!(hits)
}

/// The walk game: streamed colliders through `game.stream_colliders()`, a body that follows the
/// anchor (kinematic) or rolls (dynamic), a save at [`SAVE_AT`] and, in a restored run, the restore.
fn saves_game(scene: Scene, restore: Option<Saved>) -> Game<World> {
    setup_game(Setup { scene, restore, body_only: false })
}

fn setup_game(setup: Setup) -> Game<World> {
    let scene = setup.scene;
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1));
    game.cell_content(cell_colliders);
    game.stream_colliders();
    let at_reset = setup.clone();
    game.on_reset(move |sim, _, _, _| {
        let x = anchor_x(&at_reset, 0);
        sim.stream.set_anchor("player", vec3(x, 0.0, 10.0)).expect("anchor");
        let body = match at_reset.scene {
            Scene::Dynamic => RigidBodyBuilder::dynamic().translation(Vector::new(x, 3.0, 10.0)).linvel(Vector::new(6.0, 0.0, 0.0)),
            _ => RigidBodyBuilder::kinematic_position_based().translation(Vector::new(x, 1.0, 10.0)),
        };
        let (body, _) = sim.physics.insert(body, ColliderBuilder::ball(0.5));
        sim.world.body = Some(body);
    });
    game.on_update(move |sim, ctx| {
        sim.world.handles.push(sim.facets.get::<StreamColliders>().digest(&sim.physics));
        if ctx.tick == SAVE_AT
            && let Some(saved) = &setup.restore
        {
            if !setup.body_only {
                let snapshot: serde_json::Value = serde_json::from_slice(&saved.stream).expect("the snapshot text reads back");
                sim.stream.restore(&snapshot).expect("restores onto the same registration");
            }
            set_body(sim, &saved.body);
        }
        let next = anchor_x(&setup, ctx.tick + 1);
        sim.stream.set_anchor("player", vec3(next, 0.0, 10.0)).expect("anchor");
        if setup.scene == Scene::Static
            && let Some(body) = sim.world.body
        {
            sim.physics.bodies[body].set_next_kinematic_translation(Vector::new(next, 1.0, 10.0));
        }
        if ctx.tick == SAVE_AT && setup.restore.is_none() {
            sim.world.saved = Some(Saved { stream: serde_json::to_vec(&sim.stream.snapshot()).expect("JSON"), body: body_bits(sim) });
        }
    });
    game.probe("body", |sim| json!(body_bits(sim)));
    game.probe("shapes", |sim| json!(hex64(shapes_digest(sim))));
    game.probe("ground", |sim| ground(sim, sim.world.body.map_or(0.0, |body| sim.physics.bodies[body].translation().x)));
    if scene == Scene::Dynamic {
        game.probe("handles", |sim| json!(hex64(sim.facets.get::<StreamColliders>().digest(&sim.physics))));
    }
    game
}

/// Run `game` for [`TICKS`] ticks with inline builds (the web's pool); every tick's checksum and
/// the runtime.
fn run(game: Game<World>) -> (Vec<String>, Runtime<World>) {
    run_on(game, Pool::inline())
}

fn run_on(game: Game<World>, pool: Pool) -> (Vec<String>, Runtime<World>) {
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(7);
    let checksums = (0..TICKS)
        .map(|_| {
            runtime.step(FIXED_STEP_MS);
            runtime.checksum()
        })
        .collect();
    (checksums, runtime)
}

fn saved(runtime: &Runtime<World>) -> Saved {
    runtime.sim().world.saved.clone().expect("the run saved at tick 300")
}

/// The first tick after the restore whose values differ, if any.
fn first_difference<T: PartialEq + std::fmt::Debug>(a: &[T], b: &[T], from: usize) -> Option<String> {
    let at = (from..a.len().min(b.len())).find(|tick| a[*tick] != b[*tick])?;
    Some(format!("tick {at}: {:?} vs {:?}", a[at], b[at]))
}

#[test]
fn a_static_scene_restored_at_300_gives_the_uninterrupted_runs_checksum_on_every_later_tick() {
    let (plain, uninterrupted) = run(saves_game(Scene::Static, None));
    let save = saved(&uninterrupted);
    let (restored, runtime) = run(saves_game(Scene::Static, Some(save.clone())));
    assert_ne!(plain[SAVE_AT as usize - 1], restored[SAVE_AT as usize - 1], "the restored run streamed elsewhere before the restore");
    // Tick 300's commit ran before the restore; tick 301's commit is the first that reads it.
    assert_eq!(first_difference(&plain, &restored, SAVE_AT as usize + 1), None, "every checksum after the restore");
    assert_eq!(uninterrupted.state()["shapes"], runtime.state()["shapes"]);
    let active = |runtime: &Runtime<World>| runtime.sim().stream.active().collect::<Vec<_>>();
    assert_eq!(active(&uninterrupted), active(&runtime));
    assert!(!active(&runtime).is_empty());
}

#[test]
fn without_the_streaming_restore_the_parked_run_differs_after_300() {
    // Proves the row above can fail: the body comes back, the hysteresis ring behind the anchor
    // does not.
    let (plain, uninterrupted) = run(saves_game(Scene::Static, None));
    let (body_only, _) = run(setup_game(Setup { scene: Scene::Static, restore: Some(saved(&uninterrupted)), body_only: true }));
    assert!(first_difference(&plain, &body_only, SAVE_AT as usize + 1).is_some());
}

#[test]
#[ignore = "red (S5): a canonical rebuild cannot give back Rapier's arena generations, so restored ColliderHandles differ from the uninterrupted run's"]
fn a_static_scene_restored_at_300_gives_the_uninterrupted_runs_collider_handles() {
    let (_, uninterrupted) = run(saves_game(Scene::Static, None));
    let (_, restored) = run(saves_game(Scene::Static, Some(saved(&uninterrupted))));
    let handles = |runtime: &Runtime<World>| runtime.sim().world.handles.clone();
    assert_eq!(first_difference(&handles(&uninterrupted), &handles(&restored), SAVE_AT as usize + 1), None);
}

#[test]
fn two_restores_of_one_save_with_a_dynamic_body_replay_equal_to_each_other() {
    let (_, uninterrupted) = run(saves_game(Scene::Dynamic, None));
    let save = saved(&uninterrupted);
    let (first, a) = run(saves_game(Scene::Dynamic, Some(save.clone())));
    let (second, b) = run(saves_game(Scene::Dynamic, Some(save)));
    assert_eq!(first_difference(&first, &second, 0), None, "every checksum, collider handles and the ball included");
    #[cfg(not(target_arch = "wasm32"))]
    {
        let (eight, _) = run_on(saves_game(Scene::Dynamic, Some(saved(&uninterrupted))), Pool::new(8));
        assert_eq!(first_difference(&first, &eight, 0), None, "inline builds and 8 workers");
    }
    assert_eq!(a.sim().world.handles, b.sim().world.handles);
    assert_eq!(a.state()["body"], b.state()["body"]);
    assert!(a.sim().facets.get::<StreamColliders>().len() > 3, "the restore rebuilt the streamed colliders");
}

/// The last checksums of the restored runs, pinned: the same literals hold in a wasm32 test
/// binary, so restore-then-replay agrees across destinations (the inline pool is the web's).
#[test]
fn restored_runs_end_on_pinned_checksums() {
    let (_, uninterrupted) = run(saves_game(Scene::Static, None));
    let (static_run, _) = run(saves_game(Scene::Static, Some(saved(&uninterrupted))));
    let (_, uninterrupted) = run(saves_game(Scene::Dynamic, None));
    let (dynamic_run, _) = run(saves_game(Scene::Dynamic, Some(saved(&uninterrupted))));
    let last = |checksums: &[String]| checksums.last().cloned().unwrap_or_default();
    assert_eq!((last(&static_run), last(&dynamic_run)), (PINNED_STATIC.to_owned(), PINNED_DYNAMIC.to_owned()));
}

/// What [`restored_runs_end_on_pinned_checksums`] pins for the static scene.
const PINNED_STATIC: &str = "74c021cbc9ef9086";
/// And for the dynamic scene.
const PINNED_DYNAMIC: &str = "b22b2d598239c82c";

#[test]
fn a_snapshot_reads_back_as_the_state_it_saved() {
    let (_, uninterrupted) = run(saves_game(Scene::Static, None));
    let text = saved(&uninterrupted).stream;
    let snapshot: serde_json::Value = serde_json::from_slice(&text).expect("JSON");
    assert_eq!(snapshot["version"], json!(1));
    assert_eq!(snapshot["anchors"], json!([["player", (walk_x(SAVE_AT + 1) / CELL).floor() as i64, 0]]), "the anchor the next commit follows");
    assert_eq!(snapshot["kept"], json!([]));
    let active = snapshot["active"].as_array().map_or(0, Vec::len);
    assert!((9..=25).contains(&active), "{active} active cells at radius 1, hysteresis 1");
}

// ---- kept cells --------------------------------------------------------------------------------

#[derive(Default)]
struct Kept {
    /// Whether the kept cell was active after each tick's commit.
    kept_active: Vec<bool>,
    /// Ticks whose commit left the kept cell.
    left_at: Vec<u64>,
}

fn kept_game(release_at: Option<u64>) -> Game<Kept> {
    let mut game = Game::new(Kept::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1));
    game.cell_content(cell_colliders);
    game.stream_colliders();
    game.on_reset(|sim, _, _, _| {
        sim.stream.set_anchor("player", vec3(10.0, 0.0, 10.0)).expect("anchor");
        sim.stream.keep(KEPT).expect("keeps a cell in the world");
    });
    game.on_update(move |sim, ctx| {
        sim.world.kept_active.push(sim.stream.is_active(KEPT));
        if sim.stream.left().contains(&KEPT) {
            sim.world.left_at.push(ctx.tick);
        }
        if release_at == Some(ctx.tick) {
            sim.stream.release(KEPT);
        }
        sim.stream.set_anchor("player", vec3(walk_x(ctx.tick + 1), 0.0, 10.0)).expect("anchor");
    });
    game
}

fn run_kept(game: Game<Kept>, ticks: u64) -> Runtime<Kept> {
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(Pool::inline()));
    runtime.seed(3);
    runtime.step(FIXED_STEP_MS * ticks as f64);
    runtime
}

#[test]
fn a_kept_cell_never_leaves_and_leaves_once_released() {
    // Out 40 cells and most of the way back: the anchor is far from cell (0, 0) for most of it.
    let kept = run_kept(kept_game(None), 400);
    let world = &kept.sim().world;
    assert!(world.kept_active.iter().skip(1).all(|active| *active), "kept from the first commit on");
    assert!(world.left_at.is_empty(), "never left");
    assert!(kept.sim().facets.get::<StreamColliders>().cells().any(|cell| cell == KEPT), "its colliders stay in");
    assert_eq!(kept.sim().stream.kept().collect::<Vec<_>>(), vec![KEPT]);

    let released = run_kept(kept_game(Some(100)), 400);
    assert_eq!(released.sim().world.left_at, vec![101], "the commit after the release leaves it (the anchor is 16 cells away)");
    assert!(!released.sim().stream.is_active(KEPT));
}

#[test]
fn keep_refuses_past_its_caps_and_a_reseed_forgets_kept_cells() {
    let mut runtime = run_kept(kept_game(None), 2);
    let stream = &mut runtime.sim_mut().stream;
    let far = CellId::new(100_000, 0);
    assert_eq!(stream.keep(far).map_err(|e| e.code), Err(StreamErrorCode::OutOfWorld));
    for x in 1..genex_stream::snapshot::STREAM_KEPT_MAX as i32 {
        stream.keep(CellId::new(x, 5)).expect("under the cap");
    }
    assert_eq!(stream.keep(CellId::new(0, 9)).map_err(|e| e.code), Err(StreamErrorCode::Invalid), "one past the cap");
    stream.keep(KEPT).expect("keeping a kept cell again is not one more");
    assert_eq!(stream.kept().count(), genex_stream::snapshot::STREAM_KEPT_MAX);
    runtime.seed(4);
    assert_eq!(runtime.sim().stream.kept().count(), 1, "the reseed's on_reset kept its one cell again");

    let mut plain = Runtime::new(Game::new(Kept::default())).expect("installs");
    plain.seed(1);
    assert_eq!(plain.sim_mut().stream.keep(KEPT).map_err(|e| e.code), Err(StreamErrorCode::NotRegistered));
    assert_eq!(plain.sim_mut().stream.restore(&json!({})).map_err(|e| e.code), Err(StreamErrorCode::NotRegistered));
    assert_eq!(plain.sim().stream.snapshot(), serde_json::Value::Null);
}

#[test]
fn kept_cells_are_saved_and_restored() {
    let mut runtime = run_kept(kept_game(None), 300);
    let snapshot = runtime.sim().stream.snapshot();
    assert_eq!(snapshot["kept"], json!([[0, 0]]));
    runtime.sim_mut().stream.release(KEPT);
    runtime.sim_mut().stream.restore(&snapshot).expect("its own snapshot");
    runtime.step(FIXED_STEP_MS * 20.0);
    assert!(runtime.sim().world.left_at.is_empty(), "the restored keep held the cell");
}

// ---- refusals ----------------------------------------------------------------------------------

#[test]
fn a_truncated_oversized_or_foreign_snapshot_refuses_and_changes_nothing() {
    let mut runtime = run_kept(kept_game(None), 30);
    let good = runtime.sim().stream.snapshot();
    let text = serde_json::to_string(&good).expect("JSON");
    let active_before: Vec<CellId> = runtime.sim().stream.active().collect();
    let anchors_before: Vec<(String, CellId)> = runtime.sim().stream.anchors().map(|(name, cell)| (name.to_owned(), cell)).collect();
    let many: Vec<String> = (0..2000).map(|x| format!("[{},{}]", x % 200 - 100, x / 200)).collect();
    let rows: Vec<(&str, String)> = vec![
        ("truncated: the active list cut", text.replacen(r#""active":"#, r#""active":null,"cut":"#, 1)),
        ("truncated: a cell cut in half", text.replacen(r#""kept":[[0,0]]"#, r#""kept":[[0]]"#, 1)),
        ("oversized: too many active cells", text.replacen(r#""active":["#, &format!(r#""active":[{},"#, many.join(",")), 1)),
        ("another cell size", text.replacen(&format!(r#""cellSizeBits":{}"#, CELL.to_bits()), &format!(r#""cellSizeBits":{}"#, 16.0_f32.to_bits()), 1)),
        ("another version", text.replacen(r#""version":1"#, r#""version":7"#, 1)),
    ];
    for (what, hostile) in rows {
        let value: serde_json::Value = serde_json::from_str(&hostile).expect(what);
        let refused = runtime.sim_mut().stream.restore(&value).expect_err(what);
        assert_eq!(refused.code, StreamErrorCode::SnapshotInvalid, "{what}: {refused}");
    }
    assert_eq!(runtime.sim().stream.snapshot(), good, "nothing changed");
    runtime.step(FIXED_STEP_MS);
    let anchors_after: Vec<(String, CellId)> = runtime.sim().stream.anchors().map(|(name, cell)| (name.to_owned(), cell)).collect();
    assert_eq!(anchors_after.len(), anchors_before.len());
    assert!(runtime.sim().stream.active().count() >= active_before.len().min(9), "the commit still followed the anchor");
}
