// The meshlet draws' vertex pulling (R2). A view's compacted index buffer holds
// `gx_meshlet_index(slot, local)`: the drawn slot names the instance-table row and the meshlet,
// the meshlet's vertex buffer holds library vertex ids (rebased at upload), and the vertex is read
// from the library's vertices in storage. Indexed draws keep the post-transform cache: a vertex
// shared by a meshlet's triangles is one index.
//
// Each entry point computes what its instance-path twin computes, expression for expression, so
// the pictures match: `vs_meshlet` is forward.wgsl's `vs_main` (paired with the forward module's
// fragment entries: the outputs keep its locations, types and interpolation), `vs_meshlet_prepass`
// is prepass.wgsl's `vs_prepass` (paired with `fs_prepass`) and `vs_meshlet_shadow` is
// shadow.wgsl's `vs_shadow`. Every depth writer's position is @invariant and computed by
// gx_clip_position, so a meshlet prepass and an instance main pass (or the reverse) agree on depth.
//
// Group 0 is the forward frame group's (frame uniforms and the instance table at their forward
// bindings), group 1 the pass view, group 2 the meshlet tables (`layout::MESHLET_DRAW_BINDINGS`).

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(1) @binding(0) var<uniform> pass_view: PassView;
@group(2) @binding(0) var<storage, read> mesh_vertices: array<MeshVertex>;
@group(2) @binding(1) var<storage, read> meshlets: array<Meshlet>;
@group(2) @binding(2) var<storage, read> meshlet_vertices: array<u32>;
@group(2) @binding(3) var<storage, read> drawn_meshlets: array<DrawnMeshlet>;

// One pulled vertex and the instance-table row it is drawn with.
struct MeshletVertex {
    row: Instance,
    position: vec3<f32>,
    normal: vec3<f32>,
    uv: vec2<f32>,
    tangent: vec4<f32>,
}

fn gx_meshlet_pull(index: u32) -> MeshletVertex {
    let decoded = gx_meshlet_decode(index);
    let drawn = drawn_meshlets[decoded.x];
    let meshlet = meshlets[drawn.meshlet];
    let data = mesh_vertices[meshlet_vertices[meshlet.vertex_offset + decoded.y]].data;
    var out: MeshletVertex;
    out.row = instances[drawn.instance];
    out.position = vec3<f32>(data[0], data[1], data[2]);
    out.normal = vec3<f32>(data[3], data[4], data[5]);
    out.uv = vec2<f32>(data[6], data[7]);
    out.tangent = vec4<f32>(data[8], data[9], data[10], data[11]);
    return out;
}

// forward.wgsl's `VsOut`, location for location.
struct MeshletVsOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) @interpolate(flat) material: u32,
}

@vertex
fn vs_meshlet(@builtin(vertex_index) index: u32) -> MeshletVsOut {
    let in = gx_meshlet_pull(index);
    let row = in.row;
    let world = gx_row_world(row, in.position, frame.texture_lod.y);
    var out: MeshletVsOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.world_pos = world.xyz;
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.uv = in.uv;
    out.tangent = vec4<f32>((row.model * vec4<f32>(in.tangent.xyz, 0.0)).xyz, in.tangent.w);
    out.material = row.material;
    return out;
}

// prepass.wgsl's `PrepassOut`.
struct MeshletPrepassOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
}

@vertex
fn vs_meshlet_prepass(@builtin(vertex_index) index: u32) -> MeshletPrepassOut {
    let in = gx_meshlet_pull(index);
    let row = in.row;
    let world = gx_row_world(row, in.position, frame.texture_lod.y);
    var out: MeshletPrepassOut;
    out.clip = gx_clip_position(frame.view_proj, world, frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

// A shadow caster into the pass view's cascade, pancaked onto the near plane like `vs_shadow`
// (shadow_caster.wgsl). Casters read only the position and the model matrix.
@vertex
fn vs_meshlet_shadow(@builtin(vertex_index) index: u32) -> ShadowCasterOut {
    let decoded = gx_meshlet_decode(index);
    let drawn = drawn_meshlets[decoded.x];
    let vertex = meshlet_vertices[meshlets[drawn.meshlet].vertex_offset + decoded.y];
    let position = vec3<f32>(mesh_vertices[vertex].data[0], mesh_vertices[vertex].data[1], mesh_vertices[vertex].data[2]);
    return gx_shadow_caster(frame.cascade_view_proj[pass_view.view - 1u] * gx_row_world(instances[drawn.instance], position, frame.texture_lod.y));
}

// Depth only (layout and pipeline checks; the frame pairs the vertex entries with the forward and
// prepass fragments).
@fragment
fn fs_meshlet_depth(in: MeshletVsOut) {
}

// --- Motion vectors (RQ5.6): group 3 is `motion::MotionNode::meshlet_layout`'s (the motion frame
// row and the previous-model table, without the skinned vertices: clustered meshes are static,
// and the vertex stage's storage bindings stay within WebGPU core's eight).

// Mirrors `layout::GpuPrevModel` (prepass.wgsl's `PrevModel`).
struct MeshletPrevModel {
    model: mat4x4<f32>,
    flags: vec4<u32>,
}

// Mirrors `motion::GpuMotionFrame` (prepass.wgsl's `MotionFrame`).
struct MeshletMotionFrame {
    prev_view_proj: mat4x4<f32>,
    jitter: vec4<f32>,
    reproject: mat4x4<f32>,
}

@group(3) @binding(0) var<uniform> meshlet_motion_frame: MeshletMotionFrame;
@group(3) @binding(1) var<storage, read> meshlet_prev_models: array<MeshletPrevModel>;

// prepass.wgsl's `MotionOut`, location for location (paired with its `fs_prepass_motion`).
struct MeshletMotionOut {
    @builtin(position) @invariant clip: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) current: vec4<f32>,
    @location(2) previous: vec4<f32>,
    @location(3) @interpolate(flat) reactive: u32,
}

// `vs_prepass_motion`'s twin over pulled vertices: last frame's position is the vertex under the
// row's previous model (`motion::MOTION_FLAG_NO_HISTORY` in its flags makes the pixel reactive).
@vertex
fn vs_meshlet_prepass_motion(@builtin(vertex_index) index: u32) -> MeshletMotionOut {
    let drawn = drawn_meshlets[gx_meshlet_decode(index).x];
    let in = gx_meshlet_pull(index);
    let row = in.row;
    let prev = meshlet_prev_models[drawn.instance];
    let world = gx_row_world(row, in.position, frame.texture_lod.y);
    var out: MeshletMotionOut;
    out.clip = gx_clip_position(frame.view_proj, world, meshlet_motion_frame.jitter.xy);
    out.normal = (row.normal * vec4<f32>(in.normal, 0.0)).xyz;
    out.current = frame.view_proj * world;
    // `motion::MOTION_FLAG_STILL` (4): a still row's world position is last frame's.
    var prev_world = world;
    if (prev.flags.x & 4u) == 0u {
        prev_world = gx_sway_world(prev.model, in.position, gx_row_wind(row), frame.texture_lod.z);
    }
    out.previous = meshlet_motion_frame.prev_view_proj * prev_world;
    out.reactive = prev.flags.x & 1u;
    return out;
}
