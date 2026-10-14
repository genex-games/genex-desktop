// The physical sky, LUT 2 (RQ2.2): Hillaire's multiple-scattering LUT (32 x 32; u the sun's zenith
// cosine, v the height), from the transmittance LUT: at each texel, second-order light gathered
// over 64 directions with an isotropic phase and the lit ground, summed over every scattering
// order as the geometric series 1 / (1 - f_ms). Per unit sun illuminance, `rgba16float`
// write-only storage; a function of the atmosphere and the ground alone.
//
// The medium and the transmittance lookup repeat transmittance.wgsl's and sky_view.wgsl's (WGSL
// has no includes); tests/sky.rs holds them to one behaviour.

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var lut_sampler: sampler;
@group(0) @binding(3) var multiscatter_out: texture_storage_2d<rgba16float, write>;

const SKY_PI: f32 = 3.14159265358979;
// Directions per side of the gathering grid (8 x 8 = 64, Hillaire's; the workgroup's threads).
const SKY_MS_DIRECTIONS: u32 = 8u;
// Samples along each gathering ray.
const SKY_MS_STEPS: u32 = 20u;
// Where in a march segment its sample sits (Hillaire's 0.3).
const SKY_SEGMENT_SAMPLE: f32 = 0.3;
// Keeps the gathering point off the ground and below the top, km.
const SKY_MS_HEIGHT_MARGIN_KM: f32 = 0.01;
// The farthest a ray is marched, km.
const SKY_MAX_DISTANCE_KM: f32 = 9000.0;

struct SkyMedium {
    scattering: vec3<f32>,
    extinction: vec3<f32>,
}

// The medium at `height` km above the ground.
fn sky_medium(height: f32) -> SkyMedium {
    let rayleigh = atmosphere.rayleigh.rgb * exp(-height * atmosphere.rayleigh.w);
    let mie_density = exp(-height * atmosphere.mie.w);
    let ozone = atmosphere.ozone.rgb * max(0.0, 1.0 - abs(height - atmosphere.radii.z) / (0.5 * atmosphere.radii.w));
    var medium: SkyMedium;
    medium.scattering = rayleigh + vec3<f32>(atmosphere.mie.x * mie_density);
    medium.extinction = rayleigh + vec3<f32>(atmosphere.mie.y * mie_density) + ozone;
    return medium;
}

// The transmittance from `height` km to the top along zenith cosine `mu` (transmittance.wgsl's
// mapping, inverted).
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

struct SkyGather {
    // Second-order light reaching the point from `dir` (isotropic phase, the lit ground).
    light: vec3<f32>,
    // The share of light scattered towards the point along `dir` (f_ms's integrand).
    transfer: vec3<f32>,
}

// One gathering ray from `origin` along `dir` with the sun towards `sun`.
fn sky_gather(origin: vec3<f32>, dir: vec3<f32>, sun: vec3<f32>) -> SkyGather {
    let bottom = atmosphere.radii.x;
    let ground = sky_ground_distance(origin, dir);
    let hits_ground = ground >= 0.0;
    let t_max = min(select(sky_top_distance(origin, dir), ground, hits_ground), SKY_MAX_DISTANCE_KM);
    let isotropic = 1.0 / (4.0 * SKY_PI);
    let steps = f32(SKY_MS_STEPS);
    var gather: SkyGather;
    gather.light = vec3<f32>(0.0);
    gather.transfer = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);
    for (var i = 0u; i < SKY_MS_STEPS; i++) {
        // Quadratic spacing: dense near the point, where the air is.
        let t0 = t_max * (f32(i) / steps) * (f32(i) / steps);
        let t1 = t_max * (f32(i + 1u) / steps) * (f32(i + 1u) / steps);
        let dt = t1 - t0;
        let p = origin + (t0 + SKY_SEGMENT_SAMPLE * dt) * dir;
        let r = length(p);
        let height = max(r - bottom, 0.0);
        let sun_cos = dot(sun, p / r);
        let medium = sky_medium(height);
        let step_transmittance = exp(-medium.extinction * dt);
        let lit = select(1.0, 0.0, sky_ground_distance(p, sun) >= 0.0);
        let source = lit * sky_transmittance(height, sun_cos) * medium.scattering * isotropic;
        let extinction = max(medium.extinction, vec3<f32>(1e-7));
        gather.light += throughput * (source - source * step_transmittance) / extinction;
        gather.transfer += throughput * (medium.scattering - medium.scattering * step_transmittance) / extinction;
        throughput *= step_transmittance;
    }
    if hits_ground {
        let p = origin + t_max * dir;
        let sun_cos = dot(sun, normalize(p));
        gather.light += throughput * sky_transmittance(0.0, sun_cos) * max(sun_cos, 0.0) * atmosphere.ground_albedo.rgb / SKY_PI;
    }
    return gather;
}

// One gathering direction per thread, summed in the workgroup in a fixed tree order (the same
// bits every run): plan §2.3's limits hold (64 threads, 2 KB of workgroup memory).
var<workgroup> gathered_light: array<vec3<f32>, 64>;
var<workgroup> gathered_transfer: array<vec3<f32>, 64>;

// One workgroup per texel (dispatched side x side), one thread per direction.
@compute @workgroup_size(64, 1, 1)
fn cs_multiscatter(@builtin(workgroup_id) texel: vec3<u32>, @builtin(local_invocation_index) direction: u32) {
    let side = atmosphere.params.x;
    // Texel centres span 0..1 exactly (sky_view.wgsl's lookup inverts this).
    let unit = vec2<f32>(texel.xy) / f32(max(side, 2u) - 1u);
    let sun_cos = unit.x * 2.0 - 1.0;
    let thickness = atmosphere.radii.y - atmosphere.radii.x;
    let height = clamp(unit.y * thickness, SKY_MS_HEIGHT_MARGIN_KM, thickness - SKY_MS_HEIGHT_MARGIN_KM);
    let origin = vec3<f32>(0.0, atmosphere.radii.x + height, 0.0);
    let sun = vec3<f32>(sqrt(max(1.0 - sun_cos * sun_cos, 0.0)), sun_cos, 0.0);
    // Uniform over the sphere: azimuth by the direction's column, cosine of the polar angle by its row.
    let grid = f32(SKY_MS_DIRECTIONS);
    let azimuth = 2.0 * SKY_PI * (f32(direction % SKY_MS_DIRECTIONS) + 0.5) / grid;
    let cos_polar = 1.0 - 2.0 * (f32(direction / SKY_MS_DIRECTIONS) + 0.5) / grid;
    let sin_polar = sqrt(max(1.0 - cos_polar * cos_polar, 0.0));
    let dir = vec3<f32>(cos(azimuth) * sin_polar, cos_polar, sin(azimuth) * sin_polar);
    let gather = sky_gather(origin, dir, sun);
    gathered_light[direction] = gather.light;
    gathered_transfer[direction] = gather.transfer;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride = stride / 2u) {
        if direction < stride {
            gathered_light[direction] += gathered_light[direction + stride];
            gathered_transfer[direction] += gathered_transfer[direction + stride];
        }
        workgroupBarrier();
    }
    if direction != 0u || texel.x >= side || texel.y >= side {
        return;
    }
    // The sphere's average, times the isotropic phase's 4 pi over 4 pi.
    let count = grid * grid;
    let light = gathered_light[0] / count;
    let transfer = gathered_transfer[0] / count;
    let all_orders = light / max(vec3<f32>(1.0) - transfer, vec3<f32>(1e-4));
    textureStore(multiscatter_out, vec2<i32>(texel.xy), vec4<f32>(all_orders * atmosphere.ozone.w, 1.0));
}
