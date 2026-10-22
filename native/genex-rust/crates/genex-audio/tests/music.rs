//! Streamed music: a music track decodes the compressed file inline while it plays. It renders the
//! same samples, bit for bit, as the file decoded whole and played static (at the mixer's rate and
//! at another one, through a loop and its seek), its loops have no gap, it holds the file plus a
//! fixed working set instead of the decoded frames, two processes replay it identically, and a
//! hostile file is refused typed when it is admitted, never a panic.
//!
//! The fixtures in `tests/fixtures` were generated with FFmpeg's libvorbis encoder
//! (`-c:a libvorbis -q:a 0`, `-q:a -1` for the silence): `music-10s.ogg` is two tremolo sines in
//! stereo at 48 kHz, `tone-44k.ogg` a 2 s 440 Hz sine at 44.1 kHz and `silence-3min.ogg` three
//! minutes of stereo silence.

// These rows drive the mixer, device output or decoders (the `mixer` feature, AU-11).
#![cfg(feature = "mixer")]

use genex_audio::{
    AudioErrorCode, MUSIC_WORKING_BYTES, Mixer, MixerOp, Music, MusicId, MusicOpts, MusicTrack, decode_sound,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

const REPLAY_CHILD_ENV: &str = "GENEX_AUDIO_MUSIC_REPLAY_CHILD";
const REPLAY_LINE: &str = "genex-audio-music-replay ";
/// The GE budget for a three-minute music track (EXT-PLAN AU-4, via AU-10).
const THREE_MINUTE_TRACK_BUDGET_BYTES: usize = 4 * 1024 * 1024;

fn fixture(name: &str) -> Vec<u8> {
    let shared = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    let own = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    fs::read(if own.exists() { own } else { shared }).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Every block the mixer renders over `ticks` ticks, as sample bits, after starting `music` on
/// track A with `opts`.
fn render(music: Music, opts: MusicOpts, ticks: usize) -> Vec<Vec<u32>> {
    let mut mixer = Mixer::deviceless().unwrap();
    let id = mixer.add_music(music);
    mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::A, music: id, opts }]);
    (0..ticks).map(|_| mixer.tick().iter().map(|sample| sample.to_bits()).collect()).collect()
}

fn ext(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or("")
}

fn streamed(name: &str) -> Music {
    let music = Music::decode(&fixture(name), ext(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(music.is_streamed());
    music
}

fn decoded(name: &str) -> Music {
    Music::from_sound(decode_sound(&fixture(name), ext(name)).unwrap_or_else(|e| panic!("{name}: {e}")))
}

fn rms(block: &[u32]) -> f64 {
    let sum: f64 = block.iter().map(|bits| f64::from(f32::from_bits(*bits)).powi(2)).sum();
    (sum / block.len() as f64).sqrt()
}

fn once(fade_s: f32) -> MusicOpts {
    MusicOpts { fade_s, looped: false, ..MusicOpts::default() }
}

fn looped(start_s: f32, end_s: f32) -> MusicOpts {
    MusicOpts { fade_s: 0.0, loop_start_s: start_s, loop_end_s: Some(end_s), ..MusicOpts::default() }
}

/// A streamed file renders what the same file decoded whole renders, sample for sample: at the
/// mixer's 48 kHz, through the 4-point resampler at 44.1 kHz, with a fade-in and from a start
/// offset, and to the end and past it (silence); MP3, FLAC and WAV too.
#[test]
fn a_streamed_file_renders_the_static_decode_bit_for_bit() {
    let rows: [(&str, MusicOpts, usize); 8] = [
        ("tone.mp3", once(0.0), 45),
        ("tone.flac", MusicOpts { start_s: 0.1, ..once(0.0) }, 45),
        ("tone.wav", once(0.2), 45),
        ("tone.ogg", once(0.0), 45),
        ("tone.ogg", MusicOpts::default(), 90),
        ("tone-44k.ogg", once(0.25), 150),
        ("music-10s.ogg", MusicOpts { start_s: 7.5, ..once(0.1) }, 200),
        ("music-10s.ogg", once(0.0), 120),
    ];
    for (name, opts, ticks) in rows {
        let from_stream = render(streamed(name), opts, ticks);
        let from_static = render(decoded(name), opts, ticks);
        assert!(from_static.iter().any(|block| rms(block) > 0.01), "{name}: the music is heard");
        assert_eq!(from_stream, from_static, "{name} {opts:?}: every sample");
    }
}

/// A 0.3 s loop repeats with no gap: every tick after the first carries the tone, the stream
/// equals the static loop (the reopen path for a loop near the start and for MP3, the seek path
/// for one 6 s in) and the track still plays at the end.
#[test]
fn a_short_loop_repeats_with_no_gap() {
    let rows = [
        ("tone.ogg", looped(0.1, 0.4)),
        ("music-10s.ogg", looped(6.0, 6.3)),
        ("tone-44k.ogg", looped(1.2, 1.45)),
        ("tone.mp3", looped(0.1, 0.4)),
        ("tone.flac", looped(0.1, 0.4)),
    ];
    for (name, opts) in rows {
        let ticks = 180;
        let from_stream = render(streamed(name), opts, ticks);
        let floor = from_stream.iter().skip(1).map(|block| rms(block)).fold(f64::INFINITY, f64::min);
        assert!(floor > 0.02, "{name}: no tick of the loop is silent (quietest tick rms {floor})");
        assert_eq!(from_stream, render(decoded(name), opts, ticks), "{name}: the loop seam is the static one");
    }
    let mut mixer = Mixer::deviceless().unwrap();
    let id = mixer.add_music(streamed("tone.ogg"));
    mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::B, music: id, opts: looped(0.1, 0.4) }]);
    for _ in 0..300 {
        mixer.tick();
    }
    assert!(mixer.music_playing(MusicTrack::B), "five seconds of a 0.5 s file and the loop still plays");
}

/// A track that plays once stops on the same tick as the static one, and a stop's fade-out ends
/// it on the same tick too.
#[test]
fn a_streamed_track_ends_and_stops_on_the_static_ticks() {
    let ended_at = |music: Music, stop_at: Option<usize>| {
        let mut mixer = Mixer::deviceless().unwrap();
        let id = mixer.add_music(music);
        let opts = MusicOpts { looped: stop_at.is_some(), ..once(0.0) };
        mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::A, music: id, opts }]);
        (0..400).find(|tick| {
            if Some(*tick) == stop_at {
                mixer.apply(&[MixerOp::MusicStop { track: MusicTrack::A, fade_s: 0.5 }]);
            }
            mixer.tick();
            !mixer.music_playing(MusicTrack::A)
        })
    };
    let once_static = ended_at(decoded("tone.ogg"), None);
    assert!(once_static.is_some_and(|tick| tick >= 29), "0.5 s is 30 ticks: {once_static:?}");
    assert_eq!(ended_at(streamed("tone.ogg"), None), once_static);
    let stopped_static = ended_at(decoded("tone.ogg"), Some(100));
    assert!(stopped_static.is_some_and(|tick| tick >= 130), "a 0.5 s fade from tick 100: {stopped_static:?}");
    assert_eq!(ended_at(streamed("tone.ogg"), Some(100)), stopped_static);
}

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

/// Counts the bytes each thread holds, so a test measures what playing music keeps resident.
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

/// A streamed track holds its file plus a fixed working set, not its decoded frames: the peak this
/// thread allocated while admitting the file and playing it for 10 s (a loop's wrap included)
/// stays within `resident_bytes()`, which is the file plus [`MUSIC_WORKING_BYTES`]. The
/// three-minute file, which a whole-file decode refuses, stays within the GE row's 4 MB; the 10 s
/// file decodes whole to 3.84 MB.
#[test]
fn a_streamed_track_holds_the_file_plus_a_fixed_working_set() {
    for name in ["silence-3min.ogg", "music-10s.ogg"] {
        let bytes: Arc<[u8]> = Arc::from(fixture(name));
        let mut mixer = Mixer::deviceless().unwrap();
        mixer.tick();
        let mut reported = 0;
        let held = peak_while(|| {
            let music = Music::stream(bytes.clone(), "ogg").unwrap();
            reported = music.resident_bytes();
            let id = mixer.add_music(music);
            assert_eq!(id, MusicId(0));
            mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::A, music: id, opts: MusicOpts::default() }]);
            for _ in 0..610 {
                mixer.tick();
            }
        });
        assert!(mixer.music_playing(MusicTrack::A), "{name}: still playing after 10 s");
        eprintln!("{name}: file {} bytes, peak held admitting and streaming {held} bytes, reported {reported}", bytes.len());
        assert_eq!(reported, bytes.len() + MUSIC_WORKING_BYTES);
        assert!(held <= MUSIC_WORKING_BYTES, "{name}: {held} bytes held beyond the file");
        assert!(bytes.len() + held <= THREE_MINUTE_TRACK_BUDGET_BYTES, "{name}: within the GE row");
    }
    let three_minutes = decode_sound(&fixture("silence-3min.ogg"), "ogg").map(|sound| sound.frames());
    assert_eq!(three_minutes.map_err(|e| e.code()), Err(AudioErrorCode::TooLarge), "decoded whole it is past the sound budget");
    assert_eq!(decoded("music-10s.ogg").resident_bytes(), 480_000 * 8, "decoded whole: 3.84 MB");
}

fn replay_digest() -> String {
    let blocks = render(streamed("music-10s.ogg"), looped(6.0, 6.3), 120);
    let blocks = blocks.into_iter().chain(render(streamed("tone-44k.ogg"), MusicOpts::default(), 60));
    let digest = blocks.flatten().fold(0xcbf2_9ce4_8422_2325_u64, |hash, bits| (hash ^ u64::from(bits)).wrapping_mul(0x0100_0000_01b3));
    format!("{digest:016x}")
}

/// Two processes stream the same music to the same samples.
#[test]
fn streamed_music_replays_identically_in_two_processes() {
    if std::env::var_os(REPLAY_CHILD_ENV).is_some() {
        println!("{REPLAY_LINE}{}", replay_digest());
        return;
    }
    let replay = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "streamed_music_replays_identically_in_two_processes", "--nocapture", "--test-threads=1"])
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
    assert_eq!(first, replay_digest(), "the child process agrees with this one");
}

/// The Ogg page checksum (CRC-32, polynomial 0x04c11db7, not reflected, no final xor).
fn ogg_crc(page: &[u8]) -> u32 {
    page.iter().fold(0u32, |crc, byte| {
        (0..8).fold(crc ^ (u32::from(*byte) << 24), |crc, _| if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04c1_1db7 } else { crc << 1 })
    })
}

/// `ogg` with its last page's granule position set to `granule`, the checksum recomputed.
fn with_last_granule(ogg: &[u8], granule: u64) -> Vec<u8> {
    let start = ogg.windows(4).rposition(|w| w == b"OggS").expect("an Ogg page");
    let segments = usize::from(ogg[start + 26]);
    let body: usize = ogg[start + 27..start + 27 + segments].iter().map(|s| usize::from(*s)).sum();
    let end = start + 27 + segments + body;
    let mut out = ogg.to_vec();
    out[start + 6..start + 14].copy_from_slice(&granule.to_le_bytes());
    out[start + 22..start + 26].fill(0);
    let crc = ogg_crc(&out[start..end]);
    out[start + 22..start + 26].copy_from_slice(&crc.to_le_bytes());
    out
}

/// The hostile table: a file that cannot stream is refused typed when admitted, never a panic.
#[test]
fn hostile_music_is_refused_when_admitted_and_never_panics() {
    let ogg = fixture("tone.ogg");
    let rows: [(&str, Vec<u8>, &str, AudioErrorCode); 7] = [
        ("truncated inside the first audio page", ogg[..ogg.len() / 3].to_vec(), "ogg", AudioErrorCode::Malformed),
        ("zero bytes", Vec::new(), "ogg", AudioErrorCode::Malformed),
        ("a model named .ogg", fixture("lods-sphere.glb"), "ogg", AudioErrorCode::Malformed),
        ("a header claiming 2^40 frames", with_last_granule(&ogg, 1 << 40), "ogg", AudioErrorCode::Malformed),
        ("an Opus stream named .ogg", fixture("tone.opus"), "ogg", AudioErrorCode::NeedsImport),
        ("an Opus file", fixture("tone.opus"), "opus", AudioErrorCode::NeedsImport),
        ("a tracker module", b"anything".to_vec(), "xm", AudioErrorCode::UnsupportedFormat),
    ];
    for (row, bytes, ext, code) in rows {
        let admitted = std::panic::catch_unwind(|| Music::stream(Arc::from(bytes), ext).map(|music| music.resident_bytes()));
        let admitted = admitted.unwrap_or_else(|_| panic!("{row}: panicked"));
        assert_eq!(admitted.map_err(|error| error.code()), Err(code), "{row}");
    }
}

/// A file cut short after it was admitted plays what it has and ends: no panic, no stuck track.
#[test]
fn a_file_cut_short_inside_its_last_page_plays_what_it_has_and_ends() {
    let ogg = fixture("music-10s.ogg");
    let cut: Arc<[u8]> = Arc::from(&ogg[..ogg.len() - 200]);
    let music = std::panic::catch_unwind(|| Music::stream(cut, "ogg")).expect("no panic");
    let music = music.expect("the first packets are whole, so it is admitted");
    let mut mixer = Mixer::deviceless().unwrap();
    let id = mixer.add_music(music);
    mixer.apply(&[MixerOp::MusicStart { track: MusicTrack::A, music: id, opts: once(0.0) }]);
    let ended = (0..800).find(|_| {
        mixer.tick();
        !mixer.music_playing(MusicTrack::A)
    });
    assert!(ended.is_some_and(|tick| tick > 500), "about 10 s played, then the track ended: {ended:?}");
}
