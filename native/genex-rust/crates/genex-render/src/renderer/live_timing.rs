//! Live GPU frame timing (plan §2.6): [`TimerMode::Frame`]'s two timestamps per frame, bracketing
//! the whole frame, so dynamic resolution and `state().volatile.render.gpuMs` read the GPU's own
//! clock where the renderer-owned `TIMESTAMP_QUERY` is offered.
//!
//! - The **begin** timestamp is a one-invocation compute pass recorded at the top of the frame's
//!   first command buffer (the `tables` node), so CPU encoding never counts as GPU time.
//! - The **end** timestamp is a one-invocation compute pass that reads one texel of the world
//!   target after the frame (HUD included) was submitted: the read makes it wait for every pass
//!   that wrote the target, so the span covers the frame on tile GPUs too. Metal takes no counter
//!   sample in a pass that runs no shader, hence the one invocation in each.
//! - Timestamps go through [`GpuTimer`]'s non-blocking 3-deep ring: a frame's time lands two or
//!   three frames later, and a frame is untimed when the ring is full.
//!
//! Only frames that were [`FrameTimer::arm`]ed are timed (Live and window frames); a capture is
//! never timed and never moves dynamic resolution.

use crate::compile::Compiled;
use wgpu::{BindGroupLayout, Buffer, BufferUsages, CommandEncoder, ComputePipeline, Device, Queue, ShaderStages, TextureView};

use crate::renderer::shader;
use crate::tables::{buffer, pipeline_layout, storage};
use crate::timing::{GpuTimer, PassTiming, TimerMode};

/// The bracket passes: one invocation each, writing a word the GPU keeps (never read back).
const FRAME_TIMER_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read_write> sink: array<u32>;
@group(0) @binding(1) var world: texture_2d<f32>;

@compute @workgroup_size(1)
fn begin_frame() {
    sink[0] = sink[0] + 1u;
}

@compute @workgroup_size(1)
fn end_frame() {
    let texel = textureLoad(world, vec2<i32>(0, 0), 0);
    sink[1] = bitcast<u32>(texel.x);
}
"#;
/// Two words: the begin pass's and the end pass's.
const SINK_BYTES: u64 = 8;

/// Two timestamps around each armed frame (module docs).
pub struct FrameTimer {
    device: Device,
    queue: Queue,
    timer: GpuTimer,
    begin: Compiled<ComputePipeline>,
    end: Compiled<ComputePipeline>,
    begin_layout: BindGroupLayout,
    end_layout: BindGroupLayout,
    sink: Buffer,
    /// Whether the frame being drawn is timed (its begin pass not yet recorded).
    armed: bool,
    /// Whether the begin pass was recorded this frame (so the end pass closes the pair).
    begun: bool,
}

fn compute(device: &Device, module: &wgpu::ShaderModule, layout: &BindGroupLayout, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout(device, entry, &[layout])),
        module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

fn world_entry() -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 1,
        visibility: ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

impl FrameTimer {
    /// A timer on `device` and `queue`, or None when the device has no timestamp queries (the
    /// caller falls back to an interval-only dynamic-resolution signal).
    pub fn new(device: &Device, queue: &Queue) -> Option<FrameTimer> {
        let timer = GpuTimer::new(device, queue, TimerMode::Frame)?;
        let module = shader(device, "frame timer", FRAME_TIMER_WGSL).ok()?;
        let sink_entry = storage(0, false, ShaderStages::COMPUTE);
        let layout = |label: &str, entries: &[wgpu::BindGroupLayoutEntry]| {
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
        };
        let begin_layout = layout("frame timer begin", &[sink_entry]);
        let end_layout = layout("frame timer end", &[sink_entry, world_entry()]);
        let sink = buffer(device, "frame timer sink", SINK_BYTES, BufferUsages::STORAGE).ok()?;
        Some(FrameTimer {
            begin: compute(device, &module, &begin_layout, "begin_frame"),
            end: compute(device, &module, &end_layout, "end_frame"),
            device: device.clone(),
            queue: queue.clone(),
            timer,
            begin_layout,
            end_layout,
            sink,
            armed: false,
            begun: false,
        })
    }

    /// Arm the next frame: collect the GPU times of earlier frames that landed (milliseconds,
    /// oldest first) and start a ring slot (untimed when every slot is busy).
    pub fn arm(&mut self) -> Vec<f32> {
        let landed = self.timer.collect(&self.device).into_iter().filter_map(|sample| sample.frame_ms).collect();
        self.armed = self.timer.begin_frame();
        self.begun = false;
        landed
    }

    /// Record the begin pass into the frame's first encoder (the `tables` node); nothing when the
    /// frame is not armed.
    pub fn encode_begin(&mut self, encoder: &mut CommandEncoder) {
        if !std::mem::take(&mut self.armed) {
            return;
        }
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame timer begin"),
            layout: &self.begin_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: self.sink.as_entire_binding() }],
        });
        let writes = self.timer.compute_writes(PassTiming { node: 0, first: true, last: false });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("frame timer begin"), timestamp_writes: writes });
        pass.set_pipeline(&self.begin);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
        self.begun = true;
    }

    /// Close the frame: the end pass reading `world` (when the begin pass ran), the resolve of
    /// earlier frames' timestamps, one submission, then the readback of what was resolved.
    pub fn finish(&mut self, world: &TextureView) {
        self.armed = false;
        let device = &self.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame timer end") });
        if std::mem::take(&mut self.begun) {
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("frame timer end"),
                layout: &self.end_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.sink.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(world) },
                ],
            });
            let writes = self.timer.compute_writes(PassTiming { node: 0, first: false, last: true });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("frame timer end"), timestamp_writes: writes });
            pass.set_pipeline(&self.end);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        self.timer.resolve(&mut encoder);
        self.queue.submit([encoder.finish()]);
        self.timer.submitted();
    }

    /// Frames that went untimed because the ring was full.
    pub fn skipped(&self) -> u64 {
        self.timer.skipped()
    }
}
