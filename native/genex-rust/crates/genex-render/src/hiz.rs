//! The Hi-Z pyramid (R2, graph node 8): the farthest depth of every screen region, mip by mip, so
//! the occlusion cull rejects a meshlet whose nearest depth is behind it.
//!
//! - **The chain** ([`target`]): `r32float` at half the render size down to 1 × 1, pooled under
//!   the budget ledger's `hi-z` row (acquiring it through the [`crate::target_pool::TargetPool`]
//!   registers its bytes).
//! - **The build** ([`HizNode`], shaders/hiz_build.wgsl): one compute pass, one dispatch per mip.
//!   Mip 0 reduces the prepass depth by `textureLoad` in compute (no depth-to-colour copy); each
//!   later mip reduces the previous one, read as a sampled texture, into an `r32float` write-only
//!   storage view (core everywhere). Each dispatch is its own usage scope, so mip `k` is complete
//!   before mip `k + 1` reads it.
//! - **The reduction** follows the depth convention ([`reduction`]): the largest depth under
//!   standard Z, the smallest under reverse-Z.
//! - **Odd edges fold**: a destination texel covers its source's 2 × 2 block, and the last texel of
//!   a row or column also covers the source's leftover odd texel (or the only one of a 1-texel
//!   edge), so its footprint is up to 3 × 3. The pyramid is then conservative and tight for the
//!   cull's lookup: pixel `p` reads mip `k` at `min(p >> (k + 1), size_k - 1)`, and that texel holds
//!   exactly the farthest depth of the pixels that read it ([`reference`] is the CPU twin).
//! - **Caching**: the node keeps its bind groups and per-mip parameters until the depth view, the
//!   pyramid texture, the render size or the convention changes, so a steady frame records
//!   dispatches only.

use crate::compile::Compiled;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, ComputePipeline, Device, Queue, Texture, TextureUsages, TextureView};

use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::layout::GpuHizParams;
use crate::readback::{capture_failed, map_read_blocking};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the Hi-Z build encodes work (R2.2: [`HizNode`]). The graph schedules it once the
/// meshlet cull lands too ([`crate::meshlet_cull::occlusion_landed`]).
pub const LANDED: bool = true;

/// The pyramid's format: read-write storage in WebGPU core.
pub const HIZ_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;

/// The pyramid's pool label (its budget-ledger row).
pub const HIZ_LABEL: &str = "hi-z";

/// The Hi-Z build's compute workgroup side (8 × 8 invocations).
pub const HIZ_WORKGROUP: u32 = 8;

/// The most mips a pyramid has: half of the largest 2D texture any destination allows (16384)
/// halves 14 times to 1 texel; two spare.
pub const MIPS_MAX: u32 = 16;

/// The entry point that reduces the depth target into mip 0.
pub const FROM_DEPTH_ENTRY: &str = "hiz_from_depth";

/// The entry point that reduces mip `k - 1` into mip `k`.
pub const REDUCE_ENTRY: &str = "hiz_reduce";

/// Builds recorded back to back in one sample of [`hiz_gpu_ms`]: a lone build after an idle wait
/// pays the GPU's wake-up, while in a frame it follows the prepass on a busy GPU (as bloom's row).
pub const COST_BUILDS_PER_SAMPLE: u32 = 64;

/// The Hi-Z build: the common structs, the depth reduction (mip 0) and the mip reduction.
pub const HIZ_BUILD: &str = concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/hiz_build.wgsl"));

/// How four depths become one Hi-Z texel: keep the farthest.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HizReduce {
    /// The largest (standard Z: 1 is the far plane).
    Max,
    /// The smallest (reverse-Z: 0 is the far plane).
    Min,
}

impl HizReduce {
    /// The farthest of `depths`.
    pub fn reduce(self, depths: [f32; 4]) -> f32 {
        let [a, b, c, d] = depths;
        match self {
            HizReduce::Max => a.max(b).max(c.max(d)),
            HizReduce::Min => a.min(b).min(c.min(d)),
        }
    }

    /// `HizParams.params.y`: 0 for max, 1 for min (`gx_hiz_reduce`'s `reversed`).
    pub const fn shader_id(self) -> u32 {
        match self {
            HizReduce::Max => 0,
            HizReduce::Min => 1,
        }
    }
}

/// The reduction of a frame drawn with `depth_reversed` (`FrameConfig::depth_reversed`).
pub const fn reduction(depth_reversed: bool) -> HizReduce {
    if depth_reversed { HizReduce::Min } else { HizReduce::Max }
}

/// Mip 0's size: half the render size, at least 1 × 1 (odd edges fold into the last texel).
pub const fn base_size(render: (u32, u32)) -> (u32, u32) {
    (at_least_one(render.0 / 2), at_least_one(render.1 / 2))
}

const fn halved(px: u32, times: u32) -> u32 {
    if times >= u32::BITS { 0 } else { px >> times }
}

const fn at_least_one(px: u32) -> u32 {
    if px == 0 { 1 } else { px }
}

/// Mips of a full chain from `base` down to 1 × 1.
pub const fn mip_count(base: (u32, u32)) -> u32 {
    let largest = if base.0 > base.1 { base.0 } else { base.1 };
    if largest == 0 { 1 } else { u32::BITS - largest.leading_zeros() }
}

/// The size of `mip` in a chain from `base` (wgpu's rule: halve, round down, at least 1).
pub const fn level_size(base: (u32, u32), mip: u32) -> (u32, u32) {
    (at_least_one(halved(base.0, mip)), at_least_one(halved(base.1, mip)))
}

/// The pooled pyramid for a frame drawn at `render` size: storage-written, sampled by the cull.
pub fn target(render: (u32, u32)) -> TargetDesc {
    let size = base_size(render);
    TargetDesc {
        label: HIZ_LABEL,
        format: HIZ_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        samples: 1,
        size,
        mips: mip_count(size),
        srgb_view: false,
    }
}

// ---------------------------------------------------------------------------------------------
// The CPU reference

/// One mip of a pyramid: its size and its texels, row by row.
#[derive(Clone, Debug, PartialEq)]
pub struct HizLevel {
    /// Its size.
    pub size: (u32, u32),
    /// The farthest depth of each texel's footprint, row by row.
    pub texels: Vec<f32>,
}

impl HizLevel {
    /// The texel at (`x`, `y`).
    pub fn at(&self, x: u32, y: u32) -> f32 {
        self.texels[(y * self.size.0 + x) as usize]
    }
}

/// The source texels destination texel `at` covers on one axis, first and last: its own two, and
/// on the last destination texel also the source's leftover odd one (`gx_hiz_span`'s twin).
pub const fn span(at: u32, dest: u32, source: u32) -> (u32, u32) {
    let last_source = source.saturating_sub(1);
    let first = min_u32(at * 2, last_source);
    if at + 1 >= dest {
        return (first, last_source);
    }
    (first, min_u32(at * 2 + 1, last_source))
}

const fn min_u32(a: u32, b: u32) -> u32 {
    if a < b { a } else { b }
}

/// `source` (`size`, row by row) reduced into the next level with `reduce`, folding odd edges.
fn reduce_level(reduce: HizReduce, size: (u32, u32), source: &[f32], dest: (u32, u32)) -> Vec<f32> {
    let mut texels = Vec::with_capacity((dest.0 * dest.1) as usize);
    for y in 0..dest.1 {
        let rows = span(y, dest.1, size.1);
        for x in 0..dest.0 {
            let cols = span(x, dest.0, size.0);
            let mut far = source[(rows.0 * size.0 + cols.0) as usize];
            for sy in rows.0..=rows.1 {
                for sx in cols.0..=cols.1 {
                    let depth = source[(sy * size.0 + sx) as usize];
                    far = reduce.reduce([far, depth, far, depth]);
                }
            }
            texels.push(far);
        }
    }
    texels
}

/// The pyramid [`HizNode`] builds from a `render`-sized depth image (`depths`, row by row) under
/// `reduce`: the CPU twin of shaders/hiz_build.wgsl, equal to it bit for bit (min and max are
/// exact). Refused `texture-invalid` when `depths` does not hold `render`'s texels.
pub fn reference(reduce: HizReduce, render: (u32, u32), depths: &[f32]) -> Result<Vec<HizLevel>, RenderError> {
    let texels = u64::from(render.0) * u64::from(render.1);
    if texels == 0 || depths.len() as u64 != texels {
        let detail = format!("{} depths for a {}x{} Hi-Z source", depths.len(), render.0, render.1);
        return Err(RenderError::refused(RenderCode::TextureInvalid, detail));
    }
    let base = base_size(render);
    let mut levels: Vec<HizLevel> = Vec::with_capacity(mip_count(base) as usize);
    for mip in 0..mip_count(base) {
        let size = level_size(base, mip);
        let texels = match levels.last() {
            Some(previous) => reduce_level(reduce, previous.size, &previous.texels, size),
            None => reduce_level(reduce, render, depths, size),
        };
        levels.push(HizLevel { size, texels });
    }
    Ok(levels)
}

// ---------------------------------------------------------------------------------------------
// The GPU build

/// The bind-group binding of each piece (shaders/hiz_build.wgsl).
const PARAMS_BINDING: u32 = 0;
const DEPTH_BINDING: u32 = 1;
const DEST_BINDING: u32 = 2;
const MIP_SOURCE_BINDING: u32 = 3;

/// What one build reads and writes.
#[derive(Clone, Copy, Debug)]
pub struct HizInput<'a> {
    /// The prepass depth (`Depth32Float`, single-sampled, `TEXTURE_BINDING`) at `render` size.
    pub depth: &'a TextureView,
    /// The pyramid: a texture of [`target`]`(render)` (its size, mips and usages, or more usages).
    pub pyramid: &'a Texture,
    /// The render size (the depth's).
    pub render: (u32, u32),
    /// The frame's depth convention.
    pub reduce: HizReduce,
}

/// What the cached bind groups were made for: the inputs' identities, size and convention.
struct HizKey {
    depth: TextureView,
    pyramid: Texture,
    render: (u32, u32),
    reduce: HizReduce,
}

impl HizKey {
    fn matches(&self, input: &HizInput<'_>) -> bool {
        self.depth == *input.depth && self.pyramid == *input.pyramid && self.render == input.render && self.reduce == input.reduce
    }
}

/// The Hi-Z build (graph node 8's first step): its two pipelines, the per-mip parameters and the
/// bind groups of the current input. Made once, recorded every frame occlusion culls.
pub struct HizNode {
    depth_layout: BindGroupLayout,
    reduce_layout: BindGroupLayout,
    from_depth: Compiled<ComputePipeline>,
    reduce: Compiled<ComputePipeline>,
    params: Buffer,
    stride: u64,
    cached: Option<(HizKey, Vec<BindGroup>)>,
}

fn compute_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty, count: None }
}

fn group_layout(device: &Device, label: &str, source: wgpu::BindGroupLayoutEntry) -> BindGroupLayout {
    let size = wgpu::BufferSize::new(size_of::<GpuHizParams>() as u64);
    let params = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: size };
    let dest = wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: HIZ_FORMAT, view_dimension: wgpu::TextureViewDimension::D2 };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[compute_entry(PARAMS_BINDING, params), source, compute_entry(DEST_BINDING, dest)],
    })
}

fn compute_pipeline(device: &Device, layout: &BindGroupLayout, module: &wgpu::ShaderModule, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout(device, entry, &[layout])),
        module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

/// A pyramid that does not fit `render`'s chain, or a chain longer than [`MIPS_MAX`].
fn check_pyramid(input: &HizInput<'_>) -> Result<(), RenderError> {
    let base = base_size(input.render);
    let mips = mip_count(base);
    let (texture, size) = (input.pyramid, input.pyramid.size());
    let fits = (size.width, size.height) == base && texture.mip_level_count() == mips && texture.format() == HIZ_FORMAT;
    if !fits || mips > MIPS_MAX {
        let detail = format!("a {}x{} pyramid of {} mips for a {}x{} render", size.width, size.height, texture.mip_level_count(), input.render.0, input.render.1);
        return Err(RenderError::refused(RenderCode::TextureInvalid, detail));
    }
    Ok(())
}

impl HizNode {
    /// The build's pipelines and parameter slots.
    pub fn new(device: &Device) -> Result<HizNode, RenderError> {
        let module = crate::shaders::module(device, "hi-z build", HIZ_BUILD)?;
        let depth = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
        let mip = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        };
        let depth_layout = group_layout(device, "hi-z from depth", compute_entry(DEPTH_BINDING, depth));
        let reduce_layout = group_layout(device, "hi-z reduce", compute_entry(MIP_SOURCE_BINDING, mip));
        let stride = u64::from(device.limits().min_uniform_buffer_offset_alignment).max(size_of::<GpuHizParams>() as u64);
        let params = buffer(device, "hi-z params", stride * u64::from(MIPS_MAX), BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(HizNode {
            from_depth: compute_pipeline(device, &depth_layout, &module, FROM_DEPTH_ENTRY),
            reduce: compute_pipeline(device, &reduce_layout, &module, REDUCE_ENTRY),
            depth_layout,
            reduce_layout,
            params,
            stride,
            cached: None,
        })
    }

    /// Record the build of `input`'s pyramid: one compute pass, one dispatch per mip. Refused
    /// `texture-invalid` when the pyramid is not [`target`]`(render)`'s chain.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: HizInput<'_>) -> Result<(), RenderError> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// [`HizNode::encode`] with the pass's timestamp writes (a cost row).
    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: HizInput<'_>,
        timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> Result<(), RenderError> {
        check_pyramid(&input)?;
        self.prepare(device, queue, &input);
        let groups = &self.cached.as_ref().expect("prepared").1;
        let base = base_size(input.render);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("hi-z build"), timestamp_writes });
        for (mip, group) in groups.iter().enumerate() {
            let size = level_size(base, mip as u32);
            pass.set_pipeline(if mip == 0 { &self.from_depth } else { &self.reduce });
            pass.set_bind_group(0, group, &[]);
            // Each dispatch is its own usage scope: mip `k` is written before mip `k + 1` reads it.
            pass.dispatch_workgroups(size.0.div_ceil(HIZ_WORKGROUP), size.1.div_ceil(HIZ_WORKGROUP), 1);
        }
        Ok(())
    }

    /// Drop the cached bind groups (and with them the last depth view and pyramid they hold), as
    /// when occlusion turns off and the pool releases the pyramid.
    pub fn release(&mut self) {
        self.cached = None;
    }

    /// Make the bind groups and write the per-mip parameters when `input` is not the cached one.
    fn prepare(&mut self, device: &Device, queue: &Queue, input: &HizInput<'_>) {
        if self.cached.as_ref().is_some_and(|(key, _)| key.matches(input)) {
            return;
        }
        let base = base_size(input.render);
        let mips = mip_count(base);
        let mut bytes = vec![0u8; (self.stride * u64::from(mips)) as usize];
        for mip in 0..mips {
            let source = if mip == 0 { input.render } else { level_size(base, mip - 1) };
            let dest = level_size(base, mip);
            let row = GpuHizParams { size: [source.0, source.1, dest.0, dest.1], params: [mip, input.reduce.shader_id(), 0, 0] };
            let at = (u64::from(mip) * self.stride) as usize;
            bytes[at..at + size_of::<GpuHizParams>()].copy_from_slice(bytemuck::bytes_of(&row));
        }
        queue.write_buffer(&self.params, 0, &bytes);
        let views: Vec<TextureView> = (0..mips)
            .map(|mip| input.pyramid.create_view(&wgpu::TextureViewDescriptor { base_mip_level: mip, mip_level_count: Some(1), ..Default::default() }))
            .collect();
        let groups = (0..mips as usize)
            .map(|mip| {
                let (layout, source_binding, source) = match mip {
                    0 => (&self.depth_layout, DEPTH_BINDING, input.depth),
                    _ => (&self.reduce_layout, MIP_SOURCE_BINDING, &views[mip - 1]),
                };
                let size = wgpu::BufferSize::new(size_of::<GpuHizParams>() as u64);
                let params = wgpu::BufferBinding { buffer: &self.params, offset: self.stride * mip as u64, size };
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("hi-z build"),
                    layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: PARAMS_BINDING, resource: wgpu::BindingResource::Buffer(params) },
                        wgpu::BindGroupEntry { binding: source_binding, resource: wgpu::BindingResource::TextureView(source) },
                        wgpu::BindGroupEntry { binding: DEST_BINDING, resource: wgpu::BindingResource::TextureView(&views[mip]) },
                    ],
                })
            })
            .collect();
        let key = HizKey { depth: input.depth.clone(), pyramid: input.pyramid.clone(), render: input.render, reduce: input.reduce };
        self.cached = Some((key, groups));
    }
}

// ---------------------------------------------------------------------------------------------
// The build on a supplied depth image (tests, cost rows)

/// One build of [`hiz_pyramids`]: a depth image and its convention.
#[derive(Clone, Debug, PartialEq)]
pub struct HizFrame {
    /// The render size.
    pub render: (u32, u32),
    /// Device depth per pixel, row by row (0..1).
    pub depths: Vec<f32>,
    /// The convention it was drawn with.
    pub reduce: HizReduce,
}

/// Writes a plain `r32float` image into a prepass-format depth target (`frag_depth`), so the
/// build reads a real depth texture.
const UPLOAD_WGSL: &str = "
@group(0) @binding(0) var src_depth: texture_2d<f32>;

@vertex
fn vs_hiz_upload(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_hiz_upload(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(src_depth, vec2<i32>(position.xy), 0).r;
}
";

/// The upload pass: plain depths into a prepass-format depth target.
struct DepthUpload {
    layout: BindGroupLayout,
    pipeline: Compiled<wgpu::RenderPipeline>,
}

impl DepthUpload {
    fn new(device: &Device) -> Result<DepthUpload, RenderError> {
        let module = crate::shaders::module(device, "hi-z upload", UPLOAD_WGSL)?;
        let source = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        };
        let entry = wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: source, count: None };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("hi-z upload"), entries: &[entry] });
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("hi-z upload"),
            layout: Some(&pipeline_layout(device, "hi-z upload", &[&layout])),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_hiz_upload"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: crate::renderer::DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_hiz_upload"), compilation_options: Default::default(), targets: &[] }),
            multiview_mask: None,
            cache: None,
        });
        Ok(DepthUpload { layout, pipeline })
    }

    /// A prepass-format depth target holding `depths` (`render`, row by row).
    fn run(&self, gpu: &Gpu, render: (u32, u32), depths: &[f32]) -> Result<Texture, RenderError> {
        crate::capture::check_capture_size(render.0, render.1)?;
        let [desc, _] = crate::prepass::targets(render);
        let depth = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(desc.label),
            size: wgpu::Extent3d { width: render.0, height: render.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: desc.format,
            usage: desc.usage,
            view_formats: &[],
        });
        self.write(gpu, &depth, render, depths)?;
        Ok(depth)
    }

    /// Draw `depths` (`render`, row by row) into `depth` (a prepass-format target of that size).
    fn write(&self, gpu: &Gpu, depth: &Texture, render: (u32, u32), depths: &[f32]) -> Result<(), RenderError> {
        let device = &gpu.device;
        if depths.len() != (render.0 * render.1) as usize {
            return Err(capture_failed(format!("{} depths for a {}x{} frame", depths.len(), render.0, render.1)));
        }
        let extent = wgpu::Extent3d { width: render.0, height: render.1, depth_or_array_layers: 1 };
        let source = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("hi-z upload source"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Float,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(render.0 * 4), rows_per_image: Some(render.1) };
        gpu.queue.write_texture(source.as_image_copy(), bytemuck::cast_slice(depths), layout, extent);
        let source_view = source.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("hi-z upload"),
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&source_view) }],
        });
        let depth_view = depth.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hi-z upload") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("hi-z upload"),
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
        Ok(())
    }
}

/// A pyramid texture for `render` that can also be read back.
fn readable_pyramid(device: &Device, render: (u32, u32)) -> Texture {
    let desc = target(render);
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(desc.label),
        size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
        mip_level_count: desc.mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: desc.format,
        usage: desc.usage | TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// Every mip of `pyramid` read back.
fn read_pyramid(gpu: &Gpu, pyramid: &Texture, base: (u32, u32)) -> Result<Vec<HizLevel>, RenderError> {
    let mut levels = Vec::new();
    for mip in 0..pyramid.mip_level_count() {
        let (width, height) = level_size(base, mip);
        let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let bytes = u64::from(padded) * u64::from(height);
        let staging = buffer(&gpu.device, "hi-z readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hi-z readback") });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: pyramid, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let data = map_read_blocking(gpu, &staging, bytes)?;
        let texels = (0..height)
            .flat_map(|y| (0..width).map(move |x| (y * padded + x * 4) as usize))
            .map(|at| f32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]))
            .collect();
        levels.push(HizLevel { size: (width, height), texels });
    }
    Ok(levels)
}

/// The pyramids [`HizNode`] builds for `frames` in order, every mip read back. One node builds them
/// all, so a frame whose size or convention differs from the last rebuilds its bind groups. The
/// way to check the build on the GPU without the prepass.
pub fn hiz_pyramids(gpu: &Gpu, frames: &[HizFrame]) -> Result<Vec<Vec<HizLevel>>, RenderError> {
    let device = &gpu.device;
    let upload = DepthUpload::new(device)?;
    let mut node = HizNode::new(device)?;
    let mut pyramids = Vec::with_capacity(frames.len());
    // The same depth and pyramid textures while the size stays, so a repeated frame hits the cache.
    let mut held: Option<((u32, u32), Texture, TextureView, Texture)> = None;
    for frame in frames {
        match &held {
            Some((render, depth, ..)) if *render == frame.render => upload.write(gpu, depth, frame.render, &frame.depths)?,
            _ => {
                let depth = upload.run(gpu, frame.render, &frame.depths)?;
                let view = depth.create_view(&Default::default());
                held = Some((frame.render, depth, view, readable_pyramid(device, frame.render)));
            }
        }
        let (_, _, view, pyramid) = held.as_ref().expect("held");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hi-z build") });
        node.encode(device, &gpu.queue, &mut encoder, HizInput { depth: view, pyramid, render: frame.render, reduce: frame.reduce })?;
        gpu.queue.submit([encoder.finish()]);
        pyramids.push(read_pyramid(gpu, pyramid, base_size(frame.render))?);
    }
    Ok(pyramids)
}

/// The GPU milliseconds of one build over a `render`-sized depth target, one per sample of
/// `samples`, from timestamps around its passes; None without `TIMESTAMP_QUERY`. Each sample
/// records [`COST_BUILDS_PER_SAMPLE`] builds back to back in one submission and reports their mean.
/// The Hi-Z cost row (R2.2: <= 0.15 ms at 1080p).
pub fn hiz_gpu_ms(gpu: &Gpu, render: (u32, u32), samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let depths: Vec<f32> = (0..render.0 * render.1).map(|i| (i % 1021) as f32 / 1021.0).collect();
    let depth = DepthUpload::new(device)?.run(gpu, render, &depths)?;
    let view = depth.create_view(&Default::default());
    let pyramid = readable_pyramid(device, render);
    let mut node = HizNode::new(device)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("hi-z cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "hi-z cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hi-z cost") });
        for build in 0..COST_BUILDS_PER_SAMPLE {
            let (first, last) = (build == 0, build + 1 == COST_BUILDS_PER_SAMPLE);
            let stamps = (first || last).then_some(wgpu::ComputePassTimestampWrites {
                query_set: &query_set,
                beginning_of_pass_write_index: first.then_some(0),
                end_of_pass_write_index: last.then_some(1),
            });
            let input = HizInput { depth: &view, pyramid: &pyramid, render, reduce: HizReduce::Max };
            node.encode_timed(device, &gpu.queue, &mut encoder, input, stamps)?;
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission: Metal resolves counter samples without waiting for the
        // passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("hi-z cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_BUILDS_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chain_halves_to_one_texel_including_odd_sizes() {
        assert_eq!(base_size((1920, 1080)), (960, 540));
        assert_eq!(mip_count((960, 540)), 10);
        assert_eq!(level_size((960, 540), 9), (1, 1));
        assert_eq!(level_size((63, 36), 5), (1, 1));
        assert_eq!(mip_count((1, 1)), 1);
        assert_eq!(base_size((1, 1)), (1, 1));
    }

    #[test]
    fn the_last_texel_folds_the_leftover_odd_source_texel() {
        assert_eq!(span(0, 63, 127), (0, 1));
        assert_eq!(span(62, 63, 127), (124, 126), "the odd column folds into the last texel");
        assert_eq!(span(62, 63, 126), (124, 125));
        assert_eq!(span(0, 1, 1), (0, 0), "a 1-texel edge reads its one texel");
        assert_eq!(span(0, 1, 3), (0, 2));
    }

    #[test]
    fn the_reduction_keeps_the_farthest_depth_of_either_convention() {
        let depths = [0.25, 0.75, 0.5, 1.0];
        assert_eq!(reduction(false).reduce(depths), 1.0);
        assert_eq!(reduction(true).reduce(depths), 0.25);
        assert_eq!((HizReduce::Max.shader_id(), HizReduce::Min.shader_id()), (0, 1));
    }
}
