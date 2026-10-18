//! The WGSL extension points (extension ladder level 2): `gfx.material(path, uniforms)` and
//! `gfx.post_pass(path)`, on fixed, versioned bind-group layouts. A source is admitted at the api
//! its `[[wgsl]]` row declares ([`validate_api`]; [`validate`] is api 1); [`EXTENSION_APIS`] are
//! the versions served (the capability receipt's `extensionApis`, highest `extensionApi`). Old
//! versions keep loading.
//!
//! # Layout, version 1
//!
//! The renderer prepends a prelude ([`crate::shaders::MATERIAL_PRELUDE`],
//! [`crate::shaders::POST_PRELUDE`]) that declares the renderer's bindings and the vertex stage;
//! the game's source adds one fragment entry point and, optionally, one uniform block:
//!
//! | kind | renderer bindings | the game's | entry point |
//! | --- | --- | --- | --- |
//! | material | `@group(0) @binding(0) gx_frame`, `@group(1) @binding(0) gx_draw` | `@group(2) @binding(0) var<uniform>` | `fs_material(GxMaterialIn)` |
//! | post pass | `@group(0) @binding(0) gx_source`, `@binding(1) gx_sampler`, `@binding(2) gx_post` | `@group(1) @binding(0) var<uniform>` | `fs_post(GxPostIn)` |
//!
//! A material's `gx_frame` is a prefix of the frozen [`crate::abi::GxFrameV1`] bytes, read from a
//! compat buffer refreshed each frame (as Level-3 passes read theirs), never the renderer's own
//! frame uniforms: the renderer's layout may change without moving a shipped v1 material. A v1
//! material returns sRGB-encoded colour, so a v1 material in an HDR-requested session draws the
//! frame on the legacy LDR scene instead ([`CustomMaterials::ldr_reason`], `material-v1-in-hdr`):
//! WGSL cannot wrap its entry point, and nothing is refused. v1 post passes run at stage `ldr`.
//!
//! # Layout, version 2 (RQ1)
//!
//! The v2 preludes ([`crate::shaders::MATERIAL_V2_PRELUDE`], [`crate::shaders::POST_V2_PRELUDE`])
//! declare the whole reserved group map ([`crate::abi::MATERIAL_V2_BINDINGS`],
//! [`crate::abi::POST_V2_BINDINGS`]): group 0 is the renderer's, group 1 the draw's (reserved and
//! empty for post passes), group 2 the game's and group 3 is reserved. The game's group 2 holds
//! one `var<uniform>` at [`GAME_UNIFORM_BINDING`], up to [`GAME_TEXTURES_MAX`] `texture_2d<f32>`
//! from asset handles (`gfx.texture(path)`) from [`GAME_TEXTURE_FIRST_BINDING`], and the two
//! renderer samplers at [`GAME_SAMPLER_FIRST_BINDING`] (linear, repeating) and the binding after
//! it (nearest, clamped). Textures bind in order: a source gets as many as its highest texture
//! binding asks for. A v2 material's fragment returns what the scene stores (`gx_shade_pbr`,
//! `gx_expose`); a v2 post pass runs at stage [`PostStage::Hdr`] (after TAA's place, before bloom
//! and the tonemap) or [`PostStage::Ldr`] (v1's place).
//!
//! **Draw rows (renderer pass 2 A.0, LG-20 step 3).** A v2 material's group 1 is the frame's
//! read-only table of draw rows (`gx_draws`, one [`crate::abi::GxDrawV2`] per draw), and the draws
//! of one (material, mesh) pair are one instanced call. The geometry stage reads its instance's
//! row; `gx_draw` is a private copy the fragment reads as before: when a source's fragment reads
//! it, admission hands `fs_material` the instance's row (`@location(6)`) and opens its body by
//! copying that row in ([`ValidatedExtension::source`] is the opened text, on the same lines).
//!
//! **Declared inputs.** The bindings a v2 source's entry points actually read (naga's usage
//! analysis, not every prelude declaration) decide the frame inputs it asks the graph to produce
//! ([`ValidatedExtension::inputs`]: depth, normals, motion, environment, the HDR scene). A binding
//! whose producer is off or has not landed holds a 1x1 neutral resource
//! ([`crate::abi::NeutralInputs`]): the far plane for depth, zero motion and normals, no
//! environment light. A v2 post pass binds the depth/normal prepass's targets once the frame ran
//! it ([`PostFrame::depth`], [`PostFrame::normals`]; a source binding `gx_depth` or `gx_normals`
//! is what makes the prepass run, `prepass::ExtensionDemand::extension_inputs`), and its motion
//! target once the prepass wrote motion ([`PostFrame::motion`], RQ5: `rg16float` NDC motion,
//! current minus previous with the jitter removed, so `uv - gx_motion * vec2(0.5, -0.5)` is
//! where the pixel was last frame; zero where nothing moved and on frames without motion). A v2
//! material draws inside the world pass, which may be writing that depth, so it keeps the neutral
//! ones; its own pixels' motion is the camera's alone (the prepass draws custom geometry with
//! last frame's camera and this frame's model), so a moving custom draw under TAA should stay
//! slow or small.
//!
//! # Admission
//!
//! [`validate_api`] is the runtime's admission fact: the api is one served (`layout-mismatch`
//! naming it otherwise); the source is at most [`crate::WGSL_MAX_BYTES`]; naga parses the api's
//! prelude and the source; every binding is in the api's layout (uniforms at most
//! [`EXTENSION_UNIFORM_MAX_BYTES`]; a v2 refusal names the v2 layout); the entry points are
//! exactly the prelude's vertex stage and the source's fragment; naga validates it against WebGPU
//! core plus the native-enhanced features the game declared (`[gpu] native_features` in
//! `genex.toml`) that the device was opened with. A source that only admits at the other api is
//! refused `layout-mismatch` naming the api it is written for (a v1 source declared `api = 2`). A
//! source that validates only with a native feature the game did not declare, or the device lacks,
//! is refused `native-feature-missing`; every other refusal is `wgsl-too-large` with an
//! [`ExtensionFault`]. [`read_extension_source`] reads a source from the game's folder: relative,
//! by realpath inside it, regular files only.
//!
//! # On the GPU
//!
//! [`CustomMaterials`] draws inside the world pass (it is a [`WorldStage`]: `before_world` refreshes
//! the frame bytes, `opaque` draws) and [`PostPasses`] runs over a target after it. Their
//! pipelines are built against the session's [`PipelineFacts`] (scene format, samples, depth
//! convention), rebuilt when the presenter hands over new ones. v2 sources read [`GxFrameV2`] from a
//! [`FrameV2`] buffer: the renderer's frame uniforms remapped on the GPU, plus what the CPU knows
//! ([`FrameFacts`]: camera matrices, sizes, time, the depth convention and whether the scene is
//! LDR).
//!
//! v2 materials bind the renderer's light table, the binned path's light extension rows, tile
//! masks and z-bins (RQ6: points and spots), material table, texture arrays and sun shadow array
//! from the [`WorldPass`], so `gx_shade_pbr` lights them as the forward pass lights a built-in
//! surface. Sources without them (post passes, Level-3 passes) read a light count of 0
//! and sun shadows off in [`GxFrameV2`] (the remap clamps both by what [`FrameFacts`] says is bound).
//!
//! TODO(M7.0): the lane's host-side validator (M2.3's `genex-naga-check`) checks the raw source
//! today; given these preludes and layout rules it would refuse the same sources before a run.

use crate::compile::Compiled;
use std::path::{Component, Path};

use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, Features, Queue, RenderPipeline, ShaderStages, TextureFormat};

use crate::abi::{
    ABI_V1, ABI_V2, GX_FRAME_V2_BYTES, GxDrawV2, GxFrameV2, GxPostV2, MATERIAL_V2_BINDINGS, NeutralInputs, POST_V2_BINDINGS, RenderInputs,
    V2Binding, inputs_for, layout_entries,
};
pub use crate::abi::{EXTENSION_API_VERSION, EXTENSION_APIS, GAME_GROUP, GAME_SAMPLERS_MAX, GAME_TEXTURES_MAX};
pub use crate::error::ExtensionFault;
use crate::caps::{WGSL_MAX_BYTES, check_wgsl};
use crate::custom_pass::{PipelineFacts, depth_compare};
use crate::error::{RenderCode, RenderError};
use crate::floor::NATIVE_ENHANCED_FEATURES;
use crate::gpu::Gpu;
use crate::ibl::EnvironmentMaps;
use crate::limits::{CUSTOM_MATERIALS_MAX, EXTENSION_UNIFORM_MAX_BYTES, POST_PASSES_MAX, check_count};
use crate::renderer::{DEPTH_FORMAT, WORLD_FORMAT, WorldPass, WorldStage};
use crate::scene::{CameraDesc, MeshId};
use crate::settings::{FrameConfig, LdrReason, ShadowFilter};
use crate::shaders::{MATERIAL_PRELUDE, MATERIAL_V2_PRELUDE, POST_PRELUDE, POST_V2_PRELUDE};
use crate::tables::{VERTEX_STRIDE, buffer, entry, pipeline_layout, uniform};
use crate::texture::{TextureData, TextureKind, rect_mip_chain};

/// The longest naga diagnostic a refusal carries.
const DIAGNOSTIC_MAX_CHARS: usize = 2048;
/// Bytes between custom draws' rows in the per-draw uniform: WebGPU core's uniform offset alignment.
const DRAW_STRIDE: u64 = 256;
/// Bytes of one v2 draw row in `gx_draws` (packed: the instances of a call are adjacent rows).
const V2_ROW_BYTES: u64 = size_of::<GxDrawV2>() as u64;
/// The linear game sampler's anisotropic filtering (WebGPU core allows up to 16): a tiled ground
/// texture seen at a grazing angle stays sharp along the view instead of blurring to its far mips.
const GAME_SAMPLER_ANISOTROPY: u16 = 16;
/// Simulated seconds of one tick (60 Hz) for [`FrameFacts::delta_seconds`].
const TICK_SECONDS: f32 = 1.0 / 60.0;

/// The game group's uniform block (v2): `@group(2) @binding(0)`.
pub const GAME_UNIFORM_BINDING: u32 = 0;
/// The first of the game group's texture bindings (v2): textures bind in order from here.
pub const GAME_TEXTURE_FIRST_BINDING: u32 = 1;
/// The game group's first sampler (v2; linear, repeating); the next binding is nearest, clamped.
pub const GAME_SAMPLER_FIRST_BINDING: u32 = GAME_TEXTURE_FIRST_BINDING + GAME_TEXTURES_MAX;

/// What WebGPU core lets every shader use on top of naga's baseline (wgpu grants these from the
/// downlevel flags every WebGPU-compliant adapter has).
const CORE_CAPABILITIES: Capabilities = Capabilities::MULTISAMPLED_SHADING.union(Capabilities::CUBE_ARRAY_TEXTURES);

/// The naga capabilities each native-enhanced feature grants a shader (wgpu's own mapping for
/// these features). `MULTI_DRAW_INDIRECT_COUNT` is a draw call, not shader code: it grants none.
const FEATURE_CAPABILITIES: &[(Features, Capabilities)] = &[
    (Features::SHADER_INT64_ATOMIC_MIN_MAX, Capabilities::SHADER_INT64_ATOMIC_MIN_MAX),
    (Features::SHADER_INT64_ATOMIC_ALL_OPS, Capabilities::SHADER_INT64_ATOMIC_ALL_OPS.union(Capabilities::SHADER_INT64_ATOMIC_MIN_MAX)),
    (Features::SUBGROUP, Capabilities::SUBGROUP),
    (Features::EXPERIMENTAL_RAY_QUERY, Capabilities::RAY_QUERY),
    (Features::EXPERIMENTAL_MESH_SHADER, Capabilities::MESH_SHADER),
    (Features::TEXTURE_BINDING_ARRAY, Capabilities::TEXTURE_AND_SAMPLER_BINDING_ARRAY),
    (Features::MULTI_DRAW_INDIRECT_COUNT, Capabilities::empty()),
];

/// Which extension point a source is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExtensionKind {
    /// `gfx.material(path, uniforms)`: a fragment stage for meshes drawn in the world pass.
    Material,
    /// `gfx.post_pass(path)`: a full-frame fragment stage over a target.
    PostPass,
}

/// One binding of the fixed v1 layout.
struct Slot {
    group: u32,
    binding: u32,
    name: &'static str,
}

impl ExtensionKind {
    /// The wire spelling: `genex.toml`'s `[[wgsl]] kind` (the facade's and the host's `WgslKind`).
    pub const fn wire(self) -> &'static str {
        match self {
            ExtensionKind::Material => "material",
            ExtensionKind::PostPass => "post",
        }
    }

    /// The prelude of `api` (v1 for anything but v2; the api is checked before).
    const fn prelude(self, api: u32) -> &'static str {
        match (self, api == ABI_V2) {
            (ExtensionKind::Material, false) => MATERIAL_PRELUDE,
            (ExtensionKind::PostPass, false) => POST_PRELUDE,
            (ExtensionKind::Material, true) => MATERIAL_V2_PRELUDE,
            (ExtensionKind::PostPass, true) => POST_V2_PRELUDE,
        }
    }

    const fn vertex_entry(self, api: u32) -> &'static str {
        match (self, api == ABI_V2) {
            (ExtensionKind::Material, false) => "gx_vs_material",
            (ExtensionKind::PostPass, false) => "gx_vs_post",
            (ExtensionKind::Material, true) => "gx_vs_material_v2",
            (ExtensionKind::PostPass, true) => "gx_vs_post_v2",
        }
    }

    /// The fragment's input struct at `api` (what a refusal names).
    const fn fragment_input(self, api: u32) -> &'static str {
        match (self, api == ABI_V2) {
            (ExtensionKind::Material, false) => "GxMaterialIn",
            (ExtensionKind::PostPass, false) => "GxPostIn",
            (ExtensionKind::Material, true) => "GxMaterialInV2",
            (ExtensionKind::PostPass, true) => "GxPostInV2",
        }
    }

    /// The fragment entry point the game's source declares.
    pub const fn fragment_entry(self) -> &'static str {
        match self {
            ExtensionKind::Material => "fs_material",
            ExtensionKind::PostPass => "fs_post",
        }
    }

    /// The group the game's v1 uniform block sits in (binding 0); v2 uses [`GAME_GROUP`].
    pub const fn uniform_group(self) -> u32 {
        match self {
            ExtensionKind::Material => 2,
            ExtensionKind::PostPass => 1,
        }
    }

    const fn renderer_slots(self) -> &'static [Slot] {
        match self {
            ExtensionKind::Material => {
                &[Slot { group: 0, binding: 0, name: "gx_frame" }, Slot { group: 1, binding: 0, name: "gx_draw" }]
            }
            ExtensionKind::PostPass => &[
                Slot { group: 0, binding: 0, name: "gx_source" },
                Slot { group: 0, binding: 1, name: "gx_sampler" },
                Slot { group: 0, binding: 2, name: "gx_post" },
            ],
        }
    }

    /// The v2 map of the renderer's groups.
    const fn v2_table(self) -> &'static [V2Binding] {
        match self {
            ExtensionKind::Material => MATERIAL_V2_BINDINGS,
            ExtensionKind::PostPass => POST_V2_BINDINGS,
        }
    }

    /// How a refusal names the layout.
    const fn layout_name(self) -> &'static str {
        match self {
            ExtensionKind::Material => "material",
            ExtensionKind::PostPass => "post-pass",
        }
    }

    /// What group 1 is in the v2 layout.
    const fn group1_words(self) -> &'static str {
        match self {
            ExtensionKind::Material => "group 1 the draw's",
            ExtensionKind::PostPass => "group 1 is reserved",
        }
    }
}

/// Where a post pass runs (`gfx.post_pass(path, stage)`). v1 post passes run at `ldr`. Wire values
/// never change once shipped.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PostStage {
    /// After TAA's place and before bloom and the tonemap, on the scene (linear and pre-exposed on
    /// the HDR path; the legacy LDR scene otherwise): graph node 18.
    Hdr,
    /// After the 2D primitives, on the display-ready frame: graph node 23 (v1's place).
    Ldr,
}

impl PostStage {
    /// Every stage, in frame order.
    pub const ALL: [PostStage; 2] = [PostStage::Hdr, PostStage::Ldr];

    /// The stage's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            PostStage::Hdr => "hdr",
            PostStage::Ldr => "ldr",
        }
    }

    /// The stage spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<PostStage> {
        PostStage::ALL.into_iter().find(|stage| stage.wire() == wire)
    }
}

/// The native-enhanced features named in `genex.toml` (`[gpu] native_features`), by their wire
/// names; an unknown name is refused `native-feature-missing`.
pub fn native_features(names: &[&str]) -> Result<Features, RenderError> {
    let mut features = Features::empty();
    for name in names {
        let Some((feature, _)) = NATIVE_ENHANCED_FEATURES.iter().find(|(_, wire)| wire == name) else {
            return Err(RenderError::refused(RenderCode::NativeFeatureMissing, format!("`{name}` is not a native-enhanced feature")));
        };
        features |= *feature;
    }
    Ok(features)
}

/// The naga capabilities a shader may use with `features` on top of WebGPU core.
pub fn naga_capabilities(features: Features) -> Capabilities {
    FEATURE_CAPABILITIES
        .iter()
        .filter(|(feature, _)| features.contains(*feature))
        .fold(CORE_CAPABILITIES, |caps, (_, granted)| caps | *granted)
}

fn feature_names(features: Features) -> String {
    let names: Vec<&str> = NATIVE_ENHANCED_FEATURES.iter().filter(|(f, _)| features.contains(*f)).map(|(_, name)| *name).collect();
    names.join(", ")
}

/// What an extension may use: the native-enhanced features the game declared and the ones the
/// device was opened with. Only features in both are usable; undeclared features are never
/// requested, so a game without declarations validates against core. The renderer-owned features
/// the device is also opened with (`floor::RENDERER_FEATURES`) are never usable: they grant no
/// naga capability in wgpu 30 and are filtered out with every other non-native feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtensionContext {
    declared: Features,
    offered: Features,
}

impl ExtensionContext {
    /// WebGPU core: nothing declared, nothing offered.
    pub const fn core() -> ExtensionContext {
        ExtensionContext { declared: Features::empty(), offered: Features::empty() }
    }

    /// A game that declared `declared` on a device opened with `offered`.
    pub fn new(declared: Features, offered: Features) -> ExtensionContext {
        ExtensionContext { declared: native_only(declared), offered: native_only(offered) }
    }

    /// A game that declared `declared`, on `gpu`'s device.
    pub fn for_gpu(gpu: &Gpu, declared: Features) -> ExtensionContext {
        ExtensionContext::new(declared, gpu.device.features())
    }

    /// The declared features.
    pub fn declared(&self) -> Features {
        self.declared
    }

    /// Declared features the device has.
    pub fn usable(&self) -> Features {
        self.declared & self.offered
    }

    /// Refuse `native-feature-missing` when the device lacks a declared feature.
    pub fn check_device(&self) -> Result<(), RenderError> {
        let missing = self.declared - self.offered;
        if missing.is_empty() {
            return Ok(());
        }
        Err(RenderError::refused(
            RenderCode::NativeFeatureMissing,
            format!("the game declares {} and the device does not have it", feature_names(missing)),
        ))
    }
}

/// Only the native-enhanced features count: anything else a device has is not the game's to use.
fn native_only(features: Features) -> Features {
    NATIVE_ENHANCED_FEATURES.iter().filter(|(f, _)| features.contains(*f)).fold(Features::empty(), |all, (f, _)| all | *f)
}

/// The game group bindings a v2 source declares: its uniform block's size, and bit masks of the
/// texture and sampler slots (slot 0 is the first binding of each).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GameBindings {
    uniform: Option<u64>,
    textures: u32,
    samplers: u32,
}

/// An admitted extension: the full source (prelude and the game's), the api it was admitted
/// under, its game bindings, the native features it needs and the frame inputs it reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedExtension {
    kind: ExtensionKind,
    api: u32,
    source: String,
    game: GameBindings,
    needs: Features,
    inputs: RenderInputs,
}

impl ValidatedExtension {
    /// The extension API version it was admitted under (its `[[wgsl]] api`).
    pub fn api_version(&self) -> u32 {
        self.api
    }

    /// Which extension point it is for.
    pub fn kind(&self) -> ExtensionKind {
        self.kind
    }

    /// Bytes of its uniform block, when it declares one.
    pub fn uniform_bytes(&self) -> Option<u64> {
        self.game.uniform
    }

    /// The native-enhanced features it needs (empty for core).
    pub fn native_features(&self) -> Features {
        self.needs
    }

    /// The frame inputs its entry points read (v2; none at v1): what the graph produces for it.
    pub fn inputs(&self) -> RenderInputs {
        self.inputs
    }

    /// Game textures it binds: the highest texture slot it declares, plus one (0 for none).
    pub fn game_textures(&self) -> u32 {
        u32::BITS - self.game.textures.leading_zeros()
    }

    /// The prelude followed by the game's source: what the GPU compiles.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Refuse uniforms whose size is not the declared block's.
    pub fn check_uniforms(&self, uniforms: &[u8]) -> Result<(), RenderError> {
        let given = uniforms.len() as u64;
        if self.game.uniform.unwrap_or(0) == given {
            return Ok(());
        }
        Err(layout(format!("{given} bytes of uniforms for a block of {} bytes", self.game.uniform.unwrap_or(0))))
    }

    /// Refuse a texture count that is not the one its bindings ask for.
    pub fn check_textures(&self, given: usize) -> Result<(), RenderError> {
        let wanted = self.game_textures() as usize;
        if given == wanted {
            return Ok(());
        }
        Err(layout(format!(
            "{given} textures for a source that binds {wanted} (textures bind in order from @group({GAME_GROUP}) @binding({GAME_TEXTURE_FIRST_BINDING}))"
        )))
    }
}

fn layout(detail: impl Into<String>) -> RenderError {
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::LayoutMismatch, detail)
}

fn invalid(detail: impl Into<String>) -> RenderError {
    let mut detail: String = detail.into();
    if let Some((at, _)) = detail.char_indices().nth(DIAGNOSTIC_MAX_CHARS) {
        detail.truncate(at);
    }
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::Invalid, detail)
}

fn entry_point(detail: impl Into<String>) -> RenderError {
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::EntryPoint, detail)
}

/// Admit `source` for `kind` at extension API v1 under `context` (see the module docs).
pub fn validate(kind: ExtensionKind, source: &str, context: &ExtensionContext) -> Result<ValidatedExtension, RenderError> {
    validate_api(kind, ABI_V1, source, context)
}

/// Admit `source` for `kind` at extension API `api` (its `[[wgsl]] api`) under `context`, or refuse
/// it (see the module docs).
pub fn validate_api(kind: ExtensionKind, api: u32, source: &str, context: &ExtensionContext) -> Result<ValidatedExtension, RenderError> {
    if !EXTENSION_APIS.contains(&api) {
        let served: Vec<String> = EXTENSION_APIS.iter().map(u32::to_string).collect();
        return Err(layout(format!("extension API {api} is not one this renderer serves ({})", served.join(", "))));
    }
    check_wgsl(source).map_err(|_| {
        RenderError::extension(
            RenderCode::WgslTooLarge,
            ExtensionFault::TooLarge,
            format!("{} bytes of WGSL, at most {WGSL_MAX_BYTES}", source.len()),
        )
    })?;
    match admit(kind, api, source, context) {
        Err(error) if may_be_other_api(&error) => Err(written_for_other_api(kind, api, source, context).unwrap_or(error)),
        result => result,
    }
}

/// Whether a refusal may come from the source being written for another api (it does not parse,
/// validate or have its entry point against this api's prelude).
fn may_be_other_api(error: &RenderError) -> bool {
    matches!(ExtensionFault::of(error), Some(ExtensionFault::Invalid | ExtensionFault::EntryPoint))
}

/// The served extension API `source` admits at for `kind` under `context` (the lowest, when it
/// admits at more than one), or `None` when it admits at none: the typed fact behind a
/// `layout-mismatch` that names the api a source is written for.
pub fn written_for_api(kind: ExtensionKind, source: &str, context: &ExtensionContext) -> Option<u32> {
    EXTENSION_APIS.into_iter().find(|api| admit(kind, *api, source, context).is_ok())
}

/// The refusal of a source declared at `api` that admits at another served api.
fn written_for_other_api(kind: ExtensionKind, api: u32, source: &str, context: &ExtensionContext) -> Option<RenderError> {
    let other = written_for_api(kind, source, context).filter(|other| *other != api)?;
    Some(layout(format!(
        "the source is written for extension API v{other} (its fragment reads `{}`) and is declared api = {api}: \
         declare api = {other} in its [[wgsl]] row, or write it against `{}`",
        kind.fragment_input(other),
        kind.fragment_input(api)
    )))
}

fn admit(kind: ExtensionKind, api: u32, source: &str, context: &ExtensionContext) -> Result<ValidatedExtension, RenderError> {
    let prelude = kind.prelude(api);
    let full = format!("{prelude}\n{source}");
    let module = naga::front::wgsl::parse_str(&full).map_err(|error| invalid(error.emit_to_string(&full)))?;
    check_entry_points(kind, api, &module)?;
    let game = check_bindings(kind, api, &module)?;
    let (needs, info) = check_capabilities(&module, &full, context)?;
    let inputs = if api == ABI_V1 { RenderInputs::NONE } else { inputs_for(kind.v2_table(), &used_bindings(&module, &info)) };
    let reads_row = kind == ExtensionKind::Material && api == ABI_V2 && fragment_reads(&module, &info, DRAW_ROW_GLOBAL);
    let full = if reads_row { opened_draw_row(&full, prelude.len() + 1, context)? } else { full };
    Ok(ValidatedExtension { kind, api, source: full, game, needs, inputs })
}

/// The v2 material prelude's private copy of the fragment's draw row (`gx_draw`).
const DRAW_ROW_GLOBAL: &str = "gx_draw";
/// What [`opened_draw_row`] adds to `fs_material`'s parameters: the drawn instance's row, which
/// the v2 geometry stage writes at this location (`GxVertexOutV2::gx_row`).
const DRAW_ROW_PARAMETER: &str = "@location(6) @interpolate(flat) gx_row: u32, ";
/// What it opens `fs_material`'s body with: the row the instance draws with.
const DRAW_ROW_STORE: &str = " gx_draw = gx_draws[gx_row];";

/// Whether the fragment entry point (or a function it calls) reads or writes the private global
/// `name` (naga's usage analysis).
fn fragment_reads(module: &naga::Module, info: &ModuleInfo, name: &str) -> bool {
    let Some(entry) = module.entry_points.iter().position(|ep| ep.stage == naga::ShaderStage::Fragment) else { return false };
    let Some((handle, _)) = module.global_variables.iter().find(|(_, var)| var.name.as_deref() == Some(name)) else { return false };
    !info.get_entry_point(entry)[handle].is_empty()
}

/// `full` (the v2 material prelude, then the game's source from byte `game_at`) with the game's
/// `fs_material` handed its instance's row and opened by copying that row into `gx_draw`
/// (renderer pass 2 A.0, LG-20 step 3): the draws of one (material, mesh) pair are one instanced
/// call, and a fragment reading `gx_draw.prev_model` or `gx_draw.params` reads its own draw's.
/// Both insertions stay on the lines they are made on, so a diagnostic's line is unchanged; the
/// opened source is admitted again (a refusal here is the renderer's fault, named as one).
fn opened_draw_row(full: &str, game_at: usize, context: &ExtensionContext) -> Result<String, RenderError> {
    let not_opened = || layout("the renderer could not hand `fs_material` its draw row");
    let (parameters, body) = fs_material_openings(&full[game_at..]).ok_or_else(not_opened)?;
    let mut opened = String::with_capacity(full.len() + DRAW_ROW_PARAMETER.len() + DRAW_ROW_STORE.len());
    opened.push_str(&full[..game_at + parameters]);
    opened.push_str(DRAW_ROW_PARAMETER);
    opened.push_str(&full[game_at + parameters..game_at + body]);
    opened.push_str(DRAW_ROW_STORE);
    opened.push_str(&full[game_at + body..]);
    let module = naga::front::wgsl::parse_str(&opened).map_err(|_| not_opened())?;
    check_capabilities(&module, &opened, context).map_err(|_| not_opened())?;
    Ok(opened)
}

/// One WGSL token of [`wgsl_tokens`]: an identifier or a single punctuation character, and the
/// byte just after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WgslToken<'a> {
    Word(&'a str, usize),
    Mark(char, usize),
}

/// The identifiers and punctuation of `source` outside comments (`//` lines and nested `/* */`
/// blocks); numbers read as words. Enough to find a function's parameter list and body: WGSL has
/// no strings, and neither its attributes nor its types hold braces.
fn wgsl_tokens(source: &str) -> Vec<WgslToken<'_>> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let rest = &bytes[at..];
        if rest.starts_with(b"//") {
            at += rest.iter().position(|b| *b == b'\n').unwrap_or(rest.len());
        } else if rest.starts_with(b"/*") {
            at += block_comment_len(rest);
        } else if bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_' {
            let end = at + rest.iter().position(|b| !(b.is_ascii_alphanumeric() || *b == b'_')).unwrap_or(rest.len());
            tokens.push(WgslToken::Word(&source[at..end], end));
            at = end;
        } else {
            let mark = source[at..].chars().next().unwrap_or(' ');
            if !mark.is_whitespace() {
                tokens.push(WgslToken::Mark(mark, at + mark.len_utf8()));
            }
            at += mark.len_utf8();
        }
    }
    tokens
}

/// Bytes of the (nested) block comment `rest` starts with, to its end or the source's.
fn block_comment_len(rest: &[u8]) -> usize {
    let (mut depth, mut at) = (0usize, 0);
    while at < rest.len() {
        if rest[at..].starts_with(b"/*") {
            (depth, at) = (depth + 1, at + 2);
        } else if rest[at..].starts_with(b"*/") {
            (depth, at) = (depth - 1, at + 2);
            if depth == 0 {
                return at;
            }
        } else {
            at += 1;
        }
    }
    rest.len()
}

/// Where `fn fs_material(` 's parameters start and its body's `{` ends, in `game`.
fn fs_material_openings(game: &str) -> Option<(usize, usize)> {
    let tokens = wgsl_tokens(game);
    let named = tokens.windows(3).position(|t| {
        matches!(t, [WgslToken::Word("fn", _), WgslToken::Word(name, _), WgslToken::Mark('(', _)] if *name == ExtensionKind::Material.fragment_entry())
    })?;
    let WgslToken::Mark('(', parameters) = tokens[named + 2] else { return None };
    let mut depth = 1usize;
    for token in &tokens[named + 3..] {
        match (*token, depth) {
            (WgslToken::Mark('(', _), _) => depth += 1,
            (WgslToken::Mark(')', _), _) => depth = depth.checked_sub(1)?,
            (WgslToken::Mark('{', body), 0) => return Some((parameters, body)),
            _ => {}
        }
    }
    None
}

fn check_entry_points(kind: ExtensionKind, api: u32, module: &naga::Module) -> Result<(), RenderError> {
    let fragment = kind.fragment_entry();
    let has_fragment = module.entry_points.iter().any(|ep| ep.name == fragment && ep.stage == naga::ShaderStage::Fragment);
    if !has_fragment {
        return Err(entry_point(format!("no `@fragment fn {fragment}`")));
    }
    let allowed = [kind.vertex_entry(api), fragment];
    if let Some(stray) = module.entry_points.iter().find(|ep| !allowed.contains(&ep.name.as_str())) {
        return Err(entry_point(format!("`{}` is an entry point of its own; extension API v{api} takes only `{fragment}`", stray.name)));
    }
    Ok(())
}

/// Every resource binding is in `api`'s layout; answers the game group's bindings.
fn check_bindings(kind: ExtensionKind, api: u32, module: &naga::Module) -> Result<GameBindings, RenderError> {
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).map_err(|error| invalid(error.to_string()))?;
    let mut game = GameBindings::default();
    for (_, var) in module.global_variables.iter() {
        let Some(binding) = &var.binding else { continue };
        let at = (binding.group, binding.binding, var.name.as_deref().unwrap_or(""));
        if api == ABI_V1 {
            check_v1_binding(kind, at, var, &layouter, &mut game)?;
        } else {
            check_v2_binding(kind, at, module, var, &layouter, &mut game)?;
        }
    }
    Ok(game)
}

/// A v1 binding: the renderer's own, or the one uniform block.
fn check_v1_binding(
    kind: ExtensionKind,
    (group, slot, name): (u32, u32, &str),
    var: &naga::GlobalVariable,
    layouter: &naga::proc::Layouter,
    game: &mut GameBindings,
) -> Result<(), RenderError> {
    if kind.renderer_slots().iter().any(|s| s.group == group && s.binding == slot && s.name == name) {
        return Ok(());
    }
    let is_uniform = matches!(var.space, naga::AddressSpace::Uniform);
    if group != kind.uniform_group() || slot != 0 || !is_uniform {
        return Err(layout(format!(
            "@group({group}) @binding({slot}) `{name}` is not in extension API v1's layout: the game binds one var<uniform> at @group({}) @binding(0)",
            kind.uniform_group()
        )));
    }
    game.uniform = Some(uniform_size(layouter, var)?);
    Ok(())
}

fn uniform_size(layouter: &naga::proc::Layouter, var: &naga::GlobalVariable) -> Result<u64, RenderError> {
    let bytes = u64::from(layouter[var.ty].size);
    if bytes > EXTENSION_UNIFORM_MAX_BYTES {
        return Err(layout(format!("a {bytes}-byte uniform block, at most {EXTENSION_UNIFORM_MAX_BYTES}")));
    }
    Ok(bytes)
}

/// The refusal of a binding outside the v2 layout, naming it.
fn v2_layout(kind: ExtensionKind, (group, slot, name): (u32, u32, &str)) -> RenderError {
    let last_texture = GAME_TEXTURE_FIRST_BINDING + GAME_TEXTURES_MAX - 1;
    let last_sampler = GAME_SAMPLER_FIRST_BINDING + GAME_SAMPLERS_MAX - 1;
    layout(format!(
        "@group({group}) @binding({slot}) `{name}` is not in extension API v2's {} layout: group 0 is the renderer's, {}, \
         group {GAME_GROUP} the game's (one var<uniform> at @binding({GAME_UNIFORM_BINDING}), texture_2d<f32> at \
         @binding({GAME_TEXTURE_FIRST_BINDING}) to @binding({last_texture}), samplers at @binding({GAME_SAMPLER_FIRST_BINDING}) \
         and @binding({last_sampler})) and group 3 is reserved",
        kind.layout_name(),
        kind.group1_words()
    ))
}

/// A v2 binding: one row of the renderer's map under its own name, or a game group slot of its kind.
fn check_v2_binding(
    kind: ExtensionKind,
    at: (u32, u32, &str),
    module: &naga::Module,
    var: &naga::GlobalVariable,
    layouter: &naga::proc::Layouter,
    game: &mut GameBindings,
) -> Result<(), RenderError> {
    let (group, slot, name) = at;
    if group != GAME_GROUP {
        let known = kind.v2_table().iter().any(|row| row.group == group && row.binding == slot && row.name == name);
        return if known { Ok(()) } else { Err(v2_layout(kind, at)) };
    }
    let inner = &module.types[var.ty].inner;
    let is_uniform = matches!(var.space, naga::AddressSpace::Uniform);
    let textures = GAME_TEXTURE_FIRST_BINDING..GAME_SAMPLER_FIRST_BINDING;
    let samplers = GAME_SAMPLER_FIRST_BINDING..GAME_SAMPLER_FIRST_BINDING + GAME_SAMPLERS_MAX;
    if slot == GAME_UNIFORM_BINDING && is_uniform {
        game.uniform = Some(uniform_size(layouter, var)?);
        return Ok(());
    }
    if textures.contains(&slot) && is_float_texture_2d(inner) {
        game.textures |= 1 << (slot - GAME_TEXTURE_FIRST_BINDING);
        return Ok(());
    }
    if samplers.contains(&slot) && matches!(inner, naga::TypeInner::Sampler { comparison: false }) {
        game.samplers |= 1 << (slot - GAME_SAMPLER_FIRST_BINDING);
        return Ok(());
    }
    Err(v2_layout(kind, at))
}

fn is_float_texture_2d(inner: &naga::TypeInner) -> bool {
    matches!(
        inner,
        naga::TypeInner::Image {
            dim: naga::ImageDimension::D2,
            arrayed: false,
            class: naga::ImageClass::Sampled { kind: naga::ScalarKind::Float, multi: false },
        }
    )
}

/// The names of the bound globals some entry point reads or writes (naga's usage analysis).
fn used_bindings<'m>(module: &'m naga::Module, info: &ModuleInfo) -> Vec<&'m str> {
    let mut used = Vec::new();
    for index in 0..module.entry_points.len() {
        let function = info.get_entry_point(index);
        for (handle, var) in module.global_variables.iter() {
            let name = var.name.as_deref().unwrap_or("");
            if var.binding.is_some() && !function[handle].is_empty() && !used.contains(&name) {
                used.push(name);
            }
        }
    }
    used
}

fn validates(module: &naga::Module, capabilities: Capabilities) -> Result<ModuleInfo, String> {
    Validator::new(ValidationFlags::all(), capabilities).validate(module).map_err(|error| format!("{error:?}"))
}

/// Validate against core, then against the usable declared features; answers the features needed
/// and naga's analysis of the module.
fn check_capabilities(module: &naga::Module, source: &str, context: &ExtensionContext) -> Result<(Features, ModuleInfo), RenderError> {
    let core_error = match Validator::new(ValidationFlags::all(), CORE_CAPABILITIES).validate(module) {
        Ok(info) => return Ok((Features::empty(), info)),
        Err(error) => error,
    };
    let usable = context.usable();
    if let Some(info) = (!usable.is_empty()).then(|| validates(module, naga_capabilities(usable)).ok()).flatten() {
        // Only the usable features the source cannot validate without.
        let needed = NATIVE_ENHANCED_FEATURES
            .iter()
            .filter(|(f, _)| usable.contains(*f) && validates(module, naga_capabilities(usable - *f)).is_err())
            .fold(Features::empty(), |all, (f, _)| all | *f);
        return Ok((needed, info));
    }
    let every = NATIVE_ENHANCED_FEATURES.iter().fold(Features::empty(), |all, (f, _)| all | *f);
    if validates(module, naga_capabilities(every)).is_ok() {
        let wanted: Features = NATIVE_ENHANCED_FEATURES
            .iter()
            .filter(|(f, _)| validates(module, naga_capabilities(*f)).is_ok())
            .fold(Features::empty(), |all, (f, _)| all | *f);
        let named = if wanted.is_empty() { "several native-enhanced features".to_owned() } else { feature_names(wanted) };
        return Err(RenderError::refused(
            RenderCode::NativeFeatureMissing,
            format!("it needs {named}: declare it under [gpu] native_features in genex.toml, on a device that has it"),
        ));
    }
    Err(invalid(core_error.emit_to_string(source)))
}

fn path_refused(detail: impl Into<String>) -> RenderError {
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::PathRefused, detail)
}

/// Read an extension's source from `relative` inside the game folder `root`: relative, no `..`,
/// resolved by realpath inside `root`, a regular file (never a symlink), at most
/// [`WGSL_MAX_BYTES`] (checked before it is read). Nothing is written.
pub fn read_extension_source(root: &Path, relative: &str) -> Result<String, RenderError> {
    let path = Path::new(relative);
    let climbs = path.components().any(|c| !matches!(c, Component::Normal(_)));
    if relative.is_empty() || climbs {
        return Err(path_refused(format!("`{relative}` is not a relative path inside the game")));
    }
    let root = root.canonicalize().map_err(|e| path_refused(format!("the game folder: {e}")))?;
    let joined = root.join(path);
    let link = joined.symlink_metadata().map_err(|e| path_refused(format!("`{relative}`: {e}")))?;
    if link.file_type().is_symlink() {
        return Err(path_refused(format!("`{relative}` is a symlink")));
    }
    let real = joined.canonicalize().map_err(|e| path_refused(format!("`{relative}`: {e}")))?;
    if !real.starts_with(&root) {
        return Err(path_refused(format!("`{relative}` resolves outside the game")));
    }
    let meta = real.metadata().map_err(|e| path_refused(format!("`{relative}`: {e}")))?;
    if !meta.is_file() {
        return Err(path_refused(format!("`{relative}` is not a regular file")));
    }
    if meta.len() > WGSL_MAX_BYTES as u64 {
        return Err(RenderError::extension(
            RenderCode::WgslTooLarge,
            ExtensionFault::TooLarge,
            format!("`{relative}` is {} bytes, at most {WGSL_MAX_BYTES}", meta.len()),
        ));
    }
    std::fs::read_to_string(&real).map_err(|e| path_refused(format!("`{relative}`: {e}")))
}

// ---------------------------------------------------------------------------------------------
// The v2 frame on the GPU

/// What the CPU knows about a frame that v2 sources read in [`GxFrameV2`] beside the renderer's
/// own frame uniforms: the camera's matrices, the sizes, time, the depth convention, whether the
/// scene is the legacy LDR one and the exposure it is written with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameFacts {
    /// The camera (`view`, `proj` and their inverse; identity without one).
    pub camera: Option<CameraDesc>,
    /// The world target's size.
    pub output_size: (u32, u32),
    /// The scene's size (output × render scale).
    pub render_size: (u32, u32),
    /// Simulated seconds of one tick.
    pub delta_seconds: f32,
    /// Frames drawn since the last history reset.
    pub frame_index: u64,
    /// Whether temporal history starts over this frame.
    pub history_reset: bool,
    /// Whether depth is reversed (the HDR path).
    pub depth_reversed: bool,
    /// Whether the scene is the legacy LDR one (`gx_expose` encodes sRGB).
    pub scene_ldr: bool,
    /// The exposure the scene is written with (1 on the LDR scene; RQ1.2 copies the GPU's over it).
    pub pre_exposure: f32,
    /// The look's EV compensation (0 with the exposure switch off).
    pub ev_compensation: f32,
    /// The re-render's index within a settled capture.
    pub settle_index: u32,
    /// Whether the source binds the renderer's light table and sun shadow array (v2 materials):
    /// otherwise its frame reads no lights and no sun shadows.
    pub renderer_lights: bool,
    /// Whether the source binds the sun's shadow array alone (Level-3 passes, through the v2
    /// tables' `gx_shadow_map`): its frame then reads the sun's shadows but no lights.
    pub sun_shadows: bool,
    /// The frame's fog (GxFrameV2's `fog_color` and `fog_params`; density 0: none), the one the
    /// forward pass draws with ([`crate::renderer::Renderer::frame_fog`]), so `gx_apply_fog` fogs a
    /// v2 surface like a built-in one.
    pub fog: crate::fog::GpuFog,
}

impl FrameFacts {
    /// A frame of `output_size` drawn at `render_size` on the legacy LDR scene: standard Z, an
    /// exposure of 1, the first frame of its history, no camera.
    pub fn new(output_size: (u32, u32), render_size: (u32, u32)) -> FrameFacts {
        FrameFacts {
            camera: None,
            output_size,
            render_size,
            delta_seconds: TICK_SECONDS,
            frame_index: 0,
            history_reset: true,
            depth_reversed: false,
            scene_ldr: true,
            pre_exposure: 1.0,
            ev_compensation: 0.0,
            settle_index: 0,
            renderer_lights: false,
            sun_shadows: false,
            fog: crate::fog::GpuFog::default(),
        }
    }

    /// The facts of a frame drawn with `config` (its sizes, scene, depth and history).
    pub fn for_frame(config: &FrameConfig) -> FrameFacts {
        FrameFacts {
            frame_index: config.frame_index,
            history_reset: config.history_reset,
            depth_reversed: config.depth_reversed,
            scene_ldr: !config.hdr,
            settle_index: config.settle.map_or(0, |(index, _)| index),
            ..FrameFacts::new(config.output_size, config.render_size)
        }
    }

    /// The facts seen through `camera`.
    pub fn with_camera(self, camera: CameraDesc) -> FrameFacts {
        FrameFacts { camera: Some(camera), ..self }
    }

    /// The CPU half of [`GxFrameV2`] at `seconds`, with last frame's `view_proj` (`prev`); the GPU
    /// remap fills the renderer's members. Answers it and this frame's `view_proj`.
    fn gx_frame(&self, seconds: f32, prev: Option<[f32; 16]>) -> (GxFrameV2, Option<[f32; 16]>) {
        let size = |(w, h): (u32, u32)| [w as f32, h as f32];
        let mut frame = GxFrameV2 {
            render_size: size(self.render_size),
            output_size: size(self.output_size),
            pre_exposure: self.pre_exposure,
            inv_pre_exposure: 1.0 / self.pre_exposure.max(f32::MIN_POSITIVE),
            time: seconds,
            delta_time: self.delta_seconds,
            frame_index: self.frame_index as u32,
            depth_reversed: u32::from(self.depth_reversed),
            scene_ldr: u32::from(self.scene_ldr),
            settle_index: self.settle_index,
            history_reset: u32::from(self.history_reset),
            ev_compensation: self.ev_compensation,
            // The clamps the remap applies to the renderer's members: every light and the sun's
            // shadows where the source binds the renderer's tables, none otherwise.
            counts: [if self.renderer_lights { u32::MAX } else { 0 }, 0, 0, 0],
            cascade_splits: [0.0, 0.0, 0.0, if self.renderer_lights || self.sun_shadows { 1.0 } else { 0.0 }],
            fog_color: self.fog.color,
            fog_params: self.fog.params,
            ..GxFrameV2::from_frame(&crate::layout::GpuFrame::default())
        };
        let Some(camera) = self.camera else { return (frame, None) };
        let aspect = self.render_size.0 as f32 / self.render_size.1.max(1) as f32;
        // The projection the world pass draws with: reversed on the HDR path.
        let view_proj = if self.depth_reversed { camera.view_proj_reversed(aspect) } else { camera.view_proj(aspect) };
        let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::from(camera.eye), glam::Vec3::from(camera.target), glam::Vec3::from(camera.up));
        let this = view_proj.to_cols_array();
        frame.view = view.to_cols_array();
        frame.proj = (view_proj * view.inverse()).to_cols_array();
        frame.view_proj = this;
        frame.inv_view_proj = view_proj.inverse().to_cols_array();
        frame.unjittered_view_proj = this;
        frame.prev_view_proj = if self.history_reset { this } else { prev.unwrap_or(this) };
        frame.near = camera.near;
        frame.far = camera.far;
        (frame, Some(this))
    }
}

/// The compute pass that builds [`GxFrameV2`] on the GPU: the CPU's facts with the renderer's own
/// frame members copied in (so geometry lines up with the world bit for bit, and the pre-exposure
/// is the one the HDR scene is written with, auto exposure's included), the light count and the
/// sun's shadows clamped by what the facts say is bound.
pub const FRAME_V2_REMAP_WGSL: &str = concat!(
    include_str!("../shaders/common.wgsl"),
    "
// genex frame v2: FrameUniforms + the CPU's facts -> GxFrameV2.
@group(0) @binding(0) var<uniform> gx_source: FrameUniforms;
@group(0) @binding(1) var<uniform> gx_facts: GxFrameV2;
@group(0) @binding(2) var<storage, read_write> gx_out: GxFrameV2;

// `m` with TAA's jitter folded in as gx_clip_position adds it (clip.xy += jitter * clip.w), so a
// v2 source drawing through `view_proj` with GX_NO_JITTER lines up with the jittered world pass.
fn gx_jittered(m: mat4x4<f32>, jitter: vec2<f32>) -> mat4x4<f32> {
    if all(jitter == vec2<f32>(0.0)) {
        return m;
    }
    var out = m;
    for (var c = 0; c < 4; c++) {
        out[c] = vec4<f32>(m[c].xy + jitter * m[c].w, m[c].zw);
    }
    return out;
}

// The inverse of `gx_jittered(m, jitter)` from `inverse` (m's own): the jitter is a clip-space
// shear J (x += jitter.x * w, y += jitter.y * w), so (J m)^-1 = m^-1 J^-1, which changes only the
// last column: m^-1 (-jitter.x, -jitter.y, 0, 1).
fn gx_jittered_inverse(inverse: mat4x4<f32>, jitter: vec2<f32>) -> mat4x4<f32> {
    var out = inverse;
    out[3] = inverse[3] - jitter.x * inverse[0] - jitter.y * inverse[1];
    return out;
}

@compute @workgroup_size(1)
fn gx_frame_v2() {
    var frame = gx_facts;
    // The world pass's projection, jittered under TAA (zero jitter: the matrix as it is), with
    // its own inverse (the depth a pass reads was drawn jittered); `unjittered_view_proj` and
    // `prev_view_proj` keep the camera as it is for motion vectors.
    let jitter = gx_source.jitter.xy;
    frame.view_proj = gx_jittered(gx_source.view_proj, jitter);
    frame.proj = gx_jittered(gx_facts.proj, jitter);
    frame.inv_view_proj = gx_jittered_inverse(gx_facts.inv_view_proj, jitter);
    frame.jitter = jitter;
    // Last frame's jitter (the frame uniforms carry it in jitter.zw; this frame's after a reset).
    frame.prev_jitter = gx_source.jitter.zw;
    frame.camera_pos = gx_source.camera_pos;
    frame.camera_forward = gx_source.camera_forward;
    frame.sun_dir = gx_source.sun_dir;
    frame.sun_color = gx_source.sun_color;
    frame.ambient = gx_source.ambient;
    frame.planes = gx_source.planes;
    // Every drawn cascade (1 to 4); the rows past them keep the facts' identity.
    let drawn = min(gx_source.shadow_counts.x, 4u);
    for (var c = 0u; c < drawn; c++) {
        frame.cascade_view_proj[c] = gx_source.cascade_view_proj[c];
    }
    let shadowed = gx_source.cascade_splits.w * gx_facts.cascade_splits.w;
    frame.cascade_splits = vec4<f32>(gx_source.cascade_splits.xyz, shadowed);
    frame.shadow_params = gx_source.shadow_params;
    frame.cascade_ends = gx_source.cascade_ends;
    frame.cascade_offsets = gx_source.cascade_offsets;
    frame.counts = vec4<u32>(min(gx_source.counts.x, gx_facts.counts.x), drawn, 0u, 0u);
    // The HDR scene's pre-exposure as the frame uniforms hold it (auto exposure copies its GPU
    // value there); the legacy scene's lane is 0 and keeps the CPU's 1.
    let pre_exposure = gx_source.cascade_splits.z;
    if pre_exposure > 0.0 {
        frame.pre_exposure = pre_exposure;
        frame.inv_pre_exposure = 1.0 / pre_exposure;
    }
    gx_out = frame;
}
"
);

/// The v2 frame buffer v2 sources bind (`frame`, `gx_frame`) and the pass that fills it.
#[derive(Debug)]
pub struct FrameV2 {
    facts: Buffer,
    frame: Buffer,
    layout: BindGroupLayout,
    pipeline: Compiled<wgpu::ComputePipeline>,
    last_view_proj: Option<[f32; 16]>,
}

impl FrameV2 {
    /// The buffers and the remap pipeline on `device`.
    pub fn new(device: &Device) -> Result<FrameV2, RenderError> {
        let frame_bytes = wgpu::BufferSize::new(GX_FRAME_V2_BYTES);
        let binding = |binding, ty| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: if binding == 0 { None } else { frame_bytes } },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx frame v2"),
            entries: &[
                binding(0, wgpu::BufferBindingType::Uniform),
                binding(1, wgpu::BufferBindingType::Uniform),
                binding(2, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let module = crate::shaders::module(device, "gx frame v2", FRAME_V2_REMAP_WGSL)?;
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("gx frame v2"),
            layout: Some(&pipeline_layout(device, "gx frame v2", &[&layout])),
            module: &module,
            entry_point: Some("gx_frame_v2"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(FrameV2 {
            facts: buffer(device, "gx frame v2 facts", GX_FRAME_V2_BYTES, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            frame: buffer(device, "gx frame v2", GX_FRAME_V2_BYTES, BufferUsages::UNIFORM | BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC)?,
            layout,
            pipeline,
            last_view_proj: None,
        })
    }

    /// The buffer v2 bind groups take (binding size [`GX_FRAME_V2_BYTES`]).
    pub fn buffer(&self) -> &Buffer {
        &self.frame
    }

    /// Write this frame's CPU facts at `seconds` (ahead of [`FrameV2::refresh`]).
    pub fn write(&mut self, queue: &Queue, facts: &FrameFacts, seconds: f32) {
        let (frame, view_proj) = facts.gx_frame(seconds, self.last_view_proj);
        queue.write_buffer(&self.facts, 0, frame.as_bytes());
        self.last_view_proj = view_proj.or(self.last_view_proj);
    }

    /// Read the v2 frame back (tests and diagnostics; after the remap's submission).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_back(&self, gpu: &Gpu) -> Result<GxFrameV2, RenderError> {
        let staging = crate::readback::stage_buffer(gpu, &self.frame, 0, GX_FRAME_V2_BYTES)?;
        let bytes = crate::readback::map_read_blocking(gpu, &staging, GX_FRAME_V2_BYTES)?;
        Ok(bytemuck::pod_read_unaligned(&bytes[..GX_FRAME_V2_BYTES as usize]))
    }

    /// Record the remap from `frame_uniforms` (the renderer's, written for this frame) into
    /// `encoder`: work after it reads this frame's [`GxFrameV2`].
    pub fn refresh(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, frame_uniforms: &Buffer) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gx frame v2"),
            layout: &self.layout,
            entries: &[entry(0, frame_uniforms), entry(1, &self.facts), entry(2, &self.frame)],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("gx frame v2"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
}

/// The two renderer samplers of the game group: linear and repeating, nearest and clamped.
fn game_samplers(device: &Device) -> [wgpu::Sampler; GAME_SAMPLERS_MAX as usize] {
    let repeat = wgpu::AddressMode::Repeat;
    [
        device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("gx game linear"),
            address_mode_u: repeat,
            address_mode_v: repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: GAME_SAMPLER_ANISOTROPY,
            ..Default::default()
        }),
        device.create_sampler(&wgpu::SamplerDescriptor { label: Some("gx game nearest"), ..Default::default() }),
    ]
}

/// What the v2 sources of one renderer share: the neutral inputs, the frame bytes and the samplers.
struct V2Shared {
    neutral: NeutralInputs,
    frame: FrameV2,
    samplers: [wgpu::Sampler; GAME_SAMPLERS_MAX as usize],
}

impl V2Shared {
    fn new(gpu: &Gpu) -> Result<V2Shared, RenderError> {
        Ok(V2Shared { neutral: NeutralInputs::new(&gpu.device, &gpu.queue), frame: FrameV2::new(&gpu.device)?, samplers: game_samplers(&gpu.device) })
    }
}

// ---------------------------------------------------------------------------------------------
// The environment v2 sources read (RQ2.5)

/// The environment as v2 sources bind it (RQ2.5): the prefiltered specular cube, the SH9
/// irradiance block (`GxEnvSh`), the split-sum BRDF LUT and the environment sampler, taken from
/// the [`EnvironmentMaps`] the renderer's own frame binds (its bake once it ran, else the neutral
/// inputs), so `gx_shade_pbr` lights a v2 material with the light a built-in surface gets. Cheap
/// to clone (wgpu handles); equal views bind the same resources, so a holder rebuilds its bind
/// groups only when the bake replaced one.
#[derive(Clone, Debug, PartialEq)]
pub struct EnvironmentViews {
    specular: wgpu::TextureView,
    sh: Buffer,
    brdf_lut: wgpu::TextureView,
    sampler: wgpu::Sampler,
}

impl EnvironmentViews {
    /// What `maps` binds now (`layout::FRAME_ENV_BINDINGS`): its bake once it ran, else its
    /// neutral inputs. None only if `maps` stopped answering one of its bindings.
    pub fn of(maps: &EnvironmentMaps) -> Option<EnvironmentViews> {
        let view = |name: &str| match maps.binding(name)? {
            wgpu::BindingResource::TextureView(view) => Some(view.clone()),
            _ => None,
        };
        let wgpu::BindingResource::Buffer(sh) = maps.binding(ENV_SH)? else { return None };
        let wgpu::BindingResource::Sampler(sampler) = maps.binding(ENV_SAMPLER)? else { return None };
        Some(EnvironmentViews { specular: view(ENV_SPECULAR)?, sh: sh.buffer.clone(), brdf_lut: view(ENV_BRDF_LUT)?, sampler: sampler.clone() })
    }

    /// The resource bound under `name` in a v2 map: the material map's `env_specular`, `env_sh`,
    /// `brdf_lut` and `env_sampler`, the post-pass map's and the Level-3 tables' `gx_env_specular`
    /// and `gx_env_sh`, and the Level-3 environment group's `gx_brdf_lut` and `gx_env_sampler`
    /// (`custom_pass::ENVIRONMENT_BINDINGS`). None for any other name.
    pub fn resource(&self, name: &str) -> Option<wgpu::BindingResource<'_>> {
        match name.strip_prefix("gx_").unwrap_or(name) {
            ENV_SPECULAR => Some(wgpu::BindingResource::TextureView(&self.specular)),
            ENV_SH => Some(sized(&self.sh, size_of::<crate::abi::GxEnvSh>() as u64)),
            ENV_BRDF_LUT => Some(wgpu::BindingResource::TextureView(&self.brdf_lut)),
            ENV_SAMPLER => Some(wgpu::BindingResource::Sampler(&self.sampler)),
            _ => None,
        }
    }

    /// The environment rows of `table` with their resources (rows this does not feed are left out).
    pub fn bound<'a>(&'a self, table: &[V2Binding]) -> Vec<(&'static str, wgpu::BindingResource<'a>)> {
        table.iter().filter_map(|row| Some((row.name, self.resource(row.name)?))).collect()
    }
}

/// The environment's binding names in the material map (the forward pass's own names).
const ENV_SPECULAR: &str = "env_specular";
const ENV_SH: &str = "env_sh";
const ENV_BRDF_LUT: &str = "brdf_lut";
const ENV_SAMPLER: &str = "env_sampler";

/// A source's game group on the GPU: its layout and bind group, the uniform buffer it writes and
/// the textures it holds.
struct GameGroup {
    layout: BindGroupLayout,
    group: BindGroup,
    uniform: Option<Buffer>,
    _textures: Vec<wgpu::Texture>,
}

/// A uniform buffer holding `bytes` (rounded up to 16).
fn uniform_buffer(device: &Device, queue: &Queue, bytes: &[u8]) -> Result<Buffer, RenderError> {
    let size = (bytes.len() as u64).div_ceil(16) * 16;
    let target = buffer(device, "extension uniforms", size, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    queue.write_buffer(&target, 0, bytes);
    Ok(target)
}

/// A v1 source's uniform group over `layout` (`None` for no bytes).
fn v1_group(device: &Device, queue: &Queue, layout: &BindGroupLayout, bytes: &[u8]) -> Result<Option<GameGroup>, RenderError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let target = uniform_buffer(device, queue, bytes)?;
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("extension uniforms"), layout, entries: &[entry(0, &target)] });
    Ok(Some(GameGroup { layout: layout.clone(), group, uniform: Some(target), _textures: Vec::new() }))
}

/// A game texture: sRGB-encoded RGBA8 with its whole mip chain, averaged in linear light
/// (`texture::rect_mip_chain`), so a tiled texture far smaller than a pixel reads its average.
fn game_texture(device: &Device, queue: &Queue, data: &TextureData) -> wgpu::Texture {
    let chain = rect_mip_chain(data, TextureKind::Color);
    let size = wgpu::Extent3d { width: data.width(), height: data.height(), depth_or_array_layers: 1 };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gx game texture"),
        size,
        mip_level_count: u32::try_from(chain.len()).unwrap_or(1),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (level, mip) in chain.iter().enumerate() {
        let extent = wgpu::Extent3d { width: mip.width(), height: mip.height(), depth_or_array_layers: 1 };
        let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * mip.width()), rows_per_image: Some(mip.height()) };
        let target = wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
        queue.write_texture(target, mip.rgba(), layout, extent);
    }
    texture
}

/// A v2 source's game group: its uniform block, its textures in order and the samplers it
/// declares (`None` when it binds nothing there).
fn v2_group(gpu: &Gpu, extension: &ValidatedExtension, uniforms: &[u8], textures: &[TextureData], shared: &V2Shared) -> Result<Option<GameGroup>, RenderError> {
    let game = extension.game;
    if game.uniform.is_none() && game.textures == 0 && game.samplers == 0 {
        return Ok(None);
    }
    let (device, queue) = (&gpu.device, &gpu.queue);
    let stages = ShaderStages::VERTEX_FRAGMENT;
    let block = game.uniform.map(|_| uniform_buffer(device, queue, uniforms)).transpose()?;
    let held: Vec<wgpu::Texture> = textures.iter().map(|data| game_texture(device, queue, data)).collect();
    let views: Vec<wgpu::TextureView> = held.iter().map(|texture| texture.create_view(&Default::default())).collect();
    let mut entries = Vec::new();
    let mut resources = Vec::new();
    if let Some(target) = &block {
        entries.push(uniform(GAME_UNIFORM_BINDING, false, stages));
        resources.push(wgpu::BindGroupEntry { binding: GAME_UNIFORM_BINDING, resource: target.as_entire_binding() });
    }
    let texture_type = crate::abi::BindingKind::Texture2d.binding_type(false, 0);
    for (slot, view) in views.iter().enumerate().filter(|(slot, _)| game.textures & (1 << slot) != 0) {
        let binding = GAME_TEXTURE_FIRST_BINDING + slot as u32;
        entries.push(wgpu::BindGroupLayoutEntry { binding, visibility: stages, ty: texture_type, count: None });
        resources.push(wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) });
    }
    for (slot, sampler) in shared.samplers.iter().enumerate().filter(|(slot, _)| game.samplers & (1 << slot) != 0) {
        let binding = GAME_SAMPLER_FIRST_BINDING + slot as u32;
        entries.push(wgpu::BindGroupLayoutEntry { binding, visibility: stages, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None });
        resources.push(wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::Sampler(sampler) });
    }
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("gx game group"), entries: &entries });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("gx game group"), layout: &layout, entries: &resources });
    Ok(Some(GameGroup { layout, group, uniform: block, _textures: held }))
}

/// A bind group of `group` of a v2 map: the renderer's resources named in `bound`, neutral
/// resources for the rest.
fn v2_renderer_group<'a>(
    device: &Device,
    layout: &BindGroupLayout,
    table: &[V2Binding],
    group: u32,
    neutral: &'a NeutralInputs,
    depth_reversed: bool,
    bound: &[(&str, wgpu::BindingResource<'a>)],
) -> BindGroup {
    let entries: Vec<wgpu::BindGroupEntry<'_>> = table
        .iter()
        .filter(|row| row.group == group)
        .map(|row| {
            let given = bound.iter().find(|(name, _)| *name == row.name).map(|(_, resource)| resource.clone());
            wgpu::BindGroupEntry { binding: row.binding, resource: given.unwrap_or_else(|| neutral.resource(row, depth_reversed)) }
        })
        .collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("gx v2 inputs"), layout, entries: &entries })
}

/// `buffer` bound at `bytes` from its start.
fn sized(buffer: &Buffer, bytes: u64) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: wgpu::BufferSize::new(bytes) })
}

fn bind_group_layout(device: &Device, label: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

fn shader_module(device: &Device, label: &str, extension: &ValidatedExtension) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Owned(extension.source.clone())),
    })
}

// ---------------------------------------------------------------------------------------------
// Custom materials

/// A custom material a renderer holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CustomMaterialId(u32);

impl CustomMaterialId {
    /// The raw index.
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// The material admitted `raw`-th (a replayed renderer's ids follow admission order).
    pub(crate) const fn from_raw(raw: u32) -> Self {
        CustomMaterialId(raw)
    }
}

/// A post pass a renderer holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PostPassId(u32);

impl PostPassId {
    /// The raw index.
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// One draw of a mesh with a custom material.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CustomDraw {
    /// The draw id current when it was drawn (`frame.id(key)`, [`crate::motion::DrawId`]), if
    /// any: under TAA a moving custom draw keeps its motion history by it (renderer pass 2,
    /// P2-0.8b T-04), else by its mesh and ordinal ([`crate::motion::CustomMotion`]).
    pub id: Option<crate::motion::DrawId>,
    /// The mesh.
    pub mesh: MeshId,
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// The material.
    pub material: CustomMaterialId,
    /// sRGB tint the material reads as `in.tint` (v1 as is, v2 linearized).
    pub tint: [u8; 4],
}

/// One v1 custom draw's row (`GxDraw`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuCustomDraw {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Its inverse-transpose, for normals.
    pub normal: [f32; 16],
    /// sRGB tint in 0..1.
    pub tint: [f32; 4],
    /// x: simulated seconds, y: the draw's index in the frame.
    pub params: [f32; 4],
}

/// The v1 post pass's renderer uniforms (`GxPost`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuPost {
    /// Width, height, 1 / width, 1 / height.
    pub size: [f32; 4],
    /// x: simulated seconds, y: the pass's index in the frame.
    pub params: [f32; 4],
}

/// The renderer resources a v2 material frame group binds: a new table or texture array (a table
/// grew, a texture was added, shadows reallocated) or a new environment bake rebuilds the group.
#[derive(Clone, Debug, PartialEq)]
struct V2FrameKey {
    buffers: [Buffer; 4],
    views: [wgpu::TextureView; 6],
    environment: Option<EnvironmentViews>,
    /// The material sampler (a quality's anisotropy replaces it; renderer pass 2 P2-0.12).
    sampler: wgpu::Sampler,
}

impl V2FrameKey {
    fn of(world: &WorldPass<'_>, environment: Option<&EnvironmentViews>) -> V2FrameKey {
        V2FrameKey {
            buffers: [world.lights.clone(), world.materials.clone(), world.light_ext.clone(), world.light_bins.clone()],
            views: [
                world.shadow_map.clone(),
                world.color_textures.clone(),
                world.data_textures.clone(),
                world.ao_term.clone(),
                world.contact_mask.clone(),
                world.aerial.clone(),
            ],
            environment: environment.cloned(),
            sampler: world.texture_sampler.clone(),
        }
    }
}

/// A Level-2 pipeline: made on the compile pool inside error scopes, `Err` with wgpu's message when
/// the backend refused it (renderer pass 2, RC-04).
type CheckedPipeline = Compiled<Result<RenderPipeline, String>>;

/// The typed refusal of a source whose pipeline failed after naga accepted it.
fn pipeline_failed(message: &str) -> RenderError {
    invalid(format!("its pipeline failed: {message}"))
}

struct CustomMaterial {
    pipeline: CheckedPipeline,
    extension: ValidatedExtension,
    game: Option<GameGroup>,
}

/// The layouts of one api's renderer groups (0 the frame, 1 the draw).
struct MaterialLayouts {
    frame: BindGroupLayout,
    draw: BindGroupLayout,
}

/// One api's per-draw rows: the buffer and its bind group.
#[derive(Default)]
struct DrawRows {
    buffer: Option<Buffer>,
    group: Option<BindGroup>,
}

impl DrawRows {
    /// Grow to `bytes` when smaller; rows of `row_bytes` at [`DRAW_STRIDE`], one bound at a time
    /// by its dynamic offset (v1).
    fn reserve(&mut self, device: &Device, layout: &BindGroupLayout, bytes: u64, row_bytes: u64) -> Result<(), RenderError> {
        self.reserve_as(device, layout, bytes, BufferUsages::UNIFORM, Some(row_bytes))
    }

    /// Grow to `bytes` when smaller: one storage table of tightly packed rows, bound whole (v2's
    /// `gx_draws`, LG-20 step 3).
    fn reserve_table(&mut self, device: &Device, layout: &BindGroupLayout, bytes: u64) -> Result<(), RenderError> {
        self.reserve_as(device, layout, bytes, BufferUsages::STORAGE, None)
    }

    fn reserve_as(&mut self, device: &Device, layout: &BindGroupLayout, bytes: u64, usage: BufferUsages, row_bytes: Option<u64>) -> Result<(), RenderError> {
        if self.buffer.as_ref().is_some_and(|b| b.size() >= bytes) {
            return Ok(());
        }
        let grown = buffer(device, "custom draws", bytes.next_power_of_two(), usage | BufferUsages::COPY_DST)?;
        let resource = row_bytes.map_or_else(|| grown.as_entire_binding(), |row| sized(&grown, row));
        self.group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("custom draws"),
            layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource }],
        }));
        self.buffer = Some(grown);
        Ok(())
    }
}

/// The custom materials a renderer holds and the per-draw rows of the current frame. A
/// [`WorldStage`] of its own: drawn inside the world pass after the opaque batches.
pub struct CustomMaterials {
    device: Device,
    context: ExtensionContext,
    facts: PipelineFacts,
    v1: MaterialLayouts,
    uniforms_layout: BindGroupLayout,
    v2: MaterialLayouts,
    shared: Option<V2Shared>,
    materials: Vec<CustomMaterial>,
    rows_v1: DrawRows,
    rows_v2: DrawRows,
    /// The frozen v1 frame bytes materials read (`GxFrame` is a prefix of
    /// [`crate::abi::GxFrameV1`]), refreshed from the renderer's frame uniforms each frame.
    compat: crate::abi::CompatFrame,
    frame_group: Option<BindGroup>,
    /// The v2 frame group, and the renderer resources it binds (rebuilt when one is replaced).
    frame_group_v2: Option<(V2FrameKey, BindGroup)>,
    /// The renderer's environment v2 materials bind (None: the neutral inputs).
    environment: Option<EnvironmentViews>,
    frame: Vec<CustomDraw>,
    /// Last frame's custom draws by key (T-04), and this frame's draws' previous transforms.
    motion: crate::motion::CustomMotion,
    frame_prev: Vec<crate::motion::CustomPrev>,
    frame_facts: FrameFacts,
    /// Whether this frame's [`FrameV2`] is refreshed although no v2 material draws (v2 post passes
    /// read it).
    keep_frame_v2: bool,
    frame_v2_due: bool,
    /// The sun's shadow constants v2 pipelines are built with (the renderer's filter, temporal
    /// pattern, blend band and end fade).
    sun_shadows: SunShadowConstants,
    /// Whether the AO term v2 pipelines read carries screen-space GI (`GX_AO_GI`, renderer pass 2
    /// B.4): the forward pass's constant, so a custom surface reads the term as the built-in one.
    ao_gi: bool,
}

/// The sun's shadows as v2 materials draw them, made pipeline constants of the v2 prelude's sun
/// chunk: the filter (`GX_SHADOW_FILTER`), whether TAA turns the soft filters' taps
/// (`GX_SHADOW_TEMPORAL`), the cascade blend band and the end fade (`GX_SUN_BLEND_BAND`,
/// `GX_SUN_END_FADE`), so a custom surface is shadowed as the built-in one beside it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SunShadowConstants {
    /// The filter.
    pub filter: ShadowFilter,
    /// Whether a temporal resolve follows the scene.
    pub temporal: bool,
    /// The fraction of each cascade's depth range blended into the next.
    pub blend_band: f32,
    /// The fraction of the last cascade's depth range the shadows fade out over.
    pub end_fade: f32,
    /// The least perceptual roughness the surfaces shade with (`GX_ROUGHNESS_FLOOR`, renderer pass 2
    /// P2-0.12 LG-04): the forward pass's, so a v2 highlight of the sun's disc matches the
    /// built-in one.
    pub roughness_floor: f32,
}

impl SunShadowConstants {
    /// The legacy renderer's: 3x3 PCF, a static pattern, hard switches and a hard end, the
    /// legacy roughness floor.
    pub const LEGACY: SunShadowConstants =
        SunShadowConstants { filter: ShadowFilter::Pcf3x3, temporal: false, blend_band: 0.0, end_fade: 0.0, roughness_floor: 0.04 };

    /// The v2 prelude's pipeline constants. `GX_SUN_SOFT_EDGES` follows the band and the end fade
    /// as the forward pass's does (renderer pass 2, P2-0.3: it also turns the lookup's normal
    /// offset towards the light), so a legacy custom surface keeps the legacy lookup bit for bit.
    fn constants(&self) -> [(&'static str, f64); 6] {
        [
            ("GX_ROUGHNESS_FLOOR", f64::from(self.roughness_floor)),
            ("GX_SHADOW_FILTER", f64::from(self.filter.shader_id())),
            ("GX_SHADOW_TEMPORAL", f64::from(u8::from(self.temporal))),
            ("GX_SUN_BLEND_BAND", f64::from(self.blend_band)),
            ("GX_SUN_END_FADE", f64::from(self.end_fade)),
            ("GX_SUN_SOFT_EDGES", f64::from(u8::from(self.blend_band > 0.0 || self.end_fade > 0.0))),
        ]
    }
}

/// The v2 material prelude's switch for an AO term that carries screen-space GI (material_v2.wgsl).
const AO_GI_CONSTANT: &str = "GX_AO_GI";

/// The far plane's index among `cull::frustum_planes`' six, and the plane every point is inside of:
/// the Level-2 draws' cull keeps no far plane (LG-20).
const FAR_PLANE: usize = 5;
const ALWAYS_INSIDE: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

const MATERIAL_ATTRIBUTES: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];

impl CustomMaterials {
    /// No materials yet, on `device`, for a world pass of `samples` drawing the legacy scene.
    pub fn new(device: &Device, context: ExtensionContext, samples: u32) -> CustomMaterials {
        let stages = ShaderStages::VERTEX_FRAGMENT;
        CustomMaterials {
            device: device.clone(),
            context,
            facts: PipelineFacts { scene_format: WORLD_FORMAT, samples, depth_reversed: false },
            v1: MaterialLayouts {
                frame: bind_group_layout(device, "custom frame", &[uniform(0, false, stages)]),
                draw: bind_group_layout(device, "custom draw", &[uniform(0, true, stages)]),
            },
            uniforms_layout: bind_group_layout(device, "custom uniforms", &[uniform(0, false, stages)]),
            v2: MaterialLayouts {
                frame: bind_group_layout(device, "custom frame v2", &layout_entries(MATERIAL_V2_BINDINGS, 0)),
                draw: bind_group_layout(device, "custom draw v2", &layout_entries(MATERIAL_V2_BINDINGS, 1)),
            },
            shared: None,
            materials: Vec::new(),
            rows_v1: DrawRows::default(),
            rows_v2: DrawRows::default(),
            compat: crate::abi::CompatFrame::new(device),
            frame_group: None,
            frame_group_v2: None,
            environment: None,
            frame: Vec::new(),
            motion: crate::motion::CustomMotion::new(),
            frame_prev: Vec::new(),
            frame_facts: FrameFacts::new((1, 1), (1, 1)),
            keep_frame_v2: false,
            frame_v2_due: false,
            sun_shadows: SunShadowConstants::LEGACY,
            ao_gi: false,
        }
    }

    /// Materials held.
    pub fn len(&self) -> usize {
        self.materials.len()
    }

    /// Whether none is held.
    pub fn is_empty(&self) -> bool {
        self.materials.is_empty()
    }

    /// The colour format the materials draw in (the scene's).
    pub fn scene_format(&self) -> TextureFormat {
        self.facts.scene_format
    }

    /// Why a session holding these materials draws on the legacy LDR scene: a v1 material
    /// (`material-v1-in-hdr`), which returns sRGB-encoded colour. None otherwise.
    pub fn ldr_reason(&self) -> Option<LdrReason> {
        self.materials.iter().any(|m| m.extension.api == ABI_V1).then_some(LdrReason::MaterialV1InHdr)
    }

    /// `config` as these materials let it draw: LDR with standard Z for [`CustomMaterials::ldr_reason`].
    pub fn frame_config(&self, config: FrameConfig) -> FrameConfig {
        self.ldr_reason().map_or(config, |reason| config.degraded_to_ldr(reason))
    }

    /// The frame inputs the held v2 materials read.
    pub fn inputs(&self) -> RenderInputs {
        self.materials.iter().fold(RenderInputs::NONE, |all, m| all | m.extension.inputs)
    }

    /// The frame inputs the materials of `draws` read (what a frame drawing them asks of its
    /// producers: a material held but not drawn asks for nothing).
    pub fn inputs_of(&self, draws: &[CustomDraw]) -> RenderInputs {
        draws
            .iter()
            .filter_map(|draw| self.materials.get(draw.material.0 as usize))
            .fold(RenderInputs::NONE, |all, m| all | m.extension.inputs)
    }

    /// This frame's custom geometry for the depth/normal prepass (graph node 7): each prepared
    /// draw's mesh at its model matrix, so the prepass's consumers see the custom materials too,
    /// with last frame's model matrix for its motion (T-04: matched by draw id or mesh ordinal).
    pub fn prepass_draws(&self) -> Vec<crate::prepass::PrepassDraw> {
        self.frame
            .iter()
            .zip(&self.frame_prev)
            .map(|(draw, prev)| crate::prepass::PrepassDraw { mesh: draw.mesh, model: draw.model, prev_model: prev.model, history: prev.history })
            .collect()
    }

    /// What the next frames' v2 sources read about the camera, sizes and scene.
    pub fn set_frame_facts(&mut self, facts: FrameFacts) {
        self.frame_facts = facts;
    }

    /// The environment v2 materials bind from now on: the renderer's ([`EnvironmentViews::of`] its
    /// maps, refreshed each frame after the environment node so a new bake is bound the frame it
    /// lands), or None for the neutral inputs (no environment light).
    pub fn set_environment(&mut self, environment: Option<EnvironmentViews>) {
        self.environment = environment;
    }

    /// The environment v2 materials bind ([`CustomMaterials::set_environment`]).
    pub fn environment(&self) -> Option<&EnvironmentViews> {
        self.environment.as_ref()
    }

    /// What v2 sources read about the frame (the last [`CustomMaterials::set_frame_facts`]).
    pub fn frame_facts(&self) -> FrameFacts {
        self.frame_facts
    }

    /// Refresh the v2 frame bytes every frame although no v2 material draws (a v2 post pass reads
    /// them through [`CustomMaterials::frame_v2`]).
    pub fn keep_frame_v2(&mut self, keep: bool) {
        self.keep_frame_v2 = keep;
    }

    /// The v2 frame buffer, once a v2 source made it.
    pub fn frame_v2(&self) -> Option<&Buffer> {
        self.shared.as_ref().map(|shared| shared.frame.buffer())
    }

    fn ensure_v2(&mut self, gpu: &Gpu) -> Result<(), RenderError> {
        if self.shared.is_none() {
            self.shared = Some(V2Shared::new(gpu)?);
        }
        Ok(())
    }

    fn pipeline(&self, extension: &ValidatedExtension, game: Option<&BindGroupLayout>) -> CheckedPipeline {
        let device = &self.device;
        let api = extension.api;
        let module = shader_module(device, "custom material", extension);
        let layouts = if api == ABI_V1 { &self.v1 } else { &self.v2 };
        let mut groups = vec![&layouts.frame, &layouts.draw];
        groups.extend(game);
        let layout = pipeline_layout(device, "custom material", &groups);
        let buffers = [Some(wgpu::VertexBufferLayout { array_stride: VERTEX_STRIDE, step_mode: wgpu::VertexStepMode::Vertex, attributes: &MATERIAL_ATTRIBUTES })];
        let targets = [Some(wgpu::ColorTargetState { format: self.facts.scene_format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        // Only the v2 prelude holds the sun chunk (v1 sources declare none of the constants).
        let [a, b, c, d, e, f] = self.sun_shadows.constants();
        let v2 = [a, b, c, d, e, f, (AO_GI_CONSTANT, f64::from(u8::from(self.ao_gi)))];
        let constants: &[(&str, f64)] = if api == ABI_V1 { &[] } else { &v2 };
        let options = wgpu::PipelineCompilationOptions { constants, ..Default::default() };
        crate::compile::render_pipeline_checked(device, &wgpu::RenderPipelineDescriptor {
            label: Some("custom material"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(ExtensionKind::Material.vertex_entry(api)), compilation_options: options.clone(), buffers: &buffers },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(depth_compare(true, self.facts.depth_reversed)),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState { count: self.facts.samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(ExtensionKind::Material.fragment_entry()), compilation_options: options, targets: &targets }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// Admit a v1 `source` and build its pipeline; refused before any GPU object is made.
    pub fn add(&mut self, gpu: &Gpu, source: &str, uniforms: &[u8]) -> Result<CustomMaterialId, RenderError> {
        self.add_api(gpu, ABI_V1, source, uniforms, &[])
    }

    /// Admit `source` at extension API `api` with its uniform bytes and game textures (in binding
    /// order) and build its pipeline; refused before any GPU object is made.
    pub fn add_api(&mut self, gpu: &Gpu, api: u32, source: &str, uniforms: &[u8], textures: &[TextureData]) -> Result<CustomMaterialId, RenderError> {
        check_count("custom materials", self.materials.len() + 1, CUSTOM_MATERIALS_MAX, RenderCode::WgslTooLarge)?;
        let extension = validate_api(ExtensionKind::Material, api, source, &self.context)?;
        extension.check_uniforms(uniforms)?;
        extension.check_textures(textures.len())?;
        let game = if api == ABI_V1 {
            v1_group(&gpu.device, &gpu.queue, &self.uniforms_layout, uniforms)?
        } else {
            self.ensure_v2(gpu)?;
            let shared = self.shared.as_ref().ok_or_else(|| layout("the v2 inputs"))?;
            v2_group(gpu, &extension, uniforms, textures, shared)?
        };
        let pipeline = self.pipeline(&extension, game.as_ref().map(|g| &g.layout));
        // Admission waits for its own compile: a pipeline the backend refuses is refused here.
        if let Err(message) = pipeline.get() {
            return Err(pipeline_failed(message));
        }
        self.materials.push(CustomMaterial { pipeline, extension, game });
        Ok(CustomMaterialId((self.materials.len() - 1) as u32))
    }

    /// Build the v2 pipelines with the sun's shadows `sun` from now on (the renderer's filter,
    /// temporal pattern, blend band and end fade: [`crate::Renderer::sun_shadow_constants`]).
    /// Answers whether anything was rebuilt.
    pub fn set_sun_shadows(&mut self, sun: SunShadowConstants) -> bool {
        if sun == self.sun_shadows {
            return false;
        }
        self.sun_shadows = sun;
        self.rebuild_v2()
    }

    /// Build the v2 pipelines reading the AO term as one with screen-space GI (`on`, the
    /// renderer's `GX_AO_GI`; renderer pass 2 B.4) or without from now on. Answers whether
    /// anything was rebuilt.
    pub fn set_ao_gi(&mut self, on: bool) -> bool {
        if on == self.ao_gi {
            return false;
        }
        self.ao_gi = on;
        self.rebuild_v2()
    }

    /// Whether v2 pipelines read the AO term as one with screen-space GI.
    pub fn ao_gi(&self) -> bool {
        self.ao_gi
    }

    /// Every v2 material's pipeline built again with the current constants. Answers whether any
    /// was.
    fn rebuild_v2(&mut self) -> bool {
        let rebuilt: Vec<(usize, CheckedPipeline)> = self
            .materials
            .iter()
            .enumerate()
            .filter(|(_, m)| m.extension.api != ABI_V1)
            .map(|(i, m)| (i, self.pipeline(&m.extension, m.game.as_ref().map(|g| &g.layout))))
            .collect();
        let any = !rebuilt.is_empty();
        for (i, pipeline) in rebuilt {
            self.materials[i].pipeline = pipeline;
        }
        any
    }

    /// The sun's shadows v2 pipelines are built with.
    pub fn sun_shadows(&self) -> SunShadowConstants {
        self.sun_shadows
    }

    /// Build every pipeline against `facts` from now on (the scene format, samples and depth
    /// convention the presenter fixed for the session). Answers whether anything was rebuilt.
    pub fn set_pipeline_facts(&mut self, _gpu: &Gpu, facts: PipelineFacts) -> Result<bool, RenderError> {
        if facts == self.facts {
            return Ok(false);
        }
        self.facts = facts;
        // The neutral depth input follows the depth convention.
        self.frame_group_v2 = None;
        let pipelines: Vec<CheckedPipeline> = self.materials.iter().map(|m| self.pipeline(&m.extension, m.game.as_ref().map(|g| &g.layout))).collect();
        for (material, pipeline) in self.materials.iter_mut().zip(pipelines) {
            material.pipeline = pipeline;
        }
        Ok(true)
    }

    /// Replace a material's uniforms (the same size as its block).
    pub fn set_uniforms(&mut self, gpu: &Gpu, id: CustomMaterialId, uniforms: &[u8]) -> Result<(), RenderError> {
        let material = self.materials.get(id.0 as usize).ok_or_else(|| unknown_material(id))?;
        material.extension.check_uniforms(uniforms)?;
        if let Some(target) = material.game.as_ref().and_then(|g| g.uniform.as_ref()) {
            gpu.queue.write_buffer(target, 0, uniforms);
        }
        Ok(())
    }

    fn api_of(&self, id: CustomMaterialId) -> u32 {
        self.materials.get(id.0 as usize).map_or(ABI_V1, |m| m.extension.api)
    }

    /// Check this frame's draws and write their rows (and the v2 frame facts); nothing is written
    /// when one is refused.
    pub fn prepare(&mut self, gpu: &Gpu, draws: &[CustomDraw], seconds: f32, library: &crate::scene::MeshLibrary) -> Result<u64, RenderError> {
        self.frame.clear();
        if self.keep_frame_v2 {
            // A v2 post pass reads the frame bytes although no v2 material made them.
            self.ensure_v2(gpu)?;
        }

        for draw in draws {
            if self.materials.get(draw.material.0 as usize).is_none() {
                return Err(unknown_material(draw.material));
            }
            if library.entry(draw.mesh).is_none() {
                return Err(RenderError::refused(RenderCode::MeshInvalid, format!("mesh {} is not in the library", draw.mesh.raw())));
            }
        }
        // Matched against last frame's draws once the frame is admitted (T-04): their previous
        // models feed the prepass's motion and `GxDrawV2::prev_model`, last frame's time `prev_time`.
        let rows: Vec<crate::motion::CustomRow> = draws.iter().map(|draw| custom_row(draw, library)).collect();
        let (prevs, prev_seconds) = self.motion.apply(&rows, seconds);
        // LG-20: the draws in the camera's view, by material (one pipeline bind per material);
        // every draw keeps its motion history above and its index in the frame below.
        let order = self.drawn_order(draws, &rows);
        let v2_drawn = order.iter().any(|at| self.api_of(draws[*at].material) == ABI_V2);
        self.frame_v2_due = v2_drawn || self.keep_frame_v2;
        if let Some(shared) = self.shared.as_mut().filter(|_| v2_drawn || self.keep_frame_v2) {
            // A material binds the renderer's light table and sun shadows ([`CustomMaterials::bind_frame`]).
            let facts = FrameFacts { renderer_lights: true, ..self.frame_facts };
            shared.frame.write(&gpu.queue, &facts, seconds);
        }
        if order.is_empty() {
            self.frame_prev.clear();
            return Ok(0);
        }
        let bytes = order.len() as u64 * DRAW_STRIDE;
        let v2_bytes = order.len() as u64 * V2_ROW_BYTES;
        let mut v1_rows = vec![0u8; bytes as usize];
        let mut v2_rows = vec![0u8; if v2_drawn { v2_bytes as usize } else { 0 }];
        for (slot, i) in order.iter().copied().enumerate() {
            let (draw, prev) = (&draws[i], &prevs[i]);
            let normal = crate::instance::instance_row(&draw.model, [0.0; 3], 0.0, 0).normal;
            let params = [seconds, i as f32, prev_seconds, 0.0];
            if self.api_of(draw.material) == ABI_V1 {
                let at = slot * DRAW_STRIDE as usize;
                let row = GpuCustomDraw { model: draw.model, normal, tint: draw.tint.map(|c| f32::from(c) / 255.0), params };
                v1_rows[at..at + size_of::<GpuCustomDraw>()].copy_from_slice(bytemuck::bytes_of(&row));
                continue;
            }
            // v2 rows are packed by slot: an instanced call's instances are its run of slots.
            let at = slot * V2_ROW_BYTES as usize;
            let tint = [0, 1, 2].map(|c| crate::texture::srgb_to_linear(draw.tint[c]));
            let row = GxDrawV2 { model: draw.model, normal, prev_model: prev.model, tint: [tint[0], tint[1], tint[2], f32::from(draw.tint[3]) / 255.0], params };
            v2_rows[at..at + size_of::<GxDrawV2>()].copy_from_slice(bytemuck::bytes_of(&row));
        }
        let device = &self.device;
        self.rows_v1.reserve(device, &self.v1.draw, bytes, size_of::<GpuCustomDraw>() as u64)?;
        if v2_drawn {
            self.rows_v2.reserve_table(device, &self.v2.draw, v2_bytes)?;
        }
        if let Some(target) = &self.rows_v1.buffer {
            gpu.queue.write_buffer(target, 0, &v1_rows);
        }
        if let Some(target) = self.rows_v2.buffer.as_ref().filter(|_| v2_drawn) {
            gpu.queue.write_buffer(target, 0, &v2_rows);
        }
        self.frame = order.iter().map(|at| draws[*at]).collect();
        self.frame_prev = order.iter().map(|at| prevs[*at]).collect();
        Ok(bytes)
    }

    /// The indices of `draws` the frame draws, in drawing order (renderer pass 2 A.0, LG-20): the
    /// ones whose world sphere (`rows`' bounds) is inside the camera's side and near planes (no far
    /// plane, so either depth convention keeps them), sorted by material, equal materials in frame
    /// order. Every draw without a camera.
    fn drawn_order(&self, draws: &[CustomDraw], rows: &[crate::motion::CustomRow]) -> Vec<usize> {
        let planes = self.frame_facts.camera.map(|camera| {
            let (width, height) = self.frame_facts.output_size;
            let mut planes = crate::cull::frustum_planes(camera.view_proj(width.max(1) as f32 / height.max(1) as f32));
            planes[FAR_PLANE] = ALWAYS_INSIDE;
            planes
        });
        let seen = |at: &usize| planes.as_ref().is_none_or(|planes| crate::cull::in_frustum(planes, rows[*at].bounds));
        let mut order: Vec<usize> = (0..draws.len()).filter(seen).collect();
        // LG-20 step 3: by mesh within a material, so each v2 pair's draws are one run (one call).
        order.sort_by_key(|at| (draws[*at].material.0, draws[*at].mesh.raw()));
        order
    }

    /// This frame's draw calls ([`CustomMaterials::draw`]) as runs of its draws: a v2 material's
    /// draws of one mesh are one instanced call (LG-20 step 3); a v1 draw is a call of its own
    /// (its row is a uniform bound by offset).
    fn calls(&self) -> Vec<std::ops::Range<usize>> {
        let mut calls: Vec<std::ops::Range<usize>> = Vec::new();
        for (at, draw) in self.frame.iter().enumerate() {
            let joins = |run: &std::ops::Range<usize>| {
                let first = &self.frame[run.start];
                first.material == draw.material && first.mesh == draw.mesh && self.api_of(draw.material) != ABI_V1
            };
            match calls.last_mut() {
                Some(run) if joins(run) => run.end = at + 1,
                _ => calls.push(at..at + 1),
            }
        }
        calls
    }

    /// Refresh the v1 frame bytes (and the v2 frame, when due) from the world pass's
    /// `frame_uniforms` into `encoder` and bind them for this frame's draws (ahead of the world
    /// pass). Materials never read the renderer's own frame uniforms, so its layout may change
    /// without moving a shipped material. v2 materials also bind the world pass's light, material
    /// and texture tables and the sun's shadow array.
    pub fn bind_frame(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        let frame_uniforms = world.frame_uniforms;
        if let Some(shared) = self.shared.as_ref().filter(|_| self.frame_v2_due) {
            shared.frame.refresh(device, encoder, frame_uniforms);
            let key = V2FrameKey::of(world, self.environment.as_ref());
            if self.frame_group_v2.as_ref().is_none_or(|(held, _)| *held != key) {
                let frame = sized(shared.frame.buffer(), GX_FRAME_V2_BYTES);
                let (light_zbins, light_tiles) = crate::tables::light_bin_slices(world.light_bins);
                let mut bound = vec![
                    ("frame", frame),
                    ("lights", world.lights.as_entire_binding()),
                    // The binned local lights (RQ6.6): `gx_shade_pbr` walks the tile masks and
                    // z-bins the forward pass walks, so a v2 material is lit by the frame's points
                    // and spots as a built-in surface is.
                    ("light_ext", world.light_ext.as_entire_binding()),
                    // Two slices of the one bin table (LG-16), so the v2 map is unchanged.
                    ("light_tiles", wgpu::BindingResource::Buffer(light_tiles)),
                    ("light_zbins", wgpu::BindingResource::Buffer(light_zbins)),
                    ("materials", world.materials.as_entire_binding()),
                    ("color_textures", wgpu::BindingResource::TextureView(world.color_textures)),
                    ("data_textures", wgpu::BindingResource::TextureView(world.data_textures)),
                    ("texture_sampler", wgpu::BindingResource::Sampler(world.texture_sampler)),
                    ("shadow_map", wgpu::BindingResource::TextureView(world.shadow_map)),
                    ("shadow_sampler", wgpu::BindingResource::Sampler(world.shadow_sampler)),
                    // The frame's screen effects (RQ4.6, RQ4 review): `gx_shade_pbr` occludes
                    // indirect light (with the bent normal), shadows the sun with the contact mask
                    // and hazes with the aerial perspective as the forward pass does.
                    ("ao_map", wgpu::BindingResource::TextureView(&world.ao_term)),
                    ("contact_shadow_mask", wgpu::BindingResource::TextureView(&world.contact_mask)),
                    ("aerial_perspective", wgpu::BindingResource::TextureView(&world.aerial)),
                ];
                // The renderer's environment: the frame marks `ambient.w` from its bake, so the
                // chunks' `gx_ambient` must read the same cube, SH and LUT the forward pass reads.
                if let Some(environment) = &self.environment {
                    bound.extend(environment.bound(MATERIAL_V2_BINDINGS));
                }
                let group = v2_renderer_group(device, &self.v2.frame, MATERIAL_V2_BINDINGS, 0, &shared.neutral, self.facts.depth_reversed, &bound);
                self.frame_group_v2 = Some((key, group));
            }
        }
        if !self.frame.iter().any(|draw| self.api_of(draw.material) == ABI_V1) {
            return;
        }
        self.compat.refresh(device, encoder, frame_uniforms);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("custom frame"),
            layout: &self.v1.frame,
            entries: &[entry(0, self.compat.buffer())],
        });
        self.frame_group = Some(group);
    }

    /// Draw this frame's custom draws inside the world pass.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        if self.frame.is_empty() {
            return;
        }
        pass.set_vertex_buffer(0, world.vertices.slice(..));
        pass.set_index_buffer(world.indices.slice(..), wgpu::IndexFormat::Uint32);
        let mut bound_api = None;
        let mut bound_material = None;
        for run in self.calls() {
            let (i, draw) = (run.start, &self.frame[run.start]);
            let (Some(material), Some(mesh)) = (self.materials.get(draw.material.0 as usize), world.library.entry(draw.mesh)) else { continue };
            let api = material.extension.api;
            let v2_group = self.frame_group_v2.as_ref().map(|(_, group)| group);
            let (frame_group, rows) = if api == ABI_V1 { (self.frame_group.as_ref(), &self.rows_v1) } else { (v2_group, &self.rows_v2) };
            let (Some(frame_group), Some(draw_group)) = (frame_group, &rows.group) else { continue };
            if bound_api != Some(api) {
                pass.set_bind_group(0, frame_group, &[]);
                bound_api = Some(api);
            }
            // A rebuild the backend refused draws nothing (its admission compiled clean).
            let Ok(pipeline) = material.pipeline.get() else { continue };
            // The draws come sorted by material (LG-20): its pipeline and game group bind once.
            if bound_material != Some(draw.material) {
                pass.set_pipeline(pipeline);
                if let Some(game) = &material.game {
                    pass.set_bind_group(2, &game.group, &[]);
                }
                bound_material = Some(draw.material);
            }
            let indices = mesh.first_index..mesh.first_index + mesh.index_count;
            if api == ABI_V1 {
                pass.set_bind_group(1, draw_group, &[(i as u64 * DRAW_STRIDE) as u32]);
                pass.draw_indexed(indices, mesh.base_vertex, 0..1);
                continue;
            }
            // The run's rows are its slots of `gx_draws` (`instance_index` counts from the first).
            pass.set_bind_group(1, draw_group, &[]);
            pass.draw_indexed(indices, mesh.base_vertex, run.start as u32..run.end as u32);
        }
    }

    /// Draws this frame issues.
    pub fn frame_draws(&self) -> u32 {
        self.frame.len() as u32
    }

    /// Draw calls this frame's draws take ([`CustomMaterials::draw`]): one per v2 (material,
    /// mesh) pair drawn, one per v1 draw (LG-20 step 3).
    pub fn frame_draw_calls(&self) -> u32 {
        self.calls().len() as u32
    }

    /// Pipeline binds this frame's draws make ([`CustomMaterials::draw`]: one per run of a
    /// material, the draws being sorted by material).
    pub fn frame_pipeline_binds(&self) -> u32 {
        let changes = self.frame.windows(2).filter(|pair| pair[0].material != pair[1].material).count();
        (changes + usize::from(!self.frame.is_empty())) as u32
    }
}

impl WorldStage for CustomMaterials {
    fn before_world(&mut self, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        let device = self.device.clone();
        self.bind_frame(&device, encoder, world);
    }

    fn opaque(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.draw(pass, world);
    }

    // Renderer pass 2, P2-0.8b (T-04): drawn as a renderer's stage (`render_staged`), the custom
    // draws reach the prepass as the frame renderer's do, so its consumers (TAA's motion, AO,
    // contact shadows) see them; without it they read the background behind them.
    fn prepass_draws(&self) -> Vec<crate::prepass::PrepassDraw> {
        CustomMaterials::prepass_draws(self)
    }
}

/// `draw` as its motion is matched (T-04): its id, mesh, model and world bounds (the library
/// mesh's sphere under its model; a mesh the library lacks was refused before this is asked).
fn custom_row(draw: &CustomDraw, library: &crate::scene::MeshLibrary) -> crate::motion::CustomRow {
    let (center, radius) = library.entry(draw.mesh).map_or(([0.0; 3], 0.0), |entry| (entry.center, entry.radius));
    let bounds = crate::instance::instance_row(&draw.model, center, radius, 0).bounds;
    crate::motion::CustomRow { id: draw.id, mesh: draw.mesh, model: draw.model, bounds }
}

fn unknown_material(id: CustomMaterialId) -> RenderError {
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::Invalid, format!("no custom material {}", id.0))
}

fn unknown_post(id: PostPassId) -> RenderError {
    RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::Invalid, format!("no post pass {}", id.0))
}

// ---------------------------------------------------------------------------------------------
// Post passes

/// What a frame's post passes read about it beside their target: the output size, the time, the
/// history, the depth convention, the exposure the scene is written with, the v2 frame bytes
/// (None: neutral; [`CustomMaterials::frame_v2`] when a renderer keeps them) and the prepass's
/// depth, normals and motion.
#[derive(Clone, Copy, Debug)]
pub struct PostFrame<'a> {
    /// The world target's size.
    pub output_size: (u32, u32),
    /// Simulated seconds.
    pub seconds: f32,
    /// Frames drawn since the last history reset.
    pub frame_index: u64,
    /// Whether depth is reversed.
    pub depth_reversed: bool,
    /// The exposure an HDR scene is written with (1 at stage ldr and on the LDR scene).
    pub pre_exposure: f32,
    /// The v2 frame buffer `gx_frame` binds.
    pub frame: Option<&'a Buffer>,
    /// The prepass depth `gx_depth` binds (None: the neutral far plane), at render size.
    pub depth: Option<&'a wgpu::TextureView>,
    /// The prepass's octahedral normals `gx_normals` binds (None: neutral zero), at render size.
    pub normals: Option<&'a wgpu::TextureView>,
    /// The prepass's motion `gx_motion` binds (None: neutral zero motion), at render size: NDC
    /// motion, current minus previous, jitter removed ([`crate::motion::MOTION_FORMAT`]).
    pub motion: Option<&'a wgpu::TextureView>,
    /// The renderer's environment `gx_env_specular` and `gx_env_sh` bind (None: neutral, no
    /// environment light).
    pub environment: Option<&'a EnvironmentViews>,
    /// This frame's TAA jitter in clip units (`GxPostV2::jitter`; 0 without TAA): what the depth,
    /// normals and motion inputs were drawn with, though the scene a post pass reads is resolved.
    pub jitter: [f32; 2],
}

impl PostFrame<'_> {
    /// A frame of `output_size` at `seconds`: standard Z, exposure 1, neutral frame bytes.
    pub fn new(output_size: (u32, u32), seconds: f32) -> PostFrame<'static> {
        PostFrame {
            output_size,
            seconds,
            frame_index: 0,
            depth_reversed: false,
            pre_exposure: 1.0,
            frame: None,
            depth: None,
            normals: None,
            motion: None,
            environment: None,
            jitter: [0.0, 0.0],
        }
    }
}

struct PostPass {
    pipeline: CheckedPipeline,
    extension: ValidatedExtension,
    stage: PostStage,
    format: TextureFormat,
    game: Option<GameGroup>,
}

/// The post passes a renderer holds, run in a frame's order over a target.
pub struct PostPasses {
    device: Device,
    context: ExtensionContext,
    facts: PipelineFacts,
    source_layout: BindGroupLayout,
    uniforms_layout: BindGroupLayout,
    v2_layout: BindGroupLayout,
    empty_layout: BindGroupLayout,
    empty_group: BindGroup,
    sampler: wgpu::Sampler,
    shared: Option<V2Shared>,
    passes: Vec<PostPass>,
    params: Buffer,
    params_v2: Option<Buffer>,
    /// Copies of the targets passes read, one per size and format.
    scratch: Vec<(wgpu::Texture, wgpu::TextureView)>,
}

impl PostPasses {
    /// No post passes yet, on `device`, for the legacy scene.
    pub fn new(device: &Device, context: ExtensionContext) -> Result<PostPasses, RenderError> {
        let fragment = ShaderStages::FRAGMENT;
        let texture = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: fragment,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let sampler = wgpu::BindGroupLayoutEntry { binding: 1, visibility: fragment, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None };
        let empty_layout = bind_group_layout(device, "post reserved", &[]);
        let empty_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("post reserved"), layout: &empty_layout, entries: &[] });
        Ok(PostPasses {
            device: device.clone(),
            context,
            facts: PipelineFacts { scene_format: WORLD_FORMAT, samples: 1, depth_reversed: false },
            source_layout: bind_group_layout(device, "post source", &[texture, sampler, uniform(2, false, ShaderStages::VERTEX_FRAGMENT)]),
            uniforms_layout: bind_group_layout(device, "post uniforms", &[uniform(0, false, ShaderStages::VERTEX_FRAGMENT)]),
            v2_layout: bind_group_layout(device, "post v2", &layout_entries(POST_V2_BINDINGS, 0)),
            empty_layout,
            empty_group,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("post"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            shared: None,
            passes: Vec::new(),
            params: buffer(device, "post params", (POST_PASSES_MAX as u64) * DRAW_STRIDE, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            params_v2: None,
            scratch: Vec::new(),
        })
    }

    /// Post passes held.
    pub fn len(&self) -> usize {
        self.passes.len()
    }

    /// Whether none is held.
    pub fn is_empty(&self) -> bool {
        self.passes.is_empty()
    }

    /// The frame inputs the held v2 post passes read.
    pub fn inputs(&self) -> RenderInputs {
        self.passes.iter().fold(RenderInputs::NONE, |all, pass| all | pass.extension.inputs)
    }

    /// The frame inputs the post passes of `ids` read (a frame running them asks its producers
    /// for these; a pass held but not run asks for nothing).
    pub fn inputs_of(&self, ids: &[PostPassId]) -> RenderInputs {
        ids.iter().filter_map(|id| self.passes.get(id.0 as usize)).fold(RenderInputs::NONE, |all, pass| all | pass.extension.inputs)
    }

    /// The stage pass `id` runs at.
    pub fn stage(&self, id: PostPassId) -> Option<PostStage> {
        self.passes.get(id.0 as usize).map(|pass| pass.stage)
    }

    /// The extension API pass `id` is written against.
    pub fn api(&self, id: PostPassId) -> Option<u32> {
        self.passes.get(id.0 as usize).map(|pass| pass.extension.api)
    }

    /// The format pass `id` draws into: the scene's at stage hdr, the world target's at ldr.
    pub fn target_format(&self, id: PostPassId) -> Option<TextureFormat> {
        self.passes.get(id.0 as usize).map(|pass| pass.format)
    }

    fn format_at(&self, stage: PostStage) -> TextureFormat {
        match stage {
            PostStage::Hdr => self.facts.scene_format,
            _ => WORLD_FORMAT,
        }
    }

    fn pipeline(&self, extension: &ValidatedExtension, format: TextureFormat, game: Option<&BindGroupLayout>) -> CheckedPipeline {
        let device = &self.device;
        let api = extension.api;
        let module = shader_module(device, "post pass", extension);
        let groups: Vec<&BindGroupLayout> = match (api == ABI_V1, game) {
            (true, game) => std::iter::once(&self.source_layout).chain(game).collect(),
            (false, Some(game)) => vec![&self.v2_layout, &self.empty_layout, game],
            (false, None) => vec![&self.v2_layout],
        };
        let layout = pipeline_layout(device, "post pass", &groups);
        let targets = [Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        crate::compile::render_pipeline_checked(device, &wgpu::RenderPipelineDescriptor {
            label: Some("post pass"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(ExtensionKind::PostPass.vertex_entry(api)), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(ExtensionKind::PostPass.fragment_entry()), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// Admit a v1 `source` (stage ldr) and build its pipeline.
    pub fn add(&mut self, gpu: &Gpu, source: &str, uniforms: &[u8]) -> Result<PostPassId, RenderError> {
        self.add_api(gpu, ABI_V1, PostStage::Ldr, source, uniforms, &[])
    }

    /// Admit `source` at extension API `api` for `stage` with its uniform bytes and game textures
    /// and build its pipeline; v1 passes run at stage ldr only.
    pub fn add_api(
        &mut self,
        gpu: &Gpu,
        api: u32,
        stage: PostStage,
        source: &str,
        uniforms: &[u8],
        textures: &[TextureData],
    ) -> Result<PostPassId, RenderError> {
        check_count("post passes", self.passes.len() + 1, POST_PASSES_MAX, RenderCode::WgslTooLarge)?;
        if api == ABI_V1 && stage != PostStage::Ldr {
            return Err(layout(format!("an extension API v1 post pass runs at stage ldr; stage {} takes api = 2", stage.wire())));
        }
        let extension = validate_api(ExtensionKind::PostPass, api, source, &self.context)?;
        extension.check_uniforms(uniforms)?;
        extension.check_textures(textures.len())?;
        let game = if api == ABI_V1 {
            v1_group(&gpu.device, &gpu.queue, &self.uniforms_layout, uniforms)?
        } else {
            self.ensure_v2(gpu)?;
            let shared = self.shared.as_ref().ok_or_else(|| layout("the v2 inputs"))?;
            v2_group(gpu, &extension, uniforms, textures, shared)?
        };
        let format = self.format_at(stage);
        let pipeline = self.pipeline(&extension, format, game.as_ref().map(|g| &g.layout));
        // Admission waits for its own compile: a pipeline the backend refuses is refused here.
        if let Err(message) = pipeline.get() {
            return Err(pipeline_failed(message));
        }
        self.passes.push(PostPass { pipeline, extension, stage, format, game });
        Ok(PostPassId((self.passes.len() - 1) as u32))
    }

    fn ensure_v2(&mut self, gpu: &Gpu) -> Result<(), RenderError> {
        if self.shared.is_none() {
            self.shared = Some(V2Shared::new(gpu)?);
            self.params_v2 = Some(buffer(&gpu.device, "post params v2", (POST_PASSES_MAX as u64) * DRAW_STRIDE, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?);
        }
        Ok(())
    }

    /// Build every hdr-stage pipeline against `facts` (the session's scene format). Answers
    /// whether anything was rebuilt.
    pub fn set_pipeline_facts(&mut self, _gpu: &Gpu, facts: PipelineFacts) -> Result<bool, RenderError> {
        if facts == self.facts {
            return Ok(false);
        }
        self.facts = facts;
        let rebuilt: Vec<(TextureFormat, CheckedPipeline)> = self
            .passes
            .iter()
            .map(|pass| {
                let format = self.format_at(pass.stage);
                (format, self.pipeline(&pass.extension, format, pass.game.as_ref().map(|g| &g.layout)))
            })
            .collect();
        for (pass, (format, pipeline)) in self.passes.iter_mut().zip(rebuilt) {
            pass.format = format;
            pass.pipeline = pipeline;
        }
        Ok(true)
    }

    /// Refuse a frame naming a pass this renderer does not hold, or more passes than the cap.
    pub fn check(&self, ids: &[PostPassId]) -> Result<(), RenderError> {
        check_count("post passes in a frame", ids.len(), POST_PASSES_MAX, RenderCode::WgslTooLarge)?;
        match ids.iter().find(|id| self.passes.get(id.0 as usize).is_none()) {
            Some(id) => Err(unknown_post(*id)),
            None => Ok(()),
        }
    }

    /// Bytes of the scratch copies passes read (one per format, at the target's size): what the
    /// frame holds beside the renderer's pooled targets ([`crate::FrameRenderer::held_bytes`]).
    pub fn scratch_bytes(&self) -> u64 {
        self.scratch
            .iter()
            .map(|(texture, _)| {
                let size = texture.size();
                let texel = texture.format().block_copy_size(None).unwrap_or(4);
                u64::from(size.width) * u64::from(size.height) * u64::from(texel)
            })
            .sum()
    }

    /// The copy of a target of `texture`'s size and format that passes read.
    fn scratch(&mut self, texture: &wgpu::Texture) -> (wgpu::Texture, wgpu::TextureView) {
        let (size, format) = (texture.size(), texture.format());
        if let Some(found) = self.scratch.iter().find(|(held, _)| held.size() == size && held.format() == format) {
            return found.clone();
        }
        let copy = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("post source"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = copy.create_view(&Default::default());
        self.scratch.retain(|(held, _)| held.format() != format);
        self.scratch.push((copy.clone(), view.clone()));
        (copy, view)
    }

    /// Run every pass of `ids` in order over the world target (the legacy path: v1 passes, and v2
    /// ones on the LDR scene). Each copies the frame so far and draws its fragment over it.
    pub fn encode(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, world: (&wgpu::Texture, &wgpu::TextureView), ids: &[PostPassId], seconds: f32) {
        let size = world.0.size();
        let frame = PostFrame::new((size.width, size.height), seconds);
        self.encode_where(gpu, encoder, world, ids, &frame, |_| true);
    }

    /// [`PostPasses::encode`] with what `frame` hands the v2 passes (the v2 frame bytes, the
    /// environment, the prepass's depth and normals): the frame renderer's legacy LDR scene.
    pub fn encode_all(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, world: (&wgpu::Texture, &wgpu::TextureView), ids: &[PostPassId], frame: &PostFrame<'_>) {
        self.encode_where(gpu, encoder, world, ids, frame, |_| true);
    }

    /// Run the passes of `ids` that run at `stage`, in order, over `target`: the scene at stage hdr
    /// (render size; the world target on the LDR scene), the world target at ldr.
    pub fn encode_stage(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        target: (&wgpu::Texture, &wgpu::TextureView),
        ids: &[PostPassId],
        stage: PostStage,
        frame: &PostFrame<'_>,
    ) {
        self.encode_where(gpu, encoder, target, ids, frame, |pass| pass.stage == stage);
    }

    fn encode_where(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        target: (&wgpu::Texture, &wgpu::TextureView),
        ids: &[PostPassId],
        frame: &PostFrame<'_>,
        runs: impl Fn(&PostPass) -> bool,
    ) {
        let running: Vec<(usize, usize)> =
            ids.iter().enumerate().filter_map(|(i, id)| self.passes.get(id.0 as usize).filter(|pass| runs(pass)).map(|_| (i, id.0 as usize))).collect();
        if running.is_empty() {
            return;
        }
        let (texture, view) = target;
        let size = texture.size();
        let (copy, source) = self.scratch(texture);
        self.write_params(gpu, &running, size, frame);
        for (i, index) in running {
            let pass = &self.passes[index];
            // A rebuild the backend refused draws nothing (its admission compiled clean).
            let Ok(pipeline) = pass.pipeline.get() else { continue };
            if pass.format != texture.format() {
                continue;
            }
            encoder.copy_texture_to_texture(texture.as_image_copy(), copy.as_image_copy(), size);
            let group = if pass.extension.api == ABI_V1 { self.v1_source(&source, i) } else { self.v2_source(&source, i, frame) };
            let Some(group) = group else { continue };
            let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("post pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            render.set_pipeline(pipeline);
            render.set_bind_group(0, &group, &[]);
            match (&pass.game, pass.extension.api == ABI_V1) {
                (Some(game), true) => render.set_bind_group(1, &game.group, &[]),
                (Some(game), false) => {
                    render.set_bind_group(1, &self.empty_group, &[]);
                    render.set_bind_group(2, &game.group, &[]);
                }
                (None, _) => {}
            }
            render.draw(0..3, 0..1);
        }
    }

    /// The rows of the `running` passes (their index in the frame's list, their pass) at that
    /// index: v1's `GxPost`, v2's `GxPostV2`, sized from this stage's target. Only these rows are
    /// written: the hdr and ldr stages write theirs into one buffer before the frame's one
    /// submission, so a stage writing every row would hand the other stage its target's size
    /// (renderer pass 2, RC-01: below scale 1 an hdr pass sampled a cropped scene).
    fn write_params(&self, gpu: &Gpu, running: &[(usize, usize)], size: wgpu::Extent3d, frame: &PostFrame<'_>) {
        let (w, h) = (size.width as f32, size.height as f32);
        for &(i, index) in running {
            let at = i as u64 * DRAW_STRIDE;
            let row = GpuPost { size: [w, h, 1.0 / w, 1.0 / h], params: [frame.seconds, i as f32, 0.0, 0.0] };
            gpu.queue.write_buffer(&self.params, at, bytemuck::bytes_of(&row));
            let Some(pass) = self.passes.get(index).filter(|pass| pass.extension.api == ABI_V2) else { continue };
            // Stage hdr on the legacy LDR scene sees the display-ready frame: 0, as at ldr.
            let stage_hdr = pass.stage == PostStage::Hdr && pass.format != WORLD_FORMAT;
            let row = GxPostV2 {
                render_size: [w, h],
                output_size: [frame.output_size.0 as f32, frame.output_size.1 as f32],
                texel: [1.0 / w, 1.0 / h],
                jitter: frame.jitter,
                time: frame.seconds,
                pass_index: i as u32,
                frame_index: frame.frame_index as u32,
                depth_reversed: u32::from(frame.depth_reversed),
                pre_exposure: if stage_hdr { frame.pre_exposure } else { 1.0 },
                stage_hdr: u32::from(stage_hdr),
                reserved0: 0,
                reserved1: 0,
            };
            if let Some(target) = &self.params_v2 {
                gpu.queue.write_buffer(target, at, bytemuck::bytes_of(&row));
            }
        }
    }

    fn v1_source(&self, source: &wgpu::TextureView, i: usize) -> Option<BindGroup> {
        Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post source"),
            layout: &self.source_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.params,
                        offset: i as u64 * DRAW_STRIDE,
                        size: wgpu::BufferSize::new(size_of::<GpuPost>() as u64),
                    }),
                },
            ],
        }))
    }

    fn v2_source(&self, source: &wgpu::TextureView, i: usize, frame: &PostFrame<'_>) -> Option<BindGroup> {
        let (shared, params) = (self.shared.as_ref()?, self.params_v2.as_ref()?);
        let post = wgpu::BindingResource::Buffer(wgpu::BufferBinding {
            buffer: params,
            offset: i as u64 * DRAW_STRIDE,
            size: wgpu::BufferSize::new(size_of::<GxPostV2>() as u64),
        });
        let mut bound = vec![
            ("gx_scene", wgpu::BindingResource::TextureView(source)),
            ("gx_sampler", wgpu::BindingResource::Sampler(&self.sampler)),
            ("gx_post", post),
        ];
        if let Some(buffer) = frame.frame {
            bound.push(("gx_frame", sized(buffer, GX_FRAME_V2_BYTES)));
        }
        // The prepass's targets once it ran this frame: real depth and normals for every v2 post
        // pass (a post pass draws after the world pass, so nothing is drawing into them).
        if let Some(depth) = frame.depth {
            bound.push(("gx_depth", wgpu::BindingResource::TextureView(depth)));
        }
        if let Some(normals) = frame.normals {
            bound.push(("gx_normals", wgpu::BindingResource::TextureView(normals)));
        }
        // The prepass's motion once it wrote motion this frame (RQ5): written before the world
        // pass, read after it, like depth and normals.
        if let Some(motion) = frame.motion {
            bound.push(("gx_motion", wgpu::BindingResource::TextureView(motion)));
        }
        if let Some(environment) = frame.environment {
            bound.extend(environment.bound(POST_V2_BINDINGS));
        }
        Some(v2_renderer_group(&self.device, &self.v2_layout, POST_V2_BINDINGS, 0, &shared.neutral, frame.depth_reversed, &bound))
    }
}

// Every row fits its 256-byte dynamic-offset stride.
const _: () = assert!(size_of::<GpuPost>() as u64 <= DRAW_STRIDE && size_of::<GpuCustomDraw>() as u64 <= DRAW_STRIDE);
const _: () = assert!(size_of::<GxPostV2>() as u64 <= DRAW_STRIDE && size_of::<GxDrawV2>() as u64 <= DRAW_STRIDE);

#[cfg(test)]
mod tests {
    use super::*;

    /// LG-20 step 3: `fs_material`'s parameter list and body are found past comments that name it,
    /// attributes on their own lines and nested parentheses, and a source without one (or with a
    /// broken one) has none; nothing else is read as its openings.
    #[test]
    fn the_fragment_entry_is_opened_where_its_parameters_and_body_start() {
        let cases: &[(&str, Option<(&str, &str)>)] = &[
            ("@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return in.tint; }", Some(("in: GxMaterialInV2", " return in.tint; }"))),
            ("// fn fs_material( is not here\n/* nor fn fs_material( /* nested */ here */\n@fragment\nfn fs_material(\n  in: GxMaterialInV2,\n) -> @location(0) vec4<f32>\n{\n  return in.tint;\n}", Some(("\n  in: GxMaterialInV2,", "\n  return in.tint;\n}"))),
            ("@ fragment fn fs_material(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> { return p; }", Some(("@builtin(position) p", " return p; }"))),
            ("fn fs_material_helper(x: f32) -> f32 { return x; } @fragment fn fs_material() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }", Some((") ->", " return vec4"))),
            ("fn fs_material_helper(x: f32) -> f32 { return x; }", None),
            ("@fragment fn fs_material(in: GxMaterialInV2 -> @location(0) vec4<f32> { return in.tint; }", None),
            ("@fragment fn fs_material(in: GxMaterialInV2)) -> vec4<f32> { return in.tint; }", None),
            ("/* fn fs_material(in: X) { */", None),
            ("", None),
        ];
        for (source, wanted) in cases {
            let found = fs_material_openings(source).map(|(parameters, body)| (&source[parameters..], &source[body..]));
            match (found, wanted) {
                (Some((parameters, body)), Some((after_paren, after_brace))) => {
                    assert!(parameters.starts_with(after_paren), "{source:?}: parameters at {parameters:?}");
                    assert!(body.starts_with(after_brace), "{source:?}: body at {body:?}");
                }
                (found, wanted) => assert_eq!(found.is_some(), wanted.is_some(), "{source:?}: {found:?}"),
            }
        }
    }

    /// A v2 material reading `gx_draw` compiles with its draw row handed in (on the same lines); one
    /// that does not is compiled as written.
    #[test]
    fn a_v2_material_reading_its_draw_row_is_opened_and_one_that_does_not_is_kept() {
        let context = ExtensionContext::new(Features::empty(), Features::empty());
        let reads = "@fragment\nfn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {\n  return vec4<f32>(gx_draw.params.y);\n}";
        let helper = "fn row_time() -> f32 { return gx_draw.params.x; }\n@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return vec4<f32>(row_time()); }";
        let ignores = "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return in.tint; }";
        for source in [reads, helper] {
            let admitted = validate_api(ExtensionKind::Material, ABI_V2, source, &context).expect("admitted");
            let game = &admitted.source()[MATERIAL_V2_PRELUDE.len() + 1..];
            assert!(game.contains(DRAW_ROW_PARAMETER) && game.contains(DRAW_ROW_STORE), "{game}");
            assert_eq!(game.lines().count(), source.lines().count(), "the opened source keeps its lines");
        }
        let kept = validate_api(ExtensionKind::Material, ABI_V2, ignores, &context).expect("admitted");
        assert_eq!(kept.source(), format!("{MATERIAL_V2_PRELUDE}\n{ignores}"));
    }

    /// Renderer pass 2, P2-0.8b (T-04): a custom draw carries the draw id current when it was
    /// drawn (`frame.id(key)` reaches it through the facade), so its motion follows the id.
    #[test]
    fn a_custom_draw_carries_the_draw_id_current_when_drawn() {
        use crate::motion::DrawId;
        let mut frame = crate::immediate::ImmediateFrame::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0; 3]), [0, 0, 0, 255]);
        let material = CustomMaterialId::from_raw(0);
        let at = |x: f32| glam::Mat4::from_translation(glam::Vec3::new(x, 0.0, 0.0)).to_cols_array();
        frame.custom(MeshId::CUBE, at(0.0), material, [255; 4]);
        frame.id(Some(DrawId::from("flag"))).custom(MeshId::CUBE, at(1.0), material, [255; 4]);
        frame.id(None).custom(MeshId::SPHERE, at(2.0), material, [255; 4]);
        let ids: Vec<Option<DrawId>> = frame.custom_draws().iter().map(|draw| draw.id).collect();
        assert_eq!(ids, [None, Some(DrawId::from("flag")), None]);
    }

    #[test]
    fn the_frame_v2_remap_validates_against_webgpu_core() {
        let module = naga::front::wgsl::parse_str(FRAME_V2_REMAP_WGSL).expect("the remap parses");
        Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).expect("the remap validates against core");
    }

    #[test]
    fn frame_facts_fill_the_cpu_half_of_the_v2_frame() {
        let facts = FrameFacts::new((128, 72), (64, 36)).with_camera(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]));
        let (frame, view_proj) = facts.gx_frame(2.5, None);
        assert_eq!((frame.render_size, frame.output_size), ([64.0, 36.0], [128.0, 72.0]));
        assert_eq!((frame.scene_ldr, frame.depth_reversed, frame.history_reset), (1, 0, 1));
        assert_eq!((frame.time, frame.pre_exposure, frame.inv_pre_exposure), (2.5, 1.0, 1.0));
        assert_eq!(frame.counts[0], 0, "no light table is bound: the remap clamps the light count to 0");
        assert_eq!(frame.cascade_splits[3], 0.0, "no shadow array is bound: sun shadows off");
        assert_eq!(frame.ev_compensation, 0.0);
        let view_proj = glam::Mat4::from_cols_array(&view_proj.expect("a camera"));
        let rebuilt = glam::Mat4::from_cols_array(&frame.proj) * glam::Mat4::from_cols_array(&frame.view);
        assert!(rebuilt.abs_diff_eq(view_proj, 1e-4), "proj × view is the renderer's view_proj");
        let inverse = glam::Mat4::from_cols_array(&frame.inv_view_proj) * view_proj;
        assert!(inverse.abs_diff_eq(glam::Mat4::IDENTITY, 1e-4));
        assert_eq!(frame.prev_view_proj, frame.view_proj, "a history reset has no previous frame");
    }

    #[test]
    fn a_material_frame_reads_every_light_its_shadows_its_look_and_the_reversed_projection() {
        let camera = CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]);
        let facts = FrameFacts { renderer_lights: true, depth_reversed: true, ev_compensation: -1.5, ..FrameFacts::new((128, 72), (128, 72)) };
        let (frame, view_proj) = facts.with_camera(camera).gx_frame(0.0, None);
        assert_eq!(frame.counts[0], u32::MAX, "the remap keeps the renderer's light count");
        assert_eq!(frame.cascade_splits[3], 1.0, "and its sun shadows");
        assert_eq!(frame.ev_compensation, -1.5);
        let reversed = camera.view_proj_reversed(128.0 / 72.0).to_cols_array();
        assert_eq!(view_proj, Some(reversed), "the HDR path's projection: reverse-Z");
    }
}
