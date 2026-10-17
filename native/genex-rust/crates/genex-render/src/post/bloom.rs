//! Bloom (plan §2.2 node 19; RQ4). RQ4.0 lands the contract: the chain's format and sizes, the GPU
//! row ([`GpuBloomParams`], `BloomParams` in shaders/post/bloom_*.wgsl), the composite's CPU twin
//! and the neutral black input the tonemap binds until the chain runs ([`TONEMAP_BLOOM_BINDING`]);
//! RQ4.2 records the chain ([`BloomNode`]) and composites it in the tonemap
//! ([`crate::post::tonemap`]: the tonemap node runs the chain itself before its pass once
//! `TonemapNode::set_bloom` hands it [`BloomSettings`]).
//!
//! Bloom is **threshold-free and energy-conserving** by default (plan G20): the pre-exposed HDR
//! scene is downsampled into a mip chain (a Karis-weighted first step so one blinding texel does
//! not flicker), tent-upsampled back, each mip weighed by the look's spread
//! ([`crate::settings::Look::bloom_radius`], [`mip_weights`]), and the tonemap blends
//! `mix(scene, bloom, intensity)` ([`composite`]), so a frame's energy is kept and nothing is added. A look's optional threshold ([`crate::settings::Look::bloom_threshold`])
//! is a stylistic soft knee ([`soft_threshold`]) on the first downsample; the chain then holds only
//! the over-threshold part, so the composite trades that part for its glow and keeps the rest of the
//! scene (`scene + (bloom - soft_threshold(scene)) * intensity`, [`composite`]): a lerp would darken
//! everything below the threshold. Quality sets only the chain: on or off and its resolution
//! ([`crate::settings::BloomQuality::resolution`]).
//!
//! The chain is sized from the **output**, never the render size (renderer pass 2, P5): its top is
//! `min(output height / 2, resolution)` rows with the output's aspect, and it holds [`CHAIN_MIPS`]
//! levels on every preset (Bevy sizes its chain from a fixed vertical resolution,
//! `DEFAULT_MAX_MIP_DIMENSION` 512; Filament's `BloomOptions::resolution` is 384). A DRS step changes
//! only the scene the first downsample reads, so the halo keeps its width on screen while the
//! render scale moves, and every preset that draws bloom draws the same halo.
//!
//! The chain: mip 0 is the scene downsampled (Jimenez's 13-tap filter from the 1x scene, its taps
//! a source texel apart, or half a chain texel when the scene is less than twice the chain's size,
//! so its footprint on screen does not follow the render scale; every tap Karis-weighted by
//! 1 / (1 + luma). From the multisampled scene, when the tonemap resolves in its own pass, a
//! Karis-weighted area filter over the chain texel's footprint), each next mip the 13-tap filter of
//! the last. The upsample walks back up: the one-texel tent of mip i+1 is blended onto mip i by a
//! constant ([`blend_factors`]: `mip_i = (1 - f_i) mip_i + f_i tent(mip_i+1)`), so mip 0 ends
//! holding each mip's blur weighed by [`mip_weights`], weights that sum to 1: the bloom image has
//! the scene's mean radiance and the lerp keeps the frame's energy (P6: spread is these weights,
//! never a wider tent, whose sparse taps drew a lattice of copies around a small light). Karis's
//! weight removes energy from lone texels far above their neighbourhood on purpose (a firefly must
//! not flicker the glow); smooth emitters keep it. Every pass is a fragment pass over
//! `rgba16float`, so tile GPUs keep each mip in tile memory.
//!
//! Captures: the chain has no history; a captured frame's bloom is that frame's scene alone.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, PipelineLayout, Queue, RenderPipeline, Sampler, ShaderModule, Texture, TextureFormat, TextureUsages, TextureView};

use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{BloomQuality, Look};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the `bloom` switch changes the picture: the renderer hands each HDR frame's
/// [`BloomSettings`] to the tonemap node, which records the chain before its pass (RQ4.6). Graph
/// node 19 is the chain's row; the tonemap (node 21) records it.
pub const LANDED: bool = true;
/// The chain's format: linear HDR, filterable and renderable in core (written by fragment passes).
pub const CHAIN_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The chain's usages.
pub const CHAIN_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The chain's pool label.
pub const CHAIN_LABEL: &str = "bloom";
/// The chain's mip levels at most (P5): at 1080p and above a 540-row top holds seven, down to a
/// level of 8 rows, as ultra's chain always did. The count follows only the chain's top
/// ([`CHAIN_COARSEST_ROWS`]): every preset and DRS step draws the same chain, so the halo's size on
/// screen and each mip's share do not change with them.
pub const CHAIN_MIPS: u8 = 7;
/// The chain ends at its first level with at least this many rows: its widest blur keeps about
/// the same size on screen on a smaller output or a lower chain resolution (a phone's, the degrade
/// rung's) instead of washing a small frame with its mean (Bevy ends its chain at about 4 px).
pub const CHAIN_COARSEST_ROWS: u32 = 8;
/// The chain's top height cap, in texels, on desktop classes (`min(output height / 2, this)`):
/// at 1080p the chain starts at half the output, as ultra's always did.
pub const CHAIN_RESOLUTION: u16 = 540;
/// The binding of the bloom chain's top in the tonemap's bind groups (both the 1x and the
/// multisampled source's): a neutral 1x1 black texture until the chain runs, so the composite
/// adds nothing.
pub const TONEMAP_BLOOM_BINDING: u32 = 4;
/// The soft knee's width as a fraction of the threshold ([`soft_threshold`]; both shaders read it
/// from their uniform: `GpuBloomParams::shape.w`, `GpuTonemapParams::bloom.y`).
pub const THRESHOLD_KNEE: f32 = 0.5;
/// The binding of the tonemap's filtering sampler (the 1x source reads through it; the
/// multisampled source's layout carries it too, for the bloom chain).
pub const TONEMAP_SAMPLER_BINDING: u32 = 1;

/// One bloom step's uniform (`BloomParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuBloomParams {
    /// xy: the source's size in texels; zw: the filter's tap spacing in uv (one source texel; half
    /// a chain texel on the first downsample, [`first_tap_step`]). The shaders read the source
    /// texels per chain texel from them (`2 * zw * xy`).
    pub source: [f32; 4],
    /// x: intensity; y: threshold (0: none); z: reserved; w: the threshold's knee
    /// ([`THRESHOLD_KNEE`]).
    pub shape: [f32; 4],
    /// x: the mip written; y: mips in the chain; z: 1 on the first downsample (Karis, threshold);
    /// w: reserved.
    pub mip: [u32; 4],
}

impl GpuBloomParams {
    /// The row of the step reading a `source`-sized image and writing a `target`-sized mip `mip`
    /// of a `mips`-deep chain, with `look`'s intensity and threshold.
    pub fn new(look: &Look, source: (u32, u32), target: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        GpuBloomParams::from_shape((look.bloom_intensity, look.bloom_threshold), source, target, mip, mips)
    }

    fn from_shape((intensity, threshold): (f32, f32), source: (u32, u32), target: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        let (w, h) = (source.0.max(1) as f32, source.1.max(1) as f32);
        let first = mip == 0;
        let step = if first { first_tap_step(target) } else { [1.0 / w, 1.0 / h] };
        GpuBloomParams { source: [w, h, step[0], step[1]], shape: [intensity, threshold, 0.0, THRESHOLD_KNEE], mip: [mip, mips, u32::from(first), 0] }
    }
}

impl GpuBloomParams {
    /// The row of the pre-level reading a `source`-sized scene into a `target`-sized level
    /// (`source.zw` is 1 / the target's size: the shader reads the footprint from it).
    fn pre_level(source: (u32, u32), target: (u32, u32), mips: u32) -> GpuBloomParams {
        let (w, h) = (source.0.max(1) as f32, source.1.max(1) as f32);
        let (tw, th) = (target.0.max(1) as f32, target.1.max(1) as f32);
        GpuBloomParams { source: [w, h, 1.0 / tw, 1.0 / th], shape: [0.0, 0.0, 0.0, THRESHOLD_KNEE], mip: [0, mips, 1, 0] }
    }
}

/// The first downsample's tap spacing in uv into a `target`-sized chain top: half a chain texel,
/// a source texel of a scene twice the chain's size, so its footprint on screen is the same at
/// every render scale. A scene more than twice the chain's size is first halved into pre-levels
/// at twice the chain top's size first ([`pre_level_sizes`]), so no scene texel falls between taps.
pub fn first_tap_step(target: (u32, u32)) -> [f32; 2] {
    [0.5 / target.0.max(1) as f32, 0.5 / target.1.max(1) as f32]
}

/// Pre-levels at most: one.
pub const PRE_LEVELS_MAX: usize = 1;

/// The pre-level a `render`-sized scene is filtered into before an `output`-sized frame's chain
/// (none when bloom is off or the scene is at most twice the chain top's height): one level at
/// twice the top's size, each texel the Karis-weighted mean of the scene texels under it
/// (bloom_down.wgsl `fs_bloom_prefilter`; 1440p and 4K at scale 1, a phone's tall scene over its
/// small chain). The chain's first downsample then never reads a scene more than twice its size,
/// so no texel falls between its taps; the pre-level is the size a 1080p scene's chain reads.
pub fn pre_level_sizes(render: (u32, u32), output: (u32, u32), quality: &BloomQuality) -> Vec<(u32, u32)> {
    let Some(&top) = chain_sizes(output, quality).first() else { return Vec::new() };
    if render.1 <= 2 * top.1 {
        return Vec::new();
    }
    vec![(2 * top.0, 2 * top.1)]
}

/// The pre-levels' bytes (`rgba16float`): beside [`chain_bytes`], what a `render`-sized scene in
/// an `output`-sized frame holds for bloom.
pub fn pre_level_bytes(render: (u32, u32), output: (u32, u32), quality: &BloomQuality) -> u64 {
    pre_level_sizes(render, output, quality).iter().map(|(w, h)| u64::from(*w) * u64::from(*h) * 8).sum()
}

/// One frame's bloom: the look's intensity, threshold and spread with the quality's chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BloomSettings {
    /// The composite's lerp weight (the look's `bloom_intensity`, 0..1).
    pub intensity: f32,
    /// The stylistic soft-knee threshold in pre-exposed radiance (0: none, energy-conserving).
    pub threshold: f32,
    /// The spread: each wider mip's weight against the one below it ([`mip_weights`]).
    pub radius: f32,
    /// The chain: on or off and its resolution.
    pub quality: BloomQuality,
}

impl BloomSettings {
    /// The settings a frame of `look` under `quality` draws, or None when bloom is off, has no
    /// resolution or the look's intensity is 0 (the tonemap then binds the neutral black input).
    pub fn new(look: &Look, quality: &BloomQuality) -> Option<BloomSettings> {
        let on = quality.enabled && quality.resolution > 0 && look.bloom_intensity > 0.0;
        on.then_some(BloomSettings { intensity: look.bloom_intensity, threshold: look.bloom_threshold, radius: look.bloom_radius, quality: *quality })
    }

    fn step(&self, source: (u32, u32), target: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        GpuBloomParams::from_shape((self.intensity, self.threshold), source, target, mip, mips)
    }
}

/// The chain's top for an `output`-sized frame under `quality`: `min(output height / 2,
/// resolution)` rows (at least one) with the output's aspect.
fn chain_top(output: (u32, u32), quality: &BloomQuality) -> (u32, u32) {
    let height = (output.1 / 2).min(u32::from(quality.resolution)).max(1);
    let width = (u64::from(output.0) * u64::from(height) + u64::from(output.1.max(1)) / 2) / u64::from(output.1.max(1));
    (u32::try_from(width).unwrap_or(u32::MAX).max(1), height)
}

/// The chain's mip sizes for an `output`-sized frame under `quality` (empty when bloom is off):
/// mip 0 at [`chain_top`], each next one half the last, down to the first level of
/// [`CHAIN_COARSEST_ROWS`] rows or more and at most [`CHAIN_MIPS`] (a small output keeps its top
/// alone). The render size never enters: a DRS step keeps the chain.
pub fn chain_sizes(output: (u32, u32), quality: &BloomQuality) -> Vec<(u32, u32)> {
    if !quality.enabled || quality.resolution == 0 {
        return Vec::new();
    }
    let top = chain_top(output, quality);
    let levels = (1..u32::from(CHAIN_MIPS)).take_while(|mip| top.1 >> mip >= CHAIN_COARSEST_ROWS).count() as u32 + 1;
    (0..levels).map(|mip| ((top.0 >> mip).max(1), (top.1 >> mip).max(1))).collect()
}

/// The chain's target for an `output`-sized frame (None when bloom is off).
pub fn chain_target(output: (u32, u32), quality: &BloomQuality) -> Option<TargetDesc> {
    let sizes = chain_sizes(output, quality);
    let top = *sizes.first()?;
    Some(TargetDesc { label: CHAIN_LABEL, format: CHAIN_FORMAT, usage: CHAIN_USAGE, samples: 1, size: top, mips: sizes.len() as u32, srgb_view: false })
}

/// The chain's bytes for an `output`-sized frame (every mip, `rgba16float`).
pub fn chain_bytes(output: (u32, u32), quality: &BloomQuality) -> u64 {
    chain_sizes(output, quality).iter().map(|(w, h)| u64::from(*w) * u64::from(*h) * 8).sum()
}

/// The power of the spread each wider mip's weight takes against the one below it: the weights
/// rise by `spread ^ SPREAD_EXPONENT` an octave. Chosen so a spread keeps about the halo the
/// pass-1 tent drew at that radius, without its lattice: a soft lamp's half-energy radius grows
/// 1.19x at 1.4 (the tent 1.14x), 1.45x at 2 (1.39x) and 2.08x at 4 (2.13x).
const SPREAD_EXPONENT: f32 = 0.25;

/// Each mip's share of the bloom image under the look's `spread` (P6), from the chain's top: a
/// geometric series rising by `spread ^ SPREAD_EXPONENT` an octave, normalised to sum to 1, so the
/// spread moves the glow's falloff and never its energy; spread 1 weighs every mip alike. Bevy
/// expresses spread the same way, as per-mip blend factors (`compute_blend_factor`); the series is
/// ours.
pub fn mip_weights(spread: f32, mips: usize) -> Vec<f32> {
    let ratio = libm::powf(spread.max(f32::MIN_POSITIVE), SPREAD_EXPONENT);
    let raw: Vec<f32> = std::iter::successors(Some(1.0f32), |weight| Some(weight * ratio)).take(mips).collect();
    let total: f32 = raw.iter().sum();
    raw.iter().map(|weight| weight / total).collect()
}

/// The blend constant of each upsample, from the one into mip 0 to the one into mip `n - 2`
/// (`mip_i = (1 - f_i) mip_i + f_i tent(mip_i+1)`), that leaves mip 0 holding every mip's blur
/// weighed by `weights`: `f_i` is the share of the mips below `i` in what mips `i` and below hold.
pub fn blend_factors(weights: &[f32]) -> Vec<f32> {
    let n = weights.len();
    (0..n.saturating_sub(1))
        .map(|mip| {
            let below: f32 = weights[mip + 1..].iter().sum();
            below / (below + weights[mip]).max(f32::MIN_POSITIVE)
        })
        .collect()
}

/// The part of `c` (pre-exposed radiance) that blooms under a look's `threshold`: a quadratic soft
/// knee [`THRESHOLD_KNEE`] x `threshold` wide, scaling `c` by its brightest channel's excess; all of
/// it when `threshold` is 0. The CPU twin of `gx_bloom_threshold` (bloom_down.wgsl) and
/// `gx_tm_bloom_part` (tonemap.wgsl).
pub fn soft_threshold(c: [f32; 3], threshold: f32) -> [f32; 3] {
    if threshold <= 0.0 {
        return c;
    }
    let brightness = c[0].max(c[1]).max(c[2]);
    let knee = threshold * THRESHOLD_KNEE;
    let soft = (brightness - threshold + knee).clamp(0.0, 2.0 * knee);
    let contribution = (soft * soft / (4.0 * knee + 1e-5)).max(brightness - threshold);
    let scale = contribution / brightness.max(1e-5);
    c.map(|channel| channel * scale)
}

/// The composite's CPU twin: threshold-free, the energy-conserving blend of the scene and the
/// chain's top; under a stylistic `threshold`, the scene's over-threshold part traded for the glow
/// (`scene + (bloom - soft_threshold(scene)) * intensity`), so nothing below it darkens.
pub fn composite(scene: [f32; 3], bloom: [f32; 3], intensity: f32, threshold: f32) -> [f32; 3] {
    let t = intensity.clamp(0.0, 1.0);
    let part = soft_threshold(scene, threshold);
    std::array::from_fn(|c| scene[c] + (bloom[c] - part[c]) * t)
}

/// The scene the chain starts from: the 1x HDR scene, or its MSAA samples when the tonemap
/// resolves them in its own pass (desktop classes).
#[derive(Clone, Copy)]
pub(crate) enum BloomSource<'a> {
    /// The 1x scene (filterable).
    Scene(&'a TextureView),
    /// The multisampled scene.
    Msaa(&'a TextureView),
}

/// One chain's input: the scene, its (render) size, the output's size, the frame's bloom and the
/// input's identity (the target pool's generation).
#[derive(Clone, Copy)]
pub(crate) struct BloomInput<'a> {
    /// The scene the chain starts from.
    pub source: BloomSource<'a>,
    /// Its size.
    pub render: (u32, u32),
    /// The output's size: the chain is sized from it ([`chain_sizes`]).
    pub output: (u32, u32),
    /// The frame's bloom.
    pub settings: &'a BloomSettings,
    /// The input's identity: the first downsample's bind group is rebuilt when it changes.
    pub generation: u64,
}

/// A bloom image read back: mip 0 of the chain at the scene's mean radiance ([`bloom_chain_image`]).
#[derive(Clone, Debug, PartialEq)]
pub struct BloomImage {
    /// Its size (the chain's top: half the scene's on half-resolution chains).
    pub size: (u32, u32),
    /// Its texels, row by row, in pre-exposed radiance.
    pub texels: Vec<[f32; 4]>,
}

/// What the tonemap composites: the chain's top and how.
#[derive(Clone, Debug)]
pub(crate) struct BloomOutput {
    /// Mip 0 of the chain (every mip's blur, weighed by [`mip_weights`]).
    pub view: TextureView,
    /// The lerp weight.
    pub intensity: f32,
    /// The chain's scale in the composite: 1, the weights already sum to 1 (the tonemap's
    /// `shape.w`).
    pub scale: f32,
    /// The look's stylistic threshold (0: none, the lerp).
    pub threshold: f32,
    /// The chain's identity (changes when it is reallocated).
    pub chain: u64,
    /// Render passes the chain opened (its downsamples and upsamples).
    pub passes: u32,
}

/// The chain's texture and one view per mip, and the pre-levels before it.
struct Chain {
    texture: Texture,
    views: Vec<TextureView>,
    sizes: Vec<(u32, u32)>,
    /// The pre-levels' views ([`pre_level_sizes`]), each its own texture.
    pre: Vec<TextureView>,
    pre_sizes: Vec<(u32, u32)>,
    id: u64,
}

/// Chains one sample of [`bloom_gpu_ms`] records back to back. A lone chain after an idle wait
/// pays the GPU's wake-up (measured on the M4 Max: 0.55 ms at 8 a sample against 0.38 ms at 64);
/// in a frame the chain follows the scene's passes on a busy GPU, which 64 approximates.
pub const COST_CHAINS_PER_SAMPLE: u32 = 64;
/// The uniform slots: a pre-level each, a downsample per mip and an upsample per mip but the last.
const PARAM_SLOTS: u64 = PRE_LEVELS_MAX as u64 + CHAIN_MIPS as u64 * 2 - 1;
/// The bind-group binding of each piece (bloom_down.wgsl, bloom_up.wgsl).
const SOURCE_BINDING: u32 = 0;
const SAMPLER_BINDING: u32 = 1;
const PARAMS_BINDING: u32 = 2;
const MSAA_BINDING: u32 = 3;

/// The bloom node (graph node 19): the chain's pipelines, its texture and the bind groups of the
/// current input. Made once by the tonemap node when a frame first asks for bloom.
pub(crate) struct BloomNode {
    down_module: ShaderModule,
    layout: BindGroupLayout,
    msaa_layout: BindGroupLayout,
    msaa_pipeline_layout: PipelineLayout,
    down: Compiled<RenderPipeline>,
    msaa_down: Option<Compiled<RenderPipeline>>,
    /// The pre-level pipelines from the 1x scene (and a pre-level) and from the samples, made when
    /// a frame first needs them.
    prefilter: Option<Compiled<RenderPipeline>>,
    msaa_prefilter: Option<Compiled<RenderPipeline>>,
    chain_layout: PipelineLayout,
    up: Compiled<RenderPipeline>,
    sampler: Sampler,
    params: Buffer,
    stride: u64,
    chain: Option<Chain>,
    next_id: u64,
    extra_usage: TextureUsages,
    groups: Option<((u64, bool, u64), Vec<BindGroup>)>,
}

fn fragment_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn texture_entry(binding: u32, filterable: bool, multisampled: bool) -> wgpu::BindGroupLayoutEntry {
    let sample_type = wgpu::TextureSampleType::Float { filterable };
    fragment_entry(binding, wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled })
}

fn params_entry() -> wgpu::BindGroupLayoutEntry {
    let size = wgpu::BufferSize::new(size_of::<GpuBloomParams>() as u64);
    fragment_entry(PARAMS_BINDING, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: size })
}

/// The upsample's blend: the tent of the smaller mip mixed into this one by the pass's blend
/// constant ([`blend_factors`]), `(1 - f) mip + f tent`.
const WEIGHED: wgpu::BlendComponent = wgpu::BlendComponent {
    src_factor: wgpu::BlendFactor::Constant,
    dst_factor: wgpu::BlendFactor::OneMinusConstant,
    operation: wgpu::BlendOperation::Add,
};
const UPSAMPLE_BLEND: wgpu::BlendState = wgpu::BlendState { color: WEIGHED, alpha: WEIGHED };

fn chain_pipeline(device: &Device, layout: &PipelineLayout, module: &ShaderModule, fragment: &str, blend: Option<wgpu::BlendState>) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(fragment),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some("vs_bloom"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fragment),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: CHAIN_FORMAT, blend, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl BloomNode {
    pub(crate) fn new(device: &Device) -> Result<BloomNode, RenderError> {
        BloomNode::with_usage(device, TextureUsages::empty())
    }

    /// A node whose chain also carries `extra_usage` (a readback's `COPY_SRC`).
    fn with_usage(device: &Device, extra_usage: TextureUsages) -> Result<BloomNode, RenderError> {
        let down_module = crate::shaders::module(device, "bloom down", crate::shaders::BLOOM_DOWN)?;
        let up_module = crate::shaders::module(device, "bloom up", crate::shaders::BLOOM_UP)?;
        let sampler_entry = fragment_entry(SAMPLER_BINDING, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering));
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bloom"),
            entries: &[texture_entry(SOURCE_BINDING, true, false), sampler_entry, params_entry()],
        });
        let msaa_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bloom msaa"),
            entries: &[params_entry(), texture_entry(MSAA_BINDING, false, true)],
        });
        let chain_layout = pipeline_layout(device, "bloom", &[&layout]);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("bloom"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let stride = u64::from(device.limits().min_uniform_buffer_offset_alignment).max(size_of::<GpuBloomParams>() as u64);
        let params = buffer(device, "bloom params", stride * PARAM_SLOTS, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(BloomNode {
            down: chain_pipeline(device, &chain_layout, &down_module, "fs_bloom_down", None),
            up: chain_pipeline(device, &chain_layout, &up_module, "fs_bloom_up", Some(UPSAMPLE_BLEND)),
            msaa_pipeline_layout: pipeline_layout(device, "bloom msaa", &[&msaa_layout]),
            msaa_down: None,
            prefilter: None,
            msaa_prefilter: None,
            chain_layout,
            down_module,
            layout,
            msaa_layout,
            sampler,
            params,
            stride,
            chain: None,
            next_id: 1,
            extra_usage,
            groups: None,
        })
    }

    /// The chain for `sizes` with its `pre`-levels, reallocated when either changes.
    fn chain(&mut self, device: &Device, sizes: &[(u32, u32)], pre: &[(u32, u32)]) -> &Chain {
        if self.chain.as_ref().is_some_and(|chain| chain.sizes == sizes && chain.pre_sizes == pre) {
            return self.chain.as_ref().expect("held");
        }
        let texture = |label, (width, height): (u32, u32), mips: usize| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: mips as u32,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: CHAIN_FORMAT,
                usage: CHAIN_USAGE | self.extra_usage,
                view_formats: &[],
            })
        };
        let chain = texture(CHAIN_LABEL, sizes[0], sizes.len());
        let views = (0..sizes.len() as u32)
            .map(|mip| chain.create_view(&wgpu::TextureViewDescriptor { base_mip_level: mip, mip_level_count: Some(1), ..Default::default() }))
            .collect();
        let pre_views = pre.iter().map(|size| texture("bloom pre-level", *size, 1).create_view(&Default::default())).collect();
        self.groups = None;
        let id = self.next_id;
        self.next_id += 1;
        self.chain.insert(Chain { texture: chain, views, sizes: sizes.to_vec(), pre: pre_views, pre_sizes: pre.to_vec(), id })
    }

    fn slot(&self, index: usize) -> wgpu::BindingResource<'_> {
        let size = wgpu::BufferSize::new(size_of::<GpuBloomParams>() as u64);
        wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.params, offset: self.stride * index as u64, size })
    }

    /// The bind groups of every step, in the order they run: the pre-levels (the first reads
    /// `source`), the downsamples (mip 0 reads the last pre-level, or `source`), then the upsamples
    /// from the smallest mip up.
    fn bind_groups(&mut self, device: &Device, source: BloomSource<'_>, generation: u64) -> Vec<BindGroup> {
        let chain = self.chain.as_ref().expect("the chain is made first");
        let key = (generation, matches!(source, BloomSource::Msaa(_)), chain.id);
        if let Some((held, groups)) = &self.groups
            && *held == key
        {
            return groups.clone();
        }
        let (n, pre) = (chain.views.len(), chain.pre.len());
        let sampled = |index: usize, view: &TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("bloom"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: SOURCE_BINDING, resource: wgpu::BindingResource::TextureView(view) },
                    wgpu::BindGroupEntry { binding: SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    wgpu::BindGroupEntry { binding: PARAMS_BINDING, resource: self.slot(index) },
                ],
            })
        };
        let first = match source {
            BloomSource::Scene(view) => sampled(0, view),
            BloomSource::Msaa(view) => device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("bloom msaa"),
                layout: &self.msaa_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: PARAMS_BINDING, resource: self.slot(0) },
                    wgpu::BindGroupEntry { binding: MSAA_BINDING, resource: wgpu::BindingResource::TextureView(view) },
                ],
            }),
        };
        // Pass p reads what pass p - 1 wrote: pre-level k, then chain mip m at p = pre + m.
        let mut groups = vec![first];
        groups.extend((1..pre).map(|k| sampled(k, &chain.pre[k - 1])));
        if let Some(last) = chain.pre.last() {
            groups.push(sampled(pre, last));
        }
        groups.extend((1..n).map(|mip| sampled(pre + mip, &chain.views[mip - 1])));
        // Upsample k (k = 0 first) reads mip n-1-k and writes mip n-2-k.
        groups.extend((0..n - 1).map(|k| sampled(pre + n + k, &chain.views[n - 1 - k])));
        self.groups = Some((key, groups.clone()));
        groups
    }

    /// Record the chain for `input`: the downsamples, then the additive upsamples. None when the
    /// settings draw no chain.
    pub(crate) fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: BloomInput<'_>) -> Option<BloomOutput> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// [`BloomNode::encode`] with `timestamps` (the query set, and whether this chain stamps the
    /// first pass's beginning and the last pass's end): a cost row.
    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: BloomInput<'_>,
        timestamps: Option<(&wgpu::QuerySet, bool, bool)>,
    ) -> Option<BloomOutput> {
        let BloomInput { source, render, output, settings, generation } = input;
        let sizes = chain_sizes(output, &settings.quality);
        if sizes.is_empty() {
            return None;
        }
        let pre_sizes = pre_level_sizes(render, output, &settings.quality);
        self.ensure_pipelines(device, source, !pre_sizes.is_empty());
        let (n, pre) = (sizes.len(), pre_sizes.len());
        self.write_params(queue, render, &pre_sizes, &sizes, settings);
        self.chain(device, &sizes, &pre_sizes);
        let groups = self.bind_groups(device, source, generation);
        let chain = self.chain.as_ref().expect("made above");
        let last = pre + 2 * n - 2;
        // The first pass stamps its beginning, the last its end (one pass when the chain is one mip),
        // when the caller asks for either.
        let stamp = |step: usize| {
            let (query_set, first, final_chain) = timestamps?;
            let (begin, end) = ((first && step == 0).then_some(0), (final_chain && step == last).then_some(1));
            (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites {
                query_set,
                beginning_of_pass_write_index: begin,
                end_of_pass_write_index: end,
            })
        };
        let clear = wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT);
        for (k, group) in groups.iter().enumerate().take(pre) {
            let pipeline = match (k, source) {
                (0, BloomSource::Msaa(_)) => self.msaa_prefilter.as_ref(),
                _ => self.prefilter.as_ref(),
            };
            // A pre-level covers every texel: nothing to load.
            chain_pass(encoder, &chain.pre[k], clear, stamp(k), (pipeline.expect("made above"), None), group);
        }
        for (mip, group) in groups.iter().skip(pre).enumerate().take(n) {
            let pipeline = match (mip, source) {
                (0, BloomSource::Msaa(_)) if pre == 0 => self.msaa_down.as_ref().expect("made above"),
                _ => &self.down,
            };
            // A downsample covers every texel of its mip: nothing to load.
            chain_pass(encoder, &chain.views[mip], clear, stamp(pre + mip), (pipeline, None), group);
        }
        let factors = blend_factors(&mip_weights(settings.radius, n));
        for (k, group) in groups.iter().skip(pre + n).enumerate() {
            let written = n - 2 - k;
            let blend = f64::from(factors[written]);
            chain_pass(encoder, &chain.views[written], wgpu::LoadOp::Load, stamp(pre + n + k), (&self.up, Some(blend)), group);
        }
        let passes = (pre + 2 * n - 1) as u32;
        Some(BloomOutput { view: chain.views[0].clone(), intensity: settings.intensity, scale: 1.0, threshold: settings.threshold, chain: chain.id, passes })
    }

    /// The pipelines this frame's passes need: the multisampled first downsample, and the
    /// pre-level pipelines when the scene takes `pre`-levels (made once, on the frame that first
    /// asks).
    fn ensure_pipelines(&mut self, device: &Device, source: BloomSource<'_>, pre: bool) {
        let msaa = matches!(source, BloomSource::Msaa(_));
        if msaa && self.msaa_down.is_none() {
            self.msaa_down = Some(chain_pipeline(device, &self.msaa_pipeline_layout, &self.down_module, "fs_bloom_down_msaa", None));
        }
        if pre && self.prefilter.is_none() {
            self.prefilter = Some(chain_pipeline(device, &self.chain_layout, &self.down_module, "fs_bloom_prefilter", None));
        }
        if pre && msaa && self.msaa_prefilter.is_none() {
            self.msaa_prefilter = Some(chain_pipeline(device, &self.msaa_pipeline_layout, &self.down_module, "fs_bloom_prefilter_msaa", None));
        }
    }

    /// Every pass's row, in the order they run (`pre`-levels, then the chain's `sizes`).
    fn write_params(&self, queue: &Queue, render: (u32, u32), pre: &[(u32, u32)], sizes: &[(u32, u32)], settings: &BloomSettings) {
        let (n, p) = (sizes.len(), pre.len());
        let mut bytes = vec![0u8; (self.stride * PARAM_SLOTS) as usize];
        let mut put = |slot: usize, row: GpuBloomParams| {
            let at = slot * self.stride as usize;
            bytes[at..at + size_of::<GpuBloomParams>()].copy_from_slice(bytemuck::bytes_of(&row));
        };
        for (k, target) in pre.iter().enumerate() {
            let source = if k == 0 { render } else { pre[k - 1] };
            put(k, GpuBloomParams::pre_level(source, *target, n as u32));
        }
        let scene = pre.last().copied().unwrap_or(render);
        for mip in 0..n {
            let source = if mip == 0 { scene } else { sizes[mip - 1] };
            put(p + mip, settings.step(source, sizes[mip], mip as u32, n as u32));
        }
        for k in 0..n - 1 {
            let read = n - 1 - k;
            put(p + n + k, settings.step(sizes[read], sizes[read - 1], (read - 1) as u32, n as u32));
        }
        queue.write_buffer(&self.params, 0, &bytes);
    }
}

/// One pass of the chain: `pipeline` over `target`, with its blend constant when it blends
/// (an upsample).
fn chain_pass(
    encoder: &mut wgpu::CommandEncoder,
    target: &TextureView,
    load: wgpu::LoadOp<wgpu::Color>,
    timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
    (pipeline, blend): (&RenderPipeline, Option<f64>),
    group: &BindGroup,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("bloom"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
        })],
        timestamp_writes,
        ..Default::default()
    });
    pass.set_pipeline(pipeline);
    if let Some(f) = blend {
        pass.set_blend_constant(wgpu::Color { r: f, g: f, b: f, a: f });
    }
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}

/// An `rgba16float` texture of `texels` (row by row) the chain can read.
fn scene_texture(gpu: &Gpu, (width, height): (u32, u32), texels: &[[f32; 4]]) -> Result<Texture, RenderError> {
    crate::capture::check_capture_size(width, height)?;
    if texels.len() != (width * height) as usize {
        return Err(capture_failed(format!("{} texels for a {width}x{height} image", texels.len())));
    }
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("bloom scene"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Rgba16Float,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let halves: Vec<u16> = texels.iter().flat_map(|texel| texel.map(crate::post::tonemap::f32_to_f16)).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(&halves),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 8), rows_per_image: Some(height) },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    Ok(texture)
}

/// The bloom image a `size` scene of pre-exposed radiance (`texels`, row by row) gets under
/// `settings` in an `output`-sized frame (the scene is the render size, smaller under DRS): mip 0
/// of the chain read back at the scene's mean radiance (what the tonemap lerps towards), with its
/// size. The way to check the chain's energy and shape on the GPU.
pub fn bloom_chain_image(gpu: &Gpu, settings: &BloomSettings, size: (u32, u32), output: (u32, u32), texels: &[[f32; 4]]) -> Result<BloomImage, RenderError> {
    let scene = scene_texture(gpu, size, texels)?;
    let input = scene.create_view(&Default::default());
    read_chain(gpu, BloomInput { source: BloomSource::Scene(&input), render: size, output, settings, generation: 0 })
}

/// [`bloom_chain_image`] of a `size` multisampled scene (`samples` per texel) cleared to `color`
/// (pre-exposed radiance): the first downsample the desktop MSAA path takes, where the tonemap
/// resolves the samples in its own pass. A flat field blooms into itself.
pub fn bloom_chain_image_msaa(gpu: &Gpu, settings: &BloomSettings, size: (u32, u32), samples: u32, color: [f64; 4]) -> Result<BloomImage, RenderError> {
    crate::capture::check_capture_size(size.0, size.1)?;
    let scene = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("bloom msaa scene"),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Rgba16Float,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let input = scene.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("bloom msaa clear") });
    let [r, g, b, a] = color;
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("bloom msaa clear"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &input,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }), store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    });
    gpu.queue.submit([encoder.finish()]);
    read_chain(gpu, BloomInput { source: BloomSource::Msaa(&input), render: size, output: size, settings, generation: 0 })
}

/// Record the chain for `input`, then read mip 0 back at the scene's mean radiance.
fn read_chain(gpu: &Gpu, input: BloomInput<'_>) -> Result<BloomImage, RenderError> {
    let device = &gpu.device;
    let mut node = BloomNode::with_usage(device, TextureUsages::COPY_SRC)?;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("bloom image") });
    let output = node.encode(device, &gpu.queue, &mut encoder, input).ok_or_else(|| capture_failed("bloom is off"))?;
    let chain = node.chain.as_ref().expect("encoded");
    let (width, height) = chain.sizes[0];
    let padded = (width * 8).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = buffer(device, "bloom readback", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    encoder.copy_texture_to_buffer(
        chain.texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (y, x)))
        .map(|(y, x)| {
            let at = (y * padded + x * 8) as usize;
            std::array::from_fn(|c| crate::post::tonemap::f16_to_f32(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]])) * output.scale)
        })
        .collect();
    Ok(BloomImage { size: (width, height), texels })
}

/// The GPU milliseconds of the chain over a `render`-sized scene in an `output`-sized frame under
/// `settings`, one per sample of `frames`, from timestamps around its passes; None without
/// `TIMESTAMP_QUERY` (core devices without the renderer-owned feature). Each sample records
/// [`COST_CHAINS_PER_SAMPLE`] chains back to back in one submission and reports their mean, so the
/// GPU runs at a frame's clocks rather than idling between samples. The bloom cost row (plan §2.5:
/// <= 0.4 ms).
pub fn bloom_gpu_ms(gpu: &Gpu, settings: &BloomSettings, render: (u32, u32), output: (u32, u32), frames: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let texels = vec![[0.25, 0.2, 0.15, 1.0]; (render.0 * render.1) as usize];
    let scene = scene_texture(gpu, render, &texels)?;
    let input = scene.create_view(&Default::default());
    let mut node = BloomNode::new(device)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("bloom cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "bloom cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(frames as usize);
    for _ in 0..frames {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("bloom cost") });
        for chain in 0..COST_CHAINS_PER_SAMPLE {
            let stamps = (&query_set, chain == 0, chain + 1 == COST_CHAINS_PER_SAMPLE);
            let chain_input = BloomInput { source: BloomSource::Scene(&input), render, output, settings, generation: 0 };
            node.encode_timed(device, &gpu.queue, &mut encoder, chain_input, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission, after the chain's: Metal resolves counter samples
        // without waiting for the passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("bloom cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_CHAINS_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Quality;

    fn on(resolution: u16) -> BloomQuality {
        let mut quality = Quality::off().bloom;
        quality.enabled = true;
        quality.resolution = resolution;
        quality
    }

    #[test]
    fn the_chain_halves_from_its_output_sized_top_and_is_empty_when_off() {
        let quality = Quality::off().bloom;
        assert!(chain_sizes((1920, 1080), &quality).is_empty() && chain_target((1920, 1080), &quality).is_none());
        assert_eq!(chain_sizes((1920, 1080), &on(CHAIN_RESOLUTION)), [(960, 540), (480, 270), (240, 135), (120, 67), (60, 33), (30, 16), (15, 8)]);
        let target = chain_target((1920, 1080), &on(CHAIN_RESOLUTION)).expect("on");
        assert_eq!((target.size, target.mips, target.format), ((960, 540), u32::from(CHAIN_MIPS), CHAIN_FORMAT));
        // Above 1080p the top stays at the resolution's rows, with the output's aspect.
        assert_eq!(chain_sizes((3840, 2160), &on(CHAIN_RESOLUTION))[0], (960, 540));
        assert_eq!(chain_sizes((2560, 1440), &on(CHAIN_RESOLUTION))[0], (960, 540));
        assert_eq!(chain_sizes((2532, 1170), &on(360))[0], (779, 360));
        assert_eq!(chain_bytes((8, 8), &on(2)), 4 * 8, "a resolution of 2 rows: its 2 x 2 top alone");
        // 720p: six levels, down to 11 rows (the seventh would be 5).
        assert_eq!(chain_sizes((1280, 720), &on(CHAIN_RESOLUTION)).last(), Some(&(20, 11)));
        // The degrade rung's 270 rows: six levels, the last 8 rows like the full chain's.
        assert_eq!(chain_sizes((1920, 1080), &on(270)).last(), Some(&(15, 8)));
    }

    /// RQ4 review (the browser's pipeline check): a small output (a 64 px canvas) holds fewer mips
    /// than the chain's seven, so its texture is one WebGPU creates (a 32 px top holds three levels
    /// down to 8 rows).
    #[test]
    fn a_small_outputs_chain_ends_at_its_coarsest_rows() {
        let target = chain_target((64, 64), &on(CHAIN_RESOLUTION)).expect("on");
        assert_eq!((target.size, target.mips), ((32, 32), 3));
        assert_eq!(chain_sizes((4, 4), &on(CHAIN_RESOLUTION)), [(2, 2)]);
        assert_eq!(chain_target((1920, 1080), &on(CHAIN_RESOLUTION)).expect("on").mips, 7, "a real screen keeps all seven");
    }

    #[test]
    fn a_scene_more_than_twice_the_chain_top_is_halved_into_pre_levels_first() {
        let q = on(CHAIN_RESOLUTION);
        assert!(pre_level_sizes((1920, 1080), (1920, 1080), &q).is_empty(), "1080p: the scene is twice the top");
        assert!(pre_level_sizes((1152, 648), (1920, 1080), &q).is_empty(), "a DRS step below it");
        assert_eq!(pre_level_sizes((2560, 1440), (2560, 1440), &q), [(1920, 1080)]);
        assert_eq!(pre_level_sizes((3840, 2160), (3840, 2160), &q), [(1920, 1080)]);
        // A portrait phone: 1712 scene rows over a 360-row chain.
        assert_eq!(pre_level_sizes((790, 1712), (1179, 2556), &on(360)), [(332, 720)]);
        assert_eq!(pre_level_bytes((2560, 1440), (2560, 1440), &q), 1920 * 1080 * 8);
        assert!(pre_level_sizes((3840, 2160), (3840, 2160), &Quality::off().bloom).is_empty(), "no chain, no pre-level");
    }

    #[test]
    fn the_blend_factors_leave_mip_0_holding_the_weights() {
        for spread in [0.25, 1.0, 1.4, 4.0] {
            let weights = mip_weights(spread, 7);
            let factors = blend_factors(&weights);
            // Walk the upsamples: mip i holds (1 - f_i) of itself and f_i of what mips below it hold.
            let mut held = vec![0.0f32; 7];
            held[6] = 1.0;
            for mip in (0..6).rev() {
                let below = held.clone();
                held = below.iter().map(|share| share * factors[mip]).collect();
                held[mip] = 1.0 - factors[mip];
            }
            for (got, want) in held.iter().zip(&weights) {
                assert!((got - want).abs() < 1e-6, "spread {spread}: {held:?} against {weights:?}");
            }
        }
        assert_eq!(blend_factors(&[1.0]), Vec::<f32>::new(), "a one-mip chain blends nothing");
    }

    #[test]
    fn the_first_downsample_taps_half_a_chain_texel_apart_at_every_render_size() {
        assert_eq!(first_tap_step((960, 540)), [0.5 / 960.0, 0.5 / 540.0]);
        // At twice the chain's size that is a source texel: the pass-1 filter exactly.
        let row = GpuBloomParams::new(&Look::default(), (1920, 1080), (960, 540), 0, 7);
        assert_eq!(row.source, [1920.0, 1080.0, 1.0 / 1920.0, 1.0 / 1080.0]);
    }

    #[test]
    fn a_thresholded_composite_keeps_the_scene_below_the_threshold() {
        // A dim pixel far from every emitter (no glow reaches it): untouched, not lerped to black.
        assert_eq!(composite([0.3, 0.2, 0.1], [0.0; 3], 0.5, 1.0), [0.3, 0.2, 0.1]);
        // A bright pixel gives up part of what is above the threshold, never what is below it.
        let core = composite([4.0, 4.0, 4.0], [1.0; 3], 0.5, 1.0);
        assert!(core.iter().all(|c| (1.0..4.0).contains(c)), "{core:?}");
        // Threshold 0 is the energy-conserving lerp.
        assert_eq!(composite([2.0, 0.5, 0.0], [1.0; 3], 0.25, 0.0), [1.75, 0.625, 0.25]);
        assert_eq!(soft_threshold([0.4; 3], 1.0), [0.0; 3], "below the knee nothing blooms");
        assert_eq!(soft_threshold([3.0, 0.0, 0.0], 1.0), [2.0, 0.0, 0.0], "above the knee the excess blooms");
    }

    #[test]
    fn the_composite_conserves_energy_and_zero_intensity_is_the_scene() {
        let scene = [2.0, 0.5, 0.0];
        assert_eq!(composite(scene, [9.0, 9.0, 9.0], 0.0, 0.0), scene, "intensity 0: bloom adds nothing");
        let flat = composite([1.0; 3], [1.0; 3], 0.04, 0.0);
        assert_eq!(flat, [1.0; 3], "a flat image blooms into itself");
        let mixed = composite(scene, [1.0, 1.0, 1.0], 0.04, 0.0);
        assert!((mixed[0] - (2.0 * 0.96 + 0.04)).abs() < 1e-6);
    }

    #[test]
    fn the_first_step_carries_the_karis_and_threshold_flag_and_the_look() {
        let look = Look::default().with_bloom(0.1, 1.5, 2.0);
        let first = GpuBloomParams::new(&look, (1920, 1080), (960, 540), 0, 7);
        assert_eq!((first.mip, first.shape), ([0, 7, 1, 0], [0.1, 1.5, 0.0, THRESHOLD_KNEE]));
        let next = GpuBloomParams::new(&look, (960, 540), (480, 270), 1, 7);
        assert_eq!((next.mip[2], next.source), (0, [960.0, 540.0, 1.0 / 960.0, 1.0 / 540.0]));
    }
}
