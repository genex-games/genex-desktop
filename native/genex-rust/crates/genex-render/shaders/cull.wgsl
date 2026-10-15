// The GPU-driven cull over (instance, view) (renderer pass 2 A.0, LG-06): the camera, the drawn
// cascades, then the shadowed spots, of the nine views CullViews reserves. Each instance's
// bounding sphere is tested against each active view's frustum by its own invocation, so a batch's
// instances spread over the GPU and the cull's time follows the instances, not the largest batch.
// A deterministic ordered compaction without atomics (our meshlet cull's three dispatches): the
// visible list and the indirect arguments equal the CPU cull's, slot for slot, on every run.
// - `cull_mark` (blocks x views): each block of 256 opaque rows writes its survivors' bits (eight
//   words) and its survivor count into the view's scratch.
// - `cull_scan` (1 x views): one workgroup turns the view's block counts into exclusive prefixes
//   (the total after them), then writes every batch's draw_indexed_indirect arguments: its
//   survivors are the prefix at its end less the prefix at its start.
// - `cull_scatter` (blocks x views): each survivor's slot in its batch's region is its prefix less
//   the prefix at its batch's first row (a binary search of the batches), in row order.
// A far cascade the frame holds (its cadence) draws nothing: all three skip it, so its arguments
// keep what they held.

@group(0) @binding(0) var<uniform> views: CullViews;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> batches: array<Batch>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<DrawIndexedArgs>;
// Per active view (cull::scratch_words_per_view): the survivor bits of every block (eight words a
// block), then each block's exclusive prefix and the view's total.
@group(0) @binding(5) var<storage, read_write> scratch: array<u32>;

// Rows per block (cull.rs CULL_BLOCK): one workgroup's invocations.
const GX_CULL_BLOCK: u32 = 256u;
const GX_CULL_BLOCK_WORDS: u32 = 8u;

var<workgroup> scan: array<u32, 256>;
// `cull_mark`'s survivors per bit word of its block.
var<workgroup> word_counts: array<u32, 8>;

fn in_frustum(view: u32, bounds: vec4<f32>) -> bool {
    for (var p = 0u; p < 6u; p++) {
        let plane = views.planes[view][p];
        if dot(plane.xyz, bounds.xyz) + plane.w < -bounds.w {
            return false;
        }
    }
    return true;
}

fn gx_cull_blocks() -> u32 {
    return (views.params.x + GX_CULL_BLOCK - 1u) / GX_CULL_BLOCK;
}

// Where view `view`'s scratch starts: its bits, then its prefixes.
fn gx_cull_base(view: u32) -> u32 {
    let blocks = gx_cull_blocks();
    return view * (blocks * (GX_CULL_BLOCK_WORDS + 1u) + 1u);
}

fn gx_cull_prefix_at(view: u32) -> u32 {
    return gx_cull_base(view) + gx_cull_blocks() * GX_CULL_BLOCK_WORDS;
}

fn gx_cull_held(view: u32) -> bool {
    return (views.params.w & (1u << view)) != 0u;
}

// Survivors of view `view` among rows `0 .. row` (row at most the opaque rows): the prefix of
// row's block plus the bits of the block before it.
fn gx_cull_survivors_before(view: u32, row: u32) -> u32 {
    let block = row / GX_CULL_BLOCK;
    var count = scratch[gx_cull_prefix_at(view) + block];
    let first_word = gx_cull_base(view) + block * GX_CULL_BLOCK_WORDS;
    let within = row % GX_CULL_BLOCK;
    for (var w = 0u; w < within / 32u; w++) {
        count += countOneBits(scratch[first_word + w]);
    }
    let rest = within % 32u;
    if rest != 0u {
        count += countOneBits(scratch[first_word + within / 32u] & ((1u << rest) - 1u));
    }
    return count;
}

// The batch holding opaque row `row`: the last batch whose first row is at most it.
fn gx_cull_batch_of(row: u32) -> u32 {
    var lo = 0u;
    var hi = views.params.y - 1u;
    while lo < hi {
        let mid = (lo + hi + 1u) / 2u;
        if batches[mid].first_instance <= row {
            lo = mid;
        } else {
            hi = mid - 1u;
        }
    }
    return lo;
}

// Inclusive Hillis-Steele scan of `scan` over the workgroup.
fn gx_cull_scan_workgroup(lane: u32) {
    for (var offset = 1u; offset < GX_CULL_BLOCK; offset <<= 1u) {
        var add = 0u;
        if lane >= offset {
            add = scan[lane - offset];
        }
        workgroupBarrier();
        scan[lane] += add;
        workgroupBarrier();
    }
}

@compute @workgroup_size(256)
fn cull_mark(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let view = group.y;
    if gx_cull_held(view) {
        return;
    }
    let row = group.x * GX_CULL_BLOCK + lane;
    var keep = 0u;
    if row < views.params.x && in_frustum(view, instances[row].bounds) {
        keep = 1u;
    }
    scan[lane] = keep << (lane % 32u);
    workgroupBarrier();
    if lane < GX_CULL_BLOCK_WORDS {
        var word = 0u;
        for (var bit = 0u; bit < 32u; bit++) {
            word |= scan[lane * 32u + bit];
        }
        scratch[gx_cull_base(view) + group.x * GX_CULL_BLOCK_WORDS + lane] = word;
        word_counts[lane] = countOneBits(word);
    }
    workgroupBarrier();
    if lane == 0u {
        var total = 0u;
        for (var w = 0u; w < GX_CULL_BLOCK_WORDS; w++) {
            total += word_counts[w];
        }
        scratch[gx_cull_prefix_at(view) + group.x] = total;
    }
}

@compute @workgroup_size(256)
fn cull_scan(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let view = group.y;
    if gx_cull_held(view) {
        return;
    }
    let blocks = gx_cull_blocks();
    let at = gx_cull_prefix_at(view);
    let per = (blocks + GX_CULL_BLOCK - 1u) / GX_CULL_BLOCK;
    let first = min(lane * per, blocks);
    let last = min(first + per, blocks);
    var sum = 0u;
    for (var b = first; b < last; b++) {
        sum += scratch[at + b];
    }
    scan[lane] = sum;
    workgroupBarrier();
    gx_cull_scan_workgroup(lane);
    var run = scan[lane] - sum;
    for (var b = first; b < last; b++) {
        let here = scratch[at + b];
        scratch[at + b] = run;
        run += here;
    }
    if lane == GX_CULL_BLOCK - 1u {
        scratch[at + blocks] = scan[lane];
    }
    // The prefixes this workgroup wrote are read back below by other lanes.
    storageBarrier();
    workgroupBarrier();
    let rows = views.params.x;
    for (var b = lane; b < views.params.y; b += GX_CULL_BLOCK) {
        let batch = batches[b];
        let start = min(batch.first_instance, rows);
        let end = min(batch.first_instance + batch.instance_count, rows);
        let survivors = gx_cull_survivors_before(view, end) - gx_cull_survivors_before(view, start);
        args[view * views.params.y + b] = DrawIndexedArgs(batch.index_count, survivors, batch.first_index, batch.base_vertex, 0u);
    }
}

@compute @workgroup_size(256)
fn cull_scatter(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let view = group.y;
    if gx_cull_held(view) {
        return;
    }
    let row = group.x * GX_CULL_BLOCK + lane;
    var keep = 0u;
    if row < views.params.x {
        let word = scratch[gx_cull_base(view) + group.x * GX_CULL_BLOCK_WORDS + lane / 32u];
        keep = (word >> (lane % 32u)) & 1u;
    }
    scan[lane] = keep;
    workgroupBarrier();
    gx_cull_scan_workgroup(lane);
    if keep == 1u {
        let survivor = scratch[gx_cull_prefix_at(view) + group.x] + scan[lane] - 1u;
        let batch = batches[gx_cull_batch_of(row)];
        let slot = batch.first_instance + survivor - gx_cull_survivors_before(view, batch.first_instance);
        visible[view * views.params.x + slot] = row;
    }
}
