// The meshlet cull (R2, graph nodes 5 and 8). A candidate is one (instance, meshlet) pair, in
// meshlet-instance table order; candidate `c` owns bit `c` of the visibility history.
//
// Two-pass occlusion (Haar/Aaltonen): pass 1 keeps the candidates last frame's bitset marks (that
// are in the view's frustum and do not face away); the frame draws them into the prepass and
// builds the Hi-Z from that depth. Pass 2 re-tests EVERY candidate (instance sphere, then the
// meshlet's sphere and normal cone against the frustum, then its bounds against the new Hi-Z),
// keeps those that pass and were not kept by pass 1, and writes its verdict for every candidate
// as the next frame's bitset. Shadow views (and the camera without occlusion) run pass 1 only,
// testing frustum and cone. Correctness never depends on the history: it only decides what pass 1
// draws early.
//
// Compaction is a deterministic three-dispatch scan: `cull_mark` writes each candidate's kept
// triangles and per-block sums, `cull_scan` turns one row's block sums into exclusive prefixes
// (one workgroup per row, no inter-workgroup waits), `cull_scatter` writes each kept meshlet's
// drawn slot and its triangles into the view's compacted index buffer as
// `gx_meshlet_index(slot, local)`. No atomics anywhere, so the drawn order is the candidate order
// on every run. Each view then draws with one `draw_indexed_indirect` per argument slot (pass 1,
// pass 2, both).
//
// Rows: pass-1 rows are the cull views (camera, then the cascades); pass 2 is one more row after
// them (`cull.counts.z`), for the camera view. Each view writes its own region of the compacted
// index buffer and the drawn slots; pass 2 continues the camera's after pass 1's draws.

@group(0) @binding(0) var<uniform> cull: MeshletCull;
@group(0) @binding(1) var<uniform> views: CullViews;
@group(0) @binding(2) var<uniform> frame: FrameUniforms;
@group(0) @binding(3) var<storage, read> instances: array<Instance>;
@group(0) @binding(4) var<storage, read> meshlet_instances: array<MeshletInstance>;
@group(0) @binding(5) var<storage, read> meshlets: array<Meshlet>;
@group(0) @binding(6) var<storage, read_write> visibility: array<u32>;
@group(0) @binding(7) var<storage, read_write> keep: array<u32>;
@group(0) @binding(8) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(9) var<storage, read_write> totals: array<u32>;
@group(0) @binding(10) var<storage, read_write> args: array<u32>;
@group(0) @binding(11) var<storage, read> triangles: array<u32>;
@group(0) @binding(12) var<storage, read_write> drawn: array<DrawnMeshlet>;
@group(0) @binding(13) var<storage, read_write> indices: array<u32>;
@group(0) @binding(14) var hiz: texture_2d<f32>;
// Each view's region (`meshlet_cull::GpuViewRegion`): x its first index, y its first drawn slot,
// z and w their capacities (sized on the CPU for the instances its frustum may hold). One per
// `layout::MAX_VIEWS`.
@group(0) @binding(15) var<uniform> regions: array<vec4<u32>, 21>;

// Items one workgroup of the scan covers (`meshlet_cull::SCAN_BLOCK`).
const GX_SCAN_BLOCK: u32 = 256u;
// `cull.capacity.w` bits (`meshlet_cull::FLAG_*`).
const GX_FLAG_OCCLUSION: u32 = 1u;
const GX_FLAG_HISTORY_RESET: u32 = 2u;
const GX_HISTORY_PREV_SHIFT: u32 = 2u;
const GX_HISTORY_NEXT_SHIFT: u32 = 4u;
const GX_HISTORY_SLOT_MASK: u32 = 3u;
// Indirect argument slots per view (`meshlet_cull::ArgsSlot`) and words per `DrawIndexedArgs`.
const GX_ARGS_PER_VIEW: u32 = 3u;
const GX_ARGS_WORDS: u32 = 5u;
// A corner whose clip w is at or below this is at the eye: the bounds are never occluded.
const GX_HIZ_MIN_W: f32 = 1.0e-5;
// The near plane's and far plane's rows among a view's six planes.
const GX_FAR_PLANE: u32 = 5u;

var<workgroup> scan_a: array<u32, 256>;
var<workgroup> scan_b: array<u32, 256>;
var<workgroup> marks: array<u32, 256>;
var<workgroup> lane_slots: array<u32, 256>;

fn second_pass() -> bool {
    return cull.counts.w == 2u;
}

// The row a dispatch writes: the view on pass 1, the extra row after the views on pass 2.
fn cull_row(z: u32) -> u32 {
    if second_pass() {
        return cull.counts.z;
    }
    return z;
}

// The view a dispatch culls for: pass 2 is the camera's.
fn cull_view(z: u32) -> u32 {
    if second_pass() {
        return 0u;
    }
    return z;
}

// The meshlet instance owning `candidate`: the last row whose first candidate is at or before it.
fn meshlet_instance_of(candidate: u32) -> u32 {
    var lo = 0u;
    var hi = cull.counts.y;
    while hi - lo > 1u {
        let mid = (lo + hi) / 2u;
        if meshlet_instances[mid].first_candidate <= candidate {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// The sphere test of cull.wgsl (and `cull::in_frustum`), expression for expression.
fn sphere_in_view(view: u32, centre: vec3<f32>, radius: f32) -> bool {
    for (var p = 0u; p < 6u; p++) {
        let plane = views.planes[view][p];
        if plane.x * centre.x + plane.y * centre.y + plane.z * centre.z + plane.w < -radius {
            return false;
        }
    }
    return true;
}

// Whether `view` projects orthographically: every shadow cascade, and a camera whose
// projection's w row is constant.
fn orthographic(view: u32) -> bool {
    if view != 0u {
        return true;
    }
    let w_row = vec3<f32>(frame.view_proj[0].w, frame.view_proj[1].w, frame.view_proj[2].w);
    return all(w_row == vec3<f32>(0.0));
}

// Whether every triangle of `meshlet` faces away from `view`, tested in the instance's object
// space so a non-uniform scale keeps the cone exact. Mirrored instances (negative determinant)
// flip their winding and are never culled by the cone.
fn faces_away(view: u32, row: Instance, meshlet: Meshlet) -> bool {
    if meshlet.cone.w >= 1.0 {
        return false;
    }
    let linear = mat3x3<f32>(row.model[0].xyz, row.model[1].xyz, row.model[2].xyz);
    if determinant(linear) <= 0.0 {
        return false;
    }
    // The model's inverse: `normal` is its inverse-transpose.
    let inverse = transpose(row.normal);
    if orthographic(view) {
        // The far plane's inward normal points back at the viewer: the view direction is minus it.
        let towards = -views.planes[view][GX_FAR_PLANE].xyz;
        let direction = (inverse * vec4<f32>(towards, 0.0)).xyz;
        let length_d = length(direction);
        if length_d == 0.0 {
            return false;
        }
        return dot(direction / length_d, meshlet.cone.xyz) >= meshlet.cone.w;
    }
    let eye = (inverse * vec4<f32>(frame.camera_pos.xyz, 1.0)).xyz;
    return gx_meshlet_backfacing(meshlet.bounds.xyz, meshlet.bounds.w, meshlet.cone, eye);
}

// Whether the world sphere (`centre`, `radius`) lies wholly behind the Hi-Z: its box's eight
// corners projected give a pixel rectangle and the nearest depth; the mip where the rectangle
// spans at most two texels each way holds, in four texels, the farthest depth of every pixel it
// covers (hiz.rs). Conservative: a box reaching the eye plane or the near plane is visible.
fn hiz_occluded(centre: vec3<f32>, radius: f32) -> bool {
    let reversed = cull.hiz.w == 1u;
    var lo = vec2<f32>(1.0e30);
    var hi = vec2<f32>(-1.0e30);
    var nearest = 1.0e30;
    if reversed {
        nearest = -1.0e30;
    }
    for (var i = 0u; i < 8u; i++) {
        let side = vec3<f32>(select(-1.0, 1.0, (i & 1u) != 0u), select(-1.0, 1.0, (i & 2u) != 0u), select(-1.0, 1.0, (i & 4u) != 0u));
        let clip = frame.view_proj * vec4<f32>(centre + side * radius, 1.0);
        if clip.w <= GX_HIZ_MIN_W {
            return false;
        }
        let ndc = clip.xyz / clip.w;
        lo = min(lo, ndc.xy);
        hi = max(hi, ndc.xy);
        if reversed {
            nearest = max(nearest, ndc.z);
        } else {
            nearest = min(nearest, ndc.z);
        }
    }
    if (reversed && nearest >= 1.0) || (!reversed && nearest <= 0.0) {
        return false;
    }
    let render = cull.hiz_uv.xy * 2.0 * vec2<f32>(cull.hiz.xy);
    let last = render - 1.0;
    let xs = (vec2<f32>(lo.x, hi.x) * 0.5 + 0.5) * render.x;
    let ys = (0.5 - vec2<f32>(hi.y, lo.y) * 0.5) * render.y;
    let p0 = vec2<u32>(clamp(floor(vec2<f32>(xs.x, ys.x)), vec2<f32>(0.0), last));
    let p1 = vec2<u32>(clamp(floor(vec2<f32>(xs.y, ys.y)), vec2<f32>(0.0), last));
    var level = 0u;
    var t0 = vec2<u32>(0u);
    var t1 = vec2<u32>(0u);
    loop {
        let size = textureDimensions(hiz, level);
        t0 = min(p0 >> vec2<u32>(level + 1u), size - 1u);
        t1 = min(p1 >> vec2<u32>(level + 1u), size - 1u);
        if (t1.x - t0.x <= 1u && t1.y - t0.y <= 1u) || level + 1u >= cull.hiz.z {
            break;
        }
        level += 1u;
    }
    let depths = vec4<f32>(
        textureLoad(hiz, t0, i32(level)).x,
        textureLoad(hiz, vec2<u32>(t1.x, t0.y), i32(level)).x,
        textureLoad(hiz, vec2<u32>(t0.x, t1.y), i32(level)).x,
        textureLoad(hiz, t1, i32(level)).x,
    );
    let farthest = gx_hiz_reduce(depths, cull.hiz.w);
    if reversed {
        return nearest < farthest;
    }
    return nearest > farthest;
}

// Whether a candidate is in `view`: its instance's sphere, its meshlet's sphere and cone, and on
// pass 2 the Hi-Z.
fn candidate_visible(view: u32, row: Instance, meshlet: Meshlet) -> bool {
    if !sphere_in_view(view, row.bounds.xyz, row.bounds.w) {
        return false;
    }
    let centre = (row.model * vec4<f32>(meshlet.bounds.xyz, 1.0)).xyz;
    let scale = max(max(length(row.model[0].xyz), length(row.model[1].xyz)), length(row.model[2].xyz));
    // A swaying row's clusters move by up to its reach and turn with it: their spheres grow by
    // it and their cones never cull (model wind).
    let swaying = gx_sway_on(gx_row_wind(row));
    let radius = meshlet.bounds.w * scale + gx_sway_reach(row);
    if !sphere_in_view(view, centre, radius) || (!swaying && faces_away(view, row, meshlet)) {
        return false;
    }
    let occlusion = (cull.capacity.w & GX_FLAG_OCCLUSION) != 0u;
    if second_pass() && occlusion {
        return !hiz_occluded(centre, radius);
    }
    return true;
}

// Words of one visibility bitset.
fn visibility_words() -> u32 {
    return (cull.counts.x + 31u) / 32u;
}

// Whether last frame's bitset marks `candidate` (never after a history reset).
fn drawn_last_frame(candidate: u32) -> bool {
    if (cull.capacity.w & GX_FLAG_HISTORY_RESET) != 0u {
        return false;
    }
    let slot = (cull.capacity.w >> GX_HISTORY_PREV_SHIFT) & GX_HISTORY_SLOT_MASK;
    return (visibility[slot * visibility_words() + gx_visibility_word(candidate)] & gx_visibility_mask(candidate)) != 0u;
}

// Whether candidate `candidate` that is `visible` in `view` is kept by this dispatch.
fn kept_now(view: u32, candidate: u32, visible: bool) -> bool {
    let occlusion = (cull.capacity.w & GX_FLAG_OCCLUSION) != 0u;
    if second_pass() {
        return visible && keep[candidate] == 0u;
    }
    if view == 0u && occlusion {
        return visible && drawn_last_frame(candidate);
    }
    return visible;
}

// Dispatch 1 of 3 (blocks × 1 × rows): each candidate's kept triangles (0: not kept), the block's
// kept meshlets and indices, and on pass 2 the next frame's bitset words of the block.
@compute @workgroup_size(256, 1, 1)
fn cull_mark(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
    let candidates = cull.counts.x;
    let row = cull_row(id.z);
    let view = cull_view(id.z);
    let candidate = id.x;
    var kept = 0u;
    var visible = false;
    // A far cascade the frame holds (its cadence) draws nothing: keep no candidate for it.
    let held = !second_pass() && (views.params.w & (1u << view)) != 0u;
    if candidate < candidates {
        if !held {
            let owner = meshlet_instances[meshlet_instance_of(candidate)];
            let meshlet = meshlets[owner.first_meshlet + candidate - owner.first_candidate];
            visible = candidate_visible(view, instances[owner.instance], meshlet);
            if kept_now(view, candidate, visible) {
                kept = meshlet.triangle_count;
            }
        }
        keep[row * candidates + candidate] = kept;
    }
    scan_a[lane] = u32(kept != 0u);
    scan_b[lane] = kept * 3u;
    marks[lane] = select(0u, 1u << (lane & 31u), visible);
    workgroupBarrier();
    var word = 0u;
    if lane < GX_SCAN_BLOCK / 32u {
        for (var i = 0u; i < 32u; i++) {
            word |= marks[lane * 32u + i];
        }
    }
    for (var stride = GX_SCAN_BLOCK / 2u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            scan_a[lane] += scan_a[lane + stride];
            scan_b[lane] += scan_b[lane + stride];
        }
        workgroupBarrier();
    }
    if lane == 0u {
        let at = (row * cull.capacity.z + group.x) * 2u;
        blocks[at] = scan_a[0];
        blocks[at + 1u] = scan_b[0];
    }
    let words = visibility_words();
    let at_word = group.x * (GX_SCAN_BLOCK / 32u) + lane;
    if second_pass() && lane < GX_SCAN_BLOCK / 32u && at_word < words {
        let slot = (cull.capacity.w >> GX_HISTORY_NEXT_SHIFT) & GX_HISTORY_SLOT_MASK;
        visibility[slot * words + at_word] = word;
    }
}

// Inclusive Hillis-Steele scan of `scan_a` and `scan_b` over the workgroup.
fn scan_workgroup(lane: u32) {
    for (var offset = 1u; offset < GX_SCAN_BLOCK; offset <<= 1u) {
        var add_a = 0u;
        var add_b = 0u;
        if lane >= offset {
            add_a = scan_a[lane - offset];
            add_b = scan_b[lane - offset];
        }
        workgroupBarrier();
        scan_a[lane] += add_a;
        scan_b[lane] += add_b;
        workgroupBarrier();
    }
}

// One `DrawIndexedArgs` of `view`'s slot `slot`: `count` indices from `first`, one instance.
fn write_args(view: u32, slot: u32, count: u32, first: u32) {
    let at = (view * GX_ARGS_PER_VIEW + slot) * GX_ARGS_WORDS;
    args[at] = count;
    args[at + 1u] = 1u;
    args[at + 2u] = first;
    args[at + 3u] = 0u;
    args[at + 4u] = 0u;
}

// Dispatch 2 of 3 (1 × 1 × rows): one workgroup scans one row's block sums into exclusive
// prefixes (pass 2's start after pass 1's draws of the camera view), records the row's totals and
// writes the view's indirect arguments.
@compute @workgroup_size(256, 1, 1)
fn cull_scan(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
    let row = cull_row(group.z);
    let view = cull_view(group.z);
    let count = cull.capacity.z;
    let per = (count + GX_SCAN_BLOCK - 1u) / GX_SCAN_BLOCK;
    let first = min(lane * per, count);
    let last = min(first + per, count);
    var sum_a = 0u;
    var sum_b = 0u;
    for (var b = first; b < last; b++) {
        let at = (row * count + b) * 2u;
        sum_a += blocks[at];
        sum_b += blocks[at + 1u];
    }
    scan_a[lane] = sum_a;
    scan_b[lane] = sum_b;
    workgroupBarrier();
    scan_workgroup(lane);
    var base_a = 0u;
    var base_b = 0u;
    if second_pass() {
        base_a = totals[view * 2u];
        base_b = totals[view * 2u + 1u];
    }
    var run_a = base_a + scan_a[lane] - sum_a;
    var run_b = base_b + scan_b[lane] - sum_b;
    for (var b = first; b < last; b++) {
        let at = (row * count + b) * 2u;
        let meshlets_here = blocks[at];
        let indices_here = blocks[at + 1u];
        blocks[at] = run_a;
        blocks[at + 1u] = run_b;
        run_a += meshlets_here;
        run_b += indices_here;
    }
    if lane == GX_SCAN_BLOCK - 1u {
        let kept_meshlets = scan_a[lane];
        let kept_indices = scan_b[lane];
        totals[row * 2u] = kept_meshlets;
        totals[row * 2u + 1u] = kept_indices;
        let start = regions[view].x;
        if second_pass() {
            write_args(view, 1u, kept_indices, start + base_b);
            write_args(view, 2u, base_b + kept_indices, start);
        } else {
            write_args(view, 0u, kept_indices, start);
            write_args(view, 2u, kept_indices, start);
        }
    }
}

// Dispatch 3 of 3 (blocks × 1 × rows): each kept candidate's drawn slot (its block's prefix plus
// its place in the block), then the block's triangles written by the whole workgroup together
// (thread t writes triangles t, t + 256, ...: balanced and adjacent), each finding its meshlet by
// a binary search of the block's index prefix.
@compute @workgroup_size(256, 1, 1)
fn cull_scatter(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
    let candidates = cull.counts.x;
    let row = cull_row(id.z);
    let view = cull_view(id.z);
    let candidate = id.x;
    var kept = 0u;
    if candidate < candidates {
        kept = keep[row * candidates + candidate];
    }
    let flag = u32(kept != 0u);
    let count = kept * 3u;
    scan_a[lane] = flag;
    scan_b[lane] = count;
    workgroupBarrier();
    scan_workgroup(lane);
    let at = (row * cull.capacity.z + group.x) * 2u;
    var triangle_offset = 0u;
    var slot = 0u;
    if kept != 0u {
        slot = regions[view].y + blocks[at] + scan_a[lane] - flag;
        let owner = meshlet_instances[meshlet_instance_of(candidate)];
        let meshlet_row = owner.first_meshlet + candidate - owner.first_candidate;
        drawn[slot] = DrawnMeshlet(owner.instance, meshlet_row);
        triangle_offset = meshlets[meshlet_row].triangle_offset;
    }
    marks[lane] = triangle_offset;
    lane_slots[lane] = slot;
    workgroupBarrier();
    let base = regions[view].x + blocks[at + 1u];
    let block_triangles = scan_b[GX_SCAN_BLOCK - 1u] / 3u;
    for (var t = lane; t < block_triangles; t += GX_SCAN_BLOCK) {
        let first = t * 3u;
        // The lane whose index range holds `first`: the first inclusive prefix past it.
        var lo = 0u;
        var hi = GX_SCAN_BLOCK - 1u;
        while lo < hi {
            let mid = (lo + hi) / 2u;
            if scan_b[mid] > first {
                hi = mid;
            } else {
                lo = mid + 1u;
            }
        }
        var lane_first = 0u;
        if lo > 0u {
            lane_first = scan_b[lo - 1u];
        }
        let local = gx_meshlet_triangle(triangles[marks[lo] + (first - lane_first) / 3u]);
        let owner_slot = lane_slots[lo];
        indices[base + first] = gx_meshlet_index(owner_slot, local.x);
        indices[base + first + 1u] = gx_meshlet_index(owner_slot, local.y);
        indices[base + first + 2u] = gx_meshlet_index(owner_slot, local.z);
    }
}
