//! The studio protocol's framing and envelope, ported from the C++ template's `protocol.h` and
//! shared by every transport (genex-studio's descriptor reader, the web build's exports). One JSON
//! object per line, at most 1 MiB, nested at most 32 deep. Requests are `{id, op, arg?}`; replies
//! are `{id, ok:true, op, result}` or `{id, ok:false, op, error, available?}`; events are
//! `{event, ...}`.

use std::collections::BTreeMap;
use std::io::{ErrorKind, Read};

use crate::json::{self, ParseError, Value};

/// The longest line either side may send, newline excluded.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// The deepest nesting a request may have, its own object included.
pub const MAX_DEPTH: usize = json::MAX_DEPTH;
/// The protocol version `ready` states; the host refuses any other.
pub const PROTOCOL_VERSION: u32 = 1;
/// The smallest world target side, in pixels (the C++ runtime's `MIN_WORLD_PX`).
pub const MIN_WORLD_PX: u32 = 64;
/// The largest world target side, in pixels (the C++ runtime's `MAX_WORLD_PX`): the host refuses a
/// `ready.size` or a capture side above it (`NATIVE_CAPTURE_MAX_PX`).
pub const MAX_WORLD_PX: u32 = 4096;
/// How many bytes one read asks for; the buffer grows by this much, never by a whole line.
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// What a game sends on its own, unasked. Wire values: never rename one.
#[derive(Clone, Copy, Debug)]
pub struct Event;

impl Event {
    /// The game is up: `{nonce, protocol, contractVersion, build, backend, size, seed}`.
    pub const READY: &'static str = "ready";
    /// The game is about to exit abnormally: `{reason}`.
    pub const FATAL: &'static str = "fatal";
    /// The game's window gained or lost focus: `{focused}`.
    pub const FOCUS: &'static str = "focus";
    /// Contract v2: the game re-created its lost GPU device and dropped Live's ring, which was made
    /// on the old one; the host announces a new ring generation (`{}`).
    pub const DEVICE_RESTORED: &'static str = "device-restored";
    /// Contract v2, before `ready` only: a boot step finished and the game is still starting
    /// (`{}`, or `{stage, done?, total?}`: a [`BootProgress`]); the host gives its ready deadline
    /// again from each, up to a cap.
    pub const STARTING: &'static str = "starting";
}

/// Where a game's boot is (renderer pass 2, owner decision D11: real progress on every
/// destination), in the order a boot passes them: the host's `BootStage`
/// (`src/shared/native-contract.ts`), and the words the web shell's progress events carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BootStage {
    /// The browser downloads the game's module (web only): bytes of bytes.
    Wasm,
    /// The game's models and textures load: files of files where counted.
    Assets,
    /// The GPU device opens.
    Device,
    /// The renderer's pipelines compile: pipelines of pipelines.
    Pipelines,
    /// The first frame is drawn.
    Frame,
    /// The first lit frame is on screen.
    Ready,
}

impl BootStage {
    /// Every stage, in boot order.
    pub const ALL: [BootStage; 6] =
        [BootStage::Wasm, BootStage::Assets, BootStage::Device, BootStage::Pipelines, BootStage::Frame, BootStage::Ready];

    /// The wire spelling. Never rename one.
    pub const fn wire(self) -> &'static str {
        match self {
            BootStage::Wasm => "wasm",
            BootStage::Assets => "assets",
            BootStage::Device => "device",
            BootStage::Pipelines => "pipelines",
            BootStage::Frame => "frame",
            BootStage::Ready => "ready",
        }
    }
}

/// One step of a boot: its stage and, where it is counted, how much of how much is done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BootProgress {
    /// Where the boot is.
    pub stage: BootStage,
    /// Done so far (pipelines compiled, files loaded); None where the stage is not counted.
    pub done: Option<u64>,
    /// Of how many; None while unknown.
    pub total: Option<u64>,
}

impl BootProgress {
    /// A stage that is not counted.
    pub const fn at(stage: BootStage) -> BootProgress {
        BootProgress { stage, done: None, total: None }
    }

    /// A counted stage: `done` of `total`.
    pub const fn counted(stage: BootStage, done: u64, total: u64) -> BootProgress {
        BootProgress { stage, done: Some(done), total: Some(total) }
    }

    /// The `starting` event's fields: `{stage, done?, total?}`.
    pub fn fields(&self) -> Value {
        let mut fields = Value::object();
        fields.set("stage", Value::from(self.stage.wire()));
        if let Some(done) = self.done {
            fields.set("done", Value::from(done));
        }
        if let Some(total) = self.total {
            fields.set("total", Value::from(total));
        }
        fields
    }
}

/// Why a line was refused. Wire values: the host reads them, so never rename one.
#[derive(Clone, Copy, Debug)]
pub struct Refusal;

impl Refusal {
    /// The line passed [`MAX_LINE_BYTES`].
    pub const LINE_TOO_LONG: &'static str = "line-too-long";
    /// The line is not JSON.
    pub const BAD_JSON: &'static str = "bad-json";
    /// The line nests deeper than [`MAX_DEPTH`].
    pub const TOO_DEEP: &'static str = "too-deep";
    /// The line is JSON but not an object.
    pub const NOT_AN_OBJECT: &'static str = "not-an-object";
    /// The request has no number or string `id`.
    pub const MISSING_ID: &'static str = "missing-id";
    /// No handler answers the request's `op`.
    pub const UNKNOWN_OP: &'static str = "unknown-op";
}

/// What the next framed line was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NextLine {
    /// One line's bytes, the newline and a trailing CR removed.
    Line(Vec<u8>),
    /// A line past the cap, reported once; its bytes were dropped.
    TooLong,
    /// The source ended (or failed) and nothing is left.
    End,
}

/// NDJSON framing over a byte source. A line past the cap is reported once as
/// [`NextLine::TooLong`] and its bytes are dropped up to the next newline, so one hostile line
/// cannot grow the buffer or end the conversation. A trailing CR is stripped, blank lines are
/// skipped, and a last line with no newline is still delivered at the end. A read error ends the
/// source, as end of file does; an interrupted read is retried.
#[derive(Debug)]
pub struct LineReader<R> {
    source: R,
    cap: usize,
    pending: Vec<u8>,
    dropping: bool,
    ended: bool,
}

/// `line` without one trailing CR.
fn without_cr(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}

impl<R: Read> LineReader<R> {
    /// Frame `source` with the protocol's cap.
    pub fn new(source: R) -> Self {
        LineReader::with_cap(source, MAX_LINE_BYTES)
    }

    /// Frame `source`, refusing lines longer than `cap`.
    pub fn with_cap(source: R, cap: usize) -> Self {
        LineReader { source, cap, pending: Vec::new(), dropping: false, ended: false }
    }

    fn fill(&mut self) -> bool {
        let kept = self.pending.len();
        self.pending.resize(kept + READ_CHUNK_BYTES, 0);
        let count = loop {
            match self.source.read(&mut self.pending[kept..]) {
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Ok(count) => break count,
                Err(_) => break 0,
            }
        };
        self.pending.truncate(kept + count);
        count > 0
    }

    /// The next line, a too-long report, or the end.
    pub fn next_line(&mut self) -> NextLine {
        loop {
            if let Some(newline) = self.pending.iter().position(|&byte| byte == b'\n') {
                let tail = self.dropping;
                let line: Vec<u8> = self.pending.drain(..=newline).take(newline).collect();
                self.dropping = false;
                if tail {
                    continue; // the rest of a line already reported as too long
                }
                let line = without_cr(line);
                if line.len() > self.cap {
                    return NextLine::TooLong;
                }
                if line.is_empty() {
                    continue;
                }
                return NextLine::Line(line);
            }
            if self.dropping {
                self.pending.clear();
            } else if self.pending.len() > self.cap + 1 {
                // + 1: a line of exactly the cap may still end in CR.
                self.pending.clear();
                self.dropping = true;
                return NextLine::TooLong;
            }
            if self.ended {
                // What is left is a last line with no newline; once it is taken, the buffer stays empty.
                let line = without_cr(std::mem::take(&mut self.pending));
                if line.is_empty() {
                    return NextLine::End;
                }
                if line.len() > self.cap {
                    return NextLine::TooLong;
                }
                return NextLine::Line(line);
            }
            if !self.fill() {
                self.ended = true;
            }
        }
    }
}

/// A handler's answer: a result, or an error code for `{ok:false}`.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    /// `{ok:true, result}`.
    Result(Value),
    /// `{ok:false, error}`.
    Refused(String),
}

/// One verb's handler: it receives the request's `arg` (null when absent).
pub type Handler = Box<dyn Fn(&Value) -> Answer + Send + Sync>;

/// `{id, ok:false, op, error, available?}` as a line.
fn refusal_line(id: &Value, op: &Value, error: &str, available: Option<Vec<String>>) -> Vec<u8> {
    let mut reply = Value::object();
    reply.set("id", id.clone());
    reply.set("ok", Value::Bool(false));
    reply.set("op", op.clone());
    reply.set("error", Value::from(error));
    if let Some(available) = available {
        let mut ops = Value::array();
        for name in available {
            ops.push(Value::from(name));
        }
        reply.set("available", ops);
    }
    reply.dump()
}

/// The reply line for a handler's answer.
fn answer_line(id: &Value, op: &[u8], answer: Answer) -> Vec<u8> {
    let op = Value::String(op.to_vec());
    match answer {
        Answer::Refused(error) => refusal_line(id, &op, &error, None),
        Answer::Result(result) => {
            let mut reply = Value::object();
            reply.set("id", id.clone());
            reply.set("ok", Value::Bool(true));
            reply.set("op", op);
            reply.set("result", result);
            reply.dump()
        }
    }
}

/// A request id is a number or a string.
fn is_request_id(id: &Value) -> bool {
    matches!(id, Value::Number(_) | Value::String(_))
}

/// Routes request lines to handlers by op and writes the reply line.
#[derive(Default)]
pub struct Dispatcher {
    handlers: BTreeMap<Vec<u8>, Handler>,
}

impl std::fmt::Debug for Dispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dispatcher").field("ops", &self.ops()).finish()
    }
}

impl Dispatcher {
    /// Register (or replace) the handler for `op`.
    pub fn on(&mut self, op: &str, handler: impl Fn(&Value) -> Answer + Send + Sync + 'static) {
        self.handlers.insert(op.as_bytes().to_vec(), Box::new(handler));
    }

    /// Every registered op, sorted: what an unknown op is answered with.
    pub fn ops(&self) -> Vec<String> {
        self.handlers.keys().map(|op| String::from_utf8_lossy(op).into_owned()).collect()
    }

    /// Whether `op` has a handler.
    pub fn has(&self, op: &str) -> bool {
        self.handlers.contains_key(op.as_bytes())
    }

    /// The reply line (no newline) to one request line.
    pub fn handle(&self, line: &[u8]) -> Vec<u8> {
        let request = match json::parse_with_depth(line, MAX_DEPTH) {
            Ok(request) => request,
            Err(error) => {
                let why = if error == ParseError::TooDeep { Refusal::TOO_DEEP } else { Refusal::BAD_JSON };
                return refusal_line(&Value::Null, &Value::Null, why, None);
            }
        };
        if !matches!(request, Value::Object(_)) {
            return refusal_line(&Value::Null, &Value::Null, Refusal::NOT_AN_OBJECT, None);
        }
        let op = &request["op"];
        let named = if matches!(op, Value::String(_)) { op.clone() } else { Value::Null };
        let Some(id) = request.get("id").filter(|id| is_request_id(id)) else {
            return refusal_line(&Value::Null, &named, Refusal::MISSING_ID, None);
        };
        let handler = match op {
            Value::String(name) => self.handlers.get(name),
            _ => None,
        };
        let Some(handler) = handler else {
            return refusal_line(id, &named, Refusal::UNKNOWN_OP, Some(self.ops()));
        };
        answer_line(id, op.as_bytes(), handler(&request["arg"]))
    }

    /// The reply line to a request the framing dropped for its length.
    pub fn line_too_long(&self) -> Vec<u8> {
        refusal_line(&Value::Null, &Value::Null, Refusal::LINE_TOO_LONG, None)
    }

    /// Call `op` directly with an already-parsed argument, as the web exports do.
    pub fn call(&self, op: &str, arg: &Value) -> Vec<u8> {
        let Some(handler) = self.handlers.get(op.as_bytes()) else {
            return refusal_line(&Value::Null, &Value::from(op), Refusal::UNKNOWN_OP, Some(self.ops()));
        };
        answer_line(&Value::Null, op.as_bytes(), handler(arg))
    }
}

/// An event line (no newline): `{"event": name}` plus `fields`' members (an `event` member among
/// them is ignored).
pub fn event(name: &str, fields: &Value) -> Vec<u8> {
    let mut line = Value::object();
    line.set("event", Value::from(name));
    for (key, value) in fields.members() {
        if key != b"event" {
            line.set(key.clone(), value.clone());
        }
    }
    line.dump()
}
