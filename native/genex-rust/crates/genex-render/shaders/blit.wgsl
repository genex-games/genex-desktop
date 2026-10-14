// Present: the world target into the letterbox rectangle of a window target, nearest texel, with
// the bars cleared black by the pass. The world holds sRGB-encoded values; `fs_blit_decode` is for
// an *Srgb window format, which would otherwise encode them a second time.

struct BlitParams {
    // The letterbox rectangle in window pixels: x, y, width, height.
    viewport: vec4<f32>,
    // The world target's width and height; z, w unused.
    world: vec4<f32>,
}

@group(0) @binding(0) var world: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: BlitParams;

@vertex
fn vs_blit(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn world_texel(position: vec4<f32>) -> vec4<f32> {
    let local = position.xy - params.viewport.xy;
    let size = vec2<i32>(params.world.xy);
    let texel = clamp(vec2<i32>(floor(local * params.world.xy / params.viewport.zw)), vec2<i32>(0), size - 1);
    return textureLoad(world, texel, 0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_blit(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(world_texel(position).rgb, 1.0);
}

@fragment
fn fs_blit_decode(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(srgb_to_linear(world_texel(position).rgb), 1.0);
}
