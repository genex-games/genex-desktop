// The sun-shadow screen mask's first pass (renderer pass 2, B.7, SH-04): the sun's visibility at
// every prepass pixel through the sun chunk (shaders/lighting/sun.wgsl), appended to the forward
// module so the mask shades exactly what the forward pass would: the same cascades, bias, normal
// offset, blend band, end fade and PCSS. Its group 0 is the forward frame group's own bindings
// (`frame`, `shadow_map`, `shadow_sampler`, `point_sampler`); group 1 is the mask's, past the
// forward's `pass_view` at binding 0. The filter's taps turn with the frame key
// (`GX_SHADOW_TEMPORAL` on): the mask's own temporal pass averages them, never the colour TAA.
//
// Output (`rgba16float`): x the visibility, y the pixel's view depth (0: sky), z the view depth
// last frame's camera saw this point at and w the relative tolerance of the history's depth check.

@group(1) @binding(1) var gx_mask_depth: texture_depth_2d;
@group(1) @binding(2) var gx_mask_normals: texture_2d<f32>;
@group(1) @binding(3) var<uniform> gx_mask: SunMaskParams;

// The world position the prepass drew at pixel `pixel` (its centre, `@builtin(position).xy`) with
// device depth `depth`: the jitter the prepass added (`gx_clip_position`) taken off first.
fn gx_mask_world(pixel: vec2<f32>, depth: f32) -> vec3<f32> {
    let uv = pixel * gx_mask.size.zw;
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) - frame.jitter.xy;
    let h = gx_mask.inv_view_proj * vec4<f32>(ndc, depth, 1.0);
    return h.xyz / h.w;
}

@fragment
fn fs_sun_mask_visibility(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(position.xy);
    let depth = textureLoad(gx_mask_depth, texel, 0);
    if gx_mask_is_sky(depth, gx_mask.flags.x != 0u) {
        return vec4<f32>(1.0, 0.0, 0.0, 0.0);
    }
    let world = gx_mask_world(position.xy, depth);
    let n = gx_oct_decode(textureLoad(gx_mask_normals, texel, 0).xy);
    gx_sun_shadow_context(position.xy, frame.shadow_counts.z, frame.shadow_soft.y);
    gx_sun_shadow_end_fade(frame.shadow_soft.z);
    let visibility = sun_shadow(world, n);
    let view_depth = -(gx_mask.view * vec4<f32>(world, 1.0)).z;
    let held_depth = -(gx_mask.prev_view * vec4<f32>(world, 1.0)).z;
    let tolerance = gx_mask_depth_tolerance(n, gx_mask_view_ray(position.xy));
    return vec4<f32>(visibility, max(view_depth, 1e-4), held_depth, tolerance);
}
