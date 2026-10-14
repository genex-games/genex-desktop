//! GPU-facing structs. Each is `#[repr(C)]` of explicit `[f32; N]`/`u32` fields with hand padding
//! to its WGSL struct of the same name, never a glam type: Rapier's `enhanced-determinism` turns
//! glam to scalar math, which drops `repr(align(16))` from `Vec4`/`Mat4` (README "Renderer rule").
//! tests/layout.rs holds every size to naga's layout of the WGSL and to one golden table in builds
//! with and without Rapier.

use bytemuck::{Pod, Zeroable};

/// Point lights the light table holds; more are ignored (the scene's first ones are kept).
pub const MAX_LIGHTS: usize = 256;
/// Local lights (points and spots) the binned path (RQ6) holds at most: the high and ultra
/// presets' cap. Lights past a preset's cap are dropped farthest first, never truncated per tile.
pub const MAX_LOCAL_LIGHTS: usize = 1024;
/// The cascades the frozen v1 prefix of the frame carries (`cascade_view_proj`, `GxFrameV1`) and
/// today's default count. The renderer draws 1 to [`MAX_CASCADES`] (RQ3).
pub const SHADOW_CASCADES: usize = 2;
/// Most sun shadow cascades a frame draws (RQ3); unused rows of the frame's cascade members are 0.
pub const MAX_CASCADES: usize = 4;
/// Most spot lights with a shadow map a frame draws (RQ6.5), each one cull view.
pub const MAX_SHADOWED_SPOTS: usize = 4;
/// Cull views reserved per frame: the camera (view 0), then one per drawn cascade, then one per
/// shadowed spot. The cull views uniform reserves all of them; the visible list and the indirect
/// arguments are sized per *active* view ([`crate::scene::FramePlan::views`]), so an unused view
/// allocates nothing.
pub const MAX_VIEWS: usize = 1 + MAX_CASCADES + MAX_SHADOWED_SPOTS;
/// The non-filtering sampler PCSS's blocker search gathers the shadow map with (RQ3.2), as
/// (forward frame binding, WGSL name): the RQ4 `point_sampler` slot of
/// [`FRAME_EFFECT_BINDINGS`], which the Level-2 v2 material map binds under the same name.
/// WebGPU core samples a depth texture only with a comparison or a non-filtering sampler.
pub const SHADOW_BLOCKER_SAMPLER: (u32, &str) = (18, "point_sampler");
/// The texture index that names no texture (`NO_TEXTURE` in the shaders).
pub const NO_TEXTURE: u32 = u32::MAX;
/// The material texture size classes, by class index (RQ6.0): each class is its own pair of
/// texture arrays (sRGB colour, data) of this side. Class 0 is today's 256-texel array pair.
pub const TEXTURE_SIZE_CLASSES: [u32; 4] = [256, 512, 1024, 2048];
/// Where a material texture reference keeps its size class: the class in the bits from here up,
/// the layer below. Class 0 references are the bare layer, so tables written before size classes
/// keep their bytes; [`NO_TEXTURE`] has every bit set and is never a class-15 reference.
pub const TEXTURE_CLASS_SHIFT: u32 = 28;
/// The layer bits of a material texture reference.
pub const TEXTURE_LAYER_MASK: u32 = (1 << TEXTURE_CLASS_SHIFT) - 1;

/// A material texture reference (`GpuMaterial::textures`): `layer` of size class `class`
/// ([`TEXTURE_SIZE_CLASSES`]). Class 0 is the bare layer.
pub const fn texture_ref(class: u32, layer: u32) -> u32 {
    (class << TEXTURE_CLASS_SHIFT) | (layer & TEXTURE_LAYER_MASK)
}

/// The size class and layer of a material texture reference; `None` for [`NO_TEXTURE`].
pub const fn texture_ref_parts(reference: u32) -> Option<(u32, u32)> {
    if reference == NO_TEXTURE {
        return None;
    }
    Some((reference >> TEXTURE_CLASS_SHIFT, reference & TEXTURE_LAYER_MASK))
}
/// The slot-base entry of a slot no batch uses this frame.
pub const NO_BATCH: u32 = u32::MAX;

/// Per-frame uniforms (`FrameUniforms` in every shader).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuFrame {
    /// Projection × view, column-major.
    pub view_proj: [f32; 16],
    /// Camera position (xyz).
    pub camera_pos: [f32; 4],
    /// Unit view direction (xyz): a fragment's view depth picks its shadow cascade.
    pub camera_forward: [f32; 4],
    /// Direction towards the sun (xyz, unit).
    pub sun_dir: [f32; 4],
    /// Sun radiance (linear rgb, intensity folded in).
    pub sun_color: [f32; 4],
    /// Ambient radiance (linear rgb); w: 1 when the environment replaces it (RQ2: a sky or a map
    /// lights the scene and its bake has landed), 0 otherwise.
    pub ambient: [f32; 4],
    /// Frustum planes (xyz normal pointing in, w distance), normalized: left, right, bottom, top, near, far.
    pub planes: [[f32; 4]; 6],
    /// Light projection × view of the first two shadow cascades, column-major: the frozen v1
    /// prefix (`cascade_view_proj_v1` in WGSL). Shaders read every cascade from
    /// [`GpuFrame::cascade_matrices`].
    pub cascade_view_proj: [[f32; 16]; SHADOW_CASCADES],
    /// x, y: the view depth where cascade 0 and cascade 1 end; z: the pre-exposure the HDR scene
    /// is written with (0 on the legacy LDR scene; auto exposure copies its GPU value here,
    /// `FRAME_PRE_EXPOSURE_OFFSET`; v1 compat frames read 0); w: 1 when the sun casts shadows.
    pub cascade_splits: [f32; 4],
    /// x: depth bias; y, z: normal offset of cascade 0 and 1 (world units); w: one shadow texel in uv.
    pub shadow_params: [f32; 4],
    /// x: point lights in the light table; y: batches; z: cull views; w: visible-list rows per view.
    pub counts: [u32; 4],
    // --- Past the frozen v1 prefix (RQ3.0): `GxFrameV1` and the compat copy end above. The
    // cascade members keep `GxFrameV2`'s names and meanings, so the sun chunk reads them in the
    // forward pass and the Level-2 v2 prelude alike.
    /// Light projection × view of each drawn cascade, column-major (`cascade_view_proj` in WGSL);
    /// rows past the drawn cascades are 0. The first two equal the v1 prefix's.
    pub cascade_matrices: [[f32; 16]; MAX_CASCADES],
    /// The view depth where each cascade ends; 0 past the drawn cascades, so the drawn count is
    /// the leading run of positive ends.
    pub cascade_ends: [f32; 4],
    /// Each cascade's normal offset, world units.
    pub cascade_offsets: [f32; 4],
    /// One shadow texel of each cascade in world units (PCSS converts its world-unit penumbra to
    /// each cascade's texels with it).
    pub cascade_texels: [f32; 4],
    /// x: tan of the sun's angular radius (the penumbra's growth per world unit of
    /// receiver-to-blocker distance); y: the cascade blend band, a fraction of each cascade's
    /// depth range blended into the next (0: a hard switch); z: the end fade, the fraction of the
    /// last cascade's depth range over which the shadows fade out (0: a hard end); w: reserved (0).
    pub shadow_soft: [f32; 4],
    /// x: cascades drawn; y: shadowed spot lights drawn (RQ6.5); z: the frame index the
    /// sun chunk's soft filters turn their taps with under TAA (its low 32 bits); w: reserved (0).
    pub shadow_counts: [u32; 4],
    /// xy: TAA's sub-pixel offset of the camera's projection in NDC (y up; RQ5.6), what every
    /// camera depth writer's `gx_clip_position` adds (0 without TAA: the position is
    /// `view_proj * world`, byte for byte the unjittered one); zw: last frame's (this frame's after
    /// a history reset; the v2 frame's `prev_jitter`, RQ5 review). `view_proj` stays unjittered,
    /// so motion vectors, the fog and the cull read the camera as it is.
    pub jitter: [f32; 4],
}

/// One point light in the light table (`Light`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuLight {
    /// Position (xyz) and range (w).
    pub position_range: [f32; 4],
    /// Radiance (linear rgb, intensity folded in).
    pub color: [f32; 4],
}

/// What a local light is (`LightExt::params.y`, `GX_LIGHT_*` in the shaders), as the f32 the
/// light-extension row stores (small integers are exact in f32, and the row is all f32 so the
/// Level-2 v2 prelude reads it as `array<vec4<f32>>`).
pub const LIGHT_KIND_POINT: f32 = 0.0;
/// A spot light: a point light inside a cone ([`GpuLightExt::spot`]).
pub const LIGHT_KIND_SPOT: f32 = 1.0;
/// The shadow slot of a local light without a shadow map.
pub const NO_SHADOW_SLOT: f32 = -1.0;
/// `vec4<f32>`s one light takes in the light-extension table (`light_ext`): its [`GpuLightExt`].
pub const LIGHT_EXT_VEC4S: usize = 2;
/// `vec4<f32>`s one shadowed spot's light view-projection takes in the light-extension table.
/// The matrices follow the lights' rows: shadow slot `k`'s columns start at vec4
/// `LIGHT_EXT_VEC4S * lights + SPOT_MATRIX_VEC4S * k`.
pub const SPOT_MATRIX_VEC4S: usize = 4;

/// One local light's extension row (`LightExt`, RQ6.0), parallel to the light table at the same
/// row, so [`GpuLight`] (and the Level-2 v2 `lights` binding) keeps its 32 bytes. Bound as the
/// `light_ext` table (`array<vec4<f32>>`, [`LIGHT_EXT_VEC4S`] per light).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuLightExt {
    /// xyz: the unit direction a spot's cone points along (0 for a point); w: the cosine of the
    /// cone's outer half-angle (-1 for a point: no cone).
    pub spot: [f32; 4],
    /// x: the cosine of the cone's inner half-angle (-1 for a point); y: the kind
    /// ([`LIGHT_KIND_POINT`], [`LIGHT_KIND_SPOT`]); z: the shadow slot (0 to
    /// [`MAX_SHADOWED_SPOTS`] - 1, [`NO_SHADOW_SLOT`] without a shadow map; its layer of the
    /// shared shadow array is the spot atlas after the drawn cascades, its tile the slot's,
    /// `spot_shadow::tile_rect`); w: reserved (0).
    pub params: [f32; 4],
}

impl GpuLightExt {
    /// The extension row of a point light: no cone, no shadow map.
    pub const POINT: GpuLightExt = GpuLightExt { spot: [0.0, 0.0, 0.0, -1.0], params: [-1.0, LIGHT_KIND_POINT, NO_SHADOW_SLOT, 0.0] };
}

/// One local light as the CPU builds it (RQ6.0): the light-table row and its extension row. It is
/// never uploaded whole; the frame writes `light` into the light table and `ext` into the
/// light-extension table at the same row.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GpuLocalLight {
    /// Position, range and radiance.
    pub light: GpuLight,
    /// Kind, cone and shadow slot.
    pub ext: GpuLightExt,
}

/// A material row's extension (RQ6.0): the Level-2 v2 `GxMaterialExt`, parallel to the material
/// table at the same row, so [`GpuMaterial`] (and the frozen v1 `GxMaterial`) keeps its 48 bytes.
/// The renderer's forward pass and v2 materials read one table: `emissive` is the emissive
/// radiance (linear rgb, scene units, its strength folded in; a: reserved) and `params` holds the
/// emissive texture: x its layer (-1: none), y its size class, z flag bits
/// ([`MATERIAL_EXT_FLAG_*`](MATERIAL_EXT_FLAG_EMISSIVE)), w reserved; all f32, exact as small
/// integers.
pub type GpuMaterialExt = crate::abi::GxMaterialExt;

/// [`GpuMaterialExt`] flag: the material emits light (its emissive radiance is not 0 or it has
/// an emissive texture).
pub const MATERIAL_EXT_FLAG_EMISSIVE: u32 = 1;
/// The emissive texture layer of a material without one ([`GpuMaterialExt`] `params.x`).
pub const MATERIAL_EXT_NO_TEXTURE: f32 = -1.0;

/// The extension row of a material that emits nothing: what every row holds until RQ6.3 fills it.
pub const MATERIAL_EXT_NONE: GpuMaterialExt = GpuMaterialExt { emissive: [0.0; 4], params: [MATERIAL_EXT_NO_TEXTURE, 0.0, 0.0, 0.0] };

/// One instance in the instance table (`Instance`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuInstance {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Inverse-transpose of the model matrix (normals), column-major.
    pub normal: [f32; 16],
    /// World-space bounding sphere: centre (xyz) and radius (w).
    pub bounds: [f32; 4],
    /// Index into the material table.
    pub material: u32,
    /// Padding to 16 bytes.
    pub pad: [u32; 3],
}

/// One material in the material table (`Material`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuMaterial {
    /// Base colour, linear rgb and alpha.
    pub base_color: [f32; 4],
    /// x: metallic, y: roughness, z: 1 for the missing-asset checker, w: normal-map scale.
    pub params: [f32; 4],
    /// Texture-array layers: x base colour (sRGB array), y normal map, z metallic-roughness (data
    /// array), w unused; [`NO_TEXTURE`] when absent.
    pub textures: [u32; 4],
}

/// One batch: the instances of one mesh (`Batch`), read by the cull pass.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuBatch {
    /// First instance-table row of the batch.
    pub first_instance: u32,
    /// Rows in the batch.
    pub instance_count: u32,
    /// Indices of the mesh.
    pub index_count: u32,
    /// First index of the mesh in the shared index buffer.
    pub first_index: u32,
    /// Base vertex of the mesh in its vertex buffer (the library, or the skinned output).
    pub base_vertex: i32,
    /// Padding to 32 bytes.
    pub pad: [u32; 3],
}

/// The per-pass dynamic uniform (`PassView`). WebGPU core has no `first_instance` in indirect
/// draws (`INDIRECT_FIRST_INSTANCE` is optional) and no draw index, so a multi-draw cannot tell
/// its draws apart by instance. Each vertex carries a slot instead (its mesh, or its skinned job)
/// and the vertex shader finds the batch's visible-list region through the slot-base table; a
/// transparent draw names its row directly.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuPassView {
    /// The cull view: 0 the camera, 1 + c shadow cascade c, then the shadowed spots.
    pub view: u32,
    /// 0: the region comes from the vertex's slot; 1: `base` is the visible-list row.
    pub direct: u32,
    /// The visible-list row of a direct (transparent) draw.
    pub base: u32,
    /// Padding to 16 bytes.
    pub pad: u32,
}

/// What the cull pass reads about its views (`CullViews`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuCullViews {
    /// Inward frustum planes of each view, normalized; views past the active ones are 0.
    pub planes: [[[f32; 4]; 6]; MAX_VIEWS],
    /// x: visible-list rows per view (the opaque instance count); y: batches; z: active views (the
    /// cull dispatches this many); w: the views the frame holds (bit `v`: a far cascade off its
    /// cadence keeps last frame's map, so the cull and the meshlet cull skip it).
    pub params: [u32; 4],
}

/// `draw_indexed_indirect` arguments as the cull pass writes them (`DrawIndexedArgs`), tightly
/// packed per view so one `multi_draw_indexed_indirect` reads a view's batches.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct DrawIndexedArgs {
    /// Indices per instance.
    pub index_count: u32,
    /// Visible instances.
    pub instance_count: u32,
    /// First index.
    pub first_index: u32,
    /// Base vertex.
    pub base_vertex: i32,
    /// Always 0 (WebGPU core).
    pub first_instance: u32,
}

/// A mesh vertex as the skinning pass reads and writes it (`MeshVertex`); the same bytes as
/// [`crate::mesh::Vertex`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuMeshVertex {
    /// Position, normal, uv, tangent (xyzw), as twelve floats.
    pub data: [f32; 12],
}

/// One vertex's skin (`SkinVertex`): four joint indices into its skin and their weights.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuSkinVertex {
    /// Joint indices.
    pub joints: [u32; 4],
    /// Weights, summing to 1.
    pub weights: [f32; 4],
}

/// One compute-skinning job (`SkinJob`): one skinned draw's vertices into the skinned output.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuSkinJob {
    /// First bind-pose vertex in the library's vertex buffer.
    pub src_base: u32,
    /// Vertices.
    pub count: u32,
    /// First vertex in the skinned output.
    pub dst_base: u32,
    /// First joint matrix of the draw in the joint table.
    pub joint_base: u32,
    /// First skin row of the mesh in the skin table.
    pub skin_base: u32,
    /// The slot the output vertices carry.
    pub slot: u32,
    /// Padding to 32 bytes.
    pub pad: [u32; 2],
}

/// The present pass's uniforms (`BlitParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuBlitParams {
    /// The letterbox rectangle in window pixels: x, y, width, height.
    pub viewport: [f32; 4],
    /// The world target's width and height; z, w unused.
    pub world: [f32; 4],
}

/// The auto exposure state the exposure node keeps on the GPU (`ExposureState` in
/// `shaders/post/exposure_adapt.wgsl`): read only by shaders, never by the Sim. `exposure` is at
/// offset 0, the source of the next frame's `GxFrameV2::pre_exposure` copy.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuExposureState {
    /// The exposure multiplier the next frame writes its scene with.
    pub exposure: f32,
    /// The adapted scene EV.
    pub ev: f32,
    /// The metered (target) scene EV of the last histogram.
    pub target_ev: f32,
    /// Bit 0: adapt instantly (captures, history resets).
    pub flags: u32,
}

/// One bake step of the environment (`IblBake` in `shaders/ibl/*.wgsl`, RQ2.1): which face and
/// mip of the specular cube a dispatch writes, from which source, at which roughness. Fields
/// marked reserved are zero until a pass gives them a meaning (the struct's size never changes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuIblBake {
    /// x, y: cos and sin of the map's rotation about the up axis; z: the radiance multiplier;
    /// w: the largest radiance a source texel keeps (an analytic HDRI sun is clamped out; 0: no clamp).
    pub source: [f32; 4],
    /// x: the face (0..6), y: the mip written, z: the cube's mips, w: samples per texel.
    pub dest: [u32; 4],
    /// x: the mip's GGX roughness; y: the source cube's side in texels (mip 0); z: the source's
    /// mips; w: reserved.
    pub prefilter: [f32; 4],
    /// x: the frame index of the time-sliced schedule; y: the written mip's side in texels;
    /// z, w: reserved.
    pub schedule: [u32; 4],
}

/// The physical sky's atmosphere and sun (`SkyAtmosphere` in `shaders/sky/*.wgsl`, RQ2.2):
/// Hillaire's model, distances in kilometres, scattering per kilometre.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuSkyAtmosphere {
    /// xyz: unit direction towards the sun; w: its angular radius in radians.
    pub sun_dir: [f32; 4],
    /// rgb: the sun's illuminance at the top of the atmosphere (scene units); w: the sky's
    /// radiance multiplier.
    pub sun_illuminance: [f32; 4],
    /// rgb: the ground's albedo; w: the camera's height above the ground.
    pub ground_albedo: [f32; 4],
    /// x: the planet's radius; y: the atmosphere's top radius; z: the ozone layer's centre
    /// height; w: its width.
    pub radii: [f32; 4],
    /// rgb: Rayleigh scattering at sea level; w: its density falloff (1 / scale height).
    pub rayleigh: [f32; 4],
    /// x: Mie scattering; y: Mie extinction; z: the Mie phase asymmetry g; w: its density falloff.
    pub mie: [f32; 4],
    /// rgb: ozone absorption at the layer's peak; w: the multiple-scattering factor.
    pub ozone: [f32; 4],
    /// x, y: the transmittance LUT's size; z, w: the sky-view LUT's size.
    pub luts: [u32; 4],
    /// x: the multiple-scattering LUT's side; y: the aerial-perspective volume's side (0: off);
    /// z: the frame index of the update cadence; w: reserved.
    pub params: [u32; 4],
}

/// The frame bind group's environment bindings (forward group 0, after the textures; RQ2.0), as
/// (binding, WGSL name): the names the Level-2 v2 material map gives the same inputs, so the
/// shared lighting chunks read one set of names in the forward pass and in `gx_shade_pbr`. Until
/// the environment bake lands they hold the neutral inputs (a black cube, zero SH, the split-sum
/// identity), so the picture is the flat-ambient one.
pub const FRAME_ENV_BINDINGS: [(u32, &str); 4] = [(11, "env_specular"), (12, "env_sh"), (13, "brdf_lut"), (14, "env_sampler")];

/// The forward frame group's slots reserved for the RQ4 screen effects (RQ4.0), as (binding, WGSL
/// name): the fog row (`GxFog`), ambient occlusion, the aerial-perspective volume and the
/// non-filtering sampler they are read with (the Level-2 v2 material map's names and types), and
/// the sun's contact-shadow mask. The forward pass declares the slots whose producers the renderer
/// binds ([`FRAME_EFFECT_BOUND`]; shaders/forward_effects.wgsl), each neutral on a frame whose node
/// does not run, so such a frame draws as before RQ4; the others stay free until theirs land.
pub const FRAME_EFFECT_BINDINGS: [(u32, &str); 5] =
    [(15, "frame_fog"), (16, "ao_map"), (17, "aerial_perspective"), (18, "point_sampler"), (19, "contact_shadow_mask")];

/// The effect slots of [`FRAME_EFFECT_BINDINGS`] the forward frame group binds (RQ4.6): the fog
/// row, the AO term, the aerial-perspective volume and the contact-shadow mask. The volume is read
/// with the environment's filtering sampler, so `point_sampler` stays free.
pub const FRAME_EFFECT_BOUND: [(u32, &str); 4] = [(15, "frame_fog"), (16, "ao_map"), (17, "aerial_perspective"), (19, "contact_shadow_mask")];

/// The forward frame group's local-light and material-extension tables (RQ6.0), as (binding, WGSL
/// name): the names and types the Level-2 v2 material map gives them, so the shared lighting
/// chunks read one set of names in the forward pass and in `gx_shade_pbr`. The renderer binds
/// them from the first frame (each a table that is at least one row, zero until its producer
/// lands: no light is binned and no material emits); the forward pass declares one once its
/// work package reads it.
pub const FRAME_LIGHT_BINDINGS: [(u32, &str); 4] = [(20, "light_ext"), (21, "light_tiles"), (22, "light_zbins"), (23, "material_ext")];

/// The forward frame group's texture arrays of the larger material size classes (RQ6.0), as
/// (binding, WGSL name), colour then data per class of [`TEXTURE_SIZE_CLASSES`] past class 0
/// (whose arrays are bindings 8 and 9). Each is a filterable `texture_2d_array<f32>`, a 1 × 1
/// placeholder until its class holds a texture (RQ6.4, sampled since RQ6.7 through the surface
/// chunk's `gx_class_texel`); the forward fragment stage stays within
/// `abi::FORWARD_FRAGMENT_TEXTURES_MAX` (14 of core's 16) with every RQ4 effect slot bound too.
pub const FRAME_MATERIAL_CLASS_BINDINGS: [(u32, &str); 6] = [
    (24, "color_textures_512"),
    (25, "data_textures_512"),
    (26, "color_textures_1024"),
    (27, "data_textures_1024"),
    (28, "color_textures_2048"),
    (29, "data_textures_2048"),
];

/// One meshlet of the library's meshlet table (`Meshlet`, R2): at most
/// [`crate::meshlet::MESHLET_MAX_VERTICES`] vertices and [`crate::meshlet::MESHLET_MAX_TRIANGLES`]
/// triangles of one mesh. The same 48 bytes are a record of the `genex_meshlets` GLB extras
/// (version 1, offsets relative to the primitive's own arrays; genex-render/README.md).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuMeshlet {
    /// Object-space bounding sphere: centre (xyz) and radius (w).
    pub bounds: [f32; 4],
    /// Normal cone: unit axis (xyz) and cutoff (w), meshoptimizer's convention: the meshlet faces
    /// away from a viewer at `p` when `dot(centre - p, axis) >= cutoff * |centre - p| + radius`.
    /// A meshlet without a usable cone stores cutoff 1 (never back-facing).
    pub cone: [f32; 4],
    /// First entry of the meshlet's vertices in the meshlet vertex buffer.
    pub vertex_offset: u32,
    /// First entry of the meshlet's packed triangles in the triangle buffer.
    pub triangle_offset: u32,
    /// Vertices, 1 to 64.
    pub vertex_count: u32,
    /// Triangles, 1 to 124.
    pub triangle_count: u32,
}

/// One opaque instance drawn through meshlets (`MeshletInstance`, R2): its instance-table row,
/// its mesh's meshlet range and its first candidate (instance × meshlet pair), which is also its
/// first bit in the visibility history.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuMeshletInstance {
    /// The instance-table row.
    pub instance: u32,
    /// The mesh's first meshlet in the meshlet table.
    pub first_meshlet: u32,
    /// The mesh's meshlets.
    pub meshlet_count: u32,
    /// The instance's first candidate: the exclusive prefix sum of `meshlet_count` in table order.
    pub first_candidate: u32,
}

/// One drawn-meshlet slot of a view (`DrawnMeshlet`, R2): the compacted index buffer's index
/// `slot << MESHLET_LOCAL_BITS | local` names this slot and the meshlet-local vertex, and vertex
/// pulling reads the instance and the meshlet from here.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuDrawnMeshlet {
    /// The instance-table row.
    pub instance: u32,
    /// The meshlet-table row.
    pub meshlet: u32,
}

/// What the meshlet cull reads about one dispatch (`MeshletCull`, R2): both occlusion passes and
/// the three scan dispatches share it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuMeshletCull {
    /// x: candidates (instance × meshlet pairs); y: meshlet instances; z: cull views; w: the
    /// occlusion pass (1: last frame's visible set, 2: every candidate against the new Hi-Z).
    pub counts: [u32; 4],
    /// x, y: the Hi-Z pyramid's mip-0 size; z: its mips; w: 1 under reverse-Z (min reduction).
    pub hiz: [u32; 4],
    /// x: index capacity per view; y: drawn-slot capacity per view; z: scan blocks; w: flags
    /// (bit 0 occlusion on, bit 1 history reset: last frame's visible set is empty).
    pub capacity: [u32; 4],
    /// x, y: the render size's uv to the Hi-Z mip 0's (render / (2 × base)); z, w: reserved.
    pub hiz_uv: [f32; 4],
}

/// One Hi-Z reduction dispatch (`HizParams`, R2.2): the level it reads and the level it writes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuHizParams {
    /// x, y: the source's size (the depth target for mip 0, else the previous mip); z, w: the
    /// destination mip's size.
    pub size: [u32; 4],
    /// x: the destination mip; y: the reduction (0 max under standard Z, 1 min under reverse-Z);
    /// z, w: reserved.
    pub params: [u32; 4],
}

/// One row of the previous-model table (`PrevModel`, RQ5.0): parallel to the instance table, at
/// the same row, so [`GpuInstance`] (and the published v1 `GxInstance`) keeps its 160 bytes. The
/// prepass reads it for per-object motion ([`crate::motion`]).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuPrevModel {
    /// Last frame's model matrix, column-major (this frame's when the row has no history).
    pub model: [f32; 16],
    /// x: `motion::MOTION_FLAG_*` bits; y, z, w: reserved (0).
    pub flags: [u32; 4],
}

/// What the light binning writes and the shading reads about the bins (`LightBinParams`, RQ6.0):
/// the light binning dispatch's uniform, and the header of the `light_zbins` table (its first
/// [`crate::cluster::LIGHT_BIN_HEADER_WORDS`] words), so the forward pass and the Level-2 v2
/// prelude find the grid without another binding. All `u32`: the two depths are f32 bits.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct GpuLightBinParams {
    /// x, y: screen tiles across and down; z: mask words per tile (`ceil(lights / 32)`); w: the
    /// tile's side in pixels.
    pub grid: [u32; 4],
    /// x: z-bins; y: lights binned (the depth-sorted list's length); z: the view depth where
    /// z-bin 0 starts (f32 bits); w: z-bins per unit of view depth (f32 bits).
    pub depth: [u32; 4],
}

/// The bind group the meshlet draw's vertex pulling reads (R2.0): group 2, after the frame (0)
/// and the pass view (1), so the forward frame group is shared unchanged.
pub const MESHLET_DRAW_GROUP: u32 = 2;

/// The meshlet draw group's bindings, as (binding, WGSL name): the library's vertices (pulled
/// from storage), the meshlet table, the meshlet vertex buffer (library vertex ids) and this
/// view's drawn-meshlet slots. Each is read-only storage visible to the vertex stage.
pub const MESHLET_DRAW_BINDINGS: [(u32, &str); 4] = [(0, "mesh_vertices"), (1, "meshlets"), (2, "meshlet_vertices"), (3, "drawn_meshlets")];

/// How a compute pass may access a storage texture of one format (plan §2.3's format rules).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StorageRule {
    /// Written only: a read-modify-write pass ping-pongs between two textures.
    WriteOnly,
    /// Read and written in place.
    ReadWrite,
}

/// The only formats a renderer compute pass writes as storage textures, and how (plan §2.3, the
/// RQ2.0 format rule table). WebGPU core guarantees each: `rgba16float` and `rgba8unorm` as
/// write-only storage, `r32float` read-write. Everything else (`rg16float` BRDF LUT, normals and
/// motion, `r8unorm` AO and TAA's reactive mask) is written by fragment passes ([`FRAGMENT_WRITTEN_FORMATS`]).
pub const COMPUTE_STORAGE_FORMATS: &[(wgpu::TextureFormat, StorageRule)] = &[
    (wgpu::TextureFormat::Rgba16Float, StorageRule::WriteOnly),
    (wgpu::TextureFormat::R32Float, StorageRule::ReadWrite),
    (wgpu::TextureFormat::Rgba8Unorm, StorageRule::WriteOnly),
];

/// Targets a fragment pass writes because core has no storage for their format: (what, format).
pub const FRAGMENT_WRITTEN_FORMATS: &[(&str, wgpu::TextureFormat)] = &[
    ("brdf-lut", wgpu::TextureFormat::Rg16Float),
    ("normals", wgpu::TextureFormat::Rg16Float),
    ("motion", wgpu::TextureFormat::Rg16Float),
    ("ao", wgpu::TextureFormat::R8Unorm),
    ("contact-shadows", wgpu::TextureFormat::R8Unorm),
    ("reactive", wgpu::TextureFormat::R8Unorm),
];

/// Storage textures one shader stage of the renderer binds at most (core's limit).
pub const STORAGE_TEXTURES_PER_STAGE_MAX: u32 = 4;
/// Workgroup shared memory one renderer compute entry point declares at most, in bytes (core's).
pub const WORKGROUP_SHARED_BYTES_MAX: u32 = 16 * 1024;

/// A GPU struct's Rust layout, for the layout check.
#[derive(Clone, Copy, Debug)]
pub struct GpuStructLayout {
    /// The WGSL struct of the same layout.
    pub wgsl: &'static str,
    /// `size_of` the Rust struct.
    pub rust_size: usize,
    /// `align_of` the Rust struct.
    pub rust_align: usize,
}

const fn layout_of<T>(wgsl: &'static str) -> GpuStructLayout {
    GpuStructLayout { wgsl, rust_size: size_of::<T>(), rust_align: align_of::<T>() }
}

/// Every GPU-facing struct and the WGSL struct it mirrors.
pub const GPU_STRUCTS: &[GpuStructLayout] = &[
    layout_of::<GpuFrame>("FrameUniforms"),
    layout_of::<GpuLight>("Light"),
    layout_of::<GpuInstance>("Instance"),
    layout_of::<GpuMaterial>("Material"),
    layout_of::<GpuBatch>("Batch"),
    layout_of::<GpuPassView>("PassView"),
    layout_of::<GpuCullViews>("CullViews"),
    layout_of::<DrawIndexedArgs>("DrawIndexedArgs"),
    layout_of::<GpuMeshVertex>("MeshVertex"),
    layout_of::<GpuSkinVertex>("SkinVertex"),
    layout_of::<GpuSkinJob>("SkinJob"),
    layout_of::<GpuBlitParams>("BlitParams"),
    layout_of::<GpuExposureState>("ExposureState"),
    layout_of::<crate::abi::GxEnvSh>("GxEnvSh"),
    layout_of::<GpuIblBake>("IblBake"),
    layout_of::<GpuSkyAtmosphere>("SkyAtmosphere"),
    layout_of::<crate::fog::GpuFog>("GxFog"),
    layout_of::<crate::post::bloom::GpuBloomParams>("BloomParams"),
    layout_of::<crate::post::ao::GpuAoParams>("AoParams"),
    layout_of::<crate::post::contact_shadow::GpuContactShadowParams>("ContactShadowParams"),
    layout_of::<GpuMeshlet>("Meshlet"),
    layout_of::<GpuMeshletInstance>("MeshletInstance"),
    layout_of::<GpuDrawnMeshlet>("DrawnMeshlet"),
    layout_of::<GpuMeshletCull>("MeshletCull"),
    layout_of::<GpuHizParams>("HizParams"),
    layout_of::<GpuPrevModel>("PrevModel"),
    layout_of::<crate::post::taa::GpuTaaParams>("TaaParams"),
    layout_of::<crate::post::fsr::GpuEasuParams>("EasuParams"),
    layout_of::<crate::post::fsr::GpuRcasParams>("RcasParams"),
    layout_of::<GpuLightExt>("LightExt"),
    layout_of::<GpuMaterialExt>("GxMaterialExt"),
    layout_of::<GpuLightBinParams>("LightBinParams"),
];
