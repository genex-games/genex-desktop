//! JSON as the studio's TypeScript reads and writes it: `JSON.stringify`'s text (numbers as
//! JavaScript prints them, insertion order), the canonical form tape keys and judge prompts use
//! (keys sorted by UTF-16 code unit), string lengths in UTF-16 units, JavaScript's `trim`, and
//! the bounded walks main runs on every message before reading a field.

use serde_json::{Map, Number, Value};

/// Keys that would reach an object's prototype when a JavaScript reader copies them.
const FORBIDDEN_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
/// The largest integer JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// The decimal exponent from which JavaScript prints a number in exponent form.
const JS_EXPONENT_FROM: i32 = 21;
/// The decimal exponent below which JavaScript prints a number in exponent form.
const JS_EXPONENT_BELOW: i32 = -6;

/// A string's length as JavaScript counts it: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Whether `c` is white space to JavaScript's `String.prototype.trim` (WhiteSpace and
/// LineTerminator): unlike Rust's `trim`, it takes U+FEFF and leaves U+0085.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()` as JavaScript trims.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Whether `text` holds anything but JavaScript white space.
pub fn has_words(text: &str) -> bool {
    !js_trim(text).is_empty()
}

/// A number as JavaScript's `Number.prototype.toString` prints it (`JSON.stringify` uses it):
/// shortest round-trip digits, plain from 1e-6 up to 1e21, exponent form (`1e+21`, `1e-7`)
/// outside, and `-0` as `0`.
pub fn js_number(number: &Number) -> String {
    if let Some(whole) = number.as_u64().filter(|whole| *whole <= MAX_SAFE_INTEGER) {
        return whole.to_string();
    }
    if let Some(whole) = number.as_i64().filter(|whole| whole.unsigned_abs() <= MAX_SAFE_INTEGER) {
        return whole.to_string();
    }
    js_float(number.as_f64().unwrap_or(0.0))
}

/// A finite `f64` as JavaScript prints it.
pub fn js_float(value: f64) -> String {
    if value == 0.0 || !value.is_finite() {
        return "0".to_owned();
    }
    if value < 0.0 {
        return format!("-{}", js_float(-value));
    }
    // Rust's `{:e}` is the shortest round-trip form too: "1.2345e20", "5e-324".
    let exponent_form = format!("{value:e}");
    let (mantissa, exponent) = exponent_form.split_once('e').unwrap_or((exponent_form.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let point = exponent.parse::<i32>().unwrap_or(0) + 1;
    place_point(&digits, point)
}

/// `digits` with the decimal point `point` places from their start, in JavaScript's layout.
fn place_point(digits: &str, point: i32) -> String {
    let count = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    if count <= point && point <= JS_EXPONENT_FROM {
        return format!("{digits}{}", "0".repeat(usize::try_from(point - count).unwrap_or(0)));
    }
    if 0 < point && point <= JS_EXPONENT_FROM {
        let (whole, fraction) = digits.split_at(usize::try_from(point).unwrap_or(0));
        return format!("{whole}.{fraction}");
    }
    if JS_EXPONENT_BELOW < point && point <= 0 {
        return format!("0.{}{digits}", "0".repeat(usize::try_from(-point).unwrap_or(0)));
    }
    let shown = point - 1;
    let sign = if shown >= 0 { '+' } else { '-' };
    let (first, rest) = digits.split_at(1);
    let mantissa = if rest.is_empty() { first.to_owned() } else { format!("{first}.{rest}") };
    format!("{mantissa}e{sign}{}", shown.unsigned_abs())
}

/// A string as `JSON.stringify` quotes it (serde_json escapes the same set, the same way).
fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

/// `JSON.stringify(value)`: members in their order, numbers as JavaScript prints them.
pub fn js_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out, false);
    out
}

/// The canonical JSON of a value (`canonicalJson`): keys sorted by UTF-16 code unit, so the same
/// request hashes the same whatever order its keys were written in.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out, true);
    out
}

/// JavaScript's `a < b` on two strings: by UTF-16 code unit.
pub fn js_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_json(value: &Value, out: &mut String, sorted: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&js_number(number)),
        Value::String(text) => out.push_str(&quoted(text)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out, sorted);
            }
            out.push(']');
        }
        Value::Object(members) => write_object(members, out, sorted),
    }
}

fn write_object(members: &Map<String, Value>, out: &mut String, sorted: bool) {
    let mut entries: Vec<(&String, &Value)> = members.iter().collect();
    if sorted {
        entries.sort_by(|(a, _), (b, _)| js_order(a, b));
    }
    out.push('{');
    for (index, (key, child)) in entries.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&quoted(key));
        out.push(':');
        write_json(child, out, sorted);
    }
    out.push('}');
}

/// How large a JSON tree a walk accepts: its nodes, its depth and its characters (UTF-16 units of
/// its strings and keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JsonBounds {
    /// The most values the tree holds.
    pub nodes: usize,
    /// The deepest a value sits (the root at 0).
    pub depth: usize,
    /// The most UTF-16 units its strings and keys hold together.
    pub chars: usize,
}

/// The bounds of one message from a game (`AI_MESSAGE_BOUNDS`).
pub const AI_MESSAGE_BOUNDS: JsonBounds = JsonBounds {
    nodes: crate::wire::AI_MAX_WALK_NODES,
    depth: crate::wire::AI_MAX_WALK_DEPTH,
    chars: crate::wire::AI_MAX_BODY_CHARS,
};

/// How much of its bounds a walk has left (signed: the walk stops the moment one goes negative).
struct Budget {
    nodes: i64,
    chars: i64,
    depth: usize,
}

const fn signed(count: usize) -> i64 {
    if count > i64::MAX as usize { i64::MAX } else { count as i64 }
}

/// Whether a value is a plain JSON tree inside `bounds` (`isBoundedJson`): too many nodes, too
/// deep, too many characters, or a key that reaches a JavaScript prototype refuse it.
pub fn is_bounded(value: &Value, bounds: JsonBounds) -> bool {
    let mut budget = Budget { nodes: signed(bounds.nodes), chars: signed(bounds.chars), depth: bounds.depth };
    walk(value, &mut budget, 0)
}

fn walk(value: &Value, budget: &mut Budget, depth: usize) -> bool {
    budget.nodes -= 1;
    if depth > budget.depth || budget.nodes < 0 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(text) => {
            budget.chars -= signed(utf16_len(text));
            budget.chars >= 0
        }
        Value::Array(items) => items.iter().all(|item| walk(item, budget, depth + 1)),
        Value::Object(members) => members.iter().all(|(key, child)| {
            budget.chars -= signed(utf16_len(key));
            !FORBIDDEN_KEYS.contains(&key.as_str()) && budget.chars >= 0 && walk(child, budget, depth + 1)
        }),
    }
}

/// Whether an answer is plain JSON inside the answer bounds (`isAnswerJson`): at most
/// [`crate::wire::AI_MAX_JSON_NODES`] values, nested at most [`crate::wire::AI_MAX_JSON_DEPTH`].
/// Iterative, so hostile nesting cannot overflow the stack.
pub fn is_answer_json(value: &Value) -> bool {
    let mut pending: Vec<(&Value, usize)> = vec![(value, 0)];
    let mut nodes = 0usize;
    while let Some((item, depth)) = pending.pop() {
        nodes += 1;
        if nodes > crate::wire::AI_MAX_JSON_NODES || depth > crate::wire::AI_MAX_JSON_DEPTH {
            return false;
        }
        match item {
            Value::Array(items) => pending.extend(items.iter().map(|child| (child, depth + 1))),
            Value::Object(members) => pending.extend(members.values().map(|child| (child, depth + 1))),
            _ => {}
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let table: [(f64, &str); 16] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (1.5, "1.5"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1.5e-6, "0.0000015"),
            (5e-324, "5e-324"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            (-2.5e-7, "-2.5e-7"),
            (9_007_199_254_740_992.0, "9007199254740992"),
        ];
        for (value, printed) in table {
            assert_eq!(js_float(value), printed, "{value:e}");
        }
        assert_eq!(js_number(&Number::from(u64::MAX)), "18446744073709552000");
        assert_eq!(js_number(&Number::from(i64::MIN)), "-9223372036854776000");
        assert_eq!(js_number(&Number::from(-3)), "-3");
    }

    #[test]
    fn javascript_trims_its_own_white_space() {
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a", "NEL is not JavaScript white space");
        assert!(!has_words(" \t\n\u{2028}"));
        assert!(has_words("\u{85}"));
    }

    #[test]
    fn canonical_json_sorts_keys_by_utf16_unit() {
        // By code point U+FF5E comes before U+1F600; by UTF-16 unit 0xD83D (😀's first) comes first.
        let value = json!({ "\u{ff5e}": 1, "😀": 2, "b": [3.0, {"y": 2, "x": 1}], "a": "é" });
        assert_eq!(canonical_json(&value), "{\"a\":\"é\",\"b\":[3,{\"x\":1,\"y\":2}],\"😀\":2,\"～\":1}");
        assert_eq!(js_json(&json!({"b": 1, "a": 2})), "{\"b\":1,\"a\":2}");
    }

    #[test]
    fn bounded_walks_refuse_trees_past_any_bound() {
        let bounds = JsonBounds { nodes: 4, depth: 2, chars: 6 };
        let rows: [(Value, bool); 8] = [
            (json!({"ab": "cd"}), true),
            (json!({"ab": "cde"}), true),
            (json!({"ab": "cdefg"}), false),
            (json!([1, 2, 3]), true),
            (json!([1, 2, 3, 4]), false),
            (json!([[1]]), true),
            (json!([[[1]]]), false),
            (json!({"constructor": 1}), false),
        ];
        for (value, fits) in rows {
            assert_eq!(is_bounded(&value, bounds), fits, "{value}");
        }
        assert!(!is_bounded(&json!({"__proto__": null}), AI_MESSAGE_BOUNDS));
        assert!(is_bounded(&json!("😀".repeat(3)), JsonBounds { nodes: 1, depth: 0, chars: 6 }));
        assert!(!is_bounded(&json!("😀".repeat(4)), JsonBounds { nodes: 1, depth: 0, chars: 6 }));
    }

    #[test]
    fn an_answer_too_deep_or_too_large_is_refused_without_recursion() {
        let mut deep = json!(1);
        for _ in 0..=crate::wire::AI_MAX_JSON_DEPTH {
            deep = json!([deep]);
        }
        assert!(!is_answer_json(&deep));
        let wide = Value::Array(vec![json!(0); crate::wire::AI_MAX_JSON_NODES]);
        assert!(!is_answer_json(&wide), "the array itself is one more node");
        assert!(is_answer_json(&Value::Array(vec![json!(0); crate::wire::AI_MAX_JSON_NODES - 1])));
    }
}
