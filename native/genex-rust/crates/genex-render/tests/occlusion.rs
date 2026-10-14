//! R2.4: meshlet culling with two-pass Hi-Z occlusion, the three-dispatch ordered compaction and
//! indexed vertex-pulling draws.
//!
//! - The meshlet path draws the instance path's picture (tolerance 0 at 1x without MSAA), on the
//!   legacy and the HDR scene, with and without occlusion, shadows drawn by meshlet casters, and
//!   with the world pass testing `Equal` against a meshlet prepass.
//! - A meshlet prepass writes the instance prepass's depth bit for bit (invariance).
//! - Pass 2 re-tests every candidate: an object visible in frame N and fully occluded in N+1
//!   leaves the visible set; an object behind a wall from the first frame is never drawn.
//! - The GPU's visible lists for a 100k-meshlet batch equal the CPU reference ([`reference`]),
//!   on both depth conventions, over 5 views; the cull's cost is recorded at 5 and 9 views.
//! - Settled captures are identical on two runs and never move Live's history, also when the
//!   capture's quality draws no meshlets or no occlusion; a camera cut starts Live's over.
//! - Under the default MSAA world pass (a preset's), occlusion stands down and the meshlet path
//!   draws the instance path's picture frame by frame through a moving camera (R2 review).
//! - Adding an instance of a mesh drawn before the clustered ones keeps the history.
//! - A quality without meshlets clusters nothing and holds no meshlet bytes; they go again when
//!   meshlets go off.
//! - The `meshlets/forest` golden.
//! - The stress rows at 1080p high: an occlusion-heavy forest behind a wall and an open field,
//!   instance path against meshlets and meshlets with occlusion (GPU p50/p95, emitted indices).
//!   The acceptance gates (>= 30% saving, <= 5% open overhead) hold on immediate-mode GPUs; a
//!   tile GPU records them for the class defaults and must only see occlusion pay in the occluded
//!   scene.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test occlusion -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames (raw BGRA, top row first);
//! `GENEX_PERF_OUT` receives the cost rows as JSON lines; `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites
//! the golden.

use std::path::{Path as FsPath, PathBuf};

use genex_render::capture::Capture;
use genex_render::cull::{frustum_planes, frustum_planes_for};
use genex_render::hiz::{self, HizReduce};
use genex_render::instance::instance_row;
use genex_render::layout::{GpuCullViews, GpuFrame, GpuMeshlet, GpuMeshletInstance};
use genex_render::mesh::{MeshData, Vertex};
use genex_render::device_loss::Resilient;
use genex_render::meshlet::{self, MeshletLibrary, MeshletSet, pack_triangle};
use genex_render::meshlet_cull::{CaseHiz, CullCase, CullOutcome, CullPass, VisibilityBits, case_gpu_ms, reference, reference_visible, run_case};
use genex_render::scene::{CameraDesc, Material, MeshId, MeshLibrary, MeshletState, PointLight, Scene, scaled, translation};
use genex_render::device_class::DeviceClass;
use genex_render::immediate::ImmediateFrame;
use genex_render::presets::preset_quality;
use genex_render::settings::{Meshlets, Quality, QualityPreset, RenderFeature, SceneFormat};
use genex_render::{CullPath, FrameRenderer, Gpu, RenderOptions, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (the golden suites' tolerance), and this
/// many pixels (of 9216) may exceed it (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The occlusion-heavy stress scene's saving the acceptance asks of the meshlet path at high.
const STRESS_SAVING_MIN: f32 = 0.30;
/// The no-occlusion scene's overhead the acceptance allows.
const OPEN_OVERHEAD_MAX: f32 = 0.05;
/// Vertex invocations (counted from emitted indices) over the indexed instance path's.
const INVOCATIONS_RATIO_MAX: f32 = 1.3;

// ---------------------------------------------------------------------------------------------
// Fixtures

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

fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

fn write_perf(row: &str) {
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
}

/// A unit sphere of `rings` × `segments` quads (two triangles each), wound like `MeshData::sphere`.
fn dense_sphere(rings: u32, segments: u32) -> MeshData {
    let mut mesh = MeshData::default();
    for ring in 0..=rings {
        let theta = std::f32::consts::PI * ring as f32 / rings as f32;
        let (sin_theta, cos_theta) = (libm::sinf(theta), libm::cosf(theta));
        for segment in 0..=segments {
            let phi = std::f32::consts::TAU * segment as f32 / segments as f32;
            let (sin_phi, cos_phi) = (libm::sinf(phi), libm::cosf(phi));
            let n = [sin_theta * cos_phi, cos_theta, -sin_theta * sin_phi];
            let tangent = [-sin_phi, 0.0, -cos_phi, 1.0];
            let uv = [segment as f32 / segments as f32, ring as f32 / rings as f32];
            mesh.vertices.push(Vertex { position: n, normal: n, uv, tangent });
        }
    }
    let row = segments + 1;
    for ring in 0..rings {
        for segment in 0..segments {
            let a = ring * row + segment;
            let b = a + row;
            mesh.indices.extend([a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    mesh
}

/// The scene's big meshes: a tree crown (3 840 triangles) and a boulder (2 304), both clustered at
/// the default `min_triangles` (2 048).
struct Meshes {
    crown: MeshId,
    boulder: MeshId,
}

fn meshes(renderer: &mut Renderer, gpu: &Gpu) -> Meshes {
    let ids = renderer.add_meshes(gpu, vec![dense_sphere(40, 48), dense_sphere(32, 36)]).expect("meshes");
    Meshes { crown: ids[0], boulder: ids[1] }
}

/// The scene path a renderer draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScenePath {
    Legacy,
    Hdr,
}

/// How a renderer draws the clustered meshes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Variant {
    path: ScenePath,
    meshlets: bool,
    occlusion: bool,
    /// The world pass's `Equal` reuse forced (None: by device).
    equal: Option<bool>,
}

fn quality(variant: Variant) -> Quality {
    let mut quality = Quality::off();
    if variant.path == ScenePath::Hdr {
        quality.hdr = true;
        quality.tonemap = true;
        quality.exposure = true;
    }
    quality.set_feature(RenderFeature::Meshlets, variant.meshlets);
    if variant.occlusion {
        quality.set_feature(RenderFeature::Occlusion, true);
        quality.set_feature(RenderFeature::Prepass, true);
    }
    if variant.equal.is_some() {
        quality.set_feature(RenderFeature::Prepass, true);
    }
    quality
}

fn renderer(gpu: &Gpu, variant: Variant, size: (u32, u32)) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa: false }).expect("renderer");
    if variant.path == ScenePath::Hdr {
        renderer.set_scene_format(SceneFormat::Rgba16Float);
    }
    renderer.set_quality(&quality(variant));
    renderer.set_equal_depth_reuse(variant.equal);
    if variant.equal.is_some() {
        // Something must ask for the prepass for `Equal` to have a depth to test.
        renderer.set_prepass_demand(genex_render::prepass::ExtensionDemand { custom_inputs: genex_render::abi::RenderInputs::DEPTH, ..Default::default() });
    }
    renderer
}

/// Crowns on cube trunks at several depths, overlapping on screen, boulders, a ground, a sun with
/// shadows and a point light.
fn forest(meshes: &Meshes) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 9.0], [0.0, 1.2, 0.0]), [96, 128, 170, 255]);
    scene.lighting.shadows = true;
    scene.lighting.points.push(PointLight { position: [1.5, 2.5, 3.0], color: [255, 220, 180], intensity: 3.0, range: 8.0 });
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -4.0], [30.0, 0.2, 30.0]), Material::color([110, 150, 90, 255]));
    for i in 0..18 {
        let (x, z) = ((i % 6) as f32 * 1.9 - 4.8, -((i / 6) as f32) * 2.6 + 1.0 - (i % 2) as f32 * 0.7);
        let height = 1.1 + (i % 3) as f32 * 0.35;
        scene.draw(MeshId::CUBE, scaled([x, height * 0.5, z], [0.18, height, 0.18]), Material::color([110, 80, 50, 255]));
        let tone = [40 + (i * 9 % 60) as u8, 120 + (i * 13 % 70) as u8, 50, 255];
        scene.draw(meshes.crown, scaled([x, height + 0.45, z], [0.8, 0.95, 0.8]), Material::color(tone).with_pbr(0.0, 0.7));
    }
    for i in 0..5 {
        let x = i as f32 * 1.7 - 3.4;
        scene.draw(meshes.boulder, scaled([x, 0.25, 2.6 - i as f32 * 0.4], [0.5, 0.35, 0.45]), Material::color([140, 135, 130, 255]).with_pbr(0.1, 0.5));
    }
    scene
}

/// Draw `scene` `frames` times (the visibility history runs on) and capture the last.
fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u32) -> Capture {
    for frame in 0..frames {
        renderer.set_frame_index(u64::from(frame));
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// Pixels that differ at all, and the worst channel difference.
fn differing(a: &Capture, b: &Capture) -> (usize, u8) {
    let mut count = 0;
    let mut worst = 0u8;
    for (p, q) in a.bgra().chunks(4).zip(b.bgra().chunks(4)) {
        let diff = p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        count += usize::from(diff > 0);
    }
    (count, worst)
}

/// `set` with its meshlets in reverse order (offsets relaid): a valid set that differs from the
/// runtime clusterizer's, standing in for the importer's (R2.3's `genex_meshlets`).
fn reversed(set: &MeshletSet) -> MeshletSet {
    let mut out = MeshletSet::default();
    for meshlet in set.meshlets.iter().rev() {
        let vertices = meshlet.vertex_offset as usize..(meshlet.vertex_offset + meshlet.vertex_count) as usize;
        let triangles = meshlet.triangle_offset as usize..(meshlet.triangle_offset + meshlet.triangle_count) as usize;
        out.meshlets.push(GpuMeshlet { vertex_offset: out.vertices.len() as u32, triangle_offset: out.triangles.len() as u32, ..*meshlet });
        out.vertices.extend_from_slice(&set.vertices[vertices]);
        out.triangles.extend_from_slice(&set.triangles[triangles]);
    }
    out
}

/// The scene's big meshes, each with an imported set ([`reversed`] of the runtime one).
fn imported_meshes() -> Vec<(MeshData, Option<MeshletSet>)> {
    [dense_sphere(40, 48), dense_sphere(32, 36)]
        .into_iter()
        .map(|mesh| {
            let positions: Vec<[f32; 3]> = mesh.vertices.iter().map(|v| v.position).collect();
            let set = meshlet::build(&mesh.indices, &positions).expect("clusters");
            let imported = reversed(&set);
            assert_ne!(imported, set, "the stand-in differs from the runtime set");
            (mesh, Some(imported))
        })
        .collect()
}

/// The CPU library a renderer given `parts` under `setting` must hold.
fn library_of(setting: Meshlets, parts: &[(MeshData, Option<MeshletSet>)]) -> MeshLibrary {
    let mut library = MeshLibrary::with_meshlets(setting);
    for (mesh, set) in parts {
        library.add_with_meshlets(mesh.clone(), set.clone()).expect("added");
    }
    library
}

// ---------------------------------------------------------------------------------------------
// The picture

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meshlet_path_draws_the_instance_paths_picture() {
    let Some(gpu) = gpu() else { return };
    for path in [ScenePath::Legacy, ScenePath::Hdr] {
        let instance = Variant { path, meshlets: false, occlusion: false, equal: None };
        let mut reference = renderer(&gpu, instance, (WIDTH, HEIGHT));
        let scene = forest(&meshes(&mut reference, &gpu));
        // The HDR output's dither is keyed to the frame index: compare frames of equal index.
        let expected = [1, 3].map(|frames| draw(&gpu, &mut reference, &scene, frames));
        assert!(reference.last_meshlets().is_none(), "{path:?}: the instance path draws no meshlets");
        write_evidence(&format!("instance-{path:?}.bgra").to_lowercase(), expected[1].bgra());
        let variants = [
            Variant { path, meshlets: true, occlusion: false, equal: None },
            Variant { path, meshlets: true, occlusion: true, equal: None },
            Variant { path, meshlets: true, occlusion: true, equal: Some(true) },
        ];
        for variant in variants {
            let mut meshlet = renderer(&gpu, variant, (WIDTH, HEIGHT));
            let scene = forest(&meshes(&mut meshlet, &gpu));
            // Frame 1 starts from an empty history, frames 2 and 3 draw last frame's set early.
            for (expected, frames) in expected.iter().zip([1, 3]) {
                let got = draw(&gpu, &mut meshlet, &scene, frames);
                let stats = meshlet.last_stats();
                assert!(stats.meshlet_candidates > 0 && stats.meshlet_draws > 0, "{variant:?}: drawn through meshlets: {stats:?}");
                assert_eq!(stats.occlusion, variant.occlusion, "{variant:?}");
                assert!(stats.meshlet_views > 1, "{variant:?}: the shadow cascades draw meshlet casters: {stats:?}");
                let name = format!("meshlets-{path:?}-{}-{}-{frames}.bgra", u8::from(variant.occlusion), u8::from(variant.equal.is_some())).to_lowercase();
                write_evidence(&name, got.bgra());
                let (count, worst) = differing(expected, &got);
                assert_eq!(count, 0, "{variant:?} after {frames} frames: {count} pixels differ from the instance path (worst {worst})");
            }
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_meshlet_prepass_writes_the_instance_prepass_depth_bit_for_bit() {
    let Some(gpu) = gpu() else { return };
    for path in [ScenePath::Legacy, ScenePath::Hdr] {
        let depth = |meshlets: bool, occlusion: bool| {
            let variant = Variant { path, meshlets, occlusion, equal: Some(false) };
            let mut renderer = renderer(&gpu, variant, (WIDTH, HEIGHT));
            renderer.set_depth_readback(true);
            let scene = forest(&meshes(&mut renderer, &gpu));
            draw(&gpu, &mut renderer, &scene, 2);
            assert_eq!(renderer.last_meshlets().is_some(), meshlets);
            renderer.read_prepass_depth(&gpu).expect("prepass depth")
        };
        let instance = depth(false, false);
        for occlusion in [false, true] {
            let meshlet = depth(true, occlusion);
            let differ = instance.iter().zip(&meshlet).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            assert_eq!(differ, 0, "{path:?} (occlusion {occlusion}): {differ} prepass depths differ, so an instance main pass would fail `Equal` over a meshlet prepass");
            assert!(meshlet.iter().any(|d| *d != instance[0]), "the prepass drew something");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Two-pass occlusion

/// A boulder field behind (or beside) a wall: the wall is a cube on the instance path, the
/// boulders are clustered.
fn walled(meshes: &Meshes, wall_x: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 6.0], [0.0, 1.0, 0.0]), [30, 30, 40, 255]);
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([wall_x, 1.0, 2.0], [6.0, 4.0, 0.3]), Material::color([180, 60, 60, 255]));
    for i in 0..4 {
        scene.draw(meshes.boulder, scaled([i as f32 * 0.6 - 0.9, 1.0, -1.0], [0.3; 3]), Material::color([140, 140, 140, 255]));
    }
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_object_occluded_in_the_next_frame_leaves_the_visible_set() {
    let Some(gpu) = gpu() else { return };
    for path in [ScenePath::Legacy, ScenePath::Hdr] {
        let variant = Variant { path, meshlets: true, occlusion: true, equal: None };
        let mut renderer = renderer(&gpu, variant, (WIDTH, HEIGHT));
        let meshes = meshes(&mut renderer, &gpu);
        // Frame N: the wall stands aside, the boulders are in view.
        renderer.set_frame_index(0);
        renderer.render(&gpu, &walled(&meshes, 9.0), CullPath::Gpu).expect("frame N");
        let open = renderer.read_meshlets(&gpu).expect("readback");
        let candidates = open.frame.candidates;
        let visible_n = (0..2).map(|slot| open.bitset(slot).count()).max().unwrap_or(0);
        assert!(visible_n > 0, "{path:?}: frame N marks the boulders' front meshlets visible");
        assert!(visible_n < candidates, "{path:?}: back-facing meshlets are culled by their cones");
        assert_eq!(open.kept(0, CullPass::First), 0, "frame N starts from an empty history");
        assert!(open.kept(0, CullPass::Second) > 0, "pass 2 draws what is in view");
        // Frame N+1: the wall moves in front of every boulder.
        renderer.set_frame_index(1);
        renderer.render(&gpu, &walled(&meshes, 0.0), CullPath::Gpu).expect("frame N+1");
        let closed = renderer.read_meshlets(&gpu).expect("readback");
        assert!(closed.kept(0, CullPass::First) > 0, "{path:?}: pass 1 drew last frame's visible set early");
        assert_eq!(closed.kept(0, CullPass::Second), 0, "{path:?}: nothing new is visible behind the wall");
        let written: Vec<u32> = (0..2).map(|slot| closed.bitset(slot).count()).collect();
        assert!(written.contains(&0), "{path:?}: pass 2 re-tested every candidate and the next visible set is empty: {written:?}");
        // Frame N+2 draws nothing of the boulders at all.
        renderer.set_frame_index(2);
        renderer.render(&gpu, &walled(&meshes, 0.0), CullPath::Gpu).expect("frame N+2");
        let after = renderer.read_meshlets(&gpu).expect("readback");
        assert_eq!((after.kept(0, CullPass::First), after.kept(0, CullPass::Second)), (0, 0), "{path:?}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_object_behind_a_wall_is_never_drawn_and_the_picture_holds() {
    let Some(gpu) = gpu() else { return };
    for path in [ScenePath::Legacy, ScenePath::Hdr] {
        let mut instance = renderer(&gpu, Variant { path, meshlets: false, occlusion: false, equal: None }, (WIDTH, HEIGHT));
        let expected = {
            let meshes = meshes(&mut instance, &gpu);
            draw(&gpu, &mut instance, &walled(&meshes, 0.0), 1)
        };
        let mut renderer = renderer(&gpu, Variant { path, meshlets: true, occlusion: true, equal: None }, (WIDTH, HEIGHT));
        let meshes = meshes(&mut renderer, &gpu);
        let got = draw(&gpu, &mut renderer, &walled(&meshes, 0.0), 1);
        let read = renderer.read_meshlets(&gpu).expect("readback");
        assert_eq!(read.kept(0, CullPass::First), 0, "an empty history draws nothing in pass 1");
        assert_eq!(read.kept(0, CullPass::Second), 0, "{path:?}: the boulders behind the wall fail the Hi-Z in pass 2");
        assert_eq!(differing(&expected, &got).0, 0, "{path:?}: the picture is the instance path's");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_captures_are_identical_and_never_move_lives_history() {
    let Some(gpu) = gpu() else { return };
    let variant = Variant { path: ScenePath::Hdr, meshlets: true, occlusion: true, equal: None };
    let mut renderer = renderer(&gpu, variant, (WIDTH, HEIGHT));
    let meshes = meshes(&mut renderer, &gpu);
    let scene = forest(&meshes);
    draw(&gpu, &mut renderer, &scene, 2);
    let live = renderer.read_meshlets(&gpu).expect("readback");
    let live_bits = [live.bitset(0), live.bitset(1)];
    let mut shots = Vec::new();
    for _ in 0..2 {
        renderer.set_environment_settle(true);
        renderer.set_frame_index(0);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("capture re-render");
        let read = renderer.read_meshlets(&gpu).expect("readback");
        assert_eq!(read.kept(0, CullPass::First), 0, "a capture holds no history: pass 1 draws nothing");
        assert_eq!([read.bitset(0), read.bitset(1)], live_bits, "a capture never writes Live's bitsets");
        shots.push(renderer.capture(&gpu).expect("capture"));
        renderer.set_environment_settle(false);
    }
    assert_eq!(shots[0].bgra(), shots[1].bgra(), "two settled captures of one state are identical");
    let mut instance = self::renderer(&gpu, Variant { meshlets: false, occlusion: false, ..variant }, (WIDTH, HEIGHT));
    let instance_scene = forest(&self::meshes(&mut instance, &gpu));
    // Frame index 0, as the capture's re-render (the HDR dither is keyed to it).
    let expected = draw(&gpu, &mut instance, &instance_scene, 1);
    assert_eq!(differing(&expected, &shots[0]).0, 0, "the capture is the instance path's picture");
}

/// The camera of frame `frame` of a slow orbit around the forest (the R2 review's moving camera).
fn orbit(frame: u32) -> CameraDesc {
    let angle = frame as f32 * 0.035;
    CameraDesc::look_at([libm::sinf(angle) * 9.0, 3.0 - frame as f32 * 0.03, libm::cosf(angle) * 9.0], [0.0, 1.2, 0.0])
}

/// R2 review: the shipped configuration. A preset's world pass is MSAA 4x (TAA draws MSAA until
/// it lands), and the Hi-Z holds the single-sample prepass's depth at pixel centres, so occlusion
/// would cull meshlets seen only through an edge pixel's uncovered samples. With meshlets and
/// occlusion opted in at `medium` on a desktop class, occlusion stands down and every frame of a
/// moving camera is the instance path's picture.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_under_msaa_occlusion_stands_down_and_meshlets_draw_the_instance_paths_picture() {
    const FRAMES: u32 = 24;
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let build = |meshlets: bool| {
        let mut quality = preset_quality(QualityPreset::Medium, class);
        quality.set_feature(RenderFeature::Meshlets, meshlets);
        quality.set_feature(RenderFeature::Occlusion, meshlets);
        let mut renderer = Renderer::new(&gpu, 640, 360).expect("renderer");
        assert_eq!(renderer.sample_count(), 4, "a preset's world pass is MSAA 4x");
        renderer.set_scene_format(SceneFormat::Rgba16Float);
        renderer.set_device_class(class);
        renderer.set_quality(&quality);
        let meshes = meshes(&mut renderer, &gpu);
        (renderer, meshes)
    };
    let (mut instance, instance_meshes) = build(false);
    let (mut meshlet, meshlet_meshes) = build(true);
    let mut differing_frames = Vec::new();
    for frame in 0..FRAMES {
        let mut pictures = Vec::new();
        for (renderer, meshes) in [(&mut instance, &instance_meshes), (&mut meshlet, &meshlet_meshes)] {
            let mut scene = forest(meshes);
            scene.camera = orbit(frame);
            renderer.set_frame_index(u64::from(frame));
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            pictures.push(renderer.capture(&gpu).expect("capture"));
        }
        let stats = meshlet.last_stats();
        assert!(stats.meshlet_draws > 0, "frame {frame}: drawn through meshlets: {stats:?}");
        assert!(!stats.occlusion, "frame {frame}: occlusion stands down over MSAA");
        let (count, worst) = differing(&pictures[0], &pictures[1]);
        if count > 0 {
            differing_frames.push((frame, count, worst));
        }
        if frame == FRAMES - 1 {
            write_evidence("msaa-orbit-instance.bgra", pictures[0].bgra());
            write_evidence("msaa-orbit-meshlets.bgra", pictures[1].bgra());
        }
    }
    assert!(differing_frames.is_empty(), "(frame, pixels, worst channel) differing from the instance path: {differing_frames:?}");
}

/// The Hi-Z variant renderer at the HDR scene with meshlets and occlusion, and its forest.
fn occluding(gpu: &Gpu) -> (Renderer, Meshes) {
    let mut renderer = renderer(gpu, Variant { path: ScenePath::Hdr, meshlets: true, occlusion: true, equal: None }, (WIDTH, HEIGHT));
    let meshes = meshes(&mut renderer, gpu);
    (renderer, meshes)
}

/// R2 review: a capture whose pinned quality draws no meshlets, or meshlets without occlusion,
/// never drops Live's visibility history: the next Live frame's pass 1 still draws last frame's
/// set early.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_capture_at_another_quality_never_drops_lives_history() {
    let Some(gpu) = gpu() else { return };
    let (mut renderer, meshes) = occluding(&gpu);
    let live_quality = *renderer.quality();
    let scene = forest(&meshes);
    draw(&gpu, &mut renderer, &scene, 2);
    let live = renderer.read_meshlets(&gpu).expect("readback");
    let live_bits = [live.bitset(0), live.bitset(1)];
    let mut without_occlusion = live_quality;
    without_occlusion.set_feature(RenderFeature::Occlusion, false);
    let mut without_meshlets = live_quality;
    without_meshlets.set_feature(RenderFeature::Meshlets, false);
    without_meshlets.set_feature(RenderFeature::Occlusion, false);
    for capture in [without_meshlets, without_occlusion] {
        renderer.set_environment_settle(true);
        renderer.set_quality(&capture);
        renderer.set_frame_index(0);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("capture re-render");
        renderer.set_environment_settle(false);
        if let Ok(read) = renderer.read_meshlets(&gpu) {
            assert_eq!([read.bitset(0), read.bitset(1)], live_bits, "a capture never writes Live's bitsets");
        }
    }
    renderer.set_quality(&live_quality);
    renderer.set_frame_index(2);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("the next Live frame");
    let next = renderer.read_meshlets(&gpu).expect("readback");
    assert!(next.kept(0, CullPass::First) > 0, "pass 1 drew Live's last visible set early: the captures left Live's history");
}

/// R2 review: `frame.camera_cut()` starts every history over, the meshlet visibility too: pass 1
/// of the cut frame draws nothing of the last shot.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_camera_cut_starts_the_meshlet_history_over() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    renderer.renderer_mut().set_quality(&quality(Variant { path: ScenePath::Hdr, meshlets: true, occlusion: true, equal: None }));
    let crown = renderer.add_mesh(&gpu, dense_sphere(40, 48)).expect("mesh");
    let kept_first = |renderer: &mut FrameRenderer, tick: u64, cut: bool| {
        let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 1.0, 5.0], [0.0, 1.0, 0.0]), [30, 30, 40, 255]);
        frame.set_tick(tick);
        if cut {
            frame.camera_cut();
        }
        for i in 0..3 {
            frame.mesh(crown, scaled([i as f32 * 1.2 - 1.2, 1.0, 0.0], [0.5; 3]), Material::color([90, 150, 80, 255]));
        }
        renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        renderer.renderer_mut().read_meshlets(&gpu).expect("readback").kept(0, CullPass::First)
    };
    kept_first(&mut renderer, 1, false);
    assert!(kept_first(&mut renderer, 2, false) > 0, "without a cut, pass 1 draws last frame's set");
    assert_eq!(kept_first(&mut renderer, 3, true), 0, "a camera cut starts the visibility history over");
}

/// R2 review: adding an instance of a mesh drawn before the clustered ones (one more cube: a
/// projectile, a pickup) shifts every global instance index but moves no candidate, so the
/// visibility history holds.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_one_more_cube_keeps_the_meshlet_history() {
    let Some(gpu) = gpu() else { return };
    let (mut renderer, meshes) = occluding(&gpu);
    let scene = forest(&meshes);
    draw(&gpu, &mut renderer, &scene, 2);
    let mut more = forest(&meshes);
    more.draw(MeshId::CUBE, scaled([2.0, 0.3, 3.0], [0.3; 3]), Material::color([200, 200, 60, 255]));
    renderer.set_frame_index(2);
    renderer.render(&gpu, &more, CullPath::Gpu).expect("frame with one more cube");
    let read = renderer.read_meshlets(&gpu).expect("readback");
    assert!(read.kept(0, CullPass::First) > 0, "pass 1 still drew last frame's set: the history was not reset");
}

/// R2 review: a quality without meshlets (every preset's default) clusters nothing at load and
/// holds no meshlet bytes; turning meshlets on clusters and holds them; turning them off gives the
/// GPU's tables and working buffers back while the CPU clusters stay (no second clustering).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_meshlets_cluster_on_first_use_and_their_bytes_go_when_they_go_off() {
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::from_wire("mobile-high").expect("class");
    let off = preset_quality(QualityPreset::High, class);
    assert!(!off.meshlets, "the preset draws the instance path");
    let mut renderer = Renderer::with_options(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_quality(&off);
    let big = renderer.add_mesh(&gpu, dense_sphere(200, 250)).expect("a 100k-triangle mesh");
    assert!(renderer.library().meshlets().meshlets.is_empty(), "nothing clusters on the instance path");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 5.0], [0.0, 1.0, 0.0]), [30, 30, 40, 255]);
    scene.draw(big, scaled([0.0, 1.0, 0.0], [1.0; 3]), Material::color([90, 150, 80, 255]));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    assert_eq!(renderer.meshlet_bytes(), 0, "no meshlet bytes on the instance path");
    let mut on = off;
    on.set_feature(RenderFeature::Meshlets, true);
    renderer.set_quality(&on);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_stats().meshlet_draws > 0 && renderer.meshlet_bytes() > 0, "meshlets cluster on first use and hold bytes");
    let clusters = renderer.library().meshlets().clone();
    assert!(!clusters.meshlets.is_empty());
    renderer.set_quality(&off);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    assert_eq!(renderer.meshlet_bytes(), 0, "meshlets off: the tables and working buffers are given back");
    assert_eq!(*renderer.library().meshlets(), clusters, "the CPU clusters stay");
    renderer.set_quality(&on);
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    assert!(renderer.last_stats().meshlet_draws > 0 && renderer.meshlet_bytes() > 0, "on again: the tables go back up");
}

// ---------------------------------------------------------------------------------------------
// The golden

fn goldens_dir() -> PathBuf {
    FsPath::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/meshlets")
}

fn check_golden(name: &str, bgra: &[u8]) {
    write_evidence(&format!("golden-{name}.bgra"), bgra);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, bgra).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), bgra.len());
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(bgra.chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meshlets_forest_golden_holds() {
    let Some(gpu) = gpu() else { return };
    let variant = Variant { path: ScenePath::Hdr, meshlets: true, occlusion: true, equal: None };
    let mut renderer = renderer(&gpu, variant, (WIDTH, HEIGHT));
    let scene = forest(&meshes(&mut renderer, &gpu));
    let shot = draw(&gpu, &mut renderer, &scene, 3);
    assert!(renderer.last_stats().occlusion);
    check_golden("forest", shot.bgra());
}

// ---------------------------------------------------------------------------------------------
// The CPU reference over 100k meshlets

/// A deterministic xorshift generator.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 16) as u32
    }

    fn unit(&mut self) -> f32 {
        (self.next() & 0xff_ffff) as f32 / 16_777_216.0
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
}

const CASE_INSTANCES: u32 = 100;
const CASE_MESHLETS_PER_INSTANCE: u32 = 1_000;
const CASE_RENDER: (u32, u32) = (320, 180);

/// Ortho light views standing in for cascades (and, past four, shadowed spots).
fn light_views(count: u32) -> Vec<glam::Mat4> {
    (0..count)
        .map(|i| {
            let angle = i as f32 * 0.7;
            let dir = glam::Vec3::new(libm::cosf(angle) * 0.5, 1.0, libm::sinf(angle) * 0.5).normalize();
            let view = glam::camera::rh::view::look_at_mat4(dir * 40.0, glam::Vec3::ZERO, glam::Vec3::Y);
            let half = 12.0 + i as f32 * 6.0;
            glam::camera::rh::proj::directx::orthographic(-half, half, -half, half, 1.0, 90.0) * view
        })
        .collect()
}

/// A random meshlet-library case of 100 instances × 1 000 meshlets each, `views` views (the
/// camera and ortho light views), a random history, and a Hi-Z with a near wall over the left half.
fn hundred_k_case(seed: u64, views: u32, reversed: bool) -> CullCase {
    let mut rng = Rng(seed);
    let camera = CameraDesc::look_at([0.0, 6.0, 32.0], [0.0, 2.0, 0.0]);
    let aspect = CASE_RENDER.0 as f32 / CASE_RENDER.1 as f32;
    let view_proj = camera.projection(aspect, reversed);
    let mut frame = GpuFrame { view_proj: view_proj.to_cols_array(), camera_pos: [0.0, 6.0, 32.0, 1.0], ..GpuFrame::default() };
    frame.counts = [0, 0, views, 0];
    let mut cull_views = GpuCullViews::default();
    cull_views.planes[0] = frustum_planes_for(view_proj, reversed);
    for (i, light) in light_views(views - 1).into_iter().enumerate() {
        let mut planes = frustum_planes(light);
        planes[4] = [0.0, 0.0, 0.0, 1.0];
        cull_views.planes[i + 1] = planes;
    }
    let mut library = MeshletLibrary::default();
    let mut instances = Vec::new();
    let mut meshlet_instances = Vec::new();
    for i in 0..CASE_INSTANCES {
        let mut reach = 0.0f32;
        for _ in 0..CASE_MESHLETS_PER_INSTANCE {
            let centre = [rng.range(-3.0, 3.0), rng.range(-3.0, 3.0), rng.range(-3.0, 3.0)];
            let radius = rng.range(0.05, 0.6);
            reach = reach.max(glam::Vec3::from(centre).length() + radius);
            let axis = glam::Vec3::new(rng.range(-1.0, 1.0), rng.range(-1.0, 1.0), rng.range(-1.0, 1.0)).try_normalize().unwrap_or(glam::Vec3::Z);
            let cutoff = if rng.below(5) == 0 { 1.0 } else { rng.range(-0.3, 0.95) };
            // Mostly small meshlets (the compacted indices of 9 views stay inside one storage
            // binding), every hundredth a full one.
            let full = rng.below(100) == 0;
            let (vertices, triangles) = if full { (64, 124) } else { (3 + rng.below(62), 1 + rng.below(16)) };
            library.meshlets.push(GpuMeshlet {
                bounds: [centre[0], centre[1], centre[2], radius],
                cone: [axis.x, axis.y, axis.z, cutoff],
                vertex_offset: library.vertices.len() as u32,
                triangle_offset: library.triangles.len() as u32,
                vertex_count: vertices,
                triangle_count: triangles,
            });
            library.vertices.extend((0..vertices).map(|v| i * 64 + v));
            library.triangles.extend((0..triangles).map(|_| pack_triangle([0, 1, 2].map(|_| rng.below(vertices) as u8))));
        }
        let position = glam::Vec3::new(rng.range(-30.0, 30.0), rng.range(0.0, 10.0), rng.range(-40.0, 40.0));
        let scale = match i % 10 {
            0 => glam::Vec3::new(rng.range(0.5, 2.0), rng.range(0.5, 2.0), rng.range(0.5, 2.0)),
            1 => glam::Vec3::new(-1.0, 1.0, 1.0),
            _ => glam::Vec3::splat(rng.range(0.5, 2.0)),
        };
        let rotation = glam::Quat::from_rotation_y(rng.range(-0.5, 0.5));
        let model = glam::Mat4::from_scale_rotation_translation(scale, rotation, position).to_cols_array();
        instances.push(instance_row(&model, [0.0; 3], reach, 0));
        meshlet_instances.push(GpuMeshletInstance {
            instance: i,
            first_meshlet: i * CASE_MESHLETS_PER_INSTANCE,
            meshlet_count: CASE_MESHLETS_PER_INSTANCE,
            first_candidate: i * CASE_MESHLETS_PER_INSTANCE,
        });
    }
    let candidates = CASE_INSTANCES * CASE_MESHLETS_PER_INSTANCE;
    let mut history = VisibilityBits::new(candidates);
    for candidate in 0..candidates {
        history.set(candidate, rng.below(2) == 0);
    }
    let (wall, far) = if reversed { (0.004, 0.0) } else { (0.996, 1.0) };
    let mut depths = vec![far; (CASE_RENDER.0 * CASE_RENDER.1) as usize];
    for y in 0..CASE_RENDER.1 {
        for x in 0..CASE_RENDER.0 / 2 {
            depths[(y * CASE_RENDER.0 + x) as usize] = wall;
        }
    }
    let reduce = if reversed { HizReduce::Min } else { HizReduce::Max };
    let levels = hiz::reference(reduce, CASE_RENDER, &depths).expect("pyramid");
    CullCase {
        frame,
        views: cull_views,
        view_count: views,
        instances,
        library,
        meshlet_instances,
        history: Some(history),
        occlusion: Some(CaseHiz { render: CASE_RENDER, reversed, levels }),
    }
}

/// Every decision of `case` (each view's pass 1, the camera's pass 2), per candidate.
fn decisions(case: &CullCase, candidates: u32) -> Vec<Vec<bool>> {
    (0..candidates).map(|c| (0..case.view_count).map(|v| reference_visible(case, v, c, false)).chain([reference_visible(case, 0, c, true)]).collect()).collect()
}

/// `case` with every bound scaled by `scale` and every cone cutoff moved by `shift`.
fn perturbed(case: &CullCase, scale: f32, shift: f32) -> CullCase {
    let mut out = case.clone();
    for meshlet in &mut out.library.meshlets {
        meshlet.bounds[3] *= scale;
        if meshlet.cone[3] < 1.0 {
            meshlet.cone[3] = (meshlet.cone[3] + shift).min(0.999);
        }
    }
    for row in &mut out.instances {
        row.bounds[3] *= scale;
    }
    out
}

/// Move every candidate whose decision a 0.1 % change of its bounds or cone flips far behind the
/// camera, so the CPU and GPU decide it alike whatever their rounding.
fn settle_ambiguity(case: &mut CullCase) {
    let candidates = CASE_INSTANCES * CASE_MESHLETS_PER_INSTANCE;
    for _ in 0..3 {
        let base = decisions(case, candidates);
        let wider = decisions(&perturbed(case, 1.001, -1.0e-3), candidates);
        let narrower = decisions(&perturbed(case, 0.999, 1.0e-3), candidates);
        let ambiguous: Vec<usize> = (0..candidates as usize).filter(|c| base[*c] != wider[*c] || base[*c] != narrower[*c]).collect();
        if ambiguous.is_empty() {
            return;
        }
        for candidate in ambiguous {
            let meshlet = &mut case.library.meshlets[candidate];
            meshlet.bounds = [0.0, 0.0, 4_000.0, 0.01];
        }
    }
    panic!("ambiguous candidates remain");
}

/// The first difference between two outcomes, for a readable failure.
fn first_difference(gpu: &CullOutcome, cpu: &CullOutcome) -> Option<String> {
    for (view, (g, c)) in gpu.views.iter().zip(&cpu.views).enumerate() {
        if g.first.len() != c.first.len() || g.second.len() != c.second.len() {
            return Some(format!("view {view}: {} + {} meshlets on the GPU, {} + {} on the CPU", g.first.len(), g.second.len(), c.first.len(), c.second.len()));
        }
        if let Some(at) = g.first.iter().zip(&c.first).position(|(a, b)| a != b) {
            return Some(format!("view {view} pass 1 slot {at}: {:?} vs {:?}", g.first[at], c.first[at]));
        }
        if let Some(at) = g.second.iter().zip(&c.second).position(|(a, b)| a != b) {
            return Some(format!("view {view} pass 2 slot {at}: {:?} vs {:?}", g.second[at], c.second[at]));
        }
        if g.indices != c.indices {
            let at = g.indices.iter().zip(&c.indices).position(|(a, b)| a != b);
            return Some(format!("view {view}: indices differ at {at:?} ({} vs {})", g.indices.len(), c.indices.len()));
        }
    }
    (gpu.visibility != cpu.visibility).then(|| "the next visibility bitsets differ".to_owned())
}

#[test]
fn the_cpu_reference_keeps_pass_one_to_the_history_and_pass_two_to_the_rest() {
    // Small enough for every run: 3 instances × 1 000 meshlets.
    let mut case = hundred_k_case(7, 2, false);
    case.instances.truncate(3);
    case.meshlet_instances.truncate(3);
    let outcome = reference(&case);
    let camera = &outcome.views[0];
    let history = case.history.clone().expect("history");
    assert!(camera.first.iter().all(|drawn| history.get(drawn.meshlet)), "pass 1 draws only what last frame marked");
    assert!(camera.second.iter().all(|drawn| !history.get(drawn.meshlet) || !reference_visible(&case, 0, drawn.meshlet, false)), "pass 2 draws only what pass 1 did not");
    let next = outcome.visibility.expect("occlusion writes the next bitset");
    let drawn_second: Vec<u32> = camera.second.iter().map(|drawn| drawn.meshlet).collect();
    assert!(drawn_second.iter().all(|c| next.get(*c)), "what pass 2 draws is marked for the next frame");
    let indices: usize = camera.first.iter().chain(&camera.second).map(|drawn| case.library.meshlets[drawn.meshlet as usize].triangle_count as usize * 3).sum();
    assert_eq!(camera.indices.len(), indices, "every kept meshlet's triangles, in order");
    let reset = CullCase { history: None, ..case.clone() };
    assert!(reference(&reset).views[0].first.is_empty(), "a reset history draws nothing in pass 1");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_visible_lists_of_a_100k_meshlet_batch_equal_the_cpu_reference() {
    let Some(gpu) = gpu() else { return };
    for (seed, reversed) in [(11u64, false), (23u64, true)] {
        let mut case = hundred_k_case(seed, 5, reversed);
        settle_ambiguity(&mut case);
        let cpu = reference(&case);
        let camera = &cpu.views[0];
        assert!(!camera.first.is_empty() && !camera.second.is_empty(), "both passes draw something: {} + {}", camera.first.len(), camera.second.len());
        let occluded = (0..CASE_INSTANCES * CASE_MESHLETS_PER_INSTANCE).filter(|c| reference_visible(&case, 0, *c, false) && !reference_visible(&case, 0, *c, true)).count();
        assert!(occluded > 0, "the wall occludes some candidates in view");
        assert!(cpu.views[1..].iter().all(|view| !view.first.is_empty()), "every light view draws something");
        let gpu_outcome = run_case(&gpu, &case).expect("gpu cull");
        if let Some(difference) = first_difference(&gpu_outcome, &cpu) {
            panic!("reversed {reversed}: {difference}");
        }
        assert_eq!(gpu_outcome, cpu);
        // The same case twice gives the same bytes (no atomics: the order never varies).
        assert_eq!(run_case(&gpu, &case).expect("gpu cull again"), gpu_outcome);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cull_costs_are_recorded_at_5_and_9_views() {
    let Some(gpu) = gpu() else { return };
    let mut rows = Vec::new();
    for views in [5u32, 9] {
        let case = hundred_k_case(31, views, true);
        let Some(mut times) = case_gpu_ms(&gpu, &case, 40).expect("cost") else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        times.sort_by(f32::total_cmp);
        let (p50, p95) = (percentile(&times, 0.5), percentile(&times, 0.95));
        assert!(p50.is_finite() && p50 > 0.0);
        rows.push(format!("\"views{views}\":{{\"samples\":{},\"p50Ms\":{p50:.4},\"p95Ms\":{p95:.4}}}", times.len()));
    }
    write_perf(&format!(
        "{{\"row\":\"meshlet-cull-100k\",\"adapter\":\"{}\",\"candidates\":{},\"passes\":\"pass 1 over every view + pass 2 (camera)\",{}}}",
        gpu.receipt().adapter,
        CASE_INSTANCES * CASE_MESHLETS_PER_INSTANCE,
        rows.join(",")
    ));
}

// ---------------------------------------------------------------------------------------------
// The stress rows

fn percentile(sorted: &[f32], q: f32) -> f32 {
    sorted[((sorted.len() - 1) as f32 * q) as usize]
}

/// A dense forest: `rows` × 12 crowns. With `wall`, a wall in front hides nearly all of it.
fn stress(meshes: &Meshes, rows: u32, wall: bool) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 12.0], [0.0, 1.5, 0.0]), [96, 128, 170, 255]);
    scene.lighting.shadows = true;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -20.0], [80.0, 0.2, 80.0]), Material::color([110, 150, 90, 255]));
    if wall {
        scene.draw(MeshId::CUBE, scaled([0.0, 2.0, 8.0], [20.0, 6.0, 0.4]), Material::color([150, 140, 130, 255]));
    }
    for row in 0..rows {
        for column in 0..12 {
            let (x, z) = (column as f32 * 1.6 - 8.8 + (row % 2) as f32 * 0.8, -(row as f32) * 1.6);
            scene.draw(meshes.crown, scaled([x, 1.4, z], [0.75, 0.9, 0.75]), Material::color([50, 130 + (row * 7 % 60) as u8, 60, 255]).with_pbr(0.0, 0.7));
        }
    }
    scene
}

/// Rows of the occlusion stress forest (1 800 crowns, 6.9 M triangles behind a wall).
const STRESS_ROWS: u32 = 150;
/// The open scene's crowns: a 22 × 12 grid seen from above, none hiding another.
const OPEN_GRID: (u32, u32) = (22, 12);
/// The open scene's crown tessellation (15 360 triangles).
const OPEN_CROWN: (u32, u32) = (80, 96);

/// Crowns on a grid seen from straight above: nothing occludes anything.
fn open_field(crown: MeshId) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 30.0, 0.01], [0.0, 0.0, 0.0]), [96, 128, 170, 255]);
    scene.lighting.shadows = true;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, 0.0], [80.0, 0.2, 80.0]), Material::color([110, 150, 90, 255]));
    for gx in 0..OPEN_GRID.0 {
        for gz in 0..OPEN_GRID.1 {
            let at = [gx as f32 * 2.0 - OPEN_GRID.0 as f32 + 1.0, 0.8, gz as f32 * 2.0 - OPEN_GRID.1 as f32 + 1.0];
            scene.draw(crown, scaled(at, [0.8; 3]), Material::color([50, 140, 60, 255]).with_pbr(0.0, 0.7));
        }
    }
    scene
}

/// The high preset of a desktop-high device, with meshlets and occlusion switched as asked.
fn high(meshlets: bool, occlusion: bool) -> Quality {
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("class");
    let mut quality = genex_render::presets::preset_quality(genex_render::settings::QualityPreset::High, class);
    quality.set_feature(RenderFeature::Meshlets, meshlets);
    quality.set_feature(RenderFeature::Occlusion, occlusion);
    quality
}

/// Sorted GPU frame times of each renderer drawing `scene`, in interleaved rounds so GPU clock
/// changes hit every configuration alike. None without timestamp queries.
fn frame_times(gpu: &Gpu, renderers: &mut [Renderer], scene: &Scene) -> Option<Vec<Vec<f32>>> {
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); renderers.len()];
    for round in 0..5u64 {
        for (k, renderer) in renderers.iter_mut().enumerate() {
            for frame in 0..40u64 {
                let times = renderer.arm_frame_timer(&gpu.queue)?;
                if round > 0 && frame >= 6 {
                    landed[k].extend(times);
                }
                renderer.set_frame_index(frame);
                renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
    }
    for times in &mut landed {
        times.sort_by(f32::total_cmp);
    }
    Some(landed)
}

/// The stress rows' configurations: (name, meshlets, occlusion).
const STRESS_CONFIGS: [(&str, bool, bool); 3] = [("instance", false, false), ("meshlets", true, false), ("meshletsOcclusion", true, true)];
/// Independent trials of the stress rows; the gates read their medians.
const STRESS_TRIALS: usize = 3;

fn median(mut values: Vec<f32>) -> f32 {
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meshlet_path_saves_in_the_occlusion_stress_scene_and_costs_little_in_the_open() {
    let Some(gpu) = gpu() else { return };
    let tile = gpu.device.adapter_info().transient_saves_memory == Some(true);
    let mut renderers: Vec<Renderer> = STRESS_CONFIGS
        .iter()
        .map(|(_, meshlets, occlusion)| {
            let mut renderer = Renderer::with_options(&gpu, 1920, 1080, RenderOptions { msaa: false }).expect("renderer");
            renderer.set_scene_format(SceneFormat::Rgba16Float);
            renderer.set_quality(&high(*meshlets, *occlusion));
            renderer
        })
        .collect();
    // Every renderer adds the same meshes in the same order: one scene serves them all.
    let forest_meshes: Vec<Meshes> = renderers.iter_mut().map(|renderer| meshes(renderer, &gpu)).collect();
    let open_crowns: Vec<MeshId> = renderers.iter_mut().map(|renderer| renderer.add_mesh(&gpu, dense_sphere(OPEN_CROWN.0, OPEN_CROWN.1)).expect("crown")).collect();
    assert!(open_crowns.windows(2).all(|pair| pair[0] == pair[1]) && forest_meshes.windows(2).all(|pair| pair[0].crown == pair[1].crown));
    let scenes = [("occluded", stress(&forest_meshes[0], STRESS_ROWS, true)), ("open", open_field(open_crowns[0]))];
    let mut rows = Vec::new();
    // Per scene, per configuration: the change of the p50 over the instance path, per trial.
    let mut changes = vec![vec![Vec::new(); STRESS_CONFIGS.len()]; scenes.len()];
    let mut ratio = 0.0;
    for (s, (name, scene)) in scenes.iter().enumerate() {
        let mut trials = Vec::new();
        for _ in 0..STRESS_TRIALS {
            let Some(landed) = frame_times(&gpu, &mut renderers, scene) else {
                eprintln!("skipped: no timestamp queries");
                return;
            };
            let base = percentile(&landed[0], 0.5);
            let fields: Vec<String> = STRESS_CONFIGS
                .iter()
                .zip(&landed)
                .enumerate()
                .map(|(k, ((config, ..), times))| {
                    changes[s][k].push((percentile(times, 0.5) - base) / base);
                    format!("\"{config}\":{{\"frames\":{},\"p50Ms\":{:.4},\"p95Ms\":{:.4}}}", times.len(), percentile(times, 0.5), percentile(times, 0.95))
                })
                .collect();
            trials.push(format!("{{{}}}", fields.join(",")));
        }
        // Vertex invocations, counted from emitted indices: the meshlet path's kept indices
        // against the instance path's indices of every frustum-visible crown.
        let read = renderers[2].read_meshlets(&gpu).expect("readback");
        let emitted = read.kept_indices(0, CullPass::First) + read.kept_indices(0, CullPass::Second);
        let plan = genex_render::scene::FramePlan::build(scene, renderers[0].library(), 1920.0 / 1080.0).expect("plan");
        let crown_indices = renderers[0].library().entry(plan_crown(&forest_meshes[0], open_crowns[0], s)).map_or(0, |entry| entry.index_count);
        let instance = plan.cpu_cull().counts[1] * crown_indices;
        let scene_ratio = if instance == 0 { 0.0 } else { emitted as f32 / instance as f32 };
        if *name == "open" {
            ratio = scene_ratio;
        }
        let stats = renderers[2].last_stats();
        let medians: Vec<String> = STRESS_CONFIGS.iter().enumerate().map(|(k, (config, ..))| format!("\"{config}\":{:.4}", median(changes[s][k].clone()))).collect();
        rows.push(format!(
            "\"{name}\":{{\"medianChange\":{{{}}},\"emittedIndices\":{emitted},\"instanceIndices\":{instance},\"invocationRatio\":{scene_ratio:.4},\"candidates\":{},\"meshletViews\":{},\"trials\":[{}]}}",
            medians.join(","),
            stats.meshlet_candidates,
            stats.meshlet_views,
            trials.join(",")
        ));
    }
    write_perf(&format!("{{\"row\":\"meshlets-stress-1080p-high\",\"adapter\":\"{}\",\"tileGpu\":{tile},{}}}", gpu.receipt().adapter, rows.join(",")));
    assert!(ratio <= INVOCATIONS_RATIO_MAX, "vertex invocations {ratio:.2}x the instance path's in the open scene (gate {INVOCATIONS_RATIO_MAX}x)");
    let (meshlets_occluded, saving) = (median(changes[0][1].clone()), -median(changes[0][2].clone()));
    assert!(-saving < meshlets_occluded, "occlusion pays for itself in the occluded scene: {:.1}% against the meshlet path's {:.1}%", -saving * 100.0, meshlets_occluded * 100.0);
    let (meshlets_open, occlusion_open) = (median(changes[1][1].clone()), median(changes[1][2].clone()));
    // On a tile GPU the instance path's fixed-function vertex fetch outruns vertex pulling, the
    // prepass occlusion needs is a second geometry pass and the main pass keeps its own depth: the
    // rows are recorded for the class defaults (R2.5; plan §2.4 keeps tile classes off until the
    // measurements show a gain). The acceptance gates hold the immediate-mode GPUs they were set
    // for.
    if tile {
        eprintln!("tile GPU: occluded saving {:.1}%, open meshlets {:+.1}%, open occlusion {:+.1}% (informational)", saving * 100.0, meshlets_open * 100.0, occlusion_open * 100.0);
        return;
    }
    assert!(saving >= STRESS_SAVING_MIN, "the occlusion stress scene saves {:.1}% (gate {:.0}%)", saving * 100.0, STRESS_SAVING_MIN * 100.0);
    assert!(meshlets_open <= OPEN_OVERHEAD_MAX, "the meshlet path costs {:.1}% more in the open scene (gate {:.0}%)", meshlets_open * 100.0, OPEN_OVERHEAD_MAX * 100.0);
    assert!(occlusion_open <= OPEN_OVERHEAD_MAX, "occlusion costs {:.1}% more in the open scene (gate {:.0}%)", occlusion_open * 100.0, OPEN_OVERHEAD_MAX * 100.0);
}

/// The crown mesh scene `s` draws (0: the forest's, 1: the open field's).
fn plan_crown(forest: &Meshes, open: MeshId, s: usize) -> MeshId {
    if s == 0 { forest.crown } else { open }
}

#[test]
fn a_mesh_under_min_triangles_stays_on_the_instance_path() {
    let mut library = genex_render::scene::MeshLibrary::with_meshlets(Meshlets::DEFAULT);
    let dense = library.add(dense_sphere(40, 48)).expect("dense");
    let small = library.add(MeshData::sphere()).expect("small");
    assert!(matches!(library.meshlet_state(dense), Some(genex_render::scene::MeshletState::Clustered(_))));
    assert_eq!(library.meshlet_state(small), Some(genex_render::scene::MeshletState::Whole));
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 5.0], [0.0; 3]), [0, 0, 0, 255]);
    scene.draw(dense, translation(0.0, 0.0, 0.0), Material::color([200, 200, 200, 255]));
    scene.draw(dense, translation(2.0, 0.0, 0.0), Material::color([200, 200, 200, 255]));
    scene.draw(small, translation(-2.0, 0.0, 0.0), Material::color([200, 200, 200, 255]));
    let plan = genex_render::scene::FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    let frame = genex_render::meshlet_cull::MeshletFrame::plan(&plan, &library).expect("a clustered batch");
    let meshlets = match library.meshlet_state(dense) {
        Some(genex_render::scene::MeshletState::Clustered(range)) => range.meshlet_count,
        _ => unreachable!(),
    };
    assert_eq!(frame.instances.len(), 2, "both instances of the dense mesh, none of the small one");
    assert_eq!(frame.candidates, 2 * meshlets);
    assert_eq!(frame.instances[1].first_candidate, meshlets, "candidates follow the table order");
    assert_eq!(frame.candidate_triangles, 2 * 40 * 48 * 2);
    let clustered: Vec<bool> = frame.batches.clone();
    assert_eq!(clustered.iter().filter(|b| **b).count(), 1, "one batch draws through meshlets: {clustered:?}");
}

/// R2.6: a model's imported meshlets (R2.3) reach the renderer: the library clusters by them, not
/// by the runtime clusterizer, and they draw the instance path's picture.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_imported_meshlets_are_the_ones_drawn_and_draw_the_instance_paths_picture() {
    let Some(gpu) = gpu() else { return };
    let instance = Variant { path: ScenePath::Hdr, meshlets: false, occlusion: false, equal: None };
    let mut reference = renderer(&gpu, instance, (WIDTH, HEIGHT));
    let scene = forest(&meshes(&mut reference, &gpu));
    let expected = draw(&gpu, &mut reference, &scene, 3);
    let parts = imported_meshes();
    for occlusion in [false, true] {
        let variant = Variant { path: ScenePath::Hdr, meshlets: true, occlusion, equal: None };
        let mut meshlet = renderer(&gpu, variant, (WIDTH, HEIGHT));
        let ids = meshlet.add_meshes_with_meshlets(&gpu, parts.clone()).expect("imported parts");
        assert_eq!(meshlet.library().meshlets(), library_of(Meshlets::DEFAULT, &parts).meshlets(), "the imported sets are the library's");
        assert_ne!(meshlet.library().meshlets(), reference.library().meshlets(), "not the runtime clusterizer's");
        let scene = forest(&Meshes { crown: ids[0], boulder: ids[1] });
        let got = draw(&gpu, &mut meshlet, &scene, 3);
        assert!(meshlet.last_stats().meshlet_draws > 0, "drawn through meshlets");
        write_evidence(&format!("imported-meshlets-{}.bgra", u8::from(occlusion)), got.bgra());
        let (count, worst) = differing(&expected, &got);
        assert_eq!(count, 0, "occlusion {occlusion}: {count} pixels differ from the instance path (worst {worst})");
    }
}

/// R2.6: the game's meshlet setting and a model's imported sets survive a device loss: the
/// recovered renderer clusters by the same setting and the same imported sets.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_meshlet_setting_and_imported_sets_survive_a_device_loss() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }, Gpu::headless).expect("resilient");
    // Clustering is lazy (R2 review): the presenter hands every frame's quality over, so a
    // recovered renderer clusters once that quality draws meshlets.
    let drawn = quality(Variant { path: ScenePath::Hdr, meshlets: true, occlusion: false, equal: None });
    resilient.renderer_mut().renderer_mut().set_quality(&drawn);
    let setting = Meshlets::DEFAULT.with_occlusion(false);
    resilient.set_meshlets(setting).expect("set");
    let parts = imported_meshes();
    let ids = resilient.add_meshes_with_meshlets(parts.clone()).expect("imported parts");
    let expected = library_of(setting, &parts);
    let held = |resilient: &Resilient| resilient.renderer().renderer().library().clone();
    assert_eq!(held(&resilient).meshlets(), expected.meshlets());
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovers"), "the device was re-created");
    assert_eq!(resilient.renderer().renderer().meshlet_setting(), setting, "the game's setting is replayed");
    resilient.renderer_mut().renderer_mut().set_quality(&drawn);
    let recovered = held(&resilient);
    assert_eq!(recovered.meshlet_setting(), setting, "the library clusters by it once the quality draws meshlets");
    assert_eq!(recovered.meshlets(), expected.meshlets(), "the imported sets are replayed");

    resilient.set_meshlets(setting.with_enabled(false)).expect("off");
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovers"));
    resilient.renderer_mut().renderer_mut().set_quality(&drawn);
    let off = held(&resilient);
    assert_eq!(off.meshlet_state(ids[0]), Some(MeshletState::Whole), "the latest setting is the one replayed");
    assert!(off.meshlets().meshlets.is_empty());
}
