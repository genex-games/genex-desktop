//! Typed refusals of the sender: a code a caller matches on, and a detail for the log.

use std::fmt;

/// Why the sender refused or failed. The wire spelling is [`FramesCode::as_str`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FramesCode {
    /// The announced ring is outside the wire limits (generation 0, 0 or more than 3 slots, a side
    /// of 0 or over 8192, more than 32 Mpx).
    InvalidRing,
    /// The service name is not `games.genex.frames.<runId>` with a run id of `[A-Za-z0-9-]{8,64}`.
    InvalidServiceName,
    /// `bootstrap_look_up` did not find the run's service (not this run's name, or denied).
    LookupFailed,
    /// The device is not wgpu's Metal backend, so no IOSurface can be adopted.
    NotMetal,
    /// `IOSurfaceCreate` returned nothing.
    SurfaceCreateFailed,
    /// Metal could not make a texture over the IOSurface (the M0a KILL condition).
    TextureAdoptFailed,
    /// A frame was presented before any ring was announced.
    NoRing,
    /// The GPU did not finish the frame's blit.
    GpuWaitFailed,
    /// `mach_msg` did not deliver the frame (timeout, dead name, no space).
    SendFailed,
    /// `seq` reached 2^53 - 1; JavaScript cannot carry a larger one exactly.
    SeqExhausted,
}

impl FramesCode {
    /// The code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            FramesCode::InvalidRing => "invalid-ring",
            FramesCode::InvalidServiceName => "invalid-service-name",
            FramesCode::LookupFailed => "lookup-failed",
            FramesCode::NotMetal => "not-metal",
            FramesCode::SurfaceCreateFailed => "surface-create-failed",
            FramesCode::TextureAdoptFailed => "texture-adopt-failed",
            FramesCode::NoRing => "no-ring",
            FramesCode::GpuWaitFailed => "gpu-wait-failed",
            FramesCode::SendFailed => "send-failed",
            FramesCode::SeqExhausted => "seq-exhausted",
        }
    }
}

/// A refusal with its code and what happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FramesError {
    /// What a caller matches on.
    pub code: FramesCode,
    /// What happened, for the log.
    pub detail: String,
    /// The kernel's code for [`FramesCode::LookupFailed`] and [`FramesCode::SendFailed`].
    pub kern_return: Option<i32>,
}

impl FramesError {
    /// A refusal of `code` with `detail`.
    pub fn new(code: FramesCode, detail: impl Into<String>) -> FramesError {
        FramesError { code, detail: detail.into(), kern_return: None }
    }

    /// The same refusal carrying the kernel's code.
    pub fn with_kern_return(self, kern_return: i32) -> FramesError {
        FramesError { kern_return: Some(kern_return), ..self }
    }
}

impl fmt::Display for FramesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for FramesError {}
