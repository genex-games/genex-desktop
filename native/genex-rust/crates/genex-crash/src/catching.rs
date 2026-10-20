//! [`catching`]: run work whose panic the game survives (a job, a shader compile). The panic still
//! goes through the hook, which sees this thread is catching and writes the record `handled: true,
//! fatal: false`; the caller gets the panic back as the `Err`.

use std::cell::Cell;
use std::panic::UnwindSafe;

thread_local! {
    /// How many `catching` calls this thread is inside.
    static CATCHING: Cell<u32> = const { Cell::new(0) };
}

/// Run `f`; a panic inside is recorded `handled: true, fatal: false` and returned as the `Err`.
pub fn catching<R>(f: impl FnOnce() -> R + UnwindSafe) -> std::thread::Result<R> {
    let _inside = Inside::enter();
    std::panic::catch_unwind(f)
}

/// Whether this thread is inside [`catching`] (false while its thread-locals are torn down).
pub(crate) fn is_catching() -> bool {
    CATCHING.try_with(|depth| depth.get() > 0).unwrap_or(false)
}

/// One level of [`catching`], left when dropped.
struct Inside;

impl Inside {
    fn enter() -> Inside {
        let _ = CATCHING.try_with(|depth| depth.set(depth.get().saturating_add(1)));
        Inside
    }
}

impl Drop for Inside {
    fn drop(&mut self) {
        let _ = CATCHING.try_with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}
