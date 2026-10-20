//! The write queue and its local refusals (MP-2a, new behaviour): reserved message names, invalid
//! states, coalescing at the publish rate, ownership and host checks, deterministic tickets, the
//! Off backend, and the protocol table held equal to the vendored genex-multiplayer crate's.

use std::sync::Arc;

use genex_net::backend::NetBackend;
use genex_net::frame::{NetChange, NetPose, NetRoom};
use genex_net::ids::{NetTicket, PlayerId};
use genex_net::net::{Net, NetConfig};
use genex_net::off::OffBackend;
use genex_net::vocab::{
    self, MatchStatus, NET_CHAT_CHARS_MAX, NET_OBJECTS_MAX, NetClose, NetControl, NetErrorCode, NetMode, NetOffline, NetStatus, NetWarning, limits,
};
use genex_net::writes::{NetRequest, NetSession};
use glam::{Quat, Vec3};
use serde_json::{Value, json};

/// The vendored client's protocol constants, compiled from its own source (the crate itself is not
/// a workspace member yet, owner call), so the restated table cannot drift.
#[allow(dead_code, clippy::all)]
#[path = "../../genex-multiplayer/src/protocol.rs"]
mod upstream;

const ME: &str = "me-1";
const OTHER: &str = "other-2";

/// A room where I am seated and joined; `host` says whether I am the host.
fn joined_room(host: bool) -> NetRoom {
    let me = PlayerId::new(ME);
    let other = PlayerId::new(OTHER);
    let mut room = NetRoom::new(None);
    room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
    room.apply(NetChange::Join { id: me.clone(), name: "Me".into(), avatar_url: String::new() });
    room.apply(NetChange::Join { id: other.clone(), name: "Other".into(), avatar_url: String::new() });
    room.apply(NetChange::Me(Some(me.clone())));
    room.apply(NetChange::Host(Some(if host { me } else { other })));
    room
}

fn object(room: &mut NetRoom, id: &str, owner: Option<&str>) {
    let change = NetChange::Object { id: Arc::from(id), owner: owner.map(PlayerId::new), epoch: 0, raw: json!({}), smoothed: None, pose: None };
    room.apply(change);
}

fn net_on(room: &mut NetRoom, tick: u64, config: &NetConfig) -> Net {
    let mut net = Net::fresh(NetMode::Loopback, config);
    net.begin(room.cut(tick, NetMode::Loopback));
    net
}

fn code<T: std::fmt::Debug>(result: Result<T, genex_net::vocab::NetError>) -> NetErrorCode {
    result.expect_err("a refusal").code()
}

#[test]
fn reserved_message_names_refuse_from_the_crate_table() {
    let mut room = joined_room(false);
    let mut net = net_on(&mut room, 0, &NetConfig::new());
    for kind in ["claim", "__x", "state", "match:score", "server:restart", "rate:drop", ""] {
        assert_eq!(code(net.send(kind, json!({}))), NetErrorCode::MessageReserved, "{kind:?}");
    }
    let long = "k".repeat(limits::MAX_EVENT_TYPE_CHARS + 1);
    assert_eq!(code(net.send(&long, json!({}))), NetErrorCode::MessageTooLarge);
    net.send("boom", json!({"at": 1})).expect("a game message");
    let writes = net.end();
    assert_eq!(writes.messages.len(), 1, "only the game message is queued");
    assert_eq!(writes.messages[0].kind, "boom");
}

#[test]
fn the_restated_protocol_table_equals_the_vendored_crate() {
    assert_eq!(vocab::RESERVED_EVENT_TYPES, upstream::RESERVED_EVENT_TYPES);
    assert_eq!(vocab::RESERVED_EVENT_PREFIXES, upstream::RESERVED_EVENT_PREFIXES);
    assert_eq!(vocab::RESERVED_SHARED_PREFIX, upstream::RESERVED_SHARED_PREFIX);
    for kind in ["claim", "__x", "match:score", "boom", "objective", "queued", "seat", "rate:x", "server:y", "statex"] {
        assert_eq!(vocab::is_reserved_event_type(kind), upstream::is_reserved_event_type(kind), "{kind}");
    }
    let pairs = [
        (limits::MAX_STATE_BYTES, upstream::limits::MAX_STATE_BYTES),
        (limits::MAX_SHARED_KEY_CHARS, upstream::limits::MAX_SHARED_KEY_CHARS),
        (limits::MAX_SHARED_VALUE_BYTES, upstream::limits::MAX_SHARED_VALUE_BYTES),
        (limits::MAX_SHARED_KEYS, upstream::limits::MAX_SHARED_KEYS),
        (limits::MAX_OBJECT_ID_CHARS, upstream::limits::MAX_OBJECT_ID_CHARS),
        (limits::MAX_OBJECT_STATE_BYTES, upstream::limits::MAX_OBJECT_STATE_BYTES),
        (limits::MAX_EVENT_BYTES, upstream::limits::MAX_EVENT_BYTES),
        (limits::MAX_EVENT_TYPE_CHARS, upstream::limits::MAX_EVENT_TYPE_CHARS),
        (limits::MAX_JSON_DEPTH, upstream::limits::MAX_JSON_DEPTH),
        (limits::MAX_JSON_NODES, upstream::limits::MAX_JSON_NODES),
        (NET_CHAT_CHARS_MAX, upstream::limits::MAX_CHAT_CHARS),
        (NET_OBJECTS_MAX, upstream::limits::MAX_OBJECTS),
        (vocab::NET_PLAYERS_MAX, upstream::limits::ROOM_MAX_CLIENTS),
    ];
    for (ours, theirs) in pairs {
        assert_eq!(ours, theirs);
    }
}

#[test]
fn every_terminal_close_code_maps_to_one_net_close() {
    use upstream::close_code as cc;
    let terminal = [cc::NORMAL, cc::CONSENTED, cc::SERVER_SHUTDOWN, cc::WITH_ERROR, cc::FAILED_TO_RECONNECT, cc::REVOKED, cc::SUPERSEDED];
    for code in terminal {
        assert!(!cc::is_reconnectable(code), "{code} is terminal upstream");
        let named: Vec<NetClose> = NetClose::ALL.iter().copied().filter(|close| close.code() == Some(code)).collect();
        assert_eq!(named.len(), 1, "close code {code} names exactly one NetClose: {named:?}");
    }
    assert_eq!(NetClose::Replaced.code(), Some(4409));
    assert_eq!(NetClose::Left.code(), None, "a deliberate leave is local");
}

#[test]
fn every_vocabulary_round_trips_its_wire_spelling() {
    fn check<T: Copy + PartialEq + std::fmt::Debug>(all: &[T], wire: fn(T) -> &'static str, from: fn(&str) -> Option<T>) {
        let mut seen = std::collections::BTreeSet::new();
        for value in all {
            assert_eq!(from(wire(*value)), Some(*value));
            assert!(seen.insert(wire(*value)), "{} is spelled twice", wire(*value));
        }
        assert_eq!(from("no-such-word"), None);
    }
    check(NetMode::ALL, NetMode::wire, NetMode::from_wire);
    check(NetStatus::ALL, NetStatus::wire, NetStatus::from_wire);
    check(NetOffline::ALL, NetOffline::wire, NetOffline::from_wire);
    check(NetErrorCode::ALL, NetErrorCode::wire, NetErrorCode::from_wire);
    check(NetControl::ALL, NetControl::wire, NetControl::from_wire);
    check(NetClose::ALL, NetClose::wire, NetClose::from_wire);
    check(MatchStatus::ALL, MatchStatus::wire, MatchStatus::from_wire);
    check(NetWarning::ALL, NetWarning::wire, NetWarning::from_wire);
    assert_eq!(NetErrorCode::ALL.len(), 9);
    assert_eq!(NetControl::ALL.len(), 9);
}

#[test]
fn invalid_states_refuse_net_state_invalid() {
    let mut room = joined_room(false);
    let mut net = net_on(&mut room, 0, &NetConfig::new());
    let nan_pose = NetPose { position: Vec3::new(f32::NAN, 0.0, 0.0), rotation: Quat::IDENTITY };
    assert_eq!(code(net.set_me_pose(nan_pose, json!({}))), NetErrorCode::StateInvalid, "a NaN in a pose");
    let inf_pose = NetPose { position: Vec3::ZERO, rotation: Quat::from_xyzw(0.0, f32::INFINITY, 0.0, 1.0) };
    assert_eq!(code(net.set_me_pose(inf_pose, json!({}))), NetErrorCode::StateInvalid, "an infinity in a pose");
    // serde_json cannot hold a NaN: `json!` already turns it into null, so it never reaches the wire.
    assert_eq!(json!({ "x": f64::NAN }), json!({ "x": null }));
    assert_eq!(code(net.set_me(json!([1, 2]))), NetErrorCode::StateInvalid, "not an object");
    assert_eq!(code(net.set_me(json!(3.5))), NetErrorCode::StateInvalid, "not an object");
    let mut deep = json!(1);
    for _ in 0..40 {
        deep = json!({ "d": deep });
    }
    assert_eq!(code(net.set_me(deep)), NetErrorCode::StateInvalid, "nested past the relay's depth");
    let big = json!({ "blob": "x".repeat(limits::MAX_STATE_BYTES) });
    assert_eq!(code(net.set_me(big)), NetErrorCode::MessageTooLarge);
    assert!(net.end().me.is_none(), "nothing refused was queued");
}

#[test]
fn sixty_set_me_calls_at_15_hz_flush_15_times_each_the_latest() {
    let mut room = joined_room(false);
    let config = NetConfig::new().publish_hz(15);
    let mut net = Net::fresh(NetMode::Loopback, &config);
    let mut flushed = Vec::new();
    for tick in 0..60_u64 {
        net.begin(room.cut(tick, NetMode::Loopback));
        net.set_me(json!({ "n": tick })).expect("joined");
        let writes = net.end();
        if let Some(me) = writes.me {
            assert!(!me.snap);
            flushed.push((tick, me.state["n"].as_u64().expect("n")));
        }
    }
    assert_eq!(flushed.len(), 15);
    for (tick, value) in flushed {
        assert_eq!(tick % 4, 0, "a publish tick");
        assert_eq!(value, tick, "the latest value set before the flush");
    }
}

#[test]
fn snaps_leave_on_their_own_tick_and_numbers_round_at_flush() {
    let mut room = joined_room(false);
    let config = NetConfig::new().publish_hz(15).decimals(3);
    let mut net = net_on(&mut room, 1, &config);
    net.snap_me(json!({ "x": 1.234_567_89, "hp": 7, "tag": "a" })).expect("joined");
    let me = net.end().me.expect("a snap leaves on a non-publish tick");
    assert!(me.snap);
    assert_eq!(me.state, json!({ "x": 1.235, "hp": 7, "tag": "a" }));
    net.begin(room.cut(2, NetMode::Loopback));
    net.set_me(json!({ "x": 0.1 })).expect("joined");
    assert!(net.end().me.is_none(), "coalesced until the publish tick");
}

#[test]
fn object_writes_need_ownership_and_requests_mint_tickets() {
    let mut room = joined_room(false);
    object(&mut room, "ball", Some(OTHER));
    object(&mut room, "flag", Some(ME));
    object(&mut room, "free", None);
    let mut net = net_on(&mut room, 4, &NetConfig::new());
    assert_eq!(code(net.set_object("ball", json!({}))), NetErrorCode::NotOwner, "another player's object");
    assert_eq!(code(net.set_object("free", json!({}))), NetErrorCode::NotOwner, "nobody's object");
    assert_eq!(code(net.set_object("ghost", json!({}))), NetErrorCode::NotOwner, "no such object");
    assert_eq!(code(net.remove("ball")), NetErrorCode::NotOwner);
    net.set_object("flag", json!({ "x": 1 })).expect("mine");
    assert_eq!(net.claim("ball"), Ok(NetTicket::new(1)));
    assert_eq!(net.release("flag"), Ok(NetTicket::new(2)));
    assert_eq!(code(net.claim_as_host("free")), NetErrorCode::NotHost);
    let writes = net.end();
    assert!(writes.objects.is_empty(), "a release forgets the object's coalesced state");
    assert_eq!(writes.requests.len(), 2);
    assert!(matches!(&writes.requests[0], NetRequest::Claim { ticket, id, as_host: false } if ticket.number() == 1 && id == "ball"));

    let mut fresh = net_on(&mut joined_room(false), 4, &NetConfig::new());
    assert_eq!(fresh.claim("ball"), Ok(NetTicket::new(1)), "tickets count per seed");
}

#[test]
fn a_claim_past_the_object_cap_refuses() {
    let mut room = joined_room(false);
    for n in 0..NET_OBJECTS_MAX {
        object(&mut room, &format!("o{n:03}"), None);
    }
    let mut net = net_on(&mut room, 0, &NetConfig::new());
    assert_eq!(code(net.claim("one-more")), NetErrorCode::ObjectCap);
    assert!(net.claim("o000").is_ok(), "an existing object can still be claimed");
}

#[test]
fn host_only_writes_and_seat_checks() {
    let mut room = joined_room(false);
    let mut net = net_on(&mut room, 0, &NetConfig::new());
    assert_eq!(code(net.set_shared("round", json!(1))), NetErrorCode::NotHost);
    assert_eq!(code(net.set_room_open(false)), NetErrorCode::NotHost);
    assert_eq!(code(net.chat(&"é".repeat(NET_CHAT_CHARS_MAX + 1))), NetErrorCode::ChatTooLong);
    net.chat(&"é".repeat(NET_CHAT_CHARS_MAX)).expect("at the cap");
    assert_eq!(code(net.join_private("bad code!")), NetErrorCode::CodeInvalid);
    assert_eq!(code(net.join_private("")), NetErrorCode::CodeInvalid);
    net.join_private("AB12cd").expect("a code");

    let mut host_room = joined_room(true);
    let mut host = net_on(&mut host_room, 0, &NetConfig::new());
    assert!(host.is_host());
    assert_eq!(code(host.set_shared("__secret", json!(1))), NetErrorCode::MessageReserved);
    host.set_shared("round", json!(2)).expect("host");
    host.set_room_open(false).expect("host");
    let writes = host.end();
    assert_eq!(writes.shared, vec![("round".to_owned(), json!(2))]);
    assert_eq!(writes.room_open, Some(false));
}

#[test]
fn every_write_but_session_steps_refuses_before_joining() {
    let mut net = Net::fresh(NetMode::Loopback, &NetConfig::new());
    assert_eq!(net.status(), NetStatus::Offline);
    assert_eq!(code(net.set_me(json!({}))), NetErrorCode::NotJoined);
    assert_eq!(code(net.claim("x")), NetErrorCode::NotJoined);
    assert_eq!(code(net.chat("hi")), NetErrorCode::NotJoined);
    assert_eq!(code(net.send("boom", Value::Null)), NetErrorCode::NotJoined);
    assert_eq!(code(net.send_to_host(json!({ "jump": true }))), NetErrorCode::NotJoined);
    net.connect();
    net.leave();
    assert_eq!(net.end().session, vec![NetSession::Connect, NetSession::Leave]);
}

#[test]
fn the_off_backend_is_offline_net_disabled_and_counts_what_reaches_it() {
    let config = NetConfig::new();
    let mut backend = OffBackend::new();
    let mut net = Net::fresh(NetMode::Off, &config);
    assert_eq!(net.offline_reason(), Some(NetOffline::Disabled));
    for tick in 0..3 {
        backend.pump();
        net.begin(backend.cut(tick));
        assert_eq!((net.mode(), net.status(), net.offline_reason()), (NetMode::Off, NetStatus::Offline, Some(NetOffline::Disabled)));
        assert_eq!(net.players().count(), 0);
        assert!(net.events().is_empty());
        net.connect();
        assert_eq!(code(net.set_me(json!({}))), NetErrorCode::NotJoined);
        backend.apply(tick, net.end());
    }
    assert_eq!(backend.dropped(), 3, "one connect per tick reached the backend and was dropped");
    assert_eq!(backend.mode(), NetMode::Off);
}

#[test]
fn net_config_reports_values_outside_the_caps() {
    assert_eq!(NetConfig::new().problem(), None);
    assert_eq!(NetConfig::default(), NetConfig::new());
    assert!(NetConfig::new().publish_hz(0).problem().is_some());
    assert!(NetConfig::new().publish_hz(31).problem().is_some());
    assert!(NetConfig::new().decimals(7).problem().is_some());
    assert!(NetConfig::new().interp_delay_ticks(0).problem().is_some());
    assert!(NetConfig::new().interp_delay_ticks(31).problem().is_some());
    assert_eq!(NetConfig::new().publish_hz(30).decimals(0).interp_delay_ticks(30).problem(), None);
}
