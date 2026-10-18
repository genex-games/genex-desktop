// The sun-shadow screen mask's denoise (renderer pass 2, B.7, SH-04): its own temporal
// accumulation and an edge-avoiding spatial filter, after AMD's FidelityFX Shadow Denoiser
// (ffx-shadows-dnsr, MIT, GPUOpen-Effects/FidelityFX-Denoiser; ported to WGSL fragment passes
// without wave intrinsics or tile bitmasks, for a continuous PCSS visibility instead of one ray's
// hit bit).
//
// - `fs_sun_mask_temporal` (FidelityFX's tile classification pass): last frame's state found along
//   the prepass's motion, read bilinearly over the texels whose held view depth agrees with where
//   last frame's camera saw this point within the tolerance the visibility pass wrote
//   (FidelityFX's disocclusion test: 1% facing the camera, 10% edge-on); clamped to the 3x3 neighbourhood's mean plus or minus `temporal.y` standard
//   deviations; its sample count damped by how far it lay outside (sigma 20); blended with the
//   current visibility at lerp(`temporal.x`, 1, sqrt(max(8 - n, 0) / 8)); its variance boosted
//   over the first 16 frames.
// - `fs_sun_mask_compose` (FidelityFX's filter passes, one step here): a 3x3 a-trous kernel
//   (1, 2/3) one texel apart, two for a history younger than GX_MASK_YOUNG_COUNT frames (a
//   disocclusion's one or two frames are all noise), weighed by the shadow's similarity over the
//   accumulated estimate's standard deviation (not one frame's, so a converged history is barely
//   filtered) and by the view depth's; written beside the contact shadow as the mask the forward
//   pass reads (`rgba8unorm`: r contact, g the sun's visibility, a 0 marks the mask; a neutral
//   white texel's a 1 tells the forward pass to shade the sun inline). FidelityFX runs three steps
//   with a 3x3-filtered variance and the normals' similarity for one ray's hit bit; on a PCSS
//   visibility those cost three times this mask's whole budget for no visible change on the rows.
//
// State (`rgba16float`): x the accumulated visibility, y its variance, z the history's sample
// count, w the view depth it was made at (0: sky).

@group(0) @binding(0) var<uniform> gx_mask: SunMaskParams;
@group(0) @binding(1) var gx_raw: texture_2d<f32>;
@group(0) @binding(3) var gx_motion: texture_2d<f32>;
@group(0) @binding(4) var gx_history: texture_2d<f32>;
@group(0) @binding(5) var gx_state: texture_2d<f32>;
@group(0) @binding(7) var gx_contact: texture_2d<f32>;

// The neighbourhood the temporal clamp measures, texels either side (3x3).
const GX_MASK_CLAMP_RADIUS: i32 = 1;
// The history's longest memory: past it the current frame takes `temporal.x`.
const GX_MASK_FULL_COUNT: f32 = 8.0;
// The sample count is held to this, so a long still history still damps on a discontinuity.
const GX_MASK_COUNT_MAX: f32 = 32.0;
// Below this many samples the variance is boosted (FidelityFX's 16).
const GX_MASK_BOOST_COUNT: f32 = 16.0;
// A history younger than this many frames is filtered two texels apart.
const GX_MASK_YOUNG_COUNT: f32 = 4.0;
// The sample-count damper's sigma (FidelityFX's 20).
const GX_MASK_DAMP_SIGMA: f32 = 20.0;
// The least bilinear weight of agreeing history texels for the history to count.
const GX_MASK_HISTORY_WEIGHT_FLOOR: f32 = 0.05;
// The a-trous kernel's weight one step off the centre along an axis (FidelityFX's 1, 2/3; its
// 1/6 lies two steps off, outside the 3x3).
const GX_MASK_KERNEL_SIDE: f32 = 2.0 / 3.0;

fn gx_mask_size() -> vec2<i32> {
    return vec2<i32>(gx_mask.size.xy);
}

fn gx_mask_clamped(texel: vec2<i32>) -> vec2<i32> {
    return clamp(texel, vec2<i32>(0), gx_mask_size() - vec2<i32>(1));
}

// The 3x3 neighbourhood's mean and variance of this frame's visibility over receivers.
fn gx_mask_neighbourhood(texel: vec2<i32>) -> vec2<f32> {
    var sum = 0.0;
    var squares = 0.0;
    var count = 0.0;
    for (var y = -GX_MASK_CLAMP_RADIUS; y <= GX_MASK_CLAMP_RADIUS; y++) {
        for (var x = -GX_MASK_CLAMP_RADIUS; x <= GX_MASK_CLAMP_RADIUS; x++) {
            let raw = textureLoad(gx_raw, gx_mask_clamped(texel + vec2<i32>(x, y)), 0);
            if raw.y > 0.0 {
                sum += raw.x;
                squares += raw.x * raw.x;
                count += 1.0;
            }
        }
    }
    let mean = sum / max(count, 1.0);
    return vec2<f32>(mean, max(squares / max(count, 1.0) - mean * mean, 0.0));
}

// Last frame's state at `uv` (in 0..1), its texels kept only where the view depth they were made
// at agrees with `expected` within `tolerance`; w of the answer 0 where none agree.
fn gx_mask_history(uv: vec2<f32>, expected: f32, tolerance: f32) -> vec4<f32> {
    let size = gx_mask_size();
    let at = uv * gx_mask.size.xy - 0.5;
    let base = vec2<i32>(floor(at));
    let f = at - floor(at);
    var sum = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var i = 0; i < 4; i++) {
        let offset = vec2<i32>(i & 1, i >> 1u);
        let tap = base + offset;
        let bilinear = mix(1.0 - f.x, f.x, f32(offset.x)) * mix(1.0 - f.y, f.y, f32(offset.y));
        let inside = all(tap >= vec2<i32>(0)) && all(tap < size);
        let held = textureLoad(gx_history, gx_mask_clamped(tap), 0);
        let agrees = inside && held.w > 0.0 && abs(held.w - expected) <= tolerance * expected;
        let weight = select(0.0, bilinear, agrees);
        sum += held * weight;
        weight_sum += weight;
    }
    if weight_sum < GX_MASK_HISTORY_WEIGHT_FLOOR {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(sum.xyz / weight_sum, 1.0);
}

@fragment
fn fs_sun_mask_temporal(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(position.xy);
    let raw = textureLoad(gx_raw, texel, 0);
    if raw.y <= 0.0 {
        return vec4<f32>(1.0, 0.0, 0.0, 0.0);
    }
    let current = raw.x;
    let local = gx_mask_neighbourhood(texel);
    let deviation = sqrt(local.y);
    var history = vec4<f32>(0.0);
    var motion_px = 0.0;
    let usable = gx_mask.flags.y != 0u && gx_mask.flags.z != 0u;
    if usable {
        let motion = textureLoad(gx_motion, texel, 0).xy;
        motion_px = length(motion * 0.5 * gx_mask.size.xy);
        let uv = position.xy * gx_mask.size.zw - motion * vec2<f32>(0.5, -0.5);
        let tolerance = raw.w;
        if all(uv >= vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0)) {
            history = gx_mask_history(uv, raw.z, tolerance);
        }
    }
    if history.w <= 0.0 {
        // No history (a reset, a disocclusion, off screen): this frame alone, its variance the
        // neighbourhood's (the filter boosts a young history's, as FidelityFX does).
        return vec4<f32>(current, local.y, 1.0, raw.y);
    }
    let lo = local.x - gx_mask.temporal.y * deviation;
    let hi = local.x + gx_mask.temporal.y * deviation;
    let previous = history.x;
    let clamped = clamp(previous, lo, hi);
    // How far outside the neighbourhood the history lay damps its sample count (FidelityFX).
    let discontinuity = (previous - local.x) / max(gx_mask.temporal.y * deviation, 0.001);
    let damped = min(history.z + 1.0, GX_MASK_COUNT_MAX) * exp(-discontinuity * discontinuity / GX_MASK_DAMP_SIGMA);
    // A moving pixel takes at least the moving floor and more with its motion (each frame of
    // motion resamples the history, and the losses compound over its memory), held as a shorter
    // history so the filter weighs its variance the same way.
    let count = min(damped, gx_mask_count_for(gx_mask_moving_alpha(motion_px)));
    let alpha = gx_mask_alpha(count);
    let value = mix(clamped, current, alpha);
    // The per-frame variance as a running mean of the squared innovation, never under the
    // neighbourhood's while the history is young.
    let innovation = current - clamped;
    var variance = mix(history.y, innovation * innovation, alpha);
    if count < GX_MASK_BOOST_COUNT {
        variance = max(variance, local.y);
    }
    return vec4<f32>(value, variance, count, raw.y);
}

// The current frame's weight in an accumulation `count` frames long: 1 for a new history,
// falling to the still floor (`temporal.x`) at GX_MASK_FULL_COUNT frames (FidelityFX's schedule).
fn gx_mask_alpha(count: f32) -> f32 {
    return mix(gx_mask.temporal.x, 1.0, sqrt(max(GX_MASK_FULL_COUNT - count, 0.0) / GX_MASK_FULL_COUNT));
}

// The history length whose weight (`gx_mask_alpha`) is `alpha`.
fn gx_mask_count_for(alpha: f32) -> f32 {
    let young = clamp((alpha - gx_mask.temporal.x) / max(1.0 - gx_mask.temporal.x, 1e-6), 0.0, 1.0);
    return GX_MASK_FULL_COUNT * (1.0 - young * young);
}

// The least current weight of a pixel that moved `motion_px` render pixels since last frame: none
// below `motion.w` (a still or creeping camera keeps the still floor), else the moving floor
// (`motion.x`, FidelityFX's 0.05) raised by `motion.y` a pixel up to `motion.z`.
fn gx_mask_moving_alpha(motion_px: f32) -> f32 {
    if motion_px < gx_mask.motion.w {
        return 0.0;
    }
    return clamp(motion_px * gx_mask.motion.y, gx_mask.motion.x, gx_mask.motion.z);
}

// The filter's input at `texel`: x the visibility, y the variance of that estimate, z the view
// depth it was made at (0: sky), w its sample count. The temporal state holds the per-frame
// variance of the visibility (the turning taps' noise); an exponential average of weight alpha has
// alpha / (2 - alpha) of it, so a long history is filtered only as much as it is still noisy, and a
// young one (alpha 1, its variance boosted as FidelityFX boosts it) as much as one frame is.
// (FidelityFX filters one ray's hit bit, all noise; a PCSS visibility is already filtered over its
// penumbra, and the per-frame variance blurred the fence's 3-pixel penumbrae five times as wide.)
fn gx_mask_input(texel: vec2<i32>) -> vec4<f32> {
    let held = textureLoad(gx_state, texel, 0);
    let alpha = gx_mask_alpha(held.z);
    let boost = select(1.0, max(GX_MASK_BOOST_COUNT - held.z, 1.0), held.z < GX_MASK_BOOST_COUNT);
    return vec4<f32>(held.x, held.y * alpha / (2.0 - alpha) * boost, held.w, held.z);
}

// One a-trous step of `step` texels around `texel` (FidelityFX's 3x3 kernel 1, 2/3 at the step):
// the filtered visibility. Sky taps and taps off the screen take no weight.
fn gx_mask_atrous(texel: vec2<i32>, centre: vec4<f32>, step: i32) -> f32 {
    let deviation = max(sqrt(max(centre.y, 0.0)), gx_mask.spatial.z);
    let depth_sigma = max(gx_mask.spatial.x * centre.z * f32(step), 1e-6);
    var sum = centre.x;
    var weight_sum = 1.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let tap = texel + vec2<i32>(x, y) * step;
            let inside = all(tap >= vec2<i32>(0)) && all(tap < gx_mask_size());
            if (x == 0 && y == 0) || !inside {
                continue;
            }
            let held = textureLoad(gx_state, tap, 0);
            if held.w <= 0.0 {
                continue;
            }
            var w = select(GX_MASK_KERNEL_SIDE, 1.0, x == 0) * select(GX_MASK_KERNEL_SIDE, 1.0, y == 0);
            w *= exp(-abs(centre.x - held.x) / deviation - abs(centre.z - held.w) / depth_sigma);
            sum += w * held.x;
            weight_sum += w;
        }
    }
    return sum / weight_sum;
}

@fragment
fn fs_sun_mask_compose(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(position.xy);
    let centre = gx_mask_input(texel);
    var visibility = 1.0;
    if centre.z > 0.0 {
        visibility = gx_mask_atrous(texel, centre, select(1, 2, centre.w < GX_MASK_YOUNG_COUNT));
    }
    let contact_size = vec2<i32>(textureDimensions(gx_contact));
    let contact = textureLoad(gx_contact, min(texel * contact_size / gx_mask_size(), contact_size - vec2<i32>(1)), 0).r;
    return vec4<f32>(contact, clamp(visibility, 0.0, 1.0), 0.0, 0.0);
}
