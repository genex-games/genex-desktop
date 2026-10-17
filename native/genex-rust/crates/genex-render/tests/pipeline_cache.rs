//! The Vulkan pipeline cache (renderer pass 2, P2-0.16, RC-09): a device opened with
//! `PIPELINE_CACHE` (offered on Vulkan only) starts from the game's saved cache, its built-in
//! pipelines compile with it, and the compile pool writes it back when a burst of compiles ends.
//! The file is `genex-pipeline-cache/<wgpu's adapter key>.bin` in the game's saves (atomic and
//! symlink-refusing, genex-core's `Saves`). Metal, D3D12 and the web keep their own caches: no
//! file is made for them. This Mac has no Vulkan adapter, so the Vulkan half is not measured here.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test pipeline_cache --offline --locked -- --include-ignored

use genex_core::saves::Saves;
use genex_render::compile::{PIPELINE_CACHE_FOLDER, keep_pipeline_caches_in, open_pipeline_cache, pipeline_cache_file, save_pipeline_cache};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, translation};
use genex_render::{CullPath, Gpu, Renderer};
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
