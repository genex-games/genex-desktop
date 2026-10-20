//! The crash record, `genex-crash/1`: what crashed, where, on which thread, the raw instruction
//! pointers and the slide anchor the host symbolicates with, the GPU or WebAssembly side, the
//! seed, tick and input tail to replay it, and the last profile summary. Its JSON is the host's
//! `CrashRecordV1` (`src/shared/crash-record.ts`), field for field and in the same order.
//!
//! [`CrashRecord::to_json`] always writes a record the host parses: text is cut to its cap, and a
//! record over [`CRASH_RECORD_MAX_BYTES`] gives up the profile, then the replay track, then stack
//! frames from the bottom, naming each in `trimmed`. [`CrashRecord::from_json`] reads a record as
//! hostile input with the host parser's rules: size and depth first, then every vocabulary, count,
//! hex address and cap; unknown fields are dropped and overlong text is cut, never trusted.

use serde_json::{Map, Value, json};

use crate::caps::{
    CRASH_FRAMES_MAX, CRASH_HITCHES_MAX, CRASH_IMAGES_MAX, CRASH_JSON_DEPTH_MAX, CRASH_MESSAGE_MAX_BYTES,
    CRASH_PATH_MAX_CHARS, CRASH_PROFILE_MAX_BYTES, CRASH_RECORD_MAX_BYTES, CRASH_REPLAY_MAX_BYTES,
    IMAGE_ID_MAX_CHARS, NAME_TEXT_MAX_CHARS, SHORT_TEXT_MAX_CHARS,
};
use crate::kind::{CrashFlavour, CrashKind, CrashSource, CrashTrimmed, GpuErrorClass, WasmTrap};

/// The record's format line.
pub const CRASH_FORMAT: &str = "genex-crash/1";
/// The largest integer the host reads exactly (JavaScript's `Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// The most hex digits of an address.
const HEX_DIGITS_MAX: usize = 16;
/// Base64's alphabet (standard, padded).
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Where in the source the crash happened (a compile-time path, kept as data, never opened).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashLocation {
    /// The source path.
    pub file: String,
    /// The line.
    pub line: u64,
    /// The column.
    pub column: u64,
}

/// The thread that crashed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashThread {
    /// Its name ("" when it has none).
    pub name: String,
    /// Whether it is the game's main thread.
    pub main: bool,
}

/// One stack frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashFrame {
    /// A runtime instruction address in the game image.
    Ip(u64),
    /// An offset into one of the record's debug images (platform records).
    Image {
        /// The index into the record's images.
        image: u64,
        /// The offset into that image.
        offset: u64,
    },
}

/// A debug image a platform record's frames point into.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashImage {
    /// The image's name.
    pub name: String,
    /// Its id (a MetricKit binary UUID, an Android build id): hex digits and dashes.
    pub id: String,
}

/// The GPU's side of a `gpu-validation` or `device-lost` record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashGpu {
    /// The uncaptured error's class.
    pub class: Option<GpuErrorClass>,
    /// Why a lost device was lost.
    pub reason: Option<String>,
    /// wgpu's description.
    pub description: String,
    /// The backend.
    pub backend: Option<String>,
    /// The adapter's name.
    pub adapter: Option<String>,
}

/// One frame of a WebAssembly trap's stack (`wasm-function[func]:0xoffset`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WasmFrame {
    /// The function index.
    pub func: u64,
    /// The byte offset in the module.
    pub offset: u64,
}

/// A web trap's side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashWasm {
    /// What trapped.
    pub trap: WasmTrap,
    /// The engine's frames, top first.
    pub stack: Vec<WasmFrame>,
}

/// Where the game was: every field the writer knew.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecordContext {
    /// The run's seed.
    pub seed: Option<u32>,
    /// The last finished tick.
    pub tick: Option<u64>,
    /// The frame.
    pub frame: Option<u64>,
    /// Simulated time, in milliseconds.
    pub simulated_ms: Option<f64>,
    /// Whether the simulation was running.
    pub running: Option<bool>,
    /// The destination's wire spelling.
    pub destination: Option<String>,
    /// The build flavour.
    pub flavour: Option<CrashFlavour>,
    /// The build's identity.
    pub build: Option<String>,
    /// The game contract's version.
    pub contract: Option<u64>,
    /// The genex crate's version.
    pub genex: Option<String>,
}

/// The input since the last seed, to replay the crash with `seed`, `input` and `step`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrashReplay {
    /// The seed the track starts from.
    pub seed: u64,
    /// The first tick the track covers.
    pub from_tick: u64,
    /// The last tick it covers.
    pub to_tick: u64,
    /// False when the ring was busy or overflowed, or the track was trimmed.
    pub complete: bool,
    /// The InputTrack tail (base64 in the JSON).
    pub track: Vec<u8>,
}

/// A `genex-crash/1` record.
#[derive(Clone, Debug, PartialEq)]
pub struct CrashRecord {
    /// What crashed.
    pub kind: CrashKind,
    /// Who wrote the record.
    pub source: CrashSource,
    /// Whether the process ends.
    pub fatal: bool,
    /// Whether the panic was caught (`catching`).
    pub handled: bool,
    /// The panic message, the GPU error or the trap's text.
    pub message: String,
    /// Where in the source.
    pub location: Option<CrashLocation>,
    /// The thread.
    pub thread: Option<CrashThread>,
    /// Stack frames, top first.
    pub frames: Vec<CrashFrame>,
    /// The runtime address of `genex_crash::anchor`, for the host's slide.
    pub anchor: Option<u64>,
    /// Debug images (platform records).
    pub images: Vec<CrashImage>,
    /// The GPU side.
    pub gpu: Option<CrashGpu>,
    /// The WebAssembly side.
    pub wasm: Option<CrashWasm>,
    /// Where the game was.
    pub context: RecordContext,
    /// The input tail.
    pub replay: Option<CrashReplay>,
    /// The last profile summary (genex-profile's `volatile.profile` object).
    pub profile: Option<Value>,
    /// Frames that were hitches.
    pub hitches: Vec<u64>,
    /// What the caps gave up, in [`CrashTrimmed::ALL`] order.
    pub trimmed: Vec<CrashTrimmed>,
}

/// Why [`CrashRecord::from_json`] refused a record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CrashParseError {
    /// Over [`CRASH_RECORD_MAX_BYTES`].
    #[error("a crash record takes at most 64 KiB")]
    TooLarge,
    /// Nested deeper than [`CRASH_JSON_DEPTH_MAX`].
    #[error("a crash record nests at most 12 deep")]
    TooDeep,
    /// Not JSON, or not an object.
    #[error("a crash record is a JSON object")]
    NotJson,
    /// Another format line.
    #[error("not a genex-crash/1 record")]
    Format,
    /// A field outside its shape.
    #[error("the crash record's {0} is outside its shape")]
    Field(&'static str),
}

impl CrashRecord {
    /// A record of `kind` from `source` with `message`, every other field empty.
    pub fn new(kind: CrashKind, source: CrashSource, fatal: bool, message: impl Into<String>) -> CrashRecord {
        CrashRecord {
            kind,
            source,
            fatal,
            handled: false,
            message: message.into(),
            location: None,
            thread: None,
            frames: Vec::new(),
            anchor: None,
            images: Vec::new(),
            gpu: None,
            wasm: None,
            context: RecordContext::default(),
            replay: None,
            profile: None,
            hitches: Vec::new(),
            trimmed: Vec::new(),
        }
    }

    /// The record as JSON, at most [`CRASH_RECORD_MAX_BYTES`], every field within the host's caps.
    pub fn to_json(&self) -> Vec<u8> {
        self.to_json_within(CRASH_RECORD_MAX_BYTES)
    }

    /// The record as JSON within `max_bytes`: text cut to its caps, then the profile, the replay
    /// track and bottom frames given up (each named in `trimmed`) until it fits.
    pub(crate) fn to_json_within(&self, max_bytes: usize) -> Vec<u8> {
        let mut fitted = self.clone();
        fitted.cut_to_caps();
        loop {
            let json = serde_json::to_vec(&fitted.to_value()).unwrap_or_default();
            if json.len() <= max_bytes || !fitted.give_way() {
                return json;
            }
        }
    }

    /// Give up the next part, oldest rule first; false when nothing is left to give up.
    fn give_way(&mut self) -> bool {
        if self.profile.take().is_some() {
            self.note(CrashTrimmed::Profile);
            return true;
        }
        if let Some(replay) = self.replay.as_mut().filter(|replay| !replay.track.is_empty()) {
            replay.track.clear();
            replay.complete = false;
            self.note(CrashTrimmed::ReplayTrack);
            return true;
        }
        if !self.frames.is_empty() {
            let drop = (self.frames.len() / 8).max(1);
            self.frames.truncate(self.frames.len() - drop);
            self.note(CrashTrimmed::Frames);
            return true;
        }
        // Only a platform record with long, escape-heavy image names gets here.
        self.images.pop().is_some() || self.wasm.as_mut().and_then(|wasm| wasm.stack.pop()).is_some()
    }

    /// Note that `part` was given up, keeping `trimmed` in vocabulary order without repeats.
    fn note(&mut self, part: CrashTrimmed) {
        if !self.trimmed.contains(&part) {
            self.trimmed.push(part);
        }
        self.trimmed.sort();
    }

    /// Cut every field to the host's caps (what a writer must do so the host parses it).
    fn cut_to_caps(&mut self) {
        self.cut_named_parts();
        if let Some(thread) = self.thread.as_mut() {
            thread.name = cut_utf16(&thread.name, SHORT_TEXT_MAX_CHARS);
        }
        self.images.truncate(CRASH_IMAGES_MAX);
        let image_count = self.images.len() as u64;
        self.frames.retain(|frame| !matches!(frame, CrashFrame::Image { image, .. } if *image >= image_count));
        for image in &mut self.images {
            image.name = cut_utf16(&image.name, NAME_TEXT_MAX_CHARS);
            let id_char = |c: &char| c.is_ascii_hexdigit() || *c == '-';
            image.id = image.id.chars().filter(id_char).take(IMAGE_ID_MAX_CHARS).collect();
            if image.id.is_empty() {
                image.id = "0".to_owned();
            }
        }
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.reason = gpu.reason.as_deref().map(|text| cut_utf16(text, NAME_TEXT_MAX_CHARS));
            gpu.backend = gpu.backend.as_deref().map(|text| cut_utf16(text, SHORT_TEXT_MAX_CHARS));
            gpu.adapter = gpu.adapter.as_deref().map(|text| cut_utf16(text, NAME_TEXT_MAX_CHARS));
        }
        if let Some(wasm) = self.wasm.as_mut() {
            wasm.stack.truncate(CRASH_FRAMES_MAX);
        }
        let context = &mut self.context;
        for text in [&mut context.destination, &mut context.build, &mut context.genex].into_iter().flatten() {
            *text = cut_utf16(text, SHORT_TEXT_MAX_CHARS);
        }
        context.simulated_ms = context.simulated_ms.filter(|ms| ms.is_finite() && *ms >= 0.0);
    }

    /// The cuts the host names in `trimmed`: message, path, frames, track, profile and hitches.
    fn cut_named_parts(&mut self) {
        let message = cut_utf8(&self.message, CRASH_MESSAGE_MAX_BYTES);
        let mut cut_message = message.len() < self.message.len();
        self.message = message;
        if let Some(gpu) = self.gpu.as_mut() {
            let description = cut_utf8(&gpu.description, CRASH_MESSAGE_MAX_BYTES);
            cut_message |= description.len() < gpu.description.len();
            gpu.description = description;
        }
        if cut_message {
            self.note(CrashTrimmed::Message);
        }
        if let Some(location) = self.location.as_mut() {
            let file = cut_utf16(&location.file, CRASH_PATH_MAX_CHARS);
            let cut = file.len() < location.file.len();
            location.file = file;
            if cut {
                self.note(CrashTrimmed::LocationFile);
            }
        }
        if self.frames.len() > CRASH_FRAMES_MAX {
            self.frames.truncate(CRASH_FRAMES_MAX);
            self.note(CrashTrimmed::Frames);
        }
        if let Some(replay) = self.replay.as_mut().filter(|replay| replay.track.len() > CRASH_REPLAY_MAX_BYTES) {
            replay.track.clear();
            replay.complete = false;
            self.note(CrashTrimmed::ReplayTrack);
        }
        let profile_fits = self.profile.as_ref().is_none_or(|profile| {
            profile.is_object() && serde_json::to_vec(profile).is_ok_and(|bytes| bytes.len() <= CRASH_PROFILE_MAX_BYTES)
        });
        if !profile_fits {
            self.profile = None;
            self.note(CrashTrimmed::Profile);
        }
        self.hitches.truncate(CRASH_HITCHES_MAX);
    }

    /// The record as a JSON value, fields in the host's order.
    pub fn to_value(&self) -> Value {
        json!({
            "format": CRASH_FORMAT,
            "kind": self.kind,
            "source": self.source,
            "fatal": self.fatal,
            "handled": self.handled,
            "message": self.message,
            "location": self.location.as_ref().map(|at| json!({
                "file": at.file, "line": safe(at.line), "column": safe(at.column),
            })),
            "thread": self.thread.as_ref().map(|thread| json!({ "name": thread.name, "main": thread.main })),
            "frames": self.frames.iter().map(frame_value).collect::<Vec<_>>(),
            "anchor": self.anchor.map(|ip| json!({ "ip": hex(ip) })),
            "images": self.images.iter().map(|image| json!({ "name": image.name, "id": image.id })).collect::<Vec<_>>(),
            "gpu": self.gpu.as_ref().map(|gpu| json!({
                "class": gpu.class, "reason": gpu.reason, "description": gpu.description,
                "backend": gpu.backend, "adapter": gpu.adapter,
            })),
            "wasm": self.wasm.as_ref().map(|wasm| json!({
                "trap": wasm.trap,
                "stack": wasm.stack.iter()
                    .map(|at| json!({ "func": safe(at.func), "offset": safe(at.offset) }))
                    .collect::<Vec<_>>(),
            })),
            "context": context_value(&self.context),
            "replay": self.replay.as_ref().map(|replay| json!({
                "seed": safe(replay.seed), "fromTick": safe(replay.from_tick), "toTick": safe(replay.to_tick),
                "complete": replay.complete, "track": base64_encode(&replay.track),
            })),
            "profile": self.profile,
            "hitches": self.hitches.iter().map(|frame| safe(*frame)).collect::<Vec<_>>(),
            "symbols": Value::Null,
            "trimmed": self.trimmed,
        })
    }

    /// A record read as hostile input, with the host parser's rules.
    pub fn from_json(bytes: &[u8]) -> Result<CrashRecord, CrashParseError> {
        if bytes.len() > CRASH_RECORD_MAX_BYTES {
            return Err(CrashParseError::TooLarge);
        }
        if json_depth(bytes) > CRASH_JSON_DEPTH_MAX {
            return Err(CrashParseError::TooDeep);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| CrashParseError::NotJson)?;
        let raw = value.as_object().ok_or(CrashParseError::NotJson)?;
        read_record(raw)
    }
}

/// An address as the host spells it: `0x` and lowercase hex.
fn hex(value: u64) -> String {
    format!("{value:#x}")
}

/// A count the host reads exactly (larger values are clamped).
fn safe(value: u64) -> u64 {
    value.min(MAX_SAFE_INTEGER)
}

fn frame_value(frame: &CrashFrame) -> Value {
    match frame {
        CrashFrame::Ip(ip) => json!({ "ip": hex(*ip) }),
        CrashFrame::Image { image, offset } => json!({ "image": safe(*image), "offset": hex(*offset) }),
    }
}

/// The context with only the fields the writer knew.
fn context_value(context: &RecordContext) -> Value {
    let mut fields = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            fields.insert(key.to_owned(), value);
        }
    };
    put("seed", context.seed.map(Value::from));
    put("tick", context.tick.map(|tick| Value::from(safe(tick))));
    put("frame", context.frame.map(|frame| Value::from(safe(frame))));
    put("simulatedMs", context.simulated_ms.map(Value::from));
    put("running", context.running.map(Value::from));
    put("destination", context.destination.clone().map(Value::from));
    put("flavour", context.flavour.map(|flavour| Value::from(flavour.wire())));
    put("build", context.build.clone().map(Value::from));
    put("contract", context.contract.map(|contract| Value::from(safe(contract))));
    put("genex", context.genex.clone().map(Value::from));
    Value::Object(fields)
}

/// `text` cut to at most `max_bytes` of UTF-8, never inside a character.
pub fn cut_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// `text` cut to at most `max_units` UTF-16 units (JavaScript's string length), never inside a
/// character.
pub fn cut_utf16(text: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max_units {
            break;
        }
        end = at + character.len_utf8();
    }
    text[..end].to_owned()
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The deepest object or array nesting in `bytes` (strings skipped), without parsing.
fn json_depth(bytes: &[u8]) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for &byte in bytes {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// Standard padded base64.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (at, byte)| group | u32::from(*byte) << (16 - 8 * at));
        for at in 0..4 {
            if at <= chunk.len() {
                text.push(char::from(BASE64[(group >> (18 - 6 * at)) as usize & 63]));
            } else {
                text.push('=');
            }
        }
    }
    text
}

/// Standard padded base64 decoded; None for anything else.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut group = 0u32;
        for (at, byte) in chunk[..4 - padding].iter().enumerate() {
            let digit = BASE64.iter().position(|letter| letter == byte)?;
            group |= (digit as u32) << (18 - 6 * at);
        }
        let take = 3 - padding;
        out.extend((0..take).map(|at| (group >> (16 - 8 * at)) as u8));
    }
    Some(out)
}

// ── the reader ──────────────────────────────────────────────────────────────────────────────

type Read<T> = Result<T, CrashParseError>;

fn field<T>(name: &'static str, value: Option<T>) -> Read<T> {
    value.ok_or(CrashParseError::Field(name))
}

/// A count the host accepts: a whole number in 0..=2^53-1 (`1.0` included, as JavaScript reads it).
fn count(name: &'static str, value: &Value) -> Read<u64> {
    let whole = value.as_u64().or_else(|| {
        value.as_f64().filter(|number| number.fract() == 0.0 && *number >= 0.0).map(|number| number as u64)
    });
    field(name, whole.filter(|number| *number <= MAX_SAFE_INTEGER))
}

fn flag(name: &'static str, value: &Value) -> Read<bool> {
    field(name, value.as_bool())
}

fn text<'a>(name: &'static str, value: &'a Value, max_units: usize) -> Read<&'a str> {
    field(name, value.as_str().filter(|text| utf16_len(text) <= max_units))
}

fn address(name: &'static str, value: &Value) -> Read<u64> {
    let digits = value.as_str().and_then(|text| text.strip_prefix("0x"));
    let lower_hex = digits.filter(|digits| {
        let lower = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
        (1..=HEX_DIGITS_MAX).contains(&digits.len()) && digits.bytes().all(lower)
    });
    field(name, lower_hex.and_then(|digits| u64::from_str_radix(digits, 16).ok()))
}

fn word<T>(name: &'static str, value: &Value, from_wire: fn(&str) -> Option<T>) -> Read<T> {
    field(name, value.as_str().and_then(from_wire))
}

/// `value` read by `read` unless it is absent or null.
fn nullable<T>(value: Option<&Value>, read: impl FnOnce(&Value) -> Read<T>) -> Read<Option<T>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => read(value).map(Some),
    }
}

fn object<'a>(name: &'static str, value: &'a Value) -> Read<&'a Map<String, Value>> {
    field(name, value.as_object())
}

fn list<'a>(name: &'static str, value: &'a Value) -> Read<&'a Vec<Value>> {
    field(name, value.as_array())
}

const NULL: Value = Value::Null;

/// The member `key` of `raw`, or null.
fn at<'a>(raw: &'a Map<String, Value>, key: &str) -> &'a Value {
    raw.get(key).unwrap_or(&NULL)
}

fn read_record(raw: &Map<String, Value>) -> Read<CrashRecord> {
    if raw.get("format").and_then(Value::as_str) != Some(CRASH_FORMAT) {
        return Err(CrashParseError::Format);
    }
    let images = match raw.get("images") {
        None => Vec::new(),
        Some(value) => read_images(value)?,
    };
    let (frames, frames_cut) = read_frames(raw.get("frames"), images.len())?;
    let mut record = CrashRecord {
        kind: word("kind", at(raw, "kind"), CrashKind::from_wire)?,
        source: word("source", at(raw, "source"), CrashSource::from_wire)?,
        fatal: flag("fatal", at(raw, "fatal"))?,
        handled: flag("handled", at(raw, "handled"))?,
        message: field("message", at(raw, "message").as_str())?.to_owned(),
        location: nullable(raw.get("location"), read_location)?,
        thread: nullable(raw.get("thread"), read_thread)?,
        frames,
        anchor: nullable(raw.get("anchor"), |value| address("anchor", at(object("anchor", value)?, "ip")))?,
        images,
        gpu: nullable(raw.get("gpu"), read_gpu)?,
        wasm: nullable(raw.get("wasm"), read_wasm)?,
        context: nullable(raw.get("context"), read_context)?.unwrap_or_default(),
        replay: nullable(raw.get("replay"), read_replay)?,
        profile: raw.get("profile").filter(|value| !value.is_null()).cloned(),
        hitches: read_hitches(raw.get("hitches"))?,
        trimmed: Vec::new(),
    };
    let given: Vec<&str> =
        raw.get("trimmed").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    for part in CrashTrimmed::ALL.iter().filter(|part| given.contains(&part.wire())) {
        record.note(*part);
    }
    if frames_cut {
        record.note(CrashTrimmed::Frames);
    }
    record.cut_named_parts();
    Ok(record)
}

fn read_location(value: &Value) -> Read<CrashLocation> {
    let raw = object("location", value)?;
    let file = field("location.file", at(raw, "file").as_str())?.to_owned();
    let line = count("location.line", at(raw, "line"))?;
    Ok(CrashLocation { file, line, column: count("location.column", at(raw, "column"))? })
}

fn read_thread(value: &Value) -> Read<CrashThread> {
    let raw = object("thread", value)?;
    Ok(CrashThread {
        name: text("thread.name", at(raw, "name"), SHORT_TEXT_MAX_CHARS)?.to_owned(),
        main: flag("thread.main", at(raw, "main"))?,
    })
}

/// The top [`CRASH_FRAMES_MAX`] frames, and whether more were left out.
fn read_frames(value: Option<&Value>, images: usize) -> Read<(Vec<CrashFrame>, bool)> {
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok((Vec::new(), false)) };
    let items = list("frames", value)?;
    let frames = items.iter().take(CRASH_FRAMES_MAX).map(|item| read_frame(item, images)).collect::<Read<Vec<_>>>()?;
    Ok((frames, items.len() > CRASH_FRAMES_MAX))
}

fn read_frame(value: &Value, images: usize) -> Read<CrashFrame> {
    let raw = object("frames", value)?;
    if let Some(ip) = raw.get("ip") {
        return Ok(CrashFrame::Ip(address("frames.ip", ip)?));
    }
    let image = count("frames.image", at(raw, "image"))?;
    if image >= images as u64 {
        return Err(CrashParseError::Field("frames.image"));
    }
    Ok(CrashFrame::Image { image, offset: address("frames.offset", at(raw, "offset"))? })
}

fn read_images(value: &Value) -> Read<Vec<CrashImage>> {
    let items = list("images", value)?;
    if items.len() > CRASH_IMAGES_MAX {
        return Err(CrashParseError::Field("images"));
    }
    items
        .iter()
        .map(|item| {
            let raw = object("images", item)?;
            let id = at(raw, "id").as_str().filter(|id| {
                (1..=IMAGE_ID_MAX_CHARS).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            });
            Ok(CrashImage {
                name: text("images.name", at(raw, "name"), NAME_TEXT_MAX_CHARS)?.to_owned(),
                id: field("images.id", id)?.to_owned(),
            })
        })
        .collect()
}

fn read_gpu(value: &Value) -> Read<CrashGpu> {
    let raw = object("gpu", value)?;
    let owned = |read: Read<&str>| read.map(str::to_owned);
    Ok(CrashGpu {
        class: nullable(raw.get("class"), |value| word("gpu.class", value, GpuErrorClass::from_wire))?,
        reason: nullable(raw.get("reason"), |value| owned(text("gpu.reason", value, NAME_TEXT_MAX_CHARS)))?,
        description: field("gpu.description", at(raw, "description").as_str())?.to_owned(),
        backend: nullable(raw.get("backend"), |value| owned(text("gpu.backend", value, SHORT_TEXT_MAX_CHARS)))?,
        adapter: nullable(raw.get("adapter"), |value| owned(text("gpu.adapter", value, NAME_TEXT_MAX_CHARS)))?,
    })
}

fn read_wasm(value: &Value) -> Read<CrashWasm> {
    let raw = object("wasm", value)?;
    let stack = list("wasm.stack", at(raw, "stack"))?;
    if stack.len() > CRASH_FRAMES_MAX {
        return Err(CrashParseError::Field("wasm.stack"));
    }
    Ok(CrashWasm {
        trap: word("wasm.trap", at(raw, "trap"), WasmTrap::from_wire)?,
        stack: stack
            .iter()
            .map(|item| {
                let step = object("wasm.stack", item)?;
                let func = count("wasm.stack.func", at(step, "func"))?;
                Ok(WasmFrame { func, offset: count("wasm.stack.offset", at(step, "offset"))? })
            })
            .collect::<Read<Vec<_>>>()?,
    })
}

fn read_context(value: &Value) -> Read<RecordContext> {
    let raw = object("context", value)?;
    let optional_text =
        |key: &'static str| nullable(raw.get(key), |value| text(key, value, SHORT_TEXT_MAX_CHARS).map(str::to_owned));
    let seed = nullable(raw.get("seed"), |value| count("context.seed", value))?;
    let simulated_ms = nullable(raw.get("simulatedMs"), |value| {
        field("context.simulatedMs", value.as_f64().filter(|ms| ms.is_finite() && *ms >= 0.0))
    })?;
    Ok(RecordContext {
        seed: seed.map(|seed| u32::try_from(seed).map_err(|_| CrashParseError::Field("context.seed"))).transpose()?,
        tick: nullable(raw.get("tick"), |value| count("context.tick", value))?,
        frame: nullable(raw.get("frame"), |value| count("context.frame", value))?,
        simulated_ms,
        running: nullable(raw.get("running"), |value| flag("context.running", value))?,
        destination: optional_text("destination")?,
        flavour: nullable(raw.get("flavour"), |value| word("context.flavour", value, CrashFlavour::from_wire))?,
        build: optional_text("build")?,
        contract: nullable(raw.get("contract"), |value| count("context.contract", value))?,
        genex: optional_text("genex")?,
    })
}

/// The replay; a track over the cap reads as empty and incomplete (and is named in `trimmed`).
fn read_replay(value: &Value) -> Read<CrashReplay> {
    let raw = object("replay", value)?;
    let track = field("replay.track", at(raw, "track").as_str())?;
    let decoded = field("replay.track", base64_decode(track))?;
    let from_tick = count("replay.fromTick", at(raw, "fromTick"))?;
    let to_tick = count("replay.toTick", at(raw, "toTick"))?;
    if from_tick > to_tick {
        return Err(CrashParseError::Field("replay.fromTick"));
    }
    Ok(CrashReplay {
        seed: count("replay.seed", at(raw, "seed"))?,
        from_tick,
        to_tick,
        complete: flag("replay.complete", at(raw, "complete"))?,
        track: decoded,
    })
}

fn read_hitches(value: Option<&Value>) -> Read<Vec<u64>> {
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok(Vec::new()) };
    list("hitches", value)?.iter().take(CRASH_HITCHES_MAX).map(|item| count("hitches", item)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record whose profile, track and frames each take a few KiB.
    fn heavy() -> CrashRecord {
        let mut record = CrashRecord::new(CrashKind::Panic, CrashSource::Game, true, "boom");
        record.frames = (0..CRASH_FRAMES_MAX as u64).map(|n| CrashFrame::Ip(0x1000 + n)).collect();
        record.replay = Some(CrashReplay { seed: 1, from_tick: 0, to_tick: 9, complete: true, track: vec![7; 3000] });
        record.profile = Some(json!({ "padding": "x".repeat(3000) }));
        record
    }

    #[test]
    fn trimming_gives_up_profile_then_track_then_bottom_frames() {
        let full = heavy().to_json_within(usize::MAX).len();
        let profile_only = heavy().to_json_within(full - 100);
        let back = CrashRecord::from_json(&profile_only).expect("parses");
        assert_eq!(back.trimmed, [CrashTrimmed::Profile]);

        let track_too = heavy().to_json_within(full - 3500);
        let back = CrashRecord::from_json(&track_too).expect("parses");
        assert_eq!(back.trimmed, [CrashTrimmed::Profile, CrashTrimmed::ReplayTrack]);
        assert!(back.replay.as_ref().is_some_and(|replay| replay.track.is_empty() && !replay.complete));

        let budget = 1024;
        let frames_too = heavy().to_json_within(budget);
        assert!(frames_too.len() <= budget, "{} bytes", frames_too.len());
        let back = CrashRecord::from_json(&frames_too).expect("parses");
        assert_eq!(back.trimmed, [CrashTrimmed::Profile, CrashTrimmed::ReplayTrack, CrashTrimmed::Frames]);
        assert!(!back.frames.is_empty() && back.frames.len() < CRASH_FRAMES_MAX);
        assert_eq!(back.frames.first(), Some(&CrashFrame::Ip(0x1000)), "frames go from the bottom");
    }

    #[test]
    fn base64_round_trips_and_refuses_what_is_not_base64() {
        for len in 0..10 {
            let bytes: Vec<u8> = (0..len).map(|n| (n * 37) as u8).collect();
            assert_eq!(base64_decode(&base64_encode(&bytes)), Some(bytes));
        }
        assert_eq!(base64_encode(b"genex-input-track"), "Z2VuZXgtaW5wdXQtdHJhY2s=");
        for bad in ["abc", "ab=c", "a===", "ab!d", "QQ==QUJD"] {
            assert_eq!(base64_decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn utf16_cuts_count_what_javascript_counts() {
        assert_eq!(cut_utf16("ab\u{1F600}cd", 3), "ab");
        assert_eq!(cut_utf16("ab\u{1F600}cd", 4), "ab\u{1F600}");
        assert_eq!(cut_utf8("aé", 2), "a");
    }
}
