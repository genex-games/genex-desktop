//! The system switches (release R-1): a game's genex.toml `[nav]`, `[streaming]` and `[animation]`
//! `enabled = false` build the facade without that cargo feature. The surface stays, so the
//! game's code compiles unchanged, and what the switched-off system would do is refused with a
//! typed code. Every row runs in every feature set: run it with `--no-default-features` (and
//! `--features physics,audio`) for the switched-off side.

use genex::nav::NavConfig;
use genex::prelude::*;
use genex::{AnimationErrorCode, FIXED_STEP_MS, InstallErrorCode, Runtime, Streaming};

#[derive(Default)]
struct World {
    ticks: u32,
    refusals: Vec<String>,
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_update(|sim, _| sim.world.ticks += 1);
    game.probe("ticks", |sim| json!(sim.world.ticks));
    game
}

/// The install code `game` is refused with, or None when it installs.
fn refusal(game: Game<World>) -> Option<InstallErrorCode> {
    Runtime::new(game).err().map(|error| error.code())
}

#[test]
fn navigation_is_refused_nav_disabled_in_a_build_without_nav() {
    let mut registered = game();
    registered.navigation(NavConfig::walker(0.4, 1.8));
    let expected = if cfg!(feature = "nav") { None } else { Some(InstallErrorCode::NavDisabled) };
    assert_eq!(refusal(registered), expected);
}

#[test]
fn a_nav_bake_is_refused_nav_disabled_in_a_build_without_nav() {
    let mut registered = game();
    registered.nav_bake("yard", |_| genex::nav::NavInput::new());
    let expected = if cfg!(feature = "nav") { None } else { Some(InstallErrorCode::NavDisabled) };
    assert_eq!(refusal(registered), expected);
}

#[test]
fn streaming_is_refused_streaming_disabled_in_a_build_without_streaming() {
    let mut registered = game();
    registered.streaming(Streaming::grid(32.0));
    let expected = if cfg!(feature = "streaming") { None } else { Some(InstallErrorCode::StreamingDisabled) };
    assert_eq!(refusal(registered), expected);
}

#[test]
fn the_switch_refusals_have_their_wire_spellings() {
    assert_eq!(InstallErrorCode::NavDisabled.as_str(), "nav-disabled");
    assert_eq!(InstallErrorCode::StreamingDisabled.as_str(), "streaming-disabled");
    assert_eq!(AnimationErrorCode::Disabled.wire(), "animation-disabled");
}

#[test]
fn a_character_and_node_clips_are_refused_animation_disabled_in_a_build_without_animation() {
    let mut asks = game();
    asks.on_reset(|sim, _, _, gfx| {
        let character = gfx.character("hero.glb").expect_err("no file and, without animation, no rig");
        let clips = gfx.node_clips("door.glb").expect_err("no file and, without animation, no clips");
        sim.world.refusals = vec![character.code.wire().to_owned(), clips.code.wire().to_owned()];
    });
    asks.probe("refusals", |sim| json!(sim.world.refusals));
    let mut runtime = Runtime::new(asks).expect("installs: asking for a character is not a registration");
    runtime.seed(1);
    // With animation, a file the build lacks is the asset's refusal; without, nothing is read.
    let expected = if cfg!(feature = "animation") { ["animation-asset-invalid", "animation-asset-invalid"] } else { ["animation-disabled"; 2] };
    assert_eq!(runtime.probes()["refusals"], json!(expected));
}

#[test]
fn a_game_using_no_switched_system_runs_the_same_in_every_build() {
    let mut runtime = Runtime::new(game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(600.0 * FIXED_STEP_MS);
    assert_eq!(runtime.probes()["ticks"], json!(600));
    let state = runtime.state();
    assert!(state.get("__stream").is_none(), "no streaming key without game.streaming");
    // `sim.nav` and `sim.stream` stay in every build: empty, unregistered.
    assert!(!runtime.sim().stream.registered());
}
