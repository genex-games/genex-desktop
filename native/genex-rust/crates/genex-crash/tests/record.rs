//! The record's rows (CRASH-1a): every kind round-trips; a record over 64 KiB gives up the
//! profile, then the replay track, then bottom frames, and says so; hostile JSON is refused or
//! cut with the host parser's rules and never panics; the shared fixture
//! (`tests/fixtures/crash-record-v1.json`, read by `src/shared/crash-record.ts` too) parses.

use genex_crash::caps::{
    CRASH_FRAMES_MAX, CRASH_MESSAGE_MAX_BYTES, CRASH_PATH_MAX_CHARS, CRASH_RECORD_MAX_BYTES, CRASH_REPLAY_MAX_BYTES,
    NAME_TEXT_MAX_CHARS,
};
use genex_crash::{
    CrashFlavour, CrashFrame, CrashGpu, CrashImage, CrashKind, CrashLocation, CrashParseError, CrashRecord, CrashReplay,
    CrashSource, CrashThread, CrashTrimmed, CrashWasm, GpuErrorClass, RecordContext, WasmFrame, WasmTrap,
};
use serde_json::{Value, json};

const FIXTURE_MESSAGE: &str = "index out of bounds: the len is 3 but the index is 7";
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../tests/fixtures/crash-record-v1.json");

/// The record the shared fixture holds.
fn fixture_record() -> CrashRecord {
    let profile = json!({
        "v": 1, "on": true, "frames": 120, "cpu": { "p50": 6.1, "p95": 9.8 }, "gpu": null,
        "top": [
            { "scope": "physics", "game": false, "p95": 1.9 },
            { "scope": "enemy_ai", "game": true, "p95": 1.1 }
        ],
        "counters": { "enemies": 42 }, "memory": [], "hitches": { "count": 2, "last": 288 }, "nodes": "off",
        "dropped": { "scopes": 0, "counters": 0, "frames": 0 }
    });
    CrashRecord {
        location: Some(CrashLocation { file: "src/enemy.rs".into(), line: 42, column: 17 }),
        thread: Some(CrashThread { name: "main".into(), main: true }),
        frames: vec![CrashFrame::Ip(0x1045a3f20), CrashFrame::Ip(0x1045a2b10), CrashFrame::Ip(0x1045a1004)],
        anchor: Some(0x1045a0000),
        context: RecordContext {
            seed: Some(1),
            tick: Some(300),
            frame: Some(312),
            simulated_ms: Some(5000.5),
            running: Some(true),
            destination: Some("mac".into()),
            flavour: Some(CrashFlavour::Dev),
            build: Some("3f2a9c41d0e8b7a6".into()),
            contract: Some(2),
            genex: Some("0.1.0".into()),
        },
        replay: Some(CrashReplay {
            seed: 1,
            from_tick: 0,
            to_tick: 300,
            complete: true,
            track: b"genex-input-track".to_vec(),
        }),
        profile: Some(profile),
        hitches: vec![211, 288],
        ..CrashRecord::new(CrashKind::Panic, CrashSource::Game, true, FIXTURE_MESSAGE)
    }
}

/// A record with every part near its cap and 3.5 KB of profile, built so that it passes 64 KiB
/// only with the profile: without it the record is within 3 KB of the cap.
fn full_record() -> CrashRecord {
    let mut record = fixture_record();
    // Control characters take 6 bytes each as JSON escapes.
    record.message = "\u{1}".repeat(CRASH_MESSAGE_MAX_BYTES);
    record.frames = (0..CRASH_FRAMES_MAX as u64).map(|n| CrashFrame::Ip(0x1_0000_0000 + n * 16)).collect();
    let track = vec![0xab; CRASH_REPLAY_MAX_BYTES];
    record.replay = Some(CrashReplay { seed: 7, from_tick: 10, to_tick: 900, complete: true, track });
    record.profile = None;
    // 64 images whose names grow one escape at a time until the record is within 3 KB of the cap.
    for escapes in 0..=NAME_TEXT_MAX_CHARS {
        let name = |n: usize| format!("{n:02}{}", "\u{1}".repeat(escapes));
        let image = |n: usize| CrashImage { name: name(n), id: "0123abcd-ef".into() };
        record.images = (0..64).map(image).collect();
        if record.to_json().len() >= CRASH_RECORD_MAX_BYTES - 3_000 {
            break;
        }
    }
    record.profile = Some(json!({ "padding": "x".repeat(3_500) }));
    record
}

fn parse(value: &Value) -> Result<CrashRecord, CrashParseError> {
    CrashRecord::from_json(&serde_json::to_vec(value).expect("json"))
}

fn fixture_value() -> Value {
    serde_json::from_str(&std::fs::read_to_string(FIXTURE).expect("the shared fixture")).expect("valid JSON")
}

#[test]
fn the_shared_fixture_parses_and_is_what_the_writer_writes() {
    let text = std::fs::read(FIXTURE).expect("the shared fixture");
    assert_eq!(CrashRecord::from_json(&text), Ok(fixture_record()));
    assert_eq!(fixture_record().to_value(), fixture_value(), "field for field, in the host's shape");
    let written: Value = serde_json::from_slice(&fixture_record().to_json()).expect("valid JSON");
    assert_eq!(written, fixture_value());
}

#[test]
fn every_kind_round_trips() {
    for kind in CrashKind::ALL {
        let fatal = *kind != CrashKind::DeviceLost;
        let mut record = CrashRecord::new(*kind, CrashSource::Host, fatal, format!("{} happened", kind.wire()));
        record.gpu = Some(CrashGpu {
            class: Some(GpuErrorClass::Validation),
            reason: Some("lost".into()),
            description: "bind group".into(),
            backend: Some("metal".into()),
            adapter: Some("Apple M3".into()),
        });
        record.wasm = Some(CrashWasm { trap: WasmTrap::Memory, stack: vec![WasmFrame { func: 12, offset: 0x4f2 }] });
        record.images = vec![CrashImage { name: "Game".into(), id: "5A0E-77".into() }];
        record.frames = vec![CrashFrame::Image { image: 0, offset: 0x10 }, CrashFrame::Ip(u64::MAX)];
        let back = CrashRecord::from_json(&record.to_json()).expect("its own JSON parses");
        assert_eq!(back, record, "{}", kind.wire());
    }
}

#[test]
fn every_vocabulary_spells_its_wire_values() {
    for kind in CrashKind::ALL {
        assert_eq!(CrashKind::from_wire(kind.wire()), Some(*kind));
    }
    let kinds: Vec<&str> = CrashKind::ALL.iter().map(|kind| kind.wire()).collect();
    let expected = [
        "panic",
        "gpu-validation",
        "device-lost",
        "wasm-trap",
        "native-fault",
        "out-of-memory",
        "hang",
        "process-exit",
    ];
    assert_eq!(kinds, expected);
    let trimmed: Vec<&str> = CrashTrimmed::ALL.iter().map(|part| part.wire()).collect();
    assert_eq!(trimmed, ["profile", "replay.track", "frames", "message", "location.file"]);
    for source in CrashSource::ALL {
        assert_eq!(CrashSource::from_wire(source.wire()), Some(*source));
    }
    for class in GpuErrorClass::ALL {
        assert_eq!(GpuErrorClass::from_wire(class.wire()), Some(*class));
    }
    for trap in WasmTrap::ALL {
        assert_eq!(WasmTrap::from_wire(trap.wire()), Some(*trap));
    }
    assert_eq!(CrashKind::GAME_KINDS, &[CrashKind::Panic, CrashKind::GpuValidation, CrashKind::DeviceLost]);
}

#[test]
fn a_record_over_64_kib_gives_up_the_profile_first_and_says_so() {
    let record = full_record();
    let unfitted = serde_json::to_vec(&record.to_value()).expect("json").len();
    assert!(unfitted > CRASH_RECORD_MAX_BYTES, "the row starts over the cap: {unfitted} bytes");
    let json = record.to_json();
    assert!(json.len() <= CRASH_RECORD_MAX_BYTES, "{} bytes", json.len());
    let back = CrashRecord::from_json(&json).expect("it parses");
    assert_eq!(back.trimmed, [CrashTrimmed::Profile], "the profile alone was enough");
    assert!(back.profile.is_none());
    assert_eq!(back.replay.map(|replay| replay.track.len()), Some(CRASH_REPLAY_MAX_BYTES), "the track stays");
    assert_eq!(back.frames.first(), Some(&CrashFrame::Ip(0x1_0000_0000)), "the top frame stays");
}

#[test]
fn overlong_text_is_cut_at_a_character_and_named() {
    let mut record = fixture_record();
    record.message = "é".repeat(CRASH_MESSAGE_MAX_BYTES);
    record.location = Some(CrashLocation { file: "ü".repeat(5 * 1024), line: 1, column: 1 });
    let back = CrashRecord::from_json(&record.to_json()).expect("it parses");
    assert!(back.message.len() <= CRASH_MESSAGE_MAX_BYTES && back.message.chars().all(|c| c == 'é'));
    assert_eq!(back.location.map(|at| at.file.chars().count()), Some(CRASH_PATH_MAX_CHARS));
    assert_eq!(back.trimmed, [CrashTrimmed::Message, CrashTrimmed::LocationFile]);
}

/// The fixture with `path` set to `value` (a JSON pointer's parent and key).
fn with(pointer: &str, key: &str, value: Value) -> Value {
    let mut record = fixture_value();
    let target = record.pointer_mut(pointer).expect("the pointer exists");
    target[key] = value;
    record
}

#[test]
fn hostile_records_are_refused_and_never_panic() {
    let refused: Vec<(&str, Value)> = vec![
        ("unknown kind", with("", "kind", json!("meltdown"))),
        ("unknown source", with("", "source", json!("player"))),
        ("fatal not boolean", with("", "fatal", json!("yes"))),
        ("handled missing", with("", "handled", Value::Null)),
        ("message not text", with("", "message", json!(7))),
        ("non-hex ip", with("/frames/0", "ip", json!("0xZZ"))),
        ("upper-case ip", with("/frames/0", "ip", json!("0xABC"))),
        ("ip without 0x", with("/frames/0", "ip", json!("1045a3f20"))),
        ("ip past 16 digits", with("/frames/0", "ip", json!("0x10000000000000000"))),
        ("negative tick", with("/context", "tick", json!(-1))),
        ("fractional tick", with("/context", "tick", json!(1.5))),
        ("tick past 2^53", with("/context", "tick", json!(1u64 << 54))),
        ("seed past u32", with("/context", "seed", json!(1u64 << 32))),
        ("unknown flavour", with("/context", "flavour", json!("release"))),
        ("thread name past 128", with("/thread", "name", json!("t".repeat(129)))),
        ("replay backwards", with("/replay", "fromTick", json!(301))),
        ("track not base64", with("/replay", "track", json!("not base64!"))),
        ("frame image out of range", with("/frames/0", "image", json!(0))),
        ("anchor not hex", with("/anchor", "ip", json!("anchor"))),
        ("wrong format", with("", "format", json!("genex-crash/2"))),
    ];
    for (row, value) in &refused {
        let mut value = value.clone();
        if *row == "frame image out of range" {
            value["frames"][0] = json!({ "image": 0, "offset": "0x10" });
        }
        let result = std::panic::catch_unwind(|| parse(&value));
        assert!(matches!(result, Ok(Err(_))), "{row}: {result:?}");
    }
}

#[test]
fn oversized_and_deep_input_is_refused_before_parsing() {
    let mut big = fixture_value();
    big["message"] = json!("x".repeat(65 * 1024));
    assert_eq!(parse(&big), Err(CrashParseError::TooLarge));
    let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
    assert_eq!(CrashRecord::from_json(deep.as_bytes()), Err(CrashParseError::TooDeep));
    // Brackets inside strings are text, not nesting.
    let braces = with("", "message", json!("[[[[[[[[[[[[[[[[[[[[{{{{{{{{{{{{{{"));
    assert!(parse(&braces).is_ok());
    assert_eq!(CrashRecord::from_json(b"not json"), Err(CrashParseError::NotJson));
    assert_eq!(CrashRecord::from_json(b"[1, 2]"), Err(CrashParseError::NotJson));
}

#[test]
fn overlong_parts_from_a_writer_are_cut_and_named_not_refused() {
    let mut value = fixture_value();
    value["frames"] = Value::Array((0..129).map(|n| json!({ "ip": format!("{:#x}", 0x1000 + n) })).collect());
    value["message"] = json!("é".repeat(5 * 1024));
    value["location"]["file"] = json!("p".repeat(5 * 1024));
    value["replay"]["track"] = json!("QUJD".repeat(CRASH_REPLAY_MAX_BYTES / 3 + 1));
    value["profile"] = json!({ "padding": "x".repeat(5 * 1024) });
    value["mystery"] = json!("dropped");
    let record = parse(&value).expect("cut, not refused");
    assert_eq!(record.frames.len(), CRASH_FRAMES_MAX);
    assert!(record.message.len() <= CRASH_MESSAGE_MAX_BYTES);
    assert_eq!(record.location.as_ref().map(|at| at.file.len()), Some(CRASH_PATH_MAX_CHARS));
    let replay = record.replay.as_ref().expect("the replay stays");
    assert!(replay.track.is_empty() && !replay.complete, "an overlong track reads as empty and incomplete");
    assert!(record.profile.is_none());
    assert_eq!(record.trimmed, CrashTrimmed::ALL, "each cut named once, in vocabulary order");
    assert!(!record.to_value().as_object().expect("an object").contains_key("mystery"));
}

/// Prints what the writer writes for the heaviest records, one `SAMPLE <json>` line each, so the
/// host's parser can be run over them (`cargo test -p genex-crash --test record -- --ignored
/// --nocapture`, then `parseCrashRecord` on each line).
#[test]
#[ignore = "evidence for the host parser; prints records"]
fn writer_samples_for_the_host_parser() {
    let mut cut = fixture_record();
    cut.message = "é".repeat(3 * 1024);
    cut.location = Some(CrashLocation { file: "\u{1F600}".repeat(400), line: 1, column: 2 });
    cut.thread = Some(CrashThread { name: "\u{1F600}".repeat(100), main: false });
    cut.frames = (0..200).map(CrashFrame::Ip).collect();
    for sample in [fixture_record(), full_record(), cut] {
        println!("SAMPLE {}", String::from_utf8(sample.to_json()).expect("UTF-8"));
    }
}
