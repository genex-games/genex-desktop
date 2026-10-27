//! The C ABI called as C would call it: the replies are the registry's text, and every pointer and
//! length argument has a hostile-input table that asserts the refusal code and no side effect (no
//! world made or changed, no out-argument written, no buffer freed).
//!
//! The library is one process-wide registry, so these rows never assert absolute world counts:
//! each makes its own world and compares that world's state before and after.

#![allow(unsafe_code, reason = "these rows call the C ABI with raw pointers, hostile ones on purpose")]

use std::ffi::c_char;
use std::ptr::{null, null_mut};

use genex_physics_capi::*;

const DESC: &str = r#"{"contract":"1.0","dt":0.016666668,"substeps":1,"gravity":[0,-9.81,0],"upAxis":"y","lengthUnit":1}"#;
const CRATE: &str = r#"[{"spawn":{"key":"crate","type":"dynamic","pose":{"p":[0,2,0],"q":[0,0,0,1]},"colliders":[{"key":"c","shape":{"kind":"box","half":[0.5,0.5,0.5]}}]}}]"#;

fn c(text: &str) -> *const c_char {
    text.as_ptr().cast()
}

/// Takes a reply out of the library as text and frees it.
fn take(mut buffer: GxphBytes) -> String {
    let text = if buffer.len == 0 {
        String::new()
    } else {
        // SAFETY: a buffer the library handed out holds `len` bytes until freed.
        let bytes = unsafe { std::slice::from_raw_parts(buffer.ptr, buffer.len) };
        String::from_utf8(bytes.to_vec()).expect("replies are UTF-8")
    };
    // SAFETY: a buffer the library handed out.
    assert_eq!(unsafe { gxph_buf_free(&mut buffer) }, GXPH_OK);
    assert_eq!(buffer, GxphBytes::EMPTY, "a freed buffer is zeroed");
    text
}

/// Frees a binary buffer.
fn release(mut buffer: GxphBytes) {
    // SAFETY: a buffer the library handed out.
    assert_eq!(unsafe { gxph_buf_free(&mut buffer) }, GXPH_OK);
}

/// A fresh world with one crate, stepped once.
fn world() -> *mut GxphWorld {
    let mut handle = null_mut();
    let mut reply = GxphBytes::EMPTY;
    // SAFETY: valid text and outs.
    assert_eq!(unsafe { gxph_world_create(c(DESC), DESC.len(), &mut handle, &mut reply) }, GXPH_OK);
    assert!(take(reply).contains(r#""ok":true"#));
    assert!(!handle.is_null());
    let mut applied = GxphBytes::EMPTY;
    // SAFETY: valid text and out.
    assert_eq!(unsafe { gxph_world_apply(handle, c(CRATE), CRATE.len(), GXPH_APPLY_ATOMIC, &mut applied) }, GXPH_OK);
    assert_eq!(take(applied), r#"{"ok":true}"#);
    step(handle);
    handle
}

fn step(world: *mut GxphWorld) -> String {
    let mut reply = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_step(world, &mut reply) }, GXPH_OK);
    take(reply)
}

fn state_hash(world: *mut GxphWorld) -> String {
    let mut hash = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_state_hash(world, &mut hash) }, GXPH_OK);
    take(hash)
}

fn tick(world: *mut GxphWorld) -> u64 {
    let mut out = 0_u64;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_tick(world, &mut out) }, GXPH_OK);
    out
}

fn free(world: *mut GxphWorld) {
    // SAFETY: a handle this library gave.
    assert_eq!(unsafe { gxph_world_free(world) }, GXPH_OK);
}

#[test]
fn replies_are_the_registry_text_and_a_world_steps_snapshots_and_restores() {
    let world = world();
    assert_eq!(tick(world), 1);
    let mut snapshot = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_snapshot(world, &mut snapshot) }, GXPH_OK);
    assert!(snapshot.len > 0);
    let before = state_hash(world);
    assert_eq!(before.len(), 16);
    for _ in 0..10 {
        step(world);
    }
    assert_ne!(state_hash(world), before);
    let mut restored = GxphBytes::EMPTY;
    // SAFETY: the snapshot buffer is the library's, still held.
    assert_eq!(unsafe { gxph_world_restore(world, snapshot.ptr, snapshot.len, &mut restored) }, GXPH_OK);
    assert_eq!(take(restored), r#"{"ok":true}"#);
    release(snapshot);
    assert_eq!(state_hash(world), before, "restore gives back the state the snapshot held");

    let mut keys = GxphBytes::EMPTY;
    let mut data = GxphBytes::EMPTY;
    // SAFETY: two distinct outs.
    assert_eq!(unsafe { gxph_world_export_changed(world, 0.0, &mut keys, &mut data) }, GXPH_OK);
    assert_eq!(data.len, 14 * 4, "one body, 14 f32");
    assert_eq!(data.ptr as usize % 4, 0, "f32 data is 4-byte aligned");
    assert_eq!(take(keys), r#"["crate"]"#);
    release(data);

    let mut id = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_build_id(&mut id) }, GXPH_OK);
    assert!(take(id).starts_with("genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+"));
    let mut measured = 0_u32;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_memory_is_measured(world, &mut measured) }, GXPH_OK);
    assert_eq!(measured, 1, "the library installs the counting allocator");
    free(world);
}

#[test]
fn a_freed_or_forged_handle_answers_internal_and_a_second_free_is_refused() {
    let world = world();
    free(world);
    // SAFETY: a handle is never dereferenced.
    assert_eq!(unsafe { gxph_world_free(world) }, GXPH_ERR_NO_WORLD, "double free");
    let forged = (1_usize << 20) as *mut GxphWorld;
    // SAFETY: as above.
    assert_eq!(unsafe { gxph_world_free(forged) }, GXPH_ERR_NO_WORLD);
    // SAFETY: as above.
    assert_eq!(unsafe { gxph_world_free(null_mut()) }, GXPH_ERR_NULL);
    for gone in [world, forged] {
        let reply = step(gone);
        assert!(reply.contains(r#""code":"internal""#), "{reply}");
        assert_eq!(state_hash(gone), "", "the empty form for no world");
        assert_eq!(tick(gone), 0);
    }
}

#[test]
fn a_buffer_is_freed_once_and_never_one_the_library_does_not_hold() {
    let world = world();
    let mut reply = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_stats(world, &mut reply) }, GXPH_OK);
    let copy = reply;
    // SAFETY: the library's buffer.
    assert_eq!(unsafe { gxph_buf_free(&mut reply) }, GXPH_OK);
    let mut again = copy;
    // SAFETY: freeing a stale copy is refused before any memory is touched.
    assert_eq!(unsafe { gxph_buf_free(&mut again) }, GXPH_ERR_NOT_OURS, "double free");
    assert_eq!(again, copy, "a refused free writes nothing");
    let mut empty = GxphBytes::EMPTY;
    // SAFETY: the empty buffer.
    assert_eq!(unsafe { gxph_buf_free(&mut empty) }, GXPH_OK, "freeing the empty buffer is a no-op");
    let mut own = [0_u8; 8];
    let mut foreign = GxphBytes { ptr: own.as_mut_ptr(), len: own.len() };
    // SAFETY: a foreign pointer is refused by lookup, never freed.
    assert_eq!(unsafe { gxph_buf_free(&mut foreign) }, GXPH_ERR_NOT_OURS);
    let mut held = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_stats(world, &mut held) }, GXPH_OK);
    let mut short = GxphBytes { ptr: held.ptr, len: held.len - 1 };
    // SAFETY: a changed length is refused by lookup.
    assert_eq!(unsafe { gxph_buf_free(&mut short) }, GXPH_ERR_NOT_OURS);
    let mut no_pointer = GxphBytes { ptr: null_mut(), len: 3 };
    // SAFETY: refused by the check.
    assert_eq!(unsafe { gxph_buf_free(&mut no_pointer) }, GXPH_ERR_NOT_OURS);
    // SAFETY: refused by the check.
    assert_eq!(unsafe { gxph_buf_free(null_mut()) }, GXPH_ERR_NULL);
    take(held);
    free(world);
}

/// One hostile row: a call, the code it must give, and whether it may touch the world.
struct Row {
    name: &'static str,
    code: GxphResult,
    call: Box<dyn Fn(*mut GxphWorld, *mut GxphBytes) -> GxphResult>,
}

fn row(name: &'static str, code: GxphResult, call: impl Fn(*mut GxphWorld, *mut GxphBytes) -> GxphResult + 'static) -> Row {
    Row { name, code, call: Box::new(call) }
}

/// The hostile table: each argument kind (text, f32/f64/u32 arrays, bytes, out buffers, flags) gets
/// `NULL` with a length, a huge length, a length past the address space, a misaligned pointer, and
/// bad UTF-8. A zero length with no pointer is legal (an empty input) and is answered in JSON.
fn rows() -> Vec<Row> {
    let bad_utf8: &'static [u8] = b"[\xff\xfe]";
    let floats: &'static [f32] = Box::leak(vec![0.0_f32; 32].into_boxed_slice());
    let doubles: &'static [f64] = Box::leak(vec![0.0_f64; 8].into_boxed_slice());
    let lengths: &'static [u32] = Box::leak(vec![6_u32; 2].into_boxed_slice());
    let misaligned_f32 = (floats.as_ptr() as usize + 1) as *const f32;
    let misaligned_f64 = (doubles.as_ptr() as usize + 4) as *const f64;
    let misaligned_u32 = (lengths.as_ptr() as usize + 2) as *const u32;
    let keys = r#"["crate"]"#;
    // SAFETY (every closure): each pointer is either valid for its length or refused by the checks.
    unsafe {
        vec![
            row("apply: NULL text with a length", GXPH_ERR_NULL, |w, r| gxph_world_apply(w, null(), 10, GXPH_APPLY_EACH, r)),
            row("apply: huge length", GXPH_ERR_LENGTH, |w, r| gxph_world_apply(w, c("[]"), GXPH_ARG_BYTES_MAX + 1, GXPH_APPLY_EACH, r)),
            row("apply: SIZE_MAX length", GXPH_ERR_LENGTH, |w, r| gxph_world_apply(w, c("[]"), usize::MAX, GXPH_APPLY_EACH, r)),
            row("apply: past the address space", GXPH_ERR_LENGTH, |w, r| gxph_world_apply(w, (usize::MAX - 3) as *const c_char, 64, GXPH_APPLY_EACH, r)),
            row("apply: not UTF-8", GXPH_ERR_UTF8, move |w, r| gxph_world_apply(w, bad_utf8.as_ptr().cast(), bad_utf8.len(), GXPH_APPLY_EACH, r)),
            row("apply: an unknown mode", GXPH_ERR_ARG, |w, r| gxph_world_apply(w, c("[]"), 2, 2, r)),
            row("apply: zero length is an empty text, refused in JSON", GXPH_OK, |w, r| gxph_world_apply(w, null(), 0, GXPH_APPLY_ATOMIC, r)),
            row("command: NULL handle", GXPH_ERR_NULL, |_, r| gxph_world_command(null(), c("{}"), 2, r)),
            row("command: NULL reply", GXPH_ERR_NULL, |w, _| gxph_world_command(w, c("{}"), 2, null_mut())),
            row("command: misaligned reply", GXPH_ERR_ALIGN, |w, r| gxph_world_command(w, c("{}"), 2, (r as usize + 1) as *mut GxphBytes)),
            row("bodies: NULL kinds with a length", GXPH_ERR_NULL, |w, r| gxph_world_bodies(w, null(), 4, 0, -1.0, r)),
            row("bodies: awake_only not 0 or 1", GXPH_ERR_ARG, |w, r| gxph_world_bodies(w, null(), 0, 7, -1.0, r)),
            row("import_states: NULL data with a count", GXPH_ERR_NULL, move |w, r| gxph_world_import_states(w, c(keys), keys.len(), null(), 14, r)),
            row("import_states: misaligned data", GXPH_ERR_ALIGN, move |w, r| gxph_world_import_states(w, c(keys), keys.len(), misaligned_f32, 14, r)),
            row("import_states: huge count", GXPH_ERR_LENGTH, move |w, r| gxph_world_import_states(w, c(keys), keys.len(), floats.as_ptr(), usize::MAX / 2, r)),
            row("import_wire: misaligned data", GXPH_ERR_ALIGN, move |w, r| gxph_world_import_wire(w, c(keys), keys.len(), misaligned_f32, 15, r)),
            row("import_states_rest: not UTF-8 keys", GXPH_ERR_UTF8, move |w, r| gxph_world_import_states_rest(w, bad_utf8.as_ptr().cast(), bad_utf8.len(), floats.as_ptr(), 15, r)),
            row("import_states: a short row is refused in JSON", GXPH_OK, move |w, r| gxph_world_import_states(w, c(keys), keys.len(), floats.as_ptr(), 13, r)),
            row("add_static: misaligned lengths", GXPH_ERR_ALIGN, move |w, r| gxph_world_add_static(w, misaligned_u32, 1, doubles.as_ptr(), 6, null(), 0, null(), 0, r)),
            row("add_static: misaligned values", GXPH_ERR_ALIGN, move |w, r| gxph_world_add_static(w, lengths.as_ptr(), 1, misaligned_f64, 6, null(), 0, null(), 0, r)),
            row("add_static: NULL ramps with a count", GXPH_ERR_NULL, move |w, r| gxph_world_add_static(w, lengths.as_ptr(), 1, doubles.as_ptr(), 6, null(), 1, null(), 0, r)),
            row("add_static: huge values count", GXPH_ERR_LENGTH, move |w, r| gxph_world_add_static(w, lengths.as_ptr(), 1, doubles.as_ptr(), usize::MAX / 8, null(), 0, null(), 0, r)),
            row("add_static: rows longer than the values, refused in JSON", GXPH_OK, move |w, r| gxph_world_add_static(w, lengths.as_ptr(), 2, doubles.as_ptr(), 6, null(), 0, null(), 0, r)),
            row("restore: NULL bytes with a length", GXPH_ERR_NULL, |w, r| gxph_world_restore(w, null(), 100, r)),
            row("restore: huge length", GXPH_ERR_LENGTH, |w, r| gxph_world_restore(w, c("x").cast(), usize::MAX, r)),
            row("restore: garbage bytes, refused in JSON", GXPH_OK, |w, r| gxph_world_restore(w, c("not a snapshot").cast(), 14, r)),
            row("restore: zero length, refused in JSON", GXPH_OK, |w, r| gxph_world_restore(w, null(), 0, r)),
            row("tick_frame: NULL request with a length", GXPH_ERR_NULL, |w, r| gxph_world_tick_frame(w, null(), 8, r)),
            row("tick_frame: a request that does not decode gives the empty reply", GXPH_OK, |w, r| gxph_world_tick_frame(w, c("garbage").cast(), 7, r)),
            row("body: NULL key with a length", GXPH_ERR_NULL, |w, r| gxph_world_body(w, null(), 5, r)),
            row("import_body_state: NULL state with a length", GXPH_ERR_NULL, |w, r| gxph_world_import_body_state(w, c("crate"), 5, null(), 3, r)),
            row("canonicalize: not UTF-8 options", GXPH_ERR_UTF8, move |w, r| gxph_world_canonicalize(w, bad_utf8.as_ptr().cast(), bad_utf8.len(), r)),
            row("query: NULL query with a length", GXPH_ERR_NULL, |w, r| gxph_world_query(w, null(), 9, r)),
            row("body_desc_canonical: huge length", GXPH_ERR_LENGTH, |w, r| gxph_world_body_desc_canonical(w, c("{}"), usize::MAX, r)),
        ]
    }
}

#[test]
fn hostile_arguments_are_refused_with_their_code_and_change_nothing() {
    let world = world();
    for row in rows() {
        let hash = state_hash(world);
        let ticks = tick(world);
        let mut reply = GxphBytes::EMPTY;
        let code = (row.call)(world, &mut reply);
        assert_eq!(code, row.code, "{}", row.name);
        if code == GXPH_OK {
            let text = take(reply);
            let refused_in_json = text.contains(r#""ok":false"#) || text.is_empty();
            assert!(refused_in_json, "{}: {text}", row.name);
        } else {
            assert_eq!(reply, GxphBytes::EMPTY, "{}: a refused call writes no reply", row.name);
        }
        assert_eq!(state_hash(world), hash, "{}: the world is unchanged", row.name);
        assert_eq!(tick(world), ticks, "{}", row.name);
    }
    free(world);
}

#[test]
fn an_out_argument_that_still_holds_a_buffer_or_aliases_another_is_refused() {
    let world = world();
    let mut held = GxphBytes::EMPTY;
    // SAFETY: valid out.
    assert_eq!(unsafe { gxph_world_stats(world, &mut held) }, GXPH_OK);
    let before = held;
    // SAFETY: an out still holding a buffer is refused before anything runs.
    assert_eq!(unsafe { gxph_world_step(world, &mut held) }, GXPH_ERR_OUT_IN_USE);
    assert_eq!(held, before, "the held buffer is not overwritten (no leak)");
    assert_eq!(tick(world), 1, "the step did not run");
    let mut both = GxphBytes::EMPTY;
    // SAFETY: the same out twice is refused before anything is written.
    assert_eq!(unsafe { gxph_world_export_changed(world, 0.0, &mut both, &mut both) }, GXPH_ERR_ARG);
    assert_eq!(both, GxphBytes::EMPTY);
    let mut made = null_mut();
    let mut reply = GxphBytes::EMPTY;
    // SAFETY: a NULL out is refused before any world is made.
    unsafe {
        assert_eq!(gxph_world_create(c(DESC), DESC.len(), null_mut(), &mut reply), GXPH_ERR_NULL);
        assert_eq!(gxph_world_create(c(DESC), DESC.len(), &mut made, null_mut()), GXPH_ERR_NULL);
    }
    assert!(made.is_null());
    assert_eq!(reply, GxphBytes::EMPTY);
    take(held);
    free(world);
}

#[test]
fn a_refused_description_gives_no_handle_and_its_failure_in_json() {
    let mut handle = 5 as *mut GxphWorld;
    let mut reply = GxphBytes::EMPTY;
    let bad = r#"{"contract":"9.9"}"#;
    // SAFETY: valid text and outs.
    assert_eq!(unsafe { gxph_world_create(c(bad), bad.len(), &mut handle, &mut reply) }, GXPH_OK);
    assert!(handle.is_null(), "a refused world gives the NULL handle");
    assert!(take(reply).contains(r#""ok":false"#));
}
