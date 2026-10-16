// A sorted emitter's bitonic sort of its (key, slot) pairs, ascending by key then slot (renderer
// pass 2 A.11). Ported from AMD GPUParticles11's sort as Godot 4.7.2 carries it
// (`servers/rendering/renderer_rd/shaders/effects/sort.glsl`, MIT, Copyright (c) 2016 Advanced
// Micro Devices, Inc.; THIRD-PARTY-NOTICES.md): a block of pairs per workgroup sorted in workgroup
// memory (`cs_sort_block`), then for each larger merge the global steps down to a block apart
// (`cs_sort_step`) and the rest of the merge in workgroup memory again (`cs_sort_inner`). Genex
// holds 2048 pairs a block (16 KiB, WebGPU's default workgroup memory) where Godot holds 512, each
// of the 256 lanes taking four exchanges a step: a 16k emitter sorts in 10 dispatches, not 21
// (renderer pass 2 A.11: the 64k budget row). The first
// step of each merge compares mirrored pairs (a "flip"), so every block sorts ascending and a
// count that is not a power of two needs no padding: a pair past the count is left alone, as if
// it held +infinity. A fixed network over unique (key, slot) pairs: the same order on every run.
// Every sorted emitter of a frame sorts in the same dispatches, one segment of the shared pairs
// each (workgroup y); steps past a shorter segment's merges leave its sorted pairs as they are.

// One row per sorted emitter of the frame (`particles::GpuSortSegment`): x the first pair of its
// segment, y its count; z, w 0.
@group(0) @binding(0) var<uniform> sort_segments: array<vec4<u32>, 16>;
@group(0) @binding(1) var<storage, read_write> sort_pairs: array<vec2<u32>>;

// One global step (`particles::GpuSortStep`): x the merge's sub size, y the partner's offset from
// the pair's base (2·sub − 1 on a flip, sub otherwise), z −1 on a flip (the partner mirrors) and 1
// otherwise.
struct SortStep {
    params: vec4<i32>,
}

@group(1) @binding(0) var<uniform> sort_step: SortStep;

const SORT_SIZE: u32 = 2048u;
const SORT_THREADS: u32 = 256u;
// Pairs each lane loads and stores, and exchanges it makes a step.
const SORT_LANE_PAIRS: u32 = 8u;
const SORT_LANE_EXCHANGES: u32 = 4u;

var<workgroup> sort_lds: array<vec2<u32>, 2048>;

// Whether `a` goes after `b`: by key, then by slot.
fn sort_after(a: vec2<u32>, b: vec2<u32>) -> bool {
    return a.x > b.x || (a.x == b.x && a.y > b.y);
}

// Pairs this workgroup's block of `segment` holds.
fn sort_block_count(segment: u32, block: u32) -> u32 {
    let count = sort_segments[segment].y;
    let base = block * SORT_SIZE;
    return select(0u, min(SORT_SIZE, count - base), base < count);
}

// Load the block's pairs into workgroup memory: every lane stores all of its slots (a pair past
// the count as the last key), so nothing reads a slot before it is written.
fn sort_load(first: u32, block: u32, lane: u32, held: u32) {
    for (var i = 0u; i < SORT_LANE_PAIRS; i += 1u) {
        let at = lane + i * SORT_THREADS;
        var pair = vec2<u32>(PARTICLE_KEY_LAST, PARTICLE_KEY_LAST);
        if at < held {
            pair = sort_pairs[first + block * SORT_SIZE + at];
        }
        sort_lds[at] = pair;
    }
    workgroupBarrier();
}

fn sort_store(first: u32, block: u32, lane: u32, held: u32) {
    for (var i = 0u; i < SORT_LANE_PAIRS; i += 1u) {
        let at = lane + i * SORT_THREADS;
        if at < held {
            sort_pairs[first + block * SORT_SIZE + at] = sort_lds[at];
        }
    }
}

// Compare and order workgroup slots `index` and `partner` (`partner` past the block's count: left).
fn sort_exchange(index: u32, partner: u32, held: u32) {
    if partner < held {
        let a = sort_lds[index];
        let b = sort_lds[partner];
        if sort_after(a, b) {
            sort_lds[index] = b;
            sort_lds[partner] = a;
        }
    }
}

@compute @workgroup_size(256)
fn cs_sort_block(@builtin(workgroup_id) block: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let first = sort_segments[block.y].x;
    let held = sort_block_count(block.y, block.x);
    sort_load(first, block.x, lane, held);
    for (var span = 2u; span <= SORT_SIZE; span = span * 2u) {
        for (var sub = span >> 1u; sub > 0u; sub = sub >> 1u) {
            for (var e = 0u; e < SORT_LANE_EXCHANGES; e += 1u) {
                let pair = lane + e * SORT_THREADS;
                let low = pair & (sub - 1u);
                let high = 2u * (pair - low);
                let partner = select(high + sub + low, high + 2u * sub - 1u - low, sub == span >> 1u);
                sort_exchange(high + low, partner, held);
            }
            workgroupBarrier();
        }
    }
    sort_store(first, block.x, lane, held);
}

@compute @workgroup_size(256)
fn cs_sort_step(@builtin(global_invocation_id) id: vec3<u32>) {
    let first = sort_segments[id.y].x;
    let count = sort_segments[id.y].y;
    let sub = u32(sort_step.params.x);
    let low = id.x & (sub - 1u);
    let high = 2u * (id.x - low);
    let index = high + low;
    let partner = u32(i32(high) + sort_step.params.y + sort_step.params.z * i32(low));
    if partner < count {
        let a = sort_pairs[first + index];
        let b = sort_pairs[first + partner];
        if sort_after(a, b) {
            sort_pairs[first + index] = b;
            sort_pairs[first + partner] = a;
        }
    }
}

@compute @workgroup_size(256)
fn cs_sort_inner(@builtin(workgroup_id) block: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let first = sort_segments[block.y].x;
    let held = sort_block_count(block.y, block.x);
    sort_load(first, block.x, lane, held);
    for (var sub = SORT_SIZE >> 1u; sub > 0u; sub = sub >> 1u) {
        for (var e = 0u; e < SORT_LANE_EXCHANGES; e += 1u) {
            let pair = lane + e * SORT_THREADS;
            let low = pair & (sub - 1u);
            let high = 2u * (pair - low);
            sort_exchange(high + low, high + sub + low, held);
        }
        workgroupBarrier();
    }
    sort_store(first, block.x, lane, held);
}
