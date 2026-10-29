//! Track A: a generated character's rig and clips are checked before a game plays them. The
//! fixture is the 22-bone humanoid in a T pose; each clip below is built to be one body-cam-6
//! failure (a folded torso, knotted arms, a stretched forearm, feet off the floor, hands that
//! cannot hold one rifle) or a clean motion that must not be flagged. Weapon sockets and the
//! two-handed hold are tested on the same rig.

mod support;

use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::clip_set::{ClipRole, ClipSet};
use genex_anim::humanoid::{HumanoidBone, HumanoidMap};
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use genex_anim::pose_check::{PoseCause, PoseCheck, PoseCode, PoseDiagnostic};
use genex_anim::weapon::{HOLD_TOLERANCE, WeaponHold, WeaponSockets, hold_weapon};
use glam::{Mat4, Quat, Vec3};
use std::f32::consts::{FRAC_PI_2, PI};

fn rig() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

/// A rotation clip on `joint`: the rest rotation turned by `turn(t)` in the joint's own frame.
fn turning(rig: &Rig, name: &str, joint: &str, turn: impl Fn(f32) -> Quat) -> Clip {
    let id = rig.skeleton().find(joint).unwrap_or_else(|| panic!("joint {joint}"));
    let rest = rig.skeleton().rest_pose()[usize::from(id.raw())].rotation;
    let times = vec![0.0, 0.5, 1.0];
    let values = times.iter().map(|t| rest * turn(*t)).collect();
    let track = Track::new(id, Interpolation::Linear, times, TrackValues::Rotation(values)).expect("a track");
    Clip::new(name, vec![track]).expect("a clip")
}

/// Several joints' turns in one clip.
fn posed(rig: &Rig, name: &str, turns: &[(&str, Quat)]) -> Clip {
    let tracks = turns
        .iter()
        .map(|(joint, turn)| {
            let id = rig.skeleton().find(joint).unwrap_or_else(|| panic!("joint {joint}"));
            let rest = rig.skeleton().rest_pose()[usize::from(id.raw())].rotation;
            Track::new(id, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Rotation(vec![rest * *turn, rest * *turn])).expect("a track")
        })
        .collect();
    Clip::new(name, tracks).expect("a clip")
}

fn lifted(rig: &Rig, name: &str, by: f32) -> Clip {
    let hips = rig.skeleton().find("Hips").expect("hips");
    let rest = rig.skeleton().rest_pose()[usize::from(hips.raw())].translation;
    let track = Track::new(hips, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Translation(vec![rest + Vec3::Y * by, rest + Vec3::Y * by])).expect("a track");
    Clip::new(name, vec![track]).expect("a clip")
}

fn found(diagnostics: &[PoseDiagnostic], code: PoseCode) -> Option<&PoseDiagnostic> {
    diagnostics.iter().find(|d| d.code == code)
}

#[test]
fn the_rest_rig_is_a_whole_body() {
    let rig = rig();
    let check = PoseCheck::new(rig.skeleton());
    assert!(check.map().is_complete());
    assert_eq!(check.check_rig(), vec![], "a T-posed humanoid has nothing to fix");
}

#[test]
fn a_clean_walk_passes_and_every_defect_names_its_code() {
    let rig = rig();
    let check = PoseCheck::new(rig.skeleton());
    let swing = |sign: f32| move |t: f32| Quat::from_rotation_x(sign * 0.6 * (t - 0.5));
    let walk = turning(&rig, "Walk", "LeftUpLeg", swing(1.0));
    assert_eq!(check.check_clip(&walk, Some(ClipRole::Walk)), vec![], "a leg swing keeps the body");

    let stretched = {
        let id = rig.skeleton().find("LeftForeArm").expect("joint");
        let track = Track::new(id, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Scale(vec![Vec3::splat(1.5); 2])).expect("a track");
        Clip::new("Stretch", vec![track]).expect("a clip")
    };
    let diagnostics = check.check_clip(&stretched, None);
    let stretch = found(&diagnostics, PoseCode::LimbStretch).expect("a forearm 1.5 times as long is refused");
    assert_eq!(stretch.bone, Some(HumanoidBone::LeftHand));
    assert!(stretch.value > 1.4, "the ratio is reported: {}", stretch.value);
    assert_eq!(stretch.cause, PoseCause::BoneMismatch);

    let folded = posed(&rig, "Fold", &[("Spine1", Quat::from_rotation_x(2.4)), ("Spine2", Quat::from_rotation_x(2.4))]);
    let collapse = found(&check.check_clip(&folded, None), PoseCode::TorsoCollapse).cloned().expect("a spine folded in half collapses the torso");
    assert!(collapse.value < collapse.limit, "{collapse:?}");

    let knotted = posed(&rig, "Knot", &[("LeftForeArm", Quat::from_rotation_z(PI * 0.95))]);
    assert!(found(&check.check_clip(&knotted, None), PoseCode::LimbsKnotted).is_some(), "an elbow folded shut is a knot");

    assert!(found(&check.check_clip(&lifted(&rig, "Float", 0.4), Some(ClipRole::Idle)), PoseCode::FeetFloating).is_some());
    assert!(found(&check.check_clip(&lifted(&rig, "Sink", -0.4), Some(ClipRole::Idle)), PoseCode::FeetSunk).is_some());
    assert_eq!(found(&check.check_clip(&lifted(&rig, "Fall", 0.4), Some(ClipRole::Death)), PoseCode::FeetFloating), None, "a death may leave the floor");
}

/// Both arms pointing forward, as a rifle is held.
fn arms_forward(rig: &Rig, name: &str) -> Clip {
    posed(rig, name, &[("LeftArm", Quat::from_rotation_y(-FRAC_PI_2)), ("RightArm", Quat::from_rotation_y(FRAC_PI_2))])
}

#[test]
fn hands_must_be_able_to_hold_one_weapon_in_a_two_handed_clip() {
    let rig = rig();
    let check = PoseCheck::new(rig.skeleton());
    let held = arms_forward(&rig, "Aim");
    assert_eq!(check.check_clip(&held, Some(ClipRole::Aim)), vec![]);
    let spread = posed(&rig, "Aim", &[]);
    let off = check.check_clip(&spread, Some(ClipRole::Aim));
    let off = found(&off, PoseCode::HandsOffWeapon).expect("hands a body's width apart hold no rifle");
    assert!(off.value > off.limit);
    assert_eq!(off.role, Some(ClipRole::Aim));
    assert_eq!(check.check_clip(&spread, Some(ClipRole::Walk)), vec![], "a walking T pose is not holding anything");
}

#[test]
fn a_character_is_reported_by_role_with_the_missing_ones_named() {
    let rig = rig();
    let check = PoseCheck::new(rig.skeleton());
    let walk = turning(&rig, "Armature|Walk", "LeftUpLeg", |t| Quat::from_rotation_x(0.2 * t));
    let idle = lifted(&rig, "Idle_Rifle", 0.0);
    let report = check.check(&[walk, idle]);
    assert_eq!(report.set.clip(ClipRole::Walk), Some(0));
    assert_eq!(report.set.clip(ClipRole::Idle), Some(1));
    let missing: Vec<ClipRole> = report.diagnostics.iter().filter(|d| d.code == PoseCode::ClipRoleMissing).filter_map(|d| d.role).collect();
    assert_eq!(missing, vec![ClipRole::Run, ClipRole::Crouch, ClipRole::Aim, ClipRole::Fire, ClipRole::Reload, ClipRole::Hit, ClipRole::Death]);
    assert!(!report.pass());
}

#[test]
fn clip_names_map_to_roles_specific_first() {
    let rig = rig();
    let names = ["mixamo.com|Crouch Walk", "Rifle Aim Idle", "Run_01", "Walk_Fwd", "Idle", "Shoot", "Reload Mag", "Hit React", "Death Back"];
    let clips: Vec<Clip> = names.iter().map(|name| lifted(&rig, name, 0.0)).collect();
    let set = ClipSet::of(&clips);
    let role = |index| set.role_of(index);
    assert_eq!(role(0), Some(ClipRole::Crouch), "a crouch walk is a crouch");
    assert_eq!(role(1), Some(ClipRole::Aim), "an aim idle is an aim");
    assert_eq!(role(2), Some(ClipRole::Run));
    assert_eq!(role(3), Some(ClipRole::Walk));
    assert_eq!(role(4), Some(ClipRole::Idle));
    assert_eq!(role(5), Some(ClipRole::Fire));
    assert_eq!(role(6), Some(ClipRole::Reload));
    assert_eq!(role(7), Some(ClipRole::Hit));
    assert_eq!(role(8), Some(ClipRole::Death));
    assert_eq!(set.missing().count(), 0);
}

fn rest_pose(rig: &Rig) -> (Vec<Trs>, Vec<Mat4>) {
    let pose = rig.skeleton().rest_pose().to_vec();
    let mut model = vec![Mat4::IDENTITY; pose.len()];
    rig.skeleton().local_to_model(&pose, &mut model);
    (pose, model)
}

#[test]
fn a_two_handed_hold_lands_both_grips_on_the_weapon_and_never_breaks_the_arms() {
    let rig = rig();
    let skeleton = rig.skeleton();
    let sockets = WeaponSockets::of(skeleton, &HumanoidMap::of(skeleton)).expect("a humanoid has hands");
    let (mut pose, mut model) = rest_pose(&rig);
    let chest = model[usize::from(skeleton.find("Spine2").expect("chest").raw())].w_axis.truncate();
    let primary = chest + Vec3::new(-0.1, -0.05, 0.25);
    let support = chest + Vec3::new(0.1, -0.05, 0.38);
    let lengths = |model: &[Mat4]| {
        ["LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand"].map(|name| model[usize::from(skeleton.find(name).expect("joint").raw())].w_axis.truncate())
    };
    let before = lengths(&model);
    let held = hold_weapon(skeleton, &sockets, &WeaponHold { primary, support, weight: 1.0 }, &mut pose, &mut model);
    assert!(held.primary && held.support, "{held:?}");
    assert!(sockets.primary.position(&model).expect("grip").distance(primary) <= HOLD_TOLERANCE);
    assert!(sockets.support.position(&model).expect("grip").distance(support) <= HOLD_TOLERANCE);
    let after = lengths(&model);
    for (arm, (a, b)) in [(0, 1), (1, 2), (3, 4), (4, 5)].into_iter().enumerate() {
        let (was, is) = (before[a].distance(before[b]), after[a].distance(after[b]));
        assert!((was - is).abs() < 1e-3, "segment {arm} keeps its length: {was} -> {is}");
    }

    // A weapon out of reach: no NaN, no claim of success.
    let (mut pose, mut model) = rest_pose(&rig);
    let far = WeaponHold { primary: Vec3::new(0.0, 1.5, 6.0), support: Vec3::new(0.0, 1.5, 6.3), weight: 1.0 };
    let result = hold_weapon(skeleton, &sockets, &far, &mut pose, &mut model);
    assert!(!result.primary && !result.support);
    assert!(model.iter().all(|m| m.is_finite()));
}

#[test]
fn an_animator_can_be_aimed_at_the_weapon_through_its_arm_targets() {
    use genex_anim::animator::Limb;
    let rig = rig();
    let skeleton = rig.skeleton();
    let sockets = WeaponSockets::of(skeleton, &HumanoidMap::of(skeleton)).expect("a humanoid has hands");
    let (_, model) = rest_pose(&rig);
    let hold = WeaponHold { primary: Vec3::new(-0.1, 1.3, 0.3), support: Vec3::new(0.1, 1.3, 0.5), weight: 1.0 };
    let [(first, right), (second, left)] = sockets.limb_targets(&model, &hold).expect("targets");
    assert_eq!((first, second), (Limb::RightArm, Limb::LeftArm));
    let moved = |socket: &genex_anim::weapon::Socket, target: Vec3, goal: Vec3| {
        let hand = model[usize::from(socket.joint.raw())].w_axis.truncate();
        (target - hand).distance(goal - socket.position(&model).expect("grip"))
    };
    assert!(moved(&sockets.primary, right.target, hold.primary) < 1e-5);
    assert!(moved(&sockets.support, left.target, hold.support) < 1e-5);
    assert!(right.pole.is_finite() && left.pole.is_finite());
}
