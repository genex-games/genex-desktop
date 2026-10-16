//! The renderer's WGSL (crate `shaders/`). Every source is checked against
//! [`crate::WGSL_MAX_BYTES`] when compiled and validated by naga against WebGPU core (no
//! capabilities) in tests/layout.rs. M2.6's passes and the extension preludes (each with a sample
//! entry point, so the prelude is validated whole) are in [`SHADERS`] too. A web build ships the
//! renderer's own passes minified ([`minify`]: no comments or indentation, the same module); the
//! extension preludes stay as written everywhere, since a game's shader diagnostics count their lines.

use std::borrow::Cow;

use wgpu::{Device, ShaderModule};

use crate::caps::check_wgsl;
use crate::error::RenderError;

pub mod minify;
use minify::shipped_wgsl;

/// The lighting chunks (plan §2.3), in the order a forward fragment applies them (the decals,
/// renderer pass 2 A.10, blend into the surface before any light): each is one
/// function with its own file under `shaders/lighting/`. Later tiers own one chunk each; the
/// Level-2 v2 prelude is built from the same chunks, so shading reaches custom materials too.
pub const LIGHTING_CHUNKS: &[(&str, &str)] = &[
    ("surface", include_str!("../shaders/lighting/surface.wgsl")),
    ("decals", include_str!("../shaders/lighting/decals.wgsl")),
    ("ambient", include_str!("../shaders/lighting/ambient.wgsl")),
    ("sun", include_str!("../shaders/lighting/sun.wgsl")),
    ("local-lights", include_str!("../shaders/lighting/local_lights.wgsl")),
    ("fog", include_str!("../shaders/lighting/fog.wgsl")),
    ("output", include_str!("../shaders/lighting/output.wgsl")),
];

/// Forward metallic-roughness shading (opaque and blended) through the visible list: the common
/// structs, the invariant clip position and the RQ4 effect declarations, the frame's environment
/// bindings, the BRDF, the lighting chunks, the forward pass's effect accessors, then the forward
/// entry points.
pub const FORWARD: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/forward_env.wgsl"),
    include_str!("../shaders/pbr.wgsl"),
    include_str!("../shaders/lighting/surface.wgsl"),
    include_str!("../shaders/lighting/decals.wgsl"),
    include_str!("../shaders/lighting/ambient.wgsl"),
    include_str!("../shaders/lighting/sun.wgsl"),
    include_str!("../shaders/lighting/local_lights.wgsl"),
    include_str!("../shaders/lighting/fog.wgsl"),
    include_str!("../shaders/lighting/output.wgsl"),
    include_str!("../shaders/forward_effects.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/forward.wgsl")
));
/// Depth-only shadow casters through a cascade's visible list.
pub const SHADOW: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/shadow_caster.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/shadow.wgsl")
));
/// The compute frustum cull writing indirect draw arguments for every view.
pub const CULL: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/geometry/lod_select.wgsl"), include_str!("../shaders/cull.wgsl")));
/// Compute skinning into the storage vertex buffer.
pub const SKIN: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/skin.wgsl")));
/// Immediate lines.
pub const LINES: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/lines.wgsl")));
/// The HDR scene's background under auto exposure: the clear colour exposed on the GPU.
pub const BACKGROUND: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/background.wgsl")));
/// The letterboxed present.
pub const BLIT: &str = shipped_wgsl!(include_str!("../shaders/blit.wgsl"));
/// The bilinear upscale of a scene drawn below scale 1 into the world target (graph node 22).
pub const UPSCALE_BILINEAR: &str = shipped_wgsl!(include_str!("../shaders/upscale_bilinear.wgsl"));

// --- Part 2 (M2.6) ---
/// Immediate 2D quads (rects, sprites, 2D lines) through the 2D camera.
pub const IMMEDIATE_2D: &str = shipped_wgsl!(include_str!("../shaders/part2/immediate2d.wgsl"));
/// The particle emitter's compute pass.
pub const PARTICLES_COMPUTE: &str = shipped_wgsl!(concat!(include_str!("../shaders/part2/particle.wgsl"), include_str!("../shaders/part2/particles_compute.wgsl")));
/// The particles' billboards, drawn inside the world pass.
pub const PARTICLES_DRAW: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/part2/particle.wgsl"),
    include_str!("../shaders/part2/particles_draw.wgsl")
));
/// The prelude of `Material::custom` (extension API v1), prepended to the game's source.
pub const MATERIAL_PRELUDE: &str = include_str!("../shaders/part2/material.wgsl");
/// The prelude of `post_pass` (extension API v1), prepended to the game's source.
pub const POST_PRELUDE: &str = include_str!("../shaders/part2/post.wgsl");
/// The material prelude with the default fragment (the tint, sun-lit).
pub const MATERIAL_SAMPLE: &str = shipped_wgsl!(concat!(include_str!("../shaders/part2/material.wgsl"), include_str!("../shaders/part2/material_sample.wgsl")));
/// The post prelude with the identity fragment.
pub const POST_SAMPLE: &str = shipped_wgsl!(concat!(include_str!("../shaders/part2/post.wgsl"), include_str!("../shaders/part2/post_sample.wgsl")));
/// A HiDPI world target averaged down to the logical world size for a capture.
pub const DOWNSAMPLE: &str = shipped_wgsl!(include_str!("../shaders/part2/downsample.wgsl"));

// --- RQ1: HDR, tonemapping, exposure; extension API v2 ---
/// The prelude of `gfx.material` at extension API v2, prepended to the game's source: the common
/// structs (`GxFrameV2` among them), the BRDF, the same lighting chunks [`FORWARD`] is built from
/// (so `gx_shade_pbr` is the renderer's own shading, and each tier's chunk reaches custom
/// materials), then the v2 bindings and helpers.
pub const MATERIAL_V2_PRELUDE: &str = concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/pbr.wgsl"),
    include_str!("../shaders/lighting/surface.wgsl"),
    include_str!("../shaders/lighting/decals.wgsl"),
    include_str!("../shaders/lighting/ambient.wgsl"),
    include_str!("../shaders/lighting/sun.wgsl"),
    include_str!("../shaders/lighting/local_lights.wgsl"),
    include_str!("../shaders/lighting/fog.wgsl"),
    include_str!("../shaders/lighting/output.wgsl"),
    include_str!("../shaders/part2/material_v2.wgsl")
);
/// The prelude of `gfx.post_pass` at extension API v2, prepended to the game's source.
pub const POST_V2_PRELUDE: &str = concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/part2/post_v2.wgsl"));
/// The v2 material prelude with the default fragment: the tint as a PBR surface, shaded by the
/// renderer's lighting.
pub const MATERIAL_V2_SAMPLE: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/pbr.wgsl"),
    include_str!("../shaders/lighting/surface.wgsl"),
    include_str!("../shaders/lighting/decals.wgsl"),
    include_str!("../shaders/lighting/ambient.wgsl"),
    include_str!("../shaders/lighting/sun.wgsl"),
    include_str!("../shaders/lighting/local_lights.wgsl"),
    include_str!("../shaders/lighting/fog.wgsl"),
    include_str!("../shaders/lighting/output.wgsl"),
    include_str!("../shaders/part2/material_v2.wgsl"),
    "
// The default v2 material: the tint, shaded like a built-in surface.
@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let s = gx_surface_v2(in.world_position, in.normal, in.tint.rgb, 0.0, 0.55);
    return vec4<f32>(gx_shade_pbr(s), 1.0);
}
"
));
/// The v2 post prelude with the identity fragment.
pub const POST_V2_SAMPLE: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/part2/post_v2.wgsl"),
    "
// The identity v2 post pass: the scene as it is.
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    return textureSampleLevel(gx_scene, gx_sampler, in.uv, 0.0);
}
"
));
/// The tonemap (graph node 21; `GX_TONEMAPPER` selects the curve).
pub const TONEMAP: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/post/tonemap.wgsl")));
/// The luminance-weighted MSAA resolve of the HDR scene (graph node 16 on desktop classes).
pub const RESOLVE_HDR: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/post/resolve_hdr.wgsl")));
/// Auto exposure's log-luminance histogram (graph node 20).
pub const EXPOSURE_HISTOGRAM: &str =
    shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/post/exposure_histogram.wgsl")));
/// Auto exposure's adaptation into the exposure state (graph node 20).
pub const EXPOSURE_ADAPT: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/post/exposure_adapt.wgsl")));

// --- RQ2: image-based lighting, the physical sky, HDR environment maps (RQ2.0 registers every
// RQ2 shader; RQ2.1 owns `shaders/ibl/`, RQ2.2 `shaders/sky/`) ---
/// IBL bake: an equirectangular HDR map into the specular cube's mip 0 (compute).
pub const IBL_EQUIRECT: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/ibl/equirect.wgsl")));
/// IBL bake: the GGX prefilter of one face and mip (compute, filtered importance sampling).
pub const IBL_PREFILTER: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/ibl/prefilter.wgsl")));
/// IBL bake: SH9 irradiance projection (compute, one 64-thread workgroup).
pub const IBL_SH9: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/ibl/sh9.wgsl")));
/// The split-sum BRDF LUT (a fragment pass into `rg16float`).
pub const IBL_BRDF_LUT: &str = shipped_wgsl!(include_str!("../shaders/ibl/brdf_lut.wgsl"));
/// The physical sky's transmittance LUT (compute).
pub const SKY_TRANSMITTANCE: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/sky/transmittance.wgsl")));
/// The physical sky's multiple-scattering LUT (compute).
pub const SKY_MULTISCATTER: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/sky/multiscatter.wgsl")));
/// The physical sky's sky-view LUT (compute, on the preset's cadence).
pub const SKY_VIEW: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/sky/sky_view.wgsl")));
/// The sky background and sun disk at the far plane (graph node 13, inside the world pass).
pub const SKY_DRAW: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/sky/sky_draw.wgsl")));
/// An HDR map behind the scene at the far plane (graph node 13 under an HDR environment).
pub const IBL_BACKDROP: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/ibl/backdrop.wgsl")));

// --- RQ4: the depth/normal prepass, bloom, AO, fog, contact shadows (RQ4.0 registers every RQ4
// shader; RQ4.1 owns `prepass.wgsl`, RQ4.2 `post/bloom_*`, RQ4.3 `sky/aerial_perspective.wgsl`,
// RQ4.4 `post/gtao.wgsl` and `post/ao_denoise.wgsl`, RQ4.7 `post/contact_shadow.wgsl`) ---
/// The depth/normal prepass (graph node 7): sampleable depth and octahedral `rg16float` normals.
pub const PREPASS: &str = shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/prepass.wgsl")
));
/// Bloom's downsample (graph node 19; threshold-free, Karis-weighted first step).
pub const BLOOM_DOWN: &str = shipped_wgsl!(include_str!("../shaders/post/bloom_down.wgsl"));
/// Bloom's tent upsample (graph node 19).
pub const BLOOM_UP: &str = shipped_wgsl!(include_str!("../shaders/post/bloom_up.wgsl"));
/// The aerial-perspective volume (graph node 11, medium and above).
pub const AERIAL_PERSPECTIVE: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/sky/aerial_perspective.wgsl")));
/// GTAO's horizon search into `r8unorm` (graph node 10).
pub const GTAO: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/effects.wgsl"), include_str!("../shaders/post/gtao.wgsl")));
/// AO's bilateral denoise and its own temporal history (graph node 10).
pub const AO_DENOISE: &str = shipped_wgsl!(concat!(include_str!("../shaders/effects.wgsl"), include_str!("../shaders/post/ao_denoise.wgsl")));
/// The joint-bilateral upsample of a half-resolution AO term or contact-shadow mask to the render
/// size (graph nodes 10 and 10a).
pub const JOINT_UPSAMPLE: &str = shipped_wgsl!(concat!(include_str!("../shaders/effects.wgsl"), include_str!("../shaders/post/joint_upsample.wgsl")));
/// The sun's screen-space contact shadows into an `r8unorm` mask (graph node 10a).
pub const CONTACT_SHADOW: &str = shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/post/contact_shadow.wgsl")));

/// The vertex entry points that write depth a later pass tests against, as (shader, entry point):
/// each computes its position with `gx_clip_position` and declares it `@invariant`
/// (tests/layout.rs reflects every one with naga). A new depth writer (R2's meshlet pulling) is
/// listed here.
pub const DEPTH_WRITING_VERTEX_ENTRIES: &[(&str, &str)] = &[
    ("forward", "vs_main"),
    ("prepass", "vs_prepass"),
    ("material-v2-sample", "gx_vs_material_v2"),
    // Renderer pass 2 A.7: the terrain's world-pass and motion-prepass vertices (its plain prepass
    // shares `vs_terrain`).
    ("terrain", "vs_terrain"),
    ("terrain", "vs_terrain_motion"),
    // Renderer pass 2 A.8: the grass's world-pass and motion-prepass vertices (its plain prepass
    // shares `vs_grass`).
    ("grass", "vs_grass"),
    ("grass", "vs_grass_motion"),
];

/// Every renderer shader by name.
pub const SHADERS: &[(&str, &str)] = &[
    ("forward", FORWARD),
    ("shadow", SHADOW),
    ("cull", CULL),
    ("skin", SKIN),
    ("lines", LINES),
    ("blit", BLIT),
    ("upscale-bilinear", UPSCALE_BILINEAR),
    ("immediate-2d", IMMEDIATE_2D),
    ("particles-compute", PARTICLES_COMPUTE),
    ("particles-draw", PARTICLES_DRAW),
    ("material-sample", MATERIAL_SAMPLE),
    ("post-sample", POST_SAMPLE),
    ("downsample", DOWNSAMPLE),
    ("material-v2-sample", MATERIAL_V2_SAMPLE),
    ("post-v2-sample", POST_V2_SAMPLE),
    ("tonemap", TONEMAP),
    ("resolve-hdr", RESOLVE_HDR),
    ("exposure-histogram", EXPOSURE_HISTOGRAM),
    ("exposure-adapt", EXPOSURE_ADAPT),
    ("background", BACKGROUND),
    ("ibl-equirect", IBL_EQUIRECT),
    ("ibl-prefilter", IBL_PREFILTER),
    ("ibl-sh9", IBL_SH9),
    ("ibl-brdf-lut", IBL_BRDF_LUT),
    ("sky-transmittance", SKY_TRANSMITTANCE),
    ("sky-multiscatter", SKY_MULTISCATTER),
    ("sky-view", SKY_VIEW),
    ("sky-draw", SKY_DRAW),
    ("ibl-backdrop", IBL_BACKDROP),
    ("prepass", PREPASS),
    ("bloom-down", BLOOM_DOWN),
    ("bloom-up", BLOOM_UP),
    ("aerial-perspective", AERIAL_PERSPECTIVE),
    ("gtao", GTAO),
    ("ao-denoise", AO_DENOISE),
    ("contact-shadow", CONTACT_SHADOW),
    ("joint-upsample", JOINT_UPSAMPLE),
    ("meshlet-cull", crate::meshlet_cull::MESHLET_CULL),
    ("meshlet-draw", crate::meshlet_cull::MESHLET_DRAW),
    ("hiz-build", crate::hiz::HIZ_BUILD),
    // RQ5 review: TAA's resolve and reactive coverage and FSR1's passes, so the module and WGSL
    // size checks (and the browser's pipeline check) cover them.
    ("taa", crate::post::taa::TAA),
    ("taa-reactive", crate::post::taa::REACTIVE),
    ("taa-reactive-particles", crate::post::taa::REACTIVE_PARTICLES),
    ("easu", crate::post::fsr::EASU),
    ("rcas", crate::post::fsr::RCAS),
    // Renderer pass 2, P2-0.8b (T-03): the motion prepass's background motion.
    ("motion-background", crate::motion::BACKGROUND_MOTION),
    // Renderer pass 2 A.3: the reflection probes' capture passes (sky fill, copy).
    ("probe-passes", crate::probes::PROBE_PASSES),
    // Renderer pass 2 A.7: the terrain's world pass, prepass and motion prepass, and its casters.
    ("terrain", crate::terrain::gpu::TERRAIN),
    ("terrain-shadow", crate::terrain::gpu::TERRAIN_SHADOW),
    // Renderer pass 2 A.8: the grass's generation, its world pass, prepass and motion prepass,
    // and its casters.
    ("grass-gen", crate::foliage::gpu::GRASS_GEN),
    ("grass", crate::foliage::gpu::GRASS),
    ("grass-shadow", crate::foliage::gpu::GRASS_SHADOW),
    // Renderer pass 2 A.4: the irradiance volumes' bake reduce.
    ("irradiance-passes", crate::irradiance::IRRADIANCE_PASSES),
    // Renderer pass 2 A.6: the previous frame's colour pyramid.
    ("history-pyramid", crate::screen_inputs::HISTORY_PYRAMID),
];

/// A shader module from WGSL checked against [`crate::WGSL_MAX_BYTES`].
pub fn module(device: &Device, label: &str, source: &str) -> Result<ShaderModule, RenderError> {
    check_wgsl(source)?;
    Ok(device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(Cow::Owned(source.to_owned())),
    }))
}
