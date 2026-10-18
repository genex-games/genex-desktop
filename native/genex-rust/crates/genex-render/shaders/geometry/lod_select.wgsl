// Renderer pass 2, A6.9: the level of detail a draw takes, the WGSL twin of `mesh::select_lod`.
// `errors` holds a chain's object-space errors (up to four levels, `levels` of them used, never
// decreasing); the answer is 0 for the mesh itself or k for the k-th simplified level: the
// coarsest whose error, seen at `distance` with `pixels_per_unit` pixels a world unit at distance
// 1, is at most `threshold_px`. Compared as error * pixels_per_unit <= threshold_px * distance:
// two correctly rounded products, so the CPU and every GPU pick the same level.
fn gx_lod_select(errors: vec4<f32>, levels: u32, distance: f32, pixels_per_unit: f32, threshold_px: f32) -> u32 {
    // NaN and a camera at or inside the mesh draw the mesh itself.
    if (!(distance > 0.0)) {
        return 0u;
    }
    let budget = threshold_px * distance;
    var picked = 0u;
    for (var level = 0u; level < min(levels, 4u); level = level + 1u) {
        if (errors[level] * pixels_per_unit <= budget) {
            picked = level + 1u;
        }
    }
    return picked;
}
