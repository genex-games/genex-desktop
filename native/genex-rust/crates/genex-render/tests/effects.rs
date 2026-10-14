//! Tier RQ4 end to end (RQ4.6): the screen effects a preset asks for are drawn by the renderer
//! itself, not only by their modules on supplied buffers. On a high desktop preset under the
//! physical sky, each switch changes the frame the way its effect should when it is the only one
//! turned off: ambient occlusion and the sun's contact shadows only darken, bloom spreads light
//! past an object's silhouette, fog moves distant pixels towards its colour and the aerial
//! perspective hazes the far ground. With every effect on, two fresh renderers draw the same bytes
//! (captures stay reproducible on one adapter).
//!
//! Evidence (`GENEX_RENDER_EVIDENCE_DIR`): `effects-<case>-<w>x<h>.bgra` per frame.

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Environment, Fog, Quality, QualityPreset, RenderFeature, SceneFormat};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 256;
const HEIGHT: u32 = 144;
/// A pixel in the middle of the box's sunlit front face in [`scene`].
const BOX_FACE: (u32, u32) = (90, 75);

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
        std::fs::write(dir.join(format!("effects-{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// The high preset of an ultra desktop: AO with its own history, contact shadows, bloom, fog and
/// aerial perspective all on.
fn high() -> Quality {
    preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra))
}

/// A box and a pebble on a ground that runs a few kilometres out, a bright sphere above, under the
/// physical sky with a low-ish sun.
fn scene() -> Scene {
    let mut camera = CameraDesc::look_at([0.0, 2.2, 7.0], [0.0, 0.6, 0.0]);
    camera.far = 6000.0;
    let mut scene = Scene::new(camera, [40, 50, 70, 255]);
    scene.lighting.sun_dir = glam::Vec3::new(-0.6, 0.55, 0.35).normalize().to_array();
    let ground = Material::color([180, 170, 150, 255]).with_pbr(0.0, 0.9);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -1480.0], [3000.0, 0.2, 3000.0]), ground);
    scene.draw(MeshId::CUBE, scaled([-1.4, 0.6, 0.0], [1.2, 1.2, 1.2]), Material::color([200, 200, 205, 255]).with_pbr(0.0, 0.6));
    scene.draw(MeshId::CUBE, scaled([1.0, 0.08, 1.2], [0.16, 0.16, 0.16]), Material::color([90, 80, 70, 255]).with_pbr(0.0, 0.8));
    scene.draw(MeshId::SPHERE, scaled([1.6, 1.6, -0.5], [0.5; 3]), Material::color([255, 255, 255, 255]).with_pbr(0.0, 0.2));
    scene
}

/// One frame of [`scene`] under `quality`, with `fog` as the look's, from a fresh renderer.
fn frame(gpu: &Gpu, quality: &Quality, fog: Fog) -> Capture {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra));
    renderer.set_quality(quality);
    renderer.set_look(renderer.look().with_fog(fog));
    renderer.set_environment(&Environment::sky());
    renderer.render(gpu, &scene(), CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

fn without(feature: RenderFeature) -> Quality {
    let mut quality = high();
    quality.set_feature(feature, false);
    quality
}

/// The largest channel difference between two BGRA pixels (fog moves a colour towards its own
/// without necessarily changing its sum).
fn channel_delta(a: &[u8], b: &[u8]) -> u8 {
    (0..3).map(|lane| a[lane].abs_diff(b[lane])).max().unwrap_or(0)
}

/// Pixels where `a` is darker than `b` by more than 2 levels in any channel, and the reverse.
fn darker_brighter(a: &Capture, b: &Capture) -> (usize, usize) {
    let pairs = || a.bgra().chunks(4).zip(b.bgra().chunks(4));
    let darker = pairs().filter(|(x, y)| (0..3).any(|lane| x[lane].saturating_add(2) < y[lane])).count();
    let brighter = pairs().filter(|(x, y)| (0..3).any(|lane| x[lane] > y[lane].saturating_add(2))).count();
    (darker, brighter)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_rq4_effect_a_preset_asks_for_is_drawn_by_the_renderer() {
    let Some(gpu) = gpu() else { return };
    for feature in [RenderFeature::Ao, RenderFeature::ContactShadows, RenderFeature::Bloom, RenderFeature::Fog] {
        assert!(genex_render::graph::feature_drawn(&high(), feature), "{} is drawn on high", feature.wire());
    }
    let all = frame(&gpu, &high(), Fog::default());
    write_evidence("all", &all);
    assert!(all.bgra() == frame(&gpu, &high(), Fog::default()).bgra(), "two fresh renderers draw the same bytes");

    // AO and contact shadows take light away and never add any: AO in every crease and contact,
    // contact shadows only where the cascades miss a small caster (the pebble's base), and never
    // on a lit face (a slanted surface does not shadow itself).
    let pixels = (WIDTH * HEIGHT) as usize;
    // AO's least: the box's and the pebble's creases (RQ4 review: 1000 counted the open ground the
    // unnormalised bent-normal specular occlusion darkened by mistake; about 400 remain).
    for (feature, name, least, most) in [(RenderFeature::Ao, "no-ao", 200, pixels / 4), (RenderFeature::ContactShadows, "no-contact-shadows", 10, pixels / 50)] {
        let off = frame(&gpu, &without(feature), Fog::default());
        write_evidence(name, &off);
        let (darker, brighter) = darker_brighter(&all, &off);
        eprintln!("{name}: {darker} pixels darker with it on, {brighter} brighter");
        assert!(darker >= least, "{}: the effect darkens the frame ({darker} pixels)", feature.wire());
        assert!(darker < most, "{}: it darkens creases and contacts, not whole faces ({darker} pixels)", feature.wire());
        assert!(brighter * 20 <= darker, "{}: it only darkens ({brighter} brighter, {darker} darker)", feature.wire());
        // The middle of the box's sunlit front face: open to the sun and the sky.
        let face = ((BOX_FACE.1 * WIDTH + BOX_FACE.0) * 4) as usize;
        let (on, open) = (&all.bgra()[face..face + 3], &off.bgra()[face..face + 3]);
        assert!(channel_delta(on, open) <= 6, "{}: the lit face keeps its light ({on:?} against {open:?})", feature.wire());
    }

    // Bloom: the frame blends towards its own blur, so the dark sky right around the bright
    // sphere gains light and the frame changes in many pixels.
    let no_bloom = frame(&gpu, &without(RenderFeature::Bloom), Fog::default());
    write_evidence("no-bloom", &no_bloom);
    let changed = all.bgra().chunks(4).zip(no_bloom.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    eprintln!("bloom changes {changed} pixels");
    assert!(changed as u32 > WIDTH * HEIGHT / 4, "bloom changes the frame ({changed} pixels)");

    // Fog: uniform distance fog takes the far ground towards its colour, the near box less.
    let fog = Fog::default().with_density(0.08).with_height(0.0, 0.0).with_color([0.9, 0.92, 0.95]);
    let fogged = frame(&gpu, &high(), fog);
    write_evidence("fog", &fogged);
    let mut fog_off = high();
    fog_off.set_feature(RenderFeature::Fog, false);
    let switched_off = frame(&gpu, &fog_off, fog);
    assert!(switched_off.bgra() == all.bgra(), "the fog switch off draws no fog whatever the look says");
    // The ground below the horizon some tens of units out, and right in front of the camera.
    let far = (WIDTH / 2, HEIGHT * 5 / 12);
    let delta = |x: u32, y: u32| channel_delta(&fogged.bgra()[((y * WIDTH + x) * 4) as usize..], &all.bgra()[((y * WIDTH + x) * 4) as usize..]);
    eprintln!("fog moves the far ground by {} and the near ground by {}", delta(far.0, far.1), delta(WIDTH / 2, HEIGHT - 4));
    assert!(delta(far.0, far.1) > delta(WIDTH / 2, HEIGHT - 4), "far ground is fogged more than near ground");
    assert!(delta(far.0, far.1) >= 12, "the far ground is visibly fogged");

    // Aerial perspective: the sky's own haze over kilometres of ground (the look's switch).
    let no_air = {
        let mut renderer = Renderer::with_options(&gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra));
        renderer.set_quality(&high());
        let mut look_fog = Fog::default();
        look_fog.aerial_perspective = false;
        renderer.set_look(renderer.look().with_fog(look_fog));
        renderer.set_environment(&Environment::sky());
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        renderer.capture(&gpu).expect("capture")
    };
    write_evidence("no-aerial", &no_air);
    let hazed = all.bgra().chunks(4).zip(no_air.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    eprintln!("aerial perspective changes {hazed} pixels");
    assert!(hazed >= 50, "the aerial perspective hazes the far ground ({hazed} pixels)");
}


// ---------------------------------------------------------------------------------------------
// RQ4 review rows

/// A frame of `scene` under `quality` at `size` from a fresh renderer under the physical sky.
fn frame_of(gpu: &Gpu, quality: &Quality, scene: &Scene, size: (u32, u32)) -> Capture {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra));
    renderer.set_quality(quality);
    renderer.set_environment(&Environment::sky());
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// Rec. 709 luma of a BGRA pixel in levels.
fn luma(p: &[u8]) -> f32 {
    0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])
}

/// An open, flat, fairly smooth ground running to the horizon, seen from just above it: nothing
/// occludes it, so AO must leave every pixel as it is (visibility 1 everywhere).
fn open_plane() -> Scene {
    let mut camera = CameraDesc::look_at([0.0, 0.5, 4.0], [0.0, 0.0, -12.0]);
    camera.far = 6000.0;
    let mut scene = Scene::new(camera, [40, 50, 70, 255]);
    scene.lighting.sun_dir = glam::Vec3::new(-0.3, 0.35, -0.9).normalize().to_array();
    scene.lighting.shadows = false;
    let ground = Material::color([150, 140, 120, 255]).with_pbr(0.0, 0.45);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -1480.0], [3000.0, 0.2, 3000.0]), ground);
    scene
}

/// RQ4 review (visual 1): GTAO's bent-normal specular occlusion is relative to the unoccluded
/// hemisphere and fades out as the visibility nears 1, so on open ground seen at a grazing view
/// (where the specular lobe straddles the horizon) high's and ultra's AO with bent normals leave the
/// picture as AO off draws it, within a level, as medium's AO without bent normals does. Red before
/// the fix: high's mean -2.60 levels, worst -21.5, 7 829 of 16 128 ground pixels darker.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_bent_normal_specular_occlusion_leaves_open_ground_at_a_grazing_view_unchanged() {
    let Some(gpu) = gpu() else { return };
    let scene = open_plane();
    let ultra_desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let mut with = preset_quality(preset, ultra_desktop);
        with.set_feature(RenderFeature::ContactShadows, false);
        let mut without = with;
        without.set_feature(RenderFeature::Ao, false);
        assert!(with.ao.bent_normals(), "{preset:?}: AO carries bent normals");
        let (with_ao, without_ao) = (frame_of(&gpu, &with, &scene, (WIDTH, HEIGHT)), frame_of(&gpu, &without, &scene, (WIDTH, HEIGHT)));
        write_evidence(&format!("open-plane-{}-ao", preset.wire()), &with_ao);
        write_evidence(&format!("open-plane-{}-no-ao", preset.wire()), &without_ao);
        // The ground: everything below the horizon, sky excluded.
        let rows = HEIGHT * 9 / 16..HEIGHT;
        let ground: Vec<(f32, f32)> = rows
            .flat_map(|y| (0..WIDTH).map(move |x| ((y * WIDTH + x) * 4) as usize))
            .map(|at| (luma(&with_ao.bgra()[at..at + 4]), luma(&without_ao.bgra()[at..at + 4])))
            .collect();
        let mean = ground.iter().map(|(on, off)| on - off).sum::<f32>() / ground.len() as f32;
        let darker = ground.iter().filter(|(on, off)| on + 1.0 < *off).count();
        let worst = ground.iter().map(|(on, off)| on - off).fold(0.0, f32::min);
        eprintln!("open plane at {preset:?}: AO on - off mean {mean:.2} levels, worst {worst:.2}, {darker} of {} pixels darker by more than a level", ground.len());
        assert!(mean.abs() <= 1.0, "{preset:?}: AO darkens open ground on average by {mean:.2} levels");
        assert!(darker * 100 <= ground.len(), "{preset:?}: {darker} of {} open-ground pixels are darker by more than a level (worst {worst:.2})", ground.len());
    }
}

/// A red sphere floating over the ground, its silhouette against the ground and the sky, and red
/// thin rods (a canopy's twigs, 4 cm across) against the sky above the horizon, lit from the side.
fn floating_sphere() -> Scene {
    let mut camera = CameraDesc::look_at([0.0, 1.6, 4.5], [0.0, 1.2, 0.0]);
    camera.far = 6000.0;
    let mut scene = Scene::new(camera, [40, 50, 70, 255]);
    scene.lighting.sun_dir = glam::Vec3::new(-0.8, 0.45, 0.35).normalize().to_array();
    let ground = Material::color([150, 140, 120, 255]).with_pbr(0.0, 0.9);
    let red = Material::color([210, 40, 30, 255]).with_pbr(0.0, 0.5);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -1480.0], [3000.0, 0.2, 3000.0]), ground);
    scene.draw(MeshId::SPHERE, scaled([0.0, 1.3, 0.0], [1.1; 3]), red);
    for i in 0..4 {
        let (x, y) = (-1.9 + i as f32 * 1.25, 2.55 + (i % 2) as f32 * 0.12);
        let turn = glam::Mat4::from_translation(glam::Vec3::new(x, y, -0.4)) * glam::Mat4::from_rotation_z(0.35 - i as f32 * 0.25) * glam::Mat4::from_scale(glam::Vec3::new(1.0, 0.04, 0.04));
        scene.draw(MeshId::CUBE, turn.to_cols_array(), red);
    }
    scene
}

/// RQ4 review (visual 3): the contact-shadow march takes its slope tolerance from the smaller of
/// each axis's neighbours that are not sky (a texel whose right and lower neighbours were sky got
/// none and shadowed itself), and its half-size mask reaches the world pass through the
/// joint-bilateral upsample, and a sample must leave the receiver's own 1.5 texels before it can
/// occlude, so lit silhouettes do not shadow themselves: with contact shadows on, at most 1 % of the
/// rods' and the sphere's silhouette pixels are more than 2 levels darker than with them off (red
/// before: 20 of 956, worst 64 levels; what is left is a rod's end, where the ray runs along the
/// rod and the march cannot tell a 4 cm rod from a 5 cm-thick occluder).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_contact_shadows_leave_lit_silhouettes_as_they_are() {
    let Some(gpu) = gpu() else { return };
    let scene = floating_sphere();
    let on = high();
    assert!(on.contact_shadows, "high draws contact shadows");
    let mut off = on;
    off.set_feature(RenderFeature::ContactShadows, false);
    let (with, without) = (frame_of(&gpu, &on, &scene, (WIDTH, HEIGHT)), frame_of(&gpu, &off, &scene, (WIDTH, HEIGHT)));
    write_evidence("silhouettes-contact", &with);
    write_evidence("silhouettes-no-contact", &without);
    let is_red = |x: i64, y: i64| {
        let inside = (0..i64::from(WIDTH)).contains(&x) && (0..i64::from(HEIGHT)).contains(&y);
        let at = ((y * i64::from(WIDTH) + x) * 4) as usize;
        inside && without.bgra()[at + 2] > without.bgra()[at + 1].saturating_add(40)
    };
    let pixels = || (0..i64::from(HEIGHT)).flat_map(|y| (0..i64::from(WIDTH)).map(move |x| (x, y)));
    let red: Vec<(i64, i64)> = pixels().filter(|&(x, y)| is_red(x, y)).collect();
    assert!(red.len() > 1000, "the sphere and rods fill the frame ({} pixels)", red.len());
    // Silhouettes: red pixels within 2 pixels of the ground or the sky.
    let edge = |&(x, y): &(i64, i64)| (-2..=2).any(|dy| (-2..=2).any(|dx| !is_red(x + dx, y + dy)));
    let darker_by = |&(x, y): &(i64, i64)| {
        let at = ((y * i64::from(WIDTH) + x) * 4) as usize;
        (0..3).map(|lane| without.bgra()[at + lane].saturating_sub(with.bgra()[at + lane])).max().unwrap_or(0)
    };
    let silhouette: Vec<&(i64, i64)> = red.iter().filter(|p| edge(p)).collect();
    let darker: Vec<((i64, i64), u8)> = silhouette.iter().map(|p| (**p, darker_by(p))).filter(|(_, by)| *by > 2).collect();
    let inside = red.iter().filter(|p| !edge(p) && darker_by(p) > 2).count();
    let worst = darker.iter().map(|(_, by)| *by).max().unwrap_or(0);
    eprintln!("silhouettes: {} pixels, {} darker by more than 2 levels with contact shadows on (worst {worst}): {darker:?}; inside {inside} (the sphere's terminator)", silhouette.len(), darker.len());
    assert!(silhouette.len() > 100, "the silhouettes are found ({})", silhouette.len());
    assert!(darker.len() * 100 <= silhouette.len(), "{} silhouette pixels darker with contact shadows on (worst {worst}), e.g. {:?}", darker.len(), &darker[..darker.len().min(8)]);
}

/// The bytes `ledger` holds under `labels`.
fn ledger_bytes(ledger: &genex_render::budget::BudgetLedger, labels: &[&str]) -> u64 {
    ledger.entries().iter().filter(|entry| labels.contains(&entry.label.as_str())).map(|entry| entry.bytes).sum()
}

/// RQ4 review (performance 3): AO's and the contact shadows' targets come from the target pool,
/// so the renderer's ledger holds what they allocate (the R32F view-depth chains, the bent term, the
/// history, the half-size mask and the render-size upsamples), the budget model counts the same
/// bytes on every preset, and a quality without them (low, or a degrade step) gives them back.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_pool_ledger_holds_what_ao_and_contact_shadows_allocate_and_the_budget_model_counts_it() {
    use genex_render::budget::{BudgetInput, ledger};
    use genex_render::post::{ao, contact_shadow};
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let mut renderer = Renderer::with_options(&gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let ultra_desktop = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    renderer.set_device_class(ultra_desktop);
    renderer.set_environment(&Environment::sky());
    let ao_labels: Vec<&str> = ao::LABELS.to_vec();
    let contact_labels: Vec<&str> = contact_shadow::LABELS.to_vec();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra, QualityPreset::Low] {
        let quality = preset_quality(preset, ultra_desktop);
        renderer.set_quality(&quality);
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        let held = renderer.targets().ledger();
        let model = ledger(&quality, &BudgetInput::new(size, 1.0, SceneFormat::Rgba16Float, false));
        let (held_ao, held_contact) = (ledger_bytes(held, &ao_labels), ledger_bytes(held, &contact_labels));
        let (model_ao, model_contact) = (ledger_bytes(&model, &["ao", "ao-history"]), ledger_bytes(&model, &["contact-shadows"]));
        eprintln!("{preset:?}: AO held {held_ao} modelled {model_ao}; contact shadows held {held_contact} modelled {model_contact}");
        assert_eq!(held_ao, model_ao, "{preset:?}: the ledger holds AO's targets as the model counts them");
        assert_eq!(held_contact, model_contact, "{preset:?}: and the contact shadows'");
        let allocated: u64 = renderer.targets().targets().iter().filter(|t| ao_labels.contains(&t.desc().label) || contact_labels.contains(&t.desc().label)).map(|t| t.desc().bytes()).sum();
        assert_eq!(allocated, held_ao + held_contact, "{preset:?}: what the pool holds is what the ledger counts");
        if preset == QualityPreset::Low {
            assert_eq!(held_ao + held_contact, 0, "low draws neither: their targets are given back");
        }
    }
}
