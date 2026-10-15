//! Renderer pass 2 A.0, scale prerequisites: the rows that hold the renderer to scatter-sized
//! scenes before Tier A's foliage, grass, decals and probes land.
//!
//! - LG-06: the instance cull spreads a batch's instances over the GPU (a deterministic ordered
//!   compaction over (instance, view)), so its time grows sub-linearly with the batch, and its
//!   visible list and indirect arguments equal the CPU cull's, slot for slot.
//!
//! - LG-20: Level-2 material draws outside the camera's view are not drawn, a frame's draws
//!   bind each material's pipeline once, and the draws of one (material, mesh) pair are one
//!   instanced call whose instances each read their own `gx_draw` row.
//! - LG-13: the budget ledger counts the GPU buffers the renderer holds (`BudgetKind::Buffers`):
//!   its model of a frame's buffers is within 5% of the bytes the renderer really holds, and the
//!   buffers it names are the live ones.
//!
//! CPU rows run everywhere; real-GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test scatter -- --ignored metal
//!
//! With `GENEX_PERF_OUT` (a folder) the cost rows write their JSON there; with
//! `GENEX_RENDER_EVIDENCE_DIR` the retained-group row writes its captures there.

use std::path::PathBuf;

use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, Scene, translation};
use genex_render::{Gpu, Renderer};

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
/// Samples per cost row (each one cull pass between two timestamps).
const COST_SAMPLES: u32 = 40;
/// The scatter sizes the cull is timed at: a 10k batch and a ten-times larger one.
const SMALL_BATCH: usize = 10_000;
const LARGE_BATCH: usize = 100_000;
/// Ten times the instances may cost at most this many times the time (sub-linear; a serial walk of
/// the batch costs about ten, less the pass's fixed cost).
const SUB_LINEAR_MAX: f32 = 4.0;
/// Batches the large scatter is split over for the same work spread by batch.
const SPLIT_BATCHES: usize = 100;
/// One batch of the large scatter may cost at most this many times the same instances split over
/// [`SPLIT_BATCHES`] batches, plus [`SPLIT_SLACK_MS`]: the cull's time follows the instances, not
/// the largest batch.
const SPLIT_RATIO_MAX: f32 = 1.5;
const SPLIT_SLACK_MS: f32 = 0.05;

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

/// With `GENEX_RENDER_EVIDENCE_DIR`, write `capture` there as `<name>-<w>x<h>.bgra` (top row first).
fn write_evidence(name: &str, capture: &genex_render::capture::Capture) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("evidence folder");
    std::fs::write(dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height())), capture.bgra()).expect("evidence written");
}

fn write_perf(name: &str, report: &serde_json::Value) {
    let Ok(dir) = std::env::var("GENEX_PERF_OUT") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("perf folder");
    std::fs::write(dir.join(name), serde_json::to_string_pretty(report).expect("json")).expect("perf written");
}

/// `count` models scattered over a 400 m square around the origin (about half inside the camera's
/// view), deterministic.
fn scatter_models(count: usize, seed: u32) -> Vec<[f32; 16]> {
    let mut state = seed;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state >> 8) as f32 / (1u32 << 24) as f32
    };
    (0..count).map(|_| translation(next() * 400.0 - 200.0, next() * 2.0, next() * 400.0 - 200.0)).collect()
}

/// One batch of `count` scattered cubes (one mesh: one batch), plus `extra` small batches of other
/// meshes, seen from above the field; shadows `shadows` (one view or the camera and its cascades).
fn scatter_scene(count: usize, extra: &[(MeshId, usize)], shadows: bool) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 40.0, 160.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.shadows = shadows;
    scene.draw_instanced(MeshId::CUBE, &scatter_models(count, 0x5CA7_7E25), Material::color([200, 180, 160, 255]));
    for (index, (mesh, instances)) in extra.iter().enumerate() {
        scene.draw_instanced(*mesh, &scatter_models(*instances, 0x0BA7_C400 + index as u32), Material::color([90, 140, 90, 255]));
    }
    scene
}

/// One cull cost row: its name, the scattered cubes, the other batches and whether shadows draw.
type CullCase = (&'static str, usize, Vec<(MeshId, usize)>, bool);

fn median(samples: &[f32]) -> f32 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted[sorted.len() / 2]
}

/// Every view's indirect counts and visible-list survivors of the last GPU cull equal the CPU
/// cull's, slot for slot.
fn assert_gpu_cull_equals_cpu(what: &str, gpu: &Gpu, renderer: &Renderer, plan: &FramePlan) {
    for view in 0..plan.views {
        let cpu = plan.cpu_cull_view(view as usize);
        let args = renderer.read_view_args(gpu, view).expect("args");
        let counts: Vec<u32> = args.iter().map(|a| a.instance_count).collect();
        assert_eq!(counts, cpu.counts, "{what}: view {view}'s survivors per batch");
        let visible = renderer.read_view_visible(gpu, view).expect("visible");
        for (batch, count) in plan.batches.iter().zip(&cpu.counts) {
            let range = batch.first_instance as usize..(batch.first_instance + count) as usize;
            assert_eq!(visible[range.clone()], cpu.visible[range], "{what}: view {view}'s visible list, batch from row {}", batch.first_instance);
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_instance_cull_scales_sub_linearly_with_the_batch_and_equals_the_cpu_cull() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut rows = Vec::new();
    // The same 100k instances over a hundred meshes (one batch each): the work spread by batch.
    let meshes = renderer.add_meshes(&gpu, (1..SPLIT_BATCHES).map(|_| genex_render::mesh::MeshData::cube()).collect()).expect("meshes");
    let split: Vec<(MeshId, usize)> = meshes.iter().map(|mesh| (*mesh, LARGE_BATCH / SPLIT_BATCHES)).collect();
    let cases: [CullCase; 4] = [
        ("10k", SMALL_BATCH, vec![(MeshId::SPHERE, 300)], false),
        ("100k", LARGE_BATCH, vec![(MeshId::SPHERE, 300)], false),
        ("100k-split", LARGE_BATCH / SPLIT_BATCHES, split, false),
        ("100k-shadowed", LARGE_BATCH, vec![(MeshId::SPHERE, 300)], true),
    ];
    for (name, count, extra, shadows) in cases {
        let scene = scatter_scene(count, &extra, shadows);
        let Some(costs) = renderer.cull_gpu_ms(&gpu, &scene, COST_SAMPLES).expect("cull cost") else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        let plan = FramePlan::build(&scene, renderer.library(), WIDTH as f32 / HEIGHT as f32).expect("plan");
        assert_gpu_cull_equals_cpu(name, &gpu, &renderer, &plan);
        let ms = median(&costs);
        eprintln!("cull {name}: {} views, {} batches, median {ms:.4} ms over {} samples", plan.views, plan.batches.len(), costs.len());
        rows.push((name, count, plan.views, ms));
    }
    let report: Vec<serde_json::Value> = rows
        .iter()
        .map(|(name, count, views, ms)| serde_json::json!({ "row": name, "instances": count, "views": views, "median_ms": ms }))
        .collect();
    write_perf("A0-cull-scaling.json", &serde_json::json!({ "row": "cull-scaling", "backend": gpu.receipt().backend, "adapter": gpu.receipt().adapter, "rows": report }));
    let (small, large, split) = (rows[0].3, rows[1].3, rows[2].3);
    assert!(large <= SPLIT_RATIO_MAX * split + SPLIT_SLACK_MS, "100k instances in one batch cost {large:.4} ms against {split:.4} ms over {SPLIT_BATCHES} batches: the batch is walked serially");
    assert!(large <= SUB_LINEAR_MAX * small, "ten times the instances in one batch cost {:.2}x the time ({small:.4} -> {large:.4} ms)", large / small);
}

/// A plain v2 material: the draw's tint.
const TINT_V2: &str = "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> { return in.tint; }";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_level_two_draws_off_screen_cost_nothing_and_bind_each_material_once() {
    // LG-20 steps 1 and 2: a Level-2 draw outside the camera's frustum is not drawn (nor in the
    // prepass), and the frame's draws are sorted by material, so a pipeline is bound once per
    // material, not once per draw. What the frame shows is unchanged.
    use genex_render::abi::ABI_V2;
    use genex_render::immediate::{FrameRenderer, ImmediateFrame};
    let Some(gpu) = gpu() else { return };
    let mut frames = FrameRenderer::new(&gpu, WIDTH, HEIGHT, genex_render::RenderOptions::default()).expect("renderer");
    let materials = [0, 1].map(|_| frames.add_material_api(&gpu, ABI_V2, TINT_V2, &[], &[]).expect("a v2 material"));
    let camera = CameraDesc::look_at([0.0, 2.0, 12.0], [0.0, 1.0, 0.0]);
    let draws = |behind: usize| {
        let mut frame = ImmediateFrame::new(camera, [16, 18, 24, 255]);
        // Ten on screen, alternating materials; `behind` more behind the camera.
        for i in 0..10 {
            frame.custom(MeshId::CUBE, translation(i as f32 * 1.2 - 5.4, 1.0, 0.0), materials[i % 2], [200, 120 + 10 * i as u8, 90, 255]);
        }
        for i in 0..behind {
            frame.custom(MeshId::CUBE, translation(i as f32 - 45.0, 1.0, 40.0), materials[i % 2], [255, 255, 255, 255]);
        }
        frame
    };
    frames.render(&gpu, &draws(0), genex_render::CullPath::Gpu, None).expect("frame");
    let alone = frames.capture(&gpu).expect("capture");
    let (drawn_alone, binds_alone) = frames.custom_material_draws();
    frames.render(&gpu, &draws(90), genex_render::CullPath::Gpu, None).expect("frame");
    let with_hidden = frames.capture(&gpu).expect("capture");
    let (drawn, binds) = frames.custom_material_draws();
    assert_eq!(alone.digest(), with_hidden.digest(), "draws behind the camera change nothing on screen");
    assert_eq!((drawn_alone, binds_alone), (10, 2), "ten draws, two materials: two pipeline binds");
    assert_eq!((drawn, binds), (10, 2), "the ninety draws behind the camera are culled on the CPU");
}

/// A v2 material whose fragment reads its draw's own row (`gx_draw`): the model's translation and
/// the draw's index in the frame, so a row shared by the instances of a call would show.
const DRAW_ROW_V2: &str = "@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {
    let place = gx_draw.model[3].xyz;
    let moved = gx_draw.prev_model[3].x - place.x;
    return vec4<f32>(fract(gx_draw.params.y * 0.13), place.x * 0.05 + 0.5, in.tint.b + moved, 1.0);
}";

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_repeated_level_two_pairs_draw_as_one_instanced_call_each_reading_its_own_row() {
    // LG-20 step 3: the draws of one (material, mesh) pair are one instanced call, and a fragment
    // that reads `gx_draw` (its model, last frame's model, its index in the frame) still reads its
    // own draw's row. The picture equals the one drawn with a material per draw (no pair repeats,
    // so nothing is instanced).
    use genex_render::abi::ABI_V2;
    use genex_render::immediate::{FrameRenderer, ImmediateFrame};
    let Some(gpu) = gpu() else { return };
    let mut frames = FrameRenderer::new(&gpu, WIDTH, HEIGHT, genex_render::RenderOptions::default()).expect("renderer");
    let sources = [TINT_V2, DRAW_ROW_V2];
    let shared = sources.map(|source| frames.add_material_api(&gpu, ABI_V2, source, &[], &[]).expect("a v2 material"));
    let own: Vec<_> = (0..12).map(|i| frames.add_material_api(&gpu, ABI_V2, sources[i % 2], &[], &[]).expect("a v2 material")).collect();
    let camera = CameraDesc::look_at([0.0, 3.0, 14.0], [0.0, 1.0, 0.0]);
    let draws = |material: &dyn Fn(usize) -> genex_render::extension::CustomMaterialId| {
        let mut frame = ImmediateFrame::new(camera, [16, 18, 24, 255]);
        // Twelve on screen: two rows, cubes and spheres alternating, the two sources alternating.
        for i in 0..12 {
            let mesh = if (i / 2) % 2 == 0 { MeshId::CUBE } else { MeshId::SPHERE };
            let (x, y) = ((i % 6) as f32 * 2.2 - 5.5, if i < 6 { 0.5 } else { 3.0 });
            frame.custom(mesh, translation(x, y, 0.0), material(i), [200, 120 + 10 * i as u8, 40 + 15 * i as u8, 255]);
        }
        frame
    };
    frames.render(&gpu, &draws(&|i| own[i]), genex_render::CullPath::Gpu, None).expect("frame");
    frames.render(&gpu, &draws(&|i| own[i]), genex_render::CullPath::Gpu, None).expect("frame");
    let reference = frames.capture(&gpu).expect("capture");
    let calls_alone = frames.custom_material_draw_calls();
    frames.render(&gpu, &draws(&|i| shared[i % 2]), genex_render::CullPath::Gpu, None).expect("frame");
    frames.render(&gpu, &draws(&|i| shared[i % 2]), genex_render::CullPath::Gpu, None).expect("frame");
    let instanced = frames.capture(&gpu).expect("capture");
    let calls = frames.custom_material_draw_calls();
    let (drawn, binds) = frames.custom_material_draws();
    write_evidence("lg20-step3-per-draw", &reference);
    write_evidence("lg20-step3-instanced", &instanced);
    assert_eq!(calls_alone, 12, "a material per draw: every draw is its own call");
    assert_eq!((drawn, binds), (12, 2), "twelve draws over two materials");
    assert_eq!(calls, 4, "two materials over two meshes: four instanced calls");
    assert_eq!(reference.digest(), instanced.digest(), "every instance reads its own draw's row");
}

/// The ledger's model of a frame's buffers may differ from the bytes held by at most this share.
const BUFFER_MODEL_TOLERANCE: f64 = 0.05;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_ledger_counts_the_buffers_a_scatter_frame_holds_within_five_percent() {
    // LG-13: a 50k-instance scatter with sun shadows and binned local lights. The ledger's buffer
    // entries are what the renderer holds after the frame (every table, the mesh library, the
    // frame's uniforms and the nodes' own buffers), and its model of the frame from the scene's
    // counts is within 5% of them.
    use genex_render::budget::{BudgetInput, BudgetKind, ledger};
    use genex_render::scene::PointLight;
    use genex_render::settings::{Quality, QualityPreset, SceneFormat};
    let Some(gpu) = gpu() else { return };
    let class = genex_render::device_class::DeviceClass::from_wire("desktop-high").expect("a class");
    let quality: Quality = genex_render::presets::preset_quality(QualityPreset::High, class);
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.set_quality(&quality);
    let mut scene = scatter_scene(50_000, &[(MeshId::SPHERE, 2_000)], true);
    for i in 0..64 {
        scene.lighting.points.push(PointLight { position: [(i % 8) as f32 * 20.0 - 70.0, 2.0, (i / 8) as f32 * 20.0 - 70.0], range: 12.0, color: [255, 220, 180], intensity: 4.0 });
    }
    renderer.render(&gpu, &scene, genex_render::CullPath::Gpu).expect("frame");
    let held = renderer.buffer_ledger();
    let held_bytes = held.total_of(BudgetKind::Buffers);
    let instance_table = 50_000 * size_of::<genex_render::layout::GpuInstance>() as u64;
    assert!(held_bytes >= instance_table, "the ledger counts the instance table at least ({held_bytes} bytes)");
    for entry in held.entries() {
        assert_eq!(entry.kind, BudgetKind::Buffers);
        assert!(entry.bytes > 0, "{} holds bytes", entry.label);
    }
    let input = BudgetInput::new((WIDTH, HEIGHT), 1.0, SceneFormat::Rgba16Float, false).with_buffers(&held);
    let total = ledger(&quality, &input);
    assert_eq!(total.total_of(BudgetKind::Buffers), held_bytes, "the fit's ledger reads the held buffers");
    let model = renderer.buffer_model(&scene).expect("model");
    let error = (model as f64 - held_bytes as f64).abs() / held_bytes as f64;
    // What the device holds besides: the nodes' own uniforms and the upload arena's staging chunks
    // (wgpu's count of live buffers; evidence, not a gate: other node modules' small rows).
    let device_buffers = gpu.device.get_internal_counters().hal.buffers.read();
    eprintln!("buffers held {held_bytes} bytes in {} entries ({device_buffers} live on the device), model {model} bytes ({:.2}% off)", held.entries().len(), error * 100.0);
    write_perf("A0-buffer-ledger.json", &serde_json::json!({
        "row": "buffer-ledger", "instances": 52_000, "device_buffers": device_buffers, "held_bytes": held_bytes, "model_bytes": model, "error": error,
        "entries": held.entries().iter().map(|entry| serde_json::json!([entry.label, entry.bytes])).collect::<Vec<_>>(),
    }));
    assert!(error <= BUFFER_MODEL_TOLERANCE, "the model is {:.1}% off the held bytes", error * 100.0);
}

// --- A.0b: retained static instance groups ---

/// A scene of a retained group of `models` cubes plus loose spheres and one loose cube (the
/// group's mesh: it batches with the group's rows, after them), or the same through
/// `draw_instanced`.
fn grouped_scene(group: Option<&genex_render::retained::InstanceGroup>, models: &[[f32; 16]], shadows: bool) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 40.0, 160.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.shadows = shadows;
    let material = Material::color([200, 180, 160, 255]);
    match group {
        Some(group) => scene.draw_group(group),
        None => scene.draw_instanced(MeshId::CUBE, models, material),
    };
    scene.draw(MeshId::CUBE, translation(0.0, 3.0, 0.0), material);
    scene.draw_instanced(MeshId::SPHERE, &scatter_models(300, 0x0BA7_C400), Material::color([90, 140, 90, 255]));
    scene
}

#[test]
fn a_retained_group_plans_the_rows_its_instanced_draw_plans() {
    use genex_render::retained::InstanceGroup;
    use genex_render::scene::MeshLibrary;
    let models = scatter_models(5_000, 0x5CA7_7E25);
    let group = InstanceGroup::new(MeshId::CUBE, Material::color([200, 180, 160, 255]), models.clone()).expect("group");
    let library = MeshLibrary::new();
    for shadows in [false, true] {
        let retained = FramePlan::build(&grouped_scene(Some(&group), &models, shadows), &library, 16.0 / 9.0).expect("plan");
        let instanced = FramePlan::build(&grouped_scene(None, &models, shadows), &library, 16.0 / 9.0).expect("plan");
        assert_eq!(retained.instances, instanced.instances, "the same rows in the same places");
        assert_eq!((retained.batches.clone(), retained.slot_base.clone(), retained.materials.clone()), (instanced.batches.clone(), instanced.slot_base.clone(), instanced.materials.clone()));
        assert_eq!((retained.cull_views, retained.views, retained.logical_draws), (instanced.cull_views, instanced.views, instanced.logical_draws));
        assert_eq!(retained.retained.len(), 1);
        assert_eq!((retained.retained[0].first_row, retained.retained[0].rows), (0, 5_000), "the group's rows lead its mesh's batch");
        assert!(instanced.retained.is_empty());
    }
}

#[test]
fn only_the_rows_a_group_changed_or_moved_are_uploaded_again() {
    use genex_render::retained::InstanceGroup;
    use genex_render::scene::MeshLibrary;
    use genex_render::tables::instance_upload_ranges;
    let library = MeshLibrary::new();
    let models = scatter_models(1_000, 7);
    let mut group = InstanceGroup::new(MeshId::CUBE, Material::color([200, 180, 160, 255]), models.clone()).expect("group");
    let plan = |group: &InstanceGroup| FramePlan::build(&grouped_scene(Some(group), &models, false), &library, 1.0).expect("plan");
    let first = plan(&group);
    let rows = first.instances.len();
    assert_eq!(instance_upload_ranges(rows, &first.retained, None), vec![0..rows], "a new table: every row");
    let again = plan(&group);
    assert_eq!(instance_upload_ranges(rows, &again.retained, Some(&first.retained)), vec![1_000..rows], "the group's rows are held: only the loose rows");
    group.update(100, &scatter_models(20, 8)).expect("update");
    let updated = plan(&group);
    assert_eq!(instance_upload_ranges(rows, &updated.retained, Some(&first.retained)), vec![100..120, 1_000..rows], "only the updated rows");
    // A frame drawing another group first moves this one: all of it again.
    let other = InstanceGroup::new(MeshId::CUBE, Material::color([200, 180, 160, 255]), scatter_models(10, 9)).expect("group");
    let mut moved_scene = grouped_scene(Some(&other), &models, false);
    moved_scene.draw_group(&group);
    let moved = FramePlan::build(&moved_scene, &library, 1.0).expect("plan");
    assert_eq!(instance_upload_ranges(moved.instances.len(), &moved.retained, Some(&updated.retained)), vec![0..moved.instances.len()]);
    // Hostile held spans (past the table, other groups) never skip a row they do not cover.
    let empty = instance_upload_ranges(0, &[], Some(&first.retained));
    assert!(empty.is_empty());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_static_retained_scatter_uploads_its_rows_once_and_draws_what_draw_instanced_draws() {
    use genex_render::retained::InstanceGroup;
    let Some(gpu) = gpu() else { return };
    let models = scatter_models(50_000, 0x5CA7_7E25);
    let mut group = InstanceGroup::new(MeshId::CUBE, Material::color([200, 180, 160, 255]), models.clone()).expect("group");
    let row = size_of::<genex_render::layout::GpuInstance>() as u64;
    let mut instanced = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut retained = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut uploads = Vec::new();
    for frame in 0..3 {
        instanced.render(&gpu, &grouped_scene(None, &models, true), genex_render::CullPath::Gpu).expect("frame");
        retained.render(&gpu, &grouped_scene(Some(&group), &models, true), genex_render::CullPath::Gpu).expect("frame");
        uploads.push((instanced.last_instance_upload_bytes(), retained.last_instance_upload_bytes()));
        let (single, grouped) = (instanced.capture(&gpu).expect("capture"), retained.capture(&gpu).expect("capture"));
        write_evidence(&format!("retained-frame{frame}"), &grouped);
        assert_eq!(single.digest(), grouped.digest(), "frame {frame}: the same picture");
    }
    let loose = 301 * row;
    assert_eq!(uploads[0], (50_301 * row, 50_301 * row), "the first frame writes every row");
    assert_eq!(uploads[1], (50_301 * row, loose), "a static group's rows are not written again (draw_instanced writes them every frame)");
    group.update(1_000, &scatter_models(100, 3)).expect("update");
    let mut moved = models.clone();
    moved[1_000..1_100].copy_from_slice(&scatter_models(100, 3));
    instanced.render(&gpu, &grouped_scene(None, &moved, true), genex_render::CullPath::Gpu).expect("frame");
    retained.render(&gpu, &grouped_scene(Some(&group), &models, true), genex_render::CullPath::Gpu).expect("frame");
    assert_eq!(retained.last_instance_upload_bytes(), loose + 100 * row, "an update writes its rows only");
    let (single, grouped) = (instanced.capture(&gpu).expect("capture"), retained.capture(&gpu).expect("capture"));
    write_evidence("retained-updated", &grouped);
    assert_eq!(single.digest(), grouped.digest(), "the updated picture");
    eprintln!("instance uploads per frame (instanced, retained): {uploads:?}");
}
