//! The recorder: puffin's per-thread scope streams, collected without ever waiting on a lock.
//!
//! puffin hands a thread's finished scopes to a reporter. Its default reporter locks the global
//! profiler (parking_lot), which a browser's main thread may never wait on (`Atomics.wait`
//! throws there). So every attached thread reports through this module's reporter instead: the
//! main thread into its own queue, workers into a shared one, each with `try_lock` only. A report
//! that finds its queue busy or full is dropped and counted (`dropped.frames`); nothing blocks.
//! [`Profiler::new_frame`] drains both queues into one puffin [`FrameData`], keeps the recent and
//! slowest frames under the device class's caps ([`ProfileCaps`]) and adds the frame to the
//! summary's window.
//!
//! The clock is injected ([`ProfilerConfig::clock`]): tests time synthetic frames exactly, and a
//! browser build reads `performance.now()` through puffin's `web` feature.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};

use puffin::{FrameData, Reader, ScopeDetails, Stream, StreamInfo, StreamInfoRef, ThreadInfo, ThreadProfiler};

use crate::caps::{CapsClass, PROFILE_GAME_SCOPES_MAX, ProfileCaps, REPORT_QUEUE_MAX, SUMMARY_WINDOW_FRAMES};
use crate::counters::Counters;
use crate::scope::{self, ScopeKey, ScopeName};
use crate::summary::{Dropped, FrameStat, ProfileSummary};

/// The frame budget a run starts with (60 Hz), in milliseconds.
const DEFAULT_BUDGET_MS: f32 = 1000.0 / 60.0;

/// A nanosecond clock: puffin's time source, injected per profiler.
pub type Clock = fn() -> i64;

/// The real clock: puffin's monotonic nanoseconds (`performance.now()` in a browser).
#[cfg(any(not(target_arch = "wasm32"), feature = "web"))]
pub fn default_clock() -> i64 {
    puffin::now_ns()
}

/// Without the `web` feature a wasm32 build has no clock: every scope reads 0 ns, so a browser
/// build turns `web` on or injects its own [`Clock`].
#[cfg(all(target_arch = "wasm32", not(feature = "web")))]
pub fn default_clock() -> i64 {
    0
}

/// How a profiler is set up.
#[derive(Clone, Copy, Debug)]
pub struct ProfilerConfig {
    /// What it keeps.
    pub caps: ProfileCaps,
    /// The frame budget, in milliseconds (the hitch rule's floor).
    pub budget_ms: f32,
    /// Its clock.
    pub clock: Clock,
}

impl ProfilerConfig {
    /// The caps of `class`, a 60 Hz budget and the real clock.
    pub fn new(class: CapsClass) -> ProfilerConfig {
        ProfilerConfig { caps: ProfileCaps::for_class(class), budget_ms: DEFAULT_BUDGET_MS, clock: default_clock }
    }

    /// The same, timed by `clock`.
    pub fn with_clock(self, clock: Clock) -> ProfilerConfig {
        ProfilerConfig { clock, ..self }
    }
}

/// One thread's finished scopes, as puffin reported them.
struct Report {
    thread: ThreadInfo,
    stream: StreamInfo,
}

/// What a profiler shares with the threads that report to it.
struct Shared {
    on: AtomicBool,
    clock: Clock,
    main: Mutex<Vec<Report>>,
    workers: Mutex<Vec<Report>>,
    counters: Mutex<Counters>,
    dropped_frames: AtomicU64,
    dropped_scopes: AtomicU64,
    dropped_counters: AtomicU64,
}

impl Shared {
    /// Queue `report` without waiting; a busy or full queue drops and counts it.
    fn push(&self, main: bool, report: Report) {
        let queue = if main { &self.main } else { &self.workers };
        match try_lock(queue) {
            Some(mut reports) if reports.len() < REPORT_QUEUE_MAX => reports.push(report),
            _ => {
                self.dropped_frames.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Set a counter without waiting; a busy lock drops and counts the set.
    fn set_counter(&self, name: ScopeName, value: f64) {
        match try_lock(&self.counters) {
            Some(mut counters) => {
                counters.set(name, value);
            }
            None => {
                self.dropped_counters.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// `mutex` locked if it is free now (a poisoned lock still holds plain data); None when busy.
fn try_lock<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

/// The profiler a thread reports to, and whether it is that profiler's main thread.
struct Lane {
    shared: Arc<Shared>,
    main: bool,
}

thread_local! {
    static LANE: RefCell<Option<Lane>> = const { RefCell::new(None) };
}

/// Run `f` with this thread's lane, if it has one (never during the thread's own teardown).
fn with_lane<R>(f: impl FnOnce(&Lane) -> R) -> Option<R> {
    LANE.try_with(|lane| lane.try_borrow().ok().and_then(|lane| lane.as_ref().map(f))).ok().flatten()
}

/// Whether scopes entered on this thread are recorded: it is attached and its profiler is on.
pub(crate) fn thread_records() -> bool {
    with_lane(|lane| lane.shared.on.load(Ordering::Relaxed)).unwrap_or(false)
}

/// Count a scope that was not recorded because its site has no name-table slot.
pub(crate) fn count_unnamed_scope() {
    with_lane(|lane| lane.shared.dropped_scopes.fetch_add(1, Ordering::Relaxed));
}

/// puffin's reporter for every attached thread: copy the stream into the lane's queue.
fn report(thread: ThreadInfo, _details: &[ScopeDetails], stream: &StreamInfoRef<'_>) {
    with_lane(|lane| {
        let mut copy = StreamInfo::default();
        copy.extend(stream);
        lane.shared.push(lane.main, Report { thread, stream: copy });
    });
}

/// Attach this thread to `lane`'s profiler, timed by its clock.
fn attach(lane: Lane) {
    ThreadProfiler::initialize(lane.shared.clock, report);
    let _ = LANE.try_with(|slot| *slot.borrow_mut() = Some(lane));
}

/// Stop this thread reporting to any profiler. Scopes entered on it afterwards record nothing.
pub fn detach_thread() {
    let _ = LANE.try_with(|slot| slot.borrow_mut().take());
}

/// Report `value` under `name` for the profiler this thread is attached to (display only, never
/// in the checksum). Nothing happens on a thread that is not attached.
pub fn counter(name: ScopeName, value: f64) {
    with_lane(|lane| lane.shared.set_counter(name, value));
}

/// A handle a worker thread attaches with, so its scopes report to the profiler (`try_lock` only).
#[derive(Clone)]
pub struct WorkerLane {
    shared: Arc<Shared>,
}

impl WorkerLane {
    /// Attach the calling thread as a worker of this lane's profiler.
    pub fn attach(&self) {
        attach(Lane { shared: Arc::clone(&self.shared), main: false });
    }
}

/// The recent and slowest frames kept whole, within the caps.
struct FrameStore {
    caps: ProfileCaps,
    /// Oldest first.
    recent: VecDeque<Arc<FrameData>>,
    /// The slowest frames by puffin's frame duration, unordered.
    slow: Vec<Arc<FrameData>>,
}

impl FrameStore {
    fn new(caps: ProfileCaps) -> FrameStore {
        FrameStore { caps, recent: VecDeque::new(), slow: Vec::new() }
    }

    fn add(&mut self, frame: Arc<FrameData>) {
        self.offer_slow(&frame);
        self.recent.push_back(frame);
        while self.recent.len() > self.caps.recent_frames {
            self.recent.pop_front();
        }
        while self.bytes() > self.caps.memory_max_bytes && self.recent.pop_front().is_some() {}
        while self.bytes() > self.caps.memory_max_bytes && self.drop_fastest_slow() {}
    }

    /// Keep `frame` among the slowest when there is room or it is slower than the fastest kept.
    fn offer_slow(&mut self, frame: &Arc<FrameData>) {
        if self.caps.slow_frames == 0 {
            return;
        }
        if self.slow.len() < self.caps.slow_frames {
            self.slow.push(Arc::clone(frame));
            return;
        }
        let fastest = self.slow.iter().enumerate().min_by_key(|(_, kept)| kept.duration_ns()).map(|(at, _)| at);
        if let Some(at) = fastest
            && frame.duration_ns() > self.slow[at].duration_ns()
        {
            self.slow[at] = Arc::clone(frame);
        }
    }

    fn drop_fastest_slow(&mut self) -> bool {
        let fastest = self.slow.iter().enumerate().min_by_key(|(_, kept)| kept.duration_ns()).map(|(at, _)| at);
        fastest.map(|at| self.slow.swap_remove(at)).is_some()
    }

    fn in_recent(&self, frame: &FrameData) -> bool {
        self.recent.binary_search_by_key(&frame.frame_index(), |kept| kept.frame_index()).is_ok()
    }

    /// Slow frames that are not also recent.
    fn slow_only(&self) -> impl Iterator<Item = &Arc<FrameData>> {
        self.slow.iter().filter(|frame| !self.in_recent(frame))
    }

    fn frames(&self) -> usize {
        self.recent.len() + self.slow_only().count()
    }

    fn bytes(&self) -> usize {
        let recent: usize = self.recent.iter().map(|frame| frame.bytes_of_ram_used()).sum();
        recent + self.slow_only().map(|frame| frame.bytes_of_ram_used()).sum::<usize>()
    }
}

/// A run's profiler. It attaches the thread that makes it as the main thread, which calls
/// [`Profiler::new_frame`] once per frame; worker threads attach through [`Profiler::worker`].
pub struct Profiler {
    shared: Arc<Shared>,
    config: ProfilerConfig,
    store: FrameStore,
    window: VecDeque<FrameStat>,
    next_index: u64,
    /// Game scope names admitted this run (at most [`PROFILE_GAME_SCOPES_MAX`]).
    admitted: BTreeSet<&'static str>,
    /// Game scope instances past the name cap.
    capped_scopes: u64,
    /// The counters as last read without waiting.
    counters: Counters,
}

impl Profiler {
    /// A profiler with scopes on, its main thread the calling thread.
    pub fn new(config: ProfilerConfig) -> Profiler {
        let shared = Arc::new(Shared {
            on: AtomicBool::new(true),
            clock: config.clock,
            main: Mutex::new(Vec::new()),
            workers: Mutex::new(Vec::new()),
            counters: Mutex::new(Counters::new()),
            dropped_frames: AtomicU64::new(0),
            dropped_scopes: AtomicU64::new(0),
            dropped_counters: AtomicU64::new(0),
        });
        attach(Lane { shared: Arc::clone(&shared), main: true });
        Profiler {
            shared,
            config,
            store: FrameStore::new(config.caps),
            window: VecDeque::with_capacity(SUMMARY_WINDOW_FRAMES),
            next_index: 0,
            admitted: BTreeSet::new(),
            capped_scopes: 0,
            counters: Counters::new(),
        }
    }

    /// The profiler's setup.
    pub fn config(&self) -> ProfilerConfig {
        self.config
    }

    /// A handle for worker threads to attach with.
    pub fn worker(&self) -> WorkerLane {
        WorkerLane { shared: Arc::clone(&self.shared) }
    }

    /// Turn scope recording on or off (counters and frames still advance).
    pub fn set_on(&self, on: bool) {
        self.shared.on.store(on, Ordering::Relaxed);
    }

    /// Whether scopes are recorded.
    pub fn is_on(&self) -> bool {
        self.shared.on.load(Ordering::Relaxed)
    }

    /// Report `value` under `name` (display only, never in the checksum).
    pub fn counter(&self, name: ScopeName, value: f64) {
        self.shared.set_counter(name, value);
    }

    /// Close the frame: drain every queued report into one frame, keep it within the caps and
    /// add it to the summary's window. A busy worker queue waits for the next frame, never blocks.
    pub fn new_frame(&mut self) {
        let index = self.next_index;
        self.next_index += 1;
        let mut reports: Vec<(bool, Report)> = Vec::new();
        for (main, queue) in [(true, &self.shared.main), (false, &self.shared.workers)] {
            if let Some(mut queued) = try_lock(queue) {
                reports.extend(queued.drain(..).map(|report| (main, report)));
            }
        }
        if let Some(counters) = try_lock(&self.shared.counters) {
            self.counters = counters.clone();
        }
        if !self.is_on() || reports.is_empty() {
            return;
        }
        let mut stat = FrameStat { index, cpu_ns: 0, scopes: Vec::new() };
        let mut totals: BTreeMap<ScopeKey, i64> = BTreeMap::new();
        let mut streams: BTreeMap<ThreadInfo, StreamInfo> = BTreeMap::new();
        for (main, report) in reports {
            self.walk(&report.stream.stream, main, &mut stat, &mut totals);
            streams.entry(report.thread).or_default().extend(&report.stream.as_stream_into_ref());
        }
        stat.scopes = totals.into_iter().collect();
        if let Ok(frame) = FrameData::new(index, streams, Vec::new(), false) {
            self.store.add(Arc::new(frame));
        }
        if self.window.len() == SUMMARY_WINDOW_FRAMES {
            self.window.pop_front();
        }
        self.window.push_back(stat);
    }

    /// Add up one stream: the main thread's top-level scopes are the frame's CPU time, and each
    /// named scope's calls are added to its total (game names past the cap are counted, not added).
    fn walk(&mut self, stream: &Stream, main: bool, stat: &mut FrameStat, totals: &mut BTreeMap<ScopeKey, i64>) {
        let mut pending: Vec<(u64, usize)> = vec![(0, 0)];
        while let Some((offset, depth)) = pending.pop() {
            let Ok(reader) = Reader::with_offset(stream, offset) else { continue };
            for parsed in reader {
                let Ok(found) = parsed else { break };
                let ns = found.record.duration_ns;
                if main && depth == 0 {
                    stat.cpu_ns = stat.cpu_ns.saturating_add(ns);
                }
                if let Some(key) = scope::key_of(found.id).filter(|key| self.admit(*key)) {
                    let total = totals.entry(key).or_insert(0);
                    *total = total.saturating_add(ns);
                }
                pending.push((found.child_begin_position, depth + 1));
            }
        }
    }

    /// Whether `key`'s time is kept: engine stages always, a game name while the run has seen
    /// fewer than [`PROFILE_GAME_SCOPES_MAX`] names (or has seen this one).
    fn admit(&mut self, key: ScopeKey) -> bool {
        let ScopeKey::Game(name) = key else { return true };
        let known = self.admitted.contains(name.as_str());
        if known || self.admitted.len() < PROFILE_GAME_SCOPES_MAX {
            self.admitted.insert(name.as_str());
            return true;
        }
        self.capped_scopes = self.capped_scopes.saturating_add(1);
        false
    }

    /// What the caps and busy locks dropped so far.
    pub fn dropped(&self) -> Dropped {
        let unnamed = self.shared.dropped_scopes.load(Ordering::Relaxed);
        Dropped {
            scopes: self.capped_scopes.saturating_add(unnamed),
            counters: self.shared.dropped_counters.load(Ordering::Relaxed),
            frames: self.shared.dropped_frames.load(Ordering::Relaxed),
        }
    }

    /// The summary of the last frames (`state().volatile.profile`).
    pub fn summary(&self) -> ProfileSummary {
        let window: Vec<FrameStat> = self.window.iter().cloned().collect();
        let fresh = try_lock(&self.shared.counters).map(|counters| counters.clone());
        let counters = fresh.as_ref().unwrap_or(&self.counters);
        ProfileSummary::of_window(&window, self.is_on(), counters, self.dropped())
    }

    /// The summary window's frames, oldest first.
    pub fn window(&self) -> impl Iterator<Item = &FrameStat> {
        self.window.iter()
    }

    /// The recent frames kept whole, oldest first.
    pub fn recent_frames(&self) -> impl Iterator<Item = &Arc<FrameData>> {
        self.store.recent.iter()
    }

    /// The slowest frames kept whole, oldest first.
    pub fn slowest_frames(&self) -> Vec<Arc<FrameData>> {
        let mut slow = self.store.slow.clone();
        slow.sort_by_key(|frame| frame.frame_index());
        slow
    }

    /// How many distinct frames are kept whole (recent and slow together).
    pub fn frames_kept(&self) -> usize {
        self.store.frames()
    }

    /// Puffin's byte count of the kept frames.
    pub fn bytes_kept(&self) -> usize {
        self.store.bytes()
    }

    /// The index the next [`Profiler::new_frame`] closes.
    pub fn frame_index(&self) -> u64 {
        self.next_index
    }
}

impl Drop for Profiler {
    /// Detach the calling thread when it reports to this profiler.
    fn drop(&mut self) {
        let ours = with_lane(|lane| Arc::ptr_eq(&lane.shared, &self.shared)).unwrap_or(false);
        if ours {
            detach_thread();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::scope::EngineScope;

    /// How long a worker may take to finish a scope while the queue is held: generous, since a
    /// blocked worker would never finish at all.
    const WORKER_DEADLINE: Duration = Duration::from_secs(10);

    #[test]
    fn a_held_report_queue_never_blocks_a_reporting_thread() {
        let mut profiler = Profiler::new(ProfilerConfig::new(CapsClass::Desktop));
        let lane = profiler.worker();
        let held = profiler.shared.workers.lock().expect("the worker queue locks");
        let (done, finished) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("profile-worker".into())
            .spawn(move || {
                lane.attach();
                {
                    let _physics = scope::scope(EngineScope::Physics);
                }
                done.send(()).expect("the test is listening");
            })
            .expect("the worker starts");
        let reported = finished.recv_timeout(WORKER_DEADLINE);
        drop(held);
        worker.join().expect("the worker ends");
        assert!(reported.is_ok(), "the worker finished its scope while the queue was held");
        profiler.new_frame();
        assert_eq!(profiler.summary().dropped.frames, 1, "the report that found the queue busy is counted");
    }
}
