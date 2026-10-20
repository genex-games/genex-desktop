//! genex-crash: crash reports for genex games, below the facade. A panic or a GPU error becomes a
//! typed record (kind, raw instruction pointers with a slide anchor, the tick and its context),
//! written to a capped file sink the Studio reads, with the inputs to replay the ticks before it.
//! Symbols are resolved by the host, never in the game.
//!
//! Every planned module is declared now so each work package fills one body (G6 crash reports,
//! PROF-0d); a module that names its work package is still a stub. The record, its vocabularies,
//! caps and the file sink are filled (CRASH-1a).

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
pub use file_sink::{CRASH_DIR, CrashSink, FileSink, FileSinkError, FnSink};
pub use kind::{CrashFlavour, CrashKind, CrashSource, CrashTrimmed, GpuErrorClass, WasmTrap};
pub use record::{
    CRASH_FORMAT, CrashFrame, CrashGpu, CrashImage, CrashLocation, CrashParseError, CrashRecord, CrashReplay,
    CrashThread, CrashWasm, RecordContext, WasmFrame,
};
