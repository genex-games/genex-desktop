//! The room protocol's frames, version 3: what the host sends ([`Request`], decoded whole from a
//! [`Frame`] before anything runs) and the reply kinds. Field forms are `frame.rs`'s.
//!
//! | Kind | Request payload | Reply payload (after `u64 cpuNs`) |
//! |---|---|---|
//! | `Hello` 1 | `u32 version` | `u32 version, str buildId` |
//! | `Create` 2 | `str desc` (JSON, §4) | `str result` (`{ ok, id }` or a failure) |
//! | `AddStatic` 3 | `u32[] boxLengths, f64[] boxes, u32[] rampLengths, f64[] ramps` (§6.5) | `str result` |
//! | `Tick` 4 | a tick request (genex-physics-binding `tick.rs`: batches, step, exportSince, queries, binary) | its tick reply (`tick.rs`: results, step, export, answers, tick, memoryBytes, binary) |
//! | `Call` 5 | `u8 method, its arguments` ([`Method`]) | its result ([`Method`]) |
//! | `Shutdown` 6 | nothing | nothing; the process then exits 0 |
//!
//! A reply's kind is its request's with the high bit set, and every reply starts with `u64 cpuNs`:
//! the thread CPU time the sidecar spent on that frame (`CLOCK_THREAD_CPUTIME_ID`, read before the
//! frame was decoded and after its reply was written into memory). The world id is implicit: the
//! process holds one world (CONTRACT.md §11.1, one world per room).
//!
//! Version 2 (from 1): a `Tick` carries the binding's binary tick form instead of JSON texts, so its
//! commands cross with no number text and its reply decodes with no `JSON.parse`; the WASM package
//! crosses a tick in the same form (its `world_tick_frame` export). The host refuses a process that
//! answers `Hello` with another version.
//!
//! Version 3 (from 2): `Call` gains the contract 1.1 draft's methods (CONTRACT.md §20), bytes 21 to
//! 27: `Canonicalize`, `ExportChangedRest`, `ExportBodyStateRest`, `ImportStatesRest`, `ImportWire`,
//! `BodyDescCanonical` and `JointDescCanonical`. No other frame changed.

use genex_physics_binding::TickRequest;

use crate::frame::{Fault, Frame, Reader};

/// This protocol's version, exchanged by `Hello`.
pub const PROTOCOL_VERSION: u32 = 3;
/// The bit a reply's kind sets on its request's.
pub const REPLY_BIT: u8 = 0x80;

/// The request kinds.
pub mod kind {
    /// The first frame: the host's protocol version.
    pub const HELLO: u8 = 1;
    /// Makes the world from its description.
    pub const CREATE: u8 = 2;
    /// Imports the static world.
    pub const ADD_STATIC: u8 = 3;
    /// One room tick in one round trip.
    pub const TICK: u8 = 4;
    /// Any other registry method.
    pub const CALL: u8 = 5;
    /// Ends the process.
    pub const SHUTDOWN: u8 = 6;
}

/// A `Call`'s method byte, its arguments and its result, each a registry method on the one world
/// (genex-physics-binding `Registry::world_*`). A `str` result is the registry's JSON text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    /// `()` → `str`.
    Check = 1,
    /// `()` → `str`.
    Desc = 2,
    /// `()` → `f64`: the tick counter.
    TickCount = 3,
    /// `(str command)` → `str`.
    Command = 4,
    /// `(str commands, bool atomic)` → `str`.
    Apply = 5,
    /// `()` → `str`; the sidecar records the step's own wall time for `stats().stepMs` (§11.4).
    Step = 6,
    /// `(str key)` → `str`.
    Body = 7,
    /// `(opt<str> kinds, bool awakeOnly, f64 changedSince)` → `str`.
    Bodies = 8,
    /// `(f64 since)` → `str keys, f32[] data`.
    ExportChanged = 9,
    /// `(str key)` → `str`.
    ExportBodyState = 10,
    /// `(str key, str state)` → `str`.
    ImportBodyState = 11,
    /// `(str keys, f32[] data)` → `str`.
    ImportStates = 12,
    /// `(str queries)` → `str`.
    QueryMany = 13,
    /// `(str query)` → `str`.
    Query = 14,
    /// `()` → `opt<bytes>`.
    Snapshot = 15,
    /// `(bytes snapshot)` → `str`.
    Restore = 16,
    /// `()` → `str`.
    StateHash = 17,
    /// `()` → `str`.
    PhysicsHash = 18,
    /// `()` → `str`.
    Stats = 19,
    /// `()` → `bool`.
    MemoryIsMeasured = 20,
    /// `(str options)` → `str` (§20.1: `{ quantize? }`).
    Canonicalize = 21,
    /// `(f64 since)` → `str keys, f32[] data`, 15 numbers per body (§20.3).
    ExportChangedRest = 22,
    /// `(str key)` → `str` (§20.3).
    ExportBodyStateRest = 23,
    /// `(str keys, f32[] data)` → `str`, 15 numbers per key (§20.3).
    ImportStatesRest = 24,
    /// `(str keys, f32[] rows)` → `str`, 15 numbers per key (§20.2).
    ImportWire = 25,
    /// `(str desc)` → `str` (§20.5).
    BodyDescCanonical = 26,
    /// `(str desc)` → `str` (§20.5).
    JointDescCanonical = 27,
}

impl Method {
    /// Every method, in byte order.
    pub const ALL: [Method; 27] = [
        Method::Check,
        Method::Desc,
        Method::TickCount,
        Method::Command,
        Method::Apply,
        Method::Step,
        Method::Body,
        Method::Bodies,
        Method::ExportChanged,
        Method::ExportBodyState,
        Method::ImportBodyState,
        Method::ImportStates,
        Method::QueryMany,
        Method::Query,
        Method::Snapshot,
        Method::Restore,
        Method::StateHash,
        Method::PhysicsHash,
        Method::Stats,
        Method::MemoryIsMeasured,
        Method::Canonicalize,
        Method::ExportChangedRest,
        Method::ExportBodyStateRest,
        Method::ImportStatesRest,
        Method::ImportWire,
        Method::BodyDescCanonical,
        Method::JointDescCanonical,
    ];

    fn from_byte(byte: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|method| *method as u8 == byte)
    }
}

/// A decoded `Call`.
#[derive(Debug, PartialEq)]
pub enum Call<'a> {
    /// A method without arguments.
    Bare(Method),
    /// A method of one string.
    Text(Method, &'a str),
    /// `Apply`.
    Apply {
        /// The commands, a JSON array (§7.1).
        commands: &'a str,
        /// `"atomic"` rather than `"each"`.
        atomic: bool,
    },
    /// `Bodies`.
    Bodies {
        /// The filter's kinds, a JSON array of strings, or none.
        kinds: Option<&'a str>,
        /// Awake bodies only.
        awake_only: bool,
        /// A tick, or any negative number for none.
        changed_since: f64,
    },
    /// `ExportChanged`.
    ExportChanged {
        /// The tick after which a body changed.
        since: f64,
    },
    /// `ImportBodyState`.
    ImportBodyState {
        /// The body's key.
        key: &'a str,
        /// Its network state, JSON (§9.2).
        state: &'a str,
    },
    /// `ImportStates`.
    ImportStates {
        /// The keys, a JSON array of strings.
        keys: &'a str,
        /// 14 numbers per key (§19.1).
        data: Vec<f32>,
    },
    /// `ExportChangedRest`.
    ExportChangedRest {
        /// The tick after which a body changed.
        since: f64,
    },
    /// `ImportStatesRest` or `ImportWire`: keys and 15 numbers per key.
    Rows {
        /// Which of the two.
        method: Method,
        /// The keys, a JSON array of strings.
        keys: &'a str,
        /// 15 numbers per key (§20.2, §20.3).
        data: Vec<f32>,
    },
    /// `Restore`.
    Restore(&'a [u8]),
}

/// A request, decoded whole: a frame that cannot be decoded is a [`Fault`] before anything runs.
#[derive(Debug, PartialEq)]
pub enum Request<'a> {
    /// `Hello`.
    Hello {
        /// The host's protocol version.
        version: u32,
    },
    /// `Create`.
    Create {
        /// The world's description, JSON (§4).
        desc: &'a str,
    },
    /// `AddStatic`: the static world's flat form (§6.5).
    AddStatic {
        /// Each box row's length.
        box_lengths: Vec<u32>,
        /// Every box row's values, in order.
        boxes: Vec<f64>,
        /// Each ramp row's length.
        ramp_lengths: Vec<u32>,
        /// Every ramp row's values, in order.
        ramps: Vec<f64>,
    },
    /// `Tick`: read whole by the binding (`tick.rs`).
    Tick(TickRequest),
    /// `Call`.
    Call(Call<'a>),
    /// `Shutdown`.
    Shutdown,
}

impl<'a> Request<'a> {
    /// Decodes `frame`, refusing an unknown kind or method and any payload it cannot read exactly.
    pub fn decode(frame: &'a Frame) -> Result<Self, Fault> {
        let mut reader = Reader::new(&frame.payload);
        let request = match frame.kind {
            kind::HELLO => Request::Hello { version: reader.u32()? },
            kind::CREATE => Request::Create { desc: reader.str()? },
            kind::ADD_STATIC => Request::AddStatic {
                box_lengths: reader.u32s()?,
                boxes: reader.f64s()?,
                ramp_lengths: reader.u32s()?,
                ramps: reader.f64s()?,
            },
            kind::TICK => return TickRequest::decode(&frame.payload).map(Request::Tick).map_err(Fault::Tick),
            kind::CALL => Request::Call(call(&mut reader)?),
            kind::SHUTDOWN => Request::Shutdown,
            other => return Err(Fault::UnknownKind(other)),
        };
        reader.finish()?;
        Ok(request)
    }
}

fn call<'a>(reader: &mut Reader<'a>) -> Result<Call<'a>, Fault> {
    let byte = reader.u8()?;
    let Some(method) = Method::from_byte(byte) else { return Err(Fault::UnknownMethod(byte)) };
    Ok(match method {
        Method::Check
        | Method::Desc
        | Method::TickCount
        | Method::Step
        | Method::Snapshot
        | Method::StateHash
        | Method::PhysicsHash
        | Method::Stats
        | Method::MemoryIsMeasured => Call::Bare(method),
        Method::Command
        | Method::Body
        | Method::ExportBodyState
        | Method::QueryMany
        | Method::Query
        | Method::Canonicalize
        | Method::ExportBodyStateRest
        | Method::BodyDescCanonical
        | Method::JointDescCanonical => Call::Text(method, reader.str()?),
        Method::Apply => Call::Apply { commands: reader.str()?, atomic: reader.bool()? },
        Method::Bodies => Call::Bodies { kinds: reader.opt_str()?, awake_only: reader.bool()?, changed_since: reader.tick()? },
        Method::ExportChanged => Call::ExportChanged { since: reader.tick()? },
        Method::ImportBodyState => Call::ImportBodyState { key: reader.str()?, state: reader.str()? },
        Method::ImportStates => Call::ImportStates { keys: reader.str()?, data: reader.f32s()? },
        Method::ExportChangedRest => Call::ExportChangedRest { since: reader.tick()? },
        Method::ImportStatesRest | Method::ImportWire => Call::Rows { method, keys: reader.str()?, data: reader.f32s()? },
        Method::Restore => Call::Restore(reader.bytes()?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{LENGTH_BYTES, Writer};
    use genex_physics_binding::TickFault;

    /// The frame a writer built, as `read_frame` hands it over.
    fn frame(writer: Writer) -> Frame {
        let bytes = writer.finish().expect("fits");
        Frame { kind: bytes[LENGTH_BYTES], payload: bytes[LENGTH_BYTES + 1..].to_vec() }
    }

    fn call_frame(method: u8, args: impl FnOnce(&mut Writer)) -> Frame {
        let mut writer = Writer::new(kind::CALL);
        writer.u8(method);
        args(&mut writer);
        frame(writer)
    }

    #[test]
    fn decodes_each_request_kind() {
        let mut hello = Writer::new(kind::HELLO);
        hello.u32(PROTOCOL_VERSION);
        assert_eq!(Request::decode(&frame(hello)), Ok(Request::Hello { version: PROTOCOL_VERSION }));
        let mut tick_frame = Writer::new(kind::TICK);
        // Two batches as JSON text items (form 1), a step, no export, the queries as text.
        tick_frame.u32(2).u8(1).str("[]").u8(1).str("[{}]").bool(true).f64(-1.0).bool(true).u8(1).str("[]");
        let decoded = frame(tick_frame);
        let text = |value: &str| genex_physics_binding::tick::Item::Text(value.to_string());
        let expected = TickRequest { batches: vec![text("[]"), text("[{}]")], step: true, export_since: -1.0, queries: Some(text("[]")) };
        assert_eq!(Request::decode(&decoded), Ok(Request::Tick(expected)));
        let restore = call_frame(Method::Restore as u8, |w| {
            w.bytes(b"GXPH");
        });
        assert_eq!(Request::decode(&restore), Ok(Request::Call(Call::Restore(b"GXPH"))));
        let shutdown = frame(Writer::new(kind::SHUTDOWN));
        assert_eq!(Request::decode(&shutdown), Ok(Request::Shutdown));
    }

    #[test]
    fn refuses_hostile_requests_before_anything_runs() {
        let mut long_hello = Writer::new(kind::HELLO);
        long_hello.u32(1).u8(0);
        let mut nan_tick = Writer::new(kind::TICK);
        nan_tick.u32(0).bool(false).f64(f64::NAN).bool(false);
        let mut lying_batches = Writer::new(kind::TICK);
        lying_batches.u32(64).u8(1).str("[]");
        let mut bad_step = Writer::new(kind::TICK);
        bad_step.u32(0).u8(9).f64(0.0).bool(false);
        let mut many_batches = Writer::new(kind::TICK);
        many_batches.u32(1_000_000);
        let mut static_short = Writer::new(kind::ADD_STATIC);
        static_short.u32(1).u32(6).u32(2);
        let rows: [(&str, Frame, Fault); 11] = [
            ("an unknown kind", Frame { kind: 0x42, payload: vec![] }, Fault::UnknownKind(0x42)),
            ("a reply kind sent as a request", Frame { kind: kind::HELLO | REPLY_BIT, payload: vec![] }, Fault::UnknownKind(0x81)),
            ("a hello with a byte too many", frame(long_hello), Fault::TrailingBytes(1)),
            ("a tick exporting since NaN", frame(nan_tick), Fault::Tick(TickFault::BadNumber)),
            ("a tick claiming more batches than it carries", frame(lying_batches), Fault::Tick(TickFault::Short)),
            ("a tick claiming a million batches", frame(many_batches), Fault::Tick(TickFault::TooManyBatches(1_000_000))),
            ("a step flag of 9", frame(bad_step), Fault::Tick(TickFault::BadFlag(9))),
            ("a static world cut short", frame(static_short), Fault::ShortPayload),
            ("an unknown method", call_frame(0, |_| {}), Fault::UnknownMethod(0)),
            ("a method past the last", call_frame(28, |_| {}), Fault::UnknownMethod(28)),
            ("a shutdown with a payload", Frame { kind: kind::SHUTDOWN, payload: vec![0] }, Fault::TrailingBytes(1)),
        ];
        for (name, frame, fault) in rows {
            assert_eq!(Request::decode(&frame), Err(fault), "{name}");
        }
    }

    #[test]
    fn refuses_hostile_1_1_calls_before_anything_runs() {
        let rows: [(&str, Frame, Fault); 7] = [
            ("canonicalize without its options", call_frame(Method::Canonicalize as u8, |_| {}), Fault::ShortPayload),
            ("canonicalize with a byte too many", call_frame(Method::Canonicalize as u8, |w| {
                w.str("{}").u8(0);
            }), Fault::TrailingBytes(1)),
            ("a rest export since NaN", call_frame(Method::ExportChangedRest as u8, |w| {
                w.f64(f64::NAN);
            }), Fault::BadNumber),
            ("a wire import without its rows", call_frame(Method::ImportWire as u8, |w| {
                w.str("[]");
            }), Fault::ShortPayload),
            ("a rest import whose rows claim more than they carry", call_frame(Method::ImportStatesRest as u8, |w| {
                w.str("[]").u32(1000);
            }), Fault::ShortPayload),
            ("a body descriptor cut short", call_frame(Method::BodyDescCanonical as u8, |w| {
                w.u32(10);
            }), Fault::ShortPayload),
            ("a joint descriptor with a byte too many", call_frame(Method::JointDescCanonical as u8, |w| {
                w.str("{}").u8(7);
            }), Fault::TrailingBytes(1)),
        ];
        for (name, frame, fault) in rows {
            assert_eq!(Request::decode(&frame), Err(fault), "{name}");
        }
        let rows = call_frame(Method::ImportWire as u8, |w| {
            w.str("[\"a\"]").f32s(&[1.0; 15]);
        });
        let expected = Call::Rows { method: Method::ImportWire, keys: "[\"a\"]", data: vec![1.0; 15] };
        assert_eq!(Request::decode(&rows), Ok(Request::Call(expected)));
    }

    #[test]
    fn every_method_byte_names_one_method_and_reads_its_arguments_exactly() {
        for method in Method::ALL {
            assert_eq!(Method::from_byte(method as u8), Some(method));
        }
        let bodies = call_frame(Method::Bodies as u8, |w| {
            w.opt_str(Some("[\"crate\"]")).bool(true).f64(3.0);
        });
        let expected = Call::Bodies { kinds: Some("[\"crate\"]"), awake_only: true, changed_since: 3.0 };
        assert_eq!(Request::decode(&bodies), Ok(Request::Call(expected)));
        let missing_flag = call_frame(Method::Apply as u8, |w| {
            w.str("[]");
        });
        assert_eq!(Request::decode(&missing_flag), Err(Fault::ShortPayload));
        let bare_with_args = call_frame(Method::StateHash as u8, |w| {
            w.u8(1);
        });
        assert_eq!(Request::decode(&bare_with_args), Err(Fault::TrailingBytes(1)));
    }
}
