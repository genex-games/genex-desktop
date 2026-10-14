//! RQ1.1: the HDR scene target, pre-exposure, reverse-Z and the tonemap node (Khronos PBR Neutral,
//! AgX, Hill's ACES fit, none), the luminance-weighted MSAA resolve on desktop classes and the
//! tonemap fused with the bilinear upscale below scale 1.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test hdr -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/hdr/<name>.bgra` (raw BGRA, top row first, 128x72);
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` also writes each
//! compared frame there; `GENEX_PERF_OUT` receives the HDR cost row as JSON.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::cull::{frustum_planes, frustum_planes_for, in_frustum};
use genex_render::device_class::{DeviceClass, FormFactor};
use genex_render::post::tonemap::{TonemapSource, upscale_image, DITHER_LEVELS, MsaaResolve, encode_srgb, tonemap_cpu, tonemap_image};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PointLight, Scene, scaled, translation};
use genex_render::settings::{AntiAliasing, ExposureMode, Look, Quality, QualityPreset, SceneFormat, Tonemapper};
use genex_render::{CullPath, Gpu, LdrReason, RenderOptions, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The GPU curve may differ from the CPU reference by one 8-bit level.
const CURVE_LEVELS: u8 = 1;
/// The largest finite half float.
const HALF_MAX: f32 = 65504.0;

// ---------------------------------------------------------------------------------------------
// CPU rows

/// 16 sample radiances from deep shadow to far past white.
fn radiances() -> Vec<f32> {
    (0..16).map(|i| 0.002 * libm::exp2f(i as f32 * 0.85)).collect()
}

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

#[test]
fn every_curve_is_bounded_and_monotone_in_radiance() {
    for tonemapper in Tonemapper::ALL {
        let mut last = -1.0f32;
        for radiance in radiances().into_iter().chain([1.0e3, 6.0e4]) {
            let mapped = tonemap_cpu(tonemapper, [radiance; 3]);
            assert!(mapped.iter().all(|c| (0.0..=1.0).contains(c)), "{tonemapper:?} at {radiance}: {mapped:?} leaves [0, 1]");
            let y = luminance(mapped);
            assert!(y + 1e-6 >= last, "{tonemapper:?} is monotone: {y} after {last} at {radiance}");
            last = y;
        }
    }
}

#[test]
fn the_curves_compress_highlights_and_none_clamps() {
    // Hill's ACES fit reaches white near 15x (its shoulder clips); AgX and Neutral roll off further.
    for (tonemapper, radiance) in [(Tonemapper::Agx, 20.0), (Tonemapper::Aces, 6.0), (Tonemapper::KhronosNeutral, 20.0)] {
        let bright = tonemap_cpu(tonemapper, [radiance; 3]);
        assert!(bright.iter().all(|c| *c < 1.0), "{tonemapper:?} keeps {radiance}x white below white: {bright:?}");
    }
    assert_eq!(tonemap_cpu(Tonemapper::None, [20.0, 0.5, -1.0]), [1.0, 0.5, 0.0], "none is a clamp");
    // Khronos PBR Neutral is the legacy-preserving default: in-range colours barely move.
    for value in [0.1f32, 0.3, 0.5, 0.7] {
        let mapped = tonemap_cpu(Tonemapper::KhronosNeutral, [value, value * 0.8, value * 0.6]);
        assert!((mapped[0] - value).abs() < 0.05, "neutral keeps {value} near itself: {mapped:?}");
    }
}

/// A display colour's saturation: (max - min) / max.
fn saturation(rgb: [f32; 3]) -> f32 {
    let (hi, lo) = (rgb[0].max(rgb[1]).max(rgb[2]), rgb[0].min(rgb[1]).min(rgb[2]));
    if hi <= 0.0 { 0.0 } else { (hi - lo) / hi }
}

#[test]
fn agx_punchy_keeps_warm_lights_saturated_where_plain_agx_greys_them() {
    // A lantern's warm glow, a lit window and a saturated red, at and above display white.
    for radiance in [[1.0, 0.75, 0.3], [2.4, 1.6, 0.5], [3.0, 0.4, 0.2]] {
        let plain = saturation(tonemap_cpu(Tonemapper::Agx, radiance));
        let punchy = saturation(tonemap_cpu(Tonemapper::AgxPunchy, radiance));
        assert!(punchy > plain * 1.15, "{radiance:?}: punchy {punchy} against plain {plain}");
    }
    // Mid grey stays near mid grey and highlights still roll off below white.
    let grey = tonemap_cpu(Tonemapper::AgxPunchy, [0.18; 3]);
    assert!((0.08..0.25).contains(&grey[1]), "mid grey: {grey:?}");
    assert!(tonemap_cpu(Tonemapper::AgxPunchy, [20.0; 3]).iter().all(|c| *c < 1.0));
}

#[test]
fn an_inf_a_custom_pass_wrote_maps_to_a_finite_colour_on_every_curve() {
    // A custom source past the half-float limit can store inf (backends that do not saturate the
    // conversion): the curve reads it as the largest stored radiance, never NaN (black on screen).
    for tonemapper in Tonemapper::ALL {
        let mapped = tonemap_cpu(tonemapper, [f32::INFINITY, f32::INFINITY, 1.0]);
        assert!(mapped.iter().all(|c| c.is_finite() && (0.0..=1.0).contains(c)), "{tonemapper:?}: {mapped:?}");
        assert!(mapped[0] > 0.9, "{tonemapper:?}: inf reads as a highlight: {mapped:?}");
    }
}

#[test]
fn the_srgb_encode_is_the_forward_shaders() {
    assert_eq!(encode_srgb(0.0), 0.0);
    assert!((encode_srgb(1.0) - 1.0).abs() < 1e-6);
    assert!((encode_srgb(0.0031308) - 0.0031308 * 12.92).abs() < 1e-6);
    assert!((encode_srgb(0.5) - 0.735_356_7).abs() < 1e-4);
}

#[test]
fn a_reversed_projection_maps_near_to_one_and_far_to_zero() {
    let camera = CameraDesc::look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0]);
    for camera in [camera, camera.orthographic(4.0)] {
        let depth = |proj: glam::Mat4, distance: f32| {
            let clip = proj * glam::Vec4::new(0.0, 0.0, 5.0 - distance, 1.0);
            clip.z / clip.w
        };
        let (standard, reversed) = (camera.projection(16.0 / 9.0, false), camera.projection(16.0 / 9.0, true));
        assert!(depth(standard, camera.near).abs() < 1e-5 && (depth(standard, camera.far) - 1.0).abs() < 1e-4);
        assert!((depth(reversed, camera.near) - 1.0).abs() < 1e-5, "near maps to 1");
        assert!(depth(reversed, camera.far).abs() < 1e-4, "far maps to 0");
        assert!(depth(reversed, 2.0) > depth(reversed, 3.0), "nearer is greater");
        assert_eq!(camera.view_proj(16.0 / 9.0), camera.projection(16.0 / 9.0, false), "the standard projection is today's");
    }
}

#[test]
fn reversed_and_infinite_frustum_planes_cull_what_the_standard_planes_cull() {
    let camera = CameraDesc::look_at([0.0, 2.0, 10.0], [0.0, 0.0, 0.0]);
    let standard = frustum_planes(camera.projection(1.5, false));
    let reversed = frustum_planes_for(camera.projection(1.5, true), true);
    let infinite_camera = CameraDesc { far: f32::INFINITY, ..camera };
    let infinite = frustum_planes_for(infinite_camera.projection(1.5, true), true);
    assert!(infinite.iter().flatten().all(|v| v.is_finite()), "an infinite far plane gives no NaN plane: {infinite:?}");
    let mut kept = 0;
    for x in -12..=12 {
        for z in -30..=12 {
            let sphere = [x as f32 * 2.0, 0.0, z as f32 * 4.0, 0.5];
            let inside = in_frustum(&standard, sphere);
            assert_eq!(in_frustum(&reversed, sphere), inside, "reversed planes disagree at {sphere:?}");
            if inside {
                kept += 1;
                assert!(in_frustum(&infinite, sphere), "the infinite frustum holds what the finite one does");
            }
        }
    }
    assert!(kept > 20, "the grid straddles the frustum ({kept} kept)");
    let behind = [0.0, 2.0, 12.0, 0.5];
    assert!(!in_frustum(&reversed, behind) && !in_frustum(&infinite, behind), "behind the camera is culled");
    assert!(in_frustum(&infinite, [0.0, 0.0, -5000.0, 1.0]) && !in_frustum(&reversed, [0.0, 0.0, -5000.0, 1.0]));
}

#[test]
fn a_reverse_z_plan_culls_the_same_draws_and_carries_the_reversed_camera() {
    let library = MeshLibrary::new();
    let scene = bright_scene(2.5);
    let standard = FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    let reversed = FramePlan::build_depth(&scene, &library, 16.0 / 9.0, true, true).expect("plan");
    assert_eq!(standard.cpu_cull(), reversed.cpu_cull(), "the same draws survive the camera cull");
    assert_eq!(reversed.frame.view_proj, scene.camera.view_proj_reversed(16.0 / 9.0).to_cols_array());
    assert_ne!(standard.frame.view_proj, reversed.frame.view_proj);
    assert_eq!(standard.frame.cascade_view_proj, reversed.frame.cascade_view_proj, "shadow cascades keep standard Z");
}

// ---------------------------------------------------------------------------------------------
// GPU fixtures

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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/hdr")
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
    write_evidence(name, capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    let (outliers, worst) = compare(&golden, capture.bgra());
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

/// Pixels differing by more than the golden tolerance, and the worst channel difference.
fn compare(a: &[u8], b: &[u8]) -> (usize, u8) {
    assert_eq!(a.len(), b.len());
    let mut outliers = 0;
    let mut worst = 0u8;
    for (x, y) in a.chunks(4).zip(b.chunks(4)) {
        let diff = x.iter().zip(y).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    (outliers, worst)
}

fn pixel(capture: &Capture, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * capture.width() + x) * 4) as usize;
    capture.bgra()[i..i + 4].try_into().expect("pixel")
}

/// The HDR quality: the scene target, the look's curve and exposure, nothing else changed.
fn hdr_quality() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality
}

fn look(tonemapper: Tonemapper, ev: f32) -> Look {
    let mut look = Look::default();
    look.tonemapper = tonemapper;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = ev;
    look
}

/// A renderer drawing the HDR path with `tonemapper` at manual `ev`.
fn hdr_renderer(gpu: &Gpu, options: RenderOptions, tonemapper: Tonemapper, ev: f32) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, options).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&hdr_quality());
    renderer.set_look(look(tonemapper, ev));
    renderer
}

/// A white plane under a sun of `sun` intensity, a red cube, a green sphere and a warm point light.
fn opaque_scene(sun: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 9.0], [0.0, 0.0, 0.0]), [30, 40, 60, 255]);
    scene.lighting.sun_intensity = sun;
    scene.lighting.points.push(PointLight { position: [-2.5, 1.2, 1.0], range: 6.0, color: [255, 200, 140], intensity: 8.0 });
    scene.draw(MeshId::CUBE, translation(1.5, 0.5, 0.0), Material::color([220, 40, 50, 255]));
    scene.draw(MeshId::SPHERE, translation(-1.0, 0.8, 1.5), Material::color([90, 200, 120, 255]).with_pbr(0.0, 0.3));
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [14.0, 0.2, 10.0]), Material::color([255, 255, 255, 255]));
    scene
}

/// [`opaque_scene`] with a glass pane: the HDR path blends it in linear light, the legacy path in
/// sRGB-encoded values.
fn bright_scene(sun: f32) -> Scene {
    let mut scene = opaque_scene(sun);
    scene.draw(MeshId::CUBE, scaled([-0.2, 1.0, 3.0], [1.0, 1.4, 0.05]), Material::color([120, 170, 255, 110]));
    scene
}

/// A white plane filling the view under a sun of `sun` intensity, seen against the light: the
/// specular lobe gives a smooth gradient over the diffuse level.
fn hot_plane(sun: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.sun_intensity = sun;
    scene.lighting.sun_dir = [0.0, 0.6, -1.0];
    scene.lighting.shadows = false;
    scene.lighting.ambient_intensity = 0.0;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [60.0, 0.2, 60.0]), Material::color([255, 255, 255, 255]));
    scene
}

fn render(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene) -> Capture {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_sun_of_20_saturates_the_legacy_path_but_keeps_a_gradient_under_aces_and_agx() {
    let Some(gpu) = gpu() else { return };
    let scene = hot_plane(20.0);
    let mut off = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let legacy = render(&mut off, &gpu, &scene);
    // The centre column, from the far edge of the plane (top) to the near edge (bottom).
    let column = WIDTH / 2;
    let green = |capture: &Capture, y: u32| pixel(capture, column, y)[1];
    write_evidence("sun20-legacy", &legacy);
    let plane: Vec<u32> = (0..HEIGHT).filter(|y| green(&legacy, *y) > 0).collect();
    assert!(plane.len() as u32 > HEIGHT / 2, "the plane fills most of the view");
    // Past its antialiased far edge, the legacy path clips the whole lit plane to white.
    let plane: Vec<u32> = plane.into_iter().skip(1).collect();
    let clipped = plane.iter().filter(|y| green(&legacy, **y) == 255).count();
    assert_eq!(clipped, plane.len(), "the legacy path clips the lit plane to white: {:?}", plane.iter().map(|y| green(&legacy, *y)).collect::<Vec<_>>());
    for tonemapper in [Tonemapper::Aces, Tonemapper::Agx] {
        let mut renderer = hdr_renderer(&gpu, RenderOptions::default(), tonemapper, 0.0);
        let frame = render(&mut renderer, &gpu, &scene);
        write_evidence(&format!("sun20-{tonemapper:?}").to_lowercase(), &frame);
        let values: Vec<u8> = plane.iter().map(|y| green(&frame, *y)).collect();
        let (brightest, darkest) = (values.iter().copied().max().unwrap_or(0), values.iter().copied().min().unwrap_or(0));
        assert!(brightest < 255, "{tonemapper:?}: the brightest texel stays below white ({brightest})");
        assert!(brightest - darkest >= 4, "{tonemapper:?}: a gradient, not a plateau ({darkest}..{brightest})");
        // From the brightest texel the plane only darkens either way (the dither moves a level).
        let peak = values.iter().position(|v| *v == brightest).unwrap_or(0);
        for window in values[..=peak].windows(2) {
            assert!(window[0] <= window[1].saturating_add(DITHER_LEVELS), "{tonemapper:?}: monotone up to the peak: {values:?}");
        }
        for window in values[peak..].windows(2) {
            assert!(window[1] <= window[0].saturating_add(DITHER_LEVELS), "{tonemapper:?}: monotone after the peak: {values:?}");
        }
        let path = renderer.last_scene().expect("an HDR frame ran");
        assert!(path.hdr && path.depth_reversed && path.tonemapper == tonemapper, "{path:?}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_tonemap_node_matches_the_cpu_curves_within_one_level() {
    let Some(gpu) = gpu() else { return };
    let samples = radiances();
    // A 16x4 image: each column one radiance, rows grey, warm, cool and saturated red.
    let tints = [[1.0, 1.0, 1.0], [1.0, 0.7, 0.4], [0.4, 0.7, 1.0], [1.0, 0.1, 0.05]];
    let texels: Vec<[f32; 4]> =
        tints.iter().flat_map(|tint| samples.iter().map(move |r| [r * tint[0], r * tint[1], r * tint[2], 1.0])).collect();
    for tonemapper in Tonemapper::ALL {
        let capture = tonemap_image(&gpu, tonemapper, 16, 4, &texels, false).expect("tonemapped");
        for (i, texel) in texels.iter().enumerate() {
            // The GPU reads the image as half floats: the reference maps the same values.
            let half = texel.map(round_to_half);
            let mapped = tonemap_cpu(tonemapper, [half[0], half[1], half[2]]).map(|c| (encode_srgb(c) * 255.0).round() as u8);
            let got = &capture.bgra()[i * 4..i * 4 + 4];
            let rgb = [got[2], got[1], got[0]];
            for c in 0..3 {
                assert!(rgb[c].abs_diff(mapped[c]) <= CURVE_LEVELS, "{tonemapper:?} texel {i} {texel:?}: GPU {rgb:?}, CPU {mapped:?}");
            }
            assert_eq!(got[3], 255, "opaque");
        }
    }
    // The frame-keyed dither moves a level by at most one.
    let plain = tonemap_image(&gpu, Tonemapper::Agx, 16, 4, &texels, false).expect("plain");
    let dithered = tonemap_image(&gpu, Tonemapper::Agx, 16, 4, &texels, true).expect("dithered");
    let (_, worst) = compare(plain.bgra(), dithered.bgra());
    assert!(worst <= DITHER_LEVELS, "dither is at most {DITHER_LEVELS} level ({worst})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_curve_dithers_the_hdr_path_none_included() {
    let Some(gpu) = gpu() else { return };
    // A slow dark-sky gradient: 64 columns over a few 8-bit levels, where an undithered encode bands.
    let texels: Vec<[f32; 4]> = (0..4).flat_map(|_| (0..64).map(|x| [0.02 + x as f32 * 0.0004, 0.05 + x as f32 * 0.0006, 0.12 + x as f32 * 0.001, 1.0])).collect();
    for tonemapper in Tonemapper::ALL {
        let plain = tonemap_image(&gpu, tonemapper, 64, 4, &texels, false).expect("plain");
        let dithered = tonemap_image(&gpu, tonemapper, 64, 4, &texels, true).expect("dithered");
        let (_, worst) = compare(plain.bgra(), dithered.bgra());
        let moved = plain.bgra().iter().zip(dithered.bgra()).filter(|(a, b)| a != b).count();
        assert!(moved > 16, "{tonemapper:?}: the HDR path's encode is dithered ({moved} channels moved)");
        assert!(worst <= DITHER_LEVELS, "{tonemapper:?}: by at most {DITHER_LEVELS} level ({worst})");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_budget_ledger_covers_every_target_the_hdr_path_allocates() {
    use genex_render::budget::{BudgetInput, BudgetKind, ledger};
    use genex_render::presets::scene_format;
    let Some(gpu) = gpu() else { return };
    let output = (640, 360);
    let transient = gpu.device.adapter_info().transient_saves_memory == Some(true);
    let mut auto = look(Tonemapper::KhronosNeutral, 0.0);
    auto.exposure = ExposureMode::Auto;
    for wire in ["desktop-ultra", "desktop-high", "desktop-low", "mobile-high", "mobile-mid"] {
        let class = DeviceClass::from_wire(wire).expect("class");
        let format = scene_format(class, gpu.device.features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE));
        for preset in QualityPreset::ALL {
            let quality = preset_quality(preset, class);
            // The world pass's samples are fixed per renderer: the presenter rebuilds it for the preset's.
            let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
            let mut renderer = Renderer::with_options(&gpu, output.0, output.1, options).expect("renderer");
            renderer.set_scene_format(format);
            renderer.set_device_class(class);
            renderer.set_quality(&quality);
            renderer.set_render_scale(quality.render_scale);
            // Auto exposure reads the resolved scene: the weighted resolve then keeps a 1x scene too.
            renderer.set_look(auto);
            render(&mut renderer, &gpu, &opaque_scene(2.5));
            let path = renderer.last_scene().expect("ran");
            let input = BudgetInput::new(output, quality.render_scale, format, transient).with_msaa_read(path.resolve == Some(MsaaResolve::Weighted));
            let model = ledger(&quality, &input);
            let modelled = model.total_of(BudgetKind::Target) + model.total_of(BudgetKind::History);
            let held = renderer.targets().ledger().total();
            assert!(held <= modelled, "{wire} {preset:?}: the renderer holds {held} bytes of targets, the ledger models {modelled}: {:?}", renderer.targets().ledger().entries());
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_dynamic_resolution_step_below_one_creates_no_pipeline_in_the_frame() {
    use genex_render::settings::Upscaler;
    let Some(gpu) = gpu() else { return };
    for (upscaler, resolve) in [(Upscaler::Bilinear, MsaaResolve::Hardware), (Upscaler::Fsr1, MsaaResolve::Weighted), (Upscaler::Bilinear, MsaaResolve::Weighted)] {
        let mut renderer = hdr_renderer(&gpu, RenderOptions::default(), Tonemapper::KhronosNeutral, 0.0);
        let mut quality = hdr_quality();
        quality.upscaler = upscaler;
        renderer.set_quality(&quality);
        renderer.set_msaa_resolve(Some(resolve));
        render(&mut renderer, &gpu, &opaque_scene(2.5));
        let warm = renderer.post_pipelines();
        // The first step down is the frame that is already over budget: it compiles nothing.
        renderer.set_render_scale(0.75);
        render(&mut renderer, &gpu, &opaque_scene(2.5));
        assert!(renderer.last_scene().expect("ran").tonemap.is_some());
        assert_eq!(renderer.post_pipelines(), warm, "{upscaler:?} {resolve:?}: the step down built a pipeline");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_compact_scene_format_is_drawn_where_the_device_renders_it() {
    let Some(gpu) = gpu() else { return };
    let offered = gpu.device.features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    for options in [RenderOptions::default(), RenderOptions { msaa: false }] {
        let mut renderer = hdr_renderer(&gpu, options, Tonemapper::KhronosNeutral, 0.0);
        renderer.set_scene_format(SceneFormat::Rg11b10Ufloat);
        // The glass pane blends into the compact scene too (no alpha channel: blending reads the source's).
        let frame = render(&mut renderer, &gpu, &bright_scene(2.5));
        let expected = if offered { wgpu::TextureFormat::Rg11b10Ufloat } else { wgpu::TextureFormat::Rgba16Float };
        let path = renderer.last_scene().expect("ran");
        assert!(path.hdr && path.format == expected, "{options:?}: offered {offered}: {path:?}");
        assert_eq!(renderer.hdr_scene_format(), expected);
        // What the pool allocated is what the ledger counts: 4 bytes a texel for rg11b10.
        let held: Vec<_> = renderer.targets().targets().iter().filter(|t| t.desc().format == expected).map(|t| t.desc().bytes()).collect();
        assert!(!held.is_empty(), "{options:?}: a scene target in {expected:?}");
        assert!(frame.bgra().chunks(4).any(|p| p[2] > 120 && p[1] < 80), "{options:?}: the red cube is drawn");
    }
    assert!(offered || gpu.receipt().backend != "metal", "Apple GPUs render rg11b10ufloat: the row checks the compact path there");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_upscale_below_scale_one_keeps_dark_detail_beside_an_emissive() {
    let Some(gpu) = gpu() else { return };
    // A lantern's frame against its lit glass: one dark column, then two blinding ones, repeated.
    let (size, target) = ((24, 8), (48, 16));
    let texels: Vec<[f32; 4]> = (0..size.1).flat_map(|_| (0..size.0).map(|x| if x % 3 == 0 { [0.02, 0.015, 0.01, 1.0] } else { [24.0, 16.0, 6.0, 1.0] })).collect();
    for source in [TonemapSource::Bilinear, TonemapSource::Sharpen] {
        let capture = upscale_image(&gpu, Tonemapper::KhronosNeutral, source, size, &texels, target, false).expect("upscaled");
        // A third of the source is dark. At twice the size the two pixels beside each dark texel
        // take three quarters of it: they read nearer the dark texel than the blinding one (a plain
        // linear filter reads them near white: 0.75 x 0.015 + 0.25 x 16 is still radiance 4).
        let near_dark = capture.bgra().chunks(4).filter(|p| p[1] < 180).count();
        let total = (target.0 * target.1) as usize;
        assert!(near_dark * 3 >= total, "{source:?}: {near_dark} of {total} pixels read near the dark texels");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_none_at_exposure_one_equals_the_legacy_path_on_an_in_range_scene() {
    let Some(gpu) = gpu() else { return };
    // Single-sampled, so no resolve differs (the legacy path averages encoded samples, HDR linear
    // ones), and opaque (the legacy path blends encoded values, HDR linear light).
    let options = RenderOptions { msaa: false };
    let scene = opaque_scene(1.2);
    let mut off = Renderer::with_options(&gpu, WIDTH, HEIGHT, options).expect("renderer");
    let legacy = render(&mut off, &gpu, &scene);
    let mut renderer = hdr_renderer(&gpu, options, Tonemapper::None, 0.0);
    let frame = render(&mut renderer, &gpu, &scene);
    // Where the glossy sphere draws (or shades the floor): the scene without it differs there.
    let mut matte = opaque_scene(1.2);
    matte.draws.retain(|draw| draw.mesh != MeshId::SPHERE);
    let without_sphere = render(&mut off, &gpu, &matte);
    let sphere: Vec<bool> = legacy.bgra().chunks(4).zip(without_sphere.bgra().chunks(4)).map(|(a, b)| a != b).collect();
    // The legacy encode, give or take one level of rounding and the HDR path's dither, everywhere
    // but the sphere's direct highlight: since RQ2.4 the HDR scene's direct specular is GGX with
    // height-correlated Smith (the BRDF LUT's term), the legacy scene's Smith-Schlick
    // (intentionally flipped from "every pixel equal"; golden_ibl.rs proves the new term).
    let (mut outliers, mut worst, mut highlight) = (0usize, 0u8, 0usize);
    for ((a, b), on_sphere) in legacy.bgra().chunks(4).zip(frame.bgra().chunks(4)).zip(&sphere) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        if diff <= 1 + DITHER_LEVELS {
            continue;
        }
        if *on_sphere {
            highlight += 1;
        } else if diff > 1 + DITHER_LEVELS + ROUGH_SPECULAR_LEVELS {
            outliers += 1;
        }
        if !*on_sphere {
            worst = worst.max(diff);
        }
    }
    assert!(outliers == 0, "`none` at EV 0 is the legacy clamp off the sphere: {outliers} outliers, worst {worst}");
    assert!(highlight <= SPECULAR_TERM_PIXELS, "only the sphere's highlight shades differently: {highlight} pixels");
    assert!(renderer.last_scene().expect("ran").hdr, "it really drew the HDR path");
}

/// How many pixels of [`opaque_scene`]'s roughness-0.3 sphere may differ between the legacy and the
/// HDR direct specular (Smith-Schlick against height-correlated Smith): its highlight.
const SPECULAR_TERM_PIXELS: usize = 32;
/// How far the two specular terms may move a rough (0.6) dielectric's pixel off the sphere, in
/// 8-bit levels: its F0 = 0.04 lobe is faint, so the terms differ by a level or two there.
const ROUGH_SPECULAR_LEVELS: u8 = 2;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_blinding_sun_under_manual_ev_writes_no_inf_or_nan_into_the_scene() {
    let Some(gpu) = gpu() else { return };
    let scene = bright_scene(1.0e5);
    for ev in [0.0f32, -14.0] {
        let mut renderer = hdr_renderer(&gpu, RenderOptions { msaa: false }, Tonemapper::Agx, ev);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let texels = renderer.read_scene(&gpu).expect("the HDR scene reads back");
        assert_eq!(texels.len(), (WIDTH * HEIGHT) as usize);
        assert!(texels.iter().flatten().all(|v| v.is_finite() && *v <= HALF_MAX), "EV {ev}: every scene value is finite");
        let brightest = texels.iter().map(|t| t[0].max(t[1]).max(t[2])).fold(0.0f32, f32::max);
        if ev < 0.0 {
            assert!(brightest < 1.0e4, "pre-exposure brings the sun into range ({brightest})");
            assert!(brightest > 1.0, "and it is still HDR ({brightest})");
        }
        let frame = renderer.capture(&gpu).expect("capture");
        assert!(frame.bgra().chunks(4).any(|p| p[1] > 0), "the frame is drawn");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_legacy_path_keeps_standard_z_and_the_hdr_path_reverses_it() {
    let Some(gpu) = gpu() else { return };
    let options = RenderOptions { msaa: false };
    let scene = bright_scene(2.5);
    let mut off = Renderer::with_options(&gpu, WIDTH, HEIGHT, options).expect("renderer");
    let reference = render(&mut off, &gpu, &scene);
    off.set_depth_readback(true);
    let legacy_frame = render(&mut off, &gpu, &scene);
    assert_eq!(legacy_frame.bgra(), reference.bgra(), "reading depth back does not change the picture");
    let standard = off.read_depth(&gpu).expect("depth");
    let mut renderer = hdr_renderer(&gpu, options, Tonemapper::KhronosNeutral, 0.0);
    renderer.set_depth_readback(true);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let reversed = renderer.read_depth(&gpu).expect("depth");
    let corner = 0;
    assert_eq!((standard[corner], reversed[corner]), (1.0, 0.0), "the sky keeps the clear: far is 1 in standard Z, 0 reversed");
    let centre = (HEIGHT / 2 * WIDTH + WIDTH / 2) as usize;
    assert!(standard[centre] > 0.5 && standard[centre] < 1.0, "standard Z: a near surface ({})", standard[centre]);
    assert!(reversed[centre] > 0.0 && reversed[centre] < 0.5, "reverse-Z: the same surface ({})", reversed[centre]);
    assert!(!off.last_scene().expect("ran").depth_reversed && renderer.last_scene().expect("ran").depth_reversed);

    // A frame degraded to LDR draws the legacy picture with standard Z.
    renderer.set_ldr_reason(Some(LdrReason::CustomPassV1InWorld));
    let degraded = render(&mut renderer, &gpu, &scene);
    let path = renderer.last_scene().expect("ran");
    assert!(!path.hdr && !path.depth_reversed && path.ldr_reason == Some(LdrReason::CustomPassV1InWorld), "{path:?}");
    assert_eq!(degraded.bgra(), reference.bgra(), "the degraded frame is the legacy frame");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_legacy_quality_with_an_hdr_scene_format_is_the_legacy_frame() {
    let Some(gpu) = gpu() else { return };
    let scene = bright_scene(2.5);
    let mut off = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let legacy = render(&mut off, &gpu, &scene);
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_look(look(Tonemapper::Aces, 2.0));
    assert_eq!(render(&mut renderer, &gpu, &scene).bgra(), legacy.bgra(), "only quality.hdr turns the HDR path on");
    assert_eq!(renderer.last_stats().render_passes, off.last_stats().render_passes);
    assert!(renderer.targets().get("scene").is_none(), "no HDR target is allocated");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_low_below_scale_one_fuses_tonemap_and_upscale_into_one_pass() {
    let Some(gpu) = gpu() else { return };
    let scene = bright_scene(2.5);
    let mut off = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    render(&mut off, &gpu, &scene);
    let off_passes = off.last_stats().render_passes;
    for (wire, resolve) in [("desktop-low", MsaaResolve::Weighted), ("mobile-mid", MsaaResolve::Hardware)] {
        let class = DeviceClass::from_wire(wire).expect("class");
        let low = preset_quality(QualityPreset::Low, class);
        assert_eq!(low.anti_aliasing, AntiAliasing::Msaa4, "low keeps MSAA");
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_form_factor(class.form);
        renderer.set_msaa_resolve(Some(resolve));
        renderer.set_quality(&low);
        renderer.set_render_scale(0.5);
        let frame = render(&mut renderer, &gpu, &scene);
        // Low draws its own cascades (one shadow pass each) in place of the legacy two.
        let base = off_passes - off.last_stats().views + 1 + u32::from(low.shadows.cascades);
        // Owner decision 2026-10-12 (b) flips mobile-mid (was fused like desktop-low): a phone's
        // low upscales with EASU and RCAS, two passes after the tonemap.
        let phone = class.form == FormFactor::Mobile;
        let upscale_passes = if phone { 2 } else { 0 };
        assert_eq!(renderer.last_stats().render_passes, base + 1 + upscale_passes, "{wire}: low's tonemap (and a phone's EASU and RCAS)");
        let path = renderer.last_scene().expect("ran");
        assert_eq!((path.fsr.easu, path.fsr.rcas), (phone, phone), "{wire}: {path:?}");
        assert_eq!((path.resolve, path.resolve_pass), (Some(resolve), false), "{wire}: {path:?}");
        assert_eq!((frame.width(), frame.height()), (WIDTH, HEIGHT), "the output keeps its size");
        assert!(frame.bgra().chunks(4).filter(|p| p[2] > 120 && p[1] < 80).count() > 20, "{wire}: the red cube is drawn");
        // At scale 1 the tonemap writes straight into the world target: still one pass more.
        renderer.set_render_scale(1.0);
        render(&mut renderer, &gpu, &scene);
        assert_eq!(renderer.last_stats().render_passes, base + 1, "{wire}: scale 1");
    }
    // By device: mobile classes and tile GPUs resolve in the world pass, other desktops weighted.
    let mut renderer = hdr_renderer(&gpu, RenderOptions::default(), Tonemapper::KhronosNeutral, 0.0);
    renderer.set_form_factor(FormFactor::Mobile);
    render(&mut renderer, &gpu, &scene);
    assert_eq!(renderer.last_scene().expect("ran").resolve, Some(MsaaResolve::Hardware));
    renderer.set_form_factor(FormFactor::Desktop);
    render(&mut renderer, &gpu, &scene);
    let tile = gpu.device.adapter_info().transient_saves_memory == Some(true);
    assert_eq!(renderer.last_scene().expect("ran").resolve, Some(MsaaResolve::for_device(FormFactor::Desktop, tile)));
}

/// Partly covered pixels on a blinding object's edge: neither the background nor the object.
fn soft_edge_pixels(capture: &Capture) -> usize {
    capture.bgra().chunks(4).filter(|p| p[1] > 40 && p[1] < 200).count()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_weighted_resolve_keeps_bright_edges_antialiased() {
    let Some(gpu) = gpu() else { return };
    // A blinding white cube against black: a hardware (linear) resolve averages 1 sample of 400 with
    // 3 of 0 into 100, still white after the curve; the luminance-weighted resolve keeps the step.
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 6.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.shadows = false;
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.sun_dir = [0.0, 0.0, 1.0];
    scene.lighting.sun_intensity = 400.0;
    let tilted = glam::Mat4::from_rotation_z(0.45) * glam::Mat4::from_rotation_y(0.35);
    scene.draw(MeshId::CUBE, tilted.to_cols_array(), Material::color([255, 255, 255, 255]));
    let mut edges = Vec::new();
    for resolve in [MsaaResolve::Hardware, MsaaResolve::Weighted] {
        let mut renderer = hdr_renderer(&gpu, RenderOptions::default(), Tonemapper::Agx, 0.0);
        renderer.set_msaa_resolve(Some(resolve));
        let frame = render(&mut renderer, &gpu, &scene);
        write_evidence(&format!("resolve-{resolve:?}").to_lowercase(), &frame);
        edges.push(soft_edge_pixels(&frame));
    }
    let (hardware, weighted) = (edges[0], edges[1]);
    assert!(weighted > hardware + 20, "weighted resolve: {weighted} soft edge pixels, hardware {hardware}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_hdr_goldens() {
    let Some(gpu) = gpu() else { return };
    let scene = bright_scene(6.0);
    // The goldens pin the in-pass hardware resolve (mobile classes and tile GPUs), so a desktop GPU
    // that would pick the weighted resolve draws the same edges.
    let golden_renderer = |tonemapper| {
        let mut renderer = hdr_renderer(&gpu, RenderOptions::default(), tonemapper, 0.0);
        renderer.set_msaa_resolve(Some(MsaaResolve::Hardware));
        renderer
    };
    for (name, tonemapper) in [("hdr-aces", Tonemapper::Aces), ("hdr-agx", Tonemapper::Agx), ("hdr-neutral", Tonemapper::KhronosNeutral)] {
        let mut indirect = golden_renderer(tonemapper);
        let frame = render(&mut indirect, &gpu, &scene);
        let mut direct = golden_renderer(tonemapper);
        direct.render(&gpu, &scene, CullPath::Cpu).expect("cpu-culled frame");
        assert!(direct.capture(&gpu).expect("capture").bgra() == frame.bgra(), "{name}: the CPU-culled frame equals the GPU-culled frame");
        // Captures are reproducible on one adapter: a second renderer draws the same bytes.
        let mut again = golden_renderer(tonemapper);
        assert_eq!(render(&mut again, &gpu, &scene).digest(), frame.digest(), "{name}: reproducible");
        check_golden(name, &frame);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_hdr_and_tonemap_cost_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let (width, height) = (1920, 1080);
    let mut scene = bright_scene(6.0);
    for i in 0..60 {
        let (x, z) = ((i % 10) as f32 - 4.5, (i / 10) as f32 - 3.0);
        scene.draw(MeshId::SPHERE, scaled([x, 0.4, z], [0.35, 0.35, 0.35]), Material::color([200, 180, 160, 255]));
    }
    // The legacy path, HDR with the hardware resolve (tile classes) and with the weighted resolve
    // (desktop classes), run in interleaved rounds so GPU clock changes hit every row alike.
    let configs: [(&str, Option<MsaaResolve>); 3] =
        [("off", None), ("hdrHardware", Some(MsaaResolve::Hardware)), ("hdrWeighted", Some(MsaaResolve::Weighted))];
    let mut renderers: Vec<Renderer> = configs
        .iter()
        .map(|(_, resolve)| {
            let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
            if let Some(resolve) = resolve {
                renderer.set_scene_format(SceneFormat::Rgba16Float);
                renderer.set_quality(&hdr_quality());
                renderer.set_look(look(Tonemapper::Agx, 0.0));
                renderer.set_msaa_resolve(Some(*resolve));
            }
            renderer
        })
        .collect();
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); configs.len()];
    for round in 0..8u64 {
        for (k, renderer) in renderers.iter_mut().enumerate() {
            for frame in 0..80u64 {
                let Some(times) = renderer.arm_frame_timer(&gpu.queue) else {
                    eprintln!("skipped: no timestamp queries");
                    return;
                };
                if round > 0 && frame >= 8 {
                    landed[k].extend(times);
                }
                renderer.set_frame_index(frame);
                renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
    }
    let mut fields = vec![format!("\"row\":\"hdr-tonemap-1080p\",\"adapter\":\"{}\"", gpu.receipt().adapter)];
    let mut p50s = Vec::new();
    for ((name, _), times) in configs.iter().zip(&mut landed) {
        times.sort_by(f32::total_cmp);
        let at = |q: f32| times[((times.len() - 1) as f32 * q) as usize];
        fields.push(format!("\"{name}\":{{\"frames\":{},\"p50Ms\":{:.4},\"p95Ms\":{:.4}}}", times.len(), at(0.5), at(0.95)));
        p50s.push(at(0.5));
    }
    let row = format!("{{{}}}", fields.join(","));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(p50s.iter().all(|ms| *ms > 0.0));
}

/// `value` rounded to the nearest half float (what an `rgba16float` texel holds), as f32.
fn round_to_half(value: f32) -> f32 {
    if value == 0.0 || !value.is_finite() {
        return value;
    }
    let exponent = libm::floorf(libm::log2f(value.abs())).max(-14.0);
    let quantum = libm::exp2f(exponent - 10.0);
    (value / quantum).round() * quantum
}
