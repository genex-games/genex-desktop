//! Host transport (fd 3, the Windows named pipe), NDJSON verb dispatcher and Stop. Present in the
//! dev flavour only: an exported game never links it (the admission symbol scan proves that).
//!
//! The Rust port of the C++ template's `transport.h` and the verb half of `studio.cpp`:
//!
//! - [`transport`]: the studio's connection. When the studio starts a game it passes one duplex
//!   descriptor (`GENEX_STUDIO_FD`, always 3; on Windows the launcher's named pipe,
//!   `GENEX_STUDIO_PIPE`) and a nonce (`GENEX_STUDIO_NONCE`). A reader thread frames requests with
//!   genex-core's `LineReader` (1 MiB lines; a longer one is answered `line-too-long` and reading
//!   goes on) into a bounded queue that the main thread answers once per frame; a writer sends
//!   whole lines under a lock and goes quiet once the studio is gone. Without both variables
//!   nothing opens: web and exported builds never see it. A `loopback` TCP mode is stage-2 work.
//! - [`verbs`]: [`Studio`] answers every v1 op (`seed, start, pause, step, state, input, capture,
//!   debugCamera, cameras, eyes, demos, demo, audio`, and natively `audioLevel, timing, quit,
//!   front, visible`) against a [`StudioGame`], with `studio.cpp`'s semantics: the JS `>>> 0`
//!   seed, `busy` while the game ticks or draws, demos that end paused, captures written as
//!   `state/captures/<seq>.bgra` (eight kept) with their FNV-1a digest. Requests that arrive
//!   before `ready` wait in the queue and are answered after it; only the web flavour answers a
//!   call before the game began `starting`.
//!
//! Stop is the host's (`quit`, then SIGTERM to the game's process group after
//! `NATIVE_QUIT_GRACE_MS`, then SIGKILL after `NATIVE_TERM_GRACE_MS`); the game's part is to end
//! with exit 0 after `quit` or the studio's end of file ([`Studio::closing`]) and to keep the
//! default SIGTERM action. `examples/studio-spike.rs` is the binary the host-side conformance test
//! (`tests/conformance/rust-protocol-spike.test.ts`) drives through `NativeGamePort`.
//!
//! - [`wire`]: contract v2's wire types (protocol 2, the capability receipt, lifecycle and safe
//!   area in `state()`, touch input, the GPU refusal and bound codes, the ring verbs' arguments),
//!   held to the host's `native-contract.ts` through `tests/fixtures/native-wire-v2.json`.
//!
//! The adopted descriptor is marked close-on-exec, as `transport.cpp` does, so a process the game
//! spawns never inherits the studio's socket.
//!
//! `genex::install` hands its `Runtime<W>` to this crate through the facade's own `StudioGame`
//! implementation (the facade owns that adapter, so this crate keeps depending on genex-core
//! only). A game that can embed in Live (`StudioGame::embeddable`) also serves `surface` and
//! `release`; its frames go out through genex-frames, which the facade drives.

pub mod transport;
pub mod verbs;
pub mod wire;

#[cfg(windows)]
mod pipe;

pub use genex_core::input::Injection;
#[cfg(unix)]
pub use transport::SocketChannel;
pub use transport::{
    Channel, MAX_NONCE_BYTES, MAX_QUEUED_LINES, MAX_RUN_ID_CHARS, MIN_RUN_ID_CHARS, NONCE_ENV, PIPE_ENV, PIPE_PREFIX,
    STUDIO_FD, Transport, WRITE_STALL, from_environment, report_crashes, report_panics, studio_pipe_name,
};
pub use verbs::{
    CAPTURE_FORMAT, CAPTURE_MAX_BYTES, CAPTURE_MAX_PX, CAPTURES_KEPT, CaptureFault, CaptureLens, DEFAULT_CAMERA, FatalReason, Op,
    Pixels, ReadyInfo, RingFault, Served, Studio, StudioGame, VerbRefusal,
};
