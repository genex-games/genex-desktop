// Ocean tier (renderer pass 2, B.10): the wave field of a periodic ocean patch, evolved from its
// initial spectrum and brought to space by a 256-point Stockham FFT, one row or column per
// 256-invocation workgroup. Every step has a CPU twin of the same name in `ocean.rs`, so gameplay
// reads the same waves the picture shows.
//
// The method is Tessendorf's (deep-water dispersion, choppy displacement, the Jacobian's folds as
// foam); the Stockham autosort radix-2 passes over workgroup memory follow the idea of
// bevy-aqua-fft (MIT OR Apache-2.0). No source text is copied.
//
// The spectrum buffer holds two "pairs" per texel (vec4 = two complex numbers), each complex
// number packing two real fields (A + iB, both real in space, so their inverse transform comes
// back as re = A, im = B):
//   pair 0: (height + i x-displacement, z-displacement + i x-slope)
//   pair 1: (z-slope + i dDx/dx, dDz/dz + i dDx/dz)
// Index: pair * N * N + row * N + column, row the z wave number index, column the x one.
//
// Kernels (one bind group, group 0):
// - cs_ocean_spectrum: the spectrum at the row's time (h0 rotated by the dispersion);
// - cs_ocean_fft_rows, cs_ocean_fft_columns: the inverse transform along x, then along z;
// - cs_ocean_resolve: the sign of the centred wave numbers, then the displacement map (x, height,
//   z, Jacobian) and the slope map (x, z slopes under the displacement) the surface samples.

struct OceanParams {
    // x: the patch size, m; y: the choppiness (lambda); z: the time's fraction of the repeat period
    // (t / T, 0..1); w: the repeat period's angular frequency step (2 pi / T).
    tile: vec4<f32>,
    // x: the grid size N; y: log2 N; zw: unused.
    grid: vec4<u32>,
}

@group(0) @binding(0) var<uniform> ocean: OceanParams;
// h0(k) (xy) and conj(h0(-k)) (zw), one row per wave number, N * N rows.
@group(0) @binding(1) var<storage, read> ocean_h0: array<vec4<f32>>;
// The two pairs' spectra, transformed in place.
@group(0) @binding(2) var<storage, read_write> ocean_spectrum: array<vec4<f32>>;
// rgb: x displacement, height, z displacement (m); a: the Jacobian (below 1 where waves fold).
@group(0) @binding(3) var ocean_displacement: texture_storage_2d<rgba16float, write>;
// xy: the surface's x and z slopes; zw: 0.
@group(0) @binding(4) var ocean_slope: texture_storage_2d<rgba16float, write>;

const GX_OCEAN_N: u32 = 256u;
const GX_OCEAN_LOG2_N: u32 = 8u;
// Where pair 1 starts in the spectrum buffer (N * N).
const GX_OCEAN_PAIR_STRIDE: u32 = 65536u;
const GX_OCEAN_GRAVITY: f32 = 9.81;
const GX_OCEAN_TAU: f32 = 6.2831855;
// The smallest Jacobian denominator a slope is divided by (a fold's slope stays finite).
const GX_OCEAN_SLOPE_FLOOR: f32 = 0.1;

// Ping-pong rows of one pair (two complex numbers per element): 2 x 256 x 16 B = 8 KB.
var<workgroup> gx_ocean_a: array<vec4<f32>, 256>;
var<workgroup> gx_ocean_b: array<vec4<f32>, 256>;

fn gx_ocean_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// i * a.
fn gx_ocean_i(a: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(-a.y, a.x);
}

// The wave vector of spectrum texel (column, row), rad/m, centred (index N/2 is k = 0).
fn gx_ocean_wave_vector(texel: vec2<u32>) -> vec2<f32> {
    let centred = vec2<f32>(texel) - vec2<f32>(f32(GX_OCEAN_N / 2u));
    return centred * (GX_OCEAN_TAU / ocean.tile.x);
}

// The phase a wave of number `k` has turned through at the row's time: the deep-water dispersion
// sqrt(g k), rounded down to a multiple of the repeat period's step so the field loops, taken as a
// fraction of a turn first (exact for any time within the period).
fn gx_ocean_phase(k: f32) -> f32 {
    let steps = floor(sqrt(GX_OCEAN_GRAVITY * k) / ocean.tile.w);
    return GX_OCEAN_TAU * fract(steps * ocean.tile.z);
}

@compute @workgroup_size(16, 16)
fn cs_ocean_spectrum(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= GX_OCEAN_N || id.y >= GX_OCEAN_N {
        return;
    }
    let index = id.y * GX_OCEAN_N + id.x;
    let kv = gx_ocean_wave_vector(id.xy);
    let k = length(kv);
    let h0 = ocean_h0[index];
    let phase = gx_ocean_phase(k);
    let turn = vec2<f32>(cos(phase), sin(phase));
    let h = gx_ocean_mul(h0.xy, turn) + gx_ocean_mul(h0.zw, vec2<f32>(turn.x, -turn.y));
    let unit = select(vec2<f32>(0.0), kv / k, k > 1e-6);
    let ih = gx_ocean_i(h);
    let dx = unit.x * ih;
    let dz = unit.y * ih;
    let sx = kv.x * ih;
    let sz = kv.y * ih;
    let dxx = -(kv.x * unit.x) * h;
    let dzz = -(kv.y * unit.y) * h;
    let dxz = -(kv.x * unit.y) * h;
    ocean_spectrum[index] = vec4<f32>(h + gx_ocean_i(dx), dz + gx_ocean_i(sx));
    ocean_spectrum[GX_OCEAN_PAIR_STRIDE + index] = vec4<f32>(sz + gx_ocean_i(dxx), dzz + gx_ocean_i(dxz));
}

// One inverse radix-2 Stockham pass over the workgroup row, output element `lane` (every lane
// computes one output; `ns` the sub-transform size so far): out[lane] = a[j] +- w a[j + N/2].
fn gx_ocean_stockham(input: vec4<f32>, partner: vec4<f32>, lane: u32, ns: u32) -> vec4<f32> {
    let k = lane % ns;
    let angle = GX_OCEAN_TAU * f32(k) / f32(2u * ns);
    let w = vec2<f32>(cos(angle), sin(angle));
    let b = vec4<f32>(gx_ocean_mul(partner.xy, w), gx_ocean_mul(partner.zw, w));
    let upper = (lane / ns) % 2u == 1u;
    return select(input + b, input - b, upper);
}

// The source index of output `lane` in a pass of sub-transform size `ns`.
fn gx_ocean_source(lane: u32, ns: u32) -> u32 {
    return (lane / (2u * ns)) * ns + lane % ns;
}

// The whole inverse transform of the row loaded into gx_ocean_a: log2 N passes ping-ponging
// through gx_ocean_b (an even count, so the result is back in gx_ocean_a).
fn gx_ocean_transform(lane: u32) {
    var ns = 1u;
    for (var stage = 0u; stage < GX_OCEAN_LOG2_N; stage += 1u) {
        let j = gx_ocean_source(lane, ns);
        if stage % 2u == 0u {
            gx_ocean_b[lane] = gx_ocean_stockham(gx_ocean_a[j], gx_ocean_a[j + GX_OCEAN_N / 2u], lane, ns);
        } else {
            gx_ocean_a[lane] = gx_ocean_stockham(gx_ocean_b[j], gx_ocean_b[j + GX_OCEAN_N / 2u], lane, ns);
        }
        workgroupBarrier();
        ns *= 2u;
    }
}

// Workgroup (row, pair): the row's x transform in place.
@compute @workgroup_size(256)
fn cs_ocean_fft_rows(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let index = group.y * GX_OCEAN_PAIR_STRIDE + group.x * GX_OCEAN_N + lane;
    gx_ocean_a[lane] = ocean_spectrum[index];
    workgroupBarrier();
    gx_ocean_transform(lane);
    ocean_spectrum[index] = gx_ocean_a[lane];
}

// Workgroup (column, pair): the column's z transform in place.
@compute @workgroup_size(256)
fn cs_ocean_fft_columns(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let index = group.y * GX_OCEAN_PAIR_STRIDE + lane * GX_OCEAN_N + group.x;
    gx_ocean_a[lane] = ocean_spectrum[index];
    workgroupBarrier();
    gx_ocean_transform(lane);
    ocean_spectrum[index] = gx_ocean_a[lane];
}

@compute @workgroup_size(16, 16)
fn cs_ocean_resolve(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= GX_OCEAN_N || id.y >= GX_OCEAN_N {
        return;
    }
    let index = id.y * GX_OCEAN_N + id.x;
    // The centred wave numbers put (-1)^(x + z) on every sample.
    let flip = select(1.0, -1.0, ((id.x + id.y) & 1u) == 1u);
    let p0 = ocean_spectrum[index] * flip;
    let p1 = ocean_spectrum[GX_OCEAN_PAIR_STRIDE + index] * flip;
    let lambda = ocean.tile.y;
    let height = p0.x;
    let dx = p0.y;
    let dz = p0.z;
    let sx = p0.w;
    let sz = p1.x;
    let jxx = 1.0 + lambda * p1.y;
    let jzz = 1.0 + lambda * p1.z;
    let jxz = lambda * p1.w;
    let jacobian = jxx * jzz - jxz * jxz;
    let slope = vec2<f32>(sx / max(jxx, GX_OCEAN_SLOPE_FLOOR), sz / max(jzz, GX_OCEAN_SLOPE_FLOOR));
    textureStore(ocean_displacement, id.xy, vec4<f32>(lambda * dx, height, lambda * dz, jacobian));
    textureStore(ocean_slope, id.xy, vec4<f32>(slope, 0.0, 0.0));
}
