//! The V1 renderer: a `Bgra8Unorm` world target (4x MSAA where the formats allow it, resolved
//! into it) drawn by forward metallic-roughness shading over storage-buffer tables. A frame runs
//! through the frame graph ([`crate::graph`], plan §2.2), whose nodes this module encodes:
//!
//! 1. `tables`: the frame uniforms, cull views and tables are written to the queue;
//! 2. `before-cull`: a [`WorldStage`]'s compute work (Level-3 `before-cull` passes);
//! 3. `skinning`: compute skinning of every skinned draw into the skinned vertex buffer;
//! 4. `cull`: on the GPU-driven path, one compute cull of every opaque batch against every view
//!    (the camera and each shadow cascade) writing `draw_indexed_indirect` arguments; the CPU path
//!    culls the same tables on the CPU and issues direct draws, as the reference;
//! 5. `shadows`: each shadow cascade, depth only, through its view's arguments;
//! 5a. `prepass` (RQ4.1, only when a consumer asks: [`crate::prepass`]): the opaque batches,
//!    skinned ones included, and a [`WorldStage`]'s custom geometry into the sampleable scene
//!    depth and the octahedral normals at 1x; on immediate-mode GPUs at 1x the world pass then
//!    tests `Equal` against that depth with depth writes off, elsewhere it keeps its own;
//! 5b. `ao` and `contact-shadows` (RQ4.6, `effects`): GTAO with its own history and the sun's
//!    screen-space contact shadows from the prepass's targets, bound in the forward frame group
//!    with the frame's fog row and node 11's aerial-perspective volume; a frame without them binds
//!    neutral texels, so its picture is unchanged;
//! 6. one world pass hosting the in-pass nodes `opaque` (the opaque batches through the camera
//!    view's arguments, one `multi_draw_indexed_indirect` per vertex source, then lines),
//!    `after-opaque`, `transparent` (back to front as direct draws, then the stage's blended work)
//!    and `resolve` (the MSAA colour resolved into the scene colour and discarded);
//! 7. `upscale`: below a render scale of 1 the world pass drew into step-sized targets, and a
//!    bilinear pass stretches the scene over the world target.
//!
//! **Temporal anti-aliasing and FSR1 (RQ5.6).** Where the quality draws TAA on the HDR scene
//! with one sample ([`ScenePath::taa`]; MSAA is off, `landed_samples`), the frame:
//! - jitters every camera depth writer by Halton(2, 3) keyed to the frame index
//!   (`GpuFrame::jitter`, the cull, the shadows and `view_proj` stay unjittered) and samples
//!   material textures with TAA's LOD bias at the frame's scale (`GpuFrame::texture_lod`, a
//!   uniform: a dynamic-resolution step moves it; renderer pass 2, P2-0.8b T-06, which also gives
//!   FSR1's upscaled frames without TAA their `log2(render / display)`);
//! - runs the prepass's motion variant (node 7, [`crate::motion`]: NDC motion and the reactive
//!   no-history flags, rows matched by draw id or mesh ordinal on the frame's history set), the
//!   reactive coverage of the transparent draws (15a) and the resolve (17, [`crate::post::taa`]);
//! - reads the resolve in exposure, bloom and the tonemap; `post-hdr` passes draw over a copy of
//!   it in the 1x scene, never over the history.
//! The history set is Live's or a settled capture's own ([`Renderer::set_history_set`]); index 0
//! starts it over. Where FSR1 runs ([`ScenePath::fsr`]: medium and up below scale 1, ultra's
//! sharpen at scale 1) the tonemap writes the `rgb10a2unorm` intermediate at render size and node
//! 22 runs EASU and RCAS with the final dither into the world target.
//!
//! Targets come from a [`TargetPool`] at the current scale step: the world target at output size,
//! and at render size the scene colour (below scale 1), the multisampled colour and the depth.
//! MSAA colour and depth are transient attachments where the adapter saves memory by it.
//!
//! A [`WorldStage`] (M2.6: custom materials, GPU particles) adds compute work ahead of the world
//! pass and draws inside it, against the world's depth: after the opaque batches and after the
//! transparent draws. The part-2 passes that follow the world pass (2D primitives, post passes,
//! the HUD overlay) draw into [`Renderer::world_view`].
//!
//! Captures read the world target back top-down with no swizzle; `present` letterboxes it into a
//! window target.
//!
//! The settings reach a frame through [`Renderer::set_quality`] and [`Renderer::set_render_scale`]
//! (RQ0.7): a node whose feature switch is off never runs (`graph::quality_allows`), and sun
//! shadows switched off are planned out of the frame, so nothing samples a map that was not drawn.
//! Knobs whose feature lands in a later tier are carried and reported, never drawn. Live frames are
//! timed on the GPU through [`live_timing::FrameTimer`] when the adapter offers timestamps.
//!
//! **The HDR path (RQ1.1).** A frame draws HDR when its quality asks (`Quality::hdr`), the session's
//! scene format is an HDR one ([`Renderer::set_scene_format`]: chosen once per device class, the
//! legacy `Ldr` until set, so a caller whose in-world pipelines target the world format never gets
//! an HDR frame by accident) and nothing degraded it ([`Renderer::set_ldr_reason`],
//! [`WorldStage::ldr_reason`]). It then:
//! - draws the world pass into the scene format (`rgba16float` in core, `rg11b10ufloat` where the
//!   device was opened with its feature; MSAA resolved in HDR) with reverse-Z (`Greater`, depth
//!   cleared to 0; [`CameraDesc::view_proj_reversed`]), the forward output writing linear radiance
//!   times the pre-exposure (`lighting/output.wgsl`); under auto exposure the background is drawn
//!   on the GPU with the same exposure (`shaders/background.wgsl`);
//! - resolves MSAA by device class ([`Renderer::set_device_class`]): the in-pass hardware resolve
//!   on phones and on low or mid desktop tile GPUs, the luminance-weighted resolve on other desktop
//!   GPUs and high or ultra Apple silicon, fused into the tonemap unless something reads the
//!   resolved scene first;
//! - with bloom on, records the threshold-free bloom chain from the scene and composites it in the
//!   tonemap ([`crate::post::bloom`], RQ4.6);
//! - tonemaps with the look's curve into the world target ([`crate::post::tonemap`]), fused with a
//!   luminance-weighted bilinear upscale below scale 1, so the world target, captures, the HUD and
//!   v1 post passes keep their meaning. Every tonemap and resolve pipeline the session can reach is
//!   made on its first HDR frame, so a dynamic-resolution step compiles nothing.
//!
//! The legacy path (`off`, or a degraded frame) is the renderer before the follow-up, standard Z
//! included: its pictures are byte-identical. [`Renderer::last_scene`] says which path a frame took.
//!
//! **The meshlet path (R2.4, [`crate::meshlet_cull`]).** When the quality's `meshlets` switch and
//! the game's [`Meshlets`] setting ([`Renderer::set_meshlets`]) are on, every opaque instance of a
//! mesh the library clustered draws through meshlets on the GPU-driven path; its batch is skipped
//! by the instance path's multi-draws in the views the meshlet path covers (the camera, then the
//! cascades whose compacted index regions fit one storage binding):
//! - graph node 5 culls every candidate of every such view (cull pass 1) after the instance cull;
//! - the shadow cascades draw their meshlets with frustum- and cone-culled casters;
//! - the prepass (node 7) draws pass 1's meshlets; with occlusion (the quality's `occlusion`, which
//!   asks for the prepass) node 8 builds the Hi-Z from that depth, runs cull pass 2 over every
//!   candidate and draws what it found new over the prepass (prepass part 2);
//! - the world pass draws both passes' meshlets with the forward fragment (`Equal` over the prepass
//!   where the world pass reuses its depth).
//!
//! Every meshlet draw is the instance path's twin (vertex pulling computes what the instance
//! vertex shaders compute). With a one-sample world pass the picture is the instance path's to the
//! bit, with and without occlusion (the `occlusion` tests). Under MSAA the meshlets alone may
//! differ from the instance path on a few edge pixels where two draws tie (draw order), and
//! occlusion does not run: its Hi-Z holds the single-sample prepass's depth at pixel centres, so it
//! would cull meshlets seen only through an edge pixel's uncovered samples
//! ([`crate::presets::occlusion_runs_with`]). A settled capture starts from an empty visibility
//! history and never reads, moves or resets Live's.
//!
//! [`CameraDesc::view_proj_reversed`]: crate::scene::CameraDesc::view_proj_reversed

/// Live GPU frame timing: two timestamps around a whole frame (plan §2.6).
pub mod live_timing;
/// The forward pass's RQ4 screen effects: fog row, AO term, contact-shadow mask (RQ4.6).
mod effects;
mod froxel_fog;
/// Graph nodes 17a and 17b: the look's depth of field and motion blur (renderer pass 2 A.9).
mod lens;
mod probe_capture;
mod grass_draw;
mod terrain_draw;
mod variants;

pub use grass_draw::GrassStats;
pub use lens::CaptureLens;
pub use terrain_draw::TerrainStats;

use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, BufferUsages, Device, Queue, RenderPass,
    RenderPipeline, Sampler, ShaderModule, ShaderStages, Texture, TextureFormat, TextureUsages, TextureView,
};

use crate::capture::{Capture, check_capture_size};
use crate::caps::{check_texture, world_size};
use crate::compile::Compiled;
use crate::cull::{CpuCull, CullBuffers, CullPass};
use crate::custom_pass::{CustomStage, PassStage, PrepassViews};
use crate::device_class::{DeviceClass, FormFactor, TargetOs};
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::abi::{MATERIAL_V2_BINDINGS, RenderInputs};
use crate::graph::{EnvironmentFrame, FrameEncoder, FrameNodes, NodeId, PassCounters};
use crate::hdri::{HdriImage, PreparedMap};
use crate::hiz::{HizInput, HizNode};
use crate::ibl::EnvironmentMaps;
use crate::layout::{
    DrawIndexedArgs, FRAME_EFFECT_BOUND, FRAME_ENV_BOUND, FRAME_LIGHT_BINDINGS, FRAME_MATERIAL_CLASS_BINDINGS, GpuCullViews, GpuFrame,
    GpuPassView, MAX_CASCADES, SHADOW_CASCADES,
};
use crate::mesh::{MeshData, Vertex};
use crate::meshlet::MeshletSet;
use crate::meshlet_cull::{
    ArgsSlot, CullExternals, CullPass as MeshletPass, HistoryUse, MeshletBuffers, MeshletCullNode, MeshletDrawLayouts, MeshletFrame, MeshletPipelineSpec, MeshletPipelines,
    MeshletReadback,
};
use crate::motion::{GpuMotionFrame, MotionHistory, MotionNode, MotionStep};
use crate::post::fsr::{FsrNode, FsrPass, FsrPasses};
use crate::post::taa::{GpuReactiveJitter, GpuTaaParams, ReactiveEntry, ReactiveNode, TaaInput};
use crate::post::tonemap::{MsaaResolve, ResolveNode, TonemapNode, TonemapPass, TonemapSource, f16_to_f32};
use crate::prepass::{ExtensionDemand, GpuPrepassDraw, PrepassConsumers, PrepassDraw, PrepassInfo};
use crate::readback::{map_read, map_read_blocking, stage_buffer};
use crate::scene::{FramePlan, LineVertex, MeshId, MeshLibrary, ModelPart, PlanOptions, Scene, SunLight};
use crate::shadow::{CascadeDraws, CascadeHistory, CasterDepth, CasterSpec, ShadowMapDesc, ShadowMaps, caster_pipeline};
use crate::settings::{
    AntiAliasing, Environment, ExposureMode, FrameConfig, LdrReason, Look, Meshlets, Quality, RenderFeature, RenderSettings, SceneFormat, ShadowFilter,
    ShadowFormat, ShadowSettings, TextureClass, Tonemapper, Upscaler,
};
use crate::settle::{HistoryReset, HistorySet, TaaHistories};
use crate::skin::{SkinBuffers, SkinId, SkinPass, SkinnedMeshData};
use crate::sky::SkyState;
use crate::tables::{ARGS_STRIDE, PASS_VIEW_STRIDE, Tables, Uploads, VERTEX_STRIDE, aligned, buffer, entry, pipeline_layout, storage, uniform};
use crate::target_pool::{TargetDesc, TargetPolicy, TargetPool};
use crate::texture::{ClassArrays, TextureData, TextureId, TextureKind};

pub use crate::shaders::module as shader;
pub use crate::tables::CullPath;

/// The world target's format on every backend: captures need no CPU swizzle.
pub const WORLD_FORMAT: TextureFormat = TextureFormat::Bgra8Unorm;
/// The world pass's depth format (a [`WorldStage`]'s pipelines test against it).
pub const DEPTH_FORMAT: TextureFormat = TextureFormat::Depth32Float;
/// Samples per pixel with MSAA on.
pub const MSAA_SAMPLES: u32 = 4;
/// Pool labels of the targets the world pass and the nodes after it draw into.
const WORLD_TARGET: &str = "world";
const SCENE_TARGET: &str = "scene";
const MSAA_TARGET: &str = "world msaa";
const DEPTH_TARGET: &str = "depth";
/// Frame groups made mid-frame kept for reuse: AO's two alternating history terms, each with and
/// without a fresh environment bake.
const REFRESHED_GROUPS_KEPT: usize = 4;
/// The device class texture arrays are sized for before the presenter names one (texture
/// quality is off until a quality asks, so it sizes nothing then).
const TEXTURE_DEFAULT_CLASS: DeviceClass = DeviceClass::new(FormFactor::Desktop, crate::device_class::PerformanceTier::High);
/// The larger size classes' arrays in [`FRAME_MATERIAL_CLASS_BINDINGS`] order: colour then data
/// per class past class 0.
const MATERIAL_CLASS_ARRAYS: [(TextureClass, TextureKind); 6] = [
    (TextureClass::S512, TextureKind::Color),
    (TextureClass::S512, TextureKind::Data),
    (TextureClass::S1024, TextureKind::Color),
    (TextureClass::S1024, TextureKind::Data),
    (TextureClass::S2048, TextureKind::Color),
    (TextureClass::S2048, TextureKind::Data),
];
/// Where the frame's pre-exposure sits in the frame uniforms: `GpuFrame::cascade_splits[2]`, the
/// legacy frame's unused lane (`lighting/output.wgsl` reads it; 0 on the legacy path). Auto
/// exposure copies the GPU's exposure here, as it does into `GxFrameV2::pre_exposure`.
pub const FRAME_PRE_EXPOSURE_OFFSET: u64 = (std::mem::offset_of!(GpuFrame, cascade_splits) + 2 * size_of::<f32>()) as u64;
const _: () = assert!(FRAME_PRE_EXPOSURE_OFFSET.is_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT));

/// How a frame drew its scene colour (RQ1.1, [`Renderer::last_scene`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScenePath {
    /// Whether the scene was HDR (linear, pre-exposed, tonemapped into the world target).
    pub hdr: bool,
    /// The scene colour's format (the world format on the legacy path).
    pub format: TextureFormat,
    /// Whether camera views drew reverse-Z.
    pub depth_reversed: bool,
    /// Why a frame that asked for HDR was drawn on the legacy path instead.
    pub ldr_reason: Option<LdrReason>,
    /// The curve the tonemap applied (the look's, or `None` with the tonemap switched off).
    pub tonemapper: Tonemapper,
    /// How MSAA samples were resolved (None without MSAA).
    pub resolve: Option<MsaaResolve>,
    /// Whether the weighted resolve ran as its own pass (something read the resolved scene).
    pub resolve_pass: bool,
    /// How the tonemap read the scene (None on the legacy path).
    pub tonemap: Option<TonemapSource>,
    /// The exposure the scene was written with (1 on the legacy path).
    pub pre_exposure: f32,
    /// Whether TAA resolves the scene (RQ5.6: graph nodes 15a and 17; the HDR scene with one
    /// sample, the prepass writing motion, the camera's projection jittered).
    pub taa: bool,
    /// Which FSR1 passes upscale and sharpen the tonemapped scene (node 22; none: the tonemap
    /// writes the world target itself, bilinear-fused below scale 1 on `low`).
    pub fsr: FsrPasses,
}

impl ScenePath {
    /// The legacy path.
    const LEGACY: ScenePath = ScenePath {
        hdr: false,
        format: WORLD_FORMAT,
        depth_reversed: false,
        ldr_reason: None,
        tonemapper: Tonemapper::None,
        resolve: None,
        resolve_pass: false,
        tonemap: None,
        pre_exposure: 1.0,
        taa: false,
        fsr: FsrPasses { easu: false, rcas: false },
    };

    /// Whether FSR1 runs after the tonemap (into the world target from its intermediate).
    pub const fn fsr_runs(&self) -> bool {
        self.fsr.easu || self.fsr.rcas
    }
}

/// How a renderer is built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderOptions {
    /// 4x MSAA where the world and depth formats take it (WebGPU core guarantees both).
    pub msaa: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions { msaa: true }
    }
}

/// What the last frame drew.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameStats {
    /// Logical draws (the tagged draw count), before any culling.
    pub logical_draws: u32,
    /// Instance-table rows (opaque and transparent), before culling.
    pub instances: u32,
    /// Opaque batches.
    pub batches: u32,
    /// Cull views (the camera, plus the shadow cascades when the sun casts shadows).
    pub views: u32,
    /// Batches drawn from indirect arguments, over every view.
    pub indirect_draws: u32,
    /// `multi_draw_indexed_indirect` calls.
    pub multi_draws: u32,
    /// Opaque batches drawn directly (the CPU-culled reference path only).
    pub direct_opaque_draws: u32,
    /// Transparent direct draws.
    pub transparent_draws: u32,
    /// Compute-skinning jobs.
    pub skin_jobs: u32,
    /// Render passes the renderer's nodes opened (shadow cascades, the world pass, the upscale).
    pub render_passes: u32,
    /// Compute passes the renderer's nodes opened (skinning, the cull).
    pub compute_passes: u32,
    /// Meshlet candidates (instance × meshlet pairs) the frame culled (R2; 0 off the meshlet path).
    pub meshlet_candidates: u32,
    /// Cull views drawn through meshlets (the camera, then the cascades that fit).
    pub meshlet_views: u32,
    /// Meshlet `draw_indexed_indirect` calls, over every pass.
    pub meshlet_draws: u32,
    /// Whether two-pass Hi-Z occlusion ran.
    pub occlusion: bool,
}

/// How the last frame's world pass was set up (graph nodes 12-16).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorldPassInfo {
    /// World passes the frame opened (1: every in-pass node shares it).
    pub passes: u32,
    /// Samples per pixel.
    pub samples: u32,
    /// Whether the MSAA colour was resolved into the scene colour inside the pass.
    pub resolved: bool,
    /// What happened to the colour attachment at the end of the pass.
    pub color_store: wgpu::StoreOp,
    /// What happened to the depth at the end of the pass.
    pub depth_store: wgpu::StoreOp,
    /// Whether the attachments the pass discards are transient (never leave tile memory).
    pub transient: bool,
    /// The render size it drew at.
    pub size: (u32, u32),
}

struct Layouts {
    frame: BindGroupLayout,
    shadow: BindGroupLayout,
    pass: BindGroupLayout,
    lines: BindGroupLayout,
    /// The prepass's custom-geometry row (`prepass_draw`, group 1 binding 1, dynamic offset).
    prepass_draw: BindGroupLayout,
}

/// The pipelines that draw into the scene colour: one set for the legacy world format with standard
/// Z, one for the HDR scene format with reverse-Z (made on the first HDR frame).
#[derive(Clone)]
struct ScenePipelines {
    forward: Compiled<RenderPipeline>,
    blend: Compiled<RenderPipeline>,
    lines: Compiled<RenderPipeline>,
    /// The HDR scene's GPU-exposed background (drawn only under auto exposure).
    background: Compiled<RenderPipeline>,
}

struct Pipelines {
    /// The legacy scene's pipelines, made on the first frame drawn on it (pass-1 gate: a session
    /// that only ever draws the HDR scene compiles none of them).
    scene: Option<ScenePipelines>,
    /// What the legacy scene pipelines were made for (the shadow filter the person picked).
    scene_surface: SurfaceKey,
    /// The casters into `depth32float` maps.
    shadow: Compiled<RenderPipeline>,
    /// The casters into `depth16unorm` maps (low and mobile classes).
    shadow16: Compiled<RenderPipeline>,
}

/// What the forward module's pipeline constants are made for besides the depth convention: the
/// surfaces' specular AA (HDR only) and the sun chunk's shadow filter and temporal tap pattern.
/// A change makes the scene pipelines again (a person's or verb's quality change, never DRS).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SurfaceKey {
    specular_aa: bool,
    shadow_filter: ShadowFilter,
    shadow_temporal: bool,
    /// Which RQ4 screen effects the forward pass reads (each compiled out where off).
    effects: EffectKey,
    /// Whether the texture arrays hold size classes (`GX_TEXTURE_CLASSES`: the surface samples
    /// each texture from its class's arrays; off, it samples class 0 exactly as before RQ6.4).
    texture_classes: bool,
    /// Whether normal-map mips carry Toksvig's length (`GX_TOKSVIG`: the surface folds it into
    /// roughness).
    toksvig: bool,
    /// Whether the frame's local lights may come binned (`GX_BINNED_LIGHTS`: the quality's
    /// clustered switch). Off, the binned path's code is compiled out of the fragment (RX.R1).
    binned_lights: bool,
    /// Whether the quality's cascades blend over a band or fade out at the shadow distance
    /// (`GX_SUN_SOFT_EDGES`). Off, the sun chunk's band and end fade are compiled out (RX.R1).
    sun_soft_edges: bool,
    /// The most cascades the quality draws (`GX_SUN_CASCADES`): the sun chunk's cascade choice
    /// never looks past them (RX.R1).
    sun_cascades: u8,
    /// The least perceptual roughness the surfaces shade with, its bits (`GX_ROUGHNESS_FLOOR`,
    /// renderer pass 2 P2-0.12 LG-04): Filament's 0.045 on the HDR scene of a desktop, its
    /// half-precision 0.089 on a phone's, the legacy 0.04 on the LDR scene.
    roughness_floor: u32,
}

/// The RQ4 screen effects a quality draws, one pipeline constant each (`GX_AO`,
/// `GX_CONTACT_SHADOWS`, `GX_FOG`, `GX_AERIAL`): an effect that is off reads nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EffectKey {
    ao: bool,
    contact_shadows: bool,
    fog: bool,
    aerial: bool,
}

impl EffectKey {
    /// None drawn: the legacy scene's.
    const NONE: EffectKey = EffectKey { ao: false, contact_shadows: false, fog: false, aerial: false };

    /// What `quality` draws: AO, contact shadows and the height fog by their switches, the aerial
    /// perspective where the environment computes the volume (medium and up, whatever the fog
    /// switch says; `fog::aerial_perspective`).
    fn of(quality: &Quality) -> EffectKey {
        let drawn = |feature| crate::graph::feature_drawn(quality, feature);
        EffectKey {
            ao: drawn(RenderFeature::Ao),
            contact_shadows: drawn(RenderFeature::ContactShadows),
            fog: drawn(RenderFeature::Fog),
            aerial: crate::fog::LANDED && quality.environment.aerial_perspective,
        }
    }
}

impl SurfaceKey {
    /// The legacy scene's: no specular AA, today's 3x3 PCF, a static tap pattern.
    const LEGACY: SurfaceKey = SurfaceKey {
        specular_aa: false,
        shadow_filter: ShadowFilter::Pcf3x3,
        shadow_temporal: false,
        effects: EffectKey::NONE,
        texture_classes: false,
        toksvig: false,
        binned_lights: false,
        sun_soft_edges: false,
        sun_cascades: SHADOW_CASCADES as u8,
        roughness_floor: LEGACY_ROUGHNESS_FLOOR.to_bits(),
    };

    /// The key `quality` asks of the HDR scene (`hdr`) or the legacy one, `taa` when TAA resolves
    /// the frame. The soft filters' pattern turns with the frame only when a temporal resolve
    /// follows the HDR scene (a TAA quality on a renderer still drawing MSAA keeps the static
    /// pattern). Textures take their LOD bias from the frame (`GpuFrame::texture_lod`, T-06).
    fn of(quality: &Quality, hdr: bool, taa: bool) -> SurfaceKey {
        let temporal = hdr && taa;
        SurfaceKey {
            specular_aa: hdr && quality.specular_aa,
            shadow_filter: quality.shadows.filter,
            shadow_temporal: temporal,
            effects: EffectKey::of(quality),
            texture_classes: false,
            toksvig: false,
            binned_lights: crate::lights::BINNED_SHADING_LANDED && quality.lights.clustered,
            sun_soft_edges: quality.shadows.blend_percent > 0 || quality.shadows.fade_percent > 0,
            sun_cascades: quality.shadows.cascades.clamp(1, MAX_CASCADES as u8),
            roughness_floor: if hdr { DESKTOP_ROUGHNESS_FLOOR } else { LEGACY_ROUGHNESS_FLOOR }.to_bits(),
        }
    }

    /// This key for a device of `form` (P2-0.12 LG-04): a phone's HDR scene shades with the
    /// coarser floor of half-precision shading; the legacy scene keeps its own.
    const fn for_form(self, form: FormFactor) -> SurfaceKey {
        let hdr_floor = self.roughness_floor == DESKTOP_ROUGHNESS_FLOOR.to_bits();
        if hdr_floor && matches!(form, FormFactor::Mobile) {
            return SurfaceKey { roughness_floor: MOBILE_ROUGHNESS_FLOOR.to_bits(), ..self };
        }
        self
    }

    /// This key as the transparent pipeline compiles it: the soft filters' static tap pattern and
    /// the two-lookup cascade band, never the frame-keyed ones (renderer pass 2, P2-0.2: SH-01,
    /// T-01 step 1). TAA takes a moving transparent's current sample almost whole (its reactive
    /// coverage), so the frame-keyed taps and band dither reached the screen unaveraged: the lake's
    /// shadow edges blinked while the camera moved.
    const fn blended(self) -> SurfaceKey {
        SurfaceKey { shadow_temporal: false, ..self }
    }
}

/// The legacy LDR scene's roughness floor (the surface chunk's default `GX_ROUGHNESS_FLOOR`).
const LEGACY_ROUGHNESS_FLOOR: f32 = 0.04;
/// The HDR scene's roughness floor on a desktop (Filament's fp32 `MIN_PERCEPTUAL_ROUGHNESS`,
/// `surface_material.fs`, Apache-2.0; P2-0.12 LG-04): a polished surface's GGX peak stays within
/// what a pixel and the sun's disc resolve.
const DESKTOP_ROUGHNESS_FLOOR: f32 = 0.045;
/// The HDR scene's roughness floor on a phone (Filament's half-precision floor, Bevy's too).
const MOBILE_ROUGHNESS_FLOOR: f32 = 0.089;

/// The depth/normal prepass's pipelines (graph node 7) and the world pass's `Equal`-depth forward
/// twin, for one scene format and depth convention (made on the first frame that runs the prepass).
struct PrepassPipelines {
    format: TextureFormat,
    reversed: bool,
    /// What its `Equal` forward pipeline's constants were made for (specular AA, shadow filter).
    surface: SurfaceKey,
    /// The opaque batches through the camera view (`vs_prepass`).
    batches: Compiled<RenderPipeline>,
    /// A world stage's custom geometry, one row each (`vs_prepass_draw`).
    draws: Compiled<RenderPipeline>,
    /// The forward pipeline testing `Equal` against the prepass depth, depth writes off (1x).
    forward_equal: Compiled<RenderPipeline>,
    /// The motion variants writing normals, motion and the reactive flags (RQ5.6), made on the
    /// first frame that writes motion.
    motion: Option<MotionPipelines>,
}

/// The prepass's custom-geometry rows ([`GpuPrepassDraw`], [`crate::prepass::DRAW_STRIDE`] apart)
/// and their bind group, grown to the most draws a frame asked for.
struct PrepassRows {
    buffer: Buffer,
    group: BindGroup,
    capacity: usize,
}

/// The prepass's targets of the current scale step (render size, 1x, sampleable).
#[derive(Clone)]
struct PrepassTargets {
    depth_texture: Texture,
    depth_view: TextureView,
    normals_texture: Texture,
    normals_view: TextureView,
    /// The NDC motion (`rg16float`) on frames writing motion (RQ5.6).
    motion: Option<(Texture, TextureView)>,
    /// TAA's reactive mask (`r8unorm`) on frames writing motion: the prepass's no-history flags,
    /// then node 15a's transparent coverage.
    reactive: Option<(Texture, TextureView)>,
}

/// What a frame's stages ask of the depth/normal prepass: the extension ladder's demand (declared
/// inputs, an `after-prepass` pass, Level-2 v2 bindings) and the world stage's custom geometry.
#[derive(Clone, Debug, Default)]
pub(crate) struct StagePrepass {
    /// What the stage's passes and sources ask, beside [`Renderer::set_prepass_demand`]'s.
    pub(crate) demand: ExtensionDemand,
    /// The world stage's custom geometry ([`WorldStage::prepass_draws`]).
    pub(crate) draws: Vec<PrepassDraw>,
}

/// Both demands: every input either declares, and `after-prepass` when either runs a pass there.
fn either_demand(a: ExtensionDemand, b: ExtensionDemand) -> ExtensionDemand {
    ExtensionDemand {
        custom_inputs: a.custom_inputs.union(b.custom_inputs),
        after_prepass: a.after_prepass || b.after_prepass,
        extension_inputs: a.extension_inputs.union(b.extension_inputs),
    }
}

/// What one frame's prepass does, decided before its targets are chosen.
struct FramePrepass {
    consumers: PrepassConsumers,
    /// Whether the world pass tests `Equal` against the prepass depth.
    equal: bool,
    /// The world stage's custom geometry.
    draws: Vec<PrepassDraw>,
}

/// The library on the GPU: vertices (also the skinning source and the meshlet draws' pulled
/// vertices), slots, indices, skin rows and the meshlet buffers (R2).
struct MeshBuffers {
    vertices: Buffer,
    slots: Buffer,
    indices: Buffer,
    skin: Buffer,
    meshlets: MeshletBuffers,
}

/// The pooled targets of the current scale step: the world target (output size), the scene colour
/// below scale 1, the multisampled colour (when MSAA is on) and depth, all at render size.
struct Targets {
    world: Texture,
    world_view: TextureView,
    /// The 1x scene colour: the legacy one below scale 1, or the HDR scene (None: the world target,
    /// or on the desktop HDR path the multisampled colour the tonemap resolves itself).
    scene_texture: Option<Texture>,
    scene_view: Option<TextureView>,
    /// The legacy scaled scene through its sRGB twin: the upscale samples linear light from it.
    scene_linear: Option<TextureView>,
    msaa_view: Option<TextureView>,
    depth_texture: Texture,
    depth_view: TextureView,
    /// Whether the depth attachment is transient.
    transient: bool,
    /// The prepass's depth and normals, on frames that run it (with `spec.equal_depth` the depth
    /// above is the prepass depth).
    prepass: Option<PrepassTargets>,
    /// FSR1's tonemapped intermediate at render size and EASU's output at output size (RQ5.6),
    /// on frames that run it.
    fsr_input: Option<TextureView>,
    fsr_easu: Option<TextureView>,
    samples: u32,
    render_size: (u32, u32),
    /// What they were acquired for.
    spec: TargetSpec,
}

/// The bilinear upscale (graph node 22): made on the first frame below scale 1, its bind group
/// kept for the pool generation it reads.
struct Upscale {
    pipeline: Compiled<RenderPipeline>,
    layout: BindGroupLayout,
    sampler: Sampler,
    group: Option<(u64, BindGroup)>,
}

/// What the frame bind groups bind: they are rebuilt only when one of these is replaced (a table
/// regrown, a texture array grown), not every frame.
#[derive(Clone, PartialEq)]
struct GroupsKey {
    buffers: [Buffer; 9],
    /// The shadow array, then every material texture array ([`Renderer::texture_views`]).
    views: (TextureView, [TextureView; 8]),
    /// The environment maps' generation (the neutral inputs until the bake replaces them).
    environment: u64,
    /// The AO term, the contact-shadow mask and the aerial-perspective volume (the neutral texture
    /// where their nodes do not run).
    effects: [TextureView; 3],
    /// The material sampler's anisotropy (P2-0.12 LG-02: a quality change replaces the sampler).
    anisotropy: u16,
}

impl GroupsKey {
    /// Whether `other` binds the same tables, shadow and material arrays and sampler: it differs
    /// at most in the views a node replaces mid-frame (the effect views, the environment).
    fn same_resources(&self, other: &GroupsKey) -> bool {
        self.buffers == other.buffers && self.views == other.views && self.anisotropy == other.anisotropy
    }
}

/// What the meshlet draw pipelines were made for: the scene's format, depth convention and surface
/// constants, and the world pass's samples.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MeshletPipelineKey {
    format: TextureFormat,
    reversed: bool,
    surface: SurfaceKey,
    samples: u32,
    casters: CasterDepth,
    /// Whether the motion prepass variant is made (a frame writing motion, RQ5.6).
    motion: bool,
}

/// One frame on the meshlet path (R2): its candidates and the visibility history it reads and
/// writes.
pub(crate) struct FrameMeshlets {
    frame: MeshletFrame,
    history: HistoryUse,
}

/// The Hi-Z pyramid of the frame being drawn (graph node 8), pooled under `hi-z`.
#[derive(Clone)]
struct HizPyramid {
    texture: Texture,
    view: TextureView,
}

/// What the temporal nodes do in the frame being drawn (RQ5.6), decided with its scene path before
/// its plan: whether TAA resolves, whether the prepass writes motion, the jitter and the history.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FrameTemporal {
    /// TAA resolves this frame (graph nodes 15a and 17; [`ScenePath::taa`]).
    taa: bool,
    /// The prepass writes motion and the reactive flags (for TAA, or a declared `motion` input).
    motion: bool,
    /// The camera's jitter in render pixels (x right, y down; zero without TAA).
    jitter_px: [f32; 2],
    /// The same jitter in NDC (y up): what `gx_clip_position` adds.
    jitter_ndc: [f32; 2],
    /// The history starts over at this frame (its index is 0).
    reset: bool,
    /// The history set the frame draws on.
    set: HistorySet,
}

impl FrameTemporal {
    /// No temporal work: no TAA, no motion, no jitter.
    const NONE: FrameTemporal = FrameTemporal { taa: false, motion: false, jitter_px: [0.0; 2], jitter_ndc: [0.0; 2], reset: true, set: HistorySet::Live };
}

/// What one history set's last TAA frame was drawn with: the next frame's previous jitter and
/// the exposure its history is rescaled from.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct TemporalLast {
    jitter_px: [f32; 2],
    pre_exposure: f32,
}

/// Last frame's skinned vertices for motion vectors (RQ5.6): copied out of the skinned table
/// before this frame's skinning overwrites it, when the table holds the same history set's last
/// frame (no reset, no regrown table in between).
#[derive(Default)]
struct SkinnedPrevious {
    buffer: Option<Buffer>,
    /// The history set and bytes of the motion frame whose output the skinned table holds.
    written: Option<(HistorySet, u64)>,
    /// Bytes the frame being drawn copies before it skins (0: none; its rows have no previous
    /// skinned vertices).
    copy: u64,
}

/// The reactive coverage (graph node 15a): its node and its mesh pipeline for one depth convention.
struct ReactivePipelines {
    node: ReactiveNode,
    mesh: Compiled<RenderPipeline>,
    reversed: bool,
}

/// The motion prepass's pipelines (made with the prepass's on the first frame writing motion).
struct MotionPipelines {
    batches: Compiled<RenderPipeline>,
    draws: Compiled<RenderPipeline>,
    /// The background's motion after the geometry (renderer pass 2, P2-0.8b T-03).
    background: Compiled<RenderPipeline>,
}

/// The index of `set` in per-set arrays.
const fn set_index(set: HistorySet) -> usize {
    match set {
        HistorySet::Live => 0,
        HistorySet::Capture => 1,
    }
}

/// What a readback needs to know about the last frame.
#[derive(Clone, Copy, Default)]
struct LastFrame {
    batches: u32,
    views: u32,
    skinned_vertices: u32,
    /// Each view's visible-list region: the plan's visible slots (its opaque rows without levels).
    opaque_instances: u32,
}

/// Draws scenes into a world target and reads it back.
pub struct Renderer {
    device: Device,
    width: u32,
    height: u32,
    samples: u32,
    render_scale: f32,
    /// The quality frames draw with (`Quality::off()`, the legacy renderer, until set).
    quality: Quality,
    /// The game's look (tonemapper, exposure) on the HDR path.
    look: Look,
    /// The session's HDR scene format (`Ldr`: frames never draw HDR).
    scene_format: SceneFormat,
    /// Why frames that ask for HDR draw the legacy path (a v1 in-world pass or material).
    ldr_reason: Option<LdrReason>,
    /// The device's form factor: how MSAA resolves on the HDR path.
    form: FormFactor,
    /// The device class, when the presenter says (the resolve reads its tier).
    class: Option<DeviceClass>,
    /// The adapter's `transient_saves_memory` (None on the web): whether attachments live in tile
    /// memory, the form factor deciding where it does not say ([`Renderer::tile_gpu`]).
    tile_memory: Option<bool>,
    /// The MSAA resolve forced on the HDR path (None: by device, [`MsaaResolve::for_device`]).
    resolve_override: Option<MsaaResolve>,
    /// The frame index the dither is keyed to.
    frame_index: u64,
    /// Whether the depth is kept for [`Renderer::read_depth`].
    depth_readback: bool,
    /// Whether something reads the resolved HDR scene before the tonemap (`post-hdr` passes).
    hdr_readers: bool,
    /// The HDR scene pipelines (their format and surface constants), made on the first HDR frame.
    hdr_pipelines: Option<((TextureFormat, SurfaceKey), ScenePipelines)>,
    /// What the extension ladder asks of the prepass ([`Renderer::set_prepass_demand`]).
    prepass_demand: ExtensionDemand,
    /// The world pass's `Equal` reuse forced on or off (None: by device).
    equal_depth_override: Option<bool>,
    /// The prepass's pipelines, made on the first frame that runs it.
    prepass_pipelines: Option<PrepassPipelines>,
    /// The prepass's custom-geometry rows, made on the first frame that draws one.
    prepass_rows: Option<PrepassRows>,
    /// How the last frame's prepass ran (None: it did not).
    last_prepass: Option<PrepassInfo>,
    /// The tonemap and the weighted resolve, made on the first HDR frame (encoding fills their caches).
    post: std::cell::RefCell<Option<(TonemapNode, ResolveNode)>>,
    /// The forward pass's screen effects (AO, contact shadows; graph nodes 10 and 10a).
    effects: std::cell::RefCell<effects::ScreenEffects>,
    /// The frame's fog row (`GxFog` at the forward frame group's `frame_fog`; particles read it too).
    fog_row: Buffer,
    /// What the last planned frame's fog scatters in front of: its environment, or the flat clear
    /// colour (`frame_fog` tints the fog's colour by it).
    fog_backdrop: crate::fog::FogBackdrop,
    /// Frame groups made mid-frame once a node replaced what they bind (AO's alternating history
    /// terms, a new environment bake), the last few kept.
    refreshed_groups: std::cell::RefCell<Vec<(GroupsKey, FrameGroups)>>,
    /// Graph node 1's staging chunks, reused frame after frame (renderer pass 2, RC-08).
    upload_arena: std::cell::RefCell<crate::tables::UploadArena>,
    /// How the frame being drawn (then the last one) draws its scene colour.
    path: ScenePath,
    last_path: Option<ScenePath>,
    /// The live frame timer, armed for one frame at a time (its begin pass is recorded by the
    /// `tables` node, which only sees the renderer shared).
    timer: std::cell::RefCell<Option<live_timing::FrameTimer>>,
    pool: TargetPool,
    targets: Targets,
    groups: Option<(GroupsKey, FrameGroups)>,
    upscale: Option<Upscale>,
    last_world: Option<WorldPassInfo>,
    library: MeshLibrary,
    /// The game's meshlet setting ([`Renderer::set_meshlets`]). The library clusters by it from the
    /// first quality that draws meshlets on ([`Renderer::set_meshlets`]).
    meshlet_game: Meshlets,
    /// Whether the GPU's meshlet tables are not the library's: it re-clustered, or the tables were
    /// dropped while no frame drew meshlets. The next frame that draws meshlets uploads them.
    meshlet_upload_pending: bool,
    /// The queue the next frame uploads re-clustered meshlet buffers on.
    queue: Queue,
    meshes: MeshBuffers,
    /// Times the library was uploaded again (each costs a full copy of every mesh).
    mesh_uploads: u64,
    layouts: Layouts,
    pipelines: Pipelines,
    cull: CullPass,
    skinning: SkinPass,
    /// The present into a window's target ([`Renderer::present`]): the world target filtered by
    /// the ratio, never stretched nearest-texel (renderer pass 2, P2-0.9).
    window_present: crate::letterbox::present::WindowPresent,
    frame_uniforms: Buffer,
    /// The background triangle's three vertices (clip space, the clear colour as linear light).
    background: Buffer,
    cull_views: Buffer,
    tables: Tables,
    /// How the caster pipelines land casters past a cascade's near plane on it.
    casters: CasterDepth,
    shadow_maps: ShadowMaps,
    /// The shape `shadow_maps` was allocated with (the quality's cascades, side and format).
    shadow_desc: ShadowMapDesc,
    /// What each cascade's map holds across frames (the far-cascade cadence).
    shadow_history: CascadeHistory,
    /// Live's spot shadow slots across frames (P2-0.4, SH-07: sticky slots, faded hand-overs).
    spot_slots: crate::spot_shadow::SpotSlots,
    /// The cascades this frame redraws.
    shadow_draws: CascadeDraws,
    /// The shadowed spots' caster pipelines, made on the first frame that draws a spot map.
    spot_shadow: Option<crate::spot_shadow::SpotShadowPipelines>,
    /// The draw variants' pipelines (P2-0.12: double-sided and alpha-tested batches), made on the
    /// first frame that draws each.
    variants: variants::VariantPipelines,
    /// The terrain (renderer pass 2 A.7, [`Renderer::set_terrain`]) and its pipelines, made on the
    /// first frame that draws each.
    terrain: Option<crate::terrain::gpu::TerrainGpu>,
    terrain_pipelines: terrain_draw::TerrainPipelines,
    /// The terrain's grass (renderer pass 2 A.8), its pipelines and the time its wind sways at.
    grass: Option<crate::foliage::gpu::GrassGpu>,
    grass_pipelines: grass_draw::GrassPipelines,
    grass_time: grass_draw::GrassTime,
    /// The look's depth of field and motion blur (graph nodes 17a and 17b, renderer pass 2 A.9).
    lens: std::cell::RefCell<lens::LensNodes>,
    shadow_sampler: Sampler,
    /// PCSS's blocker search gathers the shadow map through it (`layout::SHADOW_BLOCKER_SAMPLER`).
    point_sampler: Sampler,
    texture_sampler: Sampler,
    /// `texture_sampler`'s anisotropy (the quality's, [`Quality::anisotropy`]).
    texture_anisotropy: u16,
    /// The material texture arrays of every size class (RQ6.4): made for the quality and device
    /// class in effect when the first texture is added, then kept (a later quality change keeps
    /// what was uploaded; the shaders read each texture's class from its reference). Class 0 is
    /// bindings 8 and 9, the larger classes [`FRAME_MATERIAL_CLASS_BINDINGS`] (a 1 × 1
    /// placeholder until their first texture).
    textures: ClassArrays,
    /// Whether the texture arrays are fixed: a texture was added, or a device-loss replay set
    /// them ([`Renderer::set_texture_arrays`]).
    textures_fixed: bool,
    /// The family the larger size classes are stored in (renderer pass 2 A6.4; RGBA8 until a
    /// game's compressed files choose one, [`Renderer::set_texture_family`]).
    texture_family: crate::texture::TextureFamily,
    /// The game's environment (the flat colour until set).
    environment_choice: Environment,
    /// The environment the frame binds (graph node 11's IBL output; neutral until baked).
    environment: std::cell::RefCell<EnvironmentMaps>,
    /// The physical sky's LUTs and background (graph nodes 11 and 13).
    sky: std::cell::RefCell<SkyState>,
    /// Whether the next frames bake the environment whole (a settled capture's re-renders).
    environment_settle: bool,
    stats: FrameStats,
    last: LastFrame,
    last_cpu: Option<CpuCull>,
    /// The meshlet cull (graph nodes 5 and 8's meshlet half), made on the first meshlet frame.
    meshlet_node: Option<MeshletCullNode>,
    /// The light binning (graph node 4), made on the first binned frame (it caches its bind group
    /// and grows its axis scratch while it encodes).
    light_bins: std::cell::RefCell<Option<crate::cluster::LightBinNode>>,
    /// Whether the game has asked for a shadowed spot under a quality that draws them (sticky, RQ6
    /// review): the shadow array then keeps its spot atlas layer whether or not a frame grants a
    /// slot, so a spot toggling or crossing the cap never reallocates the cascades.
    spot_atlas: bool,
    /// Scene pipeline sets made so far (the HDR and legacy scenes' and the prepass's): a frame that
    /// makes one compiles shaders on the frame thread.
    scene_pipeline_builds: std::cell::Cell<u32>,
    /// The meshlet draws' pipelines, made on the first meshlet frame and again when the scene's
    /// format, depth convention or surfaces change.
    meshlet_pipelines: Option<(MeshletPipelineKey, MeshletPipelines)>,
    /// The Hi-Z build (graph node 8), made on the first frame that occludes (it caches its bind
    /// groups while it encodes).
    hiz: std::cell::RefCell<Option<HizNode>>,
    /// The frame's Hi-Z pyramid while occlusion runs.
    hiz_pyramid: Option<HizPyramid>,
    /// What the last frame drew through meshlets.
    last_meshlets: Option<MeshletFrame>,
    /// The instance table the last upload wrote and the retained spans it holds (A.0b).
    retained_held: std::cell::RefCell<Option<(Buffer, Vec<crate::retained::RetainedSpan>)>>,
    /// Bytes of instance rows the last upload wrote.
    last_instance_bytes: std::cell::Cell<u64>,
    /// The history set the next frames draw on (Live, or a settled capture's; RQ5.6).
    history_set: HistorySet,
    /// Whether a frame index of 0 keeps TAA's and the motion history (a dynamic-resolution step:
    /// the history set started its index over for a reason TAA rides through, RQ5 review).
    temporal_kept: bool,
    /// What the frame being drawn does with TAA, motion and jitter.
    temporal: FrameTemporal,
    /// Motion vectors' row history: Live's and a capture's own (by [`set_index`]).
    motion_history: [MotionHistory; 2],
    /// The motion prepass's group 2 and frame row, made on the first frame writing motion.
    motion_node: Option<MotionNode>,
    /// Last frame's skinned vertices for the motion prepass.
    skinned_prev: SkinnedPrevious,
    /// TAA's histories, Live's and a capture's own (graph node 17), made on the first TAA frame.
    taa: std::cell::RefCell<Option<TaaHistories>>,
    /// TAA's reactive coverage (graph node 15a), made on the first TAA frame.
    reactive: Option<ReactivePipelines>,
    /// The FSR1 upscaler (graph node 22), made on the first HDR frame whose quality asks for it.
    fsr: std::cell::RefCell<Option<FsrNode>>,
    /// Each history set's last TAA frame (by [`set_index`]).
    temporal_last: [Option<TemporalLast>; 2],
    /// The motion prepass's frame row of the frame being prepared (taken into its `FramePrep`).
    motion_row: Option<GpuMotionFrame>,
    /// The camera's reprojection of the frame being drawn (last frame's view_proj × this frame's
    /// inverse; the identity without motion history): TAA's disocclusion test reads it.
    taa_reproject: [f32; 16],
    /// The game's logical world size: the size the renderer was made at ([`Renderer::logical_size`]).
    logical: (u32, u32),
    /// The most coverage the frame's transparent meshes write into TAA's reactive mask, each its
    /// material's alpha below it ([`crate::post::taa::transparent_coverage`]), read before the
    /// uploads take the plan's previous-model table.
    transparent_coverage: crate::post::taa::ReactiveCoverage,
}

fn texture_entry(binding: u32, sample_type: wgpu::TextureSampleType, dimension: wgpu::TextureViewDimension) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Texture { sample_type, view_dimension: dimension, multisampled: false },
        count: None,
    }
}

fn sampler_entry(binding: u32, kind: wgpu::SamplerBindingType) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry { binding, visibility: ShaderStages::FRAGMENT, ty: BindingType::Sampler(kind), count: None }
}

/// Whether `binned` bins a local light, a decal, a reflection probe or an irradiance volume (graph
/// node 4 has work).
fn bins_anything(binned: &crate::lights::BinnedFrame) -> bool {
    let bins = &binned.bins;
    !(bins.order.is_empty() && bins.decals.is_empty() && bins.probes.is_empty())
}

fn bind_group_layout(device: &Device, label: &str, entries: &[BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

/// The frame layout's environment entries ([`FRAME_ENV_BOUND`]): the reflection probes' cube array
/// and rows (renderer pass 2 A.3, `probes::frame_env_entry`), and each other input under the binding
/// type the Level-2 v2 material map gives the input of the same name, so the shared lighting
/// chunks see one type in both.
fn frame_env_entries() -> impl Iterator<Item = BindGroupLayoutEntry> {
    FRAME_ENV_BOUND.into_iter().filter_map(|(binding, name)| {
        if let Some(entry) = crate::probes::frame_env_entry(binding, name) {
            return Some(entry);
        }
        let row = MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name)?;
        Some(BindGroupLayoutEntry { binding, visibility: ShaderStages::FRAGMENT, ty: row.kind.binding_type(false, row.bytes), count: None })
    })
}

/// The frame layout's local-light and material-extension tables ([`FRAME_LIGHT_BINDINGS`], RQ6.0):
/// each the binding type the Level-2 v2 material map gives the table of the same name (the one
/// bin table the type of the v2 map's z-bins, a slice of it; LG-16).
fn frame_light_entries() -> impl Iterator<Item = BindGroupLayoutEntry> {
    FRAME_LIGHT_BINDINGS.into_iter().filter_map(|(binding, name)| {
        let name = crate::layout::frame_light_v2_twin(name);
        let row = MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name)?;
        Some(BindGroupLayoutEntry { binding, visibility: ShaderStages::FRAGMENT, ty: row.kind.binding_type(false, row.bytes), count: None })
    })
}

/// The frame layout's RQ4 effect entries the renderer binds ([`FRAME_EFFECT_BOUND`], RQ4.6): the
/// fog row as a uniform, the AO term under the Level-2 v2 material map's type for `ao_map`, the
/// contact-shadow mask as a 2D float texture.
fn frame_effect_entries() -> impl Iterator<Item = BindGroupLayoutEntry> {
    let float = wgpu::TextureSampleType::Float { filterable: true };
    FRAME_EFFECT_BOUND.into_iter().map(move |(binding, name)| match MATERIAL_V2_BINDINGS.iter().find(|row| row.name == name) {
        Some(row) => BindGroupLayoutEntry { binding, visibility: ShaderStages::FRAGMENT, ty: row.kind.binding_type(false, row.bytes), count: None },
        None if name == "frame_fog" => uniform(binding, false, ShaderStages::FRAGMENT),
        None => texture_entry(binding, float, wgpu::TextureViewDimension::D2),
    })
}

/// The forward frame group's layout: the tables, the shadow array, the class-0 material arrays
/// and samplers, the environment, the RQ4 effects the renderer binds, the RQ6 light and
/// material-extension tables and the larger material size classes' arrays. tests/layout.rs holds
/// it within WebGPU core's per-stage limits with every RQ4 effect slot added.
pub fn frame_layout_entries() -> Vec<BindGroupLayoutEntry> {
    use wgpu::TextureViewDimension::D2Array;
    let (vertex, fragment) = (ShaderStages::VERTEX, ShaderStages::FRAGMENT);
    let color = wgpu::TextureSampleType::Float { filterable: true };
    let classes = FRAME_MATERIAL_CLASS_BINDINGS.into_iter().map(|(binding, _)| texture_entry(binding, color, D2Array));
    [
        uniform(0, false, ShaderStages::VERTEX_FRAGMENT),
        storage(1, true, vertex),
        storage(2, true, fragment),
        storage(3, true, vertex),
        storage(4, true, vertex),
        storage(5, true, fragment),
        texture_entry(6, wgpu::TextureSampleType::Depth, D2Array),
        sampler_entry(7, wgpu::SamplerBindingType::Comparison),
        texture_entry(8, color, D2Array),
        texture_entry(9, color, D2Array),
        sampler_entry(10, wgpu::SamplerBindingType::Filtering),
    ]
    .into_iter()
    .chain(frame_env_entries())
    .chain(frame_effect_entries())
    .chain(frame_light_entries())
    .chain(classes)
    .collect()
}

/// The sun casters' group: the frame, the instance table, the visible list and the slot bases,
/// then an alpha-tested caster's material inputs (P2-0.12, `shaders/shadow.wgsl`): the material
/// table and its extension, the colour arrays of every size class and the material sampler.
fn shadow_layout_entries() -> Vec<BindGroupLayoutEntry> {
    use wgpu::TextureViewDimension::D2Array;
    let (vertex, fragment) = (ShaderStages::VERTEX, ShaderStages::FRAGMENT);
    let color = wgpu::TextureSampleType::Float { filterable: true };
    let mut entries = vec![uniform(0, false, vertex), storage(1, true, vertex), storage(2, true, vertex), storage(3, true, vertex)];
    entries.extend([storage(SHADOW_MASK_MATERIALS, true, fragment), storage(SHADOW_MASK_MATERIAL_EXT, true, fragment)]);
    entries.extend(SHADOW_MASK_COLOR_ARRAYS.map(|binding| texture_entry(binding, color, D2Array)));
    entries.push(sampler_entry(SHADOW_MASK_SAMPLER, wgpu::SamplerBindingType::Filtering));
    entries
}

/// The sun casters' alpha-mask bindings (P2-0.12, `shaders/shadow.wgsl`): the material table, its
/// extension, the colour arrays of size classes 256, 512, 1024 and 2048, and the material sampler.
const SHADOW_MASK_MATERIALS: u32 = 4;
const SHADOW_MASK_MATERIAL_EXT: u32 = 5;
const SHADOW_MASK_COLOR_ARRAYS: [u32; 4] = [6, 7, 8, 9];
const SHADOW_MASK_SAMPLER: u32 = 10;

fn layouts(device: &Device) -> Layouts {
    let (vertex, fragment) = (ShaderStages::VERTEX, ShaderStages::FRAGMENT);
    let frame = frame_layout_entries();
    Layouts {
        frame: bind_group_layout(device, "frame", &frame),
        shadow: bind_group_layout(device, "shadow", &shadow_layout_entries()),
        pass: bind_group_layout(device, "pass view", &[uniform(0, true, vertex)]),
        // The line fragment reads the frame's pre-exposure on the HDR scene.
        lines: bind_group_layout(device, "lines", &[uniform(0, false, vertex | fragment)]),
        prepass_draw: bind_group_layout(device, "prepass draw", &[uniform(1, true, vertex)]),
    }
}

/// The depth test of a depth-writing (`write`) or depth-testing pipeline, standard or `reversed`.
pub(crate) fn depth_compare(write: bool, reversed: bool) -> wgpu::CompareFunction {
    match (write, reversed) {
        (true, false) => wgpu::CompareFunction::Less,
        (false, false) => wgpu::CompareFunction::LessEqual,
        (true, true) => wgpu::CompareFunction::Greater,
        (false, true) => wgpu::CompareFunction::GreaterEqual,
    }
}

fn depth_state(write: bool, reversed: bool) -> wgpu::DepthStencilState {
    wgpu::DepthStencilState {
        format: DEPTH_FORMAT,
        depth_write_enabled: Some(write),
        depth_compare: Some(depth_compare(write, reversed)),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState::default(),
    }
}

/// Blending over the frame while keeping the target's alpha (1), so captures stay opaque.
const BLEND_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::SrcAlpha,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
};

struct PipelineSpec<'a> {
    label: &'a str,
    module: &'a ShaderModule,
    vertex: &'a str,
    fragment: Option<&'a str>,
    buffers: &'a [Option<wgpu::VertexBufferLayout<'a>>],
    topology: wgpu::PrimitiveTopology,
    depth: Option<wgpu::DepthStencilState>,
    format: TextureFormat,
    blend: Option<wgpu::BlendState>,
    samples: u32,
    layout: &'a wgpu::PipelineLayout,
}

fn render_pipeline(device: &Device, spec: &PipelineSpec<'_>) -> Compiled<RenderPipeline> {
    render_pipeline_with(device, spec, &[])
}

/// [`render_pipeline`] with the module's pipeline-overridable `constants` set.
fn render_pipeline_with(device: &Device, spec: &PipelineSpec<'_>, constants: &[(&str, f64)]) -> Compiled<RenderPipeline> {
    let compilation_options = wgpu::PipelineCompilationOptions { constants, ..Default::default() };
    let cull_mode = (spec.topology == wgpu::PrimitiveTopology::TriangleList && spec.depth.is_some()).then_some(wgpu::Face::Back);
    let targets = [Some(wgpu::ColorTargetState { format: spec.format, blend: spec.blend, write_mask: wgpu::ColorWrites::ALL })];
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(spec.label),
        layout: Some(spec.layout),
        vertex: wgpu::VertexState {
            module: spec.module,
            entry_point: Some(spec.vertex),
            compilation_options: compilation_options.clone(),
            buffers: spec.buffers,
        },
        primitive: wgpu::PrimitiveState { topology: spec.topology, cull_mode, ..Default::default() },
        depth_stencil: spec.depth.clone(),
        multisample: wgpu::MultisampleState { count: spec.samples, ..Default::default() },
        fragment: spec.fragment.map(|entry_point| wgpu::FragmentState {
            module: spec.module,
            entry_point: Some(entry_point),
            compilation_options: compilation_options.clone(),
            targets: &targets,
        }),
        multiview_mask: None,
        cache: None,
    })
}

const MESH_ATTRIBUTES: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4];
const SLOT_ATTRIBUTES: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![4 => Uint32];
const LINE_ATTRIBUTES: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x4];

/// The mesh vertex stream and the per-vertex slot stream.
fn mesh_buffers_layout() -> [Option<wgpu::VertexBufferLayout<'static>>; 2] {
    [
        Some(wgpu::VertexBufferLayout { array_stride: VERTEX_STRIDE, step_mode: wgpu::VertexStepMode::Vertex, attributes: &MESH_ATTRIBUTES }),
        Some(wgpu::VertexBufferLayout { array_stride: 4, step_mode: wgpu::VertexStepMode::Vertex, attributes: &SLOT_ATTRIBUTES }),
    ]
}

/// The scene-colour pipelines drawing into `format` with standard or `reversed` depth, their
/// surfaces made for `surface` (specular AA on the HDR scene, the sun's shadow filter; the
/// transparent pipeline's for [`SurfaceKey::blended`]).
fn scene_pipelines(device: &Device, layouts: &Layouts, samples: u32, format: TextureFormat, reversed: bool, surface: SurfaceKey) -> Result<ScenePipelines, RenderError> {
    let forward_module = shader(device, "forward", crate::shaders::FORWARD)?;
    let lines_module = shader(device, "lines", crate::shaders::LINES)?;
    let background_module = shader(device, "background", crate::shaders::BACKGROUND)?;
    let forward_layout = pipeline_layout(device, "forward", &[&layouts.frame, &layouts.pass]);
    let lines_layout = pipeline_layout(device, "lines", &[&layouts.lines]);
    let meshes = mesh_buffers_layout();
    let line_buffers = [Some(wgpu::VertexBufferLayout {
        array_stride: size_of::<LineVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &LINE_ATTRIBUTES,
    })];
    // The HDR scene's pipelines expose in the shader (`GX_SCENE_HDR`); the legacy scene's encode
    // sRGB with no branch on the frame, so the off path draws exactly as before the follow-up.
    let hdr = [("GX_SCENE_HDR", f64::from(u8::from(reversed)))];
    let surfaces = surface_constants(reversed, format, surface);
    let blended = surface_constants(reversed, format, surface.blended());
    let mesh_spec = |label, fragment, depth_write, blend| PipelineSpec {
        label,
        module: &forward_module,
        vertex: "vs_main",
        fragment: Some(fragment),
        buffers: &meshes,
        topology: wgpu::PrimitiveTopology::TriangleList,
        depth: Some(depth_state(depth_write, reversed)),
        format,
        blend,
        samples,
        layout: &forward_layout,
    };
    Ok(ScenePipelines {
        forward: render_pipeline_with(device, &mesh_spec("forward", "fs_main", true, None), &surfaces),
        blend: render_pipeline_with(device, &mesh_spec("transparent", "fs_blend", false, Some(BLEND_OVER)), &blended),
        lines: render_pipeline_with(
            device,
            &PipelineSpec {
                label: "lines",
                module: &lines_module,
                vertex: "vs_line",
                fragment: Some("fs_line"),
                buffers: &line_buffers,
                topology: wgpu::PrimitiveTopology::LineList,
                depth: Some(depth_state(false, reversed)),
                format,
                blend: None,
                samples,
                layout: &lines_layout,
            },
            &hdr,
        ),
        background: render_pipeline(
            device,
            &PipelineSpec {
                label: "background",
                module: &background_module,
                vertex: "vs_background",
                fragment: Some("fs_background"),
                buffers: &line_buffers,
                topology: wgpu::PrimitiveTopology::TriangleList,
                depth: Some(wgpu::DepthStencilState {
                    depth_write_enabled: Some(false),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    ..depth_state(false, reversed)
                }),
                format,
                blend: None,
                samples,
                layout: &lines_layout,
            },
        ),
    })
}

fn pipelines(device: &Device, layouts: &Layouts, casters: CasterDepth) -> Result<Pipelines, RenderError> {
    let shadow_module = shader(device, "shadow", crate::shaders::SHADOW)?;
    let shadow_layout = pipeline_layout(device, "shadow", &[&layouts.shadow, &layouts.pass]);
    let meshes = mesh_buffers_layout();
    let shadow = |format: TextureFormat| {
        let spec = CasterSpec { label: "shadow", module: &shadow_module, vertex: "vs_shadow", buffers: &meshes, layout: &shadow_layout, format, depth: casters };
        caster_pipeline(device, &spec)
    };
    Ok(Pipelines {
        scene: None,
        scene_surface: SurfaceKey::LEGACY,
        shadow: shadow(ShadowFormat::Depth32.texture_format()),
        shadow16: shadow(ShadowFormat::Depth16.texture_format()),
    })
}

/// The world pass's forward pipeline when it tests `Equal` against the prepass depth with depth
/// writes off (1x only): otherwise the scene pipelines' `forward` of `format` and depth convention.
fn forward_equal_pipeline(device: &Device, layouts: &Layouts, format: TextureFormat, reversed: bool, surface: SurfaceKey) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = shader(device, "forward", crate::shaders::FORWARD)?;
    let layout = pipeline_layout(device, "forward", &[&layouts.frame, &layouts.pass]);
    let meshes = mesh_buffers_layout();
    let equal = wgpu::DepthStencilState { depth_compare: Some(wgpu::CompareFunction::Equal), ..depth_state(false, reversed) };
    let spec = PipelineSpec {
        label: "forward equal",
        module: &module,
        vertex: "vs_main",
        fragment: Some("fs_main"),
        buffers: &meshes,
        topology: wgpu::PrimitiveTopology::TriangleList,
        depth: Some(equal),
        format,
        blend: None,
        samples: 1,
        layout: &layout,
    };
    Ok(render_pipeline_with(device, &spec, &surface_constants(reversed, format, surface)))
}

/// The forward module's pipeline constants: the HDR scene (`reversed` depth) exposes in the shader
/// (`GX_SCENE_HDR`), its surfaces filter specular aliasing when `surface` asks (RQ2.4: the surface
/// chunk's `GX_SPECULAR_AA`, which only the forward module declares), and the sun chunk filters
/// its cascades with `surface`'s filter (`GX_SHADOW_FILTER`, [`ShadowFilter::shader_id`]), turning
/// the soft filters' taps with the frame only under a temporal resolve (`GX_SHADOW_TEMPORAL`);
/// each RQ4 screen effect is read only when the quality draws it ([`EffectKey`]); the material
/// textures' LOD bias is the frame's (`GpuFrame::texture_lod`, T-06), never a constant. Two constants compile
/// out code a frame of the pipeline can never take (RX.R1: the features-off frame should carry no
/// more than RQ0's): the environment's light only ever lights the HDR scene
/// (`GX_ENVIRONMENT_LIGHT`), and binned lights only come with the clustered switch
/// (`GX_BINNED_LIGHTS`). Two more bound the sun chunk by the quality's shadows (pass-1 gate,
/// owner decision 2026-10-12): its cascade blend band and end fade only where the quality has
/// them (`GX_SUN_SOFT_EDGES`), its cascade choice only over the quality's cascades
/// (`GX_SUN_CASCADES`). An HDR scene stored as `rg11b10ufloat` (`format`) dithers its writes by
/// half a mantissa step (`GX_SCENE_RG11B10`, renderer pass 2 P2-0.10 C5); every other format writes
/// as before. The surfaces shade no smoother than the key's roughness floor (`GX_ROUGHNESS_FLOOR`,
/// P2-0.12 LG-04).
fn surface_constants(reversed: bool, format: TextureFormat, surface: SurfaceKey) -> [(&'static str, f64); 16] {
    let effects = surface.effects;
    [
        ("GX_ROUGHNESS_FLOOR", f64::from(f32::from_bits(surface.roughness_floor))),
        ("GX_SUN_SOFT_EDGES", f64::from(u8::from(surface.sun_soft_edges))),
        ("GX_SUN_CASCADES", f64::from(surface.sun_cascades)),
        ("GX_ENVIRONMENT_LIGHT", f64::from(u8::from(reversed))),
        ("GX_BINNED_LIGHTS", f64::from(u8::from(surface.binned_lights))),
        ("GX_TEXTURE_CLASSES", f64::from(u8::from(surface.texture_classes))),
        ("GX_TOKSVIG", f64::from(u8::from(surface.toksvig))),
        ("GX_AO", f64::from(u8::from(effects.ao))),
        ("GX_CONTACT_SHADOWS", f64::from(u8::from(effects.contact_shadows))),
        ("GX_FOG", f64::from(u8::from(effects.fog))),
        ("GX_AERIAL", f64::from(u8::from(effects.aerial))),
        ("GX_SCENE_HDR", f64::from(u8::from(reversed))),
        ("GX_SCENE_RG11B10", f64::from(u8::from(reversed && format == TextureFormat::Rg11b10Ufloat))),
        ("GX_SPECULAR_AA", f64::from(u8::from(reversed && surface.specular_aa))),
        ("GX_SHADOW_FILTER", f64::from(surface.shadow_filter.shader_id())),
        ("GX_SHADOW_TEMPORAL", f64::from(u8::from(surface.shadow_temporal))),
    ]
}

/// A prepass pipeline drawing `vertex` of `module` into the normals and a depth of `reversed`
/// convention through `layout`.
fn prepass_pipeline(device: &Device, module: &ShaderModule, vertex: &str, buffers: &[Option<wgpu::VertexBufferLayout<'_>>], layout: &wgpu::PipelineLayout, reversed: bool) -> Compiled<RenderPipeline> {
    let spec = PipelineSpec {
        label: vertex,
        module,
        vertex,
        fragment: Some("fs_prepass"),
        buffers,
        topology: wgpu::PrimitiveTopology::TriangleList,
        depth: Some(depth_state(true, reversed)),
        format: crate::prepass::NORMALS_FORMAT,
        blend: None,
        samples: 1,
        layout,
    };
    render_pipeline(device, &spec)
}

/// The prepass's pipelines for a scene of `format` with `reversed` depth (its `Equal` forward
/// pipeline's constants made for `surface`).
fn prepass_pipelines(device: &Device, layouts: &Layouts, format: TextureFormat, reversed: bool, surface: SurfaceKey) -> Result<PrepassPipelines, RenderError> {
    let module = shader(device, "prepass", crate::shaders::PREPASS)?;
    let meshes = mesh_buffers_layout();
    let batches_layout = pipeline_layout(device, "prepass", &[&layouts.frame, &layouts.pass]);
    let draws_layout = pipeline_layout(device, "prepass draws", &[&layouts.frame, &layouts.prepass_draw]);
    Ok(PrepassPipelines {
        format,
        reversed,
        surface,
        batches: prepass_pipeline(device, &module, "vs_prepass", &meshes, &batches_layout, reversed),
        draws: prepass_pipeline(device, &module, "vs_prepass_draw", &meshes[..1], &draws_layout, reversed),
        forward_equal: forward_equal_pipeline(device, layouts, format, reversed, surface)?,
        motion: None,
    })
}

/// The motion prepass's pipelines (`vs_prepass_motion`, `vs_prepass_draw_motion`) over the frame
/// and pass-view groups (or the custom-geometry row) and `node`'s group 2, depth of `reversed`
/// convention.
fn motion_pipelines(device: &Device, layouts: &Layouts, node: &MotionNode, reversed: bool) -> Result<MotionPipelines, RenderError> {
    let module = shader(device, "prepass", crate::shaders::PREPASS)?;
    let meshes = mesh_buffers_layout();
    Ok(MotionPipelines {
        batches: node.pipeline(device, &module, crate::motion::VERTEX_ENTRY, &meshes, [&layouts.frame, &layouts.pass], reversed),
        draws: node.pipeline(device, &module, crate::motion::DRAW_VERTEX_ENTRY, &meshes[..1], [&layouts.frame, &layouts.prepass_draw], reversed),
        background: node.background_pipeline(device, reversed)?,
    })
}

/// Whether the prepass's `pipelines` draw `path` with `surface` as made (else made again).
fn prepass_pipelines_fit(pipelines: &PrepassPipelines, path: &ScenePath, surface: SurfaceKey) -> bool {
    pipelines.format == path.format && pipelines.reversed == path.depth_reversed && pipelines.surface == surface
}

/// Room for `draws` custom-geometry rows (a power of two, at least one) and their bind group.
fn prepass_rows(device: &Device, layout: &BindGroupLayout, draws: usize) -> Result<PrepassRows, RenderError> {
    let capacity = draws.max(1).next_power_of_two();
    let buffer = buffer(device, "prepass draws", capacity as u64 * crate::prepass::DRAW_STRIDE, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("prepass draws"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 1,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                buffer: &buffer,
                offset: 0,
                size: wgpu::BufferSize::new(size_of::<GpuPrepassDraw>() as u64),
            }),
        }],
    });
    Ok(PrepassRows { buffer, group, capacity })
}

fn mesh_buffers(device: &Device, queue: &Queue, library: &MeshLibrary) -> Result<MeshBuffers, RenderError> {
    let upload = |label, bytes: &[u8], usage: BufferUsages| -> Result<Buffer, RenderError> {
        let target = buffer(device, label, aligned(bytes.len() as u64), usage | BufferUsages::COPY_DST)?;
        if !bytes.is_empty() {
            queue.write_buffer(&target, 0, bytes);
        }
        Ok(target)
    };
    Ok(MeshBuffers {
        vertices: upload("vertices", bytemuck::cast_slice(library.vertices()), BufferUsages::VERTEX | BufferUsages::STORAGE)?,
        slots: upload("slots", bytemuck::cast_slice(library.slots()), BufferUsages::VERTEX)?,
        indices: upload("indices", bytemuck::cast_slice(library.indices()), BufferUsages::INDEX)?,
        skin: upload("skin", bytemuck::cast_slice(library.skin()), BufferUsages::STORAGE)?,
        meshlets: MeshletBuffers::upload(device, queue, library.meshlets())?,
    })
}

/// The sample count `options` gets on this device: 4 when both target formats take it.
fn sample_count(device: &Device, options: RenderOptions) -> u32 {
    let features = device.features();
    let takes = |format: TextureFormat| format.guaranteed_format_features(features).flags.sample_count_supported(MSAA_SAMPLES);
    if options.msaa && takes(WORLD_FORMAT) && takes(DEPTH_FORMAT) { MSAA_SAMPLES } else { 1 }
}

/// The samples per pixel the world pass takes for `anti_aliasing` in this build: MSAA 4x for MSAA,
/// and for TAA too until TAA lands (RQ5, [`crate::post::taa::LANDED`]), so a preset that asks for
/// TAA keeps today's edges instead of losing them; 1 for no anti-aliasing and for landed TAA.
pub const fn landed_samples(anti_aliasing: AntiAliasing) -> u32 {
    match anti_aliasing {
        AntiAliasing::Off => 1,
        AntiAliasing::Taa | AntiAliasing::TaaSharpen if crate::post::taa::LANDED => 1,
        _ => MSAA_SAMPLES,
    }
}

/// The form factor a renderer assumes until told ([`Renderer::set_form_factor`]): mobile on iOS
/// and Android builds (tile GPUs), desktop elsewhere; the web's class comes from the probe.
fn default_form_factor() -> FormFactor {
    match TargetOs::current() {
        TargetOs::Ios | TargetOs::Android => FormFactor::Mobile,
        _ => FormFactor::Desktop,
    }
}

/// The exposure the scene is written with: `2^EV` in manual mode with the exposure switch on; 1
/// otherwise. Under auto exposure the GPU's adapted exposure is copied over it each frame
/// ([`FRAME_PRE_EXPOSURE_OFFSET`]); 1 is where adaptation starts.
fn pre_exposure(look: &Look, quality: &Quality) -> f32 {
    let manual = quality.exposure && look.exposure == ExposureMode::Manual;
    let exposure = if manual { look.manual_exposure() } else { 1.0 };
    exposure.max(f32::MIN_POSITIVE)
}

/// Whether auto exposure reads the resolved HDR scene this frame (its histogram, node 20).
fn auto_exposure(look: &Look, quality: &Quality) -> bool {
    quality.hdr && quality.exposure && look.exposure == ExposureMode::Auto
}

/// The background triangle covering the scene with `clear` (sRGB bytes) as linear light.
fn background_vertices(clear: [u8; 4]) -> [LineVertex; 3] {
    let [r, g, b, _] = clear.map(|c| exposed(f32::from(c) / 255.0, 1.0));
    let color = [r, g, b, 1.0];
    let corners = [[-1.0, -1.0, 0.0], [3.0, -1.0, 0.0], [-1.0, 3.0, 0.0]];
    corners.map(|position| LineVertex { position, color })
}

/// The sRGB byte `c` as linear light times `exposure` (a clear colour or line on the HDR path).
fn exposed(c: f32, exposure: f32) -> f32 {
    let linear = if c <= 0.04045 { c / 12.92 } else { libm::powf((c + 0.055) / 1.055, 2.4) };
    linear * exposure
}

/// The size of the scene at `scale` of `output` (the settings' one formula, clamped to the
/// smallest scale step).
fn scaled_size(output: (u32, u32), scale: f32) -> (u32, u32) {
    RenderSettings::off().frame_config(output, scale, 0, false).render_size
}

fn target(label: &'static str, format: TextureFormat, usage: TextureUsages, samples: u32, size: (u32, u32)) -> TargetDesc {
    TargetDesc { label, format, usage, samples, size, mips: 1, srgb_view: false }
}

/// What a frame's targets must hold beyond the legacy set (RQ1.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TargetSpec {
    /// The HDR scene format, on the HDR path.
    hdr: Option<TextureFormat>,
    /// Whether a later pass reads the multisampled colour (the desktop weighted resolve).
    msaa_read: bool,
    /// Whether the HDR path needs the 1x scene colour (single-sampled, hardware-resolved, or read
    /// resolved before the tonemap).
    scene_1x: bool,
    /// Whether the depth is kept for a readback.
    depth_readback: bool,
    /// Whether the frame runs the depth/normal prepass (its targets are acquired).
    prepass: bool,
    /// Whether the world pass tests `Equal` against the prepass depth instead of its own.
    equal_depth: bool,
    /// Whether the prepass writes motion and the reactive mask (their targets are acquired).
    motion: bool,
    /// The FSR1 passes the frame runs (their intermediates are acquired).
    fsr: FsrPasses,
}

/// Usages of the HDR scene colour: drawn, read by the tonemap, read back by a test, and written
/// by a copy of TAA's resolve when `post-hdr` passes draw over it (RQ5.6).
const HDR_SCENE_USAGE: TextureUsages =
    TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_SRC).union(TextureUsages::COPY_DST);
/// Usages of a multisampled colour the weighted resolve reads.
const MSAA_READ_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// Usages of a depth kept for a readback.
const DEPTH_READBACK_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::COPY_SRC);
/// Usages of the world target: drawn, read back by captures, sampled by the present.
const WORLD_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::COPY_SRC).union(TextureUsages::TEXTURE_BINDING);
/// Usages of the legacy scene below scale 1: drawn, sampled by the upscale (through its sRGB twin).
const LEGACY_SCENE_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);

/// Every descriptor a frame may acquire from the pool (plan §2.3; the layout check holds each to
/// what WebGPU core guarantees): the renderer's own at `samples` with an `hdr` scene format,
/// unread attachments under `policy` (the world target, the legacy scaled scene, the HDR scene,
/// the multisampled colour unread or read by the weighted resolve, the depth unread or kept for a
/// readback), then the environment's under `quality` (the IBL cubes and BRDF LUT, the sky LUTs).
pub fn target_catalog(policy: TargetPolicy, samples: u32, hdr: TextureFormat, quality: &Quality) -> Vec<TargetDesc> {
    let size = (64, 64);
    let unread = policy.attachment_usage();
    let mut descs = vec![
        target(WORLD_TARGET, WORLD_FORMAT, WORLD_USAGE, 1, size),
        TargetDesc { srgb_view: true, ..target(SCENE_TARGET, WORLD_FORMAT, LEGACY_SCENE_USAGE, 1, size) },
        target(SCENE_TARGET, hdr, HDR_SCENE_USAGE, 1, size),
        target(DEPTH_TARGET, DEPTH_FORMAT, unread, samples, size),
        target(DEPTH_TARGET, DEPTH_FORMAT, DEPTH_READBACK_USAGE, samples, size),
    ];
    if samples > 1 {
        for format in [WORLD_FORMAT, hdr] {
            descs.push(target(MSAA_TARGET, format, unread, samples, size));
        }
        descs.push(target(MSAA_TARGET, hdr, MSAA_READ_USAGE, samples, size));
    }
    if quality.prepass {
        for desc in crate::prepass::targets(size) {
            descs.push(desc);
            descs.push(TargetDesc { usage: desc.usage | crate::prepass::READBACK_USAGE, ..desc });
        }
    }
    if quality.anti_aliasing.temporal() {
        // TAA's motion, reactive mask and history pair (RQ5.6).
        for desc in [crate::motion::target(size), crate::post::taa::reactive_target(size)] {
            descs.push(desc);
            descs.push(TargetDesc { usage: desc.usage | crate::prepass::READBACK_USAGE, ..desc });
        }
        descs.extend(crate::post::taa::history_targets(size).map(|desc| TargetDesc { usage: desc.usage | TextureUsages::COPY_SRC, ..desc }));
        // The resolve's luma and lock side histories (renderer pass 2, P2-0.8a; `TaaNode` makes
        // them itself, listed here for the layout check).
        descs.extend(crate::post::taa::side_history_targets(size));
    }
    if quality.upscaler == Upscaler::Fsr1 || quality.anti_aliasing == AntiAliasing::TaaSharpen {
        descs.extend([crate::post::fsr::intermediate_target(size), crate::post::fsr::easu_target(size)]);
    }
    descs.extend(crate::ibl::target_descs(&quality.environment));
    descs.extend(crate::sky::target_descs(&quality.environment));
    descs
}

/// The prepass's targets at `render` size (copyable for a readback when `readback`), with the
/// motion and the reactive mask when it writes `motion` (else they are released).
fn prepass_targets(pool: &mut TargetPool, device: &Device, render: (u32, u32), readback: bool, motion: bool) -> Result<PrepassTargets, RenderError> {
    let extra = if readback { crate::prepass::READBACK_USAGE } else { TextureUsages::empty() };
    let [depth, normals] = crate::prepass::targets(render).map(|desc| TargetDesc { usage: desc.usage | extra, ..desc });
    let depth = pool.acquire(device, depth)?;
    let (depth_texture, depth_view) = (depth.texture().clone(), depth.view().clone());
    let normals = pool.acquire(device, normals)?;
    let (normals_texture, normals_view) = (normals.texture().clone(), normals.view().clone());
    let mut temporal = |desc: TargetDesc| -> Result<Option<(Texture, TextureView)>, RenderError> {
        if !motion {
            pool.release(desc.label);
            return Ok(None);
        }
        let target = pool.acquire(device, TargetDesc { usage: desc.usage | extra, ..desc })?;
        Ok(Some((target.texture().clone(), target.view().clone())))
    };
    let motion_target = temporal(crate::motion::target(render))?;
    let reactive = temporal(crate::post::taa::reactive_target(render))?;
    Ok(PrepassTargets {
        depth_texture,
        depth_view,
        normals_texture,
        normals_view,
        motion: motion_target,
        reactive,
    })
}

/// FSR1's intermediates for `passes` (the tonemapped scene at `render` size, EASU's output at
/// `output` size), released where the frame runs none.
fn fsr_targets(pool: &mut TargetPool, device: &Device, render: (u32, u32), output: (u32, u32), passes: FsrPasses) -> Result<(Option<TextureView>, Option<TextureView>), RenderError> {
    let runs = passes.easu || passes.rcas;
    let input = if runs {
        Some(pool.acquire(device, crate::post::fsr::intermediate_target(render))?.view().clone())
    } else {
        pool.release(crate::post::fsr::INTERMEDIATE_LABEL);
        None
    };
    let easu = if passes.easu {
        Some(pool.acquire(device, crate::post::fsr::easu_target(output))?.view().clone())
    } else {
        pool.release(crate::post::fsr::EASU_LABEL);
        None
    };
    Ok((input, easu))
}

/// The 1x scene colour of `spec` at `render` size of `output`: the legacy scaled scene (sampled
/// through its sRGB twin by the upscale), the HDR scene, or none (the world target is the scene).
fn scene_target(pool: &mut TargetPool, device: &Device, output: (u32, u32), render: (u32, u32), spec: &TargetSpec) -> Result<Option<(Texture, TextureView, Option<TextureView>)>, RenderError> {
    let desc = match spec.hdr {
        Some(format) if spec.scene_1x => target(SCENE_TARGET, format, HDR_SCENE_USAGE, 1, render),
        Some(_) => {
            pool.release(SCENE_TARGET);
            return Ok(None);
        }
        None if render == output => {
            pool.release(SCENE_TARGET);
            return Ok(None);
        }
        None => TargetDesc { srgb_view: true, ..target(SCENE_TARGET, WORLD_FORMAT, LEGACY_SCENE_USAGE, 1, render) },
    };
    let scene = pool.acquire(device, desc)?;
    Ok(Some((scene.texture().clone(), scene.view().clone(), scene.srgb_view().cloned())))
}

/// Acquire the targets of `render` size (of `output`) from `pool`: an equal descriptor reuses the
/// pooled target, a new step size reallocates, and a target the step no longer draws is released.
fn pooled_targets(pool: &mut TargetPool, device: &Device, output: (u32, u32), render: (u32, u32), samples: u32, spec: &TargetSpec) -> Result<Targets, RenderError> {
    // Nothing reads the MSAA colour or the depth after the world pass: transient where it saves
    // memory (unless the weighted resolve reads the samples, or a test reads the depth back).
    let unread = pool.policy().attachment_usage();
    let world = pool.acquire(device, target(WORLD_TARGET, WORLD_FORMAT, WORLD_USAGE, 1, output))?.clone();
    let scene = scene_target(pool, device, output, render, spec)?;
    let color_format = spec.hdr.unwrap_or(WORLD_FORMAT);
    let msaa = if samples > 1 {
        let usage = if spec.msaa_read { MSAA_READ_USAGE } else { unread };
        Some(pool.acquire(device, target(MSAA_TARGET, color_format, usage, samples, render))?.view().clone())
    } else {
        pool.release(MSAA_TARGET);
        None
    };
    let prepass = if spec.prepass {
        Some(prepass_targets(pool, device, render, spec.depth_readback, spec.motion)?)
    } else {
        for label in [crate::prepass::DEPTH_LABEL, crate::prepass::NORMALS_LABEL, crate::motion::MOTION_LABEL, crate::post::taa::REACTIVE_LABEL] {
            pool.release(label);
        }
        None
    };
    let (fsr_input, fsr_easu) = fsr_targets(pool, device, render, output, spec.fsr)?;
    // The `Equal` world pass draws against the prepass depth: it needs no depth of its own.
    let (depth_texture, depth_view, transient) = match &prepass {
        Some(prepass) if spec.equal_depth => {
            pool.release(DEPTH_TARGET);
            (prepass.depth_texture.clone(), prepass.depth_view.clone(), false)
        }
        _ => {
            let depth_usage = if spec.depth_readback { DEPTH_READBACK_USAGE } else { unread };
            let depth = pool.acquire(device, target(DEPTH_TARGET, DEPTH_FORMAT, depth_usage, samples, render))?;
            (depth.texture().clone(), depth.view().clone(), depth.desc().transient())
        }
    };
    let (scene_texture, scene_view, scene_linear) = match scene {
        Some((texture, view, linear)) => (Some(texture), Some(view), linear),
        None => (None, None, None),
    };
    Ok(Targets {
        world: world.texture().clone(),
        world_view: world.view().clone(),
        scene_texture,
        scene_view,
        scene_linear,
        msaa_view: msaa,
        depth_texture,
        depth_view,
        transient,
        prepass,
        fsr_input,
        fsr_easu,
        samples,
        render_size: render,
        spec: *spec,
    })
}

/// The shadow comparison sampler, the non-filtering one PCSS's blocker search gathers the shadow
/// map with (clamped to its edge, as the search's own texel reads were) and the material sampler.
/// The material textures' sampler: trilinear and repeating, filtered anisotropically up to
/// `anisotropy` (1..=16; P2-0.12 LG-02, WebGPU core's `maxAnisotropy`, which needs all three
/// filters linear). Grazing ground and floors keep their detail into the distance instead of
/// taking the mip of the footprint's long axis.
fn texture_sampler(device: &Device, anisotropy: u16) -> Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("textures"),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        anisotropy_clamp: anisotropy.clamp(1, MAX_ANISOTROPY),
        ..Default::default()
    })
}

/// WebGPU core's largest `maxAnisotropy`.
const MAX_ANISOTROPY: u16 = 16;

fn samplers(device: &Device) -> (Sampler, Sampler, Sampler) {
    let shadow = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("shadow"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        compare: Some(wgpu::CompareFunction::LessEqual),
        ..Default::default()
    });
    let point = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("shadow blockers"), ..Default::default() });
    (shadow, point, texture_sampler(device, 1))
}

/// What a [`WorldStage`] draws with inside the world pass.
pub struct WorldPass<'a> {
    /// The frame uniforms (`FrameUniforms`: camera, sun, ambient), written for this frame.
    pub frame_uniforms: &'a Buffer,
    /// The library's vertices (`MeshVertex` rows, vertex buffer 0 of the mesh pipelines).
    pub vertices: &'a Buffer,
    /// The library's indices (`Uint32`).
    pub indices: &'a Buffer,
    /// Where each mesh sits in them.
    pub library: &'a MeshLibrary,
    /// The world pass's samples per pixel (a stage's pipelines must match it).
    pub samples: u32,
    /// The instance table (`Instance` rows), written for this frame (M2.19 binds it read-only).
    pub instances: &'a Buffer,
    /// The material table (`Material` rows), written for this frame (M2.19 binds it read-only).
    pub materials: &'a Buffer,
    /// The light table (`Light` rows) the forward pass lights with, written for this frame.
    pub lights: &'a Buffer,
    /// Each local light's extension row (`light_ext`, RQ6), row for row with `lights`.
    pub light_ext: &'a Buffer,
    /// The binned path's bin table (`light_bins`, RQ6; pass 2 A.0 LG-16): the header and z-bins
    /// (a zero header bins no light), then the tile masks, built for this frame.
    pub light_bins: &'a Buffer,
    /// The sun's cascaded shadow maps (`texture_depth_2d_array`), drawn this frame when shadows are on.
    pub shadow_map: &'a TextureView,
    /// The comparison sampler the forward pass reads the shadow maps with.
    pub shadow_sampler: &'a Sampler,
    /// The colour texture array (base colour, emissive).
    pub color_textures: &'a TextureView,
    /// The data texture array (normal, metallic-roughness, occlusion).
    pub data_textures: &'a TextureView,
    /// The sampler the forward pass reads the texture arrays with.
    pub texture_sampler: &'a Sampler,
    /// The scene colour's format the stage's in-world pipelines must target (the world format on
    /// the legacy path, the HDR scene format on the HDR path).
    pub scene_format: TextureFormat,
    /// Whether the world pass's depth is reversed (`Greater`, cleared to 0).
    pub depth_reversed: bool,
    /// Whether the scene is HDR: in-world draws write linear radiance times `pre_exposure`
    /// (the legacy scene takes sRGB-encoded colour).
    pub hdr: bool,
    /// The exposure the scene is written with (1 on the legacy path).
    pub pre_exposure: f32,
    /// The frame's fog row (`GxFog`, density 0: none), written for this frame: in-world draws fog
    /// like the forward pass (particles do).
    pub fog: &'a Buffer,
    /// The environment's prefiltered specular cube (neutral before a bake): the fog's in-scatter
    /// under a sky or an HDR map.
    pub env_specular: TextureView,
    /// The filtering sampler the environment is read with.
    pub env_sampler: Sampler,
    /// The ambient-occlusion term the forward pass binds this frame (graph node 10's at the render
    /// size, a white texel where AO does not run): Level-2 v2 materials bind it as `ao_map`.
    pub ao_term: TextureView,
    /// The sun's contact-shadow mask the forward pass binds this frame (graph node 10a's at the
    /// render size, a white texel where it does not run): v2 materials bind it as
    /// `contact_shadow_mask`.
    pub contact_mask: TextureView,
    /// The aerial-perspective volume the forward pass binds this frame (node 11's, a texel of no
    /// air where it did not run): v2 materials bind it as `aerial_perspective`.
    pub aerial: TextureView,
}

/// Work a frame adds around and inside the world pass (M2.6). Every method defaults to nothing.
pub trait WorldStage {
    /// Encode work after this frame's tables are uploaded and before skinning and the cull
    /// (M2.19's `before-cull` custom passes).
    fn before_cull(&mut self, _encoder: &mut wgpu::CommandEncoder, _world: &WorldPass<'_>) {}
    /// Encode compute work ahead of the world pass (after skinning and the cull).
    fn before_world(&mut self, _encoder: &mut wgpu::CommandEncoder, _world: &WorldPass<'_>) {}
    /// Draw opaque work after the opaque batches and lines, depth-tested and depth-writing.
    fn opaque(&self, _pass: &mut RenderPass<'_>, _world: &WorldPass<'_>) {}
    /// Draw blended work after the transparent draws, depth-tested against the world.
    fn blended(&self, _pass: &mut RenderPass<'_>, _world: &WorldPass<'_>) {}
    /// Why this stage keeps an HDR-asking frame on the legacy path (its in-world pipelines target
    /// the world format with standard Z), asked by [`Renderer::render_staged`] before the frame's
    /// targets are chosen. None: the stage draws whatever [`WorldPass`] says.
    fn ldr_reason(&self) -> Option<LdrReason> {
        None
    }
    /// The custom geometry the depth/normal prepass draws besides the opaque batches (graph node
    /// 7): a custom material's meshes at their model matrices, so the prepass's consumers see them.
    /// Asked once per frame, before its targets are chosen; the prepass runs only for its
    /// consumers. A frame with custom geometry keeps the world pass's own depth (its draws write
    /// depth with a strict test, which would reject their own prepass depth). Nothing by default.
    fn prepass_draws(&self) -> Vec<PrepassDraw> {
        Vec::new()
    }
    /// Whether the stage draws blended work TAA's reactive coverage marks (graph node 15a, RQ5.6:
    /// particles), so the node runs for it without transparent meshes. Nothing by default.
    fn reactive_draws(&self) -> bool {
        false
    }
    /// Draw the stage's blended work as coverage into TAA's reactive mask inside node 15a's pass
    /// (its depth the prepass's, read only; `node`'s jitter group goes at group 2). Nothing by
    /// default: a pass's in-world draws keep the motion of what is behind them.
    fn reactive(&self, _pass: &mut RenderPass<'_>, _node: &ReactiveNode) {}
    /// The GPU's adapted exposure this frame (a `GpuPreExposure`: the exposure and its inverse)
    /// when the stage's history meters it (auto exposure): graph node 11 copies it over the
    /// background's pre-exposure, so the sky or the map is exposed as the geometry is. None: the
    /// frame's own pre-exposure stands.
    fn pre_exposure_source(&self) -> Option<&Buffer> {
        None
    }
}

/// The stage of a frame with no part-2 work.
struct NoStage;

impl WorldStage for NoStage {}

/// The bind groups one frame's passes use.
#[derive(Clone)]
struct FrameGroups {
    frame: BindGroup,
    shadow: BindGroup,
    pass: BindGroup,
    lines: BindGroup,
}

/// One frame's plan and uploads, from [`Renderer::begin_frame_prepass`] until [`Renderer::end_frame`].
/// A sun as the environment sees it: the unit direction towards it and its linear colour with its
/// intensity folded in.
type EnvironmentSun = ([f32; 3], [f32; 3]);

pub(crate) struct FramePrep {
    plan: FramePlan,
    /// The sun as the environment sees it (direction, colour): the scene's own under the sky (the
    /// light outside the atmosphere; the frame's is what reaches the ground), the frame's
    /// otherwise.
    environment_sun: EnvironmentSun,
    uploads: Uploads,
    path: CullPath,
    clear: [u8; 4],
    groups: FrameGroups,
    /// The depth/normal prepass, when a consumer asks for it.
    prepass: Option<FramePrepass>,
    /// The meshlet path, when the frame draws clustered meshes through it (R2).
    meshlets: Option<FrameMeshlets>,
    /// The scene's camera (the screen effects' view and projection).
    camera: crate::scene::CameraDesc,
    /// The motion prepass's frame row and group 2, on frames writing motion (RQ5.6).
    motion: Option<FrameMotion>,
    /// The reactive coverage's group 2 over this frame's previous-model table (TAA frames).
    reactive_group: Option<BindGroup>,
}

/// One frame's motion prepass inputs: the frame row, the instance draws' group 2 and the meshlet
/// draws' group 3 (RQ5.6).
pub(crate) struct FrameMotion {
    row: GpuMotionFrame,
    group: BindGroup,
    meshlet_group: BindGroup,
}

/// What the renderer's nodes recorded, handed back to [`Renderer::end_frame`].
pub(crate) struct WorldDone {
    stats: FrameStats,
    world: Option<WorldPassInfo>,
    prepass: Option<PrepassInfo>,
}

/// The part-1 renderer's graph nodes for one frame (plan §2.2 nodes 1-22): the graph runs them for
/// [`Renderer::render_staged`], and `FrameRenderer` wraps them with its part-2 nodes. The
/// [`WorldStage`] is handed to each call, so a wrapper can keep it beside its own nodes.
pub(crate) struct WorldNodes<'a> {
    renderer: &'a Renderer,
    prep: &'a FramePrep,
    stats: FrameStats,
    world: Option<WorldPassInfo>,
    /// Whether the standalone weighted resolve ran this frame.
    resolved: bool,
    /// How the prepass ran this frame (graph node 7).
    prepass: Option<PrepassInfo>,
    /// The frame groups made again after graph node 11 replaced the environment the frame's own
    /// groups bind (a cold bake, a new cube size): the world pass then lights with the bake the
    /// frame just made, not with what was bound before it (RQ2.5).
    baked_groups: Option<FrameGroups>,
    /// TAA's resolve once graph node 17 ran: the history it wrote is the HDR scene the later nodes
    /// read (RQ5.6).
    taa: Option<TaaResolved>,
    /// Whether the resolve was copied into the 1x scene for `post-hdr` passes (which draw over the
    /// scene, never over TAA's history): the later nodes then read the scene.
    taa_copied: bool,
}

/// What graph node 17 resolved: the history slot it wrote (the view the later nodes read).
struct TaaResolved {
    view: TextureView,
    slot: usize,
}

/// A tonemap or bloom input's identity for their bind-group caches: the pool's generation, and
/// which of the scene or TAA's two history slots it is (the history ping-pongs every frame).
const fn input_generation(pool: u64, taa_slot: Option<usize>) -> u64 {
    let tag = match taa_slot {
        Some(slot) => 1 + slot as u64,
        None => 0,
    };
    pool.wrapping_mul(4).wrapping_add(tag)
}

/// The node that tonemaps: [`NodeId::Tonemap`] once the graph runs it, until then the upscale's
/// row (node 22, the next landed pass node after the nodes that read the HDR scene).
fn tonemap_node() -> NodeId {
    if NodeId::Tonemap.landed() { NodeId::Tonemap } else { NodeId::Upscale }
}

impl<'a> WorldNodes<'a> {
    /// The renderer the nodes draw with.
    pub(crate) fn renderer(&self) -> &'a Renderer {
        self.renderer
    }

    /// The resolved HDR scene for a node that reads it before the tonemap (auto exposure's
    /// histogram, `post-hdr` passes): on desktop MSAA the weighted resolve runs here, once a frame.
    /// None on the legacy path, or when the frame's targets hold no 1x scene (a reader announces
    /// itself with [`Renderer::set_hdr_scene_readers`] before the frame).
    pub(crate) fn resolved_hdr_scene(&mut self, frame: &mut FrameEncoder) -> Option<TextureView> {
        if let Some(taa) = self.taa.as_ref().filter(|_| !self.taa_copied) {
            return Some(taa.view.clone());
        }
        self.resolved_hdr_target(frame).map(|(_, view)| view.clone())
    }

    /// [`WorldNodes::resolved_hdr_scene`] with its texture: what `post-hdr` passes draw over
    /// (graph node 18).
    pub(crate) fn resolved_hdr_target(&mut self, frame: &mut FrameEncoder) -> Option<(&'a Texture, &'a TextureView)> {
        let renderer = self.renderer;
        if !renderer.path.hdr {
            return None;
        }
        if renderer.path.resolve_pass && !self.resolved {
            renderer.encode_hdr_resolve(frame.encoder());
            self.count_render(frame, 1);
            self.resolved = true;
        }
        let scene = renderer.targets.scene_texture.as_ref().zip(renderer.targets.scene_view.as_ref());
        // TAA's history is the resolved scene; a pass drawing over it would feed its own output
        // back into next frame's history, so it draws over a copy in the 1x scene.
        if let (Some(taa), Some((texture, _))) = (self.taa.as_ref().filter(|_| !self.taa_copied), scene)
            && renderer.copy_taa_history(frame.encoder(), taa.slot, texture)
        {
            self.taa_copied = true;
        }
        scene
    }

    /// The HDR scene the tonemap reads and its identity: TAA's resolve unless it was copied into
    /// the scene, else the scene (None: the renderer's own).
    fn tonemap_input(&self) -> (Option<TextureView>, u64) {
        let generation = self.renderer.pool.generation();
        match self.taa.as_ref().filter(|_| !self.taa_copied) {
            Some(taa) => (Some(taa.view.clone()), input_generation(generation, Some(taa.slot))),
            None => (None, input_generation(generation, None)),
        }
    }

    /// How this frame draws its scene colour.
    pub(crate) fn scene(&self) -> &'a ScenePath {
        &self.renderer.path
    }

    /// Graph node 21: the resolve (when its own pass) and the tonemap into the world target.
    fn encode_tonemap(&mut self, frame: &mut FrameEncoder) {
        if self.taa.is_none() {
            self.resolved_hdr_scene(frame);
        }
        let (input, generation) = self.tonemap_input();
        let passes = self.renderer.encode_tonemap(frame, input.as_ref(), generation);
        self.count_render(frame, passes);
    }

    /// Graph node 17: TAA resolves the jittered scene with the prepass's depth, motion and reactive
    /// mask into its history set's next slot.
    fn encode_taa(&mut self, frame: &mut FrameEncoder) {
        let renderer = self.renderer;
        let (Some(scene), Some(prepass)) = (renderer.targets.scene_view.as_ref(), renderer.targets.prepass.as_ref()) else { return };
        let mut histories = renderer.taa.borrow_mut();
        let Some(histories) = histories.as_mut() else { return };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let temporal = renderer.temporal;
        let Ok(node) = histories.node_on(&device, &queue, temporal.set) else { return };
        let input = TaaInput {
            scene,
            depth: &prepass.depth_view,
            motion: prepass.motion.as_ref().map(|(_, view)| view),
            reactive: prepass.reactive.as_ref().map(|(_, view)| view),
            render: renderer.targets.render_size,
            row: renderer.taa_row(),
        };
        let output = node.encode(&device, &queue, frame.encoder(), input);
        self.taa = Some(TaaResolved { view: output.view, slot: output.slot });
        self.count_render(frame, 1);
    }

    /// Graph node 15a: the transparent draws' and the stage's billboards' coverage into the
    /// reactive mask.
    fn encode_reactive(&mut self, frame: &mut FrameEncoder, stage: &dyn WorldStage) {
        if self.renderer.encode_reactive(frame, self.prep, stage) {
            self.count_render(frame, 1);
        }
    }

    /// Graph node 22 on the HDR scene: EASU and RCAS from the tonemapped intermediate into the
    /// world target.
    fn encode_fsr(&mut self, frame: &mut FrameEncoder) {
        let passes = self.renderer.encode_fsr(frame);
        self.count_render(frame, passes);
    }

    /// Whether node `id` runs this frame.
    pub(crate) fn enabled(&self, id: NodeId) -> bool {
        // The prepass's plan holds its switch already (`prepass::runs`), which the extension
        // ladder's demand overrides: inputs drive producers.
        let allowed = id == NodeId::Prepass || crate::graph::quality_allows(id, &self.renderer.quality);
        allowed && self.needed(id)
    }

    /// Whether the frame has work for node `id` (its consumers and the plan).
    fn needed(&self, id: NodeId) -> bool {
        let plan = &self.prep.plan;
        match id {
            NodeId::Tables | NodeId::BeforeCull | NodeId::Opaque | NodeId::AfterOpaque | NodeId::Transparent => true,
            NodeId::Skinning => !plan.skin_jobs.is_empty(),
            // A frame that bins nothing keeps the zero bin header Uploads wrote (renderer pass 2
            // A.4: reflection probes and irradiance volumes are binned in a frame with no light).
            NodeId::LightBinning => plan.binned.as_ref().is_some_and(bins_anything),
            NodeId::Prepass => self.prep.prepass.is_some(),
            NodeId::Ao => self.prepass_serves(PrepassConsumers::AO) && self.renderer.frame_ao().is_some(),
            NodeId::ContactShadows => self.prepass_serves(PrepassConsumers::CONTACT_SHADOWS) && plan.cascades.is_some(),
            NodeId::Occlusion => self.prep.meshlets.as_ref().is_some_and(|meshlets| meshlets.frame.occlusion),
            NodeId::Cull => self.prep.path == CullPath::Gpu && !plan.batches.is_empty(),
            NodeId::Shadows => plan.cascades.is_some() || !plan.spot_shadows.is_empty(),
            NodeId::Resolve => self.renderer.targets.msaa_view.is_some(),
            // The stage's billboards may need it too: the node checks its work as it encodes.
            NodeId::Reactive => self.taa_runs(),
            NodeId::Taa => self.taa_runs(),
            NodeId::Tonemap => self.renderer.path.hdr,
            NodeId::Environment => self.renderer.path.hdr && self.renderer.environment_choice.lights_scene(),
            NodeId::Sky => self.renderer.path.hdr && self.renderer.sky.borrow().draws_background(),
            // The legacy upscale below scale 1, or the tonemap's row until the graph runs node 21.
            NodeId::Upscale if self.renderer.path.hdr => tonemap_node() == NodeId::Upscale || self.renderer.path.fsr_runs(),
            NodeId::Upscale => self.renderer.targets.scene_view.is_some(),
            _ => false,
        }
    }

    /// Whether TAA resolves this frame: the scene path asks and the prepass drew its motion.
    fn taa_runs(&self) -> bool {
        let motion = self.renderer.targets.prepass.as_ref().is_some_and(|prepass| prepass.motion.is_some());
        self.renderer.path.taa && motion && self.prep.prepass.is_some()
    }

    /// Whether this frame's prepass runs for `consumer`.
    fn prepass_serves(&self, consumer: PrepassConsumers) -> bool {
        self.prep.prepass.as_ref().is_some_and(|prepass| prepass.consumers.contains(consumer))
    }

    /// Graph nodes 10 (AO) and 10a (contact shadows) on the prepass's targets; the world pass then
    /// binds what they wrote.
    fn encode_effect(&mut self, id: NodeId, frame: &mut FrameEncoder) {
        let renderer = self.renderer;
        let Some(views) = self.prepass_views() else { return };
        // Renderer pass 2, P2-0.6: AO finds its history along the prepass's motion when the
        // prepass wrote it this frame (TAA's frames), else through the camera.
        let motion = self.taa_runs().then(|| self.prepass_motion()).flatten();
        let effect = renderer.effect_frame(self.prep, &views, motion.as_ref());
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let mut effects = renderer.effects.borrow_mut();
        let passes = match id {
            NodeId::Ao => renderer.frame_ao().map_or(0, |settings| effects.encode_ao(&device, &queue, frame.encoder(), &effect, &settings)),
            _ => effects.encode_contact(&device, &queue, frame.encoder(), &effect, &renderer.look),
        };
        drop(effects);
        if passes > 0 {
            self.count_render(frame, passes);
            self.baked_groups = Some(renderer.current_groups());
        }
    }

    /// The per-batch counts of `view` on the CPU path (None on the GPU-driven path).
    fn counts(&self, view: usize) -> Option<&'a [u32]> {
        self.prep.uploads.cpu_culls.get(view).map(|cull| cull.counts.as_slice())
    }

    /// Record pass node `id` into `frame`.
    pub(crate) fn encode(&mut self, id: NodeId, frame: &mut FrameEncoder, stage: &mut dyn WorldStage) {
        let renderer = self.renderer;
        let plan = &self.prep.plan;
        match id {
            NodeId::Tables => {
                let fog = renderer.frame_fog();
                let background = renderer.draws_background().then(|| background_vertices(self.prep.clear));
                let mut rows: Vec<crate::tables::UploadWrite<'_>> = vec![(&renderer.fog_row, 0, bytemuck::bytes_of(&fog))];
                if let Some(vertices) = background.as_ref() {
                    rows.push((&renderer.background, 0, bytemuck::cast_slice(vertices)));
                }
                renderer.write_uploads(frame.encoder(), &self.prep.uploads, plan, &rows);
                renderer.write_meshlets(frame.queue(), self.prep);
                // The terrain's grass (A.8): generated for the camera before the shadows and the
                // prepass draw it.
                let grass = renderer.encode_grass(frame.encoder());
                if grass > 0 {
                    self.count_compute(frame, grass);
                }
                // The frame's first command buffer opens with the armed timer's begin pass.
                if let Some(timer) = renderer.timer.borrow_mut().as_mut() {
                    timer.encode_begin(frame.encoder());
                }
            }
            NodeId::BeforeCull => stage.before_cull(frame.encoder(), &renderer.world_pass()),
            NodeId::Skinning => {
                renderer.encode_skinning(frame.encoder(), plan);
                self.count_compute(frame, 1);
            }
            NodeId::LightBinning => {
                if renderer.encode_light_bins(frame, plan) {
                    self.count_compute(frame, 1);
                }
            }
            NodeId::Cull => {
                renderer.encode_cull(frame.encoder(), plan);
                self.count_compute(frame, 1);
                if let (Some(meshlets), Some(node)) = (&self.prep.meshlets, &renderer.meshlet_node) {
                    node.encode(frame.encoder(), &meshlets.frame, MeshletPass::First);
                    self.count_compute(frame, 1);
                }
            }
            NodeId::Occlusion => {
                if renderer.encode_occlusion(frame, self.prep) {
                    // The Hi-Z build and cull pass 2, then prepass part 2.
                    self.count_compute(frame, 2);
                    self.count_render(frame, 1);
                    self.stats.meshlet_draws += 1;
                }
            }
            NodeId::Prepass => {
                if let Some(prepass) = renderer.encode_prepass(frame, self.prep, self.counts(0)) {
                    self.prepass = Some(prepass);
                    self.count_render(frame, 1);
                }
            }
            NodeId::Ao | NodeId::ContactShadows => self.encode_effect(id, frame),
            NodeId::Shadows => {
                // A far cascade off its cadence keeps last frame's map: no pass.
                let mut drawn = 0;
                for cascade in (0..plan.cascades_drawn()).filter(|c| renderer.shadow_draws.draws(*c)) {
                    renderer.encode_shadow(frame.encoder(), self.prep, cascade, self.counts(1 + cascade), &mut self.stats);
                    drawn += 1;
                }
                // Every shadowed spot's tile of the atlas layer, in one pass.
                if !plan.spot_shadows.is_empty() {
                    let cascades = plan.cascades_drawn() as u32;
                    let counts: Vec<Option<&[u32]>> =
                        plan.spot_shadows.iter().map(|spot| self.counts(crate::spot_shadow::spot_view(cascades, spot.slot) as usize)).collect();
                    renderer.encode_spot_shadows(frame.encoder(), self.prep, &counts, &mut self.stats);
                    drawn += 1;
                }
                self.count_render(frame, drawn);
            }
            NodeId::Environment => {
                let environment = renderer.environment_frame(self.prep);
                let mut sky = renderer.sky.borrow_mut();
                let map = renderer.environment.borrow().map_view().map(|(view, version)| crate::sky::BackdropMap { view: view.clone(), version });
                let sky_passes = sky.encode(frame, &environment, map.as_ref());
                if let (Some(exposure), Some(background)) = (stage.pre_exposure_source(), sky.frame_uniform()) {
                    // After the background's frame uniform was written: auto exposure's value wins.
                    let bytes = size_of::<crate::post::exposure::GpuPreExposure>() as u64;
                    frame.encoder().copy_buffer_to_buffer(exposure, 0, background, crate::abi::GX_FRAME_V2_PRE_EXPOSURE_OFFSET, bytes);
                }
                let ibl_passes = renderer.environment.borrow_mut().encode(frame, &environment, &sky);
                drop(sky);
                self.count_passes(frame, sky_passes);
                self.count_passes(frame, ibl_passes);
                // Renderer pass 2 A.3: the reflection probes' captures, lit by the bake just made.
                let probe_passes = renderer.encode_probes(frame, self.prep);
                self.count_passes(frame, probe_passes);
                // Renderer pass 2 A.5: the froxel fog, after the aerial volume it folds in.
                let froxel_passes = renderer.encode_froxels(frame, self.prep);
                self.count_passes(frame, froxel_passes);
                // A new bake or this frame's aerial-perspective volume: the world pass binds them.
                self.baked_groups = Some(renderer.current_groups());
            }
            NodeId::Reactive => self.encode_reactive(frame, stage),
            NodeId::Taa => self.encode_taa(frame),
            NodeId::Upscale | NodeId::Tonemap if renderer.path.hdr => {
                if id == tonemap_node() {
                    self.encode_tonemap(frame);
                }
                if id == NodeId::Upscale && renderer.path.fsr_runs() {
                    self.encode_fsr(frame);
                }
            }
            NodeId::Upscale => {
                renderer.encode_upscale(frame.encoder());
                self.count_render(frame, 1);
            }
            _ => {}
        }
    }

    /// Count the passes a node's module opened.
    fn count_passes(&mut self, frame: &mut FrameEncoder, passes: PassCounters) {
        self.count_compute(frame, passes.compute);
        self.count_render(frame, passes.render);
    }

    fn count_compute(&mut self, frame: &mut FrameEncoder, n: u32) {
        frame.count_compute_passes(n);
        self.stats.compute_passes += n;
    }

    fn count_render(&mut self, frame: &mut FrameEncoder, n: u32) {
        frame.count_render_passes(n);
        self.stats.render_passes += n;
    }

    /// The stage's compute work ahead of the world pass (particles, custom-pass draws recorded).
    pub(crate) fn before_world(&mut self, frame: &mut FrameEncoder, stage: &mut dyn WorldStage) {
        stage.before_world(frame.encoder(), &self.renderer.world_pass());
    }

    /// The clear colour: the scene's sRGB bytes as the legacy target stores them, or on the HDR path
    /// as linear light times the pre-exposure.
    fn clear_color(&self) -> [f64; 3] {
        let [r, g, b, _] = self.prep.clear.map(|c| f64::from(c) / 255.0);
        let path = &self.renderer.path;
        if !path.hdr {
            return [r, g, b];
        }
        [r, g, b].map(|c| f64::from(exposed(c as f32, path.pre_exposure)))
    }

    /// Open the world pass hosting `rows`: load Clear, the MSAA colour resolved into the scene
    /// colour and discarded when [`NodeId::Resolve`] is among them, depth discarded (no node reads
    /// it after the pass).
    pub(crate) fn begin_world<'e>(&mut self, rows: &[NodeId], encoder: &'e mut wgpu::CommandEncoder) -> RenderPass<'e> {
        let targets = &self.renderer.targets;
        let path = self.renderer.path;
        let [r, g, b] = self.clear_color();
        let scene = targets.scene_view.as_ref().unwrap_or(&targets.world_view);
        // The desktop HDR path keeps the samples for the weighted resolve instead.
        let resolve = rows.contains(&NodeId::Resolve) && !targets.spec.msaa_read;
        let (view, resolve_target, color_store) = match &targets.msaa_view {
            Some(msaa) if resolve => (msaa, Some(scene), wgpu::StoreOp::Discard),
            Some(msaa) if targets.spec.msaa_read => (msaa, None, wgpu::StoreOp::Store),
            _ => (scene, None, wgpu::StoreOp::Store),
        };
        // The `Equal` world pass tests the prepass depth as it is and keeps it for its consumers.
        let equal = targets.spec.equal_depth;
        let keep = equal || targets.spec.depth_readback;
        let depth_store = if keep { wgpu::StoreOp::Store } else { wgpu::StoreOp::Discard };
        let depth_clear = if path.depth_reversed { 0.0 } else { 1.0 };
        let depth_load = if equal { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(depth_clear) };
        let passes = self.world.map_or(0, |world| world.passes) + 1;
        self.world = Some(WorldPassInfo {
            passes,
            samples: targets.samples,
            resolved: resolve_target.is_some(),
            color_store,
            depth_store,
            transient: targets.transient,
            size: targets.render_size,
        });
        self.stats.render_passes += 1;
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("world"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a: 1.0 }), store: color_store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations { load: depth_load, store: depth_store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_index_buffer(self.renderer.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        pass
    }

    /// The frame groups the world pass binds: the frame's own, or those made after graph node 11.
    fn world_groups(&self) -> &FrameGroups {
        self.baked_groups.as_ref().unwrap_or(&self.prep.groups)
    }

    /// Draw in-pass node `id` inside the open world pass.
    pub(crate) fn encode_in_pass(&mut self, id: NodeId, pass: &mut RenderPass<'_>, stage: &dyn WorldStage) {
        let renderer = self.renderer;
        let plan = &self.prep.plan;
        let groups = self.world_groups().clone();
        match id {
            NodeId::Opaque => {
                if renderer.draws_background() {
                    pass.set_pipeline(&renderer.scene_pipelines().background);
                    pass.set_bind_group(0, &groups.lines, &[]);
                    pass.set_vertex_buffer(0, renderer.background.slice(..));
                    pass.draw(0..3, 0..1);
                }
                if !plan.batches.is_empty() {
                    pass.set_pipeline(renderer.opaque_pipeline());
                    pass.set_bind_group(0, &groups.frame, &[]);
                    pass.set_bind_group(1, &groups.pass, &[0]);
                    let meshlets = self.prep.meshlets.as_ref().map(|meshlets| &meshlets.frame);
                    renderer.draw_batches(pass, plan, 0, self.counts(0), meshlets, &mut self.stats);
                    renderer.draw_world_variants(pass, &groups.pass, plan, self.counts(0), &mut self.stats);
                    if let Some(pipeline) = meshlets.and_then(|_| renderer.meshlet_opaque_pipeline())
                        && renderer.draw_meshlets(pass, &groups.frame, &groups.pass, 0, ArgsSlot::All, pipeline)
                    {
                        self.stats.meshlet_draws += 1;
                    }
                }
                // The terrain (A.7), after the opaque batches, then its grass (A.8).
                renderer.draw_terrain(pass, &groups.frame, &groups.pass);
                renderer.draw_grass(pass, &groups.frame, &groups.pass);
                if !plan.lines.is_empty() {
                    pass.set_pipeline(&renderer.scene_pipelines().lines);
                    pass.set_bind_group(0, &groups.lines, &[]);
                    pass.set_vertex_buffer(0, renderer.tables.lines.get().slice(..));
                    pass.draw(0..plan.lines.len() as u32, 0..1);
                }
            }
            NodeId::Sky => renderer.sky.borrow().draw_background(pass),
            NodeId::AfterOpaque => stage.opaque(pass, &renderer.world_pass()),
            NodeId::Transparent => {
                renderer.draw_transparent(pass, &groups, plan, &mut self.stats);
                stage.blended(pass, &renderer.world_pass());
            }
            // The resolve is the world pass's resolve target (`begin_world`): nothing to draw.
            _ => {}
        }
    }

    /// Whether the prepass runs this frame (graph node 9 runs exactly then: its custom stage gets
    /// the targets).
    pub(crate) fn prepass_runs(&self) -> bool {
        self.enabled(NodeId::Prepass)
    }

    /// The prepass's targets once it ran this frame (graph node 9 hands them to a custom stage).
    pub(crate) fn prepass_views(&self) -> Option<PrepassViews> {
        let targets = self.renderer.targets.prepass.as_ref().filter(|_| self.prepass.is_some())?;
        Some(PrepassViews { depth: targets.depth_view.clone(), normals: targets.normals_view.clone() })
    }

    /// The prepass's motion once it wrote motion this frame (RQ5.6: graph node 9 hands it to a
    /// custom stage's `prepass_motion`, v2 post passes bind it as `gx_motion`).
    pub(crate) fn prepass_motion(&self) -> Option<TextureView> {
        let targets = self.renderer.targets.prepass.as_ref().filter(|_| self.prepass.is_some())?;
        targets.motion.as_ref().map(|(_, view)| view.clone())
    }

    /// What the nodes recorded.
    pub(crate) fn finish(self) -> WorldDone {
        WorldDone { stats: self.stats, world: self.world, prepass: self.prepass }
    }
}

/// The part-1 nodes with the frame's [`WorldStage`]: what [`Renderer::render_staged`] runs.
struct Staged<'a, 's> {
    nodes: WorldNodes<'a>,
    stage: &'s mut dyn WorldStage,
}

impl FrameNodes for Staged<'_, '_> {
    fn enabled(&self, id: NodeId) -> bool {
        self.nodes.enabled(id)
    }

    fn encode(&mut self, id: NodeId, frame: &mut FrameEncoder) -> Result<(), RenderError> {
        self.nodes.encode(id, frame, &mut *self.stage);
        Ok(())
    }

    fn before_world(&mut self, _rows: &[NodeId], frame: &mut FrameEncoder) -> Result<(), RenderError> {
        self.nodes.before_world(frame, &mut *self.stage);
        Ok(())
    }

    fn begin_world<'e>(&mut self, rows: &[NodeId], encoder: &'e mut wgpu::CommandEncoder) -> RenderPass<'e> {
        self.nodes.begin_world(rows, encoder)
    }

    fn encode_in_pass(&mut self, id: NodeId, pass: &mut RenderPass<'_>) {
        self.nodes.encode_in_pass(id, pass, &*self.stage);
    }
}

/// The part-1 nodes with a custom stage's `post-hdr` passes at graph node 18 (on the HDR scene,
/// before exposure and the tonemap): [`crate::custom_pass::render_scene`]'s graph.
struct CustomStaged<'a, 's> {
    nodes: WorldNodes<'a>,
    stage: &'s mut dyn CustomStage,
}

impl FrameNodes for CustomStaged<'_, '_> {
    fn enabled(&self, id: NodeId) -> bool {
        match id {
            NodeId::PostHdr => self.nodes.scene().hdr && self.stage.runs(PassStage::PostHdr),
            // Node 9 hands the prepass's targets to the stage whenever the prepass runs (its
            // `post-hdr` and `post` passes bind them too), and runs its `after-prepass` passes.
            NodeId::AfterPrepass => self.nodes.prepass_runs(),
            _ => self.nodes.enabled(id),
        }
    }

    fn encode(&mut self, id: NodeId, frame: &mut FrameEncoder) -> Result<(), RenderError> {
        if id == NodeId::AfterPrepass {
            if let Some(views) = self.nodes.prepass_views() {
                if self.stage.runs(PassStage::AfterPrepass) {
                    // Level-3 passes submit their own encoders: the frame so far goes first.
                    frame.submit();
                }
                self.stage.after_prepass(&views);
            }
            return Ok(());
        }
        if id == NodeId::PostHdr {
            if let Some((texture, view)) = self.nodes.resolved_hdr_target(frame) {
                // Level-3 passes submit their own encoders: the frame so far goes first.
                frame.submit();
                self.stage.post_hdr(texture, view);
            }
            return Ok(());
        }
        self.nodes.encode(id, frame, &mut *self.stage);
        Ok(())
    }

    fn before_world(&mut self, _rows: &[NodeId], frame: &mut FrameEncoder) -> Result<(), RenderError> {
        self.nodes.before_world(frame, &mut *self.stage);
        Ok(())
    }

    fn begin_world<'e>(&mut self, rows: &[NodeId], encoder: &'e mut wgpu::CommandEncoder) -> RenderPass<'e> {
        self.nodes.begin_world(rows, encoder)
    }

    fn encode_in_pass(&mut self, id: NodeId, pass: &mut RenderPass<'_>) {
        self.nodes.encode_in_pass(id, pass, &*self.stage);
    }
}

/// A frame's stats before its nodes run: what the plan holds (logical draws are counted before
/// any culling).
fn frame_stats(plan: &FramePlan) -> FrameStats {
    FrameStats {
        logical_draws: plan.logical_draws,
        instances: plan.instances.len() as u32,
        batches: plan.batches.len() as u32,
        views: plan.views,
        skin_jobs: plan.skin_jobs.len() as u32,
        ..FrameStats::default()
    }
}

/// The bilinear upscale's pipeline, layout and clamped linear sampler.
fn upscale_pipeline(device: &Device) -> Result<Upscale, RenderError> {
    let module = shader(device, "upscale bilinear", crate::shaders::UPSCALE_BILINEAR)?;
    let filterable = wgpu::TextureSampleType::Float { filterable: true };
    let layout = bind_group_layout(
        device,
        "upscale",
        &[texture_entry(0, filterable, wgpu::TextureViewDimension::D2), sampler_entry(1, wgpu::SamplerBindingType::Filtering)],
    );
    let pipeline = render_pipeline(
        device,
        &PipelineSpec {
            label: "upscale",
            module: &module,
            vertex: "vs_upscale",
            fragment: Some("fs_upscale"),
            buffers: &[],
            topology: wgpu::PrimitiveTopology::TriangleList,
            depth: None,
            format: WORLD_FORMAT,
            blend: None,
            samples: 1,
            layout: &pipeline_layout(device, "upscale", &[&layout]),
        },
    );
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("upscale"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    Ok(Upscale { pipeline, layout, sampler, group: None })
}

impl Renderer {
    /// A renderer with a world target of `width` × `height` (each side clamped to 64..=4096) and
    /// the default options (4x MSAA where available).
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Result<Renderer, RenderError> {
        Renderer::with_options(gpu, width, height, RenderOptions::default())
    }

    /// A renderer with `options`.
    pub fn with_options(gpu: &Gpu, width: u32, height: u32, options: RenderOptions) -> Result<Renderer, RenderError> {
        let (width, height) = world_size(width, height);
        check_texture(width, height, 4)?;
        let device = gpu.device.clone();
        let samples = sample_count(&device, options);
        // Nothing clusters until a frame's quality draws meshlets ([`Renderer::set_meshlets`]).
        let library = MeshLibrary::with_meshlets(Meshlets::DEFAULT.with_enabled(false));
        let meshes = mesh_buffers(&device, &gpu.queue, &library)?;
        let layouts = layouts(&device);
        let casters = CasterDepth::for_features(device.features());
        let pipelines = pipelines(&device, &layouts, casters)?;
        let (shadow_sampler, point_sampler, texture_sampler) = samplers(&device);
        let uniform_buffer = |label, size| buffer(&device, label, size, BufferUsages::UNIFORM | BufferUsages::COPY_DST);
        let mut pool = TargetPool::with_policy(TargetPolicy::for_device(&device));
        let targets = pooled_targets(&mut pool, &device, (width, height), (width, height), samples, &TargetSpec::default())?;
        Ok(Renderer {
            samples,
            render_scale: 1.0,
            quality: Quality::off(),
            look: Look::default(),
            scene_format: SceneFormat::Ldr,
            ldr_reason: None,
            form: default_form_factor(),
            class: None,
            tile_memory: device.adapter_info().transient_saves_memory,
            resolve_override: None,
            frame_index: 0,
            depth_readback: false,
            hdr_readers: false,
            hdr_pipelines: None,
            prepass_demand: ExtensionDemand::default(),
            equal_depth_override: None,
            prepass_pipelines: None,
            prepass_rows: None,
            last_prepass: None,
            post: std::cell::RefCell::new(None),
            effects: std::cell::RefCell::new(effects::ScreenEffects::new(&device, &gpu.queue)?),
            fog_row: uniform_buffer("frame fog", size_of::<crate::fog::GpuFog>() as u64)?,
            fog_backdrop: crate::fog::FogBackdrop::Environment,
            refreshed_groups: std::cell::RefCell::new(Vec::new()),
            upload_arena: std::cell::RefCell::new(crate::tables::UploadArena::new(&device)),
            path: ScenePath::LEGACY,
            last_path: None,
            timer: std::cell::RefCell::new(None),
            pool,
            targets,
            groups: None,
            upscale: None,
            last_world: None,
            meshes,
            mesh_uploads: 0,
            cull: CullPass::new(&device)?,
            skinning: SkinPass::new(&device)?,
            window_present: crate::letterbox::present::WindowPresent::default(),
            frame_uniforms: uniform_buffer("frame", size_of::<GpuFrame>() as u64)?,
            background: buffer(&device, "background", (3 * size_of::<LineVertex>()) as u64, BufferUsages::VERTEX | BufferUsages::COPY_DST)?,
            cull_views: uniform_buffer("cull views", size_of::<GpuCullViews>() as u64)?,
            tables: Tables::new(),
            casters,
            shadow_maps: ShadowMaps::new(&device),
            shadow_desc: ShadowMapDesc::PLACEHOLDER,
            shadow_history: CascadeHistory::default(),
            spot_slots: crate::spot_shadow::SpotSlots::default(),
            shadow_draws: CascadeDraws::default(),
            spot_shadow: None,
            variants: variants::VariantPipelines::default(),
            terrain: None,
            terrain_pipelines: terrain_draw::TerrainPipelines::default(),
            grass: None,
            grass_pipelines: grass_draw::GrassPipelines::default(),
            grass_time: grass_draw::GrassTime::default(),
            lens: std::cell::RefCell::default(),
            shadow_sampler,
            point_sampler,
            texture_sampler,
            texture_anisotropy: 1,
            textures: ClassArrays::new(&device, TEXTURE_DEFAULT_CLASS, crate::settings::TextureQuality::OFF),
            textures_fixed: false,
            texture_family: crate::texture::TextureFamily::Rgba8,
            environment_choice: Environment::Color,
            environment: std::cell::RefCell::new(EnvironmentMaps::new(&device, &gpu.queue)),
            sky: std::cell::RefCell::new(SkyState::new()),
            environment_settle: false,
            stats: FrameStats::default(),
            last: LastFrame::default(),
            last_cpu: None,
            meshlet_node: None,
            light_bins: std::cell::RefCell::new(None),
            spot_atlas: false,
            scene_pipeline_builds: std::cell::Cell::new(0),
            meshlet_pipelines: None,
            hiz: std::cell::RefCell::new(None),
            hiz_pyramid: None,
            last_meshlets: None,
            retained_held: std::cell::RefCell::new(None),
            last_instance_bytes: std::cell::Cell::new(0),
            history_set: HistorySet::Live,
            temporal_kept: false,
            temporal: FrameTemporal::NONE,
            motion_history: [MotionHistory::new(), MotionHistory::new()],
            motion_node: None,
            skinned_prev: SkinnedPrevious::default(),
            taa: std::cell::RefCell::new(None),
            reactive: None,
            fsr: std::cell::RefCell::new(None),
            temporal_last: [None, None],
            motion_row: None,
            taa_reproject: crate::post::taa::IDENTITY,
            transparent_coverage: crate::post::taa::ReactiveCoverage { cap: crate::post::taa::TRANSPARENT_COVERAGE, by_motion: false },
            library,
            meshlet_game: Meshlets::DEFAULT,
            meshlet_upload_pending: false,
            queue: gpu.queue.clone(),
            layouts,
            pipelines,
            device,
            width,
            height,
            logical: (width, height),
        })
    }

    /// The world target's size: the output the next frame draws (Live at the window's pixels, a
    /// capture at the world size or the size it asked for; [`Renderer::set_output_size`]).
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// The game's logical world size, the size the renderer was made at: the immediate 2D layer's
    /// coordinates and the default output (renderer pass 2, P2-0.9 step B).
    pub fn logical_size(&self) -> (u32, u32) {
        self.logical
    }

    /// Draw the next frames at `size` (each side clamped to 64..=4096, as the world target's):
    /// the world target, the render size the scale steps from, and the ledger follow at the next
    /// frame; the logical size and everything drawn in it (the 2D layer) stay. Live sets the
    /// window's pixels, a capture the world size or the size asked for. Refused, keeping the
    /// output, when the target would break the texture limits.
    pub fn set_output_size(&mut self, size: (u32, u32)) -> Result<(), RenderError> {
        let (width, height) = world_size(size.0, size.1);
        check_texture(width, height, 4)?;
        self.width = width;
        self.height = height;
        Ok(())
    }

    /// Draw the scene at `scale` of the output size from the next frame on (clamped to
    /// 0.5..=1): below 1 the world pass draws into targets of exactly the scaled size and a
    /// bilinear pass upscales them into the world target. A dynamic-resolution controller passes
    /// its discrete steps; captures keep the output size.
    pub fn set_render_scale(&mut self, scale: f32) {
        self.render_scale = scale;
    }

    /// Draw with `quality` from the next frame on: a node whose feature switch is off never runs,
    /// and sun shadows switched off are planned out of the frame. The sample count is fixed when
    /// the renderer is built ([`landed_samples`] says what a quality asks of it). `Quality::off()`
    /// (the default) is the legacy renderer.
    pub fn set_quality(&mut self, quality: &Quality) {
        self.quality = *quality;
        self.follow_meshlet_setting();
        let anisotropy = u16::from(quality.anisotropy).clamp(1, MAX_ANISOTROPY);
        if anisotropy != self.texture_anisotropy {
            // A resource knob (P2-0.12 LG-02): a new sampler, and the frame groups that bind it.
            self.texture_sampler = texture_sampler(&self.device, anisotropy);
            self.texture_anisotropy = anisotropy;
        }
    }

    /// The quality frames draw with.
    pub fn quality(&self) -> &Quality {
        &self.quality
    }

    /// Draw with the game's `look` from the next frame on: the tonemapper and the exposure the HDR
    /// path applies (the legacy path ignores it).
    pub fn set_look(&mut self, look: Look) {
        self.look = look;
    }

    /// Light the scene by the game's `environment` from the next frame on (RQ2): the flat colour
    /// (the default: the legacy picture), the physical sky or an HDR map. Where the quality turns
    /// IBL and the sky on, the HDR path bakes it (graph node 11) and draws it behind the scene
    /// (node 13); elsewhere the frame keeps the flat ambient term. An [`Environment::Hdri`] also
    /// needs its decoded map ([`Renderer::set_environment_map`]).
    pub fn set_environment(&mut self, environment: &Environment) {
        self.environment.get_mut().set_environment(environment);
        self.sky.get_mut().set_environment(environment);
        self.environment_choice = environment.clone();
    }

    /// The game's environment.
    pub fn environment(&self) -> &Environment {
        &self.environment_choice
    }

    /// The environment the frame's own forward pass binds now (graph node 11's bake once it ran,
    /// else the neutral inputs), as Level-2 and Level-3 v2 sources bind it (RQ2.5): the frame
    /// renderer hands it to them after node 11, so `gx_shade_pbr` lights with the same cube, SH
    /// and LUT as a built-in surface.
    pub fn environment_views(&self) -> Option<crate::extension::EnvironmentViews> {
        crate::extension::EnvironmentViews::of(&self.environment.borrow())
    }

    /// Bake an [`Environment::Hdri`] from its decoded map (the facade reads and decodes the file):
    /// prepared for this device first ([`Renderer::environment_map_width`]).
    pub fn set_environment_map(&mut self, gpu: &Gpu, map: &HdriImage) -> Result<(), RenderError> {
        let prepared = crate::hdri::prepare_map(map, self.environment_map_width());
        self.set_prepared_environment_map(gpu, &prepared)
    }

    /// Bake an [`Environment::Hdri`] from a map already prepared for this device
    /// ([`crate::hdri::prepare_map`] at [`Renderer::environment_map_width`]; the facade keeps that
    /// copy, not the decoded file).
    pub fn set_prepared_environment_map(&mut self, gpu: &Gpu, prepared: &PreparedMap) -> Result<(), RenderError> {
        self.environment.get_mut().set_prepared_map(&gpu.device, &gpu.queue, prepared)
    }

    /// The widest HDR map this device keeps (its class's, `presets::hdri_map_width`; the format's
    /// cap before the class is known).
    pub fn environment_map_width(&self) -> u32 {
        self.class.map_or(crate::hdri::HDRI_MAX_WIDTH, crate::presets::hdri_map_width)
    }

    /// Whether an HDR map is uploaded (released when the environment stops being one, so a game
    /// switching back uploads it again).
    pub fn holds_environment_map(&self) -> bool {
        self.environment.borrow().holds_map()
    }

    /// Bake the environment whole on each frame while `settle` (a settled capture's re-renders,
    /// whose history is the capture's own) instead of the time-sliced step that is due.
    pub fn set_environment_settle(&mut self, settle: bool) {
        self.environment_settle = settle;
    }

    /// What graph nodes 11 and 13 know about the frame `prep` draws.
    fn environment_frame<'a>(&'a self, prep: &'a FramePrep) -> EnvironmentFrame<'a> {
        let frame = &prep.plan.frame;
        let xyz = |v: [f32; 4]| [v[0], v[1], v[2]];
        EnvironmentFrame {
            device: &self.device,
            environment: &self.environment_choice,
            quality: &self.quality.environment,
            frame_index: self.frame_index,
            settle: self.environment_settle,
            sun_dir: prep.environment_sun.0,
            sun_color: prep.environment_sun.1,
            camera_pos: xyz(frame.camera_pos),
            view_proj: frame.view_proj,
            pre_exposure: self.path.pre_exposure,
            scene_format: self.path.format,
            samples: self.targets.samples,
            depth_reversed: self.path.depth_reversed,
            fog: self.frame_fog(),
            aerial: crate::fog::LANDED && crate::fog::aerial_perspective(&self.look.fog, &self.quality),
        }
    }

    /// The fog frames draw with: the look's under the quality's `fog` switch (none before fog
    /// lands, and none at the default look's density 0), in front of the last planned frame's
    /// backdrop ([`crate::fog::gpu_fog_over`]).
    pub fn frame_fog(&self) -> crate::fog::GpuFog {
        self.fog_over(self.fog_backdrop)
    }

    /// The fog row a frame of `scene` (its [`Renderer::next_scene`]) cleared to `clear` draws with,
    /// before its plan is built: what its Level-2 v2 sources read, so they fog with the frame's own
    /// backdrop, never the last frame's (pass-1 fix: a renderer's first frame under the sky handed
    /// a v2 material the flat backdrop's fog, and a settled capture moved by one level).
    pub fn frame_fog_for(&self, scene: &ScenePath, clear: [u8; 4]) -> crate::fog::GpuFog {
        self.fog_over(self.fog_backdrop_for(scene, clear))
    }

    fn fog_over(&self, backdrop: crate::fog::FogBackdrop) -> crate::fog::GpuFog {
        if crate::fog::LANDED { crate::fog::gpu_fog_over(&self.look.fog, &self.quality, backdrop) } else { crate::fog::GpuFog::default() }
    }

    /// Whether the environment replaces the flat ambient term on the HDR scene: once its bake and
    /// shading land, and only while the quality bakes it (IBL switched off keeps the flat term: no
    /// bake runs, so the neutral inputs would light nothing).
    fn environment_lights(&self) -> bool {
        self.quality.environment.ibl && self.environment.borrow().replaces_ambient()
    }

    /// What the fog scatters in front of on a frame of `scene` cleared to `clear`: the environment
    /// when it lights the frame, else the flat clear colour (the legacy LDR scene's too).
    fn fog_backdrop_for(&self, scene: &ScenePath, clear: [u8; 4]) -> crate::fog::FogBackdrop {
        if scene.hdr && self.environment_lights() { crate::fog::FogBackdrop::Environment } else { crate::fog::FogBackdrop::Flat(clear) }
    }

    /// The AO frames draw with: the look's radius and intensity at the quality's sampling (None:
    /// AO off, or not landed).
    fn frame_ao(&self) -> Option<crate::post::ao::AoSettings> {
        crate::post::ao::AoSettings::new(&self.look, &self.quality.ao).filter(|_| crate::post::ao::LANDED)
    }

    /// The bloom the frame's tonemap draws: the look's with the quality's chain on the HDR scene
    /// (None: the tonemap binds its neutral black input).
    fn frame_bloom(&self) -> Option<crate::post::bloom::BloomSettings> {
        let drawn = crate::post::bloom::LANDED && self.path.hdr;
        crate::post::bloom::BloomSettings::new(&self.look, &self.quality.bloom).filter(|_| drawn)
    }

    /// Hand the frame's bloom and the look's grading to the tonemap (the bloom chain's pipelines
    /// and the graded tonemap pipelines are made here, never mid-pass; A.2).
    fn prepare_bloom(&mut self) -> Result<(), RenderError> {
        let bloom = self.frame_bloom();
        let class = self.class.unwrap_or(DeviceClass::new(self.form, crate::device_class::PerformanceTier::High));
        match self.post.get_mut() {
            Some((tonemap, _)) => {
                tonemap.set_grading(&self.device, &self.queue, &self.look.grading, class);
                tonemap.set_bloom(&self.device, bloom)
            }
            None => Ok(()),
        }
    }

    /// What graph nodes 10 and 10a read about the frame `prep` draws over the prepass's `views`.
    fn effect_frame<'v>(&'v self, prep: &FramePrep, views: &'v PrepassViews, motion: Option<&'v TextureView>) -> effects::EffectFrame<'v> {
        let camera = &prep.camera;
        let (eye, target, up) = (glam::Vec3::from(camera.eye), glam::Vec3::from(camera.target), glam::Vec3::from(camera.up));
        let view = glam::camera::rh::view::look_at_mat4(eye, target, up);
        // The projection the depth was drawn with (reversed on the HDR path), from the frame's own.
        let proj = glam::Mat4::from_cols_array(&prep.plan.frame.view_proj) * view.inverse();
        let [x, y, z, _] = prep.plan.frame.sun_dir;
        effects::EffectFrame {
            depth: &views.depth,
            normals: &views.normals,
            motion,
            render: self.targets.render_size,
            view,
            proj,
            sun_dir: [x, y, z],
            frame_index: self.frame_index,
            depth_reversed: self.path.depth_reversed,
            taa: self.path.taa,
            generation: self.pool.generation(),
            frame_uniforms: &self.frame_uniforms,
            shadow_map: &self.shadow_maps.array,
            shadow_sampler: &self.shadow_sampler,
            point_sampler: &self.point_sampler,
        }
    }

    /// Whether the GPU keeps attachments in tile memory: the adapter's answer, else the form
    /// factor's ([`crate::prepass::tile_gpu`]; the web never answers).
    fn tile_gpu(&self) -> bool {
        crate::prepass::tile_gpu(self.tile_memory, self.form)
    }

    /// Ambient occlusion's history starts over at the next frame that draws AO (a settled
    /// capture's first re-render, a camera cut, a teleport).
    pub fn reset_ao_history(&mut self) {
        self.effects.get_mut().reset_ao_history();
    }

    /// A settled capture begins (RQ5 review): Live's AO history is put aside, so the capture's
    /// re-renders draw on AO's targets without becoming Live's history.
    pub fn begin_capture_history(&mut self) {
        self.effects.get_mut().stash_live_ao(&self.device, &self.queue);
    }

    /// The capture is over: Live's next frame takes its AO history back and redraws every shadow
    /// cascade (the capture's camera drew the maps a far cascade's cadence would have kept).
    pub fn end_capture_history(&mut self) {
        self.effects.get_mut().restore_live_ao();
        self.shadow_history.reset();
    }

    /// The game's look.
    pub fn look(&self) -> &Look {
        &self.look
    }

    /// The session's scene format (a pipeline-shaping fact, chosen once per device class: plan
    /// principle 8). `Ldr`, the default, keeps every frame on the legacy path whatever the quality
    /// asks; an HDR format lets frames whose quality has `hdr` on draw the HDR path.
    /// `Rg11b10Ufloat` falls back to `rgba16float` where the device cannot render it. The owner of
    /// in-world pipelines (custom materials, particles, Level-3 passes) rebuilds them against
    /// [`WorldPass::scene_format`] before setting it.
    pub fn set_scene_format(&mut self, format: SceneFormat) {
        self.scene_format = format;
    }

    /// The scene colour's format frames with HDR on draw into on this device (the world format
    /// while the session's scene format is `Ldr`; `rgba16float` under TAA, whose history is, so a
    /// resolve copies into the scene for `post-hdr` passes).
    pub fn hdr_scene_format(&self) -> TextureFormat {
        if !self.scene_format.is_hdr() {
            return WORLD_FORMAT;
        }
        if self.quality.hdr && self.taa_drawn() { TextureFormat::Rgba16Float } else { self.hdr_format() }
    }

    /// Keep frames that ask for HDR on the legacy path for `reason` (a v1 in-world pass or v1
    /// material: their pipelines target the world format with standard Z), or let them draw HDR
    /// again (None). Reported in [`Renderer::last_scene`].
    pub fn set_ldr_reason(&mut self, reason: Option<LdrReason>) {
        self.ldr_reason = reason;
    }

    /// The device's form factor, from the device class: on the HDR path mobile classes and tile
    /// GPUs resolve MSAA in the world pass, other desktop GPUs with the luminance-weighted resolve
    /// ([`MsaaResolve::for_device`]). Defaults to mobile on iOS and Android builds and desktop
    /// elsewhere.
    pub fn set_form_factor(&mut self, form: FormFactor) {
        self.form = form;
        self.class = None;
    }

    /// The device's class: its form factor, and with the tier the MSAA resolve on the HDR path
    /// ([`MsaaResolve::for_class`]: a high or ultra desktop tile GPU resolves weighted too).
    pub fn set_device_class(&mut self, class: DeviceClass) {
        self.form = class.form;
        self.class = Some(class);
    }

    /// Force the HDR path's MSAA resolve (None: by device). Diagnostics and tests: the weighted
    /// resolve on a tile GPU stores every sample to memory.
    pub fn set_msaa_resolve(&mut self, resolve: Option<MsaaResolve>) {
        self.resolve_override = resolve;
    }

    /// The frame index the next frame's dither, TAA jitter and noise are keyed to (rendered sim
    /// ticks since the history's reset; a settled capture's re-render index). A frame at index 0
    /// starts its history set's TAA and motion history over.
    pub fn set_frame_index(&mut self, index: u64) {
        self.frame_index = index;
    }

    /// The history set the next frames draw on (RQ5.6): Live's, or a settled capture's own, so a
    /// capture's TAA and motion history never reads or moves Live's (AO's is put aside and taken
    /// back, [`Renderer::begin_capture_history`]). Last frame's skinned vertices are one buffer: the
    /// Live frame after a capture draws its skinned rows without motion, once. Live by default.
    pub fn set_history_set(&mut self, set: HistorySet) {
        self.history_set = set;
    }

    /// Start history set `set`'s temporal state over for `reason` (TAA's history, the motion rows,
    /// last frame's jitter and skinned vertices): the next frame drawn on it has none.
    pub fn reset_temporal_history(&mut self, set: HistorySet, reason: HistoryReset) {
        // A dynamic-resolution step keeps all of it (TAA reprojects across sizes in uv).
        if !crate::post::taa::resets_history(reason) {
            return;
        }
        if let Some(histories) = self.taa.get_mut().as_mut() {
            histories.reset_set(set);
        }
        self.motion_history[set_index(set)].reset();
        self.temporal_last[set_index(set)] = None;
        if self.skinned_prev.written.is_some_and(|(written, _)| written == set) {
            self.skinned_prev.written = None;
        }
    }

    /// Whether this frame's index of 0 keeps TAA's and the motion history: its history set started
    /// over for a reason they ride through (a dynamic-resolution step), so the frame neither
    /// resets them nor takes its current sample whole. False (the default) keeps the rule that a
    /// frame index of 0 starts them over.
    pub fn set_temporal_kept(&mut self, kept: bool) {
        self.temporal_kept = kept;
    }

    /// Drop a capture's TAA history pair (its bytes go back to the budget; the next capture makes
    /// it again): what a class whose budget cannot hold a second pair does after each capture.
    pub fn release_capture_history(&mut self) {
        if let Some(histories) = self.taa.get_mut().as_mut() {
            histories.release_capture();
        }
        self.motion_history[set_index(HistorySet::Capture)].reset();
        self.temporal_last[set_index(HistorySet::Capture)] = None;
    }

    /// Whether this device's budget holds no second TAA history pair between captures: phones, the
    /// low tier and every class in a browser (whose budget is at most 256 MB, 128 MB when the
    /// browser hides `deviceMemory`) release a capture's after it
    /// ([`Renderer::release_capture_history`]).
    pub fn tight_budget(&self) -> bool {
        let class = self.class.unwrap_or(DeviceClass::new(self.form, crate::device_class::PerformanceTier::High));
        let browser = crate::device_class::TargetOs::current() == crate::device_class::TargetOs::Web;
        browser || class.form == FormFactor::Mobile || class.tier == crate::device_class::PerformanceTier::Low
    }

    /// Bytes the temporal history holds beside the pooled targets: TAA's history pairs and last
    /// frame's skinned vertices (the budget ledger's TAA row).
    pub fn temporal_bytes(&self) -> u64 {
        let taa = self.taa.borrow().as_ref().map_or(0, TaaHistories::history_bytes);
        taa + self.skinned_prev.buffer.as_ref().map_or(0, Buffer::size) + self.effects.borrow().ao_stash_bytes()
    }

    /// Whether something reads the resolved HDR scene before the tonemap (`post-hdr` passes): on
    /// desktop MSAA the weighted resolve then runs as its own pass instead of inside the tonemap.
    pub fn set_hdr_scene_readers(&mut self, readers: bool) {
        self.hdr_readers = readers;
    }

    /// Keep the world pass's depth for [`Renderer::read_depth`] from the next frame on (it is
    /// discarded otherwise, and transient where that saves memory): tests and diagnostics.
    pub fn set_depth_readback(&mut self, keep: bool) {
        self.depth_readback = keep;
    }

    /// What the extension ladder asks of the depth/normal prepass from the next frame on: the
    /// inputs running Level-3 v2 passes declare, whether one runs at `after-prepass`, and the inputs
    /// the Level-2 v2 sources in use bind (plan principle 3: inputs drive producers). The prepass
    /// runs when the quality's `prepass` switch allows it and this or a landed feature asks.
    pub fn set_prepass_demand(&mut self, demand: ExtensionDemand) {
        self.prepass_demand = demand;
    }

    /// Force the world pass's `Equal` reuse of the prepass depth on or off (None: by device, on
    /// immediate-mode GPUs only). Tests and diagnostics; never with MSAA, never with custom
    /// geometry in the prepass.
    pub fn set_equal_depth_reuse(&mut self, reuse: Option<bool>) {
        self.equal_depth_override = reuse;
    }

    /// How the last frame's depth/normal prepass ran (None: it did not run).
    pub fn last_prepass(&self) -> Option<PrepassInfo> {
        self.last_prepass
    }

    /// The last frame's prepass depth, top row first (as [`Renderer::read_depth`]). Refused unless
    /// the prepass ran with [`Renderer::set_depth_readback`] on.
    pub fn read_prepass_depth(&self, gpu: &Gpu) -> Result<Vec<f32>, RenderError> {
        let targets = self.kept_prepass()?;
        let rows = self.read_texture(gpu, &targets.depth_texture, 4, wgpu::TextureAspect::DepthOnly)?;
        Ok(rows.as_chunks::<4>().0.iter().map(|bytes| f32::from_le_bytes(*bytes)).collect())
    }

    /// The last frame's prepass normals, top row first: octahedral pairs (`prepass::oct_decode`
    /// turns one into a world-space unit normal; 0, 0 where nothing was drawn). Refused as
    /// [`Renderer::read_prepass_depth`].
    pub fn read_prepass_normals(&self, gpu: &Gpu) -> Result<Vec<[f32; 2]>, RenderError> {
        let targets = self.kept_prepass()?;
        let rows = self.read_texture(gpu, &targets.normals_texture, 4, wgpu::TextureAspect::All)?;
        let half = |bytes: [u8; 2]| f16_to_f32(u16::from_le_bytes(bytes));
        Ok(rows.as_chunks::<4>().0.iter().map(|texel| [half([texel[0], texel[1]]), half([texel[2], texel[3]])]).collect())
    }

    /// The last frame's motion, top row first: NDC current minus previous, the jitter removed
    /// (RQ5.6; 0, 0 where nothing was drawn). Refused as [`Renderer::read_prepass_depth`], and
    /// when the frame wrote no motion.
    pub fn read_motion(&self, gpu: &Gpu) -> Result<Vec<[f32; 2]>, RenderError> {
        let targets = self.kept_prepass()?;
        let Some((texture, _)) = targets.motion.as_ref() else {
            return Err(crate::readback::capture_failed("the last frame wrote no motion"));
        };
        let rows = self.read_texture(gpu, texture, 4, wgpu::TextureAspect::All)?;
        let half = |bytes: [u8; 2]| f16_to_f32(u16::from_le_bytes(bytes));
        Ok(rows.as_chunks::<4>().0.iter().map(|texel| [half([texel[0], texel[1]]), half([texel[2], texel[3]])]).collect())
    }

    /// The last frame's TAA reactive mask, top row first (0: history kept, 1: the current sample;
    /// renderer pass 2, B.7). Refused as [`Renderer::read_motion`].
    pub fn read_reactive(&self, gpu: &Gpu) -> Result<Vec<f32>, RenderError> {
        let targets = self.kept_prepass()?;
        let Some((texture, _)) = targets.reactive.as_ref() else {
            return Err(crate::readback::capture_failed("the last frame wrote no reactive mask"));
        };
        let rows = self.read_texture(gpu, texture, 1, wgpu::TextureAspect::All)?;
        Ok(rows.iter().map(|texel| f32::from(*texel) / 255.0).collect())
    }

    /// The last frame's prepass targets, when they were kept for a readback.
    fn kept_prepass(&self) -> Result<&PrepassTargets, RenderError> {
        let kept = self.targets.prepass.as_ref().filter(|_| self.last_prepass.is_some() && self.targets.spec.depth_readback);
        kept.ok_or_else(|| crate::readback::capture_failed("the prepass targets are kept only for a frame that ran it with set_depth_readback"))
    }

    /// How the last frame drew its scene colour (None before the first frame).
    pub fn last_scene(&self) -> Option<ScenePath> {
        self.last_path
    }

    /// The last frame's depth, top row first: `Depth32Float` values, 1 for the far plane with
    /// standard Z and 0 with reverse-Z. Refused unless [`Renderer::set_depth_readback`] was on for
    /// that frame and it was single-sampled (a multisampled texture cannot be copied out).
    pub fn read_depth(&self, gpu: &Gpu) -> Result<Vec<f32>, RenderError> {
        if !self.targets.spec.depth_readback || self.targets.samples > 1 {
            return Err(crate::readback::capture_failed("the depth is kept only for a single-sampled frame with set_depth_readback"));
        }
        let rows = self.read_texture(gpu, &self.targets.depth_texture, 4, wgpu::TextureAspect::DepthOnly)?;
        Ok(rows.as_chunks::<4>().0.iter().map(|bytes| f32::from_le_bytes(*bytes)).collect())
    }

    /// How the next frame draws its scene when a world stage gives `stage_reason` to stay LDR (a v1
    /// material or in-world pass): the facts in-world pipelines are built against before it.
    pub fn next_scene(&self, stage_reason: Option<LdrReason>) -> ScenePath {
        self.scene_path(self.render_size(), stage_reason)
    }

    /// The last frame's resolved HDR scene, top row first: linear, pre-exposed rgba (an `rgba16float`
    /// scene). Refused on the legacy path, or when the frame held no 1x scene (desktop MSAA with
    /// the resolve fused into the tonemap).
    pub fn read_scene(&self, gpu: &Gpu) -> Result<Vec<[f32; 4]>, RenderError> {
        let texture = self.targets.scene_texture.as_ref().filter(|_| self.path.hdr && self.path.format == TextureFormat::Rgba16Float);
        let Some(texture) = texture else {
            return Err(crate::readback::capture_failed("no rgba16float HDR scene was kept by the last frame"));
        };
        let rows = self.read_texture(gpu, texture, 8, wgpu::TextureAspect::All)?;
        let halves: Vec<f32> = rows.as_chunks::<2>().0.iter().map(|bytes| f16_to_f32(u16::from_le_bytes(*bytes))).collect();
        Ok(halves.as_chunks::<4>().0.to_vec())
    }

    /// The tight rows of a render-size texture of `texel` bytes, read back.
    fn read_texture(&self, gpu: &Gpu, texture: &Texture, texel: u32, aspect: wgpu::TextureAspect) -> Result<Vec<u8>, RenderError> {
        let (width, height) = self.targets.render_size;
        let tight = width * texel;
        let padded = tight.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let bytes = u64::from(padded) * u64::from(height);
        let staging = buffer(&gpu.device, "readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let data = map_read_blocking(gpu, &staging, bytes)?;
        Ok(data.chunks(padded as usize).flat_map(|row| row[..tight as usize].to_vec()).collect())
    }

    /// Time the next frame on the GPU (Live frames only; a capture is never timed): opens the
    /// [`live_timing::FrameTimer`] on first use and answers the GPU times of earlier frames that
    /// landed since, in milliseconds, oldest first. None when the device has no timestamp queries.
    pub fn arm_frame_timer(&mut self, queue: &Queue) -> Option<Vec<f32>> {
        let mut slot = self.timer.borrow_mut();
        if slot.is_none() {
            *slot = live_timing::FrameTimer::new(&self.device, queue);
        }
        Some(slot.as_mut()?.arm())
    }

    /// Close the armed frame's timing: its end pass (after everything the frame drew into the
    /// world target), the resolve of earlier frames and their readback. Nothing when not armed.
    pub fn finish_frame_timer(&mut self) {
        let mut slot = self.timer.borrow_mut();
        if let Some(timer) = slot.as_mut() {
            timer.finish(&self.targets.world_view);
        }
    }

    /// The size the scene is drawn at: the output size scaled by the render scale.
    pub fn render_size(&self) -> (u32, u32) {
        scaled_size((self.width, self.height), self.render_scale)
    }

    /// The render-target pool (its targets and their ledger entries).
    pub fn targets(&self) -> &TargetPool {
        &self.pool
    }

    /// How the last frame's world pass was set up (None before the first frame).
    pub fn last_world_pass(&self) -> Option<WorldPassInfo> {
        self.last_world
    }

    /// Samples per pixel of the world pass (4 with MSAA, else 1).
    pub fn sample_count(&self) -> u32 {
        self.samples
    }

    /// The features the renderer's device was opened with (the renderer-owned optional ones
    /// included, e.g. `RG11B10UFLOAT_RENDERABLE` for the compact scene format).
    pub fn device_features(&self) -> wgpu::Features {
        self.device.features()
    }

    /// Add a mesh (a loaded GLB) and upload the library again.
    pub fn add_mesh(&mut self, gpu: &Gpu, mesh: MeshData) -> Result<MeshId, RenderError> {
        let ids = self.add_meshes(gpu, vec![mesh])?;
        ids.first().copied().ok_or_else(|| RenderError::refused(crate::error::RenderCode::MeshInvalid, "no mesh was added"))
    }

    /// Add `meshes` (every part of one model) and upload the library again once: one full copy of
    /// the library however many parts the model has. A refused mesh adds none of them.
    pub fn add_meshes(&mut self, gpu: &Gpu, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        self.add_meshes_with_meshlets(gpu, meshes.into_iter().map(|mesh| (mesh, None)).collect())
    }

    /// [`Renderer::add_meshes`] with the meshlets each part brought (a GLB part's
    /// `genex_meshlets`, [`crate::mesh::GlbPart::meshlets`]): a clustered part uses its set when
    /// it passes [`crate::meshlet::validate`], else the runtime clusterizer's
    /// ([`MeshLibrary::add_with_meshlets`]).
    pub fn add_meshes_with_meshlets(&mut self, gpu: &Gpu, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        self.add_model_parts(gpu, parts.into_iter().map(|(mesh, meshlets)| ModelPart { mesh, meshlets, lods: None }).collect())
    }

    /// [`Renderer::add_meshes_with_meshlets`] with each part's levels of detail (a GLB part's
    /// `genex_lods`, renderer pass 2 A6.9; [`MeshLibrary::add_part`]): the plan draws each
    /// instance at the level its distance from the camera picks.
    pub fn add_model_parts(&mut self, gpu: &Gpu, parts: Vec<ModelPart>) -> Result<Vec<MeshId>, RenderError> {
        let mut library = self.library.clone();
        let ids = parts.into_iter().map(|part| library.add_part(part)).collect::<Result<Vec<MeshId>, RenderError>>()?;
        self.meshes = mesh_buffers(&gpu.device, &gpu.queue, &library)?;
        self.meshlet_upload_pending = false;
        self.mesh_uploads += 1;
        self.library = library;
        // The meshlet table grew: last frame's candidates are not this library's.
        self.reset_meshlet_history();
        Ok(ids)
    }

    /// Times the mesh library was uploaded again since this renderer was made (diagnostics).
    pub fn mesh_uploads(&self) -> u64 {
        self.mesh_uploads
    }

    /// Add a skinned mesh (its bind pose and skin) and upload the library again.
    pub fn add_skinned_mesh(&mut self, gpu: &Gpu, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        let mut library = self.library.clone();
        let id = library.add_skinned(data)?;
        self.meshes = mesh_buffers(&gpu.device, &gpu.queue, &library)?;
        self.meshlet_upload_pending = false;
        self.mesh_uploads += 1;
        self.library = library;
        self.reset_meshlet_history();
        Ok(id)
    }

    /// Add a texture as the next layer of its kind's arrays, resampled and mipped: with texture
    /// quality off into the one 256 class, else into the size class its source asks for
    /// ([`ClassArrays::add`]; a [`TextureKind::Normal`] map with Toksvig mips when the quality
    /// says so). The first texture fixes the arrays to the quality and device class in effect.
    pub fn add_texture(&mut self, gpu: &Gpu, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.fix_texture_arrays(&gpu.device);
        self.textures.add(&gpu.device, &gpu.queue, data, kind)
    }

    /// Fix the arrays to the quality and device class in effect, on the first texture.
    fn fix_texture_arrays(&mut self, device: &Device) {
        if !self.textures_fixed {
            let class = self.class.unwrap_or(TEXTURE_DEFAULT_CLASS);
            self.set_texture_arrays(device, class, self.quality.textures);
        }
    }

    /// Store the larger size classes in `family` from the first texture on (renderer pass 2
    /// A6.4): its compressed files load there ([`Renderer::add_compressed_texture`]) at a quarter
    /// of RGBA8's bytes, and class 0 (256) stays RGBA8 for images. Refused `texture-invalid` once
    /// a texture is held (the arrays are kept) or when the device does not sample the family.
    pub fn set_texture_family(&mut self, gpu: &Gpu, family: crate::texture::TextureFamily) -> Result<(), RenderError> {
        if !family.usable(gpu.device.features()) {
            return Err(RenderError::refused(crate::error::RenderCode::TextureInvalid, format!("this device does not sample {family:?} textures")));
        }
        if !self.textures.is_empty() {
            return Err(RenderError::refused(crate::error::RenderCode::TextureInvalid, "the texture family is fixed with the first texture"));
        }
        self.texture_family = family;
        if self.textures_fixed && self.textures.family() != family {
            self.textures = ClassArrays::with_family(&gpu.device, self.textures.device_class(), self.textures.quality(), family);
        }
        Ok(())
    }

    /// The family the larger size classes are stored in ([`Renderer::set_texture_family`]).
    pub fn texture_family(&self) -> crate::texture::TextureFamily {
        self.texture_family
    }

    /// The compressed families this device samples, best first for its form (renderer pass 2
    /// A6.4): the families a game's files are looked for in. None while the texture quality in
    /// effect is off: its one 256 class holds images only.
    pub fn compressed_families(&self) -> Vec<crate::texture::TextureFamily> {
        let quality = if self.textures_fixed { self.textures.quality() } else { self.quality.textures };
        if quality == crate::settings::TextureQuality::OFF {
            return Vec::new();
        }
        let mobile = self.class.is_some_and(|class| class.form == crate::device_class::FormFactor::Mobile);
        crate::texture::TextureFamily::usable_compressed(self.device.features(), mobile)
    }

    /// Add a compressed texture in the renderer's family as the next layer of its kind's arrays
    /// (renderer pass 2 A6.4; [`ClassArrays::add_compressed`]): its stored chain as it is, its top
    /// levels dropped to the size class it fits. Refused `texture-invalid` for another family,
    /// another colour space than `kind`'s or a chain under the family's smallest class.
    pub fn add_compressed_texture(&mut self, gpu: &Gpu, texture: &crate::texture::CompressedTexture, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.fix_texture_arrays(&gpu.device);
        self.textures.add_compressed(&gpu.device, &gpu.queue, texture, kind)
    }

    /// The device class and texture quality the material arrays are fixed to (None until the
    /// first texture, while the quality in effect may still choose them).
    pub fn texture_arrays(&self) -> Option<(DeviceClass, crate::settings::TextureQuality)> {
        self.textures_fixed.then(|| (self.textures.device_class(), self.textures.quality()))
    }

    /// Fix the material arrays to `class` at `quality` before any texture is added (a device-loss
    /// replay: the textures land in the classes and layers they had, so their ids still hold).
    /// Ignored once the arrays hold a texture.
    pub fn set_texture_arrays(&mut self, device: &Device, class: DeviceClass, quality: crate::settings::TextureQuality) {
        if !self.textures.is_empty() {
            return;
        }
        let held = (self.textures.device_class(), self.textures.quality(), self.textures.family());
        if held != (class, quality, self.texture_family) {
            self.textures = ClassArrays::with_family(device, class, quality, self.texture_family);
        }
        self.textures_fixed = true;
    }

    /// The texture quality the arrays hold (the quality in effect when the first texture was
    /// added; [`crate::settings::TextureQuality::OFF`] before).
    pub fn texture_quality(&self) -> crate::settings::TextureQuality {
        self.textures.quality()
    }

    /// The bytes the material texture arrays hold.
    pub fn texture_bytes(&self) -> u64 {
        self.textures.allocated_bytes()
    }

    /// The bytes the textures in the material arrays take, each in its array's family
    /// ([`ClassArrays::held_bytes`], renderer pass 2 A6.4).
    pub fn texture_held_bytes(&self) -> u64 {
        self.textures.held_bytes()
    }

    /// The surface pipelines' key for `hdr` or the legacy scene: the quality's, with the texture
    /// quality the arrays hold, or before the first texture the one that will fix them (so the
    /// first texture, however large, compiles no pipeline: the class path and Toksvig are known
    /// from boot and prewarmed with the rest).
    fn surface_key(&self, hdr: bool) -> SurfaceKey {
        let textures = if self.textures_fixed { self.textures.quality() } else { self.quality.textures };
        let classes = textures != crate::settings::TextureQuality::OFF;
        let taa = hdr && self.quality.hdr && self.scene_format.is_hdr() && self.taa_drawn();
        SurfaceKey { texture_classes: classes, toksvig: classes && textures.toksvig, ..SurfaceKey::of(&self.quality, hdr, taa) }.for_form(self.form)
    }

    /// The meshes this renderer can draw.
    pub fn library(&self) -> &MeshLibrary {
        &self.library
    }

    /// The sun's shadows as Level-2 v2 materials draw them beside the built-in surfaces of a scene
    /// that is HDR (`hdr`) or the legacy one: the quality's filter, its temporal tap pattern (under
    /// a drawn TAA), cascade blend band and end fade, and the surfaces' roughness floor (P2-0.12).
    pub fn sun_shadow_constants(&self, hdr: bool) -> crate::extension::SunShadowConstants {
        let surface = self.surface_key(hdr);
        let settings = ShadowSettings::from_quality(&self.quality.shadows, 0.0, 0.0);
        crate::extension::SunShadowConstants {
            filter: surface.shadow_filter,
            temporal: surface.shadow_temporal,
            blend_band: settings.blend_band,
            end_fade: settings.end_fade,
            roughness_floor: f32::from_bits(surface.roughness_floor),
        }
    }

    /// Plan `scene`, check its uploads against the budget and make room in the tables. A refusal
    /// comes before any GPU write (the `tables` node writes them).
    fn prepare(&mut self, scene: &Scene, path: CullPath, scene_path: &ScenePath, temporal: &FrameTemporal) -> Result<(FramePlan, Uploads, EnvironmentSun), RenderError> {
        let aspect = self.width as f32 / self.height as f32;
        // Shadows switched off are planned without cascades (no copy of the scene per frame).
        let shadows = &self.quality.shadows;
        let sun_radius = self.environment_choice.sun_angular_radius();
        let shadows = shadows.enabled.then(|| ShadowSettings::from_quality(shadows, scene.lighting.shadow_distance, sun_radius));
        // The environment's sun on every path: a frame kept on the legacy LDR scene (a v1 pass in
        // the world) is lit as the device's HDR frames are, only without the sky drawn.
        let environment_sun = self.environment_sun(scene);
        let sun = self.ground_sun(scene, environment_sun);
        let options = PlanOptions { shadows, depth_reversed: scene_path.depth_reversed, sun };
        // Rows' identities across frames only for a frame that writes motion vectors.
        let mut plan = FramePlan::build_with_motion(scene, &self.library, aspect, &options, temporal.motion)?;
        // Levels of detail by the output's height, not the render size (A6.9): a DRS step moves
        // no instance to another level.
        plan.set_lod_height(self.height);
        // The sun's angular radius whatever the shadows (GxFrameV2's `sun_dir.w`): a v2 shader
        // sizing a sun disk or glare from it sees the same sun on every preset and device class.
        plan.frame.sun_dir[3] = sun_radius;
        if scene_path.hdr {
            // The forward output reads the pre-exposure here; lines carry sRGB colours, handed to
            // the line shader as linear light, which exposes them with that same lane (so auto
            // exposure's GPU value reaches them too).
            plan.frame.cascade_splits[2] = scene_path.pre_exposure;
            plan.frame.ambient[3] = if self.environment_lights() { 1.0 } else { 0.0 };
            for vertex in &mut plan.lines {
                let [r, g, b, a] = vertex.color;
                vertex.color = [exposed(r, 1.0), exposed(g, 1.0), exposed(b, 1.0), a];
            }
        }
        self.fog_backdrop = self.fog_backdrop_for(scene_path, scene.clear);
        // The sun chunk's frame key (its soft filters turn their taps with it only under TAA).
        plan.frame.shadow_counts[2] = self.frame_index as u32;
        // Binning needs no HDR: the legacy LDR scene (the `hdr` switch off, a v1 material or
        // pass in the world) shades the same binned lights, spots and shadowed spots included.
        if crate::lights::BINNED_SHADING_LANDED && self.quality.lights.clustered {
            let binned = crate::lights::binned_frame(&scene.lighting, &self.quality.lights, &scene.camera, self.render_size());
            plan.lights.clone_from(&binned.lights);
            plan.frame.counts[0] = plan.lights.len() as u32;
            plan.binned = Some(binned);
            if crate::cluster::LANDED && self.light_bins.get_mut().is_none() {
                *self.light_bins.get_mut() = Some(crate::cluster::LightBinNode::new(&self.device)?);
            }
        } else {
            (plan.lights, plan.legacy_ext) = crate::lights::legacy_lights(&scene.lighting, &self.quality.lights, &scene.camera);
            plan.frame.counts[0] = plan.lights.len() as u32;
        }
        self.spot_atlas |= self.draws_spot_maps() && scene.lighting.spots.iter().any(|spot| spot.shadow);
        self.plan_spot_shadows(&mut plan)?;
        self.fit_shadow_maps(&mut plan);
        // The cascades this frame holds (their cadence) are not culled.
        plan.cull_views.params[3] = (0..plan.cascades_drawn()).filter(|c| !self.shadow_draws.draws(*c)).fold(0, |held, c| held | 1 << (1 + c));
        // TAA's jitter reaches every camera depth writer; the cull and the shadows stay unjittered.
        // zw: last frame's (this frame's after a reset), the v2 frame's `prev_jitter`.
        let prev = self.prev_jitter_ndc(temporal);
        plan.frame.jitter = [temporal.jitter_ndc[0], temporal.jitter_ndc[1], prev[0], prev[1]];
        // T-06: the material textures' mip bias at this frame's scale (TAA's, or FSR1's upscale's
        // without TAA), a uniform: a dynamic-resolution step moves it without a pipeline.
        let easu = scene_path.hdr && scene_path.fsr.easu;
        plan.frame.texture_lod[0] = crate::settings::frame_texture_lod_bias(&self.quality.taa, scene_path.hdr && temporal.taa, easu, self.render_scale);
        let previous_skinned = self.plan_motion(&mut plan, temporal);
        let instance_rows = self.instance_rows(&plan);
        let uploads = Uploads::new(&mut plan, path, instance_rows)?;
        self.tables.ensure(&self.device, &plan, &uploads)?;
        self.keep_previous_skinned(previous_skinned)?;
        self.last = LastFrame { batches: plan.batches.len() as u32, views: plan.views, skinned_vertices: plan.skinned_vertices, opaque_instances: plan.visible_slots };
        Ok((plan, uploads, environment_sun))
    }

    /// The sun the environment sees for `scene` (direction, linear colour with its intensity): an
    /// HDR map's analytic sun under [`crate::settings::HdriSun::Analytic`] once its map is
    /// uploaded, else the scene's own sun.
    fn environment_sun(&self, scene: &Scene) -> EnvironmentSun {
        if let Environment::Hdri(hdri) = &self.environment_choice
            && let Some(sun) = self.environment.borrow().analytic_sun(hdri)
        {
            return sun;
        }
        let lighting = &scene.lighting;
        let dir = glam::Vec3::from(lighting.sun_dir).normalize_or(glam::Vec3::Y).to_array();
        let [r, g, b, _] = crate::lights::radiance(lighting.sun_color, lighting.sun_intensity);
        (dir, [r, g, b])
    }

    /// The sun that lights the scene's surfaces when the environment changes it from the scene's
    /// own (None: the scene's sun stands): an HDR map's analytic sun, or under the sky the
    /// sun through the atmosphere ([`crate::sky::sun_transmittance`] at the camera's height), so the
    /// ground is lit by the light the sky is coloured by.
    fn ground_sun(&self, scene: &Scene, (dir, color): EnvironmentSun) -> Option<SunLight> {
        match &self.environment_choice {
            Environment::Sky(sky) => {
                let height = crate::sky::camera_height_km(scene.camera.eye[1]);
                let through = crate::sky::sun_transmittance(height, dir, sky.sun_angular_radius);
                Some(SunLight { dir, color: [0, 1, 2].map(|c| color[c] * through[c]) })
            }
            Environment::Hdri(hdri) => self.environment.borrow().analytic_sun(hdri).map(|(dir, color)| SunLight { dir, color }),
            _ => None,
        }
    }

    /// The HDR scene format the session's choice resolves to on this device: `rg11b10ufloat` only
    /// where the device was opened with `RG11B10UFLOAT_RENDERABLE` and the target pool takes it as
    /// the 1x scene and the multisampled colour, `rgba16float` (core) otherwise.
    fn hdr_format(&self) -> TextureFormat {
        let features = self.pool.policy().features();
        let format = TextureFormat::Rg11b10Ufloat;
        // Every way the frame holds the scene: the 1x scene, and the multisampled colour a resolve reads.
        let takes = [target(SCENE_TARGET, format, HDR_SCENE_USAGE, 1, (1, 1)), target(MSAA_TARGET, format, MSAA_READ_USAGE, self.samples, (1, 1))]
            .iter()
            .all(|desc| crate::target_pool::validate_with(desc, features).is_ok());
        if self.scene_format == SceneFormat::Rg11b10Ufloat && takes { format } else { TextureFormat::Rgba16Float }
    }

    /// How the next frame draws its scene colour, at `render` size, with `stage_reason` (a world
    /// stage's reason to stay LDR) besides the renderer's own.
    fn scene_path(&self, render: (u32, u32), stage_reason: Option<LdrReason>) -> ScenePath {
        let asked = self.quality.hdr && self.scene_format.is_hdr();
        let reason = self.ldr_reason.or(stage_reason);
        if !asked || reason.is_some() {
            let resolve = (self.samples > 1).then_some(MsaaResolve::Hardware);
            return ScenePath { ldr_reason: reason.filter(|_| asked), resolve, ..ScenePath::LEGACY };
        }
        let by_device = match self.class {
            Some(class) => MsaaResolve::for_class(class, self.tile_gpu()),
            None => MsaaResolve::for_device(self.form, self.tile_gpu()),
        };
        let resolve = (self.samples > 1).then(|| self.resolve_override.unwrap_or(by_device));
        let weighted = resolve == Some(MsaaResolve::Weighted);
        let output = (self.width, self.height);
        let upscaled = render != output;
        let fsr = if crate::post::fsr::LANDED { crate::post::fsr::passes(&self.quality, render, output) } else { FsrPasses::default() };
        let fsr_runs = fsr.easu || fsr.rcas;
        // The tonemap's own sharpened stretch stands in for FSR1 only where it has not landed.
        let sharpened = upscaled && self.quality.upscaler != Upscaler::Bilinear && !fsr_runs;
        let readers = self.hdr_readers || auto_exposure(&self.look, &self.quality);
        let resolve_pass = weighted && (readers || sharpened);
        let taa = self.taa_drawn();
        ScenePath {
            hdr: true,
            format: self.hdr_scene_format(),
            depth_reversed: true,
            ldr_reason: None,
            tonemapper: if self.quality.tonemap { self.look.tonemapper } else { Tonemapper::None },
            resolve,
            resolve_pass,
            tonemap: Some(TonemapSource::pick(weighted && !resolve_pass, upscaled && !fsr_runs, sharpened)),
            pre_exposure: pre_exposure(&self.look, &self.quality),
            taa,
            fsr,
        }
    }

    /// Whether TAA resolves the HDR scene under the quality (RQ5.6): its switch on in this build,
    /// a one-sample world pass (MSAA is off under TAA, `landed_samples`; a renderer built with
    /// MSAA draws MSAA until the presenter rebuilds it) and the prepass allowed, for its depth and
    /// motion. Elsewhere the frame is drawn unjittered and resolved as before.
    fn taa_drawn(&self) -> bool {
        let prepass = NodeId::Prepass.landed() && self.quality.prepass;
        self.samples == 1 && crate::motion::LANDED && prepass && crate::graph::feature_drawn(&self.quality, RenderFeature::Taa)
    }

    /// What the frame drawn on `path` at `render` size does with TAA and motion, with the
    /// extension ladder's `demand` (a declared `motion` input makes the prepass write motion
    /// without TAA): the jitter keyed to the frame index on the history set being drawn.
    fn frame_temporal(&self, path: &ScenePath, demand: ExtensionDemand, render: (u32, u32)) -> FrameTemporal {
        let demand = either_demand(self.prepass_demand, demand);
        let motion_input = demand.custom_inputs.contains(RenderInputs::MOTION) || demand.extension_inputs.contains(RenderInputs::MOTION);
        let motion = crate::motion::LANDED && NodeId::Prepass.landed() && (path.taa || motion_input);
        let (jitter_px, jitter_ndc) = if path.taa {
            let px = crate::jitter::offset_px(self.frame_index, self.quality.taa.jitter_cycle);
            (px, crate::jitter::offset_ndc(px, render))
        } else {
            (crate::jitter::NO_JITTER, crate::jitter::NO_JITTER)
        };
        let reset = self.frame_index == 0 && !self.temporal_kept;
        FrameTemporal { taa: path.taa, motion, jitter_px, jitter_ndc, reset, set: self.history_set }
    }

    /// Match `plan`'s rows against its history set's last frame (graph node 7's previous-model
    /// table and frame row, kept for the frame's `FramePrep`) on a frame writing motion, and say
    /// how many bytes of last frame's skinned vertices the skinning node keeps for it (None: its
    /// skinned rows read their current vertices, a reset or a regrown table having lost them).
    fn plan_motion(&mut self, plan: &mut FramePlan, temporal: &FrameTemporal) -> Option<u64> {
        if !temporal.motion {
            // This frame's skinning is no motion frame's: nothing for the next one to read.
            self.skinned_prev.written = None;
            self.motion_row = None;
            self.taa_reproject = crate::post::taa::IDENTITY;
            self.transparent_coverage = crate::post::taa::ReactiveCoverage { cap: crate::post::taa::TRANSPARENT_COVERAGE, by_motion: false };
            return None;
        }
        let bytes = u64::from(plan.skinned_vertices) * VERTEX_STRIDE;
        let previous = match self.skinned_prev.written {
            Some((set, held)) if set == temporal.set && !temporal.reset && held > 0 && self.tables.skinned.holds(bytes) => Some(held),
            _ => None,
        };
        let step = MotionStep { jitter_ndc: temporal.jitter_ndc, reset: temporal.reset, prev_vertices: previous.is_some() };
        let row = self.motion_history[set_index(temporal.set)].apply(plan, step);
        self.taa_reproject = crate::post::taa::reprojection(&row.prev_view_proj, &plan.frame.view_proj);
        // Read before the uploads take the previous-model table out of the plan.
        self.transparent_coverage = crate::post::taa::transparent_coverage(&crate::post::taa::TransparentRows {
            history: !temporal.reset,
            rows: &plan.transparent,
            prev_models: &plan.prev_models,
            sources: &plan.transparent_sources,
        });
        self.motion_row = Some(row);
        self.skinned_prev.written = Some((temporal.set, bytes));
        previous
    }

    /// Room for `bytes` of last frame's skinned vertices (the skinning node copies them before it
    /// skins this frame), or none to keep.
    fn keep_previous_skinned(&mut self, bytes: Option<u64>) -> Result<(), RenderError> {
        self.skinned_prev.copy = bytes.unwrap_or(0);
        let Some(bytes) = bytes else { return Ok(()) };
        if self.skinned_prev.buffer.as_ref().is_none_or(|buffer| buffer.size() < bytes) {
            let size = aligned(bytes).next_power_of_two();
            self.skinned_prev.buffer = Some(buffer(&self.device, "previous skinned vertices", size, BufferUsages::STORAGE | BufferUsages::COPY_DST)?);
        }
        Ok(())
    }

    /// The motion prepass's group 2 (instance draws) and group 3 (meshlet draws) for the frame
    /// `spec` holds (None without motion).
    fn motion_group(&self, spec: &TargetSpec) -> Option<(BindGroup, BindGroup)> {
        let node = self.motion_node.as_ref().filter(|_| spec.motion)?;
        let previous = self.skinned_prev.buffer.as_ref().filter(|_| self.skinned_prev.copy > 0);
        let prev_models = self.tables.prev_models.get();
        Some((node.group(&self.device, prev_models, previous), node.meshlet_group(&self.device, prev_models)))
    }

    /// TAA's histories and reactive coverage on a TAA frame, and FSR1's passes where the quality
    /// can run them (made on the first frame that asks, its pipelines prewarmed: a dynamic-
    /// resolution step compiles nothing).
    fn ensure_temporal(&mut self, path: &ScenePath) -> Result<(), RenderError> {
        if !path.taa {
            // A frame without TAA releases its history pairs (RQ5 review): the bytes go back to
            // the budget (`temporal_bytes`) once the person or the budget turns TAA off, and the
            // next TAA frame starts its history over anyway. The reactive node (one uniform row,
            // its pipelines bound by the particles) stays.
            *self.taa.get_mut() = None;
        } else {
            if self.taa.get_mut().is_none() {
                *self.taa.get_mut() = Some(TaaHistories::on_device(&self.device, &self.queue)?);
            }
            if self.reactive.as_ref().is_none_or(|reactive| reactive.reversed != path.depth_reversed) {
                // One node (one jitter group layout) for the session; its pipeline per convention.
                let node = match self.reactive.take() {
                    Some(reactive) => reactive.node,
                    None => ReactiveNode::new(&self.device)?,
                };
                let mesh = node.pipeline(&self.device, ReactiveEntry::Mesh, [&self.layouts.frame, &self.layouts.pass], &mesh_buffers_layout(), path.depth_reversed)?;
                self.reactive = Some(ReactivePipelines { node, mesh, reversed: path.depth_reversed });
            }
        }
        let fsr_asked = self.quality.upscaler == Upscaler::Fsr1 || self.quality.anti_aliasing == AntiAliasing::TaaSharpen;
        if crate::post::fsr::LANDED && path.hdr && fsr_asked && self.fsr.get_mut().is_none() {
            let mut node = FsrNode::new(&self.device)?;
            node.prewarm(&self.device, WORLD_FORMAT);
            *self.fsr.get_mut() = Some(node);
        }
        Ok(())
    }

    /// The targets `path` needs beyond the legacy set (`temporal`'s motion with the prepass).
    fn target_spec(&self, path: &ScenePath, prepass: Option<&FramePrepass>, temporal: &FrameTemporal) -> TargetSpec {
        let msaa_read = path.hdr && path.resolve == Some(MsaaResolve::Weighted);
        TargetSpec {
            hdr: path.hdr.then_some(path.format),
            msaa_read,
            scene_1x: path.hdr && (!msaa_read || path.resolve_pass),
            depth_readback: self.depth_readback,
            prepass: prepass.is_some(),
            equal_depth: prepass.is_some_and(|prepass| prepass.equal),
            motion: temporal.motion && prepass.is_some(),
            fsr: if path.hdr { path.fsr } else { FsrPasses::default() },
        }
    }

    /// What this frame's prepass does: None unless the node has landed, the quality allows it and
    /// a consumer asks (the extension ladder's demand, the `stage`'s, or a landed feature), with the
    /// world stage's custom geometry.
    fn prepass_plan(&self, stage: StagePrepass, meshlets: bool, sun_shadows: bool, temporal: &FrameTemporal) -> Option<FramePrepass> {
        let demand = either_demand(self.prepass_demand, stage.demand);
        let draws = stage.draws;
        let drawn = crate::prepass::drawn_consumers(&self.quality, demand);
        let mut consumers = crate::prepass::with_sun_shadows(drawn, &self.quality, sun_shadows);
        if !meshlets {
            // Occlusion culls meshlet candidates: a frame without any asks nothing of the prepass.
            consumers = consumers.without(PrepassConsumers::OCCLUSION);
        }
        if !temporal.taa {
            // A TAA quality whose frame does not resolve (the legacy LDR scene, a renderer still
            // drawing MSAA) asks nothing of the prepass for it.
            consumers = consumers.without(PrepassConsumers::TAA);
        }
        if !NodeId::Prepass.landed() {
            return None;
        }
        // The quality's switch gates the built-in consumers; the extension ladder's demand runs it
        // whatever the switch says (inputs drive producers).
        let consumers = crate::prepass::served(&self.quality, consumers)?;
        let equal = crate::prepass::main_pass_equal(self.tile_gpu(), self.samples, self.equal_depth_override, draws.len());
        Some(FramePrepass { consumers, equal, draws })
    }

    /// The prepass's pipelines for `path` (made again when the scene format or depth convention
    /// changes) and room for `draws` custom-geometry rows.
    fn ensure_prepass(&mut self, path: &ScenePath, draws: usize, motion: bool) -> Result<(), RenderError> {
        let surface = self.surface_key(path.hdr);
        let made = self.prepass_pipelines.as_ref().is_some_and(|pipelines| prepass_pipelines_fit(pipelines, path, surface));
        if !made {
            self.prepass_pipelines = Some(prepass_pipelines(&self.device, &self.layouts, path.format, path.depth_reversed, surface)?);
            self.note_pipeline_build();
        }
        if motion && self.motion_node.is_none() {
            self.motion_node = Some(MotionNode::new(&self.device)?);
        }
        if let (true, Some(pipelines), Some(node)) = (motion, self.prepass_pipelines.as_mut(), self.motion_node.as_ref())
            && pipelines.motion.is_none()
        {
            pipelines.motion = Some(motion_pipelines(&self.device, &self.layouts, node, path.depth_reversed)?);
        }
        if draws > self.prepass_rows.as_ref().map_or(0, |rows| rows.capacity) {
            self.prepass_rows = Some(prepass_rows(&self.device, &self.layouts.prepass_draw, draws)?);
        }
        Ok(())
    }

    /// The pipeline the world pass draws the opaque batches with: the forward pipeline, or its
    /// `Equal` twin over the prepass depth.
    fn opaque_pipeline(&self) -> &RenderPipeline {
        match &self.prepass_pipelines {
            Some(pipelines) if self.targets.spec.equal_depth => &pipelines.forward_equal,
            _ => &self.scene_pipelines().forward,
        }
    }

    /// The pipeline the world pass draws the meshlets with: the meshlet forward pipeline, or its
    /// `Equal` twin over the prepass depth.
    fn meshlet_opaque_pipeline(&self) -> Option<&RenderPipeline> {
        let pipelines = self.meshlet_pipelines()?;
        match &pipelines.forward_equal {
            Some(equal) if self.targets.spec.equal_depth => Some(equal),
            _ => Some(&pipelines.forward),
        }
    }

    /// Graph node 7: the opaque batches of the camera view (`counts` on the CPU path), skinned ones
    /// included, then the custom geometry, into the prepass depth and normals. None when nothing
    /// was recorded (no prepass this frame).
    fn encode_prepass(&self, frame: &mut FrameEncoder, prep: &FramePrep, counts: Option<&[u32]>) -> Option<PrepassInfo> {
        let (Some(plan), Some(targets), Some(pipelines)) = (&prep.prepass, &self.targets.prepass, &self.prepass_pipelines) else { return None };
        let rows = self.prepass_rows.as_ref().filter(|_| !plan.draws.is_empty());
        if let Some(rows) = rows {
            let mut bytes = vec![0u8; plan.draws.len() * crate::prepass::DRAW_STRIDE as usize];
            for (row, draw) in bytes.chunks_mut(crate::prepass::DRAW_STRIDE as usize).zip(&plan.draws) {
                row[..size_of::<GpuPrepassDraw>()].copy_from_slice(bytemuck::bytes_of(&GpuPrepassDraw::of(draw)));
            }
            frame.queue().write_buffer(&rows.buffer, 0, &bytes);
        }
        let depth_clear = if self.path.depth_reversed { 0.0 } else { 1.0 };
        // With motion (RQ5.6) the same draws write the motion and the reactive flags too.
        let motion = match (&prep.motion, &pipelines.motion, &targets.motion, &targets.reactive) {
            (Some(frame_motion), Some(motion_pipelines), Some((_, motion_view)), Some((_, reactive_view))) => {
                if let Some(node) = self.motion_node.as_ref() {
                    node.write(frame.queue(), &frame_motion.row);
                }
                Some((&frame_motion.group, motion_pipelines, motion_view, reactive_view))
            }
            _ => None,
        };
        let clear = wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store };
        let attachment = |view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: clear });
        let colors = match motion {
            Some((_, _, motion_view, reactive_view)) => vec![attachment(&targets.normals_view), attachment(motion_view), attachment(reactive_view)],
            None => vec![attachment(&targets.normals_view)],
        };
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("prepass"),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(depth_clear), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        if let Some((group, _, _, _)) = motion {
            pass.set_bind_group(2, group, &[]);
        }
        if !prep.plan.batches.is_empty() {
            pass.set_pipeline(motion.map_or(&pipelines.batches, |(_, motion_pipelines, _, _)| &motion_pipelines.batches));
            pass.set_bind_group(0, &prep.groups.frame, &[]);
            pass.set_bind_group(1, &prep.groups.pass, &[0]);
            // The world pass's statistics count its own draws; the prepass's repeat them.
            let meshlets = prep.meshlets.as_ref().map(|meshlets| &meshlets.frame);
            self.draw_batches(&mut pass, &prep.plan, 0, counts, meshlets, &mut FrameStats::default());
            self.draw_prepass_variants(&mut pass, &prep.groups.pass, &prep.plan, counts, motion.is_some());
            // Pass 1's meshlets (every visible one without occlusion); node 8 adds pass 2's.
            if let (Some(_), Some(meshlet_pipelines)) = (meshlets, self.meshlet_pipelines()) {
                let pipeline = self.meshlet_prepass_pipeline(meshlet_pipelines, &mut pass, prep);
                self.draw_meshlets(&mut pass, &prep.groups.frame, &prep.groups.pass, 0, ArgsSlot::First, pipeline);
            }
        }
        let mut custom_draws = 0;
        if let Some(rows) = rows {
            pass.set_pipeline(motion.map_or(&pipelines.draws, |(_, motion_pipelines, _, _)| &motion_pipelines.draws));
            pass.set_bind_group(0, &prep.groups.frame, &[]);
            if let Some((group, _, _, _)) = motion {
                // The meshlet draws bound their own group 2.
                pass.set_bind_group(2, group, &[]);
            }
            pass.set_vertex_buffer(0, self.meshes.vertices.slice(..));
            for (i, draw) in plan.draws.iter().enumerate() {
                let Some(mesh) = self.library.entry(draw.mesh) else { continue };
                pass.set_bind_group(1, &rows.group, &[(i as u64 * crate::prepass::DRAW_STRIDE) as u32]);
                pass.draw_indexed(mesh.first_index..mesh.first_index + mesh.index_count, mesh.base_vertex, 0..1);
                custom_draws += 1;
            }
        }
        // The terrain's depth, normals and motion (A.7), after every other geometry, then its
        // grass's (A.8).
        self.draw_terrain_prepass(&mut pass, prep, motion.map(|(group, _, _, _)| group));
        self.draw_grass_prepass(&mut pass, prep, motion.map(|(group, _, _, _)| group));
        if let Some((group, motion_pipelines, _, _)) = motion {
            // T-03: the camera's motion wherever no geometry drew (the sky, its sun disc, the fog
            // horizon), after every draw of the pass: `Equal` against the cleared far plane.
            MotionNode::draw_background(&mut pass, &motion_pipelines.background, group);
        }
        Some(PrepassInfo { consumers: plan.consumers, equal_depth: plan.equal, custom_draws, size: self.targets.render_size })
    }

    /// The meshlet prepass's pipeline: its motion variant on a frame writing motion (its group 3
    /// bound on `pass`), else the plain one.
    fn meshlet_prepass_pipeline<'p>(&self, pipelines: &'p MeshletPipelines, pass: &mut RenderPass<'_>, prep: &FramePrep) -> &'p RenderPipeline {
        let motion = self.targets.prepass.as_ref().is_some_and(|targets| targets.motion.is_some());
        match (&pipelines.prepass_motion, &prep.motion) {
            (Some(pipeline), Some(frame_motion)) if motion => {
                pass.set_bind_group(3, &frame_motion.meshlet_group, &[]);
                pipeline
            }
            _ => &pipelines.prepass,
        }
    }

    /// The HDR scene pipelines, the tonemap and the resolve for `path` (made on the first HDR frame,
    /// again when the scene format or the surface constants change); the tonemap's pipeline is
    /// prewarmed here. A legacy `path` keeps the legacy scene's pipelines current instead.
    fn ensure_hdr(&mut self, path: &ScenePath) -> Result<(), RenderError> {
        if !path.hdr {
            return self.ensure_legacy_scene();
        }
        // Keyed by the knobs too: the person's override of specular AA or the shadow filter
        // rebuilds the scene's set.
        let key = (path.format, self.surface_key(true));
        if self.hdr_pipelines.as_ref().is_none_or(|(made, _)| *made != key) {
            let pipelines = scene_pipelines(&self.device, &self.layouts, self.samples, path.format, true, key.1)?;
            self.hdr_pipelines = Some((key, pipelines));
            self.note_pipeline_build();
        }
        let mut post = self.post.borrow_mut();
        if post.is_none() {
            *post = Some((TonemapNode::new(&self.device)?, ResolveNode::new(&self.device)?));
        }
        // Every way the session's frames can reach the curve, made now: a dynamic-resolution step
        // (the frame already over budget) or a new reader of the resolved scene compiles nothing.
        if let Some((tonemap, resolve)) = post.as_mut() {
            let multisampled = self.samples > 1;
            let sources = [TonemapSource::Scene, TonemapSource::Bilinear, TonemapSource::Sharpen, TonemapSource::Msaa, TonemapSource::BilinearMsaa];
            for source in sources.into_iter().filter(|source| multisampled || !source.multisampled()) {
                tonemap.pipeline(&self.device, path.tonemapper, source, WORLD_FORMAT);
            }
            // FSR1's intermediate (RQ5.6): a step into an upscale tonemaps there.
            let fsr_asked = self.quality.upscaler == Upscaler::Fsr1 || self.quality.anti_aliasing == AntiAliasing::TaaSharpen;
            if crate::post::fsr::LANDED && fsr_asked {
                for source in [TonemapSource::Scene, TonemapSource::Msaa].into_iter().filter(|source| multisampled || !source.multisampled()) {
                    tonemap.pipeline(&self.device, path.tonemapper, source, crate::post::fsr::INTERMEDIATE_FORMAT);
                }
            }
            if multisampled {
                resolve.pipeline(&self.device, path.format);
            }
        }
        Ok(())
    }

    /// The legacy scene's pipelines, made on its first frame and again when the quality's shadow
    /// filter changed.
    fn ensure_legacy_scene(&mut self) -> Result<(), RenderError> {
        let surface = self.surface_key(false);
        if self.pipelines.scene.is_none() || self.pipelines.scene_surface != surface {
            self.pipelines.scene = Some(scene_pipelines(&self.device, &self.layouts, self.samples, WORLD_FORMAT, false, surface)?);
            self.pipelines.scene_surface = surface;
            self.note_pipeline_build();
        }
        Ok(())
    }

    fn note_pipeline_build(&self) {
        self.scene_pipeline_builds.set(self.scene_pipeline_builds.get() + 1);
    }

    /// Frame bind-group sets the renderer holds: the frame's own and the ones made mid-frame after
    /// a node replaced a view they bind (diagnostics: each pins the tables, shadow maps, material
    /// arrays and effect views it binds, outside the target ledger).
    pub fn frame_group_sets(&self) -> usize {
        usize::from(self.groups.is_some()) + self.refreshed_groups.borrow().len()
    }

    /// Scene pipeline sets made so far, the HDR and legacy scenes' and the prepass's (diagnostics:
    /// a frame that makes one compiles shaders on the frame thread, a hitch DRS cannot absorb).
    pub fn scene_pipeline_builds(&self) -> u32 {
        self.scene_pipeline_builds.get()
    }

    /// Tonemap and resolve pipelines made so far (diagnostics: a frame that makes one stalls).
    pub fn post_pipelines(&self) -> usize {
        self.post.borrow().as_ref().map_or(0, |(tonemap, resolve)| tonemap.pipelines_made() + resolve.pipelines_made())
    }

    /// The pipelines drawing into this frame's scene colour.
    fn scene_pipelines(&self) -> &ScenePipelines {
        if let Some((_, pipelines)) = self.hdr_pipelines.as_ref().filter(|_| self.path.hdr) {
            return pipelines;
        }
        self.pipelines.scene.as_ref().expect("ensure_hdr makes the legacy scene's pipelines before a frame draws on it")
    }

    /// Node 16 on desktop classes as its own pass: the weighted resolve into the 1x HDR scene.
    fn encode_hdr_resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        let (Some(msaa), Some(scene)) = (&self.targets.msaa_view, &self.targets.scene_view) else { return };
        let mut post = self.post.borrow_mut();
        let Some((_, resolve)) = post.as_mut() else { return };
        resolve.encode(&self.device, encoder, msaa, scene, self.path.format, self.pool.generation());
    }

    /// Node 21: the bloom chain (when the frame draws bloom) and the tonemap, reading the 1x scene
    /// (or `resolved`, TAA's resolve, of identity `generation`) or the samples, into the world
    /// target, or under FSR1 into its intermediate at render size (no dither there: RCAS's final
    /// write adds it). The render passes it opened (0: no HDR frame).
    fn encode_tonemap(&self, frame: &mut FrameEncoder, resolved: Option<&TextureView>, generation: u64) -> u32 {
        let Some(source) = self.path.tonemap else { return 0 };
        let targets = &self.targets;
        let input = match resolved {
            Some(view) if !source.multisampled() => Some(view),
            _ if source.multisampled() => targets.msaa_view.as_ref(),
            _ => targets.scene_view.as_ref(),
        };
        let Some(input) = input else { return 0 };
        let fsr = targets.fsr_input.as_ref().filter(|_| self.path.fsr_runs());
        let (target, format, target_size) = match fsr {
            Some(view) => (view, crate::post::fsr::INTERMEDIATE_FORMAT, targets.render_size),
            None => (&targets.world_view, WORLD_FORMAT, (self.width, self.height)),
        };
        let mut post = self.post.borrow_mut();
        let Some((tonemap, _)) = post.as_mut() else { return 0 };
        let pass = TonemapPass {
            source,
            input,
            target,
            format,
            tonemapper: self.path.tonemapper,
            source_size: targets.render_size,
            target_size,
            output_size: (self.width, self.height),
            dither: fsr.is_none(),
            frame_index: self.frame_index,
            generation,
            balance: self.look.white_balance_matrix(),
        };
        let device = frame.device().clone();
        let queue = frame.queue().clone();
        tonemap.encode(&device, &queue, frame.encoder(), &pass)
    }

    /// Node 22 on the HDR scene (RQ5.6): EASU from the tonemapped intermediate to output size when
    /// the scene was drawn smaller, then RCAS (sharpening by the quality's `rcas`) and the dither
    /// into the world target. The render passes it opened.
    fn encode_fsr(&self, frame: &mut FrameEncoder) -> u32 {
        let passes = self.path.fsr;
        let targets = &self.targets;
        let Some(input) = targets.fsr_input.as_ref() else { return 0 };
        let mut node = self.fsr.borrow_mut();
        let Some(node) = node.as_mut() else { return 0 };
        let pass = FsrPass {
            passes,
            input,
            easu: targets.fsr_easu.as_ref().unwrap_or(input),
            target: &targets.world_view,
            format: WORLD_FORMAT,
            render_size: targets.render_size,
            output_size: (self.width, self.height),
            rcas: passes.rcas.then_some(&self.quality.rcas),
            dither: true,
            frame_index: self.frame_index,
            generation: self.pool.generation(),
        };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        node.encode(&device, &queue, frame.encoder(), &pass);
        1 + u32::from(passes.easu)
    }

    /// Last frame's jitter in NDC on `temporal`'s history set (this frame's after a reset or
    /// without TAA): the v2 frame's `prev_jitter`.
    fn prev_jitter_ndc(&self, temporal: &FrameTemporal) -> [f32; 2] {
        let last = self.temporal_last[set_index(temporal.set)].filter(|_| temporal.taa && !temporal.reset);
        last.map_or(temporal.jitter_ndc, |last| crate::jitter::offset_ndc(last.jitter_px, self.targets.render_size))
    }

    /// This frame's TAA jitter in NDC (clip units; 0 without TAA): `GxPostV2::jitter`.
    pub fn frame_jitter_ndc(&self) -> [f32; 2] {
        self.temporal.jitter_ndc
    }

    /// TAA's row for the frame being drawn: its jitter and last frame's, the exposure ratio its
    /// history is rescaled by (manual exposure's now over then; 1 under auto exposure, whose GPU
    /// value moves by a small step per tick) and whether history starts over.
    fn taa_row(&self) -> GpuTaaParams {
        let temporal = self.temporal;
        let last = self.temporal_last[set_index(temporal.set)].filter(|_| !temporal.reset);
        let prev_jitter = last.map_or(temporal.jitter_px, |last| last.jitter_px);
        let ratio = match last {
            Some(last) if !auto_exposure(&self.look, &self.quality) => self.path.pre_exposure / last.pre_exposure.max(f32::MIN_POSITIVE),
            _ => 1.0,
        };
        let render = self.targets.render_size;
        let config = FrameConfig {
            output_size: (self.width, self.height),
            render_size: render,
            scale: self.render_scale,
            samples: self.targets.samples,
            hdr: self.path.hdr,
            depth_reversed: self.path.depth_reversed,
            ldr_reason: None,
            frame_index: self.frame_index,
            history_reset: temporal.reset,
            settle: None,
            jitter: temporal.jitter_px,
        };
        GpuTaaParams::new(&self.quality.taa, &config, prev_jitter, ratio).with_reproject(self.taa_reproject)
    }

    /// Copy TAA's resolve in history `slot` into the 1x HDR `scene` (for `post-hdr` passes):
    /// false when there is nothing to copy.
    fn copy_taa_history(&self, encoder: &mut wgpu::CommandEncoder, slot: usize, scene: &Texture) -> bool {
        let histories = self.taa.borrow();
        let Some(history) = histories.as_ref().and_then(|histories| histories.written_texture(self.temporal.set, slot)) else { return false };
        if history.format() != scene.format() || history.size() != scene.size() {
            return false;
        }
        encoder.copy_texture_to_texture(history.as_image_copy(), scene.as_image_copy(), scene.size());
        true
    }

    /// Graph node 15a: the transparent draws redrawn as coverage into the reactive mask (over the
    /// prepass's no-history flags), depth-tested against the prepass depth. False when nothing ran.
    fn encode_reactive(&self, frame: &mut FrameEncoder, prep: &FramePrep, stage: &dyn WorldStage) -> bool {
        let plan = &prep.plan;
        let (Some(reactive), Some(prepass)) = (self.reactive.as_ref(), self.targets.prepass.as_ref()) else { return false };
        let Some((_, mask)) = prepass.reactive.as_ref() else { return false };
        if plan.transparent_sources.is_empty() && !stage.reactive_draws() {
            return false;
        }
        reactive.node.write(frame.queue(), GpuReactiveJitter::new(self.temporal.jitter_px, self.targets.render_size).with_coverage(self.transparent_coverage));
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("taa reactive"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: mask,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &prepass.depth_view, depth_ops: None, stencil_ops: None }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&reactive.mesh);
        pass.set_bind_group(0, &prep.groups.frame, &[]);
        pass.set_bind_group(2, prep.reactive_group.as_ref().unwrap_or(reactive.node.jitter_group()), &[]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        for (k, source) in plan.transparent_sources.iter().enumerate() {
            let entry = u64::from(plan.views) + k as u64;
            pass.set_bind_group(1, &prep.groups.pass, &[(entry * PASS_VIEW_STRIDE) as u32]);
            let (vertices, slots) = if source.skinned {
                (self.tables.skinned.get(), self.tables.skinned_slots.get())
            } else {
                (&self.meshes.vertices, &self.meshes.slots)
            };
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.set_vertex_buffer(1, slots.slice(..));
            pass.draw_indexed(source.first_index..source.first_index + source.index_count, source.base_vertex, 0..1);
        }
        stage.reactive(&mut pass, &reactive.node);
        true
    }

    /// TAA's reactive coverage node and the depth convention of the frame being drawn, on a TAA
    /// frame (a world stage builds its own coverage pipelines over its jitter group).
    pub(crate) fn reactive_node(&self) -> Option<(&ReactiveNode, bool)> {
        self.reactive.as_ref().filter(|_| self.path.taa).map(|reactive| (&reactive.node, self.path.depth_reversed))
    }

    /// Whether this frame draws the GPU-exposed background: on the HDR scene under auto exposure,
    /// where the CPU does not know the exposure the clear colour needs.
    fn draws_background(&self) -> bool {
        self.path.hdr && auto_exposure(&self.look, &self.quality)
    }

    /// Graph node 4: the binned frame's tile masks and z-bins into `light_bins` (the table the
    /// forward pass reads whole and v2 materials as two slices). False when the frame bins nothing or
    /// the node refused its tables, which then keep the zero header Uploads wrote: no local light
    /// is shaded rather than a stale one.
    fn encode_light_bins(&self, frame: &mut FrameEncoder, plan: &FramePlan) -> bool {
        let Some(binned) = plan.binned.as_ref() else { return false };
        let mut node = self.light_bins.borrow_mut();
        let Some(node) = node.as_mut() else { return false };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let input = crate::cluster::LightBinInput { frame: &binned.bins, bins: self.tables.light_bins.get() };
        node.encode(&device, &queue, frame.encoder(), input).is_ok()
    }

    /// Graph node 1: this frame's frame uniforms, cull views and tables, and the frame's own rows
    /// `frame_rows` (fog, background), from the upload arena as copies at the head of `encoder`, the
    /// frame's own (RC-08).
    fn write_uploads(&self, encoder: &mut wgpu::CommandEncoder, uploads: &Uploads, plan: &FramePlan, frame_rows: &[crate::tables::UploadWrite<'_>]) {
        let mut writes = vec![(&self.frame_uniforms, 0, uploads.frame.as_slice()), (&self.cull_views, 0, uploads.cull_views.as_slice())];
        writes.extend(uploads.writes(&self.tables, plan));
        writes.extend_from_slice(frame_rows);
        self.upload_arena.borrow_mut().upload(encoder, &writes);
        // The instance table now holds this frame's rows: its retained spans are the next frame's
        // to compare with (A.0b).
        *self.retained_held.borrow_mut() = Some((self.tables.instances.get().clone(), plan.retained.clone()));
        self.last_instance_bytes.set(uploads.instance_bytes());
    }

    /// The instance-table rows `plan` writes: all of them, less its retained groups' rows the
    /// table holds unchanged since the last upload into this very table (A.0b).
    fn instance_rows(&self, plan: &FramePlan) -> Vec<std::ops::Range<usize>> {
        let bytes = std::mem::size_of_val(plan.instances.as_slice()) as u64;
        let held = self.retained_held.borrow();
        let same_table = |(table, _): &&(Buffer, Vec<crate::retained::RetainedSpan>)| self.tables.instances.holds(bytes) && table == self.tables.instances.get();
        let spans = held.as_ref().filter(same_table).map(|(_, spans)| spans.as_slice());
        crate::tables::instance_upload_ranges(plan.instances.len(), &plan.retained, spans)
    }

    /// Bytes of instance rows the last frame wrote (renderer pass 2 A.0b: a static retained
    /// group's rows are written once).
    pub fn last_instance_upload_bytes(&self) -> u64 {
        self.last_instance_bytes.get()
    }

    /// Prepare a frame of `scene`: plan and room in the tables, the targets of the current scale
    /// step, the bind groups they need, with `stage_reason` (a world stage's reason to keep the
    /// frame LDR) besides the renderer's own and what the frame's stages ask of the depth/normal
    /// prepass. Nothing reaches the GPU queue yet.
    pub(crate) fn begin_frame_prepass(&mut self, scene: &Scene, path: CullPath, stage_reason: Option<LdrReason>, stage: StagePrepass) -> Result<FramePrep, RenderError> {
        let (device, queue) = (self.device.clone(), self.queue.clone());
        self.upload_meshlets(&device, &queue)?;
        let render = self.render_size();
        // A frame at another render size than the last keeps the targets it replaces as spares
        // (RC-10: a dynamic-resolution step going back swaps them in instead of allocating).
        self.pool.note_render_size(render);
        let scene_path = self.scene_path(render, stage_reason);
        let temporal = self.frame_temporal(&scene_path, stage.demand, render);
        self.temporal = temporal;
        let (plan, uploads, environment_sun) = self.prepare(scene, path, &scene_path, &temporal)?;
        let meshlets = self.plan_meshlets(&plan, path);
        let prepass = self.prepass_plan(stage, meshlets.is_some(), plan.cascades.is_some(), &temporal);
        let spec = self.target_spec(&scene_path, prepass.as_ref(), &temporal);
        self.targets = pooled_targets(&mut self.pool, &self.device, (self.width, self.height), render, self.samples, &spec)?;
        self.ensure_hdr(&scene_path)?;
        if let Some(prepass) = &prepass {
            self.ensure_prepass(&scene_path, prepass.draws.len(), spec.motion)?;
        }
        self.ensure_temporal(&scene_path)?;
        self.ensure_variants(&plan, &scene_path, prepass.as_ref(), spec.motion)?;
        self.prepare_terrain(&plan, &scene_path, prepass.as_ref(), spec.motion)?;
        self.prepare_grass(&plan, &scene_path, prepass.as_ref(), spec.motion)?;
        self.path = scene_path;
        let meshlets = self.prepare_meshlets(meshlets, prepass.is_some())?;
        let consumers = prepass.as_ref().map_or(PrepassConsumers::NONE, |prepass| prepass.consumers);
        let ao = self.frame_ao().filter(|_| consumers.contains(PrepassConsumers::AO)).map(|settings| settings.quality);
        let contact = consumers.contains(PrepassConsumers::CONTACT_SHADOWS);
        // Renderer pass 2, B.7: the sun-shadow mask runs beside the contact shadows where the
        // quality draws PCSS on the HDR scene under TAA.
        let sun_mask = crate::post::sun_mask::key(&self.quality, scene_path.hdr, scene_path.taa);
        self.effects.get_mut().prepare(&self.device, &mut self.pool, render, ao.as_ref(), contact, sun_mask)?;
        self.sky.get_mut().begin_frame();
        self.prepare_bloom()?;
        let groups = self.ensure_groups();
        if !scene_path.hdr {
            self.ensure_upscale()?;
        }
        let motion = self.motion_row.take().zip(self.motion_group(&spec)).map(|(row, (group, meshlet_group))| FrameMotion { row, group, meshlet_group });
        let reactive_group = self.reactive.as_ref().filter(|_| spec.motion).map(|reactive| reactive.node.group(&self.device, self.tables.prev_models.get()));
        Ok(FramePrep { plan, environment_sun, uploads, path, clear: scene.clear, groups, prepass, meshlets, camera: scene.camera, motion, reactive_group })
    }

    /// The part-1 nodes of the frame `prep`.
    pub(crate) fn world_nodes<'a>(&'a self, prep: &'a FramePrep) -> WorldNodes<'a> {
        let mut stats = frame_stats(&prep.plan);
        if let Some(meshlets) = &prep.meshlets {
            stats.meshlet_candidates = meshlets.frame.candidates;
            stats.meshlet_views = meshlets.frame.views;
            stats.occlusion = meshlets.frame.occlusion;
        }
        WorldNodes { renderer: self, prep, stats, world: None, resolved: false, prepass: None, baked_groups: None, taa: None, taa_copied: false }
    }

    /// Keep what the frame `prep` drew (stats, the world pass, the CPU cull, the scene path).
    pub(crate) fn end_frame(&mut self, prep: FramePrep, done: WorldDone) {
        if self.temporal.taa {
            let last = TemporalLast { jitter_px: self.temporal.jitter_px, pre_exposure: self.path.pre_exposure };
            self.temporal_last[set_index(self.temporal.set)] = Some(last);
        }
        self.stats = done.stats;
        self.last_world = done.world;
        self.last_prepass = done.prepass;
        self.last_cpu = prep.uploads.cpu_culls.into_iter().next();
        self.last_path = Some(self.path);
        self.last_meshlets = prep.meshlets.map(|meshlets| meshlets.frame);
    }

    fn encode_cull(&self, encoder: &mut wgpu::CommandEncoder, plan: &FramePlan) {
        self.encode_cull_timed(encoder, plan, None);
    }

    /// [`Renderer::encode_cull`] with the cull pass's timestamp writes (a cost row).
    fn encode_cull_timed(&self, encoder: &mut wgpu::CommandEncoder, plan: &FramePlan, timestamps: Option<wgpu::ComputePassTimestampWrites<'_>>) {
        if plan.batches.is_empty() {
            return;
        }
        let buffers = CullBuffers {
            views: &self.cull_views,
            instances: self.tables.instances.get(),
            batches: self.tables.batches.get(),
            visible: self.tables.visible.get(),
            args: self.tables.args.get(),
            scratch: self.tables.cull_scratch.get(),
        };
        self.cull.encode(&self.device, encoder, &buffers, plan.visible_slots, plan.views, timestamps);
    }

    /// The frame's meshlet candidates (R2), before occlusion is decided: None when the game's
    /// meshlets or the quality's switch are off, on the CPU-culled reference path, when no opaque
    /// batch draws a clustered mesh, or when not even the camera's compacted indices fit a storage
    /// binding (every batch then draws whole).
    fn plan_meshlets(&self, plan: &FramePlan, path: CullPath) -> Option<MeshletFrame> {
        let (drawn, _) = self.meshlet_game.drawn(&self.quality);
        if !drawn || !crate::meshlet_cull::LANDED || path != CullPath::Gpu {
            return None;
        }
        let mut frame = MeshletFrame::plan(plan, &self.library)?;
        // The spots' views draw their casters on the instance path.
        let wanted = plan.views - plan.spot_shadows.len() as u32;
        let views = frame.fit(&plan.cull_views.planes, wanted, &plan.instances, &self.device.limits());
        (views > 0).then_some(frame)
    }

    /// Decide occlusion for `frame` (it needs the prepass the frame runs: `prepass`), acquire the
    /// Hi-Z pyramid, make the cull and the draw pipelines on first use, size the cull's buffers and
    /// pick the visibility history the frame reads and writes.
    /// A frame without meshlets drops the working buffers and the Hi-Z (their bytes go to 0),
    /// except while a capture re-renders: Live's history and buffers are never a capture's to drop.
    /// Occlusion needs a one-sample world pass: over MSAA its Hi-Z, built from the single-sample
    /// prepass, would cull meshlets seen only through an edge pixel's uncovered samples.
    fn prepare_meshlets(&mut self, frame: Option<MeshletFrame>, prepass: bool) -> Result<Option<FrameMeshlets>, RenderError> {
        let Some(mut frame) = frame else {
            if self.environment_settle {
                return Ok(None);
            }
            self.release_hiz();
            if self.meshlet_game.drawn(&self.quality).0 {
                // Meshlets stay on and this scene has none to draw: keep the buffers.
                if let Some(node) = self.meshlet_node.as_mut() {
                    node.reset_history();
                }
                return Ok(None);
            }
            if let Some(node) = self.meshlet_node.as_mut() {
                node.release();
            }
            self.drop_meshlet_tables()?;
            return Ok(None);
        };
        let (_, occlusion) = self.meshlet_game.drawn(&self.quality);
        let allowed = NodeId::Occlusion.landed() && crate::graph::quality_allows(NodeId::Occlusion, &self.quality);
        frame.occlusion = occlusion && prepass && self.samples == 1 && allowed;
        if self.meshlet_node.is_none() {
            self.meshlet_node = Some(MeshletCullNode::new(&self.device)?);
        }
        if frame.occlusion {
            let render = self.targets.render_size;
            let pyramid = self.pool.acquire(&self.device, crate::hiz::target(render))?;
            self.hiz_pyramid = Some(HizPyramid { texture: pyramid.texture().clone(), view: pyramid.view().clone() });
            let hiz = self.hiz.get_mut();
            if hiz.is_none() {
                *hiz = Some(HizNode::new(&self.device)?);
            }
        } else if !self.environment_settle {
            self.release_hiz();
        }
        self.ensure_meshlet_pipelines()?;
        let Some(node) = self.meshlet_node.as_mut() else { return Ok(None) };
        let externals = CullExternals {
            views: &self.cull_views,
            frame: &self.frame_uniforms,
            instances: self.tables.instances.get(),
            vertices: &self.meshes.vertices,
            library: &self.meshes.meshlets,
            hiz: self.hiz_pyramid.as_ref().map(|pyramid| &pyramid.view),
        };
        if node.prepare(&self.device, &frame, &externals).is_err() {
            // Working buffers this frame cannot have: it draws every batch whole instead.
            node.reset_history();
            return Ok(None);
        }
        let history = node.history(&frame, self.environment_settle);
        Ok(Some(FrameMeshlets { frame, history }))
    }

    /// Drop the Hi-Z pyramid (its ledger row goes to 0) and the build's cached bind groups.
    fn release_hiz(&mut self) {
        if self.hiz_pyramid.take().is_some() {
            self.pool.release(crate::hiz::HIZ_LABEL);
        }
        if let Some(node) = self.hiz.get_mut().as_mut() {
            node.release();
        }
    }

    /// The meshlet draw pipelines for this frame's scene (made again when its format, depth
    /// convention, surface constants or samples change).
    fn ensure_meshlet_pipelines(&mut self) -> Result<(), RenderError> {
        let key = MeshletPipelineKey {
            format: self.path.format,
            reversed: self.path.depth_reversed,
            surface: self.surface_key(self.path.hdr),
            samples: self.samples,
            casters: self.casters,
            motion: self.temporal.motion && self.motion_node.is_some(),
        };
        if self.meshlet_pipelines.as_ref().is_some_and(|(made, _)| *made == key) {
            return Ok(());
        }
        let Some(node) = self.meshlet_node.as_ref() else { return Ok(()) };
        let constants = surface_constants(key.reversed, key.format, key.surface);
        let spec = MeshletPipelineSpec {
            format: key.format,
            samples: key.samples,
            reversed: key.reversed,
            forward_constants: &constants,
            casters: key.casters,
            motion: self.motion_node.as_ref().filter(|_| key.motion).map(MotionNode::meshlet_layout),
        };
        let layouts = MeshletDrawLayouts { frame: &self.layouts.frame, pass: &self.layouts.pass, shadow: &self.layouts.shadow };
        self.meshlet_pipelines = Some((key, MeshletPipelines::new(&self.device, node, layouts, &spec)?));
        Ok(())
    }

    /// The meshlet draw pipelines of this frame.
    fn meshlet_pipelines(&self) -> Option<&MeshletPipelines> {
        self.meshlet_pipelines.as_ref().map(|(_, pipelines)| pipelines)
    }

    /// Queue the meshlet cull's uniforms and candidate table (graph node 1).
    fn write_meshlets(&self, queue: &Queue, prep: &FramePrep) {
        if let (Some(meshlets), Some(node)) = (&prep.meshlets, &self.meshlet_node) {
            node.write(queue, &meshlets.frame, meshlets.history, self.targets.render_size, self.path.depth_reversed);
        }
    }

    /// Draw `view`'s meshlets of argument slot `slot` with `pipeline` over `group` (the frame
    /// group, or the shadow group for casters), then give the pass back the library's indices.
    /// False when nothing was drawn.
    fn draw_meshlets(&self, pass: &mut RenderPass<'_>, group: &BindGroup, pass_views: &BindGroup, view: u32, slot: ArgsSlot, pipeline: &RenderPipeline) -> bool {
        let Some(node) = &self.meshlet_node else { return false };
        let (Some(meshlet_group), Some((indices, args))) = (node.draw_group(), node.draw_buffers()) else { return false };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.set_bind_group(1, pass_views, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
        pass.set_bind_group(crate::layout::MESHLET_DRAW_GROUP, meshlet_group, &[]);
        pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed_indirect(args, crate::meshlet_cull::args_offset(view, slot));
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        true
    }

    /// Graph node 8: the Hi-Z of the prepass depth, cull pass 2 against it and prepass part 2 (the
    /// meshlets pass 2 found, drawn over pass 1's depth and normals). False when nothing ran.
    fn encode_occlusion(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> bool {
        let meshlets = prep.meshlets.as_ref().filter(|meshlets| meshlets.frame.occlusion);
        let (Some(meshlets), Some(targets), Some(node), Some(pyramid), Some(pipelines)) =
            (meshlets, &self.targets.prepass, &self.meshlet_node, &self.hiz_pyramid, self.meshlet_pipelines())
        else {
            return false;
        };
        let queue = frame.queue().clone();
        let mut hiz = self.hiz.borrow_mut();
        let Some(build) = hiz.as_mut() else { return false };
        let input = HizInput { depth: &targets.depth_view, pyramid: &pyramid.texture, render: self.targets.render_size, reduce: crate::hiz::reduction(self.path.depth_reversed) };
        if build.encode(&self.device, &queue, frame.encoder(), input).is_err() {
            return false;
        }
        node.encode(frame.encoder(), &meshlets.frame, MeshletPass::Second);
        let load = wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store };
        let attachment = |view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: load });
        // A frame writing motion draws pass 2's meshlets into the motion and the reactive mask too.
        let colors = match (&targets.motion, &targets.reactive, &prep.motion) {
            (Some((_, motion)), Some((_, reactive)), Some(_)) => vec![attachment(&targets.normals_view), attachment(motion), attachment(reactive)],
            _ => vec![attachment(&targets.normals_view)],
        };
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("prepass part 2"),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &targets.depth_view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        let pipeline = self.meshlet_prepass_pipeline(pipelines, &mut pass, prep);
        self.draw_meshlets(&mut pass, &prep.groups.frame, &prep.groups.pass, 0, ArgsSlot::Second, pipeline);
        true
    }

    /// Draw the game's meshes as meshlets from now on per `meshlets` (R2): which meshes cluster
    /// and whether occlusion may cull them. The quality's switches still decide whether a device
    /// runs either. Clustering is lazy: the library clusters the first time a quality draws
    /// meshlets ([`Renderer::set_quality`]), so a device on the instance path clusters nothing and
    /// holds no meshlet tables, and it then stays clustered, so a capture's pinned quality or a
    /// settings toggle never re-clusters back and forth. A change of what the game clusters
    /// re-clusters the library, uploads its meshlet buffers and forgets the visibility history; an
    /// occlusion-only change moves no cluster.
    pub fn set_meshlets(&mut self, gpu: &Gpu, meshlets: Meshlets) -> Result<(), RenderError> {
        self.meshlet_game = meshlets;
        self.follow_meshlet_setting();
        self.upload_meshlets(&gpu.device, &gpu.queue)
    }

    /// The game's meshlet setting ([`Renderer::set_meshlets`]); the library's own
    /// ([`MeshLibrary::meshlet_setting`]) has meshlets off until a quality draws them.
    pub fn meshlet_setting(&self) -> Meshlets {
        self.meshlet_game
    }

    /// Re-cluster the library CPU-side when it should cluster other meshes: the first quality
    /// that draws meshlets, or a change of the game's clustering once it clusters. The buffers go
    /// up before the next frame.
    fn follow_meshlet_setting(&mut self) {
        let held = self.library.meshlet_setting();
        let draws = self.meshlet_game.drawn(&self.quality).0 && crate::meshlet_cull::LANDED;
        let wanted = if draws || held.enabled { self.meshlet_game } else { self.meshlet_game.with_enabled(false) };
        if held == wanted {
            return;
        }
        self.library.set_meshlets(wanted);
        if !held.same_clusters(&wanted) {
            self.meshlet_upload_pending = true;
            self.reset_meshlet_history();
        }
    }

    /// Upload the library's meshlet tables when frames draw meshlets and the GPU's are not the
    /// library's (it re-clustered, or they were dropped).
    fn upload_meshlets(&mut self, device: &Device, queue: &Queue) -> Result<(), RenderError> {
        if !self.meshlet_upload_pending || !self.meshlet_game.drawn(&self.quality).0 {
            return Ok(());
        }
        self.meshes.meshlets = MeshletBuffers::upload(device, queue, self.library.meshlets())?;
        self.meshlet_upload_pending = false;
        Ok(())
    }

    /// Give the GPU's meshlet tables back while no frame draws meshlets (the CPU clusters stay, so
    /// turning meshlets on again uploads them without clustering again).
    fn drop_meshlet_tables(&mut self) -> Result<(), RenderError> {
        if self.meshlet_upload_pending || self.library.meshlets().meshlets.is_empty() {
            return Ok(());
        }
        self.meshes.meshlets = MeshletBuffers::upload(&self.device, &self.queue, &crate::meshlet::MeshletLibrary::default())?;
        self.meshlet_upload_pending = true;
        Ok(())
    }

    /// Forget the far-cascade cadence's held shadow maps: the next frame redraws every cascade (a
    /// history reset: a camera cut, a teleport). A settled capture's re-renders never leave theirs
    /// to Live ([`CascadeHistory`]).
    pub fn reset_shadow_history(&mut self) {
        self.shadow_history.reset();
        self.spot_slots.reset();
    }

    /// Forget the meshlet visibility history: the next frame's cull pass 1 draws nothing and pass
    /// 2 finds everything in view (a camera cut, a teleport). Captures never read it.
    pub fn reset_meshlet_history(&mut self) {
        if let Some(node) = self.meshlet_node.as_mut() {
            node.reset_history();
        }
    }

    /// What the last frame drew through meshlets (None: it drew none).
    pub fn last_meshlets(&self) -> Option<&MeshletFrame> {
        self.last_meshlets.as_ref()
    }

    /// Bytes the meshlet path holds on the GPU: the library's meshlet tables while they are up,
    /// and the cull's working buffers (compacted indices, drawn slots, keep counts, visibility
    /// bitsets). Both go once a frame draws no meshlets, so this is 0 on the instance path.
    pub fn meshlet_bytes(&self) -> u64 {
        let tables_up = !self.meshlet_upload_pending && !self.library.meshlets().meshlets.is_empty();
        let library = if tables_up { self.meshes.meshlets.bytes() } else { 0 };
        library + self.meshlet_node.as_ref().map_or(0, MeshletCullNode::bytes)
    }

    /// The GPU buffers this renderer holds now, under [`crate::budget::BudgetKind::Buffers`] by
    /// label (renderer pass 2 A.0, LG-13): every frame table, the mesh library, the frame's
    /// uniforms, last frame's skinned vertices and the light binning's and meshlet path's own
    /// buffers; and the look's grading LUT under [`crate::budget::BudgetKind::Ibl`] (A.2). What
    /// the budget fit reads beside its targets (`BudgetInput::with_buffers`).
    pub fn buffer_ledger(&self) -> crate::budget::BudgetLedger {
        use crate::budget::BudgetKind::Buffers;
        let mut ledger = crate::budget::BudgetLedger::new();
        for (label, bytes) in self.tables.held() {
            ledger.register(Buffers, label, bytes);
        }
        let meshes = &self.meshes;
        let fixed = [
            ("mesh vertices", &meshes.vertices),
            ("mesh slots", &meshes.slots),
            ("mesh indices", &meshes.indices),
            ("mesh skin", &meshes.skin),
            ("frame uniforms", &self.frame_uniforms),
            ("background", &self.background),
            ("cull views", &self.cull_views),
            ("fog row", &self.fog_row),
        ];
        for (label, buffer) in fixed {
            ledger.register(Buffers, label, buffer.size());
        }
        if let Some(previous) = &self.skinned_prev.buffer {
            ledger.register(Buffers, "previous skinned vertices", previous.size());
        }
        if let Some(node) = self.light_bins.borrow().as_ref() {
            for (label, bytes) in node.buffers() {
                ledger.register(Buffers, label, bytes);
            }
        }
        let meshlets = self.meshlet_bytes();
        if meshlets > 0 {
            ledger.register(Buffers, "meshlet tables and cull", meshlets);
        }
        // The look's 3D grading LUT (A.2), a texture outside the target pool.
        let lut = self.post.borrow().as_ref().map_or(0, |(tonemap, _)| tonemap.grading_lut_bytes());
        if lut > 0 {
            ledger.register(crate::budget::BudgetKind::Ibl, crate::budget::GRADING_LUT_LABEL, lut);
        }
        // The terrain's row, maps, rows and grid (A.7).
        let terrain = self.terrain_bytes();
        if terrain > 0 {
            ledger.register(Buffers, crate::terrain::TERRAIN_LEDGER_LABEL, terrain);
        }
        // The grass's row, tile regions, counts, arguments and order (A.8).
        let grass = self.grass_bytes();
        if grass > 0 {
            ledger.register(Buffers, crate::foliage::GRASS_LEDGER_LABEL, grass);
        }
        // The reflection probes' cubes, capture targets and rows (A.3), outside the target pool.
        let probes = self.environment.borrow().probes().bytes();
        if probes > 0 {
            ledger.register(crate::budget::BudgetKind::Ibl, crate::budget::REFLECTION_PROBES_LABEL, probes);
        }
        // The irradiance volumes' atlas, staging block and bake targets (A.4), outside the pool.
        let volumes = self.environment.borrow().irradiance().bytes();
        if volumes > 0 {
            ledger.register(crate::budget::BudgetKind::Ibl, crate::budget::IRRADIANCE_VOLUMES_LABEL, volumes);
        }
        ledger
    }

    /// The budget's model of the buffers drawing `scene` makes this renderer hold
    /// ([`crate::budget::buffer_model`] of the frame's counts under the current quality; LG-13),
    /// computed on the CPU without drawing.
    pub fn buffer_model(&self, scene: &Scene) -> Result<u64, RenderError> {
        let aspect = self.width as f32 / self.height as f32;
        let quality = &self.quality.shadows;
        let shadows = quality.enabled.then(|| ShadowSettings::from_quality(quality, scene.lighting.shadow_distance, self.environment_choice.sun_angular_radius()));
        let plan = FramePlan::build_with(scene, &self.library, aspect, &PlanOptions { shadows, depth_reversed: false, sun: None })?;
        let binned = (crate::lights::BINNED_SHADING_LANDED && self.quality.lights.clustered)
            .then(|| crate::lights::binned_frame(&scene.lighting, &self.quality.lights, &scene.camera, self.render_size()));
        // The decals (A.10) ride in the `light_ext` table after the lights' rows and every shadowed
        // spot's matrix slot: the table holds `decals::append_rows` of the lights' bytes.
        let ext_bytes = |binned: &crate::lights::BinnedFrame| {
            let lights_bytes = std::mem::size_of_val(binned.ext.as_slice());
            if binned.decals.is_empty() {
                return lights_bytes as u64;
            }
            let rows_bytes = crate::decals::rows_base(binned.ext.len()) * size_of::<glam::Vec4>();
            (rows_bytes.max(lights_bytes) + std::mem::size_of_val(binned.decals.as_slice())) as u64
        };
        let (lights, light_ext_bytes, light_bin_bytes) = binned.as_ref().map_or((plan.lights.len(), 0, 0), |binned| {
            (binned.lights.len(), ext_bytes(binned), crate::cluster::bins_bytes(&binned.bins.grid))
        });
        let counts = crate::budget::BufferCounts {
            instances: plan.instances.len() as u64,
            opaque_instances: u64::from(plan.visible_slots),
            transparent: plan.transparent.len() as u64,
            views: u64::from(plan.views),
            batches: plan.batches.len() as u64,
            materials: plan.materials.len() as u64,
            lights: lights as u64,
            light_ext_bytes,
            light_bin_bytes: light_bin_bytes.max(u64::from(crate::cluster::LIGHT_TILES_OFFSET_WORDS) * 4 + 4),
            pass_views: u64::from(plan.views) + plan.transparent.len() as u64,
            slot_base: plan.slot_base.len() as u64,
            motion: false,
            vertices: self.library.vertices().len() as u64,
            indices: self.library.indices().len() as u64,
            skin_vertices: self.library.skin().len() as u64,
        };
        Ok(crate::budget::buffer_model(&counts))
    }

    /// Read the last meshlet frame's cull back (diagnostics and tests): each pass's kept meshlets
    /// and indices, the drawn slots and every visibility bitset.
    pub fn read_meshlets(&self, gpu: &Gpu) -> Result<MeshletReadback, RenderError> {
        let (Some(frame), Some(node)) = (&self.last_meshlets, &self.meshlet_node) else {
            return Err(crate::readback::capture_failed("the last frame drew no meshlets"));
        };
        node.read(gpu, frame)
    }

    fn encode_skinning(&self, encoder: &mut wgpu::CommandEncoder, plan: &FramePlan) {
        let Some(most) = plan.skin_jobs.iter().map(|job| job.count).max() else { return };
        // Last frame's skinned vertices, kept for the motion prepass before they are overwritten.
        if let Some(previous) = self.skinned_prev.buffer.as_ref().filter(|_| self.skinned_prev.copy > 0) {
            encoder.copy_buffer_to_buffer(self.tables.skinned.get(), 0, previous, 0, self.skinned_prev.copy);
        }
        let buffers = SkinBuffers {
            source: &self.meshes.vertices,
            skin: &self.meshes.skin,
            joints: self.tables.joints.get(),
            jobs: self.tables.skin_jobs.get(),
            output: self.tables.skinned.get(),
            output_slots: self.tables.skinned_slots.get(),
        };
        self.skinning.encode(&self.device, encoder, &buffers, plan.skin_jobs.len() as u32, most);
    }

    /// Draw `scene` into the world target. A refusal (unknown mesh, mismatched skin, upload
    /// budget, buffer cap) comes before any GPU write, so the target keeps the previous frame.
    pub fn render(&mut self, gpu: &Gpu, scene: &Scene, path: CullPath) -> Result<(), RenderError> {
        self.render_staged(gpu, scene, path, &mut NoStage)
    }

    /// [`Renderer::render`] with `stage`'s compute work ahead of the world pass and its draws
    /// inside it: one run of the frame graph, one submission.
    pub fn render_staged(&mut self, gpu: &Gpu, scene: &Scene, path: CullPath, stage: &mut dyn WorldStage) -> Result<(), RenderError> {
        let prepass = StagePrepass { demand: ExtensionDemand::default(), draws: stage.prepass_draws() };
        let prep = self.begin_frame_prepass(scene, path, stage.ldr_reason(), prepass)?;
        let mut frame = FrameEncoder::new(&self.device, &gpu.queue, "frame");
        let mut staged = Staged { nodes: self.world_nodes(&prep), stage };
        let ran = crate::graph::run(&mut staged, &mut frame);
        frame.submit();
        let done = staged.nodes.finish();
        ran?;
        self.end_frame(prep, done);
        Ok(())
    }

    /// [`Renderer::render_staged`] with a custom stage whose `post-hdr` passes run at graph node 18
    /// on the HDR scene (before exposure and the tonemap; the resolved 1x scene is kept for them).
    pub(crate) fn render_custom(&mut self, gpu: &Gpu, scene: &Scene, path: CullPath, stage: &mut dyn CustomStage) -> Result<(), RenderError> {
        self.set_hdr_scene_readers(stage.runs(PassStage::PostHdr));
        let demand = stage.prepass_demand();
        let prep = self.begin_frame_prepass(scene, path, stage.ldr_reason(), StagePrepass { demand, draws: stage.prepass_draws() })?;
        let mut frame = FrameEncoder::new(&self.device, &gpu.queue, "frame");
        let mut staged = CustomStaged { nodes: self.world_nodes(&prep), stage };
        let ran = crate::graph::run(&mut staged, &mut frame);
        frame.submit();
        let done = staged.nodes.finish();
        ran?;
        self.end_frame(prep, done);
        Ok(())
    }

    /// Upload `scene`'s tables and run only the compute cull, waiting for it (the timing row).
    pub fn cull_only(&mut self, gpu: &Gpu, scene: &Scene) -> Result<(), RenderError> {
        let scene_path = self.scene_path(self.render_size(), None);
        let (plan, uploads, _) = self.prepare(scene, CullPath::Gpu, &scene_path, &FrameTemporal::NONE)?;
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cull only") });
        self.write_uploads(&mut encoder, &uploads, &plan, &[]);
        self.encode_cull(&mut encoder, &plan);
        gpu.queue.submit([encoder.finish()]);
        #[cfg(not(target_arch = "wasm32"))]
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| crate::readback::capture_failed(e.to_string()))?;
        Ok(())
    }

    /// The GPU milliseconds of `scene`'s instance cull (graph node 2), one per sample of
    /// `samples`, from timestamps around its compute pass after one upload of the frame's tables;
    /// None without `TIMESTAMP_QUERY`. The cull cost rows (renderer pass 2 A.0, LG-06) read it.
    pub fn cull_gpu_ms(&mut self, gpu: &Gpu, scene: &Scene, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
        if !self.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return Ok(None);
        }
        let scene_path = self.scene_path(self.render_size(), None);
        let (plan, uploads, _) = self.prepare(scene, CullPath::Gpu, &scene_path, &FrameTemporal::NONE)?;
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cull cost uploads") });
        self.write_uploads(&mut encoder, &uploads, &plan, &[]);
        gpu.queue.submit([encoder.finish()]);
        let query_set = self.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("cull cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
        let resolve = crate::tables::buffer(&self.device, "cull cost resolve", 16, wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC)?;
        let period = gpu.queue.get_timestamp_period();
        let mut costs = Vec::with_capacity(samples as usize);
        for _ in 0..samples {
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cull cost") });
            let stamps = wgpu::ComputePassTimestampWrites { query_set: &query_set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) };
            self.encode_cull_timed(&mut encoder, &plan, Some(stamps));
            gpu.queue.submit([encoder.finish()]);
            // Resolved in a later submission: Metal resolves counter samples without waiting for
            // the passes that write them (timing.rs).
            gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| crate::readback::capture_failed(e.to_string()))?;
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cull cost resolve") });
            encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
            gpu.queue.submit([encoder.finish()]);
            let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
            let ticks: Vec<u64> = bytemuck::pod_collect_to_vec(&crate::readback::map_read_blocking(gpu, &staging, 16)?[..16]);
            if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
                costs.push(ms);
            }
        }
        Ok(Some(costs))
    }

    /// What the frame bind groups bind right now.
    fn groups_key(&self) -> GroupsKey {
        let t = &self.tables;
        GroupsKey {
            buffers: [
                t.instances.get().clone(),
                t.materials.get().clone(),
                t.visible.get().clone(),
                t.slot_base.get().clone(),
                t.lights.get().clone(),
                t.pass_views.get().clone(),
                t.light_ext.get().clone(),
                t.light_bins.get().clone(),
                t.material_ext.get().clone(),
            ],
            views: (self.shadow_maps.array.clone(), self.texture_views()),
            environment: self.environment.borrow().generation(),
            effects: self.effect_views(),
            anisotropy: self.texture_anisotropy,
        }
    }

    /// The frame bind groups, rebuilt only when a table or texture array they bind was replaced.
    /// A rebuild drops the mid-frame sets bound to what it replaced (renderer pass 2, RC-07: they
    /// held the old shadow array, material arrays and tables alive outside the ledger until four
    /// newer sets came); the sets of the same tables and arrays, AO's alternating terms, stay.
    fn ensure_groups(&mut self) -> FrameGroups {
        let key = self.groups_key();
        if let Some((held, groups)) = &self.groups
            && *held == key
        {
            return groups.clone();
        }
        self.refreshed_groups.get_mut().retain(|(held, _)| held.same_resources(&key));
        let groups = self.frame_groups();
        self.groups = Some((key, groups.clone()));
        groups
    }

    /// The screen effects' views bound now: the AO term, the contact-shadow mask and the
    /// aerial-perspective volume node 11 wrote this frame (each neutral where its node did not run).
    fn effect_views(&self) -> [TextureView; 3] {
        let effects = self.effects.borrow();
        let [ao, contact] = effects.views();
        let aerial = self.sky.borrow().aerial_view().cloned().unwrap_or_else(|| effects.neutral_volume().clone());
        [ao, contact, aerial]
    }

    /// The frame groups for what is bound right now, made mid-frame after a node replaced a view
    /// they bind (AO's term, the contact-shadow mask, a new environment bake): the frame's own
    /// when nothing moved, else the last few such groups kept, so AO's alternating history terms
    /// make no bind group per frame.
    fn current_groups(&self) -> FrameGroups {
        let key = self.groups_key();
        if let Some((held, groups)) = &self.groups
            && *held == key
        {
            return groups.clone();
        }
        let mut refreshed = self.refreshed_groups.borrow_mut();
        if let Some((_, groups)) = refreshed.iter().find(|(held, _)| *held == key) {
            return groups.clone();
        }
        let groups = self.frame_groups();
        if refreshed.len() >= REFRESHED_GROUPS_KEPT {
            refreshed.remove(0);
        }
        refreshed.push((key, groups.clone()));
        groups
    }

    fn frame_groups(&self) -> FrameGroups {
        let t = &self.tables;
        let environment = self.environment.borrow();
        let mut entries = vec![
            entry(0, &self.frame_uniforms),
            entry(1, t.instances.get()),
            entry(2, t.materials.get()),
            entry(3, t.visible.get()),
            entry(4, t.slot_base.get()),
            entry(5, t.lights.get()),
            wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&self.shadow_maps.array) },
            wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&self.shadow_sampler) },
            wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(self.textures.view(TextureClass::S256, TextureKind::Color)) },
            wgpu::BindGroupEntry { binding: 9, resource: wgpu::BindingResource::TextureView(self.textures.view(TextureClass::S256, TextureKind::Data)) },
            wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::Sampler(&self.texture_sampler) },
        ];
        entries.extend(
            FRAME_ENV_BOUND.into_iter().filter_map(|(binding, name)| environment.binding(name).map(|resource| wgpu::BindGroupEntry { binding, resource })),
        );
        let [ao_term, contact_mask, aerial_volume] = self.effect_views();
        let [(fog, _), (ao, _), (aerial, _), (point, _), (contact, _)] = FRAME_EFFECT_BOUND;
        entries.extend([
            entry(fog, &self.fog_row),
            wgpu::BindGroupEntry { binding: point, resource: wgpu::BindingResource::Sampler(&self.point_sampler) },
            wgpu::BindGroupEntry { binding: ao, resource: wgpu::BindingResource::TextureView(&ao_term) },
            wgpu::BindGroupEntry { binding: aerial, resource: wgpu::BindingResource::TextureView(&aerial_volume) },
            wgpu::BindGroupEntry { binding: contact, resource: wgpu::BindingResource::TextureView(&contact_mask) },
        ]);
        let [light_ext, light_bins, material_ext] = FRAME_LIGHT_BINDINGS.map(|(binding, _)| binding);
        entries.extend([entry(light_ext, t.light_ext.get()), entry(light_bins, t.light_bins.get()), entry(material_ext, t.material_ext.get())]);
        let class_views = MATERIAL_CLASS_ARRAYS.map(|(class, kind)| self.textures.view(class, kind));
        entries.extend(FRAME_MATERIAL_CLASS_BINDINGS.into_iter().zip(class_views).map(|((binding, _), view)| wgpu::BindGroupEntry {
            binding,
            resource: wgpu::BindingResource::TextureView(view),
        }));
        let frame = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("frame"), layout: &self.layouts.frame, entries: &entries });
        let color_classes = TextureClass::ALL.map(|class| self.textures.view(class, TextureKind::Color));
        let mut shadow_entries =
            vec![entry(0, &self.frame_uniforms), entry(1, t.instances.get()), entry(2, t.visible.get()), entry(3, t.slot_base.get())];
        shadow_entries.extend([entry(SHADOW_MASK_MATERIALS, t.materials.get()), entry(SHADOW_MASK_MATERIAL_EXT, t.material_ext.get())]);
        shadow_entries.extend(
            SHADOW_MASK_COLOR_ARRAYS.into_iter().zip(color_classes).map(|(binding, view)| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }),
        );
        shadow_entries.push(wgpu::BindGroupEntry { binding: SHADOW_MASK_SAMPLER, resource: wgpu::BindingResource::Sampler(&self.texture_sampler) });
        let shadow = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("shadow"), layout: &self.layouts.shadow, entries: &shadow_entries });
        let pass = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pass view"),
            layout: &self.layouts.pass,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: t.pass_views.get(),
                    offset: 0,
                    size: wgpu::BufferSize::new(size_of::<GpuPassView>() as u64),
                }),
            }],
        });
        let lines = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lines"),
            layout: &self.layouts.lines,
            entries: &[entry(0, &self.frame_uniforms)],
        });
        FrameGroups { frame, shadow, pass, lines }
    }

    /// Below scale 1: the upscale pipeline (made once) and its bind group over the scene target
    /// (rebuilt when the pool's generation moves, i.e. on a step change).
    fn ensure_upscale(&mut self) -> Result<(), RenderError> {
        let Some(scene) = self.targets.scene_linear.clone() else { return Ok(()) };
        if self.upscale.is_none() {
            self.upscale = Some(upscale_pipeline(&self.device)?);
        }
        let generation = self.pool.generation();
        let Some(upscale) = self.upscale.as_mut() else { return Ok(()) };
        if upscale.group.as_ref().is_some_and(|(held, _)| *held == generation) {
            return Ok(());
        }
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("upscale"),
            layout: &upscale.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&scene) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&upscale.sampler) },
            ],
        });
        upscale.group = Some((generation, group));
        Ok(())
    }

    /// Graph node 22: the scene stretched over the whole world target, one full-screen triangle.
    fn encode_upscale(&self, encoder: &mut wgpu::CommandEncoder) {
        let Some((upscale, (_, group))) = self.upscale.as_ref().and_then(|upscale| upscale.group.as_ref().map(|group| (upscale, group))) else {
            return;
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("upscale"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.targets.world_view,
                depth_slice: None,
                resolve_target: None,
                // The triangle covers every pixel: nothing to load.
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&upscale.pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// The opaque batches of `view`: one multi-draw per vertex source from the view's indirect
    /// arguments, or (`counts` given) the CPU cull's direct draws. Batches `meshlets` draws in this
    /// view are skipped (the multi-draw splits around them); the meshlet draw covers them.
    fn draw_batches(&self, pass: &mut RenderPass<'_>, plan: &FramePlan, view: u32, counts: Option<&[u32]>, meshlets: Option<&MeshletFrame>, stats: &mut FrameStats) {
        let total = plan.batches.len() as u32;
        // The plain batches; the variants' follow (`draw_*_variants`, P2-0.12).
        let sources = [
            (0..plan.static_batches, &self.meshes.vertices, &self.meshes.slots),
            (plan.static_batches..plan.plain_batches, self.tables.skinned.get(), self.tables.skinned_slots.get()),
        ];
        for (range, vertices, slots) in sources {
            if range.is_empty() {
                continue;
            }
            let runs = meshlets.map_or_else(|| vec![range.clone()], |frame| frame.whole_runs(view, range.clone()));
            if runs.is_empty() {
                continue;
            }
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.set_vertex_buffer(1, slots.slice(..));
            let Some(counts) = counts else {
                for run in runs {
                    let offset = (u64::from(view) * u64::from(total) + u64::from(run.start)) * ARGS_STRIDE;
                    pass.multi_draw_indexed_indirect(self.tables.args.get(), offset, run.len() as u32);
                    stats.multi_draws += 1;
                    stats.indirect_draws += run.len() as u32;
                }
                continue;
            };
            for i in range {
                let (batch, count) = (&plan.batches[i as usize], counts[i as usize]);
                if count > 0 {
                    pass.draw_indexed(batch.first_index..batch.first_index + batch.index_count, batch.base_vertex, 0..count);
                    stats.direct_opaque_draws += 1;
                }
            }
        }
    }

    /// Grant the frame's shadowed spots (RQ6.5) on the binned path: while the quality draws shadows,
    /// each slotted spot's map, matrix and cull view after the cascades', its slot held across Live's
    /// frames and faded as it changes hands (`spot_shadow::SpotSlots`; a settled capture picks afresh);
    /// otherwise every slot is cleared, so the forward pass reads no map that was not drawn. Makes
    /// the casters' pipelines on the first frame that draws a spot map.
    fn plan_spot_shadows(&mut self, plan: &mut FramePlan) -> Result<(), RenderError> {
        let eye = [plan.frame.camera_pos[0], plan.frame.camera_pos[1], plan.frame.camera_pos[2]];
        let Some(binned) = plan.binned.as_mut() else { return Ok(()) };
        let tile = crate::spot_shadow::tile_side(self.quality.shadows.map_size.max(1));
        let slots = usize::from(self.quality.lights.shadowed_spots);
        let tile = self.draws_spot_maps().then_some(tile);
        let spots = self.spot_slots.grant(binned, tile, slots, eye, self.frame_index, self.environment_settle);
        if spots.is_empty() {
            return Ok(());
        }
        let cascades = plan.cascades_drawn();
        plan.views = crate::spot_shadow::apply_views(&mut plan.frame, &mut plan.cull_views, cascades, &spots);
        plan.spot_shadows = spots;
        if self.spot_shadow.is_none() {
            self.spot_shadow = Some(crate::spot_shadow::SpotShadowPipelines::new(&self.device, &self.layouts.pass, &mesh_buffers_layout())?);
        }
        Ok(())
    }

    /// Whether this renderer's quality draws spot shadow maps: landed, binned (the legacy loop
    /// draws none), shadows on and slots granted by the preset.
    fn draws_spot_maps(&self) -> bool {
        let lights = &self.quality.lights;
        crate::spot_shadow::LANDED && lights.clustered && lights.shadowed_spots > 0 && self.quality.shadows.enabled
    }

    /// Whether the game asked for a shadowed spot under a quality that draws them (sticky): the
    /// shadow array then holds the spot atlas layer, and the budget counts it.
    pub fn uses_shadowed_spots(&self) -> bool {
        self.spot_atlas
    }

    /// Draw every shadowed spot's casters into its tile of the atlas layer (after the drawn
    /// cascades), in one pass, each through its cull view's arguments (`counts`: the CPU cull's,
    /// by spot, on the reference path).
    fn encode_spot_shadows(&self, encoder: &mut wgpu::CommandEncoder, prep: &FramePrep, counts: &[Option<&[u32]>], stats: &mut FrameStats) {
        let (plan, groups) = (&prep.plan, &prep.groups);
        let Some(pipelines) = self.spot_shadow.as_ref() else { return };
        let cascades = plan.cascades_drawn() as u32;
        let Some(layer) = self.shadow_maps.layers.get(crate::spot_shadow::spot_layer(cascades) as usize) else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("spot shadows"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: layer,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if plan.batches.is_empty() {
            return;
        }
        let t = &self.tables;
        let inputs = crate::spot_shadow::SpotShadowInputs {
            frame: &self.frame_uniforms,
            instances: t.instances.get(),
            visible: t.visible.get(),
            slot_base: t.slot_base.get(),
            light_ext: t.light_ext.get(),
        };
        pass.set_pipeline(pipelines.pipeline(self.shadow_desc.format));
        pass.set_bind_group(0, &pipelines.bind_group(&self.device, &inputs), &[]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        for (spot, counts) in plan.spot_shadows.iter().zip(counts) {
            let (x, y, side) = crate::spot_shadow::tile_rect(spot.slot, self.shadow_desc.side);
            pass.set_viewport(x as f32, y as f32, side as f32, side as f32, 0.0, 1.0);
            pass.set_scissor_rect(x, y, side, side);
            let view = crate::spot_shadow::spot_view(cascades, spot.slot);
            pass.set_bind_group(1, &groups.pass, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
            // The meshlet path never covers a spot's view: its casters draw whole.
            self.draw_batches(&mut pass, plan, view, *counts, None, stats);
            self.draw_spot_variants(&mut pass, &groups.pass, plan, view, *counts, stats);
        }
    }

    /// Size the shadow maps for `plan`'s settings (one layer per cascade, the settings' side and
    /// format, plus the spot atlas layer when spots are shadowed) and plan which cascades this frame redraws: a far cascade off its cadence keeps last
    /// frame's map and matrix ([`CascadeHistory`]); every cascade redraws on a settled capture's
    /// re-renders and after the maps change shape. A frame without sun shadows (switched off, an
    /// unlit sun) or shadowed spots drops the maps to the 1 px placeholder, so the renderer holds what the budget
    /// ledger counts (no shadow bytes), and resets the history.
    fn fit_shadow_maps(&mut self, plan: &mut FramePlan) {
        let cascades = match (plan.shadows, plan.cascades.is_some()) {
            (Some(settings), true) => Some(ShadowMapDesc::for_settings(&settings)),
            _ => None,
        };
        let settings = ShadowSettings::from_quality(&self.quality.shadows, 0.0, 0.0);
        // The atlas layer stays while the game uses shadowed spots and the quality draws them, so
        // a frame granting none (a spot switched off, behind the camera, past the cap) keeps the
        // array and the cascades' history.
        let atlas = plan.spot_shadows.len().max(usize::from(self.spot_atlas && self.draws_spot_maps()));
        let desc = crate::spot_shadow::map_desc(cascades, &settings, atlas);
        if desc != self.shadow_desc {
            self.shadow_maps = ShadowMaps::with_desc(&self.device, desc);
            self.shadow_desc = desc;
            // New maps hold no cascade: none can be held from the old ones (the spot layer came
            // or went while the cascades' shape stayed).
            self.shadow_history.reset();
        }
        self.shadow_draws = self.shadow_history.advance(plan, self.frame_index, self.environment_settle);
    }

    /// The shape of the shadow maps the renderer holds (the 1 px placeholder while no frame draws
    /// sun shadows).
    pub fn shadow_maps(&self) -> ShadowMapDesc {
        self.shadow_desc
    }

    fn encode_shadow(&self, encoder: &mut wgpu::CommandEncoder, prep: &FramePrep, cascade: usize, counts: Option<&[u32]>, stats: &mut FrameStats) {
        let (groups, plan) = (&prep.groups, &prep.plan);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("shadow cascade"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &self.shadow_maps.layers[cascade],
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        // The terrain's casters (A.7) and its grass's (A.8) before the batches' (they bind their
        // own groups).
        self.draw_terrain_casters(&mut pass, prep, cascade);
        self.draw_grass_casters(&mut pass, prep, cascade);
        if plan.batches.is_empty() {
            return;
        }
        let view = 1 + cascade as u32;
        let pipeline = if self.shadow_desc.format == ShadowFormat::Depth16.texture_format() { &self.pipelines.shadow16 } else { &self.pipelines.shadow };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &groups.shadow, &[]);
        pass.set_bind_group(1, &groups.pass, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        let meshlets = prep.meshlets.as_ref().map(|meshlets| &meshlets.frame);
        self.draw_batches(&mut pass, plan, view, counts, meshlets, stats);
        self.draw_caster_variants(&mut pass, &groups.pass, (plan, view), self.shadow_desc.format, counts, stats);
        let casters = self.meshlet_pipelines().map(|pipelines| if self.shadow_desc.format == ShadowFormat::Depth16.texture_format() { &pipelines.shadow16 } else { &pipelines.shadow });
        let caster_view = meshlets.is_some_and(|frame| view < frame.views);
        if let (true, Some(casters)) = (caster_view, casters)
            && self.draw_meshlets(&mut pass, &groups.shadow, &groups.pass, view, ArgsSlot::All, casters)
        {
            stats.meshlet_draws += 1;
        }
    }

    fn world_pass(&self) -> WorldPass<'_> {
        let [ao_term, contact_mask, aerial] = self.effect_views();
        WorldPass {
            frame_uniforms: &self.frame_uniforms,
            vertices: &self.meshes.vertices,
            indices: &self.meshes.indices,
            library: &self.library,
            samples: self.samples,
            instances: self.tables.instances.get(),
            materials: self.tables.materials.get(),
            lights: self.tables.lights.get(),
            light_ext: self.tables.light_ext.get(),
            light_bins: self.tables.light_bins.get(),
            shadow_map: &self.shadow_maps.array,
            shadow_sampler: &self.shadow_sampler,
            color_textures: self.textures.view(TextureClass::S256, TextureKind::Color),
            data_textures: self.textures.view(TextureClass::S256, TextureKind::Data),
            texture_sampler: &self.texture_sampler,
            scene_format: self.path.format,
            depth_reversed: self.path.depth_reversed,
            hdr: self.path.hdr,
            pre_exposure: self.path.pre_exposure,
            fog: &self.fog_row,
            env_specular: self.environment_specular(),
            env_sampler: self.environment.borrow().sampler().clone(),
            ao_term: ao_term.clone(),
            contact_mask,
            aerial,
        }
    }

    /// The environment's prefiltered specular cube the forward pass binds now.
    fn environment_specular(&self) -> TextureView {
        let environment = self.environment.borrow();
        match environment.binding("env_specular") {
            Some(wgpu::BindingResource::TextureView(view)) => view.clone(),
            _ => self.effects.borrow().neutral_cube().clone(),
        }
    }

    /// The world target (`Bgra8Unorm`, the resolved frame captures read).
    pub fn world_texture(&self) -> &Texture {
        &self.targets.world
    }

    /// A view of the world target, for the passes that draw after the world pass.
    pub fn world_view(&self) -> &TextureView {
        &self.targets.world_view
    }

    /// The colour texture array of size class 0 (`Rgba8UnormSrgb`, one layer per
    /// [`TextureKind::Color`] texture of that class): what immediate quads sample.
    pub fn color_texture_view(&self) -> &TextureView {
        self.textures.view(TextureClass::S256, TextureKind::Color)
    }

    /// The colour texture array of size class `class` (`Rgba8UnormSrgb`; a 1 × 1 placeholder
    /// before its first texture): immediate quads sample every class.
    pub fn color_class_view(&self, class: TextureClass) -> &TextureView {
        self.textures.view(class, TextureKind::Color)
    }

    /// The material texture views the frame group binds: class 0's colour and data arrays, then
    /// [`MATERIAL_CLASS_ARRAYS`]'.
    fn texture_views(&self) -> [TextureView; 8] {
        let base = [(TextureClass::S256, TextureKind::Color), (TextureClass::S256, TextureKind::Data)];
        let mut views = base.into_iter().chain(MATERIAL_CLASS_ARRAYS).map(|(class, kind)| self.textures.view(class, kind).clone());
        std::array::from_fn(|_| views.next().unwrap_or_else(|| unreachable!("eight material arrays")))
    }

    /// The repeating, mipped, linear sampler the texture arrays are drawn with.
    pub fn texture_sampler(&self) -> &Sampler {
        &self.texture_sampler
    }

    fn draw_transparent(&self, pass: &mut RenderPass<'_>, groups: &FrameGroups, plan: &FramePlan, stats: &mut FrameStats) {
        if plan.transparent_sources.is_empty() {
            return;
        }
        pass.set_pipeline(&self.scene_pipelines().blend);
        pass.set_bind_group(0, &groups.frame, &[]);
        for (k, source) in plan.transparent_sources.iter().enumerate() {
            let entry = u64::from(plan.views) + k as u64;
            pass.set_bind_group(1, &groups.pass, &[(entry * PASS_VIEW_STRIDE) as u32]);
            let (vertices, slots) = if source.skinned {
                (self.tables.skinned.get(), self.tables.skinned_slots.get())
            } else {
                (&self.meshes.vertices, &self.meshes.slots)
            };
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.set_vertex_buffer(1, slots.slice(..));
            pass.draw_indexed(source.first_index..source.first_index + source.index_count, source.base_vertex, 0..1);
            stats.transparent_draws += 1;
        }
    }

    /// What the last frame drew.
    pub fn last_stats(&self) -> FrameStats {
        self.stats
    }

    /// Read the world target back: BGRA, top row first, no swizzle (native; the web awaits
    /// [`Renderer::capture_async`]).
    pub fn capture(&self, gpu: &Gpu) -> Result<Capture, RenderError> {
        let (width, height) = self.drawn_size();
        let (staging, padded) = self.stage_capture(gpu, &self.targets.world, width, height)?;
        let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
        Capture::from_padded_rows(width, height, padded, &data)
    }

    /// The world target's size as the last frame drew it (an output size set since applies from
    /// the next frame on).
    fn drawn_size(&self) -> (u32, u32) {
        (self.targets.world.width(), self.targets.world.height())
    }

    /// [`Renderer::capture`] as a future: the browser maps the readback and wakes it.
    pub async fn capture_async(&self, gpu: &Gpu) -> Result<Capture, RenderError> {
        let (width, height) = self.drawn_size();
        let (staging, padded) = self.stage_capture(gpu, &self.targets.world, width, height)?;
        let data = map_read(gpu, &staging, u64::from(padded) * u64::from(height)).await?;
        Capture::from_padded_rows(width, height, padded, &data)
    }

    fn stage_capture(&self, gpu: &Gpu, texture: &Texture, width: u32, height: u32) -> Result<(Buffer, u32), RenderError> {
        // Refuse an oversize capture before allocating the readback.
        check_capture_size(width, height)?;
        let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let staging = buffer(&gpu.device, "capture", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("capture") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        Ok((staging, padded))
    }

    /// The camera view's indirect arguments the last GPU-path frame's cull wrote, one per batch.
    pub fn read_indirect_args(&self, gpu: &Gpu) -> Result<Vec<DrawIndexedArgs>, RenderError> {
        self.read_view_args(gpu, 0)
    }

    /// View `view`'s indirect arguments of the last GPU-path frame (0 the camera, 1 + c cascade c).
    pub fn read_view_args(&self, gpu: &Gpu, view: u32) -> Result<Vec<DrawIndexedArgs>, RenderError> {
        let bytes = u64::from(self.last.batches) * ARGS_STRIDE;
        if bytes == 0 || view >= self.last.views {
            return Ok(Vec::new());
        }
        let staging = stage_buffer(gpu, self.tables.args.get(), u64::from(view) * bytes, bytes)?;
        Ok(bytemuck::pod_collect_to_vec(&map_read_blocking(gpu, &staging, bytes)?))
    }

    /// View `view`'s region of the visible list the last GPU-path frame's cull wrote: one slot per
    /// opaque instance row, each batch's survivors at the start of its range (the rest unwritten).
    pub fn read_view_visible(&self, gpu: &Gpu, view: u32) -> Result<Vec<u32>, RenderError> {
        let bytes = u64::from(self.last.opaque_instances) * 4;
        if bytes == 0 || view >= self.last.views {
            return Ok(Vec::new());
        }
        let staging = stage_buffer(gpu, self.tables.visible.get(), u64::from(view) * bytes, bytes)?;
        Ok(bytemuck::pod_collect_to_vec(&map_read_blocking(gpu, &staging, bytes)?))
    }

    /// The vertices the last frame's compute skinning wrote, in job (skinned draw) order.
    pub fn read_skinned_vertices(&self, gpu: &Gpu) -> Result<Vec<Vertex>, RenderError> {
        let bytes = u64::from(self.last.skinned_vertices) * VERTEX_STRIDE;
        if bytes == 0 {
            return Ok(Vec::new());
        }
        let staging = stage_buffer(gpu, self.tables.skinned.get(), 0, bytes)?;
        Ok(bytemuck::pod_collect_to_vec(&map_read_blocking(gpu, &staging, bytes)?))
    }

    /// The last CPU-path frame's camera cull.
    pub fn last_cpu_cull(&self) -> Option<&CpuCull> {
        self.last_cpu.as_ref()
    }

    /// Instance-table rows of the last frame, before culling.
    pub fn last_plan_instances(&self) -> u32 {
        self.stats.instances
    }

    /// Letterbox the world target into `target` (a window surface's view), bars black, through the
    /// window present: FSR1 EASU + RCAS into a larger letterbox, Catmull-Rom into a smaller one,
    /// texel for texel into one of the world target's own size ([`crate::letterbox::present`]).
    /// Shells present through `Resilient::present`, which keeps its own across device recoveries.
    pub fn present(&mut self, gpu: &Gpu, target: &TextureView, format: TextureFormat, window: (u32, u32)) {
        let into = crate::letterbox::present::PresentInto { world: (&self.targets.world_view, self.drawn_size()), target, format, window };
        self.window_present.present(gpu, &into, None);
    }

    /// Present into an offscreen `Bgra8Unorm` window of `window` size and read it back (tests,
    /// and a headless check of the letterbox).
    pub fn present_to_texture(&mut self, gpu: &Gpu, window: (u32, u32)) -> Result<Capture, RenderError> {
        let (width, height) = window;
        check_texture(width, height, 4)?;
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("window"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: WORLD_FORMAT,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        self.present(gpu, &view, WORLD_FORMAT, window);
        let (staging, padded) = self.stage_capture(gpu, &texture, width, height)?;
        let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
        Capture::from_padded_rows(width, height, padded, &data)
    }
}

/// GPU rows of the settings the renderer consumes (RQ0.7). `#[ignore]`d; every name contains
/// `metal`: `cargo test -p genex-render -- --ignored metal`.
#[cfg(test)]
mod surface_constants_tests {
    use super::*;
    use crate::device_class::PerformanceTier;
    use crate::presets::preset_quality;
    use crate::settings::QualityPreset;

    /// The value the forward pipeline of `quality` (the legacy scene, no TAA) gives `name`.
    fn constant(quality: &Quality, name: &str) -> f64 {
        let constants = surface_constants(false, WORLD_FORMAT, SurfaceKey::of(quality, false, false));
        constants.iter().find(|(key, _)| *key == name).map(|(_, value)| *value).unwrap_or_else(|| panic!("{name} is a surface constant"))
    }

    /// RX.R1 (pass-1 gate, owner decision 2026-10-12): the all-features-off frame carries no
    /// shadow-edge work it never draws. Its two cascades switch hard and end hard, so the sun
    /// chunk's blend band and end fade are compiled out and its cascade choice stops at two; a
    /// quality that blends or fades keeps them, and every quality's cascade count bounds the choice.
    #[test]
    fn the_features_off_surface_compiles_out_the_shadow_edges_it_never_draws() {
        let off = Quality::off();
        assert_eq!(constant(&off, "GX_SUN_SOFT_EDGES"), 0.0, "off: no blend band, no end fade");
        assert_eq!(constant(&off, "GX_SUN_CASCADES"), 2.0, "off: two cascades");
        let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let quality = preset_quality(preset, desktop);
            let soft = quality.shadows.blend_percent > 0 || quality.shadows.fade_percent > 0;
            assert_eq!(constant(&quality, "GX_SUN_SOFT_EDGES"), f64::from(u8::from(soft)), "{preset:?}");
            assert_eq!(constant(&quality, "GX_SUN_CASCADES"), f64::from(quality.shadows.cascades), "{preset:?}");
        }
        let mut banded = Quality::off();
        banded.shadows.blend_percent = 10;
        assert_eq!(constant(&banded, "GX_SUN_SOFT_EDGES"), 1.0, "a game's blend band on the legacy cascades is drawn");
        let mut faded = Quality::off();
        faded.shadows.fade_percent = 15;
        assert_eq!(constant(&faded, "GX_SUN_SOFT_EDGES"), 1.0, "a game's end fade on the legacy cascades is drawn");
    }

    /// Renderer pass 2, P2-0.2 (SH-01, T-01 step 1): under TAA the opaque pipelines turn the soft
    /// shadow filters' taps with the frame, but the transparent pipeline compiles the static
    /// pattern and the two-lookup cascade band (`GX_SHADOW_TEMPORAL` off): a blended pixel TAA does
    /// not accumulate must carry no frame-keyed noise (the lake's shadows blinked while the camera
    /// moved). Every other constant is the opaque pipeline's.
    #[test]
    fn the_transparent_pipeline_shades_a_static_shadow_kernel_under_taa() {
        let desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
        for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let quality = preset_quality(preset, desktop);
            let surface = SurfaceKey::of(&quality, true, true);
            let value = |constants: &[(&'static str, f64)], name: &str| constants.iter().find(|(key, _)| *key == name).map(|(_, value)| *value);
            let opaque = surface_constants(true, TextureFormat::Rgba16Float, surface);
            let blended = surface_constants(true, TextureFormat::Rgba16Float, surface.blended());
            assert_eq!(value(&opaque, "GX_SHADOW_TEMPORAL"), Some(1.0), "{preset:?}: the opaque surfaces turn with the frame under TAA");
            assert_eq!(value(&blended, "GX_SHADOW_TEMPORAL"), Some(0.0), "{preset:?}: the transparent surfaces do not");
            let others = |constants: &[(&'static str, f64)]| constants.iter().filter(|(key, _)| *key != "GX_SHADOW_TEMPORAL").copied().collect::<Vec<_>>();
            assert_eq!(others(&opaque), others(&blended), "{preset:?}");
        }
    }

    /// Renderer pass 2, P2-0.10 (C5): only an HDR scene stored as `rg11b10ufloat` (desktop low and
    /// phones) dithers its writes by half a mantissa step; the `rgba16float` scene and the legacy
    /// scene compile the dither out, so their pipelines draw exactly as before.
    #[test]
    fn only_the_rg11b10_scene_dithers_its_writes() {
        let quality = preset_quality(QualityPreset::Low, DeviceClass::new(FormFactor::Mobile, PerformanceTier::High));
        let surface = SurfaceKey::of(&quality, true, false);
        let dither = |reversed, format| {
            let constants = surface_constants(reversed, format, surface);
            constants.iter().find(|(key, _)| *key == "GX_SCENE_RG11B10").map(|(_, value)| *value)
        };
        assert_eq!(dither(true, TextureFormat::Rg11b10Ufloat), Some(1.0), "the rg11b10 HDR scene dithers");
        assert_eq!(dither(true, TextureFormat::Rgba16Float), Some(0.0), "the rgba16float HDR scene does not");
        assert_eq!(dither(false, WORLD_FORMAT), Some(0.0), "the legacy scene does not");
    }

    /// Renderer pass 2, P2-0.12 (LG-04): the HDR scene shades with Filament's roughness floor,
    /// 0.045 on a desktop and the half-precision 0.089 on a phone; the legacy scene keeps 0.04.
    #[test]
    fn phones_shade_with_a_coarser_roughness_floor_than_desktops() {
        let quality = preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
        let floor = |hdr: bool, form| {
            let constants = surface_constants(hdr, TextureFormat::Rgba16Float, SurfaceKey::of(&quality, hdr, false).for_form(form));
            constants.iter().find(|(key, _)| *key == "GX_ROUGHNESS_FLOOR").map(|(_, value)| *value as f32)
        };
        assert_eq!(floor(true, FormFactor::Desktop), Some(0.045));
        assert_eq!(floor(true, FormFactor::Mobile), Some(0.089));
        assert_eq!(floor(false, FormFactor::Mobile), Some(0.04), "the legacy scene draws as before");
    }

    /// The legacy key the renderer starts from is the features-off quality's.
    #[test]
    fn the_legacy_surface_key_is_the_features_off_qualitys() {
        assert_eq!(SurfaceKey::LEGACY, SurfaceKey::of(&Quality::off(), false, false));
    }
}

#[cfg(test)]
mod metal {
    use super::*;
    use crate::scene::{CameraDesc, Material, scaled, translation};
    use crate::settings::RenderFeature;

    fn gpu() -> Option<Gpu> {
        let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
        match Gpu::headless() {
            Ok(gpu) => Some(gpu),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    fn scene() -> Scene {
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
        scene.draw(MeshId::CUBE, translation(0.0, 0.5, 0.0), Material::color([230, 41, 55, 255]));
        scene.draw(MeshId::CUBE, scaled([0.0, -0.75, 0.0], [12.0, 0.2, 8.0]), Material::color([90, 90, 100, 255]));
        scene
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_shadows_switched_off_drop_the_shadow_node_and_the_legacy_quality_keeps_the_frame() {
        let Some(gpu) = gpu() else { return };
        let mut renderer = Renderer::new(&gpu, 128, 72).expect("renderer");
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        let legacy = renderer.capture(&gpu).expect("capture").digest();
        assert_eq!(renderer.last_stats().render_passes, 3, "two cascades and the world pass");
        renderer.set_quality(&Quality::off());
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        assert_eq!(renderer.capture(&gpu).expect("capture").digest(), legacy, "Quality::off() is the legacy renderer");
        let mut unshadowed = Quality::off();
        unshadowed.set_feature(RenderFeature::Shadows, false);
        renderer.set_quality(&unshadowed);
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        let stats = renderer.last_stats();
        assert_eq!((stats.render_passes, stats.views), (1, 1), "no cascades are planned or drawn");
        assert_ne!(renderer.capture(&gpu).expect("capture").digest(), legacy, "the floor loses the cube's shadow");
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_an_armed_frame_timer_lands_gpu_times_and_an_unarmed_frame_records_nothing() {
        let Some(gpu) = gpu() else { return };
        let mut renderer = Renderer::new(&gpu, 128, 72).expect("renderer");
        let Some(first) = renderer.arm_frame_timer(&gpu.queue) else {
            assert!(!gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY), "a timer where timestamps are offered");
            return;
        };
        assert!(first.is_empty(), "nothing has landed before the first frame");
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        renderer.finish_frame_timer();
        let mut landed = Vec::new();
        for _ in 0..8 {
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            landed.extend(renderer.arm_frame_timer(&gpu.queue).unwrap_or_default());
            renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
            renderer.finish_frame_timer();
        }
        assert!(!landed.is_empty(), "armed frames land their GPU time within a few frames");
        assert!(landed.iter().all(|ms| ms.is_finite() && *ms > 0.0 && *ms < 1000.0), "{landed:?}");
        // A capture (unarmed) between Live frames records no begin pass and lands nothing.
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("an unarmed frame");
        assert_eq!(renderer.last_stats().render_passes, 3, "the timer adds no renderer pass");
    }

    /// The RQ3 review's canopy: a 44 x 4 m plate 3 m up reaching towards a low sun, crossing the
    /// near cascade's near plane on every tight fit.
    fn canopy() -> Scene {
        let mut camera = CameraDesc::look_at([-6.0, 1.7, 2.0], [-2.0, 0.0, -10.0]);
        camera.fovy_degrees = 60.0;
        let mut scene = Scene::new(camera, [120, 160, 210, 255]);
        scene.lighting.sun_dir = glam::Vec3::new(0.80, 0.42, 0.10).normalize().to_array();
        scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -40.0], [120.0, 0.2, 120.0]), Material::color([200, 200, 190, 255]));
        scene.draw(MeshId::CUBE, scaled([18.0, 3.0, -6.0], [44.0, 0.1, 4.0]), Material::color([90, 80, 70, 255]));
        scene
    }

    /// The canopy's pixels `quality` shadows with casters drawn by `casters`: darker than 0.8 of
    /// the same pixel unshadowed.
    fn canopy_shadowed(gpu: &Gpu, quality: &Quality, casters: CasterDepth) -> usize {
        let frame = |quality: &Quality| {
            let mut renderer = Renderer::new(gpu, 320, 180).expect("renderer");
            renderer.casters = casters;
            renderer.pipelines = pipelines(&renderer.device, &renderer.layouts, casters).expect("pipelines");
            renderer.set_quality(quality);
            renderer.render(gpu, &canopy(), CullPath::Gpu).expect("frame");
            renderer.capture(gpu).expect("capture")
        };
        let mut open = *quality;
        open.shadows.enabled = false;
        let (shaded, lit) = (frame(quality), frame(&open));
        let sum = |p: &[u8]| u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2]);
        shaded.bgra().chunks(4).zip(lit.bgra().chunks(4)).filter(|(s, l)| (sum(s) as f32) < 0.8 * sum(l) as f32).count()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_casters_without_unclipped_depth_write_their_true_depth_and_shadow_like_unclipped_ones() {
        use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
        use crate::settings::QualityPreset;
        let Some(gpu) = gpu() else { return };
        let legacy = canopy_shadowed(&gpu, &Quality::off(), CasterDepth::Fragment);
        for (preset, class) in [(QualityPreset::Medium, PerformanceTier::Ultra), (QualityPreset::Low, PerformanceTier::Low)] {
            // Depth32 (desktop medium) and Depth16 (the low tier) maps.
            let quality = crate::presets::preset_quality(preset, DeviceClass::new(FormFactor::Desktop, class));
            let fragment = canopy_shadowed(&gpu, &quality, CasterDepth::Fragment);
            assert!(fragment as f32 >= 0.97 * legacy as f32, "{preset:?}: {fragment} shadowed pixels against the legacy fit's {legacy}");
            if !gpu.device.features().contains(wgpu::Features::DEPTH_CLIP_CONTROL) {
                continue;
            }
            let unclipped = canopy_shadowed(&gpu, &quality, CasterDepth::Unclipped);
            assert!(fragment.abs_diff(unclipped) as f32 <= 0.01 * unclipped as f32, "{preset:?}: the fragment casters shadow {fragment} pixels, unclipped ones {unclipped}");
        }
    }

    /// The legacy quality with `filter` (and HDR when `hdr`).
    fn filtered(filter: ShadowFilter, hdr: bool) -> Quality {
        let mut quality = Quality::off();
        quality.shadows.filter = filter;
        quality.hdr = hdr;
        quality.tonemap = hdr;
        quality
    }

    /// The shadow rows' frame size (large enough to show a penumbra in the evidence).
    const EVIDENCE_SIZE: (u32, u32) = (320, 180);

    /// A frame of `scene()` under `quality`: its digest. With `GENEX_RENDER_EVIDENCE_DIR` set, the
    /// frame's BGRA bytes are also written there as `name.bgra` (evidence, never compared).
    fn digest_under(gpu: &Gpu, renderer: &mut Renderer, quality: &Quality, name: &str) -> u64 {
        renderer.set_quality(quality);
        renderer.render(gpu, &scene(), CullPath::Gpu).expect("frame");
        let capture = renderer.capture(gpu).expect("capture");
        if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
            let dir = std::path::PathBuf::from(dir);
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
        }
        capture.digest()
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_the_qualitys_shadow_filter_reaches_the_sun_chunk_on_both_scene_paths() {
        let Some(gpu) = gpu() else { return };
        for hdr in [false, true] {
            let mut renderer = Renderer::new(&gpu, EVIDENCE_SIZE.0, EVIDENCE_SIZE.1).expect("renderer");
            renderer.set_scene_format(SceneFormat::Rgba16Float);
            let pcf3 = digest_under(&gpu, &mut renderer, &filtered(ShadowFilter::Pcf3x3, hdr), &format!("filter-pcf3-hdr-{hdr}"));
            assert_eq!(renderer.last_scene().expect("ran").hdr, hdr, "the scene path");
            let hard = digest_under(&gpu, &mut renderer, &filtered(ShadowFilter::Hardware2x2, hdr), &format!("filter-hard-hdr-{hdr}"));
            assert_ne!(hard, pcf3, "hdr {hdr}: one hardware tap draws another shadow edge than 3x3 PCF");
            let pcss = digest_under(&gpu, &mut renderer, &filtered(ShadowFilter::Pcss, hdr), &format!("filter-pcss-hdr-{hdr}"));
            assert_ne!(pcss, pcf3, "hdr {hdr}: PCSS draws another penumbra than 3x3 PCF");
            assert_eq!(digest_under(&gpu, &mut renderer, &filtered(ShadowFilter::Pcf3x3, hdr), "filter-pcf3-again"), pcf3, "hdr {hdr}: back to 3x3 PCF");
        }
        // The default filter is the legacy one: the boot pipelines draw it.
        let mut fresh = Renderer::new(&gpu, EVIDENCE_SIZE.0, EVIDENCE_SIZE.1).expect("renderer");
        let mut legacy = Renderer::new(&gpu, EVIDENCE_SIZE.0, EVIDENCE_SIZE.1).expect("renderer");
        assert_eq!(digest_under(&gpu, &mut fresh, &filtered(ShadowFilter::Pcf3x3, false), "filter-pcf3-fresh"), digest_under(&gpu, &mut legacy, &Quality::off(), "legacy"));
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_the_shadow_maps_take_the_qualitys_shape_and_the_legacy_shape_keeps_its_maps() {
        let Some(gpu) = gpu() else { return };
        let mut renderer = Renderer::new(&gpu, EVIDENCE_SIZE.0, EVIDENCE_SIZE.1).expect("renderer");
        let legacy = digest_under(&gpu, &mut renderer, &Quality::off(), "maps-legacy");
        assert_eq!(renderer.shadow_desc, ShadowMapDesc::LEGACY, "two 1024 px depth32 layers");
        let mut four = Quality::off();
        four.shadows.cascades = 4;
        four.shadows.map_size = 512;
        four.shadows.format = ShadowFormat::Depth16;
        digest_under(&gpu, &mut renderer, &four, "maps-4x512-depth16");
        let desc = renderer.shadow_desc;
        assert_eq!((desc.layers, desc.side, desc.format), (4, 512, wgpu::TextureFormat::Depth16Unorm));
        let stats = renderer.last_stats();
        assert_eq!((stats.views, stats.render_passes), (5, 5), "the camera and four cascades; four shadow passes and the world");
        let mut one = Quality::off();
        one.shadows.cascades = 1;
        digest_under(&gpu, &mut renderer, &one, "maps-1x1024");
        assert_eq!((renderer.last_stats().views, renderer.last_stats().render_passes), (2, 2), "one cascade");
        assert_eq!(digest_under(&gpu, &mut renderer, &Quality::off(), "maps-legacy-again"), legacy, "back to the legacy maps: the legacy picture");
        assert_eq!(renderer.shadow_desc, ShadowMapDesc::LEGACY);
    }
}
