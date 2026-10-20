//! The Loopback backend: a deterministic in-process room that answers as the relay would.
//!
//! Studio Live, captures, judges, demos and tests run it, so nothing reaches the network. A
//! `connect` seats me on the next tick as the host of a room of one; my writes echo on the next
//! tick (my state, my objects, claims under the claim policy, shared keys, chat; a `send` never
//! echoes). A demo's [`NetScript`](crate::script::NetScript) adds remote players whose states arrive
//! `latency_ticks` later and are smoothed by the sim-time [`Interpolator`], so a scripted run is a
//! pure function of the seed and the script, bit-equal on every destination.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::Value;

use crate::backend::NetBackend;
use crate::frame::{NetChange, NetEvent, NetFrame, NetMatch, NetObject, NetRoom};
use crate::ids::{NetTicket, PlayerId};
use crate::interp::{Interpolator, tick_ms};
use crate::net::NetConfig;
use crate::script::NetClaimPolicy;
use crate::vocab::{MatchStatus, NET_PLAYERS_MAX, NetClose, NetControl, NetMode, NetStatus, NetWarning};
use crate::writes::{NetRequest, NetSession, NetWrites, StateWrite};

/// My seat's id in a Loopback room.
pub const LOOPBACK_ME_ID: &str = "me";
/// My seat's name in a Loopback room.
pub const LOOPBACK_ME_NAME: &str = "You";
/// The code `create_private` opens in a Loopback room.
pub const LOOPBACK_LOBBY_CODE: &str = "LOOPBACK";
/// Scripted remote players are `remote-1`, `remote-2`, ...
const REMOTE_ID_PREFIX: &str = "remote-";
/// An object's interpolation stream is `obj:<id>` (upstream's naming).
const OBJECT_STREAM_PREFIX: &str = "obj:";

/// Something the room does on a given tick.
#[derive(Clone, Debug)]
enum Delivery {
    Session(NetSession),
    Teardown(NetClose),
    MyState(StateWrite),
    MyObject { id: String, write: StateWrite },
    Request { request: NetRequest, made_on: u64 },
    Shared { key: String, value: Value },
    HostInput { from: PlayerId, payload: Value },
    Chat { from: PlayerId, text: String },
    RoomOpen(bool),
    RemoteJoin { id: PlayerId, name: String },
    RemoteLeave(PlayerId),
    RemoteDrop(PlayerId),
    RemoteState { id: PlayerId, state: Value, sent: u64, snap: bool },
    RemoteObject { id: String, owner: PlayerId, state: Value, sent: u64 },
    Message { from: PlayerId, kind: String, payload: Value },
    Host(Option<PlayerId>),
    Reconnecting,
    Reconnected,
    Match(MatchStatus),
}

/// The in-process room.
#[derive(Clone, Debug)]
pub struct LoopbackBackend {
    config: NetConfig,
    room: NetRoom,
    me: PlayerId,
    next_tick: u64,
    schedule: BTreeMap<u64, Vec<Delivery>>,
    interp: Interpolator,
    remotes: BTreeSet<PlayerId>,
    objects: BTreeSet<Arc<str>>,
    player_raw: BTreeMap<PlayerId, Value>,
    object_raw: BTreeMap<Arc<str>, Value>,
    remotes_made: u32,
    latency: u32,
    policy: NetClaimPolicy,
}

fn object_stream(id: &str) -> String {
    format!("{OBJECT_STREAM_PREFIX}{id}")
}

/// The object with a new owner, epoch or raw state; the on-screen state is kept when it differs.
fn object_change(id: Arc<str>, object: Option<&NetObject>, owner: Option<PlayerId>, epoch: u32, raw: Value) -> NetChange {
    let smoothed = object.map(NetObject::state).filter(|shown| **shown != raw).cloned();
    let pose = object.and_then(NetObject::pose);
    NetChange::Object { id, owner, epoch, raw, smoothed, pose }
}

impl LoopbackBackend {
    /// An empty room, offline until the game connects; smoothing starts `interp_delay_ticks` behind.
    pub fn new(config: &NetConfig) -> LoopbackBackend {
        LoopbackBackend {
            config: config.clone(),
            room: NetRoom::new(None),
            me: PlayerId::new(LOOPBACK_ME_ID),
            next_tick: 0,
            schedule: BTreeMap::new(),
            interp: Interpolator::with_delay_ticks(config.delay_ticks()),
            remotes: BTreeSet::new(),
            objects: BTreeSet::new(),
            player_raw: BTreeMap::new(),
            object_raw: BTreeMap::new(),
            remotes_made: 0,
            latency: 0,
            policy: NetClaimPolicy::Accept,
        }
    }

    /// Forget everything (a reseed): the room, the schedule, the script's ids, latency and policy.
    pub fn reset(&mut self) {
        *self = LoopbackBackend::new(&self.config);
    }

    /// My seat's id.
    pub fn me(&self) -> &PlayerId {
        &self.me
    }

    /// Remote players seated now (not yet cut).
    pub fn remotes(&self) -> usize {
        self.remotes.len()
    }

    /// The arrival delay of scripted remote content, in ticks.
    pub fn latency(&self) -> u32 {
        self.latency
    }

    /// Deliveries scheduled for later ticks.
    pub fn pending(&self) -> usize {
        self.schedule.values().map(Vec::len).sum()
    }

    fn at(&mut self, tick: u64, delivery: Delivery) {
        self.schedule.entry(tick).or_default().push(delivery);
    }

    fn remote_tick(&self) -> u64 {
        self.next_tick + u64::from(self.latency)
    }

    fn remote(&mut self, delivery: Delivery) {
        let tick = self.remote_tick();
        self.at(tick, delivery);
    }

    fn control(&mut self, delivery: Delivery) {
        let tick = self.next_tick;
        self.at(tick, delivery);
    }

    fn seated(&self) -> bool {
        self.room.me().is_some()
    }

    fn open(&self) -> bool {
        matches!(self.room.status(), NetStatus::Joined | NetStatus::Reconnecting)
    }

    fn owned_by_me(&self, id: &str) -> bool {
        self.room.object(id).is_some_and(|object| object.owner() == Some(&self.me))
    }

    // ---- script (NetScript calls these) ----------------------------------------------------

    pub(crate) fn script_join(&mut self, name: &str) -> PlayerId {
        self.remotes_made += 1;
        let id = PlayerId::new(&format!("{REMOTE_ID_PREFIX}{}", self.remotes_made));
        self.remote(Delivery::RemoteJoin { id: id.clone(), name: name.to_owned() });
        id
    }

    pub(crate) fn script_leave(&mut self, player: &PlayerId) {
        self.remote(Delivery::RemoteLeave(player.clone()));
    }

    pub(crate) fn script_drop(&mut self, player: &PlayerId) {
        self.remote(Delivery::RemoteDrop(player.clone()));
    }

    pub(crate) fn script_state(&mut self, player: &PlayerId, state: Value, snap: bool) {
        let sent = self.next_tick;
        self.remote(Delivery::RemoteState { id: player.clone(), state, sent, snap });
    }

    pub(crate) fn script_object(&mut self, object: &str, owner: &PlayerId, state: Value) {
        let sent = self.next_tick;
        self.remote(Delivery::RemoteObject { id: object.to_owned(), owner: owner.clone(), state, sent });
    }

    pub(crate) fn script_message(&mut self, from: &PlayerId, kind: &str, payload: Value) {
        self.remote(Delivery::Message { from: from.clone(), kind: kind.to_owned(), payload });
    }

    pub(crate) fn script_host_input(&mut self, from: &PlayerId, payload: Value) {
        self.remote(Delivery::HostInput { from: from.clone(), payload });
    }

    pub(crate) fn script_chat(&mut self, from: &PlayerId, text: &str) {
        self.remote(Delivery::Chat { from: from.clone(), text: text.to_owned() });
    }

    pub(crate) fn script_shared(&mut self, key: &str, value: Value) {
        self.remote(Delivery::Shared { key: key.to_owned(), value });
    }

    pub(crate) fn script_host(&mut self, player: Option<&PlayerId>) {
        self.control(Delivery::Host(player.cloned()));
    }

    pub(crate) fn script_policy(&mut self, policy: NetClaimPolicy) {
        self.policy = policy;
    }

    pub(crate) fn script_latency(&mut self, ticks: u32) {
        self.latency = ticks;
    }

    pub(crate) fn script_reconnect(&mut self, ticks: u32) {
        self.control(Delivery::Reconnecting);
        let back = self.next_tick + u64::from(ticks.max(1));
        self.at(back, Delivery::Reconnected);
    }

    pub(crate) fn script_close(&mut self, reason: NetClose) {
        self.control(Delivery::Teardown(reason));
    }

    pub(crate) fn script_match(&mut self, status: MatchStatus) {
        self.control(Delivery::Match(status));
    }

    // ---- deliveries ------------------------------------------------------------------------

    fn deliver(&mut self, tick: u64, delivery: Delivery) {
        match delivery {
            Delivery::Session(step) => self.session(step),
            Delivery::Teardown(reason) => self.teardown(reason),
            Delivery::MyState(write) => self.my_state(write),
            Delivery::MyObject { id, write } => self.my_object(tick, &id, write),
            Delivery::Request { request, made_on } => self.request(request, made_on),
            Delivery::Shared { key, value } => self.shared(key, value),
            Delivery::HostInput { from, payload } => self.host_input(from, payload),
            Delivery::Chat { from, text } => self.chat(from, text),
            Delivery::RoomOpen(open) => self.room_open(open),
            Delivery::RemoteJoin { id, name } => self.remote_join(id, &name),
            Delivery::RemoteLeave(id) => self.remote_leave(&id),
            Delivery::RemoteDrop(id) => self.remote_drop(id),
            Delivery::RemoteState { id, state, sent, snap } => self.remote_state(tick, id, state, sent, snap),
            Delivery::RemoteObject { id, owner, state, sent } => self.remote_object(tick, &id, owner, state, sent),
            Delivery::Message { from, kind, payload } => self.message(from, kind, payload),
            Delivery::Host(player) => self.host(player),
            Delivery::Reconnecting => self.reconnecting(),
            Delivery::Reconnected => self.reconnected(),
            Delivery::Match(status) => self.matchmade(status),
        }
    }

    fn session(&mut self, step: NetSession) {
        match step {
            NetSession::Cancel | NetSession::Leave => {
                if self.open() {
                    self.teardown(NetClose::Left);
                }
            }
            seat => {
                if !self.open() {
                    self.seat_me(&seat);
                }
            }
        }
    }

    fn seat_me(&mut self, step: &NetSession) {
        let me = self.me.clone();
        self.room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
        self.room.apply(NetChange::Join { id: me.clone(), name: LOOPBACK_ME_NAME.to_owned(), avatar_url: String::new() });
        self.room.apply(NetChange::Me(Some(me.clone())));
        self.room.apply(NetChange::RoomOpen(true));
        self.room.push_event(NetEvent::Joined { player: me.clone() });
        if self.room.host().is_none() {
            self.room.apply(NetChange::Host(Some(me.clone())));
            self.room.push_event(NetEvent::Host { player: Some(me) });
        }
        match step {
            NetSession::Matchmake => self.matchmade(MatchStatus::Waiting),
            NetSession::CreatePrivate => self.room.apply(NetChange::LobbyCode(Some(LOOPBACK_LOBBY_CODE.to_owned()))),
            NetSession::JoinPrivate(code) => self.room.apply(NetChange::LobbyCode(Some(code.clone()))),
            _ => {}
        }
    }

    fn teardown(&mut self, reason: NetClose) {
        if !self.open() {
            return;
        }
        for id in std::mem::take(&mut self.remotes) {
            self.room.apply(NetChange::Leave(id));
        }
        for id in std::mem::take(&mut self.objects) {
            self.room.apply(NetChange::ObjectRemoved(id));
        }
        self.room.apply(NetChange::Leave(self.me.clone()));
        self.room.apply(NetChange::Me(None));
        self.room.apply(NetChange::Host(None));
        self.room.apply(NetChange::RoomOpen(false));
        self.room.apply(NetChange::Match(None));
        self.room.apply(NetChange::LobbyCode(None));
        self.room.apply(NetChange::ServerMs(None));
        self.room.apply(NetChange::Status { status: NetStatus::Closed, reason: None });
        self.room.push_event(NetEvent::Closed { reason });
        self.interp.rebase_all();
        self.player_raw.clear();
        self.object_raw.clear();
    }

    fn my_state(&mut self, write: StateWrite) {
        if !self.seated() {
            return;
        }
        let change = NetChange::PlayerState { id: self.me.clone(), raw: write.state, smoothed: None, pose_raw: write.pose, pose: write.pose };
        self.room.apply(change);
    }

    fn my_object(&mut self, tick: u64, id: &str, write: StateWrite) {
        if !self.owned_by_me(id) {
            self.room.push_event(NetEvent::Warning { code: NetWarning::UnownedWrite });
            return;
        }
        let object = self.room.object(id);
        let epoch = object.map_or(0, NetObject::epoch) + u32::from(write.snap);
        let key: Arc<str> = Arc::from(id);
        if let Value::Object(state) = &write.state {
            self.interp.hold(&object_stream(id), state.clone(), tick);
        }
        let change = NetChange::Object { id: key, owner: Some(self.me.clone()), epoch, raw: write.state, smoothed: None, pose: write.pose };
        self.room.apply(change);
    }

    fn control_event(&mut self, ticket: NetTicket, result: NetControl, retry_at_tick: Option<u64>) {
        self.room.push_event(NetEvent::Control { ticket, result, retry_at_tick });
    }

    fn request(&mut self, request: NetRequest, made_on: u64) {
        match request {
            NetRequest::Claim { ticket, id, .. } => self.claim(ticket, &id, made_on),
            NetRequest::Release { ticket, id } => self.give_up(ticket, &id, false),
            NetRequest::Remove { ticket, id } => self.give_up(ticket, &id, true),
        }
    }

    fn claim(&mut self, ticket: NetTicket, id: &str, made_on: u64) {
        match self.policy {
            NetClaimPolicy::NotHost => return self.control_event(ticket, NetControl::NotHost, None),
            NetClaimPolicy::Held { ticks } => return self.control_event(ticket, NetControl::Held, Some(made_on + u64::from(ticks))),
            NetClaimPolicy::Accept => {}
        }
        if self.owned_by_me(id) {
            return self.control_event(ticket, NetControl::AlreadyOwner, None);
        }
        let key: Arc<str> = Arc::from(id);
        let object = self.room.object(id);
        let (epoch, raw) = object.map_or((0, Value::Null), |object| (object.epoch(), object.state_raw().clone()));
        let change = object_change(key.clone(), object, Some(self.me.clone()), epoch, raw);
        self.room.apply(change);
        self.objects.insert(key);
        self.interp.soft_handoff(&object_stream(id));
        self.room.push_event(NetEvent::Owner { object: id.to_owned(), owner: Some(self.me.clone()) });
        self.control_event(ticket, NetControl::Accepted, None);
    }

    fn give_up(&mut self, ticket: NetTicket, id: &str, remove: bool) {
        let Some(object) = self.room.object(id) else {
            return self.control_event(ticket, NetControl::UnknownObject, None);
        };
        if object.owner() != Some(&self.me) {
            return self.control_event(ticket, NetControl::NotOwner, None);
        }
        let key: Arc<str> = Arc::from(id);
        if remove {
            self.room.apply(NetChange::ObjectRemoved(key.clone()));
            self.objects.remove(&key);
            self.interp.remove_stream(&object_stream(id));
        } else {
            let change = object_change(key, Some(object), None, object.epoch(), object.state_raw().clone());
            self.room.apply(change);
            self.room.push_event(NetEvent::Owner { object: id.to_owned(), owner: None });
        }
        self.control_event(ticket, NetControl::Accepted, None);
    }

    fn shared(&mut self, key: String, value: Value) {
        self.room.apply(NetChange::Shared { key: key.clone(), value: Some(value) });
        self.room.push_event(NetEvent::Shared { key });
    }

    fn host_input(&mut self, from: PlayerId, payload: Value) {
        let me_host = self.seated() && self.room.host() == Some(&self.me);
        if me_host {
            self.room.push_event(NetEvent::HostInput { from, payload });
        }
    }

    fn chat(&mut self, from: PlayerId, text: String) {
        let Some(name) = self.room.player(&from).map(|player| player.name().to_owned()) else {
            return;
        };
        self.room.push_event(NetEvent::Chat { from, name, text });
    }

    fn room_open(&mut self, open: bool) {
        self.room.apply(NetChange::RoomOpen(open));
        self.room.push_event(NetEvent::RoomOpen { open });
    }

    fn remote_join(&mut self, id: PlayerId, name: &str) {
        if self.remotes.contains(&id) {
            return;
        }
        self.room.apply(NetChange::Join { id: id.clone(), name: name.to_owned(), avatar_url: String::new() });
        self.room.push_event(NetEvent::Joined { player: id.clone() });
        self.remotes.insert(id);
    }

    fn remote_leave(&mut self, id: &PlayerId) {
        if !self.remotes.remove(id) {
            return;
        }
        self.room.apply(NetChange::Leave(id.clone()));
        self.room.push_event(NetEvent::Left { player: id.clone() });
        self.interp.remove_stream(id.as_str());
        self.interp.remove_sender(id.as_str());
        self.player_raw.remove(id);
        let orphans: Vec<Arc<str>> = self.objects.iter().filter(|key| self.room.object(key).is_some_and(|object| object.owner() == Some(id))).cloned().collect();
        for key in orphans {
            let object = self.room.object(&key);
            let (epoch, raw) = object.map_or((0, Value::Null), |object| (object.epoch(), object.state_raw().clone()));
            let change = object_change(key.clone(), object, None, epoch, raw);
            self.room.apply(change);
            self.room.push_event(NetEvent::Owner { object: key.to_string(), owner: None });
        }
        if self.room.host() == Some(id) {
            let next = self.seated().then(|| self.me.clone());
            self.host(next);
        }
    }

    fn remote_drop(&mut self, id: PlayerId) {
        if !self.remotes.contains(&id) {
            return;
        }
        self.room.apply(NetChange::Connected { id: id.clone(), connected: false });
        self.room.push_event(NetEvent::Dropped { player: id });
    }

    fn remote_state(&mut self, tick: u64, id: PlayerId, state: Value, sent: u64, snap: bool) {
        if !self.remotes.contains(&id) {
            return;
        }
        if snap {
            self.interp.reset_epoch(id.as_str());
        }
        if let Value::Object(map) = &state {
            self.interp.push(id.as_str(), id.as_str(), sent, map.clone(), tick);
        }
        self.player_raw.insert(id, state);
    }

    fn remote_object(&mut self, tick: u64, id: &str, owner: PlayerId, state: Value, sent: u64) {
        let key: Arc<str> = Arc::from(id);
        let stream = object_stream(id);
        let object = self.room.object(id);
        let previous = object.and_then(NetObject::owner).cloned();
        let epoch = object.map_or(0, NetObject::epoch);
        if previous.as_ref() != Some(&owner) {
            let raw = object.map_or(Value::Null, |object| object.state_raw().clone());
            let change = object_change(key.clone(), object, Some(owner.clone()), epoch, raw);
            self.room.apply(change);
            self.interp.soft_handoff(&stream);
            self.room.push_event(NetEvent::Owner { object: id.to_owned(), owner: Some(owner.clone()) });
        }
        if let Value::Object(map) = &state {
            self.interp.push(&stream, owner.as_str(), sent, map.clone(), tick);
        }
        self.objects.insert(key.clone());
        self.object_raw.insert(key, state);
    }

    fn message(&mut self, from: PlayerId, kind: String, payload: Value) {
        if self.remotes.contains(&from) && self.seated() {
            self.room.push_event(NetEvent::Message { from, kind, payload });
        }
    }

    fn host(&mut self, player: Option<PlayerId>) {
        let target = player.or_else(|| self.seated().then(|| self.me.clone()));
        self.room.apply(NetChange::Host(target.clone()));
        self.room.push_event(NetEvent::Host { player: target });
    }

    fn reconnecting(&mut self) {
        if self.room.status() == NetStatus::Joined {
            self.room.apply(NetChange::Status { status: NetStatus::Reconnecting, reason: None });
            self.room.push_event(NetEvent::Reconnecting { attempt: 1 });
        }
    }

    fn reconnected(&mut self) {
        if self.room.status() == NetStatus::Reconnecting {
            self.room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
            self.room.push_event(NetEvent::Reconnected);
        }
    }

    fn matchmade(&mut self, status: MatchStatus) {
        let mut players: Vec<PlayerId> = self.remotes.iter().cloned().collect();
        if self.seated() {
            players.push(self.me.clone());
        }
        players.sort();
        let seats = u32::try_from(NET_PLAYERS_MAX).unwrap_or(u32::MAX);
        let matchmaking = NetMatch::new(status).with_players(players).with_limits(1, seats);
        self.room.apply(NetChange::Match(Some(matchmaking)));
        self.room.push_event(NetEvent::Match { status });
    }

    // ---- smoothing -------------------------------------------------------------------------

    /// Re-sample every remote stream for `tick` and record what changed.
    fn resample(&mut self, tick: u64) {
        let remotes: Vec<PlayerId> = self.remotes.iter().cloned().collect();
        for id in remotes {
            self.resample_player(tick, id);
        }
        let objects: Vec<Arc<str>> = self.objects.iter().cloned().collect();
        for key in objects {
            self.resample_object(tick, key);
        }
    }

    fn resample_player(&mut self, tick: u64, id: PlayerId) {
        let pending = self.player_raw.remove(&id);
        let sampled = self.interp.sample(id.as_str(), tick).map(Value::Object);
        let Some(player) = self.room.player(&id) else {
            return;
        };
        let raw = pending.unwrap_or_else(|| player.state_raw().clone());
        let shown = sampled.unwrap_or_else(|| raw.clone());
        if raw == *player.state_raw() && shown == *player.state() {
            return;
        }
        let smoothed = (shown != raw).then_some(shown);
        let change = NetChange::PlayerState { id: id.clone(), raw, smoothed, pose_raw: player.pose_raw(), pose: player.pose() };
        self.room.apply(change);
    }

    fn resample_object(&mut self, tick: u64, key: Arc<str>) {
        let pending = self.object_raw.remove(&key);
        let Some(object) = self.room.object(&key) else {
            return;
        };
        let remote_owned = object.owner().is_some_and(|owner| *owner != self.me);
        if !remote_owned {
            return;
        }
        let owner = object.owner().cloned();
        let epoch = object.epoch();
        let raw = pending.unwrap_or_else(|| object.state_raw().clone());
        let sampled = self.interp.sample(&object_stream(&key), tick).map(Value::Object);
        let Some(object) = self.room.object(&key) else {
            return;
        };
        let shown = sampled.unwrap_or_else(|| raw.clone());
        if raw == *object.state_raw() && shown == *object.state() {
            return;
        }
        let smoothed = (shown != raw).then_some(shown);
        let pose = object.pose();
        self.room.apply(NetChange::Object { id: key, owner, epoch, raw, smoothed, pose });
    }
}

impl NetBackend for LoopbackBackend {
    fn pump(&mut self) {}

    fn cut(&mut self, tick: u64) -> NetFrame {
        let later = self.schedule.split_off(&(tick + 1));
        let due = std::mem::replace(&mut self.schedule, later);
        for delivery in due.into_values().flatten() {
            self.deliver(tick, delivery);
        }
        self.resample(tick);
        if self.open() {
            self.room.apply(NetChange::ServerMs(Some(tick_ms(tick))));
        }
        self.next_tick = tick + 1;
        self.room.cut(tick, NetMode::Loopback)
    }

    fn apply(&mut self, tick: u64, writes: NetWrites) {
        let reply = tick + 1;
        for step in writes.session {
            self.at(reply, Delivery::Session(step));
        }
        if let Some(write) = writes.me {
            self.at(reply, Delivery::MyState(write));
        }
        for (id, write) in writes.objects {
            self.at(reply, Delivery::MyObject { id, write });
        }
        for request in writes.requests {
            self.at(reply, Delivery::Request { request, made_on: tick });
        }
        for (key, value) in writes.shared {
            self.at(reply, Delivery::Shared { key, value });
        }
        let me = self.me.clone();
        for payload in writes.host_inputs {
            self.at(reply, Delivery::HostInput { from: me.clone(), payload });
        }
        for text in writes.chat {
            self.at(reply, Delivery::Chat { from: me.clone(), text });
        }
        if let Some(open) = writes.room_open {
            self.at(reply, Delivery::RoomOpen(open));
        }
    }

    fn mode(&self) -> NetMode {
        NetMode::Loopback
    }
}
