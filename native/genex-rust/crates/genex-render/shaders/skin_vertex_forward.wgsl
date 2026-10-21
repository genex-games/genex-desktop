// Vertex-shader skinning (game systems AN-18): the world pass's entry, after the forward module's
// sources, so a far character shades through `fs_main` exactly as a compute-skinned one does.

@group(2) @binding(0) var<storage, read> skin_vertex_rows: array<SkinVertex>;
@group(2) @binding(1) var<storage, read> skin_vertex_table: array<mat4x4<f32>>;

// `vs_main`'s outputs for a vertex skinned here (the draw's record at its instance index).
@vertex
fn vs_skin_vertex(in: VsIn, @builtin(vertex_index) vertex: u32, @builtin(instance_index) record: u32) -> VsOut {
    let draw = gx_skin_vertex_draw(record);
    let m = gx_skin_vertex_matrix(vertex, draw.skin_offset, draw.joint_base);
    let world = draw.model * vec4<f32>(gx_skin_vertex_position(m, in.position), 1.0);
    var out: VsOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.world_pos = world.xyz;
    out.normal = (draw.normal * vec4<f32>(gx_skin_vertex_direction(m, in.normal), 0.0)).xyz;
    out.uv = in.uv;
    out.tangent = vec4<f32>((draw.model * vec4<f32>(gx_skin_vertex_direction(m, in.tangent.xyz), 0.0)).xyz, in.tangent.w);
    out.material = draw.material;
    return out;
}
