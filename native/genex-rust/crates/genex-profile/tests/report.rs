//! The report's rows (PROF-1b): the hitch table (CPU over twice the median, a GPU span arriving
//! three frames late attaching to its own frame, a long interval with normal CPU and GPU, nothing
//! in the warm-up), the hitch ring's caps, a report past 256 KiB truncated and still valid JSON,
//! GPU nodes in schedule order, a Chrome trace with one `X` event per scope, and the shared
//! fixture `tests/fixtures/profile-report-v2.json` the host's parser reads too. Each test runs on
//! its own thread with its own profiler and its own fake clock.

use std::cell::Cell;
use std::path::PathBuf;

use genex_profile::caps::PROFILE_MEMORY_MAX_BYTES;
use genex_profile::gpu_lane::{GpuLane, GpuNodeSample, WORLD_NODE};
use genex_profile::hitch::{HITCH_MIN_FRAMES, HitchCause, HitchDetector};
use genex_profile::memory::{MemoryClass, MemoryRows};
use genex_profile::report::{PROFILE_FRAME_SCOPES_MAX, PROFILE_REPORT_MAX_BYTES, ProfileReport, ReportMeta};
use genex_profile::scope::Site;
use genex_profile::summary::FrameStat;
use genex_profile::trace::{chrome_trace, trace_digest};
use genex_profile::{
    CapsClass, EngineScope, GpuTimeSource, NodeTiming, ProfileCaps, Profiler, ProfilerConfig, ScopeKey, ScopeName,
    scope,
};
use serde_json::Value;

const NS_PER_MS: i64 = 1_000_000;
const NS_PER_US: i64 = 1_000;
/// A 60 Hz budget, in milliseconds.
const BUDGET_MS: f32 = 1000.0 / 60.0;

thread_local! {
    static NOW: Cell<i64> = const { Cell::new(0) };
}

fn fake_clock() -> i64 {
    NOW.with(Cell::get)
}

fn advance(ns: i64) {
    NOW.with(|now| now.set(now.get() + ns));
}

fn profiler(class: CapsClass) -> Profiler {
    Profiler::new(ProfilerConfig::new(class).with_clock(fake_clock))
}

/// A synthetic frame stat: `cpu_ms` of CPU, all of it in physics.
fn stat(index: u64, cpu_ms: f64) -> FrameStat {
    let ns = (cpu_ms * NS_PER_MS as f64) as i64;
    FrameStat { index, cpu_ns: ns, scopes: vec![(ScopeKey::Engine(EngineScope::Physics), ns)] }
}

fn detector(class: CapsClass) -> HitchDetector {
    HitchDetector::new(ProfileCaps::for_class(class), BUDGET_MS)
}

/// Warm a detector up with `frames` steady frames of `cpu_ms` at a 60 Hz interval.
fn warm(detector: &mut HitchDetector, frames: u64, cpu_ms: f64) {
    for index in 0..frames {
        assert_eq!(detector.observe_frame(&stat(index, cpu_ms), f64::from(BUDGET_MS)), None, "frame {index}");
    }
}

#[test]
fn no_hitch_in_the_first_30_frames_however_slow() {
    let mut hitches = detector(CapsClass::Desktop);
    for index in 0..HITCH_MIN_FRAMES as u64 {
        let cpu = if index % 2 == 0 { 2.0 } else { 200.0 };
        assert_eq!(hitches.observe_frame(&stat(index, cpu), 400.0), None, "warm-up frame {index}");
        assert_eq!(hitches.observe_gpu(index, 300.0), None, "warm-up GPU {index}");
    }
    assert_eq!(hitches.count(), 0);
}

#[test]
fn cpu_over_twice_the_median_is_a_cpu_hitch() {
    let mut hitches = detector(CapsClass::Desktop);
    // A 20 ms median puts the line at 40 ms, above the 25 ms budget line.
    warm(&mut hitches, 40, 20.0);
    assert_eq!(hitches.observe_frame(&stat(40, 39.0), 20.0), None, "under twice the median");
    assert_eq!(hitches.observe_frame(&stat(41, 41.0), 20.0), Some(HitchCause::Cpu));
    let hitch = hitches.hitches().last().expect("a hitch");
    assert_eq!((hitch.frame, hitch.cause, hitch.threshold_ms), (41, HitchCause::Cpu, 40.0));
    assert_eq!(hitch.top.first().map(|top| (top.scope, top.us)), Some(("physics", 41_000.0)));
    // A 5 ms median: twice it is 10 ms, but the budget line (1.5 x 16.667 ms) is the floor.
    let mut light = detector(CapsClass::Desktop);
    warm(&mut light, 40, 5.0);
    assert_eq!(light.observe_frame(&stat(40, 24.0), 16.0), None, "under the budget floor");
    assert_eq!(light.observe_frame(&stat(41, 26.0), 16.0), Some(HitchCause::Cpu));
}

#[test]
fn a_gpu_span_three_frames_late_attaches_to_its_own_frame() {
    let mut hitches = detector(CapsClass::Desktop);
    warm(&mut hitches, 40, 5.0);
    for index in 0..40 {
        assert_eq!(hitches.observe_gpu(index, 4.0), None);
    }
    for index in 40..44 {
        assert_eq!(hitches.observe_frame(&stat(index, 5.0), 16.7), None);
    }
    // Frame 40's GPU time arrives while frame 43 is closing.
    assert_eq!(hitches.observe_gpu(40, 30.0), Some(HitchCause::Gpu));
    let hitch = hitches.hitches().last().expect("a hitch");
    assert_eq!((hitch.frame, hitch.cause), (40, HitchCause::Gpu));
    assert!((hitch.threshold_ms - 25.0).abs() < 1e-3, "max(2 x 4 ms, 1.5 x budget): {}", hitch.threshold_ms);
    assert_eq!(hitches.summary().last, Some(40));
}

#[test]
fn a_long_interval_with_normal_cpu_and_gpu_is_pacing_and_a_late_gpu_span_retypes_it() {
    let mut hitches = detector(CapsClass::Desktop);
    warm(&mut hitches, 40, 5.0);
    for index in 0..40 {
        hitches.observe_gpu(index, 4.0);
    }
    assert_eq!(hitches.observe_frame(&stat(40, 5.0), 41.0), None, "2.46 x the interval is under the line");
    assert_eq!(hitches.observe_frame(&stat(41, 5.0), 50.0), Some(HitchCause::Pacing));
    assert_eq!(hitches.observe_gpu(41, 4.0), None, "normal GPU keeps it pacing");
    assert_eq!(hitches.hitches().last().map(|hitch| hitch.cause), Some(HitchCause::Pacing));
    assert_eq!(hitches.observe_frame(&stat(42, 5.0), 50.0), Some(HitchCause::Pacing));
    assert_eq!(hitches.observe_gpu(42, 30.0), Some(HitchCause::Gpu), "its GPU was the cause after all");
    let causes: Vec<(u64, HitchCause)> = hitches.hitches().map(|hitch| (hitch.frame, hitch.cause)).collect();
    assert_eq!(causes, vec![(41, HitchCause::Pacing), (42, HitchCause::Gpu)], "retyped, not counted twice");
    assert_eq!(hitches.count(), 2);
}

#[test]
fn the_ring_keeps_the_16_newest_hitches_and_8_on_a_phone() {
    for (class, kept) in [(CapsClass::Desktop, 16), (CapsClass::Web, 16), (CapsClass::Phone, 8)] {
        let mut hitches = detector(class);
        warm(&mut hitches, 40, 5.0);
        for index in 40..80 {
            let cpu = if index % 2 == 0 { 60.0 } else { 5.0 };
            hitches.observe_frame(&stat(index, cpu), 16.7);
        }
        let frames: Vec<u64> = hitches.hitches().map(|hitch| hitch.frame).collect();
        let every: Vec<u64> = (40..80).filter(|index| index % 2 == 0).collect();
        let newest = every[every.len() - kept..].to_vec();
        assert_eq!(frames, newest, "{class:?}");
        assert_eq!(hitches.count(), 20, "{class:?} counts every hitch");
    }
}

#[test]
fn gpu_nodes_keep_schedule_order_and_lay_out_end_to_end() {
    let mut lane = GpuLane::new(GpuTimeSource::Timestamps);
    // Schedule order, deliberately not alphabetical; frame 6 arrives before frame 5 finishes.
    let schedule = ["shadows", "depth-prepass", WORLD_NODE, "bloom", "tonemap"];
    let samples = |frame: u64| -> Vec<GpuNodeSample> {
        schedule.iter().enumerate().map(|(at, node)| GpuNodeSample { frame, node, ms: (at + 1) as f64 * 0.5 }).collect()
    };
    lane.record_nodes(&samples(6));
    lane.record_frame(6, 8.0);
    lane.record_nodes(&samples(5));
    lane.record_frame(5, 7.5);
    let frame = lane.frame(5).expect("frame 5");
    let nodes: Vec<&str> = frame.nodes.iter().map(|node| node.node).collect();
    assert_eq!(nodes, schedule);
    assert_eq!(lane.frames().map(|frame| frame.frame).collect::<Vec<_>>(), vec![5, 6], "kept by frame index");
    let spans = lane.spans(5);
    let layout: Vec<(i64, i64)> = spans.iter().map(|span| (span.start_ns, span.end_ns)).collect();
    assert_eq!(layout, vec![(0, 500_000), (500_000, 1_500_000), (1_500_000, 3_000_000), (3_000_000, 5_000_000), (5_000_000, 7_500_000)]);
    // A sample that is not finite or not a name is left out and counted.
    lane.record_nodes(&[
        GpuNodeSample { frame: 7, node: "Bad Node", ms: 1.0 },
        GpuNodeSample { frame: 7, node: "ok", ms: f64::NAN },
    ]);
    assert_eq!(lane.dropped_nodes(), 2);
    let summary = lane.summary().expect("GPU frame times");
    assert_eq!((summary.p50, summary.p95, summary.source), (7.5, 8.0, GpuTimeSource::Timestamps));
}

#[test]
fn memory_rows_keep_their_wire_names_and_their_cap() {
    let mut memory = MemoryRows::new();
    assert!(memory.push(MemoryClass::Gpu("streamed-meshes"), 41_943_040, Some(67_108_864)));
    assert!(memory.push(MemoryClass::ProcessResident, 512_000_000, None));
    assert!(memory.push(MemoryClass::WasmHeap, 16_777_216, None));
    assert!(!memory.push(MemoryClass::Cpu("Asset Cache"), 1, None), "not a wire name");
    let classes: Vec<&str> = memory.rows().iter().map(|row| row.class.as_str()).collect();
    assert_eq!(classes, vec!["streamed-meshes", "process-resident", "wasm-heap"]);
    assert!(memory.push(MemoryClass::Gpu("streamed-meshes"), 1, Some(2)), "a class set again replaces its row");
    assert_eq!(memory.rows().len(), 3);
    for n in 0..100 {
        let name: &'static str = Box::leak(format!("cpu-{n}").into_boxed_str());
        memory.push(MemoryClass::Cpu(name), 1, None);
    }
    assert_eq!(memory.rows().len(), genex_profile::memory::PROFILE_MEMORY_ROWS_MAX);
    assert_eq!(memory.dropped(), 1 + 100 + 3 - genex_profile::memory::PROFILE_MEMORY_ROWS_MAX as u64);
}

/// 240 frames, each with `scopes_per_frame` game scopes under the frame scope.
fn heavy_profiler(scopes_per_frame: usize) -> Profiler {
    let mut profiler = profiler(CapsClass::Desktop);
    let sites: Vec<&'static Site> = (0..scopes_per_frame)
        .map(|n| {
            let name = ScopeName::try_new(Box::leak(format!("heavy_scope_{n:04}").into_boxed_str())).expect("valid");
            &*Box::leak(Box::new(Site::new(name)))
        })
        .collect();
    for _ in 0..240 {
        {
            let _frame = scope(EngineScope::Frame);
            for site in &sites {
                let _scope = site.enter();
                advance(NS_PER_US);
            }
        }
        advance(NS_PER_MS);
        profiler.new_frame();
    }
    profiler
}

#[test]
fn a_report_over_256_kib_is_truncated_and_stays_valid_json() {
    let profiler = heavy_profiler(PROFILE_FRAME_SCOPES_MAX + 88);
    assert!(profiler.bytes_kept() <= PROFILE_MEMORY_MAX_BYTES);
    let report = ProfileReport::build(&profiler, ReportMeta::new("mac", "desktop-high"), 240);
    let deepest = report.frames.last().expect("frames").scopes.iter().map(|row| row.depth).max();
    assert_eq!(report.frames.last().map(|frame| frame.scopes.len()), Some(PROFILE_FRAME_SCOPES_MAX));
    assert_eq!(deepest, Some(1), "the frame scope (depth 0) is kept; the deepest rows went first");
    let json = report.to_json();
    assert!(json.len() <= PROFILE_REPORT_MAX_BYTES, "{} bytes", json.len());
    let parsed: Value = serde_json::from_slice(&json).expect("valid JSON");
    assert_eq!(parsed["truncated"], true);
    assert_eq!(parsed["v"], 2);
    let frames = parsed["frames"].as_array().expect("frames");
    assert!(!frames.is_empty() && frames.len() < 240, "{} frames kept", frames.len());
    assert_eq!(frames.last().map(|frame| &frame["index"]), Some(&Value::from(239)), "the oldest frames went first");
}

#[test]
fn a_chrome_trace_has_one_x_event_per_scope_and_gpu_node() {
    let mut profiler = profiler(CapsClass::Desktop);
    let mut lane = GpuLane::new(GpuTimeSource::Timestamps);
    for frame in 0..3u64 {
        {
            let _frame = scope(EngineScope::Frame);
            {
                let _tick = scope(EngineScope::Tick);
                advance(2 * NS_PER_MS);
            }
            let _draw = scope(EngineScope::Draw);
            advance(NS_PER_MS);
        }
        advance(13 * NS_PER_MS);
        profiler.new_frame();
        lane.record_nodes(&[
            GpuNodeSample { frame, node: "shadows", ms: 1.0 },
            GpuNodeSample { frame, node: WORLD_NODE, ms: 2.0 },
        ]);
        lane.record_frame(frame, 3.5);
    }
    let report = ProfileReport::build(&profiler, ReportMeta::new("mac", "desktop-high").with_gpu(&lane), 120);
    let trace = chrome_trace(&report);
    let parsed: Value = serde_json::from_slice(&trace).expect("the trace is JSON");
    let events = parsed["traceEvents"].as_array().expect("traceEvents");
    let complete: Vec<&Value> = events.iter().filter(|event| event["ph"] == "X").collect();
    let scopes: usize = report.frames.iter().map(|frame| frame.scopes.len()).sum();
    let nodes: usize = report.frames.iter().map(|frame| frame.gpu.len()).sum();
    assert_eq!((scopes, nodes), (9, 6));
    assert_eq!(complete.len(), scopes + nodes);
    let ticks: Vec<f64> = complete.iter().filter(|event| event["name"] == "tick").map(|event| event["ts"].as_f64().unwrap_or(-1.0)).collect();
    assert_eq!(ticks, vec![0.0, 16_000.0, 32_000.0], "each frame starts one interval after the last");
    assert_eq!(trace_digest(&trace).len(), 16);
    assert_eq!(trace_digest(b""), "cbf29ce484222325", "FNV-1a 64 of nothing is its offset basis");
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/profile-report-v2.json")
}

/// The fixture's run: four frames with a game scope and a counter, GPU nodes, memory rows, and one
/// CPU hitch after the warm-up.
fn fixture_values() -> (Value, Value) {
    let mut profiler = profiler(CapsClass::Desktop);
    let mut lane = GpuLane::new(GpuTimeSource::Timestamps);
    lane.set_nodes(NodeTiming::Armed);
    let mut hitches = detector(CapsClass::Desktop);
    warm(&mut hitches, HITCH_MIN_FRAMES as u64, 4.0);
    profiler.counter(ScopeName::new("enemies"), 42.0);
    for frame in 0..4u64 {
        {
            let _frame = scope(EngineScope::Frame);
            {
                let _tick = scope(EngineScope::Tick);
                genex_profile::profile_scope!("enemy_ai");
                advance(if frame == 3 { 30 * NS_PER_MS } else { 3 * NS_PER_MS });
            }
            let _draw = scope(EngineScope::Draw);
            advance(NS_PER_MS);
        }
        advance(12 * NS_PER_MS);
        profiler.new_frame();
        lane.record_nodes(&[
            GpuNodeSample { frame, node: "shadows", ms: 1.25 },
            GpuNodeSample { frame, node: WORLD_NODE, ms: 2.0 },
        ]);
        lane.record_frame(frame, 3.5);
    }
    let window: Vec<FrameStat> = profiler.window().cloned().collect();
    for stat in &window {
        hitches.observe_frame(stat, 16.0);
    }
    let mut memory = MemoryRows::new();
    memory.push(MemoryClass::Gpu("streamed-meshes"), 41_943_040, Some(67_108_864));
    memory.push(MemoryClass::ProcessResident, 512_000_000, None);
    let mut summary = profiler.summary();
    lane.fill(&mut summary);
    hitches.fill(&mut summary);
    memory.fill(&mut summary);
    let meta = ReportMeta::new("mac", "desktop-high").with_gpu(&lane).with_hitches(&hitches).with_memory(memory.rows());
    let report = ProfileReport::build(&profiler, meta, 120);
    let summary = serde_json::from_slice(&summary.to_json()).expect("summary JSON");
    let report = serde_json::from_slice(&report.to_json()).expect("report JSON");
    (summary, report)
}

#[test]
fn the_report_and_summary_match_the_shared_fixture() {
    let (summary, report) = fixture_values();
    let built = serde_json::json!({ "summary": summary, "report": report });
    if std::env::var_os("GENEX_WRITE_PROFILE_FIXTURE").is_some() {
        let text = serde_json::to_string_pretty(&built).expect("fixture text") + "\n";
        std::fs::write(fixture_path(), text).expect("the fixture is written");
    }
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(fixture_path()).expect("the shared fixture exists")).expect("fixture JSON");
    assert_eq!(built, fixture, "regenerate with GENEX_WRITE_PROFILE_FIXTURE=1 only for an intended change");
    assert_eq!(fixture["report"]["hitches"][0]["cause"], "cpu");
    assert_eq!(fixture["summary"]["nodes"], "armed");
    assert_eq!(fixture["summary"]["gpu"]["source"], "timestamps");
}
