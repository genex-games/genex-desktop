// Structs shared by the renderer's shaders. Each mirrors a #[repr(C)] struct in src/layout.rs of
// the same name; tests/layout.rs holds the two sizes equal. Padding is spelled out as scalar
// fields because a vec3 pad would be 16-aligned.

struct FrameUniforms {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    // xyz: unit view direction (a fragment's view depth picks its shadow cascade).
    camera_forward: vec4<f32>,
    sun_dir: vec4<f32>,
    sun_color: vec4<f32>,
    // rgb: the flat ambient radiance; w: 1 when the environment replaces it (RQ2: a sky or a map
    // lights the scene and its bake has landed), 0 otherwise.
    ambient: vec4<f32>,
    // Normalized, pointing inwards: left, right, bottom, top, near, far.
    planes: array<vec4<f32>, 6>,
    // The frozen v1 prefix's first two cascades (`GpuFrame::cascade_view_proj`); shaders read
    // every cascade from `cascade_view_proj` below.
    cascade_view_proj_v1: array<mat4x4<f32>, 2>,
    // x, y: view depth where cascade 0 and 1 end; z: the HDR scene's pre-exposure (0 on the
    // legacy LDR scene; v1 compat frames read 0); w: 1 when the sun casts shadows.
    cascade_splits: vec4<f32>,
    // x: depth bias; y, z: normal offset of cascade 0 and 1; w: one shadow texel in uv.
    shadow_params: vec4<f32>,
    // x: point lights, y: batches, z: cull views, w: visible-list rows per view.
    counts: vec4<u32>,
    // --- Past the frozen v1 prefix (RQ3.0). The cascade members keep GxFrameV2's names and
    // meanings, so the sun chunk reads them under either frame.
    // Each drawn cascade's light view-projection (`GpuFrame::cascade_matrices`); 0 past them.
    cascade_view_proj: array<mat4x4<f32>, 4>,
    // View depth where each cascade ends (0 past the drawn ones), and each one's normal offset.
    cascade_ends: vec4<f32>,
    cascade_offsets: vec4<f32>,
    // One shadow texel of each cascade in world units.
    cascade_texels: vec4<f32>,
    // x: tan of the sun's angular radius; y: the cascade blend band (fraction; 0 a hard switch);
    // z: the end fade (fraction of the last cascade; 0 a hard end).
    shadow_soft: vec4<f32>,
    // x: cascades drawn; y: shadowed spots drawn; z: the frame key (the frame index).
    shadow_counts: vec4<u32>,
    // xy: TAA's jitter of the camera's projection in NDC (y up; 0 without TAA), added by every
    // camera depth writer's gx_clip_position; view_proj stays unjittered. zw: last frame's.
    jitter: vec4<f32>,
    // Each cascade's comparison bias in its light depth (NDC): one world-space bias over each
    // cascade's light depth (shadow.rs `Cascades::comparison_bias`), read through
    // gx_sun_cascade_bias (the v2 prelude's reads the shared `shadow_params.x`).
    cascade_bias: vec4<f32>,
    // x: the frame's texture mip bias (`settings::frame_texture_lod_bias`, T-06), read through
    // gx_texture_lod_bias; y, z, w: reserved (0).
    texture_lod: vec4<f32>,
}

struct Light {
    // xyz position, w range.
    position_range: vec4<f32>,
    color: vec4<f32>,
}

// A local light's extension row (RQ6.0), parallel to the light table at the same row and bound
// as `light_ext: array<vec4<f32>>` (GX_LIGHT_EXT_VEC4S per light), so the Level-2 v2 prelude
// reads it too. Shadowed spots' light view-projections follow the light rows
// (GX_SPOT_MATRIX_VEC4S each, by shadow slot).
struct LightExt {
    // xyz: unit cone direction (0 for a point); w: cos of the outer half-angle (-1 for a point).
    spot: vec4<f32>,
    // x: cos of the inner half-angle; y: kind (GX_LIGHT_POINT, GX_LIGHT_SPOT); z: shadow slot
    // (-1 none; its map is the slot's tile of the spot atlas, the shadow-array layer after the drawn
    // cascades); w: how far the spot's shadow has faded out as its slot changes hands (0 whole,
    // GX_SPOT_SHADOW_UNFADED, to 1 none; 0 in every row until spot slots fade).
    params: vec4<f32>,
}

// The light bins' grid and depth mapping (RQ6.0): the binning dispatch's uniform and the header
// of the bin table (its first GX_LIGHT_BIN_HEADER_WORDS words; the depths are f32 bits).
struct LightBinParams {
    // x, y: tiles across and down; z: mask words per tile; w: tile side in pixels.
    grid: vec4<u32>,
    // x: z-bins; y: lights binned; z: view depth where z-bin 0 starts; w: z-bins per unit depth.
    depth: vec4<u32>,
    // The clusterable kinds' ends in the binned index space (pass 2 A.0, LG-16): x lights, y
    // decals, z probes (every object); w reserved.
    ranges: vec4<u32>,
    // The decals' (xy) and probes' (zw) own z-bin start depth and z-bins per unit depth.
    kind_depth: vec4<u32>,
}

const GX_LIGHT_POINT: u32 = 0u;
const GX_LIGHT_SPOT: u32 = 1u;
const GX_LIGHT_EXT_VEC4S: u32 = 2u;
const GX_SPOT_MATRIX_VEC4S: u32 = 4u;
const GX_SPOT_SHADOW_UNFADED: f32 = 0.0;
// The LOD crossfade of an instance-table row that is not fading (the instance fade table's value,
// layout::INSTANCE_FADE_WHOLE): drawn whole.
const GX_INSTANCE_FADE_WHOLE: f32 = 1.0;
// The LOD crossfade's dither (game systems LOD-04; kansei `lod_fade.wgsl`, MIT, ideas): the faded
// entries keep a pixel, or an MSAA sample, of a fade-batch survivor by a threshold in [0, 1) and
// the survivor's fade (the instance fade table's x, `mesh::lod_row_keep`): fading out (0 <= fade
// < 1) keeps the thresholds below it, fading in (fade = -share) those at or above 1 - share, so
// the two levels of one crossfade cover each pixel exactly once; whole (1) keeps every pixel.
// The threshold is interleaved gradient noise of the pixel (Jimenez 2014), turned each frame on
// temporal paths so the resolve blends the two levels: by frame k's base-2 radical inverse of
// k mod GX_LOD_FADE_FRAMES (0, 1/2, 1/4, 3/4, ...), so any GX_LOD_FADE_FRAMES consecutive frames
// turn each pixel through evenly spaced thresholds and keep its incoming level in floor(8 s) or
// ceil(8 s) of them (R-12, D22: the golden-ratio walk left a pixel up to three eighths off its
// share, a stipple the settled capture showed), and the halves alternate so a running average
// sees no slow beat.
// The turns' period: the shortest TAA jitter cycle (`settings::JitterCycle::Eight`), which every
// longer cycle holds whole runs of.
const GX_LOD_FADE_FRAMES: u32 = 8u;
// log2(GX_LOD_FADE_FRAMES): the bits of the frame's radical inverse.
const GX_LOD_FADE_FRAME_BITS: u32 = 3u;

// The dither threshold of the pixel at `pixel` (framebuffer coordinates) on frame `frame_key`
// (0 on a path that does not turn it), in [0, 1).
fn gx_lod_fade_threshold(pixel: vec2<f32>, frame_key: u32) -> f32 {
    let ign = fract(52.9829189 * fract(dot(floor(pixel), vec2<f32>(0.06711056, 0.00583715))));
    let turn = reverseBits(frame_key % GX_LOD_FADE_FRAMES) >> (32u - GX_LOD_FADE_FRAME_BITS);
    return fract(ign + f32(turn) / f32(GX_LOD_FADE_FRAMES));
}

// Whether a survivor of fade `fade` keeps threshold `threshold`. `1.0 + fade` is the fade-out
// twin's `1 - share` exactly (one rounding each), so the twins' kept sets never overlap or gap.
fn gx_lod_fade_keeps(fade: f32, threshold: f32) -> bool {
    if fade < 0.0 {
        return threshold >= 1.0 + fade;
    }
    return threshold < fade;
}

// The samples of a `samples`-sample pixel a survivor of fade `fade` keeps (an MSAA path's
// `sample_mask`): sample i keeps the threshold `(i + threshold) / samples`, so the pixel is
// covered by both levels in proportion, without a stipple, and each sample by one level.
fn gx_lod_fade_coverage(fade: f32, threshold: f32, samples: u32) -> u32 {
    var mask = 0u;
    for (var i = 0u; i < samples; i++) {
        if gx_lod_fade_keeps(fade, (f32(i) + threshold) / f32(samples)) {
            mask |= 1u << i;
        }
    }
    return mask;
}
const GX_LIGHT_BIN_HEADER_WORDS: u32 = 16u;
// Z-bins per clusterable kind (cluster::LIGHT_ZBINS); kind k's start at the header plus k of them.
const GX_LIGHT_ZBINS: u32 = 64u;
// Where the tile masks start in the bin table, in words (cluster::LIGHT_TILES_OFFSET_WORDS).
const GX_LIGHT_TILES_OFFSET_WORDS: u32 = 256u;
// A z-bin no light touches: lowest index 0xFFFF above highest 0.
const GX_ZBIN_EMPTY: u32 = 0x0000ffffu;
const GX_ZBIN_INDEX_BITS: u32 = 16u;
// A material texture reference (`Material::textures`): size class in the bits from
// GX_TEXTURE_CLASS_SHIFT up, layer below; class 0 is the bare layer (RQ6.0).
const GX_TEXTURE_CLASS_SHIFT: u32 = 28u;
const GX_TEXTURE_LAYER_MASK: u32 = 0x0fffffffu;

struct Instance {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    // World-space bounding sphere: centre xyz, radius w.
    bounds: vec4<f32>,
    material: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

struct Material {
    base_color: vec4<f32>,
    // x: metallic, y: roughness, z: 1 for the missing-asset checker, w: normal-map scale.
    params: vec4<f32>,
    // Texture references: x base colour, y normal map, z metallic-roughness, w ambient occlusion
    // (P2-0.12; equal to z for an ORM texture, whose red is then read from z's texel);
    // NO_TEXTURE if none.
    textures: vec4<u32>,
}

struct Batch {
    // The batch's first slot in each view's region of the visible list.
    first_instance: u32,
    instance_count: u32,
    index_count: u32,
    first_index: u32,
    base_vertex: i32,
    // Its first instance-table row (A6.9: every level's batch of a mesh holds its rows).
    first_row: u32,
    // The batch's level of detail (A6.9, mesh_lod.rs `batch_lod`): the tag (0: no levels; bit 31,
    // then the level in bits 0-3 and the chain's length in bits 4-7), then the chain's errors over
    // the mesh's bounding radius as half-float pairs.
    lod: u32,
    lod_error01: u32,
    lod_error23: u32,
}

struct PassView {
    // 0 the camera, 1 + c shadow cascade c, then the shadowed spots.
    view: u32,
    // 1: `base` is the visible-list row (a transparent draw); 0: the vertex's slot finds it.
    direct: u32,
    base: u32,
    // Where the drawn variant's region of the slot-base table starts (P2-0.12: 0 for plain
    // batches, the variant's index times the plan's slots for the others' rows).
    slot_offset: u32,
}

struct CullViews {
    // MAX_VIEWS (layout.rs): the camera, four cascades, four shadowed spots; the active views
    // lead and the rest are 0.
    planes: array<array<vec4<f32>, 6>, 9>,
    // x: visible-list slots per view, y: batches, z: active views, w: the views the frame holds
    // (bit v: a far cascade off its cadence keeps last frame's map, so its cull is skipped).
    params: vec4<u32>,
    // The levels of detail's view (A6.9): the camera position xyz, w the output's pixels a world
    // unit at distance 1 over the error threshold (0: levels off).
    lod: vec4<f32>,
    // x: 1 when a batch draws a level.
    lod_params: vec4<u32>,
    // The world error each sun cascade's casters may show (layout.rs `GpuCullViews::shadow_lod`):
    // cascade c's in lane c, 0 the camera's level.
    shadow_lod: vec4<f32>,
}

struct DrawIndexedArgs {
    index_count: u32,
    instance_count: u32,
    first_index: u32,
    base_vertex: i32,
    first_instance: u32,
}

struct MeshVertex {
    // position xyz, normal xyz, uv, tangent xyzw.
    data: array<f32, 12>,
}

struct SkinVertex {
    joints: vec4<u32>,
    weights: vec4<f32>,
}

struct SkinJob {
    src_base: u32,
    count: u32,
    dst_base: u32,
    joint_base: u32,
    skin_base: u32,
    slot: u32,
    pad0: u32,
    pad1: u32,
}

// One bake step of the environment (RQ2.1, `shaders/ibl/`): mirrors `GpuIblBake`.
struct IblBake {
    // x, y: cos and sin of the map's rotation about up; z: radiance multiplier; w: the largest
    // radiance a source texel keeps (0: no clamp).
    source: vec4<f32>,
    // x: face, y: mip written, z: the cube's mips, w: samples per texel.
    dest: vec4<u32>,
    // x: GGX roughness of the mip; y: source side (mip 0); z: source mips; w: reserved.
    prefilter: vec4<f32>,
    // x: frame index of the time-sliced schedule; y: the written mip's side; z, w: reserved.
    schedule: vec4<u32>,
}

// The physical sky (RQ2.2, `shaders/sky/`; Hillaire, kilometres): mirrors `GpuSkyAtmosphere`.
struct SkyAtmosphere {
    // xyz: towards the sun; w: its angular radius (radians).
    sun_dir: vec4<f32>,
    // rgb: the sun's illuminance; w: the sky's radiance multiplier.
    sun_illuminance: vec4<f32>,
    // rgb: ground albedo; w: camera height above the ground.
    ground_albedo: vec4<f32>,
    // x: planet radius, y: atmosphere top radius, z: ozone centre height, w: ozone width.
    radii: vec4<f32>,
    // rgb: Rayleigh scattering; w: density falloff.
    rayleigh: vec4<f32>,
    // x: Mie scattering, y: Mie extinction, z: phase g, w: density falloff.
    mie: vec4<f32>,
    // rgb: ozone absorption; w: multiple-scattering factor.
    ozone: vec4<f32>,
    // x, y: transmittance LUT size; z, w: sky-view LUT size.
    luts: vec4<u32>,
    // x: multiple-scattering LUT side; y: aerial-perspective side (0: off); z: frame index; w: reserved.
    params: vec4<u32>,
}

// --- Meshlets and two-pass Hi-Z occlusion (R2.0): mirror `GpuMeshlet`, `GpuMeshletInstance`,
// `GpuDrawnMeshlet`, `GpuMeshletCull` and `GpuHizParams` in src/layout.rs.

// One meshlet: at most 64 vertices and 124 triangles of one mesh.
struct Meshlet {
    // Object-space bounding sphere: centre xyz, radius w.
    bounds: vec4<f32>,
    // Normal cone: unit axis xyz, cutoff w (1: no usable cone).
    cone: vec4<f32>,
    vertex_offset: u32,
    triangle_offset: u32,
    vertex_count: u32,
    triangle_count: u32,
}

// One opaque instance drawn through meshlets.
struct MeshletInstance {
    instance: u32,
    first_meshlet: u32,
    meshlet_count: u32,
    // Exclusive prefix sum of meshlet_count: the instance's first candidate and visibility bit.
    first_candidate: u32,
}

// One drawn-meshlet slot of a view: what the compacted index `slot << 6 | local` names.
struct DrawnMeshlet {
    instance: u32,
    meshlet: u32,
}

struct MeshletCull {
    // x: candidates, y: meshlet instances, z: views, w: the occlusion pass (1 or 2).
    counts: vec4<u32>,
    // x, y: Hi-Z mip-0 size; z: mips; w: 1 under reverse-Z.
    hiz: vec4<u32>,
    // x: indices per view; y: drawn slots per view; z: scan blocks; w: flags (bit 0 occlusion,
    // bit 1 history reset).
    capacity: vec4<u32>,
    // xy: render uv to Hi-Z mip-0 uv; zw: reserved.
    hiz_uv: vec4<f32>,
}

struct HizParams {
    // xy: source size; zw: destination size.
    size: vec4<u32>,
    // x: destination mip; y: 0 max (standard Z), 1 min (reverse-Z); zw: reserved.
    params: vec4<u32>,
}

// Bits of a compacted meshlet index that name the meshlet-local vertex (64 vertices).
const GX_MESHLET_LOCAL_BITS: u32 = 6u;

// The three meshlet-local vertex indices of a packed triangle (one byte each, low byte first).
fn gx_meshlet_triangle(packed: u32) -> vec3<u32> {
    return vec3<u32>(packed & 0xffu, (packed >> 8u) & 0xffu, (packed >> 16u) & 0xffu);
}

// The compacted index of meshlet-local vertex `local` of drawn slot `slot`.
fn gx_meshlet_index(slot: u32, local: u32) -> u32 {
    return (slot << GX_MESHLET_LOCAL_BITS) | local;
}

// The drawn slot (x) and meshlet-local vertex (y) a compacted index names.
fn gx_meshlet_decode(index: u32) -> vec2<u32> {
    return vec2<u32>(index >> GX_MESHLET_LOCAL_BITS, index & ((1u << GX_MESHLET_LOCAL_BITS) - 1u));
}

// Whether a meshlet with bounds centre `centre`, radius `radius` and cone `cone` faces wholly away
// from a viewer at `eye` (all in one space; meshoptimizer's conservative test).
fn gx_meshlet_backfacing(centre: vec3<f32>, radius: f32, cone: vec4<f32>, eye: vec3<f32>) -> bool {
    let to_centre = centre - eye;
    return dot(to_centre, cone.xyz) >= cone.w * length(to_centre) + radius;
}

// The visibility history's word and bit of candidate `candidate`.
fn gx_visibility_word(candidate: u32) -> u32 {
    return candidate >> 5u;
}

fn gx_visibility_mask(candidate: u32) -> u32 {
    return 1u << (candidate & 31u);
}

// The Hi-Z reduction of four depths: the farthest, which is the largest under standard Z and the
// smallest under reverse-Z (`reversed` 1), so an occluder test against it is conservative.
fn gx_hiz_reduce(depths: vec4<f32>, reversed: u32) -> f32 {
    if reversed == 1u {
        return min(min(depths.x, depths.y), min(depths.z, depths.w));
    }
    return max(max(depths.x, depths.y), max(depths.z, depths.w));
}

const NO_TEXTURE: u32 = 0xffffffffu;

// The instance-table row of an opaque vertex: the batch's region of this view's visible list
// (found through the vertex's slot) plus the instance index; a direct draw names its row.
fn visible_row(view: u32, direct: u32, base: u32, slot_start: u32, instance: u32, rows_per_view: u32) -> u32 {
    if direct == 1u {
        return base;
    }
    return view * rows_per_view + slot_start + instance;
}

// --- The published v2 ABI (abi.rs, RQ1.0): the structs both v2 preludes and the renderer's own
// v2 passes share. Members mirror `GxFrameV2`, `GxEnvSh` and `GxMaterialExt` in abi.rs field for
// field; tests/layout.rs holds every offset to naga's. The chunk-compatible members (camera_pos ..
// counts) mean what FrameUniforms' do, so the forward lighting chunks compile against either.

struct GxFrameV2 {
    view: mat4x4<f32>,
    // Jittered when TAA is on, reversed when depth_reversed is 1.
    proj: mat4x4<f32>,
    view_proj: mat4x4<f32>,
    inv_view_proj: mat4x4<f32>,
    // Last frame's unjittered view_proj (this frame's on a history reset).
    prev_view_proj: mat4x4<f32>,
    unjittered_view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    camera_forward: vec4<f32>,
    // xyz: unit direction towards the sun; w: its angular radius in radians.
    sun_dir: vec4<f32>,
    sun_color: vec4<f32>,
    ambient: vec4<f32>,
    planes: array<vec4<f32>, 6>,
    cascade_view_proj: array<mat4x4<f32>, 4>,
    // x, y: view depth where cascades 0 and 1 end; w: 1 when the sun casts shadows.
    cascade_splits: vec4<f32>,
    // x: depth bias; y, z: normal offset of cascades 0 and 1; w: one shadow texel in uv.
    shadow_params: vec4<f32>,
    // View depth where cascades 0..3 end, and their normal offsets.
    cascade_ends: vec4<f32>,
    cascade_offsets: vec4<f32>,
    // x: point lights; y: cascades drawn; z: spot lights.
    counts: vec4<u32>,
    // rgb: fog in-scatter tint; a: density (0: no fog).
    fog_color: vec4<f32>,
    // x: height falloff; y: base height; z: start distance; w: largest opacity.
    fog_params: vec4<f32>,
    jitter: vec2<f32>,
    prev_jitter: vec2<f32>,
    render_size: vec2<f32>,
    output_size: vec2<f32>,
    // The exposure the scene is written with (the previous frame's); every scene writer
    // multiplies radiance by it. 1 on the legacy path.
    pre_exposure: f32,
    inv_pre_exposure: f32,
    ev_compensation: f32,
    time: f32,
    delta_time: f32,
    near: f32,
    // 0: an infinite far plane.
    far: f32,
    frame_index: u32,
    // 1: reverse-Z (Greater, cleared to 0); 0: standard Z.
    depth_reversed: u32,
    // 1: the scene is the legacy LDR world (sRGB-encoded); 0: linear, pre-exposed HDR.
    scene_ldr: u32,
    settle_index: u32,
    history_reset: u32,
}

// The environment's diffuse irradiance: 9 spherical-harmonic coefficients (rgb).
struct GxEnvSh {
    coefficients: array<vec4<f32>, 9>,
}

// A material row's v2 extension, parallel to the material table.
struct GxMaterialExt {
    // rgb: emissive radiance in scene units; a: the occlusion map's strength (P2-0.12).
    emissive: vec4<f32>,
    // x: emissive map layer (-1 none), y: its size class, z: flags, w: the alpha cutoff (P2-0.12;
    // 0: not alpha-tested).
    params: vec4<f32>,
    // Subsurface scattering (renderer pass 2 B.1): rgb the scatter colour (linear), a the
    // thickness (0..1; 1 scatters nothing). Read only under the subsurface flag.
    subsurface: vec4<f32>,
    // x: the forward-scatter power, y: the diffuse transmission share, z: the scattering depth in
    // world units, w: reserved (B.1).
    transmission: vec4<f32>,
    // The UV mapping (Bodycam B2b, `gx_surface_uv`): xy the scale (0 reads as 1), z 1 for a
    // world-aligned box projection (xy then tiles per metre), w reserved.
    uv: vec4<f32>,
}

// The view distance of a depth-buffer value under projection `proj` (perspective or
// orthographic, standard or reversed, finite or infinite far plane).
fn gx_view_distance(proj: mat4x4<f32>, depth: f32) -> f32 {
    if proj[3][3] == 1.0 {
        return (proj[3][2] - depth) / proj[2][2];
    }
    return proj[3][2] / (depth + proj[2][2]);
}
