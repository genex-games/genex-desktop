//! A.9's renderer hook: the look's depth of field (graph node 17a) and motion blur (17b) on the
//! frame path, after TAA's resolve (node 17) and before `post-hdr` (node 18). The kernels on their
//! own are tests/dof.rs and tests/motion_blur.rs.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test lens -- --ignored metal
//!
//! The scene is a small white cube in focus a metre away in front of a far wall of vertical bars
//! (40 metres away, about six pixels wide): a lens blur or a horizontal motion blur takes the bars'
//! contrast down, and a frame drawn without either keeps it.

use genex_render::budget::{DEPTH_OF_FIELD_LABEL, MOTION_BLUR_LABEL};
use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::graph::{FRAME_GRAPH, NodeId, Step, quality_allows, schedule};
use genex_render::post::dof::DepthOfField;
use genex_render::post::motion_blur::MotionBlur;
use genex_render::renderer::CaptureLens;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{AntiAliasing, AoResolution, Quality, SceneFormat};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
/// The background's sRGB clear colour.
const CLEAR: [u8; 4] = [10, 12, 16, 255];
/// The focused cube's distance, metres.
const FOCUS: f32 = 1.0;
/// The far wall's distance from the camera, metres.
const WALL: f32 = 40.0;
/// The bars' width and period, metres (about six and twelve pixels at the wall).
const BAR: f32 = 1.6;
const PERIOD: f32 = 3.2;
/// Rows of the wall above the cube (the measured band).
const BAND: std::ops::Range<u32> = 8..40;
/// Frames drawn before a capture (TAA's history settles).
const FRAMES: u64 = 12;
/// A blurred wall keeps at most this share of the sharp wall's bar contrast.
const BLURRED_SHARE_MAX: f32 = 0.6;
/// The camera's pan per frame on the motion-blur rows, metres (about 16 px a frame at the wall,
/// past the reconstruction's longest blur).
const PAN: f32 = 4.0;

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

/// The HDR scene with TAA and nothing else that keeps history, drawn at desktop high (the ring
/// gather and the reconstruction tier).
fn taa_quality() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality.dof = genex_render::post::dof::DofTier::Ring;
    quality.motion_blur = genex_render::post::motion_blur::MotionBlurTier::Reconstruction;
    quality
}

/// One sample and no TAA, the prepass kept running for AO: the lens reads the resolved scene and
/// writes its own output.
fn single_sample_quality() -> Quality {
    let mut quality = taa_quality();
    quality.anti_aliasing = AntiAliasing::Off;
    quality.ao.resolution = AoResolution::Half;
    quality
}

fn renderer(gpu: &Gpu, quality: &Quality) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(quality);
    renderer
}

fn scene(x: f32) -> Scene {
    let camera = CameraDesc::look_at([x, 0.0, FOCUS], [x, 0.0, 0.0]);
    let mut scene = Scene::new(camera, CLEAR);
    scene.lighting.sun_dir = glam::Vec3::new(0.0, 0.3, 1.0).normalize().to_array();
    scene.draw(MeshId::CUBE, glam::Mat4::from_scale(glam::Vec3::splat(0.2)).to_cols_array(), Material::color([235, 235, 235, 255]));
    let wall_z = FOCUS - WALL;
    let mut left = -100.0;
    while left < 100.0 {
        let bar = glam::Mat4::from_translation(glam::Vec3::new(left + BAR / 2.0, 0.0, wall_z)) * glam::Mat4::from_scale(glam::Vec3::new(BAR, 30.0, 0.5));
        scene.draw(MeshId::CUBE, bar.to_cols_array(), Material::color([240, 240, 240, 255]));
        left += PERIOD;
    }
    scene
}

/// `FRAMES` frames, the camera panning by `pan` a frame and centred on the cube at the last, the
/// last read back.
fn draw(gpu: &Gpu, renderer: &mut Renderer, pan: f32) -> Capture {
    for index in 0..FRAMES {
        renderer.set_frame_index(index);
        let x = (index as f32 - (FRAMES - 1) as f32) * pan;
        renderer.render(gpu, &scene(x), CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// `capture` as raw BGRA (top row first) under `GENEX_RENDER_EVIDENCE_DIR`, when it is set.
fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("lens-{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// The bars' contrast: the standard deviation of luma along each row of the wall's band, in
/// levels, averaged over the band's rows.
fn bar_contrast(capture: &Capture) -> f32 {
    let w = capture.width() as usize;
    let luma: Vec<f32> = capture.bgra().as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect();
    let rows = BAND.map(|y| {
        let row = &luma[y as usize * w..(y as usize + 1) * w];
        let mean = row.iter().sum::<f32>() / w as f32;
        (row.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / w as f32).sqrt()
    });
    let count = BAND.len() as f32;
    rows.sum::<f32>() / count
}

fn lens_look(renderer: &Renderer, dof: bool, motion_blur: bool) -> genex_render::settings::Look {
    let mut look = *renderer.look();
    if dof {
        look = look.with_depth_of_field(DepthOfField::focused(FOCUS, 1.4).with_coc_scale(4.0));
    }
    if motion_blur {
        look = look.with_motion_blur(MotionBlur::shutter(1.0));
    }
    look
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn depth_of_field_and_motion_blur_are_graph_nodes_17a_and_17b_between_taa_and_post_hdr() {
    let wires: Vec<&str> = FRAME_GRAPH.iter().map(|row| row.wire).collect();
    let at = |wire: &str| wires.iter().position(|w| *w == wire).unwrap_or_else(|| panic!("no {wire} row: {wires:?}"));
    assert_eq!(at("dof"), at("taa") + 1, "{wires:?}");
    assert_eq!(at("motion-blur"), at("dof") + 1, "{wires:?}");
    assert_eq!(at("post-hdr"), at("motion-blur") + 1, "{wires:?}");
    assert!(NodeId::Dof.landed() && NodeId::MotionBlur.landed());
    let steps: Vec<NodeId> = schedule(|_| true).iter().flat_map(Step::nodes).collect();
    let pos = |id: NodeId| steps.iter().position(|step| *step == id).expect("scheduled");
    assert!(pos(NodeId::Taa) < pos(NodeId::Dof) && pos(NodeId::Dof) < pos(NodeId::MotionBlur) && pos(NodeId::MotionBlur) < pos(NodeId::PostHdr));
}

#[test]
fn the_lens_nodes_run_on_the_hdr_scene_only() {
    assert!(quality_allows(NodeId::Dof, &taa_quality()) && quality_allows(NodeId::MotionBlur, &taa_quality()));
    let mut ldr = taa_quality();
    ldr.hdr = false;
    assert!(!quality_allows(NodeId::Dof, &ldr) && !quality_allows(NodeId::MotionBlur, &ldr));
}

#[test]
fn a_capture_asks_for_neither_lens_effect_by_default() {
    assert_eq!(CaptureLens::default(), CaptureLens { depth_of_field: false, motion_blur: false });
    assert_eq!(CaptureLens::ALL, CaptureLens { depth_of_field: true, motion_blur: true });
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_live_frame_blurs_the_far_wall_with_the_look_s_depth_of_field() {
    let Some(gpu) = gpu() else { return };
    for (name, quality) in [("taa", taa_quality()), ("single-sample", single_sample_quality())] {
        let mut sharp = renderer(&gpu, &quality);
        let sharp_capture = draw(&gpu, &mut sharp, 0.0);
        write_evidence(&format!("{name}-sharp"), &sharp_capture);
        let sharp_contrast = bar_contrast(&sharp_capture);
        let mut lens = renderer(&gpu, &quality);
        let look = lens_look(&lens, true, false);
        lens.set_look(look);
        let blurred = draw(&gpu, &mut lens, 0.0);
        write_evidence(&format!("{name}-dof"), &blurred);
        let blurred_contrast = bar_contrast(&blurred);
        println!("{name}: bar contrast {sharp_contrast:.2} sharp, {blurred_contrast:.2} with depth of field");
        assert!(sharp_contrast > 10.0, "{name}: the wall's bars are drawn ({sharp_contrast:.2})");
        assert!(blurred_contrast < sharp_contrast * BLURRED_SHARE_MAX, "{name}: the far wall blurs: {blurred_contrast:.2} of {sharp_contrast:.2}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_panning_camera_blurs_along_its_motion_with_the_look_s_motion_blur() {
    let Some(gpu) = gpu() else { return };
    let mut sharp = renderer(&gpu, &taa_quality());
    let sharp_contrast = bar_contrast(&draw(&gpu, &mut sharp, PAN));
    for (name, dof) in [("motion blur", false), ("depth of field and motion blur", true)] {
        let mut lens = renderer(&gpu, &taa_quality());
        let look = lens_look(&lens, dof, true);
        lens.set_look(look);
        let blurred = draw(&gpu, &mut lens, PAN);
        write_evidence(&name.replace(' ', "-"), &blurred);
        let blurred_contrast = bar_contrast(&blurred);
        println!("{name}: bar contrast {sharp_contrast:.2} panning, {blurred_contrast:.2} blurred");
        assert!(blurred_contrast < sharp_contrast * BLURRED_SHARE_MAX, "{name}: the pan blurs the bars: {blurred_contrast:.2} of {sharp_contrast:.2}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_draws_without_the_lens_unless_the_shot_asks() {
    let Some(gpu) = gpu() else { return };
    let settled = |dof: bool, ask: CaptureLens| {
        let mut renderer = renderer(&gpu, &taa_quality());
        let look = lens_look(&renderer, dof, true);
        renderer.set_look(look);
        renderer.set_environment_settle(true);
        renderer.set_capture_lens(ask);
        draw(&gpu, &mut renderer, PAN)
    };
    let plain = settled(false, CaptureLens::default());
    let unasked = settled(true, CaptureLens::default());
    assert_eq!(unasked.digest(), plain.digest(), "a settled capture draws the look without its lens unless the shot asks");
    let asked = settled(true, CaptureLens::ALL);
    let (plain_contrast, asked_contrast) = (bar_contrast(&plain), bar_contrast(&asked));
    println!("settled: bar contrast {plain_contrast:.2} plain, {asked_contrast:.2} with the lens asked");
    assert!(asked_contrast < plain_contrast * BLURRED_SHARE_MAX, "a shot that asks draws the lens: {asked_contrast:.2} of {plain_contrast:.2}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_budget_ledger_counts_the_lens_targets_the_look_turns_on() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, &taa_quality());
    let labelled = |renderer: &Renderer, label: &str| renderer.buffer_ledger().entries().iter().filter(|entry| entry.label == label).map(|entry| entry.bytes).sum::<u64>();
    draw(&gpu, &mut renderer, 0.0);
    assert_eq!(labelled(&renderer, DEPTH_OF_FIELD_LABEL) + labelled(&renderer, MOTION_BLUR_LABEL), 0, "a look without the lens holds none of its targets");
    let look = lens_look(&renderer, true, true);
    renderer.set_look(look);
    draw(&gpu, &mut renderer, PAN);
    let render = (WIDTH, HEIGHT);
    let dof = genex_render::post::dof::target_bytes(render, genex_render::post::dof::DofTier::Ring, None);
    let format = Some(wgpu::TextureFormat::Rgba16Float);
    let blur = genex_render::post::motion_blur::target_bytes(render, genex_render::post::motion_blur::MotionBlurTier::Reconstruction, format);
    assert_eq!(labelled(&renderer, DEPTH_OF_FIELD_LABEL), dof, "under TAA depth of field writes into the scene");
    assert_eq!(labelled(&renderer, MOTION_BLUR_LABEL), blur, "motion blur after it takes its own output");
}
