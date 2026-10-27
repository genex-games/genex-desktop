//! One room tick in one crossing, in a binary form both shells share: the WASM export
//! `world_tick_frame` and the native sidecar's `Tick` frame (protocol 2). The TypeScript wrapper
//! (`genex-physics/js/core.js`, `encodeTick` and `readTick`) writes the request and reads the
//! reply; `tickWorld`'s result is exactly what `apply(batch, "each")` per batch, `step()`,
//! `exportChanged(exportSince)` and `queryMany(queries)` return, so every number and every string
//! here crosses as those calls' JSON text would have carried it.
//!
//! All little-endian. `str` is a `u32` byte length, then UTF-8.
//!
//! **Request**: `u32 n` (at most [`TICK_BATCHES_MAX`]), `n × item` (each batch, a JSON array of
//! commands), `bool step`, `f64 exportSince` (not NaN; any negative number exports nothing),
//! `bool queries`, then the queries' `item` when set.
//!
//! An `item` is one input the JSON calls take as text, in one of three forms (`u8` first):
//! - 0, a value: the tree `JSON.parse` would give for its text (below);
//! - 1, JSON text (`str`): read as the JSON calls read their text (the wrapper's own fallback for an
//!   input it could not judge without its text, see core.js);
//! - 2, a value that has no JSON text: a value as in 0 that held a string JSON cannot carry (a lone
//!   UTF-16 surrogate). Its text would not parse, so it is refused as that text is
//!   (`bad-command`, "the input is not JSON"), after its bytes are read whole.
//!
//! A value is a tag `u8`: 0 `null`, 1 `false`, 2 `true`, 3 a number (`f64`, finite: the wrapper
//! sends NaN and ±Infinity as ±1e39, as its text does), 4 a string (`str`), 5 an array (`u32`
//! count, then each value), 6 an object (`u32` count, then each member's name `str` and value, no
//! name twice). Nesting deeper than [`VALUE_DEPTH_MAX`] is refused. A number becomes the JSON
//! number its text would parse to (`json_number`), so the core reads exactly what it read from the
//! text.
//!
//! **Reply**: `u32 n`, one `batch` per batch; `u8` step: 0 none, 1 `failure`, 2 a step (`f64 tick`,
//! `u32` count of `event`, `bool overflowed`, `u32` count of escaped key `str`, `bool
//! memoryExceeded`); `bool exported` and, when set, `u32` count of key `str` and `u32` count of
//! `f32` data; `u8` answers: 0 none, 1 `failure`, 2 `u32` count of `answer`; then `f64 tick` and
//! `f64 memoryBytes`.
//! - `batch`: `u8` 0 then `failure` (the batch refused whole), or 1 then `u32` count of results,
//!   each `u8` 0 (ok) or 1 then its code `str`.
//! - `failure`: code `str`, `bool` index and its `f64`, detail `str`.
//! - `event`: `u8` kind (0 contactBegin, 1 contactEnd, 2 triggerEnter, 3 triggerExit), its four keys
//!   `str` in its JSON order, its two optional kinds (`bool`, then `str`), and for contactBegin
//!   `f64 impulse` and six `f64` (point, normal).
//! - `answer`: `u8` 0 then `failure`, 1 (no hit), 2 a hit (`str body`, `str collider`, `f64 dist`,
//!   six `f64`), or 3 then `u32` count of key `str`.
//!
//! Every reply number is the f64 its JSON text names (a non-finite one stands for that text's
//! `null`), and the wrapper builds each object with its JSON text's members in the same order.

use genex_physics::{ChangedExport, CommandOutcome, PhysicsEvent, PhysicsFailure, QueryAnswer, QueryOutcome, StepResult};
use serde_json::{Map, Number, Value};

/// The most command batches one tick carries (core.js `TICK_BATCHES_MAX`).
pub const TICK_BATCHES_MAX: u32 = 64;
/// The deepest a value nests (the wrapper sends at most 33 levels: `MAX_DEPTH` below a batch).
pub const VALUE_DEPTH_MAX: usize = 64;
/// The detail of an input whose text would not have parsed (genex-physics-binding `input::json`).
pub(crate) const NOT_JSON: &str = "the input is not JSON";

/// Item forms.
const ITEM_VALUE: u8 = 0;
const ITEM_TEXT: u8 = 1;
const ITEM_NO_TEXT: u8 = 2;
/// Value tags.
const TAG_NULL: u8 = 0;
const TAG_FALSE: u8 = 1;
const TAG_TRUE: u8 = 2;
const TAG_NUMBER: u8 = 3;
const TAG_STRING: u8 = 4;
const TAG_ARRAY: u8 = 5;
const TAG_OBJECT: u8 = 6;
/// Reply forms.
const STEP_NONE: u8 = 0;
const STEP_FAILURE: u8 = 1;
const STEP_DONE: u8 = 2;
const BATCH_FAILURE: u8 = 0;
const BATCH_RESULTS: u8 = 1;
const ANSWERS_NONE: u8 = 0;
const ANSWERS_FAILURE: u8 = 1;
const ANSWERS_DONE: u8 = 2;
const ANSWER_FAILURE: u8 = 0;
const ANSWER_NO_HIT: u8 = 1;
const ANSWER_HIT: u8 = 2;
const ANSWER_KEYS: u8 = 3;
const EVENT_CONTACT_BEGIN: u8 = 0;
const EVENT_CONTACT_END: u8 = 1;
const EVENT_TRIGGER_ENTER: u8 = 2;
const EVENT_TRIGGER_EXIT: u8 = 3;
/// The smallest bytes an array element (a tag) and an object member (a name length and a tag) take:
/// a count is checked against what is left before anything is allocated.
const ELEMENT_BYTES_MIN: usize = 1;
const MEMBER_BYTES_MIN: usize = 5;
/// The largest integer JSON text a JS number prints without an exponent, exclusive (ECMA-262
/// Number::toString), and the u64 and i64 ranges serde_json reads integer text into.
const PLAIN_INTEGER_LIMIT: f64 = 1e21;
const U64_END: f64 = 18_446_744_073_709_551_616.0;
const I64_MIN: f64 = -9_223_372_036_854_775_808.0;

/// Why a tick request could not be read: the sidecar ends on it (a protocol fault), the WASM
/// export answers no reply (which poisons the instance, as a trap does).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickFault {
    /// A field ran past the request's end.
    Short,
    /// Bytes left over after the last field.
    Trailing(usize),
    /// A flag other than 0 or 1.
    BadFlag(u8),
    /// An item form or a value tag this format does not name.
    BadTag(u8),
    /// A string that is not UTF-8.
    BadUtf8,
    /// A NaN or infinite number (a value), or a NaN `exportSince`.
    BadNumber,
    /// More than [`TICK_BATCHES_MAX`] batches.
    TooManyBatches(u32),
    /// A value nested deeper than [`VALUE_DEPTH_MAX`].
    TooDeep,
    /// An object naming one member twice.
    DuplicateName,
}

/// One input as it crossed (see the module header).
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// The value its JSON text parses to.
    Value(Value),
    /// JSON text, read as the JSON calls read it.
    Text(String),
    /// A value whose JSON text would not parse.
    NoText,
}

impl Item {
    /// The value, as the JSON calls read their text (`input::json`).
    pub(crate) fn read(self) -> Result<Value, PhysicsFailure> {
        match self {
            Item::Value(value) => Ok(value),
            Item::Text(text) => crate::input::json(&text),
            Item::NoText => Err(PhysicsFailure::new(genex_physics::PhysicsError::BadCommand, NOT_JSON)),
        }
    }
}

/// A tick request, read whole before anything of it runs.
#[derive(Clone, Debug, PartialEq)]
pub struct TickRequest {
    /// Command batches, each applied in `"each"` mode, in order (§7.1).
    pub batches: Vec<Item>,
    /// Whether to step after the batches (§8).
    pub step: bool,
    /// Export the bodies changed after this tick (§9.1); any negative number exports nothing.
    pub export_since: f64,
    /// A `queryMany` after the export (§19.2).
    pub queries: Option<Item>,
}

/// A cursor over a request.
struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], TickFault> {
        let Some((head, tail)) = self.rest.split_at_checked(count) else { return Err(TickFault::Short) };
        self.rest = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, TickFault> {
        Ok(self.take(1)?[0])
    }

    fn flag(&mut self) -> Result<bool, TickFault> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(TickFault::BadFlag(other)),
        }
    }

    fn u32(&mut self) -> Result<u32, TickFault> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn f64(&mut self) -> Result<f64, TickFault> {
        let bytes = self.take(8)?;
        let mut out = [0u8; 8];
        out.copy_from_slice(bytes);
        Ok(f64::from_le_bytes(out))
    }

    /// A count of items of at least `width` bytes each, checked against what is left.
    fn count(&mut self, width: usize) -> Result<usize, TickFault> {
        let count = self.u32()? as usize;
        if count.checked_mul(width).is_none_or(|bytes| bytes > self.rest.len()) {
            return Err(TickFault::Short);
        }
        Ok(count)
    }

    fn str(&mut self) -> Result<&'a str, TickFault> {
        let length = self.count(1)?;
        std::str::from_utf8(self.take(length)?).map_err(|_| TickFault::BadUtf8)
    }

    fn item(&mut self) -> Result<Item, TickFault> {
        match self.u8()? {
            ITEM_VALUE => Ok(Item::Value(self.value(0)?)),
            ITEM_TEXT => Ok(Item::Text(self.str()?.to_string())),
            ITEM_NO_TEXT => {
                self.value(0)?;
                Ok(Item::NoText)
            }
            other => Err(TickFault::BadTag(other)),
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, TickFault> {
        if depth > VALUE_DEPTH_MAX {
            return Err(TickFault::TooDeep);
        }
        match self.u8()? {
            TAG_NULL => Ok(Value::Null),
            TAG_FALSE => Ok(Value::Bool(false)),
            TAG_TRUE => Ok(Value::Bool(true)),
            TAG_NUMBER => {
                let number = self.f64()?;
                if !number.is_finite() {
                    return Err(TickFault::BadNumber);
                }
                Ok(json_number(number))
            }
            TAG_STRING => Ok(Value::String(self.str()?.to_string())),
            TAG_ARRAY => {
                let count = self.count(ELEMENT_BYTES_MIN)?;
                let mut items = Vec::with_capacity(count);
                for _ in 0..count {
                    items.push(self.value(depth + 1)?);
                }
                Ok(Value::Array(items))
            }
            TAG_OBJECT => {
                let count = self.count(MEMBER_BYTES_MIN)?;
                let mut members = Map::new();
                for _ in 0..count {
                    let name = self.str()?.to_string();
                    let value = self.value(depth + 1)?;
                    if members.insert(name, value).is_some() {
                        return Err(TickFault::DuplicateName);
                    }
                }
                Ok(Value::Object(members))
            }
            other => Err(TickFault::BadTag(other)),
        }
    }
}

/// The JSON number serde_json reads from the text a JS number prints as (ECMA-262
/// Number::toString): an integer printed without an exponent is read as a u64 or i64 when it fits,
/// anything else as an f64. `-0` is never an integer: the wrapper's text for it is `-0.0`. Past
/// 2^53 a JS text pads its shortest digits with zeros, an integer that names the same f64, so the
/// u64 or i64 here may differ from the text's in its low digits but never in `as_f64`, the one way
/// the core reads a number.
pub fn json_number(number: f64) -> Value {
    let plain_integer = number.fract() == 0.0 && number.abs() < PLAIN_INTEGER_LIMIT && !(number == 0.0 && number.is_sign_negative());
    if plain_integer && (0.0..U64_END).contains(&number) {
        return Value::Number(Number::from(number as u64));
    }
    if plain_integer && (I64_MIN..0.0).contains(&number) {
        return Value::Number(Number::from(number as i64));
    }
    Number::from_f64(number).map_or(Value::Null, Value::Number)
}

impl TickRequest {
    /// Reads a request whole; anything malformed is a [`TickFault`] before anything runs.
    pub fn decode(bytes: &[u8]) -> Result<Self, TickFault> {
        let mut cursor = Cursor { rest: bytes };
        let count = cursor.u32()?;
        if count > TICK_BATCHES_MAX {
            return Err(TickFault::TooManyBatches(count));
        }
        let mut batches = Vec::with_capacity(count as usize);
        for _ in 0..count {
            batches.push(cursor.item()?);
        }
        let step = cursor.flag()?;
        let export_since = cursor.f64()?;
        if export_since.is_nan() {
            return Err(TickFault::BadNumber);
        }
        let queries = if cursor.flag()? { Some(cursor.item()?) } else { None };
        if !cursor.rest.is_empty() {
            return Err(TickFault::Trailing(cursor.rest.len()));
        }
        Ok(Self { batches, step, export_since, queries })
    }
}

/// A reply being written, one part at a time: each part is written and dropped before the next
/// runs, so what a part allocated in the world's call is freed before `memoryBytes` is read, as it
/// is between the separate calls.
pub(crate) struct Out(Vec<u8>);

impl Out {
    /// A reply of `batches` batch results, the first written next.
    pub(crate) fn new(batches: usize) -> Self {
        let mut out = Self(Vec::with_capacity(256));
        out.u32(batches);
        out
    }

    /// The tick counter and `memoryBytes` after every part: the reply's bytes.
    pub(crate) fn finish(mut self, tick: f64, memory_bytes: f64) -> Vec<u8> {
        self.f64(tick);
        self.f64(memory_bytes);
        self.0
    }

    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }

    fn flag(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn u32(&mut self, value: usize) {
        let value = u32::try_from(value).unwrap_or(u32::MAX);
        self.0.extend_from_slice(&value.to_le_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }

    fn vec3(&mut self, value: &[f64; 3]) {
        for item in value {
            self.f64(*item);
        }
    }

    fn str(&mut self, value: &str) {
        self.u32(value.len());
        self.0.extend_from_slice(value.as_bytes());
    }

    fn opt_str(&mut self, value: Option<&String>) {
        self.flag(value.is_some());
        if let Some(text) = value {
            self.str(text);
        }
    }

    fn strs(&mut self, values: &[String]) {
        self.u32(values.len());
        for value in values {
            self.str(value);
        }
    }

    fn failure(&mut self, failure: &PhysicsFailure) {
        self.str(failure.code.code());
        self.flag(failure.index.is_some());
        if let Some(index) = failure.index {
            self.f64(index as f64);
        }
        self.str(&failure.detail);
    }

    pub(crate) fn batch(&mut self, result: &Result<Vec<CommandOutcome>, PhysicsFailure>) {
        let outcomes = match result {
            Ok(outcomes) => outcomes,
            Err(refused) => {
                self.u8(BATCH_FAILURE);
                self.failure(refused);
                return;
            }
        };
        self.u8(BATCH_RESULTS);
        self.u32(outcomes.len());
        for outcome in outcomes {
            match outcome {
                Ok(()) => self.u8(0),
                Err(code) => {
                    self.u8(1);
                    self.str(code.code());
                }
            }
        }
    }

    pub(crate) fn step(&mut self, step: Option<&Result<StepResult, PhysicsFailure>>) {
        match step {
            None => self.u8(STEP_NONE),
            Some(Err(refused)) => {
                self.u8(STEP_FAILURE);
                self.failure(refused);
            }
            Some(Ok(result)) => {
                self.u8(STEP_DONE);
                self.f64(result.tick as f64);
                self.u32(result.events.len());
                for event in &result.events {
                    self.event(event);
                }
                self.flag(result.overflowed);
                self.strs(&result.escaped);
                self.flag(result.memory_exceeded);
            }
        }
    }

    fn event(&mut self, event: &PhysicsEvent) {
        match event {
            PhysicsEvent::ContactBegin { a, b, ca, cb, ka, kb, impulse, point, normal } => {
                self.event_head(EVENT_CONTACT_BEGIN, [a, b, ca, cb], [ka, kb]);
                self.f64(*impulse);
                self.vec3(point);
                self.vec3(normal);
            }
            PhysicsEvent::ContactEnd { a, b, ca, cb, ka, kb } => self.event_head(EVENT_CONTACT_END, [a, b, ca, cb], [ka, kb]),
            PhysicsEvent::TriggerEnter { sensor, sc, other, oc, ks, ko } => {
                self.event_head(EVENT_TRIGGER_ENTER, [sensor, sc, other, oc], [ks, ko]);
            }
            PhysicsEvent::TriggerExit { sensor, sc, other, oc, ks, ko } => {
                self.event_head(EVENT_TRIGGER_EXIT, [sensor, sc, other, oc], [ks, ko]);
            }
        }
    }

    fn event_head(&mut self, kind: u8, keys: [&String; 4], kinds: [&Option<String>; 2]) {
        self.u8(kind);
        for key in keys {
            self.str(key);
        }
        for tag in kinds {
            self.opt_str(tag.as_ref());
        }
    }

    pub(crate) fn export(&mut self, export: Option<&ChangedExport>) {
        self.flag(export.is_some());
        let Some(export) = export else { return };
        self.strs(&export.keys);
        self.u32(export.data.len());
        for value in &export.data {
            self.0.extend_from_slice(&value.to_le_bytes());
        }
    }

    pub(crate) fn answers(&mut self, answers: Option<&Result<Vec<QueryOutcome>, PhysicsFailure>>) {
        let outcomes = match answers {
            None => return self.u8(ANSWERS_NONE),
            Some(Err(refused)) => {
                self.u8(ANSWERS_FAILURE);
                return self.failure(refused);
            }
            Some(Ok(outcomes)) => outcomes,
        };
        self.u8(ANSWERS_DONE);
        self.u32(outcomes.len());
        for outcome in outcomes {
            self.answer(outcome);
        }
    }

    fn answer(&mut self, outcome: &QueryOutcome) {
        match outcome {
            Err(refused) => {
                self.u8(ANSWER_FAILURE);
                self.failure(refused);
            }
            Ok(QueryAnswer::Hit(None)) => self.u8(ANSWER_NO_HIT),
            Ok(QueryAnswer::Hit(Some(hit))) => {
                self.u8(ANSWER_HIT);
                self.str(&hit.body);
                self.str(&hit.collider);
                self.f64(hit.dist);
                self.vec3(&hit.point);
                self.vec3(&hit.normal);
            }
            Ok(QueryAnswer::Keys(keys)) => {
                self.u8(ANSWER_KEYS);
                self.strs(keys);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request writer for the rows.
    #[derive(Default)]
    struct Req(Vec<u8>);

    impl Req {
        fn u8(mut self, value: u8) -> Self {
            self.0.push(value);
            self
        }
        fn u32(mut self, value: u32) -> Self {
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn f64(mut self, value: f64) -> Self {
            self.0.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn str(self, value: &[u8]) -> Self {
            let mut out = self.u32(value.len() as u32);
            out.0.extend_from_slice(value);
            out
        }
        /// The tail of a request with no batches: no step, no export, no queries.
        fn tail(self) -> Self {
            self.u8(0).f64(-1.0).u8(0)
        }
    }

    fn decode(req: Req) -> Result<TickRequest, TickFault> {
        TickRequest::decode(&req.0)
    }

    #[test]
    fn reads_values_as_their_json_text_parses() {
        // [{"impulse":{"key":"a","j":[1,-2,0.5]}}, null, true, false, "é", -0.0, 2.5]
        let req = Req::default()
            .u32(1)
            .u8(ITEM_VALUE)
            .u8(TAG_ARRAY)
            .u32(7)
            .u8(TAG_OBJECT)
            .u32(1)
            .str(b"impulse")
            .u8(TAG_OBJECT)
            .u32(2)
            .str(b"key")
            .u8(TAG_STRING)
            .str(b"a")
            .str(b"j")
            .u8(TAG_ARRAY)
            .u32(3)
            .u8(TAG_NUMBER)
            .f64(1.0)
            .u8(TAG_NUMBER)
            .f64(-2.0)
            .u8(TAG_NUMBER)
            .f64(0.5)
            .u8(TAG_NULL)
            .u8(TAG_TRUE)
            .u8(TAG_FALSE)
            .u8(TAG_STRING)
            .str("é".as_bytes())
            .u8(TAG_NUMBER)
            .f64(-0.0)
            .u8(TAG_NUMBER)
            .f64(2.5)
            .tail();
        let text = r#"[{"impulse":{"key":"a","j":[1,-2,0.5]}},null,true,false,"é",-0.0,2.5]"#;
        let parsed: Value = serde_json::from_str(text).expect("JSON");
        let read = decode(req).expect("reads");
        assert_eq!(read.batches, vec![Item::Value(parsed.clone())]);
        let Item::Value(value) = &read.batches[0] else { unreachable!() };
        assert_eq!(value.to_string(), parsed.to_string(), "the same numbers in the same forms");
        assert_eq!((read.step, read.export_since, read.queries), (false, -1.0, None));
    }

    #[test]
    fn a_number_takes_the_form_its_js_text_parses_to() {
        // Texts that name their number exactly, so even serde_json's default float parser reads it.
        let rows: [(f64, &str); 10] = [
            (0.0, "0"),
            (5.0, "5"),
            (-5.0, "-5"),
            (-0.0, "-0.0"),
            (-1.5, "-1.5"),
            (1e20, "100000000000000000000"),
            (2f64.powi(63), "9223372036854775808"),
            (-(2f64.powi(63)), "-9223372036854775808"),
            (-(2f64.powi(64)), "-18446744073709551616"),
            (2f64.powi(64), "18446744073709551616"),
        ];
        let form = |value: &Value| (value.is_u64(), value.is_i64(), value.is_f64(), value.as_f64().map(f64::to_bits));
        for (number, text) in rows {
            let parsed: Value = serde_json::from_str(text).expect("JSON");
            assert_eq!(form(&json_number(number)), form(&parsed), "{text}");
        }
        // Texts with an exponent are f64s whatever their value.
        for (number, text) in [(1e21, "1e21"), (1e39, "1e39"), (-1e39, "-1e39")] {
            let parsed: Value = serde_json::from_str(text).expect("JSON");
            assert!(json_number(number).is_f64() && parsed.is_f64(), "{text}");
        }
    }

    #[test]
    fn reads_text_items_items_without_text_and_queries() {
        let req = Req::default()
            .u32(2)
            .u8(ITEM_TEXT)
            .str(b"[{\"wake\":{\"key\":\"a\"}}]")
            .u8(ITEM_NO_TEXT)
            .u8(TAG_STRING)
            .str(b"\xEF\xBF\xBD")
            .u8(1)
            .f64(3.0)
            .u8(1)
            .u8(ITEM_VALUE)
            .u8(TAG_ARRAY)
            .u32(0);
        let read = decode(req).expect("reads");
        assert_eq!(read.batches, vec![Item::Text("[{\"wake\":{\"key\":\"a\"}}]".into()), Item::NoText]);
        assert_eq!((read.step, read.export_since, read.queries), (true, 3.0, Some(Item::Value(Value::Array(vec![])))));
        assert_eq!(Item::NoText.read().expect_err("refused").detail, NOT_JSON);
        assert_eq!(Item::Text("[".into()).read().expect_err("refused").detail, NOT_JSON);
    }

    #[test]
    fn refuses_every_hostile_request_whole() {
        let deep = (0..=VALUE_DEPTH_MAX).fold(Req::default().u32(1).u8(ITEM_VALUE), |req, _| req.u8(TAG_ARRAY).u32(1)).u8(TAG_NULL);
        let rows: [(&str, Req, TickFault); 17] = [
            ("nothing", Req::default(), TickFault::Short),
            ("65 batches", Req::default().u32(65), TickFault::TooManyBatches(65)),
            ("a batch count past the request", Req::default().u32(3).u8(ITEM_VALUE).u8(TAG_NULL), TickFault::Short),
            ("an unknown item form", Req::default().u32(1).u8(3), TickFault::BadTag(3)),
            ("an unknown value tag", Req::default().u32(1).u8(ITEM_VALUE).u8(7), TickFault::BadTag(7)),
            ("a NaN number", Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_NUMBER).f64(f64::NAN).tail(), TickFault::BadNumber),
            ("an infinite number", Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_NUMBER).f64(f64::INFINITY).tail(), TickFault::BadNumber),
            ("a string that is not UTF-8", Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_STRING).str(&[0xc3, 0x28]), TickFault::BadUtf8),
            ("text that is not UTF-8", Req::default().u32(1).u8(ITEM_TEXT).str(&[0xff]), TickFault::BadUtf8),
            ("an array count past the request", Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_ARRAY).u32(u32::MAX), TickFault::Short),
            ("an object count past the request", Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_OBJECT).u32(2).str(b"a"), TickFault::Short),
            (
                "a member named twice",
                Req::default().u32(1).u8(ITEM_VALUE).u8(TAG_OBJECT).u32(2).str(b"a").u8(TAG_NULL).str(b"a").u8(TAG_NULL).tail(),
                TickFault::DuplicateName,
            ),
            ("nesting past the cap", deep, TickFault::TooDeep),
            ("a step flag of 2", Req::default().u32(0).u8(2).f64(0.0).u8(0), TickFault::BadFlag(2)),
            ("exporting since NaN", Req::default().u32(0).u8(1).f64(f64::NAN).u8(0), TickFault::BadNumber),
            ("a queries flag of 9", Req::default().u32(0).u8(1).f64(0.0).u8(9), TickFault::BadFlag(9)),
            ("a byte left over", Req::default().u32(0).tail().u8(0), TickFault::Trailing(1)),
        ];
        for (name, req, fault) in rows {
            assert_eq!(decode(req), Err(fault), "{name}");
        }
    }
}
