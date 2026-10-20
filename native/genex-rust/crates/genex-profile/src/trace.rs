//! A Chrome trace of a report: the JSON `chrome://tracing`, Perfetto and Speedscope open, written
//! by the dev op `profile trace` into the run's `state/profile/`. One complete (`X`) event per
//! report scope on the CPU lane and per GPU node on the GPU lane, plus a name event per lane.
//!
//! Ported from wgpu-profiler 0.28.0 `src/chrometrace.rs` (<https://github.com/Wumpf/wgpu-profiler>,
//! by Andreas Reich, MIT OR Apache-2.0): the `traceEvents` array of `X` events with microsecond
//! `ts` and `dur`, one `tid` per lane. Two changes: the events are written through serde_json, not
//! format strings, so a name can never break the JSON, and frames are laid out one after another by
//! their report intervals (a report frame's scopes are relative to its own start).

use serde::Serialize;

use crate::report::ProfileReport;

/// The trace's process id (one game process).
const TRACE_PID: u32 = 1;
/// The CPU lane's thread id: every recorded thread's scopes, as the report lists them.
const CPU_TID: u32 = 1;
/// The GPU lane's thread id.
const GPU_TID: u32 = 2;
/// Microseconds per millisecond.
const US_PER_MS: f64 = 1_000.0;
/// FNV-1a 64's offset basis and prime.
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// One trace event.
#[derive(Serialize)]
struct TraceEvent<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cat: Option<&'static str>,
    ph: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ts: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dur: Option<f64>,
    pid: u32,
    tid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<LaneName>,
}

/// A lane's display name (the `M` event's argument).
#[derive(Serialize)]
struct LaneName {
    name: &'static str,
}

/// The trace file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Trace<'a> {
    trace_events: Vec<TraceEvent<'a>>,
    display_time_unit: &'static str,
}

/// A complete event at `ts` for `dur` microseconds.
fn complete<'a>(name: &'a str, cat: &'static str, ts: f64, dur: f64, tid: u32) -> TraceEvent<'a> {
    TraceEvent { name, cat: Some(cat), ph: "X", ts: Some(ts), dur: Some(dur), pid: TRACE_PID, tid, args: None }
}

/// The metadata event naming lane `tid`.
fn lane_name(tid: u32, name: &'static str) -> TraceEvent<'static> {
    TraceEvent {
        name: "thread_name",
        cat: None,
        ph: "M",
        ts: None,
        dur: None,
        pid: TRACE_PID,
        tid,
        args: Some(LaneName { name }),
    }
}

/// `report` as Chrome trace JSON.
pub fn chrome_trace(report: &ProfileReport) -> Vec<u8> {
    let mut events = vec![lane_name(CPU_TID, "CPU"), lane_name(GPU_TID, "GPU")];
    let mut frame_start_us = 0.0;
    for (at, frame) in report.frames.iter().enumerate() {
        if at > 0 {
            frame_start_us += frame.interval_ms * US_PER_MS;
        }
        for scope in &frame.scopes {
            let cat = if scope.game { "game" } else { "engine" };
            events.push(complete(scope.scope, cat, frame_start_us + scope.start_us, scope.us, CPU_TID));
        }
        let mut gpu_start_us = frame_start_us;
        for node in &frame.gpu {
            let dur = node.ms * US_PER_MS;
            events.push(complete(node.node, "gpu", gpu_start_us, dur, GPU_TID));
            gpu_start_us += dur;
        }
    }
    serde_json::to_vec(&Trace { trace_events: events, display_time_unit: "ms" }).unwrap_or_default()
}

/// FNV-1a 64 of `bytes` as 16 lowercase hex digits (the digest `trace` answers, as `bakeAssets`).
pub fn trace_digest(bytes: &[u8]) -> String {
    let hash = bytes.iter().fold(FNV_OFFSET, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME));
    format!("{hash:016x}")
}
