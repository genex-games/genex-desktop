// Motion blur (renderer pass 2, A.9 / prior-art A7.3; mirrors `post::motion_blur::GpuMotionBlurParams`).
// Shared by the tile passes (motion_blur_tiles.wgsl) and the blurs (motion_blur.wgsl: the
// reconstruction tier, a port of keijiro/KinoMotion's Reconstruction.cginc, MIT, after McGuire et
// al. 2012; the direct tier, after Bevy 0.20.0's motion_blur.wesl, MIT OR Apache-2.0). Every
// velocity is half the shutter's exposure vector in render pixels (x right, y down), clamped to
// the largest blur radius: a pixel is blurred over its position plus and minus it.
struct MotionBlurParams {
    // xy: the NDC motion (current - previous) to half the exposure vector in render pixels; z: the
    // largest blur radius, render pixels; w: its reciprocal.
    velocity: vec4<f32>,
    // xy: the render size; z: the tile side, render pixels; w: the 1/16-resolution texels a tile
    // spans per side.
    size: vec4<f32>,
    // The view distance at depth-buffer value z: |x + y z| / max(|z' + w z|, tiny) with
    // (x, y, z', w) these four (a perspective or an orthographic projection, either depth order).
    depth: vec4<f32>,
    // x: the reconstruction's sample pairs at most; y: the direct tier's samples per side at most; z: the
    // tile velocity (px) below which the reconstruction passes the scene through; w: the velocity
    // (px) below which the direct tier passes a pixel through.
    samples: vec4<f32>,
}

@group(0) @binding(0) var<uniform> mb: MotionBlurParams;
// The prepass's NDC motion (render size, 1x).
@group(0) @binding(1) var mb_motion: texture_2d<f32>;

const MB_PI: f32 = 3.14159265358979;

// The fullscreen triangle every pass draws.
@vertex
fn vs_motion_blur(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

// The last render pixel.
fn mb_last() -> vec2<i32> {
    return vec2<i32>(mb.size.xy) - vec2<i32>(1);
}

// The velocity at render pixel `p` (clamped to the render size): half the exposure vector in
// render pixels, no longer than the largest blur radius (KinoMotion's VelocitySetup).
fn mb_velocity(p: vec2<i32>) -> vec2<f32> {
    let motion = textureLoad(mb_motion, clamp(p, vec2<i32>(0), mb_last()), 0).xy;
    let v = motion * mb.velocity.xy;
    return v / max(1.0, length(v) * mb.velocity.w);
}

// The longer of two vectors (KinoMotion's VMax).
fn mb_vmax(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return select(a, b, dot(a, a) < dot(b, b));
}

// Interleaved gradient noise (Jimenez 2014), keyed by the pixel only (noise drawn after TAA is
// never resolved): the reconstruction's tile lookup jitter.
fn mb_noise(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(floor(p), vec2<f32>(0.06711056, 0.00583715))));
}
