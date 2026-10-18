// Bloom's downsample (graph node 19, RQ4.2): one mip of the chain from the one above it, starting
// from the pre-exposed HDR scene. The chain is sized from the output (renderer pass 2, P5), so the
// first downsample reads a scene of any render size by uv, its taps half a chain texel apart
// (`source.zw`, `post::bloom::first_tap_step`): its footprint on screen does not follow a DRS step.
// A scene more than twice the chain's size (1440p and up at scale 1, a phone's tall scene) is first
// filtered into a pre-level at twice the chain top's size (fs_bloom_prefilter*), so the first
// downsample never reads a scene more than twice its size and no texel falls between its taps (a
// small light would blink as it moved). Threshold-free by default: every pixel blooms by the
// energy-conserving blend in the tonemap (`mix(scene, bloom, intensity)`); a look's optional
// threshold is a soft knee on the first downsample only. Written by a fragment pass into
// `rgba16float`, never storage, so tile GPUs keep each mip in tile memory.
//
// The filter is Jimenez's 13-tap downsample (Next Generation Post Processing in Call of Duty:
// Advanced Warfare, SIGGRAPH 2014): 13 bilinear taps forming five overlapping 2x2 boxes, the
// centre box weighted 0.5 and the four corner boxes 0.125. On the first downsample each tap is
// also weighted by 1 / (1 + luma) and the sum normalized (Karis's average, per tap: a per-box
// weight cannot hold down a texel under the centre tap, which every corner box shares), so a single
// blinding texel does not flicker the glow from frame to frame. The multisampled entry
// (fs_bloom_down_msaa) reads the samples of the desktop MSAA scene the tonemap resolves in its own
// pass: the bilinear footprint of the chain texel's centre on the scene, each texel the mean of its
// samples, Karis-weighted the same way.

// Mirrors `post::bloom::GpuBloomParams`.
struct BloomParams {
    // xy: the source's size in texels; zw: the filter's tap spacing in uv (half a chain texel on
    // the first downsample, `post::bloom::first_tap_step`; one source texel after it).
    source: vec4<f32>,
    // x: intensity; y: threshold (0: none); z: reserved; w: the threshold's soft knee as a fraction
    // of it (`post::bloom::THRESHOLD_KNEE`).
    shape: vec4<f32>,
    // x: the mip written; y: mips in the chain; z: 1 on the first downsample (Karis, threshold); w: reserved.
    mip: vec4<u32>,
}

@group(0) @binding(0) var gx_bloom_source: texture_2d<f32>;
@group(0) @binding(1) var gx_bloom_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_bloom: BloomParams;
@group(0) @binding(3) var gx_bloom_msaa: texture_multisampled_2d<f32>;

// The largest radiance the scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX): an inf or
// NaN a custom pass wrote never spreads through the chain.
const GX_BLOOM_RADIANCE_MAX: f32 = 64512.0;

struct BloomOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_bloom(@builtin(vertex_index) index: u32) -> BloomOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: BloomOut;
    out.clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

fn gx_bloom_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Clamped to the stored range; `max` first so a NaN reads as 0.
fn gx_bloom_sane(c: vec3<f32>) -> vec3<f32> {
    return min(max(c, vec3<f32>(0.0)), vec3<f32>(GX_BLOOM_RADIANCE_MAX));
}

fn gx_bloom_tap(uv: vec2<f32>, offset: vec2<f32>) -> vec3<f32> {
    return gx_bloom_sane(textureSampleLevel(gx_bloom_source, gx_bloom_sampler, uv + offset * gx_bloom.source.zw, 0.0).rgb);
}

// The look's optional threshold as a quadratic soft knee (0: every pixel passes unchanged); the
// tonemap's gx_tm_bloom_part and `post::bloom::soft_threshold` are the same function.
fn gx_bloom_threshold(c: vec3<f32>) -> vec3<f32> {
    let threshold = gx_bloom.shape.y;
    if threshold <= 0.0 {
        return c;
    }
    let brightness = max(c.r, max(c.g, c.b));
    let knee = threshold * gx_bloom.shape.w;
    let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
    let contribution = max(soft * soft / (4.0 * knee + 1e-5), brightness - threshold);
    return c * (contribution / max(brightness, 1e-5));
}

// Karis's weight of one box.
fn gx_bloom_karis(c: vec3<f32>) -> f32 {
    return 1.0 / (1.0 + gx_bloom_luma(c));
}

@fragment
fn fs_bloom_down(in: BloomOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let a = gx_bloom_tap(uv, vec2<f32>(-2.0, -2.0));
    let b = gx_bloom_tap(uv, vec2<f32>(0.0, -2.0));
    let c = gx_bloom_tap(uv, vec2<f32>(2.0, -2.0));
    let d = gx_bloom_tap(uv, vec2<f32>(-2.0, 0.0));
    let e = gx_bloom_tap(uv, vec2<f32>(0.0, 0.0));
    let f = gx_bloom_tap(uv, vec2<f32>(2.0, 0.0));
    let g = gx_bloom_tap(uv, vec2<f32>(-2.0, 2.0));
    let h = gx_bloom_tap(uv, vec2<f32>(0.0, 2.0));
    let i = gx_bloom_tap(uv, vec2<f32>(2.0, 2.0));
    let j = gx_bloom_tap(uv, vec2<f32>(-1.0, -1.0));
    let k = gx_bloom_tap(uv, vec2<f32>(1.0, -1.0));
    let l = gx_bloom_tap(uv, vec2<f32>(-1.0, 1.0));
    let m = gx_bloom_tap(uv, vec2<f32>(1.0, 1.0));
    // The five boxes folded into per-tap weights: the centre box's taps 0.5 / 4, the shared centre
    // tap 4 x 0.125 / 4, the edge taps 2 x 0.125 / 4, the corner taps 0.125 / 4.
    if gx_bloom.mip.z == 0u {
        let sum = (j + k + l + m) * 0.125 + e * 0.125 + (b + d + f + h) * 0.0625 + (a + c + g + i) * 0.03125;
        return vec4<f32>(sum, 1.0);
    }
    // The first downsample: every tap Karis-weighted, normalized, then the optional threshold.
    let wj = vec4<f32>(gx_bloom_karis(j), gx_bloom_karis(k), gx_bloom_karis(l), gx_bloom_karis(m)) * 0.125;
    let we = gx_bloom_karis(e) * 0.125;
    let wb = vec4<f32>(gx_bloom_karis(b), gx_bloom_karis(d), gx_bloom_karis(f), gx_bloom_karis(h)) * 0.0625;
    let wa = vec4<f32>(gx_bloom_karis(a), gx_bloom_karis(c), gx_bloom_karis(g), gx_bloom_karis(i)) * 0.03125;
    var sum = j * wj.x + k * wj.y + l * wj.z + m * wj.w + e * we;
    sum += b * wb.x + d * wb.y + f * wb.z + h * wb.w + a * wa.x + c * wa.y + g * wa.z + i * wa.w;
    let total = dot(wj, vec4<f32>(1.0)) + we + dot(wb, vec4<f32>(1.0)) + dot(wa, vec4<f32>(1.0));
    return vec4<f32>(gx_bloom_threshold(sum / total), 1.0);
}

// One texel of the multisampled scene: the mean of its samples.
fn gx_bloom_msaa_texel(pixel: vec2<i32>) -> vec3<f32> {
    let size = vec2<i32>(gx_bloom.source.xy);
    let at = clamp(pixel, vec2<i32>(0), size - 1);
    let samples = textureNumSamples(gx_bloom_msaa);
    var sum = vec3<f32>(0.0);
    for (var s = 0u; s < samples; s++) {
        sum += gx_bloom_sane(textureLoad(gx_bloom_msaa, at, i32(s)).rgb);
    }
    return sum / f32(max(samples, 1u));
}

@fragment
fn fs_bloom_down_msaa(in: BloomOut) -> @location(0) vec4<f32> {
    // The bilinear footprint of the first mip's texel centre on the scene, by hand: multisampled
    // textures take no sampler.
    let p = in.uv * gx_bloom.source.xy - 0.5;
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    let t00 = gx_bloom_msaa_texel(base);
    let t10 = gx_bloom_msaa_texel(base + vec2<i32>(1, 0));
    let t01 = gx_bloom_msaa_texel(base + vec2<i32>(0, 1));
    let t11 = gx_bloom_msaa_texel(base + vec2<i32>(1, 1));
    let bilinear = vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    let w = bilinear * vec4<f32>(gx_bloom_karis(t00), gx_bloom_karis(t10), gx_bloom_karis(t01), gx_bloom_karis(t11));
    let mean = (t00 * w.x + t10 * w.y + t01 * w.z + t11 * w.w) / max(w.x + w.y + w.z + w.w, 1e-6);
    return vec4<f32>(gx_bloom_threshold(mean), 1.0);
}

// The pre-level (a scene more than twice the chain top's size): one level at twice the top's
// size, each texel the Karis-weighted mean of the scene texels under it. Up to twice its size
// (`footprint`, source texels per pre-level texel, at most 2: 1440p and 4K at scale 1) the four
// texels around its centre bilinearly, whose tents leave no texel between neighbours; above it (a
// phone's tall scene over its small chain) an area filter over every texel the footprint covers.
// `source.zw` is 1 / the pre-level's size here.

// Texels a side the area filter reads at most (a footprint of up to four texels).
const GX_BLOOM_AREA_TEXELS: i32 = 6;

fn gx_bloom_pre_footprint() -> vec2<f32> {
    return gx_bloom.source.xy * gx_bloom.source.zw;
}

// The bilinear texels and weights of `uv` on the source: the first texel, then the four weights.
fn gx_bloom_bilinear_at(uv: vec2<f32>) -> vec4<f32> {
    let p = uv * gx_bloom.source.xy - 0.5;
    let f = p - floor(p);
    return vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
}

fn gx_bloom_bilinear_base(uv: vec2<f32>) -> vec2<i32> {
    return vec2<i32>(floor(uv * gx_bloom.source.xy - 0.5));
}

// The share of texel `texel` the footprint `half_size` around `centre` covers.
fn gx_bloom_cover(texel: vec2<i32>, centre: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let cell = vec2<f32>(texel);
    let cover = max(min(cell + 1.0, centre + half_size) - max(cell, centre - half_size), vec2<f32>(0.0));
    return cover.x * cover.y;
}

// The area filter's first texel and texels a side.
fn gx_bloom_area_span(uv: vec2<f32>) -> vec4<i32> {
    let centre = uv * gx_bloom.source.xy;
    let half_size = gx_bloom_pre_footprint() * 0.5;
    let first = vec2<i32>(floor(centre - half_size));
    let span = min(vec2<i32>(ceil(centre + half_size)) - first, vec2<i32>(GX_BLOOM_AREA_TEXELS));
    return vec4<i32>(first, span);
}

fn gx_bloom_scene_texel(texel: vec2<i32>) -> vec3<f32> {
    let last = vec2<i32>(gx_bloom.source.xy) - 1;
    return gx_bloom_sane(textureLoad(gx_bloom_source, clamp(texel, vec2<i32>(0), last), 0).rgb);
}

@fragment
fn fs_bloom_prefilter(in: BloomOut) -> @location(0) vec4<f32> {
    var sum = vec3<f32>(0.0);
    var total = 0.0;
    if all(gx_bloom_pre_footprint() <= vec2<f32>(2.0)) {
        let base = gx_bloom_bilinear_base(in.uv);
        let w = gx_bloom_bilinear_at(in.uv);
        let at = array<vec2<i32>, 4>(base, base + vec2<i32>(1, 0), base + vec2<i32>(0, 1), base + vec2<i32>(1, 1));
        for (var i = 0; i < 4; i++) {
            let c = gx_bloom_scene_texel(at[i]);
            let weight = w[i] * gx_bloom_karis(c);
            sum += c * weight;
            total += weight;
        }
        return vec4<f32>(sum / max(total, 1e-6), 1.0);
    }
    let span = gx_bloom_area_span(in.uv);
    let centre = in.uv * gx_bloom.source.xy;
    let half_size = gx_bloom_pre_footprint() * 0.5;
    for (var y = 0; y < span.w; y++) {
        for (var x = 0; x < span.z; x++) {
            let texel = span.xy + vec2<i32>(x, y);
            let c = gx_bloom_scene_texel(texel);
            let weight = gx_bloom_cover(texel, centre, half_size) * gx_bloom_karis(c);
            sum += c * weight;
            total += weight;
        }
    }
    return vec4<f32>(sum / max(total, 1e-6), 1.0);
}

@fragment
fn fs_bloom_prefilter_msaa(in: BloomOut) -> @location(0) vec4<f32> {
    var sum = vec3<f32>(0.0);
    var total = 0.0;
    if all(gx_bloom_pre_footprint() <= vec2<f32>(2.0)) {
        let base = gx_bloom_bilinear_base(in.uv);
        let w = gx_bloom_bilinear_at(in.uv);
        let at = array<vec2<i32>, 4>(base, base + vec2<i32>(1, 0), base + vec2<i32>(0, 1), base + vec2<i32>(1, 1));
        for (var i = 0; i < 4; i++) {
            let c = gx_bloom_msaa_texel(at[i]);
            let weight = w[i] * gx_bloom_karis(c);
            sum += c * weight;
            total += weight;
        }
        return vec4<f32>(sum / max(total, 1e-6), 1.0);
    }
    let span = gx_bloom_area_span(in.uv);
    let centre = in.uv * gx_bloom.source.xy;
    let half_size = gx_bloom_pre_footprint() * 0.5;
    for (var y = 0; y < span.w; y++) {
        for (var x = 0; x < span.z; x++) {
            let texel = span.xy + vec2<i32>(x, y);
            let c = gx_bloom_msaa_texel(texel);
            let weight = gx_bloom_cover(texel, centre, half_size) * gx_bloom_karis(c);
            sum += c * weight;
            total += weight;
        }
    }
    return vec4<f32>(sum / max(total, 1e-6), 1.0);
}
