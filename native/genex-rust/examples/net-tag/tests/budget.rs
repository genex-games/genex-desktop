//! net-tag's net budget row (multiplayer MP-6a): the loopback room's cut plus apply for one tick
//! of an eight-seat room (me and seven scripted remotes publishing every tick, plus the host's
//! tag object) stays within 50 us on the host. The time covers what the runtime adds per tick
//! for the net: the backend's cut, `Net::begin`, the hooks' writes, `Net::end` and the backend's
//! apply. Budgets are advisory in lanes, so the row prints the numbers and asserts only with
//! `GENEX_NET_TAG_BUDGET=1`; it is `#[ignore]`d and runs in release:
//!
//!   GENEX_NET_TAG_BUDGET=1 node scripts/toolchains/rust-env.ts -- cargo test -p net-tag \
//!     --release --offline --test budget -- --ignored --nocapture

#![allow(clippy::disallowed_types, reason = "a budget row times the host's own work with a wall clock")]

use std::time::{Duration, Instant};

use genex::json;
use genex_net::backend::NetBackend;
use genex_net::loopback::LoopbackBackend;
use genex_net::net::{Net, NetConfig};
use genex_net::script::NetScript;
use genex_net::vocab::NetMode;

/// The budget for one tick's cut plus apply.
const BUDGET: Duration = Duration::from_micros(50);
/// Remote seats besides me.
const REMOTES: u32 = 7;
/// Ticks before timing (seat me, claim the tag) and ticks timed.
const WARM_TICKS: u64 = 20;
const TIMED_TICKS: u64 = 3600;

#[test]
#[ignore = "a timing row: run in release with --ignored"]
fn cut_plus_apply_for_an_eight_seat_room_is_within_50_us() {
    let config = NetConfig::new();
    let mut room = LoopbackBackend::new(&config);
    let remotes: Vec<_> = (0..REMOTES).map(|i| NetScript::loopback(&mut room).join(&format!("Bot {i}"))).collect();
    let mut net = Net::fresh(NetMode::Loopback, &config);
    let mut times = Vec::new();
    for tick in 0..WARM_TICKS + TIMED_TICKS {
        let x = tick as f32 * 0.01;
        for (i, remote) in remotes.iter().enumerate() {
            NetScript::loopback(&mut room).set_state(remote, json!({ "x": x + i as f32, "z": -x }));
        }
        let start = Instant::now();
        net.begin(room.cut(tick));
        if tick == 0 {
            net.connect();
        }
        net.set_me(json!({ "x": x, "z": x })).ok();
        if net.is_host() && net.object("tag").is_none_or(|tag| !tag.mine()) {
            net.claim_as_host("tag").ok();
        }
        net.set_object("tag", json!({ "x": -x, "z": x })).ok();
        room.apply(tick, net.end());
        if tick >= WARM_TICKS {
            times.push(start.elapsed());
        }
        assert!(tick < WARM_TICKS || net.players().count() == 1 + REMOTES as usize, "every seat is in the room");
    }
    times.sort();
    let mean = times.iter().sum::<Duration>() / times.len() as u32;
    let p99 = times[times.len() * 99 / 100];
    println!("cut+apply over {TIMED_TICKS} ticks, {} seats: mean {mean:?}, p99 {p99:?}, max {:?}", REMOTES + 1, times[times.len() - 1]);
    if std::env::var("GENEX_NET_TAG_BUDGET").is_ok_and(|v| v == "1") {
        assert!(mean <= BUDGET, "mean {mean:?} over the {BUDGET:?} budget");
    }
}
