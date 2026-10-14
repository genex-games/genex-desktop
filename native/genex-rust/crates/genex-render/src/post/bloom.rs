//! Bloom (plan §2.2 node 19; RQ4). RQ4.0 lands the contract: the chain's format and sizes, the GPU
//! row ([`GpuBloomParams`], `BloomParams` in shaders/post/bloom_*.wgsl), the composite's CPU twin
//! and the neutral black input the tonemap binds until the chain runs ([`TONEMAP_BLOOM_BINDING`]);
//! RQ4.2 records the chain ([`BloomNode`]) and composites it in the tonemap
//! ([`crate::post::tonemap`]: the tonemap node runs the chain itself before its pass once
//! `TonemapNode::set_bloom` hands it [`BloomSettings`]).
//!
//! Bloom is **threshold-free and energy-conserving** by default (plan G20): the pre-exposed HDR
//! scene is downsampled into a mip chain (a Karis-weighted first step so one blinding texel does
//! not flicker), tent-upsampled back with the look's spread ([`crate::settings::Look::bloom_radius`]),
//! and the tonemap blends `mix(scene, bloom, intensity)` ([`composite`]), so a frame's energy is
//! kept and nothing is added. A look's optional threshold ([`crate::settings::Look::bloom_threshold`])
//! is a stylistic soft knee ([`soft_threshold`]) on the first downsample; the chain then holds only
//! the over-threshold part, so the composite trades that part for its glow and keeps the rest of the
//! scene (`scene + (bloom - soft_threshold(scene)) * intensity`, [`composite`]): a lerp would darken
//! everything below the threshold. Quality sets only the chain: on or off, mips
//! ([`crate::settings::BloomQuality::mips`]) and whether it starts at half resolution; mobile caps
//! it at [`MOBILE_MIPS_MAX`].
//!
//! The chain: mip 0 is the scene downsampled (Jimenez's 13-tap filter from the 1x scene, its five
//! 2x2 groups Karis-weighted by 1 / (1 + luma); a 2x2 Karis-weighted box from the multisampled
//! scene when the tonemap resolves in its own pass), each next mip the 13-tap filter of the last.
//! The upsample walks back up: the tent of mip i+1 is added onto mip i (additive blend, `Load`),
//! so mip 0 ends holding the sum of every mip's blur; the composite divides it by the mip count
//! ([`BloomOutput::scale`]), so the bloom image has the scene's mean radiance and the lerp keeps
//! the frame's energy. Karis's weight removes energy from lone texels far above their
//! neighbourhood on purpose (a firefly must not flicker the glow); smooth emitters keep it. Every
//! pass is a fragment pass over `rgba16float`, so tile GPUs keep each mip in tile memory.
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
/// The most mips any preset asks for (ultra).
pub const MIPS_MAX: u8 = 7;
/// The most mips a mobile class keeps (plan §2.4's mobile caps).
pub const MOBILE_MIPS_MAX: u8 = 5;
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
    /// xy: the source mip's size in texels; zw: 1 / it.
    pub source: [f32; 4],
    /// x: intensity; y: threshold (0: none); z: the spread (radius multiplier); w: the threshold's
    /// knee ([`THRESHOLD_KNEE`]).
    pub shape: [f32; 4],
    /// x: the mip written; y: mips in the chain; z: 1 on the first downsample (Karis, threshold);
    /// w: reserved.
    pub mip: [u32; 4],
}

impl GpuBloomParams {
    /// The row of the step reading a `source`-sized mip and writing mip `mip` of a `mips`-deep
    /// chain, with `look`'s intensity, threshold and spread.
    pub fn new(look: &Look, source: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        let shape = (look.bloom_intensity, look.bloom_threshold, look.bloom_radius);
        GpuBloomParams::from_shape(shape, source, mip, mips)
    }

    fn from_shape((intensity, threshold, radius): (f32, f32, f32), source: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        let (w, h) = (source.0.max(1) as f32, source.1.max(1) as f32);
        GpuBloomParams { source: [w, h, 1.0 / w, 1.0 / h], shape: [intensity, threshold, radius, THRESHOLD_KNEE], mip: [mip, mips, u32::from(mip == 0), 0] }
    }
}

/// One frame's bloom: the look's intensity, threshold and spread with the quality's chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BloomSettings {
    /// The composite's lerp weight (the look's `bloom_intensity`, 0..1).
    pub intensity: f32,
    /// The stylistic soft-knee threshold in pre-exposed radiance (0: none, energy-conserving).
    pub threshold: f32,
    /// The upsample's spread (radius multiplier).
    pub radius: f32,
    /// The chain: mips and whether it starts at half resolution.
    pub quality: BloomQuality,
}

impl BloomSettings {
    /// The settings a frame of `look` under `quality` draws, or None when bloom is off, has no mip
    /// or the look's intensity is 0 (the tonemap then binds the neutral black input).
    pub fn new(look: &Look, quality: &BloomQuality) -> Option<BloomSettings> {
        let on = quality.enabled && quality.mips > 0 && look.bloom_intensity > 0.0;
        on.then_some(BloomSettings { intensity: look.bloom_intensity, threshold: look.bloom_threshold, radius: look.bloom_radius, quality: *quality })
    }

    fn step(&self, source: (u32, u32), mip: u32, mips: u32) -> GpuBloomParams {
        GpuBloomParams::from_shape((self.intensity, self.threshold, self.radius), source, mip, mips)
    }
}

/// The chain's mip sizes for a `render`-sized scene under `quality` (empty when bloom is off): mip 0
/// at half resolution when [`BloomQuality::half_res`], each next one half the last, ending at the
/// 1 x 1 level of a small scene (a texture holds no more levels than its size allows).
pub fn chain_sizes(render: (u32, u32), quality: &BloomQuality) -> Vec<(u32, u32)> {
    if !quality.enabled || quality.mips == 0 {
        return Vec::new();
    }
    let shift = u32::from(quality.half_res);
    let top = ((render.0 >> shift).max(1), (render.1 >> shift).max(1));
    let levels = 32 - top.0.max(top.1).leading_zeros();
    (0..u32::from(quality.mips.min(MIPS_MAX)).min(levels)).map(|mip| ((top.0 >> mip).max(1), (top.1 >> mip).max(1))).collect()
}

/// The chain's pooled target at `render` size (None when bloom is off).
pub fn chain_target(render: (u32, u32), quality: &BloomQuality) -> Option<TargetDesc> {
    let sizes = chain_sizes(render, quality);
    let top = *sizes.first()?;
    Some(TargetDesc { label: CHAIN_LABEL, format: CHAIN_FORMAT, usage: CHAIN_USAGE, samples: 1, size: top, mips: sizes.len() as u32, srgb_view: false })
}

/// The chain's bytes (every mip, `rgba16float`).
pub fn chain_bytes(render: (u32, u32), quality: &BloomQuality) -> u64 {
    chain_sizes(render, quality).iter().map(|(w, h)| u64::from(*w) * u64::from(*h) * 8).sum()
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

/// One chain's input: the scene, its (render) size, the frame's bloom and the input's identity
/// (the target pool's generation).
#[derive(Clone, Copy)]
pub(crate) struct BloomInput<'a> {
    /// The scene the chain starts from.
    pub source: BloomSource<'a>,
    /// Its size.
    pub render: (u32, u32),
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
    /// Mip 0 of the chain (every mip's blur summed).
    pub view: TextureView,
    /// The lerp weight.
    pub intensity: f32,
    /// 1 / mips: brings the summed chain back to the scene's mean radiance.
    pub scale: f32,
    /// The look's stylistic threshold (0: none, the lerp).
    pub threshold: f32,
    /// The chain's identity (changes when it is reallocated).
    pub chain: u64,
    /// Render passes the chain opened (its downsamples and upsamples).
    pub passes: u32,
}

/// The chain's texture and one view per mip.
struct Chain {
    texture: Texture,
    views: Vec<TextureView>,
    sizes: Vec<(u32, u32)>,
    id: u64,
}

/// Chains one sample of [`bloom_gpu_ms`] records back to back. A lone chain after an idle wait
/// pays the GPU's wake-up (measured on the M4 Max: 0.55 ms at 8 a sample against 0.38 ms at 64);
/// in a frame the chain follows the scene's passes on a busy GPU, which 64 approximates.
pub const COST_CHAINS_PER_SAMPLE: u32 = 64;
/// The uniform slots: a downsample per mip and an upsample per mip but the last.
const PARAM_SLOTS: u64 = MIPS_MAX as u64 * 2 - 1;
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

/// The additive blend of the upsample: the tent of the smaller mip added onto this one.
const ADDITIVE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
};

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
            up: chain_pipeline(device, &chain_layout, &up_module, "fs_bloom_up", Some(ADDITIVE)),
            msaa_pipeline_layout: pipeline_layout(device, "bloom msaa", &[&msaa_layout]),
            msaa_down: None,
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

    /// The chain for `sizes`, reallocated when they change.
    fn chain(&mut self, device: &Device, sizes: &[(u32, u32)]) -> &Chain {
        if self.chain.as_ref().is_some_and(|chain| chain.sizes == sizes) {
            return self.chain.as_ref().expect("held");
        }
        let top = sizes[0];
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(CHAIN_LABEL),
            size: wgpu::Extent3d { width: top.0, height: top.1, depth_or_array_layers: 1 },
            mip_level_count: sizes.len() as u32,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: CHAIN_FORMAT,
            usage: CHAIN_USAGE | self.extra_usage,
            view_formats: &[],
        });
        let views = (0..sizes.len() as u32)
            .map(|mip| texture.create_view(&wgpu::TextureViewDescriptor { base_mip_level: mip, mip_level_count: Some(1), ..Default::default() }))
            .collect();
        self.groups = None;
        let id = self.next_id;
        self.next_id += 1;
        self.chain.insert(Chain { texture, views, sizes: sizes.to_vec(), id })
    }

    fn slot(&self, index: usize) -> wgpu::BindingResource<'_> {
        let size = wgpu::BufferSize::new(size_of::<GpuBloomParams>() as u64);
        wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.params, offset: self.stride * index as u64, size })
    }

    /// The bind groups of every step: the downsamples (mip 0 reads `source`), then the upsamples
    /// from the smallest mip up.
    fn bind_groups(&mut self, device: &Device, source: BloomSource<'_>, generation: u64) -> Vec<BindGroup> {
        let chain = self.chain.as_ref().expect("the chain is made first");
        let key = (generation, matches!(source, BloomSource::Msaa(_)), chain.id);
        if let Some((held, groups)) = &self.groups
            && *held == key
        {
            return groups.clone();
        }
        let n = chain.views.len();
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
        let mut groups = vec![first];
        groups.extend((1..n).map(|mip| sampled(mip, &chain.views[mip - 1])));
        // Upsample k (k = 0 first) reads mip n-1-k and writes mip n-2-k.
        groups.extend((0..n - 1).map(|k| sampled(n + k, &chain.views[n - 1 - k])));
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
        let BloomInput { source, render, settings, generation } = input;
        let sizes = chain_sizes(render, &settings.quality);
        if sizes.is_empty() {
            return None;
        }
        if matches!(source, BloomSource::Msaa(_)) && self.msaa_down.is_none() {
            self.msaa_down = Some(chain_pipeline(device, &self.msaa_pipeline_layout, &self.down_module, "fs_bloom_down_msaa", None));
        }
        let n = sizes.len();
        self.write_params(queue, render, &sizes, settings);
        self.chain(device, &sizes);
        let groups = self.bind_groups(device, source, generation);
        let chain = self.chain.as_ref().expect("made above");
        let last = 2 * n - 2;
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
        for (mip, group) in groups.iter().enumerate().take(n) {
            let pipeline = match (mip, source) {
                (0, BloomSource::Msaa(_)) => self.msaa_down.as_ref().expect("made above"),
                _ => &self.down,
            };
            // A downsample covers every texel of its mip: nothing to load.
            chain_pass(encoder, &chain.views[mip], wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), stamp(mip), pipeline, group);
        }
        for (k, group) in groups.iter().enumerate().skip(n) {
            let target = &chain.views[2 * n - 2 - k];
            chain_pass(encoder, target, wgpu::LoadOp::Load, stamp(k), &self.up, group);
        }
        let scale = 1.0 / n as f32;
        let passes = (2 * n - 1) as u32;
        Some(BloomOutput { view: chain.views[0].clone(), intensity: settings.intensity, scale, threshold: settings.threshold, chain: chain.id, passes })
    }

    fn write_params(&self, queue: &Queue, render: (u32, u32), sizes: &[(u32, u32)], settings: &BloomSettings) {
        let n = sizes.len();
        let mut bytes = vec![0u8; (self.stride * PARAM_SLOTS) as usize];
        let mut put = |slot: usize, row: GpuBloomParams| {
            let at = slot * self.stride as usize;
            bytes[at..at + size_of::<GpuBloomParams>()].copy_from_slice(bytemuck::bytes_of(&row));
        };
        for mip in 0..n {
            let source = if mip == 0 { render } else { sizes[mip - 1] };
            put(mip, settings.step(source, mip as u32, n as u32));
        }
        for k in 0..n - 1 {
            let read = n - 1 - k;
            put(n + k, settings.step(sizes[read], (read - 1) as u32, n as u32));
        }
        queue.write_buffer(&self.params, 0, &bytes);
    }
}

fn chain_pass(
    encoder: &mut wgpu::CommandEncoder,
    target: &TextureView,
    load: wgpu::LoadOp<wgpu::Color>,
    timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
    pipeline: &RenderPipeline,
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
/// `settings`: mip 0 of the chain read back and scaled to the scene's mean radiance (what the
/// tonemap lerps towards), with its size. The way to check the chain's energy and shape on the GPU.
pub fn bloom_chain_image(gpu: &Gpu, settings: &BloomSettings, size: (u32, u32), texels: &[[f32; 4]]) -> Result<BloomImage, RenderError> {
    let scene = scene_texture(gpu, size, texels)?;
    let input = scene.create_view(&Default::default());
    read_chain(gpu, BloomInput { source: BloomSource::Scene(&input), render: size, settings, generation: 0 })
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
    read_chain(gpu, BloomInput { source: BloomSource::Msaa(&input), render: size, settings, generation: 0 })
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

/// The GPU milliseconds of the chain over a `render`-sized scene under `settings`, one per sample
/// of `frames`, from timestamps around its passes; None without `TIMESTAMP_QUERY` (core devices
/// without the renderer-owned feature). Each sample records [`COST_CHAINS_PER_SAMPLE`] chains back
/// to back in one submission and reports their mean, so the GPU runs at a frame's clocks rather
/// than idling between samples. The bloom cost row (plan §2.5: 7 mips <= 0.4 ms at 1080p).
pub fn bloom_gpu_ms(gpu: &Gpu, settings: &BloomSettings, render: (u32, u32), frames: u32) -> Result<Option<Vec<f32>>, RenderError> {
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
            let chain_input = BloomInput { source: BloomSource::Scene(&input), render, settings, generation: 0 };
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

    #[test]
    fn the_chain_halves_from_half_resolution_and_is_empty_when_off() {
        let mut quality = Quality::off().bloom;
        assert!(chain_sizes((1920, 1080), &quality).is_empty() && chain_target((1920, 1080), &quality).is_none());
        quality.enabled = true;
        quality.mips = 5;
        assert_eq!(chain_sizes((1920, 1080), &quality), [(960, 540), (480, 270), (240, 135), (120, 67), (60, 33)]);
        let target = chain_target((1920, 1080), &quality).expect("on");
        assert_eq!((target.size, target.mips, target.format), ((960, 540), 5, CHAIN_FORMAT));
        assert_eq!(chain_bytes((8, 8), &BloomQuality { enabled: true, mips: 2, half_res: false }), (64 + 16) * 8);
        assert_eq!(chain_sizes((4, 4), &BloomQuality { enabled: true, mips: 7, half_res: true }).last(), Some(&(1, 1)));
    }

    /// RQ4 review (the browser's pipeline check): a small scene (a 64 px canvas, a deep render-scale
    /// step) holds fewer mips than ultra's seven; the chain stops at 1 x 1, so its texture is one
    /// WebGPU creates (a 32 px top holds six levels).
    #[test]
    fn a_small_scenes_chain_stops_at_one_texel() {
        let ultra = BloomQuality { enabled: true, mips: 7, half_res: true };
        let target = chain_target((64, 64), &ultra).expect("on");
        assert_eq!((target.size, target.mips), ((32, 32), 6));
        assert_eq!(chain_sizes((4, 4), &ultra), [(2, 2), (1, 1)]);
        assert_eq!(chain_target((1920, 1080), &ultra).expect("on").mips, 7, "a real screen keeps all seven");
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
        let first = GpuBloomParams::new(&look, (960, 540), 0, 6);
        assert_eq!((first.mip, first.shape), ([0, 6, 1, 0], [0.1, 1.5, 2.0, THRESHOLD_KNEE]));
        assert_eq!(GpuBloomParams::new(&look, (480, 270), 1, 6).mip[2], 0);
    }
}
