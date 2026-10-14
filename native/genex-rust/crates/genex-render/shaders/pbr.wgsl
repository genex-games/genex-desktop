// Metallic-roughness BRDF: GGX distribution, Smith-Schlick geometry, Schlick Fresnel. The HDR
// scene shades with the height-correlated Smith visibility instead (RQ2.4), the term the BRDF LUT
// integrates; the legacy scene keeps Smith-Schlick. Which scene a fragment draws is the including
// module's `gx_scene_shades_hdr()`: the forward pipeline's `GX_SCENE_HDR` constant, a v2
// material's frame (`scene_ldr`), so `gx_shade_pbr` shades like a built-in surface.

const PI: f32 = 3.14159265;

fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = r * r / 8.0;
    return (n_dot_v / (n_dot_v * (1.0 - k) + k)) * (n_dot_l / (n_dot_l * (1.0 - k) + k));
}

// The height-correlated Smith GGX visibility G / (4 N.L N.V) (Heitz 2014; Filament's
// V_SmithGGXCorrelated; `ibl::smith_ggx_correlated` is the CPU twin) for perceptual `roughness`.
fn visibility_smith_correlated(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let lambda_v = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - a2) + a2);
    let lambda_l = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - a2) + a2);
    return 0.5 / max(lambda_v + lambda_l, 1e-7);
}

fn fresnel_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

fn shade(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, radiance: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32) -> vec3<f32> {
    let n_dot_l = max(dot(n, l), 0.0);
    if n_dot_l <= 0.0 {
        return vec3<f32>(0.0);
    }
    let h = normalize(v + l);
    let n_dot_v = max(dot(n, v), 0.0001);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let f = fresnel_schlick(max(dot(h, v), 0.0), f0);
    var specular = distribution_ggx(max(dot(n, h), 0.0), roughness) * geometry_smith(n_dot_v, n_dot_l, roughness) * f
        / (4.0 * n_dot_v * n_dot_l);
    if gx_scene_shades_hdr() {
        specular = distribution_ggx(max(dot(n, h), 0.0), roughness) * visibility_smith_correlated(n_dot_v, n_dot_l, roughness) * f;
    }
    let diffuse = (vec3<f32>(1.0) - f) * (1.0 - metallic) * albedo / PI;
    return (diffuse + specular) * radiance * n_dot_l;
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let low = c * 12.92;
    let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3<f32>(0.0031308));
}
