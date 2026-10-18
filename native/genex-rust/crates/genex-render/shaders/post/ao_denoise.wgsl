// AO's bilateral denoise and temporal accumulation (graph node 10; RQ4.4): the raw GTAO term
// (gtao.wgsl), averaged over a depth-aware window (5x5 at half
// resolution, 3x3 at full) and brought back to at most 1, then on
// temporal qualities blended with AO's own reprojected history (the previous term at the AO
// resolution, its own, never TAA's; 16-bit float). History is found through the prepass's motion
// target where the frame has one (flag 32), else through the camera with this frame's depth, and
// read bilinearly in uv at the history's own size (a dynamic-resolution step reads the previous
// size's): each of the four texels drops out where it falls off screen or where the view depth it
// was made at disagrees with the reprojected one by more than `history.y` (relative). What is left
// is clamped to one standard deviation of this frame's window estimates around the term, so a floor
// a moving object left keeps none of its old occlusion (pass 2, P3/S2).
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
    // Screen-space GI (gtao.wgsl): x the light's scale; y its strength; zw unused.
    gi: vec4<f32>,
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
// The prepass's motion (render size, NDC current - previous; a texel of none without flag 32).
@group(0) @binding(7) var gx_ao_motion: texture_2d<f32>;

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
// half resolution only. At full resolution the window reaches one pixel past an edge (two with
// history), about the term's own footprint, and the pipeline compiles the path out.
override GX_AO_CONVEX_NORMALS: bool = true;
const GX_AO_NORMAL_FLOOR: f32 = 0.001;
const GX_AO_FLAG_BENT: u32 = 2u;
const GX_AO_FLAG_MOTION: u32 = 32u;
// The term carries screen-space GI (`post::ao::FLAG_GI`): gba the gathered light, averaged and
// blended linearly (no bent normal).
const GX_AO_FLAG_GI: u32 = 64u;
// The least weight an estimate counts with (gtao.wgsl's `GX_AO_WEIGHT_FLOOR`, one 8-bit level).
const GX_AO_WEIGHT_FLOOR: f32 = 0.00392156862745098;
// The bilinear weight of the history's texels below which no history is read (every texel near
// the reprojected point dropped out).
const GX_AO_HISTORY_WEIGHT_FLOOR: f32 = 1e-3;

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

// The continuous texel coordinate (texel `t` at `t`) of uv `uv` on an AO target of `size` texels
// whose texels stand at their representative pixels (`gx_ao_texel_position`'s inverse, with this
// frame's render pixels per texel).
fn gx_ao_texel_at(uv: vec2<f32>, size: vec2<f32>) -> vec2<f32> {
    let render = max(gx_ao_view.unproject.zw, gx_ao.size.xy);
    let block = max(floor(render / gx_ao.size.xy), vec2<f32>(1.0));
    return (uv * size * block - floor(block * 0.5) - vec2<f32>(0.5)) / block;
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
//
// Beside the term, the visibility one standard deviation of the window's estimates (the same
// weights) either side of it: how far this frame's own estimates disagree, which bounds the history
// (`fs_ao_temporal`).
struct GxAoWindow {
    term: vec4<f32>,
    range: vec2<f32>,
    // With GI, the least and the most light the window's estimates gathered (each channel): the
    // history's light is held within them (`fs_ao_temporal`).
    light_low: vec3<f32>,
    light_high: vec3<f32>,
}

fn gx_ao_denoised(texel: vec2<i32>, centre: vec4<f32>) -> GxAoWindow {
    if centre.w == 0.0 {
        return GxAoWindow(vec4<f32>(0.0, 0.0, 0.0, 1.0), vec2<f32>(1.0), vec3<f32>(0.0), vec3<f32>(0.0));
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
    var visibility_squared = 0.0;
    var bent = vec3<f32>(0.0);
    let bent_term = (gx_ao.counts.w & GX_AO_FLAG_BENT) != 0u;
    let gi_term = gx_ao_gi();
    var light = vec3<f32>(0.0);
    var light_low = vec3<f32>(3.0e38);
    var light_high = vec3<f32>(0.0);
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
            let raw_bent = raw.gba * 2.0 - vec3<f32>(1.0);
            let raw_bent_length = length(raw_bent);
            // One slice per pixel (medium) measures the hemisphere along one angle only, and a
            // slice that grazes the surface measures almost none of it: its visibility counted in
            // full drew dots of false occlusion wherever the grazing slices met a trunk or a
            // crease (pass-1 fix gate, visual RED 01). The window weighs each estimate by the arcs
            // it measured, so it averages the visible arcs over the unoccluded ones of every
            // slice it holds (the ratio estimator over the window). With bent normals the weight
            // is the raw bent normal's length (gtao.wgsl): a running frame at high takes one slice.
            // The GI's raw term has no room for the weight: its estimates count alike.
            let estimate = select(select(raw.g, max(raw_bent_length, GX_AO_WEIGHT_FLOOR), bent_term), 1.0, gi_term);
            let weight = exp2(distance_squared * spatial) * depth_weight * agreement * estimate;
            let estimate_visibility = raw.r * GX_AO_RAW_SCALE;
            visibility += estimate_visibility * weight;
            visibility_squared += estimate_visibility * estimate_visibility * weight;
            bent += raw_bent / max(raw_bent_length, 1e-6) * weight;
            light += raw.gba * weight;
            if gi_term && weight > 0.0 {
                light_low = min(light_low, raw.gba);
                light_high = max(light_high, raw.gba);
            }
            weight_sum += weight;
        }
    }
    let mean = visibility / max(weight_sum, 1e-6);
    var bent_normal = vec3<f32>(0.0);
    if bent_term && dot(bent, bent) > 1e-8 {
        bent_normal = normalize(bent);
    }
    if gi_term {
        bent_normal = light / max(weight_sum, 1e-6);
    }
    let term = clamp(mean, 0.0, 1.0);
    let spread = sqrt(max(visibility_squared / max(weight_sum, 1e-6) - mean * mean, 0.0));
    return GxAoWindow(vec4<f32>(bent_normal, term), vec2<f32>(term - spread, term + spread), min(light_low, light_high), light_high);
}

// The stored form of `term` (xyz bent normal, w visibility): r visibility, gba the bent normal;
// with GI, gba the light as it is.
fn gx_ao_encode(term: vec4<f32>) -> vec4<f32> {
    if gx_ao_gi() {
        return vec4<f32>(term.w, term.xyz);
    }
    return vec4<f32>(term.w, term.xyz * 0.5 + vec3<f32>(0.5));
}

// Whether the term carries screen-space GI in gba (`GX_AO_FLAG_GI`).
fn gx_ao_gi() -> bool {
    return (gx_ao.counts.w & GX_AO_FLAG_GI) != 0u;
}

@fragment
fn fs_ao_denoise(in: AoOut) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(in.clip.xy);
    return gx_ao_encode(gx_ao_denoised(texel, gx_ao_view_at(texel)).term);
}

// Last frame's term where AO texel `texel` (this frame's view-space position `centre`) was: xyz
// the bent normal (zero without), w the visibility, and the weight the history keeps (0 off
// screen, where every texel near it disagrees in depth, or on a reset).
struct GxAoHistory {
    term: vec4<f32>,
    weight: f32,
}

// Where (uv, the history's own size's) AO texel `texel` at view-space `centre` was last frame:
// along the prepass's motion at the texel's representative pixel where the frame has it, else
// through the camera (which moves no object). Out of 0..1 where it was off screen.
fn gx_ao_history_uv(texel: vec2<i32>, previous: vec4<f32>) -> vec2<f32> {
    if (gx_ao.counts.w & GX_AO_FLAG_MOTION) != 0u {
        let grid = gx_ao_normal_grid();
        let motion = textureLoad(gx_ao_motion, min(texel * grid.block + grid.half_block, grid.last), 0).xy;
        return gx_ao_texel_position(texel) * gx_ao.size.zw - motion * vec2<f32>(0.5, -0.5);
    }
    let clip = gx_ao_view.prev_proj * previous;
    if clip.w <= 0.0 {
        return vec2<f32>(-1.0);
    }
    return vec2<f32>(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
}

fn gx_ao_held(texel: vec2<i32>, centre: vec4<f32>) -> GxAoHistory {
    let none = GxAoHistory(vec4<f32>(0.0), 0.0);
    if centre.w == 0.0 || gx_ao.history.x <= 0.0 {
        return none;
    }
    // The view depth last frame's chain should hold there: the camera's reprojection of this
    // frame's point (an object's own motion along the view is within the tolerance at a frame).
    let previous = gx_ao_view.prev_view_from_view * vec4<f32>(centre.xyz, 1.0);
    let expected = -previous.z;
    let uv = gx_ao_history_uv(texel, previous);
    if any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0)) {
        return none;
    }
    // Bilinear over the history's own texels, each kept only where its held depth agrees. A texel
    // stands where its representative pixel is (`gx_ao_texel_position`: a quarter texel past its
    // centre at half resolution), so the weights are taken there: from the texel centres every
    // frame's read slid the history a quarter texel and the crease smeared lighter frame by frame.
    let size = vec2<i32>(textureDimensions(gx_ao_history));
    let at = gx_ao_texel_at(uv, vec2<f32>(size));
    let base = vec2<i32>(floor(at));
    let f = at - floor(at);
    var sum = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var i = 0; i < 4; i++) {
        let offset = vec2<i32>(i & 1, i >> 1u);
        let tap = base + offset;
        let bilinear = mix(1.0 - f.x, f.x, f32(offset.x)) * mix(1.0 - f.y, f.y, f32(offset.y));
        let inside = all(tap >= vec2<i32>(0)) && all(tap < size);
        let clamped = clamp(tap, vec2<i32>(0), size - vec2<i32>(1));
        let held = textureLoad(gx_ao_depth_history, clamped, 0).r;
        let agrees = inside && held < GX_AO_SKY_DEPTH && abs(held - expected) <= gx_ao.history.y * expected;
        let weight = select(0.0, bilinear, agrees);
        sum += textureLoad(gx_ao_history, clamped, 0) * weight;
        weight_sum += weight;
    }
    if weight_sum < GX_AO_HISTORY_WEIGHT_FLOOR {
        return none;
    }
    let stored = sum / weight_sum;
    let bent = select(vec3<f32>(0.0), stored.gba * 2.0 - vec3<f32>(1.0), (gx_ao.counts.w & GX_AO_FLAG_BENT) != 0u);
    return GxAoHistory(vec4<f32>(select(bent, stored.gba, gx_ao_gi()), stored.r), gx_ao.history.x);
}

@fragment
fn fs_ao_temporal(in: AoOut) -> @location(0) vec4<f32> {
    let texel = vec2<i32>(in.clip.xy);
    let centre = gx_ao_view_at(texel);
    let window = gx_ao_denoised(texel, centre);
    var term = window.term;
    let history = gx_ao_held(texel, centre);
    if history.weight > 0.0 {
        // The history may lie no further from the term than the window's own estimates do: a floor
        // a moving object left (every estimate open) takes this frame's open sky (P3/S2), while in
        // a crease, whose estimates spread with their slices' angles, it averages over the frames.
        // The window holds enough estimates for that spread at every temporal quality (5x5,
        // `post::ao::denoise_radius`): ultra's 3x3 of one slice each skewed it, and the clamp drew
        // its creases darker than its frames average.
        let held = clamp(history.term.w, window.range.x, window.range.y);
        term.w = mix(term.w, held, history.weight);
        if gx_ao_gi() {
            // The light blends as it is, held within what the window's own estimates gathered: a
            // floor whose depth stays when the red box in front of it goes keeps its history
            // through the depth test, and its red faded only by the weight (two thirds of it three
            // frames later).
            let held_light = clamp(history.term.xyz, window.light_low, window.light_high);
            return gx_ao_encode(vec4<f32>(mix(term.xyz, held_light, history.weight), term.w));
        }
        if dot(term.xyz, term.xyz) > 0.0 && dot(history.term.xyz, history.term.xyz) > 0.0 {
            let blended = mix(term.xyz, history.term.xyz, history.weight);
            term = vec4<f32>(select(term.xyz, normalize(blended), dot(blended, blended) > 1e-8), term.w);
        }
    }
    return gx_ao_encode(term);
}
