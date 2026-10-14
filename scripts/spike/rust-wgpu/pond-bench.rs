//! M0a.8 matched-scene performance row for the pond on the Mac (spike only; M2.12c moves the row
//! into the lane's tests). `measure.ts bench` compiles this file with rustc against the pond's
//! release build (the dependency rlibs Cargo reported), runs it under `/usr/bin/time -l` for the
//! peak RAM, and reads the one JSON line it prints.
//!
//!   pond-bench [frames]
//!
//! It opens the headless GPU (the same WebGPU-core floor as a game), seeds the pond, runs its
//! `cast` demo, then runs `frames` live frames of 1/60 s: advance the game, draw it through the
//! GPU-culled path, and wait for the GPU, so a frame's time is its CPU work plus GPU completion
//! with no vsync. Reported: GPU open, pipeline compile (renderer creation), time to the first
//! finished frame since process start, p50/p95/max frame time, blocking capture latency, and the
//! Metal device's peak `currentAllocatedSize`.

use genex::Runtime;
use genex_platform_web::{GameHandle, MeshCache, to_scene};
use genex_render::{CullPath, Gpu, Renderer};
use std::time::Instant;

const DEFAULT_FRAMES: usize = 600;
const CAPTURES: usize = 20;
const FRAME_MS: f64 = 1000.0 / 60.0;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

/// Bytes the Metal device has allocated now (0 off Metal).
#[allow(unsafe_code)]
fn gpu_allocated(gpu: &Gpu) -> u64 {
    // SAFETY: the hal device is only read for one property while `gpu` is alive.
    let Some(hal) = (unsafe { gpu.device.as_hal::<wgpu::hal::api::Metal>() }) else { return 0 };
    let raw: &objc2::runtime::ProtocolObject<dyn objc2_metal::MTLDevice> = hal.raw_device();
    // SAFETY: `currentAllocatedSize` is a read-only NSUInteger property of every MTLDevice.
    let bytes: usize = unsafe { objc2::msg_send![raw, currentAllocatedSize] };
    bytes as u64
}

fn draw(game: &mut dyn GameHandle, gpu: &Gpu, renderer: &mut Renderer, meshes: &mut MeshCache) {
    let (frame, camera) = game.frame();
    meshes.load(&frame, pond_game::ASSETS, |mesh| renderer.add_mesh(gpu, mesh));
    renderer.render(gpu, &to_scene(&frame, &camera, meshes), CullPath::Gpu).expect("render");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
}

fn main() {
    let process_start = Instant::now();
    let frames: usize = std::env::args().nth(1).and_then(|arg| arg.parse().ok()).unwrap_or(DEFAULT_FRAMES);
    let started = Instant::now();
    let gpu = Gpu::headless().expect("a WebGPU-core adapter");
    let gpu_open_ms = ms(started);
    let mut runtime = Runtime::new(pond_game::game()).expect("the pond installs");
    // Through the shell's trait, as the self-test and the web shell drive the game.
    let game: &mut dyn GameHandle = &mut runtime;
    game.seed(genex::DEFAULT_SEED);
    game.demo(pond_game::DEFAULT_DEMO).expect("the cast demo");
    let [width, height] = pond_game::WORLD_SIZE;
    let started = Instant::now();
    let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
    let pipeline_ms = ms(started);
    let mut meshes = MeshCache::default();
    draw(game, &gpu, &mut renderer, &mut meshes);
    let first_frame_ms = ms(process_start);
    game.start();
    let mut times = Vec::with_capacity(frames);
    let mut gpu_peak = gpu_allocated(&gpu);
    for _ in 0..frames {
        let started = Instant::now();
        game.advance_live(FRAME_MS);
        draw(game, &gpu, &mut renderer, &mut meshes);
        times.push(ms(started));
        gpu_peak = gpu_peak.max(gpu_allocated(&gpu));
    }
    let mut captures = Vec::with_capacity(CAPTURES);
    for _ in 0..CAPTURES {
        let started = Instant::now();
        let capture = renderer.capture(&gpu).expect("capture");
        captures.push(ms(started));
        std::hint::black_box(capture.digest());
    }
    gpu_peak = gpu_peak.max(gpu_allocated(&gpu));
    let mut sorted = times.clone();
    sorted.sort_by(f64::total_cmp);
    captures.sort_by(f64::total_cmp);
    let line = serde_json::json!({
        "format": "genex-pond-bench/1",
        "adapter": gpu.receipt().adapter,
        "frames": frames,
        "worldSize": [width, height],
        "gpuOpenMs": gpu_open_ms,
        "pipelineCompileMs": pipeline_ms,
        "firstFrameMs": first_frame_ms,
        "frameMs": { "p50": percentile(&sorted, 50.0), "p95": percentile(&sorted, 95.0), "max": sorted.last().copied().unwrap_or(0.0) },
        "captureMs": { "p50": percentile(&captures, 50.0), "p95": percentile(&captures, 95.0) },
        "gpuAllocatedPeakBytes": gpu_peak,
        "checksum": game.checksum(),
    });
    println!("{line}");
}
