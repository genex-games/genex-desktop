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
@group(0) @binding(19) var contact_shadow_mask: texture_2d<f32>;

// The volume's slices (fog::AERIAL_SIDE).
const GX_AERIAL_SIDE: f32 = 32.0;

// Which screen effects the quality draws (the renderer's `SurfaceKey`), one constant each: an
// accessor whose effect is off answers its neutral value without projecting the position or
// reading its binding, so a legacy or low frame (fog alone) pays no texture read for AO, contact
// shadows or the aerial volume.
override GX_AO: bool = true;
override GX_CONTACT_SHADOWS: bool = true;
override GX_FOG: bool = true;
override GX_AERIAL: bool = true;

// Whether this pipeline reads an AO term (`GX_AO`); without one every visibility is 1.
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

// The screen position (0..1, v down) `world_pos` projects to.
fn gx_screen_uv(world_pos: vec3<f32>) -> vec2<f32> {
    let clip = frame.view_proj * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-6);
    return clamp(vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2<f32>(0.0), vec2<f32>(1.0));
}

// Ambient occlusion at `world_pos`: xyz the bent normal (zero: none), w the visibility. The term
// is at the render size (a half-resolution term arrives through the joint-bilateral upsample,
// post::upsample), so the texel under the pixel is the pixel's own surface's; it is filtered with
// the environment's clamping sampler all the same, and the neutral texel reads exactly 1 either way.
fn gx_ambient_occlusion(world_pos: vec3<f32>) -> vec4<f32> {
    if !gx_ao_drawn() {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let texel = textureSampleLevel(ao_map, env_sampler, gx_screen_uv(world_pos), 0.0);
    return gx_ao_decode(texel);
}

// The sun's screen-space contact shadow at `world_pos` (1: unshadowed): the mask at the render
// size (through the joint-bilateral upsample), the texel under the pixel.
fn gx_contact_shadow(world_pos: vec3<f32>) -> f32 {
    if !GX_CONTACT_SHADOWS {
        return 1.0;
    }
    return textureLoad(contact_shadow_mask, gx_screen_texel(world_pos, textureDimensions(contact_shadow_mask)), 0).r;
}

// The aerial-perspective volume's texel at `world_pos`: sampled with the environment's filtering
// sampler inside half a texel of the edges (so no address mode wraps), and faded to no air in
// front of the first slice's centre (the air nearer than it is negligible, never a full slice's).
fn gx_aerial_at(world_pos: vec3<f32>) -> vec4<f32> {
    let uvw = gx_aerial_froxel(world_pos);
    let half = 0.5 / GX_AERIAL_SIDE;
    let held = clamp(uvw, vec3<f32>(half), vec3<f32>(1.0 - half));
    let air = textureSampleLevel(aerial_perspective, env_sampler, held, 0.0);
    // Faded towards no air as `in-scatter × f, 1 - (1 - transmittance) × f`: a texel of no air
    // stays exactly (0, 0, 0, 1), so the colour is untouched bit for bit.
    let f = clamp(uvw.z / half, 0.0, 1.0);
    return vec4<f32>(air.rgb * f, 1.0 - (1.0 - air.a) * f);
}

// `color` at `world_pos` seen through the air (the aerial perspective, where the quality draws
// it) and then the frame's fog (where the quality draws it): `gx_apply_fog_aerial`'s order.
fn gx_forward_fog(color: vec3<f32>, world_pos: vec3<f32>) -> vec3<f32> {
    var seen = color;
    if GX_AERIAL {
        seen = gx_apply_aerial(seen, gx_aerial_at(world_pos));
    }
    if GX_FOG {
        seen = gx_apply_fog(seen, world_pos);
    }
    return seen;
}
