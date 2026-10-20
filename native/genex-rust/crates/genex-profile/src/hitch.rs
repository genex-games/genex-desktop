//! Hitches: frames that took visibly longer than the run's own normal, each typed by its cause.
//!
//! - `cpu`: the frame's CPU time passed `max(HITCH_FACTOR x median, budget x HITCH_BUDGET_FACTOR)`.
//! - `gpu`: its GPU time passed the same line drawn over GPU times. GPU numbers arrive two or three
//!   frames late (the timer's readback ring), so a GPU time attaches to its own frame index: a
//!   pacing hitch on that frame is retyped `gpu`, never counted twice.
//! - `pacing`: CPU and GPU were normal and only the interval passed `HITCH_PACING_FACTOR x` the
//!   target interval: the compositor or the OS, not the game.
//!
//! Nothing is a hitch during the first [`HITCH_MIN_FRAMES`] frames (shader compiles, first
//! uploads). The newest [`ProfileCaps::hitch_records`] hitches are kept (16, 8 on a phone), each
//! with the frame's heaviest scopes; the count covers the whole run.

use std::collections::VecDeque;

use serde::{Serialize, Serializer};

use crate::caps::{PROFILE_TOP_SCOPES, ProfileCaps, SUMMARY_WINDOW_FRAMES};
use crate::scope::{EngineScope, ScopeKey};
use crate::summary::{FrameStat, HitchCount, ProfileSummary, nearest_rank};

/// A frame whose time passes this many medians is a hitch.
pub const HITCH_FACTOR: f64 = 2.0;
/// The line never sits under this many frame budgets.
pub const HITCH_BUDGET_FACTOR: f64 = 1.5;
/// A frame whose interval passes this many target intervals, with normal CPU and GPU, is pacing.
pub const HITCH_PACING_FACTOR: f64 = 2.5;
/// Frames of warm-up before any hitch.
pub const HITCH_MIN_FRAMES: usize = 30;
/// How many closed frames remember their scopes for a GPU time that arrives late: the timer's
/// readback ring is three deep, so eight leaves room.
const LATE_GPU_FRAMES: usize = 8;
/// Microseconds per millisecond, and nanoseconds per microsecond.
const US_PER_MS: f64 = 1_000.0;
const NS_PER_US: f64 = 1_000.0;

/// Why a frame is a hitch. Wire values: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HitchCause {
    /// Its CPU work.
    Cpu,
    /// Its GPU work.
    Gpu,
    /// Only its interval (the compositor or the OS).
    Pacing,
}

impl HitchCause {
    /// Every cause, in declaration order.
    pub const ALL: &'static [HitchCause] = &[HitchCause::Cpu, HitchCause::Gpu, HitchCause::Pacing];

    /// The cause's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            HitchCause::Cpu => "cpu",
            HitchCause::Gpu => "gpu",
            HitchCause::Pacing => "pacing",
        }
    }

    /// The cause spelled `text`, or None.
    pub fn from_wire(text: &str) -> Option<HitchCause> {
        HitchCause::ALL.iter().copied().find(|cause| cause.wire() == text)
    }
}

impl Serialize for HitchCause {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire())
    }
}

/// One of a hitch frame's heaviest scopes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct HitchScope {
    /// The engine stage's wire spelling or the game's name.
    pub scope: &'static str,
    /// Its time in the frame, in microseconds.
    pub us: f64,
}

/// A kept hitch: its frame, why, the line it crossed and its heaviest scopes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hitch {
    /// The profiler's frame index.
    pub frame: u64,
    /// Why it is a hitch.
    pub cause: HitchCause,
    /// The line it crossed, in milliseconds.
    pub threshold_ms: f64,
    /// Its heaviest scopes, heaviest first (at most [`PROFILE_TOP_SCOPES`]).
    pub top: Vec<HitchScope>,
}

/// A closed frame a late GPU time may still attach to.
struct ClosedFrame {
    frame: u64,
    top: Vec<HitchScope>,
}

/// Times over the last [`SUMMARY_WINDOW_FRAMES`] frames (whole microseconds, so the median is
/// exact), and how many were ever seen.
#[derive(Default)]
struct Window {
    times_us: VecDeque<i64>,
    seen: usize,
}

impl Window {
    fn warm(&self) -> bool {
        self.seen >= HITCH_MIN_FRAMES
    }

    fn median_ms(&self) -> f64 {
        let values: Vec<i64> = self.times_us.iter().copied().collect();
        nearest_rank(&values, 50.0) as f64 / US_PER_MS
    }

    fn push(&mut self, ms: f64) {
        if self.times_us.len() == SUMMARY_WINDOW_FRAMES {
            self.times_us.pop_front();
        }
        self.times_us.push_back((ms * US_PER_MS).round() as i64);
        self.seen = self.seen.saturating_add(1);
    }
}

/// Finds a run's hitches. Fed once per closed frame ([`HitchDetector::observe_frame`]) and once
/// per GPU frame time ([`HitchDetector::observe_gpu`]), the GPU times in any order.
pub struct HitchDetector {
    budget_ms: f64,
    records_max: usize,
    cpu: Window,
    gpu: Window,
    closed: VecDeque<ClosedFrame>,
    /// Kept hitches, by frame index.
    kept: VecDeque<Hitch>,
    count: u64,
}

impl HitchDetector {
    /// A detector keeping `caps.hitch_records` hitches, for a frame budget (and target interval)
    /// of `budget_ms`.
    pub fn new(caps: ProfileCaps, budget_ms: f32) -> HitchDetector {
        HitchDetector {
            budget_ms: f64::from(budget_ms),
            records_max: caps.hitch_records,
            cpu: Window::default(),
            gpu: Window::default(),
            closed: VecDeque::with_capacity(LATE_GPU_FRAMES),
            kept: VecDeque::new(),
            count: 0,
        }
    }

    /// The line a time crosses to be a hitch, given its window's median (to the microsecond).
    fn line(&self, window: &Window) -> f64 {
        let line = (HITCH_FACTOR * window.median_ms()).max(self.budget_ms * HITCH_BUDGET_FACTOR);
        to_microsecond(line)
    }

    /// Close a frame: its CPU time and heaviest scopes come from `stat`, and `interval_ms` is the
    /// time since the previous frame began. Answers the hitch's cause when the frame is one.
    pub fn observe_frame(&mut self, stat: &FrameStat, interval_ms: f64) -> Option<HitchCause> {
        let cpu_ms = stat.cpu_ns as f64 / (US_PER_MS * NS_PER_US);
        let top = heaviest(stat);
        let warm = self.cpu.warm();
        let cpu_line = self.line(&self.cpu);
        let pacing_line = to_microsecond(self.budget_ms * HITCH_PACING_FACTOR);
        self.cpu.push(cpu_ms);
        if self.closed.len() == LATE_GPU_FRAMES {
            self.closed.pop_front();
        }
        self.closed.push_back(ClosedFrame { frame: stat.index, top: top.clone() });
        if !warm {
            return None;
        }
        let (cause, threshold_ms) = if cpu_ms > cpu_line {
            (HitchCause::Cpu, cpu_line)
        } else if interval_ms > pacing_line {
            (HitchCause::Pacing, pacing_line)
        } else {
            return None;
        };
        self.keep(Hitch { frame: stat.index, cause, threshold_ms, top });
        Some(cause)
    }

    /// Attach frame `frame`'s GPU time, however late it arrives. Answers `gpu` when the frame is a
    /// GPU hitch, new or retyped from pacing; a CPU hitch keeps its cause.
    pub fn observe_gpu(&mut self, frame: u64, gpu_ms: f64) -> Option<HitchCause> {
        let warm = self.gpu.warm();
        let line = self.line(&self.gpu);
        self.gpu.push(gpu_ms);
        if !warm || gpu_ms <= line {
            return None;
        }
        if let Some(kept) = self.kept.iter_mut().find(|hitch| hitch.frame == frame) {
            if kept.cause != HitchCause::Pacing {
                return None;
            }
            kept.cause = HitchCause::Gpu;
            kept.threshold_ms = line;
            return Some(HitchCause::Gpu);
        }
        let top = self.closed.iter().rev().find(|closed| closed.frame == frame).map(|closed| closed.top.clone());
        self.keep(Hitch { frame, cause: HitchCause::Gpu, threshold_ms: line, top: top.unwrap_or_default() });
        Some(HitchCause::Gpu)
    }

    /// Keep `hitch` in frame order, the oldest leaving past the cap.
    fn keep(&mut self, hitch: Hitch) {
        self.count = self.count.saturating_add(1);
        let at = self.kept.partition_point(|kept| kept.frame <= hitch.frame);
        self.kept.insert(at, hitch);
        while self.kept.len() > self.records_max {
            self.kept.pop_front();
        }
    }

    /// The kept hitches, oldest frame first.
    pub fn hitches(&self) -> impl Iterator<Item = &Hitch> {
        self.kept.iter()
    }

    /// Every hitch of the run, kept or not.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// The summary's hitch row: the count and the newest kept hitch's frame.
    pub fn summary(&self) -> HitchCount {
        HitchCount { count: self.count, last: self.kept.back().map(|hitch| hitch.frame) }
    }

    /// Put the hitch row into `summary`.
    pub fn fill(&self, summary: &mut ProfileSummary) {
        summary.hitches = self.summary();
    }
}

/// `ms` rounded to the microsecond, as every millisecond the profiler writes.
fn to_microsecond(ms: f64) -> f64 {
    (ms * US_PER_MS).round() / US_PER_MS
}

/// A frame's heaviest scopes, the whole-frame scope left out, ties by key.
fn heaviest(stat: &FrameStat) -> Vec<HitchScope> {
    let mut rows: Vec<(i64, ScopeKey)> = stat
        .scopes
        .iter()
        .filter(|(key, ns)| *key != ScopeKey::Engine(EngineScope::Frame) && *ns > 0)
        .map(|(key, ns)| (*ns, *key))
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    rows.into_iter()
        .take(PROFILE_TOP_SCOPES)
        .map(|(ns, key)| HitchScope { scope: key.name(), us: (ns as f64 / NS_PER_US).round() })
        .collect()
}
