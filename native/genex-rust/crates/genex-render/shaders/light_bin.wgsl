// Light binning (graph node 4, RQ6.1; Drobot's tile bitmasks and z-bins). The CPU sorted the
// lights, then the decals, then the probes (one clusterable index space, renderer pass 2 A.0
// LG-16; each kind by its own view depth) and wrote one bounds row per sorted object
// (`light_bounds`, cluster.rs):
// x the tile rectangle's minimum and y its maximum (tile x in the low 16 bits, y in the high),
// z the packed z-bin range it reaches. A rectangle is a column range times a row range, so a
// tile's mask word is its column's word AND its row's word. Three entry points, one pass, no
// atomics: every invocation writes only its own words.
// - `cs_light_axes`: one invocation per (tile column or tile row, mask word) tests 32 lights'
//   ranges and writes that word of `light_axes` (columns first, then rows).
// - `cs_light_bin`: one invocation per mask word (tile-major, from GX_LIGHT_TILES_OFFSET_WORDS of
//   `light_bins`) ANDs its tile's column and row words: bit `i` of word `w` set when sorted
//   object `32 w + i`'s rectangle holds the tile.
// - `cs_light_zbins`: one workgroup per (z-bin, kind) finds the lowest and highest sorted index of
//   an object of that kind whose range holds it; workgroup (0, 0) also writes the header.
// Every value is an integer test on rows the CPU wrote, so the tables equal the CPU reference
// (`LightBinFrame::reference_masks`, `reference_zbins`) bit for bit.

@group(0) @binding(0) var<uniform> bin: LightBinParams;
@group(0) @binding(1) var<storage, read> light_bounds: array<vec4<u32>>;
// The header, every kind's z-bins, then the masks at GX_LIGHT_TILES_OFFSET_WORDS (LG-16).
@group(0) @binding(2) var<storage, read_write> light_bins: array<u32>;
@group(0) @binding(3) var<storage, read_write> light_axes: array<u32>;

// Invocations per workgroup (cluster.rs LIGHT_BIN_WORKGROUP).
const GX_BIN_GROUP: u32 = 64u;
// The bounds row of a light that touches nothing (cluster.rs BOUNDS_EMPTY).
const GX_BOUNDS_EMPTY: vec4<u32> = vec4<u32>(0xffffffffu, 0u, GX_ZBIN_EMPTY, 0u);

// Sorted object `index`'s bounds row; past every binned object, a row that touches nothing.
fn gx_bounds_row(index: u32) -> vec4<u32> {
    if index < bin.ranges.z {
        return light_bounds[index];
    }
    return GX_BOUNDS_EMPTY;
}

// The flat invocation index of a dispatch that may be split over two dimensions.
fn gx_flat_index(group: vec3<u32>, groups: vec3<u32>, local: u32) -> u32 {
    return (group.y * groups.x + group.x) * GX_BIN_GROUP + local;
}

@compute @workgroup_size(64)
fn cs_light_axes(@builtin(workgroup_id) group: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    let index = gx_flat_index(group, groups, local);
    let words = bin.grid.z;
    if index >= (bin.grid.x + bin.grid.y) * words {
        return;
    }
    let line = index / words;
    let word = index % words;
    let column = line < bin.grid.x;
    let at = select(line - bin.grid.x, line, column);
    let shift = select(16u, 0u, column);
    var mask = 0u;
    for (var bit = 0u; bit < 32u; bit++) {
        let row = gx_bounds_row(word * 32u + bit);
        let lowest = (row.x >> shift) & 0xffffu;
        let highest = (row.y >> shift) & 0xffffu;
        if lowest <= at && at <= highest {
            mask |= 1u << bit;
        }
    }
    light_axes[index] = mask;
}

@compute @workgroup_size(64)
fn cs_light_bin(@builtin(workgroup_id) group: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    let index = gx_flat_index(group, groups, local);
    let words = bin.grid.z;
    if index >= bin.grid.x * bin.grid.y * words {
        return;
    }
    let tile = index / words;
    let word = index % words;
    let column = tile % bin.grid.x;
    let row = tile / bin.grid.x;
    light_bins[GX_LIGHT_TILES_OFFSET_WORDS + index] = light_axes[column * words + word] & light_axes[(bin.grid.x + row) * words + word];
}

var<workgroup> zbin_lowest: array<u32, 64>;
var<workgroup> zbin_highest: array<u32, 64>;

// One workgroup per (z-bin, kind): each invocation scans every 64th object of the kind's range,
// then a tree reduction keeps the lowest and highest index.
@compute @workgroup_size(64)
fn cs_light_zbins(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) local: u32) {
    let slice = group.x;
    let kind = group.y;
    let header = slice == 0u && kind == 0u;
    if header && local < 4u {
        light_bins[local] = bin.grid[local];
    } else if header && local < 8u {
        light_bins[local] = bin.depth[local - 4u];
    } else if header && local < 12u {
        light_bins[local] = bin.ranges[local - 8u];
    } else if header && local < GX_LIGHT_BIN_HEADER_WORDS {
        light_bins[local] = bin.kind_depth[local - 12u];
    }
    // The kind's range: lights from 0, each later kind from the previous kind's end.
    var first = 0u;
    if kind > 0u {
        first = bin.ranges[kind - 1u];
    }
    let end = max(bin.ranges[min(kind, 2u)], first);
    var lowest = 0xffffu;
    var highest = 0u;
    for (var index = first + local; index < end; index += GX_BIN_GROUP) {
        let range = light_bounds[index].z;
        if (range & 0xffffu) <= slice && slice <= (range >> GX_ZBIN_INDEX_BITS) {
            lowest = min(lowest, index);
            highest = max(highest, index);
        }
    }
    zbin_lowest[local] = lowest;
    zbin_highest[local] = highest;
    for (var stride = GX_BIN_GROUP / 2u; stride > 0u; stride >>= 1u) {
        workgroupBarrier();
        if local < stride {
            zbin_lowest[local] = min(zbin_lowest[local], zbin_lowest[local + stride]);
            zbin_highest[local] = max(zbin_highest[local], zbin_highest[local + stride]);
        }
    }
    if local == 0u && slice < bin.depth.x {
        // Nothing of the kind: lowest 0xFFFF above highest 0, which packs to GX_ZBIN_EMPTY.
        light_bins[GX_LIGHT_BIN_HEADER_WORDS + kind * GX_LIGHT_ZBINS + slice] = (zbin_lowest[0] & 0xffffu) | (zbin_highest[0] << GX_ZBIN_INDEX_BITS);
    }
}
