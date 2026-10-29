//! The third-person example (`src/game-template-rust/docs/examples/third-person`) as a game gets
//! it: the keys walk the hero along the camera's ground directions and the capsule turns to face
//! its walk, mouse look orbits the camera, a click plays the slash on the upper body to its `hit`
//! event, the boom pulls in when the camera turns to face a pillar behind it, and (on the host GPU)
//! captures from behind the hero and over the yard:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test third_person -- --ignored metal --nocapture
//!
//! The hero is the characters example's mannequin, whose clips already carry the example's names.

#[path = "../../../../../src/game-template-rust/docs/examples/third-person/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Input, Key, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/third-person/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

fn third_person() -> Game<World> {
    let mut game = Game::new(World::default()).title("Third person").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets(hero: bool) -> genex::AssetTable {
    let glb = if hero { vec![("characters/hero.glb", characters_game::mannequin::glb())] } else { Vec::new() };
    support::assets(&glb)
}

fn started(hero: bool) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(third_person(), Box::new(assets(hero))).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

fn hold(runtime: &mut Runtime<World>, key: Key, ticks: f64) {
    runtime.inject(Input::key_down(key));
    runtime.step(FIXED_STEP_MS * ticks);
    runtime.inject(Input::key_up(key));
}

fn number(value: &genex::Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("a number: {value}"))
}

#[test]
fn the_yard_and_the_rigged_hero_draw_and_a_missing_glb_draws_the_stand_in() {
    for hero in [true, false] {
        let mut runtime = started(hero);
        let frame = runtime.frame(View::Game).expect("a frame");
        let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
        for tag in ["yard", "hero"] {
            assert!(tags.contains(&tag), "the example draws {tag} (glb: {hero})");
        }
        let anim = &runtime.state()["hero"]["anim"];
        assert_eq!(anim.is_null(), !hero, "the animator is built exactly when the GLB is there: {anim}");
    }
}

#[test]
fn w_walks_the_hero_away_from_the_camera_and_a_look_orbits_the_camera_round_it() {
    let mut runtime = started(true);
    let start = runtime.state()["player"].clone();
    hold(&mut runtime, Key::KeyW, 60.0);
    let walked = runtime.state()["player"].clone();
    assert!(number(&walked["z"]) < number(&start["z"]) - 1.2, "a second of W walks north, away from the camera: {start} -> {walked}");
    assert!(runtime.state()["hero"]["anim"].to_string().contains("walk"), "the rig walks: {}", runtime.state()["hero"]["anim"]);
    runtime.inject(Input::look(300.0, 0.0));
    runtime.step(FIXED_STEP_MS);
    let turned = runtime.state()["player"].clone();
    assert!(number(&turned["yaw"]) < number(&walked["yaw"]) - 1.0, "a look right turns the camera: {walked} -> {turned}");
    hold(&mut runtime, Key::KeyW, 60.0);
    let after = runtime.state()["player"].clone();
    assert!(number(&after["x"]) > number(&turned["x"]) + 0.8, "after the turn W walks east, where the camera now looks: {turned} -> {after}");
}

#[test]
fn a_click_plays_the_slash_to_its_hit_event_over_the_walk() {
    let mut runtime = started(true);
    runtime.inject(Input::key_down(Key::KeyW));
    hold(&mut runtime, Key::Mouse1, 1.0);
    runtime.step(FIXED_STEP_MS * 60.0);
    runtime.inject(Input::key_up(Key::KeyW));
    let hero = runtime.state()["hero"].clone();
    assert_eq!(hero["attacks"], 1, "{hero}");
    assert_eq!(hero["hits"], 1, "the slash reached its hit event once: {hero}");
}

#[test]
fn the_boom_pulls_in_when_a_pillar_comes_between_the_camera_and_the_hero_and_lets_out_after() {
    let mut runtime = started(true);
    assert!(number(&runtime.state()["hero"]["boom"]) > 4.4, "nothing behind the hero at the start");
    // Half a turn: the camera now looks south, its boom reaching north into the pillar 2.6 m away.
    runtime.inject(Input::look(std::f32::consts::PI / 0.004, 0.0));
    runtime.step(FIXED_STEP_MS);
    let boom = number(&runtime.state()["hero"]["boom"]);
    assert!((0.6..2.6).contains(&boom), "the boom stops short of the pillar: {boom}");
    runtime.inject(Input::look(-std::f32::consts::PI / 0.004, 0.0));
    runtime.step(FIXED_STEP_MS * 120.0);
    assert!(number(&runtime.state()["hero"]["boom"]) > 4.3, "it lets out again once the pillar is gone");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_hero_captures_from_behind_and_over_the_yard() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets(true)) else { return };
    let mut runtime = started(true);
    assert!(presenter.install_for(&mut runtime).is_empty());
    runtime.inject(Input::look(-120.0, 30.0));
    runtime.inject(Input::key_down(Key::KeyW));
    runtime.step(FIXED_STEP_MS * 50.0);
    hold(&mut runtime, Key::Mouse1, 1.0);
    runtime.step(FIXED_STEP_MS * 12.0);
    runtime.inject(Input::key_up(Key::KeyW));
    for preset in [QualityPreset::Low, QualityPreset::High] {
        for (view, name) in [(View::Game, "third-person"), (View::Named("yard"), "third-person-yard")] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
