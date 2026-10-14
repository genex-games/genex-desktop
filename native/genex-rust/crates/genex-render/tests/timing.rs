//! Frame timing (plan §2.6, RQ0.5): the 3-deep query ring, percentile maths, CPU time without
//! swapchain waits, the submit-latency fallback (all with injected time), and real-GPU rows,
//! `#[ignore]`d so a machine without a GPU skips them; every GPU row's name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal

use std::sync::{Arc, Mutex};
use std::time::Duration;

use genex_render::Gpu;
use genex_render::timing::{
    CpuTimer, DoneCallback, FrameTiming, GpuFrameSample, GpuSource, GpuTimer, PassTiming, QUERY_RING_DEPTH, QueryRing, SlotState, SubmitLatency,
    TIMING_WINDOW_FRAMES, TimerMode, TimingWindow, span_ms,
};

/// A ring slot, the frame its next event is due and the frame it recorded.
type SlotDue = (usize, u64, u64);
/// Done callbacks a fake queue holds until the test runs them.
type Callbacks = Arc<Mutex<Vec<DoneCallback>>>;

#[test]
fn the_ring_never_hands_out_a_slot_still_in_flight_and_skips_instead_of_stalling() {
    let mut ring = QueryRing::new();
    // A frame's GPU work is done 1 to 4 frames after its submit; it is then resolved into the next
    // frame, whose map lands 1 to 3 frames after that frame's submit. Sometimes all three slots are
    // busy and the frame goes untimed rather than waiting.
    let gpu_latency = |frame: u64| 1 + (frame * 7 + 3) % 4;
    let map_latency = |frame: u64| 1 + (frame * 5 + 1) % 3;
    // (slot, frame the event is due, frame recorded)
    let (mut sampled, mut mapping): (Vec<SlotDue>, Vec<SlotDue>) = (Vec::new(), Vec::new());
    let (mut completed, mut skipped) = (Vec::new(), 0);
    for frame in 0..400u64 {
        for (slot, due, recorded) in mapping.iter().copied().filter(|(_, due, _)| *due <= frame).collect::<Vec<_>>() {
            assert_eq!(ring.complete(slot), Some(recorded), "a landed map frees its slot and names its frame");
            completed.push(recorded);
            mapping.retain(|entry| entry != &(slot, due, recorded));
        }
        let busy: Vec<usize> = sampled.iter().chain(&mapping).map(|(slot, _, _)| *slot).collect();
        let current = ring.begin(frame);
        match current {
            Some(slot) => {
                assert!(!busy.contains(&slot), "frame {frame}: slot {slot} handed out while busy");
                assert_eq!(ring.state(slot), SlotState::Recording { frame });
                assert!(!ring.resolve(slot), "a frame is never resolved in its own encoder");
            }
            None => {
                assert_eq!(busy.len(), QUERY_RING_DEPTH, "frame {frame}: skipped with a free slot");
                skipped += 1;
            }
        }
        let done: Vec<SlotDue> = sampled.iter().copied().filter(|(_, due, _)| *due <= frame).collect();
        sampled.retain(|(_, due, _)| *due > frame);
        for (slot, _, _) in &mapping {
            assert!(!ring.resolve(*slot), "frame {frame}: slot {slot} resolved into while mapping");
        }
        for (slot, _, _) in &done {
            assert!(ring.resolve(*slot), "frame {frame}: a sampled slot whose work is done resolves");
        }
        if let Some(slot) = current {
            assert!(ring.submit(slot));
            sampled.push((slot, frame + gpu_latency(frame), frame));
        }
        for (slot, _, recorded) in done {
            assert!(ring.map(slot), "the frame carrying the resolve maps it after its submit");
            mapping.push((slot, frame + map_latency(frame), recorded));
        }
        assert!(ring.in_flight() <= QUERY_RING_DEPTH);
    }
    assert!(skipped > 0, "the scripted latency fills the ring at least once");
    assert!(completed.len() > 150, "{} frames timed", completed.len());
    assert!(completed.windows(2).all(|pair| pair[0] < pair[1]), "frames land in order");
}

#[test]
fn the_ring_refuses_out_of_order_transitions() {
    let mut ring = QueryRing::new();
    let slot = ring.begin(0).expect("a free slot");
    assert!(!ring.resolve(slot) && !ring.map(slot), "a recording slot is neither resolved nor mapped");
    assert_eq!(ring.complete(slot), None);
    assert!(ring.submit(slot));
    assert!(!ring.submit(slot), "a submitted slot is not submitted twice");
    assert!(!ring.map(slot), "a slot is mapped only after its resolve");
    assert_eq!(ring.complete(slot), None);
    assert!(ring.resolve(slot));
    assert!(!ring.resolve(slot), "a slot is resolved once");
    assert_eq!(ring.complete(slot), None, "a resolving slot has no map to land");
    assert!(ring.map(slot));
    assert!(!ring.map(slot), "a slot is mapped once");
    assert_eq!(ring.complete(slot), Some(0));
    assert_eq!(ring.complete(slot), None, "a free slot completes nothing");
    let again = ring.begin(1).expect("a free slot");
    ring.abandon(again);
    assert_eq!(ring.state(again), SlotState::Free, "an unsubmitted frame frees its slot");
}

#[test]
fn percentiles_on_fixed_samples() {
    let mut window = TimingWindow::new();
    assert_eq!(window.cpu_ms(50.0), None);
    for ms in 1..=100 {
        window.push(FrameTiming { cpu_ms: ms as f32, gpu_ms: Some(ms as f32 / 10.0), ..FrameTiming::default() });
    }
    assert_eq!((window.cpu_ms(50.0), window.cpu_ms(95.0)), (Some(50.0), Some(95.0)));
    assert_eq!((window.cpu_ms(0.0), window.cpu_ms(100.0)), (Some(1.0), Some(100.0)));
    assert_eq!(window.gpu_ms(95.0), Some(9.5));
    for ms in 101..=200 {
        window.push(FrameTiming { cpu_ms: ms as f32, gpu_ms: None, ..FrameTiming::default() });
    }
    assert_eq!(window.len(), TIMING_WINDOW_FRAMES, "the window slides");
    // Frames 81..=200 remain: nearest rank 60 of 120 is 140, rank 114 is 194.
    assert_eq!((window.cpu_ms(50.0), window.cpu_ms(95.0)), (Some(140.0), Some(194.0)));
    // GPU samples slide on their own window: the last 100 frames had none, so all 100 remain.
    assert_eq!(window.gpu_ms(50.0), Some(5.0));
    let summary = window.summary();
    assert_eq!((summary.frames, summary.cpu_p50, summary.cpu_p95), (TIMING_WINDOW_FRAMES, Some(140.0), Some(194.0)));
    // A late GPU sample (the ring lands it frames after its CPU time) joins the GPU window.
    window.push_gpu(1.0, GpuSource::Timestamps);
    assert_eq!(window.summary().gpu_source, Some(GpuSource::Timestamps));
}

#[test]
fn cpu_time_excludes_swapchain_acquire_and_present_waits() {
    let ms = Duration::from_millis;
    let mut cpu = CpuTimer::new();
    cpu.begin(ms(100));
    cpu.wait_begin(ms(102));
    cpu.wait_end(ms(107));
    cpu.wait_begin(ms(109));
    cpu.wait_end(ms(110));
    assert_eq!(cpu.end(ms(112)), Some(6.0), "12 ms elapsed, 6 ms of it waiting on the swapchain");
    assert_eq!(cpu.end(ms(120)), None, "a frame ends once");
    cpu.begin(ms(200));
    cpu.wait_begin(ms(201));
    assert_eq!(cpu.end(ms(204)), Some(1.0), "an open wait ends with the frame");
}

#[test]
fn timestamp_spans_convert_ticks_and_refuse_reversed_pairs() {
    assert_eq!(span_ms(1_000, 3_001_000, 1.0), Some(3.0));
    assert_eq!(span_ms(0, 1_000_000, 41.666_668), Some(41.666_668));
    assert_eq!(span_ms(5_000, 4_000, 1.0), None, "a reversed pair is no sample");
    assert_eq!(span_ms(5_000, 6_000, 0.0), None, "no timestamp period, no sample");
}

#[test]
fn the_submit_latency_fallback_reads_the_injected_clock() {
    let now = Arc::new(Mutex::new(Duration::from_millis(1_000)));
    let clock_now = Arc::clone(&now);
    let mut latency = SubmitLatency::new(Arc::new(move || *clock_now.lock().expect("clock")));
    let callbacks: Callbacks = Arc::default();
    let register = |callbacks: &Callbacks| {
        let callbacks = Arc::clone(callbacks);
        move |callback: Box<dyn FnOnce() + Send>| callbacks.lock().expect("callbacks").push(callback)
    };
    latency.submitted(register(&callbacks));
    *now.lock().expect("clock") = Duration::from_millis(1_004);
    latency.submitted(register(&callbacks));
    assert!(latency.collect().is_empty(), "nothing done yet");
    *now.lock().expect("clock") = Duration::from_millis(1_009);
    let first = callbacks.lock().expect("callbacks").remove(0);
    first();
    assert_eq!(latency.collect(), vec![(0, 9.0)], "frame 0: submitted at 1000 ms, done at 1009 ms");
    *now.lock().expect("clock") = Duration::from_millis(1_012);
    let second = callbacks.lock().expect("callbacks").remove(0);
    second();
    assert_eq!(latency.collect(), vec![(1, 8.0)]);
}

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

const BUSY_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read_write> out: array<f32>;
override ITERATIONS: u32 = 1u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    var x = f32(id.x) * 0.001;
    for (var i = 0u; i < ITERATIONS; i = i + 1u) {
        x = fract(x * 1.000123 + 0.618034);
    }
    out[id.x] = x;
}
"#;
const BUSY_INVOCATIONS: u32 = 64 * 1024;
/// A full-screen triangle reading the compute pass's output: like a real frame's present pass, the
/// last pass depends on the first, so the GPU cannot overlap them (independent passes do overlap on
/// Apple GPUs). It draws because Metal samples no counters in a pass that runs no shader stage.
const TRIANGLE_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read> busy: array<f32>;
@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
@fragment
fn fs(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(busy[u32(at.x)], 0.4, 0.6, 1.0);
}
"#;

/// A compute pass of `iterations` ALU steps per invocation, then a small render pass: the frame's
/// first and last passes, timed at the frame level (begin on the first, end on the last).
struct Busy {
    pipeline: wgpu::ComputePipeline,
    bind: wgpu::BindGroup,
    triangle: wgpu::RenderPipeline,
    triangle_bind: wgpu::BindGroup,
    target: wgpu::TextureView,
}

fn triangle_pipeline(device: &wgpu::Device) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("triangle"),
        source: wgpu::ShaderSource::Wgsl(TRIANGLE_WGSL.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("triangle"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::TextureFormat::Rgba8Unorm.into())],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl Busy {
    fn new(gpu: &Gpu, iterations: u32) -> Busy {
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("busy"),
            source: wgpu::ShaderSource::Wgsl(BUSY_WGSL.into()),
        });
        let constants = [("ITERATIONS", f64::from(iterations))];
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("busy"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
            cache: None,
        });
        let out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("busy-out"),
            size: u64::from(BUSY_INVOCATIONS) * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("busy"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }],
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("busy-target"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let triangle = triangle_pipeline(device);
        let triangle_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("triangle"),
            layout: &triangle.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }],
        });
        Busy { pipeline, bind, triangle, triangle_bind, target: texture.create_view(&Default::default()) }
    }

    fn encode(&self, encoder: &mut wgpu::CommandEncoder, timer: &mut GpuTimer) {
        {
            let writes = timer.compute_writes(PassTiming { node: 0, first: true, last: false });
            let mut pass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("busy"), timestamp_writes: writes });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.dispatch_workgroups(BUSY_INVOCATIONS / 64, 1, 1);
        }
        let writes = timer.render_writes(PassTiming { node: 1, first: false, last: true });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("busy-clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: writes,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.triangle);
        pass.set_bind_group(0, &self.triangle_bind, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// Submit frames carrying only resolves until `timer` lands a sample.
fn flush(gpu: &Gpu, timer: &mut GpuTimer) -> Vec<GpuFrameSample> {
    for _ in 0..10 {
        let samples = timer.collect(&gpu.device);
        if !samples.is_empty() {
            return samples;
        }
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        timer.resolve(&mut encoder);
        gpu.queue.submit([encoder.finish()]);
        timer.submitted();
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("idle");
    }
    Vec::new()
}

/// One timed frame, waited on: (timestamp GPU ms, CPU-measured submit-to-idle ms).
fn timed_frame(gpu: &Gpu, busy: &Busy, timer: &mut GpuTimer) -> (Option<f32>, f32) {
    assert!(timer.begin_frame());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    busy.encode(&mut encoder, timer);
    timer.resolve(&mut encoder);
    let buffer = encoder.finish();
    #[allow(clippy::disallowed_types, reason = "the row compares timestamps with the wall clock on purpose")]
    let start = std::time::Instant::now();
    gpu.queue.submit([buffer]);
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("idle");
    let waited = start.elapsed().as_secs_f32() * 1000.0;
    timer.submitted();
    let samples = flush(gpu, timer);
    (samples.first().and_then(|sample| sample.frame_ms), waited)
}

fn write_evidence(name: &str, text: &str) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/perf");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join(name), text);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_frame_timestamps_match_the_cpu_measured_gpu_wait() {
    let Some(gpu) = gpu() else { return };
    let Some(mut timer) = GpuTimer::new(&gpu.device, &gpu.queue, TimerMode::Frame) else {
        assert!(!gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY), "the feature is opened when offered");
        panic!("the adapter offers no TIMESTAMP_QUERY: the frame-level row needs it on Metal");
    };
    // Grow the work until a frame takes 20 ms or more, so fixed submit and wake costs are small.
    let mut iterations = 2_000;
    let mut busy = Busy::new(&gpu, iterations);
    for _ in 0..12 {
        // The first frame of a new pipeline includes its warm-up: calibrate on the second.
        timed_frame(&gpu, &busy, &mut timer);
        let (_, waited) = timed_frame(&gpu, &busy, &mut timer);
        if waited >= 20.0 {
            break;
        }
        iterations *= 2;
        busy = Busy::new(&gpu, iterations);
    }
    let mut rows = Vec::new();
    for _ in 0..12 {
        let (gpu_ms, waited) = timed_frame(&gpu, &busy, &mut timer);
        rows.push((gpu_ms.expect("a timestamp sample"), waited));
    }
    rows.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (gpu_ms, waited) = rows[rows.len() / 2];
    let ratio = gpu_ms / waited;
    let json = format!(
        "{{\"row\":\"rq0.5-timestamps-vs-wait\",\"iterations\":{iterations},\"frames\":{},\"median_gpu_ms\":{gpu_ms:.3},\"median_wait_ms\":{waited:.3},\"ratio\":{ratio:.3},\"rows\":{:?},\"backend\":\"{}\",\"adapter\":\"{}\",\"measures\":\"frame-level timestamps (compute pass begin, render pass end) vs CPU wall clock from submit to device idle\"}}\n",
        rows.len(),
        rows,
        gpu.receipt().backend,
        gpu.receipt().adapter,
    );
    eprintln!("{json}");
    write_evidence("rq0.5-timestamps-vs-wait.json", &json);
    assert!((0.8..=1.2).contains(&ratio), "timestamp GPU ms {gpu_ms} is not within 20% of the {waited} ms GPU wait");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_query_ring_runs_unblocked_without_validation_errors() {
    let Some(gpu) = gpu() else { return };
    let Some(mut timer) = GpuTimer::new(&gpu.device, &gpu.queue, TimerMode::Nodes(2)) else {
        panic!("the adapter offers no TIMESTAMP_QUERY");
    };
    let busy = Busy::new(&gpu, 200);
    let scope = gpu.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut samples = Vec::new();
    let mut timed = 0;
    // Frames back to back without waiting: the ring maps landed slots and skips when all three are
    // still in flight, never touching a buffer the GPU or a pending map owns.
    for _ in 0..60 {
        samples.extend(timer.collect(&gpu.device));
        if timer.begin_frame() {
            timed += 1;
        }
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        busy.encode(&mut encoder, &mut timer);
        timer.resolve(&mut encoder);
        gpu.queue.submit([encoder.finish()]);
        timer.submitted();
    }
    for _ in 0..20 {
        if samples.len() == timed {
            break;
        }
        samples.extend(flush(&gpu, &mut timer));
    }
    let unpaced_skipped = timer.skipped();
    // Paced like a display (each frame's GPU work done before the next frame starts), the ring's
    // steady state holds at most two slots, so no frame goes untimed.
    let mut paced = 0;
    for _ in 0..60 {
        samples.extend(timer.collect(&gpu.device));
        if timer.begin_frame() {
            timed += 1;
            paced += 1;
        }
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        busy.encode(&mut encoder, &mut timer);
        timer.resolve(&mut encoder);
        gpu.queue.submit([encoder.finish()]);
        timer.submitted();
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("idle");
    }
    for _ in 0..20 {
        if samples.len() == timed {
            break;
        }
        samples.extend(flush(&gpu, &mut timer));
    }
    assert_eq!(paced, 60, "a paced frame never finds every slot busy");
    let json = format!(
        "{{\"row\":\"rq0.5-ring\",\"unpaced\":{{\"frames\":60,\"timed\":{},\"skipped\":{unpaced_skipped}}},\"paced\":{{\"frames\":60,\"timed\":{paced}}},\"landed\":{},\"backend\":\"{}\",\"adapter\":\"{}\",\"measures\":\"unpaced: 60 frames submitted without waiting (the CPU outruns the GPU; untimed frames found all {QUERY_RING_DEPTH} slots busy, never a stall); paced: device idle after each submit, as at display rate; 2 timed nodes per frame, deferred resolve\"}}\n",
        timed - paced,
        samples.len(),
        gpu.receipt().backend,
        gpu.receipt().adapter,
    );
    eprintln!("{json}");
    write_evidence("rq0.5-ring.json", &json);
    let error = pollster::block_on(scope.pop());
    assert!(error.is_none(), "validation error: {error:?}");
    assert_eq!(samples.len(), timed, "every timed frame lands a sample ({} skipped)", timer.skipped());
    assert!(samples.windows(2).all(|pair| pair[0].frame < pair[1].frame), "samples arrive in frame order");
    for sample in &samples {
        assert_eq!(sample.nodes.len(), 2);
        assert!(sample.nodes.iter().all(Option::is_some), "both nodes timed: {sample:?}");
        // Nodes may overlap (the render pass's vertex stage does not wait for the compute pass), so
        // the frame spans each node, not their sum.
        let frame = sample.frame_ms.expect("the frame span of the nodes");
        let longest = sample.nodes.iter().flatten().copied().fold(0.0f32, f32::max);
        assert!(frame >= longest, "the frame spans each of its nodes ({frame} vs {longest})");
    }
}
