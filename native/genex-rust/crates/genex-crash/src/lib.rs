//! genex-crash: crash reports for genex games, below the facade. A panic or a GPU error becomes a
//! typed record (kind, raw instruction pointers with a slide anchor, the tick and its context),
//! written to a capped file sink the Studio reads, with the inputs to replay the ticks before it.
//! Symbols are resolved by the host, never in the game.
//!
//! The record, its vocabularies, caps and the file sink (CRASH-1a); the chained panic hook with raw
//! frames and the slide anchor, the crash context, `catching` and the replay source (CRASH-1b).

pub mod kind;
pub mod caps;
pub mod record;
pub mod file_sink;
pub mod context;
pub mod frames;
pub mod hook;
pub mod catching;
pub mod replay;

pub use caps::{CRASH_FILES_KEPT, CRASH_RECORD_MAX_BYTES};
pub use catching::catching;
pub use context::{CrashContext, CrashIdentity, context};
pub use file_sink::{CRASH_DIR, CrashSink, FileSink, FileSinkError, FnSink};
pub use frames::anchor;
pub use hook::{Installed, install, note_gpu_error, record_device_lost};
pub use kind::{CrashFlavour, CrashKind, CrashSource, CrashTrimmed, GpuErrorClass, WasmTrap};
pub use record::{
    CRASH_FORMAT, CrashFrame, CrashGpu, CrashImage, CrashLocation, CrashParseError, CrashRecord, CrashReplay,
    CrashThread, CrashWasm, RecordContext, WasmFrame,
};
pub use replay::{ReplaySource, ReplayTail, set_replay_source};
