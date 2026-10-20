//! NetJournal (MP-2a, new behaviour): a byte-capped ring that drops whole oldest ticks and warns
//! `journal-trimmed` once; its v1 JSON form round-trips and feeds a fresh room the same frames; a
//! hostile JSON table refuses without a panic and without allocating what a count declares; a 60 s
//! journal of 64 players publishing at 15 Hz stays within 4 MiB.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;

use genex_net::frame::{NetChange, NetEvent, NetFrame, NetMatch, NetObject, NetPlayer, NetPose, NetRoom};
use genex_net::ids::{NetTicket, PlayerId};
use genex_net::journal::{NET_JOURNAL_FORMAT, NET_JOURNAL_JSON_BYTES_MAX, NetJournal};
use genex_net::vocab::{MatchStatus, NET_JOURNAL_BYTES_DESKTOP, NET_JOURNAL_BYTES_PHONE, NET_PLAYERS_MAX, NetControl, NetMode, NetStatus, NetWarning};
use glam::{Quat, Vec3};
use serde_json::{Value, json};

/// Bytes live and the most live at once, per thread, so parallel tests do not count each other.
struct Counting;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn grew(bytes: usize) {
    let _ = LIVE.try_with(|live| {
        live.set(live.get() + bytes);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(live.get())));
    });
}

fn shrank(bytes: usize) {
    let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(bytes)));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        shrank(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        shrank(layout.size());
        grew(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// The most bytes live at once on this thread while `work` ran, above what was live before.
fn peak_while<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let before = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    let out = work();
    (out, PEAK.with(Cell::get) - before)
}

fn id(text: &str) -> PlayerId {
    PlayerId::new(text)
}

/// A seated room: me (`p00`) hosting, plus `others` remote seats.
fn seated(others: usize) -> NetRoom {
    let mut room = NetRoom::new(None);
    room.apply(NetChange::Status { status: NetStatus::Joined, reason: None });
    for n in 0..=others {
        room.apply(NetChange::Join { id: id(&format!("p{n:02}")), name: format!("Player {n}"), avatar_url: String::new() });
    }
    room.apply(NetChange::Me(Some(id("p00"))));
    room.apply(NetChange::Host(Some(id("p00"))));
    room
}

/// Everything a tick reads, compared field by field (a frame itself has no equality).
#[derive(Debug, PartialEq)]
struct Seen {
    tick: u64,
    status: NetStatus,
    me: Option<PlayerId>,
    host: Option<PlayerId>,
    open: bool,
    players: Vec<NetPlayer>,
    objects: Vec<NetObject>,
    shared: Vec<(String, Value)>,
    events: Vec<NetEvent>,
    matchmaking: Option<NetMatch>,
    code: Option<String>,
    server_ms: Option<f64>,
}

fn seen(frame: &NetFrame) -> Seen {
    Seen {
        tick: frame.tick(),
        status: frame.status(),
        me: frame.me().cloned(),
        host: frame.host().cloned(),
        open: frame.room_open(),
        players: frame.players().cloned().collect(),
        objects: frame.objects().cloned().collect(),
        shared: frame.shared_keys().map(|key| (key.to_owned(), frame.shared(key).cloned().unwrap_or(Value::Null))).collect(),
        events: frame.events().to_vec(),
        matchmaking: frame.matchmaking().cloned(),
        code: frame.lobby_code().map(str::to_owned),
        server_ms: frame.server_ms(),
    }
}

/// One scripted tick of a busy room: every kind of change and event, so the round trip covers each.
fn script(room: &mut NetRoom, tick: u64) {
    let pose = NetPose { position: Vec3::new(tick as f32 * 0.5, 1.25, -2.0), rotation: Quat::from_xyzw(0.0, 0.5, 0.0, 0.75) };
    match tick % 6 {
        0 => {
            room.apply(NetChange::PlayerState {
                id: id("p01"),
                raw: json!({ "x": tick, "hp": 3, "tag": "é\"\\" }),
                smoothed: Some(json!({ "x": tick as f64 - 0.5 })),
                pose_raw: Some(pose),
                pose: Some(pose),
            });
            room.push_event(NetEvent::Message { from: id("p01"), kind: "boom".into(), payload: json!({ "at": [1, 2.5, null] }) });
        }
        1 => {
            let object = NetChange::Object { id: Arc::from("ball"), owner: Some(id("p02")), epoch: 3, raw: json!({ "v": tick }), smoothed: None, pose: Some(pose) };
            room.apply(object);
            room.push_event(NetEvent::Owner { object: "ball".into(), owner: Some(id("p02")) });
            room.push_event(NetEvent::Control { ticket: NetTicket::new(7), result: NetControl::Held, retry_at_tick: Some(tick + 30) });
        }
        2 => {
            room.apply(NetChange::Shared { key: "round".into(), value: Some(json!(tick)) });
            room.apply(NetChange::Shared { key: "gone".into(), value: None });
            room.push_event(NetEvent::Shared { key: "round".into() });
            room.push_event(NetEvent::Chat { from: id("p00"), name: "Player 0".into(), text: "gg".into() });
        }
        3 => {
            room.apply(NetChange::Connected { id: id("p02"), connected: tick % 12 != 3 });
            room.apply(NetChange::Match(Some(NetMatch::new(MatchStatus::Playing).with_queue(1, 3).with_players(vec![id("p00"), id("p01")]).with_limits(2, 8))));
            room.push_event(NetEvent::HostInput { from: id("p02"), payload: json!({ "jump": true }) });
            room.push_event(NetEvent::Warning { code: NetWarning::RateLimited });
        }
        4 => {
            room.apply(NetChange::LobbyCode(Some("AB12".into())));
            room.apply(NetChange::ServerMs(Some(tick as f64 * 16.5)));
            room.apply(NetChange::RoomOpen(tick % 12 == 4));
            room.push_event(NetEvent::Reconnecting { attempt: 1 });
            room.push_event(NetEvent::Reconnected);
        }
        _ => {
            if tick == 11 {
                room.apply(NetChange::Join { id: id("p03"), name: "Late".into(), avatar_url: "https://a.example/p3.png".into() });
                room.push_event(NetEvent::Joined { player: id("p03") });
            }
            if tick == 17 {
                room.apply(NetChange::Leave(id("p03")));
                room.apply(NetChange::ObjectRemoved(Arc::from("ball")));
                room.apply(NetChange::Host(None));
                room.push_event(NetEvent::Left { player: id("p03") });
                room.push_event(NetEvent::Host { player: None });
            }
        }
    }
}

#[test]
fn the_json_form_round_trips_and_feeds_a_fresh_room_the_same_frames() {
    let mut room = seated(2);
    let mut journal = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    let mut recorded = Vec::new();
    for tick in 0..24 {
        script(&mut room, tick);
        let frame = room.cut(tick, NetMode::Relay);
        assert_eq!(journal.append(&frame), None);
        let quiet = frame.changes().is_empty() && frame.events().is_empty();
        if !quiet {
            recorded.push(seen(&frame));
        }
    }
    assert_eq!(journal.len(), 22, "ticks 5 and 23 changed nothing and take no entry");

    let text = journal.to_json();
    let back = NetJournal::from_json(&text).expect("its own form");
    assert_eq!(back.to_json(), text, "byte-equal round trip");
    assert_eq!((back.len(), back.bytes(), back.span()), (journal.len(), journal.bytes(), Some((0, 22))));
    let head: Value = serde_json::from_slice(&text).expect("JSON");
    assert_eq!((head["format"].as_str(), head["version"].as_u64(), head["count"].as_u64()), (Some(NET_JOURNAL_FORMAT), Some(1), Some(22)));

    let mut replay = NetRoom::new(None);
    let mut replayed = Vec::new();
    for tick in back.ticks() {
        for change in tick.changes {
            replay.apply(change);
        }
        for event in tick.events {
            replay.push_event(event);
        }
        replayed.push(seen(&replay.cut(tick.tick, NetMode::Relay)));
    }
    assert_eq!(replayed, recorded, "a replay cuts the frames the run read");
}

#[test]
fn past_its_byte_cap_the_journal_drops_whole_oldest_ticks_and_warns_once() {
    let mut room = seated(1);
    let first = room.cut(0, NetMode::Loopback);
    let cap = 2_000;
    let mut journal = NetJournal::new(cap);
    assert_eq!(journal.append(&first), None);
    let mut warnings = Vec::new();
    for tick in 1..200_u64 {
        let state = json!({ "x": tick, "pad": "x".repeat(40) });
        room.apply(NetChange::PlayerState { id: id("p01"), raw: state, smoothed: None, pose_raw: None, pose: None });
        let frame = room.cut(tick, NetMode::Loopback);
        if let Some(warning) = journal.append(&frame) {
            warnings.push((tick, warning));
        }
        assert!(journal.bytes() <= cap, "tick {tick}: {} bytes held", journal.bytes());
    }
    assert_eq!(warnings.len(), 1, "journal-trimmed is said once: {warnings:?}");
    assert_eq!(warnings[0].1, NetWarning::JournalTrimmed);
    let (oldest, newest) = journal.span().expect("ticks held");
    assert_eq!(newest, 199);
    assert!(oldest > 0, "the oldest ticks went");
    assert_eq!(journal.trimmed_ticks(), oldest, "ticks 0..oldest were dropped, each whole");
    let held: Vec<u64> = journal.ticks().map(|tick| tick.tick).collect();
    assert_eq!(held, (oldest..=199).collect::<Vec<_>>(), "every held tick decodes whole, none torn");
    let back = NetJournal::from_json(&journal.to_json()).expect("a trimmed journal still reads");
    assert_eq!(back.trimmed_ticks(), journal.trimmed_ticks());

    let mut tiny = NetJournal::new(16);
    assert_eq!(tiny.append(&seated(3).cut(0, NetMode::Loopback)), Some(NetWarning::JournalTrimmed), "an entry over the cap is dropped");
    assert!(tiny.is_empty());
    journal.clear();
    assert_eq!((journal.len(), journal.bytes(), journal.cap_bytes()), (0, 0, cap));
}

/// A valid header around `ticks`, with fields overridden by `patch`.
fn header(patch: &[(&str, Value)], ticks: Value) -> Vec<u8> {
    let count = ticks.as_array().map_or(0, Vec::len);
    let mut root = json!({ "format": NET_JOURNAL_FORMAT, "version": 1, "capBytes": 4096, "trimmedTicks": 0, "count": count, "ticks": ticks });
    for (key, value) in patch {
        root[*key] = value.clone();
    }
    serde_json::to_vec(&root).expect("JSON")
}

#[test]
fn a_hostile_json_table_refuses_without_panic_or_declared_allocation() {
    let good = header(&[], json!([{ "t": 1, "c": [["status", "joined", null]] }, { "t": 2, "e": [["reconnected"]] }]));
    assert!(NetJournal::from_json(&good).is_ok(), "the table's base case reads");

    let deep_open = "[".repeat(10_000);
    let deep_text = format!("{{\"format\":\"{NET_JOURNAL_FORMAT}\",\"version\":1,\"capBytes\":4096,\"trimmedTicks\":0,\"count\":1,\"ticks\":[{{\"t\":1,\"c\":[{deep_open}");
    let deep_closed = format!("{deep_text}{}]}}]}}", "]".repeat(10_000));
    let hostile: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("truncated", good[..good.len() / 2].to_vec()),
        ("not JSON", b"\xff\xfe garbage".to_vec()),
        ("not an object", b"[1,2,3]".to_vec()),
        ("another format", header(&[("format", json!("genex-input-journal"))], json!([]))),
        ("version 2", header(&[("version", json!(2))], json!([]))),
        ("version as text", header(&[("version", json!("1"))], json!([]))),
        ("count 2^31", header(&[("count", json!(1_u64 << 31))], json!([{ "t": 1 }]))),
        ("count 2^64-1", header(&[("count", json!(u64::MAX))], json!([]))),
        ("negative count", header(&[("count", json!(-1))], json!([]))),
        ("capBytes 0", header(&[("capBytes", json!(0))], json!([]))),
        ("capBytes 2^40", header(&[("capBytes", json!(1_u64 << 40))], json!([]))),
        ("no trimmedTicks", header(&[("trimmedTicks", Value::Null)], json!([]))),
        ("ticks not a list", header(&[("ticks", json!({ "t": 1 })), ("count", json!(1))], json!([]))),
        ("ticks out of order", header(&[], json!([{ "t": 5 }, { "t": 5 }]))),
        ("entries past the declared cap", header(&[("capBytes", json!(64))], json!([{ "t": 1, "e": [["chat", "a", "b", "x".repeat(100)]] }]))),
        ("unknown change", header(&[], json!([{ "t": 1, "c": [["teleport", "p1"]] }]))),
        ("unknown event", header(&[], json!([{ "t": 1, "e": [["explode"]] }]))),
        ("unknown status word", header(&[], json!([{ "t": 1, "c": [["status", "dancing", null]] }]))),
        ("short join", header(&[], json!([{ "t": 1, "c": [["join", "p1"]] }]))),
        ("ticket past u32", header(&[], json!([{ "t": 1, "e": [["control", 1_u64 << 33, "accepted", null]] }]))),
        ("pose of 6 numbers", header(&[], json!([{ "t": 1, "c": [["p", "p1", {}, null, [0, 0, 0, 0, 0, 0], null]] }]))),
        ("match without status", header(&[], json!([{ "t": 1, "c": [["match", { "queue": [1, 2] }]] }]))),
        ("tick as text", header(&[], json!([{ "t": "1" }]))),
        ("nested depth 10k, unclosed", deep_text.into_bytes()),
        ("nested depth 10k, closed", deep_closed.into_bytes()),
    ];
    for (name, text) in &hostile {
        let (result, peak) = peak_while(|| std::panic::catch_unwind(|| NetJournal::from_json(text)));
        let refused = result.unwrap_or_else(|_| panic!("{name}: from_json panicked"));
        assert!(refused.is_err(), "{name}: read as a journal");
        let bound = 64 * 1024 + 16 * text.len();
        assert!(peak <= bound, "{name}: {peak} bytes live at once for a {}-byte text (bound {bound})", text.len());
    }

    let oversized = vec![b' '; NET_JOURNAL_JSON_BYTES_MAX + 1];
    let (result, peak) = peak_while(|| NetJournal::from_json(&oversized));
    assert!(result.is_err(), "a text over the cap is refused before parsing");
    assert!(peak < 64 * 1024, "{peak} bytes for a refused oversized text");
}

#[test]
fn a_60_second_journal_of_64_players_at_15_hz_fits_4_mib() {
    let mut room = seated(NET_PLAYERS_MAX - 1);
    let mut journal = NetJournal::new(NET_JOURNAL_BYTES_DESKTOP);
    journal.append(&room.cut(0, NetMode::Relay));
    for tick in 1..=3600_u64 {
        // 15 Hz of 60: a quarter of the seats publish each tick, each seat every fourth tick.
        let phase = usize::try_from(tick % 4).expect("small");
        for n in (phase..NET_PLAYERS_MAX).step_by(4) {
            let t = tick as f64;
            let state = json!({ "x": (t * 0.137 + n as f64).fract() * 100.0, "y": 1.5, "z": (t * 0.071).fract() * -50.0, "yaw": 0.785, "anim": "run" });
            let state = genex_net::writes::round_value(state, 3);
            room.apply(NetChange::PlayerState { id: id(&format!("p{n:02}")), raw: state, smoothed: None, pose_raw: None, pose: None });
        }
        journal.append(&room.cut(tick, NetMode::Relay));
    }
    let mib = journal.bytes() as f64 / f64::from(1 << 20);
    println!("60 s, 64 players at 15 Hz: {} bytes ({mib:.2} MiB) in {} ticks", journal.bytes(), journal.len());
    assert_eq!(journal.trimmed_ticks(), 0);
    assert!(journal.bytes() <= NET_JOURNAL_BYTES_PHONE, "{mib:.2} MiB is over the 4 MiB budget");
}
