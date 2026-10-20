//! The Loopback backend and NetScript (MP-2b, new behaviour): a connect seats me as host on the next
//! tick, writes echo as the relay would (a send never does, chat does), claims answer under the
//! claim policy with their ticket, scripted remotes arrive after their latency and are smoothed, a
//! snap reseeds with no glide, make_host moves the host, and a reseed forgets everything.

use genex_net::backend::NetBackend;
use genex_net::frame::{NetEvent, NetFrame};
use genex_net::ids::PlayerId;
use genex_net::journal::NetJournal;
use genex_net::loopback::{LOOPBACK_ME_ID, LOOPBACK_ME_NAME, LoopbackBackend};
use genex_net::net::{Net, NetConfig};
use genex_net::script::{NetClaimPolicy, NetScript};
use genex_net::vocab::{NET_JOURNAL_BYTES_DESKTOP, NetClose, NetControl, NetMode, NetStatus};
use serde_json::{Value, json};

/// A seat over a Loopback room, stepped one tick at a time the way the runtime will.
struct Rig {
    backend: LoopbackBackend,
    net: Net,
    tick: u64,
    journal: NetJournal,
}

impl Rig {
    fn new() -> Rig {
        let config = NetConfig::new();
        Rig { backend: LoopbackBackend::new(&config), net: Net::fresh(NetMode::Loopback, &config), tick: 0, journal: NetJournal::new(NET_JOURNAL_BYTES_DESKTOP) }
    }

    /// Cut this tick's frame, run `hook` against it, apply its writes; returns the frame.
    fn step(&mut self, hook: impl FnOnce(&mut Net)) -> NetFrame {
        let frame = self.backend.cut(self.tick);
        self.journal.append(&frame);
        self.net.begin(frame.clone());
        hook(&mut self.net);
        let writes = self.net.end();
        self.backend.apply(self.tick, writes);
        self.tick += 1;
        frame
    }

    fn idle(&mut self) -> NetFrame {
        self.step(|_| {})
    }

    fn script(&mut self) -> NetScript<'_> {
        NetScript::loopback(&mut self.backend)
    }

    /// Connect and step until joined.
    fn joined() -> Rig {
        let mut rig = Rig::new();
        rig.step(Net::connect);
        let frame = rig.idle();
        assert_eq!(frame.status(), NetStatus::Joined);
        rig
    }

    /// A seed: the room and the seat start over at tick 0.
    fn reseed(&mut self) {
        self.backend.reset();
        self.net.reseed(NetMode::Loopback);
        self.tick = 0;
        self.journal.clear();
    }
}

fn me() -> PlayerId {
    PlayerId::new(LOOPBACK_ME_ID)
}

fn x_of(value: &Value) -> f64 {
    value["x"].as_f64().expect("a number x")
}

#[test]
fn connect_gives_joined_on_the_next_tick_with_me_as_host() {
    let mut rig = Rig::new();
    let first = rig.step(Net::connect);
    assert_eq!(first.status(), NetStatus::Offline, "the connect tick still reads offline");
    assert_eq!(first.mode(), NetMode::Loopback);
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Joined);
    assert_eq!(frame.me(), Some(&me()));
    assert_eq!(frame.host(), Some(&me()));
    assert!(frame.is_host());
    assert!(frame.room_open());
    assert_eq!(frame.player(&me()).map(|p| p.name()), Some(LOOPBACK_ME_NAME));
    assert_eq!(frame.events(), &[NetEvent::Joined { player: me() }, NetEvent::Host { player: Some(me()) }]);
    assert!(frame.server_ms().is_some(), "Loopback samples sim time as the relay clock");
}

#[test]
fn send_never_echoes_and_chat_echoes() {
    let mut rig = Rig::joined();
    rig.step(|net| {
        net.send("boom", json!({"at": 3})).expect("a game message");
        net.chat("hi").expect("a chat line");
    });
    let frame = rig.idle();
    assert_eq!(frame.events(), &[NetEvent::Chat { from: me(), name: LOOPBACK_ME_NAME.into(), text: "hi".into() }]);
}

#[test]
fn my_state_echoes_on_the_publish_tick_after() {
    let mut rig = Rig::joined();
    // Tick 2 is not a publish tick at 15 Hz (every 4 ticks): the state waits for tick 4.
    rig.step(|net| net.set_me(json!({"x": 1.23456})).expect("a state"));
    for _ in 0..2 {
        let frame = rig.idle();
        assert_eq!(*frame.player(&me()).expect("me").state_raw(), Value::Null);
    }
    let frame = rig.idle();
    let mine = frame.player(&me()).expect("me");
    assert_eq!(*mine.state_raw(), json!({"x": 1.235}), "published at 3 decimals on tick 4, read on tick 5");
    assert_eq!(mine.state(), mine.state_raw(), "my own state is live, never smoothed");
}

#[test]
fn claim_answers_accepted_with_its_ticket_on_the_next_tick() {
    let mut rig = Rig::joined();
    let mut ticket = None;
    let claimed_on = rig.tick;
    rig.step(|net| ticket = Some(net.claim("ball").expect("a claim")));
    let frame = rig.idle();
    assert_eq!(frame.tick(), claimed_on + 1);
    let ticket = ticket.expect("a ticket");
    assert!(frame.events().contains(&NetEvent::Control { ticket, result: NetControl::Accepted, retry_at_tick: None }));
    assert!(frame.events().contains(&NetEvent::Owner { object: "ball".into(), owner: Some(me()) }));
    assert!(frame.object("ball").expect("the ball").mine());

    let mut again = None;
    rig.step(|net| again = Some(net.claim("ball").expect("a claim")));
    let frame = rig.idle();
    assert!(frame.events().contains(&NetEvent::Control { ticket: again.expect("a ticket"), result: NetControl::AlreadyOwner, retry_at_tick: None }));
}

#[test]
fn a_held_claim_answers_held_with_retry_at_the_claim_tick_plus_the_hold() {
    let mut rig = Rig::joined();
    rig.script().answer_claims(NetClaimPolicy::Held { ticks: 30 });
    let claimed_on = rig.tick;
    let mut ticket = None;
    rig.step(|net| ticket = Some(net.claim("ball").expect("a claim")));
    let frame = rig.idle();
    let held = NetEvent::Control { ticket: ticket.expect("a ticket"), result: NetControl::Held, retry_at_tick: Some(claimed_on + 30) };
    assert_eq!(frame.events(), &[held]);
    assert!(frame.object("ball").is_none(), "a held claim takes nothing");

    rig.script().answer_claims(NetClaimPolicy::NotHost);
    let mut refused = None;
    rig.step(|net| refused = Some(net.claim("ball").expect("a claim")));
    let frame = rig.idle();
    assert_eq!(frame.events(), &[NetEvent::Control { ticket: refused.expect("a ticket"), result: NetControl::NotHost, retry_at_tick: None }]);
}

#[test]
fn a_scripted_remote_at_latency_3_appears_on_tick_plus_3_smoothed() {
    let mut rig = Rig::joined();
    let start = rig.tick;
    let mut script = rig.script();
    script.latency_ticks(3);
    let ana = script.join("Ana");
    script.set_state(&ana, json!({"x": 0.0, "mode": "walk"}));
    assert_eq!(ana.as_str(), "remote-1");
    for _ in 0..3 {
        let frame = rig.idle();
        assert!(frame.player(&ana).is_none(), "tick {} is before the latency", frame.tick());
    }
    let frame = rig.idle();
    assert_eq!(frame.tick(), start + 3);
    assert!(frame.events().contains(&NetEvent::Joined { player: ana.clone() }));
    let seen = frame.player(&ana).expect("Ana arrived");
    assert_eq!(*seen.state_raw(), json!({"x": 0.0, "mode": "walk"}));
    assert_eq!(seen.state(), seen.state_raw(), "one sample is placed as it is");
    assert_eq!(frame.remotes().count(), 1);

    // Ana walks +1 per publish at 15 Hz: the drawn state trails the latest one, and glides.
    let mut glided = Vec::new();
    for step in 1..=12 {
        rig.script().set_state(&ana, json!({"x": f64::from(step), "mode": "walk"}));
        for _ in 0..4 {
            let frame = rig.idle();
            let ana_now = frame.player(&ana).expect("Ana");
            glided.push((x_of(ana_now.state()), x_of(ana_now.state_raw())));
        }
    }
    let (shown, latest) = *glided.last().expect("samples");
    assert!(shown < latest, "drawn {shown} trails latest {latest}");
    assert!(shown > latest - 4.0, "drawn {shown} keeps up within the render delay of {latest}");
    assert!(glided.windows(2).all(|w| w[1].0 >= w[0].0), "the glide never steps back");
    let distinct = glided.iter().map(|(s, _)| s.to_bits()).collect::<std::collections::BTreeSet<_>>().len();
    assert!(distinct > 24, "the drawn state moves between publishes ({distinct} distinct values)");
}

#[test]
fn snap_state_reseeds_with_no_glide() {
    let mut rig = Rig::joined();
    let ana = rig.script().join("Ana");
    for step in 0..10 {
        rig.script().set_state(&ana, json!({"x": f64::from(step)}));
        for _ in 0..4 {
            rig.idle();
        }
    }
    rig.script().snap_state(&ana, json!({"x": 100.0}));
    let frame = rig.idle();
    let seen = frame.player(&ana).expect("Ana");
    assert_eq!(*seen.state_raw(), json!({"x": 100.0}));
    assert_eq!(seen.state(), seen.state_raw(), "a snap is placed, not glided to");
    let frame = rig.idle();
    assert_eq!(x_of(frame.player(&ana).expect("Ana").state()), 100.0);
}

#[test]
fn make_host_of_a_remote_flips_is_host_and_emits_host() {
    let mut rig = Rig::joined();
    let ana = rig.script().join("Ana");
    rig.idle();
    rig.script().make_host(Some(&ana));
    let frame = rig.idle();
    assert_eq!(frame.host(), Some(&ana));
    assert!(!frame.is_host());
    assert_eq!(frame.events(), &[NetEvent::Host { player: Some(ana.clone()) }]);
    rig.step(|net| assert!(net.set_room_open(false).is_err(), "only the host opens the room"));

    rig.script().make_host(None);
    let frame = rig.idle();
    assert!(frame.is_host());
    assert_eq!(frame.events(), &[NetEvent::Host { player: Some(me()) }]);
}

#[test]
fn host_inputs_reach_only_the_host() {
    let mut rig = Rig::joined();
    let ana = rig.script().join("Ana");
    rig.idle();
    rig.script().send_to_host(&ana, json!({"jump": true}));
    rig.script().send(&ana, "wave", json!({}));
    let frame = rig.idle();
    assert_eq!(
        frame.events(),
        &[NetEvent::HostInput { from: ana.clone(), payload: json!({"jump": true}) }, NetEvent::Message { from: ana.clone(), kind: "wave".into(), payload: json!({}) }]
    );
    rig.script().make_host(Some(&ana));
    rig.idle();
    rig.script().send_to_host(&ana, json!({"jump": true}));
    assert!(rig.idle().events().is_empty(), "not the host: the input goes elsewhere");
}

#[test]
fn a_remote_leaving_hands_the_host_and_its_objects_back() {
    let mut rig = Rig::joined();
    let ana = rig.script().join("Ana");
    rig.script().set_object("crate", &ana, json!({"x": 1.0}));
    rig.script().make_host(Some(&ana));
    let frame = rig.idle();
    assert_eq!(frame.object("crate").and_then(|o| o.owner()), Some(&ana));
    rig.script().leave(&ana);
    let frame = rig.idle();
    assert!(frame.player(&ana).is_none());
    assert_eq!(frame.object("crate").map(|o| o.owner()), Some(None));
    assert!(frame.is_host());
    assert!(frame.events().contains(&NetEvent::Left { player: ana.clone() }));
    assert!(frame.events().contains(&NetEvent::Host { player: Some(me()) }));
}

#[test]
fn reconnect_and_close_move_the_status() {
    let mut rig = Rig::joined();
    rig.script().reconnect_for(5);
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Reconnecting);
    assert_eq!(frame.events(), &[NetEvent::Reconnecting { attempt: 1 }]);
    rig.step(|net| assert!(net.set_me(json!({})).is_err(), "no writes while reconnecting"));
    for _ in 0..3 {
        assert_eq!(rig.idle().status(), NetStatus::Reconnecting);
    }
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Joined);
    assert_eq!(frame.events(), &[NetEvent::Reconnected]);

    rig.script().close(NetClose::Replaced);
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Closed);
    assert_eq!(frame.me(), None);
    assert_eq!(frame.players().count(), 0);
    assert_eq!(frame.events(), &[NetEvent::Closed { reason: NetClose::Replaced }]);
}

#[test]
fn leave_closes_as_left_and_a_new_connect_seats_again() {
    let mut rig = Rig::joined();
    rig.step(Net::leave);
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Closed);
    assert_eq!(frame.events(), &[NetEvent::Closed { reason: NetClose::Left }]);
    rig.step(Net::create_private);
    let frame = rig.idle();
    assert_eq!(frame.status(), NetStatus::Joined);
    assert!(frame.lobby_code().is_some());
}

#[test]
fn script_calls_outside_loopback_are_counted_and_do_nothing() {
    let mut ignored = 0;
    let mut script = NetScript::ignored(&mut ignored);
    assert!(!script.is_live());
    let id = script.join("Ana");
    script.set_state(&id, json!({}));
    script.make_host(None);
    assert_eq!(id.as_str(), "");
    assert_eq!(ignored, 3);
}

/// A scripted session touching every delivery kind; returns its journal.
fn scripted_session(rig: &mut Rig, variant: u32) -> Vec<u8> {
    rig.step(Net::connect);
    let mut script = rig.script();
    script.latency_ticks(variant);
    let ana = script.join("Ana");
    let bo = script.join("Bo");
    for tick in 0..90u32 {
        if tick % 4 == 0 {
            let x = f64::from(tick) * 0.25 * f64::from(variant);
            let mut script = rig.script();
            script.set_state(&ana, json!({"x": x, "q": [0.0, 0.0, 0.0, 1.0]}));
            script.set_object("ball", &bo, json!({"x": -x}));
        }
        if tick == 40 {
            rig.script().chat(&bo, "gg");
        }
        rig.step(|net| {
            if net.status() == NetStatus::Joined && tick % 7 == 0 {
                net.set_me(json!({"t": tick})).expect("a state");
            }
        });
    }
    rig.journal.to_json()
}

#[test]
fn seed_2_then_seed_1_equals_a_fresh_seed_1() {
    let mut fresh = Rig::new();
    let expected = scripted_session(&mut fresh, 1);

    let mut reused = Rig::new();
    let other = scripted_session(&mut reused, 2);
    assert_ne!(other, expected, "the two seeds script different sessions");
    reused.reseed();
    assert_eq!(scripted_session(&mut reused, 1), expected, "a reseed leaves nothing behind");
}
