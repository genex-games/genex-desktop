//! Per-node GPU timing (PROF-2): while armed, each step of the frame graph is bracketed on the
//! GPU, so the profiler's GPU lane shows where a frame's GPU time goes, node by node.
//!
//! - GPU timing has three modes: off (nothing armed), frame (the whole frame,
//!   [`super::live_timing::FrameTimer`], Live's default) and nodes (this timer, on top of the
//!   frame timer, armed one Live frame at a time like it).
//! - Brackets are one-invocation compute passes at step boundaries on the existing [`GpuTimer`]
//!   ([`TimerMode::Steps`]), as `live_timing.rs` brackets the frame: they work on WebGPU core and
//!   on Apple GPUs, which sample counters only at the boundaries of a pass that runs a shader. A
//!   pass step is one span named by its frame-graph row; the world pass's in-pass run is one span,
//!   [`WORLD_NODE`].
//! - Times land two or three frames later through the timer's non-blocking ring, keyed to the
//!   frame index the caller armed with ([`NodeTimer::arm`]).
//! - A capture is never timed: a frame drawn on a capture's history set or baking a settled
//!   capture's environment runs unbracketed and leaves the timer disarmed ([`run_and_submit`]).
//!
//! The encode and the submission are timed on the CPU as the engine scopes `encode` and `submit`
//! (genex-profile); they record nothing on a thread that no profiler is attached to.

use std::collections::VecDeque;

use genex_profile::gpu_lane::{GpuNodeSample, WORLD_NODE};
use genex_profile::{EngineScope, scope};
use wgpu::{BindGroup, BufferUsages, ComputePipeline, Device, Queue, ShaderStages};

use crate::compile::Compiled;
use crate::graph::{FrameEncoder, FrameNodes, Step, StepTimer, run_timed, spec};
use crate::renderer::shader;
use crate::tables::{buffer, pipeline_layout, storage};
use crate::timing::{GpuTimer, MAX_TIMED_NODES, PassTiming, QUERY_RING_DEPTH, TimerMode};
use crate::{RenderError, graph};

/// The bracket pass: one invocation writing a word the GPU keeps (never read back).
const BRACKET_WGSL: &str = r#"
@group(0) @binding(0) var<storage, read_write> sink: array<u32>;

@compute @workgroup_size(1)
fn bracket() {
    sink[0] = sink[0] + 1u;
}
"#;
/// One word.
const SINK_BYTES: u64 = 4;
/// Armed frames whose step names wait for their times: the ring's depth plus room for frames
/// that were armed and then drawn as captures (their slots are abandoned, never sampled).
const PENDING_FRAMES_MAX: usize = QUERY_RING_DEPTH + 5;

/// One armed frame's per-node GPU times.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeFrame {
    /// The frame index the caller armed with.
    pub frame: u64,
    /// The bracketed span: the first step's beginning to the last step's end, in milliseconds.
    pub span_ms: Option<f64>,
    /// One sample per timed step, in schedule order.
    pub nodes: Vec<GpuNodeSample>,
}

/// An armed frame waiting for its times.
struct Pending {
    timer_frame: u64,
    frame: u64,
    names: Vec<&'static str>,
}

/// The step brackets (module docs).
pub struct NodeTimer {
    device: Device,
    queue: Queue,
    timer: GpuTimer,
    pipeline: Compiled<ComputePipeline>,
    group: BindGroup,
    /// Whether the frame being drawn is bracketed.
    armed: bool,
    /// The timer's frames begun (its own frame counter).
    timer_frames: u64,
    pending: VecDeque<Pending>,
}

impl NodeTimer {
    /// A timer on `device` and `queue`, or None when the device has no timestamp queries.
    pub fn new(device: &Device, queue: &Queue) -> Option<NodeTimer> {
        let timer = GpuTimer::new(device, queue, TimerMode::Steps(MAX_TIMED_NODES))?;
        let module = shader(device, "node timer", BRACKET_WGSL).ok()?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("node timer"),
            entries: &[storage(0, false, ShaderStages::COMPUTE)],
        });
        let sink = buffer(device, "node timer sink", SINK_BYTES, BufferUsages::STORAGE).ok()?;
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("node timer"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: sink.as_entire_binding() }],
        });
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("node timer bracket"),
            layout: Some(&pipeline_layout(device, "node timer", &[&layout])),
            module: &module,
            entry_point: Some("bracket"),
            compilation_options: Default::default(),
            cache: None,
        });
        Some(NodeTimer {
            device: device.clone(),
            queue: queue.clone(),
            timer,
            pipeline,
            group,
            armed: false,
            timer_frames: 0,
            pending: VecDeque::with_capacity(PENDING_FRAMES_MAX),
        })
    }

    /// Arm the next frame as frame `frame`: collect the per-node times of earlier frames that
    /// landed (oldest first) and start a ring slot (the frame goes untimed when every slot is busy).
    pub fn arm(&mut self, frame: u64) -> Vec<NodeFrame> {
        let landed = self.collect();
        let timer_frame = self.timer_frames;
        self.timer_frames += 1;
        self.armed = self.timer.begin_frame();
        if self.armed {
            if self.pending.len() == PENDING_FRAMES_MAX {
                self.pending.pop_front();
            }
            self.pending.push_back(Pending { timer_frame, frame, names: Vec::new() });
        }
        landed
    }

    /// Leave the frame being drawn unbracketed (a capture); its slot is abandoned at the next arm.
    pub fn disarm(&mut self) {
        self.armed = false;
    }

    /// Whether the frame being drawn is bracketed.
    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// Close an armed frame after its last submission: resolve earlier frames' timestamps, submit,
    /// and start their readback. Nothing when the frame was not armed.
    pub fn finish(&mut self) {
        if !std::mem::take(&mut self.armed) {
            return;
        }
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("node timer resolve") });
        self.timer.resolve(&mut encoder);
        self.queue.submit([encoder.finish()]);
        self.timer.submitted();
    }

    /// Frames that went untimed because the ring was full.
    pub fn skipped(&self) -> u64 {
        self.timer.skipped()
    }

    /// The landed samples, named and keyed to the caller's frames.
    fn collect(&mut self) -> Vec<NodeFrame> {
        let samples = self.timer.collect(&self.device);
        let mut landed = Vec::with_capacity(samples.len());
        for sample in samples {
            let Some(at) = self.pending.iter().position(|pending| pending.timer_frame == sample.frame) else { continue };
            let Some(pending) = self.pending.remove(at) else { continue };
            let nodes = pending
                .names
                .iter()
                .zip(&sample.nodes)
                .filter_map(|(node, ms)| ms.map(|ms| GpuNodeSample { frame: pending.frame, node, ms: f64::from(ms) }))
                .collect();
            landed.push(NodeFrame { frame: pending.frame, span_ms: sample.frame_ms.map(f64::from), nodes });
        }
        landed
    }

    /// Record one bracket pass writing step `index`'s beginning or end.
    fn bracket(&mut self, index: usize, first: bool, frame: &mut FrameEncoder) {
        let Ok(node) = u16::try_from(index) else { return };
        if !self.armed || node >= MAX_TIMED_NODES {
            return;
        }
        let writes = self.timer.compute_writes(PassTiming { node, first, last: !first });
        let label = if first { "node timer begin" } else { "node timer end" };
        let mut pass = frame.encoder().begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(label), timestamp_writes: writes });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
        drop(pass);
        frame.count_compute_passes(1);
    }
}

/// The name a step is timed under: its row's wire name, or [`WORLD_NODE`] for the world pass.
fn step_name(step: &Step) -> &'static str {
    match step {
        Step::Node(id) => spec(*id).wire,
        Step::World(_) => WORLD_NODE,
    }
}

impl StepTimer for NodeTimer {
    fn begin_step(&mut self, index: usize, step: &Step, frame: &mut FrameEncoder) {
        if !self.armed {
            return;
        }
        if let Some(pending) = self.pending.back_mut()
            && pending.names.len() == index
            && index < usize::from(MAX_TIMED_NODES)
        {
            pending.names.push(step_name(step));
        }
        self.bracket(index, true, frame);
    }

    fn end_step(&mut self, index: usize, _step: &Step, frame: &mut FrameEncoder) {
        self.bracket(index, false, frame);
    }
}

/// Run one frame of `nodes`, bracketed by `timer` when it is armed and `live` (a capture never
/// is), submit it, then close the timer's frame. The encode and the submission are the engine
/// scopes `encode` and `submit`.
pub fn run_and_submit(nodes: &mut dyn FrameNodes, frame: &mut FrameEncoder, timer: Option<&mut NodeTimer>, live: bool) -> Result<Vec<Step>, RenderError> {
    let mut timer = timer.filter(|timer| timer.is_armed());
    if !live && let Some(timer) = timer.take() {
        timer.disarm();
    }
    let ran = {
        let _encode = scope(EngineScope::Encode);
        match timer.as_deref_mut() {
            Some(timer) => run_timed(nodes, frame, Some(timer)),
            None => graph::run(nodes, frame),
        }
    };
    {
        let _submit = scope(EngineScope::Submit);
        frame.submit();
    }
    if let Some(timer) = timer {
        timer.finish();
    }
    ran
}
