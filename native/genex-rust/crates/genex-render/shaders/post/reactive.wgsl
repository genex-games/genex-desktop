// TAA's reactive coverage (graph node 15a; RQ5.2): the transparent draws redrawn as coverage into
// an r8unorm mask at render size (1: take the current sample), depth-tested against the scene's
// depth without writing it and max-blended, so the no-history flags RQ5.1's prepass writes into
// the same mask stay set. Jittered exactly as the scene was, so the mask lines up with the pixels
// it marks. Its own small pass, so the world pass keeps one colour target and Level-3 in-world
// pipelines are unchanged. The forward pass's frame group binds here unchanged (a subset of it);
// particles take the entry points of `post::taa::REACTIVE_PARTICLES`. A transparent mesh writes
// its material's alpha (the base colour's factor; its texture is not sampled here), capped at the
// frame's coverage (`post::taa::transparent_coverage`): 0 when every transparent stood still, so
// they accumulate, else 0.9 (FSR2's reactive guidance), so a moving one keeps a tenth of its history.
// A moved mesh writes its share of that cap by how far its surface moved under the pixel since last
// frame, whole from a pixel a frame (G0: a lake drifting a hundredth of a pixel a frame wrote the
// whole cap, and its flat water showed every frame's jittered sample).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> slot_base: array<u32>;
@group(1) @binding(0) var<uniform> pass_view: PassView;

// Mirrors `post::taa::GpuReactiveJitter`.
struct ReactiveJitter {
    // xy: this frame's jitter in NDC (y up); z: the most coverage a transparent mesh writes (its
    // material's alpha below it); w: reserved.
    ndc: vec4<f32>,
    // xy: the render size in pixels; z: the motion (pixels a frame) below which a moved mesh
    // writes none; w: 1 when a mesh writes its share of the cap by how far its surface moved under
    // the pixel (all of it from GX_REACTIVE_FULL_MOTION_PX).
    motion: vec4<f32>,
}

@group(2) @binding(0) var<uniform> gx_reactive_jitter: ReactiveJitter;
// `post::taa::REACTIVE_FULL_MOTION_PX`: the motion (pixels a frame) of whole coverage.
const GX_REACTIVE_FULL_MOTION_PX: f32 = 1.0;
// Last frame's model of every instance row, at the row's index (the motion prepass's table).
@group(2) @binding(1) var<storage, read> gx_prev_models: array<PrevModel>;

struct ReactiveIn {
    @location(0) position: vec3<f32>,
    @location(4) slot: u32,
}

struct ReactiveOut {
    @builtin(position) clip: vec4<f32>,
    // The row's material (`materials` is read in the fragment stage only).
    @location(0) @interpolate(flat) material: u32,
    // This point through this frame's camera (unjittered clip), and where last frame's model put
    // it through the same camera: the surface's own motion, the camera's left out.
    @location(1) now: vec4<f32>,
    @location(2) before: vec4<f32>,
}

@vertex
fn vs_reactive(in: ReactiveIn, @builtin(instance_index) instance: u32) -> ReactiveOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot];
    }
    let index = visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)];
    let row = instances[index];
    let world = row.model * vec4<f32>(in.position, 1.0);
    var out: ReactiveOut;
    out.clip = gx_clip_position(frame.view_proj, world, gx_reactive_jitter.ndc.xy);
    out.material = row.material;
    out.now = frame.view_proj * world;
    out.before = out.now;
    if gx_reactive_jitter.motion.w > 0.5 {
        out.before = frame.view_proj * (gx_prev_models[index].model * vec4<f32>(in.position, 1.0));
    }
    return out;
}

// The share of the cap a surface that moved `now` - `before` (clip) under this pixel writes: none
// below the still motion, rising linearly to all of it at the motion of whole coverage (all of it
// when either point lies on or behind the camera plane).
fn gx_reactive_motion_share(now: vec4<f32>, before: vec4<f32>) -> f32 {
    if gx_reactive_jitter.motion.w < 0.5 {
        return 1.0;
    }
    if now.w <= 1e-6 || before.w <= 1e-6 {
        return 1.0;
    }
    let moved = (now.xy / now.w - before.xy / before.w) * 0.5 * gx_reactive_jitter.motion.xy;
    let still = gx_reactive_jitter.motion.z;
    return saturate((length(moved) - still) / (GX_REACTIVE_FULL_MOTION_PX - still));
}

@fragment
fn fs_reactive(in: ReactiveOut) -> @location(0) vec4<f32> {
    let alpha = clamp(materials[in.material].base_color.a, 0.0, 1.0);
    let share = gx_reactive_motion_share(in.now, in.before);
    return vec4<f32>(min(alpha, gx_reactive_jitter.ndc.z) * share, 0.0, 0.0, 1.0);
}
