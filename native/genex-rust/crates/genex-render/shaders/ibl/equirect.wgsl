// IBL bake, step 1 (RQ2.1): an equirectangular HDR map (an HDRI, or the sky's radiance without the
// sun disk) into a cube's faces, and the box mip chain the later steps read.
//
// `cs_equirect` writes one mip of a cube, faces `bake.dest.x .. bake.dest.x + dispatch z`, from
// the map turned about up by `bake.source.xy` (cos, sin), times `bake.source.z`, each channel
// clamped to `bake.source.w` when it is above 0 (an HDRI whose sun is analytic). The map's mip is
// picked from the ratio of a cube texel's solid angle to a map texel's, so a large map does not
// alias into a small cube. The faces are the layers of a write-only `rgba16float` storage array
// (plan §2.3's format rules), sampled as a cube afterwards.
//
// `cs_downsample` is the box filter that builds a mip chain one level at a time: each texel of the
// written level averages the 2 x 2 texels above it in `source_mip` (another level of the same
// texture), layer by layer, so a face never reads another face (the time-sliced schedule bakes one
// face per frame). The equirect map's own mips are built the same way, as a one-layer array.
//
// The cube's face directions and the map's mapping are `ibl::cube_direction` and
// `ibl::equirect_uv` on the CPU (WebGPU's cube convention: +X, -X, +Y, -Y, +Z, -Z; the map's
// top row is up, +Y; u = 0.5 + atan2(z, x) / 2pi).

const IBL_PI: f32 = 3.14159265358979;

@group(0) @binding(0) var<uniform> bake: IblBake;
@group(0) @binding(1) var equirect: texture_2d<f32>;
@group(0) @binding(2) var equirect_sampler: sampler;
@group(0) @binding(3) var cube_faces: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var source_mip: texture_2d_array<f32>;

// The world direction through texel coordinate `uv` (0..1, v down) of cube face `face`.
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

// The equirect coordinate of unit direction `d` (u wraps; v = 0 is straight up).
fn ibl_equirect_uv(d: vec3<f32>) -> vec2<f32> {
    let u = 0.5 + atan2(d.z, d.x) / (2.0 * IBL_PI);
    let v = acos(clamp(d.y, -1.0, 1.0)) / IBL_PI;
    return vec2<f32>(u, v);
}

@compute @workgroup_size(8, 8, 1)
fn cs_equirect(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(cube_faces).x;
    if id.x >= side || id.y >= side {
        return;
    }
    let face = bake.dest.x + id.z;
    let world = ibl_cube_direction(face, (vec2<f32>(id.xy) + 0.5) / f32(side));
    // The map turned by angle a about up (`ibl::map_direction`): what lies in map direction m is
    // seen in world direction R(a) m, so world direction w shows the map's R(-a) w.
    let c = bake.source.x;
    let s = bake.source.y;
    let d = vec3<f32>(c * world.x - s * world.z, world.y, s * world.x + c * world.z);
    let size = vec2<f32>(textureDimensions(equirect));
    let cube_texel = 4.0 * IBL_PI / (6.0 * f32(side) * f32(side));
    let map_texel = (2.0 * IBL_PI / size.x) * (IBL_PI / size.y);
    let top = f32(textureNumLevels(equirect) - 1u);
    let lod = clamp(0.5 * log2(cube_texel / map_texel), 0.0, top);
    var color = textureSampleLevel(equirect, equirect_sampler, ibl_equirect_uv(d), lod).rgb * bake.source.z;
    if bake.source.w > 0.0 {
        color = min(color, vec3<f32>(bake.source.w));
    }
    textureStore(cube_faces, vec2<i32>(id.xy), i32(face), vec4<f32>(color, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_downsample(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(cube_faces);
    if id.x >= size.x || id.y >= size.y {
        return;
    }
    let layer = i32(bake.dest.x + id.z);
    let last = vec2<i32>(textureDimensions(source_mip)) - 1;
    let base = vec2<i32>(id.xy) * 2;
    var sum = vec4<f32>(0.0);
    for (var k = 0; k < 4; k++) {
        let texel = min(base + vec2<i32>(k & 1, k >> 1u), last);
        sum += textureLoad(source_mip, texel, layer, 0);
    }
    textureStore(cube_faces, vec2<i32>(id.xy), layer, sum * 0.25);
}
