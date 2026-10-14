// A Level-3 pass at API v2, at `after-prepass`: reads the frame's prepass depth at the centre of
// the screen into a buffer of its own (work that needs the scene's depth before the world pass).
@group(0) @binding(3) var gx_depth: texture_depth_2d;
@group(1) @binding(0) var<storage, read_write> probe: array<f32>;

@compute @workgroup_size(1)
fn cs_probe() {
    let size = vec2<i32>(textureDimensions(gx_depth));
    probe[0] = textureLoad(gx_depth, size / 2, 0);
}
