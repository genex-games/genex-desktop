// TAA (graph node 17; RQ5.2): the jittered HDR scene at render size resolved against its
// rgba16float history (ping-pong). Per pixel:
// - dilation: the motion of the closest depth in the 3x3 neighbourhood (an edge moves with the
//   object in front of it);
// - history: Catmull-Rom (five bilinear taps) at uv - motion, rescaled by exposure now / exposure
//   then (pre-exposed space), so an exposure change never resets it;
// - variance clipping: the history clipped towards the neighbourhood's YCoCg mean inside
//   mean ± GX_TAA_VARIANCE_GAMMA σ, intersected with the neighbourhood's min/max;
// - rejection: off-screen history, depth disocclusion and the reactive mask take the current
//   frame, filtered around the unjittered pixel centre (a 3x3 Gaussian over the jittered taps), so
//   a rejected region neither aliases nor wobbles by the jitter; motion raises the current weight.
//   Disocclusion compares the history's depth key with the key this surface had last frame if it
//   stayed put (the camera's own motion through `reproject`), scaled over the neighbourhood's key
//   range: a camera dollying or turning keeps the history of every static surface;
// - accumulation: max(1 / (n + 1), alpha_min) after the history's reset (half alpha_min on a
//   still pixel), blended with weights 1 / (1 + max(luma - 1, 0)): display-range values average
//   exactly (a box filter over the jitter cycle), highlights cannot flicker; at the floor the
//   current sample is the filtered one.
// The output is this frame's history: rgb the resolved radiance, alpha the pixel's depth key
// (proportional to 1 / view depth under either depth convention), read by the next frame's
// disocclusion test. A full-screen fragment pass on every destination (no storage textures).

// Mirrors `post::taa::GpuTaaParams`.
struct TaaParams {
    // xy: the render size in pixels; zw: 1 / it.
    size: vec4<f32>,
    // xy: this frame's jitter in render pixels (x right, y down); zw: the previous frame's.
    jitter: vec4<f32>,
    // x: the accumulation floor (alpha_min); y: exposure now / exposure then; z: the disocclusion
    // tolerance (relative); w: the current weight per render pixel of motion.
    params: vec4<f32>,
    // x: frames since the history's reset (n); y: 1 when this frame resets it; z: 1 under
    // reverse-Z; w: flags (GX_TAA_FLAG_*).
    counts: vec4<u32>,
    // Last frame's unjittered view_proj × this frame's inverse: a pixel's NDC (x, y, device depth)
    // to where that point sat in last frame's clip space (identity: a still camera).
    reproject: mat4x4<f32>,
}

@group(0) @binding(0) var gx_scene: texture_2d<f32>;
@group(0) @binding(1) var gx_history: texture_2d<f32>;
@group(0) @binding(2) var gx_depth: texture_depth_2d;
@group(0) @binding(3) var gx_motion: texture_2d<f32>;
@group(0) @binding(4) var gx_reactive: texture_2d<f32>;
@group(0) @binding(5) var gx_linear: sampler;
@group(0) @binding(6) var<uniform> gx_taa: TaaParams;

// `post::taa::TaaFlags::CLIP`: clip the history to the neighbourhood's colour box.
const GX_TAA_FLAG_CLIP: u32 = 1u;
// `post::taa::VARIANCE_GAMMA`.
const GX_TAA_VARIANCE_GAMMA: f32 = 1.25;
// Luminance up to which samples blend with equal weight (pre-exposed display range).
const GX_TAA_LUMA_KNEE: f32 = 1.0;
// The rejected-pixel filter's falloff: exp(-k d^2) per tap at d render pixels from the unjittered
// centre (a Gaussian close to a 3.3-pixel Blackman-Harris, the common TAA reconstruction filter).
const GX_TAA_FILTER_FALLOFF: f32 = 2.29;
// The largest radiance the history keeps (half-float's largest finite value, rounded down).
const GX_TAA_RADIANCE_MAX: f32 = 64512.0;
// `post::taa::STILL_MOTION_PX` and `post::taa::STILL_ALPHA_SHARE`: a pixel whose (dilated) motion
// is under the first stands still, and its accumulation floor is alpha_min times the second.
const GX_TAA_STILL_MOTION_PX: f32 = 0.01;
const GX_TAA_STILL_ALPHA_SHARE: f32 = 0.5;

struct TaaOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_taa(@builtin(vertex_index) index: u32) -> TaaOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return TaaOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

fn gx_taa_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn gx_taa_ycocg(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}

fn gx_taa_rgb(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// Device depth as a key proportional to 1 / view depth: d under reverse-Z, 1 - d under standard Z.
fn gx_taa_depth_key(depth: f32) -> f32 {
    return select(1.0 - depth, depth, gx_taa.counts.z == 1u);
}

// A finite, non-negative radiance no larger than the history keeps (NaN reads 0).
fn gx_taa_sane(c: vec3<f32>) -> vec3<f32> {
    return select(vec3<f32>(0.0), min(c, vec3<f32>(GX_TAA_RADIANCE_MAX)), c >= vec3<f32>(0.0));
}

// The history at `uv` through Catmull-Rom (Jimenez's five bilinear taps; the corner taps of the
// 4x4 kernel are dropped), negative lobes clamped; alpha is the centre tap's depth key (bilinear:
// between two surfaces at an edge, which the key-range test accepts).
fn gx_taa_history_catmull_rom(uv: vec2<f32>) -> vec4<f32> {
    // The history's own size: after a dynamic-resolution step it is last frame's render size,
    // reprojected into this frame's in uv.
    let size = vec2<f32>(textureDimensions(gx_history));
    let texel = 1.0 / size;
    let position = uv * size;
    let center = floor(position - 0.5) + 0.5;
    let f = position - center;
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = -0.5 * f3 + f2 - 0.5 * f;
    let w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
    let w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    let w3 = 0.5 * f3 - 0.5 * f2;
    let w12 = w1 + w2;
    let tc0 = (center - 1.0) * texel;
    let tc12 = (center + w2 / w12) * texel;
    let tc3 = (center + 2.0) * texel;
    let a = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc12.x, tc0.y), 0.0).rgb * (w12.x * w0.y);
    let b = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc0.x, tc12.y), 0.0).rgb * (w0.x * w12.y);
    let centre = textureSampleLevel(gx_history, gx_linear, tc12, 0.0);
    let c = centre.rgb * (w12.x * w12.y);
    let d = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc3.x, tc12.y), 0.0).rgb * (w3.x * w12.y);
    let e = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc12.x, tc3.y), 0.0).rgb * (w12.x * w3.y);
    let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return vec4<f32>(max((a + b + c + d + e) / weight, vec3<f32>(0.0)), centre.a);
}

// `history` clipped towards the centre of the box [lo, hi] (YCoCg) along the line to it.
fn gx_taa_clip(history: vec3<f32>, lo: vec3<f32>, hi: vec3<f32>) -> vec3<f32> {
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

// What the 3x3 neighbourhood of the current frame tells the resolve.
struct Neighbourhood {
    // The centre sample.
    current: vec3<f32>,
    // The neighbourhood filtered around the unjittered pixel centre (rgb) and its weight (a).
    filtered: vec4<f32>,
    // The YCoCg colour box (mean ± gamma σ within min/max).
    lo: vec3<f32>,
    hi: vec3<f32>,
    // The pixel with the closest depth (dilation).
    closest: vec2<i32>,
    // The centre's depth key and the neighbourhood's key range.
    key: f32,
    key_lo: f32,
    key_hi: f32,
}

// One neighbour's contribution: its YCoCg colour folded into the sums and the box, its depth key
// into the key range and the closest surface (the largest key; a tie keeps the earlier tap).
fn gx_taa_tap(n: ptr<function, Neighbourhood>, sums: ptr<function, array<vec3<f32>, 2>>, at: vec2<i32>, offset: vec2<f32>) {
    let rgb = gx_taa_sane(textureLoad(gx_scene, at, 0).rgb);
    (*n).filtered += gx_taa_filter_tap(rgb, offset);
    let c = gx_taa_ycocg(rgb);
    (*sums)[0] += c;
    (*sums)[1] += c * c;
    (*n).lo = min((*n).lo, c);
    (*n).hi = max((*n).hi, c);
    let key = gx_taa_depth_key(textureLoad(gx_depth, at, 0));
    (*n).key_lo = min((*n).key_lo, key);
    let closer = key > (*n).key_hi;
    (*n).key_hi = max((*n).key_hi, key);
    (*n).closest = select((*n).closest, at, closer);
}

// One tap of the reconstruction filter: `rgb`, sampled `offset` pixels from the centre pixel,
// weighted by its distance from the unjittered pixel centre (the jittered sample of a tap at
// offset o shows the scene at o - jitter).
fn gx_taa_filter_tap(rgb: vec3<f32>, offset: vec2<f32>) -> vec4<f32> {
    let d = offset - gx_taa.jitter.xy;
    let w = exp(-GX_TAA_FILTER_FALLOFF * dot(d, d));
    return vec4<f32>(rgb * w, w);
}

fn gx_taa_neighbourhood(pixel: vec2<i32>, size: vec2<i32>) -> Neighbourhood {
    var n: Neighbourhood;
    var sums = array<vec3<f32>, 2>(vec3<f32>(0.0), vec3<f32>(0.0));
    let last = size - vec2<i32>(1);
    // The centre first: it seeds the box, the key range and the closest surface.
    n.current = gx_taa_sane(textureLoad(gx_scene, pixel, 0).rgb);
    n.filtered = gx_taa_filter_tap(n.current, vec2<f32>(0.0));
    let centre = gx_taa_ycocg(n.current);
    sums[0] = centre;
    sums[1] = centre * centre;
    n.lo = centre;
    n.hi = centre;
    n.key = gx_taa_depth_key(textureLoad(gx_depth, pixel, 0));
    n.key_lo = n.key;
    n.key_hi = n.key;
    n.closest = pixel;
    let lo = max(pixel - vec2<i32>(1), vec2<i32>(0));
    let hi = min(pixel + vec2<i32>(1), last);
    gx_taa_tap(&n, &sums, vec2<i32>(pixel.x, lo.y), vec2<f32>(0.0, -1.0));
    gx_taa_tap(&n, &sums, vec2<i32>(lo.x, pixel.y), vec2<f32>(-1.0, 0.0));
    gx_taa_tap(&n, &sums, vec2<i32>(hi.x, pixel.y), vec2<f32>(1.0, 0.0));
    gx_taa_tap(&n, &sums, vec2<i32>(pixel.x, hi.y), vec2<f32>(0.0, 1.0));
    gx_taa_tap(&n, &sums, lo, vec2<f32>(-1.0, -1.0));
    gx_taa_tap(&n, &sums, vec2<i32>(hi.x, lo.y), vec2<f32>(1.0, -1.0));
    gx_taa_tap(&n, &sums, vec2<i32>(lo.x, hi.y), vec2<f32>(-1.0, 1.0));
    gx_taa_tap(&n, &sums, hi, vec2<f32>(1.0, 1.0));
    let mean = sums[0] / 9.0;
    let sigma = sqrt(max(sums[1] / 9.0 - mean * mean, vec3<f32>(0.0)));
    n.lo = max(n.lo, mean - GX_TAA_VARIANCE_GAMMA * sigma);
    n.hi = min(n.hi, mean + GX_TAA_VARIANCE_GAMMA * sigma);
    return n;
}

// The depth key the surface at `uv` (depth key `key`) had last frame if it stayed where it is: its
// NDC position through `reproject` (the camera's own motion). A point at infinity (key 0) or one
// the reprojection cannot place keeps its key.
fn gx_taa_prev_key(uv: vec2<f32>, key: f32) -> f32 {
    let depth = select(1.0 - key, key, gx_taa.counts.z == 1u);
    let prev = gx_taa.reproject * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    if key <= 0.0 || abs(prev.w) < 1e-20 {
        return key;
    }
    return max(gx_taa_depth_key(prev.z / prev.w), 0.0);
}

// The weight a sample of luminance `luma` blends with: 1 in the display range, falling above it.
fn gx_taa_luma_weight(c: vec3<f32>) -> f32 {
    return 1.0 / (1.0 + max(gx_taa_luma(c) - GX_TAA_LUMA_KNEE, 0.0));
}

@fragment
fn fs_taa(in: TaaOut) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_scene));
    let pixel = clamp(vec2<i32>(in.clip.xy), vec2<i32>(0), size - vec2<i32>(1));
    let n = gx_taa_neighbourhood(pixel, size);
    // Sampled before any branch on the pixel's data (uniform control flow for the sampler).
    let motion = textureLoad(gx_motion, n.closest, 0).xy;
    let uv = (vec2<f32>(pixel) + 0.5) * gx_taa.size.zw;
    let prev_uv = uv - motion * vec2<f32>(0.5, -0.5);
    let history_sample = gx_taa_history_catmull_rom(prev_uv);
    let history_rgb = history_sample.rgb * gx_taa.params.y;
    let history_key = history_sample.a;
    let reactive = textureLoad(gx_reactive, pixel, 0).r;

    // The current frame's weight: the accumulation schedule, raised by motion and the mask.
    let frames = f32(gx_taa.counts.x);
    let average = 1.0 / (frames + 1.0);
    let motion_px = length(motion * 0.5 * gx_taa.size.xy);
    // A still pixel (a still camera on a still surface) averages over twice as many frames: its
    // jittered sample of a sub-pixel edge (a grass blade, a far tree tip against the sky) moves the
    // history by alpha times the edge's contrast every frame, which kept such edges flickering by
    // more than 3 levels (pass-1 gate finding 04). The colour box still clips what changes.
    let floor = select(gx_taa.params.x, gx_taa.params.x * GX_TAA_STILL_ALPHA_SHARE, motion_px < GX_TAA_STILL_MOTION_PX);
    var weight = max(average, floor);
    weight = max(weight, clamp(motion_px * gx_taa.params.w, 0.0, 1.0));
    weight = max(weight, clamp(reactive, 0.0, 1.0));
    let offscreen = any(prev_uv < vec2<f32>(0.0)) || any(prev_uv > vec2<f32>(1.0));
    let tolerance = gx_taa.params.z;
    // The neighbourhood's key range as it was last frame (the camera's motion scales every key of
    // a static surface by about the centre's ratio).
    let ratio = gx_taa_prev_key(uv, n.key) / max(n.key, 1e-20);
    let prev_lo = n.key_lo * select(ratio, 1.0, n.key <= 0.0);
    let prev_hi = n.key_hi * select(ratio, 1.0, n.key <= 0.0);
    let disoccluded = history_key > prev_hi * (1.0 + tolerance) + 1e-6 || history_key < prev_lo * (1.0 - tolerance) - 1e-6;
    let reset = gx_taa.counts.y == 1u;
    let rejected = offscreen || disoccluded;
    if reset || rejected {
        weight = 1.0;
    }
    // A rejected or reactive pixel takes the current frame filtered around its unjittered centre;
    // a reset keeps the raw sample, so a settled cycle is still an exact box over the jitter. Once
    // the accumulation sits at its floor (Live, long after the reset) every pixel takes the
    // filtered sample too: a raw jittered sample changes with the jitter at every edge, and the
    // floor's running average of it kept edges flickering by several levels under a still camera
    // (pass-1 gate finding 05).
    let filtered = n.filtered.rgb / max(n.filtered.a, 1e-6);
    let at_floor = average <= gx_taa.params.x && !reset;
    let unjittered = select(clamp(reactive, 0.0, 1.0), 1.0, (rejected && !reset) || at_floor);
    let current = mix(n.current, filtered, unjittered);

    var history = gx_taa_sane(history_rgb);
    if (gx_taa.counts.w & GX_TAA_FLAG_CLIP) != 0u {
        history = gx_taa_rgb(gx_taa_clip(gx_taa_ycocg(history), n.lo, n.hi));
    }
    let wc = weight * gx_taa_luma_weight(current);
    let wh = (1.0 - weight) * gx_taa_luma_weight(history);
    let resolved = (current * wc + history * wh) / max(wc + wh, 1e-6);
    return vec4<f32>(gx_taa_sane(resolved), n.key);
}
