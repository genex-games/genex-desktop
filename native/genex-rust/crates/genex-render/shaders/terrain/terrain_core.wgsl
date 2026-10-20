// Heightmap terrain (renderer pass 2 A.7; `terrain/mod.rs`): the terrain group (group 2) and the
// CDLOD vertex (Filip Strugar, `fstrugar/CDLOD`, MIT) every terrain entry point shares, the forward,
// prepass, motion and sun-caster ones alike, so their positions agree bit for bit.
//
// A drawn node is one instance of a grid of GX_TERRAIN_GRID² quads (`terrain::grid_indices`): the
// vertex index names its grid vertex, the instance its row. A vertex reads its height from the
// storage table (16-bit samples, two to a word: WebGPU core cannot filter 32-bit floats, so the
// height is read by sample and filtered here), measures its distance to the camera, and slides
// onto its even neighbour as the level's morph completes (`TerrainTree::vertex` is its CPU twin).
// Integer sample positions and an exact slide keep a vertex on an edge shared with a coarser node
// at that node's vertex: no crack and no T-junction.

const GX_TERRAIN_GRID: u32 = 16u;
const GX_TERRAIN_MAX_LODS: u32 = 12u;
const GX_TERRAIN_MAX_LAYERS: u32 = 16u;

// One material layer (`terrain::gpu::GpuTerrainLayer`).
struct GxTerrainLayer {
    // x: the base colour and height texture, y: the data texture (normal xy, roughness,
    // occlusion); NO_TEXTURE for none. z, w: 0.
    textures: vec4<u32>,
    // rgb: the linear tint; w: tiles per metre.
    tint_scale: vec4<f32>,
    // x: the roughness (the factor on the data texel's with one); y: the normal strength; z, w: 0.
    params: vec4<f32>,
}

// The terrain row (`terrain::gpu::GpuTerrain`).
struct GxTerrain {
    // xy: world x, z of sample (0, 0); z: metres between samples; w: samples per metre.
    origin: vec4<f32>,
    // x: the lowest height; y: one quantization step; z, w: 0.
    heights: vec4<f32>,
    // x, y: samples across and down; z: the control words' first word; w: the normal pyramid's
    // levels.
    size: vec4<u32>,
    // x: layers; y: the heights' first sample in the maps (0 for one terrain, a tile's atlas slot
    // otherwise: `terrain::gpu::tile_terrain_row`); z, w: 0.
    counts: vec4<u32>,
    // x: the macro variation; y: 1 / its feature size (metres); z: the wet darkening; w: the wet
    // roughness.
    look: vec4<f32>,
    // x: the height blend's depth; y, z, w: 0.
    blend: vec4<f32>,
    // Each level's morph constants (xy, Strugar's `morphConsts`); z, w: 0.
    morph: array<vec4<f32>, 12>,
    // Each normal pyramid level's first word, four a row.
    normal_levels: array<vec4<u32>, 3>,
    layers: array<GxTerrainLayer, 16>,
    // x, y: one render pixel in NDC (2 / width, 2 / height), from which a pixel's step across
    // the ground is worked out (`gx_terrain_steps`); z, w: 0.
    pixel: vec4<f32>,
}

// One drawn node (`terrain::TerrainRow::gpu`).
struct GxTerrainRow {
    texel: vec2<u32>,
    lod: u32,
    quads: u32,
}

@group(2) @binding(0) var<uniform> gx_terrain: GxTerrain;
@group(2) @binding(1) var<storage, read> gx_terrain_rows: array<GxTerrainRow>;
// The heights (two 16-bit samples a word), then the control words from `size.z`, then the normal
// pyramid (three 10-bit snorms a word) from `normal_levels[0]`.
@group(2) @binding(2) var<storage, read> gx_terrain_maps: array<u32>;

// The index of sample (`x`, `z`) clamped onto the grid.
fn gx_terrain_index(x: u32, z: u32) -> u32 {
    return min(z, gx_terrain.size.y - 1u) * gx_terrain.size.x + min(x, gx_terrain.size.x - 1u);
}

// The height of sample (`x`, `z`), clamped onto the grid (`Heightfield::sample`).
fn gx_terrain_sample(x: u32, z: u32) -> f32 {
    let at = gx_terrain.counts.y + gx_terrain_index(x, z);
    let q = (gx_terrain_maps[at >> 1u] >> ((at & 1u) * 16u)) & 0xffffu;
    return gx_terrain.heights.x + f32(q) * gx_terrain.heights.y;
}

// The height at fractional sample position `p`, bilinear and clamped onto the grid
// (`Heightfield::height_at_texel`): exactly the sample at an integer position.
fn gx_terrain_height(p: vec2<f32>) -> f32 {
    let last = vec2<f32>(gx_terrain.size.xy - vec2<u32>(1u));
    let q = clamp(p, vec2<f32>(0.0), last);
    let base = floor(q);
    let f = q - base;
    let i = vec2<u32>(base);
    let h00 = gx_terrain_sample(i.x, i.y);
    let h10 = gx_terrain_sample(i.x + 1u, i.y);
    let h01 = gx_terrain_sample(i.x, i.y + 1u);
    let h11 = gx_terrain_sample(i.x + 1u, i.y + 1u);
    let near = h00 + (h10 - h00) * f.x;
    let far = h01 + (h11 - h01) * f.x;
    return near + (far - near) * f.y;
}

// How far a level-`lod` vertex `distance` metres from the camera has morphed onto its parent's
// grid (`TerrainLod::morph_k`).
fn gx_terrain_morph_k(lod: u32, distance: f32) -> f32 {
    let c = gx_terrain.morph[min(lod, GX_TERRAIN_MAX_LODS - 1u)].xy;
    return 1.0 - clamp(c.x - distance * c.y, 0.0, 1.0);
}

// The world position of grid vertex `vertex` of `row` for a camera at `camera`
// (`TerrainTree::vertex`).
fn gx_terrain_vertex(row: GxTerrainRow, vertex: u32, camera: vec3<f32>) -> vec3<f32> {
    let width = GX_TERRAIN_GRID + 1u;
    let g = vec2<u32>(vertex % width, vertex / width);
    let step = 1u << row.lod;
    let last = gx_terrain.size.xy - vec2<u32>(1u);
    let at = row.texel + g * step;
    let texel = min(at, last);
    let spacing = gx_terrain.origin.z;
    let unmorphed = vec3<f32>(
        gx_terrain.origin.x + f32(texel.x) * spacing,
        gx_terrain_sample(texel.x, texel.y),
        gx_terrain.origin.y + f32(texel.y) * spacing,
    );
    let k = gx_terrain_morph_k(row.lod, distance(unmorphed, camera));
    let odd = vec2<f32>(g & vec2<u32>(1u));
    let slid = min(vec2<f32>(at) - odd * f32(step) * k, vec2<f32>(last));
    return vec3<f32>(gx_terrain.origin.x + slid.x * spacing, gx_terrain_height(slid), gx_terrain.origin.y + slid.y * spacing);
}
