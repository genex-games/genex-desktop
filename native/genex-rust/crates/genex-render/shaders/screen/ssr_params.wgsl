// The Hi-Z screen-space reflections' parameters (renderer pass 2 B.9), shared by the trace and the
// resolve; mirrors `ssr::GpuSsrParams`. Godot's push constants become this uniform (WebGPU core
// has no push constants).

struct SsrParams {
    proj: mat4x4<f32>,
    inv_proj: mat4x4<f32>,
    // World to view (rotation part used for normals).
    view: mat4x4<f32>,
    // This frame's NDC (x, y, device depth) to last frame's clip space.
    reprojection: mat4x4<f32>,
    // xy: trace size (half the render size); zw: render size.
    size: vec4<u32>,
    // x: steps; y: Hi-Z mips; z: 1 under reverse-Z; w: 1 under an orthographic projection.
    knobs: vec4<u32>,
    // x: depth tolerance (view units); y: the ray's screen length where the fade-out starts;
    // z: curve fade-in exponent;
    // w: the roughness from which nothing is traced.
    tune: vec4<f32>,
    // x: the colour pyramid's last mip; y: radiance scale (last frame's colour to this frame's);
    // z: the roughness from which a reflection fades towards the cutoff; w: unused.
    extra: vec4<f32>,
}
