//! The CPU half of the GPU-driven path: a scene becomes storage-buffer tables (instances,
//! deduplicated materials, one batch per mesh) and the CPU frustum cull that the compute pass is
//! checked against. Also the letterbox that places the world target in a window.
//!
//! RQ3.0: the cull views reserve nine views (the camera, four cascades, four shadowed spots) and a
//! plan activates only the views it draws; the frame carries every drawn cascade past the frozen
//! v1 prefix; the shadow settings' defaults are today's shadows, and far cascades follow the
//! cadence except on a settled capture.

use genex_render::layout::{MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS, SHADOW_CASCADES};
use genex_render::letterbox::{Viewport, letterbox, window_to_world};
use genex_render::mesh::MeshData;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PlanOptions, Scene, translation};
use genex_render::settings::{
    DEFAULT_SHADOW_BLEND_BAND, DEFAULT_SHADOW_SPLIT_LAMBDA, Environment, Quality, RenderSettings, ShadowFilter, ShadowFormat, ShadowSettings,
    SkyParams,
};

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0])
}

fn scene() -> Scene {
    let red = Material::color([200, 40, 40, 255]);
    let blue = Material::color([40, 40, 200, 255]);
    let mut scene = Scene::new(camera(), [18, 20, 28, 255]);
    scene.draw(MeshId::CUBE, translation(-2.0, 0.0, 0.0), red);
    scene.draw(MeshId::SPHERE, translation(-400.0, 0.0, 0.0), blue); // far outside, left
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 30.0), red); // behind the camera
    scene.draw(MeshId::CUBE, translation(2.0, 0.0, 0.0), blue);
    scene.draw(MeshId::SPHERE, translation(0.0, 2.0, 0.0), red);
    scene.draw(MeshId::CUBE, translation(0.0, -2.0, 0.0), red);
    scene
}

#[test]
fn a_scene_becomes_one_batch_per_mesh_with_instances_in_draw_order_and_shared_materials() {
    let library = MeshLibrary::new();
    let plan = FramePlan::build(&scene(), &library, 16.0 / 9.0).expect("plan");
    assert_eq!(plan.batches.len(), 2);
    assert_eq!((plan.batches[0].first_instance, plan.batches[0].instance_count), (0, 4), "cubes first");
    assert_eq!((plan.batches[1].first_instance, plan.batches[1].instance_count), (4, 2), "then spheres");
    assert_eq!(plan.instances.len(), 6);
    assert_eq!(plan.materials.len(), 2, "two distinct materials");
    let cube = library.entry(MeshId::CUBE).expect("cube");
    assert_eq!(plan.batches[0].index_count, cube.index_count);
    assert_eq!(plan.instances[0].model[12..15], [-2.0, 0.0, 0.0], "cube #1 keeps draw order");
    assert_eq!(plan.instances[3].model[12..15], [0.0, -2.0, 0.0]);
    assert_eq!(plan.logical_draws, 6, "culling never changes the logical draw count");
}

/// Pass-1 fix (features-off CPU): runs of one material share a row without a lookup each, and the
/// rows stay what the material keys make: an interleaved material finds its row again, and
/// materials equal but for a signed zero (distinct keys) keep distinct rows.
#[test]
fn runs_and_repeats_of_a_material_share_its_row_and_distinct_keys_keep_their_own() {
    let red = Material::color([200, 40, 40, 255]);
    let blue = Material::color([40, 40, 200, 255]);
    let mut negative = red;
    negative.metallic = -0.0;
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    for (i, material) in [red, red, blue, red, negative, red, blue].into_iter().enumerate() {
        scene.draw(MeshId::CUBE, translation(i as f32, 0.0, 0.0), material);
    }
    let plan = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    let rows: Vec<u32> = plan.instances.iter().map(|row| row.material).collect();
    assert_eq!(rows, [0, 0, 1, 0, 2, 0, 1], "rows in draw order");
    assert_eq!(plan.materials.len(), 3);
    assert_eq!(plan.material_ext.len(), 3, "an extension row beside each material row");
}

#[test]
fn the_cpu_cull_drops_what_is_behind_or_beside_the_frustum_and_keeps_order() {
    let plan = FramePlan::build(&scene(), &MeshLibrary::new(), 16.0 / 9.0).expect("plan");
    let cull = plan.cpu_cull();
    assert_eq!(cull.counts, vec![3, 1]);
    // Cube batch: instances 0, 2 (behind) and 3 are cubes at -2, +30, +2, -2y: index 1 is behind.
    assert_eq!(&cull.visible[0..3], &[0, 2, 3]);
    assert_eq!(cull.visible[4], 5, "the far sphere (4) is culled; batch region starts at first_instance");
}

#[test]
fn a_library_mesh_gets_its_own_batch_and_unknown_ids_are_refused() {
    let mut library = MeshLibrary::new();
    let tri = library.add(MeshData::cube()).expect("added");
    assert_ne!(tri, MeshId::CUBE);
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw(tri, translation(0.0, 0.0, 0.0), Material::color([255, 255, 255, 255]));
    assert_eq!(FramePlan::build(&scene, &library, 1.0).expect("plan").batches.len(), 1);
    scene.draw(MeshId::from_raw(99), translation(0.0, 0.0, 0.0), Material::missing());
    let error = FramePlan::build(&scene, &library, 1.0).expect_err("unknown mesh");
    assert_eq!(error.code().wire(), "mesh-invalid");
}

#[test]
fn the_letterbox_centres_the_world_at_the_largest_aspect_preserving_fit() {
    assert_eq!(letterbox((1920, 1080), (960, 540)), Viewport { x: 0, y: 0, width: 1920, height: 1080 });
    assert_eq!(letterbox((1000, 1000), (960, 540)), Viewport { x: 0, y: 219, width: 1000, height: 562 });
    assert_eq!(letterbox((300, 100), (100, 100)), Viewport { x: 100, y: 0, width: 100, height: 100 });
    assert_eq!(letterbox((0, 0), (100, 100)), Viewport { x: 0, y: 0, width: 0, height: 0 });
}

#[test]
fn window_points_map_into_world_pixels_through_the_letterbox_and_bars_map_to_none() {
    assert_eq!(window_to_world((300, 100), (100, 100), (150.0, 50.0)), Some((50.0, 50.0)));
    assert_eq!(window_to_world((300, 100), (100, 100), (50.0, 50.0)), None);
    assert_eq!(window_to_world((200, 200), (100, 100), (100.0, 20.0)), Some((50.0, 10.0)));
}

#[test]
fn shadows_switched_off_plan_exactly_what_an_unshadowed_scene_plans() {
    let library = MeshLibrary::new();
    let mut shadowed = scene();
    shadowed.lighting.shadows = true;
    let mut unshadowed = shadowed.clone();
    unshadowed.lighting.shadows = false;
    let off = FramePlan::build_shadowed(&shadowed, &library, 16.0 / 9.0, false).expect("plan");
    assert_eq!(off, FramePlan::build(&unshadowed, &library, 16.0 / 9.0).expect("plan"));
    assert!(off.cascades.is_none(), "no cascade is planned");
    let on = FramePlan::build_shadowed(&shadowed, &library, 16.0 / 9.0, true).expect("plan");
    assert_eq!(on, FramePlan::build(&shadowed, &library, 16.0 / 9.0).expect("plan"));
    assert!(on.cascades.is_some(), "the switch on keeps the scene's own shadows");
}

fn shadowed_scene() -> Scene {
    let mut scene = scene();
    scene.lighting.shadows = true;
    scene.lighting.sun_dir = [0.3, 0.8, 0.4];
    scene.lighting.sun_intensity = 2.0;
    scene
}

fn shadows_asking(cascades: u8) -> ShadowSettings {
    let mut quality = Quality::off().shadows;
    quality.cascades = cascades;
    ShadowSettings::from_quality(&quality, 40.0, SkyParams::default().sun_angular_radius)
}

fn plan_with(shadows: Option<ShadowSettings>) -> FramePlan {
    let options = PlanOptions { shadows, depth_reversed: false, sun: None };
    FramePlan::build_with(&shadowed_scene(), &MeshLibrary::new(), 16.0 / 9.0, &options).expect("plan")
}

#[test]
fn the_cull_views_reserve_nine_views_and_a_plan_activates_one_per_drawn_cascade() {
    assert_eq!((MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS), (4, 4, 9));
    let plan = plan_with(Some(shadows_asking(SHADOW_CASCADES as u8)));
    let drawn = plan.cascades_drawn();
    assert!((1..=MAX_CASCADES).contains(&drawn), "{drawn} cascades");
    assert_eq!(plan.views as usize, 1 + drawn, "the camera, then one view per drawn cascade");
    assert_eq!(plan.cull_views.planes.len(), MAX_VIEWS);
    assert_eq!(plan.cull_views.params[2], plan.views);
    assert_eq!(plan.frame.counts[2], plan.views);
    let cascades = plan.cascades.as_ref().expect("cascades");
    for (c, planes) in cascades.planes.iter().enumerate().take(drawn) {
        assert_eq!(&plan.cull_views.planes[1 + c], planes, "view {} is cascade {c}", 1 + c);
    }
    for unused in plan.views as usize..MAX_VIEWS {
        assert_eq!(plan.cull_views.planes[unused], [[0.0; 4]; 6], "view {unused} is reserved, not active");
    }
    // Each active view culls: the cascades keep the casters around the camera.
    for view in 0..plan.views as usize {
        let cull = plan.cpu_cull_view(view);
        assert!(cull.counts.iter().sum::<u32>() > 0, "view {view} keeps something");
    }
}

#[test]
fn the_frame_carries_every_drawn_cascade_past_the_frozen_v1_prefix() {
    let plan = plan_with(Some(shadows_asking(SHADOW_CASCADES as u8)));
    let drawn = plan.cascades_drawn();
    let cascades = plan.cascades.as_ref().expect("cascades");
    let frame = plan.frame;
    assert_eq!(frame.cascade_view_proj[..], cascades.view_proj[..SHADOW_CASCADES], "the v1 prefix keeps the first two");
    let offsets = cascades.normal_offsets();
    assert_eq!(frame.cascade_ends.len(), MAX_CASCADES);
    for (c, end) in frame.cascade_ends.iter().enumerate() {
        if c >= drawn {
            assert_eq!(*end, 0.0, "an undrawn cascade ends at 0");
            continue;
        }
        assert_eq!(frame.cascade_matrices[c], cascades.view_proj[c], "cascade {c}");
        assert_eq!(*end, cascades.splits[c], "cascade {c} end");
        assert_eq!(frame.cascade_offsets[c], offsets[c], "cascade {c} offset");
        assert_eq!(frame.cascade_texels[c], cascades.texel_world[c], "cascade {c} texel");
    }
    assert_eq!(frame.shadow_counts[0] as usize, drawn);
    assert_eq!(frame.shadow_counts[1], 0, "no shadowed spot is drawn before RQ6.5");
    let soft = frame.shadow_soft;
    assert_eq!(soft[0], libm::tanf(SkyParams::default().sun_angular_radius), "the penumbra's slope from the sun's size");
    assert_eq!(soft[1], DEFAULT_SHADOW_BLEND_BAND);
    // The v1 lanes are what they were: splits, bias, normal offsets, the texel in uv.
    assert_eq!(frame.cascade_splits[..2], cascades.splits[..2]);
    assert_eq!(frame.shadow_params[1..3], offsets[..2]);
}

#[test]
fn shadows_off_leave_the_frames_cascade_tail_empty() {
    let plan = plan_with(None);
    assert!(plan.cascades.is_none());
    assert_eq!((plan.views, plan.cascades_drawn()), (1, 0));
    assert_eq!(plan.frame.cascade_ends, [0.0; 4]);
    assert_eq!(plan.frame.shadow_counts, [0; 4]);
    assert_eq!(plan.frame.cascade_splits[3], 0.0, "the sun casts no shadows");
}

#[test]
fn the_planned_options_equal_the_legacy_builders() {
    let library = MeshLibrary::new();
    let scene = shadowed_scene();
    let legacy = FramePlan::build_depth(&scene, &library, 16.0 / 9.0, true, true).expect("plan");
    let shadows = ShadowSettings::from_quality(&Quality::off().shadows, scene.lighting.shadow_distance, SkyParams::default().sun_angular_radius);
    let options = PlanOptions { shadows: Some(shadows), depth_reversed: true, sun: None };
    assert_eq!(legacy, FramePlan::build_with(&scene, &library, 16.0 / 9.0, &options).expect("plan"));
}

#[test]
fn a_four_cascade_plan_activates_five_of_the_nine_views_and_culls_each() {
    let plan = plan_with(Some(shadows_asking(4)));
    assert_eq!((plan.cascades_drawn(), plan.views), (4, 5));
    // Lane FQ: the first cascade's receivers lie within a few metres of the camera, and the sun
    // casts every shape away from them, so its cull view (held to the receivers' light-space
    // polygon, no longer their box) keeps none; the farther cascades keep the shapes.
    assert_eq!(plan.cpu_cull_view(1).counts.iter().sum::<u32>(), 0, "nothing can shadow the first cascade's receivers");
    for view in 2..5 {
        assert!(plan.cpu_cull_view(view).counts.iter().sum::<u32>() > 0, "cascade view {view} culls");
    }
}

#[test]
fn the_default_shadow_settings_are_todays_shadows() {
    let off = RenderSettings::off().quality.shadows;
    let radius = SkyParams::default().sun_angular_radius;
    let legacy = ShadowSettings::from_quality(&off, 40.0, radius);
    assert_eq!(legacy, ShadowSettings::legacy(40.0));
    assert_eq!((legacy.cascades, legacy.map_px), (2, 1024), "two 1024 px cascades");
    assert_eq!((legacy.filter, legacy.format, legacy.far_cadence), (ShadowFilter::Pcf3x3, ShadowFormat::Depth32, 1));
    assert_eq!((legacy.split_lambda, legacy.blend_band), (DEFAULT_SHADOW_SPLIT_LAMBDA, DEFAULT_SHADOW_BLEND_BAND));
    assert_eq!((DEFAULT_SHADOW_SPLIT_LAMBDA, DEFAULT_SHADOW_BLEND_BAND), (0.5, 0.0), "the practical split, a hard switch");
    assert_eq!(legacy.sun_angular_radius, radius);
    assert_eq!(legacy.texture_format(), wgpu::TextureFormat::Depth32Float);
    let mut sixteen = off;
    sixteen.format = ShadowFormat::Depth16;
    assert_eq!(ShadowSettings::from_quality(&sixteen, 40.0, radius).texture_format(), wgpu::TextureFormat::Depth16Unorm);
}

#[test]
fn shadow_settings_hold_their_ranges() {
    let mut quality = Quality::off().shadows;
    quality.cascades = 9;
    quality.far_cadence = 0;
    let held = ShadowSettings::from_quality(&quality, f32::NAN, f32::NAN);
    assert_eq!(held.cascades as usize, MAX_CASCADES, "at most four cascades");
    assert_eq!(held.far_cadence, 1, "a cadence of 0 is every frame");
    assert!(held.distance.is_finite() && held.distance > 0.0, "a NaN distance keeps a usable one");
    assert!(held.sun_angular_radius.is_finite() && held.sun_angular_radius >= 0.0);
    quality.cascades = 0;
    assert_eq!(ShadowSettings::from_quality(&quality, 40.0, 0.0).cascades, 1, "at least one cascade");
    assert_eq!(ShadowSettings::legacy(40.0).with_split_lambda(2.0).split_lambda, 1.0);
    assert_eq!(ShadowSettings::legacy(40.0).with_blend_band(-1.0).blend_band, 0.0);
    assert_eq!(ShadowSettings::legacy(40.0).with_blend_band(0.9).blend_band, genex_render::settings::SHADOW_BLEND_BAND_MAX);
}

#[test]
fn far_cascades_follow_the_cadence_and_every_cascade_draws_on_a_settled_capture() {
    let mut quality = Quality::off().shadows;
    quality.cascades = 4;
    quality.far_cadence = 4;
    let shadows = ShadowSettings::from_quality(&quality, 40.0, 0.0);
    let drawn = |frame: u64, settled: bool| -> Vec<u8> { (0..4).filter(|c| shadows.cascade_redrawn(*c, frame, settled)).collect() };
    for frame in 0..8 {
        let cascades = drawn(frame, false);
        assert_eq!(cascades[0], 0, "the nearest cascade draws every frame ({frame})");
        assert!(cascades.len() <= 2, "at most one far cascade per frame at cadence 4 ({frame}: {cascades:?})");
        assert_eq!(drawn(frame, true), vec![0, 1, 2, 3], "a settled capture draws every cascade");
    }
    for far in 1..4u8 {
        let frames = (0..8).filter(|frame| shadows.cascade_redrawn(far, *frame, false)).count();
        assert_eq!(frames, 2, "far cascade {far} draws every 4th frame");
    }
    let every = ShadowSettings::legacy(40.0);
    assert!((0..8).all(|frame| (0..2).all(|c| every.cascade_redrawn(c, frame, false))), "cadence 1 draws every cascade");
}

#[test]
fn the_filters_shader_ids_are_the_sun_chunks_variants() {
    let ids: Vec<(ShadowFilter, u32)> = ShadowFilter::ALL.iter().map(|filter| (*filter, filter.shader_id())).collect();
    assert_eq!(
        ids,
        vec![
            (ShadowFilter::Hardware2x2, 0),
            (ShadowFilter::Pcf3x3, 1),
            (ShadowFilter::Pcf5x5, 2),
            (ShadowFilter::PcssLite, 3),
            (ShadowFilter::Pcss, 4),
        ]
    );
    assert_eq!(ShadowFilter::default().shader_id(), 1, "the sun chunk's default is today's 3x3 PCF");
    assert!(ShadowFilter::PcssLite.searches_blockers() && ShadowFilter::Pcss.searches_blockers());
    assert!(!ShadowFilter::Pcf5x5.searches_blockers());
}

#[test]
fn the_suns_angular_radius_comes_from_the_environment() {
    let wide = SkyParams::default().with_sun_angular_radius_degrees(2.0);
    assert_eq!(Environment::Sky(wide).sun_angular_radius(), wide.sun_angular_radius);
    assert_eq!(Environment::Color.sun_angular_radius(), SkyParams::default().sun_angular_radius);
    assert_eq!(Environment::hdri("sky.hdr").sun_angular_radius(), SkyParams::default().sun_angular_radius);
}

// ---------------------------------------------------------------------------------------------
// Levels of detail: the LOD row table (game systems LOD-02) and the fade batches (LOD-03)
//
// The GPU rows are `#[ignore]`d and their names contain `metal`:
//
//   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//     --offline --locked --test plan -- --ignored metal

mod lod {
    use super::*;
    use genex_render::lod_rows::{DrawLod, LOD_ROW_BYTES, lod_row};
    use genex_render::mesh::{LOD_FADE_TAG, LodChain, LodLevel};
    use genex_render::retained::InstanceGroup;
    use genex_render::scene::{CpuCull, ModelPart};
    use genex_render::{CullPath, Gpu, Renderer};

    const LOD_WIDTH: u32 = 640;
    const LOD_HEIGHT: u32 = 360;
    const ASPECT: f32 = LOD_WIDTH as f32 / LOD_HEIGHT as f32;
    /// The fade band the rows plan with (the design's default).
    const BAND: f32 = 0.15;
    /// The bits of a batch's LOD tag holding its level.
    const LEVEL_MASK: u32 = 0xF;

    /// A unit sphere moved by `offset`, with two coarser levels (the first half and the first
    /// quarter of its triangles; errors 0.02 and 0.08 of its radius).
    fn chained_sphere(offset: [f32; 3]) -> ModelPart {
        let mut mesh = MeshData::sphere();
        for vertex in &mut mesh.vertices {
            for (axis, shift) in offset.iter().enumerate() {
                vertex.position[axis] += shift;
            }
        }
        let triangles = mesh.indices.len() / 3;
        let level = |share: usize, error: f32| LodLevel { indices: mesh.indices[..triangles / share * 3].to_vec(), error };
        let lods = LodChain { levels: vec![level(2, 0.02), level(4, 0.08)] };
        ModelPart { mesh, meshlets: None, lods: Some(lods) }
    }

    /// The camera at the origin looking down -z, far enough for every row.
    fn down_z() -> CameraDesc {
        let mut camera = CameraDesc::look_at([0.0, 0.0, 0.0], [0.0, 0.0, -1.0]);
        camera.far = 10_000.0;
        camera
    }

    fn plan_of(scene: &Scene, library: &MeshLibrary) -> FramePlan {
        let mut plan = FramePlan::build(scene, library, ASPECT).expect("plan");
        plan.set_lod_height(LOD_HEIGHT);
        plan
    }

    /// The level instance row `row` is drawn at by a level's (not a fade) batch of `cull`.
    fn drawn_level(plan: &FramePlan, cull: &CpuCull, row: u32) -> Option<u32> {
        let mut found = plan.batches.iter().zip(&cull.counts).filter(|(batch, count)| {
            let region = &cull.visible[batch.first_instance as usize..(batch.first_instance + **count) as usize];
            batch.lod[0] & LOD_FADE_TAG == 0 && region.contains(&row)
        });
        let level = found.next().map(|(batch, _)| batch.lod[0] & LEVEL_MASK);
        assert!(found.next().is_none(), "row {row} is drawn whole by one batch at most");
        level
    }

    /// Distances from 4 m to 2 km, geometric.
    fn distances(steps: usize) -> impl Iterator<Item = f32> {
        (0..steps).map(move |step| 4.0 * libm::powf(500.0, step as f32 / (steps - 1) as f32))
    }

    #[test]
    fn a_compound_models_parts_switch_at_the_same_distance() {
        let mut library = MeshLibrary::new();
        let near = library.add_part(chained_sphere([0.0, 0.0, 0.0])).expect("part");
        let behind = library.add_part(chained_sphere([0.0, 0.0, -6.0])).expect("part");
        // The model's sphere holds both parts: every part measures from it.
        let model_sphere = DrawLod { origin: Some([0.0, 0.0, -3.0, 4.0]), bias: 1.0, ..DrawLod::OWN };
        let material = Material::color([180, 170, 160, 255]);
        let (mut apart, mut levels_seen) = (0, std::collections::BTreeSet::new());
        for distance in distances(240) {
            for lod in [DrawLod::OWN, model_sphere] {
                let mut scene = Scene::new(down_z(), [0; 4]);
                scene.set_lod(lod);
                scene.draw(near, translation(0.0, 0.0, -distance), material).draw(behind, translation(0.0, 0.0, -distance), material);
                let plan = plan_of(&scene, &library);
                assert_eq!(plan.batches.len(), 6, "three levels per part");
                let cull = plan.cpu_cull();
                let (a, b) = (drawn_level(&plan, &cull, 0), drawn_level(&plan, &cull, 1));
                if lod == model_sphere {
                    assert_eq!(a, b, "at {distance} m the parts measured from the model's sphere draw one level");
                    levels_seen.insert(a);
                } else if a != b {
                    apart += 1;
                }
            }
        }
        assert!(apart > 0, "measured from their own spheres the parts switch at different distances");
        assert_eq!(levels_seen.len(), 3, "the sweep crosses every level: {levels_seen:?}");
    }

    #[test]
    fn bias_two_holds_each_level_twice_as_far() {
        let mut library = MeshLibrary::new();
        let mesh = library.add_part(chained_sphere([0.0; 3])).expect("part");
        let material = Material::color([180, 170, 160, 255]);
        // A point origin: the distance is exactly the origin's, so doubling it is exact.
        let level_at = |distance: f32, bias: f32| {
            let mut scene = Scene::new(down_z(), [0; 4]);
            scene.set_lod(DrawLod { origin: Some([0.0; 4]), bias, ..DrawLod::OWN });
            scene.draw(mesh, translation(0.0, 0.0, -distance), material);
            let plan = plan_of(&scene, &library);
            drawn_level(&plan, &plan.cpu_cull(), 0).expect("in view")
        };
        let mut seen = std::collections::BTreeSet::new();
        for distance in distances(300) {
            let once = level_at(distance, 1.0);
            assert_eq!(level_at(distance * 2.0, 2.0), once, "bias 2 at {} m draws what bias 1 draws at {distance} m", distance * 2.0);
            seen.insert(once);
        }
        assert_eq!(seen.len(), 3, "the sweep crosses every level: {seen:?}");
        assert!(distances(300).any(|distance| level_at(distance, 2.0) < level_at(distance, 1.0)), "at some distance bias 2 is finer");
        assert!(distances(300).all(|distance| level_at(distance, 2.0) <= level_at(distance, 1.0)), "and never coarser");
    }

    #[test]
    fn a_retained_groups_lod_rows_are_computed_once_per_version_and_an_update_recomputes_its_range() {
        let mut library = MeshLibrary::new();
        let mesh = library.add_part(chained_sphere([0.0; 3])).expect("part");
        let entry = *library.entry(mesh).expect("entry");
        let models: Vec<[f32; 16]> = (0..40).map(|i| translation(i as f32, 0.0, -10.0 - i as f32)).collect();
        let mut group = InstanceGroup::new(mesh, Material::color([90, 140, 90, 255]), models.clone()).expect("group");
        let lod = DrawLod { origin: Some([0.0, 0.0, 0.0, 2.0]), bias: 1.5, ..DrawLod::OWN };
        let mut scene = Scene::new(down_z(), [0; 4]);
        scene.set_lod(lod).draw_group(&group);
        let first = plan_of(&scene, &library);
        let rows = group.lod_rows(entry.center, entry.radius, &lod);
        assert_eq!(first.lod_rows, *rows, "the plan carries the group's rows");
        assert!(std::sync::Arc::ptr_eq(&rows, &group.lod_rows(entry.center, entry.radius, &lod)), "computed once per version");
        for (row, (model, instance)) in rows.iter().zip(models.iter().zip(&first.instances)) {
            assert_eq!(*row, lod_row(model, instance.bounds, &lod));
        }
        assert_eq!(first.lod_rows.len(), first.opaque_instances as usize, "one LOD row per opaque row");
        group.update(5, &[translation(0.0, 3.0, -50.0)]).expect("update");
        let updated = group.lod_rows(entry.center, entry.radius, &lod);
        assert_eq!(updated[5].origin, [0.0, 3.0, -50.0, 2.0]);
        assert_eq!(updated[..5], rows[..5]);
        assert_eq!(updated[6..], rows[6..]);
        // Another draw LOD for the same group recomputes its rows.
        let own = group.lod_rows(entry.center, entry.radius, &DrawLod::OWN);
        assert_eq!(own[0].origin, group.rows(entry.center, entry.radius)[0].bounds, "measured from its own bounds");
    }

    /// Spheres along -z from 3 m to about 3 km, every third measuring from a point origin with
    /// bias 2 and every fifth from a wide sphere, in the sun's shadows.
    fn receding(mesh: genex_render::scene::MeshId, count: usize, band: f32) -> Scene {
        let mut camera = CameraDesc::look_at([0.0, 1.0, 0.0], [0.0, 1.0, -1.0]);
        camera.far = 5000.0;
        let mut scene = Scene::new(camera, [20, 24, 30, 255]);
        scene.lighting.shadows = true;
        scene.lod_band = band;
        for i in 0..count {
            let distance = 3.0 * libm::powf(1000.0, i as f32 / (count - 1).max(1) as f32);
            let x = ((i % 7) as f32 - 3.0) * distance * 0.06;
            let lod = match (i % 3, i % 5) {
                (0, _) => DrawLod { origin: Some([0.0; 4]), bias: 2.0, ..DrawLod::OWN },
                (_, 0) => DrawLod { origin: Some([0.0, 0.0, 1.0, 3.0]), bias: 0.5, ..DrawLod::OWN },
                _ => DrawLod::OWN,
            };
            scene.set_lod(lod).draw(mesh, translation(x, 1.0, -distance), Material::color([180, 170, 160, 255]));
        }
        scene
    }

    #[test]
    fn each_instance_in_band_is_kept_by_its_two_fade_batches_only() {
        let mut library = MeshLibrary::new();
        let mesh = library.add_part(chained_sphere([0.0; 3])).expect("part");
        let count = 400;
        let plan = plan_of(&receding(mesh, count, BAND), &library);
        assert_eq!(plan.batches.len(), 6, "three level batches, then their three fade twins");
        assert_eq!(plan.fade_runs.len(), 1);
        assert_eq!(plan.fade_runs[0].batches, 3..6, "the fade twins follow every other batch");
        assert!(plan.batches[3..].iter().all(|batch| batch.lod[0] & LOD_FADE_TAG != 0 && batch.first_row == 0));
        assert_eq!(plan.visible_slots as usize, count * 6, "each twin has slots of its own");
        let (mut whole, mut faded) = (0, 0);
        for view in 0..plan.views as usize {
            let cull = plan.cpu_cull_view(view);
            let mut kept: Vec<Vec<(u32, f32)>> = vec![Vec::new(); count];
            for (b, (batch, survivors)) in plan.batches.iter().zip(&cull.counts).enumerate() {
                for slot in batch.first_instance..batch.first_instance + survivors {
                    let fade = cull.fades[slot as usize][0];
                    kept[cull.visible[slot as usize] as usize].push((b as u32, fade));
                    assert_eq!(cull.fades[slot as usize][1], 1.0, "grow is 1 until the far field");
                }
            }
            for (row, pairs) in kept.iter().enumerate() {
                match pairs.as_slice() {
                    [] => {}
                    [(b, fade)] => {
                        assert!(*b < 3 && *fade == 1.0, "row {row} whole in a level's batch, view {view}: {pairs:?}");
                        whole += 1;
                    }
                    [(out_batch, out), (in_batch, fade_in)] => {
                        assert!(*out_batch >= 3 && *in_batch == out_batch + 1, "row {row} in two neighbouring fade twins, view {view}: {pairs:?}");
                        assert!(*fade_in < 0.0 && *out > 0.0 && *out < 1.0, "fading out then in: {pairs:?}");
                        assert_eq!(*out, 1.0 + fade_in, "the shares sum to one: {pairs:?}");
                        faded += 1;
                    }
                    other => panic!("row {row} kept {} times in view {view}: {other:?}", other.len()),
                }
            }
        }
        assert!(whole > 0 && faded > 0, "the sweep draws rows whole and rows in band ({whole}, {faded})");
    }

    #[test]
    fn without_a_band_the_plan_has_no_fade_batch_and_the_hard_switch_is_unchanged() {
        let mut library = MeshLibrary::new();
        let mesh = library.add_part(chained_sphere([0.0; 3])).expect("part");
        let hard = plan_of(&receding(mesh, 120, 0.0), &library);
        assert_eq!(hard.batches.len(), 3);
        assert!(hard.fade_runs.is_empty() && hard.fade_slots.is_empty());
        assert_eq!(hard.cull_views.lod_params[1], 0, "no band in the cull");
        for band in [f32::NAN, -0.1, 1.5] {
            let plan = plan_of(&receding(mesh, 120, band), &library);
            assert_eq!(plan, hard, "band {band} is no band");
        }
        // Inside the band's rows the band's whole batches keep only whole rows: away from every
        // band, a band's plan keeps what the hard switch keeps.
        let banded = plan_of(&receding(mesh, 120, BAND), &library);
        for view in 0..hard.views as usize {
            let (h, b) = (hard.cpu_cull_view(view), banded.cpu_cull_view(view));
            for row in 0..120 {
                let in_band = (3..6).any(|twin| {
                    let batch = &banded.batches[twin];
                    b.visible[batch.first_instance as usize..(batch.first_instance + b.counts[twin]) as usize].contains(&row)
                });
                if !in_band {
                    assert_eq!(drawn_level(&banded, &b, row), drawn_level(&hard, &h, row), "row {row}, view {view}");
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // GPU

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

    /// Every view's indirect counts, visible lists and fade-batch fades of the last GPU cull
    /// equal the CPU cull's, slot for slot (the fades to the bit).
    fn assert_gpu_cull_equals_cpu(gpu: &Gpu, renderer: &Renderer, plan: &FramePlan) -> usize {
        let mut fades = 0;
        for view in 0..plan.views {
            let cpu = plan.cpu_cull_view(view as usize);
            let counts: Vec<u32> = renderer.read_view_args(gpu, view).expect("args").iter().map(|a| a.instance_count).collect();
            assert_eq!(counts, cpu.counts, "view {view}'s survivors per batch");
            let visible = renderer.read_view_visible(gpu, view).expect("visible");
            let gpu_fades = renderer.read_view_fades(gpu, view).expect("fades");
            for (batch, count) in plan.batches.iter().zip(&cpu.counts) {
                let range = batch.first_instance as usize..(batch.first_instance + count) as usize;
                assert_eq!(visible[range.clone()], cpu.visible[range.clone()], "view {view}'s visible list from slot {}", batch.first_instance);
                if batch.lod[0] & LOD_FADE_TAG != 0 {
                    let bits = |fades: &[[f32; 2]]| fades.iter().map(|f| f.map(f32::to_bits)).collect::<Vec<_>>();
                    assert_eq!(bits(&gpu_fades[range.clone()]), bits(&cpu.fades[range.clone()]), "view {view}'s fades from slot {}", batch.first_instance);
                    fades += range.len();
                }
            }
        }
        fades
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_the_gpu_cull_keeps_the_cpus_levels_and_fades_with_origins_biases_and_a_band() {
        let Some(gpu) = gpu() else { return };
        let mut renderer = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
        let mesh = renderer.add_model_parts(&gpu, vec![chained_sphere([0.0; 3])]).expect("added")[0];
        for band in [0.0, BAND, 0.5] {
            let scene = receding(mesh, 600, band);
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            let plan = plan_of(&scene, renderer.library());
            assert!(plan.views > 1, "the sun's cascades are culled too");
            let fades = assert_gpu_cull_equals_cpu(&gpu, &renderer, &plan);
            eprintln!("band {band}: {} batches, {fades} fade-batch survivors over {} views", plan.batches.len(), plan.views);
            assert_eq!(fades > 0, band > 0.0, "a band fades rows, no band none");
        }
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_retained_groups_lod_rows_upload_once() {
        let Some(gpu) = gpu() else { return };
        let mut renderer = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
        let mesh = renderer.add_model_parts(&gpu, vec![chained_sphere([0.0; 3])]).expect("added")[0];
        let models: Vec<[f32; 16]> = (0..500).map(|i| translation((i % 25) as f32 * 3.0 - 36.0, 0.0, -8.0 - (i / 25) as f32 * 9.0)).collect();
        let mut group = InstanceGroup::new(mesh, Material::color([90, 140, 90, 255]), models).expect("group");
        let frame = |group: &InstanceGroup| {
            let mut scene = Scene::new(down_z(), [0; 4]);
            scene.set_lod(DrawLod { origin: None, bias: 2.0, ..DrawLod::OWN }).draw_group(group);
            scene
        };
        let mut uploads = Vec::new();
        for _ in 0..3 {
            renderer.render(&gpu, &frame(&group), CullPath::Gpu).expect("frame");
            uploads.push(renderer.last_lod_row_upload_bytes());
        }
        group.update(10, &[translation(0.0, 0.0, -20.0); 4]).expect("update");
        renderer.render(&gpu, &frame(&group), CullPath::Gpu).expect("frame");
        uploads.push(renderer.last_lod_row_upload_bytes());
        assert_eq!(uploads, vec![500 * LOD_ROW_BYTES, 0, 0, 4 * LOD_ROW_BYTES], "written once, then only the updated rows");
        let plan = plan_of(&frame(&group), renderer.library());
        assert_gpu_cull_equals_cpu(&gpu, &renderer, &plan);
        let ledger = renderer.buffer_ledger();
        let lod_rows = ledger.entries().iter().find(|entry| entry.label == "lod rows").map(|entry| entry.bytes);
        eprintln!("ledger lod rows: {lod_rows:?} bytes for 500 rows");
        assert!(lod_rows.is_some_and(|bytes| bytes >= 500 * LOD_ROW_BYTES), "the ledger's lod rows hold every row: {lod_rows:?}");
    }

    #[test]
    #[ignore = "needs a GPU: run with --ignored metal"]
    fn metal_a_frame_with_no_row_in_band_draws_no_fade_and_the_picture_of_no_band() {
        let Some(gpu) = gpu() else { return };
        let picture = |band: f32| {
            let mut renderer = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
            let mesh = renderer.add_model_parts(&gpu, vec![chained_sphere([0.0; 3])]).expect("added")[0];
            let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 4.0], [0.0, 0.0, 0.0]), [20, 24, 30, 255]);
            scene.lighting.shadows = true;
            scene.lod_band = band;
            for i in 0..5 {
                scene.draw(mesh, translation(i as f32 * 2.5 - 5.0, 0.0, -2.0), Material::color([180, 170, 160, 255]));
            }
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            let plan = plan_of(&scene, renderer.library());
            let fades = assert_gpu_cull_equals_cpu(&gpu, &renderer, &plan);
            let args = renderer.read_view_args(&gpu, 0).expect("args");
            (renderer.capture(&gpu).expect("capture"), fades, args.iter().skip(3).map(|a| a.instance_count).sum::<u32>(), plan.batches.len())
        };
        let (hard, _, _, hard_batches) = picture(0.0);
        let (banded, fades, twin_survivors, banded_batches) = picture(BAND);
        assert_eq!((hard_batches, banded_batches), (3, 6), "the band plans fade twins");
        assert_eq!((fades, twin_survivors), (0, 0), "no row is in band: no fade written, no twin keeps a row");
        assert_eq!(banded.digest(), hard.digest(), "the picture is the hard switch's, bit for bit");
    }
}
