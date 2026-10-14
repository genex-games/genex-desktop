//! Frustum culling. The compute pass (`shaders/cull.wgsl`) tests every opaque instance of every
//! batch against every active cull view (the camera, then each drawn shadow cascade, then each
//! shadowed spot) in one dispatch of `batches × views` workgroups, compacts the survivors in order
//! into the view's region of the visible list and writes the view's tightly packed
//! `draw_indexed_indirect` arguments. The CPU cull here is the same test in the same order: the
//! reference the GPU path is held to.
//!
//! The cull views uniform reserves [`MAX_VIEWS`] views (RQ3.0: the camera, four cascades, four
//! shadowed spots); a frame activates [`active_views`] of them, and only the active views get a
//! visible-list region and indirect arguments, so a reserved view costs 96 bytes of uniform.
//!
//! One workgroup walks one batch in chunks of 64, so a single large batch is serial in its chunks
//! (the timing row in tests/golden_part1.rs measures 10 000 instances in one batch).
//!
//! The HDR path draws camera views with reverse-Z (RQ1.1): [`frustum_planes_for`] takes the
//! reversed (and possibly infinite) projection and answers the same six inward planes, so the
//! compute and CPU culls keep one test.

use crate::compile::Compiled;
use glam::{Mat4, Vec4};
use wgpu::{BindGroupLayout, Buffer, ComputePipeline, Device};

use crate::error::RenderError;
use crate::layout::{GpuBatch, GpuInstance, MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS};

/// Invocations per cull workgroup (`WORKGROUP` in cull.wgsl).
pub const CULL_WORKGROUP: u32 = 64;

/// The active cull views of a frame drawing `cascades` sun cascades and `spots` shadowed spot
/// lights (each clamped to its reserve): the camera, then the cascades, then the spots.
pub const fn active_views(cascades: usize, spots: usize) -> u32 {
    let cascades = if cascades < MAX_CASCADES { cascades } else { MAX_CASCADES };
    let spots = if spots < MAX_SHADOWED_SPOTS { spots } else { MAX_SHADOWED_SPOTS };
    (1 + cascades + spots) as u32
}

/// The cull view of sun cascade `cascade`.
pub const fn cascade_view(cascade: usize) -> u32 {
    1 + cascade as u32
}

/// The cull view of shadowed spot `spot` in a frame drawing `cascades` cascades (after them).
pub const fn spot_view(cascades: usize, spot: usize) -> u32 {
    (1 + cascades + spot) as u32
}

const _: () = assert!(active_views(MAX_CASCADES, MAX_SHADOWED_SPOTS) as usize == MAX_VIEWS);

/// The CPU cull's result for one view, laid out as the compute pass writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CpuCull {
    /// One slot per opaque instance; each batch's survivors fill the start of its region, in order.
    pub visible: Vec<u32>,
    /// Survivors per batch.
    pub counts: Vec<u32>,
}

/// Inward frustum planes of `view_proj` (depth 0..1), normalized: left, right, bottom, top, near, far.
pub fn frustum_planes(view_proj: Mat4) -> [[f32; 4]; 6] {
    let (r0, r1, r2, r3) = (view_proj.row(0), view_proj.row(1), view_proj.row(2), view_proj.row(3));
    [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2].map(|p: Vec4| {
        let length = p.truncate().length();
        (p / length).to_array()
    })
}

/// A plane whose normal is shorter than this has no direction: the far plane of an infinite
/// projection (its row is `(0, 0, 0, near)`), which bounds nothing.
const DEGENERATE_PLANE: f32 = 1.0e-6;
/// The plane every point is inside of.
const ALWAYS_INSIDE: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// [`frustum_planes`] of a projection with standard (`reversed` false) or reversed Z, finite or
/// infinite: still left, right, bottom, top, near, far. Under reverse-Z the clip-space `z >= 0`
/// half-space is the far side and `z <= w` the near side, so the last two rows swap; an infinite
/// far plane (no direction) becomes a plane everything is inside of instead of a NaN plane that
/// would cull everything. The standard path keeps [`frustum_planes`] bit for bit.
pub fn frustum_planes_for(view_proj: Mat4, reversed: bool) -> [[f32; 4]; 6] {
    if !reversed {
        return frustum_planes(view_proj);
    }
    let (r0, r1, r2, r3) = (view_proj.row(0), view_proj.row(1), view_proj.row(2), view_proj.row(3));
    [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r3 - r2, r2].map(|p: Vec4| {
        let length = p.truncate().length();
        if length < DEGENERATE_PLANE { ALWAYS_INSIDE } else { (p / length).to_array() }
    })
}

/// The compute pass's sphere test, expression for expression.
pub fn in_frustum(planes: &[[f32; 4]; 6], bounds: [f32; 4]) -> bool {
    planes.iter().all(|p| p[0] * bounds[0] + p[1] * bounds[1] + p[2] * bounds[2] + p[3] >= -bounds[3])
}

/// The reference cull of `batches` over `instances` against one view's `planes`.
pub fn cpu_cull(planes: &[[f32; 4]; 6], batches: &[GpuBatch], instances: &[GpuInstance], rows: usize) -> CpuCull {
    let mut visible = vec![0; rows];
    let mut counts = Vec::with_capacity(batches.len());
    for batch in batches {
        let mut written = 0;
        for i in batch.first_instance..batch.first_instance + batch.instance_count {
            if in_frustum(planes, instances[i as usize].bounds) {
                visible[(batch.first_instance + written) as usize] = i;
                written += 1;
            }
        }
        counts.push(written);
    }
    CpuCull { visible, counts }
}

/// The cull pipeline and its bind group layout.
pub(crate) struct CullPass {
    layout: BindGroupLayout,
    pipeline: Compiled<ComputePipeline>,
}

/// What one cull dispatch reads and writes.
pub(crate) struct CullBuffers<'a> {
    pub views: &'a Buffer,
    pub instances: &'a Buffer,
    pub batches: &'a Buffer,
    pub visible: &'a Buffer,
    pub args: &'a Buffer,
}

impl CullPass {
    pub(crate) fn new(device: &Device) -> Result<CullPass, RenderError> {
        use crate::tables::{compute_storage, compute_uniform};
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cull"),
            entries: &[
                compute_uniform(0),
                compute_storage(1, true),
                compute_storage(2, true),
                compute_storage(3, false),
                compute_storage(4, false),
            ],
        });
        let module = crate::shaders::module(device, "cull", crate::shaders::CULL)?;
        let pipeline_layout = crate::tables::pipeline_layout(device, "cull", &[&layout]);
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("cull"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("cull"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(CullPass { layout, pipeline })
    }

    /// One workgroup per (batch, view).
    pub(crate) fn encode(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, buffers: &CullBuffers<'_>, batches: u32, views: u32) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cull"),
            layout: &self.layout,
            entries: &[
                crate::tables::entry(0, buffers.views),
                crate::tables::entry(1, buffers.instances),
                crate::tables::entry(2, buffers.batches),
                crate::tables::entry(3, buffers.visible),
                crate::tables::entry(4, buffers.args),
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("cull"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(batches, views, 1);
    }
}
