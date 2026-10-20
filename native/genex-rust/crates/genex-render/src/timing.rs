//! Frame timing (plan §2.6): GPU timestamps where the renderer-owned `TIMESTAMP_QUERY` is
//! offered, CPU encode and submit time always, p50/p95 over a sliding window. Timings are
//! volatile: nothing a capture or the state checksum reads comes from here.
//!
//! - [`GpuTimer`] writes timestamps through pass `timestamp_writes` (WebGPU core has no
//!   encoder-level or in-pass timestamps). Live uses [`TimerMode::Frame`]: two timestamps per frame,
//!   the first pass's beginning and the last pass's end. The perf harness and dev builds use
//!   [`TimerMode::Nodes`]: a begin/end pair per graph node. In-pass nodes are costed by A/B
//!   whole-frame deltas instead (`TIMESTAMP_QUERY_INSIDE_PASSES` is native-only).
//! - Results go through a [`QUERY_RING_DEPTH`]-deep resolve/readback ring ([`QueryRing`]): a slot
//!   is resolved in a later frame's encoder once its sampling submission is done on the GPU, mapped
//!   asynchronously after that frame's submit, and recorded again only once the map landed and was
//!   unmapped. When every slot is busy the frame goes untimed: the ring never stalls, and on the
//!   web the browser lands the maps between frames.
//! - Without timestamps, [`SubmitLatency`] estimates GPU time from `on_submitted_work_done`
//!   (an injected clock: wasm has no `Instant`). It includes queueing, so it is reported as an
//!   estimate and never drives the dynamic-resolution GPU target.
//! - [`CpuTimer`] measures encode and submit time from injected instants, excluding swapchain
//!   acquire and present waits.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use wgpu::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoder, ComputePassTimestampWrites, Device, Features, MapMode, QUERY_RESOLVE_BUFFER_ALIGNMENT,
    QUERY_SET_MAX_QUERIES, QUERY_SIZE, QuerySet, QuerySetDescriptor, QueryType, Queue, RenderPassTimestampWrites,
};

/// Frames the sliding window holds.
pub const TIMING_WINDOW_FRAMES: usize = 120;
/// Frames of timestamps in flight at once (resolve/readback slots).
pub const QUERY_RING_DEPTH: usize = 3;
/// Most graph nodes [`TimerMode::Nodes`] times (2 queries each, per ring slot).
pub const MAX_TIMED_NODES: u16 = 256;
/// Submits [`SubmitLatency`] waits on at once before dropping the oldest (callbacks that never run).
pub const SUBMIT_LATENCY_PENDING_MAX: usize = 8;
/// Nanoseconds per millisecond.
const NS_PER_MS: f64 = 1_000_000.0;

/// Where a frame's GPU time came from.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum GpuSource {
    /// Timestamp queries: the GPU's own clock.
    #[default]
    Timestamps,
    /// The submit-to-done latency on the CPU clock (includes queueing; an estimate).
    SubmitLatency,
}

/// One frame's measured times, in milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameTiming {
    /// CPU encode and submit time (swapchain acquire and present waits excluded).
    pub cpu_ms: f32,
    /// GPU time between the frame's first and last timestamps (None without a sample).
    pub gpu_ms: Option<f32>,
    /// Where `gpu_ms` came from.
    pub gpu_source: GpuSource,
}

/// The window's percentiles (`state().volatile.render` and the perf harness).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TimingSummary {
    /// CPU frames held.
    pub frames: usize,
    /// CPU p50 and p95.
    pub cpu_p50: Option<f32>,
    /// CPU p95.
    pub cpu_p95: Option<f32>,
    /// GPU p50 over the GPU samples held.
    pub gpu_p50: Option<f32>,
    /// GPU p95.
    pub gpu_p95: Option<f32>,
    /// The latest GPU sample's source.
    pub gpu_source: Option<GpuSource>,
}

/// The last [`TIMING_WINDOW_FRAMES`] frames' CPU times and GPU samples. GPU samples slide on their
/// own: the ring lands them frames after their CPU time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TimingWindow {
    cpu: VecDeque<f32>,
    gpu: VecDeque<f32>,
    gpu_source: Option<GpuSource>,
}

fn push_capped(values: &mut VecDeque<f32>, value: f32) {
    if values.len() == TIMING_WINDOW_FRAMES {
        values.pop_front();
    }
    values.push_back(value);
}

impl TimingWindow {
    /// An empty window.
    pub fn new() -> TimingWindow {
        TimingWindow::default()
    }

    /// Add a frame, dropping the oldest beyond the window.
    pub fn push(&mut self, timing: FrameTiming) {
        push_capped(&mut self.cpu, timing.cpu_ms);
        if let Some(gpu_ms) = timing.gpu_ms {
            self.push_gpu(gpu_ms, timing.gpu_source);
        }
    }

    /// Add a GPU sample that landed after its frame's CPU time.
    pub fn push_gpu(&mut self, gpu_ms: f32, source: GpuSource) {
        push_capped(&mut self.gpu, gpu_ms);
        self.gpu_source = Some(source);
    }

    /// Frames held.
    pub fn len(&self) -> usize {
        self.cpu.len()
    }

    /// Whether no frame is held.
    pub fn is_empty(&self) -> bool {
        self.cpu.is_empty()
    }

    /// The `percentile` (0 to 100, nearest rank) of CPU time.
    pub fn cpu_ms(&self, percentile: f32) -> Option<f32> {
        nearest_rank(self.cpu.iter().copied().collect(), percentile)
    }

    /// The `percentile` of GPU time over the GPU samples held.
    pub fn gpu_ms(&self, percentile: f32) -> Option<f32> {
        nearest_rank(self.gpu.iter().copied().collect(), percentile)
    }

    /// p50 and p95 of both clocks.
    pub fn summary(&self) -> TimingSummary {
        TimingSummary {
            frames: self.cpu.len(),
            cpu_p50: self.cpu_ms(50.0),
            cpu_p95: self.cpu_ms(95.0),
            gpu_p50: self.gpu_ms(50.0),
            gpu_p95: self.gpu_ms(95.0),
            gpu_source: self.gpu_source,
        }
    }
}

fn nearest_rank(mut values: Vec<f32>, percentile: f32) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let rank = ((percentile.clamp(0.0, 100.0) / 100.0) * values.len() as f32).ceil() as usize;
    values.get(rank.saturating_sub(1)).copied()
}

/// Milliseconds between two timestamps of `period_ns` nanoseconds per tick; None for a reversed
/// pair or a zero period (no timestamps).
pub fn span_ms(begin: u64, end: u64, period_ns: f32) -> Option<f32> {
    if end < begin || period_ns <= 0.0 {
        return None;
    }
    Some(((end - begin) as f64 * f64::from(period_ns) / NS_PER_MS) as f32)
}

/// CPU encode and submit time from injected instants, excluding swapchain waits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuTimer {
    start: Option<Duration>,
    wait_start: Option<Duration>,
    waited: Duration,
}

impl CpuTimer {
    /// A timer with no frame open.
    pub fn new() -> CpuTimer {
        CpuTimer::default()
    }

    /// The frame's CPU work starts at `now`.
    pub fn begin(&mut self, now: Duration) {
        *self = CpuTimer { start: Some(now), wait_start: None, waited: Duration::ZERO };
    }

    /// A swapchain acquire or present wait starts at `now` (not counted).
    pub fn wait_begin(&mut self, now: Duration) {
        if self.start.is_some() && self.wait_start.is_none() {
            self.wait_start = Some(now);
        }
    }

    /// The wait ends at `now`.
    pub fn wait_end(&mut self, now: Duration) {
        if let Some(start) = self.wait_start.take() {
            self.waited += now.saturating_sub(start);
        }
    }

    /// The frame's work ends at `now` (after submit): its CPU milliseconds, once per frame.
    pub fn end(&mut self, now: Duration) -> Option<f32> {
        self.wait_end(now);
        let start = self.start.take()?;
        let busy = now.saturating_sub(start).saturating_sub(self.waited);
        Some(busy.as_secs_f32() * 1000.0)
    }
}

/// A clock the platform supplies (`Instant` natively, `performance.now()` on the web).
pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

/// A callback the queue runs when a submission's work is done.
pub type DoneCallback = Box<dyn FnOnce() + Send>;

struct PendingSubmit {
    frame: u64,
    at: Duration,
    done: Arc<Mutex<Option<Duration>>>,
}

/// The fallback GPU estimate without timestamps: submit to `on_submitted_work_done`, on the
/// platform's clock.
pub struct SubmitLatency {
    clock: Clock,
    pending: VecDeque<PendingSubmit>,
    frame: u64,
}

impl SubmitLatency {
    /// A probe reading `clock`.
    pub fn new(clock: Clock) -> SubmitLatency {
        SubmitLatency { clock, pending: VecDeque::new(), frame: 0 }
    }

    /// A frame was just submitted: `register` hands the done callback to the queue (see
    /// [`SubmitLatency::submitted_on`]).
    pub fn submitted(&mut self, register: impl FnOnce(DoneCallback)) {
        let done = Arc::new(Mutex::new(None));
        let (clock, landed) = (Arc::clone(&self.clock), Arc::clone(&done));
        if self.pending.len() == SUBMIT_LATENCY_PENDING_MAX {
            self.pending.pop_front();
        }
        self.pending.push_back(PendingSubmit { frame: self.frame, at: (self.clock)(), done });
        self.frame += 1;
        register(Box::new(move || {
            if let Ok(mut slot) = landed.lock() {
                *slot = Some(clock());
            }
        }));
    }

    /// [`SubmitLatency::submitted`] on `queue`.
    pub fn submitted_on(&mut self, queue: &Queue) {
        self.submitted(|callback| queue.on_submitted_work_done(callback));
    }

    /// The (frame, milliseconds) of every submission done since the last call, oldest first.
    pub fn collect(&mut self) -> Vec<(u64, f32)> {
        let mut landed = Vec::new();
        while let Some(front) = self.pending.front() {
            let Some(done) = front.done.lock().ok().and_then(|slot| *slot) else { break };
            landed.push((front.frame, done.saturating_sub(front.at).as_secs_f32() * 1000.0));
            self.pending.pop_front();
        }
        landed
    }
}

/// A ring slot's state. A slot moves Free → Recording → Sampled → Resolving → InFlight → Free and
/// is never recorded, resolved into or mapped out of order.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotState {
    /// Free to record.
    Free,
    /// Timestamps for `frame` are being encoded.
    Recording {
        /// The frame.
        frame: u64,
    },
    /// Submitted: the GPU is writing its timestamps (resolved only once that work is done).
    Sampled {
        /// The frame.
        frame: u64,
    },
    /// Its resolve and copy are encoded into a later frame, mapped after that frame's submit.
    Resolving {
        /// The frame.
        frame: u64,
    },
    /// Its readback buffer is mapping: untouched until the map lands and is unmapped.
    InFlight {
        /// The frame.
        frame: u64,
    },
}

/// The pure state machine of the [`QUERY_RING_DEPTH`]-deep resolve/readback ring.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryRing {
    slots: [SlotState; QUERY_RING_DEPTH],
    next: usize,
}

impl Default for QueryRing {
    fn default() -> Self {
        QueryRing { slots: [SlotState::Free; QUERY_RING_DEPTH], next: 0 }
    }
}

impl QueryRing {
    /// Every slot free.
    pub fn new() -> QueryRing {
        QueryRing::default()
    }

    /// A free slot to record `frame` into (round robin), or None when every slot is busy: the
    /// frame goes untimed instead of waiting.
    pub fn begin(&mut self, frame: u64) -> Option<usize> {
        let slot = (0..QUERY_RING_DEPTH)
            .map(|offset| (self.next + offset) % QUERY_RING_DEPTH)
            .find(|slot| self.slots[*slot] == SlotState::Free)?;
        self.slots[slot] = SlotState::Recording { frame };
        self.next = (slot + 1) % QUERY_RING_DEPTH;
        Some(slot)
    }

    fn step(&mut self, slot: usize, from: fn(SlotState) -> Option<u64>, to: fn(u64) -> SlotState) -> Option<u64> {
        let frame = from(self.slots.get(slot).copied()?)?;
        self.slots[slot] = to(frame);
        Some(frame)
    }

    /// The recording `slot`'s frame was submitted; false unless it was recording.
    pub fn submit(&mut self, slot: usize) -> bool {
        let recording = |state| if let SlotState::Recording { frame } = state { Some(frame) } else { None };
        self.step(slot, recording, |frame| SlotState::Sampled { frame }).is_some()
    }

    /// The sampled `slot`'s GPU work is done and its resolve is being encoded; false unless it was
    /// sampled.
    pub fn resolve(&mut self, slot: usize) -> bool {
        let sampled = |state| if let SlotState::Sampled { frame } = state { Some(frame) } else { None };
        self.step(slot, sampled, |frame| SlotState::Resolving { frame }).is_some()
    }

    /// The frame carrying the resolving `slot`'s copy was submitted and its map requested; false
    /// unless it was resolving.
    pub fn map(&mut self, slot: usize) -> bool {
        let resolving = |state| if let SlotState::Resolving { frame } = state { Some(frame) } else { None };
        self.step(slot, resolving, |frame| SlotState::InFlight { frame }).is_some()
    }

    /// `slot`'s map landed and was unmapped: free it and answer its frame (None unless in flight).
    pub fn complete(&mut self, slot: usize) -> Option<u64> {
        let in_flight = |state| if let SlotState::InFlight { frame } = state { Some(frame) } else { None };
        self.step(slot, in_flight, |_| SlotState::Free)
    }

    /// The recording `slot`'s frame was never submitted: free it.
    pub fn abandon(&mut self, slot: usize) {
        if let Some(state @ SlotState::Recording { .. }) = self.slots.get_mut(slot) {
            *state = SlotState::Free;
        }
    }

    /// `slot`'s state.
    pub fn state(&self, slot: usize) -> SlotState {
        self.slots.get(slot).copied().unwrap_or(SlotState::Free)
    }

    /// Slots submitted and not yet landed.
    pub fn in_flight(&self) -> usize {
        self.slots.iter().filter(|slot| !matches!(slot, SlotState::Free | SlotState::Recording { .. })).count()
    }
}

/// How finely a [`GpuTimer`] times a frame.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimerMode {
    /// Live: the first pass's beginning and the last pass's end (2 timestamps per frame). The span
    /// is the frame's only when the last pass depends on the first (the present pass does): a tile
    /// GPU overlaps passes that share no resource.
    Frame,
    /// Perf harness and dev builds: a begin/end pair per graph node, up to [`MAX_TIMED_NODES`].
    Nodes(u16),
    /// Frame-graph step brackets (PROF-2): a pair per step, up to [`MAX_TIMED_NODES`], its beginning
    /// written by the pass that opens the step ([`PassTiming::first`]) and its end by the pass that
    /// closes it ([`PassTiming::last`]), as [`TimerMode::Frame`] does for its one pair.
    Steps(u16),
}

/// Where a pass sits in the frame, for its timestamp writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PassTiming {
    /// Its graph node (timed in [`TimerMode::Nodes`]).
    pub node: u16,
    /// Whether it is the frame's first timed pass ([`TimerMode::Frame`] writes its beginning).
    pub first: bool,
    /// Whether it is the frame's last ([`TimerMode::Frame`] writes its end).
    pub last: bool,
}

/// One frame's GPU times.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuFrameSample {
    /// The timer's frame counter (frames begun, timed or not).
    pub frame: u64,
    /// The frame's span: first beginning to last end of the timed passes.
    pub frame_ms: Option<f32>,
    /// Each node's span ([`TimerMode::Nodes`]; empty in [`TimerMode::Frame`]).
    pub nodes: Vec<Option<f32>>,
}

/// Map states a slot's callback reports.
const MAP_PENDING: u8 = 0;
const MAP_OK: u8 = 1;
const MAP_FAILED: u8 = 2;

struct TimerSlot {
    readback: Buffer,
    /// Which queries were written this frame (begin and end of each pair).
    written: Vec<bool>,
    /// Which pairs were resolved into the readback buffer.
    resolved: Vec<bool>,
    /// Set when the submission that sampled the slot is done on the GPU.
    sampled: Arc<AtomicBool>,
    map: Arc<AtomicU8>,
}

impl TimerSlot {
    fn complete_pairs(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.resolved.len()).filter(|pair| self.written[pair * 2] && self.written[pair * 2 + 1])
    }
}

/// GPU timestamps through pass `timestamp_writes` and a non-blocking resolve/readback ring.
///
/// Per submitted frame, in order: [`GpuTimer::begin_frame`], the passes' writes,
/// [`GpuTimer::resolve`] into the frame's last encoder, the submit, [`GpuTimer::submitted`]; once
/// per frame (before `begin_frame`), [`GpuTimer::collect`]. A frame's timestamps are resolved in a
/// later frame's encoder, after the GPU reports the sampling submission done: wgpu's Metal backend
/// resolves counter samples without waiting for the passes that write them, so a resolve in the
/// same command buffer reads the previous frame's ticks (measured on Apple M4 Max, RQ0.5).
pub struct GpuTimer {
    mode: TimerMode,
    pairs: u32,
    queue: Queue,
    query_set: QuerySet,
    resolve: Buffer,
    slots: Vec<TimerSlot>,
    ring: QueryRing,
    recording: Option<usize>,
    frame: u64,
    skipped: u64,
    period_ns: f32,
}

fn timer_slot(device: &Device, pairs: u32) -> TimerSlot {
    TimerSlot {
        readback: device.create_buffer(&BufferDescriptor {
            label: Some("frame-timestamps-readback"),
            size: u64::from(pairs) * 2 * QUERY_SIZE as u64,
            usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }),
        written: vec![false; pairs as usize * 2],
        resolved: vec![false; pairs as usize],
        sampled: Arc::new(AtomicBool::new(false)),
        map: Arc::new(AtomicU8::new(MAP_PENDING)),
    }
}

impl GpuTimer {
    /// A timer on `device`, or None when it was not opened with `TIMESTAMP_QUERY` (the caller
    /// falls back to [`SubmitLatency`] and an interval-only DRS signal).
    pub fn new(device: &Device, queue: &Queue, mode: TimerMode) -> Option<GpuTimer> {
        if !device.features().contains(Features::TIMESTAMP_QUERY) {
            return None;
        }
        let pairs = match mode {
            TimerMode::Frame => 1,
            TimerMode::Nodes(nodes) | TimerMode::Steps(nodes) => u32::from(nodes.clamp(1, MAX_TIMED_NODES)),
        };
        let count = pairs * 2 * QUERY_RING_DEPTH as u32;
        debug_assert!(count <= QUERY_SET_MAX_QUERIES);
        let query_set =
            device.create_query_set(&QuerySetDescriptor { label: Some("frame-timestamps"), ty: QueryType::Timestamp, count });
        // Each pair resolves to its own aligned offset: unwritten queries are never resolved.
        let resolve = device.create_buffer(&BufferDescriptor {
            label: Some("frame-timestamps-resolve"),
            size: u64::from(pairs) * QUERY_RING_DEPTH as u64 * QUERY_RESOLVE_BUFFER_ALIGNMENT,
            usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let slots = (0..QUERY_RING_DEPTH).map(|_| timer_slot(device, pairs)).collect();
        Some(GpuTimer {
            mode,
            pairs,
            queue: queue.clone(),
            query_set,
            resolve,
            slots,
            ring: QueryRing::new(),
            recording: None,
            frame: 0,
            skipped: 0,
            period_ns: queue.get_timestamp_period(),
        })
    }

    /// The timer's mode.
    pub fn mode(&self) -> TimerMode {
        self.mode
    }

    /// Start a frame: answers whether it is timed (false when every ring slot is busy).
    pub fn begin_frame(&mut self) -> bool {
        if let Some(slot) = self.recording.take() {
            self.ring.abandon(slot);
        }
        let frame = self.frame;
        self.frame += 1;
        let Some(slot) = self.ring.begin(frame) else {
            self.skipped += 1;
            return false;
        };
        let state = &mut self.slots[slot];
        state.written.fill(false);
        state.resolved.fill(false);
        state.sampled.store(false, Ordering::Release);
        state.map.store(MAP_PENDING, Ordering::Release);
        self.recording = Some(slot);
        true
    }

    /// The query indices `pass` writes this frame (begin, end), marking them written.
    fn writes(&mut self, pass: PassTiming) -> Option<(Option<u32>, Option<u32>)> {
        let slot = self.recording?;
        let (pair, begin, end) = match self.mode {
            TimerMode::Frame => (0, pass.first, pass.last),
            TimerMode::Nodes(_) => (u32::from(pass.node), true, true),
            TimerMode::Steps(_) => (u32::from(pass.node), pass.first, pass.last),
        };
        if pair >= self.pairs {
            return None;
        }
        let index = pair as usize * 2;
        let written = &mut self.slots[slot].written;
        let (begin, end) = (begin && !written[index], end && !written[index + 1]);
        if !(begin || end) {
            return None;
        }
        written[index] |= begin;
        written[index + 1] |= end;
        let base = (slot as u32 * self.pairs + pair) * 2;
        Some((begin.then_some(base), end.then_some(base + 1)))
    }

    /// The timestamp writes for a render pass at `pass` (None when this frame is untimed or the
    /// pass writes nothing).
    pub fn render_writes(&mut self, pass: PassTiming) -> Option<RenderPassTimestampWrites<'_>> {
        let (beginning, end) = self.writes(pass)?;
        Some(RenderPassTimestampWrites {
            query_set: &self.query_set,
            beginning_of_pass_write_index: beginning,
            end_of_pass_write_index: end,
        })
    }

    /// The timestamp writes for a compute pass at `pass`.
    pub fn compute_writes(&mut self, pass: PassTiming) -> Option<ComputePassTimestampWrites<'_>> {
        let (beginning, end) = self.writes(pass)?;
        Some(ComputePassTimestampWrites {
            query_set: &self.query_set,
            beginning_of_pass_write_index: beginning,
            end_of_pass_write_index: end,
        })
    }

    /// Encode the resolve and readback copy of every earlier frame whose GPU work is done (encode
    /// it last in the frame).
    pub fn resolve(&mut self, encoder: &mut CommandEncoder) {
        for slot in 0..QUERY_RING_DEPTH {
            let sampled = matches!(self.ring.state(slot), SlotState::Sampled { .. });
            if !(sampled && self.slots[slot].sampled.load(Ordering::Acquire)) {
                continue;
            }
            let pairs: Vec<usize> = self.slots[slot].complete_pairs().collect();
            for pair in pairs {
                let first = (slot as u32 * self.pairs + pair as u32) * 2;
                let offset = u64::from(slot as u32 * self.pairs + pair as u32) * QUERY_RESOLVE_BUFFER_ALIGNMENT;
                let bytes = 2 * QUERY_SIZE as u64;
                encoder.resolve_query_set(&self.query_set, first..first + 2, &self.resolve, offset);
                encoder.copy_buffer_to_buffer(&self.resolve, offset, &self.slots[slot].readback, pair as u64 * bytes, bytes);
                self.slots[slot].resolved[pair] = true;
            }
            self.ring.resolve(slot);
        }
    }

    /// The frame was submitted: the recording slot waits for its GPU work, and every slot resolved
    /// into this frame starts mapping. A frame with no complete timestamp pair frees its slot.
    pub fn submitted(&mut self) {
        if let Some(slot) = self.recording.take() {
            if self.slots[slot].complete_pairs().next().is_none() {
                self.ring.abandon(slot);
            } else {
                self.ring.submit(slot);
                let sampled = Arc::clone(&self.slots[slot].sampled);
                self.queue.on_submitted_work_done(move || sampled.store(true, Ordering::Release));
            }
        }
        for slot in 0..QUERY_RING_DEPTH {
            if !self.ring.map(slot) {
                continue;
            }
            let map = Arc::clone(&self.slots[slot].map);
            self.slots[slot].readback.slice(..).map_async(MapMode::Read, move |result| {
                map.store(if result.is_ok() { MAP_OK } else { MAP_FAILED }, Ordering::Release);
            });
        }
    }

    /// Every sample whose map has landed, oldest first; never blocks (natively it polls the
    /// device once without waiting; on the web the browser runs the callbacks between frames).
    pub fn collect(&mut self, device: &Device) -> Vec<GpuFrameSample> {
        #[cfg(not(target_arch = "wasm32"))]
        let _ = device.poll(wgpu::PollType::Poll);
        #[cfg(target_arch = "wasm32")]
        let _ = device;
        let mut samples = Vec::new();
        for slot in 0..QUERY_RING_DEPTH {
            let SlotState::InFlight { frame } = self.ring.state(slot) else { continue };
            let state = self.slots[slot].map.load(Ordering::Acquire);
            if state == MAP_PENDING {
                continue;
            }
            let ticks = if state == MAP_OK { self.read_slot(slot) } else { Vec::new() };
            self.ring.complete(slot);
            samples.push(self.sample(slot, frame, &ticks));
        }
        samples.sort_by_key(|sample| sample.frame);
        samples
    }

    /// The landed slot's raw ticks, then unmap it.
    fn read_slot(&self, slot: usize) -> Vec<u64> {
        let readback = &self.slots[slot].readback;
        let ticks = match readback.slice(..).get_mapped_range() {
            Ok(view) => view.as_chunks::<{ QUERY_SIZE as usize }>().0.iter().map(|bytes| u64::from_le_bytes(*bytes)).collect(),
            Err(_) => Vec::new(),
        };
        readback.unmap();
        ticks
    }

    fn sample(&self, slot: usize, frame: u64, ticks: &[u64]) -> GpuFrameSample {
        let resolved = &self.slots[slot].resolved;
        // A zero tick was never sampled: Metal takes no counter sample in a pass that runs no
        // shader stage (a clear-only render pass), and leaves the query at 0.
        let pair_ticks = |pair: usize| {
            let both = (ticks.get(pair * 2).copied(), ticks.get(pair * 2 + 1).copied());
            match both {
                (Some(begin), Some(end)) if resolved[pair] && begin != 0 && end != 0 => Some((begin, end)),
                _ => None,
            }
        };
        let pairs: Vec<Option<(u64, u64)>> = (0..self.pairs as usize).map(pair_ticks).collect();
        let first = pairs.iter().flatten().map(|pair| pair.0).min();
        let last = pairs.iter().flatten().map(|pair| pair.1).max();
        let frame_ms = first.zip(last).and_then(|(begin, end)| span_ms(begin, end, self.period_ns));
        let nodes = match self.mode {
            TimerMode::Frame => Vec::new(),
            TimerMode::Nodes(_) | TimerMode::Steps(_) => {
                pairs.iter().map(|pair| pair.and_then(|(begin, end)| span_ms(begin, end, self.period_ns))).collect()
            }
        };
        GpuFrameSample { frame, frame_ms, nodes }
    }

    /// Frames that went untimed because every ring slot was busy.
    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}
