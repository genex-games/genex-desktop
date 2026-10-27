//! Canonical JSON (CONTRACT.md §10.2): object keys sorted byte-wise, no whitespace, strings escaped
//! as `JSON.stringify` escapes them, and every number written as ECMAScript's
//! `Number.prototype.toString` of the shortest decimal that round-trips the f32 the core holds, with
//! −0 as 0.

use std::collections::BTreeMap;
use std::fmt::Write as _;

/// The largest decimal exponent `Number.prototype.toString` writes without an exponent.
const PLAIN_EXPONENT_MAX: i32 = 21;
/// The smallest decimal exponent it writes as `0.000…` instead of an exponent.
const PLAIN_EXPONENT_MIN: i32 = -6;

/// A canonical JSON value.
#[derive(Clone, Debug)]
pub(crate) enum Canon {
    /// A number the core holds as f32.
    Num(f32),
    /// A number the core holds as f32, its sign kept: −0 is written `-0` (a descriptor's canonical
    /// form, §20.5, where the sign of a zero can reach the simulation through the z-up mapping).
    Signed(f32),
    /// `true` or `false`.
    Bool(bool),
    /// `null`.
    Null,
    /// A string.
    Str(String),
    /// An array, in order.
    Arr(Vec<Canon>),
    /// An object; a `BTreeMap<String, _>` iterates in byte order.
    Obj(BTreeMap<String, Canon>),
}

impl Canon {
    /// An object from `(key, value)` pairs.
    pub(crate) fn object<const N: usize>(pairs: [(&str, Canon); N]) -> Canon {
        Canon::Obj(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    /// A number array from f32s.
    pub(crate) fn numbers(values: &[f32]) -> Canon {
        Canon::Arr(values.iter().map(|v| Canon::Num(*v)).collect())
    }

    /// The canonical text.
    pub(crate) fn write(&self) -> String {
        let mut out = String::new();
        self.write_into(&mut out);
        out
    }

    fn write_into(&self, out: &mut String) {
        match self {
            Canon::Num(value) => out.push_str(&es_number(*value)),
            Canon::Signed(value) if *value == 0.0 && value.is_sign_negative() => out.push_str("-0"),
            Canon::Signed(value) => out.push_str(&es_number(*value)),
            Canon::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Canon::Null => out.push_str("null"),
            Canon::Str(text) => write_string(text, out),
            Canon::Arr(items) => write_array(items, out),
            Canon::Obj(members) => write_object(members, out),
        }
    }
}

fn write_array(items: &[Canon], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        item.write_into(out);
    }
    out.push(']');
}

fn write_object(members: &BTreeMap<String, Canon>, out: &mut String) {
    out.push('{');
    for (index, (key, value)) in members.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        value.write_into(out);
    }
    out.push('}');
}

/// A string escaped as `JSON.stringify` escapes it.
fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript's `Number.prototype.toString` of the shortest decimal that round-trips `value` as an
/// f32 (§10.2), with −0 written as `0`.
pub fn es_number(value: f32) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_nan() {
        return "NaN".to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    if value.is_infinite() {
        return format!("{sign}Infinity");
    }
    let (digits, exponent) = shortest_digits(value.abs());
    format!("{sign}{}", es_layout(&digits, exponent))
}

/// The shortest round-trip digits of a positive finite f32 and n, the decimal point's position:
/// value = 0.d1d2…dk × 10^n.
fn shortest_digits(value: f32) -> (String, i32) {
    // `{:e}` writes the shortest round-trip digits as `d[.ddd]e<exp>`.
    let text = format!("{value:e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    (digits, exponent + 1)
}

/// ECMA-262 Number::toString's layout of digits d1…dk with the decimal point at n.
fn es_layout(digits: &str, n: i32) -> String {
    let k = digits.len() as i32;
    if k <= n && n <= PLAIN_EXPONENT_MAX {
        return format!("{digits}{}", "0".repeat((n - k) as usize));
    }
    if 0 < n && n <= PLAIN_EXPONENT_MAX {
        let (whole, fraction) = digits.split_at(n as usize);
        return format!("{whole}.{fraction}");
    }
    if PLAIN_EXPONENT_MIN < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n) as usize));
    }
    let (first, rest) = digits.split_at(1);
    let point = if rest.is_empty() { String::new() } else { format!(".{rest}") };
    let e = n - 1;
    let e_sign = if e >= 0 { "+" } else { "-" };
    format!("{first}{point}e{e_sign}{}", e.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_follow_number_prototype_to_string_on_the_f32_shortest_digits() {
        let rows: [(f32, &str); 16] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-2.5, "-2.5"),
            (0.1, "0.1"),
            (1.0 / 30.0, "0.033333335"),
            (39.37, "39.37"),
            (3_937_000.0, "3937000"),
            (67_108_864.0, "67108864"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (0.000_001, "0.000001"),
            (0.000_000_1, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (f32::MAX, "3.4028235e+38"),
            (-800.0, "-800"),
        ];
        for (value, expected) in rows {
            assert_eq!(es_number(value), expected, "{value:e}");
        }
    }

    #[test]
    fn objects_sort_their_keys_by_byte_and_strings_escape_like_json_stringify() {
        let value = Canon::object([
            ("b", Canon::Num(1.0)),
            ("B", Canon::Str("q\"\\\n\u{01}".to_string())),
            ("a", Canon::numbers(&[0.5, -0.0])),
        ]);
        assert_eq!(value.write(), r#"{"B":"q\"\\\n\u0001","a":[0.5,0],"b":1}"#);
    }
}
