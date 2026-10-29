//! The explosion example (`src/game-template-rust/docs/examples/explosion`) as a game gets it: Space
//! sets the barrel off, and on that tick the fireball, the flash, the fire and the sparks draw, the
//! bang plays where the barrel stood, the camera's trauma is full and the crates are thrown; the
//! smoke thins and goes, a new barrel stands there five seconds on, and (on the host GPU) captures
//! before, during and after the blast:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test explosion -- --ignored metal --nocapture
//!
//! The bang is a WAV written here: a second of decaying noise over a low thump.

#[path = "../../../../../src/game-template-rust/docs/examples/explosion/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Input, Key, Runtime, View, json};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/explosion/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];
const SOUND: &str = "sfx/explosion.wav";

/// A mono 16-bit WAV at 22,050 Hz: noise and a 50 Hz thump under an exponential decay.
fn bang_wav() -> Vec<u8> {
    const RATE: u32 = 22_050;
    let mut noise = 0x2545_f491_u32;
    let samples: Vec<i16> = (0..RATE)
        .map(|n| {
            noise ^= noise << 13;
            noise ^= noise >> 17;
            noise ^= noise << 5;
            let t = n as f32 / RATE as f32;
            let white = noise as f32 / u32::MAX as f32 * 2.0 - 1.0;
            let thump = genex::math::sin(t * 50.0 * std::f32::consts::TAU);
            ((0.6 * white + 0.5 * thump) * genex::math::exp(-5.0 * t) * 26_000.0) as i16
        })
        .collect();
    let data = samples.len() as u32 * 2;
    let mut wav = Vec::with_capacity(44 + data as usize);
    wav.extend(b"RIFF");
    wav.extend((36 + data).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16_u32.to_le_bytes());
    wav.extend(1_u16.to_le_bytes());
    wav.extend(1_u16.to_le_bytes());
    wav.extend(RATE.to_le_bytes());
    wav.extend((RATE * 2).to_le_bytes());
    wav.extend(2_u16.to_le_bytes());
    wav.extend(16_u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend(data.to_le_bytes());
    wav.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    wav
}

fn explosion() -> Game<World> {
    let mut game = Game::new(World::default()).title("Explosion").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets() -> genex::AssetTable {
    support::assets(&[(SOUND, bang_wav())])
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(explosion(), Box::new(assets())).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 60.0);
    runtime
}

fn detonate(runtime: &mut Runtime<World>) {
    runtime.inject(Input::key_down(Key::Space));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::key_up(Key::Space));
}

/// The frame's tags (particles are one logical draw each) and its point lights.
fn tags(runtime: &mut Runtime<World>) -> Vec<String> {
    let frame = runtime.frame(View::Game).expect("a frame");
    let lights = frame.lights().points.len();
    frame.tags().keys().cloned().chain((lights > 0).then(|| "flash".to_owned())).collect()
}

fn number(value: &genex::Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("a number: {value}"))
}

#[test]
fn space_sets_the_barrel_off_with_every_part_of_the_blast_on_one_tick() {
    let mut runtime = started();
    let before = tags(&mut runtime);
    for tag in ["yard", "crates", "barrel"] {
        assert!(before.iter().any(|t| t == tag), "the yard draws {tag}");
    }
    assert!(!before.iter().any(|t| t == "fireball"), "nothing burns before the blast");
    let spread = number(&runtime.state()["blast"]["spread"]);
    detonate(&mut runtime);
    let during = tags(&mut runtime);
    for tag in ["fireball", "flash", "fire", "sparks"] {
        assert!(during.iter().any(|t| t == tag), "the blast draws {tag}: {during:?}");
    }
    assert!(!during.iter().any(|t| t == "barrel"), "the barrel is gone");
    let state = runtime.state();
    let blast = &state["blast"];
    assert_eq!(blast["detonations"], 1, "{blast}");
    assert_eq!(blast["trauma"], 1.0, "the camera shakes at full trauma: {blast}");
    assert_eq!(blast["sound"], true, "{blast}");
    assert!(blast["pushed"].as_u64() >= Some(15), "the blast reaches every crate: {blast}");
    let events = state["volatile"]["audio"]["events"].as_array().cloned().unwrap_or_default();
    assert!(events.iter().any(|event| event["code"] == json!("played") && event["sound"] == json!(SOUND)), "the bang played: {events:?}");
    runtime.step(FIXED_STEP_MS * 60.0);
    let thrown = number(&runtime.state()["blast"]["spread"]);
    assert!(thrown > spread + 1.0, "the crates are thrown out: {spread} -> {thrown}");
}

#[test]
fn the_smoke_thins_and_goes_and_a_new_barrel_stands_there_after() {
    let mut runtime = started();
    detonate(&mut runtime);
    runtime.step(FIXED_STEP_MS * 30.0);
    let smoking = tags(&mut runtime);
    assert!(smoking.iter().any(|t| t == "smoke"), "smoke after half a second: {smoking:?}");
    assert!(!smoking.iter().any(|t| t == "fire" || t == "flash"), "the fire and the flash are over: {smoking:?}");
    runtime.step(FIXED_STEP_MS * 210.0);
    let clear = tags(&mut runtime);
    for gone in ["smoke", "sparks", "fireball"] {
        assert!(!clear.iter().any(|t| t == gone), "{gone} is gone four seconds on: {clear:?}");
    }
    assert_eq!(runtime.state()["blast"]["armed"], false, "no barrel yet");
    runtime.step(FIXED_STEP_MS * 70.0);
    assert_eq!(runtime.state()["blast"]["armed"], true, "a new barrel five seconds on");
    detonate(&mut runtime);
    assert_eq!(runtime.state()["blast"]["detonations"], 2);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_yard_captures_before_during_and_after_the_blast() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets()) else { return };
    let mut runtime = started();
    assert!(presenter.install_for(&mut runtime).is_empty());
    for preset in [QualityPreset::Low, QualityPreset::High] {
        let luma = support::shoot(&mut presenter, &mut runtime, View::Game, preset, "explosion-before");
        assert!((20.0..235.0).contains(&luma), "the yard is neither black nor blown out: {luma}");
    }
    detonate(&mut runtime);
    runtime.step(FIXED_STEP_MS * 3.0);
    for (view, name) in [(View::Game, "explosion-fireball"), (View::Named("close"), "explosion-close")] {
        let luma = support::shoot(&mut presenter, &mut runtime, view, QualityPreset::High, name);
        eprintln!("{name}: mean luma {luma:.1}");
    }
    runtime.step(FIXED_STEP_MS * 20.0);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "explosion-sparks");
    runtime.step(FIXED_STEP_MS * 60.0);
    let luma = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "explosion-smoke");
    assert!((20.0..235.0).contains(&luma), "the smoke is neither black nor blown out: {luma}");
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
