//! A GLB whose nodes move rigidly (doors, platforms, props: game systems AN-27) as a skinned
//! model whose joints are the file's nodes: every vertex is bound to the node that places it, at
//! weight 1, so the skinned draw poses each node by its own animated transform. Nothing new in
//! the renderer: the compute (or vertex) skinning path, its parts, materials and bounds are the
//! characters' (AN-16a), one logical draw per model.
//!
//! The mesh is the file's rest pose in model space (each primitive placed by its node's global
//! transform, as the static loader places it), and each joint's inverse bind is its node's rest
//! global inverse, so the rest pose skins to itself. Parts follow the static loader's order: one
//! per material in first-use order over the default scene's nodes, depth first.

use glam::{Mat3, Mat4, Vec3};

use crate::error::RenderError;
use crate::layout::GpuSkinVertex;
use crate::mesh::{MeshData, Vertex, invalid, open_glb, read_primitive};
use crate::skin::{MAX_JOINTS, Skeleton, SkinPart, SkinnedMeshData, SkinnedModel, read_animation, skeleton_nodes};

/// One material's primitives while a rigid model is read.
struct Group {
    material: Option<usize>,
    mesh: MeshData,
    skin: Vec<GpuSkinVertex>,
}

impl SkinnedModel {
    /// The rigid-node skinned model of a GLB (module docs): joints are its nodes, every vertex at
    /// weight 1 on the node that places it, with its node tree and animations. Refused
    /// `mesh-invalid`: no node, more than [`MAX_JOINTS`] nodes, a node with two parents, no
    /// triangles, or anything [`MeshData::from_glb`] refuses.
    pub fn rigid_from_glb(bytes: &[u8]) -> Result<SkinnedModel, RenderError> {
        let gltf = open_glb(bytes)?;
        let blob = gltf.blob.as_deref();
        let nodes = skeleton_nodes(&gltf)?;
        if nodes.is_empty() || nodes.len() > MAX_JOINTS {
            return Err(invalid(format!("{} nodes, between 1 and {MAX_JOINTS}", nodes.len())));
        }
        let rest = Skeleton { joints: (0..nodes.len()).collect(), inverse_bind: vec![Mat4::IDENTITY.to_cols_array(); nodes.len()], mesh_node: None, nodes };
        // With identity inverse binds the joint matrices of the rest pose are the nodes' globals.
        let globals: Vec<Mat4> = rest.joint_matrices(&rest.rest_pose()).iter().map(Mat4::from_cols_array).collect();
        let mut groups: Vec<Group> = Vec::new();
        let scene = gltf.default_scene().or_else(|| gltf.scenes().next());
        let roots: Vec<gltf::Node<'_>> = scene.map(|scene| scene.nodes().collect()).unwrap_or_default();
        let mut stack: Vec<gltf::Node<'_>> = roots.into_iter().rev().collect();
        while let Some(node) = stack.pop() {
            if let Some(mesh) = node.mesh() {
                for primitive in mesh.primitives() {
                    read_rigid_primitive(&primitive, blob, node.index(), globals[node.index()], &mut groups)?;
                }
            }
            stack.extend(node.children().collect::<Vec<_>>().into_iter().rev());
        }
        let (mesh, skin, parts) = merge(groups)?;
        let inverse_bind = globals.iter().map(|global| global.inverse().to_cols_array()).collect();
        let skeleton = Skeleton { inverse_bind, ..rest };
        let animations = gltf.animations().map(|animation| read_animation(&animation, blob)).collect::<Result<_, _>>()?;
        // A node-posed model draws whole: skinned levels (AN-25) are read from skinned primitives only.
        Ok(SkinnedModel { data: SkinnedMeshData { mesh, skin, skeleton, animations }, parts, levels: Vec::new() })
    }
}

/// Append `primitive` of node `node`, placed by `global`, to its material's group.
fn read_rigid_primitive(primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>, node: usize, global: Mat4, groups: &mut Vec<Group>) -> Result<(), RenderError> {
    let (vertices, indices) = read_primitive(primitive, blob)?;
    let key = primitive.material().index();
    let at = match groups.iter().position(|group| group.material == key) {
        Some(at) => at,
        None => {
            groups.push(Group { material: key, mesh: MeshData::default(), skin: Vec::new() });
            groups.len() - 1
        }
    };
    let group = &mut groups[at];
    let base = u32::try_from(group.mesh.vertices.len()).map_err(|_| invalid("too many vertices"))?;
    let normals = Mat3::from_mat4(global).inverse().transpose();
    let axes = Mat3::from_mat4(global);
    let placed = vertices.iter().map(|vertex| Vertex {
        position: global.transform_point3(Vec3::from(vertex.position)).to_array(),
        normal: (normals * Vec3::from(vertex.normal)).normalize_or_zero().to_array(),
        uv: vertex.uv,
        tangent: (axes * Vec3::new(vertex.tangent[0], vertex.tangent[1], vertex.tangent[2])).normalize_or_zero().extend(vertex.tangent[3]).to_array(),
    });
    group.mesh.vertices.extend(placed);
    group.mesh.indices.extend(indices.iter().map(|index| base + index));
    let joint = u32::try_from(node).map_err(|_| invalid("too many nodes"))?;
    group.skin.extend(std::iter::repeat_n(GpuSkinVertex { joints: [joint, 0, 0, 0], weights: [1.0, 0.0, 0.0, 0.0] }, vertices.len()));
    Ok(())
}

/// The groups laid out one after another: the merged mesh, its skin rows and a part per group
/// with triangles.
fn merge(groups: Vec<Group>) -> Result<(MeshData, Vec<GpuSkinVertex>, Vec<SkinPart>), RenderError> {
    let mut mesh = MeshData::default();
    let mut skin = Vec::new();
    let mut parts = Vec::new();
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
        mesh.indices.extend(group.mesh.indices.iter().map(|index| first_vertex + index));
        mesh.vertices.extend(group.mesh.vertices);
        skin.extend(group.skin);
    }
    if mesh.indices.is_empty() {
        return Err(invalid("the model has no triangles"));
    }
    Ok((mesh, skin, parts))
}
