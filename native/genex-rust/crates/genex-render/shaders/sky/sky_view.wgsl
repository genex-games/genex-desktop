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

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var multiscatter: texture_2d<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var sky_view_out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var sky_view_in: texture_2d<f32>;
@group(0) @binding(6) var cube_out: texture_storage_2d_array<rgba16float, write>;

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
    let radiance = textureSampleLevel(sky_view_in, lut_sampler, sky_view_uv(dir, sun, sky_view_height()), 0.0).rgb;
    textureStore(cube_out, vec2<i32>(id.xy), i32(id.z), vec4<f32>(radiance, 1.0));
}
