//! The runtime's own JSON value, reader and writer, ported from the C++ template's `json.h`: the
//! studio protocol, `state()` and the checksum speak it. Objects keep their members in insertion
//! order (a repeated key replaces the value where it first stood), strings are bytes exactly as
//! the text carried them, and numbers are written in the C++ writer's form (`%.0f` for integers
//! below 1e15, else the shortest of `%.15g`..`%.17g` that reads back), so a checksum taken over a
//! dump is the same byte string the C++ runtime hashed.

use std::ops::Index;

/// The deepest nesting a parse accepts by default; the protocol refuses anything deeper.
pub const MAX_DEPTH: usize = 32;

/// Integers below this magnitude are written without a fraction or exponent.
const PLAIN_INTEGER_LIMIT: f64 = 1e15;
/// Significant digits tried, in order, for the shortest form that reads back exactly.
const SHORTEST_PRECISION: usize = 15;
const EXACT_PRECISION: usize = 17;
/// What a `\u` escape naming half a surrogate pair becomes.
const REPLACEMENT_CHARACTER: u32 = 0xFFFD;

/// One JSON value. Strings and keys are bytes: a hostile text's invalid UTF-8 is kept, as the
/// C++ reader keeps it, so a reply echoes exactly what it was sent.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Value {
    /// `null`, and what any absent lookup answers.
    #[default]
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// Every number is a double, as in JavaScript.
    Number(f64),
    /// A string's bytes.
    String(Vec<u8>),
    /// An array.
    Array(Vec<Value>),
    /// An object's members, in insertion order.
    Object(Vec<(Vec<u8>, Value)>),
}

/// Why a text did not parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    /// Not JSON.
    #[error("not JSON")]
    Syntax,
    /// Nested deeper than the limit.
    #[error("nested too deep")]
    TooDeep,
}

static NULL: Value = Value::Null;

impl Value {
    /// An empty object.
    pub fn object() -> Value {
        Value::Object(Vec::new())
    }

    /// An empty array.
    pub fn array() -> Value {
        Value::Array(Vec::new())
    }

    /// Whether this is `null`.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// The boolean, or false for any other kind.
    pub fn as_bool(&self) -> bool {
        self.as_bool_or(false)
    }

    /// The boolean, or `fallback` for any other kind.
    pub fn as_bool_or(&self, fallback: bool) -> bool {
        match self {
            Value::Bool(flag) => *flag,
            _ => fallback,
        }
    }

    /// The number, or 0 for any other kind.
    pub fn as_f64(&self) -> f64 {
        self.as_f64_or(0.0)
    }

    /// The number, or `fallback` for any other kind.
    pub fn as_f64_or(&self, fallback: f64) -> f64 {
        match self {
            Value::Number(number) => *number,
            _ => fallback,
        }
    }

    /// The string's bytes, or none for any other kind.
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Value::String(bytes) => bytes,
            _ => &[],
        }
    }

    /// The string, or "" for any other kind and for a string that is not UTF-8.
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(self.as_bytes()).unwrap_or("")
    }

    /// The items of an array; none for any other kind.
    pub fn items(&self) -> &[Value] {
        match self {
            Value::Array(items) => items,
            _ => &[],
        }
    }

    /// The members of an object; none for any other kind.
    pub fn members(&self) -> &[(Vec<u8>, Value)] {
        match self {
            Value::Object(members) => members,
            _ => &[],
        }
    }

    /// The value of `key` in an object, or none when absent or when this is not an object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.get_bytes(key.as_bytes())
    }

    /// [`Value::get`] by a key's bytes.
    pub fn get_bytes(&self, key: &[u8]) -> Option<&Value> {
        // The last one, as JSON.parse decides duplicates (a parse already keeps only one).
        self.members().iter().rev().find(|(name, _)| name == key).map(|(_, value)| value)
    }

    /// Set `key`, replacing an existing one where it stands; anything not an object becomes one.
    pub fn set(&mut self, key: impl Into<Vec<u8>>, value: Value) -> &mut Value {
        let key = key.into();
        if !matches!(self, Value::Object(_)) {
            *self = Value::object();
        }
        let Value::Object(members) = self else { unreachable!("made an object above") };
        let at = match members.iter().position(|(name, _)| *name == key) {
            Some(at) => {
                members[at].1 = value;
                at
            }
            None => {
                members.push((key, value));
                members.len() - 1
            }
        };
        &mut members[at].1
    }

    /// Append to an array; anything not an array becomes one.
    pub fn push(&mut self, value: Value) -> &mut Value {
        if !matches!(self, Value::Array(_)) {
            *self = Value::array();
        }
        let Value::Array(items) = self else { unreachable!("made an array above") };
        items.push(value);
        let last = items.len() - 1;
        &mut items[last]
    }

    /// Compact JSON text. NaN and infinities are written as null.
    pub fn dump(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.dump_to(&mut out);
        out
    }

    /// Write compact JSON text onto `out`.
    pub fn dump_to(&self, out: &mut Vec<u8>) {
        match self {
            Value::Null => out.extend_from_slice(b"null"),
            Value::Bool(flag) => out.extend_from_slice(if *flag { b"true" } else { b"false" }),
            Value::Number(number) => out.extend_from_slice(format_number(*number).as_bytes()),
            Value::String(bytes) => append_quoted(out, bytes),
            Value::Array(items) => {
                out.push(b'[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    item.dump_to(out);
                }
                out.push(b']');
            }
            Value::Object(members) => {
                out.push(b'{');
                for (i, (key, value)) in members.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    append_quoted(out, key);
                    out.push(b':');
                    value.dump_to(out);
                }
                out.push(b'}');
            }
        }
    }
}

impl Index<&str> for Value {
    type Output = Value;

    /// The value of `key`, or a shared null when absent or when this is not an object.
    fn index(&self, key: &str) -> &Value {
        self.get(key).unwrap_or(&NULL)
    }
}

impl From<bool> for Value {
    fn from(flag: bool) -> Value {
        Value::Bool(flag)
    }
}

impl From<f64> for Value {
    fn from(number: f64) -> Value {
        Value::Number(number)
    }
}

impl From<f32> for Value {
    fn from(number: f32) -> Value {
        Value::Number(f64::from(number))
    }
}

impl From<i32> for Value {
    fn from(number: i32) -> Value {
        Value::Number(f64::from(number))
    }
}

impl From<u32> for Value {
    fn from(number: u32) -> Value {
        Value::Number(f64::from(number))
    }
}

impl From<u64> for Value {
    /// As a double, the way JavaScript and the C++ runtime hold every number.
    fn from(number: u64) -> Value {
        Value::Number(number as f64)
    }
}

impl From<i64> for Value {
    /// As a double, the way JavaScript and the C++ runtime hold every number.
    fn from(number: i64) -> Value {
        Value::Number(number as f64)
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Value {
        Value::String(text.as_bytes().to_vec())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Value {
        Value::String(text.into_bytes())
    }
}

/// The largest integer a double holds exactly (2^53): below it a whole number reads back as an
/// integer in serde, as JavaScript prints it.
const EXACT_INTEGER: f64 = 9_007_199_254_740_992.0;

impl From<&Value> for serde_json::Value {
    /// A protocol value as serde's: whole numbers below 2^53 as integers, other finite numbers as
    /// doubles, anything not finite as null (the C++ writer's `null`), invalid UTF-8 replaced.
    fn from(value: &Value) -> serde_json::Value {
        match value {
            Value::Null => serde_json::Value::Null,
            Value::Bool(flag) => serde_json::Value::Bool(*flag),
            Value::Number(number) => serde_number(*number),
            Value::String(bytes) => serde_json::Value::String(String::from_utf8_lossy(bytes).into_owned()),
            Value::Array(items) => serde_json::Value::Array(items.iter().map(serde_json::Value::from).collect()),
            Value::Object(members) => serde_json::Value::Object(
                members
                    .iter()
                    .map(|(key, member)| (String::from_utf8_lossy(key).into_owned(), serde_json::Value::from(member)))
                    .collect(),
            ),
        }
    }
}

fn serde_number(number: f64) -> serde_json::Value {
    let whole = number.trunc() == number && number.abs() < EXACT_INTEGER;
    if whole && number >= 0.0 {
        // Whole and below 2^53: exact as an integer.
        return serde_json::Value::from(number as u64);
    }
    if whole {
        return serde_json::Value::from(number as i64);
    }
    serde_json::Number::from_f64(number).map_or(serde_json::Value::Null, serde_json::Value::Number)
}

impl From<&serde_json::Value> for Value {
    /// A serde value member for member; a number becomes its double.
    fn from(value: &serde_json::Value) -> Value {
        match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(flag) => Value::Bool(*flag),
            serde_json::Value::Number(number) => Value::Number(number.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(text) => Value::from(text.as_str()),
            serde_json::Value::Array(items) => Value::Array(items.iter().map(Value::from).collect()),
            serde_json::Value::Object(members) => {
                let mut out = Value::object();
                for (key, member) in members {
                    out.set(key.as_str(), Value::from(member));
                }
                out
            }
        }
    }
}

/// Parse one complete JSON text (surrounding whitespace allowed), nested at most [`MAX_DEPTH`].
pub fn parse(text: &[u8]) -> Result<Value, ParseError> {
    parse_with_depth(text, MAX_DEPTH)
}

/// Parse one complete JSON text, refusing nesting past `max_depth`.
pub fn parse_with_depth(text: &[u8], max_depth: usize) -> Result<Value, ParseError> {
    let mut reader = Reader { text, at: 0, max_depth };
    reader.skip_space();
    let value = reader.value(0)?;
    reader.skip_space();
    if reader.at != text.len() {
        return Err(ParseError::Syntax);
    }
    Ok(value)
}

/// `text` as a JSON string literal, quotes included.
pub fn quote(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    append_quoted(&mut out, text);
    out
}

/// The C++ writer's form of `number`: "null" when not finite, `%.0f` for an integer below 1e15,
/// else the shortest of `%.15g`, `%.16g` and `%.17g` that reads back exactly.
pub fn format_number(number: f64) -> String {
    if !number.is_finite() {
        return "null".to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    if number.trunc() == number && number.abs() < PLAIN_INTEGER_LIMIT {
        return format!("{number:.0}");
    }
    let mut text = String::new();
    for precision in SHORTEST_PRECISION..=EXACT_PRECISION {
        text = format_g(number, precision);
        if text.parse::<f64>().ok() == Some(number) {
            break;
        }
    }
    text
}

/// C's `%.<precision>g` for a finite, non-zero `number`.
fn format_g(number: f64, precision: usize) -> String {
    // `{:.Ne}` rounds to N + 1 significant digits exactly, as printf does; its exponent is the one
    // %g decides the notation by.
    let scientific = format!("{number:.prec$e}", prec = precision - 1);
    let (mantissa, exponent) = scientific.split_once('e').expect("LowerExp writes an exponent");
    let exponent: i32 = exponent.parse().expect("LowerExp writes a decimal exponent");
    let precision = precision as i32;
    if exponent < -4 || exponent >= precision {
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!("{}e{sign}{:02}", strip_fraction_zeros(mantissa), exponent.unsigned_abs());
    }
    let decimals = (precision - 1 - exponent) as usize;
    strip_fraction_zeros(&format!("{number:.decimals$}")).to_owned()
}

/// %g's trimming: trailing zeros of a fraction go, and the point with them when nothing is left.
fn strip_fraction_zeros(text: &str) -> &str {
    if !text.contains('.') {
        return text;
    }
    text.trim_end_matches('0').trim_end_matches('.')
}

fn append_quoted(out: &mut Vec<u8>, text: &[u8]) {
    out.push(b'"');
    for &byte in text {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0C => out.extend_from_slice(b"\\f"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            byte if byte < 0x20 => out.extend_from_slice(format!("\\u{byte:04x}").as_bytes()),
            byte => out.push(byte),
        }
    }
    out.push(b'"');
}

/// Append the UTF-8 bytes of `code` (any value below 0x110000; surrogates already replaced).
fn append_utf8(out: &mut Vec<u8>, code: u32) {
    let mut buffer = [0; 4];
    let character = char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER);
    out.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
}

fn is_high_surrogate(code: u32) -> bool {
    (0xD800..=0xDBFF).contains(&code)
}

fn is_low_surrogate(code: u32) -> bool {
    (0xDC00..=0xDFFF).contains(&code)
}

/// A recursive-descent reader whose recursion is bounded by the depth limit.
struct Reader<'a> {
    text: &'a [u8],
    at: usize,
    max_depth: usize,
}

type Read<T> = Result<T, ParseError>;

impl Reader<'_> {
    fn peek(&self) -> u8 {
        self.text.get(self.at).copied().unwrap_or(0)
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), b' ' | b'\t' | b'\n' | b'\r') {
            self.at += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Read<Value> {
        match self.peek() {
            b'{' => self.object(depth + 1),
            b'[' => self.array(depth + 1),
            b'"' => Ok(Value::String(self.string()?)),
            b't' => self.literal(b"true", Value::Bool(true)),
            b'f' => self.literal(b"false", Value::Bool(false)),
            b'n' => self.literal(b"null", Value::Null),
            _ => self.number(),
        }
    }

    fn literal(&mut self, word: &[u8], result: Value) -> Read<Value> {
        if !self.text[self.at..].starts_with(word) {
            return Err(ParseError::Syntax);
        }
        self.at += word.len();
        Ok(result)
    }

    fn digits(&mut self) -> bool {
        let start = self.at;
        while self.peek().is_ascii_digit() {
            self.at += 1;
        }
        self.at > start
    }

    fn number(&mut self) -> Read<Value> {
        let start = self.at;
        if self.peek() == b'-' {
            self.at += 1;
        }
        if self.peek() == b'0' {
            self.at += 1;
        } else if !self.digits() {
            return Err(ParseError::Syntax);
        }
        if self.peek() == b'.' {
            self.at += 1;
            if !self.digits() {
                return Err(ParseError::Syntax);
            }
        }
        if matches!(self.peek(), b'e' | b'E') {
            self.at += 1;
            if matches!(self.peek(), b'+' | b'-') {
                self.at += 1;
            }
            if !self.digits() {
                return Err(ParseError::Syntax);
            }
        }
        // The token is validated JSON number text, which Rust reads correctly rounded as strtod
        // does (an overflow is an infinity, an underflow a zero).
        let token = std::str::from_utf8(&self.text[start..self.at]).map_err(|_| ParseError::Syntax)?;
        token.parse::<f64>().map(Value::Number).map_err(|_| ParseError::Syntax)
    }

    fn hex4(&mut self) -> Read<u32> {
        let digits = self.text.get(self.at..self.at + 4).ok_or(ParseError::Syntax)?;
        let mut code = 0;
        for &digit in digits {
            self.at += 1;
            let value = char::from(digit).to_digit(16).ok_or(ParseError::Syntax)?;
            code = code * 16 + value;
        }
        Ok(code)
    }

    /// A `\u` escape, with a following low surrogate folded in; half a pair becomes U+FFFD.
    fn unicode_escape(&mut self, out: &mut Vec<u8>) -> Read<()> {
        let code = self.hex4()?;
        let pair_follows = is_high_surrogate(code) && self.text[self.at..].starts_with(b"\\u");
        if pair_follows {
            let mark = self.at;
            self.at += 2;
            let low = self.hex4()?;
            if is_low_surrogate(low) {
                append_utf8(out, 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00));
                return Ok(());
            }
            self.at = mark;
        }
        let lone = is_high_surrogate(code) || is_low_surrogate(code);
        append_utf8(out, if lone { REPLACEMENT_CHARACTER } else { code });
        Ok(())
    }

    fn escape(&mut self, out: &mut Vec<u8>) -> Read<()> {
        let byte = self.peek();
        self.at += 1;
        match byte {
            b'"' | b'\\' | b'/' => out.push(byte),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0C),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'u' => self.unicode_escape(out)?,
            _ => return Err(ParseError::Syntax),
        }
        Ok(())
    }

    fn string(&mut self) -> Read<Vec<u8>> {
        self.at += 1; // the opening quote
        let mut out = Vec::new();
        loop {
            let &byte = self.text.get(self.at).ok_or(ParseError::Syntax)?;
            self.at += 1;
            match byte {
                b'"' => return Ok(out),
                byte if byte < 0x20 => return Err(ParseError::Syntax),
                b'\\' => self.escape(&mut out)?,
                byte => out.push(byte),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Read<Value> {
        if depth > self.max_depth {
            return Err(ParseError::TooDeep);
        }
        self.at += 1;
        let mut out = Value::array();
        self.skip_space();
        if self.peek() == b']' {
            self.at += 1;
            return Ok(out);
        }
        loop {
            self.skip_space();
            let item = self.value(depth)?;
            out.push(item);
            self.skip_space();
            match self.peek() {
                b']' => {
                    self.at += 1;
                    return Ok(out);
                }
                b',' => self.at += 1,
                _ => return Err(ParseError::Syntax),
            }
        }
    }

    fn member(&mut self, out: &mut Value, depth: usize) -> Read<()> {
        self.skip_space();
        if self.peek() != b'"' {
            return Err(ParseError::Syntax);
        }
        let key = self.string()?;
        self.skip_space();
        if self.peek() != b':' {
            return Err(ParseError::Syntax);
        }
        self.at += 1;
        self.skip_space();
        let item = self.value(depth)?;
        out.set(key, item);
        Ok(())
    }

    fn object(&mut self, depth: usize) -> Read<Value> {
        if depth > self.max_depth {
            return Err(ParseError::TooDeep);
        }
        self.at += 1;
        let mut out = Value::object();
        self.skip_space();
        if self.peek() == b'}' {
            self.at += 1;
            return Ok(out);
        }
        loop {
            self.member(&mut out, depth)?;
            self.skip_space();
            match self.peek() {
                b'}' => {
                    self.at += 1;
                    return Ok(out);
                }
                b',' => self.at += 1,
                _ => return Err(ParseError::Syntax),
            }
        }
    }
}
