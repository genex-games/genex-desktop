// The joint-bilateral upsample of a half-resolution screen effect to the render size (RQ4 review):
// AO's term (graph node 10) and the sun's contact-shadow mask (10a) are made at half the render
// size, and the world pass reads them per pixel. A plain bilinear (or nearest) read bleeds a thin
// crease or a contact shadow onto the surface beside it and shows the half-size texels as blocks;
// here each render pixel blends the four low-resolution texels around it with the bilinear weights
// times how well each texel's own surface (its representative pixel's view distance and normal in
// the prepass) matches the pixel's, so a texel of another surface contributes almost nothing.
//
// Each low-resolution texel `t` stands for the render pixel `floor((t + 0.5) * full / low)`, the
// pixel under its centre (its normal), at the view distance the effect was made at: AO's comes from
// its own view-depth chain (`gx_guide`, that pixel's distance its horizon search ran from,
// `GX_UP_GUIDE`), the contact shadows' from that pixel's prepass depth (the receiver the
// march rebuilt). Pixels where the prepass drew nothing (the sky) take the nearest texel: no
// surface reads them.

// Mirrors `post::upsample::GpuUpsampleParams`.
struct UpsampleParams {
    // xy: the low-resolution size; zw: the render size.
    sizes: vec4<f32>,
    // Clip to view space: the inverse of the projection the prepass depth was drawn with.
    inv_proj: mat4x4<f32>,
    // x: 1 under reverse-Z; yzw: reserved.
    flags: vec4<u32>,
}

@group(0) @binding(0) var gx_low: texture_2d<f32>;
@group(0) @binding(1) var gx_depth: texture_depth_2d;
@group(0) @binding(2) var gx_normals: texture_2d<f32>;
@group(0) @binding(3) var<uniform> gx_up: UpsampleParams;
// The low-resolution view distances (r32float, `GX_UP_GUIDE`; a stand-in never read otherwise).
@group(0) @binding(4) var gx_guide: texture_2d<f32>;

// The relative view-distance difference at which a texel's depth weight falls to a quarter (with
// the floor, `1 / (floor + difference)²`: a kerb a few centimetres high a few metres away is
// another surface), and the normal agreement's power.
const GX_UP_DEPTH_FLOOR: f32 = 0.01;
const GX_UP_NORMAL_POWER: f32 = 8.0;
// The least normal weight (two faces at a right angle still blend a little where nothing better is
// near: a crease's own texels).
const GX_UP_NORMAL_FLOOR: f32 = 0.001;
// Whether the normals weigh in (the renderer's prepass has them; a depth-only caller has none and
// binds another texture at their slot, never read).
override GX_UP_NORMALS: bool = true;
// Whether `gx_guide` holds each texel's view distance (else the representative pixel's depth).
override GX_UP_GUIDE: bool = false;
// The guide's sky distance (`post::ao::SKY_DEPTH`).
const GX_UP_GUIDE_SKY: f32 = 1e20;

// The view distance low-resolution texel `texel` was made at (0 for the sky).
fn gx_up_texel_distance(texel: vec2<i32>) -> f32 {
    if GX_UP_GUIDE {
        let distance = textureLoad(gx_guide, texel, 0).r;
        return select(distance, 0.0, distance >= GX_UP_GUIDE_SKY);
    }
    return gx_up_distance(gx_up_representative(texel));
}

struct UpsampleOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_upsample(@builtin(vertex_index) index: u32) -> UpsampleOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return UpsampleOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

// Whether a prepass depth is the cleared far plane (nothing drawn).
fn gx_up_is_sky(depth: f32) -> bool {
    if gx_up.flags.x == 1u {
        return depth <= 0.0;
    }
    return depth >= 1.0;
}

// The positive view distance of the prepass pixel `pixel` (0 for the sky).
fn gx_up_distance(pixel: vec2<i32>) -> f32 {
    let depth = textureLoad(gx_depth, pixel, 0);
    if gx_up_is_sky(depth) {
        return 0.0;
    }
    let view = gx_up.inv_proj * vec4<f32>(0.0, 0.0, depth, 1.0);
    return -view.z / view.w;
}

// The render pixel low-resolution texel `texel` stands for.
fn gx_up_representative(texel: vec2<i32>) -> vec2<i32> {
    let full = vec2<i32>(gx_up.sizes.zw);
    let at = vec2<i32>(floor((vec2<f32>(texel) + vec2<f32>(0.5)) * gx_up.sizes.zw / gx_up.sizes.xy));
    return clamp(at, vec2<i32>(0), full - vec2<i32>(1));
}

@fragment
fn fs_upsample(in: UpsampleOut) -> @location(0) vec4<f32> {
    let pixel = vec2<i32>(in.clip.xy);
    let low = vec2<i32>(gx_up.sizes.xy);
    let last = low - vec2<i32>(1);
    let position = (vec2<f32>(pixel) + vec2<f32>(0.5)) * gx_up.sizes.xy / gx_up.sizes.zw - vec2<f32>(0.5);
    let base = vec2<i32>(floor(position));
    let distance = gx_up_distance(pixel);
    if distance <= 0.0 {
        return textureLoad(gx_low, clamp(vec2<i32>(round(position)), vec2<i32>(0), last), 0);
    }
    let f = position - floor(position);
    var normal = vec3<f32>(0.0);
    if GX_UP_NORMALS {
        normal = gx_oct_decode(textureLoad(gx_normals, pixel, 0).xy);
    }
    var sum = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var corner = 0u; corner < 4u; corner++) {
        let offset = vec2<i32>(i32(corner & 1u), i32(corner >> 1u));
        let texel = clamp(base + offset, vec2<i32>(0), last);
        let bilinear = select(1.0 - f.x, f.x, offset.x == 1) * select(1.0 - f.y, f.y, offset.y == 1);
        let at = gx_up_representative(texel);
        let texel_distance = gx_up_texel_distance(texel);
        // The sky's texels (distance 0) are another surface for every pixel that has one.
        let difference = select(abs(texel_distance - distance) / distance, 1e6, texel_distance <= 0.0);
        var agreement = 1.0;
        if GX_UP_NORMALS {
            agreement = max(pow(max(dot(normal, gx_oct_decode(textureLoad(gx_normals, at, 0).xy)), 0.0), GX_UP_NORMAL_POWER), GX_UP_NORMAL_FLOOR);
        }
        let closeness = 1.0 / (GX_UP_DEPTH_FLOOR + difference);
        let weight = max(bilinear, 1e-4) * closeness * closeness * agreement;
        sum += textureLoad(gx_low, texel, 0) * weight;
        weight_sum += weight;
    }
    return sum / max(weight_sum, 1e-12);
}
