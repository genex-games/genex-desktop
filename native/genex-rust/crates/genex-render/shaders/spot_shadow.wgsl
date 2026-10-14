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

struct SpotShadowOut {
    @builtin(position) @invariant clip: vec4<f32>,
}

// Shadow slot `slot`'s light view-projection: its four columns after the frame's light rows
// (`frame.counts.x` lights).
fn gx_spot_matrix(slot: u32) -> mat4x4<f32> {
    let base = GX_LIGHT_EXT_VEC4S * frame.counts.x + GX_SPOT_MATRIX_VEC4S * slot;
    return mat4x4<f32>(light_ext[base], light_ext[base + 1u], light_ext[base + 2u], light_ext[base + 3u]);
}

@vertex
fn vs_spot_shadow(@location(0) position: vec3<f32>, @location(4) slot: u32, @builtin(instance_index) instance: u32) -> SpotShadowOut {
    let row = instances[visible[visible_row(pass_view.view, 0u, 0u, slot_base[slot], instance, frame.counts.w)]];
    // The pass view is the spot's cull view: after the camera and the drawn cascades.
    let spot = pass_view.view - 1u - frame.shadow_counts.x;
    var out: SpotShadowOut;
    out.clip = gx_spot_matrix(spot) * (row.model * vec4<f32>(position, 1.0));
    return out;
}
