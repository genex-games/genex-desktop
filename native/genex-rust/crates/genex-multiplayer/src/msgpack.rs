//! A JSON-shaped msgpack codec over `serde_json::Value`, sized to the Genex wire rules (§1).
//!
//! - Integers that fit in 32 bits are written at the smallest width; every other number is a
//!   float64. The relay drops any payload holding an int64/uint64, so this encoder never writes one.
//! - Payloads must be finite JSON trees of at most 32 levels and 4096 nodes; `encode` refuses
//!   anything bigger rather than sending a message the relay will drop.
//! - On decode, the msgpack `undefined` extension (ext type 0, what msgpackr writes for an unset
//!   optional key) reads as an absent key; any other extension and binary read as `null`.

use serde_json::{Map, Number, Value};
use std::fmt;

use crate::protocol::limits;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    TooDeep,
    TooManyNodes,
    Truncated,
    InvalidUtf8,
    Unsupported(u8),
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodecError::TooDeep => write!(f, "payload nests deeper than {}", limits::MAX_JSON_DEPTH),
            CodecError::TooManyNodes => write!(f, "payload has more than {} nodes", limits::MAX_JSON_NODES),
            CodecError::Truncated => write!(f, "msgpack payload is truncated"),
            CodecError::InvalidUtf8 => write!(f, "msgpack string is not UTF-8"),
            CodecError::Unsupported(b) => write!(f, "unsupported msgpack byte 0x{b:02x}"),
        }
    }
}

impl std::error::Error for CodecError {}

/// Encode a JSON value as msgpack, enforcing the relay's shape bounds.
pub fn encode(value: &Value) -> Result<Vec<u8>, CodecError> {
    let mut out = Vec::with_capacity(64);
    let mut nodes = 0usize;
    write_value(&mut out, value, 1, &mut nodes)?;
    Ok(out)
}

fn write_value(out: &mut Vec<u8>, value: &Value, depth: usize, nodes: &mut usize) -> Result<(), CodecError> {
    if depth > limits::MAX_JSON_DEPTH {
        return Err(CodecError::TooDeep);
    }
    *nodes += 1;
    if *nodes > limits::MAX_JSON_NODES {
        return Err(CodecError::TooManyNodes);
    }
    match value {
        Value::Null => out.push(0xc0),
        Value::Bool(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_str(out, s),
        Value::Array(items) => {
            write_len(out, items.len(), 0x90, 0xdc, 0xdd);
            for item in items {
                write_value(out, item, depth + 1, nodes)?;
            }
        }
        Value::Object(map) => {
            write_len(out, map.len(), 0x80, 0xde, 0xdf);
            for (k, v) in map {
                write_str(out, k);
                write_value(out, v, depth + 1, nodes)?;
            }
        }
    }
    Ok(())
}

fn write_number(out: &mut Vec<u8>, n: &Number) {
    if let Some(i) = n.as_i64() {
        if (0..=u32::MAX as i64).contains(&i) {
            return write_uint(out, i as u64);
        }
        if (i32::MIN as i64..0).contains(&i) {
            return write_int(out, i);
        }
    } else if let Some(u) = n.as_u64() {
        if u <= u32::MAX as u64 {
            return write_uint(out, u);
        }
    }
    write_f64(out, n.as_f64().unwrap_or(0.0));
}

/// Always a float64 (0xcb): clocks and stamps go out this way, never as a 64-bit integer.
pub fn write_f64(out: &mut Vec<u8>, f: f64) {
    out.push(0xcb);
    out.extend_from_slice(&f.to_be_bytes());
}

fn write_uint(out: &mut Vec<u8>, u: u64) {
    if u < 0x80 {
        out.push(u as u8);
    } else if u <= 0xff {
        out.extend_from_slice(&[0xcc, u as u8]);
    } else if u <= 0xffff {
        out.push(0xcd);
        out.extend_from_slice(&(u as u16).to_be_bytes());
    } else {
        out.push(0xce);
        out.extend_from_slice(&(u as u32).to_be_bytes());
    }
}

fn write_int(out: &mut Vec<u8>, i: i64) {
    if i >= -32 {
        out.push(i as i8 as u8);
    } else if i >= i8::MIN as i64 {
        out.extend_from_slice(&[0xd0, i as i8 as u8]);
    } else if i >= i16::MIN as i64 {
        out.push(0xd1);
        out.extend_from_slice(&(i as i16).to_be_bytes());
    } else {
        out.push(0xd2);
        out.extend_from_slice(&(i as i32).to_be_bytes());
    }
}

/// Write a msgpack string.
pub fn write_str(out: &mut Vec<u8>, s: &str) {
    let len = s.len();
    if len < 32 {
        out.push(0xa0 | len as u8);
    } else if len <= 0xff {
        out.extend_from_slice(&[0xd9, len as u8]);
    } else if len <= 0xffff {
        out.push(0xda);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0xdb);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
    out.extend_from_slice(s.as_bytes());
}

fn write_len(out: &mut Vec<u8>, len: usize, fix: u8, m16: u8, m32: u8) {
    if len < 16 {
        out.push(fix | len as u8);
    } else if len <= 0xffff {
        out.push(m16);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(m32);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
}

/// Decode one msgpack value. Trailing bytes are ignored.
pub fn decode(bytes: &[u8]) -> Result<Value, CodecError> {
    let mut r = Reader { bytes, pos: 0 };
    Ok(r.read(0)?.unwrap_or(Value::Null))
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

/// Decode nesting guard: generous (the relay never sends more than 32 levels), only a stack bound.
const MAX_DECODE_DEPTH: usize = 128;

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], CodecError> {
        let end = self.pos.checked_add(n).ok_or(CodecError::Truncated)?;
        let slice = self.bytes.get(self.pos..end).ok_or(CodecError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }
    fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }
    fn be<const N: usize>(&mut self) -> Result<[u8; N], CodecError> {
        let mut a = [0u8; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }
    fn str(&mut self, len: usize) -> Result<String, CodecError> {
        let raw = self.take(len)?;
        String::from_utf8(raw.to_vec()).map_err(|_| CodecError::InvalidUtf8)
    }

    /// `None` = the msgpack `undefined` extension: an absent value.
    fn read(&mut self, depth: usize) -> Result<Option<Value>, CodecError> {
        if depth > MAX_DECODE_DEPTH {
            return Err(CodecError::TooDeep);
        }
        let b = self.u8()?;
        let v = match b {
            0x00..=0x7f => Value::from(b),
            0x80..=0x8f => self.map((b & 0x0f) as usize, depth)?,
            0x90..=0x9f => self.array((b & 0x0f) as usize, depth)?,
            0xa0..=0xbf => Value::String(self.str((b & 0x1f) as usize)?),
            0xc0 => Value::Null,
            0xc2 => Value::Bool(false),
            0xc3 => Value::Bool(true),
            0xc4..=0xc6 => {
                let len = self.len_of(b - 0xc4)?;
                self.take(len)?;
                Value::Null
            }
            0xc7..=0xc9 => {
                let len = self.len_of(b - 0xc7)?;
                return self.ext(len);
            }
            0xca => float(f32::from_be_bytes(self.be()?) as f64),
            0xcb => float(f64::from_be_bytes(self.be()?)),
            0xcc => Value::from(self.u8()?),
            0xcd => Value::from(u16::from_be_bytes(self.be()?)),
            0xce => Value::from(u32::from_be_bytes(self.be()?)),
            0xcf => Value::from(u64::from_be_bytes(self.be()?)),
            0xd0 => Value::from(self.u8()? as i8),
            0xd1 => Value::from(i16::from_be_bytes(self.be()?)),
            0xd2 => Value::from(i32::from_be_bytes(self.be()?)),
            0xd3 => Value::from(i64::from_be_bytes(self.be()?)),
            0xd4 => return self.ext(1),
            0xd5 => return self.ext(2),
            0xd6 => return self.ext(4),
            0xd7 => return self.ext(8),
            0xd8 => return self.ext(16),
            0xd9 => {
                let len = self.u8()? as usize;
                Value::String(self.str(len)?)
            }
            0xda => {
                let len = u16::from_be_bytes(self.be()?) as usize;
                Value::String(self.str(len)?)
            }
            0xdb => {
                let len = u32::from_be_bytes(self.be()?) as usize;
                Value::String(self.str(len)?)
            }
            0xdc => {
                let len = u16::from_be_bytes(self.be()?) as usize;
                self.array(len, depth)?
            }
            0xdd => {
                let len = u32::from_be_bytes(self.be()?) as usize;
                self.array(len, depth)?
            }
            0xde => {
                let len = u16::from_be_bytes(self.be()?) as usize;
                self.map(len, depth)?
            }
            0xdf => {
                let len = u32::from_be_bytes(self.be()?) as usize;
                self.map(len, depth)?
            }
            0xe0..=0xff => Value::from(b as i8),
            0xc1 => return Err(CodecError::Unsupported(b)),
        };
        Ok(Some(v))
    }

    /// Length prefix of a bin/ext family member: 0 = 8-bit, 1 = 16-bit, 2 = 32-bit.
    fn len_of(&mut self, width: u8) -> Result<usize, CodecError> {
        Ok(match width {
            0 => self.u8()? as usize,
            1 => u16::from_be_bytes(self.be()?) as usize,
            _ => u32::from_be_bytes(self.be()?) as usize,
        })
    }

    fn ext(&mut self, len: usize) -> Result<Option<Value>, CodecError> {
        let kind = self.u8()? as i8;
        self.take(len)?;
        Ok(if kind == 0 { None } else { Some(Value::Null) })
    }

    fn array(&mut self, len: usize, depth: usize) -> Result<Value, CodecError> {
        let mut items = Vec::with_capacity(len.min(1024));
        for _ in 0..len {
            items.push(self.read(depth + 1)?.unwrap_or(Value::Null));
        }
        Ok(Value::Array(items))
    }

    fn map(&mut self, len: usize, depth: usize) -> Result<Value, CodecError> {
        let mut map = Map::new();
        for _ in 0..len {
            let key = match self.read(depth + 1)? {
                Some(Value::String(s)) => s,
                Some(other) => other.to_string(),
                None => String::new(),
            };
            if let Some(v) = self.read(depth + 1)? {
                map.insert(key, v);
            }
        }
        Ok(Value::Object(map))
    }
}

fn float(f: f64) -> Value {
    Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_json_shapes() {
        let v =
            json!({"a": 1, "b": -5, "c": 1.5, "d": "héllo", "e": [true, false, null], "f": {"g": 300}, "h": -40000});
        assert_eq!(decode(&encode(&v).unwrap()).unwrap(), v);
    }

    #[test]
    fn never_writes_64_bit_integers() {
        // 2^40 and a negative beyond i32 go out as float64, never 0xcf / 0xd3.
        let big = encode(&json!(1u64 << 40)).unwrap();
        assert_eq!(big[0], 0xcb);
        let neg = encode(&json!(-(1i64 << 40))).unwrap();
        assert_eq!(neg[0], 0xcb);
        assert_eq!(encode(&json!(u32::MAX)).unwrap()[0], 0xce);
        assert_eq!(encode(&json!(i32::MIN)).unwrap()[0], 0xd2);
        assert_eq!(encode(&json!(7)).unwrap(), vec![7]);
        assert_eq!(encode(&json!(-1)).unwrap(), vec![0xff]);
    }

    #[test]
    fn ext0_reads_as_absent() {
        // {"a": undefined, "b": 1} as msgpackr writes it: fixmap(2), "a", fixext1 type 0, "b", 1.
        let bytes = [0x82, 0xa1, b'a', 0xd4, 0x00, 0x00, 0xa1, b'b', 0x01];
        assert_eq!(decode(&bytes).unwrap(), json!({"b": 1}));
        // In an array it is a hole, which JSON spells null.
        let arr = [0x92, 0xd4, 0x00, 0x00, 0x02];
        assert_eq!(decode(&arr).unwrap(), json!([null, 2]));
        // Another extension type is a value we cannot represent: null.
        let other = [0x81, 0xa1, b'x', 0xd4, 0x05, 0x00];
        assert_eq!(decode(&other).unwrap(), json!({"x": null}));
    }

    #[test]
    fn refuses_payloads_the_relay_drops() {
        let mut deep = json!(1);
        for _ in 0..40 {
            deep = json!([deep]);
        }
        assert_eq!(encode(&deep), Err(CodecError::TooDeep));
        let wide = Value::Array(vec![json!(0); 5000]);
        assert_eq!(encode(&wide), Err(CodecError::TooManyNodes));
    }

    #[test]
    fn long_strings_and_collections() {
        let s = "x".repeat(70_000);
        let v = json!({"s": s, "arr": (0..20).collect::<Vec<_>>()});
        assert_eq!(decode(&encode(&v).unwrap()).unwrap(), v);
        assert_eq!(decode(&[0xa3, b'a']), Err(CodecError::Truncated));
    }
}
