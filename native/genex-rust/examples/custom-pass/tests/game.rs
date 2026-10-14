//! The custom GPU pass sample: its rules headless through the facade runtime (no GPU), and its
//! goldens on the host GPU through genex-render, drawn the way the studio draws a frame (the
//! scene from the game's draw hooks, the passes bound to the simulation, captures and Live from
//! the same world target). The golden shows the Level-3 passes (`level3_game`); the Level-2
//! material and post pass are drawn through the one presenter native runs and the web shell share
//! (`genex::present::Presenter`, and the web shell's `Screen` over it, run natively here).
//!
//! The GPU rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p custom-pass \
//!     --offline --locked -- --ignored metal
//!
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites `tests/fixtures/render-goldens/custom-pass/example.bgra`
//! (the Level-3 passes) and `full-game.bgra` (the whole sample: the Level-2 glow material at API v2,
//! lit by the renderer's shading, and the v1 vignette beside the Level-3 passes; the v1 halo keeps
//! the frame on the LDR scene).

use std::path::{Path, PathBuf};

use custom_pass_game::{CROSSING_TICKS, GLOW_PATH, VIGNETTE_PATH, World, game, level2_game, level3_game, plain_game};
use genex::gpu::{CUSTOM_TAG, PassStage};
use genex::present::Presenter;
use genex::{FIXED_STEP_MS, Runtime, View, json};
use genex_platform_web::studio::{Painter, Screen};
use genex_platform_web::{GameHandle, MeshCache, to_scene};
use genex_render::capture::Capture;
use genex_render::custom_pass::{CustomPasses, render_scene};
use genex_render::{CullPath, Gpu, Renderer};

/// Ticks the determinism rows run: ten seconds.
const CHECKSUM_TICKS: u32 = 600;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 14400.
const GOLDEN_OUTLIER_PIXELS: usize = 72;

fn runtime(game: genex::Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("the sample's registrations are valid")
}

fn run(runtime: &mut Runtime<World>, ticks: u32) {
    runtime.seed(3);
    runtime.start();
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
}

#[test]
fn the_600_tick_state_checksum_is_the_same_with_and_without_the_passes() {
    let mut plain = runtime(plain_game());
    let mut with = runtime(game());
    run(&mut plain, CHECKSUM_TICKS);
    run(&mut with, CHECKSUM_TICKS);
    assert_eq!(with.tick(), u64::from(CHECKSUM_TICKS));
    assert_eq!(with.checksum(), plain.checksum());
    assert_eq!(with.probes(), plain.probes());
}

#[test]
fn the_passes_are_registered_at_their_stages_and_each_counts_one_custom_draw() {
    let mut with = runtime(game());
    assert_eq!(with.gpu_passes(), vec![("halo".to_owned(), PassStage::AfterOpaque), ("crt".to_owned(), PassStage::Post)]);
    with.frame(View::Game).expect("the game's view");
    let state = with.state();
    let render = &state["__render"];
    assert_eq!(render["drawCalls"], json!(6), "ground, cube, the glow sphere, the vignette and two passes: {render}");
    assert!(render["tags"].to_string().contains(CUSTOM_TAG), "{render}");
    assert_eq!(render["tags"]["glow"]["drawCalls"], json!(2), "the Level-2 material and post pass: {render}");
}

#[test]
fn the_level2_sources_are_admitted_at_their_declared_api_from_the_compiled_table() {
    let runtime = runtime(game());
    let world = &runtime.sim().world;
    assert_eq!(world.glow.refusal(), None);
    assert_eq!(world.vignette.as_ref().and_then(|pass| pass.refusal()), None);
    let state = runtime.state();
    let rows = &state["volatile"]["extensions"];
    assert_eq!(
        rows,
        &json!([
            {"path": GLOW_PATH, "kind": "material", "api": 2, "code": null, "fault": null, "detail": null},
            {"path": VIGNETTE_PATH, "kind": "post", "api": 1, "code": null, "fault": null, "detail": null},
        ]),
    );
}

#[test]
fn the_cube_crosses_its_track_and_turns_back() {
    let mut runtime = runtime(game());
    run(&mut runtime, CROSSING_TICKS - 1);
    let far = runtime.sim().world.x;
    assert!(far > 1.9, "{far}");
    runtime.step(f64::from(CROSSING_TICKS / 2) * FIXED_STEP_MS);
    assert!(runtime.sim().world.back && runtime.sim().world.x < far);
}

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
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

/// Run `game` `ticks` ticks and draw its frame as the studio does; the capture and the Live frame.
fn draw(gpu: &Gpu, game: genex::Game<World>, ticks: u32) -> (Capture, Capture) {
    let mut runtime = runtime(game);
    let [width, height] = runtime.world_size();
    let mut renderer = Renderer::new(gpu, width, height).expect("renderer");
    let mut passes = CustomPasses::new(gpu, &renderer, wgpu::Features::empty());
    let refusals = genex::gpu::host::install(&mut runtime, &mut passes, gpu);
    assert!(refusals.is_empty(), "{refusals:?}");
    run(&mut runtime, ticks);
    let camera = runtime.camera(View::Game).expect("camera");
    let frame = runtime.frame(View::Game).expect("frame");
    let scene = to_scene(&frame, &camera, &MeshCache::default());
    genex::gpu::host::with_passes(&mut runtime, |list, tick| {
        let mut run = passes.frame(gpu, list, tick)?;
        render_scene(&mut renderer, gpu, &scene, CullPath::Gpu, &mut run)
    })
    .expect("frame");
    assert!(passes.refusals().is_empty(), "{:?}", passes.refusals());
    let capture = renderer.capture(gpu).expect("capture");
    let live = renderer.present_to_texture(gpu, (width, height)).expect("live");
    (capture, live)
}

fn check_golden(name: &str, capture: &Capture) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/custom-pass");
    if let Ok(evidence) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let evidence = PathBuf::from(evidence);
        let _ = std::fs::create_dir_all(&evidence);
        std::fs::write(evidence.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
    let path = dir.join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(&dir).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: golden size");
    let outliers = golden
        .chunks(4)
        .zip(capture.bgra().chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > GOLDEN_CHANNEL_TOLERANCE))
        .count();
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_the_sample_draws_its_passes_into_the_capture_and_the_live_frame_alike() {
    let Some(gpu) = gpu() else { return };
    let (plain, plain_live) = draw(&gpu, plain_game(), 45);
    let (capture, live) = draw(&gpu, level3_game(), 45);
    assert_eq!(plain_live.digest(), plain.digest());
    assert_ne!(capture.digest(), plain.digest(), "the halo and the CRT filter drew");
    assert_eq!(live.digest(), capture.digest(), "Live carries the passes exactly as the capture does");
    let (again, _) = draw(&gpu, level3_game(), 45);
    assert_eq!(again.digest(), capture.digest(), "two replays capture identically");
    let (later, _) = draw(&gpu, level3_game(), 46);
    assert_ne!(later.digest(), capture.digest(), "the halo follows the simulation and the scanlines roll with the tick");
    check_golden("example", &capture);
}

/// The halo is the sample's custom-pass API v1 pass in the world: the one in-tree fixture of the
/// degrade path. A frame that asks for the HDR scene stays on the legacy LDR scene with standard Z
/// (`custom-pass-v1-in-world`), every pass still runs, and the picture is the legacy renderer's.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_v1_halo_keeps_an_hdr_frame_on_the_ldr_scene_and_still_draws_it() {
    use genex_render::custom_pass::PipelineFacts;
    use genex_render::settings::{LdrReason, PresetChoice, Quality, RenderSettings, SceneFormat};
    let Some(gpu) = gpu() else { return };
    let (legacy, _) = draw(&gpu, level3_game(), 45);
    let mut runtime = runtime(level3_game());
    let [width, height] = runtime.world_size();
    let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
    let mut passes = CustomPasses::new(&gpu, &renderer, wgpu::Features::empty());
    assert!(genex::gpu::host::install(&mut runtime, &mut passes, &gpu).is_empty());
    assert_eq!(passes.ldr_reason(), Some(LdrReason::CustomPassV1InWorld), "the halo is a v1 pass in the world");
    let mut hdr = Quality::off();
    (hdr.hdr, hdr.tonemap, hdr.exposure) = (true, true, true);
    let requested = RenderSettings::off().with_quality(PresetChoice::Off, hdr).frame_config((width, height), 1.0, 0, true);
    let drawn = passes.frame_config(requested);
    assert_eq!((drawn.hdr, drawn.depth_reversed, drawn.ldr_reason), (false, false, Some(LdrReason::CustomPassV1InWorld)));
    assert_eq!(LdrReason::CustomPassV1InWorld.wire(), "custom-pass-v1-in-world");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&hdr);
    renderer.set_ldr_reason(drawn.ldr_reason);
    let facts = PipelineFacts::for_frame(&drawn, renderer.sample_count(), renderer.hdr_scene_format());
    genex::gpu::host::with_passes(&mut runtime, |list, _| passes.set_pipeline_facts(&gpu, list, facts)).expect("the same facts");
    run(&mut runtime, 45);
    let camera = runtime.camera(View::Game).expect("camera");
    let frame = runtime.frame(View::Game).expect("frame");
    let scene = to_scene(&frame, &camera, &MeshCache::default());
    genex::gpu::host::with_passes(&mut runtime, |list, tick| {
        let mut run = passes.frame(&gpu, list, tick)?;
        render_scene(&mut renderer, &gpu, &scene, CullPath::Gpu, &mut run)
    })
    .expect("frame");
    assert!(passes.refusals().is_empty(), "nothing is refused: {:?}", passes.refusals());
    let path = renderer.last_scene().expect("a frame was drawn");
    assert_eq!((path.hdr, path.ldr_reason), (false, Some(LdrReason::CustomPassV1InWorld)), "drawn on the LDR scene, reason kept");
    let capture = renderer.capture(&gpu).expect("capture");
    assert_eq!(capture.digest(), legacy.digest(), "the halo and the CRT still draw: the legacy renderer's picture");
}

/// Ticks the Level-2 rows run before they capture.
const LEVEL2_TICKS: u32 = 45;

fn presenter() -> Option<Presenter> {
    gpu()?;
    Some(Presenter::open_with_root([160, 90], &[], None).expect("presenter"))
}

/// Keep `capture` as `<name>.bgra` under `GENEX_RENDER_EVIDENCE_DIR` when it is set.
fn keep(name: &str, capture: &Capture) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = PathBuf::from(dir);
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
}

/// `game` after [`LEVEL2_TICKS`], captured through a fresh shared presenter (its passes are the
/// game's) as a studio run does, with how the frame drew its scene.
fn presented(game: genex::Game<World>) -> (Capture, u32, Runtime<World>) {
    let (capture, draws, runtime, _) = presented_path(game);
    (capture, draws, runtime)
}

/// [`presented`] with the scene path of the captured frame.
fn presented_path(game: genex::Game<World>) -> (Capture, u32, Runtime<World>, genex_render::renderer::ScenePath) {
    let mut presenter = presenter().expect("a GPU");
    let mut runtime = runtime(game);
    let refused = presenter.install_for(&mut runtime);
    assert!(refused.is_empty(), "{refused:?}");
    run(&mut runtime, LEVEL2_TICKS);
    presenter.set_capturing(true);
    let drawn = presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
    assert_eq!(presenter.failure(), None);
    let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
    (presenter.resilient.capture().expect("capture"), drawn.draw_calls, runtime, path)
}

/// A v1 in-world pass keeps the frame on the legacy LDR scene, where TAA never draws (it resolves
/// the HDR scene). At a preset whose anti-aliasing is TAA (high, ultra) the presenter then draws the
/// switch table's "taa off" variant, MSAA 4x, so the halo's frame keeps anti-aliased edges instead
/// of none (pass-1 gate: the full-game golden lost its edges when high moved to TAA).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_v1_in_world_pass_at_a_taa_preset_draws_msaa_edges() {
    use genex::render::{QualityPreset, RenderConfig};
    if gpu().is_none() {
        return;
    }
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let mut presenter = presenter().expect("a GPU");
        let mut game = level3_game();
        game.render_settings(RenderConfig::new().preset(preset));
        let mut runtime = runtime(game);
        assert!(presenter.install_for(&mut runtime).is_empty());
        run(&mut runtime, LEVEL2_TICKS);
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
        let renderer = presenter.resilient.renderer().renderer();
        let path = renderer.last_scene().expect("a frame");
        assert_eq!((path.hdr, path.ldr_reason.map(|reason| reason.wire())), (false, Some("custom-pass-v1-in-world")), "{preset:?}");
        assert_eq!(renderer.sample_count(), 4, "{preset:?}: the LDR scene draws MSAA 4x in place of TAA");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_level2_material_and_post_pass_draw_on_the_native_and_the_web_presenter_alike() {
    if gpu().is_none() {
        return;
    }
    let (plain, _, _) = presented(plain_game());
    let (level3, _, _) = presented(level3_game());
    let (level2, draws, _, level2_path) = presented_path(level2_game());
    let (full, full_draws, full_runtime, full_path) = presented_path(game());
    // The v2 glow draws on the HDR scene; the v1 halo is the sample's degrade fixture.
    assert!(level2_path.hdr && level2_path.ldr_reason.is_none(), "{level2_path:?}");
    assert_eq!((full_path.hdr, full_path.ldr_reason.map(|reason| reason.wire())), (false, Some("custom-pass-v1-in-world")), "{full_path:?}");
    assert_eq!(draws, 4, "ground, cube, the glow sphere and the vignette");
    assert_eq!(full_draws, 6, "and the two Level-3 passes");
    assert_ne!(level2.digest(), plain.digest(), "the glow sphere and the vignette drew");
    assert_ne!(full.digest(), level3.digest(), "the Level-2 work shows beside the Level-3 passes");
    let rows = full_runtime.state()["volatile"]["extensions"].clone();
    assert!(rows.as_array().is_some_and(|rows| rows.iter().all(|row| row["code"].is_null())), "no device refusal: {rows}");

    // The web shell's painter over the same presenter code (Chromium runs this on the canvas).
    let Some(web) = presenter() else { return };
    let mut screen = Screen::new(web);
    let mut web_runtime = runtime(game());
    let handle: &mut dyn GameHandle = &mut web_runtime;
    screen.install(handle);
    run(&mut web_runtime, LEVEL2_TICKS);
    let handle: &mut dyn GameHandle = &mut web_runtime;
    let web_draws = screen.paint_capture(handle, None);
    let web = screen.presenter.resilient.capture().expect("web capture");
    assert_eq!(web_draws, full_draws);
    assert_eq!(web.digest(), full.digest(), "the web painter draws the Level-2 work exactly as native");
    let (again, _, _) = presented(game());
    assert_eq!(again.digest(), full.digest(), "two replays capture identically");
    // The v2 glow on the LDR scene (the halo's degrade) beside the v1 vignette and the Level-3 passes.
    check_golden("full-game", &full);
    for (name, capture) in [("plain", &plain), ("level3", &level3), ("level2", &level2), ("native", &full), ("web", &web)] {
        keep(&format!("level2-{name}"), capture);
    }
}
