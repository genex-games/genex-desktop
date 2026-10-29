//! The soldier kit (`src/game-template-rust/docs/examples/soldier`) as a game gets it: the GLB beside
//! the example (`soldier.glb`, made by `soldier.py` in Blender from Quaternius' CC0 animation
//! library) at `kits/soldier.glb`, animated from a remote soldier's replicated state alone. The
//! velocity picks the gait, the pitch tilts the aim, the shot and hit counters play the shot and
//! the side's hit, zero health holds the death, two machines fed the same state agree to the bit,
//! and (on the host GPU) close captures of each:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test soldier -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/soldier/src/game.rs"]
mod game;
#[path = "../../../../../src/game-template-rust/docs/examples/soldier/src/facets/soldier.rs"]
mod soldier;
mod support;

use genex::math::{Vec3, vec3};
use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, Value, View};

use game::{Phase, SoldierNet, World};

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/soldier/genex.toml");
const KIT_GLB: &[u8] = include_bytes!("../../../../../src/game-template-rust/docs/examples/soldier/soldier.glb");
const WORLD_SIZE: [u32; 2] = [1280, 720];

fn soldier_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Soldier kit").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    soldier::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets() -> genex::AssetTable {
    support::assets(&[(soldier::KIT, KIT_GLB.to_vec())])
}

fn started() -> Runtime<World> {
    run(soldier_game())
}

/// The kit alone, fed only what a test writes into `world.soldier`: no script plays the server.
fn remote() -> Runtime<World> {
    let mut game = Game::new(World::default()).title("Remote soldier").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.on_update(|sim, ctx| sim.world.tick = ctx.tick);
    soldier::wire(&mut game);
    run(game)
}

fn run(game: Game<World>) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game, Box::new(assets())).expect("the kit installs");
    runtime.seed(1);
    runtime.start();
    runtime
}

/// The seconds from the script's start to `phase`'s start.
fn phase_start(phase: Phase) -> f32 {
    game::PHASES.iter().take_while(|(p, _)| *p != phase).map(|(_, s)| s).sum()
}

/// Step the script to `seconds` into `phase`.
fn seek(runtime: &mut Runtime<World>, phase: Phase, seconds: f32) {
    let ticks = ((phase_start(phase) + seconds) * 60.0).round() as u64;
    let now = runtime.sim().world.tick;
    runtime.step(FIXED_STEP_MS * ticks.saturating_sub(now) as f64);
}

fn kit(runtime: &Runtime<World>) -> Value {
    runtime.state()["soldier"].clone()
}

/// The kit's layer states, as its probe prints them.
fn anim(runtime: &Runtime<World>) -> String {
    kit(runtime)["anim"].to_string()
}

fn muzzle(runtime: &Runtime<World>) -> Vec3 {
    socket(runtime, "muzzle")
}

fn socket(runtime: &Runtime<World>, name: &str) -> Vec3 {
    let at = kit(runtime)[name].clone();
    let axis = |i: usize| at[i].as_f64().unwrap_or(0.0) as f32;
    vec3(axis(0), axis(1), axis(2))
}

/// Hold the remote soldier at a replicated state for `ticks`.
fn hold(runtime: &mut Runtime<World>, net: SoldierNet, ticks: u32) {
    runtime.sim_mut().world.soldier = net;
    runtime.step(FIXED_STEP_MS * f64::from(ticks));
}

fn standing() -> SoldierNet {
    SoldierNet { yaw: std::f32::consts::FRAC_PI_2, hp: game::HEALTH, ..SoldierNet::default() }
}

#[test]
fn the_kit_loads_its_rig_and_builds_its_graph() {
    let runtime = started();
    let state = kit(&runtime);
    assert_eq!(state["kit"], true, "{state}");
}

#[test]
fn the_velocity_in_the_soldiers_own_frame_picks_the_gait() {
    let mut runtime = remote();
    let facing = standing();
    let forward = vec3(0.0, 0.0, 1.0);
    let right = vec3(-1.0, 0.0, 0.0);
    for (vel, crouch, gait) in [
        (Vec3::ZERO, false, "idle"),
        (forward * 1.3, false, "walk"),
        (forward * 4.0, false, "run"),
        (-forward * 1.0, false, "back"),
        (right * 1.2, false, "strafe-right"),
        (-right * 1.2, false, "strafe-left"),
        (Vec3::ZERO, true, "crouch"),
        (forward * 0.9, true, "crouch-walk"),
    ] {
        hold(&mut runtime, SoldierNet { vel, crouch, ..facing }, 30);
        let anim = anim(&runtime);
        assert!(anim.contains(&format!("\"{gait}\"")), "{vel} crouch {crouch} plays {gait}: {anim}");
    }
}

#[test]
fn the_rifle_points_where_the_soldier_faces_in_every_gait() {
    let mut runtime = remote();
    let forward = vec3(0.0, 0.0, 1.0);
    for (vel, crouch) in [(Vec3::ZERO, false), (forward * 1.3, false), (vec3(-1.2, 0.0, 0.0), false), (vec3(1.2, 0.0, 0.0), false), (-forward, false), (Vec3::ZERO, true)] {
        hold(&mut runtime, SoldierNet { vel, crouch, ..standing() }, 40);
        let along = socket(&runtime, "muzzle") - socket(&runtime, "sight");
        let flat = vec3(along.x, 0.0, along.z).normalize();
        let off = flat.angle_between(forward).to_degrees();
        assert!(off < 15.0, "{vel} crouch {crouch}: the rifle points {off:.0}° off the soldier's facing ({along})");
    }
}

#[test]
fn the_pitch_tilts_the_rifle_up_and_down() {
    let mut runtime = remote();
    let height = |runtime: &mut Runtime<World>, pitch: f32| {
        hold(runtime, SoldierNet { pitch, ..standing() }, 40);
        muzzle(runtime).y
    };
    let (down, level, up) = (height(&mut runtime, -0.5), height(&mut runtime, 0.0), height(&mut runtime, 0.5));
    assert!(down + 0.1 < level && level + 0.1 < up, "the muzzle rises with the pitch: {down} {level} {up}");
}

#[test]
fn the_recipes_demo_measures_the_aim_along_the_pitch() {
    // rust.soldier-kit's check: result.muzzleRiseM > 0.1.
    let mut runtime = started();
    runtime.step(FIXED_STEP_MS * 10.0);
    let result = runtime.demo("soldier-aim").expect("the demo exists");
    assert!(result["muzzleRiseM"].as_f64() > Some(0.1), "{result}");
}

#[test]
fn a_shot_a_hit_from_each_side_and_zero_health_play_from_the_counters() {
    let mut runtime = remote();
    hold(&mut runtime, SoldierNet { shots: 1, ..standing() }, 1);
    assert!(anim(&runtime).contains("fire-a"), "{}", anim(&runtime));
    let yaw = standing().yaw;
    for (k, side) in [(0.0, "hit-front"), (1.0, "hit-right"), (2.0, "hit-back"), (3.0, "hit-left")] {
        hold(&mut runtime, SoldierNet { shots: 1, hits: k as u32 + 1, hit_from: yaw + std::f32::consts::FRAC_PI_2 * k, ..standing() }, 2);
        assert!(anim(&runtime).contains(side), "a hit from {k} quarters plays {side}: {}", anim(&runtime));
    }
    hold(&mut runtime, SoldierNet { hp: 0.0, ..standing() }, 240);
    assert!(anim(&runtime).contains("\"death\""), "{}", anim(&runtime));
}

#[test]
fn two_machines_fed_the_same_replicated_state_show_the_same_soldier() {
    // The server runs the script; the remote machine runs only the kit, given each tick's state.
    let mut server = started();
    let mut client = remote();
    for _ in 0..(30.0 * 60.0) as u32 {
        server.step(FIXED_STEP_MS);
        client.sim_mut().world.soldier = server.sim().world.soldier;
        client.step(FIXED_STEP_MS);
    }
    assert_eq!(kit(&server)["digest"], kit(&client)["digest"]);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_each_animation_from_the_close_camera() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets()) else { return };
    let mut runtime = started();
    runtime.step(FIXED_STEP_MS * 5.0);
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (phase, at, name) in [
        (Phase::Idle, 1.0, "idle"),
        (Phase::Run, 1.0, "run"),
        (Phase::StrafeRight, 1.0, "strafe"),
        (Phase::AimSweep, 1.0, "aim-up"),
        (Phase::AimSweep, 3.0, "aim-down"),
        (Phase::Fire, 0.52, "fire"),
        (Phase::Reload, 0.8, "reload"),
        (Phase::Hits, 0.67, "hit"),
        (Phase::Death, 3.0, "death"),
    ] {
        seek(&mut runtime, phase, at);
        let luma = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, &format!("soldier-{name}"));
        assert!((20.0..235.0).contains(&luma), "{name}: {luma}");
    }
    support::shoot(&mut presenter, &mut runtime, View::Named("side"), QualityPreset::High, "soldier-side");
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
