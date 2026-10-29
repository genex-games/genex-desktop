// Irradiance volumes (renderer pass 2 A.4, `irradiance::IrradianceMaps`): the bake's reduce.
//
// A cell of a volume is baked from the six faces of a small cube drawn from its centre with the
// forward shading (the reflection probes' capture, `renderer/probe_capture.rs`): each face is a
// layer of `capture_color` (radiance) and `capture_depth` (the face's depth, cleared where no
// geometry covered it). `cs_irradiance_reduce` turns one cell's six faces into its ambient cube:
// one texel per axis direction (+x, -x, +y, -y, +z, -z), rgb the cosine-weighted mean radiance of
// the hemisphere around the direction (the irradiance over pi, so a constant environment of
// radiance L bakes L: the forward pass reads it as the SH9 term's twin), a the cell's reaches
// along the texel's axis, both directions, coded into one exact float (each the cos^4-weighted
// mean distance, along the axis, to the first surface: a wall across the axis at distance h
// reaches h from every texel that sees it; clamped to `grid_bake.depth.w`), which the forward
// pass's leak control tests a shaded point's distance from the cell against
// (`irradiance::ambient_reach`). The capture holds the first bounce only (surfaces lit by the sun and
// the local lights, no ambient), so a ceiling the sun never reaches would stay black: the bounces
// after it are estimated in the reduce (AAA push P3, `irradiance::bounce_gain`). The surfaces
// around a cell are lit by about what the cell sees, its mean radiance over the whole sphere M, so
// each bounce off them adds the room's albedo rho times the one before: rho/(1 - rho) x M in all,
// added to each direction in proportion to the geometry its hemisphere sees (`grid_bake.sky.y`, 0:
// the first bounce alone). Texels no geometry covered read the sky's
// prefiltered cube at `grid_bake.sky.x` and reach the clamp. One workgroup reduces one cell of the
// batch: 64 lanes each sum a strided share of the 6 x side^2 texels, then a tree sum in workgroup
// memory, and lanes 0..6 write the cell's six texels into the volume's staging block (atlas
// layout: x the cell's x; y its y, plus the volume's cells along y for a negative direction; z its
// z, plus the cells along z times the axis).

struct GxGridBake {
    // Each batch cell: xyz its coordinates in the volume, w the first of its six capture layers.
    cells: array<vec4<u32>, 8>,
    // x: cells in the batch; y, z: the volume's cells along y and z; w: the capture's side.
    shape: vec4<u32>,
    // x: the depth a face is cleared to; y, z: the face projection's depth terms (view distance
    // z / (depth + y)); w: the farthest reach a cell records.
    depth: vec4<f32>,
    // x: the sky cube's level uncovered texels read; y: the later bounces' gain, rho/(1 - rho)
    // (0: the first bounce alone); z, w: reserved.
    sky: vec4<f32>,
}

@group(0) @binding(0) var<uniform> grid_bake: GxGridBake;
@group(0) @binding(1) var capture_color: texture_2d_array<f32>;
@group(0) @binding(2) var capture_depth: texture_depth_2d_array;
@group(0) @binding(3) var sky_cube: texture_cube<f32>;
@group(0) @binding(4) var sky_sampler: sampler;
@group(0) @binding(5) var staging: texture_storage_3d<rgba16float, write>;

const GRID_LANES: u32 = 64u;
const GRID_DIRECTIONS: u32 = 6u;
// A reach code's bits and largest code (`irradiance::REACH_BITS`, `irradiance::REACH_CODE_MAX`).
const GRID_REACH_BITS: u32 = 5u;
const GRID_REACH_MASK: u32 = 31u;

// Per lane and direction: rgb the cosine-weighted radiance, a the cosine weight.
var<workgroup> lane_light: array<array<vec4<f32>, 6>, 64>;
// Per lane and direction: x the cos^4-weighted distance, y the weight.
var<workgroup> lane_reach: array<array<vec2<f32>, 6>, 64>;
// Per lane and direction: the cosine weight of the texels geometry covered.
var<workgroup> lane_surface: array<array<f32, 6>, 64>;
// Per lane: rgb the solid-angle-weighted radiance over the whole sphere, a the solid angle.
var<workgroup> lane_sphere: array<vec4<f32>, 64>;

// The world direction through texel coordinate `uv` (0..1, v down) of cube face `face`
// (`ibl::cube_direction`, the probes' `ibl_cube_direction`).
fn grid_cube_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    switch face {
        case 0u: { return normalize(vec3<f32>(1.0, -t, -s)); }
        case 1u: { return normalize(vec3<f32>(-1.0, -t, s)); }
        case 2u: { return normalize(vec3<f32>(s, 1.0, t)); }
        case 3u: { return normalize(vec3<f32>(s, -1.0, -t)); }
        case 4u: { return normalize(vec3<f32>(s, -t, 1.0)); }
        default: { return normalize(vec3<f32>(-s, -t, -1.0)); }
    }
}

// Axis direction `a` of the ambient cube (+x, -x, +y, -y, +z, -z).
fn grid_axis(a: u32) -> vec3<f32> {
    var axis = vec3<f32>(0.0);
    axis[a / 2u] = select(1.0, -1.0, (a & 1u) == 1u);
    return axis;
}

// The solid angle of texel (x, y) of a cube face `side` texels wide (`ibl::texel_solid_angle`).
fn grid_texel_solid_angle(side: u32, x: u32, y: u32) -> f32 {
    let step = 2.0 / f32(side);
    let a = vec2<f32>(f32(x), f32(y)) * step - 1.0;
    let b = a + step;
    return abs(grid_area(a.x, a.y) - grid_area(a.x, b.y) - grid_area(b.x, a.y) + grid_area(b.x, b.y));
}

fn grid_area(x: f32, y: f32) -> f32 {
    return atan2(x * y, sqrt(x * x + y * y + 1.0));
}

@compute @workgroup_size(64, 1, 1)
fn cs_irradiance_reduce(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
    let cell = grid_bake.cells[min(group.x, 7u)];
    let side = max(grid_bake.shape.w, 1u);
    let face_texels = side * side;
    let reach_max = grid_bake.depth.w;
    var light: array<vec4<f32>, 6>;
    var reach: array<vec2<f32>, 6>;
    var surface: array<f32, 6>;
    var sphere = vec4<f32>(0.0);
    for (var a = 0u; a < GRID_DIRECTIONS; a++) {
        light[a] = vec4<f32>(0.0);
        reach[a] = vec2<f32>(0.0);
        surface[a] = 0.0;
    }
    for (var i = lane; i < face_texels * 6u; i += GRID_LANES) {
        let face = i / face_texels;
        let texel = i % face_texels;
        let xy = vec2<u32>(texel % side, texel / side);
        let uv = (vec2<f32>(xy) + 0.5) / f32(side);
        let dir = grid_cube_direction(face, uv);
        let solid = grid_texel_solid_angle(side, xy.x, xy.y);
        let layer = i32(cell.w + face);
        let depth = textureLoad(capture_depth, vec2<i32>(xy), layer, 0);
        var radiance: vec3<f32>;
        // Negative: no surface (the sky), which reaches the clamp along every axis.
        var distance = -1.0;
        if depth == grid_bake.depth.x {
            radiance = textureSampleLevel(sky_cube, sky_sampler, dir, grid_bake.sky.x).rgb;
        } else {
            radiance = textureLoad(capture_color, vec2<i32>(xy), layer, 0).rgb;
            // View depth along the face's axis, then along the texel's own ray.
            let view = grid_bake.depth.z / (depth + grid_bake.depth.y);
            let st = uv * 2.0 - 1.0;
            distance = abs(view) * length(vec3<f32>(st, 1.0));
        }
        sphere += vec4<f32>(radiance * solid, solid);
        let covered = select(1.0, 0.0, distance < 0.0);
        for (var a = 0u; a < GRID_DIRECTIONS; a++) {
            let c = dot(dir, grid_axis(a));
            if c > 0.0 {
                let w = c * solid;
                light[a] += vec4<f32>(radiance * w, w);
                surface[a] += covered * w;
                let c2 = c * c;
                let focus = c2 * c2 * solid;
                let along = select(min(distance * c, reach_max), reach_max, distance < 0.0);
                reach[a] += vec2<f32>(along * focus, focus);
            }
        }
    }
    for (var a = 0u; a < GRID_DIRECTIONS; a++) {
        lane_light[lane][a] = light[a];
        lane_reach[lane][a] = reach[a];
        lane_surface[lane][a] = surface[a];
    }
    lane_sphere[lane] = sphere;
    workgroupBarrier();
    for (var stride = GRID_LANES / 2u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            for (var a = 0u; a < GRID_DIRECTIONS; a++) {
                lane_light[lane][a] += lane_light[lane + stride][a];
                lane_reach[lane][a] += lane_reach[lane + stride][a];
                lane_surface[lane][a] += lane_surface[lane + stride][a];
            }
            lane_sphere[lane] += lane_sphere[lane + stride];
        }
        workgroupBarrier();
    }
    if lane >= GRID_DIRECTIONS || group.x >= grid_bake.shape.x {
        return;
    }
    let a = lane;
    let total = lane_light[0][a];
    let whole = lane_sphere[0];
    // The later bounces: the share of the hemisphere geometry covers, lit by the cell's whole mean.
    let covered = lane_surface[0][a] / max(total.a, 1e-8);
    let bounces = covered * grid_bake.sky.y * whole.rgb / max(whole.a, 1e-8);
    let irradiance = total.rgb / max(total.a, 1e-8) + bounces;
    let axis = a / 2u;
    // Both reaches of the axis, coded into one exact float (`irradiance::pack_reaches`): either of
    // its two texels gives the lookup both planes.
    let plus = grid_reach_code(lane_reach[0][2u * axis], reach_max);
    let minus = grid_reach_code(lane_reach[0][2u * axis + 1u], reach_max);
    let negative = a & 1u;
    let at = vec3<u32>(cell.x, cell.y + negative * grid_bake.shape.y, cell.z + axis * grid_bake.shape.z);
    textureStore(staging, vec3<i32>(at), vec4<f32>(irradiance, f32((plus << GRID_REACH_BITS) | minus)));
}

// A reach's code (`irradiance::reach_code`): its weighted mean distance (`focus.x / focus.y`; the
// clamp without weight) in steps of `reach_max / GRID_REACH_MASK`, rounded to the nearest step.
fn grid_reach_code(focus: vec2<f32>, reach_max: f32) -> u32 {
    let distance = select(reach_max, focus.x / focus.y, focus.y > 0.0);
    return u32(clamp(round(distance / reach_max * f32(GRID_REACH_MASK)), 0.0, f32(GRID_REACH_MASK)));
}
