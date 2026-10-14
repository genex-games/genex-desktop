//! Part-2 bounds (M2.6). [`crate::caps`] holds the byte caps every GPU resource is checked
//! against (WGSL, buffers, textures, per-frame uploads, captures); these are the counts the
//! immediate primitives, the WGSL extension points, the particle emitters, the HUD's world labels
//! and HiDPI sizing add on top. Each refusal reuses a typed code the host already matches:
//!
//! | cap | refused with |
//! | --- | --- |
//! | [`IMMEDIATE_QUADS_MAX`] 2D quads a frame | `upload-budget` (they are one frame's uploads) |
//! | [`EXTENSION_UNIFORM_MAX_BYTES`], [`CUSTOM_MATERIALS_MAX`], [`POST_PASSES_MAX`] | `wgsl-too-large` (the extension budget naga admits against) |
//! | [`PARTICLE_EMITTERS_MAX`], [`PARTICLES_PER_EMITTER_MAX`] | `buffer-too-large` (the particle state buffers) |
//! | [`WORLD_LABELS_MAX`] | labels past it are dropped, nearest kept (a HUD paint, never a refusal) |

use crate::error::{RenderCode, RenderError};

/// 2D quads (rects, sprites, 2D lines) one frame may draw: 288 bytes of vertices each (4.5 MiB at
/// the cap), far inside [`crate::UPLOAD_MAX_BYTES_PER_FRAME`].
pub const IMMEDIATE_QUADS_MAX: usize = 16_384;
/// The largest uniform block a WGSL extension may declare (WebGPU core allows 64 KiB per binding;
/// an extension's parameters are a handful of vectors).
pub const EXTENSION_UNIFORM_MAX_BYTES: u64 = 1024;
/// Custom materials one renderer may hold.
pub const CUSTOM_MATERIALS_MAX: usize = 32;
/// Post passes one renderer may hold (a frame may run each once).
pub const POST_PASSES_MAX: usize = 8;
/// Particle emitters one renderer may hold.
pub const PARTICLE_EMITTERS_MAX: usize = 16;
/// Live particles one emitter may hold (its slots: spawn rate × lifetime).
pub const PARTICLES_PER_EMITTER_MAX: u32 = 16_384;
/// World labels one frame may project; the farthest beyond it are dropped.
pub const WORLD_LABELS_MAX: usize = 256;
/// The largest device-pixel ratio the world target scales by (plan "HiDPI and pacing").
pub const RENDER_SCALE_MAX: f32 = 2.0;

/// Refuse `count` above `max` with `code`, naming `what`.
pub fn check_count(what: &str, count: usize, max: usize, code: RenderCode) -> Result<(), RenderError> {
    if count > max {
        return Err(RenderError::refused(code, format!("{count} {what}, at most {max}")));
    }
    Ok(())
}
