//! GLB import of a rig: the skeleton of the first skinned mesh node, from bytes the sim-side
//! asset read hands over (SF-1a), checked by genex-core's GLB guard before `gltf` parses.
//!
//! `gltf` 1.4.1 can panic on damaged input (gltf-rs #478), and wasm aborts on a panic, so nothing
//! reaches its readers unchecked: the container lengths are checked before it parses, every
//! buffer must be embedded and fit the BIN chunk, and every accessor this module reads must have
//! the layout glTF gives it and lie inside its view ([`check_accessor`]). The node tree is checked
//! (one parent each, no cycle, every joint in the scene, at most [`MAX_JOINTS`]) before anything
//! of the skeleton is allocated.

use glam::Mat4;
use gltf::accessor::{DataType, Dimensions};

use crate::error::AnimationError;
use crate::ids::JointId;
use crate::math::Trs;
use crate::skeleton::{JointParts, MAX_JOINTS, Skeleton};

/// GLB header: magic, version, total length.
const GLB_HEADER_BYTES: usize = 12;
/// A chunk header: length, type.
const CHUNK_HEADER_BYTES: usize = 8;
/// The only GLB version glTF 2.0 writes.
const GLB_VERSION: u32 = 2;
/// A node with no parent in the parent table.
const NO_NODE: u32 = u32::MAX;

/// A rig read from a GLB: its skeleton and how the file's nodes map onto the skeleton's joints
/// (clips and later imports name nodes).
#[derive(Clone, Debug, PartialEq)]
pub struct Rig {
    skeleton: Skeleton,
    node_joints: Vec<Option<JointId>>,
    joint_nodes: Vec<usize>,
}

impl Rig {
    /// The skeleton.
    pub fn skeleton(&self) -> &Skeleton {
        &self.skeleton
    }

    /// The joint a file node became, if it is one.
    pub fn joint_of_node(&self, node: usize) -> Option<JointId> {
        self.node_joints.get(node).copied().flatten()
    }

    /// The file node a joint came from.
    pub fn node_of_joint(&self, joint: JointId) -> usize {
        self.joint_nodes.get(usize::from(joint.raw())).copied().unwrap_or(usize::MAX)
    }

    /// This rig read through another file's nodes, given their names in file order: a node named
    /// like one of its joints ([`Skeleton::find`]) is that joint, the first such node of a joint
    /// winning; every other node is none.
    pub(crate) fn by_names(&self, names: &[Option<&str>]) -> Rig {
        let mut node_joints = vec![None; names.len()];
        let mut joint_nodes = vec![usize::MAX; self.skeleton.joint_count()];
        for (node, name) in names.iter().enumerate() {
            let Some(joint) = name.and_then(|name| self.skeleton.find(name)) else { continue };
            let slot = &mut joint_nodes[usize::from(joint.raw())];
            if *slot == usize::MAX {
                *slot = node;
                node_joints[node] = Some(joint);
            }
        }
        Rig { skeleton: self.skeleton.clone(), node_joints, joint_nodes }
    }
}

/// The rig of a GLB's first skinned mesh node. Refused `animation-asset-invalid`: not a GLB or a
/// damaged container, a buffer that is not embedded or overruns the BIN chunk, no skinned mesh
/// node, no joints or more than [`MAX_JOINTS`], a node with two parents, a cycle, a joint or the
/// mesh node outside the scene, a joint listed twice, inverse bind matrices that are not one
/// float MAT4 per joint inside their view, or a non-finite transform.
pub fn import_rig(bytes: &[u8]) -> Result<Rig, AnimationError> {
    let gltf = open(bytes)?;
    read_rig(&gltf)
}

/// A GLB parsed by `gltf` after its container lengths are checked, with every buffer embedded
/// and inside the BIN chunk.
pub(crate) fn open(bytes: &[u8]) -> Result<gltf::Gltf, AnimationError> {
    genex_core::glb_guard::check_glb(bytes).map_err(|refusal| AnimationError::asset_invalid(format!("not a valid GLB: {refusal}")))?;
    check_container(bytes)?;
    let gltf = gltf::Gltf::from_slice_without_validation(bytes).map_err(|error| AnimationError::asset_invalid(format!("not a valid GLB: {error}")))?;
    validate(gltf.document.as_json())?;
    let blob = gltf.blob.as_ref().map_or(0, Vec::len);
    for buffer in gltf.buffers() {
        if let gltf::buffer::Source::Uri(uri) = buffer.source() {
            return Err(AnimationError::asset_invalid(format!("buffer {uri:?} is not embedded")));
        }
        if buffer.length() > blob {
            return Err(AnimationError::asset_invalid(format!("buffer {} declares {} bytes, the BIN chunk holds {blob}", buffer.index(), buffer.length())));
        }
    }
    Ok(gltf)
}

/// `gltf`'s own validation, after the one check its validation hooks assume: a primitive's
/// attribute accessors exist (the POSITION hook indexes the accessor list unchecked and panics,
/// gltf-rs #478).
fn validate(root: &gltf::json::Root) -> Result<(), AnimationError> {
    use gltf::json::validation::Validate;
    let accessors = root.accessors.len();
    let attributes = root.meshes.iter().flat_map(|mesh| &mesh.primitives).flat_map(|primitive| primitive.attributes.values());
    if let Some(index) = attributes.map(|accessor| accessor.value()).find(|&index| index >= accessors) {
        return Err(AnimationError::asset_invalid(format!("a primitive names accessor {index} of {accessors}")));
    }
    let mut first: Option<String> = None;
    root.validate(root, gltf::json::Path::new, &mut |path, error| {
        first.get_or_insert_with(|| format!("{}: {error}", path()));
    });
    match first {
        Some(error) => Err(AnimationError::asset_invalid(format!("not a valid glTF: {error}"))),
        None => Ok(()),
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    let word: [u8; 4] = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(word))
}

/// The GLB container: magic, version 2, a total length equal to the bytes, a JSON chunk first
/// and at most a BIN chunk after it, each inside the bytes.
fn check_container(bytes: &[u8]) -> Result<(), AnimationError> {
    let refuse = |what: &str| Err(AnimationError::asset_invalid(format!("not a GLB container: {what}")));
    if bytes.len() < GLB_HEADER_BYTES + CHUNK_HEADER_BYTES || !bytes.starts_with(b"glTF") {
        return refuse("no glTF header");
    }
    if u32_at(bytes, 4) != Some(GLB_VERSION) {
        return refuse("not version 2");
    }
    if u32_at(bytes, 8).map(|n| n as usize) != Some(bytes.len()) {
        return refuse("the header length is not the file length");
    }
    let json = u32_at(bytes, GLB_HEADER_BYTES).map_or(usize::MAX, |n| n as usize);
    if bytes.get(16..20) != Some(b"JSON".as_slice()) {
        return refuse("the first chunk is not JSON");
    }
    let rest = (bytes.len() - GLB_HEADER_BYTES - CHUNK_HEADER_BYTES).checked_sub(json);
    let Some(rest) = rest else { return refuse("the JSON chunk runs past the file") };
    if rest == 0 {
        return Ok(());
    }
    let at = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES + json;
    let bin = u32_at(bytes, at).map_or(usize::MAX, |n| n as usize);
    let bin_header = rest >= CHUNK_HEADER_BYTES && bytes.get(at + 4..at + 8) == Some(b"BIN\0".as_slice());
    if !bin_header || bin > rest - CHUNK_HEADER_BYTES {
        return refuse("the chunk after JSON is not a BIN chunk inside the file");
    }
    Ok(())
}

/// An accessor's layout and bounds, checked before `gltf`'s reader touches it: not sparse, the
/// given component type and element type, not normalized, a count in `counts`, a view inside the
/// BIN chunk, and every element inside the view.
pub(crate) fn check_accessor(
    accessor: &gltf::Accessor<'_>,
    blob: usize,
    layout: (DataType, Dimensions),
    counts: std::ops::RangeInclusive<usize>,
) -> Result<(), AnimationError> {
    let index = accessor.index();
    let refuse = |what: String| Err(AnimationError::asset_invalid(format!("accessor {index}: {what}")));
    if accessor.sparse().is_some() {
        return refuse("sparse accessors are not read".to_owned());
    }
    if (accessor.data_type(), accessor.dimensions()) != layout || accessor.normalized() {
        return refuse(format!("{:?} {:?}, expected {:?} {:?}", accessor.data_type(), accessor.dimensions(), layout.0, layout.1));
    }
    let count = accessor.count();
    if !counts.contains(&count) {
        return refuse(format!("{count} elements, expected {} to {}", counts.start(), counts.end()));
    }
    let Some(view) = accessor.view() else { return refuse("no buffer view".to_owned()) };
    let view_end = view.offset().checked_add(view.length());
    if view_end.is_none_or(|end| end > blob) {
        return refuse(format!("its view ends past the {blob}-byte BIN chunk"));
    }
    let element = layout.0.size() * layout.1.multiplicity();
    let stride = view.stride().unwrap_or(element);
    let end = (count.max(1) - 1).checked_mul(stride).and_then(|n| n.checked_add(element)).and_then(|n| n.checked_add(accessor.offset()));
    if stride < element || end.is_none_or(|end| end > view.length()) {
        return refuse(format!("{count} elements of {element} bytes every {stride} overrun its {}-byte view", view.length()));
    }
    Ok(())
}

/// Each node's parent, refused when a node is listed as a child twice or of itself.
fn parent_table(gltf: &gltf::Gltf) -> Result<Vec<u32>, AnimationError> {
    let mut parents = vec![NO_NODE; gltf.nodes().len()];
    for node in gltf.nodes() {
        for child in node.children() {
            let slot = &mut parents[child.index()];
            if *slot != NO_NODE || child.index() == node.index() {
                return Err(AnimationError::asset_invalid(format!("node {} has two parents", child.index())));
            }
            *slot = node.index() as u32;
        }
    }
    Ok(parents)
}

/// Refuses a cycle in the parent table: each walk up stops at a root or a node already proven.
fn check_acyclic(parents: &[u32]) -> Result<(), AnimationError> {
    const UNSEEN: u8 = 0;
    const WALKING: u8 = 1;
    const DONE: u8 = 2;
    let mut state = vec![UNSEEN; parents.len()];
    let mut path = Vec::new();
    for start in 0..parents.len() {
        let mut at = start;
        while state[at] == UNSEEN {
            state[at] = WALKING;
            path.push(at);
            match parents[at] {
                NO_NODE => break,
                parent => at = parent as usize,
            }
        }
        if state[at] == WALKING && parents[at] != NO_NODE {
            return Err(AnimationError::asset_invalid(format!("node {at} is its own ancestor")));
        }
        for node in path.drain(..) {
            state[node] = DONE;
        }
    }
    Ok(())
}

/// The topmost ancestor of `node` (the parent table is acyclic).
fn top(parents: &[u32], node: usize) -> usize {
    let mut at = node;
    while parents[at] != NO_NODE {
        at = parents[at] as usize;
    }
    at
}

/// A node's local rest transform, refused when non-finite.
fn rest(gltf: &gltf::Gltf, node: usize) -> Result<Trs, AnimationError> {
    let trs = gltf.nodes().nth(node).map_or(Trs::IDENTITY, |n| {
        let (translation, rotation, scale) = n.transform().decomposed();
        Trs::from_arrays(translation, rotation, scale)
    });
    if !trs.is_finite() {
        return Err(AnimationError::asset_invalid(format!("node {node} has a non-finite transform")));
    }
    Ok(trs)
}

/// A node's global rest transform, composed from the top down as genex-render composes it.
fn global_rest(gltf: &gltf::Gltf, parents: &[u32], node: usize) -> Result<Mat4, AnimationError> {
    let mut chain = vec![node];
    let mut at = node;
    while parents[at] != NO_NODE {
        at = parents[at] as usize;
        chain.push(at);
    }
    let mut global = Mat4::IDENTITY;
    for &node in chain.iter().rev() {
        global *= rest(gltf, node)?.matrix();
    }
    Ok(global)
}

/// The skin's joints as node indices, and the members of the skeleton (joints and the non-joint
/// nodes between two joints), refused when a joint is listed twice or the skeleton is too big.
fn skeleton_members(parents: &[u32], skin_nodes: &[usize]) -> Result<Vec<bool>, AnimationError> {
    let mut member = vec![false; parents.len()];
    for &node in skin_nodes {
        if member[node] {
            return Err(AnimationError::asset_invalid(format!("node {node} is listed twice in the skin")));
        }
        member[node] = true;
    }
    let mut between = Vec::new();
    for &joint in skin_nodes {
        between.clear();
        let mut at = parents[joint];
        while at != NO_NODE && !member[at as usize] {
            between.push(at as usize);
            at = parents[at as usize];
        }
        if at != NO_NODE {
            between.iter().for_each(|&node| member[node] = true);
        }
    }
    let count = member.iter().filter(|&&m| m).count();
    if count > MAX_JOINTS {
        return Err(AnimationError::asset_invalid(format!("{count} joints with the nodes between them, at most {MAX_JOINTS}")));
    }
    Ok(member)
}

/// Members in parent-first order: the skin's order, each joint's unplaced member ancestors first.
fn parent_first(parents: &[u32], member: &[bool], skin_nodes: &[usize]) -> Vec<usize> {
    let mut placed = vec![false; parents.len()];
    let mut order = Vec::new();
    let mut pending = Vec::new();
    for &joint in skin_nodes {
        let mut at = joint as u32;
        while at != NO_NODE && !placed[at as usize] {
            if member[at as usize] {
                pending.push(at as usize);
            }
            at = parents[at as usize];
        }
        while let Some(node) = pending.pop() {
            placed[node] = true;
            order.push(node);
        }
    }
    order
}

/// The member parent of `node`, skipping nothing (members are closed under "between").
fn member_parent(parents: &[u32], member: &[bool], node: usize) -> Option<usize> {
    let mut at = parents[node];
    while at != NO_NODE {
        if member[at as usize] {
            return Some(at as usize);
        }
        at = parents[at as usize];
    }
    None
}

/// The node tree's checks: one parent each, no cycle, every joint and the mesh node in the scene.
fn check_tree(gltf: &gltf::Gltf, parents: &[u32], skin_nodes: &[usize], mesh_node: usize) -> Result<(), AnimationError> {
    check_acyclic(parents)?;
    let Some(scene) = gltf.default_scene().or_else(|| gltf.scenes().next()) else { return Ok(()) };
    let in_scene = |node: usize| scene.nodes().any(|root| root.index() == top(parents, node));
    if let Some(&stray) = skin_nodes.iter().chain([&mesh_node]).find(|&&node| !in_scene(node)) {
        return Err(AnimationError::asset_invalid(format!("node {stray} is outside the scene")));
    }
    Ok(())
}

/// The skin's inverse bind matrices, one finite float MAT4 per joint (identity when absent).
fn inverse_binds(gltf: &gltf::Gltf, skin: &gltf::Skin<'_>, joints: usize) -> Result<Vec<Mat4>, AnimationError> {
    let blob = gltf.blob.as_deref();
    let Some(accessor) = skin.inverse_bind_matrices() else { return Ok(vec![Mat4::IDENTITY; joints]) };
    check_accessor(&accessor, blob.map_or(0, <[u8]>::len), (DataType::F32, Dimensions::Mat4), joints..=joints)?;
    let reader = skin.reader(|_| blob);
    let matrices: Vec<Mat4> = reader.read_inverse_bind_matrices().into_iter().flatten().map(|m| Mat4::from_cols_array_2d(&m)).collect();
    if matrices.len() != joints {
        return Err(AnimationError::asset_invalid(format!("{} inverse bind matrices for {joints} joints", matrices.len())));
    }
    if let Some(slot) = matrices.iter().position(|m| !m.is_finite()) {
        return Err(AnimationError::asset_invalid(format!("inverse bind matrix {slot} is not finite")));
    }
    Ok(matrices)
}

fn read_rig(gltf: &gltf::Gltf) -> Result<Rig, AnimationError> {
    let found = gltf.nodes().find_map(|n| Some((n.index(), n.mesh()?, n.skin()?)));
    let Some((mesh_node, _, skin)) = found else { return Err(AnimationError::asset_invalid("no skinned mesh node")) };
    let joint_count = skin.joints().len();
    if joint_count == 0 || joint_count > MAX_JOINTS {
        return Err(AnimationError::asset_invalid(format!("{joint_count} joints, between 1 and {MAX_JOINTS}")));
    }
    let parents = parent_table(gltf)?;
    let skin_nodes: Vec<usize> = skin.joints().map(|j| j.index()).collect();
    check_tree(gltf, &parents, &skin_nodes, mesh_node)?;
    let member = skeleton_members(&parents, &skin_nodes)?;
    let inverse_bind = inverse_binds(gltf, &skin, joint_count)?;
    let mesh_frame = global_rest(gltf, &parents, mesh_node)?;
    let unmesh = mesh_frame.inverse();
    if !unmesh.is_finite() {
        return Err(AnimationError::asset_invalid(format!("the skinned mesh node {mesh_node} cannot be inverted")));
    }
    let order = parent_first(&parents, &member, &skin_nodes);
    let mut node_joints = vec![None; parents.len()];
    for (index, &node) in order.iter().enumerate() {
        node_joints[node] = Some(JointId(index as u16));
    }
    let mut joints = Vec::with_capacity(order.len());
    for &node in &order {
        let parent = member_parent(&parents, &member, node);
        let root_frame = match (parent, parents[node]) {
            (None, NO_NODE) => Mat4::IDENTITY,
            (None, above) => global_rest(gltf, &parents, above as usize)?,
            (Some(_), _) => Mat4::IDENTITY,
        };
        let name = gltf.nodes().nth(node).and_then(|n| n.name().map(str::to_owned)).unwrap_or_default();
        let parent = parent.and_then(|p| node_joints[p]).map(JointId::raw);
        joints.push(JointParts { name, parent, rest: rest(gltf, node)?, root_frame });
    }
    let skin_slots = skin_nodes.iter().zip(inverse_bind).map(|(&node, ibm)| (node_joints[node].unwrap_or(JointId(0)), ibm)).collect();
    Ok(Rig { skeleton: Skeleton::from_parts(joints, (mesh_frame, unmesh), skin_slots), node_joints, joint_nodes: order })
}
