// TAA (graph node 17; RQ5.2): the jittered HDR scene at render size resolved against its
// rgba16float history (ping-pong). Per pixel:
// - dilation: the motion of the closest depth in the 3x3 neighbourhood (an edge moves with the
//   object in front of it); a neighbourhood of background alone moves with the camera at the far
//   plane through `reproject` (T-03);
// - history: Catmull-Rom (five bilinear taps) at uv - motion, held inside the four texels around
//   it (renderer pass 2, B.7: its overshoot, and the sharpening below, rang on sub-pixel detail
//   and compounded frame after frame into one-frame pops on every Lakeside path), rescaled by
//   exposure now / exposure then (pre-exposed space), so an exposure change never resets it;
// - rectification (renderer pass 2, P2-0.8a: S10 and T-02, after FidelityFX FSR 2.2, MIT): the
//   neighbourhood's colour box is built in reversibly tonemapped space c / (1 + max3(c)), YCoCg:
//   mean ± GX_TAA_VARIANCE_GAMMA σ inside the neighbourhood's min/max, so one bright pixel no
//   longer stretches it over everything beside a highlight. On a settled pixel (no motion of its
//   own, no reactive coverage) the box grows by the pixel's temporal noise (renderer pass 2, B.7:
//   how far its raw sample strays from the history the box keeps, a running mean in the lock
//   history's w) and a small floor, so a sub-pixel detail the jitter hits in some frames only, or
//   a sharp shadow mask's texel, no longer clips its history to each frame's box and back. History
//   outside it is clipped towards it softly: the clip is undone by how much the pixel is locked (a
//   thin feature, or an oscillation, seen within the last jitter cycle) or luma-unstable (its
//   quantised luma rose and fell over the last four frames), scaled by 1 - sqrt(reactive), motion
//   counting as reactive up to GX_TAA_MOTION_REACTIVE;
// - rejection: off-screen history (through a wider filter, GX_TAA_EDGE_FILTER_FALLOFF; B.7),
//   depth disocclusion and the reactive mask take the current
//   frame, filtered around the unjittered pixel centre (a 3x3 Gaussian over the jittered taps), so
//   a rejected region neither aliases nor wobbles by the jitter; motion raises the current weight.
//   Disocclusion: the history's depth key (last frame's farthest surface in the 3x3) lies nearer
//   than the closest key this neighbourhood had last frame if it stayed put (the camera's own
//   motion through `reproject`): a camera dollying or turning keeps the history of every static
//   surface, and a sub-pixel feature the jitter shows in some frames only never reads as one;
// - accumulation: max(1 / (n + 1), alpha_min) after the history's reset (half alpha_min on a
//   still pixel), blended with weights 1 / (1 + max(luma - 1, 0)): display-range values average
//   exactly (a box filter over the jitter cycle), highlights cannot flicker; at the floor the
//   current sample is the filtered one.
// The outputs are this frame's histories: the colour (rgb the resolved radiance, alpha the 3x3
// neighbourhood's farthest depth key, proportional to 1 / view depth under either depth
// convention, read by the next frame's disocclusion test), the last four frames' quantised luma
// (rgba8) and the lock (rgba8: its remaining lifetime / 2, the luma it was locked at, how
// recently the pixel moved and its temporal noise). A
// full-screen fragment pass on every destination (no storage textures).

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
    // reverse-Z; w: flags (GX_TAA_FLAG_*) in bits 0..7, the jitter cycle's frames in bits 8..15.
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
// Last frame's luma history (rgba8: x the newest) and lock (rgba8), at the history's size.
@group(0) @binding(7) var gx_luma_history: texture_2d<f32>;
@group(0) @binding(8) var gx_lock_history: texture_2d<f32>;

// `post::taa::TaaFlags::CLIP`: rectify the history against the neighbourhood's colour box.
const GX_TAA_FLAG_CLIP: u32 = 1u;
// `post::taa::TaaFlags::SETTLE`: a settled capture's cycle takes every raw sample with the box's
// weights while the accumulation is above its floor (R-12).
const GX_TAA_FLAG_SETTLE: u32 = 2u;
// `post::taa::HANDBACK_FLAG`: the history is TAA upscaling's last output (alpha a weight).
const GX_TAA_FLAG_HANDBACK: u32 = 128u;
// `post::taa::JITTER_CYCLE_SHIFT`: where `counts.w` keeps the jitter cycle's frames.
const GX_TAA_JITTER_CYCLE_SHIFT: u32 = 8u;
// `post::taa::VARIANCE_GAMMA`: the box's half-size in standard deviations.
const GX_TAA_VARIANCE_GAMMA: f32 = 1.25;
// Luminance up to which samples blend with equal weight (pre-exposed display range).
const GX_TAA_LUMA_KNEE: f32 = 1.0;
// The rejected-pixel filter's falloff: exp(-k d^2) per tap at d render pixels from the unjittered
// centre (a Gaussian close to a 3.3-pixel Blackman-Harris, the common TAA reconstruction filter).
const GX_TAA_FILTER_FALLOFF: f32 = 2.29;
// `post::taa::EDGE_FILTER_FALLOFF`: the wider filter a pixel whose history lies off the screen
// takes (what enters at the frame's edge has no history, and its sharp first sample popped).
const GX_TAA_EDGE_FILTER_FALLOFF: f32 = 0.8;
// The largest radiance the history keeps (half-float's largest finite value, rounded down).
const GX_TAA_RADIANCE_MAX: f32 = 64512.0;
// The tonemapped space's largest value the inverse divides by 1 - it (FSR 2.2's epsilon).
const GX_TAA_TONEMAP_EPSILON: f32 = 1.0 / 65504.0;
// `post::taa::STILL_MOTION_PX` and `post::taa::STILL_ALPHA_SHARE`: a pixel whose (dilated) motion
// is under the first stands still, and its accumulation floor is alpha_min times the second.
const GX_TAA_STILL_MOTION_PX: f32 = 0.05;
const GX_TAA_STILL_ALPHA_SHARE: f32 = 0.5;
// `post::taa::HISTORY_SHARPEN`: the history's sharpening against its outer taps where it fell
// halfway between texel centres (none on a centre), and `post::taa::SHARPEN_MOTION_PX`: the
// motion over which the sharpening fades in (none under the first).
const GX_TAA_HISTORY_SHARPEN: f32 = 0.15;
const GX_TAA_SHARPEN_MOTION_PX: vec2<f32> = vec2<f32>(0.05, 0.2);
// `post::taa::NOISE_RATE`, `NOISE_BOX_SCALE`, `NOISE_BOX_FLOOR`, `SETTLED_OWN_MOTION_PX`,
// `NOISE_RESET_OWN_MOTION_PX` and `NOISE_REACTIVE_CUT`: the temporal noise's running mean, how far
// it (and the floor) grows a settled pixel's colour box, the motion of its own over which a pixel
// stops counting as settled, the motion that clears its noise, and how fast reactive coverage
// takes the growth away.
const GX_TAA_NOISE_RATE: f32 = 0.15;
const GX_TAA_NOISE_BOX_SCALE: f32 = 3.0;
const GX_TAA_NOISE_BOX_FLOOR: f32 = 0.01;
const GX_TAA_SETTLED_OWN_MOTION_PX: vec2<f32> = vec2<f32>(0.15, 0.5);
const GX_TAA_NOISE_RESET_OWN_MOTION_PX: f32 = 0.3;
const GX_TAA_NOISE_REACTIVE_CUT: f32 = 8.0;
// `post::taa::NOISE_GROWTH_MOTION_PX`: the (dilated) motion over which the box's growth fades out.
const GX_TAA_NOISE_GROWTH_MOTION_PX: vec2<f32> = vec2<f32>(0.5, 1.5);
// `post::taa::NOISE_HOLD_REACH`: history this many growths outside the box (the first to the
// second) is clipped without the growth.
const GX_TAA_NOISE_HOLD_REACH: vec2<f32> = vec2<f32>(2.0, 4.0);
// `post::taa::LOCK_SIMILAR_RATIO`: two neighbours' lock lumas (perceived lightness of the
// tonemapped colour) are similar within this ratio (FSR 2.2's 1.05 on lightness^(1/6)).
const GX_TAA_LOCK_SIMILAR_RATIO: f32 = 1.3400956;
// `post::taa::LOCK_SHADING_CHANGE`: a lock whose shading luma changed by more than this share dies
// (and the change raises the reactive factor), as FSR 2.2's UpdateLockStatus.
const GX_TAA_LOCK_SHADING_CHANGE: f32 = 0.1;
// `post::taa::INSTABILITY_BOX_SIGMA`: the luma deviation at which a box counts as wide enough for
// luma instability to apply (FSR 2.2: pow(saturate(sigma / 0.1), 6)).
const GX_TAA_INSTABILITY_BOX_SIGMA: f32 = 0.1;
// The neighbourhood's flags above the nine similarity bits: a dissimilar neighbour darker, or
// brighter, than the centre was seen.
const GX_TAA_DARKER_SEEN: u32 = 1u << 9u;
const GX_TAA_BRIGHTER_SEEN: u32 = 1u << 10u;
// `post::taa::MOTION_REACTIVE`: the reactive factor a pixel moving a render pixel or more a frame
// counts as for its lock and luma instability (FSR 2.2's ComputeTemporalReactiveFactor).
const GX_TAA_MOTION_REACTIVE: f32 = 0.4;
// One step of an 8-bit luma.
const GX_TAA_UNORM_STEP: f32 = 1.0 / 255.0;

struct TaaOut {
    @builtin(position) clip: vec4<f32>,
}

// The resolve's three targets: the colour history, the luma history and the lock.
struct TaaTargets {
    @location(0) history: vec4<f32>,
    @location(1) luma: vec4<f32>,
    @location(2) lock: vec4<f32>,
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

// S10: radiance into the reversible tonemapped space the colour box lives in (FSR 2.2 Tonemap).
fn gx_taa_tonemap(c: vec3<f32>) -> vec3<f32> {
    return c / (max(max(c.r, c.g), max(c.b, 0.0)) + 1.0);
}

// The inverse of `gx_taa_tonemap` (FSR 2.2 InverseTonemap).
fn gx_taa_inverse_tonemap(c: vec3<f32>) -> vec3<f32> {
    return c / max(GX_TAA_TONEMAP_EPSILON, 1.0 - max(c.r, max(c.g, c.b)));
}

// The perceived lightness (L*, 0..1) of luminance `y`: what a thin feature's lock compares (FSR
// 2.2 RGBToPerceivedLuma; ComputeLockInputLuma takes it to the 1/6 power, which
// `GX_TAA_LOCK_SIMILAR_RATIO` folds in).
fn gx_taa_lightness(y: f32) -> f32 {
    if y <= 216.0 / 24389.0 {
        return y * (24389.0 / 27.0) * 0.01;
    }
    return (pow(y, 1.0 / 3.0) * 116.0 - 16.0) * 0.01;
}

// The luminance of perceived lightness `l` (0..1): the inverse of `gx_taa_lightness`, so the
// neighbours' lightness test runs on their luminance against two bounds the centre's sets.
fn gx_taa_lightness_luma(l: f32) -> f32 {
    let star = l * 100.0;
    if star <= 8.0 {
        return star * (27.0 / 24389.0);
    }
    let cube_root = (star + 16.0) / 116.0;
    return cube_root * cube_root * cube_root;
}

fn gx_taa_med3(a: f32, b: f32, c: f32) -> f32 {
    return max(min(a, b), min(max(a, b), c));
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
struct HistorySample {
    // The Catmull-Rom history (rgb) and the centre tap's depth key (a).
    value: vec4<f32>,
    // The mean of the four outer taps: the history's neighbourhood about a texel away.
    around: vec3<f32>,
    // How far between texel centres the sample fell: 0 on a centre, 1 halfway on both axes.
    between: f32,
    // The least and greatest of the four texels around the sample (its bilinear footprint): the
    // resampled and sharpened history stays inside them.
    footprint_lo: vec3<f32>,
    footprint_hi: vec3<f32>,
}

fn gx_taa_history_catmull_rom(uv: vec2<f32>) -> HistorySample {
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
    let ta = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc12.x, tc0.y), 0.0).rgb;
    let tb = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc0.x, tc12.y), 0.0).rgb;
    let centre = textureSampleLevel(gx_history, gx_linear, tc12, 0.0);
    let td = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc3.x, tc12.y), 0.0).rgb;
    let te = textureSampleLevel(gx_history, gx_linear, vec2<f32>(tc12.x, tc3.y), 0.0).rgb;
    let sum = ta * (w12.x * w0.y) + tb * (w0.x * w12.y) + centre.rgb * (w12.x * w12.y) + td * (w3.x * w12.y) + te * (w12.x * w3.y);
    let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    var out: HistorySample;
    out.value = vec4<f32>(max(sum / weight, vec3<f32>(0.0)), centre.a);
    out.around = 0.25 * (ta + tb + td + te);
    let off = f * (1.0 - f);
    out.between = 2.0 * (off.x + off.y);
    // The four texels the bilinear centre tap blends, one gather a channel (cheaper than four
    // loads: 0.42 against 0.44 ms a resolve at 1080p).
    let corner = (center + 0.5) * texel;
    let r = textureGather(0, gx_history, gx_linear, corner);
    let g = textureGather(1, gx_history, gx_linear, corner);
    let b = textureGather(2, gx_history, gx_linear, corner);
    out.footprint_lo = vec3<f32>(min(min(r.x, r.y), min(r.z, r.w)), min(min(g.x, g.y), min(g.z, g.w)), min(min(b.x, b.y), min(b.z, b.w)));
    out.footprint_hi = vec3<f32>(max(max(r.x, r.y), max(r.z, r.w)), max(max(g.x, g.y), max(g.z, g.w)), max(max(b.x, b.y), max(b.z, b.w)));
    out.value = vec4<f32>(clamp(out.value.rgb, out.footprint_lo, out.footprint_hi), out.value.a);
    return out;
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
    // S10: the taps' sum and sum of squares in tonemapped YCoCg, and their min/max.
    sum: vec3<f32>,
    squares: vec3<f32>,
    lo: vec3<f32>,
    hi: vec3<f32>,
    // T-02: the luminance range (tonemapped) whose perceived lightness is within
    // GX_TAA_LOCK_SIMILAR_RATIO of the centre's, and the neighbours inside it (bits 0..8 in FSR
    // 2.2's numbering: row by row from the top left, 4 the centre), with GX_TAA_DARKER_SEEN and
    // GX_TAA_BRIGHTER_SEEN set once a neighbour falls below or above it (lightness is monotonic in
    // luminance, so a centre with dissimilar neighbours on both sides is no ridge).
    similar_lo: f32,
    similar_hi: f32,
    similar: u32,
    // The pixel with the closest depth (dilation).
    closest: vec2<i32>,
    // The centre's depth key and the neighbourhood's key range.
    key: f32,
    key_lo: f32,
    key_hi: f32,
}

// The colour box (tonemapped YCoCg): the mean, the deviation, and mean ± gamma deviations inside
// the taps' min/max.
struct ColourBox {
    center: vec3<f32>,
    sigma: vec3<f32>,
    lo: vec3<f32>,
    hi: vec3<f32>,
}

// Tap `bit` (FSR 2.2's numbering) at `at`, `offset` pixels from the centre pixel: its colour into
// the filter and the box, its lightness against the centre's, its depth key into the key range and
// the closest surface (the largest key; a tie keeps the earlier tap). Answers its linear luma.
fn gx_taa_tap(n: ptr<function, Neighbourhood>, bit: u32, at: vec2<i32>, offset: vec2<f32>) -> f32 {
    let rgb = gx_taa_sane(textureLoad(gx_scene, at, 0).rgb);
    (*n).filtered += gx_taa_filter_tap(rgb, offset);
    let tonemapped = gx_taa_tonemap(rgb);
    let c = gx_taa_ycocg(tonemapped);
    (*n).sum += c;
    (*n).squares += c * c;
    (*n).lo = min((*n).lo, c);
    (*n).hi = max((*n).hi, c);
    let y = gx_taa_luma(tonemapped);
    let darker = select(0u, GX_TAA_DARKER_SEEN, y < (*n).similar_lo);
    let brighter = select(0u, GX_TAA_BRIGHTER_SEEN, y > (*n).similar_hi);
    let side = darker | brighter;
    (*n).similar |= select(side, 1u << bit, side == 0u);
    let key = gx_taa_depth_key(textureLoad(gx_depth, at, 0));
    (*n).key_lo = min((*n).key_lo, key);
    let closer = key > (*n).key_hi;
    (*n).key_hi = max((*n).key_hi, key);
    (*n).closest = select((*n).closest, at, closer);
    return gx_taa_luma(rgb);
}

// One tap of the reconstruction filter: `rgb`, sampled `offset` pixels from the centre pixel,
// weighted by its distance from the unjittered pixel centre (the jittered sample of a tap at
// offset o shows the scene at o - jitter).
fn gx_taa_filter_tap(rgb: vec3<f32>, offset: vec2<f32>) -> vec4<f32> {
    let d = offset - gx_taa.jitter.xy;
    let w = exp(-GX_TAA_FILTER_FALLOFF * dot(d, d));
    return vec4<f32>(rgb * w, w);
}

// The current frame around `pixel` filtered with falloff `k` about the unjittered pixel centre (the
// 3x3 neighbourhood, clamped at the frame's edges).
fn gx_taa_filtered_with(pixel: vec2<i32>, size: vec2<i32>, k: f32) -> vec3<f32> {
    var sum = vec4<f32>(0.0);
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let at = clamp(pixel + vec2<i32>(dx, dy), vec2<i32>(0), size - vec2<i32>(1));
            let rgb = gx_taa_sane(textureLoad(gx_scene, at, 0).rgb);
            let d = vec2<f32>(f32(dx), f32(dy)) - gx_taa.jitter.xy;
            let w = exp(-k * dot(d, d));
            sum += vec4<f32>(rgb * w, w);
        }
    }
    return sum.rgb / max(sum.a, 1e-6);
}

// The neighbourhood of `pixel`, and (w) the lock's shading luma: the median of the three rows'
// median linear luma, tonemapped, to the 1/6 power (FSR 2.2 reads it from a luma mip a thin
// feature does not reach; a one-pixel line, straight or diagonal, moves no row's median).
fn gx_taa_neighbourhood(n: ptr<function, Neighbourhood>, pixel: vec2<i32>, size: vec2<i32>) -> f32 {
    let last = size - vec2<i32>(1);
    // The centre seeds the box, the lightness test, the key range and the closest surface.
    let rgb = gx_taa_sane(textureLoad(gx_scene, pixel, 0).rgb);
    (*n).current = rgb;
    (*n).filtered = gx_taa_filter_tap(rgb, vec2<f32>(0.0));
    let tonemapped = gx_taa_tonemap(rgb);
    let c = gx_taa_ycocg(tonemapped);
    (*n).sum = c;
    (*n).squares = c * c;
    (*n).lo = c;
    (*n).hi = c;
    let lightness = gx_taa_lightness(gx_taa_luma(tonemapped));
    (*n).similar_lo = gx_taa_lightness_luma(lightness / GX_TAA_LOCK_SIMILAR_RATIO);
    (*n).similar_hi = gx_taa_lightness_luma(lightness * GX_TAA_LOCK_SIMILAR_RATIO);
    (*n).similar = 1u << 4u;
    (*n).key = gx_taa_depth_key(textureLoad(gx_depth, pixel, 0));
    (*n).key_lo = (*n).key;
    (*n).key_hi = (*n).key;
    (*n).closest = pixel;
    let lo = max(pixel - vec2<i32>(1), vec2<i32>(0));
    let hi = min(pixel + vec2<i32>(1), last);
    let a = gx_taa_tap(n, 1u, vec2<i32>(pixel.x, lo.y), vec2<f32>(0.0, -1.0));
    let b = gx_taa_tap(n, 3u, vec2<i32>(lo.x, pixel.y), vec2<f32>(-1.0, 0.0));
    let d = gx_taa_tap(n, 5u, vec2<i32>(hi.x, pixel.y), vec2<f32>(1.0, 0.0));
    let e = gx_taa_tap(n, 7u, vec2<i32>(pixel.x, hi.y), vec2<f32>(0.0, 1.0));
    let f = gx_taa_tap(n, 0u, lo, vec2<f32>(-1.0, -1.0));
    let g = gx_taa_tap(n, 2u, vec2<i32>(hi.x, lo.y), vec2<f32>(1.0, -1.0));
    let h = gx_taa_tap(n, 6u, vec2<i32>(lo.x, hi.y), vec2<f32>(-1.0, 1.0));
    let i = gx_taa_tap(n, 8u, hi, vec2<f32>(1.0, 1.0));
    let rows = vec3<f32>(gx_taa_med3(f, a, g), gx_taa_med3(b, gx_taa_luma(rgb), d), gx_taa_med3(h, e, i));
    let luma = max(gx_taa_med3(rows.x, rows.y, rows.z), 0.0);
    return pow(luma / (1.0 + luma), 1.0 / 6.0);
}

// S10: the colour box of the neighbourhood's tonemapped taps: mean ± GX_TAA_VARIANCE_GAMMA
// deviations, inside their min/max.
fn gx_taa_colour_box(n: ptr<function, Neighbourhood>) -> ColourBox {
    let center = (*n).sum / 9.0;
    let sigma = sqrt(max((*n).squares / 9.0 - center * center, vec3<f32>(0.0)));
    var colour_box: ColourBox;
    colour_box.center = center;
    colour_box.sigma = sigma;
    colour_box.lo = max((*n).lo, center - GX_TAA_VARIANCE_GAMMA * sigma);
    colour_box.hi = min((*n).hi, center + GX_TAA_VARIANCE_GAMMA * sigma);
    return colour_box;
}

// T-02: whether the centre is a thin feature (FSR 2.2 ComputeThinFeatureConfidence,
// ffx_fsr2_lock.h): its lightness is a ridge (above or below every dissimilar neighbour) and no
// 2x2 block around it is wholly similar to it.
fn gx_taa_thin_feature(n: ptr<function, Neighbourhood>) -> bool {
    let both_sides = GX_TAA_DARKER_SEEN | GX_TAA_BRIGHTER_SEEN;
    let ridge = ((*n).similar & both_sides) != both_sides;
    // The four 2x2 blocks holding the centre: upper left, upper right, lower left, lower right.
    let blocks = vec4<u32>(0x1bu, 0x36u, 0xd8u, 0x1b0u);
    let whole = (vec4<u32>((*n).similar) & blocks) == blocks;
    return ridge && !any(whole);
}

fn gx_taa_min_over_max(a: f32, b: f32) -> f32 {
    return select(min(a, b) / max(a, b), 1.0, max(a, b) <= 0.0);
}

// The lock this frame: its updated status (x: lifetime 0..2, y: the shading luma it holds) and how
// much it protects the history now (z), from last frame's `prev` (zero for a new sample).
// FSR 2.2's UpdateLockStatus (ffx_fsr2_postprocess_lock_status.h) and FinalizeLockStatus.
struct Lock {
    status: vec2<f32>,
    contribution: f32,
    // 1 - min/max of the held and the current shading luma.
    shading_change: f32,
}

fn gx_taa_lock(prev: vec2<f32>, new_lock: bool, shading: f32, reactive: f32, leaving: bool) -> Lock {
    var lifetime = prev.x;
    var held = select(prev.y, shading, prev.y == 0.0);
    let change = 1.0 - gx_taa_min_over_max(held, shading);
    if new_lock {
        held = shading;
        lifetime = select(1.0, 2.0, lifetime != 0.0);
    } else if lifetime <= 1.0 {
        held = mix(held, shading, 0.5);
    } else if change > GX_TAA_LOCK_SHADING_CHANGE {
        lifetime = 0.0;
    }
    let reactive_factor = max(reactive, saturate((change - GX_TAA_LOCK_SHADING_CHANGE) * 10.0));
    lifetime *= 1.0 - reactive_factor;
    var lock: Lock;
    lock.contribution = saturate(saturate((lifetime - 1.0) * 4.0) * saturate(gx_taa_min_over_max(held, shading)));
    lock.shading_change = change;
    // A lock lives one jitter cycle of frames, and dies where next frame's pixel leaves the screen.
    let cycle = max(f32(extractBits(gx_taa.counts.w, GX_TAA_JITTER_CYCLE_SHIFT, 8u)), 1.0);
    lifetime = select(max(lifetime - 1.0 / cycle, 0.0), 0.0, leaving);
    lock.status = vec2<f32>(lifetime, held);
    return lock;
}

// T-02: how unstable the pixel's luma is (FSR 2.2 ComputeLumaInstabilityFactor,
// ffx_fsr2_accumulate.h): 1 when this frame's quantised box-centre luma is closer to an older
// frame's on the same side than to last frame's (an oscillation) inside a wide enough box, 0
// otherwise, and the new luma history (x the newest).
struct Instability {
    factor: f32,
    history: vec4<f32>,
}

fn gx_taa_instability(prev: vec4<f32>, colour_box: ColourBox, reactive: f32) -> Instability {
    let luma = round(saturate(colour_box.center.x) * 255.0) / 255.0;
    // The four frame-to-frame steps, newest first. An oscillation rises and falls by more than a
    // quantisation step within them. FSR 2.2 asks instead whether this frame is closer to an older
    // frame on last frame's side than to last frame's, which reads a sub-pixel feature the jitter
    // missed twice running (or that came back a step past where it was) as stable, so its history
    // was clipped away until the next hit.
    let steps = vec4<f32>(luma, prev.x, prev.y, prev.z) - prev;
    let rises = any(steps > vec4<f32>(GX_TAA_UNORM_STEP));
    let falls = any(steps < vec4<f32>(-GX_TAA_UNORM_STEP));
    // The box's luma deviation, or the swing of the five frames' box-centre luma: a sub-pixel
    // feature the jitter misses in a frame leaves that frame's box flat, which FSR 2.2's box-only
    // test reads as stable (a feature in one tap moves the centre by a ninth of its contrast, so
    // the swing understates the taps' deviation).
    let swing = max(max(max(prev.x, prev.y), max(prev.z, prev.w)), luma) - min(min(min(prev.x, prev.y), min(prev.z, prev.w)), luma);
    let width = saturate(max(colour_box.sigma.x, swing) / GX_TAA_INSTABILITY_BOX_SIGMA);
    let width_cubed = width * width * width;
    let wide = width_cubed * width_cubed;
    let oscillates = rises && falls && wide > GX_TAA_UNORM_STEP;
    var instability: Instability;
    instability.history = vec4<f32>(luma, prev.x, prev.y, prev.z);
    // Only once four frames of luma are held (FSR 2.2: a zero oldest luma is none).
    instability.factor = select(0.0, 1.0 - pow(saturate(reactive), 1.0 / 6.0), oscillates && prev.w != 0.0);
    return instability;
}

// The depth key the surface at `uv` (depth key `key`) had last frame if it stayed where it is: its
// NDC position through `reproject` (the camera's own motion). A point at infinity (key 0) or one
// the reprojection cannot place keeps its key.
// Also (yz) how far, in render pixels (x right, y up), the camera's own motion moved that point
// since last frame (a point at infinity included: the background's motion, T-03).
fn gx_taa_prev_key(uv: vec2<f32>, key: f32) -> vec3<f32> {
    let depth = select(1.0 - key, key, gx_taa.counts.z == 1u);
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let prev = gx_taa.reproject * vec4<f32>(ndc, depth, 1.0);
    if abs(prev.w) < 1e-20 {
        return vec3<f32>(key, 0.0, 0.0);
    }
    let moved = (ndc - prev.xy / prev.w) * 0.5 * gx_taa.size.xy;
    if key <= 0.0 {
        return vec3<f32>(key, moved);
    }
    return vec3<f32>(max(gx_taa_depth_key(prev.z / prev.w), 0.0), moved);
}

// The weight a sample of luminance `luma` blends with: 1 in the display range, falling above it.
fn gx_taa_luma_weight(c: vec3<f32>) -> f32 {
    return 1.0 / (1.0 + max(gx_taa_luma(c) - GX_TAA_LUMA_KNEE, 0.0));
}

// The texel of a side history (`size` texels) that `uv` falls in.
fn gx_taa_side_texel(uv: vec2<f32>, size: vec2<u32>) -> vec2<i32> {
    let texel = vec2<i32>(floor(uv * vec2<f32>(size)));
    return clamp(texel, vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
}

@fragment
fn fs_taa(in: TaaOut) -> TaaTargets {
    let size = vec2<i32>(textureDimensions(gx_scene));
    let pixel = clamp(vec2<i32>(in.clip.xy), vec2<i32>(0), size - vec2<i32>(1));
    var n: Neighbourhood;
    let shading = gx_taa_neighbourhood(&n, pixel, size);
    let uv = (vec2<f32>(pixel) + 0.5) * gx_taa.size.zw;
    // Where the centre's surface sat last frame had it stayed put (the camera's own motion), and
    // how far the camera moved it in render pixels.
    let camera = gx_taa_prev_key(uv, n.key);
    // Dilated motion: the closest surface's in the 3x3. Where the whole neighbourhood is the
    // background (its closest key 0: the sky, the sun disc, the fog horizon) it is the camera's
    // own motion at the far plane, the centre's (renderer pass 2, P2-0.8b T-03, after Bevy's
    // background motion vectors), so a turning camera reprojects the sky instead of leaning on
    // the colour box. A select, not a branch: measured cheaper (0.015 ms against 0.025 ms at 1080p).
    let motion = select(textureLoad(gx_motion, n.closest, 0).xy, camera.yz * 2.0 * gx_taa.size.zw, n.key_hi <= 0.0);
    let prev_uv = uv - motion * vec2<f32>(0.5, -0.5);
    let resampled = gx_taa_history_catmull_rom(prev_uv);
    let history_sample = resampled.value;
    let history_key = history_sample.a;
    let reactive = clamp(textureLoad(gx_reactive, pixel, 0).r, 0.0, 1.0);
    let prev_luma = textureLoad(gx_luma_history, gx_taa_side_texel(prev_uv, textureDimensions(gx_luma_history)), 0);
    let prev_lock = textureLoad(gx_lock_history, gx_taa_side_texel(prev_uv, textureDimensions(gx_lock_history)), 0);

    // The current frame's weight: the accumulation schedule, raised by motion and the mask.
    let frames = f32(gx_taa.counts.x);
    let average = 1.0 / (frames + 1.0);
    let motion_px = length(motion * 0.5 * gx_taa.size.xy);
    // The history resampled between texel centres is sharpened back by how far between them it
    // fell: each frame of motion resamples it, and the losses compound over its memory. Not under
    // a creep: there it fed back on itself frame after frame and an edge's history rang (B.7: the
    // bench-outdoor lake box flickered on 323 pixels creeping against 21 still at high).
    let sharpen = GX_TAA_HISTORY_SHARPEN * resampled.between * smoothstep(GX_TAA_SHARPEN_MOTION_PX.x, GX_TAA_SHARPEN_MOTION_PX.y, motion_px);
    // In the box's reversibly tonemapped space (D22): in linear radiance a bulb's or a lantern
    // glass's highlight beside a dark texel drove the sharpening of its neighbour down to the
    // footprint's darkest, a dark fringe around every bright light in a pan.
    let history_t = gx_taa_tonemap(gx_taa_sane(history_sample.rgb));
    let around_t = gx_taa_tonemap(gx_taa_sane(resampled.around));
    let sharpened_t = clamp(history_t + sharpen * (history_t - around_t), vec3<f32>(0.0), vec3<f32>(1.0 - GX_TAA_TONEMAP_EPSILON));
    // A still pixel (no sharpening) keeps its history bit for bit.
    let sharpened = select(history_sample.rgb, gx_taa_inverse_tonemap(sharpened_t), sharpen > 0.0);
    let history_rgb = clamp(sharpened, resampled.footprint_lo, resampled.footprint_hi) * gx_taa.params.y;
    // A still pixel (a still camera on a still surface) averages over twice as many frames: its
    // jittered sample of a sub-pixel edge (a grass blade, a far tree tip against the sky) moves the
    // history by alpha times the edge's contrast every frame, which kept such edges flickering by
    // more than 3 levels (pass-1 gate finding 04). The colour box still clips what changes.
    let floor = select(gx_taa.params.x, gx_taa.params.x * GX_TAA_STILL_ALPHA_SHARE, motion_px < GX_TAA_STILL_MOTION_PX);
    var weight = max(average, floor);
    weight = max(weight, clamp(motion_px * gx_taa.params.w, 0.0, 1.0));
    weight = max(weight, reactive);
    // History up to a texel past the frame's edge is read clamped to it (renderer pass 2, B.7): on
    // a camera turning about a pitched axis an edge row's history falls just outside the frame on
    // some frames and not others, and taking the current sample on those popped the frame's bottom
    // row (about 100 pixels of every Lakeside pan's pops). Farther out the history is rejected.
    let edge = gx_taa.size.zw;
    let offscreen = any(prev_uv < -edge) || any(prev_uv > vec2<f32>(1.0) + edge);
    let tolerance = gx_taa.params.z;
    // The neighbourhood's closest key as it was last frame (the camera's motion scales every key of
    // a static surface by about the centre's ratio). The history is disoccluded when even the
    // farthest surface of last frame's neighbourhood lies nearer than that: what stood in front
    // went away. A surface that came in front is left to the colour box: a sub-pixel feature the
    // jitter hits in some frames only would otherwise read as one every time it shows (renderer
    // pass 2, P2-0.8a: compared both ways, the far tree line flickered on 0.094% of a still frame
    // at high against 0.013%).
    let ratio = camera.x / max(n.key, 1e-20);
    let prev_hi = n.key_hi * select(ratio, 1.0, n.key <= 0.0);
    let handback = (gx_taa.counts.w & GX_TAA_FLAG_HANDBACK) != 0u;
    let disoccluded = !handback && history_key > prev_hi * (1.0 + tolerance) + 1e-6;
    let reset = gx_taa.counts.y == 1u;
    let rejected = offscreen || disoccluded;
    let fresh = reset || rejected;
    if fresh {
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
    // R-12: a capture's settling cycle (nothing moves across it) keeps every raw sample and the
    // box's weights: its reset frame's no-history coverage took the filtered sample, which shrank
    // that frame's share of a one-sample dither towards its neighbours' (the crossfade's stipple).
    // Its history is rectified (`GX_TAA_FLAG_CLIP`) only while auto exposure meters the first
    // frames, drawn at another pre-exposure (`Renderer::taa_row`).
    let settling = (gx_taa.counts.w & GX_TAA_FLAG_SETTLE) != 0u && !at_floor;
    let unjittered = select(select(reactive, 1.0, (rejected && !reset) || at_floor), 0.0, settling);
    if settling && !reset {
        weight = average;
    }
    var current = mix(n.current, filtered, unjittered);
    // B.7: a pixel whose history lies off the screen takes a wider filter (only there: a branch
    // the frame's interior never takes).
    if offscreen && !reset {
        current = gx_taa_filtered_with(pixel, size, GX_TAA_EDGE_FILTER_FALLOFF);
    }

    // T-02: the lock and the luma instability, from last frame's (none for a new sample).
    var colour_box = gx_taa_colour_box(&n);
    // B.7: the pixel's temporal noise, how far its raw sample strays from the history the box
    // keeps (a ghost the box clips away never raises it), and the box grown by last frame's noise
    // where the pixel is settled: its surface has no motion of its own beyond the camera's (at the
    // closest surface, as the dilation reads it) and no reactive coverage. A surface moving over
    // the pixel, or a history reset, clears its noise, and history far outside the
    // grown box (a whole surface gone, not a detail the jitter missed) is clipped as before.
    let history_box = gx_taa_ycocg(gx_taa_tonemap(gx_taa_sane(history_rgb)));
    let kept = gx_taa_clip(history_box, colour_box.lo, colour_box.hi);
    let noise_now = abs(gx_taa_ycocg(gx_taa_tonemap(n.current)).x - kept.x);
    let prev_noise = select(prev_lock.w, 0.0, fresh);
    let noise = mix(prev_noise, noise_now, GX_TAA_NOISE_RATE);
    let closest_uv = (vec2<f32>(n.closest) + 0.5) * gx_taa.size.zw;
    let own_px = length(motion * 0.5 * gx_taa.size.xy - gx_taa_prev_key(closest_uv, n.key_hi).yz);
    let unmoved = 1.0 - smoothstep(GX_TAA_SETTLED_OWN_MOTION_PX.x, GX_TAA_SETTLED_OWN_MOTION_PX.y, own_px);
    // Only once the accumulation sits at its floor (Live): a capture's settling cycle keeps the
    // plain box, so a settled capture is the jitter cycle's mean as before.
    // D22: and not under a pan, where the growth held one surface's history over a noisy
    // neighbour's (a post's edge over the water's bands).
    let still = 1.0 - smoothstep(GX_TAA_NOISE_GROWTH_MOTION_PX.x, GX_TAA_NOISE_GROWTH_MOTION_PX.y, motion_px);
    let settled = unmoved * still * (1.0 - saturate(reactive * GX_TAA_NOISE_REACTIVE_CUT)) * select(0.0, 1.0, at_floor);
    let growth = (GX_TAA_NOISE_BOX_SCALE * prev_noise + GX_TAA_NOISE_BOX_FLOOR) * settled;
    let excursion = abs(history_box.x - kept.x);
    let holds = 1.0 - smoothstep(GX_TAA_NOISE_HOLD_REACH.x * growth, GX_TAA_NOISE_HOLD_REACH.y * growth, excursion);
    let grow = vec3<f32>(growth * holds);
    colour_box.lo -= grow;
    colour_box.hi += grow;
    // A moving pixel's protection is cut as FSR 2.2's temporal reactive factor cuts it: towards
    // GX_TAA_MOTION_REACTIVE at a render pixel of motion, its own or the camera's, so a lock or an
    // oscillation does not hold history the motion smeared.
    let moving = max(motion_px, length(camera.yz));
    // How recently the pixel moved (1 this frame at a render pixel of motion, falling to 0 over a
    // jitter cycle): an object passing over a still pixel rises and falls in its luma like a
    // sub-pixel feature the jitter hits now and then, and its history must not be held after it
    // left (a moving cube left a trail of 430 pixels otherwise).
    let cycle = max(f32(extractBits(gx_taa.counts.w, GX_TAA_JITTER_CYCLE_SHIFT, 8u)), 1.0);
    let moved = max(saturate(moving), select(prev_lock.z, 0.0, fresh) - 1.0 / cycle);
    let temporal_reactive = max(max(reactive, GX_TAA_MOTION_REACTIVE * saturate(moving)), moved);
    let instability = gx_taa_instability(select(prev_luma, vec4<f32>(0.0), fresh), colour_box, temporal_reactive);
    // A thin feature locks the pixel, and so does an oscillation: a feature the jitter shows in one
    // or two frames of the cycle leaves runs of flat frames longer than the luma history holds,
    // and the lock carries its protection over them for a cycle.
    let locks = gx_taa_thin_feature(&n) || instability.factor > 0.0;
    let lock = gx_taa_lock(select(prev_lock.xy * vec2<f32>(2.0, 1.0), vec2<f32>(0.0), fresh), locks, shading, temporal_reactive, offscreen);

    var history = gx_taa_sane(history_rgb);
    if (gx_taa.counts.w & GX_TAA_FLAG_CLIP) != 0u {
        // S10: rectified in the tonemapped space the box was built in, then brought back.
        let tonemapped = gx_taa_ycocg(gx_taa_tonemap(history));
        let clipped = gx_taa_clip(tonemapped, colour_box.lo, colour_box.hi);
        // T-02: a locked or luma-unstable pixel keeps its history where the box would clip it.
        let protection = saturate(max(instability.factor, lock.contribution) * (1.0 - sqrt(temporal_reactive)));
        history = gx_taa_sane(gx_taa_inverse_tonemap(gx_taa_rgb(mix(clipped, tonemapped, protection))));
    }
    let wc = weight * gx_taa_luma_weight(current);
    let wh = (1.0 - weight) * gx_taa_luma_weight(history);
    let resolved = (current * wc + history * wh) / max(wc + wh, 1e-6);
    var out: TaaTargets;
    out.history = vec4<f32>(gx_taa_sane(resolved), n.key_lo);
    out.luma = instability.history;
    let cleared = reset || own_px > GX_TAA_NOISE_RESET_OWN_MOTION_PX;
    out.lock = vec4<f32>(lock.status.x * 0.5, lock.status.y, max(moved, 0.0), select(saturate(noise), 0.0, cleared));
    return out;
}
