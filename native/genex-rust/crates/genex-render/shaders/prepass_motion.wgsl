// The motion prepass's shared chunk (RQ5.1; lane FR moved it out of prepass.wgsl): last frame's
// rows and camera at group 2 (`motion::MotionNode`'s), the flags, last frame's skinned vertices,
// and the targets a motion fragment writes. Included by the prepass module, its vertex-skinned
// twin and the forward module's prepass-surface twin (`shaders::PREPASS_SURFACE`).

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
    // Last frame's unjittered view_proj x this frame's inverse (motion_background.wgsl reads it).
    reproject: mat4x4<f32>,
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

// The motion prepass's targets of a fragment with `normal` (turned to the viewer), this frame's and
// last frame's unjittered clip positions and the row's no-history flag.
fn gx_motion_targets(normal: vec3<f32>, current: vec4<f32>, previous: vec4<f32>, reactive: u32) -> MotionTargets {
    var out: MotionTargets;
    out.normal = gx_oct_encode(normalize(normal));
    out.reactive = f32(reactive);
    // A point behind last frame's camera has no reprojection: no motion, and no history.
    if previous.w <= 1e-6 || current.w <= 1e-6 {
        out.motion = vec2<f32>(0.0);
        out.reactive = 1.0;
        return out;
    }
    out.motion = current.xy / current.w - previous.xy / previous.w;
    return out;
}

