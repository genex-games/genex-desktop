//! The Relay backend's mapping (MP-3a): every crate event, control result (§7.2), match status (§9)
//! and terminal code (§11) maps to exactly one NetEvent, NetControl, MatchStatus or NetClose; with
//! no baked slug nothing opens; a held reply's retry delay becomes a tick; a recorded-shape session
//! cut through a counting fake gives the frames it should.
//!
//! Run with the feature: `cargo test -p genex-net --features relay --test relay_map`.
#![cfg(feature = "relay")]

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::rc::Rc;

use genex_multiplayer::{ControlResult, Error as SessionError, Event, ObjectView, PlayerView, RoomTarget};
use genex_net::backend::NetBackend;
use genex_net::frame::{NetEvent, NetPose};
use genex_net::ids::{NetTicket, PlayerId};
use genex_net::net::{Net, NetConfig};
use genex_net::relay::{RelayConnector, RelayEffect, RelayMap, RelaySession, close_reason, control_result, match_view, pose_from_state, retry_at_tick, state_with_pose};
use genex_net::vocab::{MatchStatus, NetClose, NetControl, NetMode, NetOffline, NetStatus};
use glam::{Quat, Vec3};
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("a fixture")).expect("fixture JSON")
}

/// Every `Event` variant's bridge tag. The match in `RelayMap::map` has no `_` arm, so a new
/// upstream variant fails the build; this list makes the fixture cover each one.
const EVENT_TAGS: [&str; 24] = [
    "joined",
    "joinFailed",
    "playerJoined",
    "playerLeft",
    "hostChanged",
    "sharedChanged",
    "objectChanged",
    "objectRemoved",
    "controlResult",
    "message",
    "input",
    "roomOpen",
    "chat",
    "rateDrop",
    "serverRestart",
    "matchStart",
    "matchEnded",
    "matchRequeue",
    "queue",
    "seated",
    "reconnecting",
    "reconnected",
    "disconnected",
    "warning",
];

#[test]
fn every_crate_event_maps_to_exactly_one_effect() {
    let events = fixture("events.json");
    let cut_tick = events["cut_tick"].as_u64().expect("a cut tick");
    let mut map = RelayMap::default();
    for (request, ticket) in events["tickets"].as_object().expect("tickets") {
        map.expect(request.clone(), NetTicket::new(u32::try_from(ticket.as_u64().expect("a ticket")).expect("small")));
    }
    let mut tags = BTreeSet::new();
    let mut wrong = Vec::new();
    for row in events["rows"].as_array().expect("rows") {
        let event: Event = serde_json::from_value(row["event"].clone()).expect("a crate event in its bridge shape");
        tags.insert(row["event"]["type"].as_str().expect("a tag").to_owned());
        let got = format!("{:?}", map.map(&event, cut_tick));
        if got != row["expect"].as_str().expect("an expectation") {
            wrong.push(format!("{}\n   got {got}\n  want {}", row["event"], row["expect"]));
        }
    }
    assert!(wrong.is_empty(), "mapped differently:\n{}", wrong.join("\n"));
    let missing: Vec<&str> = EVENT_TAGS.iter().copied().filter(|tag| !tags.contains(*tag)).collect();
    assert!(missing.is_empty(), "the fixture misses crate events {missing:?}");
    assert_eq!(map.in_flight(), 0, "every ticket in flight was settled");
}

#[test]
fn every_control_reason_maps_to_one_net_control_and_each_is_reached() {
    let controls = fixture("controls.json");
    let mut reached = BTreeSet::new();
    for row in controls["rows"].as_array().expect("rows") {
        let result = ControlResult {
            request_id: "r".into(),
            operation: "claim".into(),
            id: "ball".into(),
            accepted: row["accepted"].as_bool().expect("accepted"),
            owner: None,
            sequence: 0.0,
            reason: row["reason"].as_str().expect("a reason").into(),
            retry_after_ms: None,
        };
        let got = control_result(&result);
        assert_eq!(got.wire(), row["expect"].as_str().expect("a wire value"), "reason {}", result.reason);
        reached.insert(got);
    }
    let unreached: Vec<NetControl> = NetControl::ALL.iter().copied().filter(|control| !reached.contains(control)).collect();
    assert!(unreached.is_empty(), "no reason maps to {unreached:?}");
}

#[test]
fn every_terminal_close_code_maps_to_its_net_close() {
    for close in NetClose::ALL {
        if let Some(code) = close.code() {
            assert_eq!(close_reason(code), *close, "code {code}");
        }
    }
    for reconnectable in [1001, 1005, 1006, 4010] {
        assert_eq!(close_reason(reconnectable), NetClose::Other, "code {reconnectable} is not terminal");
    }
    let mut map = RelayMap::default();
    map.leaving();
    let closed = map.map(&Event::Disconnected { code: 4000, reason: "left".into() }, 5);
    assert_eq!(closed, RelayEffect::Seat { status: NetStatus::Closed, event: Some(NetEvent::Closed { reason: NetClose::Left }) });
}

#[test]
fn a_held_reply_retry_after_500_ms_is_the_cut_tick_plus_30() {
    assert_eq!(retry_at_tick(1000, Some(500.0)), Some(1030));
    assert_eq!(retry_at_tick(7, Some(1.0)), Some(8), "part of a tick waits the whole tick");
    assert_eq!(retry_at_tick(7, Some(0.0)), Some(7));
    assert_eq!(retry_at_tick(7, None), None);
    assert_eq!(retry_at_tick(7, Some(f64::NAN)), None);
    assert_eq!(retry_at_tick(7, Some(-5.0)), None);
}

#[test]
fn every_match_status_reads_from_the_match_state() {
    for status in MatchStatus::ALL {
        let view = match_view(&json!({"status": status.wire(), "players": ["s2", {"id": "s1"}], "minPlayers": 2, "maxPlayers": 4, "winnerId": "s1"}), (1, 3)).expect("a match");
        assert_eq!(view.status(), *status);
        assert_eq!(view.players(), &[PlayerId::new("s2"), PlayerId::new("s1")]);
        assert_eq!((view.min_players(), view.max_players(), view.queue()), (2, 4, (1, 3)));
        assert_eq!(view.winner(), Some(&PlayerId::new("s1")));
    }
    assert!(match_view(&json!({"status": "lobby"}), (0, 0)).is_none(), "an unknown status reads no match");
    assert!(match_view(&json!({}), (0, 0)).is_none());
}

#[test]
fn a_pose_travels_in_flat_keys_and_reads_back() {
    let pose = NetPose { position: Vec3::new(1.0, -2.5, 3.25), rotation: Quat::from_xyzw(0.0, 0.5, 0.0, 0.5) };
    let state = state_with_pose(json!({"hp": 3}), Some(pose));
    assert_eq!(state["pq"], json!([0.0, 0.5, 0.0, 0.5]));
    assert_eq!(pose_from_state(&state), Some(pose));
    assert_eq!(state_with_pose(json!({"hp": 3}), None), json!({"hp": 3}));
    assert_eq!(pose_from_state(&json!({"px": 1, "py": 2})), None, "a partial pose is no pose");
}

// ---- the counting fake --------------------------------------------------------------------------

/// What the fake session reports for one pump, from `session.json`.
#[derive(Clone, Debug, Default)]
struct Step {
    events: Vec<Event>,
    session_id: String,
    host_id: Option<String>,
    players: Vec<PlayerView>,
    objects: Vec<ObjectView>,
    shared: BTreeMap<String, Value>,
    match_state: Option<Value>,
    server_now: Option<f64>,
}

impl Step {
    fn from_json(step: &Value) -> Step {
        let list = |key: &str| step.get(key).cloned().unwrap_or(json!([]));
        Step {
            events: serde_json::from_value(list("events")).expect("events"),
            session_id: step["sessionId"].as_str().unwrap_or_default().into(),
            host_id: step["hostId"].as_str().map(str::to_owned),
            players: serde_json::from_value(list("players")).expect("players"),
            objects: serde_json::from_value(list("objects")).expect("objects"),
            shared: serde_json::from_value(step.get("shared").cloned().unwrap_or(json!({}))).expect("shared"),
            match_state: step.get("match").cloned(),
            server_now: step["serverNow"].as_f64(),
        }
    }
}

/// Everything the backend asked of the fake, shared with the test.
#[derive(Debug, Default)]
struct Calls {
    opened: Vec<RoomTarget>,
    polls: u32,
    left: u32,
    published: Vec<Value>,
    claims: Vec<String>,
}

struct FakeSession {
    calls: Rc<RefCell<Calls>>,
    script: Rc<RefCell<Vec<Step>>>,
    now: Step,
}

impl RelaySession for FakeSession {
    fn poll(&mut self) -> Vec<Event> {
        self.calls.borrow_mut().polls += 1;
        let mut script = self.script.borrow_mut();
        if script.is_empty() {
            return Vec::new();
        }
        self.now = script.remove(0);
        std::mem::take(&mut self.now.events)
    }
    fn players(&self) -> &[PlayerView] {
        &self.now.players
    }
    fn objects(&self) -> &[ObjectView] {
        &self.now.objects
    }
    fn shared(&self) -> BTreeMap<String, Value> {
        self.now.shared.clone()
    }
    fn session_id(&self) -> &str {
        &self.now.session_id
    }
    fn host_id(&self) -> Option<&str> {
        self.now.host_id.as_deref()
    }
    fn match_state(&self) -> Option<Value> {
        self.now.match_state.clone()
    }
    fn server_now(&self) -> Option<f64> {
        self.now.server_now
    }
    fn leave(&mut self) {
        self.calls.borrow_mut().left += 1;
    }
    fn set_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.calls.borrow_mut().published.push(state);
        Ok(())
    }
    fn snap_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.set_me(state)
    }
    fn set_object(&mut self, id: &str, _state: Value) -> Result<(), SessionError> {
        Err(SessionError::NotOwner(id.into()))
    }
    fn snap_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
        self.set_object(id, state)
    }
    fn claim(&mut self, id: &str) -> Result<String, SessionError> {
        let mut calls = self.calls.borrow_mut();
        calls.claims.push(id.into());
        Ok(format!("rs{}", calls.claims.len()))
    }
    fn claim_as_host(&mut self, id: &str) -> Result<String, SessionError> {
        self.claim(id)
    }
    fn release(&mut self, _id: &str) -> Result<String, SessionError> {
        Err(SessionError::NotConnected)
    }
    fn destroy(&mut self, id: &str) -> Result<String, SessionError> {
        self.release(id)
    }
    fn set_shared(&mut self, _key: &str, _value: &Value) -> Result<(), SessionError> {
        Ok(())
    }
    fn send(&mut self, _kind: &str, _data: &Value) -> Result<(), SessionError> {
        Ok(())
    }
    fn send_input(&mut self, _data: &Value) -> Result<(), SessionError> {
        Ok(())
    }
    fn set_room_open(&mut self, _open: bool) -> Result<(), SessionError> {
        Ok(())
    }
    fn chat_send(&mut self, _text: &str) -> Result<(), SessionError> {
        Ok(())
    }
    fn report_eliminated(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn report_finish(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn report_score(&mut self, _delta: f64) -> Result<(), SessionError> {
        Ok(())
    }
}

struct FakeConnector {
    slug: Option<String>,
    calls: Rc<RefCell<Calls>>,
    script: Rc<RefCell<Vec<Step>>>,
}

impl RelayConnector for FakeConnector {
    type Session = FakeSession;

    fn slug(&self) -> Option<&str> {
        self.slug.as_deref()
    }

    fn open(&mut self, _slug: &str, room: RoomTarget) -> Result<FakeSession, String> {
        self.calls.borrow_mut().opened.push(room);
        Ok(FakeSession { calls: self.calls.clone(), script: self.script.clone(), now: Step::default() })
    }
}

/// A seat over a Relay backend with a fake connector, stepped like the runtime.
struct Rig {
    backend: genex_net::relay::RelayBackend<FakeConnector>,
    net: Net,
    tick: u64,
    calls: Rc<RefCell<Calls>>,
    script: Rc<RefCell<Vec<Step>>>,
}

impl Rig {
    fn new(slug: Option<&str>) -> Rig {
        let calls = Rc::new(RefCell::new(Calls::default()));
        let script = Rc::new(RefCell::new(Vec::new()));
        let connector = FakeConnector { slug: slug.map(str::to_owned), calls: calls.clone(), script: script.clone() };
        Rig { backend: genex_net::relay::RelayBackend::new(connector), net: Net::fresh(NetMode::Relay, &NetConfig::new()), tick: 0, calls, script }
    }

    fn step(&mut self, hook: impl FnOnce(&mut Net)) -> genex_net::frame::NetFrame {
        self.backend.pump();
        let frame = self.backend.cut(self.tick);
        self.net.begin(frame.clone());
        hook(&mut self.net);
        self.backend.apply(self.tick, self.net.end());
        self.tick += 1;
        frame
    }

    fn queue(&mut self, step: Step) {
        self.script.borrow_mut().push(step);
    }
}

#[test]
fn with_no_slug_the_seat_is_offline_and_no_socket_opens() {
    let mut rig = Rig::new(None);
    let frame = rig.step(Net::connect);
    assert_eq!(frame.status(), NetStatus::Offline);
    assert_eq!(frame.offline_reason(), Some(NetOffline::NoSlug));
    rig.step(Net::matchmake);
    for _ in 0..5 {
        let frame = rig.step(|_| {});
        assert_eq!((frame.status(), frame.offline_reason()), (NetStatus::Offline, Some(NetOffline::NoSlug)));
    }
    let calls = rig.calls.borrow();
    assert!(calls.opened.is_empty(), "opened {:?}", calls.opened);
    assert_eq!(calls.polls, 0);
    assert_eq!(rig.backend.stats().opened, 0);
}

#[test]
fn a_recorded_session_cuts_the_frames_it_should() {
    let session = fixture("session.json");
    let mut rig = Rig::new(Some("tag-arena"));
    rig.step(Net::connect);
    assert_eq!(rig.calls.borrow().opened, vec![RoomTarget::Play]);
    let frame = rig.step(|_| {});
    assert_eq!(frame.status(), NetStatus::Connecting);
    for (index, step) in session["steps"].as_array().expect("steps").iter().enumerate() {
        rig.queue(Step::from_json(step));
        let frame = rig.step(|_| {});
        let want = &step["expect"];
        let at = format!("step {index}");
        assert_eq!(frame.status().wire(), want["status"], "{at}");
        assert_eq!(frame.me().map(PlayerId::as_str), want["me"].as_str(), "{at}");
        assert_eq!(frame.host().map(PlayerId::as_str), want["host"].as_str(), "{at}");
        assert_eq!(Value::from(frame.is_host()), want["isHost"], "{at}");
        assert_eq!(Value::from(frame.players().count()), want["players"], "{at}");
        assert_eq!(Value::from(frame.connected()), want["connected"], "{at}");
        assert_eq!(Value::from(frame.events().len()), want["events"], "{at}: {:?}", frame.events());
        match index {
            0 => {
                let bo = frame.player(&PlayerId::new("s2")).expect("Bo");
                assert_eq!(bo.state_raw()["x"], json!(5.0));
                assert_eq!(bo.state()["x"], json!(4.5), "the crate's smoothed view is what Bo draws");
                assert_eq!(bo.pose().map(|p| p.position), Some(Vec3::new(1.0, 2.0, 3.0)));
                assert_eq!(bo.pose_raw().map(|p| p.position), Some(Vec3::new(1.0, 2.0, 3.5)));
                let ball = frame.object("ball").expect("the ball");
                assert_eq!((ball.epoch(), ball.owner().map(PlayerId::as_str), ball.mine()), (2, Some("s2"), false));
                assert_eq!(frame.shared("phase"), Some(&json!("lobby")));
                assert_eq!(frame.server_ms(), Some(1234.5));
            }
            1 => {
                assert_eq!(frame.events(), &[NetEvent::Dropped { player: PlayerId::new("s2") }]);
                assert!(frame.object("ball").is_none());
                assert_eq!(frame.shared("phase"), Some(&json!("play")));
            }
            _ => {
                assert_eq!(frame.events(), &[NetEvent::Match { status: MatchStatus::Playing }]);
                let matchmaking = frame.matchmaking().expect("a match");
                assert_eq!((matchmaking.status(), matchmaking.min_players(), matchmaking.winner()), (MatchStatus::Playing, 2, None));
            }
        }
    }
}

#[test]
fn claims_carry_their_ticket_and_a_held_answer_retries_30_ticks_after_its_cut() {
    let mut rig = Rig::new(Some("tag-arena"));
    rig.step(Net::connect);
    rig.queue(Step {
        events: vec![Event::Joined { session_id: "s1".into() }],
        session_id: "s1".into(),
        host_id: Some("s1".into()),
        players: vec![PlayerView { id: "s1".into(), connected: true, is_me: true, ..PlayerView::default() }],
        ..Step::default()
    });
    assert_eq!(rig.step(|_| {}).status(), NetStatus::Joined);
    let mut ticket = None;
    rig.step(|net| ticket = Some(net.claim("ball").expect("a claim")));
    let ticket = ticket.expect("a ticket");
    assert_eq!(rig.calls.borrow().claims, vec!["ball".to_owned()]);
    let held = ControlResult {
        request_id: "rs1".into(),
        operation: "claim".into(),
        id: "ball".into(),
        accepted: false,
        owner: None,
        sequence: 0.0,
        reason: "held".into(),
        retry_after_ms: Some(500.0),
    };
    let views = |events| Step { events, session_id: "s1".into(), host_id: Some("s1".into()), ..Step::default() };
    rig.queue(views(vec![Event::ControlResult(held)]));
    let cut = rig.tick;
    let frame = rig.step(|_| {});
    assert_eq!(frame.events(), &[NetEvent::Control { ticket, result: NetControl::Held, retry_at_tick: Some(cut + 30) }]);

    rig.step(|net| net.set_me_pose(NetPose { position: Vec3::X, rotation: Quat::IDENTITY }, json!({"hp": 1})).expect("a pose"));
    for _ in 0..4 {
        rig.step(|_| {});
    }
    let published = rig.calls.borrow().published.clone();
    assert_eq!(published.len(), 1, "one coalesced publish");
    assert_eq!(published[0]["hp"], json!(1));
    assert_eq!(pose_from_state(&published[0]).map(|pose| pose.position), Some(Vec3::X), "the pose leaves in the flat keys");
}

#[test]
fn leave_closes_as_left_and_empties_the_views() {
    let mut rig = Rig::new(Some("tag-arena"));
    rig.step(Net::connect);
    let joined = Step {
        events: vec![Event::Joined { session_id: "s1".into() }],
        session_id: "s1".into(),
        host_id: Some("s1".into()),
        players: vec![PlayerView { id: "s1".into(), connected: true, is_me: true, ..PlayerView::default() }],
        ..Step::default()
    };
    rig.queue(joined);
    assert_eq!(rig.step(|_| {}).players().count(), 1);
    rig.step(Net::leave);
    assert_eq!(rig.calls.borrow().left, 1);
    rig.queue(Step { events: vec![Event::Disconnected { code: 4000, reason: "left".into() }], ..Step::default() });
    let frame = rig.step(|_| {});
    assert_eq!(frame.status(), NetStatus::Closed);
    assert_eq!(frame.events(), &[NetEvent::Closed { reason: NetClose::Left }]);
    assert_eq!(frame.players().count(), 0);
    assert_eq!(frame.me(), None);
    rig.step(Net::connect);
    assert_eq!(rig.calls.borrow().opened.len(), 2, "a closed seat can connect again");
}
