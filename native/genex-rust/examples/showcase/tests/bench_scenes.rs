//! The renderer bench scenes (`showcase_game::bench`): the material and lighting scene, the outdoor
//! scene and the large city, drawn through genex-render's `Scene` directly (the facade has no
//! per-draw materials, point lights or skinning yet).
//!
//! The CPU rows check what each scene covers and that every frame of its camera path plans. The
//! `metal` rows render every named shot on the host GPU twice to one digest and write the PNGs
//! beside the lakeside's (`captures/latest/bench-<scene>-<shot>.png` unless `GENEX_SHOWCASE_OUT` names
//! another folder, digests in
//! `bench-digests.json`):
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test bench_scenes -- --ignored metal --nocapture

mod support;

use std::collections::BTreeSet;

use genex_render::scene::{FramePlan, MeshLibrary, Scene};
use showcase_game::bench::{self, BenchScene, PATH_FRAMES, SHOTS, SceneId};

const ASPECT: f32 = 16.0 / 9.0;

fn load(id: SceneId) -> (Box<dyn BenchScene>, MeshLibrary) {
    let mut library = MeshLibrary::new();
    let scene = bench::load(id, &mut library).expect("the scene's meshes load");
    (scene, library)
}

fn transparent_draws(scene: &Scene) -> usize {
    scene.draws.iter().filter(|d| d.material.is_transparent()).count() + scene.skinned.iter().filter(|d| d.material.is_transparent()).count()
}

#[test]
fn every_scene_plans_every_frame_of_its_camera_path() {
    for id in SceneId::ALL {
        let name = id.name();
        let (scene, library) = load(id);
        for frame in [0, 1, PATH_FRAMES / 4, PATH_FRAMES / 2, PATH_FRAMES - 1, PATH_FRAMES * 3] {
            let drawn = scene.scene(frame);
            let plan = FramePlan::build(&drawn, &library, ASPECT).unwrap_or_else(|e| panic!("{name} frame {frame}: {e}"));
            assert!(plan.cpu_cull().counts.iter().sum::<u32>() > 0, "{name} frame {frame}: the camera sees nothing");
        }
    }
}

#[test]
fn a_scene_is_the_same_for_the_same_frame_and_moves_along_its_path() {
    for id in SceneId::ALL {
        let name = id.name();
        let (a, _) = load(id);
        let (b, _) = load(id);
        assert_eq!(a.scene(120), b.scene(120), "{name}: two loads disagree at one frame");
        assert_ne!(a.scene(0).camera, a.scene(120).camera, "{name}: the camera path does not move");
        assert_eq!(a.scene(7).camera, a.scene(7 + PATH_FRAMES).camera, "{name}: the camera path does not loop");
    }
}

#[test]
fn the_material_scene_covers_metal_and_roughness_skinning_glass_and_point_lights() {
    let (scene, _) = load(SceneId::Materials);
    let drawn = scene.scene(0);
    let pairs: BTreeSet<(u32, u32)> = drawn.draws.iter().map(|d| (d.material.metallic.to_bits(), d.material.roughness.to_bits())).collect();
    let metals: BTreeSet<u32> = drawn.draws.iter().map(|d| d.material.metallic.to_bits()).collect();
    let roughness: BTreeSet<u32> = drawn.draws.iter().map(|d| d.material.roughness.to_bits()).collect();
    assert!(metals.len() >= 5 && roughness.len() >= 7 && pairs.len() >= 35, "{} metal, {} rough, {} pairs", metals.len(), roughness.len(), pairs.len());
    assert!(!drawn.skinned.is_empty(), "no skinned character");
    assert!(transparent_draws(&drawn) >= 4, "too few transparent objects");
    assert!(drawn.lighting.points.len() >= 3, "too few point lights");
    let (later, _) = load(SceneId::Materials);
    assert_ne!(later.scene(30).skinned[0].joints, drawn.skinned[0].joints, "the character does not move");
}

#[test]
fn the_outdoor_scene_has_terrain_foliage_water_and_a_sky_placeholder() {
    let (scene, library) = load(SceneId::Outdoor);
    let drawn = scene.scene(0);
    let foliage = drawn.draws.iter().filter(|d| !d.material.is_transparent()).count();
    assert!(foliage >= 5_000, "{foliage} opaque draws: too little foliage");
    assert!(transparent_draws(&drawn) >= 1, "no water");
    let sky = drawn.draws.iter().filter(|d| d.model[0] >= 100.0 && d.model[12..15] == drawn.camera.eye).count();
    assert!(sky >= 1, "no sky placeholder around the camera");
    let largest = drawn.draws.iter().filter_map(|d| library.entry(d.mesh)).map(|e| e.index_count).max().unwrap_or(0);
    assert!(largest >= 3 * 2 * 128 * 128, "the terrain is coarser than 128x128 cells ({largest} indices)");
}

/// The most two neighbouring bands of the outdoor sky placeholder may differ by, in sRGB levels on
/// any channel: a step a flicker map does not draw as an edge.
const SKY_BAND_STEP_MAX: u8 = 24;

/// G0 visual (2026-10-15): the outdoor scene's sky placeholder drew a hard-edged blue ellipse across
/// the top of the frame (its zenith band 44-54 levels off the next), which the motion rows' flicker
/// maps traced as an edge. Neighbouring bands differ by at most [`SKY_BAND_STEP_MAX`].
#[test]
fn the_outdoor_sky_placeholder_has_no_hard_band_edges() {
    let (scene, _) = load(SceneId::Outdoor);
    let drawn = scene.scene(0);
    let bands: Vec<[u8; 4]> = drawn.draws.iter().filter(|d| d.model[0] >= 100.0 && d.model[12..15] == drawn.camera.eye).map(|d| d.material.base_color).collect();
    assert!(bands.len() >= 2, "the sky placeholder's bands: {bands:?}");
    for pair in bands.windows(2) {
        let step = (0..3).map(|lane| pair[0][lane].abs_diff(pair[1][lane])).max().unwrap_or(0);
        assert!(step <= SKY_BAND_STEP_MAX, "neighbouring sky bands {:?} and {:?} differ by {step} levels", pair[0], pair[1]);
    }
}

#[test]
fn the_city_draws_at_least_fifty_thousand_instances_of_many_meshes() {
    let (scene, _) = load(SceneId::City);
    let drawn = scene.scene(0);
    // Renderer pass 2 A.0b flipped `draws` -> retained groups: the city's static instances are
    // retained groups (`mesh_instances` counts both).
    let meshes: BTreeSet<u32> = drawn.draws.iter().map(|d| d.mesh.raw()).chain(drawn.groups.iter().map(|g| g.group.mesh().raw())).collect();
    assert!(drawn.mesh_instances() >= 50_000, "{} instances", drawn.mesh_instances());
    assert!(drawn.groups.len() >= 24, "{} retained groups", drawn.groups.len());
    assert!(meshes.len() >= 24, "{} distinct meshes", meshes.len());
    assert!(drawn.logical_draws() < 1_000, "instances are not grouped into instanced draws ({})", drawn.logical_draws());
}

#[test]
fn every_shot_names_a_known_scene_once_and_a_frame_on_its_path() {
    let mut seen = BTreeSet::new();
    for shot in SHOTS {
        assert!(shot.frame < PATH_FRAMES, "{}-{} is past the path", shot.scene.name(), shot.name);
        assert!(seen.insert((shot.scene, shot.name)), "{}-{} twice", shot.scene.name(), shot.name);
    }
    for id in SceneId::ALL {
        assert!(SHOTS.iter().any(|s| s.scene == id), "{} has no shot", id.name());
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_bench_shot_renders_the_same_picture_twice_and_is_written_as_a_png() {
    let Some(gpu) = support::gpu() else { return };
    let dir = support::out_dir();
    let mut digests = Vec::new();
    for shot in SHOTS {
        let capture = support::bench_shot(&gpu, shot.scene, shot.frame);
        let again = support::bench_shot(&gpu, shot.scene, shot.frame);
        assert_eq!(again.digest(), capture.digest(), "{}-{}: two renders of one frame differ", shot.scene.name(), shot.name);
        support::write_png(&dir.join(format!("bench-{}-{}.png", shot.scene.name(), shot.name)), &capture);
        digests.push(format!("\"{}-{}\": \"{:016x}\"", shot.scene.name(), shot.name, capture.digest()));
    }
    let record = format!(
        "{{\"adapter\": {:?}, \"size\": [{}, {}], \"digests\": {{{}}}}}\n",
        gpu.receipt().adapter,
        support::SIZE[0],
        support::SIZE[1],
        digests.join(", ")
    );
    std::fs::write(dir.join("bench-digests.json"), &record).expect("digests");
    println!("{record}");
}
