//! Touch controls (`game.touch_controls`): a G6 facade contract stub (UIS-0, EXT-PLAN M1). IN-11
//! fills it over genex-input's touch layer; until then it is no game API, its state is empty and
//! its tick hooks do nothing, so `state()` and every checksum are unchanged.

/// `game.touch_controls`: the on-screen sticks and buttons (IN-11).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The touch controls' state: which touch holds which control (IN-11).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// Tick step 3: turn this tick's touches into control presses.
    pub(crate) fn step(&mut self, _setup: &Setup, _input: &crate::input::TickInput) {}

    /// A new seed: no touch holds a control.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}
}
