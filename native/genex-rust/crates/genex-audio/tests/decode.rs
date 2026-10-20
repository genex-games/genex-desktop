//! Decoding with symphonia (kira's own copy): WAV, OGG Vorbis, MP3 and FLAC load; Opus and AAC
//! are the import step's to convert (`needs-import`); raylib's QOA, XM and MOD are refused. A
//! decoded file played on the device-less mixer gives the `audioLevel` the fixture holds, with no
//! audio device, twice over. Hostile bytes (a truncated page, no bytes, another file's bytes, a
//! header claiming 2^40 frames, an Opus stream named `.ogg`, a small file that decodes past the
//! sound budget) are typed refusals, never a panic.

use genex_audio::{AudioErrorCode, MAX_DECODED_FRAMES, Mixer, decode_sound};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name)
}

/// Ticks covering more than one 2048-frame window of the 0.5 s tone.
const TICKS: u32 = 10;

/// `audioLevel` of `tone.wav` after [`TICKS`] ticks, as the verb reports it (rms to four
/// decimals, the centroid in whole hertz), recorded from the device-less mixer. The theory it
/// must agree with: a 440 Hz sine at FFmpeg's default amplitude of 1/8 has rms 0.125/√2 ≈ 0.0884,
/// and a Hann-windowed 2048-frame centroid lands within a few 23.4 Hz bins of the tone.
const TONE_WAV_LEVEL: (f64, f64) = (0.0886, 459.0);
const TONE_HZ: f64 = 440.0;
const TONE_RMS: f64 = 0.125 / std::f64::consts::SQRT_2;
/// Three FFT bins at 48 kHz over 2048 frames.
const CENTROID_SLACK_HZ: f64 = 3.0 * 48_000.0 / 2048.0;

fn level_of(name: &str) -> (f64, f64) {
    let bytes = fs::read(fixture(name)).unwrap();
    let sound = decode_sound(&bytes, name.rsplit('.').next().unwrap_or("")).unwrap_or_else(|e| panic!("{name}: {e}"));
    let mut mixer = Mixer::deviceless().expect("no device needed");
    mixer.play(&sound).expect("play");
    for _ in 0..TICKS {
        mixer.tick();
    }
    let level = mixer.level().reported();
    (level.rms, level.centroid)
}

#[test]
fn wav_ogg_mp3_and_flac_decode() {
    for name in ["tone.wav", "tone.ogg", "tone.mp3", "tone.flac"] {
        let bytes = fs::read(fixture(name)).unwrap();
        let sound = decode_sound(&bytes, name.rsplit('.').next().unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(sound.frames() > 20_000, "{name}: half a second at 48 kHz, {} frames", sound.frames());
    }
}

#[test]
fn audio_level_of_a_decoded_file_is_the_fixture_value_with_no_device() {
    let (rms, centroid) = TONE_WAV_LEVEL;
    assert!((rms - TONE_RMS).abs() < 0.001 && (centroid - TONE_HZ).abs() < CENTROID_SLACK_HZ, "the golden is a tone");
    assert_eq!(level_of("tone.wav"), TONE_WAV_LEVEL);
    assert_eq!(level_of("tone.wav"), level_of("tone.wav"), "the same bits on a second run");
    for name in ["tone.ogg", "tone.mp3", "tone.flac"] {
        let (rms, centroid) = level_of(name);
        assert!((rms - TONE_WAV_LEVEL.0).abs() < 0.005, "{name}: rms {rms}");
        assert!((centroid - TONE_WAV_LEVEL.1).abs() < 30.0, "{name}: centroid {centroid}");
    }
}

#[test]
fn formats_the_runtime_does_not_decode_are_refused_typed() {
    let opus = fs::read(fixture("tone.opus")).unwrap();
    assert_eq!(decode_sound(&opus, "opus").unwrap_err().code(), AudioErrorCode::NeedsImport);
    for ext in ["m4a", "aac"] {
        assert_eq!(decode_sound(&opus, ext).unwrap_err().code(), AudioErrorCode::NeedsImport, "{ext}");
    }
    for ext in ["qoa", "xm", "mod"] {
        assert_eq!(decode_sound(b"anything", ext).unwrap_err().code(), AudioErrorCode::UnsupportedFormat, "{ext}");
    }
    assert_eq!(decode_sound(b"not audio at all", "ogg").unwrap_err().code(), AudioErrorCode::Malformed);
}

fn crate_fixture(name: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}

/// The Ogg page checksum (CRC-32, polynomial 0x04c11db7, not reflected, no final xor).
fn ogg_crc(page: &[u8]) -> u32 {
    page.iter().fold(0u32, |crc, byte| {
        (0..8).fold(crc ^ (u32::from(*byte) << 24), |crc, _| if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04c1_1db7 } else { crc << 1 })
    })
}

/// `ogg` with its last page's granule position (the track length a reader trusts) set to
/// `granule`, the page checksum recomputed so the page is still read.
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

/// The hostile table: every row is refused with its code and nothing panics.
#[test]
fn hostile_bytes_are_typed_refusals_and_never_panic() {
    let ogg = fs::read(fixture("tone.ogg")).unwrap();
    assert_eq!(with_last_granule(&ogg, 24_000), ogg, "rewriting the true granule changes nothing: the checksum is right");
    let rows: [(&str, Vec<u8>, &str, AudioErrorCode); 7] = [
        ("truncated inside the first audio page", ogg[..ogg.len() / 3].to_vec(), "ogg", AudioErrorCode::Malformed),
        ("truncated inside the last page", ogg[..ogg.len() - 40].to_vec(), "ogg", AudioErrorCode::Malformed),
        ("zero bytes", Vec::new(), "ogg", AudioErrorCode::Malformed),
        ("a model named .ogg", fs::read(fixture("lods-sphere.glb")).unwrap(), "ogg", AudioErrorCode::Malformed),
        ("a header claiming 2^40 frames", with_last_granule(&ogg, 1 << 40), "ogg", AudioErrorCode::Malformed),
        ("an Opus stream named .ogg", fs::read(fixture("tone.opus")).unwrap(), "ogg", AudioErrorCode::NeedsImport),
        ("three minutes that decode past the sound budget", crate_fixture("silence-3min.ogg"), "ogg", AudioErrorCode::TooLarge),
    ];
    for (row, bytes, ext, code) in rows {
        let refused = std::panic::catch_unwind(|| decode_sound(&bytes, ext).map(|sound| sound.frames()));
        let refused = refused.unwrap_or_else(|_| panic!("{row}: panicked"));
        assert_eq!(refused.map_err(|error| error.code()), Err(code), "{row}");
    }
    const { assert!(MAX_DECODED_FRAMES < 180 * 48_000, "three minutes at 48 kHz is past the budget") };
}
