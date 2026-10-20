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

// Whether the pipeline's instances may fade between LODs (a pipeline-overridable constant): the
// faded entries (`*_fade`; game systems LOD-04) cut away the pixels the other level of a
// crossfade keeps, by the instance fade table, as the forward pass covers them; false (the
// default) draws every row whole.
override GX_LOD_FADE: bool = false;
// Whether the faded entries turn their dither each frame (the motion prepass under TAA).
override GX_LOD_FADE_TEMPORAL: bool = false;
// Whether the faded vertex entries grow each copy about its origin by its far-field grow (game
// systems LOD-18, the forward pass's `GX_LOD_GROW`); the motion entries grow both positions by
// this frame's grow.
override GX_LOD_GROW: bool = false;

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(3) var<storage, read> visible: array<u32>;
@group(0) @binding(4) var<storage, read> slot_base: array<u32>;
// An alpha-tested batch's material inputs (P2-0.12, the alpha-mask chunk): the material table and
// its extension, the colour arrays of every size class and the material sampler.
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(8) var color_textures: texture_2d_array<f32>;
@group(0) @binding(10) var texture_sampler: sampler;
@group(0) @binding(23) var<storage, read> material_ext: array<GxMaterialExt>;
@group(0) @binding(24) var color_textures_512: texture_2d_array<f32>;
@group(0) @binding(26) var color_textures_1024: texture_2d_array<f32>;
@group(0) @binding(28) var color_textures_2048: texture_2d_array<f32>;
// The instance fade table (layout::FRAME_INSTANCE_FADE_BINDING), read by the faded fragments.
@group(0) @binding(31) var<storage, read> instance_fade: array<vec2<f32>>;
@group(1) @binding(0) var<uniform> pass_view: PassView;
// The instance fade table again, for the faded vertex entries' far-field grow (game systems
// LOD-18; renderer::PASS_FADE_GROWS_BINDING): only the faded pipelines' group 1 holds it, so no
// other pipeline's vertex stage counts it.
@group(1) @binding(2) var<storage, read> lod_grows: array<vec2<f32>>;

// One custom-geometry draw (prepass.rs `GpuPrepassDraw`, 256 bytes apart): a custom material's
// model matrix, its inverse-transpose, last frame's model matrix (this frame's without history,
// renderer pass 2 P2-0.8b T-04) and its flags (x: GX_MOTION_NO_HISTORY when it has none).
struct PrepassDraw {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    prev_model: mat4x4<f32>,
    flags: vec4<u32>,
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
        start = slot_base[in.slot + pass_view.slot_offset];
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

// A back face (a double-sided batch's; P2-0.12) writes the normal turned to the viewer, as the
// forward pass shades it.
@fragment
fn fs_prepass(in: PrepassOut, @builtin(front_facing) front: bool) -> @location(0) vec2<f32> {
    return gx_oct_encode(normalize(in.normal) * select(-1.0, 1.0, front));
}

// --- Alpha-tested batches (P2-0.12): the uv, the world position and the material reach the
// fragment, which cuts the cutout away (`gx_alpha_mask`, the pipeline's `GX_ALPHA_MODE`).

struct PrepassMaskIn {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(4) slot: u32,
}

struct PrepassMaskOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
    @location(3) @interpolate(flat) material: u32,
}

// The instance-table row of a batch vertex (slot `slot`, `instance`) through the pass view.
fn gx_prepass_row(slot: u32, instance: u32) -> u32 {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[slot + pass_view.slot_offset];
    }
    return visible[visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w)];
}

@vertex
fn vs_prepass_mask(in: PrepassMaskIn, @builtin(instance_index) instance: u32) -> PrepassMaskOut {
    let row = instances[gx_prepass_row(in.slot, instance)];
    let world = row.model * vec4<f32>(in.position, 1.0);
    var out: PrepassMaskOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.world = world.xyz;
    out.material = row.material;
    return out;
}

@fragment
fn fs_prepass_mask(in: PrepassMaskOut, @builtin(front_facing) front: bool) -> @location(0) vec2<f32> {
    if gx_alpha_mask(in.material, in.uv, in.world, frame.shadow_counts.z) <= 0.0 {
        discard;
    }
    return gx_oct_encode(normalize(in.normal) * select(-1.0, 1.0, front));
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
        start = slot_base[in.slot + pass_view.slot_offset];
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

// A world stage's custom geometry (renderer pass 2, P2-0.8b T-04): last frame's model matrix,
// matched by draw id or mesh ordinal (`motion::CustomMotion`), gives its object motion; a draw
// without history moves with the camera alone and takes the current sample.
@vertex
fn vs_prepass_draw_motion(in: PrepassDrawIn) -> MotionOut {
    let world = prepass_draw.model * vec4<f32>(in.position, 1.0);
    let prev_world = prepass_draw.prev_model * vec4<f32>(in.position, 1.0);
    var out: MotionOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (prepass_draw.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prepass_draw.flags.x & GX_MOTION_NO_HISTORY;
    return out;
}

@fragment
fn fs_prepass_motion(in: MotionOut, @builtin(front_facing) front: bool) -> MotionTargets {
    return gx_motion_targets(in.normal * select(-1.0, 1.0, front), in.current, in.previous, in.reactive);
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

// An alpha-tested batch's motion prepass (P2-0.12): `vs_prepass_motion`'s outputs with the uv, the
// world position and the material, the cutout cut away before the targets are written.
struct MotionMaskOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) @interpolate(flat) reactive: u32,
    @location(4) uv: vec2<f32>,
    @location(5) world: vec3<f32>,
    @location(6) @interpolate(flat) material: u32,
}

@vertex
fn vs_prepass_motion_mask(in: PrepassMaskIn, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> MotionMaskOut {
    let index = gx_prepass_row(in.slot, instance);
    let row = instances[index];
    let prev = prev_models[index];
    let world = row.model * vec4<f32>(in.position, 1.0);
    var prev_world = world;
    if (prev.flags.x & GX_MOTION_STILL) == 0u {
        prev_world = prev.model * vec4<f32>(gx_motion_prev_local(in.position, prev.flags, vertex), 1.0);
    }
    var out: MotionMaskOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & GX_MOTION_NO_HISTORY;
    out.uv = in.uv;
    out.world = world.xyz;
    out.material = row.material;
    return out;
}

@fragment
fn fs_prepass_motion_mask(in: MotionMaskOut, @builtin(front_facing) front: bool) -> MotionTargets {
    if gx_alpha_mask(in.material, in.uv, in.world, frame.shadow_counts.z) <= 0.0 {
        discard;
    }
    return gx_motion_targets(in.normal * select(-1.0, 1.0, front), in.current, in.previous, in.reactive);
}

// --- The LOD crossfade's faded batches (game systems LOD-04) ---------------------------------
// Each entry is its whole twin's (the same expressions) with the vertex's visible-list slot
// carried to the fragment, which cuts away the pixels the other level of the crossfade keeps
// (`gx_lod_fade_keeps`, the threshold the forward pass's one-sample coverage uses).

// The visible-list slot of a batch vertex (slot `slot`, `instance`) through the pass view.
fn gx_prepass_visible_at(slot: u32, instance: u32) -> u32 {
    var start = 0u;
    if pass_view.direct == 0u {
        start = slot_base[slot + pass_view.slot_offset];
    }
    return visible_row(pass_view.view, pass_view.direct, pass_view.base, start, instance, frame.counts.w);
}

// The far-field grow of the copy at slot `at` (LOD-18): its slot's under `GX_LOD_GROW`, else 1.
fn gx_prepass_grow(at: u32) -> f32 {
    if GX_LOD_GROW {
        return lod_grows[at].y;
    }
    return 1.0;
}

// Whether a faded fragment at `pixel` whose vertex read slot `at` is its level's.
fn gx_prepass_fade_keeps(at: u32, pixel: vec2<f32>) -> bool {
    if !GX_LOD_FADE {
        return true;
    }
    let threshold = gx_lod_fade_threshold(pixel, select(0u, frame.shadow_counts.z, GX_LOD_FADE_TEMPORAL));
    return gx_lod_fade_keeps(instance_fade[at].x, threshold);
}

struct PrepassFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_prepass_fade(in: PrepassIn, @builtin(instance_index) instance: u32) -> PrepassFadeOut {
    let at = gx_prepass_visible_at(in.slot, instance);
    let row = instances[visible[at]];
    let world = row.model * vec4<f32>(in.position * gx_prepass_grow(at), 1.0);
    var out: PrepassFadeOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.fade_at = at;
    return out;
}

@fragment
fn fs_prepass_fade(in: PrepassFadeOut, @builtin(front_facing) front: bool) -> @location(0) vec2<f32> {
    if !gx_prepass_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return gx_oct_encode(normalize(in.normal) * select(-1.0, 1.0, front));
}

struct PrepassMaskFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
    @location(3) @interpolate(flat) material: u32,
    @location(4) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_prepass_mask_fade(in: PrepassMaskIn, @builtin(instance_index) instance: u32) -> PrepassMaskFadeOut {
    let at = gx_prepass_visible_at(in.slot, instance);
    let row = instances[visible[at]];
    let world = row.model * vec4<f32>(in.position * gx_prepass_grow(at), 1.0);
    var out: PrepassMaskFadeOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.world = world.xyz;
    out.material = row.material;
    out.fade_at = at;
    return out;
}

@fragment
fn fs_prepass_mask_fade(in: PrepassMaskFadeOut, @builtin(front_facing) front: bool) -> @location(0) vec2<f32> {
    let kept = gx_alpha_mask(in.material, in.uv, in.world, frame.shadow_counts.z);
    if kept <= 0.0 || !gx_prepass_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return gx_oct_encode(normalize(in.normal) * select(-1.0, 1.0, front));
}

struct MotionFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) @interpolate(flat) reactive: u32,
    @location(4) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_prepass_motion_fade(in: PrepassIn, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> MotionFadeOut {
    let at = gx_prepass_visible_at(in.slot, instance);
    let index = visible[at];
    let row = instances[index];
    let prev = prev_models[index];
    let world = row.model * vec4<f32>(in.position * gx_prepass_grow(at), 1.0);
    var prev_world = world;
    if (prev.flags.x & GX_MOTION_STILL) == 0u {
        prev_world = prev.model * vec4<f32>(gx_motion_prev_local(in.position, prev.flags, vertex) * gx_prepass_grow(at), 1.0);
    }
    var out: MotionFadeOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & GX_MOTION_NO_HISTORY;
    out.fade_at = at;
    return out;
}

@fragment
fn fs_prepass_motion_fade(in: MotionFadeOut, @builtin(front_facing) front: bool) -> MotionTargets {
    if !gx_prepass_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return gx_motion_targets(in.normal * select(-1.0, 1.0, front), in.current, in.previous, in.reactive);
}

struct MotionMaskFadeOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) @interpolate(flat) reactive: u32,
    @location(4) uv: vec2<f32>,
    @location(5) world: vec3<f32>,
    @location(6) @interpolate(flat) material: u32,
    @location(7) @interpolate(flat) fade_at: u32,
}

@vertex
fn vs_prepass_motion_mask_fade(in: PrepassMaskIn, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> MotionMaskFadeOut {
    let at = gx_prepass_visible_at(in.slot, instance);
    let index = visible[at];
    let row = instances[index];
    let prev = prev_models[index];
    let world = row.model * vec4<f32>(in.position * gx_prepass_grow(at), 1.0);
    var prev_world = world;
    if (prev.flags.x & GX_MOTION_STILL) == 0u {
        prev_world = prev.model * vec4<f32>(gx_motion_prev_local(in.position, prev.flags, vertex) * gx_prepass_grow(at), 1.0);
    }
    var out: MotionMaskFadeOut;
    out.clip = gx_clip_position(frame.view_proj, world, motion_frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    out.previous = motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & GX_MOTION_NO_HISTORY;
    out.uv = in.uv;
    out.world = world.xyz;
    out.material = row.material;
    out.fade_at = at;
    return out;
}

@fragment
fn fs_prepass_motion_mask_fade(in: MotionMaskFadeOut, @builtin(front_facing) front: bool) -> MotionTargets {
    let kept = gx_alpha_mask(in.material, in.uv, in.world, frame.shadow_counts.z);
    if kept <= 0.0 || !gx_prepass_fade_keeps(in.fade_at, in.clip.xy) {
        discard;
    }
    return gx_motion_targets(in.normal * select(-1.0, 1.0, front), in.current, in.previous, in.reactive);
}
