// The sample's Level-2 custom material (extension API v2, `gfx.material` under an `api = 2` row): a
// base colour from the game's uniform block lit by the renderer's own shading (`gx_shade_pbr`: the
// sun through its shadows, the point lights and fog), with a rim that pulses with the simulated
// time, added in scene units through `gx_expose`. The renderer prepends the v2 prelude (`frame`,
// `gx_draw`, `GxMaterialInV2`, the lighting chunks, the sRGB helpers), so it draws on the HDR
// scene and on the legacy LDR scene alike (the halo, a v1 in-world pass, keeps the whole sample's
// frame LDR).

struct Glow {
    // rgb: the base colour (sRGB), a: the rim's strength.
    color: vec4<f32>,
    // rgb: the rim's colour (sRGB), a: pulses per second.
    rim: vec4<f32>,
}

@group(2) @binding(0) var<uniform> glow: Glow;

@fragment
fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let base = gx_srgb_to_linear(glow.color.rgb) * in.tint.rgb;
    let surface = gx_surface_v2(in.world_position, in.normal, base, 0.0, 0.55);
    let to_eye = normalize(frame.camera_pos.xyz - in.world_position);
    let facing = 1.0 - clamp(dot(normalize(in.normal), to_eye), 0.0, 1.0);
    let pulse = 0.75 + 0.25 * sin(6.2831853 * glow.rim.a * gx_draw.params.x);
    let rim = gx_srgb_to_linear(glow.rim.rgb) * (facing * facing * glow.color.a * pulse);
    return vec4<f32>(gx_shade_pbr(surface) + gx_expose(rim), 1.0);
}
