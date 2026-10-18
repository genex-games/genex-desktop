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
//
// The night (renderer pass 2 B.2, `night_sky.rs`; ideas from Filament's analytic skybox sample,
// Apache-2.0): the moonlit sky-view LUT (the same kernel with the moon as its light), the moon's
// disk lit by the sun (a Lommel-Seeliger sphere, so the full moon is evenly bright, with earthshine
// on its dark side and faint maria), and hashed stars a pixel wide, both through the atmosphere.
// By day nothing of the night draws but a moon the game placed.
//
// The clouds (renderer pass 2 B.5, `clouds.rs`): the cloud panorama (sky/clouds_map.wgsl's mapping)
// over everything above the horizon, the sun and moon disks and the stars included, under the fog.
// Without a layer the panorama is one clear texel (no light, the whole sky behind): the sky draws
// as before, byte for byte.

struct SkyOut {
    @builtin(position) position: vec4<f32>,
    @location(0) ndc: vec2<f32>,
}

@group(0) @binding(0) var<uniform> frame: GxFrameV2;
@group(0) @binding(1) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(2) var sky_view: texture_2d<f32>;
@group(0) @binding(3) var transmittance: texture_2d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;
@group(0) @binding(5) var<uniform> night: NightSky;
@group(0) @binding(6) var moon_view: texture_2d<f32>;
@group(0) @binding(7) var cloud_panorama: texture_2d<f32>;
@group(0) @binding(8) var cloud_sampler: sampler;

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
    let horizon = sky_lut(horizon_dir, sun, height);
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
    // The pixel's angular size (the stars' and the moon's edge's width), in uniform control flow.
    let footprint = max(length(dpdx(dir)), length(dpdy(dir)));
    let sun = normalize(frame.sun_dir.xyz);
    let height = sky_view_height();
    let sky = sky_lut(dir, sun, height) + sky_sun_disk(dir, sun, height) + sky_moon_disk(dir, sun, height, footprint);
    let radiance = sky_fogged(sky_clouded(sky + sky_starlight(dir, sun, height, footprint), dir), dir, sun, height);
    return vec4<f32>(min(radiance * frame.pre_exposure, vec3<f32>(SKY_RADIANCE_MAX)), 1.0);
}

// `radiance` along unit `dir` behind the cloud panorama (B.5): above the horizon only.
fn sky_clouded(radiance: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    if dir.y <= 0.0 {
        return radiance;
    }
    return gx_clouds_over(radiance, textureSampleLevel(cloud_panorama, cloud_sampler, gx_cloud_uv(dir), 0.0));
}

// The sky-view LUT along unit `dir` with the sun towards unit `sun` at `height` km, plus the
// moonlit sky's where it was computed (the night).
fn sky_lut(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec3<f32> {
    var radiance = textureSampleLevel(sky_view, lut_sampler, sky_view_uv(dir, sun, height), 0.0).rgb;
    if night.moon.z > 0.0 && night.moon_dir.w > 0.0 {
        let moon = normalize(night.moon_dir.xyz);
        radiance += textureSampleLevel(moon_view, lut_sampler, sky_view_uv(dir, moon, height), 0.0).rgb;
    }
    return radiance;
}

// The stars along unit `dir` through the atmosphere, above the horizon, as the sun towards unit
// `sun` sets, for a pixel `footprint` radians wide.
fn sky_starlight(dir: vec3<f32>, sun: vec3<f32>, height: f32, footprint: f32) -> vec3<f32> {
    let fade = sky_night_factor(sun);
    if fade <= 0.0 || acos(clamp(dir.y, -1.0, 1.0)) > sky_horizon(height).x {
        return vec3<f32>(0.0);
    }
    return sky_stars(dir, footprint) * sky_transmittance(height, dir.y) * (fade * atmosphere.sun_illuminance.w);
}

// The moon's maria: a smooth value noise on the disk (`p` in disk radii), 1 on the highlands and
// darker on the seas.
fn sky_moon_maria(p: vec2<f32>) -> f32 {
    var sum = 0.0;
    var scale = 2.2;
    var weight = 0.6;
    for (var octave = 0u; octave < 3u; octave++) {
        let q = p * scale + vec2<f32>(f32(octave) * 7.31, 3.17);
        let cell = floor(q);
        let f = q - cell;
        let s = f * f * (3.0 - 2.0 * f);
        let corner = vec2<u32>(vec2<i32>(cell) + vec2<i32>(64));
        let n00 = sky_unit3(sky_pcg3d(vec3<u32>(corner, 11u))).x;
        let n10 = sky_unit3(sky_pcg3d(vec3<u32>(corner + vec2<u32>(1u, 0u), 11u))).x;
        let n01 = sky_unit3(sky_pcg3d(vec3<u32>(corner + vec2<u32>(0u, 1u), 11u))).x;
        let n11 = sky_unit3(sky_pcg3d(vec3<u32>(corner + vec2<u32>(1u, 1u), 11u))).x;
        sum += weight * mix(mix(n00, n10, s.x), mix(n01, n11, s.x), s.y);
        scale *= 2.1;
        weight *= 0.5;
    }
    return 1.0 - 0.35 * smoothstep(0.5, 0.75, sum / 1.05);
}

// The moon's disk along unit `dir` (0 off it or below the horizon) for a pixel `footprint` radians
// wide: the sun towards unit `sun` lights its near side (a Lommel-Seeliger sphere of the moon's
// albedo, earthshine on the rest), through the atmosphere, the edge antialiased over the pixel.
fn sky_moon_disk(dir: vec3<f32>, sun: vec3<f32>, height: f32, footprint: f32) -> vec3<f32> {
    let radius = night.moon_dir.w;
    if radius <= 0.0 {
        return vec3<f32>(0.0);
    }
    let moon = normalize(night.moon_dir.xyz);
    let towards = dot(dir, moon);
    let offset = dir - moon * towards;
    let angle = asin(min(length(offset), 1.0));
    let below_horizon = acos(clamp(dir.y, -1.0, 1.0)) > sky_horizon(height).x;
    if towards <= 0.0 || below_horizon || angle > radius + footprint {
        return vec3<f32>(0.0);
    }
    let coverage = clamp((radius - angle) / max(footprint, 1e-6) + 0.5, 0.0, 1.0);
    // The disk's point as a fraction of its radius, and the moon's surface normal there.
    let disk = offset / sin(radius);
    let s = min(length(disk), 1.0);
    let view_cos = sqrt(max(1.0 - s * s, 0.0));
    let normal = disk - moon * view_cos;
    let lit = max(dot(normal, sun), 0.0);
    let lommel = 2.0 * lit / max(lit + view_cos, 1e-4);
    // The disk's own axes (east and north on the sky) for its maria.
    let east = normalize(select(cross(vec3<f32>(0.0, 1.0, 0.0), moon), vec3<f32>(1.0, 0.0, 0.0), abs(moon.y) > 0.999));
    let north = cross(moon, east);
    let maria = sky_moon_maria(vec2<f32>(dot(disk, east), dot(disk, north)));
    let reflected = frame.sun_color.rgb * (night.moon.x * maria / SKY_PI) * (lommel + night.moon.y);
    return reflected * sky_transmittance(height, moon.y) * coverage;
}

// --- The night (renderer pass 2 B.2, `night_sky.rs`): the moonlit sky, the stars ---
// Repeated in sky_draw.wgsl and sky_view.wgsl (WGSL has no includes); tests/sky.rs holds the two
// to one layout and behaviour.

struct NightSky {
    // xyz: towards the moon; w: its angular radius in radians (0: no moon).
    moon_dir: vec4<f32>,
    // x: the moon's albedo; y: its earthshine share; z: the night factor the moonlit sky-view LUT
    // holds (0: none, not sampled); w: star cells per side of a cube face.
    moon: vec4<f32>,
    // x: the star field's mean radiance (0: none); y, z, w: reserved.
    stars: vec4<f32>,
}

// The sine of the sun's depression over which the night fades in (`night_sky::NIGHT_FADE_SINE`).
const SKY_NIGHT_FADE_SINE: f32 = 0.1;
// A cell holds a star with this probability (about 34,000 stars over the sphere at 128 cells).
const SKY_STAR_DENSITY: f32 = 0.35;
// A star sits at least this share of a cell from its cell's edges.
const SKY_STAR_MARGIN: f32 = 0.15;
// Brightness u^-0.8 for u uniform, held above SKY_STAR_FLOOR: three times as many stars per
// magnitude over six magnitudes. SKY_STAR_MEAN_POWER is its mean (floor^0.2 + (1 - floor^0.2) / 0.2),
// so the field's mean radiance is the uniform's.
const SKY_STAR_POWER: f32 = -0.8;
const SKY_STAR_FLOOR: f32 = 0.001;
const SKY_STAR_MEAN_POWER: f32 = 3.9953;
// A star is a Gaussian this many pixel footprints wide (sigma), never narrower than
// SKY_STAR_SIGMA_MIN radians: about a pixel, so jitter and turning neither flicker nor sparkle.
const SKY_STAR_PIXEL_SIGMA: f32 = 0.75;
const SKY_STAR_SIGMA_MIN: f32 = 1e-4;
// Between these widths of a star (sigma, in cells) the field turns into its mean radiance.
const SKY_STAR_MEAN_FROM: f32 = 0.25;
const SKY_STAR_MEAN_TO: f32 = 0.6;
// Star colours: a hot blue-white to a cool orange (luminance 1 each).
const SKY_STAR_HOT: vec3<f32> = vec3<f32>(0.78, 1.0, 1.32);
const SKY_STAR_COOL: vec3<f32> = vec3<f32>(1.25, 0.97, 0.72);

// How much of the night is drawn for the sun towards unit `sun` (`night_sky::night_factor`).
fn sky_night_factor(sun: vec3<f32>) -> f32 {
    return smoothstep(0.0, SKY_NIGHT_FADE_SINE, -sun.y);
}

// Three well-mixed words from three (Jarzynski and Olano 2020's pcg3d, the algorithm).
fn sky_pcg3d(seed: vec3<u32>) -> vec3<u32> {
    var v = seed * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

fn sky_unit3(words: vec3<u32>) -> vec3<f32> {
    return vec3<f32>(words >> vec3<u32>(8u)) * (1.0 / 16777216.0);
}

// The cube face unit `dir` lies on (0..5: +X, -X, +Y, -Y, +Z, -Z) and its coordinates there, -1..1.
fn sky_star_face(dir: vec3<f32>) -> vec3<f32> {
    let a = abs(dir);
    if a.x >= a.y && a.x >= a.z {
        return vec3<f32>(select(1.0, 0.0, dir.x > 0.0), dir.z / a.x, dir.y / a.x);
    }
    if a.y >= a.z {
        return vec3<f32>(select(3.0, 2.0, dir.y > 0.0), dir.x / a.y, dir.z / a.y);
    }
    return vec3<f32>(select(5.0, 4.0, dir.z > 0.0), dir.x / a.z, dir.y / a.z);
}

// The unit direction at coordinates `uv` (-1..1) of cube face `face` (sky_star_face's inverse).
fn sky_star_face_dir(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let sign = select(-1.0, 1.0, face % 2u == 0u);
    if face < 2u {
        return normalize(vec3<f32>(sign, uv.y, uv.x));
    }
    if face < 4u {
        return normalize(vec3<f32>(uv.x, sign, uv.y));
    }
    return normalize(vec3<f32>(uv.x, uv.y, sign));
}

// The star field's radiance along unit `dir` for a pixel `footprint` radians wide, outside the
// atmosphere: the stars of the two-by-two cells around the cell corner nearest `dir` on its face. A
// footprint wider than about half a cell (a small cube's texel) takes the field's mean instead, the
// energy that search would lose.
fn sky_stars(dir: vec3<f32>, footprint: f32) -> vec3<f32> {
    let mean = night.stars.x;
    let cells = night.moon.w;
    if mean <= 0.0 || cells < 1.0 {
        return vec3<f32>(0.0);
    }
    let sigma = max(footprint * SKY_STAR_PIXEL_SIGMA, SKY_STAR_SIGMA_MIN);
    let average = mean * 0.5 * (SKY_STAR_HOT + SKY_STAR_COOL);
    let blur = smoothstep(SKY_STAR_MEAN_FROM, SKY_STAR_MEAN_TO, sigma * cells / (0.5 * SKY_PI));
    if blur >= 1.0 {
        return average;
    }
    let at = sky_star_face(dir);
    let face = u32(at.x);
    let grid = (at.yz * 0.5 + 0.5) * cells;
    // The two-by-two cells around the cell corner nearest the pixel: a star sits at least
    // SKY_STAR_MARGIN of a cell inside its own, so a farther cell's star is over half a cell away,
    // past the kernel while it is drawn (sigma under SKY_STAR_MEAN_TO of a cell fades to the mean).
    let corner = floor(grid - 0.5);
    let flux_scale = mean * 4.0 * SKY_PI / (6.0 * cells * cells * SKY_STAR_DENSITY * SKY_STAR_MEAN_POWER);
    let kernel_scale = 1.0 / (2.0 * SKY_PI * sigma * sigma);
    var radiance = vec3<f32>(0.0);
    for (var dy = 0; dy <= 1; dy++) {
        for (var dx = 0; dx <= 1; dx++) {
            let cell = corner + vec2<f32>(f32(dx), f32(dy));
            if any(cell < vec2<f32>(0.0)) || any(cell > vec2<f32>(cells - 1.0)) {
                continue;
            }
            // One hash a cell: x places it (or not), y's halves jitter it, z's its brightness and colour.
            let words = sky_pcg3d(vec3<u32>(u32(cell.x), u32(cell.y), face));
            if f32(words.x >> 8u) * (1.0 / 16777216.0) >= SKY_STAR_DENSITY {
                continue;
            }
            let halves = vec4<f32>(vec4<u32>(words.y & 0xffffu, words.y >> 16u, words.z & 0xffffu, words.z >> 16u)) * (1.0 / 65536.0);
            let look = halves.zw;
            let jitter = mix(vec2<f32>(SKY_STAR_MARGIN), vec2<f32>(1.0 - SKY_STAR_MARGIN), halves.xy);
            let star = sky_star_face_dir(face, (cell + jitter) / cells * 2.0 - 1.0);
            let apart = length(cross(dir, star));
            if dot(dir, star) <= 0.0 || apart > 4.0 * sigma {
                continue;
            }
            let flux = flux_scale * pow(max(look.x, SKY_STAR_FLOOR), SKY_STAR_POWER);
            let colour = mix(SKY_STAR_HOT, SKY_STAR_COOL, look.y);
            radiance += colour * (flux * kernel_scale * exp(-0.5 * apart * apart / (sigma * sigma)));
        }
    }
    return mix(radiance, average, blur);
}

