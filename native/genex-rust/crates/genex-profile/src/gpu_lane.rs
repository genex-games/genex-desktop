//! The GPU lane: per-frame GPU times the renderer's timer hands over as plain data, kept by frame
//! index beside the CPU scopes. The renderer (genex-render's `GpuTimer`, PROF-2) gives each
//! frame's whole time and, while per-node timing is armed, one [`GpuNodeSample`] per frame-graph
//! node in schedule order (the world pass's in-pass run as [`WORLD_NODE`]). Samples arrive two or
//! three frames late and in any frame order; each attaches to its own frame.
//!
//! The span layout ([`GpuLane::spans`]) is ported from wgpu-profiler 0.28.0 `src/puffin.rs`
//! (`collect_stream_info_recursive`, <https://github.com/Wumpf/wgpu-profiler>, by Andreas Reich,
//! MIT OR Apache-2.0): each timed query becomes a begin/end span with its depth,
//! and the lane keeps the stream's range and scope count. Two changes: our node brackets are
//! sequential at one depth, so a node's span starts where the previous one ended (the brackets
//! measure durations, not shared clock stamps), and the spans are not registered with puffin's
//! global profiler, whose lock a browser's main thread may never wait on; the report and the
//! Chrome trace read them instead.

use std::collections::VecDeque;

use serde::Serialize;

use crate::caps::SUMMARY_WINDOW_FRAMES;
use crate::report::PROFILE_REPORT_FRAMES_MAX;
use crate::scope::is_scope_name;
use crate::summary::{GpuSummary, GpuTimeSource, NodeTiming, ProfileSummary, nearest_rank};

/// The node name of the world pass's in-pass run, timed as one span.
pub const WORLD_NODE: &str = "world";
/// The most nodes one frame times (genex-render's `MAX_TIMED_NODES`, restated below the renderer).
pub const PROFILE_GPU_NODES_MAX: usize = 256;
/// The most frames the lane keeps: as many as a report can ask for.
pub const GPU_LANE_FRAMES_MAX: usize = PROFILE_REPORT_FRAMES_MAX;
/// Nanoseconds per millisecond, and microseconds per millisecond.
const NS_PER_MS: f64 = 1_000_000.0;
const US_PER_MS: f64 = 1_000.0;

/// One node's GPU time in one frame, as the renderer hands it over.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GpuNodeSample {
    /// The profiler's frame index the work belongs to.
    pub frame: u64,
    /// The frame-graph row's wire name, or [`WORLD_NODE`].
    pub node: &'static str,
    /// Its GPU time, in milliseconds.
    pub ms: f64,
}

/// One node's time in a kept frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct GpuNodeTime {
    /// The frame-graph row's wire name, or [`WORLD_NODE`].
    pub node: &'static str,
    /// Its GPU time, in milliseconds.
    pub ms: f64,
}

/// One frame's GPU times.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GpuFrame {
    /// The profiler's frame index.
    pub frame: u64,
    /// The whole frame's GPU time, once the timer has it.
    pub frame_ms: Option<f64>,
    /// Per-node times in schedule order (empty unless per-node timing was armed).
    pub nodes: Vec<GpuNodeTime>,
}

/// One node laid out as a span, nanoseconds from the frame's first node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuSpan {
    /// The node's name.
    pub node: &'static str,
    /// Where it begins.
    pub start_ns: i64,
    /// Where it ends.
    pub end_ns: i64,
    /// Its nesting depth (0: the brackets are sequential).
    pub depth: usize,
}

/// A run's GPU lane.
pub struct GpuLane {
    source: GpuTimeSource,
    nodes: NodeTiming,
    /// Kept frames, by frame index.
    frames: VecDeque<GpuFrame>,
    dropped_nodes: u64,
}

impl GpuLane {
    /// An empty lane whose numbers come from `source`, per-node timing off.
    pub fn new(source: GpuTimeSource) -> GpuLane {
        GpuLane { source, nodes: NodeTiming::Off, frames: VecDeque::new(), dropped_nodes: 0 }
    }

    /// Where the numbers come from.
    pub fn source(&self) -> GpuTimeSource {
        self.source
    }

    /// Say whether per-node timing is armed (the summary shows it).
    pub fn set_nodes(&mut self, nodes: NodeTiming) {
        self.nodes = nodes;
    }

    /// The kept frame `frame`, made when absent; None when it is older than every kept frame of
    /// a full lane.
    fn frame_mut(&mut self, frame: u64) -> Option<&mut GpuFrame> {
        let at = self.frames.partition_point(|kept| kept.frame < frame);
        let present = self.frames.get(at).is_some_and(|kept| kept.frame == frame);
        if !present {
            if at == 0 && self.frames.len() == GPU_LANE_FRAMES_MAX {
                return None;
            }
            self.frames.insert(at, GpuFrame { frame, ..GpuFrame::default() });
            if self.frames.len() > GPU_LANE_FRAMES_MAX {
                self.frames.pop_front();
                return self.frames.get_mut(at.saturating_sub(1));
            }
        }
        self.frames.get_mut(at)
    }

    /// Record frame `frame`'s whole GPU time; a value that is not finite or is negative is left out.
    pub fn record_frame(&mut self, frame: u64, ms: f64) {
        if !valid_ms(ms) {
            return;
        }
        if let Some(kept) = self.frame_mut(frame) {
            kept.frame_ms = Some(ms);
        }
    }

    /// Record per-node samples, appended to their frames in the order given (the schedule's). A
    /// sample whose node is not a name, whose time is not finite, or past
    /// [`PROFILE_GPU_NODES_MAX`] in its frame is left out and counted.
    pub fn record_nodes(&mut self, samples: &[GpuNodeSample]) {
        for sample in samples {
            let admitted = is_scope_name(sample.node) && valid_ms(sample.ms);
            let kept = if admitted { self.frame_mut(sample.frame) } else { None };
            match kept {
                Some(frame) if frame.nodes.len() < PROFILE_GPU_NODES_MAX => {
                    frame.nodes.push(GpuNodeTime { node: sample.node, ms: sample.ms });
                }
                _ => self.dropped_nodes = self.dropped_nodes.saturating_add(1),
            }
        }
    }

    /// Samples left out so far.
    pub fn dropped_nodes(&self) -> u64 {
        self.dropped_nodes
    }

    /// The kept frame `frame`.
    pub fn frame(&self, frame: u64) -> Option<&GpuFrame> {
        let at = self.frames.partition_point(|kept| kept.frame < frame);
        self.frames.get(at).filter(|kept| kept.frame == frame)
    }

    /// The kept frames, oldest first.
    pub fn frames(&self) -> impl Iterator<Item = &GpuFrame> {
        self.frames.iter()
    }

    /// Frame `frame`'s nodes laid out end to end from 0 ns, in schedule order (the port of
    /// wgpu-profiler's stream layout; see the module comment).
    pub fn spans(&self, frame: u64) -> Vec<GpuSpan> {
        let Some(kept) = self.frame(frame) else { return Vec::new() };
        let mut start_ns = 0i64;
        kept.nodes
            .iter()
            .map(|node| {
                let end_ns = start_ns.saturating_add((node.ms * NS_PER_MS).round() as i64);
                let span = GpuSpan { node: node.node, start_ns, end_ns, depth: 0 };
                start_ns = end_ns;
                span
            })
            .collect()
    }

    /// GPU frame time over the newest [`SUMMARY_WINDOW_FRAMES`] frames that have one; None when
    /// none has, or the device has no GPU time.
    pub fn summary(&self) -> Option<GpuSummary> {
        if self.source == GpuTimeSource::None {
            return None;
        }
        let times: Vec<i64> = self
            .frames
            .iter()
            .rev()
            .filter_map(|frame| frame.frame_ms)
            .take(SUMMARY_WINDOW_FRAMES)
            .map(|ms| (ms * US_PER_MS).round() as i64)
            .collect();
        if times.is_empty() {
            return None;
        }
        let at = |percentile: f64| nearest_rank(&times, percentile) as f64 / US_PER_MS;
        Some(GpuSummary { p50: at(50.0), p95: at(95.0), source: self.source })
    }

    /// Put the GPU row and the per-node state into `summary`.
    pub fn fill(&self, summary: &mut ProfileSummary) {
        summary.gpu = self.summary();
        summary.nodes = self.nodes;
    }
}

/// Whether `ms` is a time: finite and not negative.
fn valid_ms(ms: f64) -> bool {
    ms.is_finite() && ms >= 0.0
}
