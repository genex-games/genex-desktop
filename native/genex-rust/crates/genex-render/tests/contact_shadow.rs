//! RQ4.7: screen-space contact shadows for the sun. The march (shaders/post/contact_shadow.wgsl)
//! runs on the depth the renderer's own prepass draws for a pebble on a plane under a low sun,
//! with the high preset's cascaded shadows: the pebble's shadow where it meets the ground is below
//! the maps' reach at that scale, and the mask holds it. Contact shadows off leave the frame the
//! previous goldens hold, byte for byte.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test contact_shadow -- --ignored metal
//!
//! The golden lives in `tests/fixtures/render-goldens/contact-shadow/base.bgra` (the mask as grey
//! BGRA, top row first, at half the 256x144 scene); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites it
//! instead. `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames and masks (raw BGRA);
//! `GENEX_PERF_OUT` receives the cost row as JSON.

use std::path::{Path, PathBuf};

use genex_render::abi::RenderInputs;
use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::post::contact_shadow::{
    ContactShadowCamera, ContactShadowFacts, ContactShadowFrame, GpuContactShadowParams, MaskImage, STEPS, contact_shadow_gpu_ms, contact_shadow_masks, mask_size,
};
use genex_render::prepass::ExtensionDemand;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Look, Quality, QualityPreset, RenderFeature, SceneFormat, ShadowFormat};
use genex_render::{CullPath, Gpu, Renderer};
use glam::{Mat4, Vec3};

const WIDTH: u32 = 256;
const HEIGHT: u32 = 144;
/// A golden texel may differ by this much (another Apple GPU family rounds differently).
const GOLDEN_TOLERANCE: u8 = 3;
/// Mask texels allowed beyond the tolerance, of 9216 (edges where a ray just grazes the pebble).
const GOLDEN_OUTLIER_TEXELS: usize = 46;
/// The contact-shadow budget at 1080p, half resolution (plan §2.5), GPU ms.
const BUDGET_MS: f32 = 0.3;
/// Samples the cost row takes.
const COST_SAMPLES: u32 = 30;

/// The pebble's side and where it sits on the ground (y = 0). Since the cascades' light-facing
/// normal offset (P2-0.3) a 2 cm pebble's shadow reaches its base in the maps (half the light
/// kept); a 1.2 cm one's still does not, and the march holds it (P2-0.7; the head's half-size mask
/// lost a third of it).
const PEBBLE: f32 = 0.012;
const PEBBLE_AT: Vec3 = Vec3::new(0.0, 0.0, 0.0);
/// A low sun behind the pebble on the left: its shadow falls towards the camera on the right.
const SUN: [f32; 3] = [-0.55, 0.35, -0.6];
const EYE: Vec3 = Vec3::new(0.05, 0.14, 0.27);
const TARGET: Vec3 = Vec3::new(0.015, 0.0, 0.015);

// ---------------------------------------------------------------------------------------------
// Fixtures

fn camera() -> CameraDesc {
    CameraDesc::look_at(EYE.to_array(), TARGET.to_array())
}

/// The scene's camera as the renderer draws it on the HDR path (reverse-Z, the camera's far plane).
fn march_camera() -> ContactShadowCamera {
    let desc = camera();
    let view = glam::camera::rh::view::look_at_mat4(EYE, TARGET, Vec3::Y);
    let aspect = WIDTH as f32 / HEIGHT as f32;
    let proj = glam::camera::rh::proj::directx::perspective(desc.fovy_degrees.to_radians(), aspect, desc.far, desc.near);
    assert!((proj * view).abs_diff_eq(desc.projection(aspect, true), 1e-5), "the march sees the renderer's camera");
    ContactShadowCamera { view, proj }
}

/// A pebble `side` world units wide on a grey plane under the low sun.
fn pebble_scene(side: f32) -> Scene {
    let mut scene = Scene::new(camera(), [120, 160, 210, 255]);
    scene.lighting.sun_dir = SUN;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [12.0, 0.2, 12.0]), Material::color([200, 200, 195, 255]));
    let centre = PEBBLE_AT + Vec3::new(0.0, side * 0.5, 0.0);
    scene.draw(MeshId::CUBE, scaled(centre.to_array(), [side; 3]), Material::color([90, 80, 70, 255]));
    scene
}

/// The desktop high preset's shadow maps and filter in four cascades on the HDR path, with the
/// prepass allowed and nothing else on: the frame contact shadows are measured against. `shadows`
/// false switches the maps off.
fn quality(shadows: bool) -> Quality {
    let high = preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.shadows = high.shadows;
    quality.shadows.cascades = 4;
    quality.shadows.enabled = shadows;
    quality.set_feature(RenderFeature::Prepass, true);
    quality
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

/// The harness runs rows on parallel threads: every GPU row shares this lock and the cost row
/// takes it alone, so its timed passes never share the GPU with another row's work.
static GPU_TURN: std::sync::RwLock<()> = std::sync::RwLock::new(());

fn gpu_shared() -> std::sync::RwLockReadGuard<'static, ()> {
    GPU_TURN.read().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn gpu_alone() -> std::sync::RwLockWriteGuard<'static, ()> {
    GPU_TURN.write().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

/// A mask as grey BGRA, top row first.
fn mask_bgra(mask: &MaskImage) -> Vec<u8> {
    mask.visibility.iter().flat_map(|&v| [v, v, v, 255]).collect()
}

/// One frame of `scene` under `quality`: its capture and the prepass depth.
fn render(gpu: &Gpu, scene: &Scene, quality: &Quality) -> (Capture, Vec<f32>) {
    let mut renderer = Renderer::new(gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(quality);
    renderer.set_depth_readback(true);
    // A Level-3 pass declaring depth asks for the prepass whatever else is on.
    renderer.set_prepass_demand(ExtensionDemand { custom_inputs: RenderInputs::DEPTH, ..ExtensionDemand::default() });
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_prepass().is_some(), "the prepass ran");
    let depth = renderer.read_prepass_depth(gpu).expect("prepass depth");
    (renderer.capture(gpu).expect("capture"), depth)
}

fn facts(frame_index: u64, taa: bool) -> ContactShadowFacts {
    ContactShadowFacts { sun_dir: SUN, frame_index, taa, depth_reversed: true }
}

/// The pixel `world` projects to on an image of `size`.
fn pixel(size: (u32, u32), world: Vec3) -> (u32, u32) {
    let clip = march_camera().proj * march_camera().view * world.extend(1.0);
    let (u, v) = (clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    ((u * size.0 as f32) as u32, (v * size.1 as f32) as u32)
}

/// Ground points in the pebble's shadow right at its base: just past its shadowed sides, along the
/// sun's direction on the ground.
fn base_points(side: f32) -> Vec<Vec3> {
    let away = -Vec3::new(SUN[0], 0.0, SUN[2]).normalize();
    let across = Vec3::new(-away.z, 0.0, away.x);
    let edge = PEBBLE_AT + away * (side * 0.5 * 1.25 + 0.006);
    [-0.25f32, 0.0, 0.25].iter().map(|k| edge + across * side * *k).collect()
}

/// An open ground point far from the pebble.
const OPEN: Vec3 = Vec3::new(-0.06, 0.0, 0.08);

fn luma(capture: &Capture, at: (u32, u32)) -> f32 {
    let i = ((at.1 * WIDTH + at.0) * 4) as usize;
    let p = &capture.bgra()[i..i + 3];
    p.iter().map(|&c| f32::from(c)).sum::<f32>() / 3.0
}

/// The mean visibility of the mask over the base points.
fn base_visibility(mask: &MaskImage, side: f32) -> f32 {
    let points = base_points(side);
    points.iter().map(|p| pixel(mask.size, *p)).map(|(x, y)| mask.at(x, y)).sum::<f32>() / points.len() as f32
}

/// How much of the shadowless frame's light the shadowed frame keeps over the base points.
fn base_light_kept(shaded: &Capture, lit: &Capture, side: f32) -> f32 {
    let points = base_points(side);
    let kept: f32 = points.iter().map(|p| pixel((WIDTH, HEIGHT), *p)).map(|at| luma(shaded, at) / luma(lit, at).max(1.0)).sum();
    kept / points.len() as f32
}

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens")
}

/// Compare `mask` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_mask_golden(name: &str, mask: &MaskImage) {
    let bytes = mask_bgra(mask);
    write_evidence(&format!("contact-shadow-{name}.bgra"), &bytes);
    let path = goldens_dir().join("contact-shadow").join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().expect("folder")).expect("goldens folder");
        std::fs::write(&path, &bytes).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), bytes.len(), "{name}: mask size");
    let outliers = golden.chunks(4).zip(bytes.chunks(4)).filter(|(a, b)| a[0].abs_diff(b[0]) > GOLDEN_TOLERANCE).count();
    assert!(outliers <= GOLDEN_OUTLIER_TEXELS, "{name}: {outliers} texels differ from the golden by more than {GOLDEN_TOLERANCE}");
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn contact_shadows_are_a_high_and_ultra_feature_on_desktops() {
    for tier in PerformanceTier::ALL {
        let class = DeviceClass::new(FormFactor::Desktop, tier);
        for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let on = preset_quality(preset, class).contact_shadows;
            let expected = matches!(preset, QualityPreset::High | QualityPreset::Ultra);
            assert_eq!(on, expected, "{preset:?} on {class:?}");
        }
    }
    assert!(!Quality::off().contact_shadows, "the off preset is the old renderer");
}

fn wgsl_sizes(source: &str, name: &str) -> Vec<usize> {
    let module = naga::front::wgsl::parse_str(source).expect("parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.types.iter().filter(|(_, ty)| ty.name.as_deref() == Some(name)).map(|(handle, _)| layouter[handle].size as usize).collect()
}

#[test]
fn the_march_row_equals_the_wgsl_struct_and_the_shader_validates() {
    let source = genex_render::shaders::CONTACT_SHADOW;
    assert_eq!(wgsl_sizes(source, "ContactShadowParams"), [size_of::<GpuContactShadowParams>()]);
    let module = naga::front::wgsl::parse_str(source).expect("parses");
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).expect("validates under core");
}

#[test]
fn the_base_points_lie_in_the_pebbles_shadow_and_the_open_point_does_not() {
    let sun = Vec3::from(SUN).normalize();
    let half = PEBBLE * 0.5;
    let hits = |p: Vec3| {
        // March from p towards the sun through the pebble's box.
        (1..=400).map(|i| p + sun * (i as f32 * 0.001)).any(|q| q.x.abs() <= half && q.z.abs() <= half && (0.0..=PEBBLE).contains(&q.y))
    };
    for p in base_points(PEBBLE) {
        assert!(hits(p), "{p} is shadowed by the pebble");
    }
    assert!(!hits(OPEN));
    assert!(mask_size((WIDTH, HEIGHT)) == (128, 72) && STEPS >= 8);
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_pebble_gets_a_contact_shadow_at_its_base_that_the_cascades_miss() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let scene = pebble_scene(PEBBLE);
    let (shaded, depth) = render(&gpu, &scene, &quality(true));
    let (lit, _) = render(&gpu, &scene, &quality(false));
    write_evidence("pebble-cascades.bgra", shaded.bgra());
    write_evidence("pebble-unshadowed.bgra", lit.bgra());
    // Four cascades of the high preset's maps leave the pebble's base lit: below a map texel and its bias.
    let kept = base_light_kept(&shaded, &lit, PEBBLE);
    assert!(kept > 0.9, "the cascades already shadow the base ({kept} of the light kept): pick a smaller pebble");
    let frame = ContactShadowFrame { depth, camera: march_camera(), facts: facts(0, false) };
    let mask = contact_shadow_masks(&gpu, &Look::default(), (WIDTH, HEIGHT), &[frame]).expect("mask").remove(0);
    let base = base_visibility(&mask, PEBBLE);
    let (ox, oy) = pixel(mask.size, OPEN);
    assert!(base < 0.25, "the base is in contact shadow (visibility {base})");
    assert_eq!(mask.at(ox, oy), 1.0, "open ground is unshadowed");
    let lit_texels = mask.visibility.iter().filter(|&&v| v == 255).count();
    assert!(lit_texels as f32 > 0.9 * mask.visibility.len() as f32, "the shadow stays at the pebble ({lit_texels} lit)");
    check_mask_golden("base", &mask);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_mask_is_the_same_bits_every_frame_without_taa_and_turns_with_the_frame_under_it() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let (_, depth) = render(&gpu, &pebble_scene(PEBBLE), &quality(true));
    let frame = |index, taa| ContactShadowFrame { depth: depth.clone(), camera: march_camera(), facts: facts(index, taa) };
    let look = Look::default();
    let still = contact_shadow_masks(&gpu, &look, (WIDTH, HEIGHT), &[frame(0, false), frame(7, false)]).expect("masks");
    assert_eq!(still[0], still[1], "no noise without TAA: the frame index changes nothing");
    let temporal = contact_shadow_masks(&gpu, &look, (WIDTH, HEIGHT), &[frame(1, true), frame(2, true), frame(1, true)]).expect("masks");
    assert_ne!(temporal[0], temporal[1], "under TAA the start turns with the frame");
    assert_eq!(temporal[0], temporal[2], "the same frame index is the same mask");
    assert!(base_visibility(&temporal[1], PEBBLE) < 0.5, "noise keeps the contact shadow");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_longer_ray_reaches_further_and_the_sky_is_never_shadowed() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    // The pan row's 8 cm stone: its shadow is longer than the short ray, and both rays' steps are
    // finer than it (a fixed step count spreads a long ray thin over a small caster).
    let (_, depth) = render(&gpu, &pebble_scene(PAN_STONE), &quality(true));
    let frame = ContactShadowFrame { depth: depth.clone(), camera: march_camera(), facts: facts(0, false) };
    let shadowed = |look: &Look| {
        let mask = contact_shadow_masks(&gpu, look, (WIDTH, HEIGHT), std::slice::from_ref(&frame)).expect("mask").remove(0);
        mask.visibility.iter().filter(|&&v| v < 128).count()
    };
    let short = shadowed(&Look::default().with_contact_shadow_length(0.05));
    let long = shadowed(&Look::default().with_contact_shadow_length(0.5));
    assert!(short > 0 && long > short, "a longer ray shadows more ground: {short} vs {long}");
    let sky = ContactShadowFrame { depth: vec![0.0; depth.len()], ..frame.clone() };
    let mask = contact_shadow_masks(&gpu, &Look::default(), (WIDTH, HEIGHT), &[sky]).expect("mask").remove(0);
    assert!(mask.visibility.iter().all(|&v| v == 255), "nothing drawn, nothing shadowed");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_contact_shadows_off_draw_the_previous_cascade_golden_byte_for_byte() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    // The 4-cascade golden's street and quality (tests/shadow_cascades.rs), contact shadows off.
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.5, 8.0], [0.0, 0.5, -6.0]), [120, 160, 210, 255]);
    scene.lighting.sun_dir = [0.6, 0.55, 0.3];
    scene.lighting.shadow_distance = 60.0;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -25.0], [24.0, 0.2, 70.0]), Material::color([210, 210, 200, 255]));
    for i in 0..12 {
        let z = 2.0 - i as f32 * 5.0;
        let side = if i % 2 == 0 { -2.5 } else { 2.5 };
        scene.draw(MeshId::CUBE, scaled([side, 0.5, z], [1.0, 2.0, 1.0]), Material::color([200, 70, 60, 255]));
        scene.draw(MeshId::CUBE, scaled([-side * 1.6, 1.5, z - 2.0], [0.2, 4.0, 0.2]), Material::color([60, 60, 70, 255]));
        scene.draw(MeshId::SPHERE, scaled([0.0, 0.1, z - 1.0], [0.7; 3]), Material::color([60, 170, 90, 255]));
    }
    let mut quality = Quality::off();
    quality.shadows.cascades = 4;
    quality.shadows.map_size = 2048;
    quality.shadows.format = ShadowFormat::Depth32;
    quality.shadows.far_cadence = 1;
    assert!(!quality.contact_shadows);
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.set_quality(&quality);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let capture = renderer.capture(&gpu).expect("capture");
    write_evidence("cascades-4-contact-off.bgra", capture.bgra());
    let golden = std::fs::read(goldens_dir().join("shadows/cascades-4.bgra")).expect("the 4-cascade golden");
    let differing = golden.chunks(4).zip(capture.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    assert_eq!(differing, 0, "contact shadows off changed {differing} pixels of the previous golden");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_contact_shadows_cost_at_most_0_3_ms_at_1080p_half_res() {
    let _turn = gpu_alone();
    let Some(gpu) = gpu() else { return };
    let render = (1920, 1080);
    // The pebble frame at 1080p: its depth, scaled up nearest (the march's cost is per texel).
    let (_, depth) = render_scene_depth(&gpu, render);
    let camera = {
        let desc = camera();
        let view = glam::camera::rh::view::look_at_mat4(EYE, TARGET, Vec3::Y);
        let proj = glam::camera::rh::proj::directx::perspective(desc.fovy_degrees.to_radians(), render.0 as f32 / render.1 as f32, desc.far, desc.near);
        ContactShadowCamera { view, proj }
    };
    let frame = ContactShadowFrame { depth, camera, facts: facts(0, false) };
    let Some(mut costs) = contact_shadow_gpu_ms(&gpu, &Look::default(), render, &frame, COST_SAMPLES).expect("cost") else {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    };
    costs.sort_by(f32::total_cmp);
    let at = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
    let (p50, p95) = (at(0.5), at(0.95));
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let row = format!(
            "{{\"row\":\"contact-shadows\",\"render\":[{},{}],\"mask\":[{},{}],\"steps\":{STEPS},\"samples\":{},\"p50Ms\":{p50:.4},\"p95Ms\":{p95:.4},\"budgetMs\":{BUDGET_MS},\"adapter\":\"{}\"}}\n",
            render.0,
            render.1,
            render.0 / 2,
            render.1 / 2,
            costs.len(),
            gpu.receipt().adapter
        );
        std::fs::write(path, row).expect("perf row");
    }
    assert!(p50 <= BUDGET_MS, "contact shadows take {p50:.3} ms at 1080p (budget {BUDGET_MS})");
}

// ---------------------------------------------------------------------------------------------
// Ray-cast scenes (P2-0.7): depth for any camera, sub-pixel jitter included

/// A box standing on the ground: its centre and half extents.
#[derive(Clone, Copy, Debug)]
struct Block {
    centre: Vec3,
    half: Vec3,
}

impl Block {
    /// A cube of `side` resting on the ground at `at` (y ignored).
    fn resting(at: Vec3, side: f32) -> Block {
        Block { centre: Vec3::new(at.x, side * 0.5, at.z), half: Vec3::splat(side * 0.5) }
    }

    /// The nearest positive distance along `dir` from `origin` into the box (slab test).
    fn hit(&self, origin: Vec3, dir: Vec3) -> Option<f32> {
        let inv = dir.recip();
        let a = (self.centre - self.half - origin) * inv;
        let b = (self.centre + self.half - origin) * inv;
        let (near, far) = (a.min(b).max_element(), a.max(b).min_element());
        (far >= near.max(0.0)).then_some(near.max(0.0))
    }
}

/// The nearest distance along `dir` from `origin` to the ground (y = 0) or one of `blocks`.
fn nearest_hit(origin: Vec3, dir: Vec3, blocks: &[Block]) -> Option<f32> {
    let ground = (dir.y < 0.0).then(|| -origin.y / dir.y);
    blocks.iter().filter_map(|b| b.hit(origin, dir)).chain(ground).min_by(f32::total_cmp)
}

/// A perspective camera at `eye` looking at `target` on a `size` frame, as the HDR path draws it
/// (reverse-Z, the scene camera's planes), its projection moved by `jitter` render pixels (y down).
fn cast_camera(eye: Vec3, target: Vec3, size: (u32, u32), jitter: [f32; 2]) -> ContactShadowCamera {
    let desc = camera();
    let view = glam::camera::rh::view::look_at_mat4(eye, target, Vec3::Y);
    let proj = glam::camera::rh::proj::directx::perspective(desc.fovy_degrees.to_radians(), size.0 as f32 / size.1 as f32, desc.far, desc.near);
    let shift = Mat4::from_translation(Vec3::new(jitter[0] * 2.0 / size.0 as f32, -jitter[1] * 2.0 / size.1 as f32, 0.0));
    ContactShadowCamera { view, proj: shift * proj }
}

/// The device depth (reverse-Z, 0 for nothing) of the ground and `blocks` through `camera` at the
/// centre of every pixel of a `size` frame, top row first: a prepass depth without the renderer.
fn cast_depth(camera: &ContactShadowCamera, size: (u32, u32), blocks: &[Block]) -> Vec<f32> {
    let view_proj = camera.proj * camera.view;
    let inverse = view_proj.inverse();
    let eye = camera.view.inverse().w_axis.truncate();
    let depth_at = |x: u32, y: u32| {
        let ndc = Vec3::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5);
        let dir = (inverse.project_point3(ndc) - eye).normalize();
        nearest_hit(eye, dir, blocks).map_or(0.0, |t| view_proj.project_point3(eye + dir * t).z)
    };
    (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|(x, y)| depth_at(x, y)).collect()
}

/// Whether ground point `p` is in `block`'s shadow robustly: the ray towards the sun meets the
/// block shrunk by `margin` within `reach` (so ground within `margin` of `p` is shadowed too).
fn deep_in_shadow(p: Vec3, block: &Block, margin: f32, reach: f32) -> bool {
    let core = Block { half: block.half - Vec3::splat(margin), ..*block };
    core.hit(p, Vec3::from(SUN).normalize()).is_some_and(|t| t <= reach)
}

/// The mask texel ground point `p` falls in through `camera` (None off the mask or behind).
fn mask_texel(camera: &ContactShadowCamera, mask: (u32, u32), p: Vec3) -> Option<(u32, u32)> {
    let clip = camera.proj * camera.view * p.extend(1.0);
    let (u, v) = (clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    let inside = clip.w > 0.0 && (0.0..1.0).contains(&u) && (0.0..1.0).contains(&v);
    inside.then_some(((u * mask.0 as f32) as u32, (v * mask.1 as f32) as u32))
}

/// Ground points on a `step` grid within `radius` of `block` that lie deep in its contact shadow
/// (within `reach` of it along the sun) and that `camera` sees (not hidden by the block).
fn shadow_points(block: &Block, camera: &ContactShadowCamera, step: f32, radius: f32, reach: f32) -> Vec<Vec3> {
    let eye = camera.view.inverse().w_axis.truncate();
    let n = (radius / step) as i32;
    let grid = (-n..=n).flat_map(|i| (-n..=n).map(move |j| Vec3::new(block.centre.x + i as f32 * step, 0.0, block.centre.z + j as f32 * step)));
    grid.filter(|p| deep_in_shadow(*p, block, 0.005, reach))
        .filter(|p| {
            let to = *p - eye;
            nearest_hit(eye, to.normalize(), std::slice::from_ref(block)).is_none_or(|t| t >= to.length() - 1e-3)
        })
        .collect()
}

#[test]
fn the_ray_cast_depth_matches_the_projection_of_the_ground_and_the_block() {
    let size = (64, 36);
    let block = Block::resting(Vec3::ZERO, 0.08);
    let camera = cast_camera(EYE, TARGET, size, [0.0, 0.0]);
    let depth = cast_depth(&camera, size, &[block]);
    // The block's top centre and an open ground point each read their own depth (reverse-Z depth
    // is inversely proportional to view distance: within a pixel's reach of it).
    for p in [Vec3::new(0.0, 0.08, 0.0), OPEN] {
        let (x, y) = mask_texel(&camera, size, p).expect("on screen");
        let expected = (camera.proj * camera.view).project_point3(p).z;
        let ratio = depth[(y * size.0 + x) as usize] / expected;
        assert!((ratio - 1.0).abs() < 0.05, "{p}: depth {ratio} of its own");
    }
    assert!(depth.iter().all(|d| (0.0..=1.0).contains(d)));
    let points = shadow_points(&block, &camera, 0.004, 0.25, 0.1);
    assert!(points.len() > 20 && points.iter().all(|p| deep_in_shadow(*p, &block, 0.0, 0.25)));
}

/// GA (renderer pass 2): open ground with nothing on it casts no contact shadow onto itself, at the
/// screen's border too. A border texel's neighbour beyond the screen read as the texel itself (the
/// clamped read), its slope came out zero and with it the tolerance that keeps a slanted surface
/// from shadowing itself: Lakeside's dolly darkened the frame's left column by half for one frame
/// (the shadows-on run 20 against the shadows-off run's 41).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_open_ground_casts_no_contact_shadow_on_itself_at_the_screen_border() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let look = Look::default().with_contact_shadow_length(FAR_RAY);
    let camera = cast_camera(FAR_EYE, FAR_CRATE, FAR_SIZE, [0.0, 0.0]);
    let depth = cast_depth(&camera, FAR_SIZE, &[]);
    // Low suns from either side and behind, each under TAA's noise for a few frames.
    let suns = [[-0.55, 0.12, -0.6], [0.55, 0.12, -0.6], [0.1, 0.12, 0.9]];
    let frames: Vec<_> = suns
        .iter()
        .flat_map(|sun| (0..4u64).map(move |f| (*sun, f)))
        .map(|(sun_dir, frame_index)| ContactShadowFrame { depth: depth.clone(), camera, facts: ContactShadowFacts { sun_dir, frame_index, taa: true, depth_reversed: true } })
        .collect();
    let masks = contact_shadow_masks(&gpu, &look, FAR_SIZE, &frames).expect("masks");
    let (width, height) = masks[0].size;
    let border = |x: u32, y: u32| x == 0 || y == 0 || x + 1 == width || y + 1 == height;
    let mut worst = (1.0f32, 0usize, 0u32, 0u32, false);
    for (k, mask) in masks.iter().enumerate() {
        for y in 0..height {
            for x in 0..width {
                let v = mask.at(x, y);
                if v < worst.0 {
                    worst = (v, k, x, y, border(x, y));
                }
            }
        }
    }
    write_evidence("open-ground-border.bgra", &mask_bgra(&masks[worst.1]));
    let (visibility, frame, x, y, on_border) = worst;
    assert!(visibility >= 0.99, "open ground shadows itself: visibility {visibility:.3} at mask texel ({x}, {y}) (border {on_border}) in frame {frame} of {}", masks.len());
}

/// The pan row's render size and frames.
const PAN_SIZE: (u32, u32) = (512, 288);
const PAN_FRAMES: u32 = 128;
/// The stone the pan row leaves behind: 8 cm, its contact shadow inside the default ray.
const PAN_STONE: f32 = 0.08;
/// The most a deep-shadow ground point's mask may change from one pan frame to the next, per mask
/// texel the point moved (at least one; P2-0.7: no pop at the screen border): about twice the edge
/// fade's steepest slope (2 across its band of a twelfth of the screen, 0.094 a texel of 256), as
/// hits land on whole depth texels. The head popped from shadowed to lit in one frame.
const PAN_STEP_PER_TEXEL_MAX: f32 = 0.2;

/// The camera of pan frame `frame`: moved right along its own axis by 1.5 mm a frame (under one
/// mask texel at the stone), so the stone, a quarter of the way in from the left, leaves the
/// screen's left edge while the shadow it casts towards the camera (to its right) is still on it.
fn pan_camera(frame: u32) -> ContactShadowCamera {
    let right = (TARGET - EYE).cross(Vec3::Y).normalize();
    let shift = right * (0.05 + 0.0015 * frame as f32);
    cast_camera(EYE + shift, TARGET + shift, PAN_SIZE, [0.0, 0.0])
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_pan_fades_contact_shadows_out_at_the_screen_border_without_a_pop() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let stone = Block::resting(Vec3::ZERO, PAN_STONE);
    let look = Look::default();
    // Ground deep in the stone's contact shadow, well within the fully shadowed half of the ray.
    let points = shadow_points(&stone, &pan_camera(0), 0.003, 0.2, look.contact_shadow_length * 0.4);
    assert!(points.len() > 30, "{} points", points.len());
    let frames: Vec<_> = (0..PAN_FRAMES).map(|f| ContactShadowFrame { depth: cast_depth(&pan_camera(f), PAN_SIZE, &[stone]), camera: pan_camera(f), facts: facts(0, false) }).collect();
    let masks = contact_shadow_masks(&gpu, &look, PAN_SIZE, &frames).expect("masks");
    let size = masks[0].size;
    // The stone leaves the screen during the pan, while some of its shadow is still on it.
    let stone_on = |f: u32| mask_texel(&pan_camera(f), size, stone.centre).is_some();
    assert!(stone_on(0) && !stone_on(PAN_FRAMES - 1), "the stone leaves the screen");
    let texel = |f: u32, p: Vec3| mask_texel(&pan_camera(f), size, p).filter(|(x, _)| *x >= 1);
    let visible = |f: u32, p: Vec3| texel(f, p).map(|(x, y)| masks[f as usize].at(x, y));
    // Each tracked step: (change per texel moved, frame, point).
    let steps: Vec<(f32, u32, Vec3)> = points
        .iter()
        .flat_map(|p| (1..PAN_FRAMES).map(move |f| (f, *p)))
        .filter_map(|(f, p)| {
            let (Some(a), Some(b)) = (texel(f - 1, p), texel(f, p)) else { return None };
            let moved = (a.0.abs_diff(b.0) + a.1.abs_diff(b.1)).max(1) as f32;
            Some(((masks[f as usize].at(b.0, b.1) - masks[f as usize - 1].at(a.0, a.1)).abs() / moved, f, p))
        })
        .collect();
    assert!(steps.len() > points.len() * 8, "points stay on screen while the stone leaves ({})", steps.len());
    let (worst, frame, point) = steps.iter().copied().fold((0.0, 0, Vec3::ZERO), |held, step| if step.0 > held.0 { step } else { held });
    let means: String = (0..PAN_FRAMES)
        .map(|f| {
            let on: Vec<f32> = points.iter().filter_map(|p| visible(f, *p)).collect();
            format!("{f} stone_on={} points_on={} mean_visibility={:.3}\n", stone_on(f), on.len(), on.iter().sum::<f32>() / on.len().max(1) as f32)
        })
        .collect();
    let series: Vec<String> = (0..PAN_FRAMES).map(|f| format!("{f}:{:?}:{:.3}", texel(f, point), visible(f, point).unwrap_or(-1.0))).collect();
    write_evidence("pan-border.txt", format!("worst step {worst:.3} a texel at frame {frame} point {point}\nworst point: {}\n{means}", series.join(" ")).as_bytes());
    for f in [0, frame.saturating_sub(1), frame] {
        write_evidence(&format!("pan-{f}.bgra"), &mask_bgra(&masks[f as usize]));
    }
    assert!(worst <= PAN_STEP_PER_TEXEL_MAX, "a shadowed ground point pops by {worst:.3} a texel at pan frame {frame} ({point})");
}

/// The jitter row: a 1 m crate 20 m from a camera 25 degrees above the ground, at the render size
/// where one mask texel spans about 5.5 cm across there (more than the 5 cm fixed thickness) and
/// 13 cm along the ground, under a 1 m ray.
const FAR_SIZE: (u32, u32) = (1024, 576);
const FAR_EYE: Vec3 = Vec3::new(3.0, 8.5, 6.0);
const FAR_CRATE: Vec3 = Vec3::new(0.0, 0.0, -12.0);
const FAR_CRATE_SIDE: f32 = 1.0;
const FAR_RAY: f32 = 1.0;
/// TAA's cycle length the row jitters over.
const FAR_FRAMES: u64 = 8;
/// How far (world units) a ground receiver must be inside the crate's contact shadow, or outside
/// its reach, to be judged: texels nearer the shadow's edge may go either way.
const FAR_MARGIN: f32 = 0.05;
/// What the crate's contact shadow must hold in every jitter frame: the mean darkness of the ground
/// deep in it, how much that mean may move between frames, and the mean darkness it may put on
/// open ground near the crate (the head's binary, fixed-thickness hit loses the far shadow and
/// toggles with the jitter).
const FAR_DARKNESS_MIN: f32 = 0.6;
const FAR_DARKNESS_SPREAD_MAX: f32 = 0.1;
const FAR_FALSE_MAX: f32 = 0.05;

/// The ground point the march rebuilds for mask texel (`x`, `y`): the depth texel under the mask
/// texel's centre (`gx_contact_texel_centre`), or None when that texel shows the crate or nothing.
fn far_receiver(camera: &ContactShadowCamera, mask: (u32, u32), x: u32, y: u32, blocks: &[Block]) -> Option<Vec3> {
    let inverse = (camera.proj * camera.view).inverse();
    let eye = camera.view.inverse().w_axis.truncate();
    let (px, py) = (2 * x + 1, 2 * y + 1);
    let ndc = Vec3::new((px as f32 + 0.5) / (2 * mask.0) as f32 * 2.0 - 1.0, 1.0 - (py as f32 + 0.5) / (2 * mask.1) as f32 * 2.0, 0.5);
    let dir = (inverse.project_point3(ndc) - eye).normalize();
    let p = eye + dir * nearest_hit(eye, dir, blocks)?;
    (p.y.abs() < 1e-3).then_some(p)
}

/// One jitter frame's judgement: (mean darkness deep in the shadow, mean darkness on open ground
/// near the crate, texels judged deep).
fn far_judge(mask: &MaskImage, camera: &ContactShadowCamera, block: &Block) -> (f32, f32, usize) {
    let sun = Vec3::from(SUN).normalize();
    let wide = Block { half: block.half + Vec3::splat(FAR_MARGIN), ..*block };
    let (mut deep, mut open) = (Vec::new(), Vec::new());
    for y in 0..mask.size.1 {
        for x in 0..mask.size.0 {
            let Some(p) = far_receiver(camera, mask.size, x, y, std::slice::from_ref(block)) else { continue };
            let darkness = 1.0 - mask.at(x, y);
            if deep_in_shadow(p, block, FAR_MARGIN, FAR_RAY * 0.4) {
                deep.push(darkness);
            } else if (p - block.centre).length() < 2.0 && wide.hit(p, sun).is_none_or(|t| t > FAR_RAY) {
                open.push(darkness);
            }
        }
    }
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
    (mean(&deep), mean(&open), deep.len())
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_far_crates_contact_shadow_holds_under_sub_pixel_jitter() {
    let _turn = gpu_shared();
    let Some(gpu) = gpu() else { return };
    let block = Block::resting(FAR_CRATE, FAR_CRATE_SIDE);
    let target = FAR_CRATE + Vec3::new(0.0, 0.5, 0.0);
    let look = Look::default().with_contact_shadow_length(FAR_RAY);
    let jitter = |f: u64| genex_render::jitter::offset_px(f, genex_render::settings::JitterCycle::default());
    let cameras: Vec<_> = (0..FAR_FRAMES).map(|f| cast_camera(FAR_EYE, target, FAR_SIZE, jitter(f))).collect();
    let frames: Vec<_> = cameras.iter().map(|c| ContactShadowFrame { depth: cast_depth(c, FAR_SIZE, &[block]), camera: *c, facts: facts(0, false) }).collect();
    let masks = contact_shadow_masks(&gpu, &look, FAR_SIZE, &frames).expect("masks");
    let judged: Vec<_> = masks.iter().zip(&cameras).map(|(m, c)| far_judge(m, c, &block)).collect();
    write_evidence("far-jitter-0.bgra", &mask_bgra(&masks[0]));
    let log: String = judged.iter().enumerate().map(|(f, (d, o, n))| format!("{f} deep_texels={n} darkness={d:.3} open_darkness={o:.3}\n")).collect();
    write_evidence("far-jitter.txt", log.as_bytes());
    assert!(judged.iter().all(|(_, _, n)| *n > 40), "the crate casts a judged contact shadow\n{log}");
    let darkest = judged.iter().map(|j| j.0).fold(0.0, f32::max);
    let faintest = judged.iter().map(|j| j.0).fold(1.0, f32::min);
    let falsest = judged.iter().map(|j| j.1).fold(0.0, f32::max);
    assert!(faintest >= FAR_DARKNESS_MIN, "the far crate's contact shadow is too faint: darkness {faintest:.3}\n{log}");
    assert!(darkest - faintest <= FAR_DARKNESS_SPREAD_MAX, "the far crate's contact shadow moves with the jitter: {faintest:.3}..{darkest:.3}\n{log}");
    assert!(falsest <= FAR_FALSE_MAX, "open ground near the far crate is shadowed: {falsest:.3}\n{log}");
}

/// The pebble scene's prepass depth at `size`.
fn render_scene_depth(gpu: &Gpu, size: (u32, u32)) -> (Mat4, Vec<f32>) {
    let mut renderer = Renderer::new(gpu, size.0, size.1).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality(true));
    renderer.set_depth_readback(true);
    renderer.set_prepass_demand(ExtensionDemand { custom_inputs: RenderInputs::DEPTH, ..ExtensionDemand::default() });
    renderer.render(gpu, &pebble_scene(PEBBLE), CullPath::Gpu).expect("frame");
    let aspect = size.0 as f32 / size.1 as f32;
    (camera().projection(aspect, true), renderer.read_prepass_depth(gpu).expect("prepass depth"))
}
