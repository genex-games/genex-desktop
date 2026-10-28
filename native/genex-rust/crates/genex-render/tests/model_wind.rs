//! Model wind (vegetation lane, `genex_render::wind`): a draw whose material sways bends in the
//! shared wind in the vertex stage, and one that does not is drawn exactly as before. CPU rows hold
//! the plan to the parity rules: a still draw's rows carry zero wind words, a swaying one carries
//! its words and a bounding sphere grown by its reach, the LOD rows and the material table are the
//! same either way, and a retained group sways with its material. Shader rows validate every
//! module that draws instance rows. The real-GPU row draws a pole still and swaying at two wind
//! times:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --offline --locked --test model_wind -- --ignored metal

use genex_render::retained::InstanceGroup;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene};
use genex_render::wind::Sway;

/// A tree's sway over a pole of the cube mesh (y -0.5..0.5) scaled tall.
const POLE: Sway = Sway { height: 0.5, reach: 0.5, trunk: 0.06, branch: 0.03, flutter: 0.01, flutter_hz: 3.0 };

fn pole(x: f32) -> [f32; 16] {
    glam::Mat4::from_scale_rotation_translation(glam::Vec3::new(0.3, 8.0, 0.3), glam::Quat::IDENTITY, glam::Vec3::new(x, 4.0, 0.0)).to_cols_array()
}

fn scene_of(material: Material) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 14.0], [0.0, 4.0, 0.0]), [120, 140, 170, 255]);
    for x in [-3.0, 0.0, 3.0] {
        scene.draw(MeshId::CUBE, pole(x), material);
    }
    scene
}

#[test]
fn a_still_draw_carries_no_wind_and_a_swaying_one_its_words_and_wider_bounds() {
    let library = MeshLibrary::new();
    let bark = Material::color([120, 110, 100, 255]);
    let still = FramePlan::build(&scene_of(bark), &library, 16.0 / 9.0).expect("plan");
    let swaying = FramePlan::build(&scene_of(bark.with_sway(POLE)), &library, 16.0 / 9.0).expect("plan");
    assert!(still.instances.iter().all(|row| row.wind == [0; 3]), "a still draw's rows carry zero wind words");
    for (a, b) in still.instances.iter().zip(&swaying.instances) {
        assert_eq!(b.wind, POLE.words());
        assert_eq!((a.model, a.normal, a.material), (b.model, b.normal, b.material), "the sway changes nothing else of the row");
        assert!(b.bounds[3] > a.bounds[3], "the sphere grows so the cull keeps a swaying tip");
    }
    assert_eq!(still.lod_rows, swaying.lod_rows, "wind never moves a level switch");
    assert_eq!(still.materials, swaying.materials, "the sway is not in the material table");
    assert_eq!(still.batches, swaying.batches);
}

#[test]
fn a_retained_group_sways_with_its_material() {
    let library = MeshLibrary::new();
    let bark = Material::color([120, 110, 100, 255]);
    let group = InstanceGroup::new(MeshId::CUBE, bark, vec![pole(-3.0), pole(3.0)]).expect("a group");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 14.0], [0.0, 4.0, 0.0]), [0; 4]);
    scene.draw_group_with(&group, bark.with_sway(POLE));
    let plan = FramePlan::build(&scene, &library, 1.0).expect("plan");
    assert!(plan.instances.iter().all(|row| row.wind == POLE.words()), "every copy sways");
    assert_eq!(plan.retained[0].wind, POLE.words(), "the span records its words, so a change of wind re-uploads it");
    let mut still = Scene::new(CameraDesc::look_at([0.0, 4.0, 14.0], [0.0, 4.0, 0.0]), [0; 4]);
    still.draw_group(&group);
    let still = FramePlan::build(&still, &library, 1.0).expect("plan");
    assert!(still.instances.iter().all(|row| row.wind == [0; 3]));
    assert_eq!(still.retained[0].wind, [0; 3]);
}

#[test]
fn every_module_that_draws_instance_rows_sways_them_and_validates() {
    let modules = [
        ("forward", genex_render::shaders::FORWARD),
        ("prepass", genex_render::shaders::PREPASS),
        ("prepass-surface", genex_render::shaders::PREPASS_SURFACE),
        ("shadow", genex_render::shaders::SHADOW),
        ("spot-shadow", genex_render::spot_shadow::SPOT_SHADOW),
        ("meshlet-draw", genex_render::meshlet_cull::MESHLET_DRAW),
        ("meshlet-cull", genex_render::meshlet_cull::MESHLET_CULL),
    ];
    for (name, source) in modules {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());
        validator.validate(&module).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let sways = module.functions.iter().any(|(_, function)| function.name.as_deref() == Some("gx_sway_offset"));
        assert!(sways, "{name} carries the sway");
    }
}

// --- Real-GPU row ---

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::settings::{AoResolution, Quality, QualityPreset, SceneFormat};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

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

/// High on desktop-high without the features that keep their own noise or meter the picture.
fn steady() -> Quality {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
    let mut quality = preset_quality(QualityPreset::High, class);
    quality.ao.resolution = AoResolution::Off;
    quality.bloom.enabled = false;
    quality.exposure = false;
    quality
}

/// `scene` settled at wind `seconds` and captured.
fn settled(gpu: &Gpu, scene: &Scene, seconds: f32) -> Vec<u8> {
    let mut renderer = Renderer::with_options(gpu, 320, 180, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&steady());
    for k in 0..12 {
        renderer.set_frame_index(k);
        renderer.set_foliage_seconds(seconds);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture").bgra().to_vec()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_pole_ignores_the_wind_and_a_swaying_one_moves_with_it() {
    let Some(gpu) = gpu() else { return };
    let bark = Material::color([120, 110, 100, 255]);
    let still = scene_of(bark);
    assert_eq!(settled(&gpu, &still, 0.5), settled(&gpu, &still, 3.0), "a still draw is the same picture at any wind time");
    let swaying = scene_of(bark.with_sway(POLE));
    let (a, b) = (settled(&gpu, &swaying, 0.5), settled(&gpu, &swaying, 3.0));
    let moved = a.iter().zip(&b).filter(|(x, y)| x.abs_diff(**y) > 8).count();
    assert!(moved > 200, "the swaying poles move between wind times ({moved} channels)");
    assert_eq!(settled(&gpu, &swaying, 0.5), a, "a function of the wind time alone");
}
