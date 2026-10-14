// FSR1 RCAS (graph node 22, RQ5.3): robust contrast-adaptive sharpening at output size, after EASU
// (or alone at scale 1 under TAA's sharpen on ultra), then the final dither into the world
// target. A full-screen fragment pass.
//
// A WGSL port of AMD FidelityFX Super Resolution 1.0's RCAS (`FsrRcasF` in `ffx_fsr1.h`), MIT,
// Copyright (c) 2021 Advanced Micro Devices, Inc. (notice in THIRD-PARTY-NOTICES.md). Changes: the
// reciprocals are exact and guarded where the original relies on a hardware reciprocal of zero
// being infinite, the optional noise-detection term (`FSR_RCAS_DENOISE`) is a uniform switch, on
// by default (RQ5 review: the sharpened frame turned per-pixel noise TAA could not integrate into
// grain), and the dither follows the sharpening.
//
// The sharpened pixel is a weighted sum of its centre and the four neighbours in a plus shape,
// with a negative lobe sized per channel so no result leaves [0, 1].

// Mirrors `post::fsr::GpuRcasParams`.
struct RcasParams {
    // x: the sharpness as a linear scale (exp2(-stops); 0 leaves the image as it is); y: 1 to
    // dither; z: the frame the dither is keyed to; w: 1 for noise detection.
    con: vec4<f32>,
    // xy: the output size in pixels; zw: 1 / it.
    size: vec4<f32>,
}

@group(0) @binding(0) var gx_input: texture_2d<f32>;
@group(0) @binding(1) var<uniform> gx_rcas: RcasParams;

// The most RCAS pulls the neighbours: 0.25 - 1/16.
const GX_RCAS_LIMIT: f32 = 0.1875;
// The dither's amplitude in encoded units: half an 8-bit level (the tonemap's).
const GX_RCAS_DITHER: f32 = 0.5 / 255.0;

struct RcasOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_rcas(@builtin(vertex_index) index: u32) -> RcasOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return RcasOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

fn gx_rcas_load(pixel: vec2<i32>) -> vec3<f32> {
    let size = vec2<i32>(textureDimensions(gx_input));
    return textureLoad(gx_input, clamp(pixel, vec2<i32>(0), size - vec2<i32>(1)), 0).rgb;
}

// Luma times two.
fn gx_rcas_luma(c: vec3<f32>) -> f32 {
    return c.b * 0.5 + (c.r * 0.5 + c.g);
}

// Interleaved gradient noise (Jimenez 2014) keyed to the frame, as the tonemap's dither is.
fn gx_rcas_noise(pixel: vec2<f32>, frame: f32) -> f32 {
    let p = pixel + 5.588238 * frame;
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// FSR_RCAS_DENOISE's factor on the lobe: 1 at a clean edge, down to 0.5 where the centre's luma
// sits as far from its four neighbours' mean as the plus shape's whole luma range (an isolated
// speck: noise). A flat neighbourhood has no range and keeps the lobe.
fn gx_rcas_noise_factor(b: vec3<f32>, d: vec3<f32>, e: vec3<f32>, f: vec3<f32>, h: vec3<f32>) -> f32 {
    let bl = gx_rcas_luma(b);
    let dl = gx_rcas_luma(d);
    let el = gx_rcas_luma(e);
    let fl = gx_rcas_luma(f);
    let hl = gx_rcas_luma(h);
    let range = max(max(max(bl, dl), max(el, fl)), hl) - min(min(min(bl, dl), min(el, fl)), hl);
    let nz = 0.25 * (bl + dl + fl + hl) - el;
    let noise = select(clamp(abs(nz) / range, 0.0, 1.0), 0.0, range <= 1.0e-5);
    return -0.5 * noise + 1.0;
}

@fragment
fn fs_rcas(in: RcasOut) -> @location(0) vec4<f32> {
    // The 3x3 neighbourhood's plus shape:
    //     b
    //   d e f
    //     h
    let sp = vec2<i32>(in.clip.xy);
    let b = gx_rcas_load(sp + vec2<i32>(0, -1));
    let d = gx_rcas_load(sp + vec2<i32>(-1, 0));
    let e = gx_rcas_load(sp);
    let f = gx_rcas_load(sp + vec2<i32>(1, 0));
    let h = gx_rcas_load(sp + vec2<i32>(0, 1));
    // The ring's range per channel.
    let mn4 = min(min(b, d), min(f, h));
    let mx4 = max(max(b, d), max(f, h));
    // The limiters: how far the negative lobe may go before the result clips at 0 or at 1.
    let hit_min = min(mn4, e) / max(4.0 * mx4, vec3<f32>(1.0e-5));
    let hit_max = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3<f32>(-1.0e-5));
    let lobe_c = max(-hit_min, hit_max);
    var lobe = max(-GX_RCAS_LIMIT, min(max(lobe_c.r, max(lobe_c.g, lobe_c.b)), 0.0)) * gx_rcas.con.x;
    if gx_rcas.con.w > 0.5 {
        lobe *= gx_rcas_noise_factor(b, d, e, f, h);
    }
    // Resolve: the weights sum to 4 * lobe + 1.
    let rcp_l = 1.0 / (4.0 * lobe + 1.0);
    var pix = (lobe * (b + d + h + f) + e) * rcp_l;
    if gx_rcas.con.y > 0.5 {
        pix += (gx_rcas_noise(floor(in.clip.xy), gx_rcas.con.z) * 2.0 - 1.0) * GX_RCAS_DITHER;
    }
    return vec4<f32>(pix, 1.0);
}
