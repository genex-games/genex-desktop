//! The frame graph (plan §2.2, RQ0.6): the ordered node table, its schedule (pass nodes and the
//! in-pass nodes of one world pass), the render-target pool and scaled rendering.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal

use genex_render::budget::BudgetKind;
use genex_render::capture::Capture;
use genex_render::graph::{FRAME_GRAPH, FrameEncoder, FrameNodes, NodeId, NodeKind, Step, run, schedule};
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, scaled, translation};
use genex_render::target_pool::{TargetDesc, TargetPolicy, TargetRefusal, validate, validate_with};
use genex_render::{CullPath, Gpu, RenderError, RenderOptions, Renderer};
use wgpu::{TextureFormat, TextureUsages};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;

/// The plan's table (§2.2), in frame order.
// Renderer pass 2 wave 2 flipped: the water (16a) after the resolve (29 -> 30 rows).
const PLAN_ORDER: [&str; 30] = [
    "tables",
    "before-cull",
    "skinning",
    "light-binning",
    "cull",
    "shadows",
    "prepass",
    "occlusion",
    "after-prepass",
    "ao",
    "contact-shadows",
    "environment",
    "opaque",
    "sky",
    "after-opaque",
    "transparent",
    "reactive",
    "resolve",
    "water",
    "taa",
    "dof",
    "motion-blur",
    "post-hdr",
    "bloom",
    "exposure",
    "tonemap",
    "upscale",
    "post",
    "hud",
    "timestamps",
];

/// The nodes that encode work today (later tiers' rows are disabled stubs). RQ1 lands node 18
/// (`post-hdr`), 20 (exposure) and 21 (tonemap); RQ2 lands the environment node and the sky; RQ4.1
/// lands the prepass (node 7) and RQ4.5 its Level-3 `after-prepass` stage (node 9); R2.4 lands
/// two-pass Hi-Z occlusion (node 8); RQ4.6 lands AO (node 10), contact shadows (10a) and bloom's
/// row (19, its chain recorded by the tonemap).
// RQ6.7 flipped: light binning (node 4) is landed (23 -> 24 rows).
// RQ5.6 flipped: TAA's reactive coverage (15a) and resolve (17) are landed (24 -> 26 rows).
// Renderer pass 2 A.9 flipped: depth of field (17a) and motion blur (17b) are landed (26 -> 28 rows).
// Renderer pass 2 wave 2 flipped: the water (16a) is landed (28 -> 29 rows).
const LANDED: [NodeId; 29] = [
    NodeId::Tables,
    NodeId::BeforeCull,
    NodeId::Skinning,
    NodeId::LightBinning,
    NodeId::Cull,
    NodeId::Shadows,
    NodeId::Prepass,
    NodeId::Occlusion,
    NodeId::AfterPrepass,
    NodeId::Ao,
    NodeId::ContactShadows,
    NodeId::Environment,
    NodeId::Opaque,
    NodeId::Sky,
    NodeId::AfterOpaque,
    NodeId::Transparent,
    NodeId::Reactive,
    NodeId::Resolve,
    NodeId::Water,
    NodeId::Taa,
    NodeId::Dof,
    NodeId::MotionBlur,
    NodeId::PostHdr,
    NodeId::Bloom,
    NodeId::Exposure,
    NodeId::Tonemap,
    NodeId::Upscale,
    NodeId::Post,
    NodeId::Hud,
];

// ---------------------------------------------------------------------------------------------
// The table and the schedule (CPU)

#[test]
fn node_order_equals_the_plan_table() {
    let wires: Vec<&str> = FRAME_GRAPH.iter().map(|row| row.wire).collect();
    assert_eq!(wires, PLAN_ORDER.to_vec());
    let in_pass: Vec<&str> = FRAME_GRAPH.iter().filter(|row| row.kind == NodeKind::InPass).map(|row| row.wire).collect();
    assert_eq!(in_pass, vec!["opaque", "sky", "after-opaque", "transparent", "resolve"], "nodes 12-16 draw inside the world pass");
}

#[test]
fn only_landed_nodes_are_enabled_and_later_tiers_rows_are_disabled_stubs() {
    let landed: Vec<NodeId> = FRAME_GRAPH.iter().map(|row| row.id).filter(|id| id.landed()).collect();
    assert_eq!(landed, LANDED.to_vec());
    let everything = schedule(|_| true);
    let scheduled: Vec<NodeId> = everything.iter().flat_map(Step::nodes).collect();
    assert_eq!(scheduled, LANDED.to_vec(), "a stub row is never scheduled, even when asked for");
}

#[test]
fn disabled_nodes_are_never_scheduled() {
    assert!(schedule(|_| false).is_empty());
    let without_shadows = schedule(|id| id != NodeId::Shadows && id != NodeId::Upscale);
    let ids: Vec<NodeId> = without_shadows.iter().flat_map(Step::nodes).collect();
    assert!(!ids.contains(&NodeId::Shadows) && !ids.contains(&NodeId::Upscale));
}

// RQ5.6 flipped: the reactive coverage (15a, a pass node) sits between the transparent draws and
// the MSAA resolve, so a frame enabling both would split the world pass. None does: TAA draws one
// sample (`landed_samples`), so a TAA frame has no resolve and an MSAA frame no reactive coverage.
// The rows are checked on the two frames that exist, not on "every row enabled".
#[test]
fn the_in_pass_nodes_share_one_world_pass() {
    let msaa_frame = schedule(|id| id != NodeId::Reactive && id != NodeId::Taa);
    let taa_frame = schedule(|id| id != NodeId::Resolve);
    for (steps, rows) in [
        (&msaa_frame, vec![NodeId::Opaque, NodeId::Sky, NodeId::AfterOpaque, NodeId::Transparent, NodeId::Resolve]),
        (&taa_frame, vec![NodeId::Opaque, NodeId::Sky, NodeId::AfterOpaque, NodeId::Transparent]),
    ] {
        let worlds: Vec<&Step> = steps.iter().filter(|step| matches!(step, Step::World(_))).collect();
        assert_eq!(worlds.len(), 1, "one world pass: {steps:?}");
        assert_eq!(worlds[0].nodes(), rows);
    }
    let taa: Vec<NodeId> = taa_frame.iter().flat_map(Step::nodes).collect();
    let at_taa = |id| taa.iter().position(|n| *n == id).expect("scheduled");
    assert!(at_taa(NodeId::Transparent) < at_taa(NodeId::Reactive) && at_taa(NodeId::Reactive) < at_taa(NodeId::Taa) && at_taa(NodeId::Taa) < at_taa(NodeId::PostHdr));
    let steps = msaa_frame;
    let order: Vec<NodeId> = steps.iter().flat_map(Step::nodes).collect();
    let at = |id| order.iter().position(|n| *n == id).expect("scheduled");
    assert!(at(NodeId::Shadows) < at(NodeId::Opaque) && at(NodeId::Resolve) < at(NodeId::Upscale) && at(NodeId::Upscale) < at(NodeId::Post));
}

#[test]
fn the_legacy_world_schedule_opens_one_pass_for_nodes_twelve_to_fifteen_with_or_without_msaa() {
    for msaa in [true, false] {
        // The legacy renderer draws no TAA (its quality is MSAA or none).
        let temporal = |id| id == NodeId::Reactive || id == NodeId::Taa;
        let steps = schedule(|id| id != NodeId::Upscale && !temporal(id) && (msaa || id != NodeId::Resolve));
        let worlds = steps.iter().filter(|step| matches!(step, Step::World(_))).count();
        assert_eq!(worlds, 1, "msaa {msaa}");
    }
}

// ---------------------------------------------------------------------------------------------
// Target pool rules (CPU)

fn desc(label: &'static str, format: TextureFormat, usage: TextureUsages, samples: u32, size: (u32, u32)) -> TargetDesc {
    TargetDesc { label, format, usage, samples, size, mips: 1, srgb_view: false }
}

#[test]
fn a_target_asking_storage_of_rg16float_is_refused_by_the_pool_validator() {
    let hostile = [
        desc("normals", TextureFormat::Rg16Float, TextureUsages::STORAGE_BINDING | TextureUsages::RENDER_ATTACHMENT, 1, (64, 64)),
        desc("motion", TextureFormat::Rg16Float, TextureUsages::STORAGE_BINDING, 1, (64, 64)),
        desc("hdr", TextureFormat::Rgba16Float, TextureUsages::STORAGE_ATOMIC, 1, (64, 64)),
        desc("depth", TextureFormat::Depth32Float, TextureUsages::STORAGE_BINDING, 1, (64, 64)),
    ];
    for target in hostile {
        match validate(&target) {
            Err(TargetRefusal::UsageBeyondCore { label, .. }) => assert_eq!(label, target.label),
            other => panic!("{} {:?} {:?}: {other:?}", target.label, target.format, target.usage),
        }
    }
    let empty = desc("empty", TextureFormat::Bgra8Unorm, TextureUsages::RENDER_ATTACHMENT, 1, (0, 72));
    assert!(matches!(validate(&empty), Err(TargetRefusal::Empty { .. })));
    let fine = [
        desc("normals", TextureFormat::Rg16Float, TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING, 1, (64, 64)),
        desc("hdr", TextureFormat::Rgba16Float, TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING, 1, (64, 64)),
        desc("msaa", TextureFormat::Bgra8Unorm, TextureUsages::RENDER_ATTACHMENT | TextureUsages::TRANSIENT_ATTACHMENT, 4, (64, 64)),
    ];
    for target in fine {
        assert_eq!(validate(&target), Ok(()), "{}", target.label);
    }
}

#[test]
fn rg11b10ufloat_is_an_attachment_only_where_the_device_was_opened_with_its_feature() {
    let usage = TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    let scene = desc("scene", TextureFormat::Rg11b10Ufloat, usage, 1, (64, 64));
    let msaa = desc("msaa", TextureFormat::Rg11b10Ufloat, usage, 4, (64, 64));
    let granted = wgpu::Features::RG11B10UFLOAT_RENDERABLE;
    for target in [scene, msaa] {
        assert!(matches!(validate(&target), Err(TargetRefusal::UsageBeyondCore { .. })), "{}: core alone refuses it", target.label);
        assert_eq!(validate_with(&target, granted), Ok(()), "{}: the granted feature takes it", target.label);
        // Only renderer-owned target features count: another optional feature grants nothing.
        assert!(validate_with(&target, wgpu::Features::TIMESTAMP_QUERY).is_err(), "{}", target.label);
    }
    assert_eq!(TargetPolicy::new(Some(true), false).with_features(granted | wgpu::Features::TIMESTAMP_QUERY).features(), granted);
}

#[test]
fn transient_attachments_only_where_the_adapter_saves_memory_and_never_on_the_web() {
    assert!(TargetPolicy::new(Some(true), false).attachment_usage().contains(TextureUsages::TRANSIENT_ATTACHMENT));
    for (saves, web) in [(Some(false), false), (None, false), (Some(true), true), (None, true)] {
        let policy = TargetPolicy::new(saves, web);
        assert_eq!(policy.attachment_usage(), TextureUsages::RENDER_ATTACHMENT, "saves {saves:?} web {web}");
    }
}

#[test]
fn a_transient_target_counts_no_bytes_in_the_ledger() {
    let saves = TargetPolicy::new(Some(true), false);
    let msaa = desc("msaa", TextureFormat::Bgra8Unorm, saves.attachment_usage(), 4, (100, 50));
    assert_eq!(msaa.bytes(), 0);
    let plain = desc("msaa", TextureFormat::Bgra8Unorm, TextureUsages::RENDER_ATTACHMENT, 4, (100, 50));
    assert_eq!(plain.bytes(), 100 * 50 * 4 * 4);
    let depth = desc("depth", TextureFormat::Depth32Float, TextureUsages::RENDER_ATTACHMENT, 1, (100, 50));
    assert_eq!(depth.bytes(), 100 * 50 * 4);
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

/// Lit cubes and spheres on a floor under sun shadows and a point light: detail at every scale.
fn scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
    scene.lighting.points.push(PointLight { position: [2.0, 3.0, 2.0], range: 10.0, color: [255, 200, 120], intensity: 3.0 });
    let colors = [[230, 41, 55, 255], [0, 228, 48, 255], [0, 121, 241, 255], [253, 249, 0, 255]];
    for (i, color) in colors.iter().enumerate() {
        let x = i as f32 * 1.8 - 2.7;
        scene.draw(MeshId::CUBE, translation(x, 0.0, 0.0), Material::color(*color).with_pbr(0.1 * i as f32, 0.5));
        scene.draw(MeshId::SPHERE, translation(x, 1.6, -1.0), Material::color(*color).with_pbr(0.8, 0.25));
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.75, 0.0], [12.0, 0.2, 8.0]), Material::color([90, 90, 100, 255]));
    scene.line([-3.0, 2.8, 0.0], [3.0, 2.8, 0.0], [255, 255, 255, 255]);
    scene
}

/// Each channel averaged over `block` × `block` pixel boxes.
fn box_filter(capture: &Capture, block: u32) -> Vec<f32> {
    let (w, h) = (capture.width() / block, capture.height() / block);
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for by in 0..h {
        for bx in 0..w {
            for channel in 0..4 {
                let mut sum = 0.0;
                for y in 0..block {
                    for x in 0..block {
                        let at = (((by * block + y) * capture.width() + bx * block + x) * 4 + channel) as usize;
                        sum += f32::from(capture.bgra()[at]);
                    }
                }
                out.push(sum / (block * block) as f32);
            }
        }
    }
    out
}

fn mean_abs(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_render_pass_count_of_the_legacy_frame_equals_todays() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
    let stats = renderer.last_stats();
    assert_eq!(stats.views, 3, "the camera and two cascades");
    assert_eq!(stats.render_passes, 3, "two shadow cascades and one world pass, as before the graph");
    assert_eq!(stats.compute_passes, 1, "the cull (no skinned draws)");
    renderer.render(&gpu, &scene(), CullPath::Cpu).expect("frame");
    assert_eq!(renderer.last_stats().render_passes, 3);
    assert_eq!(renderer.last_stats().compute_passes, 0, "the CPU path has no cull dispatch");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_with_msaa_nodes_twelve_to_fifteen_record_one_render_pass_with_transient_discarded_attachments() {
    let Some(gpu) = gpu() else { return };
    let saves = gpu.device.adapter_info().transient_saves_memory == Some(true);
    eprintln!("adapter transient_saves_memory: {saves}");
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
    let world = renderer.last_world_pass().expect("a world pass ran");
    assert_eq!(world.passes, 1, "one world pass hosts opaque, after-opaque and transparent");
    assert_eq!(world.samples, 4);
    assert!(world.resolved, "MSAA resolves into the scene colour inside the world pass");
    assert_eq!(world.color_store, wgpu::StoreOp::Discard, "the multisampled colour is never stored");
    assert_eq!(world.depth_store, wgpu::StoreOp::Discard, "no node reads depth after the world pass");
    assert_eq!(world.transient, saves, "transient exactly when the adapter saves memory");
    let ledger = renderer.targets().ledger();
    let bytes_of = |label: &str| ledger.entries().iter().find(|e| e.kind == BudgetKind::Target && e.label == label).map(|e| e.bytes);
    let msaa_bytes = u64::from(WIDTH * HEIGHT) * 4 * 4;
    assert_eq!(bytes_of("world msaa"), Some(if saves { 0 } else { msaa_bytes }));
    assert_eq!(bytes_of("world"), Some(u64::from(WIDTH * HEIGHT) * 4));

    let mut single = Renderer::with_options(&gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    single.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
    let world = single.last_world_pass().expect("a world pass ran");
    assert_eq!((world.passes, world.samples, world.resolved), (1, 1, false));
    assert_eq!(world.color_store, wgpu::StoreOp::Store, "without MSAA the world pass stores its colour");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_scale_half_allocates_half_size_targets_and_upscales_into_the_world_target() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.render(&gpu, &scene(), CullPath::Gpu).expect("full frame");
    let full = renderer.capture(&gpu).expect("capture");
    assert!(renderer.targets().get("scene").is_none(), "scale 1 draws straight into the world target");

    renderer.set_render_scale(0.5);
    renderer.render(&gpu, &scene(), CullPath::Gpu).expect("half frame");
    let half = renderer.capture(&gpu).expect("capture");
    assert_eq!(renderer.render_size(), (WIDTH / 2, HEIGHT / 2));
    assert_eq!((half.width(), half.height()), (WIDTH, HEIGHT), "captures keep the output size");
    for label in ["scene", "world msaa", "depth"] {
        let target = renderer.targets().get(label).unwrap_or_else(|| panic!("{label} pooled"));
        assert_eq!(target.desc().size, (WIDTH / 2, HEIGHT / 2), "{label} is exactly the step's size");
    }
    let scene_target = renderer.targets().get("scene").expect("scene pooled");
    assert!(scene_target.desc().srgb_view && scene_target.srgb_view().is_some(), "the upscale samples linear light through the sRGB twin");
    assert_eq!(renderer.targets().get("world").expect("world").desc().size, (WIDTH, HEIGHT));
    assert_eq!(renderer.last_stats().render_passes, 4, "the bilinear upscale adds one pass");

    assert_ne!(full.bgra(), half.bgra(), "the half-scale frame is not the full frame");
    let (full_boxed, half_boxed) = (box_filter(&full, 8), box_filter(&half, 8));
    let difference = mean_abs(&full_boxed, &half_boxed);
    assert!(difference < 6.0, "after an 8x8 box filter the frames agree (mean |Δ| {difference:.2} of 255)");
    assert!(mean_abs(&box_filter(&full, 1), &box_filter(&half, 1)) > difference, "the box filter is what makes them agree");

    renderer.set_render_scale(1.0);
    renderer.render(&gpu, &scene(), CullPath::Gpu).expect("full again");
    assert_eq!(renderer.capture(&gpu).expect("capture").bgra(), full.bgra(), "back at scale 1 the frame is the full frame");
    assert!(renderer.targets().get("scene").is_none(), "the scaled scene target is released at scale 1");
    assert_eq!(renderer.last_stats().render_passes, 3);
}

/// Records which nodes the graph asks for: no node but the enabled ones may encode.
struct Recorder {
    enabled: Vec<NodeId>,
    encoded: Vec<NodeId>,
    hosts: u32,
    view: wgpu::TextureView,
}

impl FrameNodes for Recorder {
    fn enabled(&self, id: NodeId) -> bool {
        self.enabled.contains(&id)
    }

    fn encode(&mut self, id: NodeId, _frame: &mut FrameEncoder) -> Result<(), RenderError> {
        self.encoded.push(id);
        Ok(())
    }

    fn begin_world<'e>(&mut self, _rows: &[NodeId], encoder: &'e mut wgpu::CommandEncoder) -> wgpu::RenderPass<'e> {
        self.hosts += 1;
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("recorder world"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        })
    }

    fn encode_in_pass(&mut self, id: NodeId, _pass: &mut wgpu::RenderPass<'_>) {
        self.encoded.push(id);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_disabled_nodes_encode_nothing() {
    let Some(gpu) = gpu() else { return };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("recorder"),
        size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Bgra8Unorm,
        usage: TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    // RQ5.6 flipped: TAA landed, so the stub asked for is the timestamp resolve's row (25), which
    // the graph never schedules (`timing.rs` records it outside the table).
    let enabled = vec![NodeId::Cull, NodeId::Opaque, NodeId::Transparent, NodeId::Sky, NodeId::Timestamps];
    let mut recorder = Recorder { enabled, encoded: Vec::new(), hosts: 0, view };
    let mut frame = FrameEncoder::new(&gpu.device, &gpu.queue, "recorder");
    let steps = run(&mut recorder, &mut frame).expect("graph ran");
    frame.submit();
    // RQ2 landed the sky, so it encodes in the world pass; the stub (taa) never does.
    assert_eq!(recorder.encoded, vec![NodeId::Cull, NodeId::Opaque, NodeId::Sky, NodeId::Transparent], "stubs (timestamps) never encode");
    assert_eq!(recorder.hosts, 1);
    assert_eq!(steps.len(), 2);
    assert_eq!(frame.counters().render, 1, "the host pass is counted once");
    assert_eq!(frame.counters().submissions, 1);
}

#[test]
fn every_level_three_stage_is_a_graph_node_and_the_in_world_stages_draw_in_the_world_pass() {
    use genex_render::custom_pass::PassStage;
    let nodes: Vec<NodeId> = PassStage::ALL.iter().map(|stage| stage.node()).collect();
    assert_eq!(nodes, vec![NodeId::BeforeCull, NodeId::AfterOpaque, NodeId::Transparent, NodeId::Post, NodeId::PostHdr, NodeId::AfterPrepass]);
    for stage in PassStage::ALL {
        let row = genex_render::graph::spec(stage.node());
        // `post-hdr` (custom-pass API v2) is node 18 on the HDR path; on the legacy LDR scene its
        // passes run first in node 23 over the world target.
        assert!(stage.node().landed(), "{} runs today", stage.wire());
        assert_eq!(row.kind == NodeKind::InPass, stage.in_world(), "{}", stage.wire());
    }
}
