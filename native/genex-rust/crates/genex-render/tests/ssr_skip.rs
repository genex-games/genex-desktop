//! Lane FQ: screen-space reflections skipped where nothing can take one. A frame whose surfaces
//! are all too rough for the trace (Ashen Horde's crowd draws at 0.75) paid for the surface pass,
//! the Hi-Z, the trace, the blur and the resolve and drew zero reflections; its frame now draws the
//! zero texel at binding 30 instead, the same picture. A frame with one surface that can reflect
//! runs them all as before.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test ssr_skip -- --ignored metal --test-threads=1

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene, scaled, translation};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::ssr::{ROUGHNESS_CUTOFF, frame_can_reflect};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::Vec3;

const SIZE: (u32, u32) = (320, 180);
/// The frames drawn before the compared one: the reflections read the frame before's pyramid.
const FRAMES: u64 = 4;

/// A rough crowd of boxes on rough ground under a low sun, and `extra` drawn as well.
fn rough_scene(extra: Option<(Vec3, Material)>) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.8, -6.0]), [120, 110, 100, 255]);
    scene.lighting.sun_dir = Vec3::new(0.4, 0.3, -0.8).normalize().to_array();
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [60.0, 0.2, 60.0]), Material::color([140, 120, 100, 255]).with_pbr(0.0, 0.95));
    for i in 0..60 {
        let (x, z) = ((i % 10) as f32 * 1.2 - 5.4, -(i / 10) as f32 * 1.5);
        scene.draw(MeshId::CUBE, scaled([x, 0.7, z], [0.4, 1.4, 0.4]), Material::color([90, 70, 60, 255]).with_pbr(0.0, 0.75));
    }
    if let Some((at, material)) = extra {
        scene.draw(MeshId::CUBE, translation(at.x, at.y, at.z), material);
    }
    scene
}

/// The ultra frame `FRAMES` frames in: its capture and the compute passes it opened.
fn ultra_frame(gpu: &Gpu, scene: &Scene) -> (Vec<u8>, u32) {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let mut renderer = Renderer::with_options(gpu, SIZE.0, SIZE.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(class);
    renderer.set_quality(&preset_quality(QualityPreset::Ultra, class));
    for index in 0..FRAMES {
        renderer.set_frame_index(index);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    (renderer.capture(gpu).expect("capture").bgra().to_vec(), renderer.last_stats().compute_passes)
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

#[test]
fn a_frame_can_reflect_only_through_a_surface_the_trace_would_take() {
    let plan = |scene: &Scene| FramePlan::build(scene, &MeshLibrary::new(), 16.0 / 9.0).expect("plan");
    assert!(!frame_can_reflect(&plan(&rough_scene(None))), "every surface is at or past the cutoff");
    let smooth = Material::color([200, 200, 200, 255]).with_pbr(0.0, ROUGHNESS_CUTOFF - 0.05);
    assert!(frame_can_reflect(&plan(&rough_scene(Some((Vec3::new(0.0, 0.5, 0.0), smooth))))), "a surface under the cutoff");
    let at_cutoff = Material::color([200, 200, 200, 255]).with_pbr(0.0, ROUGHNESS_CUTOFF);
    assert!(!frame_can_reflect(&plan(&rough_scene(Some((Vec3::new(0.0, 0.5, 0.0), at_cutoff))))), "the cutoff itself is not traced");
}

/// Lane FQ, red first: the rough crowd opened the reflections' passes and drew none.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_frame_nothing_can_reflect_in_skips_the_reflections_and_draws_the_same_picture() {
    let Some(gpu) = gpu() else { return };
    // The same frame with a mirror far behind the camera, past the shadows' reach: nothing in view
    // changes, and the frame traces.
    let mirror = Material::color([200, 200, 200, 255]).with_pbr(1.0, 0.05);
    let (rough, rough_passes) = ultra_frame(&gpu, &rough_scene(None));
    let (traced, traced_passes) = ultra_frame(&gpu, &rough_scene(Some((Vec3::new(0.0, 0.5, 400.0), mirror))));
    let differing = rough.chunks(4).zip(traced.chunks(4)).filter(|(a, b)| a != b).count();
    assert_eq!(differing, 0, "the skipped frame draws the traced frame's picture");
    assert!(rough_passes < traced_passes, "the skipped frame opens fewer compute passes ({rough_passes} vs {traced_passes})");
}
