//! UIS-2: the save envelope's encoding is canonical and stable (byte-equal round trips, floats
//! included), large bodies deflate to committed bytes, any changed body byte is caught, the size
//! cap holds, and every refusal's wire spelling is pinned.

use genex_core::saves::MAX_SAVE_BYTES;
use genex_core::saves::mirror::MirrorError;
use genex_save::codec::{DEFLATE_ABOVE_BYTES, DEFLATE_MAGIC};
use genex_save::envelope::{Envelope, SAVE_FORMAT, SaveMeta, decode, encode};
use genex_save::error::{SAVE_RESTORE_DIVERGED, SaveErrorCode};
use serde_json::{Map, Value, json};

/// The committed golden of the 300 KiB body (`GXSZ` + length + deflate stream).
const GOLDEN_300K: &[u8] = include_bytes!("goldens/deflate-300k.sav");
/// The committed golden of a schema-1 slot read by UIS-3's migration rows.
const GOLDEN_SCHEMA1: &[u8] = include_bytes!("goldens/schema1.sav");

fn meta(label: &str) -> SaveMeta {
    SaveMeta {
        label: label.to_owned(),
        play_ms: 300_000,
        saved_at_ms: None,
        locale: "en".to_owned(),
        build: "0123456789abcdef".to_owned(),
    }
}

fn envelope(sections: Map<String, Value>) -> Envelope {
    Envelope {
        schema: 3,
        game: "golden-game".to_owned(),
        tick: 18_000,
        seed: 7,
        rng: [0x853c_49e6_748f_ea9b, 0xda3e_39cb_94b9_5bdb],
        state_checksum: 0x0123_4567_89ab_cdef,
        sections,
        meta: meta("Chapter 2"),
    }
}

fn sections(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("sections are an object"),
    }
}

/// Every f64 in `value`, in document order, as bits (so -0.0 and 0.0 differ).
fn float_bits(value: &Value, out: &mut Vec<u64>) {
    match value {
        Value::Number(number) if number.is_f64() => out.push(number.as_f64().map(f64::to_bits).unwrap_or_default()),
        Value::Array(items) => items.iter().for_each(|item| float_bits(item, out)),
        Value::Object(map) => map.values().for_each(|item| float_bits(item, out)),
        _ => {}
    }
}

fn awkward_floats() -> Map<String, Value> {
    sections(json!({
        "genex.nav": {"agents": []},
        "world": {
            "negativeZero": -0.0,
            "huge": 1e300,
            "smallestSubnormal": 5e-324,
            "subnormal": 1e-310,
            "largestSubnormal": 2.225_073_858_507_201e-308,
            "tenthOfMicro": 1e-7,
            "third": 1.0 / 3.0,
            "ints": [0, -1, u64::MAX, i64::MIN],
            "text": "Ünïcödé \u{1F600} \"quoted\" \\ \n",
        },
        "quests": [true, false, null, {"b": 2, "a": 1}],
    }))
}

#[test]
fn a_round_trip_is_byte_equal_with_negative_zero_huge_subnormal_and_tiny_floats() {
    let original = envelope(awkward_floats());
    let bytes = encode(&original).expect("encodes");
    let decoded = decode(&bytes).expect("decodes");
    assert_eq!(decoded, original);
    let (mut before, mut after) = (Vec::new(), Vec::new());
    float_bits(&Value::Object(original.sections.clone()), &mut before);
    float_bits(&Value::Object(decoded.sections.clone()), &mut after);
    assert_eq!(before, after, "every float keeps its bits, -0.0 included");
    assert!(before.contains(&(-0.0f64).to_bits()));
    assert_eq!(encode(&decoded).expect("re-encodes"), bytes, "decode then encode is byte-equal");
    let keys: Vec<&str> = decoded.sections.keys().map(String::as_str).collect();
    assert_eq!(keys, ["genex.nav", "world", "quests"], "sections keep their order");
}

#[test]
fn a_small_body_is_plain_canonical_json_in_the_documented_member_order() {
    let original = envelope(sections(json!({"world": {"hp": 3}})));
    let bytes = encode(&original).expect("encodes");
    let text = std::str::from_utf8(&bytes).expect("a plain body is UTF-8 JSON");
    let digest = format!("{:016x}", original.digest());
    let expected = format!(
        concat!(
            r#"{{"genex":"save","format":1,"schema":3,"game":"golden-game","tick":18000,"seed":7,"#,
            r#""rng":["853c49e6748fea9b","da3e39cb94b95bdb"],"stateChecksum":"0123456789abcdef","digest":"{}","#,
            r#""sections":{{"world":{{"hp":3}}}},"#,
            r#""meta":{{"label":"Chapter 2","playMs":300000,"savedAtMs":null,"#,
            r#""locale":"en","build":"0123456789abcdef"}}}}"#
        ),
        digest
    );
    assert_eq!(text, expected);
    assert_eq!(SAVE_FORMAT, 1);
}

#[test]
fn the_digest_covers_the_sections_and_never_the_meta() {
    let original = envelope(sections(json!({"world": {"hp": 3}})));
    let mut relabelled = original.clone();
    relabelled.meta = SaveMeta { saved_at_ms: Some(1_760_000_000_000), ..meta("Another label") };
    assert_eq!(relabelled.digest(), original.digest());
    let mut changed = original.clone();
    changed.sections.insert("world".to_owned(), json!({"hp": 4}));
    assert_ne!(changed.digest(), original.digest());
    let mut later = original.clone();
    later.tick += 1;
    assert_ne!(later.digest(), original.digest());
    let mut reseeded = original;
    reseeded.rng[1] ^= 2;
    assert_ne!(reseeded.digest(), changed.digest());
}

/// A deterministic body of about 300 KiB: rows of an inventory with floats and names.
fn body_300k() -> Envelope {
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = move || {
        state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        state >> 33
    };
    let names = ["sword", "shield", "potion", "arrow", "key", "map", "gem", "scroll"];
    let rows: Vec<Value> = (0..6_200)
        .map(|i| {
            let pick = usize::try_from(next() % 8).unwrap_or_default();
            let count = next() % 100;
            let x = f64::from(u32::try_from(next() % 4096).unwrap_or_default()) / 16.0;
            json!({"id": i, "item": names[pick], "count": count, "x": x})
        })
        .collect();
    envelope(sections(json!({"world": {"inventory": rows}})))
}

#[test]
fn a_300_kib_body_deflates_to_the_committed_golden() {
    let original = body_300k();
    let plain_len = serde_json::to_vec(&Value::Object(original.sections.clone())).map(|v| v.len()).unwrap_or_default();
    assert!(plain_len > DEFLATE_ABOVE_BYTES && plain_len < 400 * 1024, "the body is about 300 KiB ({plain_len} bytes)");
    let bytes = encode(&original).expect("encodes");
    assert_eq!(&bytes[..4], DEFLATE_MAGIC, "bodies past DEFLATE_ABOVE_BYTES are deflated");
    if std::env::var_os("GENEX_SAVE_BLESS").is_some() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens");
        std::fs::write(dir.join("deflate-300k.sav"), &bytes).expect("blesses the golden");
    }
    assert_eq!(bytes, GOLDEN_300K, "the encoded bytes are the committed golden");
    assert_eq!(decode(GOLDEN_300K).expect("the golden decodes"), original);
}

/// The schema-1 slot UIS-3's migration rows start from: a world from before `hp` became `health`
/// (schema 2) and `quests` gained a `log` (schema 3).
fn schema1() -> Envelope {
    let mut slot = envelope(sections(json!({
        "genex.nav": {"agents": [{"id": 1, "at": [0.5, -0.0, 2.25]}]},
        "world": {"hp": 10, "name": "hero", "pos": [1.5, 0.0, -3.25]},
        "quests": {"done": ["intro"]},
    })));
    slot.schema = 1;
    slot.tick = 600;
    slot.meta = meta("Before the bridge");
    slot
}

#[test]
fn the_schema_1_golden_decodes() {
    if std::env::var_os("GENEX_SAVE_BLESS").is_some() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens");
        std::fs::write(dir.join("schema1.sav"), encode(&schema1()).expect("encodes")).expect("blesses the golden");
    }
    let slot = decode(GOLDEN_SCHEMA1).expect("the schema-1 golden decodes");
    assert_eq!(slot, schema1());
    assert_eq!(slot.schema, 1);
    assert_eq!(slot.game, "golden-game");
    assert_eq!(encode(&slot).expect("re-encodes"), GOLDEN_SCHEMA1);
}

#[test]
fn one_flipped_body_byte_anywhere_in_the_sections_is_save_corrupt() {
    let original = envelope(awkward_floats());
    let bytes = encode(&original).expect("encodes");
    let text = std::str::from_utf8(&bytes).expect("plain");
    let start = text.find(r#""sections":"#).expect("sections member");
    let end = text.find(r#","meta":"#).expect("meta member");
    for at in start..end {
        for flip in [0x01u8, 0x20, 0x80] {
            let mut doctored = bytes.clone();
            doctored[at] ^= flip;
            let refusal = decode(&doctored).expect_err("a changed body byte never decodes");
            assert_eq!(refusal.code, SaveErrorCode::Corrupt, "byte {at} ^ {flip:#x}: {refusal}");
        }
    }
}

#[test]
fn one_flipped_byte_in_a_deflated_body_is_save_corrupt() {
    let bytes = encode(&body_300k()).expect("encodes");
    for at in (8..bytes.len()).step_by(97) {
        let mut doctored = bytes.clone();
        doctored[at] ^= 0x10;
        let refusal = decode(&doctored).expect_err("a changed deflated byte never decodes");
        assert_eq!(refusal.code, SaveErrorCode::Corrupt, "byte {at}: {refusal}");
    }
}

#[test]
fn a_body_over_16_mib_is_save_too_large_and_nothing_is_returned() {
    let filler = "x".repeat(MAX_SAVE_BYTES + 1);
    let refusal = encode(&envelope(sections(json!({"world": filler})))).expect_err("too large");
    assert_eq!(refusal.code, SaveErrorCode::TooLarge);
    let stored = vec![b' '; MAX_SAVE_BYTES + 1];
    assert_eq!(decode(&stored).map_err(|e| e.code), Err(SaveErrorCode::TooLarge));
}

#[test]
fn every_save_error_code_has_its_pinned_wire_spelling() {
    let pinned = [
        "save-slot-invalid",
        "save-slot-missing",
        "save-slots-full",
        "save-too-large",
        "save-quota",
        "save-unavailable",
        "save-corrupt",
        "save-format-unknown",
        "save-newer",
        "save-migration-missing",
        "save-migration-failed",
        "save-section-invalid",
        "save-section-missing",
        "save-busy",
        "save-load-timeout",
        "save-not-configured",
    ];
    assert_eq!(SaveErrorCode::ALL.map(SaveErrorCode::wire), pinned);
    for code in SaveErrorCode::ALL {
        assert_eq!(SaveErrorCode::from_wire(code.wire()), Some(code));
    }
    assert_eq!(SaveErrorCode::from_wire("save-nope"), None);
    assert_eq!(SaveErrorCode::Quota.wire(), MirrorError::Quota.wire(), "genex-core's spelling, not re-spelled");
    assert_eq!(SaveErrorCode::Unavailable.wire(), MirrorError::Unavailable.wire());
    assert_eq!(SAVE_RESTORE_DIVERGED, "save-restore-diverged");
}
