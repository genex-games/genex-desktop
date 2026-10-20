//! The summary every frame puts in `state().volatile.profile` (outside the checksum): CPU frame
//! time and each scope's total time per frame as p50/p95 over the last [`SUMMARY_WINDOW_FRAMES`],
//! the [`PROFILE_TOP_SCOPES`] heaviest scopes by p95, counters, memory rows, hitches and what was
//! dropped. Its JSON is the host's `ProfileSummaryV1` (`src/shared/frame-profile.ts`) and never
//! passes [`PROFILE_SUMMARY_MAX_BYTES`]: counters, then memory rows, then top rows give way first.
//!
//! Percentiles are nearest-rank, as genex-render's frame timer computes them. A scope absent from
//! a frame counts 0 ms for that frame, so a scope's p95 is its cost per frame, not per call.

use std::collections::BTreeMap;

use serde::{Serialize, Serializer};

use crate::caps::{PROFILE_SUMMARY_MAX_BYTES, PROFILE_TOP_SCOPES, SUMMARY_WINDOW_FRAMES};
use crate::counters::Counters;
use crate::scope::{EngineScope, ScopeKey};

/// The summary's format number (its `v`).
pub const PROFILE_SUMMARY_VERSION: u32 = 1;
/// Nanoseconds per millisecond.
const NS_PER_MS: f64 = 1_000_000.0;
/// Milliseconds keep three decimals (one microsecond) in the JSON.
const MS_DECIMALS: f64 = 1_000.0;

/// What one recorded frame adds to the summary's window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameStat {
    /// The profiler's frame index.
    pub index: u64,
    /// The main thread's top-level scopes, added up: the frame's CPU time.
    pub cpu_ns: i64,
    /// Each named scope's total time in the frame, every thread and call added up.
    pub scopes: Vec<(ScopeKey, i64)>,
}

/// Where the GPU numbers come from. Wire values: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GpuTimeSource {
    /// Timestamp queries.
    Timestamps,
    /// Timestamps a browser rounds (Chrome: about 100 µs).
    TimestampsQuantized,
    /// Submit-to-done latency, on a device with no timestamps.
    SubmitLatency,
    /// No GPU time.
    None,
}

impl GpuTimeSource {
    /// Every source, in declaration order.
    pub const ALL: &'static [GpuTimeSource] = &[
        GpuTimeSource::Timestamps,
        GpuTimeSource::TimestampsQuantized,
        GpuTimeSource::SubmitLatency,
        GpuTimeSource::None,
    ];

    /// The source's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            GpuTimeSource::Timestamps => "timestamps",
            GpuTimeSource::TimestampsQuantized => "timestamps-quantized",
            GpuTimeSource::SubmitLatency => "submit-latency",
            GpuTimeSource::None => "none",
        }
    }

    /// The source spelled `text`, or None.
    pub fn from_wire(text: &str) -> Option<GpuTimeSource> {
        GpuTimeSource::ALL.iter().copied().find(|source| source.wire() == text)
    }
}

impl Serialize for GpuTimeSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire())
    }
}

/// Whether per-node GPU timing is armed. Wire values: never rename one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum NodeTiming {
    /// Whole-frame GPU timing only (the default).
    #[default]
    Off,
    /// Per-node brackets.
    Armed,
}

impl NodeTiming {
    /// Every state, in declaration order.
    pub const ALL: &'static [NodeTiming] = &[NodeTiming::Off, NodeTiming::Armed];

    /// The state's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            NodeTiming::Off => "off",
            NodeTiming::Armed => "armed",
        }
    }

    /// The state spelled `text`, or None.
    pub fn from_wire(text: &str) -> Option<NodeTiming> {
        NodeTiming::ALL.iter().copied().find(|state| state.wire() == text)
    }
}

impl Serialize for NodeTiming {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.wire())
    }
}

/// A distribution in milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Percentiles {
    /// The median.
    pub p50: f64,
    /// The 95th percentile.
    pub p95: f64,
}

/// GPU frame time and where it comes from (filled by the GPU lane).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct GpuSummary {
    /// The median, in milliseconds.
    pub p50: f64,
    /// The 95th percentile, in milliseconds.
    pub p95: f64,
    /// Where the numbers come from.
    pub source: GpuTimeSource,
}

/// One of the heaviest scopes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct TopScope {
    /// The engine stage's wire spelling or the game's name.
    pub scope: &'static str,
    /// Whether a game named it.
    pub game: bool,
    /// Its time per frame at the 95th percentile, in milliseconds.
    pub p95: f64,
}

/// One memory row: a GPU budget kind, a CPU memory class or a process measure, in bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MemoryRow {
    /// The class's wire spelling.
    pub class: String,
    /// Bytes in use.
    pub bytes: u64,
    /// The class's budget, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<u64>,
}

/// How many hitches the run had and the newest one's frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct HitchCount {
    /// Hitches so far.
    pub count: u64,
    /// The newest hitch's frame index.
    pub last: Option<u64>,
}

/// What the caps dropped, counted since the run began.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Dropped {
    /// Scope instances past the game-name cap or the id table.
    pub scopes: u64,
    /// Counter sets past the name cap, not finite, or cut to fit the summary.
    pub counters: u64,
    /// Thread reports that found their queue busy or full.
    pub frames: u64,
}

/// `state().volatile.profile`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProfileSummary {
    /// The format number, [`PROFILE_SUMMARY_VERSION`].
    pub v: u32,
    /// Whether scopes are recorded.
    pub on: bool,
    /// How many frames the percentiles cover.
    pub frames: usize,
    /// CPU frame time.
    pub cpu: Percentiles,
    /// GPU frame time, when the GPU lane has any.
    pub gpu: Option<GpuSummary>,
    /// The heaviest scopes by p95, heaviest first.
    pub top: Vec<TopScope>,
    /// Every counter's last value, by name.
    pub counters: BTreeMap<&'static str, f64>,
    /// Memory rows.
    pub memory: Vec<MemoryRow>,
    /// Hitches.
    pub hitches: HitchCount,
    /// Whether per-node GPU timing is armed.
    pub nodes: NodeTiming,
    /// What the caps dropped.
    pub dropped: Dropped,
}

impl ProfileSummary {
    /// The summary of `window` (oldest first; only its newest [`SUMMARY_WINDOW_FRAMES`] count),
    /// with the counters and drop counts as they stand. GPU, memory and hitches start empty.
    pub fn of_window(window: &[FrameStat], on: bool, counters: &Counters, dropped: Dropped) -> ProfileSummary {
        let window = &window[window.len().saturating_sub(SUMMARY_WINDOW_FRAMES)..];
        let cpu: Vec<i64> = window.iter().map(|frame| frame.cpu_ns).collect();
        ProfileSummary {
            v: PROFILE_SUMMARY_VERSION,
            on,
            frames: window.len(),
            cpu: percentiles(&cpu),
            gpu: None,
            top: top_scopes(window),
            counters: counters.values().clone(),
            memory: Vec::new(),
            hitches: HitchCount::default(),
            nodes: NodeTiming::Off,
            dropped: Dropped { counters: dropped.counters.saturating_add(counters.dropped()), ..dropped },
        }
    }

    /// The summary as JSON, at most [`PROFILE_SUMMARY_MAX_BYTES`]: past it, counters (the last
    /// by name first, each counted as dropped), then memory rows, then top rows are left out.
    pub fn to_json(&self) -> Vec<u8> {
        let mut fitted = self.clone();
        loop {
            let json = serde_json::to_vec(&fitted).unwrap_or_default();
            if json.len() <= PROFILE_SUMMARY_MAX_BYTES || !fitted.give_way() {
                return json;
            }
        }
    }

    /// Leave out one row to make room; false when nothing is left to leave out.
    fn give_way(&mut self) -> bool {
        if self.counters.pop_last().is_some() {
            self.dropped.counters = self.dropped.counters.saturating_add(1);
            return true;
        }
        self.memory.pop().is_some() || self.top.pop().is_some()
    }
}

/// The nearest-rank `percentile` (0..=100) of `values`; 0 for none.
pub fn nearest_rank(values: &[i64], percentile: f64) -> i64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = ((percentile.clamp(0.0, 100.0) / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

/// Nanoseconds as milliseconds with three decimals.
pub fn ms(ns: i64) -> f64 {
    (ns as f64 / NS_PER_MS * MS_DECIMALS).round() / MS_DECIMALS
}

fn percentiles(values: &[i64]) -> Percentiles {
    Percentiles { p50: ms(nearest_rank(values, 50.0)), p95: ms(nearest_rank(values, 95.0)) }
}

/// The heaviest scopes by p95 of their per-frame total (absent frames count 0), the whole-frame
/// scope left out, ties broken by key (engine stages in vocabulary order, then game names);
/// scopes with a p95 of 0 are not listed.
fn top_scopes(window: &[FrameStat]) -> Vec<TopScope> {
    let mut totals: BTreeMap<ScopeKey, Vec<i64>> = BTreeMap::new();
    for (at, frame) in window.iter().enumerate() {
        for (key, ns) in &frame.scopes {
            let per_frame = totals.entry(*key).or_insert_with(|| vec![0; window.len()]);
            per_frame[at] = per_frame[at].saturating_add(*ns);
        }
    }
    let mut rows: Vec<(i64, ScopeKey)> = totals
        .into_iter()
        .filter(|(key, _)| *key != ScopeKey::Engine(EngineScope::Frame))
        .map(|(key, per_frame)| (nearest_rank(&per_frame, 95.0), key))
        .filter(|(p95, _)| *p95 > 0)
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    rows.into_iter()
        .take(PROFILE_TOP_SCOPES)
        .map(|(p95, key)| TopScope { scope: key.name(), game: key.is_game(), p95: ms(p95) })
        .collect()
}
