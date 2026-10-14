// A Level-3 pass at API v2, at `post-hdr`: warms the HDR scene before the tonemap, multiplying it
// by a constant tint through the blend (so it reads no input of its own and works on every scene
// format the renderer blends: rgba16float, rg11b10ufloat and the legacy LDR scene).
const WARM: vec3<f32> = vec3<f32>(1.0, 0.97, 0.92);

@vertex
fn vs_warm(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_warm() -> @location(0) vec4<f32> {
    return vec4<f32>(WARM, 1.0);
}
