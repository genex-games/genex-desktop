// The tonemap (graph node 21, RQ1.1): the HDR scene, already multiplied by its exposure
// (pre-exposed, so nothing here divides by it), mapped to display colour by the look's curve and
// sRGB-encoded into the world target with a frame-keyed dither of at most half a level, or into
// the rgb10a2unorm intermediate an upscale reads (no dither: the final write adds it).
//
// The curve is the pipeline's `GX_TONEMAPPER` override, `Tonemapper::shader_id`: 0 Khronos PBR
// Neutral (the legacy-preserving default), 1 AgX, 2 Hill's ACES fit, 3 none (a clamp, encoded
// as the legacy forward shader encodes), 4 AgX with the punchy look (Wrensch's `agxLook`,
// Blender's "Punchy": power 1.35 and saturation 1.4 in AgX's log space). tests/layout.rs emits every value
// through HLSL, MSL and SPIR-V. The curves are ported from three.js 0.185's tonemapping shader chunk
// (MIT, Copyright 2010-2026 three.js authors): Khronos PBR Neutral (Khronos Group, Emmett Lalish),
// AgX (Troy Sobotka; the minimal fit of Benjamin Wrensch, iolite; Filament's Rec. 2020 port) and
// Stephen Hill's ACES fit (ACES RRT + ODT, with three's 1 / 0.6 brighter-viewing scale). Every
// curve's output is dithered, `none` too: an HDR scene through a clamp bands like any other.
//
// Entry points, one per way the scene reaches the curve:
// - fs_tonemap: the 1x scene, one texel per pixel (scale 1);
// - fs_tonemap_msaa: the multisampled scene through the luminance-weighted resolve (desktop
//   classes at scale 1: the resolve is fused into this pass);
// - fs_tonemap_bilinear: the 1x scene stretched bilinearly (below scale 1 on `low`: tonemap and
//   upscale are one pass);
// - fs_tonemap_bilinear_msaa: the same over weighted-resolved texels (desktop `low` with MSAA);
// - fs_tonemap_sharpen: five bilinear taps through the curve and a contrast-adaptive sharpen in the
//   manner of FSR 1's RCAS (the stand-in for EASU + RCAS in a build without FSR1; RQ5.6 draws
//   medium and above through fsr.rs instead).
// Every bilinear filter weights its four texels by 1 / (1 + luma) (Karis) and maps the mean back,
// as the resolve does: linear HDR interpolation lets one blinding texel swamp the dark detail
// beside it (a lantern's frame against its glass).
//
// Bloom (RQ4.2) composites before the curve in every entry point: `mix(scene, bloom, intensity)`
// with the chain's top (bloom_down/bloom_up.wgsl, every mip's blur summed) scaled by 1 / mips, so
// the frame keeps its energy. Intensity 0 (no bloom: a neutral black texture is bound) skips it,
// so the picture is byte for byte the bloom-free one. Under a look's stylistic threshold the chain
// holds only the over-threshold part, so that part is traded for the glow and the rest is kept:
// `scene + (bloom - part(scene)) * intensity` (a lerp would darken everything below it).

override GX_TONEMAPPER: u32 = 0u;

struct GxTonemapParams {
    // xy: the source's size in texels (the render size); zw: 1 / it.
    source: vec4<f32>,
    // xy: the target's size in pixels; zw: 1 / it.
    output: vec4<f32>,
    // x: the dither amplitude in encoded units (0: none); y: the sharpness (0..1); z: bloom's
    // intensity (0: no bloom); w: the bloom chain's scale (1 / mips).
    shape: vec4<f32>,
    // x: the frame index the dither is keyed to.
    frame: vec4<u32>,
    // x: bloom's stylistic threshold (0: none, the lerp); y: its soft knee as a fraction of it.
    bloom: vec4<f32>,
    // xyz: the look's white-balance gains (luminance-normalised; 1 each leaves the scene as it is).
    balance: vec4<f32>,
}

@group(0) @binding(0) var gx_hdr_scene: texture_2d<f32>;
@group(0) @binding(1) var gx_tm_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_tm: GxTonemapParams;
@group(0) @binding(3) var gx_hdr_msaa: texture_multisampled_2d<f32>;
// The bloom chain's top (`post::bloom::TONEMAP_BLOOM_BINDING`), read through the filtering sampler.
@group(0) @binding(4) var gx_bloom_chain: texture_2d<f32>;

// RCAS's lobe limit (0.25 - 1/16): the sharpen never inverts a neighbourhood.
const GX_TM_LOBE_LIMIT: f32 = 0.1875;
// AgX's log2 range: log2(2^-10 * 0.18) and log2(2^6.5 * 0.18).
const GX_AGX_MIN_EV: f32 = -12.47393;
const GX_AGX_MAX_EV: f32 = 4.026069;
// The largest radiance the scene stores (lighting/output.wgsl's GX_SCENE_RADIANCE_MAX): an inf a
// custom pass wrote reads as it, never as NaN through the curve or the weighted resolve.
const GX_TM_RADIANCE_MAX: f32 = 64512.0;
// Khronos PBR Neutral: where highlight compression starts, and how far compressed highlights desaturate.
const GX_NEUTRAL_START: f32 = 0.76;
const GX_NEUTRAL_DESATURATION: f32 = 0.15;

struct GxTonemapOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_tonemap(@builtin(vertex_index) index: u32) -> GxTonemapOut {
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: GxTonemapOut;
    out.clip = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
    out.uv = corner;
    return out;
}

fn gx_tm_aces(color: vec3<f32>) -> vec3<f32> {
    // sRGB => XYZ => D65_2_D60 => AP1 => RRT_SAT (columns, as three's GLSL).
    let input = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
    // ODT_SAT => XYZ => D60_2_D65 => sRGB.
    let output = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));
    let v = input * (color / 0.6);
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return clamp(output * (a / b), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn gx_tm_agx_contrast(x: vec3<f32>) -> vec3<f32> {
    let x2 = x * x;
    let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// AgX's punchy look: slope 1, offset 0, power 1.35 per channel, saturation 1.4 about luma.
fn gx_tm_agx_punchy(c: vec3<f32>) -> vec3<f32> {
    let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    return luma + 1.4 * (pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.35)) - luma);
}

fn gx_tm_agx(color: vec3<f32>, punchy: bool) -> vec3<f32> {
    let srgb_to_rec2020 = mat3x3<f32>(vec3<f32>(0.6274, 0.0691, 0.0164), vec3<f32>(0.3293, 0.9195, 0.0880), vec3<f32>(0.0433, 0.0113, 0.8956));
    let rec2020_to_srgb = mat3x3<f32>(vec3<f32>(1.6605, -0.1246, -0.0182), vec3<f32>(-0.5876, 1.1329, -0.1006), vec3<f32>(-0.0728, -0.0083, 1.1187));
    let inset = mat3x3<f32>(
        vec3<f32>(0.856627153315983, 0.137318972929847, 0.11189821299995),
        vec3<f32>(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
        vec3<f32>(0.0482516061458583, 0.101439036467562, 0.811302368396859)
    );
    let outset = mat3x3<f32>(
        vec3<f32>(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
        vec3<f32>(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
        vec3<f32>(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
    );
    var c = inset * (srgb_to_rec2020 * color);
    c = max(c, vec3<f32>(1e-10));
    c = clamp((log2(c) - GX_AGX_MIN_EV) / (GX_AGX_MAX_EV - GX_AGX_MIN_EV), vec3<f32>(0.0), vec3<f32>(1.0));
    c = gx_tm_agx_contrast(c);
    if punchy {
        c = gx_tm_agx_punchy(c);
    }
    c = outset * c;
    c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
    return clamp(rec2020_to_srgb * c, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn gx_tm_neutral(color: vec3<f32>) -> vec3<f32> {
    let x = min(color.r, min(color.g, color.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    let c = color - offset;
    let peak = max(c.r, max(c.g, c.b));
    if peak < GX_NEUTRAL_START {
        return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let d = 1.0 - GX_NEUTRAL_START;
    let new_peak = 1.0 - d * d / (peak + d - GX_NEUTRAL_START);
    let g = 1.0 - 1.0 / (GX_NEUTRAL_DESATURATION * (peak - new_peak) + 1.0);
    return clamp(mix(c * (new_peak / peak), vec3<f32>(new_peak), g), vec3<f32>(0.0), vec3<f32>(1.0));
}

// The look's curve: pre-exposed linear radiance, white-balanced by the look's gains, to
// display-linear colour in [0, 1].
fn gx_tonemap_curve(color: vec3<f32>) -> vec3<f32> {
    let c = min(max(color * gx_tm.balance.rgb, vec3<f32>(0.0)), vec3<f32>(GX_TM_RADIANCE_MAX));
    if GX_TONEMAPPER == 1u || GX_TONEMAPPER == 4u {
        return gx_tm_agx(c, GX_TONEMAPPER == 4u);
    }
    if GX_TONEMAPPER == 2u {
        return gx_tm_aces(c);
    }
    if GX_TONEMAPPER == 3u {
        return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return gx_tm_neutral(c);
}

// The sRGB transfer, exactly as pbr.wgsl's `linear_to_srgb` (the legacy path's encode).
fn gx_tm_encode(c: vec3<f32>) -> vec3<f32> {
    let low = c * 12.92;
    let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3<f32>(0.0031308));
}

// Interleaved gradient noise (Jimenez 2014) keyed to the frame: generated, no texture.
fn gx_tm_noise(pixel: vec2<f32>, frame: u32) -> f32 {
    let p = pixel + 5.588238 * f32(frame % 64u);
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// The part of `c` above the look's threshold: bloom_down.wgsl's soft knee (gx_bloom_threshold) and
// `post::bloom::soft_threshold`.
fn gx_tm_bloom_part(c: vec3<f32>) -> vec3<f32> {
    let threshold = gx_tm.bloom.x;
    let brightness = max(c.r, max(c.g, c.b));
    let knee = threshold * gx_tm.bloom.y;
    let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
    let contribution = max(soft * soft / (4.0 * knee + 1e-5), brightness - threshold);
    return c * (contribution / max(brightness, 1e-5));
}

// The bloom composite of `hdr` at `uv` (the scene unchanged without bloom): the energy-conserving
// lerp, or under a threshold the over-threshold part traded for the glow.
fn gx_tm_bloom(hdr: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if gx_tm.shape.z <= 0.0 {
        return hdr;
    }
    let bloom = textureSampleLevel(gx_bloom_chain, gx_tm_sampler, uv, 0.0).rgb * gx_tm.shape.w;
    let scene = min(max(hdr, vec3<f32>(0.0)), vec3<f32>(GX_TM_RADIANCE_MAX));
    if gx_tm.bloom.x <= 0.0 {
        return mix(scene, bloom, gx_tm.shape.z);
    }
    return scene + (bloom - gx_tm_bloom_part(scene)) * gx_tm.shape.z;
}

// The tonemapped, encoded colour of `hdr` at output pixel `pixel` (`uv` on the target), bloom
// composited, dithered when the pass asks.
fn gx_tm_display(hdr: vec3<f32>, pixel: vec2<f32>, uv: vec2<f32>) -> vec4<f32> {
    var encoded = gx_tm_encode(gx_tonemap_curve(gx_tm_bloom(hdr, uv)));
    if gx_tm.shape.x > 0.0 {
        encoded += (gx_tm_noise(floor(pixel), gx_tm.frame.x) * 2.0 - 1.0) * gx_tm.shape.x;
    }
    return vec4<f32>(encoded, 1.0);
}

fn gx_tm_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// The luminance-weighted resolve of `pixel`: each sample weighted by 1 / (1 + luma), the mean
// mapped back by the inverse, so one blinding sample does not whiten a mostly dark edge pixel.
// resolve_hdr.wgsl holds the same function for the standalone resolve.
fn gx_tm_resolve(pixel: vec2<i32>) -> vec3<f32> {
    let samples = textureNumSamples(gx_hdr_msaa);
    var sum = vec3<f32>(0.0);
    for (var i = 0u; i < samples; i++) {
        let c = min(max(textureLoad(gx_hdr_msaa, pixel, i32(i)).rgb, vec3<f32>(0.0)), vec3<f32>(GX_TM_RADIANCE_MAX));
        sum += c / (1.0 + gx_tm_luma(c));
    }
    let mean = sum / f32(max(samples, 1u));
    return mean / max(1.0 - gx_tm_luma(mean), 1e-4);
}

@fragment
fn fs_tonemap(in: GxTonemapOut) -> @location(0) vec4<f32> {
    let hdr = textureLoad(gx_hdr_scene, vec2<i32>(in.clip.xy), 0).rgb;
    return gx_tm_display(hdr, in.clip.xy, in.uv);
}

@fragment
fn fs_tonemap_msaa(in: GxTonemapOut) -> @location(0) vec4<f32> {
    return gx_tm_display(gx_tm_resolve(vec2<i32>(in.clip.xy)), in.clip.xy, in.uv);
}

// The four texels of the 1x scene's bilinear footprint at `uv` mixed with the bilinear weights, each
// texel weighted by 1 / (1 + luma) and the mean mapped back by the inverse.
fn gx_tm_bilinear(uv: vec2<f32>) -> vec3<f32> {
    let f = fract(uv * gx_tm.source.xy - 0.5);
    // Gather order: (x0, y1), (x1, y1), (x1, y0), (x0, y0).
    let bilinear = vec4<f32>((1.0 - f.x) * f.y, f.x * f.y, f.x * (1.0 - f.y), (1.0 - f.x) * (1.0 - f.y));
    let limit = vec4<f32>(GX_TM_RADIANCE_MAX);
    let r = min(max(textureGather(0, gx_hdr_scene, gx_tm_sampler, uv), vec4<f32>(0.0)), limit);
    let g = min(max(textureGather(1, gx_hdr_scene, gx_tm_sampler, uv), vec4<f32>(0.0)), limit);
    let b = min(max(textureGather(2, gx_hdr_scene, gx_tm_sampler, uv), vec4<f32>(0.0)), limit);
    let weights = bilinear / (1.0 + 0.2126 * r + 0.7152 * g + 0.0722 * b);
    let mean = vec3<f32>(dot(weights, r), dot(weights, g), dot(weights, b));
    return mean / max(1.0 - gx_tm_luma(mean), 1e-4);
}

@fragment
fn fs_tonemap_bilinear(in: GxTonemapOut) -> @location(0) vec4<f32> {
    return gx_tm_display(gx_tm_bilinear(in.uv), in.clip.xy, in.uv);
}

@fragment
fn fs_tonemap_bilinear_msaa(in: GxTonemapOut) -> @location(0) vec4<f32> {
    // A bilinear filter by hand: multisampled textures take no sampler.
    let size = vec2<i32>(gx_tm.source.xy);
    let p = in.uv * gx_tm.source.xy - 0.5;
    let base = vec2<i32>(floor(p));
    let f = p - floor(p);
    let t00 = gx_tm_resolve(clamp(base, vec2<i32>(0), size - 1));
    let t10 = gx_tm_resolve(clamp(base + vec2<i32>(1, 0), vec2<i32>(0), size - 1));
    let t01 = gx_tm_resolve(clamp(base + vec2<i32>(0, 1), vec2<i32>(0), size - 1));
    let t11 = gx_tm_resolve(clamp(base + vec2<i32>(1, 1), vec2<i32>(0), size - 1));
    // Karis-weighted, as gx_tm_bilinear.
    let w = vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    let k = w / (1.0 + vec4<f32>(gx_tm_luma(t00), gx_tm_luma(t10), gx_tm_luma(t01), gx_tm_luma(t11)));
    let mean = t00 * k.x + t10 * k.y + t01 * k.z + t11 * k.w;
    let hdr = mean / max(1.0 - gx_tm_luma(mean), 1e-4);
    return gx_tm_display(hdr, in.clip.xy, in.uv);
}

// The bilinear scene at `uv`, bloom composited, through the curve, sRGB-encoded.
fn gx_tm_tap(uv: vec2<f32>) -> vec3<f32> {
    return gx_tm_encode(gx_tonemap_curve(gx_tm_bloom(gx_tm_bilinear(uv), uv)));
}

fn gx_tm_max3(v: vec3<f32>) -> f32 {
    return max(v.x, max(v.y, v.z));
}

@fragment
fn fs_tonemap_sharpen(in: GxTonemapOut) -> @location(0) vec4<f32> {
    let px = gx_tm.output.zw;
    let e = gx_tm_tap(in.uv);
    let b = gx_tm_tap(in.uv - vec2<f32>(0.0, px.y));
    let d = gx_tm_tap(in.uv - vec2<f32>(px.x, 0.0));
    let f = gx_tm_tap(in.uv + vec2<f32>(px.x, 0.0));
    let h = gx_tm_tap(in.uv + vec2<f32>(0.0, px.y));
    let lo = min(min(b, d), min(f, h));
    let hi = max(max(b, d), max(f, h));
    // How far a negative lobe may go before the result leaves [min, max] of the cross.
    let hit_min = min(lo, e) / max(4.0 * hi, vec3<f32>(1.0e-5));
    let hit_max = (vec3<f32>(1.0) - max(hi, e)) / min(4.0 * lo - 4.0, vec3<f32>(-1.0e-5));
    let lobe = max(-GX_TM_LOBE_LIMIT, min(gx_tm_max3(max(-hit_min, hit_max)), 0.0)) * gx_tm.shape.y;
    var encoded = clamp((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), vec3<f32>(0.0), vec3<f32>(1.0));
    if gx_tm.shape.x > 0.0 {
        encoded += (gx_tm_noise(floor(in.clip.xy), gx_tm.frame.x) * 2.0 - 1.0) * gx_tm.shape.x;
    }
    return vec4<f32>(encoded, 1.0);
}
