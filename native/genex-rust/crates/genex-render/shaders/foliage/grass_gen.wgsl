// The grass's generation (renderer pass 2 A.8; `foliage::plan` is its CPU twin), three compute
// passes over a camera-centred square of tiles of GX_GRASS_TILE_SIDE² cells:
//
// - `cs_grass_tiles` (tiles x tiles workgroups): a tile past the radius or outside the camera's
//   frustum keeps nothing; elsewhere each lane hashes its global cell into a candidate (jitter,
//   which layer from the four control texels around it, the keep threshold against the cell's
//   probability), reads the ground's height and tests the blade's sphere against the frustum. The
//   survivors are compacted in cell order by a workgroup prefix sum into the tile's own region, and
//   the tile's count is stored.
// - `cs_grass_scan` (one workgroup): the tile counts into exclusive offsets and the indirect draw's
//   arguments (vertices a blade, blades drawn).
// - `cs_grass_pack` (tiles x tiles): each kept blade's region index at its offset, the order the
//   draws read.
//
// No atomics: the drawn list is a pure function of the camera and the terrain, as every renderer
// cull is. Group 0 is the generation's own, group 1 empty, group 2 the terrain's
// (terrain_core.wgsl: its row and its maps).

@group(0) @binding(0) var<uniform> gx_grass: GxGrass;
@group(0) @binding(1) var<storage, read_write> gx_grass_regions: array<vec4<u32>>;
// Each tile's count, then each tile's offset.
@group(0) @binding(2) var<storage, read_write> gx_grass_tiles: array<u32>;
// The indirect draw: vertex count, instance count, first vertex, first instance.
@group(0) @binding(3) var<storage, read_write> gx_grass_args: array<u32, 4>;
@group(0) @binding(4) var<storage, read_write> gx_grass_order: array<u32>;

var<workgroup> gx_grass_scan: array<u32, 256>;

// Inclusive Hillis-Steele scan of `gx_grass_scan` over the workgroup.
fn gx_grass_scan_workgroup(lane: u32) {
    for (var offset = 1u; offset < GX_GRASS_TILE_CELLS; offset <<= 1u) {
        var add = 0u;
        if lane >= offset {
            add = gx_grass_scan[lane - offset];
        }
        workgroupBarrier();
        gx_grass_scan[lane] += add;
        workgroupBarrier();
    }
}

// The cell side.
fn gx_grass_cell() -> f32 {
    return gx_grass.cell.x;
}

// Whether tile `tile` of the square may hold a drawn blade (`foliage::tile_visible`).
fn gx_grass_tile_visible(tile: vec2<u32>) -> bool {
    let cell = gx_grass_cell();
    let side = cell * f32(GX_GRASS_TILE_SIDE);
    let first = vec2<f32>(gx_grass.grid.xy) * cell + vec2<f32>(tile) * side;
    let low = gx_grass.cell.z - GX_GRASS_ROOT_SINK;
    let high = gx_grass.cell.w + GX_GRASS_HEIGHT_MAX;
    let centre = vec3<f32>(first.x + side * 0.5, (low + high) * 0.5, first.y + side * 0.5);
    let half = vec3<f32>(side * 0.5, (high - low) * 0.5, side * 0.5);
    let camera = gx_grass.camera.xyz;
    let nearest = vec2<f32>(abs(camera.x - centre.x) - half.x, abs(camera.z - centre.z) - half.z);
    let reach = sqrt(max(nearest.x, 0.0) * max(nearest.x, 0.0) + max(nearest.y, 0.0) * max(nearest.y, 0.0));
    if reach > gx_grass.camera.w {
        return false;
    }
    for (var p = 0u; p < 6u; p++) {
        let plane = gx_grass.planes[p];
        let extent = abs(plane.x) * half.x + abs(plane.y) * half.y + abs(plane.z) * half.z;
        if plane.x * centre.x + plane.y * centre.y + plane.z * centre.z + plane.w < -extent {
            return false;
        }
    }
    return true;
}

// The blades per square metre of layer `layer`.
fn gx_grass_density(layer: u32) -> f32 {
    return gx_grass.layers[min(layer, GX_GRASS_LAYERS - 1u)].shape.x;
}

// The blades per square metre at world `xz` and the layer a `pick` (0..1) of them grows from: the
// four control texels around it, each texel's base and overlay in a fixed order
// (`GrassField::density_at`).
struct GxGrassDensity {
    total: f32,
    layer: u32,
}

fn gx_grass_density_at(xz: vec2<f32>, pick: f32) -> GxGrassDensity {
    let last = vec2<f32>(gx_terrain.size.xy - vec2<u32>(1u));
    let p = clamp((xz - gx_terrain.origin.xy) / gx_terrain.origin.z, vec2<f32>(0.0), last);
    let base = floor(p);
    let f = p - base;
    let i = vec2<u32>(base);
    let layers = max(gx_terrain.counts.x, 1u);
    var ids: array<u32, 8>;
    var weights: array<f32, 8>;
    var total = 0.0;
    for (var c = 0u; c < 4u; c++) {
        let corner = vec2<u32>(c & 1u, c >> 1u);
        let at = i + corner;
        let word = gx_terrain_maps[gx_terrain.size.z + gx_terrain_index(at.x, at.y)];
        let along = select(1.0 - f, f, corner == vec2<u32>(1u));
        let weight = along.x * along.y;
        let overlay = f32((word >> 10u) & 0xffu) / 255.0;
        ids[2u * c] = min(word & 31u, layers - 1u);
        weights[2u * c] = weight * (1.0 - overlay);
        ids[2u * c + 1u] = min((word >> 5u) & 31u, layers - 1u);
        weights[2u * c + 1u] = weight * overlay;
    }
    for (var k = 0u; k < 8u; k++) {
        total += weights[k] * gx_grass_density(ids[k]);
    }
    let target_share = pick * total;
    var run = 0.0;
    var chosen = ids[0];
    for (var k = 0u; k < 8u; k++) {
        let share = weights[k] * gx_grass_density(ids[k]);
        if share <= 0.0 {
            continue;
        }
        chosen = ids[k];
        run += share;
        if target_share < run {
            break;
        }
    }
    return GxGrassDensity(total, chosen);
}

// A cell's candidate: whether a blade grows there and is in view, and its record.
struct GxGrassCandidate {
    keep: bool,
    record: vec4<u32>,
}

// The blade of global cell `cell` (`GrassField::blade`, then the frustum's sphere test).
fn gx_grass_candidate(cell: vec2<i32>) -> GxGrassCandidate {
    var out = GxGrassCandidate(false, vec4<u32>(0u));
    let size = gx_grass_cell();
    let wx = (f32(cell.x) + gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_JITTER_X)) * size;
    let wz = (f32(cell.y) + gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_JITTER_Z)) * size;
    let spacing = gx_terrain.origin.z;
    let span = vec2<f32>(gx_terrain.size.xy - vec2<u32>(1u)) * spacing;
    let origin = gx_terrain.origin.xy;
    let inside = wx >= origin.x && wz >= origin.y && wx <= origin.x + span.x && wz <= origin.y + span.y;
    if !inside {
        return out;
    }
    let ground = gx_terrain_height((vec2<f32>(wx, wz) - origin) / spacing);
    let to = vec3<f32>(wx, ground, wz) - gx_grass.camera.xyz;
    let distance = sqrt(to.x * to.x + to.y * to.y + to.z * to.z);
    let density = gx_grass_density_at(vec2<f32>(wx, wz), gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_LAYER));
    let base = density.total * size * size * gx_grass.cell.y;
    let probability = min(base * gx_grass_distance_share(distance, gx_grass.camera.w), 1.0);
    let threshold = gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_KEEP);
    if threshold >= probability {
        return out;
    }
    let grown = min((probability - threshold) / (GX_GRASS_FADE_BAND * max(base, 1e-6)), 1.0);
    let layer = gx_grass.layers[density.layer];
    if layer.shape.x <= 0.0 {
        return out;
    }
    let tall = gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_TALL);
    let full = layer.shape.y + (layer.shape.z - layer.shape.y) * tall;
    let height = u32(min(full * grown / GX_GRASS_HEIGHT_MAX, 1.0) * 4095.0 + 0.5);
    let roll = gx_grass_unit(cell.x, cell.y, GX_GRASS_SALT_KIND);
    var kind = GX_GRASS_GREEN;
    if roll < layer.width.w {
        kind = GX_GRASS_FLOWER;
    } else if roll < layer.width.w + layer.width.z {
        kind = GX_GRASS_DRY;
    }
    let root = vec3<f32>(wx, ground - GX_GRASS_ROOT_SINK, wz);
    // The blade's sphere against the frustum (its tallest extent and the widest blade).
    let blade_height = f32(height) / 4095.0 * GX_GRASS_HEIGHT_MAX;
    let centre = vec3<f32>(root.x, root.y + blade_height * 0.5, root.z);
    let radius = blade_height * 0.5 + GX_GRASS_WIDTH_MAX;
    for (var p = 0u; p < 6u; p++) {
        let plane = gx_grass.planes[p];
        if dot(plane.xyz, centre) + plane.w < -radius {
            return out;
        }
    }
    let yaw = gx_grass_hash(cell.x, cell.y, GX_GRASS_SALT_YAW) >> 24u;
    let packed = yaw | (density.layer << 8u) | (kind << 12u) | (u32(grown * 63.0 + 0.5) << 14u) | (height << 20u);
    out.keep = true;
    out.record = vec4<u32>(bitcast<vec3<u32>>(root), packed);
    return out;
}

@compute @workgroup_size(256)
fn cs_grass_tiles(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let tiles = u32(gx_grass.grid.z);
    let tile = group.y * tiles + group.x;
    var keep = 0u;
    var record = vec4<u32>(0u);
    if gx_grass_tile_visible(group.xy) {
        let local = vec2<u32>(lane % GX_GRASS_TILE_SIDE, lane / GX_GRASS_TILE_SIDE);
        let cell = gx_grass.grid.xy + vec2<i32>(group.xy * GX_GRASS_TILE_SIDE + local);
        let candidate = gx_grass_candidate(cell);
        keep = select(0u, 1u, candidate.keep);
        record = candidate.record;
    }
    gx_grass_scan[lane] = keep;
    workgroupBarrier();
    gx_grass_scan_workgroup(lane);
    if keep == 1u {
        gx_grass_regions[tile * GX_GRASS_TILE_CELLS + gx_grass_scan[lane] - 1u] = record;
    }
    if lane == GX_GRASS_TILE_CELLS - 1u {
        gx_grass_tiles[tile] = gx_grass_scan[lane];
    }
}

@compute @workgroup_size(256)
fn cs_grass_scan(@builtin(local_invocation_index) lane: u32) {
    let tiles = u32(gx_grass.grid.z) * u32(gx_grass.grid.z);
    let per = (tiles + GX_GRASS_TILE_CELLS - 1u) / GX_GRASS_TILE_CELLS;
    let first = min(lane * per, tiles);
    let last = min(first + per, tiles);
    var sum = 0u;
    for (var t = first; t < last; t++) {
        sum += gx_grass_tiles[t];
    }
    gx_grass_scan[lane] = sum;
    workgroupBarrier();
    gx_grass_scan_workgroup(lane);
    var run = gx_grass_scan[lane] - sum;
    for (var t = first; t < last; t++) {
        gx_grass_tiles[tiles + t] = run;
        run += gx_grass_tiles[t];
    }
    if lane == GX_GRASS_TILE_CELLS - 1u {
        gx_grass_args[0] = u32(gx_grass.grid.w);
        gx_grass_args[1] = gx_grass_scan[lane];
        gx_grass_args[2] = 0u;
        gx_grass_args[3] = 0u;
    }
}

@compute @workgroup_size(256)
fn cs_grass_pack(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    let tiles = u32(gx_grass.grid.z);
    let tile = group.y * tiles + group.x;
    if lane < gx_grass_tiles[tile] {
        gx_grass_order[gx_grass_tiles[tiles * tiles + tile] + lane] = tile * GX_GRASS_TILE_CELLS + lane;
    }
}
