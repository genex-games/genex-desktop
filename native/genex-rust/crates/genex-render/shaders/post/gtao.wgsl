// Ground-truth ambient occlusion (graph node 10; RQ4.4): slices × steps of horizon search over
// the prepass depth around each pixel's normal, at the AO resolution, into the raw term (visibility
// / GX_AO_RAW_SCALE in r; with bent normals the world-space bent normal as `n * 0.5 + 0.5` in gba).
// Written by a fragment pass: core has no `r8unorm` storage.
//
// A port of XeGTAO's `XeGTAO_PrefilterDepths16x16` and `XeGTAO_MainPass` (Intel, MIT; Filip
// Strugar 2021, after Jimenez et al. 2016, "Practical Real-Time Strategies for Accurate Indirect
// Occlusion"). The noise is XeGTAO's Hilbert-curve R2 sequence, keyed to the frame index only when
// AO keeps its own history (`counts.z` is 0 otherwise: a static per-pixel pattern, plan
// principle 6).
//
// Spaces: the prepass normals are world-space (view-space with flag 8) and octahedral. Depth is
// read from the AO resolution's view-depth chain (after XeGTAO's prefilter: mip 0 from the prepass
// depth, four more each holding one texel of the mip above), so far samples read coarse mips and
// stay in cache.
// The search runs in XeGTAO's view space (x right, y up, z the positive distance in front of the
// camera): the renderer's right-handed view space with z negated.

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
    // This frame's view space to last frame's, and last frame's projection (the denoise's).
    prev_view_from_view: mat4x4<f32>,
    prev_proj: mat4x4<f32>,
    // x, y: 1 / proj[0][0] and 1 / proj[1][1]; zw: the render size (`gx_ao_texel_placement`).
    unproject: vec4<f32>,
}

// The AO resolution's view-depth chain (r32float, positive distance in front of the camera, mip 0
// at the AO resolution, `GX_AO_SKY_DEPTH` where the sky is), built by `fs_ao_depth` and
// `fs_ao_depth_down` below.
@group(0) @binding(0) var gx_ao_depth: texture_2d<f32>;
@group(0) @binding(1) var gx_normals: texture_2d<f32>;
@group(0) @binding(2) var<uniform> gx_ao: AoParams;
@group(0) @binding(3) var<uniform> gx_ao_view: AoView;
// The chain's sources: the prepass depth (mip 0) and the mip above (the others).
@group(0) @binding(4) var gx_device_depth: texture_depth_2d;
@group(0) @binding(5) var gx_ao_depth_source: texture_2d<f32>;

const GX_AO_PI: f32 = 3.14159265358979;
const GX_AO_HALF_PI: f32 = 1.57079632679490;
// The raw term's packing (`post::ao::RAW_SCALE`): headroom over 1 (the fade adds a little).
const GX_AO_RAW_SCALE: f32 = 1.5;
// The view depth the chain holds for the sky (`post::ao::SKY_DEPTH`).
const GX_AO_SKY_DEPTH: f32 = 1e20;
// XeGTAO's defaults: the radius multiplier, the closest sample in
// pixels (the centre pixel teaches nothing), the screen radius below which AO fades out, the
// offset (log2 pixels) from which samples read coarser depth mips.
const GX_AO_RADIUS_MULTIPLIER: f32 = 1.457;
const GX_AO_TOO_CLOSE_PIXELS: f32 = 1.3;
const GX_AO_FADE_PIXELS: f32 = 10.0;
const GX_AO_MIP_OFFSET: f32 = 3.3;
// XeGTAO's final power (`FinalValuePower`) at intensity 1, and its floor: applied per pixel before
// the denoise averages, as XeGTAO does.
const GX_AO_POWER: f32 = 2.2;
const GX_AO_SLOPE_FUDGE: f32 = 0.05;
const GX_AO_MIN_VISIBILITY: f32 = 0.03;
// The least 1 - (normal . axis)² the slide divides by (`gx_ao_slide`): a slice within about 2
// degrees of the surface's own plane slides its samples at most about 30 times their offset.
const GX_AO_SLIDE_FLOOR: f32 = 1e-3;
// The least cosine between the depth's own normal and the shading normal for the slide to take
// the depth's (`gx_ao_geometric_normal`): smoothing over facets turns a normal by a few degrees,
// a quad across an edge by anything.
const GX_AO_GEOMETRIC_AGREEMENT: f32 = 0.7;
// The sky's distance as the derivatives see it: finite, so the quad's differences stay finite.
const GX_AO_FINITE_DEPTH: f32 = 1e6;
const GX_AO_FLAG_BENT: u32 = 2u;
// A slice's most unoccluded arc (`cos n + n sin n` at n = pi/2, a full projected normal): the
// weight's unit per slice.
const GX_AO_WEIGHT_FULL: f32 = 1.57079632679490;
// The least weight the raw term stores (one 8-bit level): a pixel whose slices all graze the
// surface still counts a little, so a window of them averages instead of dividing by zero.
const GX_AO_WEIGHT_FLOOR: f32 = 0.00392156862745098;
const GX_AO_FLAG_REVERSE_Z: u32 = 4u;
const GX_AO_FLAG_VIEW_NORMALS: u32 = 8u;
const GX_AO_FLAG_INTERLEAVE: u32 = 16u;
// The Hilbert curve's side (XeGTAO's level 6) and the R1/R2 sequences' generators.
const GX_AO_HILBERT_SIDE: u32 = 64u;
const GX_AO_R1: f32 = 0.6180339887498948;
const GX_AO_R2: vec2<f32> = vec2<f32>(0.7548776662466927, 0.5698402909980532);

struct AoOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_ao(@builtin(vertex_index) index: u32) -> AoOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return AoOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

// The positive view distance of the prepass texel `texel` (`GX_AO_SKY_DEPTH` for the sky).
fn gx_ao_linear_depth(texel: vec2<i32>) -> f32 {
    let depth = textureLoad(gx_device_depth, texel, 0);
    let reversed = (gx_ao.counts.w & GX_AO_FLAG_REVERSE_Z) != 0u;
    if (reversed && depth <= 0.0) || (!reversed && depth >= 1.0) {
        return GX_AO_SKY_DEPTH;
    }
    let view = gx_ao_view.inv_proj * vec4<f32>(0.0, 0.0, depth, 1.0);
    return -view.z / view.w;
}

// The render pixels per AO texel along each axis (1 at full resolution, 2 at half).
fn gx_ao_block() -> vec2<f32> {
    return max(floor(max(gx_ao_view.unproject.zw, vec2<f32>(1.0)) / gx_ao.size.xy), vec2<f32>(1.0));
}

// Where (AO pixel position) the surface AO texel `texel` stands for lies, as `texel * xy + zw`:
// the centre of its representative render pixel, the one under the texel's centre
// (`texel * block + block / 2`, whose depth mip 0 holds and whose normal the search reads; the
// upsample's representative too). Full resolution: the texel's centre.
fn gx_ao_texel_placement() -> vec4<f32> {
    let render = max(gx_ao_view.unproject.zw, gx_ao.size.xy);
    let block = gx_ao_block();
    let scale = gx_ao.size.xy / render;
    return vec4<f32>(block * scale, (floor(block * 0.5) + vec2<f32>(0.5)) * scale);
}

// Mip 0 of the chain: the prepass depth of each AO texel's representative render pixel as
// positive view distance. One real pixel, not the 2x2 block's average: the average of a block
// that straddles an edge (a slab's top and the floor below it) is a point in mid-air in front of
// the farther surface, which then occluded the farther surface's own edge (a thin step's crease
// bled onto its top) once the search stopped hiding small occlusions (gate finding 03).
@fragment
fn fs_ao_depth(in: AoOut) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(gx_device_depth));
    let block = max(size / vec2<i32>(gx_ao.size.xy), vec2<i32>(1));
    let representative = vec2<i32>(in.clip.xy) * block + block / vec2<i32>(2);
    return vec4<f32>(gx_ao_linear_depth(min(representative, size - vec2<i32>(1))), 0.0, 0.0, 1.0);
}

// Mips 1 and up: of each 2x2 block of the mip above, its last texel (`2 * texel + 1`), so every
// texel of the chain holds one real pixel's distance: texel `t` of mip `m` holds mip-0 texel
// `(t + 1) * 2^m - 1`, where the horizon search places it (`gx_ao_horizons`). XeGTAO
// averages the block with weights that keep thin near geometry; an average of a block that
// straddles an edge is a point in mid-air, which occluded the farther surface's edge, and on a
// grazing plane the average lies off the plane (gate finding 03). A thin occluder a coarse mip
// steps over is still seen by the near steps, which read mip 0.
@fragment
fn fs_ao_depth_down(in: AoOut) -> @location(0) vec4<f32> {
    let last = vec2<i32>(textureDimensions(gx_ao_depth_source)) - vec2<i32>(1);
    return vec4<f32>(textureLoad(gx_ao_depth_source, min(vec2<i32>(in.clip.xy) * 2 + vec2<i32>(1), last), 0).r, 0.0, 0.0, 1.0);
}

// The view distance at AO pixel position `ao_pos` from the chain's mip `mip`.
fn gx_ao_depth_at(ao_pos: vec2<f32>, mip: i32) -> f32 {
    let size = max(vec2<i32>(gx_ao.size.xy) >> vec2<u32>(u32(mip)), vec2<i32>(1));
    let texel = clamp(vec2<i32>(floor(ao_pos * gx_ao.size.zw * vec2<f32>(size))), vec2<i32>(0), size - vec2<i32>(1));
    return textureLoad(gx_ao_depth, texel, mip).r;
}

// The position in XeGTAO's view space (z the positive distance) of the point at AO pixel position
// `ao_pos` and view distance `distance`, through the projection's own terms (perspective or
// orthographic).
fn gx_ao_view_position(ao_pos: vec2<f32>, distance: f32) -> vec3<f32> {
    return gx_ao_unproject(gx_ao_ndc(ao_pos), distance);
}

// The NDC of AO pixel position `ao_pos`.
fn gx_ao_ndc(ao_pos: vec2<f32>) -> vec2<f32> {
    let uv = ao_pos * gx_ao.size.zw;
    return vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}

// The unit normal at AO pixel position `ao_pos` in XeGTAO's view space.
fn gx_ao_view_normal(ao_pos: vec2<f32>) -> vec3<f32> {
    let size = vec2<i32>(textureDimensions(gx_normals));
    let texel = clamp(vec2<i32>(floor(ao_pos * gx_ao.size.zw * vec2<f32>(size))), vec2<i32>(0), size - vec2<i32>(1));
    var n = gx_oct_decode(textureLoad(gx_normals, texel, 0).xy);
    if (gx_ao.counts.w & GX_AO_FLAG_VIEW_NORMALS) == 0u {
        n = (gx_ao_view.view * vec4<f32>(n, 0.0)).xyz;
    }
    return normalize(vec3<f32>(n.x, n.y, -n.z));
}

// XeGTAO's Hilbert index of `pixel` on a 64x64 tile: neighbouring pixels get well-spread R2 noise.
fn gx_ao_hilbert(pixel: vec2<u32>) -> u32 {
    var p = pixel % vec2<u32>(GX_AO_HILBERT_SIDE);
    var index = 0u;
    for (var level = GX_AO_HILBERT_SIDE / 2u; level > 0u; level = level / 2u) {
        let region_x = u32((p.x & level) > 0u);
        let region_y = u32((p.y & level) > 0u);
        index += level * level * ((3u * region_x) ^ region_y);
        if region_y == 0u {
            if region_x == 1u {
                p = vec2<u32>(GX_AO_HILBERT_SIDE - 1u) - p;
            }
            p = p.yx;
        }
    }
    return index;
}

// The slice and step noise of `pixel` (XeGTAO's spatio-temporal noise; frame 0 is static).
fn gx_ao_noise(pixel: vec2<u32>) -> vec2<f32> {
    let index = gx_ao_hilbert(pixel) + 288u * (gx_ao.counts.z % 64u);
    return fract(vec2<f32>(0.5) + f32(index) * GX_AO_R2);
}

// XeGTAO's `XeGTAO_FastACos` (Eberly's first-order fit): acos within 7e-5 rad of the real one.
fn gx_ao_fast_acos(x: f32) -> f32 {
    let a = abs(x);
    let r = (-0.156583 * a + GX_AO_HALF_PI) * sqrt(max(1.0 - a, 0.0));
    return select(GX_AO_PI - r, r, x >= 0.0);
}

// `v` turned by the rotation that takes unit `onto_from` onto unit `onto` (Rodrigues).
fn gx_ao_rotate(v: vec3<f32>, onto_from: vec3<f32>, onto: vec3<f32>) -> vec3<f32> {
    let axis = cross(onto_from, onto);
    let c = dot(onto_from, onto);
    let k = 1.0 / max(1.0 + c, 1e-6);
    return v * c + cross(axis, v) + axis * (dot(axis, v) * k);
}

// The view position (XeGTAO's space) of NDC `ndc` at view distance `distance`, through the
// projection's own terms (perspective or orthographic).
fn gx_ao_unproject(ndc: vec2<f32>, distance: f32) -> vec3<f32> {
    let p = gx_ao_view.proj;
    let z = -distance;
    let w = p[2][3] * z + p[3][3];
    let x = (ndc.x * w - p[2][0] * z - p[3][0]) * gx_ao_view.unproject.x;
    let y = (ndc.y * w - p[2][1] * z - p[3][1]) * gx_ao_view.unproject.y;
    return vec3<f32>(x, y, distance);
}

// The view-space ray of NDC `ndc` as a line in the view distance d: x and y are `d * a + b` for
// the returned (a, b) (perspective or orthographic: the projection's own terms). Linear in `ndc`.
fn gx_ao_ray(ndc: vec2<f32>) -> vec4<f32> {
    let p = gx_ao_view.proj;
    let u = gx_ao_view.unproject.xy;
    let a = (vec2<f32>(p[2][0], p[2][1]) - ndc * p[2][3]) * u;
    let b = (ndc * p[3][3] - vec2<f32>(p[3][0], p[3][1])) * u;
    return vec4<f32>(a, b);
}

// A slice's frame in XeGTAO's view space: the slice plane's axis (its normal), the plane's
// orthonormal pair (`across`, the +omega side's direction, and the view vector), and the slide
// (`gx_ao_slide`) as its components along that pair.
struct GxAoSlice {
    axis: vec3<f32>,
    across: vec3<f32>,
    view_vec: vec3<f32>,
    slide: vec2<f32>,
}

// The tangent-plane direction that crosses the slice plane of `axis` at unit rate, for `normal`:
// moving a sample along it by its distance off the slice keeps its height over the centre's
// tangent plane. Long where the normal lies near the axis (the slice grazes the surface).
fn gx_ao_slide(normal: vec3<f32>, axis: vec3<f32>) -> vec3<f32> {
    let across = dot(normal, axis);
    return (axis - normal * across) / max(1.0 - across * across, GX_AO_SLIDE_FLOOR);
}

// The horizon cosine of a sample at view distance `distance_at` on the ray `ray` (`gx_ao_ray`,
// its b already relative to the centre's x and y), seen from the centre at view distance
// `centre_z`, on the slice's `side` (1 the +omega side, -1 the other) whose horizon starts at
// `low`, with XeGTAO's falloff (`low` for the sky or beyond the radius).
//
// A sample sits on a whole texel, off the slice by up to half a texel (more on a coarse mip), and
// on ground seen at a grazing angle that half texel is a long way along the ground: such a sample
// stood above the slice's horizon and open flat ground occluded itself (gate finding 03). The
// sample is slid back onto the slice along the centre's tangent plane, which keeps its height over
// that plane (a plane's samples land on the slice's horizon exactly); one the slide carries past
// the centre to the other side teaches nothing about this side.
//
// The falloff measures the offset with its depth part stretched by `1 + params.w` (XeGTAO's
// thin-occluder compensation, `ThinOccluderCompensation`): a sample far in front of or behind the
// centre falls off sooner, so thin geometry (a kerb, a draped path) is not taken for a wall of
// infinite thickness. 0, the default, is plain distance.
fn gx_ao_sample(distance_at: f32, ray: vec4<f32>, centre_z: f32, slice: GxAoSlice, side: f32, low: f32, falloff: vec2<f32>) -> f32 {
    let aimed = vec3<f32>(distance_at * ray.xy + ray.zw, distance_at - centre_z);
    // The slid sample in the slice's own coordinates (it lies in the slice plane): x across the
    // screen (the +omega side positive), y towards the camera.
    let off_slice = dot(aimed, slice.axis);
    let x = dot(aimed, slice.across) - off_slice * slice.slide.x;
    let y = dot(aimed, slice.view_vec) - off_slice * slice.slide.y;
    let length_squared = max(x * x + y * y, 1e-12);
    let inv_length = inverseSqrt(length_squared);
    // Without thin-occluder compensation (the default) the stretched length is the length.
    var stretched = length_squared * inv_length;
    if gx_ao.params.w > 0.0 {
        let delta = slice.across * x + slice.view_vec * y;
        stretched = length(vec3<f32>(delta.xy, delta.z * (1.0 + gx_ao.params.w)));
    }
    let weight = clamp(stretched * falloff.x + falloff.y, 0.0, 1.0);
    let teaches_nothing = distance_at >= GX_AO_SKY_DEPTH || x * side <= 0.0;
    return select(mix(low, y * inv_length, weight), low, teaches_nothing);
}

// Both sides' horizon cosines along `omega` (pixels per unit of `s`, +omega first) from AO pixel
// `ao_pos` (NDC `ndc`, view position `centre`), starting at the normal's horizons `low`:
// `counts.y` steps on each side (XeGTAO's `StepsPerSlice`), both sides of a step sharing its
// distance and mip. Samples sit on their mip texels' centres; one off screen is skipped. With
// `GX_AO_FLAG_INTERLEAVE` (a temporal frame that blends history) the frame takes every other step,
// the frame index's parity choosing which, so two frames of history hold every step.
fn gx_ao_horizons(ao_pos: vec2<f32>, ndc: vec2<f32>, ray_per_texel: vec4<f32>, centre: vec3<f32>, frame: GxAoSlice, omega: vec2<f32>, low: vec2<f32>, slice: u32, noise: f32, min_s: f32, falloff: vec2<f32>) -> vec2<f32> {
    let steps = gx_ao.counts.y;
    let interleaved = (gx_ao.counts.w & GX_AO_FLAG_INTERLEAVE) != 0u;
    let stride = select(1u, 2u, interleaved);
    let first = select(0u, gx_ao.counts.z & 1u, interleaved);
    let inv_steps = 1.0 / f32(steps);
    let last_mip = f32(textureNumLevels(gx_ao_depth) - 1u);
    let size = vec2<i32>(gx_ao.size.xy);
    // A step's mip from its distance along the slice: log2 of its offset in pixels, less XeGTAO's
    // offset.
    let mip_bias = log2(length(omega)) - GX_AO_MIP_OFFSET;
    let origin = vec2<i32>(ao_pos);
    let centre_texel = vec2<f32>(origin);
    // The centre's ray (b relative to the centre) and how a and b change per AO pixel: each
    // sample's view position is its depth along its ray, with no matrix per tap.
    let ray = gx_ao_ray(ndc) - vec4<f32>(0.0, 0.0, centre.xy);
    // Per mip-0 texel of the chain (`gx_ao_ray_per_texel`): a texel `t` of mip `m` holds mip-0
    // texel `(t + 1) * 2^m - 1` (`fs_ao_depth_down`).
    let first_texel = centre_texel + vec2<f32>(1.0);
    var horizons = low;
    for (var i = first; i < steps; i += stride) {
        let step_noise = fract(noise + f32(slice + i * steps) * GX_AO_R1);
        // XeGTAO's sample distribution power (2): denser near the pixel.
        let t = (f32(i) + step_noise) * inv_steps;
        let s = t * t + min_s;
        let offset = round(s * omega);
        let mip = u32(round(clamp(log2(s) + mip_bias, 0.0, last_mip)));
        let last = max(size >> vec2<u32>(mip), vec2<i32>(1)) - vec2<i32>(1);
        let px_step = vec2<i32>(offset);
        // Clamped on screen before the shift (read, then discarded off screen), then to the mip's
        // last texel (a mip's size rounds down).
        let texel0 = min(max(origin + px_step, vec2<i32>(0)) >> vec2<u32>(mip), last);
        let texel1 = min(max(origin - px_step, vec2<i32>(0)) >> vec2<u32>(mip), last);
        let d0 = textureLoad(gx_ao_depth, texel0, i32(mip)).r;
        let d1 = textureLoad(gx_ao_depth, texel1, i32(mip)).r;
        // Each sample sits where the distance it read was measured (its mip-0 texel), not at
        // the pixel it aimed at: on ground seen at a grazing angle the aimed pixel with another
        // pixel's distance stood above the ground half the time (gate finding 03).
        let scale = f32(1u << mip);
        let at0 = (vec2<f32>(texel0) + vec2<f32>(1.0)) * scale - first_texel;
        let at1 = (vec2<f32>(texel1) + vec2<f32>(1.0)) * scale - first_texel;
        let s0 = gx_ao_sample(d0, ray + ray_per_texel * at0.xyxy, centre.z, frame, 1.0, low.x, falloff);
        let s1 = gx_ao_sample(d1, ray + ray_per_texel * at1.xyxy, centre.z, frame, -1.0, low.y, falloff);
        // A sample off screen teaches nothing: the edge's depth read in its place stood off the
        // slice and drew dots of false occlusion along the screen's bottom edge (gate finding 03).
        horizons.x = max(horizons.x, select(low.x, s0, gx_ao_on_screen(origin + px_step, size)));
        horizons.y = max(horizons.y, select(low.y, s1, gx_ao_on_screen(origin - px_step, size)));
    }
    return horizons;
}

// Whether AO pixel `pixel` lies on an AO target of `size` pixels.
fn gx_ao_on_screen(pixel: vec2<i32>, size: vec2<i32>) -> bool {
    // A negative coordinate wraps past every size as unsigned.
    return all(vec2<u32>(pixel) < vec2<u32>(size));
}

// How a view ray's (a, b) (`gx_ao_ray`) change per texel of the AO target's mip 0, whose texels
// sit `gx_ao_texel_placement().xy` AO pixels apart.
fn gx_ao_ray_per_texel() -> vec4<f32> {
    let p = gx_ao_view.proj;
    let u = gx_ao_view.unproject.xy;
    let ndc_per_pixel = vec2<f32>(2.0, -2.0) * gx_ao.size.zw;
    return vec4<f32>(-p[2][3] * u, p[3][3] * u) * (ndc_per_pixel * gx_ao_texel_placement().xy).xyxy;
}

// The normal of the surface the depth holds, from the view position's screen derivatives
// `quad` (one-sided differences across the pixel quad; XeGTAO's space), on the shading normal
// `shading`'s side. The shading normal where the two turn apart by more than smoothing over a
// facet turns a normal: a quad across an edge or a texel-thin object, or the sky.
fn gx_ao_geometric_normal(quad: mat2x3<f32>, shading: vec3<f32>) -> vec3<f32> {
    let n = cross(quad[0], quad[1]);
    let length_squared = dot(n, n);
    if !(length_squared > 1e-30) {
        return shading;
    }
    let g = n * inverseSqrt(length_squared) * sign(dot(n, shading) + 1e-12);
    return select(shading, g, dot(g, shading) >= GX_AO_GEOMETRIC_AGREEMENT);
}

// One pixel's raw estimate (`gx_gtao`).
struct GxAoEstimate {
    // Visibility (one pixel's, so it may exceed 1).
    visibility: f32,
    // The arcs the slices would have unoccluded, over the most `counts.x` slices can have
    // (`GX_AO_WEIGHT_FULL` each): how much of the cosine-weighted hemisphere the estimate measured.
    weight: f32,
    // The bent normal in XeGTAO's view space (zero without bent normals).
    bent: vec3<f32>,
}

// The raw estimate at AO pixel `ao_pos` (view position `centre`, whose screen derivatives are
// `quad`).
fn gx_gtao(ao_pos: vec2<f32>, centre: vec3<f32>, quad: mat2x3<f32>) -> GxAoEstimate {
    let view_vec = normalize(-centre);
    let normal = gx_ao_view_normal(ao_pos);
    // The slide keeps a sample's height over the surface the depth holds, which is not the shading
    // normal's plane where normals are smoothed over flat facets (a heightfield's rolling ground):
    // in a slice that grazes the surface the slide carries a sample many times its offset, so the
    // facet's small tilt against the smoothed normal drew a streak of false occlusion along the
    // ground's creases (pass-1 fix gate, visual RED 01). The arcs stay the shading normal's.
    let geometric = gx_ao_geometric_normal(quad, normal);
    let effect_radius = gx_ao.params.x * GX_AO_RADIUS_MULTIPLIER;
    let falloff_range = gx_ao.params.z * effect_radius;
    let falloff_from = effect_radius * (1.0 - gx_ao.params.z);
    let falloff = vec2<f32>(-1.0 / falloff_range, falloff_from / falloff_range + 1.0);
    // Pixels a view-space unit covers at this depth (perspective or orthographic).
    let clip_w = (gx_ao_view.proj * vec4<f32>(centre.x, centre.y, -centre.z, 1.0)).w;
    let screen_radius = effect_radius * 0.5 * gx_ao.size.x * gx_ao_view.proj[0][0] / max(clip_w, 1e-6);
    if screen_radius < GX_AO_TOO_CLOSE_PIXELS {
        return GxAoEstimate(1.0, 1.0, vec3<f32>(0.0));
    }
    let fade = clamp((GX_AO_FADE_PIXELS - screen_radius) / 100.0, 0.0, 1.0) * 0.5;
    // The slices' visible arcs and, beside them, the arcs they would have unoccluded: their ratio is
    // the pixel's visibility (a ratio estimator). Each slice's own estimate depends on its angle to
    // the normal (cos n + n sin n unoccluded: up to about 1.6 on ground seen from eye height, near
    // 0 across it), so a pixel with one or two slices drew open flat ground anywhere from black to
    // past white and only the denoise's window averaged it back: a mottle the final power and the
    // packing's clip turned into false occlusion (gate finding 03). The ratio is exactly 1 on open
    // ground at any slice angle and converges to the same visibility as the plain mean.
    var visible = 0.0;
    var unoccluded = 0.0;
    var bent = vec3<f32>(0.0);
    let noise = gx_ao_noise(vec2<u32>(ao_pos));
    let ndc = gx_ao_ndc(ao_pos);
    let ray_per_texel = gx_ao_ray_per_texel();
    let min_s = GX_AO_TOO_CLOSE_PIXELS / screen_radius;
    let slices = gx_ao.counts.x;
    for (var slice = 0u; slice < slices; slice++) {
        let phi = (f32(slice) + noise.x) / f32(slices) * GX_AO_PI;
        let cos_phi = cos(phi);
        let sin_phi = sin(phi);
        // Screen y points down, view y up.
        let omega = vec2<f32>(cos_phi, -sin_phi) * screen_radius;
        let direction = vec3<f32>(cos_phi, sin_phi, 0.0);
        let ortho = direction - dot(direction, view_vec) * view_vec;
        let axis = normalize(cross(ortho, view_vec));
        let projected = normal - axis * dot(normal, axis);
        // XeGTAO's fudge for the slight over-darkening on steep slopes (its training set agreed).
        let projected_length = mix(length(projected), 1.0, GX_AO_SLOPE_FUDGE);
        let sign_n = select(-1.0, 1.0, dot(ortho, projected) >= 0.0);
        let cos_n = clamp(dot(projected, view_vec) / max(length(projected), 1e-6), 0.0, 1.0);
        let n = sign_n * gx_ao_fast_acos(cos_n);
        let sin_n = sin(n);
        // The normal's horizons cos(n ± pi/2), and below, the arcs and the bent normal through the
        // angle-sum identities on one sine and cosine per horizon (XeGTAO's closed forms, fewer
        // transcendentals).
        let across = normalize(ortho);
        let slide = gx_ao_slide(geometric, axis);
        let frame = GxAoSlice(axis, across, view_vec, vec2<f32>(dot(slide, across), dot(slide, view_vec)));
        let horizons = gx_ao_horizons(ao_pos, ndc, ray_per_texel, centre, frame, omega, vec2<f32>(-sin_n, sin_n), slice, noise.y, min_s, falloff);
        let h0 = n + clamp(-gx_ao_fast_acos(horizons.y) - n, -GX_AO_HALF_PI, GX_AO_HALF_PI);
        let h1 = n + clamp(gx_ao_fast_acos(horizons.x) - n, -GX_AO_HALF_PI, GX_AO_HALF_PI);
        let sh = sin(vec2<f32>(h0, h1));
        let ch = cos(vec2<f32>(h0, h1));
        let c2 = 2.0 * ch * ch - vec2<f32>(1.0);
        let s2 = 2.0 * sh * ch;
        let cos_2h_n = c2 * cos_n + s2 * sin_n;
        let arc = (vec2<f32>(cos_n) + 2.0 * vec2<f32>(h0, h1) * sin_n - cos_2h_n) * 0.25;
        visible += projected_length * (arc.x + arc.y);
        // The same arcs with both horizons at the normal's (cos(2h - n) = -cos n there).
        unoccluded += projected_length * (cos_n + n * sin_n);
        if gx_ao_bent() {
            let s3 = sh * (3.0 - 4.0 * sh * sh);
            let c3 = ch * (4.0 * ch * ch - 3.0);
            let sin_h_n = sh * cos_n - ch * sin_n;
            let sin_3h_n = s3 * cos_n - c3 * sin_n;
            let sin_hpn = sh * cos_n + ch * sin_n;
            let cos_3h_n = c3 * cos_n + s3 * sin_n;
            let cos_hpn = ch * cos_n - sh * sin_n;
            let t0 = (6.0 * (sin_h_n.x + sin_h_n.y) - (sin_3h_n.x + sin_3h_n.y) + 16.0 * sin_n - 3.0 * (sin_hpn.x + sin_hpn.y)) / 12.0;
            let t1 = (-(cos_3h_n.x + cos_3h_n.y) + 8.0 * cos_n - 3.0 * (cos_hpn.x + cos_hpn.y)) / 12.0;
            let local = vec3<f32>(direction.x * t0, direction.y * t0, -t1);
            bent += gx_ao_rotate(local, vec3<f32>(0.0, 0.0, -1.0), view_vec) * projected_length;
        }
    }
    let weight = unoccluded / (f32(slices) * GX_AO_WEIGHT_FULL);
    return GxAoEstimate(visible / max(unoccluded, 1e-4) + fade / f32(slices), weight, bent);
}

@fragment
fn fs_gtao(in: AoOut) -> @location(0) vec4<f32> {
    let placement = gx_ao_texel_placement();
    let ao_pos = floor(in.clip.xy) * placement.xy + placement.zw;
    let depth = gx_ao_depth_at(ao_pos, 0);
    // The derivatives need the whole quad, so they are taken before the sky's early return (whose
    // distance is held finite here: the normal refuses its differences anyway).
    let centre = gx_ao_view_position(ao_pos, min(depth, GX_AO_FINITE_DEPTH));
    let quad = mat2x3<f32>(dpdxFine(centre), dpdyFine(centre));
    if depth >= GX_AO_SKY_DEPTH {
        // The sky: unoccluded, no bent normal (or a full weight); the denoise never reads it.
        return vec4<f32>(1.0 / GX_AO_RAW_SCALE, select(1.0, 0.5, gx_ao_bent()), 0.5, 0.5);
    }
    let term = gx_gtao(ao_pos, centre, quad);
    let visibility = clamp(max(pow(max(term.visibility, 0.0), GX_AO_POWER * gx_ao.params.y), GX_AO_MIN_VISIBILITY) / GX_AO_RAW_SCALE, 0.0, 1.0);
    if !gx_ao_bent() {
        // The raw term without a bent normal (`post::ao::RAW_WEIGHTED_FORMAT`) carries the
        // estimate's weight for the denoise to average by.
        return vec4<f32>(visibility, clamp(term.weight, GX_AO_WEIGHT_FLOOR, 1.0), 0.0, 0.0);
    }
    var bent_world = vec3<f32>(0.0);
    if dot(term.bent, term.bent) > 1e-12 {
        // Back to the renderer's view space (z negated), then to world space.
        let bent_view = normalize(vec3<f32>(term.bent.x, term.bent.y, -term.bent.z));
        bent_world = normalize((vec4<f32>(bent_view, 0.0) * gx_ao_view.view).xyz);
    }
    return vec4<f32>(visibility, bent_world * 0.5 + vec3<f32>(0.5));
}

// Whether GTAO integrates a bent normal (the raw term's gba hold it).
fn gx_ao_bent() -> bool {
    return (gx_ao.counts.w & GX_AO_FLAG_BENT) != 0u;
}
