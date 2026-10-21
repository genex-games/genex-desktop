//! The G6 game systems' seams in the facade (UIS-0, EXT-PLAN M1): input, touch controls, the input
//! journal, audio, saves, gameplay UI, settings, profiling, crash reports and multiplayer. The game
//! holds one [`G6Setup`] (each area's `impl Game` block writes its own field), the runtime one
//! [`G6`], and `runtime.rs` calls each area's hooks at its place in the tick, so a later area fills
//! its own module and touches `runtime.rs`, `ctx.rs` and `game.rs` only through small hunks. Every
//! hook is a no-op until its area lands.

use crate::{actions, actions_journal, actions_touch, audio, crash, net, profile, saves, settings, ui};
use genex_core::json::Value as CoreValue;

/// What a game registers for the G6 areas (the `Game` field `g6`).
#[derive(Debug, Default)]
pub(crate) struct G6Setup {
    /// `game.input` (IN-11).
    pub(crate) input: actions::Setup,
    /// `game.touch_controls` (IN-11).
    pub(crate) touch: actions_touch::Setup,
    /// `game.audio` (AU-7).
    pub(crate) audio: audio::Setup,
    /// `game.saves`, `game.save_section`, `game.save_world` (UIS-9).
    pub(crate) saves: saves::Setup,
    /// `game.ui` (UIS-10).
    pub(crate) ui: ui::Setup,
    /// `game.settings` (UIS-11).
    pub(crate) settings: settings::Setup,
    /// `game.net` (MP-4a).
    pub(crate) net: net::Setup,
}

/// The runtime's G6 state (the runtime field `g6`).
#[derive(Debug, Default)]
pub(crate) struct G6 {
    /// Evaluated actions.
    pub(crate) input: actions::State,
    /// Touch controls.
    pub(crate) touch: actions_touch::State,
    /// The input journal.
    pub(crate) journal: actions_journal::State,
    /// The audio queue.
    pub(crate) audio: audio::State,
    /// Pending saves and loads.
    pub(crate) saves: saves::State,
    /// Gameplay UI state.
    pub(crate) ui: ui::State,
    /// The person's settings.
    pub(crate) settings: settings::State,
    /// The frame recorder.
    pub(crate) profile: profile::State,
    /// The crash context.
    pub(crate) crash: crash::State,
    /// The net backend.
    pub(crate) net: net::State,
}

impl G6 {
    /// A new seed: each area resets in turn.
    pub(crate) fn reset(&mut self, setup: &G6Setup) {
        self.input.reset(&setup.input);
        self.touch.reset(&setup.touch);
        self.journal.reset();
        self.audio.reset(&setup.audio);
        self.saves.reset(&setup.saves);
        self.ui.reset(&setup.ui);
        self.settings.reset(&setup.settings);
        self.net.reset(&setup.net);
    }

    /// `g6_tick_begin`: before the tick's input, name the tick for a crash record and open its
    /// profile frame. A pending load swapped in before the streaming commit (`saves::swap_in`).
    pub(crate) fn tick_begin(&mut self, _setup: &G6Setup, tick: u64) {
        self.crash.enter_tick(tick);
        self.profile.frame_begin(tick);
    }

    /// `g6_tick_end`: after the physics step and the net flush, apply the tick's audio, then close
    /// the profile frame. The tick's saves are written once the tick has counted
    /// (`saves::end_of_tick`).
    pub(crate) fn tick_end(&mut self, setup: &G6Setup, tick: u64) {
        self.audio.apply(&setup.audio);
        self.profile.frame_end(tick);
    }

    /// The G6 runtime keys (`__input`, `__net`), `volatile.saves` and `volatile.profile`, each only
    /// while its area is registered (the profile once a shell started its recorder).
    pub(crate) fn runtime_keys(&self, setup: &G6Setup, state: &mut CoreValue) {
        self.input.runtime_key(&setup.input, state);
        self.net.runtime_key(&setup.net, state);
        self.saves.volatile_key(&setup.saves, state);
        self.profile.volatile_key(state);
        self.settings.volatile_key(state);
    }
}
