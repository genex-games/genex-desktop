// FSR1 EASU (graph node 22, RQ5.3): edge-adaptive spatial upsampling of the tonemapped
// rgb10a2unorm intermediate at the DRS step's render size to the output size. RCAS sharpens after
// it, then the final dither. A full-screen fragment pass.
//
// A WGSL port of AMD FidelityFX Super Resolution 1.0's EASU (`FsrEasuF` in `ffx_fsr1.h`), MIT,
// Copyright (c) 2021 Advanced Micro Devices, Inc. (notice in THIRD-PARTY-NOTICES.md). Changes: the
// reciprocal and reciprocal square root approximations are exact, divisions are guarded so an
// all-equal neighbourhood cannot divide by zero, and the taps are gathers of a texture in WGSL.
//
// The kernel reads 12 taps around the texel `f` the output pixel lands between:
//
//        b c
//      e f g h
//      i j k l
//        n o
//
// It finds the local edge direction and strength from the luma of the taps, rotates and stretches
// a windowed Lanczos-like kernel along it, and clamps the result to the range of the four centre
// texels (f, g, j, k) so the kernel never rings past its neighbourhood.

// Mirrors `post::fsr::GpuEasuParams`: EASU's four constant vectors (FsrEasuCon), as floats.
struct EasuParams {
    // xy: the render-to-output scale; zw: half of it less half a texel.
    con0: vec4<f32>,
    // xy: one render texel; zw: the offset (+1, -1) texels of the first gather from the f texel.
    con1: vec4<f32>,
    // xy: the second gather's offset (-1, +2) texels from the first; zw: the third's (+1, +2).
    con2: vec4<f32>,
    // y: the fourth gather's offset, 4 texels below the first.
    con3: vec4<f32>,
}

@group(0) @binding(0) var gx_input: texture_2d<f32>;
@group(0) @binding(1) var gx_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_easu: EasuParams;

struct EasuOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_easu(@builtin(vertex_index) index: u32) -> EasuOut {
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return EasuOut(vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0));
}

// Luma times two, from the red, green and blue gathers (FSR's approximation, no weights sum).
fn gx_easu_luma(r: vec4<f32>, g: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    return b * 0.5 + (r * 0.5 + g);
}

// One tap of the bilinear-weighted direction and length accumulation. `w` is the bilinear weight
// of the centre texel `lC`; a..e are the luma of the plus-shaped neighbourhood around it:
//
//     a
//   b c d
//     e
fn gx_easu_set(dir: ptr<function, vec2<f32>>, len: ptr<function, f32>, w: f32, lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) {
    // The direction is the '+' difference; the length converts gradient reversal to 0, smoothly to
    // non-reversal at 1, shaped, then adds the horizontal and vertical terms.
    let dc = lD - lC;
    let cb = lC - lB;
    var len_x = max(abs(dc), abs(cb));
    len_x = 1.0 / max(len_x, 1.0e-12);
    let dir_x = lD - lB;
    (*dir).x += dir_x * w;
    len_x = clamp(abs(dir_x) * len_x, 0.0, 1.0);
    len_x *= len_x;
    (*len) += len_x * w;
    // The same along y.
    let ec = lE - lC;
    let ca = lC - lA;
    var len_y = max(abs(ec), abs(ca));
    len_y = 1.0 / max(len_y, 1.0e-12);
    let dir_y = lE - lA;
    (*dir).y += dir_y * w;
    len_y = clamp(abs(dir_y) * len_y, 0.0, 1.0);
    len_y *= len_y;
    (*len) += len_y * w;
}

// One tap of the kernel: `off` is the tap's offset from the output pixel in render texels, `c`
// its colour. Accumulates the weighted colour (xyz) and the weight (w).
fn gx_easu_tap(acc: ptr<function, vec4<f32>>, off: vec2<f32>, dir: vec2<f32>, len: vec2<f32>, lob: f32, clp: f32, c: vec3<f32>) {
    // Rotate the offset by the direction, then apply the anisotropy.
    var v = vec2<f32>(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x);
    v *= len;
    // Distance squared, limited to the window as at a corner two taps can be outside it.
    var d2 = v.x * v.x + v.y * v.y;
    d2 = min(d2, clp);
    // An approximation of Lanczos2 without sin(), rcp() or sqrt():
    //   (25/16 * (2/5 * x^2 - 1)^2 - (25/16 - 1)) * (1/4 * x^2 - 1)^2
    // whose negative lobe `lob` moves with the amount of edge.
    var w_b = 0.4 * d2 - 1.0;
    var w_a = lob * d2 - 1.0;
    w_b *= w_b;
    w_a *= w_a;
    w_b = 1.5625 * w_b - 0.5625;
    let w = w_b * w_a;
    *acc += vec4<f32>(c * w, w);
}

@fragment
fn fs_easu(in: EasuOut) -> @location(0) vec4<f32> {
    // The output pixel in render texel space: texel i's centre is at i.
    var pp = floor(in.clip.xy) * gx_easu.con0.xy + gx_easu.con0.zw;
    let fp = floor(pp);
    pp -= fp;
    // Four gathers on texel corners, each 2x2 texels: x is the lower left, then clockwise.
    let p0 = fp * gx_easu.con1.xy + gx_easu.con1.zw;
    let p1 = p0 + gx_easu.con2.xy;
    let p2 = p0 + gx_easu.con2.zw;
    let p3 = p0 + gx_easu.con3.xy;
    let bczz_r = textureGather(0, gx_input, gx_sampler, p0);
    let bczz_g = textureGather(1, gx_input, gx_sampler, p0);
    let bczz_b = textureGather(2, gx_input, gx_sampler, p0);
    let ijfe_r = textureGather(0, gx_input, gx_sampler, p1);
    let ijfe_g = textureGather(1, gx_input, gx_sampler, p1);
    let ijfe_b = textureGather(2, gx_input, gx_sampler, p1);
    let klhg_r = textureGather(0, gx_input, gx_sampler, p2);
    let klhg_g = textureGather(1, gx_input, gx_sampler, p2);
    let klhg_b = textureGather(2, gx_input, gx_sampler, p2);
    let zzon_r = textureGather(0, gx_input, gx_sampler, p3);
    let zzon_g = textureGather(1, gx_input, gx_sampler, p3);
    let zzon_b = textureGather(2, gx_input, gx_sampler, p3);

    let bczz_l = gx_easu_luma(bczz_r, bczz_g, bczz_b);
    let ijfe_l = gx_easu_luma(ijfe_r, ijfe_g, ijfe_b);
    let klhg_l = gx_easu_luma(klhg_r, klhg_g, klhg_b);
    let zzon_l = gx_easu_luma(zzon_r, zzon_g, zzon_b);
    let l_b = bczz_l.x;
    let l_c = bczz_l.y;
    let l_i = ijfe_l.x;
    let l_j = ijfe_l.y;
    let l_f = ijfe_l.z;
    let l_e = ijfe_l.w;
    let l_k = klhg_l.x;
    let l_l = klhg_l.y;
    let l_h = klhg_l.z;
    let l_g = klhg_l.w;
    let l_o = zzon_l.z;
    let l_n = zzon_l.w;

    // Accumulate the direction and length with the bilinear weights of f, g, j and k.
    var dir = vec2<f32>(0.0);
    var len = 0.0;
    gx_easu_set(&dir, &len, (1.0 - pp.x) * (1.0 - pp.y), l_b, l_e, l_f, l_g, l_j);
    gx_easu_set(&dir, &len, pp.x * (1.0 - pp.y), l_c, l_f, l_g, l_h, l_k);
    gx_easu_set(&dir, &len, (1.0 - pp.x) * pp.y, l_f, l_i, l_j, l_k, l_n);
    gx_easu_set(&dir, &len, pp.x * pp.y, l_g, l_j, l_k, l_l, l_o);

    // Normalize, and clean up close to zero (no edge: a horizontal direction, a round kernel).
    let dir2 = dir * dir;
    var dir_r = dir2.x + dir2.y;
    let zero = dir_r < (1.0 / 32768.0);
    dir_r = inverseSqrt(max(dir_r, 1.0e-30));
    dir_r = select(dir_r, 1.0, zero);
    dir.x = select(dir.x, 1.0, zero);
    dir *= dir_r;
    // Transform the length from {0 to 2} to {0 to 1} and shape it with a square.
    len = len * 0.5;
    len *= len;
    // Stretch the kernel: 1.0 vertical or horizontal, sqrt(2) on a diagonal.
    let stretch = (dir.x * dir.x + dir.y * dir.y) / max(max(abs(dir.x), abs(dir.y)), 1.0e-6);
    // The anisotropic length after rotation: x lerps 1.0 to 'stretch' on edges, y lerps 1.0 to 2x.
    let len2 = vec2<f32>(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    // Based on the amount of edge the window shifts from +/-sqrt(2) to slightly beyond 2.
    let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    // The distance squared clipping point is the end of the adjustable window.
    let clp = 1.0 / lob;

    // The colours of the 12 taps.
    let rgb_b = vec3<f32>(bczz_r.x, bczz_g.x, bczz_b.x);
    let rgb_c = vec3<f32>(bczz_r.y, bczz_g.y, bczz_b.y);
    let rgb_i = vec3<f32>(ijfe_r.x, ijfe_g.x, ijfe_b.x);
    let rgb_j = vec3<f32>(ijfe_r.y, ijfe_g.y, ijfe_b.y);
    let rgb_f = vec3<f32>(ijfe_r.z, ijfe_g.z, ijfe_b.z);
    let rgb_e = vec3<f32>(ijfe_r.w, ijfe_g.w, ijfe_b.w);
    let rgb_k = vec3<f32>(klhg_r.x, klhg_g.x, klhg_b.x);
    let rgb_l = vec3<f32>(klhg_r.y, klhg_g.y, klhg_b.y);
    let rgb_h = vec3<f32>(klhg_r.z, klhg_g.z, klhg_b.z);
    let rgb_g = vec3<f32>(klhg_r.w, klhg_g.w, klhg_b.w);
    let rgb_o = vec3<f32>(zzon_r.z, zzon_g.z, zzon_b.z);
    let rgb_n = vec3<f32>(zzon_r.w, zzon_g.w, zzon_b.w);

    var acc = vec4<f32>(0.0);
    gx_easu_tap(&acc, vec2<f32>(0.0, -1.0) - pp, dir, len2, lob, clp, rgb_b);
    gx_easu_tap(&acc, vec2<f32>(1.0, -1.0) - pp, dir, len2, lob, clp, rgb_c);
    gx_easu_tap(&acc, vec2<f32>(-1.0, 1.0) - pp, dir, len2, lob, clp, rgb_i);
    gx_easu_tap(&acc, vec2<f32>(0.0, 1.0) - pp, dir, len2, lob, clp, rgb_j);
    gx_easu_tap(&acc, vec2<f32>(0.0, 0.0) - pp, dir, len2, lob, clp, rgb_f);
    gx_easu_tap(&acc, vec2<f32>(-1.0, 0.0) - pp, dir, len2, lob, clp, rgb_e);
    gx_easu_tap(&acc, vec2<f32>(1.0, 1.0) - pp, dir, len2, lob, clp, rgb_k);
    gx_easu_tap(&acc, vec2<f32>(2.0, 1.0) - pp, dir, len2, lob, clp, rgb_l);
    gx_easu_tap(&acc, vec2<f32>(2.0, 0.0) - pp, dir, len2, lob, clp, rgb_h);
    gx_easu_tap(&acc, vec2<f32>(1.0, 0.0) - pp, dir, len2, lob, clp, rgb_g);
    gx_easu_tap(&acc, vec2<f32>(1.0, 2.0) - pp, dir, len2, lob, clp, rgb_o);
    gx_easu_tap(&acc, vec2<f32>(0.0, 2.0) - pp, dir, len2, lob, clp, rgb_n);

    // Normalize, and dering: no result leaves the range of the four texels around the pixel.
    var pix = acc.xyz / select(acc.w, 1.0, abs(acc.w) < 1.0e-9);
    let lo = min(min(rgb_f, rgb_g), min(rgb_j, rgb_k));
    let hi = max(max(rgb_f, rgb_g), max(rgb_j, rgb_k));
    pix = clamp(pix, lo, hi);
    return vec4<f32>(pix, 1.0);
}
