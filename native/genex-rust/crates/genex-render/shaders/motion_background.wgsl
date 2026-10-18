// Background motion (renderer pass 2, P2-0.8b, T-03): the motion of the pixels no geometry drew
// (the sky, its sun disc, the fog horizon and later the cloud panorama), written into the motion
// prepass's motion target after its geometry. One full-screen triangle at the far plane, tested
// `Equal` against the cleared depth (no writes), so it lands only where the depth stayed clear.
// A pixel's direction is reprojected through `reproject` (last frame's unjittered view_proj x this
// frame's inverse) at device depth far, the camera's own motion: a turning camera moves the sky by
// the turn. After Bevy v0.20 `background_motion_vectors.wesl` (MIT OR Apache-2.0) and Snapdragon
// GSR 2's convert pass (`sgsr2_convert.fs`, BSD-3-Clause), both ideas only.
//
// Only the motion target (location 1) is written: the normals keep their clear and the reactive
// mask keeps 0 (the sky keeps its history).

// Mirrors `motion::GpuMotionFrame` (prepass.wgsl's `MotionFrame`).
struct MotionFrame {
    prev_view_proj: mat4x4<f32>,
    // xy: this frame's jitter in NDC (y up); zw: reserved (0).
    jitter: vec4<f32>,
    // Last frame's unjittered view_proj x this frame's inverse.
    reproject: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> motion_frame: MotionFrame;

// Whether depth is reversed (far at 0) or standard (far at 1): the pipeline's convention.
override GX_DEPTH_REVERSED: bool = true;

struct BackgroundOut {
    @builtin(position) clip: vec4<f32>,
    // This pixel's unjittered NDC, and where its direction sat in last frame's clip space: both
    // linear in the screen position (a projective map is linear in homogeneous coordinates), so
    // screen-linear interpolation is exact and the divide happens per fragment.
    @location(0) @interpolate(linear) current: vec2<f32>,
    @location(1) @interpolate(linear) previous: vec4<f32>,
}

@vertex
fn vs_background_motion(@builtin(vertex_index) vertex: u32) -> BackgroundOut {
    // (-1, -1), (3, -1), (-1, 3): one triangle over the whole target.
    let ndc = vec2<f32>(f32(vertex & 1u) * 4.0 - 1.0, f32(vertex >> 1u) * 4.0 - 1.0);
    let far = select(1.0, 0.0, GX_DEPTH_REVERSED);
    let unjittered = ndc - motion_frame.jitter.xy;
    var out: BackgroundOut;
    out.clip = vec4<f32>(ndc, far, 1.0);
    out.current = unjittered;
    out.previous = motion_frame.reproject * vec4<f32>(unjittered, far, 1.0);
    return out;
}

@fragment
fn fs_background_motion(in: BackgroundOut) -> @location(1) vec2<f32> {
    // A direction behind last frame's camera has no reprojection: no motion.
    if in.previous.w <= 1e-6 {
        return vec2<f32>(0.0);
    }
    return in.current - in.previous.xy / in.previous.w;
}
