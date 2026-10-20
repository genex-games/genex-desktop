//! The logical Director: commands in, logical voices and mixer ops out, on integer ticks and libm.
//! Stealing, virtualization, ducking, music slots, refusals and the save section are pure
//! functions of the commands and the ticks: equal in two processes, equal at every pool size, and
//! a restored snapshot replays like the uninterrupted run.

use genex_audio::{
    AudioCommand, AudioErrorCode, AudioEvent, AudioEventCode, AudioSetup, Bus, Director, Duck, LOGICAL_VOICES_MAX, Listener,
    LogicalVoice, MIXER_RATE_HZ, Mixer, MixerOp, Music, MusicId, MusicOpts, MusicTrack, PRIORITY_DEFAULT, PlayOpts, PoolClass,
    ReverbPreset, ReverbZone, Sound, SoundId, SoundInfo, Spatial, StepInput, Voice, ZoneShape, instance_victim, rank_for_pool,
    steal_victim,
};
use genex_core::rng::Pcg32;
use glam::Vec3;
use std::process::Command;

const RATE: u32 = 48_000;
/// Ten seconds: long enough to outlive every scenario.
const LONG: SoundId = SoundId(0);
/// Half a second: 30 ticks at pitch 1.
const SHORT: SoundId = SoundId(1);
const THEME: MusicId = MusicId(0);
const STING: MusicId = MusicId(1);
const FUZZ_CHILD_ENV: &str = "GENEX_AUDIO_DIRECTOR_FUZZ_CHILD";
const FUZZ_LINE: &str = "genex-audio-director-fuzz ";

fn director(class: PoolClass, setup: AudioSetup) -> Director {
    let mut director = Director::new(class, setup);
    director.register_sound(LONG, SoundInfo { frames: u64::from(RATE) * 10, rate_hz: RATE });
    director.register_sound(SHORT, SoundInfo { frames: u64::from(RATE) / 2, rate_hz: RATE });
    director.register_music(THEME, SoundInfo { frames: u64::from(RATE) * 120, rate_hz: RATE });
    director.register_music(STING, SoundInfo { frames: u64::from(RATE), rate_hz: 44_100 });
    director
}

fn play(director: &mut Director, sound: SoundId, opts: PlayOpts) -> (Voice, AudioCommand) {
    let voice = director.issue_voice();
    (voice, AudioCommand::Play { voice, sound, opts })
}

fn step(director: &mut Director, commands: &[AudioCommand]) -> Vec<MixerOp> {
    director.step(commands, StepInput::default()).to_vec()
}

fn events(director: &Director) -> Vec<AudioEvent> {
    director.events().events().to_vec()
}

fn logical(voice: u32, sound: u32, priority: u8, started_tick: u64) -> LogicalVoice {
    LogicalVoice {
        voice: Voice::from_id(voice),
        sound: SoundId(sound),
        bus: Bus::Sfx,
        priority,
        started_tick,
        position_frames: 0.0,
        frames: 1,
        rate_hz: RATE,
        looped: false,
        gain_db: 0.0,
        pan: 0.0,
        pitch: 1.0,
        cutoff_hz: 20_000.0,
        send_db: -60.0,
        occluded: false,
        at: None,
        spatial: Spatial::default(),
        slot: None,
        never_virtual: false,
    }
}

#[test]
fn the_steal_victim_is_lowest_priority_then_oldest_then_highest_id() {
    let table: [(&[LogicalVoice], u8, Option<u32>); 6] = [
        (&[logical(1, 0, 100, 5), logical(2, 0, 50, 9), logical(3, 0, 50, 7)], 128, Some(3)),
        (&[logical(1, 0, 50, 7), logical(2, 0, 50, 7), logical(3, 0, 90, 1)], 128, Some(2)),
        (&[logical(1, 0, 200, 1), logical(2, 0, 200, 2)], 128, None),
        (&[logical(1, 0, 128, 3), logical(2, 0, 128, 2)], 128, Some(2)),
        (&[logical(1, 0, 129, 3), logical(2, 0, 127, 9)], 128, Some(2)),
        (&[], 0, None),
    ];
    for (voices, priority, want) in table {
        assert_eq!(steal_victim(voices, priority), want.map(Voice::from_id), "{voices:?} at priority {priority}");
    }
}

#[test]
fn the_instance_victim_is_the_oldest_of_the_same_sound_at_its_cap() {
    let voices = [logical(1, 7, 128, 4), logical(2, 3, 128, 1), logical(3, 7, 128, 2), logical(4, 7, 128, 2)];
    assert_eq!(instance_victim(&voices, SoundId(7), 3), Some(Voice::from_id(3)), "oldest tick, then lowest id");
    assert_eq!(instance_victim(&voices, SoundId(7), 4), None, "under the cap");
    assert_eq!(instance_victim(&voices, SoundId(7), 0), None, "0 is no cap");
    assert_eq!(instance_victim(&voices, SoundId(3), 1), Some(Voice::from_id(2)));
}

#[test]
fn the_pool_ranks_never_virtual_then_priority_then_gain_then_age_then_id() {
    let mut ui = logical(1, 0, 10, 9);
    ui.never_virtual = true;
    let mut loud = logical(2, 0, 128, 5);
    loud.gain_db = -1.0;
    let mut quiet = logical(3, 0, 128, 1);
    quiet.gain_db = -20.0;
    let mut early = logical(4, 0, 128, 1);
    early.gain_db = -1.0;
    let high = logical(5, 0, 250, 9);
    let mut twin = logical(6, 0, 128, 1);
    twin.gain_db = -1.0;
    let order: Vec<u32> = {
        let voices = [ui, loud, quiet, early, high, twin];
        rank_for_pool(&voices).into_iter().map(|i| voices[i].voice.id()).collect()
    };
    assert_eq!(order, vec![1, 5, 4, 6, 2, 3]);
}

#[test]
fn max_instances_steals_the_oldest_of_the_same_sound() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let mut first = Vec::new();
    for _ in 0..4 {
        let (voice, command) = play(&mut director, LONG, PlayOpts::default());
        step(&mut director, &[command]);
        first.push(voice);
    }
    let (thief, command) = play(&mut director, LONG, PlayOpts::default());
    let ops = step(&mut director, &[command]);
    assert!(!director.playing(first[0]) && director.playing(thief));
    let stolen = events(&director).into_iter().find(|e| e.code == AudioEventCode::Stolen).expect("a stolen event");
    assert_eq!((stolen.voice, stolen.by, stolen.sound), (first[0], thief, Some(LONG)));
    assert!(ops.iter().any(|op| matches!(op, MixerOp::Stop { fade_s, .. } if *fade_s == 0.005)), "a 5 ms steal fade: {ops:?}");
    let (other, command) = play(&mut director, SHORT, PlayOpts::default().max_instances(1));
    step(&mut director, &[command]);
    assert!(director.playing(other), "another sound has its own cap");
    assert_eq!(director.voices().len(), 5);
}

#[test]
fn a_play_that_outranks_no_one_is_refused_with_a_typed_limit() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let commands: Vec<AudioCommand> = (0..LOGICAL_VOICES_MAX)
        .map(|_| play(&mut director, LONG, PlayOpts::default().priority(200).max_instances(0)).1)
        .collect();
    step(&mut director, &commands);
    assert_eq!(director.voices().len(), LOGICAL_VOICES_MAX);
    let (refused, command) = play(&mut director, SHORT, PlayOpts::default().priority(100));
    step(&mut director, &[command]);
    assert!(!director.playing(refused));
    let event = events(&director).into_iter().find(|e| e.code == AudioEventCode::Refused).expect("refused");
    assert_eq!((event.voice, event.reason), (refused, Some(AudioErrorCode::SoundLimit)));
    let (thief, command) = play(&mut director, SHORT, PlayOpts::default().priority(200));
    step(&mut director, &[command]);
    assert!(director.playing(thief), "an equal priority steals the oldest");
    assert!(!director.playing(Voice::from_id(64)), "all started on one tick: the highest id goes");
    assert!(director.playing(Voice::from_id(1)));

    let mut capped = self::director(PoolClass::Desktop, AudioSetup::default());
    let guards: Vec<AudioCommand> =
        (0..2).map(|_| play(&mut capped, LONG, PlayOpts::default().priority(200).max_instances(2)).1).collect();
    step(&mut capped, &guards);
    let (late, command) = play(&mut capped, LONG, PlayOpts::default().priority(100).max_instances(2));
    step(&mut capped, &[command]);
    let event = events(&capped).into_iter().find(|e| e.code == AudioEventCode::Refused).expect("refused");
    assert_eq!((event.voice, event.reason, capped.playing(late)), (late, Some(AudioErrorCode::InstanceLimit), false));
    assert_eq!(capped.events().counts().refused, 1);
    let (missing, command) = play(&mut capped, SoundId(99), PlayOpts::default());
    step(&mut capped, &[command]);
    let event = events(&capped).into_iter().find(|e| e.code == AudioEventCode::Refused).expect("refused");
    assert_eq!((event.voice, event.reason, capped.playing(missing)), (missing, Some(AudioErrorCode::SoundMissing), false));
}

#[test]
fn a_one_shot_ends_on_its_last_frame_and_answers_its_position() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let (voice, command) = play(&mut director, SHORT, PlayOpts::default());
    step(&mut director, &[command]);
    assert_eq!(director.position_s(voice), Some(1.0 / 60.0));
    for tick in 1..29 {
        step(&mut director, &[]);
        assert!(director.playing(voice), "tick {tick}");
    }
    step(&mut director, &[]);
    assert!(!director.playing(voice) && director.position_s(voice).is_none());
    assert_eq!(events(&director).first().map(|e| (e.code, e.voice)), Some((AudioEventCode::Ended, voice)));
    let (fast, command) = play(&mut director, SHORT, PlayOpts::default().pitch(2.0));
    step(&mut director, &[command]);
    for _ in 1..15 {
        step(&mut director, &[]);
    }
    assert!(!director.playing(fast), "pitch 2 plays half a second in 15 ticks");
    let (looped, command) = play(&mut director, SHORT, PlayOpts::default().looped());
    step(&mut director, &[command]);
    for _ in 0..100 {
        step(&mut director, &[]);
    }
    let wrapped = director.position_s(looped).unwrap();
    assert!(director.playing(looped) && wrapped < 0.5, "a loop wraps: {wrapped}");
}

/// A scripted scene of 60 voices (more than any pool) with spatial movement, stops and music.
fn pool_scene(director: &mut Director, tick: u32) -> Vec<AudioCommand> {
    let mut commands = Vec::new();
    if tick < 60 {
        let i = tick as f32;
        let opts = PlayOpts::default()
            .looped()
            .priority(100 + (tick % 7) as u8)
            .volume_db(-((tick % 13) as f32))
            .max_instances(0)
            .at(Vec3::new(libm::sinf(i) * 10.0, 0.0, libm::cosf(i) * 10.0));
        commands.push(play(director, LONG, opts).1);
    }
    if tick % 9 == 4 && tick > 20 {
        commands.push(AudioCommand::Stop { voice: Voice::from_id(tick / 3), fade_s: 0.1 });
    }
    if tick.is_multiple_of(5) {
        let voice = Voice::from_id(1 + tick % 40);
        commands.push(AudioCommand::SetPosition { voice, position: Vec3::new(tick as f32 * 0.1, 0.0, -2.0) });
    }
    if tick == 30 {
        commands.push(AudioCommand::Music { music: THEME, opts: MusicOpts::default() });
    }
    commands
}

#[test]
fn logical_state_is_identical_at_every_pool_size() {
    let mut runs: Vec<Director> = [PoolClass::Desktop, PoolClass::Web, PoolClass::Phone]
        .into_iter()
        .map(|class| director(class, AudioSetup::default()))
        .collect();
    let mut virtual_seen = [0usize; 3];
    for tick in 0..240 {
        let mut hashes = Vec::new();
        for (index, run) in runs.iter_mut().enumerate() {
            let commands = pool_scene(run, tick);
            run.step(&commands, StepInput::default());
            hashes.push(run.logical_hash());
            virtual_seen[index] = virtual_seen[index].max(run.voices().iter().filter(|v| v.is_virtual()).count());
            let real = run.voices().iter().filter(|v| !v.is_virtual()).count();
            assert!(real <= run.class().physical_voices(), "tick {tick}: {real} real voices");
        }
        assert!(hashes.windows(2).all(|pair| pair[0] == pair[1]), "tick {tick}: {hashes:x?}");
    }
    assert!(virtual_seen[2] > virtual_seen[1] && virtual_seen[1] > virtual_seen[0], "{virtual_seen:?}");
    let strip = |run: &Director| -> Vec<LogicalVoice> { run.voices().iter().map(|v| LogicalVoice { slot: None, ..*v }).collect() };
    assert_eq!(strip(&runs[0]), strip(&runs[2]), "only the virtual flags differ");
}

#[test]
fn a_realized_voice_starts_at_its_logical_offset() {
    let mut director = director(PoolClass::Phone, AudioSetup::default());
    let guards: Vec<AudioCommand> =
        (0..24).map(|_| play(&mut director, LONG, PlayOpts::default().looped().priority(200).max_instances(0)).1).collect();
    step(&mut director, &guards);
    let (waiting, command) = play(&mut director, LONG, PlayOpts::default().looped().priority(10).pitch(1.5).max_instances(0));
    let ops = step(&mut director, &[command]);
    assert!(director.voices().iter().find(|v| v.voice == waiting).unwrap().is_virtual());
    assert!(!ops.iter().any(|op| matches!(op, MixerOp::Start { .. })), "no track for a virtual voice");
    assert_eq!(events(&director).iter().map(|e| e.code).collect::<Vec<_>>(), vec![AudioEventCode::Played, AudioEventCode::Virtualized]);
    for _ in 0..37 {
        step(&mut director, &[]);
    }
    let offset = director.voices().iter().find(|v| v.voice == waiting).unwrap().position_frames;
    assert_eq!(offset, 38.0 * 1.5 * f64::from(RATE) / 60.0, "virtual voices keep time");
    let ops = step(&mut director, &[AudioCommand::Stop { voice: Voice::from_id(3), fade_s: 0.0 }]);
    let start = ops.iter().find_map(|op| match op {
        MixerOp::Start { start_frame, pitch, .. } => Some((*start_frame, *pitch)),
        _ => None,
    });
    assert_eq!(start, Some((offset, 1.5)), "{ops:?}");
    assert!(events(&director).iter().any(|e| e.code == AudioEventCode::Realized && e.voice == waiting));
}

#[test]
fn ducking_follows_its_attack_and_release_envelope() {
    let duck = Duck { trigger: Bus::Voice, target: Bus::Music, depth_db: -12.0, attack_s: 0.1, release_s: 0.2 };
    let mut director = director(PoolClass::Desktop, AudioSetup { ducks: vec![duck], ..AudioSetup::default() });
    let music_db = |ops: &[MixerOp]| {
        ops.iter().find_map(|op| match op {
            MixerOp::BusVolume { bus: Bus::Music, db, .. } => Some(*db),
            _ => None,
        })
    };
    assert_eq!(music_db(&step(&mut director, &[])), None, "no op while nothing changes");
    let (_, line) = play(&mut director, SHORT, PlayOpts::default().on(Bus::Voice));
    let mut table = vec![music_db(&step(&mut director, &[line]))];
    for _ in 0..50 {
        table.push(music_db(&step(&mut director, &[])));
    }
    let attack: Vec<f32> = (1..=6).map(|i| -2.0 * i as f32).collect();
    assert_eq!(table[..6].iter().map(|db| db.unwrap()).collect::<Vec<_>>(), attack, "6 ticks to -12 dB");
    assert!(table[6..30].iter().all(Option::is_none), "held while the line plays: {table:?}");
    let release: Vec<f32> = (1..=12).map(|i| -12.0 + i as f32).collect();
    assert_eq!(table[30..42].iter().map(|db| db.unwrap()).collect::<Vec<_>>(), release, "12 ticks back to 0 dB");
    assert!(table[42..].iter().all(Option::is_none));
    assert_eq!(director.bus_db(Bus::Music), 0.0);
    step(&mut director, &[AudioCommand::BusVolume { bus: Bus::Music, db: -6.0, fade_s: 0.0 }]);
    let (_, line) = play(&mut director, SHORT, PlayOpts::default().on(Bus::Voice));
    let ducked = music_db(&step(&mut director, &[line]));
    assert_eq!(ducked, Some(-8.0), "the duck sits on top of the game's own bus layer");
}

#[test]
fn music_crossfades_between_tracks_a_and_b_and_reports_its_end() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let ops = step(&mut director, &[AudioCommand::Music { music: THEME, opts: MusicOpts { fade_s: 0.0, ..MusicOpts::default() } }]);
    assert!(matches!(ops.as_slice(), [MixerOp::MusicStart { track: MusicTrack::A, music: THEME, .. }]), "{ops:?}");
    assert_eq!(events(&director).first().map(|e| (e.code, e.music)), Some((AudioEventCode::MusicStarted, Some(THEME))));
    assert_eq!((director.music_track(), director.music_volume_db(MusicTrack::A)), (Some(MusicTrack::A), Some(0.0)));
    for _ in 0..9 {
        step(&mut director, &[]);
    }
    assert_eq!(director.music_position_s(MusicTrack::A), Some(10.0 / 60.0));
    let sting = MusicOpts { fade_s: 0.5, looped: false, volume_db: -3.0, ..MusicOpts::default() };
    let ops = step(&mut director, &[AudioCommand::Music { music: STING, opts: sting }]);
    assert!(ops.contains(&MixerOp::MusicStop { track: MusicTrack::A, fade_s: 0.5 }), "{ops:?}");
    assert!(ops.contains(&MixerOp::MusicStart { track: MusicTrack::B, music: STING, opts: sting }), "{ops:?}");
    assert_eq!(director.music_track(), Some(MusicTrack::B));
    let mut volumes = vec![(director.music_volume_db(MusicTrack::A), director.music_volume_db(MusicTrack::B))];
    for _ in 0..30 {
        step(&mut director, &[]);
        volumes.push((director.music_volume_db(MusicTrack::A), director.music_volume_db(MusicTrack::B)));
    }
    let (a, b) = volumes[14];
    assert!((a.unwrap() + 30.0).abs() < 1e-4 && (b.unwrap() + 31.5).abs() < 1e-4, "half way: {a:?} {b:?}");
    assert_eq!(volumes[29], (None, Some(-3.0)), "A is gone once its fade ends");
    assert_eq!(volumes[30], (None, Some(-3.0)));
    let mut ended = None;
    for tick in 31..80 {
        step(&mut director, &[]);
        if events(&director).iter().any(|e| e.code == AudioEventCode::MusicEnded && e.music == Some(STING)) {
            ended = Some(tick);
        }
    }
    assert_eq!(ended, Some(65), "48 000 frames at 735 a tick end on the sting's 66th tick: {volumes:?}");
    assert_eq!(director.music_track(), None);
    let ops = step(&mut director, &[AudioCommand::StopMusic { fade_s: 1.0 }]);
    assert!(ops.is_empty(), "nothing to stop");
}

#[test]
fn non_finite_commands_are_dropped_with_invalid_value() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let (voice, command) = play(&mut director, LONG, PlayOpts::default().looped().at(Vec3::new(0.0, 0.0, -3.0)));
    step(&mut director, &[command]);
    let before = director.voices().to_vec();
    let (bad, bad_play) = play(&mut director, LONG, PlayOpts::default().pitch(f32::NAN));
    let hostile = [
        bad_play,
        AudioCommand::SetVolume { voice, db: f32::NAN, fade_s: 0.0 },
        AudioCommand::SetPitch { voice, rate: f32::INFINITY, fade_s: 0.0 },
        AudioCommand::SetPosition { voice, position: Vec3::new(f32::NAN, 0.0, 0.0) },
        AudioCommand::Teleport { voice, position: Vec3::splat(f32::NEG_INFINITY) },
        AudioCommand::SetVolume { voice, db: -3.0, fade_s: f32::NAN },
        AudioCommand::BusVolume { bus: Bus::Sfx, db: f32::NAN, fade_s: 0.0 },
        AudioCommand::MasterVolume { db: 0.0, fade_s: f32::INFINITY },
        AudioCommand::Listener(Some(Listener { position: Vec3::splat(f32::NAN), forward: Vec3::NEG_Z, up: Vec3::Y })),
        AudioCommand::Music { music: THEME, opts: MusicOpts { volume_db: f32::NAN, ..MusicOpts::default() } },
    ];
    let ops = step(&mut director, &hostile);
    let refusals: Vec<Option<AudioErrorCode>> = events(&director).iter().map(|e| e.reason).collect();
    assert_eq!(refusals, vec![Some(AudioErrorCode::InvalidValue); hostile.len()]);
    assert!(!director.playing(bad));
    let after: Vec<LogicalVoice> = director.voices().iter().map(|v| LogicalVoice { position_frames: 0.0, ..*v }).collect();
    let before: Vec<LogicalVoice> = before.iter().map(|v| LogicalVoice { position_frames: 0.0, ..*v }).collect();
    assert_eq!(after, before, "nothing changed");
    assert!(ops.is_empty(), "no op reaches the mixer: {ops:?}");
    assert_eq!(director.music_track(), None);
}

#[test]
fn voice_and_zone_ids_restart_at_one_after_a_seed() {
    let zone = ReverbZone {
        name: "hall",
        shape: ZoneShape::Sphere { center: Vec3::ZERO, radius: 5.0 },
        preset: ReverbPreset::HALL,
        send_db: -6.0,
        uniformity: 0.5,
    };
    let mut director = director(PoolClass::Desktop, AudioSetup { zones: vec![zone], ..AudioSetup::default() });
    let ids: Vec<u32> = (0..3).map(|_| director.issue_voice().id()).collect();
    assert_eq!(ids, vec![1, 2, 3]);
    assert_eq!(director.issue_zone().id(), 2, "the setup's zone took id 1");
    let (_, command) = play(&mut director, LONG, PlayOpts::default());
    step(&mut director, &[command]);
    director.reset();
    assert_eq!(director.issue_voice().id(), 1);
    assert_eq!(director.issue_zone().id(), 2);
    assert!(director.voices().is_empty() && director.events().counts().played == 0);
    assert_eq!(director.zones().len(), 1, "the setup's zones come back on every seed");
    assert_eq!(director.tick(), 0);
}

/// A 2,000-tick seeded fuzz over every command, answering the logical-state hash every 100 ticks.
fn fuzz_session(class: PoolClass) -> Vec<u64> {
    let duck = Duck { trigger: Bus::Voice, target: Bus::Ambience, depth_db: -9.0, attack_s: 0.05, release_s: 0.3 };
    let cave = ReverbZone {
        name: "cave",
        shape: ZoneShape::Box { min: Vec3::splat(-8.0), max: Vec3::splat(8.0) },
        preset: ReverbPreset::CAVE,
        send_db: -4.0,
        uniformity: 0.7,
    };
    let setup = AudioSetup { ducks: vec![duck], zones: vec![cave], ..AudioSetup::default() };
    let mut director = director(class, setup);
    let mut rng = Pcg32::seeded(0x5eed_a0d1);
    let mut hashes = Vec::new();
    for tick in 0..2_000 {
        let commands: Vec<AudioCommand> = (0..rng.below(4)).map(|_| fuzz_command(&mut director, &mut rng)).collect();
        director.step(&commands, StepInput::default());
        if tick % 100 == 99 {
            hashes.push(director.logical_hash());
        }
    }
    hashes
}

fn fuzz_position(rng: &mut Pcg32) -> Vec3 {
    Vec3::new(rng.range_f32(-30.0, 30.0), rng.range_f32(-3.0, 3.0), rng.range_f32(-30.0, 30.0))
}

fn fuzz_command(director: &mut Director, rng: &mut Pcg32) -> AudioCommand {
    let known = Voice::from_id(1 + rng.below(80));
    let bus = Bus::ALL[rng.below(Bus::ALL.len() as u32) as usize];
    match rng.below(12) {
        0..=3 => {
            let sound = if rng.chance(0.5) { LONG } else { SHORT };
            let mut opts = PlayOpts::default().on(bus).priority(rng.below(256) as u8).volume_db(rng.range_f32(-20.0, 0.0));
            opts = opts.pitch(rng.range_f32(0.5, 2.0)).max_instances(rng.below(6) as u8);
            if rng.chance(0.4) {
                opts = opts.looped();
            }
            if rng.chance(0.7) {
                let falloff = Spatial { doppler: rng.unit(), ..Spatial::default() };
                opts = opts.at(fuzz_position(rng)).spatial(falloff);
            }
            play(director, sound, opts).1
        }
        4 => AudioCommand::Stop { voice: known, fade_s: rng.range_f32(0.0, 0.5) },
        5 => AudioCommand::SetPosition { voice: known, position: fuzz_position(rng) },
        6 => AudioCommand::Teleport { voice: known, position: fuzz_position(rng) },
        7 => AudioCommand::SetVolume { voice: known, db: rng.range_f32(-30.0, 0.0), fade_s: rng.range_f32(0.0, 1.0) },
        8 => AudioCommand::SetPitch { voice: known, rate: rng.range_f32(0.5, 2.0), fade_s: rng.range_f32(0.0, 1.0) },
        9 => AudioCommand::BusVolume { bus, db: rng.range_f32(-24.0, 0.0), fade_s: rng.range_f32(0.0, 1.0) },
        10 => {
            let music = if rng.chance(0.5) { THEME } else { STING };
            let opts = MusicOpts { fade_s: rng.range_f32(0.0, 2.0), looped: rng.chance(0.5), ..MusicOpts::default() };
            AudioCommand::Music { music, opts }
        }
        _ => {
            let ears = Listener { position: fuzz_position(rng), forward: Vec3::NEG_Z, up: Vec3::Y };
            AudioCommand::Listener(rng.chance(0.8).then_some(ears))
        }
    }
}

fn digest(hashes: &[u64]) -> String {
    hashes.iter().map(|hash| format!("{hash:016x}")).collect::<Vec<_>>().join(",")
}

#[test]
fn a_seeded_fuzz_has_the_same_logical_hash_in_two_processes() {
    if std::env::var_os(FUZZ_CHILD_ENV).is_some() {
        println!("{FUZZ_LINE}{}", digest(&fuzz_session(PoolClass::Desktop)));
        return;
    }
    let child = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "a_seeded_fuzz_has_the_same_logical_hash_in_two_processes", "--nocapture", "--test-threads=1"])
            .env(FUZZ_CHILD_ENV, "1")
            .output()
            .expect("re-run the test binary");
        assert!(output.status.success(), "child failed: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8(output.stdout).unwrap();
        stdout.lines().find_map(|l| l.split_once(FUZZ_LINE)).map(|(_, digest)| digest.to_owned()).expect("a digest line")
    };
    let here = digest(&fuzz_session(PoolClass::Desktop));
    assert_eq!(child(), here);
    assert_eq!(child(), here);
    assert_eq!(digest(&fuzz_session(PoolClass::Phone)), here, "the pool size never changes the logical state");
    let last = here.rsplit(',').next().unwrap();
    assert_eq!(last, FUZZ_DIGEST, "the pinned digest every destination must answer");
}

/// The fuzz's last logical hash on aarch64-apple-darwin.
const FUZZ_DIGEST: &str = "334abd1ecd006144";

/// A scene with looped voices (spatial and not), a volume fade in flight, a duck, a moved bus,
/// music mid-crossfade, an added zone and a listener override: everything a save keeps.
fn save_scene(director: &mut Director, tick: u32) -> Vec<AudioCommand> {
    let mut commands = Vec::new();
    match tick {
        0 => {
            for i in 0..6 {
                let at = Vec3::new(i as f32 * 3.0 - 7.0, 0.0, -4.0);
                let falloff = Spatial { doppler: 1.0, ..Spatial::default() };
                commands.push(play(director, LONG, PlayOpts::default().looped().at(at).spatial(falloff).max_instances(0)).1);
            }
            commands.push(play(director, SHORT, PlayOpts::default().looped().on(Bus::Ambience).volume_db(-4.0)).1);
            commands.push(AudioCommand::Music { music: THEME, opts: MusicOpts { fade_s: 0.0, ..MusicOpts::default() } });
        }
        5 => {
            let zone = ReverbZone {
                name: "crypt",
                shape: ZoneShape::Sphere { center: Vec3::new(0.0, 0.0, 2.0), radius: 3.0 },
                preset: ReverbPreset::CAVE,
                send_db: -3.0,
                uniformity: 1.0,
            };
            commands.push(AudioCommand::AddZone { zone: director.issue_zone(), def: zone });
            commands.push(AudioCommand::BusVolume { bus: Bus::Sfx, db: -5.0, fade_s: 0.5 });
        }
        20 => {
            commands.push(AudioCommand::SetVolume { voice: Voice::from_id(2), db: -18.0, fade_s: 2.0 });
            commands.push(AudioCommand::Music { music: STING, opts: MusicOpts { fade_s: 3.0, looped: true, ..MusicOpts::default() } });
            commands.push(AudioCommand::Listener(Some(Listener { position: Vec3::new(0.0, 0.0, 1.0), forward: Vec3::X, up: Vec3::Y })));
        }
        _ => {}
    }
    if tick % 7 == 3 {
        let voice = Voice::from_id(1 + tick % 6);
        commands.push(AudioCommand::SetPosition { voice, position: Vec3::new(libm::sinf(tick as f32) * 6.0, 0.0, -5.0) });
    }
    if tick == 400 {
        commands.push(AudioCommand::Stop { voice: Voice::from_id(4), fade_s: 0.2 });
    }
    if tick % 50 == 40 {
        commands.push(play(director, SHORT, PlayOpts::default().on(Bus::Voice)).1);
    }
    commands
}

const SAVE_AT: u32 = 30;
const REPLAY_TICKS: u32 = 300;

#[test]
fn snapshot_then_restore_then_300_ticks_equals_the_uninterrupted_run() {
    let duck = Duck { trigger: Bus::Voice, target: Bus::Ambience, depth_db: -9.0, attack_s: 0.1, release_s: 0.5 };
    let setup = AudioSetup { ducks: vec![duck], ..AudioSetup::default() };
    let mut straight = director(PoolClass::Desktop, setup.clone());
    let mut section = None;
    for tick in 0..SAVE_AT + REPLAY_TICKS {
        if tick == SAVE_AT {
            section = Some(straight.snapshot());
        }
        let commands = save_scene(&mut straight, tick);
        straight.step(&commands, StepInput::default());
    }
    let section = section.unwrap();
    assert!(section.get("voices").is_some_and(|v| v.items().len() == 7), "the looped voices are kept: {section:?}");
    for class in [PoolClass::Desktop, PoolClass::Phone] {
        let mut restored = director(class, setup.clone());
        for tick in 0..17 {
            let commands = pool_scene(&mut restored, tick);
            restored.step(&commands, StepInput::default());
        }
        restored.restore(&section).expect("restore");
        for tick in SAVE_AT..SAVE_AT + REPLAY_TICKS {
            let commands = save_scene(&mut restored, tick);
            restored.step(&commands, StepInput::default());
        }
        assert_eq!(restored.logical_hash(), straight.logical_hash(), "{class:?}");
        let strip = |run: &Director| -> Vec<LogicalVoice> { run.voices().iter().map(|v| LogicalVoice { slot: None, ..*v }).collect() };
        assert_eq!(strip(&restored), strip(&straight));
        assert_eq!(restored.music_position_s(MusicTrack::B), straight.music_position_s(MusicTrack::B));
    }
}

#[test]
fn restore_refuses_a_section_it_cannot_read_and_keeps_its_state() {
    let mut director = director(PoolClass::Desktop, AudioSetup::default());
    let (voice, command) = play(&mut director, LONG, PlayOpts::default().looped());
    step(&mut director, &[command]);
    let hash = director.logical_hash();
    let mut wrong_version = director.snapshot();
    wrong_version.set("version", genex_core::json::Value::Number(99.0));
    let mut bad_voice = director.snapshot();
    let mut voices = bad_voice.get("voices").cloned().unwrap();
    if let genex_core::json::Value::Array(items) = &mut voices {
        items[0].set("sound", genex_core::json::Value::String(b"loud".to_vec()));
    }
    bad_voice.set("voices", voices);
    for hostile in [genex_core::json::Value::Null, genex_core::json::Value::Number(3.0), wrong_version, bad_voice] {
        let refused = director.restore(&hostile).expect_err("refused");
        assert_eq!(refused.code(), AudioErrorCode::InvalidValue);
        assert_eq!(director.logical_hash(), hash, "no side effect");
        assert!(director.playing(voice));
    }
    let _ = PRIORITY_DEFAULT;
}

fn sine(rate: u32, seconds: f64, frequency: f64) -> Sound {
    let frames = (f64::from(rate) * seconds) as usize;
    let samples: Vec<[f32; 2]> = (0..frames)
        .map(|i| {
            let value = 0.3 * libm::sin(2.0 * std::f64::consts::PI * frequency * i as f64 / f64::from(rate)) as f32;
            [value, value]
        })
        .collect();
    Sound::from_frames(rate, &samples)
}

#[test]
fn the_directors_ops_render_on_the_mixer_with_none_dropped() {
    for class in [PoolClass::Desktop, PoolClass::Phone] {
        let mut mixer = Mixer::new(class).expect("mixer");
        let mut director = Director::new(class, AudioSetup::default());
        for (seconds, frequency) in [(10.0, 220.0), (0.5, 880.0)] {
            let id = mixer.add_sound(sine(MIXER_RATE_HZ, seconds, frequency));
            director.register_sound(id, SoundInfo { frames: (f64::from(MIXER_RATE_HZ) * seconds) as u64, rate_hz: MIXER_RATE_HZ });
        }
        for (rate, seconds) in [(MIXER_RATE_HZ, 4.0), (44_100, 1.0)] {
            let id = mixer.add_music(Music::from_sound(sine(rate, seconds, 330.0)));
            director.register_music(id, SoundInfo { frames: (f64::from(rate) * seconds) as u64, rate_hz: rate });
        }
        let mut rng = Pcg32::seeded(0xa0d1_0002);
        let mut loudest = 0.0_f64;
        for _ in 0..600 {
            let commands: Vec<AudioCommand> = (0..rng.below(4)).map(|_| fuzz_command(&mut director, &mut rng)).collect();
            let ops = director.step(&commands, StepInput::default()).to_vec();
            mixer.apply(&ops);
            mixer.tick();
            loudest = loudest.max(mixer.level().rms);
            assert!(mixer.active_voices() <= class.physical_voices());
        }
        assert_eq!(mixer.dropped_ops(), 0, "{class:?}: every op names a real slot, sound and finite value");
        assert!(loudest > 0.01, "{class:?}: the voices are heard: rms {loudest}");
    }
}

/// A free occluder: a wall on the positive x side.
struct HalfWall;

impl genex_audio::Occluder for HalfWall {
    fn transmission(&mut self, _from: Vec3, to: Vec3) -> f32 {
        if to.x > 0.0 { 0.35 } else { 1.0 }
    }
}

/// The advisory `audio.decide` row: 64 moving spatial voices with Doppler, a duck, a zone and
/// occlusion, one Director step per tick, on the Phone pool.
/// `cargo test -p genex-audio --release --test director -- --ignored --nocapture`.
#[test]
#[ignore = "timing row: run in release on a quiet machine"]
#[allow(clippy::disallowed_types, reason = "test timing: the row measures how long a Director step holds the thread")]
fn timing_64_spatial_voices_per_step() {
    use std::time::Instant;
    const TICKS: u32 = 600;
    let duck = Duck { trigger: Bus::Voice, target: Bus::Music, depth_db: -9.0, attack_s: 0.1, release_s: 0.3 };
    let hall = ReverbZone {
        name: "hall",
        shape: ZoneShape::Box { min: Vec3::splat(-50.0), max: Vec3::splat(50.0) },
        preset: ReverbPreset::HALL,
        send_db: -6.0,
        uniformity: 0.5,
    };
    let setup = AudioSetup { ducks: vec![duck], zones: vec![hall], occlusion: true, ..AudioSetup::default() };
    let mut director = director(PoolClass::Phone, setup);
    let falloff = Spatial { doppler: 1.0, ..Spatial::default() };
    let plays: Vec<AudioCommand> = (0..LOGICAL_VOICES_MAX)
        .map(|i| {
            let at = Vec3::new(libm::sinf(i as f32) * 20.0, 0.0, libm::cosf(i as f32) * 20.0);
            play(&mut director, LONG, PlayOpts::default().looped().max_instances(0).at(at).spatial(falloff)).1
        })
        .collect();
    let mut wall = HalfWall;
    director.step(&plays, StepInput { camera: None, occluder: Some(&mut wall) });
    let started = Instant::now();
    for tick in 0..TICKS {
        let moves: Vec<AudioCommand> = (1..=LOGICAL_VOICES_MAX as u32)
            .map(|id| {
                let angle = (tick + id) as f32 * 0.01;
                let position = Vec3::new(libm::sinf(angle) * 20.0, 0.0, libm::cosf(angle) * 20.0);
                AudioCommand::SetPosition { voice: Voice::from_id(id), position }
            })
            .collect();
        director.step(&moves, StepInput { camera: None, occluder: Some(&mut wall) });
    }
    let per_tick_ms = started.elapsed().as_secs_f64() * 1000.0 / f64::from(TICKS);
    println!("genex-audio decide: 64 spatial voices, {per_tick_ms:.4} ms/tick");
    assert_eq!(director.voices().len(), LOGICAL_VOICES_MAX);
}
