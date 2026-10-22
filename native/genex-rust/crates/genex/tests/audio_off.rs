//! A game built with `[audio] enabled = false` (AU-11): the facade without its `audio` feature
//! links neither kira nor symphonia nor cpal, and the game's code compiles unchanged. Every sound
//! is missing, `ctx.audio` plays nothing and reads nothing, and `state().volatile.audio` says why.
//! Runs only in that build:
//! `cargo test -p genex --no-default-features --features physics --test audio_off`.
#![cfg(not(feature = "audio"))]

use genex::Runtime;
use genex::audio::{AudioSetup, ReverbPreset, ReverbZone, Sound, ZoneShape};
use genex::prelude::*;

const TONE: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/tone.wav");
const TONE_TABLE: &[(&str, &[u8])] = &[("sfx/tone.wav", TONE)];
const STEP_MS: f64 = 1000.0 / 60.0;
const TICKS: u64 = 6;
/// A cave zone around the origin.
const CAVE: ReverbZone = ReverbZone {
    name: "cave",
    shape: ZoneShape::Sphere { center: Vec3::ZERO, radius: 10.0 },
    preset: ReverbPreset::CAVE,
    send_db: -6.0,
    uniformity: 1.0,
};

#[derive(Default)]
struct World {
    sound: Option<Sound>,
    voices: Vec<Voice>,
    playing: Vec<bool>,
    positions: Vec<Option<f32>>,
    zones: Vec<genex::audio::ZoneId>,
}

/// A game that loads the tone at reset and plays it, adds a zone and reads it back every tick.
fn tone_game(setup: bool) -> Game<World> {
    let mut game = Game::new(World::default());
    if setup {
        game.audio(AudioSetup::default());
    }
    game.on_reset(|sim, _, _, gfx| sim.world.sound = Some(gfx.sound("sfx/tone.wav")));
    game.on_update(|sim, ctx| {
        let world = &mut sim.world;
        let sound = world.sound.as_ref().expect("loaded at reset");
        let voice = ctx.audio.play(sound);
        world.voices.push(voice);
        world.playing.push(ctx.audio.playing(voice));
        world.positions.push(ctx.audio.position_s(voice));
        world.zones.push(ctx.audio.add_zone(CAVE));
        ctx.audio.stop(voice, 0.1);
    });
    game
}

fn run(setup: bool) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(tone_game(setup), Box::new(TONE_TABLE)).expect("installs");
    runtime.step(TICKS as f64 * STEP_MS);
    runtime
}

/// AU-11 red row: `ctx.audio.play` answers `Voice::NONE` and `playing` false, with or without a
/// `game.audio` setup; no zone id is issued and the level is silence.
#[test]
fn ctx_audio_plays_nothing_without_the_audio_feature() {
    for setup in [false, true] {
        let runtime = run(setup);
        let world = &runtime.sim().world;
        assert_eq!(world.voices.len() as u64, TICKS, "setup {setup}");
        assert!(world.voices.iter().all(|voice| *voice == Voice::NONE), "setup {setup}: {:?}", world.voices);
        assert!(world.playing.iter().all(|playing| !playing), "setup {setup}: {:?}", world.playing);
        assert!(world.positions.iter().all(Option::is_none), "setup {setup}: {:?}", world.positions);
        assert!(world.zones.iter().all(|zone| *zone == genex::audio::ZoneId::default()), "setup {setup}");
        assert_eq!(runtime.audio_logical_hash(), 0, "setup {setup}");
        let level = runtime.audio_level();
        assert_eq!((level.rms.to_bits(), level.centroid.to_bits()), (0, 0), "setup {setup}");
    }
}

/// Every sound is missing with the typed refusal `audio-disabled`, and `state().volatile.audio`
/// names it, so an agent reading state sees why the game is silent.
#[test]
fn a_sound_is_missing_as_audio_disabled_and_state_says_so() {
    use genex::audio::{AudioErrorCode, SoundRefusal};
    let runtime = run(false);
    let sound = runtime.sim().world.sound.clone().expect("loaded at reset");
    assert!(sound.is_missing());
    assert_eq!(sound.refusal(), Some(SoundRefusal::Audio(AudioErrorCode::Disabled)));
    assert_eq!(sound.refusal().map(SoundRefusal::as_str), Some("audio-disabled"));
    assert_eq!(sound.seconds(), 0.0);
    let audio = runtime.state()["volatile"]["audio"].clone();
    assert_eq!(audio, json!({ "enabled": false, "issues": [{ "path": "sfx/tone.wav", "code": "audio-disabled" }] }));
}

/// A game that asks for no sound shows no `volatile.audio` in this build either.
#[test]
fn a_game_without_sounds_shows_no_audio_state() {
    let mut runtime = Runtime::new(Game::new(World::default())).expect("installs");
    runtime.step(3.0 * STEP_MS);
    assert_eq!(runtime.state()["volatile"].get("audio"), None);
}

/// The shell's device is never opened, and the open asks for no queue.
#[test]
fn the_device_never_opens() {
    let mut device = genex::audio::Device::default();
    let opened = device.open_once_where(false, || panic!("no queue is made without audio"));
    assert!(!opened);
    assert!(device.tried());
    assert_eq!(device.fault(), None);
}
