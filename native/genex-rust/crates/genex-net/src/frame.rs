//! NetFrame: the immutable view of the room one tick reads, cut once per tick.
//!
//! A backend keeps a [`NetRoom`] and changes it only through [`NetChange`]s, each recorded in the
//! order it happened. [`NetRoom::cut`] hands out a frame whose roster, objects and shared map are
//! `Arc`-shared slices, rebuilt only when something in them changed, plus the tick's changes and
//! events: the journal records exactly those, so a fresh room fed them back cuts the same frames.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use glam::{Quat, Vec3};
use serde_json::Value;

use crate::ids::{NetTicket, PlayerId};
use crate::vocab::{MatchStatus, NET_EVENTS_PER_TICK_MAX, NetClose, NetControl, NetMode, NetOffline, NetStatus, NetWarning};

/// The protocol's posed stream (PROTOCOL.md §6.6): flat fields, so a smoother slerps the rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NetPose {
    /// Where the player or object is.
    pub position: Vec3,
    /// Which way it faces.
    pub rotation: Quat,
}

impl NetPose {
    /// Whether every component is a finite number.
    pub fn is_finite(&self) -> bool {
        self.position.is_finite() && self.rotation.is_finite()
    }
}

/// One seated player as this tick sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct NetPlayer {
    id: PlayerId,
    name: String,
    avatar_url: String,
    connected: bool,
    is_me: bool,
    state: Value,
    state_raw: Value,
    pose: Option<NetPose>,
    pose_raw: Option<NetPose>,
}

impl NetPlayer {
    /// The seat's id.
    pub fn id(&self) -> &PlayerId {
        &self.id
    }

    /// The verified identity's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The avatar's URL; empty when unknown.
    pub fn avatar_url(&self) -> &str {
        &self.avatar_url
    }

    /// False while the seat is held by the reconnect grace.
    pub fn connected(&self) -> bool {
        self.connected
    }

    /// Whether this seat is this client's.
    pub fn is_me(&self) -> bool {
        self.is_me
    }

    /// The smoothed state: DRAW ONLY (for me, the live state).
    pub fn state(&self) -> &Value {
        &self.state
    }

    /// The latest state: every gameplay read, discrete fields and flags.
    pub fn state_raw(&self) -> &Value {
        &self.state_raw
    }

    /// The smoothed pose, when the player publishes one.
    pub fn pose(&self) -> Option<NetPose> {
        self.pose
    }

    /// The latest pose, when the player publishes one.
    pub fn pose_raw(&self) -> Option<NetPose> {
        self.pose_raw
    }
}

/// One shared object as this tick sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct NetObject {
    id: Arc<str>,
    owner: Option<PlayerId>,
    mine: bool,
    epoch: u32,
    state: Value,
    state_raw: Value,
    pose: Option<NetPose>,
}

impl NetObject {
    /// The object's id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Who owns it; `None` when nobody does.
    pub fn owner(&self) -> Option<&PlayerId> {
        self.owner.as_ref()
    }

    /// Whether this client owns it.
    pub fn mine(&self) -> bool {
        self.mine
    }

    /// The snap epoch: +1 on every hard reset.
    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    /// The smoothed state (for the owner, the live state).
    pub fn state(&self) -> &Value {
        &self.state
    }

    /// The latest state.
    pub fn state_raw(&self) -> &Value {
        &self.state_raw
    }

    /// The smoothed pose, when the owner publishes one.
    pub fn pose(&self) -> Option<NetPose> {
        self.pose
    }
}

/// A matchmade seat's standing (PROTOCOL.md §9).
#[derive(Clone, Debug, PartialEq)]
pub struct NetMatch {
    status: MatchStatus,
    queue: (u32, u32),
    players: Vec<PlayerId>,
    min_players: u32,
    max_players: u32,
    winner: Option<PlayerId>,
}

impl NetMatch {
    /// A match in `status`, with an empty queue and no players yet.
    pub fn new(status: MatchStatus) -> NetMatch {
        NetMatch { status, queue: (0, 0), players: Vec::new(), min_players: 0, max_players: 0, winner: None }
    }

    /// The queue position and size (me included).
    pub fn with_queue(mut self, position: u32, size: u32) -> NetMatch {
        self.queue = (position, size);
        self
    }

    /// The seated players.
    pub fn with_players(mut self, players: Vec<PlayerId>) -> NetMatch {
        self.players = players;
        self
    }

    /// The preset's player bounds.
    pub fn with_limits(mut self, min_players: u32, max_players: u32) -> NetMatch {
        self.min_players = min_players;
        self.max_players = max_players;
        self
    }

    /// The winner, once the round ended.
    pub fn with_winner(mut self, winner: Option<PlayerId>) -> NetMatch {
        self.winner = winner;
        self
    }

    /// Where the seat stands.
    pub fn status(&self) -> MatchStatus {
        self.status
    }

    /// The queue position and size (me included).
    pub fn queue(&self) -> (u32, u32) {
        self.queue
    }

    /// The seated players.
    pub fn players(&self) -> &[PlayerId] {
        &self.players
    }

    /// The fewest players the round starts with.
    pub fn min_players(&self) -> u32 {
        self.min_players
    }

    /// The most players a round seats.
    pub fn max_players(&self) -> u32 {
        self.max_players
    }

    /// The winner, once the round ended.
    pub fn winner(&self) -> Option<&PlayerId> {
        self.winner.as_ref()
    }
}

/// Something that happened in the room, in arrival order.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum NetEvent {
    /// A player took a seat.
    Joined {
        /// Who.
        player: PlayerId,
    },
    /// A player left for good.
    Left {
        /// Who.
        player: PlayerId,
    },
    /// A player's connection dropped; the reconnect grace holds the seat.
    Dropped {
        /// Who.
        player: PlayerId,
    },
    /// A player came back within the grace.
    Returned {
        /// Who.
        player: PlayerId,
    },
    /// The host changed; `None` while authority is not settled.
    Host {
        /// The new host.
        player: Option<PlayerId>,
    },
    /// An object appeared or changed owner.
    Owner {
        /// Which object.
        object: String,
        /// The new owner.
        owner: Option<PlayerId>,
    },
    /// A shared key changed.
    Shared {
        /// Which key.
        key: String,
    },
    /// A game message from another player (never an echo of my own).
    Message {
        /// The sender.
        from: PlayerId,
        /// The message type.
        kind: String,
        /// Its payload.
        payload: Value,
    },
    /// An input forwarded to me as host (named apart from INPUT's action vocabulary).
    HostInput {
        /// The sender.
        from: PlayerId,
        /// Its payload.
        payload: Value,
    },
    /// A chat line (mine echo).
    Chat {
        /// The sender.
        from: PlayerId,
        /// The sender's name as the relay stamped it.
        name: String,
        /// The line.
        text: String,
    },
    /// The answer to a claim, release or remove.
    Control {
        /// The request's ticket.
        ticket: NetTicket,
        /// The answer.
        result: NetControl,
        /// For `held`: the tick from which a retry may succeed.
        retry_at_tick: Option<u64>,
    },
    /// The host opened or closed the room.
    RoomOpen {
        /// Whether it takes new players.
        open: bool,
    },
    /// The socket dropped; reconnect attempt `attempt` is on its way.
    Reconnecting {
        /// 1 for the first attempt.
        attempt: u32,
    },
    /// The reconnect finished.
    Reconnected,
    /// Terminal: the seat closed.
    Closed {
        /// Why.
        reason: NetClose,
    },
    /// The matchmade seat moved on.
    Match {
        /// Where it stands now.
        status: MatchStatus,
    },
    /// Something refused nothing but is worth knowing.
    Warning {
        /// What.
        code: NetWarning,
    },
}

/// One change to a room, the unit the journal records. Backends make them through [`NetRoom`].
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum NetChange {
    /// The status and, when offline or closed, why.
    Status {
        /// The status.
        status: NetStatus,
        /// Why it is offline.
        reason: Option<NetOffline>,
    },
    /// Which seat is this client's.
    Me(Option<PlayerId>),
    /// Which seat is the host.
    Host(Option<PlayerId>),
    /// Whether the room takes new players.
    RoomOpen(bool),
    /// A player took a seat (an existing seat keeps its state).
    Join {
        /// The seat.
        id: PlayerId,
        /// The verified name.
        name: String,
        /// The avatar's URL.
        avatar_url: String,
    },
    /// A player left.
    Leave(PlayerId),
    /// A player's connection dropped or came back.
    Connected {
        /// The seat.
        id: PlayerId,
        /// Whether it is connected.
        connected: bool,
    },
    /// A player's state changed.
    PlayerState {
        /// The seat.
        id: PlayerId,
        /// The latest state.
        raw: Value,
        /// The smoothed state, when it differs from `raw`.
        smoothed: Option<Value>,
        /// The latest pose.
        pose_raw: Option<NetPose>,
        /// The smoothed pose.
        pose: Option<NetPose>,
    },
    /// An object appeared or changed.
    Object {
        /// The object.
        id: Arc<str>,
        /// Its owner.
        owner: Option<PlayerId>,
        /// Its snap epoch.
        epoch: u32,
        /// The latest state.
        raw: Value,
        /// The smoothed state, when it differs from `raw`.
        smoothed: Option<Value>,
        /// The smoothed pose.
        pose: Option<NetPose>,
    },
    /// An object went away.
    ObjectRemoved(Arc<str>),
    /// A shared key was set (`Some`) or deleted (`None`).
    Shared {
        /// The key.
        key: String,
        /// The value.
        value: Option<Value>,
    },
    /// The matchmade seat's standing.
    Match(Option<NetMatch>),
    /// The private lobby's code.
    LobbyCode(Option<String>),
    /// The relay clock as sampled for this tick.
    ServerMs(Option<f64>),
}

/// The immutable view of the room one tick reads.
#[derive(Clone, Debug)]
pub struct NetFrame {
    tick: u64,
    mode: NetMode,
    status: NetStatus,
    reason: Option<NetOffline>,
    me: Option<PlayerId>,
    host: Option<PlayerId>,
    room_open: bool,
    players: Arc<[Arc<NetPlayer>]>,
    objects: Arc<[Arc<NetObject>]>,
    shared: Arc<[(String, Value)]>,
    events: Arc<[NetEvent]>,
    matchmaking: Option<NetMatch>,
    lobby_code: Option<String>,
    server_ms: Option<f64>,
    changes: Arc<[NetChange]>,
}

impl NetFrame {
    /// An empty frame: offline for `reason`, nobody seated (before the first cut, and in Off).
    pub fn offline(mode: NetMode, reason: Option<NetOffline>) -> NetFrame {
        NetFrame {
            tick: 0,
            mode,
            status: NetStatus::Offline,
            reason,
            me: None,
            host: None,
            room_open: false,
            players: Arc::from([]),
            objects: Arc::from([]),
            shared: Arc::from([]),
            events: Arc::from([]),
            matchmaking: None,
            lobby_code: None,
            server_ms: None,
            changes: Arc::from([]),
        }
    }

    /// The tick this frame was cut for.
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Which backend the build chose.
    pub fn mode(&self) -> NetMode {
        self.mode
    }

    /// Where the seat stands.
    pub fn status(&self) -> NetStatus {
        self.status
    }

    /// Why the status is offline or closed.
    pub fn offline_reason(&self) -> Option<NetOffline> {
        self.reason
    }

    /// This client's seat, once seated.
    pub fn me(&self) -> Option<&PlayerId> {
        self.me.as_ref()
    }

    /// Every seated player, me included, in id order.
    pub fn players(&self) -> impl Iterator<Item = &NetPlayer> {
        self.players.iter().map(|player| player.as_ref())
    }

    /// Every seated player but me, in id order.
    pub fn remotes(&self) -> impl Iterator<Item = &NetPlayer> {
        self.players().filter(|player| !player.is_me)
    }

    /// One seat.
    pub fn player(&self, id: &PlayerId) -> Option<&NetPlayer> {
        let at = self.players.binary_search_by(|player| player.id.cmp(id)).ok()?;
        Some(&self.players[at])
    }

    /// The quorum count: seats not held by the reconnect grace.
    pub fn connected(&self) -> usize {
        self.players.iter().filter(|player| player.connected).count()
    }

    /// Every shared object, in id order.
    pub fn objects(&self) -> impl Iterator<Item = &NetObject> {
        self.objects.iter().map(|object| object.as_ref())
    }

    /// One object.
    pub fn object(&self, id: &str) -> Option<&NetObject> {
        let at = self.objects.binary_search_by(|object| object.id.as_ref().cmp(id)).ok()?;
        Some(&self.objects[at])
    }

    /// How many objects exist.
    pub fn object_count(&self) -> usize {
        self.objects.len()
    }

    /// One shared value.
    pub fn shared(&self, key: &str) -> Option<&Value> {
        let at = self.shared.binary_search_by(|(k, _)| k.as_str().cmp(key)).ok()?;
        Some(&self.shared[at].1)
    }

    /// Every shared key, in key order.
    pub fn shared_keys(&self) -> impl Iterator<Item = &str> {
        self.shared.iter().map(|(key, _)| key.as_str())
    }

    /// The host; `None` while authority is not settled (do not start host work).
    pub fn host(&self) -> Option<&PlayerId> {
        self.host.as_ref()
    }

    /// Joined, settled, and the host is me.
    pub fn is_host(&self) -> bool {
        let settled_me = self.me.is_some() && self.host == self.me;
        self.status == NetStatus::Joined && settled_me
    }

    /// Whether the room takes new players.
    pub fn room_open(&self) -> bool {
        self.room_open
    }

    /// This tick's events, in arrival order.
    pub fn events(&self) -> &[NetEvent] {
        &self.events
    }

    /// The matchmade seat's standing.
    pub fn matchmaking(&self) -> Option<&NetMatch> {
        self.matchmaking.as_ref()
    }

    /// The private lobby's code.
    pub fn lobby_code(&self) -> Option<&str> {
        self.lobby_code.as_deref()
    }

    /// The relay clock as sampled at the cut (deadlines).
    pub fn server_ms(&self) -> Option<f64> {
        self.server_ms
    }

    /// The changes this frame applied to the previous one, in order: what the journal records.
    pub fn changes(&self) -> &[NetChange] {
        &self.changes
    }
}

/// A backend's room: the state frames are cut from, changed only through [`NetChange`]s.
#[derive(Clone, Debug)]
pub struct NetRoom {
    status: NetStatus,
    reason: Option<NetOffline>,
    me: Option<PlayerId>,
    host: Option<PlayerId>,
    room_open: bool,
    players: BTreeMap<PlayerId, Arc<NetPlayer>>,
    players_view: Arc<[Arc<NetPlayer>]>,
    players_dirty: bool,
    objects: BTreeMap<Arc<str>, Arc<NetObject>>,
    objects_view: Arc<[Arc<NetObject>]>,
    objects_dirty: bool,
    shared: BTreeMap<String, Value>,
    shared_view: Arc<[(String, Value)]>,
    shared_dirty: bool,
    matchmaking: Option<NetMatch>,
    lobby_code: Option<String>,
    server_ms: Option<f64>,
    changes: Vec<NetChange>,
    events: VecDeque<NetEvent>,
}

impl NetRoom {
    /// An empty room, offline for `reason`.
    pub fn new(reason: Option<NetOffline>) -> NetRoom {
        NetRoom {
            status: NetStatus::Offline,
            reason,
            me: None,
            host: None,
            room_open: false,
            players: BTreeMap::new(),
            players_view: Arc::from([]),
            players_dirty: false,
            objects: BTreeMap::new(),
            objects_view: Arc::from([]),
            objects_dirty: false,
            shared: BTreeMap::new(),
            shared_view: Arc::from([]),
            shared_dirty: false,
            matchmaking: None,
            lobby_code: None,
            server_ms: None,
            changes: Vec::new(),
            events: VecDeque::new(),
        }
    }

    /// The status now (not yet cut).
    pub fn status(&self) -> NetStatus {
        self.status
    }

    /// This client's seat now (not yet cut).
    pub fn me(&self) -> Option<&PlayerId> {
        self.me.as_ref()
    }

    /// The host now (not yet cut).
    pub fn host(&self) -> Option<&PlayerId> {
        self.host.as_ref()
    }

    /// One seat now (not yet cut).
    pub fn player(&self, id: &PlayerId) -> Option<&NetPlayer> {
        self.players.get(id).map(|player| player.as_ref())
    }

    /// One object now (not yet cut).
    pub fn object(&self, id: &str) -> Option<&NetObject> {
        self.objects.get(id).map(|object| object.as_ref())
    }

    /// Queue an event for the next cut.
    pub fn push_event(&mut self, event: NetEvent) {
        self.events.push_back(event);
    }

    /// Events queued for later cuts.
    pub fn pending_events(&self) -> usize {
        self.events.len()
    }

    /// Apply one change and record it for the next cut's journal entry.
    pub fn apply(&mut self, change: NetChange) {
        self.apply_state(&change);
        self.changes.push(change);
    }

    fn apply_state(&mut self, change: &NetChange) {
        match change {
            NetChange::Status { status, reason } => {
                self.status = *status;
                self.reason = *reason;
            }
            NetChange::Me(me) => {
                self.me.clone_from(me);
                self.players_dirty = true;
                self.objects_dirty = true;
            }
            NetChange::Host(host) => self.host.clone_from(host),
            NetChange::RoomOpen(open) => self.room_open = *open,
            NetChange::Join { id, name, avatar_url } => self.join(id, name, avatar_url),
            NetChange::Leave(id) => {
                self.players_dirty |= self.players.remove(id).is_some();
            }
            NetChange::Connected { id, connected } => self.edit_player(id, |player| player.connected = *connected),
            NetChange::PlayerState { id, raw, smoothed, pose_raw, pose } => self.edit_player(id, |player| {
                player.state_raw.clone_from(raw);
                player.state.clone_from(smoothed.as_ref().unwrap_or(raw));
                player.pose_raw = *pose_raw;
                player.pose = *pose;
            }),
            NetChange::Object { id, owner, epoch, raw, smoothed, pose } => {
                let object = NetObject {
                    id: id.clone(),
                    owner: owner.clone(),
                    mine: false,
                    epoch: *epoch,
                    state: smoothed.as_ref().unwrap_or(raw).clone(),
                    state_raw: raw.clone(),
                    pose: *pose,
                };
                self.objects.insert(id.clone(), Arc::new(object));
                self.objects_dirty = true;
            }
            NetChange::ObjectRemoved(id) => {
                self.objects_dirty |= self.objects.remove(id).is_some();
            }
            NetChange::Shared { key, value } => {
                match value {
                    Some(value) => self.shared.insert(key.clone(), value.clone()),
                    None => self.shared.remove(key),
                };
                self.shared_dirty = true;
            }
            NetChange::Match(matchmaking) => self.matchmaking.clone_from(matchmaking),
            NetChange::LobbyCode(code) => self.lobby_code.clone_from(code),
            NetChange::ServerMs(ms) => self.server_ms = *ms,
        }
    }

    fn join(&mut self, id: &PlayerId, name: &str, avatar_url: &str) {
        if let Some(player) = self.players.get_mut(id) {
            let player = Arc::make_mut(player);
            player.name = name.to_owned();
            player.avatar_url = avatar_url.to_owned();
            player.connected = true;
        } else {
            let player = NetPlayer {
                id: id.clone(),
                name: name.to_owned(),
                avatar_url: avatar_url.to_owned(),
                connected: true,
                is_me: false,
                state: Value::Null,
                state_raw: Value::Null,
                pose: None,
                pose_raw: None,
            };
            self.players.insert(id.clone(), Arc::new(player));
        }
        self.players_dirty = true;
    }

    fn edit_player(&mut self, id: &PlayerId, edit: impl FnOnce(&mut NetPlayer)) {
        if let Some(player) = self.players.get_mut(id) {
            edit(Arc::make_mut(player));
            self.players_dirty = true;
        }
    }

    /// Cut the frame for `tick`: the views (rebuilt only when changed), the changes since the last
    /// cut and up to [`NET_EVENTS_PER_TICK_MAX`] events (the rest wait, behind an `events-deferred`
    /// warning).
    pub fn cut(&mut self, tick: u64, mode: NetMode) -> NetFrame {
        self.rebuild_views();
        NetFrame {
            tick,
            mode,
            status: self.status,
            reason: self.reason,
            me: self.me.clone(),
            host: self.host.clone(),
            room_open: self.room_open,
            players: self.players_view.clone(),
            objects: self.objects_view.clone(),
            shared: self.shared_view.clone(),
            events: self.take_events(),
            matchmaking: self.matchmaking.clone(),
            lobby_code: self.lobby_code.clone(),
            server_ms: self.server_ms,
            changes: Arc::from(std::mem::take(&mut self.changes)),
        }
    }

    fn take_events(&mut self) -> Arc<[NetEvent]> {
        if self.events.len() <= NET_EVENTS_PER_TICK_MAX {
            return self.events.drain(..).collect();
        }
        let mut events: Vec<NetEvent> = self.events.drain(..NET_EVENTS_PER_TICK_MAX - 1).collect();
        events.push(NetEvent::Warning { code: NetWarning::EventsDeferred });
        Arc::from(events)
    }

    fn rebuild_views(&mut self) {
        if self.players_dirty {
            for player in self.players.values_mut() {
                let is_me = self.me.as_ref() == Some(&player.id);
                if player.is_me != is_me {
                    Arc::make_mut(player).is_me = is_me;
                }
            }
            self.players_view = self.players.values().cloned().collect();
            self.players_dirty = false;
        }
        if self.objects_dirty {
            for object in self.objects.values_mut() {
                let mine = self.me.is_some() && object.owner == self.me;
                if object.mine != mine {
                    Arc::make_mut(object).mine = mine;
                }
            }
            self.objects_view = self.objects.values().cloned().collect();
            self.objects_dirty = false;
        }
        if self.shared_dirty {
            self.shared_view = self.shared.iter().map(|(key, value)| (key.clone(), value.clone())).collect();
            self.shared_dirty = false;
        }
    }
}
