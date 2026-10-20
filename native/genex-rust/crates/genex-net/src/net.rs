//! Net: the reads a game makes on `sim.net` and the writes it queues.
//!
//! Reads take `&self` and answer from the frame this tick consumed; writes take `&mut self`, are
//! checked against that same frame (so a refusal is deterministic) and leave after the tick. The
//! relay can still refuse later, through a `Control` event or a warning.

use serde_json::Value;

use crate::frame::{NetEvent, NetFrame, NetMatch, NetObject, NetPlayer, NetPose};
use crate::ids::{NetTicket, PlayerId, TicketCounter};
use crate::vocab::{
    NET_CHAT_CHARS_MAX, NET_CODE_CHARS_MAX, NET_DECIMALS_DEFAULT, NET_DECIMALS_MAX, NET_INTERP_DELAY_TICKS_DEFAULT, NET_INTERP_DELAY_TICKS_MAX,
    NET_OBJECTS_MAX, NET_PUBLISH_HZ_DEFAULT, NET_PUBLISH_HZ_MAX, NetError, NetErrorCode, NetMode, NetOffline, NetStatus, RESERVED_SHARED_PREFIX,
    is_reserved_event_type, limits, utf16_len,
};
use crate::writes::{MatchReport, NetMessage, NetRequest, NetSession, NetWrites, WriteQueue, check_payload, check_state};

/// Per-game net knobs; the defaults fit the feel checklist.
#[derive(Clone, Debug, PartialEq)]
pub struct NetConfig {
    publish_hz: u32,
    decimals: u32,
    interp_delay_ticks: u32,
}

impl NetConfig {
    /// Publish at 15 Hz, keep 3 decimals, smooth 6 ticks behind.
    pub fn new() -> NetConfig {
        NetConfig { publish_hz: NET_PUBLISH_HZ_DEFAULT, decimals: NET_DECIMALS_DEFAULT, interp_delay_ticks: NET_INTERP_DELAY_TICKS_DEFAULT }
    }

    /// How often coalesced states leave: 1..=30 Hz.
    pub fn publish_hz(mut self, hz: u32) -> NetConfig {
        self.publish_hz = hz;
        self
    }

    /// Digits numbers keep when they leave: 0..=6.
    pub fn decimals(mut self, digits: u32) -> NetConfig {
        self.decimals = digits;
        self
    }

    /// The sim-time smoothing delay: 1..=30 ticks.
    pub fn interp_delay_ticks(mut self, ticks: u32) -> NetConfig {
        self.interp_delay_ticks = ticks;
        self
    }

    /// The publish rate.
    pub fn publish_rate(&self) -> u32 {
        self.publish_hz
    }

    /// The digits kept.
    pub fn digits(&self) -> u32 {
        self.decimals
    }

    /// The smoothing delay.
    pub fn delay_ticks(&self) -> u32 {
        self.interp_delay_ticks
    }

    /// What is outside the caps, for the install refusal `net-config-invalid`; `None` when valid.
    pub fn problem(&self) -> Option<String> {
        if !(1..=NET_PUBLISH_HZ_MAX).contains(&self.publish_hz) {
            return Some(format!("publish_hz {} is outside 1..={NET_PUBLISH_HZ_MAX}", self.publish_hz));
        }
        if self.decimals > NET_DECIMALS_MAX {
            return Some(format!("decimals {} is outside 0..={NET_DECIMALS_MAX}", self.decimals));
        }
        if !(1..=NET_INTERP_DELAY_TICKS_MAX).contains(&self.interp_delay_ticks) {
            return Some(format!("interp_delay_ticks {} is outside 1..={NET_INTERP_DELAY_TICKS_MAX}", self.interp_delay_ticks));
        }
        None
    }
}

impl Default for NetConfig {
    fn default() -> NetConfig {
        NetConfig::new()
    }
}

/// `sim.net`: the frame this tick consumed and the writes it queued.
#[derive(Clone, Debug)]
pub struct Net {
    frame: NetFrame,
    config: NetConfig,
    queue: WriteQueue,
    tickets: TicketCounter,
}

fn refuse<T>(code: NetErrorCode, detail: impl Into<String>) -> Result<T, NetError> {
    Err(NetError::new(code, detail))
}

/// A private lobby code: 1..=64 of `[A-Za-z0-9_-]`.
fn is_lobby_code(code: &str) -> bool {
    let well_formed = code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    !code.is_empty() && code.len() <= NET_CODE_CHARS_MAX && well_formed
}

impl Net {
    /// A seat that has consumed no frame yet: offline, for the reason the mode implies.
    pub fn fresh(mode: NetMode, config: &NetConfig) -> Net {
        let reason = (mode == NetMode::Off).then_some(NetOffline::Disabled);
        Net { frame: NetFrame::offline(mode, reason), config: config.clone(), queue: WriteQueue::default(), tickets: TicketCounter::default() }
    }

    /// The runtime hands this tick's frame over before the update hooks run.
    pub fn begin(&mut self, frame: NetFrame) {
        self.frame = frame;
    }

    /// The runtime takes this tick's writes after the hooks ran.
    pub fn end(&mut self) -> NetWrites {
        self.queue.flush(self.frame.tick(), self.config.publish_hz, self.config.decimals)
    }

    /// The frame this tick consumed.
    pub fn frame(&self) -> &NetFrame {
        &self.frame
    }

    /// The knobs this seat runs with.
    pub fn config(&self) -> &NetConfig {
        &self.config
    }

    // ---- reads -----------------------------------------------------------------------------

    /// Which backend the build chose.
    pub fn mode(&self) -> NetMode {
        self.frame.mode()
    }

    /// Where the seat stands.
    pub fn status(&self) -> NetStatus {
        self.frame.status()
    }

    /// Why the status is offline or closed.
    pub fn offline_reason(&self) -> Option<NetOffline> {
        self.frame.offline_reason()
    }

    /// This client's seat, once seated.
    pub fn me(&self) -> Option<&PlayerId> {
        self.frame.me()
    }

    /// Every seated player, me included, in id order.
    pub fn players(&self) -> impl Iterator<Item = &NetPlayer> {
        self.frame.players()
    }

    /// Every seated player but me, in id order.
    pub fn remotes(&self) -> impl Iterator<Item = &NetPlayer> {
        self.frame.remotes()
    }

    /// One seat.
    pub fn player(&self, id: &PlayerId) -> Option<&NetPlayer> {
        self.frame.player(id)
    }

    /// The quorum count: seats not held by the reconnect grace.
    pub fn connected(&self) -> usize {
        self.frame.connected()
    }

    /// Every shared object, in id order.
    pub fn objects(&self) -> impl Iterator<Item = &NetObject> {
        self.frame.objects()
    }

    /// One object.
    pub fn object(&self, id: &str) -> Option<&NetObject> {
        self.frame.object(id)
    }

    /// One shared value.
    pub fn shared(&self, key: &str) -> Option<&Value> {
        self.frame.shared(key)
    }

    /// Every shared key, in key order.
    pub fn shared_keys(&self) -> impl Iterator<Item = &str> {
        self.frame.shared_keys()
    }

    /// The host; `None` while authority is not settled (do not start host work).
    pub fn host(&self) -> Option<&PlayerId> {
        self.frame.host()
    }

    /// Joined, settled, and the host is me.
    pub fn is_host(&self) -> bool {
        self.frame.is_host()
    }

    /// Whether the room takes new players.
    pub fn room_open(&self) -> bool {
        self.frame.room_open()
    }

    /// This tick's events, in arrival order.
    pub fn events(&self) -> &[NetEvent] {
        self.frame.events()
    }

    /// The matchmade seat's standing.
    pub fn matchmaking(&self) -> Option<&NetMatch> {
        self.frame.matchmaking()
    }

    /// The private lobby's code.
    pub fn lobby_code(&self) -> Option<&str> {
        self.frame.lobby_code()
    }

    /// The relay clock as sampled at the cut (deadlines).
    pub fn server_ms(&self) -> Option<f64> {
        self.frame.server_ms()
    }

    // ---- writes: session -------------------------------------------------------------------

    /// Join the game's shared room (a commitment point: never on boot behind a menu).
    pub fn connect(&mut self) {
        self.queue.now().session.push(NetSession::Connect);
    }

    /// Search through the `[net].matchmaking` preset.
    pub fn matchmake(&mut self) {
        self.queue.now().session.push(NetSession::Matchmake);
    }

    /// Open a private lobby; its code arrives in `lobby_code()`.
    pub fn create_private(&mut self) {
        self.queue.now().session.push(NetSession::CreatePrivate);
    }

    /// Join a friend's private lobby by its code.
    pub fn join_private(&mut self, code: &str) -> Result<(), NetError> {
        if !is_lobby_code(code) {
            return refuse(NetErrorCode::CodeInvalid, format!("a lobby code is 1..={NET_CODE_CHARS_MAX} of [A-Za-z0-9_-]"));
        }
        self.queue.now().session.push(NetSession::JoinPrivate(code.to_owned()));
        Ok(())
    }

    /// Leave the queue or the match seat.
    pub fn cancel(&mut self) {
        self.queue.now().session.push(NetSession::Cancel);
    }

    /// Leave on purpose: no auto-reconnect.
    pub fn leave(&mut self) {
        self.queue.now().session.push(NetSession::Leave);
    }

    // ---- writes: state ---------------------------------------------------------------------

    fn joined(&self) -> Result<(), NetError> {
        if self.frame.status() == NetStatus::Joined {
            return Ok(());
        }
        refuse(NetErrorCode::NotJoined, format!("the seat is {}", self.frame.status().wire()))
    }

    fn host_only(&self) -> Result<(), NetError> {
        self.joined()?;
        if self.frame.is_host() {
            return Ok(());
        }
        refuse(NetErrorCode::NotHost, "only the host may do this")
    }

    fn owned(&self, id: &str) -> Result<(), NetError> {
        self.joined()?;
        let mine = self.frame.object(id).is_some_and(NetObject::mine);
        if mine {
            return Ok(());
        }
        refuse(NetErrorCode::NotOwner, format!("object `{id}` is not mine"))
    }

    fn object_id(id: &str) -> Result<(), NetError> {
        let units = utf16_len(id);
        if units == 0 || units > limits::MAX_OBJECT_ID_CHARS {
            return refuse(NetErrorCode::MessageTooLarge, format!("an object id is 1..={} characters", limits::MAX_OBJECT_ID_CHARS));
        }
        Ok(())
    }

    /// My state, coalesced: the latest call leaves on the next publish tick.
    pub fn set_me(&mut self, state: Value) -> Result<(), NetError> {
        self.joined()?;
        check_state(&state, None, limits::MAX_STATE_BYTES)?;
        self.queue.set_me(state, None);
        Ok(())
    }

    /// My pose plus extra state, coalesced like `set_me`.
    pub fn set_me_pose(&mut self, pose: NetPose, extra: Value) -> Result<(), NetError> {
        self.joined()?;
        check_state(&extra, Some(&pose), limits::MAX_STATE_BYTES)?;
        self.queue.set_me(extra, Some(pose));
        Ok(())
    }

    /// My state as a discontinuity (teleport, respawn): it leaves this tick.
    pub fn snap_me(&mut self, state: Value) -> Result<(), NetError> {
        self.joined()?;
        check_state(&state, None, limits::MAX_STATE_BYTES)?;
        self.queue.snap_me(state, None);
        Ok(())
    }

    /// An owned object's state, coalesced.
    pub fn set_object(&mut self, id: &str, state: Value) -> Result<(), NetError> {
        self.owned(id)?;
        check_state(&state, None, limits::MAX_OBJECT_STATE_BYTES)?;
        self.queue.set_object(id, state);
        Ok(())
    }

    /// An owned object's state as a discontinuity: it leaves this tick.
    pub fn snap_object(&mut self, id: &str, state: Value) -> Result<(), NetError> {
        self.owned(id)?;
        check_state(&state, None, limits::MAX_OBJECT_STATE_BYTES)?;
        self.queue.snap_object(id, state);
        Ok(())
    }

    // ---- writes: requests ------------------------------------------------------------------

    fn claim_with(&mut self, id: &str, as_host: bool) -> Result<NetTicket, NetError> {
        self.joined()?;
        Self::object_id(id)?;
        if as_host && !self.frame.is_host() {
            return refuse(NetErrorCode::NotHost, "only the host may claim as host");
        }
        let at_cap = self.frame.object(id).is_none() && self.frame.object_count() >= NET_OBJECTS_MAX;
        if at_cap {
            return refuse(NetErrorCode::ObjectCap, format!("the room holds {NET_OBJECTS_MAX} objects"));
        }
        let ticket = self.tickets.mint();
        self.queue.now().requests.push(NetRequest::Claim { ticket, id: id.to_owned(), as_host });
        Ok(ticket)
    }

    /// Ask to own an object; the answer arrives as a `Control` event with the ticket.
    pub fn claim(&mut self, id: &str) -> Result<NetTicket, NetError> {
        self.claim_with(id, false)
    }

    /// The host's claim (seed, reset, adoption).
    pub fn claim_as_host(&mut self, id: &str) -> Result<NetTicket, NetError> {
        self.claim_with(id, true)
    }

    /// Give an owned object up.
    pub fn release(&mut self, id: &str) -> Result<NetTicket, NetError> {
        self.owned(id)?;
        self.queue.forget_object(id);
        let ticket = self.tickets.mint();
        self.queue.now().requests.push(NetRequest::Release { ticket, id: id.to_owned() });
        Ok(ticket)
    }

    /// Remove an owned object.
    pub fn remove(&mut self, id: &str) -> Result<NetTicket, NetError> {
        self.owned(id)?;
        self.queue.forget_object(id);
        let ticket = self.tickets.mint();
        self.queue.now().requests.push(NetRequest::Remove { ticket, id: id.to_owned() });
        Ok(ticket)
    }

    // ---- writes: room ----------------------------------------------------------------------

    /// Set a shared key (host only).
    pub fn set_shared(&mut self, key: &str, value: Value) -> Result<(), NetError> {
        self.host_only()?;
        let units = utf16_len(key);
        if units == 0 || key.starts_with(RESERVED_SHARED_PREFIX) {
            return refuse(NetErrorCode::MessageReserved, format!("shared key `{key}` is empty or reserved"));
        }
        if units > limits::MAX_SHARED_KEY_CHARS {
            return refuse(NetErrorCode::MessageTooLarge, format!("a shared key is at most {} characters", limits::MAX_SHARED_KEY_CHARS));
        }
        check_payload(&value, limits::MAX_SHARED_VALUE_BYTES, "the shared value")?;
        self.queue.now().shared.push((key.to_owned(), value));
        Ok(())
    }

    /// A message to every other player (never echoes to me).
    pub fn send(&mut self, kind: &str, payload: Value) -> Result<(), NetError> {
        if kind.is_empty() || is_reserved_event_type(kind) {
            return refuse(NetErrorCode::MessageReserved, format!("message type `{kind}` belongs to the relay"));
        }
        if utf16_len(kind) > limits::MAX_EVENT_TYPE_CHARS {
            return refuse(NetErrorCode::MessageTooLarge, format!("a message type is at most {} characters", limits::MAX_EVENT_TYPE_CHARS));
        }
        self.joined()?;
        check_payload(&payload, limits::MAX_EVENT_BYTES, "the payload")?;
        self.queue.now().messages.push(NetMessage { kind: kind.to_owned(), payload });
        Ok(())
    }

    /// An input for the host (the protocol's input channel; only the host receives it).
    pub fn send_to_host(&mut self, payload: Value) -> Result<(), NetError> {
        self.joined()?;
        check_payload(&payload, limits::MAX_EVENT_BYTES, "the input")?;
        self.queue.now().host_inputs.push(payload);
        Ok(())
    }

    /// Open or close the room to new players (host only).
    pub fn set_room_open(&mut self, open: bool) -> Result<(), NetError> {
        self.host_only()?;
        self.queue.now().room_open = Some(open);
        Ok(())
    }

    /// A chat line (echoes to me).
    pub fn chat(&mut self, text: &str) -> Result<(), NetError> {
        self.joined()?;
        if utf16_len(text) > NET_CHAT_CHARS_MAX {
            return refuse(NetErrorCode::ChatTooLong, format!("a chat line is at most {NET_CHAT_CHARS_MAX} characters"));
        }
        self.queue.now().chat.push(text.to_owned());
        Ok(())
    }

    /// A matchmade round's report.
    pub fn report(&mut self, report: MatchReport) -> Result<(), NetError> {
        self.joined()?;
        self.queue.now().reports.push(report);
        Ok(())
    }

    /// Forget the frame, the queue and the ticket counter (a reseed); the next cut refills the view.
    pub fn reseed(&mut self, mode: NetMode) {
        *self = Net::fresh(mode, &self.config);
    }
}
