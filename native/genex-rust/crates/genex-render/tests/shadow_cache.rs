//! Renderer pass 2, B.6: cached static shadows plus a dynamic overlay (`genex_render::shadow_cache`).
//! CPU rows hold the plan: a still world's layer draws whole, then rebuilds its cache, then reuses
//! it; a cached caster that moves leaves the cache on the frame it moves; a cascade following a
//! moving camera draws whole; settled frames and a switched-off cache draw every layer whole. The
//! GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --release --test shadow_cache -- --ignored metal
//!
//! (the cost row's gate needs `--release`). Cached frames match uncached ones byte for byte while
//! casters move, stop and a cached caster moves (no stale shadow), with a shadowed spot beside the
//! cascades; and a large static world saves at least [`SHADOW_TIME_SAVED_MIN`] of its shadow time
//! (`GENEX_RENDER_PERF_DIR` receives the cost row).

use std::path::PathBuf;

use genex_render::device_class::DeviceClass;
use genex_render::layout::MAX_LOCAL_LIGHTS;
use genex_render::lod_rows::{DrawLod, FAR_RULE_NONE, GpuFarRule};
use genex_render::lights::SpotLight;
use genex_render::mesh::MeshData;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PlanOptions, Scene, scaled, translation};
use genex_render::settings::{Quality, QualityPreset, SceneFormat, ShadowFilter, ShadowSettings};
use genex_render::shadow::CascadeHistory;
use genex_render::shadow_cache::{CachePlan, LayerUse, STILL_FRAMES, ShadowCache};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

const ASPECT: f32 = 16.0 / 9.0;
const SUN: [f32; 3] = [0.5, 1.0, 0.35];
const DISTANCE: f32 = 40.0;
/// An opaque grey (alpha below 255 would draw as glass, which casts no shadow).
const GREY: [u8; 4] = [200, 200, 200, 255];

/// Spheres on a side of the CPU rows' grid: 256 spheres, about 262 thousand triangles, more than
/// a 1024 px layer's copy is worth.
const GRID: usize = 16;

/// A ground (a cube batch) with a `grid` x `grid` field of spheres on it and a cube at `cube_x`.
fn world_of(eye_x: f32, cube_x: f32, grid: usize) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([eye_x, 4.0, 10.0], [eye_x, 0.0, -4.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadow_distance = DISTANCE;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [30.0, 0.2, 30.0]), Material::color(GREY));
    scene.draw(MeshId::CUBE, translation(cube_x, 0.0, -2.0), Material::color(GREY));
    for i in 0..grid * grid {
        let (x, z) = ((i % grid) as f32 * 1.5 - 11.0, (i / grid) as f32 * 1.5 - 16.0);
        scene.draw(MeshId::SPHERE, translation(x, 0.0, z), Material::color(GREY));
    }
    scene
}

fn world(eye_x: f32, cube_x: f32) -> Scene {
    world_of(eye_x, cube_x, GRID)
}

fn shadows() -> ShadowSettings {
    let mut settings = ShadowSettings::from_quality(&Quality::off().shadows, DISTANCE, 0.0);
    settings.cascades = 2;
    settings
}

/// One Live frame of `scene` through `cache`, its cascades planned by `history`.
fn step(cache: &mut ShadowCache, history: &mut CascadeHistory, frame: u64, scene: &Scene, live: bool) -> (FramePlan, CachePlan) {
    step_with(cache, history, frame, scene, live, true)
}

/// [`step`], `array` whether the renderer may hold a cache array.
fn step_with(cache: &mut ShadowCache, history: &mut CascadeHistory, frame: u64, scene: &Scene, live: bool, array: bool) -> (FramePlan, CachePlan) {
    let options = PlanOptions { shadows: Some(shadows()), depth_reversed: false, sun: None };
    let mut plan = FramePlan::build_with(scene, &MeshLibrary::new(), ASPECT, &options).expect("plan");
    let draws = history.advance(&mut plan, frame, !live);
    let desc = genex_render::shadow::ShadowMapDesc::for_settings(&shadows());
    let cached = cache.plan(&plan, &draws, desc, live, (false, array));
    (plan, cached)
}

/// The batch of `plan` drawing `mesh` (one batch per drawn library mesh, ascending mesh id: the
/// world's cubes, then its spheres), checked by its row count.
fn batch_of(plan: &FramePlan, mesh: MeshId) -> u32 {
    let (batch, rows) = if mesh == MeshId::CUBE { (0, 2) } else { (1, (GRID * GRID) as u32) };
    assert_eq!(plan.batches[batch as usize].instance_count, rows, "the world's batches");
    batch
}

#[test]
fn a_still_world_draws_whole_until_its_casters_stood_still_then_holds_its_maps() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    let scene = world(0.0, 2.0);
    let uses: Vec<[LayerUse; 2]> = (0..STILL_FRAMES as u64 + 6)
        .map(|frame| {
            let (_, plan) = step(&mut cache, &mut history, frame, &scene, true);
            [plan.layer(0), plan.layer(1)]
        })
        .collect();
    let first = STILL_FRAMES as usize;
    // No batch stood still long enough before, and the first frame with a static set is new to
    // each layer: every layer draws whole.
    assert!(uses[..=first].iter().all(|layer| *layer == [LayerUse::Draw; 2]), "{uses:?}");
    // Nothing else reaches the layers: their maps already hold the statics, so no pass runs.
    assert!(uses[first + 1..].iter().all(|layer| *layer == [LayerUse::Hold; 2]), "{uses:?}");
}

/// A far rule that thins the CPU rows' field from 5 m (game systems LOD-18): the camera's view
/// of it changes whenever the camera moves, whatever its rows do.
const FOREST_RULE: GpuFarRule = GpuFarRule { start: 5.0, end: 25.0, keep: 0.3, fade_out: 10.0 };

/// [`world`] with its spheres thinned by [`FOREST_RULE`] (a forest past its far start), fading in
/// a band of `band` (LOD-03's fade twins of every far-ruled mesh are drawn either way).
fn forest(band: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 10.0], [0.0, 0.0, -4.0]), [0, 0, 0, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadow_distance = DISTANCE;
    scene.lod_band = band;
    scene.far_rules = vec![FOREST_RULE];
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [30.0, 0.2, 30.0]), Material::color(GREY));
    scene.draw(MeshId::CUBE, translation(2.0, 0.0, -2.0), Material::color(GREY));
    scene.set_lod(DrawLod { far_rule: 1, ..DrawLod::OWN });
    for i in 0..GRID * GRID {
        let (x, z) = ((i % GRID) as f32 * 1.5 - 11.0, (i / GRID) as f32 * 1.5 - 16.0);
        scene.draw(MeshId::SPHERE, translation(x, 0.0, z), Material::color(GREY));
    }
    scene
}

/// Whether batch `b` of `plan` draws rows a far rule thins.
fn far_ruled(plan: &FramePlan, b: usize) -> bool {
    let batch = &plan.batches[b];
    let first = batch.first_row as usize;
    plan.lod_rows.get(first..first + batch.instance_count as usize).unwrap_or(&[]).iter().any(|row| row.far_rule != FAR_RULE_NONE)
}

// Game systems LOD-05. At head the thinned field stood still, so it joined the cache: the cached
// layers kept every sphere whole while the camera's cull thinned and faded them (a stale shadow).
#[test]
fn a_fading_forest_never_enters_the_static_cache() {
    for band in [0.0, 0.15] {
        let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
        let scene = forest(band);
        let warm = STILL_FRAMES as u64 + 6;
        for frame in 0..warm {
            let (plan, cached) = step(&mut cache, &mut history, frame, &scene, true);
            assert!(!plan.fade_runs.is_empty(), "band {band}: the forest draws its fade twins");
            let thinned: Vec<usize> = (0..plan.batches.len()).filter(|b| far_ruled(&plan, *b)).collect();
            assert!(thinned.len() >= 2, "band {band}: the field and its twin ({thinned:?})");
            for b in thinned {
                assert!(!cached.cached(b as u32), "band {band} frame {frame}: batch {b} (thinned by a far rule) entered the cache");
            }
            if frame + 1 == warm {
                assert!(cached.cached(0), "band {band}: the still ground and cube stay cached");
                for layer in 0..2 {
                    assert!(cached.reached(layer), "band {band}: the forest reaches cascade {layer}: it draws over the cache");
                    assert_ne!(cached.layer(layer), LayerUse::Hold, "band {band}: a layer the forest reaches is never held");
                }
            }
        }
    }
}

#[test]
fn a_cached_caster_that_moves_leaves_the_cache_on_the_frame_it_moves_and_never_reads_a_stale_layer() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    let warm = STILL_FRAMES as u64 + 4;
    for frame in 0..warm {
        let (_, plan) = step(&mut cache, &mut history, frame, &world(0.0, 2.0), true);
        if frame + 1 == warm {
            assert_eq!([plan.layer(0), plan.layer(1)], [LayerUse::Hold; 2]);
        }
    }
    // The cube batch (the ground and the cube) and the spheres are cached; the cube now moves.
    let mut seen: [Vec<(LayerUse, bool)>; 2] = [Vec::new(), Vec::new()];
    for k in 0..6u64 {
        let (plan, cached) = step(&mut cache, &mut history, warm + k, &world(0.0, 2.0 + 0.3 * (k + 1) as f32), true);
        let (cube, sphere) = (batch_of(&plan, MeshId::CUBE), batch_of(&plan, MeshId::SPHERE));
        assert!(!cached.cached(cube), "frame {k}: the moving cube's batch is the overlay's");
        assert!(cached.cached(sphere), "frame {k}: the still spheres stay cached");
        for (layer, seen) in seen.iter_mut().enumerate() {
            seen.push((cached.layer(layer), cached.reached(layer)));
        }
    }
    // The ground reaches every cascade. The frame the cube moves the static set changes: each
    // layer draws whole, then caches the spheres alone, then reuses that cache with the ground and
    // the cube drawn over it every frame; none is held, so none keeps a stale cube.
    for seen in &seen {
        assert!(seen.iter().all(|(_, reached)| *reached), "{seen:?}");
        let uses: Vec<LayerUse> = seen.iter().map(|(used, _)| *used).collect();
        assert_eq!(uses[..2], [LayerUse::Draw, LayerUse::Rebuild], "{uses:?}");
        assert!(uses[2..].iter().all(|used| *used == LayerUse::Reuse), "{uses:?}");
    }
}

#[test]
fn a_layer_whose_cached_casters_are_light_draws_whole_instead_of_copying_its_cache() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    let warm = STILL_FRAMES as u64 + 4;
    for frame in 0..warm {
        step(&mut cache, &mut history, frame, &world_of(0.0, 2.0, 2), true);
    }
    // Four spheres and the ground: the cube moving never makes a copy worth it.
    for k in 0..6u64 {
        let (_, plan) = step(&mut cache, &mut history, warm + k, &world_of(0.0, 2.0 + 0.3 * (k + 1) as f32, 2), true);
        assert_eq!([plan.layer(0), plan.layer(1)], [LayerUse::Draw; 2], "frame {k}");
    }
}

#[test]
fn without_a_cache_array_a_layer_only_holds_or_draws_whole() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    let warm = STILL_FRAMES as u64 + 4;
    for frame in 0..warm {
        let (_, plan) = step_with(&mut cache, &mut history, frame, &world(0.0, 2.0), true, false);
        if frame + 1 == warm {
            assert_eq!([plan.layer(0), plan.layer(1)], [LayerUse::Hold; 2], "a still world holds its maps without an array");
        }
    }
    for k in 0..6u64 {
        let (_, plan) = step_with(&mut cache, &mut history, warm + k, &world(0.0, 2.0 + 0.3 * (k + 1) as f32), true, false);
        assert_eq!([plan.layer(0), plan.layer(1)], [LayerUse::Draw; 2], "frame {k}: no array to rebuild");
    }
}

#[test]
fn a_cascade_following_a_moving_camera_draws_whole_and_never_copies() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    for frame in 0..STILL_FRAMES as u64 + 4 {
        step(&mut cache, &mut history, frame, &world(0.0, 2.0), true);
    }
    for k in 1..8u64 {
        let (_, plan) = step(&mut cache, &mut history, STILL_FRAMES as u64 + 4 + k, &world(0.9 * k as f32, 2.0), true);
        assert_eq!(plan.layer(0), LayerUse::Draw, "step {k}: the nearest cascade moved with the camera");
    }
}

#[test]
fn settled_frames_and_a_switched_off_cache_draw_every_layer_whole() {
    let (mut cache, mut history) = (ShadowCache::default(), CascadeHistory::default());
    let scene = world(0.0, 2.0);
    for frame in 0..STILL_FRAMES as u64 + 4 {
        let (_, plan) = step(&mut cache, &mut history, frame, &scene, false);
        assert_eq!(plan.cached_layers(), 0, "a settled frame draws every layer whole");
    }
    cache.set_enabled(false);
    for frame in 0..STILL_FRAMES as u64 + 4 {
        let (_, plan) = step(&mut cache, &mut history, frame, &scene, true);
        assert_eq!(plan.cached_layers(), 0, "the cache is off");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows

static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu_row() -> std::sync::MutexGuard<'static, ()> {
    GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
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

/// The high preset's sun shadows (cascades, map size, format, PCSS) on the plain HDR path, every
/// local light binned, with `spots` shadow slots and `filter` (the cost row's is a cheap PCF, so
/// its shadow time is mostly the maps).
fn shadow_quality(spots: u8, filter: Option<ShadowFilter>) -> Quality {
    let class = DeviceClass::from_wire("desktop-ultra").expect("a class");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.shadows = preset_quality(QualityPreset::High, class).shadows;
    quality.shadows.screen_mask = false;
    if let Some(filter) = filter {
        quality.shadows.filter = filter;
    }
    quality.lights.clustered = true;
    quality.lights.cap = MAX_LOCAL_LIGHTS as u32;
    quality.lights.tile_px = 16;
    quality.lights.shadowed_spots = spots;
    quality
}

fn renderer(gpu: &Gpu, size: (u32, u32), quality: &Quality, cache: bool) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_quality(quality);
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_static_shadow_cache(cache);
    renderer
}

fn down_spot(position: [f32; 3], shadow: bool) -> SpotLight {
    SpotLight {
        position,
        direction: [0.0, -1.0, 0.0],
        range: 12.0,
        color: [255, 255, 255],
        intensity: 30.0,
        inner_angle: 30f32.to_radians(),
        outer_angle: 40f32.to_radians(),
        shadow,
    }
}

/// The match row's frame `frame`: a ground and two boxes (the cube batch), a field of spheres, a
/// shadowed spot over them, and a mover (a mesh of its own). The mover moves on frames 13-24 and
/// stands still after; a box moves on frame 36 and stands still after.
fn match_scene(frame: u64, mover: MeshId) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 6.0, 10.0], [0.0, 0.0, -3.0]), [20, 30, 40, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadow_distance = DISTANCE;
    scene.lighting.spots = vec![SpotLight { range: 14.0, ..down_spot([-2.0, 8.0, -3.0], true) }];
    scene.draw(MeshId::CUBE, scaled([0.0, -0.55, -4.0], [30.0, 0.1, 30.0]), Material::color(GREY));
    scene.draw(MeshId::CUBE, translation(4.0, 1.2, 1.0), Material::color(GREY));
    let box_x = if frame >= 36 { -4.0 } else { -5.0 };
    scene.draw(MeshId::CUBE, translation(box_x, 1.2, 1.0), Material::color(GREY));
    for i in 0..MATCH_GRID * MATCH_GRID {
        let (x, z) = ((i % MATCH_GRID) as f32 - 9.5, (i / MATCH_GRID) as f32 - 13.5);
        scene.draw(MeshId::SPHERE, translation(x, 0.0, z), Material::color(GREY));
    }
    let moving = 0.12 * frame.clamp(12, 24).saturating_sub(12) as f32;
    scene.draw(mover, translation(-3.0 + moving, 1.4, -2.0), Material::color(GREY));
    scene
}

/// Spheres on a side of the match row's field: 400 spheres, enough triangles in every layer for
/// its cache to pay at 1024 px.
const MATCH_GRID: usize = 20;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cached_shadow_frames_match_uncached_ones_byte_for_byte_while_casters_move_and_stop() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let mut quality = shadow_quality(1, None);
    // 1024 px layers, so the field's casters outweigh a layer's copy (`CACHE_PAYS_TRIANGLES_PER_BYTE`).
    quality.shadows.map_size = 1024;
    let size = (256, 144);
    let mut renderers = [false, true].map(|cache| renderer(&gpu, size, &quality, cache));
    let movers: Vec<MeshId> = renderers.iter_mut().map(|renderer| renderer.add_mesh(&gpu, MeshData::cube()).expect("the mover's mesh")).collect();
    let layers = usize::from(quality.shadows.cascades) + 1;
    let mut cached_frames = Vec::new();
    for frame in 0..48u64 {
        let captures: Vec<_> = renderers
            .iter_mut()
            .zip(&movers)
            .map(|(renderer, mover)| {
                renderer.set_frame_index(frame);
                renderer.render(&gpu, &match_scene(frame, *mover), CullPath::Gpu).expect("frame");
                (renderer.capture(&gpu).expect("capture"), renderer.last_stats().shadow_layers_cached)
            })
            .collect();
        assert_eq!(captures[0].1, 0, "frame {frame}: the uncached renderer drew from a cache");
        let differing = captures[0].0.bgra().iter().zip(captures[1].0.bgra()).filter(|(a, b)| a != b).count();
        assert_eq!(differing, 0, "frame {frame}: the cached frame differs from the uncached one in {differing} bytes");
        cached_frames.push(captures[1].1 as usize);
    }
    eprintln!("cached layers by frame ({layers} layers): {cached_frames:?}");
    // Once the field stood still every layer is held or drawn from the cache, the ones the moving
    // mover reaches with it drawn over the cache; after the mover and after the box stopped too.
    let all = |frames: std::ops::Range<usize>| frames.clone().all(|frame| cached_frames[frame] == layers);
    assert!(all(10..13), "before the mover moves: {cached_frames:?}");
    assert!(all(15..25), "while the mover moves: {cached_frames:?}");
    assert!(all(34..36), "after the mover joined the cache: {cached_frames:?}");
    // With the ground in the overlay (the box shares its mesh), the far cascade's few cached
    // spheres no longer outweigh its copy: it draws whole; the others reuse their caches.
    assert!((38..45).all(|frame| cached_frames[frame] + 1 >= layers), "after the box moved: {cached_frames:?}");
}

/// Trees on a side of the forest row's forest.
const FOREST_GRID: usize = 12;

/// The forest row's frame `frame`: [`match_scene`]'s still world (its field cached) and a forest
/// of `tree` (a mesh of its own) a far rule thins and fades (game systems LOD-05), the camera
/// dollying in on frames 20-27 and standing still after, so the thinning changes while every row
/// stands still.
fn forest_scene(frame: u64, (mover, tree): (MeshId, MeshId), band: f32) -> Scene {
    let mut scene = match_scene(0, mover);
    let dolly = 0.25 * frame.clamp(20, 28).saturating_sub(20) as f32;
    scene.camera = CameraDesc::look_at([0.0, 6.0, 10.0 - dolly], [0.0, 0.0, -3.0 - dolly]);
    scene.lod_band = band;
    scene.far_rules = vec![GpuFarRule { start: 6.0, end: 22.0, keep: 0.3, fade_out: 8.0 }];
    scene.set_lod(DrawLod { far_rule: 1, ..DrawLod::OWN });
    for i in 0..FOREST_GRID * FOREST_GRID {
        let (x, z) = ((i % FOREST_GRID) as f32 * 1.1 - 6.0, (i / FOREST_GRID) as f32 * 1.1 - 12.0);
        scene.draw(tree, translation(x, 1.6, z), Material::color(GREY));
    }
    scene
}

// Game systems LOD-05: the fade twins cast from the overlay of a cached layer. At head a cached
// layer drew no fade twin (the overlay walked the whole batches only) and cached the thinned
// field whole.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_fading_forests_cached_shadow_frames_match_uncached_ones_byte_for_byte() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let mut quality = shadow_quality(1, None);
    quality.shadows.map_size = 1024;
    let size = (256, 144);
    for band in [0.0, 0.15] {
        let mut renderers = [false, true].map(|cache| renderer(&gpu, size, &quality, cache));
        let meshes: Vec<(MeshId, MeshId)> = renderers
            .iter_mut()
            .map(|renderer| (renderer.add_mesh(&gpu, MeshData::cube()).expect("the mover's mesh"), renderer.add_mesh(&gpu, MeshData::sphere()).expect("the tree's mesh")))
            .collect();
        let mut cached_frames = Vec::new();
        for frame in 0..36u64 {
            let captures: Vec<_> = renderers
                .iter_mut()
                .zip(&meshes)
                .map(|(renderer, meshes)| {
                    renderer.set_frame_index(frame);
                    renderer.render(&gpu, &forest_scene(frame, *meshes, band), CullPath::Gpu).expect("frame");
                    (renderer.capture(&gpu).expect("capture"), renderer.last_stats().shadow_layers_cached)
                })
                .collect();
            let differing = captures[0].0.bgra().iter().zip(captures[1].0.bgra()).filter(|(a, b)| a != b).count();
            assert_eq!(differing, 0, "band {band} frame {frame}: the cached frame differs from the uncached one in {differing} bytes");
            cached_frames.push(captures[1].1);
        }
        eprintln!("band {band}: cached layers by frame: {cached_frames:?}");
        assert!(cached_frames[12..20].iter().all(|layers| *layers > 0), "band {band}: the still field is drawn from the cache: {cached_frames:?}");
        assert!(cached_frames[30..].iter().all(|layers| *layers > 0), "band {band}: and again once the camera stopped: {cached_frames:?}");
    }
}

/// The cost row: a world of [`COST_GRID`]² static spheres on a ground under two shadowed spots and
/// the sun at the high preset's cascades, a box (a mesh of its own) moving every frame.
const COST_GRID: usize = 96;
const COST_SIZE: (u32, u32) = (1920, 1080);
const PERF_FRAMES: usize = 40;
const PERF_WARMUP: usize = 12;
const PERF_ROUNDS: usize = 6;
/// Each round's frame time is its [`ROUND_PERCENTILE`] frame: the least contended frames, so another
/// process's GPU work on a shared machine does not swamp a millisecond-scale difference.
const ROUND_PERCENTILE: f32 = 0.1;
/// B.6's acceptance: the share of the shadow time a large static world saves.
const SHADOW_TIME_SAVED_MIN: f32 = 0.30;

fn cost_scene(frame: u64, shadows: bool, eye_x: f32, mover: MeshId) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([eye_x, 14.0, 26.0], [eye_x, 0.0, 0.0]), [20, 30, 40, 255]);
    scene.lighting.sun_dir = SUN;
    scene.lighting.shadows = shadows;
    scene.lighting.spots = vec![down_spot([-6.0, 8.0, 4.0], shadows), down_spot([6.0, 8.0, 4.0], shadows)];
    scene.draw(MeshId::CUBE, scaled([0.0, -0.55, 0.0], [160.0, 0.1, 160.0]), Material::color(GREY));
    scene.draw(mover, translation(-4.0 + 0.05 * (frame % 160) as f32, 0.0, 6.0), Material::color(GREY));
    for i in 0..COST_GRID * COST_GRID {
        let half = (COST_GRID - 1) as f32 * 0.75;
        let (x, z) = ((i % COST_GRID) as f32 * 1.5 - half, (i / COST_GRID) as f32 * 1.5 - half);
        scene.draw(MeshId::SPHERE, translation(x, 0.1, z), Material::color(GREY));
    }
    scene
}

fn percentile(mut samples: Vec<f32>, q: f32) -> f32 {
    samples.sort_by(f32::total_cmp);
    samples[((samples.len() - 1) as f32 * q).round() as usize]
}

/// One round of GPU-timed frames of every renderer in lock step (frame-level timestamps), so
/// another process's GPU work falls on all of them alike: by renderer, its frame times; None
/// without timestamp queries.
fn gpu_frame_times(gpu: &Gpu, renderers: &mut [Renderer], scene: &dyn Fn(usize, u64) -> Scene) -> Option<Vec<Vec<f32>>> {
    let mut times = vec![Vec::new(); renderers.len()];
    for frame in 0..(PERF_WARMUP + PERF_FRAMES) as u64 {
        for (k, renderer) in renderers.iter_mut().enumerate() {
            let landed = renderer.arm_frame_timer(&gpu.queue)?;
            if frame >= PERF_WARMUP as u64 {
                times[k].extend(landed);
            }
            renderer.set_frame_index(frame);
            renderer.render(gpu, &scene(k, frame), CullPath::Gpu).expect("frame");
            renderer.finish_frame_timer();
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        }
    }
    Some(times)
}

/// Frame times (shadows off, uncached, cached): the median over rounds of each round's
/// [`ROUND_PERCENTILE`] frame of `scene`.
fn cost(gpu: &Gpu, scene: &dyn Fn(u64, bool, MeshId) -> Scene) -> Option<[f32; 3]> {
    let quality = shadow_quality(2, Some(ShadowFilter::Pcf3x3));
    let mut renderers = [false, false, true].map(|cache| renderer(gpu, COST_SIZE, &quality, cache));
    let movers: Vec<MeshId> = renderers.iter_mut().map(|renderer| renderer.add_mesh(gpu, MeshData::cube()).expect("the mover's mesh")).collect();
    let mut medians = [Vec::new(), Vec::new(), Vec::new()];
    for round in 0..=PERF_ROUNDS {
        let times = gpu_frame_times(gpu, &mut renderers, &|k, frame| scene(frame, k > 0, movers[k]))?;
        eprintln!("round {round}: the cached renderer's last frame drew {} layers from the cache", renderers[2].last_stats().shadow_layers_cached);
        if round > 0 {
            for (k, times) in times.into_iter().enumerate() {
                medians[k].push(percentile(times, ROUND_PERCENTILE));
            }
        }
    }
    Some(medians.map(|m| percentile(m, 0.5)))
}

#[test]
#[ignore = "needs a GPU with timestamp queries: run with --ignored metal"]
fn metal_a_large_static_world_saves_a_third_of_its_shadow_time() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let Some(still) = cost(&gpu, &|frame, shadows, mover| cost_scene(frame, shadows, 0.0, mover)) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    // The camera walking along the grid: the cascades follow it, the spots' maps stand still.
    let walk = cost(&gpu, &|frame, shadows, mover| cost_scene(frame, shadows, 0.05 * frame as f32, mover)).expect("timestamps");
    let saved = |[off, uncached, cached]: [f32; 3]| (uncached - cached) / (uncached - off).max(f32::MIN_POSITIVE);
    let json = format!(
        "{{\"row\":\"b6-static-shadow-cache-1080p\",\"measures\":\"frame-level GPU timestamps; {} static spheres on a ground, a moving box, the sun at the high preset's cascades (PCF 3x3) and two shadowed spots, 1920x1080; shadow time = shadowed less unshadowed frame; the three renderers in lock step, medians over {PERF_ROUNDS} rounds of each round's p{} of {PERF_FRAMES} frames\",\"backend\":\"{}\",\"adapter\":\"{}\",\"build\":\"{}\",\"still\":{{\"off_ms\":{:.4},\"uncached_ms\":{:.4},\"cached_ms\":{:.4},\"saved\":{:.3}}},\"walk\":{{\"off_ms\":{:.4},\"uncached_ms\":{:.4},\"cached_ms\":{:.4},\"saved\":{:.3}}},\"saved_min\":{SHADOW_TIME_SAVED_MIN}}}\n",
        COST_GRID * COST_GRID,
        (ROUND_PERCENTILE * 100.0) as u32,
        gpu.receipt().backend,
        gpu.receipt().adapter,
        if cfg!(debug_assertions) { "debug" } else { "release" },
        still[0],
        still[1],
        still[2],
        saved(still),
        walk[0],
        walk[1],
        walk[2],
        saved(walk),
    );
    eprintln!("{json}");
    if let Ok(dir) = std::env::var("GENEX_RENDER_PERF_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(PathBuf::from(dir).join("B6-static-shadow-cache.json"), &json).expect("perf row");
    }
    if cfg!(debug_assertions) {
        eprintln!("gate skipped: a debug build; run the row with --release");
        return;
    }
    assert!(saved(still) >= SHADOW_TIME_SAVED_MIN, "a still camera over the static world saves {:.3} of its shadow time: {still:?}", saved(still));
}

