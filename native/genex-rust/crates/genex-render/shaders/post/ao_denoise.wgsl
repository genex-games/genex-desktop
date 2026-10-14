// AO's bilateral denoise and temporal accumulation (graph node 10; RQ4.4): the raw GTAO term
// (gtao.wgsl), averaged over a depth-aware window (5x5 at half
// resolution, 3x3 at full) and brought back to at most 1, then on
// temporal qualities blended with AO's own reprojected history (the previous term at the AO
// resolution, its own, never TAA's). History is reprojected through the camera with this frame's
// depth and rejected where it falls off screen or where the view depth it was made at disagrees
// with the reprojected one by more than `history.y` (relative).
//
// The term: r visibility (1 unoccluded); with bent normals gba the world-space bent normal as
// `n * 0.5 + 0.5`. The raw term without bent normals carries in g the estimate's weight (how much
// of the hemisphere its slices measured, gtao.wgsl's `GxAoEstimate::weight`), and the window
// averages by it. The view depth each history texel was made at is last frame's view-depth chain
// (gtao.wgsl), which AO keeps alongside the history.

// Mirrors `post::ao::GpuAoParams`.
struct AoParams {
    // xy: the AO target's size in pixels; zw: 1 / it.
    size: vec4<f32>,
    // x: radius (world units); y: intensity; z: falloff (fraction of the radius); w: thickness.
    params: vec4<f32>,
    // x: slices; y: steps per slice; z: the frame index its noise keys to; w: flags (1 temporal,
    // 2 bent normals, 4 reverse-Z, 8 view-space normals, 16 every other step).
    counts: vec4<u32>,
    // x: the history's blend weight; y: the depth difference that rejects history; z: the denoise
    // window's half width in texels; w: its spatial falloff (sigma, texels).
    history: vec4<f32>,
}

// Mirrors `post::ao::GpuAoView`.
struct AoView {
    // The projection the depth was drawn with, and its inverse.
    proj: mat4x4<f32>,
    inv_proj: mat4x4<f32>,
    // World to view.
    view: mat4x4<f32>,
    // This frame's view space to last frame's, and last frame's projection.
    prev_view_from_view: mat4x4<f32>,
    prev_proj: mat4x4<f32>,
    // x, y: 1 / proj[0][0] and 1 / proj[1][1]; zw: the render size (gtao.wgsl's
    // `gx_ao_texel_placement`).
    unproject: vec4<f32>,
}

@group(0) @binding(0) var gx_ao_raw: texture_2d<f32>;
@group(0) @binding(1) var gx_ao_history: texture_2d<f32>;
// This frame's view-depth chain (gtao.wgsl; mip 0 is read) and last frame's.
@group(0) @binding(2) var gx_ao_depth: texture_2d<f32>;
@group(0) @binding(3) var<uniform> gx_ao: AoParams;
@group(0) @binding(4) var<uniform> gx_ao_view: AoView;
@group(0) @binding(5) var gx_ao_depth_history: texture_2d<f32>;
// The prepass normals (render size, octahedral): each texel's surface is its representative
// pixel's.
@group(0) @binding(6) var gx_ao_normals: texture_2d<f32>;

// The raw term's packing and the chain's sky depth (gtao.wgsl's).
// The widest denoise window (half width, texels) that reads every texel of its square; a wider
// one reads a disc of them (`gx_ao_denoised`).
const GX_AO_DENSE_RADIUS: i32 = 2;
const GX_AO_RAW_SCALE: f32 = 1.5;
const GX_AO_SKY_DEPTH: f32 = 1e20;
// How far, relative to the centre's distance, a neighbour may lie off the centre's plane per texel
// of distance before it counts as another surface. The window's half width is `history.z`, its
// spatial falloff (texels) `history.w`.
const GX_AO_PLANE_TOLERANCE: f32 = 0.01;
// Past a convex edge (a step's top and its riser, meeting at the same depth) the other face lies
// on the centre's plane for a texel or two, so depth alone let the riser's occlusion bleed onto the
// top once the estimate stopped overshooting 1 there (gate finding 03). A neighbour that lies
// behind the centre's plane (its inverse distance below the plane's by more than this share) has
// its weight fall with its normal's turn from the centre's (their cosine's eighth power, as the
// joint upsample's), down to the floor. A concave crease's other face lies in front of the plane
// and shares the crease's darkness, so it keeps its weight.
const GX_AO_CONVEX_TOLERANCE: f32 = 1e-3;
// Whether the window weighs normals past a convex edge (`post::ao::CONVEX_NORMALS_CONSTANT`): at
// half resolution only. At full resolution the window reaches one pixel past an edge, the term's
// own footprint, and the pipeline compiles the path out.
override GX_AO_CONVEX_NORMALS: bool = true;
const GX_AO_NORMAL_FLOOR: f32 = 0.001;
const GX_AO_FLAG_BENT: u32 = 2u;

struct AoOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_ao_denoise(@builtin(vertex_index) index: u32) -> AoOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return AoOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

// Where (AO pixel position) AO texel `texel`'s surface lies: its representative render pixel's
// centre (gtao.wgsl's `gx_ao_texel_placement`).
fn gx_ao_texel_position(texel: vec2<i32>) -> vec2<f32> {
    let render = max(gx_ao_view.unproject.zw, gx_ao.size.xy);
    let block = max(floor(render / gx_ao.size.xy), vec2<f32>(1.0));
    return (vec2<f32>(texel) * block + floor(block * 0.5) + vec2<f32>(0.5)) * gx_ao.size.xy / render;
}

// Where AO texels' representative pixels lie in the render-sized normals: texel `t`'s is
// `t * xy + zw`, clamped to the normals' last pixel.
struct GxAoNormalGrid {
    block: vec2<i32>,
    half_block: vec2<i32>,
    last: vec2<i32>,
}

fn gx_ao_normal_grid() -> GxAoNormalGrid {
    let render = vec2<i32>(max(gx_ao_view.unproject.zw, gx_ao.size.xy));
    let block = max(render / vec2<i32>(gx_ao.size.xy), vec2<i32>(1));
    return GxAoNormalGrid(block, block / vec2<i32>(2), render - vec2<i32>(1));
}

// The normal of AO texel `texel`'s surface: its representative pixel's (gtao.wgsl's).
fn gx_ao_texel_normal(grid: GxAoNormalGrid, texel: vec2<i32>) -> vec3<f32> {
    return gx_oct_decode(textureLoad(gx_ao_normals, min(texel * grid.block + grid.half_block, grid.last), 0).xy);
}

// The renderer's view-space position of AO texel `texel` (its representative pixel), 0 in w for
// the sky.
fn gx_ao_view_at(texel: vec2<i32>) -> vec4<f32> {
    let distance = textureLoad(gx_ao_depth, texel, 0).r;
    if distance >= GX_AO_SKY_DEPTH {
        return vec4<f32>(0.0);
    }
    let p = gx_ao_view.proj;
    let uv = gx_ao_texel_position(texel) * gx_ao.size.zw;
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let z = -distance;
    let w = p[2][3] * z + p[3][3];
    let x = (ndc.x * w - p[2][0] * z - p[3][0]) * gx_ao_view.unproject.x;
    let y = (ndc.y * w - p[2][1] * z - p[3][1]) * gx_ao_view.unproject.y;
    return vec4<f32>(x, y, z, 1.0);
}

// The inverse view distance at `texel` (0 for the sky, so it lies off every surface's plane).
fn gx_ao_inverse_depth(texel: vec2<i32>) -> f32 {
    let size = vec2<i32>(gx_ao.size.xy);
    let distance = textureLoad(gx_ao_depth, clamp(texel, vec2<i32>(0), size - vec2<i32>(1)), 0).r;
    return select(1.0 / max(distance, 1e-6), 0.0, distance >= GX_AO_SKY_DEPTH);
}

// Of the one-sided differences `before` and `after` of the inverse depth along an axis, the one of
// smaller size: the surface's own slope, not a step to the neighbour beyond an edge.
fn gx_ao_slope(before: f32, after: f32) -> f32 {
    return select(after, before, abs(before) < abs(after));
}

// The term at `texel`: the depth-aware average of the raw term around it (already shaped by the
// look's intensity), at most 1. xyz the world-space bent normal (zero without), w the visibility.
// A neighbour counts in full when it lies on the centre's plane: the inverse view distance is
// linear across the screen on a plane, so the centre's one-sided slopes predict each neighbour's
// (XeGTAO's slope-adjusted edges), and a grazing floor, whose distance changes fast from texel to
// texel, keeps its whole window instead of collapsing to the centre's noisy estimate. A step off
// that plane (a kerb, a crease's other face) by more than the tolerance is another surface.
fn gx_ao_denoised(texel: vec2<i32>, centre: vec4<f32>) -> vec4<f32> {
    if centre.w == 0.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let size = vec2<i32>(gx_ao.size.xy);
    let inverse = 1.0 / max(-centre.z, 1e-6);
    let slope = vec2<f32>(
        gx_ao_slope(inverse - gx_ao_inverse_depth(texel - vec2<i32>(1, 0)), gx_ao_inverse_depth(texel + vec2<i32>(1, 0)) - inverse),
        gx_ao_slope(inverse - gx_ao_inverse_depth(texel - vec2<i32>(0, 1)), gx_ao_inverse_depth(texel + vec2<i32>(0, 1)) - inverse),
    );
    let grid = gx_ao_normal_grid();
    // Read on the first neighbour behind the plane (none on open ground).
    var normal = vec3<f32>(0.0);
    var normal_read = false;
    var weight_sum = 0.0;
    var visibility = 0.0;
    var bent = vec3<f32>(0.0);
    let bent_term = (gx_ao.counts.w & GX_AO_FLAG_BENT) != 0u;
    let radius = i32(gx_ao.history.z);
    let sigma = max(gx_ao.history.w, 0.5);
    // exp(-d² / (2 sigma²)) as exp2(d² * spatial).
    let spatial = -1.0 / (2.0 * sigma * sigma * 0.6931471805599453);
    // A window wider than 5x5 is a disc (37 of 7x7's 49 texels: the corners' Gaussian weights
    // are the smallest), so medium's one slice is averaged over 7x7's width within its budget.
    let disc = select(radius * radius * 2, radius * radius + radius, radius > GX_AO_DENSE_RADIUS);
    for (var dy = -radius; dy <= radius; dy++) {
        for (var dx = -radius; dx <= radius; dx++) {
            if dx * dx + dy * dy > disc {
                continue;
            }
            let at = clamp(texel + vec2<i32>(dx, dy), vec2<i32>(0), size - vec2<i32>(1));
            // Only the neighbour's depth matters here (the sky's is past every tolerance).
            let predicted = inverse + dot(slope, vec2<f32>(f32(dx), f32(dy)));
            // Positive: nearer than the plane (in front of it, on its normal's side: the camera
            // sees the plane's front); negative: behind it.
            let toward = (gx_ao_inverse_depth(at) - predicted) / inverse;
            let distance_squared = f32(dx * dx + dy * dy);
            let tolerance = GX_AO_PLANE_TOLERANCE * max(sqrt(distance_squared), 1.0);
            let depth_weight = clamp(1.0 - abs(toward) / tolerance, 0.0, 1.0);
            var agreement = 1.0;
            if GX_AO_CONVEX_NORMALS && depth_weight > 0.0 && toward < -GX_AO_CONVEX_TOLERANCE {
                if !normal_read {
                    normal = gx_ao_texel_normal(grid, texel);
                    normal_read = true;
                }
                // The cosine's eighth power by three squarings.
                let c = max(dot(normal, gx_ao_texel_normal(grid, at)), 0.0);
                let c2 = c * c;
                let c4 = c2 * c2;
                agreement = max(c4 * c4, GX_AO_NORMAL_FLOOR);
            }
            let raw = textureLoad(gx_ao_raw, at, 0);
            // One slice per pixel (medium) measures the hemisphere along one angle only, and a
            // slice that grazes the surface measures almost none of it: its visibility counted in
            // full drew dots of false occlusion wherever the grazing slices met a trunk or a
            // crease (pass-1 fix gate, visual RED 01). The window weighs each estimate by the arcs
            // it measured, so it averages the visible arcs over the unoccluded ones of every
            // slice it holds (the ratio estimator over the window). With bent normals (two or
            // more slices across the half circle) each pixel already measured most of it.
            let estimate = select(raw.g, 1.0, bent_term);
            let weight = exp2(distance_squared * spatial) * depth_weight * agreement * estimate;
            visibility += raw.r * GX_AO_RAW_SCALE * weight;
            bent += (raw.gba * 2.0 - vec3<f32>(1.0)) * weight;
            weight_sum += weight;
        }
    }
    let shaped = clamp(visibility / max(weight_sum, 1e-6), 0.0, 1.0);
    var bent_normal = vec3<f32>(0.0);
    if bent_term && dot(bent, bent) > 1e-8 {
        bent_normal = normalize(bent);
    }
    return vec4<f32>(bent_normal, shaped);
}

// The stored form of `term` (xyz bent normal, w visibility): r visibility, gba the bent normal.
fn gx_ao_encode(term: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(term.w, term.xyz * 0.5 + vec3<f32>(0.5));
}

@fragment
fn fs_ao_denoise(in: AoOut) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(in.clip.xy);
    return gx_ao_encode(gx_ao_denoised(texel, gx_ao_view_at(texel)));
}

// How much of last frame's term `centre` (this frame's view-space position) may keep, and where
// it was: the history's weight is 0 off screen, where the view depth disagrees, or on a reset.
fn gx_ao_history_texel(centre: vec4<f32>) -> vec3<f32> {
    if centre.w == 0.0 || gx_ao.history.x <= 0.0 {
        return vec3<f32>(0.0);
    }
    let previous = gx_ao_view.prev_view_from_view * vec4<f32>(centre.xyz, 1.0);
    let clip = gx_ao_view.prev_proj * previous;
    if clip.w <= 0.0 {
        return vec3<f32>(0.0);
    }
    let uv = vec2<f32>(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    if any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0)) {
        return vec3<f32>(0.0);
    }
    let texel = vec2<f32>(floor(uv * gx_ao.size.xy));
    let expected = -previous.z;
    let held = textureLoad(gx_ao_depth_history, vec2<i32>(texel), 0).r;
    let agrees = held < GX_AO_SKY_DEPTH && abs(held - expected) <= gx_ao.history.y * expected;
    return vec3<f32>(texel, select(0.0, gx_ao.history.x, agrees));
}

@fragment
fn fs_ao_temporal(in: AoOut) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(in.clip.xy);
    let centre = gx_ao_view_at(texel);
    var term = gx_ao_denoised(texel, centre);
    let history = gx_ao_history_texel(centre);
    if history.z > 0.0 {
        let held = textureLoad(gx_ao_history, vec2<i32>(history.xy), 0);
        term.w = mix(term.w, held.r, history.z);
        if dot(term.xyz, term.xyz) > 0.0 {
            let blended = mix(term.xyz, held.gba * 2.0 - vec3<f32>(1.0), history.z);
            term = vec4<f32>(select(term.xyz, normalize(blended), dot(blended, blended) > 1e-8), term.w);
        }
    }
    return gx_ao_encode(term);
}
