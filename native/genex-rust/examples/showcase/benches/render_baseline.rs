//! The renderer perf harness (baseline row of the renderer follow-up): headless on the host GPU,
//! fixed camera paths, CPU and GPU frame times as p50/p95, one JSON record per run in
//! `.studio-dev/evidence/rust-renderer/perf/`.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo bench -p showcase --offline \
//!     --locked --bench render-baseline
//!
//! Rows, at every size:
//! - `lakeside-<shot>`: the five named shots (fixed cameras, the simulation advancing one tick per
//!   frame from tick 600), drawn as the studio draws them (custom passes included, no HUD);
//! - `lakeside-tour`: the tour camera (`View::Game`) from tick 600;
//! - `bench-<scene>`: the bench scenes along their camera paths from frame 0.
//!
//! Per frame: `cpuMs` is building the scene, planning, uploading, encoding and submitting (until the
//! renderer returns); `frameMs` adds waiting for the GPU to finish (device poll); `gpuMs` is the GPU
//! time from a timestamp at the start of the frame's first command encoder to one at the end of an
//! empty pass on the world target submitted after the frame (every submission of the frame and any GPU
//! idle between them), when the adapter offers `TIMESTAMP_QUERY` (else null with the reason). The
//! device is otherwise the floor's: core limits, no other feature. Per-pass GPU times need the
//! renderer's own timestamps (plan RQ0.5).
//!
//! Environment: `GENEX_PERF_FRAMES` measured frames (600) after `GENEX_PERF_WARMUP` (60);
//! `GENEX_PERF_SIZES` (`1280x720,1920x1080`); `GENEX_PERF_ROWS` a comma list of row names to keep;
//! `GENEX_PERF_OUT` the record's path. Power source and thermal state (`pmset`) are recorded so
//! runs are compared like for like only.
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

#[path = "../tests/support/mod.rs"]
mod support;

use std::path::PathBuf;
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use genex::{FIXED_STEP_MS, Runtime, Value, View, json};
use genex_render::Gpu;
use genex_render::renderer::FrameStats;
use showcase_game::bench::SceneId;
use showcase_game::world::{SHOTS, World};

/// Frames measured per row and frames run before them.
const DEFAULT_FRAMES: u32 = 600;
const DEFAULT_WARMUP: u32 = 60;
/// Sizes measured by default.
const DEFAULT_SIZES: &str = "1280x720,1920x1080";
/// Timestamp slots: the frame's start and its end.
const TIMESTAMPS: u32 = 2;

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn sizes() -> Vec<[u32; 2]> {
    let text = std::env::var("GENEX_PERF_SIZES").unwrap_or_else(|_| DEFAULT_SIZES.to_owned());
    text.split(',')
        .filter_map(|size| {
            let (w, h) = size.trim().split_once('x')?;
            Some([w.parse().ok()?, h.parse().ok()?])
        })
        .collect()
}

fn kept(row: &str) -> bool {
    std::env::var("GENEX_PERF_ROWS").map_or(true, |rows| rows.split(',').any(|r| r.trim() == row))
}

/// One line of a host tool's output, or `unknown`.
fn host(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("; "))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// GPU timestamps around a frame: a stamped dispatch first in the frame's first encoder and a
/// stamped pass on the world target submitted after the frame, read back once it is done.
struct Timer {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    read: wgpu::Buffer,
    /// A one-invocation dispatch the stamps are written around (Metal drops an empty pass).
    tick: wgpu::ComputePipeline,
    period_ns: f32,
}

/// The stamped pass's shader: one invocation that does nothing.
const TICK_WGSL: &str = "@compute @workgroup_size(1) fn main() {}";

impl Timer {
    fn new(gpu: &Gpu) -> Timer {
        let device = &gpu.device;
        let bytes = u64::from(TIMESTAMPS) * 8;
        Timer {
            set: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("frame timestamps"), ty: wgpu::QueryType::Timestamp, count: TIMESTAMPS }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("timestamp resolve"),
                size: bytes,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            read: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("timestamp read"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            tick: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("timestamp tick"),
                layout: None,
                module: &device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("timestamp tick"), source: wgpu::ShaderSource::Wgsl(TICK_WGSL.into()) }),
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            }),
            period_ns: gpu.queue.get_timestamp_period(),
        }
    }

    /// Encode the start stamp: a one-invocation dispatch, first in the frame's first encoder.
    fn start(&self, encoder: &mut wgpu::CommandEncoder) {
        let writes = wgpu::ComputePassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: None };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("frame start stamp"), timestamp_writes: Some(writes) });
        pass.set_pipeline(&self.tick);
        pass.dispatch_workgroups(1, 1, 1);
    }

    /// Submit the end stamp: an empty pass that loads and stores the world target, so it ends only
    /// after every earlier write to it (the world pass, the post passes) has finished. A
    /// compute pass with no shared resource ran beside the frame on Metal instead of after it.
    fn end(&self, gpu: &Gpu, world: &wgpu::TextureView) {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame end stamp") });
        // The pass's end: on a tile GPU its start is sampled when its vertex stage may begin, while
        // the frame's fragment work on the same target is still running.
        let writes = wgpu::RenderPassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(1) };
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("frame end stamp"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: world,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: Some(writes),
            occlusion_query_set: None,
            multiview_mask: None,
        }));
        gpu.queue.submit([encoder.finish()]);
    }

    /// The frame's GPU milliseconds, once the frame and its end stamp finished. The values are resolved in a submission
    /// of their own because Metal's counter samples are only readable once their command buffer
    /// completed (a resolve in the stamping command buffer read the previous frame's values).
    fn read_ms(&self, gpu: &Gpu) -> f64 {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("timestamp resolve") });
        encoder.resolve_query_set(&self.set, 0..TIMESTAMPS, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.read, 0, u64::from(TIMESTAMPS) * 8);
        gpu.queue.submit([encoder.finish()]);
        let slice = self.read.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("timestamps mapped");
        let ticks: Vec<u64> =
            slice.get_mapped_range().expect("timestamps read").chunks(8).map(|c| u64::from_le_bytes(c.try_into().unwrap_or([0; 8]))).collect();
        self.read.unmap();
        ticks[1].saturating_sub(ticks[0]) as f64 * f64::from(self.period_ns) / 1.0e6
    }
}

/// The frame times of one row.
#[derive(Default)]
struct Samples {
    cpu: Vec<f64>,
    frame: Vec<f64>,
    gpu: Vec<f64>,
}

fn summary(values: &mut [f64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    json!({ "p50": round(support::percentile(values, 0.5)), "p95": round(support::percentile(values, 0.95)), "mean": round(mean), "max": round(values[values.len() - 1]) })
}

fn stats_json(stats: FrameStats) -> Value {
    json!({
        "logicalDraws": stats.logical_draws,
        "instances": stats.instances,
        "batches": stats.batches,
        "views": stats.views,
        "indirectDraws": stats.indirect_draws,
        "transparentDraws": stats.transparent_draws,
        "skinJobs": stats.skin_jobs,
    })
}

/// What a row's frame gets: the frame index, the start stamp to encode first, and where to
/// submit the end stamp once the frame is submitted.
struct FrameHooks<'t> {
    timer: Option<&'t Timer>,
}

impl FrameHooks<'_> {
    fn start(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(timer) = self.timer {
            timer.start(encoder);
        }
    }

    fn end(&self, gpu: &Gpu, world: &wgpu::TextureView) {
        if let Some(timer) = self.timer {
            timer.end(gpu, world);
        }
    }
}

/// Run `warmup` + `frames` frames of `draw`, keeping the measured ones.
fn measure(gpu: &Gpu, timer: Option<&Timer>, warmup: u32, frames: u32, mut draw: impl FnMut(u32, &FrameHooks<'_>)) -> Samples {
    let hooks = FrameHooks { timer };
    let mut samples = Samples::default();
    for frame in 0..warmup + frames {
        let start = Instant::now();
        draw(frame, &hooks);
        let cpu = start.elapsed();
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
        let whole = start.elapsed();
        let gpu_ms = timer.map(|t| t.read_ms(gpu));
        if frame < warmup {
            continue;
        }
        samples.cpu.push(cpu.as_secs_f64() * 1000.0);
        samples.frame.push(whole.as_secs_f64() * 1000.0);
        samples.gpu.extend(gpu_ms);
    }
    samples
}

fn row(name: &str, size: [u32; 2], camera: &str, mut samples: Samples, stats: FrameStats) -> Value {
    json!({
        "row": name,
        "size": size,
        "camera": camera,
        "frames": samples.frame.len(),
        "cpuMs": summary(&mut samples.cpu),
        "frameMs": summary(&mut samples.frame),
        "gpuMs": summary(&mut samples.gpu),
        "stats": stats_json(stats),
    })
}

fn lakeside_row(gpu: &Gpu, timer: Option<&Timer>, size: [u32; 2], view: View<'_>, warmup: u32, frames: u32) -> (Samples, FrameStats) {
    let mut runtime: Runtime<World> = support::lakeside_at_shot_tick();
    let mut stage = support::Lakeside::new(gpu, &mut runtime, Some(size));
    let samples = measure(gpu, timer, warmup, frames, |_, hooks| {
        runtime.step(FIXED_STEP_MS);
        stage.draw_marked(gpu, &mut runtime, view, &mut |encoder| hooks.start(encoder));
        hooks.end(gpu, stage.renderer.world_view());
    });
    (samples, stage.renderer.last_stats())
}

fn bench_row(gpu: &Gpu, timer: Option<&Timer>, size: [u32; 2], id: SceneId, warmup: u32, frames: u32) -> (Samples, FrameStats) {
    let (mut renderer, scene) = support::bench_stage(gpu, id, size);
    let samples = measure(gpu, timer, warmup, frames, |frame, hooks| {
        let drawn = scene.scene(frame);
        support::render_marked(&mut renderer, gpu, &drawn, &mut |encoder| hooks.start(encoder));
        hooks.end(gpu, renderer.world_view());
    });
    (samples, renderer.last_stats())
}

/// The device: with `TIMESTAMP_QUERY` when the adapter offers it.
fn open() -> Option<(Gpu, Option<String>)> {
    match Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY) {
        Ok(gpu) => Some((gpu, None)),
        Err(error) => support::admit(Gpu::headless()).map(|gpu| (gpu, Some(format!("no TIMESTAMP_QUERY: {error}")))),
    }
}

fn out_path(sha: &str) -> PathBuf {
    std::env::var_os("GENEX_PERF_OUT").map_or_else(|| support::evidence_dir("perf").join(format!("render-baseline-{sha}.json")), PathBuf::from)
}

fn main() {
    // `cargo bench` passes `--bench`; a filter argument is not supported (use GENEX_PERF_ROWS).
    let Some((gpu, timestamp_problem)) = open() else { return };
    if support::metal_required() {
        assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
    }
    let timer = timestamp_problem.is_none().then(|| Timer::new(&gpu));
    let (warmup, frames) = (env_u32("GENEX_PERF_WARMUP", DEFAULT_WARMUP), env_u32("GENEX_PERF_FRAMES", DEFAULT_FRAMES).max(1));
    let mut rows = Vec::new();
    for size in sizes() {
        for shot in SHOTS {
            let name = format!("lakeside-{}", shot.name);
            if kept(&name) {
                let (samples, stats) = lakeside_row(&gpu, timer.as_ref(), size, View::Named(shot.name), warmup, frames);
                rows.push(row(&name, size, "fixed shot", samples, stats));
                eprintln!("{name} {size:?} done");
            }
        }
        if kept("lakeside-tour") {
            let (samples, stats) = lakeside_row(&gpu, timer.as_ref(), size, View::Game, warmup, frames);
            rows.push(row("lakeside-tour", size, "tour path from tick 600", samples, stats));
            eprintln!("lakeside-tour {size:?} done");
        }
        for id in SceneId::ALL {
            let name = format!("bench-{}", id.name());
            if kept(&name) {
                let (samples, stats) = bench_row(&gpu, timer.as_ref(), size, id, warmup, frames);
                rows.push(row(&name, size, "scene path from frame 0", samples, stats));
                eprintln!("{name} {size:?} done");
            }
        }
    }
    let sha = host("git", &["rev-parse", "--short=12", "HEAD"]);
    let status = host("git", &["status", "--porcelain", "--untracked-files=no"]);
    let dirty = !status.is_empty() && status != "unknown";
    let record = json!({
        "harness": "render-baseline",
        "version": 1,
        "recordedAt": SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        "build": { "sha": sha, "trackedChanges": dirty, "profile": "bench (release)" },
        "adapter": { "name": gpu.receipt().adapter, "backend": gpu.receipt().backend },
        "timestamps": match &timestamp_problem { None => json!({ "available": true, "periodNs": gpu.queue.get_timestamp_period() }), Some(why) => json!({ "available": false, "reason": why }) },
        "host": { "power": host("pmset", &["-g", "ps"]), "thermal": host("pmset", &["-g", "therm"]) },
        "method": { "warmupFrames": warmup, "measuredFrames": frames, "msaa": genex_render::MSAA_SAMPLES, "statistic": "nearest-rank p50/p95 per row" },
        "rows": rows,
    });
    let path = out_path(&sha);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("the perf folder");
    }
    std::fs::write(&path, format!("{record:#}\n")).expect("perf record");
    println!("{record:#}");
    eprintln!("written: {}", path.display());
}
