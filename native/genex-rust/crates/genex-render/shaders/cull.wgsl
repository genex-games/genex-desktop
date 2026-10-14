// The GPU-driven cull: one workgroup per (batch, active view): the camera, the drawn cascades, then
// the shadowed spots, of the nine views CullViews reserves. Each pass over 64 instances tests their
// bounding spheres against the view's frustum, prefix-sums the survivors in workgroup memory and
// writes their instance-table rows, in order, into the batch's region of the view's visible list;
// then one invocation writes the view's draw_indexed_indirect arguments for the batch.
// Order-preserving compaction (no atomics), so the visible list equals the CPU cull's and frames
// are deterministic. A batch is walked serially in chunks of 64 by its one workgroup.

@group(0) @binding(0) var<uniform> views: CullViews;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> batches: array<Batch>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<DrawIndexedArgs>;

const WORKGROUP: u32 = 64u;

var<workgroup> scan: array<u32, 64>;

fn in_frustum(view: u32, bounds: vec4<f32>) -> bool {
    for (var p = 0u; p < 6u; p++) {
        let plane = views.planes[view][p];
        if dot(plane.xyz, bounds.xyz) + plane.w < -bounds.w {
            return false;
        }
    }
    return true;
}

@compute @workgroup_size(64)
fn cull(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let view = group.y;
    // A far cascade the frame holds (its cadence) draws nothing: its cull is skipped.
    if (views.params.w & (1u << view)) != 0u {
        return;
    }
    let batch = batches[group.x];
    let region = view * views.params.x + batch.first_instance;
    var written = 0u;
    var start = 0u;
    loop {
        if start >= batch.instance_count {
            break;
        }
        let i = start + lane;
        var keep = 0u;
        if i < batch.instance_count && in_frustum(view, instances[batch.first_instance + i].bounds) {
            keep = 1u;
        }
        scan[lane] = keep;
        workgroupBarrier();
        for (var offset = 1u; offset < WORKGROUP; offset = offset * 2u) {
            var add = 0u;
            if lane >= offset {
                add = scan[lane - offset];
            }
            workgroupBarrier();
            scan[lane] = scan[lane] + add;
            workgroupBarrier();
        }
        if keep == 1u {
            visible[region + written + scan[lane] - 1u] = batch.first_instance + i;
        }
        written = written + workgroupUniformLoad(&scan[WORKGROUP - 1u]);
        start = start + WORKGROUP;
    }
    if lane == 0u {
        args[view * views.params.y + group.x] = DrawIndexedArgs(batch.index_count, written, batch.first_index, batch.base_vertex, 0u);
    }
}
