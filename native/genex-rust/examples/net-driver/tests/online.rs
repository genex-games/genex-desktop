//! The facade driver's online answers (multiplayer MP-6b, new behaviour) over the facade's real
//! `RelayBackend` with a scripted session behind the connector, so no socket opens: what the
//! driver prints for a join, a control result, a refusal the facade makes before a request
//! leaves, a game event, a host change, a reconnect and a terminal close. The same answers over a
//! real relay are the bench row in `parity.rs` (owner machine).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use genex_multiplayer::{ChatMessage, ControlResult, Error as SessionError, Event, ObjectView, PlayerView, RoomTarget};
use genex_net::relay::{RelayBackend, RelayConnector, RelaySession};
use net_driver::{BenchJoin, Driver};
use serde_json::{Value, json};

/// The fake relay room one driver's session sees, shared with the test.
#[derive(Debug, Default)]
struct Room {
    joins: Vec<BenchJoin>,
    events: Vec<Event>,
    players: Vec<PlayerView>,
    objects: Vec<ObjectView>,
    shared: BTreeMap<String, Value>,
    session_id: String,
    host: Option<String>,
    requests: Vec<(String, String)>,
    published: Vec<Value>,
    left: u32,
}

type Shared = Rc<RefCell<Room>>;

struct FakeSession {
    room: Shared,
    players: Vec<PlayerView>,
    objects: Vec<ObjectView>,
    session_id: String,
    host: Option<String>,
}

impl FakeSession {
    fn request(&mut self, operation: &str, id: &str) -> Result<String, SessionError> {
        let mut room = self.room.borrow_mut();
        let request_id = format!("rq{}", room.requests.len() + 1);
        room.requests.push((operation.to_owned(), id.to_owned()));
        Ok(request_id)
    }
}

impl RelaySession for FakeSession {
    fn poll(&mut self) -> Vec<Event> {
        let mut room = self.room.borrow_mut();
        self.players = room.players.clone();
        self.objects = room.objects.clone();
        self.session_id = room.session_id.clone();
        self.host = room.host.clone();
        std::mem::take(&mut room.events)
    }
    fn players(&self) -> &[PlayerView] {
        &self.players
    }
    fn objects(&self) -> &[ObjectView] {
        &self.objects
    }
    fn shared(&self) -> BTreeMap<String, Value> {
        self.room.borrow().shared.clone()
    }
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn host_id(&self) -> Option<&str> {
        self.host.as_deref()
    }
    fn match_state(&self) -> Option<Value> {
        None
    }
    fn server_now(&self) -> Option<f64> {
        None
    }
    fn leave(&mut self) {
        self.room.borrow_mut().left += 1;
    }
    fn set_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.room.borrow_mut().published.push(state);
        Ok(())
    }
    fn snap_me(&mut self, state: Value) -> Result<(), SessionError> {
        self.set_me(state)
    }
    fn set_object(&mut self, _id: &str, state: Value) -> Result<(), SessionError> {
        self.set_me(state)
    }
    fn snap_object(&mut self, id: &str, state: Value) -> Result<(), SessionError> {
        self.set_object(id, state)
    }
    fn claim(&mut self, id: &str) -> Result<String, SessionError> {
        self.request("claim", id)
    }
    fn claim_as_host(&mut self, id: &str) -> Result<String, SessionError> {
        self.request("claim-host", id)
    }
    fn release(&mut self, id: &str) -> Result<String, SessionError> {
        self.request("release", id)
    }
    fn destroy(&mut self, id: &str) -> Result<String, SessionError> {
        self.request("remove", id)
    }
    fn set_shared(&mut self, key: &str, value: &Value) -> Result<(), SessionError> {
        self.room.borrow_mut().shared.insert(key.to_owned(), value.clone());
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
    room: Shared,
    slug: String,
}

impl RelayConnector for FakeConnector {
    type Session = FakeSession;

    fn slug(&self) -> Option<&str> {
        Some(&self.slug)
    }

    fn open(&mut self, _slug: &str, _room: RoomTarget) -> Result<FakeSession, String> {
        Ok(FakeSession { room: self.room.clone(), players: Vec::new(), objects: Vec::new(), session_id: String::new(), host: None })
    }
}

/// A driver whose `connect` opens the fake room, and the room.
fn rig() -> (Driver, Shared) {
    let room: Shared = Rc::default();
    let opened = room.clone();
    let driver = Driver::with_backend(Box::new(move |join: BenchJoin| {
        let slug = join.game_id.clone();
        opened.borrow_mut().joins.push(join);
        Box::new(RelayBackend::new(FakeConnector { room: opened.clone(), slug }))
    }));
    (driver, room)
}

fn player(id: &str, name: &str, state: Value) -> PlayerView {
    PlayerView { id: id.into(), name: name.into(), uid: format!("u-{id}"), team: -1, connected: true, state: state.clone(), state_raw: state, ..PlayerView::default() }
}

fn object(id: &str, owner: Option<&str>, state: Value) -> ObjectView {
    ObjectView { id: id.into(), owner: owner.map(str::to_owned), seq: 1.0, epoch: 0.0, state: state.clone(), state_raw: state }
}

/// One loop turn: pump, then one tick; answers what the driver printed.
fn turn(driver: &mut Driver) -> Vec<Value> {
    driver.pump();
    driver.tick();
    driver.take_output()
}

/// Send `command`; answers what the driver printed at once.
fn send(driver: &mut Driver, command: Value) -> Vec<Value> {
    driver.command(&command.to_string());
    driver.take_output()
}

/// Seat the driver as `me` in a room with `bob`, `me` hosting; answers the connect's lines.
fn seated(driver: &mut Driver, room: &Shared) -> Vec<Value> {
    let none = send(driver, json!({ "cmdId": 1, "cmd": "connect", "endpoint": "ws://127.0.0.1:2567", "gameId": "bench", "name": "alice", "token": "t0" }));
    assert_eq!(none, Vec::<Value>::new(), "connect answers once seated");
    turn(driver);
    {
        let mut room = room.borrow_mut();
        room.session_id = "me".into();
        room.host = Some("me".into());
        room.players = vec![player("bob", "bob", json!({})), player("me", "alice", json!({}))];
        room.events.push(Event::Joined { session_id: "me".into() });
    }
    turn(driver)
}

#[test]
fn connect_answers_once_seated_and_the_snapshot_reads_the_facade_frame() {
    let (mut driver, room) = rig();
    let lines = seated(&mut driver, &room);
    assert_eq!(lines, vec![json!({ "type": "joined", "sid": "me" }), json!({ "type": "reply", "cmdId": 1, "ok": true, "result": { "sid": "me" } })]);
    let join = room.borrow().joins[0].clone();
    assert_eq!((join.endpoint.as_str(), join.game_id.as_str(), join.name.as_deref(), join.token.as_str()), ("ws://127.0.0.1:2567", "bench", Some("alice"), "t0"));
    let snapshot = &send(&mut driver, json!({ "cmdId": 2, "cmd": "snapshot" }))[0]["result"];
    assert_eq!(snapshot["me"], "me");
    assert_eq!(snapshot["status"], "connected");
    assert_eq!(snapshot["host"], "me");
    assert_eq!(snapshot["isHost"], true);
    assert_eq!(snapshot["players"].as_array().map(Vec::len), Some(2));
    // The facade shows no uid or team: the answer says null rather than reaching around it.
    assert_eq!(snapshot["players"][0], json!({ "sid": "bob", "uid": null, "name": "bob", "team": null, "connected": true, "data": {} }));
    let again = send(&mut driver, json!({ "cmdId": 3, "cmd": "connect", "endpoint": "ws://x", "gameId": "bench" }));
    assert_eq!(again[0]["error"], "already connected");
}

#[test]
fn a_state_write_leaves_at_the_next_publish_tick_with_its_values() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    let lines = send(&mut driver, json!({ "cmdId": 2, "cmd": "setState", "data": { "x": 1.5, "hp": 3, "inv": [1, 2] } }));
    assert_eq!(lines, vec![json!({ "type": "reply", "cmdId": 2, "ok": true, "result": null })]);
    for _ in 0..2 {
        turn(&mut driver);
    }
    assert_eq!(room.borrow().published, vec![json!({ "x": 1.5, "hp": 3, "inv": [1, 2] })], "the bench's values leave as given");
}

#[test]
fn a_control_request_answers_with_the_relay_result_as_an_event_and_the_reply() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    assert_eq!(send(&mut driver, json!({ "cmdId": 2, "cmd": "claim", "id": "ball" })), Vec::<Value>::new());
    turn(&mut driver);
    assert_eq!(room.borrow().requests, vec![("claim".to_owned(), "ball".to_owned())]);
    {
        let mut room = room.borrow_mut();
        room.objects = vec![object("ball", Some("me"), json!({}))];
        let result = ControlResult {
            request_id: "rq1".into(),
            operation: "claim".into(),
            id: "ball".into(),
            accepted: true,
            owner: Some("me".into()),
            sequence: 1.0,
            reason: "accepted".into(),
            retry_after_ms: None,
        };
        room.events.push(Event::ControlResult(result));
    }
    let lines = turn(&mut driver);
    let result = json!({ "requestId": "t1", "operation": "claim", "id": "ball", "accepted": true, "owner": "me", "sequence": null, "reason": "accepted" });
    assert_eq!(lines, vec![json!({ "type": "event", "name": "objectResult", "payload": result }), json!({ "type": "reply", "cmdId": 2, "ok": true, "result": result })]);
}

#[test]
fn a_held_claim_reports_the_relay_delay_rounded_up_to_whole_ticks() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    room.borrow_mut().objects = vec![object("ball", Some("bob"), json!({ "x": 7 }))];
    turn(&mut driver);
    send(&mut driver, json!({ "cmdId": 2, "cmd": "claim", "id": "ball" }));
    turn(&mut driver);
    let held = ControlResult {
        request_id: "rq1".into(),
        operation: "claim".into(),
        id: "ball".into(),
        accepted: false,
        owner: Some("bob".into()),
        sequence: 1.0,
        reason: "held".into(),
        retry_after_ms: Some(120.0),
    };
    room.borrow_mut().events.push(Event::ControlResult(held));
    let lines = turn(&mut driver);
    let reply = &lines[1];
    assert_eq!((reply["result"]["accepted"].clone(), reply["result"]["reason"].clone(), reply["result"]["owner"].clone()), (json!(false), json!("held"), json!("bob")));
    // 120 ms is 7.2 ticks: the facade's retry tick is 8 ticks on, 133.3 ms.
    let ms = reply["result"]["retryAfterMs"].as_f64().expect("retryAfterMs");
    assert!((ms - 8.0 * genex::FIXED_STEP_MS).abs() < 1e-9, "retryAfterMs {ms}");
}

#[test]
fn requests_the_facade_refuses_before_they_leave_answer_as_the_relay_would() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    room.borrow_mut().objects = vec![object("puck", Some("bob"), json!({}))];
    room.borrow_mut().host = Some("bob".into());
    turn(&mut driver);
    let missing = send(&mut driver, json!({ "cmdId": 2, "cmd": "release", "id": "ball" }));
    assert_eq!(missing[0]["result"]["reason"], "missing");
    assert_eq!(missing[0]["result"]["owner"], Value::Null);
    let not_owner = send(&mut driver, json!({ "cmdId": 3, "cmd": "destroy", "id": "puck" }));
    assert_eq!((not_owner[0]["result"]["reason"].clone(), not_owner[0]["result"]["operation"].clone(), not_owner[0]["result"]["owner"].clone()), (json!("not-owner"), json!("remove"), json!("bob")));
    let not_host = send(&mut driver, json!({ "cmdId": 4, "cmd": "claim", "id": "puck", "authority": "host" }));
    assert_eq!(not_host[0]["result"]["reason"], "not-host");
    assert_eq!(not_host[0]["result"]["accepted"], false);
    // A guest's shared write is the facade's host-only rule, not a relay refusal.
    let shared = send(&mut driver, json!({ "cmdId": 5, "cmd": "setShared", "key": "round", "value": 3 }));
    assert_eq!(shared[0]["error"], "net-not-host");
    // A non-owner's publish and a reserved send are dropped client-side and still answer ok.
    for (cmd_id, command) in [(6, json!({ "cmd": "setObject", "id": "puck", "d": { "x": 1 } })), (7, json!({ "cmd": "send", "type": "__evil", "data": 1 }))] {
        let mut command = command;
        command["cmdId"] = json!(cmd_id);
        assert_eq!(send(&mut driver, command)[0]["ok"], true);
    }
    turn(&mut driver);
    assert_eq!(room.borrow().requests, Vec::<(String, String)>::new(), "nothing left for the relay");
}

#[test]
fn game_events_reach_the_bench_only_for_listened_types() {
    let (mut driver, room) = rig();
    send(&mut driver, json!({ "cmdId": 9, "cmd": "listen", "type": "hit" }));
    seated(&mut driver, &room);
    {
        let mut room = room.borrow_mut();
        room.events.push(Event::Message { kind: "hit".into(), data: json!({ "dmg": 3 }) });
        room.events.push(Event::Message { kind: "miss".into(), data: json!({}) });
        room.events.push(Event::Chat(ChatMessage { id: 4.0, from: "bob".into(), name: "bob".into(), text: "hi".into(), at: 1.0 }));
    }
    let lines = turn(&mut driver);
    assert_eq!(
        lines,
        vec![
            json!({ "type": "event", "name": "message", "payload": { "type": "hit", "data": { "dmg": 3 } } }),
            json!({ "type": "event", "name": "chat", "payload": { "id": null, "from": "bob", "name": "bob", "text": "hi", "at": null } }),
        ]
    );
}

#[test]
fn host_changes_reconnects_and_a_terminal_close_answer_as_events() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    room.borrow_mut().host = Some("bob".into());
    room.borrow_mut().events.push(Event::HostChanged { host: Some("bob".into()) });
    assert_eq!(turn(&mut driver), vec![json!({ "type": "event", "name": "hostChanged", "payload": { "host": "bob" } })]);
    room.borrow_mut().host = Some("me".into());
    room.borrow_mut().events.push(Event::Reconnecting { code: 1006 });
    assert_eq!(turn(&mut driver), vec![json!({ "type": "event", "name": "reconnecting", "payload": { "attempt": 1, "code": null } })]);
    let snapshot = &send(&mut driver, json!({ "cmdId": 2, "cmd": "snapshot" }))[0]["result"];
    assert_eq!((snapshot["status"].clone(), snapshot["isHost"].clone()), (json!("reconnecting"), json!(false)), "isHost is false while reconnecting");
    room.borrow_mut().events.push(Event::Reconnected);
    assert_eq!(turn(&mut driver), vec![json!({ "type": "event", "name": "reconnected", "payload": {} })]);
    room.borrow_mut().events.push(Event::Disconnected { code: 4409, reason: "superseded".into() });
    assert_eq!(turn(&mut driver), vec![json!({ "type": "event", "name": "disconnect", "payload": { "code": 4409 } })]);
    let snapshot = &send(&mut driver, json!({ "cmdId": 3, "cmd": "snapshot" }))[0]["result"];
    assert_eq!(snapshot["status"], "closed");
    assert_eq!(send(&mut driver, json!({ "cmdId": 4, "cmd": "setState", "data": {} }))[0]["error"], "not connected");
}

#[test]
fn a_deliberate_leave_reaches_the_session_and_emits_no_disconnect() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    assert_eq!(send(&mut driver, json!({ "cmdId": 2, "cmd": "leave" }))[0]["result"], Value::Null);
    turn(&mut driver);
    assert_eq!(room.borrow().left, 1);
    room.borrow_mut().events.push(Event::Disconnected { code: 4000, reason: "consented".into() });
    assert_eq!(turn(&mut driver), Vec::<Value>::new());
    assert_eq!(send(&mut driver, json!({ "cmdId": 3, "cmd": "snapshot" }))[0]["result"]["status"], "closed");
}

#[test]
fn a_join_the_relay_refuses_fails_the_connect() {
    let (mut driver, room) = rig();
    send(&mut driver, json!({ "cmdId": 1, "cmd": "connect", "endpoint": "ws://127.0.0.1:2567", "gameId": "bench" }));
    turn(&mut driver);
    room.borrow_mut().events.push(Event::JoinFailed { code: 426, message: "unsupported protocol".into() });
    let lines = turn(&mut driver);
    assert_eq!(lines.len(), 1, "one reply, no disconnect event: {lines:?}");
    assert_eq!((lines[0]["cmdId"].clone(), lines[0]["ok"].clone()), (json!(1), json!(false)));
}

/// Characterization (MP-6b finding): PROTOCOL.md §7.2's `missing`, `invalid` and `capacity` have no
/// `NetControl` value (it has `unknown-object`, which the relay never sends), so the facade reads
/// them as `offline`. The row flips, named, when genex-net's vocabulary gains them.
#[test]
fn a_relay_reason_the_facade_has_no_value_for_answers_offline() {
    let (mut driver, room) = rig();
    seated(&mut driver, &room);
    room.borrow_mut().objects = vec![object("ball", Some("me"), json!({}))];
    turn(&mut driver);
    send(&mut driver, json!({ "cmdId": 2, "cmd": "destroy", "id": "ball" }));
    turn(&mut driver);
    let missing = ControlResult {
        request_id: "rq1".into(),
        operation: "remove".into(),
        id: "ball".into(),
        accepted: false,
        owner: None,
        sequence: 0.0,
        reason: "missing".into(),
        retry_after_ms: None,
    };
    room.borrow_mut().objects.clear();
    room.borrow_mut().events.push(Event::ControlResult(missing));
    let lines = turn(&mut driver);
    assert_eq!(lines[1]["result"]["reason"], "offline", "the relay said missing: {lines:?}");
}
