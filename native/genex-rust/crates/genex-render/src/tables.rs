//! The storage-buffer tables a frame draws from and the bytes it writes into them. Every table
//! grows to the next power of two when a frame needs more and is never shrunk; every byte a frame
//! writes is charged against the per-frame upload budget before the first write, so a refused
//! frame leaves the GPU untouched (the world target keeps the previous frame).
//!
//! Visible list: one region of `opaque_instances` rows per cull view, then one row per transparent
//! draw. Indirect arguments: `batches` per view, tightly packed. Pass views: one 256-byte dynamic
//! uniform per cull view, then one per transparent draw. Previous models (RQ5): one row per
//! instance row, at the same index, filled only while motion vectors are drawn.

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

/// The smallest table: one row of the largest table struct (an `Instance`, 160 bytes) fits, so
/// an empty table still binds where a shader expects at least one element.
const TABLE_MIN_BYTES: u64 = 256;

/// `bytes` rounded up to a multiple of 16 (wgpu's copy alignment), at least [`TABLE_MIN_BYTES`].
pub(crate) fn aligned(bytes: u64) -> u64 {
    bytes.max(TABLE_MIN_BYTES).div_ceil(16) * 16
}

/// One growable GPU table.
pub(crate) struct Table {
    label: &'static str,
    usage: BufferUsages,
    buffer: Option<Buffer>,
}

impl Table {
    const fn new(label: &'static str, usage: BufferUsages) -> Table {
        Table { label, usage, buffer: None }
    }

    /// Make room for `bytes`; a grown table is a new, empty buffer.
    fn ensure(&mut self, device: &Device, bytes: u64) -> Result<(), RenderError> {
        let need = aligned(bytes);
        if self.buffer.as_ref().is_some_and(|b| b.size() >= need) {
            return Ok(());
        }
        self.buffer = Some(buffer(device, self.label, need.next_power_of_two(), self.usage)?);
        Ok(())
    }

    /// Whether the table holds `bytes` without growing (a grown table loses what it held).
    pub(crate) fn holds(&self, bytes: u64) -> bool {
        self.buffer.as_ref().is_some_and(|b| b.size() >= aligned(bytes))
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
    /// The per-tile light masks (`light_tiles`, RQ6; built by graph node 4 on a binned frame).
    pub light_tiles: Table,
    /// The light-bin header and z-bins (`light_zbins`, RQ6; a zero header bins no light).
    pub light_zbins: Table,
    /// Each material row's extension (`material_ext`, RQ6.3: its emission), parallel to `materials`.
    pub material_ext: Table,
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
            visible: Table::new("visible", storage),
            args: Table::new("indirect args", storage | BufferUsages::INDIRECT | BufferUsages::COPY_SRC),
            pass_views: Table::new("pass views", BufferUsages::UNIFORM | BufferUsages::COPY_DST),
            lines: Table::new("lines", BufferUsages::VERTEX | BufferUsages::COPY_DST),
            joints: Table::new("joints", storage),
            skin_jobs: Table::new("skin jobs", storage),
            skinned: Table::new("skinned vertices", BufferUsages::STORAGE | BufferUsages::VERTEX | BufferUsages::COPY_SRC),
            skinned_slots: Table::new("skinned slots", BufferUsages::STORAGE | BufferUsages::VERTEX),
            prev_models: Table::new("previous models", storage),
            light_ext: Table::new("light extensions", storage),
            light_tiles: Table::new("light tiles", storage),
            light_zbins: Table::new("light z-bins", storage),
            material_ext: Table::new("material extensions", storage),
        }
    }

    /// Make room for `uploads` (and the GPU-written tables of `plan`).
    pub(crate) fn ensure(&mut self, device: &Device, plan: &FramePlan, uploads: &Uploads) -> Result<(), RenderError> {
        let visible_rows = u64::from(plan.views) * u64::from(plan.opaque_instances) + plan.transparent.len() as u64;
        let sizes = [
            (&mut self.instances, bytes_of_rows(&plan.instances)),
            (&mut self.materials, bytes_of_rows(&plan.materials)),
            (&mut self.material_ext, bytes_of_rows(&plan.material_ext)),
            (&mut self.lights, bytes_of_rows(&plan.lights)),
            (&mut self.batches, bytes_of_rows(&plan.batches)),
            (&mut self.slot_base, bytes_of_rows(&plan.slot_base)),
            (&mut self.visible, visible_rows * 4),
            (&mut self.args, u64::from(plan.views) * plan.batches.len() as u64 * ARGS_STRIDE),
            (&mut self.pass_views, uploads.pass_views.len() as u64),
            (&mut self.lines, bytes_of_rows(&plan.lines)),
            (&mut self.joints, bytes_of_rows(&plan.joints)),
            (&mut self.skin_jobs, bytes_of_rows(&plan.skin_jobs)),
            (&mut self.skinned, u64::from(plan.skinned_vertices) * VERTEX_STRIDE),
            (&mut self.skinned_slots, u64::from(plan.skinned_vertices) * 4),
            (&mut self.prev_models, std::mem::size_of_val(uploads.prev_models.as_slice()) as u64),
            // The RQ6 tables bind from the first frame (forward frame bindings 20-23); the binned
            // light tables hold rows only on a binned frame (RQ6.2), else a zero bin header.
            (&mut self.light_ext, uploads.light_ext.len() as u64),
            (&mut self.light_tiles, light_tile_bytes(plan, uploads)),
            (&mut self.light_zbins, crate::cluster::zbin_bytes()),
        ];
        for (table, bytes) in sizes {
            table.ensure(device, bytes)?;
        }
        Ok(())
    }
}

/// What one frame writes to the GPU, charged against the upload budget before anything is written.
pub(crate) struct Uploads {
    /// The binned path's extension rows, tile masks and bins (RQ6.2). Graph node 4 builds the masks
    /// and bins on the GPU (RQ6.7), so the CPU writes no masks and a zero bin header, which node 4
    /// overwrites; a frame that bins nothing keeps the zero header and loops the legacy table.
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

/// The bytes `light_tiles` needs: the binned frame's masks (written by node 4 or the CPU).
fn light_tile_bytes(plan: &FramePlan, uploads: &Uploads) -> u64 {
    plan.binned.as_ref().map_or(0, |binned| binned.bins.grid.mask_bytes()).max(uploads.light_tiles.len() as u64)
}

fn pass_views(plan: &FramePlan) -> Vec<u8> {
    let transparent_base = plan.views * plan.opaque_instances;
    let views = (0..plan.views).map(|view| GpuPassView { view, direct: 0, base: 0, pad: 0 });
    let glass = (0..plan.transparent.len() as u32).map(|k| GpuPassView { view: 0, direct: 1, base: transparent_base + k, pad: 0 });
    let entries: Vec<GpuPassView> = views.chain(glass).collect();
    let mut bytes = vec![0u8; entries.len().max(1) * PASS_VIEW_STRIDE as usize];
    for (i, entry) in entries.iter().enumerate() {
        let at = i * PASS_VIEW_STRIDE as usize;
        bytes[at..at + size_of::<GpuPassView>()].copy_from_slice(bytemuck::bytes_of(entry));
    }
    bytes
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
        CullPath::Gpu => u64::from(plan.views) * u64::from(plan.opaque_instances) * 4,
    };
    (bytemuck::cast_slice(&rows).to_vec(), offset, cpu_culls)
}

impl Uploads {
    pub(crate) fn new(plan: &mut FramePlan, path: CullPath) -> Result<Uploads, RenderError> {
        let (visible, visible_offset, cpu_culls) = visible_rows(plan, path);
        let uploads = Uploads {
            frame: bytemuck::bytes_of::<GpuFrame>(&plan.frame).to_vec(),
            cull_views: bytemuck::bytes_of::<GpuCullViews>(&plan.cull_views).to_vec(),
            pass_views: pass_views(plan),
            prev_models: std::mem::take(&mut plan.prev_models),
            light_ext: plan.binned.as_ref().map_or_else(|| bytemuck::cast_slice(&plan.legacy_ext).to_vec(), |b| crate::spot_shadow::light_ext_bytes(&b.ext, &plan.spot_shadows)),
            light_tiles: cpu_light_tiles(plan),
            light_zbins: cpu_light_zbins(plan),
            visible,
            visible_offset,
            cpu_culls,
        };
        let mut budget = UploadBudget::new();
        for bytes in uploads.all() {
            budget.charge(bytes.len() as u64)?;
        }
        for bytes in plan_rows(plan) {
            budget.charge(bytes.len() as u64)?;
        }
        budget.charge(std::mem::size_of_val(uploads.prev_models.as_slice()) as u64)?;
        Ok(uploads)
    }

    /// The tables built here (the plan's own rows are [`plan_rows`]).
    fn all(&self) -> [&Vec<u8>; 7] {
        [&self.light_ext, &self.light_tiles, &self.light_zbins, &self.frame, &self.cull_views, &self.pass_views, &self.visible]
    }

    /// Write every table this frame fills from the CPU: `plan`'s rows straight from the plan (the
    /// one these uploads were made of), the rest from here.
    pub(crate) fn write(&self, queue: &wgpu::Queue, tables: &Tables, plan: &FramePlan) {
        let [instances, materials, material_ext, lights, batches, slot_base, lines, joints, skin_jobs] = plan_rows(plan);
        let writes = [
            (&tables.instances, instances),
            (&tables.materials, materials),
            (&tables.material_ext, material_ext),
            (&tables.lights, lights),
            (&tables.batches, batches),
            (&tables.slot_base, slot_base),
            (&tables.pass_views, self.pass_views.as_slice()),
            (&tables.lines, lines),
            (&tables.joints, joints),
            (&tables.skin_jobs, skin_jobs),
            (&tables.light_ext, self.light_ext.as_slice()),
            (&tables.light_tiles, self.light_tiles.as_slice()),
            (&tables.light_zbins, self.light_zbins.as_slice()),
        ];
        for (table, bytes) in writes {
            if !bytes.is_empty() {
                queue.write_buffer(table.get(), 0, bytes);
            }
        }
        if !self.prev_models.is_empty() {
            queue.write_buffer(tables.prev_models.get(), 0, bytemuck::cast_slice(&self.prev_models));
        }
        if !self.visible.is_empty() {
            queue.write_buffer(tables.visible.get(), self.visible_offset, &self.visible);
        }
    }
}
