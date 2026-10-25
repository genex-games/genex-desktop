//! Lane FR: the reflections' surface texel written by the prepass. A frame that traced drew the
//! camera's opaque batches three times: the prepass, the reflections' own surface pass (`Equal`
//! over the prepass depth, for A.6's normal and roughness alone) and the world pass. The prepass
//! now draws them last with the forward module's surface twin, which writes its own three targets
//! and the texel in one draw, so the batches are drawn twice and the picture is the same.
//!
//! The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test ssr_prepass -- --ignored metal --test-threads=1
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames (raw BGRA, the size in the name).

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled, translation};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::{CullPath, FrameStats, Gpu, RenderOptions, Renderer};
use glam::Vec3;

const SIZE: (u32, u32) = (320, 180);
/// The frames drawn before the compared one: the reflections read the frame before's pyramid.
const FRAMES: u64 = 4;

/// A wet street: a mirror-smooth ground, a rough wall and posts, a smooth metal ball and a
/// rough box standing in front of a smooth one (the surface texel must be the one in front).
fn street() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.6, 7.0], [0.0, 0.8, -4.0]), [120, 130, 150, 255]);
    scene.lighting.sun_dir = Vec3::new(0.3, 0.6, -0.7).normalize().to_array();
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [40.0, 0.2, 40.0]), Material::color([60, 64, 70, 255]).with_pbr(0.0, 0.08));
    scene.draw(MeshId::CUBE, scaled([0.0, 2.0, -8.0], [20.0, 4.0, 0.4]), Material::color([200, 90, 60, 255]).with_pbr(0.0, 0.9));
    for i in 0..6 {
        let x = i as f32 * 2.0 - 5.0;
        scene.draw(MeshId::CUBE, scaled([x, 1.0, -3.0], [0.3, 2.0, 0.3]), Material::color([220, 220, 90, 255]).with_pbr(0.0, 0.6));
    }
    scene.draw(MeshId::CUBE, translation(1.5, 0.5, 1.0), Material::color([230, 230, 230, 255]).with_pbr(1.0, 0.1));
    scene.draw(MeshId::CUBE, scaled([-1.5, 0.6, 2.0], [0.8, 1.2, 0.8]), Material::color([90, 140, 90, 255]).with_pbr(0.0, 0.85));
    scene.draw(MeshId::CUBE, scaled([-1.5, 0.6, 1.0], [1.0, 1.0, 1.0]), Material::color([200, 200, 210, 255]).with_pbr(1.0, 0.05));
    scene
}

/// The ultra frame `FRAMES` frames in on `class`: its capture and its statistics.
fn ultra_frame(gpu: &Gpu, scene: &Scene, class: DeviceClass) -> (Vec<u8>, FrameStats) {
    let mut renderer = Renderer::with_options(gpu, SIZE.0, SIZE.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(class);
    renderer.set_quality(&preset_quality(QualityPreset::Ultra, class));
    for index in 0..FRAMES {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    (renderer.capture(gpu).expect("capture").bgra().to_vec(), renderer.last_stats())
}

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn write_evidence(name: &str, bgra: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).expect("evidence folder");
        std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{}x{}.bgra", SIZE.0, SIZE.1)), bgra).expect("written");
    }
}

/// Lane FR, red first: the reflections' surface pass drew the camera's opaque batches a third time.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_frame_that_traces_draws_its_opaque_batches_in_the_prepass_and_the_world_pass_only() {
    let Some(gpu) = gpu() else { return };
    let ultra = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let (picture, stats) = ultra_frame(&gpu, &street(), ultra);
    write_evidence("ssr-prepass-street", &picture);
    assert_eq!(stats.camera_opaque_passes, 2, "{stats:?}");
    // The trace still runs: the Hi-Z, the trace, the blur and the resolve.
    let mut rough = street();
    for draw in &mut rough.draws {
        draw.material = draw.material.with_pbr(0.0, 0.95);
    }
    let (_, rough_stats) = ultra_frame(&gpu, &rough, ultra);
    assert!(stats.compute_passes > rough_stats.compute_passes, "the smooth street traces ({} vs {})", stats.compute_passes, rough_stats.compute_passes);
    // A frame that traces nothing keeps one prepass pass and draws the batches twice too.
    assert_eq!(rough_stats.camera_opaque_passes, 2, "{rough_stats:?}");
    assert_eq!(stats.render_passes, rough_stats.render_passes + 1, "the prepass's surface pass is its one extra pass");
}

/// The desktop `high` preset traces too (48 steps): the same rule.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_desktop_high_draws_its_opaque_batches_twice_as_well() {
    let Some(gpu) = gpu() else { return };
    let high = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let mut renderer = Renderer::with_options(&gpu, SIZE.0, SIZE.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(high);
    renderer.set_quality(&preset_quality(QualityPreset::High, high));
    for index in 0..FRAMES {
        renderer.set_frame_index(index);
        renderer.render(&gpu, &street(), CullPath::Gpu).expect("frame");
    }
    assert_eq!(renderer.last_stats().camera_opaque_passes, 2, "{:?}", renderer.last_stats());
}
