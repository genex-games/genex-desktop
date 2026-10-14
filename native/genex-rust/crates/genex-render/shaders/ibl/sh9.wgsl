// IBL bake, step 3 (RQ2.1): the environment's diffuse irradiance as 9 spherical-harmonic
// coefficients (`GxEnvSh`), projected from a small mip of the radiance cube (`source_faces`, its
// six faces as array layers, read texel by texel) by one workgroup of `SH9_THREADS` threads (at
// most 64, plan §2.3). Each texel is weighted by its exact solid angle, so a constant environment
// projects exactly. Lanes accumulate a fixed stride of texels, then reduce in workgroup memory
// (64 x 9 vec4 = 9 KB, under core's 16 KB) along a fixed tree: two bakes are byte-identical.
//
// The convention `ibl::sh9_eval` holds on the CPU: each coefficient is the radiance's projection on
// the real SH basis (`ibl::sh9_basis`) times the cosine lobe's `A_l / pi` (`ibl::SH9_LOBE`), so
// evaluating the basis at a normal gives the radiance a white Lambertian surface there reflects.

const SH9_THREADS: u32 = 64u;

@group(0) @binding(0) var<uniform> bake: IblBake;
@group(0) @binding(1) var source_faces: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> sh_out: array<vec4<f32>, 9>;

var<workgroup> partial: array<array<vec4<f32>, 9>, SH9_THREADS>;

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

// The solid angle of the face region from the face centre to face coordinate (x, y) in -1..1.
fn ibl_area_element(x: f32, y: f32) -> f32 {
    return atan2(x * y, sqrt(x * x + y * y + 1.0));
}

// The real SH basis at unit direction `d`, coefficient `i` (`ibl::sh9_basis`).
fn ibl_sh9_basis(d: vec3<f32>, i: u32) -> f32 {
    switch i {
        case 0u: { return 0.282095; }
        case 1u: { return 0.488603 * d.y; }
        case 2u: { return 0.488603 * d.z; }
        case 3u: { return 0.488603 * d.x; }
        case 4u: { return 1.092548 * d.x * d.y; }
        case 5u: { return 1.092548 * d.y * d.z; }
        case 6u: { return 0.315392 * (3.0 * d.z * d.z - 1.0); }
        case 7u: { return 1.092548 * d.x * d.z; }
        default: { return 0.546274 * (d.x * d.x - d.y * d.y); }
    }
}

// The cosine lobe's A_l / pi of coefficient `i`'s band (`ibl::SH9_LOBE`).
fn ibl_sh9_lobe(i: u32) -> f32 {
    if i == 0u {
        return 1.0;
    }
    if i < 4u {
        return 2.0 / 3.0;
    }
    return 0.25;
}

@compute @workgroup_size(SH9_THREADS, 1, 1)
fn cs_sh9(@builtin(local_invocation_index) lane: u32) {
    let side = textureDimensions(source_faces).x;
    let per_face = side * side;
    let inverse = 1.0 / f32(side);
    var sum: array<vec4<f32>, 9>;
    for (var i = 0u; i < 9u; i++) {
        sum[i] = vec4<f32>(0.0);
    }
    for (var texel = lane; texel < 6u * per_face; texel += SH9_THREADS) {
        let face = texel / per_face;
        let x = (texel % per_face) % side;
        let y = (texel % per_face) / side;
        let d = ibl_cube_direction(face, (vec2<f32>(f32(x), f32(y)) + 0.5) * inverse);
        let x0 = 2.0 * f32(x) * inverse - 1.0;
        let y0 = 2.0 * f32(y) * inverse - 1.0;
        let x1 = x0 + 2.0 * inverse;
        let y1 = y0 + 2.0 * inverse;
        let solid_angle = abs(ibl_area_element(x0, y0) - ibl_area_element(x0, y1) - ibl_area_element(x1, y0) + ibl_area_element(x1, y1));
        let radiance = textureLoad(source_faces, vec2<u32>(x, y), face, 0).rgb * solid_angle;
        for (var i = 0u; i < 9u; i++) {
            sum[i] += vec4<f32>(radiance * ibl_sh9_basis(d, i), 0.0);
        }
    }
    for (var i = 0u; i < 9u; i++) {
        partial[lane][i] = sum[i];
    }
    workgroupBarrier();
    for (var stride = SH9_THREADS / 2u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            for (var i = 0u; i < 9u; i++) {
                partial[lane][i] += partial[lane + stride][i];
            }
        }
        workgroupBarrier();
    }
    if lane == 0u {
        for (var i = 0u; i < 9u; i++) {
            sh_out[i] = vec4<f32>(partial[0][i].rgb * ibl_sh9_lobe(i), 0.0);
        }
    }
}
