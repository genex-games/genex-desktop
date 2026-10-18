//! Vertex-shader skinning for far, small characters (the per-class switch from compute skinning).
//!
//! Stub until AN-18 fills it.

/// Vertex-shader skinning (a stub entry until AN-18).
pub const SKIN_VERTEX: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/skin_vertex.wgsl"));
