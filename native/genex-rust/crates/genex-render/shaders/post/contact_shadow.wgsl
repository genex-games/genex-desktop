// Screen-space contact shadows for the sun (graph node 10a; RQ4.7, P2-0.7): a short ray march
// towards the sun through the prepass depth, `length` world units long, into an `r8unorm` mask
// (1 unshadowed) at half the render size; the sun chunk multiplies its shadow by it
// (`gx_contact_shadow`, shaders/lighting/sun.wgsl). On at high and ultra.
//
// Each mask texel reconstructs the world position of the depth texel under it, projects the ray's
// two ends onto the screen and steps between them in screen space, one sample per depth texel the
// ray spans (at least `GX_CONTACT_MIN_STEPS`, at most `steps`), so a far receiver's short ray takes
// few samples and a near one's are evenly spread on the screen (Stachowiak's raymarch, Bevy 0.20
// `ssr/raymarch.wesl`). Depth and the ray's distance along it are interpolated perspective-correctly.
// A sample is occluded when the depth there lies in front of it by more than the receiver's own
// slope tolerance and by less than a thickness: the fixed minimum, a share of the view distance
// (Bend Studio's depth-relative thickness) or the ray's own change in view distance since the last
// sample (Filament's per-step tolerance), whichever is largest, so distant hits do not toggle as one
// depth texel grows past the minimum. A hit is soft: fully occluding within that thickness and
// fading out across as much again behind it (Bevy's `(penetration - 0.5) / 0.5`). The ray
// takes the strongest occlusion of all its samples; hits in the first half of the ray shadow fully,
// later ones fade out towards its end so the shadow's tip is soft. A receiver so far away that the
// ray is only a few depth texels long there takes none: contact shadows fade out with distance.
//
// The screen has no depth beyond its edges, so a sample's occlusion fades out across the outer
// twelfth of the screen (Filament's `12 |uv - 0.5| - 5`) and a ray that leaves the screen is cut
// at its edge, its steps spent on the part on the screen: as the camera pans, a contact shadow
// whose caster leaves the screen fades out instead of switching off. Sky texels are unshadowed, and a ray heading for the camera is cut short of it.
// Distances come from `gx_view_distance`, so perspective and orthographic cameras, standard and
// reversed depth, finite and infinite far planes all march alike.
//
// The march starts `start bias` of a step out (no self-shadowing on the receiver). Only under TAA
// (counts.w) does it add interleaved gradient noise of the pixel and frame index to that start, so
// the history averages the steps' banding; without TAA the pattern is fixed and a frame is the
// same bits every time.

// Mirrors `post::contact_shadow::GpuContactShadowParams`.
struct ContactShadowParams {
    // xy: the mask's size in pixels; zw: 1 / it.
    size: vec4<f32>,
    // xyz: the unit direction towards the sun (world space); w: the ray length in world units.
    light: vec4<f32>,
    // x: the least depth thickness a hit counts within (world units); y: the start bias (steps);
    // z: the thickness per unit of view distance; w: reserved.
    params: vec4<f32>,
    // x: the most steps; y: the frame index (noise only under TAA); z: 1 under reverse-Z; w: 1
    // under TAA.
    counts: vec4<u32>,
}

@group(0) @binding(0) var gx_depth: texture_depth_2d;
@group(0) @binding(1) var<uniform> gx_contact: ContactShadowParams;
@group(0) @binding(2) var<uniform> gx_frame: GxFrameV2;

// The share of the ray, from its start, whose hits shadow fully; beyond it they fade to none.
const GX_CONTACT_FULL_SHARE: f32 = 0.5;
// How far (depth texels) a sample must have left the receiver on screen before it can occlude.
const GX_CONTACT_MIN_TEXELS: f32 = 1.5;
// The frame-index period of the noise under TAA (keeps the float offset exact).
const GX_CONTACT_NOISE_PERIOD: u32 = 64u;
// The fewest samples a ray takes, however few depth texels it spans.
const GX_CONTACT_MIN_STEPS: u32 = 4u;
// Depth texels between samples along the ray on the screen.
const GX_CONTACT_TEXELS_PER_STEP: f32 = 1.0;
// A ray heading for the camera ends where its clip w falls to this share of its start's (short of
// the eye, where its projection would blow up).
const GX_CONTACT_W_FLOOR: f32 = 0.1;
// How many depth texels long the ray must be at the receiver's distance (seen across) before its
// occlusion starts to count, and from how many it counts fully: a ray shorter than a few texels
// resolves nothing (distant foliage would only shade itself with depth noise), so contact shadows
// fade out with distance, further at higher resolutions.
const GX_CONTACT_RESOLVE_MIN: f32 = 8.0;
const GX_CONTACT_RESOLVE_FULL: f32 = 16.0;
// The share of a hit's depth window behind the surface that occludes fully; behind it a hit fades
// out (the window is twice the thickness: full within the thickness, fading across as much again).
const GX_CONTACT_SOFT_HIT: f32 = 0.5;

struct ContactOut {
    @builtin(position) clip: vec4<f32>,
}

@vertex
fn vs_contact_shadow(@builtin(vertex_index) index: u32) -> ContactOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return ContactOut(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0));
}

// Whether a depth-buffer value is the cleared far plane (nothing drawn).
fn gx_contact_is_sky(depth: f32) -> bool {
    if gx_contact.counts.z == 1u {
        return depth <= 0.0;
    }
    return depth >= 1.0;
}

// The depth texel under screen uv `uv` (0..1, top row first).
fn gx_contact_depth_at(uv: vec2<f32>) -> f32 {
    let size = vec2<i32>(textureDimensions(gx_depth));
    let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
    return textureLoad(gx_depth, pixel, 0);
}

// Interleaved gradient noise in 0..1 (Jimenez 2014).
fn gx_contact_noise(pixel: vec2<f32>, frame: u32) -> f32 {
    let p = pixel + 5.588238 * f32(frame % GX_CONTACT_NOISE_PERIOD);
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// The ray's start offset in steps: the start bias, plus noise across the rest of a step under TAA.
fn gx_contact_start(pixel: vec2<f32>) -> f32 {
    let bias = gx_contact.params.y;
    if gx_contact.counts.w == 0u {
        return bias;
    }
    return bias + gx_contact_noise(pixel, gx_contact.counts.y) * (1.0 - bias);
}

// How much of a hit at share `t` of the ray's length occludes: all of it in the ray's first half,
// fading to none at its end (the shadow's soft tip).
fn gx_contact_tip(t: f32) -> f32 {
    return 1.0 - smoothstep(GX_CONTACT_FULL_SHARE, 1.0, t);
}

// How much of a sample's occlusion survives at screen uv `uv`: all of it inside, fading out to none
// at the screen's edge across its outer twelfth, where the depth buffer runs out (Filament v1.77.3
// `surface_shadowing.fs` `screenSpaceContactShadow`, Apache-2.0).
fn gx_contact_edge_fade(uv: vec2<f32>) -> f32 {
    let fade = max(12.0 * abs(uv - vec2<f32>(0.5)) - vec2<f32>(5.0), vec2<f32>(0.0));
    return saturate(1.0 - dot(fade, fade));
}

// The occlusion of a sample `ahead` behind the drawn surface (view distance) past the receiver's
// slope `tolerance`: full within `thickness`, fading out across as much again behind it, none
// beyond (Bevy 0.20 `pbr_functions.wesl` `calculate_contact_shadow`, MIT OR Apache-2.0, over a
// window of twice the thickness).
fn gx_contact_soft_hit(ahead: f32, tolerance: f32, thickness: f32) -> f32 {
    let penetration = (ahead - tolerance) / (thickness / GX_CONTACT_SOFT_HIT);
    if penetration <= 0.0 || penetration >= 1.0 {
        return 0.0;
    }
    return 1.0 - saturate((penetration - GX_CONTACT_SOFT_HIT) / (1.0 - GX_CONTACT_SOFT_HIT));
}

// The ray from world point `origin` along `ray` in clip space, its end cut short of the camera
// when it heads for it: (start, end, the share of `ray` the end lies at).
struct ContactRay {
    start: vec4<f32>,
    end: vec4<f32>,
    reach: f32,
}

fn gx_contact_ray(origin: vec3<f32>, ray: vec3<f32>) -> ContactRay {
    let start = gx_frame.view_proj * vec4<f32>(origin, 1.0);
    let end = gx_frame.view_proj * vec4<f32>(origin + ray, 1.0);
    let floor_w = GX_CONTACT_W_FLOOR * start.w;
    if end.w >= floor_w {
        return ContactRay(start, end, 1.0);
    }
    let reach = (start.w - floor_w) / (start.w - end.w);
    return ContactRay(start, mix(start, end, reach), reach);
}

// The world size of one of the depth's `height` rows at view distance `here`: the receiver's texel
// footprint (perspective: it grows with the distance; orthographic: fixed).
fn gx_contact_texel_footprint(here: f32, height: f32) -> f32 {
    let across = 2.0 / (gx_frame.proj[1][1] * height);
    return select(here * across, across, gx_frame.proj[3][3] == 1.0);
}

// The screen uv of clip-space ndc `ndc` (top row first).
fn gx_contact_uv(ndc: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// The share of the screen segment from `start` (on the screen) along `delta` (uv) that stays on the
// screen, at most all of it.
fn gx_contact_on_screen(start: vec2<f32>, delta: vec2<f32>) -> f32 {
    let bound = select(vec2<f32>(0.0), vec2<f32>(1.0), delta > vec2<f32>(0.0));
    let exits = select(vec2<f32>(1.0), (bound - start) / delta, delta != vec2<f32>(0.0));
    return clamp(min(exits.x, exits.y), 0.0, 1.0);
}

// The centre of the depth texel under screen uv `uv`: a half-resolution mask texel's centre falls
// on a corner of four depth texels, and a receiver rebuilt there from one of their depths would sit
// half a texel off its surface (a slanted face would then shadow itself).
fn gx_contact_texel_centre(uv: vec2<f32>) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(gx_depth));
    return (clamp(floor(uv * size), vec2<f32>(0.0), size - vec2<f32>(1.0)) + vec2<f32>(0.5)) / size;
}

// Whether screen uv `uv` lies on the screen.
fn gx_contact_on_screen_uv(uv: vec2<f32>) -> bool {
    return all(uv >= vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
}

// The receiver's change in view distance per depth texel along `step` (one texel across or
// down): of the two neighbours on that axis that are on the screen and not sky, the smaller
// difference, so a texel on a silhouette takes its own surface's slope rather than the step to the
// background (or none when the one neighbour read was sky, which left a silhouette with no
// tolerance at all). A neighbour beyond the screen's edge is not read (GA): the clamped read was
// the texel itself, a slope of zero, and a slanted surface shadowed itself along the border.
fn gx_contact_axis_slope(uv: vec2<f32>, here: f32, step: vec2<f32>) -> f32 {
    let before = gx_contact_depth_at(uv - step);
    let after = gx_contact_depth_at(uv + step);
    let none = 3.4e38;
    let a_read = gx_contact_on_screen_uv(uv - step) && !gx_contact_is_sky(before);
    let b_read = gx_contact_on_screen_uv(uv + step) && !gx_contact_is_sky(after);
    let a = select(none, abs(gx_view_distance(gx_frame.proj, before) - here), a_read);
    let b = select(none, abs(gx_view_distance(gx_frame.proj, after) - here), b_read);
    let slope = min(a, b);
    return select(slope, 0.0, slope >= none);
}

@fragment
fn fs_contact_shadow(in: ContactOut) -> @location(0) vec4<f32> {
    let uv = gx_contact_texel_centre(in.clip.xy * gx_contact.size.zw);
    let depth = gx_contact_depth_at(uv);
    // A ray of no length (the look's `contact_shadow_length` 0) shadows nothing.
    if gx_contact_is_sky(depth) || gx_contact.counts.x == 0u || gx_contact.light.w <= 0.0 {
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
    }
    // A sample is compared with the depth at the centre of the texel it lands in, up to half a
    // texel away from it: on a surface seen at a slant that depth moves by up to half the receiver's
    // per-texel change in view distance, so a hit must lie behind the surface by more than that
    // (a slanted face or grazing ground never shadows itself).
    let texels = vec2<f32>(textureDimensions(gx_depth));
    let texel = 1.0 / texels;
    let here = gx_view_distance(gx_frame.proj, depth);
    let resolve = gx_contact.light.w / gx_contact_texel_footprint(here, texels.y);
    let resolved = saturate((resolve - GX_CONTACT_RESOLVE_MIN) / (GX_CONTACT_RESOLVE_FULL - GX_CONTACT_RESOLVE_MIN));
    if resolved <= 0.0 {
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
    }
    let slope = max(gx_contact_axis_slope(uv, here, vec2<f32>(texel.x, 0.0)), gx_contact_axis_slope(uv, here, vec2<f32>(0.0, texel.y)));
    let tolerance = 0.5 * slope;
    let receiver = gx_frame.inv_view_proj * vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    let ray = gx_contact_ray(receiver.xyz / receiver.w, gx_contact.light.xyz * gx_contact.light.w);
    // Perspective-correct interpolation in screen space: ndc and 1 / w are linear along it.
    let ndc0 = ray.start.xyz / ray.start.w;
    let ndc1 = ray.end.xyz / ray.end.w;
    let q0 = 1.0 / ray.start.w;
    let q1 = 1.0 / ray.end.w;
    // The march spends its steps on the part of the ray on the screen (Bevy clips the ray to the
    // view frustum): a caster leaving the screen is sampled ever more finely as it goes, so a
    // sliver of it at the edge is not missed between two steps.
    let uv0 = gx_contact_uv(ndc0.xy);
    let on_screen = gx_contact_on_screen(uv0, gx_contact_uv(ndc1.xy) - uv0);
    let span = length((gx_contact_uv(ndc1.xy) - uv0) * texels) * on_screen;
    let steps = clamp(u32(span / GX_CONTACT_TEXELS_PER_STEP), GX_CONTACT_MIN_STEPS, max(gx_contact.counts.x, GX_CONTACT_MIN_STEPS));
    let start = gx_contact_start(in.clip.xy);
    // A sample still within the receiver's own texel neighbourhood reads the receiver's surface (a
    // twig's or a kerb's own front face, nearer than a point just above its top), so only samples
    // that have left it can occlude: from this many steps on (the samples leave the receiver at
    // `span / steps` texels a step).
    let first = GX_CONTACT_MIN_TEXELS * f32(steps) / max(span, 1e-6);
    var occlusion = 0.0;
    var previous = here;
    for (var i = 0u; i < steps; i++) {
        let s = on_screen * (f32(i) + start) / f32(steps);
        let sample_ndc = mix(ndc0, ndc1, s);
        let sample_uv = gx_contact_uv(sample_ndc.xy);
        // The rest of the ray lies off the screen too: it has no depth there.
        if any(sample_uv < vec2<f32>(0.0)) || any(sample_uv >= vec2<f32>(1.0)) {
            break;
        }
        let distance_here = gx_view_distance(gx_frame.proj, sample_ndc.z);
        let step_change = abs(distance_here - previous);
        previous = distance_here;
        if f32(i) + start < first {
            continue;
        }
        let scene = gx_contact_depth_at(sample_uv);
        // How far the drawn surface lies in front of the sample, in view distance.
        let ahead = distance_here - gx_view_distance(gx_frame.proj, scene);
        if gx_contact_is_sky(scene) || ahead <= tolerance {
            continue;
        }
        let thickness = max(max(gx_contact.params.x, gx_contact.params.z * distance_here), step_change);
        // The sample's share of the world ray (perspective-correct from its screen share).
        let t = ray.reach * s * q1 / mix(q0, q1, s);
        let hit = gx_contact_soft_hit(ahead, tolerance, thickness) * gx_contact_tip(t) * gx_contact_edge_fade(sample_uv);
        occlusion = max(occlusion, hit);
        if occlusion >= 1.0 {
            break;
        }
    }
    return vec4<f32>(1.0 - occlusion * resolved, 0.0, 0.0, 1.0);
}
