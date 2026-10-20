//! The input journal: a G6 facade contract stub (UIS-0, EXT-PLAN M1). IN-12 fills it over genex-
//! input's journal; until then it is no game API, its state is empty and its tick hooks do nothing,
//! so `state()` and every checksum are unchanged.

/// The journal of the actions each tick evaluated, for replays and judges (IN-12).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// Tick step 6: record the tick's evaluated actions.
    pub(crate) fn record(&mut self, _actions: &crate::actions::State) {}

    /// A new seed starts an empty journal.
    pub(crate) fn reset(&mut self) {}
}
