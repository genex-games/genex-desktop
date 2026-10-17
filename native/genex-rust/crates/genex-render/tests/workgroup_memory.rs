//! Workgroup memory without wgpu's zeroing (renderer pass 2, P2-0.16, A8.6). On native, naga's MSL
//! writer zeroes every workgroup array a kernel uses from one thread, before a barrier, at the start
//! of each workgroup, unless the pipeline opts out. The built-in kernels that write every workgroup
//! variable before reading it opt out (`compile::WORKGROUP_AUDIT`, `compile::written_first`); the
//! web zeroes regardless. The CPU row holds every registered shader with workgroup memory to that
//! audit; the Metal row measures what the zeroing costs on this GPU.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test workgroup_memory --offline --locked -- --include-ignored

use genex_render::Gpu;
use genex_render::compile::{WORKGROUP_AUDIT, written_first};
use genex_render::shaders::SHADERS;

/// Shaders with workgroup memory that their own module registers, outside `shaders::SHADERS`.
const UNREGISTERED: &[(&str, &str)] = &[("light-bin", genex_render::cluster::LIGHT_BIN)];

fn has_workgroup_memory(name: &str, source: &str) -> bool {
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
    module.global_variables.iter().any(|(_, global)| global.space == naga::AddressSpace::WorkGroup)
}

#[test]
fn every_built_in_shader_with_workgroup_memory_is_audited_and_every_audit_names_one() {
    let with_memory: Vec<&str> = SHADERS.iter().chain(UNREGISTERED).filter(|(name, source)| has_workgroup_memory(name, source)).map(|(name, _)| *name).collect();
    let audited: Vec<&str> = WORKGROUP_AUDIT.iter().map(|(name, _)| *name).collect();
    for name in &with_memory {
        assert!(audited.contains(name), "{name} declares workgroup memory: audit it into compile::WORKGROUP_AUDIT (or keep wgpu's zeroing)");
    }
    for name in &audited {
        assert!(with_memory.contains(name), "{name} is audited but no registered shader of that name has workgroup memory");
    }
    assert!(WORKGROUP_AUDIT.iter().all(|(_, proof)| !proof.is_empty()), "every audit says why");
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

/// A kernel shaped like the meshlet cull's: four 256-word workgroup arrays, each written by its
/// lane before a barrier and then read across lanes.
const SCAN_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
var<workgroup> a: array<u32, 256>;
var<workgroup> b: array<u32, 256>;
var<workgroup> c: array<u32, 256>;
var<workgroup> d: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
    a[lane] = id.x; b[lane] = lane; c[lane] = id.x ^ lane; d[lane] = 1u;
    workgroupBarrier();
    out[id.x] = a[255u - lane] + b[(lane + 1u) % 256u] + c[lane / 2u] + d[0];
}
"#;
const WORKGROUPS: u32 = 16 * 1024;
const DISPATCHES: u32 = 8;
const SAMPLES: usize = 15;

/// GPU milliseconds of `DISPATCHES` dispatches of the scan kernel compiled with `options`, the
/// median of `SAMPLES` timestamped submissions.
fn scan_ms(gpu: &Gpu, options: wgpu::PipelineCompilationOptions<'_>) -> f64 {
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("scan"), source: wgpu::ShaderSource::Wgsl(SCAN_WGSL.into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("scan"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: options,
        cache: None,
    });
    let bytes = u64::from(WORKGROUPS) * 256 * 4;
    let out = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: out.as_entire_binding() }],
    });
    let queries = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolved = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let read = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut samples = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: Some(wgpu::ComputePassTimestampWrites { query_set: &queries, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }),
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            for _ in 0..DISPATCHES {
                pass.dispatch_workgroups(WORKGROUPS, 1, 1);
            }
        }
        encoder.resolve_query_set(&queries, 0..2, &resolved, 0);
        encoder.copy_buffer_to_buffer(&resolved, 0, &read, 0, 16);
        gpu.queue.submit([encoder.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).expect("the GPU finishes");
        let ticks: [u64; 2] = bytemuck::pod_read_unaligned(&read.slice(..).get_mapped_range().expect("the read is mapped")[..16]);
        read.unmap();
        samples.push(ticks[1].saturating_sub(ticks[0]) as f64 * f64::from(gpu.queue.get_timestamp_period()) / 1e6);
    }
    samples.sort_by(f64::total_cmp);
    samples[SAMPLES / 2]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_skipping_the_zeroing_is_never_slower_and_the_saving_is_measured() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let mut rows = Vec::new();
    for _ in 0..3 {
        let zeroed = scan_ms(&gpu, wgpu::PipelineCompilationOptions::default());
        let written = scan_ms(&gpu, written_first());
        rows.push((zeroed, written));
    }
    for (zeroed, written) in &rows {
        eprintln!("{} workgroups x {DISPATCHES}: zeroed {zeroed:.3} ms, written first {written:.3} ms", WORKGROUPS);
    }
    let (zeroed, written) = rows[rows.len() / 2];
    assert!(written <= zeroed * 1.05, "skipping the zeroing costs time: {written:.3} ms against {zeroed:.3} ms");
}
