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
    for view in 1..5 {
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
