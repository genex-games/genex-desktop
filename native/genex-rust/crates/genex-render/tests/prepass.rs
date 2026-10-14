//! RQ4.1: the depth/normal prepass (graph node 7) and the `Equal`-depth world pass.
//!
//! The prepass draws the opaque batches (skinned ones included) and a world stage's custom
//! geometry into a sampleable depth and octahedral normals at 1x, only when a consumer asks. On
//! immediate-mode GPUs at 1x the world pass then tests `Equal` against that depth with depth writes
//! off; on tile GPUs and with MSAA it keeps its own depth and the prepass serves consumers only.
//! These rows hold the picture unchanged either way and the prepass depth equal to the world pass's.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test prepass -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames (raw BGRA, top row first);
//! `GENEX_PERF_OUT` receives the cost row as JSON.

use std::path::PathBuf;

use genex_render::abi::RenderInputs;
use genex_render::capture::Capture;
use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::MeshData;
use genex_render::prepass::{ExtensionDemand, PrepassConsumers, PrepassDraw, equal_depth_reuse, oct_decode};
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, scaled, translation};
use genex_render::settings::{Quality, RenderFeature, SceneFormat};
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer, WorldStage};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (the golden suites' tolerance).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// The prepass's share of the opaque world pass it serves (plan §2.10).
const PREPASS_SHARE_MAX: f32 = 0.15;

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

/// The legacy path (standard Z, the world format) or the HDR path (reverse-Z, `rgba16float`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Path {
    Legacy,
    Hdr,
}

/// The quality of `path` with the prepass switch on (nothing else turned on asks for it).
fn quality(path: Path) -> Quality {
    let mut quality = Quality::off();
    if path == Path::Hdr {
        quality.hdr = true;
        quality.tonemap = true;
        quality.exposure = true;
    }
    quality.set_feature(RenderFeature::Prepass, true);
    quality
}

/// What a Level-3 pass declaring depth asks of the frame: the prepass, whatever else is off.
fn depth_demand() -> ExtensionDemand {
    ExtensionDemand { custom_inputs: RenderInputs::DEPTH, ..ExtensionDemand::default() }
}

/// A one-joint skinned cube: its joint matrix places it.
fn skinned_cube() -> SkinnedMeshData {
    let mesh = MeshData::cube();
    let skin = vec![GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let skeleton = Skeleton {
        nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }],
        joints: vec![0],
        inverse_bind: vec![translation(0.0, 0.0, 0.0)],
        mesh_node: None,
    };
    SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() }
}

/// Spheres and cubes at several depths over a ground, overlapping on screen, and a skinned cube.
fn scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let skin = renderer.add_skinned_mesh(gpu, &skinned_cube()).expect("skinned mesh");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.5, 7.0], [0.0, 0.4, 0.0]), [24, 28, 40, 255]);
    scene.lighting.shadows = false;
    for i in 0..6 {
        let (x, z) = (i as f32 * 0.9 - 2.2, -(i as f32) * 0.8);
        scene.draw(MeshId::SPHERE, scaled([x, 0.6, z], [0.7; 3]), Material::color([220, 150, 60, 255]).with_pbr(0.2, 0.4));
        scene.draw(MeshId::CUBE, scaled([-x, 0.4, z - 0.4], [0.6; 3]), Material::color([70, 140, 220, 255]));
    }
    let joint = scaled([0.6, 1.4, 1.2], [0.5; 3]);
    scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), vec![joint], Material::color([120, 220, 90, 255]));
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -2.0], [12.0, 0.2, 10.0]), Material::color([200, 200, 200, 255]));
    scene
}

fn renderer(gpu: &Gpu, path: Path, msaa: bool) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa }).expect("renderer");
    if path == Path::Hdr {
        renderer.set_scene_format(SceneFormat::Rgba16Float);
    }
    renderer.set_quality(&quality(path));
    renderer.set_depth_readback(!msaa);
    renderer
}

/// One frame of [`scene`]: its capture and (single-sampled) depth.
fn frame(gpu: &Gpu, renderer: &mut Renderer, cull: CullPath, stage: &mut dyn WorldStage) -> (Capture, Option<Vec<f32>>) {
    let scene = scene(renderer, gpu);
    renderer.render_staged(gpu, &scene, cull, stage).expect("frame");
    let capture = renderer.capture(gpu).expect("capture");
    (capture, renderer.read_depth(gpu).ok())
}

/// No custom work.
struct NoStage;

impl WorldStage for NoStage {}

/// A stage whose custom geometry (one cube the world pass never draws) goes into the prepass.
struct CustomGeometry(Vec<PrepassDraw>);

impl WorldStage for CustomGeometry {
    fn prepass_draws(&self) -> Vec<PrepassDraw> {
        self.0.clone()
    }
}

/// Depths compared bit for bit (`Equal` needs the very same float).
fn same_bits(a: &[f32], b: &[f32]) -> usize {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).filter(|(x, y)| x.to_bits() != y.to_bits()).count()
}

/// Pixels differing beyond the golden tolerance, and the worst channel difference.
fn outliers(a: &Capture, b: &Capture) -> (usize, u8) {
    let mut count = 0;
    let mut worst = 0u8;
    for (p, q) in a.bgra().chunks(4).zip(b.bgra().chunks(4)) {
        let diff = p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            count += 1;
        }
    }
    (count, worst)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn equal_reuse_follows_the_device_class_and_a_forced_reuse_never_reaches_msaa_or_custom_geometry() {
    use genex_render::prepass::main_pass_equal;
    assert!(main_pass_equal(false, 1, None, 0), "immediate-mode GPUs at 1x reuse the depth");
    assert!(!main_pass_equal(true, 1, None, 0), "tile GPUs keep their own depth by default");
    assert!(main_pass_equal(true, 1, Some(true), 0), "a diagnostic may force it on a tile GPU");
    assert!(!main_pass_equal(false, 1, Some(false), 0));
    assert!(!main_pass_equal(false, 4, Some(true), 0), "never with MSAA: the prepass is 1x");
    assert!(!main_pass_equal(false, 1, Some(true), 1), "custom geometry keeps the world pass's own depth");
}

#[test]
fn only_landed_consumers_and_the_extension_ladder_ask_for_the_prepass() {
    use genex_render::prepass::{consumers, drawn_consumers};
    let mut quality = Quality::off();
    quality.set_feature(RenderFeature::Prepass, true);
    quality.set_feature(RenderFeature::Ao, true);
    quality.set_feature(RenderFeature::ContactShadows, true);
    let asked = consumers(&quality, ExtensionDemand::default());
    assert!(asked.contains(PrepassConsumers::AO));
    let drawn = drawn_consumers(&quality, ExtensionDemand::default());
    assert_eq!(drawn.contains(PrepassConsumers::AO), genex_render::post::ao::LANDED, "a switch without its node asks for nothing");
    let ladder = drawn_consumers(&Quality::off(), ExtensionDemand { after_prepass: true, ..ExtensionDemand::default() });
    assert_eq!(ladder, PrepassConsumers::CUSTOM_PASS);
}

/// RQ4 review: wgpu's WebGPU backend never says whether the GPU keeps attachments in tile memory,
/// so an unknown answer takes the class's form: a phone's browser is a tile GPU (no `Equal` reuse),
/// a desktop's is not; a known answer stands.
#[test]
fn an_adapter_that_does_not_say_takes_its_tile_memory_from_the_form_factor() {
    use genex_render::device_class::FormFactor;
    use genex_render::prepass::tile_gpu;
    assert!(tile_gpu(None, FormFactor::Mobile), "mobile web: tile");
    assert!(!tile_gpu(None, FormFactor::Desktop), "desktop web: immediate mode");
    assert!(tile_gpu(Some(true), FormFactor::Desktop) && !tile_gpu(Some(false), FormFactor::Mobile), "the adapter's answer stands");
    assert!(!equal_depth_reuse(tile_gpu(None, FormFactor::Mobile), 1), "no Equal reuse on mobile web, even single-sampled");
}

/// RQ4 review: contact shadows ask for the prepass only on a frame whose sun casts shadows (the
/// node needs the cascades); AO and the ladder's demand are untouched.
#[test]
fn contact_shadows_ask_for_the_prepass_only_when_the_sun_casts_shadows() {
    use genex_render::prepass::{drawn_consumers, with_sun_shadows};
    let mut quality = Quality::off();
    quality.set_feature(RenderFeature::Prepass, true);
    quality.set_feature(RenderFeature::ContactShadows, true);
    let drawn = drawn_consumers(&quality, ExtensionDemand::default());
    assert!(drawn.contains(PrepassConsumers::CONTACT_SHADOWS));
    assert!(with_sun_shadows(drawn, &quality, true).contains(PrepassConsumers::CONTACT_SHADOWS));
    assert!(with_sun_shadows(drawn, &quality, false).is_empty(), "no shadowed sun: nobody asks");
    quality.set_feature(RenderFeature::Ao, true);
    let drawn = drawn_consumers(&quality, depth_demand());
    let unshadowed = with_sun_shadows(drawn, &quality, false);
    assert!(unshadowed.contains(PrepassConsumers::AO) && unshadowed.contains(PrepassConsumers::CUSTOM_PASS));
    assert!(!unshadowed.contains(PrepassConsumers::CONTACT_SHADOWS));
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_forced_prepass_leaves_the_1x_frame_unchanged_and_its_depth_is_the_world_pass_s() {
    let Some(gpu) = gpu() else { return };
    for path in [Path::Legacy, Path::Hdr] {
        for cull in [CullPath::Gpu, CullPath::Cpu] {
            let mut reference = renderer(&gpu, path, false);
            let (image, depth) = frame(&gpu, &mut reference, cull, &mut NoStage);
            let depth = depth.expect("the reference depth");
            assert_eq!(reference.last_prepass(), None, "{path:?}: no consumer, no prepass");
            write_evidence(&format!("{path:?}-{cull:?}-reference.bgra").to_lowercase(), image.bgra());
            for equal in [true, false] {
                let label = format!("{path:?} {cull:?} equal {equal}");
                let mut forced = renderer(&gpu, path, false);
                forced.set_prepass_demand(depth_demand());
                forced.set_equal_depth_reuse(Some(equal));
                let (with, with_depth) = frame(&gpu, &mut forced, cull, &mut NoStage);
                let info = forced.last_prepass().unwrap_or_else(|| panic!("{label}: the prepass ran"));
                assert_eq!(info.equal_depth, equal, "{label}");
                assert_eq!(info.consumers, PrepassConsumers::CUSTOM_PASS, "{label}");
                assert_eq!(info.size, (WIDTH, HEIGHT), "{label}");
                write_evidence(&format!("{path:?}-{cull:?}-equal-{equal}.bgra").to_lowercase(), with.bgra());
                let (count, worst) = outliers(&image, &with);
                assert!(with.bgra() == image.bgra(), "{label}: tolerance 0 at 1x ({count} pixels beyond the golden tolerance, worst {worst})");
                let with_depth = with_depth.expect("the world pass's depth");
                assert_eq!(same_bits(&with_depth, &depth), 0, "{label}: the world pass's depth");
                let prepass_depth = forced.read_prepass_depth(&gpu).expect("the prepass depth");
                assert_eq!(same_bits(&prepass_depth, &depth), 0, "{label}: the prepass depth equals the world pass's bit for bit");
            }
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_with_msaa_the_world_pass_keeps_its_own_depth_and_the_picture_holds_the_golden_tolerance() {
    let Some(gpu) = gpu() else { return };
    for path in [Path::Legacy, Path::Hdr] {
        let mut reference = renderer(&gpu, path, true);
        let (image, _) = frame(&gpu, &mut reference, CullPath::Gpu, &mut NoStage);
        assert!(reference.sample_count() > 1, "the MSAA row needs a multisampled world pass");
        let mut forced = renderer(&gpu, path, true);
        forced.set_prepass_demand(depth_demand());
        forced.set_equal_depth_reuse(Some(true));
        forced.set_depth_readback(true);
        let (with, _) = frame(&gpu, &mut forced, CullPath::Gpu, &mut NoStage);
        let info = forced.last_prepass().expect("the prepass ran");
        assert!(!info.equal_depth, "{path:?}: an MSAA world pass cannot test against the 1x prepass");
        let (count, worst) = outliers(&image, &with);
        assert!(count <= GOLDEN_OUTLIER_PIXELS, "{path:?}: {count} pixels beyond the golden tolerance (worst {worst})");
        write_evidence(&format!("{path:?}-msaa-prepass.bgra").to_lowercase(), with.bgra());
        // The prepass is 1x: its depth is the 1x world pass's.
        let mut single = renderer(&gpu, path, false);
        let (_, depth) = frame(&gpu, &mut single, CullPath::Gpu, &mut NoStage);
        let prepass_depth = forced.read_prepass_depth(&gpu).expect("the prepass depth");
        assert_eq!(same_bits(&prepass_depth, &depth.expect("1x depth")), 0, "{path:?}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_prepass_runs_only_for_a_consumer_and_by_device_reuses_depth_on_immediate_mode_gpus_only() {
    let Some(gpu) = gpu() else { return };
    let mut idle = renderer(&gpu, Path::Legacy, false);
    let _ = frame(&gpu, &mut idle, CullPath::Gpu, &mut NoStage);
    let passes = idle.last_stats().render_passes;
    assert_eq!(idle.last_prepass(), None, "the switch alone runs nothing (pay for what you use)");
    // The switch gates the built-in consumers; the extension ladder's demand (a game's pass or
    // source reading depth) runs the prepass whatever it says: inputs drive producers (RQ4.5).
    let mut switched_off = renderer(&gpu, Path::Legacy, false);
    let mut off = Quality::off();
    off.ao.resolution = genex_render::settings::AoResolution::Half;
    switched_off.set_quality(&off);
    let _ = frame(&gpu, &mut switched_off, CullPath::Gpu, &mut NoStage);
    assert_eq!(switched_off.last_prepass(), None, "the quality's switch gates every built-in consumer");
    switched_off.set_prepass_demand(depth_demand());
    let _ = frame(&gpu, &mut switched_off, CullPath::Gpu, &mut NoStage);
    let forced = switched_off.last_prepass().expect("the extension ladder's demand runs the prepass with the switch off");
    assert_eq!(forced.consumers, PrepassConsumers::CUSTOM_PASS, "only the ladder's consumer, never the switched-off built-ins");
    let mut asked = renderer(&gpu, Path::Legacy, false);
    asked.set_prepass_demand(depth_demand());
    let _ = frame(&gpu, &mut asked, CullPath::Gpu, &mut NoStage);
    let info = asked.last_prepass().expect("a consumer runs it");
    assert_eq!(asked.last_stats().render_passes, passes + 1, "one more render pass");
    let tile = gpu.device.adapter_info().transient_saves_memory == Some(true);
    assert_eq!(info.equal_depth, equal_depth_reuse(tile, 1), "by device: Equal reuse on immediate-mode GPUs only (tile GPU: {tile})");
}

/// RQ4 review: contact shadows on with the sun's shadows off (the scene turns them off) record no
/// prepass: its one consumer never runs.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_contact_shadows_with_the_sun_unshadowed_record_no_prepass() {
    let Some(gpu) = gpu() else { return };
    let mut contact = renderer(&gpu, Path::Hdr, false);
    let mut asked = quality(Path::Hdr);
    asked.set_feature(RenderFeature::ContactShadows, true);
    contact.set_quality(&asked);
    let _ = frame(&gpu, &mut contact, CullPath::Gpu, &mut NoStage);
    assert_eq!(contact.last_prepass(), None, "the scene casts no sun shadows: no geometry pass for a node that never runs");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_custom_geometry_reaches_the_prepass_depth_and_normals_and_keeps_the_world_pass_s_depth() {
    let Some(gpu) = gpu() else { return };
    let mut reference = renderer(&gpu, Path::Legacy, false);
    let (image, depth) = frame(&gpu, &mut reference, CullPath::Gpu, &mut NoStage);
    let depth = depth.expect("depth");
    // A cube in front of everything, drawn by the stage only into the prepass.
    let cube = PrepassDraw { mesh: MeshId::CUBE, model: scaled([0.0, 1.6, 4.0], [0.8; 3]) };
    let mut stage = CustomGeometry(vec![cube]);
    let mut forced = renderer(&gpu, Path::Legacy, false);
    forced.set_prepass_demand(depth_demand());
    forced.set_equal_depth_reuse(Some(true));
    let (with, with_depth) = frame(&gpu, &mut forced, CullPath::Gpu, &mut stage);
    let info = forced.last_prepass().expect("the prepass ran");
    assert_eq!((info.custom_draws, info.equal_depth), (1, false), "custom geometry keeps the world pass's own depth");
    assert!(with.bgra() == image.bgra(), "the world pass draws what it drew before");
    assert_eq!(same_bits(&with_depth.expect("depth"), &depth), 0, "the world pass's own depth");
    let prepass_depth = forced.read_prepass_depth(&gpu).expect("prepass depth");
    let nearer = prepass_depth.iter().zip(&depth).filter(|(p, d)| p < d).count();
    assert!(nearer > 100, "the custom cube is in the prepass depth ({nearer} pixels nearer)");
    let normals = forced.read_prepass_normals(&gpu).expect("prepass normals");
    // The cube's front face points at the camera (+z, tilted by the camera's pitch).
    let centre = ((HEIGHT / 2) * WIDTH + WIDTH / 2) as usize;
    let n = oct_decode(normals[centre]);
    assert!(n[2] > 0.9, "the cube's front face at the centre: {n:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_prepass_normals_are_unit_world_normals_and_zero_where_nothing_was_drawn() {
    let Some(gpu) = gpu() else { return };
    let mut forced = renderer(&gpu, Path::Hdr, false);
    forced.set_prepass_demand(depth_demand());
    let scene = scene(&mut forced, &gpu);
    forced.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let normals = forced.read_prepass_normals(&gpu).expect("normals");
    let depth = forced.read_prepass_depth(&gpu).expect("depth");
    // Reverse-Z: 0 is the far plane (nothing drawn).
    let (mut drawn, mut up) = (0, 0);
    for (pair, z) in normals.iter().zip(&depth) {
        if *z == 0.0 {
            assert_eq!(*pair, [0.0, 0.0], "nothing drawn keeps the cleared zero");
            continue;
        }
        drawn += 1;
        let n = oct_decode(*pair);
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        assert!((length - 1.0).abs() < 1e-3, "{n:?}");
        if n[1] > 0.99 {
            up += 1;
        }
    }
    assert!(drawn > 2000 && up > 500, "the ground's top face faces +y: {up} of {drawn} drawn pixels");
    // The normals as colour (n * 0.5 + 0.5, BGRA) and the depth as grey, for the evidence.
    let to_byte = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    let mut picture = Vec::with_capacity(normals.len() * 4);
    let mut grey = Vec::with_capacity(depth.len() * 4);
    for (pair, z) in normals.iter().zip(&depth) {
        let n = if *z == 0.0 { [-1.0; 3] } else { oct_decode(*pair) };
        picture.extend([to_byte(n[2] * 0.5 + 0.5), to_byte(n[1] * 0.5 + 0.5), to_byte(n[0] * 0.5 + 0.5), 255]);
        // z^(1/4) as two square roots: the same bits on every target, unlike a platform powf.
        let level = to_byte(z.sqrt().sqrt());
        grey.extend([level, level, level, 255]);
    }
    write_evidence("hdr-prepass-normals.bgra", &picture);
    write_evidence("hdr-prepass-depth.bgra", &grey);
}

/// The cost scene: a field of overlapping spheres at 1080p (vertex- and overdraw-heavy), lit by
/// the sun and two dozen point lights as a game's opaque pass is (shadows off: the frame is the
/// opaque pass, the cull and the tonemap).
fn cost_scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 12.0], [0.0, 0.5, 0.0]), [24, 28, 40, 255]);
    scene.lighting.shadows = false;
    for i in 0..24 {
        let (x, z) = ((i % 6) as f32 * 2.0 - 5.0, -((i / 6) as f32) * 4.0);
        scene.lighting.points.push(PointLight { position: [x, 1.5, z], range: 6.0, color: [255, 220, 180], intensity: 2.0 });
    }
    for i in 0..400 {
        let (x, z) = ((i % 20) as f32 * 0.6 - 5.7, -((i / 20) as f32) * 0.9);
        scene.draw(MeshId::SPHERE, scaled([x, 0.5, z], [0.55; 3]), Material::color([200, 160, 120, 255]).with_pbr(0.3, 0.5));
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -8.0], [30.0, 0.2, 30.0]), Material::color([200, 200, 200, 255]));
    scene
}

/// Frame configurations the cost row compares: without the prepass, with it by device (on a tile
/// GPU the world pass keeps its own depth), and with `Equal` forced (informational on a tile GPU).
const COST_CONFIGS: [(&str, bool, Option<bool>); 3] = [("off", false, None), ("prepass", true, None), ("prepassEqual", true, Some(true))];
/// Independent trials of the cost row; the gate reads their median.
const COST_TRIALS: usize = 3;

/// One trial: every configuration's sorted GPU frame times, in interleaved rounds so GPU clock
/// changes hit every configuration alike. None without timestamp queries.
fn cost_trial(gpu: &Gpu, scene: &Scene) -> Option<Vec<Vec<f32>>> {
    let mut renderers: Vec<Renderer> = COST_CONFIGS
        .iter()
        .map(|(_, on, equal)| {
            let mut renderer = Renderer::with_options(gpu, 1920, 1080, RenderOptions { msaa: false }).expect("renderer");
            renderer.set_quality(&quality(Path::Hdr));
            renderer.set_scene_format(SceneFormat::Rgba16Float);
            if *on {
                renderer.set_prepass_demand(depth_demand());
                renderer.set_equal_depth_reuse(*equal);
            }
            renderer
        })
        .collect();
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); COST_CONFIGS.len()];
    for round in 0..8u64 {
        for (k, renderer) in renderers.iter_mut().enumerate() {
            for frame in 0..80u64 {
                let times = renderer.arm_frame_timer(&gpu.queue)?;
                if round > 0 && frame >= 8 {
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

fn percentile(sorted: &[f32], q: f32) -> f32 {
    sorted[((sorted.len() - 1) as f32 * q) as usize]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_prepass_costs_at_most_15_percent_of_the_opaque_pass_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let scene = cost_scene();
    let tile = gpu.device.adapter_info().transient_saves_memory == Some(true);
    let mut trials = Vec::new();
    let mut shares = Vec::new();
    for _ in 0..COST_TRIALS {
        let Some(landed) = cost_trial(&gpu, &scene) else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        let p50s: Vec<f32> = landed.iter().map(|times| percentile(times, 0.5)).collect();
        // The frame without the prepass is the opaque pass (shadows off, no environment) plus the
        // cull and the tonemap: the delta over it bounds the prepass and any world-pass slowdown.
        let share = (p50s[1] - p50s[0]) / p50s[0];
        let mut fields: Vec<String> = COST_CONFIGS
            .iter()
            .zip(&landed)
            .map(|((name, _, _), times)| format!("\"{name}\":{{\"frames\":{},\"p50Ms\":{:.4},\"p95Ms\":{:.4}}}", times.len(), percentile(times, 0.5), percentile(times, 0.95)))
            .collect();
        fields.push(format!("\"prepassShare\":{share:.4},\"equalShare\":{:.4}", (p50s[2] - p50s[0]) / p50s[0]));
        trials.push(format!("{{{}}}", fields.join(",")));
        shares.push(share);
    }
    shares.sort_by(f32::total_cmp);
    let median = shares[COST_TRIALS / 2];
    let row = format!(
        "{{\"row\":\"prepass-1080p\",\"adapter\":\"{}\",\"tileGpu\":{tile},\"medianPrepassShare\":{median:.4},\"trials\":[{}]}}",
        gpu.receipt().adapter,
        trials.join(",")
    );
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, format!("{row}\n")).expect("perf row");
    }
    assert!(median <= PREPASS_SHARE_MAX, "the prepass costs {:.1}% of the opaque frame (median of {COST_TRIALS}; gate {:.0}%)", median * 100.0, PREPASS_SHARE_MAX * 100.0);
}
