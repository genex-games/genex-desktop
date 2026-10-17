// The opaque scene's view depth for the particles (renderer pass 2 A.11): the prepass depth turned
// into world units along the view, at half the render size, in a texture of the particles' own. Soft billboards fade
// against it and the depth collision tests paths against it. It is a copy because the world
// pass may hold the prepass depth as its own attachment (the `Equal` reuse), which nothing in the
// pass may sample. Perspective or orthographic, standard or reversed Z: the depth is read back
// through the frame's own view-projection.

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var particle_depth_in: texture_depth_2d;
@group(0) @binding(2) var particle_depth_out: texture_storage_2d<r32float, write>;

// The view depth where no surface is (a depth that never ends at a perspective camera's far
// plane): a billboard never fades against it and nothing collides with it.
const PARTICLE_NO_SURFACE: f32 = 3.0e38;

// The view depth (world units along the camera's forward axis) of device depth `z`.
fn particle_view_depth(z: f32) -> f32 {
    let vp = frame.view_proj;
    let row_z = vec4<f32>(vp[0].z, vp[1].z, vp[2].z, vp[3].z);
    let row_w = vec4<f32>(vp[0].w, vp[1].w, vp[2].w, vp[3].w);
    let w_length = dot(row_w.xyz, row_w.xyz);
    if w_length > 1e-12 {
        // Perspective: clip z = a · clip w + b, and clip w is the view depth, so z = a + b / depth.
        let a = dot(row_z.xyz, row_w.xyz) / w_length;
        let b = row_z.w - a * row_w.w;
        let denominator = z - a;
        if abs(denominator) < 1e-12 {
            return PARTICLE_NO_SURFACE;
        }
        return max(b / denominator, 0.0);
    }
    // Orthographic: clip z is affine along the forward axis.
    let along = dot(row_z.xyz, frame.camera_forward.xyz);
    let at_eye = dot(row_z.xyz, frame.camera_pos.xyz) + row_z.w;
    return (z - at_eye) / along;
}

// One texel per 2 x 2 of the prepass depth (renderer pass 2 A.11: a quarter of the texels to
// write and to read under 64k streaks): the nearest of the four, so a billboard fades early rather
// than late beside a nearer edge, and a path stops on a thin edge it crosses.
@compute @workgroup_size(8, 8)
fn cs_particle_depth(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(particle_depth_out);
    if any(id.xy >= size) {
        return;
    }
    let full = textureDimensions(particle_depth_in) - vec2<u32>(1u);
    let base = id.xy * 2u;
    var nearest = PARTICLE_NO_SURFACE;
    for (var k = 0u; k < 4u; k += 1u) {
        let texel = min(base + vec2<u32>(k & 1u, k >> 1u), full);
        nearest = min(nearest, particle_view_depth(textureLoad(particle_depth_in, texel, 0)));
    }
    textureStore(particle_depth_out, id.xy, vec4<f32>(nearest, 0.0, 0.0, 1.0));
}
