
// The default custom material: the tint, lit by the sun.
@fragment
fn fs_material(in: GxMaterialIn) -> @location(0) vec4<f32> {
    let lit = gx_srgb_to_linear(in.tint.rgb) * gx_lambert(in.normal);
    return vec4<f32>(gx_linear_to_srgb(lit), 1.0);
}
