//! Meshlet culling and draws with two-pass Hi-Z occlusion (R2, graph nodes 5 and 8).
//!
//! - **Candidates** are (instance, meshlet) pairs in meshlet-instance table order
//!   ([`crate::layout::GpuMeshletInstance::first_candidate`]); candidate `c` owns bit `c` of the
//!   visibility history. [`MeshletFrame::plan`] makes the table from a frame's opaque batches:
//!   every instance of a library mesh the library clustered ([`crate::scene::MeshletState`]).
//! - **Two passes** (Haar/Aaltonen): pass 1 (graph node 5) keeps the candidates last frame's
//!   bitset marks that are in the camera's frustum and do not face away; the frame draws them
//!   into the prepass and builds the Hi-Z from that depth (node 8, [`crate::hiz`]). Pass 2 (node 8)
//!   re-tests **every** candidate (instance sphere, then meshlet sphere and cone against the
//!   frustum, then its bounds against the new Hi-Z), keeps those that pass and were not kept by
//!   pass 1, and its verdict for all candidates is the next frame's bitset. The prepass draws pass
//!   2's meshlets on top (prepass part 2) and the main pass draws both. Correctness never depends
//!   on the history: it only decides what pass 1 draws early. Shadow views and a camera without
//!   occlusion run pass 1 only, testing frustum and cone.
//! - **History:** [`HISTORY_SLOTS`] bitsets of [`visibility_words`] words: two Live ones
//!   (ping-pong) and one a settled capture writes, so a capture never reads or moves Live's. A
//!   reset (a new candidate table, a frame without occlusion, [`MeshletCullNode::reset_history`],
//!   every capture re-render) sets [`FLAG_HISTORY_RESET`], so pass 1 draws nothing and pass 2
//!   draws every candidate in view: a capture holds no history.
//! - **Compaction** is a three-dispatch ordered scan ([`SCAN_DISPATCHES`], [`SCAN_BLOCK`] items per
//!   workgroup): per-block keep counts, an exclusive scan of the block sums (one workgroup per row),
//!   an ordered scatter. No atomics, no inter-workgroup waits, so the draw order is the candidate
//!   order on every run.
//! - **Draws:** per view, a compacted `u32` index buffer of `slot << MESHLET_LOCAL_BITS | local`
//!   ([`crate::meshlet::drawn_index`], `slot` already counts the view's region) drawn with one
//!   `draw_indexed_indirect` per [`ArgsSlot`]; vertex pulling (shaders/meshlet_draw.wgsl) reads the
//!   slot's instance and meshlet ([`crate::layout::GpuDrawnMeshlet`]) and the library vertex the
//!   meshlet vertex buffer names. Its entries pair with the forward, prepass and shadow pipelines'
//!   own fragments, computing what their instance-path twins compute, so the pictures are equal.
//!
//! [`reference`] is the CPU twin of both passes and [`run_case`] runs them on the GPU over a
//! supplied case (tests and the cull cost rows).

use crate::compile::Compiled;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, CommandEncoder, ComputePipeline, Device, Queue, RenderPipeline, TextureFormat, TextureView};

use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::hiz::HizLevel;
use crate::layout::{DrawIndexedArgs, GpuCullViews, GpuDrawnMeshlet, GpuFrame, GpuInstance, GpuMeshlet, GpuMeshletCull, GpuMeshletInstance, MAX_VIEWS, NO_BATCH};
use crate::meshlet::{MESHLET_LOCAL_BITS, MeshletLibrary, drawn_index, unpack_triangle};
use crate::readback::{map_read_blocking, stage_buffer};
use crate::scene::{FramePlan, MeshId, MeshLibrary, MeshletState};
use crate::tables::{aligned, buffer, pipeline_layout, storage, uniform};

/// Whether the meshlet path draws (R2.4).
pub const LANDED: bool = true;

/// Whether two-pass Hi-Z occlusion runs: the meshlet path and the Hi-Z build have both landed.
pub const fn occlusion_landed() -> bool {
    LANDED && crate::hiz::LANDED
}

/// The meshlet cull and its scan.
pub const MESHLET_CULL: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/meshlet_cull.wgsl")));
/// The meshlet draws' vertex pulling.
pub const MESHLET_DRAW: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/shadow_caster.wgsl"),
    include_str!("../shaders/meshlet_draw.wgsl")
));
/// The meshlet draw's vertex entry point (a depth writer: `@invariant`, `gx_clip_position`),
/// paired with the forward module's fragments.
pub const MESHLET_DRAW_VERTEX_ENTRY: &str = "vs_meshlet";
/// The meshlet prepass's vertex entry point, paired with the prepass module's `fs_prepass`.
pub const MESHLET_PREPASS_VERTEX_ENTRY: &str = "vs_meshlet_prepass";
/// The meshlet motion prepass's vertex entry point (RQ5.6), paired with the prepass module's
/// `fs_prepass_motion`: group 3 is [`crate::motion::MotionNode::meshlet_layout`].
pub const MESHLET_PREPASS_MOTION_VERTEX_ENTRY: &str = "vs_meshlet_prepass_motion";
/// The prepass module's fragment entry writing the reflections' rough surface texel beside the
/// motion targets (lane FR): prepass part 2's meshlets on a frame that traces.
pub const MESHLET_PREPASS_ROUGH_FRAGMENT_ENTRY: &str = "fs_prepass_motion_rough";
/// The meshlet shadow casters' vertex entry point (depth only).
pub const MESHLET_SHADOW_VERTEX_ENTRY: &str = "vs_meshlet_shadow";
/// Dispatch 1 of a compaction: keep counts per candidate and per block.
pub const MARK_ENTRY: &str = "cull_mark";
/// Dispatch 2: the exclusive scan of one row's block sums, its totals and indirect arguments.
pub const SCAN_ENTRY: &str = "cull_scan";
/// Dispatch 3: the ordered scatter into the drawn slots and the compacted index buffer.
pub const SCATTER_ENTRY: &str = "cull_scatter";

/// Items one scan workgroup covers (`GX_SCAN_BLOCK` in the shader).
pub const SCAN_BLOCK: u32 = 256;
/// Dispatches of one compaction: keep counts per block, the scan of the block sums, the scatter.
pub const SCAN_DISPATCHES: u32 = 3;
/// Visibility bitsets kept: Live's pair (last frame's, read by pass 1, and the next one, written
/// by pass 2) and the one settled captures write.
pub const HISTORY_SLOTS: u32 = 3;
/// The bitset a settled capture's pass 2 writes (Live's two are 0 and 1).
pub const CAPTURE_HISTORY_SLOT: u32 = 2;
/// Kept for the R2.0 contract: the Live ping-pong pair.
pub const VISIBILITY_HISTORY_BUFFERS: u32 = 2;
/// Indirect argument slots per view ([`ArgsSlot`]).
pub const ARGS_PER_VIEW: u32 = 3;
/// Bytes of one indirect argument slot.
pub const ARGS_STRIDE: u64 = size_of::<DrawIndexedArgs>() as u64;
/// Drawn slots a frame can name over all its views: the index's bits above the local vertex.
pub const MAX_DRAWN_SLOTS: u64 = 1 << (u32::BITS - MESHLET_LOCAL_BITS);
/// Workgroups of one dispatch dimension (WebGPU core's `maxComputeWorkgroupsPerDimension`).
const MAX_WORKGROUPS: u32 = 65_535;

/// Which occlusion pass a dispatch runs (`MeshletCull.counts.w`).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CullPass {
    /// Last frame's visible set, before the Hi-Z exists (every view).
    First,
    /// Every candidate against the new Hi-Z (the camera).
    Second,
}

impl CullPass {
    /// The shader's spelling (1 or 2).
    pub const fn shader_id(self) -> u32 {
        match self {
            CullPass::First => 1,
            CullPass::Second => 2,
        }
    }
}

/// A view's indirect argument slots.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ArgsSlot {
    /// Pass 1's meshlets (the prepass draws them before the Hi-Z).
    First,
    /// Pass 2's meshlets, after pass 1's in the same index region (prepass part 2).
    Second,
    /// Both passes' meshlets: what the main pass and the shadow casters draw.
    All,
}

impl ArgsSlot {
    /// The slot's index among a view's [`ARGS_PER_VIEW`].
    pub const fn index(self) -> u32 {
        match self {
            ArgsSlot::First => 0,
            ArgsSlot::Second => 1,
            ArgsSlot::All => 2,
        }
    }
}

/// The byte offset of `view`'s `slot` in the argument buffer.
pub const fn args_offset(view: u32, slot: ArgsSlot) -> u64 {
    (view as u64 * ARGS_PER_VIEW as u64 + slot.index() as u64) * ARGS_STRIDE
}

/// `MeshletCull.capacity.w` bit: occlusion is on (pass 1 reads the history, pass 2 the Hi-Z).
pub const FLAG_OCCLUSION: u32 = 1;
/// `MeshletCull.capacity.w` bit: the history was reset (last frame's visible set is empty).
pub const FLAG_HISTORY_RESET: u32 = 2;
/// Where the bitset pass 1 reads sits in the flags (2 bits).
pub const HISTORY_PREV_SHIFT: u32 = 2;
/// Where the bitset pass 2 writes sits in the flags (2 bits).
pub const HISTORY_NEXT_SHIFT: u32 = 4;

/// Which bitsets a frame reads and writes, and whether it starts from an empty history.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HistoryUse {
    /// The bitset pass 1 reads.
    pub prev: u32,
    /// The bitset pass 2 writes.
    pub next: u32,
    /// Last frame's visible set is empty.
    pub reset: bool,
}

impl HistoryUse {
    /// The flags of a dispatch with occlusion `occlusion`.
    pub const fn flags(self, occlusion: bool) -> u32 {
        let mut flags = (self.prev << HISTORY_PREV_SHIFT) | (self.next << HISTORY_NEXT_SHIFT);
        if occlusion {
            flags |= FLAG_OCCLUSION;
        }
        if self.reset {
            flags |= FLAG_HISTORY_RESET;
        }
        flags
    }
}

/// Scan workgroups for `candidates` (at least one).
pub const fn scan_blocks(candidates: u32) -> u32 {
    let blocks = candidates.div_ceil(SCAN_BLOCK);
    if blocks == 0 { 1 } else { blocks }
}

/// Words of one visibility bitset for `candidates` (at least one).
pub const fn visibility_words(candidates: u32) -> u32 {
    let words = candidates.div_ceil(32);
    if words == 0 { 1 } else { words }
}

/// Indices one view's compacted index buffer holds at most: every candidate's triangles.
pub const fn view_index_capacity(candidate_triangles: u64) -> u64 {
    candidate_triangles * 3
}

/// Bytes of the compacted index buffers of `views` views.
pub const fn compacted_index_bytes(candidate_triangles: u64, views: u32) -> u64 {
    view_index_capacity(candidate_triangles) * 4 * views as u64
}

/// Whether one view's compacted index buffer fits one storage binding of `limits` (WebGPU core:
/// 128 MiB); a scene over it chunks by binding offset or keeps big meshes on the instance path.
pub fn view_indices_fit(candidate_triangles: u64, limits: &wgpu::Limits) -> bool {
    view_index_capacity(candidate_triangles) * 4 <= limits.max_storage_buffer_binding_size
}

/// A visibility bitset on the CPU (the reference the GPU's is compared with).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VisibilityBits {
    words: Vec<u32>,
}

impl VisibilityBits {
    /// An empty bitset for `candidates`.
    pub fn new(candidates: u32) -> VisibilityBits {
        VisibilityBits { words: vec![0; visibility_words(candidates) as usize] }
    }

    /// A bitset of these words.
    pub fn from_words(words: Vec<u32>) -> VisibilityBits {
        VisibilityBits { words }
    }

    /// Whether candidate `candidate` is marked.
    pub fn get(&self, candidate: u32) -> bool {
        self.words.get((candidate / 32) as usize).is_some_and(|word| word & (1 << (candidate % 32)) != 0)
    }

    /// Mark candidate `candidate` visible or not (ignored past the end).
    pub fn set(&mut self, candidate: u32, visible: bool) {
        if let Some(word) = self.words.get_mut((candidate / 32) as usize) {
            let mask = 1 << (candidate % 32);
            *word = if visible { *word | mask } else { *word & !mask };
        }
    }

    /// Clear every mark: a history reset.
    pub fn reset(&mut self) {
        self.words.fill(0);
    }

    /// The words as uploaded.
    pub fn words(&self) -> &[u32] {
        &self.words
    }

    /// Marked candidates.
    pub fn count(&self) -> u32 {
        self.words.iter().map(|word| word.count_ones()).sum()
    }
}

// ---------------------------------------------------------------------------------------------
// The frame's candidates

/// Where one view's draws sit in the compacted index buffer and the drawn slots (`regions` in
/// shaders/meshlet_cull.wgsl), sized for every candidate whose instance the view's frustum may
/// hold ([`MeshletFrame::fit`]).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuViewRegion {
    /// The view's first index.
    pub first_index: u32,
    /// The view's first drawn slot.
    pub first_slot: u32,
    /// Indices the view may write.
    pub index_capacity: u32,
    /// Drawn slots the view may write.
    pub slot_capacity: u32,
}

/// The regions uniform: one per reserved cull view.
type RegionTable = [GpuViewRegion; MAX_VIEWS];

/// A view's frustum test on the CPU is widened by this share of the sphere's radius, plus
/// [`REGION_SLACK_ABS`] and this share of the centre's magnitude, so the GPU's own rounding
/// never keeps an instance the region was not sized for.
const REGION_SLACK_REL: f32 = 0.01;
const REGION_SLACK_ABS: f32 = 0.01;

/// What one frame draws on the meshlet path: its candidate table, the views it culls and whether
/// occlusion runs.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshletFrame {
    /// The meshlet-instance table (candidate order).
    pub instances: Vec<GpuMeshletInstance>,
    /// Triangles of each meshlet instance's mesh (parallel to `instances`).
    pub triangles: Vec<u32>,
    /// Candidates (instance × meshlet pairs).
    pub candidates: u32,
    /// Triangles over every candidate.
    pub candidate_triangles: u64,
    /// The cull views drawn through meshlets: the camera, then the shadow cascades whose regions
    /// fit ([`MeshletFrame::fit`]); a view past them draws its clustered batches whole.
    pub views: u32,
    /// Each drawn view's region (`views` of them).
    pub regions: Vec<GpuViewRegion>,
    /// Whether two-pass occlusion runs (the camera view, with the prepass).
    pub occlusion: bool,
    /// Per opaque batch: whether it draws through meshlets (skinned batches never do).
    pub batches: Vec<bool>,
}

impl MeshletFrame {
    /// The candidates of `plan`'s opaque batches over `library`: every instance of a mesh the
    /// library clustered. None when no batch draws through meshlets.
    pub fn plan(plan: &FramePlan, library: &MeshLibrary) -> Option<MeshletFrame> {
        let mut batches = vec![false; plan.batches.len()];
        let mut instances = Vec::new();
        let mut instance_triangles = Vec::new();
        let (mut candidates, mut candidate_triangles) = (0u64, 0u64);
        // The plain library batches in row order (a mesh's levels follow it, A6.9): a mesh's batch
        // is the one starting at its slot base.
        let library_batches = &plan.batches[..plan.static_batches as usize];
        for (mesh, base) in plan.slot_base.iter().enumerate().take(library.len()) {
            if *base == NO_BATCH {
                continue;
            }
            let at = library_batches.partition_point(|row| row.first_instance < *base);
            let Some(row) = library_batches.get(at).filter(|row| row.first_instance == *base) else { continue };
            let Some(MeshletState::Clustered(range)) = library.meshlet_state(MeshId::from_raw(mesh as u32)) else { continue };
            if range.meshlet_count == 0 {
                continue;
            }
            batches[at] = true;
            let triangles = u64::from(row.index_count / 3);
            for instance in row.first_row..row.first_row + row.instance_count {
                instances.push(GpuMeshletInstance {
                    instance,
                    first_meshlet: range.first_meshlet,
                    meshlet_count: range.meshlet_count,
                    first_candidate: candidates as u32,
                });
                instance_triangles.push(row.index_count / 3);
                candidates += u64::from(range.meshlet_count);
                candidate_triangles += triangles;
            }
        }
        if instances.is_empty() || candidates > u64::from(u32::MAX) {
            return None;
        }
        Some(MeshletFrame {
            instances,
            triangles: instance_triangles,
            candidates: candidates as u32,
            candidate_triangles,
            views: 0,
            regions: Vec::new(),
            occlusion: false,
            batches,
        })
    }

    /// Size each view's region for the candidates whose instance its frustum (`planes`, the cull
    /// views of `wanted` views) may hold over `instances` (the instance table), and keep the most
    /// views (the camera, then the cascades) whose regions, drawn slots and dispatches fit
    /// `limits` and the index's slot bits. Returns the views kept: 0 when not even the camera's
    /// fit (the frame then draws every batch whole).
    pub fn fit(&mut self, planes: &[[[f32; 4]; 6]], wanted: u32, instances: &[GpuInstance], limits: &wgpu::Limits) -> u32 {
        let binding = limits.max_storage_buffer_binding_size.min(limits.max_buffer_size).min(crate::BUFFER_MAX_BYTES);
        let dispatchable = scan_blocks(self.candidates) <= MAX_WORKGROUPS.min(limits.max_compute_workgroups_per_dimension);
        let keep = (u64::from(wanted) + 1) * u64::from(self.candidates) * 4;
        self.regions.clear();
        self.views = 0;
        if !dispatchable || keep > binding {
            return 0;
        }
        let (mut indices, mut slots) = (0u64, 0u64);
        for view in planes.iter().take(wanted.min(MAX_VIEWS as u32) as usize) {
            let (mut view_indices, mut view_slots) = (0u64, 0u64);
            for (row, triangles) in self.instances.iter().zip(&self.triangles) {
                let Some(instance) = instances.get(row.instance as usize) else { continue };
                if crate::cull::in_frustum(view, widened(instance.bounds)) {
                    view_indices += u64::from(*triangles) * 3;
                    view_slots += u64::from(row.meshlet_count);
                }
            }
            let fits = (indices + view_indices) * 4 <= binding && (slots + view_slots) * size_of::<GpuDrawnMeshlet>() as u64 <= binding;
            if !fits || slots + view_slots > MAX_DRAWN_SLOTS {
                break;
            }
            self.regions.push(GpuViewRegion { first_index: indices as u32, first_slot: slots as u32, index_capacity: view_indices as u32, slot_capacity: view_slots as u32 });
            indices += view_indices;
            slots += view_slots;
        }
        self.views = self.regions.len() as u32;
        self.views
    }

    /// Indices over every view's region.
    pub fn index_capacity(&self) -> u64 {
        self.regions.iter().map(|region| u64::from(region.index_capacity)).sum()
    }

    /// Drawn slots over every view's region.
    pub fn slot_capacity(&self) -> u64 {
        self.regions.iter().map(|region| u64::from(region.slot_capacity)).sum()
    }

    /// The regions uniform.
    fn region_table(&self) -> RegionTable {
        let mut table = [GpuViewRegion::default(); MAX_VIEWS];
        for (row, region) in table.iter_mut().zip(&self.regions) {
            *row = *region;
        }
        table
    }

    /// Whether view `view`'s batch `batch` draws through meshlets this frame.
    pub fn draws(&self, view: u32, batch: usize) -> bool {
        view < self.views && self.batches.get(batch).copied().unwrap_or(false)
    }

    /// Whether batch `batch` draws through meshlets in some view.
    fn clustered(&self, batch: usize) -> bool {
        self.batches.get(batch).copied().unwrap_or(false)
    }

    /// The runs of `range`'s batches that `view` draws whole: the instance path's multi-draws.
    pub fn whole_runs(&self, view: u32, range: std::ops::Range<u32>) -> Vec<std::ops::Range<u32>> {
        let mut runs = Vec::new();
        let mut start = None;
        for batch in range.clone() {
            let whole = !(view < self.views && self.clustered(batch as usize));
            match (whole, start) {
                (true, None) => start = Some(batch),
                (false, Some(from)) => {
                    runs.push(from..batch);
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(from) = start {
            runs.push(from..range.end);
        }
        runs
    }

    /// The uniform of pass `pass` with `history` (Hi-Z of a `render`-sized frame, `reversed` depth).
    pub fn uniform(&self, pass: CullPass, history: HistoryUse, render: (u32, u32), reversed: bool) -> GpuMeshletCull {
        let base = crate::hiz::base_size(render);
        let mips = crate::hiz::mip_count(base);
        GpuMeshletCull {
            counts: [self.candidates, self.instances.len() as u32, self.views, pass.shader_id()],
            hiz: [base.0, base.1, mips, u32::from(reversed)],
            capacity: [self.index_capacity() as u32, self.slot_capacity() as u32, scan_blocks(self.candidates), history.flags(self.occlusion)],
            hiz_uv: [render.0 as f32 / (2 * base.0) as f32, render.1 as f32 / (2 * base.1) as f32, 0.0, 0.0],
        }
    }
}

/// A world sphere widened for the regions' CPU frustum test ([`REGION_SLACK_REL`]).
fn widened(bounds: [f32; 4]) -> [f32; 4] {
    let reach = bounds[0].abs().max(bounds[1].abs()).max(bounds[2].abs());
    [bounds[0], bounds[1], bounds[2], bounds[3] * (1.0 + REGION_SLACK_REL) + REGION_SLACK_ABS + reach * 1.0e-4]
}

// ---------------------------------------------------------------------------------------------
// The GPU node

/// The library's meshlet buffers on the GPU (uploaded beside the library's vertices and indices).
pub struct MeshletBuffers {
    /// The meshlet table.
    pub meshlets: Buffer,
    /// The meshlet vertex buffer (library vertex ids).
    pub vertices: Buffer,
    /// The packed triangles.
    pub triangles: Buffer,
}

impl MeshletBuffers {
    /// Upload `library` (an empty one still binds: each buffer holds at least one table row).
    pub fn upload(device: &Device, queue: &Queue, library: &MeshletLibrary) -> Result<MeshletBuffers, RenderError> {
        let upload = |label, bytes: &[u8]| -> Result<Buffer, RenderError> {
            let target = storage_buffer(device, label, bytes.len() as u64, BufferUsages::empty())?;
            if !bytes.is_empty() {
                queue.write_buffer(&target, 0, bytes);
            }
            Ok(target)
        };
        Ok(MeshletBuffers {
            meshlets: upload("meshlets", bytemuck::cast_slice(&library.meshlets))?,
            vertices: upload("meshlet vertices", bytemuck::cast_slice(&library.vertices))?,
            triangles: upload("meshlet triangles", bytemuck::cast_slice(&library.triangles))?,
        })
    }

    /// Bytes of the three buffers.
    pub fn bytes(&self) -> u64 {
        self.meshlets.size() + self.vertices.size() + self.triangles.size()
    }
}

/// What a frame's buffers hold room for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Capacity {
    candidates: u64,
    instances: u64,
    views: u64,
    indices: u64,
    slots: u64,
}

impl Capacity {
    fn of(frame: &MeshletFrame) -> Capacity {
        Capacity {
            candidates: u64::from(frame.candidates),
            instances: frame.instances.len() as u64,
            views: u64::from(frame.views),
            indices: frame.index_capacity(),
            slots: frame.slot_capacity(),
        }
    }

    fn holds(&self, other: &Capacity) -> bool {
        let tables = self.candidates >= other.candidates && self.instances >= other.instances && self.views >= other.views;
        tables && self.indices >= other.indices && self.slots >= other.slots
    }

    /// Room for `other` with headroom, so a growing scene reallocates rarely; the headroom never
    /// takes a buffer past one storage binding ([`crate::BUFFER_MAX_BYTES`]).
    fn grown(&self, other: &Capacity) -> Capacity {
        let grow = |have: u64, want: u64, row_bytes: u64| {
            if have >= want {
                return have;
            }
            want.max((have * 3 / 2).min(crate::BUFFER_MAX_BYTES / row_bytes))
        };
        let views = grow(self.views, other.views, 1).min(MAX_VIEWS as u64);
        let keep_row = (views + 1) * 4;
        Capacity {
            candidates: grow(self.candidates, other.candidates, keep_row),
            instances: grow(self.instances, other.instances, size_of::<GpuMeshletInstance>() as u64),
            views,
            indices: grow(self.indices, other.indices, 4),
            slots: grow(self.slots, other.slots, size_of::<GpuDrawnMeshlet>() as u64),
        }
    }
}

/// A frame's working buffers, grown to the largest frame.
struct FrameBuffers {
    capacity: Capacity,
    meshlet_instances: Buffer,
    visibility: Buffer,
    keep: Buffer,
    blocks: Buffer,
    totals: Buffer,
    args: Buffer,
    drawn: Buffer,
    indices: Buffer,
}

/// What a frame binds that the node does not own.
#[derive(Clone, Copy)]
pub struct CullExternals<'a> {
    /// The cull views' planes (`CullViews`).
    pub views: &'a Buffer,
    /// The frame uniforms (`FrameUniforms`: the camera's projection and eye).
    pub frame: &'a Buffer,
    /// The instance table.
    pub instances: &'a Buffer,
    /// The library's vertices (`MeshVertex`, storage-readable): the draws pull them.
    pub vertices: &'a Buffer,
    /// The library's meshlet buffers.
    pub library: &'a MeshletBuffers,
    /// The Hi-Z pyramid, all mips (None: no occlusion this frame; a neutral texture is bound).
    pub hiz: Option<&'a TextureView>,
}

/// The identity of everything the bind groups bind.
#[derive(Clone, PartialEq)]
struct GroupsKey {
    buffers: [Buffer; 13],
    hiz: Option<TextureView>,
}

/// The bind groups of both passes (they differ in their uniform slot) and the draws' group.
struct Groups {
    mark: [BindGroup; 2],
    scan: [BindGroup; 2],
    scatter: [BindGroup; 2],
    draw: BindGroup,
}

/// Bytes between the two passes' uniforms (WebGPU core's uniform offset alignment).
const UNIFORM_STRIDE: u64 = 256;
const _: () = assert!(size_of::<GpuMeshletCull>() as u64 <= UNIFORM_STRIDE);

/// The bindings of shaders/meshlet_cull.wgsl.
mod binding {
    pub const CULL: u32 = 0;
    pub const VIEWS: u32 = 1;
    pub const FRAME: u32 = 2;
    pub const INSTANCES: u32 = 3;
    pub const MESHLET_INSTANCES: u32 = 4;
    pub const MESHLETS: u32 = 5;
    pub const VISIBILITY: u32 = 6;
    pub const KEEP: u32 = 7;
    pub const BLOCKS: u32 = 8;
    pub const TOTALS: u32 = 9;
    pub const ARGS: u32 = 10;
    pub const TRIANGLES: u32 = 11;
    pub const DRAWN: u32 = 12;
    pub const INDICES: u32 = 13;
    pub const HIZ: u32 = 14;
    pub const REGIONS: u32 = 15;
}

fn compute_layout(device: &Device, label: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

fn compute_pipeline(device: &Device, layout: &BindGroupLayout, module: &wgpu::ShaderModule, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout(device, entry, &[layout])),
        module,
        entry_point: Some(entry),
        // A8.6: every meshlet-cull kernel writes its lanes' workgroup slots first.
        compilation_options: crate::compile::written_first(),
        cache: None,
    })
}

fn buffer_entry(binding: u32, buffer: &Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: buffer.as_entire_binding() }
}

/// A storage buffer of at least `bytes` (aligned, at least one table row).
fn storage_buffer(device: &Device, label: &str, bytes: u64, extra: BufferUsages) -> Result<Buffer, RenderError> {
    buffer(device, label, aligned(bytes), BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC | extra)
}

/// The meshlet cull (graph nodes 5 and 8's meshlet half): its three pipelines, the library's
/// meshlet buffers, the frame's working buffers, the visibility history and the bind groups.
/// Made on the first frame that draws meshlets.
pub struct MeshletCullNode {
    mark_layout: BindGroupLayout,
    scan_layout: BindGroupLayout,
    scatter_layout: BindGroupLayout,
    draw_layout: BindGroupLayout,
    mark: Compiled<ComputePipeline>,
    scan: Compiled<ComputePipeline>,
    scatter: Compiled<ComputePipeline>,
    uniforms: Buffer,
    regions: Buffer,
    neutral_hiz: TextureView,
    frame: Option<FrameBuffers>,
    groups: Option<(GroupsKey, Groups)>,
    /// Which Live bitset last frame's pass 2 wrote, and the candidate layout it was written for
    /// ([`history_key`]).
    live: Option<(u32, Vec<CandidateKey>)>,
}

impl MeshletCullNode {
    /// The cull's pipelines.
    pub fn new(device: &Device) -> Result<MeshletCullNode, RenderError> {
        use wgpu::ShaderStages;
        let module = crate::shaders::module(device, "meshlet cull", MESHLET_CULL)?;
        let compute = ShaderStages::COMPUTE;
        let hiz = wgpu::BindGroupLayoutEntry {
            binding: binding::HIZ,
            visibility: compute,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let mark_layout = compute_layout(
            device,
            "meshlet cull mark",
            &[
                uniform(binding::CULL, false, compute),
                uniform(binding::VIEWS, false, compute),
                uniform(binding::FRAME, false, compute),
                storage(binding::INSTANCES, true, compute),
                storage(binding::MESHLET_INSTANCES, true, compute),
                storage(binding::MESHLETS, true, compute),
                storage(binding::VISIBILITY, false, compute),
                storage(binding::KEEP, false, compute),
                storage(binding::BLOCKS, false, compute),
                hiz,
            ],
        );
        let scan_layout = compute_layout(
            device,
            "meshlet cull scan",
            &[
                uniform(binding::CULL, false, compute),
                storage(binding::BLOCKS, false, compute),
                storage(binding::TOTALS, false, compute),
                storage(binding::ARGS, false, compute),
                uniform(binding::REGIONS, false, compute),
            ],
        );
        let scatter_layout = compute_layout(
            device,
            "meshlet cull scatter",
            &[
                uniform(binding::CULL, false, compute),
                storage(binding::MESHLET_INSTANCES, true, compute),
                storage(binding::MESHLETS, true, compute),
                storage(binding::KEEP, false, compute),
                storage(binding::BLOCKS, false, compute),
                storage(binding::TRIANGLES, true, compute),
                storage(binding::DRAWN, false, compute),
                storage(binding::INDICES, false, compute),
                uniform(binding::REGIONS, false, compute),
            ],
        );
        let draw_layout = compute_layout(device, "meshlet draw", &crate::tables::meshlet_draw_layout_entries());
        let neutral = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("meshlet cull neutral hi-z"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::hiz::HIZ_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        Ok(MeshletCullNode {
            mark: compute_pipeline(device, &mark_layout, &module, MARK_ENTRY),
            scan: compute_pipeline(device, &scan_layout, &module, SCAN_ENTRY),
            scatter: compute_pipeline(device, &scatter_layout, &module, SCATTER_ENTRY),
            mark_layout,
            scan_layout,
            scatter_layout,
            draw_layout,
            uniforms: buffer(device, "meshlet cull", UNIFORM_STRIDE * 2, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            regions: buffer(device, "meshlet regions", size_of::<RegionTable>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            neutral_hiz: neutral.create_view(&Default::default()),
            frame: None,
            groups: None,
            live: None,
        })
    }

    /// Room in the working buffers for `frame` and the bind groups over `externals`.
    pub fn prepare(&mut self, device: &Device, frame: &MeshletFrame, externals: &CullExternals<'_>) -> Result<(), RenderError> {
        let wanted = Capacity::of(frame);
        let held = self.frame.as_ref().map(|buffers| buffers.capacity).unwrap_or_default();
        if !held.holds(&wanted) {
            self.frame = Some(frame_buffers(device, held.grown(&wanted))?);
            // The bitsets were made again: nothing of the history is left.
            self.live = None;
        }
        let Some(buffers) = &self.frame else { return Err(RenderError::refused(RenderCode::BufferTooLarge, "no meshlet working buffers")) };
        let library = externals.library;
        let key = GroupsKey {
            buffers: [
                externals.views.clone(),
                externals.frame.clone(),
                externals.instances.clone(),
                externals.vertices.clone(),
                library.meshlets.clone(),
                library.vertices.clone(),
                library.triangles.clone(),
                buffers.meshlet_instances.clone(),
                buffers.visibility.clone(),
                buffers.keep.clone(),
                buffers.args.clone(),
                buffers.drawn.clone(),
                buffers.indices.clone(),
            ],
            hiz: externals.hiz.cloned(),
        };
        if self.groups.as_ref().is_some_and(|(held, _)| *held == key) {
            return Ok(());
        }
        let groups = self.groups_for(device, library, buffers, externals);
        self.groups = Some((key, groups));
        Ok(())
    }

    fn groups_for(&self, device: &Device, library: &MeshletBuffers, buffers: &FrameBuffers, externals: &CullExternals<'_>) -> Groups {
        let hiz = externals.hiz.unwrap_or(&self.neutral_hiz);
        let cull = |slot: u64| wgpu::BindGroupEntry {
            binding: binding::CULL,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                buffer: &self.uniforms,
                offset: slot * UNIFORM_STRIDE,
                size: wgpu::BufferSize::new(size_of::<GpuMeshletCull>() as u64),
            }),
        };
        let group = |label, layout, entries: &[wgpu::BindGroupEntry<'_>]| device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries });
        let mark = |slot| {
            group(
                "meshlet cull mark",
                &self.mark_layout,
                &[
                    cull(slot),
                    buffer_entry(binding::VIEWS, externals.views),
                    buffer_entry(binding::FRAME, externals.frame),
                    buffer_entry(binding::INSTANCES, externals.instances),
                    buffer_entry(binding::MESHLET_INSTANCES, &buffers.meshlet_instances),
                    buffer_entry(binding::MESHLETS, &library.meshlets),
                    buffer_entry(binding::VISIBILITY, &buffers.visibility),
                    buffer_entry(binding::KEEP, &buffers.keep),
                    buffer_entry(binding::BLOCKS, &buffers.blocks),
                    wgpu::BindGroupEntry { binding: binding::HIZ, resource: wgpu::BindingResource::TextureView(hiz) },
                ],
            )
        };
        let scan = |slot| {
            group(
                "meshlet cull scan",
                &self.scan_layout,
                &[
                    cull(slot),
                    buffer_entry(binding::BLOCKS, &buffers.blocks),
                    buffer_entry(binding::TOTALS, &buffers.totals),
                    buffer_entry(binding::ARGS, &buffers.args),
                    buffer_entry(binding::REGIONS, &self.regions),
                ],
            )
        };
        let scatter = |slot| {
            group(
                "meshlet cull scatter",
                &self.scatter_layout,
                &[
                    cull(slot),
                    buffer_entry(binding::MESHLET_INSTANCES, &buffers.meshlet_instances),
                    buffer_entry(binding::MESHLETS, &library.meshlets),
                    buffer_entry(binding::KEEP, &buffers.keep),
                    buffer_entry(binding::BLOCKS, &buffers.blocks),
                    buffer_entry(binding::TRIANGLES, &library.triangles),
                    buffer_entry(binding::DRAWN, &buffers.drawn),
                    buffer_entry(binding::INDICES, &buffers.indices),
                    buffer_entry(binding::REGIONS, &self.regions),
                ],
            )
        };
        let draw = group(
            "meshlet draw",
            &self.draw_layout,
            &[
                buffer_entry(0, externals.vertices),
                buffer_entry(1, &library.meshlets),
                buffer_entry(2, &library.vertices),
                buffer_entry(3, &buffers.drawn),
            ],
        );
        Groups { mark: [mark(0), mark(1)], scan: [scan(0), scan(1)], scatter: [scatter(0), scatter(1)], draw }
    }

    /// The history `frame` reads and writes: a settled capture (`settle`) starts empty and writes
    /// the capture's bitset, whatever it draws, and never touches Live's; Live reads last frame's
    /// bitset unless the candidate layout changed or last frame ran no occlusion, and writes the
    /// other. Advances Live's pair.
    pub fn history(&mut self, frame: &MeshletFrame, settle: bool) -> HistoryUse {
        // Settle first: a capture whose pinned quality runs no occlusion must not drop Live's.
        if settle {
            return HistoryUse { prev: CAPTURE_HISTORY_SLOT, next: CAPTURE_HISTORY_SLOT, reset: true };
        }
        if !frame.occlusion {
            self.live = None;
            return HistoryUse { prev: 0, next: 0, reset: true };
        }
        let (prev, reset) = match &mut self.live {
            Some((slot, key)) if same_layout(key, &frame.instances) => (*slot, false),
            Some((slot, key)) => {
                *key = history_key(&frame.instances);
                (*slot, true)
            }
            None => {
                self.live = Some((0, history_key(&frame.instances)));
                (0, true)
            }
        };
        let next = 1 - prev;
        if let Some((slot, _)) = &mut self.live {
            *slot = next;
        }
        HistoryUse { prev, next, reset }
    }

    /// Forget Live's history: the next frame's pass 1 draws nothing (a camera cut, a quality or
    /// device change).
    pub fn reset_history(&mut self) {
        self.live = None;
    }

    /// Drop the working buffers, their bind groups and Live's history (a frame without meshlets):
    /// [`MeshletCullNode::bytes`] goes to 0 and the next meshlet frame makes them again.
    pub fn release(&mut self) {
        self.frame = None;
        self.groups = None;
        self.live = None;
    }

    /// Queue `frame`'s uniforms (both passes) and candidate table.
    pub fn write(&self, queue: &Queue, frame: &MeshletFrame, history: HistoryUse, render: (u32, u32), reversed: bool) {
        let Some(buffers) = &self.frame else { return };
        let mut bytes = vec![0u8; (UNIFORM_STRIDE * 2) as usize];
        for (slot, pass) in [CullPass::First, CullPass::Second].into_iter().enumerate() {
            let at = slot * UNIFORM_STRIDE as usize;
            bytes[at..at + size_of::<GpuMeshletCull>()].copy_from_slice(bytemuck::bytes_of(&frame.uniform(pass, history, render, reversed)));
        }
        queue.write_buffer(&self.uniforms, 0, &bytes);
        queue.write_buffer(&self.regions, 0, bytemuck::bytes_of(&frame.region_table()));
        queue.write_buffer(&buffers.meshlet_instances, 0, bytemuck::cast_slice(&frame.instances));
    }

    /// Record one pass of the cull: three dispatches in one compute pass (pass 1 over every view,
    /// pass 2 over the camera's). Nothing when the node was not prepared.
    pub fn encode(&self, encoder: &mut CommandEncoder, frame: &MeshletFrame, pass: CullPass) {
        self.encode_timed(encoder, frame, pass, None);
    }

    /// [`MeshletCullNode::encode`] with the pass's timestamp writes (the cost rows).
    fn encode_timed(&self, encoder: &mut CommandEncoder, frame: &MeshletFrame, pass: CullPass, timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'_>>) {
        let Some((_, groups)) = &self.groups else { return };
        let (slot, rows) = match pass {
            CullPass::First => (0, frame.views),
            CullPass::Second => (1, 1),
        };
        let blocks = scan_blocks(frame.candidates);
        let mut compute = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("meshlet cull"), timestamp_writes });
        // Each dispatch is its own usage scope: one's writes are complete before the next reads.
        compute.set_pipeline(&self.mark);
        compute.set_bind_group(0, &groups.mark[slot], &[]);
        compute.dispatch_workgroups(blocks, 1, rows);
        compute.set_pipeline(&self.scan);
        compute.set_bind_group(0, &groups.scan[slot], &[]);
        compute.dispatch_workgroups(1, 1, rows);
        compute.set_pipeline(&self.scatter);
        compute.set_bind_group(0, &groups.scatter[slot], &[]);
        compute.dispatch_workgroups(blocks, 1, rows);
    }

    /// The draws' group (group [`crate::layout::MESHLET_DRAW_GROUP`]).
    pub fn draw_group(&self) -> Option<&BindGroup> {
        self.groups.as_ref().map(|(_, groups)| &groups.draw)
    }

    /// The compacted index buffer and the indirect argument buffer.
    pub fn draw_buffers(&self) -> Option<(&Buffer, &Buffer)> {
        self.frame.as_ref().map(|buffers| (&buffers.indices, &buffers.args))
    }

    /// Bytes of the node's working buffers on the GPU.
    pub fn bytes(&self) -> u64 {
        self.frame.as_ref().map_or(0, |buffers| {
            [&buffers.meshlet_instances, &buffers.visibility, &buffers.keep, &buffers.blocks, &buffers.totals, &buffers.args, &buffers.drawn, &buffers.indices]
                .iter()
                .map(|buffer| buffer.size())
                .sum()
        })
    }

    /// Read `frame`'s results back (diagnostics and tests): the kept meshlets and indices of every
    /// row, and every visibility bitset.
    pub fn read(&self, gpu: &Gpu, frame: &MeshletFrame) -> Result<MeshletReadback, RenderError> {
        let Some(buffers) = &self.frame else { return Err(crate::readback::capture_failed("no meshlet frame was drawn")) };
        let read_words = |source: &Buffer, words: u64| -> Result<Vec<u32>, RenderError> {
            let bytes = words.max(1) * 4;
            let staging = stage_buffer(gpu, source, 0, bytes)?;
            let data = map_read_blocking(gpu, &staging, bytes)?;
            Ok(data[..(words * 4) as usize].as_chunks::<4>().0.iter().map(|word| u32::from_le_bytes(*word)).collect())
        };
        let rows = u64::from(frame.views) + 1;
        let totals = read_words(&buffers.totals, rows * 2)?;
        let words = u64::from(visibility_words(frame.candidates));
        let bitsets = read_words(&buffers.visibility, words * u64::from(HISTORY_SLOTS))?;
        let drawn_words = read_words(&buffers.drawn, frame.slot_capacity() * 2)?;
        let indices = read_words(&buffers.indices, frame.index_capacity())?;
        let args = read_words(&buffers.args, u64::from(frame.views) * u64::from(ARGS_PER_VIEW) * 5)?;
        Ok(MeshletReadback { frame: frame.clone(), totals, bitsets, drawn: drawn_words, indices, args })
    }
}

/// One candidate-table row as the visibility history sees it: the mesh's meshlet range and the
/// row's first candidate. The global instance index is left out: a change in the number of
/// instances of a mesh drawn before the clustered ones (more cubes, a projectile) shifts every
/// index without moving a candidate, and must not cost a history reset.
type CandidateKey = [u32; 3];

/// The history key of a candidate table.
fn history_key(instances: &[GpuMeshletInstance]) -> Vec<CandidateKey> {
    instances.iter().map(candidate_key).collect()
}

fn candidate_key(row: &GpuMeshletInstance) -> CandidateKey {
    [row.first_meshlet, row.meshlet_count, row.first_candidate]
}

/// Whether `instances` lays its candidates out as `key` did (no allocation).
fn same_layout(key: &[CandidateKey], instances: &[GpuMeshletInstance]) -> bool {
    key.len() == instances.len() && key.iter().zip(instances).all(|(held, row)| *held == candidate_key(row))
}

/// Make the working buffers for `capacity`.
fn frame_buffers(device: &Device, capacity: Capacity) -> Result<FrameBuffers, RenderError> {
    let candidates = capacity.candidates.max(1);
    let rows = capacity.views + 1;
    let blocks = u64::from(scan_blocks(candidates.min(u64::from(u32::MAX)) as u32));
    let words = u64::from(visibility_words(candidates.min(u64::from(u32::MAX)) as u32));
    Ok(FrameBuffers {
        capacity,
        meshlet_instances: storage_buffer(device, "meshlet instances", capacity.instances * size_of::<GpuMeshletInstance>() as u64, BufferUsages::empty())?,
        visibility: storage_buffer(device, "meshlet visibility", words * u64::from(HISTORY_SLOTS) * 4, BufferUsages::empty())?,
        keep: storage_buffer(device, "meshlet keep", rows * candidates * 4, BufferUsages::empty())?,
        blocks: storage_buffer(device, "meshlet blocks", rows * blocks * 8, BufferUsages::empty())?,
        totals: storage_buffer(device, "meshlet totals", rows * 8, BufferUsages::empty())?,
        args: storage_buffer(device, "meshlet args", capacity.views * u64::from(ARGS_PER_VIEW) * ARGS_STRIDE, BufferUsages::INDIRECT)?,
        drawn: storage_buffer(device, "drawn meshlets", capacity.slots.max(1) * size_of::<GpuDrawnMeshlet>() as u64, BufferUsages::empty())?,
        indices: storage_buffer(device, "meshlet indices", capacity.indices.max(3) * 4, BufferUsages::INDEX)?,
    })
}

/// A frame's cull results read back ([`MeshletCullNode::read`]).
#[derive(Clone, Debug, PartialEq)]
pub struct MeshletReadback {
    /// The frame they belong to.
    pub frame: MeshletFrame,
    /// (kept meshlets, kept indices) per row: the views' pass 1, then the camera's pass 2.
    pub totals: Vec<u32>,
    /// Every visibility bitset ([`HISTORY_SLOTS`] of [`visibility_words`] words).
    pub bitsets: Vec<u32>,
    /// The drawn slots as words (instance, meshlet), every view's region.
    pub drawn: Vec<u32>,
    /// Every view's compacted index region.
    pub indices: Vec<u32>,
    /// Every view's indirect arguments.
    pub args: Vec<u32>,
}

impl MeshletReadback {
    /// Meshlets pass `pass` kept in `view` (pass 2: the camera's only).
    pub fn kept(&self, view: u32, pass: CullPass) -> u32 {
        let row = match pass {
            CullPass::First => view,
            CullPass::Second => self.frame.views,
        };
        self.totals.get(row as usize * 2).copied().unwrap_or(0)
    }

    /// Indices pass `pass` kept in `view`.
    pub fn kept_indices(&self, view: u32, pass: CullPass) -> u32 {
        let row = match pass {
            CullPass::First => view,
            CullPass::Second => self.frame.views,
        };
        self.totals.get(row as usize * 2 + 1).copied().unwrap_or(0)
    }

    /// Bitset `slot`.
    pub fn bitset(&self, slot: u32) -> VisibilityBits {
        let words = visibility_words(self.frame.candidates) as usize;
        let at = slot as usize * words;
        VisibilityBits::from_words(self.bitsets.get(at..at + words).map(<[u32]>::to_vec).unwrap_or_default())
    }

    /// The meshlets `view` draws (pass 1's, then pass 2's on the camera), in draw order.
    pub fn drawn(&self, view: u32, occlusion: bool) -> Vec<GpuDrawnMeshlet> {
        let mut count = self.kept(view, CullPass::First);
        if occlusion && view == 0 {
            count += self.kept(0, CullPass::Second);
        }
        let start = self.frame.regions.get(view as usize).map_or(0, |region| region.first_slot as usize);
        (start..start + count as usize).map(|slot| GpuDrawnMeshlet { instance: self.drawn[slot * 2], meshlet: self.drawn[slot * 2 + 1] }).collect()
    }

    /// The indices `view` draws (both passes on the camera).
    pub fn indices(&self, view: u32, occlusion: bool) -> Vec<u32> {
        let mut count = self.kept_indices(view, CullPass::First);
        if occlusion && view == 0 {
            count += self.kept_indices(0, CullPass::Second);
        }
        let start = self.frame.regions.get(view as usize).map_or(0, |region| region.first_index as usize);
        self.indices[start..start + count as usize].to_vec()
    }
}

// ---------------------------------------------------------------------------------------------
// The draw pipelines

/// What the meshlet draw pipelines are made for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshletPipelineSpec<'a> {
    /// The scene colour's format.
    pub format: TextureFormat,
    /// Samples of the world pass.
    pub samples: u32,
    /// Whether camera views draw reverse-Z.
    pub reversed: bool,
    /// The forward module's pipeline constants (the scene's surfaces).
    pub forward_constants: &'a [(&'a str, f64)],
    /// How the shadow casters land casters past a cascade's near plane on it.
    pub casters: crate::shadow::CasterDepth,
    /// The motion prepass's group 3 layout, on frames writing motion (RQ5.6): the motion variant
    /// of the prepass is made with it.
    pub motion: Option<&'a BindGroupLayout>,
}

/// The layouts the draws bind: the forward frame group, the pass view and the meshlet group.
#[derive(Clone, Copy)]
pub struct MeshletDrawLayouts<'a> {
    /// Group 0: the forward frame group.
    pub frame: &'a BindGroupLayout,
    /// Group 1: the pass view (one dynamic uniform).
    pub pass: &'a BindGroupLayout,
    /// Group 0 of the shadow casters: the shadow group (frame uniforms, instance table), never the
    /// frame group, which binds the shadow maps the casters draw into.
    pub shadow: &'a BindGroupLayout,
}

/// The meshlet draws' pipelines, each the instance path's twin with vertex pulling.
pub struct MeshletPipelines {
    /// The world pass (`fs_main`, depth written).
    pub forward: Compiled<RenderPipeline>,
    /// The world pass testing `Equal` against the prepass depth (1x only).
    pub forward_equal: Option<Compiled<RenderPipeline>>,
    /// The prepass (`fs_prepass` into the normals).
    pub prepass: Compiled<RenderPipeline>,
    /// The motion prepass (`fs_prepass_motion` into the normals, the motion and the reactive
    /// mask; RQ5.6), made when the spec names the motion group's layout.
    pub prepass_motion: Option<Compiled<RenderPipeline>>,
    /// The motion prepass into the reflections' surface texel too (lane FR,
    /// `fs_prepass_motion_rough`: the rough texel where pass 2's meshlets land), with
    /// `prepass_motion`.
    pub prepass_motion_rough: Option<Compiled<RenderPipeline>>,
    /// The shadow casters into `depth32float` maps.
    pub shadow: Compiled<RenderPipeline>,
    /// The shadow casters into `depth16unorm` maps.
    pub shadow16: Compiled<RenderPipeline>,
}

/// A fragment stage of another module: the module, its entry point and its pipeline constants.
type ForeignFragment<'a> = (&'a wgpu::ShaderModule, &'a str, &'a [(&'a str, f64)]);

/// One meshlet draw pipeline: `vertex` of the meshlet module, `fragment` of another module.
struct DrawSpec<'a> {
    label: &'a str,
    layout: &'a wgpu::PipelineLayout,
    vertex: &'a str,
    fragment: Option<ForeignFragment<'a>>,
    target: Option<TextureFormat>,
    depth: wgpu::DepthStencilState,
    samples: u32,
}

fn depth(format: TextureFormat, write: bool, compare: wgpu::CompareFunction) -> wgpu::DepthStencilState {
    wgpu::DepthStencilState { format, depth_write_enabled: Some(write), depth_compare: Some(compare), stencil: wgpu::StencilState::default(), bias: wgpu::DepthBiasState::default() }
}

impl MeshletPipelines {
    /// The pipelines of `spec` over `layouts` (and the meshlet group `node` binds).
    pub fn new(device: &Device, node: &MeshletCullNode, layouts: MeshletDrawLayouts<'_>, spec: &MeshletPipelineSpec<'_>) -> Result<MeshletPipelines, RenderError> {
        use crate::renderer::{DEPTH_FORMAT, depth_compare};
        let meshlet_module = crate::shaders::module(device, "meshlet draw", MESHLET_DRAW)?;
        let forward_module = crate::shaders::module(device, "forward", crate::shaders::FORWARD)?;
        let prepass_module = crate::shaders::module(device, "prepass", crate::shaders::PREPASS)?;
        let layout = pipeline_layout(device, "meshlet draw", &[layouts.frame, layouts.pass, &node.draw_layout]);
        let shadow_layout = pipeline_layout(device, "meshlet shadow", &[layouts.shadow, layouts.pass, &node.draw_layout]);
        let make = |draw: DrawSpec<'_>| {
            let targets = [draw.target.map(|format| wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
            crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
                label: Some(draw.label),
                layout: Some(draw.layout),
                vertex: wgpu::VertexState { module: &meshlet_module, entry_point: Some(draw.vertex), compilation_options: Default::default(), buffers: &[] },
                primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: Some(wgpu::Face::Back), ..Default::default() },
                depth_stencil: Some(draw.depth),
                multisample: wgpu::MultisampleState { count: draw.samples, ..Default::default() },
                fragment: draw.fragment.map(|(module, entry, constants)| wgpu::FragmentState {
                    module,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions { constants, ..Default::default() },
                    targets: &targets,
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let forward_fragment = Some((&forward_module, "fs_main", spec.forward_constants));
        let shadow = |format: TextureFormat| {
            let caster = crate::shadow::CasterSpec {
                label: "meshlet shadow",
                module: &meshlet_module,
                vertex: MESHLET_SHADOW_VERTEX_ENTRY,
                buffers: &[],
                layout: &shadow_layout,
                format,
                depth: spec.casters,
            };
            crate::shadow::caster_pipeline(device, &caster)
        };
        let equal = (spec.samples == 1).then(|| {
            make(DrawSpec {
                label: "meshlet forward equal",
                layout: &layout,
                vertex: MESHLET_DRAW_VERTEX_ENTRY,
                fragment: forward_fragment,
                target: Some(spec.format),
                depth: depth(DEPTH_FORMAT, false, wgpu::CompareFunction::Equal),
                samples: 1,
            })
        });
        let motion_prepass = |fragment: &str, targets: &[Option<wgpu::ColorTargetState>]| {
            spec.motion.map(|motion_layout| {
                let layout = pipeline_layout(device, "meshlet motion prepass", &[layouts.frame, layouts.pass, &node.draw_layout, motion_layout]);
                crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
                    label: Some("meshlet motion prepass"),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState { module: &meshlet_module, entry_point: Some(MESHLET_PREPASS_MOTION_VERTEX_ENTRY), compilation_options: Default::default(), buffers: &[] },
                    primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: Some(wgpu::Face::Back), ..Default::default() },
                    depth_stencil: Some(depth(DEPTH_FORMAT, true, depth_compare(true, spec.reversed))),
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState { module: &prepass_module, entry_point: Some(fragment), compilation_options: Default::default(), targets }),
                    multiview_mask: None,
                    cache: None,
                })
            })
        };
        let targets = crate::motion::TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
        let prepass_motion = motion_prepass(crate::motion::FRAGMENT_ENTRY, &targets);
        // Lane FR: prepass part 2 on a frame whose prepass wrote the reflections' surface texel.
        let prepass_motion_rough = motion_prepass(MESHLET_PREPASS_ROUGH_FRAGMENT_ENTRY, &crate::motion::surface_targets());
        Ok(MeshletPipelines {
            forward: make(DrawSpec {
                label: "meshlet forward",
                layout: &layout,
                vertex: MESHLET_DRAW_VERTEX_ENTRY,
                fragment: forward_fragment,
                target: Some(spec.format),
                depth: depth(DEPTH_FORMAT, true, depth_compare(true, spec.reversed)),
                samples: spec.samples,
            }),
            forward_equal: equal,
            prepass: make(DrawSpec {
                label: "meshlet prepass",
                layout: &layout,
                vertex: MESHLET_PREPASS_VERTEX_ENTRY,
                fragment: Some((&prepass_module, "fs_prepass", &[])),
                target: Some(crate::prepass::NORMALS_FORMAT),
                depth: depth(DEPTH_FORMAT, true, depth_compare(true, spec.reversed)),
                samples: 1,
            }),
            prepass_motion,
            prepass_motion_rough,
            shadow: shadow(crate::settings::ShadowFormat::Depth32.texture_format()),
            shadow16: shadow(crate::settings::ShadowFormat::Depth16.texture_format()),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The CPU reference and a GPU run over a supplied case

/// A Hi-Z a case's pass 2 tests against.
#[derive(Clone, Debug, PartialEq)]
pub struct CaseHiz {
    /// The render size the pyramid was built for.
    pub render: (u32, u32),
    /// Whether the depth is reversed (the pyramid holds minimums).
    pub reversed: bool,
    /// The pyramid ([`crate::hiz::reference`]).
    pub levels: Vec<HizLevel>,
}

/// One cull over supplied tables: what [`reference`] and [`run_case`] both answer.
#[derive(Clone, Debug, PartialEq)]
pub struct CullCase {
    /// The frame uniforms (the camera's `view_proj` and eye).
    pub frame: GpuFrame,
    /// The cull views' planes (the camera, then the cascades).
    pub views: GpuCullViews,
    /// Views culled.
    pub view_count: u32,
    /// The instance table.
    pub instances: Vec<GpuInstance>,
    /// The meshlet library.
    pub library: MeshletLibrary,
    /// The candidate table.
    pub meshlet_instances: Vec<GpuMeshletInstance>,
    /// Last frame's bitset (None: a reset history).
    pub history: Option<VisibilityBits>,
    /// The Hi-Z (None: no occlusion, pass 1 only).
    pub occlusion: Option<CaseHiz>,
}

impl CullCase {
    /// The case's frame on the meshlet path.
    /// The case's frame on the meshlet path: every view's region holds every candidate.
    pub fn meshlet_frame(&self) -> MeshletFrame {
        let candidates: u32 = self.meshlet_instances.iter().map(|row| row.meshlet_count).sum();
        let triangles: Vec<u32> = self
            .meshlet_instances
            .iter()
            .map(|row| self.library.meshlets[row.first_meshlet as usize..(row.first_meshlet + row.meshlet_count) as usize].iter().map(|meshlet| meshlet.triangle_count).sum())
            .collect();
        let candidate_triangles = triangles.iter().map(|t| u64::from(*t)).sum();
        let regions = (0..self.view_count)
            .map(|view| GpuViewRegion {
                first_index: (view as u64 * view_index_capacity(candidate_triangles)) as u32,
                first_slot: view * candidates,
                index_capacity: view_index_capacity(candidate_triangles) as u32,
                slot_capacity: candidates,
            })
            .collect();
        MeshletFrame {
            instances: self.meshlet_instances.clone(),
            triangles,
            candidates,
            candidate_triangles,
            views: self.view_count,
            regions,
            occlusion: self.occlusion.is_some(),
            batches: Vec::new(),
        }
    }
}

/// What one view draws: each pass's meshlets in order and the compacted indices of both.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViewDraws {
    /// Pass 1's meshlets.
    pub first: Vec<GpuDrawnMeshlet>,
    /// Pass 2's meshlets (the camera with occlusion).
    pub second: Vec<GpuDrawnMeshlet>,
    /// The view's compacted indices, pass 1's then pass 2's.
    pub indices: Vec<u32>,
}

/// A case's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CullOutcome {
    /// Per view.
    pub views: Vec<ViewDraws>,
    /// The next frame's bitset (occlusion only).
    pub visibility: Option<VisibilityBits>,
}

/// The CPU twin of `sphere_in_view`.
fn sphere_in(planes: &[[f32; 4]; 6], centre: [f32; 3], radius: f32) -> bool {
    planes.iter().all(|p| p[0] * centre[0] + p[1] * centre[1] + p[2] * centre[2] + p[3] >= -radius)
}

fn mat4(m: &[f32; 16]) -> glam::Mat4 {
    glam::Mat4::from_cols_array(m)
}

/// The CPU twin of `faces_away`.
fn faces_away(case: &CullCase, view: u32, row: &GpuInstance, meshlet: &GpuMeshlet) -> bool {
    if meshlet.cone[3] >= 1.0 {
        return false;
    }
    let model = mat4(&row.model);
    if glam::Mat3::from_mat4(model).determinant() <= 0.0 {
        return false;
    }
    let inverse = mat4(&row.normal).transpose();
    let vp = mat4(&case.frame.view_proj);
    let orthographic = view != 0 || vp.row(3).truncate() == glam::Vec3::ZERO;
    let axis = glam::Vec3::new(meshlet.cone[0], meshlet.cone[1], meshlet.cone[2]);
    if orthographic {
        let far = case.views.planes[view as usize][5];
        let direction = (inverse * glam::Vec4::new(-far[0], -far[1], -far[2], 0.0)).truncate();
        let length = direction.length();
        if length == 0.0 {
            return false;
        }
        return (direction / length).dot(axis) >= meshlet.cone[3];
    }
    let eye = (inverse * glam::Vec4::new(case.frame.camera_pos[0], case.frame.camera_pos[1], case.frame.camera_pos[2], 1.0)).truncate();
    crate::meshlet::backfacing(meshlet, eye.to_array())
}

/// The CPU twin of `hiz_occluded`.
fn hiz_occluded(case: &CullCase, hiz: &CaseHiz, centre: glam::Vec3, radius: f32) -> bool {
    let vp = mat4(&case.frame.view_proj);
    let (mut lo, mut hi) = (glam::Vec2::splat(1.0e30), glam::Vec2::splat(-1.0e30));
    let mut nearest: f32 = if hiz.reversed { -1.0e30 } else { 1.0e30 };
    for i in 0..8u32 {
        let side = glam::Vec3::new(if i & 1 != 0 { 1.0 } else { -1.0 }, if i & 2 != 0 { 1.0 } else { -1.0 }, if i & 4 != 0 { 1.0 } else { -1.0 });
        let clip = vp * (centre + side * radius).extend(1.0);
        if clip.w <= 1.0e-5 {
            return false;
        }
        let ndc = clip.truncate() / clip.w;
        lo = lo.min(ndc.truncate());
        hi = hi.max(ndc.truncate());
        nearest = if hiz.reversed { nearest.max(ndc.z) } else { nearest.min(ndc.z) };
    }
    if (hiz.reversed && nearest >= 1.0) || (!hiz.reversed && nearest <= 0.0) {
        return false;
    }
    let base = crate::hiz::base_size(hiz.render);
    let uv = glam::Vec2::new(hiz.render.0 as f32 / (2 * base.0) as f32, hiz.render.1 as f32 / (2 * base.1) as f32);
    let render = uv * 2.0 * glam::Vec2::new(base.0 as f32, base.1 as f32);
    let last = render - 1.0;
    let xs = [(lo.x * 0.5 + 0.5) * render.x, (hi.x * 0.5 + 0.5) * render.x];
    let ys = [(0.5 - hi.y * 0.5) * render.y, (0.5 - lo.y * 0.5) * render.y];
    let pixel = |v: f32, max: f32| v.floor().clamp(0.0, max) as u32;
    let (x0, x1, y0, y1) = (pixel(xs[0], last.x), pixel(xs[1], last.x), pixel(ys[0], last.y), pixel(ys[1], last.y));
    let mut level = 0usize;
    let (mut t0, mut t1);
    loop {
        let size = hiz.levels[level].size;
        t0 = ((x0 >> (level + 1)).min(size.0 - 1), (y0 >> (level + 1)).min(size.1 - 1));
        t1 = ((x1 >> (level + 1)).min(size.0 - 1), (y1 >> (level + 1)).min(size.1 - 1));
        if (t1.0 - t0.0 <= 1 && t1.1 - t0.1 <= 1) || level + 1 >= hiz.levels.len() {
            break;
        }
        level += 1;
    }
    let at = |x: u32, y: u32| hiz.levels[level].at(x, y);
    let depths = [at(t0.0, t0.1), at(t1.0, t0.1), at(t0.0, t1.1), at(t1.0, t1.1)];
    let farthest = crate::hiz::reduction(hiz.reversed).reduce(depths);
    if hiz.reversed { nearest < farthest } else { nearest > farthest }
}

/// The meshlet-instance row owning `candidate` (the shader's binary search).
fn owner_of(case: &CullCase, candidate: u32) -> Option<&GpuMeshletInstance> {
    let after = case.meshlet_instances.partition_point(|row| row.first_candidate <= candidate);
    after.checked_sub(1).map(|at| &case.meshlet_instances[at])
}

/// The CPU twin of `candidate_visible` for candidate `candidate` in `view` (`second`: pass 2,
/// where an occlusion case also tests the Hi-Z).
pub fn reference_visible(case: &CullCase, view: u32, candidate: u32, second: bool) -> bool {
    let Some(owner) = owner_of(case, candidate) else { return false };
    let row = &case.instances[owner.instance as usize];
    let meshlet = &case.library.meshlets[(owner.first_meshlet + candidate - owner.first_candidate) as usize];
    let planes = &case.views.planes[view as usize];
    if !sphere_in(planes, [row.bounds[0], row.bounds[1], row.bounds[2]], row.bounds[3]) {
        return false;
    }
    let model = mat4(&row.model);
    let centre = (model * glam::Vec4::new(meshlet.bounds[0], meshlet.bounds[1], meshlet.bounds[2], 1.0)).truncate();
    let scale = model.x_axis.truncate().length().max(model.y_axis.truncate().length()).max(model.z_axis.truncate().length());
    let radius = meshlet.bounds[3] * scale;
    if !sphere_in(planes, centre.to_array(), radius) || faces_away(case, view, row, meshlet) {
        return false;
    }
    match (&case.occlusion, second) {
        (Some(hiz), true) => !hiz_occluded(case, hiz, centre, radius),
        _ => true,
    }
}

/// Append candidate `candidate`'s draw to `draws` at global slot `slot`.
fn push_draw(case: &CullCase, draws: &mut ViewDraws, candidate: u32, slot: u32, second: bool) {
    let Some(owner) = owner_of(case, candidate) else { return };
    let meshlet_row = owner.first_meshlet + candidate - owner.first_candidate;
    let meshlet = &case.library.meshlets[meshlet_row as usize];
    let drawn = GpuDrawnMeshlet { instance: owner.instance, meshlet: meshlet_row };
    if second { draws.second.push(drawn) } else { draws.first.push(drawn) }
    for packed in &case.library.triangles[meshlet.triangle_offset as usize..(meshlet.triangle_offset + meshlet.triangle_count) as usize] {
        draws.indices.extend(unpack_triangle(*packed).map(|local| drawn_index(slot, u32::from(local))));
    }
}

/// Both passes of `case` on the CPU, in the GPU's order: what [`run_case`] must answer.
pub fn reference(case: &CullCase) -> CullOutcome {
    let frame = case.meshlet_frame();
    let occlusion = case.occlusion.is_some();
    let mut views = Vec::with_capacity(case.view_count as usize);
    for view in 0..case.view_count {
        let mut draws = ViewDraws::default();
        for candidate in 0..frame.candidates {
            let visible = reference_visible(case, view, candidate, false);
            let history = case.history.as_ref().is_some_and(|bits| bits.get(candidate));
            let kept = if view == 0 && occlusion { visible && history } else { visible };
            if kept {
                let slot = frame.regions[view as usize].first_slot + draws.first.len() as u32;
                push_draw(case, &mut draws, candidate, slot, false);
            }
        }
        views.push(draws);
    }
    let mut visibility = None;
    if occlusion {
        let mut next = VisibilityBits::new(frame.candidates);
        let first: Vec<bool> = (0..frame.candidates)
            .map(|candidate| reference_visible(case, 0, candidate, false) && case.history.as_ref().is_some_and(|bits| bits.get(candidate)))
            .collect();
        for candidate in 0..frame.candidates {
            let visible = reference_visible(case, 0, candidate, true);
            next.set(candidate, visible);
            if visible && !first[candidate as usize] {
                let draws = &mut views[0];
                let slot = frame.regions[0].first_slot + (draws.first.len() + draws.second.len()) as u32;
                push_draw(case, draws, candidate, slot, true);
            }
        }
        visibility = Some(next);
    }
    CullOutcome { views, visibility }
}

/// The GPU objects a case runs on.
struct CaseRun {
    node: MeshletCullNode,
    frame: MeshletFrame,
    _hiz: Option<wgpu::Texture>,
    _buffers: [Buffer; 4],
    _library: MeshletBuffers,
}

/// Upload `case` and prepare a node for it.
fn case_run(gpu: &Gpu, case: &CullCase) -> Result<CaseRun, RenderError> {
    let device = &gpu.device;
    let upload = |label, bytes: &[u8], usage: BufferUsages| -> Result<Buffer, RenderError> {
        let target = buffer(device, label, aligned(bytes.len() as u64), usage | BufferUsages::COPY_DST)?;
        gpu.queue.write_buffer(&target, 0, bytes);
        Ok(target)
    };
    let views = upload("case views", bytemuck::bytes_of(&case.views), BufferUsages::UNIFORM)?;
    let frame_uniforms = upload("case frame", bytemuck::bytes_of(&case.frame), BufferUsages::UNIFORM)?;
    let instances = upload("case instances", bytemuck::cast_slice(&case.instances), BufferUsages::STORAGE)?;
    let vertices = upload("case vertices", &[0u8; 48], BufferUsages::STORAGE)?;
    let mut node = MeshletCullNode::new(device)?;
    let library = MeshletBuffers::upload(device, &gpu.queue, &case.library)?;
    let hiz = case.occlusion.as_ref().map(|hiz| upload_pyramid(gpu, hiz));
    let hiz_view = hiz.as_ref().map(|texture| texture.create_view(&Default::default()));
    let frame = case.meshlet_frame();
    let externals = CullExternals { views: &views, frame: &frame_uniforms, instances: &instances, vertices: &vertices, library: &library, hiz: hiz_view.as_ref() };
    node.prepare(device, &frame, &externals)?;
    let history = HistoryUse { prev: 0, next: 1, reset: case.history.is_none() };
    let render = case.occlusion.as_ref().map_or((1, 1), |hiz| hiz.render);
    let reversed = case.occlusion.as_ref().is_some_and(|hiz| hiz.reversed);
    node.write(&gpu.queue, &frame, history, render, reversed);
    if let (Some(bits), Some(buffers)) = (&case.history, &node.frame) {
        gpu.queue.write_buffer(&buffers.visibility, 0, bytemuck::cast_slice(bits.words()));
    }
    Ok(CaseRun { node, frame, _hiz: hiz, _buffers: [views, frame_uniforms, instances, vertices], _library: library })
}

/// A pyramid texture holding `hiz`'s levels.
fn upload_pyramid(gpu: &Gpu, hiz: &CaseHiz) -> wgpu::Texture {
    let base = hiz.levels.first().map_or((1, 1), |level| level.size);
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("case hi-z"),
        size: wgpu::Extent3d { width: base.0, height: base.1, depth_or_array_layers: 1 },
        mip_level_count: hiz.levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: crate::hiz::HIZ_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (mip, level) in hiz.levels.iter().enumerate() {
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip as u32, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&level.texels),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(level.size.0 * 4), rows_per_image: Some(level.size.1) },
            wgpu::Extent3d { width: level.size.0, height: level.size.1, depth_or_array_layers: 1 },
        );
    }
    texture
}

/// Run both passes of `case` on the GPU and read the result back: what [`reference`] answers.
pub fn run_case(gpu: &Gpu, case: &CullCase) -> Result<CullOutcome, RenderError> {
    let run = case_run(gpu, case)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("meshlet cull case") });
    run.node.encode(&mut encoder, &run.frame, CullPass::First);
    if run.frame.occlusion {
        run.node.encode(&mut encoder, &run.frame, CullPass::Second);
    }
    gpu.queue.submit([encoder.finish()]);
    let read = run.node.read(gpu, &run.frame)?;
    let views = (0..run.frame.views)
        .map(|view| {
            let all = read.drawn(view, run.frame.occlusion);
            let split = read.kept(view, CullPass::First) as usize;
            ViewDraws { first: all[..split].to_vec(), second: all[split..].to_vec(), indices: read.indices(view, run.frame.occlusion) }
        })
        .collect();
    let visibility = run.frame.occlusion.then(|| read.bitset(1));
    Ok(CullOutcome { views, visibility })
}

/// The GPU milliseconds of `case`'s cull (pass 1 over every view, then pass 2 when it occludes),
/// one per sample of `samples`, from timestamps around its passes; None without `TIMESTAMP_QUERY`.
/// The cull node's cost row (R2.4: recorded at 5 and 9 views).
pub fn case_gpu_ms(gpu: &Gpu, case: &CullCase, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let run = case_run(gpu, case)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("meshlet cull cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "meshlet cull cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("meshlet cull cost") });
        let passes: &[CullPass] = if run.frame.occlusion { &[CullPass::First, CullPass::Second] } else { &[CullPass::First] };
        for (i, pass) in passes.iter().enumerate() {
            let (first, last) = (i == 0, i + 1 == passes.len());
            let stamps = wgpu::ComputePassTimestampWrites { query_set: &query_set, beginning_of_pass_write_index: first.then_some(0), end_of_pass_write_index: last.then_some(1) };
            run.node.encode_timed(&mut encoder, &run.frame, *pass, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| crate::readback::capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("meshlet cull cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reset_history_marks_nothing_and_bits_round_trip() {
        let mut bits = VisibilityBits::new(70);
        assert_eq!(bits.words().len(), 3);
        bits.set(0, true);
        bits.set(33, true);
        bits.set(69, true);
        bits.set(500, true);
        assert!(bits.get(0) && bits.get(33) && bits.get(69) && !bits.get(1) && !bits.get(500));
        assert_eq!(bits.count(), 3);
        bits.set(33, false);
        assert!(!bits.get(33));
        bits.reset();
        assert!(bits.words().iter().all(|word| *word == 0));
    }

    #[test]
    fn the_scan_and_buffers_are_sized_from_the_candidates() {
        assert_eq!((scan_blocks(0), scan_blocks(256), scan_blocks(257)), (1, 1, 2));
        assert_eq!(scan_blocks(100_000), 391);
        assert_eq!((visibility_words(0), visibility_words(32), visibility_words(33)), (1, 1, 2));
        assert_eq!(compacted_index_bytes(1_000, 3), 36_000);
        let core = wgpu::Limits::defaults();
        assert!(view_indices_fit(10_000_000, &core));
        assert!(!view_indices_fit(12_000_000, &core), "past core's 128 MiB storage binding");
        assert_eq!((CullPass::First.shader_id(), CullPass::Second.shader_id()), (1, 2));
        assert!(occlusion_landed());
        assert_eq!((args_offset(0, ArgsSlot::First), args_offset(0, ArgsSlot::All), args_offset(1, ArgsSlot::First)), (0, 40, 60));
    }

    #[test]
    fn the_flags_carry_the_history_slots_and_the_switches() {
        let live = HistoryUse { prev: 1, next: 0, reset: false };
        assert_eq!(live.flags(true), FLAG_OCCLUSION | (1 << HISTORY_PREV_SHIFT));
        let capture = HistoryUse { prev: CAPTURE_HISTORY_SLOT, next: CAPTURE_HISTORY_SLOT, reset: true };
        let flags = capture.flags(true);
        assert_eq!((flags >> HISTORY_NEXT_SHIFT) & 3, CAPTURE_HISTORY_SLOT);
        assert_ne!(flags & FLAG_HISTORY_RESET, 0);
        assert_eq!(live.flags(false) & FLAG_OCCLUSION, 0);
    }

    fn frame_of(batches: Vec<bool>, views: u32) -> MeshletFrame {
        MeshletFrame { instances: Vec::new(), triangles: Vec::new(), candidates: 10, candidate_triangles: 100, views, regions: Vec::new(), occlusion: false, batches }
    }

    #[test]
    fn clustered_batches_split_the_instance_paths_multi_draws_only_in_meshlet_views() {
        let frame = frame_of(vec![false, true, true, false, false, true], 1);
        assert_eq!(frame.whole_runs(0, 0..6), vec![0..1, 3..5]);
        assert_eq!(frame.whole_runs(1, 0..6), vec![0..6], "a cascade past the meshlet views draws every batch whole");
        assert_eq!(frame.whole_runs(0, 6..8), vec![6..8], "skinned batches are never clustered");
        assert!(frame.draws(0, 1) && !frame.draws(1, 1) && !frame.draws(0, 0));
    }

    /// A box view of half-size 10 around `x`.
    fn box_view(x: f32) -> [[f32; 4]; 6] {
        [[1.0, 0.0, 0.0, 10.0 - x], [-1.0, 0.0, 0.0, 10.0 + x], [0.0, 1.0, 0.0, 10.0], [0.0, -1.0, 0.0, 10.0], [0.0, 0.0, 1.0, 10.0], [0.0, 0.0, -1.0, 10.0]]
    }

    fn two_instances(triangles: [u32; 2]) -> (MeshletFrame, Vec<GpuInstance>) {
        let at = |x: f32| {
            let mut model = [0.0; 16];
            (model[0], model[5], model[10], model[15], model[12]) = (1.0, 1.0, 1.0, 1.0, x);
            crate::instance::instance_row(&model, [0.0; 3], 1.0, 0)
        };
        let rows = vec![
            GpuMeshletInstance { instance: 0, first_meshlet: 0, meshlet_count: 4, first_candidate: 0 },
            GpuMeshletInstance { instance: 1, first_meshlet: 4, meshlet_count: 6, first_candidate: 4 },
        ];
        let total = triangles.iter().map(|t| u64::from(*t)).sum();
        let frame = MeshletFrame { instances: rows, triangles: triangles.to_vec(), candidates: 10, candidate_triangles: total, views: 0, regions: Vec::new(), occlusion: false, batches: Vec::new() };
        (frame, vec![at(0.0), at(100.0)])
    }

    #[test]
    fn each_view_is_sized_for_the_instances_its_frustum_holds_and_views_stop_at_the_binding() {
        let core = wgpu::Limits::defaults();
        let planes = [box_view(0.0), box_view(100.0)];
        let (mut frame, instances) = two_instances([1_000, 2_000_000]);
        assert_eq!(frame.fit(&planes, 2, &instances, &core), 2);
        let first = GpuViewRegion { first_index: 0, first_slot: 0, index_capacity: 3_000, slot_capacity: 4 };
        assert_eq!(frame.regions, vec![first, GpuViewRegion { first_index: 3_000, first_slot: 4, index_capacity: 6_000_000, slot_capacity: 6 }]);
        assert_eq!((frame.index_capacity(), frame.slot_capacity()), (6_003_000, 10));
        let (mut frame, instances) = two_instances([1_000, 12_000_000]);
        assert_eq!(frame.fit(&planes, 2, &instances, &core), 1, "the cascade's 144 MB pass core's 128 MiB binding: it draws whole");
        assert_eq!(frame.regions, vec![first]);
        let (mut frame, instances) = two_instances([12_000_000, 1_000]);
        assert_eq!(frame.fit(&[box_view(0.0), box_view(0.0)], 2, &instances, &core), 0, "not even the camera's: every batch draws whole");
    }
}
