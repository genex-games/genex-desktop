//! genex-physics-wasm: the WebAssembly binding of Genex Physics, contract 1.0
//! (`../genex-physics/CONTRACT.md`; section numbers below are its own).
//!
//! These are the wasm-bindgen exports under the `@genex-ai/physics` npm package. The package's
//! hand-written wrapper (`../genex-physics/js/core.js`) is the API; these exports are its private
//! wire and change with it. This crate is a thin shell: the logic lives in `genex-physics-binding`,
//! whose [`Registry`] holds this instance's worlds by an id that is never reused, reads the inputs
//! and writes the results, and is shared with the native shells. Each export keeps its name and
//! signature and forwards to the one registry of this instance (a thread-local: a WASM instance
//! runs on one thread). Values cross as JSON text in the TypeScript shapes, except the static
//! world (flat f64 arrays), `exportChanged`'s and `importStates`' data (a `Float32Array`) and
//! snapshots (bytes). Every export returns a value for every input; an id that names no world
//! (never made, or freed) gives `internal` where the call has a result, and the empty form where
//! it has none.
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
use std::cell::RefCell;

use genex_physics::accounting::CountingAllocator;
use genex_physics_binding::Registry;
use wasm_bindgen::prelude::wasm_bindgen;

/// Every allocation is charged to the world whose call is running (§11.1).
#[global_allocator]
static ALLOCATOR: CountingAllocator<System> = CountingAllocator::new(System);

thread_local! {
    /// This instance's worlds and the hand-over of `exportChanged`'s data.
    static REGISTRY: RefCell<Registry> = const { RefCell::new(Registry::new()) };
}

/// Runs `f` on this instance's registry.
fn registry<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with_borrow_mut(f)
}

/// This build's identity (§2), e.g. `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+wasm32`.
#[wasm_bindgen]
pub fn build_id() -> String {
    genex_physics_binding::build_id()
}

/// Makes a world from its JSON description (§4): `{ ok: true, id }` or a failure.
#[wasm_bindgen]
pub fn world_create(desc: &str) -> String {
    registry(|registry| registry.world_create(desc))
}

/// Frees world `id` and its memory; `false` when there was none.
#[wasm_bindgen]
pub fn world_free(id: u32) -> bool {
    registry(|registry| registry.world_free(id))
}

/// How many worlds this instance holds.
#[wasm_bindgen]
pub fn live_worlds() -> u32 {
    registry(|registry| registry.live_worlds())
}

/// `internal` when the world failed earlier or does not exist, else `{ ok: true }`.
#[wasm_bindgen]
pub fn world_check(id: u32) -> String {
    registry(|registry| registry.world_check(id))
}

/// The resolved description as JSON (§4), or `null`.
#[wasm_bindgen]
pub fn world_desc(id: u32) -> String {
    registry(|registry| registry.world_desc(id))
}

/// The tick counter (0 for no world).
#[wasm_bindgen]
pub fn world_tick(id: u32) -> f64 {
    registry(|registry| registry.world_tick(id))
}

/// Applies one command in its JSON form (§7.3).
#[wasm_bindgen]
pub fn world_command(id: u32, command: &str) -> String {
    registry(|registry| registry.world_command(id, command))
}

/// Applies a JSON array of commands (§7.1): atomic gives `{ ok }` or the first failure, each gives
/// `{ ok: true, results }`.
#[wasm_bindgen]
pub fn world_apply(id: u32, commands: &str, atomic: bool) -> String {
    registry(|registry| registry.world_apply(id, commands, atomic))
}

/// Imports §17.7's static world (§6.5) from its flat form: each list's row lengths and values.
#[wasm_bindgen]
pub fn world_add_static(id: u32, box_lengths: &[u32], boxes: &[f64], ramp_lengths: &[u32], ramps: &[f64]) -> String {
    registry(|registry| registry.world_add_static(id, box_lengths, boxes, ramp_lengths, ramps))
}

/// Steps the world once (§8).
#[wasm_bindgen]
pub fn world_step(id: u32) -> String {
    registry(|registry| registry.world_step(id))
}

/// Records the wall time the wrapper measured around the last step (§11.4).
#[wasm_bindgen]
pub fn world_record_step_ms(id: u32, ms: f64) -> String {
    registry(|registry| registry.world_record_step_ms(id, ms))
}

/// One body's state as JSON, or `null` (§9.1).
#[wasm_bindgen]
pub fn world_body(id: u32, key: &str) -> String {
    registry(|registry| registry.world_body(id, key))
}

/// The bodies a filter selects (§9.1), as a JSON array: `kinds` a JSON array of strings or absent,
/// `changed_since` a tick or any negative number for none. A malformed `kinds` selects nothing.
#[wasm_bindgen]
pub fn world_bodies(id: u32, kinds: Option<String>, awake_only: bool, changed_since: f64) -> String {
    registry(|registry| registry.world_bodies(id, kinds.as_deref(), awake_only, changed_since))
}

/// The bodies changed after `since` (§9.1): their keys as a JSON array; their 14 numbers each wait
/// for [`take_changed_data`].
#[wasm_bindgen]
pub fn world_export_changed(id: u32, since: f64) -> String {
    registry(|registry| registry.world_export_changed(id, since))
}

/// The data of the last [`world_export_changed`], handed over once.
#[wasm_bindgen]
pub fn take_changed_data() -> Vec<f32> {
    registry(Registry::take_changed_data)
}

/// A body's replicated fields as JSON, or `null` (§9.2).
#[wasm_bindgen]
pub fn world_export_body_state(id: u32, key: &str) -> String {
    registry(|registry| registry.world_export_body_state(id, key))
}

/// Sets a body's replicated fields from their JSON form (§9.2).
#[wasm_bindgen]
pub fn world_import_body_state(id: u32, key: &str, state: &str) -> String {
    registry(|registry| registry.world_import_body_state(id, key, state))
}

/// Imports many bodies' replicated fields at once (§19.1): `keys` a JSON array of strings, `data`
/// 14 numbers per key in `exportChanged`'s layout. All or none; a refusal names its index.
#[wasm_bindgen]
pub fn world_import_states(id: u32, keys: &str, data: &[f32]) -> String {
    registry(|registry| registry.world_import_states(id, keys, data))
}

/// Runs a JSON array of queries (§19.2): `{ ok: true, results }`, one result per query as
/// [`world_query`] writes it, or one failure for a non-array (or `internal`).
#[wasm_bindgen]
pub fn world_query_many(id: u32, queries: &str) -> String {
    registry(|registry| registry.world_query_many(id, queries))
}

/// Runs one query in its JSON form (§13).
#[wasm_bindgen]
pub fn world_query(id: u32, query: &str) -> String {
    registry(|registry| registry.world_query(id, query))
}

/// The world's snapshot (§9.4), or nothing when the world failed or does not exist.
#[wasm_bindgen]
pub fn world_snapshot(id: u32) -> Option<Vec<u8>> {
    registry(|registry| registry.world_snapshot(id))
}

/// Replaces the world from a snapshot (§9.4).
#[wasm_bindgen]
pub fn world_restore(id: u32, bytes: &[u8]) -> String {
    registry(|registry| registry.world_restore(id, bytes))
}

/// `stateHash` (§10.1), 16 hex digits; empty for no world.
#[wasm_bindgen]
pub fn world_state_hash(id: u32) -> String {
    registry(|registry| registry.world_state_hash(id))
}

/// `physicsHash` (§10.2), 16 hex digits; empty for no world.
#[wasm_bindgen]
pub fn world_physics_hash(id: u32) -> String {
    registry(|registry| registry.world_physics_hash(id))
}

/// The world's counters (§11) as JSON, or `null`.
#[wasm_bindgen]
pub fn world_stats(id: u32) -> String {
    registry(|registry| registry.world_stats(id))
}

/// Whether the counting allocator measures this world's memory (§11.1).
#[wasm_bindgen]
pub fn world_memory_is_measured(id: u32) -> bool {
    registry(|registry| registry.world_memory_is_measured(id))
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
    //! The registry's own behaviour is tested in genex-physics-binding; these check the shell: one
    //! registry per instance behind the exports, and this binary's counting allocator.

    use super::*;

    const DESC: &str = r#"{"contract":"1.0","dt":0.016666668,"substeps":1,"gravity":[0,-9.81,0],"upAxis":"y","lengthUnit":1}"#;
    const CRATE: &str = r#"{"spawn":{"key":"crate","type":"dynamic","pose":{"p":[0,2,0],"q":[0,0,0,1]},"colliders":[{"key":"c","shape":{"kind":"box","half":[0.5,0.5,0.5]}}]}}"#;

    #[test]
    fn the_exports_share_one_registry_with_this_binary_s_counting_allocator() {
        let made: serde_json::Value = serde_json::from_str(&world_create(DESC)).expect("JSON");
        let id = made["id"].as_u64().expect("an id") as u32;
        assert!(world_command(id, CRATE).contains(r#""ok":true"#));
        assert_eq!(world_tick(id), 0.0);
        assert!(world_step(id).contains(r#""tick":1"#));
        assert!(world_memory_is_measured(id), "the counting allocator is installed in this binary");
        assert!(world_export_changed(id, 0.0).contains("crate"));
        assert_eq!(take_changed_data().len(), genex_physics::EXPORT_STRIDE, "the data waits in the same registry");
        assert!(take_changed_data().is_empty());
        assert_eq!(build_id(), genex_physics::build_id());
        assert!(world_free(id));
        assert!(world_step(id).contains(r#""code":"internal""#));
    }
}
