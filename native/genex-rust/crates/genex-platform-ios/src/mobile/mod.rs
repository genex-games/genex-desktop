//! The phone shell both phone crates run: genex-platform-ios uses it here, and
//! genex-platform-android re-exports it, so the lifecycle rule, the touches, the safe-area
//! presentation, the audio gate, the records and the self-test are one copy. Each crate keeps only
//! what its platform alone has: its entry, its safe-area source, its records root and its audio
//! session or focus calls. Everything here is plain winit + wgpu, so it builds and its unit tests
//! run on the host.
//!
//! - [`lifecycle`]: a surface exists only between `resumed` and `suspended`; one offered outside
//!   is refused with the typed `surface-before-resumed` code.
//! - [`touch`]: every finger reaches `ctx.touches` with an id of its own; the first also drives
//!   the facade's pointer and Mouse1.
//! - [`safe_area`] and [`present`]: insets, and the game letterboxed inside them.
//! - [`audio`]: whether the game should be heard, from the lifecycle, the platform's answer and
//!   its interruptions.
//! - [`admit`] and [`refusal`]: the adapter checked against WebGPU core before any device, and the
//!   refusal screen drawn without wgpu below it.
//! - [`gamepad`]: controllers mapped onto the standard order.
//! - [`keyboard`]: the soft keyboard's typing through genex-hud's bridge.
//! - [`orientation`]: rotation under one world size (Q5).
//! - [`thermal`]: frame pacing from the thermal state.
//! - [`frame_time`]: what a display frame feeds the live clock (whole refreshes).
//! - [`recovery`]: when a lost GPU device is re-created.
//! - [`configure`]: a surface configured only when no warm-up thread may submit.
//! - [`records`]: the self-test record, the typed `gpu-unsupported` record and the lifecycle log.
//! - [`selftest`]: the game's self-test run once on the device's GPU before live play.
//! - [`shell`]: the winit + wgpu loop (WebGPU-core adapter check, surface per `resumed`, present).

pub mod admit;
pub mod audio;
pub mod configure;
pub mod crash;
pub mod frame_time;
pub mod gamepad;
pub mod keyboard;
pub mod lifecycle;
pub mod orientation;
pub mod present;
pub mod records;
pub mod recovery;
pub mod refusal;
pub mod safe_area;
pub mod selftest;
pub mod shell;
pub mod thermal;
pub mod touch;
