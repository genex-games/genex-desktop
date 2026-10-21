//! Profiling (`genex::profile`, G6 PROFILE over genex-profile): a game times its own blocks with
//! [`crate::profile_scope!`] and reports a number per frame with [`counter`]; both are write-only,
//! so nothing a tick computes depends on whether scopes are on. The runtime times each tick
//! ([`EngineScope::Tick`]); a shell that profiles (a studio run: scopes on, Live's default) starts
//! the recorder ([`State::start`]) and closes one frame per Live frame ([`State::new_frame`]),
//! which `state().volatile.profile` then summarizes (`v`, `on`, `frames`, `cpu`, `gpu`, `top`,
//! `counters`, `memory`, `hitches`, `nodes`, `dropped`; at most 4 KiB). A run whose shell never
//! started the recorder has no `volatile.profile`, so its `state()` is unchanged, and every
//! checksum is the same with scopes on, off or never started (`volatile` is never checksummed).
//! The dev `profile` verb reads the summary, a `ProfileReport` v2, arms per-node GPU timing and
//! writes a Chrome trace ([`State::report_json`], [`State::trace_json`], [`State::arm`]).

use std::cell::RefCell;

use genex_core::json::Value as CoreValue;
use genex_profile::caps::CapsClass;
use genex_profile::{GpuLane, HitchDetector, ProfileReport, Profiler, ProfilerConfig, ReportMeta};

/// A name a game gives a scope or a counter: 1..=48 bytes of `a-z`, `0-9`, `_`, `.`, `-`, checked
/// when the game compiles. The runtime's own stages ([`EngineScope`]) and an open scope's guard.
pub use genex_profile::{EngineScope, ScopeGuard, ScopeName};
/// Where `volatile.profile.gpu` comes from, and whether per-node GPU timing is armed (`nodes`).
pub use genex_profile::{GpuTimeSource, NodeTiming};
/// Host glue: one armed frame's per-node GPU sample.
#[doc(hidden)]
pub use genex_profile::GpuNodeSample;

/// The calls the profiling page teaches, in its order (the vocabulary fixture's `profile.calls`).
pub const PROFILE_CALLS: [&str; 3] = ["genex::profile_scope!", "genex::profile::counter", "ScopeName::new"];
/// `state().volatile.profile`'s members, in the order they are written.
pub const SUMMARY_FIELDS: [&str; 11] = ["v", "on", "frames", "cpu", "gpu", "top", "counters", "memory", "hitches", "nodes", "dropped"];

/// The key `state().volatile.profile` is reported under.
pub const VOLATILE_PROFILE_KEY: &str = "profile";
/// The frames between two copies of the summary into the crash context (a record carries the
/// last one; serializing it every frame would cost more than the frame's scopes).
const CRASH_SUMMARY_EVERY_FRAMES: u64 = 30;
/// The frames an armed per-node GPU timing stays armed (`PROFILE_ARM_MAX_FRAMES`).
pub const PROFILE_ARM_MAX_FRAMES: u64 = 1_800;

/// Report `value` under `name` for this frame (a game monitor such as live enemies). Display
/// only: it lands in `state().volatile.profile.counters`, never in the checksum; at most 64 names.
pub fn counter(name: ScopeName, value: f64) {
    genex_profile::counter(name, value);
}

/// Time the rest of the enclosing block as the engine stage `stage` (host glue: a shell's frame,
/// draw and present). Nothing is recorded on a thread whose shell has not started the recorder.
#[doc(hidden)]
pub fn engine_scope(stage: EngineScope) -> ScopeGuard {
    genex_profile::scope(stage)
}

thread_local! {
    /// The tick being timed on this thread: opened at the tick's start, closed at its end. Kept
    /// here, not in the runtime, because a scope guard never leaves its thread.
    static TICK: RefCell<Option<ScopeGuard>> = const { RefCell::new(None) };
}

/// The caps class of the destination this build runs on.
fn caps_class() -> CapsClass {
    if cfg!(target_arch = "wasm32") {
        CapsClass::Web
    } else if cfg!(any(target_os = "ios", target_os = "android")) {
        CapsClass::Phone
    } else {
        CapsClass::Desktop
    }
}

/// What a started recorder keeps: the scope recorder, the GPU lane, the hitches and how long
/// per-node timing stays armed.
struct Recorder {
    profiler: Profiler,
    gpu: GpuLane,
    hitches: HitchDetector,
    /// The frame index per-node timing is armed until (exclusive); None while off.
    armed_until: Option<u64>,
}

/// The runtime's frame recorder (host glue: a shell starts it and closes its frames); display
/// state, never in the checksum.
#[doc(hidden)]
#[derive(Default)]
pub struct State {
    recorder: Option<Recorder>,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State").field("started", &self.recorder.is_some()).finish()
    }
}

impl State {
    /// Start recording on the calling thread (the one that ticks), scopes `on` or off; a second
    /// start keeps the recorder and only switches its scopes.
    pub fn start(&mut self, on: bool) {
        if let Some(recorder) = &self.recorder {
            recorder.profiler.set_on(on);
            return;
        }
        let config = ProfilerConfig::new(caps_class());
        let profiler = Profiler::new(config);
        profiler.set_on(on);
        let hitches = HitchDetector::new(config.caps, config.budget_ms);
        self.recorder = Some(Recorder { profiler, gpu: GpuLane::new(GpuTimeSource::None), hitches, armed_until: None });
    }

    /// Whether a shell started the recorder.
    pub fn started(&self) -> bool {
        self.recorder.is_some()
    }

    /// Where the GPU frame times come from (the presenter's timer: timestamps, or none).
    pub fn set_gpu_source(&mut self, source: GpuTimeSource) {
        let Some(recorder) = &mut self.recorder else { return };
        if recorder.gpu.source() == source {
            return;
        }
        let nodes = if recorder.armed_until.is_some() { NodeTiming::Armed } else { NodeTiming::Off };
        recorder.gpu = GpuLane::new(source);
        recorder.gpu.set_nodes(nodes);
    }

    /// The index the next [`State::new_frame`] closes (what per-node samples of this frame are
    /// keyed to); 0 before a start.
    pub fn frame_index(&self) -> u64 {
        self.recorder.as_ref().map_or(0, |recorder| recorder.profiler.frame_index())
    }

    /// Close a frame (a shell, after the frame's scope closed): `interval_ms` since the previous
    /// frame began, and the GPU time that landed for a frame (`gpu`: its index and milliseconds).
    /// Hitches are judged here; every few frames the summary is copied into the crash context.
    /// Nothing before a start.
    pub fn new_frame(&mut self, interval_ms: f64, gpu: Option<(u64, f64)>) {
        let Some(recorder) = &mut self.recorder else { return };
        let index = recorder.profiler.frame_index();
        recorder.profiler.new_frame();
        if let Some(stat) = recorder.profiler.window().last().filter(|stat| stat.index == index).cloned() {
            recorder.hitches.observe_frame(&stat, interval_ms);
        }
        if let Some((frame, ms)) = gpu {
            recorder.gpu.record_frame(frame, ms);
            recorder.hitches.observe_gpu(frame, ms);
        }
        if recorder.armed_until.is_some_and(|until| index + 1 >= until) {
            recorder.armed_until = None;
            recorder.gpu.set_nodes(NodeTiming::Off);
        }
        crate::crash::frame_closed(index);
        if index.is_multiple_of(CRASH_SUMMARY_EVERY_FRAMES)
            && let Some(json) = self.summary_json()
        {
            crate::crash::profile_summary(&json);
        }
    }

    /// Record per-node GPU samples that landed (an armed frame's graph steps, schedule order).
    pub fn record_nodes(&mut self, samples: &[GpuNodeSample]) {
        if let Some(recorder) = &mut self.recorder {
            recorder.gpu.record_nodes(samples);
        }
    }

    /// Arm per-node GPU timing (`nodes`) for at most [`PROFILE_ARM_MAX_FRAMES`] frames, or go back
    /// to the whole frame; answers the mode in force. Nothing before a start.
    pub fn arm(&mut self, nodes: bool) -> NodeTiming {
        let Some(recorder) = &mut self.recorder else { return NodeTiming::Off };
        let until = recorder.profiler.frame_index() + PROFILE_ARM_MAX_FRAMES;
        recorder.armed_until = nodes.then_some(until);
        let mode = if nodes { NodeTiming::Armed } else { NodeTiming::Off };
        recorder.gpu.set_nodes(mode);
        mode
    }

    /// Whether per-node GPU timing is armed.
    pub fn armed(&self) -> bool {
        self.recorder.as_ref().is_some_and(|recorder| recorder.armed_until.is_some())
    }

    /// `state().volatile.profile` as JSON (at most 4 KiB); None before a start.
    pub fn summary_json(&self) -> Option<Vec<u8>> {
        let recorder = self.recorder.as_ref()?;
        let mut summary = recorder.profiler.summary();
        recorder.gpu.fill(&mut summary);
        recorder.hitches.fill(&mut summary);
        Some(summary.to_json())
    }

    /// The `ProfileReport` v2 of the last `frames` frames for `destination` on `device_class`.
    fn report(&self, frames: usize, destination: &str, device_class: &str) -> Option<ProfileReport> {
        let recorder = self.recorder.as_ref()?;
        let meta = ReportMeta::new(destination, device_class).with_gpu(&recorder.gpu).with_hitches(&recorder.hitches);
        Some(ProfileReport::build(&recorder.profiler, meta, frames))
    }

    /// The report as JSON (at most 256 KiB); None before a start.
    pub fn report_json(&self, frames: usize, destination: &str, device_class: &str) -> Option<Vec<u8>> {
        self.report(frames, destination, device_class).map(|report| report.to_json())
    }

    /// The report's frames as a Chrome trace; None before a start.
    pub fn trace_json(&self, frames: usize, destination: &str, device_class: &str) -> Option<Vec<u8>> {
        self.report(frames, destination, device_class).map(|report| genex_profile::chrome_trace(&report))
    }

    /// At the start of a tick: open the tick's scope on this thread.
    pub(crate) fn frame_begin(&mut self, _tick: u64) {
        let guard = genex_profile::scope(EngineScope::Tick);
        if guard.is_recording() {
            let _ = TICK.try_with(|slot| slot.replace(Some(guard)));
        }
    }

    /// At the end of a tick: close the tick's scope.
    pub(crate) fn frame_end(&mut self, _tick: u64) {
        let _ = TICK.try_with(|slot| slot.take());
    }

    /// `state().volatile.profile`, once a shell started the recorder.
    pub(crate) fn volatile_key(&self, state: &mut CoreValue) {
        let Some(json) = self.summary_json() else { return };
        let Ok(summary) = genex_core::json::parse(&json) else { return };
        let mut volatile = state[genex_core::session::VOLATILE_KEY].clone();
        volatile.set(VOLATILE_PROFILE_KEY, summary);
        state.set(genex_core::session::VOLATILE_KEY, volatile);
    }
}
