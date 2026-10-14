// The Hi-Z build (R2, graph node 8; R2.2). Mip 0 reduces the prepass depth by `textureLoad` (no
// depth-to-colour copy); each later mip reduces the previous one, read as a sampled texture. Every
// texel keeps the farthest depth it covers (`gx_hiz_reduce`: max under standard Z, min under
// reverse-Z). A texel covers its source's 2x2 block, and the last texel of a row or column also
// covers the source's leftover odd texel (`hiz_span`), so the footprint is up to 3x3 and the pyramid
// is conservative for the cull's lookup (pixel p reads mip k at min(p >> (k + 1), size_k - 1)). One
// dispatch per mip; the CPU twin is `hiz::reference`. `r32float` write-only storage is core.

@group(0) @binding(0) var<uniform> hiz: HizParams;
@group(0) @binding(1) var depth_source: texture_depth_2d;
@group(0) @binding(2) var hiz_dest: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var mip_source: texture_2d<f32>;

// The first and last source texel destination texel `at` covers on one axis (`hiz::span`): its
// own two, and on the last destination texel everything to the source's edge.
fn hiz_span(at: u32, dest: u32, source: u32) -> vec2<u32> {
    let last_source = source - 1u;
    let first = min(at * 2u, last_source);
    return vec2<u32>(first, select(min(at * 2u + 1u, last_source), last_source, at + 1u >= dest));
}

// The farther of two depths under this build's convention.
fn hiz_farther(a: f32, b: f32) -> f32 {
    return gx_hiz_reduce(vec4<f32>(a, b, a, b), hiz.params.y);
}

// The footprint of destination texel `id` on each axis, or none when `id` is outside the mip.
fn hiz_footprint(id: vec2<u32>) -> vec4<u32> {
    return vec4<u32>(hiz_span(id.x, hiz.size.z, hiz.size.x), hiz_span(id.y, hiz.size.w, hiz.size.y));
}

fn hiz_store(id: vec2<u32>, far: f32) {
    textureStore(hiz_dest, vec2<i32>(id), vec4<f32>(far, 0.0, 0.0, 0.0));
}

// Mip 0 from the depth target.
@compute @workgroup_size(8, 8, 1)
fn hiz_from_depth(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= hiz.size.z || id.y >= hiz.size.w {
        return;
    }
    let span = hiz_footprint(id.xy);
    // The 2x2 block (a 1-texel source edge reads its one texel twice), then the folded column and
    // row on the last texels.
    let x1 = min(span.x + 1u, span.y);
    let y1 = min(span.z + 1u, span.w);
    var far = gx_hiz_reduce(vec4<f32>(
        textureLoad(depth_source, vec2<u32>(span.x, span.z), 0),
        textureLoad(depth_source, vec2<u32>(x1, span.z), 0),
        textureLoad(depth_source, vec2<u32>(span.x, y1), 0),
        textureLoad(depth_source, vec2<u32>(x1, y1), 0),
    ), hiz.params.y);
    if span.y > x1 {
        for (var y = span.z; y <= span.w; y++) {
            far = hiz_farther(far, textureLoad(depth_source, vec2<u32>(span.y, y), 0));
        }
    }
    if span.w > y1 {
        for (var x = span.x; x <= span.y; x++) {
            far = hiz_farther(far, textureLoad(depth_source, vec2<u32>(x, span.w), 0));
        }
    }
    hiz_store(id.xy, far);
}

// Mip k from mip k - 1.
@compute @workgroup_size(8, 8, 1)
fn hiz_reduce(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= hiz.size.z || id.y >= hiz.size.w {
        return;
    }
    let span = hiz_footprint(id.xy);
    let x1 = min(span.x + 1u, span.y);
    let y1 = min(span.z + 1u, span.w);
    var far = gx_hiz_reduce(vec4<f32>(
        textureLoad(mip_source, vec2<u32>(span.x, span.z), 0).r,
        textureLoad(mip_source, vec2<u32>(x1, span.z), 0).r,
        textureLoad(mip_source, vec2<u32>(span.x, y1), 0).r,
        textureLoad(mip_source, vec2<u32>(x1, y1), 0).r,
    ), hiz.params.y);
    if span.y > x1 {
        for (var y = span.z; y <= span.w; y++) {
            far = hiz_farther(far, textureLoad(mip_source, vec2<u32>(span.y, y), 0).r);
        }
    }
    if span.w > y1 {
        for (var x = span.x; x <= span.y; x++) {
            far = hiz_farther(far, textureLoad(mip_source, vec2<u32>(x, span.w), 0).r);
        }
    }
    hiz_store(id.xy, far);
}
