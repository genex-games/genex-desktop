//! The facade's audio (AU-7): `gfx.sound` at reset, `ctx.audio` from the hooks, `game.audio`,
//! the runtime's tick wiring and the host glue the shells and the studio call. Audio is decided
//! logically (genex-audio's Director) and never enters the checksum; `audioLevel` reads the mix.
#![cfg(feature = "audio")]

use genex::audio::{AudioSetup, AudioSettings, Bus, PlayOpts, PoolClass, Sound, SoundRefusal};
use genex::prelude::*;
use genex::{AssetErrorCode, AssetGroup, AssetSource, InstallErrorCode, Runtime};
use std::sync::Arc;

const TONE: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/tone.wav");
const TONE_TABLE: &[(&str, &[u8])] = &[("sfx/tone.wav", TONE)];
/// The tone's `audioLevel` after ten ticks on genex-audio's legacy path (`tests/decode.rs`): rms
/// to four decimals, centroid in whole hertz.
const TONE_LEVEL: (f64, f64) = (0.0886, 459.0);
/// Frames the logical clock advances per tick at pitch 1 (48 kHz / 60).
const FRAMES_PER_TICK: u64 = 800;
const STEP_MS: f64 = 1000.0 / 60.0;

/// A 16-bit mono PCM WAV of `frames` frames of a 440 Hz sine at `rate` Hz, amplitude 1/4.
fn wav(frames: u32, rate: u32) -> &'static [u8] {
    let data_bytes = frames * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for i in 0..frames {
        let phase = 2.0 * std::f64::consts::PI * 440.0 * f64::from(i) / f64::from(rate);
        let sample = (phase.sin() * 0.25 * f64::from(i16::MAX)) as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Box::leak(bytes.into_boxed_slice())
}

fn table(rows: Vec<(&'static str, &'static [u8])>) -> &'static [(&'static str, &'static [u8])] {
    Box::leak(rows.into_boxed_slice())
}

#[derive(Default)]
struct World {
    sound: Option<Sound>,
    voice: Voice,
    /// Ticks on which the update hook read `playing(voice)`.
    heard: Vec<(u64, bool)>,
    spatial: bool,
    quiet: bool,
}

/// A game that loads `path` at reset and plays it on tick 0 (at (4, 0, 0) when `spatial`).
fn tone_game(path: &'static str, spatial: bool) -> Game<World> {
    let mut game = Game::new(World::default());
    game.on_reset(move |sim, _, _, gfx| {
        sim.world.sound = Some(gfx.sound(path));
        sim.world.spatial = spatial;
    });
    game.on_update(|sim, ctx| {
        let world = &mut sim.world;
        if ctx.tick == 0 && !world.quiet {
            let sound = world.sound.as_ref().expect("loaded at reset");
            world.voice = if world.spatial { ctx.audio.play_at(sound, vec3(4.0, 0.0, 0.0)) } else { ctx.audio.play(sound) };
        }
        world.heard.push((ctx.tick, ctx.audio.playing(world.voice)));
    });
    game.probe("ticks", |sim| json!(sim.world.heard.len()));
    game
}

fn runtime(game: Game<World>, assets: &'static [(&'static str, &'static [u8])]) -> Runtime<World> {
    Runtime::with_assets(game, Box::new(assets)).expect("installs")
}

fn volatile_audio(runtime: &Runtime<World>) -> Value {
    runtime.state()["volatile"]["audio"].clone()
}

fn level_bits(runtime: &Runtime<World>) -> (u64, u64) {
    let level = runtime.audio_level();
    (level.rms.to_bits(), level.centroid.to_bits())
}

/// AU-7 red row: a Rust game playing `tone.wav` reads the tone's level from `audioLevel`, not
/// the silence of `AudioLevel::default()` (the studio verb's own row is `metal_audio_level_*` in
/// `studio.rs`).
#[test]
fn a_game_playing_tone_wav_reads_the_fixture_level() {
    let mut runtime = runtime(tone_game("sfx/tone.wav", false), TONE_TABLE);
    runtime.step(10.0 * STEP_MS);
    let level = runtime.audio_level().reported();
    assert!((level.rms - TONE_LEVEL.0).abs() < 0.005, "the tone, not silence: {level:?}");
    assert!((level.centroid - TONE_LEVEL.1).abs() < 30.0, "near the tone's centroid: {level:?}");
    let audio = volatile_audio(&runtime);
    assert_eq!(audio["voices"][0]["sound"], json!("sfx/tone.wav"), "{audio}");
    assert_eq!(audio["counts"]["played"], json!(1), "{audio}");
    assert_eq!(audio["device"]["open"], json!(false), "a test never opens a device: {audio}");
}

/// A game that asks for no sound runs no audio: no `volatile.audio`, a silent level, no state.
#[test]
fn a_game_without_audio_has_no_audio_state_and_reads_silence() {
    let mut game = Game::new(World::default());
    game.on_update(|sim, ctx| sim.world.heard.push((ctx.tick, ctx.audio.playing(Voice::NONE))));
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.step(5.0 * STEP_MS);
    assert_eq!(runtime.state()["volatile"].get("audio"), None);
    assert_eq!(level_bits(&runtime), (0, 0));
    assert_eq!(runtime.audio_logical_hash(), 0);
}

/// Audio never enters the checksum: the same game with and without `ctx.audio` calls has equal
/// checksums on every tick.
#[test]
fn checksums_are_equal_with_and_without_audio_calls() {
    let quiet = |quiet: bool| {
        let mut game = tone_game("sfx/tone.wav", true);
        game.on_reset(move |sim, _, _, _| sim.world.quiet = quiet);
        let mut runtime = runtime(game, TONE_TABLE);
        (0..40).map(|_| {
            runtime.step(STEP_MS);
            runtime.checksum()
        }).collect::<Vec<_>>()
    };
    assert_eq!(quiet(false), quiet(true));
}

/// `seed(2); seed(1)` equals a fresh `seed(1)`: the Director resets and the mixer is rebuilt, so
/// `volatile.audio` and the `audioLevel` bits match.
#[test]
fn reseeding_gives_the_fresh_seeds_audio_and_level_bits() {
    let run = |seeds: &[u32]| {
        let mut runtime = runtime(tone_game("sfx/tone.wav", true), TONE_TABLE);
        for seed in seeds {
            runtime.seed(*seed);
            runtime.step(12.0 * STEP_MS);
        }
        (volatile_audio(&runtime), level_bits(&runtime), runtime.audio_logical_hash())
    };
    let fresh = run(&[1]);
    assert!(fresh.1.0 != 0, "the tone is heard");
    assert_eq!(run(&[2, 1]), fresh);
    assert_eq!(run(&[1]), fresh, "and in a second runtime");
}

/// `ctx.audio.playing` turns false exactly on the tick the logical end passes: a 4,000-frame sound
/// played on tick 0 advances 800 frames a tick, so the hook reads it playing on ticks 1-4 and
/// stopped from tick 5, on every destination and pool class.
#[test]
fn playing_turns_false_on_the_tick_the_logical_end_passes() {
    let frames: u32 = 4_000;
    let assets = table(vec![("sfx/blip.wav", wav(frames, 48_000))]);
    for class in [PoolClass::Desktop, PoolClass::Web, PoolClass::Phone] {
        let mut runtime = runtime(tone_game("sfx/blip.wav", false), assets);
        runtime.set_audio_pool(class);
        runtime.step(10.0 * STEP_MS);
        let end = u64::from(frames).div_ceil(FRAMES_PER_TICK);
        let heard = &runtime.sim().world.heard;
        let playing: Vec<u64> = heard.iter().filter(|(_, playing)| *playing).map(|(tick, _)| *tick).collect();
        assert_eq!(playing, (1..end).collect::<Vec<_>>(), "{class:?}: {heard:?}");
    }
}

/// The ears are the game's own camera: drawing an observer camera's frame between ticks leaves
/// every voice's pan where the game camera puts it (a voice to its right pans right).
#[test]
fn an_observer_camera_never_moves_the_listener() {
    let pans = |observe: bool| {
        let mut game = tone_game("sfx/tone.wav", true);
        game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 10.0), Vec3::ZERO));
        game.named_camera("top", |_| Camera::look_at(vec3(-30.0, 40.0, 0.0), Vec3::ZERO));
        let mut runtime = runtime(game, TONE_TABLE);
        let mut pans = Vec::new();
        for _ in 0..8 {
            runtime.step(STEP_MS);
            if observe {
                runtime.frame(View::Named("top")).expect("the observer camera");
            }
            pans.push(volatile_audio(&runtime)["voices"][0]["pan"].clone());
        }
        pans
    };
    let game_view = pans(false);
    assert!(game_view.iter().all(|pan| pan.as_f64().is_some_and(|pan| pan > 0.1)), "to the camera's right: {game_view:?}");
    assert_eq!(pans(true), game_view);
}

/// An asset source counting its reads, with `named/` paths in a named group.
struct Counted {
    table: &'static [(&'static str, &'static [u8])],
    reads: Arc<std::sync::atomic::AtomicUsize>,
}

impl AssetSource for Counted {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, genex::AssetError> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.table.read(path)
    }
    fn group(&self, path: &str) -> AssetGroup {
        if path.starts_with("named/") { AssetGroup::Named } else { AssetGroup::Sim }
    }
}

/// Hostile and refused paths give a missing sound with nothing read: `../`, absolute and
/// backslash paths are `unsafe-path`, a named group's asset `not-preloaded`, an Opus file
/// `needs-import`, garbage `malformed`; a play of any of them is refused `sound-missing`.
#[test]
fn hostile_and_refused_sound_paths_are_missing_sounds_with_no_read() {
    let assets = table(vec![("sfx/tone.wav", TONE), ("named/tone.wav", TONE), ("sfx/voice.opus", b"OggS\0\x02"), ("sfx/bad.wav", b"RIFFnope")]);
    let rows: [(&str, SoundRefusal, bool); 6] = [
        ("../x.wav", SoundRefusal::Asset(AssetErrorCode::UnsafePath), false),
        ("/etc/x.wav", SoundRefusal::Asset(AssetErrorCode::UnsafePath), false),
        ("sfx\\tone.wav", SoundRefusal::Asset(AssetErrorCode::UnsafePath), false),
        ("named/tone.wav", SoundRefusal::Asset(AssetErrorCode::NotPreloaded), false),
        ("sfx/voice.opus", SoundRefusal::Audio(genex::audio::AudioErrorCode::NeedsImport), true),
        ("sfx/bad.wav", SoundRefusal::Audio(genex::audio::AudioErrorCode::Malformed), true),
    ];
    for (path, refusal, reads_bytes) in rows {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source = Counted { table: assets, reads: Arc::clone(&reads) };
        let seen: Arc<std::sync::Mutex<Option<Sound>>> = Arc::default();
        let kept = Arc::clone(&seen);
        let mut game = Game::new(World::default());
        game.on_reset(move |sim, _, _, gfx| {
            let sound = gfx.sound(path);
            *kept.lock().expect("lock") = Some(sound.clone());
            sim.world.sound = Some(sound);
        });
        game.on_update(|sim, ctx| {
            if ctx.tick == 0 {
                sim.world.voice = ctx.audio.play(sim.world.sound.as_ref().expect("a handle"));
            }
        });
        let mut runtime = Runtime::with_assets(game, Box::new(source)).expect("installs");
        let sound = seen.lock().expect("lock").clone().expect("asked at reset");
        assert!(sound.is_missing(), "{path}");
        assert_eq!(sound.refusal(), Some(refusal), "{path}");
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), usize::from(reads_bytes), "{path}: what was read");
        runtime.step(STEP_MS);
        let audio = volatile_audio(&runtime);
        assert_eq!(audio["events"][0]["code"], json!("refused"), "{path}: {audio}");
        assert_eq!(audio["events"][0]["reason"], json!("sound-missing"), "{path}: {audio}");
        assert_eq!(audio["issues"][0]["code"], json!(refusal.as_str()), "{path}: {audio}");
        let shown = audio["issues"][0]["path"].clone();
        assert!(!shown.as_str().is_some_and(|p| p.contains("..") || p.starts_with('/')), "{path}: a hostile path is never echoed: {audio}");
    }
}

/// A symlink under the asset folder that leaves it is `unsafe-path`: a missing sound, the target
/// never read.
#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_asset_folder_is_a_missing_sound() {
    let dir = std::env::temp_dir().join(format!("genex-audio-link-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let assets = dir.join("assets");
    std::fs::create_dir_all(assets.join("sfx")).expect("assets");
    std::fs::write(dir.join("secret.wav"), TONE).expect("outside file");
    std::os::unix::fs::symlink(dir.join("secret.wav"), assets.join("sfx/out.wav")).expect("link");
    let seen: Arc<std::sync::Mutex<Option<Sound>>> = Arc::default();
    let kept = Arc::clone(&seen);
    let mut game = Game::new(World::default());
    game.on_reset(move |_, _, _, gfx| *kept.lock().expect("lock") = Some(gfx.sound("sfx/out.wav")));
    let source = genex::AssetFiles::new(&[], Some(assets));
    let _runtime = Runtime::with_assets(game, Box::new(source)).expect("installs");
    let sound = seen.lock().expect("lock").clone().expect("asked");
    assert_eq!(sound.refusal(), Some(SoundRefusal::Asset(AssetErrorCode::UnsafePath)));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A wall collider between the camera and an emitter occludes it: `occluded` within two
/// round-robin cycles (one voice is cast every tick) and at least 8 dB down once the 100 ms
/// tween settles; the same game without the wall is open.
#[cfg(feature = "physics")]
#[test]
fn a_wall_collider_occludes_a_voice_behind_it() {
    use genex::physics::ColliderBuilder;
    let run = |wall: bool| {
        let mut game = tone_game("sfx/tone.wav", true);
        game.audio(AudioSetup { occlusion: true, ..AudioSetup::default() });
        game.camera(|_| Camera::look_at(vec3(4.0, 0.0, 10.0), vec3(4.0, 0.0, 0.0)));
        game.on_reset(move |sim, _, _, _| {
            if wall {
                sim.physics.insert_collider(ColliderBuilder::cuboid(3.0, 3.0, 0.25).translation(vec3(4.0, 0.0, 5.0)), None);
            }
        });
        let mut runtime = runtime(game, TONE_TABLE);
        (0..12)
            .map(|_| {
                runtime.step(STEP_MS);
                let voice = volatile_audio(&runtime)["voices"][0].clone();
                (voice["occluded"].as_bool(), voice["gainDb"].as_f64().unwrap_or(f64::NAN))
            })
            .collect::<Vec<_>>()
    };
    let open = run(false);
    let walled = run(true);
    assert!(open.iter().all(|(occluded, _)| *occluded == Some(false)), "{open:?}");
    assert_eq!(walled[1].0, Some(true), "occluded within two cycles: {walled:?}");
    let (settled_open, settled_walled) = (open[11].1, walled[11].1);
    assert!(settled_walled - settled_open <= -8.0, "at least 8 dB down: open {settled_open}, walled {settled_walled}");
}

#[test]
fn a_second_game_audio_is_refused_duplicate_audio() {
    let mut game = Game::new(World::default());
    game.audio(AudioSetup::default());
    game.audio(AudioSetup::default());
    let refused = Runtime::new(game).err().expect("refused");
    assert_eq!(refused.code(), InstallErrorCode::DuplicateAudio);
    assert_eq!(refused.code().as_str(), "duplicate-audio");
}

#[test]
fn more_reverb_zones_than_the_cap_are_refused_audio_zone_limit() {
    use genex::audio::{REVERB_ZONES_MAX, ReverbPreset, ReverbZone, ZoneShape};
    let zone = ReverbZone { name: "room", shape: ZoneShape::Sphere { center: Vec3::ZERO, radius: 1.0 }, preset: ReverbPreset::ROOM, send_db: -6.0, uniformity: 0.0 };
    let mut game = Game::new(World::default());
    game.audio(AudioSetup { zones: vec![zone; REVERB_ZONES_MAX + 1], ..AudioSetup::default() });
    let refused = Runtime::new(game).err().expect("refused");
    assert_eq!(refused.code(), InstallErrorCode::AudioZoneLimit);
    let mut game = Game::new(World::default());
    game.audio(AudioSetup { zones: vec![zone; REVERB_ZONES_MAX], ..AudioSetup::default() });
    assert!(Runtime::new(game).is_ok(), "the cap itself installs");
}

/// The logical state is the same at every pool class (only which voices are virtual differs),
/// so the Director's logical hash matches across desktop, web and phone pools.
#[test]
fn the_logical_state_is_the_same_on_every_pool_class() {
    let hashes: Vec<u64> = [PoolClass::Desktop, PoolClass::Web, PoolClass::Phone]
        .into_iter()
        .map(|class| {
            let mut runtime = runtime(tone_game("sfx/tone.wav", true), TONE_TABLE);
            runtime.set_audio_pool(class);
            runtime.step(20.0 * STEP_MS);
            assert_eq!(volatile_audio(&runtime)["pool"]["class"], json!(class.as_str()));
            runtime.audio_logical_hash()
        })
        .collect();
    assert_ne!(hashes[0], 0);
    assert!(hashes.iter().all(|hash| *hash == hashes[0]), "{hashes:?}");
}

/// The person's volumes and the mute are outside the simulation: they change the level and the
/// device output, never the logical state or the checksum.
#[test]
fn person_volumes_and_the_mute_stay_outside_the_simulation() {
    let run = |settings: AudioSettings, muted: bool| {
        let mut runtime = runtime(tone_game("sfx/tone.wav", false), TONE_TABLE);
        runtime.set_audio_settings(settings);
        runtime.set_output_muted(muted);
        runtime.step(10.0 * STEP_MS);
        (runtime.checksum(), runtime.audio_logical_hash(), runtime.audio_level().rms, volatile_audio(&runtime))
    };
    let loud = run(AudioSettings::default(), false);
    let quiet = run(AudioSettings::default().with_bus(Bus::Sfx, 0.25), false);
    let muted = run(AudioSettings::default(), true);
    assert_eq!((&quiet.0, quiet.1), (&loud.0, loud.1));
    assert!(quiet.2 < loud.2 * 0.5, "a quarter volume is quieter: {} vs {}", quiet.2, loud.2);
    assert_eq!(muted.2.to_bits(), loud.2.to_bits(), "the meter reads the mix under the mute");
    assert_eq!(muted.3["device"]["muted"], json!(true));
    assert_eq!(quiet.3["person"]["sfx"], json!(0.25));
}

/// UI sounds keep their voice: `PlayOpts::ui()` plays on the ui bus at priority 255.
#[test]
fn a_ui_sound_plays_on_the_ui_bus() {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, _, _, gfx| sim.world.sound = Some(gfx.sound("sfx/tone.wav")));
    game.on_ui(|sim, _ui, ctx| {
        if ctx.tick == 0 {
            sim.world.voice = ctx.audio.play_with(sim.world.sound.as_ref().expect("loaded"), PlayOpts::ui());
        }
    });
    let mut runtime = runtime(game, TONE_TABLE);
    runtime.step(STEP_MS);
    let audio = volatile_audio(&runtime);
    assert_eq!(audio["voices"][0]["bus"], json!("ui"), "{audio}");
    assert_eq!(runtime.sim().world.voice.id(), 1);
}

/// AU-8 red row: only a windowed run a person sees opens a device; a headless frame never does,
/// and neither does a process marked `GENEX_NO_WINDOW=1` (every `cargo test` and `cargo bench`).
#[test]
fn only_a_windowed_run_outside_tests_may_open_a_device() {
    use genex::audio::may_open_device;
    let table = [(false, false, true), (true, false, false), (false, true, false), (true, true, false)];
    for (headless, forbidden, open) in table {
        assert_eq!(may_open_device(headless, forbidden), open, "headless {headless}, forbidden {forbidden}");
    }
}

/// AU-8 red row: a process marked `GENEX_NO_WINDOW=1` opens no device: the runtime's queue is
/// never asked for, a second ask changes nothing, and `volatile.audio.device.open` stays false.
#[test]
fn a_forbidden_process_opens_no_device_and_never_asks_for_the_queue() {
    use genex::audio::Device;
    let mut runtime = runtime(tone_game("sfx/tone.wav", false), TONE_TABLE);
    runtime.step(STEP_MS);
    let mut device = Device::default();
    let opened = device.open_once_where(true, || unreachable!("a forbidden process never takes the queue"));
    assert!(!opened && device.tried() && !device.is_open());
    assert!(!device.open_once_where(false, || unreachable!("opened at most once")), "the first answer stands");
    runtime.note_audio_device(device.is_open(), device.fault());
    runtime.step(STEP_MS);
    let audio = volatile_audio(&runtime);
    assert_eq!(audio["device"]["open"], json!(false), "{audio}");
    assert_eq!(audio["device"]["fault"], Value::Null, "{audio}");
}

/// AU-8: under `cargo test` (rust-env marks the process `GENEX_NO_WINDOW=1`) the shells' own
/// path, `Device::open_for`, opens nothing either and reports a closed device.
#[test]
fn the_shells_open_path_opens_nothing_in_a_test_process() {
    use genex::audio::Device;
    if std::env::var("GENEX_NO_WINDOW").as_deref() != Ok("1") {
        return;
    }
    let mut runtime = runtime(tone_game("sfx/tone.wav", false), TONE_TABLE);
    let mut device = Device::default();
    device.open_for(&mut runtime);
    runtime.step(STEP_MS);
    assert!(!device.is_open());
    assert_eq!(volatile_audio(&runtime)["device"]["open"], json!(false));
}
