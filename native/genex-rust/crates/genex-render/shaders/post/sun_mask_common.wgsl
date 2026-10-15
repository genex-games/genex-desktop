// The sun-shadow screen mask's row (renderer pass 2, B.7, SH-04; mirrors `post::sun_mask::GpuSunMaskParams`),
// shared by the visibility pass (sun_mask_visibility.wgsl, built on the forward module) and the
// denoise passes (sun_mask_denoise.wgsl).
struct SunMaskParams {
    // This frame's unjittered clip -> world (the prepass depth's camera).
    inv_view_proj: mat4x4<f32>,
    // World -> this frame's view, and world -> last frame's view (this frame's after a reset).
    view: mat4x4<f32>,
    prev_view: mat4x4<f32>,
    // xy: the render size; zw: 1 / it.
    size: vec4<f32>,
    // x: the least weight the current frame takes once a still pixel's history is long;
    // y: the half width of the neighbourhood clamp in standard deviations; z, w: the depth
    // tolerance (relative) facing the camera and edge-on to it.
    temporal: vec4<f32>,
    // x: the depth similarity's scale (relative view depth per step); y: the normal similarity's
    // power; z: the least standard deviation the shadow similarity divides by; w: reserved.
    spatial: vec4<f32>,
    // x: a moving pixel's least current weight (FidelityFX's 0.05); y: the weight a pixel of
    // motion adds; z: the most motion raises it to; w: the motion (render pixels) below which a
    // pixel keeps the still floor.
    motion: vec4<f32>,
    // x: 1 under reverse-Z; y: 1 when last frame's state is history; z: 1 when the prepass wrote
    // motion this frame; w: reserved.
    flags: vec4<u32>,
}

// Whether the prepass depth `depth` is the clear value (nothing drawn there: the sky).
fn gx_mask_is_sky(depth: f32, reversed: bool) -> bool {
    return select(depth >= 1.0, depth <= 0.0, reversed);
}

// The unit world-space direction along the view ray through pixel centre `pixel` (between two
// depths on it).
fn gx_mask_view_ray(pixel: vec2<f32>) -> vec3<f32> {
    let uv = pixel * gx_mask.size.zw;
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let near = gx_mask.inv_view_proj * vec4<f32>(ndc, 0.5, 1.0);
    let far = gx_mask.inv_view_proj * vec4<f32>(ndc, 0.25, 1.0);
    return normalize(near.xyz / near.w - far.xyz / far.w);
}

// The history's depth tolerance (relative) for a surface with unit normal `n` seen along `view`
// (FidelityFX's: 1% facing the camera, 10% edge-on, by (1 - N.V)^8): the visibility pass writes
// it, so the temporal pass reads no normals.
fn gx_mask_depth_tolerance(n: vec3<f32>, view: vec3<f32>) -> f32 {
    let z_alignment = pow(clamp(1.0 - abs(dot(view, n)), 0.0, 1.0), 8.0);
    return mix(gx_mask.temporal.z, gx_mask.temporal.w, z_alignment);
}

// The fullscreen triangle every mask pass draws.
@vertex
fn vs_sun_mask(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}
