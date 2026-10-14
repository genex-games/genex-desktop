// A Level-2 material at API v2: a coloured surface the renderer shades as it shades its own (sun,
// shadows, lights, environment, ambient occlusion, fog), with a glow of its own on top.
struct Params {
    color: vec4<f32>,
    glow: vec4<f32>,
}
@group(2) @binding(0) var<uniform> params: Params;

@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let n = normalize(in.normal);
    let surface = gx_filter_specular_v2(gx_surface_v2(in.world_position, n, gx_srgb_to_linear(params.color.rgb), 0.2, 0.35), dpdx(n), dpdy(n));
    return vec4<f32>(gx_shade_pbr(surface) + gx_expose(params.glow.rgb * params.glow.w), 1.0);
}
