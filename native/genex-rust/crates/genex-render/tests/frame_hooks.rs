//! Renderer pass 2, Stage B wave 2 (frame hooks): the Stage B nodes on the real frame.
//!
//! B.8 TAA upscaling: a TAA frame below scale 1 resolves at output size (`post::taau`) instead of
//! TAA at render size followed by EASU, and keeps native sharpness (the plan's acceptance: 4K at a
//! dynamic-resolution scale of 0.67 within 10% of native 4K by the Laplacian). Frames that read
//! the scene at render size before the tonemap (depth of field, motion blur, `post-hdr` passes)
//! keep TAA and EASU.
//!
//! GPU rows are `metal_*` and ignored by default: `cargo test -p genex-render --release --test
//! frame_hooks -- --ignored --test-threads=1`.

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{AntiAliasing, Quality, SceneFormat, Upscaler};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

/// The plan's 4K output.
const OUTPUT_4K: (u32, u32) = (3840, 2160);
/// The dynamic-resolution scale the acceptance names (2573x1447 at 4K).
const DRS_SCALE: f32 = 0.67;
/// Frames drawn before the capture: three of the upscale's 18-phase cycles at 0.67.
const SETTLE: u64 = 54;
/// The share of native sharpness (mean absolute Laplacian of luma) an upscaled still frame keeps
/// (the plan's "within 10%": neither softer nor over-sharpened by more).
const SHARPNESS_SHARE: std::ops::RangeInclusive<f32> = 0.9..=1.1;

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

/// The HDR scene under TAA with FSR1's upscaler below scale 1 and nothing else that keeps history,
/// upscaling temporally when `taau` (B.8) or by TAA then EASU (the path before the hook).
fn taa_quality(taau: bool) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality.upscaler = Upscaler::Fsr1;
    quality.taau = taau;
    quality
}

fn renderer(gpu: &Gpu, quality: &Quality, size: (u32, u32), scale: f32) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(quality);
    renderer.set_render_scale(scale);
    renderer
}

/// A field of small turned cubes in many colours: slanted edges at every scale, the detail an
/// upscale blurs.
fn detail_scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.2, 7.5], [0.0, 0.0, 0.0]), [20, 24, 32, 255]);
    scene.lighting.sun_dir = glam::Vec3::new(-0.4, 0.7, 0.6).normalize().to_array();
    for row in 0..14 {
        for column in 0..22 {
            let (x, z) = (column as f32 * 0.42 - 4.4, row as f32 * 0.42 - 3.0);
            let turn = glam::Mat4::from_translation(glam::Vec3::new(x, 0.0, z))
                * glam::Mat4::from_rotation_y(0.31 * (row * 7 + column) as f32)
                * glam::Mat4::from_rotation_x(0.27)
                * glam::Mat4::from_scale(glam::Vec3::splat(0.17));
            let shade = |k: usize| (60 + (k * 53) % 190) as u8;
            let colour = [shade(row * 3 + column), shade(row + column * 5), shade(row * 7 + column * 2), 255];
            scene.draw(MeshId::CUBE, turn.to_cols_array(), Material::color(colour));
        }
    }
    scene
}

/// Write a capture to `GENEX_RENDER_EVIDENCE_DIR` (raw BGRA), when set.
fn write_evidence(name: &str, bgra: &[u8], size: (u32, u32)) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("frame-hooks-{name}-{}x{}.bgra", size.0, size.1)), bgra).expect("evidence");
    }
}

/// `frames` frames of `scene` drawn by `renderer`; the last frame's capture (BGRA).
fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64) -> Vec<u8> {
    for index in 0..frames {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture").bgra().to_vec()
}

/// Mean absolute 4-neighbour Laplacian of Rec. 709 luma over a `width`-wide BGRA image, levels.
fn sharpness(bgra: &[u8], width: usize) -> f32 {
    let luma: Vec<f32> = bgra.as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect();
    let height = luma.len() / width;
    let (mut sum, mut count) = (0.0f64, 0usize);
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let at = y * width + x;
            let lap = 4.0 * luma[at] - luma[at - 1] - luma[at + 1] - luma[at - width] - luma[at + width];
            sum += f64::from(lap.abs());
            count += 1;
        }
    }
    (sum / count.max(1) as f64) as f32
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_taa_frame_below_scale_one_resolves_at_output_size_without_easu() {
    let Some(gpu) = gpu() else { return };
    let scene = detail_scene();
    let output = (480, 270);
    let mut upscaled = renderer(&gpu, &taa_quality(true), output, DRS_SCALE);
    draw(&gpu, &mut upscaled, &scene, 2);
    let path = upscaled.last_scene().expect("ran");
    assert!(path.taa && path.taau, "TAA upscales below scale 1: {path:?}");
    assert!(!path.fsr.easu && !path.fsr.rcas, "no EASU after the upscale (and no RCAS without TaaSharpen): {:?}", path.fsr);
    let mut native = renderer(&gpu, &taa_quality(true), output, 1.0);
    draw(&gpu, &mut native, &scene, 2);
    let path = native.last_scene().expect("ran");
    assert!(path.taa && !path.taau, "at scale 1 TAA resolves at its own size: {path:?}");
    let mut before = renderer(&gpu, &taa_quality(false), output, DRS_SCALE);
    draw(&gpu, &mut before, &scene, 2);
    let path = before.last_scene().expect("ran");
    assert!(path.taa && !path.taau && path.fsr.easu, "without the switch TAA then EASU: {path:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_depth_of_field_keeps_taa_and_easu_below_scale_one() {
    let Some(gpu) = gpu() else { return };
    let scene = detail_scene();
    let mut quality = taa_quality(true);
    quality.dof = genex_render::post::dof::DofTier::Circular;
    let mut renderer = renderer(&gpu, &quality, (480, 270), DRS_SCALE);
    let mut look = *renderer.look();
    look.depth_of_field.enabled = true;
    renderer.set_look(look);
    draw(&gpu, &mut renderer, &scene, 2);
    let path = renderer.last_scene().expect("ran");
    assert!(path.taa && !path.taau && path.fsr.easu, "the lens reads the scene at render size: TAA then EASU: {path:?}");
}

/// The plan's acceptance (B.8): 4K at a dynamic-resolution scale of 0.67 matches native 4K's
/// sharpness within 10% (mean absolute Laplacian), where TAA at render size then EASU did not.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_4k_at_scale_0_67_keeps_native_sharpness_under_taa_upscaling() {
    let Some(gpu) = gpu() else { return };
    let scene = detail_scene();
    let width = OUTPUT_4K.0 as usize;
    let native_frame = draw(&gpu, &mut renderer(&gpu, &taa_quality(true), OUTPUT_4K, 1.0), &scene, SETTLE);
    let mut upscaled_renderer = renderer(&gpu, &taa_quality(true), OUTPUT_4K, DRS_SCALE);
    let upscaled_frame = draw(&gpu, &mut upscaled_renderer, &scene, SETTLE);
    assert!(upscaled_renderer.last_scene().is_some_and(|path| path.taau), "the frame upscaled temporally");
    let before_frame = draw(&gpu, &mut renderer(&gpu, &taa_quality(false), OUTPUT_4K, DRS_SCALE), &scene, SETTLE);
    for (name, frame) in [("native", &native_frame), ("taau", &upscaled_frame), ("taa-easu", &before_frame)] {
        write_evidence(name, frame, OUTPUT_4K);
    }
    let [native, upscaled, before] = [&native_frame, &upscaled_frame, &before_frame].map(|frame| sharpness(frame, width));
    let (share, before_share) = (upscaled / native, before / native);
    eprintln!("4K sharpness: native {native:.3}, TAA upscaling from {DRS_SCALE} {upscaled:.3} ({share:.3} of native), TAA then EASU {before:.3} ({before_share:.3})");
    assert!(SHARPNESS_SHARE.contains(&share), "TAA upscaling keeps {share:.3} of native sharpness (within {SHARPNESS_SHARE:?})");
}

/// GPU milliseconds of whole frames of each renderer drawing `scene`, rounds interleaved (the
/// GPU's clocks and heat shared alike), median per renderer; None without timestamp queries.
fn frame_ms(gpu: &Gpu, renderers: &mut [Renderer], scene: &Scene) -> Option<Vec<f32>> {
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); renderers.len()];
    for round in 0..5u64 {
        for (k, renderer) in renderers.iter_mut().enumerate() {
            for frame in 0..40u64 {
                let times = renderer.arm_frame_timer(&gpu.queue)?;
                if round > 0 && frame >= 8 {
                    landed[k].extend(times);
                }
                renderer.set_frame_index(round * 40 + frame);
                renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
    }
    Some(landed.into_iter().map(|mut times| {
        times.sort_by(f32::total_cmp);
        times[times.len() / 2]
    }).collect())
}

/// The frame the hook replaced (B.8 perf row): at 4K from 0.67, TAA upscaling's whole frame costs
/// no more than TAA at render size then EASU and RCAS did (its node measured 0.57 ms against about
/// 1.45 ms for the pair it replaces).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_upscaling_costs_no_more_than_taa_then_easu_at_4k() {
    let Some(gpu) = gpu() else { return };
    let scene = detail_scene();
    let mut renderers = [
        renderer(&gpu, &taa_quality(true), OUTPUT_4K, DRS_SCALE),
        renderer(&gpu, &taa_quality(false), OUTPUT_4K, DRS_SCALE),
        renderer(&gpu, &taa_quality(true), OUTPUT_4K, 1.0),
    ];
    let Some(ms) = frame_ms(&gpu, &mut renderers, &scene) else { return eprintln!("skipped: no timestamp queries") };
    let [taau, easu, native] = [ms[0], ms[1], ms[2]];
    eprintln!("4K whole frame (GPU p50): TAA upscaling from {DRS_SCALE} {taau:.3} ms, TAA then EASU {easu:.3} ms, native 4K TAA {native:.3} ms");
    assert!(taau <= easu, "TAA upscaling's frame {taau:.3} ms against the replaced path's {easu:.3} ms");
}

/// Mean absolute luma difference of two BGRA frames, levels.
fn luma_change(a: &[u8], b: &[u8]) -> f32 {
    let luma = |p: &[u8; 4]| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2]);
    let (a, b) = (a.as_chunks::<4>().0, b.as_chunks::<4>().0);
    a.iter().zip(b).map(|(x, y)| (luma(x) - luma(y)).abs()).sum::<f32>() / a.len().max(1) as f32
}

/// The picture's change on the frame a still camera steps from `from` to `to` (render scale), after
/// [`SETTLE`] frames at `from`, against the frame before; `reset` starts history over at the step
/// (what the switch between TAA and the upscale did before the hand-over).
fn step_change(gpu: &Gpu, scene: &Scene, from: f32, to: f32, reset: bool) -> f32 {
    let mut renderer = renderer(gpu, &taa_quality(true), (640, 360), from);
    let before = draw(gpu, &mut renderer, scene, SETTLE);
    renderer.set_render_scale(to);
    if reset {
        renderer.reset_temporal_history(genex_render::settle::HistorySet::Live, genex_render::settle::HistoryReset::CameraCut);
    }
    renderer.set_frame_index(SETTLE);
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    let after = renderer.capture(gpu).expect("capture").bgra().to_vec();
    luma_change(&before, &after)
}

/// RC-05 for the upscale (renderer pass 2 wave 2): a dynamic-resolution step across scale 1 under
/// TAA switches between TAA at render size and TAA upscaling; each hands its history to the other,
/// so the step frame changes the still picture far less than a history reset does (red before the
/// hand-over: `tests/ao.rs` `metal_a_render_scale_step_does_not_reset_ao_in_live_frames` read the
/// crease jump 1.96 levels, bound 1).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_step_across_scale_one_hands_the_history_over_both_ways() {
    let Some(gpu) = gpu() else { return };
    let scene = detail_scene();
    for (from, to) in [(1.0, DRS_SCALE), (DRS_SCALE, 1.0)] {
        let (kept, reset) = (step_change(&gpu, &scene, from, to, false), step_change(&gpu, &scene, from, to, true));
        eprintln!("step {from} -> {to}: the picture changes {kept:.3} levels with the hand-over, {reset:.3} after a reset");
        assert!(kept <= reset * 0.5, "step {from} -> {to}: {kept:.3} levels against a reset's {reset:.3}");
    }
}

/// A pond scene: a sand floor (a flattened cube, its top at y = -0.6), turned cubes standing in
/// it, and with `water` a lake rectangle at y = 0 over most of it.
fn pond(water: bool) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.4, 6.0], [0.0, -0.4, 0.0]), [20, 24, 32, 255]);
    scene.lighting.sun_dir = glam::Vec3::new(-0.3, 0.8, 0.5).normalize().to_array();
    let floor = glam::Mat4::from_translation(glam::Vec3::new(0.0, -1.1, 0.0)) * glam::Mat4::from_scale(glam::Vec3::new(8.0, 0.5, 8.0));
    scene.draw(MeshId::CUBE, floor.to_cols_array(), Material::color([194, 178, 128, 255]));
    for (k, x) in [-1.6f32, 0.0, 1.6].into_iter().enumerate() {
        let cube = glam::Mat4::from_translation(glam::Vec3::new(x, -0.3, -0.8 + k as f32 * 0.6)) * glam::Mat4::from_rotation_y(0.5 + k as f32) * glam::Mat4::from_scale(glam::Vec3::splat(0.35));
        scene.draw(MeshId::CUBE, cube.to_cols_array(), Material::color([200, 60 + 60 * k as u8, 50, 255]));
    }
    if water {
        let body = genex_render::water::WaterBody { centre: [0.0, 0.0, 0.0], half_extent: [3.0, 3.0], material: genex_render::water::WaterMaterial::LAKE };
        scene.water = Some(genex_render::scene::SceneWater { body, time: 1.5 });
    }
    scene
}

/// B.3 on the frame (graph node 16a): a scene's water draws over the opaque scene in its own pass
/// after the world pass, refracting an opaque copy where the preset holds the screen inputs and
/// blended elsewhere, and a scene without water draws exactly as before.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_scenes_water_draws_on_the_frame() {
    use genex_render::screen_inputs::ScreenInputs;
    let Some(gpu) = gpu() else { return };
    let size = (480, 270);
    for (label, inputs) in [("refracted", ScreenInputs::ALL), ("blended", ScreenInputs::NONE)] {
        let mut quality = taa_quality(true);
        quality.screen_inputs = inputs;
        let frames = |water: bool| {
            let mut renderer = renderer(&gpu, &quality, size, 1.0);
            let frame = draw(&gpu, &mut renderer, &pond(water), 8);
            (frame, renderer.last_world_pass().map(|world| world.passes))
        };
        let ((dry, dry_passes), (wet, wet_passes)) = (frames(false), frames(true));
        let (again, _) = frames(false);
        assert_eq!(dry, again, "{label}: a scene without water draws the same frame");
        let changed = dry.as_chunks::<4>().0.iter().zip(wet.as_chunks::<4>().0).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8)).count();
        let share = changed as f32 / (size.0 * size.1) as f32;
        eprintln!("{label}: the water changes {share:.3} of the frame; world passes {dry_passes:?} -> {wet_passes:?}");
        write_evidence(&format!("pond-{label}"), &wet, size);
        assert!(share > 0.2, "{label}: the lake covers much of the frame, {share:.3} changed");
        assert_eq!(dry_passes, wet_passes, "{label}: the water draws in its own pass, the world pass is one");
    }
}

/// T-01 step 3 on the frame: under TAA a camera sliding sideways moves the water's pixels by the
/// surface's own motion, not by the bed's under it (the surface is 0.85 m nearer, so its parallax
/// differs), so TAA reprojects the water by the water.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_waters_pixels_carry_the_surfaces_motion_under_taa() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let motion = |water: bool| {
        let mut renderer = renderer(&gpu, &taa_quality(true), size, 1.0);
        renderer.set_depth_readback(true);
        for (index, x) in [0.0f32, 0.12].into_iter().enumerate() {
            let mut scene = pond(water);
            scene.camera = CameraDesc::look_at([x, 2.4, 6.0], [x, -0.4, 0.0]);
            renderer.set_frame_index(index as u64);
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        }
        renderer.read_motion(&gpu).expect("motion")
    };
    let (dry, wet) = (motion(false), motion(true));
    // The middle of the frame, where the lake covers the floor.
    let (w, h) = (size.0 as usize, size.1 as usize);
    let at = |field: &[[f32; 2]], x: usize, y: usize| field[y * w + x][0];
    let samples: Vec<(f32, f32)> = (h / 2..h * 3 / 4).step_by(4).flat_map(|y| (w / 3..w * 2 / 3).step_by(8).map(move |x| (x, y))).map(|(x, y)| (at(&dry, x, y), at(&wet, x, y))).collect();
    let mean = |pick: fn(&(f32, f32)) -> f32| samples.iter().map(pick).sum::<f32>() / samples.len() as f32;
    let (bed, surface) = (mean(|s| s.0), mean(|s| s.1));
    eprintln!("sideways slide: the bed moves {bed:.5} NDC, the water surface {surface:.5}");
    assert!(bed.abs() > 1e-4, "the camera moved: {bed}");
    assert!((surface - bed).abs() > bed.abs() * 0.1, "the water's pixels carry the surface's motion ({surface}) rather than the bed's ({bed})");
}

/// B.3's screen reflections on the frame: with the history pyramid (desktop `high`), the frame
/// after one with water marches last frame's colour, so a red pillar standing out of the lake shows
/// in the water below it; without the pyramid the water reflects the environment alone.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lake_reflects_a_pillar_through_the_history_pyramid() {
    use genex_render::screen_inputs::ScreenInputs;
    let Some(gpu) = gpu() else { return };
    let size = (480, 270);
    let mut scene = pond(true);
    let pillar = glam::Mat4::from_translation(glam::Vec3::new(0.0, 0.6, -1.5)) * glam::Mat4::from_scale(glam::Vec3::new(0.5, 1.4, 0.5));
    scene.draw(MeshId::CUBE, pillar.to_cols_array(), Material::color([230, 30, 30, 255]));
    let frame = |inputs: ScreenInputs| {
        let mut quality = taa_quality(true);
        quality.screen_inputs = inputs;
        draw(&gpu, &mut renderer(&gpu, &quality, size, 1.0), &scene, 12)
    };
    let (marched, environment) = (frame(ScreenInputs::ALL), frame(ScreenInputs { history_pyramid: false, ..ScreenInputs::ALL }));
    write_evidence("pillar-marched", &marched, size);
    write_evidence("pillar-environment", &environment, size);
    // Pixels the march made redder (more red than green by 4 levels or more than without it).
    let redder = marched.as_chunks::<4>().0.iter().zip(environment.as_chunks::<4>().0).filter(|(m, e)| {
        let tint = |p: &[u8; 4]| i32::from(p[2]) - i32::from(p[1]);
        tint(m) - tint(e) >= 4
    });
    let count = redder.count();
    eprintln!("the march reddens {count} pixels below the pillar");
    assert!(count >= 200, "the lake reflects the pillar through the pyramid: {count} pixels");
}
