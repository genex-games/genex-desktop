//! What the renderer draws and how a frame becomes GPU tables. A [`Scene`] (camera, lights, draws,
//! skinned draws, lines) becomes a [`FramePlan`]: the instance table, the deduplicated material
//! table, the light table, one batch per mesh (ascending mesh id) and one per opaque skinned draw,
//! the cull views (camera, then the drawn shadow cascades, of the nine views reserved), the skinning
//! jobs and the back-to-front transparent rows. The plan also runs the CPU frustum cull that is the reference for the compute
//! pass. The facade converts its `Frame` into a `Scene` (M0a.5); the tagged draw counter stays in
//! the facade, before culling, and [`FramePlan::logical_draws`] mirrors it.
//!
//! Every instance row also carries its identity across frames ([`FramePlan::motion`], RQ5.1): the
//! draw id the game named with [`Scene::set_id`] and the row's ordinal within that id, else its
//! mesh and its ordinal within its batch. [`crate::motion::MotionHistory`] matches rows by it to
//! find last frame's transforms for motion vectors.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

use genex_core::map::FastMap;

use crate::caps::BUFFER_MAX_BYTES;
use crate::cull::{CullLod, active_views, cascade_view, cpu_cull_view};
use crate::error::{RenderCode, RenderError};
use crate::instance::instance_row;
use crate::layout::{GpuBatch, GpuMeshlet, GpuCullViews, GpuFrame, GpuInstance, GpuLight, GpuMaterial, GpuMaterialExt, GpuSkinJob, GpuSkinVertex, MAX_CASCADES, NO_BATCH, SHADOW_CASCADES};
use crate::mesh::{LOD_NOMINAL_HEIGHT, LOD_THRESHOLD_PX, LodChain, MeshData, Vertex};
use crate::mesh_arena::{ArenaStream, Rewrite, RowAllocator};
use crate::meshlet::{self, MeshletLibrary, MeshletRange, MeshletSet};
use crate::motion::{DrawId, MotionKeys, MotionRow, RowKind};
use crate::pbr::{MaterialKey, light_table, radiance};
use crate::lod_rows::{DrawLod, FAR_RULE_NONE, FAR_RULES_MAX, GpuFarRule, GpuLodRow, far_rule_usable, lod_row};
use crate::retained::{InstanceGroup, RetainedSpan};
use crate::settings::{Meshlets, ShadowSettings};
use crate::shadow::{Cascades, camera_forward, fit};
use crate::skin::{MAX_JOINTS, SkinId, SkinPart, SkinnedMeshData, skinned_bounds};
use crate::skinned_lod::{SkinLods, SkinnedLevel, SkinnedLodInput, SkinnedPick, pick_level};
use crate::transparent::back_to_front;

pub use crate::cull::{CpuCull, frustum_planes, frustum_planes_for, in_frustum};
pub use crate::pbr::{Lighting, Material, PointLight, srgb_to_linear};

/// A mesh in a [`MeshLibrary`]: its slot and the generation of that slot it was handed out in
/// (game systems STR-2). Removing a mesh moves its slot to the next generation, so the slot can
/// hold another mesh while the old id names none: a draw of it is skipped and counted
/// ([`FramePlan::stale_rows`]), never drawn as the new mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MeshId {
    index: u32,
    generation: u32,
}

impl MeshId {
    /// The unit cube.
    pub const CUBE: MeshId = MeshId::from_raw(0);
    /// The unit-radius sphere.
    pub const SPHERE: MeshId = MeshId::from_raw(1);
    /// The last id in order (a range's end).
    const LAST: MeshId = MeshId { index: u32::MAX, generation: u32::MAX };

    /// The id of slot `raw` in its first generation (it may name no mesh).
    pub const fn from_raw(raw: u32) -> MeshId {
        MeshId { index: raw, generation: 0 }
    }

    /// The raw value: the mesh's slot (the per-vertex slot and the frame's slot tables index it).
    pub const fn raw(self) -> u32 {
        self.index
    }

    /// The generation of its slot the id was handed out in (0 until a mesh in the slot is removed).
    pub const fn generation(self) -> u32 {
        self.generation
    }

    /// Its slot and generation as one integer (distinct ids, distinct values).
    pub(crate) const fn packed(self) -> u64 {
        ((self.index as u64) << 32) | self.generation as u64
    }
}

/// Where a mesh sits in the shared vertex and index buffers, and its model-space bounds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshEntry {
    /// First index in the shared index buffer.
    pub first_index: u32,
    /// Indices.
    pub index_count: u32,
    /// Base vertex in the shared vertex buffer.
    pub base_vertex: i32,
    /// Vertices.
    pub vertex_count: u32,
    /// Bounding sphere centre.
    pub center: [f32; 3],
    /// Bounding sphere radius.
    pub radius: f32,
}

/// How a library mesh draws on the meshlet path (R2.1).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MeshletState {
    /// Drawn whole: the game's meshlets are off, the mesh is under `min_triangles`, or it is skinned
    /// (skinning moves the vertices its spheres and cones would be built from).
    Whole,
    /// Clustered: its rows of the library's meshlet table.
    Clustered(MeshletRange),
    /// Drawn whole although it qualifies, for the typed reason: `buffer-too-large` when its
    /// meshlets would take a meshlet buffer past the storage binding ([`crate::BUFFER_MAX_BYTES`]),
    /// `mesh-invalid` when its indices are not a triangle list over its vertices.
    Refused(RenderCode),
}

/// One part of a model as the library takes it: its mesh, the meshlets it brought (a GLB's
/// `genex_meshlets`, R2.3) and its levels of detail (a GLB's `genex_lods`, renderer pass 2 A6.9).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelPart {
    /// The mesh.
    pub mesh: MeshData,
    /// Its imported meshlets, used when it is clustered and they are valid.
    pub meshlets: Option<MeshletSet>,
    /// Its import-time levels, coarser and coarser.
    pub lods: Option<LodChain>,
}

impl ModelPart {
    /// A part with neither meshlets nor levels.
    pub fn whole(mesh: MeshData) -> ModelPart {
        ModelPart { mesh, meshlets: None, lods: None }
    }
}

/// A model part with its level meshes made and its chain checked, ready for the room check.
struct PlannedPart {
    mesh: MeshData,
    meshlets: Option<MeshletSet>,
    /// Level k's mesh at `levels[k - 1]`.
    levels: Vec<MeshData>,
    /// The chain's errors, when the part kept one.
    errors: Option<Vec<f32>>,
}

impl PlannedPart {
    /// `part` with a chain whose level indexes past its vertices dropped (it draws whole).
    fn of(part: ModelPart) -> PlannedPart {
        let ModelPart { mesh, meshlets, lods } = part;
        let vertex_count = mesh.vertices.len() as u32;
        let chain = lods.filter(|chain| chain.levels.iter().all(|level| level.indices.iter().all(|index| *index < vertex_count)));
        let levels = chain.iter().flat_map(|chain| chain.levels.iter().map(|level| level_mesh(&mesh, &level.indices))).collect();
        PlannedPart { errors: chain.map(|chain| chain.errors()), mesh, meshlets, levels }
    }
}

/// Bytes of one entry's meshlet rows.
fn meshlet_span_bytes(span: &MeshletSpan) -> u64 {
    let [(_, meshlets), (_, vertices), (_, triangles)] = *span;
    u64::from(meshlets) * u64::from(meshlet::MESHLET_RECORD_BYTES) + (u64::from(vertices) + u64::from(triangles)) * 4
}

/// Refused `buffer-too-large` with `detail`.
fn refuse_too_large<T>(detail: String) -> Result<T, RenderError> {
    Err(RenderError::refused(RenderCode::BufferTooLarge, detail))
}

/// A library mesh's levels of detail (renderer pass 2 A6.9): each level a mesh of its own (the
/// level's triangles over the vertices they use), with the chain's object-space errors.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshLods {
    /// Level k's mesh at `levels[k - 1]` (level 0 is the mesh itself).
    pub levels: Vec<MeshId>,
    /// Their object-space errors, never decreasing.
    pub errors: Vec<f32>,
}

/// A library mesh's impostor level (game systems LOD-15): one more level past its mesh levels,
/// in the same cull. Its chain keeps at most [`crate::mesh::LOD_IMPOSTOR_MESH_LEVELS`] mesh
/// levels; past them the impostor is drawn. Every part of a compound model declares one with
/// the same error (and the model's draws a shared LOD sphere, [`DrawLod::origin`]), so the parts
/// switch together; only the lead part names the species whose quad draws, the others just stop
/// drawing. Shadow views cast the last mesh level in the impostor's place (option A).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshImpostor {
    /// The baked species the impostor draws ([`crate::impostor::GpuImpostor::layer`]); `None`
    /// for a part of a compound other than its lead.
    pub species: Option<u32>,
    /// The impostor level's error over the radius of the LOD sphere it is measured from
    /// ([`crate::mesh::impostor_level_error`]).
    pub error: f32,
}

impl MeshImpostor {
    /// The lead part's impostor: its level draws `species`' quad.
    pub const fn lead(species: u32, error: f32) -> MeshImpostor {
        MeshImpostor { species: Some(species), error }
    }

    /// Another part of a compound: it draws nothing at the impostor level.
    pub const fn part(error: f32) -> MeshImpostor {
        MeshImpostor { species: None, error }
    }
}

/// One impostor batch of a plan (game systems LOD-15): the lead part's batch at its chain's
/// impostor level, or its fade twin, whose camera survivors (its region of the visible list,
/// with their fades for a twin) are the copies the impostor draw draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImpostorBatch {
    /// Its index in [`FramePlan::batches`].
    pub batch: u32,
    /// The species it draws.
    pub species: u32,
}

/// How a library entry came in: its role decides whether it is clustered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryRole {
    /// A mesh a game draws.
    Mesh,
    /// A skinned mesh's bind pose (never clustered: skinning moves its vertices).
    Skinned,
    /// A level of another mesh (never clustered, never drawn by a game: the plan draws it).
    Level,
    /// A slot held with no rows while a replay re-creates the ids of a removed upload
    /// ([`MeshLibrary::hold_slot`]); its removal follows.
    Held,
    /// A free slot: its mesh was removed.
    Removed,
}

/// The meshlet-table rows a clustered entry took: (offset, rows) in the meshlet table, the
/// meshlet vertices and the triangles.
type MeshletSpan = [(u32, u32); 3];

/// A slot's entry while it holds no rows (freed, or held for a replay).
const EMPTY_ENTRY: MeshEntry = MeshEntry { first_index: 0, index_count: 0, base_vertex: 0, vertex_count: 0, center: [0.0; 3], radius: 0.0 };

/// Where one mesh's rows go: its first vertex and first index.
#[derive(Clone, Copy, Debug)]
struct Placement {
    base_vertex: u32,
    first_index: u32,
}

/// The meshlet tables' streams (a re-cluster replaces them whole).
const MESHLET_STREAMS: [ArenaStream; 3] = ArenaStream::MESHLET;

/// Write `new` at row `offset` of `rows`, growing it with defaults; a write below its old length
/// (a freed range filled again) is noted in `rewrites` for the arena.
fn put_rows<T: Copy + Default>(rows: &mut Vec<T>, offset: u32, new: &[T], stream: ArenaStream, rewrites: &mut Vec<Rewrite>) {
    let (old, start) = (rows.len(), offset as usize);
    let end = start + new.len();
    if end > old {
        rows.resize(end, T::default());
    }
    rows[start..end].copy_from_slice(new);
    if start < old && !new.is_empty() {
        rewrites.push((stream, offset..end as u32));
    }
}

/// Every mesh a renderer can draw, packed into one vertex and one index list, with a per-vertex
/// slot (its mesh id), the skin rows of skinned meshes and the meshlets of the meshes the game's
/// [`Meshlets`] setting clusters (R2.1).
#[derive(Clone, Debug)]
pub struct MeshLibrary {
    vertices: Vec<Vertex>,
    slots: Vec<u32>,
    indices: Vec<u32>,
    entries: Vec<MeshEntry>,
    skin: Vec<GpuSkinVertex>,
    /// Every skinned mesh's parts (AN-16a), each mesh's a run named by its [`SkinId`].
    skin_parts: Vec<SkinPart>,
    /// The levels of skinned meshes (game systems AN-25), by the base mesh's entry.
    skin_lods: BTreeMap<u32, SkinLods>,
    meshlet_setting: Meshlets,
    meshlets: MeshletLibrary,
    /// Per entry: how it draws on the meshlet path.
    meshlet_states: Vec<MeshletState>,
    /// Per entry: how it came in.
    roles: Vec<EntryRole>,
    /// The levels of the meshes that brought them (A6.9), by entry.
    lods: BTreeMap<u32, MeshLods>,
    /// The impostor levels set on meshes (game systems LOD-15), by entry.
    impostors: BTreeMap<u32, MeshImpostor>,
    /// The valid sets meshes brought with them (R2.3's `genex_meshlets`), by entry, kept for a
    /// re-cluster.
    imported: BTreeMap<u32, MeshletSet>,
    /// Per slot: the generation its live id carries (moved on when its mesh is removed).
    generations: Vec<u32>,
    /// Slots whose mesh was removed, reused smallest first (a slot whose generation ran out is
    /// never reused).
    free_slots: BTreeSet<u32>,
    /// Where vertices (and their slots) go.
    vertex_rows: RowAllocator,
    /// Where indices go.
    index_rows: RowAllocator,
    /// Where the meshlet table, the meshlet vertices and the triangles go.
    meshlet_rows: [RowAllocator; 3],
    /// Per slot: the meshlet rows its meshlets took.
    meshlet_spans: Vec<Option<MeshletSpan>>,
    /// Rows written again below a stream's length since the arena last took them.
    rewrites: Vec<Rewrite>,
}

impl Default for MeshLibrary {
    fn default() -> Self {
        MeshLibrary::new()
    }
}

impl MeshLibrary {
    /// A library holding the immediate primitives ([`MeshId::CUBE`], [`MeshId::SPHERE`]),
    /// clustering by [`Meshlets::DEFAULT`].
    pub fn new() -> MeshLibrary {
        MeshLibrary::with_meshlets(Meshlets::DEFAULT)
    }

    /// A library holding the immediate primitives that clusters the meshes `setting` names.
    pub fn with_meshlets(setting: Meshlets) -> MeshLibrary {
        let mut library = MeshLibrary {
            vertices: Vec::new(),
            slots: Vec::new(),
            indices: Vec::new(),
            entries: Vec::new(),
            skin: Vec::new(),
            skin_parts: Vec::new(),
            skin_lods: BTreeMap::new(),
            meshlet_setting: setting,
            meshlets: MeshletLibrary::default(),
            meshlet_states: Vec::new(),
            roles: Vec::new(),
            lods: BTreeMap::new(),
            impostors: BTreeMap::new(),
            imported: BTreeMap::new(),
            generations: Vec::new(),
            free_slots: BTreeSet::new(),
            vertex_rows: RowAllocator::default(),
            index_rows: RowAllocator::default(),
            meshlet_rows: Default::default(),
            meshlet_spans: Vec::new(),
            rewrites: Vec::new(),
        };
        for mesh in [MeshData::cube(), MeshData::sphere()] {
            let placement = library.place(&mesh).expect("the built-in primitives fit an empty library");
            library.push(mesh, EntryRole::Mesh, None, placement);
        }
        library
    }

    /// Cluster by the game's `setting` from now on: when it clusters other meshes
    /// ([`Meshlets::same_clusters`]) every mesh is re-clustered, in add order, so the meshlet
    /// buffers equal those of a library that had `setting` from the start; an occlusion-only
    /// change moves no cluster.
    pub fn set_meshlets(&mut self, setting: Meshlets) {
        let reclusters = !self.meshlet_setting.same_clusters(&setting);
        self.meshlet_setting = setting;
        if !reclusters {
            return;
        }
        self.meshlets = MeshletLibrary::default();
        self.meshlet_rows = Default::default();
        self.meshlet_spans.fill(None);
        // The tables go up whole once re-clustered (`Renderer::set_meshlets`).
        self.rewrites.retain(|(stream, _)| !MESHLET_STREAMS.contains(stream));
        self.meshlet_states.clear();
        for entry in 0..self.entries.len() {
            let state = self.cluster(entry);
            self.meshlet_states.push(state);
        }
    }

    /// The game's meshlet setting the library clusters by.
    pub fn meshlet_setting(&self) -> Meshlets {
        self.meshlet_setting
    }

    /// The meshlet buffers: every clustered mesh's meshlets, vertex ids in the library's range.
    pub fn meshlets(&self) -> &MeshletLibrary {
        &self.meshlets
    }

    /// How the mesh draws on the meshlet path; `None` for an unknown id.
    pub fn meshlet_state(&self, id: MeshId) -> Option<MeshletState> {
        self.meshlet_states.get(id.index as usize).copied()
    }

    /// Entry `entry`'s meshlet state, appending its meshlets when it is clustered: its imported set
    /// when that is valid, else [`meshlet::build`]'s.
    fn cluster(&mut self, entry: usize) -> MeshletState {
        let mesh = self.entries[entry];
        if self.roles[entry] != EntryRole::Mesh || !self.meshlet_setting.clusters(mesh.index_count / 3) {
            return MeshletState::Whole;
        }
        // Taken out while the tables take its rows, and put back.
        let imported = self.imported.remove(&(entry as u32));
        let state = self.cluster_with(entry, mesh, imported.as_ref());
        if let Some(set) = imported {
            self.imported.insert(entry as u32, set);
        }
        state
    }

    /// [`MeshLibrary::cluster`] of `mesh` (entry `entry`) with the set it brought, if any.
    fn cluster_with(&mut self, entry: usize, mesh: MeshEntry, imported: Option<&MeshletSet>) -> MeshletState {
        let base = mesh.base_vertex as usize;
        let indices = &self.indices[mesh.first_index as usize..(mesh.first_index + mesh.index_count) as usize];
        let set = match imported.filter(|set| meshlet::validate(set, indices, mesh.vertex_count).is_ok()) {
            Some(set) => Cow::Borrowed(set),
            None => {
                let positions: Vec<[f32; 3]> = self.vertices[base..base + mesh.vertex_count as usize].iter().map(|v| v.position).collect();
                let Ok(set) = meshlet::build(indices, &positions) else { return MeshletState::Refused(RenderCode::MeshInvalid) };
                Cow::Owned(set)
            }
        };
        match self.place_meshlets(entry, &set, base as u32) {
            Ok(range) => MeshletState::Clustered(range),
            Err(refusal) => MeshletState::Refused(refusal.code()),
        }
    }

    /// Write `set` (a mesh whose first vertex is library vertex `base_vertex`) into the meshlet
    /// tables at rows their allocators give it, for slot `entry`: offsets move to the tables' and
    /// vertex ids to the library's range. Refused `buffer-too-large`, nothing written, when a table
    /// would pass the storage binding ([`BUFFER_MAX_BYTES`]) or `u32` rows.
    fn place_meshlets(&mut self, entry: usize, set: &MeshletSet, base_vertex: u32) -> Result<MeshletRange, RenderError> {
        let counts = [set.meshlets.len(), set.vertices.len(), set.triangles.len()].map(|rows| u32::try_from(rows).ok());
        let mut span: MeshletSpan = [(0, 0); 3];
        for (table, rows) in counts.into_iter().enumerate() {
            let offset = rows.and_then(|rows| self.meshlet_rows[table].allocate(rows).map(|offset| (offset, rows)));
            match offset {
                Some(placed) => span[table] = placed,
                None => return Err(self.unplace_meshlets(&span[..table])),
            }
        }
        let lengths = [self.meshlets.meshlets.len(), self.meshlets.vertices.len(), self.meshlets.triangles.len()];
        let ends: Vec<u64> = span.iter().zip(lengths).map(|((offset, rows), len)| u64::from(offset + rows).max(len as u64)).collect();
        let bytes = (ends[0] * u64::from(meshlet::MESHLET_RECORD_BYTES)).max(ends[1].max(ends[2]) * 4);
        if bytes > BUFFER_MAX_BYTES {
            return Err(self.unplace_meshlets(&span));
        }
        let [(first, count), (vertex_base, _), (triangle_base, _)] = span;
        let records: Vec<_> = set.meshlets.iter().map(|m| GpuMeshlet { vertex_offset: m.vertex_offset + vertex_base, triangle_offset: m.triangle_offset + triangle_base, ..*m }).collect();
        let vertices: Vec<u32> = set.vertices.iter().map(|vertex| vertex + base_vertex).collect();
        put_rows(&mut self.meshlets.meshlets, first, &records, ArenaStream::Meshlets, &mut self.rewrites);
        put_rows(&mut self.meshlets.vertices, vertex_base, &vertices, ArenaStream::MeshletVertices, &mut self.rewrites);
        put_rows(&mut self.meshlets.triangles, triangle_base, &set.triangles, ArenaStream::MeshletTriangles, &mut self.rewrites);
        self.meshlet_spans[entry] = Some(span);
        Ok(MeshletRange { first_meshlet: first, meshlet_count: count })
    }

    /// Give back the meshlet rows of `span` (latest first) and answer the refusal for a set that
    /// does not fit.
    fn unplace_meshlets(&mut self, span: &[(u32, u32)]) -> RenderError {
        for (table, (offset, rows)) in span.iter().enumerate().rev() {
            self.meshlet_rows[table].free(*offset, *rows);
        }
        RenderError::refused(RenderCode::BufferTooLarge, format!("meshlet tables past the {BUFFER_MAX_BYTES}-byte storage binding"))
    }

    /// A slot for a new entry: the smallest freed one (its generation already moved on), else a
    /// new one at the end.
    fn acquire_slot(&mut self) -> MeshId {
        if let Some(index) = self.free_slots.pop_first() {
            return MeshId { index, generation: self.generations[index as usize] };
        }
        let index = self.entries.len() as u32;
        self.entries.push(EMPTY_ENTRY);
        self.roles.push(EntryRole::Removed);
        self.meshlet_states.push(MeshletState::Whole);
        self.generations.push(0);
        self.meshlet_spans.push(None);
        MeshId { index, generation: 0 }
    }

    /// Put `mesh` at `placement` (rows [`MeshLibrary::place`] took) in a new slot.
    fn push(&mut self, mesh: MeshData, role: EntryRole, imported: Option<MeshletSet>, placement: Placement) -> MeshId {
        let (center, radius) = mesh.bounds();
        let id = self.acquire_slot();
        let at = id.index as usize;
        self.entries[at] = MeshEntry {
            first_index: placement.first_index,
            index_count: mesh.indices.len() as u32,
            base_vertex: placement.base_vertex as i32,
            vertex_count: mesh.vertices.len() as u32,
            center,
            radius,
        };
        let slots = vec![id.index; mesh.vertices.len()];
        put_rows(&mut self.slots, placement.base_vertex, &slots, ArenaStream::Slots, &mut self.rewrites);
        put_rows(&mut self.vertices, placement.base_vertex, &mesh.vertices, ArenaStream::Vertices, &mut self.rewrites);
        put_rows(&mut self.indices, placement.first_index, &mesh.indices, ArenaStream::Indices, &mut self.rewrites);
        self.roles[at] = role;
        if let Some(set) = imported {
            self.imported.insert(id.index, set);
        }
        self.meshlet_states[at] = self.cluster(at);
        id
    }

    /// Take rows for `mesh`'s vertices and indices; refused, with nothing taken, as
    /// [`MeshLibrary::check_rows`] refuses the library they would make.
    fn place(&mut self, mesh: &MeshData) -> Result<Placement, RenderError> {
        let rows = (u32::try_from(mesh.vertices.len()).ok(), u32::try_from(mesh.indices.len()).ok());
        let full = || RenderError::refused(RenderCode::MeshInvalid, "the library is full");
        let (Some(vertex_rows), Some(index_rows)) = rows else { return Err(full()) };
        let base_vertex = self.vertex_rows.allocate(vertex_rows).ok_or_else(full)?;
        let Some(first_index) = self.index_rows.allocate(index_rows) else {
            self.vertex_rows.free(base_vertex, vertex_rows);
            return Err(full());
        };
        let placement = Placement { base_vertex, first_index };
        let vertices = (base_vertex as usize + mesh.vertices.len()).max(self.vertices.len());
        let indices = (first_index as usize + mesh.indices.len()).max(self.indices.len());
        if let Err(refusal) = self.check_rows(vertices, indices) {
            self.unplace(mesh, placement);
            return Err(refusal);
        }
        Ok(placement)
    }

    /// Give back the rows [`MeshLibrary::place`] took for `mesh`.
    fn unplace(&mut self, mesh: &MeshData, placement: Placement) {
        self.index_rows.free(placement.first_index, mesh.indices.len() as u32);
        self.vertex_rows.free(placement.base_vertex, mesh.vertices.len() as u32);
    }

    /// Refused `mesh-invalid` when `mesh` is empty.
    fn check_mesh(mesh: &MeshData) -> Result<(), RenderError> {
        if mesh.indices.is_empty() || mesh.vertices.is_empty() {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "empty mesh, or the library is full"));
        }
        Ok(())
    }

    /// Refused when a library of `vertices` and `indices` would not fit: `mesh-invalid` past
    /// `i32` vertices or `u32` indices, `buffer-too-large` past the GPU's binding.
    fn check_rows(&self, vertices: usize, indices: usize) -> Result<(), RenderError> {
        if i32::try_from(vertices).is_err() || u32::try_from(indices).is_err() {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "the library is full"));
        }
        let vertex_bytes = vertices as u64 * size_of::<Vertex>() as u64;
        let index_bytes = indices as u64 * 4;
        if vertex_bytes.max(index_bytes) > BUFFER_MAX_BYTES {
            let detail = format!("{vertex_bytes} bytes of vertices and {index_bytes} of indices, past the {BUFFER_MAX_BYTES}-byte binding");
            return Err(RenderError::refused(RenderCode::BufferTooLarge, detail));
        }
        Ok(())
    }

    /// Add a mesh; refused `mesh-invalid` when it is empty or the library would exceed `u32` indices.
    /// A mesh the game's [`Meshlets`] setting names is clustered ([`MeshLibrary::meshlet_state`]).
    pub fn add(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.add_with_meshlets(mesh, None)
    }

    /// [`MeshLibrary::add`] with the meshlets the mesh brought (a GLB's `genex_meshlets`, R2.3):
    /// used when the mesh is clustered and the set passes [`meshlet::validate`] against it, else
    /// the mesh is clustered at runtime.
    pub fn add_with_meshlets(&mut self, mesh: MeshData, imported: Option<MeshletSet>) -> Result<MeshId, RenderError> {
        MeshLibrary::check_mesh(&mesh)?;
        let placement = self.place(&mesh)?;
        Ok(self.push(mesh, EntryRole::Mesh, imported, placement))
    }

    /// [`MeshLibrary::add_with_meshlets`] for a model part, its levels of detail kept as meshes of
    /// their own (renderer pass 2 A6.9: each level's triangles over the vertices it uses, its
    /// bounding sphere the part's, so every level is culled as the part is). A chain whose level
    /// indexes past the part's vertices is dropped (the part draws whole); a level the library
    /// has no room for refuses the part with nothing added.
    pub fn add_part(&mut self, part: ModelPart) -> Result<MeshId, RenderError> {
        let ids = self.add_parts(vec![part])?;
        ids.first().copied().ok_or_else(|| RenderError::refused(RenderCode::MeshInvalid, "no part was added"))
    }

    /// [`MeshLibrary::add_part`] for every part of one model, all or nothing: every part and level
    /// takes its rows before any is added, so a refused part adds none of them and gives back the
    /// rows the parts before it took (the library is never copied to roll one back).
    pub fn add_parts(&mut self, parts: Vec<ModelPart>) -> Result<Vec<MeshId>, RenderError> {
        let planned: Vec<PlannedPart> = parts.into_iter().map(PlannedPart::of).collect();
        let mut placed: Vec<(&MeshData, Placement)> = Vec::new();
        let mut refused = None;
        for mesh in planned.iter().flat_map(|part| std::iter::once(&part.mesh).chain(&part.levels)) {
            match MeshLibrary::check_mesh(mesh).and_then(|()| self.place(mesh)) {
                Ok(placement) => placed.push((mesh, placement)),
                Err(refusal) => {
                    refused = Some(refusal);
                    break;
                }
            }
        }
        if let Some(refusal) = refused {
            for (mesh, placement) in placed.into_iter().rev() {
                self.unplace(mesh, placement);
            }
            return Err(refusal);
        }
        let mut placements = placed.into_iter().map(|(_, placement)| placement).collect::<Vec<_>>().into_iter();
        Ok(planned.into_iter().map(|part| self.push_part(part, &mut placements)).collect())
    }

    /// Push a part and its levels at the rows taken for them, in order.
    fn push_part(&mut self, part: PlannedPart, placements: &mut impl Iterator<Item = Placement>) -> MeshId {
        let PlannedPart { mesh, meshlets, levels, errors } = part;
        let (center, radius) = mesh.bounds();
        let mut next = || placements.next().expect("a placement per part and level");
        let id = self.push(mesh, EntryRole::Mesh, meshlets, next());
        let mut ids = Vec::with_capacity(levels.len());
        for level in levels {
            let level_id = self.push(level, EntryRole::Level, None, next());
            let entry = &mut self.entries[level_id.index as usize];
            (entry.center, entry.radius) = (center, radius);
            ids.push(level_id);
        }
        if let Some(errors) = errors.filter(|_| !ids.is_empty()) {
            self.lods.insert(id.index, MeshLods { levels: ids, errors });
        }
        id
    }

    /// The levels of detail mesh `id` brought ([`MeshLibrary::add_part`]), if any.
    pub fn lods(&self, id: MeshId) -> Option<&MeshLods> {
        self.lods.get(&id.index).filter(|_| self.is_live(id))
    }

    /// End mesh `id`'s chain with an impostor level, or take it away (`None`; game systems
    /// LOD-15). Refused `mesh-invalid` for an id the library does not hold, a level of another
    /// mesh, a skinned mesh, or an error that is not finite and positive. A mesh drawn on the
    /// meshlet path keeps drawing whole meshes there (only whole meshes have levels).
    pub fn set_impostor(&mut self, id: MeshId, impostor: Option<MeshImpostor>) -> Result<(), RenderError> {
        let refuse = |why: &str| Err(RenderError::refused(RenderCode::MeshInvalid, format!("mesh {} (generation {}) {why}", id.index, id.generation)));
        if !self.is_live(id) {
            return refuse("is not in the library");
        }
        if self.roles[id.index as usize] != EntryRole::Mesh {
            return refuse("is not a mesh a game draws: no impostor level");
        }
        let Some(impostor) = impostor else {
            self.impostors.remove(&id.index);
            return Ok(());
        };
        if !(impostor.error > 0.0 && impostor.error.is_finite()) {
            return refuse("has an impostor error that is not finite and positive");
        }
        self.impostors.insert(id.index, impostor);
        Ok(())
    }

    /// Mesh `id`'s impostor level ([`MeshLibrary::set_impostor`]), if any.
    pub fn impostor(&self, id: MeshId) -> Option<MeshImpostor> {
        self.impostors.get(&id.index).copied().filter(|_| self.is_live(id))
    }

    /// Add a skinned mesh: its bind pose as a mesh and its skin rows, one part drawn with one
    /// material. Refused `mesh-invalid` when the skin rows and vertices differ in number, a joint
    /// index is past its joints, it has more than [`MAX_JOINTS`] joints or its inverse bind
    /// matrices do not match them.
    pub fn add_skinned(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        self.add_skinned_parts(data, &[SkinPart::whole(&data.mesh)])
    }

    /// [`MeshLibrary::add_skinned`] with its parts (AN-16a, [`crate::skin::SkinnedModel::parts`]):
    /// each part skins and draws on its own, under its own material. Refused `mesh-invalid`, as
    /// `add_skinned` refuses, and when there is no part, a part is empty or reaches past the mesh's
    /// vertices or indices, its indices are not whole triangles, or one of its indices names a
    /// vertex outside the part.
    pub fn add_skinned_parts(&mut self, data: &SkinnedMeshData, parts: &[SkinPart]) -> Result<SkinId, RenderError> {
        let joints = data.skeleton.joints.len();
        let refuse = |detail: String| Err(RenderError::refused(RenderCode::MeshInvalid, detail));
        if data.skin.len() != data.mesh.vertices.len() {
            return refuse(format!("{} skin rows for {} vertices", data.skin.len(), data.mesh.vertices.len()));
        }
        if joints == 0 || joints > MAX_JOINTS || data.skeleton.inverse_bind.len() != joints {
            return refuse(format!("{joints} joints (1..={MAX_JOINTS}) with {} inverse bind matrices", data.skeleton.inverse_bind.len()));
        }
        if data.skin.iter().any(|row| row.joints.iter().any(|&j| j as usize >= joints)) {
            return refuse(format!("a joint index is past the skin's {joints} joints"));
        }
        let skin_base = u32::try_from(self.skin.len()).map_err(|_| RenderError::refused(RenderCode::MeshInvalid, "the library is full"))?;
        let skin_bytes = (self.skin.len() + data.skin.len()) as u64 * size_of::<GpuSkinVertex>() as u64;
        if skin_bytes > BUFFER_MAX_BYTES {
            return refuse_too_large(format!("{skin_bytes} bytes of skin rows, past the {BUFFER_MAX_BYTES}-byte binding"));
        }
        MeshLibrary::check_mesh(&data.mesh)?;
        check_skin_parts(&data.mesh, parts)?;
        let part_base = u32::try_from(self.skin_parts.len()).map_err(|_| RenderError::refused(RenderCode::MeshInvalid, "the library is full"))?;
        let placement = self.place(&data.mesh)?;
        let mesh = self.push(data.mesh.clone(), EntryRole::Skinned, None, placement);
        self.skin.extend_from_slice(&data.skin);
        self.skin_parts.extend_from_slice(parts);
        Ok(SkinId { mesh, skin_base, joints: joints as u32, part_base, parts: parts.len() as u32 })
    }

    /// The parts of skinned mesh `skin` (AN-16a): one for a mesh added whole.
    pub fn skin_parts(&self, skin: SkinId) -> &[SkinPart] {
        let start = skin.part_base as usize;
        self.skin_parts.get(start..start + skin.parts as usize).unwrap_or(&[])
    }

    /// Give skinned mesh `base` (added from `data`) its simplified `levels` (game systems AN-25,
    /// [`crate::skinned_lod::skinned_levels`]): each is added as a skinned mesh over the same
    /// skeleton, and a draw of `base` then skins the level its distance picks. Refused
    /// `mesh-invalid`, nothing added, when `base` is not this library's, already has levels, a level
    /// has another number of parts than `base`, more than [`crate::mesh::LOD_MAX_LEVELS`] levels
    /// are given, their errors are not finite and rising, or a level is refused as
    /// [`MeshLibrary::add_skinned_parts`] refuses.
    pub fn add_skinned_levels(&mut self, base: SkinId, data: &SkinnedMeshData, levels: &[SkinnedLevel]) -> Result<(), RenderError> {
        let refuse = |detail: &str| Err(RenderError::refused(RenderCode::MeshInvalid, format!("skinned levels of mesh {}: {detail}", base.mesh.raw())));
        if !self.is_live(base.mesh) || self.skin_parts(base).len() != base.parts as usize || self.skin_lods.contains_key(&base.mesh.index) {
            return refuse("the mesh is not this library's skinned mesh, or already has levels");
        }
        if levels.len() > crate::mesh::LOD_MAX_LEVELS as usize || levels.iter().any(|level| level.parts.len() != base.parts as usize) {
            return refuse("too many levels, or a level's parts are not the mesh's");
        }
        let rising = levels.iter().try_fold(0.0_f32, |floor, level| (level.error.is_finite() && level.error >= floor).then_some(level.error));
        if rising.is_none() {
            return refuse("the levels' errors are not finite and rising");
        }
        for level in levels {
            let skinned = SkinnedMeshData { mesh: level.mesh.clone(), skin: level.skin.clone(), skeleton: data.skeleton.clone(), animations: Vec::new() };
            MeshLibrary::check_mesh(&skinned.mesh)?;
            check_skin_parts(&skinned.mesh, &level.parts)?;
        }
        let mut lods = SkinLods::default();
        for level in levels {
            let skinned = SkinnedMeshData { mesh: level.mesh.clone(), skin: level.skin.clone(), skeleton: data.skeleton.clone(), animations: Vec::new() };
            lods.levels.push(self.add_skinned_parts(&skinned, &level.parts)?);
            lods.errors.push(level.error);
        }
        if !lods.levels.is_empty() {
            self.skin_lods.insert(base.mesh.index, lods);
        }
        Ok(())
    }

    /// The levels of skinned mesh `skin` (game systems AN-25), if it has any.
    pub fn skin_lods(&self, skin: SkinId) -> Option<&SkinLods> {
        self.skin_lods.get(&skin.mesh.index).filter(|_| self.is_live(skin.mesh))
    }

    /// Remove mesh `id` and its levels of detail (game systems STR-2): their rows go back to the
    /// allocators for the next mesh that fits, their slots move to the next generation (so `id`
    /// and its levels' ids name nothing from now on) and are reused smallest first. Answers every
    /// id freed, the mesh's first. Refused `mesh-invalid`, nothing removed, for an id that names
    /// no mesh (unknown or already removed), a level (remove its mesh), a skinned mesh (its skin
    /// rows are not freed yet) and the built-in cube and sphere (immediate draws name them).
    pub fn remove(&mut self, id: MeshId) -> Result<Vec<MeshId>, RenderError> {
        let refuse = |why: &str| Err(RenderError::refused(RenderCode::MeshInvalid, format!("mesh {} (generation {}) {why}", id.index, id.generation)));
        if !self.is_live(id) {
            return refuse("is not in the library");
        }
        if id.index <= MeshId::SPHERE.index {
            return refuse("is a built-in primitive and stays");
        }
        match self.roles[id.index as usize] {
            EntryRole::Level => return refuse("is a level of detail: remove its mesh"),
            EntryRole::Skinned => return refuse("is skinned: skinned meshes are not removed yet"),
            EntryRole::Mesh | EntryRole::Held | EntryRole::Removed => {}
        }
        let levels = self.lods.remove(&id.index).map(|lods| lods.levels).unwrap_or_default();
        let freed: Vec<MeshId> = std::iter::once(id).chain(levels).collect();
        for slot in &freed {
            self.vacate(*slot);
        }
        Ok(freed)
    }

    /// Free slot `id` whatever it holds (a replay's removal of each id a removal freed): its rows,
    /// its meshlet rows and the slot, its generation moved on. Answers whether it held anything.
    pub(crate) fn vacate(&mut self, id: MeshId) -> bool {
        let at = id.index as usize;
        let held = at < self.entries.len() && self.generations[at] == id.generation && self.roles[at] != EntryRole::Removed;
        if !held {
            return false;
        }
        let entry = self.entries[at];
        self.vertex_rows.free(entry.base_vertex as u32, entry.vertex_count);
        self.index_rows.free(entry.first_index, entry.index_count);
        if let Some(span) = self.meshlet_spans[at].take() {
            for (table, (offset, rows)) in span.into_iter().enumerate() {
                self.meshlet_rows[table].free(offset, rows);
            }
        }
        self.entries[at] = EMPTY_ENTRY;
        self.roles[at] = EntryRole::Removed;
        self.meshlet_states[at] = MeshletState::Whole;
        self.imported.remove(&id.index);
        self.lods.remove(&id.index);
        self.impostors.remove(&id.index);
        if let Some(next) = self.generations[at].checked_add(1) {
            self.generations[at] = next;
            self.free_slots.insert(id.index);
        }
        true
    }

    /// Hold the next slot with no rows (a replay re-creating the ids of an upload whose meshes
    /// were all removed: the removal that follows frees it), answering its id.
    pub(crate) fn hold_slot(&mut self) -> MeshId {
        let id = self.acquire_slot();
        self.roles[id.index as usize] = EntryRole::Held;
        id
    }

    /// Whether `id` names a mesh the library holds now (not removed, not a stale generation).
    fn is_live(&self, id: MeshId) -> bool {
        let at = id.index as usize;
        let live = |role: EntryRole| !matches!(role, EntryRole::Removed | EntryRole::Held);
        self.roles.get(at).is_some_and(|role| live(*role)) && self.generations[at] == id.generation
    }

    /// Whether `id` names a slot of this library whose mesh was removed (a stale id): a draw of it
    /// is skipped and counted, where an id the library never handed out is refused.
    pub fn is_removed(&self, id: MeshId) -> bool {
        (id.index as usize) < self.entries.len() && !self.is_live(id)
    }

    /// The mesh's entry; None for an unknown or removed id.
    pub fn entry(&self, id: MeshId) -> Option<&MeshEntry> {
        self.is_live(id).then(|| &self.entries[id.index as usize])
    }

    /// Mesh slots in the library, live and freed (the frame's slot tables are this long).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Meshes the library holds now (levels of detail included).
    pub fn live_meshes(&self) -> usize {
        self.roles.iter().filter(|role| !matches!(role, EntryRole::Removed | EntryRole::Held)).count()
    }

    /// The rows written again below a stream's length since the last take (freed rows a new
    /// mesh filled), for [`crate::mesh_arena::MeshArena::sync_with`].
    pub fn take_rewrites(&mut self) -> Vec<Rewrite> {
        std::mem::take(&mut self.rewrites)
    }

    /// Bytes the live meshes' rows take in every stream the arena mirrors (vertices with their
    /// slots, indices, skin rows and meshlet rows): what a library with no freed rows would hold.
    pub fn live_bytes(&self) -> u64 {
        let vertex = size_of::<Vertex>() as u64 + 4;
        let meshes: u64 = self
            .entries
            .iter()
            .zip(&self.roles)
            .filter(|(_, role)| !matches!(role, EntryRole::Removed | EntryRole::Held))
            .map(|(entry, _)| u64::from(entry.vertex_count) * vertex + u64::from(entry.index_count) * 4)
            .sum();
        let meshlets: u64 = self.meshlet_spans.iter().flatten().map(meshlet_span_bytes).sum();
        meshes + size_of_val(self.skin.as_slice()) as u64 + meshlets
    }

    /// Bytes every stream the arena mirrors spans now, freed rows included (the arena holds at
    /// least this much).
    pub fn span_bytes(&self) -> u64 {
        let rows = size_of_val(self.vertices.as_slice()) + self.slots.len() * 4 + self.indices.len() * 4 + size_of_val(self.skin.as_slice());
        rows as u64 + self.meshlets.bytes()
    }

    /// Whether it holds no mesh (never, after [`MeshLibrary::new`]).
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Every vertex.
    pub fn vertices(&self) -> &[Vertex] {
        &self.vertices
    }

    /// Every vertex's slot (its mesh id).
    pub fn slots(&self) -> &[u32] {
        &self.slots
    }

    /// Every index.
    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    /// Every skin row.
    pub fn skin(&self) -> &[GpuSkinVertex] {
        &self.skin
    }
}

/// A 3D camera: perspective with `fovy_degrees`, or orthographic when `ortho_height` is set.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraDesc {
    /// Eye position.
    pub eye: [f32; 3],
    /// Point looked at.
    pub target: [f32; 3],
    /// Up direction.
    pub up: [f32; 3],
    /// Vertical field of view in degrees.
    pub fovy_degrees: f32,
    /// Near plane distance.
    pub near: f32,
    /// Far plane distance.
    pub far: f32,
    /// The view's height in world units for an orthographic camera (an object's size on screen
    /// does not change with its distance); `None` is perspective.
    pub ortho_height: Option<f32>,
}

impl CameraDesc {
    /// A 45° camera at `eye` looking at `target`, +Y up, near 0.1, far 1000.
    pub fn look_at(eye: [f32; 3], target: [f32; 3]) -> CameraDesc {
        CameraDesc { eye, target, up: [0.0, 1.0, 0.0], fovy_degrees: 45.0, near: 0.1, far: 1000.0, ortho_height: None }
    }

    /// This camera made orthographic, `height` world units tall.
    pub fn orthographic(self, height: f32) -> CameraDesc {
        CameraDesc { ortho_height: Some(height), ..self }
    }

    /// Half the view's height at `depth` along the view direction.
    pub fn half_height_at(&self, depth: f32) -> f32 {
        match self.ortho_height {
            Some(height) => height * 0.5,
            None => depth * libm::tanf(self.fovy_degrees.to_radians() * 0.5),
        }
    }

    /// Projection × view for a target of `aspect` (width / height), depth 0..1.
    pub fn view_proj(&self, aspect: f32) -> Mat4 {
        // Right-handed, depth 0..1, NDC Y up: wgpu's clip space ("directx" in glam's camera module).
        let proj = match self.ortho_height {
            Some(height) => {
                let (half_h, half_w) = (height * 0.5, height * 0.5 * aspect);
                glam::camera::rh::proj::directx::orthographic(-half_w, half_w, -half_h, half_h, self.near, self.far)
            }
            None => glam::camera::rh::proj::directx::perspective(self.fovy_degrees.to_radians(), aspect, self.near, self.far),
        };
        proj * self.view()
    }

    /// Projection × view with reversed depth (RQ1.1, the HDR path): the near plane at depth 1 and
    /// the far plane at 0, drawn with `Greater` against a depth cleared to 0, so `Depth32Float`'s
    /// precision follows the distance. The camera's far plane is kept (the same draws survive the
    /// cull as with standard Z); a perspective camera whose `far` is infinite gets the infinite
    /// reversed projection.
    pub fn view_proj_reversed(&self, aspect: f32) -> Mat4 {
        use glam::camera::rh::proj::directx;
        // Swapping near and far reverses depth without the cancellation of flipping the matrix.
        let proj = match self.ortho_height {
            Some(height) => {
                let (half_h, half_w) = (height * 0.5, height * 0.5 * aspect);
                directx::orthographic(-half_w, half_w, -half_h, half_h, self.far, self.near)
            }
            None if self.far.is_infinite() => directx::perspective_infinite_reverse(self.fovy_degrees.to_radians(), aspect, self.near),
            None => directx::perspective(self.fovy_degrees.to_radians(), aspect, self.far, self.near),
        };
        proj * self.view()
    }

    /// Projection × view with standard (`reversed` false: [`CameraDesc::view_proj`]) or reversed
    /// depth ([`CameraDesc::view_proj_reversed`]).
    pub fn projection(&self, aspect: f32, reversed: bool) -> Mat4 {
        if reversed { self.view_proj_reversed(aspect) } else { self.view_proj(aspect) }
    }

    fn view(&self) -> Mat4 {
        glam::camera::rh::view::look_at_mat4(Vec3::from(self.eye), Vec3::from(self.target), Vec3::from(self.up))
    }
}

/// One mesh draw.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawItem {
    /// The mesh.
    pub mesh: MeshId,
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Its material.
    pub material: Material,
    /// The draw id current when it was drawn ([`Scene::set_id`]), if any (RQ5.1 motion vectors).
    pub id: Option<DrawId>,
    /// How its levels are chosen, current when it was drawn ([`Scene::set_lod`], game systems LOD-02).
    pub lod: DrawLod,
}

/// One draw of a retained instance group (renderer pass 2 A.0b).
#[derive(Clone, Debug, PartialEq)]
pub struct GroupDraw {
    /// The group.
    pub group: InstanceGroup,
    /// The material its instances draw with.
    pub material: Material,
    /// The draw id current when it was drawn ([`Scene::set_id`]), if any.
    pub id: Option<DrawId>,
    /// How its instances' levels are chosen ([`Scene::set_lod`], game systems LOD-02).
    pub lod: DrawLod,
}

/// One part of a skinned draw skinned in the vertex stage (game systems AN-18): its draw (an index
/// into [`Scene::skinned`]), its part and its material row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VertexSkinnedPart {
    /// The draw, an index into [`Scene::skinned`].
    pub draw: u32,
    /// The part of its skin.
    pub part: u32,
    /// Its row in [`FramePlan::materials`].
    pub material: u32,
    /// The skin it draws: the draw's own, or the level its distance picks (game systems AN-25).
    pub skin: SkinId,
}

/// One skinned draw: a skinned mesh posed by its joint matrices.
#[derive(Clone, Debug, PartialEq)]
pub struct SkinnedDraw {
    /// The skinned mesh.
    pub skin: SkinId,
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// One matrix per joint ([`crate::skin::Skeleton::joint_matrices`]).
    pub joints: Vec<[f32; 16]>,
    /// Its material.
    pub material: Material,
    /// The draw id current when it was drawn ([`Scene::set_id`]), if any (RQ5.1 motion vectors).
    pub id: Option<DrawId>,
    /// One material per part of its skin ([`Scene::draw_skinned_parts`], AN-16a); empty: every
    /// part draws with `material`.
    pub part_materials: Vec<Material>,
}

impl SkinnedDraw {
    /// The material part `part` draws with.
    pub fn part_material(&self, part: usize) -> Material {
        self.part_materials.get(part).copied().unwrap_or(self.material)
    }
}

/// A line vertex: position and sRGB colour.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct LineVertex {
    /// World position.
    pub position: [f32; 3],
    /// sRGB colour in 0..1 (alpha ignored: lines are opaque).
    pub color: [f32; 4],
}

impl LineVertex {
    /// A vertex at `position` in the 8-bit sRGB `color` (what [`Scene::line`] stores).
    pub fn srgb(position: [f32; 3], color: [u8; 4]) -> LineVertex {
        LineVertex { position, color: color.map(|c| f32::from(c) / 255.0) }
    }
}

/// A frame's water (renderer pass 2 B.3): one body and the water's clock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneWater {
    /// The rectangle drawn and how it looks.
    pub body: crate::water::WaterBody,
    /// The water's clock, seconds (the simulation's, so a capture is the same every time).
    pub time: f32,
}

/// A frame to draw.
#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    /// The camera.
    pub camera: CameraDesc,
    /// The sRGB colour the world target clears to.
    pub clear: [u8; 4],
    /// The lights.
    pub lighting: Lighting,
    /// Mesh draws, in order (an instanced draw adds one per instance).
    pub draws: Vec<DrawItem>,
    /// Skinned draws, in order.
    pub skinned: Vec<SkinnedDraw>,
    /// Line vertices, two per line.
    pub lines: Vec<LineVertex>,
    /// Retained instance groups drawn, in order (renderer pass 2 A.0b).
    pub groups: Vec<GroupDraw>,
    /// The water drawn over the opaque scene (renderer pass 2 B.3; None: no water).
    pub water: Option<SceneWater>,
    /// The levels' fade band (game systems LOD-03; `beta` of [`crate::mesh::lod_band`], in
    /// (0, 1]): while a level's projected error is within the last `lod_band` of the threshold it
    /// crossfades with the finer level through its fade batches. 0 (the default) is the hard
    /// switch and plans no fade batch; so does a value outside (0, 1]. The faded pipelines that
    /// draw the fade batches are LOD-04's: until then no frame draws them.
    pub lod_band: f32,
    /// The far rules draws thin by (game systems LOD-18): a draw whose [`DrawLod::far_rule`] is
    /// `k` thins by `far_rules[k - 1]` ([`crate::lod_rows::far_field`]). The first
    /// [`crate::lod_rows::FAR_RULES_MAX`] count; a rule `far_rule_usable` refuses leaves its
    /// draws alone.
    pub far_rules: Vec<GpuFarRule>,
    logical_draws: u32,
    /// The draw id later draws carry ([`Scene::set_id`]).
    id: Option<DrawId>,
    /// How later draws' levels are chosen ([`Scene::set_lod`]).
    lod: DrawLod,
}

impl Scene {
    /// An empty scene.
    pub fn new(camera: CameraDesc, clear: [u8; 4]) -> Scene {
        Scene {
            camera,
            clear,
            lighting: Lighting::default(),
            draws: Vec::new(),
            skinned: Vec::new(),
            lines: Vec::new(),
            groups: Vec::new(),
            water: None,
            lod_band: 0.0,
            far_rules: Vec::new(),
            logical_draws: 0,
            id: None,
            lod: DrawLod::OWN,
        }
    }

    /// How the following draws' levels are chosen (game systems LOD-02): the model-space sphere
    /// every part of a compound model measures from, so its parts switch together, and the bias
    /// (2 holds each level twice as far). [`DrawLod::OWN`] (the default) measures each part from
    /// its own bounds at the recorded errors.
    pub fn set_lod(&mut self, lod: DrawLod) -> &mut Self {
        self.lod = lod;
        self
    }

    /// How the following draws' levels are chosen.
    pub fn lod(&self) -> DrawLod {
        self.lod
    }

    /// The far rule `rule` as a draw names it ([`DrawLod::far_rule`], game systems LOD-19): 1 +
    /// its index in [`Scene::far_rules`], added the first time a frame names it (an equal rule is
    /// shared); [`FAR_RULE_NONE`] once the frame holds [`FAR_RULES_MAX`] other rules, so its copies
    /// draw unthinned rather than under another rule.
    pub fn far_rule(&mut self, rule: GpuFarRule) -> u32 {
        let index = |at: usize| u32::try_from(at + 1).unwrap_or(FAR_RULE_NONE);
        if let Some(at) = self.far_rules.iter().position(|held| *held == rule) {
            return index(at);
        }
        if self.far_rules.len() >= FAR_RULES_MAX {
            return FAR_RULE_NONE;
        }
        self.far_rules.push(rule);
        index(self.far_rules.len() - 1)
    }

    /// The draw id the following draws carry (`frame.id(key)` in the facade), `None` for none:
    /// motion vectors find a draw's last transform by its id and its ordinal within the id, so a
    /// moving object keeps its history when other draws come and go. Draws without an id fall
    /// back to their mesh and their ordinal within its batch.
    pub fn set_id(&mut self, id: Option<DrawId>) -> &mut Self {
        self.id = id;
        self
    }

    /// The draw id the following draws carry.
    pub fn id(&self) -> Option<DrawId> {
        self.id
    }

    /// Draw `mesh` under `model`: one logical draw.
    pub fn draw(&mut self, mesh: MeshId, model: [f32; 16], material: Material) -> &mut Self {
        self.draws.push(DrawItem { mesh, model, material, id: self.id, lod: self.lod });
        self.logical_draws += 1;
        self
    }

    /// Draw `mesh` once per model: one logical draw, however many instances.
    pub fn draw_instanced(&mut self, mesh: MeshId, models: &[[f32; 16]], material: Material) -> &mut Self {
        let (id, lod) = (self.id, self.lod);
        self.draws.extend(models.iter().map(|model| DrawItem { mesh, model: *model, material, id, lod }));
        self.logical_draws += 1;
        self
    }

    /// Draw a retained instance group (renderer pass 2 A.0b): what [`Scene::draw_instanced`] of
    /// its mesh, transforms and material draws, one logical draw, with its rows computed once and
    /// uploaded only when they change ([`InstanceGroup`]).
    pub fn draw_group(&mut self, group: &InstanceGroup) -> &mut Self {
        self.draw_group_with(group, group.material())
    }

    /// [`Scene::draw_group`] with `material` instead of the group's own (the facade resolves its
    /// textures each frame): its rows are still the group's, only their material row changes.
    pub fn draw_group_with(&mut self, group: &InstanceGroup, material: Material) -> &mut Self {
        self.groups.push(GroupDraw { group: group.clone(), material, id: self.id, lod: self.lod });
        self.logical_draws += 1;
        self
    }

    /// Instances the scene draws through mesh draws and retained groups.
    pub fn mesh_instances(&self) -> usize {
        self.draws.len() + self.groups.iter().map(|draw| draw.group.len()).sum::<usize>()
    }

    /// Draw a skinned mesh posed by `joints`, every part with `material`: one logical draw.
    pub fn draw_skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, material: Material) -> &mut Self {
        self.skinned.push(SkinnedDraw { skin, model, joints, material, id: self.id, part_materials: Vec::new() });
        self.logical_draws += 1;
        self
    }

    /// Draw a skinned mesh posed by `joints`, each part with its own material (AN-16a): one
    /// logical draw. `materials` holds one per part ([`SkinId::part_count`]); the frame is refused
    /// `mesh-invalid` otherwise.
    pub fn draw_skinned_parts(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, materials: Vec<Material>) -> &mut Self {
        // A draw naming no material is refused at the plan (every skin has a part); white stands in.
        let material = materials.first().copied().unwrap_or(Material::color([255; 4]));
        self.skinned.push(SkinnedDraw { skin, model, joints, material, id: self.id, part_materials: materials });
        self.logical_draws += 1;
        self
    }

    /// Draw a line segment: one logical draw.
    pub fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]) -> &mut Self {
        self.lines.push(LineVertex::srgb(from, color));
        self.lines.push(LineVertex::srgb(to, color));
        self.logical_draws += 1;
        self
    }

    /// Draw `vertices` as line segments, each pair one segment (a trailing odd vertex is
    /// dropped): one logical draw however many segments (NAV-15), none when there is no segment.
    /// The segments draw what [`Scene::line`] draws for each pair.
    pub fn lines(&mut self, vertices: &[LineVertex]) -> &mut Self {
        let whole = vertices.len() - vertices.len() % 2;
        if whole == 0 {
            return self;
        }
        self.lines.extend_from_slice(&vertices[..whole]);
        self.logical_draws += 1;
        self
    }

    /// Draw calls the scene was given (an instanced draw is one), before any culling.
    pub fn logical_draws(&self) -> u32 {
        self.logical_draws
    }
}

/// A model matrix that only moves.
pub fn translation(x: f32, y: f32, z: f32) -> [f32; 16] {
    Mat4::from_translation(Vec3::new(x, y, z)).to_cols_array()
}

/// A model matrix that scales per axis, then moves.
pub fn scaled(position: [f32; 3], scale: [f32; 3]) -> [f32; 16] {
    Mat4::from_scale_rotation_translation(Vec3::from(scale), glam::Quat::IDENTITY, Vec3::from(position)).to_cols_array()
}

/// Where a transparent draw's vertices come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawSource {
    /// From the skinned output instead of the library.
    pub skinned: bool,
    /// First index in the library's index buffer.
    pub first_index: u32,
    /// Indices.
    pub index_count: u32,
    /// Base vertex in its vertex buffer.
    pub base_vertex: i32,
}

/// The output a plan's levels of detail are chosen for (game systems AN-25): its height and the
/// quality's error threshold, as [`FramePlan::set_lod_view`] takes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LodTarget {
    /// The output's height in pixels.
    pub height: u32,
    /// The error threshold in output pixels ([`crate::settings::LodQuality::threshold_px`]).
    pub threshold_px: f32,
}

impl LodTarget {
    /// The view a plan holds until [`FramePlan::set_lod_view`]: the nominal height at 1 px.
    pub const NOMINAL: LodTarget = LodTarget { height: LOD_NOMINAL_HEIGHT, threshold_px: LOD_THRESHOLD_PX };

    /// The cull's LOD view scale (`GpuCullViews::lod.w`) for a camera of `lod_per_height`: the
    /// output's pixels a world unit at distance 1, over the threshold when it is finite, positive
    /// and not [`LOD_THRESHOLD_PX`] (then the height's alone, bit for bit).
    pub fn view_w(self, lod_per_height: f32) -> f32 {
        let w = lod_per_height * self.height as f32;
        let usable = self.threshold_px.is_finite() && self.threshold_px > 0.0;
        if usable && self.threshold_px != LOD_THRESHOLD_PX { w * LOD_THRESHOLD_PX / self.threshold_px } else { w }
    }
}

/// How a frame is planned besides its scene (RQ3.0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanOptions {
    /// The sun's shadows the quality allows, `None` when it switches them off. The scene still
    /// decides whether its sun casts shadows at all.
    pub shadows: Option<ShadowSettings>,
    /// Whether the camera draws in reversed depth (the HDR path); cascades keep standard Z.
    pub depth_reversed: bool,
    /// The sun the environment lights surfaces with instead of the scene's (RQ2: an HDR map's
    /// analytic sun, or the sky's sun through the atmosphere); `None`: the scene's sun. It shades
    /// and casts the shadows; the scene still decides whether its sun casts them at all.
    pub sun: Option<SunLight>,
}

/// A directional sun as the frame lights with it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SunLight {
    /// Unit direction towards the sun.
    pub dir: [f32; 3],
    /// Its colour: linear rgb, intensity folded in (the irradiance on a surface facing it).
    pub color: [f32; 3],
}

/// A scene turned into GPU tables.
#[derive(Clone, Debug, PartialEq)]
pub struct FramePlan {
    /// The frame's binned local lights (RQ6.2): set by the renderer on the binned path, whose
    /// light table is then `binned.lights`.
    pub binned: Option<crate::lights::BinnedFrame>,
    /// Frame uniforms.
    pub frame: GpuFrame,
    /// The instance table: opaque rows grouped by batch, then transparent rows.
    pub instances: Vec<GpuInstance>,
    /// Opaque rows (the batches' rows).
    pub opaque_instances: u32,
    /// Visible-list slots per view: the opaque rows, and the slots of each level's batch over its
    /// mesh's rows (renderer pass 2 A6.9); `opaque_instances` without levels.
    pub visible_slots: u32,
    /// The material table.
    pub materials: Vec<GpuMaterial>,
    /// Each material row's extension (RQ6.3 emission), parallel to `materials`.
    pub material_ext: Vec<GpuMaterialExt>,
    /// The light table.
    pub lights: Vec<GpuLight>,
    /// Each light-table row's extension on the legacy loop (`lights::legacy_lights`: a point, or a
    /// spot's cone), row for row; the binned path's are `binned.ext`.
    pub legacy_ext: Vec<crate::layout::GpuLightExt>,
    /// Batches: one per library mesh drawn (ascending mesh id), then one per opaque skinned draw.
    pub batches: Vec<GpuBatch>,
    /// How many of `batches` draw from the library (the rest draw skinned output).
    pub static_batches: u32,
    /// How many of `batches` are plain ([`DrawVariant::PLAIN`]): the library's, then the skinned
    /// draws'. The other variants' runs follow ([`FramePlan::variants`]; P2-0.12).
    pub plain_batches: u32,
    /// The batches of each non-plain variant the frame draws, in [`DrawVariant::ALL`] order.
    pub variants: Vec<VariantRun>,
    /// Slots per variant: the library's meshes, then the skinned draws. A variant's slot-base
    /// region starts at its index times this; [`FramePlan::slot_base`] holds one region per
    /// variant when any non-plain variant is drawn, else the plain region alone.
    pub slot_count: u32,
    /// The visible-list base of each slot (library mesh ids, then skinning jobs), [`NO_BATCH`] if unused.
    pub slot_base: Vec<u32>,
    /// Active cull views: 1, or 1 + the drawn shadow cascades, then one per shadowed spot (of the
    /// reserved [`crate::layout::MAX_VIEWS`]); the visible list and the indirect arguments hold this many.
    pub views: u32,
    /// What the cull pass reads.
    pub cull_views: GpuCullViews,
    /// The shadow cascades, when the sun casts shadows.
    pub cascades: Option<Cascades>,
    /// The shadow settings the cascades were planned with, when the sun casts shadows.
    pub shadows: Option<ShadowSettings>,
    /// The shadowed spot lights (RQ6.5), each a cull view after the cascades' and a tile of the
    /// shadow array's spot atlas layer: granted by the renderer on the binned path.
    pub spot_shadows: Vec<crate::spot_shadow::SpotShadow>,
    /// Skinning jobs, one per skinned draw.
    pub skin_jobs: Vec<GpuSkinJob>,
    /// The parts of the skinned draws skinned in the vertex stage (game systems AN-18), in draw
    /// then part order: no job, no output and no row of theirs is above.
    pub vertex_skinned: Vec<VertexSkinnedPart>,
    /// The joint table: every skinned draw's matrices, in job order.
    pub joints: Vec<[f32; 16]>,
    /// Vertices the skinning jobs write.
    pub skinned_vertices: u32,
    /// Transparent rows, back to front (culled against the camera).
    pub transparent: Vec<u32>,
    /// Their vertex sources, in the same order.
    pub transparent_sources: Vec<DrawSource>,
    /// Line vertices.
    pub lines: Vec<LineVertex>,
    /// Logical draws (draw, instanced, skinned and line calls), before any culling.
    pub logical_draws: u32,
    /// Instance rows skipped because their mesh was removed (a stale [`MeshId`], game systems
    /// STR-2): a draw's row, or every row of a retained group. Never drawn as the slot's new mesh.
    pub stale_rows: u32,
    /// Each instance row's identity across frames, row for row (RQ5.1): its draw id and ordinal
    /// within the id, else its mesh and ordinal within its batch, and its skinned vertices. Empty
    /// for a frame that writes no motion ([`FramePlan::build_with_motion`]).
    pub motion: Vec<MotionRow>,
    /// The previous-model table, row for row, once [`crate::motion::MotionHistory::apply`] matched
    /// the rows against last frame's; empty otherwise (nothing is uploaded).
    pub prev_models: Vec<crate::layout::GpuPrevModel>,
    /// Where each drawn opaque retained group's rows are (renderer pass 2 A.0b): the renderer
    /// uploads a span again only when it moved or its group changed.
    pub retained: Vec<RetainedSpan>,
    /// The camera's pixels a world unit at distance 1 per pixel of output height, over the LOD
    /// error threshold (A6.9; 0 for an orthographic camera, whose levels are off):
    /// [`FramePlan::set_lod_height`] scales it into the cull's LOD view.
    pub lod_per_height: f32,
    /// The LOD rows (game systems LOD-02), row for row with the opaque instance rows: the sphere
    /// each row's levels are measured from and its bias (cull binding 6).
    pub lod_rows: Vec<GpuLodRow>,
    /// The fade batches' runs (game systems LOD-03), one per variant that draws a mesh with
    /// levels, after every other batch: each level's fade twin, its own slots over its mesh's
    /// rows. Empty without a fade band ([`Scene::lod_band`]).
    pub fade_runs: Vec<VariantRun>,
    /// The visible-list base of each level mesh's fade twin, laid out as
    /// [`FramePlan::slot_base`] (a variant's region at its index times `slot_count`),
    /// [`NO_BATCH`] where none: the region a faded draw finds its rows through (LOD-04). Empty
    /// without fade batches.
    pub fade_slots: Vec<u32>,
    /// The frame's far rules (game systems LOD-18; cull binding 8): [`Scene::far_rules`], at most
    /// [`FAR_RULES_MAX`], each one `far_rule_usable` refuses zeroed (a zero rule thins nothing).
    pub far_rules: Vec<GpuFarRule>,
    /// The impostor batches (game systems LOD-15), in batch order: each lead part's batch at its
    /// chain's impostor level (it draws no mesh indices) and its fade twin; their camera
    /// survivors are the copies drawn as impostors.
    pub impostor_batches: Vec<ImpostorBatch>,
}

/// How a material's opaque draws are batched and drawn (P2-0.12): plain (back faces culled, drawn
/// whole), double-sided (no culling, the viewer-facing normal), alpha-tested (glTF `MASK`: cut
/// away below the cutoff in the prepass, the casters and the world pass), or both. Each variant
/// other than plain has its own batches after the plain ones and its own pipelines.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DrawVariant {
    /// Alpha-tested against the material's cutoff.
    pub masked: bool,
    /// Both faces drawn and cast.
    pub double_sided: bool,
}

impl DrawVariant {
    /// Back faces culled, drawn whole: every draw before P2-0.12.
    pub const PLAIN: DrawVariant = DrawVariant { masked: false, double_sided: false };
    /// Every variant, plain first (its index is its place here).
    pub const ALL: [DrawVariant; DRAW_VARIANTS] = [
        DrawVariant::PLAIN,
        DrawVariant { masked: false, double_sided: true },
        DrawVariant { masked: true, double_sided: false },
        DrawVariant { masked: true, double_sided: true },
    ];

    /// Its place in [`DrawVariant::ALL`].
    pub const fn index(self) -> usize {
        (self.masked as usize) * 2 + self.double_sided as usize
    }
}

/// How many draw variants there are ([`DrawVariant::ALL`]).
pub const DRAW_VARIANTS: usize = 4;

/// The batches of one non-plain [`DrawVariant`] (P2-0.12): a run of [`FramePlan::batches`], the
/// library's meshes first, then its skinned draws.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariantRun {
    /// The variant its batches draw.
    pub variant: DrawVariant,
    /// Its batches.
    pub batches: std::ops::Range<u32>,
    /// Where its skinned batches start (`batches.end` when it has none).
    pub skinned_from: u32,
}

/// Material rows shared by equal materials, each with its extension row at the same index.
#[derive(Default)]
struct Materials {
    rows: Vec<GpuMaterial>,
    ext: Vec<GpuMaterialExt>,
    index: BTreeMap<MaterialKey, u32>,
    /// The last material asked for and its row: a plan asks mesh by mesh, and a mesh's instances
    /// mostly share one material, so a run of it skips building and looking up its key (the key
    /// grew with emission; its lookup per instance was a tenth of bench-city's features-off CPU
    /// time, pass-1 fix).
    last: Option<(Material, u32)>,
}

impl Materials {
    fn row(&mut self, material: &Material) -> u32 {
        if let Some((last, row)) = &self.last
            && same_bits(last, material)
        {
            return *row;
        }
        let row = *self.index.entry(material.key()).or_insert_with(|| {
            self.rows.push(material.to_gpu());
            self.ext.push(material.to_gpu_ext());
            (self.rows.len() - 1) as u32
        });
        self.last = Some((*material, row));
        row
    }
}

/// Whether `a` and `b` are the same material to the bit, so they have the same key (`==` would
/// take a signed zero for zero, which the key tells apart). Field by field, cheapest first.
fn same_bits(a: &Material, b: &Material) -> bool {
    let bits = |x: f32, y: f32| x.to_bits() == y.to_bits();
    a.base_color == b.base_color
        && bits(a.roughness, b.roughness)
        && bits(a.metallic, b.metallic)
        && a.base_texture == b.base_texture
        && a.checker == b.checker
        && bits(a.normal_scale, b.normal_scale)
        && a.normal_texture == b.normal_texture
        && a.metal_rough_texture == b.metal_rough_texture
        && a.emissive.iter().zip(&b.emissive).all(|(x, y)| bits(*x, *y))
        && bits(a.emissive_strength, b.emissive_strength)
        && a.emissive_texture == b.emissive_texture
        && a.alpha_cutoff.map(f32::to_bits) == b.alpha_cutoff.map(f32::to_bits)
        && a.double_sided == b.double_sided
        && a.occlusion_texture == b.occlusion_texture
        && bits(a.occlusion_strength, b.occlusion_strength)
}

/// A transparent instance before sorting.
struct Glass {
    row: GpuInstance,
    source: DrawSource,
    /// Its identity across frames (None: the frame writes no motion).
    motion: Option<MotionRow>,
}

/// The motion keys of a plan's draws, made only for a frame that writes motion (RQ5 review: the
/// keys and their rows cost the planning of a 10,000-instance scene about a third more CPU time on
/// every preset, TAA or not).
struct DrawKeys {
    keys: Option<MotionKeys>,
}

impl DrawKeys {
    #[inline]
    fn row(&mut self, id: Option<DrawId>, mesh: MeshId, kind: RowKind, skinned_base: Option<u32>) -> Option<MotionRow> {
        self.keys.as_mut().map(|keys| keys.row(id, mesh, kind, skinned_base))
    }
}

/// The opaque rows a plan builds: the instance table's opaque rows with their motion rows, the
/// batches and the slot bases (one region of `slot_count` per variant when any is drawn).
struct Rows {
    instances: Vec<GpuInstance>,
    motion: Vec<MotionRow>,
    batches: Vec<GpuBatch>,
    slot_base: Vec<u32>,
    slot_count: usize,
    retained: Vec<RetainedSpan>,
    /// Whether a batch draws a level of detail (A6.9).
    lod_batches: bool,
    /// Visible-list slots taken so far: a batch's rows, and a level batch's own over its mesh's.
    slots: u32,
    /// The LOD rows, row for row with `instances` (game systems LOD-02).
    lod_rows: Vec<GpuLodRow>,
    /// Each batched mesh with levels or a far rule, for its fade twins (game systems LOD-03,
    /// LOD-18).
    lod_meshes: Vec<LodMesh>,
    /// The impostor batches so far (game systems LOD-15).
    impostor_batches: Vec<ImpostorBatch>,
}

/// A batched mesh with fade twins: its variant, its rows (its fade twins hold the same rows), its
/// meshes level by level (the mesh itself first; only it for a mesh without levels), its chain's
/// errors and bounding radius, and whether a row of it names a far rule (game systems LOD-18:
/// its thinned copies draw through its twins, with or without a band).
struct LodMesh {
    variant: usize,
    first_row: u32,
    count: usize,
    levels: Vec<MeshId>,
    errors: Vec<f32>,
    radius: f32,
    far: bool,
    /// Its impostor level (game systems LOD-15): its chain's LOD rows carry it.
    impostor: Option<MeshImpostor>,
}

impl LodMesh {
    /// The LOD row of its level `level` batch (a fade twin's when `fade`).
    fn lod(&self, level: u32, fade: bool) -> [u32; 3] {
        chain_lod(level, &self.errors, self.radius, self.impostor, fade)
    }
}

/// The LOD row of level `level`'s batch of a chain with `errors` on a mesh of bounding radius
/// `radius`, ended by `impostor` when it has one (game systems LOD-15), a fade twin's when `fade`.
fn chain_lod(level: u32, errors: &[f32], radius: f32, impostor: Option<MeshImpostor>, fade: bool) -> [u32; 3] {
    match impostor {
        Some(impostor) => crate::mesh::impostor_batch_lod(level, errors, radius, impostor.error, fade),
        None if fade => crate::mesh::fade_batch_lod(level, errors, radius),
        None => crate::mesh::batch_lod(level, errors, radius),
    }
}

/// One variant's draws of one library mesh: retained groups (indices into `Scene::groups`), then
/// mesh draws (indices into `Scene::draws`).
#[derive(Default)]
struct MeshDraws {
    groups: Vec<usize>,
    draws: Vec<usize>,
}

impl Rows {
    /// One batch per library mesh `variant` draws (ascending mesh id), its slot base in the
    /// variant's region: the mesh's retained groups' rows (computed once per group, A.0b), then
    /// its mesh draws' rows.
    #[allow(clippy::too_many_arguments, reason = "the plan's row builders share one call shape")]
    fn push_meshes(
        &mut self,
        scene: &Scene,
        library: &MeshLibrary,
        by_mesh: &BTreeMap<(usize, MeshId), MeshDraws>,
        variant: usize,
        key_of: &[Option<MotionRow>],
        keys: &mut DrawKeys,
        materials: &mut Materials,
    ) -> Result<(), RenderError> {
        let meshes = (variant, MeshId::from_raw(0))..=(variant, MeshId::LAST);
        for ((_, mesh), drawn) in by_mesh.range(meshes) {
            let entry = mesh_entry(library, *mesh)?;
            // A6.9: a mesh drawn whole with levels gets a batch per level, each with slots of its
            // own over the mesh's rows (pushed once); the cull keeps each instance in one of
            // them (`mesh::lod_keeps`).
            let whole = library.meshlet_state(*mesh) == Some(MeshletState::Whole);
            let lods = library.lods(*mesh).filter(|_| whole);
            // LOD-15: an impostor ends the chain after at most three mesh levels.
            let impostor = library.impostor(*mesh).filter(|_| whole);
            let first_row = self.instances.len() as u32;
            let count = self.push_mesh_rows(scene, entry, drawn, key_of, keys, materials);
            let kept = if impostor.is_some() { crate::mesh::LOD_IMPOSTOR_MESH_LEVELS } else { usize::MAX };
            let level_meshes: Vec<MeshId> = lods.map_or_else(Vec::new, |lods| lods.levels.iter().copied().take(kept).collect());
            let errors: Vec<f32> = lods.map_or_else(Vec::new, |lods| lods.errors.iter().copied().take(kept).collect());
            let chained = lods.is_some() || impostor.is_some();
            for level in 0..=level_meshes.len() {
                let (level_mesh, geometry) = match level.checked_sub(1) {
                    Some(at) => (level_meshes[at], mesh_entry(library, level_meshes[at])?),
                    None => (*mesh, entry),
                };
                self.slot_base[variant * self.slot_count + level_mesh.raw() as usize] = self.slots;
                let mut row = batch(self.slots as usize, count, geometry.first_index, geometry.index_count, geometry.base_vertex);
                row.first_row = first_row;
                row.lod = if chained { chain_lod(level as u32, &errors, entry.radius, impostor, false) } else { [0; 3] };
                self.batches.push(row);
                self.slots += count as u32;
            }
            if let Some(species) = impostor.and_then(|impostor| impostor.species) {
                self.push_impostor_batch(first_row, count, chain_lod(level_meshes.len() as u32 + 1, &errors, entry.radius, impostor, false), species);
            }
            self.lod_batches |= chained;
            // A clustered mesh's meshlet path culls its instances itself: it is never thinned
            // (game systems LOD-18), so its rows' far rules are dropped here.
            if library.meshlet_state(*mesh) != Some(MeshletState::Whole) {
                self.lod_rows[first_row as usize..].iter_mut().for_each(|row| row.far_rule = FAR_RULE_NONE);
            }
            let far = self.lod_rows[first_row as usize..].iter().any(|row| row.far_rule != FAR_RULE_NONE);
            if chained || far {
                let levels = std::iter::once(*mesh).chain(level_meshes).collect();
                self.lod_meshes.push(LodMesh { variant, first_row, count, levels, errors, radius: entry.radius, far, impostor });
            }
        }
        Ok(())
    }

    /// A lead part's impostor batch (game systems LOD-15): slots of its own over the part's
    /// `count` rows from `first_row`, no mesh indices (the impostor draw draws its survivors),
    /// LOD row `lod`.
    fn push_impostor_batch(&mut self, first_row: u32, count: usize, lod: [u32; 3], species: u32) {
        let mut row = batch(self.slots as usize, count, 0, 0, 0);
        row.first_row = first_row;
        row.lod = lod;
        self.impostor_batches.push(ImpostorBatch { batch: self.batches.len() as u32, species });
        self.batches.push(row);
        self.slots += count as u32;
    }

    /// The fade twins (game systems LOD-03, LOD-18), after every other batch: with a band
    /// (`banded`) of every batched mesh with levels, and of every mesh a row of which names a far
    /// rule; per variant a run of each such mesh's level batches again (the mesh itself for one
    /// without levels), tagged [`crate::mesh::LOD_FADE_TAG`], with slots of their own over the
    /// mesh's rows, their slot bases in `fade_slots` (laid out as `slot_base`).
    fn push_fade_twins(&mut self, library: &MeshLibrary, banded: bool, skinned: (&Scene, &[SkinnedPart], &[SkinnedRow]), materials: &mut Materials) -> Result<(Vec<VariantRun>, Vec<u32>), RenderError> {
        let (scene, parts, fade_rows) = skinned;
        if fade_rows.is_empty() && !self.lod_meshes.iter().any(|lod_mesh| banded || lod_mesh.far) {
            return Ok((Vec::new(), Vec::new()));
        }
        // A twin's slots are not its rows: the cull looks each slot's batch up.
        self.lod_batches = true;
        let mut fade_slots = vec![NO_BATCH; self.slot_base.len()];
        let mut runs = Vec::new();
        let mut impostor_twins = Vec::new();
        for variant in DrawVariant::ALL {
            let first = self.batches.len() as u32;
            for lod_mesh in self.lod_meshes.iter().filter(|lod_mesh| lod_mesh.variant == variant.index() && (banded || lod_mesh.far)) {
                for (level, level_mesh) in lod_mesh.levels.iter().enumerate() {
                    let geometry = mesh_entry(library, *level_mesh)?;
                    fade_slots[variant.index() * self.slot_count + level_mesh.raw() as usize] = self.slots;
                    let mut row = batch(self.slots as usize, lod_mesh.count, geometry.first_index, geometry.index_count, geometry.base_vertex);
                    row.first_row = lod_mesh.first_row;
                    row.lod = lod_mesh.lod(level as u32, true);
                    self.batches.push(row);
                    self.slots += lod_mesh.count as u32;
                }
                // LOD-15: the lead part's impostor level fades in through its own twin.
                if let Some(species) = lod_mesh.impostor.and_then(|impostor| impostor.species) {
                    let lod = lod_mesh.lod(lod_mesh.levels.len() as u32, true);
                    impostor_twins.push(ImpostorBatch { batch: self.batches.len() as u32, species });
                    let mut row = batch(self.slots as usize, lod_mesh.count, 0, 0, 0);
                    row.first_row = lod_mesh.first_row;
                    row.lod = lod;
                    self.batches.push(row);
                    self.slots += lod_mesh.count as u32;
                }
            }
            let skinned_from = self.batches.len() as u32;
            self.push_skinned_fades(scene, parts, fade_rows, variant.index(), (&mut fade_slots, materials));
            let end = self.batches.len() as u32;
            if end > first {
                runs.push(VariantRun { variant, batches: first..end, skinned_from });
            }
        }
        self.impostor_batches.extend(impostor_twins);
        Ok((runs, fade_slots))
    }

    /// The instance rows of `drawn` (a mesh's draws in one variant): its retained groups' rows,
    /// then its draws' (keyed with `key_of`, made in draw order). Answers how many.
    fn push_mesh_rows(&mut self, scene: &Scene, entry: &MeshEntry, drawn: &MeshDraws, key_of: &[Option<MotionRow>], keys: &mut DrawKeys, materials: &mut Materials) -> usize {
        let first = self.instances.len();
        for at in &drawn.groups {
            self.push_group(&scene.groups[*at], entry, keys, materials);
        }
        for at in &drawn.draws {
            let draw = &scene.draws[*at];
            let row = instance_row(&draw.model, entry.center, entry.radius, materials.row(&draw.material));
            self.lod_rows.push(lod_row(&draw.model, row.bounds, &draw.lod));
            self.instances.push(row);
            self.motion.extend(key_of.get(*at).copied().flatten());
        }
        self.instances.len() - first
    }

    /// One opaque retained group's rows: its cached rows under this frame's material row, and its
    /// span (A.0b).
    fn push_group(&mut self, GroupDraw { group, material, id, lod }: &GroupDraw, entry: &MeshEntry, keys: &mut DrawKeys, materials: &mut Materials) {
        let material = materials.row(material);
        let first = self.instances.len();
        self.instances.extend_from_slice(&group.rows(entry.center, entry.radius));
        self.lod_rows.extend_from_slice(&group.lod_rows(entry.center, entry.radius, lod));
        if material != 0 {
            for row in &mut self.instances[first..] {
                row.material = material;
            }
        }
        for _ in 0..group.len() {
            self.motion.extend(keys.row(*id, group.mesh(), RowKind::Opaque, None));
        }
        let rows = group.len() as u32;
        self.retained.push(RetainedSpan { group: group.clone(), first_row: first as u32, rows, material, bounds: (entry.center, entry.radius), lod: *lod });
    }

    /// One skinned part's batch in `variant`'s region (its slot base there): one row per draw
    /// sharing its skinned output (`rows`, AN-16b), in draw order.
    fn push_skinned(&mut self, scene: &Scene, part: &SkinnedPart, rows: &[SkinnedRow], variant: usize, materials: &mut Materials) {
        self.slot_base[variant * self.slot_count + part.job.slot as usize] = self.slots;
        let mut skinned = batch(self.slots as usize, rows.len(), part.source.first_index, part.source.index_count, part.source.base_vertex);
        skinned.first_row = self.instances.len() as u32;
        self.batches.push(skinned);
        self.slots += rows.len() as u32;
        for skinned_row in rows {
            let draw = &scene.skinned[skinned_row.draw];
            let row = instance_row(&draw.model, part.center, part.radius, materials.row(&skinned_row.material));
            self.lod_rows.push(lod_row(&draw.model, row.bounds, &DrawLod::OWN));
            self.instances.push(row);
            self.motion.extend(skinned_row.key);
        }
    }

    /// The fade batches of `variant`'s skinned levels crossfading in a band (game systems AN-25;
    /// rows sorted by variant, then part): one per part, its rows its own, its slot base in
    /// `fade_slots` (the region a faded draw finds its rows through).
    fn push_skinned_fades(&mut self, scene: &Scene, parts: &[SkinnedPart], rows: &[SkinnedRow], variant: usize, (fade_slots, materials): (&mut [u32], &mut Materials)) {
        let first = rows.partition_point(|row| row.variant < variant);
        let mine = &rows[first..first + rows[first..].partition_point(|row| row.variant == variant)];
        for same_part in mine.chunk_by(|a, b| a.part == b.part) {
            let part = &parts[same_part[0].part];
            fade_slots[variant * self.slot_count + part.job.slot as usize] = self.slots;
            let mut fades = batch(self.slots as usize, same_part.len(), part.source.first_index, part.source.index_count, part.source.base_vertex);
            fades.first_row = self.instances.len() as u32;
            fades.lod = part.lod;
            self.batches.push(fades);
            self.slots += same_part.len() as u32;
            for skinned_row in same_part {
                let draw = &scene.skinned[skinned_row.draw];
                let row = instance_row(&draw.model, part.center, part.radius, materials.row(&skinned_row.material));
                self.lod_rows.push(lod_row(&draw.model, row.bounds, &DrawLod::OWN));
                self.instances.push(row);
                self.motion.extend(skinned_row.key);
            }
        }
    }

    /// The batches of `variant`'s opaque skinned rows (sorted by variant, then part): one per
    /// part drawn, its rows together.
    fn push_skinned_variant(&mut self, scene: &Scene, parts: &[SkinnedPart], rows: &[SkinnedRow], variant: usize, materials: &mut Materials) {
        let first = rows.partition_point(|row| row.variant < variant);
        let mine = &rows[first..first + rows[first..].partition_point(|row| row.variant == variant)];
        for same_part in mine.chunk_by(|a, b| a.part == b.part) {
            self.push_skinned(scene, &parts[same_part[0].part], same_part, variant, materials);
        }
    }
}

/// One skinning job of a frame (a part of a skinned draw, shared by the draws posing the same skin
/// with a bit-identical palette, AN-16b), its batch geometry and its model-space bounds.
struct SkinnedPart {
    job: GpuSkinJob,
    source: DrawSource,
    center: [f32; 3],
    radius: f32,
    /// Its batch's LOD row (game systems AN-25): `[0; 3]` but for a level crossfading in a band,
    /// whose batch is a fade batch drawn with the fade twins.
    lod: [u32; 3],
    /// The mesh it skins: the draw's own, or a level's.
    mesh: MeshId,
}

impl SkinnedPart {
    /// Whether it draws through a fade batch (a level crossfading in a band).
    fn fades(&self) -> bool {
        self.lod[0] & crate::mesh::LOD_FADE_TAG != 0
    }
}

/// One opaque instance row of a skinned part: its draw, its material and draw variant, and its
/// identity across frames.
#[derive(Clone, Copy)]
struct SkinnedRow {
    part: usize,
    draw: usize,
    variant: usize,
    material: Material,
    key: Option<MotionRow>,
}

/// A frame's skinning: its jobs, the joint table, and each skinned draw's jobs (its parts, in
/// part order: indices into `parts`).
struct SkinnedFrame {
    parts: Vec<SkinnedPart>,
    joints: Vec<[f32; 16]>,
    uses: Vec<std::ops::Range<usize>>,
}

/// The parts of the skinned draws `vertex` marks, in draw then part order, each with its material
/// row (game systems AN-18).
/// A draw's skin is the level `picks` gives it (game systems AN-25; a vertex-path draw is never in a
/// band, so it draws one level whole).
fn vertex_skinned_parts(scene: &Scene, library: &MeshLibrary, (vertex, picks): (&[bool], &[SkinnedPick]), materials: &mut Materials) -> Vec<VertexSkinnedPart> {
    let mut parts = Vec::new();
    for (at, draw) in scene.skinned.iter().enumerate().filter(|(at, _)| vertex.get(*at).copied().unwrap_or(false)) {
        let level = picks.get(at).map_or(0, |pick| *pick.levels().start());
        let skin = library.skin_lods(draw.skin).map_or(draw.skin, |lods| lods.skin(draw.skin, level));
        for part in 0..draw.skin.parts {
            let material = materials.row(&draw.part_material(part as usize));
            parts.push(VertexSkinnedPart { draw: at as u32, part, material, skin });
        }
    }
    parts
}

/// The level each skinned draw of `scene` skins (game systems AN-25): the cull's own choice under
/// the LOD view `view` and fade band `band`, measured from the draw's posed base sphere; the base
/// whole for a skin without levels or a draw the plan refuses.
fn skinned_picks(scene: &Scene, library: &MeshLibrary, view: [f32; 4], band: f32) -> Vec<SkinnedPick> {
    let pick = |draw: &SkinnedDraw| {
        let Some(lods) = library.skin_lods(draw.skin) else { return SkinnedPick::BASE };
        let Some(entry) = library.entry(draw.skin.mesh) else { return SkinnedPick::BASE };
        let (center, radius) = skinned_bounds(entry.center, entry.radius, &draw.joints);
        let bounds = instance_row(&draw.model, center, radius, 0).bounds;
        let row = lod_row(&draw.model, bounds, &DrawLod::OWN);
        let input = SkinnedLodInput { bounds, origin: row.origin, bias: row.bias, view, band };
        pick_level(&lods.errors, entry.radius, &input)
    };
    scene.skinned.iter().map(pick).collect()
}

/// The level each skinned draw of `scene` skins on an output of `target` (game systems AN-25), as
/// [`FramePlan::build_with_skin_levels`] picks them: the base whole for a skin without levels.
pub fn skinned_levels(scene: &Scene, library: &MeshLibrary, target: LodTarget) -> Vec<SkinnedPick> {
    let eye = scene.camera.eye;
    let view = [eye[0], eye[1], eye[2], target.view_w(lod_per_height(&scene.camera))];
    skinned_picks(scene, library, view, fade_band(scene.lod_band))
}

/// LOD's screen-size metric (game systems AN-17; STR-19 and the skinned paths read it too): the
/// pixels the diameter of the world sphere `sphere` (centre xyz, radius) covers at the nominal
/// output height ([`LOD_NOMINAL_HEIGHT`]) from `camera`, on the cull's own scale (the LOD view's w,
/// [`crate::layout::GpuCullViews::lod`]). Infinite where levels are off (an orthographic camera)
/// and with the eye inside the sphere: such a draw is always at its finest.
pub fn screen_height_px(camera: &CameraDesc, sphere: [f32; 4]) -> f32 {
    let per_unit = lod_per_height(camera) * LOD_NOMINAL_HEIGHT as f32;
    let distance = Vec3::from(camera.eye).distance(Vec3::new(sphere[0], sphere[1], sphere[2]));
    let at_finest = per_unit <= 0.0 || distance <= sphere[3];
    if at_finest {
        return f32::INFINITY;
    }
    2.0 * sphere[3] * per_unit / distance
}

/// The camera's pixels a world unit at distance 1 per pixel of output height, over
/// [`LOD_THRESHOLD_PX`]: `1 / (2 tan(fovy / 2))` for a perspective camera, 0 (levels off) for an
/// orthographic one, whose projected error does not shrink with distance.
fn lod_per_height(camera: &CameraDesc) -> f32 {
    if camera.ortho_height.is_some() {
        return 0.0;
    }
    let tan = libm::tanf(camera.fovy_degrees.to_radians() * 0.5);
    if tan > 0.0 && tan.is_finite() { 0.5 / tan / LOD_THRESHOLD_PX } else { 0.0 }
}

/// A level of `mesh` as a mesh of its own: the vertices `indices` use, in first-use order, and
/// the triangles over them.
fn level_mesh(mesh: &MeshData, indices: &[u32]) -> MeshData {
    let mut remap: BTreeMap<u32, u32> = BTreeMap::new();
    let mut vertices = Vec::new();
    let indices = indices
        .iter()
        .map(|index| {
            *remap.entry(*index).or_insert_with(|| {
                vertices.push(mesh.vertices[*index as usize]);
                (vertices.len() - 1) as u32
            })
        })
        .collect();
    MeshData { vertices, indices }
}

fn mesh_entry(library: &MeshLibrary, mesh: MeshId) -> Result<&MeshEntry, RenderError> {
    library.entry(mesh).ok_or_else(|| RenderError::refused(RenderCode::MeshInvalid, format!("mesh {} is not in the library", mesh.raw())))
}

/// Whether an opaque draw of `material` batches apart from the plain batches (P2-0.12).
fn varied_material(material: &Material) -> bool {
    !material.is_transparent() && material.draw_variant() != DrawVariant::PLAIN
}

/// Whether two palettes are bit for bit the same (a NaN equals itself, -0 differs from 0).
fn same_palette(a: &[[f32; 16]], b: &[[f32; 16]]) -> bool {
    bytemuck::cast_slice::<[f32; 16], u32>(a) == bytemuck::cast_slice::<[f32; 16], u32>(b)
}

/// Each skinned draw's pose owner (AN-16b): the first draw of `scene` keyed alike by `key_of`
/// (its level, say) that poses the same skin with a bit-identical palette, itself for the first
/// of its pose and for a draw `key_of` leaves out (None). A hash of the palette's bits finds the
/// candidates, so a frame of N draws compares palettes about N times, not N^2 / 2.
pub(crate) fn pose_owners<K: Hash + Eq>(scene: &Scene, key_of: impl Fn(usize) -> Option<K>) -> Vec<usize> {
    let mut seen: FastMap<(SkinId, K, u64), Vec<usize>> = FastMap::with_capacity_and_hasher(scene.skinned.len(), Default::default());
    let mut owner_of = |(at, draw): (usize, &SkinnedDraw)| {
        let Some(key) = key_of(at) else { return at };
        let owners = seen.entry((draw.skin, key, palette_hash(&draw.joints))).or_default();
        if let Some(owner) = owners.iter().copied().find(|owner| same_palette(&scene.skinned[*owner].joints, &draw.joints)) {
            return owner;
        }
        owners.push(at);
        at
    };
    scene.skinned.iter().enumerate().map(&mut owner_of).collect()
}

/// A hash of a palette's bits (the same for bit-identical palettes).
fn palette_hash(palette: &[[f32; 16]]) -> u64 {
    let mut hasher = genex_core::map::FastHasher::default();
    hasher.write(bytemuck::cast_slice::<[f32; 16], u8>(palette));
    hasher.finish()
}

/// Refuse `mesh-invalid` a part list that does not describe `mesh` (AN-16a).
fn check_skin_parts(mesh: &MeshData, parts: &[SkinPart]) -> Result<(), RenderError> {
    let refuse = |detail: String| Err(RenderError::refused(RenderCode::MeshInvalid, detail));
    if parts.is_empty() {
        return refuse("a skinned mesh has no part".to_owned());
    }
    let (vertices, indices) = (mesh.vertices.len() as u64, mesh.indices.len() as u64);
    for (at, part) in parts.iter().enumerate() {
        let vertex_end = u64::from(part.first_vertex) + u64::from(part.vertex_count);
        let index_end = u64::from(part.first_index) + u64::from(part.index_count);
        let empty = part.vertex_count == 0 || part.index_count == 0;
        if empty || vertex_end > vertices || index_end > indices || part.index_count % 3 != 0 {
            return refuse(format!("skinned part {at} is empty, not whole triangles, or past the mesh's {vertices} vertices and {indices} indices"));
        }
        let range = part.first_vertex..part.first_vertex + part.vertex_count;
        let own = &mesh.indices[part.first_index as usize..index_end as usize];
        if own.iter().any(|index| !range.contains(index)) {
            return refuse(format!("skinned part {at} names a vertex outside its own"));
        }
    }
    Ok(())
}

/// The skinning jobs of every skinned draw (one per part; AN-16a), refused `mesh-invalid` for an
/// unknown mesh, a joint count that differs from its skin's, or a material count that differs
/// from its parts'. A draw posing the same skin with a bit-identical palette as an earlier draw
/// takes that draw's jobs, so its rows draw the same skinned output (AN-16b).
/// A draw `vertex` marks (game systems AN-18) is validated as every draw is, then takes no job and
/// no row: it skins in the vertex stage (`crate::skin_vertex`), and no other draw shares its pose.
fn skinned_parts(scene: &Scene, library: &MeshLibrary, vertex: &[bool], picks: &[SkinnedPick]) -> Result<SkinnedFrame, RenderError> {
    let skins_in_vertex = |at: usize| vertex.get(at).copied().unwrap_or(false);
    let pick_of = |at: usize| picks.get(at).copied().unwrap_or(SkinnedPick::BASE);
    let mut frame = SkinnedFrame { parts: Vec::with_capacity(scene.skinned.len()), joints: Vec::new(), uses: Vec::with_capacity(scene.skinned.len()) };
    let mut dst_base = 0u32;
    // Each draw's job owner: the first draw on compute posing its skin and level with its palette.
    let owners = pose_owners(scene, |at| (!skins_in_vertex(at)).then(|| pick_of(at)));
    for (at, draw) in scene.skinned.iter().enumerate() {
        let entry = mesh_entry(library, draw.skin.mesh)?;
        if draw.joints.len() != draw.skin.joints as usize {
            return Err(RenderError::refused(
                RenderCode::MeshInvalid,
                format!("{} joint matrices for a skin of {}", draw.joints.len(), draw.skin.joints),
            ));
        }
        if !draw.part_materials.is_empty() && draw.part_materials.len() != draw.skin.parts as usize {
            return Err(RenderError::refused(
                RenderCode::MeshInvalid,
                format!("{} materials for a skin of {} parts", draw.part_materials.len(), draw.skin.parts),
            ));
        }
        if library.skin_parts(draw.skin).len() != draw.skin.parts as usize {
            return Err(RenderError::refused(RenderCode::MeshInvalid, format!("skin of mesh {} is not this library's", draw.skin.mesh.raw())));
        }
        if skins_in_vertex(at) {
            frame.uses.push(frame.parts.len()..frame.parts.len());
            continue;
        }
        let pick = pick_of(at);
        let owner = owners[at];
        if owner != at {
            frame.uses.push(frame.uses[owner].clone());
            continue;
        }
        // Every level's rows measure from the posed sphere of the base mesh (AN-25).
        let (center, radius) = skinned_bounds(entry.center, entry.radius, &draw.joints);
        let joint_base = frame.joints.len() as u32;
        frame.joints.extend_from_slice(&draw.joints);
        let first = frame.parts.len();
        let lods = library.skin_lods(draw.skin);
        let errors = lods.map_or(&[][..], |lods| &lods.errors[..]);
        for level in pick.levels() {
            let skin = lods.map_or(draw.skin, |lods| lods.skin(draw.skin, level));
            let level_entry = mesh_entry(library, skin.mesh)?;
            let lod = pick.batch_lod(level, errors, entry.radius);
            for part in library.skin_parts(skin) {
                let job = GpuSkinJob {
                    src_base: level_entry.base_vertex as u32 + part.first_vertex,
                    count: part.vertex_count,
                    dst_base,
                    joint_base,
                    skin_base: skin.skin_base + part.first_vertex,
                    slot: (library.len() + frame.parts.len()) as u32,
                    pad: [0; 2],
                };
                // The part's indices name mesh vertices from its first: shifted onto its own output.
                let base_vertex = dst_base as i32 - part.first_vertex as i32;
                let source = DrawSource { skinned: true, first_index: level_entry.first_index + part.first_index, index_count: part.index_count, base_vertex };
                dst_base += part.vertex_count;
                frame.parts.push(SkinnedPart { job, source, center, radius, lod, mesh: skin.mesh });
            }
        }
        frame.uses.push(first..frame.parts.len());
    }
    Ok(frame)
}

impl FramePlan {
    /// Build the tables for `scene` on a target of `aspect`; an unknown mesh or a skinned draw
    /// whose joints do not match its skin is refused `mesh-invalid` before anything is built.
    pub fn build(scene: &Scene, library: &MeshLibrary, aspect: f32) -> Result<FramePlan, RenderError> {
        FramePlan::build_shadowed(scene, library, aspect, true)
    }

    /// [`FramePlan::build`] with sun shadows planned only when `allow_shadows` (the quality's
    /// switch) and the scene asks for them: off, no cascade is planned, so no shader samples a
    /// stale map, and the scene is never copied.
    pub fn build_shadowed(scene: &Scene, library: &MeshLibrary, aspect: f32, allow_shadows: bool) -> Result<FramePlan, RenderError> {
        FramePlan::build_depth(scene, library, aspect, allow_shadows, false)
    }

    /// [`FramePlan::build_shadowed`] with the camera drawn in reversed depth when `depth_reversed`
    /// (the HDR path): the frame uniforms carry [`CameraDesc::view_proj_reversed`] and the camera
    /// view's cull planes come from it ([`crate::cull::frustum_planes_for`]), so the same draws
    /// survive. Shadow cascades keep standard Z.
    pub fn build_depth(scene: &Scene, library: &MeshLibrary, aspect: f32, allow_shadows: bool, depth_reversed: bool) -> Result<FramePlan, RenderError> {
        let shadows = allow_shadows.then(|| ShadowSettings::legacy(scene.lighting.shadow_distance));
        FramePlan::build_with(scene, library, aspect, &PlanOptions { shadows, depth_reversed, sun: None })
    }

    /// [`FramePlan::build`] under `options`: the sun's shadows planned with `options.shadows`
    /// when the scene's sun casts them (the settings' cascades, fit by [`crate::shadow::fit`]
    /// around the opaque rows), and the camera in reversed depth when `options.depth_reversed`.
    pub fn build_with(scene: &Scene, library: &MeshLibrary, aspect: f32, options: &PlanOptions) -> Result<FramePlan, RenderError> {
        FramePlan::build_with_motion(scene, library, aspect, options, true)
    }

    /// [`FramePlan::build_with`] with its rows' identities ([`FramePlan::motion`]) only when the
    /// frame writes motion (`motion`); without, `motion` is empty and no key is made.
    pub fn build_with_motion(scene: &Scene, library: &MeshLibrary, aspect: f32, options: &PlanOptions, motion: bool) -> Result<FramePlan, RenderError> {
        FramePlan::build_with_skin_paths(scene, library, aspect, options, motion, &[])
    }

    /// [`FramePlan::build_with_skin_levels`] for a plan whose LOD view stays at
    /// [`LodTarget::NOMINAL`] (or is set later with [`FramePlan::set_lod_view`]; skinned levels
    /// are then picked for the nominal view).
    pub fn build_with_skin_paths(scene: &Scene, library: &MeshLibrary, aspect: f32, options: &PlanOptions, motion: bool, vertex: &[bool]) -> Result<FramePlan, RenderError> {
        FramePlan::build_with_skin_levels(scene, library, aspect, options, (motion, vertex), LodTarget::NOMINAL)
    }

    /// [`FramePlan::build_with_motion`] with the skinned draws `vertex` marks skinned in the vertex
    /// stage (game systems AN-18, [`crate::skin_vertex::vertex_skinned_draws`]): they take no
    /// skinning job, no skinned output and no row; their parts' material rows are in
    /// [`FramePlan::vertex_skinned`].
    ///
    /// Skinned draws with levels (game systems AN-25) skin the level the cull keeps under the LOD
    /// view of an output `target` (the view [`FramePlan::set_lod_view`] then sets): one level whole,
    /// or in the fade band the two levels it crossfades, both skinned by compute (a marked draw in a
    /// band leaves the vertex path for that frame).
    pub fn build_with_skin_levels(scene: &Scene, library: &MeshLibrary, aspect: f32, options: &PlanOptions, (motion, vertex): (bool, &[bool]), target: LodTarget) -> Result<FramePlan, RenderError> {
        let picks = skinned_levels(scene, library, target);
        FramePlan::build_with_picks(scene, library, aspect, options, (motion, vertex), &picks)
    }

    /// [`FramePlan::build_with_skin_levels`] with the levels [`skinned_levels`] picked for its
    /// target (the renderer picks them once for the skin paths and the plan).
    pub(crate) fn build_with_picks(scene: &Scene, library: &MeshLibrary, aspect: f32, options: &PlanOptions, (motion, vertex): (bool, &[bool]), picks: &[SkinnedPick]) -> Result<FramePlan, RenderError> {
        let depth_reversed = options.depth_reversed;
        let band = fade_band(scene.lod_band);
        let lod_per_height = lod_per_height(&scene.camera);
        let eye = scene.camera.eye;
        let vertex: Vec<bool> = vertex.iter().enumerate().map(|(at, marked)| *marked && !picks.get(at).is_some_and(|pick| pick.is_band())).collect();
        let SkinnedFrame { parts, joints, uses } = skinned_parts(scene, library, &vertex, picks)?;
        let mut materials = Materials::default();
        let mut keys = DrawKeys { keys: motion.then(MotionKeys::default) };
        // Opaque draws by variant and mesh as indices into the scene's draws (and, with motion,
        // into their keys, made in draw order so an id's ordinals follow the game's order).
        let mut by_mesh: BTreeMap<(usize, MeshId), MeshDraws> = BTreeMap::new();
        let mut key_of: Vec<Option<MotionRow>> = if motion { vec![None; scene.draws.len()] } else { Vec::new() };
        let mut glass = Vec::new();
        let mut stale_rows = 0u32;
        for (at, draw) in scene.draws.iter().enumerate() {
            if library.is_removed(draw.mesh) {
                stale_rows += 1;
                continue;
            }
            let entry = mesh_entry(library, draw.mesh)?;
            if draw.material.is_transparent() {
                let source = DrawSource { skinned: false, first_index: entry.first_index, index_count: entry.index_count, base_vertex: entry.base_vertex };
                let motion = keys.row(draw.id, draw.mesh, RowKind::Transparent, None);
                glass.push(Glass { row: instance_row(&draw.model, entry.center, entry.radius, materials.row(&draw.material)), source, motion });
            } else {
                if let Some(key) = keys.row(draw.id, draw.mesh, RowKind::Opaque, None) {
                    key_of[at] = Some(key);
                }
                by_mesh.entry((draw.material.draw_variant().index(), draw.mesh)).or_default().draws.push(at);
            }
        }
        // Retained groups (A.0b): opaque ones batch with their mesh's draws, ahead of them; a
        // transparent group's rows are sorted with the glass, one by one.
        for (at, GroupDraw { group, material, id, .. }) in scene.groups.iter().enumerate().filter(|(_, draw)| !draw.group.is_empty()) {
            if library.is_removed(group.mesh()) {
                stale_rows += group.len() as u32;
                continue;
            }
            let entry = mesh_entry(library, group.mesh())?;
            let material = *material;
            if !material.is_transparent() {
                by_mesh.entry((material.draw_variant().index(), group.mesh())).or_default().groups.push(at);
                continue;
            }
            let source = DrawSource { skinned: false, first_index: entry.first_index, index_count: entry.index_count, base_vertex: entry.base_vertex };
            for model in group.models() {
                let motion = keys.row(*id, group.mesh(), RowKind::Transparent, None);
                glass.push(Glass { row: instance_row(model, entry.center, entry.radius, materials.row(&material)), source, motion });
            }
        }
        let slot_count = library.len() + parts.len();
        let varied_skin = scene.skinned.iter().zip(&uses).any(|(draw, used)| (0..used.len()).any(|k| varied_material(&draw.part_material(k % draw.skin.parts.max(1) as usize))));
        let varied = varied_skin || by_mesh.keys().any(|(variant, _)| *variant > 0);
        let instances = scene.mesh_instances() + uses.iter().map(ExactSizeIterator::len).sum::<usize>();
        let mut rows = Rows {
            instances: Vec::with_capacity(instances),
            motion: Vec::with_capacity(if motion { instances } else { 0 }),
            batches: Vec::new(),
            slot_base: vec![NO_BATCH; if varied { slot_count * DRAW_VARIANTS } else { slot_count }],
            slot_count,
            retained: Vec::new(),
            lod_batches: false,
            slots: 0,
            lod_rows: Vec::with_capacity(instances),
            lod_meshes: Vec::new(),
            impostor_batches: Vec::new(),
        };
        rows.push_meshes(scene, library, &by_mesh, 0, &key_of, &mut keys, &mut materials)?;
        let static_batches = rows.batches.len() as u32;
        // The skinned draws' rows in the game's order, part by part (their identities made in that
        // order): the transparent ones to the glass, the opaque ones batched by variant and part,
        // the plain ones now and the other variants after the plain batches.
        let mut skinned_rows = Vec::new();
        // A level crossfading in a band (AN-25) draws through a fade batch with the fade twins.
        let mut fade_skinned_rows = Vec::new();
        for (at, draw) in scene.skinned.iter().enumerate() {
            let part_count = draw.skin.parts.max(1) as usize;
            for (k, part) in uses[at].clone().enumerate() {
                let material = draw.part_material(k % part_count);
                // Glass is not culled: in a band only the finer level draws it (a named deviation).
                if material.is_transparent() && k >= part_count {
                    continue;
                }
                let key = keys.row(draw.id, parts[part].mesh, RowKind::Skinned, Some(parts[part].job.dst_base));
                if material.is_transparent() {
                    let row = instance_row(&draw.model, parts[part].center, parts[part].radius, materials.row(&material));
                    glass.push(Glass { row, source: parts[part].source, motion: key });
                    continue;
                }
                let row = SkinnedRow { part, draw: at, variant: material.draw_variant().index(), material, key };
                if parts[part].fades() { fade_skinned_rows.push(row) } else { skinned_rows.push(row) }
            }
        }
        skinned_rows.sort_by_key(|row| (row.variant, row.part));
        fade_skinned_rows.sort_by_key(|row| (row.variant, row.part));
        let vertex_skinned = vertex_skinned_parts(scene, library, (&vertex, picks), &mut materials);
        rows.push_skinned_variant(scene, &parts, &skinned_rows, DrawVariant::PLAIN.index(), &mut materials);
        let plain_batches = rows.batches.len() as u32;
        let mut variants = Vec::new();
        for variant in DrawVariant::ALL.into_iter().skip(1) {
            let first = rows.batches.len() as u32;
            rows.push_meshes(scene, library, &by_mesh, variant.index(), &key_of, &mut keys, &mut materials)?;
            let skinned_from = rows.batches.len() as u32;
            rows.push_skinned_variant(scene, &parts, &skinned_rows, variant.index(), &mut materials);
            let end = rows.batches.len() as u32;
            if end > first {
                variants.push(VariantRun { variant, batches: first..end, skinned_from });
            }
        }
        let (fade_runs, fade_slots) = rows.push_fade_twins(library, band > 0.0, (scene, &parts, &fade_skinned_rows), &mut materials)?;
        let far_rules: Vec<GpuFarRule> = scene.far_rules.iter().take(FAR_RULES_MAX).map(|rule| if far_rule_usable(rule) { *rule } else { GpuFarRule::default() }).collect();
        let Rows { mut instances, mut motion, batches, slot_base, retained, lod_batches, slots: visible_slots, lod_rows, impostor_batches, .. } = rows;
        let opaque_instances = instances.len() as u32;
        let view_proj = scene.camera.projection(aspect, depth_reversed);
        let lit = options.sun.map_or(scene.lighting.sun_intensity > 0.0, |sun| sun.color.iter().any(|c| *c > 0.0));
        let settings = options.shadows.filter(|_| scene.lighting.shadows && lit);
        let sun_dir = options.sun.map_or(scene.lighting.sun_dir, |sun| sun.dir);
        let shadows = settings.as_ref().map(|settings| fit_cascades(scene, aspect, sun_dir, settings, &instances));
        let views = active_views(shadows.as_ref().map_or(0, drawn_cascades), 0);
        let camera_planes = frustum_planes_for(view_proj, depth_reversed);
        let (transparent, transparent_sources) = sort_glass(&mut instances, &mut motion, glass, &camera_planes, scene.camera.eye);
        let lights = light_table(&scene.lighting);
        let mut frame = frame_uniforms(scene, view_proj, camera_planes, shadows.as_ref().zip(settings.as_ref()));
        if let Some(sun) = options.sun {
            frame.sun_dir = Vec3::from(sun.dir).normalize_or(Vec3::Y).extend(0.0).to_array();
            frame.sun_color = [sun.color[0], sun.color[1], sun.color[2], frame.sun_color[3]];
        }
        if let Some(settings) = &settings {
            // The sun chunk's PCSS sizes its penumbra by the sun's angular radius, which it reads
            // here under the forward frame and the Level-2 v2 frame alike (GxFrameV2's meaning).
            frame.sun_dir[3] = settings.sun_angular_radius;
        }
        frame.counts = [lights.len() as u32, batches.len() as u32, views, visible_slots];
        let mut cull_views = GpuCullViews { params: [visible_slots, batches.len() as u32, views, 0], ..GpuCullViews::default() };
        cull_views.lod = [eye[0], eye[1], eye[2], lod_per_height * LOD_NOMINAL_HEIGHT as f32];
        cull_views.lod_params[0] = u32::from(lod_batches);
        cull_views.lod_params[1] = band.to_bits();
        cull_views.lod_params[2] = far_rules.len() as u32;
        cull_views.planes[0] = camera_planes;
        if let (Some(set), Some(settings)) = (&shadows, &settings) {
            let texels = crate::shadow::caster_error_texels(settings.filter);
            for (c, planes) in set.planes.iter().enumerate().take(drawn_cascades(set)) {
                cull_views.planes[cascade_view(c) as usize] = *planes;
                // The error its map cannot show (lane FQ): its casters' coarsest level within it.
                cull_views.shadow_lod[c] = set.texel_world[c] * texels;
            }
        }
        let skinned_vertices = parts.iter().map(|p| p.job.count).sum();
        Ok(FramePlan {
            binned: None,
            frame,
            instances,
            opaque_instances,
            visible_slots,
            materials: materials.rows,
            material_ext: materials.ext,
            legacy_ext: vec![crate::layout::GpuLightExt::POINT; lights.len()],
            lights,
            plain_batches,
            variants,
            slot_count: slot_count as u32,
            batches,
            static_batches,
            slot_base,
            views,
            cull_views,
            cascades: shadows,
            shadows: settings,
            spot_shadows: Vec::new(),
            skin_jobs: parts.iter().map(|p| p.job).collect(),
            joints,
            skinned_vertices,
            transparent,
            transparent_sources,
            lines: scene.lines.clone(),
            logical_draws: scene.logical_draws,
            stale_rows,
            motion,
            prev_models: Vec::new(),
            retained,
            lod_per_height,
            lod_rows,
            fade_runs,
            fade_slots,
            far_rules,
            impostor_batches,
            vertex_skinned,
        })
    }

    /// Choose levels of detail for an output `height` pixels tall (renderer pass 2 A6.9): the
    /// cull's LOD view takes the output's pixels a world unit at distance 1 over the error
    /// threshold. A plan assumes [`LOD_NOMINAL_HEIGHT`] until this is called.
    pub fn set_lod_height(&mut self, height: u32) {
        self.cull_views.lod[3] = self.lod_per_height * height as f32;
    }

    /// Choose levels of detail for an output `height` pixels tall at an error threshold of
    /// `threshold_px` output pixels (game systems LOD-06, the quality's
    /// [`crate::settings::LodQuality::threshold_px`]): a coarser threshold lets every level reach
    /// proportionally nearer. [`LOD_THRESHOLD_PX`] (or a threshold that is not finite and positive)
    /// is [`FramePlan::set_lod_height`] bit for bit.
    pub fn set_lod_view(&mut self, height: u32, threshold_px: f32) {
        self.cull_views.lod[3] = LodTarget { height, threshold_px }.view_w(self.lod_per_height);
    }

    /// Thin the frame's far rules by the quality's far density (game systems LOD-06,
    /// [`crate::settings::LodQuality::far_density`], in (0, 1]): each rule keeps `density` of what
    /// it kept at its end. 1 (or a density outside (0, 1)) leaves the rules as the scene set them.
    pub fn thin_far_rules(&mut self, density: f32) {
        if !(density > 0.0 && density < 1.0) {
            return;
        }
        for rule in &mut self.far_rules {
            rule.keep *= density;
        }
    }

    /// The reference cull of the camera view: the compute pass's test, on the CPU, in the same order.
    pub fn cpu_cull(&self) -> CpuCull {
        self.cpu_cull_view(0)
    }

    /// The copies the camera draws as impostors this frame (game systems LOD-15): the camera
    /// survivors of [`FramePlan::impostor_batches`] (the cull's CPU twin over those batches only,
    /// so the GPU cull keeps the same copies), each at its row's model with its species and its
    /// fade (1 whole; a fade twin's signed share while it crossfades from the last mesh level).
    pub fn impostor_instances(&self) -> Vec<crate::impostor::draw::ImpostorInstance> {
        if self.impostor_batches.is_empty() {
            return Vec::new();
        }
        let batches: Vec<GpuBatch> = self.impostor_batches.iter().map(|impostor| self.batches[impostor.batch as usize]).collect();
        let cull = cpu_cull_view(&self.cull_views.planes[0], &self.cull_lod(), &batches, &self.instances, self.visible_slots as usize, (false, 0.0));
        let mut out = Vec::new();
        for ((impostor, batch), count) in self.impostor_batches.iter().zip(&batches).zip(&cull.counts) {
            let fade_batch = batch.lod[0] & crate::mesh::LOD_FADE_TAG != 0;
            for slot in batch.first_instance..batch.first_instance + count {
                let row = cull.visible[slot as usize] as usize;
                let fade = if fade_batch { cull.fades[slot as usize][0] } else { 1.0 };
                out.push(crate::impostor::draw::ImpostorInstance { model: self.instances[row].model, species: impostor.species, fade });
            }
        }
        out
    }

    /// The reference cull of view `view` (0 the camera, 1 + c shadow cascade c); every view but
    /// the camera casts a chain's last mesh level in its impostor's place (game systems LOD-15).
    pub fn cpu_cull_view(&self, view: usize) -> CpuCull {
        let caster_error = view.checked_sub(1).and_then(|lane| self.cull_views.shadow_lod.get(lane)).copied().unwrap_or(0.0);
        cpu_cull_view(&self.cull_views.planes[view], &self.cull_lod(), &self.batches, &self.instances, self.visible_slots as usize, (view != 0, caster_error))
    }

    /// What the cull reads to choose levels: the LOD view, the fade band and the LOD rows.
    pub fn cull_lod(&self) -> CullLod<'_> {
        CullLod { view: self.cull_views.lod, band: f32::from_bits(self.cull_views.lod_params[1]), rows: &self.lod_rows, far_rules: &self.far_rules }
    }

    /// The shadow cascades this frame plans (0 without sun shadows): [`ShadowSettings::cascades`].
    /// A far cascade off its cadence keeps last frame's map ([`crate::shadow::CascadeHistory`]).
    pub fn cascades_drawn(&self) -> usize {
        self.cascades.as_ref().map_or(0, drawn_cascades)
    }
}

/// The cascades of the sun towards `sun_dir` for `scene`'s camera under `settings`, receiver-tight
/// around the `opaque` rows' bounds (the legacy settings keep the legacy fit, bit for bit).
fn fit_cascades(scene: &Scene, aspect: f32, sun_dir: [f32; 3], settings: &ShadowSettings, opaque: &[GpuInstance]) -> Cascades {
    fit(&scene.camera, aspect, sun_dir, settings, opaque.iter().map(|row| row.bounds))
}

/// The cascades `set` holds: the leading run of positive split depths (an undrawn cascade's is 0).
fn drawn_cascades(set: &Cascades) -> usize {
    set.splits.iter().take(MAX_CASCADES).take_while(|end| **end > 0.0).count()
}

/// The fade band a plan takes from [`Scene::lod_band`]: the band when it is in (0, 1], else 0
/// (the hard switch, no fade batch; NaN included).
fn fade_band(band: f32) -> f32 {
    if band > 0.0 && band <= 1.0 { band } else { 0.0 }
}

fn batch(first_instance: usize, instance_count: usize, first_index: u32, index_count: u32, base_vertex: i32) -> GpuBatch {
    GpuBatch { first_instance: first_instance as u32, instance_count: instance_count as u32, index_count, first_index, base_vertex, first_row: first_instance as u32, lod: [0; 3] }
}

/// Append the transparent rows that survive the camera cull, back to front, with their motion
/// rows; answer their rows and sources.
fn sort_glass(instances: &mut Vec<GpuInstance>, motion: &mut Vec<MotionRow>, glass: Vec<Glass>, planes: &[[f32; 4]; 6], eye: [f32; 3]) -> (Vec<u32>, Vec<DrawSource>) {
    let kept: Vec<Glass> = glass.into_iter().filter(|g| in_frustum(planes, g.row.bounds)).collect();
    let centers: Vec<[f32; 3]> = kept.iter().map(|g| [g.row.bounds[0], g.row.bounds[1], g.row.bounds[2]]).collect();
    let mut rows = Vec::with_capacity(kept.len());
    let mut sources = Vec::with_capacity(kept.len());
    for i in back_to_front(eye, &centers) {
        let g = &kept[i as usize];
        rows.push(instances.len() as u32);
        sources.push(g.source);
        instances.push(g.row);
        motion.extend(g.motion);
    }
    (rows, sources)
}

fn frame_uniforms(scene: &Scene, view_proj: Mat4, planes: [[f32; 4]; 6], shadows: Option<(&Cascades, &ShadowSettings)>) -> GpuFrame {
    let lighting = &scene.lighting;
    let mut frame = GpuFrame {
        view_proj: view_proj.to_cols_array(),
        camera_pos: Vec3::from(scene.camera.eye).extend(1.0).to_array(),
        camera_forward: Vec3::from(camera_forward(&scene.camera)).extend(0.0).to_array(),
        sun_dir: Vec3::from(lighting.sun_dir).normalize_or(Vec3::Y).extend(0.0).to_array(),
        sun_color: radiance(lighting.sun_color, lighting.sun_intensity),
        ambient: radiance(lighting.ambient, lighting.ambient_intensity),
        planes,
        ..GpuFrame::default()
    };
    if let Some((set, settings)) = shadows {
        write_cascades(&mut frame, set, settings);
    }
    frame
}

/// The sun's cascades in the frame: the frozen v1 lanes (the first two cascades, their splits and
/// normal offsets, the bias and the texel) and every drawn cascade past the v1 prefix.
fn write_cascades(frame: &mut GpuFrame, set: &Cascades, settings: &ShadowSettings) {
    let drawn = drawn_cascades(set);
    let offsets = set.normal_offsets();
    let lane = |values: &[f32], c: usize| if c < drawn { values.get(c).copied().unwrap_or(0.0) } else { 0.0 };
    for c in 0..SHADOW_CASCADES.min(drawn) {
        frame.cascade_view_proj[c] = set.view_proj[c];
    }
    frame.cascade_splits = [lane(&set.splits, 0), lane(&set.splits, 1), 0.0, 1.0];
    frame.shadow_params = [set.shared_bias, lane(&offsets, 0), lane(&offsets, 1), 1.0 / set.map_px.max(1) as f32];
    for c in 0..drawn {
        frame.cascade_matrices[c] = set.view_proj[c];
    }
    frame.cascade_ends = std::array::from_fn(|c| lane(&set.splits, c));
    frame.cascade_offsets = std::array::from_fn(|c| lane(&offsets, c));
    frame.cascade_texels = std::array::from_fn(|c| lane(&set.texel_world, c));
    // Every lane, drawn or not: a lookup past the drawn cascades compares as it always did.
    frame.cascade_bias = set.comparison_bias();
    frame.shadow_soft = [libm::tanf(settings.sun_angular_radius), settings.blend_band, settings.end_fade, 0.0];
    frame.shadow_counts = [drawn as u32, 0, 0, 0];
}
