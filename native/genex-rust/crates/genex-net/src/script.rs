//! NetScript: a demo's scripted remote players, claims, latency, reconnects and closes over Loopback.
//!
//! A script call schedules its effect on the Loopback backend: remote content (joins, leaves,
//! states, objects, messages, chat, shared keys) arrives `latency_ticks` after the tick about to be
//! cut, control calls (host, claim policy, reconnects, closes, match status) on that tick itself.
//! Outside Loopback every call is a no-op, counted for `__net.scriptIgnored`.

use serde_json::Value;

use crate::ids::PlayerId;
use crate::loopback::LoopbackBackend;
use crate::vocab::{MatchStatus, NetClose};

/// How the Loopback room answers this seat's claims.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum NetClaimPolicy {
    /// `accepted` (or `already-owner`) on the next tick: the default.
    #[default]
    Accept,
    /// `held`, retry from the claim's tick plus `ticks`.
    Held {
        /// How long the hold lasts.
        ticks: u32,
    },
    /// `not-host`: the room refuses.
    NotHost,
}

enum Target<'a> {
    Loopback(&'a mut LoopbackBackend),
    Ignored(&'a mut u64),
}

/// The handle a demo drives remote players through (`DemoDriver::net()`).
pub struct NetScript<'a> {
    target: Target<'a>,
}

impl<'a> NetScript<'a> {
    /// A script over a Loopback room.
    pub fn loopback(backend: &'a mut LoopbackBackend) -> NetScript<'a> {
        NetScript { target: Target::Loopback(backend) }
    }

    /// A script outside Loopback: every call adds one to `counter` and does nothing else.
    pub fn ignored(counter: &'a mut u64) -> NetScript<'a> {
        NetScript { target: Target::Ignored(counter) }
    }

    /// Whether calls reach a Loopback room.
    pub fn is_live(&self) -> bool {
        matches!(self.target, Target::Loopback(_))
    }

    fn with(&mut self, call: impl FnOnce(&mut LoopbackBackend)) {
        match &mut self.target {
            Target::Loopback(backend) => call(backend),
            Target::Ignored(counter) => **counter += 1,
        }
    }

    /// Seat a remote player named `name`: `remote-1`, `remote-2`, ... in call order since the seed.
    /// Outside Loopback the id is empty and nobody is seated.
    pub fn join(&mut self, name: &str) -> PlayerId {
        let mut id = PlayerId::new("");
        self.with(|backend| id = backend.script_join(name));
        id
    }

    /// The player leaves for good; their objects lose their owner.
    pub fn leave(&mut self, player: &PlayerId) {
        self.with(|backend| backend.script_leave(player));
    }

    /// The player's connection drops: the reconnect grace holds the seat (`connected` false).
    pub fn drop_connection(&mut self, player: &PlayerId) {
        self.with(|backend| backend.script_drop(player));
    }

    /// The player publishes `state` (smoothed for drawing, latest for gameplay).
    pub fn set_state(&mut self, player: &PlayerId, state: Value) {
        self.with(|backend| backend.script_state(player, state, false));
    }

    /// The player publishes `state` as a discontinuity: it is placed with no glide.
    pub fn snap_state(&mut self, player: &PlayerId, state: Value) {
        self.with(|backend| backend.script_state(player, state, true));
    }

    /// `owner` publishes `state` for `object` (taking it over if someone else owned it).
    pub fn set_object(&mut self, object: &str, owner: &PlayerId, state: Value) {
        self.with(|backend| backend.script_object(object, owner, state));
    }

    /// `from` sends a game message to everyone else.
    pub fn send(&mut self, from: &PlayerId, kind: &str, payload: Value) {
        self.with(|backend| backend.script_message(from, kind, payload));
    }

    /// `from` sends an input to the host (arrives only while I am the host).
    pub fn send_to_host(&mut self, from: &PlayerId, payload: Value) {
        self.with(|backend| backend.script_host_input(from, payload));
    }

    /// `from` says `text` in chat.
    pub fn chat(&mut self, from: &PlayerId, text: &str) {
        self.with(|backend| backend.script_chat(from, text));
    }

    /// The host sets a shared key.
    pub fn set_shared(&mut self, key: &str, value: Value) {
        self.with(|backend| backend.script_shared(key, value));
    }

    /// Make `player` the host; `None` makes me the host.
    pub fn make_host(&mut self, player: Option<&PlayerId>) {
        self.with(|backend| backend.script_host(player));
    }

    /// How the room answers my claims from now on.
    pub fn answer_claims(&mut self, policy: NetClaimPolicy) {
        self.with(|backend| backend.script_policy(policy));
    }

    /// The arrival delay of scripted remote content from now on, in ticks.
    pub fn latency_ticks(&mut self, ticks: u32) {
        self.with(|backend| backend.script_latency(ticks));
    }

    /// My connection drops for `ticks`: `reconnecting`, then `reconnected` and joined again.
    pub fn reconnect_for(&mut self, ticks: u32) {
        self.with(|backend| backend.script_reconnect(ticks));
    }

    /// The room closes my seat for `reason`.
    pub fn close(&mut self, reason: NetClose) {
        self.with(|backend| backend.script_close(reason));
    }

    /// The matchmade seat moves to `status`.
    pub fn match_status(&mut self, status: MatchStatus) {
        self.with(|backend| backend.script_match(status));
    }
}
