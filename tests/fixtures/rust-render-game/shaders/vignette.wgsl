// A Level-2 post pass at API v2: a soft vignette on the display-ready frame, after the tonemap.
@fragment fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let uv = gx_scene_uv(in.position);
    let color = textureSampleLevel(gx_scene, gx_sampler, uv, 0.0);
    let edge = smoothstep(0.4, 0.9, distance(uv, vec2<f32>(0.5)));
    return vec4<f32>(color.rgb * (1.0 - 0.3 * edge), color.a);
}
