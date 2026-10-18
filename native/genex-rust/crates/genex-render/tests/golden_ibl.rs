//! RQ2.4: image-based lighting in the forward shading (`shaders/lighting/ambient.wgsl`): SH9
//! diffuse, split-sum specular from the prefiltered cube and the BRDF LUT, multiple-scattering
//! energy compensation, the horizon fade and specular occlusion; and geometric specular
//! antialiasing (`shaders/lighting/surface.wgsl`), measured as the flicker of a bumpy sphere between
//! two jittered camera positions once the build draws it (the graph stops reporting `specular-aa`
//! as degraded).
//!
//! Every row needs a GPU: they are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test golden_ibl -- --ignored metal
//!
//! The environment rows need the bake scheduled ([`genex_render::ibl::LANDED`]); until the tier
//! turns it on they print `skipped` and return. Goldens live in
//! `tests/fixtures/render-goldens/ibl/<name>.bgra` (raw BGRA, top row first, 128x72);
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` also writes
//! each compared frame and a 640x360 evidence frame there; `GENEX_PERF_OUT` receives the IBL cost
//! row as JSON.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::hdri::{HdriImage, analytic_sun};
use genex_render::post::tonemap::f32_to_f16;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Environment, ExposureMode, HdriSun, Look, Quality, QualityPreset, SceneFormat, Tonemapper};
use genex_render::settings::HdriEnvironment;
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The furnace's environment radiance (scene units; well inside half-float precision).
const FURNACE: f32 = 0.5;
/// A white furnace reflects its environment within this share at every roughness.
const FURNACE_SHARE: f32 = 0.02;
/// The roughness steps of the sphere rows.
const ROUGHNESS: [f32; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];
/// The furnace samples a sphere's pixels inside this share of its silhouette radius.
const FURNACE_DISK: f32 = 0.85;
/// The CC0 showcase HDRI (RQ2.3).
const SHOWCASE_HDRI: &str = "../../examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr";
/// The IBL shading's budget at 1080p (plan §5, M4 Max): p50 GPU frame time over the flat colour.
const IBL_BUDGET_MS: f32 = 0.3;
/// Interleaved timing rounds of the cost row (the first warms up and is dropped).
const PERF_ROUNDS: u64 = 12;

// ---------------------------------------------------------------------------------------------
// Fixtures

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

/// Whether the environment bake is scheduled in this build (RQ2's tier switch).
fn ibl_landed() -> bool {
    if !genex_render::ibl::LANDED {
        eprintln!("skipped: ibl::LANDED is false, so no environment lights the scene in this build");
    }
    genex_render::ibl::LANDED
}

/// The HDR path with `preset`'s environment knobs (IBL on), everything else off.
fn ibl_quality(preset: QualityPreset, sky: bool) -> Quality {
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.environment = preset_quality(preset, class).environment;
    quality.environment.ibl = true;
    quality.environment.sky = sky;
    quality
}

fn look(tonemapper: Tonemapper) -> Look {
    let mut look = Look::default();
    look.tonemapper = tonemapper;
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = 0.0;
    look
}

/// A single-sampled renderer on the `rgba16float` HDR scene (so the scene reads back linear).
fn renderer(gpu: &Gpu, width: u32, height: u32, quality: &Quality, environment: &Environment) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, width, height, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(quality);
    renderer.set_look(look(Tonemapper::KhronosNeutral));
    renderer.set_environment(environment);
    renderer
}

/// An equirect map of constant radiance `value`.
fn constant_map(value: f32) -> HdriImage {
    let (width, height) = (64, 32);
    let half = f32_to_f16(value);
    let one = f32_to_f16(1.0);
    HdriImage { width, height, texels: vec![[half, half, half, one]; (width * height) as usize] }
}

/// The furnace: a constant map lighting the scene as it is (no analytic sun taken from it).
fn furnace_environment() -> Environment {
    Environment::Hdri(HdriEnvironment::new("env/furnace.hdr").with_intensity(1.0).with_sun(HdriSun::Off))
}

fn furnace_renderer(gpu: &Gpu) -> Renderer {
    let environment = furnace_environment();
    let mut renderer = renderer(gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &environment);
    renderer.set_environment_map(gpu, &constant_map(FURNACE)).expect("map");
    renderer
}

/// One unit sphere filling the middle of the frame on a black background, under `sun` (0: none).
fn sphere_scene(material: Material, sun: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 2.4], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.sun_intensity = sun;
    scene.lighting.ambient_intensity = 0.0;
    scene.draw(MeshId::SPHERE, scaled([0.0, 0.0, 0.0], [0.6, 0.6, 0.6]), material);
    scene
}

/// The linear scene after two frames (the first bakes the environment cold).
fn scene_radiance(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene) -> Vec<[f32; 4]> {
    for _ in 0..2 {
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// The pixels well inside the one object of `texels` (lit pixels over a black background): those
/// within [`FURNACE_DISK`] of its silhouette radius from its centroid.
fn disk_pixels(texels: &[[f32; 4]], width: u32) -> Vec<[f32; 4]> {
    let lit: Vec<(f32, f32)> = texels
        .iter()
        .enumerate()
        .filter(|(_, t)| t[0].max(t[1]).max(t[2]) > 0.02)
        .map(|(i, _)| ((i as u32 % width) as f32, (i as u32 / width) as f32))
        .collect();
    assert!(lit.len() > 400, "the sphere covers the frame's middle ({} lit pixels)", lit.len());
    let count = lit.len() as f32;
    let (cx, cy) = lit.iter().fold((0.0, 0.0), |(x, y), (px, py)| (x + px / count, y + py / count));
    let radius = (count / std::f32::consts::PI).sqrt() * FURNACE_DISK;
    texels
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            let (x, y) = ((*i as u32 % width) as f32, (*i as u32 / width) as f32);
            libm::hypotf(x - cx, y - cy) <= radius
        })
        .map(|(_, t)| *t)
        .collect()
}

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/ibl")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let file = format!("{name}-{}x{}.bgra", capture.width(), capture.height());
        std::fs::write(dir.join(file), capture.bgra()).expect("evidence");
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

fn capture(renderer: &mut Renderer, gpu: &Gpu, scene: &Scene, name: &str) -> Capture {
    for _ in 0..2 {
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    let capture = renderer.capture(gpu).expect("capture");
    write_evidence(name, &capture);
    capture
}

fn pixel(capture: &Capture, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * capture.width() + x) * 4) as usize;
    let p = &capture.bgra()[i..i + 4];
    [p[2], p[1], p[0]]
}

/// A unit vector `elevation` degrees above the horizon, behind the camera and a little to the side.
fn sun_at(elevation: f32) -> [f32; 3] {
    let e = elevation.to_radians();
    [0.35 * libm::cosf(e), libm::sinf(e), 0.94 * libm::cosf(e)]
}

/// The camera of [`spheres_scene`].
const SPHERES_EYE: [f32; 3] = [0.0, 1.3, 6.0];
const SPHERES_TARGET: [f32; 3] = [0.0, 1.05, 0.0];
/// The sphere rows' radius, spacing and heights.
const SPHERE_RADIUS: f32 = 0.45;
const SPHERE_SPACING: f32 = 1.1;
const METAL_ROW: f32 = 1.6;
const PLASTIC_ROW: f32 = 0.5;

/// Two rows of spheres from smooth to rough: polished metal above, red plastic below, on a grey
/// floor under the sun at `sun_dir`.
fn spheres_scene(sun_dir: [f32; 3], sun: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at(SPHERES_EYE, SPHERES_TARGET), [0, 0, 0, 255]);
    scene.lighting.sun_dir = sun_dir;
    scene.lighting.sun_intensity = sun;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [14.0, 0.2, 8.0]), Material::color([140, 140, 140, 255]));
    let size = [SPHERE_RADIUS; 3];
    for (i, roughness) in ROUGHNESS.into_iter().enumerate() {
        let x = sphere_x(i);
        scene.draw(MeshId::SPHERE, scaled([x, METAL_ROW, 0.0], size), Material::color([235, 235, 235, 255]).with_pbr(1.0, roughness));
        scene.draw(MeshId::SPHERE, scaled([x, PLASTIC_ROW, 0.0], size), Material::color([200, 30, 35, 255]).with_pbr(0.0, roughness));
    }
    scene
}

fn sphere_x(index: usize) -> f32 {
    (index as f32 - 2.0) * SPHERE_SPACING
}

/// Where the world point `p` lands in a `width` x `height` frame of the [`spheres_scene`] camera.
fn project(p: [f32; 3], width: u32, height: u32) -> (u32, u32) {
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let normalize = |a: [f32; 3]| {
        let l = dot(a, a).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let forward = normalize(sub(SPHERES_TARGET, SPHERES_EYE));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let d = sub(p, SPHERES_EYE);
    let depth = dot(d, forward);
    let half_height = depth * libm::tanf(22.5f32.to_radians());
    let half_width = half_height * width as f32 / height as f32;
    let x = (dot(d, right) / half_width * 0.5 + 0.5) * width as f32;
    let y = (0.5 - dot(d, up) / half_height * 0.5) * height as f32;
    (x as u32, y as u32)
}

/// A point on the upper row's sphere `index` (0: smoothest) facing up and towards the camera: its
/// mirror direction looks into the sky.
fn sphere_top(frame: &Capture, index: usize) -> [u8; 3] {
    let (x, y) = project([sphere_x(index), METAL_ROW + SPHERE_RADIUS * 0.75, SPHERE_RADIUS * 0.5], frame.width(), frame.height());
    pixel(frame, x, y)
}

/// The showcase's CC0 HDRI, decoded.
fn showcase_map() -> HdriImage {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(SHOWCASE_HDRI);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    genex_render::hdri::decode(&bytes).expect("the showcase HDRI decodes")
}

/// The sun `map`'s analytic sun stands for: its direction and its irradiance as the scene's sun
/// (white at the brightest channel's intensity; the facade does the same for `sun: analytic`).
fn analytic_scene_sun(map: &HdriImage) -> ([f32; 3], f32) {
    let sun = analytic_sun(map).expect("the showcase map has a sun");
    let intensity = sun.irradiance[0].max(sun.irradiance[1]).max(sun.irradiance[2]);
    (sun.direction, intensity)
}

/// The median of `values` (0 for none).
fn median(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

// ---------------------------------------------------------------------------------------------
// Rows

/// The white furnace (G6): a white environment lights a white sphere with exactly its own
/// radiance, whatever the roughness, dielectric or metal: what the single-scatter lobe loses at
/// high roughness the multiple-scattering term returns.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_white_furnace_reflects_the_whole_environment_at_every_roughness() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let mut renderer = furnace_renderer(&gpu);
    let mut worst = (0.0f32, String::new());
    for metallic in [0.0f32, 1.0] {
        for roughness in ROUGHNESS {
            let material = Material::color([255, 255, 255, 255]).with_pbr(metallic, roughness);
            let texels = scene_radiance(&mut renderer, &gpu, &sphere_scene(material, 0.0));
            let disk = disk_pixels(&texels, WIDTH);
            for texel in &disk {
                for channel in &texel[..3] {
                    let share = (channel - FURNACE).abs() / FURNACE;
                    if share > worst.0 {
                        worst = (share, format!("metallic {metallic} roughness {roughness}: {channel}"));
                    }
                }
            }
        }
    }
    eprintln!("furnace: worst share {:.4} ({})", worst.0, worst.1);
    assert!(worst.0 <= FURNACE_SHARE, "the furnace returns {FURNACE} within {FURNACE_SHARE}: worst {:.4} at {}", worst.0, worst.1);
    let frame = capture(&mut renderer, &gpu, &sphere_scene(Material::color([255, 255, 255, 255]).with_pbr(0.0, 0.5), 0.0), "furnace");
    check_golden("furnace", &frame);
}

/// The sun is not counted twice: the furnace with the analytic sun on is the furnace without it
/// plus the sun alone (no environment light), pixel for pixel in linear light. P2-0.11 (SI-07)
/// flips the sun alone's environment (named in the log): it was the flat colour, whose neutral BRDF
/// LUT leaves direct light single-scatter; a furnace of no light binds the LUT as the furnace does,
/// so both shade the sun with the same energy compensation.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_furnace_with_the_sun_is_the_furnace_plus_the_sun_alone() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let material = Material::color([255, 255, 255, 255]).with_pbr(0.0, 0.4);
    let mut furnace = furnace_renderer(&gpu);
    let without = scene_radiance(&mut furnace, &gpu, &sphere_scene(material, 0.0));
    let with = scene_radiance(&mut furnace, &gpu, &sphere_scene(material, 2.0));
    let mut alone = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &furnace_environment());
    alone.set_environment_map(&gpu, &constant_map(0.0)).expect("map");
    let sun = scene_radiance(&mut alone, &gpu, &sphere_scene(material, 2.0));
    let mut worst = 0.0f32;
    for ((w, a), s) in with.iter().zip(&without).zip(&sun) {
        for c in 0..3 {
            // One half-float step of the sum, at least.
            let tolerance = 2.0e-3 + 2.0e-3 * w[c];
            let error = (w[c] - (a[c] + s[c])).abs();
            worst = worst.max(error - tolerance);
        }
    }
    let sunlit = sun.iter().filter(|t| t[0] > 0.1).count();
    assert!(sunlit > 200, "the sun lights the sphere on its own ({sunlit} pixels)");
    assert!(worst <= 0.0, "the furnace with the sun is the sum of its parts: worst excess {worst}");
}

/// The flat-colour environment is the picture without IBL, byte for byte: the environment term
/// replaces the flat ambient only when a sky or a map lights the scene, so a game that never sets
/// an environment draws what it drew before the tier.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_flat_colour_environment_equals_the_ibl_off_frame_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    let scene = spheres_scene(sun_at(40.0), 2.5);
    let mut color = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, true), &Environment::Color);
    let with_ibl_on = capture(&mut color, &gpu, &scene, "color");
    let mut off_quality = ibl_quality(QualityPreset::High, false);
    off_quality.environment.ibl = false;
    let mut off = renderer(&gpu, WIDTH, HEIGHT, &off_quality, &Environment::Color);
    assert!(capture(&mut off, &gpu, &scene, "ibl-off").bgra() == with_ibl_on.bgra(), "the flat colour with IBL on equals IBL off");
    let mut plain_quality = Quality::off();
    plain_quality.hdr = true;
    plain_quality.tonemap = true;
    plain_quality.exposure = true;
    let mut plain = renderer(&gpu, WIDTH, HEIGHT, &plain_quality, &Environment::Color);
    assert!(capture(&mut plain, &gpu, &scene, "hdr-plain").bgra() == with_ibl_on.bgra(), "and the HDR frame with no environment knobs at all");
}

/// IBL switched off degrades to the flat ambient term, not to darkness: a sky that lights the
/// scene while the quality turns IBL off (a low preset, the person's override) draws the frame the
/// flat colour draws, the sky's own background aside (its switch is off here too).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_ibl_switched_off_under_a_sky_keeps_the_flat_ambient() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    // The sun is left out: under the sky it is the sun through the atmosphere whatever the IBL
    // switch (RQ2 review), so only the ambient term is compared (was: with a 2.5 sun).
    let scene = spheres_scene(sun_at(40.0), 0.0);
    let mut quality = ibl_quality(QualityPreset::High, false);
    quality.environment.ibl = false;
    let mut color = renderer(&gpu, WIDTH, HEIGHT, &quality, &Environment::Color);
    let flat = capture(&mut color, &gpu, &scene, "ibl-off-color");
    let mut sky = renderer(&gpu, WIDTH, HEIGHT, &quality, &Environment::sky());
    let switched_off = capture(&mut sky, &gpu, &scene, "ibl-off-sky");
    assert!(switched_off.bgra() == flat.bgra(), "IBL off under a sky keeps the flat ambient of the flat colour");
}

/// Metal and plastic spheres from smooth to rough under the physical sky (ibl/spheres): the
/// smooth metal mirrors the sky and the floor, the rough one shows their average, and the sky's
/// light reaches the shaded sides the sun misses.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_spheres_from_smooth_to_rough_under_the_sky_match_the_golden() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let scene = spheres_scene(sun_at(40.0), 2.5);
    let mut lit = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, true), &Environment::sky());
    let frame = capture(&mut lit, &gpu, &scene, "spheres");
    let mut flat = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, true), &Environment::Color);
    let reference = capture(&mut flat, &gpu, &scene, "spheres-flat");
    // The polished metal sphere's top reflects the blue sky, not the flat ambient's grey.
    let metal_top = sphere_top(&frame, 0);
    assert!(metal_top[2] > metal_top[0], "the smooth metal sphere mirrors a blue sky: {metal_top:?}");
    assert!(frame.bgra() != reference.bgra(), "the sky lights the scene: the frame differs from the flat ambient");
    check_golden("spheres", &frame);
    let mut evidence = renderer(&gpu, 640, 360, &ibl_quality(QualityPreset::High, true), &Environment::sky());
    let _ = capture(&mut evidence, &gpu, &scene, "spheres-evidence");
}

/// The showcase's CC0 HDRI lighting the spheres (ibl/hdri), its sun taken out of the map and
/// driving the analytic sun.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_showcase_hdri_lights_the_spheres_as_the_golden_holds() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let map = showcase_map();
    let (sun_dir, sun) = analytic_scene_sun(&map);
    let scene = spheres_scene(sun_dir, sun);
    let environment = Environment::Hdri(HdriEnvironment::new("env/kloofendal_43d_clear_puresky_1k.hdr"));
    let mut lit = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &environment);
    lit.set_environment_map(&gpu, &map).expect("map");
    let frame = capture(&mut lit, &gpu, &scene, "hdri");
    let metal_top = sphere_top(&frame, 0);
    assert!(metal_top[2] >= metal_top[0], "the smooth metal sphere mirrors the map's blue sky: {metal_top:?}");
    check_golden("hdri", &frame);
    let mut evidence = renderer(&gpu, 640, 360, &ibl_quality(QualityPreset::High, false), &environment);
    evidence.set_environment_map(&gpu, &map).expect("map");
    let _ = capture(&mut evidence, &gpu, &scene, "hdri-evidence");
}

/// Geometric specular antialiasing (`gx_filtered_roughness`, the surface chunk) run on the GPU
/// through the forward module: a constant normal keeps the material's roughness, a normal that
/// changes between pixels widens it (more for a faster change, never past the cap), and rough
/// surfaces barely move.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_specular_aa_widens_roughness_only_where_the_normal_varies() {
    let Some(gpu) = gpu() else { return };
    // (roughness, per-pixel normal change along x and along y)
    let cases: [(f32, f32, f32); 8] =
        [(0.04, 0.0, 0.0), (0.5, 0.0, 0.0), (0.04, 0.05, 0.0), (0.04, 0.2, 0.0), (0.04, 0.2, 0.2), (0.04, 5.0, 5.0), (0.3, 0.2, 0.0), (1.0, 0.2, 0.2)];
    let out = filtered_roughness_on_gpu(&gpu, &cases);
    let [flat_smooth, flat_rough, slight, curved, curved_both, extreme, mid, rough] = out[..] else { panic!("8 results") };
    assert!((flat_smooth - 0.04).abs() < 1e-5 && (flat_rough - 0.5).abs() < 1e-5, "a constant normal keeps the roughness: {flat_smooth}, {flat_rough}");
    assert!(0.04 < slight && slight < curved && curved < curved_both, "a faster change widens more: {slight} < {curved} < {curved_both}");
    // The kernel is capped at alpha squared + 0.2: the widest a mirror can get.
    let cap = libm::powf(libm::powf(0.04, 4.0) + 0.2, 0.25);
    assert!((extreme - cap).abs() < 1e-4, "the widening is capped: {extreme} against {cap}");
    assert!(mid > 0.3 && mid < curved.max(0.3) + 0.1, "a mid roughness widens too: {mid}");
    assert!((rough - 1.0).abs() < 1e-5, "the roughest surface stays the roughest: {rough}");
}

/// The flicker frame's size; its orthographic camera's height and distance; its sphere's scale
/// (about 43 px in radius in the frame's middle).
const FLICKER_WIDTH: u32 = 256;
const FLICKER_HEIGHT: u32 = 144;
const FLICKER_VIEW_HEIGHT: f32 = 2.0;
const FLICKER_EYE_DISTANCE: f32 = 50.0;
const FLICKER_SPHERE: f32 = 1.2;
/// The flicker metric's region: pixels within this radius of the frame's centre (inside the sphere).
const FLICKER_REGION_PX: f32 = 36.0;
/// The second camera position's jitter, in pixels to the right.
const FLICKER_JITTER_PX: f32 = 0.5;
/// With specular AA on, the frame flickers at most this share of the flicker it shows off. 0.8
/// since renderer pass 2 P2-0.12 (C8; was 0.6): specular AA filters the geometric normal's
/// variance as Filament does, and the normal map's detail is its mips' (Toksvig), so a magnified
/// bumpy map is steadied by the sphere's curvature alone (0.37 against 0.48 off).
const FLICKER_SHARE: f32 = 0.8;
/// The flicker off must reach this share for the row to measure anything.
const FLICKER_FLOOR: f32 = 0.2;
/// The normal map's bump period in texels, and its size.
const BUMP_PERIOD: u32 = 4;
const BUMP_MAP: (u32, u32) = (128, 64);

/// Whether this build draws geometric specular AA when `quality` asks for it (the graph reports
/// the knob as degraded until the HDR scene's pipelines set the surface chunk's constant).
fn specular_aa_drawn(quality: &Quality) -> bool {
    let drawn = !genex_render::graph::not_landed(quality).contains(&genex_render::graph::SPECULAR_AA_KNOB);
    if !drawn {
        eprintln!("skipped: this build reports specular AA as not drawn (degraded `specular-aa`)");
    }
    drawn
}

/// A tangent-space normal map of an egg-crate height field: bumps [`BUMP_PERIOD`] texels apart
/// whose slopes tilt the normal by up to 45 degrees.
fn bump_normal_map() -> genex_render::texture::TextureData {
    let (width, height) = BUMP_MAP;
    let k = std::f32::consts::TAU / BUMP_PERIOD as f32;
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let (fx, fy) = (x as f32 * k, y as f32 * k);
            let dx = libm::cosf(fx) * libm::sinf(fy);
            let dy = libm::sinf(fx) * libm::cosf(fy);
            let length = (dx * dx + dy * dy + 1.0).sqrt();
            let n = [-dx / length, -dy / length, 1.0 / length];
            rgba.extend(n.map(|c| ((c * 0.5 + 0.5) * 255.0).round() as u8));
            rgba.push(255);
        }
    }
    genex_render::texture::TextureData::rgba8(width, height, rgba).expect("normal map")
}

/// A polished, normal-mapped metal sphere under a bright sun through an orthographic camera moved
/// `jitter` pixels to the right: the picture moves by exactly `jitter` pixels everywhere, and the
/// bumps' glints are a pixel or thinner.
fn bumpy_sphere_scene(material: Material, jitter: f32) -> Scene {
    let dx = jitter * FLICKER_VIEW_HEIGHT / FLICKER_HEIGHT as f32;
    let camera = CameraDesc::look_at([dx, 0.0, FLICKER_EYE_DISTANCE], [dx, 0.0, 0.0]).orthographic(FLICKER_VIEW_HEIGHT);
    let mut scene = Scene::new(camera, [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.3, 0.5, 0.81];
    scene.lighting.sun_color = [255, 255, 255];
    scene.lighting.sun_intensity = 4.0;
    scene.lighting.ambient_intensity = 0.2;
    scene.lighting.shadows = false;
    scene.draw(MeshId::SPHERE, scaled([0.0, 0.0, 0.0], [FLICKER_SPHERE; 3]), material);
    scene
}

fn luma(frame: &Capture, x: u32, y: u32) -> f32 {
    let p = pixel(frame, x, y);
    (f32::from(p[0]) + f32::from(p[1]) + f32::from(p[2])) / 3.0
}

/// The flicker between `still` and `moved` (the camera moved half a pixel): how far `moved` is
/// from `still` moved by half a pixel (the mean of two neighbours), as a share of the detail
/// `still` holds (its summed step between neighbours) over the flicker region. A picture filtered to
/// the pixel grid moves smoothly and leaves a small share however much detail it has; a glint
/// thinner than a pixel pops between pixels and leaves about as much as it holds. Both signs of the
/// move are tried; the smaller wins.
fn flicker(still: &Capture, moved: &Capture) -> f32 {
    let (cx, cy) = (still.width() as f32 / 2.0, still.height() as f32 / 2.0);
    let (mut left, mut right, mut detail) = (0.0f32, 0.0f32, 0.0f32);
    for y in 0..still.height() {
        for x in 1..still.width() - 1 {
            if libm::hypotf(x as f32 + 0.5 - cx, y as f32 + 0.5 - cy) > FLICKER_REGION_PX {
                continue;
            }
            let (before, here, after) = (luma(still, x - 1, y), luma(still, x, y), luma(still, x + 1, y));
            let seen = luma(moved, x, y);
            left += (seen - (here + before) / 2.0).abs();
            right += (seen - (here + after) / 2.0).abs();
            detail += (after - here).abs();
        }
    }
    left.min(right) / detail.max(1.0)
}

/// The flicker of the bumpy sphere between the two camera positions, multisampled, with specular
/// AA `on` or off.
fn sphere_flicker(gpu: &Gpu, on: bool) -> f32 {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.specular_aa = on;
    let mut renderer = Renderer::with_options(gpu, FLICKER_WIDTH, FLICKER_HEIGHT, RenderOptions { msaa: true }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality);
    renderer.set_look(look(Tonemapper::KhronosNeutral));
    let normal = renderer.add_texture(gpu, &bump_normal_map(), genex_render::texture::TextureKind::Data).expect("normal map");
    let material = Material::color([200, 200, 200, 255]).with_pbr(1.0, 0.08).with_normal_map(normal, 1.0);
    let suffix = if on { "on" } else { "off" };
    let still = capture(&mut renderer, gpu, &bumpy_sphere_scene(material, 0.0), &format!("flicker-{suffix}-a"));
    let moved = capture(&mut renderer, gpu, &bumpy_sphere_scene(material, FLICKER_JITTER_PX), &format!("flicker-{suffix}-b"));
    flicker(&still, &moved)
}

/// Geometric specular antialiasing measured on frames (G11): a polished metal sphere with a
/// high-frequency normal map, multisampled, flickers less between two camera positions half a
/// pixel apart with specular AA on than off ([`flicker`]: what the move leaves unexplained).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_specular_aa_steadies_a_bumpy_sphere_between_jittered_views() {
    let Some(gpu) = gpu() else { return };
    let mut asked = Quality::off();
    asked.hdr = true;
    asked.specular_aa = true;
    if !specular_aa_drawn(&asked) {
        return;
    }
    let off = sphere_flicker(&gpu, false);
    let on = sphere_flicker(&gpu, true);
    eprintln!("flicker: specular AA off {off:.3}, on {on:.3} (share of the detail the move leaves unexplained)");
    assert!(off >= FLICKER_FLOOR, "the bumpy sphere aliases without specular AA: {off:.3}");
    assert!(on <= off * FLICKER_SHARE, "specular AA steadies the glints: {on:.3} against {off:.3} off");
}

/// `gx_filtered_roughness` of each case, computed by a compute entry appended to the forward
/// module (the same source the forward pipelines are built from).
fn filtered_roughness_on_gpu(gpu: &Gpu, cases: &[(f32, f32, f32)]) -> Vec<f32> {
    let source = format!(
        "{}\n{}",
        genex_render::shaders::FORWARD,
        "
@group(0) @binding(20) var<storage, read> gx_test_cases: array<vec4<f32>>;
@group(0) @binding(21) var<storage, read_write> gx_test_out: array<f32>;

@compute @workgroup_size(1)
fn cs_filtered_roughness(@builtin(global_invocation_id) id: vec3<u32>) {
    let item = gx_test_cases[id.x];
    gx_test_out[id.x] = gx_filtered_roughness(item.x, vec3<f32>(item.y, 0.0, 0.0), vec3<f32>(0.0, item.z, 0.0));
}
"
    );
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("specular aa test"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("specular aa test"),
        layout: None,
        module: &module,
        entry_point: Some("cs_filtered_roughness"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input: Vec<f32> = cases.iter().flat_map(|(r, dx, dy)| [*r, *dx, *dy, 0.0]).collect();
    let bytes = (cases.len() * 4) as u64;
    let cases_buffer = wgpu::util::DeviceExt::create_buffer_init(
        device,
        &wgpu::util::BufferInitDescriptor { label: Some("cases"), contents: bytemuck::cast_slice(&input), usage: wgpu::BufferUsages::STORAGE },
    );
    let out = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("out"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("staging"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("specular aa test"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 20, resource: cases_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 21, resource: out.as_entire_binding() },
        ],
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("specular aa test") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(cases.len() as u32, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&out, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range");
    data.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

/// The IBL shading's cost at 1080p: GPU frame time with the physical sky lighting the scene
/// against the same sky drawn with IBL off (so only the bake's node and the shading differ; an
/// unchanged environment bakes nothing), interleaved rounds, p50 and p95.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_ibl_shading_cost_at_1080p() {
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let (width, height) = (1920, 1080);
    let mut scene = spheres_scene(sun_at(40.0), 2.5);
    for i in 0..60 {
        let (x, z) = ((i % 10) as f32 - 4.5, (i / 10) as f32 * 0.8 + 1.0);
        scene.draw(MeshId::SPHERE, scaled([x, 0.3, z], [0.3, 0.3, 0.3]), Material::color([200, 180, 160, 255]).with_pbr(0.0, 0.4));
    }
    let configs = [("skyIblOff", false), ("skyIbl", true)];
    let mut renderers: Vec<Renderer> = configs
        .iter()
        .map(|(_, ibl)| {
            let mut quality = ibl_quality(QualityPreset::High, true);
            quality.environment.ibl = *ibl;
            let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
            renderer.set_scene_format(SceneFormat::Rgba16Float);
            renderer.set_quality(&quality);
            renderer.set_look(look(Tonemapper::Agx));
            renderer.set_environment(&Environment::sky());
            renderer
        })
        .collect();
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); configs.len()];
    // Each round's median per configuration: the cost is the median over rounds of the paired
    // difference, so a burst of load on the machine lands in one round, not in the verdict.
    let mut round_deltas = Vec::new();
    for round in 0..PERF_ROUNDS {
        let mut medians = [0.0f32; 2];
        for (k, renderer) in renderers.iter_mut().enumerate() {
            let mut times_this_round = Vec::new();
            for frame in 0..80u64 {
                let Some(times) = renderer.arm_frame_timer(&gpu.queue) else {
                    eprintln!("skipped: no timestamp queries");
                    return;
                };
                if round > 0 && frame >= 8 {
                    times_this_round.extend(times);
                }
                renderer.set_frame_index(frame);
                renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
            medians[k] = median(&mut times_this_round.clone());
            landed[k].extend(times_this_round);
        }
        if round > 0 {
            round_deltas.push(medians[1] - medians[0]);
        }
    }
    let added = median(&mut round_deltas);
    let mut fields = vec![format!("\"row\":\"ibl-shading-1080p\",\"adapter\":\"{}\",\"addedMedianMs\":{added:.4}", gpu.receipt().adapter)];
    for ((name, _), times) in configs.iter().zip(&mut landed) {
        times.sort_by(f32::total_cmp);
        let at = |q: f32| times[((times.len() - 1) as f32 * q) as usize];
        fields.push(format!("\"{name}\":{{\"frames\":{},\"p50Ms\":{:.4},\"p95Ms\":{:.4}}}", times.len(), at(0.5), at(0.95)));
    }
    let row = format!("{{{}}}", fields.join(","));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(added <= IBL_BUDGET_MS, "the IBL shading adds {added:.3} ms at 1080p (budget {IBL_BUDGET_MS} ms)");
}

/// The direct light's floor: its camera, its roughness and the sun.
const SMITH_EYE: [f32; 3] = [0.0, 1.5, 3.0];
const SMITH_ROUGHNESS: f32 = 0.7;
const SMITH_SUN: f32 = 3.0;
/// The share a sun-lit floor pixel may differ from the CPU reference (half-float scene).
const SMITH_SHARE: f64 = 0.02;

/// Where the camera ray through pixel (`x`, `y`) of a `width` x `height` frame meets the floor's top
/// (y = 0), for the 45-degree perspective camera at `eye` looking at the origin.
fn floor_hit(eye: [f32; 3], x: u32, y: u32, width: u32, height: u32) -> Option<[f64; 3]> {
    let eye = eye.map(f64::from);
    let normalize = |a: [f64; 3]| {
        let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        a.map(|c| c / l)
    };
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let forward = normalize(eye.map(|c| -c));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let tan = 22.5f64.to_radians().tan();
    let sx = (2.0 * (f64::from(x) + 0.5) / f64::from(width) - 1.0) * tan * f64::from(width) / f64::from(height);
    let sy = (1.0 - 2.0 * (f64::from(y) + 0.5) / f64::from(height)) * tan;
    let dir: [f64; 3] = std::array::from_fn(|i| forward[i] + right[i] * sx + up[i] * sy);
    if dir[1] >= -1e-3 {
        return None;
    }
    let t = -eye[1] / dir[1];
    Some(std::array::from_fn(|i| eye[i] + dir[i] * t))
}

/// The radiance the white metal floor (F0 = 1, so Fresnel is 1) reflects at `p` toward `eye` from
/// a white sun of `irradiance` along the unit `sun`: GGX times the height-correlated Smith
/// visibility (`ibl::smith_ggx_correlated`, the BRDF LUT's term), and the pair (correlated, the
/// Schlick-Smith term the legacy scene keeps).
fn floor_specular(p: [f64; 3], eye: [f32; 3], sun: [f64; 3], roughness: f64, irradiance: f64) -> (f64, f64) {
    let v = {
        let d: [f64; 3] = std::array::from_fn(|i| f64::from(eye[i]) - p[i]);
        let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / l)
    };
    let h = {
        let d: [f64; 3] = std::array::from_fn(|i| v[i] + sun[i]);
        let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / l)
    };
    let (n_dot_v, n_dot_l, n_dot_h) = (v[1].max(1e-4), sun[1], h[1].max(0.0));
    let alpha = roughness * roughness;
    let a2 = alpha * alpha;
    let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    let distribution = a2 / (std::f64::consts::PI * d * d);
    let correlated = genex_render::ibl::smith_ggx_correlated(n_dot_v, n_dot_l, alpha);
    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let schlick = (n_dot_v / (n_dot_v * (1.0 - k) + k)) * (n_dot_l / (n_dot_l * (1.0 - k) + k)) / (4.0 * n_dot_v * n_dot_l);
    let lit = irradiance * n_dot_l;
    (distribution * correlated * lit, distribution * schlick * lit)
}

/// The HDR scene shades direct light with the height-correlated Smith visibility (RQ2.4, G19), the
/// term the BRDF LUT integrates, so the sun and the environment's specular agree: a rough white
/// metal floor under the sun alone equals the CPU reference pixel for pixel, and the reference is
/// one the Schlick-Smith term the legacy scene keeps would miss.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_hdr_scene_shades_the_sun_with_height_correlated_smith() {
    let Some(gpu) = gpu() else { return };
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    let mut floor = renderer(&gpu, WIDTH, HEIGHT, &quality, &Environment::Color);
    let mut scene = Scene::new(CameraDesc::look_at(SMITH_EYE, [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    let sun = {
        let d = [0.0f64, 0.5, -1.0];
        let l = (d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / l)
    };
    scene.lighting.sun_dir = sun.map(|c| c as f32);
    scene.lighting.sun_color = [255, 255, 255];
    scene.lighting.sun_intensity = SMITH_SUN;
    scene.lighting.ambient_intensity = 0.0;
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [20.0, 0.2, 20.0]), Material::color([255, 255, 255, 255]).with_pbr(1.0, SMITH_ROUGHNESS));
    let texels = scene_radiance(&mut floor, &gpu, &scene);
    let (mut worst, mut apart, mut compared) = (0.0f64, 0.0f64, 0usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let Some(p) = floor_hit(SMITH_EYE, x, y, WIDTH, HEIGHT) else { continue };
            if p[0].abs() > 4.0 || p[2].abs() > 4.0 {
                continue;
            }
            let (correlated, schlick) = floor_specular(p, SMITH_EYE, sun, f64::from(SMITH_ROUGHNESS), f64::from(SMITH_SUN));
            let seen = f64::from(texels[(y * WIDTH + x) as usize][1]);
            worst = worst.max((seen - correlated).abs() / correlated.max(1e-3));
            apart = apart.max((schlick - correlated).abs() / correlated.max(1e-3));
            compared += 1;
        }
    }
    eprintln!("smith: {compared} floor pixels, worst share from the correlated reference {worst:.4}; the two terms differ by up to {apart:.4}");
    assert!(compared > 2000, "the floor fills the frame's lower part ({compared} pixels)");
    assert!(apart > 3.0 * SMITH_SHARE, "the row tells the two terms apart: {apart:.4}");
    assert!(worst <= SMITH_SHARE, "the sun's specular is GGX with height-correlated Smith: worst share {worst:.4}");
}

// ---------------------------------------------------------------------------------------------
// RQ2 review rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_hdri_is_drawn_behind_the_scene_where_the_sky_switch_is_on() {
    // Visual review 3: the map lit the scene but node 13 drew nothing behind it, so spheres lit
    // by a blue-sky map stood in front of the clear colour.
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let map = showcase_map();
    let scene = spheres_scene(sun_at(40.0), 2.5);
    let environment = Environment::Hdri(HdriEnvironment::new("env/kloofendal_43d_clear_puresky_1k.hdr"));
    let mut drawn = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, true), &environment);
    drawn.set_environment_map(&gpu, &map).expect("map");
    let frame = capture(&mut drawn, &gpu, &scene, "hdri-backdrop");
    for x in [2, WIDTH / 2, WIDTH - 3] {
        let sky = pixel(&frame, x, 2);
        assert!(sky[2] > sky[0] && sky[2] > 40, "({x}, 2): the map's blue sky behind the scene, not the black clear colour: {sky:?}");
    }
    // The sky switch off: the clear colour, the lighting unchanged.
    let mut plain = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &environment);
    plain.set_environment_map(&gpu, &map).expect("map");
    let switched_off = capture(&mut plain, &gpu, &scene, "hdri-no-backdrop");
    assert!(pixel(&switched_off, WIDTH / 2, 2).iter().all(|c| *c <= 2), "no backdrop without the switch");
    let metal = sphere_top(&frame, 0);
    let same = sphere_top(&switched_off, 0);
    assert!(metal.iter().zip(same).all(|(a, b)| a.abs_diff(b) <= 2), "the backdrop changes no lighting: {metal:?} against {same:?}");
    let mut evidence = renderer(&gpu, 640, 360, &ibl_quality(QualityPreset::High, true), &environment);
    evidence.set_environment_map(&gpu, &map).expect("map");
    let _ = capture(&mut evidence, &gpu, &scene, "hdri-backdrop-evidence");
}

/// An equirect map (`ibl::equirect_direction`'s frame) of a dim blue sky with a small sun towards
/// `sun` of radiance `peak`.
fn map_with_sun(sun: [f32; 3], peak: f32) -> HdriImage {
    let (width, height) = (1024u32, 512u32);
    let disk = libm::cosf(1.5_f32.to_radians());
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            let d = genex_render::ibl::equirect_direction((x as f32 + 0.5) / width as f32, (y as f32 + 0.5) / height as f32);
            let on = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2] > disk;
            let rgb = if on { [peak, peak * 0.95, peak * 0.9] } else if d[1] > 0.0 { [0.15, 0.25, 0.45] } else { [0.12, 0.1, 0.08] };
            [f32_to_f16(rgb[0]), f32_to_f16(rgb[1]), f32_to_f16(rgb[2]), f32_to_f16(1.0)]
        })
        .collect();
    HdriImage { width, height, texels }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_analytic_hdri_lights_and_shadows_the_scene_from_the_map_s_sun() {
    // Visual and contract reviews: `HdriSun::Analytic` clamped the map's sun out of the bake and
    // replaced it with nothing, so the scene kept the frame's own sun wherever the map's was.
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let normalize = |d: [f32; 3]| {
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let map_sun = normalize([0.8, 0.6, 0.0]);
    let map = map_with_sun(map_sun, 3000.0);
    // The frame's own sun comes from the other side.
    let mut scene = Scene::new(CameraDesc::look_at(SPHERES_EYE, [0.0, 0.3, 0.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = normalize([-0.8, 0.6, 0.0]);
    scene.lighting.sun_intensity = 2.5;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [14.0, 0.2, 8.0]), Material::color([140, 140, 140, 255]));
    scene.draw(MeshId::SPHERE, scaled([0.0, 0.45, 0.0], [0.45; 3]), Material::color([200, 200, 200, 255]));
    let floor = |frame: &Capture, x: f32| {
        let (px, py) = project_to(frame, [x, 0.0, 0.3], [0.0, 0.3, 0.0]);
        let [r, g, b] = pixel(frame, px, py);
        u32::from(r) + u32::from(g) + u32::from(b)
    };
    let shadows_toward = |environment: &Environment| {
        let mut lit = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), environment);
        lit.set_environment_map(&gpu, &map).expect("map");
        let frame = capture(&mut lit, &gpu, &scene, "hdri-analytic-sun");
        (floor(&frame, -0.75), floor(&frame, 0.75))
    };
    let analytic = Environment::Hdri(HdriEnvironment::new("env/sun.hdr"));
    let (west, east) = shadows_toward(&analytic);
    assert!(west * 10 < east * 7, "the map's sun (from +x) casts the sphere's shadow towards -x: floor {west} at -x, {east} at +x");
    let kept = Environment::Hdri(HdriEnvironment::new("env/sun.hdr").with_sun(HdriSun::Off));
    let (west, east) = shadows_toward(&kept);
    // The map's own sun stays in its light (its irradiance outweighs the frame's sun), so the
    // frame sun's shadow is only a dimming at +x.
    assert!(east < west, "HdriSun::Off keeps the frame's sun (from -x): floor {west} at -x, {east} at +x");
}

/// Where the world point `p` lands in `frame` for a camera at [`SPHERES_EYE`] looking at `target`.
fn project_to(frame: &Capture, p: [f32; 3], target: [f32; 3]) -> (u32, u32) {
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let normalize = |a: [f32; 3]| {
        let l = dot(a, a).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let forward = normalize(sub(target, SPHERES_EYE));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let d = sub(p, SPHERES_EYE);
    let depth = dot(d, forward);
    let half_height = depth * libm::tanf(22.5f32.to_radians());
    let half_width = half_height * frame.width() as f32 / frame.height() as f32;
    let x = (dot(d, right) / half_width * 0.5 + 0.5) * frame.width() as f32;
    let y = (0.5 - dot(d, up) / half_height * 0.5) * frame.height() as f32;
    (x as u32, y as u32)
}

// ---------------------------------------------------------------------------------------------
// Pass 2 P2-0.11 rows

/// How far the sunlit centre of a rough white metal may be from its single-scatter brightness
/// times `1 / E` (SI-07), as a share.
const COMPENSATION_SHARE: f32 = 0.02;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_rough_metal_sphere_in_the_sun_is_brighter_by_its_energy_compensation() {
    // SI-07, S8, LG-03: direct specular had no multiple-scattering compensation, so a rough metal
    // under the sun lost what its single-scatter lobe does not reflect (E), while the same metal
    // under the sky's split sum kept it. With an environment bound (its BRDF LUT), the sun's
    // specular is times 1 + f0 (1 / E - 1): for white metal (f0 = 1), 1 / E. The flat-colour
    // environment binds the neutral LUT and keeps the single-scatter picture.
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let roughness = 0.8;
    let material = Material::color([255, 255, 255, 255]).with_pbr(1.0, roughness);
    let mut scene = sphere_scene(material, 2.0);
    // The sun behind the camera: the sphere's centre faces both (N = V = L).
    scene.lighting.sun_dir = [0.0, 0.0, 1.0];
    scene.lighting.shadows = false;
    let mut compensated = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &furnace_environment());
    compensated.set_environment_map(&gpu, &constant_map(0.0)).expect("map");
    let with = scene_radiance(&mut compensated, &gpu, &scene);
    let mut single = renderer(&gpu, WIDTH, HEIGHT, &ibl_quality(QualityPreset::High, false), &Environment::Color);
    let without = scene_radiance(&mut single, &gpu, &scene);
    let centre = ((HEIGHT / 2) * WIDTH + WIDTH / 2) as usize;
    let ratio = with[centre][1] / without[centre][1];
    // The LUT's last texel centre along N.V (1 - 0.5 / 128) at the sphere's roughness.
    let [scale, bias] = genex_render::ibl::brdf_lut_reference(1.0 - 0.5 / f64::from(genex_render::ibl::BRDF_LUT_SIZE), f64::from(roughness), 4096);
    let expected = (1.0 / (scale + bias)) as f32;
    eprintln!("rough white metal in the sun: centre {} with the LUT, {} single-scatter: ratio {ratio:.4}, 1 / E {expected:.4}", with[centre][1], without[centre][1]);
    assert!(without[centre][1] > 0.05, "the sun lights the centre: {:?}", without[centre]);
    assert!((ratio - expected).abs() <= COMPENSATION_SHARE * expected, "the centre is {ratio:.4} times brighter, 1 / E is {expected:.4}");
}

/// The smallest share of the floor roughness's peak a polished sphere's reflection of a small sun
/// keeps at roughness 0.0625 (SI-01: a lobe blurred 3 to 6 times its width spread it thin).
const POLISHED_PEAK_SHARE: f32 = 0.3;
/// The share of a reflection's peak a pixel must reach to count in its glow.
const SUN_GLOW_SHARE: f32 = 0.01;
/// The most pixels of the 640 x 360 frame a polished sphere's reflection of the 1.5-degree sun may
/// glow over (above [`SUN_GLOW_SHARE`] of its peak): 116 when its lobe was read from a 32 px
/// radiance cube, 69 from one at half the specular side.
const POLISHED_GLOW_PIXELS: usize = 90;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_polished_sphere_reflects_a_small_sun_with_a_sharp_edge() {
    // SI-01 acceptance: a polished metal sphere (roughness 0.0625) under a map with a 1.5-degree
    // sun kept in it shows the sun as a small bright reflection with a sharp edge, close to the
    // floor roughness's mirror, not a dim smear. Evidence: `ibl-polished-sun-640x360.bgra`.
    let Some(gpu) = gpu() else { return };
    if !ibl_landed() {
        return;
    }
    let sun = {
        let d = [0.25_f32, 0.45, 1.0];
        let length = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        d.map(|c| c / length)
    };
    let map = map_with_sun(sun, 3000.0);
    let environment = Environment::Hdri(HdriEnvironment::new("env/sun.hdr").with_sun(HdriSun::Off));
    let (width, height) = (640, 360);
    let peak_and_core = |roughness: f32, name: &str| {
        let mut lit = renderer(&gpu, width, height, &ibl_quality(QualityPreset::High, false), &environment);
        lit.set_environment_map(&gpu, &map).expect("map");
        let mut scene = sphere_scene(Material::color([235, 235, 235, 255]).with_pbr(1.0, roughness), 0.0);
        scene.lighting.shadows = false;
        let texels = scene_radiance(&mut lit, &gpu, &scene);
        let frame = lit.capture(&gpu).expect("capture");
        write_evidence(name, &frame);
        let peak = texels.iter().map(|t| t[1]).fold(0.0_f32, f32::max);
        let core = texels.iter().filter(|t| t[1] > 0.5 * peak).count();
        let glow = texels.iter().filter(|t| t[1] > SUN_GLOW_SHARE * peak).count();
        (peak, core, glow)
    };
    let (mirror_peak, mirror_core, mirror_glow) = peak_and_core(0.0, "ibl-mirror-sun");
    let (polished_peak, polished_core, polished_glow) = peak_and_core(0.0625, "ibl-polished-sun");
    eprintln!(
        "small sun on a metal sphere: floor roughness peak {mirror_peak:.1} ({mirror_core} px over half, {mirror_glow} over {SUN_GLOW_SHARE}), 0.0625 peak {polished_peak:.1} ({polished_core} px over half, {polished_glow} over {SUN_GLOW_SHARE})"
    );
    assert!(polished_peak >= POLISHED_PEAK_SHARE * mirror_peak, "the polished reflection's peak {polished_peak} against the mirror's {mirror_peak}");
    assert!(polished_glow <= POLISHED_GLOW_PIXELS, "the polished reflection glows over {polished_glow} pixels (the mirror's over {mirror_glow})");
}
