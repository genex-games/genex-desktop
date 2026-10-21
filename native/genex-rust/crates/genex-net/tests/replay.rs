//! The Replay backend, the frame digest and the crash-report journal (multiplayer MP-3b, new
//! behaviour), and with `--features relay` the web relay's mapping: a recorded `drainEventsJson`
//! batch maps like the native fixture, a drain at the bridge queue's 4096 cap reaches later ticks in
//! order behind `events-deferred`, and a join in flight holds the seat as connecting.
//!
//! `cargo test -p genex-net --test replay` (add `--features relay` for the web relay rows).

use std::sync::Arc;

use genex_net::backend::NetBackend;
use genex_net::frame::{NetChange, NetEvent, NetFrame, NetRoom};
use genex_net::ids::PlayerId;
use genex_net::journal::NetJournal;
use genex_net::net::{Net, NetConfig};
use genex_net::replay::{NET_CRASH_JOURNAL_TICKS, REDACTED, ReplayBackend, crash_journal, frame_digest};
use genex_net::vocab::{NET_JOURNAL_BYTES_DESKTOP, NetMode, NetOffline, NetStatus, NetWarning};
use serde_json::{Value, json};

fn id(text: &str) -> PlayerId {
    PlayerId::new(text)
}

/// A journal of `ticks` ticks of a seated room: Ana joins at 0, states every tick, chat every 10th.
fn session(ticks: u64) -> (NetJournal, Vec<NetFrame>) {
    let mut room = NetRoom::new(None);
    let mut journal = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    let mut frames = Vec::new();
    for tick in 0..ticks {
        if tick == 0 {
            room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
            room.apply(NetChange::Me(Some(id("s1"))));
            room.apply(NetChange::Join { id: id("s2"), name: "Ana Lima".into(), avatar_url: "https://cdn.example/u/ana.png".into() });
            room.push_event(NetEvent::Joined { player: id("s2") });
        }
        if tick % 3 == 0 {
            room.apply(NetChange::PlayerState { id: id("s2"), raw: json!({"x": tick}), smoothed: None, pose_raw: None, pose: None });
        }
        if tick % 10 == 5 {
            room.push_event(NetEvent::Chat { from: id("s2"), name: "Ana Lima".into(), text: format!("meet me at {tick}") });
            room.push_event(NetEvent::Message { from: id("s2"), kind: "boom".into(), payload: json!({"at": tick}) });
        }
        let frame = room.cut(tick, NetMode::Relay);
        journal.append(&frame);
        frames.push(frame);
    }
    (journal, frames)
}

#[test]
fn a_replay_cuts_the_recorded_frames_in_the_recorded_mode_and_sends_nothing() {
    let (journal, frames) = session(40);
    let mut replay = ReplayBackend::new(&journal, NetMode::Relay).expect("a whole journal");
    assert_eq!(replay.mode(), NetMode::Replay, "__net names the backend");
    let mut net = Net::fresh(NetMode::Relay, &NetConfig::new());
    for (tick, recorded) in frames.iter().enumerate() {
        replay.pump();
        let frame = replay.cut(tick as u64);
        assert_eq!(frame.mode(), NetMode::Relay, "the game reads the mode it ran in");
        assert_eq!(frame_digest(&frame), frame_digest(recorded), "tick {tick}");
        net.begin(frame);
        net.set_me(json!({"t": tick})).expect("joined");
        replay.apply(tick as u64, net.end());
    }
    assert_eq!((replay.remaining(), replay.late_ticks()), (0, 0));
    assert!(replay.writes() > 0, "the writes were counted, and a replay has nowhere to send them");
}

#[test]
fn a_journal_whose_cap_dropped_ticks_refuses_and_a_skipped_tick_is_counted_late() {
    let (journal, _) = session(40);
    let mut small = NetJournal::new(400);
    for tick in journal.ticks() {
        let mut room = NetRoom::new(None);
        tick.changes.into_iter().for_each(|change| room.apply(change));
        tick.events.into_iter().for_each(|event| room.push_event(event));
        small.append(&room.cut(tick.tick, NetMode::Relay));
    }
    let refused = ReplayBackend::new(&small, NetMode::Relay).expect_err("its start is gone");
    assert_eq!(refused.trimmed_ticks(), small.trimmed_ticks());
    assert!(refused.trimmed_ticks() > 0);

    let mut replay = ReplayBackend::new(&journal, NetMode::Relay).expect("a whole journal");
    let frame = replay.cut(7);
    assert_eq!(replay.late_ticks(), 4, "ticks 0, 3, 5 and 6 were journaled before the first cut, at 7");
    assert_eq!(frame.player(&id("s2")).map(|p| p.state_raw().clone()), Some(json!({"x": 6})));
}

#[test]
fn a_reason_that_never_changed_is_given_to_the_replay() {
    let journal = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    let mut plain = ReplayBackend::new(&journal, NetMode::Relay).expect("empty is whole");
    assert_eq!(plain.cut(0).offline_reason(), None);
    let mut told = ReplayBackend::new(&journal, NetMode::Relay).expect("empty is whole").starting_offline(Some(NetOffline::NoSlug));
    let frame = told.cut(0);
    assert_eq!((frame.status(), frame.offline_reason()), (NetStatus::Offline, Some(NetOffline::NoSlug)));
}

#[test]
fn the_digest_changes_with_anything_a_frame_shows() {
    let base = || {
        let mut room = NetRoom::new(None);
        room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
        room.apply(NetChange::Join { id: id("s2"), name: "Bo".into(), avatar_url: String::new() });
        room
    };
    let reference = frame_digest(&base().cut(5, NetMode::Relay));
    assert_eq!(frame_digest(&base().cut(5, NetMode::Relay)), reference, "equal frames, equal digests");
    let variants: [(&str, Change); 5] = [
        ("a state", Box::new(|room| room.apply(NetChange::PlayerState { id: id("s2"), raw: json!(1), smoothed: None, pose_raw: None, pose: None }))),
        ("a shared key", Box::new(|room| room.apply(NetChange::Shared { key: "k".into(), value: Some(json!(true)) }))),
        ("an event", Box::new(|room| room.push_event(NetEvent::Warning { code: NetWarning::RateLimited }))),
        ("an object", Box::new(|room| room.apply(NetChange::Object { id: Arc::from("o"), owner: None, epoch: 0, raw: json!({}), smoothed: None, pose: None }))),
        ("the clock", Box::new(|room| room.apply(NetChange::ServerMs(Some(1.5))))),
    ];
    for (what, change) in variants {
        let mut room = base();
        change(&mut room);
        assert_ne!(frame_digest(&room.cut(5, NetMode::Relay)), reference, "{what}");
    }
    assert_ne!(frame_digest(&base().cut(6, NetMode::Relay)), reference, "the tick");
    assert_ne!(frame_digest(&base().cut(5, NetMode::Loopback)), reference, "the mode");
}

/// One change to a room, named for the row that makes it.
type Change = Box<dyn Fn(&mut NetRoom)>;

/// Every string a crash journal holds, gathered from its JSON.
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(members) => members.values().for_each(|member| strings(member, out)),
        _ => {}
    }
}

#[test]
fn the_crash_journal_keeps_the_last_120_ticks_and_redacts_names_avatars_and_chat() {
    let (journal, _) = session(600);
    assert!(journal.len() > NET_CRASH_JOURNAL_TICKS, "the journal holds more than a report keeps");
    let text = crash_journal(&journal, NET_CRASH_JOURNAL_TICKS);
    let back = NetJournal::from_json(&text).expect("a crash journal is a journal");
    assert_eq!(back.len(), NET_CRASH_JOURNAL_TICKS);
    let skipped = journal.len() - NET_CRASH_JOURNAL_TICKS;
    let first = journal.ticks().nth(skipped).map(|t| t.tick).expect("a tick");
    assert_eq!(back.span(), journal.span().map(|(_, last)| (first, last)), "the newest ticks");
    let head: Value = serde_json::from_slice(&text).expect("JSON");
    assert_eq!(head["trimmedTicks"], json!(skipped), "every tick left out is counted");

    let mut seen = Vec::new();
    strings(&head, &mut seen);
    for secret in ["Ana Lima", "cdn.example", "meet me at"] {
        assert!(!seen.iter().any(|text| text.contains(secret)), "{secret:?} leaked into the crash journal");
    }
    let count = |journal: &NetJournal, skip: usize, chat: bool| -> usize {
        let kind = |e: &NetEvent| if chat { matches!(e, NetEvent::Chat { .. }) } else { matches!(e, NetEvent::Message { .. }) };
        journal.ticks().skip(skip).flat_map(|t| t.events).filter(kind).count()
    };
    let chats: Vec<NetEvent> = back.ticks().flat_map(|t| t.events).filter(|e| matches!(e, NetEvent::Chat { .. })).collect();
    assert_eq!(chats.len(), count(&journal, skipped, true));
    assert!(!chats.is_empty());
    assert!(chats.iter().all(|chat| *chat == NetEvent::Chat { from: id("s2"), name: REDACTED.into(), text: REDACTED.into() }), "{chats:?}");
    assert_eq!(count(&back, 0, false), count(&journal, skipped, false), "seat ids and game messages stay: they explain the crash");

    let whole = crash_journal(&journal, usize::MAX);
    let whole = NetJournal::from_json(&whole).expect("a journal");
    let joins: Vec<NetChange> = whole.ticks().flat_map(|t| t.changes).filter(|c| matches!(c, NetChange::Join { .. })).collect();
    assert_eq!(joins, vec![NetChange::Join { id: id("s2"), name: REDACTED.into(), avatar_url: REDACTED.into() }]);
}

#[cfg(feature = "relay")]
mod web_relay {
    //! The web relay's rows: they need the `relay` feature's crate types.

    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::future::Future;
    use std::path::Path;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::{Context, Poll};

    use genex_multiplayer::{Error as SessionError, Event, JoinFailure, ObjectView, PlayerView, RoomTarget};
    use genex_net::backend::NetBackend;
    use genex_net::frame::NetEvent;
    use genex_net::ids::{NetTicket, PlayerId};
    use genex_net::net::{Net, NetConfig};
    use genex_net::relay::web::{BRIDGE_EVENT_QUEUE_MAX, DialedSession, drained_events};
    use genex_net::relay::{RelayBackend, RelayConnector, RelayMap, RelaySession};
    use genex_net::vocab::{NET_EVENTS_PER_TICK_MAX, NetClose, NetMode, NetStatus, NetWarning};
    use serde_json::{Value, json};

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).expect("a fixture")).expect("fixture JSON")
    }

    #[test]
    fn a_recorded_drain_batch_maps_like_the_native_fixture() {
        let native = fixture("events.json");
        let drain = fixture("drain.json");
        let batch = drained_events(drain["batch"].as_str().expect("the batch is one string"));
        assert_eq!(batch.unreadable as u64, drain["unreadable"].as_u64().expect("a count"), "the unknown kind is skipped");
        assert!(!batch.full);
        let rows = native["rows"].as_array().expect("rows");
        assert_eq!(batch.events.len(), rows.len());
        let cut_tick = native["cut_tick"].as_u64().expect("a cut tick");
        let mut map = RelayMap::default();
        for (request, ticket) in native["tickets"].as_object().expect("tickets") {
            map.expect(request.clone(), NetTicket::new(u32::try_from(ticket.as_u64().expect("a ticket")).expect("small")));
        }
        for (event, row) in batch.events.iter().zip(rows) {
            assert_eq!(format!("{:?}", map.map(event, cut_tick)), row["expect"].as_str().expect("an expectation"), "{}", row["event"]);
        }
        assert_eq!(map.in_flight(), 0);
        assert_eq!(drained_events("not a list"), Default::default(), "a broken batch reads as no events");
    }

    // ---- a scripted session ---------------------------------------------------------------------

    #[derive(Default)]
    struct Script {
        drains: Vec<Vec<Event>>,
        left: u32,
    }

    struct Bridge {
        script: Rc<RefCell<Script>>,
        players: Vec<PlayerView>,
    }

    impl RelaySession for Bridge {
        fn poll(&mut self) -> Vec<Event> {
            let mut script = self.script.borrow_mut();
            if script.drains.is_empty() { Vec::new() } else { script.drains.remove(0) }
        }
        fn players(&self) -> &[PlayerView] {
            &self.players
        }
        fn objects(&self) -> &[ObjectView] {
            &[]
        }
        fn shared(&self) -> BTreeMap<String, Value> {
            BTreeMap::new()
        }
        fn session_id(&self) -> &str {
            "s1"
        }
        fn host_id(&self) -> Option<&str> {
            Some("s1")
        }
        fn match_state(&self) -> Option<Value> {
            None
        }
        fn server_now(&self) -> Option<f64> {
            None
        }
        fn leave(&mut self) {
            self.script.borrow_mut().left += 1;
        }
        fn set_me(&mut self, _state: Value) -> Result<(), SessionError> {
            Ok(())
        }
        fn snap_me(&mut self, _state: Value) -> Result<(), SessionError> {
            Ok(())
        }
        fn set_object(&mut self, _id: &str, _state: Value) -> Result<(), SessionError> {
            Ok(())
        }
        fn snap_object(&mut self, _id: &str, _state: Value) -> Result<(), SessionError> {
            Ok(())
        }
        fn claim(&mut self, _id: &str) -> Result<String, SessionError> {
            Ok("rs1".into())
        }
        fn claim_as_host(&mut self, _id: &str) -> Result<String, SessionError> {
            Ok("rs1".into())
        }
        fn release(&mut self, _id: &str) -> Result<String, SessionError> {
            Ok("rs1".into())
        }
        fn destroy(&mut self, _id: &str) -> Result<String, SessionError> {
            Ok("rs1".into())
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

    /// The bridge's connect promise: pending until the test settles it.
    type Settle = Rc<RefCell<Option<Result<Bridge, JoinFailure>>>>;

    struct Promise(Settle);

    impl Future for Promise {
        type Output = Result<Bridge, JoinFailure>;

        fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
            self.0.borrow_mut().take().map_or(Poll::Pending, Poll::Ready)
        }
    }

    struct Connector {
        settle: Settle,
        opened: Rc<RefCell<Vec<RoomTarget>>>,
    }

    impl RelayConnector for Connector {
        type Session = DialedSession<Bridge>;

        fn slug(&self) -> Option<&str> {
            Some("tag-arena")
        }

        fn open(&mut self, _slug: &str, room: RoomTarget) -> Result<DialedSession<Bridge>, String> {
            self.opened.borrow_mut().push(room);
            Ok(DialedSession::dialing(Box::pin(Promise(self.settle.clone()))))
        }
    }

    struct Rig {
        backend: RelayBackend<Connector>,
        net: Net,
        tick: u64,
        settle: Settle,
        script: Rc<RefCell<Script>>,
    }

    impl Rig {
        fn new() -> Rig {
            let settle: Settle = Rc::new(RefCell::new(None));
            let connector = Connector { settle: settle.clone(), opened: Rc::new(RefCell::new(Vec::new())) };
            Rig { backend: RelayBackend::new(connector), net: Net::fresh(NetMode::Relay, &NetConfig::new()), tick: 0, settle, script: Rc::default() }
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

        fn seat(&mut self) {
            let bridge = Bridge { script: self.script.clone(), players: Vec::new() };
            *self.settle.borrow_mut() = Some(Ok(bridge));
        }
    }

    #[test]
    fn a_join_in_flight_holds_the_seat_connecting_until_the_promise_settles() {
        let mut rig = Rig::new();
        rig.step(Net::connect);
        for _ in 0..3 {
            let frame = rig.step(|_| {});
            assert_eq!(frame.status(), NetStatus::Connecting, "the promise has not settled");
            assert_eq!(frame.players().count(), 0);
        }
        rig.script.borrow_mut().drains.push(vec![Event::Joined { session_id: "s1".into() }]);
        rig.seat();
        rig.step(|_| {});
        let frame = rig.step(|_| {});
        assert_eq!((frame.status(), frame.me().map(PlayerId::as_str), frame.is_host()), (NetStatus::Joined, Some("s1"), true));
        assert!(rig.backend.session().is_some_and(|session| session.session().is_some()));
    }

    #[test]
    fn a_refused_join_closes_the_seat_and_a_leave_while_joining_leaves_once_seated() {
        let mut rig = Rig::new();
        rig.step(Net::connect);
        *rig.settle.borrow_mut() = Some(Err(JoinFailure { code: 426, message: "upgrade".into() }));
        let frame = rig.step(|_| {});
        assert_eq!(frame.status(), NetStatus::Closed);
        assert_eq!(frame.events(), &[NetEvent::Closed { reason: NetClose::Other }]);

        let mut rig = Rig::new();
        rig.step(Net::connect);
        rig.step(Net::leave);
        assert!(rig.backend.session().is_some_and(DialedSession::is_dialing));
        rig.seat();
        rig.step(|_| {});
        assert_eq!(rig.script.borrow().left, 1, "the seat the join found is left at once");
    }

    #[test]
    fn a_drain_at_the_bridge_cap_reaches_later_ticks_in_order_behind_events_deferred() {
        let mut rig = Rig::new();
        rig.step(Net::connect);
        rig.seat();
        rig.script.borrow_mut().drains.push(vec![Event::Joined { session_id: "s1".into() }]);
        rig.step(|_| {});
        rig.step(|_| {});
        let full: Vec<Event> = (0..BRIDGE_EVENT_QUEUE_MAX).map(|n| Event::Message { kind: "n".into(), data: json!(n) }).collect();
        rig.script.borrow_mut().drains.push(full);

        let mut arrived = Vec::new();
        let mut deferred_ticks = 0;
        for _ in 0..8 {
            let frame = rig.step(|_| {});
            assert!(frame.events().len() <= NET_EVENTS_PER_TICK_MAX);
            for event in frame.events() {
                match event {
                    NetEvent::Message { payload, .. } => arrived.push(payload.as_u64().expect("a number")),
                    NetEvent::Warning { code: NetWarning::EventsDeferred } => deferred_ticks += 1,
                    other => panic!("unexpected {other:?}"),
                }
            }
        }
        let expected: Vec<u64> = (0..BRIDGE_EVENT_QUEUE_MAX as u64).collect();
        assert_eq!(arrived, expected, "every event of the full drain arrived, in queue order");
        let per_tick = NET_EVENTS_PER_TICK_MAX - 1;
        assert_eq!(deferred_ticks, BRIDGE_EVENT_QUEUE_MAX.div_ceil(per_tick) - 1, "each tick that left some behind says so");
        assert_eq!(rig.backend.session().map(DialedSession::full_drains), Some(1), "the full drain is counted");
    }
}
