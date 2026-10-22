//! The mannequin: a 22-joint humanoid written as GLB bytes in code, so the example ships no asset
//! file and every destination reads the same bytes. Copied from the `characters` example; here the
//! `Walk` and `Run` hips travel forward over each cycle, so the clips carry root motion (the
//! frontier's agents move by it through `CharacterMotion::Mixed`). Each bone is a box from its
//! joint towards its child, skinned rigidly to that joint, and the clips are keyed from sines.
//!
//! Clips: `Idle` (2 s), `Walk` (1 s, 1.4 m), `Run` (0.66 s, 2.6 m), `Slash` (0.8 s, played once)
//! and `Climb` (1 s, hand over hand, in place).

use genex::glam::{Mat4, Quat, Vec3};

/// The file name the game loads it as.
pub const MANNEQUIN: &str = "mannequin.glb";

/// Keys per clip cycle (the last equals the first, so a loop closes; the hips' forward travel is
/// the root motion the loop carries on).
const KEYS: usize = 17;
/// Metres the hips travel over one `Walk` cycle and one `Run` cycle.
pub const WALK_TRAVEL: f32 = 1.4;
/// See [`WALK_TRAVEL`].
pub const RUN_TRAVEL: f32 = 2.6;

/// The joints: name, parent (an index into this table) and offset from the parent, in metres.
/// The character stands at the origin facing +z, its arms hanging at its sides.
const JOINTS: [(&str, Option<usize>, [f32; 3]); 22] = [
    ("Hips", None, [0.0, 0.98, 0.0]),
    ("Spine", Some(0), [0.0, 0.1, 0.0]),
    ("Spine1", Some(1), [0.0, 0.13, 0.0]),
    ("Spine2", Some(2), [0.0, 0.13, 0.0]),
    ("Neck", Some(3), [0.0, 0.15, 0.0]),
    ("Head", Some(4), [0.0, 0.1, 0.0]),
    ("LeftShoulder", Some(3), [0.07, 0.11, 0.0]),
    ("LeftArm", Some(6), [0.12, 0.0, 0.0]),
    ("LeftForeArm", Some(7), [0.0, -0.28, 0.0]),
    ("LeftHand", Some(8), [0.0, -0.25, 0.0]),
    ("RightShoulder", Some(3), [-0.07, 0.11, 0.0]),
    ("RightArm", Some(10), [-0.12, 0.0, 0.0]),
    ("RightForeArm", Some(11), [0.0, -0.28, 0.0]),
    ("RightHand", Some(12), [0.0, -0.25, 0.0]),
    ("LeftUpLeg", Some(0), [0.1, -0.05, 0.0]),
    ("LeftLeg", Some(14), [0.0, -0.43, 0.0]),
    ("LeftFoot", Some(15), [0.0, -0.43, 0.0]),
    ("LeftToeBase", Some(16), [0.0, -0.06, 0.13]),
    ("RightUpLeg", Some(0), [-0.1, -0.05, 0.0]),
    ("RightLeg", Some(18), [0.0, -0.43, 0.0]),
    ("RightFoot", Some(19), [0.0, -0.43, 0.0]),
    ("RightToeBase", Some(20), [0.0, -0.06, 0.13]),
];

/// Joint indices the clips key.
const HIPS: usize = 0;
const SPINE: usize = 1;
const SPINE1: usize = 2;
const NECK: usize = 4;
const ARM: [usize; 2] = [7, 11];
const FORE_ARM: [usize; 2] = [8, 12];
const UP_LEG: [usize; 2] = [14, 18];
const LEG: [usize; 2] = [15, 19];
const FOOT: [usize; 2] = [16, 20];

/// Each bone's box: half its width across, in metres (the head and torso are wider).
fn bone_half_width(joint: usize) -> f32 {
    match JOINTS[joint].0 {
        "Hips" | "Spine" | "Spine1" | "Spine2" => 0.13,
        "Head" => 0.1,
        "LeftUpLeg" | "RightUpLeg" => 0.075,
        "LeftShoulder" | "RightShoulder" => 0.05,
        _ => 0.05,
    }
}

/// One clip's channels: (joint, rotations per key) and the hips' translations per key.
struct ClipKeys {
    name: &'static str,
    seconds: f32,
    rotations: Vec<(usize, Vec<Quat>)>,
    hips: Vec<Vec3>,
}

fn phase(key: usize) -> f32 {
    key as f32 / (KEYS - 1) as f32 * std::f32::consts::TAU
}

/// A rotation about x per key: `amplitude × sin(phase + shift) + bias`.
fn swing_x(amplitude: f32, shift: f32, bias: f32) -> Vec<Quat> {
    (0..KEYS).map(|key| Quat::from_rotation_x(amplitude * genex::math::sin(phase(key) + shift) + bias)).collect()
}

/// A knee or elbow bend per key: `max(0, sin(phase + shift)) × amplitude + bias` about x.
fn bend_x(amplitude: f32, shift: f32, bias: f32) -> Vec<Quat> {
    (0..KEYS).map(|key| Quat::from_rotation_x(amplitude * genex::math::sin(phase(key) + shift).max(0.0) + bias)).collect()
}

fn hips_bob(depth: f32) -> Vec<Vec3> {
    let rest = Vec3::from(JOINTS[HIPS].2);
    (0..KEYS).map(|key| rest - Vec3::Y * (depth * (0.5 - 0.5 * genex::math::cos(2.0 * phase(key))))).collect()
}

/// A locomotion cycle; its hips travel `travel` metres forward (+z) over the cycle (root motion).
#[allow(clippy::too_many_arguments)]
fn locomotion(name: &'static str, seconds: f32, travel: f32, stride: f32, knee: f32, arm: f32, lean: f32, bob: f32) -> ClipKeys {
    use std::f32::consts::PI;
    let mut rotations = vec![(SPINE, swing_x(0.0, 0.0, lean))];
    for (side, shift) in [(0, 0.0), (1, PI)] {
        rotations.push((UP_LEG[side], swing_x(stride, shift, 0.0)));
        rotations.push((LEG[side], bend_x(-knee, shift + 0.5 * PI, 0.0)));
        rotations.push((FOOT[side], swing_x(0.2 * stride, shift, 0.0)));
        rotations.push((ARM[side], swing_x(arm, shift + PI, 0.0)));
        rotations.push((FORE_ARM[side], swing_x(0.0, 0.0, 0.6 * arm + 0.1)));
    }
    let hips = hips_bob(bob).into_iter().enumerate().map(|(key, at)| at + Vec3::Z * (travel * key as f32 / (KEYS - 1) as f32)).collect();
    ClipKeys { name, seconds, rotations, hips }
}

fn idle() -> ClipKeys {
    let rotations = vec![
        (SPINE, swing_x(0.03, 0.0, 0.0)),
        (NECK, swing_x(0.04, 1.0, 0.0)),
        (ARM[0], swing_x(0.04, 0.0, 0.0)),
        (ARM[1], swing_x(0.04, 0.5, 0.0)),
        (FORE_ARM[0], swing_x(0.0, 0.0, 0.15)),
        (FORE_ARM[1], swing_x(0.0, 0.0, 0.15)),
    ];
    ClipKeys { name: "Idle", seconds: 2.0, rotations, hips: hips_bob(0.01) }
}

/// The right arm raised and swept down across the body, the chest turning with it.
fn slash() -> ClipKeys {
    let curve = |key: usize| {
        let t = key as f32 / (KEYS - 1) as f32;
        if t < 0.35 { t / 0.35 } else { 1.0 - (t - 0.35) / 0.65 }
    };
    let arm = (0..KEYS).map(|key| Quat::from_rotation_x(-2.4 * curve(key)) * Quat::from_rotation_z(-0.5 * curve(key))).collect();
    let fore = (0..KEYS).map(|key| Quat::from_rotation_x(-0.8 * curve(key))).collect();
    let chest = (0..KEYS).map(|key| Quat::from_rotation_y(0.5 * curve(key) - 0.25 * (1.0 - curve(key)))).collect();
    let rest = Vec3::from(JOINTS[HIPS].2);
    ClipKeys { name: "Slash", seconds: 0.8, rotations: vec![(ARM[1], arm), (FORE_ARM[1], fore), (SPINE1, chest)], hips: vec![rest; KEYS] }
}

/// Hand over hand: the arms reach up in turn, the knees lift in turn.
fn climb() -> ClipKeys {
    use std::f32::consts::PI;
    let mut rotations = Vec::new();
    for (side, shift) in [(0, 0.0), (1, PI)] {
        rotations.push((ARM[side], swing_x(0.5, shift, -2.4)));
        rotations.push((FORE_ARM[side], bend_x(-0.9, shift, -0.2)));
        rotations.push((UP_LEG[side], bend_x(-1.0, shift + PI, -0.3)));
        rotations.push((LEG[side], bend_x(1.2, shift + PI, 0.3)));
    }
    ClipKeys { name: "Climb", seconds: 1.0, rotations, hips: hips_bob(0.03) }
}

fn clips() -> Vec<ClipKeys> {
    vec![idle(), locomotion("Walk", 1.0, WALK_TRAVEL, 0.45, 0.7, 0.35, 0.03, 0.03), locomotion("Run", 0.66, RUN_TRAVEL, 0.8, 1.3, 0.7, 0.15, 0.06), slash(), climb()]
}

/// Little-endian GLB pieces: the binary chunk and its views and accessors as JSON.
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
        self.views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#, self.bin.len(), bytes.len()));
        self.bin.extend_from_slice(bytes);
        self.views.len() - 1
    }

    fn floats(&mut self, values: &[f32], kind: &str, bounds: Option<(Vec<f32>, Vec<f32>)>) -> usize {
        let width = match kind {
            "SCALAR" => 1,
            "VEC3" => 3,
            "VEC4" => 4,
            _ => 16,
        };
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        let view = self.view(&bytes);
        let bounds = bounds.map_or(String::new(), |(min, max)| format!(r#","min":{},"max":{}"#, list(&min), list(&max)));
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5126,"count":{},"type":"{kind}"{bounds}}}"#, values.len() / width));
        self.accessors.len() - 1
    }

    fn shorts(&mut self, values: &[u16], kind: &str) -> usize {
        let width = if kind == "VEC4" { 4 } else { 1 };
        let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();
        let view = self.view(&bytes);
        self.accessors.push(format!(r#"{{"bufferView":{view},"componentType":5123,"count":{},"type":"{kind}"}}"#, values.len() / width));
        self.accessors.len() - 1
    }
}

fn list(values: &[f32]) -> String {
    let items: Vec<String> = values.iter().map(|value| format!("{value}")).collect();
    format!("[{}]", items.join(","))
}

/// Each joint's model-space rest position.
fn rest_positions() -> Vec<Vec3> {
    let mut out: Vec<Vec3> = Vec::with_capacity(JOINTS.len());
    for (_, parent, offset) in JOINTS {
        let base = parent.map_or(Vec3::ZERO, |parent| out[parent]);
        out.push(base + Vec3::from(offset));
    }
    out
}

/// Where a joint's box ends: its first child's joint, or a short way on for a leaf.
fn bone_end(joint: usize, rest: &[Vec3]) -> Vec3 {
    let child = JOINTS.iter().position(|(_, parent, _)| *parent == Some(joint));
    match (JOINTS[joint].0, child) {
        ("Head", _) => rest[joint] + Vec3::Y * 0.22,
        ("LeftHand" | "RightHand", _) => rest[joint] - Vec3::Y * 0.12,
        ("Spine2", _) => rest[joint] + Vec3::Y * 0.15,
        ("Hips", _) => rest[joint] + Vec3::Y * 0.1,
        (_, Some(child)) => rest[child],
        (_, None) => rest[joint] + Vec3::Z * 0.05,
    }
}

/// A box from `a` to `b`, `half` wide: 24 corners with flat normals and 36 indices.
fn bone_box(a: Vec3, b: Vec3, half: f32, positions: &mut Vec<f32>, normals: &mut Vec<f32>, indices: &mut Vec<u16>) {
    let along = (b - a).normalize_or(Vec3::Y);
    let side = if along.y.abs() > 0.9 { Vec3::X } else { Vec3::Y.cross(along).normalize() };
    let up = along.cross(side).normalize();
    let center = 0.5 * (a + b);
    let extent = [0.5 * (b - a).length() + 0.02, half, half];
    let axes = [along, side, up];
    for (axis, sign) in [(0, 1.0), (0, -1.0), (1, 1.0), (1, -1.0), (2, 1.0), (2, -1.0)] {
        let normal = axes[axis] * sign;
        let (u, v) = (axes[(axis + 1) % 3] * extent[(axis + 1) % 3], axes[(axis + 2) % 3] * extent[(axis + 2) % 3]);
        let face = center + normal * extent[axis];
        let base = (positions.len() / 3) as u16;
        let corners = if sign > 0.0 { [face - u - v, face + u - v, face + u + v, face - u + v] } else { [face - u - v, face - u + v, face + u + v, face + u - v] };
        for corner in corners {
            positions.extend(corner.to_array());
            normals.extend(normal.to_array());
        }
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// The mannequin as GLB bytes (the same bytes on every call and destination).
pub fn glb() -> Vec<u8> {
    let rest = rest_positions();
    let mut writer = Writer::default();
    let (mut positions, mut normals, mut indices, mut joints) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for joint in 0..JOINTS.len() {
        let before = positions.len() / 3;
        bone_box(rest[joint], bone_end(joint, &rest), bone_half_width(joint), &mut positions, &mut normals, &mut indices);
        let added = positions.len() / 3 - before;
        joints.extend(std::iter::repeat_n([joint as u16, 0, 0, 0], added).flatten());
    }
    let weights: Vec<f32> = std::iter::repeat_n([1.0, 0.0, 0.0, 0.0], positions.len() / 3).flatten().collect();
    let bounds = |values: &[f32]| {
        let (mut min, mut max) = (vec![f32::MAX; 3], vec![f32::MIN; 3]);
        for corner in values.chunks(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(corner[axis]);
                max[axis] = max[axis].max(corner[axis]);
            }
        }
        (min, max)
    };
    let position = writer.floats(&positions, "VEC3", Some(bounds(&positions)));
    let normal = writer.floats(&normals, "VEC3", None);
    let joint_accessor = writer.shorts(&joints, "VEC4");
    let weight_accessor = writer.floats(&weights, "VEC4", None);
    let index_accessor = writer.shorts(&indices, "SCALAR");
    let inverse_bind: Vec<f32> = rest.iter().flat_map(|at| Mat4::from_translation(-*at).to_cols_array()).collect();
    let ibm = writer.floats(&inverse_bind, "MAT4", None);
    let animations: Vec<String> = clips().iter().map(|clip| clip_json(clip, &mut writer)).collect();
    // Node 0 holds the mesh; joint `j` is node `j + 1`.
    let mut nodes = vec![r#"{"name":"Mannequin","mesh":0,"skin":0}"#.to_owned()];
    for (index, (name, _, offset)) in JOINTS.iter().enumerate() {
        let children: Vec<String> = JOINTS.iter().enumerate().filter(|(_, (_, parent, _))| *parent == Some(index)).map(|(child, _)| (child + 1).to_string()).collect();
        let children = if children.is_empty() { String::new() } else { format!(r#","children":[{}]"#, children.join(",")) };
        nodes.push(format!(r#"{{"name":"{name}","translation":{}{children}}}"#, list(offset)));
    }
    let skin_joints: Vec<String> = (1..=JOINTS.len()).map(|node| node.to_string()).collect();
    let json = format!(
        concat!(
            r#"{{"asset":{{"version":"2.0","generator":"genex frontier example"}},"buffers":[{{"byteLength":{bin}}}],"bufferViews":[{views}],"accessors":[{accessors}],"#,
            r#""materials":[{{"name":"mannequin","pbrMetallicRoughness":{{"baseColorFactor":[0.82,0.78,0.72,1],"metallicFactor":0,"roughnessFactor":0.6}}}}],"#,
            r#""meshes":[{{"name":"Mannequin","primitives":[{{"attributes":{{"POSITION":{position},"NORMAL":{normal},"JOINTS_0":{joints},"WEIGHTS_0":{weights}}},"indices":{indices},"material":0}}]}}],"#,
            r#""skins":[{{"joints":[{skin}],"inverseBindMatrices":{ibm},"skeleton":1}}],"nodes":[{nodes}],"scenes":[{{"nodes":[0,1]}}],"scene":0,"animations":[{animations}]}}"#
        ),
        bin = writer.bin.len(),
        views = writer.views.join(","),
        accessors = writer.accessors.join(","),
        position = position,
        normal = normal,
        joints = joint_accessor,
        weights = weight_accessor,
        indices = index_accessor,
        skin = skin_joints.join(","),
        ibm = ibm,
        nodes = nodes.join(","),
        animations = animations.join(","),
    );
    pack(&json, &writer.bin)
}

/// A clip's samplers and channels, its keys written through `writer`.
fn clip_json(clip: &ClipKeys, writer: &mut Writer) -> String {
    let times: Vec<f32> = (0..KEYS).map(|key| clip.seconds * key as f32 / (KEYS - 1) as f32).collect();
    let input = writer.floats(&times, "SCALAR", Some((vec![0.0], vec![clip.seconds])));
    let mut samplers = Vec::new();
    let mut channels = Vec::new();
    for (joint, rotations) in &clip.rotations {
        let values: Vec<f32> = rotations.iter().flat_map(|rotation| rotation.normalize().to_array()).collect();
        let output = writer.floats(&values, "VEC4", None);
        channels.push(format!(r#"{{"sampler":{},"target":{{"node":{},"path":"rotation"}}}}"#, samplers.len(), joint + 1));
        samplers.push(format!(r#"{{"input":{input},"output":{output},"interpolation":"LINEAR"}}"#));
    }
    let values: Vec<f32> = clip.hips.iter().flat_map(|at| at.to_array()).collect();
    let output = writer.floats(&values, "VEC3", None);
    channels.push(format!(r#"{{"sampler":{},"target":{{"node":{},"path":"translation"}}}}"#, samplers.len(), HIPS + 1));
    samplers.push(format!(r#"{{"input":{input},"output":{output},"interpolation":"LINEAR"}}"#));
    format!(r#"{{"name":"{}","samplers":[{}],"channels":[{}]}}"#, clip.name, samplers.join(","), channels.join(","))
}

/// The GLB container: header, JSON chunk (space padded), BIN chunk (zero padded).
fn pack(json: &str, bin: &[u8]) -> Vec<u8> {
    let mut json = json.as_bytes().to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut bin = bin.to_vec();
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = 12 + 8 + json.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}
