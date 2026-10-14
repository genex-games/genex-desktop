//! A Level-3 pass at custom-pass API v2, registered at `after-prepass`: a compute shader reads the
//! frame's prepass depth at the centre of the screen into a storage buffer of its own. Registering
//! there makes the renderer draw its depth/normal prepass on every preset and device.

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage, RenderInputs};

use crate::scene::World;

const PROBE_WGSL: &str = include_str!("../shaders/depth_probe.wgsl");
/// The custom-pass API the probe is written against (the v2 tables).
const PASS_API: u32 = 2;
/// Bytes of the probe's buffer: one depth.
const PROBE_BYTES: u64 = 4;

/// Register the probe.
pub fn wire(game: &mut genex::Game<World>) {
    game.gpu_pass("depth-probe", PassStage::AfterPrepass, DepthProbe::default());
}

/// The probe's pipeline and the bind group of its buffer.
#[derive(Default)]
pub struct DepthProbe {
    resources: Option<(gpu::ComputePipeline, gpu::BindGroup)>,
}

impl GpuPass<World> for DepthProbe {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = setup.create_shader("depth probe", PROBE_WGSL)?;
        let own = setup.create_bind_group_layout(&gpu::BindGroupLayoutDescriptor {
            label: Some("depth probe"),
            entries: &[gpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: gpu::ShaderStages::COMPUTE,
                ty: gpu::BindingType::Buffer {
                    ty: gpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let groups = [Some(setup.tables_layout()), Some(&own)];
        let layout = setup.create_pipeline_layout(&gpu::PipelineLayoutDescriptor {
            label: Some("depth probe"),
            bind_group_layouts: &groups,
            immediate_size: 0,
        });
        let pipeline = setup.create_compute_pipeline(&gpu::ComputePipelineDescriptor {
            label: Some("depth probe"),
            layout: Some(&layout),
            module: &module,
            entry_point: Some("cs_probe"),
            compilation_options: Default::default(),
            cache: None,
        });
        let buffer = setup.create_buffer(&gpu::BufferDescriptor {
            label: Some("depth probe"),
            size: PROBE_BYTES,
            usage: gpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })?;
        let group = setup.create_bind_group(&gpu::BindGroupDescriptor {
            label: Some("depth probe"),
            layout: &own,
            entries: &[gpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }],
        });
        self.resources = Some((pipeline, group));
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some((pipeline, group)) = &self.resources else { return };
        let tables = ctx.tables().clone();
        let Some(encoder) = ctx.encoder() else { return };
        let mut pass = encoder.begin_compute_pass(&gpu::ComputePassDescriptor { label: Some("depth probe"), timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &tables, &[]);
        pass.set_bind_group(1, group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }

    fn api(&self) -> u32 {
        PASS_API
    }

    fn inputs(&self) -> RenderInputs {
        RenderInputs::DEPTH
    }
}
