//! A frame's uploads (renderer pass 2, P2-0.16, RC-08): graph node 1 writes the frame's uniforms,
//! cull views and tables from an upload arena the renderer keeps, so a frame after the first makes
//! no driver buffer for them (`queue.write_buffer` made and freed one staging buffer per call:
//! about fifteen a frame). The count is wgpu's own (`Device::get_internal_counters`, the
//! `counters` feature of the test build): the buffers alive right after a frame's submission,
//! against those alive before it, with the GPU idle on both sides of the frames before.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test uploads --offline --locked -- --ignored metal

use genex_render::scene::{CameraDesc, Material, MeshId, PointLight, Scene, translation};
use genex_render::{CullPath, Gpu, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// Frames drawn (each waited for) before the counted one: the arena's chunks are made by then.
const WARM_FRAMES: usize = 4;
/// The driver buffers wgpu's indirect-call validation makes for a GPU-path frame (the pass that
/// checks indirect draw arguments; 3 on an M4 Max, 0 on a device opened without it, 2026-10-14).
const INDIRECT_VALIDATION_BUFFERS: isize = 3;

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

/// A row of lit cubes under a point light: every table the frame writes holds rows.
fn scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
    scene.lighting.points.push(PointLight { position: [2.0, 3.0, 2.0], range: 10.0, color: [255, 200, 120], intensity: 3.0 });
    for i in 0..24 {
        let x = i as f32 * 0.5 - 6.0;
        scene.draw(MeshId::CUBE, translation(x, 0.0, -(i % 4) as f32), Material::color([200, 80 + i as u8 * 4, 60, 255]).with_pbr(0.2, 0.5));
    }
    scene.line([-3.0, 2.8, 0.0], [3.0, 2.8, 0.0], [255, 255, 255, 255]);
    scene
}

/// The driver buffers alive now (wgpu's HAL counter).
fn live_buffers(gpu: &Gpu) -> isize {
    gpu.device.get_internal_counters().hal.buffers.read()
}

fn idle(gpu: &Gpu) {
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the GPU finishes");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_graph_node_one_makes_no_staging_buffer_after_the_first_frame() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let scene = scene();
    // `cull_only` is graph node 1's uploads and the compute cull (which writes nothing from the CPU).
    for _ in 0..WARM_FRAMES {
        renderer.cull_only(&gpu, &scene).expect("uploads and cull");
    }
    let before = live_buffers(&gpu);
    assert!(before > 0, "the test build counts driver buffers (wgpu's `counters` feature)");
    renderer.cull_only(&gpu, &scene).expect("uploads and cull");
    let made = live_buffers(&gpu) - before;
    assert_eq!(made, 0, "the uploads made {made} driver buffers");
}

/// The whole frame, both cull paths: the CPU path makes no driver buffer at all, and the GPU path
/// only wgpu's indirect-call validation's (no node of the default frame writes with
/// `queue.write_buffer` any more).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_frame_after_the_first_makes_no_staging_buffer_of_its_own() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let scene = scene();
    for path in [CullPath::Gpu, CullPath::Cpu] {
        for _ in 0..WARM_FRAMES {
            renderer.render(&gpu, &scene, path).expect("frame");
            idle(&gpu);
        }
        let before = live_buffers(&gpu);
        renderer.render(&gpu, &scene, path).expect("frame");
        let made = live_buffers(&gpu) - before;
        idle(&gpu);
        let allowed = if path == CullPath::Gpu { INDIRECT_VALIDATION_BUFFERS } else { 0 };
        assert!(made <= allowed, "{path:?}: the frame made {made} driver buffers, at most {allowed} expected");
    }
}
