//! Plain JSON floats in a section load back exactly: every finite f64 (and every f32 a game's
//! world widens to f64 through serde) encodes, decodes to the same bits and re-encodes to the same
//! bytes. A non-finite float has no JSON number: serde_json writes it as `null`, which decodes as
//! `null` (the facade's typed load then refuses it, see the genex saves rows).
//!
//! The decode re-parses each float from its own number token, so the hostile rows put the text a
//! token scanner could trip on (digits, `-` and `e` in strings, escaped quotes and backslashes,
//! unicode escapes, nesting, integer extremes) beside a float serde_json's default parser misreads.

use genex_save::envelope::{Envelope, SaveMeta, decode, encode, parse_document};
use genex_save::error::SaveErrorCode;
use serde_json::{Map, Value, json};

/// Random bit patterns drawn per width.
const RANDOM_FLOATS: usize = 4_000;
/// The generator's seed: the table is the same on every run.
const SEED: u64 = 0x5afe_f10a_7500_0001;

/// splitmix64: a seeded stream of u64 bit patterns.
fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn envelope(value: Value) -> Envelope {
    let mut sections = Map::new();
    sections.insert("world".to_owned(), json!({ "v": value }));
    Envelope {
        schema: 1,
        game: "floats".to_owned(),
        tick: 600,
        seed: 7,
        rng: [1, 2],
        state_checksum: 3,
        sections,
        meta: SaveMeta { label: "floats".to_owned(), ..SaveMeta::default() },
    }
}

/// The named awkward floats: f64 extremes, subnormals, -0.0 and f32 values widened as serde does.
fn named_floats() -> Vec<(String, Value)> {
    let f64s: [(&str, f64); 14] = [
        ("0.1", 0.1),
        ("-0.0", -0.0),
        ("1e300", 1e300),
        ("-1e300", -1e300),
        ("f64::MAX", f64::MAX),
        ("f64::MIN_POSITIVE", f64::MIN_POSITIVE),
        ("smallest subnormal", 5e-324),
        ("largest subnormal", 2.225_073_858_507_201e-308),
        ("1e-310", 1e-310),
        ("1/3", 1.0 / 3.0),
        ("f64::EPSILON", f64::EPSILON),
        ("2^53 + 2", 9_007_199_254_740_994.0),
        ("1e22", 1e22),
        ("1e23", 1e23),
    ];
    let f32s: [(&str, f32); 10] = [
        ("0.1f32", 0.1),
        ("-0.0f32", -0.0),
        ("1/3 f32", 1.0 / 3.0),
        ("f32::MAX", f32::MAX),
        ("f32::MIN_POSITIVE", f32::MIN_POSITIVE),
        ("smallest f32 subnormal", f32::from_bits(1)),
        ("largest f32 subnormal", f32::from_bits(0x007f_ffff)),
        ("f32::EPSILON", f32::EPSILON),
        ("-4.5f32", -4.5),
        ("16777217f32", 16_777_217.0),
    ];
    let named = f64s.iter().map(|(name, x)| ((*name).to_owned(), Value::from(*x)));
    named.chain(f32s.iter().map(|(name, x)| ((*name).to_owned(), Value::from(*x)))).collect()
}

/// Seeded random finite f64 and f32 bit patterns, the f32s widened as serde widens them.
fn random_floats() -> Vec<(String, Value)> {
    let mut state = SEED;
    let mut rows = Vec::with_capacity(2 * RANDOM_FLOATS);
    while rows.len() < RANDOM_FLOATS {
        let x = f64::from_bits(splitmix(&mut state));
        if x.is_finite() {
            rows.push((format!("f64 bits {:016x}", x.to_bits()), Value::from(x)));
        }
    }
    while rows.len() < 2 * RANDOM_FLOATS {
        let bits = u32::try_from(splitmix(&mut state) >> 32).unwrap_or_default();
        let x = f32::from_bits(bits);
        if x.is_finite() {
            rows.push((format!("f32 bits {bits:08x}"), Value::from(x)));
        }
    }
    rows
}

/// What is wrong with `value`'s round trip, if anything.
fn round_trip_fault(value: &Value) -> Option<String> {
    let original = envelope(value.clone());
    let bytes = match encode(&original) {
        Ok(bytes) => bytes,
        Err(error) => return Some(format!("encode refused: {}", error.detail)),
    };
    let decoded = match decode(&bytes) {
        Ok(decoded) => decoded,
        Err(error) => return Some(format!("decode refused {}: {}", error.code.wire(), error.detail)),
    };
    let bits = |envelope: &Envelope| envelope.sections["world"]["v"].as_f64().map(f64::to_bits);
    if decoded != original || bits(&decoded) != bits(&original) {
        return Some(format!("loaded {} for {}", decoded.sections["world"]["v"], value));
    }
    match encode(&decoded) {
        Ok(again) if again == bytes => None,
        Ok(_) => Some("re-encoding gives other bytes".to_owned()),
        Err(error) => Some(format!("re-encode refused: {}", error.detail)),
    }
}

#[test]
fn every_finite_float_round_trips_byte_identical_and_loads_equal() {
    let rows: Vec<(String, Value)> = named_floats().into_iter().chain(random_floats()).collect();
    let faults: Vec<String> = rows
        .iter()
        .filter_map(|(name, value)| round_trip_fault(value).map(|fault| format!("{name}: {fault}")))
        .collect();
    let first = &faults[..faults.len().min(5)];
    assert!(faults.is_empty(), "{} of {} floats fail, first: {first:?}", faults.len(), rows.len());
}

#[test]
fn a_section_of_many_plain_floats_loads_back() {
    let poses: Vec<Value> = random_floats().into_iter().map(|(_, value)| value).collect();
    let original = envelope(Value::Array(poses));
    let bytes = encode(&original).expect("encodes");
    let decoded = decode(&bytes).expect("a section of plain floats loads");
    assert_eq!(decoded, original);
    assert_eq!(encode(&decoded).expect("re-encodes"), bytes);
}

#[test]
fn a_non_finite_float_has_no_json_number_and_round_trips_as_null() {
    for x in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let original = envelope(Value::from(x));
        assert_eq!(original.sections["world"]["v"], Value::Null, "{x} becomes null before encoding");
        let bytes = encode(&original).expect("encodes");
        assert_eq!(decode(&bytes).expect("decodes"), original);
    }
}

/// f32::MAX widened: a float serde_json's default parser lands an ulp off.
const MISREAD: f64 = 3.402_823_466_385_288_6e38;

/// Section values whose strings, keys, nesting and integers sit beside floats the decode re-parses.
fn hostile_token_rows() -> Vec<(&'static str, Value)> {
    vec![
        ("digits in a string", json!(["1.5e300", MISREAD, "-0.0", MISREAD])),
        ("an escaped quote before digits", json!(["a\"1.25\"", MISREAD])),
        ("an escaped backslash ends a string", json!(["\\", MISREAD, "\\\"9\\", MISREAD])),
        ("a unicode escape with digits", json!(["\u{1}\u{1f}2", MISREAD, "é1e5", MISREAD])),
        ("digits in keys", json!({ "1.5e3": MISREAD, "-2": { "e-7\"": MISREAD } })),
        ("nested arrays and objects", json!([[[MISREAD, [{ "a": [MISREAD] }]], {}], [], MISREAD])),
        ("integers at their extremes", json!([u64::MAX, MISREAD, i64::MIN, MISREAD, 0, -1])),
        ("past u64 as a float", json!([18_446_744_073_709_551_616.0_f64, MISREAD])),
        ("exponents", json!([1e300, 5e-324, MISREAD, -1e-300, 1e22])),
        ("negative zero", json!([-0.0, MISREAD, 0.0, -0.0])),
        ("literals between floats", json!([true, MISREAD, null, MISREAD, false, MISREAD])),
    ]
}

#[test]
fn floats_beside_hostile_tokens_round_trip_byte_identical() {
    for (what, value) in hostile_token_rows() {
        let original = envelope(value);
        let bytes = encode(&original).unwrap_or_else(|error| panic!("{what}: encode refused {error:?}"));
        let decoded = decode(&bytes).unwrap_or_else(|error| panic!("{what}: decode refused {error:?}"));
        assert_eq!(decoded, original, "{what}");
        let text = |envelope: &Envelope| serde_json::to_string(&envelope.sections).unwrap_or_default();
        assert_eq!(text(&decoded), text(&original), "{what}: every float's bits, -0.0 included");
        assert_eq!(encode(&decoded).ok(), Some(bytes), "{what}: re-encodes byte-identical");
    }
}

#[test]
fn a_parsed_document_keeps_integers_and_reads_each_float_from_its_own_token() {
    let text = br#"{"s":"1.5\"2e3\\","n":[3.4028234663852886e38,{"k\u00221":-0.0}],"u":18446744073709551615,"i":-9223372036854775808,"big":18446744073709551616,"t":5e-324,"x":1e300}"#;
    let document = parse_document(text).expect("JSON");
    assert_eq!(document["s"], json!("1.5\"2e3\\"));
    assert_eq!(document["n"][0].as_f64().map(f64::to_bits), Some(MISREAD.to_bits()));
    assert_eq!(document["n"][1]["k\"1"].as_f64().map(f64::to_bits), Some((-0.0_f64).to_bits()));
    assert_eq!((document["u"].as_u64(), document["i"].as_i64()), (Some(u64::MAX), Some(i64::MIN)));
    assert_eq!(document["big"].as_f64(), Some(18_446_744_073_709_551_616.0));
    assert_eq!((document["t"].as_f64(), document["x"].as_f64()), (Some(5e-324), Some(1e300)));
}

#[test]
fn hostile_text_around_floats_is_refused_corrupt_and_never_panics() {
    let bytes = encode(&envelope(json!(["a\"1\\", MISREAD, { "k": [0.1, MISREAD] }]))).expect("encodes");
    let text = String::from_utf8(bytes.clone()).expect("a small body is plain JSON");
    let refused: [(&str, Vec<u8>); 3] = [
        ("a duplicate member", text.replacen(r#"{"v":"#, r#"{"v":0.30000000000000004,"v":"#, 1).into_bytes()),
        ("a float in another spelling", text.replacen("3.4028234663852886e+38", "3.40282346638528860e+38", 1).into_bytes()),
        ("a dangling escape", br#"{"genex":"save","s":"\"#.to_vec()),
    ];
    for (what, stored) in refused {
        assert!(stored != bytes, "{what} changes the body");
        assert_eq!(decode(&stored).map_err(|error| error.code), Err(SaveErrorCode::Corrupt), "{what}");
    }
    // Every cut, and each byte turned into a quote, a backslash, a minus or an `e`: refused, or
    // (a label or game name is outside the digest) a canonical save that loads as its exact bytes.
    let mut swept: Vec<(String, Vec<u8>)> = (1..bytes.len()).map(|end| (format!("cut at {end}"), bytes[..end].to_vec())).collect();
    for at in 0..bytes.len() {
        for &byte in br#""\-e"# {
            let mut mutated = bytes.clone();
            mutated[at] = byte;
            swept.push((format!("{} at {at}", char::from(byte)), mutated));
        }
    }
    let codes = [SaveErrorCode::Corrupt, SaveErrorCode::FormatUnknown];
    for (what, stored) in swept {
        match decode(&stored) {
            Ok(decoded) => assert_eq!(encode(&decoded).ok(), Some(stored), "{what}: loads only as its exact bytes"),
            Err(refused) => assert!(codes.contains(&refused.code), "{what}: {refused:?}"),
        }
    }
}
