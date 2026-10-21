//! The input journal (G6 input, IN-12): every tick's merged input since the seed (or an input
//! restore's anchor), kept within genex-input's 1 MiB cap, while `game.input` is registered.
//!
//! The journal records what the merger handed the tick, before the HUD's focus gating (the gating
//! is recomputed on replay from the same rows), so `Runtime::replay` on a fresh runtime with the
//! track's seed and bindings reproduces every checksum. A crash record takes its tail
//! ([`InputJournalView::track_within`]); `state().__input.journal` shows its size.

use genex_core::input::{PadStates, TickInput as CoreTick};
use genex_input::journal::{InputJournal, JournalView};
use genex_input::track::{InputTrack, TrackHeader};
use serde_json::{Value, json};

/// What the runtime's journal holds (host glue: crash records, judges, replays).
#[derive(Clone, Copy, Debug)]
pub struct InputJournalView<'a> {
    journal: Option<&'a InputJournal>,
}

impl InputJournalView<'_> {
    /// Ticks, bytes and completeness (all zero without `game.input`).
    pub fn view(&self) -> JournalView {
        self.journal.map(InputJournal::view).unwrap_or_default()
    }

    /// Everything the journal holds as a track; `None` without `game.input`.
    pub fn track(&self) -> Option<InputTrack> {
        self.journal.map(InputJournal::track)
    }

    /// The newest ticks that encode within `bytes_max` (a crash record's tail).
    pub fn track_within(&self, bytes_max: usize) -> Option<InputTrack> {
        self.journal.map(|journal| journal.track_within(bytes_max))
    }
}

/// The runtime's journal: none until the first seed of a game with `game.input`.
#[derive(Debug, Default)]
pub(crate) struct State {
    journal: Option<InputJournal>,
    /// The pads as the last recorded tick left them (a snapshot anchor's starting point).
    last_pads: PadStates,
}

impl State {
    /// Journal under `header` (the seed, contract, world and bindings) from tick `tick`: from the
    /// seed at tick 0, else anchored there like an input snapshot (the bindings changed mid-run, so
    /// a replay starts from that tick's restored state).
    pub(crate) fn start(&mut self, header: TrackHeader, tick: u64) {
        let mut journal = InputJournal::new(header);
        if tick > 0 {
            journal.anchor_snapshot(tick, self.last_pads);
        } else {
            self.last_pads = PadStates::default();
        }
        self.journal = Some(journal);
    }

    /// An input restore: journal from the snapshot's tick, the pads as the last tick left them.
    pub(crate) fn anchor(&mut self, tick: u64) {
        if let Some(journal) = self.journal.as_mut() {
            journal.anchor_snapshot(tick, self.last_pads);
        }
    }

    /// Tick step 6: record the tick's merged input.
    pub(crate) fn record(&mut self, tick: u64, input: &CoreTick) {
        if let Some(journal) = self.journal.as_mut() {
            journal.record(tick, input);
            self.last_pads = *input.pads.states();
        }
    }

    /// A seed of a game without `game.input` keeps no journal.
    pub(crate) fn reset(&mut self) {
        self.journal = None;
        self.last_pads = PadStates::default();
    }

    /// The journal, for host glue.
    pub(crate) fn view(&self) -> InputJournalView<'_> {
        InputJournalView { journal: self.journal.as_ref() }
    }

    /// `state().__input.journal`.
    pub(crate) fn runtime_value(&self) -> Value {
        let view = self.view().view();
        json!({ "ticks": view.ticks, "bytes": view.bytes, "complete": view.complete })
    }
}
