// Auto exposure's adaptation (graph node 20, `post/exposure.rs`): the histogram's
// percentile-trimmed mean EV, clamped to the look's limits, adapted by a fixed step per simulated
// tick (or at once for captures, history resets and a new history) into the exposure state.
// `ExposureState` is layout.rs `GpuExposureState` (tests/layout.rs holds the two equal):
// `exposure` is the next frame's pre-exposure, also written with its inverse to `PreExposure`
// (the order of `GxFrameV2.pre_exposure, inv_pre_exposure`, one 8-byte copy). One invocation per
// bin: an exclusive prefix sum of the counts in u32 (exact), each bin's trimmed share, then a
// fixed-order tree sum of the shares, so the result is the same on every run and no invocation
// loops over the bins. `post/exposure.rs` holds the CPU reference (`meter_ev`, `adapt_ev`), which
// sums in the same order.

struct ExposureState {
    exposure: f32,
    ev: f32,
    target_ev: f32,
    // Bit 0: adapt instantly (set for a new history; cleared here).
    flags: u32,
}

struct ExposureParams {
    // x: the EV of bin 0's lower edge; y: bins per EV; z, w: low and high percentiles.
    histogram: vec4<f32>,
    // x: ev_min; y: ev_max; z: ev_compensation.
    limits: vec4<f32>,
    // x: EV per tick while brightening; y: EV per tick while darkening.
    speed: vec4<f32>,
    // x: input divisor; y: metering; z: ticks; w: flags (bit 0: adapt instantly).
    control: vec4<u32>,
}

struct PreExposure {
    pre_exposure: f32,
    inv_pre_exposure: f32,
}

const GX_EXPOSURE_BINS: u32 = 128u;
const GX_EXPOSURE_INSTANT: u32 = 1u;

var<workgroup> gx_prefix: array<u32, 128>;
// x: share × bin-centre EV; y: share.
var<workgroup> gx_sums: array<vec2<f32>, 128>;

@group(0) @binding(0) var<storage, read_write> gx_exposure: ExposureState;
@group(0) @binding(1) var<storage, read> gx_histogram: array<u32, 128>;
@group(0) @binding(2) var<uniform> gx_params: ExposureParams;
@group(0) @binding(3) var<storage, read_write> gx_pre_exposure: PreExposure;

@compute @workgroup_size(128)
fn cs_exposure_adapt(@builtin(local_invocation_index) bin: u32) {
    let count = gx_histogram[bin];
    gx_prefix[bin] = count;
    workgroupBarrier();
    // Inclusive scan (Hillis-Steele): integer sums, exact in any order.
    for (var offset = 1u; offset < GX_EXPOSURE_BINS; offset <<= 1u) {
        var sum = gx_prefix[bin];
        if bin >= offset {
            sum += gx_prefix[bin - offset];
        }
        workgroupBarrier();
        gx_prefix[bin] = sum;
        workgroupBarrier();
    }
    let total = f32(gx_prefix[GX_EXPOSURE_BINS - 1u]);
    let below = f32(gx_prefix[bin] - count);
    let low = total * gx_params.histogram.z;
    let high = total * gx_params.histogram.w;
    let share = max(min(below + f32(count), high) - max(below, low), 0.0);
    let centre = gx_params.histogram.x + (f32(bin) + 0.5) * (1.0 / gx_params.histogram.y);
    gx_sums[bin] = vec2<f32>(share * centre, share);
    workgroupBarrier();
    // Tree sum in a fixed order: bin i adds bin i + stride.
    for (var stride = GX_EXPOSURE_BINS / 2u; stride > 0u; stride >>= 1u) {
        if bin < stride {
            gx_sums[bin] = gx_sums[bin] + gx_sums[bin + stride];
        }
        workgroupBarrier();
    }
    if bin != 0u {
        return;
    }
    let kept = gx_sums[0];
    // Nothing counted (or nothing kept): hold the last target.
    var target_ev = gx_exposure.target_ev;
    if total > 0.0 && kept.y > 0.0 {
        target_ev = min(max(kept.x / kept.y, gx_params.limits.x), gx_params.limits.y);
    }
    let instant = ((gx_exposure.flags | gx_params.control.w) & GX_EXPOSURE_INSTANT) != 0u;
    var ev = target_ev;
    if !instant {
        let ticks = f32(gx_params.control.z);
        let up = gx_params.speed.x * ticks;
        let down = gx_params.speed.y * ticks;
        ev = gx_exposure.ev + min(max(target_ev - gx_exposure.ev, -up), down);
    }
    let exposure = exp2(gx_params.limits.z - ev);
    gx_exposure = ExposureState(exposure, ev, target_ev, 0u);
    gx_pre_exposure = PreExposure(exposure, 1.0 / exposure);
}
