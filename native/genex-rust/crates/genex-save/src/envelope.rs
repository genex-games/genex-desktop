//! The save envelope: one slot's sections with the sim position they were read at, as canonical
//! JSON (serde_json with `preserve_order`, ryu floats, no whitespace, members in the documented
//! order) so the same state always gives the same bytes on every target. serde_json's default
//! float parser can land an ulp off the ryu text it wrote, so [`parse_document`] sets each float
//! back to core's correctly rounded parse of its own token: every finite float reads back to the
//! bits it was written from. A non-finite one has no JSON number and serialises as `null`.
//!
//! ```json
//! {"genex":"save","format":1,"schema":3,"game":"<save name>","tick":18000,"seed":7,
//!  "rng":["<u64 hex>","<u64 hex>"],"stateChecksum":"<fnv64 hex>","digest":"<fnv64 hex>",
//!  "sections":{"genex.nav":{..},"world":{..}},
//!  "meta":{"label":"Chapter 2","playMs":300000,"savedAtMs":null,"locale":"en","build":"<digest>"}}
//! ```
//!
//! `digest` is FNV-1a 64 of the canonical `{"schema","tick","seed","rng","sections"}`; `meta` is a
//! person's layer (label, wall clock, locale) outside the digest and the state checksum. A decode
//! accepts only the exact bytes [`encode`] writes: any other spelling of the same document (spacing,
//! `1E300` for `1e300`, a reordered member) is `save-corrupt`, so a changed byte never loads.

use std::io::{self, Write};

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from, hex64};
use serde_json::{Map, Number, Value};

use crate::codec;
use crate::error::{SaveError, SaveErrorCode};

/// The envelope format this build writes and reads.
pub const SAVE_FORMAT: u32 = 1;
/// The most sections one slot holds.
pub const SECTIONS_MAX: usize = 64;
/// The most bytes a section name holds.
pub const SECTION_NAME_MAX: usize = 48;
/// serde_json's recursion limit: a stored document is always shallower than this many nested
/// arrays and objects, so whatever [`encode`] writes, [`decode`] parses.
pub const NESTING_MAX: usize = 128;
/// The deepest nesting a section's value may have: the document's object and `sections` take two
/// levels, and serde_json refuses the 128th.
pub const SECTION_NESTING_MAX: usize = NESTING_MAX - 3;
/// The most characters a slot label holds.
pub const LABEL_CHARS_MAX: usize = 64;
/// The `genex` member's value: what marks the bytes as a save.
const SAVE_MARK: &str = "save";
/// The envelope's members, in the order they are written.
const MEMBERS: [&str; 11] =
    ["genex", "format", "schema", "game", "tick", "seed", "rng", "stateChecksum", "digest", "sections", "meta"];
/// The meta block's members, in the order they are written.
const META_MEMBERS: [&str; 5] = ["label", "playMs", "savedAtMs", "locale", "build"];
/// A digest or an rng part in the envelope: 16 lowercase hex digits.
const HEX64_CHARS: usize = 16;

/// The person's layer of a slot: shown in a slot list, never part of the state.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct SaveMeta {
    /// The label the slot list shows (at most [`LABEL_CHARS_MAX`] characters).
    pub label: String,
    /// Simulated play time in milliseconds.
    pub play_ms: u64,
    /// Wall-clock milliseconds since the Unix epoch, display only; None in Genex runs.
    pub saved_at_ms: Option<u64>,
    /// The locale the game ran in.
    pub locale: String,
    /// The build's digest.
    pub build: String,
}

/// One slot's contents.
#[derive(Clone, Debug, PartialEq)]
pub struct Envelope {
    /// The game's save schema the sections are written at (>= 1).
    pub schema: u32,
    /// The game's save name.
    pub game: String,
    /// The simulated tick the sections were read at.
    pub tick: u64,
    /// The run's seed.
    pub seed: u64,
    /// The sim rng's position (genex-core `Pcg32::parts`).
    pub rng: [u64; 2],
    /// The state checksum at `tick`, compared after a restore.
    pub state_checksum: u64,
    /// The named sections in registration order.
    pub sections: Map<String, Value>,
    /// The person's layer, outside the digest.
    pub meta: SaveMeta,
}

impl Envelope {
    /// FNV-1a 64 of the canonical `{"schema","tick","seed","rng","sections"}`.
    pub fn digest(&self) -> u64 {
        let mut hash = Fnv(FNV_OFFSET_BASIS);
        // An Fnv writer never fails, and a Map always serialises (its keys are strings).
        let _ = write_digest_input(&mut hash, self, Sections::Value(&self.sections));
        hash.0
    }
}

/// The stored bytes of `envelope` (deflated past `DEFLATE_ABOVE_BYTES`). Refuses
/// `save-section-invalid` for a section name, count or nesting past its cap, `save-slot-invalid`
/// for a label past [`LABEL_CHARS_MAX`], and `save-too-large` past 16 MiB.
pub fn encode(envelope: &Envelope) -> Result<Vec<u8>, SaveError> {
    check_sections(&envelope.sections).map_err(SaveError::section_invalid)?;
    if envelope.meta.label.chars().count() > LABEL_CHARS_MAX {
        return Err(SaveError::slot_invalid(format!("a slot label holds at most {LABEL_CHARS_MAX} characters")));
    }
    let sections = serde_json::to_vec(&envelope.sections).map_err(|e| SaveError::section_invalid(e.to_string()))?;
    let mut hash = Fnv(FNV_OFFSET_BASIS);
    let mut document = Vec::with_capacity(sections.len() + 512);
    let written = write_digest_input(&mut hash, envelope, Sections::Bytes(&sections))
        .and_then(|()| write_document(&mut document, envelope, hash.0, Sections::Bytes(&sections)));
    written.map_err(|e| SaveError::section_invalid(e.to_string()))?;
    codec::pack(document)
}

/// The envelope in `stored` bytes. Refuses `save-too-large` past 16 MiB, `save-format-unknown`
/// for bytes that are not a save of [`SAVE_FORMAT`], and `save-corrupt` for anything else that is
/// not exactly what [`encode`] writes, a digest mismatch included.
pub fn decode(stored: &[u8]) -> Result<Envelope, SaveError> {
    let json = codec::unpack(stored)?;
    let Value::Object(members) = parse_document(&json)? else {
        return Err(SaveError::new(SaveErrorCode::FormatUnknown, "not a genex save"));
    };
    if members.get("genex").and_then(Value::as_str) != Some(SAVE_MARK) {
        return Err(SaveError::new(SaveErrorCode::FormatUnknown, "not a genex save"));
    }
    if members.get("format").and_then(Value::as_u64) != Some(u64::from(SAVE_FORMAT)) {
        return Err(SaveError::new(SaveErrorCode::FormatUnknown, "a save format this build does not read"));
    }
    let (envelope, digest) = read_members(members).map_err(SaveError::corrupt)?;
    if envelope.digest() != digest {
        return Err(SaveError::corrupt("the digest does not match the sections"));
    }
    let mut compare = Compare { expected: &json, at: 0, equal: true };
    let rewritten = write_document(&mut compare, &envelope, digest, Sections::Value(&envelope.sections));
    if rewritten.is_err() || !compare.equal || compare.at != json.len() {
        return Err(SaveError::corrupt("the envelope is not in canonical form"));
    }
    Ok(envelope)
}

/// The JSON document in unpacked envelope bytes with every float exact: serde_json's default
/// parser can land an ulp off a float's text, so each one is set to core's correctly rounded
/// `str::parse::<f64>` of its own token. Refuses `save-corrupt` for bytes that are not JSON.
pub fn parse_document(json: &[u8]) -> Result<Value, SaveError> {
    let mut document: Value = serde_json::from_slice(json).map_err(|e| SaveError::corrupt(format!("not JSON: {e}")))?;
    exact_floats(json, &mut document);
    Ok(document)
}

/// Pairs `document`'s numbers with `json`'s number tokens in document order and sets each float
/// from its token (an integer serde_json holds as u64 or i64 is exact and stays). Only a document
/// with a duplicate member pairs them out of step, and the canonical compare refuses it anyway.
fn exact_floats(json: &[u8], document: &mut Value) {
    let mut tokens = NumberTokens { json, at: 0 };
    let mut stack: Vec<Box<dyn Iterator<Item = &mut Value> + '_>> = vec![Box::new(std::iter::once(document))];
    while let Some(top) = stack.last_mut() {
        let Some(value) = top.next() else {
            stack.pop();
            continue;
        };
        match value {
            Value::Array(items) => stack.push(Box::new(items.iter_mut())),
            Value::Object(map) => stack.push(Box::new(map.values_mut())),
            Value::Number(number) => {
                let token = tokens.next();
                if let Some(exact) = token.filter(|_| number.is_f64()).and_then(parse_float) {
                    *number = exact;
                }
            }
            _ => {}
        }
    }
}

/// The correctly rounded finite float a JSON number token spells, if it spells one.
fn parse_float(token: &[u8]) -> Option<Number> {
    std::str::from_utf8(token).ok()?.parse::<f64>().ok().and_then(Number::from_f64)
}

/// The number tokens of JSON text in document order, string contents and escapes skipped.
struct NumberTokens<'a> {
    json: &'a [u8],
    at: usize,
}

impl<'a> Iterator for NumberTokens<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        let number_byte = |byte: &u8| matches!(byte, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E');
        let mut in_string = false;
        while let Some(&byte) = self.json.get(self.at) {
            let start = self.at;
            self.at += 1;
            match byte {
                b'\\' if in_string => self.at += 1,
                b'"' => in_string = !in_string,
                b'-' | b'0'..=b'9' if !in_string => {
                    while self.json.get(self.at).is_some_and(number_byte) {
                        self.at += 1;
                    }
                    return self.json.get(start..self.at);
                }
                _ => {}
            }
        }
        None
    }
}

/// The envelope and its stored digest from a document's members, or what is wrong with them.
fn read_members(mut members: Map<String, Value>) -> Result<(Envelope, u64), String> {
    if let Some(unknown) = members.keys().find(|key| !MEMBERS.contains(&key.as_str())) {
        return Err(format!("unknown member {unknown:?}"));
    }
    let schema = u32::try_from(member_u64(&members, "schema")?).map_err(|_| "schema is past u32".to_owned())?;
    if schema == 0 {
        return Err("schema 0".to_owned());
    }
    let rng = match members.get("rng").and_then(Value::as_array).map(Vec::as_slice) {
        Some([a, b]) => [hex_part(a)?, hex_part(b)?],
        _ => return Err("rng is not two parts".to_owned()),
    };
    let Some(Value::Object(sections)) = members.remove("sections") else {
        return Err("sections is not an object".to_owned());
    };
    check_sections(&sections)?;
    let Some(Value::Object(meta)) = members.remove("meta") else {
        return Err("meta is not an object".to_owned());
    };
    let envelope = Envelope {
        schema,
        game: member_str(&members, "game")?,
        tick: member_u64(&members, "tick")?,
        seed: member_u64(&members, "seed")?,
        rng,
        state_checksum: hex_part(members.get("stateChecksum").unwrap_or(&Value::Null))?,
        sections,
        meta: read_meta(&meta)?,
    };
    let digest = hex_part(members.get("digest").unwrap_or(&Value::Null))?;
    Ok((envelope, digest))
}

fn read_meta(meta: &Map<String, Value>) -> Result<SaveMeta, String> {
    if let Some(unknown) = meta.keys().find(|key| !META_MEMBERS.contains(&key.as_str())) {
        return Err(format!("unknown meta member {unknown:?}"));
    }
    let saved_at_ms = match meta.get("savedAtMs") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or("savedAtMs is not a u64 or null")?),
        None => return Err("meta.savedAtMs is missing".to_owned()),
    };
    Ok(SaveMeta {
        label: member_str(meta, "label")?,
        play_ms: member_u64(meta, "playMs")?,
        saved_at_ms,
        locale: member_str(meta, "locale")?,
        build: member_str(meta, "build")?,
    })
}

fn member_u64(members: &Map<String, Value>, key: &str) -> Result<u64, String> {
    members.get(key).and_then(Value::as_u64).ok_or_else(|| format!("{key} is not a u64"))
}

fn member_str(members: &Map<String, Value>, key: &str) -> Result<String, String> {
    members.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(|| format!("{key} is not a string"))
}

/// A u64 written as [`HEX64_CHARS`] lowercase hex digits.
fn hex_part(value: &Value) -> Result<u64, String> {
    let text = value.as_str().unwrap_or_default();
    let digits = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
    if text.len() != HEX64_CHARS || !text.bytes().all(digits) {
        return Err(format!("{value} is not 16 lowercase hex digits"));
    }
    u64::from_str_radix(text, 16).map_err(|e| e.to_string())
}

/// Whether a section name is 1 to [`SECTION_NAME_MAX`] of ASCII letters, digits, `.`, `_`, `-`.
fn section_name_ok(name: &str) -> bool {
    let alphabet = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-');
    !name.is_empty() && name.len() <= SECTION_NAME_MAX && name.bytes().all(alphabet)
}

/// What is wrong with `sections`, if anything: their count, a name, or a value's nesting.
fn check_sections(sections: &Map<String, Value>) -> Result<(), String> {
    if sections.len() > SECTIONS_MAX {
        return Err(format!("a slot holds at most {SECTIONS_MAX} sections"));
    }
    if let Some(name) = sections.keys().find(|name| !section_name_ok(name)) {
        return Err(format!("section name {name:?} is not 1 to {SECTION_NAME_MAX} of A-Z, a-z, 0-9, '.', '_', '-'"));
    }
    match sections.iter().find(|(_, value)| nesting_past(value, SECTION_NESTING_MAX)) {
        Some((name, _)) => Err(format!("section {name:?} nests deeper than {SECTION_NESTING_MAX}")),
        None => Ok(()),
    }
}

/// Whether `value` nests more than `limit` arrays and objects deep (walked without recursion).
fn nesting_past(value: &Value, limit: usize) -> bool {
    let mut stack: Vec<(&Value, usize)> = vec![(value, 0)];
    while let Some((item, depth)) = stack.pop() {
        let children: Box<dyn Iterator<Item = &Value>> = match item {
            Value::Array(items) => Box::new(items.iter()),
            Value::Object(map) => Box::new(map.values()),
            _ => continue,
        };
        if depth + 1 > limit {
            return true;
        }
        stack.extend(children.map(|child| (child, depth + 1)));
    }
    false
}

/// A slot's sections, as serialised bytes (encode) or as the value (decode, digest).
#[derive(Clone, Copy)]
enum Sections<'a> {
    Bytes(&'a [u8]),
    Value(&'a Map<String, Value>),
}

fn write_sections<W: Write>(out: &mut W, sections: Sections<'_>) -> io::Result<()> {
    match sections {
        Sections::Bytes(bytes) => out.write_all(bytes),
        Sections::Value(map) => serde_json::to_writer(out, map).map_err(io::Error::other),
    }
}

/// The bytes [`Envelope::digest`] hashes.
fn write_digest_input<W: Write>(out: &mut W, envelope: &Envelope, sections: Sections<'_>) -> io::Result<()> {
    let [a, b] = envelope.rng;
    write!(out, r#"{{"schema":{},"tick":{},"seed":{},"#, envelope.schema, envelope.tick, envelope.seed)?;
    write!(out, r#""rng":["{}","{}"],"sections":"#, hex64(a), hex64(b))?;
    write_sections(out, sections)?;
    out.write_all(b"}")
}

/// The canonical document.
fn write_document<W: Write>(out: &mut W, envelope: &Envelope, digest: u64, sections: Sections<'_>) -> io::Result<()> {
    let [a, b] = envelope.rng;
    let meta = &envelope.meta;
    let saved_at = meta.saved_at_ms.map_or_else(|| "null".to_owned(), |ms| ms.to_string());
    write!(out, r#"{{"genex":"{SAVE_MARK}","format":{SAVE_FORMAT},"schema":{},"game":"#, envelope.schema)?;
    serde_json::to_writer(&mut *out, &envelope.game).map_err(io::Error::other)?;
    write!(out, r#","tick":{},"seed":{},"rng":["{}","{}"],"#, envelope.tick, envelope.seed, hex64(a), hex64(b))?;
    write!(out, r#""stateChecksum":"{}","digest":"{}","sections":"#, hex64(envelope.state_checksum), hex64(digest))?;
    write_sections(out, sections)?;
    out.write_all(br#","meta":{"label":"#)?;
    serde_json::to_writer(&mut *out, &meta.label).map_err(io::Error::other)?;
    write!(out, r#","playMs":{},"savedAtMs":{saved_at},"locale":"#, meta.play_ms)?;
    serde_json::to_writer(&mut *out, &meta.locale).map_err(io::Error::other)?;
    out.write_all(br#","build":"#)?;
    serde_json::to_writer(&mut *out, &meta.build).map_err(io::Error::other)?;
    out.write_all(b"}}")
}

/// A writer that FNV-1a 64 hashes what it is given.
struct Fnv(u64);

impl Write for Fnv {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = fnv1a64_from(bytes, self.0);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A writer that compares what it is given with `expected`, allocating nothing.
struct Compare<'a> {
    expected: &'a [u8],
    at: usize,
    equal: bool,
}

impl Write for Compare<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self.at + bytes.len();
        self.equal = self.equal && self.expected.get(self.at..end) == Some(bytes);
        self.at = end;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
