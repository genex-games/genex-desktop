// Shadowed spot lights' depth pass (RQ6.5, spot_shadow.rs). Each shadowed spot renders its casters
// into its tile of the spot atlas, the shared shadow depth array's layer after the drawn cascades,
// through a perspective light view-projection that follows the light rows in `light_ext`
// (GX_SPOT_MATRIX_VEC4S per shadow slot, after GX_LIGHT_EXT_VEC4S per light). Instances come
// through the spot's region of the visible list, which the cull pass filled against the spot's
// frustum (its cull view: after the camera and the drawn cascades). A perspective map has a real
// near plane: casters are clipped there, never pancaked; the pipeline adds the casters' constant
// and slope-scaled depth bias.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> slot_base: array<u32>;
@group(0) @binding(4) var<storage, read> light_ext: array<vec4<f32>>;
@group(1) @binding(0) var<uniform> pass_view: PassView;
// The instance fade table (game systems LOD-04, LOD-18; renderer::PASS_FADE_GROWS_BINDING): the
// faded casters' (fade, grow) per visible-list slot, in their own group 1.
@group(1) @binding(2) var<storage, read> lod_grows: array<vec2<f32>>;

struct SpotShadowOut {
    @builtin(position) @invariant clip: vec4<f32>,
}

// Shadow slot `slot`'s light view-projection: its four columns after the frame's light rows
// (`frame.counts.x` lights).
fn gx_spot_matrix(slot: u32) -> mat4x4<f32> {
    let base = GX_LIGHT_EXT_VEC4S * frame.counts.x + GX_SPOT_MATRIX_VEC4S * slot;
    return mat4x4<f32>(light_ext[base], light_ext[base + 1u], light_ext[base + 2u], light_ext[base + 3u]);
}

// A faded caster (game systems LOD-04, LOD-18): the clip position of a fade twin's copy grown
// about its origin by its far-field grow, and its fade for the fragment.
struct SpotShadowFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) @interpolate(flat) fade: f32,
}

@vertex
fn vs_spot_shadow_fade(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> SpotShadowFadeOut {
    let at = visible_row(pass_view.view, 0u, 0u, slot_base[slot + pass_view.slot_offset], instance, frame.counts.w);
    let row = instances[visible[at]];
    let fade_grow = lod_grows[at];
    let spot = pass_view.view - 1u - frame.shadow_counts.x;
    return SpotShadowFadeOut(gx_spot_matrix(spot) * (row.model * vec4<f32>(position * fade_grow.y, 1.0)), fade_grow.x);
}

// The other level's texels cut away by the unturned dither (the sun casters' rule), so each
// texel of a crossfade is cast by one level and a thinned copy casts its share.
@fragment
fn fs_spot_shadow_fade(in: SpotShadowFadeOut) {
    if !gx_lod_fade_keeps(in.fade, gx_lod_fade_threshold(in.clip.xy, 0u)) {
        discard;
    }
}

@vertex
fn vs_spot_shadow(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> SpotShadowOut {
    let row = instances[visible[visible_row(pass_view.view, 0u, 0u, slot_base[slot + pass_view.slot_offset], instance, frame.counts.w)]];
    // The pass view is the spot's cull view: after the camera and the drawn cascades.
    let spot = pass_view.view - 1u - frame.shadow_counts.x;
    var out: SpotShadowOut;
    out.clip = gx_spot_matrix(spot) * (row.model * vec4<f32>(position, 1.0));
    return out;
}
