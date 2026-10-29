//! R-30 (AU-12, owner call G13): the mixer's meter (libm, the same bits on every target) against
//! the C++ runtime's `AudioMeter` goldens (`session.golden.json`, recorded on macOS with the
//! platform's `cos`, `sin` and `hypot`). Every rms is bit-equal, and so is every centroid but the
//! rows of the one named, owner-approved exception [`AU12_CENTROID_LIBM_1ULP`]: there libm's
//! twiddles move the centroid by exactly one ulp. That exception is the only tolerance.

use genex_audio::AudioMeter;
use genex_core::rng::Pcg32;
use serde_json::Value;

/// The C++ runtime's session goldens: the `audio` cases feed seeded noise and pin the level.
const SESSION_GOLDEN: &str = include_str!("../../../../../tests/fixtures/genex-core-goldens/session.golden.json");

/// The named exception `AU-12-centroid-libm-1ulp`: (seed, frames fed) of each golden row whose
/// centroid the libm meter reads exactly one ulp from the C++ bits. Owner-approved (G13); a
/// larger difference, a one-ulp row not listed, or a listed row that stops differing fails the row.
const AU12_CENTROID_LIBM_1ULP: &[(u64, usize)] = &[(1, 1000), (1, 2048), (1, 3000), (2, 512), (2, 4096)];

/// A golden double: its hex bits.
fn bits_of(value: &Value) -> u64 {
    let text = value.as_str().expect("hex bits");
    u64::from_str_radix(text.trim_start_matches("0x"), 16).expect("hex u64")
}

/// A golden number written as a number.
fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

/// How many doubles lie between `a` and `b` (both finite and of one sign here).
fn ulps_apart(a: u64, b: u64) -> u64 {
    a.abs_diff(b)
}

#[test]
fn the_mixer_meter_reads_the_cpp_goldens_with_one_named_exception() {
    let golden: Value = serde_json::from_str(SESSION_GOLDEN).expect("the session golden parses");
    let cases = golden["cases"]["audio"].as_array().expect("audio cases");
    let mut rows = 0;
    let mut one_ulp = Vec::new();
    for case in cases {
        let seed = case["seed"].as_u64().expect("a seed");
        let mut rng = Pcg32::seeded(seed);
        let amplitude = number(&case["amplitude"]) as f32;
        let rate = number(&case["rate"]);
        let mut meter = AudioMeter::default();
        let feeds = case["feeds"].as_array().expect("feeds");
        let levels = case["levels"].as_array().expect("levels");
        for (feed, want) in feeds.iter().zip(levels) {
            let frames = feed.as_u64().expect("frames") as usize;
            // The C++ golden's input, made as genex-core's golden row makes it.
            let mut samples: Vec<f32> = (0..frames * 2).map(|_| rng.range_f32(-amplitude, amplitude)).collect();
            if case["poison"].as_bool() == Some(true) && !samples.is_empty() {
                let last = samples.len() - 1;
                samples[0] = f32::NAN;
                samples[last] = 7.0;
            }
            meter.feed(&samples);
            let level = meter.level(rate);
            let row = format!("seed {seed} after {frames} frames");
            assert_eq!(format!("{:016x}", level.rms.to_bits()), format!("{:016x}", bits_of(&want["rms"])), "rms, {row}");
            let apart = ulps_apart(level.centroid.to_bits(), bits_of(&want["centroid"]));
            assert!(apart <= 1, "centroid {:#018x} against the C++ {:#018x}, {row}", level.centroid.to_bits(), bits_of(&want["centroid"]));
            if apart == 1 {
                one_ulp.push((seed, frames));
            }
            rows += 1;
        }
    }
    assert_eq!(rows, 8, "every audio golden row is read");
    assert_eq!(one_ulp, AU12_CENTROID_LIBM_1ULP, "the rows one ulp off are exactly the named exception's; every other centroid is bit-equal");
}
