// The screen-space ray march (renderer pass 2 A.6, the SSR helper): a shared chunk any pass or
// material includes after common.wgsl (it reads `gx_view_distance`) to march a ray through a depth
// buffer and find where it first passes behind the drawn surface. Water (B.3), glass and the Hi-Z
// SSR's fallback (B.9) call it; it binds nothing itself: the caller hands it its depth texture.
//
// A port of Bevy 0.20.0 `crates/bevy_pbr/src/ssr/raymarch.wesl` (Copyright (c) 2023 Tomasz
// Stachowiak, dual-licensed MIT OR Apache-2.0, used under Apache-2.0), itself a port of h3r2tic's
// `raymarch.hlsl`: a linear march over the ray's screen span (its step count the pixels it crosses,
// at most `linear_steps`), then bisection and an optional secant step between the last miss and
// the first hit. Each sample compares the ray against both the bilinear and the nearest depth
// (manual `textureLoad` taps, Bevy's WebGPU path) and counts as behind the surface only below both,
// so the march neither shadows itself on depth steps nor leaks through the smooth surface's skirt.
// Changes from the source, each kept in the CPU twin (`screen_inputs::march`):
// - distances are view distances in world units from `gx_view_distance` of the caller's
//   projection, so perspective and orthographic cameras, standard and reversed depth, finite and
//   infinite far planes march alike (Bevy's `1 / ndc.z` holds for an infinite reverse-Z
//   perspective only); the thickness is in world units too;
// - the cleared far plane (sky) is a distance of `GX_SSR_FAR`, never a surface;
// - the march exponent is a whole number (1 or 2, multiplied out, not `pow`);
// - a ray component that does not move never limits the frustum clip (no 0 / 0).

// The view distance standing for the sky (cleared depth): no ray passes behind it.
const GX_SSR_FAR: f32 = 1e30;
// The relative bias on the surface's distance (Bevy's `bias`).
const GX_SSR_DEPTH_BIAS: f32 = 0.000002;
// The smallest clip w a ray end is divided by (Bevy's guard for rays heading at the eye).
const GX_SSR_W_FLOOR: f32 = 1e-10;
// The secant step is kept when it lands this much closer to the surface than the last miss.
const GX_SSR_SECANT_GAIN: f32 = 0.9;
// The fewest linear samples a ray takes.
const GX_SSR_MIN_STEPS: i32 = 2;

// A ray to march and how (the caller fills it with `gx_ssr_march_new` and one of the `to`
// functions, then sets the knobs it wants).
struct GxSsrMarch {
    // NDC (clip space divided by w) of the ray's ends, clipped to the view frustum.
    start: vec3<f32>,
    end: vec3<f32>,
    // The most linear samples (at least `GX_SSR_MIN_STEPS`; fewer when the ray crosses fewer
    // depth texels).
    linear_steps: u32,
    // 1: equidistant samples; 2: denser near the start (samples at (i / n)^2 of the ray).
    exponent: u32,
    // Bisection steps after the first hit (0 for a shadow ray, 4-6 for a colour lookup).
    bisection_steps: u32,
    // 1: one secant step after the bisection.
    secant: u32,
    // The first sample's offset in 0..1 of a step (1: none).
    jitter: f32,
    // 1: march past surfaces the ray goes deeper behind than `thickness` (shadow rays; leaks colour).
    behind_surfaces: u32,
    // 1: nearest depth taps only.
    sloppy: u32,
    // How thick every depth texel is assumed to be, in world units of view distance.
    thickness: f32,
    // The projection the depth was drawn with and its convention (1: reverse-Z).
    proj: mat4x4<f32>,
    reversed: u32,
}

// What a march found.
struct GxSsrHit {
    // 1 when the ray passed behind a surface within its thickness.
    hit: u32,
    // The hit's share of the ray (0..1), or on a miss the furthest share it travelled.
    t: f32,
    // The screen uv (0..1, top row first) at `t`.
    uv: vec2<f32>,
    // How far behind the surface the hit sample lies (world units), and that as a share of the
    // thickness. Undefined on a miss.
    penetration: f32,
    penetration_share: f32,
}

// One sample's signed distance to the surface (negative: behind it), whether it may count as a hit
// and how deep it lies behind the nearer of the two depth readings.
struct GxSsrSample {
    distance: f32,
    valid: bool,
    penetration: f32,
}

// A march from `start` (NDC) under `proj` with Bevy's defaults: 4 linear steps, no bisection, no
// secant, no jitter, a thickness of 1, and the end at the start until a `to` function sets it.
fn gx_ssr_march_new(start: vec3<f32>, proj: mat4x4<f32>, reversed: u32) -> GxSsrMarch {
    return GxSsrMarch(start, start, 4u, 1u, 0u, 0u, 1.0, 0u, 0u, 1.0, proj, reversed);
}

// The screen uv of NDC `ndc` (top row first).
fn gx_ssr_uv(ndc: vec2<f32>) -> vec2<f32> {
    return ndc * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
}

// `offset / delta` per axis, or `none` on an axis the ray does not move along.
fn gx_ssr_edge_reach(offset: vec3<f32>, delta: vec3<f32>, none: f32) -> vec3<f32> {
    return select(offset / delta, vec3<f32>(none), delta == vec3<f32>(0.0));
}

// The march `march` towards clip-space direction `dir` from its start, clipped to the frustum:
// to the frustum's edge when `infinite`, else at most to `start + dir`.
fn gx_ssr_march_clip(march: GxSsrMarch, dir: vec4<f32>, infinite: bool) -> GxSsrMarch {
    var out = march;
    var end = vec4<f32>(march.start, 1.0) + dir;
    // Perspective division without dividing by zero for rays heading straight at the eye.
    end = end / (select(-1.0, 1.0, end.w >= 0.0) * max(GX_SSR_W_FLOOR, abs(end.w)));
    // The start moved onto the frustum's x and y range.
    var delta = end.xyz - march.start;
    let near_edge = select(vec3<f32>(-1.0, -1.0, 0.0), vec3<f32>(1.0), delta < vec3<f32>(0.0));
    let to_near = gx_ssr_edge_reach(near_edge - march.start, delta, -GX_SSR_FAR);
    out.start = march.start + delta * max(0.0, max(to_near.x, to_near.y));
    // The end cut where the ray leaves the frustum.
    delta = end.xyz - out.start;
    let far_edge = select(vec3<f32>(-1.0, -1.0, 0.0), vec3<f32>(1.0), delta >= vec3<f32>(0.0));
    let to_far = gx_ssr_edge_reach(far_edge - out.start, delta, GX_SSR_FAR);
    let reach = min(min(to_far.x, to_far.y), to_far.z);
    out.end = out.start + delta * select(min(1.0, reach), reach, infinite);
    return out;
}

// The march to NDC position `end` (finite: it stops there or at the frustum's edge).
fn gx_ssr_march_to(march: GxSsrMarch, end: vec3<f32>) -> GxSsrMarch {
    return gx_ssr_march_clip(march, vec4<f32>(end - march.start, 0.0) * sign(end.z), false);
}

// The march along clip-space direction `dir` to the frustum's edge.
fn gx_ssr_march_toward(march: GxSsrMarch, dir: vec4<f32>) -> GxSsrMarch {
    return gx_ssr_march_clip(march, dir, true);
}

// A march from world point `origin` along world direction `direction` to the frustum's edge, seen
// through `view_proj` (drawn with `proj`, `reversed` its depth convention).
fn gx_ssr_march_world(view_proj: mat4x4<f32>, proj: mat4x4<f32>, reversed: u32, origin: vec3<f32>, direction: vec3<f32>) -> GxSsrMarch {
    let start = view_proj * vec4<f32>(origin, 1.0);
    let march = gx_ssr_march_new(start.xyz / start.w, proj, reversed);
    return gx_ssr_march_toward(march, view_proj * vec4<f32>(direction, 0.0));
}

// The depth texel at `texel`, clamped to the texture.
fn gx_ssr_depth_texel(depth: texture_depth_2d, texel: vec2<i32>) -> f32 {
    let last = vec2<i32>(textureDimensions(depth)) - vec2<i32>(1);
    return textureLoad(depth, clamp(texel, vec2<i32>(0), last), 0);
}

// The depth under screen uv `uv` (nearest texel).
fn gx_ssr_depth_nearest(depth: texture_depth_2d, uv: vec2<f32>, size: vec2<f32>) -> f32 {
    return gx_ssr_depth_texel(depth, vec2<i32>(floor(uv * size)));
}

// The depth at screen uv `uv`, bilinear between the four texels around it.
fn gx_ssr_depth_bilinear(depth: texture_depth_2d, uv: vec2<f32>, size: vec2<f32>) -> f32 {
    let coord = uv * size - vec2<f32>(0.5);
    let base = vec2<i32>(floor(coord));
    let f = coord - floor(coord);
    let d00 = gx_ssr_depth_texel(depth, base);
    let d10 = gx_ssr_depth_texel(depth, base + vec2<i32>(1, 0));
    let d01 = gx_ssr_depth_texel(depth, base + vec2<i32>(0, 1));
    let d11 = gx_ssr_depth_texel(depth, base + vec2<i32>(1, 1));
    return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}

// The view distance of depth-buffer value `value` under the march's projection; the cleared far
// plane is `GX_SSR_FAR`.
fn gx_ssr_distance(march: GxSsrMarch, value: f32) -> f32 {
    let sky = select(value >= 1.0, value <= 0.0, march.reversed == 1u);
    if sky {
        return GX_SSR_FAR;
    }
    return min(gx_view_distance(march.proj, value), GX_SSR_FAR);
}

// The march's sample at NDC point `point` (Bevy's `depth_raymarch_distance_fn_evaluate`).
fn gx_ssr_sample(depth: texture_depth_2d, march: GxSsrMarch, size: vec2<f32>, point: vec3<f32>) -> GxSsrSample {
    let uv = gx_ssr_uv(point.xy);
    let ray = gx_ssr_distance(march, point.z);
    let nearest = gx_ssr_distance(march, gx_ssr_depth_nearest(depth, uv, size));
    var far = nearest;
    var near = nearest;
    if march.sloppy == 0u {
        let smooth_surface = gx_ssr_distance(march, gx_ssr_depth_bilinear(depth, uv, size));
        far = max(smooth_surface, nearest);
        near = min(smooth_surface, nearest);
    }
    let penetration = ray - near;
    let valid = march.behind_surfaces == 0u || penetration < march.thickness;
    return GxSsrSample(far * (1.0 + GX_SSR_DEPTH_BIAS) - ray, valid, penetration);
}

// Whether sample `s` lies behind the surface and may count as a hit.
fn gx_ssr_behind(s: GxSsrSample) -> bool {
    return s.distance < 0.0 && s.valid;
}

// The share of the ray the linear march's sample `step` (with the jitter) lands at.
fn gx_ssr_step_t(march: GxSsrMarch, step: f32, steps: f32) -> f32 {
    let along = (step + march.jitter) / steps;
    var t = along;
    for (var power = 1u; power < march.exponent; power += 1u) {
        t = t * along;
    }
    return t;
}

// March `march` through `depth` (Bevy's `depth_ray_march_march` with its hybrid root finder).
fn gx_ssr_march_run(depth: texture_depth_2d, march: GxSsrMarch) -> GxSsrHit {
    let size = vec2<f32>(textureDimensions(depth));
    let start_uv = gx_ssr_uv(march.start.xy);
    let end_uv = gx_ssr_uv(march.end.xy);
    let span_px = length((end_uv - start_uv) * size);
    let steps = max(GX_SSR_MIN_STEPS, min(i32(march.linear_steps), i32(floor(span_px))));
    let dir = march.end - march.start;

    // The linear march: the first sample behind the surface ends it.
    var min_t = 0.0;
    var max_t = 1.0;
    var min_s = GxSsrSample(0.0, false, 0.0);
    var max_s = GxSsrSample(0.0, false, 0.0);
    var intersected = false;
    for (var step = 0; step < steps; step += 1) {
        let t = gx_ssr_step_t(march, f32(step), f32(steps));
        let s = gx_ssr_sample(depth, march, size, march.start + dir * t);
        if gx_ssr_behind(s) {
            max_t = t;
            max_s = s;
            intersected = true;
            break;
        }
        min_t = t;
        min_s = s;
    }
    let miss_t = min_t;
    var hit_t = min_t;
    var hit_s = max_s;

    // Bisection between the last sample in front and the first behind, then one secant step.
    if intersected {
        for (var step = 0u; step < march.bisection_steps; step += 1u) {
            let mid_t = (min_t + max_t) * 0.5;
            let s = gx_ssr_sample(depth, march, size, march.start + dir * mid_t);
            if gx_ssr_behind(s) {
                max_t = mid_t;
                max_s = s;
            } else {
                min_t = mid_t;
                min_s = s;
            }
        }
        hit_t = max_t;
        hit_s = max_s;
        if march.secant == 1u {
            let mid_t = mix(min_t, max_t, min_s.distance / (min_s.distance - max_s.distance));
            let s = gx_ssr_sample(depth, march, size, march.start + dir * mid_t);
            if abs(s.distance) < min_s.distance * GX_SSR_SECANT_GAIN && s.valid {
                hit_t = mid_t;
                hit_s = s;
            }
        }
    }

    if intersected && hit_s.penetration < march.thickness && hit_s.distance < march.thickness {
        return GxSsrHit(1u, hit_t, mix(start_uv, end_uv, hit_t), hit_s.penetration, hit_s.penetration / march.thickness);
    }
    return GxSsrHit(0u, miss_t, mix(start_uv, end_uv, miss_t), 0.0, 0.0);
}

// How much of a screen-space hit at `uv` to trust near the screen's edge: all of it inside, fading
// out across the outer twelfth (Filament's `12 |uv - 0.5| - 5`), where the depth runs out.
fn gx_ssr_edge_fade(uv: vec2<f32>) -> f32 {
    let fade = max(12.0 * abs(uv - vec2<f32>(0.5)) - vec2<f32>(5.0), vec2<f32>(0.0));
    return saturate(1.0 - dot(fade, fade));
}
