//! The panic hook: [`install`] chains it in front of the hook installed before it, once per
//! process. A panic becomes one record (kind, message, location, thread, raw frames, the anchor,
//! the crash context, the replay tail and the last profile summary) delivered to every sink, then
//! the previous hook runs.
//!
//! A panic inside a panic hook aborts the process, so the sinks never run inside it: the hook hands
//! the record to a short-lived delivery thread and joins it. A sink that panics there panics on
//! that thread, where the hook sees the delivery guard and writes no second record; the original
//! hook goes on to the previous hook. On wasm32 (no threads) the sinks run inline.
//!
//! [`note_gpu_error`] types the next panic on its thread `gpu-validation` (wgpu panics on an
//! uncaptured error right after reporting it), and [`record_device_lost`] writes a record that is
//! not fatal while recovery goes on.

use std::cell::{Cell, RefCell};
use std::panic::{AssertUnwindSafe, PanicHookInfo};
use std::sync::OnceLock;
use std::thread::ThreadId;

use crate::catching::is_catching;
use crate::context::{CrashContext, context};
use crate::file_sink::CrashSink;
use crate::frames;
use crate::kind::{CrashKind, CrashSource, GpuErrorClass};
use crate::record::{CrashGpu, CrashLocation, CrashRecord, CrashThread};
use crate::replay::read_tail;

/// The name of the thread that delivers a panic's record.
const DELIVERY_THREAD: &str = "genex-crash-delivery";
/// Frames below `record_panic` that are the hook's too: the hook closure.
const HOOK_CALLERS: usize = 1;
/// The message of a panic whose payload is not text.
const NO_TEXT: &str = "Box<dyn Any>";

/// The previous hook, as `std::panic::take_hook` gives it.
type PreviousHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

/// What the hook holds: the sinks, the hook it chains to and the game's main thread.
struct Hook {
    sinks: Vec<Box<dyn CrashSink>>,
    previous: PreviousHook,
    main: ThreadId,
}

static HOOK: OnceLock<Hook> = OnceLock::new();

thread_local! {
    /// Set while this thread delivers a record: a panic now is a sink's, and gets no record.
    static DELIVERING: Cell<bool> = const { Cell::new(false) };
    /// The GPU error the next panic on this thread is typed by.
    static PENDING_GPU: RefCell<Option<(GpuErrorClass, String)>> = const { RefCell::new(None) };
}

/// Whether [`install`] installed the hook or found it installed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installed {
    /// This call installed it with its sinks.
    Now,
    /// It was installed before; this call's sinks were dropped.
    Already,
}

/// Install the hook once, chaining the hook installed before it; the thread that installs it is
/// the game's main thread. A second call changes nothing and drops its sinks.
pub fn install(sinks: Vec<Box<dyn CrashSink>>) -> Installed {
    let mut installed = Installed::Already;
    HOOK.get_or_init(|| {
        installed = Installed::Now;
        Hook { sinks, previous: std::panic::take_hook(), main: std::thread::current().id() }
    });
    if installed == Installed::Now {
        // A closure, not the function itself: std calls a boxed hook through its vtable, and for a
        // function item that goes through a trampoline frame the stack walk could not tell from
        // std's own. The closure's call to `record_panic` is never a tail call (the previous hook
        // runs after it), so the closure is exactly one frame below it.
        std::panic::set_hook(Box::new(|info: &PanicHookInfo<'_>| {
            record_panic(info);
            call_previous(info);
        }));
    }
    installed
}

/// The next panic on this thread is typed `gpu-validation` with this class and description.
pub fn note_gpu_error(class: GpuErrorClass, description: &str) {
    let _ = PENDING_GPU.try_with(|pending| {
        if let Ok(mut pending) = pending.try_borrow_mut() {
            *pending = Some((class, description.to_string()));
        }
    });
}

/// A record now that the GPU device was lost (not fatal: recovery goes on), to every sink.
/// `reason` is wgpu's lost reason as text, `message` its description. Nothing without the hook.
pub fn record_device_lost(reason: &str, message: &str) {
    let Some(hook) = HOOK.get() else { return };
    let ctx = context();
    let mut record = base_record(CrashKind::DeviceLost, false, message, ctx, hook.main);
    let (backend, adapter) = ctx.gpu_adapter();
    record.gpu = Some(CrashGpu {
        class: None,
        reason: Some(reason.to_string()),
        description: message.to_string(),
        backend,
        adapter,
    });
    deliver_inline(hook, &record);
}

/// The installed hook's first half: a record for the panic, unless it is a sink's. Never inlined:
/// the stack walk skips every frame down to this function and the hook closure below it.
#[inline(never)]
fn record_panic(info: &PanicHookInfo<'_>) {
    let Some(hook) = HOOK.get() else { return };
    if is_delivering() {
        return;
    }
    let record = panic_record(info, hook);
    deliver_from_hook(hook, &record);
}

/// The installed hook's second half: the hook installed before it.
fn call_previous(info: &PanicHookInfo<'_>) {
    if let Some(hook) = HOOK.get() {
        (hook.previous)(info);
    }
}

/// The record of the panic `info` describes, on this thread, now.
fn panic_record(info: &PanicHookInfo<'_>, hook: &Hook) -> CrashRecord {
    let hook_start = record_panic as fn(&PanicHookInfo<'_>) as usize as u64;
    let frames = frames::capture(hook_start, HOOK_CALLERS);
    let message = info.payload_as_str().unwrap_or(NO_TEXT);
    let location = info.location().map(|at| CrashLocation {
        file: at.file().to_string(),
        line: u64::from(at.line()),
        column: u64::from(at.column()),
    });
    let facts = PanicFacts { message, location, frames, handled: is_catching(), gpu: take_pending_gpu() };
    record_from(facts, context(), hook.main)
}

/// What the hook knows of one panic.
struct PanicFacts<'a> {
    message: &'a str,
    location: Option<CrashLocation>,
    frames: Vec<crate::record::CrashFrame>,
    handled: bool,
    gpu: Option<(GpuErrorClass, String)>,
}

/// The record of a panic: typed by a pending GPU error, fatal unless caught.
fn record_from(facts: PanicFacts<'_>, ctx: &CrashContext, main: ThreadId) -> CrashRecord {
    let kind = if facts.gpu.is_some() { CrashKind::GpuValidation } else { CrashKind::Panic };
    let mut record = base_record(kind, !facts.handled, facts.message, ctx, main);
    record.handled = facts.handled;
    record.location = facts.location;
    record.frames = facts.frames;
    if let Some((class, description)) = facts.gpu {
        let (backend, adapter) = ctx.gpu_adapter();
        record.gpu = Some(CrashGpu { class: Some(class), reason: None, description, backend, adapter });
    }
    record
}

/// A game record of `kind` with this thread, the anchor, the context, the replay and the profile.
fn base_record(kind: CrashKind, fatal: bool, message: &str, ctx: &CrashContext, main: ThreadId) -> CrashRecord {
    let current = std::thread::current();
    let mut record = CrashRecord::new(kind, CrashSource::Game, fatal, message);
    record.thread = Some(CrashThread { name: current.name().unwrap_or("").to_string(), main: current.id() == main });
    record.anchor = frames::anchor_ip();
    record.context = ctx.snapshot();
    record.replay = read_tail(&record.context);
    record.profile = ctx.profile_summary();
    record
}

/// Deliver from inside the panic hook: on a delivery thread, joined, so a sink's panic stays
/// there. Inline when no thread can be started (wasm32, or the system refused one).
fn deliver_from_hook(hook: &Hook, record: &CrashRecord) {
    std::thread::scope(|scope| {
        let delivery = std::thread::Builder::new()
            .name(DELIVERY_THREAD.to_string())
            .spawn_scoped(scope, || deliver_inline(hook, record));
        match delivery {
            // Joined here, so the scope never re-raises the delivery thread's panic.
            Ok(delivery) => drop(delivery.join()),
            // No thread: inline, where a panicking sink aborts (std's rule for a panic in a hook).
            Err(_) => deliver_inline(hook, record),
        }
    });
}

/// Hand the record to every sink on this thread, the delivery guard set; a sink's panic is caught
/// (outside the panic hook) and the next sink still gets the record.
fn deliver_inline(hook: &Hook, record: &CrashRecord) {
    let json = record.to_json();
    let _guard = Delivering::enter();
    for sink in &hook.sinks {
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| sink.deliver(record, &json)));
    }
}

fn is_delivering() -> bool {
    DELIVERING.try_with(Cell::get).unwrap_or(false)
}

/// The pending GPU error of this thread, taken.
fn take_pending_gpu() -> Option<(GpuErrorClass, String)> {
    PENDING_GPU.try_with(|pending| pending.try_borrow_mut().ok().and_then(|mut slot| slot.take())).ok().flatten()
}

/// The delivery guard of this thread, cleared when dropped.
struct Delivering;

impl Delivering {
    fn enter() -> Delivering {
        let _ = DELIVERING.try_with(|flag| flag.set(true));
        Delivering
    }
}

impl Drop for Delivering {
    fn drop(&mut self) {
        let _ = DELIVERING.try_with(|flag| flag.set(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kind::CrashFlavour;
    use crate::record::CrashFrame;

    fn facts(frames: Vec<CrashFrame>, handled: bool, gpu: Option<(GpuErrorClass, String)>) -> PanicFacts<'static> {
        let location = Some(CrashLocation { file: "src/enemy.rs".into(), line: 42, column: 17 });
        PanicFacts { message: "index out of bounds", location, frames, handled, gpu }
    }

    #[test]
    fn a_panic_with_no_frames_still_gives_a_record() {
        // The wasm32 path: no stack walk, the record otherwise whole and parseable by the host.
        let ctx = CrashContext::new();
        ctx.set_seed(4);
        ctx.set_tick(10, 166.0, true);
        let record = record_from(facts(Vec::new(), false, None), &ctx, std::thread::current().id());
        assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::Panic, true, false));
        assert!(record.frames.is_empty());
        assert_eq!(record.thread.as_ref().map(|thread| thread.main), Some(true));
        assert_eq!((record.context.seed, record.context.tick), (Some(4), Some(10)));
        let parsed = CrashRecord::from_json(&record.to_json()).expect("the host parses it");
        assert_eq!(parsed.message, "index out of bounds");
    }

    #[test]
    fn a_caught_panic_is_handled_and_a_gpu_cause_types_it() {
        let ctx = CrashContext::new();
        let other = std::thread::Builder::new()
            .spawn(|| std::thread::current().id())
            .and_then(|thread| thread.join().map_err(|_| std::io::Error::other("the thread panicked")))
            .expect("a thread id");
        let gpu = Some((GpuErrorClass::OutOfMemory, "out of memory".to_string()));
        let record = record_from(facts(vec![CrashFrame::Ip(0x10)], true, gpu), &ctx, other);
        assert_eq!((record.kind, record.fatal, record.handled), (CrashKind::GpuValidation, false, true));
        assert_eq!(record.gpu.and_then(|gpu| gpu.class), Some(GpuErrorClass::OutOfMemory));
        assert_eq!(record.thread.map(|thread| thread.main), Some(false), "not the installing thread");
        assert_eq!(record.context.flavour, None::<CrashFlavour>);
    }
}
