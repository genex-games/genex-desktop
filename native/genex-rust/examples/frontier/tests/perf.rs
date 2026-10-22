//! EP-X1: the frontier's 120 s ride drawn Live on the host GPU, one tick per frame: desktop-high in
//! a 2560x1440 window and the mobile-mid proxy at its reference resolution. Per class: no frame
//! (tick, draw and GPU completion) over the class's frame interval (D7: 16.7 ms on desktop-high) and
//! zero stalls (`volatile.__stream.stalls`). The record goes to `GENEX_FRONTIER_PERF_OUT` (default
//! `.studio-dev/evidence/rust-renderer/perf/frontier-ride.json`). Timings are the gate's on a quiet
//! machine (GE); a lane's run is advisory.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p frontier \
//!     --release --offline --test perf -- --ignored metal --nocapture
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

use std::path::PathBuf;
use std::time::Instant;

use frontier_game::{RIDE_TICKS, WORLD_SIZE, assets, game};
use genex::present::Presenter;
use genex::render::{DeviceClass, FormFactor, RenderChange};
use genex::{FIXED_STEP_MS, Value, View, json};
use genex_render::presets::{class_defaults, reference_resolution};

/// Frames drawn at tick 0 before the measured ride: the pipelines compile, the impostors bake and
/// the first view set loads (a game's boot, not its play).
const WARM_FRAMES: u32 = 60;
/// The desktop row's window: 1440p.
const DESKTOP_WINDOW: (u32, u32) = (2560, 1440);
/// The classes the ride is drawn at.
const CLASSES: [&str; 2] = ["desktop-high", "mobile-mid"];
/// The slowest frames the record lists.
const SLOWEST: usize = 12;

fn percentile(values: &[f64], share: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = ((sorted.len() as f64 - 1.0) * share).round() as usize;
    sorted.get(at).copied().unwrap_or(0.0)
}

fn rounded(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// The ride drawn Live at `class` in `window`: its row and what is over a budget.
fn ride(class: DeviceClass, window: (u32, u32)) -> (Value, Vec<String>) {
    let wire = class.wire();
    let mut presenter = Presenter::open(WORLD_SIZE, assets()).expect("a WebGPU-core adapter");
    presenter.set_window_size(window);
    let mut runtime = genex::Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let settings = presenter.render_settings().expect("the game's settings attached");
    settings.borrow_mut().apply(&RenderChange { device_class: Some(Some(class)), ..RenderChange::default() });
    for _ in 0..WARM_FRAMES {
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
    }
    let budget_ms = 1000.0 / f64::from(class_defaults(class).target_fps);
    let (mut frames, mut steps, mut draws, mut waits) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..RIDE_TICKS {
        let start = Instant::now();
        runtime.step(FIXED_STEP_MS);
        let stepped = start.elapsed().as_secs_f64() * 1000.0;
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        let drawn = start.elapsed().as_secs_f64() * 1000.0;
        presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        let finished = start.elapsed().as_secs_f64() * 1000.0;
        steps.push(stepped);
        draws.push(drawn - stepped);
        waits.push(finished - drawn);
        frames.push(finished);
    }
    assert_eq!(presenter.failure(), None);
    let state = runtime.state();
    let stream = &state["volatile"]["__stream"];
    let stalls = stream["stalls"].as_u64().expect("the stall count");
    let over = frames.iter().filter(|ms| **ms > budget_ms).count();
    let max = frames.iter().copied().fold(0.0, f64::max);
    let mut order: Vec<usize> = (0..frames.len()).collect();
    order.sort_by(|a, b| frames[*b].total_cmp(&frames[*a]));
    let slowest: Vec<Value> = order.iter().take(SLOWEST).map(|i| json!({ "tick": i + 1, "stepMs": rounded(steps[*i]), "drawMs": rounded(draws[*i]), "gpuWaitMs": rounded(waits[*i]), "frameMs": rounded(frames[*i]) })).collect();
    let mut failures = Vec::new();
    if over > 0 {
        failures.push(format!("{wire}: {over} frames over {budget_ms:.1} ms (max {max:.2} ms)"));
    }
    if stalls > 0 {
        failures.push(format!("{wire}: {stalls} stalls"));
    }
    let summary = |values: &[f64]| json!({ "p50": rounded(percentile(values, 0.5)), "p95": rounded(percentile(values, 0.95)), "p99": rounded(percentile(values, 0.99)), "max": rounded(percentile(values, 1.0)) });
    let row = json!({
        "class": wire,
        "window": [window.0, window.1],
        "frames": frames.len(),
        "frameBudgetMs": rounded(budget_ms),
        "frameMs": summary(&frames),
        "framesOverBudget": over,
        "stalls": stalls,
        "heldMs": stream["heldMs"],
        "stepMs": summary(&steps),
        "drawMs": summary(&draws),
        "gpuWaitMs": summary(&waits),
        "lod": state["volatile"]["render"]["lod"],
        "slowest": slowest,
    });
    (row, failures)
}

fn out_path() -> PathBuf {
    let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/perf/frontier-ride.json");
    let path = std::env::var_os("GENEX_FRONTIER_PERF_OUT").map_or(default, PathBuf::from);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("the record's folder");
    }
    path
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_ride_fits_each_class_frame_budget_with_zero_stalls() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    if let Err(error) = Presenter::open(WORLD_SIZE, assets()) {
        assert!(!require, "GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}");
        return eprintln!("skipped: no WebGPU-core adapter ({error})");
    }
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for wire in CLASSES {
        let class = DeviceClass::from_wire(wire).expect("a class");
        let window = if class.form == FormFactor::Desktop { DESKTOP_WINDOW } else { reference_resolution(class) };
        let (row, over) = ride(class, window);
        println!("{row}");
        rows.push(row);
        failures.extend(over);
    }
    let record = json!({
        "harness": "frontier-ride",
        "seconds": RIDE_TICKS as f64 * FIXED_STEP_MS / 1000.0,
        "method": "Live frames through Presenter::draw_view, one tick per frame; frame = tick + draw + GPU completion (device poll)",
        "rows": rows,
        "passed": failures.is_empty(),
        "failures": failures,
    });
    std::fs::write(out_path(), format!("{record:#}\n")).expect("the record writes");
    assert!(failures.is_empty(), "the ride is over a budget: {failures:?}");
}
