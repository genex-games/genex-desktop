// The terrain's sun casters (renderer pass 2 A.7): depth only, into one cascade's layer, over the
// sun casters' group (group 0: the frame), the pass view (group 1: the cascade's view) and the
// terrain group (group 2). A vertex morphs by the camera's distance as the world pass's does, so the
// shadow it casts is the ground the camera sees. Pancaking as every caster's (shadow_caster.wgsl).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<uniform> pass_view: PassView;

@vertex
fn vs_terrain_shadow(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ShadowCasterOut {
    let world = gx_terrain_vertex(gx_terrain_rows[instance], vertex, frame.camera_pos.xyz);
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * vec4<f32>(world, 1.0));
}
