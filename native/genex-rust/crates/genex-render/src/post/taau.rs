//! TAA upscaling at output size (renderer pass 2, B.8; T-05). Below a render scale of 1 on the
//! TAA presets, the jittered samples drawn at render size accumulate into a history at **output**
//! size, so a dynamic-resolution step to 0.67 keeps the output's detail instead of averaging the
//! samples at render size and letting EASU invent the edges from one frame.
//!
//! Two full-screen fragment passes ([`TAAU`], shaders/post/taau.wgsl), after Snapdragon Game
//! Super Resolution v2's 2-pass fragment shader (BSD-3-Clause, Qualcomm) with FidelityFX FSR2
//! v1.1.4's Lanczos-2 and kernel bias (MIT, AMD):
//! - **convert** at render size: dilated motion (closest depth in the 3x3, the camera's motion at
//!   the far plane), the current frame's least weight (reactive coverage, or 1 where the history is
//!   disoccluded, our TAA's depth-key test) and the 3x3's farthest key for next frame's test; a
//!   ping-pong pair at render size ([`convert_targets`]);
//! - **upscale** at output size: the render sample nearest each output pixel and its four edge
//!   neighbours (SGSR2's five taps) weighted by Lanczos-2 of their jittered distance (kernel bias
//!   [`kernel_bias`]), deringed; the history read bilinearly at its previous position and clipped
//!   to the taps' box (wide at rest, [`STILL_GAMMA`]; the variance box from a render pixel of
//!   motion); the history's alpha holds its accumulated sample weight, which grows by each frame's
//!   Lanczos weight up to `1 / alpha_min` ([`MOVING_WEIGHT_MAX`] on a moving pixel), so a sample
//!   landing on the output pixel counts whole and one a render pixel away little.
//!
//! The jitter cycle follows the ratio ([`jitter_phases`]: FSR2's `ceil(8 · (display / render)²)`)
//! and so does the materials' mip bias ([`texture_lod_bias`]: `log2(render / display) − 1`). At
//! scale 1 ([`upscales`] false) the frame keeps TAA at its own size ([`crate::post::taa`]).
//! Fragment only: no storage textures, no compute, no atomics, so it fits WebGPU core and phones.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroupLayout, Buffer, BufferUsages, Device, Queue, RenderPipeline, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::post::taa::{GpuTaaParams, TaaFlags, TaaImage};
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{FrameConfig, TAA_LOD_BIAS_MIN, TaaQuality};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// The upscale's two passes (shaders/post/taau.wgsl).
pub const TAAU: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/taau.wgsl"));

/// The output-size history: rgb the radiance, a the accumulated sample weight.
pub const HISTORY_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The convert pass's target at render size: xy the dilated motion, z the current frame's least
/// weight, w the 3x3's farthest depth key.
pub const CONVERT_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Usage of both pairs: drawn, then sampled by the next pass or frame.
pub const TARGET_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The history pair's labels.
pub const HISTORY_LABELS: [&str; 2] = ["taau history a", "taau history b"];
/// The convert pair's labels.
pub const CONVERT_LABELS: [&str; 2] = ["taau convert a", "taau convert b"];
/// Bytes per texel of either pair.
pub const TEXEL_BYTES: u64 = 8;
/// The jitter phases per squared upscale ratio (FSR2's `ffxFsr2GetJitterPhaseCount` base).
pub const JITTER_PHASES_PER_RATIO_SQ: f32 = 8.0;
/// The most jitter phases (the TAA row keeps them in eight bits).
pub const JITTER_PHASES_MAX: u32 = 255;
/// The largest Lanczos kernel bias (FSR2 `ComputeMaxKernelWeight`: 1.99).
pub const KERNEL_BIAS_MAX: f32 = 1.99;
/// The kernel bias per unit of upscale ratio: FSR2 scales distances by the ratio itself and
/// sharpens afterwards with RCAS; a third more keeps the output's detail without it (B.8's
/// sharpness row: 0.77 of native at 1.0, 0.96 at the cap, at 0.67).
pub const KERNEL_SHARPNESS: f32 = 4.0 / 3.0;
/// A fresh pixel's kernel bias share of `1 + bias` (FSR2: `max(1, (1 + bias) · 0.3)`).
pub const FRESH_KERNEL_SHARE: f32 = 0.3;
/// The extra mip bias beside `log2(render / display)` (FSR2 README "Mipmap biasing": −1).
pub const UPSCALE_LOD_BIAS: f32 = -1.0;
/// A still pixel's box half-size in standard deviations (`GX_TAAU_STILL_GAMMA`): wide, so the
/// taps' min/max bound it (the render taps are coarser than the output's detail; a 1.25 σ box clipped
/// the detail the jitter cycle built). It narrows to TAA's [`crate::post::taa::VARIANCE_GAMMA`] over
/// [`BOX_MOTION_PX`].
pub const STILL_GAMMA: f32 = 8.0;
/// The motion, render pixels a frame, at which the box is the variance box (`GX_TAAU_BOX_MOTION_PX`).
pub const BOX_MOTION_PX: f32 = 1.0;
/// The most accumulated sample weight a moving pixel's history keeps (`GX_TAAU_MOVING_WEIGHT_MAX`,
/// as SGSR2 caps its history under motion): every frame resamples the history bilinearly, and a
/// longer memory compounds that into blur (B.8's pan row: 0.53 of native's sharpness at 8, 1.07 at 3).
pub const MOVING_WEIGHT_MAX: f32 = 3.0;
/// The motion, render pixels a frame, at which [`MOVING_WEIGHT_MAX`] applies whole (`GX_TAAU_MOVING_PX`).
pub const MOVING_PX: f32 = 0.1;
/// A reconstruction whose Lanczos weights sum below this takes its nearest sample
/// (`GX_TAAU_LEAST_SAMPLE_WEIGHT`).
pub const LEAST_SAMPLE_WEIGHT: f32 = 0.05;
/// Resolves per cost sample.
pub const COST_RESOLVES_PER_SAMPLE: u32 = 32;

const PARAMS_BINDING: u32 = 0;
const SAMPLER_BINDING: u32 = 1;

/// Whether a frame drawn at `render` into `output` upscales temporally (below the output size;
/// at scale 1 TAA resolves at its own size).
pub fn upscales(render: (u32, u32), output: (u32, u32)) -> bool {
    render.0 < output.0 || render.1 < output.1
}

fn sized(size: (u32, u32)) -> (u32, u32) {
    (size.0.max(1), size.1.max(1))
}

/// The upscale ratio (output / render, by width; at least 1).
pub fn ratio(render: (u32, u32), output: (u32, u32)) -> f32 {
    (sized(output).0 as f32 / sized(render).0 as f32).max(1.0)
}

/// The jitter cycle's phases for `render` into `output`: FSR2's `ceil(8 · ratio²)`, eight at
/// scale 1 (TAA's cycle), at most [`JITTER_PHASES_MAX`].
pub fn jitter_phases(render: (u32, u32), output: (u32, u32)) -> u32 {
    let r = ratio(render, output);
    let phases = libm::ceilf(JITTER_PHASES_PER_RATIO_SQ * r * r - 1e-4) as u32;
    phases.clamp(8, JITTER_PHASES_MAX)
}

/// The jitter of frame `frame_index` in a cycle of `phases`, render pixels in `(-0.5, 0.5)` (x
/// right, y down): Halton(2, 3) at the phase + 1, as [`crate::jitter::offset_px`] (eight phases
/// are TAA's cycle).
pub fn offset_px(frame_index: u64, phases: u32) -> [f32; 2] {
    let at = (frame_index % u64::from(phases.max(1))) as u32 + 1;
    crate::jitter::HALTON_BASES.map(|base| crate::jitter::halton(at, base) - 0.5)
}

/// The mip bias materials sample with under the upscale at `render_scale`: `log2(scale) − 1`, held
/// at [`TAA_LOD_BIAS_MIN`] (NaN reads scale 1).
pub fn texture_lod_bias(render_scale: f32) -> f32 {
    let scale = if render_scale.is_nan() { 1.0 } else { render_scale.clamp(crate::settings::RENDER_SCALE_MIN, 1.0) };
    (libm::log2f(scale) + UPSCALE_LOD_BIAS).max(TAA_LOD_BIAS_MIN)
}

/// The jitter of frame `frame_index` drawn at `render` into `output`: the upscale's phases
/// ([`jitter_phases`]) when it [`upscales`], else TAA's `cycle` ([`crate::jitter::offset_px`]), so a
/// frame at scale 1 keeps today's positions. What `RenderSettings::frame_config` asks once the
/// renderer wires the upscale.
pub fn frame_jitter(frame_index: u64, render: (u32, u32), output: (u32, u32), cycle: crate::settings::JitterCycle) -> [f32; 2] {
    if upscales(render, output) {
        return offset_px(frame_index, jitter_phases(render, output));
    }
    crate::jitter::offset_px(frame_index, cycle)
}

/// The frames a settled capture re-renders at `render` into `output`: one cycle of the upscale's
/// phases when it [`upscales`], else TAA's `cycle`.
pub fn settle_frames(render: (u32, u32), output: (u32, u32), cycle: crate::settings::JitterCycle) -> u32 {
    if upscales(render, output) { jitter_phases(render, output) } else { cycle.frames() }
}

/// The mip bias of a frame TAA resolves at `render_scale`: the upscale's ([`texture_lod_bias`])
/// when it [`upscales`] the frame (`upscaling`), else TAA's own ([`TaaQuality::texture_lod_bias`]).
pub fn frame_texture_lod_bias(taa: &TaaQuality, upscaling: bool, render_scale: f32) -> f32 {
    if upscaling { texture_lod_bias(render_scale) } else { taa.texture_lod_bias(render_scale) }
}

/// The Lanczos kernel bias at rest and on a fresh pixel for `render` into `output`: distances in
/// render pixels are scaled by it. At rest `min(1.99, ratio · KERNEL_SHARPNESS)` (FSR2's
/// `ComputeMaxKernelWeight` is `min(1.99, ratio)`, followed by RCAS); fresh FSR2's
/// `max(1, (1 + ratio) · 0.3)`, wider, as a fresh pixel has one frame of samples.
pub fn kernel_bias(render: (u32, u32), output: (u32, u32)) -> [f32; 2] {
    let r = ratio(render, output);
    [(r * KERNEL_SHARPNESS).min(KERNEL_BIAS_MAX), ((1.0 + r) * FRESH_KERNEL_SHARE).max(1.0)]
}

/// The upscale's uniform (`TaauParams` in shaders/post/taau.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuTaauParams {
    /// xy: the render size; zw: 1 / it.
    pub render: [f32; 4],
    /// xy: the output size; zw: 1 / it.
    pub output: [f32; 4],
    /// xy: this frame's jitter in render pixels (x right, y down); zw: the previous frame's.
    pub jitter: [f32; 4],
    /// As [`GpuTaaParams::params`]: x alpha_min, y the exposure ratio, z the disocclusion
    /// tolerance, w the current weight per render pixel of motion.
    pub params: [f32; 4],
    /// x: the kernel bias at rest; y: on a fresh pixel ([`kernel_bias`]).
    pub kernel: [f32; 4],
    /// As [`GpuTaaParams::counts`]: x frames since the reset, y 1 on a reset, z 1 under reverse-Z,
    /// w flags with the phases from bit 8.
    pub counts: [u32; 4],
    /// As [`GpuTaaParams::reproject`].
    pub reproject: [f32; 16],
}

impl GpuTaauParams {
    /// The row for the frame `config` describes (its render and output sizes), with `taa`'s floor,
    /// the previous frame's jitter and the exposure ratio.
    pub fn new(taa: &TaaQuality, config: &FrameConfig, prev_jitter: [f32; 2], exposure_ratio: f32) -> GpuTaauParams {
        let row = GpuTaaParams::new(taa, config, prev_jitter, exposure_ratio);
        let (render, output) = (sized(config.render_size), sized(config.output_size));
        let (w, h) = (output.0 as f32, output.1 as f32);
        let [at_rest, fresh] = kernel_bias(render, output);
        let phases = jitter_phases(render, output);
        let counts = [row.counts[0], row.counts[1], row.counts[2], TaaFlags::CLIP.bits() | phases << crate::post::taa::JITTER_CYCLE_SHIFT];
        GpuTaauParams {
            render: row.size,
            output: [w, h, 1.0 / w, 1.0 / h],
            jitter: row.jitter,
            params: row.params,
            kernel: [at_rest, fresh, 0.0, 0.0],
            counts,
            reproject: row.reproject,
        }
    }

    /// The row with the camera's reprojection (a non-finite matrix keeps the identity).
    pub fn with_reproject(mut self, reproject: [f32; 16]) -> GpuTaauParams {
        if reproject.iter().all(|value| value.is_finite()) {
            self.reproject = reproject;
        }
        self
    }

    /// The row starting history over.
    pub const fn reset(mut self) -> GpuTaauParams {
        self.counts[0] = 0;
        self.counts[1] = 1;
        self.jitter[2] = self.jitter[0];
        self.jitter[3] = self.jitter[1];
        self
    }

    /// Whether the row starts history over.
    pub const fn resets(&self) -> bool {
        self.counts[1] != 0
    }
}

/// The history pair at `output` size.
pub fn history_targets(output: (u32, u32)) -> [TargetDesc; 2] {
    let size = sized(output);
    HISTORY_LABELS.map(|label| TargetDesc { label, format: HISTORY_FORMAT, usage: TARGET_USAGE, samples: 1, size, mips: 1, srgb_view: false })
}

/// The convert pair at `render` size.
pub fn convert_targets(render: (u32, u32)) -> [TargetDesc; 2] {
    let size = sized(render);
    CONVERT_LABELS.map(|label| TargetDesc { label, format: CONVERT_FORMAT, usage: TARGET_USAGE, samples: 1, size, mips: 1, srgb_view: false })
}

/// What the upscale holds, for the budget ledger: the history pair at output size and the convert
/// pair at render size.
pub fn bytes(render: (u32, u32), output: (u32, u32)) -> u64 {
    let texels = |(w, h): (u32, u32)| u64::from(w) * u64::from(h);
    2 * TEXEL_BYTES * (texels(sized(output)) + texels(sized(render)))
}

// ---------------------------------------------------------------------------------------------
// The node

/// What one upscale reads: the jittered HDR scene and its depth at render size, the motion target
/// and the reactive mask (neutral when None), the sizes and the frame's row.
pub struct TaauInput<'a> {
    /// The 1x HDR scene at render size.
    pub scene: &'a TextureView,
    /// The scene's depth (`Depth32Float`).
    pub depth: &'a TextureView,
    /// The motion target (NDC, current − previous, jitter removed); None reads zero motion.
    pub motion: Option<&'a TextureView>,
    /// The reactive mask; None reads zero.
    pub reactive: Option<&'a TextureView>,
    /// The render size.
    pub render: (u32, u32),
    /// The output size (the history's).
    pub output: (u32, u32),
    /// The frame's row ([`GpuTaauParams::new`]).
    pub row: GpuTaauParams,
}

/// What one upscale wrote.
pub struct TaauOutput {
    /// The upscaled scene at output size: this frame's history (rgb; alpha its weight).
    pub view: TextureView,
    /// Whether it started history over.
    pub reset: bool,
    /// The history slot it wrote.
    pub slot: usize,
}

struct Target {
    size: (u32, u32),
    texture: Texture,
    view: TextureView,
}

/// The upscale's pipelines, its pairs (each slot made at the size of the pass that writes it) and
/// neutral inputs.
pub struct TaauNode {
    convert: Compiled<RenderPipeline>,
    upscale: Compiled<RenderPipeline>,
    params_layout: BindGroupLayout,
    convert_layout: BindGroupLayout,
    upscale_layout: BindGroupLayout,
    params_group: wgpu::BindGroup,
    params: Buffer,
    neutral_motion: TextureView,
    neutral_reactive: TextureView,
    neutral_convert: TextureView,
    neutral_history: TextureView,
    converts: [Option<Target>; 2],
    histories: [Option<Target>; 2],
    written: Option<usize>,
    frames: u32,
    extra_usage: TextureUsages,
}

fn entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn float_texture(binding: u32) -> wgpu::BindGroupLayoutEntry {
    entry(
        binding,
        wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
    )
}

fn neutral(device: &Device, queue: &Queue, label: &str, format: TextureFormat, texel: &[u8]) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        texture.as_image_copy(),
        texel,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(texel.len() as u32), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
    texture.create_view(&Default::default())
}

fn target(device: &Device, desc: &TargetDesc, extra_usage: TextureUsages) -> Target {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(desc.label),
        size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: desc.format,
        usage: desc.usage | extra_usage,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    Target { size: desc.size, texture, view }
}

fn pipeline(device: &Device, module: &wgpu::ShaderModule, layout: &wgpu::PipelineLayout, label: &str, fragment: &str, format: TextureFormat) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(
        device,
        &wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState { module, entry_point: Some("vs_taau"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fragment),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        },
    )
}

fn texture_entry(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

/// One full-screen pass into `view` (every texel written: nothing to load).
fn draw(
    encoder: &mut wgpu::CommandEncoder,
    label: &str,
    view: &TextureView,
    pipeline: &RenderPipeline,
    groups: &[&wgpu::BindGroup],
    timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
        })],
        timestamp_writes,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    for (index, group) in groups.iter().enumerate() {
        pass.set_bind_group(index as u32, *group, &[]);
    }
    pass.draw(0..3, 0..1);
}

/// The timestamps around both passes: the beginning on the convert, the end on the upscale.
pub struct TaauStamps<'a> {
    /// The query set.
    pub query_set: &'a wgpu::QuerySet,
    /// The index written at the convert's beginning, if any.
    pub begin: Option<u32>,
    /// The index written at the upscale's end, if any.
    pub end: Option<u32>,
}

impl TaauNode {
    /// The node.
    pub fn new(device: &Device, queue: &Queue) -> Result<TaauNode, RenderError> {
        TaauNode::with_usage(device, queue, TextureUsages::empty())
    }

    /// A node whose history also carries `extra_usage` (a readback's or a copy's `COPY_SRC`).
    pub(crate) fn with_usage(device: &Device, queue: &Queue, extra_usage: TextureUsages) -> Result<TaauNode, RenderError> {
        let module = crate::shaders::module(device, "taau", TAAU)?;
        let params_size = wgpu::BufferSize::new(size_of::<GpuTaauParams>() as u64);
        let params_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("taau params"),
            entries: &[
                entry(PARAMS_BINDING, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: params_size }),
                entry(SAMPLER_BINDING, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
            ],
        });
        let depth = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
        let convert_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("taau convert"),
            entries: &[entry(0, depth), float_texture(1), float_texture(2), float_texture(3)],
        });
        let upscale_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("taau upscale"), entries: &[float_texture(0), float_texture(1), float_texture(2)] });
        let empty = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("taau none"), entries: &[] });
        let convert = pipeline(device, &module, &pipeline_layout(device, "taau convert", &[&params_layout, &convert_layout]), "taau convert", "fs_taau_convert", CONVERT_FORMAT);
        let upscale = pipeline(device, &module, &pipeline_layout(device, "taau upscale", &[&params_layout, &empty, &upscale_layout]), "taau upscale", "fs_taau", HISTORY_FORMAT);
        // Clamped at the edges: the history read near the frame's edge never wraps to the far side.
        let sampler: Sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("taau history"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let params = buffer(device, "taau params", size_of::<GpuTaauParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let params_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("taau params"),
            layout: &params_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: PARAMS_BINDING, resource: params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        Ok(TaauNode {
            convert,
            upscale,
            params_layout,
            convert_layout,
            upscale_layout,
            params_group,
            params,
            neutral_motion: neutral(device, queue, "taau no motion", crate::motion::MOTION_FORMAT, &[0u8; 4]),
            neutral_reactive: neutral(device, queue, "taau no reactive", crate::post::taa::REACTIVE_FORMAT, &[0u8]),
            neutral_convert: neutral(device, queue, "taau no convert", CONVERT_FORMAT, &[0u8; 8]),
            neutral_history: neutral(device, queue, "taau no history", HISTORY_FORMAT, &[0u8; 8]),
            converts: [None, None],
            histories: [None, None],
            written: None,
            frames: 0,
            extra_usage,
        })
    }

    /// Forget the history: the next upscale starts over.
    pub fn reset(&mut self) {
        self.written = None;
    }

    /// The bytes both pairs hold now.
    pub fn history_bytes(&self) -> u64 {
        self.converts.iter().chain(&self.histories).flatten().map(|t| u64::from(t.size.0) * u64::from(t.size.1) * TEXEL_BYTES).sum()
    }

    /// The params layout (group 0 of both passes).
    pub fn params_layout(&self) -> &BindGroupLayout {
        &self.params_layout
    }

    /// Record the convert and the upscale of `input` into the slots the last frame did not write,
    /// and swap. A row asking for a reset, or a pair just (re)made, starts over.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: TaauInput<'_>) -> TaauOutput {
        self.encode_timed(device, queue, encoder, input, None)
    }

    fn slot(slots: &mut [Option<Target>; 2], device: &Device, desc: &TargetDesc, extra_usage: TextureUsages) -> bool {
        let index = if desc.label.ends_with('a') { 0 } else { 1 };
        let remake = slots[index].as_ref().is_none_or(|t| t.size != desc.size);
        if remake {
            slots[index] = Some(target(device, desc, extra_usage));
        }
        remake
    }

    /// [`TaauNode::encode`] with timestamps around both passes.
    pub fn encode_timed(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: TaauInput<'_>, stamps: Option<TaauStamps<'_>>) -> TaauOutput {
        let read = self.written.unwrap_or(1);
        let write = 1 - read;
        let made_history = TaauNode::slot(&mut self.histories, device, &history_targets(input.output)[write], self.extra_usage);
        TaauNode::slot(&mut self.converts, device, &convert_targets(input.render)[write], TextureUsages::empty());
        // A history of another output size (a resize) cannot be reprojected in uv: start over.
        let read_size_ok = self.histories[read].as_ref().is_some_and(|t| t.size == sized(input.output));
        let fresh = self.written.is_none() || !read_size_ok || (made_history && self.histories[read].is_none());
        self.written = Some(write);
        let reset = fresh || input.row.resets();
        self.frames = if reset { 0 } else { self.frames.saturating_add(1) };
        let mut row = if reset { input.row.reset() } else { input.row };
        row.counts[0] = self.frames;
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let prev_convert = if reset { &self.neutral_convert } else { self.converts[read].as_ref().map_or(&self.neutral_convert, |t| &t.view) };
        let prev_history = if reset { &self.neutral_history } else { self.histories[read].as_ref().map_or(&self.neutral_history, |t| &t.view) };
        let convert_view = &self.converts[write].as_ref().expect("made above").view;
        let history_view = self.histories[write].as_ref().expect("made above").view.clone();
        let convert_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("taau convert"),
            layout: &self.convert_layout,
            entries: &[
                texture_entry(0, input.depth),
                texture_entry(1, input.motion.unwrap_or(&self.neutral_motion)),
                texture_entry(2, input.reactive.unwrap_or(&self.neutral_reactive)),
                texture_entry(3, prev_convert),
            ],
        });
        let upscale_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("taau upscale"),
            layout: &self.upscale_layout,
            entries: &[texture_entry(0, input.scene), texture_entry(1, convert_view), texture_entry(2, prev_history)],
        });
        let empty_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("taau none"), entries: &[] });
        let empty = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("taau none"), layout: &empty_layout, entries: &[] });
        let (begin, end) = match &stamps {
            Some(s) => (
                s.begin.map(|index| wgpu::RenderPassTimestampWrites { query_set: s.query_set, beginning_of_pass_write_index: Some(index), end_of_pass_write_index: None }),
                s.end.map(|index| wgpu::RenderPassTimestampWrites { query_set: s.query_set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(index) }),
            ),
            None => (None, None),
        };
        draw(encoder, "taau convert", convert_view, &self.convert, &[&self.params_group, &convert_group], begin);
        draw(encoder, "taau upscale", &history_view, &self.upscale, &[&self.params_group, &empty, &upscale_group], end);
        TaauOutput { view: history_view, reset: row.resets(), slot: write }
    }

    /// The history texture of `slot`.
    pub fn slot_texture(&self, slot: usize) -> Option<&Texture> {
        self.histories.get(slot)?.as_ref().map(|t| &t.texture)
    }

    fn written_texture(&self) -> Option<&Texture> {
        self.slot_texture(self.written?)
    }
}

// ---------------------------------------------------------------------------------------------
// Image-level upscales (the GPU rows of tests/taau.rs and the cost row)

/// One frame of an image-level upscale sequence: every render-size image `render` texels row by
/// row.
#[derive(Clone, Debug)]
pub struct TaauFrameImage {
    /// The jittered HDR scene at render size (pre-exposed radiance; alpha ignored).
    pub scene: Vec<[f32; 4]>,
    /// Device depth.
    pub depth: Vec<f32>,
    /// NDC motion (current − previous, jitter removed); empty: none.
    pub motion: Vec<[f32; 2]>,
    /// Reactive coverage `0..=1`; empty: none.
    pub reactive: Vec<f32>,
    /// The frame's row; its sizes are replaced by the sequence's.
    pub row: GpuTaauParams,
}

fn read_history(gpu: &Gpu, node: &TaauNode, size: (u32, u32)) -> Result<TaaImage, RenderError> {
    let texture = node.written_texture().ok_or_else(|| capture_failed("no upscale was recorded"))?;
    let (width, height) = size;
    let padded = (width * 8).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = buffer(&gpu.device, "taau readback", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taau readback") });
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (y, x)))
        .map(|(y, x)| {
            let at = (y * padded + x * 8) as usize;
            std::array::from_fn(|c| crate::post::tonemap::f16_to_f32(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]])))
        })
        .collect();
    Ok(TaaImage { size, texels })
}

fn sized_row(row: GpuTaauParams, render: (u32, u32), output: (u32, u32)) -> GpuTaauParams {
    let (rw, rh) = (render.0 as f32, render.1 as f32);
    let (ow, oh) = (output.0 as f32, output.1 as f32);
    let [at_rest, fresh] = kernel_bias(render, output);
    GpuTaauParams { render: [rw, rh, 1.0 / rw, 1.0 / rh], output: [ow, oh, 1.0 / ow, 1.0 / oh], kernel: [at_rest, fresh, 0.0, 0.0], ..row }
}

fn frame_inputs(gpu: &Gpu, render: (u32, u32), frame: &TaauFrameImage) -> Result<crate::post::taa::ImageInputs, RenderError> {
    let image = crate::post::taa::TaaFrameImage {
        scene: frame.scene.clone(),
        depth: frame.depth.clone(),
        motion: frame.motion.clone(),
        reactive: frame.reactive.clone(),
        row: GpuTaaParams::default(),
    };
    crate::post::taa::image_inputs(gpu, render, &image)
}

/// Upscale `frames` (render size) one after another on one history at `output` size, reading each
/// upscaled frame back. The first frame always starts history over.
pub fn taau_resolve_images(gpu: &Gpu, render: (u32, u32), output: (u32, u32), frames: &[TaauFrameImage]) -> Result<Vec<TaaImage>, RenderError> {
    crate::capture::check_capture_size(render.0, render.1)?;
    crate::capture::check_capture_size(output.0, output.1)?;
    let device = &gpu.device;
    let mut node = TaauNode::with_usage(device, &gpu.queue, TextureUsages::COPY_SRC)?;
    let mut images = Vec::with_capacity(frames.len());
    for frame in frames {
        let inputs = frame_inputs(gpu, render, frame)?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taau image") });
        let input = TaauInput {
            scene: &inputs.scene,
            depth: &inputs.depth,
            motion: inputs.motion.as_ref(),
            reactive: inputs.reactive.as_ref(),
            render,
            output,
            row: sized_row(frame.row, render, output),
        };
        node.encode(device, &gpu.queue, &mut encoder, input);
        gpu.queue.submit([encoder.finish()]);
        images.push(read_history(gpu, &node, output)?);
    }
    Ok(images)
}

/// The GPU milliseconds of one upscale (both passes) from `render` into `output`, one per sample
/// of `frames`, from timestamps around [`COST_RESOLVES_PER_SAMPLE`] upscales; None without
/// `TIMESTAMP_QUERY`. The cost row (plan §5, B.8: <= 0.6 ms at 4K).
pub fn taau_gpu_ms(gpu: &Gpu, render: (u32, u32), output: (u32, u32), frames: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let texels = (render.0 * render.1) as usize;
    // A textured scene (not flat), so the taps' caches see real data.
    let scene = (0..texels).map(|i| {
        let v = ((i * 2_654_435_761) % 1000) as f32 / 1000.0;
        [v, 0.5 * v + 0.2, 0.3, 1.0]
    });
    let mut config = crate::settings::RenderSettings::off().frame_config(output, 1.0, 1, false);
    config.render_size = render;
    let image = TaauFrameImage {
        scene: scene.collect(),
        depth: vec![0.5; texels],
        motion: vec![[0.001, 0.0]; texels],
        reactive: vec![0.0; texels],
        row: GpuTaauParams::new(&TaaQuality::DEFAULT, &config, [0.0; 2], 1.0),
    };
    let inputs = frame_inputs(gpu, render, &image)?;
    let mut node = TaauNode::new(device, &gpu.queue)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("taau cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "taau cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(frames as usize);
    for _ in 0..frames {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taau cost") });
        for k in 0..COST_RESOLVES_PER_SAMPLE {
            let stamps = TaauStamps { query_set: &query_set, begin: (k == 0).then_some(0), end: (k + 1 == COST_RESOLVES_PER_SAMPLE).then_some(1) };
            let input =
                TaauInput { scene: &inputs.scene, depth: &inputs.depth, motion: inputs.motion.as_ref(), reactive: inputs.reactive.as_ref(), render, output, row: image.row };
            node.encode_timed(device, &gpu.queue, &mut encoder, input, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taau cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_RESOLVES_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kernel_bias_follows_the_ratio_up_to_its_cap() {
        assert_eq!(kernel_bias((100, 100), (100, 100)), [KERNEL_SHARPNESS, 1.0]);
        let [at_rest, fresh] = kernel_bias((1280, 720), (1920, 1080));
        assert!((at_rest - KERNEL_BIAS_MAX).abs() < 1e-6 && (fresh - 1.0).abs() < 1e-6, "{at_rest} {fresh}");
        assert_eq!(kernel_bias((100, 100), (400, 400))[0], KERNEL_BIAS_MAX);
    }

    #[test]
    fn a_frame_at_scale_one_keeps_taa_and_an_upscaled_one_takes_the_phases() {
        use crate::settings::JitterCycle;
        let (render, output) = ((1280, 720), (1920, 1080));
        assert_eq!(frame_jitter(3, output, output, JitterCycle::Sixteen), crate::jitter::offset_px(3, JitterCycle::Sixteen));
        assert_eq!(frame_jitter(17, render, output, JitterCycle::Eight), offset_px(17, 18));
        assert_ne!(frame_jitter(17, render, output, JitterCycle::Eight), crate::jitter::offset_px(17, JitterCycle::Eight));
        assert_eq!((settle_frames(output, output, JitterCycle::Sixteen), settle_frames(render, output, JitterCycle::Eight)), (16, 18));
        let taa = TaaQuality::DEFAULT;
        assert_eq!(frame_texture_lod_bias(&taa, false, 0.5), taa.texture_lod_bias(0.5));
        assert_eq!(frame_texture_lod_bias(&taa, true, 0.5), texture_lod_bias(0.5));
    }

    #[test]
    fn the_ledger_counts_the_history_at_output_size_and_the_convert_at_render_size() {
        assert_eq!(bytes((2, 1), (4, 2)), 2 * 8 * (8 + 2));
    }
}
