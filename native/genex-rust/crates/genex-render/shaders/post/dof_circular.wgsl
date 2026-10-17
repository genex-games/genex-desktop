// The circular tier's gather (A.9): a port of Godot 4.7.2's single-pass circular bokeh
// (servers/rendering/renderer_rd/shaders/effects/bokeh_dof_raster.glsl, MODE_BOKEH_CIRCULAR; MIT,
// Copyright (c) 2014-present Godot Engine contributors), after Tuxedo Labs' "Bokeh depth of field
// in a single pass" (2018). A golden-angle spiral over the half-resolution colour whose CoC rides
// in its alpha, read texel by texel. Godot's loop runs to the largest blur for every pixel; here it stops at the
// dilated tile's largest CoC and spends at most `dof.scale.w` samples on the way.

// The golden angle's rotation (cos, sin of 2.39996323 rad): the spiral turns by it each sample,
// one multiply instead of a cos and a sin.
const DOF_GOLDEN_ROTATION: vec2<f32> = vec2<f32>(-0.73736887, 0.67549029);

// The gathered colour (rgb) and the gathered CoC (a), at half resolution.
@fragment
fn fs_dof_circular(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = frag.xy * dof.size.zw;
    let centre = textureSampleLevel(dof_colour, dof_nearest, uv, 0.0);
    let tiles = textureLoad(dof_ring_tiles, vec2<i32>(frag.xy) / DOF_TILE_HALF_TEXELS, 0).rg;
    if dof_trivial_tile(tiles) {
        return centre;
    }
    // The farthest a sample can reach this pixel from, and the radius step that gets there in
    // the sample budget (the radius grows by step / radius: about reach^2 / (2 step) samples).
    let reach = min(max(-tiles.x, tiles.y), dof.coc.w);
    let step = max(1.0, reach * reach / (2.0 * dof.scale.w));
    var accum = centre;
    var total = 1.0;
    var radius = 1.0;
    var direction = vec2<f32>(1.0, 0.0);
    loop {
        if radius >= reach + 0.5 {
            break;
        }
        // Nearest texels: a bilinear tap across a depth edge mixes a sharp prop's colour into a CoC
        // large enough to reach (Filament: "not safe to use bilinear filtering").
        let s = textureSampleLevel(dof_colour, dof_nearest, uv + direction * radius * dof.scale.xy, 0.0);
        // A sample behind the centre blurs over it no more than the centre's own CoC allows: a
        // sharp foreground keeps its edge against the blurred background.
        var limit = abs(s.a);
        if s.a > centre.a {
            limit = clamp(limit, 0.0, abs(centre.a) * 2.0);
        }
        let m = smoothstep(radius - 0.5, radius + 0.5, limit);
        accum += mix(accum / total, s, m);
        total += 1.0;
        radius += step / radius;
        direction = vec2<f32>(direction.x * DOF_GOLDEN_ROTATION.x - direction.y * DOF_GOLDEN_ROTATION.y, direction.x * DOF_GOLDEN_ROTATION.y + direction.y * DOF_GOLDEN_ROTATION.x);
    }
    return accum / total;
}
