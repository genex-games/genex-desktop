// Motion blur's tiles (A.9 / A7.3), after a depth chunk and motion_blur_pack.wgsl: the longest
// velocity of each tile's 3x3 neighbourhood (KinoMotion's TileMax and NeighborMax, MIT; McGuire et
// al. 2012), in two passes: a compute reduction of each 16x16 block of render pixels in workgroup
// memory that also writes each pixel's packed speed and distance (KinoMotion's VelocitySetup;
// it reduces in four fragment passes), then one fragment pass per tile over the k x k blocks of
// its 3x3 tiles.

// The 16x16 blocks' longest velocities (xy).
@group(0) @binding(6) var mb_blocks_out: texture_storage_2d<rgba16float, write>;
// Each render pixel's packed speed and distance.
@group(0) @binding(7) var mb_packed_out: texture_storage_2d<r32uint, write>;
// The 16x16 blocks, read by the neighbourhood pass.
@group(0) @binding(3) var mb_blocks: texture_2d<f32>;

// One velocity per invocation: the longest of its 2x2 pixels of a 16x16 block.
var<workgroup> mb_block: array<vec2<f32>, 64>;

// The velocity of render pixel `p`, its packed speed and distance stored when `p` is inside
// the render size.
fn mb_pack_pixel(p: vec2<i32>) -> vec2<f32> {
    let v = mb_velocity(p);
    if all(p <= mb_last()) {
        textureStore(mb_packed_out, p, vec4<u32>(mb_pack(v, mb_distance(p)), 0u, 0u, 0u));
    }
    return v;
}

// The longest velocity of the workgroup's 16x16 render pixels (clamped to the render size), and
// each pixel's packed speed and distance. Each of the 8x8 invocations takes 2x2 pixels: fewer
// invocations and barriers than one a pixel (a still 1080p frame's node 0.25 -> 0.21 ms).
@compute @workgroup_size(8, 8)
fn cs_mb_blocks(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) index: u32, @builtin(workgroup_id) group: vec3<u32>) {
    let base = vec2<i32>(id.xy) * 2;
    let v = mb_vmax(mb_vmax(mb_pack_pixel(base), mb_pack_pixel(base + vec2<i32>(1, 0))), mb_vmax(mb_pack_pixel(base + vec2<i32>(0, 1)), mb_pack_pixel(base + vec2<i32>(1, 1))));
    mb_block[index] = v;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride = stride >> 1u) {
        if index < stride {
            mb_block[index] = mb_vmax(mb_block[index], mb_block[index + stride]);
        }
        workgroupBarrier();
    }
    if index == 0u {
        textureStore(mb_blocks_out, vec2<i32>(group.xy), vec4<f32>(mb_block[0], 0.0, 0.0));
    }
}

// The longest velocity of tile `tile` (k x k blocks, k = the tile side / 16), the tile index
// clamped to the tile grid.
fn mb_tile_max(tile: vec2<i32>) -> vec2<f32> {
    let k = i32(mb.size.w);
    let tiles = vec2<i32>(ceil(mb.size.xy / mb.size.z));
    let base = clamp(tile, vec2<i32>(0), tiles - vec2<i32>(1)) * k;
    let last = vec2<i32>(textureDimensions(mb_blocks)) - vec2<i32>(1);
    var v = vec2<f32>(0.0);
    for (var y = 0; y < k; y++) {
        for (var x = 0; x < k; x++) {
            v = mb_vmax(v, textureLoad(mb_blocks, min(base + vec2<i32>(x, y), last), 0).xy);
        }
    }
    return v;
}

// The longest velocity of the tile's 3x3 neighbourhood, the centre favoured by 1% (KinoMotion's
// NeighborMax), so every pixel within the largest radius of a moving one sees its velocity.
@fragment
fn fs_mb_neighbour(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let centre = vec2<i32>(frag.xy);
    let weight = 1.01;
    var v = mb_tile_max(centre) * weight;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if x == 0 && y == 0 {
                continue;
            }
            v = mb_vmax(v, mb_tile_max(centre + vec2<i32>(x, y)));
        }
    }
    return vec4<f32>(v / weight, 0.0, 0.0);
}
