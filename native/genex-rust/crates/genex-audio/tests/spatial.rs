//! Spatial math, reverb zones and the occlusion scheduler: pure libm functions held to tables
//! computed from the published formulas (the Web Audio PannerNode distance models and equal-power
//! pan, Godot's Doppler and reverb uniformity), and the Director that applies them.

use genex_audio::{
    AudioCommand, AudioSetup, CUTOFF_FAR_HZ, CUTOFF_OPEN_HZ, DOPPLER_RATE_MAX, Attenuation, Director, Listener,
    OCCLUSION_RAYS_PER_TICK, Occluder, OcclusionScheduler, PlayOpts, PoolClass, ReverbPreset, ReverbZone, SEND_OFF_DB,
    SoundId, SoundInfo, Spatial, StepInput, Voice, ZoneId, ZoneShape, active_zone, attenuation_db, distance_cutoff_hz,
    doppler_rate, pan, pan_gains, send_db,
};
use glam::Vec3;

fn spatial(attenuation: Attenuation, ref_distance: f32, max_distance: f32, rolloff: f32) -> Spatial {
    Spatial { attenuation, ref_distance, max_distance, rolloff, ..Spatial::default() }
}

/// The Web Audio gain for each model, with the distance clamped to `ref..=max` (the clamped
/// models: gain stops falling past `max_distance`).
fn spec_gain(model: Attenuation, d: f64, r: f64, m: f64, f: f64) -> f64 {
    let d = d.clamp(r, m);
    match model {
        Attenuation::Inverse => r / (r + f * (d - r)),
        Attenuation::Linear => 1.0 - f.clamp(0.0, 1.0) * (d - r) / (m - r),
        Attenuation::Exponential => (d / r).powf(-f),
        _ => 1.0,
    }
}

fn spec_db(gain: f64) -> f32 {
    let db = if gain <= 0.0 { f64::NEG_INFINITY } else { 20.0 * gain.log10() };
    (db as f32).max(SEND_OFF_DB)
}

#[test]
fn attenuation_matches_the_spec_formulas_at_each_reference_distance() {
    let models = [Attenuation::Inverse, Attenuation::Linear, Attenuation::Exponential, Attenuation::Off];
    let shapes = [(1.0_f32, 50.0_f32, 1.0_f32), (2.0, 20.0, 0.5), (0.5, 100.0, 2.0)];
    for model in models {
        for (r, m, f) in shapes {
            let falloff = spatial(model, r, m, f);
            for d in [0.0, r, 2.0 * r, m, 2.0 * m] {
                let got = attenuation_db(&falloff, d);
                let want = spec_db(spec_gain(model, f64::from(d), f64::from(r), f64::from(m), f64::from(f)));
                assert!(
                    (got - want).abs() <= 1e-3,
                    "{model:?} ref {r} max {m} rolloff {f} at {d} m: {got} dB, the spec says {want} dB"
                );
            }
            assert_eq!(attenuation_db(&falloff, 0.0), 0.0, "{model:?}: full volume inside ref_distance");
            assert_eq!(attenuation_db(&falloff, 2.0 * m), attenuation_db(&falloff, m), "{model:?}: flat past max_distance");
        }
    }
}

#[test]
fn attenuation_never_answers_nan_for_degenerate_falloffs() {
    let degenerate = [
        spatial(Attenuation::Exponential, 0.0, 0.0, 1.0),
        spatial(Attenuation::Linear, 5.0, 5.0, 1.0),
        spatial(Attenuation::Inverse, -1.0, 10.0, -2.0),
    ];
    for falloff in degenerate {
        for d in [0.0, 1.0, 1e9, -3.0] {
            let db = attenuation_db(&falloff, d);
            assert!((SEND_OFF_DB..=0.0).contains(&db), "{falloff:?} at {d}: {db}");
        }
    }
}

fn ears() -> Listener {
    Listener { position: Vec3::new(1.0, 2.0, 3.0), forward: Vec3::NEG_Z, up: Vec3::Y }
}

#[test]
fn the_equal_power_pan_keeps_power_and_mirrors_behind_the_listener() {
    let listener = ears();
    for step in -20..=20 {
        let p = step as f32 / 20.0;
        let (left, right) = pan_gains(p);
        assert!((left * left + right * right - 1.0).abs() <= 1e-6, "pan {p}: L {left} R {right}");
    }
    assert_eq!(pan_gains(-1.0), (1.0, 0.0));
    assert_eq!(pan_gains(1.0), (0.0, 1.0));
    let right = pan(&listener, listener.position + Vec3::new(3.0, 0.0, 0.0), 1.0);
    assert!((right - 1.0).abs() <= 1e-6, "a source to the right pans right: {right}");
    let left = pan(&listener, listener.position + Vec3::new(-3.0, 0.0, 0.0), 1.0);
    assert!((left + 1.0).abs() <= 1e-6, "a source to the left pans left: {left}");
    for (x, z) in [(1.0_f32, 2.0_f32), (2.0, 0.5), (-1.5, 1.0), (0.3, 4.0)] {
        let front = pan(&listener, listener.position + Vec3::new(x, 0.0, -z), 1.0);
        let behind = pan(&listener, listener.position + Vec3::new(x, 0.0, z), 1.0);
        assert_eq!(front.to_bits(), behind.to_bits(), "behind mirrors the front at x {x} z {z}");
        assert!(front.signum() == x.signum() && front.abs() < 1.0);
    }
    let half = pan(&listener, listener.position + Vec3::new(3.0, 0.0, 0.0), 0.5);
    assert!((half - 0.5).abs() <= 1e-6, "panning 0.5 halves the pan: {half}");
    for at in [listener.position, listener.position + Vec3::Y * 4.0] {
        let centred = pan(&listener, at, 1.0);
        assert_eq!(centred, 0.0, "a source at the listener (or straight above) is centred");
    }
    assert_eq!(pan(&Listener { forward: Vec3::ZERO, ..listener }, Vec3::new(9.0, 0.0, 0.0), 1.0), 0.0, "degenerate ears");
}

#[test]
fn the_distance_low_pass_falls_log_linearly_to_its_far_cut_off() {
    let falloff = Spatial::default();
    assert_eq!(distance_cutoff_hz(&falloff, 0.0), CUTOFF_OPEN_HZ);
    let far = distance_cutoff_hz(&falloff, falloff.max_distance);
    assert!((far - CUTOFF_FAR_HZ).abs() <= 0.5, "{far}");
    assert_eq!(distance_cutoff_hz(&falloff, falloff.max_distance * 3.0), far, "flat past max_distance");
    let half = distance_cutoff_hz(&falloff, falloff.max_distance * 0.5);
    let geometric_mean = (CUTOFF_OPEN_HZ * CUTOFF_FAR_HZ).sqrt();
    assert!((half - geometric_mean).abs() <= 1.0, "half way is the geometric mean: {half} vs {geometric_mean}");
    let open = Spatial { lowpass_by_distance: false, ..falloff };
    assert_eq!(distance_cutoff_hz(&open, 40.0), CUTOFF_OPEN_HZ);
}

#[test]
fn doppler_raises_an_approaching_source_and_clamps_its_rate() {
    let toward = Vec3::X;
    let approaching = doppler_rate(Vec3::new(20.0, 0.0, 0.0), Vec3::ZERO, toward, 1.0);
    assert!(approaching > 1.0, "{approaching}");
    let expected = 343.0 / (343.0 - 20.0);
    assert!((approaching - expected).abs() <= 1e-5, "Godot's c/(c + v·dir): {approaching} vs {expected}");
    let receding = doppler_rate(Vec3::new(-20.0, 0.0, 0.0), Vec3::ZERO, toward, 1.0);
    assert!(receding < 1.0, "{receding}");
    let listener_moves = doppler_rate(Vec3::ZERO, Vec3::new(-20.0, 0.0, 0.0), toward, 1.0);
    assert_eq!(listener_moves.to_bits(), approaching.to_bits(), "only the relative velocity counts");
    assert_eq!(doppler_rate(Vec3::new(340.0, 0.0, 0.0), Vec3::ZERO, toward, 1.0), DOPPLER_RATE_MAX, "clamped at 8");
    assert_eq!(doppler_rate(Vec3::new(5_000.0, 0.0, 0.0), Vec3::ZERO, toward, 1.0), DOPPLER_RATE_MAX, "supersonic");
    assert_eq!(doppler_rate(Vec3::new(-5_000.0, 0.0, 0.0), Vec3::ZERO, toward, 1.0), 0.125, "clamped at 1/8");
    assert_eq!(doppler_rate(Vec3::new(20.0, 0.0, 0.0), Vec3::ZERO, toward, 0.0), 1.0, "strength 0 is off");
    let sideways = doppler_rate(Vec3::new(0.0, 0.0, 30.0), Vec3::ZERO, toward, 1.0);
    assert_eq!(sideways, 1.0, "moving across the line of sight keeps the pitch");
    assert_eq!(doppler_rate(Vec3::new(f32::NAN, 0.0, 0.0), Vec3::ZERO, toward, 1.0), 1.0, "a NaN velocity is ignored");
}

const BLIP: SoundId = SoundId(0);

fn director(setup: AudioSetup) -> Director {
    let mut director = Director::new(PoolClass::Desktop, setup);
    director.register_sound(BLIP, SoundInfo { frames: 48_000 * 10, rate_hz: 48_000 });
    director
}

fn voice_pitch(director: &Director, voice: Voice) -> f32 {
    director.voices().iter().find(|v| v.voice == voice).map(|v| v.pitch).unwrap()
}

#[test]
fn a_teleport_resets_doppler_to_one() {
    let mut director = director(AudioSetup::default());
    let voice = director.issue_voice();
    let falloff = Spatial { doppler: 1.0, ..Spatial::default() };
    let opts = PlayOpts::default().looped().at(Vec3::new(0.0, 0.0, -40.0)).spatial(falloff);
    director.step(&[AudioCommand::Play { voice, sound: BLIP, opts }], StepInput::default());
    assert_eq!(voice_pitch(&director, voice), 1.0, "a new voice has no velocity yet");
    let closer = AudioCommand::SetPosition { voice, position: Vec3::new(0.0, 0.0, -39.5) };
    director.step(&[closer], StepInput::default());
    let approaching = voice_pitch(&director, voice);
    let expected = 343.0 / (343.0 - 30.0);
    assert!((approaching - expected).abs() <= 1e-4, "0.5 m a tick toward the ears is 30 m/s: {approaching}");
    director.step(&[AudioCommand::Teleport { voice, position: Vec3::new(0.0, 0.0, -2.0) }], StepInput::default());
    assert_eq!(voice_pitch(&director, voice), 1.0, "a teleport is not a 37 m jump in one tick");
    director.step(&[], StepInput::default());
    assert_eq!(voice_pitch(&director, voice), 1.0, "standing still");
}

fn zone(name: &'static str, shape: ZoneShape) -> ReverbZone {
    ReverbZone { name, shape, preset: ReverbPreset::ROOM, send_db: -6.0, uniformity: 0.0 }
}

#[test]
fn the_smallest_zone_holding_the_listener_wins_and_ties_go_to_registration() {
    let hall = zone("hall", ZoneShape::Box { min: Vec3::splat(-10.0), max: Vec3::splat(10.0) });
    let room = zone("room", ZoneShape::Box { min: Vec3::ZERO, max: Vec3::splat(2.0) });
    let ball = zone("ball", ZoneShape::Sphere { center: Vec3::splat(1.0), radius: 0.5 });
    let twin = zone("twin", ZoneShape::Box { min: Vec3::ZERO, max: Vec3::splat(2.0) });
    let zones: Vec<(ZoneId, ReverbZone)> =
        [hall, room, ball, twin].into_iter().enumerate().map(|(i, z)| (ZoneId::from_id(i as u32 + 1), z)).collect();
    let cases: [(Vec3, Option<&str>); 6] = [
        (Vec3::splat(5.0), Some("hall")),
        (Vec3::splat(1.8), Some("room")),
        (Vec3::splat(1.0), Some("ball")),
        (Vec3::splat(2.0), Some("room")),
        (Vec3::splat(50.0), None),
        (Vec3::new(-10.0, 10.0, 0.0), Some("hall")),
    ];
    for (listener, want) in cases {
        let got = active_zone(&zones, listener).map(|i| zones[i].1.name);
        assert_eq!(got, want, "listener at {listener}");
    }
    assert_eq!(active_zone(&zones[1..], Vec3::splat(1.8)).map(|i| zones[1 + i].1.name), Some("room"), "room before its twin");
    assert_eq!(active_zone(&[], Vec3::ZERO), None);
    let nan = active_zone(&zones, Vec3::new(f32::NAN, 0.0, 0.0));
    assert_eq!(nan, None, "a NaN listener is in no zone");
}

#[test]
fn uniformity_sets_how_much_of_the_dry_falloff_the_send_keeps() {
    let base = zone("cave", ZoneShape::Sphere { center: Vec3::ZERO, radius: 10.0 });
    let table = [
        (0.0_f32, -12.0_f32, -18.0_f32),
        (0.5, -12.0, -12.0),
        (1.0, -12.0, -6.0),
        (0.0, 0.0, -6.0),
        (2.0, -12.0, -6.0),
        (-1.0, -12.0, -18.0),
    ];
    for (uniformity, dry, want) in table {
        let got = send_db(&ReverbZone { uniformity, ..base }, dry);
        assert_eq!(got, want, "uniformity {uniformity}, dry {dry} dB");
    }
    assert_eq!(send_db(&ReverbZone { uniformity: 0.0, ..base }, -200.0), SEND_OFF_DB, "floored at silence");
}

fn voices(ids: std::ops::RangeInclusive<u32>) -> Vec<Voice> {
    ids.map(Voice::from_id).collect()
}

#[test]
fn the_occlusion_scheduler_refreshes_every_emitter_round_robin_in_id_order() {
    let audible = voices(1..=20);
    let mut scheduler = OcclusionScheduler::default();
    let ticks = audible.len().div_ceil(OCCLUSION_RAYS_PER_TICK);
    let mut cast = Vec::new();
    for _ in 0..ticks {
        let picked = scheduler.pick(&audible);
        assert!(picked.len() <= OCCLUSION_RAYS_PER_TICK);
        cast.extend(picked);
    }
    assert_eq!(cast, audible, "all 20 within ceil(20/8) = {ticks} ticks, in id order");
    assert_eq!(scheduler.pick(&audible), voices(1..=8), "and round again");
    let fewer = voices(3..=5);
    assert_eq!(scheduler.pick(&fewer), fewer, "under the cap everything is cast every tick");
    let mut gap = OcclusionScheduler::default();
    assert_eq!(gap.pick(&voices(1..=10)), voices(1..=8));
    let after_removal = [Voice::from_id(2), Voice::from_id(12), Voice::from_id(14)];
    assert_eq!(gap.pick(&after_removal), after_removal.to_vec(), "under the cap: every one, in id order");
    let mut over = OcclusionScheduler::default();
    assert_eq!(over.pick(&voices(1..=12)), voices(1..=8));
    let shifted: Vec<Voice> = [1, 3, 9, 10, 11, 13, 15, 17, 19, 21].into_iter().map(Voice::from_id).collect();
    assert_eq!(over.pick(&shifted), shifted[2..].to_vec(), "resumes at the first id past the cursor");
    assert_eq!(over.pick(&shifted), shifted[..8].to_vec(), "and wraps to the lowest id on the next tick");
    gap.reset();
    assert_eq!(gap.pick(&voices(1..=10)), voices(1..=8));
    assert!(OcclusionScheduler::default().pick(&[]).is_empty());
}

/// A wall that remembers every ray it was asked about.
#[derive(Default)]
struct Wall {
    rays: Vec<Vec3>,
}

impl Occluder for Wall {
    fn transmission(&mut self, _from: Vec3, to: Vec3) -> f32 {
        self.rays.push(to);
        if to.x > 0.0 { 0.0 } else { 1.0 }
    }
}

#[test]
fn the_director_casts_occlusion_rays_round_robin_and_lowers_occluded_voices() {
    let mut director = director(AudioSetup { occlusion: true, ..AudioSetup::default() });
    let mut plays = Vec::new();
    for i in 0..20 {
        let side = if i % 2 == 0 { 1.0 } else { -1.0 };
        let at = Vec3::new(side * 3.0, 0.0, -(i as f32) - 1.0);
        let opts = PlayOpts::default().looped().max_instances(0).at(at);
        plays.push(AudioCommand::Play { voice: director.issue_voice(), sound: BLIP, opts });
    }
    let mut wall = Wall::default();
    director.step(&plays, StepInput { camera: None, occluder: Some(&mut wall) });
    for _ in 0..2 {
        director.step(&[], StepInput { camera: None, occluder: Some(&mut wall) });
    }
    let zs: Vec<f32> = wall.rays.iter().map(|to| -to.z).collect();
    let want: Vec<f32> = (1..=20).map(|i| i as f32).collect();
    assert_eq!(zs, want, "20 emitters refreshed within 3 ticks, in id order");
    for _ in 0..10 {
        director.step(&[], StepInput { camera: None, occluder: Some(&mut wall) });
    }
    let behind_wall = director.voices().iter().find(|v| v.voice == Voice::from_id(1)).unwrap();
    let in_the_open = director.voices().iter().find(|v| v.voice == Voice::from_id(2)).unwrap();
    assert!(behind_wall.occluded && !in_the_open.occluded);
    assert!(behind_wall.gain_db < in_the_open.gain_db - 6.0, "{} vs {}", behind_wall.gain_db, in_the_open.gain_db);
    assert!(behind_wall.cutoff_hz < 1_500.0 && in_the_open.cutoff_hz > 1_500.0);
    let mut quiet = self::director(AudioSetup::default());
    let voice = quiet.issue_voice();
    let mut unused = Wall::default();
    let play = AudioCommand::Play { voice, sound: BLIP, opts: PlayOpts::default().looped().at(Vec3::new(3.0, 0.0, -1.0)) };
    quiet.step(&[play], StepInput { camera: None, occluder: Some(&mut unused) });
    assert!(unused.rays.is_empty(), "no rays unless the game's setup turns occlusion on");
}

/// FNV-1a over the bits of every table value: the same number on every destination (the
/// native-vs-wasm32 row at the integrate runs this test there).
fn table_digest() -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let mut eat = |value: f32| {
        for byte in value.to_bits().to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    let listener = ears();
    for model in [Attenuation::Inverse, Attenuation::Linear, Attenuation::Exponential, Attenuation::Off] {
        let falloff = spatial(model, 1.5, 40.0, 1.3);
        for step in 0..100 {
            let d = step as f32 * 0.5;
            eat(attenuation_db(&falloff, d));
            eat(distance_cutoff_hz(&falloff, d));
        }
    }
    for step in 0..64 {
        let angle = step as f32 * 0.1;
        let at = listener.position + Vec3::new(libm::sinf(angle) * 4.0, 0.3, libm::cosf(angle) * 4.0);
        let p = pan(&listener, at, 0.8);
        eat(p);
        let (left, right) = pan_gains(p);
        eat(left);
        eat(right);
        eat(doppler_rate(Vec3::new(angle * 10.0 - 30.0, 0.0, 1.0), Vec3::ZERO, Vec3::X, 1.0));
    }
    hash
}

#[test]
fn the_spatial_tables_hash_to_their_pinned_digest() {
    assert_eq!(format!("{:016x}", table_digest()), TABLE_DIGEST, "a table value changed bits");
}

/// The digest on aarch64-apple-darwin; every destination must answer the same.
const TABLE_DIGEST: &str = "94130f7412cc0de8";
