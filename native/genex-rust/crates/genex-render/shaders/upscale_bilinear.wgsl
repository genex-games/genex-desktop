// Upscale (frame graph node 22): the scene drawn at a render scale below 1 into its step-sized
// target, stretched over the whole world target with one full-screen triangle, then sharpened. At
// scale 1 the node does not run and the scene is the world target itself.
//
// The scene holds sRGB-encoded Bgra8Unorm values; it is sampled through its sRGB view, so the
// bilinear filter blends linear light (a bright lamp against dark wood keeps its energy instead of
// darkening the mix). A contrast-adaptive sharpen in the manner of FSR 1's RCAS, in one pass, then
// restores the edges the stretch softens: the bilinear value at this pixel and at its four
// output-space neighbours, back in perceptual (sRGB) space, with a lobe limited so it never
// overshoots the neighbourhood's range. The result is written sRGB-encoded, as the world target
// holds. WebGPU core only: five filtered samples, derivatives of the triangle's uv.

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var scene_sampler: sampler;

// The sharpness: RCAS's sharpness of 0.2 stops (exp2(-0.2)), its usual default.
const SHARPNESS: f32 = 0.87055;
// RCAS's lobe limit (0.25 - 1/16): the sharpen never inverts a neighbourhood.
const LOBE_LIMIT: f32 = 0.1875;

struct UpscaleOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_upscale(@builtin(vertex_index) index: u32) -> UpscaleOut {
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: UpscaleOut;
    out.clip = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
    out.uv = corner;
    return out;
}

fn encode_srgb(linear: vec3<f32>) -> vec3<f32> {
    let c = clamp(linear, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = c * 12.92;
    let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3<f32>(0.0031308));
}

// The bilinear (linear-light) scene at `uv`, sRGB-encoded.
fn tap(uv: vec2<f32>) -> vec3<f32> {
    return encode_srgb(textureSampleLevel(scene, scene_sampler, uv, 0.0).rgb);
}

fn max3(v: vec3<f32>) -> f32 {
    return max(v.x, max(v.y, v.z));
}

@fragment
fn fs_upscale(in: UpscaleOut) -> @location(0) vec4<f32> {
    // One output pixel in uv: the triangle's uv is linear across the screen.
    let px = vec2<f32>(dpdx(in.uv).x, dpdy(in.uv).y);
    let e = tap(in.uv);
    let b = tap(in.uv - vec2<f32>(0.0, px.y));
    let d = tap(in.uv - vec2<f32>(px.x, 0.0));
    let f = tap(in.uv + vec2<f32>(px.x, 0.0));
    let h = tap(in.uv + vec2<f32>(0.0, px.y));
    let lo = min(min(b, d), min(f, h));
    let hi = max(max(b, d), max(f, h));
    // How far a negative lobe may go before the result leaves [min, max] of the cross.
    let hit_min = min(lo, e) / max(4.0 * hi, vec3<f32>(1.0e-5));
    let hit_max = (vec3<f32>(1.0) - max(hi, e)) / min(4.0 * lo - 4.0, vec3<f32>(-1.0e-5));
    let lobe_rgb = max(-hit_min, hit_max);
    let lobe = max(-LOBE_LIMIT, min(max3(lobe_rgb), 0.0)) * SHARPNESS;
    let sharpened = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
    return vec4<f32>(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
