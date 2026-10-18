// Lighting chunk: the sun. Its direct light through the cascaded shadow maps and the screen-space
// contact shadows. Reads the forward bindings `frame`, `shadow_map` and `shadow_sampler` and the
// accessors `gx_contact_shadow` (shaders/effects.wgsl; 1 where none are drawn),
// `gx_sun_screen_shadow` (the sun-shadow screen mask, renderer pass 2 B.7; -1 where none) and
// `gx_sun_cascade_bias` (each cascade's comparison bias: the frame uniforms' per-cascade row in the
// forward pass, the shared `shadow_params.x` in the v2 prelude); `shade` is pbr.wgsl's BRDF.
//
// The chunk compiles against FrameUniforms (the forward pass) and GxFrameV2 (the Level-2 v2
// prelude), so it reads only members both frames share under one meaning: `camera_pos`,
// `camera_forward`, `sun_dir` (w: the sun's angular radius in radians, GxFrameV2's meaning; 0 is a
// point sun), `cascade_splits.w` (the sun casts shadows), `shadow_params` (x: depth bias, w: one
// shadow texel in uv), `cascade_ends`, `cascade_offsets` and `cascade_view_proj` (four rows). A
// frame draws 1 to GX_MAX_CASCADES cascades; an undrawn cascade ends at 0, so the drawn count is
// the leading run of positive ends (`gx_sun_cascades`). Each cascade's texel and depth range in
// world units come from its own orthographic matrix, so the chunk needs no per-cascade table.
//
// What the frames do not share, the fragment entry hands over through `gx_sun_shadow_context`
// before it shades: the pixel (the noise that rotates the soft filters' taps), the frame key
// (the frame index, read only under TAA) and the cascade blend band; and through
// `gx_sun_shadow_end_fade` the share of the last cascade over which the shadows fade out before
// the shadow distance. An entry that never calls them shades with all of them 0: an unrotated tap
// pattern, a hard switch between cascades and a hard end at the shadow distance.
//
// The filter is a pipeline constant, `GX_SHADOW_FILTER` (settings.rs `ShadowFilter::shader_id`):
//   0 one hardware 2x2 comparison tap (a one-texel edge);
//   1 3x3 PCF, nine bilinear comparison taps (the default: the legacy renderer, bit for bit);
//   2 5x5 PCF as nine `textureGatherCompare` footprints weighted to the bilinear 5x5 kernel;
//   3 PCSS-lite (6 bilinear blocker taps, 16 filter taps) and 4 PCSS (8 and 32); each search also
//   reads the receiver's own texel.
// PCSS finds the average blocker depth around the receiver by gathering the shadow map's four
// texels a bilinear read touches through the non-filtering `point_sampler` (one fetch where four
// `textureLoad`s were; both preludes bind it, `layout::SHADOW_BLOCKER_SAMPLER`), turns the receiver-to-blocker distance into a penumbra in world units from the sun's angular
// radius, w = (d_receiver - d_blocker) x tan(angular radius), capped at GX_PCSS_MAX_WORLD metres
// in every cascade and preset alike. Search and filter each run in the first cascade, from the
// receiver's own, whose GX_PCSS_MAX_TEXELS texels span their radius and whose map holds the
// receiver (a wide penumbra is read from a coarser cascade, so the kernel stays within 16 texels
// and the penumbra stays the same width across a split); only past the last such cascade is the
// radius held to 16 of the receiver cascade's texels. The search reaches as far as a blocker at
// the receiver cascade's slice sphere's sun-side point would spread its penumbra (renderer pass 2,
// P2-0.3, SH-06: not from the map's near plane, which the legacy fit puts 60 units towards the sun).
//
// The blocker search is the same on every frame (P2-0.3, SH-03): a fixed Vogel disk (a
// golden-angle spiral, Poisson-like for every tap count) plus the receiver's own texel, each tap
// weighing the four texels a bilinear read would touch, so the blockers it finds change smoothly
// with the receiver. Where it finds less than one tap's worth of blocker, PCSS eases into the
// receiver's own bilinear tap (a one-texel edge) instead of returning the light whole, so a soft
// shadow leaves its penumbra without a step. Only the filter's taps turn: by interleaved gradient
// noise of the pixel, and only under TAA (`GX_SHADOW_TEMPORAL`) does the frame key turn it further,
// so a frame without TAA is the same bits every time. P2-0.3 measured noise keyed to the
// shadow-map texel instead: one rotation per texel left TAA's 3x3 clip box no spread to hold the
// history with, and open Lakeside ground under the 7 degree sun flickered 18 times as much while
// the camera crept (0.82% of pixels a frame at high against 0.046%). The transparent pipeline compiles it off under
// TAA too (renderer.rs `SurfaceKey::blended`): TAA takes a moving transparent's current sample
// almost whole, so frame-keyed taps reached the screen unaveraged. Taps are compared against the
// receiver's plane in light space (receiver-plane depth bias), so a wide kernel on a sloped
// receiver does not shadow itself; a receiver steeper than the plane follows keeps the rest of its
// slope as a bias that grows with the tap's distance.
//
// The lookup's normal offset (each cascade's `cascade_offsets`, a number of its texels) follows the
// light wherever the quality draws soft edges (P2-0.3, B5a, Godot's): scaled by 1 - N.L and with
// its part along the light removed (`gx_sun_normal_offset`). The features-off and legacy frames
// keep the offset along the normal, bit for bit.
//
// Cascade blending: inside the last `blend_band` fraction of a cascade's depth range the next
// cascade fades in, a lerp of the two lookups with or without TAA (P2-0.3, SH-02: every reference
// engine lerps; a per-frame dither left a ring boiling at each split under motion). Both lookups
// take one normal offset, eased from the cascade's to the next one's across the band, so they put
// an edge in the same place and neither end of the band steps. Inside the last `end_fade` fraction
// of the last cascade's range the sun's visibility fades to 1, so shadows end softly at the shadow
// distance. A receiver past a map's far plane (a far cascade the cadence holds while the camera
// moves) compares against the map's deepest depth instead of reading lit (P2-0.3, S4).

// Most cascades a frame draws (layout.rs `MAX_CASCADES`).
const GX_MAX_CASCADES: u32 = 4u;
// `GX_SHADOW_FILTER` values.
const GX_SHADOW_HARDWARE: u32 = 0u;
const GX_SHADOW_PCF3: u32 = 1u;
const GX_SHADOW_PCF5: u32 = 2u;
const GX_SHADOW_PCSS_LITE: u32 = 3u;
// PCSS's widest penumbra radius in world units (metres), the same in every cascade and preset.
const GX_PCSS_MAX_WORLD: f32 = 1.0;
// PCSS's widest kernel radius (blocker search and filter) in texels of the cascade it reads: a
// wider world radius is read from a coarser cascade. PCSS-lite shares both: fewer taps over the
// same penumbra.
const GX_PCSS_MAX_TEXELS: f32 = 16.0;
// The steepest receiver slope (world depth per world unit across the map) the receiver-plane bias
// follows; a receiver nearly edge-on to the sun keeps this slope, and the rest of its slope as a
// bias growing with each tap's distance. P2-0.3 (SH-11): open ground under a 7 degree sun climbs
// 8.1, which the old clamp of 4 cut, so PCSS found the ground itself on the sun side.
const GX_SHADOW_MAX_RECEIVER_SLOPE: f32 = 16.0;
// The blocker weight (in taps: each tap weighs four texels bilinearly) from which PCSS's result is
// its filter's whole; below it the result eases into the receiver's own one-texel tap.
const GX_PCSS_FOUND_WHOLE: f32 = 1.0;
// The blocker search's taps besides the receiver's own, and the filter's taps: PCSS-lite and PCSS.
// Each search tap reads the four texels a bilinear read touches (P2-0.3), so fewer taps than pass
// 1's point taps read more texels: 6 and 8 keep the disk-sun law (0.0485 and 0.0458 m of penumbra
// per metre against 0.048) at 2.8x and 2.2x pass 1's filter cost for 4 cascades at 1080p on the M4
// Max (0.64 and 0.79 ms against 0.23 and 0.37; 16 taps cost 1.42 ms for the same law).
const GX_PCSS_LITE_SEARCH: u32 = 6u;
const GX_PCSS_LITE_TAPS: u32 = 16u;
const GX_PCSS_SEARCH: u32 = 8u;
const GX_PCSS_TAPS: u32 = 32u;
// The golden angle in radians (the Vogel disk's step).
const GX_GOLDEN_ANGLE: f32 = 2.3999632;
const GX_TAU: f32 = 6.2831853;

override GX_SHADOW_FILTER: u32 = GX_SHADOW_PCF3;
// Whether a temporal resolve (TAA) accumulates the surface: the soft filters' tap pattern then also
// turns with the frame key. Off (no TAA, or the transparent pipeline): a static pattern.
override GX_SHADOW_TEMPORAL: bool = false;
// Whether the quality blends cascades over a band or fades the last one out (RX.R1), and with them
// the light-facing normal offset (P2-0.3): off, the band and the end fade are compiled out, every
// cascade switches and ends hard and the offset runs along the normal, as the features-off and
// legacy frames draw (the Level-2 v2 prelude sets it from its own band and end fade).
override GX_SUN_SOFT_EDGES: bool = true;
// The most cascades the quality draws (RX.R1): the cascade choice never looks past them.
override GX_SUN_CASCADES: u32 = GX_MAX_CASCADES;

// What the fragment entry hands the chunk (`gx_sun_shadow_context`).
struct GxSunShadowContext {
    // The fragment's pixel (`@builtin(position).xy`): keys the filter's tap rotation.
    pixel: vec2<f32>,
    // The frame index; read only under GX_SHADOW_TEMPORAL.
    frame_key: u32,
    // The fraction of each cascade's depth range blended into the next (0: a hard switch).
    blend_band: f32,
}

var<private> gx_sun_context: GxSunShadowContext;
// The fraction of the last cascade's depth range over which the shadows fade out (0: a hard end).
var<private> gx_sun_end_fade: f32;

// Hand the sun chunk the fragment's pixel, the frame key and the cascade blend band; call it in
// the fragment entry before shading. Not calling it is all three 0.
fn gx_sun_shadow_context(pixel: vec2<f32>, frame_key: u32, blend_band: f32) {
    gx_sun_context = GxSunShadowContext(pixel, frame_key, blend_band);
}

// Hand the sun chunk the share of the last cascade's depth range over which the shadows fade out
// before the shadow distance; call it in the fragment entry before shading. Not calling it is 0.
fn gx_sun_shadow_end_fade(fade: f32) {
    gx_sun_end_fade = fade;
}

// The cascades the frame draws: the leading run of positive `cascade_ends`. Unrolled over the
// four lanes with no loop (RX.R1: the looped walks of the cascade table, taken three times per
// fragment, cost the features-off bench-outdoor frame about 0.05 ms GPU p50 at 1080p).
fn gx_sun_cascades() -> u32 {
    let e = frame.cascade_ends;
    return select(0u, select(1u, select(2u, select(3u, 4u, e.w > 0.0), e.z > 0.0), e.y > 0.0), e.x > 0.0);
}

// The cascade view depth `depth` falls in among the first `count`, or GX_MAX_CASCADES beyond the
// last drawn one: the nearest whose end holds it (the ends grow with the cascade).
fn gx_sun_cascade_of(depth: f32, count: u32) -> u32 {
    let e = frame.cascade_ends;
    var cascade = GX_MAX_CASCADES;
    if GX_SUN_CASCADES > 3u && count > 3u && depth <= e.w {
        cascade = 3u;
    }
    if GX_SUN_CASCADES > 2u && count > 2u && depth <= e.z {
        cascade = 2u;
    }
    if GX_SUN_CASCADES > 1u && count > 1u && depth <= e.y {
        cascade = 1u;
    }
    if count > 0u && depth <= e.x {
        cascade = 0u;
    }
    return cascade;
}

// The cascade view depth `depth` falls in, or GX_MAX_CASCADES beyond the last drawn one.
fn gx_sun_cascade(depth: f32) -> u32 {
    return gx_sun_cascade_of(depth, gx_sun_cascades());
}

// Interleaved gradient noise (Jimenez 2014) of the context's pixel in 0..1, moved along by the
// frame key only under TAA.
fn gx_sun_noise() -> f32 {
    var p = gx_sun_context.pixel;
    if GX_SHADOW_TEMPORAL {
        p += 5.588238 * f32(gx_sun_context.frame_key % 64u);
    }
    return fract(52.982919 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// Tap `i` of a `count`-tap Vogel disk of radius 1, turned by `rotation` radians.
fn gx_sun_vogel(i: u32, count: u32, rotation: f32) -> vec2<f32> {
    let r = sqrt((f32(i) + 0.5) / f32(count));
    let a = f32(i) * GX_GOLDEN_ANGLE + rotation;
    return vec2<f32>(cos(a), sin(a)) * r;
}

// `(2 radius + 1)²` comparison taps around `uv` in `cascade`, averaged.
fn gx_sun_pcf(uv: vec2<f32>, cascade: u32, reference: f32, texel: f32, radius: i32) -> f32 {
    var lit = 0.0;
    for (var y = -radius; y <= radius; y++) {
        for (var x = -radius; x <= radius; x++) {
            let at = uv + vec2<f32>(f32(x), f32(y)) * texel;
            lit += textureSampleCompareLevel(shadow_map, shadow_sampler, at, i32(cascade), reference);
        }
    }
    let side = f32(2 * radius + 1);
    return lit / (side * side);
}

// The weight of texel `k` (0..5) of the six texels a bilinear 5x5 kernel touches along one axis,
// `f` the sample's fraction past texel 2's centre: 1 - f, 1, 1, 1, 1, f.
fn gx_sun_pcf5_weight(k: u32, f: f32) -> f32 {
    if k == 0u {
        return 1.0 - f;
    }
    if k == 5u {
        return f;
    }
    return 1.0;
}

// 5x5 bilinear PCF as nine 2x2 `textureGatherCompare` footprints: the 6x6 texels the 25 bilinear
// taps would touch, each weighted by how much of it the taps cover.
fn gx_sun_pcf5(uv: vec2<f32>, cascade: u32, reference: f32) -> f32 {
    let size = vec2<f32>(textureDimensions(shadow_map));
    let at = uv * size - 0.5;
    let base = floor(at);
    let f = at - base;
    var lit = 0.0;
    for (var by = 0u; by < 3u; by++) {
        for (var bx = 0u; bx < 3u; bx++) {
            // The footprint's top-left texel is base - 2 + 2b; gathering at its far corner
            // (texel coordinate base - 1 + 2b) fetches exactly its 2x2 block.
            let corner = base + vec2<f32>(f32(2u * bx) - 1.0, f32(2u * by) - 1.0);
            let g = textureGatherCompare(shadow_map, shadow_sampler, corner / size, i32(cascade), reference);
            let x0 = gx_sun_pcf5_weight(2u * bx, f.x);
            let x1 = gx_sun_pcf5_weight(2u * bx + 1u, f.x);
            let y0 = gx_sun_pcf5_weight(2u * by, f.y);
            let y1 = gx_sun_pcf5_weight(2u * by + 1u, f.y);
            // Gather order: w top-left, z top-right, x bottom-left, y bottom-right.
            lit += g.w * x0 * y0 + g.z * x1 * y0 + g.x * x0 * y1 + g.y * x1 * y1;
        }
    }
    return lit / 25.0;
}

// The receiver's plane in a cascade's map: the change of light-space depth (ndc) per unit of uv
// (`slope`), held to GX_SHADOW_MAX_RECEIVER_SLOPE, and the rest of a steeper receiver's slope
// (`excess`, ndc per uv of a tap's distance).
struct GxSunPlane {
    slope: vec2<f32>,
    excess: f32,
}

// The plane in cascade `m`'s map of a surface with unit normal `n` (`ndc_per_uv` converts a world
// slope to ndc depth per uv).
fn gx_sun_receiver_plane(m: mat4x4<f32>, n: vec3<f32>, ndc_per_uv: f32) -> GxSunPlane {
    let helper = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(n.x) > 0.9);
    let t1 = normalize(cross(n, helper));
    let t2 = cross(n, t1);
    let a = (m * vec4<f32>(t1, 0.0)).xyz;
    let b = (m * vec4<f32>(t2, 0.0)).xyz;
    let au = vec2<f32>(0.5 * a.x, -0.5 * a.y);
    let bu = vec2<f32>(0.5 * b.x, -0.5 * b.y);
    let det = au.x * bu.y - au.y * bu.x;
    let largest = GX_SHADOW_MAX_RECEIVER_SLOPE * ndc_per_uv;
    if abs(det) < 1e-12 {
        return GxSunPlane(vec2<f32>(0.0), largest);
    }
    let g = vec2<f32>(a.z * bu.y - au.y * b.z, au.x * b.z - a.z * bu.x) / det;
    let length_g = length(g);
    if length_g > largest {
        return GxSunPlane(g * (largest / length_g), length_g - largest);
    }
    return GxSunPlane(g, 0.0);
}

// The comparison reference of a tap `d` uv from the receiver whose own is `reference`: the
// receiver's plane there, plus the slope the plane does not follow over the tap's distance.
fn gx_sun_plane_reference(reference: f32, plane: GxSunPlane, d: vec2<f32>) -> f32 {
    return reference + dot(plane.slope, d) + plane.excess * length(d);
}

// Where `world_pos` (normal `n`) reads `cascade`'s map: its uv, its light depth (ndc) and that
// depth biased (the comparison's reference, the depth held to the map: past the far plane it
// compares against the deepest depth the map holds), and whether the map holds it (inside the
// map's square, before its far plane).
struct GxSunLookup {
    uv: vec2<f32>,
    depth: f32,
    reference: f32,
    inside: bool,
}

// The world-space normal offset of a lookup `offset` world units off a surface with unit normal
// `n`. Where the quality draws soft edges it follows the light, as Godot's does
// (`scene_forward_clustered.glsl` 4.7.2, MIT): scaled by 1 - N.L, so a surface facing the sun takes
// none and a grazing one takes it whole, and with its part along the light removed, so it moves the
// lookup across the map and never along the light's depth (P2-0.3, B5a). The features-off and
// legacy frames offset along the normal.
fn gx_sun_normal_offset(n: vec3<f32>, offset: f32) -> vec3<f32> {
    if !GX_SUN_SOFT_EDGES {
        return n * offset;
    }
    let l = frame.sun_dir.xyz;
    let along = n * (offset * (1.0 - max(dot(n, l), 0.0)));
    return along - l * dot(l, along);
}

// The lookup of `world_pos` (normal `n`) in `cascade`'s map, `offset` world units off the surface.
fn gx_sun_lookup(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32) -> GxSunLookup {
    let clip = frame.cascade_view_proj[cascade] * vec4<f32>(world_pos + gx_sun_normal_offset(n, offset), 1.0);
    let ndc = clip.xyz / clip.w;
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let inside = abs(ndc.x) <= 1.0 && abs(ndc.y) <= 1.0 && ndc.z <= 1.0;
    return GxSunLookup(uv, ndc.z, clamp(ndc.z, 0.0, 1.0) - gx_sun_cascade_bias(cascade), inside);
}

// `cascade`'s scale from rows 0 and 2 of its orthographic light matrix: x uv per world unit (half
// the x scale), y ndc depth per world unit along the light.
fn gx_sun_scale(cascade: u32) -> vec2<f32> {
    let m = frame.cascade_view_proj[cascade];
    return vec2<f32>(0.5 * length(vec3<f32>(m[0].x, m[1].x, m[2].x)), length(vec3<f32>(m[0].z, m[1].z, m[2].z)));
}

// The first cascade from `cascade` whose GX_PCSS_MAX_TEXELS texels span `radius` world units and
// whose map holds `world_pos` (looked up `offset` off the surface); `cascade` itself when no
// coarser one does.
fn gx_sun_pcss_cascade(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32, radius: f32) -> u32 {
    let count = gx_sun_cascades();
    let texels = f32(textureDimensions(shadow_map).x);
    var c = cascade;
    for (var next = cascade + 1u; next < count; next++) {
        if radius * gx_sun_scale(c).x * texels <= GX_PCSS_MAX_TEXELS || !gx_sun_lookup(world_pos, n, next, offset).inside {
            break;
        }
        c = next;
    }
    return c;
}

// How far along the light, world units, the receiver at light depth `reference` (ndc) of a
// cascade of `scale` lies past the cascade's slice sphere's sun-side point: the farthest a blocker
// inside the slice can be. The map's light depth starts towards the sun from that point by what it
// spans past its own width (the legacy fit's `CASTER_REACH`; a tight fit starts at the sphere or,
// receiver-tight, past it).
fn gx_sun_front_distance(reference: f32, scale: vec2<f32>) -> f32 {
    let front = max(1.0 / scale.y - 1.0 / scale.x, 0.0);
    return max(max(reference, 0.0) / scale.y - front, 0.0);
}

// A kernel of `radius` world units in `cascade`'s uv: at least one texel, at most GX_PCSS_MAX_TEXELS.
fn gx_sun_kernel_uv(radius: f32, cascade: u32) -> f32 {
    let texel = 1.0 / f32(textureDimensions(shadow_map).x);
    return clamp(radius * gx_sun_scale(cascade).x, texel, GX_PCSS_MAX_TEXELS * texel);
}

// One blocker tap `d` uv from the receiver `at` (whose plane is `plane`) in `cascade`'s map: the
// four texels a bilinear read there touches, each a blocker where it is nearer the sun than the
// receiver's plane at that texel, weighed bilinearly. x: the weighed blocker depth; y: the weight.
fn gx_sun_blocker_tap(at: GxSunLookup, plane: GxSunPlane, cascade: u32, d: vec2<f32>) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(shadow_map));
    let p = (at.uv + d) * size - 0.5;
    let base = floor(p);
    let f = p - base;
    // The 2x2 footprint whose upper-left texel is `base` (the sampler clamps to the map's edge).
    // A gather returns (base + (0, 1), base + (1, 1), base + (1, 0), base): corner k = (k & 1, k >> 1)
    // is component w, z, x, y, summed in k's order.
    let stored = textureGather(shadow_map, point_sampler, (base + 1.0) / size, i32(cascade)).wzxy;
    var sum = vec2<f32>(0.0);
    for (var k = 0u; k < 4u; k++) {
        let corner = vec2<f32>(f32(k & 1u), f32(k >> 1u));
        let texel = base + corner;
        let weight = mix(1.0 - f.x, f.x, corner.x) * mix(1.0 - f.y, f.y, corner.y);
        if stored[k] < gx_sun_plane_reference(at.reference, plane, (texel + 0.5) / size - at.uv) {
            sum += vec2<f32>(weight * stored[k], weight);
        }
    }
    return sum;
}

// What PCSS's blocker search finds for `world_pos` (looked up `offset` off the surface) in
// `cascade`'s map: `search` taps of a fixed Vogel disk over `reach` world units plus the receiver's
// own texel. x: the receiver's distance to its average blocker, world units; y: the blocker weight
// found (0: none); z: the receiver's own bilinear tap's visibility (a one-texel edge).
fn gx_sun_blockers(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32, reach: f32, search: u32) -> vec3<f32> {
    let at = gx_sun_lookup(world_pos, n, cascade, offset);
    let scale = gx_sun_scale(cascade);
    let plane = gx_sun_receiver_plane(frame.cascade_view_proj[cascade], n, scale.y / scale.x);
    let radius = gx_sun_kernel_uv(reach, cascade);
    let own = gx_sun_blocker_tap(at, plane, cascade, vec2<f32>(0.0));
    var found = own;
    for (var i = 0u; i < search; i++) {
        found += gx_sun_blocker_tap(at, plane, cascade, gx_sun_vogel(i, search, 0.0) * radius);
    }
    let distance = select(0.0, max(at.reference - found.x / max(found.y, 1e-6), 0.0) / scale.y, found.y > 0.0);
    return vec3<f32>(distance, found.y, 1.0 - own.y);
}

// `taps` comparison taps over `penumbra` world units around `world_pos` (looked up `offset` off
// the surface) in `cascade`'s map, turned by the pixel's noise.
fn gx_sun_pcss_filter(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32, penumbra: f32, taps: u32) -> f32 {
    let at = gx_sun_lookup(world_pos, n, cascade, offset);
    let scale = gx_sun_scale(cascade);
    let plane = gx_sun_receiver_plane(frame.cascade_view_proj[cascade], n, scale.y / scale.x);
    let radius = gx_sun_kernel_uv(penumbra, cascade);
    let rotation = gx_sun_noise() * GX_TAU;
    var lit = 0.0;
    for (var i = 0u; i < taps; i++) {
        let d = gx_sun_vogel(i, taps, rotation) * radius;
        lit += textureSampleCompareLevel(shadow_map, shadow_sampler, at.uv + d, i32(cascade), gx_sun_plane_reference(at.reference, plane, d));
    }
    return lit / f32(taps);
}

// PCSS for `world_pos` (normal `n`, looked up `offset` off the surface) in the receiver's
// `cascade`: `search` blocker taps over the penumbra a blocker at the slice sphere's sun-side point
// would cast, then `taps` comparison taps over the world-unit penumbra of the blockers found, each
// capped at GX_PCSS_MAX_WORLD and read in the cascade `gx_sun_pcss_cascade` picks for its radius.
// Less than GX_PCSS_FOUND_WHOLE of blocker eases into the receiver's own one-texel tap.
fn gx_sun_pcss(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32, search: u32, taps: u32) -> f32 {
    let spread = tan(frame.sun_dir.w);
    let receiver = gx_sun_lookup(world_pos, n, cascade, offset);
    let reach = min(gx_sun_front_distance(receiver.reference, gx_sun_scale(cascade)) * spread, GX_PCSS_MAX_WORLD);
    let searched = gx_sun_pcss_cascade(world_pos, n, cascade, offset, reach);
    let blockers = gx_sun_blockers(world_pos, n, searched, offset, reach, search);
    if blockers.y <= 0.0 {
        return blockers.z;
    }
    let penumbra = min(blockers.x * spread, GX_PCSS_MAX_WORLD);
    let filtered = gx_sun_pcss_cascade(world_pos, n, cascade, offset, penumbra);
    let lit = gx_sun_pcss_filter(world_pos, n, filtered, offset, penumbra, taps);
    return mix(blockers.z, lit, clamp(blockers.y / GX_PCSS_FOUND_WHOLE, 0.0, 1.0));
}

// The sun's visibility at `world_pos` with geometric normal `n` through `cascade`'s map, looked up
// `offset` world units off the surface, filtered by GX_SHADOW_FILTER.
fn gx_sun_cascade_shadow(world_pos: vec3<f32>, n: vec3<f32>, cascade: u32, offset: f32) -> f32 {
    let at = gx_sun_lookup(world_pos, n, cascade, offset);
    let uv = at.uv;
    let reference = at.reference;
    let texel = frame.shadow_params.w;
    if GX_SHADOW_FILTER == GX_SHADOW_HARDWARE {
        return textureSampleCompareLevel(shadow_map, shadow_sampler, uv, i32(cascade), reference);
    }
    if GX_SHADOW_FILTER == GX_SHADOW_PCF5 {
        return gx_sun_pcf5(uv, cascade, reference);
    }
    if GX_SHADOW_FILTER == GX_SHADOW_PCSS_LITE {
        return gx_sun_pcss(world_pos, n, cascade, offset, GX_PCSS_LITE_SEARCH, GX_PCSS_LITE_TAPS);
    }
    if GX_SHADOW_FILTER != GX_SHADOW_PCF3 {
        return gx_sun_pcss(world_pos, n, cascade, offset, GX_PCSS_SEARCH, GX_PCSS_TAPS);
    }
    // 3x3 PCF, spelled as the legacy renderer spelled it (the goldens' bits).
    var lit = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let at = uv + vec2<f32>(f32(x), f32(y)) * texel;
            lit += textureSampleCompareLevel(shadow_map, shadow_sampler, at, i32(cascade), reference);
        }
    }
    return lit / 9.0;
}

// Where `cascade`'s depth range starts (0 for the first).
fn gx_sun_start(cascade: u32) -> f32 {
    if cascade == 0u {
        return 0.0;
    }
    return frame.cascade_ends[cascade - 1u];
}

// How far into the band where `cascade` (of `count` drawn) fades into the next one view depth
// `depth` lies: 0 before the band (or with no band or no next cascade), towards 1 at the
// cascade's end.
fn gx_sun_band(depth: f32, cascade: u32, count: u32) -> f32 {
    if !GX_SUN_SOFT_EDGES {
        return 0.0;
    }
    let band = gx_sun_context.blend_band;
    if band <= 0.0 || cascade + 1u >= count {
        return 0.0;
    }
    let start = gx_sun_start(cascade);
    let end = frame.cascade_ends[cascade];
    let fade_from = end - band * (end - start);
    if depth <= fade_from {
        return 0.0;
    }
    return clamp((depth - fade_from) / max(end - fade_from, 1e-6), 0.0, 1.0);
}

// How far into the last cascade's end fade view depth `depth` lies: 0 before it (or without a
// fade, or in another cascade than the last of `count`), towards 1 at the shadow distance.
fn gx_sun_end(depth: f32, cascade: u32, count: u32) -> f32 {
    if !GX_SUN_SOFT_EDGES {
        return 0.0;
    }
    if gx_sun_end_fade <= 0.0 || cascade + 1u != count {
        return 0.0;
    }
    let start = gx_sun_start(cascade);
    let end = frame.cascade_ends[cascade];
    let fade_from = end - gx_sun_end_fade * (end - start);
    return clamp((depth - fade_from) / max(end - fade_from, 1e-6), 0.0, 1.0);
}

// The sun's visibility at `world_pos`: the configured filter in the cascade its view depth falls
// in (faded into the next one across the blend band, and out to 1 across the last cascade's end
// fade), 1 beyond the last cascade or without shadows. The drawn count and the cascade are found
// once per fragment.
fn sun_shadow(world_pos: vec3<f32>, n: vec3<f32>) -> f32 {
    if frame.cascade_splits.w < 0.5 {
        return 1.0;
    }
    let depth = dot(world_pos - frame.camera_pos.xyz, frame.camera_forward.xyz);
    let count = gx_sun_cascades();
    let cascade = gx_sun_cascade_of(depth, count);
    if cascade >= GX_MAX_CASCADES {
        return 1.0;
    }
    let end = gx_sun_end(depth, cascade, count);
    if end > 0.0 {
        return mix(gx_sun_banded(world_pos, n, depth, cascade, count), 1.0, end);
    }
    return gx_sun_banded(world_pos, n, depth, cascade, count);
}

// The visibility in `cascade` (of `count`) at view depth `depth`, faded into the next cascade
// across the band: both cascades' lookups lerped, from one normal offset eased from this cascade's
// to the next one's, so both put an edge in the same place and neither end of the band steps.
fn gx_sun_banded(world_pos: vec3<f32>, n: vec3<f32>, depth: f32, cascade: u32, count: u32) -> f32 {
    let fade = gx_sun_band(depth, cascade, count);
    if fade <= 0.0 {
        return gx_sun_cascade_shadow(world_pos, n, cascade, frame.cascade_offsets[cascade]);
    }
    let offset = mix(frame.cascade_offsets[cascade], frame.cascade_offsets[cascade + 1u], fade);
    let near = gx_sun_cascade_shadow(world_pos, n, cascade, offset);
    return mix(near, gx_sun_cascade_shadow(world_pos, n, cascade + 1u, offset), fade);
}

// The sun's visibility on the surface `s` through the cascaded maps: the screen mask's where the
// frame made one for this opaque surface (renderer pass 2, B.7, SH-04: the same chunk evaluated
// after the prepass, accumulated over frames and filtered edge-aware by its own denoise, so a
// soft edge holds still under motion instead of leaving the turning taps' noise to the colour TAA;
// `gx_sun_screen_shadow`, -1 where there is none), else `sun_shadow` inline. A blended surface
// always shades inline: the mask holds the opaque surface behind it.
fn gx_sun_visibility(s: Surface) -> f32 {
    if GX_SHADOW_TEMPORAL && s.alpha >= 1.0 {
        let screen = gx_sun_screen_shadow(s.world_pos);
        if screen >= 0.0 {
            return screen;
        }
    }
    return sun_shadow(s.world_pos, s.geometric);
}

// The sun's shadowed light on `s` from the unit direction `sun` (toward the sun), which the
// caller normalizes once per fragment and adds the result itself. The cascaded maps' visibility
// (`gx_sun_visibility`) is multiplied by the screen-space contact shadow (`gx_contact_shadow`,
// shaders/effects.wgsl): the small-scale occlusion the maps miss, 1 where the frame draws no
// contact shadows. A blended surface takes no contact shadow: the mask holds the opaque surface
// behind it, as the AO map does (pass-1 gate: a lake's water sheet wore the stippled contact
// shadow of the shallow bed under it).
fn gx_sun(s: Surface, sun: vec3<f32>) -> vec3<f32> {
    let contact = select(gx_contact_shadow(s.world_pos), 1.0, s.alpha < 1.0);
    let visibility = gx_sun_visibility(s) * contact;
    return shade(s.n, s.v, sun, frame.sun_color.rgb, s.albedo, s.metallic, s.roughness) * visibility;
}
