//! One process's session: the order its frames must come in and the one world they drive.
//!
//! `Hello` comes first and once. `Create` comes next, as often as it is refused; once a world
//! exists every other frame drives it and another `Create` is a fault (one world per process,
//! CONTRACT.md §11.1). `AddStatic`, `Tick` and `Call` before the world exists, a second `Hello` and
//! a second `Create` are out of order: each is a [`Fault`] returned before anything runs, so the
//! process exits 3 with the world exactly as the last good frame left it (nothing of the bad one
//! applied). `Shutdown` is accepted at any point.

use std::time::Instant;

use genex_physics_binding::{Registry, TickRequest};
use serde_json::Value;

use crate::frame::{Fault, Writer};
use crate::protocol::{Call, Method, PROTOCOL_VERSION, REPLY_BIT, Request, kind};

/// Where the session is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Nothing received yet.
    AwaitHello,
    /// Greeted; no world yet.
    AwaitWorld,
    /// The world, by its registry id.
    Ready(u32),
}

/// What the main loop does after writing a reply.
#[derive(Debug, PartialEq, Eq)]
pub enum After {
    /// Reads the next frame.
    Continue,
    /// The world was made: the loop sets the process's memory limit from its `memoryBytes` (§11.1).
    Created {
        /// The world's resolved `limits.memoryBytes`.
        memory_bytes: u64,
    },
    /// Exits 0 (`Shutdown`).
    Exit,
}

/// A handled frame: its reply (with a zero `cpuNs` the loop fills in) and what comes next.
pub struct Handled {
    /// The reply frame.
    pub reply: Writer,
    /// What the loop does next.
    pub after: After,
}

/// The session of one process.
pub struct Session {
    registry: Registry,
    state: State,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

/// A reply of `request_kind`, its `cpuNs` still zero.
fn reply(request_kind: u8) -> Writer {
    let mut writer = Writer::new(request_kind | REPLY_BIT);
    writer.u64(0);
    writer
}

fn text_reply(request_kind: u8, text: &str) -> Handled {
    let mut writer = reply(request_kind);
    writer.str(text);
    Handled { reply: writer, after: After::Continue }
}

/// The resolved `limits.memoryBytes` of a world's description (JSON text, §4), or 0.
fn memory_limit(desc: &str) -> u64 {
    serde_json::from_str::<Value>(desc).ok().and_then(|desc| desc["limits"]["memoryBytes"].as_u64()).unwrap_or(0)
}

impl Session {
    /// A session before its `Hello`.
    pub fn new() -> Self {
        Self { registry: Registry::new(), state: State::AwaitHello }
    }

    /// Runs one decoded request; an out-of-order one is a [`Fault`] with nothing run.
    pub fn handle(&mut self, request: Request<'_>) -> Result<Handled, Fault> {
        match (request, self.state) {
            (Request::Shutdown, _) => Ok(Handled { reply: reply(kind::SHUTDOWN), after: After::Exit }),
            (Request::Hello { .. }, State::AwaitHello) => Ok(self.hello()),
            (Request::Hello { .. }, _) => Err(Fault::OutOfOrder("a second Hello")),
            (_, State::AwaitHello) => Err(Fault::OutOfOrder("a frame before Hello")),
            (Request::Create { desc }, State::AwaitWorld) => Ok(self.create(desc)),
            (Request::Create { .. }, State::Ready(_)) => Err(Fault::OutOfOrder("a second world in one process")),
            (_, State::AwaitWorld) => Err(Fault::OutOfOrder("a frame before Create")),
            (Request::AddStatic { box_lengths, boxes, ramp_lengths, ramps }, State::Ready(id)) => {
                let text = self.registry.world_add_static(id, &box_lengths, &boxes, &ramp_lengths, &ramps);
                Ok(text_reply(kind::ADD_STATIC, &text))
            }
            (Request::Tick(tick), State::Ready(id)) => Ok(self.tick(id, tick)),
            (Request::Call(call), State::Ready(id)) => Ok(self.call(id, call)),
        }
    }

    /// Answers this side's version and build; the host refuses a version other than its own.
    fn hello(&mut self) -> Handled {
        self.state = State::AwaitWorld;
        let mut writer = reply(kind::HELLO);
        writer.u32(PROTOCOL_VERSION).str(&genex_physics_binding::build_id());
        Handled { reply: writer, after: After::Continue }
    }

    fn create(&mut self, desc: &str) -> Handled {
        let text = self.registry.world_create(desc);
        let made = serde_json::from_str::<Value>(&text).ok().and_then(|made| made["id"].as_u64());
        let Some(id) = made.and_then(|id| u32::try_from(id).ok()) else { return text_reply(kind::CREATE, &text) };
        self.state = State::Ready(id);
        let memory_bytes = memory_limit(&self.registry.world_desc(id));
        Handled { after: After::Created { memory_bytes }, ..text_reply(kind::CREATE, &text) }
    }

    /// Steps the world and records the step's own wall time (§11.4: display only).
    fn step(&mut self, id: u32) -> String {
        let start = Instant::now();
        let text = self.registry.world_step(id);
        // A step that failed leaves the world failed, where recording changes nothing; the
        // recorded time is then never read, so no result needs parsing here.
        self.registry.world_record_step_ms(id, start.elapsed().as_secs_f64() * 1000.0);
        text
    }

    /// A room tick (genex-physics-binding `tick.rs`), its step timed on this process's clock.
    fn tick(&mut self, id: u32, request: TickRequest) -> Handled {
        let start = Instant::now();
        let mut since_start = || start.elapsed().as_secs_f64() * 1000.0;
        let bytes = self.registry.world_tick_frame(id, request, &mut since_start);
        let mut writer = reply(kind::TICK);
        writer.raw(&bytes);
        Handled { reply: writer, after: After::Continue }
    }

    fn call(&mut self, id: u32, call: Call<'_>) -> Handled {
        let registry = &mut self.registry;
        let mut writer = reply(kind::CALL);
        match call {
            Call::Bare(Method::TickCount) => writer.f64(registry.world_tick(id)),
            Call::Bare(Method::MemoryIsMeasured) => writer.bool(registry.world_memory_is_measured(id)),
            Call::Bare(Method::Snapshot) => match registry.world_snapshot(id) {
                Some(bytes) => writer.bool(true).bytes(&bytes),
                None => writer.bool(false),
            },
            Call::Bare(Method::Step) => writer.str(&self.step(id)),
            Call::Bare(method) => writer.str(&bare_text(registry, id, method)),
            Call::Text(method, text) => writer.str(&text_call(registry, id, method, text)),
            Call::Apply { commands, atomic } => writer.str(&registry.world_apply(id, commands, atomic)),
            Call::Bodies { kinds, awake_only, changed_since } => {
                writer.str(&registry.world_bodies(id, kinds, awake_only, changed_since))
            }
            Call::ExportChanged { since } => {
                let keys = registry.world_export_changed(id, since);
                writer.str(&keys).f32s(&registry.take_changed_data())
            }
            Call::ImportBodyState { key, state } => writer.str(&registry.world_import_body_state(id, key, state)),
            Call::ImportStates { keys, data } => writer.str(&registry.world_import_states(id, keys, &data)),
            Call::ExportChangedRest { since } => {
                let keys = registry.world_export_changed_rest(id, since);
                writer.str(&keys).f32s(&registry.take_changed_data())
            }
            Call::Rows { method: Method::ImportWire, keys, data } => writer.str(&registry.world_import_wire(id, keys, &data)),
            Call::Rows { keys, data, .. } => writer.str(&registry.world_import_states_rest(id, keys, &data)),
            Call::Restore(bytes) => writer.str(&registry.world_restore(id, bytes)),
        };
        Handled { reply: writer, after: After::Continue }
    }
}

/// A method without arguments whose result is JSON text (or a hash).
fn bare_text(registry: &mut Registry, id: u32, method: Method) -> String {
    match method {
        Method::Check => registry.world_check(id),
        Method::Desc => registry.world_desc(id),
        Method::StateHash => registry.world_state_hash(id),
        Method::PhysicsHash => registry.world_physics_hash(id),
        _ => registry.world_stats(id),
    }
}

/// A method of one string argument.
fn text_call(registry: &mut Registry, id: u32, method: Method, text: &str) -> String {
    match method {
        Method::Command => registry.world_command(id, text),
        Method::Body => registry.world_body(id, text),
        Method::ExportBodyState => registry.world_export_body_state(id, text),
        Method::QueryMany => registry.world_query_many(id, text),
        Method::Canonicalize => registry.world_canonicalize(id, text),
        Method::ExportBodyStateRest => registry.world_export_body_state_rest(id, text),
        Method::BodyDescCanonical => registry.world_body_desc_canonical(id, text),
        Method::JointDescCanonical => registry.world_joint_desc_canonical(id, text),
        _ => registry.world_query(id, text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{LENGTH_BYTES, Reader};
    use genex_physics_binding::tick::Item;

    const DESC: &str = r#"{"contract":"1.0","dt":0.016666668,"substeps":1,"gravity":[0,-9.81,0],"upAxis":"y","lengthUnit":1}"#;
    const CRATE: &str = r#"[{"spawn":{"key":"crate","type":"dynamic","pose":{"p":[0,2,0],"q":[0,0,0,1]},"colliders":[{"key":"c","shape":{"kind":"box","half":[0.5,0.5,0.5]}}]}}]"#;

    /// The payload of a reply after its `cpuNs`.
    fn body(handled: Handled) -> Vec<u8> {
        let bytes = handled.reply.finish().expect("fits");
        bytes[LENGTH_BYTES + 1 + 8..].to_vec()
    }

    fn ready() -> Session {
        let mut session = Session::new();
        session.handle(Request::Hello { version: PROTOCOL_VERSION }).expect("hello");
        let made = session.handle(Request::Create { desc: DESC }).expect("create");
        assert_eq!(made.after, After::Created { memory_bytes: 64 * 1024 * 1024 });
        session
    }

    #[test]
    fn refuses_frames_out_of_order_and_runs_none_of_them() {
        let tick = || Request::Tick(TickRequest { batches: vec![text(CRATE)], step: true, export_since: 0.0, queries: None });
        let mut fresh = Session::new();
        assert_eq!(fresh.handle(Request::Create { desc: DESC }).err(), Some(Fault::OutOfOrder("a frame before Hello")));
        fresh.handle(Request::Hello { version: PROTOCOL_VERSION }).expect("hello");
        assert_eq!(fresh.handle(Request::Hello { version: 1 }).err(), Some(Fault::OutOfOrder("a second Hello")));
        assert_eq!(fresh.handle(tick()).err(), Some(Fault::OutOfOrder("a frame before Create")));
        assert_eq!(fresh.registry.live_worlds(), 0, "the refused tick made nothing");
        let refused = fresh.handle(Request::Create { desc: r#"{"contract":"2.0"}"# }).expect("answers");
        assert_eq!(refused.after, After::Continue, "a refused world leaves the session waiting for one");
        assert!(matches!(fresh.handle(Request::Create { desc: DESC }).expect("create").after, After::Created { .. }));
        let hash = fresh.registry.world_state_hash(1);
        assert_eq!(fresh.handle(Request::Create { desc: DESC }).err(), Some(Fault::OutOfOrder("a second world in one process")));
        assert_eq!((fresh.registry.live_worlds(), fresh.registry.world_state_hash(1)), (1, hash));
        assert_eq!(fresh.handle(Request::Shutdown).expect("bye").after, After::Exit);
    }

    /// An item of JSON text (the binding's form 1).
    fn text(value: &str) -> Item {
        Item::Text(value.to_string())
    }

    #[test]
    fn a_tick_applies_steps_exports_and_answers_in_one_reply() {
        let mut session = ready();
        let request = TickRequest {
            batches: vec![text(CRATE), text(r#"[{"wake":{"key":"nobody"}}]"#)],
            step: true,
            export_since: 0.0,
            queries: Some(text(r#"[{"ray":{"origin":[0,9,0],"dir":[0,-1,0],"maxDist":20}}]"#)),
        };
        let bytes = body(session.handle(Request::Tick(request)).expect("tick"));
        let mut reader = Reader::new(&bytes);
        assert_eq!(reader.u32(), Ok(2));
        assert_eq!((reader.u8(), reader.u32(), reader.u8()), (Ok(1), Ok(1), Ok(0)), "the spawn applied");
        assert_eq!((reader.u8(), reader.u32(), reader.u8(), reader.str()), (Ok(1), Ok(1), Ok(1), Ok("unknown-key")));
        assert_eq!((reader.u8(), reader.f64()), (Ok(2), Ok(1.0)), "stepped to tick 1");
        assert_eq!((reader.u32(), reader.bool(), reader.u32(), reader.bool()), (Ok(0), Ok(false), Ok(0), Ok(false)));
        assert_eq!((reader.bool(), reader.u32(), reader.str()), (Ok(true), Ok(1), Ok("crate")));
        assert_eq!(reader.f32s().map(|data| data.len()), Ok(genex_physics::EXPORT_STRIDE));
        assert_eq!((reader.u8(), reader.u32(), reader.u8(), reader.str()), (Ok(2), Ok(1), Ok(2), Ok("crate")), "the ray hit");
        assert_eq!(reader.str(), Ok("c"));
        for _ in 0..7 {
            reader.f64().expect("dist, point, normal");
        }
        assert_eq!(reader.f64(), Ok(1.0));
        assert!(reader.f64().is_ok_and(|bytes| bytes > 0.0), "the world's measured memory");
        assert_eq!(reader.finish(), Ok(()));
        let stats: Value = serde_json::from_str(&session.registry.world_stats(1)).expect("JSON");
        assert!(stats["stepMs"].as_f64().is_some_and(|ms| ms > 0.0), "the sidecar timed the tick's step");
    }

    #[test]
    fn a_tick_with_nothing_asked_answers_only_its_tick_and_memory() {
        let mut session = ready();
        let request = TickRequest { batches: vec![], step: false, export_since: -1.0, queries: None };
        let bytes = body(session.handle(Request::Tick(request)).expect("tick"));
        let mut reader = Reader::new(&bytes);
        let read = (reader.u32(), reader.u8(), reader.bool(), reader.u8(), reader.f64());
        assert_eq!(read, (Ok(0), Ok(0), Ok(false), Ok(0), Ok(0.0)));
    }

    #[test]
    fn calls_reach_the_one_world() {
        let mut session = ready();
        let applied = body(session.handle(Request::Call(Call::Apply { commands: CRATE, atomic: true })).expect("apply"));
        assert_eq!(Reader::new(&applied).str(), Ok(r#"{"ok":true}"#));
        body(session.handle(Request::Call(Call::Bare(Method::Step))).expect("step"));
        let stats = body(session.handle(Request::Call(Call::Bare(Method::Stats))).expect("stats"));
        let stats: Value = serde_json::from_str(Reader::new(&stats).str().expect("text")).expect("JSON");
        assert_eq!((stats["tick"].as_u64(), stats["bodies"].as_u64()), (Some(1), Some(1)));
        assert!(stats["stepMs"].as_f64().is_some_and(|ms| ms > 0.0), "the sidecar timed its own step");
        let snapshot = body(session.handle(Request::Call(Call::Bare(Method::Snapshot))).expect("snapshot"));
        let mut reader = Reader::new(&snapshot);
        assert_eq!(reader.bool(), Ok(true));
        let bytes = reader.bytes().expect("bytes").to_vec();
        let restored = body(session.handle(Request::Call(Call::Restore(&bytes))).expect("restore"));
        assert_eq!(Reader::new(&restored).str(), Ok(r#"{"ok":true}"#));
        let canonical = body(session.handle(Request::Call(Call::Text(Method::Canonicalize, r#"{"quantize":true}"#))).expect("canonicalize"));
        assert_eq!(Reader::new(&canonical).str(), Ok(r#"{"ok":true}"#));
        let exported = body(session.handle(Request::Call(Call::ExportChangedRest { since: 0.0 })).expect("export"));
        let mut reader = Reader::new(&exported);
        let keys = reader.str().expect("keys").to_string();
        let data = reader.f32s().expect("data");
        assert_eq!(data.len(), genex_physics::EXPORT_STRIDE_REST);
        let imported = body(session.handle(Request::Call(Call::Rows { method: Method::ImportStatesRest, keys: &keys, data })).expect("import"));
        assert_eq!(Reader::new(&imported).str(), Ok(r#"{"ok":true}"#));
        let wire = body(session.handle(Request::Call(Call::Rows { method: Method::ImportWire, keys: &keys, data: vec![0.0; 3] })).expect("wire"));
        assert!(Reader::new(&wire).str().is_ok_and(|text| text.contains("bad-command")), "rows of the wrong length are refused");
        let measured = body(session.handle(Request::Call(Call::Bare(Method::MemoryIsMeasured))).expect("measured"));
        assert_eq!(Reader::new(&measured).bool(), Ok(true), "this crate's tests install the counting allocator");
    }
}
