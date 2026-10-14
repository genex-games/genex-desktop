// The CRT filter: reads a copy of the finished world target and darkens every third row (rolling
// with the tick) and the corners, before the HUD paints over it.

struct Crt {
    // x: the tick.
    params: vec4<f32>,
}

struct VsOut {
    @builtin(position) position: vec4<f32>,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> crt: Crt;

@vertex
fn vs_crt(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_crt(in: VsOut) -> @location(0) vec4<f32> {
    let pixel = vec2<i32>(in.position.xy);
    let color = textureLoad(source, pixel, 0).rgb;
    let row = (u32(pixel.y) + u32(crt.params.x)) % 3u;
    let scan = select(1.0, 0.7, row == 0u);
    let size = vec2<f32>(textureDimensions(source));
    let centered = in.position.xy / size - vec2<f32>(0.5);
    let vignette = clamp(1.2 - dot(centered, centered) * 1.6, 0.0, 1.0);
    return vec4<f32>(color * scan * vignette, 1.0);
}
