// Vertex-shader skinning (game systems AN-18): the sun casters' entry, after the shadow module's
// sources (the casters' bias and pancaking are every caster's).

@group(2) @binding(0) var<storage, read> skin_vertex_rows: array<SkinVertex>;
@group(2) @binding(1) var<storage, read> skin_vertex_table: array<mat4x4<f32>>;

@vertex
fn vs_skin_vertex_shadow(@location(0) position: vec3<f32>, @builtin(vertex_index) vertex: u32, @builtin(instance_index) record: u32) -> ShadowCasterOut {
    let draw = gx_skin_vertex_draw(record);
    let m = gx_skin_vertex_matrix(vertex, draw.skin_offset, draw.joint_base);
    let world = draw.model * vec4<f32>(gx_skin_vertex_position(m, position), 1.0);
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * world);
}
