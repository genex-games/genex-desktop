// genex WGSL extension API v1: the prelude of `post_pass`. The renderer prepends it to the game's
// source; the game writes `@fragment fn fs_post(in: GxPostIn) -> @location(0) vec4<f32>` and,
// optionally, one `var<uniform>` at @group(1) @binding(0) (its parameters, at most
// EXTENSION_UNIFORM_MAX_BYTES). Nothing else may be bound and no other entry point declared.
// `gx_source` is the frame so far (sRGB-encoded, Bgra8Unorm read as rgba); the fragment's output
// replaces it, alpha ignored. Post passes run after the 2D primitives and before the HUD.

// x, y: the world target's size in pixels; z, w: one pixel in uv.
// params x: the simulated time in seconds, y: the pass's index in the frame.
struct GxPost {
    size: vec4<f32>,
    params: vec4<f32>,
}

struct GxPostIn {
    @builtin(position) position: vec4<f32>,
    // (0, 0) the top-left corner, (1, 1) the bottom-right.
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var gx_source: texture_2d<f32>;
@group(0) @binding(1) var gx_sampler: sampler;
@group(0) @binding(2) var<uniform> gx_post: GxPost;

@vertex
fn gx_vs_post(@builtin(vertex_index) index: u32) -> GxPostIn {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: GxPostIn;
    out.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}
