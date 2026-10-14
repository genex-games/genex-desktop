//! The joint-bilateral upsample of a half-resolution screen effect to the render size (RQ4 review;
//! shaders/post/joint_upsample.wgsl): AO's term and the sun's contact-shadow mask are made at half
//! the render size, then brought to the render size guided by the prepass's depth and normals, so
//! the world pass (and a Level-2 v2 material) reads one texel per pixel that belongs to the
//! pixel's own surface: no crease or contact shadow bleeds onto the surface beside it and no
//! half-size block shows. One full-screen pass of five texel reads per corner; the target is
//! pooled by its owner (AO's [`crate::post::ao::AO_FULL_LABEL`], the contact shadows'
//! [`crate::post::contact_shadow::MASK_FULL_LABEL`]).

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use glam::Mat4;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, PipelineLayout, Queue, RenderPipeline, ShaderModule, TextureFormat, TextureView};

use crate::error::RenderError;
use crate::tables::{buffer, pipeline_layout};

/// The upsample's uniform (`UpsampleParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuUpsampleParams {
    /// xy: the low-resolution size; zw: the render size.
    pub sizes: [f32; 4],
    /// Clip to view space (the inverse of the projection the prepass depth was drawn with).
    pub inv_proj: [f32; 16],
    /// x: 1 under reverse-Z; yzw: reserved.
    pub flags: [u32; 4],
}

impl GpuUpsampleParams {
    /// The row for a `low`-sized effect brought to `render` size under `proj` (depth `reversed`).
    pub fn new(low: (u32, u32), render: (u32, u32), proj: Mat4, reversed: bool) -> GpuUpsampleParams {
        GpuUpsampleParams {
            sizes: [low.0.max(1) as f32, low.1.max(1) as f32, render.0.max(1) as f32, render.1.max(1) as f32],
            inv_proj: proj.inverse().to_cols_array(),
            flags: [u32::from(reversed), 0, 0, 0],
        }
    }
}

/// What one upsample reads and writes.
pub struct UpsampleInput<'a> {
    /// The low-resolution effect.
    pub low: &'a TextureView,
    /// The prepass depth (render size).
    pub depth: &'a TextureView,
    /// The prepass's octahedral normals (render size); None weighs by depth alone.
    pub normals: Option<&'a TextureView>,
    /// The render-size target, of the effect's format.
    pub target: &'a TextureView,
    /// The low-resolution view distance each texel was made at (`r32float`, AO's view-depth chain
    /// mip 0); None reads the representative pixel's prepass depth.
    pub guide: Option<&'a TextureView>,
    /// The row to write.
    pub params: GpuUpsampleParams,
    /// The inputs' identity: bind groups are cached by it (AO's alternating terms keep two).
    pub key: (u64, u64),
}

/// The upsample's pipelines (one per target format, made on first use), its uniform and its last
/// bind group.
pub struct JointUpsample {
    module: ShaderModule,
    layout: BindGroupLayout,
    pipeline_layout: PipelineLayout,
    pipelines: Vec<((TextureFormat, bool, bool), Compiled<RenderPipeline>)>,
    params: Buffer,
    groups: Vec<((u64, u64), BindGroup)>,
}

/// Bind groups the upsample keeps (AO's two alternating terms, with room for a step change).
const GROUPS_KEPT: usize = 4;

fn entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn texture_entry(binding: u32, sample_type: wgpu::TextureSampleType) -> wgpu::BindGroupLayoutEntry {
    entry(binding, wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false })
}

impl JointUpsample {
    /// The node, its shader compiled; pipelines come with the first format drawn.
    pub fn new(device: &Device) -> Result<JointUpsample, RenderError> {
        let module = crate::shaders::module(device, "joint upsample", crate::shaders::JOINT_UPSAMPLE)?;
        let unfilterable = wgpu::TextureSampleType::Float { filterable: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("joint upsample"),
            entries: &[
                texture_entry(0, unfilterable),
                texture_entry(1, wgpu::TextureSampleType::Depth),
                texture_entry(2, unfilterable),
                texture_entry(4, unfilterable),
                entry(
                    3,
                    wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(size_of::<GpuUpsampleParams>() as u64),
                    },
                ),
            ],
        });
        let pipeline_layout = pipeline_layout(device, "joint upsample", &[&layout]);
        let params = buffer(device, "joint upsample params", size_of::<GpuUpsampleParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(JointUpsample { module, layout, pipeline_layout, pipelines: Vec::new(), params, groups: Vec::new() })
    }

    fn pipeline(&mut self, device: &Device, format: TextureFormat, normals: bool, guide: bool) -> &RenderPipeline {
        let key = (format, normals, guide);
        if let Some(index) = self.pipelines.iter().position(|(held, _)| *held == key) {
            return &self.pipelines[index].1;
        }
        let constants = [("GX_UP_NORMALS", f64::from(u8::from(normals))), ("GX_UP_GUIDE", f64::from(u8::from(guide)))];
        let compilation_options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("joint upsample"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState { module: &self.module, entry_point: Some("vs_upsample"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &self.module,
                entry_point: Some("fs_upsample"),
                compilation_options,
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        self.pipelines.push((key, pipeline));
        &self.pipelines.last().expect("pushed").1
    }

    /// Record the upsample of `input` into `format` (the target's). One render pass.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: UpsampleInput<'_>, format: TextureFormat) {
        self.encode_timed(device, queue, encoder, input, format, None);
    }

    /// [`JointUpsample::encode`] with `timestamp_writes` around its pass (a cost row's last pass).
    pub fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: UpsampleInput<'_>,
        format: TextureFormat,
        timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) {
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&input.params));
        let group = match self.groups.iter().find(|(held, _)| *held == input.key) {
            Some((_, group)) => group.clone(),
            None => {
                let view = |binding, view| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) };
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("joint upsample"),
                    layout: &self.layout,
                    // Without normals or a guide the low texture stands in at their slots (never read).
                    entries: &[
                        view(0, input.low),
                        view(1, input.depth),
                        view(2, input.normals.unwrap_or(input.low)),
                        crate::tables::entry(3, &self.params),
                        view(4, input.guide.unwrap_or(input.low)),
                    ],
                });
                if self.groups.len() == GROUPS_KEPT {
                    self.groups.remove(0);
                }
                self.groups.push((input.key, group.clone()));
                group
            }
        };
        let pipeline = self.pipeline(device, format, input.normals.is_some(), input.guide.is_some()).clone();
        let attachment = wgpu::RenderPassColorAttachment {
            view: input.target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("joint upsample"), color_attachments: &[Some(attachment)], timestamp_writes, ..Default::default() });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
}
