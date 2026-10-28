//! Local exposure (AAA push P3, `genex_render::post::local_exposure`): a sunlit window and the dark
//! room around it in one frame. Real-GPU rows (`#[ignore]`d, every name contains `metal`) hold the
//! operator on a synthetic image (the window keeps its detail and comes down, the room comes up, no
//! halo beside the frame, off is byte for byte the picture before) and the renderer's default look
//! at desktop `high` on a room with a window onto a sunlit yard:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test local_exposure -- --ignored metal

use genex_render::Gpu;
use genex_render::capture::Capture;
use genex_render::post::local_exposure::LocalExposure;
use genex_render::post::tonemap::{local_exposure_image, tonemap_image};
use genex_render::settings::Tonemapper;

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

/// The synthetic frame: a room wall (left) beside a window onto a sunlit yard (right), each with
/// 4-texel stripes of ±30% (the detail a tonemap must keep).
const SIZE: (u32, u32) = (512, 128);
/// Where the window starts.
const WINDOW_X: u32 = 256;
/// The room's and the window's pre-exposed radiance: 3 EV under and 6 EV over middle grey, the
/// spread of a corridor and the snowy yard its window looks onto.
const ROOM: f32 = 0.0225;
const WINDOW: f32 = 11.5;
/// The stripes' amplitude.
const STRIPES: f32 = 0.3;

fn window_and_room() -> Vec<[f32; 4]> {
    let (width, height) = SIZE;
    (0..height)
        .flat_map(|_| 0..width)
        .map(|x| {
            let base = if x < WINDOW_X { ROOM } else { WINDOW };
            let stripe = if (x / 4) % 2 == 0 { 1.0 + STRIPES } else { 1.0 - STRIPES };
            let value = base * stripe;
            [value, value, value, 1.0]
        })
        .collect()
}

/// The display grey (0..255, the green channel) of column `x`, averaged down the image.
fn column(capture: &Capture, x: u32) -> f32 {
    let (width, height) = (capture.width(), capture.height());
    let sum: u32 = (0..height).map(|y| u32::from(capture.bgra()[((y * width + x) * 4 + 1) as usize])).sum();
    sum as f32 / height as f32
}

fn mean(capture: &Capture, columns: std::ops::Range<u32>) -> f32 {
    let count = columns.len() as f32;
    columns.map(|x| column(capture, x)).sum::<f32>() / count
}

/// The stripes' contrast in display levels over `columns`: the mean step between neighbouring
/// stripes.
fn detail(capture: &Capture, columns: std::ops::Range<u32>) -> f32 {
    let steps: Vec<f32> = columns.clone().step_by(4).zip(columns.skip(4).step_by(4)).map(|(a, b)| (column(capture, a) - column(capture, b)).abs()).collect();
    steps.iter().sum::<f32>() / steps.len() as f32
}

/// Under local exposure the window's stripes keep at least this many times their contrast.
const DETAIL_GAIN_MIN: f32 = 1.5;
/// The most display levels the room right beside the window frame (4..24 texels from it) may
/// differ from the room far from it: no dark halo around the window.
const HALO_LEVELS_MAX: f32 = 6.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_window_keeps_its_detail_and_the_room_comes_up_without_a_halo() {
    let Some(gpu) = gpu() else { return };
    let texels = window_and_room();
    let tonemapper = Tonemapper::AgxPunchy;
    let before = local_exposure_image(&gpu, tonemapper, SIZE, &texels, None).expect("the picture before");
    let after = local_exposure_image(&gpu, tonemapper, SIZE, &texels, Some(LocalExposure::DEFAULT)).expect("local exposure");
    let (room, window) = (16..WINDOW_X - 64, WINDOW_X + 64..SIZE.0 - 16);
    let (window_before, window_after) = (detail(&before, window.clone()), detail(&after, window.clone()));
    let (room_before, room_after) = (mean(&before, room.clone()), mean(&after, room.clone()));
    let near = mean(&after, WINDOW_X - 24..WINDOW_X - 4);
    eprintln!(
        "window: detail {window_before:.1} -> {window_after:.1} levels, mean {:.1} -> {:.1}; room: mean {room_before:.1} -> {room_after:.1}, beside the frame {near:.1}",
        mean(&before, window.clone()),
        mean(&after, window.clone())
    );
    assert!(window_after >= window_before * DETAIL_GAIN_MIN, "the window's stripes: {window_before:.1} -> {window_after:.1} levels (at least x{DETAIL_GAIN_MIN})");
    assert!(mean(&after, window.clone()) < mean(&before, window), "the window comes down");
    assert!(room_after > room_before + 4.0, "the room comes up: {room_before:.1} -> {room_after:.1}");
    assert!((near - room_after).abs() <= HALO_LEVELS_MAX, "a halo beside the window: {near:.1} against {room_after:.1} far from it");
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_off_is_byte_for_byte_the_picture_before() {
    let Some(gpu) = gpu() else { return };
    let texels = window_and_room();
    let plain = tonemap_image(&gpu, Tonemapper::AgxPunchy, SIZE.0, SIZE.1, &texels, false).expect("tonemap");
    for local in [None, Some(LocalExposure::OFF)] {
        let drawn = local_exposure_image(&gpu, Tonemapper::AgxPunchy, SIZE, &texels, local).expect("local exposure off");
        assert_eq!(drawn.digest(), plain.digest(), "{local:?} changes the picture");
    }
}

// --- The renderer: a room with a window onto a sunlit yard, desktop `high` ---

use genex_render::device_class::DeviceClass;
use genex_render::irradiance::IrradianceVolume;
use genex_render::presets::preset_quality;
use genex_render::probes::ReflectionProbe;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Environment, ExposureMode, Look, QualityPreset};

const ROOM_SIZE: (u32, u32) = (480, 270);

/// A closed room (20 cm walls and a ceiling, no lamp) with a window in its east wall onto a snowy
/// yard in the sun; the camera inside looks at the window. The sun falls through the window onto
/// the floor, so the room's only light is that patch and the sky through the window.
fn room_with_a_window() -> Scene {
    let mut scene = Scene::new(room_camera(), [0, 0, 0, 255]);
    scene.lighting.sun_dir = [0.8, 0.5, 0.25];
    scene.lighting.sun_intensity = 6.0;
    let plaster = Material::color([190, 190, 185, 255]).with_pbr(0.0, 0.9);
    // The room: x -4.2..0.2, z -2.2..2.2, 2.5 high inside.
    scene.draw(MeshId::CUBE, scaled([-2.0, -0.05, 0.0], [4.4, 0.1, 4.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([-2.0, 2.6, 0.0], [4.4, 0.2, 4.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([-4.1, 1.25, 0.0], [0.2, 2.5, 4.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([-2.0, 1.25, -2.1], [4.4, 2.5, 0.2]), plaster);
    scene.draw(MeshId::CUBE, scaled([-2.0, 1.25, 2.1], [4.4, 2.5, 0.2]), plaster);
    // The east wall around a window 1.6 wide (z -0.8..0.8) and 1.2 high (y 0.9..2.1).
    scene.draw(MeshId::CUBE, scaled([0.1, 0.45, 0.0], [0.2, 0.9, 4.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([0.1, 2.3, 0.0], [0.2, 0.4, 4.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([0.1, 1.5, -1.5], [0.2, 1.2, 1.4]), plaster);
    scene.draw(MeshId::CUBE, scaled([0.1, 1.5, 1.5], [0.2, 1.2, 1.4]), plaster);
    // The yard: snow in the sun, and a block of flats across it off to the side (its shadow falls
    // away from the window).
    scene.draw(MeshId::CUBE, scaled([8.0, -0.05, 0.0], [16.0, 0.1, 20.0]), Material::color([235, 238, 242, 255]).with_pbr(0.0, 0.8));
    scene.draw(MeshId::CUBE, scaled([10.0, 3.0, 6.0], [6.0, 6.0, 1.0]), Material::color([150, 145, 140, 255]).with_pbr(0.0, 0.9));
    // The room declared as games declare one: its reflection probe and its irradiance volume, so
    // the sky does not light its inside through the walls.
    let (min, max) = ([-4.0, 0.0, -2.0], [0.0, 2.5, 2.0]);
    scene.lighting.reflection_probes.push(ReflectionProbe::new(min, max).with_capture([-2.0, 1.6, 0.0]).with_blend(0.25));
    scene.lighting.irradiance_volumes.push(IrradianceVolume::new(min, max).with_blend(0.25));
    scene
}

fn room_camera() -> CameraDesc {
    CameraDesc::look_at([-3.4, 1.5, -0.9], [0.0, 1.6, 0.2])
}

/// Desktop `high` at `local` exposure, auto exposure metering the whole frame.
fn high_renderer(gpu: &Gpu, local: LocalExposure) -> genex_render::Renderer {
    high_renderer_at(gpu, ROOM_SIZE, local)
}

/// [`high_renderer`] drawing a `size` frame.
fn high_renderer_at(gpu: &Gpu, size: (u32, u32), local: LocalExposure) -> genex_render::Renderer {
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let mut renderer = genex_render::Renderer::with_options(gpu, size.0, size.1, genex_render::RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(genex_render::settings::SceneFormat::Rgba16Float);
    renderer.set_quality(&preset_quality(QualityPreset::High, class));
    renderer.set_environment(&Environment::sky());
    let mut look = Look::default().with_local_exposure(local);
    look.tonemapper = Tonemapper::AgxPunchy;
    look.exposure = ExposureMode::Auto;
    renderer.set_look(look);
    renderer
}

/// The frame after the environment, the volumes, TAA and the exposure have settled.
fn settled_capture(renderer: &mut genex_render::Renderer, gpu: &Gpu, scene: &Scene) -> Capture {
    renderer.set_environment_settle(true);
    for frame in 0..24u64 {
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.set_environment_settle(false);
    renderer.capture(gpu).expect("capture")
}

/// The mean display grey (0..255) of the pixels the world points `points` land on.
fn grey_at(capture: &Capture, camera: &CameraDesc, points: &[[f32; 3]]) -> f32 {
    let (width, height) = (capture.width(), capture.height());
    let view_proj = camera.view_proj(width as f32 / height as f32);
    let mut sum = 0.0;
    let mut count = 0.0;
    for point in points {
        let clip = view_proj * glam::Vec3::from(*point).extend(1.0);
        let ndc = clip.truncate() / clip.w;
        let (x, y) = (((ndc.x + 1.0) * 0.5 * width as f32) as i64, ((1.0 - ndc.y) * 0.5 * height as f32) as i64);
        if clip.w <= 0.0 || !(0..i64::from(width)).contains(&x) || !(0..i64::from(height)).contains(&y) {
            continue;
        }
        let at = ((y as u32 * width + x as u32) * 4) as usize;
        let [b, g, r] = [capture.bgra()[at], capture.bgra()[at + 1], capture.bgra()[at + 2]].map(f32::from);
        sum += 0.0722 * b + 0.7152 * g + 0.2126 * r;
        count += 1.0;
    }
    assert!(count > 0.0, "no point of the region is on screen");
    sum / count
}

/// A grid of points over the rectangle from `a` spanning `u` and `v`.
fn patch(a: [f32; 3], u: [f32; 3], v: [f32; 3]) -> Vec<[f32; 3]> {
    let steps = 10;
    (0..steps)
        .flat_map(|i| (0..steps).map(move |j| (i, j)))
        .map(|(i, j)| {
            let (s, t) = ((i as f32 + 0.5) / steps as f32, (j as f32 + 0.5) / steps as f32);
            std::array::from_fn(|k| a[k] + u[k] * s + v[k] * t)
        })
        .collect()
}

/// Write `capture` as raw BGRA named `name` under `GENEX_LOCAL_EXPOSURE_EVIDENCE_DIR`, when set.
fn write_evidence(name: &str, capture: &Capture) {
    let Ok(folder) = std::env::var("GENEX_LOCAL_EXPOSURE_EVIDENCE_DIR") else { return };
    std::fs::create_dir_all(&folder).expect("evidence folder");
    let file = format!("{name}-{}x{}.bgra", capture.width(), capture.height());
    std::fs::write(std::path::Path::new(&folder).join(file), capture.bgra()).expect("evidence written");
}

/// The least display levels the default look at `high` brings the window's view down and the
/// room's walls and ceiling up by, against the look without local exposure.
const ROOM_LEVELS_MIN: f32 = 6.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_default_look_at_high_holds_a_sunlit_window_and_the_room_around_it() {
    let Some(gpu) = gpu() else { return };
    let scene = room_with_a_window();
    let camera = room_camera();
    // What the window shows (the plane of its opening), the wall beside it, the ceiling above.
    let window = patch([0.15, 1.0, -0.7], [0.0, 1.0, 0.0], [0.0, 0.0, 1.4]);
    let wall = patch([-0.001, 0.2, -1.9], [0.0, 1.8, 0.0], [0.0, 0.0, 0.9]);
    let ceiling = patch([-2.6, 2.499, -1.8], [2.2, 0.0, 0.0], [0.0, 0.0, 3.6]);
    let mut rows = Vec::new();
    for (name, local) in [("off", LocalExposure::OFF), ("default", Look::default().local_exposure)] {
        let mut renderer = high_renderer(&gpu, local);
        let capture = settled_capture(&mut renderer, &gpu, &scene);
        write_evidence(&format!("room-window-{name}"), &capture);
        let row = [grey_at(&capture, &camera, &window), grey_at(&capture, &camera, &wall), grey_at(&capture, &camera, &ceiling)];
        eprintln!("{name}: window {:.1}, wall {:.1}, ceiling {:.1}", row[0], row[1], row[2]);
        rows.push(row);
    }
    let [off, on] = [rows[0], rows[1]];
    assert!(on[0] <= off[0] - ROOM_LEVELS_MIN, "the window's view comes down: {:.1} -> {:.1}", off[0], on[0]);
    assert!(on[1] >= off[1] + ROOM_LEVELS_MIN, "the wall beside the window comes up: {:.1} -> {:.1}", off[1], on[1]);
    assert!(on[2] >= off[2] + ROOM_LEVELS_MIN, "the ceiling comes up: {:.1} -> {:.1}", off[2], on[2]);
}

/// The HDR scene of the settled frame (before the tonemap), drawn at a fixed exposure of 1 so two
/// frames compare as radiance (auto exposure would follow whatever changed).
fn settled_scene(renderer: &mut genex_render::Renderer, gpu: &Gpu, scene: &Scene) -> Vec<[f32; 4]> {
    let mut look = *renderer.look();
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer.set_environment_settle(true);
    for frame in 0..24u64 {
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    renderer.set_environment_settle(false);
    renderer.read_scene(gpu).expect("the HDR scene reads back")
}

/// The mean HDR luminance of the pixels the world points `points` land on.
fn luminance_at(texels: &[[f32; 4]], camera: &CameraDesc, points: &[[f32; 3]]) -> f32 {
    let (width, height) = ROOM_SIZE;
    let view_proj = camera.view_proj(width as f32 / height as f32);
    let mut sum = 0.0;
    let mut count = 0.0;
    for point in points {
        let clip = view_proj * glam::Vec3::from(*point).extend(1.0);
        let ndc = clip.truncate() / clip.w;
        let (x, y) = (((ndc.x + 1.0) * 0.5 * width as f32) as i64, ((1.0 - ndc.y) * 0.5 * height as f32) as i64);
        if clip.w <= 0.0 || !(0..i64::from(width)).contains(&x) || !(0..i64::from(height)).contains(&y) {
            continue;
        }
        let [r, g, b, _] = texels[(y as u32 * width + x as u32) as usize];
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        count += 1.0;
    }
    assert!(count > 0.0, "no point of the region is on screen");
    sum / count
}

/// The least the later bounces lift the wall beside the window (which the sun never reaches and
/// whose cells see little of the sunlit floor) over the first bounce alone: a closed room of albedo
/// 0.45 takes about 1 / (1 - 0.45) = 1.8 times its first bounce, less where the window lets light
/// out.
const WALL_LIFT_MIN: f32 = 1.4;
/// The same for the ceiling, whose first bounce already holds the sunlit floor patch below it.
const CEILING_LIFT_MIN: f32 = 1.25;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_room_s_ceiling_takes_the_bounces_after_the_first() {
    // Red first: the volume's bake holds the first bounce only (the capture draws no ambient), so
    // the ceiling and the walls the sun never reaches take only what the sunlit floor patch and
    // the window send them once.
    let Some(gpu) = gpu() else { return };
    let camera = room_camera();
    let ceiling = patch([-2.6, 2.499, -1.8], [2.2, 0.0, 0.0], [0.0, 0.0, 3.6]);
    let wall = patch([-0.001, 0.2, -1.9], [0.0, 1.8, 0.0], [0.0, 0.0, 0.9]);
    let mut rows = Vec::new();
    for bounce in [0.0, genex_render::irradiance::DEFAULT_BOUNCE] {
        let mut scene = room_with_a_window();
        for volume in &mut scene.lighting.irradiance_volumes {
            *volume = volume.with_bounce(bounce);
        }
        let mut renderer = high_renderer(&gpu, LocalExposure::OFF);
        let texels = settled_scene(&mut renderer, &gpu, &scene);
        let row = [luminance_at(&texels, &camera, &ceiling), luminance_at(&texels, &camera, &wall)];
        eprintln!("bounce albedo {bounce}: ceiling {:.4}, wall {:.4}", row[0], row[1]);
        rows.push(row);
    }
    let [first, all] = [rows[0], rows[1]];
    assert!(all[0] >= first[0] * CEILING_LIFT_MIN, "the ceiling: {:.4} -> {:.4} (at least x{CEILING_LIFT_MIN})", first[0], all[0]);
    assert!(all[1] >= first[1] * WALL_LIFT_MIN, "the wall beside the window: {:.4} -> {:.4} (at least x{WALL_LIFT_MIN})", first[1], all[1]);
}

/// The room with its window shuttered and a lamp lit under the ceiling: the sky and the sun stay
/// outside.
fn shuttered_room() -> Scene {
    let mut scene = room_with_a_window();
    scene.draw(MeshId::CUBE, scaled([0.1, 1.5, 0.0], [0.2, 1.2, 1.6]), Material::color([120, 110, 100, 255]).with_pbr(0.0, 0.8));
    scene.lighting.points.push(genex_render::lights::PointLight { position: [-2.0, 2.2, 0.0], range: 6.0, color: [255, 236, 210], intensity: 2.0 });
    scene
}

/// The most the room's fog may brighten the room's lamp-lit side wall, as a share of the wall
/// without fog: the air inside a closed room scatters what the room sees (its lamp-lit walls and
/// the lamp), not the sky's horizon outside.
const ROOM_FOG_LIFT_MAX: f32 = 1.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_fog_inside_a_room_does_not_glow_with_the_sky_through_its_walls() {
    // Red first: the froxel fog in-scatters the horizon's radiance everywhere (the sun's lobe is
    // shadowed, the sky's is not), so a closed room's air glows as if it stood outdoors.
    use genex_render::settings::Fog;
    let Some(gpu) = gpu() else { return };
    let camera = room_camera();
    // The room's north wall (on the right), lit by the lamp.
    let wall = patch([-3.0, 0.2, 1.999], [2.5, 0.0, 0.0], [0.0, 2.0, 0.0]);
    let mut rows = Vec::new();
    for fogged in [false, true] {
        let mut renderer = high_renderer(&gpu, LocalExposure::OFF);
        if fogged {
            let fog = Fog::default().with_density(0.25).with_height(0.0, 0.0).with_range(0.0, 0.9);
            renderer.set_look(renderer.look().with_fog(fog));
        }
        let texels = settled_scene(&mut renderer, &gpu, &shuttered_room());
        let shown = luminance_at(&texels, &camera, &wall);
        eprintln!("fog {fogged}: the north wall {shown:.4}");
        rows.push(shown);
    }
    let lift = (rows[1] - rows[0]) / rows[0].max(1e-6);
    assert!(lift <= ROOM_FOG_LIFT_MAX, "the room's fog lifts its dark wall by {:.0}% (at most {:.0}%)", 100.0 * lift, 100.0 * ROOM_FOG_LIFT_MAX);
}

/// The median GPU time of each graph node over `frames` armed Live frames of `scene` (after the
/// environment and the volumes settled), by node name; None without timestamp queries.
fn node_medians(gpu: &Gpu, renderer: &mut genex_render::Renderer, scene: &Scene, frames: u64) -> Option<Vec<(&'static str, f64)>> {
    settled_capture(renderer, gpu, scene);
    let mut samples: Vec<(&'static str, f64)> = Vec::new();
    for frame in 100..100 + frames + 12 {
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let landed = renderer.arm_node_timer(&gpu.queue, frame)?;
        samples.extend(landed.iter().flat_map(|frame| frame.nodes.iter().map(|node| (node.node, node.ms))));
        renderer.set_frame_index(frame);
        renderer.render(gpu, scene, genex_render::CullPath::Gpu).expect("frame");
    }
    let mut names: Vec<&'static str> = samples.iter().map(|(name, _)| *name).collect();
    names.dedup();
    names.sort_unstable();
    names.dedup();
    Some(
        names
            .into_iter()
            .map(|name| {
                let mut times: Vec<f64> = samples.iter().filter(|(node, _)| *node == name).map(|(_, ms)| *ms).collect();
                times.sort_by(f64::total_cmp);
                (name, times[times.len() / 2])
            })
            .collect(),
    )
}

/// The most local exposure may add to the tonemap node at 1080p (its grid pass and the slice).
const LOCAL_EXPOSURE_BUDGET_MS: f64 = 0.3;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_local_exposure_at_1080p_holds_its_budget() {
    use genex_render::settings::Fog;
    let Some(gpu) = gpu() else { return };
    let size = (1920, 1080);
    let fog = Fog::default().with_density(0.02).with_height(0.2, 0.0).with_range(0.0, 0.6);
    let mut rows = Vec::new();
    for local in [LocalExposure::OFF, LocalExposure::DEFAULT] {
        let mut renderer = high_renderer_at(&gpu, size, local);
        renderer.set_look(renderer.look().with_fog(fog));
        let Some(nodes) = node_medians(&gpu, &mut renderer, &room_with_a_window(), 40) else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        let shown: Vec<String> = nodes.iter().filter(|(_, ms)| *ms >= 0.05).map(|(name, ms)| format!("{name} {ms:.3}")).collect();
        eprintln!("local exposure {:?}: {}", local.is_on(), shown.join(", "));
        rows.push(nodes);
    }
    let node = |rows: &[(&str, f64)], name: &str| rows.iter().find(|(node, _)| *node == name).map_or(0.0, |(_, ms)| *ms);
    let added = node(&rows[1], "tonemap") - node(&rows[0], "tonemap");
    eprintln!("local exposure adds {added:.3} ms to the tonemap at 1080p");
    assert!(added <= LOCAL_EXPOSURE_BUDGET_MS, "local exposure adds {added:.3} ms (at most {LOCAL_EXPOSURE_BUDGET_MS})");
}
