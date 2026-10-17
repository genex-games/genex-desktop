// Motion blur's depth read: sample 0 of a multisampled depth (frames without the prepass).
@group(0) @binding(2) var mb_depth: texture_depth_multisampled_2d;

// The depth-buffer value at render pixel `p` (clamped to the render size).
fn mb_depth_at(p: vec2<i32>) -> f32 {
    return textureLoad(mb_depth, clamp(p, vec2<i32>(0), mb_last()), 0);
}
