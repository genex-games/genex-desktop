//! Multiplayer through the facade (multiplayer MP-4a): `sim.net` reads the frame the runtime cut
//! before the update hooks, writes leave after the tick and come back in a later frame, every
//! shell frame pumps the backend (paused or not) and what it brought lands in the first tick it
//! runs, `game.net` registers once within its caps, `state().__net` is display only and the
//! checksum never sees the net. Loopback rooms are forced with `Runtime::set_net_mode`, as a
//! build with `net-loopback` would choose.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use genex::net::{Net, NetConfig, NetEvent, NetFrame, NetMode, NetStatus, PlayerId};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime, View};
use genex_net::backend::NetBackend;
use genex_net::frame::NetRoom;
use genex_net::writes::NetWrites;
use serde_json::json;

#[derive(Default)]
struct World {
    /// `sim.net.events().len()` on each tick.
    events: Vec<usize>,
    ticks: u64,
}

/// Connect on the first tick; once seated, snap my state to the tick that wrote it.
fn echo_game(drawn: Rc<RefCell<Vec<Option<u64>>>>) -> Game<World> {
    let mut game = Game::new(World::default()).title("Net");
    game.on_update(|sim, _| {
        sim.world.ticks += 1;
        sim.world.events.push(sim.net.events().len());
        if sim.net.status() == NetStatus::Offline {
            sim.net.connect();
        }
        if sim.net.status() == NetStatus::Joined {
            sim.net.snap_me(json!({ "tick": sim.world.ticks })).expect("seated");
        }
    });
    game.on_draw(move |sim, frame, _| {
        frame.cube(Transform::IDENTITY, Color::RED);
        let me = sim.net.me().and_then(|me| sim.net.player(me));
        drawn.borrow_mut().push(me.and_then(|me| me.state_raw()["tick"].as_u64()));
    });
    game
}

fn step_and_draw(rt: &mut Runtime<World>) {
    rt.step(FIXED_STEP_MS);
    rt.frame(View::Game).expect("the game's view");
}

/// New behaviour: in a loopback room a write `on_update` queues is read by `on_draw` on the next
/// tick (the room seats me the tick after `connect`, and my state echoes the tick after I snap it).
#[test]
fn in_loopback_a_write_from_on_update_is_read_by_on_draw_on_the_next_tick() {
    let drawn = Rc::new(RefCell::new(Vec::new()));
    let mut rt = Runtime::new(echo_game(Rc::clone(&drawn))).expect("installs");
    rt.set_net_mode(NetMode::Loopback);
    for _ in 0..6 {
        step_and_draw(&mut rt);
    }
    // Tick 1 connects, tick 2 is seated and snaps 2, tick 3 reads it back, and so on.
    assert_eq!(*drawn.borrow(), [None, None, Some(2), Some(3), Some(4), Some(5)]);
    assert_eq!(rt.sim().net.mode(), NetMode::Loopback);
    assert_eq!(rt.state()["__net"]["status"], json!("joined"));
    assert_eq!(rt.state()["__net"]["mode"], json!("loopback"));
}

/// The same game without networking stays offline (`net-disabled`), its writes refuse, and its
/// state has no `__net`.
#[test]
fn a_game_without_networking_is_offline_and_has_no_net_key() {
    let drawn = Rc::new(RefCell::new(Vec::new()));
    let mut rt = Runtime::new(echo_game(Rc::clone(&drawn))).expect("installs");
    assert_eq!(rt.net_mode(), NetMode::Off, "a build without net features");
    for _ in 0..3 {
        step_and_draw(&mut rt);
    }
    assert_eq!(*drawn.borrow(), [None, None, None]);
    assert_eq!(rt.sim().net.offline_reason(), Some(genex::net::NetOffline::Disabled));
    assert_eq!(rt.state().get("__net"), None, "a non-net game's state has no __net");
}

/// A stand-in backend: each pump brings one chat line, each cut takes everything pumped since.
struct Pumped {
    room: NetRoom,
    pumps: Rc<Cell<u64>>,
}

impl NetBackend for Pumped {
    fn pump(&mut self) {
        self.pumps.set(self.pumps.get() + 1);
        let from = PlayerId::new("remote-1");
        self.room.push_event(NetEvent::Chat { from, name: "Ada".to_owned(), text: format!("pump {}", self.pumps.get()) });
    }

    fn cut(&mut self, tick: u64) -> NetFrame {
        self.room.cut(tick, NetMode::Replay)
    }

    fn apply(&mut self, _tick: u64, _writes: NetWrites) {}

    fn mode(&self) -> NetMode {
        NetMode::Replay
    }
}

/// New behaviour: one `advance_live(50)` that runs three ticks pumps once and hands what the pump
/// brought to the first tick only; a paused runtime still pumps, consumes no frame and runs no
/// tick, and its pump's events land in the first tick after it resumes.
#[test]
fn a_live_frame_pumps_once_and_its_events_reach_the_first_tick_only() {
    let mut rt = Runtime::new(echo_game(Rc::new(RefCell::new(Vec::new())))).expect("installs");
    let pumps = Rc::new(Cell::new(0));
    rt.set_net_backend(Box::new(Pumped { room: NetRoom::new(None), pumps: Rc::clone(&pumps) }));
    rt.start();
    assert_eq!(rt.advance_live(50.0), 3, "50 ms runs three ticks");
    assert_eq!((pumps.get(), rt.net_pumps()), (1, 1), "pumped once for the frame");
    assert_eq!(rt.sim().world.events, [1, 0, 0], "the first tick takes the pump's events");
    rt.pause();
    let tick = rt.tick();
    assert_eq!(rt.advance_live(50.0), 0, "paused: no tick");
    assert_eq!((pumps.get(), rt.tick()), (2, tick), "paused: still pumped, no frame consumed");
    assert_eq!(rt.sim().world.events, [1, 0, 0]);
    rt.start();
    assert_eq!(rt.advance_live(50.0), 3);
    assert_eq!(rt.sim().world.events, [1, 0, 0, 2, 0, 0], "the paused pump's line and this frame's, on its first tick");
}

/// New behaviour: `game.net` registers once (`duplicate-net`) within its caps
/// (`net-config-invalid`: a publish rate of 0, more than 6 decimals, a delay of 0).
#[test]
fn game_net_registers_once_within_its_caps() {
    let refused = |configure: fn(&mut Game<World>)| {
        let mut game = Game::new(World::default());
        configure(&mut game);
        Runtime::new(game).err().map(|error| error.code())
    };
    assert_eq!(refused(|game| { game.net(NetConfig::new()); }), None);
    assert_eq!(refused(|game| { game.net(NetConfig::new()).net(NetConfig::new()); }), Some(InstallErrorCode::DuplicateNet));
    assert_eq!(refused(|game| { game.net(NetConfig::new().publish_hz(0)); }), Some(InstallErrorCode::NetConfigInvalid));
    assert_eq!(refused(|game| { game.net(NetConfig::new().publish_hz(31)); }), Some(InstallErrorCode::NetConfigInvalid));
    assert_eq!(refused(|game| { game.net(NetConfig::new().decimals(7)); }), Some(InstallErrorCode::NetConfigInvalid));
    assert_eq!(refused(|game| { game.net(NetConfig::new().interp_delay_ticks(0)); }), Some(InstallErrorCode::NetConfigInvalid));
    assert_eq!(InstallErrorCode::DuplicateNet.as_str(), "duplicate-net");
    assert_eq!(InstallErrorCode::NetConfigInvalid.as_str(), "net-config-invalid");
}

/// New behaviour: a probe named `net` installs (`__net` is the runtime's key, `net` the game's),
/// and the checksum never sees the net: a loopback run and an offline run of the same seed and
/// input have the same checksum on every tick.
#[test]
fn a_probe_named_net_installs_and_the_checksum_never_sees_the_net() {
    let game = || {
        let mut game = Game::new(World::default()).title("Net probe");
        game.on_update(|sim, _| {
            sim.world.ticks += 1;
            if sim.net.status() == NetStatus::Offline {
                sim.net.connect();
            }
            let _ = sim.net.chat("hello");
        });
        game.probe("net", |sim| json!({ "ticks": sim.world.ticks }));
        game
    };
    let mut offline = Runtime::new(game()).expect("a probe named net installs");
    let mut looped = Runtime::new(game()).expect("installs");
    looped.set_net_mode(NetMode::Loopback);
    for _ in 0..30 {
        offline.step(FIXED_STEP_MS);
        looped.step(FIXED_STEP_MS);
        assert_eq!(offline.checksum(), looped.checksum(), "tick {}", offline.tick());
    }
    assert_eq!(looped.state()["net"], json!({ "ticks": 30 }));
    assert_eq!(looped.state()["__net"]["status"], json!("joined"));
    assert_eq!(offline.state().get("__net"), None);
}

/// New behaviour: a demo scripts remote players in the loopback room; outside it every script call
/// does nothing and is counted in `__net.scriptIgnored` (shown because `game.net` is registered).
#[test]
fn a_demo_scripts_remote_players_in_the_loopback_room_only() {
    let game = || {
        let mut game = Game::new(World::default()).title("Net demo");
        game.net(NetConfig::new());
        game.on_update(|sim, _| {
            if sim.net.status() == NetStatus::Offline {
                sim.net.connect();
            }
        });
        game.demo("two", |driver| {
            let ada = driver.net().join("Ada");
            driver.net().set_state(&ada, json!({ "x": 1 }));
            driver.advance_ms(100);
            json!(driver.sim().net.remotes().count())
        });
        game
    };
    let mut looped = Runtime::new(game()).expect("installs");
    looped.set_net_mode(NetMode::Loopback);
    assert_eq!(looped.demo("two").expect("a demo"), json!(1), "the scripted remote is seated");
    let mut offline = Runtime::new(game()).expect("installs");
    assert_eq!(offline.demo("two").expect("a demo"), json!(0));
    assert_eq!(offline.state()["__net"]["mode"], json!("off"));
    assert_eq!(offline.state()["__net"]["scriptIgnored"], json!(2), "join and set_state, ignored");
}

/// Reseeding starts the loopback room over: `seed(2)` then `seed(1)` replays a fresh `seed(1)`.
#[test]
fn a_reseed_starts_the_loopback_room_over() {
    let run = |rt: &mut Runtime<World>| {
        for _ in 0..8 {
            rt.step(FIXED_STEP_MS);
        }
        (rt.checksum(), rt.state()["__net"].clone(), rt.sim().world.events.clone())
    };
    let mut fresh = Runtime::new(echo_game(Rc::new(RefCell::new(Vec::new())))).expect("installs");
    fresh.set_net_mode(NetMode::Loopback);
    fresh.seed(1);
    let expected = run(&mut fresh);
    let mut reseeded = Runtime::new(echo_game(Rc::new(RefCell::new(Vec::new())))).expect("installs");
    reseeded.set_net_mode(NetMode::Loopback);
    reseeded.seed(2);
    run(&mut reseeded);
    reseeded.seed(1);
    assert_eq!(run(&mut reseeded), expected);
}

/// `sim.net` is part of the game API: a fresh one is offline for the mode it was made for.
#[test]
fn a_fresh_net_is_offline() {
    let net = Net::fresh(NetMode::Loopback, &NetConfig::default());
    assert_eq!((net.status(), net.offline_reason()), (NetStatus::Offline, None));
}
