// Hi-Z screen-space reflections, the resolve (renderer pass 2 B.9): the half-size trace up to the
// render size by a bilateral bilinear filter (depth, normal and roughness weights), then the trace's
// tone map undone. A port of Godot 4.7.2 `screen_space_reflection_resolve.glsl` (MIT, © Godot Engine
// contributors and Juan Linietsky, Ariel Manzur). Changes, kept in the CPU twin
// (`ssr::twin::resolve`): no mip-level image (the trace sampled its mip itself); a half-size
// sample's depth is the Hi-Z's nearest and its normal and roughness the full-size pixel at twice
// its coordinate; coordinates clamp to the edge; the sky resolves to nothing. The result is the
// forward pass's `screen_reflections` (binding 30): rgb the reflected radiance times the
// confidence, a the confidence (`gx_ssr_apply`). Include after effects.wgsl, normal_roughness.wgsl
// and ssr_params.wgsl.

@group(0) @binding(0) var<uniform> ssr: SsrParams;
@group(0) @binding(1) var ssr_hiz: texture_2d<f32>;
@group(0) @binding(2) var ssr_depth: texture_depth_2d;
@group(0) @binding(3) var ssr_normal_roughness: texture_2d<f32>;
@group(0) @binding(4) var ssr_trace: texture_2d<f32>;
@group(0) @binding(5) var ssr_out: texture_storage_2d<rgba16float, write>;

const SSR_LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
const SSR_DEPTH_FACTOR: f32 = 2048.0;
const SSR_NORMAL_FACTOR: f32 = 32.0;
const SSR_ROUGHNESS_FACTOR: f32 = 16.0;

// One half-size sample at `at` and its weight against the pixel's depth, normal and roughness.
fn ssr_sample(depth: f32, normal: vec3<f32>, roughness: f32, at: vec2<i32>) -> vec4<f32> {
    let half_last = vec2<i32>(ssr.size.xy) - vec2<i32>(1);
    let cell = clamp(at, vec2<i32>(0), half_last);
    let sample_depth = textureLoad(ssr_hiz, cell, 0).x;
    let full_last = vec2<i32>(ssr.size.zw) - vec2<i32>(1);
    let texel = textureLoad(ssr_normal_roughness, min(cell * 2, full_last), 0);
    let weight_depth = exp(-abs(depth - sample_depth) * SSR_DEPTH_FACTOR);
    let weight_normal = exp(-saturate(1.0 - dot(normal, gx_unpack_normal(texel))) * SSR_NORMAL_FACTOR);
    let weight_roughness = exp(-abs(roughness - gx_unpack_roughness(texel)) * SSR_ROUGHNESS_FACTOR);
    return vec4<f32>(vec2<f32>(cell), 0.0, weight_depth * weight_normal * weight_roughness);
}

// The trace's colour at `cell` with its tone map undone.
fn ssr_untonemapped(cell: vec2<f32>) -> vec4<f32> {
    let color = textureLoad(ssr_trace, vec2<i32>(cell), 0);
    return vec4<f32>(color.rgb / max(1.0 - dot(color.rgb, SSR_LUMA), 1e-4), color.a);
}

@compute @workgroup_size(8, 8, 1)
fn cs_ssr_resolve(@builtin(global_invocation_id) id: vec3<u32>) {
    if any(id.xy >= ssr.size.zw) {
        return;
    }
    let pixel = vec2<i32>(id.xy);
    let depth = textureLoad(ssr_depth, pixel, 0);
    let sky = select(1.0, 0.0, ssr.knobs.z == 1u);
    if depth == sky {
        textureStore(ssr_out, pixel, vec4<f32>(0.0));
        return;
    }
    let texel = textureLoad(ssr_normal_roughness, pixel, 0);
    let normal = gx_unpack_normal(texel);
    let roughness = gx_unpack_roughness(texel);
    let w = fract((vec2<f32>(pixel) + vec2<f32>(0.5)) * 0.5);
    let base = (pixel - vec2<i32>(1)) / 2;
    let s0 = ssr_sample(depth, normal, roughness, base);
    let s1 = ssr_sample(depth, normal, roughness, base + vec2<i32>(1, 0));
    let s2 = ssr_sample(depth, normal, roughness, base + vec2<i32>(0, 1));
    let s3 = ssr_sample(depth, normal, roughness, base + vec2<i32>(1, 1));
    let w0 = s0.w * w.x * w.y;
    let w1 = s1.w * (1.0 - w.x) * w.y;
    let w2 = s2.w * w.x * (1.0 - w.y);
    let w3 = s3.w * (1.0 - w.x) * (1.0 - w.y);
    let total = w0 + w1 + w2 + w3;
    var result = vec4<f32>(0.0);
    if total > 0.0 {
        result = (ssr_untonemapped(s0.xy) * w0 + ssr_untonemapped(s1.xy) * w1 + ssr_untonemapped(s2.xy) * w2 + ssr_untonemapped(s3.xy) * w3) / total;
    }
    textureStore(ssr_out, pixel, result);
}

// The blur between the trace and the resolve (not in the source; CPU twin `ssr::twin::Screen::blur`):
// a separable bilateral Gaussian over the half-size trace, as wide as `SSR_BLUR_TAPS` texels each
// side on a surface as rough as `extra.z` and narrowing to nothing on a mirror. Where a ray finds
// nothing (a thin table top it passed behind, a pendant bulb) the probes show through; a rough
// surface's lobe spreads that hole's edge, which the trace drew as hard as a mirror's (a staircase
// at the trace's half size). Run along x from the trace into the reflections' texture (as scratch,
// the trace's size in its corner), then along y back into the trace, before the resolve.
const SSR_BLUR_TAPS: i32 = 4;

// The bilateral weight of the trace texel at `cell` against the centre's depth, normal and
// roughness: the resolve's weights.
fn ssr_blur_weight(depth: f32, normal: vec3<f32>, roughness: f32, cell: vec2<i32>) -> f32 {
    let full_last = vec2<i32>(ssr.size.zw) - vec2<i32>(1);
    let texel = textureLoad(ssr_normal_roughness, min(cell * 2, full_last), 0);
    let weight_depth = exp(-abs(depth - textureLoad(ssr_hiz, cell, 0).x) * SSR_DEPTH_FACTOR);
    let weight_normal = exp(-saturate(1.0 - dot(normal, gx_unpack_normal(texel))) * SSR_NORMAL_FACTOR);
    let weight_roughness = exp(-abs(roughness - gx_unpack_roughness(texel)) * SSR_ROUGHNESS_FACTOR);
    return weight_depth * weight_normal * weight_roughness;
}

fn ssr_blur(id: vec2<u32>, axis: vec2<i32>) {
    if any(id >= ssr.size.xy) {
        return;
    }
    let pixel = vec2<i32>(id);
    let centre = textureLoad(ssr_trace, pixel, 0);
    let full_last = vec2<i32>(ssr.size.zw) - vec2<i32>(1);
    let texel = textureLoad(ssr_normal_roughness, min(pixel * 2, full_last), 0);
    let roughness = gx_unpack_roughness(texel);
    let sigma = f32(SSR_BLUR_TAPS) * 0.5 * smoothstep(0.0, ssr.extra.z, roughness);
    // A mirror keeps its texel; a surface from the cutoff was not traced (nothing to spread).
    if sigma < 0.25 || roughness >= ssr.tune.w {
        textureStore(ssr_out, pixel, centre);
        return;
    }
    let normal = gx_unpack_normal(texel);
    let depth = textureLoad(ssr_hiz, pixel, 0).x;
    let last = vec2<i32>(ssr.size.xy) - vec2<i32>(1);
    var sum = centre;
    var total = 1.0;
    // Two sigmas each side: a smoother surface pays for fewer taps.
    let taps = min(i32(ceil(sigma * 2.0)), SSR_BLUR_TAPS);
    for (var i = 1; i <= taps; i++) {
        let gauss = exp(-f32(i * i) / (2.0 * sigma * sigma));
        for (var side = -1; side <= 1; side += 2) {
            let cell = clamp(pixel + axis * i * side, vec2<i32>(0), last);
            let weight = gauss * ssr_blur_weight(depth, normal, roughness, cell);
            sum += textureLoad(ssr_trace, cell, 0) * weight;
            total += weight;
        }
    }
    textureStore(ssr_out, pixel, sum / total);
}

@compute @workgroup_size(8, 8, 1)
fn cs_ssr_blur_x(@builtin(global_invocation_id) id: vec3<u32>) {
    ssr_blur(id.xy, vec2<i32>(1, 0));
}

@compute @workgroup_size(8, 8, 1)
fn cs_ssr_blur_y(@builtin(global_invocation_id) id: vec3<u32>) {
    ssr_blur(id.xy, vec2<i32>(0, 1));
}
