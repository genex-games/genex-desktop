//! The Relay backend over the vendored genex-multiplayer Session (native libcolyseus; the web
//! bridge in MP-3b).
//!
//! `pump` polls the session every shell frame and keeps what it reports; `cut` maps those events
//! (by exhaustive match over the crate's `Event`, no `_` arm: an upstream variant fails the build)
//! and samples the session's views into the room once per tick, so a recorded session replays from
//! its journal; `apply` makes the session calls the tick's writes ask for. Smoothing is the crate's
//! own (wall clock), sampled once per tick, until upstream exposes the sender stamp (MP-O6).
//!
//! The backend is generic over [`RelaySession`] and [`RelayConnector`], so the mapping is tested
//! against a counting fake with no socket. A build without the game's slug baked in stays offline
//! (`net-no-slug`) and never opens one.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use genex_multiplayer::protocol::close_code;
use genex_multiplayer::{ControlResult, Error as SessionError, Event, ObjectView, PlayerView, RoomTarget};
use glam::{Quat, Vec3};
use serde_json::Value;

use crate::backend::NetBackend;
use crate::frame::{NetChange, NetEvent, NetFrame, NetMatch, NetPose, NetRoom};
use crate::ids::{NetTicket, PlayerId};
use crate::vocab::{MatchStatus, NET_TICK_HZ, NetClose, NetControl, NetMode, NetOffline, NetStatus, NetWarning};
use crate::writes::{MatchReport, NetRequest, NetSession, NetWrites, StateWrite};

#[cfg(not(target_arch = "wasm32"))]
pub mod native;

/// The reason the crate gives a control request it settled itself after its timeout.
pub const CONTROL_REASON_TIMEOUT: &str = "timeout";
/// The reason the crate gives a control request pending when the seat closed.
pub const CONTROL_REASON_DISCONNECTED: &str = "disconnected";
/// Where a published pose's position travels in the state: flat numbers the crate's smoother lerps.
pub const POSE_POSITION_KEYS: [&str; 3] = ["px", "py", "pz"];
/// Where a published pose's rotation travels: a flat `[x, y, z, w]` the crate's smoother slerps.
pub const POSE_ROTATION_KEY: &str = "pq";

/// The match state keys (PROTOCOL.md §9.3) the frame reads.
const MATCH_STATUS_KEY: &str = "status";
const MATCH_PLAYERS_KEY: &str = "players";
const MATCH_MIN_KEY: &str = "minPlayers";
const MATCH_MAX_KEY: &str = "maxPlayers";
const MATCH_WINNER_KEY: &str = "winnerId";
const MATCH_PLAYER_ID_KEY: &str = "id";

/// The slice of a relay session the backend drives: the native `Session`, the web bridge, a fake.
pub trait RelaySession {
    /// Drive the network; the events since the last call.
    fn poll(&mut self) -> Vec<Event>;
    /// Every seated player, me included.
    fn players(&self) -> &[PlayerView];
    /// Every shared object.
    fn objects(&self) -> &[ObjectView];
    /// The shared map.
    fn shared(&self) -> BTreeMap<String, Value>;
    /// My seat's id; empty before the first join.
    fn session_id(&self) -> &str;
    /// The host's seat id, once settled.
    fn host_id(&self) -> Option<&str>;
    /// A match room's state (§9.3), parsed.
    fn match_state(&self) -> Option<Value>;
    /// The relay's room clock, when it publishes one (§16).
    fn server_now(&self) -> Option<f64>;
    /// Leave with consent.
    fn leave(&mut self);
    /// Publish my state (coalesced by the crate).
    fn set_me(&mut self, state: Value) -> Result<(), SessionError>;
    /// Publish my state as a discontinuity.
    fn snap_me(&mut self, state: Value) -> Result<(), SessionError>;
    /// Publish an owned object's state.
    fn set_object(&mut self, id: &str, state: Value) -> Result<(), SessionError>;
    /// Publish an owned object's state as a discontinuity.
    fn snap_object(&mut self, id: &str, state: Value) -> Result<(), SessionError>;
    /// A confirmed claim; the request id its answer carries.
    fn claim(&mut self, id: &str) -> Result<String, SessionError>;
    /// The host's claim.
    fn claim_as_host(&mut self, id: &str) -> Result<String, SessionError>;
    /// Give an owned object up.
    fn release(&mut self, id: &str) -> Result<String, SessionError>;
    /// Remove an owned object.
    fn destroy(&mut self, id: &str) -> Result<String, SessionError>;
    /// Set a shared key (host).
    fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), SessionError>;
    /// A game event to everyone else.
    fn send(&mut self, kind: &str, data: &Value) -> Result<(), SessionError>;
    /// An input for the host.
    fn send_input(&mut self, data: &Value) -> Result<(), SessionError>;
    /// Open or close the room (host).
    fn set_room_open(&mut self, open: bool) -> Result<(), SessionError>;
    /// A chat line.
    fn chat_send(&mut self, text: &str) -> Result<(), SessionError>;
    /// A match self-report: out.
    fn report_eliminated(&mut self) -> Result<(), SessionError>;
    /// A match self-report: finished.
    fn report_finish(&mut self) -> Result<(), SessionError>;
    /// A match self-report: a score change.
    fn report_score(&mut self, delta: f64) -> Result<(), SessionError>;
}

/// Opens sessions for the game's slug: the guest door (native), the edge identity (web), a fake.
pub trait RelayConnector {
    /// The session this connector opens.
    type Session: RelaySession;

    /// The game's slug, when the build baked one in.
    fn slug(&self) -> Option<&str>;

    /// Start a session into `room`; a refusal before any socket says why, for a person.
    fn open(&mut self, slug: &str, room: RoomTarget) -> Result<Self::Session, String>;
}

/// A crate event that changes nothing the game reads (counted for diagnostics).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RelayQuiet {
    /// An object went away: the next view sample removes it.
    ObjectRemoved,
    /// The relay will restart soon.
    ServerRestart,
    /// A crate warning (English text, never matched on).
    Warning,
    /// A control answer for a request this backend did not send.
    UnknownRequest,
}

/// What one crate event does to the room.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum RelayEffect {
    /// A game-visible event.
    Event(NetEvent),
    /// The seat moved: the new status and the event that says so.
    Seat {
        /// The status.
        status: NetStatus,
        /// The event, when the game sees one.
        event: Option<NetEvent>,
    },
    /// The matchmaking queue moved (the seat is searching).
    Queue {
        /// My place in the queue.
        position: u32,
        /// The queue's length.
        size: u32,
    },
    /// Nothing the game reads.
    Quiet(RelayQuiet),
}

/// A §11 close code as a `NetClose`: the terminal codes 1:1, any other code `other`.
pub fn close_reason(code: i32) -> NetClose {
    match code {
        close_code::NORMAL => NetClose::Normal,
        close_code::CONSENTED => NetClose::Consented,
        close_code::SERVER_SHUTDOWN => NetClose::ServerShutdown,
        close_code::WITH_ERROR => NetClose::ServerError,
        close_code::FAILED_TO_RECONNECT => NetClose::ReconnectFailed,
        close_code::REVOKED => NetClose::Revoked,
        close_code::SUPERSEDED => NetClose::Replaced,
        _ => NetClose::Other,
    }
}

/// A control answer (§7.2) as a `NetControl`: the relay's reason codes 1:1, the crate's own
/// timeout and disconnect as `offline`. An unknown refusal reads `offline` (the request is over).
pub fn control_result(result: &ControlResult) -> NetControl {
    if result.accepted {
        return NetControl::Accepted;
    }
    match result.reason.as_str() {
        CONTROL_REASON_TIMEOUT | CONTROL_REASON_DISCONNECTED => NetControl::Offline,
        reason => NetControl::from_wire(reason).unwrap_or(NetControl::Offline),
    }
}

/// The tick a retry may succeed from: the cut tick plus the relay's delay, rounded up to ticks.
pub fn retry_at_tick(cut_tick: u64, retry_after_ms: Option<f64>) -> Option<u64> {
    let ms = retry_after_ms.filter(|ms| ms.is_finite() && *ms >= 0.0)?;
    let ticks = libm::ceil(ms * f64::from(NET_TICK_HZ) / 1000.0);
    Some(cut_tick + ticks as u64)
}

/// A relay count (a JSON number) as a `u32`: non-finite reads 0, the rest is clamped.
fn whole(number: f64) -> u32 {
    if !number.is_finite() {
        return 0;
    }
    number.clamp(0.0, f64::from(u32::MAX)) as u32
}

fn count(value: Option<&Value>) -> u32 {
    whole(value.and_then(Value::as_f64).unwrap_or(0.0))
}

fn match_player(value: &Value) -> Option<PlayerId> {
    let id = value.as_str().or_else(|| value.get(MATCH_PLAYER_ID_KEY).and_then(Value::as_str))?;
    Some(PlayerId::new(id))
}

/// A match room's state (§9.3) and the last queue report as a `NetMatch`; `None` without a status.
pub fn match_view(state: &Value, queue: (u32, u32)) -> Option<NetMatch> {
    let status = MatchStatus::from_wire(state.get(MATCH_STATUS_KEY)?.as_str()?)?;
    let players = state.get(MATCH_PLAYERS_KEY).and_then(Value::as_array).map(|list| list.iter().filter_map(match_player).collect()).unwrap_or_default();
    let winner = state.get(MATCH_WINNER_KEY).and_then(Value::as_str).filter(|id| !id.is_empty()).map(PlayerId::new);
    let limits = (count(state.get(MATCH_MIN_KEY)), count(state.get(MATCH_MAX_KEY)));
    Some(NetMatch::new(status).with_queue(queue.0, queue.1).with_players(players).with_limits(limits.0, limits.1).with_winner(winner))
}

fn finite_f32(value: Option<&Value>) -> Option<f32> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n as f32)
}

/// The pose a published state carries in its flat pose keys, if all of them are there.
pub fn pose_from_state(state: &Value) -> Option<NetPose> {
    let [x, y, z] = POSE_POSITION_KEYS.map(|key| finite_f32(state.get(key)));
    let rotation = state.get(POSE_ROTATION_KEY)?.as_array().filter(|q| q.len() == 4)?;
    let [qx, qy, qz, qw] = [0, 1, 2, 3].map(|i| finite_f32(rotation.get(i)));
    Some(NetPose { position: Vec3::new(x?, y?, z?), rotation: Quat::from_xyzw(qx?, qy?, qz?, qw?) })
}

/// `state` with `pose` written into the flat pose keys (a state without a pose is unchanged).
pub fn state_with_pose(state: Value, pose: Option<NetPose>) -> Value {
    let (Value::Object(mut members), Some(pose)) = (state.clone(), pose) else {
        return state;
    };
    let position = [pose.position.x, pose.position.y, pose.position.z];
    for (key, value) in POSE_POSITION_KEYS.iter().zip(position) {
        members.insert((*key).to_owned(), Value::from(f64::from(value)));
    }
    let rotation = [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w].map(|c| Value::from(f64::from(c)));
    members.insert(POSE_ROTATION_KEY.to_owned(), Value::Array(rotation.to_vec()));
    Value::Object(members)
}

/// What the mapping remembers between events: the tickets of requests in flight, the reconnect
/// attempt, and whether the game left on purpose.
#[derive(Clone, Debug, Default)]
pub struct RelayMap {
    tickets: BTreeMap<String, NetTicket>,
    attempts: u32,
    leaving: bool,
}

impl RelayMap {
    /// A request is in flight: its answer, carrying `request_id`, settles `ticket`.
    pub fn expect(&mut self, request_id: String, ticket: NetTicket) {
        self.tickets.insert(request_id, ticket);
    }

    /// The game called `leave()`: the close that follows reads `left`.
    pub fn leaving(&mut self) {
        self.leaving = true;
    }

    /// Requests in flight.
    pub fn in_flight(&self) -> usize {
        self.tickets.len()
    }

    fn closed(&self, code: i32) -> RelayEffect {
        let reason = if self.leaving { NetClose::Left } else { close_reason(code) };
        RelayEffect::Seat { status: NetStatus::Closed, event: Some(NetEvent::Closed { reason }) }
    }

    fn control(&mut self, result: &ControlResult, cut_tick: u64) -> RelayEffect {
        let Some(ticket) = self.tickets.remove(&result.request_id) else {
            return RelayEffect::Quiet(RelayQuiet::UnknownRequest);
        };
        let retry_at_tick = retry_at_tick(cut_tick, result.retry_after_ms);
        RelayEffect::Event(NetEvent::Control { ticket, result: control_result(result), retry_at_tick })
    }

    /// Map one crate event, polled before the cut of `cut_tick`.
    pub fn map(&mut self, event: &Event, cut_tick: u64) -> RelayEffect {
        let player = |id: &str| PlayerId::new(id);
        let event = match event {
            Event::Joined { .. } => {
                self.attempts = 0;
                return RelayEffect::Seat { status: NetStatus::Joined, event: None };
            }
            Event::JoinFailed { code, .. } | Event::Disconnected { code, .. } => return self.closed(*code),
            Event::Seated => return RelayEffect::Seat { status: NetStatus::Connecting, event: None },
            Event::Reconnecting { .. } => {
                self.attempts += 1;
                return RelayEffect::Seat { status: NetStatus::Reconnecting, event: Some(NetEvent::Reconnecting { attempt: self.attempts }) };
            }
            Event::Reconnected => {
                self.attempts = 0;
                return RelayEffect::Seat { status: NetStatus::Joined, event: Some(NetEvent::Reconnected) };
            }
            Event::Queue { position, size } => {
                return RelayEffect::Queue { position: whole(*position), size: whole(*size) };
            }
            Event::ControlResult(result) => return self.control(result, cut_tick),
            Event::ObjectRemoved { .. } => return RelayEffect::Quiet(RelayQuiet::ObjectRemoved),
            Event::ServerRestart => return RelayEffect::Quiet(RelayQuiet::ServerRestart),
            Event::Warning { .. } => return RelayEffect::Quiet(RelayQuiet::Warning),
            Event::PlayerJoined { id } => NetEvent::Joined { player: player(id) },
            Event::PlayerLeft { id } => NetEvent::Left { player: player(id) },
            Event::HostChanged { host } => NetEvent::Host { player: host.as_deref().map(player) },
            Event::SharedChanged { key } => NetEvent::Shared { key: key.clone() },
            Event::ObjectChanged { id, owner } => NetEvent::Owner { object: id.clone(), owner: owner.as_deref().map(player) },
            // A relay game event names no sender (§5.4): the id is empty.
            Event::Message { kind, data } => NetEvent::Message { from: player(""), kind: kind.clone(), payload: data.clone() },
            Event::Input { from, data } => NetEvent::HostInput { from: player(from), payload: data.clone() },
            Event::RoomOpen { open } => NetEvent::RoomOpen { open: *open },
            Event::Chat(line) => NetEvent::Chat { from: player(&line.from), name: line.name.clone(), text: line.text.clone() },
            Event::RateDrop { .. } => NetEvent::Warning { code: NetWarning::RateLimited },
            Event::MatchStart { .. } => NetEvent::Match { status: MatchStatus::Playing },
            Event::MatchEnded { .. } => NetEvent::Match { status: MatchStatus::Ended },
            Event::MatchRequeue { .. } => NetEvent::Match { status: MatchStatus::Searching },
        };
        RelayEffect::Event(event)
    }
}

/// Counters for `__net` and crash reports.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RelayStats {
    /// Sessions opened.
    pub opened: u64,
    /// Session calls the crate refused (not connected, payload rules).
    pub refused: u64,
    /// Writes that reached no session.
    pub dropped: u64,
    /// Crate events the game does not read.
    pub quiet: u64,
}

/// The views the room last recorded, to change only what moved.
#[derive(Clone, Debug, Default)]
struct Mirror {
    players: BTreeMap<PlayerId, PlayerView>,
    objects: BTreeMap<Arc<str>, ObjectView>,
    shared: BTreeMap<String, Value>,
    matchmaking: Option<NetMatch>,
    server_ms: Option<f64>,
}

/// The backend of exports and the web draft.
pub struct RelayBackend<C: RelayConnector> {
    connector: C,
    session: Option<C::Session>,
    room: NetRoom,
    map: RelayMap,
    inbox: Vec<Event>,
    mirror: Mirror,
    queue: (u32, u32),
    stats: RelayStats,
}

fn epoch_of(view: &ObjectView) -> u32 {
    whole(view.epoch)
}

fn shown(state: &Value, raw: &Value) -> Option<Value> {
    (state != raw).then(|| state.clone())
}

impl<C: RelayConnector> RelayBackend<C> {
    /// A backend over `connector`: offline, and `net-no-slug` when the build baked no slug in.
    pub fn new(connector: C) -> RelayBackend<C> {
        let reason = connector.slug().is_none().then_some(NetOffline::NoSlug);
        RelayBackend {
            connector,
            session: None,
            room: NetRoom::new(reason),
            map: RelayMap::default(),
            inbox: Vec::new(),
            mirror: Mirror::default(),
            queue: (0, 0),
            stats: RelayStats::default(),
        }
    }

    /// The counters.
    pub fn stats(&self) -> RelayStats {
        self.stats
    }

    /// The connector (tests read their fakes through it).
    pub fn connector(&self) -> &C {
        &self.connector
    }

    /// The open session, if any.
    pub fn session(&self) -> Option<&C::Session> {
        self.session.as_ref()
    }

    fn open(&mut self, step: &NetSession) {
        if self.session.is_some() {
            return;
        }
        let Some(slug) = self.connector.slug().map(str::to_owned) else {
            return;
        };
        let room = match step {
            NetSession::Matchmake => RoomTarget::Queue,
            NetSession::CreatePrivate => RoomTarget::CreatePrivate,
            NetSession::JoinPrivate(code) => RoomTarget::JoinById(code.clone()),
            _ => RoomTarget::Play,
        };
        match self.connector.open(&slug, room) {
            Ok(session) => {
                self.session = Some(session);
                self.map = RelayMap::default();
                self.stats.opened += 1;
                self.room.apply(NetChange::Status { status: NetStatus::Connecting, reason: None });
            }
            Err(_) => {
                self.room.apply(NetChange::Status { status: NetStatus::Closed, reason: None });
                self.room.push_event(NetEvent::Closed { reason: NetClose::Other });
            }
        }
    }

    fn session_step(&mut self, step: &NetSession) {
        match step {
            NetSession::Leave | NetSession::Cancel => {
                if matches!(step, NetSession::Leave) {
                    self.map.leaving();
                }
                if let Some(session) = self.session.as_mut() {
                    session.leave();
                }
            }
            seat => self.open(seat),
        }
    }

    fn effect(&mut self, effect: RelayEffect) {
        match effect {
            RelayEffect::Event(event) => {
                if let NetEvent::RoomOpen { open } = event {
                    self.room.apply(NetChange::RoomOpen(open));
                }
                self.room.push_event(event);
            }
            RelayEffect::Seat { status, event } => {
                if self.room.status() != status {
                    self.room.apply(NetChange::Status { status, reason: None });
                }
                if status == NetStatus::Closed {
                    self.close_views();
                }
                if let Some(event) = event {
                    self.room.push_event(event);
                }
            }
            RelayEffect::Queue { position, size } => {
                self.queue = (position, size);
                if self.room.status() != NetStatus::Searching {
                    self.room.apply(NetChange::Status { status: NetStatus::Searching, reason: None });
                }
            }
            RelayEffect::Quiet(_) => self.stats.quiet += 1,
        }
    }

    /// The seat closed: drop the session and empty the views.
    fn close_views(&mut self) {
        self.session = None;
        let mirror = std::mem::take(&mut self.mirror);
        for id in mirror.players.into_keys() {
            self.room.apply(NetChange::Leave(id));
        }
        for id in mirror.objects.into_keys() {
            self.room.apply(NetChange::ObjectRemoved(id));
        }
        for change in [NetChange::Me(None), NetChange::Host(None), NetChange::Match(None), NetChange::ServerMs(None)] {
            self.room.apply(change);
        }
    }

    fn sample_players(&mut self, views: &[PlayerView]) {
        let seen: BTreeSet<PlayerId> = views.iter().map(|view| PlayerId::new(&view.id)).collect();
        let gone: Vec<PlayerId> = self.mirror.players.keys().filter(|id| !seen.contains(*id)).cloned().collect();
        for id in gone {
            self.mirror.players.remove(&id);
            self.room.apply(NetChange::Leave(id));
        }
        for view in views {
            let id = PlayerId::new(&view.id);
            let before = self.mirror.players.get(&id);
            if before.is_some_and(|before| before == view) {
                continue;
            }
            let identity_moved = before.is_none_or(|before| before.name != view.name || before.avatar_url != view.avatar_url);
            if identity_moved {
                self.room.apply(NetChange::Join { id: id.clone(), name: view.name.clone(), avatar_url: view.avatar_url.clone() });
            }
            let was_connected = before.is_none_or(|before| before.connected);
            if was_connected != view.connected {
                self.room.apply(NetChange::Connected { id: id.clone(), connected: view.connected });
                let event = if view.connected { NetEvent::Returned { player: id.clone() } } else { NetEvent::Dropped { player: id.clone() } };
                self.room.push_event(event);
            }
            let state_moved = before.is_none_or(|before| before.state != view.state || before.state_raw != view.state_raw);
            if state_moved {
                let raw = view.state_raw.clone();
                let change = NetChange::PlayerState { id: id.clone(), smoothed: shown(&view.state, &raw), pose_raw: pose_from_state(&raw), pose: pose_from_state(&view.state), raw };
                self.room.apply(change);
            }
            self.mirror.players.insert(id, view.clone());
        }
    }

    fn sample_objects(&mut self, views: &[ObjectView]) {
        let seen: BTreeSet<&str> = views.iter().map(|view| view.id.as_str()).collect();
        let gone: Vec<Arc<str>> = self.mirror.objects.keys().filter(|id| !seen.contains(id.as_ref())).cloned().collect();
        for id in gone {
            self.mirror.objects.remove(&id);
            self.room.apply(NetChange::ObjectRemoved(id));
        }
        for view in views {
            let id: Arc<str> = Arc::from(view.id.as_str());
            if self.mirror.objects.get(&id).is_some_and(|before| before == view) {
                continue;
            }
            let raw = view.state_raw.clone();
            let change = NetChange::Object {
                id: id.clone(),
                owner: view.owner.as_deref().map(PlayerId::new),
                epoch: epoch_of(view),
                smoothed: shown(&view.state, &raw),
                pose: pose_from_state(&view.state),
                raw,
            };
            self.room.apply(change);
            self.mirror.objects.insert(id, view.clone());
        }
    }

    fn sample_shared(&mut self, shared: BTreeMap<String, Value>) {
        for (key, value) in shared {
            if self.mirror.shared.get(&key) == Some(&value) {
                continue;
            }
            self.room.apply(NetChange::Shared { key: key.clone(), value: Some(value.clone()) });
            self.mirror.shared.insert(key, value);
        }
    }

    /// Sample the session's views into the room (once per cut).
    fn sample(&mut self) {
        let Some(session) = self.session.as_ref() else {
            return;
        };
        let me = Some(session.session_id()).filter(|id| !id.is_empty()).map(PlayerId::new);
        let host = session.host_id().filter(|id| !id.is_empty()).map(PlayerId::new);
        let players = session.players().to_vec();
        let objects = session.objects().to_vec();
        let shared = session.shared();
        let matchmaking = session.match_state().and_then(|state| match_view(&state, self.queue));
        let server_ms = session.server_now();
        if self.room.me() != me.as_ref() {
            self.room.apply(NetChange::Me(me));
        }
        if self.room.host() != host.as_ref() {
            self.room.apply(NetChange::Host(host));
        }
        self.sample_players(&players);
        self.sample_objects(&objects);
        self.sample_shared(shared);
        if self.mirror.matchmaking != matchmaking {
            self.room.apply(NetChange::Match(matchmaking.clone()));
            self.mirror.matchmaking = matchmaking;
        }
        if self.mirror.server_ms != server_ms {
            self.room.apply(NetChange::ServerMs(server_ms));
            self.mirror.server_ms = server_ms;
        }
    }

    fn refused<T>(&mut self, result: Result<T, SessionError>) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(SessionError::NotOwner(_)) => {
                self.stats.refused += 1;
                self.room.push_event(NetEvent::Warning { code: NetWarning::UnownedWrite });
                None
            }
            Err(_) => {
                self.stats.refused += 1;
                None
            }
        }
    }

    fn publish_me(&mut self, write: StateWrite) {
        let Some(session) = self.session.as_mut() else {
            self.stats.dropped += 1;
            return;
        };
        let state = state_with_pose(write.state, write.pose);
        let result = if write.snap { session.snap_me(state) } else { session.set_me(state) };
        self.refused(result);
    }

    fn publish_object(&mut self, id: &str, write: StateWrite) {
        let Some(session) = self.session.as_mut() else {
            self.stats.dropped += 1;
            return;
        };
        let state = state_with_pose(write.state, write.pose);
        let result = if write.snap { session.snap_object(id, state) } else { session.set_object(id, state) };
        self.refused(result);
    }

    fn request(&mut self, request: NetRequest) {
        let (ticket, result) = match (self.session.as_mut(), &request) {
            (None, NetRequest::Claim { ticket, .. } | NetRequest::Release { ticket, .. } | NetRequest::Remove { ticket, .. }) => (*ticket, Err(SessionError::NotConnected)),
            (Some(session), NetRequest::Claim { ticket, id, as_host: true }) => (*ticket, session.claim_as_host(id)),
            (Some(session), NetRequest::Claim { ticket, id, as_host: false }) => (*ticket, session.claim(id)),
            (Some(session), NetRequest::Release { ticket, id }) => (*ticket, session.release(id)),
            (Some(session), NetRequest::Remove { ticket, id }) => (*ticket, session.destroy(id)),
        };
        match result {
            Ok(request_id) => self.map.expect(request_id, ticket),
            Err(_) => {
                self.stats.refused += 1;
                self.room.push_event(NetEvent::Control { ticket, result: NetControl::Offline, retry_at_tick: None });
            }
        }
    }

    /// The tick's room writes, in the order the game made each kind.
    fn room_writes(&mut self, writes: NetWrites) {
        let Some(session) = self.session.as_mut() else {
            self.stats.dropped += writes.len() as u64;
            return;
        };
        let mut results: Vec<Result<(), SessionError>> = Vec::new();
        results.extend(writes.shared.iter().map(|(key, value)| session.set_shared(key, value)));
        results.extend(writes.messages.iter().map(|message| session.send(&message.kind, &message.payload)));
        results.extend(writes.host_inputs.iter().map(|payload| session.send_input(payload)));
        results.extend(writes.chat.iter().map(|text| session.chat_send(text)));
        results.extend(writes.room_open.map(|open| session.set_room_open(open)));
        results.extend(writes.reports.iter().map(|report| match report {
            MatchReport::Eliminated => session.report_eliminated(),
            MatchReport::Finished => session.report_finish(),
            MatchReport::Score(delta) => session.report_score(*delta as f64),
        }));
        for result in results {
            self.refused(result);
        }
    }
}

impl<C: RelayConnector> NetBackend for RelayBackend<C> {
    fn pump(&mut self) {
        if let Some(session) = self.session.as_mut() {
            self.inbox.extend(session.poll());
        }
    }

    fn cut(&mut self, tick: u64) -> NetFrame {
        for event in std::mem::take(&mut self.inbox) {
            let effect = self.map.map(&event, tick);
            self.effect(effect);
        }
        self.sample();
        self.room.cut(tick, NetMode::Relay)
    }

    fn apply(&mut self, _tick: u64, mut writes: NetWrites) {
        for step in std::mem::take(&mut writes.session) {
            self.session_step(&step);
        }
        if let Some(write) = writes.me.take() {
            self.publish_me(write);
        }
        for (id, write) in std::mem::take(&mut writes.objects) {
            self.publish_object(&id, write);
        }
        for request in std::mem::take(&mut writes.requests) {
            self.request(request);
        }
        self.room_writes(writes);
    }

    fn mode(&self) -> NetMode {
        NetMode::Relay
    }
}
