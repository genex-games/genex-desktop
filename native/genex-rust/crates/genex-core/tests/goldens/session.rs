//! `session.h`: the state machine over the clock, the merge and the rng; `state()`'s snapshot and
//! checksum; the frame timings and the audio level.

use crate::input::{injection_from, sample_of, tick_of};
use crate::support::{bits, golden, real, same, string_list, strings, text_str, u64_of};
use crate::toy::Toy;
use genex_core::clock::FIXED_STEP_MS;
use genex_core::json::{self, Value};
use genex_core::rng::Pcg32;
use genex_core::session::{AudioMeter, FrameTiming, Session, StateExtras, checksum, snapshot};

fn step_result(session: &mut Session, toy: &mut Toy, step: &Value, keys: &[String]) -> Value {
    if let Some(seed) = step.get("seed") {
        return Value::from(session.seed(u64_of(seed) as u32, toy));
    }
    if step.get("start").is_some() {
        return Value::from(session.start());
    }
    if step.get("pause").is_some() {
        return Value::from(session.pause());
    }
    if let Some(ms) = step.get("step") {
        let stepped = session.step(real(ms), toy);
        let mut result = Value::object();
        result.set("ticks", Value::from(stepped.ticks));
        result.set("frame", Value::from(stepped.frame as f64));
        result.set("simulatedMs", bits(stepped.simulated_ms));
        return result;
    }
    if let Some(ms) = step.get("frame") {
        return Value::from(session.frame(real(ms), toy));
    }
    if step.get("inject").is_some() {
        return strings(&session.inject(&injection_from(step)));
    }
    if let Some(frame) = step.get("sample") {
        session.sample(&sample_of(frame));
        return Value::Null;
    }
    if step.get("takeRender").is_some() {
        return Value::from(session.take_render());
    }
    if step.get("requestRender").is_some() {
        session.request_render();
        return Value::Null;
    }
    let spec = &step["snapshot"];
    let extras = StateExtras {
        fps: spec.get("fps").map_or(0.0, real),
        camera: spec.get("camera").map_or_else(|| "default".to_owned(), |camera| camera.as_str().to_owned()),
        probes: toy.probes(),
        hud: spec["hud"].clone(),
        render: spec["render"].clone(),
        assets: spec["assets"].clone(),
        error: spec["error"].as_str().to_owned(),
        player: spec["player"].clone(),
    };
    let mut result = Value::object();
    result.set("state", Value::String(snapshot(session, &extras).dump()));
    result.set("checksum", Value::from(checksum(session.seed_value(), session.tick(), &extras.probes)));
    result.set("last", tick_of(session.last(), keys));
    result
}

#[test]
fn recorded_sessions_reach_the_same_state_and_checksum() {
    let cases = golden!("session");
    for scene in cases["sessions"].items() {
        let step_ms = scene.get("stepMs").map_or(FIXED_STEP_MS, real);
        let mut session = Session::new(step_ms);
        let mut toy = Toy::new();
        let keys = string_list(&scene["keys"]);
        for (i, (step, want)) in scene["steps"].items().iter().zip(scene["results"].items()).enumerate() {
            let got = step_result(&mut session, &mut toy, step, &keys);
            same(&got, want, &format!("session {:?} step {i}: {step:?}", scene["name"]));
        }
    }
}

#[test]
fn checksums_cover_the_same_leaves() {
    let cases = golden!("session");
    for case in cases["checksums"].items() {
        let probes = json::parse(text_str(&case["probes"]).as_bytes()).expect("probes parse");
        let got = checksum(u64_of(&case["seed"]) as u32, case["tick"].as_f64() as u64, &probes);
        same(&Value::from(got), &case["checksum"], &format!("checksum {:?}", case["probes"]));
    }
}

#[test]
fn frame_timings_average_the_same() {
    let cases = golden!("session");
    for case in cases["timings"].items() {
        let mut timing = FrameTiming::default();
        for frame in case["frames"].items() {
            let parts = frame.items();
            timing.record(real(&parts[0]), real(&parts[1]), real(&parts[2]));
        }
        if let Some(generated) = case.get("generated") {
            let mut rng = Pcg32::seeded(u64_of(&generated["seed"]));
            for _ in 0..generated["count"].as_f64() as usize {
                let frame_ms = f64::from(rng.below(50_000)) / 1000.0;
                let update_ms = f64::from(rng.below(8_000)) / 1000.0;
                let draw_ms = f64::from(rng.below(12_000)) / 1000.0;
                timing.record(frame_ms, update_ms, draw_ms);
            }
        }
        let got = timing.timings();
        same(&bits(got.frame_ms), &case["frameMs"], "frame ms");
        same(&bits(got.update_ms), &case["updateMs"], "update ms");
        same(&bits(got.draw_ms), &case["drawMs"], "draw ms");
        same(&Value::from(got.frames as f64), &case["count"], "frames counted");
    }
}

/// The centroid goes through the platform's cos, sin and hypot, as the C++ does: bit-equal where
/// the goldens were taken (macOS), within rounding elsewhere. The level is a volatile reading.
const CENTROID_TOLERANCE: f64 = 1e-9;

#[test]
fn the_audio_level_reads_the_same_window() {
    let cases = golden!("session");
    for case in cases["audio"].items() {
        let meter = AudioMeter::default();
        let mut rng = Pcg32::seeded(u64_of(&case["seed"]));
        let amplitude = real(&case["amplitude"]) as f32;
        for (feed, want) in case["feeds"].items().iter().zip(case["levels"].items()) {
            let frames = feed.as_f64() as usize;
            let mut samples: Vec<f32> = (0..frames * 2).map(|_| rng.range_f32(-amplitude, amplitude)).collect();
            if case["poison"].as_bool() && !samples.is_empty() {
                let last = samples.len() - 1;
                samples[0] = f32::NAN;
                samples[last] = 7.0;
            }
            meter.feed(&samples);
            let level = meter.level(real(&case["rate"]));
            same(&bits(level.rms), &want["rms"], &format!("rms after {frames} frames"));
            let centroid = real(&want["centroid"]);
            if cfg!(target_os = "macos") {
                same(&bits(level.centroid), &want["centroid"], &format!("centroid after {frames} frames"));
            }
            let scale = centroid.abs().max(1.0);
            assert!((level.centroid - centroid).abs() <= CENTROID_TOLERANCE * scale, "centroid after {frames} frames");
        }
    }
}
