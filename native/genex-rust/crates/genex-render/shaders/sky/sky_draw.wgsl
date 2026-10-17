// The sky background (graph node 13, RQ2.2): drawn inside the world pass at the far plane over
// whatever no opaque draw covered (the depth test passes only the cleared far plane), from the
// sky-view LUT with the sun disk and its limb darkening added here only (the environment bake
// excludes it: the analytic sun lights the scene directly, with shadows). The view direction comes
// from the frame's inverse view-projection; the sun is the frame's current one, so the disk and
// the LUT's azimuth follow it even between LUT refreshes. Radiance times the frame's pre-exposure.
//
// The lookups repeat sky_view.wgsl's (WGSL has no includes); tests/sky.rs holds them to one
// behaviour.
//
// Fog (RQ4.3): the frame's fog (GxFrameV2's fog_color and fog_params; density 0, the default,
// draws none and leaves the colour untouched) takes the sky at a very large finite distance,
// through the same closed-form optical depth as lighting/fog.wgsl (repeated below; tests/fog.rs
// holds the two to one behaviour), into the sky-view LUT's colour at the horizon in the pixel's
// azimuth plus the sun's forward lobe, tinted by the fog's colour: the fog at the horizon is the
// sky's colour, and towards the sun it glows as fogged geometry in front of it does (SI-03; the
// forward chunk's Henyey-Greenstein lobe of the sun as it reaches the ground, here the frame's sun
// through the transmittance LUT; Godot's sky shader adds the scene fog's sun scatter the same way).

struct SkyOut {
    @builtin(position) position: vec4<f32>,
    @location(0) ndc: vec2<f32>,
}

@group(0) @binding(0) var<uniform> frame: GxFrameV2;
@group(0) @binding(1) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(2) var sky_view: texture_2d<f32>;
@group(0) @binding(3) var transmittance: texture_2d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;

const SKY_PI: f32 = 3.14159265358979;
// The camera's height is held between these, km (sky_view.wgsl's).
const SKY_MIN_HEIGHT_KM: f32 = 0.001;
const SKY_TOP_MARGIN_KM: f32 = 0.01;
// The largest radiance the HDR scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX).
const SKY_RADIANCE_MAX: f32 = 64512.0;
// Limb darkening I(mu) = I(1) mu^alpha per channel (Hestroffer and Magnan 1998, u = 1).
const SKY_LIMB_ALPHA: vec3<f32> = vec3<f32>(0.397, 0.503, 0.652);

// --- Fog (lighting/fog.wgsl's constants and optical depth) ---
const SKY_FOG_REACH: f32 = 50000.0;
const SKY_FOG_CLEAR_DEPTH: f32 = 1e-7;
const SKY_FOG_FLAT_EXPONENT: f32 = 1e-2;
const SKY_FOG_EXPONENT_LIMIT: f32 = 60.0;
const SKY_FOG_HORIZON_SLOPE: f32 = 0.02;
// The sun lobe's Henyey-Greenstein asymmetry, its share of the sun's radiance and the band (sine
// of elevation) over which it sets (lighting/fog.wgsl's GX_FOG_SUN_*; owner decision D13: a third
// weaker than pass 1's 1/2, its colour a third of the way to the sun's luminance).
const SKY_FOG_SUN_G: f32 = 0.6;
const SKY_FOG_SUN_SHARE: f32 = 1.0 / 3.0;
const SKY_FOG_SUN_DESATURATE: f32 = 1.0 / 3.0;
const SKY_FOG_LUMINANCE: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
// lighting/fog.wgsl's GX_FOG_SUN_SIDE_CUT (D13).
const SKY_FOG_SUN_SIDE_CUT: f32 = 0.5;
const SKY_FOG_SET_BAND: f32 = 0.04;

fn sky_fog_exp(x: f32) -> f32 {
    return exp(clamp(x, -SKY_FOG_EXPONENT_LIMIT, SKY_FOG_EXPONENT_LIMIT));
}

// The fog's optical depth along the ray from the camera along unit `dir` for `reach` world units.
fn sky_fog_optical_depth(dir: vec3<f32>, reach: f32) -> f32 {
    let density = frame.fog_color.a;
    let start = frame.fog_params.z;
    if density <= 0.0 || reach <= start {
        return 0.0;
    }
    let falloff = frame.fog_params.x;
    let span = reach - start;
    let rise = falloff * dir.y;
    let exponent = rise * span;
    let start_exponent = falloff * (frame.camera_pos.y + dir.y * start - frame.fog_params.y);
    if abs(exponent) < SKY_FOG_FLAT_EXPONENT {
        return density * sky_fog_exp(-start_exponent) * span * (1.0 - exponent * (0.5 - exponent / 6.0));
    }
    return density * (sky_fog_exp(-start_exponent) - sky_fog_exp(-start_exponent - exponent)) / rise;
}

@vertex
fn vs_sky(@builtin(vertex_index) index: u32) -> SkyOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    let ndc = uv * 2.0 - 1.0;
    // The far plane: 0 under reverse-Z, 1 under standard Z.
    let far = select(1.0, 0.0, frame.depth_reversed == 1u);
    var out: SkyOut;
    out.position = vec4<f32>(ndc, far, 1.0);
    out.ndc = ndc;
    return out;
}

// The camera's height above the ground, km, held inside the atmosphere.
fn sky_view_height() -> f32 {
    return clamp(atmosphere.ground_albedo.w, SKY_MIN_HEIGHT_KM, atmosphere.radii.y - atmosphere.radii.x - SKY_TOP_MARGIN_KM);
}

// The horizon at `height` km: x the zenith angle of the horizon, y the angle from it to the nadir.
fn sky_horizon(height: f32) -> vec2<f32> {
    let bottom = atmosphere.radii.x;
    let tangent = sqrt(height * (2.0 * bottom + height));
    let beta = acos(clamp(tangent / (bottom + height), -1.0, 1.0));
    return vec2<f32>(SKY_PI - beta, beta);
}

// The sky-view LUT's uv for unit `dir` with the sun towards unit `sun`, at `height` km.
fn sky_view_uv(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(sky_view));
    let horizon = sky_horizon(height);
    let zenith = acos(clamp(dir.y, -1.0, 1.0));
    var v: f32;
    if zenith <= horizon.x {
        v = (1.0 - sqrt(max(1.0 - zenith / horizon.x, 0.0))) * 0.5;
    } else {
        v = min(sqrt(max((zenith - horizon.x) / horizon.y, 0.0)), 1.0) * 0.5 + 0.5;
    }
    // The azimuth from the sun, in the horizontal plane (straight up or a sun overhead: towards it).
    let flat_dir = vec2<f32>(dir.x, dir.z);
    let flat_sun = vec2<f32>(sun.x, sun.z);
    var light_view_cos = 1.0;
    if dot(flat_dir, flat_dir) > 1e-12 && dot(flat_sun, flat_sun) > 1e-12 {
        light_view_cos = clamp(dot(normalize(flat_dir), normalize(flat_sun)), -1.0, 1.0);
    }
    let u = sqrt(max(0.5 - 0.5 * light_view_cos, 0.0));
    return (vec2<f32>(u, v) * (size - 1.0) + 0.5) / size;
}

// The transmittance from `height` km to the top along zenith cosine `mu`.
fn sky_transmittance(height: f32, mu: f32) -> vec3<f32> {
    let bottom = atmosphere.radii.x;
    let top = atmosphere.radii.y;
    let r = bottom + height;
    let horizon = sqrt((top - bottom) * (top + bottom));
    let rho = sqrt(max(height * (2.0 * bottom + height), 0.0));
    let discriminant = (top - r) * (top + r) + r * r * mu * mu;
    let d = max(0.0, -r * mu + sqrt(max(discriminant, 0.0)));
    let d_min = top - r;
    let d_max = rho + horizon;
    let uv = vec2<f32>((d - d_min) / max(d_max - d_min, 1e-6), rho / horizon);
    return textureSampleLevel(transmittance, lut_sampler, uv, 0.0).rgb;
}

// The sun disk's radiance along unit `dir` (0 off the disk or below the horizon): the sun's
// illuminance over its solid angle, through the atmosphere, darkened towards the limb.
fn sky_sun_disk(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec3<f32> {
    let radius = frame.sun_dir.w;
    let below_horizon = acos(clamp(dir.y, -1.0, 1.0)) > sky_horizon(height).x;
    if radius <= 0.0 || below_horizon || dot(dir, sun) < cos(radius) {
        return vec3<f32>(0.0);
    }
    // The angle from the disk's centre by its sine: exact where the cosine is flat.
    let angle = asin(min(length(cross(dir, sun)), 1.0));
    let edge = min(angle / radius, 1.0);
    let mu = max(sqrt(max(1.0 - edge * edge, 0.0)), 1e-4);
    let limb = pow(vec3<f32>(mu), SKY_LIMB_ALPHA);
    // 2 pi (1 - cos r), without the cancellation of 1 - cos for a small disk.
    let half_sine = sin(0.5 * radius);
    let solid_angle = 4.0 * SKY_PI * half_sine * half_sine;
    return frame.sun_color.rgb / solid_angle * sky_transmittance(height, sun.y) * limb;
}

// Henyey-Greenstein phase of the sun's forward lobe at `cos_theta` (lighting/fog.wgsl's).
fn sky_fog_phase(cos_theta: f32) -> f32 {
    let g2 = SKY_FOG_SUN_G * SKY_FOG_SUN_G;
    let denominator = max(1.0 + g2 - 2.0 * SKY_FOG_SUN_G * cos_theta, 1e-4);
    return (1.0 - g2) / (4.0 * SKY_PI * denominator * sqrt(denominator));
}

// The sun's forward lobe the fog scatters towards the camera along unit `dir` (lighting/fog.wgsl's
// `gx_fog_inscatter` lobe): the sun as it reaches the ground at `height` km, setting with the sun.
fn sky_fog_sun_lobe(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec3<f32> {
    let ground_sun = frame.sun_color.rgb * sky_transmittance(height, sun.y);
    let lobe_color = mix(ground_sun, vec3<f32>(dot(ground_sun, SKY_FOG_LUMINANCE)), SKY_FOG_SUN_DESATURATE);
    let up = smoothstep(-SKY_FOG_SET_BAND, 0.0, sun.y);
    return lobe_color * (up * SKY_FOG_SUN_SHARE * sky_fog_phase(dot(dir, sun)));
}

// The horizon's light `horizon_light`, read along `horizon_dir` for the ray along `dir`, as the fog
// scatters it (lighting/fog.wgsl's `gx_fog_sky_light`, D13).
fn sky_fog_sky_light(horizon_light: vec3<f32>, horizon_dir: vec3<f32>, dir: vec3<f32>, sun: vec3<f32>) -> vec3<f32> {
    let up = smoothstep(-SKY_FOG_SET_BAND, 0.0, sun.y);
    let nearer = sky_fog_phase(dot(horizon_dir, sun)) - sky_fog_phase(dot(dir, sun));
    let cut = SKY_FOG_SUN_SIDE_CUT * up * max(nearer, 0.0) / sky_fog_phase(1.0);
    return mix(horizon_light, vec3<f32>(dot(horizon_light, SKY_FOG_LUMINANCE)), cut) * (1.0 - cut);
}

// `radiance` seen through the fog towards unit `dir`: blended into the sky-view LUT's colour at the
// horizon in `dir`'s azimuth plus the sun's forward lobe, tinted by the fog's colour.
fn sky_fogged(radiance: vec3<f32>, dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec3<f32> {
    if frame.fog_color.a <= 0.0 {
        return radiance;
    }
    let depth = sky_fog_optical_depth(dir, SKY_FOG_REACH);
    if depth < SKY_FOG_CLEAR_DEPTH {
        return radiance;
    }
    let opacity = min(1.0 - exp(-depth), frame.fog_params.w);
    let around = length(dir.xz);
    let azimuth = select(vec2<f32>(0.0, 1.0), dir.xz / around, around > 1e-6);
    let horizon_dir = normalize(vec3<f32>(azimuth.x, SKY_FOG_HORIZON_SLOPE, azimuth.y));
    let horizon = textureSampleLevel(sky_view, lut_sampler, sky_view_uv(horizon_dir, sun, height), 0.0).rgb;
    let inscatter = sky_fog_sky_light(horizon, horizon_dir, dir, sun) + sky_fog_sun_lobe(dir, sun, height);
    return radiance * (1.0 - opacity) + frame.fog_color.rgb * inscatter * opacity;
}

@fragment
fn fs_sky(in: SkyOut) -> @location(0) vec4<f32> {
    // A point on the near plane (1 under reverse-Z, 0 under standard Z): finite even with an
    // infinite far plane.
    let near = select(0.0, 1.0, frame.depth_reversed == 1u);
    let world = frame.inv_view_proj * vec4<f32>(in.ndc, near, 1.0);
    let dir = normalize(world.xyz / world.w - frame.camera_pos.xyz);
    let sun = normalize(frame.sun_dir.xyz);
    let height = sky_view_height();
    let sky = textureSampleLevel(sky_view, lut_sampler, sky_view_uv(dir, sun, height), 0.0).rgb;
    let radiance = sky_fogged(sky + sky_sun_disk(dir, sun, height), dir, sun, height);
    return vec4<f32>(min(radiance * frame.pre_exposure, vec3<f32>(SKY_RADIANCE_MAX)), 1.0);
}
