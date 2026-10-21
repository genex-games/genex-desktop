//! UIS-13: save slots of a streamed world (G6 saves over STR-12's stream snapshot).
//!
//! A game that registers `game.streaming` and `game.saves` gets the built-in `genex.stream`
//! section in every slot: `sim.stream.snapshot()` (anchors, kept cells, active cells) beside the
//! game's own sections, restored through STR-9's commit hooks after a load. The rows use the
//! `stream-valley` registration (STR-26a: 64 m cells, sim radius 2, hysteresis 1, prefetch 1, one
//! anchor, a 4 x 4 km world) with static streamed colliders and a kinematic body:
//! - a slot holds `genex.stream` and the game's section, and a slot saved at tick 300 and loaded at
//!   tick 600 (the anchor 600 m away by then) replays the uninterrupted run's checksum on every tick
//!   to 600: the S5 promise for static colliders and kinematic characters (Rapier's arena
//!   generations are not part of it);
//! - the slot bodies of that world stay under the 16 MiB save cap (`MAX_SAVE_BYTES`), measured as it
//!   plays and with every kept cell the snapshot allows;
//! - the envelope bytes are equal on the native pool (8 threads) and the web's inline pool, apart
//!   from the wall-clock date a native slot records (`meta.savedAtMs`; the web records none).
//!
//! New behaviour (section 0 of the game systems plan): the section is red until `genex.stream` is
//! wired into `saves.rs`.

#![cfg(feature = "physics")]

use std::sync::Arc;

use genex::physics::{ColliderBuilder, QueryFilter, Ray, RigidBodyBuilder, RigidBodyHandle, Vector};
use genex::prelude::*;
use genex::saves::SaveConfig;
use genex::{CellBuild, CellColliders, CellId, CellInputs, FIXED_STEP_MS, Runtime, StreamColliders, Streaming};
use genex_core::digest::{fnv1a64, fnv1a64_from, hex64};
use genex_core::saves::MAX_SAVE_BYTES;
use genex_render::jobs::Pool;
use serde_json::json;

/// The STR-26a registration: 64 m cells, sim radius 2, hysteresis 1, prefetch 1, one anchor.
const CELL: f32 = 64.0;
const RADII: [u32; 3] = [2, 1, 1];
/// The world's half side in metres (cells -32..=31).
const WORLD_HALF: f32 = 2048.0;
/// The tick the slot holds, and the tick the uninterrupted run ends (and the load is pressed).
const SAVE_TICK: u64 = 300;
const END_TICK: u64 = 600;
/// Metres the anchor moves a tick: by [`END_TICK`] it is 600 m past where the slot was saved, so
/// every cell the slot held has left.
const METRES_PER_TICK: f32 = 2.0;
/// The slot's name.
const SLOT: &str = "valley";
/// The streamed-world save cap the plan names (STR-12 acceptance): one slot body.
const SAVE_CAP: usize = 16 * 1024 * 1024;
/// The most cells a snapshot keeps (genex-stream's `STREAM_KEPT_MAX`).
const KEPT_MAX: i32 = 64;

#[derive(Default)]
struct World {
    body: Option<RigidBodyHandle>,
}

/// What a run keeps: whether it keeps every cell the snapshot allows (the worst-case body).
#[derive(Clone, Copy)]
struct Setup {
    keep_all: bool,
}

/// The anchor's x at `tick`, from the valley's west edge eastwards.
fn anchor_x(tick: u64) -> f32 {
    -WORLD_HALF + 40.0 + tick as f32 * METRES_PER_TICK
}

/// A cell's static colliders from the seed and the cell alone: a ground slab and seeded boxes.
fn cell_colliders(cell: CellId, inputs: &CellInputs) -> CellBuild<u32> {
    let mut rng = inputs.rng();
    let (min, _) = inputs.bounds();
    let half = CELL * 0.5;
    let slab = ColliderBuilder::cuboid(half, 0.5, half).translation(Vector::new(min.x + half, -0.5, min.y + half));
    let mut colliders = CellColliders::new().with(slab);
    for _ in 0..2 + rng.below(5) {
        let at = Vector::new(min.x + rng.range_f32(1.0, CELL - 1.0), rng.range_f32(0.2, 2.0), min.y + rng.range_f32(1.0, CELL - 1.0));
        colliders.push(ColliderBuilder::cuboid(0.5, rng.range_f32(0.2, 1.5), 0.5).translation(at));
    }
    CellBuild::default().thing((cell.x + cell.z).unsigned_abs()).part(colliders)
}

fn body_bits(sim: &Sim<World>) -> Vec<u32> {
    let Some(body) = sim.world.body.map(|handle| &sim.physics.bodies[handle]) else { return Vec::new() };
    let t = body.translation();
    [t.x, t.y, t.z].map(f32::to_bits).to_vec()
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

/// Rays straight down around the body: what it would stand on.
fn ground(sim: &Sim<World>) -> serde_json::Value {
    let x = sim.world.body.map_or(0.0, |body| sim.physics.bodies[body].translation().x);
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

/// The kept cells of the worst-case run: a row along the north edge, far from the anchor.
fn kept_cells() -> impl Iterator<Item = CellId> {
    (0..KEPT_MAX).map(|i| CellId::new(i - KEPT_MAX / 2, 31))
}

/// The valley-scale walk: streamed colliders, a kinematic body on the anchor, a save of [`SLOT`]
/// at the end of tick 299 (it holds tick 300) and a load on `KeyL`.
fn slots_game(setup: Setup) -> Game<World> {
    let mut game = Game::new(World::default()).title("Stream slots");
    let [radius, hysteresis, prefetch] = RADII;
    game.streaming(Streaming::grid(CELL).sim_radius(radius).hysteresis(hysteresis).prefetch(prefetch));
    game.cell_content(cell_colliders);
    game.stream_colliders();
    game.saves(SaveConfig::schema(1));
    game.save_section("walk", |sim| json!(body_bits(sim)), |sim, value, _gfx| {
        let bits: Vec<u32> = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        let [x, y, z] = <[u32; 3]>::try_from(bits).map_err(|_| "three numbers".to_owned())?.map(f32::from_bits);
        let body = sim.world.body.ok_or("the reset hook inserts the body")?;
        sim.physics.bodies[body].set_translation(Vector::new(x, y, z), true);
        Ok(())
    });
    game.on_reset(move |sim, _, _, _| {
        let x = anchor_x(0);
        sim.stream.set_anchor("player", vec3(x, 0.0, 10.0)).expect("anchor");
        if setup.keep_all {
            for cell in kept_cells() {
                sim.stream.keep(cell).expect("within the kept cap");
            }
        }
        let (body, _) = sim.physics.insert(RigidBodyBuilder::kinematic_position_based().translation(Vector::new(x, 1.0, 10.0)), ColliderBuilder::ball(0.5));
        sim.world.body = Some(body);
    });
    game.on_update(|sim, ctx| {
        if ctx.tick + 1 == SAVE_TICK {
            ctx.slots().save(SLOT, "Valley").expect("the save is queued");
        }
        if ctx.keys.pressed(Key::KeyL) {
            ctx.slots().load(SLOT).expect("the load is queued");
        }
        let next = anchor_x(ctx.tick + 1);
        sim.stream.set_anchor("player", vec3(next, 0.0, 10.0)).expect("anchor");
        if let Some(body) = sim.world.body {
            sim.physics.bodies[body].set_next_kinematic_translation(Vector::new(next, 1.0, 10.0));
        }
    });
    game.probe("body", |sim| json!(body_bits(sim)));
    game.probe("shapes", |sim| json!(hex64(shapes_digest(sim))));
    game.probe("ground", ground);
    game.probe("active", |sim| {
        let cells: Vec<[i32; 2]> = sim.stream.active().map(|cell| [cell.x, cell.z]).collect();
        json!(cells)
    });
    game
}

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-stream-slots-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    text.push('/');
    text
}

fn runtime(setup: Setup, pool: Pool, name: &str) -> Runtime<World> {
    let mut rt = Runtime::new(slots_game(setup)).expect("a consistent game installs");
    rt.use_stream_pool(Arc::new(pool));
    rt.use_studio_saves(&state_dir(name));
    rt.seed(1);
    rt
}

/// Run to `tick`, the checksum after each tick from `from` on.
fn run_to(rt: &mut Runtime<World>, tick: u64, from: u64) -> Vec<String> {
    let mut checksums = Vec::new();
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
        if rt.tick() >= from {
            checksums.push(rt.checksum());
        }
    }
    checksums
}

fn slot_body(rt: &Runtime<World>) -> Vec<u8> {
    rt.saves().load(&format!("slots/{SLOT}.sav")).expect("the slot body")
}

/// The body with its wall-clock date (`meta.savedAtMs`, a person's layer outside the digest) as
/// the web writes it: none.
fn without_date(body: &[u8]) -> String {
    let text = std::str::from_utf8(body).expect("an envelope is UTF-8 JSON");
    let Some(at) = text.find("\"savedAtMs\":") else { return text.to_owned() };
    let start = at + "\"savedAtMs\":".len();
    let end = start + text[start..].find([',', '}']).expect("the member ends");
    format!("{}null{}", &text[..start], &text[end..])
}

#[test]
fn a_slot_holds_genex_stream_and_a_load_replays_the_uninterrupted_run() {
    let mut rt = runtime(Setup { keep_all: false }, Pool::inline(), "replay");
    let uninterrupted = run_to(&mut rt, END_TICK, SAVE_TICK + 1);
    let saved_active = {
        let body = slot_body(&rt);
        let envelope = genex::saves::decode(&body).expect("an envelope");
        let names: Vec<&str> = envelope.sections.keys().map(String::as_str).collect();
        assert_eq!(names, ["genex.stream", "walk"], "the built-in section first, then the game's");
        assert_eq!(envelope.tick, SAVE_TICK);
        envelope.sections["genex.stream"]["active"].clone()
    };
    assert!(saved_active.as_array().is_some_and(|cells| !cells.is_empty()), "the slot holds the active cells: {saved_active}");
    let at_end = rt.state()["active"].clone();
    assert_ne!(at_end, saved_active, "the anchor has moved on: no cell of the slot is still active");

    // The press runs a tick; the load swaps in at the start of the next, which runs as tick 301.
    rt.inject(Input::key_tap(Key::KeyL));
    rt.step(FIXED_STEP_MS);
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.tick(), SAVE_TICK + 1, "the load applied");
    let mut replayed = vec![rt.checksum()];
    replayed.extend(run_to(&mut rt, END_TICK, SAVE_TICK + 2));
    assert_eq!(replayed.len(), uninterrupted.len());
    for (offset, (again, first)) in replayed.iter().zip(&uninterrupted).enumerate() {
        assert_eq!(again, first, "tick {} after the load", SAVE_TICK + 1 + offset as u64);
    }
    let last = &rt.state()["volatile"]["saves"]["lastLoad"];
    println!("lastLoad {last}");
    assert_eq!(last["slot"], json!(SLOT));
    assert_eq!(last["tick"], json!(SAVE_TICK));
    // The self-check runs once the commit has rebuilt the slot's cells, so a probe that reads
    // streamed colliders or the active set agrees with the saved checksum (GI determinism row).
    assert_eq!(last["checksumMatch"], json!(true), "the restored world's checksum is the saved one");
    let issues = &rt.state()["volatile"]["saves"]["issues"];
    assert!(!issues.as_array().is_some_and(|all| all.iter().any(|issue| issue == genex::saves::SAVE_RESTORE_DIVERGED)), "no divergence: {issues}");
}

#[test]
fn stream_valley_slots_stay_under_the_16_mib_save_cap() {
    assert_eq!(SAVE_CAP, MAX_SAVE_BYTES, "the plan's cap is genex-core's per-file save cap");
    let mut playing = runtime(Setup { keep_all: false }, Pool::inline(), "size-playing");
    run_to(&mut playing, SAVE_TICK + 1, u64::MAX);
    let mut worst = runtime(Setup { keep_all: true }, Pool::inline(), "size-kept");
    run_to(&mut worst, SAVE_TICK + 1, u64::MAX);
    let (playing, worst) = (slot_body(&playing), slot_body(&worst));
    let kept = genex::saves::decode(&worst).expect("an envelope").sections["genex.stream"]["kept"].as_array().map_or(0, Vec::len);
    println!("stream-valley slot bodies: {} bytes as it plays, {} bytes with {kept} kept cells (cap {SAVE_CAP})", playing.len(), worst.len());
    assert_eq!(kept, KEPT_MAX as usize, "the worst case keeps every cell the snapshot allows");
    assert!(playing.len() < SAVE_CAP && worst.len() < SAVE_CAP);
}

#[test]
fn envelope_bytes_are_equal_on_the_native_pool_and_the_web_inline_pool() {
    let mut native = runtime(Setup { keep_all: false }, Pool::new(8), "native");
    let mut inline = runtime(Setup { keep_all: false }, Pool::inline(), "inline");
    run_to(&mut native, SAVE_TICK + 1, u64::MAX);
    run_to(&mut inline, SAVE_TICK + 1, u64::MAX);
    let (native, inline) = (slot_body(&native), slot_body(&inline));
    assert!(native.windows(14).any(|w| w == b"\"genex.stream\""), "the slot holds genex.stream");
    assert_eq!(without_date(&native), without_date(&inline), "equal bytes apart from the native wall-clock date");
}
