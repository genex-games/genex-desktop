// Vertex-shader skinning (game systems AN-18): the prepass's entries, after the prepass module's
// sources. Group 2 is the motion node's (an empty group on a frame without motion), so the two
// tables sit at group 3. Motion comes from last frame's palette and model in the draw's record,
// with no skinned output kept.

@group(3) @binding(0) var<storage, read> skin_vertex_rows: array<SkinVertex>;
@group(3) @binding(1) var<storage, read> skin_vertex_table: array<mat4x4<f32>>;

// `vs_prepass`'s outputs for a vertex skinned here.
@vertex
fn vs_skin_vertex_prepass(in: PrepassIn, @builtin(vertex_index) vertex: u32, @builtin(instance_index) record: u32) -> PrepassOut {
    let draw = gx_skin_vertex_draw(record);
    let m = gx_skin_vertex_matrix(vertex, draw.skin_offset, draw.joint_base);
    let world = draw.model * vec4<f32>(gx_skin_vertex_position(m, in.position), 1.0);
    var out: PrepassOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (draw.normal * vec4<f32>(gx_skin_vertex_direction(m, in.normal), 0.0)).xyz;
    return out;
}

// `vs_prepass_motion`'s outputs for a vertex skinned here: last frame's position from last
// frame's palette and model (this frame's when the draw has no history).
@vertex
fn vs_skin_vertex_motion(in: PrepassIn, @builtin(vertex_index) vertex: u32, @builtin(instance_index) record: u32) -> MotionOut {
    let draw = gx_skin_vertex_draw(record);
    let m = gx_skin_vertex_matrix(vertex, draw.skin_offset, draw.joint_base);
    let world = draw.model * vec4<f32>(gx_skin_vertex_position(m, in.position), 1.0);
    let before = gx_skin_vertex_matrix(vertex, draw.skin_offset, draw.prev_joint_base);
    let prev_world = draw.prev_model * vec4<f32>(gx_skin_vertex_position(before, in.position), 1.0);
    var out: MotionOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (draw.normal * vec4<f32>(gx_skin_vertex_direction(m, in.normal), 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = draw.flags & GX_MOTION_NO_HISTORY;
    return out;
}
