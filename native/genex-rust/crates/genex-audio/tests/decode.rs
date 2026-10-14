//! Decoding with symphonia (kira's own copy): WAV, OGG Vorbis, MP3 and FLAC load; Opus and AAC
//! are the import step's to convert (`needs-import`); raylib's QOA, XM and MOD are refused. A
//! decoded file played on the device-less mixer gives the `audioLevel` the fixture holds, with no
//! audio device, twice over.

use genex_audio::{AudioErrorCode, Mixer, decode_sound};
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
