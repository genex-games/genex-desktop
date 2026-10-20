//! Profiling (`genex::profile`): a G6 facade contract stub (UIS-0, EXT-PLAN M1). PROF-5 fills it
//! over genex-profile; until then it is no game API, its state is empty and its tick hooks do
//! nothing, so `state()` and every checksum are unchanged.

/// The runtime's frame recorder (PROF-5); display state, never in the checksum.
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// At the start of a tick: open the frame's scope.
    pub(crate) fn frame_begin(&mut self, _tick: u64) {}

    /// At the end of a tick: close the frame's scope.
    pub(crate) fn frame_end(&mut self, _tick: u64) {}
}
