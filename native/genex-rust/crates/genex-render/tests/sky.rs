//! RQ2.2: the physical sky (Hillaire) on every preset: the transmittance, multiple-scattering and
//! sky-view LUTs, their frame-indexed cadence, the background at the far plane with the sun disk,
//! and the sky into the environment cube without the disk.
//!
//! Every row needs a GPU: they are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test sky -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/sky/<name>.bgra` (raw BGRA, top row first,
//! 128x72); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` also
//! writes each compared frame there; `GENEX_PERF_OUT` receives the LUT cost row as JSON.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::post::tonemap::f16_to_f32;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled, translation};
use genex_render::settings::{Environment, EnvironmentQuality, ExposureMode, Look, Quality, QualityPreset, SceneFormat, SkyParams, Tonemapper};
use genex_render::sky::{CUBE_FORMAT, LutRefresh, SkyFrame, SkyLut, SkyState};
use genex_render::{CullPath, Gpu, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// Low and high may differ in detail, never in look (the showcase's look-consistency row): mean
/// luminance within this share of high's, the mean colour's hue within this many degrees.
const LOOK_LUMINANCE_SHARE: f64 = 0.06;
const LOOK_HUE_DEGREES: f64 = 4.0;
/// The sky LUTs' budget (plan §5, M4 Max): per refresh on high, amortized over the cadence on low,
/// and on low the frame that refreshes (its p95) within high's per-frame budget too (RQ2 review:
/// the amortized mean alone hid the every-8th-frame spike).
const HIGH_BUDGET_MS: f64 = 0.3;
const LOW_AMORTIZED_BUDGET_MS: f64 = 0.1;
const LOW_REFRESH_P95_BUDGET_MS: f64 = HIGH_BUDGET_MS;
/// How far one trial may pass a budget before the row fails whatever the median says (timing
/// noise on a shared desktop GPU).
const TRIAL_NOISE_BAND: f64 = 0.5;
/// Timed refreshes per row.
const TIMED_RUNS: usize = 60;
/// Untimed refreshes before them (pipelines made, the GPU's clocks up).
const TIMING_WARMUP: usize = 8;
/// Interleaved trials of the whole cost row; the gate reads their median (plan §2.10's P15).
const TIMED_TRIALS: usize = 3;
/// The scene's sun (scene units).
const SUN: f32 = 2.5;

// ---------------------------------------------------------------------------------------------
// Fixtures

fn gpu_with(features: wgpu::Features) -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless_with(features) {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require && features.is_empty() => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no adapter with {features:?} ({error})");
            None
        }
    }
}

fn gpu() -> Option<Gpu> {
    gpu_with(wgpu::Features::empty())
}

/// A unit vector `elevation` degrees above the horizon, towards -Z (the cameras look that way).
fn sun_at(elevation: f32) -> [f32; 3] {
    let e = elevation.to_radians();
    [0.0, libm::sinf(e), -libm::cosf(e)]
}

/// The sky knobs of `preset` on a desktop class.
fn environment(preset: QualityPreset) -> EnvironmentQuality {
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class");
    let mut quality = preset_quality(preset, class).environment;
    quality.sky = true;
    quality
}

fn frame(sun_dir: [f32; 3], frame_index: u64) -> SkyFrame {
    SkyFrame { sun_dir, sun_illuminance: [SUN; 3], camera_height_km: 0.002, frame_index }
}

/// A sky with its LUTs computed for `sun_dir` under `quality`.
fn baked_sky(gpu: &Gpu, sky: &SkyParams, quality: &EnvironmentQuality, sun_dir: [f32; 3]) -> SkyState {
    let mut state = SkyState::new();
    state.set_environment(&Environment::Sky(*sky));
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky test") });
    let passes = state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(sky, quality, frame(sun_dir, 0)).forced(true));
    assert_eq!(passes.compute, 1, "the first refresh computes every LUT in one pass");
    gpu.queue.submit([encoder.finish()]);
    state
}

fn luminance(rgb: [f32; 4]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// The mean of `row` of a `width`-wide LUT, over `columns`.
fn row_mean(texels: &[[f32; 4]], width: u32, row: u32, columns: std::ops::Range<u32>) -> [f32; 4] {
    let count = columns.len() as f32;
    let mut sum = [0.0f32; 4];
    for x in columns {
        let texel = texels[(row * width + x) as usize];
        for (s, v) in sum.iter_mut().zip(texel) {
            *s += v;
        }
    }
    sum.map(|s| s / count)
}

/// The sky-view LUT row just above the horizon (the lower half is the ground).
fn horizon_row(height: u32) -> u32 {
    height / 2 - 1
}

// ---------------------------------------------------------------------------------------------
// LUT rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_noon_sky_is_bluer_overhead_and_brightest_towards_the_sun() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let sky = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(80.0));
    let (width, height) = sky.lut_size(SkyLut::SkyView).expect("made");
    let texels = sky.read_lut(&gpu, SkyLut::SkyView).expect("read");
    assert!(texels.iter().all(|t| t.iter().all(|c| c.is_finite() && *c >= 0.0)), "finite, non-negative radiance");
    let zenith = row_mean(&texels, width, 0, 0..width);
    let horizon = row_mean(&texels, width, horizon_row(height), 0..width);
    eprintln!("noon: zenith {zenith:?} (Y {}), horizon {horizon:?} (Y {})", luminance(zenith), luminance(horizon));
    assert!(luminance(zenith) > 0.0, "the noon sky is lit");
    // Rayleigh: blue overhead; the long path whitens the horizon.
    let blue = |t: [f32; 4]| t[2] / t[0].max(1e-6);
    assert!(blue(zenith) > 1.5 * blue(horizon), "zenith B/R {} against horizon B/R {}", blue(zenith), blue(horizon));
    // Mie's forward lobe: towards the sun (column 0) the horizon is brighter than away (the last).
    let towards = texels[(horizon_row(height) * width) as usize];
    let away = texels[(horizon_row(height) * width + width - 1) as usize];
    assert!(luminance(towards) > luminance(away), "towards the sun {towards:?}, away {away:?}");
    // The zenith is at its brightest with the sun overhead.
    let overhead = baked_sky(&gpu, &SkyParams::default(), &quality, [0.0, 1.0, 0.0]).read_lut(&gpu, SkyLut::SkyView).expect("read");
    let low_sun = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(20.0)).read_lut(&gpu, SkyLut::SkyView).expect("read");
    let zenith_of = |texels: &[[f32; 4]]| luminance(row_mean(texels, width, 0, 0..width));
    assert!(zenith_of(&overhead) > zenith_of(&texels) && zenith_of(&texels) > zenith_of(&low_sun), "zenith luminance follows the sun");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sunset_reddens_the_horizon_towards_the_sun() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let sky = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(2.0));
    let (width, height) = sky.lut_size(SkyLut::SkyView).expect("made");
    let texels = sky.read_lut(&gpu, SkyLut::SkyView).expect("read");
    let towards = row_mean(&texels, width, horizon_row(height), 0..width / 8);
    eprintln!("sunset horizon towards the sun: {towards:?}");
    assert!(towards[0] > 1.5 * towards[2], "R/B {} at the sunset horizon", towards[0] / towards[2].max(1e-6));
    let noon = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(80.0)).read_lut(&gpu, SkyLut::SkyView).expect("read");
    let noon_towards = row_mean(&noon, width, horizon_row(height), 0..width / 8);
    assert!(noon_towards[0] < noon_towards[2], "the noon horizon stays blue-white: {noon_towards:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_two_runs_write_identical_lut_bytes() {
    let Some(gpu) = gpu() else { return };
    for preset in [QualityPreset::Low, QualityPreset::High] {
        let quality = environment(preset);
        let bits = |sky: &SkyState, lut| -> Vec<u32> { sky.read_lut(&gpu, lut).expect("read").iter().flatten().map(|v| v.to_bits()).collect() };
        let first = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(30.0));
        let second = baked_sky(&gpu, &SkyParams::default(), &quality, sun_at(30.0));
        for lut in [SkyLut::Transmittance, SkyLut::Multiscatter, SkyLut::SkyView] {
            let a = bits(&first, lut);
            assert!(a.iter().any(|bits| *bits != 0), "{preset:?} {lut:?} holds something");
            assert_eq!(a, bits(&second, lut), "{preset:?} {lut:?} is a pure function of its inputs");
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_transmittance_lut_dims_towards_the_horizon_and_the_ground() {
    let Some(gpu) = gpu() else { return };
    let sky = baked_sky(&gpu, &SkyParams::default(), &environment(QualityPreset::Low), sun_at(45.0));
    let (width, height) = sky.lut_size(SkyLut::Transmittance).expect("made");
    let texels = sky.read_lut(&gpu, SkyLut::Transmittance).expect("read");
    // Row 0 is the ground; column 0 looks straight up, the last column along the horizon.
    let up = texels[0];
    let along = texels[(width - 1) as usize];
    let high_up = texels[((height - 1) * width) as usize];
    assert!(up.iter().take(3).all(|c| (0.5..=1.0).contains(c)), "straight up from the ground most light passes: {up:?}");
    assert!(up[2] < up[0], "blue is scattered out more than red: {up:?}");
    assert!(along[1] < 0.05 * up[1], "the horizon path is far longer: {along:?} against {up:?}");
    assert!(high_up[1] > up[1], "from the top of the atmosphere nothing is lost: {high_up:?}");
}

/// Every texel of the six faces of a `side`² cube the sky was baked into, as linear rgba.
fn bake_cube(gpu: &Gpu, sky: &SkyState, side: u32) -> Vec<[f32; 4]> {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("sky cube test"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: CUBE_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky cube test") });
    assert!(sky.encode_cube(&gpu.device, &mut encoder, &view, side), "the LUTs are baked");
    let row = side * 8;
    assert_eq!(row % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT, 0, "the test sizes keep rows aligned");
    let bytes = u64::from(row * side * 6);
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sky cube readback"),
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

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_env_cube_baked_from_the_sky_holds_no_sun_disk() {
    let Some(gpu) = gpu() else { return };
    // The largest disk, high in the sky: any of it in the bake would dwarf the sky.
    let sky = SkyParams::default().with_sun_angular_radius_degrees(5.0).with_intensity(2.0);
    let state = baked_sky(&gpu, &sky, &environment(QualityPreset::High), sun_at(60.0));
    let lut = state.read_lut(&gpu, SkyLut::SkyView).expect("read");
    let lut_max = lut.iter().flat_map(|t| t.iter().take(3).copied()).fold(0.0f32, f32::max);
    let cube = bake_cube(&gpu, &state, 64);
    let cube_max = cube.iter().flat_map(|t| t.iter().take(3).copied()).fold(0.0f32, f32::max);
    eprintln!("sky-view max {lut_max}, cube max {cube_max}");
    assert!(cube_max > 0.25 * lut_max, "the cube holds the sky ({cube_max} against {lut_max})");
    assert!(cube_max <= lut_max * 1.001, "no texel above the sky's maximum: {cube_max} > {lut_max}");
    // +Y (face 2) is the sky overhead, -Y (face 3) the lit ground below the horizon.
    let face_mean = |face: usize| {
        let texels = &cube[face * 64 * 64..(face + 1) * 64 * 64];
        texels.iter().map(|t| luminance(*t)).sum::<f32>() / texels.len() as f32
    };
    assert!(face_mean(2) > 0.0 && face_mean(3) > 0.0, "sky above, lit ground below: {} {}", face_mean(2), face_mean(3));
    let up = cube[2 * 64 * 64 + 32 * 64 + 32];
    assert!(up[2] > up[0], "the zenith is blue: {up:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sky_view_lut_follows_the_preset_cadence_and_skips_unchanged_inputs() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::Low);
    assert_eq!((quality.sky_lut, quality.sky_cadence), ((64, 36), 8), "low: 64x36 every 8th frame");
    let sky = SkyParams::default();
    let mut state = baked_sky(&gpu, &sky, &quality, sun_at(30.0));
    let start = state.generation();
    let mut refreshes = Vec::new();
    for frame_index in 1..=16u64 {
        // The sun moves every frame: the LUT follows only on the cadence.
        let sun = sun_at(30.0 + frame_index as f32 * 0.5);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("cadence") });
        let passes = state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(&sky, &quality, frame(sun, frame_index)));
        gpu.queue.submit([encoder.finish()]);
        if passes.compute > 0 {
            refreshes.push(frame_index);
        }
    }
    assert_eq!(refreshes, [8, 16], "every 8th frame");
    assert_eq!(state.generation(), start + 2);
    // A settled capture refreshes whenever the inputs moved, and never when they did not.
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("settle") });
    let moved = state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(&sky, &quality, frame(sun_at(70.0), 17)).forced(true));
    let again = state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, LutRefresh::new(&sky, &quality, frame(sun_at(70.0), 0)).forced(true));
    gpu.queue.submit([encoder.finish()]);
    assert_eq!((moved.compute, again.compute), (1, 0), "settle refreshes a moved sky once");
}

// ---------------------------------------------------------------------------------------------
// Frames through the renderer

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/sky")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

fn pixel(capture: &Capture, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * capture.width() + x) * 4) as usize;
    let p = &capture.bgra()[i..i + 4];
    [p[2], p[1], p[0]]
}

/// The HDR path with the physical sky at `preset`'s sky knobs, everything else off.
fn sky_quality(preset: QualityPreset) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = environment(preset);
    quality.environment.ibl = false;
    quality
}

fn sky_renderer(gpu: &Gpu, preset: QualityPreset, ev: f32, sky: SkyParams) -> Renderer {
    let mut renderer = Renderer::new(gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&sky_quality(preset));
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = ev;
    renderer.set_look(look);
    renderer.set_environment(&Environment::Sky(sky));
    renderer
}

/// A grey ground running to the horizon and a red cube, under a sun `elevation` degrees up ahead.
fn sky_scene(elevation: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.5, 8.0], [0.0, 2.6, 0.0]), [255, 0, 255, 255]);
    scene.lighting.sun_dir = sun_at(elevation);
    scene.lighting.sun_intensity = SUN;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [30.0, 0.2, 30.0]), Material::color([150, 150, 150, 255]));
    scene.draw(MeshId::CUBE, translation(-1.5, 0.5, 2.0), Material::color([220, 40, 50, 255]));
    scene
}

fn render(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene, name: &str) -> Capture {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    let capture = renderer.capture(gpu).expect("capture");
    write_evidence(name, &capture);
    capture
}

/// A capture's mean linear colour's luminance and hue (the showcase's look statistics).
fn mean_look(capture: &Capture) -> (f64, f64) {
    let decode = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let mut sum = [0.0f64; 3];
    for p in capture.bgra().chunks(4) {
        for (channel, value) in [p[2], p[1], p[0]].into_iter().enumerate() {
            sum[channel] += decode(value);
        }
    }
    let count = (capture.bgra().len() / 4) as f64;
    let [r, g, b] = sum.map(|channel| channel / count);
    ((0.2126 * r + 0.7152 * g + 0.0722 * b), (3f64.sqrt() * (g - b)).atan2(2.0 * r - g - b).to_degrees())
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sky_draws_behind_the_scene_at_noon_and_sunset_on_every_preset() {
    let Some(gpu) = gpu() else { return };
    let mut high = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    let noon = render(&mut high, &gpu, &sky_scene(70.0), "noon");
    // The clear colour (magenta) is gone: the sky covers every pixel no geometry did.
    let top = pixel(&noon, WIDTH / 2, 2);
    assert!(top[2] > top[0] && top[2] > top[1], "a blue sky overhead, not the clear colour: {top:?}");
    // The grey ground draws over the sky, lit by the sun through the atmosphere (RQ2 review: a
    // little warm at 70 degrees; was "every channel within 12 of red", a white-lit ground).
    let ground = pixel(&noon, WIDTH - 4, HEIGHT - 4);
    assert!(ground.iter().all(|c| *c > 60) && ground[0] >= ground[1] && ground[1] >= ground[2], "the ground still draws over the sky, sun-warm: {ground:?}");
    assert!(ground[0].abs_diff(ground[2]) <= 24, "a high sun is nearly white: {ground:?}");
    check_golden("noon", &noon);

    // A large disk (2 degrees) so it covers pixels at the golden's size.
    let big_sun = SkyParams::default().with_sun_angular_radius_degrees(2.0);
    let mut dusk = sky_renderer(&gpu, QualityPreset::High, 2.0, big_sun);
    let sunset = render(&mut dusk, &gpu, &sky_scene(1.5), "sunset");
    // Find the sun disk above the ground plane: the brightest sky pixel, ahead of the camera.
    let (mut best, mut at) = (0u32, (0, 0));
    for y in 0..HEIGHT / 2 + 8 {
        for x in 0..WIDTH {
            let [r, g, b] = pixel(&sunset, x, y);
            let sum = u32::from(r) + u32::from(g) + u32::from(b);
            if sum > best {
                (best, at) = (sum, (x, y));
            }
        }
    }
    assert!(best >= 3 * 230, "the sun disk is drawn in the background: brightest {best} at {at:?}");
    assert!((WIDTH / 2).abs_diff(at.0) <= 3, "the disk is ahead of the camera: {at:?}");
    let beside = pixel(&sunset, at.0 + 12, at.1);
    assert!(beside[0] > beside[2], "the sky by the setting sun is warm: {beside:?}");
    check_golden("sunset", &sunset);

    let mut low = sky_renderer(&gpu, QualityPreset::Low, 0.0, SkyParams::default());
    let low_noon = render(&mut low, &gpu, &sky_scene(70.0), "low");
    check_golden("low", &low_noon);
    let (high_y, high_hue) = mean_look(&noon);
    let (low_y, low_hue) = mean_look(&low_noon);
    assert!((low_y - high_y).abs() <= high_y * LOOK_LUMINANCE_SHARE, "low and high share a look: luminance {low_y} against {high_y}");
    assert!((low_hue - high_hue).abs() <= LOOK_HUE_DEGREES, "low and high share a look: hue {low_hue} against {high_hue}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_flat_colour_environment_keeps_the_clear_colour() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    renderer.set_environment(&Environment::Color);
    let frame = render(&mut renderer, &gpu, &sky_scene(70.0), "color");
    let top = pixel(&frame, WIDTH / 2, 2);
    assert!(top[0] > 200 && top[2] > 200 && top[1] < 60, "the clear colour behind the scene: {top:?}");
    // The sky switched off in the quality: the same.
    let mut quality = sky_quality(QualityPreset::High);
    quality.environment.sky = false;
    let mut off = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    off.set_quality(&quality);
    let frame = render(&mut off, &gpu, &sky_scene(70.0), "sky-switch-off");
    assert_eq!(pixel(&frame, WIDTH / 2, 2), top, "no sky without the switch");
}

/// Evidence frames at a reviewable size (no assertions beyond drawing): written only with
/// `GENEX_RENDER_EVIDENCE_DIR` set.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_evidence_frames_of_the_sky_through_the_day() {
    let Some(dir) = std::env::var_os("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let Some(gpu) = gpu() else { return };
    let (width, height) = (640, 360);
    for (name, preset, elevation, ev) in
        [("day-high", QualityPreset::High, 60.0, 0.0), ("day-low", QualityPreset::Low, 60.0, 0.0), ("golden-hour", QualityPreset::High, 8.0, 1.0), ("sunset", QualityPreset::High, 1.0, 2.0), ("dusk", QualityPreset::High, -3.0, 5.0)]
    {
        let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_quality(&sky_quality(preset));
        let mut look = Look::default();
        look.tonemapper = Tonemapper::Agx;
        look.exposure = ExposureMode::Manual;
        look.ev_compensation = ev;
        renderer.set_look(look);
        renderer.set_environment(&Environment::sky());
        renderer.render(&gpu, &sky_scene(elevation), CullPath::Gpu).expect("frame");
        let capture = renderer.capture(&gpu).expect("capture");
        std::fs::write(PathBuf::from(&dir).join(format!("evidence-{name}-{width}x{height}.bgra")), capture.bgra()).expect("evidence");
    }
}

// ---------------------------------------------------------------------------------------------
// Cost

/// GPU milliseconds of `runs` LUT refreshes, each timed by its compute pass's timestamps, sorted.
///
/// The refreshes are submitted back to back, one submission each (as frames are), after
/// `TIMING_WARMUP` untimed ones, and read once at the end: a GPU left idle between tiny
/// submissions drops its clocks, and the first pass after the idle costs about 0.6 ms on the M4
/// Max whatever its size (the 64x36 LUT's tail equalled the 192x108 one's), which is the
/// platform's wake-up, not the sky's work. (A frame's other work recorded before each refresh
/// does not help on Metal: compute passes overlap, so the refresh's timestamps took in the load's
/// tail, 0.31 ms for the 64x36 LUT; RQ2 review.)
fn time_refreshes(gpu: &Gpu, quality: &EnvironmentQuality, refresh_all: bool, runs: usize) -> Vec<f64> {
    time_refreshes_of(gpu, quality, refresh_all, false, runs)
}

/// [`time_refreshes`], at night under a full moon when `night` (B.2: the moonlit sky-view LUT is
/// computed beside the sun's).
fn time_refreshes_of(gpu: &Gpu, quality: &EnvironmentQuality, refresh_all: bool, night: bool, runs: usize) -> Vec<f64> {
    let total = TIMING_WARMUP + runs;
    let stamps_count = 2 * total as u32;
    let bytes = u64::from(stamps_count) * 8;
    let queries = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("sky timing"), ty: wgpu::QueryType::Timestamp, count: stamps_count });
    let resolve = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sky timing"),
        size: bytes,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let read = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sky timing read"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let period = f64::from(gpu.queue.get_timestamp_period());
    let mut sky = SkyParams::default();
    let mut state = SkyState::new();
    for run in 0..total {
        // A moving sun refreshes the sky view; a new ground albedo every LUT.
        if refresh_all {
            sky = sky.with_ground_albedo([0.2 + 0.001 * run as f32, 0.3, 0.3]);
        }
        let sun = if night { sun_at(-20.0 - 0.1 * run as f32) } else { sun_at(20.0 + 0.1 * run as f32) };
        if night {
            sky = sky.with_moon(Some(genex_render::settings::Moon::new(sun.map(|c| -c))));
        }
        let first = 2 * run as u32;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky timing") });
        let writes = wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(first), end_of_pass_write_index: Some(first + 1) };
        let refresh = LutRefresh::new(&sky, quality, frame(sun, 0)).forced(true).timed(writes);
        let passes = state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, refresh);
        assert_eq!(passes.compute, 1, "every timed run refreshes");
        gpu.queue.submit([encoder.finish()]);
    }
    // Metal's counter sample buffers are not hazard-tracked: a resolve recorded before the last
    // refresh finished may read its slots as zero.
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky timing resolve") });
    encoder.resolve_query_set(&queries, 0..stamps_count, &resolve, 0);
    encoder.copy_buffer_to_buffer(&resolve, 0, &read, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    read.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let stamps: Vec<u64> = read.slice(..).get_mapped_range().expect("mapped range").as_chunks::<8>().0.iter().map(|b| u64::from_le_bytes(*b)).collect();
    let mut times: Vec<f64> = stamps.as_chunks::<2>().0[TIMING_WARMUP..].iter().map(|[begin, end]| end.saturating_sub(*begin) as f64 * period / 1.0e6).collect();
    times.sort_by(f64::total_cmp);
    assert!(times.iter().all(|ms| *ms > 0.0), "every refresh was timed: {times:?}");
    times
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// One trial of the cost row: the percentiles of each kind of refresh, GPU ms.
#[derive(Clone, Copy, Debug)]
struct SkyCost {
    high_view: [f64; 2],
    high_all: [f64; 2],
    low_view: [f64; 2],
}

fn sky_cost(gpu: &Gpu, high: &EnvironmentQuality, low: &EnvironmentQuality) -> SkyCost {
    let stats = |times: Vec<f64>| [percentile(&times, 0.5), percentile(&times, 0.95)];
    SkyCost {
        high_view: stats(time_refreshes(gpu, high, false, TIMED_RUNS)),
        high_all: stats(time_refreshes(gpu, high, true, TIMED_RUNS)),
        low_view: stats(time_refreshes(gpu, low, false, TIMED_RUNS)),
    }
}

/// The median of `trials`' values picked by `pick` (the perf gate's median of interleaved runs).
fn median_of(trials: &[SkyCost], pick: impl Fn(&SkyCost) -> f64) -> f64 {
    let mut values: Vec<f64> = trials.iter().map(pick).collect();
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sky_luts_fit_their_budget() {
    let Some(gpu) = gpu_with(wgpu::Features::TIMESTAMP_QUERY) else { return };
    let high = environment(QualityPreset::High);
    let low = environment(QualityPreset::Low);
    let trials: Vec<SkyCost> = (0..TIMED_TRIALS).map(|_| sky_cost(&gpu, &high, &low)).collect();
    let high_view_p95 = median_of(&trials, |cost| cost.high_view[1]);
    let high_all_p50 = median_of(&trials, |cost| cost.high_all[0]);
    let low_amortized = median_of(&trials, |cost| cost.low_view[0]) / f64::from(low.sky_cadence.max(1));
    let low_refresh_p95 = median_of(&trials, |cost| cost.low_view[1]);
    let pair = |[p50, p95]: [f64; 2]| serde_json::json!({ "p50": p50, "p95": p95 });
    let row = serde_json::json!({
        "row": "sky-luts",
        "adapter": gpu.adapter().get_info().name,
        "runs": TIMED_RUNS,
        "warmup": TIMING_WARMUP,
        "trials": trials.iter().map(|cost| serde_json::json!({
            "high_sky_view_ms": pair(cost.high_view),
            "high_all_luts_ms": pair(cost.high_all),
            "low_sky_view_ms": pair(cost.low_view),
        })).collect::<Vec<_>>(),
        "median": { "high_sky_view_p95_ms": high_view_p95, "high_all_luts_p50_ms": high_all_p50, "low_amortized_ms": low_amortized, "low_refresh_p95_ms": low_refresh_p95 },
        "sky_view": { "high": [high.sky_lut.0, high.sky_lut.1], "low": [low.sky_lut.0, low.sky_lut.1] },
        "cadence_low": low.sky_cadence,
        "budget_ms": { "high": HIGH_BUDGET_MS, "low_amortized": LOW_AMORTIZED_BUDGET_MS, "low_refresh_p95": LOW_REFRESH_P95_BUDGET_MS },
        "method": "back-to-back submissions after warm-up; median of trials gated, every trial within the noise band",
    });
    eprintln!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    // The steady state follows the sun (sky view); the full refresh runs when the atmosphere changes.
    assert!(high_view_p95 <= HIGH_BUDGET_MS, "high sky view p95 {high_view_p95:.4} ms (median of {TIMED_TRIALS})");
    assert!(high_all_p50 <= HIGH_BUDGET_MS, "high full refresh p50 {high_all_p50:.4} ms (median of {TIMED_TRIALS})");
    assert!(low_amortized <= LOW_AMORTIZED_BUDGET_MS, "low amortized {low_amortized:.4} ms (median of {TIMED_TRIALS})");
    assert!(low_refresh_p95 <= LOW_REFRESH_P95_BUDGET_MS, "low's refresh frame p95 {low_refresh_p95:.4} ms (median of {TIMED_TRIALS})");
    // Every trial, not only the median: one far over budget is a real spike, not noise.
    let band = 1.0 + TRIAL_NOISE_BAND;
    for (index, cost) in trials.iter().enumerate() {
        let worst = [(cost.high_view[1], "high sky view p95"), (cost.high_all[0], "high full refresh p50"), (cost.low_view[1], "low refresh p95")];
        for (ms, what) in worst {
            assert!(ms <= HIGH_BUDGET_MS * band, "trial {index}: {what} {ms:.4} ms is past the budget's noise band");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// RQ2 review rows

#[test]
fn the_sun_through_the_atmosphere_reddens_as_it_sets_and_ends_below_the_horizon() {
    use genex_render::sky::sun_transmittance;
    let radius = SkyParams::default().sun_angular_radius;
    let noon = sun_transmittance(0.002, sun_at(70.0), radius);
    let golden = sun_transmittance(0.002, sun_at(10.0), radius);
    let sunset = sun_transmittance(0.002, sun_at(3.0), radius);
    for t in [noon, golden, sunset] {
        assert!(t[0] > t[1] && t[1] > t[2], "red passes, blue scatters out: {t:?}");
    }
    assert!(noon.iter().all(|c| (0.7..1.0).contains(c)), "a high sun loses little: {noon:?}");
    assert!(sunset[2] < 0.25 * noon[2] && sunset[0] > 0.3, "a 3 degree sun is red: {sunset:?}");
    assert!(golden[0] > sunset[0] && golden[2] > sunset[2], "lower is dimmer: {golden:?} {sunset:?}");
    assert_eq!(sun_transmittance(0.002, sun_at(-2.0), radius), [0.0; 3], "a sun below the horizon lights nothing");
    let half = sun_transmittance(0.0, sun_at(0.0), radius);
    assert!(half[0] > 0.0 && half[0] < sunset[0], "a sun on the horizon is half hidden: {half:?}");
    let space = sun_transmittance(200.0, sun_at(30.0), radius);
    assert!(space.iter().all(|c| *c > 0.999), "above the atmosphere nothing is lost: {space:?}");
}

/// The transmittance LUT's texel coordinate for `height` km and zenith cosine `mu` (Bruneton's
/// mapping, as `sky_draw.wgsl`'s `sky_transmittance` reads it).
fn transmittance_uv(height: f32, mu: f32) -> (f32, f32) {
    let (bottom, top) = (genex_render::sky::EARTH_RADIUS_KM, genex_render::sky::ATMOSPHERE_TOP_KM);
    let r = bottom + height;
    let horizon = ((top - bottom) * (top + bottom)).sqrt();
    let rho = (height * (2.0 * bottom + height)).max(0.0).sqrt();
    let discriminant = (top - r) * (top + r) + r * r * mu * mu;
    let d = (-r * mu + discriminant.max(0.0).sqrt()).max(0.0);
    let (d_min, d_max) = (top - r, rho + horizon);
    ((d - d_min) / (d_max - d_min).max(1e-6), rho / horizon)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cpu_sun_transmittance_is_the_transmittance_lut() {
    // The surfaces' sun (`sky::sun_transmittance`, CPU) and the sky's (the LUT) are one model.
    let Some(gpu) = gpu() else { return };
    let sky = baked_sky(&gpu, &SkyParams::default(), &environment(QualityPreset::High), sun_at(45.0));
    let (width, height) = sky.lut_size(SkyLut::Transmittance).expect("made");
    let texels = sky.read_lut(&gpu, SkyLut::Transmittance).expect("read");
    let lookup = |u: f32, v: f32| {
        let (x, y) = (u * width as f32 - 0.5, v * height as f32 - 0.5);
        let (x0, y0) = (x.floor().clamp(0.0, (width - 2) as f32), y.floor().clamp(0.0, (height - 2) as f32));
        let (tx, ty) = ((x - x0).clamp(0.0, 1.0), (y - y0).clamp(0.0, 1.0));
        let at = |dx: u32, dy: u32| texels[((y0 as u32 + dy) * width + x0 as u32 + dx) as usize];
        [0, 1, 2].map(|c| {
            let top = at(0, 0)[c] * (1.0 - tx) + at(1, 0)[c] * tx;
            let bottom = at(0, 1)[c] * (1.0 - tx) + at(1, 1)[c] * tx;
            top * (1.0 - ty) + bottom * ty
        })
    };
    for (height_km, elevation) in [(0.002_f32, 70.0_f32), (0.002, 30.0), (0.002, 10.0), (0.5, 20.0), (3.0, 45.0)] {
        let dir = sun_at(elevation);
        let cpu = genex_render::sky::sun_transmittance(height_km, dir, SkyParams::default().sun_angular_radius);
        let (u, v) = transmittance_uv(height_km, dir[1]);
        let lut = lookup(u, v);
        for c in 0..3 {
            assert!((cpu[c] - lut[c]).abs() <= 0.02 * lut[c].max(0.05), "{height_km} km at {elevation} degrees: CPU {cpu:?}, LUT {lut:?}");
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_low_sun_lights_the_ground_as_warm_as_it_colours_the_sky() {
    // Visual review 2: the sky took the sun as light outside the atmosphere and reddened it, the
    // surfaces took it white, so a golden-hour sky stood over white-lit ground.
    let Some(gpu) = gpu() else { return };
    let mut renderer = sky_renderer(&gpu, QualityPreset::High, 3.0, SkyParams::default());
    let frame = render(&mut renderer, &gpu, &sky_scene(3.0), "sunset-ground");
    // The lit grey ground right in front of the camera.
    let ground = pixel(&frame, WIDTH / 2 + 20, HEIGHT - 6);
    assert!(ground[0] > ground[1] + 6 && ground[1] > ground[2] + 6, "a 3 degree sun lights the grey ground warm: {ground:?}");
    let mut noon = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    let lit = pixel(&render(&mut noon, &gpu, &sky_scene(70.0), "noon-ground"), WIDTH / 2 + 20, HEIGHT - 6);
    assert!(lit[2] + 30 > lit[0], "a high sun lights it nearly white: {lit:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_sky_view_resize_makes_no_shader_and_keeps_the_static_luts() {
    // Performance review 1: a dynamic-resolution demotion changes the sky-view LUT's size, which
    // rebuilt every sky module and pipeline and recomputed the static LUTs in the demoted frame.
    let Some(gpu) = gpu() else { return };
    let sky = SkyParams::default();
    let high = environment(QualityPreset::High);
    let mut state = baked_sky(&gpu, &sky, &high, sun_at(45.0));
    assert_eq!(state.builds(), 1);
    let transmittance = state.read_lut(&gpu, SkyLut::Transmittance).expect("read");
    for (index, preset) in [QualityPreset::Medium, QualityPreset::Low, QualityPreset::High].into_iter().enumerate() {
        let quality = environment(preset);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sky resize") });
        let refresh = LutRefresh::new(&sky, &quality, frame(sun_at(45.0), 1 + index as u64)).forced(true);
        state.encode_luts(&gpu.device, &gpu.queue, &mut encoder, refresh);
        gpu.queue.submit([encoder.finish()]);
        assert_eq!(state.lut_size(SkyLut::SkyView), Some(quality.sky_lut), "{preset:?}: the sky-view LUT at the new size");
        assert_eq!(state.builds(), 1, "{preset:?}: no shader module or pipeline made again");
        assert!(state.read_lut(&gpu, SkyLut::Transmittance).expect("read") == transmittance, "{preset:?}: the static LUTs kept");
    }
    let fresh = baked_sky(&gpu, &sky, &high, sun_at(45.0));
    assert!(state.read_lut(&gpu, SkyLut::SkyView).expect("read") == fresh.read_lut(&gpu, SkyLut::SkyView).expect("read"), "back at high: as a fresh sky");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_with_its_backdrop_switched_off_the_sky_still_lights_the_scene() {
    // Contract review: `sky` off with `ibl` on under the physical sky computed no LUTs, baked
    // nothing and bound the neutral (black) environment in place of the flat ambient.
    let Some(gpu) = gpu() else { return };
    let mut quality = sky_quality(QualityPreset::High);
    quality.environment.ibl = true;
    let mut both = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    both.set_quality(&quality);
    let scene = sky_scene(40.0);
    let _ = render(&mut both, &gpu, &scene, "ibl-sky-on");
    let lit = render(&mut both, &gpu, &scene, "ibl-sky-on");
    quality.environment.sky = false;
    let mut backdrop_off = sky_renderer(&gpu, QualityPreset::High, 0.0, SkyParams::default());
    backdrop_off.set_quality(&quality);
    let _ = render(&mut backdrop_off, &gpu, &scene, "ibl-sky-off");
    let off = render(&mut backdrop_off, &gpu, &scene, "ibl-sky-off");
    let clear = pixel(&off, WIDTH / 2, 2);
    assert!(clear[0] > 200 && clear[2] > 200 && clear[1] < 60, "no backdrop: the clear colour {clear:?}");
    // Every pixel of geometry is lit by the sky either way (edge pixels blend the backdrop in).
    let (mut geometry, mut differ) = (0, 0);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let b = pixel(&off, x, y);
            // The clear colour, dithered by the tonemap.
            if b[0] > 200 && b[2] > 200 && b[1] < 60 {
                continue;
            }
            geometry += 1;
            differ += usize::from(pixel(&lit, x, y).iter().zip(b).any(|(p, q)| p.abs_diff(q) > 2));
        }
    }
    assert!(geometry > 1000, "the ground and the cube cover the lower frame: {geometry}");
    assert!(differ * 50 <= geometry, "{differ} of {geometry} geometry pixels differ with the backdrop off");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_under_auto_exposure_the_sky_is_exposed_as_the_geometry_is() {
    // Found by the RQ2 finalizer: the sky's frame uniform carried the CPU pre-exposure (1 under
    // auto exposure) while the geometry was written with the GPU's adapted exposure, so the
    // showcase's sky was drawn several stops too bright and the tonemap bleached it.
    use genex_render::immediate::ImmediateFrame;
    use genex_render::{FrameRenderer, RenderOptions};
    let Some(gpu) = gpu() else { return };
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 1.5, 8.0], [0.0, 1.5, 0.0]), [255, 0, 255, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [30.0, 0.2, 30.0]), Material::color([150, 150, 150, 255]));
    frame.lighting_mut().sun_dir = sun_at(40.0);
    frame.lighting_mut().sun_intensity = 12.0;
    let scene_ratio = |exposure: ExposureMode| {
        let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
        renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
        renderer.renderer_mut().set_quality(&sky_quality(QualityPreset::High));
        let mut look = Look::default();
        look.exposure = exposure;
        look.ev_compensation = 0.0;
        renderer.renderer_mut().set_look(look);
        renderer.renderer_mut().set_environment(&Environment::sky());
        let frames = genex_render::settle::settle_frames(renderer.renderer().quality(), renderer.renderer().look(), true);
        renderer.render_settled(&gpu, &frame, CullPath::Gpu, None, frames).expect("settled");
        let scene = renderer.renderer().read_scene(&gpu).expect("the HDR scene");
        let at = |x: u32, y: u32| luminance(scene[(y * WIDTH + x) as usize]);
        (at(WIDTH / 2, 4), at(WIDTH / 2, HEIGHT - 4))
    };
    let (manual_sky, manual_ground) = scene_ratio(ExposureMode::Manual);
    let (auto_sky, auto_ground) = scene_ratio(ExposureMode::Auto);
    let exposure = auto_ground / manual_ground;
    assert!(exposure < 0.5, "the bright scene meters down: exposure {exposure}");
    let (manual, auto) = (manual_sky / manual_ground, auto_sky / auto_ground);
    assert!((auto / manual - 1.0).abs() < 0.03, "sky over ground: {auto} under auto exposure, {manual} under manual (exposure {exposure})");
}

// ---------------------------------------------------------------------------------------------
// Pass 2 P2-0.11 (SI-15): an f64 reference for the sky-view LUT

/// The atmosphere a LUT was computed from, in f64 (km): the medium of `sky_view.wgsl`.
struct ReferenceSky {
    bottom: f64,
    top: f64,
    rayleigh: [f64; 3],
    rayleigh_falloff: f64,
    mie_scattering: f64,
    mie_extinction: f64,
    mie_g: f64,
    mie_falloff: f64,
    ozone: [f64; 3],
    ozone_centre: f64,
    ozone_width: f64,
    ground_albedo: [f64; 3],
    multiscatter_factor: f64,
    /// The transmittance to the top, by height (rows) and zenith cosine (columns).
    transmittance: Vec<[f64; 3]>,
    /// All scattering orders past the first per unit illuminance, by height and sun cosine.
    multiscatter: Vec<[f64; 3]>,
}

/// Rows and columns of the reference's transmittance table.
const REFERENCE_T_HEIGHTS: usize = 256;
const REFERENCE_T_COSINES: usize = 1024;
/// Midpoint steps of one transmittance integral.
const REFERENCE_T_STEPS: usize = 400;
/// Side of the reference's multiple-scattering table, its gathering directions per side and
/// steps per gathering ray.
const REFERENCE_MS_SIDE: usize = 32;
const REFERENCE_MS_DIRECTIONS: usize = 16;
const REFERENCE_MS_STEPS: usize = 100;
/// Steps along a view ray (quadratic spacing, midpoints).
const REFERENCE_VIEW_STEPS: usize = 2000;

struct Medium {
    rayleigh: [f64; 3],
    mie: f64,
    extinction: [f64; 3],
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn length3(a: [f64; 3]) -> f64 {
    dot3(a, a).sqrt()
}

impl ReferenceSky {
    fn new(row: &genex_render::layout::GpuSkyAtmosphere) -> ReferenceSky {
        let f = |v: f32| f64::from(v);
        let mut sky = ReferenceSky {
            bottom: f(row.radii[0]),
            top: f(row.radii[1]),
            rayleigh: [0, 1, 2].map(|c| f(row.rayleigh[c])),
            rayleigh_falloff: f(row.rayleigh[3]),
            mie_scattering: f(row.mie[0]),
            mie_extinction: f(row.mie[1]),
            mie_g: f(row.mie[2]),
            mie_falloff: f(row.mie[3]),
            ozone: [0, 1, 2].map(|c| f(row.ozone[c])),
            ozone_centre: f(row.radii[2]),
            ozone_width: f(row.radii[3]),
            ground_albedo: [0, 1, 2].map(|c| f(row.ground_albedo[c])),
            multiscatter_factor: f(row.ozone[3]),
            transmittance: Vec::new(),
            multiscatter: Vec::new(),
        };
        sky.transmittance = (0..REFERENCE_T_HEIGHTS * REFERENCE_T_COSINES)
            .map(|index| {
                let height = (sky.top - sky.bottom) * (index / REFERENCE_T_COSINES) as f64 / (REFERENCE_T_HEIGHTS - 1) as f64;
                let mu = -1.0 + 2.0 * (index % REFERENCE_T_COSINES) as f64 / (REFERENCE_T_COSINES - 1) as f64;
                sky.transmittance_exact(height, mu)
            })
            .collect();
        sky.multiscatter = (0..REFERENCE_MS_SIDE * REFERENCE_MS_SIDE)
            .map(|index| {
                let height = (sky.top - sky.bottom) * (index / REFERENCE_MS_SIDE) as f64 / (REFERENCE_MS_SIDE - 1) as f64;
                let sun_cos = -1.0 + 2.0 * (index % REFERENCE_MS_SIDE) as f64 / (REFERENCE_MS_SIDE - 1) as f64;
                sky.multiscatter_exact(height.clamp(0.01, sky.top - sky.bottom - 0.01), sun_cos)
            })
            .collect();
        sky
    }

    fn medium(&self, height: f64) -> Medium {
        let rayleigh_density = (-height * self.rayleigh_falloff).exp();
        let mie_density = (-height * self.mie_falloff).exp();
        let ozone = (1.0 - (height - self.ozone_centre).abs() / (0.5 * self.ozone_width)).max(0.0);
        let rayleigh = self.rayleigh.map(|s| s * rayleigh_density);
        Medium {
            rayleigh,
            mie: self.mie_scattering * mie_density,
            extinction: [0, 1, 2].map(|c| rayleigh[c] + self.mie_extinction * mie_density + self.ozone[c] * ozone),
        }
    }

    /// The distance along unit `dir` from `origin` to the ground, None when it misses.
    fn ground_distance(&self, origin: [f64; 3], dir: [f64; 3]) -> Option<f64> {
        let b = dot3(origin, dir);
        let c = dot3(origin, origin) - self.bottom * self.bottom;
        let discriminant = b * b - c;
        (b <= 0.0 && discriminant >= 0.0).then(|| (-b - discriminant.sqrt()).max(0.0))
    }

    /// The distance along unit `dir` from `origin` inside the atmosphere to its top.
    fn top_distance(&self, origin: [f64; 3], dir: [f64; 3]) -> f64 {
        let b = dot3(origin, dir);
        let c = dot3(origin, origin) - self.top * self.top;
        (-b + (b * b - c).max(0.0).sqrt()).max(0.0)
    }

    /// The transmittance from `height` along zenith cosine `mu` to the top, by a midpoint integral.
    fn transmittance_exact(&self, height: f64, mu: f64) -> [f64; 3] {
        let origin = [0.0, self.bottom + height, 0.0];
        let dir = [(1.0 - mu * mu).max(0.0).sqrt(), mu, 0.0];
        let reach = self.top_distance(origin, dir);
        let dt = reach / REFERENCE_T_STEPS as f64;
        let mut depth = [0.0; 3];
        for i in 0..REFERENCE_T_STEPS {
            let t = (i as f64 + 0.5) * dt;
            let p = [dir[0] * t, origin[1] + dir[1] * t, 0.0];
            let medium = self.medium((length3(p) - self.bottom).max(0.0));
            for (total, extinction) in depth.iter_mut().zip(medium.extinction) {
                *total += extinction * dt;
            }
        }
        depth.map(|d| (-d).exp())
    }

    /// The tabled transmittance (bilinear in height and cosine).
    fn transmittance(&self, height: f64, mu: f64) -> [f64; 3] {
        let y = (height / (self.top - self.bottom)).clamp(0.0, 1.0) * (REFERENCE_T_HEIGHTS - 1) as f64;
        let x = ((mu + 1.0) * 0.5).clamp(0.0, 1.0) * (REFERENCE_T_COSINES - 1) as f64;
        bilinear(&self.transmittance, REFERENCE_T_COSINES, REFERENCE_T_HEIGHTS, x, y)
    }

    /// The tabled multiple scattering (bilinear in height and sun cosine).
    fn multiscatter(&self, height: f64, sun_cos: f64) -> [f64; 3] {
        let y = (height / (self.top - self.bottom)).clamp(0.0, 1.0) * (REFERENCE_MS_SIDE - 1) as f64;
        let x = ((sun_cos + 1.0) * 0.5).clamp(0.0, 1.0) * (REFERENCE_MS_SIDE - 1) as f64;
        bilinear(&self.multiscatter, REFERENCE_MS_SIDE, REFERENCE_MS_SIDE, x, y)
    }

    /// Hillaire's isotropic multiple-scattering estimate at `height` with the sun at `sun_cos`: the
    /// second order gathered over the sphere with the lit ground, summed over every order as
    /// 1 / (1 - f_ms), times the multiple-scattering factor.
    fn multiscatter_exact(&self, height: f64, sun_cos: f64) -> [f64; 3] {
        let origin = [0.0, self.bottom + height, 0.0];
        let sun = [(1.0 - sun_cos * sun_cos).max(0.0).sqrt(), sun_cos, 0.0];
        let isotropic = 1.0 / (4.0 * core::f64::consts::PI);
        let (mut light, mut transfer) = ([0.0; 3], [0.0; 3]);
        let n = REFERENCE_MS_DIRECTIONS;
        for k in 0..n * n {
            let azimuth = 2.0 * core::f64::consts::PI * ((k % n) as f64 + 0.5) / n as f64;
            let cos_polar = 1.0 - 2.0 * ((k / n) as f64 + 0.5) / n as f64;
            let sin_polar = (1.0 - cos_polar * cos_polar).max(0.0).sqrt();
            let dir = [azimuth.cos() * sin_polar, cos_polar, azimuth.sin() * sin_polar];
            let ground = self.ground_distance(origin, dir);
            let reach = ground.unwrap_or_else(|| self.top_distance(origin, dir));
            let mut throughput = [1.0_f64; 3];
            for i in 0..REFERENCE_MS_STEPS {
                let (t0, t1) = (reach * i as f64 / REFERENCE_MS_STEPS as f64, reach * (i + 1) as f64 / REFERENCE_MS_STEPS as f64);
                let dt = t1 - t0;
                let p = [0, 1, 2].map(|c| origin[c] + (t0 + 0.5 * dt) * dir[c]);
                let r = length3(p);
                let sample_height = (r - self.bottom).max(0.0);
                let medium = self.medium(sample_height);
                let lit = if self.ground_distance(p, sun).is_some() { 0.0 } else { 1.0 };
                let sun_t = self.transmittance(sample_height, dot3(sun, p) / r);
                for c in 0..3 {
                    let scattering = medium.rayleigh[c] + medium.mie;
                    let step = (-medium.extinction[c] * dt).exp();
                    let integral = (1.0 - step) / medium.extinction[c].max(1e-12);
                    light[c] += throughput[c] * lit * sun_t[c] * scattering * isotropic * integral;
                    transfer[c] += throughput[c] * scattering * integral;
                    throughput[c] *= step;
                }
            }
            if let Some(t) = ground {
                let p = [0, 1, 2].map(|c| origin[c] + t * dir[c]);
                let mu = dot3(sun, p) / length3(p);
                let sun_t = self.transmittance(0.0, mu);
                for c in 0..3 {
                    light[c] += throughput[c] * sun_t[c] * mu.max(0.0) * self.ground_albedo[c] / core::f64::consts::PI;
                }
            }
        }
        let count = (n * n) as f64;
        [0, 1, 2].map(|c| light[c] / count / (1.0 - transfer[c] / count).max(1e-4) * self.multiscatter_factor)
    }

    /// The radiance per unit sun illuminance reaching a camera `height` km up along unit `dir`
    /// with the sun towards unit `sun`, the disk excluded (`sky_integrate`, integrated finely).
    fn radiance(&self, height: f64, dir: [f64; 3], sun: [f64; 3]) -> [f64; 3] {
        let origin = [0.0, self.bottom + height, 0.0];
        let ground = self.ground_distance(origin, dir);
        let reach = ground.unwrap_or_else(|| self.top_distance(origin, dir)).min(9000.0);
        let cos_theta = dot3(dir, sun);
        let rayleigh_phase = 3.0 / (16.0 * core::f64::consts::PI) * (1.0 + cos_theta * cos_theta);
        let g = self.mie_g;
        let mie_phase = 3.0 / (8.0 * core::f64::consts::PI) * (1.0 - g * g) / (2.0 + g * g) * (1.0 + cos_theta * cos_theta) / (1.0 + g * g - 2.0 * g * cos_theta).max(1e-12).powf(1.5);
        let (mut radiance, mut throughput) = ([0.0; 3], [1.0_f64; 3]);
        let steps = REFERENCE_VIEW_STEPS as f64;
        for i in 0..REFERENCE_VIEW_STEPS {
            let (t0, t1) = (reach * (i as f64 / steps).powi(2), reach * ((i + 1) as f64 / steps).powi(2));
            let dt = t1 - t0;
            let p = [0, 1, 2].map(|c| origin[c] + (t0 + 0.5 * dt) * dir[c]);
            let r = length3(p);
            let sample_height = (r - self.bottom).max(0.0);
            let sun_cos = dot3(sun, p) / r;
            let medium = self.medium(sample_height);
            let lit = if self.ground_distance(p, sun).is_some() { 0.0 } else { 1.0 };
            let sun_t = self.transmittance(sample_height, sun_cos);
            let multiple = self.multiscatter(sample_height, sun_cos);
            for c in 0..3 {
                let single = lit * sun_t[c] * (medium.rayleigh[c] * rayleigh_phase + medium.mie * mie_phase);
                let source = single + multiple[c] * (medium.rayleigh[c] + medium.mie);
                let step = (-medium.extinction[c] * dt).exp();
                radiance[c] += throughput[c] * source * (1.0 - step) / medium.extinction[c].max(1e-12);
                throughput[c] *= step;
            }
        }
        if let Some(t) = ground {
            let p = [0, 1, 2].map(|c| origin[c] + t * dir[c]);
            let mu = dot3(sun, p) / length3(p);
            let sun_t = self.transmittance(0.0, mu);
            for c in 0..3 {
                radiance[c] += throughput[c] * sun_t[c] * mu.max(0.0) * self.ground_albedo[c] / core::f64::consts::PI;
            }
        }
        radiance
    }
}

/// `table` (`width` × `height`, rows of `width`) at fractional texel `(x, y)`, bilinear.
fn bilinear(table: &[[f64; 3]], width: usize, height: usize, x: f64, y: f64) -> [f64; 3] {
    let (x0, y0) = ((x.floor() as usize).min(width - 1), (y.floor() as usize).min(height - 1));
    let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
    let (fx, fy) = (x - x0 as f64, y - y0 as f64);
    let at = |x: usize, y: usize| table[y * width + x];
    [0, 1, 2].map(|c| {
        let top = at(x0, y0)[c] * (1.0 - fx) + at(x1, y0)[c] * fx;
        let bottom = at(x0, y1)[c] * (1.0 - fx) + at(x1, y1)[c] * fx;
        top * (1.0 - fy) + bottom * fy
    })
}

/// The view direction and sun of sky-view texel `(x, y)` of a `width` × `height` LUT at `height_km`
/// for a sun at zenith cosine `sun_cos` (`cs_sky_view`'s parameterisation).
fn sky_view_texel_rays(sky: &ReferenceSky, (x, y): (u32, u32), (width, height): (u32, u32), height_km: f64, sun_cos: f64) -> ([f64; 3], [f64; 3]) {
    let unit = [f64::from(x) / f64::from(width.max(2) - 1), f64::from(y) / f64::from(height.max(2) - 1)];
    let tangent = (height_km * (2.0 * sky.bottom + height_km)).sqrt();
    let beta = (tangent / (sky.bottom + height_km)).clamp(-1.0, 1.0).acos();
    let horizon = core::f64::consts::PI - beta;
    let zenith = if unit[1] < 0.5 {
        let coord = 1.0 - 2.0 * unit[1];
        horizon * (1.0 - coord * coord)
    } else {
        let coord = unit[1] * 2.0 - 1.0;
        horizon + beta * coord * coord
    };
    let light_view_cos = 1.0 - 2.0 * unit[0] * unit[0];
    let dir = [zenith.sin() * light_view_cos, zenith.cos(), zenith.sin() * (1.0 - light_view_cos * light_view_cos).max(0.0).sqrt()];
    let sun = [(1.0 - sun_cos * sun_cos).max(0.0).sqrt(), sun_cos, 0.0];
    (dir, sun)
}

/// A compared sky-view texel: where, the LUT's value and the reference's.
type Compared = ((u32, u32), [f32; 4], [f64; 3]);

/// The share by which a sky-view LUT texel may differ from the f64 reference (SI-15).
const SKY_VIEW_REFERENCE_TOLERANCE: f64 = 0.03;
/// The share of the brightest reference value a dimmer channel's error is measured against.
const SKY_VIEW_DIM_FLOOR: f64 = 0.01;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_sky_view_lut_holds_the_f64_reference_within_three_percent() {
    // SI-15: the sky's rows were qualitative only ("bluer overhead", "reddens"). The sky-view LUT
    // (30 steps over LUT transmittance and multiple scattering) against Hillaire's integral in f64
    // (2000 steps, transmittance and multiple scattering integrated finely), at a high noon-ish
    // sun and a low one, over the sky, at the horizon band's edges and below it.
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let params = SkyParams::default();
    let mut failures = Vec::new();
    let mut worst = 0.0_f64;
    for elevation in [45.0_f32, 5.0] {
        let sun_dir = sun_at(elevation);
        let state = baked_sky(&gpu, &params, &quality, sun_dir);
        let row = genex_render::sky::atmosphere(&params, &quality, &frame(sun_dir, 0));
        let reference = ReferenceSky::new(&row);
        let (width, height) = state.lut_size(SkyLut::SkyView).expect("made");
        let texels = state.read_lut(&gpu, SkyLut::SkyView).expect("read");
        let height_km = f64::from(row.ground_albedo[3]).clamp(0.001, reference.top - reference.bottom - 0.01);
        let scale = [0, 1, 2].map(|c| f64::from(row.sun_illuminance[c] * row.sun_illuminance[3]));
        let rows = [0, height / 8, height / 4, height * 3 / 8, height / 2 - 3, height / 2 + 3, height * 5 / 8, height * 7 / 8, height - 1];
        let columns = [0, width / 4, width / 2, width * 3 / 4, width - 1];
        let compared: Vec<Compared> = rows
            .iter()
            .flat_map(|y| columns.map(|x| (x, *y)))
            .map(|(x, y)| {
                let (dir, sun) = sky_view_texel_rays(&reference, (x, y), (width, height), height_km, f64::from(sun_dir[1]));
                let want = reference.radiance(height_km, dir, sun);
                ((x, y), texels[(y * width + x) as usize], [0, 1, 2].map(|c| want[c] * scale[c]))
            })
            .collect();
        // A channel far dimmer than the sky (the ground at a low sun) is held to a share of the
        // brightest reference value instead of its own.
        let floor = SKY_VIEW_DIM_FLOOR * compared.iter().flat_map(|(_, _, want)| *want).fold(0.0, f64::max);
        for ((x, y), got, want) in compared {
            for c in 0..3 {
                let error = (f64::from(got[c]) - want[c]).abs() / want[c].max(floor);
                worst = worst.max(error);
                if error > SKY_VIEW_REFERENCE_TOLERANCE {
                    failures.push(format!("sun {elevation} texel ({x}, {y}) channel {c}: LUT {} reference {:.5} ({:.1}%)", got[c], want[c], 100.0 * error));
                }
            }
        }
    }
    eprintln!("sky-view LUT against the f64 reference: worst {:.2}%; {} texel channels over {:.0}%", 100.0 * worst, failures.len(), 100.0 * SKY_VIEW_REFERENCE_TOLERANCE);
    for failure in &failures {
        eprintln!("  {failure}");
    }
    assert!(failures.is_empty(), "{} sky-view texel channels are over the tolerance", failures.len());
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2 B.2: the night sky (stars, a moon with its phase, the moonlit sky) and
// data-driven media

/// Towards `elevation` degrees up at `azimuth` degrees from -Z (the cameras' forward) towards +X.
fn towards(elevation: f32, azimuth: f32) -> [f32; 3] {
    let (e, a) = (elevation.to_radians(), azimuth.to_radians());
    [libm::cosf(e) * libm::sinf(a), libm::sinf(e), -libm::cosf(e) * libm::cosf(a)]
}

/// A night: the sun 30 degrees under the horizon behind the camera.
fn night_sun() -> [f32; 3] {
    towards(-30.0, 180.0)
}

/// `sky` drawn at `width`x`height` over the sky scene's ground with the sun towards `sun`, at a
/// manual `ev`, the AgX curve.
fn night_frame(gpu: &Gpu, (width, height): (u32, u32), sky: SkyParams, sun: [f32; 3], ev: f32) -> Capture {
    let mut renderer = Renderer::new(gpu, width, height).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&sky_quality(QualityPreset::High));
    let mut look = Look::default();
    look.tonemapper = Tonemapper::Agx;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = ev;
    renderer.set_look(look);
    renderer.set_environment(&Environment::Sky(sky));
    let mut scene = sky_scene(0.0);
    scene.lighting.sun_dir = sun;
    renderer.render(gpu, &scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

fn pixel_sum(capture: &Capture, x: u32, y: u32) -> u32 {
    pixel(capture, x, y).iter().map(|c| u32::from(*c)).sum()
}

/// Sky pixels (in rows `rows`) brighter than every one of their eight neighbours by `margin` (sum
/// of channels): points of light.
fn points_of_light(capture: &Capture, rows: std::ops::Range<u32>, margin: u32) -> usize {
    let mut count = 0;
    for y in rows.start.max(1)..rows.end.min(capture.height() - 1) {
        for x in 1..capture.width() - 1 {
            let centre = pixel_sum(capture, x, y);
            let around = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
                .iter()
                .map(|(dx, dy)| pixel_sum(capture, x.wrapping_add_signed(*dx), y.wrapping_add_signed(*dy)))
                .max()
                .unwrap_or(0);
            if centre >= around + margin {
                count += 1;
            }
        }
    }
    count
}

fn write_named_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_night_sky_draws_stars_and_a_moon_and_the_day_sky_neither() {
    let Some(gpu) = gpu() else { return };
    let size = (640, 360);
    // A full moon ahead, 18 degrees up (the sun under the horizon behind the camera).
    let moon = genex_render::settings::Moon::new(towards(18.0, 10.0)).with_angular_radius_degrees(1.0);
    let night = night_frame(&gpu, size, SkyParams::default().with_moon(Some(moon)), night_sun(), 7.0);
    write_named_evidence("b2-night", &night);
    let stars = points_of_light(&night, 0..size.1 / 3, 24);
    eprintln!("night: {stars} points of light in the upper third");
    assert!(stars >= 20, "a starry night: {stars} points of light in the upper third");
    // The moon is the brightest thing in the sky, ahead and up.
    let (mut best, mut at) = (0, (0, 0));
    for y in 0..size.1 / 2 {
        for x in 0..size.0 {
            let sum = pixel_sum(&night, x, y);
            if sum > best {
                (best, at) = (sum, (x, y));
            }
        }
    }
    assert!(best >= 3 * 200, "the full moon is bright at night: {best} at {at:?}");
    assert!(at.0 > size.0 / 2 && at.0 < size.0 / 2 + 80, "the moon is ahead, a little right: {at:?}");
    // Without stars or a moon the same night is an even dark sky.
    let empty = night_frame(&gpu, size, SkyParams::default().with_stars(0.0), night_sun(), 7.0);
    assert_eq!(points_of_light(&empty, 0..size.1 / 3, 24), 0, "no stars, no points of light");
    // By day nothing of the night draws: the default stars change no byte.
    let day = night_frame(&gpu, size, SkyParams::default(), towards(40.0, 180.0), 0.0);
    let day_without = night_frame(&gpu, size, SkyParams::default().with_stars(0.0), towards(40.0, 180.0), 0.0);
    assert!(day.bgra() == day_without.bgra(), "stars never draw by day");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_moon_s_lit_side_faces_the_sun() {
    let Some(gpu) = gpu() else { return };
    let size = (640, 360);
    // A big moon straight ahead, the sun under the horizon off to the right: a half moon lit on
    // its right.
    let moon = genex_render::settings::Moon::new(towards(15.0, 0.0)).with_angular_radius_degrees(3.0);
    let sun = towards(-20.0, 90.0);
    let frame = night_frame(&gpu, size, SkyParams::default().with_moon(Some(moon)).with_stars(0.0), sun, 6.0);
    write_named_evidence("b2-half-moon", &frame);
    let (mut best, mut at) = (0, (0, 0));
    for y in 0..size.1 / 2 {
        for x in 0..size.0 {
            let sum = pixel_sum(&frame, x, y);
            if sum > best {
                (best, at) = (sum, (x, y));
            }
        }
    }
    // The disk is about 36 pixels across, centred at the middle column.
    let (centre_x, y) = (size.0 / 2, at.1);
    let (left, right) = (pixel_sum(&frame, centre_x - 10, y), pixel_sum(&frame, centre_x + 10, y));
    eprintln!("half moon: brightest {best} at {at:?}, left {left}, right {right}");
    assert!(at.0 > centre_x, "the brightest part of the disk faces the sun: {at:?}");
    assert!(right > left + 60, "the lit side is the sun's: right {right} against left {left}");
    assert!(left > 0, "earthshine: the dark side is not black: {left}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_env_cube_at_night_holds_the_moonlit_sky_and_the_stars_but_no_moon_disk() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let face_mean = |cube: &[[f32; 4]], face: usize| {
        let texels = &cube[face * 64 * 64..(face + 1) * 64 * 64];
        texels.iter().map(|t| luminance(*t)).sum::<f32>() / texels.len() as f32
    };
    let dark = SkyParams::default().with_stars(0.0);
    let dark_cube = bake_cube(&gpu, &baked_sky(&gpu, &dark, &quality, night_sun()), 64);
    let moon = genex_render::settings::Moon::new(towards(30.0, 0.0));
    let moonlit = SkyParams::default().with_moon(Some(moon)).with_stars(0.0);
    let moonlit_cube = bake_cube(&gpu, &baked_sky(&gpu, &moonlit, &quality, night_sun()), 64);
    let starry = SkyParams::default();
    let starry_cube = bake_cube(&gpu, &baked_sky(&gpu, &starry, &quality, night_sun()), 64);
    let (dark_up, moonlit_up, starry_up) = (face_mean(&dark_cube, 2), face_mean(&moonlit_cube, 2), face_mean(&starry_cube, 2));
    eprintln!("cube +Y mean: dark {dark_up}, moonlit {moonlit_up}, starry {starry_up}");
    assert!(moonlit_up > 10.0 * dark_up.max(1e-9) && moonlit_up > 1e-5, "the moonlit sky lights the cube: {moonlit_up} against {dark_up}");
    assert!(starry_up > dark_up + 0.5 * genex_render::night_sky::DEFAULT_STARS, "the stars reach the cube: {starry_up} against {dark_up}");
    // The disk is the analytic light's (as the sun's): the cube holds the sky it lights, not it.
    let moonlit_max = moonlit_cube.iter().map(|t| luminance(*t)).fold(0.0f32, f32::max);
    let disk = genex_render::night_sky::MOON_ALBEDO * SUN / std::f32::consts::PI;
    assert!(moonlit_max < 0.1 * disk, "no moon disk in the cube: max {moonlit_max} against the disk's {disk}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_mars_medium_turns_the_noon_sky_butterscotch() {
    let Some(gpu) = gpu() else { return };
    let quality = environment(QualityPreset::High);
    let zenith = |sky: &SkyParams| {
        let state = baked_sky(&gpu, sky, &quality, sun_at(60.0));
        let lut = state.read_lut(&gpu, SkyLut::SkyView).expect("read");
        let (width, _) = state.lut_size(SkyLut::SkyView).expect("made");
        row_mean(&lut, width, 1, 0..width)
    };
    let earth = zenith(&SkyParams::default());
    let mars = zenith(&SkyParams::default().with_medium(genex_render::settings::SkyMedium::mars()));
    eprintln!("zenith: earth {earth:?}, mars {mars:?}");
    assert!(earth[2] > earth[0], "Earth's zenith is blue: {earth:?}");
    assert!(mars[0] > mars[2] && mars[1] > mars[2], "Mars's zenith is butterscotch: {mars:?}");
}

#[test]
fn the_night_sky_s_uniform_has_one_layout_in_every_sky_shader() {
    use naga::proc::Layouter;
    for (name, source) in [("sky-draw", genex_render::shaders::SKY_DRAW), ("sky-view", genex_render::shaders::SKY_VIEW)] {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        let mut layouter = Layouter::default();
        layouter.update(module.to_ctx()).expect("layout");
        let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("NightSky")).unwrap_or_else(|| panic!("{name} declares NightSky"));
        assert_eq!(layouter[handle].size as usize, size_of::<genex_render::night_sky::GpuNightSky>(), "NightSky in {name}");
    }
}

#[test]
fn the_ground_light_hands_over_from_the_sun_to_the_moon_without_a_jump() {
    use genex_render::night_sky::ground_light;
    let luminance3 = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let sky = SkyParams::default();
    let moon_sky = |sun: [f32; 3]| sky.with_moon(Some(genex_render::settings::Moon::new(sun.map(|c| -c))));
    // The sun from 10 degrees up to 20 under, in 0.05 degree steps, a full moon opposite it. The
    // sun's own light falls steeply as its disk sets (physical: the sky's light carries the dusk);
    // the hand-over adds no step of its own and leaves the moon's light as the floor.
    let start = luminance3(ground_light(&moon_sky(towards(10.0, 0.0)), 0.002, towards(10.0, 0.0), [SUN; 3]).1);
    let mut previous = start;
    let mut worst_step = 0.0f32;
    let mut handed_over = false;
    for step in 1..=600 {
        let sun = towards(10.0 - step as f32 * 0.05, 0.0);
        let (dir, color) = ground_light(&moon_sky(sun), 0.002, sun, [SUN; 3]);
        let light = luminance3(color);
        assert!(light > 0.0, "a full moon keeps the night lit at step {step}");
        handed_over |= dir != sun;
        worst_step = worst_step.max((light - previous).abs() / start);
        previous = light;
    }
    assert!(handed_over, "the moon lights the ground once the sun is down");
    assert!(worst_step < 0.02, "the light never jumps: worst step {worst_step} of the 10-degree sun's");
    let full_moon = genex_render::night_sky::DEFAULT_MOONLIGHT * SUN;
    assert!(previous > 0.3 * full_moon && previous < full_moon, "the moon's light through the air is the night's floor: {previous} against {full_moon}");
    let (_, without) = ground_light(&sky, 0.002, towards(-20.0, 0.0), [SUN; 3]);
    assert_eq!(without, [0.0; 3], "no moon: the night is dark");
    let (dir, day) = ground_light(&moon_sky(towards(40.0, 0.0)), 0.002, towards(40.0, 0.0), [SUN; 3]);
    let sun_alone = genex_render::sky::sun_transmittance(0.002, towards(40.0, 0.0), sky.sun_angular_radius).map(|t| t * SUN);
    assert_eq!((dir, day), (towards(40.0, 0.0), sun_alone), "by day the sun, exactly as before");
}

#[test]
fn earth_as_a_medium_is_the_atmosphere_row_bit_for_bit() {
    let mut quality = Quality::off().environment;
    quality.sky = true;
    quality.sky_lut = (96, 54);
    let row = genex_render::sky::atmosphere(&SkyParams::default(), &quality, &frame(sun_at(30.0), 0));
    let explicit = genex_render::sky::atmosphere(&SkyParams::default().with_medium(genex_render::settings::SkyMedium::earth()), &quality, &frame(sun_at(30.0), 0));
    assert_eq!(bytemuck::bytes_of(&row), bytemuck::bytes_of(&explicit));
    assert_eq!(row.rayleigh, [5.802e-3, 13.558e-3, 33.1e-3, 1.0 / 8.0], "Earth's Rayleigh term as before");
    assert_eq!(row.mie, [3.996e-3, 4.440e-3, 0.8, 1.0 / 1.2], "Earth's Mie term as before");
    let mars = genex_render::sky::atmosphere(&SkyParams::default().with_medium(genex_render::settings::SkyMedium::mars()), &quality, &frame(sun_at(30.0), 0));
    assert!(mars.radii[0] < 4000.0 && mars.mie[0] > 5.0 * row.mie[0], "Mars: a smaller planet, a dustier sky");
    let hostile = genex_render::settings::SkyMedium::earth().with_planet(f32::NAN, -5.0).with_mie(3.996e-3, 0.0, 1.0, 1.2);
    let held = SkyParams::default().with_medium(hostile).medium;
    assert_eq!(held.planet_radius_km, genex_render::sky::EARTH_RADIUS_KM, "NaN: Earth's");
    assert!(held.mie_extinction >= held.mie_scattering && held.mie_asymmetry < 1.0 && held.atmosphere_height_km >= 1.0, "held to what the LUTs take: {held:?}");
}

/// The displayed frame's mean linear luminance (sRGB decoded).
fn displayed_luminance(capture: &Capture) -> f64 {
    mean_look(capture).0
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_day_to_night_sweep_under_auto_exposure_has_no_jump_and_ends_moonlit_and_dark() {
    use genex_render::settings::{CompensationCurve, Moon};
    let Some(gpu) = gpu() else { return };
    let (width, height) = (160, 90);
    let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mut quality = sky_quality(QualityPreset::High);
    quality.environment.ibl = true;
    renderer.set_quality(&quality);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::Agx;
    look.exposure = ExposureMode::Auto;
    // C4: a night meters several stops down and keeps part of its darkness.
    look.compensation_curve = CompensationCurve::new(&[(-8.0, -3.0), (-2.0, -1.0), (2.0, 0.0)]);
    renderer.set_look(look);
    let mut means = Vec::new();
    let mut day = 0.0;
    // The sun from 12 degrees up to 12 under at a game's pace (a 12-minute day: 0.5 degrees a
    // second, 1/60 s a frame), a full moon opposite it, then the night held while the exposure
    // settles.
    let sweep: Vec<f32> = (0..=2880).map(|step| 12.0 - step as f32 * (0.5 / 60.0)).chain(std::iter::repeat_n(-12.0, 300)).collect();
    for (frame_index, elevation) in sweep.iter().enumerate() {
        let sun = towards(*elevation, 0.0);
        let sky = SkyParams::default().with_moon(Some(Moon::new(sun.map(|c| -c))));
        renderer.set_environment(&Environment::Sky(sky));
        let mut scene = sky_scene(0.0);
        scene.lighting.sun_dir = sun;
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let capture = renderer.capture(&gpu).expect("capture");
        let mean = displayed_luminance(&capture);
        if frame_index == 0 {
            day = mean;
        }
        if frame_index == sweep.len() - 1 {
            write_named_evidence("b2-sweep-night", &capture);
        }
        means.push(mean);
    }
    let worst = means.windows(2).map(|pair| (pair[1].max(1e-6) / pair[0].max(1e-6)).log2().abs()).fold(0.0f64, f64::max);
    let night = *means.last().expect("frames");
    eprintln!("sweep: day {day}, night {night}, worst step {worst} EV");
    assert!(worst < 0.1, "no exposure jump through the sweep: worst {worst} EV in one frame");
    assert!(night < 0.5 * day, "the night stays darker than the day: {night} against {day}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_moon_lights_the_night_ground() {
    // The renderer lights the surfaces with `night_sky::ground_light` (the sun, or once it has set
    // the moon): a full moon 40 degrees up lights the grey ground as its light through the air
    // says, the moonlit sky's ambient aside.
    use genex_render::settings::Moon;
    let Some(gpu) = gpu() else { return };
    let ground = |sky: SkyParams| {
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_quality(&sky_quality(QualityPreset::High));
        renderer.set_environment(&Environment::Sky(sky));
        let mut scene = sky_scene(0.0);
        scene.lighting.sun_dir = night_sun();
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let hdr = renderer.read_scene(&gpu).expect("the HDR scene");
        luminance(hdr[((HEIGHT - 4) * WIDTH + WIDTH - 4) as usize])
    };
    let moon = Moon::new(towards(40.0, 0.0));
    let lit = ground(SkyParams::default().with_moon(Some(moon)));
    let dark = ground(SkyParams::default());
    let (_, light) = genex_render::night_sky::ground_light(&SkyParams::default().with_moon(Some(moon)), 0.0015, night_sun(), [SUN; 3]);
    // The ground's grey (150 of 255 in sRGB) under the light at 40 degrees, Lambert.
    let albedo = 0.3049;
    let expected = (0.2126 * light[0] + 0.7152 * light[1] + 0.0722 * light[2]) * libm::sinf(40f32.to_radians()) * albedo / std::f32::consts::PI;
    eprintln!("night ground: moonlit {lit}, moonless {dark}, the moon's direct light alone {expected}");
    assert!(lit - dark > 0.5 * expected, "the moon lights the ground directly: {lit} over {dark}, expected about {expected} more");
}

/// B.2's night may cost the background this much more than the day's at 1080p (stars and the moon
/// per pixel), M4 Max.
const NIGHT_DRAW_EXTRA_BUDGET_MS: f64 = 0.1;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_night_sky_fits_the_sky_budget() {
    let Some(gpu) = gpu_with(wgpu::Features::TIMESTAMP_QUERY) else { return };
    let high = environment(QualityPreset::High);
    let p = |times: &[f64]| [percentile(times, 0.5), percentile(times, 0.95)];
    let night_luts = p(&time_refreshes_of(&gpu, &high, false, true, TIMED_RUNS));
    let day_luts = p(&time_refreshes_of(&gpu, &high, false, false, TIMED_RUNS));
    let moon = genex_render::settings::Moon::new(towards(30.0, 0.0));
    // Trials of the day's and the night's draws interleaved frame by frame (B.5's interleaved cost
    // helper: other work on a shared GPU then weighs on both alike), each trial's own difference,
    // the median of them gated.
    let skies = [(SkyParams::default(), towards(40.0, 180.0)), (SkyParams::default().with_moon(Some(moon)), night_sun())];
    let mut pairs: Vec<([f64; 2], [f64; 2])> = (0..TIMED_TRIALS)
        .map(|_| {
            let times = genex_render::sky::background_gpu_ms_interleaved(&gpu, &skies, &high, (1920, 1080), TIMED_RUNS).expect("drawn").expect("timestamps");
            (p(&times[0]), p(&times[1]))
        })
        .collect();
    pairs.sort_by(|a, b| (a.1[0] - a.0[0]).total_cmp(&(b.1[0] - b.0[0])));
    let (day_draw, night_draw) = pairs[pairs.len() / 2];
    let row = serde_json::json!({
        "row": "sky-night",
        "adapter": gpu.adapter().get_info().name,
        "runs": TIMED_RUNS,
        "luts_ms": { "day": day_luts, "night": night_luts },
        "background_1080p_ms": { "day": day_draw, "night": night_draw },
        "budget_ms": { "luts_p95": HIGH_BUDGET_MS, "night_background_extra": NIGHT_DRAW_EXTRA_BUDGET_MS },
    });
    eprintln!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(night_luts[1] <= HIGH_BUDGET_MS, "the night's LUTs (the moonlit one too) p95 {:.4} ms", night_luts[1]);
    assert!(night_draw[0] <= day_draw[0] + NIGHT_DRAW_EXTRA_BUDGET_MS, "the night's background p50 {:.4} ms against the day's {:.4}", night_draw[0], day_draw[0]);
}
