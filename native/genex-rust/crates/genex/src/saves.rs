//! Save slots (`ctx.slots()`, `game.saves`, `game.save_section`, `game.save_world`): a G6 facade
//! contract stub (UIS-0, EXT-PLAN M1). UIS-9 fills it over genex-save; until then it is no game
//! API, its state is empty and its tick hooks do nothing, so `state()` and every checksum are
//! unchanged.

/// `game.saves` and its sections: what a save holds and how it migrates (UIS-9).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The runtime's pending save and load (UIS-9).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// Before a tick: swap in a load the last tick asked for.
    pub(crate) fn swap_in(&mut self, _setup: &Setup) {}

    /// At the end of a tick: write the save the tick asked for.
    pub(crate) fn end_of_tick(&mut self, _setup: &Setup) {}

    /// A new seed: nothing is pending.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}
}

/// `ctx.slots()`: the save slots a tick reads and asks to write (UIS-9).
#[derive(Clone, Copy, Debug)]
pub(crate) struct CtxSlots<'a>(pub(crate) std::marker::PhantomData<&'a State>);
