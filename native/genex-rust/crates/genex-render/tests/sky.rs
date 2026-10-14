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
        let sun = sun_at(20.0 + 0.1 * run as f32);
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
