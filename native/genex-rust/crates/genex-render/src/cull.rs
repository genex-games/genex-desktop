//! Frustum culling. The compute pass (`shaders/cull.wgsl`) tests every opaque instance against
//! every active cull view (the camera, then each drawn shadow cascade, then each shadowed spot),
//! one invocation per (instance, view), compacts each batch's survivors in order into the view's
//! region of the visible list and writes the view's tightly packed `draw_indexed_indirect`
//! arguments. The CPU cull here is the same test in the same order: the reference the GPU path is
//! held to.
//!
//! Renderer pass 2 A.0 (LG-06): three dispatches of a deterministic ordered compaction without
//! atomics (the meshlet cull's): mark (each 256-row block's survivor bits and count), scan (each
//! view's block prefixes, then every batch's arguments from the prefixes at its ends) and scatter
//! (each survivor's slot: its prefix less its batch's first row's). Before it one workgroup walked
//! a batch serially in chunks of 64, so one 100k-instance batch took 3.3 ms against 0.04-0.16 ms
//! for the same instances over a hundred batches (M4 Max, tests/scatter.rs).
//!
//! The cull views uniform reserves [`MAX_VIEWS`] views (RQ3.0: the camera, four cascades, four
//! shadowed spots); a frame activates [`active_views`] of them, and only the active views get a
//! visible-list region and indirect arguments, so a reserved view costs 96 bytes of uniform.
//!
//! Levels of detail (game systems LOD-02, LOD-03): a level's batch keeps an instance by
//! [`crate::mesh::lod_row_keep`], the fade band measured from the instance's LOD row (binding 6,
//! [`crate::lod_rows::GpuLodRow`]: the sphere its levels are measured from and its bias). A fade
//! batch keeps the instances fading in or out of its level, and the scatter writes each of its
//! survivors' signed fade into the per-slot fade table (binding 7, parallel to the visible list,
//! `vec2(fade, grow)` per slot, [`crate::layout::INSTANCE_FADE_BYTES`]); no other slot is written.
//!
//! The HDR path draws camera views with reverse-Z (RQ1.1): [`frustum_planes_for`] takes the
//! reversed (and possibly infinite) projection and answers the same six inward planes, so the
//! compute and CPU culls keep one test.

use crate::compile::Compiled;
use glam::{Mat4, Vec4};
use wgpu::{BindGroupLayout, Buffer, ComputePipeline, Device};

use crate::error::RenderError;
use crate::layout::{GpuBatch, GpuInstance, INSTANCE_FADE_WHOLE, MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS};
use crate::lod_rows::{GpuLodRow, LOD_BIAS_DEFAULT};

/// Opaque rows per cull block: one workgroup's invocations (`GX_CULL_BLOCK` in cull.wgsl).
pub const CULL_BLOCK: u32 = 256;
/// Survivor-bit words per block.
const CULL_BLOCK_WORDS: u32 = CULL_BLOCK / 32;

/// The cull's blocks over `rows` opaque rows.
pub const fn cull_blocks(rows: u32) -> u32 {
    rows.div_ceil(CULL_BLOCK)
}

/// Scratch words one view's cull takes over `rows` opaque rows: every block's survivor bits, then
/// each block's prefix and the view's total.
pub const fn scratch_words_per_view(rows: u32) -> u64 {
    cull_blocks(rows) as u64 * (CULL_BLOCK_WORDS as u64 + 1) + 1
}

/// Scratch bytes of a frame of `views` active views over `rows` opaque rows.
pub const fn scratch_bytes(rows: u32, views: u32) -> u64 {
    scratch_words_per_view(rows) * views as u64 * 4
}

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

/// The cull group's binding of the per-slot fade table (`fades` in `shaders/cull.wgsl`, game
/// systems LOD-03).
pub const CULL_FADES_BINDING: u32 = 7;

/// The cull's first entry point: each block's survivor bits and count.
pub const CULL_MARK_ENTRY: &str = "cull_mark";
/// The second: each view's block prefixes and every batch's indirect arguments.
pub const CULL_SCAN_ENTRY: &str = "cull_scan";
/// The third: each survivor's slot in its batch's region of the visible list.
pub const CULL_SCATTER_ENTRY: &str = "cull_scatter";

/// The CPU cull's result for one view, laid out as the compute pass writes it.
#[derive(Clone, Debug, PartialEq)]
pub struct CpuCull {
    /// One slot per opaque instance (and per level batch's instance, A6.9); each batch's survivors
    /// (their instance rows) fill the start of its region, in order.
    pub visible: Vec<u32>,
    /// Survivors per batch.
    pub counts: Vec<u32>,
    /// The fade table, slot for slot with `visible` (game systems LOD-03): `[fade, grow]` for each
    /// survivor of a fade batch (the signed fade of [`crate::mesh::lod_row_keep`], grow 1); every
    /// other slot holds [`INSTANCE_FADE_WHOLE`] twice and is never written by the compute pass.
    pub fades: Vec<[f32; 2]>,
}

/// What the cull reads to choose levels (renderer pass 2 A6.9, game systems LOD-02 and LOD-03).
#[derive(Clone, Copy, Debug)]
pub struct CullLod<'a> {
    /// The frame's LOD view ([`crate::layout::GpuCullViews::lod`]): the camera position, w the
    /// pixels a world unit at distance 1 over the threshold (0: levels off).
    pub view: [f32; 4],
    /// The fade band (`beta` of [`crate::mesh::lod_band`]; 0 the hard switch).
    pub band: f32,
    /// The LOD rows, row for row with the opaque instance rows; a row past them measures from
    /// its bounds at the default bias.
    pub rows: &'a [GpuLodRow],
}

impl CullLod<'_> {
    /// The origin and bias of instance row `row` of world `bounds`.
    fn of(&self, row: usize, bounds: [f32; 4]) -> ([f32; 4], f32) {
        self.rows.get(row).map_or((bounds, LOD_BIAS_DEFAULT), |lod| (lod.origin, lod.bias))
    }
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

/// The reference cull of `batches` over `instances` against one view's `planes`, a level's batch
/// keeping only the instances `lod` gives its level, and a fade batch those fading in or out of
/// it, with their fades ([`crate::mesh::lod_row_keep`]; renderer pass 2 A6.9, game systems LOD-03).
pub fn cpu_cull(planes: &[[f32; 4]; 6], lod: &CullLod<'_>, batches: &[GpuBatch], instances: &[GpuInstance], slots: usize) -> CpuCull {
    let mut visible = vec![0; slots];
    let mut fades = vec![[INSTANCE_FADE_WHOLE; 2]; slots];
    let mut counts = Vec::with_capacity(batches.len());
    for batch in batches {
        let fade_batch = batch.lod[0] & crate::mesh::LOD_FADE_TAG != 0;
        let mut written = 0;
        for i in batch.first_row..batch.first_row + batch.instance_count {
            let bounds = instances[i as usize].bounds;
            let (origin, bias) = lod.of(i as usize, bounds);
            let kept = crate::mesh::lod_row_keep(batch.lod, bounds, origin, lod.view, bias, lod.band).filter(|_| in_frustum(planes, bounds));
            let Some(fade) = kept else { continue };
            let slot = (batch.first_instance + written) as usize;
            visible[slot] = i;
            if fade_batch {
                fades[slot] = [fade, INSTANCE_FADE_WHOLE];
            }
            written += 1;
        }
        counts.push(written);
    }
    CpuCull { visible, counts, fades }
}

/// The cull's three pipelines and their bind group layout.
pub(crate) struct CullPass {
    layout: BindGroupLayout,
    mark: Compiled<ComputePipeline>,
    scan: Compiled<ComputePipeline>,
    scatter: Compiled<ComputePipeline>,
}

/// What one cull dispatch reads and writes.
pub(crate) struct CullBuffers<'a> {
    pub views: &'a Buffer,
    pub instances: &'a Buffer,
    pub batches: &'a Buffer,
    pub visible: &'a Buffer,
    pub args: &'a Buffer,
    /// The survivor bits and block prefixes ([`scratch_bytes`]).
    pub scratch: &'a Buffer,
    /// The LOD rows (binding 6, game systems LOD-02), row for row with the opaque instance rows.
    pub lod_rows: &'a Buffer,
    /// The per-slot fade table (binding 7, game systems LOD-03): every view's region of
    /// `vec2<f32>` per visible-list slot.
    pub fades: &'a Buffer,
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
                compute_storage(5, false),
                compute_storage(crate::lod_rows::CULL_LOD_ROWS_BINDING, true),
                compute_storage(CULL_FADES_BINDING, false),
            ],
        });
        let module = crate::shaders::module(device, "cull", crate::shaders::CULL)?;
        let pipeline_layout = crate::tables::pipeline_layout(device, "cull", &[&layout]);
        let pipeline = |entry: &str| {
            crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(entry),
                // A8.6: every lane writes its scan slot first (`compile::WORKGROUP_AUDIT`).
                compilation_options: crate::compile::written_first(),
                cache: None,
            })
        };
        Ok(CullPass { mark: pipeline(CULL_MARK_ENTRY), scan: pipeline(CULL_SCAN_ENTRY), scatter: pipeline(CULL_SCATTER_ENTRY), layout })
    }

    /// The three dispatches over `rows` opaque rows and `views` active views, in one pass;
    /// `timestamps` around it (a cost row).
    pub(crate) fn encode(
        &self,
        device: &Device,
        encoder: &mut wgpu::CommandEncoder,
        buffers: &CullBuffers<'_>,
        rows: u32,
        views: u32,
        timestamps: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cull"),
            layout: &self.layout,
            entries: &[
                crate::tables::entry(0, buffers.views),
                crate::tables::entry(1, buffers.instances),
                crate::tables::entry(2, buffers.batches),
                crate::tables::entry(3, buffers.visible),
                crate::tables::entry(4, buffers.args),
                crate::tables::entry(5, buffers.scratch),
                crate::tables::entry(crate::lod_rows::CULL_LOD_ROWS_BINDING, buffers.lod_rows),
                crate::tables::entry(CULL_FADES_BINDING, buffers.fades),
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("cull"), timestamp_writes: timestamps });
        let blocks = cull_blocks(rows).max(1);
        pass.set_bind_group(0, &group, &[]);
        // Each dispatch is its own usage scope: the scan reads what the mark wrote, the scatter
        // what the scan wrote.
        pass.set_pipeline(&self.mark);
        pass.dispatch_workgroups(blocks, views, 1);
        pass.set_pipeline(&self.scan);
        pass.dispatch_workgroups(1, views, 1);
        pass.set_pipeline(&self.scatter);
        pass.dispatch_workgroups(blocks, views, 1);
    }
}
