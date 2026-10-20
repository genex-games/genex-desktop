//! Stack frames as raw instruction pointers, never symbols: the game only walks its stack
//! (`backtrace::trace`, or on iOS the system unwinder's `_Unwind_Backtrace`, which is what
//! backtrace itself calls on Apple targets), and the host symbolicates against the build's debug
//! file. The host finds the image's slide from [`anchor`]: the record carries the anchor's runtime
//! address and the debug file names the same symbol. On wasm32 there is no stack walk (the web
//! shell keeps the engine's own stack): a record there has no frames and no anchor.

#[cfg(not(target_arch = "wasm32"))]
use crate::caps::CRASH_FRAMES_MAX;
use crate::record::CrashFrame;

/// The anchor's unique constant ("genex_cr"), so identical code folding cannot merge it with
/// another function that returns its own address.
const ANCHOR_TAG: u64 = 0x6765_6e65_785f_6372;
/// How many of the top frames are searched for the hook's own frame.
#[cfg(not(target_arch = "wasm32"))]
const HOOK_FRAMES_SEARCHED: usize = 32;
/// How far past the hook function's start a return address may sit and still be inside it. The
/// hook function is a few calls long; the stack walk gives no function sizes (on Apple targets it
/// gives no function starts either), so this bounds it.
#[cfg(not(target_arch = "wasm32"))]
const HOOK_SPAN_BYTES: u64 = 4096;

/// Address anchor for the host's slide: returns its own runtime address. Never inlined, and its
/// body holds a constant no other function has.
#[inline(never)]
pub fn anchor() -> u64 {
    let tag = std::hint::black_box(ANCHOR_TAG);
    let address = anchor as fn() -> u64 as usize as u64;
    if tag == ANCHOR_TAG { address } else { tag }
}

/// The anchor a record carries: its address natively, None on wasm32 (no frames to slide).
pub fn anchor_ip() -> Option<u64> {
    if cfg!(target_arch = "wasm32") { None } else { Some(anchor()) }
}

/// The stack's raw frames, top first, at most [`CRASH_FRAMES_MAX`]. When the function starting at
/// `hook_start` is found among the top frames, every frame down to it and `callers` more below it
/// (the hook's own) are skipped; otherwise every frame is kept.
#[cfg(not(target_arch = "wasm32"))]
pub fn capture(hook_start: u64, callers: usize) -> Vec<CrashFrame> {
    let ips = walk(CRASH_FRAMES_MAX + HOOK_FRAMES_SEARCHED);
    let skip = hook_depth(&ips, hook_start).map_or(0, |depth| depth.saturating_add(callers));
    ips.into_iter().skip(skip).take(CRASH_FRAMES_MAX).map(CrashFrame::Ip).collect()
}

/// The stack's raw return addresses, top first, at most `limit`.
#[cfg(not(any(target_arch = "wasm32", target_os = "ios")))]
fn walk(limit: usize) -> Vec<u64> {
    let mut ips: Vec<u64> = Vec::with_capacity(limit);
    backtrace::trace(|frame| {
        ips.push(frame.ip().addr() as u64);
        ips.len() < limit
    });
    ips
}

/// The stack's raw return addresses on iOS, top first, at most `limit`.
#[cfg(target_os = "ios")]
fn walk(limit: usize) -> Vec<u64> {
    unwind::walk(limit)
}

/// The system unwinder (libSystem's `_Unwind_Backtrace`), used on iOS where the backtrace crate
/// does not build against the locked libc.
#[cfg(target_os = "ios")]
#[allow(unsafe_code)] // FFI to the system unwinder: two C calls and the callback's data pointer.
mod unwind {
    use std::ffi::{c_int, c_void};

    /// The unwinder's opaque per-frame context.
    #[repr(C)]
    struct UnwindContext {
        _opaque: [u8; 0],
    }

    /// `_URC_NO_REASON`: keep walking.
    const URC_NO_REASON: c_int = 0;
    /// `_URC_FAILURE`: stop the walk (backtrace's own stop code on this unwinder).
    const URC_FAILURE: c_int = 9;

    type Step = extern "C" fn(*mut UnwindContext, *mut c_void) -> c_int;

    unsafe extern "C" {
        fn _Unwind_Backtrace(step: Step, data: *mut c_void) -> c_int;
        fn _Unwind_GetIP(context: *mut UnwindContext) -> usize;
    }

    /// The walk's state, handed to [`step`] through the unwinder's data pointer.
    struct Walk {
        ips: Vec<u64>,
        limit: usize,
    }

    extern "C" fn step(context: *mut UnwindContext, data: *mut c_void) -> c_int {
        // SAFETY: `data` is the `Walk` that `walk` lends for the whole `_Unwind_Backtrace` call,
        // and nothing else touches it meanwhile.
        let walk = unsafe { &mut *data.cast::<Walk>() };
        // SAFETY: `context` is the live frame context the unwinder passes to this callback.
        let ip = unsafe { _Unwind_GetIP(context) };
        walk.ips.push(ip as u64);
        if walk.ips.len() < walk.limit { URC_NO_REASON } else { URC_FAILURE }
    }

    /// Walks the current thread's stack, top first, at most `limit` return addresses.
    pub(super) fn walk(limit: usize) -> Vec<u64> {
        let mut walk = Walk { ips: Vec::with_capacity(limit), limit };
        // SAFETY: `step` matches the callback type the unwinder expects, and `walk` outlives the
        // call. The return code only says why the walk ended; the frames gathered are kept either way.
        unsafe { _Unwind_Backtrace(step, (&raw mut walk).cast()) };
        walk.ips
    }
}

/// No stack walk on wasm32.
#[cfg(target_arch = "wasm32")]
pub fn capture(_hook_start: u64, _callers: usize) -> Vec<CrashFrame> {
    Vec::new()
}

/// How many top frames belong to the stack walk and the hook function: the index past the
/// deepest of the top frames whose address sits inside the function starting at `hook_start`.
#[cfg(not(target_arch = "wasm32"))]
fn hook_depth(ips: &[u64], hook_start: u64) -> Option<usize> {
    ips.iter()
        .take(HOOK_FRAMES_SEARCHED)
        .rposition(|&ip| ip > hook_start && ip - hook_start <= HOOK_SPAN_BYTES)
        .map(|at| at + 1)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn the_hook_depth_is_past_the_deepest_frame_inside_the_hook() {
        let start = 0x1000;
        assert_eq!(hook_depth(&[0x9000, 0x1010, 0x1200, 0x7000], start), Some(3));
        assert_eq!(hook_depth(&[0x9000, 0x7000], start), None, "not found: keep every frame");
        assert_eq!(hook_depth(&[0x1000, 0x7000], start), None, "a return address is past the start");
        let mut deep = vec![0x9000; HOOK_FRAMES_SEARCHED];
        deep.push(0x1010);
        assert_eq!(hook_depth(&deep, start), None, "only the top frames are searched");
    }

    #[test]
    fn the_anchor_returns_its_own_address() {
        assert_eq!(anchor(), anchor as fn() -> u64 as usize as u64);
        assert_eq!(anchor_ip(), Some(anchor()));
    }
}
