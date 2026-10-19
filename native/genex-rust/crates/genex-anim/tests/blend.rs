//! AN-4: pose blending, layer masks, additive layers and the humanoid alias table. Additive
//! layers apply `base × delta` (ozz-animation 0.15's order), weights that sum to zero give the
//! rest pose without a NaN, a masked layer leaves the joints outside its mask bit-identical, and
//! every rig family's alias table maps the 22 required humanoid bones on a look-alike rig. The
//! runtime table is held equal to `tests/fixtures/humanoid-aliases.json`, the one table the
//! host's character facts read too.

mod support;

use std::path::PathBuf;

use genex_anim::blend::{BLEND_THRESHOLD, Blender, Layer, additive_delta, apply_additive, apply_override};
use genex_anim::humanoid::{HUMANOID_BONES, HumanoidBone, HumanoidMap, PROFILES, RigProfile};
use genex_anim::import::{Rig, import_rig};
use genex_anim::mask::{BodyPart, JointMask, Mask};
use genex_anim::math::Trs;
use genex_anim::skeleton::Skeleton;
use genex_core::json::{self, Value};
use glam::{Quat, Vec3};
use support::RigSpec;

/// The 22 required bones in `HumanoidBone` order: (parent index, rest offset in metres).
const TOPOLOGY: [(Option<usize>, [f32; 3]); 22] = [
    (None, [0.0, 1.0, 0.0]),
    (Some(0), [0.0, 0.1, 0.0]),
    (Some(1), [0.0, 0.12, 0.0]),
    (Some(2), [0.0, 0.12, 0.0]),
    (Some(3), [0.0, 0.15, 0.0]),
    (Some(4), [0.0, 0.1, 0.0]),
    (Some(3), [0.06, 0.12, 0.0]),
    (Some(6), [0.12, 0.0, 0.0]),
    (Some(7), [0.26, 0.0, 0.0]),
    (Some(8), [0.24, 0.0, 0.0]),
    (Some(3), [-0.06, 0.12, 0.0]),
    (Some(10), [-0.12, 0.0, 0.0]),
    (Some(11), [-0.26, 0.0, 0.0]),
    (Some(12), [-0.24, 0.0, 0.0]),
    (Some(0), [0.09, -0.05, 0.0]),
    (Some(14), [0.0, -0.42, 0.0]),
    (Some(15), [0.0, -0.42, 0.0]),
    (Some(16), [0.0, -0.06, 0.12]),
    (Some(0), [-0.09, -0.05, 0.0]),
    (Some(18), [0.0, -0.42, 0.0]),
    (Some(19), [0.0, -0.42, 0.0]),
    (Some(20), [0.0, -0.06, 0.12]),
];

/// A look-alike of one rig family: its bone names in `HumanoidBone` order as that family's
/// exporter spells them, a wrapper node or root joint above the hips, and extra joints the
/// family adds (end bones, fingers, twist bones) that must not confuse the map.
struct LookAlike {
    profile: RigProfile,
    stem: &'static str,
    names: [&'static str; 22],
    wrapper: Option<&'static str>,
    root_joint: Option<&'static str>,
    extras: &'static [(&'static str, usize)],
}

const LOOK_ALIKES: [LookAlike; 6] = [
    LookAlike {
        profile: RigProfile::Humanoid,
        stem: "godot",
        names: [
            "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head", "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightShoulder", "RightUpperArm",
            "RightLowerArm", "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes", "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
        ],
        wrapper: None,
        root_joint: Some("Root"),
        extras: &[("LeftEye", 5), ("RightEye", 5), ("Jaw", 5)],
    },
    LookAlike {
        profile: RigProfile::Mixamo,
        stem: "mixamorig",
        names: [
            "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:Neck", "mixamorig:Head", "mixamorig:LeftShoulder", "mixamorig:LeftArm",
            "mixamorig:LeftForeArm", "mixamorig:LeftHand", "mixamorig:RightShoulder", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand", "mixamorig:LeftUpLeg",
            "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:LeftToeBase", "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot", "mixamorig:RightToeBase",
        ],
        wrapper: Some("Armature"),
        root_joint: None,
        extras: &[("mixamorig:HeadTop_End", 5), ("mixamorig:LeftHandIndex1", 9), ("mixamorig:LeftToe_End", 17)],
    },
    LookAlike {
        profile: RigProfile::Meshy,
        stem: "meshy",
        names: [
            "Hips", "Spine", "Spine01", "Spine02", "neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand",
            "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
        ],
        wrapper: Some("Armature"),
        root_joint: None,
        extras: &[("head_end", 5), ("headfront", 5), ("LeftToe_End", 17)],
    },
    LookAlike {
        profile: RigProfile::Tripo,
        stem: "tripo",
        names: [
            "Pelvis", "Waist", "Spine01", "Spine02", "NeckTwist01", "Head", "L_Clavicle", "L_Upperarm", "L_Forearm", "L_Hand", "R_Clavicle", "R_Upperarm", "R_Forearm", "R_Hand",
            "L_Thigh", "L_Calf", "L_Foot", "L_ToeBase", "R_Thigh", "R_Calf", "R_Foot", "R_ToeBase",
        ],
        wrapper: None,
        root_joint: Some("Hip"),
        extras: &[("L_UpperarmTwist01", 7), ("R_CalfTwist01", 19)],
    },
    LookAlike {
        profile: RigProfile::Uthana,
        stem: "uthana",
        names: [
            "hips", "spine", "chest", "upper_chest", "neck", "head", "left_shoulder", "left_upper_arm", "left_lower_arm", "left_hand", "right_shoulder", "right_upper_arm",
            "right_lower_arm", "right_hand", "left_upper_leg", "left_lower_leg", "left_foot", "left_toes", "right_upper_leg", "right_lower_leg", "right_foot", "right_toes",
        ],
        wrapper: None,
        root_joint: Some("root"),
        extras: &[("left_index_proximal", 9)],
    },
    LookAlike {
        profile: RigProfile::UeMannequin,
        stem: "ue-mannequin",
        names: [
            "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r",
            "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
        ],
        wrapper: None,
        root_joint: Some("root"),
        extras: &[("ik_foot_root", usize::MAX), ("upperarm_twist_01_l", 7), ("calf_twist_01_r", 19)],
    },
];

/// Quaternius UAL ships the UE mannequin skeleton (its pack says it retargets onto UE's
/// mannequin): UE4's three spine bones and a capitalised `Head`. The `ue-mannequin` table maps
/// it; UE5's five-spine rig maps `spine_05` as the upper chest.
const UAL_NAMES: [&str; 22] = [
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "thigh_l",
    "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
];

/// A rig with `names` on the 22-bone topology, under an optional wrapper node and root joint,
/// with `extras` (name, parent bone; `usize::MAX` hangs it off the root joint).
fn look_alike_rig(stem: &'static str, names: &[&str; 22], wrapper: Option<&str>, root_joint: Option<&str>, extras: &[(&str, usize)]) -> Rig {
    let mut spec = RigSpec::new(stem);
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let wrapper = wrapper.map(|name| spec.node(name, None, [0.0; 3], Quat::IDENTITY, [1.0; 3]));
    let root = root_joint.map(|name| spec.joint(name, wrapper, [0.0; 3], Quat::IDENTITY));
    let mut bones: Vec<usize> = Vec::new();
    for (index, (parent, offset)) in TOPOLOGY.iter().enumerate() {
        let parent = parent.map_or(root.or(wrapper), |p| Some(bones[p]));
        bones.push(spec.joint(names[index], parent, *offset, Quat::IDENTITY));
    }
    for (name, parent) in extras {
        let parent = if *parent == usize::MAX { root.or(wrapper) } else { Some(bones[*parent]) };
        spec.joint(name, parent, [0.0, 0.05, 0.0], Quat::IDENTITY);
    }
    import_rig(&spec.glb()).unwrap_or_else(|error| panic!("{stem}: {error}"))
}

fn assert_maps_every_bone(skeleton: &Skeleton, map: &HumanoidMap, names: &[&str; 22], what: &str) {
    assert!(map.is_complete(), "{what}: unmapped {:?}", map.missing().collect::<Vec<_>>());
    for (bone, name) in HumanoidBone::ALL.iter().zip(names) {
        let joint = map.joint(*bone).unwrap_or_else(|| panic!("{what}: {bone:?} unmapped"));
        assert_eq!(skeleton.name(joint), *name, "{what}: {bone:?}");
    }
}

#[test]
fn each_alias_table_maps_the_22_required_bones_on_its_rig() {
    for look in &LOOK_ALIKES {
        let rig = look_alike_rig(look.stem, &look.names, look.wrapper, look.root_joint, look.extras);
        let skeleton = rig.skeleton();
        let pinned = HumanoidMap::with_profile(skeleton, look.profile);
        assert_maps_every_bone(skeleton, &pinned, &look.names, look.stem);
        let detected = HumanoidMap::of(skeleton);
        assert_eq!(detected.profile(), look.profile, "{}: the detected family", look.stem);
        assert_maps_every_bone(skeleton, &detected, &look.names, look.stem);
    }
    let ual = look_alike_rig("ual", &UAL_NAMES, None, Some("root"), &[("ik_hand_root", usize::MAX)]);
    let map = HumanoidMap::of(ual.skeleton());
    assert_eq!(map.profile(), RigProfile::UeMannequin, "UAL is the UE mannequin skeleton");
    assert_maps_every_bone(ual.skeleton(), &map, &UAL_NAMES, "ual");
}

#[test]
fn the_ue5_mannequin_maps_spine_05_as_the_upper_chest() {
    let mut names = LOOK_ALIKES[5].names;
    names[3] = "spine_05";
    let rig = look_alike_rig("ue5", &names, None, Some("root"), &[("spine_03", 2), ("spine_04", 2)]);
    let map = HumanoidMap::of(rig.skeleton());
    assert_eq!(map.profile(), RigProfile::UeMannequin);
    assert_maps_every_bone(rig.skeleton(), &map, &names, "ue5");
}

#[test]
fn the_fixture_rigs_are_mixamo_humanoids_and_a_chain_is_not() {
    let humanoid = import_rig(&support::humanoid22().glb()).expect("humanoid22");
    let map = HumanoidMap::of(humanoid.skeleton());
    assert_eq!(map.profile(), RigProfile::Mixamo);
    assert!(map.is_complete());
    let mixamo = import_rig(&support::mixamo().glb()).expect("mixamo");
    assert!(HumanoidMap::of(mixamo.skeleton()).is_complete(), "mixamorig: prefixes resolve");
    let chain = import_rig(&support::chain3().glb()).expect("chain3");
    let map = HumanoidMap::of(chain.skeleton());
    assert!(!map.is_complete());
    assert_eq!(map.mapped(), 0, "a three-joint chain has no humanoid bones");
    assert!(Mask::Humanoid(BodyPart::UpperBody).resolve(chain.skeleton(), Some(&map)).is_none(), "no spine, no upper-body mask");
}

/// `tests/fixtures/humanoid-aliases.json` from the repository root.
fn alias_fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/humanoid-aliases.json");
    let text = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    json::parse(&text).expect("the alias table is JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value.items().iter().map(|item| item.as_str().to_owned()).collect()
}

#[test]
fn the_alias_json_is_the_runtime_table() {
    let fixture = alias_fixture();
    let bones: Vec<&str> = HumanoidBone::ALL.iter().map(|bone| bone.name()).collect();
    assert_eq!(strings(&fixture["bones"]), bones, "bone names and order");
    assert_eq!(HUMANOID_BONES, HumanoidBone::ALL.len());
    let profiles = fixture["profiles"].items();
    let ids: Vec<&str> = PROFILES.iter().map(|p| p.profile.wire()).collect();
    let fixture_ids: Vec<&str> = profiles.iter().map(|p| p["id"].as_str()).collect();
    assert_eq!(fixture_ids, ids, "profile ids and order");
    for (profile, pinned) in PROFILES.iter().zip(profiles) {
        for (bone, aliases) in HumanoidBone::ALL.iter().zip(profile.aliases) {
            let fixture_aliases = strings(&pinned["aliases"][bone.name()]);
            assert_eq!(fixture_aliases, *aliases, "{} {}", profile.profile.wire(), bone.name());
        }
    }
}

/// A pose of `count` joints, each joint moved by its index and `seed`.
fn pose(count: usize, seed: f32) -> Vec<Trs> {
    (0..count)
        .map(|index| {
            let k = index as f32 + seed;
            Trs {
                translation: Vec3::new(0.01 * k, 0.5 + 0.02 * k, -0.03 * k),
                rotation: (Quat::from_rotation_x(0.1 * k) * Quat::from_rotation_y(0.07 * k + seed)).normalize(),
                scale: Vec3::splat(1.0 + 0.01 * seed),
            }
        })
        .collect()
}

fn bits(trs: &Trs) -> [u32; 10] {
    let t = trs.translation.to_array();
    let r = trs.rotation.to_array();
    let s = trs.scale.to_array();
    [t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]].map(f32::to_bits)
}

fn quat_close(a: Quat, b: Quat) -> f32 {
    1.0 - a.dot(b).abs()
}

#[test]
fn an_additive_yaw_on_a_pitched_base_is_base_times_delta() {
    let pitch = Quat::from_rotation_x(0.6);
    let yaw = Quat::from_rotation_y(0.8);
    assert!(quat_close(pitch * yaw, yaw * pitch) > 1e-3, "the scenario tells the two orders apart");
    let base = vec![Trs { translation: Vec3::new(1.0, 2.0, 3.0), rotation: pitch, scale: Vec3::splat(2.0) }];
    let delta = vec![Trs { translation: Vec3::new(0.5, 0.0, -1.0), rotation: yaw, scale: Vec3::splat(1.5) }];
    let mut out = base.clone();
    apply_additive(&mut out, &Layer::new(&delta, 1.0));
    assert!(quat_close(out[0].rotation, pitch * yaw) < 1e-6, "base × delta, got {:?}", out[0].rotation);
    assert!(quat_close(out[0].rotation, yaw * pitch) > 1e-4, "not delta × base (pre-0.15 order)");
    assert!((out[0].translation - Vec3::new(1.5, 2.0, 2.0)).length() < 1e-6, "translations add");
    assert!((out[0].scale - Vec3::splat(3.0)).length() < 1e-6, "scales multiply");

    let mut half = base.clone();
    apply_additive(&mut half, &Layer::new(&delta, 0.5));
    let expected = pitch * Quat::from_rotation_y(0.4);
    assert!(quat_close(half[0].rotation, expected) < 1e-3, "half a yaw on the pitch, got {:?}", half[0].rotation);
    assert!((half[0].translation - Vec3::new(1.25, 2.0, 2.5)).length() < 1e-6);
    assert!((half[0].scale - Vec3::splat(2.5)).length() < 1e-6);

    let mut untouched = base.clone();
    apply_additive(&mut untouched, &Layer::new(&delta, 0.0));
    assert_eq!(bits(&untouched[0]), bits(&base[0]), "weight 0 adds nothing");
}

#[test]
fn an_additive_delta_rebuilds_the_pose_from_its_reference() {
    let reference = pose(8, 0.3);
    let target = pose(8, 1.1);
    let mut delta = vec![Trs::IDENTITY; 8];
    additive_delta(&target, &reference, &mut delta);
    let mut rebuilt = reference.clone();
    apply_additive(&mut rebuilt, &Layer::new(&delta, 1.0));
    for (got, want) in rebuilt.iter().zip(&target) {
        assert!(quat_close(got.rotation, want.rotation) < 1e-6);
        assert!((got.translation - want.translation).length() < 1e-5);
        assert!((got.scale - want.scale).length() < 1e-5);
    }
}

#[test]
fn weights_summing_to_zero_give_the_rest_pose_without_a_nan() {
    let rest = pose(12, 0.0);
    let a = pose(12, 1.0);
    let b = pose(12, 2.0);
    let mut out = vec![Trs::IDENTITY; 12];
    let mut blender = Blender::new();
    for weights in [[0.0, 0.0], [-1.0, 0.0], [f32::NAN, 0.0], [0.0, f32::INFINITY], [-0.0, -0.0]] {
        blender.blend(&rest, &[Layer::new(&a, weights[0]), Layer::new(&b, weights[1])], &mut out);
        for (got, want) in out.iter().zip(&rest) {
            assert_eq!(bits(got), bits(want), "weights {weights:?} give the rest pose");
        }
    }
    blender.blend(&rest, &[], &mut out);
    assert!(out.iter().zip(&rest).all(|(got, want)| bits(got) == bits(want)), "no layers give the rest pose");

    blender.blend(&rest, &[Layer::new(&a, BLEND_THRESHOLD * 0.5)], &mut out);
    for ((got, rest), a) in out.iter().zip(&rest).zip(&a) {
        assert!(got.is_finite());
        let halfway = (rest.translation + a.translation) * 0.5;
        assert!((got.translation - halfway).length() < 1e-5, "under the threshold the rest pose fills the remainder");
    }
}

#[test]
fn one_layer_alone_is_copied_and_two_layers_normalize() {
    let rest = pose(6, 0.0);
    let a = pose(6, 1.0);
    let b = pose(6, 3.0);
    let mut out = vec![Trs::IDENTITY; 6];
    let mut blender = Blender::new();
    blender.blend(&rest, &[Layer::new(&a, 0.37)], &mut out);
    assert!(out.iter().zip(&a).all(|(got, want)| bits(got) == bits(want)), "one layer over the threshold is that layer");
    blender.blend(&rest, &[Layer::new(&a, 1.0), Layer::new(&b, 3.0)], &mut out);
    for ((got, a), b) in out.iter().zip(&a).zip(&b) {
        let want = a.translation * 0.25 + b.translation * 0.75;
        assert!((got.translation - want).length() < 1e-5, "weights normalize");
        assert!((got.rotation.length() - 1.0).abs() < 1e-5, "rotations come out unit length");
    }
    let flipped: Vec<Trs> = a.iter().map(|t| Trs { rotation: -t.rotation, ..*t }).collect();
    blender.blend(&rest, &[Layer::new(&a, 1.0), Layer::new(&flipped, 1.0)], &mut out);
    for (got, a) in out.iter().zip(&a) {
        assert!(quat_close(got.rotation, a.rotation) < 1e-6, "q and -q blend to q, not to zero");
    }
}

/// The humanoid22 fixture's skeleton with its map, a base pose and an upper-body pose.
fn humanoid() -> (Rig, HumanoidMap) {
    let rig = import_rig(&support::humanoid22().glb()).expect("humanoid22");
    let map = HumanoidMap::of(rig.skeleton());
    (rig, map)
}

const LEG_BONES: [HumanoidBone; 9] = [
    HumanoidBone::Hips,
    HumanoidBone::LeftUpperLeg,
    HumanoidBone::LeftLowerLeg,
    HumanoidBone::LeftFoot,
    HumanoidBone::LeftToes,
    HumanoidBone::RightUpperLeg,
    HumanoidBone::RightLowerLeg,
    HumanoidBone::RightFoot,
    HumanoidBone::RightToes,
];

#[test]
fn an_upper_body_mask_leaves_the_leg_joints_bit_identical() {
    let (rig, map) = humanoid();
    let skeleton = rig.skeleton();
    let count = skeleton.joint_count();
    let upper = Mask::Humanoid(BodyPart::UpperBody).resolve(skeleton, Some(&map)).expect("an upper-body mask");
    let legs: Vec<usize> = LEG_BONES.iter().map(|bone| usize::from(map.joint(*bone).expect("a leg bone").raw())).collect();
    for bone in LEG_BONES {
        assert_eq!(upper.weight(map.joint(bone).expect("a leg bone")), 0.0, "the upper body holds no leg joint");
    }
    let rest = skeleton.rest_pose().to_vec();
    let base = pose(count, 1.0);
    let wave = pose(count, 4.0);
    let mut out = vec![Trs::IDENTITY; count];
    let mut blender = Blender::new();
    blender.blend(&rest, &[Layer::new(&base, 1.0), Layer::new(&wave, 1.0).masked(&upper)], &mut out);
    for leg in &legs {
        assert_eq!(bits(&out[*leg]), bits(&base[*leg]), "blend: leg joint {leg}");
    }
    let spine = usize::from(map.joint(HumanoidBone::Chest).expect("chest").raw());
    assert_ne!(bits(&out[spine]), bits(&base[spine]), "the upper body does blend");

    let mut overridden = base.clone();
    apply_override(&mut overridden, &Layer::new(&wave, 0.6).masked(&upper));
    let mut added = base.clone();
    apply_additive(&mut added, &Layer::new(&wave, 0.6).masked(&upper));
    for leg in &legs {
        assert_eq!(bits(&overridden[*leg]), bits(&base[*leg]), "override: leg joint {leg}");
        assert_eq!(bits(&added[*leg]), bits(&base[*leg]), "additive: leg joint {leg}");
    }
    let mut full = base.clone();
    apply_override(&mut full, &Layer::new(&wave, 1.0).masked(&upper));
    assert_eq!(bits(&full[spine]), bits(&wave[spine]), "a full-weight override copies the layer");
}

#[test]
fn body_parts_are_the_subtrees_the_humanoid_map_names() {
    let (rig, map) = humanoid();
    let skeleton = rig.skeleton();
    let joint = |bone: HumanoidBone| map.joint(bone).expect("mapped");
    let resolve = |part: BodyPart| Mask::Humanoid(part).resolve(skeleton, Some(&map)).expect("a mask");
    let upper = resolve(BodyPart::UpperBody);
    let lower = resolve(BodyPart::LowerBody);
    for id in skeleton.joints() {
        assert_eq!(upper.weight(id) + lower.weight(id), 1.0, "upper and lower body split every joint");
    }
    let head = resolve(BodyPart::Head);
    assert_eq!(head.weight(joint(HumanoidBone::Head)), 1.0);
    assert_eq!(head.weight(joint(HumanoidBone::Neck)), 1.0);
    assert_eq!(head.weight(joint(HumanoidBone::LeftHand)), 0.0);
    let left_arm = resolve(BodyPart::LeftArm);
    assert_eq!(left_arm.weight(joint(HumanoidBone::LeftHand)), 1.0);
    assert_eq!(left_arm.weight(joint(HumanoidBone::RightHand)), 0.0);
    let right_leg = resolve(BodyPart::RightLeg);
    assert_eq!(right_leg.weight(joint(HumanoidBone::RightToes)), 1.0);
    assert_eq!(right_leg.weight(joint(HumanoidBone::Hips)), 0.0);
    assert_eq!(resolve(BodyPart::LeftArm).count() + resolve(BodyPart::RightArm).count(), 8);

    let all = Mask::All.resolve(skeleton, None).expect("all");
    assert_eq!(all.count(), skeleton.joint_count());
    let named = Mask::Joints(vec![joint(HumanoidBone::LeftLowerLeg)]).resolve(skeleton, None).expect("a joint subtree");
    assert_eq!(named.count(), 3, "lower leg, foot and toes");
    assert!(Mask::Humanoid(BodyPart::Head).resolve(skeleton, None).is_none(), "a body part needs a humanoid map");
    let tree = import_rig(&support::tree("tree60", 60).glb()).expect("tree60");
    let far = tree.skeleton().joints().last().expect("a joint");
    assert!(Mask::Joints(vec![far]).resolve(skeleton, None).is_none(), "a joint past this skeleton");
    let inverted: JointMask = upper.inverted();
    assert_eq!(inverted, lower);
}

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn blending_three_poses_of_sixty_joints_fits_the_budget() {
    let rest = pose(60, 0.0);
    let poses = [pose(60, 1.0), pose(60, 2.0), pose(60, 3.0)];
    let layers = [Layer::new(&poses[0], 0.5), Layer::new(&poses[1], 0.3), Layer::new(&poses[2], 0.2)];
    let mut out = vec![Trs::IDENTITY; 60];
    let mut blender = Blender::new();
    for _ in 0..1_000 {
        blender.blend(&rest, &layers, &mut out);
    }
    const RUNS: u32 = 20_000;
    let started = std::time::Instant::now();
    for _ in 0..RUNS {
        blender.blend(std::hint::black_box(&rest), std::hint::black_box(&layers), &mut out);
    }
    let micros = started.elapsed().as_secs_f64() * 1e6 / f64::from(RUNS);
    // Recorded, not asserted: lane timings are advisory (plan 4.4); the budget is 3 µs.
    println!("AN-4 budget: 3-pose 60-joint blend {micros:.3} µs (budget 3 µs)");
    assert!(out.iter().all(Trs::is_finite));
}
