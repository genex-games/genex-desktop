//! The GPU-hang fixture (M3.1): a game whose one custom post pass spins every pixel for ~4 billion
//! iterations, so its first frame never finishes in time. Served by the studio (`genex::install`,
//! the facade's `studio` feature), its `capture` waits on that frame and misses the deadline: the
//! host takes it for a GPU hang, kills the game's group and ends the run `gpu-hang`
//! (`tests/conformance/rust-lifecycle-real.test.ts`). Never run it outside that row.

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
use genex::prelude::*;

const HANG_WGSL: &str = include_str!("../shaders/hang.wgsl");

/// Nothing to simulate: the frame alone is the point.
#[derive(Clone, Debug, Default, PartialEq)]
struct World;

/// The looping pass, drawn over the finished world target.
#[derive(Default)]
struct Hang {
    resources: Option<(gpu::Buffer, gpu::BindGroup, gpu::RenderPipeline)>,
}

impl GpuPass<World> for Hang {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = setup.create_shader("hang", HANG_WGSL)?;
        let spin = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("hang"),
            size: 16,
            usage: gpu::BufferUsages::UNIFORM | gpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })?;
        let layout = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor {
            label: Some("hang"),
            entries: &[gpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: gpu::ShaderStages::FRAGMENT,
                ty: gpu::BindingType::Buffer {
                    ty: gpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let group = setup.create_bind_group(&gpu::BindGroupDescriptor {
            label: Some("hang"),
            layout: &layout,
            entries: &[gpu::BindGroupEntry { binding: 0, resource: spin.as_entire_binding() }],
        });
        let pipeline_layout = setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor {
            label: Some("hang"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let targets =
            [Some(gpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: gpu::ColorWrites::ALL })];
        let pipeline = setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("hang"),
            layout: Some(&pipeline_layout),
            vertex: gpu::VertexState {
                module: &module,
                entry_point: Some("vs_hang"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: gpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: gpu::MultisampleState::default(),
            fragment: Some(gpu::FragmentState {
                module: &module,
                entry_point: Some("fs_hang"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        });
        self.resources = Some((spin, group, pipeline));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some((spin, group, pipeline)) = &self.resources else { return };
        let count: Vec<u8> = [u32::MAX, 0, 0, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
        let _ = ctx.write_buffer(spin, 0, &count);
        let Some(target) = ctx.world_view().cloned() else { return };
        let Some(encoder) = ctx.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&gpu::RenderPassDescriptor {
            label: Some("hang"),
            color_attachments: &[Some(gpu::RenderPassColorAttachment {
                view: &target,
                depth_slice: None,
                resolve_target: None,
                ops: gpu::Operations { load: gpu::LoadOp::Load, store: gpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn main() {
    let mut game = Game::new(World).title("GPU hang").world_size(64, 64);
    game.gpu_pass("hang", PassStage::Post, Hang::default());
    genex::install(game);
}
