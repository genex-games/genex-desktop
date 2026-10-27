//! genex-physics-binding: the host-neutral binding of Genex Physics, contract 1.0
//! (`../genex-physics/CONTRACT.md`; section numbers below are its own).
//!
//! Every binding of the core is the same adapter: worlds held by id, inputs read from JSON text
//! and flat arrays, results written as JSON text in the TypeScript shapes of
//! `genex-physics/js/index.d.ts`. That adapter is [`Registry`]; a host's shell owns one and
//! forwards to it. The WASM binding (`genex-physics-wasm`, the `@genex-ai/physics` npm package)
//! keeps one per instance, the native sidecar (`genex-physics-sidecar`) one per process holding one
//! world; the C ABI is the next shell. Each method is
//! one export of that wire, with its inputs and return forms: JSON text, `Vec<f32>` for
//! `exportChanged`'s data, `Option<Vec<u8>>` for snapshots, bools and f64.
//!
//! Ids are never reused within one registry: 0 is never handed out, and once the next id would be
//! `u32::MAX` every create is refused with `internal`. Every method returns a value for every
//! input; an id that names no world (never made, or freed) gives `internal` where the call has a
//! result, and the empty form where it has none (`null`, `[]`, an empty string, 0 or `false`).
//!
//! # Memory (§11.1)
//!
//! Per-world memory is measured only in a binary that installs genex-physics'
//! `CountingAllocator` as its global allocator (the WASM shell does); otherwise `stats()` reports
//! the core's model. This crate's own tests install it, so they see the measured form.
//!
//! # Threads (§1.1)
//!
//! A registry is a plain value: a shell that calls it from one thread (the WASM instance) keeps it
//! in a thread-local; a shell with several threads gives each world's calls one thread.

use std::collections::BTreeMap;

use genex_physics::{
    BodyFilter, ChangedExport, Command, CommandOutcome, PhysicsError, PhysicsFailure, Query, QueryOutcome, StepResult, World, WorldDesc,
};

mod input;
mod output;
pub mod tick;

pub use tick::{TickFault, TickRequest};

/// This crate's tests measure memory as the WASM shell does: every allocation is charged to the
/// world whose call is running (§11.1).
#[cfg(test)]
#[global_allocator]
static ALLOCATOR: genex_physics::accounting::CountingAllocator<std::alloc::System> =
    genex_physics::accounting::CountingAllocator::new(std::alloc::System);

/// The detail of a call on an id that names no world.
const NO_WORLD: &str = "no such world: it was freed, or never made";
/// The detail when the registry ran out of ids (after 2^32 - 1 worlds in one registry).
const NO_IDS: &str = "this instance has made every world it can; make a new instance";
/// The first tick. `bodies()` takes a smaller `changed_since` (the wrapper passes -1) as no filter.
const FIRST_TICK: f64 = 0.0;
/// The first id a registry hands out; 0 is never one.
const FIRST_ID: u32 = 1;

fn internal(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::Internal, detail)
}

/// This build's identity (§2), e.g. `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+wasm32`.
pub fn build_id() -> String {
    genex_physics::build_id()
}

/// The live worlds of one host instance, by an id that is never reused, and the hand-over of the
/// last [`Registry::world_export_changed`]'s data.
pub struct Registry {
    /// The live worlds by id.
    worlds: BTreeMap<u32, Box<World>>,
    /// The next id; 0 is never handed out.
    next_id: u32,
    /// The data of the last `world_export_changed`, until `take_changed_data` takes it.
    changed_data: Vec<f32>,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    /// An empty registry; its first world gets id 1.
    pub const fn new() -> Self {
        Self { worlds: BTreeMap::new(), next_id: FIRST_ID, changed_data: Vec::new() }
    }

    /// Runs `f` on world `id`, or gives `missing` when there is none.
    fn with_world<T>(&mut self, id: u32, missing: T, f: impl FnOnce(&mut World) -> T) -> T {
        match self.worlds.get_mut(&id) {
            Some(world) => f(world),
            None => missing,
        }
    }

    /// Runs a call with a result on world `id` and writes it as JSON text.
    fn call(&mut self, id: u32, f: impl FnOnce(&mut World) -> String) -> String {
        self.with_world(id, output::failure(&internal(NO_WORLD)), f)
    }

    /// Makes a world from its JSON description (§4): `{ ok: true, id }` or a failure.
    pub fn world_create(&mut self, desc: &str) -> String {
        let made = input::json(desc).and_then(|value| WorldDesc::from_json(&value)).and_then(|desc| World::create(&desc));
        let world = match made {
            Ok(world) => world,
            Err(refused) => return output::failure(&refused),
        };
        let id = self.next_id;
        if id == u32::MAX {
            return output::failure(&internal(NO_IDS));
        }
        self.next_id = id + 1;
        self.worlds.insert(id, Box::new(world));
        output::ok_with([("id", serde_json::json!(id))])
    }

    /// Frees world `id` and its memory; `false` when there was none.
    pub fn world_free(&mut self, id: u32) -> bool {
        self.worlds.remove(&id).is_some()
    }

    /// How many worlds this registry holds.
    pub fn live_worlds(&self) -> u32 {
        self.worlds.len() as u32
    }

    /// `internal` when the world failed earlier or does not exist, else `{ ok: true }`.
    pub fn world_check(&mut self, id: u32) -> String {
        self.call(id, |world| output::unit(world.check()))
    }

    /// The resolved description as JSON (§4), or `null`.
    pub fn world_desc(&mut self, id: u32) -> String {
        self.with_world(id, "null".to_string(), |world| output::desc(world.desc()))
    }

    /// The tick counter (0 for no world).
    pub fn world_tick(&mut self, id: u32) -> f64 {
        self.with_world(id, 0.0, |world| world.tick() as f64)
    }

    /// Applies one command in its JSON form (§7.3).
    pub fn world_command(&mut self, id: u32, command: &str) -> String {
        self.call(id, |world| {
            let parsed = input::json(command).and_then(|value| Command::from_json(&value));
            output::unit(parsed.and_then(|command| world.command(&command)))
        })
    }

    /// Applies a JSON array of commands (§7.1): atomic gives `{ ok }` or the first failure, each
    /// gives `{ ok: true, results }`.
    pub fn world_apply(&mut self, id: u32, commands: &str, atomic: bool) -> String {
        if !atomic {
            return match self.apply_each(id, input::json(commands)) {
                Ok(outcomes) => output::outcomes(&outcomes),
                Err(refused) => output::failure(&refused),
            };
        }
        self.call(id, |world| {
            let applied = input::json(commands).and_then(|value| world.apply_json_atomic(&value));
            match applied {
                Ok(()) => output::ok(),
                Err(refused) => output::failure(&refused),
            }
        })
    }

    /// An `"each"` apply of commands already read (§7.1): `internal` for no world, else the read's
    /// own refusal or one outcome per command. `world_apply` and a tick share it.
    fn apply_each(&mut self, id: u32, commands: Result<serde_json::Value, PhysicsFailure>) -> Result<Vec<CommandOutcome>, PhysicsFailure> {
        let Some(world) = self.worlds.get_mut(&id) else { return Err(internal(NO_WORLD)) };
        commands.and_then(|value| world.apply_json_each(&value))
    }

    /// Imports §17.7's static world (§6.5) from its flat form: each list's row lengths and values.
    pub fn world_add_static(&mut self, id: u32, box_lengths: &[u32], boxes: &[f64], ramp_lengths: &[u32], ramps: &[f64]) -> String {
        self.call(id, |world| {
            let parsed = input::static_world(box_lengths, boxes, ramp_lengths, ramps);
            output::unit(parsed.and_then(|statics| world.add_static_world(&statics)))
        })
    }

    /// Steps the world once (§8).
    pub fn world_step(&mut self, id: u32) -> String {
        match self.step(id) {
            Ok(result) => output::step(&result),
            Err(refused) => output::failure(&refused),
        }
    }

    /// One step (§8), or `internal` for no world. `world_step` and a tick share it.
    fn step(&mut self, id: u32) -> Result<StepResult, PhysicsFailure> {
        self.with_world(id, Err(internal(NO_WORLD)), World::step)
    }

    /// Records the wall time the host measured around the last step (§11.4).
    pub fn world_record_step_ms(&mut self, id: u32, ms: f64) -> String {
        self.call(id, |world| output::unit(world.record_step_ms(ms)))
    }

    /// One body's state as JSON, or `null` (§9.1).
    pub fn world_body(&mut self, id: u32, key: &str) -> String {
        self.with_world(id, "null".to_string(), |world| {
            world.body(key).map_or("null".to_string(), |state| output::body_state(&state).to_string())
        })
    }

    /// The bodies a filter selects (§9.1), as a JSON array: `kinds` a JSON array of strings or
    /// absent, `changed_since` a tick or any negative number for none. A malformed `kinds` selects
    /// nothing.
    pub fn world_bodies(&mut self, id: u32, kinds: Option<&str>, awake_only: bool, changed_since: f64) -> String {
        let kinds = match kinds.map(input::kinds).transpose() {
            Ok(kinds) => kinds,
            Err(_) => return "[]".to_string(),
        };
        let changed_since_tick = (changed_since >= FIRST_TICK).then_some(changed_since as u64);
        let filter = BodyFilter { kinds, awake_only, changed_since_tick };
        self.with_world(id, "[]".to_string(), |world| {
            serde_json::Value::Array(world.bodies(&filter).iter().map(output::body_state).collect()).to_string()
        })
    }

    /// The bodies changed after `since` (§9.1): their keys as a JSON array; their 14 numbers each
    /// wait for [`Registry::take_changed_data`]. No world gives `[]` and no data.
    pub fn world_export_changed(&mut self, id: u32, since: f64) -> String {
        let export = self.export_changed(id, since);
        self.changed_data = export.data;
        serde_json::json!(export.keys).to_string()
    }

    /// The bodies changed after `since` and their data; none for no world. Shared with a tick.
    fn export_changed(&mut self, id: u32, since: f64) -> ChangedExport {
        self.with_world(id, None, |world| Some(world.export_changed(since.max(FIRST_TICK) as u64))).unwrap_or_default()
    }

    /// The data of the last [`Registry::world_export_changed`], handed over once.
    pub fn take_changed_data(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.changed_data)
    }

    /// A body's replicated fields as JSON, or `null` (§9.2).
    pub fn world_export_body_state(&mut self, id: u32, key: &str) -> String {
        let state = self.with_world(id, None, |world| world.export_body_state(key));
        state.map_or("null".to_string(), |state| output::net_state(&state).to_string())
    }

    /// Sets a body's replicated fields from their JSON form (§9.2).
    pub fn world_import_body_state(&mut self, id: u32, key: &str, state: &str) -> String {
        self.call(id, |world| output::unit(input::net_state(state).and_then(|state| world.import_body_state(key, &state))))
    }

    /// Imports many bodies' replicated fields at once (§19.1): `keys` a JSON array of strings,
    /// `data` 14 numbers per key in `exportChanged`'s layout. All or none; a refusal names its index.
    pub fn world_import_states(&mut self, id: u32, keys: &str, data: &[f32]) -> String {
        self.call(id, |world| output::unit(input::keys(keys).and_then(|keys| world.import_states(&keys, data))))
    }

    /// Runs a JSON array of queries (§19.2): `{ ok: true, results }`, one result per query as
    /// [`Registry::world_query`] writes it, or one failure for a non-array (or `internal`).
    pub fn world_query_many(&mut self, id: u32, queries: &str) -> String {
        match self.query_many(id, input::json(queries)) {
            Ok(outcomes) => output::answers(&outcomes),
            Err(refused) => output::failure(&refused),
        }
    }

    /// A `queryMany` of queries already read (§19.2): `internal` for no world, else the read's own
    /// refusal or one outcome per query. `world_query_many` and a tick share it.
    fn query_many(&mut self, id: u32, queries: Result<serde_json::Value, PhysicsFailure>) -> Result<Vec<QueryOutcome>, PhysicsFailure> {
        let Some(world) = self.worlds.get_mut(&id) else { return Err(internal(NO_WORLD)) };
        queries.and_then(|value| world.query_many_json(&value))
    }

    /// One room tick in one crossing (`tick.rs`): each batch as `world_apply(batch, false)`, the step
    /// as `world_step` (its wall time on `now_ms`'s clock recorded for `stats().stepMs`, §11.4),
    /// the export as `world_export_changed`, the queries as `world_query_many`, then the tick
    /// counter and `memoryBytes`; each part exactly what that call gives, in the reply's binary form.
    pub fn world_tick_frame(&mut self, id: u32, request: TickRequest, now_ms: &mut dyn FnMut() -> f64) -> Vec<u8> {
        let TickRequest { batches, step, export_since, queries } = request;
        let mut out = tick::Out::new(batches.len());
        for batch in batches {
            out.batch(&self.apply_each(id, batch.read()));
        }
        let stepped = step.then(|| {
            let start = now_ms();
            let stepped = self.step(id);
            if stepped.is_ok() {
                self.world_record_step_ms(id, now_ms() - start);
            }
            stepped
        });
        out.step(stepped.as_ref());
        drop(stepped);
        let export = (export_since >= FIRST_TICK).then(|| self.export_changed(id, export_since));
        out.export(export.as_ref());
        drop(export);
        let answers = queries.map(|queries| self.query_many(id, queries.read()));
        out.answers(answers.as_ref());
        drop(answers);
        out.finish(self.world_tick(id), self.world_memory_bytes(id))
    }

    /// Runs one query in its JSON form (§13).
    pub fn world_query(&mut self, id: u32, query: &str) -> String {
        self.call(id, |world| {
            let answered = input::json(query).and_then(|value| Query::from_json(&value)).and_then(|query| world.query(&query));
            match answered {
                Ok(answer) => output::answer(&answer),
                Err(refused) => output::failure(&refused),
            }
        })
    }

    /// The world's snapshot (§9.4), or nothing when the world failed or does not exist.
    pub fn world_snapshot(&mut self, id: u32) -> Option<Vec<u8>> {
        self.with_world(id, None, |world| world.snapshot().ok())
    }

    /// Replaces the world from a snapshot (§9.4).
    pub fn world_restore(&mut self, id: u32, bytes: &[u8]) -> String {
        self.call(id, |world| output::unit(world.restore(bytes)))
    }

    /// `stateHash` (§10.1), 16 hex digits; empty for no world.
    pub fn world_state_hash(&mut self, id: u32) -> String {
        self.with_world(id, String::new(), |world| world.state_hash_hex())
    }

    /// `physicsHash` (§10.2), 16 hex digits; empty for no world.
    pub fn world_physics_hash(&mut self, id: u32) -> String {
        self.with_world(id, String::new(), |world| world.physics_hash())
    }

    /// The world's counters (§11) as JSON, or `null`.
    pub fn world_stats(&mut self, id: u32) -> String {
        self.with_world(id, "null".to_string(), |world| output::stats(&world.stats()))
    }

    /// The world's `stats().memoryBytes` (§11.1) as a number, without the JSON; 0 for no world.
    pub fn world_memory_bytes(&mut self, id: u32) -> f64 {
        self.with_world(id, 0.0, |world| world.stats().memory_bytes as f64)
    }

    /// Whether the counting allocator measures this world's memory (§11.1); `false` for no world.
    pub fn world_memory_is_measured(&mut self, id: u32) -> bool {
        self.with_world(id, false, |world| world.memory_is_measured())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const DESC: &str = r#"{"contract":"1.0","dt":0.016666668,"substeps":1,"gravity":[0,-9.81,0],"upAxis":"y","lengthUnit":1}"#;
    const CRATE: &str = r#"{"spawn":{"key":"crate","type":"dynamic","pose":{"p":[0,2,0],"q":[0,0,0,1]},"colliders":[{"key":"c","shape":{"kind":"box","half":[0.5,0.5,0.5]}}]}}"#;

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("the binding writes JSON")
    }

    fn create(registry: &mut Registry) -> u32 {
        let made = parse(&registry.world_create(DESC));
        made["id"].as_u64().expect("an id") as u32
    }

    #[test]
    fn a_world_is_made_driven_read_and_freed_by_id() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        assert_eq!(parse(&registry.world_command(id, CRATE))["ok"], true);
        let stepped = parse(&registry.world_step(id));
        assert_eq!((stepped["ok"].clone(), stepped["tick"].clone()), (Value::Bool(true), serde_json::json!(1)));
        assert_eq!(parse(&registry.world_body(id, "crate"))["type"], "dynamic");
        assert_eq!(parse(&registry.world_stats(id))["bodies"], 1);
        assert!(registry.world_memory_is_measured(id), "the counting allocator is installed in this binary");
        assert_eq!(registry.world_state_hash(id).len(), 16);
        assert!(registry.world_free(id));
        assert!(!registry.world_free(id), "an id is freed once");
        assert_eq!(parse(&registry.world_step(id))["code"], "internal");
        let reads = (registry.world_body(id, "crate"), registry.world_stats(id), registry.world_state_hash(id));
        assert_eq!(reads, ("null".into(), "null".into(), String::new()));
    }

    #[test]
    fn ids_are_never_reused() {
        let mut registry = Registry::new();
        let first = create(&mut registry);
        registry.world_free(first);
        let second = create(&mut registry);
        assert!(second > first);
        registry.world_free(second);
    }

    #[test]
    fn the_last_id_is_never_handed_out_and_a_refusal_takes_none() {
        let mut registry = Registry { next_id: u32::MAX - 1, ..Registry::new() };
        assert_eq!(create(&mut registry), u32::MAX - 1);
        let refused = parse(&registry.world_create(DESC));
        assert_eq!((refused["code"].clone(), refused["detail"].clone()), (serde_json::json!("internal"), serde_json::json!(NO_IDS)));
        assert_eq!(registry.live_worlds(), 1);
        assert_eq!(parse(&registry.world_create(DESC))["detail"], NO_IDS, "it stays refused");
    }

    #[test]
    fn a_refused_world_takes_no_id_and_names_the_core_code() {
        let mut registry = Registry::new();
        let refused = parse(&registry.world_create(r#"{"contract":"2.0"}"#));
        assert_eq!((refused["ok"].clone(), refused["code"].clone()), (Value::Bool(false), serde_json::json!("contract-mismatch")));
        assert_eq!(parse(&registry.world_create("not json"))["code"], "bad-command");
        assert_eq!(registry.live_worlds(), 0);
        assert_eq!(create(&mut registry), FIRST_ID, "the refusals took no id");
    }

    #[test]
    fn memory_follows_spawns_and_returns_when_bodies_go() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        let empty = parse(&registry.world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert_eq!(parse(&registry.world_command(id, CRATE))["ok"], true);
        let one = parse(&registry.world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert!(one > empty, "a spawn is charged to its world: {empty} -> {one}");
        assert_eq!(registry.world_memory_bytes(id), one as f64, "the number stats() writes");
        assert_eq!(parse(&registry.world_command(id, r#"{"remove":{"key":"crate"}}"#))["ok"], true);
        let after = parse(&registry.world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert!(after < one, "a removal credits it back: {one} -> {after}");
        registry.world_free(id);
        assert_eq!(registry.world_memory_bytes(id), 0.0, "no world, no bytes");
    }

    #[test]
    fn export_changed_hands_its_data_over_once() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        registry.world_command(id, CRATE);
        assert_eq!(parse(&registry.world_export_changed(id, 0.0)), serde_json::json!(["crate"]));
        assert_eq!(registry.take_changed_data().len(), genex_physics::EXPORT_STRIDE);
        assert!(registry.take_changed_data().is_empty());
        registry.world_free(id);
    }

    #[test]
    fn import_states_takes_export_changed_s_data_and_refuses_with_an_index() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        registry.world_command(id, CRATE);
        registry.world_command(id, &CRATE.replace(r#""key":"crate""#, r#""key":"crate2""#));
        for _ in 0..5 {
            registry.world_step(id);
        }
        let keys = registry.world_export_changed(id, 0.0);
        let mut data = registry.take_changed_data();
        let hash = registry.world_state_hash(id);
        assert_eq!(parse(&registry.world_import_states(id, &keys, &data))["ok"], true);
        assert_eq!(registry.world_state_hash(id), hash, "the world's own export imports as it was read");
        data[genex_physics::EXPORT_STRIDE] = f32::NAN;
        let refused = parse(&registry.world_import_states(id, &keys, &data));
        assert_eq!((refused["code"].clone(), refused["index"].clone()), (serde_json::json!("non-finite"), serde_json::json!(1)));
        assert_eq!(parse(&registry.world_import_states(id, "[1]", &[]))["code"], "bad-command");
        assert_eq!(parse(&registry.world_import_states(id, &keys, &data[1..]))["code"], "bad-command");
        assert_eq!(registry.world_state_hash(id), hash, "a refusal changes nothing");
        registry.world_free(id);
        assert_eq!(parse(&registry.world_import_states(id, "[]", &[]))["code"], "internal");
    }

    #[test]
    fn query_many_writes_each_result_as_query_does() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        registry.world_command(id, CRATE);
        let queries = [r#"{"ray":{"origin":[0,9,0],"dir":[0,-1,0],"maxDist":20}}"#, r#"{"ray":{"origin":[0,9,0],"dir":[0,0,0],"maxDist":20}}"#, "{}"];
        let many = parse(&registry.world_query_many(id, &format!("[{}]", queries.join(","))));
        let single: Vec<Value> = queries.iter().map(|query| parse(&registry.world_query(id, query))).collect();
        assert_eq!(many["results"], Value::Array(single));
        assert_eq!(parse(&registry.world_query_many(id, "{}"))["code"], "bad-command");
        assert_eq!(parse(&registry.world_query_many(id, "not json"))["code"], "bad-command");
        registry.world_free(id);
    }

    #[test]
    fn apply_each_reports_one_result_per_command_and_atomic_the_first_failure() {
        let mut registry = Registry::new();
        let id = create(&mut registry);
        let batch = format!(r#"[{CRATE},{{"wake":{{"key":"nobody"}}}}]"#);
        let each = parse(&registry.world_apply(id, &batch, false));
        assert_eq!(each["results"], serde_json::json!([{ "ok": true }, { "ok": false, "code": "unknown-key" }]));
        let atomic = parse(&registry.world_apply(id, r#"[{"wake":{"key":"crate"}},{"wake":{"key":"nobody"}}]"#, true));
        assert_eq!((atomic["code"].clone(), atomic["index"].clone()), (serde_json::json!("unknown-key"), serde_json::json!(1)));
        registry.world_free(id);
    }

    /// A cursor over a tick reply, for the rows below.
    struct Reply<'a>(&'a [u8]);

    impl Reply<'_> {
        fn take(&mut self, count: usize) -> &[u8] {
            let (head, tail) = self.0.split_at(count);
            self.0 = tail;
            head
        }
        fn u8(&mut self) -> u8 {
            self.take(1)[0]
        }
        fn u32(&mut self) -> u32 {
            u32::from_le_bytes(self.take(4).try_into().expect("4 bytes"))
        }
        fn f64(&mut self) -> f64 {
            f64::from_le_bytes(self.take(8).try_into().expect("8 bytes"))
        }
        fn str(&mut self) -> String {
            let length = self.u32() as usize;
            String::from_utf8(self.take(length).to_vec()).expect("UTF-8")
        }
    }

    #[test]
    fn a_tick_frame_gives_what_the_separate_calls_give() {
        let (mut framed, mut called) = (Registry::new(), Registry::new());
        let (one, two) = (create(&mut framed), create(&mut called));
        let batch = format!("[{CRATE}]");
        let wake = r#"[{"wake":{"key":"nobody"}}]"#;
        let ray = r#"[{"ray":{"origin":[0,9,0],"dir":[0,-1,0],"maxDist":20}}]"#;
        let request = TickRequest {
            batches: vec![tick::Item::Value(parse(&batch)), tick::Item::Text(wake.into()), tick::Item::NoText],
            step: true,
            export_since: 0.0,
            queries: Some(tick::Item::Value(parse(ray))),
        };
        let mut clock = 0.0;
        let bytes = framed.world_tick_frame(one, request, &mut || {
            clock += 2.5;
            clock
        });
        let applied = [called.world_apply(two, &batch, false), called.world_apply(two, wake, false)];
        assert_eq!(parse(&applied[0])["results"], serde_json::json!([{ "ok": true }]));
        let stepped = parse(&called.world_step(two));
        let keys = parse(&called.world_export_changed(two, 0.0));
        let data = called.take_changed_data();
        let answers = parse(&called.world_query_many(two, ray));

        let mut reply = Reply(&bytes);
        assert_eq!(reply.u32(), 3);
        assert_eq!((reply.u8(), reply.u32(), reply.u8()), (1, 1, 0), "the spawn: one ok");
        assert_eq!((reply.u8(), reply.u32(), reply.u8(), reply.str()), (1, 1, 1, "unknown-key".into()));
        assert_eq!((reply.u8(), reply.str()), (0, "bad-command".into()), "a batch with no text is refused whole");
        assert_eq!((reply.u8(), reply.str()), (0, tick::NOT_JSON.into()), "no index; its detail");
        assert_eq!((reply.u8(), reply.f64()), (2, stepped["tick"].as_f64().expect("tick")));
        assert_eq!((reply.u32(), reply.u8(), reply.u32(), reply.u8()), (0, 0, 0, 0), "no events, escapes or overflow");
        assert_eq!((reply.u8(), reply.u32(), reply.str()), (1, 1, keys[0].as_str().expect("key").to_string()));
        assert_eq!(reply.u32() as usize, data.len());
        let framed_data: Vec<u32> = (0..data.len()).map(|_| u32::from_le_bytes(reply.take(4).try_into().expect("f32"))).collect();
        assert_eq!(framed_data, data.iter().map(|value| value.to_bits()).collect::<Vec<_>>(), "the data bit for bit");
        let hit = &answers["results"][0]["hit"];
        assert_eq!((reply.u8(), reply.u32(), reply.u8()), (2, 1, 2));
        assert_eq!((reply.str(), reply.str(), reply.f64()), ("crate".into(), "c".into(), hit["dist"].as_f64().expect("dist")));
        for _ in 0..6 {
            reply.f64();
        }
        assert_eq!(reply.f64(), 1.0, "the tick after");
        assert_eq!(reply.f64(), called.world_memory_bytes(two));
        assert!(reply.0.is_empty(), "nothing left over");
        assert_eq!(framed.world_state_hash(one), called.world_state_hash(two));
        assert_eq!(parse(&framed.world_stats(one))["stepMs"], 2.5, "the step's own time on the clock given");
    }

    #[test]
    fn a_tick_frame_on_no_world_answers_internal_in_every_part() {
        let mut registry = Registry::new();
        let request = TickRequest { batches: vec![tick::Item::Value(parse("[]"))], step: true, export_since: 0.0, queries: None };
        let bytes = registry.world_tick_frame(7, request, &mut || 0.0);
        let mut reply = Reply(&bytes);
        assert_eq!((reply.u32(), reply.u8(), reply.str()), (1, 0, "internal".into()));
        assert_eq!((reply.u8(), reply.str()), (0, NO_WORLD.into()));
        assert_eq!((reply.u8(), reply.str()), (1, "internal".into()));
        assert_eq!((reply.u8(), reply.str()), (0, NO_WORLD.into()));
        assert_eq!((reply.u8(), reply.u32(), reply.u32()), (1, 0, 0), "an empty export");
        assert_eq!((reply.u8(), reply.f64(), reply.f64()), (0, 0.0, 0.0));
        assert!(reply.0.is_empty());
    }

    #[test]
    fn two_registries_hold_their_own_worlds_and_ids() {
        let (mut one, mut two) = (Registry::new(), Registry::new());
        let (first, other) = (create(&mut one), create(&mut two));
        assert_eq!((first, other), (FIRST_ID, FIRST_ID), "each registry numbers its own worlds");
        one.world_command(first, CRATE);
        assert_eq!(parse(&one.world_stats(first))["bodies"], 1);
        assert_eq!(parse(&two.world_stats(other))["bodies"], 0);
        assert!(one.world_free(first));
        assert_eq!((one.live_worlds(), two.live_worlds()), (0, 1));
    }
}
