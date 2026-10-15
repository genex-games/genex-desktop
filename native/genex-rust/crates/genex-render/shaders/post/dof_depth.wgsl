// The depth of field's depth read: a single-sampled depth (the prepass's).
@group(0) @binding(2) var dof_depth: texture_depth_2d;

// The depth-buffer value at render pixel `p` (clamped to the render size).
fn dof_depth_at(p: vec2<i32>) -> f32 {
    let last = vec2<i32>(dof.size.xy) - vec2<i32>(1);
    return textureLoad(dof_depth, clamp(p, vec2<i32>(0), last), 0);
}
