// The forward pass's RQ4 screen-effect inputs: the accessors the lighting chunks call
// (shaders/effects.wgsl), so one chunk compiles in the forward pass and in the Level-2 v2 prelude.
// The renderer binds them in the forward frame group (`layout::FRAME_EFFECT_BINDINGS`, RQ4.6): the
// frame's fog row (density 0 when the look or the quality has no fog), the ambient-occlusion term
// and the sun's contact-shadow mask (each a 1x1 white texture on frames whose node does not run)
// and the aerial-perspective volume (a texel of no air where node 11 did not write it), so a frame
// without an effect draws as before RQ4.

@group(0) @binding(15) var<uniform> frame_fog: GxFog;
@group(0) @binding(16) var ao_map: texture_2d<f32>;
@group(0) @binding(17) var aerial_perspective: texture_3d<f32>;
// PCSS's blocker search gathers the shadow map through it (`layout::SHADOW_BLOCKER_SAMPLER`).
@group(0) @binding(18) var point_sampler: sampler;
@group(0) @binding(19) var contact_shadow_mask: texture_2d<f32>;

// Which screen effects the quality draws (the renderer's `SurfaceKey`), one constant each: an
// accessor whose effect is off answers its neutral value without projecting the position or
// reading its binding, so a legacy or low frame (fog alone) pays no texture read for AO, contact
// shadows or the aerial volume.
override GX_AO: bool = true;
override GX_CONTACT_SHADOWS: bool = true;
override GX_FOG: bool = true;
override GX_AERIAL: bool = true;

// Whether this pipeline reads an AO term (`GX_AO`); without one every visibility is 1.
// The sun chunk's comparison bias for `cascade` (its light depth, NDC): the frame's per-cascade
// row (`GpuFrame::cascade_bias`).
fn gx_sun_cascade_bias(cascade: u32) -> f32 {
    return frame.cascade_bias[cascade];
}

// The surface chunk's texture mip bias: the pipeline's constant plus the frame's lane
// (`GpuFrame::texture_lod`, renderer pass 2 P2-0.8b T-06), so it follows the frame's scale.
fn gx_texture_lod_bias() -> f32 {
    return GX_TEXTURE_LOD_BIAS + frame.texture_lod.x;
}

fn gx_ao_drawn() -> bool {
    return GX_AO;
}

// The frame's fog.
fn gx_fog() -> GxFog {
    return frame_fog;
}

// The texel of a screen-space map of `size` that `world_pos` projects to.
fn gx_screen_texel(world_pos: vec3<f32>, size: vec2<u32>) -> vec2<i32> {
    let clip = frame.view_proj * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-6);
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let texels = vec2<i32>(size);
    return clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), texels - vec2<i32>(1));
}

// Ambient occlusion at `world_pos`: xyz the bent normal (zero: none), w the visibility. The term
// is at the render size (a half-resolution term arrives through the joint-bilateral upsample,
// post::upsample), so the fragment reads its own pixel's texel (`gx_sun_context.pixel`, set before
// shading), as the v2 path does: AO is made from the jittered prepass, and projecting the position
// through the unjittered `view_proj` landed up to half a pixel off, so a filtered read blended in a
// different neighbour every frame of the jitter cycle (pass 2, S5). The neutral 1x1 texel reads 1.
fn gx_ambient_occlusion(world_pos: vec3<f32>) -> vec4<f32> {
    if !gx_ao_drawn() {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let last = vec2<i32>(textureDimensions(ao_map)) - vec2<i32>(1);
    let pixel = clamp(vec2<i32>(gx_sun_context.pixel), vec2<i32>(0), last);
    return gx_ao_decode(textureLoad(ao_map, pixel, 0));
}

// The sun's screen-space contact shadow at `world_pos` (1: unshadowed): the mask at the render
// size (through the joint-bilateral upsample), the texel under the pixel.
fn gx_contact_shadow(world_pos: vec3<f32>) -> f32 {
    if !GX_CONTACT_SHADOWS {
        return 1.0;
    }
    return textureLoad(contact_shadow_mask, gx_screen_texel(world_pos, textureDimensions(contact_shadow_mask)), 0).r;
}

// The sun's visibility from the screen mask (renderer pass 2, B.7, SH-04; post::sun_mask) at the
// pixel (`gx_sun_context.pixel`), or -1 where the frame binds none: the mask shares the
// contact-shadow slot (r contact, g the sun's visibility) and marks itself with alpha 0, while the
// neutral white texel and the contact shadows' own `r8unorm` mask read alpha 1. Only a pipeline
// whose taps turn under TAA asks (`GX_SHADOW_TEMPORAL`): the transparent pipeline and every frame
// without TAA shade the sun inline. The fragment reads its own pixel's texel, as AO's: read
// bilinearly where the position projects (with the jitter), the colour box TAA builds from the
// moving neighbourhood swung on thin shadows, and the still fence flickered four times as much.
fn gx_sun_screen_shadow(world_pos: vec3<f32>) -> f32 {
    if !GX_SHADOW_TEMPORAL {
        return -1.0;
    }
    let last = vec2<i32>(textureDimensions(contact_shadow_mask)) - vec2<i32>(1);
    let texel = textureLoad(contact_shadow_mask, clamp(vec2<i32>(gx_sun_context.pixel), vec2<i32>(0), last), 0);
    return select(-1.0, texel.g, texel.a < 0.5);
}

// The air at `world_pos` (renderer pass 2 SI-04 and A.5): the air volume bound in the aerial slot
// (node 11's aerial perspective, or on froxel presets the froxel fog with the aerial folded in; no
// air where neither ran), read with the environment's filtering sampler (`gx_air_sample`).
fn gx_air_at(world_pos: vec3<f32>) -> GxAir {
    return gx_air_sample(aerial_perspective, env_sampler, gx_aerial_froxel(world_pos));
}

// `color` at `world_pos` seen through the air (the aerial perspective or the froxel fog, where the
// quality draws it) and then the frame's height fog (where the quality draws it and the air does not
// hold it already): `gx_apply_fog_air`'s order.
fn gx_forward_fog(color: vec3<f32>, world_pos: vec3<f32>) -> vec3<f32> {
    var seen = color;
    var air = gx_air_none();
    if GX_AERIAL {
        air = gx_air_at(world_pos);
        seen = gx_apply_air(seen, air);
    }
    if GX_FOG && !gx_air_holds_fog(air) {
        seen = gx_apply_fog(seen, world_pos);
    }
    return seen;
}
