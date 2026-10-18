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

// Game systems LOD-01: the fade band, the WGSL twin of `mesh_lod.rs` `lod_band` (kansei's
// stateless crossfade). x is the level `gx_lod_select` picks with every error scaled by `bias`;
// y is the share of its pixels it draws, in 1024ths: 1 whole, below 1 while its projected error is
// within the last `beta` of the threshold, the finer level drawing the rest. A distance that is not positive,
// a bias that is not finite and positive or a band outside [0, 1] draw the mesh itself whole.
// Expression for expression the CPU's, so every comparison is of correctly rounded products.
fn gx_lod_band(errors: vec4<f32>, levels: u32, distance: f32, pixels_per_unit: f32, threshold_px: f32, bias: f32, beta: f32) -> vec2<f32> {
    let usable = distance > 0.0 && bias > 0.0 && bias <= 3.40282347e38 && beta >= 0.0 && beta <= 1.0;
    if (!usable) {
        return vec2<f32>(0.0, 1.0);
    }
    let budget = threshold_px * distance;
    // Two-operand products only, as the CPU's: nothing left for a compiler to reassociate.
    let scale = pixels_per_unit * bias;
    var level = 0u;
    var fit = 0.0;
    for (var at = 0u; at < min(levels, 4u); at = at + 1u) {
        let projected = errors[at] * scale;
        if (projected <= budget) {
            level = at + 1u;
            fit = projected;
        }
    }
    // An infinite budget (an infinite distance) leaves no band: the coarsest level is whole.
    let whole = level == 0u || budget > 3.40282347e38 || fit <= (1.0 - beta) * budget;
    if (whole) {
        return vec2<f32>(f32(level), 1.0);
    }
    let steps = gx_lod_band_steps(budget - fit, beta * budget);
    if (steps >= 1024.0) {
        return vec2<f32>(f32(level), 1.0);
    }
    return vec2<f32>(f32(level), steps * (1.0 / 1024.0));
}

// The share fade / width in whole 1024ths, rounded down (mesh_lod.rs `band_steps`, with
// LOD_FADE_STEPS = 1024): the division only guesses, within one step; the two correctly rounded
// product comparisons decide, so a GPU whose division is not correctly rounded still lands on the
// CPU's step.
fn gx_lod_band_steps(fade: f32, width: f32) -> f32 {
    let scaled = fade * 1024.0;
    var steps = clamp(floor(fade / width * 1024.0), 0.0, 1024.0);
    let next = steps + 1.0;
    if (steps < 1024.0 && next * width <= scaled) {
        steps = next;
    }
    if (steps > 0.0 && steps * width > scaled) {
        steps = steps - 1.0;
    }
    return steps;
}
