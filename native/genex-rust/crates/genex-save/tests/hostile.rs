//! UIS-2 hostile table: bodies and names a game, a person or a damaged disk could hand the save
//! crate. Each row is refused with its code and nothing is returned; no row panics or allocates
//! past the cap.

use genex_core::saves::MAX_SAVE_BYTES;
use genex_save::codec::{DEFLATE_MAGIC, pack, unpack};
use genex_save::envelope::{Envelope, NESTING_MAX, SECTION_NAME_MAX, SECTIONS_MAX, SaveMeta, decode, encode};
use genex_save::error::SaveErrorCode;
use genex_save::slot::{AUTOSAVE_RING_MAX, SLOT_NAME_MAX, SlotName};
use serde_json::{Map, Value, json};

fn envelope(sections: Map<String, Value>) -> Envelope {
    Envelope {
        schema: 1,
        game: "hostile".to_owned(),
        tick: 60,
        seed: 1,
        rng: [1, 3],
        state_checksum: 9,
        sections,
        meta: SaveMeta {
            label: "Hostile".to_owned(),
            play_ms: 1_000,
            saved_at_ms: None,
            locale: "en".to_owned(),
            build: String::new(),
        },
    }
}

fn one_section(name: &str, value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(name.to_owned(), value);
    map
}

/// `[[[ ... ]]]` holding `depth` arrays.
fn nested(depth: usize) -> Value {
    (0..depth).fold(json!(0), |inner, _| Value::Array(vec![inner]))
}

/// The plain JSON of an envelope with `member` replaced by `value` (the digest left as it was).
fn doctored(member: &str, value: Value) -> Vec<u8> {
    let bytes = encode(&envelope(one_section("world", json!({"hp": 3})))).expect("encodes");
    let mut document: Value = serde_json::from_slice(&bytes).expect("plain JSON");
    document[member] = value;
    serde_json::to_vec(&document).expect("serialises")
}

/// A `GXSZ` frame declaring `length` over `stream`.
fn frame(length: u32, stream: &[u8]) -> Vec<u8> {
    let mut bytes = DEFLATE_MAGIC.to_vec();
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(stream);
    bytes
}

fn deflate(bytes: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec(bytes, 6)
}

#[test]
fn hostile_bodies_are_refused_with_their_code() {
    let json = encode(&envelope(one_section("world", json!({"hp": 3})))).expect("encodes");
    let json_len = u32::try_from(json.len()).expect("small");
    let zeros = vec![0u8; 32 * 1024 * 1024];
    let cap = u32::try_from(MAX_SAVE_BYTES).expect("16 MiB fits u32");
    let mut deep = String::new();
    for _ in 0..200 {
        deep.push('[');
    }
    for _ in 0..200 {
        deep.push(']');
    }
    let deep_body = String::from_utf8(json.clone()).expect("plain").replace(r#"{"hp":3}"#, &deep);
    let rows: Vec<(&str, Vec<u8>, SaveErrorCode)> = vec![
        ("empty", Vec::new(), SaveErrorCode::Corrupt),
        ("not JSON", b"\x89PNG\r\n\x1a\n".to_vec(), SaveErrorCode::Corrupt),
        ("truncated GXSZ: magic only", DEFLATE_MAGIC.to_vec(), SaveErrorCode::Corrupt),
        ("truncated GXSZ: half a length", frame(0, &[])[..6].to_vec(), SaveErrorCode::Corrupt),
        ("truncated GXSZ: no stream", frame(json_len, &[]), SaveErrorCode::Corrupt),
        ("truncated GXSZ: half a stream", frame(json_len, &deflate(&json)[..10]), SaveErrorCode::Corrupt),
        ("length lie: short", frame(json_len - 1, &deflate(&json)), SaveErrorCode::Corrupt),
        ("length lie: long", frame(json_len + 1, &deflate(&json)), SaveErrorCode::Corrupt),
        ("length past the cap", frame(cap + 1, &deflate(&json)), SaveErrorCode::TooLarge),
        ("inflate bomb, honest length", frame(cap, &deflate(&zeros)), SaveErrorCode::TooLarge),
        ("inflate bomb, lying length", frame(json_len, &deflate(&zeros)), SaveErrorCode::Corrupt),
        ("bytes after the stream", [frame(json_len, &deflate(&json)), vec![0]].concat(), SaveErrorCode::Corrupt),
        ("nesting deeper than the cap", deep_body.into_bytes(), SaveErrorCode::Corrupt),
        ("sections an array", doctored("sections", json!([])), SaveErrorCode::Corrupt),
        ("sections a string", doctored("sections", json!("world")), SaveErrorCode::Corrupt),
        ("unknown format", doctored("format", json!(2)), SaveErrorCode::FormatUnknown),
        ("format a string", doctored("format", json!("1")), SaveErrorCode::FormatUnknown),
        ("not a genex save", doctored("genex", json!("settings")), SaveErrorCode::FormatUnknown),
        ("a JSON array", b"[1,2,3]".to_vec(), SaveErrorCode::FormatUnknown),
        ("schema 0", doctored("schema", json!(0)), SaveErrorCode::Corrupt),
        ("schema past u32", doctored("schema", json!(u64::from(u32::MAX) + 1)), SaveErrorCode::Corrupt),
        ("negative tick", doctored("tick", json!(-1)), SaveErrorCode::Corrupt),
        ("float tick", doctored("tick", json!(60.0)), SaveErrorCode::Corrupt),
        ("rng of one part", doctored("rng", json!(["0000000000000001"])), SaveErrorCode::Corrupt),
        ("rng not hex", doctored("rng", json!(["zz", "0000000000000003"])), SaveErrorCode::Corrupt),
        ("digest of the wrong body", doctored("digest", json!("0000000000000000")), SaveErrorCode::Corrupt),
        ("unknown member", doctored("extra", json!(1)), SaveErrorCode::Corrupt),
        ("meta missing", doctored("meta", Value::Null), SaveErrorCode::Corrupt),
        ("trailing bytes", [json.as_slice(), b" {}"].concat(), SaveErrorCode::Corrupt),
        (
            "non-canonical spacing",
            String::from_utf8(json.clone()).expect("plain").replacen(':', ": ", 1).into_bytes(),
            SaveErrorCode::Corrupt,
        ),
        ("past the cap, plain", vec![b' '; MAX_SAVE_BYTES + 1], SaveErrorCode::TooLarge),
    ];
    for (row, bytes, code) in rows {
        let refusal = decode(&bytes).expect_err(row);
        assert_eq!(refusal.code, code, "{row}: {refusal}");
    }
}

#[test]
fn a_frame_round_trips_and_a_small_body_stays_plain() {
    let json = encode(&envelope(one_section("world", json!({"hp": 3})))).expect("encodes");
    assert_eq!(pack(json.clone()).expect("packs"), json, "a body under DEFLATE_ABOVE_BYTES is stored as is");
    let framed = frame(u32::try_from(json.len()).expect("small"), &deflate(&json));
    assert_eq!(unpack(&framed).expect("unpacks").as_ref(), json.as_slice());
}

#[test]
fn hostile_sections_are_refused_on_encode() {
    let mut too_many = Map::new();
    for i in 0..=SECTIONS_MAX {
        too_many.insert(format!("s{i}"), json!(i));
    }
    let deep_ok = NESTING_MAX - 3;
    let rows: Vec<(&str, Map<String, Value>)> = vec![
        ("an empty name", one_section("", json!(1))),
        ("a name past the cap", one_section(&"s".repeat(SECTION_NAME_MAX + 1), json!(1))),
        ("a slash", one_section("a/b", json!(1))),
        ("a space", one_section("a b", json!(1))),
        ("a NUL", one_section("a\0b", json!(1))),
        ("too many sections", too_many),
        ("nesting past the cap", one_section("world", nested(deep_ok + 1))),
    ];
    for (row, sections) in rows {
        let refusal = encode(&envelope(sections)).expect_err(row);
        assert_eq!(refusal.code, SaveErrorCode::SectionInvalid, "{row}: {refusal}");
    }
    let deepest = envelope(one_section("world", nested(deep_ok)));
    let bytes = encode(&deepest).expect("the deepest allowed section encodes");
    assert_eq!(decode(&bytes).expect("and decodes"), deepest);
    let mut label = envelope(Map::new());
    label.meta.label = "é".repeat(65);
    assert_eq!(encode(&label).map_err(|e| e.code), Err(SaveErrorCode::SlotInvalid), "a label past 64 characters");
}

#[test]
fn a_game_names_only_plain_slots_and_never_an_autosave_or_a_reserved_name() {
    let refused = [
        "",
        "Slot",
        "SLOT-1",
        &"a".repeat(SLOT_NAME_MAX + 1),
        "-lead",
        "a_b",
        "a.b",
        "..",
        "a/b",
        "a\\b",
        "a\0b",
        "café",
        "autosave-0",
        "autosave-x",
        "con",
        "nul",
        "com1",
        "lpt9",
        "aux",
        "prn",
        "genex-crash",
    ];
    for name in refused {
        let refusal = SlotName::new(name).expect_err(name);
        assert_eq!(refusal.code, SaveErrorCode::SlotInvalid, "{name:?}");
    }
    for name in ["a", "slot-1", "chapter-02", &"z".repeat(SLOT_NAME_MAX), "0"] {
        let slot = SlotName::new(name).expect(name);
        assert_eq!(slot.as_str(), name);
        assert!(!slot.is_autosave());
        assert_eq!(slot.body_file(), format!("slots/{name}.sav"));
        assert_eq!(slot.meta_file(), format!("slots/{name}.meta.json"));
    }
}

#[test]
fn autosave_slots_are_looked_up_but_never_named_by_a_game() {
    let ring = SlotName::autosave(2).expect("in the ring");
    assert_eq!(ring.as_str(), "autosave-2");
    assert!(ring.is_autosave());
    assert_eq!(ring.autosave_index(), Some(2));
    assert_eq!(ring.body_file(), "autosave/2.sav");
    assert_eq!(ring.meta_file(), "autosave/2.meta.json");
    assert_eq!(SlotName::lookup("autosave-2"), Ok(ring));
    assert_eq!(SlotName::lookup("slot-1").map(|s| s.is_autosave()), Ok(false));
    let past = AUTOSAVE_RING_MAX;
    assert!(SlotName::autosave(past).is_err());
    for name in [format!("autosave-{past}"), "autosave-01".to_owned(), "autosave-".to_owned(), "autosave-a".to_owned()]
    {
        assert_eq!(SlotName::lookup(&name).map_err(|e| e.code), Err(SaveErrorCode::SlotInvalid), "{name}");
    }
}
