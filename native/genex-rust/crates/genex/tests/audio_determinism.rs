//! AU-10 through the facade: audio's logical state is a pure function of seed, input and ticks.
//! A 600-tick game plays every kind of `ctx.audio` call the reference teaches: thirty looping
//! crickets (more voices than a phone or the web renders), footsteps capped by `max_instances`, a
//! rapid-fire gun that steals its oldest shot, dialogue that ducks the music, a music crossfade as
//! the ears enter a reverb zone, a wall collider occluding a generator, a Doppler fly-by moved
//! every tick, and UI clicks. Its ears are a listener override walking along x.
//!
//! - **Pools.** At the desktop's 48, the web's 32 and a phone's 24 physical voices the Director's
//!   logical hash is equal on every tick, and so is `state().volatile.audio` once the pool's own
//!   facts are removed (the `virtual` flags, the virtualized count and events, the pool sizes),
//!   while the smaller pools really do virtualize.
//! - **Destinations.** The logical hashes of every 30th tick fold into one digest, pinned here
//!   ([`PINNED_LOGICAL`]). Whatever target runs this file must reach it: aarch64 macOS, x86_64
//!   macOS under Rosetta (`--target x86_64-apple-darwin`) and wasm32 in a headless libtest
//!   runner (Linux, Windows, iOS and Android on their own runners, named at the gates).
//!
//! Every row is new behaviour (section 0 of the game systems plan). A game built without physics
//! has no colliders to occlude, and one built without audio plays nothing (AU-11): this file is
//! not compiled then.

#![cfg(all(feature = "physics-raw", feature = "audio"))]

use genex::audio::{PoolClass, Sound};
use genex::physics::ColliderBuilder;
use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime};

const TICKS: u64 = 600;
/// Ticks between the samples the pinned digest folds.
const SAMPLE_TICKS: u64 = 30;
/// FNV-1a 64 over the twenty sampled logical hashes, little-endian.
const PINNED_LOGICAL: u64 = 0xc691_ddcb_d683_81ff;
const SEED: u32 = 1;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

const RATE: u32 = 24_000;
const CRICKETS: usize = 30;
const GENERATOR: Vec3 = Vec3::new(0.0, 1.0, 10.0);
const WALL_CENTER: Vec3 = Vec3::new(0.0, 2.0, 5.0);
const WALL_HALF: Vec3 = Vec3::new(3.0, 2.0, 0.3);
const ZONE_CENTER: Vec3 = Vec3::new(8.0, 0.0, 0.0);
const ZONE_RADIUS: f32 = 4.0;
const TURRET: Vec3 = Vec3::new(5.0, 1.0, -5.0);
const BURST: (u64, u64) = (100, 190);
const TALK_TICK: u64 = 50;
const FLYBY: (u64, u64) = (200, 360);
const STEP_TICKS: u64 = 15;
const CLICK_TICKS: u64 = 120;

/// A 16-bit mono PCM WAV of `seconds` of a `freq` Hz sine at [`RATE`], amplitude 1/4.
fn wav(seconds: f64, freq: f64) -> &'static [u8] {
    let frames = (f64::from(RATE) * seconds) as u32;
    let data_bytes = frames * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&RATE.to_le_bytes());
    bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for i in 0..frames {
        let phase = 2.0 * std::f64::consts::PI * freq * f64::from(i) / f64::from(RATE);
        let sample = (libm::sin(phase) * 0.25 * f64::from(i16::MAX)) as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Box::leak(bytes.into_boxed_slice())
}

fn assets() -> &'static [(&'static str, &'static [u8])] {
    let rows = vec![
        ("sfx/cricket.wav", wav(0.6, 4500.0)),
        ("sfx/hum.wav", wav(1.0, 50.0)),
        ("sfx/step.wav", wav(0.5, 180.0)),
        ("sfx/shot.wav", wav(0.4, 90.0)),
        ("sfx/talk.wav", wav(2.0, 140.0)),
        ("sfx/drone.wav", wav(1.0, 100.0)),
        ("sfx/click.wav", wav(0.03, 2000.0)),
        ("music/open.wav", wav(2.0, 220.0)),
        ("music/zone.wav", wav(2.0, 330.0)),
    ];
    Box::leak(rows.into_boxed_slice())
}

#[derive(Default)]
struct World {
    sounds: Vec<Sound>,
    music: Vec<Music>,
    in_zone: bool,
    drone: Voice,
}

fn ears_at(tick: u64) -> Vec3 {
    Vec3::new(-10.0 + 20.0 * tick as f32 / TICKS as f32, 1.7, 0.0)
}

fn drone_at(tick: u64) -> Vec3 {
    let since = (tick - FLYBY.0) as f32 / (FLYBY.1 - FLYBY.0) as f32;
    Vec3::new(-40.0, 6.0, 3.0).lerp(Vec3::new(40.0, 6.0, 3.0), since)
}

fn setup() -> AudioSetup {
    let zone = ReverbZone {
        name: "hall",
        shape: ZoneShape::Sphere { center: ZONE_CENTER, radius: ZONE_RADIUS },
        preset: ReverbPreset::HALL,
        send_db: -6.0,
        uniformity: 0.5,
    };
    let duck = Duck { trigger: Bus::Voice, target: Bus::Music, depth_db: -12.0, attack_s: 0.1, release_s: 0.8 };
    AudioSetup { ducks: vec![duck], zones: vec![zone], occlusion: true, ..AudioSetup::default() }
}

fn start(world: &World, ctx: &Ctx<'_>) {
    let [cricket, hum, ..] = &world.sounds[..] else { return };
    for index in 0..CRICKETS {
        let (sin, cos) = genex::math::sin_cos(std::f32::consts::TAU * index as f32 / CRICKETS as f32);
        let at = Vec3::new(15.0 * cos, 0.3, 15.0 * sin);
        ctx.audio.play_with(cricket, PlayOpts::default().on(Bus::Ambience).looped().at(at).max_instances(0));
    }
    ctx.audio.play_with(hum, PlayOpts::default().looped().at(GENERATOR));
    ctx.audio.music(&world.music[0], MusicOpts { fade_s: 0.5, ..MusicOpts::default() });
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let tick = ctx.tick;
    let world = &mut sim.world;
    if tick == 0 {
        start(world, ctx);
    }
    let ears = ears_at(tick);
    ctx.audio.listener(Some(Listener { position: ears, forward: Vec3::X, up: Vec3::Y }));
    let [_, _, step, shot, talk, drone, click, ..] = &world.sounds[..] else { return };
    if tick.is_multiple_of(STEP_TICKS) {
        let pitch = 0.92 + ctx.rng.below(17) as f32 * 0.01;
        ctx.audio.play_with(step, PlayOpts::default().at(ears.with_y(0.0)).pitch(pitch).max_instances(2));
    }
    if (BURST.0..BURST.1).contains(&tick) && tick.is_multiple_of(3) {
        ctx.audio.play_with(shot, PlayOpts::default().at(TURRET).priority(140).max_instances(5));
    }
    if tick == TALK_TICK {
        ctx.audio.play_with(talk, PlayOpts::default().on(Bus::Voice));
    }
    if tick == FLYBY.0 {
        let flyby = Spatial { ref_distance: 4.0, max_distance: 80.0, doppler: 1.0, ..Spatial::default() };
        world.drone = ctx.audio.play_with(drone, PlayOpts::default().looped().at(drone_at(tick)).spatial(flyby));
    } else if (FLYBY.0..FLYBY.1).contains(&tick) {
        ctx.audio.set_position(world.drone, drone_at(tick));
    } else if tick == FLYBY.1 {
        ctx.audio.stop(world.drone, 0.2);
    }
    if tick % CLICK_TICKS == CLICK_TICKS / 2 {
        ctx.audio.play_with(click, PlayOpts::ui());
    }
    let in_zone = ears.distance(ZONE_CENTER) <= ZONE_RADIUS;
    if in_zone != world.in_zone {
        world.in_zone = in_zone;
        ctx.audio.music(&world.music[usize::from(in_zone)], MusicOpts { fade_s: 2.0, ..MusicOpts::default() });
    }
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.audio(setup());
    game.on_reset(|sim, _, _, gfx| {
        let sounds = ["cricket", "hum", "step", "shot", "talk", "drone", "click"];
        sim.world = World {
            sounds: sounds.iter().map(|name| gfx.sound(&format!("sfx/{name}.wav"))).collect(),
            music: vec![gfx.music("music/open.wav"), gfx.music("music/zone.wav")],
            ..World::default()
        };
        sim.physics.insert_collider(ColliderBuilder::cuboid(WALL_HALF.x, WALL_HALF.y, WALL_HALF.z).translation(WALL_CENTER), None);
    });
    game.on_update(update);
    game
}

fn runtime(class: PoolClass) -> Runtime<World> {
    let mut rt = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    rt.set_audio_pool(class);
    rt.seed(SEED);
    rt
}

/// `volatile.audio` without what only the pool decides: the `virtual` flags, the virtualized
/// count, the virtualized and realized events, and the pool's own sizes.
fn logical_view(audio: &Value) -> Value {
    let mut view = audio.clone();
    view["pool"] = Value::Null;
    view["device"] = Value::Null;
    view["counts"]["virtualized"] = Value::Null;
    if let Some(voices) = view["voices"].as_array_mut() {
        for voice in voices {
            voice["virtual"] = Value::Null;
        }
    }
    if let Some(events) = view["events"].as_array_mut() {
        events.retain(|event| event["code"] != json!("virtualized") && event["code"] != json!("realized"));
    }
    view
}

/// Every pool class keeps the desktop's logical state on every tick, and the smaller pools do
/// virtualize (so the row is not vacuous).
#[test]
fn every_pool_class_keeps_the_same_logical_state_on_every_tick() {
    let mut runs: Vec<Runtime<World>> = [PoolClass::Desktop, PoolClass::Web, PoolClass::Phone].into_iter().map(runtime).collect();
    let mut most_virtual = [0u64; 3];
    let mut kinds = std::collections::BTreeSet::new();
    for tick in 0..TICKS {
        for rt in &mut runs {
            rt.step(FIXED_STEP_MS);
        }
        let views: Vec<Value> = runs.iter().map(|rt| rt.state()["volatile"]["audio"].clone()).collect();
        for (most, audio) in most_virtual.iter_mut().zip(&views) {
            *most = (*most).max(audio["pool"]["virtual"].as_u64().unwrap_or(0));
        }
        for event in views[0]["events"].as_array().into_iter().flatten() {
            kinds.insert(event["code"].as_str().unwrap_or_default().to_owned());
        }
        let hashes: Vec<u64> = runs.iter().map(Runtime::audio_logical_hash).collect();
        assert!(hashes.iter().all(|hash| *hash == hashes[0]), "tick {tick}: logical hashes {hashes:x?}");
        let desktop = logical_view(&views[0]);
        for (class, audio) in ["web", "phone"].iter().zip(&views[1..]) {
            assert_eq!(logical_view(audio), desktop, "tick {tick}: {class}'s volatile.audio, virtual flags aside");
        }
    }
    assert_eq!(most_virtual[0], 0, "48 voices hold the whole scene");
    assert!(most_virtual[1] > 0 && most_virtual[2] > most_virtual[1], "web and phone virtualize: {most_virtual:?}");
    for code in ["played", "stolen", "ended", "stopped", "music-started"] {
        assert!(kinds.contains(code), "the scene emits {code}: {kinds:?}");
    }
}

/// The digest of every 30th tick's logical hash on this destination is the pinned one.
#[test]
fn the_logical_digest_is_the_pinned_one_on_this_destination() {
    let mut rt = runtime(PoolClass::Desktop);
    let mut digest = FNV_OFFSET;
    for _ in 0..TICKS / SAMPLE_TICKS {
        for _ in 0..SAMPLE_TICKS {
            rt.step(FIXED_STEP_MS);
        }
        digest = rt.audio_logical_hash().to_le_bytes().iter().fold(digest, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME));
    }
    assert_eq!(digest, PINNED_LOGICAL, "logical digest {digest:#018x}");
}
