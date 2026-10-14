//! Reading the goldens `scripts/spike/rust-wgpu/extract-goldens.ts` wrote from the C++ template,
//! in the encodings `tests/fixtures/genex-core-goldens/driver/golden_driver.cpp` documents.

use genex_core::input::Vec2;
use genex_core::json::{self, Value};

/// A golden file's `cases`, parsed by the port's own JSON reader.
macro_rules! golden {
    ($unit:literal) => {
        crate::support::cases(include_str!(concat!(
            "../../../../../../tests/fixtures/genex-core-goldens/",
            $unit,
            ".golden.json"
        )))
    };
}
pub(crate) use golden;

/// The deepest nesting a golden file has (the C++ driver reads scenarios with the same limit).
const GOLDEN_DEPTH: usize = 64;

/// The `cases` member of a golden file.
pub fn cases(text: &str) -> Value {
    let golden = json::parse_with_depth(text.as_bytes(), GOLDEN_DEPTH).expect("a golden file parses");
    golden["cases"].clone()
}

/// `value`'s bits as the driver writes a double.
pub fn bits(value: f64) -> Value {
    Value::from(format!("0x{:016x}", value.to_bits()))
}

/// `value`'s bits as the driver writes a float.
pub fn float_bits(value: f32) -> Value {
    Value::from(value.to_bits())
}

/// A 64-bit integer written as a number or as hex text.
pub fn u64_of(value: &Value) -> u64 {
    if let Value::Number(number) = value {
        // The goldens only write integers this way.
        return *number as u64;
    }
    u64::from_str_radix(value.as_str().trim_start_matches("0x"), 16).expect("hex u64")
}

/// A double written as a number, "nan", "inf", "-inf", "-0" or its hex bits.
pub fn real(value: &Value) -> f64 {
    if let Value::Number(number) = value {
        return *number;
    }
    match value.as_str() {
        "nan" => f64::NAN,
        "inf" => f64::INFINITY,
        "-inf" => f64::NEG_INFINITY,
        "-0" => -0.0,
        text => f64::from_bits(u64::from_str_radix(text.trim_start_matches("0x"), 16).expect("hex bits")),
    }
}

/// A double narrowed to a float, as the driver's `static_cast<float>` does.
pub fn real32(value: &Value) -> f32 {
    real(value) as f32
}

/// The bytes a text spec names: a string, `{hex}`, `{repeat, count}` or an array of specs.
pub fn text(spec: &Value) -> Vec<u8> {
    match spec {
        Value::String(bytes) => bytes.clone(),
        Value::Array(parts) => parts.iter().flat_map(text).collect(),
        _ if spec.get("hex").is_some() => from_hex(spec["hex"].as_str()),
        _ if spec.get("repeat").is_some() => text(&spec["repeat"]).repeat(spec["count"].as_f64() as usize),
        _ => Vec::new(),
    }
}

/// A text spec that names valid UTF-8.
pub fn text_str(spec: &Value) -> String {
    String::from_utf8(text(spec)).expect("a UTF-8 text spec")
}

/// Lowercase hex of `bytes`.
pub fn hex(bytes: &[u8]) -> Value {
    Value::from(bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// The bytes lowercase hex names.
pub fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex byte")).collect()
}

/// A list of text specs as strings.
pub fn string_list(value: &Value) -> Vec<String> {
    value.items().iter().map(text_str).collect()
}

/// A list of strings as a JSON array.
pub fn strings<S: AsRef<str>>(list: &[S]) -> Value {
    let mut out = Value::array();
    for item in list {
        out.push(Value::from(item.as_ref()));
    }
    out
}

/// A 2D vector as the driver writes one: two floats' bits.
pub fn vec2(value: Vec2) -> Value {
    let mut out = Value::array();
    out.push(float_bits(value.x));
    out.push(float_bits(value.y));
    out
}

/// A 2D vector from two reals, or `fallback` when absent.
pub fn vec2_of(value: &Value, fallback: Vec2) -> Vec2 {
    match value.items() {
        [x, y, ..] => Vec2 { x: real32(x), y: real32(y) },
        _ => fallback,
    }
}

/// Assert two values are equal, printing both dumps when they are not.
#[track_caller]
pub fn same(actual: &Value, expected: &Value, context: &str) {
    if actual != expected {
        panic!(
            "{context}\n  rust: {}\n   c++: {}",
            String::from_utf8_lossy(&actual.dump()),
            String::from_utf8_lossy(&expected.dump())
        );
    }
}
