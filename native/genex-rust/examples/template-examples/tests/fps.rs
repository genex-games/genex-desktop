//! The FPS facet set (`src/game-template-rust/docs/examples/fps`) as a game gets it, wired as its
//! `main.rs` wires it: mouse look turns the view, the keys walk the capsule, three hitscan shots
//! drop the rigged enemy into its death clip, and (on the host GPU) captures of the view model,
//! the muzzle flash and the fallen enemy:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test fps -- --ignored metal --nocapture
//!
//! The enemy is the characters example's mannequin with three of its clips renamed to the set's
//! names (Slash plays as Fire, Run as Hit, Climb as Death): the rows prove the wiring, not the art.

#[path = "../../../../../src/game-template-rust/docs/examples/fps/src/game.rs"]
mod game;
#[path = "../../../../../src/game-template-rust/docs/examples/fps/src/facets/viewmodel.rs"]
mod viewmodel;
#[path = "../../../../../src/game-template-rust/docs/examples/fps/src/facets/weapon.rs"]
mod weapon;
#[path = "../../../../../src/game-template-rust/docs/examples/fps/src/facets/enemy.rs"]
mod enemy;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Input, Key, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/fps/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

/// The mannequin as `characters/enemy.glb`: the same bytes with clips renamed in place (each new
/// name padded with JSON whitespace to the old one's length, so no chunk length moves).
fn enemy_glb() -> Vec<u8> {
    let mut glb = characters_game::mannequin::glb();
    for (from, to) in [(r#""name":"Slash""#, r#""name":"Fire" "#), (r#""name":"Run""#, r#""name":"Hit""#), (r#""name":"Climb""#, r#""name":"Death""#)] {
        let at = glb.windows(from.len()).position(|window| window == from.as_bytes()).unwrap_or_else(|| panic!("the mannequin has {from}"));
        glb[at..at + from.len()].copy_from_slice(to.as_bytes());
    }
    glb
}

/// A bullet hole: a dark core and a ragged grey rim on a transparent square, 64 texels.
fn bullet_hole_png() -> Vec<u8> {
    const SIDE: u32 = 64;
    let mut rgba = Vec::with_capacity((SIDE * SIDE * 4) as usize);
    for y in 0..SIDE {
        for x in 0..SIDE {
            let (dx, dy) = (x as f32 - 31.5, y as f32 - 31.5);
            let r = (dx * dx + dy * dy).sqrt() / 32.0 + 0.06 * genex::math::sin(genex::math::atan2(dy, dx) * 7.0);
            let (shade, alpha) = if r < 0.28 { (12, 255) } else if r < 0.75 { (70, ((0.75 - r) / 0.47 * 230.0) as u8) } else { (0, 0) };
            rgba.extend([shade, shade, shade, alpha]);
        }
    }
    let mut png = Vec::new();
    image::write_buffer_with_format(&mut std::io::Cursor::new(&mut png), &rgba, SIDE, SIDE, image::ExtendedColorType::Rgba8, image::ImageFormat::Png).expect("png");
    png
}

/// The set as its `main.rs` wires it, with its genex.toml's `[render]`.
fn fps() -> Game<World> {
    let mut game = Game::new(World::default()).title("FPS").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    viewmodel::wire(&mut game);
    weapon::wire(&mut game);
    enemy::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets() -> genex::AssetTable {
    support::assets(&[("characters/enemy.glb", enemy_glb()), ("decals/bullet-hole.png", bullet_hole_png())])
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(fps(), Box::new(assets())).expect("the set installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

/// Pull the trigger once: press, a tick, release, then let the cooldown pass.
fn shoot(runtime: &mut Runtime<World>) {
    runtime.inject(Input::key_down(Key::Mouse1));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::key_up(Key::Mouse1));
    runtime.step(FIXED_STEP_MS * 10.0);
}

#[test]
fn the_enemy_loads_its_rig_and_plays_its_graph() {
    let runtime = started();
    let state = runtime.state();
    assert_ne!(state["enemy"]["anim"], genex::Value::Null, "the enemy's animator is built: {}", state["enemy"]);
    assert_eq!(state["enemy"]["health"], 3);
}

#[test]
fn mouse_look_turns_the_view_and_the_keys_walk_the_capsule() {
    let mut runtime = started();
    let before = runtime.state()["player"].clone();
    runtime.inject(Input::look(120.0, -40.0));
    runtime.step(FIXED_STEP_MS);
    let turned = runtime.state()["player"].clone();
    assert!(turned["yaw"].as_f64() > before["yaw"].as_f64(), "a look right turns the yaw up: {before} -> {turned}");
    assert!(turned["pitch"].as_f64() > before["pitch"].as_f64(), "a look up tilts the view up");
    runtime.inject(Input::key_down(Key::KeyW));
    runtime.step(FIXED_STEP_MS * 60.0);
    runtime.inject(Input::key_up(Key::KeyW));
    let walked = runtime.state()["player"].clone();
    let moved = (walked["x"].as_f64().unwrap_or(0.0) - turned["x"].as_f64().unwrap_or(0.0)).hypot(walked["z"].as_f64().unwrap_or(0.0) - turned["z"].as_f64().unwrap_or(0.0));
    assert!(moved > 1.5, "a second of W walks the capsule: {moved} m");
}

/// WP-3: the example's sprint used to bob 4 cm at 14 Hz with a cusp at every step. On
/// `FirstPersonRig` the camera's probe (`state().volatile.camera`) stays under the comfort caps on
/// a held sprint: cadence below 3 Hz, bob at most 3 cm peak to peak, roll at most 1.5°.
#[test]
fn a_held_sprint_keeps_the_camera_under_the_comfort_caps() {
    let mut runtime = started();
    runtime.inject(Input::key_down(Key::ShiftLeft));
    runtime.inject(Input::key_down(Key::KeyW));
    runtime.step(FIXED_STEP_MS * 60.0);
    let (mut bobs, mut cadence, mut roll) = (Vec::new(), 0.0f64, 0.0f64);
    for _ in 0..120 {
        runtime.step(FIXED_STEP_MS);
        let camera = runtime.state()["volatile"]["camera"].clone();
        bobs.push(camera["bobM"].as_f64().expect("the camera probe's bob"));
        cadence = cadence.max(camera["cadenceHz"].as_f64().expect("its cadence"));
        roll = roll.max(camera["rollDeg"].as_f64().expect("its roll").abs());
    }
    let peak_to_peak = bobs.iter().copied().fold(f64::NEG_INFINITY, f64::max) - bobs.iter().copied().fold(f64::INFINITY, f64::min);
    assert!(cadence > 2.0 && cadence < 3.0, "the sprint's step rate is {cadence:.2} Hz");
    assert!(peak_to_peak > 0.01 && peak_to_peak <= 0.03, "the sprint bobs {peak_to_peak:.4} m peak to peak");
    assert!(roll <= 1.5, "and rolls {roll:.2}°");
}

#[test]
fn three_hitscan_shots_drop_the_enemy_into_its_death_clip_and_it_stays_down() {
    let mut runtime = started();
    for _ in 0..3 {
        shoot(&mut runtime);
    }
    let state = runtime.state();
    assert_eq!(state["weapon"]["fired"], 3, "{}", state["weapon"]);
    assert_eq!(state["enemy"]["dead"], true, "three hits kill it: {}", state["enemy"]);
    runtime.step(FIXED_STEP_MS * 180.0);
    let anim = runtime.state()["enemy"]["anim"].to_string();
    assert!(anim.contains("death"), "it holds its death state: {anim}");
    shoot(&mut runtime);
    assert_eq!(runtime.state()["weapon"]["hits"], 4, "a shot past the body hits the wall behind it");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_view_model_the_flash_and_the_fallen_enemy_capture() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets()) else { return };
    let mut runtime = started();
    assert!(presenter.install_for(&mut runtime).is_empty());
    // Walk up to the cover, so the enemy fills more of the frame.
    runtime.inject(Input::key_down(Key::KeyW));
    runtime.step(FIXED_STEP_MS * 120.0);
    runtime.inject(Input::key_up(Key::KeyW));
    runtime.step(FIXED_STEP_MS * 30.0);
    for preset in [QualityPreset::Low, QualityPreset::High] {
        support::shoot(&mut presenter, &mut runtime, View::Game, preset, "fps-aim");
        support::shoot(&mut presenter, &mut runtime, View::Named("hall"), preset, "fps-hall");
    }
    runtime.inject(Input::key_down(Key::Mouse1));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::key_up(Key::Mouse1));
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-fire");
    runtime.step(FIXED_STEP_MS * 10.0);
    shoot(&mut runtime);
    shoot(&mut runtime);
    runtime.step(FIXED_STEP_MS * 120.0);
    assert_eq!(runtime.state()["enemy"]["dead"], true);
    let luma = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "fps-down");
    assert!((15.0..235.0).contains(&luma), "the view is neither black nor blown out: {luma}");
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
