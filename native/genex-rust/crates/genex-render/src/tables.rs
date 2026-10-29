//! The storage-buffer tables a frame draws from and the bytes it writes into them. Every table
//! grows to the next power of two when a frame needs more and is never shrunk, except the skinned
//! output and its slots, which grow by [`skinned_growth`] (game systems AN-16b: 48 B per skinned
//! vertex per instance, twice with motion vectors, is too much to round up); every byte a frame
//! writes is charged against the per-frame upload budget before the first write, so a refused
//! frame leaves the GPU untouched (the world target keeps the previous frame).
//!
//! Visible list: one region of `visible_slots` per cull view (the opaque rows, and each level
//! batch's slots, renderer pass 2 A6.9), then one row per transparent
//! draw. Indirect arguments: `batches` per view, tightly packed. Pass views: one 256-byte dynamic
//! uniform per cull view, then one per transparent draw. Previous models (RQ5): one row per
//! instance row, at the same index, filled only while motion vectors are drawn.
//!
//! Uploads (renderer pass 2, RC-08): graph node 1's writes come from one [`UploadArena`], whose
//! mapped staging chunks are kept and reused, recorded as copies at the head of the frame's own
//! command encoder, ahead of everything the frame records after node 1 (every submission of the
//! frame's work goes through that encoder, which is submitted before any other node's own).
//! `queue.write_buffer` made a staging buffer per call in wgpu-core and freed it after the GPU used
//! it (16 a frame on a lit scene; 0.34 ms of CPU a frame against 0.08 ms for a 3 MB frame of 17
//! writes on an M4 Max). G0 (2026-10-15): submitted as a command buffer of their own ahead of the
//! frame's, the copies cost the features-off frame 0.025-0.045 ms of GPU time (bench-outdoor and
//! stress-forest at 1080p, median of 5 interleaved runs against `queue.write_buffer`'s 0.574 and
//! 0.903 ms), which `queue.write_buffer` puts in the frame's own submission.

use wgpu::{BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, BufferBindingType, BufferUsages, Device, ShaderStages};

use crate::caps::{UploadBudget, check_buffer};
use crate::cull::CpuCull;
use crate::error::RenderError;
use crate::layout::{
    DrawIndexedArgs, GpuCullViews, GpuDrawnMeshlet, GpuFrame, GpuMeshVertex, GpuMeshlet, GpuMeshletInstance, GpuPassView, GpuPrevModel, MESHLET_DRAW_BINDINGS,
};
use crate::scene::FramePlan;

/// Stride of the per-pass dynamic uniform: WebGPU core's `min_uniform_buffer_offset_alignment`.
pub const PASS_VIEW_STRIDE: u64 = 256;
/// Bytes of one indirect draw's arguments.
pub const ARGS_STRIDE: u64 = size_of::<DrawIndexedArgs>() as u64;
/// Bytes of one mesh vertex.
pub const VERTEX_STRIDE: u64 = size_of::<GpuMeshVertex>() as u64;

/// Bytes of one meshlet-table row (R2).
pub const MESHLET_STRIDE: u64 = size_of::<GpuMeshlet>() as u64;
/// Bytes of one meshlet-instance row (R2).
pub const MESHLET_INSTANCE_STRIDE: u64 = size_of::<GpuMeshletInstance>() as u64;
/// Bytes of one drawn-meshlet slot (R2).
pub const DRAWN_MESHLET_STRIDE: u64 = size_of::<GpuDrawnMeshlet>() as u64;
/// Bytes of one compacted index (`u32`, drawn with `IndexFormat::Uint32`).
pub const MESHLET_INDEX_STRIDE: u64 = 4;
/// Bytes of one previous-model row (RQ5): the table is parallel to the instance table.
pub const PREV_MODEL_STRIDE: u64 = size_of::<GpuPrevModel>() as u64;

/// The meshlet draw group's layout (`layout::MESHLET_DRAW_GROUP`, R2): every binding of
/// [`MESHLET_DRAW_BINDINGS`] as read-only storage visible to the vertex stage (vertex pulling).
/// The draw's pipeline layout is the forward frame group, the pass view and this group; WebGPU
/// counts every storage binding a stage can see across them, so the vertex stage sees 7 of core's
/// 8 and this group must not become visible to the fragment stage (tests/layout.rs holds both).
pub fn meshlet_draw_layout_entries() -> Vec<BindGroupLayoutEntry> {
    MESHLET_DRAW_BINDINGS.iter().map(|(binding, _)| storage(*binding, true, ShaderStages::VERTEX)).collect()
}

/// How a frame decides which instances to draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CullPath {
    /// Compute frustum cull writing indirect draw arguments (the V1 path).
    Gpu,
    /// CPU frustum cull and direct draws (the reference).
    Cpu,
}

pub(crate) fn storage(binding: u32, read_only: bool, visibility: ShaderStages) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility,
        ty: BindingType::Buffer { ty: BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
        count: None,
    }
}

pub(crate) fn uniform(binding: u32, dynamic: bool, visibility: ShaderStages) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility,
        ty: BindingType::Buffer { ty: BufferBindingType::Uniform, has_dynamic_offset: dynamic, min_binding_size: None },
        count: None,
    }
}

pub(crate) fn compute_storage(binding: u32, read_only: bool) -> BindGroupLayoutEntry {
    storage(binding, read_only, ShaderStages::COMPUTE)
}

pub(crate) fn compute_uniform(binding: u32) -> BindGroupLayoutEntry {
    uniform(binding, false, ShaderStages::COMPUTE)
}

pub(crate) fn pipeline_layout(device: &Device, label: &str, groups: &[&BindGroupLayout]) -> wgpu::PipelineLayout {
    let groups: Vec<Option<&BindGroupLayout>> = groups.iter().map(|g| Some(*g)).collect();
    device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &groups, immediate_size: 0 })
}

pub(crate) fn entry(binding: u32, buffer: &Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: buffer.as_entire_binding() }
}

/// A buffer checked against [`crate::BUFFER_MAX_BYTES`].
pub(crate) fn buffer(device: &Device, label: &str, size: u64, usage: BufferUsages) -> Result<Buffer, RenderError> {
    check_buffer(size)?;
    Ok(device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage, mapped_at_creation: false }))
}

/// The upload arena's staging chunk: writes smaller than this share chunks, a larger one gets a
/// chunk of its own size (kept and reused by the next frame that writes as much).
const UPLOAD_CHUNK_BYTES: u64 = 1 << 20;

/// One write a frame uploads: `bytes` into `target` at `offset` (both multiples of 4, as every
/// table row and offset is).
pub(crate) type UploadWrite<'a> = (&'a Buffer, u64, &'a [u8]);

/// The per-frame upload arena (RC-08): [`wgpu::util::StagingBelt`]'s mapped chunks, reused once
/// the GPU has copied out of them. Its chunks stay allocated (at most the upload budget per frame
/// in flight).
pub(crate) struct UploadArena {
    belt: wgpu::util::StagingBelt,
}

impl UploadArena {
    pub(crate) fn new(device: &Device) -> UploadArena {
        UploadArena { belt: wgpu::util::StagingBelt::new(device.clone(), UPLOAD_CHUNK_BYTES) }
    }

    /// Record `writes` (empty ones skipped) as copies from the arena into `encoder` (the frame's
    /// own, before anything that reads them); its chunks come back once that encoder is submitted.
    /// Nothing is recorded when every write is empty.
    pub(crate) fn upload(&mut self, encoder: &mut wgpu::CommandEncoder, writes: &[UploadWrite<'_>]) {
        if writes.iter().all(|(_, _, bytes)| bytes.is_empty()) {
            return;
        }
        for (target, offset, bytes) in writes {
            let Some(size) = wgpu::BufferSize::new(copy_size(bytes.len())) else { continue };
            let mut view = self.belt.write_buffer(encoder, target, *offset, size);
            view.slice(..bytes.len()).copy_from_slice(bytes);
            let pad = view.len() - bytes.len();
            view.slice(bytes.len()..).copy_from_slice(&[0; 4][..pad]);
        }
        self.belt.finish_and_recall_on_submit(encoder);
    }
}

/// `len` bytes rounded up to wgpu's copy alignment (4).
fn copy_size(len: usize) -> u64 {
    (len as u64).next_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT)
}

/// The smallest table: one row of the largest table struct (a `GxMaterialExt`, 272 bytes) fits,
/// so an empty table still binds where a shader expects at least one element.
const TABLE_MIN_BYTES: u64 = 512;
const _: () = assert!(TABLE_MIN_BYTES >= std::mem::size_of::<crate::abi::GxMaterialExt>() as u64);

/// `bytes` rounded up to a multiple of 16 (wgpu's copy alignment), at least [`TABLE_MIN_BYTES`].
pub(crate) fn aligned(bytes: u64) -> u64 {
    bytes.max(TABLE_MIN_BYTES).div_ceil(16) * 16
}

/// The granule the skinned tables grow in (AN-16b).
pub const SKINNED_GROWTH_GRANULE_BYTES: u64 = 64 * 1024;
/// How much a skinned table grows past what it held when a frame needs more (AN-16b): a quarter.
const SKINNED_GROWTH_NUM: u64 = 5;
const SKINNED_GROWTH_DEN: u64 = 4;

/// The size a skinned table (the skinned output, its slots, last frame's copy) takes when it
/// holds `held` bytes and a frame needs `need` (game systems AN-16b): `need` itself the first
/// time, else at least 1.25 times what it held, rounded up to [`SKINNED_GROWTH_GRANULE_BYTES`]
/// (below one granule, to the next power of two, as every other table) and never past
/// [`crate::BUFFER_MAX_BYTES`] when `need` fits under it. A table of 48 MB of skinned vertices
/// takes 48 MB, not the next power of two's 64.
pub fn skinned_growth(held: u64, need: u64) -> u64 {
    let grown = if held == 0 { need } else { need.max(held.saturating_mul(SKINNED_GROWTH_NUM) / SKINNED_GROWTH_DEN) };
    if grown < SKINNED_GROWTH_GRANULE_BYTES {
        return grown.next_power_of_two();
    }
    let rounded = grown.div_ceil(SKINNED_GROWTH_GRANULE_BYTES).saturating_mul(SKINNED_GROWTH_GRANULE_BYTES);
    if need <= crate::BUFFER_MAX_BYTES { rounded.min(crate::BUFFER_MAX_BYTES) } else { rounded }
}

/// How a table grows when a frame needs more than it holds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Growth {
    /// To the next power of two.
    PowerOfTwo,
    /// By [`skinned_growth`].
    Skinned,
}

/// One growable GPU table.
pub(crate) struct Table {
    label: &'static str,
    usage: BufferUsages,
    buffer: Option<Buffer>,
    growth: Growth,
    /// How many buffers it has had: a new one holds nothing of the old one's.
    generation: u64,
}

impl Table {
    const fn new(label: &'static str, usage: BufferUsages) -> Table {
        Table { label, usage, buffer: None, growth: Growth::PowerOfTwo, generation: 0 }
    }

    const fn skinned(label: &'static str, usage: BufferUsages) -> Table {
        Table { label, usage, buffer: None, growth: Growth::Skinned, generation: 0 }
    }

    /// Make room for `bytes`; a grown table is a new, empty buffer.
    fn ensure(&mut self, device: &Device, bytes: u64) -> Result<(), RenderError> {
        let need = aligned(bytes);
        if self.buffer.as_ref().is_some_and(|b| b.size() >= need) {
            return Ok(());
        }
        let size = match self.growth {
            Growth::PowerOfTwo => need.next_power_of_two(),
            Growth::Skinned => skinned_growth(self.capacity(), need),
        };
        self.buffer = Some(buffer(device, self.label, size, self.usage)?);
        self.generation += 1;
        Ok(())
    }

    /// How many buffers the table has had (a changed count: what it held is gone).
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Whether the table holds `bytes` without growing (a grown table loses what it held).
    pub(crate) fn holds(&self, bytes: u64) -> bool {
        self.buffer.as_ref().is_some_and(|b| b.size() >= aligned(bytes))
    }

    /// The table's label and the bytes its buffer holds (None before it is first ensured).
    pub(crate) fn held(&self) -> Option<(&'static str, u64)> {
        self.buffer.as_ref().map(|buffer| (self.label, buffer.size()))
    }

    /// The bytes its buffer holds (0 before it is first ensured).
    fn capacity(&self) -> u64 {
        self.buffer.as_ref().map_or(0, Buffer::size)
    }

    /// The buffer (present once [`Table::ensure`] ran).
    pub(crate) fn get(&self) -> &Buffer {
        // Every table is ensured before a frame binds it; `expect` would be a renderer bug.
        self.buffer.as_ref().unwrap_or_else(|| unreachable!("table {} used before ensure", self.label))
    }
}

/// The per-frame tables.
pub(crate) struct Tables {
    pub instances: Table,
    pub materials: Table,
    pub lights: Table,
    pub batches: Table,
    pub slot_base: Table,
    pub visible: Table,
    pub args: Table,
    /// The instance cull's survivor bits and block prefixes (LG-06; `cull::scratch_bytes`).
    pub cull_scratch: Table,
    pub pass_views: Table,
    pub lines: Table,
    pub joints: Table,
    pub skin_jobs: Table,
    pub skinned: Table,
    pub skinned_slots: Table,
    /// Last frame's model of each instance row (RQ5 motion vectors; empty until they land).
    pub prev_models: Table,
    /// Each local light's extension row, then the shadowed spots' matrices (`light_ext`, RQ6; on
    /// the legacy loop each light-table row's extension).
    pub light_ext: Table,
    /// The light bins (`light_bins`, RQ6; pass 2 A.0 LG-16): the header and every clusterable
    /// kind's z-bins (a zero header bins no light), then the per-tile masks from
    /// `cluster::LIGHT_TILES_OFFSET_WORDS` (built by graph node 4 on a binned frame).
    pub light_bins: Table,
    /// Each material row's extension (`material_ext`, RQ6.3: its emission), parallel to `materials`.
    pub material_ext: Table,
    /// The LOD rows (game systems LOD-02, cull binding 6), parallel to the opaque instance rows:
    /// sized by the instance table's room and replaced exactly when it is, so a retained group's
    /// held instance rows mean its LOD rows are held too.
    pub lod_rows: Table,
    /// The per-slot fade table (game systems LOD-03, cull binding 7): `vec2<f32>` per visible-list
    /// slot of every view, written by the cull for fade-batch survivors.
    pub instance_fade: Table,
    /// The frame's far rules (game systems LOD-18, cull binding 8): a uniform of
    /// [`crate::lod_rows::FAR_RULES_MAX`] rules, the first `plan.far_rules` written.
    pub far_rules: Table,
}

impl Tables {
    pub(crate) fn new() -> Tables {
        let storage = BufferUsages::STORAGE | BufferUsages::COPY_DST;
        Tables {
            instances: Table::new("instances", storage),
            materials: Table::new("materials", storage),
            lights: Table::new("lights", storage),
            batches: Table::new("batches", storage),
            slot_base: Table::new("slot base", storage),
            // COPY_SRC: the cull rows read a view's region back (`Renderer::read_view_visible`).
            visible: Table::new("visible", storage | BufferUsages::COPY_SRC),
            args: Table::new("indirect args", storage | BufferUsages::INDIRECT | BufferUsages::COPY_SRC),
            cull_scratch: Table::new("cull scratch", BufferUsages::STORAGE),
            pass_views: Table::new("pass views", BufferUsages::UNIFORM | BufferUsages::COPY_DST),
            lines: Table::new("lines", BufferUsages::VERTEX | BufferUsages::COPY_DST),
            joints: Table::new("joints", storage),
            skin_jobs: Table::new("skin jobs", storage),
            skinned: Table::skinned("skinned vertices", BufferUsages::STORAGE | BufferUsages::VERTEX | BufferUsages::COPY_SRC),
            skinned_slots: Table::skinned("skinned slots", BufferUsages::STORAGE | BufferUsages::VERTEX),
            prev_models: Table::new("previous models", storage),
            light_ext: Table::new("light extensions", storage),
            light_bins: Table::new("light bins", storage),
            material_ext: Table::new("material extensions", storage),
            lod_rows: Table::new("lod rows", storage),
            // COPY_SRC: the fade rows read a view's region back (`Renderer::read_view_fades`).
            instance_fade: Table::new("instance fade", storage | BufferUsages::COPY_SRC),
            far_rules: Table::new("far rules", BufferUsages::UNIFORM | BufferUsages::COPY_DST),
        }
    }

    /// Every ensured table's label and held bytes (LG-13: the ledger's frame-table entries).
    pub(crate) fn held(&self) -> Vec<(&'static str, u64)> {
        [
            &self.instances,
            &self.materials,
            &self.lights,
            &self.batches,
            &self.slot_base,
            &self.visible,
            &self.args,
            &self.cull_scratch,
            &self.pass_views,
            &self.lines,
            &self.joints,
            &self.skin_jobs,
            &self.skinned,
            &self.skinned_slots,
            &self.prev_models,
            &self.light_ext,
            &self.light_bins,
            &self.material_ext,
            &self.lod_rows,
            &self.instance_fade,
            &self.far_rules,
        ]
        .into_iter()
        .filter_map(Table::held)
        .collect()
    }

    /// Make room for `uploads` (and the GPU-written tables of `plan`).
    pub(crate) fn ensure(&mut self, device: &Device, plan: &FramePlan, uploads: &Uploads) -> Result<(), RenderError> {
        let visible_rows = u64::from(plan.views) * u64::from(plan.visible_slots) + plan.transparent.len() as u64;
        // The LOD table follows the instance table's room (LOD-02): a new instance table is a new
        // LOD table, and the LOD table never grows on its own.
        if !self.instances.holds(bytes_of_rows(&plan.instances)) {
            self.lod_rows.buffer = None;
        }
        let sizes = [
            (&mut self.instances, bytes_of_rows(&plan.instances)),
            (&mut self.materials, bytes_of_rows(&plan.materials)),
            (&mut self.material_ext, bytes_of_rows(&plan.material_ext)),
            (&mut self.lights, bytes_of_rows(&plan.lights)),
            (&mut self.batches, bytes_of_rows(&plan.batches)),
            (&mut self.slot_base, bytes_of_rows(&plan.slot_base) + bytes_of_rows(&plan.fade_slots)),
            (&mut self.visible, visible_rows * 4),
            (&mut self.args, u64::from(plan.views) * plan.batches.len() as u64 * ARGS_STRIDE),
            (&mut self.cull_scratch, crate::cull::scratch_bytes(plan.visible_slots, plan.views)),
            (&mut self.pass_views, uploads.pass_views.len() as u64),
            (&mut self.lines, bytes_of_rows(&plan.lines)),
            (&mut self.joints, bytes_of_rows(&plan.joints)),
            (&mut self.skin_jobs, bytes_of_rows(&plan.skin_jobs)),
            (&mut self.skinned, u64::from(plan.skinned_vertices) * VERTEX_STRIDE),
            (&mut self.skinned_slots, u64::from(plan.skinned_vertices) * 4),
            (&mut self.prev_models, std::mem::size_of_val(uploads.prev_models.as_slice()) as u64),
            // The RQ6 tables bind from the first frame (forward frame bindings 20, 21 and 23); the
            // bin table holds masks only on a binned frame (RQ6.2), else a zero bin header.
            (&mut self.light_ext, uploads.light_ext.len() as u64),
            (&mut self.light_bins, light_bin_bytes(plan, uploads)),
            (&mut self.instance_fade, u64::from(plan.views) * fade_slots(plan) * crate::layout::INSTANCE_FADE_BYTES),
            (&mut self.far_rules, crate::lod_rows::FAR_RULES_BYTES),
        ];
        for (table, bytes) in sizes {
            table.ensure(device, bytes)?;
        }
        let instance_room = self.instances.capacity() / size_of::<crate::layout::GpuInstance>() as u64;
        self.lod_rows.ensure(device, instance_room * crate::lod_rows::LOD_ROW_BYTES)?;
        Ok(())
    }
}

/// What one frame writes to the GPU, charged against the upload budget before anything is written.
pub(crate) struct Uploads {
    /// The binned path's extension rows, tile masks and bins (RQ6.2), the last two written into
    /// `light_bins` (masks at the tiles' offset, header and z-bins at 0). Graph node 4 builds the
    /// masks and bins on the GPU (RQ6.7), so the CPU writes no masks and a zero bin header, which
    /// node 4 overwrites; a frame that bins nothing keeps the zero header and loops the legacy table.
    pub light_ext: Vec<u8>,
    pub light_tiles: Vec<u8>,
    pub light_zbins: Vec<u8>,
    pub frame: Vec<u8>,
    pub cull_views: Vec<u8>,
    pub pass_views: Vec<u8>,
    /// The previous-model rows (RQ5; empty while motion vectors are not drawn), moved out of the
    /// plan rather than copied (bench-city's 64k instances hold 5 MB of them).
    pub prev_models: Vec<crate::layout::GpuPrevModel>,
    /// The CPU path's visible list (every view's region, then the transparent rows), or only the
    /// transparent rows (at their offset) on the GPU path.
    pub visible: Vec<u8>,
    pub visible_offset: u64,
    pub cpu_culls: Vec<CpuCull>,
    /// The instance-table rows this frame writes (renderer pass 2 A.0b): every row, less the
    /// retained groups' rows the table already holds as they were ([`instance_upload_ranges`]).
    pub instance_rows: Vec<std::ops::Range<usize>>,
    /// The LOD rows this frame writes (game systems LOD-02): the instance rows written, clipped
    /// to the opaque rows ([`crate::lod_rows::lod_row_upload_ranges`]).
    pub lod_rows: Vec<std::ops::Range<usize>>,
    /// The CPU path's fade table (every view's region; LOD-03), empty on the GPU path or without
    /// fade batches.
    pub fades: Vec<u8>,
    /// The frame's far rules (LOD-18), empty without any.
    pub far_rules: Vec<u8>,
}

/// The instance-table rows a frame of `rows` rows whose retained groups lie at `spans` writes when
/// the table holds `held`, the spans of the last upload into it (None: a new or grown table, or
/// none held): every row but each held span's unchanged rows (renderer pass 2 A.0b, dirty-range
/// uploads). Ascending, disjoint, non-empty.
pub fn instance_upload_ranges(rows: usize, spans: &[crate::retained::RetainedSpan], held: Option<&[crate::retained::RetainedSpan]>) -> Vec<std::ops::Range<usize>> {
    let every_row = std::iter::once(0..rows).filter(|all| !all.is_empty());
    let Some(held) = held else { return every_row.collect() };
    // Looked up by group id (a sorted list: no hashing order anywhere near the frame).
    let mut by_group: Vec<(u64, &crate::retained::RetainedSpan)> = held.iter().map(|span| (span.group.id(), span)).collect();
    by_group.sort_by_key(|(id, _)| *id);
    let last_of = |id: u64| by_group.binary_search_by_key(&id, |(held, _)| *held).ok().map(|at| by_group[at].1);
    // The kept (not written) row ranges, ascending: spans are laid out in row order.
    let mut kept: Vec<std::ops::Range<usize>> = Vec::new();
    for span in spans {
        let Some(last) = last_of(span.group.id()) else { continue };
        let changed = span.changed_since(last);
        let first = span.first_row as usize;
        let end = first + span.rows as usize;
        let (changed_start, changed_end) = (first + changed.start as usize, first + changed.end as usize);
        let pieces = if changed.is_empty() { [first..end, end..end] } else { [first..changed_start, changed_end..end] };
        kept.extend(pieces.into_iter().filter(|piece| !piece.is_empty() && piece.end <= rows));
    }
    kept.sort_by_key(|range| range.start);
    let mut written = Vec::new();
    let mut at = 0;
    for range in kept {
        if range.start > at {
            written.push(at..range.start);
        }
        at = at.max(range.end);
    }
    if at < rows {
        written.push(at..rows);
    }
    written
}

/// The plan's own rows as the tables hold them, in [`Uploads::write`]'s order: written from the
/// plan, never copied into a frame's uploads first (bench-outdoor's 12k instance rows are 2 MB a
/// frame; the features-off path's CPU time, pass-1 fix).
fn plan_rows(plan: &FramePlan) -> [&[u8]; 9] {
    [
        bytemuck::cast_slice(&plan.instances),
        bytemuck::cast_slice(&plan.materials),
        bytemuck::cast_slice(&plan.material_ext),
        bytemuck::cast_slice(&plan.lights),
        bytemuck::cast_slice(&plan.batches),
        bytemuck::cast_slice(&plan.slot_base),
        bytemuck::cast_slice(&plan.lines),
        bytemuck::cast_slice(&plan.joints),
        bytemuck::cast_slice(&plan.skin_jobs),
    ]
}

/// The bytes a table of `rows` takes.
fn bytes_of_rows<T>(rows: &[T]) -> u64 {
    std::mem::size_of_val(rows) as u64
}

/// The tile masks the CPU writes: none once graph node 4 builds them on the GPU
/// (`cluster::LANDED`), else the binned frame's CPU reference.
fn cpu_light_tiles(plan: &FramePlan) -> Vec<u8> {
    match plan.binned.as_ref() {
        Some(binned) if !crate::cluster::LANDED => bytemuck::cast_slice(&binned.bins.reference_masks()).to_vec(),
        _ => Vec::new(),
    }
}

/// The z-bin table the CPU writes: a zero header (no light binned; on the legacy loop with
/// [`crate::cluster::LEGACY_SPOTS_WORD`] set when its table holds a spot) unless the CPU reference
/// stands in for graph node 4. Node 4 overwrites the header and bins on the GPU after this write,
/// so a frame whose build is refused shades no local light rather than last frame's bins.
fn cpu_light_zbins(plan: &FramePlan) -> Vec<u8> {
    match plan.binned.as_ref() {
        Some(binned) if !crate::cluster::LANDED => bytemuck::cast_slice(&binned.bins.reference_zbins()).to_vec(),
        Some(_) => vec![0; crate::cluster::zbin_bytes() as usize],
        None => {
            let mut words = vec![0u32; crate::cluster::zbin_bytes() as usize / 4];
            let spots = plan.legacy_ext.iter().any(|ext| crate::lights::kind_of(ext) == crate::lights::LightKind::Spot);
            words[crate::cluster::LEGACY_SPOTS_WORD] = u32::from(spots);
            bytemuck::cast_slice(&words).to_vec()
        }
    }
}

/// Where the masks start in `light_bins`, in bytes.
const LIGHT_TILES_OFFSET_BYTES: u64 = crate::cluster::LIGHT_TILES_OFFSET_WORDS as u64 * 4;

/// The bytes `light_bins` needs: the header and z-bins, then the binned frame's masks (written by
/// node 4 or the CPU) from [`LIGHT_TILES_OFFSET_BYTES`]; at least one mask word, so the v2 map's
/// `light_tiles` slice is never empty.
fn light_bin_bytes(plan: &FramePlan, uploads: &Uploads) -> u64 {
    let masks = plan.binned.as_ref().map_or(0, |binned| binned.bins.grid.mask_bytes()).max(uploads.light_tiles.len() as u64);
    LIGHT_TILES_OFFSET_BYTES + masks.max(4)
}

/// The v2 map's two slices of `light_bins` (LG-16): (`light_zbins`, `light_tiles`).
pub(crate) fn light_bin_slices(bins: &Buffer) -> (wgpu::BufferBinding<'_>, wgpu::BufferBinding<'_>) {
    let zbins = wgpu::BufferBinding { buffer: bins, offset: 0, size: wgpu::BufferSize::new(crate::cluster::zbin_bytes()) };
    let tiles = wgpu::BufferBinding { buffer: bins, offset: LIGHT_TILES_OFFSET_BYTES, size: None };
    (zbins, tiles)
}

/// The pass-view entry of view `view`'s rows for draw variant `variant` (P2-0.12): the plain
/// variant's is the view's own entry; the others follow the transparent draws' entries, one block
/// of the plan's views per variant after plain, present only when the plan draws a variant.
pub fn variant_pass_entry(plan: &FramePlan, view: u32, variant: usize) -> u64 {
    if variant == 0 {
        return u64::from(view);
    }
    u64::from(plan.views) + plan.transparent.len() as u64 + (variant as u64 - 1) * u64::from(plan.views) + u64::from(view)
}

/// The variant pass entries the plan holds after its views and transparent draws: every
/// non-plain variant's block when it draws a variant, else none.
fn variant_blocks(plan: &FramePlan) -> u64 {
    if plan.variants.is_empty() { 0 } else { crate::scene::DRAW_VARIANTS as u64 - 1 }
}

/// The variants whose fade twins' slot bases the plan holds (game systems LOD-04): its
/// `fade_slots` regions, one per variant of the slot-base layout, none without fade batches.
fn fade_regions(plan: &FramePlan) -> u32 {
    if plan.fade_slots.is_empty() || plan.slot_count == 0 { 0 } else { plan.fade_slots.len() as u32 / plan.slot_count }
}

/// The pass-view entry of view `view`'s fade-twin rows of draw variant `variant` (game systems
/// LOD-04): after the variants' blocks, one block of the plan's views per fade region, each
/// reading its variant's region of the twins' slot bases, which follow the plan's own in the
/// slot-base table.
pub fn fade_pass_entry(plan: &FramePlan, view: u32, variant: usize) -> u64 {
    let after_variants = u64::from(plan.views) + plan.transparent.len() as u64 + variant_blocks(plan) * u64::from(plan.views);
    after_variants + variant as u64 * u64::from(plan.views) + u64::from(view)
}

fn pass_views(plan: &FramePlan) -> Vec<u8> {
    let transparent_base = plan.views * plan.visible_slots;
    let views = (0..plan.views).map(|view| GpuPassView { view, direct: 0, base: 0, slot_offset: 0 });
    let glass = (0..plan.transparent.len() as u32).map(|k| GpuPassView { view: 0, direct: 1, base: transparent_base + k, slot_offset: 0 });
    // Each non-plain variant's rows read its region of the slot-base table (P2-0.12).
    let varied = 1..1 + variant_blocks(plan) as u32;
    let variants = varied.flat_map(|variant| (0..plan.views).map(move |view| GpuPassView { view, direct: 0, base: 0, slot_offset: variant * plan.slot_count }));
    // Each variant's fade twins read their region of the twins' slot bases (LOD-04).
    let fade_base = plan.slot_base.len() as u32;
    let fades = (0..fade_regions(plan)).flat_map(|variant| (0..plan.views).map(move |view| GpuPassView { view, direct: 0, base: 0, slot_offset: fade_base + variant * plan.slot_count }));
    let entries: Vec<GpuPassView> = views.chain(glass).chain(variants).chain(fades).collect();
    let mut bytes = vec![0u8; entries.len().max(1) * PASS_VIEW_STRIDE as usize];
    for (i, entry) in entries.iter().enumerate() {
        let at = i * PASS_VIEW_STRIDE as usize;
        bytes[at..at + size_of::<GpuPassView>()].copy_from_slice(bytemuck::bytes_of(entry));
    }
    bytes
}

/// Each cull view's slots in the instance fade table (game systems LOD-03): the plan's visible
/// slots when it has fade batches, else none (the table keeps its smallest size, which the cull
/// binds and never writes).
pub fn fade_slots(plan: &FramePlan) -> u64 {
    if plan.fade_runs.is_empty() { 0 } else { u64::from(plan.visible_slots) }
}

/// The fade table the CPU path writes (game systems LOD-03): every view's fades, slot for slot
/// with its visible list, when the plan has fade batches; nothing otherwise (or on the GPU path,
/// whose cull writes them).
fn cpu_fades(plan: &FramePlan, cpu_culls: &[CpuCull]) -> Vec<u8> {
    if plan.fade_runs.is_empty() {
        return Vec::new();
    }
    let fades: Vec<[f32; 2]> = cpu_culls.iter().flat_map(|cull| cull.fades.iter().copied()).collect();
    bytemuck::cast_slice(&fades).to_vec()
}

/// The visible-list bytes a frame writes from the CPU, and where they start.
fn visible_rows(plan: &FramePlan, path: CullPath) -> (Vec<u8>, u64, Vec<CpuCull>) {
    let cpu_culls: Vec<CpuCull> = match path {
        CullPath::Cpu => (0..plan.views as usize).map(|view| plan.cpu_cull_view(view)).collect(),
        CullPath::Gpu => Vec::new(),
    };
    let mut rows: Vec<u32> = cpu_culls.iter().flat_map(|cull| cull.visible.iter().copied()).collect();
    rows.extend(&plan.transparent);
    let offset = match path {
        CullPath::Cpu => 0,
        CullPath::Gpu => u64::from(plan.views) * u64::from(plan.visible_slots) * 4,
    };
    (bytemuck::cast_slice(&rows).to_vec(), offset, cpu_culls)
}

impl Uploads {
    pub(crate) fn new(plan: &mut FramePlan, path: CullPath, instance_rows: Vec<std::ops::Range<usize>>) -> Result<Uploads, RenderError> {
        let (visible, visible_offset, cpu_culls) = visible_rows(plan, path);
        let lod_rows = crate::lod_rows::lod_row_upload_ranges(plan.lod_rows.len(), &instance_rows);
        let fades = cpu_fades(plan, &cpu_culls);
        let uploads = Uploads {
            frame: bytemuck::bytes_of::<GpuFrame>(&plan.frame).to_vec(),
            cull_views: bytemuck::bytes_of::<GpuCullViews>(&plan.cull_views).to_vec(),
            pass_views: pass_views(plan),
            prev_models: std::mem::take(&mut plan.prev_models),
            // The binned path's decal rows (renderer pass 2 A.10) follow the lights' and the spots'.
            light_ext: plan.binned.as_ref().map_or_else(
                || bytemuck::cast_slice(&plan.legacy_ext).to_vec(),
                |b| crate::decals::append_rows(crate::spot_shadow::light_ext_bytes(&b.ext, &plan.spot_shadows), b.ext.len(), &b.decals),
            ),
            light_tiles: cpu_light_tiles(plan),
            light_zbins: cpu_light_zbins(plan),
            visible,
            visible_offset,
            cpu_culls,
            instance_rows,
            lod_rows,
            fades,
            far_rules: bytemuck::cast_slice(&plan.far_rules).to_vec(),
        };
        let mut budget = UploadBudget::new();
        for bytes in uploads.all() {
            budget.charge(bytes.len() as u64)?;
        }
        // The instance rows charge only what is written (A.0b: retained rows already held cost 0).
        let [_, other_rows @ ..] = plan_rows(plan);
        for bytes in other_rows {
            budget.charge(bytes.len() as u64)?;
        }
        budget.charge(bytes_of_rows(&plan.fade_slots))?;
        let written: usize = uploads.instance_rows.iter().map(ExactSizeIterator::len).sum();
        budget.charge((written * size_of::<crate::layout::GpuInstance>()) as u64)?;
        budget.charge(uploads.lod_row_bytes())?;
        budget.charge(std::mem::size_of_val(uploads.prev_models.as_slice()) as u64)?;
        Ok(uploads)
    }

    /// The tables built here (the plan's own rows are [`plan_rows`]).
    fn all(&self) -> [&Vec<u8>; 9] {
        [&self.light_ext, &self.light_tiles, &self.light_zbins, &self.frame, &self.cull_views, &self.pass_views, &self.visible, &self.fades, &self.far_rules]
    }

    /// Every table write this frame makes from the CPU, for the upload arena: `plan`'s rows straight
    /// from the plan (the one these uploads were made of), the rest from here.
    pub(crate) fn writes<'a>(&'a self, tables: &'a Tables, plan: &'a FramePlan) -> Vec<UploadWrite<'a>> {
        let [_, materials, material_ext, lights, batches, slot_base, lines, joints, skin_jobs] = plan_rows(plan);
        let row = size_of::<crate::layout::GpuInstance>();
        let instance_writes = self.instance_rows.iter().map(|range| {
            let bytes: &[u8] = bytemuck::cast_slice(&plan.instances[range.clone()]);
            (tables.instances.get(), (range.start * row) as u64, bytes)
        });
        let lod_writes = self.lod_rows.iter().map(|range| {
            let bytes: &[u8] = bytemuck::cast_slice(&plan.lod_rows[range.clone()]);
            (tables.lod_rows.get(), range.start as u64 * crate::lod_rows::LOD_ROW_BYTES, bytes)
        });
        let rest = [
            (tables.materials.get(), 0, materials),
            (tables.material_ext.get(), 0, material_ext),
            (tables.lights.get(), 0, lights),
            (tables.batches.get(), 0, batches),
            (tables.slot_base.get(), 0, slot_base),
            // The fade twins' slot bases follow (game systems LOD-04, [`fade_pass_entry`]).
            (tables.slot_base.get(), bytes_of_rows(&plan.slot_base), bytemuck::cast_slice(&plan.fade_slots)),
            (tables.pass_views.get(), 0, self.pass_views.as_slice()),
            (tables.lines.get(), 0, lines),
            (tables.joints.get(), 0, joints),
            (tables.skin_jobs.get(), 0, skin_jobs),
            (tables.light_ext.get(), 0, self.light_ext.as_slice()),
            (tables.light_bins.get(), LIGHT_TILES_OFFSET_BYTES, self.light_tiles.as_slice()),
            (tables.light_bins.get(), 0, self.light_zbins.as_slice()),
            (tables.prev_models.get(), 0, bytemuck::cast_slice(&self.prev_models)),
            (tables.visible.get(), self.visible_offset, self.visible.as_slice()),
            (tables.instance_fade.get(), 0, self.fades.as_slice()),
            (tables.far_rules.get(), 0, self.far_rules.as_slice()),
        ];
        instance_writes.chain(lod_writes).chain(rest).collect()
    }

    /// Bytes of LOD rows this frame writes (game systems LOD-02: a static retained group's are
    /// written once).
    pub(crate) fn lod_row_bytes(&self) -> u64 {
        self.lod_rows.iter().map(ExactSizeIterator::len).sum::<usize>() as u64 * crate::lod_rows::LOD_ROW_BYTES
    }

    /// Bytes of instance rows this frame writes (A.0b).
    pub(crate) fn instance_bytes(&self) -> u64 {
        (self.instance_rows.iter().map(ExactSizeIterator::len).sum::<usize>() * size_of::<crate::layout::GpuInstance>()) as u64
    }
}
