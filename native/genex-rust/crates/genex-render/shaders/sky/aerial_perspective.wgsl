// Aerial perspective (graph node 11, RQ4.3; Hillaire's camera-space volume): 32 x 32 froxels by 32
// slices from the camera out along the view frustum, in two halves (renderer pass 2 SI-04). Texel
// (x, y, z) holds what the air between the camera and the point at slice coordinate w = (z + 0.5)
// / 32 along pixel (x, y)'s ray (`aerial_slice_km`, the fog chunk's `gx_air_slice` inverted) does to
// the light behind it: rgb the sky's in-scatter along that stretch (a 0: no height fog in it), and
// texel (x, y, z + 32) its transmittance per channel (the fog chunk's `gx_apply_air` is
// `color × transmittance + in-scatter`). One workgroup per pixel column marches the sky model's
// single scattering (the sky-view LUT's own integral, sky_view.wgsl) with the multiple-scattering
// LUT's second-order term, a thread per slice, and accumulates through the slices with a prefix
// scan. It runs on medium and above, where the fog's look allows it; `rgba16float` write-only
// storage, core.
//
// The medium and lookups repeat sky_view.wgsl's (WGSL has no includes); tests/fog.rs holds the
// volume's transmittance to a numeric integral and its in-scatter to the sky-view LUT.

@group(0) @binding(0) var<uniform> atmosphere: SkyAtmosphere;
@group(0) @binding(1) var<uniform> frame: GxFrameV2;
@group(0) @binding(2) var transmittance: texture_2d<f32>;
@group(0) @binding(3) var multiscatter: texture_2d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;
@group(0) @binding(5) var aerial_out: texture_storage_3d<rgba16float, write>;

const SKY_PI: f32 = 3.14159265358979;
// The farthest slice, world units (the fog chunk's GX_FOG_AERIAL_RANGE), where its slices turn
// from even to logarithmic steps (GX_AIR_NEAR), and world units per km.
const AERIAL_RANGE: f32 = 32000.0;
const AERIAL_NEAR: f32 = 4.0;
const AERIAL_UNITS_PER_KM: f32 = 1000.0;
// Marching steps inside each slice.
const AERIAL_SLICE_STEPS: u32 = 4u;
// The camera's height is held between these, km (sky_view.wgsl's).
const SKY_MIN_HEIGHT_KM: f32 = 0.001;
const SKY_TOP_MARGIN_KM: f32 = 0.01;

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

// The distance (km) along a slice's ray at slice coordinate `w` (0..1): the fog chunk's
// `gx_air_slice` inverted (fog.rs `aerial_slice_distance`).
fn aerial_slice_km(w: f32) -> f32 {
    let span = log2(1.0 + AERIAL_RANGE / AERIAL_NEAR);
    return AERIAL_NEAR * (exp2(clamp(w, 0.0, 1.0) * span) - 1.0) / AERIAL_UNITS_PER_KM;
}

// Each workgroup is one pixel column: its 32 threads march one slice each (the slices' segments
// are independent), then combine in a prefix scan, so the column costs a slice's steps and five
// scan rounds, not 32 slices' steps one after the other. A segment is (radiance, transmittance)
// from the segment's start; `prefix then this` is (L_prev + T_prev * L, T_prev * T), associative.
const AERIAL_SLICES: u32 = 32u;

var<workgroup> scan_radiance: array<vec3<f32>, 32>;
var<workgroup> scan_transmittance: array<vec3<f32>, 32>;

@compute @workgroup_size(32, 1, 1)
fn cs_aerial_perspective(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) slice: u32) {
    // The ray through the column's pixel centre (v down): a point on the near plane (1 under
    // reverse-Z, 0 under standard Z), as sky_draw.wgsl unprojects.
    let uv = (vec2<f32>(group.xy) + 0.5) / f32(AERIAL_SLICES);
    let near = select(0.0, 1.0, frame.depth_reversed == 1u);
    let world = frame.inv_view_proj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, near, 1.0);
    let dir = normalize(world.xyz / world.w - frame.camera_pos.xyz);
    let sun = normalize(atmosphere.sun_dir.xyz);

    let bottom = atmosphere.radii.x;
    let origin = vec3<f32>(0.0, bottom + sky_view_height(), 0.0);
    // The ray ends on the ground or at the top of the atmosphere.
    let ground = sky_ground_distance(origin, dir);
    let reach = select(sky_top_distance(origin, dir), ground, ground >= 0.0);
    let cos_theta = dot(dir, sun);
    let rayleigh_phase = sky_rayleigh_phase(cos_theta);
    let mie_phase = sky_mie_phase(cos_theta);

    // This thread's slice: from the previous slice's end to its own, both capped at the ray's end.
    let start = select(0.0, min(aerial_slice_km((f32(slice) - 0.5) / f32(AERIAL_SLICES)), reach), slice > 0u);
    let end = min(aerial_slice_km((f32(slice) + 0.5) / f32(AERIAL_SLICES)), reach);
    let dt = max(end - start, 0.0) / f32(AERIAL_SLICE_STEPS);
    var radiance = vec3<f32>(0.0);
    var throughput = vec3<f32>(1.0);
    for (var sub = 0u; sub < AERIAL_SLICE_STEPS; sub++) {
        let p = origin + (start + (f32(sub) + 0.5) * dt) * dir;
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
    scan_radiance[slice] = radiance;
    scan_transmittance[slice] = throughput;
    workgroupBarrier();

    // Inclusive prefix scan over the slices (Hillis-Steele: read, barrier, write, barrier).
    for (var offset = 1u; offset < AERIAL_SLICES; offset *= 2u) {
        var l = scan_radiance[slice];
        var t = scan_transmittance[slice];
        if slice >= offset {
            let previous_l = scan_radiance[slice - offset];
            let previous_t = scan_transmittance[slice - offset];
            l = previous_l + previous_t * l;
            t = previous_t * t;
        }
        workgroupBarrier();
        scan_radiance[slice] = l;
        scan_transmittance[slice] = t;
        workgroupBarrier();
    }

    let scale = atmosphere.sun_illuminance.rgb * atmosphere.sun_illuminance.w;
    let total = scan_transmittance[slice];
    let column = vec2<i32>(group.xy);
    // In-scatter in front (alpha 0: the height fog is not in it), the transmittance per channel
    // behind (alpha its mean, for a reader of the grey form).
    textureStore(aerial_out, vec3<i32>(column, i32(slice)), vec4<f32>(scan_radiance[slice] * scale, 0.0));
    textureStore(aerial_out, vec3<i32>(column, i32(slice + AERIAL_SLICES)), vec4<f32>(total, (total.x + total.y + total.z) / 3.0));
}
