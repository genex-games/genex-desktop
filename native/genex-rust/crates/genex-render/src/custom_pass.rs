//! Custom GPU passes (extension ladder level 3, M2.19): raw wgpu compute and render passes a game
//! registers into the runtime frame through `genex::gpu`, in safe Rust.
//!
//! # Stages
//!
//! A pass is registered once, at install, for one [`PassStage`]:
//!
//! | stage | runs | records into |
//! | --- | --- | --- |
//! | [`PassStage::BeforeCull`] | after the frame's tables are uploaded, before skinning and the cull | its own [`wgpu::CommandEncoder`] (compute) |
//! | [`PassStage::AfterOpaque`] | inside the world pass, after the opaque batches, lines and custom materials | [`WorldDraws`], replayed into the world pass against its colour and depth |
//! | [`PassStage::AfterTransparent`] | inside the world pass, after the transparent draws and particles | [`WorldDraws`], as above |
//! | [`PassStage::PostHdr`] (API v2) | after TAA's place, before bloom and the tonemap (graph node 18); on the legacy LDR scene, first in node 23 | its own encoder, with the scene colour target (render size) |
//! | [`PassStage::Post`] | after the 2D primitives and post passes, before the HUD overlay | its own encoder, with the resolved world colour target |
//! | [`PassStage::AfterPrepass`] (API v2, RQ4) | after the depth/normal prepass and Hi-Z, before AO and the world pass (graph node 9) | its own encoder, with the prepass's depth and normals as declared inputs |
//!
//! `after-prepass` is in the host's vocabulary ([`PassStage::VOCABULARY`]) from RQ4.0 on and is
//! served ([`AFTER_PREPASS_SERVED`]) exactly when the game frame hands the prepass to Level-3 passes
//! ([`PREPASS_SERVED`]): until then registering a pass there is refused `gpu-pass-invalid`, never accepted and left
//! unrun. Its passes run in [`CustomStage::after_prepass`], which the prepass's node calls with
//! the frame's [`PrepassViews`]; from then on the v2 tables of every encoder stage (`after-prepass`,
//! `post-hdr`, `post`) bind the prepass depth and normals as `gx_depth` and `gx_normals`, and
//! [`PassFrame::prepass_depth`] / [`PassFrame::prepass_normals`] hand them to a pass binding them
//! in its own groups. The in-world stages keep the neutral inputs. A pass registered at
//! `after-prepass` or declaring depth or normals makes the prepass run whatever the preset's AO and
//! TAA say ([`CustomPasses::prepass_demand`]: inputs drive producers).
//!
//! **Motion (RQ5).** Once the prepass writes motion, the frame hands its target over before the
//! `after-prepass` stage ([`CustomStage::prepass_motion`]) and the same encoder stages bind it as
//! `gx_motion` and through [`PassFrame::prepass_motion`]: `rg16float` NDC motion, current minus
//! previous with the jitter removed. Geometry a pass draws in the world is not in the prepass, so
//! by itself its pixels keep the motion of what the prepass drew there. On TAA frames an in-world
//! pass gives TAA its own (renderer pass 2, B.7): [`PassFrame::motion_draws`] draw the motion of
//! what it moves (a vertex animation evaluated at this tick and at [`PassFrame::prev_tick`], say
//! with the shared wind, [`crate::wind`]) into the motion target, and [`PassFrame::reactive_draws`]
//! draw the coverage of blended work moving over a background whose motion it does not share (a
//! glow sprite) into the reactive mask. Both replay in graph node 15a against the prepass depth,
//! after the world pass and before the resolve ([`CustomStage::temporal_motion`], the stage's
//! [`WorldStage::reactive`]); they are recorded, checked and proven with the pass's world draws.
//!
//! Each stage is a node of the frame graph ([`PassStage::node`], [`crate::graph`]): the registry's
//! [`PassRun`] is the [`WorldStage`] the renderer's nodes hand the frame's encoder (`before-cull`),
//! the open world pass (`after-opaque`, `after-transparent`) and, through [`CustomStage`], the
//! world target after node 23's 2D and post-pass work is submitted (`post`).
//!
//! Every stage runs inside the runtime frame, before capture readback and the Live ring copy, so
//! captures and Live frames carry what a pass drew. A pass sees the frame's tables (the frame
//! uniforms and the instance and material tables, bound read-only through
//! [`PassSetup::tables_layout`]), the tick and, in the facade, `&Sim`; no API hands GPU data back
//! to update hooks, so the state checksum never reads the GPU. Each registered pass counts as one
//! logical draw under [`CUSTOM_TAG`].
//!
//! The v1 frame uniforms a pass binds are the frozen [`crate::abi::GxFrameV1`] bytes in a compat
//! buffer the registry refreshes each frame ([`crate::abi::CompatFrame`]), never the renderer's
//! own frame uniforms, so the renderer's internal layout may change without moving a v1 pass.
//!
//! # Lifecycle
//!
//! A pass declares its API version ([`CustomPass::api`], 1 by default) and the frame inputs it
//! reads ([`CustomPass::inputs`], none by default). Registration refuses (`gpu-pass-invalid`,
//! naming the pass) an API version this build does not serve ([`CUSTOM_PASS_APIS`]), a v1 pass
//! that declares inputs (v1 tables have none), a v1 pass at `post-hdr` or `after-prepass`, and a
//! pass at a stage this build does not serve yet ([`PassStage::served`]).
//!
//! **API v2** passes bind the v2 tables ([`TABLES_V2_WGSL`], [`PassSetup::tables_layout`]): the
//! whole [`crate::abi::GxFrameV2`] (matrices and their inverse, sizes, `pre_exposure`,
//! `depth_reversed`, `scene_ldr`, frame index), the instance and material rows, and the declared
//! inputs (depth, normals, motion, the environment). The graph enables the producers of what
//! running v2 passes declare ([`CustomPasses::render_inputs`], the receipt's `renderInputs`); an
//! input whose producer is off or has not landed ([`PRODUCED_INPUTS`]) is bound to a 1x1 neutral
//! resource. A v2 pass draws in the scene format at the in-world stages and `post-hdr`
//! ([`PassSetup::world_format`]). A **v1 in-world pass** expects the sRGB-encoded world target, so
//! a session holding one draws on the legacy LDR scene with standard Z
//! ([`CustomPasses::ldr_reason`], `custom-pass-v1-in-world`); a v1 `post` pass always sees the LDR
//! world target. Nothing is refused for either. [`PassSetup::rebuild_reason`] says why a rebuild
//! runs; [`PassSetup::quality`] and [`PassFrame::quality`] carry the quality in effect;
//! [`PassFrame::render_size`] is the scene's size (smaller than the world target's below a render
//! scale of 1; the presenter sets it each frame, [`CustomPasses::set_render_size`]);
//! [`PassFrame::frame_index`] counts frames drawn since the last history reset
//! ([`PassFrame::history_reset`]); [`PassFrame::settle`] is set while a capture re-renders one tick
//! (an encode may then run several times for one tick, so a pass is a function of tick, sim and
//! settle index). A capture ([`CustomPasses::set_capture`]) starts from an empty history whatever
//! Live drew before it: its frames count from 0 by settle index, and Live's own history resumes
//! after it.
//!
//! Pipeline-shaping facts ([`PipelineFacts`]: the scene format, the world pass's samples, the depth
//! convention) are fixed per session. When the presenter hands the registry new ones
//! ([`CustomPasses::set_pipeline_facts`]), every running pass's rebuild hook runs again through the
//! device-loss path with [`RebuildReason::PipelineChange`], and [`PassSetup::pipeline_changes`] says
//! which facts moved. What each pass holds ([`PassSetup::bytes`]) enters the render budget's ledger
//! ([`CustomPasses::register_budget`]); [`CustomPasses::over_budget`] names the passes past a budget.
//!
//! # Admission
//!
//! Resources are created through [`PassSetup`] (in the pass's rebuild hook, at install and after
//! device loss) and count against the GPU caps: buffers [`crate::BUFFER_MAX_BYTES`] each,
//! textures [`crate::TEXTURE_MAX_BYTES`] each, [`GPU_PASS_BYTES_MAX`] per pass, at most
//! [`GPU_PASSES_MAX`] passes, uploads [`crate::UPLOAD_MAX_BYTES_PER_FRAME`] a frame; no buffer is
//! mappable (nothing reads the GPU back). WGSL goes through [`validate_pass_wgsl`]: at most
//! [`crate::WGSL_MAX_BYTES`], parsed and validated by naga against WebGPU core plus the native
//! features the game declared and the device was opened with (`native-feature-missing`
//! otherwise; the device is never opened with undeclared features). wgpu's validation errors in a
//! rebuild hook or a frame are caught by an error scope and become a typed `gpu-pass-invalid`
//! naming the pass; a pass refused during a frame is skipped for that frame (nothing it encoded is
//! submitted) and stays off afterwards, and the rest of the frame draws. In-world draws are first
//! replayed into a throwaway pass on attachments of the world pass's formats and samples (never
//! submitted), so an invalid command can never poison the world pass itself; render bundles are
//! not used because native wgpu treats a bundle's validation error as fatal.
//!
//! Renderer internals stay private: a pass never sees the renderer's pipelines, the world's
//! multisampled target or the indirect arguments, only what this module hands it. The host's GPU
//! hang watchdog covers passes, since they run inside the frame whose deadline it watches.
//!
//! # Error scopes on the web
//!
//! Native wgpu settles a scope when it is popped, so a refusal lands in the frame that caused it
//! ([`ScopeMode::Immediate`]). The browser answers a scope later ([`ScopeMode::Deferred`], the web's
//! mode): a scope still pending is parked and polled at the start of every later frame
//! ([`CustomPasses::poll_scopes`]), or awaited where the caller can wait
//! ([`CustomPasses::take_pending`], a capture or the boot), and a pass whose scope reports an error
//! is refused `gpu-pass-invalid` from then on. Until an in-world pass's first proof has resolved
//! clean its draws stay out of the world pass, so a pass that was never valid cannot poison it.
//! After that a frame's draws are replayed while their own proof is pending only when an earlier
//! clean proof covers each of them (the same pipeline and vertex slots, slices at least as large,
//! ranges ending no later; [`WorldDraws`] checks the rest on the CPU as it records): a pass whose
//! draws grow past what was proven waits for its proof, because one invalid command in the world
//! pass loses the browser's whole frame (RC-11). Bind groups are not compared: a pass may make
//! them per frame, and their contents are not visible here.

use std::future::Future;
use std::ops::{Bound, Range, RangeBounds};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use naga::valid::{Capabilities, ValidationFlags, Validator};
use wgpu::{
    BindGroup, BindGroupLayout, Buffer, BufferUsages, CommandEncoder, Device, Features, Queue, ShaderStages, Texture, TextureFormat,
    TextureView,
};

use crate::abi::{
    ABI_V1, ABI_V2, BindingKind, CompatFrame, GX_FRAME_V1_BYTES, GX_FRAME_V2_BYTES, Neutral, NeutralInputs, RenderInputs, V2Binding, layout_entries,
};
use crate::budget::{BudgetKind, BudgetLedger};
use crate::caps::{BUFFER_MAX_BYTES, MAX_WORLD_PX, TEXTURE_MAX_BYTES, UploadBudget, WGSL_MAX_BYTES};
use crate::error::{RenderCode, RenderError};
use crate::extension::{EnvironmentViews, ExtensionContext, FrameFacts, FrameV2, naga_capabilities};
use crate::settle::FrameHistory;
use crate::floor::NATIVE_ENHANCED_FEATURES;
use crate::gpu::Gpu;
use crate::graph::NodeId;
use crate::renderer::{DEPTH_FORMAT, Renderer, WORLD_FORMAT, WorldPass, WorldStage};
use crate::settings::{FrameConfig, LdrReason, Quality};
use crate::scene::Scene;
use crate::tables::CullPath;

/// The custom-pass API version the capability receipt records (`customPassApi`): genex-studio's
/// `CUSTOM_PASS_API_VERSION` and the host's `NATIVE_CUSTOM_PASS_API_VERSION`; defined with the v2
/// ABI in `abi.rs` (RQ1.0). The tables layout and [`TABLES_WGSL`] are version 1; a change is a
/// release change.
pub use crate::abi::{CUSTOM_PASS_API_VERSION, CUSTOM_PASS_APIS};
/// The tag every custom pass counts one logical draw under.
pub const CUSTOM_TAG: &str = "custom";
/// Passes one renderer holds.
pub const GPU_PASSES_MAX: usize = 8;
/// Bytes of buffers and textures one pass may hold.
pub const GPU_PASS_BYTES_MAX: u64 = BUFFER_MAX_BYTES;
/// The longest pass name, in characters.
pub const GPU_PASS_NAME_MAX_CHARS: usize = 64;
/// The longest naga diagnostic a refusal carries.
const DIAGNOSTIC_MAX_CHARS: usize = 2048;
/// Mip levels counted for a texture's bytes (a 4096-pixel side has 13).
const MIP_LEVELS_COUNTED: u32 = 16;
/// Bytes per texel assumed for a format without a single copy size (depth-stencil pairs).
const FALLBACK_TEXEL_BYTES: u64 = 8;

/// What every pass's WGSL may use, prepended to it: the frame uniforms and the instance and
/// material rows, laid out as the frozen [`crate::abi::GxFrameV1`], `GpuInstance` and
/// `GpuMaterial` (tests/layout.rs holds them to the ABI sizes). A pass
/// binds them through [`PassSetup::tables_layout`]: `@binding(0) var<uniform> gx_frame: GxFrame`,
/// `@binding(1) var<storage, read> gx_instances: array<GxInstance>` and `@binding(2) var<storage,
/// read> gx_materials: array<GxMaterial>`, in the group it chooses.
pub const TABLES_WGSL: &str = "// genex custom-pass tables, API v1.
struct GxFrame {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    camera_forward: vec4<f32>,
    sun_dir: vec4<f32>,
    sun_color: vec4<f32>,
    ambient: vec4<f32>,
    planes: array<vec4<f32>, 6>,
    cascade_view_proj: array<mat4x4<f32>, 2>,
    cascade_splits: vec4<f32>,
    shadow_params: vec4<f32>,
    counts: vec4<u32>,
}

struct GxInstance {
    model: mat4x4<f32>,
    normal: mat4x4<f32>,
    bounds: vec4<f32>,
    material: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

struct GxMaterial {
    base_color: vec4<f32>,
    params: vec4<f32>,
    textures: vec4<u32>,
}
";

/// What every API v2 pass's WGSL may use, prepended to it: the renderer's common structs
/// (`GxFrameV2`, `GxEnvSh`, `GxMaterialExt` among them) with `GxInstance` and `GxMaterial`, the v1
/// rows. A v2 pass binds the v2 tables through [`PassSetup::tables_layout`] in the group it
/// chooses: `@binding(0) var<uniform> gx_frame: GxFrameV2`, `@binding(1) var<storage, read>
/// gx_instances: array<GxInstance>`, `@binding(2) var<storage, read> gx_materials:
/// array<GxMaterial>`, `@binding(3) var gx_depth: texture_depth_2d`, `@binding(4) var gx_normals:
/// texture_2d<f32>`, `@binding(5) var gx_motion: texture_2d<f32>`, `@binding(6) var
/// gx_env_specular: texture_cube<f32>`, `@binding(7) var<uniform> gx_env_sh: GxEnvSh` and
/// `@binding(8) var gx_point_sampler: sampler` (non-filtering), `@binding(9) var gx_shadow_map:
/// texture_depth_2d_array` and `@binding(10) var gx_shadow_sampler: sampler_comparison` (the sun's
/// shadow cascades, always bound: compare a point's depth in `GxFrameV2::cascade_view_proj[c]`,
/// offset along its normal by `cascade_offsets[c]`, less `shadow_params.x`; a frame without sun
/// shadows binds a lit map and says so in `cascade_splits.w`). The shared wind (`gx_wind`,
/// [`crate::wind`]) is declared too, so a vertex animation sways with the scene's and can evaluate
/// itself at [`PassFrame::prev_tick`] for its motion. The names of the common structs and functions
/// are reserved.
pub const TABLES_V2_WGSL: &str = concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/wind.wgsl"),
    "
// genex custom-pass tables, API v2: the v1 rows under their v1 names.
alias GxInstance = Instance;
alias GxMaterial = Material;
"
);

/// Every stage a v2 pass's tables are visible to.
const TABLE_STAGES: ShaderStages = ShaderStages::VERTEX_FRAGMENT.union(ShaderStages::COMPUTE);

const fn table_row(binding: u32, name: &'static str, kind: BindingKind, bytes: u64, input: RenderInputs, neutral: Neutral) -> V2Binding {
    V2Binding { group: 0, binding, name, kind, visibility: TABLE_STAGES, bytes, dynamic: false, input, neutral }
}

/// The v2 tables' bindings (the layout [`PassSetup::tables_layout`] answers to a v2 pass).
pub const TABLES_V2_BINDINGS: &[V2Binding] = &[
    table_row(0, "gx_frame", BindingKind::Uniform, GX_FRAME_V2_BYTES, RenderInputs::NONE, Neutral::Zero),
    table_row(1, "gx_instances", BindingKind::Storage, crate::abi::GX_INSTANCE_V1_BYTES, RenderInputs::NONE, Neutral::Zero),
    table_row(2, "gx_materials", BindingKind::Storage, crate::abi::GX_MATERIAL_V1_BYTES, RenderInputs::NONE, Neutral::Zero),
    table_row(3, "gx_depth", BindingKind::Depth2d, 0, RenderInputs::DEPTH, Neutral::FarDepth),
    table_row(4, "gx_normals", BindingKind::Texture2d, 0, RenderInputs::NORMALS, Neutral::Zero),
    table_row(5, "gx_motion", BindingKind::Texture2d, 0, RenderInputs::MOTION, Neutral::Zero),
    table_row(6, "gx_env_specular", BindingKind::TextureCube, 0, RenderInputs::ENVIRONMENT, Neutral::Zero),
    table_row(7, "gx_env_sh", BindingKind::Uniform, size_of::<crate::abi::GxEnvSh>() as u64, RenderInputs::ENVIRONMENT, Neutral::Zero),
    table_row(8, "gx_point_sampler", BindingKind::NonFilteringSampler, 0, RenderInputs::NONE, Neutral::Sampler),
    table_row(9, "gx_shadow_map", BindingKind::DepthArray, 0, RenderInputs::NONE, Neutral::FarDepth),
    table_row(10, "gx_shadow_sampler", BindingKind::ComparisonSampler, 0, RenderInputs::NONE, Neutral::Sampler),
];

/// What the v2 tables bind from the frame's world pass: its instance and material rows and the
/// sun's shadow cascades with their comparison sampler.
struct FrameRows {
    instances: Buffer,
    materials: Buffer,
    shadow_map: TextureView,
    shadow_sampler: wgpu::Sampler,
}

/// The environment group an API v2 pass may bind in a group of its own (RQ2.5;
/// [`PassSetup::environment_layout`], [`PassFrame::environment`]): everything image-based lighting
/// reads, `@binding(0) var gx_env_specular: texture_cube<f32>` (the prefiltered specular cube, one
/// roughness per mip), `@binding(1) var<uniform> gx_env_sh: GxEnvSh` (SH9 irradiance),
/// `@binding(2) var gx_brdf_lut: texture_2d<f32>` (the split-sum LUT: x scale, y bias of F0) and
/// `@binding(3) var gx_env_sampler: sampler` (filtering, clamped). Until the renderer hands over
/// its environment (or with the flat colour) they hold the neutral inputs: no environment light and
/// the LUT's identity. Every stage that runs a pass may read them.
pub const ENVIRONMENT_BINDINGS: &[V2Binding] = &[
    table_row(0, "gx_env_specular", BindingKind::TextureCube, 0, RenderInputs::ENVIRONMENT, Neutral::Zero),
    table_row(1, "gx_env_sh", BindingKind::Uniform, size_of::<crate::abi::GxEnvSh>() as u64, RenderInputs::ENVIRONMENT, Neutral::Zero),
    table_row(2, "gx_brdf_lut", BindingKind::Texture2d, 0, RenderInputs::ENVIRONMENT, Neutral::BrdfIdentity),
    table_row(3, "gx_env_sampler", BindingKind::Sampler, 0, RenderInputs::ENVIRONMENT, Neutral::Sampler),
];

/// Where in the frame a pass runs (see the module docs). Wire values never change once shipped.
///
/// Later tiers add stages (`post-hdr`, `after-prepass`) without renaming these, so the enum is
/// `#[non_exhaustive]` and code outside this crate matches it with a wildcard arm:
///
/// ```
/// use genex_render::custom_pass::PassStage;
/// fn in_own_encoder(stage: PassStage) -> bool {
///     match stage {
///         PassStage::AfterOpaque | PassStage::AfterTransparent => false,
///         _ => true,
///     }
/// }
/// assert!(in_own_encoder(PassStage::Post));
/// ```
///
/// An exhaustive match without one does not compile:
///
/// ```compile_fail,E0004
/// use genex_render::custom_pass::PassStage;
/// fn order(stage: PassStage) -> u8 {
///     match stage {
///         PassStage::BeforeCull => 0,
///         PassStage::AfterOpaque => 1,
///         PassStage::AfterTransparent => 2,
///         PassStage::Post => 3,
///     }
/// }
/// ```
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PassStage {
    /// Compute after the tables upload, before skinning and the cull.
    BeforeCull,
    /// Draws inside the world pass after the opaque work.
    AfterOpaque,
    /// Draws inside the world pass after the transparent work.
    AfterTransparent,
    /// Work over the resolved world target before the HUD overlay.
    Post,
    /// Work over the scene colour after TAA's place, before bloom and the tonemap (API v2).
    PostHdr,
    /// Work after the depth/normal prepass, before AO and the world pass, reading the prepass's
    /// depth and normals (API v2, RQ4; served once [`AFTER_PREPASS_SERVED`]).
    AfterPrepass,
}

impl PassStage {
    /// Every stage this build serves, in vocabulary order (appended, never renamed): `post-hdr` runs
    /// before `post` in the frame.
    pub const ALL: [PassStage; 6] =
        [PassStage::BeforeCull, PassStage::AfterOpaque, PassStage::AfterTransparent, PassStage::Post, PassStage::PostHdr, PassStage::AfterPrepass];

    /// Every stage id the host's `CustomPassStage` names, in vocabulary order. Every one is served
    /// now (`after-prepass` since RQ4.6), so it equals [`PassStage::ALL`]; a stage whose node lands
    /// later is appended here first.
    pub const VOCABULARY: [PassStage; 6] =
        [PassStage::BeforeCull, PassStage::AfterOpaque, PassStage::AfterTransparent, PassStage::Post, PassStage::PostHdr, PassStage::AfterPrepass];

    /// The stage's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            PassStage::BeforeCull => "before-cull",
            PassStage::AfterOpaque => "after-opaque",
            PassStage::AfterTransparent => "after-transparent",
            PassStage::Post => "post",
            PassStage::PostHdr => "post-hdr",
            PassStage::AfterPrepass => "after-prepass",
        }
    }

    /// The stage spelled `wire`, if any (served or not: [`PassStage::served`]).
    pub fn from_wire(wire: &str) -> Option<PassStage> {
        PassStage::VOCABULARY.into_iter().find(|stage| stage.wire() == wire)
    }

    /// Whether this build runs passes registered at the stage.
    pub const fn served(self) -> bool {
        match self {
            PassStage::AfterPrepass => AFTER_PREPASS_SERVED,
            _ => true,
        }
    }

    /// Whether only custom-pass API v2 passes may run at the stage (they read v2 inputs).
    pub const fn v2_only(self) -> bool {
        matches!(self, PassStage::PostHdr | PassStage::AfterPrepass)
    }

    /// Whether the stage's passes read the depth/normal prepass's targets once it ran: the encoder
    /// stages from `after-prepass` on (`before-cull` runs before it; the in-world stages draw into
    /// the world pass, which may be writing that depth).
    const fn reads_prepass(self) -> bool {
        matches!(self, PassStage::AfterPrepass | PassStage::PostHdr | PassStage::Post)
    }

    /// Whether the stage draws inside the world pass.
    pub const fn in_world(self) -> bool {
        matches!(self, PassStage::AfterOpaque | PassStage::AfterTransparent)
    }

    /// The frame-graph node the stage's passes run in (plan §2.2): `before-cull` is node 2, the
    /// in-world stages are the in-pass nodes 14 and 15 of the world pass, `post-hdr` is node 18,
    /// `post` is node 23, `after-prepass` (RQ4) is node 9.
    pub const fn node(self) -> NodeId {
        match self {
            PassStage::BeforeCull => NodeId::BeforeCull,
            PassStage::AfterOpaque => NodeId::AfterOpaque,
            PassStage::AfterTransparent => NodeId::Transparent,
            PassStage::Post => NodeId::Post,
            PassStage::PostHdr => NodeId::PostHdr,
            PassStage::AfterPrepass => NodeId::AfterPrepass,
        }
    }

    /// Whether the stage draws on the scene (its format): the in-world stages and `post-hdr`.
    pub const fn on_scene(self) -> bool {
        matches!(self, PassStage::AfterOpaque | PassStage::AfterTransparent | PassStage::PostHdr)
    }
}

/// Why a pass's rebuild hook runs ([`PassSetup::rebuild_reason`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RebuildReason {
    /// The pass was just registered.
    Install,
    /// The device was lost and re-created.
    DeviceLost,
    /// A pipeline-shaping setting changed (sample count, scene format, depth convention), at boot,
    /// on an explicit person or verb change, or at a loading point.
    PipelineChange,
}

impl RebuildReason {
    /// The reason's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            RebuildReason::Install => "install",
            RebuildReason::DeviceLost => "device-lost",
            RebuildReason::PipelineChange => "pipeline-change",
        }
    }
}

/// The pipeline-shaping facts of the frame a pass's pipelines are built against (plan principle
/// 8): fixed per session, changed only at boot, on an explicit change or at a loading point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PipelineFacts {
    /// The colour format in-world stages draw into.
    pub scene_format: TextureFormat,
    /// Samples per pixel of the world pass.
    pub samples: u32,
    /// Whether the world pass's depth is reversed (`Greater`, cleared to 0).
    pub depth_reversed: bool,
}

impl PipelineFacts {
    /// The legacy facts of `renderer`'s world pass: the world format with standard depth (what a
    /// registry starts from). What the next frame draws with is [`PipelineFacts::for_scene`] of
    /// [`Renderer::next_scene`] (`FrameRenderer::pipeline_facts`).
    pub fn of(renderer: &Renderer) -> PipelineFacts {
        PipelineFacts { scene_format: WORLD_FORMAT, samples: renderer.sample_count(), depth_reversed: false }
    }

    /// What a frame drawing its scene along `scene` ([`Renderer::next_scene`]) with a world pass of
    /// `samples` builds against: the HDR scene's format and reversed depth, or the legacy scene.
    pub fn for_scene(scene: &crate::renderer::ScenePath, samples: u32) -> PipelineFacts {
        PipelineFacts { scene_format: scene.format, samples, depth_reversed: scene.depth_reversed }
    }

    /// What a frame drawn with `config` by a world pass of `samples` builds against: the HDR scene
    /// in `hdr_format` with its depth convention, or the legacy LDR scene with standard Z (an
    /// `off` preset, or a frame degraded to LDR).
    pub fn for_frame(config: &FrameConfig, samples: u32, hdr_format: TextureFormat) -> PipelineFacts {
        let scene_format = if config.hdr { hdr_format } else { WORLD_FORMAT };
        PipelineFacts { scene_format, samples, depth_reversed: config.hdr && config.depth_reversed }
    }

    /// Which facts differ in `to`.
    pub fn changes_to(self, to: PipelineFacts) -> PipelineChanges {
        PipelineChanges {
            format: self.scene_format != to.scene_format,
            samples: self.samples != to.samples,
            depth: self.depth_reversed != to.depth_reversed,
        }
    }
}

/// The wire spellings of the facts a pipeline change names.
pub const PIPELINE_CHANGE_FORMAT: &str = "format";
/// See [`PIPELINE_CHANGE_FORMAT`].
pub const PIPELINE_CHANGE_SAMPLES: &str = "samples";
/// See [`PIPELINE_CHANGE_FORMAT`].
pub const PIPELINE_CHANGE_DEPTH: &str = "depth";

/// Which pipeline-shaping facts a [`RebuildReason::PipelineChange`] moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PipelineChanges {
    /// The scene format.
    pub format: bool,
    /// The world pass's samples.
    pub samples: bool,
    /// The depth convention.
    pub depth: bool,
}

impl PipelineChanges {
    /// Whether any fact moved.
    pub fn any(self) -> bool {
        self.format || self.samples || self.depth
    }

    /// The moved facts' wire spellings, in this order: `format`, `samples`, `depth`.
    pub fn wires(self) -> Vec<&'static str> {
        let all = [(self.format, PIPELINE_CHANGE_FORMAT), (self.samples, PIPELINE_CHANGE_SAMPLES), (self.depth, PIPELINE_CHANGE_DEPTH)];
        all.into_iter().filter(|(moved, _)| *moved).map(|(_, wire)| wire).collect()
    }
}

/// When a pass's wgpu error scopes are answered (module docs, "Error scopes on the web").
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScopeMode {
    /// Each scope is answered when it is popped; one that is still pending is parked (native).
    Immediate,
    /// Every scope is parked and answered on a later frame or when awaited (the web).
    Deferred,
}

impl ScopeMode {
    /// The mode of the target this is built for: deferred on the web, immediate natively.
    pub const fn for_target() -> ScopeMode {
        if cfg!(target_arch = "wasm32") { ScopeMode::Deferred } else { ScopeMode::Immediate }
    }
}

fn refusal(code: RenderCode, name: &str, detail: impl std::fmt::Display) -> RenderError {
    RenderError::refused(code, format!("pass `{name}`: {detail}"))
}

fn invalid(name: &str, detail: impl std::fmt::Display) -> RenderError {
    refusal(RenderCode::GpuPassInvalid, name, detail)
}

/// Whether the game frame hands the depth/normal prepass to Level-3 passes: both frame paths (the
/// frame renderer and [`render_scene`]) run it for what the frame's passes and Level-2 v2 sources
/// ask ([`CustomStage::prepass_demand`]) and call [`CustomStage::after_prepass`] at graph node 9
/// (RQ4.5).
pub const PREPASS_SERVED: bool = true;

/// The frame inputs whose producers have landed in this build: the environment since RQ2's bake
/// and bindings ([`crate::ibl::LANDED`]), depth and normals once the prepass reaches the passes
/// ([`PREPASS_SERVED`]), motion once the frame path's prepass writes it ([`crate::motion::LANDED`];
/// the stage binds what [`CustomStage::prepass_motion`] hands it). A v2 pass may declare any
/// input: one not produced is bound to a 1x1 neutral resource (the environment too, under the flat
/// colour; zero motion).
pub const PRODUCED_INPUTS: RenderInputs = {
    let environment = if crate::ibl::LANDED { RenderInputs::ENVIRONMENT } else { RenderInputs::NONE };
    let prepass = if PREPASS_SERVED { environment.union(RenderInputs::DEPTH).union(RenderInputs::NORMALS) } else { environment };
    if PREPASS_SERVED && crate::motion::LANDED { prepass.union(RenderInputs::MOTION) } else { prepass }
};

/// Whether this build serves the `after-prepass` stage ([`PassStage::AfterPrepass`]): exactly when
/// the prepass it follows reaches the passes ([`PREPASS_SERVED`]), since the stage's passes run in
/// [`CustomStage::after_prepass`], which the prepass's node calls (graph node 9). The stage joins
/// [`PassStage::ALL`] and the receipt's `abi::CUSTOM_PASS_STAGES` with it.
pub const AFTER_PREPASS_SERVED: bool = crate::prepass::LANDED && PREPASS_SERVED;

/// Whether `pass` is written against an API this build serves and its contract holds at `stage`:
/// a v1 pass reads no frame inputs and never runs at `post-hdr`; refused `gpu-pass-invalid` naming
/// the version, the inputs or the stage otherwise.
fn check_contract(name: &str, stage: PassStage, pass: &dyn CustomPass) -> Result<(), RenderError> {
    let api = pass.api();
    if !CUSTOM_PASS_APIS.contains(&api) {
        let served: Vec<String> = CUSTOM_PASS_APIS.iter().map(u32::to_string).collect();
        return Err(invalid(name, format!("written for custom-pass API {api}; this build serves API {}", served.join(", "))));
    }
    if api != ABI_V1 {
        return check_served(name, stage);
    }
    if stage.v2_only() {
        return Err(invalid(name, format!("`{}` is a custom-pass API v2 stage: declare api 2", stage.wire())));
    }
    let asked: Vec<&str> = pass.inputs().iter().map(RenderInputs::wire).collect();
    if asked.is_empty() {
        return Ok(());
    }
    Err(invalid(name, format!("custom-pass API v1 tables carry no frame inputs; declare api 2 to read {}", asked.join(", "))))
}

/// Whether this build serves `stage`; refused `gpu-pass-invalid` naming the stage otherwise (a stage
/// in the host's vocabulary whose node has not landed yet: a pass there would never run).
fn check_served(name: &str, stage: PassStage) -> Result<(), RenderError> {
    if stage.served() {
        return Ok(());
    }
    Err(invalid(name, format!("stage `{}` is not served by this build yet (it runs once its frame node lands)", stage.wire())))
}

/// `error` naming the pass `name` (as is when it already does).
fn named(name: &str, error: RenderError) -> RenderError {
    if error.to_string().contains(&format!("`{name}`")) {
        return error;
    }
    refusal(error.code(), name, error)
}

/// Refuse an empty, overlong or control-character pass name `gpu-pass-invalid`.
pub fn check_pass_name(name: &str) -> Result<(), RenderError> {
    let blank = name.trim().is_empty();
    let long = name.chars().count() > GPU_PASS_NAME_MAX_CHARS;
    if blank || long || name.chars().any(char::is_control) {
        return Err(invalid(name, format!("a pass name is 1 to {GPU_PASS_NAME_MAX_CHARS} printable characters")));
    }
    Ok(())
}

fn validates(module: &naga::Module, capabilities: Capabilities) -> bool {
    Validator::new(ValidationFlags::all(), capabilities).validate(module).is_ok()
}

fn feature_names(features: Features) -> String {
    let names: Vec<&str> = NATIVE_ENHANCED_FEATURES.iter().filter(|(f, _)| features.contains(*f)).map(|(_, name)| *name).collect();
    names.join(", ")
}

fn diagnostic(mut text: String) -> String {
    if let Some((at, _)) = text.char_indices().nth(DIAGNOSTIC_MAX_CHARS) {
        text.truncate(at);
    }
    text
}

/// The tables prelude of custom-pass API `api`.
pub const fn tables_wgsl(api: u32) -> &'static str {
    if api == ABI_V2 { TABLES_V2_WGSL } else { TABLES_WGSL }
}

/// Admit a pass's WGSL (with [`TABLES_WGSL`] prepended) under `context`: answers the
/// native-enhanced features it needs, or refuses it naming the pass `name` (`gpu-pass-invalid`
/// over [`crate::WGSL_MAX_BYTES`] or when naga rejects it, `native-feature-missing` when it needs
/// a feature the game did not declare or the device lacks).
pub fn validate_pass_wgsl(name: &str, source: &str, context: &ExtensionContext) -> Result<Features, RenderError> {
    validate_pass_wgsl_api(name, ABI_V1, source, context)
}

/// [`validate_pass_wgsl`] for a pass of custom-pass API `api` (its tables prelude, [`tables_wgsl`]).
pub fn validate_pass_wgsl_api(name: &str, api: u32, source: &str, context: &ExtensionContext) -> Result<Features, RenderError> {
    if source.len() > WGSL_MAX_BYTES {
        return Err(invalid(name, format!("{} bytes of WGSL, at most {WGSL_MAX_BYTES}", source.len())));
    }
    let full = format!("{}\n{source}", tables_wgsl(api));
    let module = naga::front::wgsl::parse_str(&full).map_err(|error| invalid(name, diagnostic(error.emit_to_string(&full))))?;
    let core = Validator::new(ValidationFlags::all(), naga_capabilities(Features::empty())).validate(&module);
    let Err(core_error) = core else { return Ok(Features::empty()) };
    let usable = context.usable();
    if !usable.is_empty() && validates(&module, naga_capabilities(usable)) {
        let needed = NATIVE_ENHANCED_FEATURES
            .iter()
            .filter(|(f, _)| usable.contains(*f) && !validates(&module, naga_capabilities(usable - *f)))
            .fold(Features::empty(), |all, (f, _)| all | *f);
        return Ok(needed);
    }
    let every = NATIVE_ENHANCED_FEATURES.iter().fold(Features::empty(), |all, (f, _)| all | *f);
    if validates(&module, naga_capabilities(every)) {
        let wanted = NATIVE_ENHANCED_FEATURES
            .iter()
            .filter(|(f, _)| validates(&module, naga_capabilities(*f)))
            .fold(Features::empty(), |all, (f, _)| all | *f);
        let named_features = if wanted.is_empty() { "several native-enhanced features".to_owned() } else { feature_names(wanted) };
        return Err(refusal(
            RenderCode::NativeFeatureMissing,
            name,
            format!("it needs {named_features}: declare it under [gpu] native_features in genex.toml, on a device that has it"),
        ));
    }
    Err(invalid(name, diagnostic(core_error.emit_to_string(&full))))
}

/// Check a pass's buffer: 1 to [`crate::BUFFER_MAX_BYTES`] bytes (`buffer-too-large`), never
/// mappable or mapped at creation (`gpu-pass-invalid`: nothing reads the GPU back); answers its
/// bytes.
pub fn check_buffer_descriptor(name: &str, desc: &wgpu::BufferDescriptor<'_>) -> Result<u64, RenderError> {
    if desc.size == 0 || desc.size > BUFFER_MAX_BYTES {
        return Err(refusal(RenderCode::BufferTooLarge, name, format!("a {}-byte buffer, between 1 and {BUFFER_MAX_BYTES}", desc.size)));
    }
    let mappable = desc.usage.intersects(BufferUsages::MAP_READ | BufferUsages::MAP_WRITE);
    if mappable || desc.mapped_at_creation {
        return Err(invalid(name, "a pass buffer is never mapped: nothing reads the GPU back (write it with write_buffer)"));
    }
    Ok(desc.size)
}

/// The bytes of a texture: every mip level and layer of every sample.
pub fn texture_bytes(desc: &wgpu::TextureDescriptor<'_>) -> u64 {
    let format = desc.format;
    let (block_width, block_height) = format.block_dimensions();
    let block = format.block_copy_size(None).map_or(FALLBACK_TEXEL_BYTES, u64::from);
    let levels = desc.mip_level_count.min(MIP_LEVELS_COUNTED);
    let texels: u64 = (0..levels)
        .filter_map(|level| desc.mip_level_size(level))
        .map(|size| {
            let blocks = u64::from(size.width.div_ceil(block_width)) * u64::from(size.height.div_ceil(block_height));
            blocks.saturating_mul(u64::from(size.depth_or_array_layers))
        })
        .fold(0u64, u64::saturating_add);
    texels.saturating_mul(block).saturating_mul(u64::from(desc.sample_count.max(1)))
}

/// Check a pass's texture: each side at most [`crate::caps::MAX_WORLD_PX`] and at most
/// [`crate::TEXTURE_MAX_BYTES`] in all (`texture-too-large`); answers its bytes.
pub fn check_texture_descriptor(name: &str, desc: &wgpu::TextureDescriptor<'_>) -> Result<u64, RenderError> {
    let bytes = texture_bytes(desc);
    let wide = desc.size.width > MAX_WORLD_PX || desc.size.height > MAX_WORLD_PX;
    if wide || bytes > TEXTURE_MAX_BYTES {
        let size = desc.size;
        return Err(refusal(
            RenderCode::TextureTooLarge,
            name,
            format!(
                "a {}×{}×{} texture of {bytes} bytes, at most {TEXTURE_MAX_BYTES} bytes and {MAX_WORLD_PX} px a side",
                size.width, size.height, size.depth_or_array_layers
            ),
        ));
    }
    Ok(bytes)
}

/// What a popped pair of error scopes answers: the first error either caught.
#[cfg(not(target_arch = "wasm32"))]
type ScopeFuture = Pin<Box<dyn Future<Output = Option<wgpu::Error>> + Send>>;
/// What a popped pair of error scopes answers (the browser's futures are not `Send`).
#[cfg(target_arch = "wasm32")]
type ScopeFuture = Pin<Box<dyn Future<Output = Option<wgpu::Error>>>>;

/// Run `work` inside validation and out-of-memory error scopes; answers what it returned and the
/// scopes' answer, the first error either caught.
fn scoped<T>(device: &Device, work: impl FnOnce() -> T) -> (T, ScopeFuture) {
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let value = work();
    let invalid = validation.pop();
    let out_of_memory = memory.pop();
    (value, Box::pin(async move { invalid.await.or(out_of_memory.await) }))
}

/// Both scopes' answers as one: the first error of `first`, then of `second`.
fn either(first: ScopeFuture, second: ScopeFuture) -> ScopeFuture {
    Box::pin(async move { first.await.or(second.await) })
}

/// Poll `future` once without waiting (a browser future is woken by its promise; the next poll
/// reads it).
fn poll_once(future: &mut ScopeFuture) -> Poll<Option<wgpu::Error>> {
    future.as_mut().poll(&mut Context::from_waker(Waker::noop()))
}

/// What a scope answered by the time its work needs to know.
enum Verdict {
    Clean,
    Failed(wgpu::Error),
    /// Not answered yet: parked until it is.
    Pending(ScopeFuture),
}

/// The verdict of `future` under `mode`: a deferred scope is always parked, an immediate one is
/// polled once (and parked if the backend has not answered yet).
fn judge(mode: ScopeMode, mut future: ScopeFuture) -> Verdict {
    if mode == ScopeMode::Deferred {
        return Verdict::Pending(future);
    }
    match poll_once(&mut future) {
        Poll::Ready(Some(error)) => Verdict::Failed(error),
        Poll::Ready(None) => Verdict::Clean,
        Poll::Pending => Verdict::Pending(future),
    }
}

/// What a parked scope covered: the work its error refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScopeKind {
    Rebuild,
    Frame,
    Draws,
    Submission,
}

impl ScopeKind {
    /// The refusal's words: `wgpu refused its <what>`.
    const fn what(self) -> &'static str {
        match self {
            ScopeKind::Rebuild => "rebuild",
            ScopeKind::Frame => "frame",
            ScopeKind::Draws => "draws",
            ScopeKind::Submission => "submission",
        }
    }
}

/// A scope not answered yet, for the pass at `index` on the device of `epoch`.
struct Parked {
    epoch: u32,
    index: usize,
    kind: ScopeKind,
    future: ScopeFuture,
    /// What a clean answer proves of an in-world pass's draws (empty for the other kinds).
    proves: Vec<DrawFact>,
}

/// The scopes a registry had parked ([`CustomPasses::take_pending`]), to await where waiting is
/// allowed (a capture, the boot).
pub struct PendingScopes {
    epoch: u32,
    scopes: Vec<Parked>,
}

impl PendingScopes {
    /// Scopes waiting.
    pub fn len(&self) -> usize {
        self.scopes.len()
    }

    /// Whether none waits.
    pub fn is_empty(&self) -> bool {
        self.scopes.is_empty()
    }

    /// Await every scope's answer.
    pub async fn settle(self) -> SettledScopes {
        let mut answers = Vec::with_capacity(self.scopes.len());
        for parked in self.scopes {
            let error = parked.future.await;
            answers.push(Answer { index: parked.index, kind: parked.kind, error: error.map(|error| error.to_string()), proves: parked.proves });
        }
        SettledScopes { epoch: self.epoch, answers }
    }
}

/// The answers of awaited scopes, for [`CustomPasses::apply_settled`].
pub struct SettledScopes {
    epoch: u32,
    answers: Vec<Answer>,
}

/// One scope's answer for the pass at `index`: the error it caught, if any, and what a clean
/// answer proves of the pass's draws.
struct Answer {
    index: usize,
    kind: ScopeKind,
    error: Option<String>,
    proves: Vec<DrawFact>,
}

/// The tables bind group's layout (API v1): the frame uniforms, then the instance and material
/// tables read-only, visible to every stage.
fn tables_layout(device: &Device) -> BindGroupLayout {
    let visibility = ShaderStages::VERTEX_FRAGMENT | ShaderStages::COMPUTE;
    let storage = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    };
    let frame = wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(GX_FRAME_V1_BYTES),
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("custom pass tables"), entries: &[frame, storage(1), storage(2)] })
}

/// The v2 tables bind group's layout ([`TABLES_V2_BINDINGS`]).
fn tables_v2_layout(device: &Device) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("custom pass tables v2"), entries: &layout_entries(TABLES_V2_BINDINGS, 0) })
}

/// What the v2 tables of one registry hold beside the renderer's rows: their layout, the
/// environment group's layout, the v2 frame bytes and the neutral inputs.
struct TablesV2 {
    layout: BindGroupLayout,
    environment_layout: BindGroupLayout,
    frame: FrameV2,
    neutral: NeutralInputs,
}

impl TablesV2 {
    fn new(gpu: &Gpu) -> Result<TablesV2, RenderError> {
        let environment_layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("custom pass environment"),
            entries: &layout_entries(ENVIRONMENT_BINDINGS, 0),
        });
        Ok(TablesV2 {
            layout: tables_v2_layout(&gpu.device),
            environment_layout,
            frame: FrameV2::new(&gpu.device)?,
            neutral: NeutralInputs::new(&gpu.device, &gpu.queue),
        })
    }
}

/// A pass the game registered. Its rebuild hook creates every resource through [`PassSetup`] (at
/// install and again on a new device after a loss); its encode hook records one frame's work.
pub trait CustomPass {
    /// Create (or re-create) the pass's resources.
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), RenderError>;
    /// Record this frame's work into `frame`.
    fn encode(&mut self, frame: &mut PassFrame<'_>);
    /// The custom-pass API version the pass is written against (its tables layout, formats and
    /// stages): 1 by default, 2 for the v2 tables, the scene format and `post-hdr`.
    fn api(&self) -> u32 {
        ABI_V1
    }
    /// The frame inputs the pass reads beyond the tables (API v2); the frame graph produces each
    /// one a running pass declares. None by default.
    fn inputs(&self) -> RenderInputs {
        RenderInputs::NONE
    }
}

/// What a rebuild hook creates resources through (see the module docs).
pub struct PassSetup<'a> {
    name: &'a str,
    stage: PassStage,
    api: u32,
    device: &'a Device,
    queue: &'a Queue,
    context: ExtensionContext,
    tables_layout: &'a BindGroupLayout,
    environment_layout: Option<&'a BindGroupLayout>,
    world_size: (u32, u32),
    facts: PipelineFacts,
    changes: PipelineChanges,
    bytes: u64,
    quality: &'a Quality,
    reason: RebuildReason,
}

impl<'a> PassSetup<'a> {
    /// Why this rebuild runs.
    pub fn rebuild_reason(&self) -> RebuildReason {
        self.reason
    }

    /// Which pipeline-shaping facts moved, for [`RebuildReason::PipelineChange`] (none otherwise).
    pub fn pipeline_changes(&self) -> PipelineChanges {
        self.changes
    }

    /// The pipeline-shaping facts this rebuild builds against.
    pub fn pipeline_facts(&self) -> PipelineFacts {
        self.facts
    }

    /// The quality in effect (a pass may size its own work by it).
    pub fn quality(&self) -> &Quality {
        self.quality
    }

    /// The pass's name.
    pub fn name(&self) -> &str {
        self.name
    }

    /// The stage it runs at.
    pub fn stage(&self) -> PassStage {
        self.stage
    }

    /// The custom-pass API it is built for ([`CustomPass::api`]).
    pub fn api(&self) -> u32 {
        self.api
    }

    /// The world target's size in pixels.
    pub fn world_size(&self) -> (u32, u32) {
        self.world_size
    }

    /// The colour format the stage renders into: the scene format for in-world stages and
    /// `post-hdr` (the legacy `Bgra8Unorm` LDR scene, or the HDR scene of an HDR session), the
    /// world target's (`Bgra8Unorm`, what captures read) for the others.
    pub fn world_format(&self) -> TextureFormat {
        if self.stage.on_scene() { self.facts.scene_format } else { WORLD_FORMAT }
    }

    /// Whether the world pass's depth is reversed (`Greater`, cleared to 0: the HDR path).
    pub fn depth_reversed(&self) -> bool {
        self.facts.depth_reversed
    }

    /// The world pass's depth format (what in-world pipelines test against).
    pub fn depth_format(&self) -> TextureFormat {
        DEPTH_FORMAT
    }

    /// Samples per pixel of what the stage renders into: the world pass's for in-world stages
    /// (4 with MSAA), 1 for the resolved target a post pass sees.
    pub fn samples(&self) -> u32 {
        if self.stage.in_world() { self.facts.samples } else { 1 }
    }

    /// The world's depth test for an in-world pipeline: `Less` and writing, or `LessEqual` and
    /// read-only (blended work); `Greater` and `GreaterEqual` under reversed depth.
    pub fn world_depth(&self, write: bool) -> wgpu::DepthStencilState {
        wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(write),
            depth_compare: Some(depth_compare(write, self.facts.depth_reversed)),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }
    }

    /// The multisample state of a pipeline drawing at this stage.
    pub fn world_multisample(&self) -> wgpu::MultisampleState {
        wgpu::MultisampleState { count: self.samples(), ..Default::default() }
    }

    /// The colour target of a pipeline drawing into TAA's motion target
    /// ([`PassFrame::motion_draws`]): [`crate::motion::MOTION_FORMAT`], written whole.
    pub fn motion_target(&self) -> wgpu::ColorTargetState {
        wgpu::ColorTargetState { format: crate::motion::MOTION_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL }
    }

    /// The colour target of a pipeline drawing into TAA's reactive mask
    /// ([`PassFrame::reactive_draws`]): [`crate::post::taa::REACTIVE_FORMAT`], max-blended, so the
    /// renderer's own coverage and the prepass's no-history flags stay where they are higher.
    pub fn reactive_target(&self) -> wgpu::ColorTargetState {
        let max = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max };
        let blend = wgpu::BlendState { color: max, alpha: max };
        wgpu::ColorTargetState { format: crate::post::taa::REACTIVE_FORMAT, blend: Some(blend), write_mask: wgpu::ColorWrites::RED }
    }

    /// The depth test of a pipeline drawing TAA's motion or reactive draws against the prepass
    /// depth: nearer or equal passes (`LessEqual`, `GreaterEqual` under reversed depth), so geometry
    /// the world pass already wrote into a shared depth passes again; `write` only for motion draws
    /// (the reactive coverage reads the depth only).
    pub fn temporal_depth(&self, write: bool) -> wgpu::DepthStencilState {
        let compare = if self.facts.depth_reversed { wgpu::CompareFunction::GreaterEqual } else { wgpu::CompareFunction::LessEqual };
        wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(write),
            depth_compare: Some(compare),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }
    }

    /// The multisample state of a motion or reactive pipeline: one sample (TAA frames draw no MSAA).
    pub fn temporal_multisample(&self) -> wgpu::MultisampleState {
        wgpu::MultisampleState::default()
    }

    /// The layout of the frame's tables bind group ([`PassFrame::tables`]): [`TABLES_WGSL`]'s for
    /// an API v1 pass, [`TABLES_V2_WGSL`]'s ([`TABLES_V2_BINDINGS`]) for v2.
    pub fn tables_layout(&self) -> &'a BindGroupLayout {
        self.tables_layout
    }

    /// The layout of the environment group ([`ENVIRONMENT_BINDINGS`], [`PassFrame::environment`])
    /// an API v2 pass binds in a group of its own for image-based lighting; None for API v1.
    pub fn environment_layout(&self) -> Option<&'a BindGroupLayout> {
        self.environment_layout
    }

    /// Bytes of buffers and textures the pass holds so far (entered in the render budget).
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    fn charge(&mut self, bytes: u64, code: RenderCode) -> Result<(), RenderError> {
        match self.bytes.checked_add(bytes) {
            Some(total) if total <= GPU_PASS_BYTES_MAX => {
                self.bytes = total;
                Ok(())
            }
            _ => Err(refusal(code, self.name, format!("{bytes} more bytes after {}, at most {GPU_PASS_BYTES_MAX} a pass", self.bytes))),
        }
    }

    /// Compile `wgsl` (with the pass's tables prelude, [`tables_wgsl`], prepended) after
    /// [`validate_pass_wgsl_api`] admits it.
    pub fn create_shader(&mut self, label: &str, wgsl: &str) -> Result<wgpu::ShaderModule, RenderError> {
        validate_pass_wgsl_api(self.name, self.api, wgsl, &self.context)?;
        let full = format!("{}\n{wgsl}", tables_wgsl(self.api));
        Ok(self.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(full.into()) }))
    }

    /// A buffer within the caps ([`check_buffer_descriptor`] and [`GPU_PASS_BYTES_MAX`]).
    pub fn create_buffer(&mut self, desc: &wgpu::BufferDescriptor<'_>) -> Result<Buffer, RenderError> {
        let bytes = check_buffer_descriptor(self.name, desc)?;
        self.charge(bytes, RenderCode::BufferTooLarge)?;
        Ok(self.device.create_buffer(desc))
    }

    /// A buffer holding `contents` (rounded up to 4 bytes), usable as `usage` and as a copy
    /// destination.
    pub fn create_buffer_init(&mut self, label: &str, contents: &[u8], usage: BufferUsages) -> Result<Buffer, RenderError> {
        let size = (contents.len() as u64).div_ceil(4) * 4;
        let buffer = self.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: usage | BufferUsages::COPY_DST, mapped_at_creation: false })?;
        let mut padded = contents.to_vec();
        padded.resize(size as usize, 0);
        self.queue.write_buffer(&buffer, 0, &padded);
        Ok(buffer)
    }

    /// A texture within the caps ([`check_texture_descriptor`] and [`GPU_PASS_BYTES_MAX`]).
    pub fn create_texture(&mut self, desc: &wgpu::TextureDescriptor<'_>) -> Result<Texture, RenderError> {
        let bytes = check_texture_descriptor(self.name, desc)?;
        self.charge(bytes, RenderCode::TextureTooLarge)?;
        Ok(self.device.create_texture(desc))
    }

    /// Write `data` into `buffer` at `offset` (initial contents).
    pub fn write_buffer(&self, buffer: &Buffer, offset: u64, data: &[u8]) {
        self.queue.write_buffer(buffer, offset, data);
    }

    /// A bind group layout.
    pub fn create_bind_group_layout(&self, desc: &wgpu::BindGroupLayoutDescriptor<'_>) -> BindGroupLayout {
        self.device.create_bind_group_layout(desc)
    }

    /// A bind group.
    pub fn create_bind_group(&self, desc: &wgpu::BindGroupDescriptor<'_>) -> BindGroup {
        self.device.create_bind_group(desc)
    }

    /// A pipeline layout.
    pub fn create_pipeline_layout(&self, desc: &wgpu::PipelineLayoutDescriptor<'_>) -> wgpu::PipelineLayout {
        self.device.create_pipeline_layout(desc)
    }

    /// A render pipeline (its shaders come from [`PassSetup::create_shader`]).
    pub fn create_render_pipeline(&self, desc: &wgpu::RenderPipelineDescriptor<'_>) -> wgpu::RenderPipeline {
        self.device.create_render_pipeline(desc)
    }

    /// A compute pipeline (its shader comes from [`PassSetup::create_shader`]).
    pub fn create_compute_pipeline(&self, desc: &wgpu::ComputePipelineDescriptor<'_>) -> wgpu::ComputePipeline {
        self.device.create_compute_pipeline(desc)
    }

    /// A sampler.
    pub fn create_sampler(&self, desc: &wgpu::SamplerDescriptor<'_>) -> wgpu::Sampler {
        self.device.create_sampler(desc)
    }
}

/// The depth test of an in-world pipeline that writes depth or only reads it.
pub(crate) const fn depth_compare(write: bool, reversed: bool) -> wgpu::CompareFunction {
    match (write, reversed) {
        (true, false) => wgpu::CompareFunction::Less,
        (false, false) => wgpu::CompareFunction::LessEqual,
        (true, true) => wgpu::CompareFunction::Greater,
        (false, true) => wgpu::CompareFunction::GreaterEqual,
    }
}

/// One recorded in-world command, replayed into the world pass.
#[derive(Clone, Debug)]
enum DrawCommand {
    Pipeline(wgpu::RenderPipeline),
    BindGroup(u32, BindGroup, Vec<u32>),
    Vertex(u32, Buffer, u64, u64),
    Index(Buffer, wgpu::IndexFormat, u64, u64),
    Draw(Range<u32>, Range<u32>),
    DrawIndexed(Range<u32>, i32, Range<u32>),
    DrawIndirect(Buffer, u64),
    DrawIndexedIndirect(Buffer, u64),
}

/// `range` of a `size`-byte buffer as (offset, bytes), or None when it falls outside.
fn byte_range(range: impl RangeBounds<u64>, size: u64) -> Option<(u64, u64)> {
    let start = match range.start_bound() {
        Bound::Included(&at) => at,
        Bound::Excluded(&at) => at.checked_add(1)?,
        Bound::Unbounded => 0,
    };
    let end = match range.end_bound() {
        Bound::Included(&at) => at.checked_add(1)?,
        Bound::Excluded(&at) => at,
        Bound::Unbounded => size,
    };
    (start <= end && end <= size).then(|| (start, end - start))
}

/// Bytes of one indirect draw's arguments (`draw_indirect`: vertex count, instance count, first
/// vertex, first instance).
const DRAW_INDIRECT_BYTES: u64 = 16;
/// Bytes of one indexed indirect draw's arguments (index count, instance count, first index, base
/// vertex, first instance).
const DRAW_INDEXED_INDIRECT_BYTES: u64 = 20;
/// The alignment WebGPU asks of vertex-buffer and indirect offsets.
const COMMAND_OFFSET_ALIGNMENT: u64 = 4;
/// The most proven draw facts an in-world pass keeps (the oldest go first).
const PROVEN_FACTS_MAX: usize = 64;
/// Bind group indices a pass may set: the device is opened with WebGPU core's limits
/// ([`crate::floor::core_limits`]).
const BIND_GROUPS_MAX: u32 = wgpu::Limits::defaults().max_bind_groups;
/// Vertex buffer slots a pass may set, as [`BIND_GROUPS_MAX`].
const VERTEX_SLOTS_MAX: u32 = wgpu::Limits::defaults().max_vertex_buffers;

/// The kind of one recorded draw, as a proven fact compares it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DrawKind {
    Direct,
    Indexed,
    Indirect,
    IndexedIndirect,
}

/// What one draw of a clean proof shows WebGPU accepts (RC-11): with `pipeline` and the vertex
/// slices `slots` bound, `vertices` and `instances` (the ranges' ends) fit every buffer the
/// pipeline reads. A later draw on the same pipeline and slots, with slices at least as large and
/// ranges ending no later, fits too: the pipeline fixes the strides. Bind groups and indirect
/// arguments are not compared (wgpu validates indirect counts on the GPU; a bind group's
/// contents are not visible here).
#[derive(Clone, Debug, PartialEq)]
struct DrawFact {
    pipeline: wgpu::RenderPipeline,
    kind: DrawKind,
    /// (slot, bytes) of every vertex slice bound, by slot.
    slots: Vec<(u32, u64)>,
    vertices: u32,
    instances: u32,
}

impl DrawFact {
    /// Whether `proven` shows this draw fits.
    fn within(&self, proven: &DrawFact) -> bool {
        let same_slots = self.slots.len() == proven.slots.len()
            && self.slots.iter().zip(&proven.slots).all(|((slot, bytes), (proven_slot, proven_bytes))| slot == proven_slot && bytes >= proven_bytes);
        self.pipeline == proven.pipeline && self.kind == proven.kind && same_slots && self.vertices <= proven.vertices && self.instances <= proven.instances
    }
}

/// Whether every draw of `facts` is shown to fit by one of `proven` (no draw at all is covered).
fn covered(facts: &[DrawFact], proven: &[DrawFact]) -> bool {
    facts.iter().all(|fact| proven.iter().any(|known| fact.within(known)))
}

/// Add `facts` to `proven`, each once, keeping the newest [`PROVEN_FACTS_MAX`].
fn remember(proven: &mut Vec<DrawFact>, facts: Vec<DrawFact>) {
    for fact in facts {
        if !proven.contains(&fact) {
            proven.push(fact);
        }
    }
    let over = proven.len().saturating_sub(PROVEN_FACTS_MAX);
    proven.drain(..over);
}

/// The render-pass state a recording has set so far: what each draw is checked and described by.
#[derive(Debug, Default)]
struct DrawState {
    pipeline: Option<wgpu::RenderPipeline>,
    slots: Vec<(u32, u64)>,
    /// The index slice bound: its format and bytes.
    index: Option<(wgpu::IndexFormat, u64)>,
}

/// What an in-world pass draws: the commands of a render pass, recorded, validated and replayed
/// inside the world pass (its colour, depth and samples; see [`PassSetup::world_depth`] and
/// [`PassSetup::world_multisample`]). Each pass starts from no pipeline and no bindings of its
/// own choosing: bind everything it draws with.
///
/// What the CPU can check is checked as it is recorded, and a command that fails refuses the pass
/// (`gpu-pass-invalid`) before anything is replayed: a slice outside its buffer, a buffer without
/// the usage its command needs, a misaligned offset, an inverted range, an indexed draw past its
/// index slice (or with none of its own bound) and indirect arguments past their buffer.
#[derive(Debug)]
pub struct WorldDraws {
    tables: BindGroup,
    commands: Vec<DrawCommand>,
    fault: Option<String>,
    state: DrawState,
    /// Every draw recorded, as a proof would show it fits; None when a draw had no pipeline.
    facts: Option<Vec<DrawFact>>,
}

impl WorldDraws {
    fn new(tables: BindGroup) -> WorldDraws {
        WorldDraws { tables, commands: Vec::new(), fault: None, state: DrawState::default(), facts: Some(Vec::new()) }
    }

    /// Draw with `pipeline`.
    pub fn set_pipeline(&mut self, pipeline: &wgpu::RenderPipeline) -> &mut Self {
        self.state.pipeline = Some(pipeline.clone());
        self.commands.push(DrawCommand::Pipeline(pipeline.clone()));
        self
    }

    /// Bind `group` at `index` with its dynamic `offsets`.
    pub fn set_bind_group(&mut self, index: u32, group: &BindGroup, offsets: &[u32]) -> &mut Self {
        if index >= BIND_GROUPS_MAX {
            self.fault(|| format!("bind group index {index}, past the {BIND_GROUPS_MAX} a pipeline has"));
            return self;
        }
        self.commands.push(DrawCommand::BindGroup(index, group.clone(), offsets.to_vec()));
        self
    }

    /// Bind the frame's tables ([`PassFrame::tables`]) at `index`.
    pub fn bind_tables(&mut self, index: u32) -> &mut Self {
        let tables = self.tables.clone();
        self.set_bind_group(index, &tables, &[])
    }

    /// Keep the first fault: the one the refusal names.
    fn fault(&mut self, what: impl FnOnce() -> String) {
        self.fault.get_or_insert_with(what);
    }

    fn slice_of(&mut self, buffer: &Buffer, range: impl RangeBounds<u64>) -> Option<(u64, u64)> {
        let slice = byte_range(range, buffer.size());
        if slice.is_none() {
            self.fault(|| format!("a slice outside a {}-byte buffer", buffer.size()));
        }
        slice
    }

    /// Whether `buffer` has `usage` (a fault naming `what` otherwise).
    fn has_usage(&mut self, buffer: &Buffer, usage: BufferUsages, what: &str) -> bool {
        let has = buffer.usage().contains(usage);
        if !has {
            self.fault(|| format!("a {what} buffer without {usage:?} usage"));
        }
        has
    }

    /// Whether `offset` is a multiple of `alignment` (a fault naming `what` otherwise).
    fn aligned(&mut self, offset: u64, alignment: u64, what: &str) -> bool {
        let aligned = offset.is_multiple_of(alignment);
        if !aligned {
            self.fault(|| format!("a {what} offset of {offset} bytes, not a multiple of {alignment}"));
        }
        aligned
    }

    /// Whether `ranges` all run forwards (a fault otherwise).
    fn forwards(&mut self, ranges: &[&Range<u32>]) -> bool {
        let forwards = ranges.iter().all(|range| range.start <= range.end);
        if !forwards {
            self.fault(|| "a draw range that ends before it starts".to_owned());
        }
        forwards
    }

    /// Note a draw of `kind` reading `vertices` and `instances` (the ranges' ends) for the proof.
    fn note(&mut self, kind: DrawKind, vertices: u32, instances: u32) {
        let fact = self.state.pipeline.clone().map(|pipeline| DrawFact { pipeline, kind, slots: self.state.slots.clone(), vertices, instances });
        match (fact, self.facts.as_mut()) {
            (Some(fact), Some(facts)) => facts.push(fact),
            // A draw with no pipeline of the pass's own is never shown to fit by another frame.
            _ => self.facts = None,
        }
    }

    /// The index slice an indexed draw reads, or None (a fault) when the pass bound none.
    fn index_slice(&mut self) -> Option<(wgpu::IndexFormat, u64)> {
        let index = self.state.index;
        if index.is_none() {
            self.fault(|| "an indexed draw with no index buffer of its own".to_owned());
        }
        index
    }

    /// Whether `bytes` of indirect arguments at `offset` of `buffer` fit (a fault otherwise).
    fn indirect_fits(&mut self, buffer: &Buffer, offset: u64, bytes: u64) -> bool {
        if !self.has_usage(buffer, BufferUsages::INDIRECT, "indirect") || !self.aligned(offset, COMMAND_OFFSET_ALIGNMENT, "indirect") {
            return false;
        }
        let fits = offset.checked_add(bytes).is_some_and(|end| end <= buffer.size());
        if !fits {
            self.fault(|| format!("indirect arguments at {offset} past the end of a {}-byte buffer", buffer.size()));
        }
        fits
    }

    /// Read vertex buffer `slot` from `range` of `buffer`.
    pub fn set_vertex_buffer(&mut self, slot: u32, buffer: &Buffer, range: impl RangeBounds<u64>) -> &mut Self {
        if slot >= VERTEX_SLOTS_MAX {
            self.fault(|| format!("vertex buffer slot {slot}, past the {VERTEX_SLOTS_MAX} a pipeline has"));
            return self;
        }
        if !self.has_usage(buffer, BufferUsages::VERTEX, "vertex") {
            return self;
        }
        let Some((offset, size)) = self.slice_of(buffer, range) else { return self };
        if self.aligned(offset, COMMAND_OFFSET_ALIGNMENT, "vertex") {
            self.state.slots.retain(|(known, _)| *known != slot);
            self.state.slots.push((slot, size));
            self.state.slots.sort_unstable();
            self.commands.push(DrawCommand::Vertex(slot, buffer.clone(), offset, size));
        }
        self
    }

    /// Read indices of `format` from `range` of `buffer`.
    pub fn set_index_buffer(&mut self, buffer: &Buffer, format: wgpu::IndexFormat, range: impl RangeBounds<u64>) -> &mut Self {
        if !self.has_usage(buffer, BufferUsages::INDEX, "index") {
            return self;
        }
        let Some((offset, size)) = self.slice_of(buffer, range) else { return self };
        if self.aligned(offset, u64::from(format.byte_size()), "index") {
            self.state.index = Some((format, size));
            self.commands.push(DrawCommand::Index(buffer.clone(), format, offset, size));
        }
        self
    }

    /// Draw `vertices` of `instances`.
    pub fn draw(&mut self, vertices: Range<u32>, instances: Range<u32>) -> &mut Self {
        if self.forwards(&[&vertices, &instances]) {
            self.note(DrawKind::Direct, vertices.end, instances.end);
            self.commands.push(DrawCommand::Draw(vertices, instances));
        }
        self
    }

    /// Draw `indices` from `base_vertex` of `instances`.
    pub fn draw_indexed(&mut self, indices: Range<u32>, base_vertex: i32, instances: Range<u32>) -> &mut Self {
        if !self.forwards(&[&indices, &instances]) {
            return self;
        }
        let Some((format, bytes)) = self.index_slice() else { return self };
        let held = bytes / u64::from(format.byte_size());
        if u64::from(indices.end) > held {
            self.fault(|| format!("an indexed draw to index {} of a slice holding {held}", indices.end));
            return self;
        }
        // Vertex-rate buffers are not range-checked for an indexed draw (WebGPU): only instances count.
        self.note(DrawKind::Indexed, 0, instances.end);
        self.commands.push(DrawCommand::DrawIndexed(indices, base_vertex, instances));
        self
    }

    /// Draw from the arguments at `offset` of `buffer`.
    pub fn draw_indirect(&mut self, buffer: &Buffer, offset: u64) -> &mut Self {
        if self.indirect_fits(buffer, offset, DRAW_INDIRECT_BYTES) {
            self.note(DrawKind::Indirect, 0, 0);
            self.commands.push(DrawCommand::DrawIndirect(buffer.clone(), offset));
        }
        self
    }

    /// Draw indexed from the arguments at `offset` of `buffer`.
    pub fn draw_indexed_indirect(&mut self, buffer: &Buffer, offset: u64) -> &mut Self {
        if self.index_slice().is_some() && self.indirect_fits(buffer, offset, DRAW_INDEXED_INDIRECT_BYTES) {
            self.note(DrawKind::IndexedIndirect, 0, 0);
            self.commands.push(DrawCommand::DrawIndexedIndirect(buffer.clone(), offset));
        }
        self
    }

    /// Commands recorded so far.
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    /// Whether nothing is recorded.
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    fn replay(&self, pass: &mut wgpu::RenderPass<'_>) {
        for command in &self.commands {
            match command {
                DrawCommand::Pipeline(pipeline) => pass.set_pipeline(pipeline),
                DrawCommand::BindGroup(index, group, offsets) => pass.set_bind_group(*index, group, offsets),
                DrawCommand::Vertex(slot, buffer, offset, size) => pass.set_vertex_buffer(*slot, buffer.slice(*offset..offset + size)),
                DrawCommand::Index(buffer, format, offset, size) => pass.set_index_buffer(buffer.slice(*offset..offset + size), *format),
                DrawCommand::Draw(vertices, instances) => pass.draw(vertices.clone(), instances.clone()),
                DrawCommand::DrawIndexed(indices, base, instances) => pass.draw_indexed(indices.clone(), *base, instances.clone()),
                DrawCommand::DrawIndirect(buffer, offset) => pass.draw_indirect(buffer, *offset),
                DrawCommand::DrawIndexedIndirect(buffer, offset) => pass.draw_indexed_indirect(buffer, *offset),
            }
        }
    }
}

/// What a pass's encode hook records one frame's work into (see the module docs).
pub struct PassFrame<'f> {
    name: &'f str,
    stage: PassStage,
    depth_reversed: bool,
    tick: u64,
    world_size: (u32, u32),
    render_size: (u32, u32),
    history: History,
    quality: &'f Quality,
    device: &'f Device,
    queue: &'f Queue,
    tables: &'f BindGroup,
    environment: Option<&'f BindGroup>,
    budget: &'f mut UploadBudget,
    encoder: Option<&'f mut CommandEncoder>,
    draws: Option<&'f mut WorldDraws>,
    /// The in-world stages' draws into TAA's motion target and reactive mask (graph node 15a), on
    /// frames whose prepass writes motion.
    temporal: Option<TemporalDraws<'f>>,
    world: Option<(&'f Texture, &'f TextureView)>,
    prepass: Option<&'f PrepassViews>,
    motion: Option<&'f TextureView>,
}

/// The draws an in-world pass records for TAA (graph node 15a; [`PassFrame::motion_draws`],
/// [`PassFrame::reactive_draws`]).
struct TemporalDraws<'f> {
    motion: &'f mut WorldDraws,
    reactive: &'f mut WorldDraws,
}

impl PassFrame<'_> {
    /// The pass's name.
    pub fn name(&self) -> &str {
        self.name
    }

    /// The stage it runs at.
    pub fn stage(&self) -> PassStage {
        self.stage
    }

    /// The simulation tick this frame shows (never the wall clock).
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// The tick the frame before this one showed on the same history: what a vertex animation
    /// evaluates itself at a second time for its motion ([`PassFrame::motion_draws`]). This
    /// frame's tick on a history reset and in a capture's re-renders of one tick (no motion of its
    /// own), so a settled capture draws the same picture with or without it.
    pub fn prev_tick(&self) -> u64 {
        self.tick.saturating_sub(self.history.ticks_back)
    }

    /// The world target's size in pixels (the output size).
    pub fn world_size(&self) -> (u32, u32) {
        self.world_size
    }

    /// The scene's size in pixels: the world target's at a render scale of 1, smaller below it.
    pub fn render_size(&self) -> (u32, u32) {
        self.render_size
    }

    /// Whether the scene's depth is reversed (`Greater`, cleared to 0: the HDR path).
    pub fn depth_reversed(&self) -> bool {
        self.depth_reversed
    }

    /// The quality in effect this frame.
    pub fn quality(&self) -> &Quality {
        self.quality
    }

    /// Frames drawn since the last history reset: what temporal sequences are keyed to (one per
    /// drawn frame, whatever sim ticks it ran).
    pub fn frame_index(&self) -> u64 {
        self.history.frame_index
    }

    /// Whether temporal history starts over this frame (install, rebuild, a tick going back).
    pub fn history_reset(&self) -> bool {
        self.history.frame_index == 0
    }

    /// While a capture re-renders one tick: (this re-render's index, re-renders in all). None in
    /// Live frames.
    pub fn settle(&self) -> Option<(u32, u32)> {
        self.history.settle
    }

    /// The frame's tables, read-only, on [`PassSetup::tables_layout`]: the v1 frame and the
    /// instance and material tables for an API v1 pass; the v2 frame, the rows and the declared
    /// inputs for v2.
    pub fn tables(&self) -> &BindGroup {
        self.tables
    }

    /// This frame's environment on [`PassSetup::environment_layout`] (API v2; None for v1): the
    /// renderer's specular cube, SH9, BRDF LUT and sampler once it handed them over
    /// ([`CustomStage::environment`]), else the neutral inputs.
    pub fn environment(&self) -> Option<&BindGroup> {
        self.environment
    }

    /// The pass's own encoder (before-cull and post stages; None in the world pass).
    pub fn encoder(&mut self) -> Option<&mut CommandEncoder> {
        self.encoder.as_deref_mut()
    }

    /// What an in-world pass draws (after-opaque and after-transparent stages; None otherwise).
    pub fn draws(&mut self) -> Option<&mut WorldDraws> {
        self.draws.as_deref_mut()
    }

    /// What an in-world pass draws into TAA's motion target (renderer pass 2, B.7), on frames
    /// whose prepass writes motion (TAA); None at other stages and on other frames. Geometry the
    /// pass moves itself (a vertex animation, an instance it moves) draws its motion here, so TAA
    /// reprojects it instead of trailing it: [`crate::motion::MOTION_FORMAT`] NDC motion, this
    /// frame's position minus last frame's, both through the unjittered matrices
    /// (`gx_frame.unjittered_view_proj` and `gx_frame.prev_view_proj`), rasterised through the
    /// jittered `gx_frame.view_proj` as the world draw was. Replayed after the world pass, before
    /// the reactive coverage (graph node 15a), against the prepass depth with
    /// [`PassSetup::motion_target`], [`PassSetup::temporal_depth`] and
    /// [`PassSetup::temporal_multisample`]; writing depth there adds the geometry to the depth TAA
    /// dilates and tests disocclusion with. Without it a pass's pixels keep the motion of what the
    /// prepass drew behind them.
    pub fn motion_draws(&mut self) -> Option<&mut WorldDraws> {
        self.temporal.as_mut().map(|temporal| &mut *temporal.motion)
    }

    /// What an in-world pass draws into TAA's reactive mask (renderer pass 2, B.7), on frames whose
    /// prepass writes motion: 0 keeps a pixel's history, 1 takes the current sample. Blended work
    /// that moves over a background whose motion it does not share (a glow sprite, a puff of
    /// smoke) writes how much of the pixel it owns, so TAA neither trails nor pops it; still work
    /// writes nothing and accumulates. Replayed inside node 15a's coverage pass after the
    /// renderer's own, against the prepass depth read-only, with [`PassSetup::reactive_target`]
    /// (max-blended), [`PassSetup::temporal_depth`]`(false)` and [`PassSetup::temporal_multisample`].
    pub fn reactive_draws(&mut self) -> Option<&mut WorldDraws> {
        self.temporal.as_mut().map(|temporal| &mut *temporal.reactive)
    }

    /// The colour target of an encoder stage: the resolved world target at `post` (`Bgra8Unorm`,
    /// the frame captures read), the scene colour at `post-hdr`; a copy source and a render
    /// attachment. None at the other stages.
    pub fn world_texture(&self) -> Option<&Texture> {
        self.world.map(|(texture, _)| texture)
    }

    /// A view of [`PassFrame::world_texture`] (`post` and `post-hdr` only).
    pub fn world_view(&self) -> Option<&TextureView> {
        self.world.map(|(_, view)| view)
    }

    /// The prepass depth of this frame ([`crate::renderer::DEPTH_FORMAT`], render size, the
    /// frame's depth convention) at `after-prepass`, `post-hdr` and `post` once the prepass ran;
    /// None at the other stages and on frames without a prepass. The v2 tables bind it as
    /// `gx_depth` too.
    pub fn prepass_depth(&self) -> Option<&TextureView> {
        self.prepass.map(|prepass| &prepass.depth)
    }

    /// The prepass's octahedral normals ([`crate::prepass::NORMALS_FORMAT`]), as
    /// [`PassFrame::prepass_depth`]; the v2 tables bind them as `gx_normals`.
    pub fn prepass_normals(&self) -> Option<&TextureView> {
        self.prepass.map(|prepass| &prepass.normals)
    }

    /// The prepass's motion of this frame ([`crate::motion::MOTION_FORMAT`], render size: NDC
    /// motion, current minus previous with the jitter removed, so a pixel at `uv` was at
    /// `uv - motion * (0.5, -0.5)` last frame) at `after-prepass`, `post-hdr` and `post` once the
    /// prepass wrote motion ([`CustomStage::prepass_motion`]); None at the other stages and on
    /// frames without motion. The v2 tables bind it as `gx_motion` too (zero motion otherwise).
    pub fn prepass_motion(&self) -> Option<&TextureView> {
        self.motion
    }

    /// Write `data` into `buffer` at `offset` before this frame's GPU work, within the frame's
    /// upload budget (`upload-budget` naming the pass otherwise).
    pub fn write_buffer(&mut self, buffer: &Buffer, offset: u64, data: &[u8]) -> Result<(), RenderError> {
        self.budget.charge(data.len() as u64).map_err(|error| named(self.name, error))?;
        self.queue.write_buffer(buffer, offset, data);
        Ok(())
    }

    /// A bind group for this frame (over the world view, say).
    pub fn create_bind_group(&self, desc: &wgpu::BindGroupDescriptor<'_>) -> BindGroup {
        self.device.create_bind_group(desc)
    }
}

/// Where a frame sits in its temporal history.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct History {
    frame_index: u64,
    settle: Option<(u32, u32)>,
    /// Sim ticks back to the frame drawn before this one on the same history (0 on a history
    /// reset and in a capture's re-renders of one tick): [`PassFrame::prev_tick`].
    ticks_back: u64,
}

/// The temporal history Live frames and captures are keyed to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct HistoryClock {
    /// The tick Live's history last started at; None until the first frame or after a reset.
    origin: Option<u64>,
    /// While capturing: the next settle re-render's index and the re-renders in all.
    capture: Option<(u32, u32)>,
    /// The tick Live's last frame showed (a capture leaves it as it was).
    last: Option<u64>,
}

impl HistoryClock {
    /// The history of a frame at `tick`: in Live, rendered ticks since the last reset (a first
    /// frame, a rebuild or a tick before the origin starts over); in a capture, the settle index
    /// from an empty history, leaving Live's origin as it was.
    fn at(&mut self, tick: u64) -> History {
        if let Some((index, count)) = self.capture.as_mut() {
            let settle = ((*index).min(count.saturating_sub(1)), *count);
            *index = index.saturating_add(1);
            return History { frame_index: u64::from(settle.0), settle: Some(settle), ticks_back: 0 };
        }
        let origin = match self.origin {
            Some(origin) if origin <= tick => origin,
            _ => *self.origin.insert(tick),
        };
        let frame_index = tick - origin;
        let last = self.last.replace(tick).filter(|last| *last <= tick && frame_index > 0);
        History { frame_index, settle: None, ticks_back: last.map_or(0, |last| tick - last) }
    }
}

/// One registered pass.
#[derive(Clone, Debug)]
struct Entry {
    name: String,
    stage: PassStage,
    api: u32,
    inputs: RenderInputs,
    bytes: u64,
    enabled: bool,
    /// The code that stopped it, once it no longer runs.
    refused: Option<RenderCode>,
    /// Whether one of its in-world proofs resolved clean on this device (deferred scopes keep its
    /// draws out of the world pass until then).
    proven: bool,
    /// The draws its clean proofs showed fit (RC-11): while a later proof is pending, a frame's
    /// draws are replayed only when these cover every one of them.
    proven_draws: Vec<DrawFact>,
}

/// The passes one renderer runs: their names, stages, bytes and refusals, and the tables layout
/// they bind. The pass objects stay the caller's (the facade's `Game`); every frame hands them
/// over in registration order ([`CustomPasses::frame`]).
pub struct CustomPasses {
    context: ExtensionContext,
    tables_layout: BindGroupLayout,
    world_size: (u32, u32),
    /// The scene's size this frame (below a render scale of 1, smaller than the world's).
    render_size: (u32, u32),
    facts: PipelineFacts,
    /// What the rebuild under way changed (none outside a pipeline change).
    changes: PipelineChanges,
    mode: ScopeMode,
    /// Scopes not answered yet, oldest first.
    parked: Vec<Parked>,
    /// Bumped by every rebuild: a scope of an older epoch is of an older device or pipeline set.
    epoch: u32,
    entries: Vec<Entry>,
    refusals: Vec<RenderError>,
    /// The throwaway attachments in-world draws are validated against (world formats and samples).
    proving: Option<(TextureView, TextureView)>,
    /// The throwaway single-sampled attachments motion and reactive draws are validated against
    /// (the motion format, the reactive mask's, the depth).
    temporal_proving: Option<(TextureView, TextureView, TextureView)>,
    /// The v1 frame uniforms the tables bind.
    compat: CompatFrame,
    /// The v2 tables' layout, frame bytes and neutral inputs, once a v2 pass registers.
    v2: Option<TablesV2>,
    /// The renderer's environment v2 passes bind (None: the neutral inputs).
    environment: Option<EnvironmentViews>,
    /// The camera v2 frames read their matrices from.
    camera: Option<crate::scene::CameraDesc>,
    quality: Quality,
    /// The temporal history frames are keyed to.
    history: HistoryClock,
}

impl CustomPasses {
    /// The passes of `renderer` on `gpu`, for a game that declares `declared` native-enhanced
    /// features.
    pub fn new(gpu: &Gpu, renderer: &Renderer, declared: Features) -> CustomPasses {
        CustomPasses {
            context: ExtensionContext::for_gpu(gpu, declared),
            tables_layout: tables_layout(&gpu.device),
            world_size: renderer.size(),
            render_size: renderer.render_size(),
            facts: PipelineFacts::of(renderer),
            changes: PipelineChanges::default(),
            mode: ScopeMode::for_target(),
            parked: Vec::new(),
            epoch: 0,
            entries: Vec::new(),
            refusals: Vec::new(),
            proving: None,
            temporal_proving: None,
            compat: CompatFrame::new(&gpu.device),
            v2: None,
            environment: None,
            camera: None,
            quality: Quality::off(),
            history: HistoryClock::default(),
        }
    }

    /// The camera the next frames' v2 tables read their view and projection from (the renderer's
    /// own `view_proj` comes from its frame uniforms either way).
    pub fn set_camera(&mut self, camera: crate::scene::CameraDesc) {
        self.camera = Some(camera);
    }

    /// The environment the next frames' v2 passes bind (in their tables as `gx_env_specular` and
    /// `gx_env_sh`, and as [`PassFrame::environment`]): the renderer's, or None for the neutral
    /// inputs. A frame renderer hands it over each frame through [`CustomStage::environment`].
    pub fn set_environment(&mut self, environment: Option<EnvironmentViews>) {
        self.environment = environment;
    }

    /// The environment v2 passes bind ([`CustomPasses::set_environment`]).
    pub fn environment(&self) -> Option<&EnvironmentViews> {
        self.environment.as_ref()
    }

    /// Why a session running these passes draws on the legacy LDR scene: a running API v1 pass at
    /// an in-world stage (`custom-pass-v1-in-world`), which expects the sRGB-encoded world target.
    /// None otherwise (v1 `post` passes always see the LDR world target).
    pub fn ldr_reason(&self) -> Option<LdrReason> {
        let v1_in_world = self.running().any(|entry| entry.api == ABI_V1 && entry.stage.in_world());
        v1_in_world.then_some(LdrReason::CustomPassV1InWorld)
    }

    /// Whether a running pass is registered at `stage` (a `post-hdr` grade changes the scene auto
    /// exposure meters: a settled capture then re-meters once more,
    /// `settle::GRADED_EXPOSURE_SETTLE_FRAMES`).
    pub fn runs_at(&self, stage: PassStage) -> bool {
        self.running().any(|entry| entry.stage == stage)
    }

    /// `config` as these passes let it draw: LDR with standard Z for [`CustomPasses::ldr_reason`].
    pub fn frame_config(&self, config: FrameConfig) -> FrameConfig {
        self.ldr_reason().map_or(config, |reason| config.degraded_to_ldr(reason))
    }

    /// The frame inputs the running v2 passes declare: what the graph enables producers for (the
    /// receipt's `renderInputs`).
    pub fn render_inputs(&self) -> RenderInputs {
        self.running().fold(RenderInputs::NONE, |all, entry| all | entry.inputs)
    }

    /// What these passes ask of the depth/normal prepass (plan principle 3, inputs drive
    /// producers): the inputs running v2 passes declare, whether one runs at `after-prepass`, and
    /// `extension_inputs`, what the Level-2 v2 sources in use bind
    /// (`CustomMaterials::inputs() | PostPasses::inputs()`). The frame renderer hands it to
    /// [`crate::prepass::consumers`].
    pub fn prepass_demand(&self, extension_inputs: RenderInputs) -> crate::prepass::ExtensionDemand {
        crate::prepass::ExtensionDemand {
            custom_inputs: self.render_inputs(),
            after_prepass: self.running().any(|entry| entry.stage == PassStage::AfterPrepass),
            extension_inputs,
        }
    }

    /// What the v2 tables of a frame at `history` say about it.
    fn frame_facts(&self, history: History) -> FrameFacts {
        let facts = FrameFacts {
            frame_index: history.frame_index,
            history_reset: history.frame_index == 0,
            depth_reversed: self.facts.depth_reversed,
            scene_ldr: self.facts.scene_format == WORLD_FORMAT,
            settle_index: history.settle.map_or(0, |(index, _)| index),
            ..FrameFacts::new(self.world_size, self.render_size)
        };
        match self.camera {
            Some(camera) => facts.with_camera(camera),
            None => facts,
        }
    }

    /// The quality passes see from now on. A pipeline-shaping change re-runs every rebuild with
    /// [`RebuildReason::PipelineChange`] ([`CustomPasses::set_pipeline_facts`]).
    pub fn set_quality(&mut self, quality: Quality) {
        self.quality = quality;
    }

    /// The scene's size passes see from the next frame ([`PassFrame::render_size`]): the
    /// renderer's `render_size()`, which the presenter hands over every frame.
    pub fn set_render_size(&mut self, size: (u32, u32)) {
        self.render_size = size;
    }

    /// The pipeline-shaping facts passes are built against.
    pub fn pipeline_facts(&self) -> PipelineFacts {
        self.facts
    }

    /// Build against `facts` from now on. When they differ from the current ones, every running
    /// pass's rebuild hook runs again through the device-loss path with
    /// [`RebuildReason::PipelineChange`] and [`PassSetup::pipeline_changes`] naming what moved (a
    /// pass refused now stops running, as after a loss). Answers whether anything was rebuilt.
    pub fn set_pipeline_facts(&mut self, gpu: &Gpu, passes: &mut [&mut dyn CustomPass], facts: PipelineFacts) -> Result<bool, RenderError> {
        if facts == self.facts {
            return Ok(false);
        }
        self.changes = self.facts.changes_to(facts);
        self.facts = facts;
        let rebuilt = self.rebuild_for(gpu, passes, RebuildReason::PipelineChange);
        self.changes = PipelineChanges::default();
        rebuilt.map(|()| true)
    }

    /// When scopes are answered from now on (the web's default is [`ScopeMode::Deferred`]; a native
    /// test sets it to exercise the web's path).
    pub fn set_scope_mode(&mut self, mode: ScopeMode) {
        self.mode = mode;
    }

    /// When scopes are answered.
    pub fn scope_mode(&self) -> ScopeMode {
        self.mode
    }

    /// Scopes parked and not answered yet.
    pub fn pending_scopes(&self) -> usize {
        self.parked.len()
    }

    /// Poll every parked scope once without waiting and apply the answers that came: a pass whose
    /// scope caught an error is refused `gpu-pass-invalid` and stops running. [`CustomPasses::frame`]
    /// calls it first. Answers the scopes answered.
    pub fn poll_scopes(&mut self) -> usize {
        let parked = std::mem::take(&mut self.parked);
        let mut answered = 0;
        for mut scope in parked {
            if scope.epoch != self.epoch {
                continue;
            }
            match poll_once(&mut scope.future) {
                Poll::Ready(error) => {
                    answered += 1;
                    let answer = Answer { index: scope.index, kind: scope.kind, error: error.map(|error| error.to_string()), proves: scope.proves };
                    let _ = self.answer(answer);
                }
                Poll::Pending => self.parked.push(scope),
            }
        }
        answered
    }

    /// The parked scopes, to await where the caller can wait (the web's capture and boot); hand
    /// what they settle to [`CustomPasses::apply_settled`].
    pub fn take_pending(&mut self) -> PendingScopes {
        let epoch = self.epoch;
        let scopes = std::mem::take(&mut self.parked).into_iter().filter(|scope| scope.epoch == epoch).collect();
        PendingScopes { epoch, scopes }
    }

    /// Apply awaited scopes' answers; answers of an older device or pipeline set are dropped.
    /// Answers whether they changed what the frame draws: a pass refused, or an in-world pass
    /// proven for the first time since its build (its draws were held out until now), so a capture
    /// drawn before the answers must be drawn again.
    pub fn apply_settled(&mut self, settled: SettledScopes) -> bool {
        if settled.epoch != self.epoch {
            return false;
        }
        let mut changed = false;
        for answer in settled.answers {
            changed |= self.answer(answer);
        }
        changed
    }

    /// One scope's answer for the pass at `index`: a clean proof admits its draws, an error refuses
    /// it (once: a pass already stopped keeps its first refusal). Answers whether it changed what
    /// the frame draws (a first proof, or a refusal).
    fn answer(&mut self, answer: Answer) -> bool {
        let Answer { index, kind, error, proves } = answer;
        let Some(entry) = self.entries.get_mut(index) else { return false };
        let Some(error) = error else {
            let first_proof = kind == ScopeKind::Draws && !entry.proven;
            entry.proven |= first_proof;
            remember(&mut entry.proven_draws, proves);
            return first_proof && entry.enabled;
        };
        if !entry.enabled {
            return false;
        }
        let refusal = invalid(&entry.name, format!("wgpu refused its {}: {error}", kind.what()));
        self.refuse(index, refusal);
        true
    }

    /// Stop the pass at `index` with `error`, kept with the refusals.
    fn refuse(&mut self, index: usize, error: RenderError) {
        self.entries[index].enabled = false;
        self.entries[index].refused = Some(error.code());
        self.refusals.push(error);
    }

    fn park(&mut self, index: usize, kind: ScopeKind, future: ScopeFuture) {
        self.park_proving(index, kind, future, Vec::new());
    }

    /// [`CustomPasses::park`] for a scope whose clean answer proves `proves` of the pass's draws.
    fn park_proving(&mut self, index: usize, kind: ScopeKind, future: ScopeFuture, proves: Vec<DrawFact>) {
        self.parked.push(Parked { epoch: self.epoch, index, kind, future, proves });
    }

    /// Register every running pass's bytes in `ledger` (kind [`BudgetKind::Pass`], by name).
    pub fn register_budget(&self, ledger: &mut BudgetLedger) {
        for entry in self.running() {
            ledger.register(BudgetKind::Pass, &entry.name, entry.bytes);
        }
    }

    /// The running passes' bytes by name, in registration order (`BudgetInput::with_pass`).
    pub fn budget_passes(&self) -> Vec<(String, u64)> {
        self.running().map(|entry| (entry.name.clone(), entry.bytes)).collect()
    }

    /// The running passes past `budget_bytes` when they are added, in registration order, on top
    /// of `other_bytes` the frame already holds: what `volatile.render.degraded` lists.
    pub fn over_budget(&self, other_bytes: u64, budget_bytes: u64) -> Vec<String> {
        let mut total = other_bytes;
        let mut over = Vec::new();
        for entry in self.running() {
            total = total.saturating_add(entry.bytes);
            if total > budget_bytes {
                over.push(entry.name.clone());
            }
        }
        over
    }

    fn running(&self) -> impl Iterator<Item = &Entry> {
        self.entries.iter().filter(|entry| entry.enabled)
    }

    /// The quality passes see.
    pub fn quality(&self) -> &Quality {
        &self.quality
    }

    /// The history of a frame at `tick` ([`HistoryClock::at`]).
    fn history_at(&mut self, tick: u64) -> History {
        self.history.at(tick)
    }

    /// Draw the next frames as a capture's `settle_frames` re-renders of one tick (`Some`: each
    /// starts from an empty history, [`PassFrame::settle`] set) or as Live frames again (`None`:
    /// Live's history resumes where it was).
    pub fn set_capture(&mut self, settle_frames: Option<u32>) {
        self.history.capture = settle_frames.map(|count| (0, count.max(1)));
    }

    /// Passes registered.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether none is registered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The passes' names and stages, in registration order.
    pub fn passes(&self) -> Vec<(&str, PassStage)> {
        self.entries.iter().map(|entry| (entry.name.as_str(), entry.stage)).collect()
    }

    /// The code that stopped the registered pass `name` (None while it runs, or for a name not
    /// registered): what the facade reports in `state().volatile.customPasses`.
    pub fn refusal_of(&self, name: &str) -> Option<RenderCode> {
        self.entries.iter().find(|entry| entry.name == name).and_then(|entry| entry.refused)
    }

    /// Whether the pass `name` is registered and still runs.
    pub fn is_enabled(&self, name: &str) -> bool {
        self.entries.iter().any(|entry| entry.name == name && entry.enabled)
    }

    /// Bytes the pass `name` holds.
    pub fn bytes(&self, name: &str) -> Option<u64> {
        self.entries.iter().find(|entry| entry.name == name).map(|entry| entry.bytes)
    }

    /// Refusals met while running frames or rebuilding, oldest first.
    pub fn refusals(&self) -> &[RenderError] {
        &self.refusals
    }

    /// The refusals so far, clearing them.
    pub fn take_refusals(&mut self) -> Vec<RenderError> {
        std::mem::take(&mut self.refusals)
    }

    /// Run `pass`'s rebuild hook: its bytes, and its scope when that is not answered yet.
    fn build(&self, gpu: &Gpu, name: &str, stage: PassStage, pass: &mut dyn CustomPass, reason: RebuildReason) -> Result<(u64, Option<ScopeFuture>), RenderError> {
        let api = pass.api();
        let tables_layout = match &self.v2 {
            Some(v2) if api == ABI_V2 => &v2.layout,
            _ => &self.tables_layout,
        };
        let environment_layout = self.v2.as_ref().filter(|_| api == ABI_V2).map(|v2| &v2.environment_layout);
        let mut setup = PassSetup {
            name,
            stage,
            api,
            device: &gpu.device,
            queue: &gpu.queue,
            context: self.context,
            tables_layout,
            environment_layout,
            world_size: self.world_size,
            facts: self.facts,
            changes: self.changes,
            bytes: 0,
            quality: &self.quality,
            reason,
        };
        let (built, scope) = scoped(&gpu.device, || pass.rebuild(&mut setup));
        built.map_err(|error| named(name, error))?;
        match judge(self.mode, scope) {
            Verdict::Clean => Ok((setup.bytes, None)),
            Verdict::Failed(error) => Err(invalid(name, format!("wgpu refused its {}: {error}", ScopeKind::Rebuild.what()))),
            Verdict::Pending(scope) => Ok((setup.bytes, Some(scope))),
        }
    }

    /// Register `pass` as `name` at `stage` and run its rebuild hook; a refusal leaves it
    /// unregistered (`gpu-pass-invalid` for a bad or duplicate name, one pass over
    /// [`GPU_PASSES_MAX`] or wgpu's validation; the caps' and naga's codes otherwise), naming it.
    pub fn register(&mut self, gpu: &Gpu, name: &str, stage: PassStage, pass: &mut dyn CustomPass) -> Result<(), RenderError> {
        check_pass_name(name)?;
        if self.entries.iter().any(|entry| entry.name == name) {
            return Err(invalid(name, "another pass already has this name"));
        }
        if self.entries.len() >= GPU_PASSES_MAX {
            return Err(invalid(name, format!("at most {GPU_PASSES_MAX} custom passes")));
        }
        self.context.check_device().map_err(|error| named(name, error))?;
        check_contract(name, stage, pass)?;
        if pass.api() == ABI_V2 && self.v2.is_none() {
            self.v2 = Some(TablesV2::new(gpu).map_err(|error| named(name, error))?);
        }
        let (bytes, pending) = self.build(gpu, name, stage, pass, RebuildReason::Install)?;
        let (api, inputs) = (pass.api(), pass.inputs());
        self.entries.push(Entry { name: name.to_owned(), stage, api, inputs, bytes, enabled: true, refused: None, proven: false, proven_draws: Vec::new() });
        if let Some(scope) = pending {
            self.park(self.entries.len() - 1, ScopeKind::Rebuild, scope);
        }
        Ok(())
    }

    fn check_list(&self, given: usize) -> Result<(), RenderError> {
        if given == self.entries.len() {
            return Ok(());
        }
        Err(RenderError::refused(RenderCode::GpuPassInvalid, format!("{given} passes handed over for {} registered", self.entries.len())))
    }

    /// Re-create every running pass's resources on `gpu` (after device loss), in registration
    /// order; a pass refused now stops running and its refusal is kept. Answers the first.
    pub fn rebuild(&mut self, gpu: &Gpu, passes: &mut [&mut dyn CustomPass]) -> Result<(), RenderError> {
        self.rebuild_for(gpu, passes, RebuildReason::DeviceLost)
    }

    /// [`CustomPasses::rebuild`] for `reason` (a device loss or a pipeline-shaping change); the
    /// passes' temporal history starts over, scopes of the old pipelines are dropped and in-world
    /// passes are proven again.
    pub fn rebuild_for(&mut self, gpu: &Gpu, passes: &mut [&mut dyn CustomPass], reason: RebuildReason) -> Result<(), RenderError> {
        self.check_list(passes.len())?;
        self.context = ExtensionContext::for_gpu(gpu, self.context.declared());
        // The tables and the v1 frame's refresh belong to the device, not to the pipeline facts: a
        // pipeline change keeps them (their refresh pipeline compiled again on the frame thread
        // at every anti-aliasing change, pass-1 gate).
        if reason != RebuildReason::PipelineChange {
            self.tables_layout = tables_layout(&gpu.device);
            self.compat = CompatFrame::new(&gpu.device);
            if self.v2.is_some() {
                self.v2 = Some(TablesV2::new(gpu)?);
            }
        }
        self.proving = None;
        self.temporal_proving = None;
        self.history.origin = None;
        self.history.last = None;
        self.epoch = self.epoch.wrapping_add(1);
        self.parked.clear();
        let mut first = None;
        for (index, pass) in passes.iter_mut().enumerate() {
            let Entry { name, stage, enabled, .. } = self.entries[index].clone();
            if !enabled {
                continue;
            }
            self.entries[index].proven = false;
            self.entries[index].proven_draws.clear();
            match self.build(gpu, &name, stage, &mut **pass, reason) {
                Ok((bytes, pending)) => {
                    self.entries[index].bytes = bytes;
                    if let Some(scope) = pending {
                        self.park(index, ScopeKind::Rebuild, scope);
                    }
                }
                Err(error) => {
                    self.refuse(index, error.clone());
                    first.get_or_insert(error);
                }
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// One frame's run of `passes` (the registered passes, in registration order) at `tick`: the
    /// stage a renderer draws through ([`render_scene`], `FrameRenderer::render_with`).
    pub fn frame<'a, 'p>(&'a mut self, gpu: &Gpu, passes: &'a mut [&'p mut dyn CustomPass], tick: u64) -> Result<PassRun<'a, 'p>, RenderError> {
        self.check_list(passes.len())?;
        self.poll_scopes();
        let history = self.history_at(tick);
        Ok(PassRun {
            registry: self,
            passes,
            tick,
            history,
            ev_compensation: 0.0,
            compat_refreshed: false,
            device: gpu.device.clone(),
            queue: gpu.queue.clone(),
            tables: None,
            tables_v2: None,
            rows: None,
            prepass: None,
            motion: None,
            tables_v2_prepass: None,
            environment_group: None,
            draws: Vec::new(),
            temporal: Vec::new(),
            built_for_scene: false,
            budget: UploadBudget::new(),
        })
    }
}

/// The depth/normal prepass's targets of one frame (graph node 7), handed to the frame's custom
/// stage at node 9 ([`CustomStage::after_prepass`]): the scene depth ([`crate::renderer::DEPTH_FORMAT`],
/// sampleable, in the frame's depth convention) and the octahedral normals
/// ([`crate::prepass::NORMALS_FORMAT`]), both at render size and single-sampled.
#[derive(Clone, Debug)]
pub struct PrepassViews {
    /// The prepass depth.
    pub depth: TextureView,
    /// The prepass normals (octahedral, `gx_oct_decode` turns a texel back into a unit normal).
    pub normals: TextureView,
}

/// What a frame renderer tells a frame's custom stage before the frame's graph runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StageFrame {
    /// Where the frame sits in its temporal history (Live's, with its reset rules, or a capture's).
    pub history: FrameHistory,
    /// The look's EV compensation (0 with the exposure switch off or on the legacy scene).
    pub ev_compensation: f32,
    /// The frame's camera: the v2 tables' `view`, `proj`, `inv_view_proj`, `unjittered_view_proj`
    /// and `prev_view_proj` come from it (renderer pass 2, B.7: before, a frame renderer never
    /// handed it over, so they were identity and zero rows unless a caller set
    /// [`CustomPasses::set_camera`]).
    pub camera: crate::scene::CameraDesc,
}

/// The custom work of one frame: compute before the cull, draws inside the world pass and post
/// work before the HUD. [`PassRun`] is the registered passes'; [`NoCustom`] is none.
pub trait CustomStage: WorldStage {
    /// The frame about to draw: its passes read this history (and v2 sources this EV
    /// compensation) instead of their own clock, so every source of a frame reads one history.
    fn begin_frame(&mut self, _frame: &StageFrame) {}
    /// The prepass ran this frame (graph node 9): run the `after-prepass` stage over its targets,
    /// and bind them as `gx_depth` and `gx_normals` in the v2 tables of every later encoder stage
    /// (`post-hdr`, `post`). In-world stages keep the neutral inputs (the world pass may be drawing
    /// into that depth).
    fn after_prepass(&mut self, _prepass: &PrepassViews) {}
    /// The prepass wrote this frame's motion target (graph node 7, RQ5:
    /// [`crate::motion::MOTION_FORMAT`] NDC motion at render size, current minus previous, the
    /// jitter removed). A frame renderer calls it before [`CustomStage::after_prepass`]; from then
    /// on the v2 tables of the encoder stages (`after-prepass`, `post-hdr`, `post`) bind it as
    /// `gx_motion` and [`PassFrame::prepass_motion`] hands it out. In-world stages keep the neutral
    /// zero (the world pass draws while the frame's motion is read only later).
    fn prepass_motion(&mut self, _motion: &TextureView) {}
    /// The renderer's environment this frame (after graph node 11 baked it, before the world
    /// pass): v2 passes bind it in their tables (`gx_env_specular`, `gx_env_sh`) and as
    /// [`PassFrame::environment`] from now on.
    fn environment(&mut self, _environment: &EnvironmentViews) {}
    /// Graph node 15a, ahead of the reactive coverage: draw the in-world passes' motion draws
    /// ([`PassFrame::motion_draws`]) into the frame's `motion` target against the prepass `depth`
    /// (both at render size, single-sampled), on `encoder`. False when nothing was drawn.
    fn temporal_motion(&self, _encoder: &mut CommandEncoder, _motion: &TextureView, _depth: &TextureView) -> bool {
        false
    }
    /// Run the `post-hdr` stage over the scene colour (the world target on the legacy LDR scene),
    /// ahead of the 2D primitives, post passes and `post` stage.
    fn post_hdr(&mut self, _scene: &Texture, _view: &TextureView) {}
    /// Whether a pass runs at `stage` this frame (a caller submits the frame so far before an
    /// encoder stage only when one does).
    fn runs(&self, _stage: PassStage) -> bool {
        false
    }
    /// What this frame's passes ask of the depth/normal prepass (plan principle 3, inputs drive
    /// producers): the inputs running v2 passes declare and whether one runs at `after-prepass`.
    /// A frame renderer adds what its Level-2 v2 sources bind and hands the sum to the renderer
    /// before the frame's targets are chosen. Nothing by default.
    fn prepass_demand(&self) -> crate::prepass::ExtensionDemand {
        crate::prepass::ExtensionDemand::default()
    }
    /// Run the post stage over the resolved world target.
    fn after_world(&mut self, _world: &Texture, _view: &TextureView) {}
    /// Logical draws the stage adds under [`CUSTOM_TAG`].
    fn custom_draws(&self) -> u32 {
        0
    }
}

/// A frame with no custom passes.
pub struct NoCustom;

impl WorldStage for NoCustom {}

impl CustomStage for NoCustom {}

/// One frame's run of the registered passes ([`CustomPasses::frame`]).
pub struct PassRun<'a, 'p> {
    registry: &'a mut CustomPasses,
    passes: &'a mut [&'p mut dyn CustomPass],
    tick: u64,
    history: History,
    /// The look's EV compensation v2 sources read (0 unless a frame renderer says).
    ev_compensation: f32,
    /// Whether this frame's v1 frame uniforms were refreshed into the compat buffer.
    compat_refreshed: bool,
    device: Device,
    queue: Queue,
    tables: Option<BindGroup>,
    /// The v2 tables with neutral depth and normals (`before-cull` and the in-world stages).
    tables_v2: Option<BindGroup>,
    /// The renderer's instance and material tables and the sun's shadow cascades (the depth array
    /// and its comparison sampler) the v2 tables bind, once the frame named them.
    rows: Option<FrameRows>,
    /// The prepass's targets, once its node handed them over this frame.
    prepass: Option<PrepassViews>,
    /// The prepass's motion target, once its node handed it over this frame (RQ5).
    motion: Option<TextureView>,
    /// The v2 tables binding [`PassRun::prepass`] as `gx_depth` and `gx_normals` and
    /// [`PassRun::motion`] as `gx_motion` (the encoder stages from `after-prepass` on).
    tables_v2_prepass: Option<BindGroup>,
    /// This frame's environment group (v2 passes), once a pass asked for it.
    environment_group: Option<BindGroup>,
    draws: Vec<(PassStage, WorldDraws)>,
    /// The in-world passes' motion and reactive draws, for graph node 15a.
    temporal: Vec<(WorldDraws, WorldDraws)>,
    /// Whether this frame's draws were built for the world pass's scene (the facts handed over
    /// match it); the temporal draws replay only then, as the world draws do.
    built_for_scene: bool,
    budget: UploadBudget,
}

impl PassRun<'_, '_> {
    /// Refresh the compat buffer from this frame's frame uniforms, once, ahead of every pass that
    /// reads it: in `encoder` (the frame's, submitted with the world pass) when no before-cull pass
    /// runs, else in a submission of its own ahead of theirs.
    fn refresh_compat(&mut self, encoder: &mut CommandEncoder, world: &WorldPass<'_>) {
        if self.compat_refreshed {
            return;
        }
        self.compat_refreshed = true;
        if self.at(PassStage::BeforeCull).is_empty() {
            self.refresh_frames(encoder, world);
            return;
        }
        let mut own = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("gx frame v1") });
        self.refresh_frames(&mut own, world);
        self.queue.submit([own.finish()]);
    }

    /// The v1 compat bytes, and the v2 frame when a v2 pass runs (its CPU facts written for the
    /// frame's history first), refreshed into `encoder`.
    fn refresh_frames(&mut self, encoder: &mut CommandEncoder, world: &WorldPass<'_>) {
        self.registry.compat.refresh(&self.device, encoder, world.frame_uniforms);
        if !self.runs_api(ABI_V2) {
            return;
        }
        // The v2 tables bind the sun's shadow array (`gx_shadow_map`), so the frame says whether
        // the sun casts this frame.
        let facts = FrameFacts { ev_compensation: self.ev_compensation, sun_shadows: true, ..self.registry.frame_facts(self.history) };
        let seconds = self.tick as f32 * facts.delta_seconds;
        if let Some(v2) = self.registry.v2.as_mut() {
            v2.frame.write(&self.queue, &facts, seconds);
            v2.frame.refresh(&self.device, encoder, world.frame_uniforms);
        }
    }

    /// Whether a running pass is written against `api`.
    fn runs_api(&self, api: u32) -> bool {
        self.registry.entries.iter().any(|entry| entry.enabled && entry.api == api)
    }

    /// The v2 tables of this frame: the v2 frame, the renderer's rows and neutral inputs.
    fn tables_v2_for(&mut self, world: &WorldPass<'_>) -> Option<BindGroup> {
        if let Some(tables) = &self.tables_v2 {
            return Some(tables.clone());
        }
        self.rows = Some(FrameRows {
            instances: world.instances.clone(),
            materials: world.materials.clone(),
            shadow_map: world.shadow_map.clone(),
            shadow_sampler: world.shadow_sampler.clone(),
        });
        let tables = self.build_tables_v2(None, None)?;
        self.tables_v2 = Some(tables.clone());
        Some(tables)
    }

    /// The v2 tables over the frame's rows, with `prepass`'s targets as `gx_depth` and
    /// `gx_normals` and `motion` as `gx_motion` (neutral resources without them).
    fn build_tables_v2(&self, prepass: Option<&PrepassViews>, motion: Option<&TextureView>) -> Option<BindGroup> {
        let v2 = self.registry.v2.as_ref()?;
        let rows = self.rows.as_ref()?;
        let depth_reversed = self.registry.facts.depth_reversed;
        let entries: Vec<wgpu::BindGroupEntry<'_>> = TABLES_V2_BINDINGS
            .iter()
            .map(|row| {
                let resource = match (row.name, prepass, motion) {
                    ("gx_frame", _, _) => {
                        wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: v2.frame.buffer(), offset: 0, size: wgpu::BufferSize::new(GX_FRAME_V2_BYTES) })
                    }
                    ("gx_instances", _, _) => rows.instances.as_entire_binding(),
                    ("gx_materials", _, _) => rows.materials.as_entire_binding(),
                    ("gx_shadow_map", _, _) => wgpu::BindingResource::TextureView(&rows.shadow_map),
                    ("gx_shadow_sampler", _, _) => wgpu::BindingResource::Sampler(&rows.shadow_sampler),
                    ("gx_depth", Some(prepass), _) => wgpu::BindingResource::TextureView(&prepass.depth),
                    ("gx_normals", Some(prepass), _) => wgpu::BindingResource::TextureView(&prepass.normals),
                    ("gx_motion", _, Some(motion)) => wgpu::BindingResource::TextureView(motion),
                    _ => match self.registry.environment.as_ref().and_then(|environment| environment.resource(row.name)) {
                        Some(resource) => resource,
                        None => v2.neutral.resource(row, depth_reversed),
                    },
                };
                wgpu::BindGroupEntry { binding: row.binding, resource }
            })
            .collect();
        let label = if prepass.is_some() || motion.is_some() { "custom pass tables v2 (prepass)" } else { "custom pass tables v2" };
        Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout: &v2.layout, entries: &entries }))
    }

    /// The v2 tables binding this frame's prepass targets (depth and normals, motion), once the
    /// prepass handed any over and the frame named its rows.
    fn prepass_tables(&mut self) -> Option<BindGroup> {
        if let Some(tables) = &self.tables_v2_prepass {
            return Some(tables.clone());
        }
        if self.prepass.is_none() && self.motion.is_none() {
            return None;
        }
        let tables = self.build_tables_v2(self.prepass.as_ref(), self.motion.as_ref())?;
        self.tables_v2_prepass = Some(tables.clone());
        Some(tables)
    }

    /// The tables a pass at `index` binds at `stage` (its api's, with the prepass's targets from
    /// `after-prepass` on once the prepass ran), once the frame built them.
    fn tables_of(&mut self, index: usize, stage: PassStage) -> Option<BindGroup> {
        match self.registry.entries.get(index).map(|entry| entry.api) {
            Some(ABI_V2) if stage.reads_prepass() => self.prepass_tables().or_else(|| self.tables_v2.clone()),
            Some(ABI_V2) => self.tables_v2.clone(),
            _ => self.tables.clone(),
        }
    }

    /// The environment group a pass at `index` binds ([`PassFrame::environment`]): this frame's,
    /// made on first use from the renderer's environment (neutral without one); None for API v1.
    fn environment_of(&mut self, index: usize) -> Option<BindGroup> {
        if self.registry.entries.get(index).map(|entry| entry.api) != Some(ABI_V2) {
            return None;
        }
        if let Some(group) = &self.environment_group {
            return Some(group.clone());
        }
        let v2 = self.registry.v2.as_ref()?;
        let environment = self.registry.environment.as_ref();
        let entries: Vec<wgpu::BindGroupEntry<'_>> = ENVIRONMENT_BINDINGS
            .iter()
            .map(|row| {
                let resource = environment.and_then(|environment| environment.resource(row.name)).unwrap_or_else(|| v2.neutral.resource(row, false));
                wgpu::BindGroupEntry { binding: row.binding, resource }
            })
            .collect();
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("custom pass environment"), layout: &v2.environment_layout, entries: &entries });
        self.environment_group = Some(group.clone());
        Some(group)
    }

    fn tables_for(&mut self, world: &WorldPass<'_>) -> BindGroup {
        if let Some(tables) = &self.tables {
            return tables.clone();
        }
        let frame = wgpu::BufferBinding { buffer: self.registry.compat.buffer(), offset: 0, size: wgpu::BufferSize::new(GX_FRAME_V1_BYTES) };
        let tables = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("custom pass tables"),
            layout: &self.registry.tables_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(frame) },
                wgpu::BindGroupEntry { binding: 1, resource: world.instances.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: world.materials.as_entire_binding() },
            ],
        });
        self.tables = Some(tables.clone());
        tables
    }

    /// The running passes at `stage`: their indices and names.
    fn at(&self, stage: PassStage) -> Vec<(usize, String)> {
        let entries = self.registry.entries.iter().enumerate();
        entries.filter(|(_, entry)| entry.enabled && entry.stage == stage).map(|(index, entry)| (index, entry.name.clone())).collect()
    }

    fn refuse(&mut self, index: usize, error: RenderError) {
        self.registry.refuse(index, error);
    }

    /// Run the passes at an encoder stage, each on its own encoder inside error scopes. A pass whose
    /// frame scope is not answered yet is submitted (its submission scoped too) and judged later.
    fn run_encoders(&mut self, stage: PassStage, world: Option<(&Texture, &TextureView)>) {
        let prepass = self.prepass.clone().filter(|_| stage.reads_prepass());
        let motion = self.motion.clone().filter(|_| stage.reads_prepass());
        for (index, name) in self.at(stage) {
            let Some(tables) = self.tables_of(index, stage) else { continue };
            let tables = &tables;
            let environment = self.environment_of(index);
            let device = self.device.clone();
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(&name) });
            let (_, encoded) = scoped(&device, || {
                let mut frame = PassFrame {
                    name: &name,
                    stage,
                    depth_reversed: self.registry.facts.depth_reversed,
                    tick: self.tick,
                    world_size: self.registry.world_size,
                    render_size: self.registry.render_size,
                    history: self.history,
                    quality: &self.registry.quality,
                    device: &device,
                    queue: &self.queue,
                    tables,
                    environment: environment.as_ref(),
                    budget: &mut self.budget,
                    encoder: Some(&mut encoder),
                    draws: None,
                    temporal: None,
                    world,
                    prepass: prepass.as_ref(),
                    motion: motion.as_ref(),
                };
                self.passes[index].encode(&mut frame);
            });
            let (commands, finished) = scoped(&device, || encoder.finish());
            match judge(self.registry.mode, either(encoded, finished)) {
                Verdict::Failed(error) => {
                    self.refuse(index, invalid(&name, format!("wgpu refused its {}: {error}", ScopeKind::Frame.what())));
                    continue;
                }
                Verdict::Pending(scope) => self.registry.park(index, ScopeKind::Frame, scope),
                Verdict::Clean => {}
            }
            let (_, submitted) = scoped(&device, || self.queue.submit([commands]));
            match judge(self.registry.mode, submitted) {
                Verdict::Failed(error) => {
                    self.refuse(index, invalid(&name, format!("wgpu refused its {}: {error}", ScopeKind::Submission.what())));
                }
                Verdict::Pending(scope) => self.registry.park(index, ScopeKind::Submission, scope),
                Verdict::Clean => {}
            }
        }
    }

    /// Record the in-world passes and keep the draws that validate, for the world pass to replay
    /// (and their motion and reactive draws, for graph node 15a, on frames writing motion).
    fn record_draws(&mut self, samples: u32) {
        for stage in [PassStage::AfterOpaque, PassStage::AfterTransparent] {
            for (index, name) in self.at(stage) {
                self.record_pass(index, &name, stage, samples);
            }
        }
    }

    /// Record the in-world pass at `index`, prove what it drew and keep it (see the module docs).
    fn record_pass(&mut self, index: usize, name: &str, stage: PassStage, samples: u32) {
        let Some(tables) = self.tables_of(index, stage) else { return };
        let environment = self.environment_of(index);
        let device = self.device.clone();
        let mut recorded = Recorded::new(&tables);
        let temporal = self.motion.is_some();
        let (_, encoded) = scoped(&device, || {
            let mut frame = PassFrame {
                name,
                stage,
                depth_reversed: self.registry.facts.depth_reversed,
                tick: self.tick,
                world_size: self.registry.world_size,
                render_size: self.registry.render_size,
                history: self.history,
                quality: &self.registry.quality,
                device: &device,
                queue: &self.queue,
                tables: &tables,
                environment: environment.as_ref(),
                budget: &mut self.budget,
                encoder: None,
                draws: Some(&mut recorded.world),
                temporal: temporal.then_some(TemporalDraws { motion: &mut recorded.motion, reactive: &mut recorded.reactive }),
                world: None,
                prepass: None,
                motion: None,
            };
            self.passes[index].encode(&mut frame);
        });
        if let Some(fault) = recorded.fault() {
            self.refuse(index, invalid(name, fault));
            return;
        }
        let proving = self.proving(samples);
        let temporal_proving = (!recorded.temporal_is_empty()).then(|| self.temporal_proving());
        let (_, proved) = scoped(&device, || {
            prove(&device, name, &recorded.world, &proving, true);
            if let Some((motion, reactive, depth)) = &temporal_proving {
                prove(&device, name, &recorded.motion, &(motion.clone(), depth.clone()), true);
                prove(&device, name, &recorded.reactive, &(reactive.clone(), depth.clone()), false);
            }
        });
        let facts = recorded.facts();
        match judge(self.registry.mode, either(encoded, proved)) {
            Verdict::Failed(error) => {
                self.refuse(index, invalid(name, format!("wgpu refused its {}: {error}", ScopeKind::Draws.what())));
            }
            Verdict::Clean => {
                let entry = &mut self.registry.entries[index];
                entry.proven = true;
                remember(&mut entry.proven_draws, facts.unwrap_or_default());
                self.keep_draws(stage, recorded);
            }
            Verdict::Pending(scope) => {
                let entry = &self.registry.entries[index];
                // On probation until one proof resolves clean, and afterwards held out of the
                // world pass while it draws beyond what its clean proofs showed fits (RC-11: on
                // the web an invalid command there loses the whole frame). Its motion and reactive
                // draws are proven with it, their facts after the world draws'.
                let replays = entry.proven && facts.as_deref().is_some_and(|facts| covered(facts, &entry.proven_draws));
                self.registry.park_proving(index, ScopeKind::Draws, scope, facts.unwrap_or_default());
                if replays {
                    self.keep_draws(stage, recorded);
                }
            }
        }
    }

    fn keep_draws(&mut self, stage: PassStage, recorded: Recorded) {
        let Recorded { world, motion, reactive } = recorded;
        if !world.is_empty() {
            self.draws.push((stage, world));
        }
        if !motion.is_empty() || !reactive.is_empty() {
            self.temporal.push((motion, reactive));
        }
    }

    /// The throwaway single-sampled attachments motion and reactive draws are proven on: the
    /// motion target's format, the reactive mask's and the depth, made once per device.
    fn temporal_proving(&mut self) -> (TextureView, TextureView, TextureView) {
        if let Some(views) = &self.registry.temporal_proving {
            return views.clone();
        }
        let views = (
            proving_attachment(&self.device, "custom pass proving motion", crate::motion::MOTION_FORMAT, 1),
            proving_attachment(&self.device, "custom pass proving reactive", crate::post::taa::REACTIVE_FORMAT, 1),
            proving_attachment(&self.device, "custom pass proving temporal depth", DEPTH_FORMAT, 1),
        );
        self.registry.temporal_proving = Some(views.clone());
        views
    }

    /// The throwaway attachments for `samples`, made once per device.
    fn proving(&mut self, samples: u32) -> (TextureView, TextureView) {
        if let Some(views) = &self.registry.proving {
            return views.clone();
        }
        let scene_format = self.registry.facts.scene_format;
        let views = (
            proving_attachment(&self.device, "custom pass proving colour", scene_format, samples),
            proving_attachment(&self.device, "custom pass proving depth", DEPTH_FORMAT, samples),
        );
        self.registry.proving = Some(views.clone());
        views
    }

    fn replay(&self, stage: PassStage, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        // Draws built for another scene (facts not handed over for this frame) would poison the
        // world pass: they wait for the presenter's next `set_pipeline_facts`.
        let facts = &self.registry.facts;
        if (facts.scene_format, facts.depth_reversed) != (world.scene_format, world.depth_reversed) {
            return;
        }
        let mut replayed = false;
        for (_, draws) in self.draws.iter().filter(|(at, _)| *at == stage) {
            draws.replay(pass);
            replayed = true;
        }
        if replayed {
            // The world pass's later draws set their own pipeline, bindings and vertex buffers but
            // expect the library's index buffer, which a pass may have replaced.
            pass.set_index_buffer(world.indices.slice(..), wgpu::IndexFormat::Uint32);
        }
    }
}

/// Replay `draws` into a pass on the throwaway attachments `proving` (the world pass's formats and
/// samples) and finish it, never submitted: wgpu reports any invalid command here, not in the
/// world pass.
/// A throwaway 1x1 attachment of `format` and `samples` that draws are proven on.
fn proving_attachment(device: &Device, label: &str, format: TextureFormat, samples: u32) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// What one in-world pass recorded in a frame: its world draws, and its motion and reactive draws
/// for graph node 15a ([`PassFrame::motion_draws`], [`PassFrame::reactive_draws`]).
struct Recorded {
    world: WorldDraws,
    motion: WorldDraws,
    reactive: WorldDraws,
}

impl Recorded {
    fn new(tables: &BindGroup) -> Recorded {
        Recorded { world: WorldDraws::new(tables.clone()), motion: WorldDraws::new(tables.clone()), reactive: WorldDraws::new(tables.clone()) }
    }

    /// The first fault of any of the three, the world draws' first.
    fn fault(&mut self) -> Option<String> {
        self.world.fault.take().or_else(|| self.motion.fault.take()).or_else(|| self.reactive.fault.take())
    }

    fn temporal_is_empty(&self) -> bool {
        self.motion.is_empty() && self.reactive.is_empty()
    }

    /// Every draw recorded, world draws first, as a proof shows it fits; None when one had no
    /// pipeline of the pass's own.
    fn facts(&mut self) -> Option<Vec<DrawFact>> {
        let mut facts = self.world.facts.take()?;
        facts.extend(self.motion.facts.take()?);
        facts.extend(self.reactive.facts.take()?);
        Some(facts)
    }
}

/// Replay `draws` into a pass on the throwaway attachments `proving` (the formats and samples of
/// the pass they are replayed into; the depth written when `depth_writes`, else read-only, as
/// node 15a's coverage pass binds it) and finish it, never submitted: wgpu reports any invalid
/// command here, not in the frame.
fn prove(device: &Device, name: &str, draws: &WorldDraws, proving: &(TextureView, TextureView), depth_writes: bool) {
    let (color, depth) = proving;
    let depth_ops = depth_writes.then_some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(name) });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(name),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: color,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Discard },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops, stencil_ops: None }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        draws.replay(&mut pass);
    }
    drop(encoder.finish());
}

impl WorldStage for PassRun<'_, '_> {
    fn before_cull(&mut self, encoder: &mut CommandEncoder, world: &WorldPass<'_>) {
        self.refresh_compat(encoder, world);
        self.tables_for(world);
        self.tables_v2_for(world);
        self.run_encoders(PassStage::BeforeCull, None);
    }

    fn before_world(&mut self, encoder: &mut CommandEncoder, world: &WorldPass<'_>) {
        self.refresh_compat(encoder, world);
        self.tables_for(world);
        self.tables_v2_for(world);
        let facts = &self.registry.facts;
        self.built_for_scene = (facts.scene_format, facts.depth_reversed) == (world.scene_format, world.depth_reversed);
        self.record_draws(world.samples);
    }

    fn opaque(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.replay(PassStage::AfterOpaque, pass, world);
    }

    fn blended(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.replay(PassStage::AfterTransparent, pass, world);
    }

    fn ldr_reason(&self) -> Option<LdrReason> {
        self.registry.ldr_reason()
    }

    fn reactive_draws(&self) -> bool {
        self.built_for_scene && self.temporal.iter().any(|(_, reactive)| !reactive.is_empty())
    }

    fn reactive(&self, pass: &mut wgpu::RenderPass<'_>, _node: &crate::post::taa::ReactiveNode) {
        if !self.built_for_scene {
            return;
        }
        for (_, reactive) in &self.temporal {
            reactive.replay(pass);
        }
    }
}

impl CustomStage for PassRun<'_, '_> {
    fn environment(&mut self, environment: &EnvironmentViews) {
        if self.registry.environment.as_ref() == Some(environment) {
            return;
        }
        self.registry.environment = Some(environment.clone());
        // Tables already built this frame (a before-cull pass ran) rebind the new environment.
        self.environment_group = None;
        self.tables_v2_prepass = None;
        if self.tables_v2.is_some() {
            self.tables_v2 = self.build_tables_v2(None, None);
        }
    }

    fn begin_frame(&mut self, frame: &StageFrame) {
        let settle = frame.history.settle.map(|settle| (settle.index, settle.count));
        // A frame drawn on its history after another shows `ticks` more ticks than that one (none
        // in a capture, which re-renders one tick).
        let continued = !frame.history.history_reset() && settle.is_none();
        let ticks_back = if continued { u64::from(frame.history.ticks) } else { 0 };
        self.history = History { frame_index: frame.history.frame_index, settle, ticks_back };
        self.ev_compensation = frame.ev_compensation;
        self.registry.camera = Some(frame.camera);
    }

    fn prepass_motion(&mut self, motion: &TextureView) {
        self.motion = Some(motion.clone());
        self.tables_v2_prepass = None;
    }

    fn temporal_motion(&self, encoder: &mut CommandEncoder, motion: &TextureView, depth: &TextureView) -> bool {
        let mut draws = self.temporal.iter().map(|(motion, _)| motion).filter(|draws| !draws.is_empty()).peekable();
        if !self.built_for_scene || draws.peek().is_none() {
            return false;
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("level-3 motion"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: motion,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        for draws in draws {
            draws.replay(&mut pass);
        }
        true
    }

    fn after_prepass(&mut self, prepass: &PrepassViews) {
        self.prepass = Some(prepass.clone());
        self.tables_v2_prepass = None;
        // A frame whose tables were never built (no before-cull node) runs its passes next frame.
        if self.tables.is_none() {
            return;
        }
        self.run_encoders(PassStage::AfterPrepass, None);
    }

    fn post_hdr(&mut self, scene: &Texture, view: &TextureView) {
        // A frame whose world pass never ran has no tables: its passes wait for the next one.
        if self.tables.is_none() {
            return;
        }
        self.run_encoders(PassStage::PostHdr, Some((scene, view)));
    }

    fn runs(&self, stage: PassStage) -> bool {
        !self.at(stage).is_empty()
    }

    fn prepass_demand(&self) -> crate::prepass::ExtensionDemand {
        self.registry.prepass_demand(RenderInputs::NONE)
    }

    fn after_world(&mut self, world: &Texture, view: &TextureView) {
        // A frame whose world pass never ran has no tables: its post passes wait for the next one.
        if self.tables.is_none() {
            return;
        }
        self.run_encoders(PassStage::Post, Some((world, view)));
    }

    fn custom_draws(&self) -> u32 {
        self.registry.entries.len() as u32
    }
}

/// Draw `scene` through the part-1 `renderer` with `custom`'s passes (the studio's headless
/// path): compute before the cull, draws in the world pass, `post-hdr` work over the HDR scene at
/// graph node 18 before the tonemap (over the world target after the frame on the legacy LDR
/// scene), and `post` work after it.
pub fn render_scene(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene, path: CullPath, custom: &mut dyn CustomStage) -> Result<(), RenderError> {
    renderer.render_custom(gpu, scene, path, custom)?;
    if !renderer.last_scene().is_some_and(|scene| scene.hdr) {
        custom.post_hdr(renderer.world_texture(), renderer.world_view());
    }
    custom.after_world(renderer.world_texture(), renderer.world_view());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_starts_from_an_empty_history_whatever_live_drew_and_live_resumes_after_it() {
        let capture_after = |live_frames: u64| {
            let mut clock = HistoryClock::default();
            for tick in 10..10 + live_frames {
                clock.at(tick);
            }
            clock.capture = Some((0, 1));
            let captured = clock.at(10 + live_frames);
            clock.capture = None;
            (captured, clock.at(10 + live_frames + 1))
        };
        let (fresh, _) = capture_after(0);
        let (long, resumed) = capture_after(240);
        assert_eq!(fresh, History { frame_index: 0, settle: Some((0, 1)), ticks_back: 0 });
        assert_eq!(long, fresh, "a capture after 240 Live frames sees the same empty history");
        // Live last showed tick 249; the capture drew 250 on its own history.
        assert_eq!(resumed, History { frame_index: 241, settle: None, ticks_back: 2 }, "Live's own history resumes after the capture");
        let mut settling = HistoryClock { origin: Some(3), capture: Some((0, 3)), last: None };
        let indices: Vec<History> = (0..4).map(|_| settling.at(9)).collect();
        assert_eq!(
            indices.iter().map(|history| history.settle).collect::<Vec<_>>(),
            vec![Some((0, 3)), Some((1, 3)), Some((2, 3)), Some((2, 3))],
            "each settle re-render has its index, never past the last"
        );
        assert_eq!(indices[0].frame_index, 0, "history_reset on the first re-render");
    }

    #[test]
    fn a_frame_s_previous_tick_is_the_last_live_frame_s_and_its_own_after_a_reset_or_in_a_capture() {
        let mut clock = HistoryClock::default();
        let ticks_back: Vec<u64> = [10, 11, 13, 13].into_iter().map(|tick| clock.at(tick).ticks_back).collect();
        assert_eq!(ticks_back, vec![0, 1, 2, 0], "a first frame has none; skipped ticks count; a tick shown twice moved nothing");
        clock.capture = Some((0, 2));
        assert_eq!((clock.at(13).ticks_back, clock.at(13).ticks_back), (0, 0), "a capture re-renders one tick");
        clock.capture = None;
        assert_eq!(clock.at(14).ticks_back, 1, "Live resumes from its own last frame after a capture");
        assert_eq!(clock.at(5).ticks_back, 0, "a tick going back starts the history over");
    }
}
