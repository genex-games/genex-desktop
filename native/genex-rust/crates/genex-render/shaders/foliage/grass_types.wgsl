// Grass (renderer pass 2 A.8; `foliage/mod.rs`): the grass row every grass module reads, the cell
// hash and the blade record. The generation (grass_gen.wgsl) and the draws (grass_core.wgsl) both
// include it, so a blade is the same bits wherever it is read.

const GX_GRASS_TILE_SIDE: u32 = 16u;
const GX_GRASS_TILE_CELLS: u32 = 256u;
const GX_GRASS_LAYERS: u32 = 16u;
// `foliage::GRASS_HEIGHT_MAX`, `GRASS_WIDTH_MAX`, `GRASS_ROOT_SINK`, `GRASS_FADE_BAND`.
const GX_GRASS_HEIGHT_MAX: f32 = 2.0;
const GX_GRASS_WIDTH_MAX: f32 = 0.2;
const GX_GRASS_ROOT_SINK: f32 = 0.03;
const GX_GRASS_FADE_BAND: f32 = 0.15;
// `foliage::distance_share`'s knees.
const GX_GRASS_NEAR_SHARE: f32 = 0.3;
const GX_GRASS_FAR_SHARE: f32 = 0.8;
const GX_GRASS_FAR_DENSITY: f32 = 0.3;
// `foliage::kind`.
const GX_GRASS_GREEN: u32 = 0u;
const GX_GRASS_DRY: u32 = 1u;
const GX_GRASS_FLOWER: u32 = 2u;
// The hash salts (`foliage::salt`).
const GX_GRASS_SALT_JITTER_X: u32 = 0u;
const GX_GRASS_SALT_JITTER_Z: u32 = 1u;
const GX_GRASS_SALT_KEEP: u32 = 2u;
const GX_GRASS_SALT_YAW: u32 = 3u;
const GX_GRASS_SALT_TALL: u32 = 4u;
const GX_GRASS_SALT_LAYER: u32 = 5u;
const GX_GRASS_SALT_KIND: u32 = 6u;

// What grows on one terrain layer (`foliage::gpu::GpuGrassLayer`).
struct GxGrassLayer {
    // x: blades per square metre (0: bare); y, z: the shortest and tallest blade; w: transmission.
    shape: vec4<f32>,
    // x, y: the narrowest and widest root; z: the dry share; w: the flower share.
    width: vec4<f32>,
    // rgb: the colour at the foot (linear).
    root: vec4<f32>,
    // rgb: the colour at the tip.
    tip: vec4<f32>,
    // rgb: a dry tip's colour.
    dry: vec4<f32>,
    // rgb: a flower's colour.
    flower: vec4<f32>,
}

// The frame's grass row (`foliage::gpu::GpuGrass`).
struct GxGrass {
    // xyz: the camera; w: the radius blades grow to.
    camera: vec4<f32>,
    // The camera's frustum planes (normalized, inward).
    planes: array<vec4<f32>, 6>,
    // x, y: the generated square's first cell (global x, z); z: tiles a side; w: vertices a blade.
    grid: vec4<i32>,
    // x: the cell's side (metres); y: the quality's density share; z, w: the terrain's lowest and
    // highest height.
    cell: vec4<f32>,
    // x: this frame's simulated seconds; y: last frame's (its motion sways from there); z: segments
    // a blade; w: one render pixel's size at a clip w of 1 (`GrassFrameInput::pixel`).
    time: vec4<f32>,
    layers: array<GxGrassLayer, 16>,
}

// lowbias32 (Chris Wellons, public domain) over a cell and a salt (`foliage::hash`).
fn gx_grass_hash(x: i32, z: i32, salt: u32) -> u32 {
    var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(z) * 0xd8163841u) ^ (salt * 0xcb1ab31fu);
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}

// A cell's random in 0..1 for `salt` (`foliage::unit`).
fn gx_grass_unit(x: i32, z: i32, salt: u32) -> f32 {
    return f32(gx_grass_hash(x, z, salt) >> 8u) / 16777216.0;
}

// How much of the near density survives `distance` metres from the camera within `radius`
// (`foliage::distance_share`).
fn gx_grass_distance_share(distance: f32, radius: f32) -> f32 {
    let t = distance / max(radius, 1e-3);
    if t <= GX_GRASS_NEAR_SHARE {
        return 1.0;
    }
    if t <= GX_GRASS_FAR_SHARE {
        let k = (t - GX_GRASS_NEAR_SHARE) / (GX_GRASS_FAR_SHARE - GX_GRASS_NEAR_SHARE);
        return 1.0 + (GX_GRASS_FAR_DENSITY - 1.0) * k;
    }
    let k = min((t - GX_GRASS_FAR_SHARE) / (1.0 - GX_GRASS_FAR_SHARE), 1.0);
    return GX_GRASS_FAR_DENSITY * (1.0 - k);
}

// One blade unpacked from its record (`foliage::Blade::pack`).
struct GxGrassBlade {
    root: vec3<f32>,
    // Radians.
    yaw: f32,
    height: f32,
    layer: u32,
    kind: u32,
    // 0..1: how far it has grown in.
    grown: f32,
    // 0..1: a random of its own (its width and shade).
    tint: f32,
}

fn gx_grass_unpack(record: vec4<u32>) -> GxGrassBlade {
    var blade: GxGrassBlade;
    blade.root = bitcast<vec3<f32>>(record.xyz);
    let w = record.w;
    blade.yaw = f32(w & 255u) * (6.28318531 / 256.0);
    blade.layer = (w >> 8u) & 15u;
    blade.kind = (w >> 12u) & 3u;
    blade.grown = f32((w >> 14u) & 63u) / 63.0;
    blade.height = f32(w >> 20u) / 4095.0 * GX_GRASS_HEIGHT_MAX;
    blade.tint = f32(gx_grass_hash(bitcast<i32>(record.x), bitcast<i32>(record.z), w) >> 8u) / 16777216.0;
    return blade;
}
