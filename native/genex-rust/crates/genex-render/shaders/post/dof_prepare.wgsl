// The depth of field's prepare passes (A.9): the half-resolution colour with its CoC, its mips,
// the 16 px min/max CoC tiles and their dilation. Ported from Filament v1.77.3
// (materials/dof/dofDownsample.mat, dofMipmap.mat, dofTiles.mat, dofDilate.mat; Apache-2.0).

// The HDR scene at render size.
@group(0) @binding(1) var dof_scene: texture_2d<f32>;
// One mip of the half-resolution colour (the level a pass reads).
@group(0) @binding(4) var dof_source: texture_2d<f32>;
// The min/max CoC tiles.
@group(0) @binding(5) var dof_tiles: texture_2d<f32>;
// Nearest texels (the quarter tiles' gathers).
@group(0) @binding(6) var dof_point: sampler;

// The 2x2 block of render pixels under half-resolution texel `frag`: the scene's mean and the
// block's smallest CoC (the foreground wins: it may spread over the background, never the
// reverse; Filament's downsampleCoC). Filament also weighs each pixel by Karis' 1 / (1 + max),
// which darkens a blurred bright-and-dark pattern by a fifth and dims every bokeh highlight; the
// scene here is TAA's resolve, whose fireflies TAA already tamed, so the mean keeps the energy.
@fragment
fn fs_dof_downsample(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let base = vec2<i32>(frag.xy) * 2;
    let last = vec2<i32>(dof.size.xy) - vec2<i32>(1);
    var colour = vec3<f32>(0.0);
    var coc = DOF_MAX_COC_RADIUS * 4.0;
    for (var i = 0; i < 4; i++) {
        let p = min(base + vec2<i32>(i & 1, i >> 1u), last);
        colour += textureLoad(dof_scene, p, 0).rgb;
        coc = min(coc, dof_coc(dof_depth_at(p)));
    }
    return vec4<f32>(colour * 0.25, coc);
}

// The next mip of the half-resolution colour: the 2x2 mean and the smallest CoC (Filament's
// dofMipmap, whose bilateral weights all resolve to 1).
@fragment
fn fs_dof_mip(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let base = vec2<i32>(frag.xy) * 2;
    let last = dof_last(textureDimensions(dof_source));
    var colour = vec3<f32>(0.0);
    var coc = DOF_MAX_COC_RADIUS * 4.0;
    for (var i = 0; i < 4; i++) {
        let s = textureLoad(dof_source, min(base + vec2<i32>(i & 1, i >> 1u), last), 0);
        colour += s.rgb;
        coc = min(coc, s.a);
    }
    return vec4<f32>(colour * 0.25, coc);
}

// The smallest and largest CoC over 4x4 half-resolution texels: a quarter tile (Filament's first
// two reductions of dofTiles; one pass of 64 loads a tile left the GPU a thread per tile, and it
// cost 0.2 ms at 1080p).
@fragment
fn fs_dof_tiles_quarter(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    // Four gathers of the CoC (alpha), each the 2x2 texels around a texel corner: the quarter
    // tile's 4x4 block lies inside the half-resolution size (whole tiles), so no read clamps.
    let texel = 1.0 / vec2<f32>(textureDimensions(dof_source));
    let corner = floor(frag.xy) * 4.0;
    let a = textureGather(3, dof_source, dof_point, (corner + vec2<f32>(1.0, 1.0)) * texel);
    let b = textureGather(3, dof_source, dof_point, (corner + vec2<f32>(3.0, 1.0)) * texel);
    let c = textureGather(3, dof_source, dof_point, (corner + vec2<f32>(1.0, 3.0)) * texel);
    let d = textureGather(3, dof_source, dof_point, (corner + vec2<f32>(3.0, 3.0)) * texel);
    let low = min(min(a, b), min(c, d));
    let high = max(max(a, b), max(c, d));
    return vec4<f32>(min(min(low.x, low.y), min(low.z, low.w)), max(max(high.x, high.y), max(high.z, high.w)), 0.0, 0.0);
}

// A tile's smallest and largest CoC: the 2x2 quarter tiles under it (Filament's last reduction).
@fragment
fn fs_dof_tiles(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let base = vec2<i32>(frag.xy) * 2;
    let last = dof_last(textureDimensions(dof_tiles));
    var range = vec2<f32>(DOF_MAX_COC_RADIUS * 4.0, -DOF_MAX_COC_RADIUS * 4.0);
    for (var i = 0; i < 4; i++) {
        let quarter = textureLoad(dof_tiles, min(base + vec2<i32>(i & 1, i >> 1u), last), 0).rg;
        range = vec2<f32>(min(range.x, quarter.x), max(range.y, quarter.y));
    }
    return vec4<f32>(range, 0.0, 0.0);
}

// Each tile takes its neighbours' CoC two tiles around (Filament's two rounds of dofDilate: a
// 32 px CoC from a tile two tiles away reaches it): the smallest foreground and the largest
// background.
@fragment
fn fs_dof_dilate(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let centre = vec2<i32>(frag.xy);
    let last = dof_last(textureDimensions(dof_tiles));
    var range = textureLoad(dof_tiles, centre, 0).rg;
    for (var y = -2; y <= 2; y++) {
        for (var x = -2; x <= 2; x++) {
            let tap = textureLoad(dof_tiles, clamp(centre + vec2<i32>(x, y), vec2<i32>(0), last), 0).rg;
            range = vec2<f32>(min(range.x, tap.x), max(range.y, tap.y));
        }
    }
    return vec4<f32>(range, 0.0, 0.0);
}
