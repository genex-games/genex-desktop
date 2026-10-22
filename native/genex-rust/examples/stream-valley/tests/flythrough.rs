//! STR-26b: the stream-valley fly-through and its budget rows.
//!
//! - The budget table (`tests/fixtures/render-perf/budgets.json`) holds the per-frame streaming
//!   budgets the view set runs on: `stream-finish-<class>` (main-thread milliseconds of decoding and
//!   uploading) and `stream-upload-<class>` (read bytes uploaded), and `stream-upload-web` (a
//!   browser's cap). The row fails when the table and `genex_render::presets::stream_budget`
//!   disagree, so a budget changes in one place the rows read.
//! - In release, `--ignored replay`: the whole fly-through (30 m/s along the ring road for 120 s,
//!   7,200 ticks) replays equal checksums every 60 ticks on one and on eight stream threads.
//! - On the host GPU, `--ignored metal`: the fly-through drawn Live, one tick per frame, at
//!   desktop-high in a 2560x1440 window and on the mobile-high and mobile-mid proxies at their
//!   reference resolutions. Per class: no frame (tick, draw and GPU completion) over the class's
//!   frame interval (D7: 16.7 ms on desktop-high), zero stalls (`volatile.__stream.stalls`), the
//!   view set's p99 finish within the class's `stream-finish` budget, and resident content within
//!   the class's pool at every frame; the last two fail when the view set finished no model
//!   (nothing streamed, nothing measured). The record is written to `GENEX_FLY_OUT` (default
//!   `.studio-dev/evidence/rust-renderer/perf/stream-flythrough.json`). Timings are the gate's on a
//!   quiet machine (GE); a lane's run is advisory. A debug build skips the row.
//!
//! ```text
//! node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley --offline --test flythrough
//! node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley --release --offline \
//!   --test flythrough -- --ignored replay --nocapture
//! GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley \
//!   --release --offline --test flythrough -- --ignored metal --nocapture
//! ```
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use genex::present::{Presenter, ViewLimits};
use genex::render::{DeviceClass, RenderChange, TargetOs};
use genex::{FIXED_STEP_MS, Runtime, Value, View, json};
use genex_render::jobs::Pool;
use genex_render::presets::{class_defaults, reference_resolution, stream_budget};
use stream_valley_game::valley::ANCHOR_SPEED;
use stream_valley_game::{WORLD_SIZE, assets, game};

/// The fly-through's length, in seconds (at [`ANCHOR_SPEED`]: 3.6 km of road).
const FLY_SECONDS: f64 = 120.0;
/// Ticks between the replay's checksums.
const EVERY: u64 = 60;
/// Frames drawn at tick 0 before the measured fly-through: the pipelines compile and the first
/// view set loads (a game's boot, not its play).
const WARM_FRAMES: u32 = 60;
/// The desktop row's window: 1440p.
const DESKTOP_WINDOW: (u32, u32) = (2560, 1440);
/// The classes the fly-through is drawn at.
const FLY_CLASSES: [&str; 3] = ["desktop-high", "mobile-high", "mobile-mid"];
/// The slowest frames the record lists.
const SLOWEST: usize = 12;
/// Bytes in a MiB, for the record.
const MIB: f64 = 1024.0 * 1024.0;

fn fly_ticks() -> u64 {
    (FLY_SECONDS * 1000.0 / FIXED_STEP_MS).round() as u64
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn budgets() -> Value {
    let text = std::fs::read_to_string(repo().join("tests/fixtures/render-perf/budgets.json")).expect("the budget table reads");
    text.parse().expect("the budget table is JSON")
}

/// The entry `id` of the budget table, or why the row fails.
fn entry<'a>(table: &'a Value, id: &str) -> &'a Value {
    let entries = table["entries"].as_array().expect("entries");
    entries.iter().find(|entry| entry["id"] == id).unwrap_or_else(|| panic!("budgets.json has no `{id}` entry"))
}

/// The class's `stream-finish` budget from the table, in milliseconds.
fn finish_budget_ms(table: &Value, class: &str) -> f64 {
    entry(table, &format!("stream-finish-{class}"))["budgetMs"].as_f64().expect("budgetMs")
}

#[test]
fn the_budget_table_holds_the_stream_budgets_the_view_set_runs_on() {
    let table = budgets();
    let web_cap = entry(&table, "stream-upload-web")["budgetBytes"].as_u64().expect("budgetBytes");
    for class in DeviceClass::ALL {
        let wire = class.wire();
        let native = stream_budget(class, TargetOs::current());
        let finish = entry(&table, &format!("stream-finish-{wire}"));
        let upload = entry(&table, &format!("stream-upload-{wire}"));
        // No profile row draws these features, so they never charge a renderer feature's cost.
        assert_eq!(finish["features"], json!(["stream-finish"]), "{wire}");
        assert_eq!(upload["features"], json!(["stream-upload"]), "{wire}");
        assert_eq!(finish["budgetMs"].as_f64(), Some(native.finish_ms), "{wire}: the finish budget");
        assert_eq!(upload["budgetBytes"].as_u64(), Some(native.upload_bytes), "{wire}: the upload budget");
        let web = stream_budget(class, TargetOs::Web);
        assert_eq!(web.upload_bytes, native.upload_bytes.min(web_cap), "{wire}: a browser's upload is capped");
        assert_eq!(web.finish_ms, native.finish_ms, "{wire}: a browser finishes inline on the same budget");
    }
}

/// Checksums every [`EVERY`] ticks of the whole fly-through on `threads` stream threads.
fn replay(threads: usize) -> Vec<String> {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    let pool = if threads == 1 { Pool::inline() } else { Pool::new(threads) };
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(1);
    assert!(runtime.start());
    let mut checksums = Vec::new();
    for tick in 1..=fly_ticks() {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            checksums.push(runtime.checksum());
        }
    }
    checksums
}

#[test]
#[ignore = "the whole fly-through: run in release with --ignored replay"]
fn release_replay_of_the_flythrough_is_equal_on_one_and_eight_threads() {
    let one = replay(1);
    let eight = replay(8);
    assert_eq!(one.len() as u64, fly_ticks() / EVERY);
    assert_eq!(one, eight, "one stream thread against eight");
    println!("fly-through of {} ticks at {ANCHOR_SPEED} m/s: checksum {}", fly_ticks(), one.last().expect("checksums"));
}

/// A frame's samples.
#[derive(Default)]
struct Samples {
    frame_ms: Vec<f64>,
    step_ms: Vec<f64>,
    /// The CPU side of the draw (`draw_view`), then the wait for the GPU to finish the frame.
    draw_ms: Vec<f64>,
    gpu_wait_ms: Vec<f64>,
    finish_ms: Vec<f64>,
    upload_bytes: Vec<f64>,
    resident_bytes: Vec<u64>,
    loading_frames: u32,
    /// The view set's work over the run: models finished, the most cells wanted and the fewest
    /// built, the most retained groups and their instances.
    finished: u64,
    cells_wanted_max: u32,
    cells_built_min: u32,
    groups_max: u32,
    group_instances_max: u64,
}

impl Samples {
    fn view(&mut self, stats: &genex::present::ViewStats) {
        self.finish_ms.push(stats.finish_ms);
        self.upload_bytes.push(stats.upload_bytes as f64);
        self.resident_bytes.push(stats.residency.resident_bytes);
        self.loading_frames += u32::from(stats.loading_draws > 0);
        self.finished += u64::from(stats.finished);
        self.cells_wanted_max = self.cells_wanted_max.max(stats.cells_wanted);
        self.cells_built_min = if self.frame_ms.len() == 1 { stats.cells_built } else { self.cells_built_min.min(stats.cells_built) };
        self.groups_max = self.groups_max.max(stats.groups);
        self.group_instances_max = self.group_instances_max.max(stats.group_instances);
    }
}

fn percentile(values: &[f64], share: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = ((sorted.len() as f64 - 1.0) * share).round() as usize;
    sorted.get(at).copied().unwrap_or(0.0)
}

/// The [`SLOWEST`] frames: their tick and how long the tick (sim), the draw's CPU side, the GPU
/// wait and the whole frame took.
fn slowest(samples: &Samples) -> Value {
    let mut frames: Vec<usize> = (0..samples.frame_ms.len()).collect();
    frames.sort_by(|a, b| samples.frame_ms[*b].total_cmp(&samples.frame_ms[*a]));
    let rows: Vec<Value> = frames.iter().take(SLOWEST).map(|i| json!({ "tick": i + 1, "stepMs": rounded(samples.step_ms[*i]), "drawMs": rounded(samples.draw_ms[*i]), "gpuWaitMs": rounded(samples.gpu_wait_ms[*i]), "frameMs": rounded(samples.frame_ms[*i]) })).collect();
    Value::Array(rows)
}

fn rounded(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn set_class(presenter: &Presenter, class: DeviceClass) {
    let settings = presenter.render_settings().expect("the game's settings attached");
    settings.borrow_mut().apply(&RenderChange { device_class: Some(Some(class)), ..RenderChange::default() });
}

/// The fly-through drawn Live at `class` in `window`: its row and what is over a budget.
fn fly(class: DeviceClass, window: (u32, u32), table: &Value) -> (Value, Vec<String>) {
    let wire = class.wire();
    let mut presenter = Presenter::open(WORLD_SIZE, assets()).expect("a WebGPU-core adapter");
    presenter.set_window_size(window);
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    set_class(&presenter, class);
    for _ in 0..WARM_FRAMES {
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
    }
    let limits = ViewLimits::for_class(class, TargetOs::current());
    let pool = limits.residency.pool_bytes;
    let frame_budget_ms = 1000.0 / f64::from(class_defaults(class).target_fps);
    let finish_budget = finish_budget_ms(table, &wire);
    let mut samples = Samples::default();
    let mut over_pool = 0u32;
    for _ in 0..fly_ticks() {
        let start = Instant::now();
        runtime.step(FIXED_STEP_MS);
        let stepped = start.elapsed().as_secs_f64() * 1000.0;
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        let drawn = start.elapsed().as_secs_f64() * 1000.0;
        presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        let finished = start.elapsed().as_secs_f64() * 1000.0;
        samples.step_ms.push(stepped);
        samples.draw_ms.push(drawn - stepped);
        samples.gpu_wait_ms.push(finished - drawn);
        samples.frame_ms.push(finished);
        let stats = presenter.stream_stats();
        samples.view(&stats);
        over_pool += u32::from(stats.residency.resident_bytes > pool);
    }
    assert_eq!(presenter.failure(), None);
    let state = runtime.state();
    let stream = &state["volatile"]["__stream"];
    let stalls = stream["stalls"].as_u64().expect("the stall count");
    let frame_max = samples.frame_ms.iter().copied().fold(0.0, f64::max);
    let finish_p99 = percentile(&samples.finish_ms, 0.99);
    let resident_max = samples.resident_bytes.iter().copied().max().unwrap_or(0);
    let over_frame = samples.frame_ms.iter().filter(|ms| **ms > frame_budget_ms).count();
    let mut failures = Vec::new();
    if over_frame > 0 {
        failures.push(format!("{wire}: {over_frame} frames over {frame_budget_ms:.1} ms (max {frame_max:.2} ms)"));
    }
    if stalls > 0 {
        failures.push(format!("{wire}: {stalls} stalls"));
    }
    if finish_p99 > finish_budget {
        failures.push(format!("{wire}: finish p99 {finish_p99:.3} ms > {finish_budget} ms"));
    }
    // A view set that streams no model leaves its finish, upload and pool rows nothing to measure.
    if samples.finished == 0 {
        failures.push(format!("{wire}: the view set finished no model, so its finish, upload and pool rows measured nothing"));
    }
    if over_pool > 0 {
        failures.push(format!("{wire}: resident over the {:.0} MiB pool on {over_pool} frames", pool as f64 / MIB));
    }
    let row = json!({
        "class": wire,
        "window": [window.0, window.1],
        "frames": samples.frame_ms.len(),
        "frameBudgetMs": rounded(frame_budget_ms),
        "frameMs": {
            "p50": rounded(percentile(&samples.frame_ms, 0.5)),
            "p95": rounded(percentile(&samples.frame_ms, 0.95)),
            "p99": rounded(percentile(&samples.frame_ms, 0.99)),
            "max": rounded(frame_max),
        },
        "framesOverBudget": over_frame,
        "stalls": stalls,
        "heldMs": stream["heldMs"],
        "finishBudgetMs": finish_budget,
        "finishMs": { "p50": rounded(percentile(&samples.finish_ms, 0.5)), "p99": rounded(finish_p99), "max": rounded(percentile(&samples.finish_ms, 1.0)) },
        "uploadMiB": { "p99": rounded(percentile(&samples.upload_bytes, 0.99) / MIB), "max": rounded(percentile(&samples.upload_bytes, 1.0) / MIB) },
        "uploadBudgetMiB": rounded(limits.upload_bytes as f64 / MIB),
        "poolMiB": rounded(pool as f64 / MIB),
        "residentMaxMiB": rounded(resident_max as f64 / MIB),
        "framesOverPool": over_pool,
        "framesDrawingWhileLoading": samples.loading_frames,
        "view": {
            "modelsFinished": samples.finished,
            "cellsWantedMax": samples.cells_wanted_max,
            "cellsBuiltMin": samples.cells_built_min,
            "groupsMax": samples.groups_max,
            "groupInstancesMax": samples.group_instances_max,
        },
        "stepMs": { "p50": rounded(percentile(&samples.step_ms, 0.5)), "p99": rounded(percentile(&samples.step_ms, 0.99)), "max": rounded(percentile(&samples.step_ms, 1.0)) },
        "drawMs": { "p50": rounded(percentile(&samples.draw_ms, 0.5)), "p99": rounded(percentile(&samples.draw_ms, 0.99)), "max": rounded(percentile(&samples.draw_ms, 1.0)) },
        "gpuWaitMs": { "p50": rounded(percentile(&samples.gpu_wait_ms, 0.5)), "p99": rounded(percentile(&samples.gpu_wait_ms, 0.99)), "max": rounded(percentile(&samples.gpu_wait_ms, 1.0)) },
        "slowest": slowest(&samples),
    });
    (row, failures)
}

fn out_path() -> PathBuf {
    let default = repo().join(".studio-dev/evidence/rust-renderer/perf/stream-flythrough.json");
    let path = std::env::var_os("GENEX_FLY_OUT").map_or(default, PathBuf::from);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("the record's folder");
    }
    path
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_flythrough_fits_each_class_budget_with_zero_stalls_and_content_within_the_pool() {
    // The frame budgets are release figures: a debug build (the workspace's `--ignored metal`
    // sweep) would run the whole ride unoptimised, fail every frame and write the record anyway.
    if cfg!(debug_assertions) {
        return eprintln!("skipped: a debug build; the frame budgets are release rows (run with --release)");
    }
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    if let Err(error) = Presenter::open(WORLD_SIZE, assets()) {
        assert!(!require, "GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}");
        return eprintln!("skipped: no WebGPU-core adapter ({error})");
    }
    let table = budgets();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for wire in FLY_CLASSES {
        let class = DeviceClass::from_wire(wire).expect("a class");
        let window = if class.form == genex::render::FormFactor::Desktop { DESKTOP_WINDOW } else { reference_resolution(class) };
        let (row, over) = fly(class, window, &table);
        println!("{row}");
        rows.push(row);
        failures.extend(over);
    }
    let record = json!({
        "harness": "stream-flythrough",
        "speedMetresPerSecond": ANCHOR_SPEED,
        "seconds": FLY_SECONDS,
        "method": "Live frames through Presenter::draw_view, one tick per frame; frame = tick + draw + GPU completion (device poll)",
        "rows": rows,
        "passed": failures.is_empty(),
        "failures": failures,
    });
    std::fs::write(out_path(), format!("{record:#}\n")).expect("the record writes");
    assert!(failures.is_empty(), "the fly-through is over a budget: {failures:?}");
}
