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
use std::collections::BTreeMap;

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

use crate::caps::BUFFER_MAX_BYTES;
use crate::cull::{active_views, cascade_view, cpu_cull};
use crate::error::{RenderCode, RenderError};
use crate::instance::instance_row;
use crate::layout::{GpuBatch, GpuCullViews, GpuFrame, GpuInstance, GpuLight, GpuMaterial, GpuMaterialExt, GpuSkinJob, GpuSkinVertex, MAX_CASCADES, NO_BATCH, SHADOW_CASCADES};
use crate::mesh::{LOD_NOMINAL_HEIGHT, LOD_THRESHOLD_PX, LodChain, MeshData, Vertex};
use crate::meshlet::{self, MeshletLibrary, MeshletRange, MeshletSet};
use crate::motion::{DrawId, MotionKeys, MotionRow, RowKind};
use crate::pbr::{MaterialKey, light_table, radiance};
use crate::retained::{InstanceGroup, RetainedSpan};
use crate::settings::{Meshlets, ShadowSettings};
use crate::shadow::{Cascades, camera_forward, fit};
use crate::skin::{MAX_JOINTS, SkinId, SkinnedMeshData, skinned_bounds};
use crate::transparent::back_to_front;

pub use crate::cull::{CpuCull, frustum_planes, frustum_planes_for, in_frustum};
pub use crate::pbr::{Lighting, Material, PointLight, srgb_to_linear};

/// A mesh in a [`MeshLibrary`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MeshId(u32);

impl MeshId {
    /// The unit cube.
    pub const CUBE: MeshId = MeshId(0);
    /// The unit-radius sphere.
    pub const SPHERE: MeshId = MeshId(1);

    /// The id with this raw value (it may name no mesh).
    pub const fn from_raw(raw: u32) -> MeshId {
        MeshId(raw)
    }

    /// The raw value.
    pub const fn raw(self) -> u32 {
        self.0
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

/// A library mesh's levels of detail (renderer pass 2 A6.9): each level a mesh of its own (the
/// level's triangles over the vertices they use), with the chain's object-space errors.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshLods {
    /// Level k's mesh at `levels[k - 1]` (level 0 is the mesh itself).
    pub levels: Vec<MeshId>,
    /// Their object-space errors, never decreasing.
    pub errors: Vec<f32>,
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
    meshlet_setting: Meshlets,
    meshlets: MeshletLibrary,
    /// Per entry: how it draws on the meshlet path.
    meshlet_states: Vec<MeshletState>,
    /// Per entry: how it came in.
    roles: Vec<EntryRole>,
    /// The levels of the meshes that brought them (A6.9), by entry.
    lods: BTreeMap<u32, MeshLods>,
    /// The valid sets meshes brought with them (R2.3's `genex_meshlets`), by entry, kept for a
    /// re-cluster.
    imported: BTreeMap<u32, MeshletSet>,
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
            meshlet_setting: setting,
            meshlets: MeshletLibrary::default(),
            meshlet_states: Vec::new(),
            roles: Vec::new(),
            lods: BTreeMap::new(),
            imported: BTreeMap::new(),
        };
        for mesh in [MeshData::cube(), MeshData::sphere()] {
            library.push(mesh, EntryRole::Mesh, None);
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
        self.meshlet_states.get(id.0 as usize).copied()
    }

    /// Entry `entry`'s meshlet state, appending its meshlets when it is clustered: its imported set
    /// when that is valid, else [`meshlet::build`]'s.
    fn cluster(&mut self, entry: usize) -> MeshletState {
        let mesh = self.entries[entry];
        if self.roles[entry] != EntryRole::Mesh || !self.meshlet_setting.clusters(mesh.index_count / 3) {
            return MeshletState::Whole;
        }
        let base = mesh.base_vertex as usize;
        let indices = &self.indices[mesh.first_index as usize..(mesh.first_index + mesh.index_count) as usize];
        let imported = self.imported.get(&(entry as u32)).filter(|set| meshlet::validate(set, indices, mesh.vertex_count).is_ok());
        let set = match imported {
            Some(set) => Cow::Borrowed(set),
            None => {
                let positions: Vec<[f32; 3]> = self.vertices[base..base + mesh.vertex_count as usize].iter().map(|v| v.position).collect();
                let Ok(set) = meshlet::build(indices, &positions) else { return MeshletState::Refused(RenderCode::MeshInvalid) };
                Cow::Owned(set)
            }
        };
        match self.meshlets.append_within(&set, base as u32, BUFFER_MAX_BYTES) {
            Ok(range) => MeshletState::Clustered(range),
            Err(refusal) => MeshletState::Refused(refusal.code()),
        }
    }

    fn push(&mut self, mesh: MeshData, role: EntryRole, imported: Option<MeshletSet>) -> MeshId {
        let (center, radius) = mesh.bounds();
        let id = MeshId(self.entries.len() as u32);
        self.entries.push(MeshEntry {
            first_index: self.indices.len() as u32,
            index_count: mesh.indices.len() as u32,
            base_vertex: self.vertices.len() as i32,
            vertex_count: mesh.vertices.len() as u32,
            center,
            radius,
        });
        self.slots.extend(std::iter::repeat_n(id.0, mesh.vertices.len()));
        self.vertices.extend(mesh.vertices);
        self.indices.extend(mesh.indices);
        self.roles.push(role);
        if let Some(set) = imported {
            self.imported.insert(id.0, set);
        }
        let state = self.cluster(id.0 as usize);
        self.meshlet_states.push(state);
        id
    }

    /// Refused `mesh-invalid` when `mesh` is empty or the library would exceed `u32` indices.
    fn check_room(&self, mesh: &MeshData) -> Result<(), RenderError> {
        let empty = mesh.indices.is_empty() || mesh.vertices.is_empty();
        let total_vertices = self.vertices.len() + mesh.vertices.len();
        let total_indices = self.indices.len() + mesh.indices.len();
        if empty || i32::try_from(total_vertices).is_err() || u32::try_from(total_indices).is_err() {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "empty mesh, or the library is full"));
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
        self.check_room(&mesh)?;
        Ok(self.push(mesh, EntryRole::Mesh, imported))
    }

    /// [`MeshLibrary::add_with_meshlets`] for a model part, its levels of detail kept as meshes of
    /// their own (renderer pass 2 A6.9: each level's triangles over the vertices it uses, its
    /// bounding sphere the part's, so every level is culled as the part is). A chain whose level
    /// indexes past the part's vertices is dropped (the part draws whole); a level the library
    /// has no room for refuses the part with nothing added.
    pub fn add_part(&mut self, part: ModelPart) -> Result<MeshId, RenderError> {
        let ModelPart { mesh, meshlets, lods } = part;
        let vertex_count = mesh.vertices.len() as u32;
        let chain = lods.filter(|chain| chain.levels.iter().all(|level| level.indices.iter().all(|index| *index < vertex_count)));
        let levels: Vec<MeshData> = chain.iter().flat_map(|chain| chain.levels.iter().map(|level| level_mesh(&mesh, &level.indices))).collect();
        self.check_room(&mesh)?;
        let extra = levels.iter().fold((mesh.vertices.len(), mesh.indices.len()), |(v, i), level| (v + level.vertices.len(), i + level.indices.len()));
        if i32::try_from(self.vertices.len() + extra.0).is_err() || u32::try_from(self.indices.len() + extra.1).is_err() {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "the library is full"));
        }
        let (center, radius) = mesh.bounds();
        let id = self.push(mesh, EntryRole::Mesh, meshlets);
        let mut ids = Vec::with_capacity(levels.len());
        for level in levels {
            let level_id = self.push(level, EntryRole::Level, None);
            let entry = &mut self.entries[level_id.0 as usize];
            (entry.center, entry.radius) = (center, radius);
            ids.push(level_id);
        }
        if let Some(chain) = chain.filter(|_| !ids.is_empty()) {
            self.lods.insert(id.0, MeshLods { levels: ids, errors: chain.errors() });
        }
        Ok(id)
    }

    /// The levels of detail mesh `id` brought ([`MeshLibrary::add_part`]), if any.
    pub fn lods(&self, id: MeshId) -> Option<&MeshLods> {
        self.lods.get(&id.0)
    }

    /// Add a skinned mesh: its bind pose as a mesh and its skin rows. Refused `mesh-invalid` when
    /// the skin rows and vertices differ in number, a joint index is past its joints, it has more
    /// than [`MAX_JOINTS`] joints or its inverse bind matrices do not match them.
    pub fn add_skinned(&mut self, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
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
        self.check_room(&data.mesh)?;
        let mesh = self.push(data.mesh.clone(), EntryRole::Skinned, None);
        self.skin.extend_from_slice(&data.skin);
        Ok(SkinId { mesh, skin_base, joints: joints as u32 })
    }

    /// The mesh's entry.
    pub fn entry(&self, id: MeshId) -> Option<&MeshEntry> {
        self.entries.get(id.0 as usize)
    }

    /// Meshes in the library.
    pub fn len(&self) -> usize {
        self.entries.len()
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
    logical_draws: u32,
    /// The draw id later draws carry ([`Scene::set_id`]).
    id: Option<DrawId>,
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
            logical_draws: 0,
            id: None,
        }
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
        self.draws.push(DrawItem { mesh, model, material, id: self.id });
        self.logical_draws += 1;
        self
    }

    /// Draw `mesh` once per model: one logical draw, however many instances.
    pub fn draw_instanced(&mut self, mesh: MeshId, models: &[[f32; 16]], material: Material) -> &mut Self {
        let id = self.id;
        self.draws.extend(models.iter().map(|model| DrawItem { mesh, model: *model, material, id }));
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
        self.groups.push(GroupDraw { group: group.clone(), material, id: self.id });
        self.logical_draws += 1;
        self
    }

    /// Instances the scene draws through mesh draws and retained groups.
    pub fn mesh_instances(&self) -> usize {
        self.draws.len() + self.groups.iter().map(|draw| draw.group.len()).sum::<usize>()
    }

    /// Draw a skinned mesh posed by `joints`: one logical draw.
    pub fn draw_skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, material: Material) -> &mut Self {
        self.skinned.push(SkinnedDraw { skin, model, joints, material, id: self.id });
        self.logical_draws += 1;
        self
    }

    /// Draw a line segment: one logical draw.
    pub fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]) -> &mut Self {
        let color = color.map(|c| f32::from(c) / 255.0);
        self.lines.push(LineVertex { position: from, color });
        self.lines.push(LineVertex { position: to, color });
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
        let meshes = (variant, MeshId(0))..=(variant, MeshId(u32::MAX));
        for ((_, mesh), drawn) in by_mesh.range(meshes) {
            let entry = mesh_entry(library, *mesh)?;
            // A6.9: a mesh drawn whole with levels gets a batch per level, each with slots of its
            // own over the mesh's rows (pushed once); the cull keeps each instance in one of
            // them (`mesh::lod_keeps`).
            let lods = library.lods(*mesh).filter(|_| library.meshlet_state(*mesh) == Some(MeshletState::Whole));
            let first_row = self.instances.len() as u32;
            let count = self.push_mesh_rows(scene, entry, drawn, key_of, keys, materials);
            let levels = lods.map_or(0, |lods| lods.levels.len());
            for level in 0..=levels {
                let (level_mesh, geometry) = match lods {
                    Some(lods) if level > 0 => (lods.levels[level - 1], mesh_entry(library, lods.levels[level - 1])?),
                    _ => (*mesh, entry),
                };
                self.slot_base[variant * self.slot_count + level_mesh.raw() as usize] = self.slots;
                let mut row = batch(self.slots as usize, count, geometry.first_index, geometry.index_count, geometry.base_vertex);
                row.first_row = first_row;
                row.lod = lods.map_or([0; 3], |lods| crate::mesh::batch_lod(level as u32, &lods.errors, entry.radius));
                self.batches.push(row);
                self.slots += count as u32;
            }
            self.lod_batches |= levels > 0;
        }
        Ok(())
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
            self.instances.push(instance_row(&draw.model, entry.center, entry.radius, materials.row(&draw.material)));
            self.motion.extend(key_of.get(*at).copied().flatten());
        }
        self.instances.len() - first
    }

    /// One opaque retained group's rows: its cached rows under this frame's material row, and its
    /// span (A.0b).
    fn push_group(&mut self, GroupDraw { group, material, id }: &GroupDraw, entry: &MeshEntry, keys: &mut DrawKeys, materials: &mut Materials) {
        let material = materials.row(material);
        let first = self.instances.len();
        self.instances.extend_from_slice(&group.rows(entry.center, entry.radius));
        if material != 0 {
            for row in &mut self.instances[first..] {
                row.material = material;
            }
        }
        for _ in 0..group.len() {
            self.motion.extend(keys.row(*id, group.mesh(), RowKind::Opaque, None));
        }
        let rows = group.len() as u32;
        self.retained.push(RetainedSpan { group: group.clone(), first_row: first as u32, rows, material, bounds: (entry.center, entry.radius) });
    }

    /// One opaque skinned draw's batch (one row), its slot base in `variant`'s region.
    fn push_skinned(&mut self, part: &SkinnedPart, draw: &SkinnedDraw, variant: usize, key: Option<MotionRow>, materials: &mut Materials) {
        let row = instance_row(&draw.model, part.center, part.radius, materials.row(&draw.material));
        self.slot_base[variant * self.slot_count + part.job.slot as usize] = self.slots;
        let mut skinned = batch(self.slots as usize, 1, part.source.first_index, part.source.index_count, part.source.base_vertex);
        skinned.first_row = self.instances.len() as u32;
        self.batches.push(skinned);
        self.slots += 1;
        self.instances.push(row);
        self.motion.extend(key);
    }
}

/// One skinned draw's job, its batch geometry and its model-space bounds.
struct SkinnedPart {
    job: GpuSkinJob,
    source: DrawSource,
    center: [f32; 3],
    radius: f32,
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

/// The skinning jobs of every skinned draw, refused `mesh-invalid` for an unknown mesh or a
/// joint count that differs from its skin's.
fn skinned_parts(scene: &Scene, library: &MeshLibrary) -> Result<(Vec<SkinnedPart>, Vec<[f32; 16]>), RenderError> {
    let mut parts = Vec::with_capacity(scene.skinned.len());
    let mut joints = Vec::new();
    let mut dst_base = 0u32;
    for (i, draw) in scene.skinned.iter().enumerate() {
        let entry = mesh_entry(library, draw.skin.mesh)?;
        if draw.joints.len() != draw.skin.joints as usize {
            return Err(RenderError::refused(
                RenderCode::MeshInvalid,
                format!("{} joint matrices for a skin of {}", draw.joints.len(), draw.skin.joints),
            ));
        }
        let job = GpuSkinJob {
            src_base: entry.base_vertex as u32,
            count: entry.vertex_count,
            dst_base,
            joint_base: joints.len() as u32,
            skin_base: draw.skin.skin_base,
            slot: (library.len() + i) as u32,
            pad: [0; 2],
        };
        let source = DrawSource { skinned: true, first_index: entry.first_index, index_count: entry.index_count, base_vertex: dst_base as i32 };
        let (center, radius) = skinned_bounds(entry.center, entry.radius, &draw.joints);
        joints.extend_from_slice(&draw.joints);
        dst_base += entry.vertex_count;
        parts.push(SkinnedPart { job, source, center, radius });
    }
    Ok((parts, joints))
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
        let depth_reversed = options.depth_reversed;
        let (parts, joints) = skinned_parts(scene, library)?;
        let mut materials = Materials::default();
        let mut keys = DrawKeys { keys: motion.then(MotionKeys::default) };
        // Opaque draws by variant and mesh as indices into the scene's draws (and, with motion,
        // into their keys, made in draw order so an id's ordinals follow the game's order).
        let mut by_mesh: BTreeMap<(usize, MeshId), MeshDraws> = BTreeMap::new();
        let mut key_of: Vec<Option<MotionRow>> = if motion { vec![None; scene.draws.len()] } else { Vec::new() };
        let mut glass = Vec::new();
        for (at, draw) in scene.draws.iter().enumerate() {
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
        for (at, GroupDraw { group, material, id }) in scene.groups.iter().enumerate().filter(|(_, draw)| !draw.group.is_empty()) {
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
        let varied_skin = scene.skinned.iter().any(|draw| !draw.material.is_transparent() && draw.material.draw_variant() != DrawVariant::PLAIN);
        let varied = varied_skin || by_mesh.keys().any(|(variant, _)| *variant > 0);
        let instances = scene.mesh_instances() + parts.len();
        let mut rows = Rows {
            instances: Vec::with_capacity(instances),
            motion: Vec::with_capacity(if motion { instances } else { 0 }),
            batches: Vec::new(),
            slot_base: vec![NO_BATCH; if varied { slot_count * DRAW_VARIANTS } else { slot_count }],
            slot_count,
            retained: Vec::new(),
            lod_batches: false,
            slots: 0,
        };
        rows.push_meshes(scene, library, &by_mesh, 0, &key_of, &mut keys, &mut materials)?;
        let static_batches = rows.batches.len() as u32;
        // The skinned draws in the game's order: the transparent ones to the glass, the plain ones
        // batched now, the other variants after the plain batches.
        let mut varied_skinned = Vec::new();
        for (at, (part, draw)) in parts.iter().zip(&scene.skinned).enumerate() {
            let key = keys.row(draw.id, draw.skin.mesh, RowKind::Skinned, Some(part.job.dst_base));
            if draw.material.is_transparent() {
                let row = instance_row(&draw.model, part.center, part.radius, materials.row(&draw.material));
                glass.push(Glass { row, source: part.source, motion: key });
                continue;
            }
            match draw.material.draw_variant().index() {
                0 => rows.push_skinned(part, draw, 0, key, &mut materials),
                variant => varied_skinned.push((variant, at, key)),
            }
        }
        let plain_batches = rows.batches.len() as u32;
        let mut variants = Vec::new();
        for variant in DrawVariant::ALL.into_iter().skip(1) {
            let first = rows.batches.len() as u32;
            rows.push_meshes(scene, library, &by_mesh, variant.index(), &key_of, &mut keys, &mut materials)?;
            let skinned_from = rows.batches.len() as u32;
            for (_, at, key) in varied_skinned.iter().filter(|(v, _, _)| *v == variant.index()) {
                rows.push_skinned(&parts[*at], &scene.skinned[*at], variant.index(), *key, &mut materials);
            }
            let end = rows.batches.len() as u32;
            if end > first {
                variants.push(VariantRun { variant, batches: first..end, skinned_from });
            }
        }
        let Rows { mut instances, mut motion, batches, slot_base, retained, lod_batches, slots: visible_slots, .. } = rows;
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
        let lod_per_height = lod_per_height(&scene.camera);
        let mut cull_views = GpuCullViews { params: [visible_slots, batches.len() as u32, views, 0], ..GpuCullViews::default() };
        let eye = scene.camera.eye;
        cull_views.lod = [eye[0], eye[1], eye[2], lod_per_height * LOD_NOMINAL_HEIGHT as f32];
        cull_views.lod_params[0] = u32::from(lod_batches);
        cull_views.planes[0] = camera_planes;
        if let Some(set) = &shadows {
            for (c, planes) in set.planes.iter().enumerate().take(drawn_cascades(set)) {
                cull_views.planes[cascade_view(c) as usize] = *planes;
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
            motion,
            prev_models: Vec::new(),
            retained,
            lod_per_height,
        })
    }

    /// Choose levels of detail for an output `height` pixels tall (renderer pass 2 A6.9): the
    /// cull's LOD view takes the output's pixels a world unit at distance 1 over the error
    /// threshold. A plan assumes [`LOD_NOMINAL_HEIGHT`] until this is called.
    pub fn set_lod_height(&mut self, height: u32) {
        self.cull_views.lod[3] = self.lod_per_height * height as f32;
    }

    /// The reference cull of the camera view: the compute pass's test, on the CPU, in the same order.
    pub fn cpu_cull(&self) -> CpuCull {
        self.cpu_cull_view(0)
    }

    /// The reference cull of view `view` (0 the camera, 1 + c shadow cascade c).
    pub fn cpu_cull_view(&self, view: usize) -> CpuCull {
        cpu_cull(&self.cull_views.planes[view], self.cull_views.lod, &self.batches, &self.instances, self.visible_slots as usize)
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
