// The depth of field's full-resolution combines (A.9): the ring tier's (a port of Filament
// v1.77.3's materials/dof/dofCombine.mat, Apache-2.0) and the circular tier's (Godot 4.7.2's
// MODE_COMPOSITE_BOKEH, MIT, read with a CoC-aware upsample). In-focus tiles pass the scene
// through unchanged.

// The HDR scene at render size.
@group(0) @binding(1) var dof_scene: texture_2d<f32>;
// The dilated min/max CoC tiles.
@group(0) @binding(5) var dof_tiles: texture_2d<f32>;
// Linear texels (the half-resolution result's upsample).
@group(0) @binding(7) var dof_linear: sampler;
// The half-resolution result: the ring tier's median (rgb premultiplied, a coverage) or the
// circular gather (rgb colour, a the gathered CoC).
@group(0) @binding(8) var dof_blurred: texture_2d<f32>;

// The half-resolution uv of full-resolution fragment `frag`.
fn dof_half_uv(frag: vec2<f32>) -> vec2<f32> {
    return frag * dof.scale.xy;
}

// The ring tier: the blurred layer over the scene by its coverage.
@fragment
fn fs_dof_combine(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(frag.xy);
    let scene = textureLoad(dof_scene, p, 0);
    let tiles = textureLoad(dof_tiles, p / (DOF_TILE_HALF_TEXELS * 2), 0).rg;
    if dof_trivial_tile(tiles) {
        return scene;
    }
    let blurred = textureSampleLevel(dof_blurred, dof_linear, dof_half_uv(frag.xy), 0.0);
    // A constant-CoC tile well out of focus is all blur.
    if dof_fast_tile(tiles) && abs(tiles.x) >= DOF_MAX_IN_FOCUS_COC + 1.0 {
        return vec4<f32>(blurred.rgb, scene.a);
    }
    return vec4<f32>(blurred.rgb + (1.0 - blurred.a) * scene.rgb, scene.a);
}

// The circular tier's gather at `frag`, its four nearest texels weighted bilinearly and by how
// close their gathered CoC is to the pixel's own `coc` (a texel across a depth edge does not
// smear its side over this one).
fn dof_circular_upsample(frag: vec2<f32>, coc: f32) -> vec4<f32> {
    let size = vec2<f32>(textureDimensions(dof_blurred));
    let position = dof_half_uv(frag) * size - 0.5;
    let base = vec2<i32>(floor(position));
    let f = position - floor(position);
    let last = dof_last(textureDimensions(dof_blurred));
    let t00 = textureLoad(dof_blurred, clamp(base, vec2<i32>(0), last), 0);
    let t10 = textureLoad(dof_blurred, clamp(base + vec2<i32>(1, 0), vec2<i32>(0), last), 0);
    let t01 = textureLoad(dof_blurred, clamp(base + vec2<i32>(0, 1), vec2<i32>(0), last), 0);
    let t11 = textureLoad(dof_blurred, clamp(base + vec2<i32>(1, 1), vec2<i32>(0), last), 0);
    var w = vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    let cocs = vec4<f32>(t00.a, t10.a, t01.a, t11.a);
    // Texels of about one CoC: plain bilinear; across a depth edge, weighed by CoC likeness.
    let spread = max(max(cocs.x, cocs.y), max(cocs.z, cocs.w)) - min(min(cocs.x, cocs.y), min(cocs.z, cocs.w));
    if spread > 1.0 {
        w = w / (vec4<f32>(0.05) + abs(cocs - vec4<f32>(coc)));
    }
    return (t00 * w.x + t10 * w.y + t01 * w.z + t11 * w.w) / max(dot(w, vec4<f32>(1.0)), DOF_WEIGHT_MIN);
}

// The circular tier: the gather mixed over the scene by the pixel's CoC, or by the gathered CoC
// where a nearer blur covers it (Godot's composite).
@fragment
fn fs_dof_composite(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(frag.xy);
    let scene = textureLoad(dof_scene, p, 0);
    let tiles = textureLoad(dof_tiles, p / (DOF_TILE_HALF_TEXELS * 2), 0).rg;
    if dof_trivial_tile(tiles) {
        return scene;
    }
    let centre = dof_coc(dof_depth_at(p));
    let blurred = dof_circular_upsample(frag.xy, centre);
    // The pixel's own blur ramps in over its second pixel of CoC; a nearer blur covers it as far
    // as its gathered CoC says (an average over the spiral: Godot's |weight|).
    var amount = dof_coc_to_alpha(centre);
    if blurred.a < centre {
        amount = max(amount, saturate(abs(blurred.a)));
    }
    return vec4<f32>(mix(scene.rgb, blurred.rgb, amount), scene.a);
}
