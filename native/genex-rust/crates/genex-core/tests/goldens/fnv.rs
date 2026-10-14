//! `digest.h`: FNV-1a 64 and its hex form.

use crate::support::{from_hex, golden, same, text, u64_of};
use genex_core::digest::{fnv1a64, fnv1a64_from, hex64};
use genex_core::json::Value;

#[test]
fn digests_match_the_cpp() {
    let cases = golden!("fnv");
    for case in cases["texts"].items() {
        let bytes = from_hex(case["hex"].as_str());
        same(&Value::from(hex64(fnv1a64(&bytes))), &case["digest"], &format!("fnv of {}", case["hex"].as_str()));
    }
    for case in cases["chained"].items() {
        let bytes = from_hex(case["hex"].as_str());
        let split = case["split"].as_f64() as usize;
        let half = fnv1a64(&bytes[..split]);
        same(&Value::from(hex64(half)), &case["half"], "chained half");
        same(&Value::from(hex64(fnv1a64_from(&bytes[split..], half))), &case["whole"], "chained whole");
    }
    let pattern: Vec<u8> = (0..4096_usize).map(|i| ((i * 31 + 7) % 256) as u8).collect();
    same(&Value::from(hex64(fnv1a64(&pattern))), &cases["pattern4096"], "the 4096-byte capture pattern");
    for case in cases["hex64"].items() {
        same(&Value::from(hex64(u64_of(&case["value"]))), &case["text"], "hex64");
    }
}

#[test]
fn the_published_vectors_hold() {
    assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
    assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
    assert_eq!(fnv1a64(b"foobar"), 0x85944171f73967e8);
    const AT_COMPILE_TIME: u64 = fnv1a64(b"a");
    assert_eq!(AT_COMPILE_TIME, 0xaf63dc4c8601ec8c);
    assert_eq!(text(&Value::from("a")), b"a");
}
