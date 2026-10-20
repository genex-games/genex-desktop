//! `ProfileReport` v2: what the dev op `profile` answers for `report` (the host's
//! `ProfileReportV2` in `src/shared/frame-profile.ts`). The last frames the recorder kept whole,
//! each with its scope tree (microseconds from the frame's start), its CPU, GPU and interval
//! times and its GPU nodes, plus every kept hitch, the memory rows and the counters.
//!
//! Caps: at most [`PROFILE_REPORT_FRAMES_MAX`] frames and [`PROFILE_FRAME_SCOPES_MAX`] scopes a
//! frame (the deepest leave first). Its JSON never passes [`PROFILE_REPORT_MAX_BYTES`]: the oldest
//! frames leave first, then hitches, and `truncated` says so.

use std::collections::BTreeMap;
use std::sync::Arc;

use puffin::{FrameData, Reader, Stream};
use serde::Serialize;

use crate::gpu_lane::{GpuLane, GpuNodeTime};
use crate::hitch::{Hitch, HitchDetector};
use crate::recorder::Profiler;
use crate::scope::key_of;
use crate::summary::{FrameStat, GpuTimeSource, MemoryRow, ms};

/// The report's format number (its `v`).
pub const PROFILE_REPORT_VERSION: u32 = 2;
/// The most bytes a report takes as JSON.
pub const PROFILE_REPORT_MAX_BYTES: usize = 256 * 1024;
/// The most frames a report holds.
pub const PROFILE_REPORT_FRAMES_MAX: usize = 240;
/// The frames a `report` gives when it names none.
pub const PROFILE_REPORT_FRAMES_DEFAULT: usize = 120;
/// The most scopes one report frame lists.
pub const PROFILE_FRAME_SCOPES_MAX: usize = 512;
/// The engine id every report names.
pub const PROFILE_REPORT_ENGINE: &str = "rust-wgpu";
/// Nanoseconds per microsecond; microseconds keep three decimals (one nanosecond).
const NS_PER_US: f64 = 1_000.0;
const US_DECIMALS: f64 = 1_000.0;

/// Who the report is about, and the lanes it reads besides the recorder.
#[derive(Clone, Copy)]
pub struct ReportMeta<'a> {
    destination: &'a str,
    device_class: &'a str,
    gpu: Option<&'a GpuLane>,
    hitches: Option<&'a HitchDetector>,
    memory: &'a [MemoryRow],
}

impl<'a> ReportMeta<'a> {
    /// A report for `destination` (`mac`, `web`, …) on `device_class` (`desktop-high`, …), with no
    /// GPU lane, hitches or memory rows yet.
    pub fn new(destination: &'a str, device_class: &'a str) -> ReportMeta<'a> {
        ReportMeta { destination, device_class, gpu: None, hitches: None, memory: &[] }
    }

    /// The same, reading GPU times from `gpu`.
    pub fn with_gpu(self, gpu: &'a GpuLane) -> ReportMeta<'a> {
        ReportMeta { gpu: Some(gpu), ..self }
    }

    /// The same, listing `hitches`' kept hitches.
    pub fn with_hitches(self, hitches: &'a HitchDetector) -> ReportMeta<'a> {
        ReportMeta { hitches: Some(hitches), ..self }
    }

    /// The same, listing `memory`.
    pub fn with_memory(self, memory: &'a [MemoryRow]) -> ReportMeta<'a> {
        ReportMeta { memory, ..self }
    }
}

/// One timed scope of a report frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportScope {
    /// The engine stage's wire spelling or the game's name.
    pub scope: &'static str,
    /// Whether a game named it.
    pub game: bool,
    /// Its nesting depth on its thread (0: top level).
    pub depth: usize,
    /// Microseconds from the frame's start.
    pub start_us: f64,
    /// Its duration, in microseconds.
    pub us: f64,
}

/// One frame of a report.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFrame {
    /// The profiler's frame index.
    pub index: u64,
    /// The frame's CPU time, in milliseconds.
    pub cpu_ms: f64,
    /// The frame's GPU time, when the lane has it.
    pub gpu_ms: Option<f64>,
    /// Milliseconds since the previous kept frame began (0 for the first kept frame).
    pub interval_ms: f64,
    /// Its scopes in start order, at most [`PROFILE_FRAME_SCOPES_MAX`].
    pub scopes: Vec<ReportScope>,
    /// Per-node GPU times in schedule order (empty unless per-node timing was armed).
    pub gpu: Vec<GpuNodeTime>,
}

/// What the dev op `profile` answers for `report`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReport {
    /// The format number, [`PROFILE_REPORT_VERSION`].
    pub v: u32,
    /// [`PROFILE_REPORT_ENGINE`].
    pub engine: &'static str,
    /// Where the game runs.
    pub destination: String,
    /// The device class it runs as.
    pub device_class: String,
    /// The frames, oldest first.
    pub frames: Vec<ReportFrame>,
    /// Every kept hitch, oldest frame first.
    pub hitches: Vec<Hitch>,
    /// Memory rows.
    pub memory: Vec<MemoryRow>,
    /// Every counter's last value, by name.
    pub counters: BTreeMap<&'static str, f64>,
    /// Where the GPU numbers come from.
    pub gpu_source: GpuTimeSource,
    /// Whether caps left anything out.
    pub truncated: bool,
}

impl ProfileReport {
    /// The report of `profiler`'s last `frames` recent frames (clamped to
    /// 1..=[`PROFILE_REPORT_FRAMES_MAX`]) with what `meta` names.
    pub fn build(profiler: &Profiler, meta: ReportMeta<'_>, frames: usize) -> ProfileReport {
        let wanted = frames.clamp(1, PROFILE_REPORT_FRAMES_MAX);
        let recent: Vec<&Arc<FrameData>> = profiler.recent_frames().collect();
        let first = recent.len().saturating_sub(wanted);
        let window: Vec<&FrameStat> = profiler.window().collect();
        let mut truncated = false;
        let mut report_frames = Vec::with_capacity(recent.len() - first);
        for at in first..recent.len() {
            let previous = at.checked_sub(1).map(|before| recent[before].as_ref());
            let (frame, cut) = report_frame(recent[at], previous, &window, meta.gpu);
            truncated |= cut;
            report_frames.push(frame);
        }
        let summary = profiler.summary();
        ProfileReport {
            v: PROFILE_REPORT_VERSION,
            engine: PROFILE_REPORT_ENGINE,
            destination: meta.destination.to_owned(),
            device_class: meta.device_class.to_owned(),
            frames: report_frames,
            hitches: meta.hitches.map(|hitches| hitches.hitches().cloned().collect()).unwrap_or_default(),
            memory: meta.memory.to_vec(),
            counters: summary.counters,
            gpu_source: meta.gpu.map_or(GpuTimeSource::None, GpuLane::source),
            truncated,
        }
    }

    /// The report as JSON, at most [`PROFILE_REPORT_MAX_BYTES`]: past it the oldest frames leave
    /// first, then the oldest hitches, and `truncated` is set.
    pub fn to_json(&self) -> Vec<u8> {
        let first = serde_json::to_vec(self).unwrap_or_default();
        if first.len() <= PROFILE_REPORT_MAX_BYTES {
            return first;
        }
        let mut fitted = self.clone();
        fitted.truncated = true;
        // Drop about as many frames as the excess suggests, then one at a time.
        let per_frame = first.len() / self.frames.len().max(1);
        let excess = first.len() - PROFILE_REPORT_MAX_BYTES;
        let guess = (excess / per_frame.max(1)).min(fitted.frames.len());
        fitted.frames.drain(..guess);
        loop {
            let json = serde_json::to_vec(&fitted).unwrap_or_default();
            if json.len() <= PROFILE_REPORT_MAX_BYTES || !fitted.give_way() {
                return json;
            }
        }
    }

    /// Leave out the oldest frame, else the oldest hitch; false when neither is left.
    fn give_way(&mut self) -> bool {
        if !self.frames.is_empty() {
            self.frames.remove(0);
            return true;
        }
        if !self.hitches.is_empty() {
            self.hitches.remove(0);
            return true;
        }
        false
    }
}

/// One kept frame as a report frame, and whether its scopes were cut.
fn report_frame(
    frame: &FrameData,
    previous: Option<&FrameData>,
    window: &[&FrameStat],
    gpu: Option<&GpuLane>,
) -> (ReportFrame, bool) {
    let index = frame.frame_index();
    let start_ns = frame.meta().range_ns.0;
    let interval_ns = previous.map_or(0, |before| start_ns.saturating_sub(before.meta().range_ns.0));
    let (scopes, top_level_ns) = frame_scopes(frame, start_ns);
    let cut = scopes.len() > PROFILE_FRAME_SCOPES_MAX;
    let stat = window.iter().find(|stat| stat.index == index);
    let cpu_ns = stat.map_or(top_level_ns, |stat| stat.cpu_ns);
    let lane = gpu.and_then(|lane| lane.frame(index));
    let report = ReportFrame {
        index,
        cpu_ms: ms(cpu_ns),
        gpu_ms: lane.and_then(|lane| lane.frame_ms),
        interval_ms: ms(interval_ns),
        scopes: keep_shallowest(scopes),
        gpu: lane.map(|lane| lane.nodes.clone()).unwrap_or_default(),
    };
    (report, cut)
}

/// Every genex scope of the frame on every thread, with its depth and start, and the busiest
/// thread's top-level time (the CPU time of a frame older than the summary's window).
fn frame_scopes(frame: &FrameData, start_ns: i64) -> (Vec<ReportScope>, i64) {
    let Some(unpacked) = frame.unpacked().ok() else { return (Vec::new(), 0) };
    let mut scopes = Vec::new();
    let mut busiest = 0i64;
    for stream in unpacked.thread_streams.values() {
        busiest = busiest.max(walk(&stream.stream, start_ns, &mut scopes));
    }
    (scopes, busiest)
}

/// Add one thread's genex scopes to `scopes`; answers its top-level time. Another library's
/// scope is not listed, though its children are (one level deeper).
fn walk(stream: &Stream, start_ns: i64, scopes: &mut Vec<ReportScope>) -> i64 {
    let mut top_level = 0i64;
    let mut pending: Vec<(u64, usize)> = vec![(0, 0)];
    while let Some((offset, depth)) = pending.pop() {
        let Ok(reader) = Reader::with_offset(stream, offset) else { continue };
        for parsed in reader {
            let Ok(found) = parsed else { break };
            let record = found.record;
            if depth == 0 {
                top_level = top_level.saturating_add(record.duration_ns);
            }
            if let Some(key) = key_of(found.id) {
                scopes.push(ReportScope {
                    scope: key.name(),
                    game: key.is_game(),
                    depth,
                    start_us: us(record.start_ns.saturating_sub(start_ns)),
                    us: us(record.duration_ns),
                });
            }
            pending.push((found.child_begin_position, depth + 1));
        }
    }
    top_level
}

/// At most [`PROFILE_FRAME_SCOPES_MAX`] scopes, the deepest leaving first, in start order.
fn keep_shallowest(mut scopes: Vec<ReportScope>) -> Vec<ReportScope> {
    if scopes.len() > PROFILE_FRAME_SCOPES_MAX {
        scopes.sort_by_key(|scope| scope.depth);
        scopes.truncate(PROFILE_FRAME_SCOPES_MAX);
    }
    scopes.sort_by(|a, b| a.start_us.total_cmp(&b.start_us).then(a.depth.cmp(&b.depth)));
    scopes
}

/// Nanoseconds as microseconds with three decimals.
fn us(ns: i64) -> f64 {
    (ns as f64 / NS_PER_US * US_DECIMALS).round() / US_DECIMALS
}
