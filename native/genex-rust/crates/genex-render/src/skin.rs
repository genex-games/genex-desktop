//! Skinned glTF: the mesh in bind pose with four joints and weights per vertex, the node tree its
//! joints hang in, and its animations. A frame's skinned draw names its joint matrices; a compute
//! pass (`shaders/skin.wgsl`) blends them into each vertex and writes the result into a storage
//! vertex buffer the opaque batches draw from, with no CPU copy. [`skin_vertices_cpu`] is the
//! same arithmetic on the CPU: the reference the compute pass is held to (within 1e-5).
//!
//! Joint matrices follow glTF: `inverse(global(mesh node)) × global(joint) × inverse bind`.
//!
//! A skinned GLB loads every primitive of every node its skin binds, one [`SkinPart`] per material
//! (game systems AN-16a, [`SkinnedModel`]); each part skins as a job of its own and draws under its
//! own material. Draws posing one skin with a bit-identical palette share its jobs and output, and
//! a job whose output the skinned table already holds is skipped (AN-16b, `SkinnedHeld`).
//!
//! Motion vectors (RQ5.1) need where each skinned vertex was last frame: [`SkinnedPair`] keeps two
//! skinned output buffers and swaps them every frame, so last frame's output stays intact while
//! this frame's is written (no copy), and the prepass's motion entry reads it at the row's
//! previous base ([`crate::motion::MotionHistory`] maps rows across frames).

use crate::compile::Compiled;
use glam::{Mat4, Quat, Vec3, Vec4};
use wgpu::{BindGroupLayout, Buffer, ComputePipeline, Device};

use crate::error::RenderError;
use crate::layout::{GpuSkinJob, GpuSkinVertex};
use crate::mesh::{LodChain, LodLevel, LodMerge, MeshData, Vertex, check_attribute_layout, invalid, open_glb, read_lod_extras, read_primitive};
use crate::scene::MeshId;
use crate::skinned_lod::{SkinnedLevel, skinned_levels};

/// Joints one skin may have (the joint table holds every skinned draw's matrices).
pub const MAX_JOINTS: usize = 256;
/// Invocations per skinning workgroup (`SKIN_WORKGROUP` in skin.wgsl): one vertex each.
pub const SKIN_WORKGROUP: u32 = 64;

/// A node's local transform.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trs {
    /// Translation.
    pub translation: [f32; 3],
    /// Rotation quaternion, xyzw.
    pub rotation: [f32; 4],
    /// Scale.
    pub scale: [f32; 3],
}

impl Trs {
    /// No transform.
    pub const IDENTITY: Trs = Trs { translation: [0.0; 3], rotation: [0.0, 0.0, 0.0, 1.0], scale: [1.0; 3] };

    /// Scale, then rotate, then translate.
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_scale_rotation_translation(Vec3::from(self.scale), Quat::from_array(self.rotation), Vec3::from(self.translation))
    }
}

/// One node of the tree a skin's joints hang in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkeletonNode {
    /// Its parent node.
    pub parent: Option<usize>,
    /// Its rest transform.
    pub rest: Trs,
}

/// The node tree, which nodes are joints, and their inverse bind matrices.
#[derive(Clone, Debug, PartialEq)]
pub struct Skeleton {
    /// Every node of the file.
    pub nodes: Vec<SkeletonNode>,
    /// The joints, as node indices, in skin order.
    pub joints: Vec<usize>,
    /// Each joint's inverse bind matrix, column-major.
    pub inverse_bind: Vec<[f32; 16]>,
    /// The node holding the skinned mesh: its global transform is taken out of every joint.
    pub mesh_node: Option<usize>,
}

impl Skeleton {
    /// Every node at rest.
    pub fn rest_pose(&self) -> Vec<Trs> {
        self.nodes.iter().map(|node| node.rest).collect()
    }

    /// Global transforms of every node for `pose` (one local transform per node; a missing one
    /// is the node's rest). Parents come before children whatever the file's order.
    fn globals(&self, pose: &[Trs]) -> Vec<Mat4> {
        let local = |i: usize| pose.get(i).unwrap_or(&self.nodes[i].rest).matrix();
        let mut globals: Vec<Option<Mat4>> = vec![None; self.nodes.len()];
        for start in 0..self.nodes.len() {
            let mut chain = vec![start];
            while let Some(parent) = self.nodes[chain[chain.len() - 1]].parent
                && globals[parent].is_none()
                && chain.len() <= self.nodes.len()
            {
                chain.push(parent);
            }
            for &node in chain.iter().rev() {
                if globals[node].is_some() {
                    continue;
                }
                let parent = self.nodes[node].parent.and_then(|p| globals[p]).unwrap_or(Mat4::IDENTITY);
                globals[node] = Some(parent * local(node));
            }
        }
        globals.into_iter().map(|g| g.unwrap_or(Mat4::IDENTITY)).collect()
    }

    /// The joint matrices of `pose`, in skin order, column-major.
    pub fn joint_matrices(&self, pose: &[Trs]) -> Vec<[f32; 16]> {
        let globals = self.globals(pose);
        let unmesh = self.mesh_node.and_then(|m| globals.get(m)).map_or(Mat4::IDENTITY, |g| g.inverse());
        self.joints
            .iter()
            .zip(&self.inverse_bind)
            .map(|(&node, ibm)| (unmesh * globals[node] * Mat4::from_cols_array(ibm)).to_cols_array())
            .collect()
    }
}

/// How a channel interpolates between keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interpolation {
    /// Hold each key until the next.
    Step,
    /// Lerp translations and scales, slerp rotations (cubic-spline channels use their key values).
    Linear,
}

/// What a channel animates.
#[derive(Clone, Debug, PartialEq)]
pub enum ChannelValues {
    /// Translation keys.
    Translation(Vec<[f32; 3]>),
    /// Rotation keys (xyzw).
    Rotation(Vec<[f32; 4]>),
    /// Scale keys.
    Scale(Vec<[f32; 3]>),
}

/// One animated property of one node.
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    /// The node.
    pub node: usize,
    /// Key times in seconds, ascending.
    pub times: Vec<f32>,
    /// Key values, one per time.
    pub values: ChannelValues,
    /// Interpolation.
    pub interpolation: Interpolation,
}

/// A glTF animation.
#[derive(Clone, Debug, PartialEq)]
pub struct Animation {
    /// Its name in the file.
    pub name: Option<String>,
    /// The last key time.
    pub duration: f32,
    /// Its channels (morph-target weights are not read).
    pub channels: Vec<Channel>,
}

/// The keys around `time` and how far between them it is.
fn keys_at(times: &[f32], time: f32, interpolation: Interpolation) -> (usize, usize, f32) {
    let after = times.partition_point(|&t| t <= time);
    if after == 0 {
        return (0, 0, 0.0);
    }
    if after >= times.len() {
        let last = times.len() - 1;
        return (last, last, 0.0);
    }
    let (a, b) = (after - 1, after);
    let span = times[b] - times[a];
    let t = if span > 0.0 && interpolation == Interpolation::Linear { (time - times[a]) / span } else { 0.0 };
    (a, b, t)
}

impl Animation {
    /// The pose at `time` seconds (clamped to the animation): every node at rest except what the
    /// channels move.
    pub fn sample(&self, skeleton: &Skeleton, time: f32) -> Vec<Trs> {
        let mut pose = skeleton.rest_pose();
        let time = time.clamp(0.0, self.duration);
        for channel in &self.channels {
            let Some(trs) = pose.get_mut(channel.node) else { continue };
            if channel.times.is_empty() {
                continue;
            }
            let (a, b, t) = keys_at(&channel.times, time, channel.interpolation);
            match &channel.values {
                ChannelValues::Translation(keys) => trs.translation = Vec3::from(keys[a]).lerp(Vec3::from(keys[b]), t).to_array(),
                ChannelValues::Scale(keys) => trs.scale = Vec3::from(keys[a]).lerp(Vec3::from(keys[b]), t).to_array(),
                ChannelValues::Rotation(keys) => {
                    let (qa, qb) = (Quat::from_array(keys[a]).normalize(), Quat::from_array(keys[b]).normalize());
                    trs.rotation = qa.slerp(qb, t).normalize().to_array();
                }
            }
        }
        pose
    }
}

/// A skinned mesh: bind-pose vertices, one skin row per vertex, the skeleton and its animations.
#[derive(Clone, Debug, PartialEq)]
pub struct SkinnedMeshData {
    /// The mesh in bind pose, in the skinned node's own space.
    pub mesh: MeshData,
    /// Joints and weights per vertex (indices into `skeleton.joints`).
    pub skin: Vec<GpuSkinVertex>,
    /// The skeleton.
    pub skeleton: Skeleton,
    /// The file's animations.
    pub animations: Vec<Animation>,
}

/// A skinned mesh in a renderer's library.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkinId {
    pub(crate) mesh: MeshId,
    pub(crate) skin_base: u32,
    pub(crate) joints: u32,
    /// Its first part in the library's part list (AN-16a).
    pub(crate) part_base: u32,
    /// Its parts.
    pub(crate) parts: u32,
}

impl SkinId {
    /// Its bind-pose mesh in the library.
    pub fn mesh(self) -> MeshId {
        self.mesh
    }

    /// Joint matrices each of its draws must name.
    pub fn joint_count(self) -> u32 {
        self.joints
    }

    /// Its parts: the materials [`crate::scene::Scene::draw_skinned_parts`] takes.
    pub fn part_count(self) -> u32 {
        self.parts
    }
}

impl SkinnedMeshData {
    /// The skinned mesh of a GLB ([`SkinnedModel::from_glb`]) without its parts: every primitive
    /// of every node sharing the first skin, merged. Refused as [`SkinnedModel::from_glb`].
    pub fn from_glb(bytes: &[u8]) -> Result<SkinnedMeshData, RenderError> {
        SkinnedModel::from_glb(bytes).map(|model| model.data)
    }
}

/// One part of a skinned mesh (game systems AN-16a): a run of its vertices and the triangles over
/// them, drawn with one material. Its indices name only its own vertices, so its skinning job
/// writes them alone and its batch draws them under its own material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkinPart {
    /// Its first vertex in the mesh.
    pub first_vertex: u32,
    /// Its vertices.
    pub vertex_count: u32,
    /// Its first index in the mesh.
    pub first_index: u32,
    /// Its indices (a multiple of 3).
    pub index_count: u32,
    /// The glTF material its primitives name (`None`: none), the order [`crate::glb_material::GlbModel`]
    /// lists a GLB's materials in when the skinned primitives are all it has.
    pub material: Option<u32>,
}

impl SkinPart {
    /// The whole of `mesh` as one part naming no material.
    pub fn whole(mesh: &MeshData) -> SkinPart {
        SkinPart { first_vertex: 0, vertex_count: mesh.vertices.len() as u32, first_index: 0, index_count: mesh.indices.len() as u32, material: None }
    }
}

/// A skinned GLB with its parts (game systems AN-16a): the merged skinned mesh and one part per
/// material, in the order the materials are first used.
#[derive(Clone, Debug, PartialEq)]
pub struct SkinnedModel {
    /// The skinned mesh: every part's vertices and triangles, part after part.
    pub data: SkinnedMeshData,
    /// Its parts, tiling its vertices and indices in order.
    pub parts: Vec<SkinPart>,
    /// Its simplified levels (game systems AN-25), from every skinned primitive's
    /// `extras.genex_lods`; empty when a part has none (it then draws whole).
    pub levels: Vec<SkinnedLevel>,
}

impl SkinnedModel {
    /// The skinned mesh of a GLB: the first skinned node's skin (of its default scene or of any
    /// node) and every primitive of every node that skin binds, one part per material in
    /// first-use order (a single-material GLB is one part, in the file's primitive order), with
    /// its node tree and animations. Refused `mesh-invalid`: no skinned node, a primitive without
    /// JOINTS_0 or WEIGHTS_0, a joint index past the skin's joints, more than [`MAX_JOINTS`]
    /// joints, a node with two parents, or anything [`MeshData::from_glb`] refuses.
    pub fn from_glb(bytes: &[u8]) -> Result<SkinnedModel, RenderError> {
        let gltf = open_glb(bytes)?;
        let blob = gltf.blob.as_deref();
        let node = gltf.nodes().find(|n| n.mesh().is_some() && n.skin().is_some()).ok_or_else(|| invalid("the GLB has no skinned mesh"))?;
        let Some(skin) = node.skin() else { return Err(invalid("the GLB has no skinned mesh")) };
        let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
        if joints.is_empty() || joints.len() > MAX_JOINTS {
            return Err(invalid(format!("{} joints, between 1 and {MAX_JOINTS}", joints.len())));
        }
        let inverse_bind: Vec<[f32; 16]> = match skin.reader(|_| blob).read_inverse_bind_matrices() {
            Some(matrices) => matrices.map(|m| Mat4::from_cols_array_2d(&m).to_cols_array()).collect(),
            None => vec![Mat4::IDENTITY.to_cols_array(); joints.len()],
        };
        if inverse_bind.len() != joints.len() {
            return Err(invalid("inverseBindMatrices and joints counts differ"));
        }
        // Every node the skin binds: a character split into body, clothes and hair is one skin
        // over several nodes (glTF ignores a skinned node's own transform, so they share space).
        let skinned_meshes: Vec<gltf::Mesh<'_>> =
            gltf.nodes().filter(|n| n.skin().is_some_and(|s| s.index() == skin.index())).filter_map(|n| n.mesh()).collect();
        let (mesh, skin_rows, parts, chains) = read_skinned_parts(&gltf, &skinned_meshes, joints.len())?;
        let levels = skinned_levels(&mesh, &skin_rows, &parts, &chains);
        let skeleton = Skeleton { nodes: skeleton_nodes(&gltf)?, joints, inverse_bind, mesh_node: Some(node.index()) };
        let animations = gltf.animations().map(|a| read_animation(&a, blob)).collect::<Result<_, _>>()?;
        Ok(SkinnedModel { data: SkinnedMeshData { mesh, skin: skin_rows, skeleton, animations }, parts, levels })
    }
}

/// One material's primitives while a skinned mesh is read: their vertices, triangles (indices
/// local to the group) and skin rows.
struct PartGroup {
    material: Option<usize>,
    mesh: MeshData,
    skin: Vec<GpuSkinVertex>,
    /// Its primitives' levels (AN-25), over the group's vertices.
    lods: LodMerge,
}

/// One part's chain (AN-25), its indices moved from the part's own vertices onto the mesh's.
fn rebased_chain(chain: LodChain, first_vertex: u32) -> LodChain {
    let levels = chain.levels.into_iter().map(|level| LodLevel { indices: level.indices.iter().map(|index| first_vertex + index).collect(), error: level.error });
    LodChain { levels: levels.collect() }
}

/// A skinned GLB's merged mesh, its skin rows, its parts and each part's chain of levels.
type SkinnedParts = (MeshData, Vec<GpuSkinVertex>, Vec<SkinPart>, Vec<Option<LodChain>>);

/// The primitives of `meshes`, grouped by material in first-use order and laid out group after
/// group: the merged mesh, its skin rows and one part per group with triangles.
fn read_skinned_parts(gltf: &gltf::Gltf, meshes: &[gltf::Mesh<'_>], joint_count: usize) -> Result<SkinnedParts, RenderError> {
    let mut groups: Vec<PartGroup> = Vec::new();
    for primitive in meshes.iter().flat_map(gltf::Mesh::primitives) {
        let key = primitive.material().index();
        let at = match groups.iter().position(|group| group.material == key) {
            Some(at) => at,
            None => {
                groups.push(PartGroup { material: key, mesh: MeshData::default(), skin: Vec::new(), lods: LodMerge::default() });
                groups.len() - 1
            }
        };
        read_skinned_primitive(gltf, &primitive, joint_count, &mut groups[at])?;
    }
    let mut mesh = MeshData::default();
    let mut skin = Vec::new();
    let mut parts = Vec::new();
    let mut chains = Vec::new();
    for group in groups.into_iter().filter(|group| !group.mesh.indices.is_empty()) {
        let first_vertex = u32::try_from(mesh.vertices.len()).map_err(|_| invalid("too many vertices"))?;
        let first_index = u32::try_from(mesh.indices.len()).map_err(|_| invalid("too many indices"))?;
        parts.push(SkinPart {
            first_vertex,
            vertex_count: group.mesh.vertices.len() as u32,
            first_index,
            index_count: group.mesh.indices.len() as u32,
            material: group.material.map(|index| index as u32),
        });
        mesh.indices.extend(group.mesh.indices.iter().map(|i| first_vertex + i));
        mesh.vertices.extend(group.mesh.vertices);
        skin.extend(group.skin);
        chains.push(group.lods.finish().0.map(|chain| rebased_chain(chain, first_vertex)));
    }
    if mesh.indices.is_empty() {
        return Err(invalid("the skinned mesh has no triangles"));
    }
    Ok((mesh, skin, parts, chains))
}

/// Append one skinned primitive's vertices, triangles and skin rows to `group`.
fn read_skinned_primitive(gltf: &gltf::Gltf, primitive: &gltf::Primitive<'_>, joint_count: usize, group: &mut PartGroup) -> Result<(), RenderError> {
    let blob = gltf.blob.as_deref();
    let (vertices, indices) = read_primitive(primitive, blob)?;
    for semantic in [gltf::Semantic::Joints(0), gltf::Semantic::Weights(0)] {
        check_attribute_layout(primitive, &semantic)?;
    }
    let reader = primitive.reader(|_| blob);
    let joints: Vec<[u16; 4]> = reader.read_joints(0).ok_or_else(|| invalid("a skinned primitive has no JOINTS_0"))?.into_u16().collect();
    let weights: Vec<[f32; 4]> = reader.read_weights(0).ok_or_else(|| invalid("a skinned primitive has no WEIGHTS_0"))?.into_f32().collect();
    if joints.len() != vertices.len() || weights.len() != vertices.len() {
        return Err(invalid("JOINTS_0 or WEIGHTS_0 and POSITION counts differ"));
    }
    if joints.iter().flatten().any(|&j| usize::from(j) >= joint_count) {
        return Err(invalid(format!("a joint index is past the skin's {joint_count} joints")));
    }
    let base = u32::try_from(group.mesh.vertices.len()).map_err(|_| invalid("too many vertices"))?;
    // Levels keep JOINTS_0/WEIGHTS_0: they are triangles over these vertices (glTF ignores a
    // skinned node's transform, so they are placed as the mesh is).
    group.lods.visit(read_lod_extras(gltf, primitive, blob, vertices.len() as u32), Mat4::IDENTITY, base);
    group.skin.extend(joints.iter().zip(&weights).map(|(j, w)| skin_row(*j, *w)));
    group.mesh.vertices.extend(vertices);
    group.mesh.indices.extend(indices.iter().map(|i| base + i));
    Ok(())
}

/// Weights normalized to sum 1; none at all binds the vertex to joint 0.
fn skin_row(joints: [u16; 4], weights: [f32; 4]) -> GpuSkinVertex {
    let sum: f32 = weights.iter().map(|w| w.max(0.0)).sum();
    if sum <= 0.0 {
        return GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] };
    }
    GpuSkinVertex { joints: joints.map(u32::from), weights: weights.map(|w| w.max(0.0) / sum) }
}

fn skeleton_nodes(gltf: &gltf::Gltf) -> Result<Vec<SkeletonNode>, RenderError> {
    let mut nodes: Vec<SkeletonNode> = gltf
        .nodes()
        .map(|node| {
            let (translation, rotation, scale) = node.transform().decomposed();
            SkeletonNode { parent: None, rest: Trs { translation, rotation, scale } }
        })
        .collect();
    for node in gltf.nodes() {
        for child in node.children() {
            let slot = &mut nodes[child.index()].parent;
            if slot.is_some() || child.index() == node.index() {
                return Err(invalid(format!("node {} has two parents", child.index())));
            }
            *slot = Some(node.index());
        }
    }
    Ok(nodes)
}

fn read_animation(animation: &gltf::Animation<'_>, blob: Option<&[u8]>) -> Result<Animation, RenderError> {
    let mut channels = Vec::new();
    for channel in animation.channels() {
        let reader = channel.reader(|_| blob);
        let times: Vec<f32> = reader.read_inputs().ok_or_else(|| invalid("an animation channel has no input"))?.collect();
        let cubic = channel.sampler().interpolation() == gltf::animation::Interpolation::CubicSpline;
        // A cubic-spline key is (in-tangent, value, out-tangent): keep the values.
        let keep = |i: usize| !cubic || i % 3 == 1;
        let values = match reader.read_outputs().ok_or_else(|| invalid("an animation channel has no output"))? {
            gltf::animation::util::ReadOutputs::Translations(keys) => {
                ChannelValues::Translation(keys.enumerate().filter(|(i, _)| keep(*i)).map(|(_, k)| k).collect())
            }
            gltf::animation::util::ReadOutputs::Scales(keys) => {
                ChannelValues::Scale(keys.enumerate().filter(|(i, _)| keep(*i)).map(|(_, k)| k).collect())
            }
            gltf::animation::util::ReadOutputs::Rotations(keys) => {
                ChannelValues::Rotation(keys.into_f32().enumerate().filter(|(i, _)| keep(*i)).map(|(_, k)| k).collect())
            }
            gltf::animation::util::ReadOutputs::MorphTargetWeights(_) => continue,
        };
        let count = match &values {
            ChannelValues::Translation(v) | ChannelValues::Scale(v) => v.len(),
            ChannelValues::Rotation(v) => v.len(),
        };
        if count != times.len() || times.windows(2).any(|w| w[1] < w[0]) {
            return Err(invalid("an animation channel's keys and times differ or go backwards"));
        }
        let interpolation = match channel.sampler().interpolation() {
            gltf::animation::Interpolation::Step => Interpolation::Step,
            _ => Interpolation::Linear,
        };
        channels.push(Channel { node: channel.target().node().index(), times, values, interpolation });
    }
    let duration = channels.iter().filter_map(|c| c.times.last().copied()).fold(0.0_f32, f32::max);
    Ok(Animation { name: animation.name().map(str::to_owned), duration, channels })
}

/// The blended skin matrix of one vertex, summed in joint-slot order as skin.wgsl sums it.
fn skin_matrix(row: &GpuSkinVertex, joints: &[[f32; 16]]) -> Mat4 {
    let mut m = Mat4::ZERO;
    for k in 0..4 {
        let joint = joints.get(row.joints[k] as usize).map_or(Mat4::IDENTITY, Mat4::from_cols_array);
        m += joint * row.weights[k];
    }
    m
}

/// The vertices of `mesh` skinned by `joints`: the CPU reference of the compute pass.
pub fn skin_vertices_cpu(mesh: &MeshData, skin: &[GpuSkinVertex], joints: &[[f32; 16]]) -> Vec<Vertex> {
    mesh.vertices
        .iter()
        .zip(skin)
        .map(|(v, row)| {
            let m = skin_matrix(row, joints);
            let position = m * Vec4::from((Vec3::from(v.position), 1.0));
            let normal = (m * Vec4::from((Vec3::from(v.normal), 0.0))).truncate().normalize_or(Vec3::Y);
            let tangent = (m * Vec4::new(v.tangent[0], v.tangent[1], v.tangent[2], 0.0)).truncate().normalize_or(Vec3::X);
            Vertex { position: position.truncate().to_array(), normal: normal.to_array(), uv: v.uv, tangent: tangent.extend(v.tangent[3]).to_array() }
        })
        .collect()
}

/// A model-space bounding sphere of a skinned draw: around every joint's image of the bind-pose
/// sphere, which holds every blend of them.
pub fn skinned_bounds(center: [f32; 3], radius: f32, joints: &[[f32; 16]]) -> ([f32; 3], f32) {
    let spheres: Vec<(Vec3, f32)> = joints
        .iter()
        .map(|j| {
            let m = Mat4::from_cols_array(j);
            let scale = m.x_axis.truncate().length().max(m.y_axis.truncate().length()).max(m.z_axis.truncate().length());
            (m.transform_point3(Vec3::from(center)), radius * scale)
        })
        .collect();
    let Some(first) = spheres.first() else { return (center, radius) };
    let (mut min, mut max) = (first.0 - Vec3::splat(first.1), first.0 + Vec3::splat(first.1));
    for (c, r) in &spheres {
        min = min.min(*c - Vec3::splat(*r));
        max = max.max(*c + Vec3::splat(*r));
    }
    let middle = (min + max) * 0.5;
    let reach = spheres.iter().map(|(c, r)| c.distance(middle) + r).fold(0.0_f32, f32::max);
    (middle.to_array(), reach)
}

/// The skinning pipeline and its bind group layout.
pub(crate) struct SkinPass {
    layout: BindGroupLayout,
    pipeline: Compiled<ComputePipeline>,
}

/// What one skinning dispatch reads and writes.
pub(crate) struct SkinBuffers<'a> {
    pub source: &'a Buffer,
    pub skin: &'a Buffer,
    pub joints: &'a Buffer,
    pub jobs: &'a Buffer,
    pub output: &'a Buffer,
    pub output_slots: &'a Buffer,
}

impl SkinPass {
    pub(crate) fn new(device: &Device) -> Result<SkinPass, RenderError> {
        use crate::tables::compute_storage;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("skin"),
            entries: &[
                compute_storage(0, true),
                compute_storage(1, true),
                compute_storage(2, true),
                compute_storage(3, true),
                compute_storage(4, false),
                compute_storage(5, false),
            ],
        });
        let module = crate::shaders::module(device, "skin", crate::shaders::SKIN)?;
        let pipeline_layout = crate::tables::pipeline_layout(device, "skin", &[&layout]);
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("skin"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("skin"),
            compilation_options: Default::default(),
            cache: None,
        });
        Ok(SkinPass { layout, pipeline })
    }

    /// One row of workgroups per job, wide enough for the largest job.
    pub(crate) fn encode(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, buffers: &SkinBuffers<'_>, jobs: u32, most_vertices: u32) {
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("skin"),
            layout: &self.layout,
            entries: &[
                crate::tables::entry(0, buffers.source),
                crate::tables::entry(1, buffers.skin),
                crate::tables::entry(2, buffers.joints),
                crate::tables::entry(3, buffers.jobs),
                crate::tables::entry(4, buffers.output),
                crate::tables::entry(5, buffers.output_slots),
            ],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("skin"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(most_vertices.div_ceil(SKIN_WORKGROUP), jobs, 1);
    }
}

/// The skinned output, double-buffered for motion vectors (RQ5.1): each frame writes one buffer
/// while the other keeps last frame's skinned vertices. A buffer grows only while it is the one
/// being written, so the previous frame's output is never lost to a resize.
pub(crate) struct SkinnedPair {
    buffers: [Option<Buffer>; 2],
    current: usize,
    /// Whether the other buffer holds a frame's output (false until a second frame).
    previous_written: bool,
    written: bool,
}

impl SkinnedPair {
    /// No buffers yet.
    pub(crate) const fn new() -> SkinnedPair {
        SkinnedPair { buffers: [None, None], current: 1, previous_written: false, written: false }
    }

    /// Start a frame writing `bytes` of skinned vertices: the buffers swap, so last frame's output
    /// becomes the previous one, and the one written now grows when it is too small.
    pub(crate) fn begin(&mut self, device: &Device, bytes: u64, usage: wgpu::BufferUsages) -> Result<(), RenderError> {
        self.current = 1 - self.current;
        self.previous_written = self.written;
        self.written = true;
        let need = crate::tables::aligned(bytes);
        if self.buffers[self.current].as_ref().is_none_or(|buffer| buffer.size() < need) {
            let held = self.buffers[self.current].as_ref().map_or(0, Buffer::size);
            self.buffers[self.current] = Some(crate::tables::buffer(device, "skinned vertices", crate::tables::skinned_growth(held, need), usage)?);
        }
        Ok(())
    }

    /// The buffer this frame writes (present once [`SkinnedPair::begin`] ran).
    pub(crate) fn current(&self) -> Option<&Buffer> {
        self.buffers[self.current].as_ref()
    }

    /// Last frame's output, when there was a last frame.
    pub(crate) fn previous(&self) -> Option<&Buffer> {
        self.buffers[1 - self.current].as_ref().filter(|_| self.previous_written)
    }

    /// Forget last frame's output (a history reset: the next frame has no previous vertices).
    pub(crate) fn forget(&mut self) {
        self.written = false;
        self.previous_written = false;
    }
}

/// What the skinned output table holds (game systems AN-16b): the jobs of the last frame that
/// skinned into it, with the joint table they read and the table buffers' generations then. A job
/// of this frame that equals a held one at the same output (same vertices, skin rows and slot)
/// with a bit-identical palette is skipped: the table already holds its output, so a still
/// character runs no skinning, and its rows read last frame's vertices equal to this frame's (no
/// motion). A frame's jobs become the held ones only once its skinning is recorded
/// ([`SkinnedHeld::commit`]): a frame refused before then leaves the table and this record as
/// they were.
#[derive(Default)]
pub(crate) struct SkinnedHeld {
    held: Option<HeldSkinning>,
    pending: Option<HeldSkinning>,
}

/// One frame's skinning as the table holds it.
#[derive(Clone, Default)]
struct HeldSkinning {
    /// Its jobs by output base.
    jobs: std::collections::BTreeMap<u32, GpuSkinJob>,
    joints: Vec<[f32; 16]>,
    /// Each job's palette length, by joint base.
    palettes: std::collections::BTreeMap<u32, u32>,
    generations: [u64; 2],
}

impl HeldSkinning {
    fn of(jobs: &[GpuSkinJob], joints: &[[f32; 16]], generations: [u64; 2]) -> HeldSkinning {
        let mut bases: Vec<u32> = jobs.iter().map(|job| job.joint_base).collect();
        bases.sort_unstable();
        bases.dedup();
        let ends = bases.iter().skip(1).copied().chain(std::iter::once(joints.len() as u32));
        let palettes = bases.iter().zip(ends).map(|(base, end)| (*base, end - base)).collect();
        HeldSkinning { jobs: jobs.iter().map(|job| (job.dst_base, *job)).collect(), joints: joints.to_vec(), palettes, generations }
    }

    /// The palette `job` reads.
    fn palette(&self, job: &GpuSkinJob) -> &[[f32; 16]] {
        let len = self.palettes.get(&job.joint_base).copied().unwrap_or(0) as usize;
        let start = job.joint_base as usize;
        self.joints.get(start..start + len).unwrap_or(&[])
    }

    /// Whether the table holds `job`'s output as `now` (this frame's skinning) would write it.
    fn holds(&self, job: &GpuSkinJob, now: &HeldSkinning) -> bool {
        let Some(held) = self.jobs.get(&job.dst_base) else { return false };
        let same_job = (held.src_base, held.count, held.skin_base, held.slot) == (job.src_base, job.count, job.skin_base, job.slot);
        let (was, is) = (self.palette(held), now.palette(job));
        same_job && !is.is_empty() && bytemuck::cast_slice::<[f32; 16], u32>(was) == bytemuck::cast_slice::<[f32; 16], u32>(is)
    }
}

impl SkinnedHeld {
    /// The jobs of a frame (`jobs` over `joints`, into tables of `generations`: the skinned output's
    /// and its slots') that must run: those whose output the tables do not hold. The frame's jobs
    /// wait to be committed.
    pub(crate) fn jobs_to_run(&mut self, jobs: &[GpuSkinJob], joints: &[[f32; 16]], generations: [u64; 2]) -> Vec<GpuSkinJob> {
        let now = HeldSkinning::of(jobs, joints, generations);
        let run = match self.held.as_ref().filter(|held| held.generations == generations) {
            Some(held) => jobs.iter().filter(|job| !held.holds(job, &now)).copied().collect(),
            None => jobs.to_vec(),
        };
        self.pending = Some(now);
        run
    }

    /// The pending frame's skinning was recorded: the tables hold its jobs' output.
    pub(crate) fn commit(&mut self) {
        if let Some(pending) = self.pending.take() {
            self.held = Some(pending);
        }
    }

    /// Forget what the tables hold (the meshes they skin from changed): every job runs next frame.
    pub(crate) fn forget(&mut self) {
        self.held = None;
        self.pending = None;
    }
}
