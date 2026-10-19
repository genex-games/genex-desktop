//! Synthetic fixture rigs for genex-anim's tests, written as GLB bytes with std and glam only.
//! genex-render's oracle dump (`crates/genex-render/tests/skin_oracle_dump.rs`) includes this
//! same file by path, so the palettes it records in `tests/fixtures/oracle/*.json` come from
//! exactly the bytes genex-anim imports here (genex-anim keeps no dev-dependency on the renderer).
//!
//! Every rig is built from a node list: names, parents, rest transforms, the skin's joint list in
//! file order and the skinned mesh node. Inverse bind matrices come from the rest pose
//! (`inverse(global(joint)) × global(mesh node)`), so the rest palette is close to identity.

#![allow(dead_code)]

use glam::{Mat4, Quat, Vec3};

/// One node of a fixture rig.
#[derive(Clone, Debug)]
pub struct NodeSpec {
    /// Its glTF name.
    pub name: String,
    /// Its parent node.
    pub parent: Option<usize>,
    /// Rest translation.
    pub translation: [f32; 3],
    /// Rest rotation, xyzw.
    pub rotation: [f32; 4],
    /// Rest scale.
    pub scale: [f32; 3],
    /// Written as a `matrix` instead of TRS when set.
    pub as_matrix: bool,
}

/// What a channel animates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelPath {
    /// Translation keys (3 floats).
    Translation,
    /// Rotation keys (4 floats, xyzw).
    Rotation,
    /// Scale keys (3 floats).
    Scale,
}

impl ChannelPath {
    fn width(self) -> usize {
        match self {
            ChannelPath::Rotation => 4,
            ChannelPath::Translation | ChannelPath::Scale => 3,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            ChannelPath::Translation => "translation",
            ChannelPath::Rotation => "rotation",
            ChannelPath::Scale => "scale",
        }
    }
}

/// How a channel interpolates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelInterpolation {
    /// STEP.
    Step,
    /// LINEAR.
    Linear,
    /// CUBICSPLINE: three values per key (in-tangent, value, out-tangent).
    CubicSpline,
}

impl ChannelInterpolation {
    /// The glTF spelling.
    pub fn wire(self) -> &'static str {
        match self {
            ChannelInterpolation::Step => "STEP",
            ChannelInterpolation::Linear => "LINEAR",
            ChannelInterpolation::CubicSpline => "CUBICSPLINE",
        }
    }
}

/// One animated property of one node.
#[derive(Clone, Debug)]
pub struct ChannelSpec {
    /// The node it moves.
    pub node: usize,
    /// What it moves.
    pub path: ChannelPath,
    /// How it interpolates.
    pub interpolation: ChannelInterpolation,
    /// Key times, ascending.
    pub times: Vec<f32>,
    /// Key values, flattened (cubic splines carry three per key).
    pub values: Vec<f32>,
}

/// One clip.
#[derive(Clone, Debug)]
pub struct ClipSpec {
    /// Its glTF name.
    pub name: String,
    /// Its channels.
    pub channels: Vec<ChannelSpec>,
}

/// A fixture rig, before it is written as a GLB.
#[derive(Clone, Debug)]
pub struct RigSpec {
    /// Its fixture name (the oracle file stem).
    pub name: &'static str,
    /// Every node, in file order.
    pub nodes: Vec<NodeSpec>,
    /// The scene's root nodes.
    pub scene_roots: Vec<usize>,
    /// The node holding the skinned mesh.
    pub mesh_node: usize,
    /// The skin's joints, as node indices, in file (skin) order.
    pub joints: Vec<usize>,
    /// Primitives of the skinned mesh, each with its own material.
    pub parts: usize,
    /// Clips.
    pub clips: Vec<ClipSpec>,
    /// Extra `children` entries written after the real ones (hostile rigs: two parents, cycles).
    pub extra_children: Vec<(usize, usize)>,
    /// Replaces the computed inverse bind matrices when set.
    pub inverse_bind_override: Option<Vec<[f32; 16]>>,
}

/// The rest pose's identity rotation.
pub const IDENTITY_ROTATION: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

impl RigSpec {
    /// An empty rig whose skinned mesh node is added first.
    pub fn new(name: &'static str) -> RigSpec {
        RigSpec {
            name,
            nodes: Vec::new(),
            scene_roots: Vec::new(),
            mesh_node: 0,
            joints: Vec::new(),
            parts: 1,
            clips: Vec::new(),
            extra_children: Vec::new(),
            inverse_bind_override: None,
        }
    }

    /// Add a node; a node with no parent is a scene root.
    pub fn node(&mut self, name: &str, parent: Option<usize>, translation: [f32; 3], rotation: Quat, scale: [f32; 3]) -> usize {
        let index = self.nodes.len();
        self.nodes.push(NodeSpec { name: name.to_owned(), parent, translation, rotation: rotation.to_array(), scale, as_matrix: false });
        if parent.is_none() {
            self.scene_roots.push(index);
        }
        index
    }

    /// Add a node and make it the next joint of the skin.
    pub fn joint(&mut self, name: &str, parent: Option<usize>, translation: [f32; 3], rotation: Quat) -> usize {
        let index = self.node(name, parent, translation, rotation, [1.0; 3]);
        self.joints.push(index);
        index
    }

    /// Each node's global rest transform, as genex-render composes it (parent × local).
    pub fn rest_globals(&self) -> Vec<Mat4> {
        let mut out = vec![Mat4::IDENTITY; self.nodes.len()];
        for (index, slot) in out.iter_mut().enumerate() {
            let mut chain = vec![index];
            while let Some(parent) = self.nodes[*chain.last().unwrap()].parent {
                if chain.len() > self.nodes.len() {
                    break;
                }
                chain.push(parent);
            }
            let mut global = Mat4::IDENTITY;
            for &node in chain.iter().rev() {
                global *= local_matrix(&self.nodes[node]);
            }
            *slot = global;
        }
        out
    }

    /// The inverse bind matrices the GLB carries.
    pub fn inverse_bind(&self) -> Vec<[f32; 16]> {
        if let Some(matrices) = &self.inverse_bind_override {
            return matrices.clone();
        }
        let globals = self.rest_globals();
        let mesh = globals[self.mesh_node];
        self.joints.iter().map(|&joint| (globals[joint].inverse() * mesh).to_cols_array()).collect()
    }

    /// Nodes a joint-only skeleton animates: the joints and any non-joint node between two
    /// joints, ascending by node index.
    pub fn posable(&self) -> Vec<usize> {
        let mut out: Vec<usize> = self.joints.clone();
        for &joint in &self.joints {
            let mut between = Vec::new();
            let mut at = self.nodes[joint].parent;
            while let Some(node) = at {
                if self.joints.contains(&node) {
                    out.extend(between.iter().copied());
                    break;
                }
                between.push(node);
                at = self.nodes[node].parent;
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The JSON chunk and BIN chunk of this rig's GLB.
    pub fn json_and_bin(&self) -> (String, Vec<u8>) {
        let mut writer = Writer::default();
        let joint_count = self.joints.len().max(1);
        let mut primitives = Vec::new();
        for part in 0..self.parts {
            let base = part as f32;
            let positions = [base, 0.0, 0.0, base + 1.0, 0.0, 0.0, base, 1.0, 0.0];
            let position = writer.accessor_f32(&positions, "VEC3", Some((vec![base, 0.0, 0.0], vec![base + 1.0, 1.0, 0.0])));
            let joints: Vec<u16> =
                (0..3).flat_map(|k| [((k + part) % joint_count) as u16, ((k + part + 1) % joint_count) as u16, 0, 0]).collect();
            let joints_accessor = writer.accessor_u16(&joints, "VEC4");
            let weights: Vec<f32> = (0..3).flat_map(|_| [0.75, 0.25, 0.0, 0.0]).collect();
            let weights_accessor = writer.accessor_f32(&weights, "VEC4", None);
            let indices = writer.accessor_u16(&[0, 1, 2], "SCALAR");
            primitives.push(format!(
                r#"{{"attributes":{{"POSITION":{position},"JOINTS_0":{joints_accessor},"WEIGHTS_0":{weights_accessor}}},"indices":{indices},"material":{part}}}"#
            ));
        }
        let ibm: Vec<f32> = self.inverse_bind().iter().flatten().copied().collect();
        let ibm_accessor = writer.accessor_f32(&ibm, "MAT4", None);
        let animations: Vec<String> = self.clips.iter().map(|clip| clip_json(clip, &mut writer)).collect();
        let nodes: Vec<String> = (0..self.nodes.len()).map(|index| self.node_json(index)).collect();
        let materials: Vec<String> =
            (0..self.parts).map(|part| format!(r#"{{"name":"part{part}","pbrMetallicRoughness":{{"baseColorFactor":[1,{},0.5,1]}}}}"#, part as f32 * 0.25)).collect();
        let joints = list(self.joints.iter().map(usize::to_string));
        let roots = list(self.scene_roots.iter().map(usize::to_string));
        let mut json = format!(
            r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"bufferViews":[{}],"accessors":[{}],"materials":[{}],"meshes":[{{"primitives":[{}]}}],"skins":[{{"joints":{joints},"inverseBindMatrices":{ibm_accessor}}}],"nodes":[{}],"scenes":[{{"nodes":{roots}}}],"scene":0"#,
            writer.bin.len(),
            writer.views.join(","),
            writer.accessors.join(","),
            materials.join(","),
            primitives.join(","),
            nodes.join(","),
        );
        if !animations.is_empty() {
            json.push_str(&format!(r#","animations":[{}]"#, animations.join(",")));
        }
        json.push('}');
        (json, writer.bin)
    }

    /// The rig as GLB bytes.
    pub fn glb(&self) -> Vec<u8> {
        let (json, bin) = self.json_and_bin();
        glb(&json, &bin)
    }

    fn node_json(&self, index: usize) -> String {
        let node = &self.nodes[index];
        let mut children: Vec<usize> = (0..self.nodes.len()).filter(|&c| self.nodes[c].parent == Some(index)).collect();
        children.extend(self.extra_children.iter().filter(|(parent, _)| *parent == index).map(|(_, child)| *child));
        let mut fields = vec![format!(r#""name":"{}""#, node.name)];
        if !children.is_empty() {
            fields.push(format!(r#""children":{}"#, list(children.iter().map(usize::to_string))));
        }
        if node.as_matrix {
            let matrix = local_matrix(node).to_cols_array();
            fields.push(format!(r#""matrix":{}"#, floats(&matrix)));
        } else {
            fields.push(format!(r#""translation":{}"#, floats(&node.translation)));
            fields.push(format!(r#""rotation":{}"#, floats(&node.rotation)));
            fields.push(format!(r#""scale":{}"#, floats(&node.scale)));
        }
        if index == self.mesh_node {
            fields.push(r#""mesh":0,"skin":0"#.to_owned());
        }
        format!("{{{}}}", fields.join(","))
    }
}

/// A node's local rest matrix, as genex-render's `Trs::matrix` builds it.
pub fn local_matrix(node: &NodeSpec) -> Mat4 {
    Mat4::from_scale_rotation_translation(Vec3::from(node.scale), Quat::from_array(node.rotation), Vec3::from(node.translation))
}

#[derive(Default)]
struct Writer {
    bin: Vec<u8>,
    views: Vec<String>,
    accessors: Vec<String>,
}

impl Writer {
    fn view(&mut self, bytes: &[u8]) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        let offset = self.bin.len();
        self.bin.extend_from_slice(bytes);
        self.views.push(format!(r#"{{"buffer":0,"byteOffset":{offset},"byteLength":{}}}"#, bytes.len()));
        self.views.len() - 1
    }

    fn accessor_f32(&mut self, values: &[f32], kind: &str, bounds: Option<(Vec<f32>, Vec<f32>)>) -> usize {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let view = self.view(&bytes);
        let count = values.len() / components(kind);
        let bounds = bounds.map_or(String::new(), |(min, max)| format!(r#","min":{},"max":{}"#, floats(&min), floats(&max)));
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5126,"count":{count},"type":"{kind}"{bounds}}}"#));
        self.accessors.len() - 1
    }

    fn accessor_u16(&mut self, values: &[u16], kind: &str) -> usize {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let view = self.view(&bytes);
        let count = values.len() / components(kind);
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5123,"count":{count},"type":"{kind}"}}"#));
        self.accessors.len() - 1
    }
}

fn components(kind: &str) -> usize {
    match kind {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        "MAT4" => 16,
        other => panic!("no accessor kind {other}"),
    }
}

fn clip_json(clip: &ClipSpec, writer: &mut Writer) -> String {
    let mut channels = Vec::new();
    let mut samplers = Vec::new();
    for (index, channel) in clip.channels.iter().enumerate() {
        let first = channel.times.first().copied().unwrap_or(0.0);
        let last = channel.times.last().copied().unwrap_or(0.0);
        let input = writer.accessor_f32(&channel.times, "SCALAR", Some((vec![first], vec![last])));
        let kind = if channel.path.width() == 4 { "VEC4" } else { "VEC3" };
        let output = writer.accessor_f32(&channel.values, kind, None);
        channels.push(format!(r#"{{"sampler":{index},"target":{{"node":{},"path":"{}"}}}}"#, channel.node, channel.path.wire()));
        samplers.push(format!(r#"{{"input":{input},"output":{output},"interpolation":"{}"}}"#, channel.interpolation.wire()));
    }
    format!(r#"{{"name":"{}","channels":[{}],"samplers":[{}]}}"#, clip.name, channels.join(","), samplers.join(","))
}

fn list(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

/// Floats as JSON numbers that read back to the same f32 (Rust's shortest round-trip form).
fn floats(values: &[f32]) -> String {
    list(values.iter().map(|v| if v.is_finite() { format!("{v:?}") } else { "0".to_owned() }))
}

/// GLB container bytes around a JSON chunk and a BIN chunk.
pub fn glb(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut json = json.as_bytes().to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut bin = bin.to_vec();
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut out = b"glTF".to_vec();
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// A small deterministic rotation for node `node` (the scripted pose both sides apply).
pub fn scripted_rotation(node: usize) -> Quat {
    let n = node as f32;
    let axis = Vec3::new(1.0 + n * 0.37, 2.0 - n * 0.11, 0.5 + n * 0.23).normalize();
    Quat::from_axis_angle(axis, 0.15 + n * 0.071)
}

/// The scripted pose of one posable node: its rest rotation turned by [`scripted_rotation`] and
/// its translation nudged, as (translation, rotation xyzw, scale).
pub fn scripted_local(node: &NodeSpec, index: usize) -> ([f32; 3], [f32; 4], [f32; 3]) {
    let rotation = (Quat::from_array(node.rotation) * scripted_rotation(index)).to_array();
    let n = index as f32;
    let translation = [node.translation[0] + 0.01 * n, node.translation[1], node.translation[2] - 0.005 * n];
    (translation, rotation, node.scale)
}

/// The times each clip of an oracle rig is sampled at.
pub const ORACLE_TIMES: [f32; 6] = [0.0, 0.1, 0.37, 0.5, 0.75, 1.0];

fn y_rotation(angle: f32) -> Quat {
    Quat::from_rotation_y(angle)
}

/// A 3-joint chain under a translated mesh node, with Step, Linear and CubicSpline clips.
pub fn chain3() -> RigSpec {
    let mut rig = RigSpec::new("chain3");
    rig.mesh_node = rig.node("body", None, [0.5, 0.0, -0.25], Quat::IDENTITY, [1.0; 3]);
    let root = rig.joint("root", None, [0.0, 0.1, 0.0], y_rotation(0.3));
    let mid = rig.joint("mid", Some(root), [0.0, 1.0, 0.0], Quat::from_rotation_z(0.2));
    let tip = rig.joint("tip", Some(mid), [0.0, 1.0, 0.0], Quat::IDENTITY);
    let half = std::f32::consts::FRAC_1_SQRT_2;
    rig.clips.push(ClipSpec {
        name: "Armature|Wave".to_owned(),
        channels: vec![
            ChannelSpec {
                node: mid,
                path: ChannelPath::Rotation,
                interpolation: ChannelInterpolation::Linear,
                times: vec![0.0, 0.5, 1.0],
                values: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, half, half, 0.0, 0.0, 0.0, 1.0],
            },
            ChannelSpec {
                node: root,
                path: ChannelPath::Translation,
                interpolation: ChannelInterpolation::Linear,
                times: vec![0.0, 1.0],
                values: vec![0.0, 0.1, 0.0, 0.5, 0.1, 0.25],
            },
        ],
    });
    rig.clips.push(ClipSpec {
        name: "Step".to_owned(),
        channels: vec![ChannelSpec {
            node: tip,
            path: ChannelPath::Scale,
            interpolation: ChannelInterpolation::Step,
            times: vec![0.0, 0.4, 0.8],
            values: vec![1.0, 1.0, 1.0, 1.5, 1.5, 1.5, 0.5, 0.5, 0.5],
        }],
    });
    // Cubic: (in-tangent, value, out-tangent) per key; non-zero tangents so Hermite differs from
    // a lerp of the values.
    rig.clips.push(ClipSpec {
        name: "Cubic".to_owned(),
        channels: vec![ChannelSpec {
            node: root,
            path: ChannelPath::Translation,
            interpolation: ChannelInterpolation::CubicSpline,
            times: vec![0.0, 1.0],
            values: vec![0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 2.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.1, 0.0, 0.0, 0.0, 0.0],
        }],
    });
    rig
}

/// The canonical 22 humanoid joints: (name, parent name, offset).
const HUMANOID: [(&str, &str, [f32; 3]); 22] = [
    ("Hips", "", [0.0, 1.0, 0.0]),
    ("Spine", "Hips", [0.0, 0.1, 0.0]),
    ("Spine1", "Spine", [0.0, 0.12, 0.0]),
    ("Spine2", "Spine1", [0.0, 0.12, 0.0]),
    ("Neck", "Spine2", [0.0, 0.15, 0.0]),
    ("Head", "Neck", [0.0, 0.1, 0.0]),
    ("LeftShoulder", "Spine2", [0.06, 0.12, 0.0]),
    ("LeftArm", "LeftShoulder", [0.12, 0.0, 0.0]),
    ("LeftForeArm", "LeftArm", [0.26, 0.0, 0.0]),
    ("LeftHand", "LeftForeArm", [0.24, 0.0, 0.0]),
    ("RightShoulder", "Spine2", [-0.06, 0.12, 0.0]),
    ("RightArm", "RightShoulder", [-0.12, 0.0, 0.0]),
    ("RightForeArm", "RightArm", [-0.26, 0.0, 0.0]),
    ("RightHand", "RightForeArm", [-0.24, 0.0, 0.0]),
    ("LeftUpLeg", "Hips", [0.09, -0.05, 0.0]),
    ("LeftLeg", "LeftUpLeg", [0.0, -0.42, 0.0]),
    ("LeftFoot", "LeftLeg", [0.0, -0.42, 0.0]),
    ("LeftToeBase", "LeftFoot", [0.0, -0.06, 0.12]),
    ("RightUpLeg", "Hips", [-0.09, -0.05, 0.0]),
    ("RightLeg", "RightUpLeg", [0.0, -0.42, 0.0]),
    ("RightFoot", "RightLeg", [0.0, -0.42, 0.0]),
    ("RightToeBase", "RightFoot", [0.0, -0.06, 0.12]),
];

fn add_humanoid(rig: &mut RigSpec, prefix: &str, root_parent: Option<usize>, unit: f32) -> Vec<usize> {
    let mut indices: Vec<usize> = Vec::new();
    for (k, (name, parent, offset)) in HUMANOID.iter().enumerate() {
        let parent = if parent.is_empty() { root_parent } else { HUMANOID.iter().position(|(n, _, _)| n == parent).map(|p| indices[p]) };
        let offset = [offset[0] * unit, offset[1] * unit, offset[2] * unit];
        let turn = Quat::from_rotation_x(0.02 * k as f32) * Quat::from_rotation_z(-0.015 * k as f32);
        indices.push(rig.joint(&format!("{prefix}{name}"), parent, offset, turn));
    }
    indices
}

/// A 22-joint humanoid with a walk clip.
pub fn humanoid22() -> RigSpec {
    let mut rig = RigSpec::new("humanoid22");
    rig.mesh_node = rig.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let joints = add_humanoid(&mut rig, "", None, 1.0);
    rig.parts = 2;
    rig.clips.push(ClipSpec {
        name: "Walk".to_owned(),
        channels: vec![
            ChannelSpec {
                node: joints[14],
                path: ChannelPath::Rotation,
                interpolation: ChannelInterpolation::Linear,
                times: vec![0.0, 0.5, 1.0],
                values: [Quat::from_rotation_x(0.5), Quat::from_rotation_x(-0.5), Quat::from_rotation_x(0.5)].iter().flat_map(|q| q.to_array()).collect(),
            },
            ChannelSpec {
                node: joints[0],
                path: ChannelPath::Translation,
                interpolation: ChannelInterpolation::Linear,
                times: vec![0.0, 1.0],
                values: vec![0.0, 1.0, 0.0, 0.0, 1.0, 1.2],
            },
        ],
    });
    rig
}

/// A Mixamo-style rig: an "Armature" node turned 90° about X at scale 0.01 holds the mesh and the
/// `mixamorig:` joints, which sit in centimetres.
pub fn mixamo() -> RigSpec {
    let mut rig = RigSpec::new("mixamo");
    let armature = rig.node("Armature", None, [0.0; 3], Quat::from_rotation_x(std::f32::consts::FRAC_PI_2), [0.01; 3]);
    rig.mesh_node = rig.node("Beta_Surface", Some(armature), [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let joints = add_humanoid(&mut rig, "mixamorig:", Some(armature), 100.0);
    rig.clips.push(ClipSpec {
        name: "mixamo.com".to_owned(),
        channels: vec![ChannelSpec {
            node: joints[7],
            path: ChannelPath::Rotation,
            interpolation: ChannelInterpolation::Linear,
            times: vec![0.0, 1.0],
            values: [Quat::IDENTITY, Quat::from_rotation_z(1.0)].iter().flat_map(|q| q.to_array()).collect(),
        }],
    });
    rig
}

/// A chain whose file lists children before parents and whose skin lists the joints tip first.
pub fn unordered() -> RigSpec {
    let mut rig = RigSpec::new("unordered");
    // File order: tip, mid, mesh, root (parents are fixed up after every node exists).
    for (name, translation) in [("tip", [0.0, 0.8, 0.0]), ("mid", [0.0, 0.9, 0.1]), ("body", [0.0; 3]), ("root", [0.2, 0.0, 0.0])] {
        rig.nodes.push(NodeSpec { name: name.to_owned(), parent: None, translation, rotation: y_rotation(0.4).to_array(), scale: [1.0; 3], as_matrix: false });
    }
    rig.nodes[0].parent = Some(1);
    rig.nodes[1].parent = Some(3);
    rig.mesh_node = 2;
    rig.scene_roots = vec![2, 3];
    rig.joints = vec![0, 3, 1];
    rig
}

/// A chain whose middle joint's rest is written as a `matrix`, with a non-joint node between
/// two joints and a non-uniform scale.
pub fn matrix_and_between() -> RigSpec {
    let mut rig = RigSpec::new("matrix_and_between");
    rig.mesh_node = rig.node("body", None, [0.0, 0.0, 0.3], y_rotation(-0.2), [1.0; 3]);
    let root = rig.joint("root", None, [0.0; 3], Quat::IDENTITY);
    let mid = rig.joint("mid", Some(root), [0.0, 1.0, 0.0], Quat::from_rotation_x(0.3));
    rig.nodes[mid].as_matrix = true;
    rig.nodes[mid].scale = [1.0, 1.5, 0.8];
    let socket = rig.node("socket", Some(mid), [0.1, 0.5, 0.0], Quat::from_rotation_y(0.7), [1.0; 3]);
    rig.joint("tip", Some(socket), [0.0, 0.5, 0.0], Quat::IDENTITY);
    rig
}

/// A tree of `count` joints (a spine with side branches), for the cost and allocation rows.
pub fn tree(name: &'static str, count: usize) -> RigSpec {
    let mut rig = RigSpec::new(name);
    rig.mesh_node = rig.node("body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let mut spine: Option<usize> = None;
    for k in 0..count {
        let joint = rig.joint(&format!("j{k}"), spine, [0.0, 0.1, 0.01 * (k % 5) as f32], Quat::from_rotation_y(0.01 * k as f32));
        if k % 3 != 2 {
            spine = Some(joint);
        }
    }
    rig
}

/// Every rig with an oracle file.
pub fn oracle_rigs() -> Vec<RigSpec> {
    vec![chain3(), humanoid22(), mixamo(), unordered(), matrix_and_between(), tree("tree60", 60)]
}
