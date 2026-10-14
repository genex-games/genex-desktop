
// The identity post pass: the frame as it is.
@fragment
fn fs_post(in: GxPostIn) -> @location(0) vec4<f32> {
    return textureSampleLevel(gx_source, gx_sampler, in.uv, 0.0);
}
