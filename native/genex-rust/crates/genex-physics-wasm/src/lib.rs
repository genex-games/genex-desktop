//! genex-physics-wasm: the WebAssembly binding of Genex Physics, contract 1.0
//! (`../genex-physics/CONTRACT.md`; section numbers below are its own).
//!
//! These are the wasm-bindgen exports under the `@genex-ai/physics` npm package. The package's
//! hand-written wrapper (`../genex-physics/js/core.js`) is the API; these exports are its private
//! wire and change with it. Worlds live in this instance's registry, addressed by an id that is
//! never reused. Values cross as JSON text in the TypeScript shapes (`output`), except the static
//! world (flat f64 arrays, `input`), `exportChanged`'s data (a `Float32Array`) and snapshots
//! (bytes). Every export returns a value for every input; an id that names no world (never made,
//! or freed) gives `internal` where the call has a result, and the empty form where it has none.
//!
//! # Memory (§11.1)
//!
//! The binary installs genex-physics' [`CountingAllocator`] as its global allocator, so every
//! allocation a world's call makes is charged to that world and credited back when freed, whatever
//! call frees it. `stats().memoryBytes` is then the world's exact live bytes, even with many worlds
//! in one instance. Refusals (`LimitMemory`) are judged by the core's model before anything is
//! allocated, so none relies on an allocation failing.
//!
//! # Failure (§11.3)
//!
//! A WASM build aborts on a panic: the instance traps (`unreachable`) and is unusable. The wrapper
//! catches the trap, marks the instance poisoned and answers `internal` from then on; the
//! `test-trap` feature adds [`test_trap`] so its tests can cause one.

use std::alloc::System;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use genex_physics::accounting::CountingAllocator;
use genex_physics::{ApplyMode, BodyFilter, Command, PhysicsError, PhysicsFailure, Query, World, WorldDesc};
use wasm_bindgen::prelude::wasm_bindgen;

mod input;
mod output;

/// Every allocation is charged to the world whose call is running (§11.1).
#[global_allocator]
static ALLOCATOR: CountingAllocator<System> = CountingAllocator::new(System);

/// The detail of a call on an id that names no world.
const NO_WORLD: &str = "no such world: it was freed, or never made";
/// The detail when the registry ran out of ids (after 2^32 - 1 worlds in one instance).
const NO_IDS: &str = "this instance has made every world it can; make a new instance";
/// The first tick. `bodies()` takes a smaller `changed_since` (the wrapper passes -1) as no filter.
const FIRST_TICK: f64 = 0.0;

thread_local! {
    /// The live worlds by id.
    static WORLDS: RefCell<BTreeMap<u32, Box<World>>> = const { RefCell::new(BTreeMap::new()) };
    /// The next id; 0 is never handed out.
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
    /// The data of the last `world_export_changed`, until `take_changed_data` takes it.
    static CHANGED_DATA: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

fn internal(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::Internal, detail)
}

/// Runs `f` on world `id`, or gives `missing` when there is none.
fn with_world<T>(id: u32, missing: T, f: impl FnOnce(&mut World) -> T) -> T {
    WORLDS.with_borrow_mut(|worlds| match worlds.get_mut(&id) {
        Some(world) => f(world),
        None => missing,
    })
}

/// Runs a call with a result on world `id` and writes it as JSON text.
fn call(id: u32, f: impl FnOnce(&mut World) -> String) -> String {
    with_world(id, output::failure(&internal(NO_WORLD)), f)
}

/// This build's identity (§2), e.g. `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+wasm32`.
#[wasm_bindgen]
pub fn build_id() -> String {
    genex_physics::build_id()
}

/// Makes a world from its JSON description (§4): `{ ok: true, id }` or a failure.
#[wasm_bindgen]
pub fn world_create(desc: &str) -> String {
    let made = input::json(desc).and_then(|value| WorldDesc::from_json(&value)).and_then(|desc| World::create(&desc));
    let world = match made {
        Ok(world) => world,
        Err(refused) => return output::failure(&refused),
    };
    let id = NEXT_ID.get();
    if id == u32::MAX {
        return output::failure(&internal(NO_IDS));
    }
    NEXT_ID.set(id + 1);
    WORLDS.with_borrow_mut(|worlds| worlds.insert(id, Box::new(world)));
    output::ok_with([("id", serde_json::json!(id))])
}

/// Frees world `id` and its memory; `false` when there was none.
#[wasm_bindgen]
pub fn world_free(id: u32) -> bool {
    WORLDS.with_borrow_mut(|worlds| worlds.remove(&id)).is_some()
}

/// How many worlds this instance holds.
#[wasm_bindgen]
pub fn live_worlds() -> u32 {
    WORLDS.with_borrow(|worlds| worlds.len() as u32)
}

/// `internal` when the world failed earlier or does not exist, else `{ ok: true }`.
#[wasm_bindgen]
pub fn world_check(id: u32) -> String {
    call(id, |world| output::unit(world.check()))
}

/// The resolved description as JSON (§4), or `null`.
#[wasm_bindgen]
pub fn world_desc(id: u32) -> String {
    with_world(id, "null".to_string(), |world| output::desc(world.desc()))
}

/// The tick counter (0 for no world).
#[wasm_bindgen]
pub fn world_tick(id: u32) -> f64 {
    with_world(id, 0.0, |world| world.tick() as f64)
}

/// Applies one command in its JSON form (§7.3).
#[wasm_bindgen]
pub fn world_command(id: u32, command: &str) -> String {
    call(id, |world| {
        let parsed = input::json(command).and_then(|value| Command::from_json(&value));
        output::unit(parsed.and_then(|command| world.command(&command)))
    })
}

/// Applies a JSON array of commands (§7.1): atomic gives `{ ok }` or the first failure, each gives
/// `{ ok: true, results }`.
#[wasm_bindgen]
pub fn world_apply(id: u32, commands: &str, atomic: bool) -> String {
    call(id, |world| {
        let value = match input::json(commands) {
            Ok(value) => value,
            Err(refused) => return output::failure(&refused),
        };
        let mode = if atomic { ApplyMode::Atomic } else { ApplyMode::Each };
        let applied = match mode {
            ApplyMode::Atomic => world.apply_json_atomic(&value).map(|()| None),
            ApplyMode::Each => world.apply_json_each(&value).map(Some),
        };
        match applied {
            Ok(None) => output::ok(),
            Ok(Some(outcomes)) => output::outcomes(&outcomes),
            Err(refused) => output::failure(&refused),
        }
    })
}

/// Imports §17.7's static world (§6.5) from its flat form: each list's row lengths and values.
#[wasm_bindgen]
pub fn world_add_static(id: u32, box_lengths: &[u32], boxes: &[f64], ramp_lengths: &[u32], ramps: &[f64]) -> String {
    call(id, |world| {
        let parsed = input::static_world(box_lengths, boxes, ramp_lengths, ramps);
        output::unit(parsed.and_then(|statics| world.add_static_world(&statics)))
    })
}

/// Steps the world once (§8).
#[wasm_bindgen]
pub fn world_step(id: u32) -> String {
    call(id, |world| match world.step() {
        Ok(result) => output::step(&result),
        Err(refused) => output::failure(&refused),
    })
}

/// Records the wall time the wrapper measured around the last step (§11.4).
#[wasm_bindgen]
pub fn world_record_step_ms(id: u32, ms: f64) -> String {
    call(id, |world| output::unit(world.record_step_ms(ms)))
}

/// One body's state as JSON, or `null` (§9.1).
#[wasm_bindgen]
pub fn world_body(id: u32, key: &str) -> String {
    with_world(id, "null".to_string(), |world| world.body(key).map_or("null".to_string(), |state| output::body_state(&state).to_string()))
}

/// The bodies a filter selects (§9.1), as a JSON array: `kinds` a JSON array of strings or absent,
/// `changed_since` a tick or any negative number for none. A malformed `kinds` selects nothing.
#[wasm_bindgen]
pub fn world_bodies(id: u32, kinds: Option<String>, awake_only: bool, changed_since: f64) -> String {
    let kinds = match kinds.as_deref().map(input::kinds).transpose() {
        Ok(kinds) => kinds,
        Err(_) => return "[]".to_string(),
    };
    let changed_since_tick = (changed_since >= FIRST_TICK).then_some(changed_since as u64);
    let filter = BodyFilter { kinds, awake_only, changed_since_tick };
    with_world(id, "[]".to_string(), |world| {
        serde_json::Value::Array(world.bodies(&filter).iter().map(output::body_state).collect()).to_string()
    })
}

/// The bodies changed after `since` (§9.1): their keys as a JSON array; their 14 numbers each wait
/// for [`take_changed_data`].
#[wasm_bindgen]
pub fn world_export_changed(id: u32, since: f64) -> String {
    let export = with_world(id, None, |world| Some(world.export_changed(since.max(FIRST_TICK) as u64))).unwrap_or_default();
    CHANGED_DATA.set(export.data);
    serde_json::json!(export.keys).to_string()
}

/// The data of the last [`world_export_changed`], handed over once.
#[wasm_bindgen]
pub fn take_changed_data() -> Vec<f32> {
    CHANGED_DATA.take()
}

/// A body's replicated fields as JSON, or `null` (§9.2).
#[wasm_bindgen]
pub fn world_export_body_state(id: u32, key: &str) -> String {
    let state = with_world(id, None, |world| world.export_body_state(key));
    state.map_or("null".to_string(), |state| output::net_state(&state).to_string())
}

/// Sets a body's replicated fields from their JSON form (§9.2).
#[wasm_bindgen]
pub fn world_import_body_state(id: u32, key: &str, state: &str) -> String {
    call(id, |world| output::unit(input::net_state(state).and_then(|state| world.import_body_state(key, &state))))
}

/// Runs one query in its JSON form (§13).
#[wasm_bindgen]
pub fn world_query(id: u32, query: &str) -> String {
    call(id, |world| {
        let answered = input::json(query).and_then(|value| Query::from_json(&value)).and_then(|query| world.query(&query));
        match answered {
            Ok(answer) => output::answer(&answer),
            Err(refused) => output::failure(&refused),
        }
    })
}

/// The world's snapshot (§9.4), or nothing when the world failed or does not exist.
#[wasm_bindgen]
pub fn world_snapshot(id: u32) -> Option<Vec<u8>> {
    with_world(id, None, |world| world.snapshot().ok())
}

/// Replaces the world from a snapshot (§9.4).
#[wasm_bindgen]
pub fn world_restore(id: u32, bytes: &[u8]) -> String {
    call(id, |world| output::unit(world.restore(bytes)))
}

/// `stateHash` (§10.1), 16 hex digits; empty for no world.
#[wasm_bindgen]
pub fn world_state_hash(id: u32) -> String {
    with_world(id, String::new(), |world| world.state_hash_hex())
}

/// `physicsHash` (§10.2), 16 hex digits; empty for no world.
#[wasm_bindgen]
pub fn world_physics_hash(id: u32) -> String {
    with_world(id, String::new(), |world| world.physics_hash())
}

/// The world's counters (§11) as JSON, or `null`.
#[wasm_bindgen]
pub fn world_stats(id: u32) -> String {
    with_world(id, "null".to_string(), |world| output::stats(&world.stats()))
}

/// Whether the counting allocator measures this world's memory (§11.1).
#[wasm_bindgen]
pub fn world_memory_is_measured(id: u32) -> bool {
    with_world(id, false, |world| world.memory_is_measured())
}

/// The bytes of one WebAssembly memory page.
const WASM_PAGE_BYTES: f64 = 65_536.0;

/// The instance's linear memory in bytes (it only grows); 0 off wasm32.
#[wasm_bindgen]
pub fn wasm_memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    let pages = core::arch::wasm32::memory_size(0) as f64;
    #[cfg(not(target_arch = "wasm32"))]
    let pages = 0.0;
    pages * WASM_PAGE_BYTES
}

/// Test builds only: panics, which traps a WASM instance (§11.3's failure, on purpose).
#[cfg(feature = "test-trap")]
#[wasm_bindgen]
pub fn test_trap() {
    panic!("test_trap: the instance traps on purpose (§11.3)");
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

    fn create() -> u32 {
        let made = parse(&world_create(DESC));
        made["id"].as_u64().expect("an id") as u32
    }

    #[test]
    fn a_world_is_made_driven_read_and_freed_by_id() {
        let id = create();
        assert_eq!(parse(&world_command(id, CRATE))["ok"], true);
        let stepped = parse(&world_step(id));
        assert_eq!((stepped["ok"].clone(), stepped["tick"].clone()), (Value::Bool(true), serde_json::json!(1)));
        assert_eq!(parse(&world_body(id, "crate"))["type"], "dynamic");
        assert_eq!(parse(&world_stats(id))["bodies"], 1);
        assert!(world_memory_is_measured(id), "the counting allocator is installed in this binary");
        assert_eq!(world_state_hash(id).len(), 16);
        assert!(world_free(id));
        assert!(!world_free(id), "an id is freed once");
        assert_eq!(parse(&world_step(id))["code"], "internal");
        assert_eq!((world_body(id, "crate"), world_stats(id), world_state_hash(id)), ("null".into(), "null".into(), String::new()));
    }

    #[test]
    fn ids_are_never_reused() {
        let first = create();
        world_free(first);
        let second = create();
        assert!(second > first);
        world_free(second);
    }

    #[test]
    fn a_refused_world_takes_no_id_and_names_the_core_code() {
        let before = live_worlds();
        let refused = parse(&world_create(r#"{"contract":"2.0"}"#));
        assert_eq!((refused["ok"].clone(), refused["code"].clone()), (Value::Bool(false), serde_json::json!("contract-mismatch")));
        assert_eq!(parse(&world_create("not json"))["code"], "bad-command");
        assert_eq!(live_worlds(), before);
    }

    #[test]
    fn memory_follows_spawns_and_returns_when_bodies_go() {
        let id = create();
        let empty = parse(&world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert_eq!(parse(&world_command(id, CRATE))["ok"], true);
        let one = parse(&world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert!(one > empty, "a spawn is charged to its world: {empty} -> {one}");
        assert_eq!(parse(&world_command(id, r#"{"remove":{"key":"crate"}}"#))["ok"], true);
        let after = parse(&world_stats(id))["memoryBytes"].as_u64().expect("bytes");
        assert!(after < one, "a removal credits it back: {one} -> {after}");
        world_free(id);
    }

    #[test]
    fn export_changed_hands_its_data_over_once() {
        let id = create();
        world_command(id, CRATE);
        assert_eq!(parse(&world_export_changed(id, 0.0)), serde_json::json!(["crate"]));
        assert_eq!(take_changed_data().len(), genex_physics::EXPORT_STRIDE);
        assert!(take_changed_data().is_empty());
        world_free(id);
    }

    #[test]
    fn apply_each_reports_one_result_per_command_and_atomic_the_first_failure() {
        let id = create();
        let batch = format!(r#"[{CRATE},{{"wake":{{"key":"nobody"}}}}]"#);
        let each = parse(&world_apply(id, &batch, false));
        assert_eq!(each["results"], serde_json::json!([{ "ok": true }, { "ok": false, "code": "unknown-key" }]));
        let atomic = parse(&world_apply(id, r#"[{"wake":{"key":"crate"}},{"wake":{"key":"nobody"}}]"#, true));
        assert_eq!((atomic["code"].clone(), atomic["index"].clone()), (serde_json::json!("unknown-key"), serde_json::json!(1)));
        world_free(id);
    }
}
