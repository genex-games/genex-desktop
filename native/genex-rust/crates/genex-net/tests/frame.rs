//! NetFrame and NetRoom (MP-2a, new behaviour): ordered reads, derived flags, Arc-shared views
//! rebuilt only on change, the per-tick event cap, and the cut-plus-apply timing row.

use std::sync::Arc;

use genex_net::backend::NetBackend;
use genex_net::frame::{NetChange, NetEvent, NetFrame, NetMatch, NetRoom};
use genex_net::ids::PlayerId;
use genex_net::journal::NetJournal;
use genex_net::net::{Net, NetConfig};
use genex_net::vocab::{MatchStatus, NET_EVENTS_PER_TICK_MAX, NET_JOURNAL_BYTES_DESKTOP, NET_OBJECTS_MAX, NET_PLAYERS_MAX, NetMode, NetStatus, NetWarning};
use genex_net::writes::NetWrites;
use serde_json::json;

fn id(text: &str) -> PlayerId {
    PlayerId::new(text)
}

fn join(room: &mut NetRoom, who: &str) {
    room.apply(NetChange::Join { id: id(who), name: who.to_uppercase(), avatar_url: String::new() });
}

fn seated_room() -> NetRoom {
    let mut room = NetRoom::new(None);
    room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
    for who in ["carol", "alice", "bob"] {
        join(&mut room, who);
    }
    room.apply(NetChange::Me(Some(id("bob"))));
    room.apply(NetChange::Host(Some(id("bob"))));
    room
}

#[test]
fn players_iterate_in_id_order_with_me_flagged_and_remotes_without_me() {
    let mut room = seated_room();
    let frame = room.cut(1, NetMode::Loopback);
    let order: Vec<&str> = frame.players().map(|p| p.id().as_str()).collect();
    assert_eq!(order, ["alice", "bob", "carol"]);
    let remotes: Vec<&str> = frame.remotes().map(|p| p.id().as_str()).collect();
    assert_eq!(remotes, ["alice", "carol"]);
    assert!(frame.player(&id("bob")).is_some_and(|p| p.is_me()));
    assert_eq!(frame.player(&id("alice")).map(|p| p.name()), Some("ALICE"));
    assert!(frame.player(&id("zed")).is_none());
    assert!(frame.is_host());
    assert_eq!(frame.connected(), 3);
    assert_eq!(frame.changes().len(), 6, "every change since the last cut");
}

#[test]
fn is_host_needs_joined_and_a_settled_host() {
    let mut room = seated_room();
    room.apply(NetChange::Host(None));
    assert!(!room.cut(1, NetMode::Loopback).is_host(), "authority not settled");
    room.apply(NetChange::Host(Some(id("bob"))));
    room.apply(NetChange::Status { status: NetStatus::Reconnecting, reason: None });
    assert!(!room.cut(2, NetMode::Loopback).is_host(), "not joined");
}

#[test]
fn objects_and_shared_read_in_order_with_mine_derived_from_me() {
    let mut room = seated_room();
    for (name, owner) in [("zeta", Some("bob")), ("alpha", Some("carol")), ("mid", None)] {
        let change = NetChange::Object { id: Arc::from(name), owner: owner.map(id), epoch: 2, raw: json!({ "n": 1 }), smoothed: None, pose: None };
        room.apply(change);
    }
    room.apply(NetChange::Shared { key: "score".into(), value: Some(json!(3)) });
    room.apply(NetChange::Shared { key: "round".into(), value: Some(json!(1)) });
    room.apply(NetChange::Shared { key: "round".into(), value: None });
    let frame = room.cut(1, NetMode::Loopback);
    let objects: Vec<(&str, bool)> = frame.objects().map(|o| (o.id(), o.mine())).collect();
    assert_eq!(objects, [("alpha", false), ("mid", false), ("zeta", true)]);
    assert_eq!(frame.object("alpha").and_then(|o| o.owner()).map(PlayerId::as_str), Some("carol"));
    assert_eq!(frame.object("zeta").map(|o| o.epoch()), Some(2));
    assert_eq!(frame.shared("score"), Some(&json!(3)));
    assert_eq!(frame.shared("round"), None, "deleted");
    assert_eq!(frame.shared_keys().collect::<Vec<_>>(), ["score"]);

    room.apply(NetChange::Me(Some(id("carol"))));
    let frame = room.cut(2, NetMode::Loopback);
    assert!(frame.object("alpha").is_some_and(|o| o.mine()), "mine follows me");
    assert!(frame.player(&id("carol")).is_some_and(|p| p.is_me()));
    assert!(frame.player(&id("bob")).is_some_and(|p| !p.is_me()));
}

#[test]
fn views_are_shared_until_something_in_them_changes() {
    let mut room = seated_room();
    let first = room.cut(1, NetMode::Loopback);
    let same = room.cut(2, NetMode::Loopback);
    let pointer = |frame: &NetFrame, who: &str| std::ptr::from_ref(frame.player(&id(who)).expect("seated"));
    assert_eq!(pointer(&first, "alice"), pointer(&same, "alice"), "an unchanged roster is the same allocation");
    assert!(same.changes().is_empty());

    room.apply(NetChange::PlayerState { id: id("alice"), raw: json!({ "x": 1 }), smoothed: Some(json!({ "x": 0.5 })), pose_raw: None, pose: None });
    let changed = room.cut(3, NetMode::Loopback);
    assert_ne!(pointer(&first, "alice"), pointer(&changed, "alice"), "a changed player is rebuilt");
    assert_eq!(pointer(&first, "carol"), pointer(&changed, "carol"), "the others stay shared");
    let alice = changed.player(&id("alice")).expect("seated");
    assert_eq!((alice.state_raw(), alice.state()), (&json!({ "x": 1 }), &json!({ "x": 0.5 })));
    assert_eq!(first.player(&id("alice")).map(|p| p.state_raw().clone()), Some(serde_json::Value::Null), "an old frame never changes");
}

#[test]
fn events_past_the_per_tick_cap_carry_into_the_next_tick_behind_a_warning() {
    let mut room = seated_room();
    let total = NET_EVENTS_PER_TICK_MAX + 500;
    for attempt in 0..total {
        room.push_event(NetEvent::Reconnecting { attempt: u32::try_from(attempt).expect("small") });
    }
    let first = room.cut(1, NetMode::Loopback);
    assert_eq!(first.events().len(), NET_EVENTS_PER_TICK_MAX);
    assert_eq!(first.events().last(), Some(&NetEvent::Warning { code: NetWarning::EventsDeferred }));
    assert_eq!(first.events()[0], NetEvent::Reconnecting { attempt: 0 });
    let second = room.cut(2, NetMode::Loopback);
    assert_eq!(second.events().len(), total - (NET_EVENTS_PER_TICK_MAX - 1), "the rest, in order");
    assert_eq!(second.events()[0], NetEvent::Reconnecting { attempt: u32::try_from(NET_EVENTS_PER_TICK_MAX - 1).expect("small") });
    assert!(room.cut(3, NetMode::Loopback).events().is_empty());
}

#[test]
fn matchmaking_lobby_code_and_server_clock_read_from_the_frame() {
    let mut room = seated_room();
    let standing = NetMatch::new(MatchStatus::Waiting).with_queue(2, 5).with_players(vec![id("bob")]).with_limits(2, 8);
    room.apply(NetChange::Match(Some(standing.clone())));
    room.apply(NetChange::LobbyCode(Some("AB12".into())));
    room.apply(NetChange::ServerMs(Some(1234.5)));
    room.apply(NetChange::RoomOpen(true));
    let frame = room.cut(1, NetMode::Relay);
    assert_eq!(frame.matchmaking(), Some(&standing));
    assert_eq!(frame.matchmaking().map(NetMatch::queue), Some((2, 5)));
    assert_eq!(frame.lobby_code(), Some("AB12"));
    assert_eq!(frame.server_ms(), Some(1234.5));
    assert!(frame.room_open());
    assert_eq!(frame.mode(), NetMode::Relay);
}

/// A relay-shaped backend for the timing row: 64 seats and 128 objects, a quarter of the seats and
/// objects publishing each tick (15 Hz), the server clock sampled every tick.
struct Busy {
    room: NetRoom,
    applied: usize,
}

impl Busy {
    fn new() -> Busy {
        let mut room = NetRoom::new(None);
        room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
        for n in 0..NET_PLAYERS_MAX {
            room.apply(NetChange::Join { id: id(&format!("p{n:02}")), name: format!("Player {n}"), avatar_url: String::new() });
        }
        room.apply(NetChange::Me(Some(id("p00"))));
        room.apply(NetChange::Host(Some(id("p00"))));
        for n in 0..NET_OBJECTS_MAX {
            let owner = if n % 8 == 0 { "p00".to_owned() } else { format!("p{:02}", n % NET_PLAYERS_MAX) };
            room.apply(NetChange::Object { id: Arc::from(format!("o{n:03}")), owner: Some(id(&owner)), epoch: 0, raw: json!({}), smoothed: None, pose: None });
        }
        Busy { room, applied: 0 }
    }

    /// What arrives between two cuts.
    fn arrive(&mut self, tick: u64) {
        let phase = usize::try_from(tick % 4).expect("small");
        for n in (phase..NET_PLAYERS_MAX).step_by(4).skip(1) {
            let state = json!({ "x": n as f64 * 0.25, "y": 1.5, "z": tick as f64 * 0.125, "yaw": 0.75 });
            self.room.apply(NetChange::PlayerState { id: id(&format!("p{n:02}")), raw: state, smoothed: None, pose_raw: None, pose: None });
        }
        for n in (phase..NET_OBJECTS_MAX).step_by(4).filter(|n| n % 8 != 0) {
            let owner = id(&format!("p{:02}", n % NET_PLAYERS_MAX));
            let raw = json!({ "x": tick as f64 * 0.5, "hp": 3 });
            self.room.apply(NetChange::Object { id: Arc::from(format!("o{n:03}")), owner: Some(owner), epoch: 0, raw, smoothed: None, pose: None });
        }
        self.room.apply(NetChange::ServerMs(Some(tick as f64 * 16.0 + 0.25)));
    }
}

impl NetBackend for Busy {
    fn pump(&mut self) {}

    fn cut(&mut self, tick: u64) -> NetFrame {
        self.room.cut(tick, NetMode::Relay)
    }

    fn apply(&mut self, _tick: u64, writes: NetWrites) {
        self.applied += writes.len();
    }

    fn mode(&self) -> NetMode {
        NetMode::Relay
    }
}

#[test]
#[ignore = "timing row (advisory in lanes): cargo test --release -p genex-net --test frame -- --ignored --nocapture"]
#[allow(clippy::disallowed_types)] // A timing row reads the wall clock; the simulation never does.
fn cut_plus_apply_for_64_players_and_128_objects() {
    let mut backend = Busy::new();
    let mut journal = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    let mut net = Net::fresh(NetMode::Relay, &NetConfig::new());
    let mut spent = Vec::new();
    for tick in 0..3600_u64 {
        backend.arrive(tick);
        let started = std::time::Instant::now();
        let frame = backend.cut(tick);
        journal.append(&frame);
        net.begin(frame);
        net.set_me(json!({ "x": tick as f64 * 0.01, "y": 1.0 })).expect("joined");
        for n in (0..NET_OBJECTS_MAX).step_by(8) {
            net.set_object(&format!("o{n:03}"), json!({ "x": 1.0 })).expect("mine");
        }
        let writes = net.end();
        backend.apply(tick, writes);
        spent.push(started.elapsed().as_nanos());
    }
    spent.sort_unstable();
    let median_us = spent[spent.len() / 2] as f64 / 1000.0;
    let p99_us = spent[spent.len() * 99 / 100] as f64 / 1000.0;
    println!("cut+journal+writes+apply, 64 players / 128 objects: median {median_us:.1} us, p99 {p99_us:.1} us");
    assert!(backend.applied > 0);
    assert!(median_us <= 50.0, "median {median_us:.1} us is over the 50 us budget");
}
