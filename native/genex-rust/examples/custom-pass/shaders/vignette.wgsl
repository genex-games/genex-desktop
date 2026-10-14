// The sample's Level-2 post pass (extension API v1, `gfx.post_pass`): a warm vignette over the
// finished frame, before the Level-3 CRT filter and the HUD. The renderer prepends the post prelude
// (gx_source, gx_sampler, gx_post, GxPostIn).

struct Vignette {
    // rgb: the edge tint (sRGB), a: the vignette's strength.
    tint: vec4<f32>,
}

@group(1) @binding(0) var<uniform> vignette: Vignette;

@fragment
fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> {
    let color = textureSample(gx_source, gx_sampler, in.uv).rgb;
    let from_centre = in.uv - vec2<f32>(0.5);
    let edge = clamp(dot(from_centre, from_centre) * 2.0, 0.0, 1.0) * vignette.tint.a;
    return vec4<f32>(mix(color, color * vignette.tint.rgb, edge), 1.0);
}
