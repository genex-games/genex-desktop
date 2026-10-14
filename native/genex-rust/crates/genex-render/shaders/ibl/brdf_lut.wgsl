// The split-sum BRDF LUT (RQ2.1): a fragment pass (core has no `rg16float` storage) writing, for
// N.V along x and perceptual roughness along y (texel centres, row 0 smoothest), the scale and bias
// of F0 in the specular integral of a white environment: specular = F0 * lut.x + lut.y. The
// microfacet model is the one RQ2.4's shading uses: GGX with alpha = roughness^2 and the
// height-correlated Smith visibility (Heitz 2014; Filament's V_SmithGGXCorrelated), integrated by
// sampling the visible normals (Heitz 2018) over a fixed Hammersley set of `BRDF_LUT_SAMPLES`
// points. Written once, 128 x 128 `rg16float`. `ibl::brdf_lut_reference` is the CPU twin (f64, the
// same sample set).

const IBL_PI: f32 = 3.14159265358979;
const BRDF_LUT_SAMPLES: u32 = 2048u;

struct LutOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_brdf_lut(@builtin(vertex_index) index: u32) -> LutOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: LutOut;
    out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    out.uv = uv;
    return out;
}

// Point `i` of the `n`-point Hammersley set (`n` a power of two), each coordinate centred in its
// stratum (`ibl::hammersley`).
fn ibl_hammersley(i: u32, n: u32) -> vec2<f32> {
    let half = 0.5 / f32(n);
    return vec2<f32>(f32(i) / f32(n) + half, f32(reverseBits(i)) * 2.3283064365386963e-10 + half);
}

// A GGX half vector distributed as the normals visible from `v` (Heitz 2018; isotropic `alpha`,
// z along the normal) for the point `xi` (`ibl::ggx_visible_normal`).
fn ibl_ggx_visible_normal(xi: vec2<f32>, v: vec3<f32>, alpha: f32) -> vec3<f32> {
    let vh = normalize(vec3<f32>(alpha * v.x, alpha * v.y, v.z));
    let lensq = vh.x * vh.x + vh.y * vh.y;
    var t1 = vec3<f32>(1.0, 0.0, 0.0);
    if lensq > 0.0 {
        t1 = vec3<f32>(-vh.y, vh.x, 0.0) / sqrt(lensq);
    }
    let t2 = cross(vh, t1);
    let r = sqrt(xi.x);
    let phi = 2.0 * IBL_PI * xi.y;
    let p1 = r * cos(phi);
    let s = 0.5 * (1.0 + vh.z);
    let p2 = (1.0 - s) * sqrt(max(1.0 - p1 * p1, 0.0)) + s * r * sin(phi);
    let p3 = sqrt(max(1.0 - p1 * p1 - p2 * p2, 0.0));
    let nh = p1 * t1 + p2 * t2 + p3 * vh;
    return normalize(vec3<f32>(alpha * nh.x, alpha * nh.y, max(nh.z, 0.0)));
}

// The height-correlated Smith GGX visibility G / (4 N.L N.V).
fn ibl_visibility(n_dot_v: f32, n_dot_l: f32, alpha: f32) -> f32 {
    let a2 = alpha * alpha;
    let lambda_v = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - a2) + a2);
    let lambda_l = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - a2) + a2);
    return 0.5 / (lambda_v + lambda_l);
}

@fragment
fn fs_brdf_lut(in: LutOut) -> @location(0) vec2<f32> {
    let n_dot_v = in.uv.x;
    let roughness = in.uv.y;
    let alpha = roughness * roughness;
    let a2 = alpha * alpha;
    let v = vec3<f32>(sqrt(max(1.0 - n_dot_v * n_dot_v, 0.0)), 0.0, n_dot_v);
    // Visible-normal sampling: each sample weighs F * G2 / G1(v), and
    // G2 / G1(v) = Vis * 4 N.L N.V / G1(v) with G1(v) = 2 N.V / (N.V + sqrt(a2 + (1 - a2) N.V^2)).
    let over_g1 = 2.0 * (n_dot_v + sqrt(a2 + (1.0 - a2) * n_dot_v * n_dot_v));
    var scale = 0.0;
    var bias = 0.0;
    for (var i = 0u; i < BRDF_LUT_SAMPLES; i++) {
        let h = ibl_ggx_visible_normal(ibl_hammersley(i, BRDF_LUT_SAMPLES), v, alpha);
        let v_dot_h = dot(v, h);
        let n_dot_l = 2.0 * v_dot_h * h.z - v.z;
        if n_dot_l > 0.0 && v_dot_h > 0.0 {
            let weight = ibl_visibility(n_dot_v, n_dot_l, alpha) * n_dot_l * over_g1;
            let f = 1.0 - v_dot_h;
            let fresnel = f * f * f * f * f;
            scale += (1.0 - fresnel) * weight;
            bias += fresnel * weight;
        }
    }
    return vec2<f32>(scale, bias) / f32(BRDF_LUT_SAMPLES);
}
