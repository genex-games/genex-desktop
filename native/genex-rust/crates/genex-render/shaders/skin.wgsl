// Compute skinning: one invocation per vertex of one job (one skinned draw). The vertex's four
// joint matrices are blended by its weights, in slot order (src/skin.rs sums them the same way),
// and the skinned vertex and its slot are written into the storage vertex buffers the opaque
// batches draw from. With motion vectors (RQ5.1) the output is one of a pair that swaps every
// frame (`skin::SkinnedPair`), so the other still holds last frame's skinned vertices for the
// prepass's previous positions.

@group(0) @binding(0) var<storage, read> source: array<MeshVertex>;
@group(0) @binding(1) var<storage, read> skins: array<SkinVertex>;
@group(0) @binding(2) var<storage, read> joints: array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read> jobs: array<SkinJob>;
@group(0) @binding(4) var<storage, read_write> output: array<MeshVertex>;
@group(0) @binding(5) var<storage, read_write> output_slots: array<u32>;

const SKIN_WORKGROUP: u32 = 64u;

@compute @workgroup_size(64)
fn skin(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let job = jobs[group.y];
    let i = id.x;
    if i >= job.count {
        return;
    }
    let v = source[job.src_base + i].data;
    let s = skins[job.skin_base + i];
    var m = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    for (var k = 0u; k < 4u; k++) {
        m = m + joints[job.joint_base + s.joints[k]] * s.weights[k];
    }
    let p = m * vec4<f32>(v[0], v[1], v[2], 1.0);
    let n = normalize((m * vec4<f32>(v[3], v[4], v[5], 0.0)).xyz);
    let t = normalize((m * vec4<f32>(v[8], v[9], v[10], 0.0)).xyz);
    var out: MeshVertex;
    out.data = array<f32, 12>(p.x, p.y, p.z, n.x, n.y, n.z, v[6], v[7], t.x, t.y, t.z, v[11]);
    output[job.dst_base + i] = out;
    output_slots[job.dst_base + i] = job.slot;
}
