//! Game systems AN-18: vertex-shader skinning for mid and far characters. A far plain skinned draw
//! skins in the vertex stage from the library's bind pose: it takes no skinning job, no skinned
//! output and no row of the plan, and draws what compute skinning draws (within 1 LSB). Near,
//! masked and transparent draws keep compute skinning.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test skin_vertex -- --include-ignored
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the captures (PNG), the memory and the frame-cost numbers.

use std::path::PathBuf;

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::motion::DrawId;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshLibrary, PlanOptions, Scene, translation};
use genex_render::settings::{AntiAliasing, Quality, QualityPreset, SceneFormat};
use genex_render::skin::{Skeleton, SkeletonNode, SkinId, SkinnedMeshData, Trs};
use genex_render::skin_vertex::{SKIN_VERTEX_BELOW_PX, SkinVertexPolicy, vertex_skinned_draws};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};

/// The vertex path's skinned memory may be at most this share of the all-compute figure (AN-18).
const VERTEX_MEMORY_SHARE_MAX: f64 = 0.25;
const WIDTH: u32 = 192;
const HEIGHT: u32 = 192;

// ---------------------------------------------------------------------------------------------
// Fixtures

/// A two-joint strip of `columns` x `rows` vertices, 0.4 m wide and 1.8 m tall: the lower half
/// follows joint 0, the upper half joint 1, blended across the middle (a knee).
fn bending_strip(columns: u32, rows: u32) -> SkinnedMeshData {
    let mut vertices = Vec::with_capacity((columns * rows) as usize);
    let mut skin = Vec::with_capacity((columns * rows) as usize);
    for r in 0..rows {
        for c in 0..columns {
            let (u, v) = (c as f32 / (columns - 1) as f32, r as f32 / (rows - 1) as f32);
            vertices.push(Vertex { position: [(u - 0.5) * 0.4, v * 1.8, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
            let upper = ((v - 0.35) / 0.3).clamp(0.0, 1.0);
            skin.push(GpuSkinVertex { joints: [0, 1, 0, 0], weights: [1.0 - upper, upper, 0.0, 0.0] });
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
    let nodes = vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }, SkeletonNode { parent: Some(0), rest: Trs::IDENTITY }];
    let skeleton = Skeleton { nodes, joints: vec![0, 1], inverse_bind: vec![translation(0.0, 0.0, 0.0), translation(0.0, 0.0, 0.0)], mesh_node: None };
    SkinnedMeshData { mesh: MeshData { vertices, indices }, skin, skeleton, animations: Vec::new() }
}

/// The strip's palette with its knee bent by `angle` radians about z at 0.9 m.
fn bent(angle: f32) -> Vec<[f32; 16]> {
    let (s, c) = (libm::sinf(angle), libm::cosf(angle));
    let knee = 0.9;
    // T(0, knee) * Rz(angle) * T(0, -knee), column-major.
    let upper = [c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, knee * s, knee - knee * c, 0.0, 1.0];
    vec![translation(0.0, 0.0, 0.0), upper]
}

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.9, 3.2], [0.0, 0.9, 0.0])
}

fn orange() -> Material {
    Material::color([230, 140, 60, 255])
}

/// A scene drawing `skin` at each of `places` (x, z), bent by `angle`.
fn crowd(skin: SkinId, places: &[[f32; 2]], angle: f32) -> Scene {
    let mut scene = Scene::new(camera(), [20, 24, 30, 255]);
    scene.lighting.shadows = false;
    for (i, [x, z]) in places.iter().enumerate() {
        scene.set_id(Some(DrawId::from_key(&format!("strip-{i}"))));
        scene.draw_skinned(skin, translation(*x, 0.0, *z), bent(angle), orange());
    }
    scene
}

/// 200 places: `near` of them within 4 m of the camera, the rest 80 to 120 m out.
fn places(near: usize) -> Vec<[f32; 2]> {
    (0..200)
        .map(|i| {
            let x = (i % 20) as f32 - 9.5;
            if i < near { [x * 0.3, -0.5 - (i / 20) as f32] } else { [x * 4.0, -80.0 - (i / 20) as f32 * 4.0] }
        })
        .collect()
}

/// The 200 places (20 near), every draw its own pose on frame `frame`: no job is shared.
fn posed_crowd(skin: SkinId, frame: u64) -> Scene {
    let mut scene = crowd(skin, &[], 0.0);
    for (i, [x, z]) in places(20).iter().enumerate() {
        scene.set_id(Some(DrawId::from_key(&format!("strip-{i}"))));
        scene.draw_skinned(skin, translation(*x, 0.0, *z), bent(0.2 + 0.001 * i as f32 + 0.1 * frame as f32), orange());
    }
    scene
}

// ---------------------------------------------------------------------------------------------
// The plan

#[test]
fn far_plain_draws_take_the_vertex_path_and_no_job_output_or_row() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&bending_strip(4, 8)).expect("skinned");
    let scene = crowd(skin, &places(20), 0.4);
    let vertex = vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Auto);
    assert_eq!(vertex.iter().filter(|far| **far).count(), 180, "the 180 far draws, under {SKIN_VERTEX_BELOW_PX} px");
    assert!(vertex[..20].iter().all(|far| !far), "the near ones stay on compute skinning");
    let options = PlanOptions { shadows: None, depth_reversed: false, sun: None };
    let plan = FramePlan::build_with_skin_paths(&scene, &library, 1.0, &options, true, &vertex).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 1, "the near draws share one pose: one job");
    assert_eq!(plan.skinned_vertices, 32, "one output, for the near pose");
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(skinned.iter().map(|batch| batch.instance_count).sum::<u32>(), 20, "rows for the near draws only");
    assert_eq!(plan.vertex_skinned.len(), 180);
    assert!(plan.vertex_skinned.iter().all(|part| part.material == plan.vertex_skinned[0].material), "one material row");
    assert_eq!(plan.motion.len(), plan.instances.len());
}

#[test]
fn masked_and_transparent_draws_keep_compute_skinning_whatever_the_policy() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&bending_strip(4, 8)).expect("skinned");
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    let far = translation(0.0, 0.0, -100.0);
    scene.draw_skinned(skin, far, bent(0.2), orange());
    scene.draw_skinned(skin, far, bent(0.2), Material::color([230, 140, 60, 128]));
    let mut masked = orange();
    masked.alpha_cutoff = Some(0.5);
    scene.draw_skinned(skin, far, bent(0.2), masked);
    assert_eq!(vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Vertex), [true, false, false]);
    assert!(vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Compute).is_empty());
}

#[test]
fn a_compute_draw_never_shares_the_pose_of_a_vertex_skinned_one() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&bending_strip(4, 8)).expect("skinned");
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned(skin, translation(0.0, 0.0, -100.0), bent(0.2), orange());
    scene.draw_skinned(skin, translation(0.0, 0.0, -1.0), bent(0.2), orange());
    let vertex = vertex_skinned_draws(&scene, &library, SkinVertexPolicy::Auto);
    assert_eq!(vertex, [true, false]);
    let options = PlanOptions { shadows: None, depth_reversed: false, sun: None };
    let plan = FramePlan::build_with_skin_paths(&scene, &library, 1.0, &options, false, &vertex).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 1, "the near draw skins its own pose");
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(skinned.iter().map(|batch| batch.instance_count).sum::<u32>(), 1, "and draws its row");
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

fn evidence_dir() -> Option<PathBuf> {
    std::env::var("GENEX_RENDER_EVIDENCE_DIR").ok().map(PathBuf::from)
}

fn write_evidence(name: &str, bytes: &[u8]) {
    if let Some(dir) = evidence_dir() {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

fn write_png(name: &str, width: u32, height: u32, bgra: &[u8]) {
    let Some(dir) = evidence_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(dir.join(name), png(width, height, bgra)).expect("png");
}

/// An RGB PNG of a BGRA capture: zlib stored blocks, no compression (evidence only).
fn png(width: u32, height: u32, bgra: &[u8]) -> Vec<u8> {
    fn crc(bytes: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for byte in bytes {
            c ^= u32::from(*byte);
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
    let chunk = |out: &mut Vec<u8>, kind: &[u8], data: &[u8]| {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend(crc(&body).to_be_bytes());
    };
    let mut raw = Vec::with_capacity(((width * 3 + 1) * height) as usize);
    for row in bgra.chunks((width * 4) as usize) {
        raw.push(0);
        raw.extend(row.chunks(4).flat_map(|p| [p[2], p[1], p[0]]));
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend(len.to_le_bytes());
        zlib.extend((!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::new();
    header.extend(width.to_be_bytes());
    header.extend(height.to_be_bytes());
    header.extend([8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A renderer drawing motion vectors (TAA on the HDR path with the prepass), as the skinning
/// memory rows draw.
fn motion_renderer(gpu: &Gpu, width: u32, height: u32) -> Renderer {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    let mut renderer = Renderer::with_options(gpu, width, height, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_quality(&quality);
    renderer
}

/// The bytes the ledger holds under `label`.
fn held(renderer: &Renderer, label: &str) -> u64 {
    renderer.buffer_ledger().entries().iter().filter(|entry| entry.label == label).map(|entry| entry.bytes).sum()
}

/// Every skinned byte: compute skinning's output, last frame's copy and slots, and the vertex
/// path's table.
fn skinned_bytes(renderer: &Renderer) -> u64 {
    ["skinned vertices", "previous skinned vertices", "skinned slots", "vertex skin table"].iter().map(|label| held(renderer, label)).sum()
}

/// The largest channel difference of two BGRA captures.
fn max_difference(a: &[u8], b: &[u8]) -> u8 {
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)
}

/// One frame of a bent strip through `policy` on `renderer`: its capture, its skinning jobs and
/// its vertex-skinned draws.
fn picture(gpu: &Gpu, renderer: &mut Renderer, skin: SkinId, policy: SkinVertexPolicy, shadows: bool) -> (Vec<u8>, u32, usize) {
    renderer.set_skin_vertex_policy(policy);
    renderer.set_frame_index(0);
    let mut scene = crowd(skin, &[[0.0, 0.0]], 0.5);
    if shadows {
        // The strip casts onto a wall behind it (the sun casters' vertex path).
        scene.lighting.shadows = true;
        scene.lighting.sun_dir = [0.3, 0.5, 1.0];
        let wall = renderer.add_mesh(gpu, genex_render::mesh::MeshData::cube()).expect("wall");
        scene.draw(wall, genex_render::scene::scaled([0.0, 0.9, -0.6], [4.0, 4.0, 0.1]), Material::color([200, 200, 200, 255]));
    }
    renderer.render(gpu, &scene, CullPath::Gpu).expect("frame");
    (renderer.capture(gpu).expect("capture").bgra().to_vec(), renderer.last_stats().skin_jobs, renderer.last_vertex_skinned_draws())
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_vertex_skinned_instance_matches_the_compute_golden_within_one_lsb() {
    let Some(gpu) = gpu() else { return };
    let cases = [("legacy", false), ("taa", false), ("legacy-shadowed", true), ("taa-shadowed", true)];
    for (name, shadows) in cases {
        let mut renderer = if name.starts_with("taa") { motion_renderer(&gpu, WIDTH, HEIGHT) } else { Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer") };
        let skin = renderer.add_skinned_mesh(&gpu, &bending_strip(12, 48)).expect("skinned");
        let (golden, golden_jobs, golden_draws) = picture(&gpu, &mut renderer, skin, SkinVertexPolicy::Compute, shadows);
        let (vertex, vertex_jobs, vertex_draws) = picture(&gpu, &mut renderer, skin, SkinVertexPolicy::Vertex, shadows);
        write_png(&format!("an18-{name}-compute.png"), WIDTH, HEIGHT, &golden);
        write_png(&format!("an18-{name}-vertex.png"), WIDTH, HEIGHT, &vertex);
        let differing = golden.iter().zip(&vertex).filter(|(a, b)| a != b).count();
        let worst = max_difference(&golden, &vertex);
        eprintln!("{name}: compute {golden_jobs} jobs / {golden_draws} vertex draws; vertex {vertex_jobs} jobs / {vertex_draws} draws; {differing} channels differ, worst {worst}");
        assert_eq!((golden_jobs, golden_draws), (1, 0), "{name}: the golden is compute skinned");
        assert_eq!((vertex_jobs, vertex_draws), (0, 1), "{name}: the vertex path runs no job");
        let lit = vertex.chunks(4).filter(|p| p[2] > 120 && p[2] > p[0] + 40).count();
        assert!(lit > 1500, "{name}: the bent strip is on screen ({lit} orange pixels)");
        assert!(worst <= 1, "{name}: the vertex path is within 1 LSB of the compute golden (worst {worst}, {differing} channels)");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_two_hundred_far_instances_allocate_no_skinned_output() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = motion_renderer(&gpu, WIDTH, HEIGHT);
    let skin = renderer.add_skinned_mesh(&gpu, &bending_strip(12, 48)).expect("skinned");
    // What the tables hold with no skinned draw at all.
    renderer.render(&gpu, &Scene::new(camera(), [0, 0, 0, 255]), CullPath::Gpu).expect("empty frame");
    let none = ["skinned vertices", "previous skinned vertices", "skinned slots"].map(|label| held(&renderer, label));
    for frame in 0..2u64 {
        renderer.set_frame_index(frame);
        renderer.render(&gpu, &crowd(skin, &places(0), 0.3 + 0.1 * frame as f32), CullPath::Gpu).expect("frame");
    }
    let far = ["skinned vertices", "previous skinned vertices", "skinned slots"].map(|label| held(&renderer, label));
    let table = held(&renderer, "vertex skin table");
    let line = format!("200 far: skinned output/previous/slots {far:?} B (no draws: {none:?} B); vertex skin table {table} B; jobs {}; vertex draws {}\n", renderer.last_stats().skin_jobs, renderer.last_vertex_skinned_draws());
    eprint!("{line}");
    write_evidence("an18-far-memory.txt", line.as_bytes());
    assert_eq!(renderer.last_stats().skin_jobs, 0);
    assert_eq!(renderer.last_vertex_skinned_draws(), 200);
    assert_eq!(far, none, "200 far instances allocate no skinned-output byte past an empty frame's");
    assert!(table > 0 && table < 200 * 4 * 1024, "the records and palettes only: {table} B");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_twenty_near_and_one_hundred_eighty_far_hold_at_most_a_quarter_of_the_all_compute_memory() {
    let Some(gpu) = gpu() else { return };
    let measure = |policy: SkinVertexPolicy| {
        let mut renderer = motion_renderer(&gpu, WIDTH, HEIGHT);
        renderer.set_skin_vertex_policy(policy);
        let skin = renderer.add_skinned_mesh(&gpu, &bending_strip(50, 100)).expect("skinned");
        for frame in 0..2u64 {
            renderer.set_frame_index(frame);
            renderer.render(&gpu, &posed_crowd(skin, frame), CullPath::Gpu).expect("frame");
        }
        (skinned_bytes(&renderer), renderer.last_stats().skin_jobs)
    };
    let ((compute, compute_jobs), (mixed, mixed_jobs)) = (measure(SkinVertexPolicy::Compute), measure(SkinVertexPolicy::Auto));
    let share = mixed as f64 / compute as f64;
    let line = format!("20 near + 180 far, 5000 vertices each: all compute {compute} B ({compute_jobs} jobs); auto {mixed} B ({mixed_jobs} jobs); share {share:.3}\n");
    eprint!("{line}");
    write_evidence("an18-mixed-memory.txt", line.as_bytes());
    assert_eq!((compute_jobs, mixed_jobs), (200, 20));
    assert!(share <= VERTEX_MEMORY_SHARE_MAX, "skinned memory is {share:.3} of the all-compute figure (budget {VERTEX_MEMORY_SHARE_MAX})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_vertex_skinned_character_writes_motion_when_its_pose_moves_and_none_when_still() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = motion_renderer(&gpu, WIDTH, HEIGHT);
    renderer.set_depth_readback(true);
    renderer.set_skin_vertex_policy(SkinVertexPolicy::Vertex);
    let skin = renderer.add_skinned_mesh(&gpu, &bending_strip(12, 48)).expect("skinned");
    let mut frame = |index: u64, angle: f32| {
        renderer.set_frame_index(index);
        renderer.render(&gpu, &crowd(skin, &[[0.0, 0.0]], angle), CullPath::Gpu).expect("frame");
        renderer.read_motion(&gpu).expect("motion").iter().filter(|m| m[0].abs() + m[1].abs() > 1e-6).count()
    };
    let _ = frame(0, 0.4);
    let still = frame(1, 0.4);
    let moved = frame(2, 0.6);
    eprintln!("moving pixels: still {still}, bent further {moved}");
    assert_eq!(still, 0, "a still vertex-skinned character writes no motion");
    assert!(moved > 50, "its knee bending moves its upper half ({moved} pixels)");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_phone_proxy_frame_cost_is_recorded_for_both_paths() {
    let Some(gpu) = gpu() else { return };
    let phone = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid);
    let quality = preset_quality(QualityPreset::Medium, phone);
    let (width, height) = (1170 / 2, 540 / 2);
    let mut lines = String::new();
    for policy in [SkinVertexPolicy::Compute, SkinVertexPolicy::Auto] {
        let mut renderer = Renderer::with_options(&gpu, width, height, RenderOptions { msaa: false }).expect("renderer");
        renderer.set_quality(&quality);
        renderer.set_skin_vertex_policy(policy);
        let skin = renderer.add_skinned_mesh(&gpu, &bending_strip(50, 100)).expect("skinned");
        let frames = 24u64;
        let mut spent = Vec::new();
        for frame in 0..frames {
            renderer.set_frame_index(frame);
            let scene = posed_crowd(skin, frame);
            #[allow(clippy::disallowed_types, reason = "the phone-proxy row records the wall clock; no picture depends on it")]
            let start = std::time::Instant::now();
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
            let _ = renderer.capture(&gpu).expect("capture");
            spent.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        spent.drain(..4);
        spent.sort_by(f64::total_cmp);
        let median = spent[spent.len() / 2];
        lines.push_str(&format!("{policy:?}: {width}x{height} medium/mobile-mid, 20 near + 180 far x 5000 vertices: median {median:.2} ms render+readback over {} frames; jobs {}; vertex draws {}\n", spent.len(), renderer.last_stats().skin_jobs, renderer.last_vertex_skinned_draws()));
    }
    eprint!("{lines}");
    write_evidence("an18-phone-proxy.txt", lines.as_bytes());
}
