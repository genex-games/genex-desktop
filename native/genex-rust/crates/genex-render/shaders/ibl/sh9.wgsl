// IBL bake, step 3 (RQ2.1): the environment's diffuse irradiance as 9 spherical-harmonic
// coefficients (`GxEnvSh`), projected from a small mip of the radiance cube (`source_faces`, its
// six faces as array layers, read texel by texel) by one workgroup of `SH9_THREADS` threads (at
// most 64, plan §2.3). Each texel is weighted by its exact solid angle, so a constant environment
// projects exactly. Lanes accumulate a fixed stride of texels, then reduce in workgroup memory
// (64 x 9 vec4 = 9 KB, under core's 16 KB) along a fixed tree: two bakes are byte-identical.
//
// The convention `ibl::sh9_eval` holds on the CPU: each coefficient is the radiance's projection on
// the real SH basis (`ibl::sh9_basis`) times the cosine lobe's `A_l / pi` (`ibl::SH9_LOBE`), so
// evaluating the basis at a normal gives the radiance a white Lambertian surface there reflects.
//
// Deringing (SI-05; Sloan, "Deringing Spherical Harmonics", 2017; Filament's auto-windowing,
// Apache-2.0): a bright compact source left in a map rings the 9 coefficients negative on the side
// away from it, where the shading's clamp then shows black. After the reduction every lane takes
// the minimum of the SH over its share of `SH9_MIN_POINTS` fixed directions (the centres of an
// 8 x 8 grid on each face); when it is negative, a fixed bisection finds the weakest sinc^4 window
// (cutoff between `SH9_WINDOW_MIN` and `SH9_WINDOW_MAX` bands) that makes it non-negative there,
// and bands 1 and 2 are scaled by it. An SH that is non-negative already is stored as projected.
// `ibl::sh9_dering_window` is the CPU twin.

const SH9_THREADS: u32 = 64u;
// The directions the minimum is taken over (`ibl::sh9_min_directions`): 6 faces x 8 x 8.
const SH9_MIN_GRID: u32 = 8u;
const SH9_MIN_POINTS: u32 = 384u;
// The window's cutoff range in bands and its bisection steps (`ibl::SH9_WINDOW_*`).
const SH9_WINDOW_MIN: f32 = 3.0;
const SH9_WINDOW_MAX: f32 = 13.0;
const SH9_WINDOW_STEPS: u32 = 16u;
const SH9_PI: f32 = 3.14159265358979;

@group(0) @binding(0) var<uniform> bake: IblBake;
@group(0) @binding(1) var source_faces: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read_write> sh_out: array<vec4<f32>, 9>;

var<workgroup> partial: array<array<vec4<f32>, 9>, SH9_THREADS>;
var<workgroup> lowest: array<f32, SH9_THREADS>;
// The projection's least value, read back uniform: whether the bisection runs at all.
var<workgroup> ringing: f32;

// The world direction through texel coordinate `uv` (0..1, v down) of cube face `face`.
fn ibl_cube_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    switch face {
        case 0u: { return normalize(vec3<f32>(1.0, -t, -s)); }
        case 1u: { return normalize(vec3<f32>(-1.0, -t, s)); }
        case 2u: { return normalize(vec3<f32>(s, 1.0, t)); }
        case 3u: { return normalize(vec3<f32>(s, -1.0, -t)); }
        case 4u: { return normalize(vec3<f32>(s, -t, 1.0)); }
        default: { return normalize(vec3<f32>(-s, -t, -1.0)); }
    }
}

// The solid angle of the face region from the face centre to face coordinate (x, y) in -1..1.
fn ibl_area_element(x: f32, y: f32) -> f32 {
    return atan2(x * y, sqrt(x * x + y * y + 1.0));
}

// The real SH basis at unit direction `d`, coefficient `i` (`ibl::sh9_basis`).
fn ibl_sh9_basis(d: vec3<f32>, i: u32) -> f32 {
    switch i {
        case 0u: { return 0.282095; }
        case 1u: { return 0.488603 * d.y; }
        case 2u: { return 0.488603 * d.z; }
        case 3u: { return 0.488603 * d.x; }
        case 4u: { return 1.092548 * d.x * d.y; }
        case 5u: { return 1.092548 * d.y * d.z; }
        case 6u: { return 0.315392 * (3.0 * d.z * d.z - 1.0); }
        case 7u: { return 1.092548 * d.x * d.z; }
        default: { return 0.546274 * (d.x * d.x - d.y * d.y); }
    }
}

// The cosine lobe's A_l / pi of coefficient `i`'s band (`ibl::SH9_LOBE`).
fn ibl_sh9_lobe(i: u32) -> f32 {
    if i == 0u {
        return 1.0;
    }
    if i < 4u {
        return 2.0 / 3.0;
    }
    return 0.25;
}

// Sloan's sinc^4 window of band `band` (1 or 2) for a cutoff of `cutoff` bands (`ibl::sh9_window`).
fn ibl_sh9_window(band: u32, cutoff: f32) -> f32 {
    let x = SH9_PI * f32(band) / cutoff;
    let sinc = sin(x) / x;
    return sinc * sinc * sinc * sinc;
}

// The SH `sh` at unit `d` per channel, bands 1 and 2 scaled by `window` (`ibl::sh9_windowed`).
fn ibl_sh9_windowed(sh: array<vec3<f32>, 9>, d: vec3<f32>, window: vec2<f32>) -> vec3<f32> {
    var value = sh[0] * ibl_sh9_basis(d, 0u);
    for (var i = 1u; i < 9u; i++) {
        value += sh[i] * (ibl_sh9_basis(d, i) * select(window.y, window.x, i < 4u));
    }
    return value;
}

// The least value of `sh` windowed by `window` over every lane's share of the directions and every
// channel, the same in every lane (a fixed tree in workgroup memory, as the projection's).
fn ibl_sh9_workgroup_min(lane: u32, sh: array<vec3<f32>, 9>, window: vec2<f32>) -> f32 {
    var least = 3.0e38;
    for (var point = lane; point < SH9_MIN_POINTS; point += SH9_THREADS) {
        let face = point / (SH9_MIN_GRID * SH9_MIN_GRID);
        let x = point % SH9_MIN_GRID;
        let y = (point / SH9_MIN_GRID) % SH9_MIN_GRID;
        let d = ibl_cube_direction(face, (vec2<f32>(f32(x), f32(y)) + 0.5) / f32(SH9_MIN_GRID));
        let value = ibl_sh9_windowed(sh, d, window);
        least = min(least, min(value.x, min(value.y, value.z)));
    }
    lowest[lane] = least;
    workgroupBarrier();
    for (var stride = SH9_THREADS / 2u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            lowest[lane] = min(lowest[lane], lowest[lane + stride]);
        }
        workgroupBarrier();
    }
    let result = lowest[0];
    workgroupBarrier();
    return result;
}

@compute @workgroup_size(SH9_THREADS, 1, 1)
fn cs_sh9(@builtin(local_invocation_index) lane: u32) {
    let side = textureDimensions(source_faces).x;
    let per_face = side * side;
    let inverse = 1.0 / f32(side);
    var sum: array<vec4<f32>, 9>;
    for (var i = 0u; i < 9u; i++) {
        sum[i] = vec4<f32>(0.0);
    }
    for (var texel = lane; texel < 6u * per_face; texel += SH9_THREADS) {
        let face = texel / per_face;
        let x = (texel % per_face) % side;
        let y = (texel % per_face) / side;
        let d = ibl_cube_direction(face, (vec2<f32>(f32(x), f32(y)) + 0.5) * inverse);
        let x0 = 2.0 * f32(x) * inverse - 1.0;
        let y0 = 2.0 * f32(y) * inverse - 1.0;
        let x1 = x0 + 2.0 * inverse;
        let y1 = y0 + 2.0 * inverse;
        let solid_angle = abs(ibl_area_element(x0, y0) - ibl_area_element(x0, y1) - ibl_area_element(x1, y0) + ibl_area_element(x1, y1));
        let radiance = textureLoad(source_faces, vec2<u32>(x, y), face, 0).rgb * solid_angle;
        for (var i = 0u; i < 9u; i++) {
            sum[i] += vec4<f32>(radiance * ibl_sh9_basis(d, i), 0.0);
        }
    }
    for (var i = 0u; i < 9u; i++) {
        partial[lane][i] = sum[i];
    }
    workgroupBarrier();
    for (var stride = SH9_THREADS / 2u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            for (var i = 0u; i < 9u; i++) {
                partial[lane][i] += partial[lane + stride][i];
            }
        }
        workgroupBarrier();
    }
    var sh: array<vec3<f32>, 9>;
    for (var i = 0u; i < 9u; i++) {
        sh[i] = partial[0][i].rgb * ibl_sh9_lobe(i);
    }
    let projected = ibl_sh9_workgroup_min(lane, sh, vec2<f32>(1.0));
    if lane == 0u {
        ringing = projected;
    }
    // An SH that is non-negative already (a sky, any smooth map) skips the bisection.
    var window = vec2<f32>(1.0);
    if workgroupUniformLoad(&ringing) < 0.0 {
        var low = SH9_WINDOW_MIN;
        var high = SH9_WINDOW_MAX;
        for (var step = 0u; step < SH9_WINDOW_STEPS; step++) {
            let middle = 0.5 * (low + high);
            let least = ibl_sh9_workgroup_min(lane, sh, vec2<f32>(ibl_sh9_window(1u, middle), ibl_sh9_window(2u, middle)));
            if least < 0.0 {
                high = middle;
            } else {
                low = middle;
            }
        }
        window = vec2<f32>(ibl_sh9_window(1u, low), ibl_sh9_window(2u, low));
    }
    if lane == 0u {
        for (var i = 0u; i < 9u; i++) {
            let factor = select(select(window.y, window.x, i < 4u), 1.0, i == 0u);
            sh_out[i] = vec4<f32>(sh[i] * factor, 0.0);
        }
    }
}
