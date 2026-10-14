//! A procedural skinned walker: eleven joints (hips, chest, neck, two arms of two bones, two legs
//! of two bones), limbs as tubes whose first rings blend with the parent bone so elbows and knees
//! bend smoothly, and a walk cycle posed from the frame index alone.

use genex::math::{self, Quat, Vec3, vec3};
use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::MeshData;
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};

use super::geometry::{boxes, merged, transformed, tube, uv_sphere};

/// The joints, in skin order (each one is also its node).
const HIPS: usize = 0;
const CHEST: usize = 1;
const NECK: usize = 2;
const LEFT_ARM: usize = 3;
const LEFT_FOREARM: usize = 4;
const RIGHT_ARM: usize = 5;
const RIGHT_FOREARM: usize = 6;
const LEFT_THIGH: usize = 7;
const LEFT_SHIN: usize = 8;
const RIGHT_THIGH: usize = 9;
const RIGHT_SHIN: usize = 10;

/// Each joint's parent and where it sits in the bind pose (model space, metres, facing +Z).
const JOINTS: [(Option<usize>, [f32; 3]); 11] = [
    (None, [0.0, 0.95, 0.0]),
    (Some(HIPS), [0.0, 1.4, 0.0]),
    (Some(CHEST), [0.0, 1.55, 0.0]),
    (Some(CHEST), [0.21, 1.47, 0.0]),
    (Some(LEFT_ARM), [0.23, 1.18, 0.0]),
    (Some(CHEST), [-0.21, 1.47, 0.0]),
    (Some(RIGHT_ARM), [-0.23, 1.18, 0.0]),
    (Some(HIPS), [0.1, 0.92, 0.0]),
    (Some(LEFT_THIGH), [0.1, 0.5, 0.0]),
    (Some(HIPS), [-0.1, 0.92, 0.0]),
    (Some(RIGHT_THIGH), [-0.1, 0.5, 0.0]),
];

/// The fraction of a limb, from its root, whose rings blend with the parent bone.
const BLEND: f32 = 0.4;
/// Walk cycles per second.
const STRIDES_PER_SECOND: f32 = 0.9;

fn at(joint: usize) -> Vec3 {
    Vec3::from(JOINTS[joint].1)
}

/// The skeleton: every node at rest is its offset from its parent; inverse binds undo the bind pose.
fn skeleton() -> Skeleton {
    let nodes = JOINTS
        .iter()
        .map(|(parent, position)| {
            let offset = Vec3::from(*position) - parent.map_or(Vec3::ZERO, at);
            SkeletonNode { parent: *parent, rest: Trs { translation: offset.to_array(), ..Trs::IDENTITY } }
        })
        .collect();
    let inverse_bind = JOINTS.iter().map(|(_, p)| math::Mat4::from_translation(-Vec3::from(*p)).to_cols_array()).collect();
    Skeleton { nodes, joints: (0..JOINTS.len()).collect(), inverse_bind, mesh_node: None }
}

/// A part's skin rows: every vertex on `joint`.
fn rigid(mesh: &MeshData, joint: usize) -> Vec<GpuSkinVertex> {
    vec![GpuSkinVertex { joints: [joint as u32, 0, 0, 0], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()]
}

/// A limb from `joint` to `end`: its tube and skin rows, its first rings shared with the parent.
fn limb(joint: usize, end: Vec3, radius: [f32; 2]) -> (MeshData, Vec<GpuSkinVertex>) {
    let (rings, segments) = (8, 10);
    let mesh = tube(at(joint), end, radius, rings, segments);
    let parent = JOINTS[joint].0.unwrap_or(joint);
    let skin = (0..=rings)
        .flat_map(|ring| {
            let t = ring as f32 / rings as f32;
            let own = (0.5 + 0.5 * t / BLEND).min(1.0);
            std::iter::repeat_n(GpuSkinVertex { joints: [joint as u32, parent as u32, 0, 0], weights: [own, 1.0 - own, 0.0, 0.0] }, segments as usize + 1)
        })
        .collect();
    (mesh, skin)
}

/// A ball of `radius` at `center` on `joint` (closes a limb's ends).
fn ball(center: Vec3, radius: f32, joint: usize) -> (MeshData, Vec<GpuSkinVertex>) {
    let mesh = transformed(&uv_sphere(8, 12), math::Mat4::from_scale_rotation_translation(Vec3::splat(radius), Quat::IDENTITY, center));
    let skin = rigid(&mesh, joint);
    (mesh, skin)
}

/// The walker in bind pose, 1.8 m tall, standing on y = 0 facing +Z.
pub fn walker() -> SkinnedMeshData {
    let mut parts: Vec<(MeshData, Vec<GpuSkinVertex>)> = vec![
        limb(HIPS, at(CHEST) + vec3(0.0, 0.08, 0.0), [0.17, 0.2]),
        limb(CHEST, at(NECK), [0.2, 0.08]),
        ball(at(NECK) + vec3(0.0, 0.14, 0.02), 0.12, NECK),
        ball(at(HIPS), 0.17, HIPS),
    ];
    let mut sides = Vec::new();
    for (arm, forearm, thigh, shin, x) in [(LEFT_ARM, LEFT_FOREARM, LEFT_THIGH, LEFT_SHIN, 1.0), (RIGHT_ARM, RIGHT_FOREARM, RIGHT_THIGH, RIGHT_SHIN, -1.0)] {
        let hand = vec3(0.24 * x, 0.92, 0.0);
        let ankle = vec3(0.1 * x, 0.08, 0.0);
        sides.push(limb(arm, at(forearm), [0.06, 0.05]));
        sides.push(limb(forearm, hand, [0.05, 0.04]));
        sides.push(ball(at(arm), 0.065, arm));
        sides.push(ball(at(forearm), 0.05, forearm));
        sides.push(ball(hand, 0.05, forearm));
        sides.push(limb(thigh, at(shin), [0.085, 0.065]));
        sides.push(limb(shin, ankle, [0.065, 0.05]));
        sides.push(ball(at(shin), 0.066, shin));
        let foot = boxes(&[(vec3(0.1 * x, 0.04, 0.05), vec3(0.1, 0.08, 0.26))]);
        let foot_skin = rigid(&foot, shin);
        sides.push((foot, foot_skin));
    }
    parts.extend(sides);
    let meshes: Vec<MeshData> = parts.iter().map(|(mesh, _)| mesh.clone()).collect();
    let skin = parts.into_iter().flat_map(|(_, skin)| skin).collect();
    SkinnedMeshData { mesh: merged(&meshes), skin, skeleton: skeleton(), animations: Vec::new() }
}

fn swing(angle: f32) -> [f32; 4] {
    Quat::from_rotation_x(angle).to_array()
}

/// The joint matrices of the walk cycle at `seconds` (legs and arms swing in opposition, knees
/// and elbows bend, the hips bob).
pub fn walk(walker: &SkinnedMeshData, seconds: f32) -> Vec<[f32; 16]> {
    let skeleton = &walker.skeleton;
    let phase = math::TAU * STRIDES_PER_SECOND * seconds;
    let (s, c) = math::sin_cos(phase);
    let mut pose = skeleton.rest_pose();
    pose[HIPS].translation[1] += 0.03 * c.abs();
    pose[LEFT_THIGH].rotation = swing(-0.5 * s);
    pose[RIGHT_THIGH].rotation = swing(0.5 * s);
    pose[LEFT_SHIN].rotation = swing(0.6 * (-c).max(0.0) + 0.1);
    pose[RIGHT_SHIN].rotation = swing(0.6 * c.max(0.0) + 0.1);
    pose[LEFT_ARM].rotation = swing(0.4 * s);
    pose[RIGHT_ARM].rotation = swing(-0.4 * s);
    pose[LEFT_FOREARM].rotation = swing(-0.35);
    pose[RIGHT_FOREARM].rotation = swing(-0.35);
    pose[CHEST].rotation = Quat::from_rotation_y(0.12 * s).to_array();
    skeleton.joint_matrices(&pose)
}
