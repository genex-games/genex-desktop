// IBL bake, step 2 (RQ2.1): the GGX prefilter of the specular cube's mip `bake.dest.y`, faces
// `bake.dest.x .. bake.dest.x + dispatch z`, at the mip's roughness (`bake.prefilter.x`;
// alpha = roughness^2, the IBL remap of Karis's k = alpha / 2 family), by filtered importance
// sampling (Krivanek and Colbert 2008): each of the fixed `bake.dest.w` Hammersley samples reads the
// radiance cube at the mip whose texel covers the sample's solid angle, so few samples make no
// fireflies. With N = V = R (the split-sum's assumption) each output texel is a weighted average of
// filtered source texels, so it is never brighter than the source's brightest texel.
//
// The CPU twins are `ibl::cube_direction`, `ibl::hammersley` and `ibl::ggx_half_vector`.

const IBL_PI: f32 = 3.14159265358979;

@group(0) @binding(0) var<uniform> bake: IblBake;
@group(0) @binding(1) var source_cube: texture_cube<f32>;
@group(0) @binding(2) var source_sampler: sampler;
@group(0) @binding(3) var mip_faces: texture_storage_2d_array<rgba16float, write>;

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

// Point `i` of the `n`-point Hammersley set (`n` a power of two), each coordinate centred in its
// stratum (`ibl::hammersley`).
fn ibl_hammersley(i: u32, n: u32) -> vec2<f32> {
    let half = 0.5 / f32(n);
    return vec2<f32>(f32(i) / f32(n) + half, f32(reverseBits(i)) * 2.3283064365386963e-10 + half);
}

// A GGX-distributed half vector in tangent space (z along the normal) for the point `xi`.
fn ibl_ggx_half_vector(xi: vec2<f32>, alpha: f32) -> vec3<f32> {
    let a2 = alpha * alpha;
    let phi = 2.0 * IBL_PI * xi.x;
    let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sin_theta = sqrt(max(1.0 - cos_theta * cos_theta, 0.0));
    return vec3<f32>(sin_theta * cos(phi), sin_theta * sin(phi), cos_theta);
}

// The GGX normal distribution at `n_dot_h`.
fn ibl_ggx_d(n_dot_h: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let f = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    return a2 / (IBL_PI * f * f);
}

@compute @workgroup_size(8, 8, 1)
fn cs_prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(mip_faces).x;
    if id.x >= side || id.y >= side {
        return;
    }
    let face = bake.dest.x + id.z;
    let n = ibl_cube_direction(face, (vec2<f32>(id.xy) + 0.5) / f32(side));
    let roughness = bake.prefilter.x;
    let alpha = roughness * roughness;
    let samples = max(bake.dest.w, 1u);
    let source_side = f32(textureDimensions(source_cube).x);
    let top = f32(textureNumLevels(source_cube) - 1u);
    let texel_solid_angle = 4.0 * IBL_PI / (6.0 * source_side * source_side);
    var up = vec3<f32>(1.0, 0.0, 0.0);
    if abs(n.z) < 0.999 {
        up = vec3<f32>(0.0, 0.0, 1.0);
    }
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    var color = vec3<f32>(0.0);
    var weight = 0.0;
    for (var i = 0u; i < samples; i++) {
        let h_t = ibl_ggx_half_vector(ibl_hammersley(i, samples), alpha);
        let h = tangent * h_t.x + bitangent * h_t.y + n * h_t.z;
        let l = 2.0 * dot(n, h) * h - n;
        let n_dot_l = dot(n, l);
        if n_dot_l > 0.0 {
            // pdf(l) = D * (N.H) / (4 V.H), and V = N: D / 4.
            let pdf = ibl_ggx_d(h_t.z, alpha) * 0.25;
            let sample_solid_angle = 1.0 / (f32(samples) * pdf + 1e-6);
            let lod = clamp(0.5 * log2(sample_solid_angle / texel_solid_angle) + 1.0, 0.0, top);
            color += textureSampleLevel(source_cube, source_sampler, l, lod).rgb * n_dot_l;
            weight += n_dot_l;
        }
    }
    textureStore(mip_faces, vec2<i32>(id.xy), i32(face), vec4<f32>(color / max(weight, 1e-6), 1.0));
}
