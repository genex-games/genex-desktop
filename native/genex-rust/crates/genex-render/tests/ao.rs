//! RQ4.4: ground-truth ambient occlusion (GTAO) with its own reprojected history, the bilateral
//! denoise and bent normals, run on a corner scene this file ray casts on the CPU (a floor, a back
//! wall and a box pushed into the corner), so the node is checked without the prepass.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test ao -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/ao/<name>.bgra` (the AO term as grey BGRA, top
//! row first, at the AO resolution of a 256x144 scene); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites
//! them instead. `GENEX_RENDER_EVIDENCE_DIR` also writes each compared term there; `GENEX_PERF_OUT`
//! receives the AO cost rows as JSON.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::device_class::DeviceClass;
use genex_render::post::ao::{self, AoCamera, AoFrame, AoFrameFacts, AoImage, AoSettings, GpuAoParams, GpuAoView, ao_gpu_ms, ao_term_images};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{AoQuality, AoResolution, Look, Quality, QualityPreset};
use genex_render::texture::{TextureData, TextureKind};
use genex_render::{CullPath, Gpu, Renderer};
use glam::{Vec3, Vec4};

const WIDTH: u32 = 256;
const HEIGHT: u32 = 144;
/// A golden texel may differ by this much (another Apple GPU family rounds differently).
const GOLDEN_TOLERANCE: u8 = 3;
/// Texels allowed beyond the tolerance, of 9216 (half resolution) or 36864.
const GOLDEN_OUTLIER_TEXELS: usize = 46;
/// The AO budgets at 1080p (plan §2.5), GPU ms: ultra's full resolution 1.5 ms (owner decision
/// 2026-10-12: its 3 slices x 8 steps keep their quality; was 1.2).
const HALF_BUDGET_MS: f32 = 0.6;
const FULL_BUDGET_MS: f32 = 1.5;
/// Samples the cost rows take.
const COST_SAMPLES: u32 = 30;

// ---------------------------------------------------------------------------------------------
// The corner scene, ray cast on the CPU

/// The back wall's plane (z) and the box pushed into the corner it makes with the floor.
const WALL_Z: f32 = -2.0;
const BOX_MIN: Vec3 = Vec3::new(-0.6, 0.0, -2.0);
const BOX_MAX: Vec3 = Vec3::new(0.6, 1.2, -0.8);

/// The scene's camera (perspective, reverse-Z as the HDR path draws).
fn camera(eye: Vec3) -> AoCamera {
    AoCamera {
        view: glam::camera::rh::view::look_at_mat4(eye, Vec3::new(0.0, 0.4, -1.2), Vec3::Y),
        proj: glam::camera::rh::proj::directx::perspective(50f32.to_radians(), WIDTH as f32 / HEIGHT as f32, 100.0, 0.1),
    }
}

const EYE: Vec3 = Vec3::new(0.0, 2.2, 3.5);

/// The nearest hit of the ray `origin + t * dir` with the slabs of the box, and its normal.
fn hit_box(origin: Vec3, dir: Vec3) -> Option<(f32, Vec3)> {
    let (mut near, mut far, mut normal) = (f32::NEG_INFINITY, f32::INFINITY, Vec3::ZERO);
    for axis in 0..3 {
        let inv = 1.0 / dir[axis];
        let (a, b) = ((BOX_MIN[axis] - origin[axis]) * inv, (BOX_MAX[axis] - origin[axis]) * inv);
        let (t0, t1) = if a < b { (a, b) } else { (b, a) };
        if t0 > near {
            near = t0;
            normal = Vec3::ZERO;
            normal[axis] = -dir[axis].signum();
        }
        far = far.min(t1);
    }
    (near <= far && near > 0.0).then_some((near, normal))
}

/// The corner scene seen from `eye` at render size: device depth (0 where the sky is) and world
/// normals per pixel; `with_box` false leaves the box out.
fn corner_frame(eye: Vec3, with_box: bool, facts: AoFrameFacts, size: (u32, u32)) -> AoFrame {
    let camera = camera(eye);
    let camera = AoCamera { proj: glam::camera::rh::proj::directx::perspective(50f32.to_radians(), size.0 as f32 / size.1 as f32, 100.0, 0.1), ..camera };
    let view_proj = camera.proj * camera.view;
    let inverse = view_proj.inverse();
    let mut depth = Vec::with_capacity((size.0 * size.1) as usize);
    let mut normals = Vec::with_capacity(depth.capacity());
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inverse * ndc;
            let dir = (far.truncate() / far.w - eye).normalize();
            let mut best: Option<(f32, Vec3)> = None;
            let mut take = |candidate: Option<(f32, Vec3)>| {
                if let Some((t, n)) = candidate
                    && t > 0.0
                    && best.is_none_or(|(held, _)| t < held)
                {
                    best = Some((t, n));
                }
            };
            take((dir.y < 0.0).then(|| (-eye.y / dir.y, Vec3::Y)));
            take((dir.z < 0.0).then(|| ((WALL_Z - eye.z) / dir.z, Vec3::Z)));
            if with_box {
                take(hit_box(eye, dir));
            }
            match best {
                Some((t, n)) => {
                    let clip = view_proj * (eye + dir * t).extend(1.0);
                    depth.push(clip.z / clip.w);
                    normals.push(n.to_array());
                }
                None => {
                    depth.push(0.0);
                    normals.push([0.0, 1.0, 0.0]);
                }
            }
        }
    }
    AoFrame { depth, normals, camera, facts, motion: Vec::new() }
}

fn facts(frame_index: u64, history_reset: bool) -> AoFrameFacts {
    AoFrameFacts { frame_index, history_reset, depth_reversed: true, ..AoFrameFacts::default() }
}

/// The AO pixel `world` projects to under `frame`'s camera on an AO image of `size`.
fn ao_pixel(frame: &AoFrame, size: (u32, u32), world: Vec3) -> (u32, u32) {
    let clip = frame.camera.proj * frame.camera.view * world.extend(1.0);
    let (u, v) = (clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    ((u * size.0 as f32) as u32, (v * size.1 as f32) as u32)
}

/// The mean visibility over the (2r+1)² window around `at`.
fn window_mean(image: &AoImage, at: (u32, u32), r: u32) -> f32 {
    let texels: Vec<f32> = (at.1 - r..=at.1 + r).flat_map(|y| (at.0 - r..=at.0 + r).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).collect();
    texels.iter().sum::<f32>() / texels.len() as f32
}

fn window_min(image: &AoImage, at: (u32, u32), r: u32) -> f32 {
    (at.1 - r..=at.1 + r).flat_map(|y| (at.0 - r..=at.0 + r).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).fold(1.0, f32::min)
}

fn window_spread(image: &AoImage, at: (u32, u32), r: u32) -> f32 {
    let mean = window_mean(image, at, r);
    let texels: Vec<f32> = (at.1 - r..=at.1 + r).flat_map(|y| (at.0 - r..=at.0 + r).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).collect();
    (texels.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / texels.len() as f32).sqrt()
}

fn quality(preset: QualityPreset) -> AoQuality {
    preset_quality(preset, DeviceClass::ALL[0]).ao
}

fn settings(quality: AoQuality) -> AoSettings {
    AoSettings::new(&Look::default(), &quality).expect("AO on")
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn every_ao_preset_runs_gtao_and_off_runs_nothing() {
    let look = Look::default();
    assert_eq!(AoSettings::new(&look, &Quality::off().ao), None, "the off preset draws no AO");
    let medium = quality(QualityPreset::Medium);
    let high = quality(QualityPreset::High);
    let ultra = quality(QualityPreset::Ultra);
    assert_eq!((medium.resolution, medium.slices, medium.temporal, medium.bent_normals()), (AoResolution::Half, 1, false, false));
    assert_eq!((high.resolution, high.slices, high.temporal, high.bent_normals()), (AoResolution::Half, 2, true, true));
    assert_eq!((ultra.resolution, ultra.slices, ultra.temporal, ultra.bent_normals()), (AoResolution::Full, 3, true, true));
    for quality in [medium, high, ultra] {
        assert!(AoSettings::new(&look, &quality).is_some());
    }
}

fn wgsl_sizes(source: &str, name: &str) -> Vec<usize> {
    let module = naga::front::wgsl::parse_str(source).expect("parses");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.types.iter().filter(|(_, ty)| ty.name.as_deref() == Some(name)).map(|(handle, _)| layouter[handle].size as usize).collect()
}

#[test]
fn the_ao_rows_equal_the_wgsl_structs_naga_lays_out() {
    use genex_render::shaders::{AO_DENOISE, GTAO};
    for source in [GTAO, AO_DENOISE] {
        assert_eq!(wgsl_sizes(source, "AoParams"), [size_of::<GpuAoParams>()]);
        assert_eq!(wgsl_sizes(source, "AoView"), [size_of::<GpuAoView>()]);
    }
    assert_eq!(size_of::<GpuAoView>(), 336);
}

#[test]
fn the_corner_scene_has_floor_wall_box_and_sky() {
    let frame = corner_frame(EYE, true, facts(0, true), (WIDTH, HEIGHT));
    let normal_at = |world: Vec3| {
        let (x, y) = ao_pixel(&frame, (WIDTH, HEIGHT), world);
        frame.normals[(y * WIDTH + x) as usize]
    };
    assert_eq!(normal_at(Vec3::new(0.0, 0.0, 0.9)), [0.0, 1.0, 0.0], "floor");
    assert_eq!(normal_at(Vec3::new(2.5, 1.5, WALL_Z)), [0.0, 0.0, 1.0], "wall");
    assert_eq!(normal_at(Vec3::new(0.0, 0.6, BOX_MAX.z)), [0.0, 0.0, 1.0], "box front");
    assert!(frame.depth.iter().all(|d| (0.0..=1.0).contains(d)));
}

// ---------------------------------------------------------------------------------------------
// GPU fixtures

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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/ao")
}

/// The term as grey BGRA (visibility in every colour channel).
fn grey(image: &AoImage) -> Capture {
    let bgra = image.visibility.iter().flat_map(|v| [*v, *v, *v, 255]).collect();
    Capture::new(image.size.0, image.size.1, bgra).expect("capture")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence");
    }
}

/// Compare `image` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, image: &AoImage) {
    let capture = grey(image);
    write_evidence(name, &capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: size");
    let diffs: Vec<u8> = golden.chunks(4).zip(capture.bgra().chunks(4)).map(|(a, b)| a[0].abs_diff(b[0])).collect();
    let outliers = diffs.iter().filter(|d| **d > GOLDEN_TOLERANCE).count();
    let worst = diffs.iter().max().copied().unwrap_or(0);
    assert!(outliers <= GOLDEN_OUTLIER_TEXELS, "{name}: {outliers} texels differ from the golden by more than {GOLDEN_TOLERANCE} (worst {worst})");
}

fn run(gpu: &Gpu, settings: &AoSettings, frames: &[AoFrame]) -> Vec<AoImage> {
    ao_term_images(gpu, settings, (WIDTH, HEIGHT), frames).expect("AO runs")
}

/// `frame` alone at render size `size` as a history reset (its own noise key).
fn run_at(gpu: &Gpu, settings: &AoSettings, size: (u32, u32), frame: &AoFrame) -> AoImage {
    let fresh = AoFrame { facts: AoFrameFacts { history_reset: true, ..frame.facts }, ..frame.clone() };
    ao_term_images(gpu, settings, size, std::slice::from_ref(&fresh)).expect("AO runs").remove(0)
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_box_in_a_corner_darkens_the_creases_and_leaves_open_ground_unoccluded() {
    let Some(gpu) = gpu() else { return };
    let frame = corner_frame(EYE, true, facts(0, true), (WIDTH, HEIGHT));
    for (name, preset) in [("gtao-medium", QualityPreset::Medium), ("gtao-high", QualityPreset::High), ("gtao-ultra", QualityPreset::Ultra)] {
        let settings = settings(quality(preset));
        let image = run(&gpu, &settings, std::slice::from_ref(&frame)).remove(0);
        write_evidence(name, &grey(&image));
        let size = image.size;
        let crease_wall = ao_pixel(&frame, size, Vec3::new(1.8, 0.02, WALL_Z + 0.02));
        let crease_box = ao_pixel(&frame, size, Vec3::new(0.0, 0.02, BOX_MAX.z + 0.02));
        let open = ao_pixel(&frame, size, Vec3::new(0.0, 0.0, 0.9));
        let (wall, front) = (window_mean(&image, crease_wall, 1), window_mean(&image, crease_box, 1));
        let (ground, lowest) = (window_mean(&image, open, 3), window_min(&image, open, 3));
        eprintln!("{name}: creases {wall:.3} and {front:.3}, open ground {ground:.3} (lowest {lowest:.3})");
        assert!(wall < 0.7, "{name}: the floor-wall crease darkens ({wall})");
        assert!(front < 0.7, "{name}: the box-floor crease darkens ({front})");
        assert!((ground - 1.0).abs() <= 0.02, "{name}: open ground stays unoccluded ({ground})");
        // One slice (medium) leaves some speckle the 5x5 denoise does not remove.
        assert!(lowest >= 0.85, "{name}: no dark speckle on open ground ({lowest})");
        let sky = image.at(size.0 / 2, 0);
        assert_eq!(sky, 1.0, "{name}: the sky is unoccluded");
        if preset != QualityPreset::Ultra {
            check_golden(name, &image);
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_bent_normals_lean_out_of_the_crease_and_stand_up_on_open_ground() {
    let Some(gpu) = gpu() else { return };
    let frame = corner_frame(EYE, true, facts(0, true), (WIDTH, HEIGHT));
    let image = run(&gpu, &settings(quality(QualityPreset::High)), std::slice::from_ref(&frame)).remove(0);
    let bent = image.bent.as_ref().expect("high carries bent normals");
    let bgra = bent.iter().flat_map(|n| [n[2], n[1], n[0], 255]).collect();
    write_evidence("gtao-high-bent-normals", &Capture::new(image.size.0, image.size.1, bgra).expect("capture"));
    let decode = |at: (u32, u32)| {
        let texel = bent[(at.1 * image.size.0 + at.0) as usize];
        Vec3::new(f32::from(texel[0]), f32::from(texel[1]), f32::from(texel[2])) / 255.0 * 2.0 - Vec3::ONE
    };
    let open = decode(ao_pixel(&frame, image.size, Vec3::new(0.0, 0.0, 0.9)));
    assert!(open.y > 0.9 && open.length() > 0.9, "open ground's bent normal is the floor's ({open})");
    let near_wall = decode(ao_pixel(&frame, image.size, Vec3::new(1.8, 0.02, WALL_Z + 0.15)));
    assert!(near_wall.z > 0.1, "next to the wall the bent normal leans away from it ({near_wall})");
    let medium = run(&gpu, &settings(quality(QualityPreset::Medium)), std::slice::from_ref(&frame)).remove(0);
    assert!(medium.bent.is_none(), "one slice: r8unorm visibility only");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_without_history_consecutive_frames_of_a_static_scene_are_byte_identical() {
    let Some(gpu) = gpu() else { return };
    let mut medium = quality(QualityPreset::Medium);
    medium.temporal = false;
    let frames = [corner_frame(EYE, true, facts(7, false), (WIDTH, HEIGHT)), corner_frame(EYE, true, facts(8, false), (WIDTH, HEIGHT))];
    let images = run(&gpu, &settings(medium), &frames);
    assert_eq!(images[0], images[1], "no history: a static per-pixel pattern, not the frame index");
    let mut high = quality(QualityPreset::High);
    high.temporal = false;
    let images = run(&gpu, &settings(high), &frames);
    assert_eq!(images[0], images[1], "two slices and bent normals without history are static too");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_settled_captures_are_identical_and_a_settle_resets_the_history() {
    let Some(gpu) = gpu() else { return };
    let settings = settings(quality(QualityPreset::High));
    let size = (WIDTH, HEIGHT);
    // Two settled captures: a reset, then the same frames.
    let settled: Vec<AoFrame> = (0..6).map(|i| corner_frame(EYE, true, facts(40 + i, i == 0), size)).collect();
    let first = run(&gpu, &settings, &settled);
    let second = run(&gpu, &settings, &settled);
    assert_eq!(first, second, "settled AO is deterministic");
    // History from another view and another scene before the settle must not leak into it.
    let mut warmed: Vec<AoFrame> = (0..4).map(|i| corner_frame(EYE + Vec3::new(0.8, 0.3, 0.0), i % 2 == 0, facts(3 + i, i == 0), size)).collect();
    warmed.extend(settled.iter().cloned());
    let after_warmup = run(&gpu, &settings, &warmed);
    assert_eq!(after_warmup[4..], first[..], "a settle starts AO's history over");
    // The history accumulates: open ground is calmer after a few frames than on the reset frame.
    let open = ao_pixel(&settled[0], first[0].size, Vec3::new(0.0, 0.0, 0.9));
    let calm = |image: &AoImage| window_spread(image, open, 4);
    assert!(calm(&first[5]) <= calm(&first[0]) + 1e-3, "history smooths: {} after against {} on the reset", calm(&first[5]), calm(&first[0]));
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_history_is_rejected_where_the_reprojected_depth_disagrees() {
    let Some(gpu) = gpu() else { return };
    let settings = settings(quality(QualityPreset::High));
    let size = (WIDTH, HEIGHT);
    // The box goes away between two frames of a still camera: where it stood, last frame's depth
    // (the box) disagrees with this frame's (the floor and wall behind it).
    let with_box = corner_frame(EYE, true, facts(20, true), size);
    let without = corner_frame(EYE, false, facts(21, false), size);
    let carried = run(&gpu, &settings, &[with_box.clone(), without.clone()]).remove(1);
    // The same frame after an all-sky one: its history is rejected everywhere, so the frame is its
    // own estimate (the same steps: a frame that blends history takes every other one).
    let texels = without.depth.len();
    let sky = AoFrame { depth: vec![0.0; texels], normals: vec![[0.0, 1.0, 0.0]; texels], camera: without.camera, facts: facts(20, true), motion: Vec::new() };
    let fresh = run(&gpu, &settings, &[sky, without.clone()]).remove(1);
    // Low on the box's front face: dark in the box's term; once the box is gone the floor behind it
    // shows there, a view distance more than `HISTORY_DEPTH_REJECT` away. (Lower still, at the very
    // foot, the floor's distance is within it: depth alone cannot tell a crease that opened up. At
    // 0.15 m up the floor behind lay barely past it, and since each AO texel stands for one render
    // pixel (gate finding 03) that point's history passed: 0.2 m keeps the row off the margin.)
    let foot = ao_pixel(&with_box, carried.size, Vec3::new(0.0, 0.2, BOX_MAX.z));
    let box_term = run(&gpu, &settings, std::slice::from_ref(&with_box)).remove(0);
    let (dark, own) = (box_term.at(foot.0, foot.1), fresh.at(foot.0, foot.1));
    eprintln!("box foot: the box's term {dark:.3}, after it went {:.3}, without its history {own:.3}", carried.at(foot.0, foot.1));
    assert!(dark < 0.8 && own > dark + 0.1, "the box's foot is dark and the floor behind it is not ({dark}, {own})");
    assert_eq!(carried.at(foot.0, foot.1), fresh.at(foot.0, foot.1), "the disoccluded floor takes no box history");
    // A moved camera reprojects: open ground stays unoccluded rather than smearing.
    let moved = corner_frame(EYE + Vec3::new(0.25, 0.0, 0.0), true, facts(22, false), size);
    let image = run(&gpu, &settings, &[corner_frame(EYE, true, facts(21, true), size), moved.clone()]).remove(1);
    let open = ao_pixel(&moved, image.size, Vec3::new(0.0, 0.0, 0.9));
    let ground = window_mean(&image, open, 3);
    assert!((ground - 1.0).abs() <= 0.02, "open ground after a camera move: {ground}");
}

// ---------------------------------------------------------------------------------------------
// AO off: the picture before AO

/// The part1 `pbr` golden: rendered before RQ4.4 (spheres resting on a normal-mapped floor under
/// the flat ambient and the sun) and compared here byte for byte, not at the golden tolerance.
const PRE_AO_GOLDEN: &str = "../../../../tests/fixtures/render-goldens/part1/pbr.bgra";
const PRE_AO_SIZE: (u32, u32) = (128, 72);

/// A square RGBA8 image from a per-pixel function.
fn texture_image(size: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> TextureData {
    let rgba = (0..size).flat_map(|y| (0..size).map(move |x| (x, y))).flat_map(|(x, y)| f(x, y)).collect();
    TextureData::rgba8(size, size, rgba).expect("texture")
}

/// golden_part1.rs's `pbr` scene, texture for texture.
fn pbr_scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let checker = texture_image(64, |x, y| if (x / 16 + y / 16).is_multiple_of(2) { [235, 235, 235, 255] } else { [20, 20, 20, 255] });
    let bumps = texture_image(64, |x, y| {
        let (u, v) = ((x % 16) as f32 / 16.0 - 0.5, (y % 16) as f32 / 16.0 - 0.5);
        let (nx, ny) = (u * 1.6, v * 1.6);
        let nz = (1.0 - (nx * nx + ny * ny).min(0.95)).sqrt();
        let enc = |c: f32| ((c * 0.5 + 0.5) * 255.0).round() as u8;
        [enc(nx), enc(ny), enc(nz), 255]
    });
    let base = renderer.add_texture(gpu, &checker, TextureKind::Color).expect("base texture");
    let normal = renderer.add_texture(gpu, &bumps, TextureKind::Data).expect("normal map");
    let rough = renderer.add_texture(gpu, &texture_image(16, |x, _| [0, (x * 16) as u8, 0, 255]), TextureKind::Data).expect("mr");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.2, 6.5], [0.0, 0.3, 0.0]), [18, 20, 28, 255]);
    scene.lighting.shadows = false;
    for i in 0..5 {
        let x = i as f32 * 1.1 - 2.2;
        let roughness = 0.1 + 0.2 * i as f32;
        scene.draw(MeshId::SPHERE, scaled([x, 1.4, 0.0], [0.5; 3]), Material::color([230, 180, 60, 255]).with_pbr(1.0, roughness));
        scene.draw(MeshId::SPHERE, scaled([x, 0.3, 0.0], [0.5; 3]), Material::color([60, 120, 230, 255]).with_pbr(0.0, roughness));
    }
    let floor = Material::color([255; 4]).with_base_texture(base).with_normal_map(normal, 1.0).with_metal_rough_texture(rough);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.4, 0.0], [6.0, 0.2, 3.0]), floor);
    scene
}

fn pbr_frame(gpu: &Gpu, quality: &Quality) -> Capture {
    let mut renderer = Renderer::new(gpu, PRE_AO_SIZE.0, PRE_AO_SIZE.1).expect("renderer");
    renderer.set_quality(quality);
    let scene = pbr_scene(&mut renderer, gpu);
    renderer.render(gpu, &scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}

/// AO switched off draws the picture from before AO, byte for byte: the ambient chunk's occlusion
/// (multi-bounce, specular occlusion) is exactly 1 at full visibility, so a game without AO pays
/// no change in its pixels. Since the renderer records AO ([`ao::LANDED`], RQ4.6) an AO-enabled
/// quality with the prepass it reads darkens the frame (the spheres' contact with the floor), and
/// only darkens it: AO takes indirect light away, never adds any.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_ao_off_draws_the_pre_ao_golden_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    let golden = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(PRE_AO_GOLDEN)).expect("the part1 pbr golden");
    let off = pbr_frame(&gpu, &Quality::off());
    write_evidence("ao-off-pbr", &off);
    let differing = golden.iter().zip(off.bgra()).filter(|(a, b)| a != b).count();
    assert!(off.bgra() == golden.as_slice(), "AO off differs from the pre-AO golden in {differing} bytes");
    let sum = |bgra: &[u8]| bgra.chunks(4).map(|p| u64::from(p[0]) + u64::from(p[1]) + u64::from(p[2])).sum::<u64>();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let mut with_ao = Quality::off();
        with_ao.ao = quality(preset);
        with_ao.prepass = true;
        let frame = pbr_frame(&gpu, &with_ao);
        write_evidence(&format!("ao-on-pbr-{}", preset.wire()), &frame);
        if !ao::LANDED {
            assert!(frame.bgra() == golden.as_slice(), "{preset:?}: AO the graph does not schedule changes nothing");
            continue;
        }
        let brighter = frame.bgra().chunks(4).zip(golden.chunks(4)).filter(|(a, b)| (0..3).any(|lane| a[lane] > b[lane].saturating_add(1))).count();
        assert!(sum(frame.bgra()) < sum(&golden), "{preset:?}: AO darkens the frame");
        assert_eq!(brighter, 0, "{preset:?}: AO never brightens a pixel");
    }
}

/// One cost row: AO under `quality` on the corner scene seen from `eye` at 1080p, p50 and p95 GPU ms
/// (None without `TIMESTAMP_QUERY`). `reset` makes every frame a history reset (no history read;
/// since pass 2 P4 the running frames' slices); otherwise the frames blend history as a running
/// game's do.
fn cost(gpu: &Gpu, quality: AoQuality, eye: Vec3, reset: bool) -> Option<(f32, f32)> {
    let render = (1920, 1080);
    let frame = corner_frame(eye, true, facts(1, reset), render);
    let mut costs = ao_gpu_ms(gpu, &settings(quality), render, &frame, COST_SAMPLES).expect("cost")?;
    costs.sort_by(f32::total_cmp);
    Some((costs[costs.len() / 2], costs[(costs.len() * 95 / 100).min(costs.len() - 1)]))
}

/// The corner scene from three times as far: AO's radius covers about a third of the pixels, as
/// in a scene seen from a game camera rather than up close.
const FAR_EYE: Vec3 = Vec3::new(0.0, 5.8, 13.9);

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_ao_costs_within_its_budget_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let mut rows = Vec::new();
    let cases = [
        ("medium", quality(QualityPreset::Medium), EYE, false, HALF_BUDGET_MS, true),
        ("high", quality(QualityPreset::High), EYE, false, HALF_BUDGET_MS, true),
        ("ultra", quality(QualityPreset::Ultra), EYE, false, FULL_BUDGET_MS, true),
        ("ultra-far", quality(QualityPreset::Ultra), FAR_EYE, false, FULL_BUDGET_MS, true),
        // A history reset (a settled capture's first frame, a camera cut) took every slice of
        // ultra's 3 x 8 (1.9 ms) and was only recorded; since pass 2 (P4, flipped to asserted) it
        // takes the running frames' slices and holds the budget too.
        ("ultra-reset", quality(QualityPreset::Ultra), EYE, true, FULL_BUDGET_MS, true),
    ];
    for (name, quality, eye, reset, budget, asserted) in cases {
        let Some((p50, p95)) = cost(&gpu, quality, eye, reset) else {
            eprintln!("skipped: no TIMESTAMP_QUERY");
            return;
        };
        eprintln!("ao {name} 1080p: p50 {p50:.3} ms, p95 {p95:.3} ms (budget {budget} ms{})", if asserted { "" } else { ", recorded" });
        rows.push(serde_json::json!({
            "case": name, "render": [1920, 1080], "slices": quality.slices, "steps": quality.steps, "full_res": quality.resolution == AoResolution::Full, "history_reset": reset,
            "p50_ms": p50, "p95_ms": p95, "budget_ms": budget, "asserted": asserted, "within_budget": p50 <= budget,
        }));
        assert!(!asserted || p50 <= budget, "AO {name} costs {p50} ms at 1080p, over {budget} ms");
    }
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let report = serde_json::json!({ "row": "ao-cost", "adapter": gpu.receipt().adapter, "samples": COST_SAMPLES, "rows": rows });
        std::fs::write(path, serde_json::to_string_pretty(&report).expect("json")).expect("perf written");
    }
}

// ---------------------------------------------------------------------------------------------
// RQ4 review: half-resolution AO through the joint-bilateral upsample

/// The step's height and the slab's far edge: a thin slab (a kerb, a draped path) on the floor for
/// x < 0, its face at x = 0 looking along +x.
const STEP_HEIGHT: f32 = 0.08;

/// The thin-step scene seen from `eye` at render size: floor, the slab's top and its face.
fn step_frame(eye: Vec3, size: (u32, u32)) -> AoFrame {
    let camera = AoCamera {
        view: glam::camera::rh::view::look_at_mat4(eye, Vec3::new(0.0, 0.0, -0.5), Vec3::Y),
        proj: glam::camera::rh::proj::directx::perspective(50f32.to_radians(), size.0 as f32 / size.1 as f32, 100.0, 0.1),
    };
    let view_proj = camera.proj * camera.view;
    let inverse = view_proj.inverse();
    let mut depth = Vec::with_capacity((size.0 * size.1) as usize);
    let mut normals = Vec::with_capacity(depth.capacity());
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inverse * ndc;
            let dir = (far.truncate() / far.w - eye).normalize();
            let mut best: Option<(f32, Vec3)> = None;
            let mut take = |t: f32, n: Vec3, keep: &dyn Fn(Vec3) -> bool| {
                if t > 0.0 && keep(eye + dir * t) && best.is_none_or(|(held, _)| t < held) {
                    best = Some((t, n));
                }
            };
            if dir.y < 0.0 {
                take(-eye.y / dir.y, Vec3::Y, &|p| p.x >= 0.0);
                take((STEP_HEIGHT - eye.y) / dir.y, Vec3::Y, &|p| p.x < 0.0);
            }
            if dir.x.abs() > 1e-6 {
                take(-eye.x / dir.x, Vec3::X, &|p| p.y >= 0.0 && p.y <= STEP_HEIGHT);
            }
            match best {
                Some((t, n)) => {
                    let clip = view_proj * (eye + dir * t).extend(1.0);
                    depth.push(clip.z / clip.w);
                    normals.push(n.to_array());
                }
                None => {
                    depth.push(0.0);
                    normals.push([0.0, 1.0, 0.0]);
                }
            }
        }
    }
    AoFrame { depth, normals, camera, facts: facts(0, true), motion: Vec::new() }
}

/// The column of the step's face on row `y` of `frame`: the first floor pixel right of the slab.
fn face_column(frame: &AoFrame, width: u32, y: u32) -> Option<u32> {
    (1..width).find(|&x| {
        let at = (y * width + x) as usize;
        frame.normals[at] == [1.0, 0.0, 0.0] || (frame.normals[at - 1] == [0.0, 1.0, 0.0] && frame.depth[at] < frame.depth[at - 1] - 1e-6)
    })
}

/// Per row of `image` (render size), how far the darkening (visibility below `threshold`) reaches
/// on each side of the step's face: (row, pixels onto the slab's top left of the face, the last
/// dark column right of it on the floor).
fn crease_reach(image: &AoImage, frame: &AoFrame, threshold: f32) -> Vec<(u32, u32, Option<u32>)> {
    let (w, h) = image.size;
    (h / 3..h * 5 / 6)
        .filter_map(|y| {
            let face = face_column(frame, w, y)?;
            let onto_top = (0..face).rev().take_while(|&x| image.at(x, y) < threshold).count() as u32;
            let floor = (face..w).rev().find(|&x| image.at(x, y) < threshold);
            Some((y, onto_top, floor))
        })
        .collect()
}

/// `image` (half resolution) read with a plain bilinear filter at each pixel of `render`: what the
/// world pass read before the upsample.
fn bilinear(image: &AoImage, render: (u32, u32)) -> AoImage {
    let (w, h) = image.size;
    let at = |x: i64, y: i64| f32::from(image.visibility[(y.clamp(0, i64::from(h) - 1) as u32 * w + x.clamp(0, i64::from(w) - 1) as u32) as usize]);
    let visibility = (0..render.1)
        .flat_map(|y| (0..render.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let (u, v) = ((x as f32 + 0.5) * w as f32 / render.0 as f32 - 0.5, (y as f32 + 0.5) * h as f32 / render.1 as f32 - 0.5);
            let (x0, y0) = (u.floor() as i64, v.floor() as i64);
            let (fx, fy) = (u - u.floor(), v - v.floor());
            let top = at(x0, y0) * (1.0 - fx) + at(x0 + 1, y0) * fx;
            let bottom = at(x0, y0 + 1) * (1.0 - fx) + at(x0 + 1, y0 + 1) * fx;
            (top * (1.0 - fy) + bottom * fy).round() as u8
        })
        .collect();
    AoImage { size: render, visibility, bent: None }
}

/// How `image`'s crease reaches past `reference`'s: the worst row on the floor side, the rows
/// past by more than 2 pixels, and the mean pixels per row it darkens on the slab's top beyond the
/// reference's.
fn overshoot(image: &AoImage, reference: &AoImage, frame: &AoFrame) -> (i64, usize, f32) {
    let threshold = 0.85;
    let (wide, narrow) = (crease_reach(image, frame, threshold), crease_reach(reference, frame, threshold));
    let (mut floor, mut rows_over_two, mut top) = (0i64, 0usize, 0i64);
    for ((_, onto, last), (_, reference_onto, reference_last)) in wide.iter().zip(&narrow) {
        let past = i64::from(last.unwrap_or(0)) - i64::from(reference_last.unwrap_or(0));
        floor = floor.max(past);
        rows_over_two += usize::from(past > 2);
        top += (i64::from(*onto) - i64::from(*reference_onto)).max(0);
    }
    (floor, rows_over_two, top as f32 / wide.len().max(1) as f32)
}

/// RQ4 review (visual 2): half-resolution AO reaches the world pass through the joint-bilateral
/// upsample, so a thin step's crease stays about as narrow as the full-resolution term draws it: on
/// the floor beside the step within 2 render pixels on 95 % of the rows (3 at most: a
/// half-resolution texel and a half), and on the step's top under a pixel a row on average, less
/// than a plain bilinear read of the same half-resolution term (the world pass's before) bleeds.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_half_resolution_ao_keeps_a_thin_steps_crease_within_two_pixels_of_full_resolution() {
    let Some(gpu) = gpu() else { return };
    let eye = Vec3::new(1.6, 1.1, 2.4);
    let frame = step_frame(eye, (WIDTH, HEIGHT));
    // A full-resolution term at three slices of eight steps (the finest sampling the node takes;
    // ultra's preset took it until gate finding 03 moved ultra to four steps a slice) and high's
    // half-resolution one, each a reset frame (no history: a settled capture's first). The
    // reference takes every slice (without history: a temporal quality's frames take half).
    let mut full = quality(QualityPreset::Ultra);
    full.steps = ao::STEPS_MAX;
    full.temporal = false;
    let half = quality(QualityPreset::High);
    let reference = ao::ao_render_images(&gpu, &settings(full), (WIDTH, HEIGHT), std::slice::from_ref(&frame)).expect("full").remove(0);
    let upsampled = ao::ao_render_images(&gpu, &settings(half), (WIDTH, HEIGHT), std::slice::from_ref(&frame)).expect("half").remove(0);
    let plain = bilinear(&ao_term_images(&gpu, &settings(half), (WIDTH, HEIGHT), std::slice::from_ref(&frame)).expect("half term").remove(0), (WIDTH, HEIGHT));
    write_evidence("step-full", &grey(&reference));
    write_evidence("step-half-upsampled", &grey(&upsampled));
    write_evidence("step-half-bilinear", &grey(&plain));
    assert_eq!(upsampled.size, (WIDTH, HEIGHT), "the world pass reads the term at the render size");
    assert!(crease_reach(&reference, &frame, 0.85).iter().filter(|(.., last)| last.is_some()).count() > 10, "the full-resolution term darkens the crease");
    let (floor, rows, top) = overshoot(&upsampled, &reference, &frame);
    let (plain_floor, plain_rows, plain_top) = overshoot(&plain, &reference, &frame);
    eprintln!(
        "thin step, upsampled: floor overshoot {floor} px ({rows} rows over 2), onto the top {top:.2} px a row; bilinear: {plain_floor} px ({plain_rows} rows), {plain_top:.2} px a row"
    );
    assert!(floor <= 3 && rows * 20 <= crease_reach(&reference, &frame, 0.85).len(), "the crease reaches {floor} px past full resolution ({rows} rows over 2 px)");
    assert!(top <= 1.0 && top < plain_top, "the crease bleeds {top:.2} px a row onto the step's top (bilinear {plain_top:.2})");
}

/// RQ4 review (visual 5): medium's AO (one slice, four steps, half resolution, no history) leaves
/// open ground flat: the term's standard deviation over the open floor in front of the corner,
/// where nothing occludes, is at most 0.01 (red before the fix: a static streaky mottle).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_medium_ao_leaves_no_mottle_on_open_ground() {
    let Some(gpu) = gpu() else { return };
    let frame = corner_frame(EYE, true, facts(0, true), (WIDTH, HEIGHT));
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        let image = ao::ao_render_images(&gpu, &settings(quality(preset)), (WIDTH, HEIGHT), std::slice::from_ref(&frame)).expect("AO").remove(0);
        write_evidence(&format!("open-{}", preset.wire()), &grey(&image));
        // The floor in front of the box, well clear of the creases: rows near the bottom.
        let texels: Vec<f32> = (HEIGHT - 24..HEIGHT - 4).flat_map(|y| (24..WIDTH - 24).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).collect();
        let mean = texels.iter().sum::<f32>() / texels.len() as f32;
        let spread = (texels.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / texels.len() as f32).sqrt();
        let lowest = texels.iter().copied().fold(1.0, f32::min);
        eprintln!("{preset:?} open floor: mean {mean:.4}, standard deviation {spread:.4}, lowest {lowest:.3}");
        assert!(spread <= 0.01, "{preset:?}: open ground's AO varies by {spread:.4} (lowest {lowest:.3})");
    }
}

/// The walk-through ground row's render size, eye height, field of view and how far below the
/// horizon its measured ground starts (render rows): the stress forest's camera (eye height
/// 1.75 m, 62 degrees, looking a little up the path) over open flat ground at 720p.
const GROUND_SIZE: (u32, u32) = (1280, 720);
const GROUND_EYE_HEIGHT: f32 = 1.75;
const GROUND_FOVY_DEGREES: f32 = 62.0;
const GROUND_ROWS_BELOW_HORIZON: u32 = 60;
/// The bottom rows the edge check reads (where the horizon search's samples run off screen).
const GROUND_EDGE_ROWS: u32 = 4;
/// Open flat ground's term at every AO preset: its standard deviation at most this, and no texel
/// (the bottom edge included) below [`GROUND_LOWEST`]. Gate finding 03: medium drew a mottle
/// (stress-forest ground luma sd 1.99 against high's 0.93) and dark dots along the bottom edge.
const GROUND_SPREAD_MAX: f32 = 0.01;
const GROUND_LOWEST: f32 = 0.95;

/// Open flat ground (y = 0, nothing else; the sky above the horizon) seen from eye height looking
/// along -z and slightly up, at `size`.
fn open_ground_frame(size: (u32, u32), frame_index: u64) -> AoFrame {
    let eye = Vec3::new(0.0, GROUND_EYE_HEIGHT, 0.0);
    let camera = AoCamera {
        view: glam::camera::rh::view::look_at_mat4(eye, Vec3::new(0.0, GROUND_EYE_HEIGHT * 1.1, -4.0), Vec3::Y),
        proj: glam::camera::rh::proj::directx::perspective(GROUND_FOVY_DEGREES.to_radians(), size.0 as f32 / size.1 as f32, 500.0, 0.1),
    };
    let view_proj = camera.proj * camera.view;
    let inverse = view_proj.inverse();
    let mut depth = Vec::with_capacity((size.0 * size.1) as usize);
    let mut normals = Vec::with_capacity(depth.capacity());
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inverse * ndc;
            let dir = (far.truncate() / far.w - eye).normalize();
            let t = if dir.y < 0.0 { -eye.y / dir.y } else { f32::INFINITY };
            let clip = view_proj * (eye + dir * t).extend(1.0);
            let on_ground = t.is_finite() && clip.z / clip.w > 0.0;
            depth.push(if on_ground { clip.z / clip.w } else { 0.0 });
            normals.push([0.0, 1.0, 0.0]);
        }
    }
    AoFrame { depth, normals, camera, facts: AoFrameFacts { frame_index, history_reset: frame_index == 0, depth_reversed: true, ..AoFrameFacts::default() }, motion: Vec::new() }
}

/// The first render row of `frame` whose every texel is ground.
fn first_ground_row(frame: &AoFrame, size: (u32, u32)) -> u32 {
    (0..size.1).find(|y| (0..size.0).all(|x| frame.depth[(y * size.0 + x) as usize] > 0.0)).expect("the ground fills the bottom of the frame")
}

/// Gate finding 03: medium's AO (one slice, four steps, half resolution, no history, no TAA) drew a
/// blocky mottle of false occlusion over open flat ground and dark dots along the bottom screen
/// edge in the stress forest's walk-through view, at the look's default intensity. The term the
/// world pass reads over open flat ground from eye height is flat at every AO preset: standard
/// deviation at most [`GROUND_SPREAD_MAX`], nothing below [`GROUND_LOWEST`], the bottom rows
/// included. Temporal presets are read after a few frames of history, as Live draws them.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_open_flat_ground_from_eye_height_reads_flat_at_every_ao_preset() {
    let Some(gpu) = gpu() else { return };
    let frames: Vec<AoFrame> = (0..8).map(|i| open_ground_frame(GROUND_SIZE, i)).collect();
    let top = first_ground_row(&frames[0], GROUND_SIZE) + GROUND_ROWS_BELOW_HORIZON;
    let mut problems = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = quality(preset);
        let used = if quality.temporal { &frames[..] } else { &frames[..1] };
        let image = ao::ao_render_images(&gpu, &settings(quality), GROUND_SIZE, used).expect("AO").pop().expect("a term");
        write_evidence(&format!("open-ground-{}", preset.wire()), &grey(&image));
        let texels: Vec<f32> = (top..GROUND_SIZE.1).flat_map(|y| (0..GROUND_SIZE.0).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).collect();
        let mean = texels.iter().sum::<f32>() / texels.len() as f32;
        let spread = (texels.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / texels.len() as f32).sqrt();
        let lowest = texels.iter().copied().fold(1.0, f32::min);
        let edge = (GROUND_SIZE.1 - GROUND_EDGE_ROWS..GROUND_SIZE.1).flat_map(|y| (0..GROUND_SIZE.0).map(move |x| (x, y))).map(|(x, y)| image.at(x, y)).fold(1.0, f32::min);
        eprintln!("{}: open ground mean {mean:.4}, standard deviation {spread:.4}, lowest {lowest:.3}, bottom edge lowest {edge:.3}", preset.wire());
        if spread > GROUND_SPREAD_MAX || lowest < GROUND_LOWEST {
            problems.push(format!("{}: open ground's term varies by {spread:.4}, lowest {lowest:.3} (bottom edge {edge:.3})", preset.wire()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// RQ4 review (visual 6): the thickness knob (`AoParams::params.w`, XeGTAO's thin-occluder
/// compensation) reaches the horizon search: with it a sample far in front of or behind the
/// centre falls off sooner, so the corner's box (an occluder in front of the floor) darkens its
/// crease less than with the default 0, which draws as before.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_thickness_knob_lightens_occlusion_by_samples_off_the_centres_depth() {
    let Some(gpu) = gpu() else { return };
    let frame = corner_frame(EYE, true, facts(0, true), (WIDTH, HEIGHT));
    let mean = |thickness: f32| {
        let settings = AoSettings { thickness, ..settings(quality(QualityPreset::High)) };
        let image = run(&gpu, &settings, std::slice::from_ref(&frame)).remove(0);
        image.visibility.iter().map(|v| f32::from(*v)).sum::<f32>() / image.visibility.len() as f32 / 255.0
    };
    let (plain, thin) = (mean(ao::THICKNESS), mean(4.0));
    eprintln!("mean visibility: thickness {} {plain:.4}, thickness 4 {thin:.4}", ao::THICKNESS);
    assert_eq!(ao::THICKNESS, 0.0, "XeGTAO's default: the heightfield assumption");
    assert!(thin > plain + 0.002, "thin-occluder compensation lightens the occlusion ({plain:.4} -> {thin:.4})");
}

// ---------------------------------------------------------------------------------------------
// A log wall: stacked horizontal cylinders against a ground truth

/// The log wall's logs: radius (the showcase cabin's), courses, and the wall's plane (the axes).
const LOG_RADIUS: f32 = 0.17;
const LOG_COURSES: u32 = 8;
/// The log wall row's render size, eye and AO reach (the showcase's look).
const LOG_WALL_SIZE: (u32, u32) = (512, 288);
const LOG_WALL_EYE: Vec3 = Vec3::new(0.8, 1.4, 4.0);
const LOG_WALL_RADIUS: f32 = 0.9;
/// GTAO's visibility at intensity 1 / its final power (XeGTAO's 2.2): the plain cosine-weighted
/// estimate the ground truth is compared with.
const PLAIN_INTENSITY: f32 = 1.0 / 2.2;
/// Hemisphere rays per ground-truth pixel, and every how many pixels one is cast.
const GROUND_TRUTH_RAYS: u32 = 256;
const GROUND_TRUTH_STRIDE: u32 = 7;

fn log_wall_camera(size: (u32, u32)) -> AoCamera {
    AoCamera {
        view: glam::camera::rh::view::look_at_mat4(LOG_WALL_EYE, Vec3::new(0.0, 1.4, 0.0), Vec3::Y),
        proj: glam::camera::rh::proj::directx::perspective(50f32.to_radians(), size.0 as f32 / size.1 as f32, 100.0, 0.1),
    }
}

/// The nearest hit (distance along `dir`, the log, the normal) of the ray from `origin` with the
/// logs: cylinders along x, centred at y = R + 2Ri on the plane z = 0.
fn hit_logs(origin: Vec3, dir: Vec3) -> Option<(f32, u32, Vec3)> {
    let mut best: Option<(f32, u32, Vec3)> = None;
    for log in 0..LOG_COURSES {
        let centre = glam::Vec2::new(LOG_RADIUS + 2.0 * LOG_RADIUS * log as f32, 0.0);
        let (o, d) = (glam::Vec2::new(origin.y, origin.z) - centre, glam::Vec2::new(dir.y, dir.z));
        let a = d.length_squared();
        if a < 1e-12 {
            continue;
        }
        let b = o.dot(d);
        let disc = b * b - a * (o.length_squared() - LOG_RADIUS * LOG_RADIUS);
        if disc < 0.0 {
            continue;
        }
        let t = (-b - disc.sqrt()) / a;
        if t > 1e-4 && best.is_none_or(|(held, ..)| t < held) {
            let p = origin + dir * t;
            best = Some((t, log, Vec3::new(0.0, p.y - centre.x, p.z).normalize()));
        }
    }
    best
}

/// A log-wall pixel's surface: its point, its normal and its log's course.
type LogHit = (Vec3, Vec3, u32);

/// The log wall from [`LOG_WALL_EYE`] at `size`: device depth and the logs' exact normals.
fn log_wall_frame(size: (u32, u32)) -> (AoFrame, Vec<Option<LogHit>>) {
    let camera = log_wall_camera(size);
    let inverse = (camera.proj * camera.view).inverse();
    let (mut depth, mut normals, mut hits) = (Vec::new(), Vec::new(), Vec::new());
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inverse * ndc;
            let dir = (far.truncate() / far.w - LOG_WALL_EYE).normalize();
            match hit_logs(LOG_WALL_EYE, dir) {
                Some((t, log, n)) => {
                    let p = LOG_WALL_EYE + dir * t;
                    let clip = camera.proj * camera.view * p.extend(1.0);
                    depth.push(clip.z / clip.w);
                    normals.push(n.to_array());
                    hits.push(Some((p, n, log)));
                }
                None => {
                    depth.push(0.0);
                    normals.push([0.0, 1.0, 0.0]);
                    hits.push(None);
                }
            }
        }
    }
    (AoFrame { depth, normals, camera, facts: facts(0, true), motion: Vec::new() }, hits)
}

/// The cosine-weighted share of the hemisphere around `n` at `p` that no other log hides within
/// `reach` (a fixed low-discrepancy set of directions: Hammersley over the disc).
fn ground_truth_visibility(p: Vec3, n: Vec3, reach: f32) -> f32 {
    let tangent = Vec3::X;
    let bitangent = n.cross(tangent);
    let mut open = 0;
    for i in 0..GROUND_TRUTH_RAYS {
        let u = (i as f32 + 0.5) / GROUND_TRUTH_RAYS as f32;
        let v = (i.reverse_bits() as f64 / 4_294_967_296.0) as f32;
        let (r, phi) = (u.sqrt(), std::f32::consts::TAU * v);
        let dir = (tangent * r * libm::cosf(phi) + bitangent * r * libm::sinf(phi) + n * (1.0 - u).sqrt()).normalize();
        let start = p + n * 1e-3;
        if hit_logs(start, dir).is_none_or(|(t, ..)| t > reach) {
            open += 1;
        }
    }
    open as f32 / GROUND_TRUTH_RAYS as f32
}

/// Gate finding 01 (the showcase's shaded cabin walls 43% darker with AO): the estimate is right on
/// a log wall, so the darkening is the look's strength (XeGTAO's final power 2.2 at intensity 1),
/// not GTAO. Stacked logs seen from the front, GTAO at its plain power (intensity 1 / 2.2) against
/// a ray-cast ground truth of the same reach, over the middle courses: the means agree (the logs'
/// grooves hide about a fifth of the sky).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_gtao_on_a_log_wall_matches_the_ray_cast_ground_truth() {
    let Some(gpu) = gpu() else { return };
    let (frame, hits) = log_wall_frame(LOG_WALL_SIZE);
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let settings = AoSettings { radius: LOG_WALL_RADIUS, intensity: PLAIN_INTENSITY, ..settings(quality(preset)) };
        let reach = LOG_WALL_RADIUS * 1.457;
        let image = ao::ao_render_images(&gpu, &settings, LOG_WALL_SIZE, std::slice::from_ref(&frame)).expect("AO").remove(0);
        write_evidence(&format!("log-wall-{}", preset.wire()), &grey(&image));
        let (mut gtao, mut truth, mut count) = (0.0, 0.0, 0);
        for (index, hit) in hits.iter().enumerate() {
            let Some((p, n, log)) = hit else { continue };
            let (x, y) = (index as u32 % LOG_WALL_SIZE.0, index as u32 / LOG_WALL_SIZE.0);
            if !(2..LOG_COURSES - 2).contains(log) || !(index as u32).is_multiple_of(GROUND_TRUTH_STRIDE) || !(64..LOG_WALL_SIZE.0 - 64).contains(&x) {
                continue;
            }
            gtao += image.at(x, y);
            truth += ground_truth_visibility(*p, *n, reach);
            count += 1;
        }
        let (gtao, truth) = (gtao / count as f32, truth / count as f32);
        eprintln!("{}: GTAO {gtao:.3}, ground truth {truth:.3} over {count} pixels", preset.wire());
        assert!((gtao - truth).abs() <= 0.08, "{}: GTAO {gtao:.3} against the ground truth {truth:.3}", preset.wire());
    }
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.6: AO's own history (P3/S2 precision, fetch, motion and clamp; P4 slices
// instead of steps; RC-05 a dynamic-resolution step keeps it)

/// The most a floor's AO may still differ from its converged value three frames after a turning
/// box stopped, mean over the floor the box's occlusion swept in its last turning frames
/// (P2-0.6: "less than 2% luma residue after 3 frames").
const TRAIL_RESIDUE_MAX: f32 = 0.02;
/// The turning frames whose poses make the swept floor: the last ones before the box stopped
/// (older poses' occlusion has faded from any history by then).
const TRAIL_POSES: u64 = 5;
/// Frames the box turns for, degrees a frame, and the frames after it stops before the row reads.
const TURN_FRAMES: u64 = 20;
const TURN_DEGREES_PER_FRAME: f32 = 5.0;
const STOPPED_FRAMES: u64 = 3;
/// Frames the converged references take.
const CONVERGE_FRAMES: u64 = 128;
/// A floor texel belongs to the swept floor when one of the box's last poses darkened it this far
/// below its converged value at the box's last pose.
const SWEPT_DARKENING: f32 = 0.05;
/// The turning box: its centre on the floor (its bottom on y = 0) and half extent.
const TURN_CENTRE: Vec3 = Vec3::new(0.0, 0.35, -0.4);
const TURN_HALF: f32 = 0.35;

/// What a pixel of the turning-box scene shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shows {
    Sky,
    Floor,
    Box,
}

/// The ray's nearest hit with the turning box at `degrees` about +Y, and its world normal.
fn hit_turned_box(origin: Vec3, dir: Vec3, degrees: f32) -> Option<(f32, Vec3)> {
    let turn = glam::Quat::from_rotation_y(degrees.to_radians());
    let (o, d) = (turn.inverse() * (origin - TURN_CENTRE), turn.inverse() * dir);
    let (mut near, mut far, mut normal) = (f32::NEG_INFINITY, f32::INFINITY, Vec3::ZERO);
    for axis in 0..3 {
        let inv = 1.0 / d[axis];
        let (a, b) = ((-TURN_HALF - o[axis]) * inv, (TURN_HALF - o[axis]) * inv);
        let (t0, t1) = if a < b { (a, b) } else { (b, a) };
        if t0 > near {
            near = t0;
            normal = Vec3::ZERO;
            normal[axis] = -d[axis].signum();
        }
        far = far.min(t1);
    }
    (near <= far && near > 0.0).then_some((near, turn * normal))
}

/// The turning-box scene (a floor and the box at `degrees`) from [`EYE`] at render size, with the
/// motion the prepass would write (the box turned by `step` degrees since last frame; the camera is
/// still) and what each pixel shows.
fn turning_frame(degrees: f32, step: f32, facts: AoFrameFacts, size: (u32, u32)) -> (AoFrame, Vec<Shows>) {
    let camera = camera(EYE);
    let camera = AoCamera { proj: glam::camera::rh::proj::directx::perspective(50f32.to_radians(), size.0 as f32 / size.1 as f32, 100.0, 0.1), ..camera };
    let view_proj = camera.proj * camera.view;
    let inverse = view_proj.inverse();
    let ndc_of = |p: Vec3| {
        let clip = view_proj * p.extend(1.0);
        glam::Vec2::new(clip.x / clip.w, clip.y / clip.w)
    };
    let (mut depth, mut normals, mut motion, mut shows) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inverse * ndc;
            let dir = (far.truncate() / far.w - EYE).normalize();
            let floor = (dir.y < 0.0).then(|| -EYE.y / dir.y);
            let on_box = hit_turned_box(EYE, dir, degrees).filter(|(t, _)| floor.is_none_or(|f| *t < f));
            let (t, n, kind) = match (on_box, floor) {
                (Some((t, n)), _) => (t, n, Shows::Box),
                (None, Some(t)) => (t, Vec3::Y, Shows::Floor),
                (None, None) => (0.0, Vec3::Y, Shows::Sky),
            };
            shows.push(kind);
            normals.push(n.to_array());
            if kind == Shows::Sky {
                depth.push(0.0);
                motion.push([0.0, 0.0]);
                continue;
            }
            let p = EYE + dir * t;
            let clip = view_proj * p.extend(1.0);
            depth.push(clip.z / clip.w);
            let before = if kind == Shows::Box { TURN_CENTRE + glam::Quat::from_rotation_y((-step).to_radians()) * (p - TURN_CENTRE) } else { p };
            motion.push((ndc_of(p) - ndc_of(before)).to_array());
        }
    }
    (AoFrame { depth, normals, camera, facts, motion }, shows)
}

/// What render pixel stands for AO texel `texel` of an AO image of `ao` size at `render` size (the
/// one under its centre).
fn render_pixel(texel: (u32, u32), ao: (u32, u32), render: (u32, u32)) -> (u32, u32) {
    let block = ((render.0 / ao.0).max(1), (render.1 / ao.1).max(1));
    ((texel.0 * block.0 + block.0 / 2).min(render.0 - 1), (texel.1 * block.1 + block.1 / 2).min(render.1 - 1))
}

/// The turning box's AO trail at `preset`, with or without the prepass's motion: the mean residue
/// over the swept floor (converged minus the frame three frames after the box stopped), the worst
/// 3x3 window of it, and the swept floor's texels.
fn turning_trail(gpu: &Gpu, preset: QualityPreset, with_motion: bool) -> (f32, f32, usize) {
    let size = (WIDTH, HEIGHT);
    let settings = settings(quality(preset));
    let last = TURN_FRAMES as f32 * TURN_DEGREES_PER_FRAME;
    let strip = |(frame, shows): (AoFrame, Vec<Shows>)| (if with_motion { frame } else { AoFrame { motion: Vec::new(), ..frame } }, shows);
    // The box turns, then stands still at its last pose.
    let mut turning: Vec<AoFrame> = (0..=TURN_FRAMES).map(|i| strip(turning_frame(i as f32 * TURN_DEGREES_PER_FRAME, TURN_DEGREES_PER_FRAME, facts(i, i == 0), size)).0).collect();
    turning.extend((1..=STOPPED_FRAMES).map(|i| strip(turning_frame(last, 0.0, facts(TURN_FRAMES + i, false), size)).0));
    let after = run(gpu, &settings, &turning).pop().expect("a term");
    // The same last pose, converged from a reset.
    let shows = turning_frame(last, 0.0, facts(0, true), size).1;
    let converging: Vec<AoFrame> = (0..CONVERGE_FRAMES).map(|i| turning_frame(last, 0.0, facts(i, i == 0), size).0).collect();
    let converged = run(gpu, &settings, &converging).pop().expect("a term");
    write_evidence(&format!("turning-{}-{}-after", preset.wire(), if with_motion { "motion" } else { "camera" }), &grey(&after));
    write_evidence(&format!("turning-{}-converged", preset.wire()), &grey(&converged));
    // Where the box's last poses darkened the floor: each pose's own reset frame.
    let poses: Vec<AoImage> = (TURN_FRAMES - TRAIL_POSES..TURN_FRAMES).map(|i| run(gpu, &settings, std::slice::from_ref(&turning_frame(i as f32 * TURN_DEGREES_PER_FRAME, 0.0, facts(0, true), size).0)).remove(0)).collect();
    let ao = after.size;
    let floor = |x: u32, y: u32| {
        let (px, py) = render_pixel((x, y), ao, size);
        shows[(py * size.0 + px) as usize] == Shows::Floor
    };
    let swept: Vec<(u32, u32)> = (1..ao.1 - 1)
        .flat_map(|y| (1..ao.0 - 1).map(move |x| (x, y)))
        .filter(|&(x, y)| floor(x, y) && poses.iter().any(|pose| pose.at(x, y) < converged.at(x, y) - SWEPT_DARKENING))
        .collect();
    let residue = |x: u32, y: u32| converged.at(x, y) - after.at(x, y);
    let mean = swept.iter().map(|&(x, y)| residue(x, y)).sum::<f32>() / swept.len().max(1) as f32;
    let worst = swept.iter().map(|&(x, y)| (y - 1..=y + 1).flat_map(|wy| (x - 1..=x + 1).map(move |wx| (wx, wy))).map(|(wx, wy)| residue(wx, wy)).sum::<f32>() / 9.0).fold(0.0, f32::max);
    (mean, worst, swept.len())
}

/// P2-0.6 (P3/S2): AO's own history read nearest, reprojected through the camera alone and never
/// clamped kept a moving object's old occlusion on the floor it left: the floor keeps its depth, so
/// its history passed the depth test and faded as 0.9^n (a dark trail about 0.35 s long behind the
/// template's turning cube). A box turning on the floor, then still: three frames after it stops,
/// the floor its occlusion swept is within [`TRAIL_RESIDUE_MAX`] of the converged term, with the
/// prepass's motion (TAA frames) and without it (camera reprojection).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_turning_box_leaves_no_ao_trail_on_the_floor() {
    let Some(gpu) = gpu() else { return };
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        for with_motion in [true, false] {
            let (mean, worst, texels) = turning_trail(&gpu, preset, with_motion);
            let source = if with_motion { "motion" } else { "camera" };
            eprintln!("{} ({source}): swept floor {texels} texels, residue mean {mean:.4}, worst 3x3 {worst:.4}", preset.wire());
            assert!(texels > 20, "{}: the box sweeps the floor ({texels} texels)", preset.wire());
            if mean.abs() > TRAIL_RESIDUE_MAX {
                problems.push(format!("{} ({source}): the floor keeps {mean:.4} of the box's old occlusion (worst 3x3 {worst:.4})", preset.wire()));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Crease windows of the corner scene: the floor-wall crease and the box's front crease.
fn crease_means(frame: &AoFrame, image: &AoImage) -> [f32; 2] {
    let wall = ao_pixel(frame, image.size, Vec3::new(1.8, 0.02, WALL_Z + 0.02));
    let front = ao_pixel(frame, image.size, Vec3::new(0.0, 0.02, BOX_MAX.z + 0.02));
    [window_mean(image, wall, 1), window_mean(image, front, 1)]
}

/// How far a running history's crease may sit from reset frames' (every slice and step at once),
/// each over the frames it averages: about two levels.
const RUNNING_CREASE_DRIFT_MAX: f32 = 0.008;
/// Frames each side of the comparison averages (reset frames on as many noise keys).
const DRIFT_FRAMES: u64 = 64;

/// The crease means of `images`, averaged.
fn mean_creases(frame: &AoFrame, images: &[AoImage]) -> [f32; 2] {
    std::array::from_fn(|c| images.iter().map(|image| crease_means(frame, image)[c]).sum::<f32>() / images.len() as f32)
}

/// P2-0.6 (P4): a frame that blends history took every other step of each slice, and a slice's
/// horizon is the maximum over its steps, so each half saw a lower horizon than the whole: the
/// running history was lighter than the reset frame (darkening on a cut, then relaxing lighter).
/// Every frame now takes every step of fewer slices, resets too (XeGTAO's final power is convex,
/// so an estimate of more slices draws darker), and the history adds no bias of its own (its
/// bilinear read at the texels' own positions, its clamp): on a still corner the running
/// history's creases, mean of its last [`DRIFT_FRAMES`] frames, sit within
/// [`RUNNING_CREASE_DRIFT_MAX`] of reset frames' (on as many noise keys) at high and ultra.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_running_ao_history_is_as_dark_as_a_reset_frame() {
    let Some(gpu) = gpu() else { return };
    let size = (WIDTH, HEIGHT);
    let frames: Vec<AoFrame> = (0..CONVERGE_FRAMES).map(|i| corner_frame(EYE, true, facts(i, i == 0), size)).collect();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let settings = settings(quality(preset));
        let images = run(&gpu, &settings, &frames);
        let resets: Vec<AoImage> = (0..DRIFT_FRAMES).map(|i| run(&gpu, &settings, std::slice::from_ref(&corner_frame(EYE, true, facts(i, true), size))).remove(0)).collect();
        let reset = mean_creases(&frames[0], &resets);
        let running = mean_creases(&frames[0], &images[images.len() - DRIFT_FRAMES as usize..]);
        eprintln!("{}: creases reset {reset:?}, running {running:?}", preset.wire());
        for c in 0..2 {
            if (running[c] - reset[c]).abs() > RUNNING_CREASE_DRIFT_MAX {
                problems.push(format!("{} crease {c}: running {:.4} against the reset frame's {:.4}", preset.wire(), running[c], reset[c]));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The most a dynamic-resolution step frame's crease noise may be, as a share of a fresh frame's at
/// the new size (no history, what the step drew before), each against the new size's converged
/// term (RMS over the crease's 5x5 texels, the mean offset taken out).
const STEP_NOISE_SHARE_MAX: f32 = 0.6;

/// The RMS of `image` against `converged` over the 5x5 texels around `at`, their mean offset taken out.
fn crease_noise(image: &AoImage, converged: &AoImage, at: (u32, u32)) -> f32 {
    let diffs: Vec<f32> = (at.1 - 2..=at.1 + 2).flat_map(|y| (at.0 - 2..=at.0 + 2).map(move |x| (x, y))).map(|(x, y)| image.at(x, y) - converged.at(x, y)).collect();
    let mean = diffs.iter().sum::<f32>() / diffs.len() as f32;
    (diffs.iter().map(|d| (d - mean) * (d - mean)).sum::<f32>() / diffs.len() as f32).sqrt()
}

/// P2-0.6 (RC-05): a dynamic-resolution step remade AO's targets at the new size and started its
/// history over, so for the frames it needs to converge the term showed its raw per-frame noise:
/// contact areas darkened and lightened at every DRS step (every 0.5-4 s under borderline load).
/// AO keeps the previous size's history for the step frame and reads it in uv: at high and ultra,
/// on a render-size step from 256x144 to 224x126, the step frame's creases carry at most
/// [`STEP_NOISE_SHARE_MAX`] of a fresh frame's noise against the new size's converged term.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_dynamic_resolution_step_keeps_ao_history() {
    let Some(gpu) = gpu() else { return };
    let (before, after) = ((WIDTH, HEIGHT), (224, 126));
    let mut frames: Vec<((u32, u32), AoFrame)> = (0..CONVERGE_FRAMES).map(|i| (before, corner_frame(EYE, true, facts(i, i == 0), before))).collect();
    frames.extend((0..4).map(|i| (after, corner_frame(EYE, true, facts(CONVERGE_FRAMES + i, false), after))));
    let sized: Vec<((u32, u32), &AoFrame)> = frames.iter().map(|(size, frame)| (*size, frame)).collect();
    let step = CONVERGE_FRAMES as usize;
    let converging: Vec<AoFrame> = (0..CONVERGE_FRAMES).map(|i| corner_frame(EYE, true, facts(i, i == 0), after)).collect();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let settings = settings(quality(preset));
        let images = ao::ao_term_images_sized(&gpu, &settings, &sized).expect("AO");
        let converged_after = ao::ao_term_images(&gpu, &settings, after, &converging).expect("AO").pop().expect("a term");
        let fresh = run_at(&gpu, &settings, after, &frames[step].1);
        write_evidence(&format!("scale-step-{}-before", preset.wire()), &grey(&images[step - 1]));
        write_evidence(&format!("scale-step-{}-at", preset.wire()), &grey(&images[step]));
        for (c, world) in [Vec3::new(1.8, 0.02, WALL_Z + 0.02), Vec3::new(0.0, 0.02, BOX_MAX.z + 0.02)].into_iter().enumerate() {
            let at = ao_pixel(&frames[step].1, images[step].size, world);
            let (carried, restarted) = (crease_noise(&images[step], &converged_after, at), crease_noise(&fresh, &converged_after, at));
            eprintln!("{} crease {c}: noise at the step {carried:.4}, a fresh frame's {restarted:.4}", preset.wire());
            if carried > restarted * STEP_NOISE_SHARE_MAX {
                problems.push(format!("{} crease {c}: noise at the step {carried:.4}, a fresh frame's {restarted:.4}", preset.wire()));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// P2-0.6 (P3/S2): AO's own history is 16-bit float (8 bits at weight 0.9 cannot move by less than
/// half a level a frame, so it froze within 5/255 of the true value: fixed blotches on a still
/// camera). The term the history ping-pongs with is the same format; the term brought to the render
/// size for the world pass stays 8-bit.
#[test]
fn ao_history_is_sixteen_bit_float() {
    use genex_render::target_pool::TargetDesc;
    use wgpu::TextureFormat;
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = quality(preset);
        assert_eq!(ao::history_format(&quality), TextureFormat::Rgba16Float, "{}: visibility and the bent normal", preset.wire());
        let targets = ao::targets((1920, 1080), &quality);
        let format = |label: &str| targets.iter().find(|t| t.label == label).map(|t| t.format);
        assert_eq!(format(ao::AO_LABEL), Some(TextureFormat::Rgba16Float), "{}: the term the history ping-pongs with", preset.wire());
        assert_eq!(format(ao::HISTORY_LABEL), Some(TextureFormat::Rgba16Float));
        if let Some(full) = format(ao::AO_FULL_LABEL) {
            assert_eq!(full, ao::term_format(&quality), "{}: the world pass's term stays 8-bit", preset.wire());
        }
        let (frame, history) = ao::target_bytes((1920, 1080), &quality);
        assert_eq!(frame + history, targets.iter().map(TargetDesc::bytes).sum::<u64>());
    }
    let mut one_slice = quality(QualityPreset::Medium);
    one_slice.temporal = true;
    assert_eq!(ao::history_format(&one_slice), TextureFormat::R16Float, "visibility alone");
    assert_eq!(ao::history_format(&quality(QualityPreset::Medium)), ao::term_format(&quality(QualityPreset::Medium)), "no history: the term's own");
}

/// Pass 2, RC-05: which resets start the renderer's own histories (AO's, the shadow cadence's, the
/// meshlet visibility's) over: every reason TAA's rule starts over on, never a dynamic-resolution
/// step (whose frame restarts the index all the same).
#[test]
fn a_scale_step_keeps_the_renderers_own_histories() {
    use genex_render::settle::{FrameHistory, HistoryReset, HistorySet};
    let at = |frame_index: u64, reset: Option<HistoryReset>| FrameHistory { set: HistorySet::Live, frame_index, ticks: 1, reset, settle: None };
    assert!(!at(0, Some(HistoryReset::ScaleStep)).drops_history(), "a dynamic-resolution step keeps them");
    for reason in [HistoryReset::CameraCut, HistoryReset::Resize, HistoryReset::Settings, HistoryReset::DeviceRecreated, HistoryReset::Rewind, HistoryReset::Capture] {
        assert!(at(0, Some(reason)).drops_history(), "{reason:?} starts them over");
    }
    assert!(at(0, None).drops_history(), "a first frame has none to keep");
    assert!(!at(5, None).drops_history(), "a running frame keeps them");
}

/// The Live renderer's output size for the scale-step row.
const STEP_OUTPUT: (u32, u32) = (256, 144);
/// Live frames before the step, the frames before it the row reads, and the frames after it the
/// row reads (recorded: the new size's AO settles over them).
const STEP_WARM_FRAMES: u64 = 40;
const STEP_BEFORE_FRAMES: usize = 10;
const STEP_AFTER_FRAMES: u64 = 30;
/// The most the step frame may move the crease's luma (0..255) through AO (the change with AO on
/// less the same step's change with AO off, from the mean of the frames before the step): "a DRS
/// step does not visibly reset AO (luma change at the step frame below 1 level)".
const STEP_AO_LUMA_MAX: f64 = 1.0;

/// A floor and a cube lit by ambient light alone (AO is what darkens the crease at its foot).
fn ambient_cube_frame(tick: u64) -> genex_render::immediate::ImmediateFrame {
    use genex_render::immediate::ImmediateFrame;
    use genex_render::scene::translation;
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 1.6, 3.0], [0.0, 0.3, 0.0]), [40, 50, 70, 255]);
    let lighting = frame.lighting_mut();
    lighting.sun_intensity = 0.0;
    lighting.ambient = [255, 255, 255];
    lighting.ambient_intensity = 1.0;
    frame.cube(translation(0.0, 0.5, 0.0), [200, 200, 200, 255]);
    frame.cube(scaled([0.0, -0.1, 0.0], [12.0, 0.2, 10.0]), [200, 200, 200, 255]);
    frame.set_tick(tick);
    frame
}

/// Mean luma (0..255) of the 7x7 window around `at`.
fn window_luma(capture: &Capture, at: (u32, u32)) -> f64 {
    let bgra = capture.bgra();
    let (mut sum, mut count) = (0.0, 0);
    for y in at.1 - 3..=at.1 + 3 {
        for x in at.0 - 3..=at.0 + 3 {
            let i = ((y * capture.width() + x) * 4) as usize;
            sum += 0.0722 * f64::from(bgra[i]) + 0.7152 * f64::from(bgra[i + 1]) + 0.2126 * f64::from(bgra[i + 2]);
            count += 1;
        }
    }
    sum / f64::from(count)
}

/// Live frames of the ambient cube at the high preset, AO `on`, stepping the render scale from 1
/// to 0.75 after [`STEP_WARM_FRAMES`]: the crease's luma on the last [`STEP_BEFORE_FRAMES`] frames
/// before the step and on each frame from it on.
fn crease_lumas_across_a_step(gpu: &Gpu, on: bool) -> (Vec<f64>, Vec<f64>) {
    use genex_render::device_class::{FormFactor, PerformanceTier};
    use genex_render::immediate::ImmediateFrame;
    use genex_render::settings::SceneFormat;
    use genex_render::{FrameRenderer, RenderOptions};
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let mut quality = preset_quality(QualityPreset::High, class);
    if !on {
        quality.ao.resolution = AoResolution::Off;
    }
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut frames = FrameRenderer::new(gpu, STEP_OUTPUT.0, STEP_OUTPUT.1, options).expect("renderer");
    let part1 = frames.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    let crease = {
        let probe = ambient_cube_frame(0);
        let camera = probe.scene().camera;
        let view = glam::camera::rh::view::look_at_mat4(Vec3::from(camera.eye), Vec3::from(camera.target), Vec3::from(camera.up));
        let proj = glam::camera::rh::proj::directx::perspective(camera.fovy_degrees.to_radians(), STEP_OUTPUT.0 as f32 / STEP_OUTPUT.1 as f32, 100.0, 0.1);
        let clip = proj * view * Vec4::new(0.0, 0.04, 0.56, 1.0);
        (((clip.x / clip.w * 0.5 + 0.5) * STEP_OUTPUT.0 as f32) as u32, ((0.5 - clip.y / clip.w * 0.5) * STEP_OUTPUT.1 as f32) as u32)
    };
    let live = |frames: &mut FrameRenderer, tick: u64| {
        let frame: ImmediateFrame = ambient_cube_frame(tick);
        frames.render(gpu, &frame, CullPath::Gpu, None).expect("a Live frame");
        window_luma(&frames.capture(gpu).expect("capture"), crease)
    };
    let all: Vec<f64> = (0..STEP_WARM_FRAMES).map(|tick| live(&mut frames, tick)).collect();
    frames.renderer_mut().set_render_scale(0.75);
    let after = (0..STEP_AFTER_FRAMES).map(|i| live(&mut frames, STEP_WARM_FRAMES + i)).collect();
    (all[all.len() - STEP_BEFORE_FRAMES..].to_vec(), after)
}

/// Pass 2, RC-05 (end to end): every dynamic-resolution step reset AO's history (and the meshlet
/// visibility and the shadow cadence), so AO's noise burst at each step under borderline load:
/// contact areas blinked every 0.5-4 s. Live frames at the high preset stepping the render scale
/// from 1 to 0.75: what AO changes in the crease at the cube's foot on the step frame (the change
/// with AO on less the same step's change with AO off, each from the mean of the frames before the
/// step) stays within [`STEP_AO_LUMA_MAX`] levels. The frames after it are recorded: the new size
/// draws AO from fewer pixels and settles where it does.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_render_scale_step_does_not_reset_ao_in_live_frames() {
    let Some(gpu) = gpu() else { return };
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    let (on_before, on_after) = crease_lumas_across_a_step(&gpu, true);
    let (off_before, off_after) = crease_lumas_across_a_step(&gpu, false);
    let (on_was, off_was) = (mean(&on_before), mean(&off_before));
    let changes: Vec<f64> = on_after.iter().zip(&off_after).map(|(on, off)| (on - on_was) - (off - off_was)).collect();
    let settled = mean(&changes[changes.len() - 10..]);
    let noise = on_before.iter().map(|l| (l - on_was).abs()).fold(0.0_f64, f64::max);
    eprintln!("crease luma: AO on {on_before:.2?} -> {on_after:.2?}; off {off_was:.2} -> {off_after:.2?}");
    eprintln!("AO's change {changes:.2?}, settled {settled:.2}, running noise before the step {noise:.2}");
    assert!(on_was + 3.0 < off_was, "AO darkens the crease ({on_was:.2} with, {off_was:.2} without)");
    assert!(changes[0].abs() <= STEP_AO_LUMA_MAX, "the step frame moves the crease by {:.2} levels through AO ({changes:.2?})", changes[0]);
}
