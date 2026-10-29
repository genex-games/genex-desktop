// Metallic-roughness BRDF: GGX distribution, Smith-Schlick geometry, Schlick Fresnel. The HDR
// scene shades with the height-correlated Smith visibility instead (RQ2.4), the term the BRDF LUT
// integrates; the legacy scene keeps Smith-Schlick. Which scene a fragment draws is the including
// module's `gx_scene_shades_hdr()`: the forward pipeline's `GX_SCENE_HDR` constant, a v2
// material's frame (`scene_ldr`), so `gx_shade_pbr` shades like a built-in surface.
//
// The HDR scene's direct specular takes multiple-scattering energy compensation (SI-07, S8,
// LG-03; Filament's `energyCompensation = 1 + f0 (1 / E - 1)`, Apache-2.0), with E the
// single-scatter lobe's directional albedo `dfg.x + dfg.y` from the BRDF LUT the ambient chunk
// reads (`gx_env_dfg`), so a rough metal reflects the sun and the lamps with the energy the
// environment's split sum gives it. The LUT tap is taken once per surface (`gx_specular_energy`
// keeps it across the lights of one fragment); under the neutral LUT (no environment bake) E is 1
// and nothing changes.

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

// The last surface whose directional albedo was looked up: its N.V and roughness, and E.
var<private> gx_energy_key: vec2<f32> = vec2<f32>(-1.0, -1.0);
var<private> gx_energy_albedo: f32 = 1.0;

// The multiple-scattering compensation of a specular lobe of perceptual `roughness` seen at
// `n_dot_v` with reflectance `f0`: `1 + f0 (1 / E - 1)`, E looked up once per surface.
fn gx_specular_energy(f0: vec3<f32>, n_dot_v: f32, roughness: f32) -> vec3<f32> {
    let key = vec2<f32>(n_dot_v, roughness);
    if any(key != gx_energy_key) {
        let dfg = gx_env_dfg(n_dot_v, roughness);
        gx_energy_albedo = dfg.x + dfg.y;
        gx_energy_key = key;
    }
    return vec3<f32>(1.0) + f0 * (1.0 / max(gx_energy_albedo, 1e-4) - 1.0);
}

// The direction the sun lights `n` seen from `v` along, the sun a disc of `angular_radius`
// (radians) around the unit direction `l` (renderer pass 2, P2-0.12 LG-04; Filament's
// `sampleSunAreaLight`, Apache-2.0): the direction inside the disc closest to the mirror direction,
// which is the mirror direction itself when it falls inside. A smooth surface then reflects the
// sun's whole disc, a glint a few pixels wide, instead of a delta light's one-pixel spike that
// sparkles under TAA's jitter. `l` itself for a point sun.
fn gx_sun_area_direction(l: vec3<f32>, angular_radius: f32, n: vec3<f32>, v: vec3<f32>) -> vec3<f32> {
    if angular_radius <= 0.0 {
        return l;
    }
    let r = reflect(-v, n);
    let l_dot_r = dot(l, r);
    let d = cos(angular_radius);
    if l_dot_r >= d {
        return r;
    }
    let s = r - l_dot_r * l;
    let s_length = length(s);
    if s_length <= 1.0e-6 {
        return l;
    }
    return normalize(l * d + (s / s_length) * sin(angular_radius));
}

fn shade(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, radiance: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32) -> vec3<f32> {
    let n_dot_l = max(dot(n, l), 0.0);
    if n_dot_l <= 0.0 {
        return vec3<f32>(0.0);
    }
    if gx_lobe_params.w > 0.5 {
        return gx_shade_lobes(n, v, l, radiance, albedo, metallic, roughness);
    }
    let h = normalize(v + l);
    let n_dot_v = max(dot(n, v), 0.0001);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let f = fresnel_schlick(max(dot(h, v), 0.0), f0);
    var specular = distribution_ggx(max(dot(n, h), 0.0), roughness) * geometry_smith(n_dot_v, n_dot_l, roughness) * f
        / (4.0 * n_dot_v * n_dot_l);
    if gx_scene_shades_hdr() {
        specular = distribution_ggx(max(dot(n, h), 0.0), roughness) * visibility_smith_correlated(n_dot_v, n_dot_l, roughness) * f
            * gx_specular_energy(f0, n_dot_v, roughness);
    }
    let diffuse = (vec3<f32>(1.0) - f) * (1.0 - metallic) * albedo / PI;
    return (diffuse + specular) * radiance * n_dot_l;
}

// The extra lobes of the fragment being shaded (AAA materials, review WP-15; `layers::Lobes`,
// `KHR_materials_clearcoat`, `_sheen` and `_anisotropy`): the forward pass sets them from its
// material's row before any light (`gx_lobes_begin`, shaders/lighting/layers.wgsl). They stay zero
// for every other surface and module, so `shade` is the metallic-roughness BRDF exactly as before.
// x the clearcoat, y its perceptual roughness, z the anisotropy (-1..1), w 1 while any lobe shades.
var<private> gx_lobe_params: vec4<f32> = vec4<f32>(0.0);
// rgb the sheen's colour (linear), a its perceptual roughness.
var<private> gx_lobe_sheen: vec4<f32> = vec4<f32>(0.0);
// The anisotropy's direction (world, unit, in the surface's plane).
var<private> gx_lobe_tangent: vec3<f32> = vec3<f32>(1.0, 0.0, 0.0);
// The clearcoat's normal: the geometric one (the coat lies smooth over the base's normal map).
var<private> gx_lobe_coat_normal: vec3<f32> = vec3<f32>(0.0, 1.0, 0.0);

// The least perceptual roughness of a clearcoat or sheen lobe (their peaks stay a few pixels wide).
const GX_LOBE_ROUGHNESS_MIN: f32 = 0.045;
// The sheen lobe's mean directional albedo (Charlie over its roughness range, Filament's DFG.z
// averaged): how much of the base a full sheen hides.
const GX_SHEEN_ALBEDO: f32 = 0.157;

// The anisotropic GGX distribution (Burley 2012; Filament's `D_GGX_Anisotropic`, Apache-2.0).
fn gx_ggx_anisotropic(at: f32, ab: f32, t_dot_h: f32, b_dot_h: f32, n_dot_h: f32) -> f32 {
    let a2 = at * ab;
    let d = vec3<f32>(ab * t_dot_h, at * b_dot_h, a2 * n_dot_h);
    let b2 = a2 / max(dot(d, d), 1e-12);
    return a2 * b2 * b2 / PI;
}

// The anisotropic height-correlated Smith visibility (Heitz 2014; Filament's
// `V_SmithGGXCorrelated_Anisotropic`).
fn gx_visibility_anisotropic(at: f32, ab: f32, tv: vec2<f32>, tl: vec2<f32>, n_dot_v: f32, n_dot_l: f32) -> f32 {
    let lambda_v = n_dot_l * length(vec3<f32>(at * tv.x, ab * tv.y, n_dot_v));
    let lambda_l = n_dot_v * length(vec3<f32>(at * tl.x, ab * tl.y, n_dot_l));
    return clamp(0.5 / max(lambda_v + lambda_l, 1e-7), 0.0, 1.0);
}

// The sheen's Charlie distribution (Estevez and Kulla 2017) for perceptual `roughness`.
fn gx_charlie(roughness: f32, n_dot_h: f32) -> f32 {
    let inv_alpha = 1.0 / (roughness * roughness);
    let sin2 = max(1.0 - n_dot_h * n_dot_h, 0.0078125);
    return (2.0 + inv_alpha) * pow(sin2, inv_alpha * 0.5) / (2.0 * PI);
}

// The sheen's visibility (Neubelt and Pettineo 2013).
fn gx_neubelt(n_dot_v: f32, n_dot_l: f32) -> f32 {
    return clamp(1.0 / (4.0 * (n_dot_l + n_dot_v - n_dot_l * n_dot_v)), 0.0, 1.0);
}

// The specular lobe of `shade` with the anisotropy stretching it along `gx_lobe_tangent`.
fn gx_lobe_specular(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, h: vec3<f32>, roughness: f32, f: vec3<f32>) -> vec3<f32> {
    let n_dot_v = max(dot(n, v), 0.0001);
    let n_dot_l = max(dot(n, l), 0.0);
    let n_dot_h = max(dot(n, h), 0.0);
    let anisotropy = gx_lobe_params.z;
    if anisotropy == 0.0 {
        return distribution_ggx(n_dot_h, roughness) * visibility_smith_correlated(n_dot_v, n_dot_l, roughness) * f;
    }
    let t = normalize(gx_lobe_tangent - n * dot(n, gx_lobe_tangent));
    let b = cross(n, t);
    let a = roughness * roughness;
    let at = max(a * (1.0 + anisotropy), 0.001);
    let ab = max(a * (1.0 - anisotropy), 0.001);
    let d = gx_ggx_anisotropic(at, ab, dot(t, h), dot(b, h), n_dot_h);
    let vis = gx_visibility_anisotropic(at, ab, vec2<f32>(dot(t, v), dot(b, v)), vec2<f32>(dot(t, l), dot(b, l)), n_dot_v, n_dot_l);
    return d * vis * f;
}

// `shade` with the fragment's extra lobes: the specular stretched by its anisotropy, a sheen over
// the base (which the sheen's albedo dims), and a clearcoat over both (which its Fresnel dims).
fn gx_shade_lobes(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, radiance: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32) -> vec3<f32> {
    let n_dot_l = max(dot(n, l), 0.0);
    let n_dot_v = max(dot(n, v), 0.0001);
    let h = normalize(v + l);
    let v_dot_h = max(dot(v, h), 0.0);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let f = fresnel_schlick(v_dot_h, f0);
    var specular = gx_lobe_specular(n, v, l, h, roughness, f);
    if gx_scene_shades_hdr() {
        specular *= gx_specular_energy(f0, n_dot_v, roughness);
    }
    var lit = ((vec3<f32>(1.0) - f) * (1.0 - metallic) * albedo / PI + specular) * n_dot_l;
    let sheen = gx_lobe_sheen;
    let sheen_peak = max(sheen.r, max(sheen.g, sheen.b));
    if sheen_peak > 0.0 {
        let sheen_roughness = max(sheen.a, GX_LOBE_ROUGHNESS_MIN);
        let lobe = gx_charlie(sheen_roughness, max(dot(n, h), 0.0)) * gx_neubelt(n_dot_v, n_dot_l);
        lit = lit * (1.0 - sheen_peak * GX_SHEEN_ALBEDO) + sheen.rgb * lobe * n_dot_l;
    }
    let coat = gx_lobe_params.x;
    if coat > 0.0 {
        let nc = gx_lobe_coat_normal;
        let coat_roughness = max(gx_lobe_params.y, GX_LOBE_ROUGHNESS_MIN);
        let fc = (0.04 + 0.96 * pow(1.0 - v_dot_h, 5.0)) * coat;
        // Kelemen's visibility, as Filament's clearcoat.
        let l_dot_h = max(dot(l, h), 0.0);
        let coat_lobe = distribution_ggx(max(dot(nc, h), 0.0), coat_roughness) * 0.25 / max(l_dot_h * l_dot_h, 1e-4);
        lit = lit * (1.0 - fc) + vec3<f32>(coat_lobe * fc * max(dot(nc, l), 0.0));
    }
    return lit * radiance;
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let low = c * 12.92;
    let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3<f32>(0.0031308));
}
