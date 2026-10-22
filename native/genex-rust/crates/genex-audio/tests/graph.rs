//! The bus graph: five buses with a sim layer and a person layer, a reverb send that leaves a tail,
//! a physical voice pool per class and two music tracks. `audioLevel` is a pure function of the
//! ops applied and the ticks run (in one process or across two), a reset equals a fresh mixer bit
//! for bit, and a hostile op is dropped with no side effect.

// These rows drive the mixer, device output or decoders (the `mixer` feature, AU-11).
#![cfg(feature = "mixer")]

use genex_audio::{
    AudioLevel, AudioSettings, Bus, MIXER_RATE_HZ, Mixer, MixerOp, Music, MusicOpts, MusicTrack, PhysicalSlot, PoolClass,
    ReverbPreset, SEND_OFF_DB, Sound, SoundId,
};
use std::process::Command;

const REPLAY_CHILD_ENV: &str = "GENEX_AUDIO_GRAPH_REPLAY_CHILD";
const REPLAY_LINE: &str = "genex-audio-graph-replay ";
/// Ticks whose 2048-frame meter window holds nothing from three ticks earlier (800 frames a tick).
const WINDOW_TICKS: u32 = 3;
const OPEN_HZ: f32 = 20_000.0;

fn sine(frequency: f64, seconds: f64, amplitude: f32) -> Sound {
    let frames = (f64::from(MIXER_RATE_HZ) * seconds) as usize;
    let samples = (0..frames)
        .map(|i| {
            let phase = 2.0 * std::f64::consts::PI * frequency * i as f64 / f64::from(MIXER_RATE_HZ);
            let value = amplitude * libm::sin(phase) as f32;
            [value, value]
        })
        .collect::<Vec<_>>();
    Sound::from_frames(MIXER_RATE_HZ, &samples)
}

fn start(slot: u16, bus: Bus, sound: SoundId) -> MixerOp {
    MixerOp::Start {
        slot: PhysicalSlot(slot),
        bus,
        sound,
        start_frame: 0.0,
        looped: true,
        gain_db: 0.0,
        pan: 0.0,
        pitch: 1.0,
        cutoff_hz: OPEN_HZ,
        send_db: SEND_OFF_DB,
        fade_in_s: 0.0,
    }
}

fn with_send(op: MixerOp, db: f32, once: bool) -> MixerOp {
    match op {
        MixerOp::Start { slot, bus, sound, start_frame, gain_db, pan, pitch, cutoff_hz, fade_in_s, .. } => MixerOp::Start {
            slot,
            bus,
            sound,
            start_frame,
            looped: !once,
            gain_db,
            pan,
            pitch,
            cutoff_hz,
            send_db: db,
            fade_in_s,
        },
        other => other,
    }
}

fn bits(level: AudioLevel) -> (u64, u64) {
    (level.rms.to_bits(), level.centroid.to_bits())
}

fn run(mixer: &mut Mixer, ticks: u32) -> Vec<AudioLevel> {
    (0..ticks)
        .map(|_| {
            mixer.tick();
            mixer.level()
        })
        .collect()
}

/// A looped tone on the music bus under a 0.3 s bus volume tween; every tick's level.
fn tween_session() -> Vec<AudioLevel> {
    let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
    let tone = mixer.add_sound(sine(440.0, 1.0, 0.5));
    mixer.apply(&[start(0, Bus::Music, tone)]);
    run(&mut mixer, WINDOW_TICKS);
    mixer.apply(&[MixerOp::BusVolume { bus: Bus::Music, db: -18.0, fade_s: 0.3 }]);
    run(&mut mixer, 30)
}

fn digest(levels: &[AudioLevel]) -> String {
    levels.iter().map(|level| format!("{:016x}{:016x}", level.rms.to_bits(), level.centroid.to_bits())).collect()
}

#[test]
fn a_bus_volume_tween_is_heard_gradually() {
    let levels = tween_session();
    let (first, middle, last) = (levels[0].rms, levels[8].rms, levels[29].rms);
    assert!(first > 0.3, "the tone is heard before the tween: {first}");
    assert!(last < first / 7.0, "-18 dB is about an eighth: {first} -> {last}");
    assert!(middle < first && middle > last, "the tween passes through the middle: {first} {middle} {last}");
}

/// Two process replays of a bus volume tween give the same level on every tick, bit for bit.
#[test]
fn a_bus_volume_tween_replays_bit_identically_in_two_processes() {
    if std::env::var_os(REPLAY_CHILD_ENV).is_some() {
        println!("{REPLAY_LINE}{}", digest(&tween_session()));
        return;
    }
    let replay = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "a_bus_volume_tween_replays_bit_identically_in_two_processes", "--nocapture", "--test-threads=1"])
            .env(REPLAY_CHILD_ENV, "1")
            .output()
            .expect("re-run the test binary");
        assert!(output.status.success(), "child failed: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8(output.stdout).unwrap();
        let line = stdout.lines().find_map(|l| l.split_once(REPLAY_LINE)).map(|(_, digest)| digest.to_owned());
        line.unwrap_or_else(|| panic!("no replay line in {stdout:?}"))
    };
    let first = replay();
    assert_eq!(first, replay());
    assert_eq!(first, digest(&tween_session()), "the child process agrees with this one");
}

/// A bus at −∞ (the person's slider at 0, or the sim layer at −∞) is exact silence, and the
/// other buses read as if it were not there.
#[test]
fn a_bus_at_minus_infinity_is_silent_while_the_other_buses_still_read() {
    let ui_alone = {
        let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
        let _sfx = mixer.add_sound(sine(1000.0, 1.0, 0.5));
        let ui = mixer.add_sound(sine(300.0, 1.0, 0.3));
        mixer.apply(&[start(1, Bus::Ui, ui)]);
        *run(&mut mixer, 6).last().unwrap()
    };
    assert!(ui_alone.rms > 0.05, "{ui_alone:?}");
    let silence_sfx: [&dyn Fn(&mut Mixer); 2] = [
        &|mixer| mixer.set_settings(AudioSettings::default().with_bus(Bus::Sfx, 0.0)),
        &|mixer| mixer.apply(&[MixerOp::BusVolume { bus: Bus::Sfx, db: f32::NEG_INFINITY, fade_s: 0.0 }]),
    ];
    for (row, silence) in silence_sfx.iter().enumerate() {
        let mut alone = Mixer::new(PoolClass::Desktop).unwrap();
        let sfx = alone.add_sound(sine(1000.0, 1.0, 0.5));
        silence(&mut alone);
        alone.apply(&[start(0, Bus::Sfx, sfx)]);
        assert_eq!(*run(&mut alone, 6).last().unwrap(), AudioLevel { rms: 0.0, centroid: 0.0 }, "row {row}");

        let mut both = Mixer::new(PoolClass::Desktop).unwrap();
        let sfx = both.add_sound(sine(1000.0, 1.0, 0.5));
        let ui = both.add_sound(sine(300.0, 1.0, 0.3));
        silence(&mut both);
        both.apply(&[start(0, Bus::Sfx, sfx), start(1, Bus::Ui, ui)]);
        assert_eq!(bits(*run(&mut both, 6).last().unwrap()), bits(ui_alone), "row {row}: the silent bus adds nothing");
    }
}

/// A 50 ms one-shot sent to the cave reverb; the level three ticks after its last frame.
fn tail_level(send_db: f32) -> AudioLevel {
    let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
    let blip = mixer.add_sound(sine(800.0, 0.05, 0.5));
    mixer.apply(&[MixerOp::Reverb { preset: ReverbPreset::CAVE, fade_s: 0.0 }, with_send(start(0, Bus::Sfx, blip), send_db, true)]);
    // The blip is 2400 frames: three ticks. Three more ticks and the window holds only what follows.
    *run(&mut mixer, 3 + WINDOW_TICKS).last().unwrap()
}

#[test]
fn the_reverb_send_leaves_a_tail_after_the_dry_voice_stopped() {
    let dry = tail_level(SEND_OFF_DB);
    let wet = tail_level(0.0);
    assert!(dry.rms < 1e-6, "no send: nothing after the blip: {dry:?}");
    assert!(wet.rms > 1e-3, "the cave rings on: {wet:?}");
}

/// What runs after a reset or on a fresh mixer: a reverb voice, a pan, a bus tween and music.
fn scenario(mixer: &mut Mixer, tone: SoundId, music: genex_audio::MusicId) -> Vec<(Vec<u32>, (u64, u64))> {
    mixer.apply(&[
        MixerOp::Reverb { preset: ReverbPreset::HALL, fade_s: 0.0 },
        with_send(start(2, Bus::Voice, tone), -6.0, false),
        MixerOp::Pan { slot: PhysicalSlot(2), pan: -0.5, fade_s: 0.1 },
        MixerOp::BusVolume { bus: Bus::Voice, db: -6.0, fade_s: 0.2 },
        MixerOp::MusicStart { track: MusicTrack::A, music, opts: MusicOpts::default() },
    ]);
    (0..12)
        .map(|_| {
            let block = mixer.tick().iter().map(|sample| sample.to_bits()).collect();
            (block, bits(mixer.level()))
        })
        .collect()
}

#[test]
fn reset_after_a_reverb_tail_equals_a_fresh_mixer_bit_for_bit() {
    let settings = AudioSettings::default().with_bus(Bus::Music, 0.5);
    let load = |mixer: &mut Mixer| {
        mixer.set_settings(settings);
        let tone = mixer.add_sound(sine(500.0, 0.5, 0.4));
        let music = mixer.add_music(Music::from_sound(sine(220.0, 2.0, 0.2)));
        (tone, music)
    };
    let mut used = Mixer::new(PoolClass::Web).unwrap();
    let (tone, music) = load(&mut used);
    used.apply(&[
        MixerOp::Reverb { preset: ReverbPreset::CAVE, fade_s: 0.0 },
        with_send(start(0, Bus::Sfx, tone), 0.0, false),
        MixerOp::BusVolume { bus: Bus::Sfx, db: -3.0, fade_s: 1.0 },
        MixerOp::MasterVolume { db: -2.0, fade_s: 0.0 },
    ]);
    run(&mut used, 8);
    assert!(used.level().rms > 0.0, "the tail is ringing before the reset");
    used.reset().unwrap();
    assert_eq!(used.settings(), settings, "the person's volumes survive a seed");

    let mut fresh = Mixer::new(PoolClass::Web).unwrap();
    let (fresh_tone, fresh_music) = load(&mut fresh);
    assert_eq!((tone, music), (fresh_tone, fresh_music));
    let after_reset = scenario(&mut used, tone, music);
    let from_fresh = scenario(&mut fresh, tone, music);
    assert!(after_reset.last().unwrap().1.0 != 0, "the scenario is heard");
    assert_eq!(after_reset, from_fresh, "every block and level, bit for bit");
}

#[test]
fn muting_stays_after_the_meter_and_survives_a_reset() {
    let session = |muted: bool| {
        let mut mixer = Mixer::new(PoolClass::Phone).unwrap();
        mixer.set_muted(muted);
        let tone = mixer.add_sound(sine(700.0, 1.0, 0.5));
        mixer.apply(&[with_send(start(0, Bus::Ambience, tone), -3.0, false)]);
        let silent = (0..6).all(|_| mixer.tick().iter().all(|sample| *sample == 0.0));
        mixer.reset().unwrap();
        (bits(mixer_level_after(&mut mixer, tone)), silent, mixer.muted())
    };
    let (loud_level, loud_silent, _) = session(false);
    let (muted_level, muted_silent, still_muted) = session(true);
    assert!(!loud_silent && muted_silent, "a muted run sends silence to the device");
    assert!(still_muted, "a seed keeps the person's mute");
    assert_eq!(loud_level, muted_level, "the meter reads the mix before the mute");
}

fn mixer_level_after(mixer: &mut Mixer, tone: SoundId) -> AudioLevel {
    mixer.apply(&[start(3, Bus::Ui, tone)]);
    *run(mixer, 4).last().unwrap()
}

#[test]
fn each_class_renders_its_own_physical_pool() {
    for (class, physical) in [(PoolClass::Desktop, 48), (PoolClass::Web, 32), (PoolClass::Phone, 24)] {
        let mut mixer = Mixer::new(class).unwrap();
        assert_eq!(mixer.physical_voices(), physical);
        let tone = mixer.add_sound(sine(400.0, 1.0, 0.01));
        let ops: Vec<MixerOp> = (0..=physical as u16).map(|slot| start(slot, Bus::ALL[usize::from(slot) % 5], tone)).collect();
        mixer.apply(&ops);
        mixer.tick();
        assert_eq!(mixer.active_voices(), physical, "{class:?}");
        assert_eq!(mixer.dropped_ops(), 1, "{class:?}: the slot past the pool is dropped");
    }
}

#[test]
fn a_slot_moving_to_another_bus_follows_that_bus() {
    let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
    let tone = mixer.add_sound(sine(600.0, 1.0, 0.5));
    mixer.set_settings(AudioSettings::default().with_bus(Bus::Sfx, 0.0));
    mixer.apply(&[start(0, Bus::Sfx, tone)]);
    assert_eq!(run(&mut mixer, WINDOW_TICKS + 1).last().unwrap().rms, 0.0, "on the silent bus");
    mixer.apply(&[start(0, Bus::Ui, tone)]);
    assert!(run(&mut mixer, WINDOW_TICKS + 1).last().unwrap().rms > 0.1, "moved to an audible bus");
    assert_eq!(mixer.active_voices(), 1, "one slot, one voice");
}

#[test]
fn music_plays_on_its_track_and_stops_with_a_fade() {
    let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
    let music = mixer.add_music(Music::from_sound(sine(330.0, 2.0, 0.4)));
    let once = MusicOpts { looped: false, fade_s: 0.0, ..MusicOpts::default() };
    mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::B, music, opts: once }]);
    assert!(run(&mut mixer, WINDOW_TICKS + 1).last().unwrap().rms > 0.1);
    assert!(mixer.music_playing(MusicTrack::B) && !mixer.music_playing(MusicTrack::A));
    mixer.apply(&[MixerOp::MusicStop { track: MusicTrack::B, fade_s: 0.05 }]);
    let after = *run(&mut mixer, WINDOW_TICKS + 3).last().unwrap();
    assert_eq!(after.rms, 0.0, "{after:?}");
    assert!(!mixer.music_playing(MusicTrack::B));
}

/// Hostile ops: a slot past the pool, an unknown sound or music, NaN and ∞ values, an op on a
/// slot that never played. Each is dropped and counted, and the mix equals one that never saw it.
#[test]
fn hostile_ops_are_dropped_with_no_side_effect() {
    let base = |mixer: &mut Mixer| {
        let tone = mixer.add_sound(sine(450.0, 1.0, 0.4));
        mixer.apply(&[start(0, Bus::Sfx, tone)]);
        tone
    };
    let mut clean = Mixer::new(PoolClass::Desktop).unwrap();
    base(&mut clean);
    let expected = run(&mut clean, 6).iter().map(|level| bits(*level)).collect::<Vec<_>>();

    let mut hostile = Mixer::new(PoolClass::Desktop).unwrap();
    let tone = base(&mut hostile);
    let slot = PhysicalSlot(0);
    let unused = PhysicalSlot(7);
    let rows = [
        start(48, Bus::Sfx, tone),
        start(u16::MAX, Bus::Ui, tone),
        start(1, Bus::Sfx, SoundId(99)),
        with_send(start(1, Bus::Sfx, tone), f32::NAN, false),
        MixerOp::Gain { slot, db: f32::NAN, fade_s: 0.0 },
        MixerOp::Pan { slot, pan: f32::INFINITY, fade_s: 0.0 },
        MixerOp::Pitch { slot, rate: f32::NAN, fade_s: 0.0 },
        MixerOp::Cutoff { slot, hz: f32::NEG_INFINITY, fade_s: 0.0 },
        MixerOp::Send { slot, db: f32::NAN, fade_s: 0.0 },
        MixerOp::Gain { slot: unused, db: -3.0, fade_s: 0.0 },
        MixerOp::Stop { slot: unused, fade_s: 0.0 },
        MixerOp::BusVolume { bus: Bus::Sfx, db: f32::NAN, fade_s: 0.0 },
        MixerOp::MasterVolume { db: f32::NAN, fade_s: f32::INFINITY },
        MixerOp::Reverb { preset: ReverbPreset { room: f32::NAN, damping: 0.5 }, fade_s: 0.0 },
        MixerOp::MusicStart { track: MusicTrack::A, music: genex_audio::MusicId(3), opts: MusicOpts::default() },
        MixerOp::MusicVolume { track: MusicTrack::A, db: f32::NAN, fade_s: 0.0 },
    ];
    hostile.apply(&rows);
    assert_eq!(hostile.dropped_ops(), rows.len() as u64);
    let got = run(&mut hostile, 6).iter().map(|level| bits(*level)).collect::<Vec<_>>();
    assert_eq!(got, expected);
    // Fades that would panic a Duration (negative, NaN, ∞, huge) are clamped, never a panic.
    for fade_s in [-1.0, f32::NAN, f32::INFINITY, 1e30] {
        hostile.apply(&[MixerOp::Gain { slot, db: -1.0, fade_s }, MixerOp::BusVolume { bus: Bus::Ui, db: 0.0, fade_s }]);
    }
    assert_eq!(hostile.dropped_ops(), rows.len() as u64);
}

/// The GC timing row (advisory in a lane, gating on a quiet machine): 48 active voices plus the
/// reverb at most 0.6 ms a tick on the desktop baseline. Run in release:
/// `cargo test -p genex-audio --release --test graph -- --ignored --nocapture`.
#[test]
#[ignore = "timing row: run in release on a quiet machine"]
#[allow(clippy::disallowed_types, reason = "test timing: the row measures how long a mixer tick holds the thread")]
fn timing_48_voices_and_reverb_per_tick() {
    use std::time::Instant;
    const TICKS: u32 = 600;
    let mut mixer = Mixer::new(PoolClass::Desktop).unwrap();
    let sounds: Vec<SoundId> = (0..8).map(|i| mixer.add_sound(sine(200.0 + 90.0 * f64::from(i), 1.0, 0.02))).collect();
    let mut ops = vec![MixerOp::Reverb { preset: ReverbPreset::HALL, fade_s: 0.0 }];
    for slot in 0..48u16 {
        let op = start(slot, Bus::ALL[usize::from(slot) % 5], sounds[usize::from(slot) % 8]);
        ops.push(with_send(op, -12.0, false));
        ops.push(MixerOp::Cutoff { slot: PhysicalSlot(slot), hz: 4_000.0, fade_s: 0.0 });
    }
    mixer.apply(&ops);
    run(&mut mixer, 10);
    assert_eq!(mixer.active_voices(), 48);
    let started = Instant::now();
    for tick in 0..TICKS {
        // One parameter change per voice per tick, as a moving spatial scene sends.
        let pans: Vec<MixerOp> = (0..48u16)
            .map(|slot| MixerOp::Pan { slot: PhysicalSlot(slot), pan: ((tick + u32::from(slot)) % 20) as f32 / 10.0 - 1.0, fade_s: 1.0 / 60.0 })
            .collect();
        mixer.apply(&pans);
        mixer.tick();
    }
    let per_tick_ms = started.elapsed().as_secs_f64() * 1000.0 / f64::from(TICKS);
    println!("genex-audio timing: 48 voices + reverb = {per_tick_ms:.4} ms/tick over {TICKS} ticks");
}
