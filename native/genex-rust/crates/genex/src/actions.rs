//! Input actions (`ctx.actions`, `game.input`): a G6 facade contract stub (UIS-0, EXT-PLAN M1).
//! IN-11 fills it over genex-input; until then it is no game API, its state is empty and its tick
//! hooks do nothing, so `state()` and every checksum are unchanged.

/// `game.input`: the game's action map and contexts (IN-11).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The runtime's action state: devices seen, the evaluated actions (IN-11).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// Tick step 1: take the tick's merged device input.
    pub(crate) fn merge(&mut self, _setup: &Setup, _input: &crate::input::TickInput) {}

    /// Tick step 4: the device tracker (which device the player last used).
    pub(crate) fn track_devices(&mut self, _setup: &Setup, _input: &crate::input::TickInput) {}

    /// Tick step 5: evaluate the action map for this tick.
    pub(crate) fn evaluate(&mut self, _setup: &Setup) {}

    /// A new seed: the actions start released.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}

    /// `state().__input`, only while `game.input` is registered.
    pub(crate) fn runtime_key(&self, _setup: &Setup, _state: &mut genex_core::json::Value) {}
}

impl State {
    /// What the tick's hooks read actions through.
    pub(crate) fn ctx(&self) -> CtxActions<'_> {
        CtxActions(std::marker::PhantomData)
    }
}

/// `ctx.actions`: the tick's evaluated actions (IN-11).
#[derive(Clone, Copy, Debug)]
pub(crate) struct CtxActions<'a>(std::marker::PhantomData<&'a State>);
