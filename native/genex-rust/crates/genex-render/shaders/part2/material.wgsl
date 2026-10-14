// genex WGSL extension API v1: the prelude of `Material::custom`. The renderer prepends it to the
// game's source; the game writes `@fragment fn fs_material(in: GxMaterialIn) -> @location(0)
// vec4<f32>` and, optionally, one `var<uniform>` at @group(2) @binding(0) (its parameters, at most
// EXTENSION_UNIFORM_MAX_BYTES). Nothing else may be bound and no other entry point declared.
// The fragment returns an sRGB-encoded colour (the world target is Bgra8Unorm); alpha is ignored:
// custom materials are opaque and depth-tested against the world.

// A prefix of the frozen v1 frame (GxFrameV1), never the renderer's own frame uniforms. sun_color
// and ambient are linear radiance.
struct GxFrame {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    camera_forward: vec4<f32>,
    sun_dir: vec4<f32>,
    sun_color: vec4<f32>,
    ambient: vec4<f32>,
}

// One custom draw: its model and normal matrices, its sRGB tint and x: the simulated time in
// seconds, y: the draw's index in the frame.
struct GxDraw {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    tint: vec4<f32>,
    params: vec4<f32>,
}

struct GxMaterialIn {
    @builtin(position) position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tint: vec4<f32>,
}

@group(0) @binding(0) var<uniform> gx_frame: GxFrame;
@group(1) @binding(0) var<uniform> gx_draw: GxDraw;

@vertex
fn gx_vs_material(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>) -> GxMaterialIn {
    let world = gx_draw.model * vec4<f32>(position, 1.0);
    var out: GxMaterialIn;
    out.position = gx_frame.view_proj * world;
    out.world_position = world.xyz;
    out.normal = normalize((gx_draw.normal * vec4<f32>(normal, 0.0)).xyz);
    out.uv = uv;
    out.tint = gx_draw.tint;
    return out;
}

/// sRGB-encoded → linear.
fn gx_srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

/// Linear → sRGB-encoded.
fn gx_linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let clamped = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = clamped * 12.92;
    let high = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, clamped <= vec3<f32>(0.0031308));
}

/// The sun's Lambert term plus ambient, as linear radiance, for a world-space normal.
fn gx_lambert(normal: vec3<f32>) -> vec3<f32> {
    let n_dot_l = max(dot(normalize(normal), normalize(gx_frame.sun_dir.xyz)), 0.0);
    return gx_frame.sun_color.rgb * n_dot_l + gx_frame.ambient.rgb;
}
