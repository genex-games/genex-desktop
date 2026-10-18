// The grass's sun casters (renderer pass 2 A.8): depth only, into the nearest cascade's layer,
// over the sun casters' group (group 0: the frame), the pass view (group 1: the cascade's view)
// and the grass group (group 2). The blades are the camera's (the generation culls for the camera
// only), at this frame's sway, so the shadow a blade casts is the blade the camera sees. Pancaking
// as every caster's (shadow_caster.wgsl).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> pass_view: PassView;

@vertex
fn vs_grass_shadow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ShadowCasterOut {
    let blade = gx_grass_blade(instance);
    let point = gx_grass_point(blade, vertex, gx_grass.time.x, frame.camera_pos.xyz);
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * vec4<f32>(point.position, 1.0));
}
