//! The device-less mixer: `audioLevel` (rms and spectral centroid over the last 2048 frames at a
//! fixed mixer rate) is a pure function of what the game played and the ticks run, with no audio
//! device, in one process or across two.

use genex_audio::{
    AUDIO_WINDOW_FRAMES, AudioLevel, AudioMeter, FRAMES_PER_TICK, MIXER_RATE_HZ, Mixer, SinkQueue, Sound,
};
use std::process::Command;

const TONE_HZ: f64 = 1000.0;
/// Ticks that cover more than one 2048-frame window (800 frames a tick).
const TICKS: u32 = 6;
const REPLAY_CHILD_ENV: &str = "GENEX_AUDIO_REPLAY_CHILD";
const REPLAY_LINE: &str = "genex-audio-replay ";

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

fn run_session() -> AudioLevel {
    let mut mixer = Mixer::deviceless().expect("a device-less mixer needs no device");
    mixer.play(&sine(TONE_HZ, 1.0, 0.5)).expect("play");
    for _ in 0..TICKS {
        mixer.tick();
    }
    mixer.level()
}

fn bits(level: AudioLevel) -> (u64, u64) {
    (level.rms.to_bits(), level.centroid.to_bits())
}

#[test]
fn a_tick_renders_the_mixer_rate_over_sixty() {
    assert_eq!(FRAMES_PER_TICK * 60, MIXER_RATE_HZ as usize);
    let mut mixer = Mixer::deviceless().unwrap();
    assert_eq!(mixer.tick().len(), FRAMES_PER_TICK * 2, "interleaved stereo");
}

#[test]
fn audio_level_over_2048_frames_is_identical_with_no_device() {
    let first = run_session();
    let second = run_session();
    assert_eq!(bits(first), bits(second));
    assert!(first.rms > 0.05, "the tone is heard: {first:?}");
    let bin = f64::from(MIXER_RATE_HZ) / AUDIO_WINDOW_FRAMES as f64;
    assert!((first.centroid - TONE_HZ).abs() < 3.0 * bin, "centroid near the tone: {first:?}");
}

#[test]
fn a_mixer_that_played_nothing_reads_silence() {
    let mut mixer = Mixer::deviceless().unwrap();
    for _ in 0..TICKS {
        mixer.tick();
    }
    assert_eq!(mixer.level(), AudioLevel { rms: 0.0, centroid: 0.0 });
}

#[test]
fn muting_silences_the_device_block_but_not_the_level() {
    let mut loud = Mixer::deviceless().unwrap();
    let mut muted = Mixer::deviceless().unwrap();
    muted.set_muted(true);
    let tone = sine(TONE_HZ, 1.0, 0.5);
    loud.play(&tone).unwrap();
    muted.play(&tone).unwrap();
    for _ in 0..TICKS {
        loud.tick();
        assert!(muted.tick().iter().all(|s| *s == 0.0), "a muted run sends silence to the device");
    }
    assert_eq!(bits(loud.level()), bits(muted.level()), "the meter reads the mix before the mute");
}

#[test]
fn the_reported_level_rounds_like_the_cpp_runtime() {
    let level = AudioLevel { rms: 0.123_456, centroid: 1000.6 };
    assert_eq!(level.reported(), AudioLevel { rms: 0.1235, centroid: 1001.0 });
}

#[test]
fn a_full_scale_square_wave_reads_rms_one() {
    let mut meter = AudioMeter::default();
    let block = (0..AUDIO_WINDOW_FRAMES).flat_map(|i| if (i / 24) % 2 == 0 { [1.0, 1.0] } else { [-1.0, -1.0] });
    meter.feed(&block.collect::<Vec<f32>>());
    let level = meter.level(f64::from(MIXER_RATE_HZ));
    assert!((level.rms - 1.0).abs() < 1e-12, "{level:?}");
}

#[test]
fn the_meter_keeps_only_the_last_window() {
    let mut meter = AudioMeter::default();
    meter.feed(&vec![1.0; AUDIO_WINDOW_FRAMES * 2]);
    meter.feed(&vec![0.0; AUDIO_WINDOW_FRAMES * 2]);
    assert_eq!(meter.level(f64::from(MIXER_RATE_HZ)), AudioLevel { rms: 0.0, centroid: 0.0 });
}

/// Hostile samples: what a broken effect could put in the mix.
#[test]
fn non_finite_and_over_range_samples_never_break_the_level() {
    let rows: [(f32, f64); 5] = [(f32::NAN, 0.0), (f32::INFINITY, 0.0), (f32::NEG_INFINITY, 0.0), (4.0, 1.0), (-4.0, 1.0)];
    for (sample, rms) in rows {
        let mut meter = AudioMeter::default();
        meter.feed(&vec![sample; 64]);
        let level = meter.level(f64::from(MIXER_RATE_HZ));
        assert!(level.rms.is_finite() && level.centroid.is_finite(), "{sample}: {level:?}");
        assert!((level.rms - rms).abs() < 1e-12, "{sample}: {level:?}");
    }
}

#[test]
fn an_odd_sample_count_drops_the_half_frame() {
    let mut meter = AudioMeter::default();
    meter.feed(&[0.5, 0.5, 0.5]);
    let level = meter.level(f64::from(MIXER_RATE_HZ));
    assert!((level.rms - 0.5).abs() < 1e-12, "{level:?}");
}

#[test]
fn the_device_queue_plays_silence_on_underrun_and_drops_the_oldest_on_overrun() {
    let queue = SinkQueue::with_capacity(4);
    let mut out = [9.0_f32; 3];
    queue.drain_into(&mut out);
    assert_eq!(out, [0.0; 3], "underrun is silence");
    queue.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    let mut out = [0.0_f32; 5];
    queue.drain_into(&mut out);
    assert_eq!(out, [3.0, 4.0, 5.0, 6.0, 0.0], "the newest samples win");
}

/// Two process replays give the same level, bit for bit.
#[test]
fn two_process_replays_give_identical_levels() {
    if std::env::var_os(REPLAY_CHILD_ENV).is_some() {
        let (rms, centroid) = bits(run_session());
        println!("{REPLAY_LINE}{rms:016x} {centroid:016x}");
        return;
    }
    let replay = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "two_process_replays_give_identical_levels", "--nocapture", "--test-threads=1"])
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
    let (rms, centroid) = bits(run_session());
    assert_eq!(first, format!("{rms:016x} {centroid:016x}"), "the child process agrees with this one");
}
