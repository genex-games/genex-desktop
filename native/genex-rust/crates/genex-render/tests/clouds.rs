//! Renderer pass 2 B.5: the cloud panorama seen from the ground. A compute kernel marches a cloud
//! layer into a panorama of the sky (amortised: one texel of every 4x4 block a frame, 8x8 on ultra, while the sun
//! the camera's height or the layer moves, all of them on a settled capture or the first frame), and the sky's
//! background and its environment cube read it over the sky-view LUT, so reflections and the
//! ambient light see the clouds.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test clouds -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` also writes each compared frame there (raw BGRA, top row first).

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::clouds::{CloudGrid, Clouds};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::post::tonemap::f16_to_f32;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{AntiAliasing, Environment, EnvironmentQuality, ExposureMode, Look, Quality, QualityPreset, SceneFormat, SkyParams, Tonemapper};
use genex_render::sky::{CUBE_FORMAT, LutRefresh, SkyFrame, SkyState};
use genex_render::{CullPath, Gpu, Renderer};

/// The scene's sun (scene units).
const SUN: f32 = 2.5;
/// The coverage the rows draw (a broken cumulus sky).
const COVERAGE: f32 = 0.55;
/// The plan's budget for the panorama, amortised (plan section 5, B.5), on high at 1080p.
const AMORTISED_BUDGET_MS: f64 = 1.0;
/// Timed frames per cost row and untimed ones before them.
const TIMED_RUNS: usize = 64;
const TIMING_WARMUP: usize = 16;
/// Interleaved trials of the composite's cost (the background with and without the layer).
const COMPOSITE_TRIALS: usize = 3;
/// How far the sun turns a frame in the moving rows: a 24-minute game day runs the sun 0.25
/// degrees a second (0.004 a frame at 60 Hz); this is five times that.
const SUN_DEGREES_PER_FRAME: f32 = 0.02;

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
        std::fs::write(dir.join(format!("clouds-{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

fn desktop() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// A unit vector `elevation` degrees above the horizon, `azimuth` degrees from -Z towards +X.
fn towards(elevation: f32, azimuth: f32) -> [f32; 3] {
    let (e, a) = (elevation.to_radians(), azimuth.to_radians());
    [libm::cosf(e) * libm::sinf(a), libm::sinf(e), -libm::cosf(e) * libm::cosf(a)]
}

/// The sky knobs of `preset` on a desktop.
fn environment(preset: QualityPreset) -> EnvironmentQuality {
    let mut quality = preset_quality(preset, desktop()).environment;
    quality.sky = true;
    quality
}

fn cloudy() -> SkyParams {
    SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(COVERAGE)))
}

fn sky_frame(sun_dir: [f32; 3], frame_index: u64) -> SkyFrame {
    SkyFrame { sun_dir, sun_illuminance: [SUN; 3], camera_height_km: 0.002, frame_index }
}

/// One frame of the sky's LUTs and its clouds for `sun_dir` (`force`: everything at once).
fn encode_sky(gpu: &Gpu, state: &mut SkyState, sky: &SkyParams, quality: &EnvironmentQuality, frame: SkyFrame, force: bool) -> u32 {
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clouds test") });
    state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(sky, quality, frame).forced(force));
    let passes = state.encode_clouds(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(sky, quality, frame).forced(force));
    gpu.queue.submit([encoder.finish()]);
    passes.compute
}

fn cloudy_state(gpu: &Gpu, quality: &EnvironmentQuality, sun_dir: [f32; 3]) -> SkyState {
    let sky = cloudy();
    let mut state = SkyState::new();
    state.set_environment(&Environment::Sky(sky));
    assert_eq!(encode_sky(gpu, &mut state, &sky, quality, sky_frame(sun_dir, 0), true), 1, "the first frame marches the whole panorama");
    state
}

fn luminance(rgb: [f32; 4]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// The mean step between neighbours (right and below) of a `width`-wide field over its mean: a
/// smooth gradient (the clear sky) has almost none, broken clouds a lot.
fn relative_detail(values: &[f32], width: usize) -> f32 {
    let height = values.len() / width;
    let mut steps = 0.0f32;
    let mut count = 0usize;
    for y in 0..height - 1 {
        for x in 0..width - 1 {
            let at = values[y * width + x];
            steps += (values[y * width + x + 1] - at).abs() + (values[(y + 1) * width + x] - at).abs();
            count += 2;
        }
    }
    let mean = values.iter().sum::<f32>() / values.len().max(1) as f32;
    steps / count.max(1) as f32 / mean.max(1e-9)
}

/// Rec. 709 luma of every pixel, in levels.
fn lumas(capture: &Capture) -> Vec<f32> {
    capture.bgra().as_chunks::<4>().0.iter().map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

// ---------------------------------------------------------------------------------------------
// CPU rows

/// Plan section 5, B.5's "on for": desktop medium and up; low and every phone (mobile-high only
/// after a measurement on the owner's devices) draw none. Ultra's panorama is at least high's, and
/// high's at least medium's.
#[test]
fn clouds_draw_from_desktop_medium_up_and_on_no_phone() {
    let grid = |preset, class| preset_quality(preset, class).environment.clouds;
    assert_eq!(grid(QualityPreset::Low, desktop()), None, "desktop low draws no clouds");
    let [medium, high, ultra] = [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra].map(|preset| grid(preset, desktop()).expect("clouds on desktop medium and up"));
    let texels = |grid: CloudGrid| grid.panorama.0 * grid.panorama.1;
    assert!(texels(medium) <= texels(high) && texels(high) <= texels(ultra), "ultra >= high >= medium: {medium:?} {high:?} {ultra:?}");
    for grid in [medium, high, ultra] {
        assert!(grid.block.is_power_of_two(), "the amortised slices' block is a power of two: {grid:?}");
        assert_eq!(grid.panorama.0 % grid.block, 0, "the amortised slices tile the panorama: {grid:?}");
        assert_eq!(grid.panorama.1 % grid.block, 0, "the amortised slices tile the panorama: {grid:?}");
    }
    for tier in PerformanceTier::ALL {
        for preset in QualityPreset::ALL {
            assert_eq!(grid(preset, DeviceClass::new(FormFactor::Mobile, tier)), None, "no clouds on a phone ({tier:?}, {preset:?})");
        }
    }
}

/// A game's layer is held to what the kernel takes; the default layer is valid as it is.
#[test]
fn a_cloud_layer_is_held_to_what_the_kernel_takes() {
    let default = Clouds::default();
    assert_eq!(default.validated(), default, "the default layer is valid");
    assert_eq!(Clouds::default().with_coverage(2.0).coverage, 1.0);
    assert_eq!(Clouds::default().with_coverage(-1.0).coverage, 0.0);
    let thin = Clouds::default().with_layer(-3.0, 0.0);
    assert!(thin.base_km > 0.0 && thin.thickness_km > 0.0, "a layer keeps a base above the ground and a thickness: {thin:?}");
    assert!(Clouds::default().with_density(f32::NAN).density.is_finite(), "a NaN density is refused");
    assert_eq!(Clouds::default().cirrus, 0.0, "the default layer has no cirrus");
    assert_eq!(Clouds::default().with_cirrus(2.0).cirrus, 1.0);
    assert_eq!(Clouds::default().with_cirrus(f32::NAN).cirrus, 0.0, "a NaN cirrus takes the default's");
    assert_eq!(SkyParams::default().clouds, None, "the default sky has no clouds (every sky golden holds)");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

/// The panorama is a pure function of its inputs: two skies write identical bytes. While the sun
/// moves, each frame marches one sixteenth of the texels, and sixteen frames visit every texel
/// once: the panorama then stands within a small step of a whole march at the last sun.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cloud_panorama_is_deterministic_and_amortised_over_sixteen_frames() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let sun = towards(25.0, 30.0);
    let first = cloudy_state(&gpu, &quality, sun).read_clouds(&gpu).expect("panorama");
    let second = cloudy_state(&gpu, &quality, sun).read_clouds(&gpu).expect("panorama");
    assert!(first == second, "two marches of one sky write identical texels");
    let grid = quality.clouds.expect("clouds on high");
    let total = (grid.panorama.0 * grid.panorama.1) as usize;
    assert_eq!(first.len(), total);
    let cover = first.iter().filter(|t| t[3] < 0.5).count() as f32 / total as f32;
    eprintln!("panorama {:?}: {:.1}% of texels behind more than half a cloud", grid.panorama, 100.0 * cover);
    assert!((0.05..0.9).contains(&cover), "a broken sky: some clouds, some sky ({cover})");

    let sky = cloudy();
    let mut state = cloudy_state(&gpu, &quality, sun);
    let mut written = Vec::new();
    let mut last_sun = sun;
    let slices = grid.slices() as u64;
    for frame in 1..=slices {
        last_sun = towards(25.0 + SUN_DEGREES_PER_FRAME * frame as f32, 30.0);
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(last_sun, frame), false);
        written.push(state.clouds_texels_written());
    }
    assert!(written.iter().all(|w| *w as usize == total / slices as usize), "each frame marches one texel a block: {written:?} of {total}");
    let amortised = state.read_clouds(&gpu).expect("panorama");
    let whole = cloudy_state(&gpu, &quality, last_sun).read_clouds(&gpu).expect("panorama");
    // Near the sun the forward lobe turns fast with it, so the row reads the steps' mean and 99th
    // percentile, not the single worst texel.
    let mut steps: Vec<f32> = amortised.iter().zip(&whole).map(|(a, b)| (luminance(*a) - luminance(*b)).abs() / luminance(*b).max(1e-3)).collect();
    steps.sort_by(f32::total_cmp);
    let mean = steps.iter().sum::<f32>() / steps.len() as f32;
    let (p99, worst) = (steps[steps.len() * 99 / 100], steps[steps.len() - 1]);
    eprintln!("amortised against whole at the last sun: relative luminance step mean {mean:.4}, p99 {p99:.4}, worst {worst:.4}");
    assert!(mean < 0.01 && p99 < 0.05, "after sixteen frames every texel was marched within 0.3 degrees of the last sun (mean {mean}, p99 {p99})");
    // A still sun: nothing to march.
    for frame in slices + 1..2 * slices + 8 {
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(last_sun, frame), false);
    }
    assert_eq!(state.clouds_texels_written(), 0, "a settled panorama marches nothing");
    // A game drifting its layer every frame: amortised like a moving sun, never whole each frame.
    for frame in 0..8u64 {
        let drifting = SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(COVERAGE).with_offset([0.01 * (frame + 1) as f32, 0.0])));
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clouds drift") });
        let refresh = LutRefresh::new(&drifting, &quality, sky_frame(last_sun, 100 + frame));
        state.encode_clouds(&gpu.device, &gpu.queue, &mut encoder, refresh);
        gpu.queue.submit([encoder.finish()]);
        assert_eq!(state.clouds_texels_written() as usize, total / slices as usize, "a drifting layer marches one texel a block a frame");
    }
}

/// The HDR path with the physical sky at `preset`'s sky knobs, no IBL (the background alone),
/// manual exposure.
fn sky_renderer(gpu: &Gpu, preset: QualityPreset, size: (u32, u32), sky: SkyParams, clouds: Option<CloudGrid>) -> Renderer {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = environment(preset);
    quality.environment.ibl = false;
    quality.environment.clouds = clouds;
    let mut renderer = Renderer::new(gpu, size.0, size.1).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Manual;
    renderer.set_look(look);
    renderer.set_environment(&Environment::Sky(sky));
    renderer
}

/// A grey ground to the horizon under the sun `sun_dir`, the camera at head height looking
/// `pitch` degrees up towards -Z.
fn sky_scene(sun_dir: [f32; 3], pitch: f32, fovy: f32) -> Scene {
    let ahead = towards(pitch, 0.0);
    let eye = [0.0, 1.6, 0.0];
    let mut camera = CameraDesc::look_at(eye, [eye[0] + ahead[0] * 10.0, eye[1] + ahead[1] * 10.0, eye[2] + ahead[2] * 10.0]);
    camera.fovy_degrees = fovy;
    let mut scene = Scene::new(camera, [255, 0, 255, 255]);
    scene.lighting.sun_dir = sun_dir;
    scene.lighting.sun_intensity = SUN;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [400.0, 0.2, 400.0]), Material::color([150, 150, 150, 255]));
    scene
}

/// Every texel of the six faces of a `side`² cube the sky was baked into, as linear rgba.
fn bake_cube(gpu: &Gpu, sky: &SkyState, side: u32) -> Vec<[f32; 4]> {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("clouds cube test"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: CUBE_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clouds cube test") });
    assert!(sky.encode_cube(&gpu.device, &mut encoder, &view, side), "the LUTs are baked");
    let row = side * 8;
    let bytes = u64::from(row * side * 6);
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("clouds cube readback"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(side) } },
        wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 6 },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    data.as_chunks::<8>().0.iter().map(|t| [0, 2, 4, 6].map(|at| f16_to_f32(u16::from_le_bytes([t[at], t[at + 1]])))).collect()
}

/// The clouds draw into the background (the sky above the horizon breaks into bright and darker
/// patches where the clear sky is a smooth gradient) and into the environment cube (its +Y face
/// likewise), and a quality without the panorama draws the sky as before, byte for byte, while the
/// ground under the declared layer takes its veiled sun (the Bodycam light fix: the weather is the
/// game's, on every preset).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_clouds_draw_into_the_background_and_the_environment_cube() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let sun = towards(30.0, 40.0);
    let scene = sky_scene(sun, 25.0, 70.0);
    let high = environment(QualityPreset::High).clouds;
    let draw = |sky: SkyParams, clouds| {
        let mut renderer = sky_renderer(&gpu, QualityPreset::High, size, sky, clouds);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        renderer.capture(&gpu).expect("capture")
    };
    let clear = draw(SkyParams::default(), high);
    let cloudy_frame = draw(cloudy(), high);
    let switched_off = draw(cloudy(), None);
    write_evidence("clear", &clear);
    write_evidence("cloudy", &cloudy_frame);
    // The sky's upper two thirds (the horizon sits lower in a frame pitched 25 degrees up).
    let upper = |capture: &Capture| lumas(capture)[..(size.0 * size.1 * 2 / 3) as usize].to_vec();
    assert!(upper(&clear) == upper(&switched_off), "a quality without clouds draws the sky as before");
    let ground = |capture: &Capture| lumas(capture)[(size.0 * size.1 * 15 / 16) as usize..].iter().sum::<f32>();
    assert!(ground(&switched_off) < ground(&clear), "the ground under the layer takes a veiled sun without the panorama too");
    let width = size.0 as usize;
    let (clear_detail, cloudy_detail) = (relative_detail(&upper(&clear), width), relative_detail(&upper(&cloudy_frame), width));
    eprintln!("background luma detail: clear {clear_detail:.4}, cloudy {cloudy_detail:.4}");
    assert!(cloudy_detail > 2.0 * clear_detail.max(0.002), "the cloudy sky breaks up ({cloudy_detail:.4} against {clear_detail:.4})");

    let quality = environment(QualityPreset::High);
    let clear_state = {
        let sky = SkyParams::default();
        let mut state = SkyState::new();
        state.set_environment(&Environment::Sky(sky));
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(sun, 0), true);
        state
    };
    let side = 128;
    let face = (side * side) as usize;
    let up_face = |texels: &[[f32; 4]]| texels[2 * face..3 * face].iter().map(|t| luminance(*t)).collect::<Vec<_>>();
    let clear_up = up_face(&bake_cube(&gpu, &clear_state, side));
    let cloudy_up = up_face(&bake_cube(&gpu, &cloudy_state(&gpu, &quality, sun), side));
    let (clear_cube, cloudy_cube) = (relative_detail(&clear_up, side as usize), relative_detail(&cloudy_up, side as usize));
    let change = clear_up.iter().zip(&cloudy_up).map(|(a, b)| (a - b).abs()).sum::<f32>() / clear_up.iter().sum::<f32>();
    eprintln!("cube +Y luminance detail: clear {clear_cube:.4}, cloudy {cloudy_cube:.4}; mean change {change:.3} of the clear sky");
    assert!(change > 0.2 && cloudy_cube > 1.5 * clear_cube.max(0.002), "the environment cube holds the clouds (change {change:.3}, detail {cloudy_cube:.4} against {clear_cube:.4})");
}

/// TAA's history while the camera turns past a low sun among clouds: the sun disc's centroid in
/// the last frame stands within a pixel of where a fresh frame draws it (P2-0.8's sky-rotation row
/// with B.5's clouds, which ride the sky's motion: T-03), and the clouds stand where a fresh frame
/// draws them (no smear).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_turning_camera_keeps_the_sun_disc_and_the_clouds_where_a_fresh_frame_draws_them() {
    let Some(gpu) = gpu() else { return };
    const SIZE: (u32, u32) = (320, 180);
    const FOVY: f32 = 20.0;
    const ELEVATION: f32 = 12.0;
    const TURN_PX: f32 = 2.0;
    const FRAMES: u64 = 24;
    let sky = SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(0.4)));
    let renderer = || {
        let mut quality = Quality::off();
        quality.hdr = true;
        quality.tonemap = true;
        quality.prepass = true;
        quality.anti_aliasing = AntiAliasing::Taa;
        quality.environment = environment(QualityPreset::High);
        quality.environment.ibl = false;
        let mut renderer = Renderer::new(&gpu, SIZE.0, SIZE.1).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(desktop());
        renderer.set_quality(&quality);
        let mut look = Look::default();
        look.exposure = ExposureMode::Manual;
        renderer.set_look(look);
        renderer.set_environment(&Environment::Sky(sky));
        renderer
    };
    let step = TURN_PX * 2.0 * libm::tanf(FOVY.to_radians() * 0.5) / SIZE.1 as f32;
    let yaw = |frame: u64| (frame as f32 - FRAMES as f32 * 0.5) * step;
    let sun = towards(ELEVATION, 0.0);
    let scene = |frame: u64| {
        let mut scene = sky_scene(sun, ELEVATION, FOVY);
        let ahead = towards(ELEVATION, yaw(frame).to_degrees());
        let eye = [0.0, 1.6, 0.0];
        scene.camera = CameraDesc::look_at(eye, [ahead[0] * 10.0, eye[1] + ahead[1] * 10.0, ahead[2] * 10.0]);
        scene.camera.fovy_degrees = FOVY;
        scene
    };
    let mut turning = renderer();
    for frame in 0..FRAMES {
        turning.set_frame_index(frame);
        turning.render(&gpu, &scene(frame), CullPath::Gpu).expect("frame");
    }
    let turned = turning.capture(&gpu).expect("capture");
    let mut fresh = renderer();
    fresh.set_frame_index(0);
    fresh.render(&gpu, &scene(FRAMES - 1), CullPath::Gpu).expect("frame");
    let reference = fresh.capture(&gpu).expect("capture");
    write_evidence("turned", &turned);
    write_evidence("fresh", &reference);
    let (turned_luma, fresh_luma) = (lumas(&turned), lumas(&reference));
    let floor = fresh_luma.iter().copied().fold(0.0f32, f32::max) * 0.92;
    let centroid = |luma: &[f32]| {
        let mut sum = [0.0f32; 3];
        for (i, l) in luma.iter().enumerate().filter(|(_, l)| **l >= floor) {
            let weight = l - floor + 1.0;
            sum[0] += weight * (i % SIZE.0 as usize) as f32;
            sum[1] += weight * (i / SIZE.0 as usize) as f32;
            sum[2] += weight;
        }
        [sum[0] / sum[2].max(f32::MIN_POSITIVE), sum[1] / sum[2].max(f32::MIN_POSITIVE)]
    };
    let (a, b) = (centroid(&turned_luma), centroid(&fresh_luma));
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    let error = libm::sqrtf(dx * dx + dy * dy);
    // The clouds: the sky above the horizon (the frame's upper half), away from the frame's edges
    // (a turning frame's first column has no history).
    let mut sky_diff = 0.0f32;
    let mut sky_pixels = 0usize;
    for y in 8..(SIZE.1 / 2) as usize {
        for x in 8..(SIZE.0 - 8) as usize {
            let i = y * SIZE.0 as usize + x;
            sky_diff += (turned_luma[i] - fresh_luma[i]).abs();
            sky_pixels += 1;
        }
    }
    let sky_mean = sky_diff / sky_pixels as f32;
    eprintln!("sun disc centroid: turned {a:?}, fresh {b:?}, error {error:.2} px; clouds' mean luma difference {sky_mean:.2} levels");
    assert!(error < 1.0, "the turning camera's sun disc stands {error:.2} px from a fresh frame's");
    assert!(sky_mean < 2.0, "the clouds under a turning camera stand where a fresh frame draws them ({sky_mean:.2} levels)");
}

/// The cloud-edge flicker row: a still camera under a moving sun, the panorama amortised. A texel
/// marched every sixteenth frame steps once where its neighbours drift; the flicker that adds is
/// the second difference of a pixel's luma over time (a flicker's signature; a smooth drift has
/// little) over the clouds' edges, against the same frames with everything marched whole each frame
/// (a settled capture's path): within a quarter level on average and a level at the 99th percentile.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cloud_edges_hold_still_while_the_panorama_amortises_under_a_moving_sun() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    const FRAMES: u64 = 40;
    let run = |whole: bool| {
        let mut renderer = sky_renderer(&gpu, QualityPreset::High, size, cloudy(), environment(QualityPreset::High).clouds);
        renderer.set_environment_settle(whole);
        let mut frames = Vec::new();
        for frame in 0..FRAMES {
            let sun = towards(30.0 + SUN_DEGREES_PER_FRAME * frame as f32, 40.0);
            renderer.set_frame_index(frame);
            renderer.render(&gpu, &sky_scene(sun, 25.0, 70.0), CullPath::Gpu).expect("frame");
            frames.push(lumas(&renderer.capture(&gpu).expect("capture")));
        }
        frames
    };
    let (amortised, whole) = (run(false), run(true));
    let last = whole.last().expect("frames");
    let width = size.0 as usize;
    // The clouds' edges in the sky: a luma step of 4 levels or more to the right or below.
    let edges: Vec<usize> = (0..(size.1 as usize / 2) * width)
        .filter(|i| i % width + 1 < width && ((last[i + 1] - last[*i]).abs() >= 4.0 || (last[i + width] - last[*i]).abs() >= 4.0))
        .collect();
    assert!(edges.len() > 100, "the frame has cloud edges to watch ({})", edges.len());
    let flicker = |frames: &[Vec<f32>]| {
        let mut seconds: Vec<f32> = Vec::new();
        for t in 1..frames.len() - 1 {
            for &i in &edges {
                seconds.push((frames[t + 1][i] - 2.0 * frames[t][i] + frames[t - 1][i]).abs());
            }
        }
        seconds.sort_by(f32::total_cmp);
        (seconds.iter().sum::<f32>() / seconds.len() as f32, seconds[seconds.len() * 99 / 100])
    };
    let ((mean, p99), (whole_mean, whole_p99)) = (flicker(&amortised), flicker(&whole));
    eprintln!(
        "cloud edges: {} pixels, temporal second difference amortised mean {mean:.3} p99 {p99:.2}, whole every frame mean {whole_mean:.3} p99 {whole_p99:.2} levels",
        edges.len()
    );
    assert!(mean <= whole_mean + 0.25 && p99 <= whole_p99 + 1.0, "cloud edges flicker while the panorama amortises: mean {mean:.3} against {whole_mean:.3}, p99 {p99:.2} against {whole_p99:.2} levels");
}

/// Timed marches of the panorama at `quality` under a sun moving `SUN_DEGREES_PER_FRAME` a frame
/// (`whole`: every frame forced whole), sorted, in ms.
fn time_clouds(gpu: &Gpu, quality: &EnvironmentQuality, whole: bool) -> Vec<f64> {
    let total = TIMING_WARMUP + TIMED_RUNS;
    let count = 2 * total as u32;
    let bytes = u64::from(count) * 8;
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("clouds timing"), ty: wgpu::QueryType::Timestamp, count });
    let buffer = |label, usage| gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes, usage, mapped_at_creation: false });
    let resolve = buffer("clouds timing", wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC);
    let read = buffer("clouds timing read", wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
    let sky = cloudy();
    let mut state = SkyState::new();
    state.set_environment(&Environment::Sky(sky));
    for run in 0..total {
        let frame = sky_frame(towards(25.0 + SUN_DEGREES_PER_FRAME * run as f32, 30.0), run as u64);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clouds timing") });
        state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(&sky, quality, frame).forced(true));
        let first = 2 * run as u32;
        let writes = wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(first), end_of_pass_write_index: Some(first + 1) };
        let refresh = LutRefresh::new(&sky, quality, frame).forced(whole || run == 0).timed(writes);
        let passes = state.encode_clouds(&gpu.device, &gpu.queue, &mut encoder, refresh);
        assert_eq!(passes.compute, 1, "every timed frame marches");
        gpu.queue.submit([encoder.finish()]);
    }
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("clouds timing resolve") });
    encoder.resolve_query_set(&queries, 0..count, &resolve, 0);
    encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    read.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let period = f64::from(gpu.queue.get_timestamp_period());
    let stamps: Vec<u64> = read.slice(..).get_mapped_range().expect("mapped range").as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
    let mut times: Vec<f64> = stamps.as_chunks::<2>().0[TIMING_WARMUP..].iter().map(|[begin, end]| end.saturating_sub(*begin) as f64 * period / 1.0e6).collect();
    times.sort_by(f64::total_cmp);
    times
}

/// The plan's budget: the panorama costs at most 1.0 ms a frame amortised on high (its p50 under a
/// moving sun); medium's fits it too. Ultra is measured and reported (owner decision D15: the
/// quality bar first). The whole march (a settled capture or the first frame) is reported.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cloud_panorama_fits_its_amortised_budget() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let mut rows = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = environment(preset);
        let sliced = time_clouds(&gpu, &quality, false);
        let whole = time_clouds(&gpu, &quality, true);
        let (p50, p95) = (sliced[sliced.len() / 2], sliced[sliced.len() * 95 / 100]);
        let whole_p50 = whole[whole.len() / 2];
        // The composite: the 1080p background with and without the layer, their draws interleaved.
        let sun = towards(25.0, 30.0);
        let mut composite = Vec::new();
        for _ in 0..COMPOSITE_TRIALS {
            let skies = [(SkyParams::default(), sun), (cloudy(), sun)];
            let times = genex_render::sky::background_gpu_ms_interleaved(&gpu, &skies, &quality, (1920, 1080), TIMED_RUNS).expect("drawn").expect("timestamps");
            let median = |times: &[f64]| times[times.len() / 2];
            composite.push(median(&times[1]) - median(&times[0]));
        }
        composite.sort_by(f64::total_cmp);
        let composite_ms = composite[composite.len() / 2];
        eprintln!(
            "{preset:?} {:?}: amortised march p50 {p50:.3} ms, p95 {p95:.3} ms; whole march p50 {whole_p50:.3} ms; 1080p composite +{composite_ms:.3} ms (trials {composite:?})",
            quality.clouds
        );
        rows.push((preset, p50 + composite_ms.max(0.0)));
    }
    for (preset, total) in rows {
        if preset != QualityPreset::Ultra {
            assert!(total <= AMORTISED_BUDGET_MS, "{preset:?}: the clouds cost {total:.3} ms a frame amortised (budget {AMORTISED_BUDGET_MS})");
        }
    }
}

/// Evidence frames (not a gate): the cloudy sky at golden hour towards the sun and at noon, at
/// 1440p on high and 4K on ultra, written to `GENEX_RENDER_EVIDENCE_DIR` for a person to look at.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_evidence_frames_of_the_clouds() {
    let Some(gpu) = gpu() else { return };
    if std::env::var("GENEX_RENDER_EVIDENCE_DIR").is_err() {
        eprintln!("skipped: no GENEX_RENDER_EVIDENCE_DIR");
        return;
    }
    let shots = [("golden-hour", towards(7.0, 15.0), 8.0), ("noon", towards(55.0, 120.0), 12.0), ("afternoon", towards(25.0, -35.0), 10.0)];
    for (preset, size) in [(QualityPreset::High, (2560, 1440)), (QualityPreset::Ultra, (3840, 2160))] {
        for (name, sun, pitch) in shots {
            let mut renderer = sky_renderer(&gpu, preset, size, cloudy(), environment(preset).clouds);
            renderer.render(&gpu, &sky_scene(sun, pitch, 60.0), CullPath::Gpu).expect("frame");
            let capture = renderer.capture(&gpu).expect("capture");
            write_evidence(&format!("{name}-{preset:?}"), &capture);
            // The Lakeside's sky: its fair-weather cumulus under a cirrus sheet.
            let lakeside = SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(CIRRUS_ROW_COVERAGE).with_cirrus(CIRRUS_ROW_SHEET)));
            let mut renderer = sky_renderer(&gpu, preset, size, lakeside, environment(preset).clouds);
            renderer.render(&gpu, &sky_scene(sun, pitch, 60.0), CullPath::Gpu).expect("frame");
            write_evidence(&format!("{name}-cirrus-{preset:?}"), &renderer.capture(&gpu).expect("capture"));
        }
    }
}

/// The lowest elevation the night row reads clouds at, degrees: the shots look over the treeline,
/// and below it the clouds are mostly the hazy sky in front of them.
const NIGHT_ROW_ELEVATION_DEGREES: f32 = 10.0;

/// The mean light, rgb, of a `width`-wide panorama's cloud texels (behind more than half a cloud)
/// at least [`NIGHT_ROW_ELEVATION_DEGREES`] up (`sky/clouds_map.wgsl`'s rows: the zenith first,
/// elevation a right angle times (t + t^2) / 2 of t = 1 - v).
fn mean_cloud_light(panorama: &[[f32; 4]], width: usize) -> [f32; 3] {
    let rows = panorama.len() / width;
    let high = |at: usize| {
        let up = 1.0 - ((at / width) as f32 + 0.5) / rows as f32;
        (0.25 * std::f32::consts::PI * (up + up * up)).to_degrees() >= NIGHT_ROW_ELEVATION_DEGREES
    };
    let clouds: Vec<&[f32; 4]> = panorama.iter().enumerate().filter(|(at, t)| t[3] < 0.5 && high(*at)).map(|(_, t)| t).collect();
    let n = clouds.len().max(1) as f32;
    [0, 1, 2].map(|c| clouds.iter().map(|t| t[c]).sum::<f32>() / n)
}

/// Look lane SKY (after GB): on a moonlit night the clouds are lit by the moon, as the ground is
/// (`night_sky::ground_light`: the brighter of the sun and the moon), not left to the twilight
/// under the horizon: they read moonlit and neutral against the moonlit sky instead of dark,
/// warm shapes hiding the stars. The Lakeside's night: the sun 7 degrees under the horizon, the
/// full moon 7 degrees up opposite it, cooled ([0.55, 0.72, 1.0]) at 0.012 of the sun's light.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_moonlit_nights_clouds_are_lit_by_the_moon_and_neutral() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let sun = towards(-7.0, 270.0);
    let moon = genex_render::night_sky::Moon::new(towards(7.0, 90.0)).with_moonlight(0.012).with_tint([0.55, 0.72, 1.0]);
    let night = |moon: Option<genex_render::night_sky::Moon>| {
        let sky = cloudy().with_moon(moon).with_stars(4e-5);
        let mut state = SkyState::new();
        state.set_environment(&Environment::Sky(sky));
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(sun, 0), true);
        mean_cloud_light(&state.read_clouds(&gpu).expect("panorama"), quality.clouds.expect("clouds on high").panorama.0 as usize)
    };
    let moonless = night(None);
    let moonlit = night(Some(moon));
    let lum = |rgb: [f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let lift = lum(moonlit) / lum(moonless).max(1e-9);
    let warmth = moonlit[0] / moonlit[2].max(1e-9);
    eprintln!("night clouds: moonless {moonless:?}, moonlit {moonlit:?}, lift {lift:.2}x, red over blue {warmth:.3}");
    assert!(lift >= 2.0, "the moon lights the clouds: {lift:.2}x the moonless night's");
    assert!(warmth <= 1.0, "moonlit clouds are neutral or cool, never warm (red over blue {warmth:.3})");
}

/// The golden-hour layer the row reads (the Lakeside's coverage).
const GOLDEN_COVERAGE: f32 = 0.4;
/// The warmest the golden-hour sky overhead may read with the clouds (the +Y face's red over blue:
/// grey or cooler, never orange), and the most they may brighten it.
const GOLDEN_RED_OVER_BLUE_MAX: f32 = 1.0;
const GOLDEN_BRIGHTENING_MAX: f32 = 2.0;

/// Look lane SKY: at golden hour a cumulus overhead is seen from below, from its base, which the
/// low sun reaches only through kilometres of cloud: it reads grey to rose in the sky's light,
/// orange only at the edges towards the sun. The march's light reach towards a grazing sun was
/// held to 2 km, so the low sun lit the bases through and the whole deck glowed flat orange (B.5's
/// own look note): in the environment cube it dyed the Lakeside's ambient light, and the golden
/// meadow turned orange-brown (D13: the meadow keeps its green). The cause was the march's
/// ambient term: three horizon samples weighed like the zenith let the low sun's glow light every
/// cloud. The cube's +Y face with the layer reads grey or cooler and at most twice as bright.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_hour_clouds_overhead_do_not_dye_the_ambient_orange() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let sun = towards(7.0, 15.0);
    let side = 64;
    let face = (side * side) as usize;
    let up = |sky: SkyParams| {
        let mut state = SkyState::new();
        state.set_environment(&Environment::Sky(sky));
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(sun, 0), true);
        let texels = bake_cube(&gpu, &state, side);
        let n = face as f32;
        [0, 1, 2].map(|c| texels[2 * face..3 * face].iter().map(|t| t[c]).sum::<f32>() / n)
    };
    let clear = up(SkyParams::default());
    let cloudy = up(SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(GOLDEN_COVERAGE))));
    let lum = |rgb: [f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let warmth = |rgb: [f32; 3]| rgb[0] / rgb[2].max(1e-9);
    let (red_over_blue, brightening) = (warmth(cloudy), lum(cloudy) / lum(clear).max(1e-9));
    eprintln!("golden hour +Y: clear {clear:?} (red over blue {:.2}), cloudy {cloudy:?} (red over blue {red_over_blue:.2}); brightening {brightening:.2}x", warmth(clear));
    assert!(red_over_blue <= GOLDEN_RED_OVER_BLUE_MAX, "the clouds overhead dye the ambient orange: red over blue {red_over_blue:.2} (at most {GOLDEN_RED_OVER_BLUE_MAX})");
    assert!(brightening <= GOLDEN_BRIGHTENING_MAX, "the clouds overhead brighten the ambient {brightening:.2}x (at most {GOLDEN_BRIGHTENING_MAX})");
}

/// The 4K frame the dither row reads: ultra's panorama at its 1:1 output.
const DITHER_SIZE: (u32, u32) = (3840, 2160);
/// The most texel-scale noise a cloudy 4K sky may hold over the clear sky's, in levels: the mean,
/// over the sky, of each pixel's luma step from the mean of its 3 x 3 neighbourhood (a soft cloud
/// edge is smooth at that scale; the march's dither is not), and the same at the 99.9th percentile.
const DITHER_MEAN_OVER_CLEAR_MAX: f32 = 0.15;
const DITHER_P999_MAX: f32 = 2.0;

/// Each sky pixel's luma step (levels) from the mean of its 3 x 3 neighbourhood, over the top
/// `rows` rows of a `width`-wide frame, sorted.
fn texel_noise(values: &[f32], width: usize, rows: usize) -> Vec<f32> {
    let mut steps = Vec::with_capacity(width * rows);
    for y in 1..rows - 1 {
        for x in 1..width - 1 {
            let mut sum = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    sum += values[(y + dy - 1) * width + x + dx - 1];
                }
            }
            steps.push((values[y * width + x] - sum / 9.0).abs());
        }
    }
    steps.sort_by(f32::total_cmp);
    steps
}

/// Look fix lane SKY (after the final shots): at 4K 1:1 the clouds' edges showed the march's
/// start-offset dither as a cross-hatch (each panorama texel's interleaved-gradient offset,
/// magnified three pixels a texel). The cloudy 4K sky on ultra holds no more texel-scale noise
/// than the clear sky's plus [`DITHER_MEAN_OVER_CLEAR_MAX`] levels on average, and its worst
/// thousandth stays under [`DITHER_P999_MAX`] levels, at golden hour and in the afternoon.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cloud_edges_show_no_march_dither_at_4k() {
    let Some(gpu) = gpu() else { return };
    let ultra = environment(QualityPreset::Ultra).clouds;
    let mut problems = Vec::new();
    for (name, sun, pitch) in [("golden-hour", towards(7.0, 15.0), 12.0), ("afternoon", towards(25.0, -35.0), 14.0)] {
        let scene = sky_scene(sun, pitch, 60.0);
        let draw = |sky: SkyParams| {
            let mut renderer = sky_renderer(&gpu, QualityPreset::Ultra, DITHER_SIZE, sky, ultra);
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            renderer.capture(&gpu).expect("capture")
        };
        let (clear, cloudy_frame) = (draw(SkyParams::default()), draw(cloudy()));
        write_evidence(&format!("dither-{name}"), &cloudy_frame);
        let (width, rows) = (DITHER_SIZE.0 as usize, DITHER_SIZE.1 as usize * 3 / 5);
        let mean = |steps: &[f32]| steps.iter().sum::<f32>() / steps.len().max(1) as f32;
        let (clear_steps, cloudy_steps) = (texel_noise(&lumas(&clear), width, rows), texel_noise(&lumas(&cloudy_frame), width, rows));
        let (clear_mean, cloudy_mean) = (mean(&clear_steps), mean(&cloudy_steps));
        let p999 = cloudy_steps[cloudy_steps.len() * 999 / 1000];
        eprintln!("{name}: texel-scale noise clear {clear_mean:.3}, cloudy {cloudy_mean:.3} levels; cloudy p99.9 {p999:.2} (clear {:.2})", clear_steps[clear_steps.len() * 999 / 1000]);
        if cloudy_mean > clear_mean + DITHER_MEAN_OVER_CLEAR_MAX || p999 > DITHER_P999_MAX {
            problems.push(format!("{name}: texel-scale noise {cloudy_mean:.3} against the clear sky's {clear_mean:.3}, p99.9 {p999:.2} levels"));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The cirrus row's cumulus coverage (the Lakeside's) and its sheet.
const CIRRUS_ROW_COVERAGE: f32 = 0.35;
const CIRRUS_ROW_SHEET: f32 = 0.6;
/// The share of the clear gaps (no cumulus, at least 15 degrees up) the sheet covers (dims the sky
/// behind by 3% or more), at least and at most: streaks, not an overcast.
const CIRRUS_GAP_SHARE: std::ops::RangeInclusive<f32> = 0.15..=0.8;
/// The sheet is thin: what it leaves of the sky behind, on average where it covers.
const CIRRUS_THROUGH_MIN: f32 = 0.4;

/// Look fix lane SKY (after the final shots): the Lakeside's dusk lost GB's streaky cirrus deck
/// when the renderer's cumulus replaced the game's flat clouds. A layer with cirrus draws a thin
/// sheet of streaks above the cumulus: in the gaps between the cumulus at golden hour it covers
/// [`CIRRUS_GAP_SHARE`] of the sky, leaves at least [`CIRRUS_THROUGH_MIN`] of it behind on
/// average, and lights it (the streaks add light where they dim the sky); a layer without cirrus
/// leaves the gaps clear.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_cirrus_sheet_streaks_the_sky_above_the_cumulus() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let width = quality.clouds.expect("clouds on high").panorama.0 as usize;
    let sun = towards(7.0, 15.0);
    let panorama = |cirrus: f32| {
        let sky = SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(CIRRUS_ROW_COVERAGE).with_cirrus(cirrus)));
        let mut state = SkyState::new();
        state.set_environment(&Environment::Sky(sky));
        encode_sky(&gpu, &mut state, &sky, &quality, sky_frame(sun, 0), true);
        state.read_clouds(&gpu).expect("panorama")
    };
    let (bare, sheet) = (panorama(0.0), panorama(CIRRUS_ROW_SHEET));
    let rows = bare.len() / width;
    let up = |at: usize| {
        let t = 1.0 - ((at / width) as f32 + 0.5) / rows as f32;
        (0.25 * std::f32::consts::PI * (t + t * t)).to_degrees() >= 15.0
    };
    let gaps: Vec<usize> = (0..bare.len()).filter(|at| up(*at) && bare[*at][3] >= 0.999).collect();
    assert!(gaps.len() > width, "the cumulus leaves gaps ({})", gaps.len());
    let covered: Vec<usize> = gaps.iter().copied().filter(|at| sheet[*at][3] <= 0.97).collect();
    let share = covered.len() as f32 / gaps.len() as f32;
    let n = covered.len().max(1) as f32;
    let through = covered.iter().map(|at| sheet[*at][3]).sum::<f32>() / n;
    let light = covered.iter().map(|at| luminance(sheet[*at])).sum::<f32>() / n;
    let bare_light = gaps.iter().map(|at| luminance(bare[*at])).sum::<f32>() / gaps.len() as f32;
    eprintln!("cirrus: {share:.3} of {} gap texels covered, mean through {through:.3}, light {light:.4} (bare {bare_light:.4})", gaps.len());
    assert!(CIRRUS_GAP_SHARE.contains(&share), "the sheet covers {share:.3} of the gaps (wanted {CIRRUS_GAP_SHARE:?})");
    assert!(through >= CIRRUS_THROUGH_MIN, "the sheet is thin: {through:.3} of the sky left behind (at least {CIRRUS_THROUGH_MIN})");
    assert!(light > 2.0 * bare_light.max(1e-6), "the streaks are lit: {light:.4} against the bare gaps' {bare_light:.4}");
}
