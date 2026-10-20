// Impostor mips (game systems LOD-13; after kansei's `impostor_mip.wgsl`, MIT): one mip of the
// species' three atlases from the mip before, one workgroup per frame (frames are an even number
// of texels wide at every level built, so a 2 x 2 block never straddles two frames). Colour,
// normal, depth and the surface channels are averaged over coverage (plainly where none is
// covered, so the pack's dilated values carry down).
//
// The coverage is kept, not thinned (Castano 2010, "Computing alpha mipmaps"): each texel's alpha
// is the mip-0 box average under it, scaled per frame (never below 1) so the share of texels at or
// above the draw's cutoff is the nearest the texel count allows to the frame's share at mip 0. A plain average (kansei's, `GX_MIP_PLAIN`) thins a far crown of
// leaves into the background, because sparse covered texels average below the cutoff. The scale
// is found by bisection over the frame's texels, counted with storage atomics (no workgroup
// memory) between storage barriers.

struct GxImpostorMip {
    // Texels per frame side at the level written, and at mip 0.
    frame_px: u32,
    base_px: u32,
    // GX_MIP_COVERAGE or GX_MIP_PLAIN.
    rule: u32,
    // Frames per atlas side (the frame's counter slot).
    frames: u32,
    // The draw's coverage cutoff.
    cutoff: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

@group(0) @binding(0) var a_in: texture_2d<f32>;
@group(0) @binding(1) var b_in: texture_2d<f32>;
@group(0) @binding(2) var c_in: texture_2d<f32>;
@group(0) @binding(3) var a_base: texture_2d<f32>;
@group(0) @binding(4) var a_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var b_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(6) var c_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(7) var<uniform> mip: GxImpostorMip;
// Two counters per frame: the covered texels at mip 0, and a bisection step's.
@group(0) @binding(8) var<storage, read_write> counts: array<atomic<u32>>;

const GX_MIP_COVERAGE: u32 = 0u;
const GX_MIP_PLAIN: u32 = 1u;
const GX_MIP_LANES: u32 = 64u;
const GX_MIP_BISECT_STEPS: u32 = 16u;
// The alpha scales the bisection tries: from 1 (no change) up to this.
const GX_MIP_SCALE_MAX: f32 = 16.0;

fn gx_mip_oct_decode(e: vec2<f32>) -> vec3<f32> {
    let g = e * 2.0 - 1.0;
    let y = 1.0 - abs(g.x) - abs(g.y);
    var xz = g;
    if y < 0.0 {
        let s = select(vec2<f32>(-1.0), vec2<f32>(1.0), g >= vec2<f32>(0.0));
        xz = (vec2<f32>(1.0) - abs(g.yx)) * s;
    }
    return normalize(vec3<f32>(xz.x, y, xz.y));
}

fn gx_mip_oct_encode(n: vec3<f32>) -> vec2<f32> {
    let v = n / (abs(n.x) + abs(n.y) + abs(n.z));
    var e = v.xz;
    if v.y < 0.0 {
        let s = select(vec2<f32>(-1.0), vec2<f32>(1.0), v.xz >= vec2<f32>(0.0));
        e = (vec2<f32>(1.0) - abs(v.zx)) * s;
    }
    return e * 0.5 + 0.5;
}

// The average alpha of the mip-0 block under texel `p` of the level written: the unscaled box
// filter (Castano scales each level of the plain chain, never a scaled level again, so clamped
// texels do not pile up at 1 and the count can still reach the wanted share).
fn gx_mip_block_alpha(p: vec2<i32>) -> f32 {
    let block = mip.base_px / mip.frame_px;
    var alpha = 0.0;
    for (var k = 0u; k < block * block; k++) {
        alpha += textureLoad(a_base, p * i32(block) + vec2<i32>(i32(k % block), i32(k / block)), 0).a;
    }
    return alpha / f32(block * block);
}

// Texels of the frame at `origin` (`side` wide) whose block alpha times `scale` reaches the cutoff,
// counted by this lane.
fn gx_mip_count(origin: vec2<i32>, side: u32, scale: f32, lane: u32) -> u32 {
    var count = 0u;
    for (var i = lane; i < side * side; i += GX_MIP_LANES) {
        let p = origin + vec2<i32>(i32(i % side), i32(i / side));
        count += select(0u, 1u, gx_mip_block_alpha(p) * scale >= mip.cutoff);
    }
    return count;
}

// The frame's covered texels at mip 0, counted by this lane.
fn gx_mip_base_count(frame: vec2<u32>, lane: u32) -> u32 {
    let side = mip.base_px;
    let origin = vec2<i32>(frame * side);
    var count = 0u;
    for (var i = lane; i < side * side; i += GX_MIP_LANES) {
        let p = origin + vec2<i32>(i32(i % side), i32(i / side));
        count += select(0u, 1u, textureLoad(a_base, p, 0).a >= mip.cutoff);
    }
    return count;
}

// The alpha scale that keeps the frame's coverage, never below 1 (an opaque interior stays opaque;
// only thinning is undone), and 1 under the plain rule.
fn gx_mip_scale(frame: vec2<u32>, lane: u32) -> f32 {
    let slot = 2u * (frame.y * mip.frames + frame.x);
    let side = mip.frame_px;
    let origin = vec2<i32>(frame * side);
    if lane == 0u {
        atomicStore(&counts[slot], 0u);
    }
    storageBarrier();
    atomicAdd(&counts[slot], gx_mip_base_count(frame, lane));
    storageBarrier();
    let base_share = f32(atomicLoad(&counts[slot])) / f32(mip.base_px * mip.base_px);
    let wanted = base_share * f32(side * side);
    var lo = 1.0;
    var hi = GX_MIP_SCALE_MAX;
    var lo_count = 0.0;
    var hi_count = f32(side * side);
    for (var step = 0u; step < GX_MIP_BISECT_STEPS; step++) {
        let mid = (lo + hi) * 0.5;
        if lane == 0u {
            atomicStore(&counts[slot + 1u], 0u);
        }
        storageBarrier();
        atomicAdd(&counts[slot + 1u], gx_mip_count(origin, side, mid, lane));
        storageBarrier();
        let count = f32(atomicLoad(&counts[slot + 1u]));
        let short = count < wanted;
        lo = select(lo, mid, short);
        lo_count = select(lo_count, count, short);
        hi = select(mid, hi, short);
        hi_count = select(count, hi_count, short);
        storageBarrier();
    }
    // The bracket's end whose count is nearer the wanted share (a small frame's count steps by
    // whole texels); the lower end only once a step fell short (it starts at the unscaled 1).
    let nearer_lo = lo > 1.0 && wanted - lo_count < hi_count - wanted;
    return select(select(hi, lo, nearer_lo), 1.0, mip.rule == GX_MIP_PLAIN);
}

// Texel `p` of the level written, its alpha scaled by `scale`.
fn gx_mip_write(p: vec2<i32>, scale: f32) {
    var weighted_a = vec4<f32>(0.0);
    var plain_a = vec3<f32>(0.0);
    var weighted_b = vec4<f32>(0.0);
    var plain_b = vec4<f32>(0.0);
    var weighted_c = vec4<f32>(0.0);
    var plain_c = vec4<f32>(0.0);
    for (var k = 0u; k < 4u; k++) {
        let q = p * 2 + vec2<i32>(i32(k & 1u), i32(k >> 1u));
        let a = textureLoad(a_in, q, 0);
        let b = textureLoad(b_in, q, 0);
        let c = textureLoad(c_in, q, 0);
        let nb = vec4<f32>(gx_mip_oct_decode(b.xy), b.z);
        weighted_a += vec4<f32>(a.rgb * a.a, a.a);
        plain_a += a.rgb;
        weighted_b += nb * a.a;
        plain_b += nb;
        weighted_c += c * a.a;
        plain_c += c;
    }
    var albedo = plain_a * 0.25;
    var nd = plain_b * 0.25;
    var surface = plain_c * 0.25;
    var roughness = 0.0;
    for (var k = 0u; k < 4u; k++) {
        roughness += textureLoad(b_in, p * 2 + vec2<i32>(i32(k & 1u), i32(k >> 1u)), 0).w;
    }
    if weighted_a.a > 0.0 {
        albedo = weighted_a.rgb / weighted_a.a;
        nd = weighted_b / weighted_a.a;
        surface = weighted_c / weighted_a.a;
    }
    let alpha = clamp(gx_mip_block_alpha(p) * scale, 0.0, 1.0);
    let normal = normalize(nd.xyz + vec3<f32>(0.0, 1.0e-6, 0.0));
    textureStore(a_out, p, vec4<f32>(albedo, alpha));
    textureStore(b_out, p, vec4<f32>(gx_mip_oct_encode(normal), nd.w, roughness * 0.25));
    textureStore(c_out, p, surface);
}

@compute @workgroup_size(64, 1, 1)
fn cs_impostor_mip(@builtin(workgroup_id) frame: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let scale = gx_mip_scale(frame.xy, lane);
    let side = mip.frame_px;
    let origin = vec2<i32>(frame.xy * side);
    for (var i = lane; i < side * side; i += GX_MIP_LANES) {
        gx_mip_write(origin + vec2<i32>(i32(i % side), i32(i / side)), scale);
    }
}
