//! The job pool: priority, cancel and a finish budget per frame, threads on native and inline on the
//! web (game systems STR-4, the generalized `compile.rs` pool).
//!
//! Off-thread work (pipeline compiles, file reads, decodes, shape builds, GPU resource creation on
//! native, where wgpu's `Device` and `Queue` are `Send + Sync`) goes to one process-wide [`Pool`]
//! of 2-8 threads. A job is queued on one of three [`Priority`] lanes: a thread always takes the
//! oldest job of the most urgent lane, so a `Sim` job the next tick waits for never queues behind a
//! hundred prefetches. A job still queued can be cancelled ([`Job::cancel`]); its closure is then
//! never called. A job that panics is caught: its [`Job`] reports the message and the pool keeps
//! running.
//!
//! What a job made usually still has to be finished on the frame thread (a GPU upload, an entry in
//! the scene). That work waits in a [`FinishQueue`], drained once a frame in priority order until
//! the frame's budget is spent ([`finish_budget_ms`]: 2.0 ms on desktops and the web, 1.0 ms on
//! phones). The clock is the caller's ([`FinishClock`]): the presenter passes its frame clock and
//! tests a fake one, so this crate never reads a wall clock.
//!
//! On the web (wasm32, no threads) the pool has none: a job runs where it is submitted, so it is
//! finished when [`Pool::spawn`] returns and nothing cancels. The same holds on native for a pool
//! made with [`Pool::inline`], or when not one thread could start.
//!
//! Ideas from Godot's threaded resource loader and Fyrox's `AsyncSceneLoader` (both MIT; no code
//! taken): load on a worker, finish on the main thread, polled once a frame.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use crate::device_class::{DeviceClass, FormFactor};

/// Job threads at most in the process pool: the driver's own compiler service does not scale past
/// about this, and streaming work is bound by the same cores.
#[cfg(not(target_arch = "wasm32"))]
const MAX_THREADS: usize = 8;
/// Job threads at least, when the host's parallelism is unknown or 1.
#[cfg(not(target_arch = "wasm32"))]
const MIN_THREADS: usize = 2;

/// The frame thread's finish budget on desktops and the web, in milliseconds.
pub const FINISH_BUDGET_DESKTOP_MS: f64 = 2.0;
/// The frame thread's finish budget on phones and tablets, in milliseconds.
pub const FINISH_BUDGET_PHONE_MS: f64 = 1.0;

/// The finish budget a frame on a device of `class` spends draining its [`FinishQueue`].
pub fn finish_budget_ms(class: DeviceClass) -> f64 {
    match class.form {
        FormFactor::Desktop => FINISH_BUDGET_DESKTOP_MS,
        FormFactor::Mobile => FINISH_BUDGET_PHONE_MS,
    }
}

/// How urgent a job (or its finishing work) is. A thread takes the oldest job of the most urgent
/// non-empty lane; within a lane jobs run in the order they were submitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Priority {
    /// The simulation waits for it (a cell the next tick enters, a collider): first.
    Sim,
    /// The current view draws it (a pipeline, a visible cell's mesh or texture).
    Visible,
    /// Wanted soon (the prefetch ring around the view): last.
    Prefetch,
}

impl Priority {
    /// Every priority, most urgent first.
    pub const ALL: [Priority; 3] = [Priority::Sim, Priority::Visible, Priority::Prefetch];

    /// The lane index (`ALL`'s order).
    const fn lane(self) -> usize {
        match self {
            Priority::Sim => 0,
            Priority::Visible => 1,
            Priority::Prefetch => 2,
        }
    }
}

/// Where a job is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    /// Waiting on its lane.
    Queued,
    /// A thread is running it.
    Running,
    /// It returned or panicked ([`Job::wait`] says which).
    Finished,
    /// Cancelled while queued: its closure never ran.
    Cancelled,
}

const QUEUED: u8 = 0;
const RUNNING: u8 = 1;
const FINISHED: u8 = 2;
const CANCELLED: u8 = 3;

/// Why a job has no value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobError {
    /// The job panicked, with the panic's message.
    Panicked(String),
    /// The job was cancelled before it started.
    Cancelled,
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobError::Panicked(message) => f.write_str(message),
            JobError::Cancelled => f.write_str("the job was cancelled"),
        }
    }
}

impl std::error::Error for JobError {}

/// A job's shared slot: its state and, once settled, what it came to.
struct Slot<T> {
    state: AtomicU8,
    outcome: OnceLock<Result<T, JobError>>,
}

impl<T> Slot<T> {
    fn settled(state: u8, outcome: Result<T, JobError>) -> Self {
        let slot = Slot { state: AtomicU8::new(state), outcome: OnceLock::new() };
        let _ = slot.outcome.set(outcome);
        slot
    }
}

/// A job handed to a [`Pool`]: wait for its value, poll it, or cancel it while it is queued.
pub struct Job<T> {
    slot: Arc<Slot<T>>,
}

impl<T: std::fmt::Debug> std::fmt::Debug for Job<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.slot.outcome.get() {
            Some(outcome) => f.debug_tuple("Job").field(outcome).finish(),
            None => f.debug_tuple("Job").field(&self.state()).finish(),
        }
    }
}

impl<T> Job<T> {
    /// A job that is already finished with `value`.
    pub fn ready(value: T) -> Self {
        Job { slot: Arc::new(Slot::settled(FINISHED, Ok(value))) }
    }

    /// Where the job is now.
    pub fn state(&self) -> JobState {
        match self.slot.state.load(Ordering::Acquire) {
            QUEUED => JobState::Queued,
            RUNNING => JobState::Running,
            CANCELLED => JobState::Cancelled,
            _ => JobState::Finished,
        }
    }

    /// Cancel the job if it has not started: true when this call cancelled it (its closure will
    /// never run), false when it is running, finished or was cancelled already.
    pub fn cancel(&self) -> bool {
        let cancelled = self.slot.state.compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire).is_ok();
        if cancelled {
            let _ = self.slot.outcome.set(Err(JobError::Cancelled));
        }
        cancelled
    }

    /// Whether the job has settled (finished, panicked or been cancelled). Never waits.
    pub fn is_ready(&self) -> bool {
        self.slot.outcome.get().is_some()
    }

    /// What the job came to, or None while it is queued or running. Never waits.
    pub fn try_get(&self) -> Option<Result<&T, JobError>> {
        self.slot.outcome.get().map(as_ref)
    }

    /// What the job came to, waiting until it settles.
    pub fn wait(&self) -> Result<&T, JobError> {
        as_ref(self.slot.outcome.wait())
    }

    /// The value, waiting for it: a job that panicked panics again here with its message, as the
    /// call it replaced would have (the pipeline compiles' contract); a cancelled one panics too.
    pub fn get(&self) -> &T {
        match self.wait() {
            Ok(value) => value,
            Err(error) => panic!("{error}"),
        }
    }

    /// What the job came to, moved out (no copy of a large payload), waiting until it settles.
    pub fn into_result(self) -> Result<T, JobError> {
        let mut slot = self.slot;
        as_ref(slot.outcome.wait())?;
        // Made: the job's thread drops its handle on the slot right after setting the value.
        loop {
            match Arc::try_unwrap(slot) {
                Ok(owned) => return owned.outcome.into_inner().unwrap_or(Err(JobError::Cancelled)),
                Err(shared) => {
                    slot = shared;
                    std::thread::yield_now();
                }
            }
        }
    }
}

/// A settled outcome borrowed: the value, or its error cloned.
fn as_ref<T>(outcome: &Result<T, JobError>) -> Result<&T, JobError> {
    outcome.as_ref().map_err(Clone::clone)
}

/// What a panic carried, as the message its job reports.
pub(crate) fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = panic.downcast_ref::<&str>() {
        return (*text).to_owned();
    }
    panic.downcast_ref::<String>().cloned().unwrap_or_else(|| "a job panicked".to_owned())
}

type Task = Box<dyn FnOnce() + Send>;

/// The lanes, the holds and whether the pool's handle is gone.
struct Queue {
    lanes: [VecDeque<Task>; 3],
    holds: u32,
    closed: bool,
}

impl Queue {
    /// The oldest task of the most urgent non-empty lane (job threads only: the web has none).
    #[cfg(not(target_arch = "wasm32"))]
    fn next(&mut self) -> Option<Task> {
        self.lanes.iter_mut().find_map(VecDeque::pop_front)
    }

    fn len(&self) -> usize {
        self.lanes.iter().map(VecDeque::len).sum()
    }
}

/// What a pool's threads share with it.
struct Shared {
    queue: Mutex<Queue>,
    wake: std::sync::Condvar,
}

impl Shared {
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A pool of job threads with three priority lanes (none on the web: jobs run inline).
pub struct Pool {
    shared: Arc<Shared>,
    threads: usize,
}

impl std::fmt::Debug for Pool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pool").field("threads", &self.threads).field("queued", &self.queued()).finish()
    }
}

impl Pool {
    /// A pool of `threads` job threads (fewer if some cannot start; none runs every job inline).
    /// On the web it is always inline.
    pub fn new(threads: usize) -> Pool {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue { lanes: [VecDeque::new(), VecDeque::new(), VecDeque::new()], holds: 0, closed: false }),
            wake: std::sync::Condvar::new(),
        });
        let threads = start_threads(&shared, threads);
        Pool { shared, threads }
    }

    /// A pool with no threads: every job runs where it is submitted (the web's pool).
    pub fn inline() -> Pool {
        Pool::new(0)
    }

    /// The process pool every renderer job goes to: 2-8 threads by the host's parallelism (inline
    /// on the web). Its threads start on first use and live as long as the process.
    pub fn global() -> &'static Pool {
        static GLOBAL: OnceLock<Pool> = OnceLock::new();
        GLOBAL.get_or_init(|| Pool::new(process_threads()))
    }

    /// Threads running jobs (0 when jobs run inline).
    pub fn threads(&self) -> usize {
        self.threads
    }

    /// Jobs on the lanes not yet taken by a thread (cancelled ones included until a thread passes
    /// them).
    pub fn queued(&self) -> usize {
        self.shared.queue().len()
    }

    /// Run `job` on the `priority` lane: on a pool thread, or here, before this returns, when the
    /// pool has none.
    pub fn spawn<T: Send + Sync + 'static>(&self, priority: Priority, job: impl FnOnce() -> T + Send + 'static) -> Job<T> {
        self.spawn_then(priority, job, || {})
    }

    /// [`Pool::spawn`], then `after` on the job's thread once its outcome is set (not for a job
    /// cancelled before it started).
    pub(crate) fn spawn_then<T: Send + Sync + 'static>(&self, priority: Priority, job: impl FnOnce() -> T + Send + 'static, after: impl FnOnce() + Send + 'static) -> Job<T> {
        let slot = Arc::new(Slot { state: AtomicU8::new(QUEUED), outcome: OnceLock::new() });
        let filled = Arc::clone(&slot);
        let run = move || {
            if filled.state.compare_exchange(QUEUED, RUNNING, Ordering::AcqRel, Ordering::Acquire).is_err() {
                // Cancelled while queued.
                return;
            }
            let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).map_err(|panic| JobError::Panicked(panic_message(panic.as_ref())));
            filled.state.store(FINISHED, Ordering::Release);
            let _ = filled.outcome.set(made);
            drop(filled);
            after();
        };
        self.submit(priority, Box::new(run));
        Job { slot }
    }

    fn submit(&self, priority: Priority, task: Task) {
        if self.threads == 0 {
            task();
            return;
        }
        self.shared.queue().lanes[priority.lane()].push_back(task);
        self.shared.wake.notify_one();
    }

    /// Hold the pool: while the returned guard lives no thread starts a job, so queued jobs wait
    /// (and a frame that needs one waits with them). Tests stand a slow worker in with it.
    #[must_use = "the pool runs again when the hold is dropped"]
    pub fn hold(&self) -> PoolHold {
        self.shared.queue().holds += 1;
        PoolHold { shared: Arc::clone(&self.shared) }
    }

    /// Whether a hold is alive on the pool.
    pub fn is_held(&self) -> bool {
        self.shared.queue().holds > 0
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        // Its threads finish what is queued, then end.
        self.shared.queue().closed = true;
        self.shared.wake.notify_all();
    }
}

/// While alive, no thread of its pool starts a job ([`Pool::hold`]).
#[must_use = "the pool runs again when the hold is dropped"]
pub struct PoolHold {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for PoolHold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PoolHold")
    }
}

impl Drop for PoolHold {
    fn drop(&mut self) {
        let mut queue = self.shared.queue();
        queue.holds = queue.holds.saturating_sub(1);
        drop(queue);
        self.shared.wake.notify_all();
    }
}

/// The process pool's thread count: the host's parallelism within 2-8.
#[cfg(not(target_arch = "wasm32"))]
fn process_threads() -> usize {
    std::thread::available_parallelism().map_or(MIN_THREADS, std::num::NonZeroUsize::get).clamp(MIN_THREADS, MAX_THREADS)
}

#[cfg(target_arch = "wasm32")]
fn process_threads() -> usize {
    0
}

/// Start up to `wanted` threads on `shared`: how many started.
#[cfg(not(target_arch = "wasm32"))]
fn start_threads(shared: &Arc<Shared>, wanted: usize) -> usize {
    (0..wanted)
        .filter(|index| {
            let shared = Arc::clone(shared);
            std::thread::Builder::new().name(format!("genex-job-{index}")).spawn(move || work(&shared)).is_ok()
        })
        .count()
}

#[cfg(target_arch = "wasm32")]
fn start_threads(_shared: &Arc<Shared>, _wanted: usize) -> usize {
    0
}

/// One job thread: take the next task (the queue lock is released first) and run it. A task never
/// unwinds ([`Pool::spawn_then`] catches its job's panic). A thread waits while the pool is held
/// and ends once the pool is dropped and its lanes are empty.
#[cfg(not(target_arch = "wasm32"))]
fn work(shared: &Shared) {
    loop {
        let mut queue = shared.queue();
        let task = loop {
            if queue.holds == 0
                && let Some(task) = queue.next()
            {
                break task;
            }
            if queue.closed && queue.len() == 0 {
                return;
            }
            queue = shared.wake.wait(queue).unwrap_or_else(PoisonError::into_inner);
        };
        drop(queue);
        task();
    }
}

/// The time source a [`FinishQueue`] drain reads. The presenter passes its frame clock; tests a
/// fake one (a closure returning milliseconds works).
pub trait FinishClock {
    /// Milliseconds since an arbitrary origin.
    fn now_ms(&mut self) -> f64;
}

impl<F: FnMut() -> f64> FinishClock for F {
    fn now_ms(&mut self) -> f64 {
        self()
    }
}

/// What one [`FinishQueue::drain`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FinishReport {
    /// Items finished.
    pub finished: usize,
    /// Items still queued for a later frame.
    pub left: usize,
    /// Milliseconds the drain spent, by its clock.
    pub spent_ms: f64,
}

type Lanes<W> = [VecDeque<W>; 3];

fn empty_lanes<W>() -> Lanes<W> {
    [VecDeque::new(), VecDeque::new(), VecDeque::new()]
}

/// Work waiting for the frame thread, on the same three priority lanes as the pool, drained once a
/// frame under a millisecond budget.
pub struct FinishQueue<W> {
    lanes: Lanes<W>,
    inbox: Arc<Mutex<Lanes<W>>>,
}

impl<W> Default for FinishQueue<W> {
    fn default() -> Self {
        FinishQueue { lanes: empty_lanes(), inbox: Arc::new(Mutex::new(empty_lanes())) }
    }
}

impl<W> std::fmt::Debug for FinishQueue<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinishQueue").field("len", &self.len()).finish()
    }
}

impl<W> FinishQueue<W> {
    /// An empty queue.
    pub fn new() -> Self {
        FinishQueue::default()
    }

    /// Queue `work` on the `priority` lane (from the frame thread).
    pub fn push(&mut self, priority: Priority, work: W) {
        self.lanes[priority.lane()].push_back(work);
    }

    /// A handle job threads hand finished work in through; it joins the lanes at the next drain.
    pub fn inbox(&self) -> FinishInbox<W> {
        FinishInbox { lanes: Arc::clone(&self.inbox) }
    }

    /// Items waiting, handed-in ones included.
    pub fn len(&self) -> usize {
        let handed_in: usize = lock_lanes(&self.inbox).iter().map(VecDeque::len).sum();
        self.lanes.iter().map(VecDeque::len).sum::<usize>() + handed_in
    }

    /// Whether nothing waits.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Finish waiting items, most urgent lane first and each lane in order, until the time spent
    /// reaches `budget_ms` by `clock`: the item that crosses the budget is the last one, and at
    /// least one item is finished whenever any waits, so an item dearer than the whole budget
    /// still finishes on its frame. What is left waits for the next drain.
    pub fn drain(&mut self, budget_ms: f64, clock: &mut impl FinishClock, mut finish: impl FnMut(W)) -> FinishReport {
        self.take_handed_in();
        let started = clock.now_ms();
        let mut report = FinishReport::default();
        while let Some(work) = self.lanes.iter_mut().find_map(VecDeque::pop_front) {
            finish(work);
            report.finished += 1;
            report.spent_ms = clock.now_ms() - started;
            if report.spent_ms >= budget_ms {
                break;
            }
        }
        report.left = self.len();
        report
    }

    /// Move handed-in work onto the lanes, in the order it was handed in.
    fn take_handed_in(&mut self) {
        let mut inbox = lock_lanes(&self.inbox);
        for (lane, handed_in) in self.lanes.iter_mut().zip(inbox.iter_mut()) {
            lane.append(handed_in);
        }
    }
}

/// Hands finished work from any thread to a [`FinishQueue`] ([`FinishQueue::inbox`]).
pub struct FinishInbox<W> {
    lanes: Arc<Mutex<Lanes<W>>>,
}

impl<W> Clone for FinishInbox<W> {
    fn clone(&self) -> Self {
        FinishInbox { lanes: Arc::clone(&self.lanes) }
    }
}

impl<W> std::fmt::Debug for FinishInbox<W> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FinishInbox")
    }
}

impl<W> FinishInbox<W> {
    /// Hand `work` in on the `priority` lane.
    pub fn push(&self, priority: Priority, work: W) {
        lock_lanes(&self.lanes)[priority.lane()].push_back(work);
    }
}

fn lock_lanes<W>(lanes: &Mutex<Lanes<W>>) -> MutexGuard<'_, Lanes<W>> {
    lanes.lock().unwrap_or_else(PoisonError::into_inner)
}
