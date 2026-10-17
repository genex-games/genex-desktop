//! `genex::gpu`: custom GPU passes, extension ladder level 3. A game writes raw wgpu compute and
//! render passes in safe Rust and registers each once, at a fixed stage of the runtime frame:
//!
//! ```
//! use genex::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
//! use genex::prelude::*;
//!
//! #[derive(Default)]
//! struct World { glow: f32 }
//!
//! /// Tints the finished frame (a real pass builds its pipeline in `rebuild`).
//! #[derive(Default)]
//! struct Tint { pipeline: Option<genex::gpu::RenderPipeline> }
//!
//! impl GpuPass<World> for Tint {
//!     fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
//!         let _module = setup.create_shader("tint", "@compute @workgroup_size(1) fn main() {}")?;
//!         Ok(())
//!     }
//!     fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
//!         let _glow = ctx.sim().world.glow; // read-only: a pass never changes the simulation
//!         let Some(_encoder) = ctx.encoder() else { return };
//!     }
//! }
//!
//! let mut game = Game::new(World::default());
//! game.gpu_pass("tint", PassStage::Post, Tint::default());
//! ```
//!
//! The stages, the frame's read-only tables ([`TABLES_WGSL`]), the caps and the refusals are
//! genex-render's ([`genex_render::custom_pass`]): resources come from [`PassSetup`] in the
//! rebuild hook (at install and again after device loss) and count against the GPU caps; WGSL is
//! validated by naga against WebGPU core plus the game's declared native features
//! (`gpu-pass-invalid`, `native-feature-missing`); wgpu's validation errors become
//! `gpu-pass-invalid` naming the pass; each pass is one logical draw under [`CUSTOM_TAG`].
//!
//! Captures, Live and determinism hold: a pass runs inside the runtime frame, before capture
//! readback and the Live ring copy, sees `&Sim` and the tick only, and nothing here hands GPU data
//! to an update hook. Neither of these compiles:
//!
//! ```compile_fail,E0599
//! # use genex::prelude::*;
//! # #[derive(Default)] struct World { score: u32 }
//! # let mut game = Game::new(World::default());
//! // Update hooks get a `Ctx`, which has no GPU: there is no device, buffer or readback to reach.
//! game.on_update(|sim, ctx| sim.world.score = ctx.gpu().read_back());
//! ```
//!
//! ```compile_fail,E0594
//! # use genex::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup};
//! # #[derive(Default)] struct World { score: u32 }
//! struct Cheat;
//! impl GpuPass<World> for Cheat {
//!     fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> { Ok(()) }
//!     // A pass sees the simulation read-only: it cannot write what the checksum reads.
//!     fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) { ctx.sim().world.score += 1; }
//! }
//! ```
//!
//! The device itself is never handed out: every resource comes through [`PassSetup`], so the caps
//! and naga's admission cannot be skipped, and no buffer a pass makes is mappable.
//!
//! # Custom-pass API v2
//!
//! A pass declares the API it is written against ([`GpuPass::api`], 1 by default) and, at v2, the
//! frame inputs it reads ([`GpuPass::inputs`]). A v2 pass binds the v2 tables
//! ([`TABLES_V2_WGSL`]: the whole `GxFrameV2` with `pre_exposure`, `depth_reversed`, `scene_ldr`
//! and the matrices, the rows, and depth, normals, motion and the environment, neutral until their
//! producers run), draws in the scene format at the in-world stages and at
//! [`PassStage::PostHdr`] (after TAA's place, before bloom and the tonemap), and reads
//! [`PassFrame::depth_reversed`] and [`PassFrame::render_size`]. Declaring `RenderInputs::DEPTH`
//! or `NORMALS`, or registering at [`PassStage::AfterPrepass`] (after the depth/normal prepass,
//! before the world pass), makes the renderer draw its prepass on every preset (inputs drive
//! producers): the encoder stages read it through [`PassFrame::prepass_depth`] and
//! [`PassFrame::prepass_normals`] and as `gx_depth` and `gx_normals` in the v2 tables. Once the
//! prepass writes motion vectors (TAA), the same stages read them through
//! [`PassFrame::prepass_motion`] and as `gx_motion` (`rg16float` NDC motion, current minus
//! previous, jitter removed: a pixel at `uv` was at `uv - motion * vec2(0.5, -0.5)` last frame;
//! zero motion before that). Under TAA an in-world pass hands TAA what it moves itself:
//! [`PassFrame::motion_draws`] (a vertex animation's motion, evaluated at [`PassFrame::tick`] and
//! [`PassFrame::prev_tick`], for example with the shared `gx_wind`) and [`PassFrame::reactive_draws`]
//! (the coverage of blended work moving over the scene), built with [`PassSetup::motion_target`],
//! [`PassSetup::reactive_target`] and [`PassSetup::temporal_depth`]; without them its pixels keep
//! the motion of what the prepass drew behind them. A v1 pass at `after-opaque` or
//! `after-transparent` keeps the game's frame on the legacy LDR scene (`custom-pass-v1-in-world`
//! in `state().volatile.render.degraded`); write new passes at v2. Bloom and fog are the look's
//! (`genex::render::RenderConfig::bloom` and `RenderConfig::fog`), not a pass's job:
//!
//! ```
//! use genex::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage, RenderInputs};
//! use genex::prelude::*;
//!
//! #[derive(Default)]
//! struct World;
//!
//! /// Outlines silhouettes by depth before the tonemap (a real pass builds its pipeline in `rebuild`).
//! #[derive(Default)]
//! struct DepthOutline;
//!
//! impl GpuPass<World> for DepthOutline {
//!     fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
//!         let _format = setup.world_format(); // the scene format at post-hdr
//!         let _module = setup.create_shader("outline", "@group(0) @binding(0) var<uniform> gx_frame: GxFrameV2;")?;
//!         Ok(())
//!     }
//!     fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
//!         let _reversed = ctx.depth_reversed();
//!     }
//!     fn api(&self) -> u32 {
//!         2
//!     }
//!     fn inputs(&self) -> RenderInputs {
//!         RenderInputs::DEPTH
//!     }
//! }
//!
//! let mut game = Game::new(World);
//! game.gpu_pass("outline", PassStage::PostHdr, DepthOutline);
//! ```

use std::ops::{Deref, DerefMut};

use crate::game::Game;
use crate::runtime::Runtime;
use crate::sim::Sim;
use genex_render::custom_pass::{CustomPass, check_pass_name};

pub use genex_render::abi::RenderInputs;
pub use genex_render::custom_pass::{
    CUSTOM_PASS_API_VERSION, CUSTOM_PASS_APIS, CUSTOM_TAG, GPU_PASS_BYTES_MAX, GPU_PASSES_MAX, PassFrame, PassSetup, PassStage, TABLES_V2_WGSL,
    TABLES_WGSL, WorldDraws,
};
pub use genex_render::{RenderCode as GpuCode, RenderError as GpuError};

/// The pinned wgpu types a pass is written with: genex's wgpu, so a game never names a version.
pub use wgpu::{
    AddressMode, BindGroup, BindGroupDescriptor, BindGroupEntry, BindGroupLayout, BindGroupLayoutDescriptor, BindGroupLayoutEntry,
    BindingResource, BindingType, BlendComponent, BlendFactor, BlendOperation, BlendState, Buffer, BufferAddress, BufferBinding,
    BufferBindingType, BufferDescriptor, BufferSize, BufferUsages, Color as ClearColor, ColorTargetState, ColorWrites, CommandEncoder,
    CompareFunction, ComputePass, ComputePassDescriptor, ComputePipeline, ComputePipelineDescriptor, DepthBiasState, DepthStencilState,
    Extent3d, Face, FilterMode, FragmentState, FrontFace, IndexFormat, LoadOp, MipmapFilterMode, MultisampleState, Operations, Origin3d,
    PipelineCompilationOptions, PipelineLayout, PipelineLayoutDescriptor, PolygonMode, PrimitiveState, PrimitiveTopology, RenderPass,
    RenderPassColorAttachment, RenderPassDescriptor, RenderPipeline, RenderPipelineDescriptor, Sampler, SamplerBindingType,
    SamplerDescriptor, ShaderModule, ShaderStages, StencilState, StoreOp, Texture, TextureAspect, TextureDescriptor, TextureDimension,
    TextureFormat, TextureSampleType, TextureUsages, TextureView, TextureViewDescriptor, TextureViewDimension, VertexAttribute,
    VertexBufferLayout, VertexFormat, VertexState, VertexStepMode,
};

/// The native-enhanced features this build declares (`[gpu] native_features`, which the lane
/// compiles in as `GENEX_NATIVE_FEATURES`): a phone shell opens its device with exactly these, and
/// an adapter that lacks one is refused `native-feature-missing` before any device exists. An
/// unknown name is refused the same way.
#[cfg(not(target_arch = "wasm32"))]
pub fn declared_native_features() -> Result<wgpu::Features, GpuError> {
    crate::present::declared_features()
}

/// A custom GPU pass over a game whose world is `W`. `rebuild` creates every resource through
/// [`PassSetup`] (at install, and on the new device after a loss); `run` records one frame's work
/// through [`GpuPassCtx`], which reads the simulation but never writes it.
pub trait GpuPass<W>: 'static {
    /// Create (or re-create) the pass's resources.
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError>;
    /// Record this frame's work.
    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, W>);
    /// The custom-pass API the pass is written against: 1 (the default, the v1 tables and the
    /// world format) or 2 (the v2 tables, the scene format, `post-hdr`).
    fn api(&self) -> u32 {
        genex_render::abi::ABI_V1
    }
    /// The frame inputs an API v2 pass reads (depth, normals, motion, the environment, the HDR
    /// scene); the frame graph produces each one a running pass declares. None by default.
    fn inputs(&self) -> RenderInputs {
        RenderInputs::NONE
    }
}

/// What a pass records a frame through: genex-render's [`PassFrame`] (its encoder or in-world
/// draws, the frame's tables, the world target at the post stage, the upload budget), plus the
/// simulation, read-only.
pub struct GpuPassCtx<'c, 'f, W> {
    frame: &'c mut PassFrame<'f>,
    sim: &'c Sim<W>,
}

impl<W> GpuPassCtx<'_, '_, W> {
    /// The simulation this frame shows, read-only.
    pub fn sim(&self) -> &Sim<W> {
        self.sim
    }
}

impl<'f, W> Deref for GpuPassCtx<'_, 'f, W> {
    type Target = PassFrame<'f>;

    fn deref(&self) -> &PassFrame<'f> {
        self.frame
    }
}

impl<W> DerefMut for GpuPassCtx<'_, '_, W> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.frame
    }
}

/// One `game.gpu_pass(..)` registration.
pub(crate) struct GpuPassEntry<W> {
    name: String,
    stage: PassStage,
    pass: Box<dyn GpuPass<W>>,
    /// False once the studio's renderer refused it at install: it neither runs nor counts.
    admitted: bool,
}

impl<W: Default + 'static> Game<W> {
    /// Register `pass` as `name` at `stage` (extension ladder level 3; see [`crate::gpu`]). Panics
    /// with `gpu-pass-invalid` for an empty, overlong or control-character name, a name already
    /// registered, or more than [`GPU_PASSES_MAX`] passes, as `install` does for other
    /// inconsistent registrations.
    pub fn gpu_pass(&mut self, name: &str, stage: PassStage, pass: impl GpuPass<W>) -> &mut Self {
        if let Err(error) = check_pass_name(name) {
            panic!("genex::Game::gpu_pass: {error}");
        }
        if self.gpu_passes.iter().any(|entry| entry.name == name) {
            panic!("genex::Game::gpu_pass: {}: pass `{name}` is registered twice", GpuCode::GpuPassInvalid);
        }
        if self.gpu_passes.len() >= GPU_PASSES_MAX {
            panic!("genex::Game::gpu_pass: {}: pass `{name}`: at most {GPU_PASSES_MAX} custom passes", GpuCode::GpuPassInvalid);
        }
        self.gpu_passes.push(GpuPassEntry { name: name.to_owned(), stage, pass: Box::new(pass), admitted: true });
        self
    }
}

/// The game's passes as `(name, stage)`, in registration order.
pub(crate) fn registered<W>(entries: &[GpuPassEntry<W>]) -> Vec<(String, PassStage)> {
    entries.iter().map(|entry| (entry.name.clone(), entry.stage)).collect()
}

/// Logical draws the passes add to a frame's tally (one per admitted pass), merged into `tags`
/// under [`CUSTOM_TAG`] as `(tag, draws, triangles)`.
pub(crate) fn tally<W>(entries: &[GpuPassEntry<W>], tags: &mut Vec<(String, u32, u32)>) -> u32 {
    let draws = entries.iter().filter(|entry| entry.admitted).count() as u32;
    if draws == 0 {
        return 0;
    }
    match tags.iter_mut().find(|(tag, _, _)| tag == CUSTOM_TAG) {
        Some((_, count, _)) => *count += draws,
        None => tags.push((CUSTOM_TAG.to_owned(), draws, 0)),
    }
    draws
}

/// A pass bound to the simulation it reads this frame: what genex-render runs.
struct Bound<'s, W> {
    pass: &'s mut dyn GpuPass<W>,
    sim: &'s Sim<W>,
}

impl<W: 'static> CustomPass for Bound<'_, W> {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        self.pass.rebuild(setup)
    }

    fn encode(&mut self, frame: &mut PassFrame<'_>) {
        let mut ctx = GpuPassCtx { frame, sim: self.sim };
        self.pass.run(&mut ctx);
    }

    fn api(&self) -> u32 {
        self.pass.api()
    }

    fn inputs(&self) -> RenderInputs {
        self.pass.inputs()
    }
}

/// Host glue for the platform shells and the studio: binding a runtime's passes to its
/// simulation for genex-render. Not for game code (it needs a renderer, which games never hold).
#[doc(hidden)]
pub mod host {
    use super::{Bound, GpuError, registered};
    use crate::runtime::Runtime;
    use genex_render::Gpu;
    use genex_render::custom_pass::{CustomPass, CustomPasses};

    /// Run `f` over the runtime's admitted passes, bound to its simulation, in registration order,
    /// with the tick the frame shows.
    pub fn with_passes<W: Default + 'static, R>(runtime: &mut Runtime<W>, f: impl FnOnce(&mut [&mut dyn CustomPass], u64) -> R) -> R {
        let (entries, sim, tick) = runtime.gpu_pass_parts();
        let mut bound: Vec<Bound<'_, W>> =
            entries.iter_mut().filter(|entry| entry.admitted).map(|entry| Bound { pass: entry.pass.as_mut(), sim }).collect();
        let mut passes: Vec<&mut dyn CustomPass> = bound.iter_mut().map(|pass| pass as &mut dyn CustomPass).collect();
        f(&mut passes, tick)
    }

    /// Register the runtime's passes into `passes` on `gpu`; a refused pass is left out of every
    /// frame (and of the draw count). Answers the refused passes' names with their refusals.
    pub fn install<W: Default + 'static>(runtime: &mut Runtime<W>, passes: &mut CustomPasses, gpu: &Gpu) -> Vec<(String, GpuError)> {
        let names = registered(runtime.gpu_pass_parts().0);
        let mut refusals = Vec::new();
        let (entries, sim, _) = runtime.gpu_pass_parts();
        for (entry, (name, stage)) in entries.iter_mut().zip(names) {
            let mut bound = Bound { pass: entry.pass.as_mut(), sim };
            if let Err(error) = passes.register(gpu, &name, stage, &mut bound) {
                entry.admitted = false;
                refusals.push((name, error));
            }
        }
        refusals
    }
}

impl<W: Default + 'static> Runtime<W> {
    /// The custom GPU passes the game registered, as `(name, stage)` in registration order.
    pub fn gpu_passes(&mut self) -> Vec<(String, PassStage)> {
        registered(self.gpu_pass_parts().0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Key, View};

    #[derive(Default)]
    struct World {
        x: i64,
        seen: u64,
    }

    /// A pass that does nothing on the GPU (no GPU here) and counts its runs in its own state.
    struct Quiet {
        runs: u32,
    }

    impl GpuPass<World> for Quiet {
        fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
            Ok(())
        }

        fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
            self.runs += u32::try_from(ctx.sim().world.seen).unwrap_or(0);
        }
    }

    fn game(with_passes: bool) -> Game<World> {
        let mut game = Game::new(World::default()).world_size(320, 180);
        game.on_update(|sim, ctx| {
            sim.world.x += if ctx.keys.down(Key::Space) { 3 } else { 1 };
            sim.world.seen += 1;
        });
        game.probe("x", |sim| serde_json::json!(sim.world.x));
        game.on_draw(|sim, frame, _| {
            frame.cube(crate::Transform::from_xyz(sim.world.x as f32 * 0.01, 0.0, 0.0), crate::Color::WHITE);
        });
        if with_passes {
            game.gpu_pass("glow", PassStage::Post, Quiet { runs: 0 });
            game.gpu_pass("ring", PassStage::AfterOpaque, Quiet { runs: 0 });
        }
        game
    }

    #[test]
    fn the_600_tick_state_checksum_is_the_same_with_and_without_passes() {
        let mut plain = Runtime::new(game(false)).expect("plain game");
        let mut with = Runtime::new(game(true)).expect("game with passes");
        for runtime in [&mut plain, &mut with] {
            runtime.seed(7);
            runtime.start();
            runtime.step(600.0 * crate::FIXED_STEP_MS);
            let _ = runtime.frame(View::Game);
        }
        assert_eq!(plain.tick(), 600);
        assert_eq!(with.checksum(), plain.checksum(), "registered passes never move the checksum");
        assert_eq!(with.gpu_passes(), vec![("glow".to_owned(), PassStage::Post), ("ring".to_owned(), PassStage::AfterOpaque)]);
    }

    #[test]
    fn each_registered_pass_counts_one_custom_draw_in_the_render_tally() {
        let mut runtime = Runtime::new(game(true)).expect("game");
        runtime.frame(View::Game).expect("frame");
        let state = runtime.state();
        let render = &state["__render"];
        assert_eq!(render["drawCalls"], serde_json::json!(3), "one cube and two passes: {render}");
        let tags = render["tags"].to_string();
        assert!(tags.contains(CUSTOM_TAG), "{tags}");
    }

    #[test]
    fn the_host_binds_passes_to_the_simulation_read_only_in_registration_order() {
        let mut runtime = Runtime::new(game(true)).expect("game");
        runtime.start();
        runtime.step(5.0 * crate::FIXED_STEP_MS);
        let before = runtime.checksum();
        let (count, tick) = host::with_passes(&mut runtime, |passes, tick| (passes.len(), tick));
        assert_eq!((count, tick), (2, 5));
        assert_eq!(runtime.checksum(), before);
    }

    /// A v2 pass that reads depth and motion.
    struct Reads;

    impl GpuPass<World> for Reads {
        fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
            Ok(())
        }

        fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}

        fn api(&self) -> u32 {
            2
        }

        fn inputs(&self) -> RenderInputs {
            RenderInputs::DEPTH | RenderInputs::MOTION
        }
    }

    #[test]
    fn a_passs_api_and_inputs_reach_the_renderer_and_default_to_v1_without_inputs() {
        let mut game = game(true);
        game.gpu_pass("reads", PassStage::PostHdr, Reads);
        let mut runtime = Runtime::new(game).expect("game");
        let declared = host::with_passes(&mut runtime, |passes, _| passes.iter().map(|pass| (pass.api(), pass.inputs())).collect::<Vec<_>>());
        let none = RenderInputs::NONE;
        assert_eq!(declared, vec![(1, none), (1, none), (2, RenderInputs::DEPTH | RenderInputs::MOTION)]);
        assert!(CUSTOM_PASS_APIS.contains(&2), "this build serves custom-pass API v2");
    }

    #[test]
    #[should_panic(expected = "gpu-pass-invalid")]
    fn a_duplicate_pass_name_panics_gpu_pass_invalid() {
        let mut game = game(true);
        game.gpu_pass("glow", PassStage::Post, Quiet { runs: 0 });
    }

    #[test]
    #[should_panic(expected = "gpu-pass-invalid")]
    fn an_empty_pass_name_panics_gpu_pass_invalid() {
        game(false).gpu_pass("", PassStage::Post, Quiet { runs: 0 });
    }

    #[test]
    #[should_panic(expected = "gpu-pass-invalid")]
    fn a_pass_over_the_cap_panics_gpu_pass_invalid() {
        let mut game = game(false);
        for n in 0..=GPU_PASSES_MAX {
            game.gpu_pass(&format!("pass-{n}"), PassStage::Post, Quiet { runs: 0 });
        }
    }
}
