// genex WGSL extension API v2: the prelude of `gfx.material` at `[[wgsl]] api = 2`. The renderer
// prepends shaders/common.wgsl, the BRDF (pbr.wgsl), the forward lighting chunks
// (shaders/lighting/*.wgsl, the same text the renderer's own forward shader is built from) and
// this file to the game's source. The game writes
// `@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32>` and may bind its own
// group 2: one `var<uniform>` at @binding(0) (at most EXTENSION_UNIFORM_MAX_BYTES), up to four
// `texture_2d<f32>` and two samplers from asset handles (`gfx.texture(path)`). Group 3 is reserved.
//
// The fragment returns the value the scene target stores: build a surface with `gx_surface_v2`,
// shade it with `gx_shade_pbr` (the renderer's own lighting: ambient with AO, the sun through its
// shadows and contact shadows, every local light, the aerial perspective and fog; later tiers'
// inputs arrive through the same chunks) and add any colour of your own in scene units through `gx_expose`. On the HDR path
// that is linear radiance times the pre-exposure; on the legacy LDR scene (an `off` preset, or a
// frame degraded to LDR) `gx_expose` encodes sRGB instead, so one source draws right on both.
//
// Names the prelude declares are reserved: everything starting `gx_`, the renderer's structs
// (FrameUniforms, Light, Instance, Material, Batch, PassView, CullViews, DrawIndexedArgs,
// MeshVertex, SkinVertex, SkinJob, Surface) and functions of the chunks, and the group-0 names
// below (the chunks read `frame`, `lights`, `materials`, `shadow_map`, `shadow_sampler`,
// `color_textures`, `data_textures` and `texture_sampler` under exactly these names). Bindings
// whose producer is off or not landed yet hold 1x1 neutral values (no environment light, no
// occlusion, no in-scatter); the receipt's `renderInputs` lists what is really produced.

// Group 0: the renderer's (abi.rs MATERIAL_V2_BINDINGS).
@group(0) @binding(0) var<uniform> frame: GxFrameV2;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read> materials: array<Material>;
@group(0) @binding(3) var<storage, read> material_ext: array<GxMaterialExt>;
@group(0) @binding(4) var color_textures: texture_2d_array<f32>;
@group(0) @binding(5) var data_textures: texture_2d_array<f32>;
@group(0) @binding(6) var texture_sampler: sampler;
@group(0) @binding(7) var shadow_map: texture_depth_2d_array;
@group(0) @binding(8) var shadow_sampler: sampler_comparison;
// The environment (RQ2): prefiltered specular cube, SH9 irradiance, split-sum BRDF LUT.
@group(0) @binding(9) var env_specular: texture_cube<f32>;
@group(0) @binding(10) var<uniform> env_sh: GxEnvSh;
@group(0) @binding(11) var brdf_lut: texture_2d<f32>;
@group(0) @binding(12) var env_sampler: sampler;
// Screen-space ambient occlusion (RQ4; render size, 1 = unoccluded).
@group(0) @binding(13) var ao_map: texture_2d<f32>;
// Aerial perspective (RQ4): rgb in-scatter, a transmittance, over view-space froxels.
@group(0) @binding(14) var aerial_perspective: texture_3d<f32>;
@group(0) @binding(15) var point_sampler: sampler;
// Binned local lights (RQ6): per-tile light masks, depth bins and per-light extension rows.
@group(0) @binding(16) var<storage, read> light_tiles: array<u32>;
@group(0) @binding(17) var<storage, read> light_zbins: array<u32>;
@group(0) @binding(18) var<storage, read> light_ext: array<vec4<f32>>;
// The sun's screen-space contact shadows (RQ4; render size, 1 = unshadowed).
@group(0) @binding(19) var contact_shadow_mask: texture_2d<f32>;

// The light walk's reads (shaders/lighting/local_lights.wgsl): the renderer binds `light_zbins`
// and `light_tiles` as two slices of its one bin table (pass 2 A.0, LG-16).
fn gx_light_bin_word(i: u32) -> u32 {
    return light_zbins[i];
}

fn gx_light_tile_word(i: u32) -> u32 {
    return light_tiles[i];
}

// The surface chunk's larger material size classes (RQ6.4) are the forward pass's: a v2 material
// binds class 0 only (the twelve sampled textures of plan section 2.9), so this reads the class-0
// layer of any reference. The built-in surface (`gx_surface`) is never called from here.
fn gx_class_texel(color: bool, reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    if color {
        return textureSampleGrad(color_textures, texture_sampler, uv, layer(reference), uv_dx, uv_dy);
    }
    return textureSampleGrad(data_textures, texture_sampler, uv, layer(reference), uv_dx, uv_dy);
}

// One custom draw: its model and normal matrices, last frame's model matrix (matched by draw id,
// else mesh and ordinal; this frame's without history), its linear tint and x: the simulated time
// in seconds, y: the draw's index in the frame, z: last frame's simulated time (x on the first).
struct GxDrawV2 {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    prev_model: mat4x4<f32>,
    tint: vec4<f32>,
    params: vec4<f32>,
}

// Group 1: the frame's draw rows, one per draw (renderer pass 2 A.0, LG-20 step 3). The draws of
// one (material, mesh) pair are one instanced call, so each vertex reads its instance's row.
@group(1) @binding(0) var<storage, read> gx_draws: array<GxDrawV2>;

// The fragment's own draw: the renderer opens `fs_material` with `gx_draw = gx_draws[..]` when the
// source reads it (`extension::open_draw_row`), so `gx_draw.prev_model` and `gx_draw.params` read
// the drawn instance's row as they read a draw's own uniform before.
var<private> gx_draw: GxDrawV2;

struct GxMaterialInV2 {
    // `gx_clip_position` of the world position: `@invariant`, as every depth writer's is.
    @builtin(position) @invariant position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    // Linear rgb and alpha.
    @location(3) tint: vec4<f32>,
    // Unjittered clip positions this frame and last (motion vectors).
    @location(4) clip_current: vec4<f32>,
    @location(5) clip_previous: vec4<f32>,
}

// What the geometry stage writes: `GxMaterialInV2` and the instance's row (`gx_draws`' index),
// which a `fs_material` reading `gx_draw` is handed at @location(6).
struct GxVertexOutV2 {
    @builtin(position) @invariant position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tint: vec4<f32>,
    @location(4) clip_current: vec4<f32>,
    @location(5) clip_previous: vec4<f32>,
    @location(6) @interpolate(flat) gx_row: u32,
}

@vertex
fn gx_vs_material_v2(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @builtin(instance_index) instance: u32) -> GxVertexOutV2 {
    let draw = gx_draws[instance];
    let world = draw.model * vec4<f32>(position, 1.0);
    var out: GxVertexOutV2;
    out.position = gx_clip_position(frame.view_proj, world, GX_NO_JITTER);
    out.world_position = world.xyz;
    out.normal = normalize((draw.normal * vec4<f32>(normal, 0.0)).xyz);
    out.uv = uv;
    out.tint = draw.tint;
    out.clip_current = frame.unjittered_view_proj * world;
    out.clip_previous = frame.prev_view_proj * (draw.prev_model * vec4<f32>(position, 1.0));
    out.gx_row = instance;
    return out;
}

// Whether the frame draws the HDR scene (pbr.wgsl's direct specular asks): a v2 pipeline serves
// both scenes, so it reads the frame where the forward pipeline reads its constant.
fn gx_scene_shades_hdr() -> bool {
    return frame.scene_ldr == 0u;
}

// The surface `gx_shade_pbr` lights (the forward chunks' `Surface`).
alias GxSurface = Surface;

// A surface at `world_pos` with the unit-less `normal`, linear base colour `albedo`, `metallic`
// and `roughness`, seen from the camera. It takes no derivatives, so it may be called anywhere;
// its highlight is not filtered against aliasing (`gx_filter_specular_v2` does that).
fn gx_surface_v2(world_pos: vec3<f32>, normal: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32) -> GxSurface {
    let n = normalize(normal);
    let v = normalize(frame.camera_pos.xyz - world_pos);
    return Surface(world_pos, n, n, v, albedo, 1.0, clamp(metallic, 0.0, 1.0), clamp(roughness, GX_ROUGHNESS_FLOOR, 1.0));
}

// `s` with its roughness widened by how fast its shading normal turns across the pixel (`n_dx`,
// `n_dy`: `dpdx` and `dpdy` of the unit normal), the geometric specular AA a built-in surface gets
// on the HDR scene (the surface chunk's `gx_filtered_roughness`), so a small or curved shiny
// surface does not sparkle. Unchanged on the legacy LDR scene. Take the derivatives in uniform
// control flow: `let n = normalize(in.normal); gx_filter_specular_v2(s, dpdx(n), dpdy(n))`.
fn gx_filter_specular_v2(s: GxSurface, n_dx: vec3<f32>, n_dy: vec3<f32>) -> GxSurface {
    var filtered = s;
    if gx_scene_shades_hdr() {
        filtered.roughness = gx_filtered_roughness(s.roughness, n_dx, n_dy);
    }
    return filtered;
}

// Scene radiance as the scene target stores it: times the pre-exposure on the HDR path (never
// negative and held under the half-float limit, as the forward output writes it, so a blinding
// emissive never stores inf), clamped and sRGB-encoded on the legacy LDR scene.
fn gx_expose(color: vec3<f32>) -> vec3<f32> {
    if frame.scene_ldr == 1u {
        return gx_encode_ldr(color);
    }
    return min(max(color, vec3<f32>(0.0)) * frame.pre_exposure, vec3<f32>(GX_SCENE_RADIANCE_MAX));
}

// The cascade blend band and the end fade of the preset's sun shadows, which GxFrameV2 does not
// carry: the renderer sets both when it builds the pipeline, with the shadow filter.
override GX_SUN_BLEND_BAND: f32 = 0.0;
override GX_SUN_END_FADE: f32 = 0.0;

// The scene pixel `world_pos` lands on (the sun's soft filters turn their taps by it).
fn gx_scene_pixel(world_pos: vec3<f32>) -> vec2<f32> {
    let clip = frame.view_proj * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xy / max(clip.w, 1e-6);
    return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * frame.render_size;
}

// The renderer's own shading of `s` in the order its forward pass applies it (ambient, the sun,
// the local lights, fog), exposed for the scene target: what a built-in surface writes, the sun's
// shadows filtered, blended across cascades and faded out as the preset draws them, and on the HDR
// scene the sun a disc for the highlight (`gx_sun_area_direction`, renderer pass 2 P2-0.12).
fn gx_shade_pbr(s: GxSurface) -> vec3<f32> {
    gx_sun_shadow_context(gx_scene_pixel(s.world_pos), frame.frame_index, GX_SUN_BLEND_BAND);
    gx_sun_shadow_end_fade(GX_SUN_END_FADE);
    var sun = normalize(frame.sun_dir.xyz);
    if gx_scene_shades_hdr() {
        sun = gx_sun_area_direction(sun, frame.sun_dir.w, s.n, s.v);
    }
    var color = gx_ambient(s);
    color += gx_sun(s, sun);
    color = gx_local_lights(color, s);
    color = gx_apply_fog_aerial(color, s.world_pos, gx_aerial_at(s.world_pos));
    return gx_expose(color);
}

// sRGB-encoded → linear (for colours authored in sRGB).
fn gx_srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

// The view distance of a depth value under this frame's projection.
fn gx_linear_depth(depth: f32) -> f32 {
    return gx_view_distance(frame.proj, depth);
}

// --- The RQ4 screen-effect accessors the lighting chunks call (shaders/effects.wgsl), read from
// this map as the forward pass reads its own: the frame's fog, `ao_map` (1x1 unoccluded until AO
// runs), the sun's `contact_shadow_mask` (1x1 unshadowed until contact shadows run) and the
// `aerial_perspective` volume (a texel of no air where it is not drawn). AO and the mask are at
// the render size, so the texel under the pixel is the pixel's own.

// The frame's fog (GxFrameV2's fog_color and fog_params).
fn gx_fog() -> GxFog {
    return GxFog(frame.fog_color, frame.fog_params);
}

// The texel of a screen-space map of `size` that `world_pos` projects to.
fn gx_screen_texel_v2(world_pos: vec3<f32>, size: vec2<u32>) -> vec2<i32> {
    let clip = frame.view_proj * vec4<f32>(world_pos, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-6);
    let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    let texels = vec2<i32>(size);
    return clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), texels - vec2<i32>(1));
}

// Whether a v2 material reads the AO term: always (the neutral term reads exactly 1).
// The sun chunk's comparison bias for `cascade`: the v2 frame carries one shared bias
// (`shadow_params.x`): cascade 0's on depth32 maps, whose light depths span one multiple of their
// map widths so it is every cascade's world bias, `shadow::DEPTH_BIAS` otherwise (renderer pass 2,
// P2-0.3). A per-cascade lane in `GxFrameV2` is an ABI decision.
fn gx_sun_cascade_bias(cascade: u32) -> f32 {
    return frame.shadow_params.x;
}

// The surface chunk's texture mip bias: the pipeline's constant alone (the v2 frame carries no
// texture lane; renderer pass 2 P2-0.8b T-06 left `GxFrameV2` unchanged).
fn gx_texture_lod_bias() -> f32 {
    return GX_TEXTURE_LOD_BIAS;
}

fn gx_ao_drawn() -> bool {
    return true;
}

// Ambient occlusion at `world_pos`: xyz the bent normal (zero: none), w the visibility.
fn gx_ambient_occlusion(world_pos: vec3<f32>) -> vec4<f32> {
    return gx_ao_decode(textureLoad(ao_map, gx_screen_texel_v2(world_pos, textureDimensions(ao_map)), 0));
}

// The sun's visibility from the screen mask (renderer pass 2, B.7): none for a v2 material (-1),
// which is drawn after the prepass the mask was made from, so the sun chunk shades it inline.
fn gx_sun_screen_shadow(world_pos: vec3<f32>) -> f32 {
    return -1.0;
}

// The sun's screen-space contact shadow at `world_pos` (1: unshadowed).
fn gx_contact_shadow(world_pos: vec3<f32>) -> f32 {
    return textureLoad(contact_shadow_mask, gx_screen_texel_v2(world_pos, textureDimensions(contact_shadow_mask)), 0).r;
}

// The volume's slices (fog::AERIAL_SIDE).
const GX_AERIAL_SIDE_V2: f32 = 32.0;

// The aerial-perspective volume's texel at `world_pos` (the forward pass's `gx_aerial_at`):
// sampled inside half a texel of the edges and faded to no air in front of the first slice.
fn gx_aerial_at(world_pos: vec3<f32>) -> vec4<f32> {
    let uvw = gx_aerial_froxel(world_pos);
    let half = 0.5 / GX_AERIAL_SIDE_V2;
    let held = clamp(uvw, vec3<f32>(half), vec3<f32>(1.0 - half));
    let air = textureSampleLevel(aerial_perspective, env_sampler, held, 0.0);
    let f = clamp(uvw.z / half, 0.0, 1.0);
    return vec4<f32>(air.rgb * f, 1.0 - (1.0 - air.a) * f);
}
