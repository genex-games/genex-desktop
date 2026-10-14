//! The frame graph (plan §2.2): a fixed, ordered table of nodes, with no scheduler and no
//! dependency solver. RQ0.1 landed the node ids, kinds and the order; RQ0.6 runs every frame
//! through it ([`run`]): `Renderer::render_staged` and `FrameRenderer::render_with` are
//! [`FrameNodes`] implementations (`enabled`, `targets`, `encode`). RQ0.7 wires the settings into
//! their `enabled`: a node whose feature switch is off in the frame's [`Quality`] never runs
//! ([`quality_allows`]), whatever its consumers ask.
//!
//! There are two node kinds. Pass nodes ([`NodeKind::Queue`], [`NodeKind::Compute`],
//! [`NodeKind::Pass`]) record into the frame's encoder and open their own passes. In-pass nodes
//! ([`NodeKind::InPass`]) receive the open render pass of their host: nodes 12-16 draw inside
//! **one world pass** (load Clear, MSAA resolved with `StoreOp::Discard`, depth discarded unless
//! a later node reads it), which [`FrameNodes::begin_world`] opens for the run of enabled in-pass
//! rows. An enabled pass node between two in-pass rows would close the host; no landed node does.
//!
//! Later tiers' nodes are rows here from the start ([`NodeId::landed`] false): [`schedule`] never
//! runs them, whatever `enabled` answers, so a stub row encodes nothing. Level-3 stage hooks are
//! nodes too (`before-cull` 2, `after-opaque` 14, `after-transparent` 15, `post-hdr` 18, `post`
//! 23). RQ1 landed the HDR path's nodes: `post-hdr` 18, auto exposure 20 and the tonemap 21 (they
//! run only on frames drawing the HDR scene). RQ4.0 gates the RQ4 rows on their modules' `LANDED`
//! (the prepass 7, `after-prepass` 9, AO 10, contact shadows 10a, bloom 19; fog is a lighting
//! chunk, not a node), so each wave-1 work package lands its row without editing this table.
//! R2.0 does the same for R2: the occlusion row 8 (Hi-Z build, cull pass 2, prepass part 2) lands
//! with [`crate::meshlet_cull::occlusion_landed`], and the meshlet half of the cull row 5 with
//! [`crate::meshlet_cull::LANDED`]; [`OcclusionFrame`] is what both know about a frame. RQ5.0
//! gates TAA's rows (the reactive coverage 15a and the resolve 17) on [`crate::post::taa::LANDED`],
//! the prepass's motion target on [`crate::motion::LANDED`] and the FSR1 half of the upscale row 22
//! on [`crate::post::fsr::LANDED`]; [`TemporalFrame`] is what they know about a frame. RQ5.6
//! landed all three. The reactive coverage (15a) is a pass node between the transparent draws and
//! the MSAA resolve: TAA draws one sample, so a frame never runs both and the world pass stays one.

use wgpu::{CommandEncoder, Device, Queue, RenderPass, TextureFormat};

use crate::error::RenderError;
use crate::settings::{AoResolution, Environment, EnvironmentQuality, Quality, RenderFeature};

/// Specular anti-aliasing's subject spelling (a table knob without a switch).
pub const SPECULAR_AA_KNOB: &str = "specular-aa";

/// What a node records into.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    /// Queue writes (table uploads, timestamp resolves).
    Queue,
    /// Its own compute pass.
    Compute,
    /// Its own render pass.
    Pass,
    /// Draws inside the world pass.
    InPass,
}

/// A node of the frame graph, in frame order (plan §2.2's table).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NodeId {
    /// 1: instance, material and light tables and parallel tables.
    Tables,
    /// 2: Level-3 `before-cull` passes.
    BeforeCull,
    /// 3: compute skinning.
    Skinning,
    /// 4: light binning (RQ6).
    LightBinning,
    /// 5: cull pass 1 (frustum; with R2, last frame's visible set).
    Cull,
    /// 6: shadow cascades and shadowed spots.
    Shadows,
    /// 7: depth, normal and motion prepass (RQ4, RQ5).
    Prepass,
    /// 8: Hi-Z build, cull pass 2 and prepass part 2 (R2).
    Occlusion,
    /// 9: Level-3 `after-prepass` passes (RQ4).
    AfterPrepass,
    /// 10: ambient occlusion (RQ4).
    Ao,
    /// 10a: contact shadows (RQ4).
    ContactShadows,
    /// 11: sky LUTs, aerial perspective and the environment bake (RQ2).
    Environment,
    /// 12: the opaque batches.
    Opaque,
    /// 13: sky background and sun disk (RQ2).
    Sky,
    /// 14: Level-2 custom materials and Level-3 `after-opaque` passes.
    AfterOpaque,
    /// 15: transparent draws, particles and Level-3 `after-transparent` passes.
    Transparent,
    /// 15a: TAA's reactive coverage (RQ5).
    Reactive,
    /// 16: MSAA resolve.
    Resolve,
    /// 17: TAA (RQ5).
    Taa,
    /// 18: Level-3 `post-hdr` and Level-2 `hdr` post passes (RQ1).
    PostHdr,
    /// 19: bloom (RQ4).
    Bloom,
    /// 20: auto exposure (RQ1).
    Exposure,
    /// 21: tonemap and bloom composite (RQ1).
    Tonemap,
    /// 22: upscale (bilinear, or EASU + RCAS) and the final dither.
    Upscale,
    /// 23: 2D quads, Level-2 `ldr` post passes and Level-3 `post` passes.
    Post,
    /// 24: the HUD overlay.
    Hud,
    /// 25: the timestamp resolve.
    Timestamps,
}

/// A target a node writes (the plan table's "writes" column, for the nodes that have landed).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// The storage-buffer tables and frame uniforms.
    Tables,
    /// Skinned vertices.
    SkinnedVertices,
    /// Indirect draw arguments and the visible lists.
    IndirectArgs,
    /// The shadow depth array.
    ShadowMaps,
    /// The multisampled scene colour (transient where it saves memory).
    SceneMsaa,
    /// The scene's depth (transient where it saves memory and nothing reads it).
    SceneDepth,
    /// The 1x scene colour at render size (the world target itself at scale 1).
    SceneColor,
    /// The world target (`Bgra8Unorm`, output size): what captures, Live and the HUD read.
    World,
    /// Whatever a Level-3 pass writes into its own resources.
    PassOwned,
    /// The exposure buffer (the next frame's pre-exposure).
    Exposure,
    /// The prepass's octahedral `rg16float` normals (render size, 1x).
    Normals,
    /// The ambient occlusion term and AO's own history (`r8unorm`, the AO resolution).
    AmbientOcclusion,
    /// The sun's contact-shadow mask (`r8unorm`, half the render size).
    ContactShadowMask,
    /// The bloom mip chain (threshold-free).
    BloomChain,
    /// The Hi-Z pyramid (`r32float`, half the render size down to 1 × 1).
    HiZ,
    /// The next frame's meshlet visibility bitset.
    MeshletVisibility,
    /// The views' compacted meshlet index buffers, drawn-meshlet slots and indirect arguments.
    MeshletDraws,
    /// The prepass's `rg16float` NDC motion (render size, 1x; RQ5).
    Motion,
    /// TAA's `r8unorm` reactive mask (render size; RQ5).
    ReactiveMask,
    /// TAA's `rgba16float` history pair (render size; RQ5).
    TaaHistory,
    /// The per-tile light masks and the light-bin header and z-bins (RQ6).
    LightBins,
}

impl NodeId {
    /// Whether the node encodes work in this build. Later tiers' rows are stubs: never scheduled.
    /// The environment rows land with their modules ([`crate::ibl::LANDED`],
    /// [`crate::sky::LANDED`]), so the tier's work packages flip them without editing this table.
    pub const fn landed(self) -> bool {
        match self {
            NodeId::Environment => crate::ibl::LANDED || crate::sky::LANDED,
            NodeId::Sky => crate::sky::LANDED,
            NodeId::Prepass => crate::prepass::LANDED,
            // Level-3 `after-prepass` passes run once the prepass they follow has landed and the
            // stage is served (`custom_pass::AFTER_PREPASS_SERVED`, RQ4.5).
            NodeId::AfterPrepass => crate::prepass::LANDED && crate::custom_pass::AFTER_PREPASS_SERVED,
            NodeId::Ao => crate::post::ao::LANDED,
            NodeId::ContactShadows => crate::post::contact_shadow::LANDED,
            NodeId::Bloom => crate::post::bloom::LANDED,
            NodeId::Occlusion => crate::meshlet_cull::occlusion_landed(),
            NodeId::Reactive | NodeId::Taa => crate::post::taa::LANDED,
            NodeId::LightBinning => crate::cluster::LANDED,
            _ => matches!(
                self,
                NodeId::Tables
                    | NodeId::BeforeCull
                    | NodeId::Skinning
                    | NodeId::Cull
                    | NodeId::Shadows
                    | NodeId::Opaque
                    | NodeId::AfterOpaque
                    | NodeId::Transparent
                    | NodeId::Resolve
                    | NodeId::PostHdr
                    | NodeId::Exposure
                    | NodeId::Tonemap
                    | NodeId::Upscale
                    | NodeId::Post
                    | NodeId::Hud
            ),
        }
    }

    /// What the node writes when it runs (empty for a stub row).
    pub const fn writes(self) -> &'static [Target] {
        match self {
            NodeId::Tables => &[Target::Tables],
            NodeId::BeforeCull => &[Target::PassOwned],
            NodeId::Skinning => &[Target::SkinnedVertices],
            NodeId::Cull if crate::meshlet_cull::LANDED => &[Target::IndirectArgs, Target::MeshletDraws],
            NodeId::Cull => &[Target::IndirectArgs],
            NodeId::Shadows => &[Target::ShadowMaps],
            NodeId::Opaque | NodeId::AfterOpaque | NodeId::Transparent => &[Target::SceneMsaa, Target::SceneDepth],
            NodeId::Resolve | NodeId::PostHdr => &[Target::SceneColor],
            NodeId::Exposure => &[Target::Exposure],
            NodeId::Tonemap | NodeId::Upscale | NodeId::Post | NodeId::Hud => &[Target::World],
            NodeId::Prepass if crate::prepass::LANDED && crate::motion::LANDED => &[Target::SceneDepth, Target::Normals, Target::Motion],
            NodeId::Prepass if crate::prepass::LANDED => &[Target::SceneDepth, Target::Normals],
            NodeId::Reactive if crate::post::taa::LANDED => &[Target::ReactiveMask],
            NodeId::Taa if crate::post::taa::LANDED => &[Target::SceneColor, Target::TaaHistory],
            NodeId::LightBinning if crate::cluster::LANDED => &[Target::LightBins],
            NodeId::AfterPrepass if crate::prepass::LANDED && crate::custom_pass::AFTER_PREPASS_SERVED => &[Target::PassOwned],
            NodeId::Ao if crate::post::ao::LANDED => &[Target::AmbientOcclusion],
            NodeId::ContactShadows if crate::post::contact_shadow::LANDED => &[Target::ContactShadowMask],
            NodeId::Bloom if crate::post::bloom::LANDED => &[Target::BloomChain],
            NodeId::Occlusion if crate::meshlet_cull::occlusion_landed() => {
                &[Target::HiZ, Target::MeshletVisibility, Target::MeshletDraws, Target::SceneDepth, Target::Normals]
            }
            _ => &[],
        }
    }
}

/// Whether `quality` lets node `id` run: the node's feature switch (plan §2.4), so a preset, the
/// person or `genex.toml` turning a feature off removes its node from the frame. Nodes without a
/// switch (tables, culling, the world pass, the upscale, Level-3 stages, the HUD) are always
/// allowed; whether they run is their renderer's call. Later tiers' rows answer their switch
/// already, and [`schedule`] still never runs a row that has not landed.
pub fn quality_allows(id: NodeId, quality: &Quality) -> bool {
    match id {
        NodeId::Shadows => quality.shadows.enabled,
        NodeId::LightBinning => quality.lights.clustered,
        NodeId::Prepass => quality.prepass,
        NodeId::Occlusion => quality.occlusion,
        NodeId::Ao => quality.ao.resolution != AoResolution::Off,
        NodeId::ContactShadows => quality.contact_shadows,
        NodeId::Environment => quality.environment.ibl || quality.environment.sky,
        NodeId::Sky => quality.environment.sky,
        NodeId::Reactive | NodeId::Taa => quality.anti_aliasing.temporal(),
        NodeId::Bloom => quality.bloom.enabled,
        NodeId::Exposure => quality.hdr && quality.exposure,
        NodeId::Tonemap => quality.hdr,
        _ => true,
    }
}

/// Whether `feature`'s switch changes what this build draws. Every switch is a typed setting from
/// RQ0 on, but only a switch whose node has landed changes the picture; the others arrive with
/// their tier and are reported off (and `not-landed` in `degraded`) until then, never as on.
pub const fn feature_landed(feature: RenderFeature) -> bool {
    match feature {
        RenderFeature::Ibl => crate::ibl::LANDED,
        RenderFeature::Sky => crate::sky::LANDED,
        RenderFeature::Prepass => crate::prepass::LANDED,
        RenderFeature::Ao => crate::post::ao::LANDED,
        RenderFeature::ContactShadows => crate::post::contact_shadow::LANDED,
        RenderFeature::Bloom => crate::post::bloom::LANDED,
        RenderFeature::Fog => crate::fog::LANDED,
        RenderFeature::Meshlets => crate::meshlet_cull::LANDED,
        RenderFeature::Occlusion => crate::meshlet_cull::occlusion_landed(),
        RenderFeature::Taa => crate::post::taa::LANDED,
        RenderFeature::Upscaler => crate::post::fsr::LANDED,
        RenderFeature::Clustered => crate::cluster::LANDED,
        RenderFeature::SpotShadows => crate::spot_shadow::LANDED,
        _ => matches!(feature, RenderFeature::Hdr | RenderFeature::Tonemap | RenderFeature::Exposure | RenderFeature::Shadows | RenderFeature::TextureQuality),
    }
}

/// Whether `quality` has `feature` on and this build draws it.
pub fn feature_drawn(quality: &Quality, feature: RenderFeature) -> bool {
    feature_landed(feature) && quality.feature(feature)
}

/// What `quality` asks for that this build does not draw, by `degraded` subject: each switch that
/// is on without having landed, by its wire spelling. Every shadow knob is drawn as asked since
/// RQ3 (cascades, map size, filter, depth format, far cadence). Empty for [`Quality::off`]: the
/// legacy renderer draws exactly what it asks.
pub fn not_landed(quality: &Quality) -> Vec<&'static str> {
    RenderFeature::ALL.into_iter().filter(|feature| !feature_landed(*feature) && quality.feature(*feature)).map(RenderFeature::wire).collect()
}

/// One row of the frame graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeSpec {
    /// The node.
    pub id: NodeId,
    /// What it records into.
    pub kind: NodeKind,
    /// Its stable spelling (timings, `degraded` reasons, perf rows).
    pub wire: &'static str,
}

const fn node(id: NodeId, kind: NodeKind, wire: &'static str) -> NodeSpec {
    NodeSpec { id, kind, wire }
}

/// The frame graph, in frame order.
pub const FRAME_GRAPH: &[NodeSpec] = &[
    node(NodeId::Tables, NodeKind::Queue, "tables"),
    node(NodeId::BeforeCull, NodeKind::Compute, "before-cull"),
    node(NodeId::Skinning, NodeKind::Compute, "skinning"),
    node(NodeId::LightBinning, NodeKind::Compute, "light-binning"),
    node(NodeId::Cull, NodeKind::Compute, "cull"),
    node(NodeId::Shadows, NodeKind::Pass, "shadows"),
    node(NodeId::Prepass, NodeKind::Pass, "prepass"),
    node(NodeId::Occlusion, NodeKind::Compute, "occlusion"),
    node(NodeId::AfterPrepass, NodeKind::Pass, "after-prepass"),
    node(NodeId::Ao, NodeKind::Pass, "ao"),
    node(NodeId::ContactShadows, NodeKind::Pass, "contact-shadows"),
    node(NodeId::Environment, NodeKind::Compute, "environment"),
    node(NodeId::Opaque, NodeKind::InPass, "opaque"),
    node(NodeId::Sky, NodeKind::InPass, "sky"),
    node(NodeId::AfterOpaque, NodeKind::InPass, "after-opaque"),
    node(NodeId::Transparent, NodeKind::InPass, "transparent"),
    node(NodeId::Reactive, NodeKind::Pass, "reactive"),
    node(NodeId::Resolve, NodeKind::InPass, "resolve"),
    node(NodeId::Taa, NodeKind::Pass, "taa"),
    node(NodeId::PostHdr, NodeKind::Pass, "post-hdr"),
    node(NodeId::Bloom, NodeKind::Pass, "bloom"),
    node(NodeId::Exposure, NodeKind::Compute, "exposure"),
    node(NodeId::Tonemap, NodeKind::Pass, "tonemap"),
    node(NodeId::Upscale, NodeKind::Pass, "upscale"),
    node(NodeId::Post, NodeKind::Pass, "post"),
    node(NodeId::Hud, NodeKind::Pass, "hud"),
    node(NodeId::Timestamps, NodeKind::Queue, "timestamps"),
];

/// The row of `id`.
pub fn spec(id: NodeId) -> NodeSpec {
    FRAME_GRAPH.iter().copied().find(|row| row.id == id).unwrap_or(node(id, NodeKind::Pass, ""))
}

/// One step of a frame: a pass node, or the world pass hosting a run of in-pass nodes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// A queue, compute or pass node.
    Node(NodeId),
    /// One world pass and the in-pass nodes drawn inside it, in table order.
    World(Vec<NodeId>),
}

impl Step {
    /// The nodes the step runs, in order.
    pub fn nodes(&self) -> Vec<NodeId> {
        match self {
            Step::Node(id) => vec![*id],
            Step::World(rows) => rows.clone(),
        }
    }
}

/// The frame's steps: every landed row `enabled` answers yes for, in table order, consecutive
/// in-pass rows gathered into one [`Step::World`].
pub fn schedule(enabled: impl Fn(NodeId) -> bool) -> Vec<Step> {
    let mut steps: Vec<Step> = Vec::new();
    for row in FRAME_GRAPH.iter().filter(|row| row.id.landed() && enabled(row.id)) {
        if row.kind != NodeKind::InPass {
            steps.push(Step::Node(row.id));
            continue;
        }
        match steps.last_mut() {
            Some(Step::World(rows)) => rows.push(row.id),
            _ => steps.push(Step::World(vec![row.id])),
        }
    }
    steps
}

/// Passes and submissions a frame recorded (the renderer's own, not a Level-3 pass's).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PassCounters {
    /// Render passes opened.
    pub render: u32,
    /// Compute passes opened.
    pub compute: u32,
    /// Command buffers submitted.
    pub submissions: u32,
}

/// The frame's command encoder: created on first use, submitted when a node needs its work on
/// the queue ahead of its own (a Level-3 `post` pass submits its own encoders) and at the end.
pub struct FrameEncoder {
    device: Device,
    queue: Queue,
    label: &'static str,
    encoder: Option<CommandEncoder>,
    counters: PassCounters,
}

impl FrameEncoder {
    /// A frame encoder on `device` and `queue`, labelled `label`.
    pub fn new(device: &Device, queue: &Queue, label: &'static str) -> FrameEncoder {
        FrameEncoder { device: device.clone(), queue: queue.clone(), label, encoder: None, counters: PassCounters::default() }
    }

    /// The device.
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// The queue.
    pub fn queue(&self) -> &Queue {
        &self.queue
    }

    /// The open encoder (a new one after a submission).
    pub fn encoder(&mut self) -> &mut CommandEncoder {
        let (device, label) = (&self.device, self.label);
        self.encoder.get_or_insert_with(|| device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(label) }))
    }

    /// Submit what is recorded so far (nothing when nothing is).
    pub fn submit(&mut self) {
        if let Some(encoder) = self.encoder.take() {
            self.queue.submit([encoder.finish()]);
            self.counters.submissions += 1;
        }
    }

    /// Count `n` render passes a node opened.
    pub fn count_render_passes(&mut self, n: u32) {
        self.counters.render += n;
    }

    /// Count `n` compute passes a node opened.
    pub fn count_compute_passes(&mut self, n: u32) {
        self.counters.compute += n;
    }

    /// What the frame recorded so far.
    pub fn counters(&self) -> PassCounters {
        self.counters
    }
}

/// What graph node 11 (the sky LUTs and the environment bake) and node 13 (the sky background)
/// know about one frame (RQ2.0): the environment, the quality's IBL and sky knobs, the frame index
/// their time-sliced schedules key to, the sun and camera, and the world pass they draw into.
#[non_exhaustive]
#[derive(Clone, Copy, Debug)]
pub struct EnvironmentFrame<'a> {
    /// The device.
    pub device: &'a Device,
    /// The game's environment.
    pub environment: &'a Environment,
    /// The quality's IBL and sky knobs.
    pub quality: &'a EnvironmentQuality,
    /// Frames drawn since the history's last reset (a capture: its settle index).
    pub frame_index: u64,
    /// Whether everything is baked at once this frame (a settled capture's re-render), instead of
    /// the time-sliced step that is due.
    pub settle: bool,
    /// Unit direction towards the sun.
    pub sun_dir: [f32; 3],
    /// The sun's radiance (linear rgb, intensity folded in).
    pub sun_color: [f32; 3],
    /// The camera's position.
    pub camera_pos: [f32; 3],
    /// The camera's projection × view (reversed when `depth_reversed`), column-major.
    pub view_proj: [f32; 16],
    /// The exposure the scene is written with.
    pub pre_exposure: f32,
    /// The scene colour's format, samples and depth convention (the background's pipeline).
    pub scene_format: TextureFormat,
    /// Samples per pixel of the world pass.
    pub samples: u32,
    /// Whether camera views draw reverse-Z.
    pub depth_reversed: bool,
    /// The frame's fog (density 0: none): the sky and HDR-map backgrounds fog themselves with it.
    pub fog: crate::fog::GpuFog,
    /// Whether node 11 writes the aerial-perspective volume under the sky (the quality's knob and
    /// the fog's look, [`crate::fog::aerial_perspective`]).
    pub aerial: bool,
}

/// What graph node 5's meshlet half and node 8 (Hi-Z build, cull pass 2, prepass part 2) know
/// about one frame (R2.0): the game's meshlets against the quality, the depth convention the Hi-Z
/// reduces by, the render size it is built at, and whether the visibility history starts empty.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OcclusionFrame {
    /// Whether meshes at or above the game's `min_triangles` draw as meshlets this frame.
    pub meshlets: bool,
    /// Whether two-pass Hi-Z occlusion culls them.
    pub occlusion: bool,
    /// The render size (the Hi-Z is half of it).
    pub render_size: (u32, u32),
    /// Whether camera views draw reverse-Z (the Hi-Z keeps the minimum).
    pub depth_reversed: bool,
    /// Frames drawn since the history's last reset.
    pub frame_index: u64,
    /// Whether last frame's visible set is empty (a reset or a settled capture): pass 1 draws
    /// nothing and pass 2 draws every candidate in view.
    pub history_reset: bool,
}

impl OcclusionFrame {
    /// The frame `config` draws with `settings`' meshlets and quality.
    pub fn new(settings: &crate::settings::RenderSettings, config: &crate::settings::FrameConfig) -> OcclusionFrame {
        let (meshlets, occlusion) = settings.meshlets.drawn(&settings.quality);
        OcclusionFrame {
            meshlets: meshlets && crate::meshlet_cull::LANDED,
            occlusion: occlusion && crate::meshlet_cull::occlusion_landed(),
            render_size: config.render_size,
            depth_reversed: config.depth_reversed,
            frame_index: config.frame_index,
            history_reset: config.history_reset || config.settle.is_some(),
        }
    }

    /// The Hi-Z reduction of this frame's depth convention.
    pub const fn reduction(&self) -> crate::hiz::HizReduce {
        crate::hiz::reduction(self.depth_reversed)
    }
}

/// What the temporal nodes know about one frame (RQ5.0): the prepass's motion target (node 7),
/// TAA's reactive coverage and resolve (15a, 17) and the FSR1 upscale (22). Each switch is the
/// quality's and this build's: nothing temporal runs before its module lands.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TemporalFrame {
    /// Whether TAA resolves this frame (MSAA is off then).
    pub taa: bool,
    /// Whether the prepass writes motion vectors (for TAA, or a declared `motion` input).
    pub motion: bool,
    /// Which FSR1 passes run.
    pub fsr: crate::post::fsr::FsrPasses,
    /// This frame's jitter in render pixels (zero without TAA).
    pub jitter: [f32; 2],
    /// The previous frame's jitter (this frame's on a history reset).
    pub prev_jitter: [f32; 2],
    /// The mip bias materials sample with (0 without TAA).
    pub texture_lod_bias: f32,
    /// The render size (the history's).
    pub render_size: (u32, u32),
    /// The world target's size.
    pub output_size: (u32, u32),
    /// Frames drawn since the history's last reset (a capture: its settle index).
    pub frame_index: u64,
    /// Whether TAA history starts over this frame (a reset, or a settled capture's first frame).
    pub history_reset: bool,
}

impl TemporalFrame {
    /// The frame `config` draws with `settings`' quality; `motion_input` when a Level-2/Level-3
    /// extension declared the motion input.
    pub fn new(settings: &crate::settings::RenderSettings, config: &crate::settings::FrameConfig, motion_input: bool) -> TemporalFrame {
        let quality = &settings.quality;
        let taa = feature_drawn(quality, RenderFeature::Taa);
        let history_reset = config.history_reset || config.settle.is_some_and(|(index, _)| index == 0);
        let prev_jitter = match (taa, history_reset) {
            (true, false) => crate::jitter::offset_px(config.frame_index.wrapping_sub(1), quality.taa.jitter_cycle),
            _ => config.jitter,
        };
        let fsr = match crate::post::fsr::LANDED {
            true => crate::post::fsr::passes(quality, config.render_size, config.output_size),
            false => crate::post::fsr::FsrPasses::default(),
        };
        TemporalFrame {
            taa,
            motion: crate::motion::LANDED && (taa || motion_input),
            fsr,
            jitter: config.jitter,
            prev_jitter,
            texture_lod_bias: if taa { quality.taa.texture_lod_bias(config.scale) } else { 0.0 },
            render_size: config.render_size,
            output_size: config.output_size,
            frame_index: config.frame_index,
            history_reset,
        }
    }
}

/// The nodes one frame draws with (plan §2.2): a renderer answers which rows run and encodes them.
pub trait FrameNodes {
    /// Whether `id` runs this frame (asked only for landed rows).
    fn enabled(&self, id: NodeId) -> bool;

    /// What `id` writes this frame.
    fn targets(&self, id: NodeId) -> &'static [Target] {
        id.writes()
    }

    /// Record pass node `id` (queue writes, its own compute or render passes, counted on `frame`).
    fn encode(&mut self, id: NodeId, frame: &mut FrameEncoder) -> Result<(), RenderError>;

    /// Work the in-pass `rows` need on the frame before their host opens (compute their draws
    /// read, bind groups). Nothing by default.
    fn before_world(&mut self, _rows: &[NodeId], _frame: &mut FrameEncoder) -> Result<(), RenderError> {
        Ok(())
    }

    /// Open the world pass hosting `rows` (its attachments follow from them: a resolve target
    /// when [`NodeId::Resolve`] is among them).
    fn begin_world<'e>(&mut self, rows: &[NodeId], encoder: &'e mut CommandEncoder) -> RenderPass<'e>;

    /// Draw in-pass node `id` inside the open world pass.
    fn encode_in_pass(&mut self, id: NodeId, pass: &mut RenderPass<'_>);
}

/// Run one frame of `nodes` into `frame` in table order; answers the steps that ran. The first
/// refusal stops the frame there (what is recorded stays on `frame` for the caller to submit or
/// drop).
pub fn run(nodes: &mut dyn FrameNodes, frame: &mut FrameEncoder) -> Result<Vec<Step>, RenderError> {
    let steps = schedule(|id| nodes.enabled(id));
    for step in &steps {
        match step {
            Step::Node(id) => nodes.encode(*id, frame)?,
            Step::World(rows) => {
                nodes.before_world(rows, frame)?;
                frame.count_render_passes(1);
                let mut pass = nodes.begin_world(rows, frame.encoder());
                for id in rows {
                    nodes.encode_in_pass(*id, &mut pass);
                }
            }
        }
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_off_quality_allows_every_landed_node_but_the_hdr_path_s() {
        let off = Quality::off();
        // The legacy renderer draws no HDR scene (exposure and the tonemap are the HDR path's) and
        // no environment: its sky and IBL switches are off, so those nodes never run there. Its
        // prepass switch is off too (RQ4.1), and so are two-pass occlusion (R2.4), AO, contact
        // shadows and bloom (RQ4.6), light binning (RQ6.7: the binned path is the HDR scene's), and
        // TAA's reactive coverage and resolve (RQ5.6: the legacy renderer draws MSAA).
        let hdr_only = [
            NodeId::Reactive,
            NodeId::Taa,
            NodeId::LightBinning,
            NodeId::Prepass,
            NodeId::Occlusion,
            NodeId::Ao,
            NodeId::ContactShadows,
            NodeId::Bloom,
            NodeId::Exposure,
            NodeId::Tonemap,
            NodeId::Environment,
            NodeId::Sky,
        ];
        for row in FRAME_GRAPH.iter().filter(|row| row.id.landed()) {
            let allowed = quality_allows(row.id, &off);
            assert_eq!(allowed, !hdr_only.contains(&row.id), "{} in the legacy renderer", row.wire);
        }
    }

    #[test]
    fn nothing_temporal_runs_before_its_module_lands() {
        let mut quality = Quality::off();
        quality.hdr = true;
        quality.set_feature(RenderFeature::Taa, true);
        quality.set_feature(RenderFeature::Upscaler, true);
        let settings = crate::settings::RenderSettings::off().with_quality(crate::settings::PresetChoice::Off, quality);
        let config = settings.frame_config((1920, 1080), 0.5, 5, false);
        let frame = TemporalFrame::new(&settings, &config, true);
        assert_eq!(frame.taa, crate::post::taa::LANDED);
        assert_eq!(frame.motion, crate::motion::LANDED);
        assert_eq!(frame.fsr.easu, crate::post::fsr::LANDED, "scale 0.5 upscales once FSR1 lands");
        if !crate::post::taa::LANDED {
            assert_eq!((frame.jitter, frame.prev_jitter, frame.texture_lod_bias), ([0.0; 2], [0.0; 2], 0.0));
        }
        assert_eq!((frame.render_size, frame.output_size, frame.frame_index, frame.history_reset), ((960, 540), (1920, 1080), 5, false));
    }

    #[test]
    fn a_feature_switched_off_removes_its_node_from_the_schedule() {
        let mut quality = Quality::off();
        quality.set_feature(RenderFeature::Shadows, false);
        let steps = schedule(|id| quality_allows(id, &quality));
        let nodes: Vec<NodeId> = steps.iter().flat_map(Step::nodes).collect();
        assert!(!nodes.contains(&NodeId::Shadows), "{nodes:?}");
        assert!(nodes.contains(&NodeId::Opaque), "the world pass still runs");
        for (feature, node) in [(RenderFeature::Bloom, NodeId::Bloom), (RenderFeature::Ao, NodeId::Ao), (RenderFeature::Taa, NodeId::Taa)] {
            let mut on = Quality::off();
            assert!(!quality_allows(node, &on), "{} off in the legacy renderer", spec(node).wire);
            on.set_feature(feature, true);
            if feature == RenderFeature::Bloom {
                on.bloom.mips = 4;
            }
            assert!(quality_allows(node, &on), "{} follows its switch", spec(node).wire);
        }
    }
}
