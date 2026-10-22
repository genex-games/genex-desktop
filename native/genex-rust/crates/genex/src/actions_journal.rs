//! The input journal (G6 input, IN-12): every tick's merged input since the seed (or an input
//! restore's anchor), kept within genex-input's 1 MiB cap, while `game.input` is registered.
//!
//! The journal records what the merger handed the tick, before the HUD's focus gating (the gating
//! is recomputed on replay from the same rows), so `Runtime::replay` on a fresh runtime with the
//! track's seed and bindings reproduces every checksum. A crash record takes its tail
//! ([`InputJournalView::track_within`]): each seed registers the journal as the crash hook's
//! replay source (PROF-9), which reads it with `try_lock` only, so a record's `replay` carries the
//! newest ticks within its cap. `state().__input.journal` shows its size.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use genex_core::input::{PadStates, TickInput as CoreTick};
use genex_crash::{ReplaySource, ReplayTail};
use genex_input::journal::{InputJournal, JournalView};
use genex_input::track::{InputTrack, TrackHeader};
use serde_json::{Value, json};

/// The journal behind its lock: the runtime writes it each tick, the crash hook reads it.
type Shared = Mutex<Option<InputJournal>>;

/// What the runtime's journal holds (host glue: crash records, judges, replays).
#[derive(Debug)]
pub struct InputJournalView<'a> {
    journal: MutexGuard<'a, Option<InputJournal>>,
}

impl InputJournalView<'_> {
    /// Ticks, bytes and completeness (all zero without `game.input`).
    pub fn view(&self) -> JournalView {
        self.journal.as_ref().map(InputJournal::view).unwrap_or_default()
    }

    /// Everything the journal holds as a track; `None` without `game.input`.
    pub fn track(&self) -> Option<InputTrack> {
        self.journal.as_ref().map(InputJournal::track)
    }

    /// The newest ticks that encode within `bytes_max` (a crash record's tail).
    pub fn track_within(&self, bytes_max: usize) -> Option<InputTrack> {
        self.journal.as_ref().map(|journal| journal.track_within(bytes_max))
    }
}

/// The crash hook's replay source: the journal's newest ticks within the record's cap. It never
/// waits: a journal locked right now (a panic inside the tick's own record step) or one whose
/// runtime is gone answers None, and the record says `complete: false`.
struct JournalSource(Weak<Shared>);

impl ReplaySource for JournalSource {
    fn tail(&self, max_bytes: usize) -> Option<ReplayTail> {
        let shared = self.0.upgrade()?;
        let slot = shared.try_lock().ok()?;
        let track = slot.as_ref()?.track_within(max_bytes);
        let from_tick = track.start_tick();
        let to_tick = (from_tick + track.ticks()).saturating_sub(1);
        Some(ReplayTail { seed: u64::from(track.header().seed), from_tick, to_tick, complete: track.complete(), track: track.encode() })
    }
}

/// The runtime's journal: none until the first seed of a game with `game.input`.
#[derive(Debug, Default)]
pub(crate) struct State {
    journal: Arc<Shared>,
    /// The pads as the last recorded tick left them (a snapshot anchor's starting point).
    last_pads: PadStates,
}

impl State {
    /// The journal's slot (a poisoned lock is still the journal: a panic never leaves it torn).
    fn slot(&self) -> MutexGuard<'_, Option<InputJournal>> {
        self.journal.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Journal under `header` (the seed, contract, world and bindings) from tick `tick`: from the
    /// seed at tick 0, else anchored there like an input snapshot (the bindings changed mid-run, so
    /// a replay starts from that tick's restored state). The crash hook replays from it.
    pub(crate) fn start(&mut self, header: TrackHeader, tick: u64) {
        let mut journal = InputJournal::new(header);
        if tick > 0 {
            journal.anchor_snapshot(tick, self.last_pads);
        } else {
            self.last_pads = PadStates::default();
        }
        *self.slot() = Some(journal);
        genex_crash::set_replay_source(Box::new(JournalSource(Arc::downgrade(&self.journal))));
    }

    /// An input restore: journal from the snapshot's tick, the pads as the last tick left them.
    pub(crate) fn anchor(&mut self, tick: u64) {
        let last_pads = self.last_pads;
        if let Some(journal) = self.slot().as_mut() {
            journal.anchor_snapshot(tick, last_pads);
        }
    }

    /// Tick step 6: record the tick's merged input.
    pub(crate) fn record(&mut self, tick: u64, input: &CoreTick) {
        let recorded = match self.slot().as_mut() {
            Some(journal) => {
                journal.record(tick, input);
                true
            }
            None => false,
        };
        if recorded {
            self.last_pads = *input.pads.states();
        }
    }

    /// A seed of a game without `game.input` keeps no journal.
    pub(crate) fn reset(&mut self) {
        *self.slot() = None;
        self.last_pads = PadStates::default();
    }

    /// The journal, for host glue.
    pub(crate) fn view(&self) -> InputJournalView<'_> {
        InputJournalView { journal: self.slot() }
    }

    /// `state().__input.journal`.
    pub(crate) fn runtime_value(&self) -> Value {
        let view = self.view().view();
        json!({ "ticks": view.ticks, "bytes": view.bytes, "complete": view.complete })
    }
}
