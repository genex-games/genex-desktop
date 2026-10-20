//! Gameplay UI (`game.ui`): a G6 facade contract stub (UIS-0, EXT-PLAN M1). UIS-10 fills it over
//! genex-ui; until then it is no game API, its state is empty and its tick hooks do nothing, so
//! `state()` and every checksum are unchanged.

/// `game.ui`: the menus and widgets the game registers (UIS-10).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The gameplay UI's keyed state and focus (UIS-10).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// A new seed: menus close and focus resets.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}
}
