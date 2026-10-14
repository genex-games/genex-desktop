//! Real-GPU rows, `#[ignore]`d so a machine without a GPU skips them; every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 bash scripts/spike/rust-wgpu/rust-env.sh cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! With `GENEX_REQUIRE_METAL=1` a missing adapter or a non-Metal backend fails instead of skipping.

use std::path::PathBuf;
use std::process::Command;

use genex_render::capture::{Capture, hex64};
use genex_render::mesh::MeshData;
use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, scaled, translation};
use genex_render::{CullPath, Gpu, RenderCode, Renderer, UPLOAD_MAX_BYTES_PER_FRAME};

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
/// Where the child run writes its digest.
const CHILD_OUT: &str = "GENEX_RENDER_CHILD_OUT";

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

/// A one-triangle GLB: the plan's GLB mesh path on the GPU.
fn triangle_glb() -> Vec<u8> {
    let positions: [f32; 9] = [-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.5, 0.0];
    let indices: [u16; 4] = [0, 1, 2, 0];
    let mut bin: Vec<u8> = positions.iter().flat_map(|f| f.to_le_bytes()).collect();
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    let mut json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"bufferViews":[{{"buffer":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":6}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[-1,0,0],"max":[1,1.5,0]}},{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}]}}"#,
        bin.len()
    )
    .into_bytes();
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut out = b"glTF".to_vec();
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// The fixed scene: lit cubes and spheres, a GLB triangle, a missing-model checker, a line, and
/// instances well outside the frustum (behind, left and far) so culling has work to do.
fn fixed_scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let triangle = renderer.add_mesh(gpu, MeshData::from_glb(&triangle_glb()).expect("glb")).expect("upload");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 9.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
    scene.lighting.points.push(PointLight { position: [2.0, 3.0, 2.0], range: 10.0, color: [255, 200, 120], intensity: 3.0 });
    let colors = [[230, 41, 55, 255], [0, 228, 48, 255], [0, 121, 241, 255], [253, 249, 0, 255]];
    for (i, color) in colors.iter().enumerate() {
        let x = i as f32 * 1.8 - 2.7;
        scene.draw(MeshId::CUBE, translation(x, 0.0, 0.0), Material::color(*color).with_pbr(0.1 * i as f32, 0.5));
        scene.draw(MeshId::SPHERE, translation(x, 1.6, -1.0), Material::color(*color).with_pbr(0.8, 0.25));
    }
    scene.draw(MeshId::CUBE, scaled([0.0, -0.75, 0.0], [12.0, 0.2, 8.0]), Material::color([90, 90, 100, 255]));
    scene.draw(triangle, translation(0.0, 0.2, 2.0), Material::color([255, 161, 0, 255]));
    scene.draw(MeshId::SPHERE, translation(2.5, 0.2, 2.5), Material::missing());
    for culled in [translation(0.0, 0.0, 40.0), translation(-300.0, 0.0, 0.0), translation(0.0, 0.0, -5000.0)] {
        scene.draw(MeshId::CUBE, culled, Material::color([255, 255, 255, 255]));
        scene.draw(MeshId::SPHERE, culled, Material::color([255, 255, 255, 255]));
    }
    scene.line([-3.0, 2.8, 0.0], [3.0, 2.8, 0.0], [255, 255, 255, 255]);
    scene
}

fn render_fixed(path: CullPath) -> Option<(Capture, Renderer, Gpu)> {
    let gpu = gpu()?;
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let scene = fixed_scene(&mut renderer, &gpu);
    renderer.render(&gpu, &scene, path).expect("render");
    let capture = renderer.capture(&gpu).expect("capture");
    Some((capture, renderer, gpu))
}

fn assert_non_blank(capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    assert_eq!(capture.bgra().len(), (WIDTH * HEIGHT * 4) as usize);
    let clear = [28u8, 20, 18, 255]; // BGRA of the clear colour: stored as-is, no swizzle needed
    let pixels: Vec<&[u8]> = capture.bgra().chunks(4).collect();
    assert_eq!(pixels[0], clear, "the top-left corner is the clear colour, top row first");
    let drawn = pixels.iter().filter(|p| **p != clear).count();
    assert!(drawn > pixels.len() / 10, "only {drawn} pixels differ from the clear colour");
    assert!(pixels.iter().all(|p| p[3] == 255), "captures are opaque");
    let mut distinct: Vec<&[u8]> = pixels.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert!(distinct.len() > 50, "lit shading gives many colours, got {}", distinct.len());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_receipt_reports_tier_core_the_backend_and_offered_features() {
    let Some(gpu) = gpu() else { return };
    let receipt = gpu.receipt();
    assert_eq!(receipt.tier.wire(), "core");
    assert!(!receipt.backend.is_empty());
    eprintln!("receipt: {}", receipt.to_json());
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).expect("receipt JSON");
    assert_eq!(json["tier"], "core");
    assert_eq!(json["backend"], receipt.backend);
    assert!(json["nativeEnhanced"].is_array());
    write_evidence("receipt.json", &receipt.to_json());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_fixed_scene_child_capture_is_non_blank() {
    let Some((capture, _, _)) = render_fixed(CullPath::Gpu) else { return };
    assert_non_blank(&capture);
    if let Ok(out) = std::env::var(CHILD_OUT) {
        std::fs::write(out, hex64(capture.digest())).expect("child digest");
    } else {
        write_evidence_bytes(&format!("fixed-scene-{WIDTH}x{HEIGHT}.bgra"), capture.bgra());
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_capture_is_bit_identical_over_two_process_runs() {
    let Some((capture, _, _)) = render_fixed(CullPath::Gpu) else { return };
    let digests: Vec<String> = (0..2).map(child_digest).collect();
    assert_eq!(digests[0], digests[1], "two processes rendered different pixels");
    assert_eq!(digests[0], hex64(capture.digest()), "a child and this process differ");
    write_evidence("fixed-scene-digest.txt", &format!("{}\n", digests[0]));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_compute_culled_indirect_draws_equal_the_cpu_culled_direct_reference() {
    let Some((gpu_capture, renderer, gpu)) = render_fixed(CullPath::Gpu) else { return };
    let args = renderer.read_indirect_args(&gpu).expect("indirect args");
    let Some((cpu_capture, cpu_renderer, _)) = render_fixed(CullPath::Cpu) else { return };
    let cpu = cpu_renderer.last_cpu_cull().expect("the CPU path keeps its cull");
    let counts: Vec<u32> = args.iter().map(|a| a.instance_count).collect();
    assert_eq!(counts, cpu.counts, "the compute pass kept the same instances as the CPU cull");
    assert!(cpu.counts.iter().sum::<u32>() < renderer.last_plan_instances(), "something was culled");
    assert_eq!(gpu_capture.digest(), cpu_capture.digest(), "indirect and direct frames differ (tolerance 0)");
    assert_eq!(gpu_capture.bgra(), cpu_capture.bgra());
}

/// 300 cubes on a line through the frustum, interleaved with 300 far behind the camera: batches
/// span several 64-instance chunks of the cull's prefix sum, with survivors in every chunk.
fn crowd() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 30.0], [0.0, 0.0, 0.0]), [10, 10, 10, 255]);
    for i in 0..300 {
        let x = (i as f32 - 150.0) * 0.5;
        let color = [(i * 7 % 256) as u8, (i * 13 % 256) as u8, 200, 255];
        scene.draw(MeshId::CUBE, scaled([x, (i % 5) as f32 - 2.0, 0.0], [0.3, 0.3, 0.3]), Material::color(color));
        scene.draw(MeshId::CUBE, translation(x, 0.0, 60.0), Material::color([255, 255, 255, 255]));
        scene.draw(MeshId::SPHERE, scaled([x, 3.0, -2.0], [0.2, 0.2, 0.2]), Material::color(color));
    }
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cull_matches_the_cpu_cull_across_many_workgroup_chunks() {
    let Some(gpu) = gpu() else { return };
    let scene = crowd();
    let mut gpu_path = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    gpu_path.render(&gpu, &scene, CullPath::Gpu).expect("gpu frame");
    let mut cpu_path = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    cpu_path.render(&gpu, &scene, CullPath::Cpu).expect("cpu frame");
    let cpu = cpu_path.last_cpu_cull().expect("cpu cull").clone();
    let gpu_counts: Vec<u32> = gpu_path.read_indirect_args(&gpu).expect("args").iter().map(|a| a.instance_count).collect();
    assert_eq!(gpu_counts, cpu.counts);
    assert!(cpu.counts[0] > 64 && cpu.counts[0] < 600, "cubes survive in several chunks: {:?}", cpu.counts);
    let (a, b) = (gpu_path.capture(&gpu).expect("capture"), cpu_path.capture(&gpu).expect("capture"));
    assert_eq!(a.digest(), b.digest(), "indirect and direct frames differ (tolerance 0)");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_upload_over_the_frame_budget_is_refused_and_draws_nothing() {
    let Some((before, mut renderer, gpu)) = render_fixed(CullPath::Gpu) else { return };
    let per_instance = std::mem::size_of::<genex_render::layout::GpuInstance>() as u64;
    let too_many = UPLOAD_MAX_BYTES_PER_FRAME / per_instance + 1;
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0]), [255, 0, 0, 255]);
    for i in 0..too_many {
        scene.draw(MeshId::CUBE, translation(i as f32, 0.0, 0.0), Material::color([1, 2, 3, 255]));
    }
    let error = renderer.render(&gpu, &scene, CullPath::Gpu).expect_err("over the upload budget");
    assert_eq!(error.code(), RenderCode::UploadBudget);
    let after = renderer.capture(&gpu).expect("capture");
    assert_eq!(after.digest(), before.digest(), "the refused frame changed nothing");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_present_letterboxes_the_world_target_into_a_wider_window() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, 100, 100).expect("renderer");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0]), [200, 100, 50, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([255, 255, 255, 255]));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("render");
    let world = renderer.capture(&gpu).expect("world");
    let window = renderer.present_to_texture(&gpu, (300, 100)).expect("present");
    let px = |c: &Capture, x: u32, y: u32| -> [u8; 4] {
        let i = ((y * c.width() + x) * 4) as usize;
        c.bgra()[i..i + 4].try_into().expect("pixel")
    };
    assert_eq!(px(&window, 10, 50), [0, 0, 0, 255], "left bar");
    assert_eq!(px(&window, 290, 50), [0, 0, 0, 255], "right bar");
    assert_eq!(px(&window, 105, 5), px(&world, 5, 5), "the world's corner at the letterbox origin");
    assert_eq!(px(&window, 150, 50), px(&world, 50, 50), "the world's centre at the window's centre");
}

fn child_digest(run: usize) -> String {
    let out = std::env::temp_dir().join(format!("genex-render-child-{}-{run}.txt", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let status = Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", "metal_fixed_scene_child_capture_is_non_blank", "--test-threads=1"])
        .env(CHILD_OUT, &out)
        .status()
        .expect("child run");
    assert!(status.success(), "child run {run} failed");
    let digest = std::fs::read_to_string(&out).expect("child wrote its digest");
    let _ = std::fs::remove_file(&out);
    digest
}

/// Evidence for the run log, when the caller names a folder.
fn write_evidence(name: &str, text: &str) {
    write_evidence_bytes(name, text.as_bytes());
}

fn write_evidence_bytes(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_model_s_parts_upload_the_mesh_library_once() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, 64, 64).expect("renderer");
    let part = MeshData::from_glb(&triangle_glb()).expect("glb");
    let (before, meshes) = (renderer.mesh_uploads(), renderer.library().len());
    let ids = renderer.add_meshes(&gpu, vec![part.clone(), part.clone(), part]).expect("parts");
    assert_eq!(renderer.mesh_uploads(), before + 1, "one upload for every part");
    assert_eq!(renderer.library().len(), meshes + 3);
    assert!(ids[0] != ids[1] && ids[1] != ids[2], "{ids:?}");
}
