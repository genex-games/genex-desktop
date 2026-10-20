//! Sounds, music and spatial audio (`ctx.audio`, `game.audio`): a G6 facade contract stub (UIS-0,
//! EXT-PLAN M1). AU-7 fills it over genex-audio; until then it is no game API, its state is empty
//! and its tick hooks do nothing, so `state()` and every checksum are unchanged.

/// `game.audio`: the buses, zones and voice limits set once at install (AU-7).
#[derive(Debug, Default)]
pub(crate) struct Setup;

/// The runtime's audio queue and director (AU-7).
#[derive(Debug, Default)]
pub(crate) struct State;

impl State {
    /// After the update hooks, the UI hooks and the physics step: apply the tick's audio commands.
    pub(crate) fn apply(&mut self, _setup: &Setup) {}

    /// A new seed: every voice stops and the queue empties.
    pub(crate) fn reset(&mut self, _setup: &Setup) {}
}

impl State {
    /// What the tick's hooks play through.
    pub(crate) fn ctx(&self) -> CtxAudio<'_> {
        CtxAudio(std::marker::PhantomData)
    }
}

/// `ctx.audio`: the queue the tick's hooks write (AU-7).
#[derive(Clone, Copy, Debug)]
pub(crate) struct CtxAudio<'a>(std::marker::PhantomData<&'a State>);
