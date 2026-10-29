//! Lane UP: the image a native desktop's ultra frame draws when it renders its pixel budget and
//! TAA-upscales it to the window (`presets::budget_scale`, `presets::effect_budgeted`), against
//! the same frames rendered natively at scale 1 with full-resolution AO (ultra before the budget).
//! Every frame is compared with the native one of the same index, by luma SSIM (8x8 windows,
//! stride 4) and mean absolute error, on three scenes a crowd game shows:
//!
//! - **thin geometry**: a field of grass blades and a picket fence a pixel or two wide, still
//!   (shimmer: each pixel's frame-to-frame change once settled) and under a slow pan;
//! - **edges in motion**: the same field under a fast pan;
//! - **a fast crowd**: forty boxes running across a checkered floor, each under its own draw id
//!   (ghosting: what the frames behind a runner still show of it).
//!
//! The output is half the Mac's 3456x2169 panel a side, rendered at that panel's budget scale
//! (0.6875) with the budget's half-resolution AO: the upscale ratio and the effects Live draws
//! there. The numbers are printed for the report; the asserted bounds guard against a regression.
//!
//! GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test upscale_quality -- --ignored metal --test-threads=1
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each scene's last native and upscaled frame (raw BGRA).

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::motion::DrawId;
use genex_render::presets::{budget_scale, class_defaults, effect_budgeted, preset_quality, render_pixel_budget, step_size};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene};
use genex_render::settings::{AoResolution, Quality, QualityPreset, SceneFormat};
use genex_render::upscale::UpscaleMode;
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::{Mat4, Vec3};

/// The Mac's full-screen drawable, whose budget scale and effects the upscaled frames take.
const PANEL: (u32, u32) = (3456, 2169);
/// The compared frames' output: half the panel a side.
const OUTPUT: (u32, u32) = (1728, 1085);
/// Frames drawn before a still scene is compared: a second of Live, over three of the upscale's
/// 17-phase jitter cycles at 0.6875.
const SETTLE: u64 = 60;
/// Frames of motion compared after the settle.
const MOVING: u64 = 24;
/// The SSIM windows' side and stride, in pixels.
const SSIM_WINDOW: usize = 8;
const SSIM_STRIDE: usize = 4;
/// The least mean SSIM an upscaled frame keeps against the native one, still and in motion
/// (measured on the M4 Max: 0.956 still grass, 0.934 and 0.907 under the slow and fast pans,
/// 0.979 for the crowd).
const SSIM_STILL_MIN: f64 = 0.93;
const SSIM_MOVING_MIN: f64 = 0.88;
/// The most mean absolute luma difference from the native frame, in levels (measured 0.7 to 3.2).
const MEAN_ABS_MAX: f64 = 4.0;
/// The least mean SSIM and the most mean absolute error at dynamic resolution's floor (0.53125 of
/// the panel a side; measured 0.86 and 4.2 levels under the fast pan).
const FLOOR_SSIM_MIN: f64 = 0.84;
const FLOOR_MEAN_ABS_MAX: f64 = 5.0;
/// The most a settled still upscaled frame may change from one frame to the next, over the
/// native frame's change (shimmer), plus a floor of 0.25 levels for two settled frames.
const SHIMMER_RATIO_MAX: f64 = 2.0;
const SHIMMER_FLOOR: f64 = 0.25;
/// The most pixels behind the runners that may differ from the native frame by more than
/// [`GHOST_LEVELS`] (ghosting), as a share of the trail.
const GHOST_SHARE_MAX: f64 = 0.02;
const GHOST_LEVELS: f32 = 24.0;

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

fn ultra_class() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra)
}

/// Native ultra: scale 1, AO at full resolution (what lock 1.0 drew before the budget).
fn native_quality() -> Quality {
    preset_quality(QualityPreset::Ultra, ultra_class())
}

/// The scale Live draws the panel at nominally: the budget's.
fn budget() -> f32 {
    budget_scale(PANEL, render_pixel_budget(ultra_class()))
}

/// Dynamic resolution's lowest step on the panel: the class's lowest step times the budget's
/// scale, in 1/32 steps (0.53125).
fn floor_scale() -> f32 {
    let lowest = class_defaults(ultra_class()).drs_steps[0] * budget();
    (lowest * 32.0).round() / 32.0
}

/// The quality Live draws the panel with: ultra under its effect budgets at the nominal step.
fn upscaled_quality() -> Quality {
    effect_budgeted(&native_quality(), ultra_class(), step_size(PANEL, budget()))
}

fn renderer(gpu: &Gpu, quality: &Quality, scale: f32) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, OUTPUT.0, OUTPUT.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(ultra_class());
    renderer.set_quality(quality);
    renderer.set_render_scale(scale);
    renderer
}

fn transform(at: Vec3, yaw: f32, tilt: f32, scale: Vec3) -> [f32; 16] {
    (Mat4::from_translation(at) * Mat4::from_rotation_y(yaw) * Mat4::from_rotation_z(tilt) * Mat4::from_scale(scale)).to_cols_array()
}

/// A tiny deterministic hash in [0, 1).
fn hash(i: u32) -> f32 {
    let mut x = i.wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    x ^= x >> 15;
    x = x.wrapping_mul(0x2C1B_3C6D);
    x ^= x >> 12;
    (x & 0xFF_FFFF) as f32 / 16_777_216.0
}

/// A sunlit checkered floor of `tiles` a side, one metre each, centred on the origin.
fn floor(scene: &mut Scene, tiles: i32) {
    let half = tiles / 2;
    let (mut light, mut dark) = (Vec::new(), Vec::new());
    for z in -half..half {
        for x in -half..half {
            let model = transform(Vec3::new(x as f32 + 0.5, -0.05, z as f32 + 0.5), 0.0, 0.0, Vec3::new(1.0, 0.1, 1.0));
            if (x + z).rem_euclid(2) == 0 { light.push(model) } else { dark.push(model) }
        }
    }
    scene.draw_instanced(MeshId::CUBE, &light, Material::color([150, 140, 120, 255]).with_pbr(0.0, 0.35));
    scene.draw_instanced(MeshId::CUBE, &dark, Material::color([70, 66, 60, 255]).with_pbr(0.0, 0.6));
}

/// Thin geometry: 6,000 blades a centimetre wide (about a pixel at 6 m) leaning every way, and a
/// picket fence of 2 cm posts behind them, seen from `eye`.
fn grass_scene(eye: [f32; 3], target: [f32; 3]) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at(eye, target), [120, 150, 190, 255]);
    scene.lighting.sun_dir = Vec3::new(-0.5, 0.65, 0.4).normalize().to_array();
    floor(&mut scene, 24);
    let blades: Vec<[f32; 16]> = (0..6000)
        .map(|i| {
            let (x, z) = (hash(i) * 10.0 - 5.0, hash(i + 7919) * 8.0 - 6.0);
            let height = 0.25 + 0.3 * hash(i + 104_729);
            transform(Vec3::new(x, height * 0.5, z), hash(i + 31) * std::f32::consts::TAU, (hash(i + 61) - 0.5) * 0.6, Vec3::new(0.012, height, 0.012))
        })
        .collect();
    scene.draw_instanced(MeshId::CUBE, &blades, Material::color([70, 140, 40, 255]).with_pbr(0.0, 0.7));
    let posts: Vec<[f32; 16]> = (0..80).map(|i| transform(Vec3::new(i as f32 * 0.15 - 6.0, 0.6, -7.0), 0.0, 0.0, Vec3::new(0.02, 1.2, 0.02))).collect();
    scene.draw_instanced(MeshId::CUBE, &posts, Material::color([230, 225, 215, 255]));
    let rails: Vec<[f32; 16]> = [0.35, 1.0].iter().map(|y| transform(Vec3::new(0.0, *y, -7.0), 0.0, 0.0, Vec3::new(12.0, 0.03, 0.03))).collect();
    scene.draw_instanced(MeshId::CUBE, &rails, Material::color([230, 225, 215, 255]));
    scene
}

/// A fast crowd: forty 0.5 m boxes running across the floor at frame `frame`, each under its own
/// draw id, about 20 output pixels a frame.
fn crowd_scene(frame: u64) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 9.0], [0.0, 0.3, 0.0]), [120, 150, 190, 255]);
    scene.lighting.sun_dir = Vec3::new(-0.5, 0.65, 0.4).normalize().to_array();
    floor(&mut scene, 30);
    for runner in 0..40u32 {
        let lane = runner as f32 * 0.3 - 6.0;
        let speed = 0.2 + 0.1 * hash(runner);
        let x = (hash(runner + 11) * 16.0 + speed * frame as f32).rem_euclid(16.0) - 8.0;
        let colour = [200, (60 + runner * 4) as u8, 60, 255];
        scene.set_id(Some(DrawId::from(format!("runner-{runner}").as_str())));
        scene.draw(MeshId::CUBE, transform(Vec3::new(x, 0.25, lane * 0.5), 0.4, 0.0, Vec3::splat(0.5)), Material::color(colour).with_pbr(0.0, 0.5));
    }
    scene.set_id(None);
    scene
}

/// Rec. 709 luma of every pixel, in levels.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Mean SSIM of luma images `a` and `b` (`width` wide) over 8x8 windows at stride 4.
fn ssim(a: &[f32], b: &[f32], width: usize) -> f64 {
    let height = a.len() / width;
    let (c1, c2) = ((0.01f64 * 255.0).powi(2), (0.03f64 * 255.0).powi(2));
    let (mut sum, mut count) = (0.0f64, 0usize);
    let n = (SSIM_WINDOW * SSIM_WINDOW) as f64;
    for y in (0..height.saturating_sub(SSIM_WINDOW)).step_by(SSIM_STRIDE) {
        for x in (0..width.saturating_sub(SSIM_WINDOW)).step_by(SSIM_STRIDE) {
            let (mut ma, mut mb, mut aa, mut bb, mut ab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for dy in 0..SSIM_WINDOW {
                for dx in 0..SSIM_WINDOW {
                    let at = (y + dy) * width + x + dx;
                    let (va, vb) = (f64::from(a[at]), f64::from(b[at]));
                    (ma, mb, aa, bb, ab) = (ma + va, mb + vb, aa + va * va, bb + vb * vb, ab + va * vb);
                }
            }
            let (ma, mb) = (ma / n, mb / n);
            let (va, vb, cov) = (aa / n - ma * ma, bb / n - mb * mb, ab / n - ma * mb);
            sum += ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            count += 1;
        }
    }
    sum / count.max(1) as f64
}

/// Mean absolute luma difference, levels.
fn mean_abs(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| f64::from((x - y).abs())).sum::<f64>() / a.len().max(1) as f64
}

fn write_evidence(name: &str, capture: &Capture) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("evidence folder");
    std::fs::write(dir.join(format!("upscale-{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
}

/// Frames `0..settle + compared` of `scene_at(frame)` drawn by `renderer`; the lumas of the last
/// `compared` frames, and the last frame.
fn run(gpu: &Gpu, renderer: &mut Renderer, scene_at: &dyn Fn(u64) -> Scene, settle: u64, compared: u64) -> (Vec<Vec<f32>>, Capture) {
    let mut frames = Vec::new();
    let mut last = None;
    for index in 0..settle + compared {
        renderer.set_frame_index(index);
        renderer.render(gpu, &scene_at(index), CullPath::Gpu).expect("frame");
        if index >= settle {
            let capture = renderer.capture(gpu).expect("capture");
            frames.push(lumas(&capture));
            last = Some(capture);
        }
    }
    (frames, last.expect("compared frames"))
}

/// What one scene measured: mean SSIM and mean absolute error against native, frame for frame,
/// and the mean frame-to-frame change of each sequence.
#[derive(Debug)]
struct Compared {
    ssim: f64,
    mean_abs: f64,
    native_change: f64,
    upscaled_change: f64,
}

/// Draw `scene_at` natively and upscaled and compare them frame for frame.
fn compare(gpu: &Gpu, name: &str, scene_at: &dyn Fn(u64) -> Scene, settle: u64, compared: u64) -> (Compared, Vec<Vec<f32>>, Vec<Vec<f32>>) {
    compare_at(gpu, budget(), name, scene_at, (settle, compared))
}

/// [`compare`] with the upscaled frames drawn at `scale` (`frames`: settled, then compared).
fn compare_at(gpu: &Gpu, scale: f32, name: &str, scene_at: &dyn Fn(u64) -> Scene, frames: (u64, u64)) -> (Compared, Vec<Vec<f32>>, Vec<Vec<f32>>) {
    let (settle, compared) = frames;
    let quality = upscaled_quality();
    assert_eq!(quality.ao.resolution, AoResolution::Half, "the premise: the panel's budget halves AO");
    let mut native = renderer(gpu, &native_quality(), 1.0);
    let (native_frames, native_last) = run(gpu, &mut native, scene_at, settle, compared);
    drop(native);
    let mut upscaled = renderer(gpu, &quality, scale);
    let (upscaled_frames, upscaled_last) = run(gpu, &mut upscaled, scene_at, settle, compared);
    assert!(upscaled.last_scene().is_some_and(|path| path.taau), "the upscaled frames resolve by TAAU");
    write_evidence(&format!("{name}-native"), &native_last);
    write_evidence(&format!("{name}-upscaled"), &upscaled_last);
    let width = OUTPUT.0 as usize;
    let pairs = || native_frames.iter().zip(&upscaled_frames);
    let frames = native_frames.len() as f64;
    let change = |frames: &[Vec<f32>]| frames.windows(2).map(|pair| mean_abs(&pair[0], &pair[1])).sum::<f64>() / (frames.len() - 1).max(1) as f64;
    let compared = Compared {
        ssim: pairs().map(|(n, u)| ssim(n, u, width)).sum::<f64>() / frames,
        mean_abs: pairs().map(|(n, u)| mean_abs(n, u)).sum::<f64>() / frames,
        native_change: change(&native_frames),
        upscaled_change: change(&upscaled_frames),
    };
    eprintln!("{name} at scale {scale} (render {:?} of {OUTPUT:?}): {compared:?}", step_size(OUTPUT, scale));
    (compared, native_frames, upscaled_frames)
}

/// Thin geometry, still: once settled, the upscaled field matches native (SSIM) and shimmers no
/// more than twice as much as native TAA from frame to frame.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_thin_geometry_settles_like_native_without_shimmer() {
    let Some(gpu) = gpu() else { return };
    let still = |_| grass_scene([0.0, 1.6, 4.0], [0.0, 0.3, -2.0]);
    let (compared, _, _) = compare(&gpu, "grass-still", &still, SETTLE, 16);
    assert!(compared.ssim >= SSIM_STILL_MIN && compared.mean_abs <= MEAN_ABS_MAX, "still grass: {compared:?}");
    let shimmer_max = (compared.native_change * SHIMMER_RATIO_MAX).max(SHIMMER_FLOOR);
    assert!(compared.upscaled_change <= shimmer_max, "still grass shimmers {:.3} levels a frame (native {:.3})", compared.upscaled_change, compared.native_change);
}

/// Thin geometry and edges in motion: a slow pan (about a pixel a frame) and a fast one (about 8)
/// keep the native frame's structure frame for frame.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_thin_geometry_and_edges_stay_stable_in_motion() {
    let Some(gpu) = gpu() else { return };
    for (name, metres) in [("grass-slow-pan", 0.004f32), ("grass-fast-pan", 0.03)] {
        let pan = move |frame: u64| {
            let x = metres * frame as f32 - 0.6;
            grass_scene([x, 1.6, 4.0], [x, 0.3, -2.0])
        };
        let (compared, _, _) = compare(&gpu, name, &pan, SETTLE / 2, MOVING);
        assert!(compared.ssim >= SSIM_MOVING_MIN && compared.mean_abs <= MEAN_ABS_MAX, "{name}: {compared:?}");
    }
}

/// A fast crowd: behind each runner the upscaled frames show the floor as native does, so no
/// ghost trails it (pixels behind a runner further than 24 levels from native, as a share of the
/// trail: those native shows as floor that a runner covered in the last eight frames).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_fast_crowd_leaves_no_ghosts_under_the_upscale() {
    let Some(gpu) = gpu() else { return };
    let (compared, native_frames, upscaled_frames) = compare(&gpu, "crowd", &crowd_scene, SETTLE / 2, MOVING);
    assert!(compared.ssim >= SSIM_MOVING_MIN && compared.mean_abs <= MEAN_ABS_MAX, "crowd: {compared:?}");
    // The trail: pixels whose native luma changed in the last eight frames (a runner passed) but
    // not in this one (it is gone).
    let (mut trail, mut ghosts) = (0usize, 0usize);
    for at in 8..native_frames.len() {
        let now = &native_frames[at];
        for pixel in 0..now.len() {
            let settled = (native_frames[at - 1][pixel] - now[pixel]).abs() < 2.0;
            let passed = (at - 8..at).any(|before| (native_frames[before][pixel] - now[pixel]).abs() > 40.0);
            if settled && passed {
                trail += 1;
                ghosts += usize::from((upscaled_frames[at][pixel] - now[pixel]).abs() > GHOST_LEVELS);
            }
        }
    }
    let share = ghosts as f64 / trail.max(1) as f64;
    eprintln!("crowd trail: {trail} pixels, {ghosts} ghosted ({:.4})", share);
    assert!(trail > 1000, "the premise: the runners leave a trail ({trail})");
    assert!(share <= GHOST_SHARE_MAX, "{ghosts} of {trail} trail pixels ghost ({share:.4})");
}

/// A compared scene: its name, its frames and how many settle before how many are compared.
type SceneRow<'a> = (&'a str, &'a dyn Fn(u64) -> Scene, (u64, u64));

/// Dynamic resolution's floor on the panel (0.53125, where a heavy frame holds 60 fps): the three
/// scenes keep the native frame's structure within looser bounds (measured on the M4 Max and
/// printed for the report).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_at_the_dynamic_resolution_floor_the_upscale_keeps_the_native_structure() {
    let Some(gpu) = gpu() else { return };
    let floor = floor_scale();
    assert_eq!(floor, 0.53125, "the premise: the panel's lowest step");
    let still = |_| grass_scene([0.0, 1.6, 4.0], [0.0, 0.3, -2.0]);
    let pan = |frame: u64| {
        let x = 0.03 * frame as f32 - 0.6;
        grass_scene([x, 1.6, 4.0], [x, 0.3, -2.0])
    };
    let rows: [SceneRow<'_>; 3] = [("floor-grass-still", &still, (SETTLE, 16)), ("floor-grass-fast-pan", &pan, (SETTLE / 2, MOVING)), ("floor-crowd", &crowd_scene, (SETTLE / 2, MOVING))];
    for (name, scene_at, frames) in rows {
        let (compared, _, _) = compare_at(&gpu, floor, name, scene_at, frames);
        assert!(compared.ssim >= FLOOR_SSIM_MIN && compared.mean_abs <= FLOOR_MEAN_ABS_MAX, "{name}: {compared:?}");
    }
}

/// The pixels behind the runners (native changed in the last eight frames, not in this one) and how
/// many of them the upscaled frames show more than [`GHOST_LEVELS`] from native.
fn ghosting(native_frames: &[Vec<f32>], upscaled_frames: &[Vec<f32>]) -> (usize, usize) {
    let (mut trail, mut ghosts) = (0usize, 0usize);
    for at in 8..native_frames.len() {
        let now = &native_frames[at];
        for pixel in 0..now.len() {
            let settled = (native_frames[at - 1][pixel] - now[pixel]).abs() < 2.0;
            let passed = (at - 8..at).any(|before| (native_frames[before][pixel] - now[pixel]).abs() > 40.0);
            if settled && passed {
                trail += 1;
                ghosts += usize::from((upscaled_frames[at][pixel] - now[pixel]).abs() > GHOST_LEVELS);
            }
        }
    }
    (trail, ghosts)
}

/// `frames` (settled, then compared) of `scene_at` drawn with `quality` at `scale` of the output.
fn frames_at(gpu: &Gpu, quality: &Quality, scale: f32, scene_at: &dyn Fn(u64) -> Scene, frames: (u64, u64)) -> Vec<Vec<f32>> {
    let mut renderer = renderer(gpu, quality, scale);
    run(gpu, &mut renderer, scene_at, frames.0, frames.1).0
}

/// SSIM and mean absolute error of `frames` against `native`, frame for frame, and their mean
/// frame-to-frame change.
fn against(native: &[Vec<f32>], frames: &[Vec<f32>]) -> Compared {
    let width = OUTPUT.0 as usize;
    let count = native.len() as f64;
    let change = |frames: &[Vec<f32>]| frames.windows(2).map(|pair| mean_abs(&pair[0], &pair[1])).sum::<f64>() / (frames.len() - 1).max(1) as f64;
    Compared {
        ssim: native.iter().zip(frames).map(|(n, u)| ssim(n, u, width)).sum::<f64>() / count,
        mean_abs: native.iter().zip(frames).map(|(n, u)| mean_abs(n, u)).sum::<f64>() / count,
        native_change: change(native),
        upscaled_change: change(frames),
    }
}

/// Lane UQ: each upscaling mode's frames on the Mac panel against native ultra (scale 1,
/// full-resolution AO), with the effect budget each mode's render size draws: SSIM and mean error
/// for the still field, the fast pan and the crowd; shimmer (still field) and ghosting (crowd) for
/// Quality and Performance. Native, Quality and Balanced keep the budget rows' bounds, Performance
/// the floor's. Ultra Performance (11/32, measured once with the floor lowered) did not: still
/// field 0.857, fast pan 0.765, 3.0% of the crowd's trail ghosted, so it is not offered.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_each_upscaling_mode_keeps_the_native_frame_s_structure() {
    let Some(gpu) = gpu() else { return };
    let still = |_| grass_scene([0.0, 1.6, 4.0], [0.0, 0.3, -2.0]);
    let pan = |frame: u64| {
        let x = 0.03 * frame as f32 - 0.6;
        grass_scene([x, 1.6, 4.0], [x, 0.3, -2.0])
    };
    let rows: [SceneRow<'_>; 3] = [("grass-still", &still, (SETTLE, 16)), ("grass-fast-pan", &pan, (SETTLE / 2, MOVING)), ("crowd", &crowd_scene, (SETTLE / 2, MOVING))];
    let modes: Vec<(&str, f32)> = UpscaleMode::ALL.iter().map(|mode| (mode.wire(), mode.scale())).collect();
    for (scene, scene_at, frames) in rows {
        let native = frames_at(&gpu, &native_quality(), 1.0, scene_at, frames);
        for (mode, scale) in &modes {
            let quality = effect_budgeted(&native_quality(), ultra_class(), step_size(PANEL, *scale));
            let upscaled = frames_at(&gpu, &quality, *scale, scene_at, frames);
            let compared = against(&native, &upscaled);
            let mut line = format!("UQ {scene} {mode} scale {scale} (AO {:?}): ssim {:.3} mean {:.2}", quality.ao.resolution, compared.ssim, compared.mean_abs);
            if scene == "grass-still" {
                line += &format!(" shimmer {:.3} (native {:.3})", compared.upscaled_change, compared.native_change);
            }
            if scene == "crowd" {
                let (trail, ghosts) = ghosting(&native, &upscaled);
                line += &format!(" ghosted {:.4} of {trail}", ghosts as f64 / trail.max(1) as f64);
                if ["quality", "performance"].contains(mode) {
                    assert!(ghosts as f64 / trail.max(1) as f64 <= GHOST_SHARE_MAX, "{line}");
                }
            }
            eprintln!("{line}");
            let (ssim_min, mean_max) = match *mode {
                "native" | "quality" | "balanced" if scene == "grass-still" => (SSIM_STILL_MIN, MEAN_ABS_MAX),
                "native" | "quality" | "balanced" => (SSIM_MOVING_MIN, MEAN_ABS_MAX),
                _ => (FLOOR_SSIM_MIN, FLOOR_MEAN_ABS_MAX),
            };
            assert!(compared.ssim >= ssim_min && compared.mean_abs <= mean_max, "{line}");
            if scene == "grass-still" && ["quality", "performance"].contains(mode) {
                let shimmer_max = (compared.native_change * SHIMMER_RATIO_MAX).max(SHIMMER_FLOOR);
                assert!(compared.upscaled_change <= shimmer_max, "{line}");
            }
        }
    }
}
