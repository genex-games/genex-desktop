//! AN-12: basic humanoid retargeting. A UAL walk retargeted onto a Meshy-style rig in an A-pose
//! whose bones point along other local axes keeps the feet's height within 2 cm of the source's
//! scaled by the leg ratio, and the limbs' directions on the source's; a source (or a target)
//! missing `LeftUpperLeg` is refused `animation-retarget-unmapped` naming the bone; retargeting
//! onto the same rig is the identity within 1e-6; and the load-time cost per clip is recorded
//! (budget 5 ms).
//!
//! Every row is new behaviour (section 0 of the game systems plan): the module was a stub.

mod support;

use genex_anim::AnimationErrorCode;
use genex_anim::clip::{Clip, Property, import_clips};
use genex_anim::humanoid::{HumanoidBone, HumanoidMap};
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::{Trs, same_hemisphere};
use genex_anim::retarget::{Retargeter, retarget_clips};
use genex_anim::sample::{SampleCursor, Wrap, sample};
use genex_anim::skeleton::Skeleton;
use glam::{Mat4, Quat, Vec3};
use support::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec, RigSpec};

/// `sin` through glam's libm (the platform's is not the same bits everywhere).
fn sin(x: f32) -> f32 {
    glam::Vec2::from_angle(x).y
}

/// The walk's length and key rate.
const WALK_SECONDS: f32 = 1.0;
const WALK_KEYS: usize = 30;

/// One joint of a fixture rig given in model space: its name, its parent (an earlier entry), its
/// rest position and its rest global rotation.
struct Joint {
    name: &'static str,
    parent: Option<usize>,
    position: Vec3,
    rotation: Quat,
}

/// A rig of `joints` (given in model space) under a mesh node at the origin, with `clips`
/// animating them (channel nodes are indices into `joints`).
fn rig_spec(name: &'static str, joints: &[Joint], clips: Vec<ClipSpec>) -> RigSpec {
    let mut spec = RigSpec::new(name);
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let mut nodes = Vec::new();
    for joint in joints {
        let (parent_position, parent_rotation) = joint.parent.map_or((Vec3::ZERO, Quat::IDENTITY), |p| (joints[p].position, joints[p].rotation));
        let local_rotation = parent_rotation.inverse() * joint.rotation;
        let offset = parent_rotation.inverse() * (joint.position - parent_position);
        nodes.push(spec.joint(joint.name, joint.parent.map(|p| nodes[p]), offset.to_array(), local_rotation));
    }
    for mut clip in clips {
        for channel in &mut clip.channels {
            channel.node = nodes[channel.node];
        }
        spec.clips.push(clip);
    }
    spec
}

/// The humanoid skeleton both fixtures share, in profile order (no root above the hips): each
/// bone's parent and its offset from it in a T-pose, metres.
const BODY: [(HumanoidBone, Option<usize>, [f32; 3]); 22] = [
    (HumanoidBone::Hips, None, [0.0, 0.95, 0.0]),
    (HumanoidBone::Spine, Some(0), [0.0, 0.1, 0.0]),
    (HumanoidBone::Chest, Some(1), [0.0, 0.12, 0.0]),
    (HumanoidBone::UpperChest, Some(2), [0.0, 0.12, 0.0]),
    (HumanoidBone::Neck, Some(3), [0.0, 0.15, 0.0]),
    (HumanoidBone::Head, Some(4), [0.0, 0.1, 0.0]),
    (HumanoidBone::LeftShoulder, Some(3), [0.06, 0.12, 0.0]),
    (HumanoidBone::LeftUpperArm, Some(6), [0.12, 0.0, 0.0]),
    (HumanoidBone::LeftLowerArm, Some(7), [0.26, 0.0, 0.0]),
    (HumanoidBone::LeftHand, Some(8), [0.24, 0.0, 0.0]),
    (HumanoidBone::RightShoulder, Some(3), [-0.06, 0.12, 0.0]),
    (HumanoidBone::RightUpperArm, Some(10), [-0.12, 0.0, 0.0]),
    (HumanoidBone::RightLowerArm, Some(11), [-0.26, 0.0, 0.0]),
    (HumanoidBone::RightHand, Some(12), [-0.24, 0.0, 0.0]),
    (HumanoidBone::LeftUpperLeg, Some(0), [0.09, -0.05, 0.0]),
    (HumanoidBone::LeftLowerLeg, Some(14), [0.0, -0.42, 0.0]),
    (HumanoidBone::LeftFoot, Some(15), [0.0, -0.42, 0.0]),
    (HumanoidBone::LeftToes, Some(16), [0.0, -0.06, 0.12]),
    (HumanoidBone::RightUpperLeg, Some(0), [-0.09, -0.05, 0.0]),
    (HumanoidBone::RightLowerLeg, Some(18), [0.0, -0.42, 0.0]),
    (HumanoidBone::RightFoot, Some(19), [0.0, -0.42, 0.0]),
    (HumanoidBone::RightToes, Some(20), [0.0, -0.06, 0.12]),
];

/// The UE mannequin's (Quaternius UAL's) names, in [`BODY`] order.
const UAL_NAMES: [&str; 22] = [
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "thigh_l", "calf_l",
    "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
];

/// Meshy's names, in [`BODY`] order.
const MESHY_NAMES: [&str; 22] = [
    "Hips",
    "Spine",
    "Spine01",
    "Spine02",
    "neck",
    "Head",
    "LeftShoulder",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "RightShoulder",
    "RightArm",
    "RightForeArm",
    "RightHand",
    "LeftUpLeg",
    "LeftLeg",
    "LeftFoot",
    "LeftToeBase",
    "RightUpLeg",
    "RightLeg",
    "RightFoot",
    "RightToeBase",
];

/// The source: a UAL rig (a `root` above the pelvis, identity rest rotations, a T-pose) with an
/// in-place walk keyed at 30 fps: thighs swing ±0.5 rad, calves bend, feet roll, arms swing and
/// the pelvis bobs.
fn ual(names: &[&'static str; 22]) -> RigSpec {
    let mut joints = vec![Joint { name: "root", parent: None, position: Vec3::ZERO, rotation: Quat::IDENTITY }];
    for (index, (_, parent, offset)) in BODY.iter().enumerate() {
        let parent = parent.map_or(0, |p| p + 1);
        joints.push(Joint { name: names[index], parent: Some(parent), position: joints[parent].position + Vec3::from(*offset), rotation: Quat::IDENTITY });
    }
    let times: Vec<f32> = (0..=WALK_KEYS).map(|k| k as f32 * WALK_SECONDS / WALK_KEYS as f32).collect();
    let phase = |t: f32| std::f32::consts::TAU * t / WALK_SECONDS;
    let rotations = |node: usize, at: &dyn Fn(f32) -> Quat| ChannelSpec {
        node,
        path: ChannelPath::Rotation,
        interpolation: ChannelInterpolation::Linear,
        times: times.clone(),
        values: times.iter().flat_map(|t| at(*t).to_array()).collect(),
    };
    let mut channels = vec![ChannelSpec {
        node: 1,
        path: ChannelPath::Translation,
        interpolation: ChannelInterpolation::Linear,
        times: times.clone(),
        values: times.iter().flat_map(|t| [0.0, 0.95 + 0.03 * sin(2.0 * phase(*t)), 0.0]).collect(),
    }];
    for (thigh, calf, foot, shift) in [(15, 16, 17, 0.0), (19, 20, 21, std::f32::consts::PI)] {
        channels.push(rotations(thigh, &move |t| Quat::from_rotation_x(0.5 * sin(phase(t) + shift))));
        channels.push(rotations(calf, &move |t| Quat::from_rotation_x(0.4 + 0.4 * sin(phase(t) + shift + 1.2))));
        channels.push(rotations(foot, &move |t| Quat::from_rotation_x(-0.2 * sin(phase(t) + shift + 0.6))));
    }
    for (arm, shift) in [(8, std::f32::consts::PI), (12, 0.0)] {
        channels.push(rotations(arm, &move |t| Quat::from_rotation_x(0.3 * sin(phase(t) + shift)) * Quat::from_rotation_z(0.1)));
    }
    rig_spec("ual-walk", &joints, vec![ClipSpec { name: "Walk_Loop".to_owned(), channels }])
}

/// The scale of the Meshy-style target's legs and pelvis height over the source's.
const LEG_RATIO: f32 = 1.15;

/// The target: a Meshy-style rig, hips at the root, legs and pelvis height 1.15 times the
/// source's, a longer spine, an A-pose (arms 45° down), and every bone's rest frame turned
/// (bones along local Y pointing forward, then twisted per joint) so no local rotation means what
/// the source's does.
fn meshy() -> RigSpec {
    let mut joints: Vec<Joint> = Vec::new();
    let a_pose = Quat::from_rotation_z(-std::f32::consts::FRAC_PI_4);
    for (index, (bone, parent, offset)) in BODY.iter().enumerate() {
        let mut offset = Vec3::from(*offset);
        let leg = matches!(bone, HumanoidBone::Hips) || (index >= 14);
        if leg {
            offset *= LEG_RATIO;
        } else if matches!(bone, HumanoidBone::Spine | HumanoidBone::Chest | HumanoidBone::UpperChest) {
            offset *= 1.3;
        }
        if matches!(bone, HumanoidBone::LeftLowerArm | HumanoidBone::LeftHand) {
            offset = a_pose * offset;
        } else if matches!(bone, HumanoidBone::RightLowerArm | HumanoidBone::RightHand) {
            offset = a_pose.inverse() * offset;
        }
        let position = parent.map_or(Vec3::ZERO, |p| joints[p].position) + offset;
        let rotation = Quat::from_rotation_x(std::f32::consts::FRAC_PI_2) * Quat::from_rotation_y(0.37 * index as f32) * Quat::from_rotation_z(0.11 * index as f32);
        joints.push(Joint { name: MESHY_NAMES[index], parent: *parent, position, rotation });
    }
    rig_spec("meshy-a-pose", &joints, Vec::new())
}

fn load(spec: &RigSpec) -> (Rig, Vec<Clip>) {
    let bytes = spec.glb();
    let rig = import_rig(&bytes).expect("the fixture imports");
    let clips = import_clips(&bytes, &rig).expect("its clips import");
    (rig, clips)
}

/// `clip` on `skeleton` at `time`: its local and model pose.
fn pose_at(skeleton: &Skeleton, clip: &Clip, time: f32) -> (Vec<Trs>, Vec<Mat4>) {
    let mut local = skeleton.rest_pose().to_vec();
    sample(clip, time, Wrap::Loop, &mut SampleCursor::new(), &mut local);
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(&local, &mut model);
    (local, model)
}

fn at(skeleton: &Skeleton, bone: HumanoidBone) -> usize {
    usize::from(HumanoidMap::of(skeleton).joint(bone).expect("mapped").raw())
}

fn position(model: &[Mat4], index: usize) -> Vec3 {
    model[index].w_axis.truncate()
}

/// Times over the cycle: every key and every point between two.
fn cycle() -> impl Iterator<Item = f32> {
    (0..2 * WALK_KEYS).map(|k| k as f32 * WALK_SECONDS / (2 * WALK_KEYS) as f32)
}

#[test]
fn a_ual_walk_on_an_a_pose_meshy_rig_keeps_foot_height_within_2_cm_of_the_leg_scaled_source() {
    let (source, walks) = load(&ual(&UAL_NAMES));
    let (target, _) = load(&meshy());
    let retargeter = Retargeter::new(source.skeleton(), target.skeleton()).expect("both rigs are humanoids");
    assert!((retargeter.leg_ratio() - LEG_RATIO).abs() < 1e-4, "leg ratio {}", retargeter.leg_ratio());
    let walk = retargeter.clip(&walks[0]).expect("the walk retargets");
    assert_eq!(walk.name(), "Walk_Loop");
    assert_eq!(walk.duration(), walks[0].duration());
    let mut worst = 0.0f32;
    for time in cycle() {
        let (_, from) = pose_at(source.skeleton(), &walks[0], time);
        let (_, onto) = pose_at(target.skeleton(), &walk, time);
        for bone in [HumanoidBone::LeftFoot, HumanoidBone::RightFoot, HumanoidBone::LeftToes, HumanoidBone::RightToes] {
            let want = position(&from, at(source.skeleton(), bone)).y * LEG_RATIO;
            let got = position(&onto, at(target.skeleton(), bone)).y;
            worst = worst.max((got - want).abs());
            assert!((got - want).abs() <= 0.02, "t {time}: {bone:?} at {got}, the scaled source at {want}");
        }
    }
    println!("AN-12: worst foot-height gap over the cycle {:.6} m (row: 0.02 m)", worst);
}

/// The worst foot-height gap from the leg-scaled source over the cycle.
fn worst_foot_gap(source: &Rig, from: &Clip, target: &Rig, onto: &Clip) -> f32 {
    let mut worst = 0.0f32;
    for time in cycle() {
        let (_, a) = pose_at(source.skeleton(), from, time);
        let (_, b) = pose_at(target.skeleton(), onto, time);
        for bone in [HumanoidBone::LeftFoot, HumanoidBone::RightFoot] {
            let want = position(&a, at(source.skeleton(), bone)).y * LEG_RATIO;
            worst = worst.max((position(&b, at(target.skeleton(), bone)).y - want).abs());
        }
    }
    worst
}

#[test]
fn the_foot_row_refuses_a_naive_copy_of_local_rotations() {
    // The row is red for the method it guards against: copying each humanoid bone's local
    // rotation keys across ignores the target's rest frames and misses by far more than 2 cm.
    let (source, walks) = load(&ual(&UAL_NAMES));
    let (target, _) = load(&meshy());
    let (from, onto) = (HumanoidMap::of(source.skeleton()), HumanoidMap::of(target.skeleton()));
    let tracks = walks[0]
        .tracks()
        .iter()
        .filter(|track| track.property() == Property::Rotation)
        .filter_map(|track| {
            let bone = HumanoidBone::ALL.into_iter().find(|bone| from.joint(*bone) == Some(track.joint()))?;
            genex_anim::clip::Track::new(onto.joint(bone)?, track.interpolation(), track.times().to_vec(), track.values().clone()).ok()
        })
        .collect();
    let naive = Clip::new("naive", tracks).expect("a clip");
    let gap = worst_foot_gap(&source, &walks[0], &target, &naive);
    assert!(gap > 0.02, "a naive copy misses by {gap} m");
    let walk = Retargeter::new(source.skeleton(), target.skeleton()).expect("humanoids").clip(&walks[0]).expect("retargets");
    assert!(worst_foot_gap(&source, &walks[0], &target, &walk) <= 0.02);
    println!("AN-12: a naive local copy misses the foot row by {gap:.3} m");
}

#[test]
fn the_retargeted_limbs_point_where_the_sources_do_whatever_the_rest_pose() {
    let (source, walks) = load(&ual(&UAL_NAMES));
    let (target, _) = load(&meshy());
    let walk = Retargeter::new(source.skeleton(), target.skeleton()).expect("humanoids").clip(&walks[0]).expect("retargets");
    let limbs = [
        (HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm),
        (HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand),
        (HumanoidBone::RightUpperArm, HumanoidBone::RightLowerArm),
        (HumanoidBone::LeftUpperLeg, HumanoidBone::LeftLowerLeg),
        (HumanoidBone::RightLowerLeg, HumanoidBone::RightFoot),
        (HumanoidBone::Hips, HumanoidBone::Spine),
        (HumanoidBone::LeftFoot, HumanoidBone::LeftToes),
    ];
    for time in cycle() {
        let (_, from) = pose_at(source.skeleton(), &walks[0], time);
        let (_, onto) = pose_at(target.skeleton(), &walk, time);
        for (bone, child) in limbs {
            let direction = |skeleton: &Skeleton, model: &[Mat4]| position(model, at(skeleton, child)) - position(model, at(skeleton, bone));
            let off = direction(source.skeleton(), &from).angle_between(direction(target.skeleton(), &onto)).to_degrees();
            assert!(off < 0.1, "t {time}: {bone:?} is {off}° off the source's");
        }
    }
}

#[test]
fn a_source_missing_left_upper_leg_is_refused_naming_the_bone() {
    let mut names = UAL_NAMES;
    names[14] = "leg_upper_left_unknown";
    let (source, walks) = load(&ual(&names));
    let (target, _) = load(&meshy());
    let refused = Retargeter::new(source.skeleton(), target.skeleton()).expect_err("no LeftUpperLeg in the source");
    assert_eq!(refused.code, AnimationErrorCode::RetargetUnmapped);
    assert_eq!(refused.code.wire(), "animation-retarget-unmapped");
    assert!(refused.detail.contains("LeftUpperLeg") && refused.detail.contains("source"), "{}", refused.detail);
    let refused = retarget_clips(source.skeleton(), &walks, target.skeleton()).expect_err("the batch call too");
    assert_eq!(refused.code, AnimationErrorCode::RetargetUnmapped);
    // The other way round, the target lacks it.
    let refused = Retargeter::new(target.skeleton(), source.skeleton()).expect_err("no LeftUpperLeg in the target");
    assert!(refused.detail.contains("LeftUpperLeg") && refused.detail.contains("target"), "{}", refused.detail);
    // A rig with no humanoid at all names the first bone, the hips.
    let chain = import_rig(&support::chain3().glb()).expect("the chain");
    let refused = Retargeter::new(chain.skeleton(), target.skeleton()).expect_err("not a humanoid");
    assert!(refused.detail.contains("Hips"), "{}", refused.detail);
}

#[test]
fn missing_toes_are_optional() {
    let mut names = UAL_NAMES;
    names[17] = "nub_l";
    names[21] = "nub_r";
    let (source, walks) = load(&ual(&names));
    let (target, _) = load(&meshy());
    let walk = Retargeter::new(source.skeleton(), target.skeleton()).expect("toes are optional").clip(&walks[0]).expect("retargets");
    let (_, onto) = pose_at(target.skeleton(), &walk, 0.25);
    let (_, from) = pose_at(source.skeleton(), &walks[0], 0.25);
    let foot = |skeleton: &Skeleton, model: &[Mat4]| position(model, at(skeleton, HumanoidBone::LeftFoot)).y;
    assert!((foot(target.skeleton(), &onto) - LEG_RATIO * foot(source.skeleton(), &from)).abs() <= 0.02);
}

#[test]
fn retargeting_onto_the_same_rig_is_the_identity_within_1e_6() {
    let (rig, walks) = load(&ual(&UAL_NAMES));
    let skeleton = rig.skeleton();
    let same = retarget_clips(skeleton, &walks, skeleton).expect("a rig onto itself").remove(0);
    let mut worst = 0.0f32;
    for time in cycle() {
        let (want, _) = pose_at(skeleton, &walks[0], time);
        let (got, _) = pose_at(skeleton, &same, time);
        for (joint, (want, got)) in want.iter().zip(&got).enumerate() {
            let turned = same_hemisphere(got.rotation, want.rotation);
            let gaps = [(got.translation - want.translation).abs().max_element(), (glam::Vec4::from(turned) - glam::Vec4::from(want.rotation)).abs().max_element(), (got.scale - want.scale).abs().max_element()];
            let gap = gaps.iter().copied().fold(0.0f32, f32::max);
            worst = worst.max(gap);
            assert!(gap <= 1e-6, "t {time}: joint {joint} ({}) differs by {gap}", skeleton.joints().nth(joint).map_or("", |id| skeleton.name(id)));
        }
    }
    println!("AN-12: same-rig retarget worst component gap {worst:e}");
    // The retargeted clip animates what the source did: rotations of every humanoid bone, the
    // pelvis's translation, nothing's scale.
    assert!(same.tracks().iter().all(|track| track.property() != Property::Scale));
}

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn retargeting_a_clip_takes_at_most_5_ms_recorded() {
    let (source, walks) = load(&ual(&UAL_NAMES));
    let (target, _) = load(&meshy());
    for _ in 0..3 {
        let _ = retarget_clips(source.skeleton(), &walks, target.skeleton());
    }
    const RUNS: u32 = 20;
    let started = std::time::Instant::now();
    for _ in 0..RUNS {
        let clips = retarget_clips(std::hint::black_box(source.skeleton()), std::hint::black_box(&walks), target.skeleton()).expect("retargets");
        assert_eq!(clips.len(), 1);
    }
    let millis = started.elapsed().as_secs_f64() * 1e3 / f64::from(RUNS);
    // Recorded, not asserted: lane timings are advisory (plan 4.4); the budget is 5 ms a clip.
    println!("AN-12 budget: retarget a {WALK_KEYS}-key, 23-joint walk {millis:.3} ms per clip (budget 5 ms)");
}

#[test]
fn a_retarget_replays_bit_for_bit() {
    let (source, walks) = load(&ual(&UAL_NAMES));
    let (target, _) = load(&meshy());
    let a = retarget_clips(source.skeleton(), &walks, target.skeleton()).expect("retargets");
    let b = retarget_clips(source.skeleton(), &walks, target.skeleton()).expect("retargets");
    assert_eq!(a, b);
}
