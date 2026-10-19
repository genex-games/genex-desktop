//! Typed refusals. Every error carries a [`RenderCode`] whose wire spelling the host and the
//! capability receipt use; the codes shared with v1 (`no-state-dir`, `capture-failed`) keep the
//! C++ runtime's spelling.

/// Why the renderer refused. Wire values never change once shipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RenderCode {
    /// No adapter, or one below WebGPU core (limits, compliance or backend).
    GpuUnsupported,
    /// The device request itself failed after the floor check passed.
    DeviceFailed,
    /// A WGSL source is longer than [`crate::WGSL_MAX_BYTES`], or naga rejected it.
    WgslTooLarge,
    /// A buffer is empty or larger than [`crate::BUFFER_MAX_BYTES`].
    BufferTooLarge,
    /// A texture is larger than [`crate::TEXTURE_MAX_BYTES`].
    TextureTooLarge,
    /// A frame's uploads would exceed [`crate::UPLOAD_MAX_BYTES_PER_FRAME`].
    UploadBudget,
    /// A capture would exceed [`crate::CAPTURE_MAX_BYTES`].
    CaptureTooLarge,
    /// The capture could not be read back or written (v1 code).
    CaptureFailed,
    /// The run has no absolute state folder for capture files (v1 code).
    NoStateDir,
    /// A mesh is malformed, references an external buffer, or is unknown; also a skin whose
    /// joints, weights or matrices do not match its mesh.
    MeshInvalid,
    /// Texture data whose bytes do not match its size, or an empty one (M2.5; not yet in the
    /// host's `NativeGpuBound`).
    TextureInvalid,
    /// The device was lost; frames and captures answer this until it is re-created (M2.6, the
    /// host's `NativeRefusal.DeviceLost`).
    DeviceLost,
    /// A declared native-enhanced feature the device was not opened with, an extension that needs
    /// one it was not declared, or an unknown feature name (M2.6, `NativeRefusal.NativeFeatureMissing`).
    NativeFeatureMissing,
    /// A custom GPU pass (extension ladder level 3, M2.19) was refused: its WGSL is over
    /// [`crate::WGSL_MAX_BYTES`] or fails naga, a resource breaks the pass rules, or wgpu's
    /// validation caught an error inside it (`NativeRefusal.GpuPassInvalid`). The detail names the
    /// pass.
    GpuPassInvalid,
    /// Growing the mesh arena would hold more than its peak limit at once (WebGPU and phones:
    /// [`crate::mesh_arena::ARENA_PEAK_MAX_BYTES_CONSTRAINED`]); nothing was made or written, and
    /// the caller evicts first (game systems STR-2).
    StreamArenaFull,
}

impl RenderCode {
    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            RenderCode::GpuUnsupported => "gpu-unsupported",
            RenderCode::DeviceFailed => "device-failed",
            RenderCode::WgslTooLarge => "wgsl-too-large",
            RenderCode::BufferTooLarge => "buffer-too-large",
            RenderCode::TextureTooLarge => "texture-too-large",
            RenderCode::UploadBudget => "upload-budget",
            RenderCode::CaptureTooLarge => "capture-too-large",
            RenderCode::CaptureFailed => "capture-failed",
            RenderCode::NoStateDir => "no-state-dir",
            RenderCode::MeshInvalid => "mesh-invalid",
            RenderCode::TextureInvalid => "texture-invalid",
            RenderCode::DeviceLost => "device-lost",
            RenderCode::NativeFeatureMissing => "native-feature-missing",
            RenderCode::GpuPassInvalid => "gpu-pass-invalid",
            RenderCode::StreamArenaFull => "stream-arena-full",
        }
    }
}

impl std::fmt::Display for RenderCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.wire())
    }
}

/// Why an adapter is below the WebGPU-core floor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnsupportedReason {
    /// No adapter on the requested backends.
    NoAdapter,
    /// The backend is not Metal, D3D12, Vulkan or the browser's WebGPU.
    Backend,
    /// `DownlevelCapabilities::is_webgpu_compliant()` is false.
    NotWebGpuCompliant,
    /// A limit is below `Limits::defaults()`; the first one found is named.
    LimitBelowCore {
        /// The wgpu field name of the limit.
        limit: String,
    },
}

/// Why a WGSL extension (`Material::custom`, `post_pass`) was refused (M2.6). The host sees the
/// refusal's code (`wgsl-too-large` for every fault naga or the caps raise); the fault tells the
/// game's author which rule the source broke. Wire values never change once shipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExtensionFault {
    /// The source is longer than [`crate::WGSL_MAX_BYTES`].
    TooLarge,
    /// The source path is absolute, climbs out of the game, is a symlink, not a regular file, or
    /// missing.
    PathRefused,
    /// naga could not parse or validate it against WebGPU core plus the declared features.
    Invalid,
    /// A binding that is not in the extension API's fixed layout, or uniforms of another size.
    LayoutMismatch,
    /// Its entry point is missing, or it declares entry points of its own.
    EntryPoint,
}

impl ExtensionFault {
    /// The fault's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ExtensionFault::TooLarge => "too-large",
            ExtensionFault::PathRefused => "path-refused",
            ExtensionFault::Invalid => "invalid",
            ExtensionFault::LayoutMismatch => "layout-mismatch",
            ExtensionFault::EntryPoint => "entry-point",
        }
    }

    /// The fault of an extension refusal; `None` for any other error.
    pub fn of(error: &RenderError) -> Option<ExtensionFault> {
        match error {
            RenderError::Refused { fault, .. } => *fault,
            RenderError::GpuUnsupported { .. } => None,
        }
    }
}

/// A refusal with its code and what caused it.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RenderError {
    /// The GPU is below WebGPU core.
    #[error("gpu-unsupported: {reason:?} ({detail})")]
    GpuUnsupported {
        /// Which part of the floor failed.
        reason: UnsupportedReason,
        /// The adapter and backend, for the person.
        detail: String,
    },
    /// Any other refusal.
    #[error("{code}: {detail}")]
    Refused {
        /// The typed code.
        code: RenderCode,
        /// What was refused.
        detail: String,
        /// Which extension rule was broken, for an extension refusal (M2.6); `None` otherwise.
        fault: Option<ExtensionFault>,
    },
}

impl RenderError {
    /// A refusal with `code`.
    pub fn refused(code: RenderCode, detail: impl Into<String>) -> RenderError {
        RenderError::Refused { code, detail: detail.into(), fault: None }
    }

    /// An extension refusal: `code` with the rule the source broke.
    pub fn extension(code: RenderCode, fault: ExtensionFault, detail: impl Into<String>) -> RenderError {
        RenderError::Refused { code, detail: format!("{}: {}", fault.wire(), detail.into()), fault: Some(fault) }
    }

    /// The typed code.
    pub fn code(&self) -> RenderCode {
        match self {
            RenderError::GpuUnsupported { .. } => RenderCode::GpuUnsupported,
            RenderError::Refused { code, .. } => *code,
        }
    }
}
