// Shared by every lakeside pass: `passes.rs` prepends this file to each pass's own WGSL (after
// genex's custom-pass API v2 tables prelude, which declares `GxFrameV2`; each pass binds it as
// `gx_frame`). The camera planes, the low sun the sky and water glow around, colour conversions,
// what a pass writes into the scene (sRGB-encoded on the legacy LDR scene, linear radiance times
// the pre-exposure on the HDR one), the look's fog on what a pass draws, hashing and noise, and the
// golden-hour sky itself.

// The environment's SH9 irradiance (the v2 tables' binding 7): the sky the lake mirrors. A pass
// that reads it declares the environment (`RenderInputs::ENVIRONMENT`).
@group(0) @binding(7) var<uniform> gx_env_sh: GxEnvSh;
// The prefiltered environment cube (binding 6) and the tables' sampler (binding 8): the horizon's
// radiance the fog scatters, read as the renderer's own fog reads it.
@group(0) @binding(6) var gx_env_specular: texture_cube<f32>;
@group(0) @binding(8) var gx_point_sampler: sampler;

// The facade's camera planes (genex present.rs NEAR_PLANE / FAR_PLANE): GxFrame carries none.
const GX_NEAR: f32 = 0.1;
const GX_FAR: f32 = 1000.0;
const PI: f32 = 3.14159265;
// Where the low evening sun glows in the sky: the sun the draw hook lights and shadows the models
// with (`frame.sun`, layout.rs SUN_DIR), 7 degrees up, so the grass's translucency, the sprites'
// glow and the water's glint come from the physical sky's sun disk.
const GLOW_DIR: vec3<f32> = vec3<f32>(0.794, 0.122, 0.596);
const WATER_LEVEL: f32 = 0.0;

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let x = max(c, vec3<f32>(0.0));
    let low = x * 12.92;
    let high = 1.055 * pow(x, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, x <= vec3<f32>(0.0031308));
}

// The colour a pass writes for linear radiance `c`: sRGB-encoded on the legacy LDR scene, and on
// the HDR scene linear and pre-exposed (the tonemap maps it to the display).
fn scene_rgb(c: vec3<f32>) -> vec3<f32> {
    if gx_frame.scene_ldr == 1u {
        return linear_to_srgb(c);
    }
    return max(c, vec3<f32>(0.0)) * gx_frame.pre_exposure;
}

// The lakeside was tuned on the sRGB-encoded LDR scene, where blending mixes encoded values. The
// HDR scene blends linear light, which lifts dark pixels under a translucent haze far more and
// dims an additive glow over a lit surface; these keep the art's look there.
const HDR_HAZE_ALPHA: f32 = 0.5;
const HDR_GLOW_GAIN: f32 = 1.8;

// A haze layer's coverage `a` for the scene being drawn.
fn haze_alpha(a: f32) -> f32 {
    return select(a * HDR_HAZE_ALPHA, a, gx_frame.scene_ldr == 1u);
}

// What an additive glow is scaled by on the scene being drawn.
fn glow_gain() -> f32 {
    return select(HDR_GLOW_GAIN, 1.0, gx_frame.scene_ldr == 1u);
}

// A scene colour read back as linear (pre-exposed on the HDR scene).
fn scene_linear(c: vec3<f32>) -> vec3<f32> {
    if gx_frame.scene_ldr == 1u {
        return srgb_to_linear(c);
    }
    return c;
}

// ±half an 8-bit step against banding on the LDR scene; the HDR scene is dithered by the tonemap.
fn ldr_dither(p: vec2<f32>) -> vec3<f32> {
    if gx_frame.scene_ldr == 1u {
        return vec3<f32>((hash12(p) - 0.5) / 255.0);
    }
    return vec3<f32>(0.0);
}

// The depth of the far plane: 1 with standard Z, 0 with the HDR path's reverse-Z.
fn far_depth() -> f32 {
    return select(1.0, 0.0, gx_frame.depth_reversed == 1u);
}

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn hash12(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise2(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash12(i);
    let b = hash12(i + vec2<f32>(1.0, 0.0));
    let c = hash12(i + vec2<f32>(0.0, 1.0));
    let d = hash12(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2<f32>) -> f32 {
    var sum = 0.0;
    var amplitude = 0.5;
    var q = p;
    for (var i = 0; i < 5; i++) {
        sum += amplitude * noise2(q);
        q = q * 2.03 + vec2<f32>(17.1, 9.7);
        amplitude *= 0.5;
    }
    return sum / 0.96875;
}

// The inverse of a 4x4 matrix (the view-projection, to turn a screen corner into a view ray).
fn inverse4(m: mat4x4<f32>) -> mat4x4<f32> {
    let a00 = m[0][0]; let a01 = m[0][1]; let a02 = m[0][2]; let a03 = m[0][3];
    let a10 = m[1][0]; let a11 = m[1][1]; let a12 = m[1][2]; let a13 = m[1][3];
    let a20 = m[2][0]; let a21 = m[2][1]; let a22 = m[2][2]; let a23 = m[2][3];
    let a30 = m[3][0]; let a31 = m[3][1]; let a32 = m[3][2]; let a33 = m[3][3];
    let b00 = a00 * a11 - a01 * a10;
    let b01 = a00 * a12 - a02 * a10;
    let b02 = a00 * a13 - a03 * a10;
    let b03 = a01 * a12 - a02 * a11;
    let b04 = a01 * a13 - a03 * a11;
    let b05 = a02 * a13 - a03 * a12;
    let b06 = a20 * a31 - a21 * a30;
    let b07 = a20 * a32 - a22 * a30;
    let b08 = a20 * a33 - a23 * a30;
    let b09 = a21 * a32 - a22 * a31;
    let b10 = a21 * a33 - a23 * a31;
    let b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    let inv = 1.0 / det;
    return mat4x4<f32>(
        vec4<f32>(a11 * b11 - a12 * b10 + a13 * b09, a02 * b10 - a01 * b11 - a03 * b09, a31 * b05 - a32 * b04 + a33 * b03, a22 * b04 - a21 * b05 - a23 * b03) * inv,
        vec4<f32>(a12 * b08 - a10 * b11 - a13 * b07, a00 * b11 - a02 * b08 + a03 * b07, a32 * b02 - a30 * b05 - a33 * b01, a20 * b05 - a22 * b02 + a23 * b01) * inv,
        vec4<f32>(a10 * b10 - a11 * b08 + a13 * b06, a01 * b08 - a00 * b10 - a03 * b06, a30 * b04 - a31 * b02 + a33 * b00, a21 * b02 - a20 * b04 - a23 * b00) * inv,
        vec4<f32>(a11 * b07 - a10 * b09 - a12 * b06, a00 * b09 - a01 * b07 + a02 * b06, a31 * b01 - a30 * b03 - a32 * b00, a20 * b03 - a21 * b01 + a22 * b00) * inv,
    );
}

// The world point on the far plane behind a clip-space corner.
fn far_point(inv_view_proj: mat4x4<f32>, ndc: vec2<f32>) -> vec3<f32> {
    let p = inv_view_proj * vec4<f32>(ndc, 1.0, 1.0);
    return p.xyz / p.w;
}

// 0 looking away from the glow's azimuth, 1 looking straight at it.
fn toward_glow(dir: vec3<f32>) -> f32 {
    let flat_dir = normalize(vec3<f32>(dir.x, 0.0, dir.z) + vec3<f32>(1e-5, 0.0, 0.0));
    let flat_glow = normalize(vec3<f32>(GLOW_DIR.x, 0.0, GLOW_DIR.z));
    return dot(flat_dir, flat_glow) * 0.5 + 0.5;
}

// The irradiance `sh` (the environment's SH9, the cosine lobe folded in: the renderer's
// `gx_env_irradiance`) holds towards unit `n`: the radiance a white Lambertian surface facing `n`
// reflects, a smooth sky colour for the haze and the lake.
fn sh9_irradiance(sh: GxEnvSh, n: vec3<f32>) -> vec3<f32> {
    let c = sh.coefficients;
    var e = c[0].rgb * 0.282095;
    e += (c[1].rgb * n.y + c[2].rgb * n.z + c[3].rgb * n.x) * 0.488603;
    e += (c[4].rgb * (n.x * n.y) + c[5].rgb * (n.y * n.z) + c[7].rgb * (n.x * n.z)) * 1.092548;
    e += c[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0));
    e += c[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
    return max(e, vec3<f32>(0.0));
}

// Whether the renderer's environment (the physical sky or a map) lights this frame: its light
// then colours the haze and the lake; otherwise (the flat colour, the legacy LDR scene) the painted
// dusk does.
fn environment_lights() -> bool {
    return gx_frame.ambient.w > 0.5;
}

// The haze colour along `dir`: warm towards the low sun, a dusky violet away from it.
fn haze(dir: vec3<f32>) -> vec3<f32> {
    let g = normalize(GLOW_DIR);
    let toward = toward_glow(dir);
    let warm = vec3<f32>(1.0, 0.63, 0.36);
    let dusk = vec3<f32>(0.50, 0.44, 0.56);
    let sun = pow(max(dot(dir, g), 0.0), 6.0);
    return mix(dusk, warm, toward * toward * 0.85) + vec3<f32>(1.0, 0.6, 0.3) * sun * 0.32;
}

// Two ranges of far mountains along the horizon: answers (silhouette height, colour) per range.
fn ridge(dir: vec3<f32>, scale: f32, salt: f32, base: f32, amount: f32) -> f32 {
    let az = atan2(dir.z, dir.x);
    return base + amount * fbm2(vec2<f32>(az * scale + salt, salt * 0.37));
}

// The golden-hour sky along `dir` (linear rgb), drifting clouds keyed to `time` in seconds.
fn sky(dir_in: vec3<f32>, time: f32) -> vec3<f32> {
    let dir = normalize(dir_in);
    let g = normalize(GLOW_DIR);
    let toward = toward_glow(dir);
    let y = clamp(dir.y, 0.0, 1.0);
    let horizon = mix(vec3<f32>(0.66, 0.42, 0.44), vec3<f32>(1.0, 0.56, 0.25), toward * toward);
    let middle = mix(vec3<f32>(0.36, 0.34, 0.52), vec3<f32>(0.80, 0.52, 0.42), toward * toward * toward);
    let zenith = vec3<f32>(0.10, 0.17, 0.38);
    var color = mix(horizon, middle, smoothstep(0.0, 0.16, y));
    color = mix(color, zenith, smoothstep(0.12, 0.75, y));
    let cos_glow = max(dot(dir, g), 0.0);
    color += vec3<f32>(1.0, 0.58, 0.26) * (pow(cos_glow, 7.0) * 0.55 + pow(cos_glow, 90.0) * 1.4);
    color += vec3<f32>(1.0, 0.86, 0.62) * smoothstep(0.99935, 0.99965, cos_glow) * 6.0;
    // Long evening clouds: lit gold on the sun's side, rose and violet elsewhere.
    if dir.y > 0.0 {
        let uv = dir.xz / (dir.y + 0.08) * vec2<f32>(0.55, 1.5) + vec2<f32>(time * 0.006, time * 0.002);
        let n = fbm2(uv * 1.3);
        let band = smoothstep(0.015, 0.09, dir.y) * (1.0 - smoothstep(0.32, 0.62, dir.y));
        let amount = smoothstep(0.5, 0.78, n) * band;
        let lit = mix(vec3<f32>(0.62, 0.38, 0.48), vec3<f32>(1.0, 0.68, 0.40), pow(cos_glow, 2.5) * 0.9 + 0.1);
        let rim = pow(cos_glow, 12.0) * (1.0 - smoothstep(0.55, 0.85, n)) * 1.2;
        color = mix(color, lit + vec3<f32>(1.0, 0.7, 0.4) * rim, amount * 0.8);
    }
    // Far mountains, blue with distance, the nearer range darker.
    let far_ridge = ridge(dir, 1.6, 3.1, 0.018, 0.075);
    let near_ridge = ridge(dir, 3.3, 7.3, 0.004, 0.045);
    let far_color = mix(horizon, vec3<f32>(0.46, 0.40, 0.56), 0.55);
    let near_color = mix(horizon, vec3<f32>(0.25, 0.24, 0.36), 0.68);
    color = mix(color, far_color, smoothstep(far_ridge + 0.002, far_ridge - 0.002, dir.y));
    color = mix(color, near_color, smoothstep(near_ridge + 0.002, near_ridge - 0.002, dir.y));
    return color;
}

// The look's height and distance fog (`[render.look]`, here `showcase.rs`'s `look_fog`), which the
// renderer applies to every built-in surface as it is shaded but not to what a Level-3 pass draws:
// the same closed form over GxFrameV2's fog row (`fog_color`: tint and density; `fog_params`:
// height falloff, base height, start distance, largest opacity), so the grass and the lake fade
// into the haze with the terrain under them. It scatters the environment's radiance just above the
// horizon in the ray's azimuth (the prefiltered cube at the renderer's fog roughness, as
// lighting/fog.wgsl reads it: RX review, the SH9 irradiance this read before is a hemisphere
// average, darker than the horizon, and left olive specks of grass in the far haze) plus the sun's
// forward lobe of the frame's sun colour (already the sun as it reaches the ground, never reddened
// again), both tinted; under the flat colour, the row's colour (the tint times the flat backdrop,
// renderer.rs `frame_fog`). Level-3 passes get no
// aerial-perspective volume, so the air's own scattering on medium and above is the one part of the
// built-in fog this leaves out.
const LOOK_FOG_HORIZON_RISE: f32 = 0.02;
// lighting/fog.wgsl's GX_FOG_ENV_ROUGHNESS, through the cube's perceptual mip mapping.
const LOOK_FOG_ENV_ROUGHNESS: f32 = 0.0;
const LOOK_FOG_SUN_G: f32 = 0.6;
// lighting/fog.wgsl's GX_FOG_SUN_SHARE and GX_FOG_SUN_DESATURATE (genex's D13 golden-hour cut: the
// lobe a third weaker, its colour a third of the way to the sun's luminance).
const LOOK_FOG_SUN_SHARE: f32 = 1.0 / 3.0;
const LOOK_FOG_SUN_DESATURATE: f32 = 1.0 / 3.0;
const LOOK_FOG_LUMINANCE: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
const LOOK_FOG_SUN_SIDE_CUT: f32 = 0.5;
const LOOK_FOG_FLAT: f32 = 1e-2;
const LOOK_FOG_EXPONENT_LIMIT: f32 = 60.0;

fn look_fog_exp(x: f32) -> f32 {
    return exp(clamp(x, -LOOK_FOG_EXPONENT_LIMIT, LOOK_FOG_EXPONENT_LIMIT));
}

// The fog's optical depth from the camera along unit `dir` for `reach` world units.
fn look_fog_depth(origin: vec3<f32>, dir: vec3<f32>, reach: f32) -> f32 {
    let density = gx_frame.fog_color.a;
    let start = gx_frame.fog_params.z;
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let falloff = gx_frame.fog_params.x;
    let span = reach - start;
    let rise = falloff * dir.y;
    let exponent = rise * span;
    let start_exponent = falloff * (origin.y + dir.y * start - gx_frame.fog_params.y);
    if abs(exponent) < LOOK_FOG_FLAT {
        return density * look_fog_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    return density * (look_fog_exp(-start_exponent) - look_fog_exp(-start_exponent - exponent)) / rise;
}

// The light the fog scatters towards the camera along unit `dir`.
fn look_fog_light(dir: vec3<f32>) -> vec3<f32> {
    let tint = gx_frame.fog_color.rgb;
    if !environment_lights() {
        return tint;
    }
    let around = length(dir.xz);
    let azimuth = select(vec2<f32>(0.0, 1.0), dir.xz / around, around > 1e-6);
    let horizon = normalize(vec3<f32>(azimuth.x, LOOK_FOG_HORIZON_RISE, azimuth.y));
    let last_mip = f32(textureNumLevels(gx_env_specular) - 1u);
    let lod = last_mip * LOOK_FOG_ENV_ROUGHNESS * (2.0 - LOOK_FOG_ENV_ROUGHNESS);
    let sky = textureSampleLevel(gx_env_specular, gx_point_sampler, horizon, lod).rgb;
    let sun = normalize(gx_frame.sun_dir.xyz);
    let sun_up = smoothstep(-0.04, 0.0, sun.y);
    let g2 = LOOK_FOG_SUN_G * LOOK_FOG_SUN_G;
    let denominator = max(1.0 + g2 - 2.0 * LOOK_FOG_SUN_G * dot(dir, sun), 1e-4);
    let phase = (1.0 - g2) / (4.0 * PI * denominator * sqrt(denominator));
    let lobe_color = mix(gx_frame.sun_color.rgb, vec3<f32>(dot(gx_frame.sun_color.rgb, LOOK_FOG_LUMINANCE)), LOOK_FOG_SUN_DESATURATE);
    // genex's `gx_fog_sky_light` (D13): the aureole the horizon read sees beyond the ray's own angle
    // to the sun, cut (the lobe's phase at the read less the ray's, over its peak).
    let toward = max(1.0 + g2 - 2.0 * LOOK_FOG_SUN_G * dot(horizon, sun), 1e-4);
    let peak = (1.0 - LOOK_FOG_SUN_G) * (1.0 - LOOK_FOG_SUN_G);
    let nearer = pow(peak / toward, 1.5) - pow(peak / denominator, 1.5);
    let cut = LOOK_FOG_SUN_SIDE_CUT * sun_up * max(nearer, 0.0);
    let sky_light = mix(sky, vec3<f32>(dot(sky, LOOK_FOG_LUMINANCE)), cut) * (1.0 - cut);
    return tint * (sky_light + lobe_color * (sun_up * LOOK_FOG_SUN_SHARE * phase));
}

// `color` (linear radiance) seen through the look's fog between the camera and `world`.
fn look_fog(color: vec3<f32>, world: vec3<f32>) -> vec3<f32> {
    let origin = gx_frame.camera_pos.xyz;
    let to_surface = world - origin;
    let reach = length(to_surface);
    if gx_frame.fog_color.a <= 0.0 || reach <= 0.0 {
        return color;
    }
    let dir = to_surface / reach;
    let depth = look_fog_depth(origin, dir, reach);
    let opacity = min(1.0 - exp(-depth), gx_frame.fog_params.w);
    return mix(color, look_fog_light(dir), opacity);
}
