//! Where the game was when it crashed: the process-wide [`CrashContext`] the runtime writes after
//! every tick and frame and the panic hook reads. The hook may run on any thread at any moment,
//! inside a lock the runtime holds, so every read here is an atomic load or a `try_lock` that gives
//! up when busy: the hook never waits. Each field is stored on its own, so a crash in the middle of
//! [`CrashContext::set_tick`] may pair a tick with the previous tick's time.
//!
//! Nothing here is readable by a tick: the setters are write-only for the simulation, so the crash
//! context never changes what the game computes.

use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};

use serde_json::Value;

use crate::caps::CRASH_PROFILE_MAX_BYTES;
use crate::kind::CrashFlavour;
use crate::record::RecordContext;

/// A u64 field no setter has written (no seed fits it: seeds are u32).
const UNSET: u64 = u64::MAX;
/// `running` before the first tick.
const RUNNING_UNSET: u8 = 0;
/// `running`: the simulation was paused.
const RUNNING_NO: u8 = 1;
/// `running`: the simulation was running.
const RUNNING_YES: u8 = 2;

/// What build is running, set once per process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashIdentity {
    /// The destination's wire spelling (`mac`, `web`, ...).
    pub destination: String,
    /// The build flavour.
    pub flavour: CrashFlavour,
    /// The build's identity.
    pub build: String,
    /// The game contract's version.
    pub contract: u64,
    /// The genex crate's version.
    pub genex: String,
}

/// The adapter a GPU record names.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct GpuAdapter {
    backend: String,
    adapter: String,
}

/// The process's crash context: written by the runtime, read by the hook without waiting.
#[derive(Debug)]
pub struct CrashContext {
    identity: OnceLock<CrashIdentity>,
    seed: AtomicU64,
    tick: AtomicU64,
    /// Simulated milliseconds as `f64` bits ([`UNSET`] is a NaN no setter stores).
    simulated_ms: AtomicU64,
    running: AtomicU8,
    frame: AtomicU64,
    /// The last profile summary, pre-serialized (at most [`CRASH_PROFILE_MAX_BYTES`]).
    profile: Mutex<Option<Vec<u8>>>,
    adapter: Mutex<Option<GpuAdapter>>,
}

static CONTEXT: CrashContext = CrashContext::new();

/// The process's crash context (the one the hook reads).
pub fn context() -> &'static CrashContext {
    &CONTEXT
}

impl Default for CrashContext {
    fn default() -> CrashContext {
        CrashContext::new()
    }
}

impl CrashContext {
    /// A context that knows nothing yet (the process's own is [`context`]).
    pub const fn new() -> CrashContext {
        CrashContext {
            identity: OnceLock::new(),
            seed: AtomicU64::new(UNSET),
            tick: AtomicU64::new(UNSET),
            simulated_ms: AtomicU64::new(UNSET),
            running: AtomicU8::new(RUNNING_UNSET),
            frame: AtomicU64::new(UNSET),
            profile: Mutex::new(None),
            adapter: Mutex::new(None),
        }
    }

    /// Name the build; the first identity stays (a second call changes nothing).
    pub fn set_identity(&self, identity: CrashIdentity) {
        let _ = self.identity.set(identity);
    }

    /// The run's seed.
    pub fn set_seed(&self, seed: u32) {
        self.seed.store(u64::from(seed), Ordering::Relaxed);
    }

    /// The last finished tick, the simulated time and whether the simulation runs.
    pub fn set_tick(&self, tick: u64, simulated_ms: f64, running: bool) {
        let running = if running { RUNNING_YES } else { RUNNING_NO };
        self.simulated_ms.store(simulated_ms.to_bits(), Ordering::Relaxed);
        self.running.store(running, Ordering::Relaxed);
        self.tick.store(tick, Ordering::Release);
    }

    /// The frame being drawn.
    pub fn set_frame(&self, frame: u64) {
        self.frame.store(frame, Ordering::Relaxed);
    }

    /// The last profile summary as JSON. One that is not a JSON object or is over
    /// [`CRASH_PROFILE_MAX_BYTES`] clears it; a busy slot keeps the previous one.
    pub fn set_profile_summary(&self, summary_json: &[u8]) {
        let fits = summary_json.len() <= CRASH_PROFILE_MAX_BYTES && summary_json.first() == Some(&b'{');
        let Some(mut slot) = try_lock(&self.profile) else { return };
        *slot = fits.then(|| summary_json.to_vec());
    }

    /// The adapter GPU records name.
    pub fn set_gpu_adapter(&self, backend: &str, adapter: &str) {
        let Some(mut slot) = try_lock(&self.adapter) else { return };
        *slot = Some(GpuAdapter { backend: backend.to_string(), adapter: adapter.to_string() });
    }

    /// Every field set so far, as the record carries it.
    pub fn snapshot(&self) -> RecordContext {
        let tick = known(self.tick.load(Ordering::Acquire));
        let identity = self.identity.get();
        RecordContext {
            seed: known(self.seed.load(Ordering::Relaxed)).and_then(|seed| u32::try_from(seed).ok()),
            tick,
            frame: known(self.frame.load(Ordering::Relaxed)),
            simulated_ms: known(self.simulated_ms.load(Ordering::Relaxed)).map(f64::from_bits),
            running: match self.running.load(Ordering::Relaxed) {
                RUNNING_YES => Some(true),
                RUNNING_NO => Some(false),
                _ => None,
            },
            destination: identity.map(|id| id.destination.clone()),
            flavour: identity.map(|id| id.flavour),
            build: identity.map(|id| id.build.clone()),
            contract: identity.map(|id| id.contract),
            genex: identity.map(|id| id.genex.clone()),
        }
    }

    /// The last profile summary, when one is set, readable and not busy.
    pub fn profile_summary(&self) -> Option<Value> {
        let slot = try_lock(&self.profile)?;
        let bytes = slot.as_deref()?;
        serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object)
    }

    /// The adapter's backend and name, when set and not busy.
    pub fn gpu_adapter(&self) -> (Option<String>, Option<String>) {
        let Some(slot) = try_lock(&self.adapter) else { return (None, None) };
        match slot.as_ref() {
            Some(gpu) => (Some(gpu.backend.clone()), Some(gpu.adapter.clone())),
            None => (None, None),
        }
    }
}

/// `value` unless it is [`UNSET`].
fn known(value: u64) -> Option<u64> {
    (value != UNSET).then_some(value)
}

/// The lock when it is free now (a poisoned lock is still read: it holds plain data).
pub(crate) fn try_lock<T: ?Sized>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}
