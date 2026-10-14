//! Screen-space contact shadows for the sun (plan §2.2 node 10a; RQ4). RQ4.0 landed the contract:
//! the mask target ([`mask_target`]), the GPU row ([`GpuContactShadowParams`],
//! `ContactShadowParams` in shaders/post/contact_shadow.wgsl) and the march's fixed step count.
//! RQ4.7 records the march: [`ContactShadowNode`] reads the prepass depth and the frame's
//! `GxFrameV2` and writes the mask; the sun chunk (shaders/lighting/sun.wgsl) multiplies the sun's
//! visibility by `gx_contact_shadow`, which answers 1 until the forward frame group binds the mask.
//!
//! Contact shadows are a high and ultra feature (plan §2.4): the quality only switches them on or
//! off ([`runs`]), the march always takes [`STEPS`] samples, at half the render size, and the look
//! sets the ray's length ([`crate::settings::Look::contact_shadow_length`]). They catch what the
//! cascaded maps miss at small scale: a pebble's or a foot's shadow where it meets the ground,
//! below a map texel and its bias. Noise along the ray is frame-keyed only under TAA (plan
//! principle 6): without TAA a frame is the same bits every time. The mask is fragment-written
//! `r8unorm` (1 unshadowed; core has no `r8unorm` storage); [`mask_bytes`] is what it holds, for
//! the budget ledger. It keeps no history.
//!
//! The renderer records [`ContactShadowNode`] between the prepass (RQ4.1) and the world pass on
//! frames whose sun casts shadows (only then does the prepass run for it,
//! `prepass::with_sun_shadows`), brings the mask to the render size with the joint-bilateral
//! upsample ([`MASK_FULL_LABEL`], [`crate::post::upsample`]; both targets from the renderer's
//! target pool, RQ4 review) and binds it at the forward frame group's `contact_shadow_mask` slot
//! (`layout::FRAME_EFFECT_BOUND`, read by `gx_contact_shadow` in shaders/forward_effects.wgsl;
//! RQ4.6) and at the Level-2 v2 map's; a frame without contact shadows binds a white texel there. [`contact_shadow_masks`] runs the node on a depth buffer the caller supplies, so the
//! march is checked on the GPU without the prepass wiring.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use glam::Mat4;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, Queue, RenderPipeline, Texture, TextureFormat, TextureUsages, TextureView};

use crate::abi::GxFrameV2;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{Look, Quality};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the graph schedules contact shadows (node 10a) and the `contact-shadows` switch changes
/// the picture: the renderer records [`ContactShadowNode`] after the prepass and binds its mask in
/// the forward frame group (RQ4.6).
pub const LANDED: bool = true;
/// The mask's format (1 unshadowed).
pub const MASK_FORMAT: TextureFormat = TextureFormat::R8Unorm;
/// The mask's usages.
pub const MASK_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The mask's pool label.
pub const MASK_LABEL: &str = "contact shadows";
/// The mask brought to the render size by the joint-bilateral upsample (what the world pass reads;
/// [`crate::post::upsample`]).
pub const MASK_FULL_LABEL: &str = "contact shadows full";
/// Every pool label contact shadows may hold (released when they do not run).
pub const LABELS: [&str; 2] = [MASK_LABEL, MASK_FULL_LABEL];
/// Samples along each ray (one count for high and ultra: the feature is off below).
pub const STEPS: u32 = 16;
/// The depth thickness a sample must be within to occlude, in world units.
pub const THICKNESS: f32 = 0.05;
/// How far along the ray the march starts, as a fraction of a step (self-shadowing bias).
pub const START_BIAS: f32 = 0.5;
/// Cost rows record this many nodes back to back per sample (as AO's: a lone pass after an idle
/// wait pays the GPU's wake-up).
pub const COST_NODES_PER_SAMPLE: u32 = 32;

/// The bindings of contact_shadow.wgsl's group 0.
const BINDING_DEPTH: u32 = 0;
const BINDING_PARAMS: u32 = 1;
const BINDING_FRAME: u32 = 2;

/// The march's uniform (`ContactShadowParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuContactShadowParams {
    /// xy: the mask's size in pixels; zw: 1 / it.
    pub size: [f32; 4],
    /// xyz: the unit direction towards the sun (world space); w: the ray length in world units.
    pub light: [f32; 4],
    /// x: the depth thickness a hit must be within (world units); y: the start bias; zw: reserved.
    pub params: [f32; 4],
    /// x: steps; y: the frame index (noise only under TAA, else 0); z: 1 under reverse-Z; w: 1
    /// under TAA (the march adds frame-keyed noise to its start).
    pub counts: [u32; 4],
}

impl GpuContactShadowParams {
    /// The row for a `size` mask towards `sun_dir` with `look`'s ray length, on `frame_index`
    /// (kept only when `taa` consumes the noise) with `depth_reversed` as the frame has it.
    pub fn new(look: &Look, size: (u32, u32), sun_dir: [f32; 3], frame_index: u64, taa: bool, depth_reversed: bool) -> GpuContactShadowParams {
        let (w, h) = (size.0.max(1) as f32, size.1.max(1) as f32);
        let noise_frame = if taa { (frame_index % u64::from(u32::MAX)) as u32 } else { 0 };
        let sun = glam::Vec3::from(sun_dir).normalize_or(glam::Vec3::Y);
        GpuContactShadowParams {
            size: [w, h, 1.0 / w, 1.0 / h],
            light: [sun.x, sun.y, sun.z, look.contact_shadow_length],
            params: [THICKNESS, START_BIAS, 0.0, 0.0],
            counts: [STEPS, noise_frame, u32::from(depth_reversed), u32::from(taa)],
        }
    }
}

/// Whether contact shadows run under `quality` on a frame whose sun casts shadows (`sun_shadows`):
/// the quality's switch, and a sun to shadow.
pub fn runs(quality: &Quality, sun_shadows: bool) -> bool {
    quality.contact_shadows && sun_shadows
}

/// The mask's size for a `render`-sized scene: half of it, at least 1x1.
pub fn mask_size(render: (u32, u32)) -> (u32, u32) {
    ((render.0 / 2).max(1), (render.1 / 2).max(1))
}

/// The mask's pooled target at `render` size.
pub fn mask_target(render: (u32, u32)) -> TargetDesc {
    TargetDesc { label: MASK_LABEL, format: MASK_FORMAT, usage: MASK_USAGE, samples: 1, size: mask_size(render), mips: 1, srgb_view: false }
}

/// Every pooled target of contact shadows at `render` size: the half-size mask and the mask
/// upsampled to the render size ([`MASK_FULL_LABEL`]).
pub fn targets(render: (u32, u32)) -> Vec<TargetDesc> {
    targets_with_usage(render, TextureUsages::empty())
}

/// [`targets`] with `extra_usage` (a readback's `COPY_SRC`).
fn targets_with_usage(render: (u32, u32), extra_usage: TextureUsages) -> Vec<TargetDesc> {
    let mask = TargetDesc { usage: MASK_USAGE | extra_usage, ..mask_target(render) };
    let full = TargetDesc { label: MASK_FULL_LABEL, size: (render.0.max(1), render.1.max(1)), ..mask };
    if full.size == mask.size { vec![mask] } else { vec![mask, full] }
}

/// The mask's bytes at `render` size: one byte a texel at half size, and one at the render size
/// for the upsampled mask (the pool's ledger entries).
pub fn mask_bytes(render: (u32, u32)) -> u64 {
    targets(render).iter().map(TargetDesc::bytes).sum()
}

// ---------------------------------------------------------------------------------------------
// The node

/// What a frame tells the march beside its depth.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContactShadowFacts {
    /// Unit direction towards the sun (world space).
    pub sun_dir: [f32; 3],
    /// The frame index (keys the noise under TAA only).
    pub frame_index: u64,
    /// Whether a temporal resolve follows (the noise turns per frame).
    pub taa: bool,
    /// Whether the depth is reversed (`Greater`, cleared to 0).
    pub depth_reversed: bool,
}

/// What [`ContactShadowNode::encode`] reads this frame.
pub struct ContactShadowInput<'a> {
    /// The prepass depth (render size, sampleable).
    pub depth: &'a TextureView,
    /// The frame's `GxFrameV2` (uniform): the march reads `view_proj`, `inv_view_proj` and `proj`.
    pub frame: &'a Buffer,
    /// The render size.
    pub render: (u32, u32),
    /// The look (the ray's length).
    pub look: &'a Look,
    /// Sun, frame index, TAA and depth convention.
    pub facts: ContactShadowFacts,
    /// The prepass's normals (the upsample weighs by them; None: by depth alone).
    pub normals: Option<&'a TextureView>,
    /// The projection the depth was drawn with (view to clip): the upsample's view distances.
    pub proj: Mat4,
    /// The inputs' identity: the bind group is rebuilt when it changes.
    pub generation: u64,
}

/// A target and its view.
struct Mask {
    size: (u32, u32),
    texture: Texture,
    view: TextureView,
}

impl Mask {
    fn pooled(target: &crate::target_pool::PooledTarget) -> Mask {
        Mask { size: target.desc().size, texture: target.texture().clone(), view: target.view().clone() }
    }
}

/// Graph node 10a: the march into the half-size mask, then the joint-bilateral upsample to the
/// render size. Its targets come from the target pool ([`ContactShadowNode::acquire`]); it keeps
/// no history.
pub struct ContactShadowNode {
    layout: BindGroupLayout,
    pipeline: Compiled<RenderPipeline>,
    params: Buffer,
    mask: Option<Mask>,
    full: Option<Mask>,
    extra_usage: TextureUsages,
    group: Option<(GroupKey, BindGroup)>,
    upsample: crate::post::upsample::JointUpsample,
}

/// What a cached bind group was made for: the input's generation and the mask's size.
type GroupKey = (u64, (u32, u32));

/// A fragment-visible bind group layout entry.
fn fragment_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

/// A uniform of `size` bytes at `binding`.
fn uniform_entry(binding: u32, size: usize) -> wgpu::BindGroupLayoutEntry {
    let min_binding_size = wgpu::BufferSize::new(size as u64);
    fragment_entry(binding, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size })
}

/// The march's layout: the depth, its row and the frame.
fn march_layout(device: &Device) -> BindGroupLayout {
    let depth = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("contact shadows"),
        entries: &[
            fragment_entry(BINDING_DEPTH, depth),
            uniform_entry(BINDING_PARAMS, size_of::<GpuContactShadowParams>()),
            uniform_entry(BINDING_FRAME, size_of::<GxFrameV2>()),
        ],
    })
}

/// The full-screen march writing the mask.
fn march_pipeline(device: &Device, layout: &BindGroupLayout) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = crate::shaders::module(device, "contact shadows", crate::shaders::CONTACT_SHADOW)?;
    Ok(crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("contact shadows"),
        layout: Some(&pipeline_layout(device, "contact shadows", &[layout])),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_contact_shadow"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_contact_shadow"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: MASK_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    }))
}

/// A single-mip 2D texture.
fn make_texture(device: &Device, label: &str, size: (u32, u32), format: TextureFormat, usage: TextureUsages) -> Texture {
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
}

/// Timestamp writes around one pass: (query set, stamp its beginning, stamp its end).
type Stamps<'a> = Option<(&'a wgpu::QuerySet, bool, bool)>;

impl ContactShadowNode {
    /// The node, its shader compiled and its layout made; the mask comes with the first frame.
    pub fn new(device: &Device) -> Result<ContactShadowNode, RenderError> {
        ContactShadowNode::with_usage(device, TextureUsages::empty())
    }

    /// A node whose mask also carries `extra_usage` (a readback's `COPY_SRC`).
    fn with_usage(device: &Device, extra_usage: TextureUsages) -> Result<ContactShadowNode, RenderError> {
        let layout = march_layout(device);
        let pipeline = march_pipeline(device, &layout)?;
        let params = buffer(device, "contact shadow params", size_of::<GpuContactShadowParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let upsample = crate::post::upsample::JointUpsample::new(device)?;
        Ok(ContactShadowNode { layout, pipeline, params, mask: None, full: None, extra_usage, group: None, upsample })
    }

    /// Take the mask and its render-size twin for a `render`-sized frame from `pool` (allocated
    /// there, so the ledger holds them, and kept while their descriptors hold).
    pub fn acquire(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32)) -> Result<(), RenderError> {
        let descs = targets_with_usage(render, self.extra_usage);
        for label in LABELS {
            if !descs.iter().any(|desc| desc.label == label) {
                pool.release(label);
            }
        }
        let mask = Mask::pooled(pool.acquire(device, descs[0])?);
        let full = match descs.get(1) {
            Some(desc) => Some(Mask::pooled(pool.acquire(device, *desc)?)),
            None => None,
        };
        if self.mask.as_ref().is_none_or(|held| held.texture != mask.texture) {
            self.group = None;
        }
        self.mask = Some(mask);
        self.full = full;
        Ok(())
    }

    /// Give the targets back to `pool` (contact shadows do not run).
    pub fn release(&mut self, pool: &mut crate::target_pool::TargetPool) {
        for label in LABELS {
            pool.release(label);
        }
        self.mask = None;
        self.full = None;
        self.group = None;
    }

    /// The bind group for `input`, cached by its generation and the mask's size.
    fn bind_group(&mut self, device: &Device, input: &ContactShadowInput<'_>, size: (u32, u32)) -> BindGroup {
        let key = (input.generation, size);
        if let Some((held, group)) = &self.group
            && *held == key
        {
            return group.clone();
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("contact shadows"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: BINDING_DEPTH, resource: wgpu::BindingResource::TextureView(input.depth) },
                crate::tables::entry(BINDING_PARAMS, &self.params),
                crate::tables::entry(BINDING_FRAME, input.frame),
            ],
        });
        self.group = Some((key, group.clone()));
        group
    }

    /// Record the march for `input` into the mask, then its upsample, and return the view the
    /// world pass reads (the render size, [`MASK_FORMAT`], 1 unshadowed). None when no mask of this
    /// size was acquired.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: ContactShadowInput<'_>) -> Option<TextureView> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// [`ContactShadowNode::encode`] with timestamps around its passes: a cost row.
    fn encode_timed(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: ContactShadowInput<'_>, stamps: Stamps<'_>) -> Option<TextureView> {
        let size = mask_size(input.render);
        if self.mask.as_ref().is_none_or(|mask| mask.size != size) {
            return None;
        }
        let facts = input.facts;
        let row = GpuContactShadowParams::new(input.look, size, facts.sun_dir, facts.frame_index, facts.taa, facts.depth_reversed);
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let group = self.bind_group(device, &input, size);
        let view = self.mask.as_ref().expect("checked above").view.clone();
        let upsampled = self.full.is_some();
        let stamp = |first: bool, last: bool| {
            let (query_set, stamp_first, stamp_last) = stamps?;
            let (begin, end) = ((first && stamp_first).then_some(0), (last && stamp_last).then_some(1));
            (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end })
        };
        let timestamp_writes = stamp(true, !upsampled);
        // The march writes every texel of the mask: nothing to load.
        let attachment = wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
        };
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("contact shadows"), color_attachments: &[Some(attachment)], timestamp_writes, ..Default::default() });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        let Some(full) = &self.full else { return Some(view) };
        let full_view = full.view.clone();
        let params = crate::post::upsample::GpuUpsampleParams::new(size, input.render, input.proj, facts.depth_reversed);
        let upsample = crate::post::upsample::UpsampleInput { low: &view, depth: input.depth, normals: input.normals, target: &full_view, guide: None, params, key: (input.generation, 0) };
        self.upsample.encode_timed(device, queue, encoder, upsample, MASK_FORMAT, stamp(false, true));
        Some(full_view)
    }
}

// ---------------------------------------------------------------------------------------------
// The node on a supplied depth buffer (tests, cost rows)

/// The camera a supplied depth was drawn with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContactShadowCamera {
    /// World → view.
    pub view: Mat4,
    /// View → clip (reversed when the facts say so).
    pub proj: Mat4,
}

impl ContactShadowCamera {
    /// The `GxFrameV2` members the march reads, for a `render`-sized frame under `facts`.
    pub fn frame_row(&self, render: (u32, u32), facts: &ContactShadowFacts) -> GxFrameV2 {
        let view_proj = self.proj * self.view;
        let inverse_view = self.view.inverse();
        GxFrameV2 {
            view: self.view.to_cols_array(),
            proj: self.proj.to_cols_array(),
            view_proj: view_proj.to_cols_array(),
            inv_view_proj: view_proj.inverse().to_cols_array(),
            prev_view_proj: view_proj.to_cols_array(),
            unjittered_view_proj: view_proj.to_cols_array(),
            camera_pos: inverse_view.w_axis.to_array(),
            camera_forward: (-inverse_view.z_axis.truncate()).extend(0.0).to_array(),
            sun_dir: glam::Vec3::from(facts.sun_dir).extend(0.0).to_array(),
            render_size: [render.0 as f32, render.1 as f32],
            output_size: [render.0 as f32, render.1 as f32],
            pre_exposure: 1.0,
            inv_pre_exposure: 1.0,
            frame_index: (facts.frame_index % u64::from(u32::MAX)) as u32,
            depth_reversed: u32::from(facts.depth_reversed),
            ..GxFrameV2::default()
        }
    }
}

/// One frame of [`contact_shadow_masks`]: the scene's device depth row by row at render size
/// (top row first), the camera it was drawn with and the frame's facts.
#[derive(Clone, Debug, PartialEq)]
pub struct ContactShadowFrame {
    /// Device depth per pixel (0..1, the convention `facts.depth_reversed` names).
    pub depth: Vec<f32>,
    /// The camera.
    pub camera: ContactShadowCamera,
    /// Sun, frame index, TAA and depth convention.
    pub facts: ContactShadowFacts,
}

/// A mask read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskImage {
    /// Its size (half the render size).
    pub size: (u32, u32),
    /// Visibility per texel (255 unshadowed), row by row.
    pub visibility: Vec<u8>,
}

impl MaskImage {
    /// Visibility at texel (`x`, `y`) in 0..1.
    pub fn at(&self, x: u32, y: u32) -> f32 {
        f32::from(self.visibility[(y * self.size.0 + x) as usize]) / 255.0
    }
}

/// Writes a render-sized depth target from a plain `r32float` texture: the prepass depth for a
/// scene the caller drew or ray cast elsewhere.
const UPLOAD_WGSL: &str = "
@group(0) @binding(0) var src_depth: texture_2d<f32>;

@vertex
fn vs_upload(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_upload(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(src_depth, vec2<i32>(position.xy), 0).r;
}
";

/// The upload pass: plain depth into the prepass depth's format.
struct Upload {
    layout: BindGroupLayout,
    pipeline: Compiled<RenderPipeline>,
}

impl Upload {
    fn new(device: &Device) -> Result<Upload, RenderError> {
        let module = crate::shaders::module(device, "contact shadow upload", UPLOAD_WGSL)?;
        let source = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("contact shadow upload"), entries: &[fragment_entry(0, source)] });
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("contact shadow upload"),
            layout: Some(&pipeline_layout(device, "contact shadow upload", &[&layout])),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_upload"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: crate::renderer::DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_upload"), compilation_options: Default::default(), targets: &[] }),
            multiview_mask: None,
            cache: None,
        });
        Ok(Upload { layout, pipeline })
    }

    /// `depth` in a stand-in for the prepass depth at `size`.
    fn run(&self, gpu: &Gpu, size: (u32, u32), depth: &[f32]) -> Result<TextureView, RenderError> {
        if depth.len() != (size.0 * size.1) as usize {
            return Err(capture_failed(format!("{} depths for a {}x{} frame", depth.len(), size.0, size.1)));
        }
        let device = &gpu.device;
        let source = make_texture(device, "contact shadow upload depth", size, TextureFormat::R32Float, TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST);
        gpu.queue.write_texture(
            source.as_image_copy(),
            bytemuck::cast_slice(depth),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * 4), rows_per_image: Some(size.1) },
            wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        );
        let source_view = source.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("contact shadow upload"),
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&source_view) }],
        });
        let [desc, _] = crate::prepass::targets(size);
        let target = make_texture(device, desc.label, size, desc.format, desc.usage).create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("contact shadow upload") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("contact shadow upload"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &target,
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
        Ok(target)
    }
}

/// A uniform buffer holding `frame`'s `GxFrameV2`.
fn frame_buffer(gpu: &Gpu, frame: &ContactShadowFrame, render: (u32, u32)) -> Result<Buffer, RenderError> {
    let row = frame.camera.frame_row(render, &frame.facts);
    let held = buffer(&gpu.device, "contact shadow frame", size_of::<GxFrameV2>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    gpu.queue.write_buffer(&held, 0, row.as_bytes());
    Ok(held)
}

/// Read the node's mask back: the half-size one, or (`render_size`) the one the world pass reads.
fn read_mask(gpu: &Gpu, node: &ContactShadowNode, render_size: bool) -> Result<MaskImage, RenderError> {
    let read = if render_size { node.full.as_ref().or(node.mask.as_ref()) } else { node.mask.as_ref() };
    let mask = read.ok_or_else(|| capture_failed("contact shadows drew nothing"))?;
    let (width, height) = mask.size;
    let padded = width.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let bytes = u64::from(padded) * u64::from(height);
    let staging = buffer(&gpu.device, "contact shadow readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("contact shadow readback") });
    encoder.copy_texture_to_buffer(
        mask.texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, bytes)?;
    let visibility = (0..height).flat_map(|y| (0..width).map(move |x| (y * padded + x) as usize)).map(|at| data[at]).collect();
    Ok(MaskImage { size: (width, height), visibility })
}

/// The masks contact shadows make for `frames` in order at `render` size under `look`: each
/// frame's depth is written to a stand-in for the prepass depth, then the node runs and its mask is
/// read back. The way to check the march on the GPU without the prepass wiring.
pub fn contact_shadow_masks(gpu: &Gpu, look: &Look, render: (u32, u32), frames: &[ContactShadowFrame]) -> Result<Vec<MaskImage>, RenderError> {
    masks(gpu, look, render, frames, false)
}

/// [`contact_shadow_masks`] read at the render size: the mask the world pass reads, through the
/// joint-bilateral upsample (weighed by depth alone: the supplied frames carry no normals).
pub fn contact_shadow_render_masks(gpu: &Gpu, look: &Look, render: (u32, u32), frames: &[ContactShadowFrame]) -> Result<Vec<MaskImage>, RenderError> {
    masks(gpu, look, render, frames, true)
}

fn masks(gpu: &Gpu, look: &Look, render: (u32, u32), frames: &[ContactShadowFrame], render_size: bool) -> Result<Vec<MaskImage>, RenderError> {
    crate::capture::check_capture_size(render.0, render.1)?;
    let device = &gpu.device;
    let upload = Upload::new(device)?;
    let mut node = ContactShadowNode::with_usage(device, TextureUsages::COPY_SRC)?;
    let mut pool = crate::target_pool::TargetPool::new();
    node.acquire(device, &mut pool, render)?;
    let mut masks = Vec::with_capacity(frames.len());
    for (index, frame) in frames.iter().enumerate() {
        let depth = upload.run(gpu, render, &frame.depth)?;
        let frame_row = frame_buffer(gpu, frame, render)?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("contact shadow mask") });
        let input =
            ContactShadowInput { depth: &depth, frame: &frame_row, render, look, facts: frame.facts, normals: None, proj: frame.camera.proj, generation: index as u64 };
        node.encode(device, &gpu.queue, &mut encoder, input).ok_or_else(|| capture_failed("contact shadows have no mask"))?;
        gpu.queue.submit([encoder.finish()]);
        masks.push(read_mask(gpu, &node, render_size)?);
    }
    Ok(masks)
}

/// The GPU milliseconds of the march over `frame` at `render` size under `look`, one per sample of
/// `samples`, from timestamps around its pass; None without `TIMESTAMP_QUERY`. Each sample records
/// [`COST_NODES_PER_SAMPLE`] nodes back to back in one submission and reports their mean. The
/// contact-shadow cost row (plan §2.5: <= 0.3 ms at 1080p, half resolution).
pub fn contact_shadow_gpu_ms(gpu: &Gpu, look: &Look, render: (u32, u32), frame: &ContactShadowFrame, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let depth = Upload::new(device)?.run(gpu, render, &frame.depth)?;
    let frame_row = frame_buffer(gpu, frame, render)?;
    let mut node = ContactShadowNode::new(device)?;
    let mut pool = crate::target_pool::TargetPool::new();
    node.acquire(device, &mut pool, render)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("contact shadow cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "contact shadow cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("contact shadow cost") });
        for run in 0..COST_NODES_PER_SAMPLE {
            let input = ContactShadowInput { depth: &depth, frame: &frame_row, render, look, facts: frame.facts, normals: None, proj: frame.camera.proj, generation: 0 };
            node.encode_timed(device, &gpu.queue, &mut encoder, input, Some((&query_set, run == 0, run + 1 == COST_NODES_PER_SAMPLE)));
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission: Metal resolves counter samples without waiting for the
        // passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("contact shadow cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_NODES_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mask_is_half_size_r8unorm() {
        let target = mask_target((1920, 1080));
        assert_eq!((target.size, target.format, target.samples), ((960, 540), MASK_FORMAT, 1));
        // The half-size mask and its render-size upsample (RQ4 review), both in the pool's ledger.
        assert_eq!(mask_bytes((1920, 1080)), 960 * 540 + 1920 * 1080);
        assert_eq!(targets((1920, 1080)).iter().map(|t| (t.label, t.size)).collect::<Vec<_>>(), [(MASK_LABEL, (960, 540)), (MASK_FULL_LABEL, (1920, 1080))]);
        assert_eq!(mask_size((1, 1)), (1, 1));
        assert_eq!(targets((1, 1)).len(), 1, "a mask the size of the scene needs no upsample");
    }

    #[test]
    fn noise_keys_to_the_frame_only_under_taa() {
        let look = Look::default().with_contact_shadow_length(0.5);
        let still = GpuContactShadowParams::new(&look, (960, 540), [0.0, 1.0, 0.0], 9, false, true);
        assert_eq!((still.counts, still.light[3]), ([STEPS, 0, 1, 0], 0.5));
        assert_eq!(GpuContactShadowParams::new(&look, (960, 540), [0.0, 1.0, 0.0], 9, true, false).counts, [STEPS, 9, 0, 1]);
    }

    #[test]
    fn the_sun_direction_is_unit_length_and_a_zero_one_points_up() {
        let look = Look::default();
        let row = GpuContactShadowParams::new(&look, (4, 4), [0.0, 3.0, 4.0], 0, false, true);
        assert_eq!(row.light[..3], [0.0, 0.6, 0.8]);
        assert_eq!(GpuContactShadowParams::new(&look, (4, 4), [0.0; 3], 0, false, true).light[..3], [0.0, 1.0, 0.0]);
    }

    #[test]
    fn contact_shadows_run_only_when_switched_on_under_a_shadowing_sun() {
        let mut quality = Quality::off();
        assert!(!runs(&quality, true));
        quality.contact_shadows = true;
        assert!(runs(&quality, true));
        assert!(!runs(&quality, false), "no sun shadows, no contact shadows");
    }

    #[test]
    fn the_frame_row_reconstructs_the_camera() {
        let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::new(1.0, 2.0, 3.0), glam::Vec3::ZERO, glam::Vec3::Y);
        let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(1.0, 2.0, 0.1);
        let facts = ContactShadowFacts { sun_dir: [0.0, 1.0, 0.0], frame_index: 3, taa: false, depth_reversed: true };
        let row = ContactShadowCamera { view, proj }.frame_row((8, 4), &facts);
        assert!(glam::Vec4::from(row.camera_pos).abs_diff_eq(glam::Vec4::new(1.0, 2.0, 3.0, 1.0), 1e-5));
        let forward = glam::Vec3::new(-1.0, -2.0, -3.0).normalize();
        assert!(glam::Vec4::from(row.camera_forward).truncate().abs_diff_eq(forward, 1e-5));
        let round_trip = Mat4::from_cols_array(&row.inv_view_proj) * Mat4::from_cols_array(&row.view_proj);
        assert!(round_trip.abs_diff_eq(Mat4::IDENTITY, 1e-4));
        assert_eq!((row.depth_reversed, row.frame_index), (1, 3));
    }
}
