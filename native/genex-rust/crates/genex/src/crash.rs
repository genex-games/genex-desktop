//! Crash reports: a G6 facade contract stub (UIS-0, EXT-PLAN M1). PROF-5 fills it over genex-crash;
//! until then it is no game API, its state is empty and its tick hooks do nothing, so `state()` and
//! every checksum are unchanged.

/// The context a crash record carries (PROF-5).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// At the start of a tick: the tick a crash would name.
    pub(crate) fn enter_tick(&mut self, _tick: u64) {}
}
