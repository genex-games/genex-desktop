// The auto exposure histogram (graph node 20, `post/exposure.rs`): the HDR scene's log-luminance
// in a fixed 128-bin histogram (`EXPOSURE_HISTOGRAM_BINS`, settings.rs). One invocation samples the
// centre texel of one `divisor`² input cell (`textureLoad`: any float scene format, no sampler),
// divides the scene's pre-exposure back out, weights it by the look's metering and counts it into
// workgroup memory with u32 atomics (WebGPU core), then the workgroup adds its counts to the
// storage histogram. Integer atomics make the counts independent of invocation order.
// `post/exposure.rs` holds the CPU reference of every expression here (`cpu_histogram`).

struct ExposureState {
    exposure: f32,
    ev: f32,
    target_ev: f32,
    flags: u32,
}

struct ExposureParams {
    // x: the EV of bin 0's lower edge; y: bins per EV; z, w: low and high percentiles.
    histogram: vec4<f32>,
    // x: ev_min; y: ev_max; z: ev_compensation.
    limits: vec4<f32>,
    // x: EV per tick while brightening; y: EV per tick while darkening.
    speed: vec4<f32>,
    // x: input divisor; y: metering (0 average, 1 centre, 2 spot); z: ticks; w: flags.
    control: vec4<u32>,
}

const GX_EXPOSURE_BINS: u32 = 128u;
const GX_EXPOSURE_KEY: f32 = 0.18;
const GX_EXPOSURE_BLACK: f32 = 1.0e-6;
const GX_EXPOSURE_LUMINANCE_MAX: f32 = 1.0e30;
const GX_METERING_WEIGHT_MAX: u32 = 16u;
const GX_SPOT_RADIUS: f32 = 0.2;

var<workgroup> gx_bins: array<atomic<u32>, 128>;

@group(0) @binding(0) var gx_hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> gx_histogram: array<atomic<u32>, 128>;
@group(0) @binding(2) var<uniform> gx_params: ExposureParams;
@group(0) @binding(3) var<storage, read> gx_exposure: ExposureState;

fn gx_metering_weight(metering: u32, uv: vec2<f32>) -> u32 {
    let d = vec2<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0);
    let r2 = (d.x * d.x + d.y * d.y) * 0.5;
    if metering == 1u {
        return 1u + u32(floor(15.0 * max(1.0 - r2, 0.0)));
    }
    if metering == 2u {
        return select(0u, GX_METERING_WEIGHT_MAX, r2 <= GX_SPOT_RADIUS * GX_SPOT_RADIUS);
    }
    return GX_METERING_WEIGHT_MAX;
}

@compute @workgroup_size(16, 16)
fn cs_exposure_histogram(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    if local < GX_EXPOSURE_BINS {
        atomicStore(&gx_bins[local], 0u);
    }
    workgroupBarrier();
    let size = textureDimensions(gx_hdr_scene);
    let divisor = max(gx_params.control.x, 1u);
    let cells = (size + vec2<u32>(divisor - 1u)) / divisor;
    if id.x < cells.x && id.y < cells.y {
        let half = divisor / 2u;
        let texel = min(id.xy * divisor + vec2<u32>(half), size - vec2<u32>(1u));
        let rgb = textureLoad(gx_hdr_scene, texel, 0).rgb;
        let luminance = (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) * (1.0 / gx_exposure.exposure);
        // NaN fails both comparisons, so it is never counted.
        if luminance > GX_EXPOSURE_BLACK && luminance < GX_EXPOSURE_LUMINANCE_MAX {
            let ev = log2(luminance / GX_EXPOSURE_KEY);
            let at = floor((ev - gx_params.histogram.x) * gx_params.histogram.y);
            let bin = u32(clamp(at, 0.0, f32(GX_EXPOSURE_BINS - 1u)));
            let uv = vec2<f32>((f32(texel.x) + 0.5) / f32(size.x), (f32(texel.y) + 0.5) / f32(size.y));
            let weight = gx_metering_weight(gx_params.control.y, uv);
            if weight > 0u {
                atomicAdd(&gx_bins[bin], weight);
            }
        }
    }
    workgroupBarrier();
    if local < GX_EXPOSURE_BINS {
        let count = atomicLoad(&gx_bins[local]);
        if count > 0u {
            atomicAdd(&gx_histogram[local], count);
        }
    }
}
