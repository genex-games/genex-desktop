// Auto exposure's adaptation (graph node 20, `post/exposure.rs`): the histogram's
// percentile-trimmed mean EV, clamped to the look's limits, less the look's compensation curve at
// it (`aim_ev`), adapted per simulated tick (or at once for captures, history resets and a new
// history) into the exposure state: a full step far from the target, within the look's transition
// the distance times speed over transition (Bevy 0.20's hybrid adaptation, `auto_exposure.wesl`,
// MIT OR Apache-2.0), snapping onto it within 1e-4 EV.
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
    // x: ev_min; y: ev_max; z: ev_compensation; w: the compensation curve's points.
    limits: vec4<f32>,
    // x: EV per tick while brightening; y: EV per tick while darkening; z: the exponential
    // transition in EV (0: linear).
    speed: vec4<f32>,
    // x: input divisor; y: metering; z: ticks; w: flags (bit 0: adapt instantly).
    control: vec4<u32>,
    // The compensation curve: (metered EV, compensation EV) points, two a row, in EV order.
    curve: array<vec4<f32>, 4>,
}

struct PreExposure {
    pre_exposure: f32,
    inv_pre_exposure: f32,
}

const GX_EXPOSURE_BINS: u32 = 128u;
const GX_EXPOSURE_INSTANT: u32 = 1u;
// The adapted EV snaps onto the target once this close (`ADAPT_SNAP_EV`).
const GX_ADAPT_SNAP_EV: f32 = 1.0e-4;
const GX_CURVE_POINTS_MAX: u32 = 8u;
// The most simulated ticks one frame adapts by (`ADAPT_TICKS_PER_FRAME_MAX`).
const GX_ADAPT_TICKS_PER_FRAME_MAX: u32 = 600u;

var<workgroup> gx_prefix: array<u32, 128>;
// x: share × bin-centre EV; y: share.
var<workgroup> gx_sums: array<vec2<f32>, 128>;

@group(0) @binding(0) var<storage, read_write> gx_exposure: ExposureState;
@group(0) @binding(1) var<storage, read> gx_histogram: array<u32, 128>;
@group(0) @binding(2) var<uniform> gx_params: ExposureParams;
@group(0) @binding(3) var<storage, read_write> gx_pre_exposure: PreExposure;

// Point `i` of the compensation curve: (metered EV, compensation EV).
fn gx_curve_point(i: u32) -> vec2<f32> {
    let row = gx_params.curve[i / 2u];
    return select(row.xy, row.zw, (i % 2u) == 1u);
}

// The compensation at metered EV `ev`: flat beyond the first and last points, linear between
// (`post::exposure::curve_compensation`).
fn gx_compensation(ev: f32) -> f32 {
    let count = min(u32(gx_params.limits.w), GX_CURVE_POINTS_MAX);
    if count == 0u {
        return 0.0;
    }
    let first = gx_curve_point(0u);
    let last = gx_curve_point(count - 1u);
    if ev <= first.x {
        return first.y;
    }
    if ev >= last.x {
        return last.y;
    }
    var upper = count - 1u;
    for (var i = count - 1u; i >= 1u; i--) {
        if ev < gx_curve_point(i).x {
            upper = i;
        }
    }
    let a = gx_curve_point(upper - 1u);
    let b = gx_curve_point(upper);
    return a.y + (b.y - a.y) * ((ev - a.x) / (b.x - a.x));
}

// One simulated tick's step from `ev` towards `aim` (`post::exposure::adapt_tick`): linear beyond
// the transition, the distance times speed over transition within it, snapped onto the aim.
fn gx_adapt_tick(ev: f32, aim: f32) -> f32 {
    let up = gx_params.speed.x;
    let down = gx_params.speed.y;
    let delta = aim - ev;
    let transition = gx_params.speed.z;
    var step = min(max(delta, -up), down);
    if transition > 0.0 {
        step = select(max(-up, delta * up / transition), min(down, delta * down / transition), delta > 0.0);
    }
    let next = ev + step;
    if abs(aim - next) < GX_ADAPT_SNAP_EV {
        return aim;
    }
    return next;
}

// The frame's adaptation: one tick's step per simulated tick it ran, at most 600
// (`post::exposure::adapt_ev`).
fn gx_adapt(ev: f32, aim: f32) -> f32 {
    var adapted = ev;
    let ticks = min(gx_params.control.z, GX_ADAPT_TICKS_PER_FRAME_MAX);
    for (var i = 0u; i < ticks; i++) {
        adapted = gx_adapt_tick(adapted, aim);
    }
    return adapted;
}

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
        let metered = min(max(kept.x / kept.y, gx_params.limits.x), gx_params.limits.y);
        target_ev = metered - gx_compensation(metered);
    }
    let instant = ((gx_exposure.flags | gx_params.control.w) & GX_EXPOSURE_INSTANT) != 0u;
    var ev = target_ev;
    if !instant {
        ev = gx_adapt(gx_exposure.ev, target_ev);
    }
    let exposure = exp2(gx_params.limits.z - ev);
    gx_exposure = ExposureState(exposure, ev, target_ev, 0u);
    gx_pre_exposure = PreExposure(exposure, 1.0 / exposure);
}
