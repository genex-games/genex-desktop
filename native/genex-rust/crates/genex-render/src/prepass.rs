//! The depth/normal prepass (plan §2.2 node 7; RQ4). RQ4.0 landed its contract, RQ4.1 records it:
//! the targets, the consumers that make it run (plan principle 3: pay for what you use), when the
//! main pass reuses its depth with `Equal`, the custom geometry it draws besides the opaque
//! batches and the octahedral normal encoding's CPU twin. The renderer (`renderer.rs`) records the
//! pass itself.
//!
//! - **Targets** ([`targets`]): the scene depth, kept and sampleable (`TEXTURE_BINDING`, never
//!   transient, stored), and the normals ([`NORMALS_FORMAT`], octahedral world-space unit normals,
//!   written by a fragment pass because core has no `rg16float` storage), both at render size and
//!   1x. The normals are the geometry's (vertex) normals, not normal-mapped; a consumer turns them
//!   to view space with the frame's view matrix.
//! - **What it draws**: the opaque batches through the camera view's indirect arguments (or the
//!   CPU cull's direct draws), skinned batches from the skinned vertex buffer, the meshlets of the
//!   clustered meshes (R2.4: cull pass 1's, then with occlusion pass 2's in prepass part 2, graph
//!   node 8), and a world stage's custom geometry ([`PrepassDraw`]: custom materials' meshes at
//!   their model matrices), so its consumers see everything opaque.
//! - **Consumers** ([`PrepassConsumers`], [`consumers`]): ambient occlusion, contact shadows, TAA's
//!   motion (RQ5), Hi-Z occlusion (R2), a Level-3 pass declaring depth or normals or registered at
//!   `after-prepass`, and a Level-2 v2 source that binds them. The prepass runs when the quality
//!   allows it and one of them asks, or when the extension ladder asks whatever the switch says
//!   (a game's pass or source reading depth must never read a neutral far plane: [`served`]);
//!   the frame renderer and the part-1 path hand it the demand of the frame's Level-3 passes and
//!   Level-2 v2 sources (RQ4.5); a consumer whose own node has not landed
//!   asks for nothing yet ([`drawn_consumers`]), so a frame without consumers keeps today's pass
//!   count. Occlusion asks only on frames with meshlet candidates ([`PrepassConsumers::without`]).
//! - **Equal reuse** ([`equal_depth_reuse`], [`main_pass_equal`]): on immediate-mode GPUs at 1x the
//!   main pass tests `Equal` against the prepass depth with depth writes off, saving overdraw. On
//!   tile GPUs the prepass is a second geometry pass whose depth would have to leave tile memory,
//!   so the main pass keeps its own (transient) depth there (plan G5/P5: on TBDR the main pass must
//!   not get slower). Bit-identical depth between the two passes comes from the shared
//!   `@invariant` `gx_clip_position` (`shaders::DEPTH_WRITING_VERTEX_ENTRIES`). A frame whose
//!   prepass drew custom geometry keeps the main pass's own depth too: custom-material pipelines
//!   write depth with a strict `Less`, which would reject their own prepass depth.

use wgpu::{TextureFormat, TextureUsages};

use crate::abi::RenderInputs;
use crate::device_class::FormFactor;
use crate::scene::MeshId;
use crate::settings::{AoResolution, Quality};
use crate::target_pool::TargetDesc;

/// Whether the graph schedules the prepass (node 7) and its `prepass` switch changes the picture.
pub const LANDED: bool = true;
/// The normals target's format: octahedral unit normals in -1..1 (fragment-written; renderable and
/// filterable in core, never storage).
pub const NORMALS_FORMAT: TextureFormat = TextureFormat::Rg16Float;
/// The prepass depth's usages: drawn, then sampled by its consumers (never transient).
pub const DEPTH_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The normals target's usages.
pub const NORMALS_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// What a test or diagnostic reading the targets back adds to their usages.
pub const READBACK_USAGE: TextureUsages = TextureUsages::COPY_SRC;
/// Bytes between two custom-geometry rows (WebGPU core's uniform offset alignment).
pub const DRAW_STRIDE: u64 = 256;
/// The prepass depth's pool label.
pub const DEPTH_LABEL: &str = "prepass depth";
/// The normals target's pool label.
pub const NORMALS_LABEL: &str = "prepass normals";

/// Who asks for the prepass this frame (a small bit set).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct PrepassConsumers(u32);

impl PrepassConsumers {
    /// Nobody.
    pub const NONE: PrepassConsumers = PrepassConsumers(0);
    /// Ambient occlusion (GTAO reads depth and normals).
    pub const AO: PrepassConsumers = PrepassConsumers(1);
    /// Screen-space contact shadows (depth).
    pub const CONTACT_SHADOWS: PrepassConsumers = PrepassConsumers(1 << 1);
    /// TAA's motion vectors and closest-depth dilation (RQ5).
    pub const TAA: PrepassConsumers = PrepassConsumers(1 << 2);
    /// Two-pass Hi-Z occlusion culling (R2).
    pub const OCCLUSION: PrepassConsumers = PrepassConsumers(1 << 3);
    /// A Level-3 pass: one declaring `RenderInputs::DEPTH`/`NORMALS`, or registered at `after-prepass`.
    pub const CUSTOM_PASS: PrepassConsumers = PrepassConsumers(1 << 4);
    /// A Level-2 v2 source whose module binds `gx_depth` or `gx_normals`.
    pub const EXTENSION: PrepassConsumers = PrepassConsumers(1 << 5);

    const NAMED: [(PrepassConsumers, &'static str); 6] = [
        (PrepassConsumers::AO, "ao"),
        (PrepassConsumers::CONTACT_SHADOWS, "contact-shadows"),
        (PrepassConsumers::TAA, "taa"),
        (PrepassConsumers::OCCLUSION, "occlusion"),
        (PrepassConsumers::CUSTOM_PASS, "custom-pass"),
        (PrepassConsumers::EXTENSION, "extension"),
    ];

    /// The extension ladder's consumers: a game's Level-3 pass or Level-2 v2 source reading the
    /// prepass. They make it run whatever the quality's switch says ([`runs`]).
    pub const EXTENSION_LADDER: PrepassConsumers = PrepassConsumers::CUSTOM_PASS.union(PrepassConsumers::EXTENSION);

    /// Whether nobody asks.
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The consumers of `self` that are also in `other`.
    pub const fn intersection(self, other: PrepassConsumers) -> PrepassConsumers {
        PrepassConsumers(self.0 & other.0)
    }

    /// Whether every consumer of `other` asks.
    pub const fn contains(self, other: PrepassConsumers) -> bool {
        self.0 & other.0 == other.0
    }

    /// Both sets.
    pub const fn union(self, other: PrepassConsumers) -> PrepassConsumers {
        PrepassConsumers(self.0 | other.0)
    }

    /// The consumers of `self` that are not in `other` (a frame with nothing for a consumer to do:
    /// occlusion without meshlet candidates).
    pub const fn without(self, other: PrepassConsumers) -> PrepassConsumers {
        PrepassConsumers(self.0 & !other.0)
    }

    /// The consumers' stable spellings (timings, `degraded` subjects), in a fixed order.
    pub fn wires(self) -> Vec<&'static str> {
        PrepassConsumers::NAMED.iter().filter(|(consumer, _)| self.contains(*consumer)).map(|(_, name)| *name).collect()
    }
}

impl std::ops::BitOr for PrepassConsumers {
    type Output = PrepassConsumers;

    fn bitor(self, other: PrepassConsumers) -> PrepassConsumers {
        self.union(other)
    }
}

/// What the extension ladder asks of the frame: the inputs running Level-3 v2 passes declare
/// (`CustomPasses::render_inputs`), whether a pass is registered at `after-prepass`, and the inputs
/// the Level-2 v2 sources in use bind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExtensionDemand {
    /// What running Level-3 v2 passes declare.
    pub custom_inputs: RenderInputs,
    /// Whether a Level-3 pass runs at `after-prepass`.
    pub after_prepass: bool,
    /// What the Level-2 v2 sources in use bind.
    pub extension_inputs: RenderInputs,
    /// Whether any Level-3 pass runs this frame: it may read the sun's maps anywhere, so each
    /// cascade keeps its whole cull view ([`crate::shadow::cull_to_receivers`] stands down).
    pub level3: bool,
}

/// Whether `inputs` read the prepass's targets (its motion included, RQ5.6: the motion prepass is
/// the prepass writing two more targets).
fn reads_prepass(inputs: RenderInputs) -> bool {
    inputs.contains(RenderInputs::DEPTH) || inputs.contains(RenderInputs::NORMALS) || inputs.contains(RenderInputs::MOTION)
}

/// Who asks for the prepass under `quality` and the extension ladder's `demand`. A feature's
/// switch counts only when it is on; whether it has landed is the graph's business.
pub fn consumers(quality: &Quality, demand: ExtensionDemand) -> PrepassConsumers {
    let asks = [
        (quality.ao.resolution != AoResolution::Off, PrepassConsumers::AO),
        (quality.contact_shadows, PrepassConsumers::CONTACT_SHADOWS),
        (quality.anti_aliasing.temporal(), PrepassConsumers::TAA),
        (quality.occlusion, PrepassConsumers::OCCLUSION),
        (demand.after_prepass || reads_prepass(demand.custom_inputs), PrepassConsumers::CUSTOM_PASS),
        (reads_prepass(demand.extension_inputs), PrepassConsumers::EXTENSION),
    ];
    asks.into_iter().filter(|(on, _)| *on).fold(PrepassConsumers::NONE, |all, (_, consumer)| all | consumer)
}

/// The consumers the prepass runs for under `quality`: every one of `consumers` with the quality's
/// switch on, only the extension ladder's with it off ([`PrepassConsumers::EXTENSION_LADDER`]:
/// inputs drive producers, so a game's pass or source reading depth or normals gets them on every
/// preset and device, the ones whose switch is off included, instead of a neutral far plane); None
/// when that is nobody.
pub fn served(quality: &Quality, consumers: PrepassConsumers) -> Option<PrepassConsumers> {
    let served = if quality.prepass { consumers } else { consumers.intersection(PrepassConsumers::EXTENSION_LADDER) };
    (!served.is_empty()).then_some(served)
}

/// Whether the prepass runs: the quality allows it and somebody asks, or the extension ladder asks
/// ([`served`]).
pub fn runs(quality: &Quality, consumers: PrepassConsumers) -> bool {
    served(quality, consumers).is_some()
}

/// `consumers` on a frame whose sun casts shadows (`sun_shadows`) or not: contact shadows march
/// only towards a shadowed sun ([`crate::post::contact_shadow::runs`]), so without one they ask
/// nothing of the prepass and a frame whose only consumer they were records no geometry pass.
pub fn with_sun_shadows(consumers: PrepassConsumers, quality: &Quality, sun_shadows: bool) -> PrepassConsumers {
    if crate::post::contact_shadow::runs(quality, sun_shadows) {
        return consumers;
    }
    consumers.without(PrepassConsumers::CONTACT_SHADOWS)
}

/// Whether the GPU keeps attachments in tile memory: the adapter's `transient_saves_memory` when it
/// says, else the class's form (wgpu's WebGPU backend never says, and a phone's browser runs on a
/// tile GPU while a desktop's does not).
pub const fn tile_gpu(transient_saves_memory: Option<bool>, form: FormFactor) -> bool {
    match transient_saves_memory {
        Some(tile) => tile,
        None => matches!(form, FormFactor::Mobile),
    }
}

/// Whether the main pass reuses the prepass depth with `Equal` (depth writes off): only on an
/// immediate-mode GPU (`tile_gpu` false) with a single-sampled world pass, since the prepass is 1x.
/// Elsewhere the main pass keeps its own depth test and the prepass depth is only read.
pub const fn equal_depth_reuse(tile_gpu: bool, samples: u32) -> bool {
    !tile_gpu && samples == 1
}

/// Whether this frame's main pass tests `Equal` against the prepass depth: [`equal_depth_reuse`]
/// unless a test or diagnostic forces it (`forced`, never with MSAA), and only when the prepass drew
/// no custom geometry (module docs).
pub const fn main_pass_equal(tile_gpu: bool, samples: u32, forced: Option<bool>, custom_draws: usize) -> bool {
    let by_device = match forced {
        Some(on) => on && samples == 1,
        None => equal_depth_reuse(tile_gpu, samples),
    };
    by_device && custom_draws == 0
}

/// The consumers whose producer node is in this build: a switch whose node has not landed asks
/// for nothing yet (no AO, contact-shadow, TAA or occlusion node reads the prepass until it
/// lands), while the extension ladder's demand always counts.
pub fn drawn_consumers(quality: &Quality, demand: ExtensionDemand) -> PrepassConsumers {
    let landed = [
        (PrepassConsumers::AO, crate::post::ao::LANDED),
        (PrepassConsumers::CONTACT_SHADOWS, crate::post::contact_shadow::LANDED),
        (PrepassConsumers::TAA, crate::motion::LANDED),
        (PrepassConsumers::OCCLUSION, crate::meshlet_cull::occlusion_landed()),
        (PrepassConsumers::CUSTOM_PASS, true),
        (PrepassConsumers::EXTENSION, true),
    ];
    let asked = consumers(quality, demand);
    landed.into_iter().filter(|(consumer, drawn)| *drawn && asked.contains(*consumer)).fold(PrepassConsumers::NONE, |all, (consumer, _)| all | consumer)
}

/// One custom-geometry draw the prepass adds to the opaque batches: a library mesh at a model
/// matrix (a custom material's draw, [`crate::renderer::WorldStage::prepass_draws`]), with last
/// frame's model matrix for its motion (renderer pass 2, P2-0.8b T-04).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrepassDraw {
    /// The mesh.
    pub mesh: MeshId,
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Last frame's model matrix (this frame's for a draw that stood still or has no history).
    pub prev_model: [f32; 16],
    /// Whether the draw has history: matched to last frame's (`crate::motion::CustomMotion`). One
    /// without writes the no-history flag, so TAA takes the current sample where it lands.
    pub history: bool,
}

impl PrepassDraw {
    /// `mesh` at `model` standing still with its history (a stage whose geometry never moves).
    pub const fn still(mesh: MeshId, model: [f32; 16]) -> PrepassDraw {
        PrepassDraw { mesh, model, prev_model: model, history: true }
    }
}

/// A custom-geometry draw's uniform row (`PrepassDraw` in shaders/prepass.wgsl), [`DRAW_STRIDE`]
/// apart: the model matrix, its inverse-transpose, last frame's model matrix and the motion flags.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuPrepassDraw {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Its inverse-transpose, for normals.
    pub normal: [f32; 16],
    /// Last frame's model matrix (the motion prepass's previous position, T-04).
    pub prev_model: [f32; 16],
    /// x: [`crate::motion::MOTION_FLAG_NO_HISTORY`] for a draw without history; y, z, w: 0.
    pub flags: [u32; 4],
}

impl GpuPrepassDraw {
    /// The row of `draw`.
    pub fn of(draw: &PrepassDraw) -> GpuPrepassDraw {
        let normal = crate::instance::instance_row(&draw.model, [0.0; 3], 0.0, 0).normal;
        let flags = [if draw.history { 0 } else { crate::motion::MOTION_FLAG_NO_HISTORY }, 0, 0, 0];
        GpuPrepassDraw { model: draw.model, normal, prev_model: draw.prev_model, flags }
    }
}

const _: () = assert!(size_of::<GpuPrepassDraw>() as u64 <= DRAW_STRIDE);

/// How a frame's prepass ran ([`crate::Renderer::last_prepass`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrepassInfo {
    /// Who asked for it.
    pub consumers: PrepassConsumers,
    /// Whether the main pass tested `Equal` against its depth (depth writes off) instead of
    /// keeping its own.
    pub equal_depth: bool,
    /// The custom-geometry draws it drew besides the opaque batches.
    pub custom_draws: u32,
    /// The render size it drew at.
    pub size: (u32, u32),
}

/// The prepass targets at `render` size (1x: the prepass never multisamples).
pub fn targets(render: (u32, u32)) -> [TargetDesc; 2] {
    let size = (render.0.max(1), render.1.max(1));
    let target = |label, format, usage| TargetDesc { label, format, usage, samples: 1, size, mips: 1, srgb_view: false };
    [target(DEPTH_LABEL, crate::renderer::DEPTH_FORMAT, DEPTH_USAGE), target(NORMALS_LABEL, NORMALS_FORMAT, NORMALS_USAGE)]
}

/// The CPU twin of `gx_oct_encode` (shaders/effects.wgsl): a unit normal as two numbers in -1..1.
pub fn oct_encode(n: [f32; 3]) -> [f32; 2] {
    let sum = (n[0].abs() + n[1].abs() + n[2].abs()).max(1e-8);
    let p = [n[0] / sum, n[1] / sum];
    if n[2] >= 0.0 {
        return p;
    }
    let sign = |v: f32| if v >= 0.0 { 1.0 } else { -1.0 };
    [(1.0 - p[1].abs()) * sign(p[0]), (1.0 - p[0].abs()) * sign(p[1])]
}

/// The CPU twin of `gx_oct_decode`: the unit normal `oct_encode` encoded as `e`.
pub fn oct_decode(e: [f32; 2]) -> [f32; 3] {
    let mut n = [e[0], e[1], 1.0 - e[0].abs() - e[1].abs()];
    let t = (-n[2]).max(0.0);
    n[0] += if n[0] >= 0.0 { -t } else { t };
    n[1] += if n[1] >= 0.0 { -t } else { t };
    let length = libm::sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).max(1e-20);
    n.map(|c| c / length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AntiAliasing, RenderFeature};

    #[test]
    fn nobody_asks_in_the_legacy_renderer_so_the_prepass_never_runs() {
        let off = Quality::off();
        assert_eq!(consumers(&off, ExtensionDemand::default()), PrepassConsumers::NONE);
        assert!(!runs(&off, PrepassConsumers::AO), "the quality's switch gates every built-in consumer");
    }

    #[test]
    fn the_extension_ladder_makes_the_prepass_run_whatever_the_quality_switch_says() {
        let off = Quality::off();
        assert!(!off.prepass);
        for consumer in [PrepassConsumers::CUSTOM_PASS, PrepassConsumers::EXTENSION] {
            assert!(runs(&off, consumer), "{:?}: inputs drive producers", consumer.wires());
            assert!(runs(&off, consumer | PrepassConsumers::AO));
        }
        assert!(!runs(&off, PrepassConsumers::AO | PrepassConsumers::TAA | PrepassConsumers::OCCLUSION));
        assert_eq!(served(&off, PrepassConsumers::AO | PrepassConsumers::CUSTOM_PASS), Some(PrepassConsumers::CUSTOM_PASS), "only the ladder's, with the switch off");
        let mut on = off;
        on.prepass = true;
        assert_eq!(served(&on, PrepassConsumers::AO | PrepassConsumers::CUSTOM_PASS), Some(PrepassConsumers::AO | PrepassConsumers::CUSTOM_PASS));
    }

    #[test]
    fn each_consumer_asks_only_with_its_feature_on() {
        let mut quality = Quality::off();
        quality.set_feature(RenderFeature::Prepass, true);
        assert!(!runs(&quality, consumers(&quality, ExtensionDemand::default())), "pay for what you use");
        quality.set_feature(RenderFeature::Ao, true);
        quality.set_feature(RenderFeature::ContactShadows, true);
        quality.anti_aliasing = AntiAliasing::Taa;
        quality.set_feature(RenderFeature::Occlusion, true);
        let all = consumers(&quality, ExtensionDemand::default());
        assert_eq!(all.wires(), ["ao", "contact-shadows", "taa", "occlusion"]);
        assert!(runs(&quality, all));
    }

    #[test]
    fn the_extension_ladder_asks_through_declared_inputs_and_the_after_prepass_stage() {
        let quality = Quality::off();
        let motion_only = ExtensionDemand { custom_inputs: RenderInputs::MOTION, ..ExtensionDemand::default() };
        // RQ5.6 flipped: the motion target is the prepass's (its motion variant writes it), so a
        // declared motion input runs the prepass like depth or normals (inputs drive producers).
        assert_eq!(consumers(&quality, motion_only), PrepassConsumers::CUSTOM_PASS, "motion is written by the prepass");
        let depth = ExtensionDemand { custom_inputs: RenderInputs::DEPTH, ..ExtensionDemand::default() };
        assert_eq!(consumers(&quality, depth), PrepassConsumers::CUSTOM_PASS);
        let stage = ExtensionDemand { after_prepass: true, ..ExtensionDemand::default() };
        assert_eq!(consumers(&quality, stage), PrepassConsumers::CUSTOM_PASS);
        let material = ExtensionDemand { extension_inputs: RenderInputs::NORMALS, ..ExtensionDemand::default() };
        assert_eq!(consumers(&quality, material), PrepassConsumers::EXTENSION);
    }

    #[test]
    fn equal_reuse_is_for_single_sampled_immediate_mode_gpus_only() {
        assert!(equal_depth_reuse(false, 1));
        assert!(!equal_depth_reuse(true, 1), "a tile GPU keeps its own depth in tile memory");
        assert!(!equal_depth_reuse(false, 4), "the prepass is 1x; an MSAA main pass cannot test against it");
    }

    #[test]
    fn the_targets_are_render_sized_sampleable_and_single_sampled() {
        let [depth, normals] = targets((960, 540));
        assert_eq!((depth.size, depth.samples, normals.size, normals.format), ((960, 540), 1, (960, 540), NORMALS_FORMAT));
        assert!(depth.usage.contains(TextureUsages::TEXTURE_BINDING) && !depth.usage.contains(TextureUsages::TRANSIENT_ATTACHMENT));
        assert_eq!(targets((0, 0))[0].size, (1, 1));
    }

    #[test]
    fn octahedral_normals_round_trip_on_every_octant() {
        for &n in &[[0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.577, -0.577, -0.577], [-0.3, 0.4, -0.866]] {
            let length = libm::sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            let unit = n.map(|c: f32| c / length);
            let e = oct_encode(unit);
            assert!(e.iter().all(|c| (-1.0..=1.0).contains(c)), "{e:?}");
            let back = oct_decode(e);
            for axis in 0..3 {
                assert!((back[axis] - unit[axis]).abs() < 1e-5, "{unit:?} -> {e:?} -> {back:?}");
            }
        }
        assert_eq!(oct_encode([0.0, 0.0, 0.0]), [0.0, 0.0], "a zero normal encodes as +z");
    }
}
