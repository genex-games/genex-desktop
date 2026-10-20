//! The input to replay a crash: INPUT's recorder registers a [`ReplaySource`] (its InputTrack ring)
//! and the hook asks it for the tail since the last seed. Neither the registry nor the source may
//! make the hook wait: both answer with `try_lock`, and a busy one gives a replay marked
//! `complete: false` with no track, so the record still names the seed and tick to start from.

use std::sync::{Arc, Mutex};

use crate::caps::CRASH_REPLAY_MAX_BYTES;
use crate::context::try_lock;
use crate::record::{CrashReplay, RecordContext};

/// The tail a source answers: the seed it starts from, the ticks it covers and its rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayTail {
    /// The seed the track starts from.
    pub seed: u64,
    /// The first tick the track covers.
    pub from_tick: u64,
    /// The last tick it covers.
    pub to_tick: u64,
    /// False when the ring overflowed or the oldest rows were dropped to fit.
    pub complete: bool,
    /// InputTrack rows, whole rows only.
    pub track: Vec<u8>,
}

/// What INPUT's recorder offers the hook: the tail since the last seed, without blocking.
pub trait ReplaySource: Send + Sync {
    /// The newest rows within `max_bytes` (dropping the oldest whole rows first), or None when the
    /// ring is busy right now. Must not block and must not panic.
    fn tail(&self, max_bytes: usize) -> Option<ReplayTail>;
}

impl<T: ReplaySource + ?Sized> ReplaySource for Arc<T> {
    fn tail(&self, max_bytes: usize) -> Option<ReplayTail> {
        (**self).tail(max_bytes)
    }
}

static SOURCE: Mutex<Option<Box<dyn ReplaySource>>> = Mutex::new(None);

/// Register the source the hook reads (replacing the one before).
pub fn set_replay_source(source: Box<dyn ReplaySource>) {
    let mut slot = SOURCE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *slot = Some(source);
}

/// The replay for a record at `at`: None with no source registered; a replay marked incomplete
/// with no track when the registry or the source is busy. Never waits.
pub fn read_tail(at: &RecordContext) -> Option<CrashReplay> {
    let Some(slot) = try_lock(&SOURCE) else { return Some(busy(at)) };
    let source = slot.as_deref()?;
    tail_from(source, at)
}

/// The replay `source` gives for a record at `at` (what [`read_tail`] does with the registered
/// one). A track over [`CRASH_REPLAY_MAX_BYTES`] is dropped (its rows cannot be cut here).
pub fn tail_from(source: &dyn ReplaySource, at: &RecordContext) -> Option<CrashReplay> {
    let Some(tail) = source.tail(CRASH_REPLAY_MAX_BYTES) else { return Some(busy(at)) };
    let fits = tail.track.len() <= CRASH_REPLAY_MAX_BYTES && tail.from_tick <= tail.to_tick;
    if !fits {
        return Some(CrashReplay { complete: false, track: Vec::new(), ..busy(at) });
    }
    Some(CrashReplay {
        seed: tail.seed,
        from_tick: tail.from_tick,
        to_tick: tail.to_tick,
        complete: tail.complete,
        track: tail.track,
    })
}

/// The replay of a busy source: where to start from, no rows.
fn busy(at: &RecordContext) -> CrashReplay {
    let tick = at.tick.unwrap_or(0);
    CrashReplay {
        seed: at.seed.map_or(0, u64::from),
        from_tick: tick,
        to_tick: tick,
        complete: false,
        track: Vec::new(),
    }
}
