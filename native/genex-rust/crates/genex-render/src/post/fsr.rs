//! The FSR1 upscaler (plan §2.2 node 22; RQ5): EASU's edge-adaptive upscale and RCAS's sharpening
//! of the tonemapped `rgb10a2unorm` intermediate, then the final dither into the world target.
//! RQ5.0 landed the contract: the intermediates ([`intermediate_target`], [`easu_target`]), the GPU
//! rows ([`GpuEasuParams`], [`GpuRcasParams`]) and which passes a frame runs ([`passes`]); RQ5.3
//! ports AMD FidelityFX FSR1 (MIT) into the shaders and adds [`FsrNode`], the two passes a frame
//! records, and the cost model DRS adds to its predictions ([`estimated_cost_ms`]).
//!
//! EASU reads the tonemapped intermediate with four gathers per channel and writes an
//! [`INTERMEDIATE_FORMAT`] image at output size; RCAS reads that (or the intermediate itself at
//! scale 1) with five loads, sharpens by [`RcasQuality`] stops and adds the frame-keyed dither as
//! it writes the world target. Both are full-screen fragment passes, so they run on every
//! destination's WebGPU-core floor and cost nothing in compute-only features. Each DRS step is an
//! exact-size target ([`GpuEasuParams::new`] takes the step's size whole, never a sub-rectangle).
//!
//! The upscaler is a pipeline knob ([`Upscaler`]): bilinear (the RQ0 node, fused into the tonemap
//! on low) or FSR1. RCAS's sharpness is a resource knob ([`crate::settings::RcasQuality`]), shared
//! with TAA's sharpen on ultra, which runs RCAS alone at scale 1.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, PipelineLayout, Queue, RenderPipeline, Sampler, ShaderModule, TextureFormat, TextureUsages, TextureView};

use crate::capture::Capture;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{AntiAliasing, Quality, RcasQuality, Upscaler};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the graph's upscale node runs EASU and RCAS and the `upscaler` switch changes the
/// picture: true since RQ5.6, when the renderer's upscale node (22) records [`FsrNode`] after the
/// tonemap wrote the intermediate (the fused bilinear tonemap stays `low`'s).
pub const LANDED: bool = true;
/// Frames the final dither's noise repeats after (the tonemap's cycle).
pub const DITHER_FRAME_CYCLE: u64 = 64;
/// The GPU budget of EASU plus RCAS at 1080p output (plan §2.5), in milliseconds.
pub const COST_BUDGET_MS_1080P: f32 = 0.3;
/// Pixels of the 1080p output [`COST_BUDGET_MS_1080P`] is stated at.
const COST_REFERENCE_PIXELS: f32 = 1920.0 * 1080.0;
/// Upscale runs one sample of [`gpu_ms`] records back to back.
pub const COST_RUNS_PER_SAMPLE: u32 = 8;
/// Samples [`gpu_ms`] records and drops first, so the first measured scale does not time the GPU
/// ramping its clocks (the plan's "after warm-up").
pub const COST_WARMUP_SAMPLES: u32 = 24;
/// The format of the tonemapped intermediate EASU reads and of EASU's output RCAS reads: 10 bits
/// a channel, so the display-referred values do not band before the final dither.
pub const INTERMEDIATE_FORMAT: TextureFormat = TextureFormat::Rgb10a2Unorm;
/// The intermediates' usages.
pub const INTERMEDIATE_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The tonemapped intermediate's pool label (render size).
pub const INTERMEDIATE_LABEL: &str = "fsr input";
/// EASU's output's pool label (output size).
pub const EASU_LABEL: &str = "fsr easu";
/// Bytes of one intermediate texel.
pub const INTERMEDIATE_TEXEL_BYTES: u64 = 4;

/// EASU (a full-screen fragment pass).
pub const EASU: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/easu.wgsl"));
/// RCAS and the final dither (a full-screen fragment pass).
pub const RCAS: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/rcas.wgsl"));

/// EASU's uniform (`EasuParams`): AMD's four constant vectors (`FsrEasuCon`) as floats.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuEasuParams {
    /// The input-to-output scale and the half-texel offset.
    pub con0: [f32; 4],
    /// The input texel steps of the first taps.
    pub con1: [f32; 4],
    /// The input texel steps of the middle taps.
    pub con2: [f32; 4],
    /// The input texel steps of the last taps.
    pub con3: [f32; 4],
}

impl GpuEasuParams {
    /// The constants for an EASU pass reading a whole `render`-sized texture and writing an
    /// `output`-sized one (AMD's `FsrEasuCon`). The four taps' gathers sit on texel corners, one
    /// texel right and up of the pattern's `f` texel; the other constants are their offsets.
    pub fn new(render: (u32, u32), output: (u32, u32)) -> GpuEasuParams {
        let (rw, rh) = (render.0.max(1) as f32, render.1.max(1) as f32);
        let (ow, oh) = (output.0.max(1) as f32, output.1.max(1) as f32);
        let (sx, sy) = (rw / ow, rh / oh);
        GpuEasuParams {
            con0: [sx, sy, 0.5 * sx - 0.5, 0.5 * sy - 0.5],
            con1: [1.0 / rw, 1.0 / rh, 1.0 / rw, -1.0 / rh],
            con2: [-1.0 / rw, 2.0 / rh, 1.0 / rw, 2.0 / rh],
            con3: [0.0, 4.0 / rh, 0.0, 0.0],
        }
    }
}

/// RCAS's uniform (`RcasParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuRcasParams {
    /// x: the sharpness as a linear scale (`exp2(-stops)`; 0 leaves the image as it is); y: 1 to
    /// apply the final dither; z: the frame the dither is keyed to (below
    /// [`DITHER_FRAME_CYCLE`]); w: 1 to soften the lobe where the neighbourhood is noise
    /// ([`RcasQuality::denoise`]).
    pub con: [f32; 4],
    /// xy: the output size in pixels; zw: 1 / it.
    pub size: [f32; 4],
}

impl GpuRcasParams {
    /// The row for an `output`-sized RCAS with `rcas`'s sharpness (libm's `exp2f`), dithering
    /// when `dither`.
    pub fn new(rcas: &RcasQuality, output: (u32, u32), dither: bool) -> GpuRcasParams {
        let (w, h) = (output.0.max(1) as f32, output.1.max(1) as f32);
        let con = [libm::exp2f(-rcas.sharpness), f32::from(u8::from(dither)), 0.0, f32::from(u8::from(rcas.denoise))];
        GpuRcasParams { con, size: [w, h, 1.0 / w, 1.0 / h] }
    }

    /// The row for a pass that only dithers: RCAS with no sharpening, which writes its input
    /// unchanged (the final write of a frame whose sharpen is off).
    pub fn unsharpened(output: (u32, u32), dither: bool) -> GpuRcasParams {
        let mut row = GpuRcasParams::new(&RcasQuality::DEFAULT, output, dither);
        row.con[0] = 0.0;
        row
    }

    /// The row keyed to `frame_index`'s dither noise.
    pub fn keyed(mut self, frame_index: u64) -> GpuRcasParams {
        self.con[2] = (frame_index % DITHER_FRAME_CYCLE) as f32;
        self
    }
}

/// What EASU plus RCAS cost at `output` size on the budget line (plan §2.5: at most
/// [`COST_BUDGET_MS_1080P`] at 1080p), in milliseconds. The cost follows the output's pixels, not
/// the render step's: DRS adds it to its predictions as a fixed term
/// ([`crate::drs::DrsController::with_fixed_ms`]) so a lower step does not promise a saving the
/// upscale keeps.
pub fn estimated_cost_ms(output: (u32, u32)) -> f32 {
    COST_BUDGET_MS_1080P * (output.0.max(1) as f32 * output.1.max(1) as f32) / COST_REFERENCE_PIXELS
}

/// RCAS's share of [`estimated_cost_ms`] when it runs alone (at scale 1 under TAA's sharpen): it
/// is the lighter of the two passes (the M4 Max's rows: 0.106 ms alone at 1080p, 0.25-0.27 ms
/// with EASU).
pub const RCAS_ALONE_SHARE: f32 = 0.4;

/// What EASU plus RCAS cost on `class` at `output` (RQ5 review): [`estimated_cost_ms`], measured
/// on the M4 Max (a `desktop-high` Mac), scaled by the square root of the bandwidth ratio of the
/// class's work limits (`presets::work_limits`): a model, not a measurement, so a phone's DRS
/// counts its upscale at about three to six times the Mac's instead of the Mac's.
pub fn class_cost_ms(class: crate::device_class::DeviceClass, output: (u32, u32)) -> f32 {
    let reference = crate::device_class::DeviceClass::new(crate::device_class::FormFactor::Desktop, crate::device_class::PerformanceTier::High);
    let bandwidth = |class| crate::presets::work_limits(class).offchip_bytes.max(1) as f32;
    estimated_cost_ms(output) * libm::sqrtf(bandwidth(reference) / bandwidth(class))
}

/// The fixed costs FSR1 adds to a frame of `quality` on `class` at `output`, below scale 1 and at
/// scale 1 (`drs::DrsController::with_upscale_ms`): EASU with RCAS below 1 when FSR1 upscales,
/// RCAS alone at 1 under TAA's sharpen.
pub fn upscale_costs_ms(quality: &Quality, class: crate::device_class::DeviceClass, output: (u32, u32)) -> (f32, f32) {
    let full = output;
    let below = passes(quality, (full.0 / 2, full.1 / 2), full);
    let at_one = passes(quality, full, full);
    let cost = class_cost_ms(class, output);
    let of = |runs: FsrPasses| match (runs.easu, runs.rcas) {
        (true, _) => cost,
        (false, true) => cost * RCAS_ALONE_SHARE,
        (false, false) => 0.0,
    };
    (of(below), of(at_one))
}

/// Which FSR1 passes a frame runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct FsrPasses {
    /// EASU: FSR1 is the upscaler and the scene is drawn below the output size.
    pub easu: bool,
    /// RCAS: after EASU, or alone at scale 1 under TAA's sharpen.
    pub rcas: bool,
}

/// The FSR1 passes `quality` asks for at `render` size into `output` (whether they run is
/// [`LANDED`]'s too).
pub fn passes(quality: &Quality, render: (u32, u32), output: (u32, u32)) -> FsrPasses {
    let easu = quality.hdr && quality.upscaler == Upscaler::Fsr1 && render != output;
    FsrPasses { easu, rcas: easu || quality.anti_aliasing == AntiAliasing::TaaSharpen }
}

fn sized(size: (u32, u32)) -> (u32, u32) {
    (size.0.max(1), size.1.max(1))
}

/// The tonemapped intermediate at `render` size.
pub fn intermediate_target(render: (u32, u32)) -> TargetDesc {
    TargetDesc { label: INTERMEDIATE_LABEL, format: INTERMEDIATE_FORMAT, usage: INTERMEDIATE_USAGE, samples: 1, size: sized(render), mips: 1, srgb_view: false }
}

/// EASU's output at `output` size.
pub fn easu_target(output: (u32, u32)) -> TargetDesc {
    TargetDesc { label: EASU_LABEL, format: INTERMEDIATE_FORMAT, usage: INTERMEDIATE_USAGE, samples: 1, size: sized(output), mips: 1, srgb_view: false }
}

/// What the passes `runs` hold at `render` and `output` size, for the budget ledger.
pub fn bytes(runs: FsrPasses, render: (u32, u32), output: (u32, u32)) -> u64 {
    let texels = |size: (u32, u32)| u64::from(size.0.max(1)) * u64::from(size.1.max(1));
    let input = if runs.easu || runs.rcas { texels(render) } else { 0 };
    let easu = if runs.easu { texels(output) } else { 0 };
    (input + easu) * INTERMEDIATE_TEXEL_BYTES
}

/// One FSR1 run: what a frame hands [`FsrNode::encode`].
pub(crate) struct FsrPass<'a> {
    /// Which passes run ([`passes`]; RCAS writes the target either way).
    pub passes: FsrPasses,
    /// The tonemapped intermediate at `render_size` ([`INTERMEDIATE_FORMAT`]).
    pub input: &'a TextureView,
    /// EASU's output at `output_size` ([`INTERMEDIATE_FORMAT`]); read when `passes.easu`.
    pub easu: &'a TextureView,
    /// RCAS's target: the world target at `output_size`.
    pub target: &'a TextureView,
    /// The target's format.
    pub format: TextureFormat,
    /// The step's render size.
    pub render_size: (u32, u32),
    /// The world target's size.
    pub output_size: (u32, u32),
    /// RCAS's sharpness; None leaves the image unsharpened (the pass only dithers).
    pub rcas: Option<&'a RcasQuality>,
    /// Whether the final write dithers (frame 0 of a capture, every live frame).
    pub dither: bool,
    /// The frame the dither is keyed to.
    pub frame_index: u64,
    /// Changes whenever a view above is re-created (bind groups follow it).
    pub generation: u64,
}

/// Timestamps around a run: the query set (begin at 0, end at 1) and whether this run is the
/// first and the last of a timed span.
pub(crate) type FsrStamps<'a> = (&'a wgpu::QuerySet, bool, bool);

/// The FSR1 upscaler's passes (graph node 22): EASU into [`INTERMEDIATE_FORMAT`] at output size,
/// then RCAS and the final dither into the world target.
pub(crate) struct FsrNode {
    modules: (ShaderModule, ShaderModule),
    easu_layout: BindGroupLayout,
    rcas_layout: BindGroupLayout,
    easu_pipeline_layout: PipelineLayout,
    rcas_pipeline_layout: PipelineLayout,
    sampler: Sampler,
    easu_params: Buffer,
    rcas_params: Buffer,
    easu_pipeline: Option<Compiled<RenderPipeline>>,
    rcas_pipelines: Vec<(TextureFormat, Compiled<RenderPipeline>)>,
    easu_group: Option<(u64, BindGroup)>,
    /// RCAS reading EASU's output, and RCAS reading the intermediate itself.
    rcas_groups: [Option<(u64, BindGroup)>; 2],
}

/// The timestamp writes of one pass of a timed span: `opens` the span when it is a first run's
/// first pass, `closes` it when it is a last run's last pass.
fn stamp_writes<'a>(stamps: Option<FsrStamps<'a>>, opens: bool, closes: bool) -> Option<wgpu::RenderPassTimestampWrites<'a>> {
    let (query_set, first, last) = stamps?;
    let begin = (opens && first).then_some(0);
    let end = (closes && last).then_some(1);
    (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end })
}

fn float_texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D2,
        multisampled: false,
    };
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None };
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn fullscreen(device: &Device, label: &str, layout: &PipelineLayout, module: &ShaderModule, entries: (&str, &str), format: TextureFormat) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some(entries.0), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entries.1),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl FsrNode {
    pub(crate) fn new(device: &Device) -> Result<FsrNode, RenderError> {
        let easu = crate::shaders::module(device, "fsr easu", EASU)?;
        let rcas = crate::shaders::module(device, "fsr rcas", RCAS)?;
        let easu_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fsr easu"),
            entries: &[
                float_texture_entry(0),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                uniform_entry(2),
            ],
        });
        let rcas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("fsr rcas"), entries: &[float_texture_entry(0), uniform_entry(1)] });
        // Gathers ignore the filter; clamping is what holds the frame's edge texels.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("fsr easu"), ..Default::default() });
        Ok(FsrNode {
            easu_pipeline_layout: pipeline_layout(device, "fsr easu", &[&easu_layout]),
            rcas_pipeline_layout: pipeline_layout(device, "fsr rcas", &[&rcas_layout]),
            modules: (easu, rcas),
            easu_layout,
            rcas_layout,
            sampler,
            easu_params: buffer(device, "fsr easu params", size_of::<GpuEasuParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            rcas_params: buffer(device, "fsr rcas params", size_of::<GpuRcasParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            easu_pipeline: None,
            rcas_pipelines: Vec::new(),
            easu_group: None,
            rcas_groups: [None, None],
        })
    }

    /// Make EASU's pipeline and RCAS's into `format` now (the first frame that can run them), so
    /// a dynamic-resolution step into or out of an upscale compiles nothing.
    pub(crate) fn prewarm(&mut self, device: &Device, format: TextureFormat) {
        self.easu_pipeline(device);
        self.rcas_pipeline(device, format);
    }

    /// The EASU pipeline, made on first use (a pipeline-shaping change prewarms it at the frame
    /// that asks, never mid-pass).
    fn easu_pipeline(&mut self, device: &Device) -> Compiled<RenderPipeline> {
        let (layout, module) = (&self.easu_pipeline_layout, &self.modules.0);
        self.easu_pipeline.get_or_insert_with(|| fullscreen(device, "fsr easu", layout, module, ("vs_easu", "fs_easu"), INTERMEDIATE_FORMAT)).clone()
    }

    /// The RCAS pipeline writing `format`, made on first use.
    fn rcas_pipeline(&mut self, device: &Device, format: TextureFormat) -> Compiled<RenderPipeline> {
        if let Some((_, pipeline)) = self.rcas_pipelines.iter().find(|(held, _)| *held == format) {
            return pipeline.clone();
        }
        let pipeline = fullscreen(device, "fsr rcas", &self.rcas_pipeline_layout, &self.modules.1, ("vs_rcas", "fs_rcas"), format);
        self.rcas_pipelines.push((format, pipeline.clone()));
        pipeline
    }

    fn easu_group(&mut self, device: &Device, input: &TextureView, generation: u64) -> BindGroup {
        if let Some((held, group)) = &self.easu_group
            && *held == generation
        {
            return group.clone();
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fsr easu"),
            layout: &self.easu_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(input) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: self.easu_params.as_entire_binding() },
            ],
        });
        self.easu_group = Some((generation, group.clone()));
        group
    }

    fn rcas_group(&mut self, device: &Device, input: &TextureView, after_easu: bool, generation: u64) -> BindGroup {
        let slot = usize::from(!after_easu);
        if let Some((held, group)) = &self.rcas_groups[slot]
            && *held == generation
        {
            return group.clone();
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("fsr rcas"),
            layout: &self.rcas_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(input) },
                wgpu::BindGroupEntry { binding: 1, resource: self.rcas_params.as_entire_binding() },
            ],
        });
        self.rcas_groups[slot] = Some((generation, group.clone()));
        group
    }

    /// Record one run: EASU when `pass.passes.easu`, then RCAS and the dither into the target.
    pub(crate) fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, pass: &FsrPass<'_>) {
        self.encode_timed(device, queue, encoder, pass, None);
    }

    /// [`FsrNode::encode`] with timestamps around the run's passes.
    pub(crate) fn encode_timed(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, pass: &FsrPass<'_>, stamps: Option<FsrStamps<'_>>) {
        if pass.passes.easu {
            queue.write_buffer(&self.easu_params, 0, bytemuck::bytes_of(&GpuEasuParams::new(pass.render_size, pass.output_size)));
            let (pipeline, group) = (self.easu_pipeline(device), self.easu_group(device, pass.input, pass.generation));
            let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fsr easu"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: pass.easu,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                timestamp_writes: stamp_writes(stamps, true, false),
                ..Default::default()
            });
            render.set_pipeline(&pipeline);
            render.set_bind_group(0, &group, &[]);
            render.draw(0..3, 0..1);
        }
        let base = pass.rcas.map_or_else(|| GpuRcasParams::unsharpened(pass.output_size, pass.dither), |rcas| GpuRcasParams::new(rcas, pass.output_size, pass.dither));
        queue.write_buffer(&self.rcas_params, 0, bytemuck::bytes_of(&base.keyed(pass.frame_index)));
        let input = if pass.passes.easu { pass.easu } else { pass.input };
        let (pipeline, group) = (self.rcas_pipeline(device, pass.format), self.rcas_group(device, input, pass.passes.easu, pass.generation));
        // The span opens on EASU's pass, or on RCAS's when EASU does not run.
        let timestamp_writes = stamp_writes(stamps, !pass.passes.easu, true);
        let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("fsr rcas"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: pass.target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            timestamp_writes,
            ..Default::default()
        });
        render.set_pipeline(&pipeline);
        render.set_bind_group(0, &group, &[]);
        render.draw(0..3, 0..1);
    }
}

// ---------------------------------------------------------------------------------------------
// Standalone image helpers (checks and cost rows)

/// The result of [`upscale_image`].
pub struct FsrImage {
    /// EASU's output decoded to 0..1 (None when the image was not upscaled).
    pub easu: Option<Vec<[f32; 3]>>,
    /// The world target after RCAS and the dither.
    pub capture: Capture,
}

/// A 0..1 channel as 10 bits.
fn unorm10(value: f32) -> u32 {
    (value.clamp(0.0, 1.0) * 1023.0 + 0.5) as u32
}

/// `texel` packed into [`INTERMEDIATE_FORMAT`] (opaque).
fn pack_rgb10a2(texel: [f32; 4]) -> u32 {
    unorm10(texel[0]) | unorm10(texel[1]) << 10 | unorm10(texel[2]) << 20 | 3 << 30
}

/// The reference radius of the gather's taps: [`INTERMEDIATE_FORMAT`] rounds to 1/1023.
pub const INTERMEDIATE_STEP: f32 = 1.0 / 1023.0;

/// Run the FSR1 passes over a `size` image of display-encoded colour in 0..1 (`texels`, row by
/// row, quantized to [`INTERMEDIATE_FORMAT`]) onto an `output`-sized `Bgra8Unorm` capture, through
/// the node the renderer records: EASU when the sizes differ, then RCAS with `rcas` (None:
/// unsharpened) and the dither when `dither` (frame 0).
pub fn upscale_image(gpu: &Gpu, (size, texels): ((u32, u32), &[[f32; 4]]), output: (u32, u32), rcas: Option<&RcasQuality>, dither: bool) -> Result<FsrImage, RenderError> {
    crate::capture::check_capture_size(size.0, size.1)?;
    crate::capture::check_capture_size(output.0, output.1)?;
    if texels.len() != (size.0 * size.1) as usize {
        return Err(capture_failed(format!("{} texels for a {}x{} image", texels.len(), size.0, size.1)));
    }
    let device = &gpu.device;
    let texture = |label, size: (u32, u32), format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let input_texture = texture("fsr image", size, INTERMEDIATE_FORMAT, INTERMEDIATE_USAGE | TextureUsages::COPY_DST);
    let packed: Vec<u32> = texels.iter().map(|texel| pack_rgb10a2(*texel)).collect();
    gpu.queue.write_texture(
        input_texture.as_image_copy(),
        bytemuck::cast_slice(&packed),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * 4), rows_per_image: Some(size.1) },
        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
    );
    let easu_texture = texture("fsr easu image", output, INTERMEDIATE_FORMAT, INTERMEDIATE_USAGE | TextureUsages::COPY_SRC);
    let world_format = crate::renderer::WORLD_FORMAT;
    let target_texture = texture("fsr target", output, world_format, TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC);
    let views = (input_texture.create_view(&Default::default()), easu_texture.create_view(&Default::default()), target_texture.create_view(&Default::default()));
    let runs = passes_between(size, output);
    let mut node = FsrNode::new(device)?;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("fsr image") });
    let pass = FsrPass {
        passes: runs,
        input: &views.0,
        easu: &views.1,
        target: &views.2,
        format: world_format,
        render_size: size,
        output_size: output,
        rcas,
        dither,
        frame_index: 0,
        generation: 0,
    };
    node.encode(device, &gpu.queue, &mut encoder, &pass);
    let padded = |width: u32| (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let stage = |label, texture: &wgpu::Texture, encoder: &mut wgpu::CommandEncoder| -> Result<Buffer, RenderError> {
        let staging = buffer(device, label, u64::from(padded(output.0)) * u64::from(output.1), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded(output.0)), rows_per_image: Some(output.1) },
            },
            wgpu::Extent3d { width: output.0, height: output.1, depth_or_array_layers: 1 },
        );
        Ok(staging)
    };
    let easu_staging = if runs.easu { Some(stage("fsr easu readback", &easu_texture, &mut encoder)?) } else { None };
    let target_staging = stage("fsr readback", &target_texture, &mut encoder)?;
    gpu.queue.submit([encoder.finish()]);
    let bytes = u64::from(padded(output.0)) * u64::from(output.1);
    let easu = match &easu_staging {
        Some(staging) => {
            let data = map_read_blocking(gpu, staging, bytes)?;
            let decoded = (0..output.1)
                .flat_map(|y| (0..output.0).map(move |x| (y, x)))
                .map(|(y, x)| {
                    let at = (y * padded(output.0) + x * 4) as usize;
                    let bits = u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]);
                    [bits & 1023, bits >> 10 & 1023, bits >> 20 & 1023].map(|c| c as f32 / 1023.0)
                })
                .collect();
            Some(decoded)
        }
        None => None,
    };
    let data = map_read_blocking(gpu, &target_staging, bytes)?;
    Ok(FsrImage { easu, capture: Capture::from_padded_rows(output.0, output.1, padded(output.0), &data)? })
}

/// The passes an upscale from `render` to `output` runs when FSR1 is the upscaler: EASU when the
/// sizes differ, and RCAS always (the final write).
fn passes_between(render: (u32, u32), output: (u32, u32)) -> FsrPasses {
    FsrPasses { easu: render != output, rcas: true }
}

/// The GPU milliseconds of EASU plus RCAS from a `render`-sized image to `output`, one per sample
/// of `frames` after [`COST_WARMUP_SAMPLES`] dropped ones, from timestamps around the passes; None
/// without `TIMESTAMP_QUERY`. Each sample
/// records [`COST_RUNS_PER_SAMPLE`] runs back to back in one submission and reports their mean, so
/// the GPU runs at a frame's clocks rather than idling between samples (the bloom row's method).
pub fn gpu_ms(gpu: &Gpu, render: (u32, u32), output: (u32, u32), frames: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let texture = |label, size: (u32, u32), format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: size.0.max(1), height: size.1.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let world_format = crate::renderer::WORLD_FORMAT;
    let input = texture("fsr cost input", render, INTERMEDIATE_FORMAT, INTERMEDIATE_USAGE).create_view(&Default::default());
    let easu = texture("fsr cost easu", output, INTERMEDIATE_FORMAT, INTERMEDIATE_USAGE).create_view(&Default::default());
    let target = texture("fsr cost target", output, world_format, TextureUsages::RENDER_ATTACHMENT).create_view(&Default::default());
    let runs = passes_between(render, output);
    let mut node = FsrNode::new(device)?;
    let rcas = RcasQuality::DEFAULT;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("fsr cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "fsr cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(frames as usize);
    for sample in 0..COST_WARMUP_SAMPLES + frames {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("fsr cost") });
        for run in 0..COST_RUNS_PER_SAMPLE {
            let pass = FsrPass {
                passes: runs,
                input: &input,
                easu: &easu,
                target: &target,
                format: world_format,
                render_size: render,
                output_size: output,
                rcas: Some(&rcas),
                dither: true,
                frame_index: u64::from(run),
                generation: 0,
            };
            node.encode_timed(device, &gpu.queue, &mut encoder, &pass, Some((&query_set, run == 0, run + 1 == COST_RUNS_PER_SAMPLE)));
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission, after the runs': Metal resolves counter samples without
        // waiting for the passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("fsr cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period).filter(|_| sample >= COST_WARMUP_SAMPLES) {
            costs.push(ms / COST_RUNS_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::RenderFeature;

    #[test]
    fn easu_runs_below_the_output_size_and_rcas_after_it_or_alone_under_taa_sharpen() {
        let mut quality = Quality::off();
        quality.hdr = true;
        quality.set_feature(RenderFeature::Upscaler, true);
        let (half, full) = ((960, 540), (1920, 1080));
        assert_eq!(passes(&quality, half, full), FsrPasses { easu: true, rcas: true });
        assert_eq!(passes(&quality, full, full), FsrPasses::default(), "nothing to upscale at scale 1");
        quality.anti_aliasing = AntiAliasing::TaaSharpen;
        assert_eq!(passes(&quality, full, full), FsrPasses { easu: false, rcas: true });
        assert_eq!(passes(&Quality::off(), half, full), FsrPasses::default(), "the legacy renderer stretches bilinearly");
        assert_eq!(bytes(FsrPasses { easu: true, rcas: true }, (2, 2), (4, 4)), (4 + 16) * 4);
        assert_eq!(bytes(FsrPasses::default(), (2, 2), (4, 4)), 0);
    }

    #[test]
    fn rcas_sharpness_is_a_linear_scale_of_its_stops() {
        assert_eq!(GpuRcasParams::new(&RcasQuality::DEFAULT.with_sharpness(0.0), (4, 2), true).con, [1.0, 1.0, 0.0, 1.0], "noise detection on");
        assert_eq!(GpuRcasParams::new(&RcasQuality::DEFAULT.with_denoise(false), (4, 2), true).con[3], 0.0);
        assert_eq!(GpuRcasParams::new(&RcasQuality::DEFAULT.with_sharpness(1.0), (4, 2), false).con[0], 0.5);
        assert_eq!(GpuRcasParams::new(&RcasQuality::DEFAULT, (4, 2), false).size, [4.0, 2.0, 0.25, 0.5]);
    }
}
