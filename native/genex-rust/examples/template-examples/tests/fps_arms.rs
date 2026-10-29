//! The first-person arms kit (`src/game-template-rust/docs/examples/fps-arms`) as a game gets it:
//! the GLB beside the example (`fps-arms.glb`, made by `fps_arms.py` in Blender) at
//! `kits/fps-arms.glb`, wired as its `main.rs` wires it. Aiming puts the rear notch and the front
//! post on the view's centre, a reload takes the magazine out of the well and seats a new one, the
//! trigger fires at 600 rounds a minute and clicks on an empty magazine, and (on the host GPU)
//! captures of the hip, the sights, the reload with the magazine out and a shot:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test fps_arms -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/fps-arms/src/game.rs"]
mod game;
#[path = "../../../../../src/game-template-rust/docs/examples/fps-arms/src/facets/rifle.rs"]
mod rifle;
#[path = "../../../../../src/game-template-rust/docs/examples/fps-arms/src/facets/viewmodel.rs"]
mod viewmodel;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Input, Key, Runtime, Value, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/fps-arms/genex.toml");
const KIT_GLB: &[u8] = include_bytes!("../../../../../src/game-template-rust/docs/examples/fps-arms/fps-arms.glb");
const WORLD_SIZE: [u32; 2] = [1280, 720];
/// The Reload clip's moment the old magazine is held clear of the well, and its whole length.
const MAGAZINE_CLEAR_TICKS: f64 = 45.0;
const RELOAD_TICKS: f64 = 160.0;

/// The set as its `main.rs` wires it, with its genex.toml's `[render]`.
fn fps_arms() -> Game<World> {
    let mut game = Game::new(World::default()).title("FPS arms").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    rifle::wire(&mut game);
    viewmodel::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets() -> genex::AssetTable {
    support::assets(&[(viewmodel::KIT, KIT_GLB.to_vec())])
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(fps_arms(), Box::new(assets())).expect("the set installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

/// Hold `key` for `ticks`, then let it go.
fn hold(runtime: &mut Runtime<World>, key: Key, ticks: f64) {
    runtime.inject(Input::key_down(key));
    runtime.step(FIXED_STEP_MS * ticks);
    runtime.inject(Input::key_up(key));
}

fn view_model(runtime: &Runtime<World>) -> Value {
    runtime.state()["viewmodel"].clone()
}

/// Both sights' angles off the view's centre line, in degrees.
fn sights_off_axis(runtime: &Runtime<World>) -> [f64; 2] {
    let sights = view_model(runtime)["sightsOffAxisDeg"].clone();
    [sights[0].as_f64().expect("the rear notch"), sights[1].as_f64().expect("the front post")]
}

fn magazine_out(runtime: &Runtime<World>) -> f64 {
    view_model(runtime)["magazineOutM"].as_f64().expect("the magazine's distance from its seat")
}

#[test]
fn the_kit_loads_its_rig_and_plays_its_graph() {
    let runtime = started();
    let state = view_model(&runtime);
    assert_eq!(state["kit"], true, "{state}");
    assert!(state["anim"].to_string().contains("idle"), "the base layer starts idle: {}", state["anim"]);
}

#[test]
fn aiming_puts_the_rear_notch_and_the_front_post_on_the_view_centre() {
    let mut runtime = started();
    let hip = sights_off_axis(&runtime);
    assert!(hip.iter().all(|deg| *deg > 3.0), "at the hip the sights sit off the centre: {hip:?}");
    runtime.inject(Input::key_down(Key::Mouse2));
    runtime.step(FIXED_STEP_MS * 60.0);
    let aimed = sights_off_axis(&runtime);
    assert!(aimed.iter().all(|deg| *deg < 0.3), "down the sights both sit on the centre: {aimed:?} ({})", view_model(&runtime)["anim"]);
    assert!(runtime.state()["player"]["aim"].as_f64() > Some(0.99));
}

#[test]
fn a_reload_takes_the_magazine_out_of_the_well_and_seats_a_new_one() {
    let mut runtime = started();
    hold(&mut runtime, Key::Mouse1, 30.0);
    runtime.step(FIXED_STEP_MS * 20.0);
    let fired = runtime.state()["rifle"].clone();
    assert!(fired["rounds"].as_u64() < Some(30), "{fired}");
    assert!(magazine_out(&runtime) < 0.002, "the magazine starts seated");
    hold(&mut runtime, Key::KeyR, 1.0);
    runtime.step(FIXED_STEP_MS * MAGAZINE_CLEAR_TICKS);
    let out = magazine_out(&runtime);
    assert!(out > 0.1, "mid-reload the magazine is clear of the well: {out} m ({})", view_model(&runtime)["anim"]);
    assert_eq!(runtime.state()["rifle"]["rounds"], fired["rounds"], "the rounds count only once the new magazine is in");
    runtime.step(FIXED_STEP_MS * (RELOAD_TICKS - MAGAZINE_CLEAR_TICKS));
    let rifle = runtime.state()["rifle"].clone();
    assert_eq!(rifle["rounds"], 30, "{rifle}");
    assert_eq!(rifle["reloading"], false, "{rifle}");
    assert!(magazine_out(&runtime) < 0.002, "the new magazine is seated: {}", magazine_out(&runtime));
}

#[test]
fn the_trigger_fires_at_600_a_minute_and_clicks_on_an_empty_magazine() {
    let mut runtime = started();
    hold(&mut runtime, Key::Mouse1, 60.0);
    let fired = runtime.state()["rifle"]["fired"].as_u64().unwrap_or(0);
    assert!((10..=11).contains(&fired), "a second of trigger fires ten rounds: {fired}");
    hold(&mut runtime, Key::Mouse1, 200.0);
    runtime.step(FIXED_STEP_MS * 10.0);
    assert_eq!(runtime.state()["rifle"]["rounds"], 0);
    hold(&mut runtime, Key::Mouse1, 2.0);
    let anim = view_model(&runtime)["anim"].to_string();
    assert!(anim.contains("dry"), "an empty magazine clicks: {anim}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_hip_the_sights_the_reload_and_a_shot_capture() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets()) else { return };
    let mut runtime = started();
    assert!(presenter.install_for(&mut runtime).is_empty());
    runtime.step(FIXED_STEP_MS * 30.0);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-arms-idle");
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::Low, "fps-arms-idle");
    runtime.inject(Input::key_down(Key::Mouse2));
    runtime.step(FIXED_STEP_MS * 60.0);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-arms-ads");
    runtime.inject(Input::key_down(Key::Mouse1));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::key_up(Key::Mouse1));
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-arms-ads-fire");
    runtime.inject(Input::key_up(Key::Mouse2));
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime.inject(Input::key_down(Key::Mouse1));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::key_up(Key::Mouse1));
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-arms-fire");
    runtime.step(FIXED_STEP_MS * 20.0);
    hold(&mut runtime, Key::KeyR, 1.0);
    runtime.step(FIXED_STEP_MS * MAGAZINE_CLEAR_TICKS);
    assert!(magazine_out(&runtime) > 0.1);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-arms-reload");
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
