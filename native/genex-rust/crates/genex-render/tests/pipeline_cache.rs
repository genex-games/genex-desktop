//! The Vulkan pipeline cache (renderer pass 2, P2-0.16, RC-09): a device opened with
//! `PIPELINE_CACHE` (offered on Vulkan only) starts from the game's saved cache, its built-in
//! pipelines compile with it, and the compile pool writes it back when a burst of compiles ends.
//! The file is `genex-pipeline-cache/<wgpu's adapter key>.bin` in the game's saves (atomic and
//! symlink-refusing, genex-core's `Saves`). Metal, D3D12 and the web keep their own caches: no
//! file is made for them. This Mac has no Vulkan adapter, so the Vulkan half is not measured here.
//!
//! Late compiles (game systems R-20, EP-X1): a pipeline first asked for mid-game makes its frame
//! wait for the compile (the frontier's tick 1 waited 0.5 s cold on Metal for the vertex-skin path).
//! The first frame with a kind of content compiles every variant that content can take later: a
//! skinned draw that goes far (AN-18) and a dynamic-resolution step below scale 1 (TAAU, B.8)
//! compile nothing.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test pipeline_cache --offline --locked -- --include-ignored

use genex_core::saves::Saves;
use genex_render::compile::{PIPELINE_CACHE_FOLDER, compile_tally, keep_pipeline_caches_in, open_pipeline_cache, pipeline_cache_file, pipelines_since, save_pipeline_cache};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::motion::DrawId;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, translation};
use genex_render::settings::{AntiAliasing, Quality, SceneFormat};
use genex_render::skin::{Skeleton, SkeletonNode, SkinId, SkinnedMeshData, Trs};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use wgpu::{AdapterInfo, Backend, DeviceType};

fn adapter(backend: Backend) -> AdapterInfo {
    AdapterInfo {
        name: "test adapter".to_owned(),
        vendor: 0x13b5,
        device: 0x9876,
        device_type: DeviceType::IntegratedGpu,
        device_pci_bus_id: String::new(),
        driver: "test driver".to_owned(),
        driver_info: "1.0".to_owned(),
        backend,
        subgroup_min_size: 4,
        subgroup_max_size: 64,
        transient_saves_memory: None,
        limit_bucket: None,
    }
}

#[test]
fn only_a_vulkan_adapter_keeps_a_pipeline_cache_and_its_file_is_a_plain_save_name() {
    assert_eq!(pipeline_cache_file(&adapter(Backend::Vulkan)).as_deref(), Some("genex-pipeline-cache/wgpu_pipeline_cache_vulkan_5045_39030.bin"));
    for backend in [Backend::Metal, Backend::Dx12, Backend::BrowserWebGpu, Backend::Gl, Backend::Noop] {
        assert_eq!(pipeline_cache_file(&adapter(backend)), None, "{backend:?} keeps its own cache");
    }
}

/// A fresh save root (ending in its separator, as genex-core's save roots do).
fn save_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("genex-pipeline-cache-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("a save root");
    root
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_keeps_no_pipeline_cache_and_writes_no_file() {
    let root = save_root("metal");
    keep_pipeline_caches_in(Some(Saves::at(Ok(format!("{}/", root.display())))));
    let gpu = match Gpu::headless() {
        Ok(gpu) => gpu,
        Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") => panic!("no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            return;
        }
    };
    let info = gpu.adapter().get_info();
    assert_eq!(info.backend, Backend::Metal, "this row is the Metal half");
    assert!(!gpu.device.features().contains(wgpu::Features::PIPELINE_CACHE), "Metal offers no wgpu pipeline cache");
    assert!(!open_pipeline_cache(&gpu.device, &info));
    let mut renderer = Renderer::new(&gpu, 64, 48).expect("renderer");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.0, 5.0], [0.0, 0.0, 0.0]), [10, 10, 10, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([200, 60, 40, 255]));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("a frame compiles and draws without a cache");
    assert!(!save_pipeline_cache(&gpu.device));
    assert!(!root.join(PIPELINE_CACHE_FOLDER).exists(), "no pipeline-cache file on Metal");
    keep_pipeline_caches_in(None);
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------------------------
// Late compiles (R-20)

/// The headless GPU, or None (skipped) when there is none and Metal is not required.
fn gpu() -> Option<Gpu> {
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1") => panic!("no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The HDR path with TAA, the prepass (motion) and TAA upscaling, as desktop high draws.
fn temporal_renderer(gpu: &Gpu) -> Renderer {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    quality.anti_aliasing = AntiAliasing::Taa;
    quality.taau = true;
    let mut renderer = Renderer::with_options(gpu, 160, 120, RenderOptions { msaa: false }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(&quality);
    renderer
}

/// A two-joint strip 0.4 m wide and 1.8 m tall (a character's size), its upper half on joint 1.
fn strip() -> SkinnedMeshData {
    let (columns, rows) = (4_u32, 12_u32);
    let mut vertices = Vec::new();
    let mut skin = Vec::new();
    for r in 0..rows {
        for c in 0..columns {
            let (u, v) = (c as f32 / (columns - 1) as f32, r as f32 / (rows - 1) as f32);
            vertices.push(Vertex { position: [(u - 0.5) * 0.4, v * 1.8, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
            let upper = u32::from(v > 0.5);
            skin.push(GpuSkinVertex { joints: [upper, 0, 0, 0], weights: [1.0, 0.0, 0.0, 0.0] });
        }
    }
    let mut indices = Vec::new();
    for r in 0..rows - 1 {
        for c in 0..columns - 1 {
            let a = r * columns + c;
            indices.extend([a, a + 1, a + columns + 1, a, a + columns + 1, a + columns]);
        }
    }
    let nodes = vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }, SkeletonNode { parent: Some(0), rest: Trs::IDENTITY }];
    let skeleton = Skeleton { nodes, joints: vec![0, 1], inverse_bind: vec![translation(0.0, 0.0, 0.0); 2], mesh_node: None };
    SkinnedMeshData { mesh: MeshData { vertices, indices }, skin, skeleton, animations: Vec::new() }
}

/// A lit, shadowed scene with the strip `distance` metres in front of the camera (None: no strip).
fn strip_at(skin: SkinId, distance: Option<f32>) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.9, 3.0], [0.0, 0.9, 0.0]), [20, 24, 30, 255]);
    scene.lighting.shadows = true;
    scene.lighting.sun_dir = [0.3, 0.6, 0.7];
    scene.draw(MeshId::CUBE, genex_render::scene::scaled([0.0, -0.05, 0.0], [40.0, 0.1, 40.0]), Material::color([180, 180, 180, 255]));
    if let Some(distance) = distance {
        scene.set_id(Some(DrawId::from_key("strip")));
        scene.draw_skinned(skin, translation(0.0, 0.0, 3.0 - distance), vec![translation(0.0, 0.0, 0.0); 2], Material::color([230, 140, 60, 255]));
    }
    scene
}

/// Draw `scene` as frame `index`: the labels of the pipelines it compiled.
fn compiled_by(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, index: u64) -> Vec<String> {
    let base = compile_tally();
    renderer.set_frame_index(index);
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
    pipelines_since(base)
}

/// The labels in `labels` that start with `prefix` (other tests in this binary compile alongside).
fn named<'a>(labels: &'a [String], prefix: &str) -> Vec<&'a String> {
    labels.iter().filter(|label| label.starts_with(prefix)).collect()
}

/// A character skins by compute near the camera and in the vertex stage far from it (AN-18). The
/// first frame of a renderer holding its skinned mesh compiled the vertex path's pipelines, so
/// neither the frame it first appears far (the frontier's agents at tick 1: 505 ms cold, red at the
/// R2 head) nor the frame it walks far compiles any.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_skinned_draw_going_far_compiles_nothing() {
    let Some(gpu) = gpu() else { return };
    for near_first in [false, true] {
        let mut renderer = temporal_renderer(&gpu);
        let skin = renderer.add_skinned_mesh(&gpu, &strip()).expect("skinned");
        let first = compiled_by(&gpu, &mut renderer, &strip_at(skin, None), 0);
        if near_first {
            compiled_by(&gpu, &mut renderer, &strip_at(skin, Some(0.0)), 1);
            assert_eq!(renderer.last_vertex_skinned_draws(), 0, "near, the strip skins by compute");
        }
        let far = compiled_by(&gpu, &mut renderer, &strip_at(skin, Some(150.0)), 2);
        assert_eq!(renderer.last_vertex_skinned_draws(), 1, "far, the strip skins in the vertex stage");
        eprintln!("near first {near_first}: first frame {:?}; far frame {far:?}", named(&first, "skin vertex"));
        assert_eq!(named(&far, "skin vertex"), Vec::<&String>::new(), "near first {near_first}: the far frame compiled the vertex path late");
    }
}

/// A dynamic-resolution step below scale 1 resolves by TAAU (B.8): its pipelines compiled with
/// TAA's on the first TAA frame, so the step compiles none (the frontier ride under load compiled
/// them mid-ride).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_dynamic_resolution_step_below_one_compiles_nothing() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = temporal_renderer(&gpu);
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 4.0], [0.0, 0.0, 0.0]), [20, 24, 30, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([200, 60, 40, 255]));
    let first = compiled_by(&gpu, &mut renderer, &scene, 0);
    compiled_by(&gpu, &mut renderer, &scene, 1);
    renderer.set_render_scale(0.67);
    let stepped = compiled_by(&gpu, &mut renderer, &scene, 2);
    let path = renderer.last_scene().expect("drawn");
    assert!(path.taau, "the step below 1 resolves by TAAU: {path:?}");
    eprintln!("first frame: {:?}; stepped frame: {stepped:?}", named(&first, "taau"));
    assert_eq!(named(&stepped, "taau"), Vec::<&String>::new(), "the step compiled TAAU late");
}
