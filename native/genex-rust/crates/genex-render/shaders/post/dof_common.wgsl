// Gather depth of field (renderer pass 2, A.9; mirrors `post::dof::GpuDofParams`). Shared by the
// prepare passes (dof_prepare.wgsl), the gathers (dof_ring.wgsl, a port of Filament v1.77.3's
// materials/dof, Apache-2.0; dof_circular.wgsl, a port of Godot 4.7.2's bokeh_dof_raster.glsl,
// MIT) and the combines (dof_combine.wgsl). Every CoC is a signed radius in full-resolution
// pixels: negative in front of the focus plane, positive behind it.
struct DofParams {
    // x, y: the CoC diameter's madd on the depth-buffer value; z: the most negative (foreground)
    // radius; w: the largest (background) radius.
    coc: vec4<f32>,
    // xy: the render size; zw: 1 / the half-resolution (tile-padded) size.
    size: vec4<f32>,
    // xy: full-resolution pixels to half-resolution uv; z: full- to half-resolution pixels (0.5);
    // w: the circular gather's most samples.
    scale: vec4<f32>,
    // The ring gather's rings: foreground, background, fast tiles; w: reserved.
    rings: vec4<f32>,
}

@group(0) @binding(0) var<uniform> dof: DofParams;

const DOF_PI: f32 = 3.14159265358979;
// Below this CoC radius a pixel is in focus (Filament's MAX_IN_FOCUS_COC).
const DOF_MAX_IN_FOCUS_COC: f32 = 1.0;
// The radius every sample weight is normalised to (Filament's MAX_COC_RADIUS).
const DOF_MAX_COC_RADIUS: f32 = 32.0;
// The tile side in half-resolution texels (16 full-resolution pixels).
const DOF_TILE_HALF_TEXELS: i32 = 8;
// The smallest weight divided by, and the largest colour kept (Filament's mediump limits).
const DOF_WEIGHT_MIN: f32 = 0.00006103515625;
const DOF_COLOUR_MAX: f32 = 65504.0;

// The fullscreen triangle every pass draws.
@vertex
fn vs_dof(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

// The signed CoC radius at depth-buffer value `depth`: half the diameter's madd, clamped to the
// tier's radius, zero in focus (Filament's getCOC and dofDownsample's clamp).
fn dof_coc(depth: f32) -> f32 {
    let radius = clamp((depth * dof.coc.x + dof.coc.y) * 0.5, dof.coc.z, dof.coc.w);
    return select(radius, 0.0, abs(radius) < DOF_MAX_IN_FOCUS_COC);
}

// How opaque a pixel of CoC `coc` is in the blurred layer (Filament's cocToAlpha).
fn dof_coc_to_alpha(coc: f32) -> f32 {
    return saturate(abs(coc) - DOF_MAX_IN_FOCUS_COC);
}

// A tile's (min, max) CoC: whether all of it is in focus (Filament's isTrivialTile).
fn dof_trivial_tile(tiles: vec2<f32>) -> bool {
    return max(abs(tiles.x), abs(tiles.y)) < DOF_MAX_IN_FOCUS_COC;
}

// Whether a tile's CoC is about constant: within 5% (Filament's isFastTile).
fn dof_fast_tile(tiles: vec2<f32>) -> bool {
    return (tiles.y - tiles.x) <= abs(tiles.y) * 0.05;
}

// The last texel of a `size`-sized level.
fn dof_last(size: vec2<u32>) -> vec2<i32> {
    return vec2<i32>(size) - vec2<i32>(1);
}
