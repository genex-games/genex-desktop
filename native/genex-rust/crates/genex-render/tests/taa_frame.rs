//! RQ5.6: TAA, the motion prepass and FSR1 on the frame path (graph nodes 7, 15a, 17 and 22 as
//! `Renderer` and `FrameRenderer` record them), not the kernels on their own (tests/taa.rs,
//! tests/motion.rs and tests/fsr.rs hold those).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test taa_frame -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` also writes each compared frame there (raw BGRA, top row first).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::extension::PostStage;
use genex_render::immediate::FrameRenderer;
use genex_render::motion::DrawId;
use genex_render::prepass::PrepassConsumers;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{AntiAliasing, Quality, SceneFormat, Upscaler};
use genex_render::{CullPath, Gpu, ImmediateFrame, RenderOptions, Renderer};

const WIDTH: u32 = 160;
const HEIGHT: u32 = 96;
/// The background's sRGB clear colour.
const CLEAR: [u8; 4] = [12, 14, 20, 255];

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

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("taa-frame-{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// The HDR scene with TAA and nothing else that keeps history (no AO, no auto exposure), so a
/// frame's difference from the last is TAA's alone.
fn taa_quality() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality
}

/// The HDR scene with one sample and no anti-aliasing: the aliased reference.
fn aliased_quality() -> Quality {
    let mut quality = taa_quality();
    quality.anti_aliasing = AntiAliasing::Off;
    quality
}

fn renderer(gpu: &Gpu, quality: &Quality, size: (u32, u32)) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa: quality.anti_aliasing == AntiAliasing::Msaa4 }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(quality);
    renderer
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0])
}

/// A white cube turned so every silhouette edge is slanted, at `x` across.
fn cube_at(x: f32) -> [f32; 16] {
    let turn = glam::Mat4::from_translation(glam::Vec3::new(x, 0.0, 0.0))
        * glam::Mat4::from_rotation_z(0.42)
        * glam::Mat4::from_rotation_x(0.35)
        * glam::Mat4::from_scale(glam::Vec3::splat(1.1));
    turn.to_cols_array()
}

fn scene_with(x: f32, id: Option<&str>) -> Scene {
    let mut scene = Scene::new(camera(), CLEAR);
    scene.lighting.sun_dir = glam::Vec3::new(-0.4, 0.6, 0.7).normalize().to_array();
    scene.set_id(id.map(DrawId::from));
    scene.draw(MeshId::CUBE, cube_at(x), Material::color([235, 235, 235, 255]));
    scene
}

/// Frames `frames` of `scene` (their indices) drawn by `renderer`, the last one read back.
fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: std::ops::Range<u64>) -> Capture {
    for index in frames {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// Rec. 709 luma of every pixel, in levels.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Pixels whose luma lies strictly between the background's (a few levels) and the cube's darkest
/// face (about 150 levels): an anti-aliased silhouette's partly covered pixels. An aliased
/// silhouette has almost none (each pixel is the background or the cube).
fn partial_pixels(capture: &Capture) -> usize {
    lumas(capture).iter().filter(|luma| (25.0..125.0).contains(*luma)).count()
}

/// The steepest luma change between horizontal neighbours, in levels.
fn max_gradient(capture: &Capture) -> f32 {
    let luma = lumas(capture);
    let w = capture.width() as usize;
    luma.chunks_exact(w).flat_map(|row| row.windows(2).map(|pair| (pair[0] - pair[1]).abs())).fold(0.0, f32::max)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn a_taa_quality_asks_the_prepass_for_its_motion() {
    let consumers = genex_render::prepass::consumers(&taa_quality(), genex_render::prepass::ExtensionDemand::default());
    assert!(consumers.contains(PrepassConsumers::TAA));
    assert_eq!(genex_render::renderer::landed_samples(AntiAliasing::Taa), 1, "TAA draws one sample per pixel");
    assert_eq!(genex_render::renderer::landed_samples(AntiAliasing::TaaSharpen), 1);
    assert_eq!(genex_render::renderer::landed_samples(AntiAliasing::Msaa4), 4);
}

// ---------------------------------------------------------------------------------------------
// GPU rows

/// TAA resolves the one-sample HDR scene: the prepass writes motion for it, the jittered frames
/// accumulate, and a settled static frame's slanted edges carry far fewer hard staircase steps
/// than the reset frame's (which is the aliased current sample).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_resolves_the_one_sample_scene_and_settles_its_edges() {
    let Some(gpu) = gpu() else { return };
    let scene = scene_with(0.0, None);
    let mut taa = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
    let first = draw(&gpu, &mut taa, &scene, 0..1);
    let path = taa.last_scene().expect("ran");
    assert!(path.taa, "TAA resolves the HDR scene");
    assert_eq!(path.format, wgpu::TextureFormat::Rgba16Float);
    assert_eq!(taa.last_world_pass().expect("world").samples, 1, "MSAA is off under TAA");
    let prepass = taa.last_prepass().expect("the prepass ran");
    assert!(prepass.consumers.contains(PrepassConsumers::TAA), "{:?}", prepass.consumers);
    let settled = draw(&gpu, &mut taa, &scene, 1..16);
    let mut aliased = renderer(&gpu, &aliased_quality(), (WIDTH, HEIGHT));
    let reference = draw(&gpu, &mut aliased, &scene, 0..1);
    assert!(!aliased.last_scene().expect("ran").taa);
    write_evidence("first", &first);
    write_evidence("settled", &settled);
    write_evidence("aliased", &reference);
    let (first_partial, settled_partial, aliased_partial) = (partial_pixels(&first), partial_pixels(&settled), partial_pixels(&reference));
    eprintln!("partly covered silhouette pixels: reset frame {first_partial}, settled {settled_partial}, unjittered aliased {aliased_partial}");
    assert!(settled_partial >= 3 * aliased_partial + 40, "TAA's settled silhouette: {settled_partial} partly covered pixels against {aliased_partial} aliased");
    assert!(settled_partial >= 3 * first_partial + 40, "the reset frame is the aliased current sample ({first_partial}), the settled one {settled_partial}");
}

/// Two renderers drawing one frame sequence write the same bytes: the jitter, the motion and the
/// history are functions of the frame index and the scene alone.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_frames_are_byte_identical_across_runs() {
    let Some(gpu) = gpu() else { return };
    let captures: Vec<Capture> = (0..2)
        .map(|_| {
            let mut taa = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
            let mut last = None;
            for (index, x) in [-0.6f32, -0.45, -0.3, -0.15, 0.0, 0.15, 0.3, 0.45].into_iter().enumerate() {
                last = Some(draw(&gpu, &mut taa, &scene_with(x, Some("cube")), index as u64..index as u64 + 1));
            }
            last.expect("drawn")
        })
        .collect();
    assert_eq!(captures[0].bgra(), captures[1].bgra(), "the same sequence, the same bytes");
}

/// A named cube moving fast leaves no trail: its motion vectors carry the history with it, and
/// the pixels it uncovered take the background, as a frame drawn fresh at its last position does.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_fast_moving_named_cube_leaves_no_trail_under_taa() {
    let Some(gpu) = gpu() else { return };
    let mut taa = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
    let positions: Vec<f32> = (0..10).map(|i| -1.2 + 0.18 * i as f32).collect();
    let mut moving = None;
    for (index, x) in positions.iter().enumerate() {
        moving = Some(draw(&gpu, &mut taa, &scene_with(*x, Some("runner")), index as u64..index as u64 + 1));
    }
    let moving = moving.expect("drawn");
    let last = *positions.last().expect("a position");
    let mut fresh = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
    let reference = draw(&gpu, &mut fresh, &scene_with(last, Some("runner")), 0..1);
    write_evidence("moving", &moving);
    write_evidence("moving-reference", &reference);
    let (w, h) = (WIDTH as i64, HEIGHT as i64);
    // The clear colour as the tonemap wrote it (a corner the cube never reaches).
    let clear: [u8; 3] = std::array::from_fn(|lane| reference.bgra()[lane]);
    let background = |capture: &Capture, x: i64, y: i64| {
        let at = ((y * w + x) * 4) as usize;
        (0..3).all(|lane| capture.bgra()[at + lane].abs_diff(clear[lane]) <= 6)
    };
    // Pixels that are background in the fresh frame and at least 3 pixels from its cube.
    let clear_of_cube = |x: i64, y: i64| (-3..=3).all(|dy| (-3..=3).all(|dx| {
        let (nx, ny) = (x + dx, y + dy);
        !(0..w).contains(&nx) || !(0..h).contains(&ny) || background(&reference, nx, ny)
    }));
    let trail: Vec<(i64, i64)> = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).filter(|&(x, y)| clear_of_cube(x, y) && !background(&moving, x, y)).collect();
    eprintln!("trail pixels: {} {:?}", trail.len(), &trail[..trail.len().min(8)]);
    assert!(trail.is_empty(), "{} background pixels behind the cube still show it: {:?}", trail.len(), &trail[..trail.len().min(8)]);
}

/// Below scale 1 FSR1 upscales: the tonemap writes its intermediate, EASU and RCAS write the world
/// target, and an edge comes out steeper than through the bilinear upscale.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_fsr1_upscales_below_scale_one_and_keeps_edges_sharper_than_bilinear() {
    let Some(gpu) = gpu() else { return };
    let scene = scene_with(0.0, None);
    let output = (WIDTH * 2, HEIGHT * 2);
    let upscale = |upscaler: Upscaler| {
        let mut quality = aliased_quality();
        quality.upscaler = upscaler;
        let mut renderer = renderer(&gpu, &quality, output);
        renderer.set_render_scale(0.5);
        let capture = draw(&gpu, &mut renderer, &scene, 0..1);
        (capture, renderer.last_scene().expect("ran"), renderer.last_stats())
    };
    let (fsr, fsr_path, fsr_stats) = upscale(Upscaler::Fsr1);
    let (bilinear, bilinear_path, bilinear_stats) = upscale(Upscaler::Bilinear);
    write_evidence("fsr-x2", &fsr);
    write_evidence("bilinear-x2", &bilinear);
    assert!(fsr_path.fsr.easu && fsr_path.fsr.rcas, "{:?}", fsr_path.fsr);
    assert!(!bilinear_path.fsr.easu && !bilinear_path.fsr.rcas, "bilinear is fused into the tonemap");
    assert_eq!(fsr_stats.render_passes, bilinear_stats.render_passes + 2, "EASU and RCAS are two passes of their own");
    let (sharp, soft) = (max_gradient(&fsr), max_gradient(&bilinear));
    eprintln!("steepest edge: FSR1 {sharp:.1}, bilinear {soft:.1} levels per pixel");
    assert!(sharp >= soft * 1.1, "FSR1's edge {sharp:.1} against bilinear's {soft:.1}");
}

/// Ultra's sharpen at scale 1: RCAS alone after TAA, from the tonemap's intermediate.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_sharpen_runs_rcas_alone_at_scale_one() {
    let Some(gpu) = gpu() else { return };
    let scene = scene_with(0.0, None);
    let mut quality = taa_quality();
    quality.anti_aliasing = AntiAliasing::TaaSharpen;
    let mut sharpened = renderer(&gpu, &quality, (WIDTH, HEIGHT));
    let capture = draw(&gpu, &mut sharpened, &scene, 0..8);
    let path = sharpened.last_scene().expect("ran");
    assert!(path.taa && !path.fsr.easu && path.fsr.rcas, "{:?}", path.fsr);
    let mut plain = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
    let unsharpened = draw(&gpu, &mut plain, &scene, 0..8);
    write_evidence("taa-sharpen", &capture);
    assert_ne!(capture.bgra(), unsharpened.bgra(), "RCAS sharpened the resolve");
}

const HALVE_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let scene = textureSampleLevel(gx_scene, gx_sampler, gx_scene_uv(in.position), 0.0).rgb;
    return vec4<f32>(scene * 0.5, 1.0);
}
";

/// An `hdr`-stage post pass under TAA draws over a copy of the resolve in the scene, never over
/// TAA's history: a pass halving the scene halves each frame once, not once more every frame.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_hdr_post_pass_under_taa_never_feeds_back_into_the_history() {
    let Some(gpu) = gpu() else { return };
    let mut frames = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    frames.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    frames.renderer_mut().set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    frames.renderer_mut().set_quality(&taa_quality());
    let halve = frames.add_post_pass_api(&gpu, 2, PostStage::Hdr, HALVE_V2, &[], &[]).expect("a v2 hdr post pass");
    let mean = |capture: &Capture| lumas(capture).iter().sum::<f32>() / (WIDTH * HEIGHT) as f32;
    let mut means = Vec::new();
    for tick in 0..12u64 {
        let mut frame = ImmediateFrame::new(camera(), CLEAR);
        frame.set_tick(tick).cube(cube_at(0.0), [235, 235, 235, 255]).post_pass(halve);
        frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        let capture = frames.capture(&gpu).expect("capture");
        if tick == 11 {
            write_evidence("hdr-post-halved", &capture);
        }
        means.push(mean(&capture));
    }
    assert!(frames.renderer().last_scene().expect("ran").taa);
    eprintln!("mean luma per frame with a halving hdr pass: {means:?}");
    let (early, late) = (means[2], means[11]);
    assert!(late >= early * 0.9, "the frame darkens frame after frame ({early:.2} -> {late:.2}): the pass fed TAA's history");
}

/// The frame path's motion target carries a named cube's motion: moved by `dx` world units to the
/// right between two frames, its centre's motion is the CPU's reprojection (NDC now minus then,
/// the jitter removed), and a still frame after it reads zero motion.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_frame_paths_motion_target_carries_a_named_cubes_motion() {
    let Some(gpu) = gpu() else { return };
    let mut taa = renderer(&gpu, &taa_quality(), (WIDTH, HEIGHT));
    taa.set_depth_readback(true);
    let (from, to) = (-0.3f32, 0.0f32);
    draw(&gpu, &mut taa, &scene_with(from, Some("mover")), 0..1);
    draw(&gpu, &mut taa, &scene_with(to, Some("mover")), 1..2);
    let motion = taa.read_motion(&gpu).expect("motion kept");
    let depth = taa.read_prepass_depth(&gpu).expect("depth kept");
    let (px, py) = (WIDTH / 2, HEIGHT / 2);
    let at = (py * WIDTH + px) as usize;
    let centre = motion[at];
    let aspect = WIDTH as f32 / HEIGHT as f32;
    let view_proj = camera().view_proj_reversed(aspect);
    // The surface point the centre pixel sees: its depth unprojected at the pixel's NDC with frame
    // 1's jitter taken off (the depth was rasterized jittered), then the same point last frame.
    let jitter = genex_render::jitter::offset_ndc(genex_render::jitter::offset_px(1, genex_render::settings::JitterCycle::Eight), (WIDTH, HEIGHT));
    let ndc = [(px as f32 + 0.5) / WIDTH as f32 * 2.0 - 1.0 - jitter[0], 1.0 - (py as f32 + 0.5) / HEIGHT as f32 * 2.0 - jitter[1]];
    let world = view_proj.inverse() * glam::Vec4::new(ndc[0], ndc[1], depth[at], 1.0);
    let point = (world.truncate() / world.w).to_array();
    let before = [point[0] - (to - from), point[1], point[2]];
    let cols = view_proj.to_cols_array();
    let expected = genex_render::motion::motion_of(&cols, &cols, point, before);
    eprintln!("centre motion {centre:?}, expected {expected:?}");
    assert!((centre[0] - expected[0]).abs() < 2e-3 && (centre[1] - expected[1]).abs() < 2e-3, "{centre:?} against {expected:?}");
    draw(&gpu, &mut taa, &scene_with(to, Some("mover")), 2..3);
    let still = taa.read_motion(&gpu).expect("motion kept");
    let largest = still.iter().map(|m| m[0].abs().max(m[1].abs())).fold(0.0f32, f32::max);
    assert!(largest < 1e-3, "a still frame moves nothing ({largest})");
}

/// A [`FrameRenderer`] drawing `quality` on the HDR scene (Live history, the reset rules).
fn frame_renderer(gpu: &Gpu, quality: &Quality) -> FrameRenderer {
    let mut frames = FrameRenderer::new(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    let renderer = frames.renderer_mut();
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(quality);
    frames
}

/// The still cube as a Live frame at `tick`, read back.
fn live_cube(gpu: &Gpu, frames: &mut FrameRenderer, tick: u64) -> Capture {
    let mut frame = ImmediateFrame::new(camera(), CLEAR);
    frame.lighting_mut().sun_dir = glam::Vec3::new(-0.4, 0.6, 0.7).normalize().to_array();
    frame.cube(cube_at(0.0), [235, 235, 235, 255]);
    frame.set_tick(tick);
    frames.render(gpu, &frame, CullPath::Gpu, None).expect("Live frame");
    frames.capture(gpu).expect("capture")
}

// RQ5 review: TAA's history lived at the render size and every dynamic-resolution step threw it
// away (a reset: an aliased frame, then 8 to 16 frames to converge again). The resolve now reads
// the old size's history in uv: rising from 0.75 to scale 1 (no upscale to blur the count), the
// first frame keeps anti-aliased edges where a reset's first frame has none.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_dynamic_resolution_step_keeps_taa_history_instead_of_resetting_it() {
    let Some(gpu) = gpu() else { return };
    let mut stepped = frame_renderer(&gpu, &taa_quality());
    stepped.renderer_mut().set_render_scale(0.75);
    for tick in 1..=16 {
        live_cube(&gpu, &mut stepped, tick);
    }
    stepped.renderer_mut().set_render_scale(1.0);
    let after_step = live_cube(&gpu, &mut stepped, 17);
    let history = stepped.last_history().expect("a frame");
    assert_eq!(history.reset, Some(genex_render::settle::HistoryReset::ScaleStep), "the step restarted the index");
    let mut fresh = frame_renderer(&gpu, &taa_quality());
    let first = live_cube(&gpu, &mut fresh, 1);
    let mut settled = first.clone();
    for tick in 2..=16 {
        settled = live_cube(&gpu, &mut fresh, tick);
    }
    write_evidence("drs-step-after", &after_step);
    write_evidence("drs-fresh-first", &first);
    write_evidence("drs-settled", &settled);
    let (kept, reset, converged) = (partial_pixels(&after_step), partial_pixels(&first), partial_pixels(&settled));
    eprintln!("partly covered pixels at scale 1: after the step {kept}, a reset's first frame {reset}, settled {converged}");
    assert!(converged > reset + 20, "the settled edges are anti-aliased ({converged} against {reset})");
    assert!(kept * 2 > converged, "the first frame after the step keeps the history's edges: {kept} of {converged}");
}
