// TAA upscaling at output size (renderer pass 2, B.8; T-05). Two full-screen fragment passes after
// Snapdragon Game Super Resolution v2's 2-pass fragment shader (sgsr2_convert.fs and
// sgsr2_upscale.fs, BSD-3-Clause, Copyright (c) 2023-2024 Qualcomm Innovation Center, Inc.), with the
// Lanczos-2 reconstruction, deringing and kernel bias of AMD FidelityFX FSR2 v1.1.4
// (ffx_fsr2_upsample.h; MIT, Copyright (C) 2024 Advanced Micro Devices, Inc.), and our TAA's
// disocclusion, exposure ratio and luma weighting (taa.wgsl):
//
// - convert (`fs_taau_convert`, render size): per render pixel the motion of the closest surface in
//   its 3x3 (the camera's own motion at the far plane where the whole neighbourhood is background,
//   T-03), the current frame's least weight (the reactive mask, or 1 where the history is
//   disoccluded: last frame's farthest key there lies nearer than the neighbourhood's closest key
//   as the camera moved it), and the 3x3's farthest depth key, which the next frame's convert reads
//   back for that test. Ping-pong at render size.
// - upscale (`fs_taau`, output size): the render sample nearest the output pixel's centre and its
//   four edge neighbours (SGSR2's five taps), each weighted by Lanczos-2 of its jittered distance to
//   that centre in render pixels times the kernel bias (`post::taau::kernel_bias`), deringed to the
//   taps' range; the four diagonal neighbours join the colour box (FSR2's 3x3: the five taps' box
//   clipped a diagonal edge's history to one side, a render-pixel staircase, D22) and the wider
//   kernel below (the sharp kernel's negative lobe over them, deringed to the 3x3, frayed the
//   edges). Where the clip moved the history (its shading changed: the water's caustics and
//   glints, a reactive or disoccluded pixel) the reconstruction leans to the fresh pixel's wider
//   kernel by as much (FSR2 lerps its kernel bias by its reactive factor), so a frame's samples
//   the history cannot keep land smooth, not as render-pixel blocks; the history (rgba16float at
//   output size: rgb the radiance, a the accumulated sample weight) read bilinearly at the
//   motion's previous position and clipped to the taps' box (linear
//   radiance, SGSR2: mean ± gamma σ inside min/max; gamma wide at rest, 1.25 from a render pixel of
//   motion). The history's weight grows by each frame's Lanczos weight up to 1 / alpha_min (to
//   GX_TAAU_MOVING_WEIGHT_MAX under motion, as SGSR2 caps it; twice that at rest), and the current sample blends in by
//   its share of it: a sample landing on the output pixel counts whole, one a render pixel away
//   little or negatively, so the jitter cycle's samples build the output's detail.
// Fixed taps written out (no loops): the loop forms cost twice as much at 4K (B.8 cost row).

// Mirrors `post::taau::GpuTaauParams`.
struct TaauParams {
    // xy: the render size; zw: 1 / it.
    render: vec4<f32>,
    // xy: the output size; zw: 1 / it.
    output: vec4<f32>,
    // xy: this frame's jitter in render pixels (x right, y down); zw: the previous frame's.
    jitter: vec4<f32>,
    // x: the accumulation floor (alpha_min); y: exposure now / exposure then; z: the disocclusion
    // tolerance; w: the current weight per render pixel of motion.
    params: vec4<f32>,
    // x: the Lanczos kernel bias at rest; y: on a fresh pixel; zw: unused.
    kernel: vec4<f32>,
    // x: frames since the history's reset; y: 1 when this frame resets it; z: 1 under reverse-Z;
    // w: flags in bits 0..7, the jitter cycle's phases from bit 8.
    counts: vec4<u32>,
    // Last frame's unjittered view_proj × this frame's inverse (identity: a still camera).
    reproject: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> gx_taau: TaauParams;
@group(0) @binding(1) var gx_linear: sampler;
// The convert pass's inputs (render size).
@group(1) @binding(0) var gx_depth: texture_depth_2d;
@group(1) @binding(1) var gx_motion: texture_2d<f32>;
@group(1) @binding(2) var gx_reactive: texture_2d<f32>;
@group(1) @binding(3) var gx_prev_convert: texture_2d<f32>;
// The upscale pass's inputs: the jittered scene and this frame's convert (render size), the
// history (output size).
@group(2) @binding(0) var gx_scene: texture_2d<f32>;
@group(2) @binding(1) var gx_convert: texture_2d<f32>;
@group(2) @binding(2) var gx_history: texture_2d<f32>;

// `post::taa::TaaFlags::CLIP`.
const GX_TAAU_FLAG_CLIP: u32 = 1u;
// `post::taau::HANDOVER_FLAG`: the history is TAA's last resolve (alpha its depth key).
const GX_TAAU_FLAG_HANDOVER: u32 = 128u;
// `post::taa::VARIANCE_GAMMA`: the moving box's half-size in standard deviations.
const GX_TAAU_VARIANCE_GAMMA: f32 = 1.25;
// Luminance up to which samples blend with equal weight (pre-exposed display range).
const GX_TAAU_LUMA_KNEE: f32 = 1.0;
// The largest radiance the history keeps (half-float's largest finite value, rounded down).
const GX_TAAU_RADIANCE_MAX: f32 = 64512.0;
// `post::taau::STILL_GAMMA` and `BOX_MOTION_PX`: a still pixel's box half-size in deviations (the
// taps' min/max bound it first), and the motion (render pixels) over which it narrows to
// GX_TAAU_VARIANCE_GAMMA.
const GX_TAAU_STILL_GAMMA: f32 = 8.0;
const GX_TAAU_BOX_MOTION_PX: f32 = 1.0;
// `post::taau::MOVING_WEIGHT_MAX` and `MOVING_PX`: the most accumulated weight a moving pixel's
// history keeps, reached at this much motion (render pixels).
const GX_TAAU_MOVING_WEIGHT_MAX: f32 = 3.0;
const GX_TAAU_MOVING_PX: f32 = 0.1;
// `post::taa::STILL_MOTION_PX` and `post::taa::STILL_ALPHA_SHARE`: a pixel moving under the first
// (render pixels) stands still, and its accumulation floor is alpha_min times the second.
const GX_TAAU_STILL_MOTION_PX: f32 = 0.05;
const GX_TAAU_STILL_ALPHA_SHARE: f32 = 0.5;
// `post::taau::LEAST_SAMPLE_WEIGHT`: a reconstruction whose Lanczos weights sum below this takes
// the nearest sample instead (all its taps fell on the kernel's negative lobe or its tail).
const GX_TAAU_LEAST_SAMPLE_WEIGHT: f32 = 0.05;
// `post::taau::SHADING_CHANGE_GAIN`: how far (in the box's half-extents, times this) the clip
// moved the history for the reconstruction to take the fresh pixel's kernel whole.
const GX_TAAU_SHADING_CHANGE_GAIN: f32 = 2.0;
// The taps of the 3x3 box.
const GX_TAAU_TAPS: f32 = 9.0;

struct TaauOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_taau(@builtin(vertex_index) index: u32) -> TaauOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return TaauOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

fn gx_taau_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn gx_taau_sane(c: vec3<f32>) -> vec3<f32> {
    return select(vec3<f32>(0.0), min(c, vec3<f32>(GX_TAAU_RADIANCE_MAX)), c >= vec3<f32>(0.0));
}

fn gx_taau_depth_key(depth: f32) -> f32 {
    return select(1.0 - depth, depth, gx_taau.counts.z == 1u);
}

fn gx_taau_luma_weight(c: vec3<f32>) -> f32 {
    return 1.0 / (1.0 + max(gx_taau_luma(c) - GX_TAAU_LUMA_KNEE, 0.0));
}

// FSR2's Lanczos2ApproxSq: Lanczos-2 of x from x², 0 from x = 2 on (FSR2 v1.1.4,
// ffx_fsr2_upsample.h; MIT).
fn gx_taau_lanczos2_sq(x2: f32) -> f32 {
    let x = min(x2, 4.0);
    let a = (2.0 / 5.0) * x - 1.0;
    let b = (1.0 / 4.0) * x - 1.0;
    return ((25.0 / 16.0) * a * a - (25.0 / 16.0 - 1.0)) * (b * b);
}

// ---------------------------------------------------------------------------------------------
// Convert (render size)

// The camera's own motion of the point at NDC `ndc` and device depth `depth`: where it sat in last
// frame's clip space (xy, NDC) and its previous depth key (z; the key itself at the far plane).
fn gx_taau_camera(ndc: vec2<f32>, key: f32) -> vec3<f32> {
    let depth = select(1.0 - key, key, gx_taau.counts.z == 1u);
    let prev = gx_taau.reproject * vec4<f32>(ndc, depth, 1.0);
    if abs(prev.w) < 1e-20 {
        return vec3<f32>(ndc, key);
    }
    let prev_key = select(max(gx_taau_depth_key(prev.z / prev.w), 0.0), key, key <= 0.0);
    return vec3<f32>(prev.xy / prev.w, prev_key);
}

// The 3x3's closest surface (the largest depth key; a tie keeps the earlier tap) and its key range.
struct DepthNeighbourhood {
    closest: vec2<i32>,
    hi: f32,
    lo: f32,
}

fn gx_taau_depth_tap(n: ptr<function, DepthNeighbourhood>, at: vec2<i32>) {
    let k = gx_taau_depth_key(textureLoad(gx_depth, at, 0));
    (*n).closest = select((*n).closest, at, k > (*n).hi);
    (*n).hi = max((*n).hi, k);
    (*n).lo = min((*n).lo, k);
}

@fragment
fn fs_taau_convert(in: TaauOut) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_depth));
    let pixel = clamp(vec2<i32>(in.clip.xy), vec2<i32>(0), size - vec2<i32>(1));
    // The 3x3's closest surface (largest key) and its farthest key.
    let key = gx_taau_depth_key(textureLoad(gx_depth, pixel, 0));
    var n: DepthNeighbourhood;
    n.closest = pixel;
    n.hi = key;
    n.lo = key;
    let lo = max(pixel - vec2<i32>(1), vec2<i32>(0));
    let hi = min(pixel + vec2<i32>(1), size - vec2<i32>(1));
    gx_taau_depth_tap(&n, vec2<i32>(pixel.x, lo.y));
    gx_taau_depth_tap(&n, vec2<i32>(lo.x, pixel.y));
    gx_taau_depth_tap(&n, vec2<i32>(hi.x, pixel.y));
    gx_taau_depth_tap(&n, vec2<i32>(pixel.x, hi.y));
    gx_taau_depth_tap(&n, lo);
    gx_taau_depth_tap(&n, vec2<i32>(hi.x, lo.y));
    gx_taau_depth_tap(&n, vec2<i32>(lo.x, hi.y));
    gx_taau_depth_tap(&n, hi);
    let closest = n.closest;
    let key_hi = n.hi;
    let key_lo = n.lo;
    let uv = (vec2<f32>(pixel) + 0.5) * gx_taau.render.zw;
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let camera = gx_taau_camera(ndc, key);
    let background = (ndc - camera.xy);
    let motion = select(textureLoad(gx_motion, closest, 0).xy, background, key_hi <= 0.0);
    // Disocclusion (taa.wgsl's test): last frame's farthest key at the previous position lies nearer
    // than the neighbourhood's closest key as the camera moved it.
    let prev_uv = uv - motion * vec2<f32>(0.5, -0.5);
    let prev_size = vec2<f32>(textureDimensions(gx_prev_convert));
    let prev_texel = clamp(vec2<i32>(floor(prev_uv * prev_size)), vec2<i32>(0), vec2<i32>(prev_size) - vec2<i32>(1));
    let prev = textureLoad(gx_prev_convert, prev_texel, 0);
    let ratio = camera.z / max(key, 1e-20);
    let prev_hi = key_hi * select(ratio, 1.0, key <= 0.0);
    let fresh_history = gx_taau.counts.y == 1u;
    let disoccluded = !fresh_history && prev.w > prev_hi * (1.0 + gx_taau.params.z) + 1e-6;
    let reactive = clamp(textureLoad(gx_reactive, pixel, 0).r, 0.0, 1.0);
    return vec4<f32>(motion, select(reactive, 1.0, disoccluded), key_lo);
}

// ---------------------------------------------------------------------------------------------
// Upscale (output size)

struct Reconstruction {
    // The Lanczos-weighted current colour (deringed) and the weights' sum, with the kernel at rest
    // and with the fresh pixel's (wider) kernel.
    colour: vec3<f32>,
    weight: f32,
    wide_colour: vec3<f32>,
    wide_weight: f32,
    // The taps' colour box: mean, deviation, min and max.
    mean: vec3<f32>,
    sigma: vec3<f32>,
    lo: vec3<f32>,
    hi: vec3<f32>,
}

// The running sums of the reconstruction's taps.
struct Taps {
    sum: vec4<f32>,
    wide: vec4<f32>,
    // The five taps' range (the sharp reconstruction's deringing).
    lo5: vec3<f32>,
    hi5: vec3<f32>,
    moments: vec3<f32>,
    squares: vec3<f32>,
    lo: vec3<f32>,
    hi: vec3<f32>,
}

// One tap: the render sample at `at`, `d` render pixels from the output pixel's centre, under the
// squared kernel biases `bias2` (x at rest or fresh, y the fresh pixel's); `edge`: one of the five
// taps of the sharp reconstruction (a diagonal one is not).
fn gx_taau_tap(taps: ptr<function, Taps>, at: vec2<i32>, d: vec2<f32>, bias2: vec2<f32>, edge: bool) -> vec3<f32> {
    let rgb = gx_taau_sane(textureLoad(gx_scene, at, 0).rgb);
    let w = select(0.0, gx_taau_lanczos2_sq(dot(d, d) * bias2.x), edge);
    let wide = gx_taau_lanczos2_sq(dot(d, d) * bias2.y);
    (*taps).sum += vec4<f32>(rgb * w, w);
    (*taps).wide += vec4<f32>(rgb * wide, wide);
    if edge {
        (*taps).lo5 = min((*taps).lo5, rgb);
        (*taps).hi5 = max((*taps).hi5, rgb);
    }
    (*taps).moments += rgb;
    (*taps).squares += rgb * rgb;
    (*taps).lo = min((*taps).lo, rgb);
    (*taps).hi = max((*taps).hi, rgb);
    return rgb;
}

// The render sample nearest the output pixel's centre `centre` (render pixels) at `base`, and its
// eight neighbours (FSR2's 3x3), each at its jittered position (render pixel i shows the scene at
// i + 0.5 - jitter), with kernel bias `bias` and the fresh pixel's `wide`. The box is in linear
// radiance (SGSR2).
fn gx_taau_reconstruct(base: vec2<i32>, centre: vec2<f32>, bias: f32, wide: f32) -> Reconstruction {
    let last = vec2<i32>(gx_taau.render.xy) - vec2<i32>(1);
    let lo_at = max(base - vec2<i32>(1), vec2<i32>(0));
    let hi_at = min(base + vec2<i32>(1), last);
    let d = vec2<f32>(base) + 0.5 - gx_taau.jitter.xy - centre;
    let bias2 = vec2<f32>(bias * bias, wide * wide);
    var taps: Taps;
    taps.lo = vec3<f32>(GX_TAAU_RADIANCE_MAX);
    taps.hi = vec3<f32>(0.0);
    taps.lo5 = taps.lo;
    taps.hi5 = taps.hi;
    let nearest = gx_taau_tap(&taps, base, d, bias2, true);
    gx_taau_tap(&taps, vec2<i32>(lo_at.x, base.y), d - vec2<f32>(1.0, 0.0), bias2, true);
    gx_taau_tap(&taps, vec2<i32>(hi_at.x, base.y), d + vec2<f32>(1.0, 0.0), bias2, true);
    gx_taau_tap(&taps, vec2<i32>(base.x, lo_at.y), d - vec2<f32>(0.0, 1.0), bias2, true);
    gx_taau_tap(&taps, vec2<i32>(base.x, hi_at.y), d + vec2<f32>(0.0, 1.0), bias2, true);
    gx_taau_tap(&taps, lo_at, d - vec2<f32>(1.0, 1.0), bias2, false);
    gx_taau_tap(&taps, vec2<i32>(hi_at.x, lo_at.y), d + vec2<f32>(1.0, -1.0), bias2, false);
    gx_taau_tap(&taps, vec2<i32>(lo_at.x, hi_at.y), d + vec2<f32>(-1.0, 1.0), bias2, false);
    gx_taau_tap(&taps, hi_at, d + vec2<f32>(1.0, 1.0), bias2, false);
    var r: Reconstruction;
    r.mean = taps.moments / GX_TAAU_TAPS;
    r.sigma = sqrt(max(taps.squares / GX_TAAU_TAPS - r.mean * r.mean, vec3<f32>(0.0)));
    r.lo = taps.lo;
    r.hi = taps.hi;
    r.weight = taps.sum.a;
    // Deringing (FSR2): the negative lobes may not take the reconstruction outside its taps.
    let reconstructed = clamp(taps.sum.rgb / max(taps.sum.a, 1e-6), taps.lo5, taps.hi5);
    r.colour = select(reconstructed, nearest, taps.sum.a < GX_TAAU_LEAST_SAMPLE_WEIGHT);
    r.wide_weight = taps.wide.a;
    let wide_reconstructed = clamp(taps.wide.rgb / max(taps.wide.a, 1e-6), taps.lo, taps.hi);
    r.wide_colour = select(wide_reconstructed, nearest, taps.wide.a < GX_TAAU_LEAST_SAMPLE_WEIGHT);
    return r;
}

// `history` clipped towards the centre of the box [lo, hi] along the line to it.
fn gx_taau_clip(history: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> vec3<f32> {
    let center = 0.5 * (hi + lo);
    let extent = max(0.5 * (hi - lo), vec3<f32>(1e-6));
    let offset = history - center;
    let units = abs(offset / extent);
    let most = max(units.x, max(units.y, units.z));
    if most > 1.0 {
        return center + offset / most;
    }
    return history;
}

@fragment
fn fs_taau(in: TaauOut) -> @location(0) vec4<f32> {
    let out_px = floor(in.clip.xy);
    let uv = (out_px + 0.5) * gx_taau.output.zw;
    // The output pixel's centre in render pixels, and the render pixel whose jittered sample lies
    // nearest it (sample i shows i + 0.5 - jitter).
    let centre = uv * gx_taau.render.xy;
    let render_size = vec2<i32>(gx_taau.render.xy);
    let base = clamp(vec2<i32>(floor(centre + gx_taau.jitter.xy)), vec2<i32>(0), render_size - vec2<i32>(1));
    let convert = textureLoad(gx_convert, base, 0);
    let motion = convert.xy;
    let prev_uv = uv - motion * vec2<f32>(0.5, -0.5);
    let edge = gx_taau.output.zw;
    let offscreen = any(prev_uv < -edge) || any(prev_uv > vec2<f32>(1.0) + edge);
    let reset = gx_taau.counts.y == 1u;
    let floor_weight = convert.z;
    let fresh = reset || offscreen || floor_weight >= 1.0;
    let bias = select(gx_taau.kernel.x, gx_taau.kernel.y, fresh);
    let r = gx_taau_reconstruct(base, centre, bias, gx_taau.kernel.y);
    var current = r.colour;
    if fresh {
        // A fresh pixel takes the current frame whole; its weight starts from its own samples.
        return vec4<f32>(current, max(r.weight, GX_TAAU_LEAST_SAMPLE_WEIGHT));
    }
    // Bilinear (SGSR2): Catmull-Rom cost 0.14 ms more at 4K, and the moving weight cap keeps the
    // pan's sharpness without it.
    let sampled = textureSampleLevel(gx_history, gx_linear, prev_uv, 0.0);
    var history = gx_taau_sane(sampled.rgb * gx_taau.params.y);
    // TAA's resolve handed over carries its depth key in alpha: it counts as the floor's whole
    // memory (TAA held its history at alpha_min).
    let handover = (gx_taau.counts.w & GX_TAAU_FLAG_HANDOVER) != 0u;
    let accumulated = select(max(sampled.a, 0.0), 1.0 / max(gx_taau.params.x, 1e-3), handover) * (1.0 - floor_weight);
    let motion_px = length(motion * 0.5 * gx_taau.render.xy);
    var sample_weight = max(r.weight, 0.0);
    if (gx_taau.counts.w & GX_TAAU_FLAG_CLIP) != 0u {
        // A still pixel clips to the taps' range alone: the render taps are coarser than the
        // output's detail, and a variance box over them clipped the detail the jitter cycle built
        // (SGSR2 widens its box by the upscale's area ratio cubed at rest). Motion brings the
        // variance box back over GX_TAAU_BOX_MOTION_PX render pixels.
        let gamma = mix(GX_TAAU_STILL_GAMMA, GX_TAAU_VARIANCE_GAMMA, saturate(motion_px / GX_TAAU_BOX_MOTION_PX));
        let lo = max(r.lo, r.mean - gamma * r.sigma);
        let hi = min(r.hi, r.mean + gamma * r.sigma);
        let clipped = gx_taau_sane(gx_taau_clip(history, lo, hi));
        // D22: how far the clip moved the history, in the box's half-extents: a shading change the
        // history cannot keep, whose samples the fresh pixel's kernel reconstructs.
        let extent = max(0.5 * (hi - lo), vec3<f32>(1e-4));
        let moved = abs(clipped - history) / extent;
        let change = saturate(max(moved.x, max(moved.y, moved.z)) * GX_TAAU_SHADING_CHANGE_GAIN);
        let shading = max(change, floor_weight);
        current = mix(r.colour, r.wide_colour, shading);
        sample_weight = mix(max(r.weight, 0.0), max(r.wide_weight, 0.0), shading);
        history = clipped;
    }
    // The history's weight: each frame adds its samples' Lanczos weight, up to 1 / alpha_min (less
    // per pixel of motion, as TAA's current weight), and to GX_TAAU_MOVING_WEIGHT_MAX on a moving
    // pixel: each frame resamples the history bilinearly, and over a longer memory the resampling
    // compounds into blur (B.8's pan row: 0.53 of native's sharpness at 8, 1.07 at 3).
    // A still pixel keeps twice the memory (taa.wgsl's still floor): the jitter cycle's phases weigh
    // unequally in a running average, and on detail at the render size's Nyquist limit the shorter
    // memory flickered (B.8's still row: 0.80% of pixels at alpha_min, 0.33% at half of it).
    let floor = gx_taau.params.x * select(1.0, GX_TAAU_STILL_ALPHA_SHARE, motion_px < GX_TAAU_STILL_MOTION_PX);
    let least = clamp(floor + motion_px * gx_taau.params.w, floor, 1.0);
    let most = mix(1.0 / least, GX_TAAU_MOVING_WEIGHT_MAX, saturate(motion_px / GX_TAAU_MOVING_PX));
    let total = min(accumulated + sample_weight, most);
    let alpha = select(1.0, clamp(sample_weight / total, 0.0, 1.0), total > 1e-6);
    let wc = alpha * gx_taau_luma_weight(current);
    let wh = (1.0 - alpha) * gx_taau_luma_weight(history);
    let resolved = (current * wc + history * wh) / max(wc + wh, 1e-6);
    return vec4<f32>(gx_taau_sane(resolved), total);
}
