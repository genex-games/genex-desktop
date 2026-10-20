//! Game systems AN-16b: skinned memory and skinning work. Draws posing one skin with a
//! bit-identical palette share one job and its output; a job whose output the skinned table
//! already holds is skipped (a still character runs no skinning and writes no motion); the
//! skinned tables grow to what a frame needs (x1.25 steps), not to the next power of two.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test skinning_memory -- --include-ignored
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the memory numbers.

use std::path::PathBuf;

use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshLibrary, Scene, scaled, translation};
use genex_render::settings::{AntiAliasing, Quality, SceneFormat};
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};
use genex_render::tables::{SKINNED_GROWTH_GRANULE_BYTES, VERTEX_STRIDE, skinned_growth};
use genex_render::{BUFFER_MAX_BYTES, CullPath, Gpu, RenderOptions, Renderer};

/// The skinned memory may be at most this much of the exact need (AN-16b).
const SKINNED_MEMORY_RATIO_MAX: f64 = 1.3;
const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;

// ---------------------------------------------------------------------------------------------
// Fixtures

/// A one-joint skinned grid of `columns` x `rows` vertices in the XY plane, 1 m square.
fn skinned_grid(columns: u32, rows: u32) -> SkinnedMeshData {
    let mut vertices = Vec::with_capacity((columns * rows) as usize);
    for r in 0..rows {
        for c in 0..columns {
            let (u, v) = (c as f32 / (columns - 1) as f32, r as f32 / (rows - 1) as f32);
            vertices.push(Vertex { position: [u - 0.5, v, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
        }
    }
    let mut indices = Vec::new();
    for r in 0..rows - 1 {
        for c in 0..columns - 1 {
            let a = r * columns + c;
            let (b, d, e) = (a + 1, a + columns, a + columns + 1);
            indices.extend([a, b, e, a, e, d]);
        }
    }
    let mesh = MeshData { vertices, indices };
    let skin = vec![GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let skeleton = Skeleton { nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }], joints: vec![0], inverse_bind: vec![translation(0.0, 0.0, 0.0)], mesh_node: None };
    SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() }
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.5, 4.0], [0.0, 0.5, 0.0])
}

fn grey() -> Material {
    Material::color([200, 200, 200, 255])
}

// ---------------------------------------------------------------------------------------------
// The plan: shared palettes

#[test]
fn two_draws_with_identical_palettes_run_one_skin_job_and_share_its_output() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&skinned_grid(4, 4)).expect("skinned");
    let pose = vec![translation(0.0, 0.2, 0.0)];
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned(skin, translation(-1.0, 0.0, 0.0), pose.clone(), grey());
    scene.draw_skinned(skin, translation(1.0, 0.0, 0.0), pose.clone(), Material::color([90, 200, 90, 255]));
    let plan = FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 1, "one job for the shared pose (today one per draw)");
    assert_eq!(plan.joints.len(), 1, "one palette in the joint table");
    assert_eq!(plan.skinned_vertices, 16, "the output once");
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(skinned.len(), 1, "one batch drawing both rows");
    assert_eq!(skinned[0].instance_count, 2);
    let rows = skinned[0].first_row as usize..skinned[0].first_row as usize + 2;
    let models: Vec<f32> = plan.instances[rows.clone()].iter().map(|row| row.model[12]).collect();
    assert_eq!(models, [-1.0, 1.0], "each row keeps its own model, in draw order");
    assert_ne!(plan.instances[rows.start].material, plan.instances[rows.start + 1].material, "and its own material");
    assert_eq!(plan.motion.len(), plan.instances.len());
    assert!(plan.motion[rows].iter().all(|row| row.skinned_base == Some(0)), "both rows read the shared output");
}

#[test]
fn palettes_differing_in_one_bit_or_on_another_skin_run_their_own_jobs() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&skinned_grid(4, 4)).expect("skinned");
    let other = library.add_skinned(&skinned_grid(4, 4)).expect("skinned");
    let pose = translation(0.0, 0.2, 0.0);
    let mut negative_zero = pose;
    negative_zero[1] = -0.0;
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned(skin, translation(-1.0, 0.0, 0.0), vec![pose], grey());
    scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), vec![negative_zero], grey());
    scene.draw_skinned(other, translation(1.0, 0.0, 0.0), vec![pose], grey());
    scene.draw_skinned(skin, translation(2.0, 0.0, 0.0), vec![pose], grey());
    let plan = FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 3, "-0 is not 0 bit for bit; another skin is another job; the fourth draw shares the first's");
    assert_eq!(plan.skinned_vertices, 48);
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(skinned.iter().map(|batch| batch.instance_count).collect::<Vec<_>>(), [2, 1, 1]);
}

// ---------------------------------------------------------------------------------------------
// Table growth

#[test]
fn skinned_tables_grow_to_the_need_in_quarter_steps_not_to_the_next_power_of_two() {
    let mib = 1024 * 1024;
    let exact = 48_000_000;
    let first = skinned_growth(0, exact);
    assert!(first >= exact && first - exact < SKINNED_GROWTH_GRANULE_BYTES, "the first table is the need: {first}");
    assert!(first < 64 * mib, "not the next power of two");
    let grown = skinned_growth(first, first + 1);
    assert_eq!(grown % SKINNED_GROWTH_GRANULE_BYTES, 0);
    assert!(grown >= first * 5 / 4 && grown < first * 5 / 4 + SKINNED_GROWTH_GRANULE_BYTES, "a quarter more: {grown}");
    assert_eq!(skinned_growth(first, 2 * first), 2 * first, "a larger need is taken whole");
    assert_eq!(skinned_growth(0, 1152), 2048, "a small table stays the next power of two");
    assert_eq!(skinned_growth(120 * mib, 121 * mib), BUFFER_MAX_BYTES, "a quarter step stops at the binding");
    assert!(skinned_growth(0, BUFFER_MAX_BYTES + 1) > BUFFER_MAX_BYTES, "a need past the binding is left for the cap to refuse");
}

// ---------------------------------------------------------------------------------------------
// The GPU

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

/// A renderer drawing motion vectors (TAA on the HDR path), its prepass targets kept.
fn motion_renderer(gpu: &Gpu) -> Renderer {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality);
    renderer.set_depth_readback(true);
    renderer
}

/// The bytes the ledger holds under `label`.
fn held(renderer: &Renderer, label: &str) -> u64 {
    renderer.buffer_ledger().entries().iter().filter(|entry| entry.label == label).map(|entry| entry.bytes).sum()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_fifty_twenty_thousand_vertex_instances_allocate_at_most_1_3x_the_exact_skinned_bytes() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = motion_renderer(&gpu);
    let skin = renderer.add_skinned_mesh(&gpu, &skinned_grid(100, 200)).expect("skinned");
    let instances = 50u32;
    for frame in 0..2u64 {
        let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
        scene.lighting.shadows = false;
        for i in 0..instances {
            // Every instance and frame its own pose: no job is shared or skipped.
            let pose = translation(0.0, 0.01 * i as f32 + 0.1 * frame as f32, 0.0);
            scene.draw_skinned(skin, scaled([i as f32 * 0.1 - 2.5, 0.0, -3.0], [0.1; 3]), vec![pose], grey());
        }
        renderer.set_frame_index(frame);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        assert_eq!(renderer.last_stats().skin_jobs, instances);
    }
    let vertices = u64::from(instances) * 20_000;
    let exact = vertices * VERTEX_STRIDE * 2 + vertices * 4;
    let (output, previous, slots) = (held(&renderer, "skinned vertices"), held(&renderer, "previous skinned vertices"), held(&renderer, "skinned slots"));
    let total = output + previous + slots;
    let ratio = total as f64 / exact as f64;
    let line = format!("skinned output {output} B, previous {previous} B, slots {slots} B; exact {exact} B; ratio {ratio:.3}\n");
    eprint!("{line}");
    write_evidence("an16b-skinned-memory.txt", line.as_bytes());
    assert!(previous > 0, "the motion frame keeps last frame's skinned vertices");
    assert!(ratio <= SKINNED_MEMORY_RATIO_MAX, "skinned memory is {ratio:.3}x the exact need (budget {SKINNED_MEMORY_RATIO_MAX}x)");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_still_character_runs_no_skin_job_on_its_second_frame_and_writes_no_motion() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = motion_renderer(&gpu);
    let skin = renderer.add_skinned_mesh(&gpu, &skinned_grid(8, 8)).expect("skinned");
    let frame = |renderer: &mut Renderer, index: u64, lift: f32| {
        let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
        scene.lighting.shadows = false;
        scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), vec![translation(0.0, lift, 0.0)], grey());
        renderer.set_frame_index(index);
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        let moving = renderer.read_motion(&gpu).expect("motion").iter().filter(|m| m[0].abs() + m[1].abs() > 1e-6).count();
        (renderer.last_stats().skin_jobs, moving, renderer.read_skinned_vertices(&gpu).expect("skinned"))
    };
    let (first_jobs, _, first) = frame(&mut renderer, 0, 0.2);
    let (still_jobs, still_moving, still) = frame(&mut renderer, 1, 0.2);
    let (moved_jobs, moved_moving, _) = frame(&mut renderer, 2, 0.3);
    eprintln!("jobs {first_jobs}, {still_jobs}, {moved_jobs}; moving pixels when still {still_moving}, when moved {moved_moving}");
    assert_eq!(first_jobs, 1);
    assert_eq!(still_jobs, 0, "the still character's output is held (today 1)");
    assert!(still == first, "the held output is the first frame's");
    assert_eq!(still_moving, 0, "a still character writes no motion");
    assert_eq!(moved_jobs, 1, "a new pose skins again");
    assert!(moved_moving > 0, "and moves");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_shared_output_draws_exactly_what_two_jobs_draw() {
    let Some(gpu) = gpu() else { return };
    let picture = |share: bool| {
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        let skin = renderer.add_skinned_mesh(&gpu, &skinned_grid(8, 8)).expect("skinned");
        let pose = translation(0.0, 0.2, 0.0);
        // The same numbers, one bit apart: -0 is not shared.
        let mut twin = pose;
        twin[1] = if share { 0.0 } else { -0.0 };
        let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
        scene.lighting.shadows = false;
        scene.draw_skinned(skin, translation(-0.7, 0.0, 0.0), vec![pose], Material::color([220, 120, 40, 255]));
        scene.draw_skinned(skin, translation(0.7, 0.0, 0.0), vec![twin], Material::color([40, 140, 220, 255]));
        renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        (renderer.last_stats().skin_jobs, renderer.capture(&gpu).expect("capture").bgra().to_vec())
    };
    let ((shared_jobs, shared), (own_jobs, own)) = (picture(true), picture(false));
    assert_eq!((shared_jobs, own_jobs), (1, 2));
    write_evidence("an16b-shared.bgra", &shared);
    assert!(shared == own, "the shared output draws the same frame");
    assert!(shared.chunks(4).filter(|p| p[0] > 100).count() > 200, "the blue draw is on screen");
}
