//! GPU bounds. ProcessSandbox bounds CPU, memory and files, not GPU work, so the renderer checks
//! every shader, buffer, texture, frame upload and capture against these caps before the GPU sees
//! it. Each cap fits inside WebGPU's default limits, so a game that runs on the Mac cannot exceed
//! what the web allows.

use crate::error::{RenderCode, RenderError};

/// The longest WGSL source the renderer compiles (its own shaders and, later, extensions).
pub const WGSL_MAX_BYTES: usize = 256 * 1024;
/// The largest buffer: WebGPU core's `max_storage_buffer_binding_size` (128 MiB).
pub const BUFFER_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// The largest texture: a 4096 × 4096 RGBA8 image.
pub const TEXTURE_MAX_BYTES: u64 = 4096 * 4096 * 4;
/// Bytes one frame may write to GPU buffers (instance, material, batch, line tables): a hard
/// refusal ([`UploadBudget`]). Streamed assets go through the soft upload queue instead
/// ([`crate::upload_queue`]), which spreads them over frames under the class's smaller budget
/// ([`crate::presets::stream_budget`]); this cap does not move for them.
pub const UPLOAD_MAX_BYTES_PER_FRAME: u64 = 32 * 1024 * 1024;
/// The largest capture, equal to the host's `NATIVE_CAPTURE_MAX_BYTES`.
pub const CAPTURE_MAX_BYTES: u64 = 4096 * 4096 * 4;
/// The world target's side is kept between these, as the C++ runtime's `MIN_WORLD_PX`/`MAX_WORLD_PX`:
/// genex-core's values, so the facade's install check, the renderer and `ready` agree.
pub use genex_core::protocol::{MAX_WORLD_PX, MIN_WORLD_PX};

/// Refuse a WGSL source above [`WGSL_MAX_BYTES`].
pub fn check_wgsl(source: &str) -> Result<(), RenderError> {
    if source.len() > WGSL_MAX_BYTES {
        return Err(RenderError::refused(
            RenderCode::WgslTooLarge,
            format!("{} bytes of WGSL, at most {WGSL_MAX_BYTES}", source.len()),
        ));
    }
    Ok(())
}

/// Refuse an empty buffer or one above [`BUFFER_MAX_BYTES`].
pub fn check_buffer(bytes: u64) -> Result<(), RenderError> {
    if bytes == 0 || bytes > BUFFER_MAX_BYTES {
        return Err(RenderError::refused(
            RenderCode::BufferTooLarge,
            format!("{bytes} bytes, between 1 and {BUFFER_MAX_BYTES}"),
        ));
    }
    Ok(())
}

/// Refuse a texture whose bytes exceed [`TEXTURE_MAX_BYTES`] or whose side exceeds [`MAX_WORLD_PX`].
pub fn check_texture(width: u32, height: u32, bytes_per_pixel: u32) -> Result<(), RenderError> {
    let bytes = u64::from(width).saturating_mul(u64::from(height)).saturating_mul(u64::from(bytes_per_pixel));
    let too_wide = width > MAX_WORLD_PX || height > MAX_WORLD_PX;
    if too_wide || bytes > TEXTURE_MAX_BYTES {
        return Err(RenderError::refused(
            RenderCode::TextureTooLarge,
            format!("{width}×{height}×{bytes_per_pixel} is above {TEXTURE_MAX_BYTES} bytes or {MAX_WORLD_PX} px"),
        ));
    }
    Ok(())
}

/// The world target's size, each side clamped to [`MIN_WORLD_PX`]..=[`MAX_WORLD_PX`].
pub fn world_size(width: u32, height: u32) -> (u32, u32) {
    (width.clamp(MIN_WORLD_PX, MAX_WORLD_PX), height.clamp(MIN_WORLD_PX, MAX_WORLD_PX))
}

/// The bytes one frame has written so far; a charge that would cross the cap is refused and
/// not counted.
#[derive(Debug, Default)]
pub struct UploadBudget {
    used: u64,
}

impl UploadBudget {
    /// An empty budget for a new frame.
    pub fn new() -> UploadBudget {
        UploadBudget::default()
    }

    /// Count `bytes`, or refuse `upload-budget` when they would cross [`UPLOAD_MAX_BYTES_PER_FRAME`].
    pub fn charge(&mut self, bytes: u64) -> Result<(), RenderError> {
        match self.used.checked_add(bytes) {
            Some(total) if total <= UPLOAD_MAX_BYTES_PER_FRAME => {
                self.used = total;
                Ok(())
            }
            _ => Err(RenderError::refused(
                RenderCode::UploadBudget,
                format!("{bytes} more bytes after {}, at most {UPLOAD_MAX_BYTES_PER_FRAME} per frame", self.used),
            )),
        }
    }

    /// Bytes counted so far.
    pub fn used(&self) -> u64 {
        self.used
    }
}
