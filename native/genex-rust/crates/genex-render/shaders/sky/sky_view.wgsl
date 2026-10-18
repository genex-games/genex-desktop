// The physical sky, LUT 3 (RQ2.2): Hillaire's sky-view LUT, the sky's radiance around the camera
// by latitude (v: the zenith at 0, the horizon at 0.5, a non-linear mapping dense at the horizon;
// below it, the lit ground) and azimuth from the sun (u: towards it at 0, away at 1; the sky is
// symmetric about the sun's vertical plane). Single scattering with Rayleigh and Cornette-Shanks
// phases plus the multiple-scattering LUT, times the sun's illuminance and the sky's intensity;
// the sun disk is excluded. Refreshed on the preset's frame-indexed cadence; `rgba16float`
// write-only storage at the preset's size.
//
// `cs_sky_cube` reads the LUT back into an environment cube's mip 0 for the IBL bake (no disk:
// the analytic sun lights the scene directly). The medium and lookups repeat multiscatter.wgsl's
// and sky_draw.wgsl's (WGSL has no includes); tests/sky.rs holds them to one behaviour.
//
// The night (renderer pass 2 B.2): the same kernel computes the moonlit sky into a second LUT with
// the moon as its light (`cs_sky_view` over another atmosphere row), and `cs_sky_cube` adds it and
// the stars to the cube at night, so reflections and the night's ambient see them; the moon's disk
// stays out of the cube as the sun's does (the moon is then the analytic light).

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var multiscatter: texture_2d<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var sky_view_out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var sky_view_in: texture_2d<f32>;
@group(0) @binding(6) var cube_out: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(7) var<uniform> night: NightSky;
@group(0) @binding(8) var moon_view_in: texture_2d<f32>;

const SKY_PI: f32 = 3.14159265358979;
// Samples along each view ray.
const SKY_VIEW_STEPS: u32 = 30u;
// Where in a march segment its sample sits: its midpoint (SI-15). Hillaire's sample's 0.3 sits
// where the air is denser than the segment's mean on a ray climbing out of it, so the sky came out
// 3 to 7 percent brighter than the converged integral overhead (tests/sky.rs's f64 reference).
const SKY_SEGMENT_SAMPLE: f32 = 0.5;
// The camera's height is held between these, km (float precision at the planet's radius, and
// inside the atmosphere).
const SKY_MIN_HEIGHT_KM: f32 = 0.001;
const SKY_TOP_MARGIN_KM: f32 = 0.01;
// The farthest a ray is marched, km.
const SKY_MAX_DISTANCE_KM: f32 = 9000.0;

struct SkyMedium {
    rayleigh: vec3<f32>,
    mie: f32,
    scattering: vec3<f32>,
    extinction: vec3<f32>,
}

// The medium at `height` km above the ground.
fn sky_medium(height: f32) -> SkyMedium {
    let mie_density = exp(-height * atmosphere.mie.w);
    let ozone = atmosphere.ozone.rgb * max(0.0, 1.0 - abs(height - atmosphere.radii.z) / (0.5 * atmosphere.radii.w));
    var medium: SkyMedium;
    medium.rayleigh = atmosphere.rayleigh.rgb * exp(-height * atmosphere.rayleigh.w);
    medium.mie = atmosphere.mie.x * mie_density;
    medium.scattering = medium.rayleigh + vec3<f32>(medium.mie);
    medium.extinction = medium.rayleigh + vec3<f32>(atmosphere.mie.y * mie_density) + ozone;
    return medium;
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

// All scattering orders past the first at `height` km with the sun at zenith cosine `sun_cos`,
// per unit illuminance (multiscatter.wgsl's texel centres span 0..1).
fn sky_multiscatter(height: f32, sun_cos: f32) -> vec3<f32> {
    let side = f32(atmosphere.params.x);
    let unit = clamp(vec2<f32>(sun_cos * 0.5 + 0.5, height / (atmosphere.radii.y - atmosphere.radii.x)), vec2<f32>(0.0), vec2<f32>(1.0));
    let uv = (unit * (side - 1.0) + 0.5) / side;
    return textureSampleLevel(multiscatter, lut_sampler, uv, 0.0).rgb;
}

// The distance along unit `dir` from `origin` (relative to the planet's centre) to the ground;
// negative when the ray misses it.
fn sky_ground_distance(origin: vec3<f32>, dir: vec3<f32>) -> f32 {
    let bottom = atmosphere.radii.x;
    let r = length(origin);
    let b = dot(origin, dir);
    let c = (r - bottom) * (r + bottom);
    let discriminant = b * b - c;
    if b > 0.0 || discriminant < 0.0 {
        return -1.0;
    }
    return max(-b - sqrt(discriminant), 0.0);
}

// The distance along unit `dir` from `origin` inside the atmosphere to its top.
fn sky_top_distance(origin: vec3<f32>, dir: vec3<f32>) -> f32 {
    let top = atmosphere.radii.y;
    let r = length(origin);
    let b = dot(origin, dir);
    let c = (r - top) * (r + top);
    return max(-b + sqrt(max(b * b - c, 0.0)), 0.0);
}

fn sky_rayleigh_phase(cos_theta: f32) -> f32 {
    return 3.0 / (16.0 * SKY_PI) * (1.0 + cos_theta * cos_theta);
}

// Cornette-Shanks with the atmosphere's asymmetry g.
fn sky_mie_phase(cos_theta: f32) -> f32 {
    let g = atmosphere.mie.z;
    let g2 = g * g;
    let k = 3.0 / (8.0 * SKY_PI) * (1.0 - g2) / (2.0 + g2);
    let denominator = max(1.0 + g2 - 2.0 * g * cos_theta, 1e-6);
    return k * (1.0 + cos_theta * cos_theta) / (denominator * sqrt(denominator));
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

// The radiance (per unit illuminance, the sun disk excluded) reaching the camera at `height` km
// along unit `dir` with the sun towards unit `sun`; `ground` marks a ray below the horizon, which
// ends on the lit ground.
fn sky_integrate(height: f32, dir: vec3<f32>, sun: vec3<f32>, ground: bool) -> vec3<f32> {
    let bottom = atmosphere.radii.x;
    let origin = vec3<f32>(0.0, bottom + height, 0.0);
    var t_max = sky_top_distance(origin, dir);
    if ground {
        let hit = sky_ground_distance(origin, dir);
        // A ray just below the horizon may miss the sphere in float: it ends at the tangent point.
        t_max = select(sqrt(height * (2.0 * bottom + height)), hit, hit >= 0.0);
    }
    t_max = min(t_max, SKY_MAX_DISTANCE_KM);
    let cos_theta = dot(dir, sun);
    let rayleigh_phase = sky_rayleigh_phase(cos_theta);
    let mie_phase = sky_mie_phase(cos_theta);
    let steps = f32(SKY_VIEW_STEPS);
    var radiance = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);
    for (var i = 0u; i < SKY_VIEW_STEPS; i++) {
        // Quadratic spacing: dense near the camera, where the air is.
        let t0 = t_max * (f32(i) / steps) * (f32(i) / steps);
        let t1 = t_max * (f32(i + 1u) / steps) * (f32(i + 1u) / steps);
        let dt = t1 - t0;
        let p = origin + (t0 + SKY_SEGMENT_SAMPLE * dt) * dir;
        let r = length(p);
        let sample_height = max(r - bottom, 0.0);
        let sun_cos = dot(sun, p / r);
        let medium = sky_medium(sample_height);
        let step_transmittance = exp(-medium.extinction * dt);
        let lit = select(1.0, 0.0, sky_ground_distance(p, sun) >= 0.0);
        let phase_scattering = medium.rayleigh * rayleigh_phase + vec3<f32>(medium.mie * mie_phase);
        let single = lit * sky_transmittance(sample_height, sun_cos) * phase_scattering;
        let source = single + sky_multiscatter(sample_height, sun_cos) * medium.scattering;
        let extinction = max(medium.extinction, vec3<f32>(1e-7));
        radiance += throughput * (source - source * step_transmittance) / extinction;
        throughput *= step_transmittance;
    }
    if ground {
        let p = origin + t_max * dir;
        let sun_cos = dot(sun, normalize(p));
        radiance += throughput * sky_transmittance(0.0, sun_cos) * max(sun_cos, 0.0) * atmosphere.ground_albedo.rgb / SKY_PI;
    }
    return radiance;
}

@compute @workgroup_size(8, 8, 1)
fn cs_sky_view(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = atmosphere.luts.zw;
    if id.x >= size.x || id.y >= size.y {
        return;
    }
    // Texel centres span 0..1 exactly (sky_view_uv inverts this).
    let unit = vec2<f32>(id.xy) / vec2<f32>(max(size, vec2<u32>(2u)) - 1u);
    let height = sky_view_height();
    let horizon = sky_horizon(height);
    var zenith: f32;
    if unit.y < 0.5 {
        let coord = 1.0 - 2.0 * unit.y;
        zenith = horizon.x * (1.0 - coord * coord);
    } else {
        let coord = unit.y * 2.0 - 1.0;
        zenith = horizon.x + horizon.y * coord * coord;
    }
    let light_view_cos = 1.0 - 2.0 * unit.x * unit.x;
    let sin_zenith = sin(zenith);
    let dir = vec3<f32>(sin_zenith * light_view_cos, cos(zenith), sin_zenith * sqrt(max(1.0 - light_view_cos * light_view_cos, 0.0)));
    let sun_cos = clamp(normalize(atmosphere.sun_dir.xyz).y, -1.0, 1.0);
    let sun = vec3<f32>(sqrt(max(1.0 - sun_cos * sun_cos, 0.0)), sun_cos, 0.0);
    let radiance = sky_integrate(height, dir, sun, unit.y >= 0.5);
    let scale = atmosphere.sun_illuminance.rgb * atmosphere.sun_illuminance.w;
    textureStore(sky_view_out, vec2<i32>(id.xy), vec4<f32>(radiance * scale, 1.0));
}

// The sky-view LUT's uv for unit `dir` with the sun towards unit `sun`, at `height` km.
fn sky_view_uv(dir: vec3<f32>, sun: vec3<f32>, height: f32) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(sky_view_in));
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

// The direction through texel centre `uv` (-1..1, v down) of cube face `face` (WebGPU's order and
// orientation: +X, -X, +Y, -Y, +Z, -Z).
fn sky_cube_dir(face: u32, uv: vec2<f32>) -> vec3<f32> {
    switch face {
        case 0u: {
            return normalize(vec3<f32>(1.0, -uv.y, -uv.x));
        }
        case 1u: {
            return normalize(vec3<f32>(-1.0, -uv.y, uv.x));
        }
        case 2u: {
            return normalize(vec3<f32>(uv.x, 1.0, uv.y));
        }
        case 3u: {
            return normalize(vec3<f32>(uv.x, -1.0, -uv.y));
        }
        case 4u: {
            return normalize(vec3<f32>(uv.x, -uv.y, 1.0));
        }
        default: {
            return normalize(vec3<f32>(-uv.x, -uv.y, -1.0));
        }
    }
}

@compute @workgroup_size(8, 8, 1)
fn cs_sky_cube(@builtin(global_invocation_id) id: vec3<u32>) {
    let side = textureDimensions(cube_out).x;
    if id.x >= side || id.y >= side || id.z >= 6u {
        return;
    }
    let uv = (vec2<f32>(id.xy) + 0.5) / f32(side) * 2.0 - 1.0;
    let dir = sky_cube_dir(id.z, uv);
    let sun = normalize(atmosphere.sun_dir.xyz);
    let height = sky_view_height();
    var radiance = textureSampleLevel(sky_view_in, lut_sampler, sky_view_uv(dir, sun, height), 0.0).rgb;
    radiance += sky_night(dir, sun, height, SKY_PI / (2.0 * f32(side)));
    textureStore(cube_out, vec2<i32>(id.xy), i32(id.z), vec4<f32>(radiance, 1.0));
}

// The night along unit `dir` with the sun towards unit `sun` at `height` km, for a texel
// `footprint` radians wide: the moonlit sky where its LUT was computed, and the stars through the
// atmosphere above the horizon as the sun sets.
fn sky_night(dir: vec3<f32>, sun: vec3<f32>, height: f32, footprint: f32) -> vec3<f32> {
    var radiance = vec3<f32>(0.0);
    if night.moon.z > 0.0 && night.moon_dir.w > 0.0 {
        let moon = normalize(night.moon_dir.xyz);
        radiance += textureSampleLevel(moon_view_in, lut_sampler, sky_view_uv(dir, moon, height), 0.0).rgb;
    }
    let fade = sky_night_factor(sun);
    if fade > 0.0 && acos(clamp(dir.y, -1.0, 1.0)) < sky_horizon(height).x {
        radiance += sky_stars(dir, footprint) * sky_transmittance(height, dir.y) * (fade * atmosphere.sun_illuminance.w);
    }
    return radiance;
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

