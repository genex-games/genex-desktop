//! Hostile input tracks (IN-3): every damaged or oversized track is refused whole with a typed code
//! (`input-track-invalid` or `input-track-too-large`) and nothing of it is kept; a header that does
//! not match the run is `input-track-mismatch`. The journal's buffers never pass
//! `JOURNAL_BYTES_MAX`: past it the journal turns into a ring of the newest ticks, `complete` false,
//! and what it holds still replays.

use genex_core::input::{Keys, MAX_TOUCHES, PadState, PadStates, TickInput, TouchPhase, TouchPoint, Vec2};
use genex_input::error::InputErrorCode;
use genex_input::journal::{InputJournal, JOURNAL_BYTES_MAX, JOURNAL_RING_TICKS};
use genex_input::track::{InputTrack, TRACK_BYTES_MAX, TrackAnchor, TrackHeader};

fn header() -> TrackHeader {
    TrackHeader { seed: 3, contract: 1, world: [640, 360], bindings_digest: 0xfeed, bindings: b"{}".to_vec() }
}

fn tick_with(held: &[&str], pressed: &[&str], look: f32) -> TickInput {
    let mut input = TickInput::default();
    let names = |list: &[&str]| list.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    input.keys.assign(names(held), names(pressed), Vec::new());
    input.look = Vec2 { x: look, y: 0.0 };
    input
}

/// A small valid track: ten ticks with a key held from tick 2 and a look on tick 5.
fn valid_bytes() -> Vec<u8> {
    let mut journal = InputJournal::new(header());
    for tick in 0..10 {
        let input = match tick {
            2 => tick_with(&["KeyW"], &["KeyW"], 0.0),
            5 => tick_with(&["KeyW"], &[], 2.5),
            3..=9 => tick_with(&["KeyW"], &[], 0.0),
            _ => TickInput::default(),
        };
        journal.record(tick, &input);
    }
    journal.track().encode()
}

/// The documented layout, written by hand so a row can say exactly what is wrong with it.
#[derive(Default)]
struct Bytes(Vec<u8>);

impl Bytes {
    fn v(mut self, value: u64) -> Bytes {
        let mut rest = value;
        while rest >= 0x80 {
            self.0.push((rest as u8) | 0x80);
            rest >>= 7;
        }
        self.0.push(rest as u8);
        self
    }

    fn raw(mut self, bytes: &[u8]) -> Bytes {
        self.0.extend_from_slice(bytes);
        self
    }

    fn f32(self, value: f32) -> Bytes {
        self.raw(&value.to_bits().to_le_bytes())
    }

    /// Magic, format, flags (complete), seed 3, contract 1, world 640x360, digest, no bindings.
    fn header(format: u64) -> Bytes {
        Bytes::default().raw(b"GXIT").v(format).raw(&[1]).v(3).v(1).v(640).v(360).raw(&0xfeed_u64.to_le_bytes()).v(0)
    }

    /// A key table naming `names`.
    fn keys(self, names: &[&str]) -> Bytes {
        names.iter().fold(self.v(names.len() as u64), |out, name| out.v(name.len() as u64).raw(name.as_bytes()))
    }

    /// One segment over `ticks` ticks from 0 holding `rows` rows of `body`.
    fn segment(self, ticks: u64, rows: u64, body: &Bytes) -> Bytes {
        self.v(1).v(0).v(ticks).v(rows).raw(&[0]).v(body.0.len() as u64).raw(&body.0)
    }
}

/// A track whose single segment holds `rows` rows of `body` over `ticks` ticks.
fn track(ticks: u64, rows: u64, body: Bytes) -> Vec<u8> {
    Bytes::header(1).keys(&["KeyW"]).segment(ticks, rows, &body).0
}

/// A row field mask: held keys, look, text, touches.
const HELD: u64 = 1;
const LOOK: u64 = 1 << 3;
const TEXT: u64 = 1 << 8;
const TOUCHES: u64 = 1 << 9;

fn touches_row(count: u64) -> Bytes {
    (0..count).fold(Bytes::default().v(0).v(TOUCHES).v(count), |out, id| out.v(id).raw(&[0]).f32(1.0).f32(2.0))
}

#[test]
fn the_hand_written_layout_is_the_format() {
    // A track built by hand from the documented layout decodes, so the hostile rows below are
    // each wrong for exactly the reason they name.
    let body = Bytes::default().v(1).v(HELD).v(1).v(0).v(2).v(LOOK).f32(1.5).f32(0.0);
    let decoded = InputTrack::decode(&track(5, 2, body)).expect("the hand-written track decodes");
    let inputs: Vec<(u64, TickInput)> = decoded.inputs().collect();
    assert_eq!(inputs.len(), 5);
    assert!(inputs[1].1.keys.down("KeyW") && inputs[4].1.keys.down("KeyW"));
    assert_eq!(inputs[3].1.look.x, 1.5);
    assert_eq!(inputs[4].1.look.x, 0.0, "a delta is not carried to the next tick");
    assert!(InputTrack::decode(&valid_bytes()).is_ok());
}

#[test]
fn hostile_tracks_are_refused_whole_with_a_typed_code() {
    use InputErrorCode::{TrackInvalid, TrackTooLarge};
    let valid = valid_bytes();
    let truncated = valid[..valid.len() - 1].to_vec();
    let mut format_2 = valid.clone();
    format_2[4] = 2;
    let mut trailing = valid.clone();
    trailing.push(0);
    let held_row = |gap: u64| Bytes::default().v(gap).v(HELD).v(1).v(0);
    let two_rows = |second_gap: u64| {
        let mut body = held_row(1);
        body.0.extend_from_slice(&held_row(second_gap).0);
        body
    };
    let long_text = "x".repeat(257);
    let units_over = "🎮".repeat(129); // 258 UTF-16 units in 516 bytes
    let table: Vec<(&str, Vec<u8>, InputErrorCode)> = vec![
        ("truncated by one byte", truncated, TrackInvalid),
        ("empty", Vec::new(), TrackInvalid),
        ("not a track", b"PK\x03\x04 not an input track".to_vec(), TrackInvalid),
        ("format 2", format_2, TrackInvalid),
        ("a hand-written format 2", Bytes::header(2).keys(&[]).v(0).0, TrackInvalid),
        ("a byte after the last segment", trailing, TrackInvalid),
        ("a row count past the bytes", track(10, 1_000_000, held_row(1)), TrackInvalid),
        ("a row count of u64::MAX", track(10, u64::MAX, held_row(1)), TrackInvalid),
        ("more rows than ticks", track(1, 2, two_rows(1)), TrackInvalid),
        ("a row repeats its tick", track(10, 2, two_rows(0)), TrackInvalid),
        ("a tick gap that overflows", track(10, 2, two_rows(u64::MAX)), TrackInvalid),
        ("a row past its segment", track(3, 1, held_row(3)), TrackInvalid),
        ("a key index past the table", track(4, 1, Bytes::default().v(0).v(HELD).v(1).v(1)), TrackInvalid),
        ("more than ten fingers down", track(4, 1, touches_row(MAX_TOUCHES as u64 + 1)), TrackInvalid),
        ("text over 256 bytes", track(4, 1, Bytes::default().v(0).v(TEXT).v(257).raw(long_text.as_bytes())), TrackInvalid),
        ("text over 256 UTF-16 units", track(4, 1, Bytes::default().v(0).v(TEXT).v(516).raw(units_over.as_bytes())), TrackInvalid),
        ("text that is not UTF-8", track(4, 1, Bytes::default().v(0).v(TEXT).v(2).raw(&[0xc3, 0x28])), TrackInvalid),
        ("an empty row mask", track(4, 1, Bytes::default().v(0).v(0)), TrackInvalid),
        ("an unknown row bit", track(4, 1, Bytes::default().v(0).v(1 << 10)), TrackInvalid),
        ("a varint of eleven bytes", track(4, 1, Bytes::default().raw(&[0xff; 11])), TrackInvalid),
        ("a key name that is not canonical", Bytes::header(1).keys(&["w"]).v(0).0, TrackInvalid),
        ("a key name that repeats", Bytes::header(1).keys(&["KeyW", "KeyW"]).v(0).0, TrackInvalid),
        ("a segment of no tick", track(0, 0, Bytes::default()), TrackInvalid),
        ("over 16 MiB", vec![0; TRACK_BYTES_MAX + 1], TrackTooLarge),
    ];
    for (name, bytes, code) in table {
        let refused = InputTrack::decode(&bytes).err().unwrap_or_else(|| panic!("{name}: decoded"));
        assert_eq!(refused.code, code, "{name}: {}", refused.detail);
    }
}

#[test]
fn every_prefix_of_a_track_is_refused() {
    let valid = valid_bytes();
    for len in 0..valid.len() {
        let refused = InputTrack::decode(&valid[..len]).err();
        assert_eq!(refused.map(|error| error.code), Some(InputErrorCode::TrackInvalid), "a {len}-byte prefix");
    }
}

#[test]
fn a_track_for_another_run_is_a_mismatch() {
    let track = InputTrack::decode(&valid_bytes()).expect("valid");
    assert!(track.check(3, 1, [640, 360], 0xfeed).is_ok());
    let others = [(4, 1, [640, 360], 0xfeed), (3, 2, [640, 360], 0xfeed), (3, 1, [640, 361], 0xfeed), (3, 1, [640, 360], 1)];
    for (seed, contract, world, digest) in others {
        let refused = track.check(seed, contract, world, digest).err().map(|error| error.code);
        assert_eq!(refused, Some(InputErrorCode::TrackMismatch));
    }
}

/// A tick of heavy input: changing keys, both sticks, a trigger, text and fingers.
fn heavy(tick: u64) -> (TickInput, PadStates) {
    let mut input = TickInput::default();
    let key = format!("Key{}", char::from(b'A' + (tick % 26) as u8));
    let mut keys = Keys::default();
    keys.assign(vec![key.clone(), "ShiftLeft".to_owned()], vec![key], Vec::new());
    input.keys = keys;
    input.look = Vec2 { x: tick as f32 * 0.37, y: -(tick as f32) };
    input.text = "typed".to_owned();
    let mut pads = PadStates::default();
    let t = (tick % 1000) as f32 / 1000.0;
    pads[0] = PadState { connected: true, axes: [t, -t, t * 0.5, 0.25], ..PadState::default() };
    pads[0].buttons[7] = t;
    input.touches = vec![TouchPoint { id: 1, x: t * 100.0, y: 5.0, phase: TouchPhase::Held }];
    (input, pads)
}

#[test]
fn the_journal_never_allocates_past_its_cap_and_rings_past_it() {
    let mut journal = InputJournal::new(header());
    let mut before = PadStates::default();
    let mut recorded = Vec::new();
    let mut peak = 0;
    let ticks = 60_000;
    for tick in 0..ticks {
        let (mut input, now) = heavy(tick);
        input.pads.assign(now, before);
        before = now;
        journal.record(tick, &input);
        peak = peak.max(journal.allocated());
        assert!(journal.allocated() <= JOURNAL_BYTES_MAX, "tick {tick}: {} bytes", journal.allocated());
        if tick + 20_000 >= ticks {
            recorded.push(input);
        }
    }
    let view = journal.view();
    println!("heavy journal: peak {peak} bytes allocated, holds {} ticks in {} bytes", view.ticks, view.bytes);
    assert!(!view.complete, "past the cap the journal is a ring");
    assert!(view.ticks >= JOURNAL_RING_TICKS.min(view.ticks) && view.ticks < ticks);
    let track = InputTrack::decode(&journal.track().encode()).expect("the ring's track decodes");
    assert!(!track.complete());
    assert_eq!(track.start_tick() + track.ticks(), ticks, "the ring holds the newest ticks");
    let offset = recorded.len() - track.ticks() as usize;
    for ((tick, replayed), original) in track.inputs().zip(&recorded[offset..]) {
        assert_eq!(&replayed, original, "tick {tick} replays from the ring");
    }
}

#[test]
fn a_light_session_stays_complete_and_a_tail_export_fits_its_budget() {
    let mut journal = InputJournal::new(header());
    for tick in 0..30_000 {
        let input = if tick % 120 < 60 { tick_with(&["KeyW"], &[], 0.0) } else { TickInput::default() };
        journal.record(tick, &input);
    }
    assert!(journal.view().complete);
    assert_eq!(journal.view().ticks, 30_000);
    let tail = journal.track_within(24 * 1024);
    assert!(tail.encode().len() <= 24 * 1024);
    assert_eq!(tail.start_tick() + tail.ticks(), 30_000);
}

#[test]
fn a_skipped_tick_restarts_the_journal_incomplete_and_a_snapshot_anchor_completes_it() {
    let mut journal = InputJournal::new(header());
    journal.record(0, &TickInput::default());
    journal.record(5, &TickInput::default());
    assert!(!journal.view().complete);
    journal.record(6, &tick_with(&["KeyW"], &["KeyW"], 0.0));
    let track = journal.track();
    assert_eq!((track.start_tick(), track.ticks()), (6, 1));
    journal.anchor_snapshot(100, PadStates::default());
    journal.record(100, &TickInput::default());
    let track = InputTrack::decode(&journal.track().encode()).expect("decodes");
    assert_eq!(track.anchor(), TrackAnchor::Snapshot);
    assert!(track.complete());
    assert_eq!(track.start_tick(), 100);
    journal.record(u64::MAX, &TickInput::default());
    journal.record(u64::MAX, &TickInput::default());
    assert!(!journal.view().complete, "the last tick number restarts the journal without overflowing");
}
