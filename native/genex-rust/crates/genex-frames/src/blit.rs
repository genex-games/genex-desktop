//! The final blit into a slot, bottom-up: memory row 0 of the IOSurface holds the bottom image
//! row, as `frames.cpp` (and ANGLE's IOSurface pbuffers) store it and the host expects. The source
//! is scaled nearest-neighbour to the ring size (identity when the sizes match), with no filtering
//! and no colour conversion, so the slot's bytes are exactly the source's.

use std::time::Duration;

use crate::error::{FramesCode, FramesError};
use crate::surface::{SLOT_FORMAT, SlotSurface};

/// How long the sender waits for the GPU to finish a frame before giving up on it.
pub const GPU_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

const SHADER: &str = r"
struct Ring { size: vec2<u32>, _pad: vec2<u32> }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> ring: Ring;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corners = array(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4(corners[index], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let source_size = textureDimensions(source);
    let x = u32(position.x);
    // Framebuffer row 0 is memory row 0, which holds the image's bottom row.
    let image_y = ring.size.y - 1u - u32(position.y);
    let sx = min(x * source_size.x / ring.size.x, source_size.x - 1u);
    let sy = min(image_y * source_size.y / ring.size.y, source_size.y - 1u);
    return textureLoad(source, vec2(sx, sy), 0);
}
";

/// The bottom-up blit pipeline. One per sender; reused for every frame and ring.
pub struct BottomUpBlit {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    target: wgpu::Buffer,
}

impl BottomUpBlit {
    /// Builds the pipeline on `device`.
    pub fn new(device: &wgpu::Device) -> BottomUpBlit {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("genex-frames blit"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("genex-frames blit"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("genex-frames blit"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("genex-frames blit"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: SLOT_FORMAT,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let target = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("genex-frames blit target"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        BottomUpBlit { pipeline, layout, target }
    }

    /// Blits `source` into `slot` bottom-up, submits, and returns once the GPU finished it: the
    /// frame is complete in the IOSurface before anything is sent.
    pub fn draw_and_wait(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &wgpu::TextureView,
        slot: &SlotSurface,
    ) -> Result<(), FramesError> {
        let size = slot.texture().size();
        let words: [u32; 4] = [size.width, size.height, 0, 0];
        let bytes: Vec<u8> = words.iter().flat_map(|word| word.to_le_bytes()).collect();
        queue.write_buffer(&self.target, 0, &bytes);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("genex-frames blit"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) },
                wgpu::BindGroupEntry { binding: 1, resource: self.target.as_entire_binding() },
            ],
        });
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("genex-frames blit") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("genex-frames blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: slot.view(),
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        let submission = queue.submit([encoder.finish()]);
        device
            .poll(wgpu::PollType::Wait { submission_index: Some(submission), timeout: Some(GPU_WAIT_TIMEOUT) })
            .map(|_| ())
            .map_err(|error| FramesError::new(FramesCode::GpuWaitFailed, error.to_string()))
    }
}
