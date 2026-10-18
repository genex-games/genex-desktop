//! What the GPU rows share (the lakeside shots, the bench scene captures and the perf harness in
//! `benches/render_baseline.rs`): the host adapter, the evidence folders, PNG output, the lakeside
//! drawn the way the studio draws a frame, and a bench scene drawn through the renderer.
#![allow(dead_code, reason = "each test target uses a part of the support module")]

use std::path::PathBuf;

use genex::{FIXED_STEP_MS, Runtime, View};
use genex_platform_web::{MeshCache, to_scene};
use genex_render::capture::Capture;
use genex_render::custom_pass::{CustomPasses, CustomStage, NoCustom, PassStage, PipelineFacts, render_scene};
use genex_render::mesh::MeshData;
use genex_render::scene::{MeshId, Scene};
use genex_render::settings::Environment;
use genex_render::skin::{SkinId, SkinnedMeshData};
use genex_render::{CullPath, Gpu, RenderError, Renderer, WorldPass, WorldStage};
use showcase_game::bench::{self, BenchScene, Meshes, SceneId};
use showcase_game::world::World;
use showcase_game::{assets, game};

/// The size the bench scenes are captured at (the lakeside's world size).
pub const SIZE: [u32; 2] = showcase_game::showcase::WORLD_SIZE;
/// The tick every lakeside shot is taken at.
pub const SHOT_TICK: u32 = 600;

/// The evidence folder under the repository's `.studio-dev/evidence/rust-renderer/`.
pub fn evidence_dir(leaf: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer").join(leaf)
}

/// Whether `GENEX_REQUIRE_METAL=1` asks for the Metal adapter (a missing one fails the row).
pub fn metal_required() -> bool {
    std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1")
}

/// Check the opened adapter against `GENEX_REQUIRE_METAL`, or skip without one.
pub fn admit(opened: Result<Gpu, RenderError>) -> Option<Gpu> {
    let require = metal_required();
    match opened {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The host's WebGPU-core adapter with no optional feature.
pub fn gpu() -> Option<Gpu> {
    admit(Gpu::headless())
}

/// The captures folder: `GENEX_SHOWCASE_OUT`, or `captures/latest` in the evidence folder. The
/// tier-over-tier baseline `captures/before` is written only when `GENEX_SHOWCASE_WRITE_BEFORE=1`
/// asks for it, so a run that forgets to name its folder never overwrites the baseline.
pub fn out_dir() -> PathBuf {
    let dir = std::env::var_os("GENEX_SHOWCASE_OUT").map_or_else(|| evidence_dir("captures/latest"), PathBuf::from);
    let before = evidence_dir("captures/before");
    let writes_before = std::env::var("GENEX_SHOWCASE_WRITE_BEFORE").is_ok_and(|v| v == "1");
    let is_before = |path: &PathBuf| path.canonicalize().ok().is_some_and(|path| before.canonicalize().is_ok_and(|before| path == before));
    assert!(writes_before || !is_before(&dir), "{dir:?} is the before baseline: set GENEX_SHOWCASE_WRITE_BEFORE=1 to rewrite it");
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// Write a capture as an opaque RGBA PNG.
pub fn write_png(path: &PathBuf, capture: &Capture) {
    let rgba: Vec<u8> = capture.bgra().chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, capture.width(), capture.height(), image::ExtendedColorType::Rgba8).expect("png written");
}

/// The value at fraction `p` of an ascending list (nearest rank).
pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    let at = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[at.min(sorted.len() - 1)]
}

/// A renderer's library as the bench scenes load into it.
pub struct OnGpu<'a> {
    /// The renderer whose library grows.
    pub renderer: &'a mut Renderer,
    /// Its device.
    pub gpu: &'a Gpu,
}

impl Meshes for OnGpu<'_> {
    fn add(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.renderer.add_mesh(self.gpu, mesh)
    }

    fn add_skinned(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        self.renderer.add_skinned_mesh(self.gpu, data)
    }
}

/// A renderer of `size` holding bench scene `id`'s meshes.
pub fn bench_stage(gpu: &Gpu, id: SceneId, size: [u32; 2]) -> (Renderer, Box<dyn BenchScene>) {
    bench_stage_with(gpu, id, size, genex_render::RenderOptions::default())
}

/// [`bench_stage`] on a renderer built with `options` (one sample for a TAA profile, RQ5.6).
pub fn bench_stage_with(gpu: &Gpu, id: SceneId, size: [u32; 2], options: genex_render::RenderOptions) -> (Renderer, Box<dyn BenchScene>) {
    let mut renderer = Renderer::with_options(gpu, size[0], size[1], options).expect("renderer");
    let scene = bench::load(id, &mut OnGpu { renderer: &mut renderer, gpu }).expect("the scene's meshes load");
    (renderer, scene)
}

/// Bench scene `id` at `frame` of its path, captured at [`SIZE`] on a fresh renderer.
pub fn bench_shot(gpu: &Gpu, id: SceneId, frame: u32) -> Capture {
    let (mut renderer, scene) = bench_stage(gpu, id, SIZE);
    renderer.render(gpu, &scene.scene(frame), CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// Work encoded at the start of a frame's command encoder (a GPU timestamp, in the perf harness).
pub type Marker<'m> = &'m mut dyn FnMut(&mut wgpu::CommandEncoder);

/// A frame's stage with a marker encoded first.
struct Marked<'a, 'm> {
    inner: &'a mut dyn CustomStage,
    marker: Marker<'m>,
}

impl WorldStage for Marked<'_, '_> {
    fn before_cull(&mut self, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        (self.marker)(encoder);
        self.inner.before_cull(encoder, world);
    }
    fn before_world(&mut self, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        self.inner.before_world(encoder, world);
    }
    fn opaque(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.inner.opaque(pass, world);
    }
    fn blended(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.inner.blended(pass, world);
    }
    fn pre_exposure_source(&self) -> Option<&wgpu::Buffer> {
        self.inner.pre_exposure_source()
    }
}

impl CustomStage for Marked<'_, '_> {
    fn post_hdr(&mut self, scene: &wgpu::Texture, view: &wgpu::TextureView) {
        self.inner.post_hdr(scene, view);
    }
    fn runs(&self, stage: PassStage) -> bool {
        self.inner.runs(stage)
    }
    fn after_world(&mut self, world: &wgpu::Texture, view: &wgpu::TextureView) {
        self.inner.after_world(world, view);
    }
    fn custom_draws(&self) -> u32 {
        self.inner.custom_draws()
    }
}

/// Draw `scene` with `marker` encoded first (bench scenes have no custom passes).
pub fn render_marked(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene, marker: Marker<'_>) {
    render_scene(renderer, gpu, scene, CullPath::Gpu, &mut Marked { inner: &mut NoCustom, marker }).expect("frame");
}

/// A renderer with the lakeside's passes and meshes, drawing one runtime's frames.
pub struct Lakeside {
    /// The renderer.
    pub renderer: Renderer,
    passes: CustomPasses,
    meshes: MeshCache,
}

/// Hand `renderer` the environment `frame` declares, as the presenter does
/// (`genex::present::Presenter`): the physical sky, the flat colour, or an HDR map decoded from
/// the game's assets and uploaded whenever the renderer does not hold it (the perf rows draw the
/// environment the game draws, RQ2 review).
pub fn apply_environment(renderer: &mut Renderer, gpu: &Gpu, frame: &genex::Frame) {
    let environment = frame.declared_environment().cloned().unwrap_or(Environment::Color);
    if let Environment::Hdri(hdri) = &environment
        && !renderer.holds_environment_map()
    {
        let bytes = genex::present::ModelSource::model_bytes(&assets(), &hdri.path).expect("the game's HDR map is in its assets");
        let map = genex_render::hdri::decode(&bytes).expect("the game's HDR map decodes");
        renderer.set_environment_map(gpu, &map).expect("the map uploads");
    }
    if *renderer.environment() != environment {
        renderer.set_environment(&environment);
    }
}

impl Lakeside {
    /// The lakeside's renderer at `size` (its world size when `None`).
    pub fn new(gpu: &Gpu, runtime: &mut Runtime<World>, size: Option<[u32; 2]>) -> Lakeside {
        Lakeside::with_options(gpu, runtime, size, genex_render::RenderOptions::default())
    }

    /// [`Lakeside::new`] on a renderer built with `options` (one sample for a TAA profile, as the
    /// presenter builds it for its first frame's preset; RQ5.6).
    pub fn with_options(gpu: &Gpu, runtime: &mut Runtime<World>, size: Option<[u32; 2]>, options: genex_render::RenderOptions) -> Lakeside {
        let [width, height] = size.unwrap_or_else(|| runtime.world_size());
        let renderer = Renderer::with_options(gpu, width, height, options).expect("renderer");
        let mut passes = CustomPasses::new(gpu, &renderer, wgpu::Features::empty());
        let refusals = genex::gpu::host::install(runtime, &mut passes, gpu);
        assert!(refusals.is_empty(), "{refusals:?}");
        Lakeside { renderer, passes, meshes: MeshCache::default() }
    }

    /// Draw `view` of the runtime's current tick with `marker` encoded first.
    pub fn draw_marked(&mut self, gpu: &Gpu, runtime: &mut Runtime<World>, view: View<'_>, marker: Marker<'_>) {
        let camera = runtime.camera(view).expect("camera");
        let frame = runtime.frame(view).expect("frame");
        let Lakeside { renderer, passes, meshes } = self;
        meshes.load(&frame, assets(), |mesh| renderer.add_mesh(gpu, mesh));
        apply_environment(renderer, gpu, &frame);
        // The ground is the built-in terrain (renderer pass 2 A.7), held by the renderer; this
        // bridge uploads no textures, so its layers draw flat.
        if let Some((desc, version)) = genex::present::terrain_of(&frame, meshes.cache())
            && renderer.terrain_version() != Some(version)
        {
            renderer.set_terrain(gpu, Some((&desc, version))).expect("the terrain");
        }
        let scene = to_scene(&frame, &camera, meshes);
        // The passes follow what the frame draws (the HDR scene and its depth convention, or the
        // legacy one), as the presenter's do, at the renderer's scale step.
        let facts = PipelineFacts::for_scene(&renderer.next_scene(passes.ldr_reason()), renderer.sample_count());
        genex::gpu::host::with_passes(runtime, |list, _| passes.set_pipeline_facts(gpu, list, facts)).expect("pass pipelines");
        passes.set_render_size(renderer.render_size());
        genex::gpu::host::with_passes(runtime, |list, tick| {
            let mut run = passes.frame(gpu, list, tick)?;
            render_scene(renderer, gpu, &scene, CullPath::Gpu, &mut Marked { inner: &mut run, marker })
        })
        .expect("frame");
        assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    }

    /// Draw `view` of the runtime's current tick.
    pub fn draw(&mut self, gpu: &Gpu, runtime: &mut Runtime<World>, view: View<'_>) {
        self.draw_marked(gpu, runtime, view, &mut |_| {});
    }
}

/// The lakeside seeded with 1 and run to [`SHOT_TICK`].
pub fn lakeside_at_shot_tick() -> Runtime<World> {
    lakeside_at(SHOT_TICK)
}

/// The lakeside seeded with 1 and run to `tick`. `GENEX_SHOWCASE_BACKDROP_TAPS=<n>` taps B `n`
/// times on the first tick (1: the fetched golden-hour map, 2: the clear map), to look at the
/// other backdrops; the default draws the physical sky.
pub fn lakeside_at(tick: u32) -> Runtime<World> {
    let mut runtime = Runtime::new(game()).expect("registrations");
    runtime.seed(1);
    runtime.start();
    let taps: u32 = std::env::var("GENEX_SHOWCASE_BACKDROP_TAPS").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut stepped = 0;
    for _ in 0..taps {
        runtime.inject(genex::Input::key_tap(genex::Key::KeyB));
        runtime.step(FIXED_STEP_MS);
        stepped += 1;
    }
    runtime.step(f64::from(tick.saturating_sub(stepped)) * FIXED_STEP_MS);
    runtime
}

/// A scene drawn as a game's frame is captured: `load` puts its meshes in the frame renderer's
/// library and answers the scene, which [`FrameRenderer::render_settled`] draws with
/// `look` under `quality` (`None`: the legacy renderer, `off`), auto exposure metered and settled
/// (the bench rows drew through `Renderer::render`, which runs no exposure node: pass-1 gate
/// finding 07's near-black forest was never exposed).
pub fn game_capture(
    gpu: &Gpu,
    class: genex_render::device_class::DeviceClass,
    quality: Option<&genex_render::settings::Quality>,
    look: &genex_render::settings::Look,
    load: &dyn Fn(&mut OnGpu<'_>) -> Scene,
) -> Capture {
    game_frames(gpu, class, quality, look, load).capture(gpu).expect("capture")
}

/// [`game_capture`]'s frame renderer after the settled frame (its world target holds the picture,
/// its renderer the path the frame took).
pub fn game_frames(
    gpu: &Gpu,
    class: genex_render::device_class::DeviceClass,
    quality: Option<&genex_render::settings::Quality>,
    look: &genex_render::settings::Look,
    load: &dyn Fn(&mut OnGpu<'_>) -> Scene,
) -> genex_render::FrameRenderer {
    let drawn = quality.copied().unwrap_or_else(genex_render::settings::Quality::off);
    let options = genex_render::RenderOptions { msaa: genex_render::renderer::landed_samples(drawn.anti_aliasing) > 1 };
    let mut frames = genex_render::FrameRenderer::new(gpu, SIZE[0], SIZE[1], options).expect("frame renderer");
    let scene = load(&mut OnGpu { renderer: frames.renderer_mut(), gpu });
    let renderer = frames.renderer_mut();
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(&drawn);
    renderer.set_scene_format(genex_render::presets::scene_format(class, rg11b10));
    renderer.set_look(*look);
    renderer.set_device_class(class);
    let settle = frames.settle_frames();
    frames.render_settled(gpu, &genex_render::immediate::ImmediateFrame::from_scene(scene), CullPath::Gpu, None, settle).expect("settled frame");
    frames
}
