//! Multiplayer (`sim.net`, `game.net`): a G6 facade contract stub (UIS-0, EXT-PLAN M1). MP-4a fills
//! it over genex-net behind the `net` features; until then it is no game API, its state is empty
//! and its tick hooks do nothing, so `state()` and every checksum are unchanged.

/// `game.net`: the session the game joins (MP-4a).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The runtime's backend and journal (MP-4a).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// Before the update hooks: cut this tick's net frame into `sim.net`.
    pub(crate) fn cut(&mut self, _setup: &Setup, _net: &mut SimNet) {}

    /// After the physics step: flush the writes the tick queued.
    pub(crate) fn flush(&mut self, _setup: &Setup, _net: &mut SimNet) {}

    /// A new seed: the session starts over.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}

    /// `state().__net`, only while `game.net` is registered.
    pub(crate) fn runtime_key(&self, _setup: &Setup, _state: &mut genex_core::json::Value) {}
}

/// `sim.net`: the tick's net frame and its queued writes, owned by the runtime like `sim.nav`
/// (MP-4a).
#[derive(Debug, Default)]
pub(crate) struct SimNet;
