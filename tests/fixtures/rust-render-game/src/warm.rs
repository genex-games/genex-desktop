//! A Level-3 pass at custom-pass API v2, registered at `post-hdr`: it multiplies the HDR scene by a
//! warm tint before the tonemap (a multiply blend over the scene the stage hands it), so an ejected
//! fork keeps the stage the renderer runs before its curve.

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};

use crate::scene::World;

const WARM_WGSL: &str = include_str!("../shaders/warm.wgsl");
/// The custom-pass API the pass is written against (the v2 tables).
const PASS_API: u32 = 2;

/// The scene times the fragment's colour: a tint that keeps alpha.
const MULTIPLY: gpu::BlendState = gpu::BlendState {
    color: gpu::BlendComponent { src_factor: gpu::BlendFactor::Dst, dst_factor: gpu::BlendFactor::Zero, operation: gpu::BlendOperation::Add },
    alpha: gpu::BlendComponent { src_factor: gpu::BlendFactor::Zero, dst_factor: gpu::BlendFactor::One, operation: gpu::BlendOperation::Add },
};

/// Register the pass.
pub fn wire(game: &mut genex::Game<World>) {
    game.gpu_pass("warm", PassStage::PostHdr, Warm::default());
}

/// The pass's pipeline.
#[derive(Default)]
pub struct Warm {
    pipeline: Option<gpu::RenderPipeline>,
}

impl GpuPass<World> for Warm {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = setup.create_shader("warm", WARM_WGSL)?;
        let groups = [Some(setup.tables_layout())];
        let layout = setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor { label: Some("warm"), bind_group_layouts: &groups, immediate_size: 0 });
        let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: Some(MULTIPLY), write_mask: gpu::ColorWrites::COLOR })];
        let pipeline = setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("warm"),
            layout: Some(&layout),
            vertex: gpu::VertexState { module: &module, entry_point: Some("vs_warm"), compilation_options: Default::default(), buffers: &[] },
            primitive: gpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: setup.world_multisample(),
            fragment: Some(gpu::FragmentState { module: &module, entry_point: Some("fs_warm"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        self.pipeline = Some(pipeline);
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some(pipeline) = &self.pipeline else { return };
        let Some(view) = ctx.world_view().cloned() else { return };
        let tables = ctx.tables().clone();
        let Some(encoder) = ctx.encoder() else { return };
        let mut pass = encoder.begin_render_pass(&gpu::RenderPassDescriptor {
            label: Some("warm"),
            color_attachments: &[Some(gpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: gpu::Operations { load: gpu::LoadOp::Load, store: gpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.draw(0..3, 0..1);
    }

    fn api(&self) -> u32 {
        PASS_API
    }
}
