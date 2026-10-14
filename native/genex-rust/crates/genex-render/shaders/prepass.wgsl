// The depth/normal prepass (graph node 7; RQ4.1): the opaque instances through the camera view's
// region of the visible list, as the forward pass draws them (skinned batches read the skinned
// vertex buffer through the same entry point), then a world stage's custom geometry, into the
// sampleable scene depth and the `rg16float` octahedral normals target. Every position comes from
// `gx_clip_position` and is `@invariant`, as the forward vertex shader's is, so an `Equal`-depth
// main pass (non-tile classes, 1x) matches it bit for bit. The forward pass's frame group binds
// here unchanged (the bindings below are a subset of it), so one bind group serves both passes.
//
// The normals are world-space geometry normals (`gx_oct_encode`, effects.wgsl); a consumer turns
// them to view space with the frame's view matrix.
//
// With motion vectors (RQ5.1, `motion.rs`) the same draws run through the `*_motion` entry points
// into three targets: the normals, the `rg16float` motion (NDC, current minus previous, jitter
// removed) and TAA's `r8unorm` reactive mask, where a row without history writes 1 (TAA's
// reactive coverage pass max-blends the transparents over it later).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> slot_base: array<u32>;
@group(1) @binding(0) var<uniform> pass_view: PassView;

// One custom-geometry draw (prepass.rs `GpuPrepassDraw`, 256 bytes apart): a custom material's
// model matrix and its inverse-transpose.
struct PrepassDraw {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
}

@group(1) @binding(1) var<uniform> prepass_draw: PrepassDraw;

struct PrepassIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(4) slot: u32,
}

struct PrepassDrawIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
}

struct PrepassOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
}

@vertex
fn vs_prepass(in: PrepassIn, @builtin(instance_index) instance: u32) -> PrepassOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot];
    }
    let row = instances[visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)]];
    let world = row.model * vec4<f32>(in.position, 1.0);
    var out: PrepassOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

@vertex
fn vs_prepass_draw(in: PrepassDrawIn) -> PrepassOut {
    let world = prepass_draw.model * vec4<f32>(in.position, 1.0);
    var out: PrepassOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (prepass_draw.normal * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

@fragment
fn fs_prepass(in: PrepassOut) -> @location(0) vec2<f32> {
    return gx_oct_encode(normalize(in.normal));
}

// --- Motion vectors (RQ5.1): group 2 is `motion::MotionNode`'s ------------------------------

// Mirrors `layout::GpuPrevModel` (`motion::PREV_MODEL_WGSL`): one row per instance-table row.
struct PrevModel {
    // Last frame's model matrix (this frame's when the row has no history).
    model: mat4x4<f32>,
    // x: MOTION_FLAG_* bits; y: the first of last frame's skinned vertices of this row in
    // `prev_skinned` (GX_MOTION_NO_PREV_VERTICES: none, the row's current vertices stand in);
    // z: the first of this frame's skinned vertices (its batch's base vertex); w: reserved (0).
    flags: vec4<u32>,
}

// Mirrors `motion::GpuMotionFrame`.
struct MotionFrame {
    // Last frame's unjittered projection x view (this frame's after a reset).
    prev_view_proj: mat4x4<f32>,
    // xy: this frame's jitter in NDC (y up), what `gx_clip_position` adds; zw: reserved (0).
    jitter: vec4<f32>,
}

// `motion::MOTION_FLAG_NO_HISTORY`.
const GX_MOTION_NO_HISTORY: u32 = 1u;
// `motion::MOTION_FLAG_STILL`: last frame's world position is this frame's.
const GX_MOTION_STILL: u32 = 4u;
// `motion::NO_PREV_VERTICES`.
const GX_MOTION_NO_PREV_VERTICES: u32 = 0xffffffffu;

@group(2) @binding(0) var<uniform> motion_frame: MotionFrame;
@group(2) @binding(1) var<storage, read> prev_models: array<PrevModel>;
@group(2) @binding(2) var<storage, read> prev_skinned: array<MeshVertex>;

struct MotionOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    // The unjittered clip positions of this frame and the last: their NDC difference is the
    // motion with the jitter removed (perspective-correct, divided per fragment).
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    // 1 when the row has no history (TAA takes the current sample).
    @location(3) @interpolate(flat) reactive: u32,
}

struct MotionTargets {
    @location(0) normal: vec2<f32>,
    @location(1) motion: vec2<f32>,
    @location(2) reactive: f32,
}

// The model-space position this vertex had last frame: its skinned output then (when the row was
// skinned last frame too), else this frame's.
fn gx_motion_prev_local(position: vec3<f32>, flags: vec4<u32>, vertex: u32) -> vec3<f32> {
    if flags.y == GX_MOTION_NO_PREV_VERTICES {
        return position;
    }
    let v = prev_skinned[flags.y + (vertex - flags.z)].data;
    return vec3<f32>(v[0], v[1], v[2]);
}

@vertex
fn vs_prepass_motion(in: PrepassIn, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> MotionOut {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[in.slot];
    }
    let index = visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)];
    let row = instances[index];
    let prev = prev_models[index];
    let world = row.model * vec4<f32>(in.position, 1.0);
    // A still row skips the second transform (uniform across the instance's vertices).
    var prev_world = world;
    if (prev.flags.x & GX_MOTION_STILL) == 0u {
        prev_world = prev.model * vec4<f32>(gx_motion_prev_local(in.position, prev.flags, vertex), 1.0);
    }
    var out: MotionOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & GX_MOTION_NO_HISTORY;
    return out;
}

// A world stage's custom geometry: no previous transform is known, so its motion is the camera's
// alone (zero object motion) and it keeps its history.
@vertex
fn vs_prepass_draw_motion(in: PrepassDrawIn) -> MotionOut {
    let world = prepass_draw.model * vec4<f32>(in.position, 1.0);
    var out: MotionOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (prepass_draw.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * world;
    out.reactive = 0u;
    return out;
}

@fragment
fn fs_prepass_motion(in: MotionOut) -> MotionTargets {
    var out: MotionTargets;
    out.normal = gx_oct_encode(normalize(in.normal));
    out.reactive = f32(in.reactive);
    // A point behind last frame's camera has no reprojection: no motion, and no history.
    if in.previous.w <= 1e-6 || in.current.w <= 1e-6 {
        out.motion = vec2<f32>(0.0);
        out.reactive = 1.0;
        return out;
    }
    out.motion = in.current.xy / in.current.w - in.previous.xy / in.previous.w;
    return out;
}
