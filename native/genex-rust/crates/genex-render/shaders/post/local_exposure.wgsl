// Local exposure's grid (AAA push P3, `post/local_exposure.rs`): before the tonemap, the scene it
// reads into a bilateral grid of log luminance. One workgroup per 32² cell (`GRID_CELL`), one
// invocation per 4² block of it: the block's mean (four bilinear taps, one at the shared corner of
// each 2² of it; on the multisampled scene the first sample of each 2²'s corner texels) turned
// into its EV,
// `log2(luminance / 0.18)` of the pre-exposed scene held to -8..8 (`EV_RANGE`), and splatted with a
// tent into the two nearest of 16 slices (`GRID_SLICES`) as an (EV sum, weight) pair. The cell's
// plain mean EV goes to a second texture. Workgroup u32 atomics in fixed point (WebGPU core) make
// the sums independent of invocation order. The tonemap slices the grid at each pixel's own EV
// (tonemap.wgsl's `gx_tm_local`).

const GX_LE_SLICES: u32 = 16u;
const GX_LE_EV_LO: f32 = -8.0;
const GX_LE_EV_HI: f32 = 8.0;
const GX_LE_KEY: f32 = 0.18;
const GX_LE_BLACK: f32 = 1.0e-6;
// The largest radiance the scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX).
const GX_LE_RADIANCE_MAX: f32 = 64512.0;
// Fixed point: one sample's whole weight. 64 samples × 16 EV × 64 stays far inside a u32.
const GX_LE_UNIT: f32 = 64.0;
// Samples in a whole cell (8² blocks): the grid's weights are shares of a whole cell.
const GX_LE_CELL_SAMPLES: f32 = 64.0;
const GX_LE_CELL: u32 = 32u;
// A sample's block side, in texels.
const GX_LE_BLOCK: u32 = 4u;

var<workgroup> gx_le_weight: array<atomic<u32>, 16>;
var<workgroup> gx_le_sum: array<atomic<u32>, 16>;
// x: samples counted; y: their EV sum above GX_LE_EV_LO.
var<workgroup> gx_le_all: array<atomic<u32>, 2>;

@group(0) @binding(0) var gx_le_scene: texture_2d<f32>;
// Bilinear, clamped to the edge.
@group(0) @binding(1) var gx_le_sampler: sampler;
// (EV sum above GX_LE_EV_LO, weight), each a share of a whole cell's samples.
@group(0) @binding(2) var gx_le_grid: texture_storage_3d<rgba16float, write>;
// x: the cell's plain mean EV.
@group(0) @binding(3) var gx_le_mean: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var gx_le_msaa: texture_multisampled_2d<f32>;

fn gx_le_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// A sample's EV, black (and NaN, which fails the comparison) at the darkest slice.
fn gx_le_ev(rgb: vec3<f32>) -> f32 {
    let luminance = min(gx_le_luma(max(rgb, vec3<f32>(0.0))), GX_LE_RADIANCE_MAX);
    if !(luminance > GX_LE_BLACK) {
        return GX_LE_EV_LO;
    }
    return clamp(log2(luminance / GX_LE_KEY), GX_LE_EV_LO, GX_LE_EV_HI);
}

fn gx_le_clear(local: u32) {
    if local < GX_LE_SLICES {
        atomicStore(&gx_le_weight[local], 0u);
        atomicStore(&gx_le_sum[local], 0u);
    }
    if local < 2u {
        atomicStore(&gx_le_all[local], 0u);
    }
}

// Count one sample of EV `ev` into the workgroup's slices with a tent.
fn gx_le_splat(ev: f32) {
    let above = ev - GX_LE_EV_LO;
    let z = above / (GX_LE_EV_HI - GX_LE_EV_LO) * f32(GX_LE_SLICES - 1u);
    let lower = min(u32(floor(z)), GX_LE_SLICES - 2u);
    let f = z - f32(lower);
    atomicAdd(&gx_le_weight[lower], u32(round((1.0 - f) * GX_LE_UNIT)));
    atomicAdd(&gx_le_sum[lower], u32(round((1.0 - f) * above * GX_LE_UNIT)));
    atomicAdd(&gx_le_weight[lower + 1u], u32(round(f * GX_LE_UNIT)));
    atomicAdd(&gx_le_sum[lower + 1u], u32(round(f * above * GX_LE_UNIT)));
    atomicAdd(&gx_le_all[0], 1u);
    atomicAdd(&gx_le_all[1], u32(round(above * GX_LE_UNIT)));
}

// Write the workgroup's slices and mean for `cell`.
fn gx_le_write(cell: vec2<u32>, local: u32) {
    let share = 1.0 / (GX_LE_UNIT * GX_LE_CELL_SAMPLES);
    if local < GX_LE_SLICES {
        let sum = f32(atomicLoad(&gx_le_sum[local])) * share;
        let weight = f32(atomicLoad(&gx_le_weight[local])) * share;
        textureStore(gx_le_grid, vec3<u32>(cell, local), vec4<f32>(sum, weight, 0.0, 0.0));
    }
    if local == GX_LE_SLICES {
        let count = atomicLoad(&gx_le_all[0]);
        let mean = select(0.0, f32(atomicLoad(&gx_le_all[1])) / (GX_LE_UNIT * f32(count)) + GX_LE_EV_LO, count > 0u);
        textureStore(gx_le_mean, cell, vec4<f32>(mean, 0.0, 0.0, 0.0));
    }
}

@compute @workgroup_size(8, 8)
fn cs_local_exposure_grid(@builtin(workgroup_id) cell: vec3<u32>, @builtin(local_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    gx_le_clear(local);
    workgroupBarrier();
    let size = textureDimensions(gx_le_scene);
    let origin = cell.xy * GX_LE_CELL + id.xy * GX_LE_BLOCK;
    if all(origin < size) {
        // The shared corner of each 2² of the block: each bilinear tap is its mean (the edge
        // texel repeats).
        var sum = vec3<f32>(0.0);
        for (var i = 0u; i < 4u; i++) {
            let corner = vec2<f32>(origin + 2u * vec2<u32>(i & 1u, i >> 1u)) + 1.0;
            sum += textureSampleLevel(gx_le_scene, gx_le_sampler, corner / vec2<f32>(size), 0.0).rgb;
        }
        gx_le_splat(gx_le_ev(sum * 0.25));
    }
    workgroupBarrier();
    gx_le_write(cell.xy, local);
}

@compute @workgroup_size(8, 8)
fn cs_local_exposure_grid_msaa(@builtin(workgroup_id) cell: vec3<u32>, @builtin(local_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    gx_le_clear(local);
    workgroupBarrier();
    let size = textureDimensions(gx_le_msaa);
    let origin = cell.xy * GX_LE_CELL + id.xy * GX_LE_BLOCK;
    if all(origin < size) {
        let last = vec2<i32>(size) - 1;
        let at = vec2<i32>(origin);
        var sum = vec3<f32>(0.0);
        for (var i = 0; i < 4; i++) {
            let texel = min(at + 2 * vec2<i32>(i & 1, i >> 1u), last);
            sum += min(max(textureLoad(gx_le_msaa, texel, 0).rgb, vec3<f32>(0.0)), vec3<f32>(GX_LE_RADIANCE_MAX));
        }
        gx_le_splat(gx_le_ev(sum * 0.25));
    }
    workgroupBarrier();
    gx_le_write(cell.xy, local);
}
