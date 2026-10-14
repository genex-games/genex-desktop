// Screen-space contact shadows for the sun (graph node 10a; RQ4.7): a short ray march towards the
// sun through the prepass depth, `steps` samples over `length` world units, into an `r8unorm` mask
// (1 unshadowed) at half the render size; the sun chunk multiplies its shadow by it
// (`gx_contact_shadow`, shaders/lighting/sun.wgsl). On at high and ultra.
//
// Each mask texel reconstructs the world position of the depth texel under it, steps along the
// unit direction towards the sun and projects every sample back onto the screen. A sample is
// occluded when the depth there lies in front of it by less than the thickness (world units, in
// view distance): something thin and near stands between the receiver and the sun, which the
// cascaded maps miss at that scale (their texels and bias are centimetres to metres). The first hit
// decides: hits in the first half of the ray shadow fully, later ones fade out towards its end so
// the shadow's tip is soft. Sky texels, rays that leave the screen or pass behind the camera are
// unshadowed. Distances come from `gx_view_distance`, so perspective and orthographic cameras,
// standard and reversed depth, finite and infinite far planes all march alike.
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
    // x: the depth thickness a hit must be within (world units); y: the start bias; zw: reserved.
    params: vec4<f32>,
    // x: steps; y: the frame index (noise only under TAA); z: 1 under reverse-Z; w: 1 under TAA.
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

// The visibility the first hit at share `t` of the ray leaves (0: fully shadowed).
fn gx_contact_hit_visibility(t: f32) -> f32 {
    return smoothstep(GX_CONTACT_FULL_SHARE, 1.0, t);
}

// The centre of the depth texel under screen uv `uv`: a half-resolution mask texel's centre falls
// on a corner of four depth texels, and a receiver rebuilt there from one of their depths would sit
// half a texel off its surface (a slanted face would then shadow itself).
fn gx_contact_texel_centre(uv: vec2<f32>) -> vec2<f32> {
    let size = vec2<f32>(textureDimensions(gx_depth));
    return (clamp(floor(uv * size), vec2<f32>(0.0), size - vec2<f32>(1.0)) + vec2<f32>(0.5)) / size;
}

// The receiver's change in view distance per depth texel along `step` (one texel across or
// down): of the two neighbours on that axis that are not sky, the smaller difference, so a texel
// on a silhouette takes its own surface's slope rather than the step to the background (or none
// when the one neighbour read was sky, which left a silhouette with no tolerance at all).
fn gx_contact_axis_slope(uv: vec2<f32>, here: f32, step: vec2<f32>) -> f32 {
    let before = gx_contact_depth_at(uv - step);
    let after = gx_contact_depth_at(uv + step);
    let none = 3.4e38;
    let a = select(abs(gx_view_distance(gx_frame.proj, before) - here), none, gx_contact_is_sky(before));
    let b = select(abs(gx_view_distance(gx_frame.proj, after) - here), none, gx_contact_is_sky(after));
    let slope = min(a, b);
    return select(slope, 0.0, slope >= none);
}

@fragment
fn fs_contact_shadow(in: ContactOut) -> @location(0) vec4<f32> {
    let uv = gx_contact_texel_centre(in.clip.xy * gx_contact.size.zw);
    let depth = gx_contact_depth_at(uv);
    let steps = gx_contact.counts.x;
    // A ray of no length (the look's `contact_shadow_length` 0) shadows nothing.
    if gx_contact_is_sky(depth) || steps == 0u || gx_contact.light.w <= 0.0 {
        return vec4<f32>(1.0, 0.0, 0.0, 1.0);
    }
    // A sample is compared with the depth at the centre of the texel it lands in, up to half a
    // texel away from it: on a surface seen at a slant that depth moves by up to half the receiver's
    // per-texel change in view distance, so a hit must lie behind the surface by more than that
    // (a slanted face or grazing ground never shadows itself).
    let texel = 1.0 / vec2<f32>(textureDimensions(gx_depth));
    let here = gx_view_distance(gx_frame.proj, depth);
    let slope = max(gx_contact_axis_slope(uv, here, vec2<f32>(texel.x, 0.0)), gx_contact_axis_slope(uv, here, vec2<f32>(0.0, texel.y)));
    let tolerance = 0.5 * slope;
    let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
    let receiver = gx_frame.inv_view_proj * ndc;
    let origin = receiver.xyz / receiver.w;
    let ray = gx_contact.light.xyz * gx_contact.light.w;
    let start = gx_contact_start(in.clip.xy);
    let thickness = gx_contact.params.x;
    for (var i = 0u; i < steps; i++) {
        let t = (f32(i) + start) / f32(steps);
        let clip = gx_frame.view_proj * vec4<f32>(origin + ray * t, 1.0);
        if clip.w <= 0.0 {
            break;
        }
        let sample_ndc = clip.xyz / clip.w;
        let sample_uv = vec2<f32>(sample_ndc.x * 0.5 + 0.5, 0.5 - sample_ndc.y * 0.5);
        if any(sample_uv < vec2<f32>(0.0)) || any(sample_uv >= vec2<f32>(1.0)) {
            break;
        }
        // A sample still within the receiver's own texel neighbourhood reads the receiver's
        // surface (a twig's or a kerb's own front face, nearer than a point just above its top), so
        // only samples that have left it can occlude.
        if distance(sample_uv / texel, uv / texel) < GX_CONTACT_MIN_TEXELS {
            continue;
        }
        let scene = gx_contact_depth_at(sample_uv);
        if gx_contact_is_sky(scene) {
            continue;
        }
        // How far the drawn surface lies in front of the sample, in view distance.
        let ahead = gx_view_distance(gx_frame.proj, sample_ndc.z) - gx_view_distance(gx_frame.proj, scene);
        if ahead > tolerance && ahead < thickness + tolerance {
            return vec4<f32>(gx_contact_hit_visibility(t), 0.0, 0.0, 1.0);
        }
    }
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
