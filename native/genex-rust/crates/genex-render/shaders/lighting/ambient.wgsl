// Lighting chunk: ambient. The frame's flat ambient colour, or the environment's image-based light
// (RQ2) when a sky or a map lights the scene. Reads the forward bindings `frame`, `env_specular`,
// `env_sh`, `brdf_lut` and `env_sampler` (the Level-2 v2 material map declares the same names) and
// the `gx_ambient_occlusion` accessor (shaders/effects.wgsl).
//
// The environment's light is the split sum (Karis 2013) over the bake RQ2.1 writes: SH9 irradiance
// for the diffuse lobe, the prefiltered specular cube at the surface's roughness mip times the
// BRDF LUT's scale and bias (GGX, height-correlated Smith) for the specular one, with
// multiple-scattering energy compensation (Fdez-Aguera 2019) so a white furnace reflects all of a
// white environment at every roughness. Specular occlusion: the horizon fade of a normal-mapped
// reflection that dips under the geometric surface (Filament), and, for opaque surfaces, the
// ambient occlusion: through the cone-cone intersection of the visibility cone around GTAO's bent
// normal and the specular lobe (Jimenez et al. 2016, Filament's form) when AO carries a bent normal
// (high and ultra; never below Lagarde's estimate), else through Lagarde's NdotV/roughness fit
// (Frostbite 2014). Ambient occlusion
// darkens indirect light only (this chunk: the flat ambient or the environment), never the sun or
// local lights, with Jimenez's multi-bounce fit so bright albedo is not over-darkened. A blended
// surface takes no screen-space occlusion: the AO map holds the opaque surface behind it.

// Whether the environment may light this pipeline's surfaces (`frame.ambient.w` then says whether
// it does this frame): the forward pass compiles it out of the legacy LDR scene, which the
// environment never lights (RX.R1); every other module keeps the runtime choice.
override GX_ENVIRONMENT_LIGHT: bool = true;

// The ambient light `s` reflects: the first term a fragment's lighting adds up from. The flat
// colour unless `frame.ambient.w` says the environment replaces it; occluded by AO either way.
fn gx_ambient(s: Surface) -> vec3<f32> {
    if GX_ENVIRONMENT_LIGHT && frame.ambient.w > 0.5 {
        return gx_environment_light(s);
    }
    // Without an AO term the visibility is 1 and its multi-bounce factor exactly 1 (RX.R1).
    if !gx_ao_drawn() {
        return frame.ambient.rgb * s.albedo;
    }
    let occlusion = gx_surface_occlusion(s).w;
    return frame.ambient.rgb * s.albedo * gx_ao_multibounce(occlusion, s.albedo);
}

// An AO term's texel decoded (`post::ao`'s encoding): xyz the world-space bent normal (zero when the
// term has none: an `r8unorm` texel reads gba as (0, 0, 1), a neutral one as (1, 1, 1), the sky
// stores none), w the visibility (r).
fn gx_ao_decode(texel: vec4<f32>) -> vec4<f32> {
    let bent = texel.gba * 2.0 - vec3<f32>(1.0);
    let length_squared = dot(bent, bent);
    let present = length_squared > 0.25 && length_squared < 2.0;
    return vec4<f32>(select(vec3<f32>(0.0), bent * inverseSqrt(max(length_squared, 1e-8)), present), texel.r);
}

// The ambient occlusion `s` takes: the accessor's (xyz bent normal, zero when none; w visibility),
// or none for a blended surface (the AO map holds the opaque surface behind it).
fn gx_surface_occlusion(s: Surface) -> vec4<f32> {
    if s.alpha < 1.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    return gx_ambient_occlusion(s.world_pos);
}

// Jimenez et al. 2016's multi-bounce fit: the light `visibility` lets through plus what bounces
// back off nearby surfaces of `albedo`, so bright occluders do not over-darken. Exactly 1 when
// unoccluded, never below `visibility`.
fn gx_ao_multibounce(visibility: f32, albedo: vec3<f32>) -> vec3<f32> {
    let a = 2.0404 * albedo - vec3<f32>(0.3324);
    let b = -4.7951 * albedo + vec3<f32>(0.6417);
    let c = 2.7552 * albedo + vec3<f32>(0.6903);
    let x = vec3<f32>(visibility);
    return clamp(((x * a + b) * x + c) * x, x, vec3<f32>(1.0));
}

// The share of the spherical cap of cosine `cos_cap1` that the cap of cosine `cos_cap2` covers when
// their axes are `cos_distance` apart, times the smaller cap's 1 - cosine (Oat and Sander 2007, the
// smooth approximation of Jimenez et al. 2016).
fn gx_caps_intersection(cos_cap1: f32, cos_cap2: f32, cos_distance: f32) -> f32 {
    let r1 = acos(clamp(cos_cap1, -1.0, 1.0));
    let r2 = acos(clamp(cos_cap2, -1.0, 1.0));
    let d = acos(clamp(cos_distance, -1.0, 1.0));
    if min(r1, r2) <= max(r1, r2) - d {
        return 1.0 - max(cos_cap1, cos_cap2);
    }
    if r1 + r2 <= d {
        return 0.0;
    }
    let delta = abs(r1 - r2);
    let x = 1.0 - clamp((d - delta) / max(r1 + r2 - delta, 1e-4), 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x) * (1.0 - max(cos_cap1, cos_cap2));
}

// The occlusion (1 - visibility) at which the bent normal's cone test takes full effect.
const GX_BENT_TRUST_OCCLUSION: f32 = 0.15;
// The GGX alphas over which the cone test fades in: a lobe narrower than the visibility cone's
// own resolution (two or three slices across the half circle) turns the cone-cone intersection
// into a step, so a smooth metal's band of contact occlusion became a sharp dark rim with full
// light above it, curving where the bent normal turned at an edge (pass-1 fix gate, live-app
// finding 2: the template's brass block, roughness 0.3, at high and ultra). From alpha 0.16 (a
// lobe about 20 degrees wide) to 0.36 (about 40) the test fades in; narrower lobes take
// Lagarde's estimate alone, as medium's do (the test once faded towards no occlusion at all
// below alpha 0.09, so such a surface lost its contact darkening at high and ultra only).
const GX_BENT_TRUST_ALPHA: vec2<f32> = vec2<f32>(0.16, 0.36);
// The N.V band over which the cone test hands over to Lagarde's estimate: a face seen at a grazing
// angle spans a few pixels, so GTAO's horizons there are its neighbours' and its bent normal points
// away from the reflection. The cone test then takes all of a metal's ambient light, which has no
// diffuse to fall back on (RX review: the template's brass block went from (80,60,40) to (5,1,0)).
const GX_BENT_GRAZING_NV: vec2<f32> = vec2<f32>(0.1, 0.4);

// The specular visibility GTAO's bent normal `bent` and `visibility` leave the reflection `r` of a
// surface of perceptual `roughness` with normal `n`: the visibility cone around the bent normal
// against the specular lobe's cone (Jimenez et al. 2016, Filament's `specularAO_Cones`), relative
// to the same lobe against the unoccluded hemisphere around `n` (the caller weighs it against
// Lagarde's estimate by `gx_bent_cone_share`). The ratio matters: at full visibility the
// visibility cone is that hemisphere, and a grazing lobe straddling the horizon would otherwise be
// cut a second time although the split sum's DFG and `gx_horizon_fade` already take the horizon's
// share (RQ4 review: open ground seen at a grazing view darkened by up to 25 levels). So an
// unoccluded surface keeps all its specular light at every roughness and view.
fn gx_specular_occlusion_bent(bent: vec3<f32>, visibility: f32, r: vec3<f32>, n: vec3<f32>, roughness: f32) -> f32 {
    let alpha = roughness * roughness;
    let cos_visibility = sqrt(clamp(1.0 - visibility, 0.0, 1.0));
    // The lobe's aperture: log(10) / log(2) = 3.321928.
    let cos_lobe = exp2(-3.321928 * alpha * alpha);
    let occluded = gx_caps_intersection(cos_visibility, cos_lobe, dot(bent, r));
    let open = gx_caps_intersection(0.0, cos_lobe, dot(n, r));
    let occlusion = select(occluded / max(open, 1e-6), 1.0, open <= 1e-6);
    // Nearly open ground's bent normal is mostly the estimate's noise (a few slices tilt it either
    // way), so the cone test fades out as the visibility nears 1.
    let trusted = smoothstep(0.0, GX_BENT_TRUST_OCCLUSION, 1.0 - visibility);
    return mix(1.0, clamp(occlusion, 0.0, 1.0), trusted);
}

// How far the cone test may replace Lagarde's estimate for a lobe of perceptual `roughness` seen
// at `n_dot_v`: not for a lobe narrower than the visibility cone resolves
// ([`GX_BENT_TRUST_ALPHA`]), nor at a grazing view ([`GX_BENT_GRAZING_NV`]).
fn gx_bent_cone_share(n_dot_v: f32, roughness: f32) -> f32 {
    let alpha = roughness * roughness;
    return smoothstep(GX_BENT_TRUST_ALPHA.x, GX_BENT_TRUST_ALPHA.y, alpha) * smoothstep(GX_BENT_GRAZING_NV.x, GX_BENT_GRAZING_NV.y, n_dot_v);
}

// The radiance a white Lambertian surface facing `n` reflects under the environment: `env_sh`
// evaluated on the real SH basis (band order L00; L1-1, L10, L11; L2-2, L2-1, L20, L21, L22). The
// coefficients carry the cosine lobe's `A_l / pi` already (`ibl::sh9_eval` is the CPU twin), so a
// constant environment of radiance L returns L. Zero under the neutral inputs.
fn gx_env_irradiance(n: vec3<f32>) -> vec3<f32> {
    let c = env_sh.coefficients;
    var e = c[0].rgb * 0.282095;
    e += (c[1].rgb * n.y + c[2].rgb * n.z + c[3].rgb * n.x) * 0.488603;
    e += (c[4].rgb * (n.x * n.y) + c[5].rgb * (n.y * n.z) + c[7].rgb * (n.x * n.z)) * 1.092548;
    e += c[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0));
    e += c[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
    return max(e, vec3<f32>(0.0));
}

// The split-sum scale and bias of F0 for a view at `n_dot_v` on a surface of perceptual
// `roughness`. The LUT holds N.V along x and roughness along y at texel centres, so the bilinear
// sample at (N.V, roughness) interpolates between them; the 1x1 neutral LUT answers its one texel.
fn gx_env_dfg(n_dot_v: f32, roughness: f32) -> vec2<f32> {
    return textureSampleLevel(brdf_lut, env_sampler, vec2<f32>(n_dot_v, roughness), 0.0).rg;
}

// The specular cube's level for perceptual `roughness`: its mips hold roughness perceptually
// (`ibl::mip_roughness`, the inverse of this; Filament's `last · r · (2 − r)`), so the low
// roughnesses a mirror-like surface shows get most of the levels. `ibl::roughness_lod` is the CPU
// twin.
fn gx_env_lod(roughness: f32) -> f32 {
    let last_mip = f32(textureNumLevels(env_specular) - 1u);
    let r = clamp(roughness, 0.0, 1.0);
    return last_mip * r * (2.0 - r);
}

// The prefiltered radiance arriving along `dir` for perceptual `roughness`.
fn gx_env_specular(dir: vec3<f32>, roughness: f32) -> vec3<f32> {
    return textureSampleLevel(env_specular, env_sampler, dir, gx_env_lod(roughness)).rgb;
}

// Where a rough lobe's reflected light mostly comes from: the mirror direction `r` pulled
// towards the normal as the lobe widens (Filament's dominant direction, alpha squared).
fn gx_specular_dominant(n: vec3<f32>, r: vec3<f32>, roughness: f32) -> vec3<f32> {
    let alpha = roughness * roughness;
    return normalize(mix(r, n, alpha * alpha));
}

// How much of the reflection `r` stays above the geometric surface `geometric`: a normal map can
// tilt the mirror direction under it, where the environment would be seen through the surface.
fn gx_horizon_fade(r: vec3<f32>, geometric: vec3<f32>) -> f32 {
    let horizon = min(1.0 + dot(r, geometric), 1.0);
    return horizon * horizon;
}

// The specular visibility the ambient `occlusion` leaves for a view at `n_dot_v` on a surface of
// perceptual `roughness` (Lagarde and de Rousiers 2014): rough lobes take the occlusion as it is,
// smooth ones mostly at grazing views. 1 when unoccluded.
fn gx_specular_occlusion(n_dot_v: f32, occlusion: f32, roughness: f32) -> f32 {
    let alpha = roughness * roughness;
    return clamp(pow(n_dot_v + occlusion, exp2(-16.0 * alpha - 1.0)) - 1.0 + occlusion, 0.0, 1.0);
}

// The environment's light on `s`: SH9 diffuse and split-sum specular with multiple-scattering
// compensation, its specular occluded by the horizon and (opaque surfaces) the ambient occlusion,
// its diffuse by the ambient occlusion. Zero under the neutral inputs (black cube, zero SH).
fn gx_environment_light(s: Surface) -> vec3<f32> {
    let n_dot_v = clamp(dot(s.n, s.v), 0.0001, 1.0);
    let f0 = mix(vec3<f32>(0.04), s.albedo, s.metallic);
    let dfg = gx_env_dfg(n_dot_v, s.roughness);
    // Single scattering with the roughness-dependent Fresnel, then the energy the single-scatter
    // lobe loses, returned with the average Fresnel's tint (Fdez-Aguera 2019).
    let fr = max(vec3<f32>(1.0 - s.roughness), f0) - f0;
    let k_s = f0 + fr * pow(1.0 - n_dot_v, 5.0);
    let fss_ess = k_s * dfg.x + dfg.y;
    let e_ms = 1.0 - (dfg.x + dfg.y);
    let f_avg = f0 + (vec3<f32>(1.0) - f0) / 21.0;
    let fms_ems = e_ms * fss_ess * f_avg / (vec3<f32>(1.0) - e_ms * f_avg);
    let k_d = s.albedo * (1.0 - s.metallic) * (vec3<f32>(1.0) - fss_ess - fms_ems);
    let r = reflect(-s.v, s.n);
    let radiance = gx_env_specular(gx_specular_dominant(s.n, r, s.roughness), s.roughness);
    let irradiance = gx_env_irradiance(s.n);
    let ao = gx_surface_occlusion(s);
    let occlusion = ao.w;
    let ao_lagarde = gx_specular_occlusion(n_dot_v, occlusion, s.roughness);
    var ao_specular = ao_lagarde;
    if dot(ao.xyz, ao.xyz) > 0.0 {
        let cone = gx_specular_occlusion_bent(ao.xyz, occlusion, r, s.n, s.roughness);
        // The cone test counts every occluder as black, so a reflection that points into a lit
        // occluder (a block's lower faces mirroring the floor it stands on) lost all its light:
        // a black band across the faces at high and ultra (owner report 2026-10-11). The bent
        // normal may only keep more light than the AO-only estimate, never less.
        ao_specular = max(ao_lagarde, mix(ao_lagarde, cone, gx_bent_cone_share(n_dot_v, s.roughness)));
    }
    let specular_visibility = gx_horizon_fade(r, s.geometric) * ao_specular;
    let specular = fss_ess * radiance * specular_visibility;
    return specular + (fms_ems + k_d) * irradiance * gx_ao_multibounce(occlusion, s.albedo * (1.0 - s.metallic));
}
