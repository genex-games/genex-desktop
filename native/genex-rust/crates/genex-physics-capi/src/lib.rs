//! genex-physics-capi: the C ABI of Genex Physics, contract 1.0 and the 1.1 draft
//! (`../genex-physics/CONTRACT.md`; section numbers below are its own).
//!
//! Hosts that load a native library (Unity, Godot, Unreal, any C or C++ program) call the core
//! through these `gxph_*` functions. The header is the hand-written `include/genex_physics.h`; this
//! file and that header change together, and `scripts/physics-capi.ts --test` compiles a C file
//! against both (symbols both ways, `static_assert` sizes) and replays the §16 vectors through
//! them. Like the WASM exports and the native sidecar, this crate is a thin shell over
//! `genex-physics-binding`'s [`Registry`]: every reply is that registry's JSON text, byte for byte
//! what the WASM package's private wire carries for the same call.
//!
//! # The boundary
//!
//! - **Results.** Every function but [`gxph_abi_version`] returns a `gxph_result`. `GXPH_OK` means
//!   the registry ran and every out-argument was written; a contract refusal (`badCommand`,
//!   `internal` for a world that is gone, …) is then inside the JSON reply, exactly as the WASM
//!   wire gives it. Any other value is a refusal at the boundary itself: nothing was read past the
//!   bad argument, nothing changed and no out-argument was written.
//! - **Handles.** A `gxph_world*` is the registry's world id, never dereferenced. Ids are never
//!   reused, so a freed or forged handle names no world: calls with a reply answer `internal`
//!   (as the WASM wire does), and [`gxph_world_free`] answers `GXPH_ERR_NO_WORLD`.
//! - **Buffers.** Every reply is a `gxph_bytes` the library allocated and still owns until
//!   [`gxph_buf_free`] gives it back. The library records each buffer it hands out, so freeing one
//!   it does not hold (twice, or a foreign pointer) is `GXPH_ERR_NOT_OURS` with no side effect, and
//!   a freed `gxph_bytes` is zeroed in place. An out `gxph_bytes` must be empty (`{NULL, 0}`) on
//!   entry, so a reply is never written over one still held (`GXPH_ERR_OUT_IN_USE`).
//! - **Inputs.** Text is UTF-8 with an explicit length (no terminator); arrays are a pointer and an
//!   element count. A zero length needs no pointer; any other is checked for `NULL`, alignment of
//!   its element type, a total under [`GXPH_ARG_BYTES_MAX`] and no address overflow before a slice
//!   is made. Two out-arguments of one call must not be the same pointer.
//! - **Panics.** Every call runs under `catch_unwind`: no unwind ever crosses into C. A panic in
//!   the shell or the binding (the core already turns a backend panic into `internal` for its world,
//!   §11.3) answers `GXPH_ERR_PANIC` and poisons the library: every later call answers the same, as
//!   a trapped WASM instance does.
//!
//! # Threads (§1.1)
//!
//! One registry per loaded library, behind one lock: calls from several threads are safe and run
//! one at a time.
//!
//! # Memory (§11.1)
//!
//! The library installs genex-physics' [`CountingAllocator`] as its own Rust allocator, so
//! `stats().memoryBytes` is each world's measured live bytes (64-bit, so not wasm32's figure).

#![allow(unsafe_code, reason = "a C ABI reads caller pointers; each block says why it holds")]

use std::collections::BTreeMap;
use std::ffi::c_char;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use genex_physics::accounting::CountingAllocator;
use genex_physics_binding::{Registry, TickRequest};

/// Every allocation is charged to the world whose call is running (§11.1).
#[global_allocator]
static ALLOCATOR: CountingAllocator<std::alloc::System> = CountingAllocator::new(std::alloc::System);

/// The ABI's version; the header's `GXPH_ABI_VERSION`. A change to any signature, struct or code
/// below bumps it.
pub const GXPH_ABI_VERSION: u32 = 1;

/// A call's status (`gxph_result` in the header).
pub type GxphResult = i32;
/// The registry ran; every out-argument holds its reply.
pub const GXPH_OK: GxphResult = 0;
/// A required pointer was `NULL` (or a handle was `NULL`).
pub const GXPH_ERR_NULL: GxphResult = 1;
/// A length over [`GXPH_ARG_BYTES_MAX`] bytes, or one that overflows the address space.
pub const GXPH_ERR_LENGTH: GxphResult = 2;
/// A pointer not aligned for its element type.
pub const GXPH_ERR_ALIGN: GxphResult = 3;
/// Text that is not UTF-8.
pub const GXPH_ERR_UTF8: GxphResult = 4;
/// An out `gxph_bytes` that still holds a buffer.
pub const GXPH_ERR_OUT_IN_USE: GxphResult = 5;
/// `gxph_world_free` of a handle that names no live world.
pub const GXPH_ERR_NO_WORLD: GxphResult = 6;
/// `gxph_buf_free` of a buffer this library does not hold (freed already, or never its own).
pub const GXPH_ERR_NOT_OURS: GxphResult = 7;
/// The library panicked, in this call or an earlier one; it is poisoned.
pub const GXPH_ERR_PANIC: GxphResult = 8;
/// An argument outside its values (a mode or flag), or two out-arguments that are one pointer.
pub const GXPH_ERR_ARG: GxphResult = 9;

/// `gxph_world_apply`'s modes (§7.1).
pub const GXPH_APPLY_EACH: u32 = 0;
/// All or none.
pub const GXPH_APPLY_ATOMIC: u32 = 1;

/// The most bytes one input argument may span (1 GiB).
pub const GXPH_ARG_BYTES_MAX: usize = 1 << 30;

/// An opaque world handle (`gxph_world` in the header): the registry's id, never dereferenced.
#[repr(C)]
pub struct GxphWorld {
    _opaque: [u8; 0],
}

/// A buffer the library hands out (`gxph_bytes`): `len` bytes at `ptr`, `{NULL, 0}` when empty.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GxphBytes {
    /// The first byte; `NULL` for an empty buffer.
    pub ptr: *mut u8,
    /// Its length in bytes.
    pub len: usize,
}

impl GxphBytes {
    /// The empty buffer every out-argument starts as.
    pub const EMPTY: Self = Self { ptr: std::ptr::null_mut(), len: 0 };
}

/// A buffer the library holds for the caller until `gxph_buf_free`.
enum Owned {
    Bytes(#[allow(dead_code, reason = "held only to keep the allocation alive")] Box<[u8]>),
    Floats(#[allow(dead_code, reason = "held only to keep the allocation alive")] Box<[f32]>),
}

/// The loaded library: its registry, the buffers it has handed out, and whether it panicked.
struct Library {
    registry: Registry,
    /// Each buffer handed out, by its address, with its length in bytes.
    buffers: BTreeMap<usize, (usize, Owned)>,
    poisoned: bool,
}

impl Library {
    const fn new() -> Self {
        Self { registry: Registry::new(), buffers: BTreeMap::new(), poisoned: false }
    }

    /// Hands `bytes` out: recorded until freed, or the empty buffer for none.
    fn hand_out(&mut self, bytes: Vec<u8>) -> GxphBytes {
        if bytes.is_empty() {
            return GxphBytes::EMPTY;
        }
        let mut held = bytes.into_boxed_slice();
        let out = GxphBytes { ptr: held.as_mut_ptr(), len: held.len() };
        self.buffers.insert(out.ptr as usize, (out.len, Owned::Bytes(held)));
        out
    }

    /// Hands f32 data out as bytes (4-byte aligned, native byte order).
    fn hand_out_floats(&mut self, floats: Vec<f32>) -> GxphBytes {
        if floats.is_empty() {
            return GxphBytes::EMPTY;
        }
        let mut held = floats.into_boxed_slice();
        let out = GxphBytes { ptr: held.as_mut_ptr().cast::<u8>(), len: std::mem::size_of_val(&*held) };
        self.buffers.insert(out.ptr as usize, (out.len, Owned::Floats(held)));
        out
    }
}

/// The library's one registry (§1.1: one lock, one call at a time).
static LIBRARY: Mutex<Library> = Mutex::new(Library::new());

/// A boundary refusal, as its `gxph_result`.
type Checked<T> = Result<T, GxphResult>;

/// Runs one call on `library` under the lock and `catch_unwind`: its result, or `GXPH_ERR_PANIC`
/// (poisoning the library) when it panicked or the library already had.
fn run(library: &Mutex<Library>, call: impl FnOnce(&mut Library) -> Checked<()>) -> GxphResult {
    let Ok(mut held) = library.lock() else { return GXPH_ERR_PANIC };
    if held.poisoned {
        return GXPH_ERR_PANIC;
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| call(&mut held)));
    match outcome {
        Ok(Ok(())) => GXPH_OK,
        Ok(Err(code)) => code,
        Err(_) => {
            held.poisoned = true;
            GXPH_ERR_PANIC
        }
    }
}

/// [`run`] on the library's own registry.
fn call(body: impl FnOnce(&mut Library) -> Checked<()>) -> GxphResult {
    run(&LIBRARY, body)
}

// ---------------------------------------------------------------------------------------------
// Reading the caller's arguments.

/// `len` elements at `ptr`, checked: a zero length needs no pointer; otherwise not `NULL`, aligned
/// for `T`, at most [`GXPH_ARG_BYTES_MAX`] bytes, and not past the end of the address space.
///
/// # Safety
///
/// When every check passes, `ptr` must point to `len` initialised `T`s that stay unchanged for the
/// call (the C contract of every array argument).
unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> Checked<&'a [T]> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(GXPH_ERR_NULL);
    }
    let size = std::mem::size_of::<T>().max(1);
    if len > GXPH_ARG_BYTES_MAX / size {
        return Err(GXPH_ERR_LENGTH);
    }
    if !(ptr as usize).is_multiple_of(std::mem::align_of::<T>()) {
        return Err(GXPH_ERR_ALIGN);
    }
    if (ptr as usize).checked_add(len * size).is_none() {
        return Err(GXPH_ERR_LENGTH);
    }
    // SAFETY: non-null, aligned, within isize::MAX bytes and the address space (checked above);
    // that the caller's memory holds `len` initialised elements is this function's own contract.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// UTF-8 text of `len` bytes at `ptr`.
///
/// # Safety
///
/// As [`slice`].
unsafe fn text<'a>(ptr: *const c_char, len: usize) -> Checked<&'a str> {
    // SAFETY: forwarded to the caller's contract.
    let bytes = unsafe { slice(ptr.cast::<u8>(), len) }?;
    std::str::from_utf8(bytes).map_err(|_| GXPH_ERR_UTF8)
}

/// Text that may be absent: `NULL` with a zero length is absent; any other is [`text`].
///
/// # Safety
///
/// As [`slice`].
unsafe fn optional_text<'a>(ptr: *const c_char, len: usize) -> Checked<Option<&'a str>> {
    if ptr.is_null() && len == 0 {
        return Ok(None);
    }
    if ptr.is_null() {
        return Err(GXPH_ERR_NULL);
    }
    // SAFETY: forwarded to the caller's contract.
    unsafe { text(ptr, len) }.map(Some)
}

/// An out-argument's pointer: not `NULL` and aligned for `T`.
fn out_ptr<T>(ptr: *mut T) -> Checked<*mut T> {
    if ptr.is_null() {
        return Err(GXPH_ERR_NULL);
    }
    if !(ptr as usize).is_multiple_of(std::mem::align_of::<T>()) {
        return Err(GXPH_ERR_ALIGN);
    }
    Ok(ptr)
}

/// An out `gxph_bytes`: a valid pointer to an empty buffer.
///
/// # Safety
///
/// When non-null and aligned, `ptr` must point to a readable and writable `gxph_bytes`.
unsafe fn out_bytes(ptr: *mut GxphBytes) -> Checked<*mut GxphBytes> {
    let ptr = out_ptr(ptr)?;
    // SAFETY: non-null and aligned (checked); readable is the caller's contract.
    let current = unsafe { ptr.read() };
    if current != GxphBytes::EMPTY {
        return Err(GXPH_ERR_OUT_IN_USE);
    }
    Ok(ptr)
}

/// Two out-arguments of one call must be two places.
fn distinct<A, B>(a: *mut A, b: *mut B) -> Checked<()> {
    if std::ptr::eq(a.cast::<u8>(), b.cast::<u8>()) {
        return Err(GXPH_ERR_ARG);
    }
    Ok(())
}

/// A 0/1 flag.
fn flag(value: u32) -> Checked<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(GXPH_ERR_ARG),
    }
}

/// The registry id a handle names. `NULL` is refused; a value past `u32::MAX` names no world, and
/// so is given as `u32::MAX` (never handed out: the registry refuses to make a world with it).
fn world_id(handle: *const GxphWorld) -> Checked<u32> {
    let value = handle as usize;
    if value == 0 {
        return Err(GXPH_ERR_NULL);
    }
    Ok(u32::try_from(value).unwrap_or(u32::MAX))
}

/// Writes `value` through an out pointer already checked by [`out_ptr`] or [`out_bytes`].
///
/// # Safety
///
/// `ptr` passed those checks and is writable (the caller's contract).
unsafe fn write<T>(ptr: *mut T, value: T) {
    // SAFETY: non-null and aligned (checked by the caller of this helper); writable by contract.
    unsafe { ptr.write(value) }
}

/// A call whose reply is the registry's text: checks `out`, runs `reply`, hands its text out.
///
/// # Safety
///
/// `out` as [`out_bytes`]; `reply` reads its own arguments under their contracts.
unsafe fn text_reply(out: *mut GxphBytes, reply: impl FnOnce(&mut Registry) -> Checked<String>) -> GxphResult {
    call(|library| {
        // SAFETY: forwarded to the caller's contract.
        let out = unsafe { out_bytes(out) }?;
        let text = reply(&mut library.registry)?;
        let bytes = library.hand_out(text.into_bytes());
        // SAFETY: checked by out_bytes above.
        unsafe { write(out, bytes) };
        Ok(())
    })
}

/// Milliseconds on a monotonic clock, for a tick's `stats().stepMs` (§11.4).
fn now_ms() -> f64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

// ---------------------------------------------------------------------------------------------
// The exports. Each one's safety contract is the header's: every pointer argument points to what
// its length says (or is NULL with a zero length), and every out-argument to writable memory.

/// The ABI version this library was built with (`GXPH_ABI_VERSION`).
#[unsafe(no_mangle)]
pub extern "C" fn gxph_abi_version() -> u32 {
    GXPH_ABI_VERSION
}

/// This build's identity (§2) as text, e.g. `genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+aarch64-apple-darwin`.
///
/// # Safety
///
/// `out` points to a writable, empty `gxph_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_build_id(out: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(out, |_| Ok(genex_physics_binding::build_id())) }
}

/// Gives a buffer back and zeroes it. Freeing the empty buffer is a no-op; freeing one the library
/// does not hold (twice, foreign, or a changed length) is `GXPH_ERR_NOT_OURS` and frees nothing.
///
/// # Safety
///
/// `buffer` points to a readable and writable `gxph_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_buf_free(buffer: *mut GxphBytes) -> GxphResult {
    call(|library| {
        let ptr = out_ptr(buffer)?;
        // SAFETY: non-null and aligned (checked); readable by contract.
        let held = unsafe { ptr.read() };
        if held == GxphBytes::EMPTY {
            return Ok(());
        }
        let ours = library.buffers.get(&(held.ptr as usize)).is_some_and(|(len, _)| *len == held.len);
        if !ours {
            return Err(GXPH_ERR_NOT_OURS);
        }
        library.buffers.remove(&(held.ptr as usize));
        // SAFETY: checked above.
        unsafe { write(ptr, GxphBytes::EMPTY) };
        Ok(())
    })
}

/// How many worlds the library holds.
///
/// # Safety
///
/// `out` points to a writable `uint32_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_live_worlds(out: *mut u32) -> GxphResult {
    call(|library| {
        let out = out_ptr(out)?;
        // SAFETY: checked above.
        unsafe { write(out, library.registry.live_worlds()) };
        Ok(())
    })
}

/// Makes a world from its JSON description (§4). `reply` is `{ ok: true, id }` or a failure;
/// `world` the new handle, or `NULL` when refused.
///
/// # Safety
///
/// `desc` holds `desc_len` bytes; `world` and `reply` are writable, `reply` empty.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_create(desc: *const c_char, desc_len: usize, world: *mut *mut GxphWorld, reply: *mut GxphBytes) -> GxphResult {
    call(|library| {
        let world_out = out_ptr(world)?;
        // SAFETY: the caller's contract.
        let reply_out = unsafe { out_bytes(reply) }?;
        distinct(world_out, reply_out)?;
        // SAFETY: the caller's contract.
        let desc = unsafe { text(desc, desc_len) }?;
        let text = library.registry.world_create(desc);
        let id = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|value| value["id"].as_u64()).unwrap_or(0);
        let handle = id as usize as *mut GxphWorld;
        let bytes = library.hand_out(text.into_bytes());
        // SAFETY: both checked above.
        unsafe {
            write(world_out, handle);
            write(reply_out, bytes);
        }
        Ok(())
    })
}

/// Frees a world and its memory; `GXPH_ERR_NO_WORLD` when the handle names none (freed already).
///
/// # Safety
///
/// None beyond the handle being a value this library gave (any other names no world).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_free(world: *mut GxphWorld) -> GxphResult {
    call(|library| {
        let id = world_id(world)?;
        if library.registry.world_free(id) { Ok(()) } else { Err(GXPH_ERR_NO_WORLD) }
    })
}

/// `internal` when the world failed earlier or does not exist, else `{ ok: true }`.
///
/// # Safety
///
/// `reply` points to a writable, empty `gxph_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_check(world: *const GxphWorld, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_check(world_id(world)?))) }
}

/// The resolved description as JSON (§4), or `null`.
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_desc(world: *const GxphWorld, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_desc(world_id(world)?))) }
}

/// The tick counter (0 for no world).
///
/// # Safety
///
/// `out` points to a writable `uint64_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_tick(world: *const GxphWorld, out: *mut u64) -> GxphResult {
    call(|library| {
        let out = out_ptr(out)?;
        let tick = library.registry.world_tick(world_id(world)?);
        // SAFETY: checked above.
        unsafe { write(out, tick as u64) };
        Ok(())
    })
}

/// Applies one command in its JSON form (§7.3).
///
/// # Safety
///
/// `command` holds `command_len` bytes; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_command(world: *const GxphWorld, command: *const c_char, command_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_command(world_id(world)?, text(command, command_len)?))) }
}

/// Applies a JSON array of commands (§7.1) in `GXPH_APPLY_EACH` or `GXPH_APPLY_ATOMIC` mode.
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_apply(world: *const GxphWorld, commands: *const c_char, commands_len: usize, mode: u32, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe {
        text_reply(reply, |registry| {
            let atomic = flag(mode)?;
            Ok(registry.world_apply(world_id(world)?, text(commands, commands_len)?, atomic))
        })
    }
}

/// Imports §17.7's static world (§6.5) in its flat form: each list's row lengths and its values,
/// row after row.
///
/// # Safety
///
/// Each array holds its count of elements (4-byte aligned lengths, 8-byte aligned values).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments, reason = "the flat form is four arrays, each a pointer and a count")]
pub unsafe extern "C" fn gxph_world_add_static(
    world: *const GxphWorld,
    box_lengths: *const u32,
    box_lengths_len: usize,
    boxes: *const f64,
    boxes_len: usize,
    ramp_lengths: *const u32,
    ramp_lengths_len: usize,
    ramps: *const f64,
    ramps_len: usize,
    reply: *mut GxphBytes,
) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe {
        text_reply(reply, |registry| {
            let id = world_id(world)?;
            let box_lengths = slice(box_lengths, box_lengths_len)?;
            let boxes = slice(boxes, boxes_len)?;
            let ramp_lengths = slice(ramp_lengths, ramp_lengths_len)?;
            let ramps = slice(ramps, ramps_len)?;
            Ok(registry.world_add_static(id, box_lengths, boxes, ramp_lengths, ramps))
        })
    }
}

/// Steps the world once (§8).
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_step(world: *const GxphWorld, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_step(world_id(world)?))) }
}

/// Records the wall time the host measured around the last step (§11.4).
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_record_step_ms(world: *const GxphWorld, ms: f64, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_record_step_ms(world_id(world)?, ms))) }
}

/// One body's state as JSON, or `null` (§9.1).
///
/// # Safety
///
/// `key` holds `key_len` bytes; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_body(world: *const GxphWorld, key: *const c_char, key_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_body(world_id(world)?, text(key, key_len)?))) }
}

/// The bodies a filter selects (§9.1) as a JSON array: `kinds` a JSON array of strings, or `NULL`
/// with length 0 for no kind filter; `awake_only` 0 or 1; `changed_since` a tick, or negative for none.
///
/// # Safety
///
/// `kinds` holds `kinds_len` bytes or is `NULL` with 0; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_bodies(
    world: *const GxphWorld,
    kinds: *const c_char,
    kinds_len: usize,
    awake_only: u32,
    changed_since: f64,
    reply: *mut GxphBytes,
) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe {
        text_reply(reply, |registry| {
            let id = world_id(world)?;
            let kinds = optional_text(kinds, kinds_len)?;
            Ok(registry.world_bodies(id, kinds, flag(awake_only)?, changed_since))
        })
    }
}

/// Shared by both changed exports: checks both outs, runs `export`, hands out the keys and the data.
///
/// # Safety
///
/// Both outs as [`out_bytes`].
unsafe fn changed_reply(keys: *mut GxphBytes, data: *mut GxphBytes, export: impl FnOnce(&mut Registry) -> Checked<String>) -> GxphResult {
    call(|library| {
        // SAFETY: forwarded to the caller's contract.
        let keys_out = unsafe { out_bytes(keys) }?;
        // SAFETY: forwarded to the caller's contract.
        let data_out = unsafe { out_bytes(data) }?;
        distinct(keys_out, data_out)?;
        let listed = export(&mut library.registry)?;
        let floats = library.registry.take_changed_data();
        let keys = library.hand_out(listed.into_bytes());
        let data = library.hand_out_floats(floats);
        // SAFETY: both checked above.
        unsafe {
            write(keys_out, keys);
            write(data_out, data);
        }
        Ok(())
    })
}

/// The bodies changed after tick `since` (§9.1): `keys` a JSON array, `data` 14 f32 per key in
/// `exportChanged`'s layout (native byte order, 4-byte aligned; empty for none).
///
/// # Safety
///
/// `keys` and `data` point to two distinct writable, empty `gxph_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_export_changed(world: *const GxphWorld, since: f64, keys: *mut GxphBytes, data: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { changed_reply(keys, data, |registry| Ok(registry.world_export_changed(world_id(world)?, since))) }
}

/// [`gxph_world_export_changed`] with the sleep timer (§20.3): 15 f32 per key, every awake body
/// listed besides the changed ones.
///
/// # Safety
///
/// As [`gxph_world_export_changed`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_export_changed_rest(world: *const GxphWorld, since: f64, keys: *mut GxphBytes, data: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { changed_reply(keys, data, |registry| Ok(registry.world_export_changed_rest(world_id(world)?, since))) }
}

/// A body's replicated fields as JSON, or `null` (§9.2).
///
/// # Safety
///
/// As [`gxph_world_body`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_export_body_state(world: *const GxphWorld, key: *const c_char, key_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_export_body_state(world_id(world)?, text(key, key_len)?))) }
}

/// [`gxph_world_export_body_state`] with the sleep timer `rest` (§20.3).
///
/// # Safety
///
/// As [`gxph_world_body`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_export_body_state_rest(world: *const GxphWorld, key: *const c_char, key_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_export_body_state_rest(world_id(world)?, text(key, key_len)?))) }
}

/// Sets a body's replicated fields from their JSON form (§9.2).
///
/// # Safety
///
/// `key` and `state` hold their lengths in bytes; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_import_body_state(
    world: *const GxphWorld,
    key: *const c_char,
    key_len: usize,
    state: *const c_char,
    state_len: usize,
    reply: *mut GxphBytes,
) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe {
        text_reply(reply, |registry| {
            let id = world_id(world)?;
            Ok(registry.world_import_body_state(id, text(key, key_len)?, text(state, state_len)?))
        })
    }
}

/// The three bulk imports share their arguments: keys as a JSON array, f32 rows.
#[derive(Clone, Copy)]
enum Bulk {
    States,
    StatesRest,
    Wire,
}

/// Shared by the bulk imports.
///
/// # Safety
///
/// As [`gxph_world_import_states`].
unsafe fn bulk_import(world: *const GxphWorld, keys: *const c_char, keys_len: usize, data: *const f32, data_len: usize, reply: *mut GxphBytes, bulk: Bulk) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe {
        text_reply(reply, |registry| {
            let id = world_id(world)?;
            let keys = text(keys, keys_len)?;
            let data = slice(data, data_len)?;
            Ok(match bulk {
                Bulk::States => registry.world_import_states(id, keys, data),
                Bulk::StatesRest => registry.world_import_states_rest(id, keys, data),
                Bulk::Wire => registry.world_import_wire(id, keys, data),
            })
        })
    }
}

/// Imports many bodies' replicated fields at once (§19.1): `keys` a JSON array of strings, `data`
/// `data_len` f32, 14 per key in `exportChanged`'s layout. All or none.
///
/// # Safety
///
/// `keys` holds `keys_len` bytes, `data` `data_len` 4-byte aligned f32; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_import_states(world: *const GxphWorld, keys: *const c_char, keys_len: usize, data: *const f32, data_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { bulk_import(world, keys, keys_len, data, data_len, reply, Bulk::States) }
}

/// [`gxph_world_import_states`] with the sleep timer: 15 f32 per key (§20.3).
///
/// # Safety
///
/// As [`gxph_world_import_states`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_import_states_rest(world: *const GxphWorld, keys: *const c_char, keys_len: usize, data: *const f32, data_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { bulk_import(world, keys, keys_len, data, data_len, reply, Bulk::StatesRest) }
}

/// Imports wire rows (§20.2): 15 f32 per key. All or none.
///
/// # Safety
///
/// As [`gxph_world_import_states`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_import_wire(world: *const GxphWorld, keys: *const c_char, keys_len: usize, data: *const f32, data_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { bulk_import(world, keys, keys_len, data, data_len, reply, Bulk::Wire) }
}

/// Puts the world into its canonical state (§20.1): `options` is JSON `{ quantize?: boolean }`.
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_canonicalize(world: *const GxphWorld, options: *const c_char, options_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_canonicalize(world_id(world)?, text(options, options_len)?))) }
}

/// A body descriptor's canonical form (§20.5): `{ ok: true, desc }` or `spawn`'s own refusal.
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_body_desc_canonical(world: *const GxphWorld, desc: *const c_char, desc_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_body_desc_canonical(world_id(world)?, text(desc, desc_len)?))) }
}

/// A joint descriptor's canonical form (§20.5): `{ ok: true, desc }` or `addJoint`'s own refusal.
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_joint_desc_canonical(world: *const GxphWorld, desc: *const c_char, desc_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_joint_desc_canonical(world_id(world)?, text(desc, desc_len)?))) }
}

/// Runs one query in its JSON form (§13).
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_query(world: *const GxphWorld, query: *const c_char, query_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_query(world_id(world)?, text(query, query_len)?))) }
}

/// Runs a JSON array of queries (§19.2): `{ ok: true, results }` or one failure.
///
/// # Safety
///
/// As [`gxph_world_command`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_query_many(world: *const GxphWorld, queries: *const c_char, queries_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_query_many(world_id(world)?, text(queries, queries_len)?))) }
}

/// One room tick in one call: the binding's binary tick request in, its binary reply out
/// (`genex-physics-binding/src/tick.rs`). A request that does not decode gives the empty reply.
///
/// # Safety
///
/// `request` holds `request_len` bytes; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_tick_frame(world: *const GxphWorld, request: *const u8, request_len: usize, reply: *mut GxphBytes) -> GxphResult {
    call(|library| {
        // SAFETY: the caller's contract.
        let out = unsafe { out_bytes(reply) }?;
        let id = world_id(world)?;
        // SAFETY: the caller's contract.
        let bytes = unsafe { slice(request, request_len) }?;
        let answer = match TickRequest::decode(bytes) {
            Ok(request) => library.registry.world_tick_frame(id, request, &mut now_ms),
            Err(_) => Vec::new(),
        };
        let handed = library.hand_out(answer);
        // SAFETY: checked above.
        unsafe { write(out, handed) };
        Ok(())
    })
}

/// The world's snapshot (§9.4), or the empty buffer when the world failed or does not exist.
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_snapshot(world: *const GxphWorld, snapshot: *mut GxphBytes) -> GxphResult {
    call(|library| {
        // SAFETY: the caller's contract.
        let out = unsafe { out_bytes(snapshot) }?;
        let bytes = library.registry.world_snapshot(world_id(world)?).unwrap_or_default();
        let handed = library.hand_out(bytes);
        // SAFETY: checked above.
        unsafe { write(out, handed) };
        Ok(())
    })
}

/// Replaces the world from a snapshot (§9.4).
///
/// # Safety
///
/// `bytes` holds `bytes_len` bytes; `reply` as [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_restore(world: *const GxphWorld, bytes: *const u8, bytes_len: usize, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_restore(world_id(world)?, slice(bytes, bytes_len)?))) }
}

/// `stateHash` (§10.1): 16 hex digits, or the empty buffer for no world.
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_state_hash(world: *const GxphWorld, hash: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(hash, |registry| Ok(registry.world_state_hash(world_id(world)?))) }
}

/// `physicsHash` (§10.2): 16 hex digits, or the empty buffer for no world.
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_physics_hash(world: *const GxphWorld, hash: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(hash, |registry| Ok(registry.world_physics_hash(world_id(world)?))) }
}

/// The world's counters (§11) as JSON, or `null`.
///
/// # Safety
///
/// As [`gxph_world_check`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_stats(world: *const GxphWorld, reply: *mut GxphBytes) -> GxphResult {
    // SAFETY: the caller's contract.
    unsafe { text_reply(reply, |registry| Ok(registry.world_stats(world_id(world)?))) }
}

/// The world's `stats().memoryBytes` (§11.1); 0 for no world.
///
/// # Safety
///
/// `out` points to a writable `uint64_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_memory_bytes(world: *const GxphWorld, out: *mut u64) -> GxphResult {
    call(|library| {
        let out = out_ptr(out)?;
        let bytes = library.registry.world_memory_bytes(world_id(world)?);
        // SAFETY: checked above.
        unsafe { write(out, bytes as u64) };
        Ok(())
    })
}

/// 1 when the counting allocator measures this world's memory (§11.1), else 0 (and for no world).
///
/// # Safety
///
/// `out` points to a writable `uint32_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn gxph_world_memory_is_measured(world: *const GxphWorld, out: *mut u32) -> GxphResult {
    call(|library| {
        let out = out_ptr(out)?;
        let measured = library.registry.world_memory_is_measured(world_id(world)?);
        // SAFETY: checked above.
        unsafe { write(out, u32::from(measured)) };
        Ok(())
    })
}

/// Panics inside a call, so a test can see the boundary catch it and the library poison itself.
/// Only the test build (`scripts/physics-capi.ts --test`, feature `test-panic`) has it.
#[cfg(feature = "test-panic")]
#[unsafe(no_mangle)]
pub extern "C" fn gxph_test_panic() -> GxphResult {
    call(|_| panic!("gxph_test_panic: a deliberate panic at the C boundary"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_is_caught_answers_panic_and_poisons_only_its_own_library() {
        let library = Mutex::new(Library::new());
        assert_eq!(run(&library, |_| Ok(())), GXPH_OK);
        let quiet = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let caught = run(&library, |_| panic!("deliberate"));
        std::panic::set_hook(quiet);
        assert_eq!(caught, GXPH_ERR_PANIC);
        assert_eq!(run(&library, |_| Ok(())), GXPH_ERR_PANIC, "a poisoned library answers every later call the same");
        assert_eq!(run(&Mutex::new(Library::new()), |_| Ok(())), GXPH_OK);
    }

    #[test]
    fn a_slice_is_checked_before_it_is_made() {
        let floats = [1.0_f32, 2.0, 3.0];
        // SAFETY: each pointer below is either refused by the checks or points into `floats`.
        unsafe {
            assert_eq!(slice::<f32>(std::ptr::null(), 0), Ok(&[][..]));
            assert_eq!(slice::<f32>(std::ptr::null(), 1), Err(GXPH_ERR_NULL));
            assert_eq!(slice::<f32>(floats.as_ptr(), usize::MAX), Err(GXPH_ERR_LENGTH));
            assert_eq!(slice::<f32>(floats.as_ptr(), GXPH_ARG_BYTES_MAX / 4 + 1), Err(GXPH_ERR_LENGTH));
            let misaligned = floats.as_ptr().cast::<u8>().add(1).cast::<f32>();
            assert_eq!(slice::<f32>(misaligned, 1), Err(GXPH_ERR_ALIGN));
            let near_end = (usize::MAX - 3) as *const u8;
            assert_eq!(slice::<u8>(near_end, 16), Err(GXPH_ERR_LENGTH));
            assert_eq!(slice(floats.as_ptr(), 3), Ok(&floats[..]));
        }
    }

    #[test]
    fn a_handle_past_u32_names_the_id_no_world_ever_gets() {
        assert_eq!(world_id(std::ptr::null()), Err(GXPH_ERR_NULL));
        assert_eq!(world_id(7 as *const GxphWorld), Ok(7));
        #[cfg(target_pointer_width = "64")]
        assert_eq!(world_id((1_usize << 40) as *const GxphWorld), Ok(u32::MAX));
    }
}
