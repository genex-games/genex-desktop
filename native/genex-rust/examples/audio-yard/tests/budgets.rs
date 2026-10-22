//! audio-yard's audio budgets (AU-10's GE rows), advisory in a lane and gating at GE on a quiet
//! machine. Both rows are `#[ignore]`d and named `budget`; run them in release:
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p audio-yard --release --offline \
//!     --test budgets -- --ignored budget --nocapture --test-threads 1
//!
//! - **Mixer cost.** The yard's own sounds, looping as 64 logical spatial voices inside the cave's
//!   reverb zone, rendered by genex-audio's mixer at a pool class's physical voices (48 on
//!   desktop, 24 on a phone): the median render of a tick over five batches must stay within
//!   0.6 ms on desktop. The phone pool's cost on this Mac times [`MOBILE_MID_FACTOR`] is the
//!   mobile-mid estimate, within 1.5 ms.
//! - **Music resident.** A three-minute track (the Ogg `GENEX_AUDIO_YARD_LONG_OGG` names, else the
//!   yard track looping) holds its file plus at most genex-audio's working set, within 4 MB; the
//!   yard's crossfade holds two files and two working sets. An allocator that tracks this thread's
//!   live bytes counts them.

#![allow(clippy::disallowed_types, reason = "the timing row reads the wall clock, outside any simulation")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;
use std::time::Instant;

use audio_yard_game::ASSETS;
use genex_audio::{
    AudioCommand, AudioSetup, Director, Listener, MUSIC_WORKING_BYTES, Mixer, MixerOp, Music, MusicId, MusicOpts, MusicTrack, PlayOpts,
    PoolClass,
    ReverbPreset, ReverbZone, SoundId, SoundInfo, StepInput, ZoneShape, decode_sound,
};
use genex::glam::Vec3;

/// The desktop budget for one tick's render at the full pool, ms.
const DESKTOP_TICK_MS: f64 = 0.6;
/// The mobile-mid budget for one tick's render at the phone pool, ms.
const MOBILE_MID_TICK_MS: f64 = 1.5;
/// How much slower a mid-range phone's big core runs this code than this Mac's: Geekbench 6
/// single-core, about 3,900 on an M4 Max against about 1,100 on a 2024 mid-range Android phone.
const MOBILE_MID_FACTOR: f64 = 3.5;
/// The GE budget for a three-minute music track's resident bytes.
const MUSIC_RESIDENT_BUDGET_BYTES: usize = 4 * 1024 * 1024;
const LOGICAL_VOICES: usize = 64;
const WARM_TICKS: usize = 60;
const BATCH_TICKS: usize = 600;
const BATCHES: usize = 5;
/// Three minutes of ticks.
const THREE_MINUTES_TICKS: usize = 3 * 60 * 60;
/// Ticks between the music crossfades of the resident row.
const CROSSFADE_EVERY_TICKS: usize = 600;
const LONG_OGG_ENV: &str = "GENEX_AUDIO_YARD_LONG_OGG";
/// The looping sounds the cost row plays (each in turn round the ring of voices).
const LOOPS: [&str; 4] = ["sfx/cricket.wav", "sfx/hum.wav", "sfx/drone.wav", "sfx/footstep.wav"];

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

fn count(delta: isize) {
    let _ = LIVE.try_with(|live| {
        live.set(live.get() + delta);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(live.get())));
    });
}

/// Counts the bytes each thread holds, so a row measures what streaming music keeps resident.
struct Counting;

// SAFETY: every call forwards to the system allocator unchanged; only the counters are added.
#[allow(unsafe_code, reason = "a test allocator that counts live bytes per thread")]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size() as isize);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count(-(layout.size() as isize));
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(new_size as isize - layout.size() as isize);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Peak bytes this thread held above what it held before `run`.
fn peak_while(run: impl FnOnce()) -> usize {
    let before = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    run();
    usize::try_from(PEAK.with(Cell::get) - before).unwrap_or(0)
}

fn asset(path: &str) -> &'static [u8] {
    ASSETS.iter().find(|(name, _)| *name == path).map(|(_, bytes)| *bytes).unwrap_or_else(|| panic!("{path} is in the table"))
}

fn cave() -> AudioSetup {
    let zone = ReverbZone {
        name: "cave",
        shape: ZoneShape::Box { min: Vec3::splat(-40.0), max: Vec3::splat(40.0) },
        preset: ReverbPreset::CAVE,
        send_db: -4.0,
        uniformity: 1.0,
    };
    AudioSetup { zones: vec![zone], ..AudioSetup::default() }
}

/// One tick: the Director decides (not timed), the mixer applies and renders (timed, ms).
fn tick(director: &mut Director, mixer: &mut Mixer, commands: &[AudioCommand]) -> f64 {
    let ears = Listener { position: Vec3::Y, forward: Vec3::NEG_Z, up: Vec3::Y };
    let ops: Vec<MixerOp> = director.step(commands, StepInput { camera: Some(ears), occluder: None }).to_vec();
    let started = Instant::now();
    mixer.apply(&ops);
    mixer.tick();
    started.elapsed().as_secs_f64() * 1000.0
}

/// The median ms one tick's render takes with 64 looping spatial voices at `class`'s pool.
fn mixer_tick_ms(class: PoolClass) -> f64 {
    let mut director = Director::new(class, cave());
    let mut mixer = Mixer::new(class).expect("the mixer starts");
    for (index, path) in LOOPS.iter().enumerate() {
        let sound = decode_sound(asset(path), "wav").expect("a synthesized WAV");
        let id = SoundId(u32::try_from(index).expect("four sounds"));
        director.register_sound(id, SoundInfo { frames: sound.frames() as u64, rate_hz: sound.sample_rate() });
        mixer.add_sound(sound);
    }
    let plays: Vec<AudioCommand> = (0..LOGICAL_VOICES)
        .map(|index| {
            let (sin, cos) = genex::math::sin_cos(std::f32::consts::TAU * index as f32 / LOGICAL_VOICES as f32);
            let at = Vec3::new(12.0 * cos, 1.0, 12.0 * sin);
            let sound = SoundId(u32::try_from(index % LOOPS.len()).expect("four sounds"));
            let opts = PlayOpts::default().looped().at(at).max_instances(0);
            AudioCommand::Play { voice: director.issue_voice(), sound, opts }
        })
        .collect();
    tick(&mut director, &mut mixer, &plays);
    for _ in 0..WARM_TICKS {
        tick(&mut director, &mut mixer, &[]);
    }
    assert_eq!(mixer.active_voices(), class.physical_voices(), "{class:?}: the full pool renders");
    let mut batches: Vec<f64> =
        (0..BATCHES).map(|_| (0..BATCH_TICKS).map(|_| tick(&mut director, &mut mixer, &[])).sum::<f64>() / BATCH_TICKS as f64).collect();
    batches.sort_by(f64::total_cmp);
    println!("{class:?}: batches {batches:?} ms/tick");
    batches[BATCHES / 2]
}

#[test]
#[ignore = "a timing row: run in release with --ignored budget"]
fn budget_mixer_tick_desktop_and_mobile_mid() {
    let desktop = mixer_tick_ms(PoolClass::Desktop);
    let phone = mixer_tick_ms(PoolClass::Phone);
    let mobile_mid = phone * MOBILE_MID_FACTOR;
    println!("mixer: desktop 48 voices {desktop:.4} ms/tick; phone 24 voices {phone:.4} ms/tick here, mobile-mid estimate {mobile_mid:.4} ms/tick");
    assert!(desktop <= DESKTOP_TICK_MS, "desktop {desktop:.4} ms > {DESKTOP_TICK_MS} ms");
    assert!(mobile_mid <= MOBILE_MID_TICK_MS, "mobile-mid estimate {mobile_mid:.4} ms > {MOBILE_MID_TICK_MS} ms");
}

/// Streams `tracks` on the mixer for three minutes, crossfading to the next track every
/// `every` ticks; answers the peak bytes held beyond the files.
fn stream_three_minutes(tracks: &[Arc<[u8]>], every: usize) -> usize {
    let mut mixer = Mixer::new(PoolClass::Desktop).expect("the mixer starts");
    mixer.tick();
    peak_while(|| {
        let ids: Vec<MusicId> = tracks.iter().map(|bytes| mixer.add_music(Music::stream(bytes.clone(), "ogg").expect("an Ogg track"))).collect();
        let mut track = MusicTrack::A;
        for tick in 0..THREE_MINUTES_TICKS {
            if tick % every == 0 {
                let music = ids[(tick / every) % ids.len()];
                track = track.other();
                mixer.apply(&[MixerOp::MusicStop { track: track.other(), fade_s: 2.0 }, MixerOp::MusicStart { track, music, opts: MusicOpts { fade_s: 2.0, ..MusicOpts::default() } }]);
            }
            mixer.tick();
        }
        assert!(mixer.music_playing(track), "still playing after three minutes");
    })
}

/// The GE row: one three-minute track (the file `GENEX_AUDIO_YARD_LONG_OGG` names, else the yard
/// track looping for three minutes) holds its file plus one working set, within 4 MB.
#[test]
#[ignore = "a memory row: run in release with --ignored budget"]
fn budget_a_three_minute_track_stays_resident_within_4_mb() {
    let named = std::env::var_os(LONG_OGG_ENV);
    let bytes: Arc<[u8]> = match &named {
        Some(path) => Arc::from(std::fs::read(path).expect("the three-minute Ogg reads")),
        None => Arc::from(asset("music/yard.ogg")),
    };
    let name = named.as_ref().map_or_else(|| "music/yard.ogg (looped)".to_owned(), |path| path.to_string_lossy().into_owned());
    let held = stream_three_minutes(std::slice::from_ref(&bytes), usize::MAX);
    let total = bytes.len() + held;
    println!("music: {name} ({} B) for 3 min: peak held beyond the file {held} B, total {total} B", bytes.len());
    assert!(held <= MUSIC_WORKING_BYTES, "{held} B beyond the file > one working set ({MUSIC_WORKING_BYTES} B)");
    assert!(total <= MUSIC_RESIDENT_BUDGET_BYTES, "{total} B > {MUSIC_RESIDENT_BUDGET_BYTES} B");
}

/// The yard's crossfade every 10 s for three minutes holds the two files plus two working sets
/// (`Music::resident_bytes`: "a crossfade between two streamed tracks holds two working sets").
#[test]
#[ignore = "a memory row: run in release with --ignored budget"]
fn budget_the_yard_crossfade_holds_two_working_sets() {
    let tracks: Vec<Arc<[u8]>> = ["music/yard.ogg", "music/cave.ogg"].iter().map(|path| Arc::from(asset(path))).collect();
    let files: usize = tracks.iter().map(|bytes| bytes.len()).sum();
    let held = stream_three_minutes(&tracks, CROSSFADE_EVERY_TICKS);
    println!("music: yard + cave crossfading every 10 s for 3 min: files {files} B, peak held beyond them {held} B, total {} B", files + held);
    assert!(held <= 2 * MUSIC_WORKING_BYTES, "{held} B beyond the files > two working sets ({} B)", 2 * MUSIC_WORKING_BYTES);
}
