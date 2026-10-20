//! Game settings (`game.settings`): a G6 facade contract stub (UIS-0, EXT-PLAN M1). UIS-10 fills it
//! over genex-ui's settings schema; until then it is no game API, its state is empty and its tick
//! hooks do nothing, so `state()` and every checksum are unchanged.

/// `game.settings`: the typed options the settings menu shows (UIS-10).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The person's settings as the runtime holds them (UIS-10).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// A new seed keeps the person's settings (they are not simulation state).
    pub(crate) fn reset(&mut self, _setup: &Setup) {}
}
