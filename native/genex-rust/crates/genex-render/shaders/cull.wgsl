// The GPU-driven cull over (instance, view) (renderer pass 2 A.0, LG-06): the camera, the drawn
// cascades, then the shadowed spots, of the nine views CullViews reserves. Each instance's
// bounding sphere is tested against each active view's frustum by its own invocation, so a batch's
// instances spread over the GPU and the cull's time follows the instances, not the largest batch.
// A deterministic ordered compaction without atomics (our meshlet cull's three dispatches): the
// visible list and the indirect arguments equal the CPU cull's, slot for slot, on every run.
// - `cull_mark` (blocks x views): each block of 256 slots writes its survivors' bits (eight words)
//   and its survivor count into the view's scratch.
// - `cull_scan` (1 x views): one workgroup turns the view's block counts into exclusive prefixes
//   (the total after them), then writes every batch's draw_indexed_indirect arguments: its
//   survivors are the prefix at its end less the prefix at its start.
// - `cull_scatter` (blocks x views): each survivor's slot in its batch's region is its prefix less
//   the prefix at its batch's first row (a binary search of the batches), in row order.
// A far cascade the frame holds (its cadence) draws nothing: all three skip it, so its arguments
// keep what they held.
// Levels of detail (renderer pass 2 A6.9): a mesh with levels has a batch per level, each with
// slots of its own over all of the mesh's rows (`Batch::first_row`); `cull_mark` keeps an
// instance only in the batch of the level the camera's distance picks (`gx_cull_lod_fade`,
// mesh_lod.rs `lod_row_keep`), in every view. The three dispatches run over slots: without levels
// a slot is its row.
// The fade band (game systems LOD-02, LOD-03): an instance's level is measured from its LOD row
// (`lod_rows`: the sphere its levels are measured from and its bias), and with a band (`beta`,
// `views.lod_params.y`) a level's fade batch keeps the instances fading in or out of it
// (`gx_cull_lod_fade`, mesh_lod.rs `lod_row_keep`); `cull_scatter` writes each fade-batch
// survivor's fade into `fades`, slot for slot with the visible list, and no other slot.
// The far field (game systems LOD-18): a copy whose LOD row names a far rule (`far_rules`) and
// lies past its start is thinned (`gx_far_field`): its whole batches drop it, its fade batches
// keep it with the far share in its fade and the far field's grow beside it.
// Impostors (game systems LOD-15): an impostor is the last level of its chain (`GX_LOD_IMPOSTOR_TAG`),
// its error measured over the LOD row's radius so every part of a compound switches together. In
// every view but the camera (option A) a band at the impostor level reads as the last mesh level
// whole: the casters keep the mesh's shape where the camera draws the impostor.
// Instance occlusion (horde 10k, occlusion.rs): `occ` names the dispatch's phase and its first
// view (a single-view dispatch is `group.y` 0 plus `occ.params.y`). Phase 1 (`History`, every
// view) keeps, in each occluded cascade with a usable history, only the rows the cascade saw last
// frame (`occ_history`, through each row's last-frame row); phase 2 (`Second`, one cascade, after
// its first draws and their Hi-Z) re-tests every kept row against the Hi-Z, writes the next
// frame's history and keeps those visible that phase 1 did not; phase 3 (`Final`, the camera,
// after the whole prepass and its Hi-Z) keeps the rows the Hi-Z does not hide. The Hi-Z holds the
// farthest depth of what was drawn, so a row it hides would have lost every depth test: the
// pictures and the maps are the ones without occlusion, and the history only decides what draws
// early.

@group(0) @binding(0) var<uniform> views: CullViews;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> batches: array<Batch>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<DrawIndexedArgs>;
// Per active view (cull::scratch_words_per_view): the survivor bits of every block (eight words a
// block), then each block's exclusive prefix and the view's total.
@group(0) @binding(5) var<storage, read_write> scratch: array<u32>;

// One opaque instance row's level-of-detail inputs (lod_rows.rs `GpuLodRow`).
struct LodRow {
    // The world sphere its levels are measured from (xyz, radius).
    origin: vec4<f32>,
    // Every projected error of its chain is scaled by this (2: each level held twice as far).
    bias: f32,
    // Its far rule (0: none; else 1 + its index in `far_rules`, LOD-18).
    far_rule: u32,
    spare0: u32,
    spare1: u32,
}

// Row for row with the opaque instance rows (lod_rows.rs CULL_LOD_ROWS_BINDING).
@group(0) @binding(6) var<storage, read> lod_rows: array<LodRow>;
// Per active view, slot for slot with the visible list: (fade, grow) of each fade-batch survivor
// (layout.rs FRAME_INSTANCE_FADE_BINDING, cull.rs CULL_FADES_BINDING).
@group(0) @binding(7) var<storage, read_write> fades: array<vec2<f32>>;

// One far rule (lod_rows.rs `GpuFarRule`, game systems LOD-18): past `start` the copies thin to
// an expected share of `keep` at `end`, then fade out over `fade_out` (0: kept to the horizon).
struct FarRule {
    start: f32,
    end: f32,
    keep: f32,
    fade_out: f32,
}

// lod_rows.rs FAR_RULES_MAX rules; the frame's count is `views.lod_params.z`, and the plan zeroes
// a rule `far_rule_usable` refuses (a zero rule leaves its copies alone).
struct FarRules {
    rules: array<FarRule, 16>,
}

// The frame's far rules (lod_rows.rs CULL_FAR_RULES_BINDING); a row's rule k is rules[k - 1].
@group(0) @binding(8) var<uniform> far_rules: FarRules;

// One cull dispatch's occlusion (occlusion.rs `GpuOcclusionCull`).
struct OcclusionCull {
    // x: the phase (0 frustum only, 1 history, 2 second pass, 3 final); y: the dispatch's first
    // view; z: bit v, view v's history is usable; w: bit v, view v is occluded this frame.
    params: vec4<u32>,
    // x: the history slot read, y: the slot written; z: the rows each view's history holds (its
    // stride); w: 1 when the Hi-Z's depth is reversed.
    history: vec4<u32>,
    // The Hi-Z: x, y its mip 0 size, z its mips.
    hiz: vec4<u32>,
    // x, y: the depth the Hi-Z was built from, in pixels.
    render: vec4<f32>,
    // The tested view's projection × view.
    view_proj: mat4x4<f32>,
}

@group(0) @binding(9) var<uniform> occ: OcclusionCull;
// The tested view's Hi-Z (a 1 x 1 texel while no phase reads it).
@group(0) @binding(10) var occ_hiz: texture_2d<f32>;
// occlusion.rs layout: each row's last-frame row (`stride` words, NO_ROW none), then the history
// slots, each `GX_OCC_VIEWS` regions of `stride` words (1: the view saw the row), then each view's
// counts of the rows its Hi-Z phase tested and found visible (what tells the renderer it pays).
@group(0) @binding(11) var<storage, read_write> occ_history: array<atomic<u32>>;

// occlusion.rs `OcclusionPhase`, `OCCLUSION_VIEWS` and `NO_ROW`.
const GX_OCC_HISTORY: u32 = 1u;
const GX_OCC_SECOND: u32 = 2u;
const GX_OCC_FINAL: u32 = 3u;
const GX_OCC_VIEWS: u32 = 5u;
const GX_OCC_NO_ROW: u32 = 0xffffffffu;
// History slots (occlusion.rs `HISTORY_SLOTS`): the counts follow them.
const GX_OCC_SLOTS: u32 = 3u;

// A Hi-Z phase's tested and visible rows of this workgroup, added to the view's counts once.
var<workgroup> occ_tested: atomic<u32>;
var<workgroup> occ_visible: atomic<u32>;
// A corner whose clip w is at or below this is at the eye: the bounds are never hidden.
const GX_OCC_MIN_W: f32 = 1.0e-5;

// The view a dispatch's workgroup row `y` culls.
fn gx_cull_view(y: u32) -> u32 {
    return y + occ.params.y;
}

fn gx_occ_bit(mask: u32, view: u32) -> bool {
    return view < 32u && ((mask >> view) & 1u) != 0u;
}

// Word of view `view`'s history for `row` in history slot `slot`.
fn gx_occ_at(slot: u32, view: u32, row: u32) -> u32 {
    return occ.history.z * (1u + slot * GX_OCC_VIEWS + view) + row;
}

// Whether phase 1 draws `row` in `view`: its last-frame row was seen there, or nothing is known.
fn gx_occ_drawn_early(view: u32, row: u32) -> bool {
    if !gx_occ_bit(occ.params.z, view) || row >= occ.history.z {
        return true;
    }
    let prev = atomicLoad(&occ_history[row]);
    if prev == GX_OCC_NO_ROW || prev >= occ.history.z {
        return true;
    }
    return atomicLoad(&occ_history[gx_occ_at(occ.history.x, view, prev)]) != 0u;
}

// Whether the world sphere (`centre`, `radius`) lies wholly behind the Hi-Z of the tested view:
// its box's eight corners give a pixel rectangle (widened by a pixel each way: the depth was drawn
// jittered) and the nearest depth; the mip where the rectangle spans at most two texels each way
// holds, in four texels, the farthest depth of every pixel it covers (hiz.rs). Conservative: a
// box reaching the eye plane or the near plane is visible. meshlet_cull.wgsl `hiz_occluded`'s test.
fn gx_occ_hidden(centre: vec3<f32>, radius: f32) -> bool {
    let reversed = occ.history.w == 1u;
    var lo = vec2<f32>(1.0e30);
    var hi = vec2<f32>(-1.0e30);
    var nearest = 1.0e30;
    if reversed {
        nearest = -1.0e30;
    }
    for (var i = 0u; i < 8u; i++) {
        let side = vec3<f32>(select(-1.0, 1.0, (i & 1u) != 0u), select(-1.0, 1.0, (i & 2u) != 0u), select(-1.0, 1.0, (i & 4u) != 0u));
        let clip = occ.view_proj * vec4<f32>(centre + side * radius, 1.0);
        if clip.w <= GX_OCC_MIN_W {
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
    let render = occ.render.xy;
    let last = render - 1.0;
    let xs = (vec2<f32>(lo.x, hi.x) * 0.5 + 0.5) * render.x + vec2<f32>(-1.0, 1.0);
    let ys = (0.5 - vec2<f32>(hi.y, lo.y) * 0.5) * render.y + vec2<f32>(-1.0, 1.0);
    let p0 = vec2<u32>(clamp(floor(vec2<f32>(xs.x, ys.x)), vec2<f32>(0.0), last));
    let p1 = vec2<u32>(clamp(floor(vec2<f32>(xs.y, ys.y)), vec2<f32>(0.0), last));
    var level = 0u;
    var t0 = vec2<u32>(0u);
    var t1 = vec2<u32>(0u);
    loop {
        let size = textureDimensions(occ_hiz, level);
        t0 = min(p0 >> vec2<u32>(level + 1u), size - 1u);
        t1 = min(p1 >> vec2<u32>(level + 1u), size - 1u);
        if (t1.x - t0.x <= 1u && t1.y - t0.y <= 1u) || level + 1u >= occ.hiz.z {
            break;
        }
        level += 1u;
    }
    let depths = vec4<f32>(
        textureLoad(occ_hiz, t0, i32(level)).x,
        textureLoad(occ_hiz, vec2<u32>(t1.x, t0.y), i32(level)).x,
        textureLoad(occ_hiz, vec2<u32>(t0.x, t1.y), i32(level)).x,
        textureLoad(occ_hiz, t1, i32(level)).x,
    );
    let farthest = gx_hiz_reduce(depths, occ.history.w);
    if reversed {
        return nearest < farthest;
    }
    return nearest > farthest;
}

// Whether the occlusion phase keeps `row` of `view`, which the frustum and its level kept, of
// world sphere `bounds` grown by `grow` (the far field's). Phase 2 also writes the next history.
fn gx_occ_keeps(view: u32, row: u32, bounds: vec4<f32>, grow: f32) -> bool {
    let phase = occ.params.x;
    if !gx_occ_bit(occ.params.w, view) || phase == 0u {
        return true;
    }
    if phase == GX_OCC_HISTORY {
        return gx_occ_drawn_early(view, row);
    }
    let visible = !gx_occ_hidden(bounds.xyz, bounds.w * max(grow, 1.0));
    atomicAdd(&occ_tested, 1u);
    if visible {
        atomicAdd(&occ_visible, 1u);
    }
    if phase == GX_OCC_FINAL {
        return visible;
    }
    if visible && row < occ.history.z {
        atomicStore(&occ_history[gx_occ_at(occ.history.y, view, row)], 1u);
    }
    return visible && !gx_occ_drawn_early(view, row);
}

// Word of view `view`'s tested (`which` 0) or visible (1) count.
fn gx_occ_count_at(view: u32, which: u32) -> u32 {
    return occ.history.z * (1u + GX_OCC_SLOTS * GX_OCC_VIEWS) + view * 2u + which;
}

// lod_rows.rs FAR_FADE_BAND (the grass's grow-in band), FAR_GROW_MAX and the hash's cells a unit.
const GX_FAR_FADE_BAND: f32 = 0.15;
const GX_FAR_GROW_MAX: f32 = 2.0;
const GX_FAR_HASH_CELLS: f32 = 100.0;

// lod_rows.rs `far_hash`: the copy's sphere centre on a 1 cm grid, hashed, in [0, 1).
fn gx_far_hash(origin: vec4<f32>) -> f32 {
    let cell = vec3<u32>(vec3<i32>(floor(origin.xyz * GX_FAR_HASH_CELLS + 0.5)));
    var h = (cell.x * 0x8da6b343u) ^ (cell.y * 0xd8163841u) ^ (cell.z * 0xcb1ab31fu);
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return f32(h >> 8u) / 16777216.0;
}

// lod_rows.rs `far_threshold`: the keep threshold whose expected drawn share is `density`.
fn gx_far_threshold(density: f32) -> f32 {
    let b = GX_FAR_FADE_BAND;
    let room = 2.0 * b * (1.0 - b);
    let upper = 1.0 - b / (2.0 * (1.0 - b));
    let lower = b / (2.0 * (1.0 - b));
    if density >= upper {
        return 1.0 - sqrt(room * (1.0 - density));
    }
    if density >= lower {
        return density * (1.0 - b) + 0.5 * b;
    }
    return sqrt(room * density);
}

// lod_rows.rs `far_field`, expression for expression: x 1 when the copy is thinned (past its
// rule's start), y its share of pixels drawn (0: thinned away), z its grow about its origin.
fn gx_far_field(lod_row: LodRow) -> vec3<f32> {
    let near = vec3<f32>(0.0, 1.0, 1.0);
    if lod_row.far_rule == 0u || lod_row.far_rule > views.lod_params.z {
        return near;
    }
    let rule = far_rules.rules[lod_row.far_rule - 1u];
    let usable = rule.start >= 0.0 && rule.end > rule.start && rule.keep > 0.0 && rule.keep <= 1.0 && rule.fade_out >= 0.0;
    if !usable {
        return near;
    }
    let offset = lod_row.origin.xyz - views.lod.xyz;
    let distance = sqrt(offset.x * offset.x + offset.y * offset.y + offset.z * offset.z);
    let past_start = distance > rule.start && distance <= 0x1.fffffep+127f;
    if !past_start {
        return near;
    }
    let t = clamp((distance - rule.start) / (rule.end - rule.start), 0.0, 1.0);
    let eased = t * t * (3.0 - 2.0 * t);
    let density = 1.0 + (rule.keep - 1.0) * eased;
    let grow = min(1.0 / sqrt(density), GX_FAR_GROW_MAX);
    var threshold = gx_far_threshold(density);
    if rule.fade_out > 0.0 && distance > rule.end {
        threshold *= max(1.0 - (distance - rule.end) / rule.fade_out, 0.0);
    }
    if !(threshold > 0.0) {
        return vec3<f32>(1.0, 0.0, grow);
    }
    let hashed = gx_far_hash(lod_row.origin) * (1.0 - GX_FAR_FADE_BAND);
    let share = clamp((threshold - hashed) / GX_FAR_FADE_BAND, 0.0, 1.0);
    return vec3<f32>(1.0, share, grow);
}

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

// The batch holding slot `row`: the last batch whose first slot is at most it.
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

// The LOD tag's bit marking a batch that draws one level of a chain (mesh_lod.rs LOD_TAG).
const GX_LOD_TAG: u32 = 0x80000000u;
// A fade batch's bit (mesh_lod.rs LOD_FADE_TAG): without a band it keeps nothing.
const GX_LOD_FADE_TAG: u32 = 0x40000000u;
// A chain whose levels the CPU planned for the draw (mesh_lod.rs LOD_PLANNED_TAG: a skinned band,
// only its levels skinned), which no shadow view casts coarser (lane FQ).
const GX_LOD_PLANNED_TAG: u32 = 0x10000000u;
// A chain ended by an impostor (mesh_lod.rs LOD_IMPOSTOR_TAG, game systems LOD-15).
const GX_LOD_IMPOSTOR_TAG: u32 = 0x20000000u;

// The value of the non-negative, finite half float `bits` (mesh_lod.rs `f16_value`, exact):
// decoded by hand, since naga counts `unpack2x16float` outside WebGPU core.
fn gx_cull_half(bits: u32) -> f32 {
    let exponent = (bits >> 10u) & 31u;
    let mantissa = bits & 1023u;
    if exponent == 0u {
        return f32(mantissa) * (1.0 / 16777216.0);
    }
    return bitcast<f32>(((exponent + 112u) << 23u) | (mantissa << 13u));
}

// Whether `batch` keeps its instance row `row` of world sphere `bounds`, and the fade its
// slot gets: x 1 when kept, y the signed fade (1 whole), z the grow (1 unthinned). A batch
// without levels keeps every instance whole; a level's batch the instances whole at its level;
// its fade twin those fading in to it (-share) or out of it to the next coarser level
// (1 - share), measured from the row's LOD row (read only for a level's batch). Levels off
// (`lod.w` not positive) or a radius that is not positive draw the mesh itself whole. With far
// rules (`views.lod_params.z`, game systems LOD-18) a copy past its rule's start is thinned:
// every whole batch drops it and its fade batches keep it, the fade times the far share and the
// grow the far field's (`gx_far_field`). A sun cascade (`caster_error` positive, lane FQ) casts
// the coarsest mesh level within that world error whole where it is coarser than the camera's
// band (`gx_cull_caster_level`). In a shadow view (`caster`, every view but the camera)
// a chain ended by an impostor casts its last mesh level whole where the camera's band is at the
// impostor (game systems LOD-15 option A). mesh_lod.rs `lod_row_keep_view` is its CPU twin,
// expression for expression.
fn gx_cull_lod_fade(batch: Batch, bounds: vec4<f32>, row: u32, caster: bool, caster_error: f32) -> vec3<f32> {
    var far = vec3<f32>(0.0, 1.0, 1.0);
    if views.lod_params.z != 0u {
        far = gx_far_field(lod_rows[row]);
    }
    let tagged = (batch.lod & GX_LOD_TAG) != 0u;
    let fade = tagged && (batch.lod & GX_LOD_FADE_TAG) != 0u;
    if far.x > 0.0 && (!fade || !(far.y > 0.0)) {
        return vec3<f32>(0.0, 1.0, 1.0);
    }
    if !tagged {
        return vec3<f32>(1.0, 1.0, 1.0);
    }
    let level = batch.lod & 15u;
    var band = vec2<f32>(0.0, 1.0);
    if views.lod.w > 0.0 && bounds.w > 0.0 {
        let levels = min((batch.lod >> 4u) & 15u, 4u);
        let halves = vec4<u32>(batch.lod_error01 & 0xFFFFu, batch.lod_error01 >> 16u, batch.lod_error23 & 0xFFFFu, batch.lod_error23 >> 16u);
        var errors = vec4<f32>(gx_cull_half(halves.x), gx_cull_half(halves.y), gx_cull_half(halves.z), gx_cull_half(halves.w)) * bounds.w;
        let lod_row = lod_rows[row];
        let impostor = (batch.lod & GX_LOD_IMPOSTOR_TAG) != 0u && levels > 0u;
        if impostor {
            errors[levels - 1u] = gx_cull_half(halves[levels - 1u]) * lod_row.origin.w;
        }
        let distance = length(lod_row.origin.xyz - views.lod.xyz) - lod_row.origin.w;
        band = gx_lod_band(errors, levels, distance, views.lod.w, 1.0, lod_row.bias, bitcast<f32>(views.lod_params.y));
        if caster && impostor && u32(band.x) >= levels {
            band = vec2<f32>(f32(levels - 1u), 1.0);
        }
        // A sun cascade casts the coarsest mesh level its map cannot tell apart (lane FQ), whole,
        // when that is coarser than the camera's.
        let planned = (batch.lod & GX_LOD_PLANNED_TAG) != 0u;
        let floor = gx_cull_caster_level(errors, select(levels, levels - 1u, impostor), select(caster_error, 0.0, planned));
        if floor > u32(band.x) {
            band = vec2<f32>(f32(floor), 1.0);
        }
    }
    let picked = u32(band.x);
    if far.x > 0.0 {
        if band.y >= 1.0 {
            return vec3<f32>(select(0.0, 1.0, level == picked), far.y, far.z);
        }
        if level == picked {
            return vec3<f32>(1.0, -band.y * far.y, far.z);
        }
        return vec3<f32>(select(0.0, 1.0, level + 1u == picked), (1.0 - band.y) * far.y, far.z);
    }
    if band.y >= 1.0 {
        return vec3<f32>(select(0.0, 1.0, !fade && level == picked), 1.0, 1.0);
    }
    if !fade {
        return vec3<f32>(0.0, 1.0, 1.0);
    }
    if level == picked {
        return vec3<f32>(1.0, -band.y, 1.0);
    }
    return vec3<f32>(select(0.0, 1.0, level + 1u == picked), 1.0 - band.y, 1.0);
}

// The world error view `view`'s casters may show (lane FQ, `views.shadow_lod`): a sun cascade's,
// 0 for the camera and the shadowed spots (their lanes are 0).
fn gx_cull_caster_error(view: u32) -> f32 {
    if view == 0u || view > 4u {
        return 0.0;
    }
    return views.shadow_lod[view - 1u];
}

// The coarsest of the first `mesh_levels` levels whose world error (`errors`) is within
// `allowed` (0: none, the mesh itself). mesh_lod.rs `caster_level` is its CPU twin.
fn gx_cull_caster_level(errors: vec4<f32>, mesh_levels: u32, allowed: f32) -> u32 {
    var level = 0u;
    if !(allowed > 0.0) {
        return level;
    }
    for (var k = 0u; k < min(mesh_levels, 4u); k++) {
        if errors[k] <= allowed {
            level = k + 1u;
        }
    }
    return level;
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
    let view = gx_cull_view(group.y);
    if gx_cull_held(view) {
        return;
    }
    if lane == 0u {
        atomicStore(&occ_tested, 0u);
        atomicStore(&occ_visible, 0u);
    }
    workgroupBarrier();
    let slot = group.x * GX_CULL_BLOCK + lane;
    var keep = 0u;
    if slot < views.params.x {
        // Without levels a slot is its row; with them its batch says which row it holds.
        var row = slot;
        var lod_keeps = true;
        var grow = 1.0;
        if views.lod_params.x != 0u {
            let batch = batches[gx_cull_batch_of(slot)];
            row = batch.first_row + slot - batch.first_instance;
            let kept = gx_cull_lod_fade(batch, instances[row].bounds, row, view != 0u, gx_cull_caster_error(view));
            lod_keeps = kept.x > 0.0;
            grow = kept.z;
        }
        let bounds = instances[row].bounds;
        if lod_keeps && in_frustum(view, bounds) && gx_occ_keeps(view, row, bounds, grow) {
            keep = 1u;
        }
    }
    scan[lane] = keep << (lane % 32u);
    workgroupBarrier();
    // A Hi-Z phase's counts (occlusion.rs `OcclusionFeedback`): one add per workgroup.
    if lane == 0u && occ.params.x >= GX_OCC_SECOND && gx_occ_bit(occ.params.w, view) && view < GX_OCC_VIEWS {
        atomicAdd(&occ_history[gx_occ_count_at(view, 0u)], atomicLoad(&occ_tested));
        atomicAdd(&occ_history[gx_occ_count_at(view, 1u)], atomicLoad(&occ_visible));
    }
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
    let view = gx_cull_view(group.y);
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
    let view = gx_cull_view(group.y);
    if gx_cull_held(view) {
        return;
    }
    let own = group.x * GX_CULL_BLOCK + lane;
    var keep = 0u;
    if own < views.params.x {
        let word = scratch[gx_cull_base(view) + group.x * GX_CULL_BLOCK_WORDS + lane / 32u];
        keep = (word >> (lane % 32u)) & 1u;
    }
    scan[lane] = keep;
    workgroupBarrier();
    gx_cull_scan_workgroup(lane);
    if keep == 1u {
        let survivor = scratch[gx_cull_prefix_at(view) + group.x] + scan[lane] - 1u;
        let batch = batches[gx_cull_batch_of(own)];
        let slot = batch.first_instance + survivor - gx_cull_survivors_before(view, batch.first_instance);
        // The survivor's instance row: the row its own slot `own` stands for in its batch.
        let row = batch.first_row + own - batch.first_instance;
        visible[view * views.params.x + slot] = row;
        // A fade batch's survivor gets its fade (LOD-03) and its far field's grow (LOD-18).
        if (batch.lod & GX_LOD_FADE_TAG) != 0u {
            let kept = gx_cull_lod_fade(batch, instances[row].bounds, row, view != 0u, gx_cull_caster_error(view));
            fades[view * views.params.x + slot] = kept.yz;
        }
    }
}
