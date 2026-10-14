//! macOS embedded mode: the GXF wire v1 sender over an IOSurface ring.
//!
//! The game renders its frame with wgpu; [`sender::FrameSender`] blits it bottom-up into a free
//! slot of the ring the host announced (IOSurfaces adopted by wgpu through
//! `create_texture_from_hal`), waits for the GPU, then sends one 80-byte `GXF1` Mach message that
//! moves a send right to the slot's IOSurface to `games.genex.frames.<runId>`. The slot is the
//! host's until its `release`. The receive-only addon (`native/genex-frames/`) and the wire are
//! unchanged; [`wire`] reproduces `gxf_wire.h` with const-asserted sizes.
//!
//! [`wire`] (payload, service names), [`ring`] and [`error`] are portable so their rules are
//! tested everywhere; the Mach, IOSurface and Metal modules build on macOS only.
#![cfg_attr(
    target_os = "macos",
    allow(unsafe_code, reason = "Mach messages, IOSurface and Metal objects are FFI; each block says why it holds")
)]

pub mod error;
pub mod ring;
pub mod wire;

#[cfg(target_os = "macos")]
pub mod blit;
#[cfg(target_os = "macos")]
pub mod connection;
#[cfg(target_os = "macos")]
pub mod gpu;
#[cfg(target_os = "macos")]
pub mod sender;
#[cfg(target_os = "macos")]
pub mod surface;

pub use error::{FramesCode, FramesError};
