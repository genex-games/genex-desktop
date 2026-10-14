//! RQ6.5: shadowed spot lights. Up to `LightQuality::shadowed_spots` spots (0 on low and medium,
//! 2 on high, 4 on ultra) asking for a shadow get a perspective depth map each, drawn as a tile
//! of the one extra layer of the shared shadow array after the sun's cascades, every spot culled
//! through its own reserved cull view; the binned forward pass reads it with a 3x3 PCF through
//! the light's shadow slot.
//!
//! The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test spot_shadow -- --ignored metal
//!
//! Golden `spot-shadow/occluder` (raw BGRA top row first, 128x72, AgX at EV 0).
//! `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites it; `GENEX_RENDER_EVIDENCE_DIR` receives every compared
//! frame; `GENEX_RENDER_PERF_DIR` receives the cost row.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::layout::{MAX_LOCAL_LIGHTS, NO_SHADOW_SLOT};
use genex_render::lights::{Lighting, SpotLight, binned_frame};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene, scaled};
use genex_render::settings::{Look, Quality, SceneFormat, ShadowFormat, Tonemapper};
use genex_render::spot_shadow::{LANDED, apply_views, grant, spot_view, tile_side};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::Vec3;

/// Renderer rows: frame size and golden tolerances (another Apple GPU family rounds differently).
const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The spots' cone: outer and inner half-angles in degrees.
const SPOT_OUTER_DEGREES: f32 = 40.0;
const SPOT_INNER_DEGREES: f32 = 30.0;
/// How dark the floor behind an occluder must be, as a share of the unshadowed floor.
const SHADOWED_SHARE: f32 = 0.15;
/// How dark the floor behind the occluder must be under the widest cone (its coarse map).
const WIDEST_CONE_SHARE: f32 = 0.75;
/// How close the open floor of a shadowed spot stays to the unshadowed one (no acne, no
/// peter-panning across the lit disc): relative radiance.
const OPEN_FLOOR_TOLERANCE: f32 = 0.02;

/// GPU rows share one adapter: one at a time, so a timing row never shares the GPU with another.
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

fn goldens_dir(set: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens").join(set)
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Pixels of `a` and `b` (BGRA) differing by more than the golden tolerance, and the worst channel.
fn differing(a: &[u8], b: &[u8]) -> (usize, u8) {
    let (mut outliers, mut worst) = (0, 0u8);
    for (p, q) in a.chunks(4).zip(b.chunks(4)) {
        let diff = p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    (outliers, worst)
}

/// Compare `capture` with golden `set/name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(set: &str, name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(&format!("{set}-{name}"), capture);
    let path = goldens_dir(set).join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir(set)).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let (outliers, worst) = differing(&golden, capture.bgra());
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{set}/{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

/// A single-sampled HDR renderer at EV 0 (AgX), local lights binned in 16 px tiles, with
/// `shadowed_spots` shadow slots.
fn spot_renderer(gpu: &Gpu, size: (u32, u32), shadowed_spots: u8) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_quality(&spot_quality(shadowed_spots));
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::Agx;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer
}

/// The lights/spot golden's quality (`Quality::off` on the HDR path, every local light binned in
/// 16 px tiles) with `shadowed_spots` shadow slots.
fn spot_quality(shadowed_spots: u8) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.lights.clustered = true;
    quality.lights.cap = MAX_LOCAL_LIGHTS as u32;
    quality.lights.tile_px = 16;
    quality.lights.shadowed_spots = shadowed_spots;
    quality
}

/// A spot at `position` pointing straight down, asking for a shadow map when `shadow`.
fn down_spot(position: [f32; 3], shadow: bool) -> SpotLight {
    SpotLight {
        position,
        direction: [0.0, -1.0, 0.0],
        range: 10.0,
        color: [255, 255, 255],
        intensity: 20.0,
        inner_angle: SPOT_INNER_DEGREES.to_radians(),
        outer_angle: SPOT_OUTER_DEGREES.to_radians(),
        shadow,
    }
}

/// The camera of the occluder rows.
fn occluder_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 6.0, 6.0], [0.0, 0.0, 0.0])
}

/// A grey ground in the dark (no sun, no ambient) under `spots`, with a cube of side `size`
/// centred at each of `occluders`.
fn ground_scene(camera: CameraDesc, spots: Vec<SpotLight>, occluders: &[([f32; 3], f32)]) -> Scene {
    let mut scene = Scene::new(camera, [0, 0, 0, 255]);
    scene.lighting = Lighting { sun_intensity: 0.0, ambient_intensity: 0.0, shadows: false, spots, ..Lighting::default() };
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [24.0, 0.1, 24.0]), Material::color([180, 180, 180, 255]));
    for (at, size) in occluders {
        scene.draw(MeshId::CUBE, scaled(*at, [*size; 3]), Material::color([180, 180, 180, 255]));
    }
    scene
}

/// The floor point a light at `light` throws the shadow of `point` onto (y = 0).
fn floor_shadow(light: [f32; 3], point: [f32; 3]) -> [f32; 3] {
    let (l, p) = (Vec3::from(light), Vec3::from(point));
    let t = l.y / (l.y - p.y);
    (l + (p - l) * t).to_array()
}

/// The pixel (column, row from the top) `world` lands on for `camera` on a `size` frame.
fn pixel_of(camera: &CameraDesc, size: (u32, u32), world: [f32; 3]) -> (u32, u32) {
    let clip = camera.view_proj(size.0 as f32 / size.1 as f32) * Vec3::from(world).extend(1.0);
    let ndc = clip.truncate() / clip.w;
    let x = ((ndc.x * 0.5 + 0.5) * size.0 as f32) as u32;
    let y = ((0.5 - ndc.y * 0.5) * size.1 as f32) as u32;
    (x.min(size.0 - 1), y.min(size.1 - 1))
}

/// The mean red radiance of the 3x3 pixels around `world`'s pixel.
fn radiance_at(radiance: &[[f32; 4]], camera: &CameraDesc, size: (u32, u32), world: [f32; 3]) -> f32 {
    let (x, y) = pixel_of(camera, size, world);
    let mut sum = 0.0;
    for dy in -1i32..=1 {
        for dx in -1i32..=1 {
            let px = (x as i32 + dx).clamp(0, size.0 as i32 - 1) as u32;
            let py = (y as i32 + dy).clamp(0, size.1 as i32 - 1) as u32;
            sum += radiance[(py * size.0 + px) as usize][0];
        }
    }
    sum / 9.0
}

fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, path: CullPath) -> (Capture, Vec<[f32; 4]>) {
    renderer.render(gpu, scene, path).expect("frame");
    let radiance = renderer.read_scene(gpu).expect("the HDR scene reads back");
    (renderer.capture(gpu).expect("capture"), radiance)
}

/// The red-first scene: one shadowed spot 4 m over the ground, a 0.8 m cube 2 m under it and 1 m
/// aside, so its shadow falls 2 m from the disc's centre.
const LIGHT: [f32; 3] = [0.0, 4.0, 0.0];
const OCCLUDER: ([f32; 3], f32) = ([1.0, 2.0, 0.0], 0.8);
/// A floor point inside the lit disc that no occluder shadows.
const OPEN_FLOOR: [f32; 3] = [-1.6, 0.0, 0.4];

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_an_occluder_in_a_shadowed_spots_cone_darkens_the_floor_behind_it() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let size = (WIDTH, HEIGHT);
    let camera = occluder_camera();
    let scene = ground_scene(camera, vec![down_spot(LIGHT, true)], &[OCCLUDER]);
    let (_, unshadowed) = draw(&gpu, &mut spot_renderer(&gpu, size, 0), &scene, CullPath::Gpu);
    let (capture, shadowed) = draw(&gpu, &mut spot_renderer(&gpu, size, 2), &scene, CullPath::Gpu);
    let behind = floor_shadow(LIGHT, OCCLUDER.0);
    let (open, dark) = (radiance_at(&unshadowed, &camera, size, behind), radiance_at(&shadowed, &camera, size, behind));
    assert!(open > 0.05, "the floor behind the cube is inside the lit disc ({open})");
    if !LANDED {
        // Until the renderer draws spot maps, a shadow slot changes nothing.
        assert_eq!(shadowed, unshadowed, "no spot shadow before RQ6.5's renderer seam lands");
        return;
    }
    assert!(dark < open * SHADOWED_SHARE, "the cube shadows the floor behind it: {dark} of {open}");
    let (lit, kept) = (radiance_at(&unshadowed, &camera, size, OPEN_FLOOR), radiance_at(&shadowed, &camera, size, OPEN_FLOOR));
    assert!(lit > 0.05, "the open floor is lit ({lit})");
    assert!((kept - lit).abs() <= lit * OPEN_FLOOR_TOLERANCE, "the open floor keeps its light: {kept} against {lit}");
    check_golden("spot-shadow", "occluder", &capture);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_with_no_shadow_slot_a_shadow_asking_spot_draws_the_lights_spot_golden_byte_for_byte() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    // The lights/spot golden's scene (RQ6.2), its spot now asking for a shadow map.
    let camera = CameraDesc::look_at([0.0, 5.0, 5.0], [0.0, 0.0, 0.0]);
    let mut spot = down_spot([0.0, 2.0, 0.0], true);
    (spot.intensity, spot.inner_angle, spot.outer_angle) = (4.0, 20f32.to_radians(), 30f32.to_radians());
    let scene = ground_scene(camera, vec![spot], &[]);
    let golden = std::fs::read(goldens_dir("lights").join("spot.bgra")).expect("the lights/spot golden");
    let (no_slots, _) = draw(&gpu, &mut spot_renderer(&gpu, (WIDTH, HEIGHT), 0), &scene, CullPath::Gpu);
    assert!(no_slots.bgra() == golden.as_slice(), "no shadow slot: the lights/spot golden, byte for byte");
    // Slots, but the sun's shadows (and with them every shadow map) switched off.
    let mut renderer = spot_renderer(&gpu, (WIDTH, HEIGHT), 2);
    let mut off = spot_quality(2);
    off.shadows.enabled = false;
    renderer.set_quality(&off);
    let (shadows_off, _) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
    assert!(shadows_off.bgra() == golden.as_slice(), "shadows switched off: the lights/spot golden, byte for byte");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: slots, views and culls of a planned frame

/// A plan of `scene` on the binned path with `shadowed_spots` slots, its spots granted with
/// `tile_px` maps as the renderer grants them.
fn granted_plan(scene: &Scene, shadowed_spots: u8, tile_px: Option<u32>) -> FramePlan {
    let mut plan = FramePlan::build(scene, &MeshLibrary::new(), WIDTH as f32 / HEIGHT as f32).expect("plan");
    let mut binned = binned_frame(&scene.lighting, &spot_quality(shadowed_spots).lights, &scene.camera, (WIDTH, HEIGHT));
    let spots = grant(&mut binned, tile_px, usize::from(shadowed_spots), scene.camera.eye);
    let cascades = plan.cascades_drawn();
    plan.views = apply_views(&mut plan.frame, &mut plan.cull_views, cascades, &spots);
    plan.binned = Some(binned);
    plan
}

#[test]
fn each_shadowed_spot_culls_its_casters_through_its_own_view_after_the_cascades() {
    let camera = occluder_camera();
    let far = [12.0, 2.0, 0.0];
    let mut scene = ground_scene(camera, vec![down_spot(LIGHT, true), down_spot([-3.0, 4.0, 0.0], false)], &[OCCLUDER, (far, 0.5)]);
    scene.lighting.sun_intensity = 2.0;
    scene.lighting.shadows = true;
    let plan = granted_plan(&scene, 2, Some(tile_side(1024)));
    let cascades = plan.cascades_drawn() as u32;
    assert_eq!(cascades, 2, "the legacy sun's two cascades");
    assert_eq!(plan.views, 1 + cascades + 1, "the camera, the cascades, the one shadowed spot");
    assert_eq!(plan.frame.counts[2], plan.views);
    assert_eq!(plan.frame.shadow_counts[1], 1);
    let culled = plan.cpu_cull_view(spot_view(cascades, 0) as usize);
    // Each batch's survivors fill the start of its region of the view's visible list.
    let centres: Vec<[f32; 3]> = plan
        .batches
        .iter()
        .zip(&culled.counts)
        .flat_map(|(batch, count)| culled.visible[batch.first_instance as usize..(batch.first_instance + count) as usize].iter())
        .map(|row| {
            let b = plan.instances[*row as usize].bounds;
            [b[0], b[1], b[2]]
        })
        .collect();
    assert!(centres.iter().any(|c| (Vec3::from(*c) - Vec3::from(OCCLUDER.0)).length() < 1e-4), "the cube under the spot casts: {centres:?}");
    assert!(!centres.iter().any(|c| (Vec3::from(*c) - Vec3::from(far)).length() < 1e-4), "the cube outside its cone is culled: {centres:?}");
}

/// The contact row's spot (RQ6 review): 3 m over the floor, wide enough that the floor around the
/// cube is fully lit, and the cube of side 1 resting on the floor 1 m aside, so its shadow runs
/// from its face at x = -0.5 to x = 0.25 along z = 0.
const CONTACT_LIGHT: [f32; 3] = [-2.0, 3.0, 0.0];
const CONTACT_CUBE: ([f32; 3], f32) = ([-1.0, 0.5, 0.0], 1.0);

/// A camera looking straight down at the contact row's cube, `height` metres of floor tall.
fn top_down(height: f32) -> CameraDesc {
    CameraDesc { up: [0.0, 0.0, -1.0], ..CameraDesc::look_at([-0.5, 10.0, 0.0], [-0.5, 0.0, 0.0]) }.orthographic(height)
}

// RQ6 review: no capture showed a shadowed spot's contact shadow, where peter-panning (the
// receiver's normal offset with the casters' bias) would open a lit gap between a resting object
// and its shadow. At high's and ultra's map sides the shadow must start at the cube's face.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_cube_resting_under_a_shadowed_spot_casts_a_shadow_that_touches_it() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let mut spot = down_spot(CONTACT_LIGHT, true);
    (spot.inner_angle, spot.outer_angle) = (50f32.to_radians(), 60f32.to_radians());
    for (preset, map_size) in [("high", 2048), ("ultra", 4096)] {
        let size = (512, 288);
        let camera = top_down(3.0);
        let scene = ground_scene(camera, vec![spot], &[CONTACT_CUBE]);
        let mut shadowed = spot_renderer(&gpu, size, 1);
        let mut quality = spot_quality(1);
        quality.shadows.map_size = map_size;
        shadowed.set_quality(&quality);
        let (_, open) = draw(&gpu, &mut spot_renderer(&gpu, size, 0), &scene, CullPath::Gpu);
        let (capture, dark) = draw(&gpu, &mut shadowed, &scene, CullPath::Gpu);
        write_evidence(&format!("spot-shadow-contact-{preset}-512x288"), &capture);
        // One map texel at the floor beside the cube (the tile's texel across the cone at 3 m),
        // and one screen pixel: the most a lit gap may be.
        let tile = genex_render::spot_shadow::tile_side(map_size) as f32;
        let texel = 2.0 * 3.0 * libm::tanf(60f32.to_radians()) / tile;
        let pixel = 3.0 / size.1 as f32;
        let first = -0.5 + texel + 2.0 * pixel;
        let lit = radiance_at(&open, &camera, size, [1.0, 0.0, 0.0]);
        assert!(lit > 0.05, "{preset}: the floor past the shadow is lit ({lit})");
        let mut x = first;
        while x < 0.15 {
            let (unshadowed, kept) = (radiance_at(&open, &camera, size, [x, 0.0, 0.0]), radiance_at(&dark, &camera, size, [x, 0.0, 0.0]));
            assert!(kept < unshadowed * SHADOWED_SHARE, "{preset}: a lit gap at x = {x:.3} ({kept} of {unshadowed}), {:.3} m from the cube", x + 0.5);
            x += pixel;
        }
        let past = radiance_at(&dark, &camera, size, [0.6, 0.0, 0.0]);
        assert!(past > radiance_at(&open, &camera, size, [0.6, 0.0, 0.0]) * 0.9, "{preset}: the floor past the shadow keeps its light");
    }
    // The golden: high's map side at the goldens' size.
    let camera = top_down(3.0);
    let scene = ground_scene(camera, vec![spot], &[CONTACT_CUBE]);
    let mut renderer = spot_renderer(&gpu, (WIDTH, HEIGHT), 1);
    let mut quality = spot_quality(1);
    quality.shadows.map_size = 2048;
    renderer.set_quality(&quality);
    let (capture, _) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
    check_golden("spot-shadow", "contact", &capture);
}

// RQ6 review: slots went to the first shadow-asking spots in scene order wherever they were, so a
// spot behind the camera drew its caster pass every frame while a nearer one on screen went
// unshadowed.
#[test]
fn a_shadow_asking_spot_behind_the_camera_draws_no_spot_view_and_the_one_on_screen_gets_the_slot() {
    let camera = occluder_camera();
    // Scene order: behind the camera first (the camera at z = 6 looks towards -z), then on screen.
    let behind = down_spot([0.0, 4.0, 30.0], true);
    let on_screen = down_spot(LIGHT, true);
    let scene = ground_scene(camera, vec![behind, on_screen], &[OCCLUDER]);
    let plan = granted_plan(&scene, 1, Some(tile_side(1024)));
    let cascades = plan.cascades_drawn() as u32;
    assert_eq!(plan.views, 1 + cascades + 1, "one spot view, for the spot on screen");
    let binned = plan.binned.as_ref().expect("binned");
    let slotted: Vec<[f32; 4]> = binned.lights.iter().zip(&binned.ext).filter(|(_, ext)| ext.params[2] >= 0.0).map(|(light, _)| light.position_range).collect();
    assert_eq!(slotted.len(), 1);
    assert_eq!(slotted[0][..3], LIGHT, "the slot goes to the spot on screen, not the first one listed");
    let alone = ground_scene(camera, vec![behind], &[OCCLUDER]);
    assert_eq!(granted_plan(&alone, 2, Some(tile_side(1024))).views, 1 + cascades, "a spot behind the camera alone draws no spot pass");
}

// RQ6 review: the shadow array was reallocated (every cascade with it) whenever a frame's granted
// spots went between none and some: a flashlight switched on and off, or a spot crossing the cap.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_shadowed_spot_switching_on_and_off_keeps_the_shadow_array() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = occluder_camera();
    let mut renderer = spot_renderer(&gpu, (WIDTH, HEIGHT), 2);
    let mut lit = ground_scene(camera, vec![down_spot(LIGHT, true)], &[OCCLUDER]);
    (lit.lighting.sun_intensity, lit.lighting.shadows) = (2.0, true);
    let mut dark = ground_scene(camera, Vec::new(), &[OCCLUDER]);
    (dark.lighting.sun_intensity, dark.lighting.shadows) = (2.0, true);
    draw(&gpu, &mut renderer, &lit, CullPath::Gpu);
    let maps = renderer.shadow_maps();
    assert!(maps.layers >= 2, "the cascades and the spot atlas: {maps:?}");
    assert!(renderer.uses_shadowed_spots());
    for frame in 0..6 {
        let scene = if frame % 2 == 0 { &dark } else { &lit };
        draw(&gpu, &mut renderer, scene, CullPath::Gpu);
        assert_eq!(renderer.shadow_maps(), maps, "frame {frame}: the shadow array keeps its shape (and its cascades' history)");
    }
    let mut off = spot_quality(2);
    off.lights.shadowed_spots = 0;
    renderer.set_quality(&off);
    draw(&gpu, &mut renderer, &lit, CullPath::Gpu);
    assert_eq!(renderer.shadow_maps().layers, maps.layers - 1, "a quality with no spot slots drops the atlas layer");
}

#[test]
fn only_granted_slots_survive_and_a_frame_without_maps_clears_every_slot() {
    let spots = (0..5).map(|i| down_spot([i as f32 * 2.0 - 4.0, 4.0, 0.0], true)).collect();
    let scene = ground_scene(occluder_camera(), spots, &[]);
    let slots = |plan: &FramePlan| -> Vec<f32> {
        let mut slots: Vec<f32> = plan.binned.as_ref().expect("binned").ext.iter().map(|ext| ext.params[2]).filter(|slot| *slot >= 0.0).collect();
        slots.sort_by(f32::total_cmp);
        slots
    };
    assert_eq!(slots(&granted_plan(&scene, 2, Some(512))), [0.0, 1.0], "high: two maps");
    assert_eq!(slots(&granted_plan(&scene, 4, Some(512))), [0.0, 1.0, 2.0, 3.0], "ultra: four maps");
    let off = granted_plan(&scene, 4, None);
    assert!(off.binned.as_ref().expect("binned").ext.iter().all(|ext| ext.params[2] == NO_SHADOW_SLOT), "no map, no slot");
    assert_eq!(off.views, 1, "no spot view without maps");
}

// ---------------------------------------------------------------------------------------------
// More renderer rows

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_each_spot_reads_its_own_atlas_tile_and_a_spot_past_the_slots_stays_unshadowed() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let size = (384, 216);
    let camera = CameraDesc::look_at([0.0, 11.0, 11.0], [0.0, 0.0, 0.0]);
    // Three shadow-asking spots whose discs do not reach each other's shadows, each with a cube
    // 1 m aside under it; high grants two slots.
    let lights = [[-6.0, 4.0, 0.0], [0.0, 4.0, 0.0], [6.0, 4.0, -1.0]];
    let occluders: Vec<([f32; 3], f32)> = lights.iter().map(|l| ([l[0] + 1.0, 2.0, l[2]], 0.8)).collect();
    let scene = ground_scene(camera, lights.iter().map(|l| down_spot(*l, true)).collect(), &occluders);
    let (_, unshadowed) = draw(&gpu, &mut spot_renderer(&gpu, size, 0), &scene, CullPath::Gpu);
    let mut renderer = spot_renderer(&gpu, size, 2);
    let (capture, shadowed) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::write(PathBuf::from(dir).join("spot-shadow-three-spots-384x216.bgra"), capture.bgra()).expect("evidence");
    }
    let share = |k: usize| {
        let behind = floor_shadow(lights[k], occluders[k].0);
        radiance_at(&shadowed, &camera, size, behind) / radiance_at(&unshadowed, &camera, size, behind)
    };
    if !LANDED {
        assert_eq!(shadowed, unshadowed);
        return;
    }
    assert!(share(0) < SHADOWED_SHARE && share(1) < SHADOWED_SHARE, "slots 0 and 1 shadow their own floors: {} {}", share(0), share(1));
    assert!((share(2) - 1.0).abs() < OPEN_FLOOR_TOLERANCE, "the third spot holds no slot on high: unshadowed ({})", share(2));
    assert_eq!(renderer.shadow_maps().layers, 1, "an unlit sun: the atlas layer alone");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_spot_shadows_sit_beside_the_sun_cascades_through_both_cull_paths_and_repeat_bit_for_bit() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let size = (WIDTH, HEIGHT);
    let camera = occluder_camera();
    let mut scene = ground_scene(camera, vec![down_spot(LIGHT, true)], &[OCCLUDER]);
    // A low sun from behind the camera: its cascades shadow too, the spot's layer comes after them.
    (scene.lighting.sun_intensity, scene.lighting.sun_dir, scene.lighting.shadows) = (0.4, [0.0, 0.3, 1.0], true);
    let mut sun_only = spot_renderer(&gpu, size, 0);
    let (_, unshadowed) = draw(&gpu, &mut sun_only, &scene, CullPath::Gpu);
    let passes_without = sun_only.last_stats().render_passes;
    let mut renderer = spot_renderer(&gpu, size, 2);
    let (gpu_culled, shadowed) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
    if !LANDED {
        assert_eq!(shadowed, unshadowed);
        return;
    }
    let behind = floor_shadow(LIGHT, OCCLUDER.0);
    let (open, dark) = (radiance_at(&unshadowed, &camera, size, behind), radiance_at(&shadowed, &camera, size, behind));
    assert!(dark < open * 0.5, "the spot's shadow darkens the sun-lit floor too: {dark} of {open}");
    assert_eq!(renderer.shadow_maps().layers, 3, "two cascades and the atlas layer");
    assert_eq!(renderer.last_stats().render_passes, passes_without + 1, "every spot map in one pass");
    assert_eq!(renderer.last_stats().views, 4, "the camera, two cascades and the spot");
    let (again, _) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
    assert!(again.bgra() == gpu_culled.bgra(), "a second frame is the same bits");
    let (cpu_culled, _) = draw(&gpu, &mut spot_renderer(&gpu, size, 2), &scene, CullPath::Cpu);
    let (outliers, worst) = differing(cpu_culled.bgra(), gpu_culled.bgra());
    assert_eq!(outliers, 0, "the CPU-culled reference draws the same spot shadow (worst {worst})");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_depth16_array_and_the_widest_cone_still_shadow_without_acne() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let size = (WIDTH, HEIGHT);
    let camera = occluder_camera();
    let mut wide = down_spot(LIGHT, true);
    (wide.inner_angle, wide.outer_angle) = (80f32.to_radians(), genex_render::lights::SPOT_OUTER_ANGLE_MAX);
    // The widest cone spreads a tile's texels over 178 degrees (a 512 px tile here: about 0.9 m a
    // texel on the floor under it), so its shadow is coarse; it must still darken the floor.
    let cases = [("depth16", down_spot(LIGHT, true), ShadowFormat::Depth16, SHADOWED_SHARE), ("widest cone", wide, ShadowFormat::Depth32, WIDEST_CONE_SHARE)];
    for (label, spot, format, share) in cases {
        let scene = ground_scene(camera, vec![spot], &[OCCLUDER]);
        let mut quality = spot_quality(2);
        quality.shadows.format = format;
        let (_, unshadowed) = draw(&gpu, &mut spot_renderer(&gpu, size, 0), &scene, CullPath::Gpu);
        let mut renderer = spot_renderer(&gpu, size, 2);
        renderer.set_quality(&quality);
        let (_, shadowed) = draw(&gpu, &mut renderer, &scene, CullPath::Gpu);
        if !LANDED {
            assert_eq!(shadowed, unshadowed);
            continue;
        }
        let behind = floor_shadow(LIGHT, OCCLUDER.0);
        let (open, dark) = (radiance_at(&unshadowed, &camera, size, behind), radiance_at(&shadowed, &camera, size, behind));
        assert!(dark < open * share, "{label}: the cube shadows the floor behind it: {dark} of {open}");
        let (lit, kept) = (radiance_at(&unshadowed, &camera, size, OPEN_FLOOR), radiance_at(&shadowed, &camera, size, OPEN_FLOOR));
        assert!((kept - lit).abs() <= lit * OPEN_FLOOR_TOLERANCE, "{label}: the open floor keeps its light: {kept} against {lit}");
    }
}

/// The cost row's frames per round, warm-up frames and interleaved rounds.
const PERF_FRAMES: usize = 40;
const PERF_WARMUP: usize = 8;
const PERF_ROUNDS: usize = 4;
/// RQ6.5's acceptance: two shadowed spots add at most this much GPU time at 1080p.
const TWO_SPOTS_BUDGET_MS: f32 = 0.8;

/// A 12 x 12 grid of cubes on the ground under two shadowed spots.
fn cost_scene() -> Scene {
    let occluders: Vec<([f32; 3], f32)> =
        (0..144).map(|i| ([(i % 12) as f32 * 1.5 - 8.25, 0.4, (i / 12) as f32 * 1.5 - 8.25], 0.6)).collect();
    let spots = vec![down_spot([-3.0, 5.0, -1.0], true), down_spot([3.0, 5.0, 1.0], true)];
    ground_scene(CameraDesc::look_at([0.0, 9.0, 13.0], [0.0, 0.0, 0.0]), spots, &occluders)
}

fn percentiles(mut samples: Vec<f32>) -> (f32, f32) {
    samples.sort_by(f32::total_cmp);
    let at = |q: f32| samples[((samples.len() - 1) as f32 * q).round() as usize];
    (at(0.5), at(0.95))
}

/// One round of GPU-timed frames (frame-level timestamps); None without timestamp queries.
fn gpu_frame_times(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> Option<Vec<f32>> {
    let mut times = Vec::new();
    for frame in 0..(PERF_WARMUP + PERF_FRAMES) as u64 {
        let landed = renderer.arm_frame_timer(&gpu.queue)?;
        if frame >= PERF_WARMUP as u64 {
            times.extend(landed);
        }
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
        renderer.finish_frame_timer();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    }
    Some(times)
}

#[test]
#[ignore = "needs a GPU with timestamp queries: run with --ignored metal"]
fn metal_two_shadowed_spots_fit_their_budget_at_1080p() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let scene = cost_scene();
    // Both draw the two spots on the binned path at high's 2048 px array (two 1024 px tiles); one
    // maps and filters their shadows.
    let mut renderers = [0, 2].map(|spots| {
        let mut renderer = spot_renderer(&gpu, (1920, 1080), spots);
        let mut quality = spot_quality(spots);
        quality.shadows.map_size = 2048;
        renderer.set_quality(&quality);
        renderer
    });
    let mut rounds: Vec<[(f32, f32); 2]> = Vec::new();
    let mut landed = [Vec::new(), Vec::new()];
    for round in 0..=PERF_ROUNDS {
        let mut stats = [(0.0, 0.0); 2];
        for (k, renderer) in renderers.iter_mut().enumerate() {
            let Some(times) = gpu_frame_times(&gpu, renderer, &scene) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            stats[k] = percentiles(times.clone());
            if round > 0 {
                landed[k].extend(times);
            }
        }
        if round > 0 {
            rounds.push(stats);
        }
    }
    let paired = |pick: fn((f32, f32)) -> f32| percentiles(rounds.iter().map(|r| pick(r[1]) - pick(r[0])).collect()).0;
    let added = (paired(|s| s.0), paired(|s| s.1));
    let (off, on) = (percentiles(landed[0].clone()), percentiles(landed[1].clone()));
    let json = format!(
        "{{\"row\":\"rq6.5-two-spot-shadows-1080p\",\"measures\":\"frame-level GPU timestamps, 144 cubes on a ground under two spots on the binned HDR path, 2048 px shadow array (1024 px tiles), 1920x1080; paired medians over {PERF_ROUNDS} interleaved rounds of {PERF_FRAMES} frames\",\"backend\":\"{}\",\"adapter\":\"{}\",\"build\":\"{}\",\"landed\":{LANDED},\"unshadowed\":{{\"p50_ms\":{:.4},\"p95_ms\":{:.4}}},\"two_shadowed\":{{\"p50_ms\":{:.4},\"p95_ms\":{:.4}}},\"added\":{{\"p50_ms\":{:.4},\"p95_ms\":{:.4}}},\"budget_ms\":{TWO_SPOTS_BUDGET_MS}}}\n",
        gpu.receipt().backend,
        gpu.receipt().adapter,
        if cfg!(debug_assertions) { "debug" } else { "release" },
        off.0,
        off.1,
        on.0,
        on.1,
        added.0,
        added.1
    );
    eprintln!("{json}");
    if let Ok(dir) = std::env::var("GENEX_RENDER_PERF_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(PathBuf::from(dir).join("RQ6.5-spot-shadow-cost.json"), &json).expect("perf row");
    }
    assert!(added.0 <= TWO_SPOTS_BUDGET_MS, "two shadowed spots add {added:?} ms (p50, p95) at 1080p");
    if cfg!(debug_assertions) {
        eprintln!("p95 gate skipped: a debug build; run the row with --release");
        return;
    }
    assert!(added.1 <= TWO_SPOTS_BUDGET_MS, "two shadowed spots add {added:?} ms (p50, p95) at 1080p");
}
