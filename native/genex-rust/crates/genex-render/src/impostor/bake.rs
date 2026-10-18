//! The impostor bake: frames rendered at build time (LOD-23) or, as the fallback, at runtime.
//!
//! Stub until LOD-13 fills it.

/// The bake's G-buffer pass (a stub entry until LOD-13).
pub const IMPOSTOR_BAKE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/impostor/bake.wgsl"));
/// The atlas pack (a stub entry until LOD-13).
pub const IMPOSTOR_PACK: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/impostor/pack.wgsl"));
/// The atlas mips (a stub entry until LOD-13).
pub const IMPOSTOR_MIP: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/impostor/mip.wgsl"));
