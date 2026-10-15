// Reflection probes (renderer pass 2 A.3, `probes::ProbeMaps`): the two passes a capture adds to
// the IBL bake's own (the box mip chain and the GGX prefilter of equirect.wgsl and prefilter.wgsl
// filter a captured cube as they filter the sky's).
//
// `cs_probe_sky_fill`: after a face of the probe's cube is drawn, every texel no geometry covered
// (its depth still the clear value, `bake.source.x`) takes the sky's radiance along the texel's
// direction (the sky's prefiltered cube at its mirror level), so a window shows the sky behind it.
// The face is layer `bake.dest.x` of the capture's source cube (write-only storage: the covered
// texels are left as drawn).
//
// `cs_probe_copy`: one mip of a six-layer cube (`copy_source`) into layers `bake.dest.x ..` of the
// same mip of the probe array, each written texel the mean of the `bake.dest.y` squared source
// texels it covers (1: an exact copy; 2 when the sky's cube is twice the probes' side). The sky's
// cube goes into layer 0 this way whenever its bake changes.

const IBL_PI: f32 = 3.14159265358979;

@group(0) @binding(0) var<uniform> bake: IblBake;
@group(0) @binding(1) var face_depth: texture_depth_2d;
@group(0) @binding(2) var sky_cube: texture_cube<f32>;
@group(0) @binding(3) var sky_sampler: sampler;
@group(0) @binding(4) var faces_out: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var copy_source: texture_2d_array<f32>;

// The world direction through texel coordinate `uv` (0..1, v down) of cube face `face`
// (`ibl::cube_direction`).
fn ibl_cube_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    switch face {
        case 0u: { return normalize(vec3<f32>(1.0, -t, -s)); }
        case 1u: { return normalize(vec3<f32>(-1.0, -t, s)); }
        case 2u: { return normalize(vec3<f32>(s, 1.0, t)); }
        case 3u: { return normalize(vec3<f32>(s, -1.0, -t)); }
        case 4u: { return normalize(vec3<f32>(s, -t, 1.0)); }
        default: { return normalize(vec3<f32>(-s, -t, -1.0)); }
    }
}

@compute @workgroup_size(8, 8, 1)
fn cs_probe_sky_fill(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(face_depth);
    if id.x >= size.x || id.y >= size.y {
        return;
    }
    let depth = textureLoad(face_depth, vec2<i32>(id.xy), 0);
    if depth != bake.source.x {
        return;
    }
    let face = bake.dest.x;
    let dir = ibl_cube_direction(face, (vec2<f32>(id.xy) + 0.5) / vec2<f32>(size));
    let sky = textureSampleLevel(sky_cube, sky_sampler, dir, 0.0).rgb;
    textureStore(faces_out, vec2<i32>(id.xy), i32(face), vec4<f32>(sky, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_probe_copy(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(faces_out);
    if id.x >= size.x || id.y >= size.y {
        return;
    }
    let ratio = max(bake.dest.y, 1u);
    let last = vec2<i32>(textureDimensions(copy_source)) - 1;
    let base = vec2<i32>(id.xy * ratio);
    var sum = vec4<f32>(0.0);
    for (var j = 0u; j < ratio; j++) {
        for (var i = 0u; i < ratio; i++) {
            sum += textureLoad(copy_source, min(base + vec2<i32>(i32(i), i32(j)), last), i32(id.z), 0);
        }
    }
    textureStore(faces_out, vec2<i32>(id.xy), i32(bake.dest.x + id.z), sum / f32(ratio * ratio));
}
