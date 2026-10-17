// Present: the world target into the letterbox rectangle of a window target, with the bars cleared
// black by the pass. `fs_blit` copies texel for texel (a letterbox of the world's own size, or an
// image already at the letterbox's size); `fs_catmull_rom` filters the world down into a letterbox
// smaller than it (`letterbox::present`; a larger one goes through FSR1 EASU + RCAS). The world
// holds sRGB-encoded values; the `_decode` entry points are for an *Srgb window format, which
// would otherwise encode them a second time.

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

// The most world texels one unit of the Catmull-Rom kernel spans: a letterbox at a quarter of the
// world or smaller still reads at most 16 x 16 texels a pixel.
const CATMULL_ROM_FOOTPRINT_MAX: f32 = 4.0;

// The Catmull-Rom cubic (B = 0, C = 0.5) at `x` kernel units from the sample point.
fn catmull_rom_weight(x: f32) -> f32 {
    let a = abs(x);
    if a < 1.0 {
        return (1.5 * a - 2.5) * a * a + 1.0;
    }
    if a < 2.0 {
        return ((-0.5 * a + 2.5) * a - 4.0) * a + 2.0;
    }
    return 0.0;
}

// The world filtered at the window pixel `position` with the separable Catmull-Rom kernel. When
// the letterbox is smaller than the world the kernel widens by the ratio (up to
// CATMULL_ROM_FOOTPRINT_MAX), so every world texel under the pixel weighs in and nothing aliases;
// at 1:1 it is the usual 4 x 4 taps (loads, as the blit's layout has no sampler for the 9-tap
// bilinear form). The result is held to 0..1: the kernel's negative lobes overshoot hard edges.
fn world_catmull_rom(position: vec4<f32>) -> vec4<f32> {
    let local = position.xy - params.viewport.xy;
    let ratio = params.world.xy / params.viewport.zw;
    // The pixel centre in world texel units, texel i's centre at i.
    let centre = local * ratio - 0.5;
    let unit = clamp(ratio, vec2<f32>(1.0), vec2<f32>(CATMULL_ROM_FOOTPRINT_MAX));
    let first = vec2<i32>(floor(centre - 2.0 * unit)) + 1;
    let last = vec2<i32>(floor(centre + 2.0 * unit));
    let size = vec2<i32>(params.world.xy);
    var sum = vec3<f32>(0.0);
    var weight = 0.0;
    for (var y = first.y; y <= last.y; y += 1) {
        let wy = catmull_rom_weight((f32(y) - centre.y) / unit.y);
        for (var x = first.x; x <= last.x; x += 1) {
            let w = catmull_rom_weight((f32(x) - centre.x) / unit.x) * wy;
            let texel = clamp(vec2<i32>(x, y), vec2<i32>(0), size - 1);
            sum += textureLoad(world, texel, 0).rgb * w;
            weight += w;
        }
    }
    return vec4<f32>(clamp(sum / max(weight, 1.0e-6), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
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

@fragment
fn fs_catmull_rom(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return world_catmull_rom(position);
}

@fragment
fn fs_catmull_rom_decode(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(srgb_to_linear(world_catmull_rom(position).rgb), 1.0);
}
