//! AN-11: foot placement on slopes and foot locking. On a 20° slope the planted sole stays within
//! 1 cm of the ground and the foot turns to the normal (clamped to 30° on a steeper one); the
//! pelvis drops by the lower foot's offset, never the higher one's; a locked foot slides at most
//! 1 mm while the hips move, and lets go past the unlock radius without a jump; a ground probe
//! that finds nothing leaves the pose unchanged, bit for bit; planting samples at most
//! [`PLANT_JOINTS_MAX`] joints; a height function (a terrain's `height`) and, with `physics`, a
//! Rapier ray plant the same feet as an exact plane; and the placer's state replays and restores
//! bit for bit.
//!
//! Every row is new behaviour (section 0 of the game systems plan): the module was a stub.

mod support;

use genex_anim::character::GroundHit;
use genex_anim::foot::{ANKLE_CONTACT_BAND, Foot, FootPlacer, FootPlan, FootRig, FootSettings, MAX_FOOT_TILT, PLANT_JOINTS_MAX, apply_plan, height_ground};
use genex_anim::humanoid::{HumanoidBone, HumanoidMap};
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use genex_anim::skeleton::Skeleton;
use genex_anim::AnimationErrorCode;
use glam::{Mat4, Quat, Vec3};
use support::RigSpec;

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

/// `sin` and `cos` through glam's libm (the platform's are not the same bits everywhere).
fn sin(x: f32) -> f32 {
    glam::Vec2::from_angle(x).y
}

fn cos(x: f32) -> f32 {
    glam::Vec2::from_angle(x).x
}

/// The UE mannequin's (and Quaternius UAL's) leg and spine joints, knees bent: thigh -0.3 rad,
/// calf +0.6, foot -0.3 about X, so the ankle stands under the hip and the foot lies flat.
fn ual_rig() -> Rig {
    let mut spec = RigSpec::new("ual-legs");
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let root = spec.joint("root", None, [0.0; 3], Quat::IDENTITY);
    let pelvis = spec.joint("pelvis", Some(root), [0.0, 0.95, 0.0], Quat::IDENTITY);
    let spine = spec.joint("spine_01", Some(pelvis), [0.0, 0.1, 0.0], Quat::IDENTITY);
    let spine2 = spec.joint("spine_02", Some(spine), [0.0, 0.12, 0.0], Quat::IDENTITY);
    let spine3 = spec.joint("spine_03", Some(spine2), [0.0, 0.12, 0.0], Quat::IDENTITY);
    let neck = spec.joint("neck_01", Some(spine3), [0.0, 0.15, 0.0], Quat::IDENTITY);
    spec.joint("head", Some(neck), [0.0, 0.1, 0.0], Quat::IDENTITY);
    for (side, x) in [("l", 1.0), ("r", -1.0)] {
        let clavicle = spec.joint(&format!("clavicle_{side}"), Some(spine3), [0.06 * x, 0.12, 0.0], Quat::IDENTITY);
        let upper = spec.joint(&format!("upperarm_{side}"), Some(clavicle), [0.12 * x, 0.0, 0.0], Quat::IDENTITY);
        let lower = spec.joint(&format!("lowerarm_{side}"), Some(upper), [0.26 * x, 0.0, 0.0], Quat::IDENTITY);
        spec.joint(&format!("hand_{side}"), Some(lower), [0.24 * x, 0.0, 0.0], Quat::IDENTITY);
    }
    for (side, x) in [("l", 1.0), ("r", -1.0)] {
        let thigh = spec.joint(&format!("thigh_{side}"), Some(pelvis), [0.09 * x, -0.05, 0.0], Quat::from_rotation_x(-0.3));
        let calf = spec.joint(&format!("calf_{side}"), Some(thigh), [0.0, -0.42, 0.0], Quat::from_rotation_x(0.6));
        let foot = spec.joint(&format!("foot_{side}"), Some(calf), [0.0, -0.42, 0.0], Quat::from_rotation_x(-0.3));
        spec.joint(&format!("ball_{side}"), Some(foot), [0.0, -0.06, 0.12], Quat::IDENTITY);
    }
    import_rig(&spec.glb()).expect("the UAL legs import")
}

/// A Mixamo rig (the "Armature" frame at 0.01, centimetre joints): the hips are the root.
fn mixamo_rig() -> Rig {
    import_rig(&support::mixamo().glb()).expect("the Mixamo fixture imports")
}

fn foot_rig(skeleton: &Skeleton) -> FootRig {
    FootRig::of(skeleton, &HumanoidMap::of(skeleton)).expect("a humanoid's legs")
}

fn joint(skeleton: &Skeleton, bone: HumanoidBone) -> usize {
    usize::from(HumanoidMap::of(skeleton).joint(bone).expect("mapped").raw())
}

/// A plane through `point` with unit `normal`, as a ground probe: where the segment from `from`
/// to `to` meets it.
fn plane(point: Vec3, normal: Vec3) -> impl FnMut(Vec3, Vec3) -> Option<GroundHit> {
    move |from: Vec3, to: Vec3| {
        let span = to - from;
        let along = span.dot(normal);
        if along.abs() <= f32::EPSILON {
            return None;
        }
        let t = (point - from).dot(normal) / along;
        (0.0..=1.0).contains(&t).then(|| GroundHit { point: from + span * t, normal })
    }
}

/// A slope of `degrees` rising toward +X through the origin: its unit normal.
fn slope_normal(degrees: f32) -> Vec3 {
    let angle = degrees.to_radians();
    Vec3::new(-sin(angle), cos(angle), 0.0)
}

fn model_of(skeleton: &Skeleton, pose: &[Trs]) -> Vec<Mat4> {
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(pose, &mut model);
    model
}

/// `pose` with `plan` applied, and its model matrices: the evaluation's step 6 then its final
/// local-to-model.
fn planted(skeleton: &Skeleton, rig: &FootRig, plan: &FootPlan, pose: &[Trs]) -> (Vec<Trs>, Vec<Mat4>) {
    let mut local = pose.to_vec();
    let mut model = model_of(skeleton, &local);
    if apply_plan(skeleton, rig, plan, &mut local, &mut model) {
        skeleton.local_to_model(&local, &mut model);
    }
    (local, model)
}

fn position(model: &[Mat4], index: usize) -> Vec3 {
    model[index].w_axis.truncate()
}

fn rotation(model: &[Mat4], index: usize) -> Quat {
    model[index].to_scale_rotation_translation().1
}

/// The angle between two vectors, through glam's libm.
fn angle(a: Vec3, b: Vec3) -> f32 {
    a.angle_between(b)
}

#[test]
fn on_a_20_degree_slope_the_planted_sole_is_within_1_cm_of_the_ground_and_turns_to_the_normal() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let normal = slope_normal(20.0);
    let mut placer = FootPlacer::new(FootSettings::default());
    let plan = placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, normal));
    assert!(plan.feet.iter().all(Option::is_some), "both feet found the slope: {plan:?}");
    let before = model_of(skeleton, &rest);
    let (_, after) = planted(skeleton, &feet, &plan, &rest);
    for (foot, bone) in [(Foot::Left, HumanoidBone::LeftFoot), (Foot::Right, HumanoidBone::RightFoot)] {
        let ankle = joint(skeleton, bone);
        let height = feet.ankle_height(foot);
        assert!((height - 0.0975).abs() < 1e-4, "the rest ankle stands {height} m over its sole");
        // The foot's own up axis, turned as the placement turned it.
        let turn = rotation(&after, ankle) * rotation(&before, ankle).inverse();
        let up = turn * Vec3::Y;
        let sole = position(&after, ankle) - up * height;
        let gap = sole.dot(normal);
        assert!(gap.abs() <= 0.01, "{foot:?}: the sole is {gap} m off the slope");
        let off = angle(up, normal).to_degrees();
        assert!(off <= 0.5, "{foot:?}: the foot is {off}° off the slope's normal");
    }
}

#[test]
fn a_40_degree_slope_turns_the_foot_by_30_degrees_at_most() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let mut placer = FootPlacer::new(FootSettings::default());
    let plan = placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, slope_normal(40.0)));
    let before = model_of(skeleton, &rest);
    let (_, after) = planted(skeleton, &feet, &plan, &rest);
    assert!((MAX_FOOT_TILT.to_degrees() - 30.0).abs() < 1e-4);
    for bone in [HumanoidBone::LeftFoot, HumanoidBone::RightFoot] {
        let ankle = joint(skeleton, bone);
        let turn = rotation(&after, ankle) * rotation(&before, ankle).inverse();
        let tilt = angle(turn * Vec3::Y, Vec3::Y).to_degrees();
        assert!((tilt - 30.0).abs() < 0.05, "{bone:?} turned {tilt}°, clamped to 30°");
    }
}

#[test]
fn the_pelvis_drops_by_the_lower_foots_offset_and_never_the_higher_ones() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let normal = slope_normal(20.0);
    let mut placer = FootPlacer::new(FootSettings::default());
    let plan = placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, normal));
    let before = model_of(skeleton, &rest);
    let (_, after) = planted(skeleton, &feet, &plan, &rest);
    // Each foot's own offset: its goal's height over the animated ankle.
    let offset = |foot: Foot, bone: HumanoidBone| plan.feet[foot.index()].expect("a goal").ankle.y - position(&before, joint(skeleton, bone)).y;
    let (left, right) = (offset(Foot::Left, HumanoidBone::LeftFoot), offset(Foot::Right, HumanoidBone::RightFoot));
    assert!(left > 0.0 && right < 0.0, "up the slope the left foot rises ({left}), the right sinks ({right})");
    let hips = joint(skeleton, HumanoidBone::Hips);
    let dropped = position(&after, hips).y - position(&before, hips).y;
    assert!((dropped - right).abs() < 1e-5, "the pelvis moved {dropped}, the lower foot's offset is {right}");
    assert!((dropped - left).abs() > 0.01, "and not the higher foot's {left}");
    assert_eq!(plan.pelvis.x, 0.0);
    assert_eq!(plan.pelvis.z, 0.0);
    // Both feet still reach their goals from the lowered pelvis.
    for (foot, bone) in [(Foot::Left, HumanoidBone::LeftFoot), (Foot::Right, HumanoidBone::RightFoot)] {
        let reached = (position(&after, joint(skeleton, bone)) - plan.feet[foot.index()].expect("a goal").ankle).length();
        assert!(reached < 1e-4, "{foot:?} is {reached} m from its goal");
    }
}

#[test]
fn a_locked_foot_slides_at_most_1_mm_while_the_hips_move() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let mut placer = FootPlacer::new(FootSettings::default());
    let ankle = joint(skeleton, HumanoidBone::LeftFoot);
    let hips = joint(skeleton, HumanoidBone::Hips);
    let mut start = None;
    let mut hips_start = None;
    for tick in 0..7 {
        // The character moves 1 cm a tick while its animation stands still: unlocked, the foot
        // would slide with it.
        let place = Mat4::from_translation(Vec3::new(0.0, 0.0, 0.01 * tick as f32));
        let plan = placer.plant(&feet, &rest, place, [true, true], TICK, plane(Vec3::ZERO, Vec3::Y));
        assert!(placer.is_locked(Foot::Left) && placer.is_locked(Foot::Right), "tick {tick}: both feet lock on contact");
        let (_, model) = planted(skeleton, &feet, &plan, &rest);
        let world = place.transform_point3(position(&model, ankle));
        let hip = place.transform_point3(position(&model, hips));
        let first = *start.get_or_insert(world);
        let first_hip = *hips_start.get_or_insert(hip);
        let slid = (world - first).length();
        assert!(slid <= 1e-3, "tick {tick}: the locked foot slid {slid} m");
        if tick == 6 {
            assert!((hip - first_hip).length() >= 0.059, "the hips moved {}", (hip - first_hip).length());
        }
    }
}

#[test]
fn a_lock_lets_go_past_the_unlock_radius_and_the_foot_eases_back_without_a_jump() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let settings = FootSettings::default();
    let mut placer = FootPlacer::new(settings);
    let mut last: Option<Vec3> = None;
    let mut unlocked_at = None;
    for tick in 0..80 {
        let place = Mat4::from_translation(Vec3::new(0.0, 0.0, 0.02 * tick.min(15) as f32));
        let plan = placer.plant(&feet, &rest, place, [true, true], TICK, plane(Vec3::ZERO, Vec3::Y));
        let goal = place.transform_point3(plan.feet[Foot::Left.index()].expect("a goal").ankle);
        if let Some(previous) = last {
            let step = (goal - previous).length();
            assert!(step <= 0.05, "tick {tick}: the goal jumped {step} m");
        }
        last = Some(goal);
        if unlocked_at.is_none() && !placer.is_locked(Foot::Left) {
            unlocked_at = Some(tick);
        }
    }
    let unlocked = unlocked_at.expect("the lock lets go");
    // 2 cm a tick: past the 0.2 m radius on the 11th tick.
    assert!((10..=12).contains(&unlocked), "let go at tick {unlocked} (radius {})", settings.unlock_radius);
    // Long after, the unlocked foot is back on the animation.
    let place = Mat4::from_translation(Vec3::new(0.0, 0.0, 0.3));
    let plan = placer.plant(&feet, &rest, place, [true, true], TICK, plane(Vec3::ZERO, Vec3::Y));
    let animated = place.transform_point3(position(&model_of(skeleton, &rest), joint(skeleton, HumanoidBone::LeftFoot)));
    let back = (place.transform_point3(plan.feet[Foot::Left.index()].expect("a goal").ankle) - animated).length();
    assert!(back < 1e-3, "the foot is {back} m from the animation");
}

#[test]
fn a_ground_probe_that_finds_nothing_leaves_the_pose_unchanged_bit_for_bit() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let mut placer = FootPlacer::new(FootSettings::default());
    // Locked first, then the ground goes away: the lock is dropped and nothing moves.
    placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, Vec3::Y));
    let plan = placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, |_, _| None);
    assert_eq!(plan, FootPlan::NONE);
    assert!(!placer.is_locked(Foot::Left) && !placer.is_locked(Foot::Right));
    let mut local = rest.clone();
    let mut model = model_of(skeleton, &local);
    let want = model.clone();
    assert!(!apply_plan(skeleton, &feet, &plan, &mut local, &mut model));
    let bits = |pose: &[Trs]| pose.iter().flat_map(|t| t.translation.to_array().into_iter().chain(t.rotation.to_array()).chain(t.scale.to_array())).map(f32::to_bits).collect::<Vec<_>>();
    assert_eq!(bits(&local), bits(&rest));
    assert_eq!(model, want);
    // A probe that answers garbage (a NaN point, a zero or downward normal) counts as nothing.
    let hostile: [GroundHit; 3] = [
        GroundHit { point: Vec3::NAN, normal: Vec3::Y },
        GroundHit { point: Vec3::ZERO, normal: Vec3::ZERO },
        GroundHit { point: Vec3::ZERO, normal: Vec3::NEG_Y },
    ];
    for hit in hostile {
        let plan = placer.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, |_, _| Some(hit));
        assert_eq!(plan, FootPlan::NONE, "{hit:?}");
    }
    // A character transform that is not finite plants nothing either.
    let plan = placer.plant(&feet, &rest, Mat4::from_scale(Vec3::ZERO), [true, true], TICK, plane(Vec3::ZERO, Vec3::Y));
    assert_eq!(plan, FootPlan::NONE);
}

#[test]
fn planting_samples_only_the_leg_chains_at_most_12_joints() {
    for (name, rig) in [("UAL", ual_rig()), ("Mixamo", mixamo_rig())] {
        let skeleton = rig.skeleton();
        let feet = foot_rig(skeleton);
        let mut placer = FootPlacer::new(FootSettings::default());
        placer.plant(&feet, skeleton.rest_pose(), Mat4::IDENTITY, [true, false], TICK, plane(Vec3::ZERO, Vec3::Y));
        let sampled = placer.sampled();
        assert!(sampled <= PLANT_JOINTS_MAX, "{name}: {sampled} joints sampled");
        assert!(sampled < skeleton.joint_count(), "{name}: fewer than all {}", skeleton.joint_count());
        println!("{name}: plant sampled {sampled} of {} joints", skeleton.joint_count());
    }
    // The UAL legs: root, pelvis, then thigh, calf and foot per side.
    let rig = ual_rig();
    let mut placer = FootPlacer::new(FootSettings::default());
    placer.plant(&foot_rig(rig.skeleton()), rig.skeleton().rest_pose(), Mat4::IDENTITY, [false, false], TICK, |_, _| None);
    assert_eq!(placer.sampled(), 8);
}

/// Release R-22 (new behaviour): a game that marks no foot contacts gets them from height. At rest
/// both feet are down; a thigh swung forward lifts its foot past the 3 cm band and only that foot
/// is up; a pose shorter than the skeleton has neither foot down.
#[test]
fn contacts_by_height_say_which_feet_stand_within_the_band() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    assert_eq!(feet.contacts(&model_of(skeleton, &rest)), [true, true]);
    let mut pose = rest.clone();
    let thigh = joint(skeleton, HumanoidBone::LeftUpperLeg);
    pose[thigh].rotation = Quat::from_rotation_x(-0.5) * pose[thigh].rotation;
    let model = model_of(skeleton, &pose);
    let lifted = position(&model, joint(skeleton, HumanoidBone::LeftFoot)).y - feet.ankle_height(Foot::Left);
    assert!(lifted > ANKLE_CONTACT_BAND, "the swung foot rose {lifted} m");
    assert_eq!(feet.contacts(&model), [false, true]);
    assert_eq!(feet.contacts(&model[..2]), [false, false]);
}

#[test]
fn the_sampled_leg_chain_equals_the_full_pose() {
    // The planner's own leg matrices are the skeleton's, so its goals start where the pose is: on
    // flat ground at the model's floor a standing foot's goal is its animated ankle.
    let rig = mixamo_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let mut pose = skeleton.rest_pose().to_vec();
    let knee = joint(skeleton, HumanoidBone::LeftLowerLeg);
    pose[knee].rotation = Quat::from_rotation_x(0.4) * pose[knee].rotation;
    let model = model_of(skeleton, &pose);
    let mut placer = FootPlacer::new(FootSettings::default());
    let plan = placer.plant(&feet, &pose, Mat4::IDENTITY, [false, false], TICK, plane(Vec3::ZERO, Vec3::Y));
    for (foot, bone) in [(Foot::Left, HumanoidBone::LeftFoot), (Foot::Right, HumanoidBone::RightFoot)] {
        let goal = plan.feet[foot.index()].expect("a goal").ankle;
        let ankle = position(&model, joint(skeleton, bone));
        assert!((goal - ankle).length() < 1e-5, "{foot:?}: goal {goal}, ankle {ankle}");
    }
    assert!(plan.pelvis.length() < 1e-6, "the pelvis stays: {}", plan.pelvis);
}

#[test]
fn a_height_function_plants_the_same_feet_as_the_exact_plane() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let rise = 20.0f32.to_radians();
    let slope = sin(rise) / cos(rise);
    let mut exact = FootPlacer::new(FootSettings::default());
    let mut sampled = FootPlacer::new(FootSettings::default());
    let want = exact.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, slope_normal(20.0)));
    let got = sampled.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, height_ground(move |x: f32, _z: f32| Some(x * slope)));
    for foot in Foot::ALL {
        let (want, got) = (want.feet[foot.index()].expect("exact"), got.feet[foot.index()].expect("sampled"));
        assert!((want.ankle - got.ankle).length() < 1e-4, "{foot:?}: {} vs {}", want.ankle, got.ankle);
        assert!(want.tilt.angle_between(got.tilt) < 1e-3, "{foot:?}: {:?} vs {:?}", want.tilt, got.tilt);
    }
    // Outside the terrain (None) and a NaN height plant nothing.
    let none = sampled.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, height_ground(|_, _| None));
    assert_eq!(none, FootPlan::NONE);
    let nan = sampled.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, height_ground(|_, _| Some(f32::NAN)));
    assert_eq!(nan, FootPlan::NONE);
}

#[test]
fn a_turned_and_moved_character_plants_its_feet_in_world_space() {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let rest = skeleton.rest_pose().to_vec();
    let place = Mat4::from_rotation_translation(Quat::from_rotation_y(1.1), Vec3::new(3.0, 2.0, -4.0));
    let mut placer = FootPlacer::new(FootSettings::default());
    // The floor at the character's feet: the goals are the animated ankles.
    let plan = placer.plant(&feet, &rest, place, [true, true], TICK, plane(Vec3::new(0.0, 2.0, 0.0), Vec3::Y));
    let model = model_of(skeleton, &rest);
    for (foot, bone) in [(Foot::Left, HumanoidBone::LeftFoot), (Foot::Right, HumanoidBone::RightFoot)] {
        let goal = plan.feet[foot.index()].expect("a goal");
        assert!((goal.ankle - position(&model, joint(skeleton, bone))).length() < 1e-5, "{foot:?}: {}", goal.ankle);
        assert!(goal.tilt.angle_between(Quat::IDENTITY) < 1e-5);
    }
    // A step 10 cm up under both feet lifts both goals (a fresh placer: no lock holds them); the
    // pelvis does not rise.
    let mut placer = FootPlacer::new(FootSettings::default());
    let plan = placer.plant(&feet, &rest, place, [false, false], TICK, plane(Vec3::new(0.0, 2.1, 0.0), Vec3::Y));
    for foot in Foot::ALL {
        let lift = plan.feet[foot.index()].expect("a goal").ankle.y - feet.ankle_height(foot);
        assert!((lift - 0.1).abs() < 1e-4, "{foot:?} lifted {lift}");
    }
    assert_eq!(plan.pelvis, Vec3::ZERO);
}

/// The plans and digests of a scripted walk over a bumpy slope, ticks `from..to`.
fn script(placer: &mut FootPlacer, from: usize, to: usize) -> Vec<(FootPlan, u64)> {
    let rig = ual_rig();
    let skeleton = rig.skeleton();
    let feet = foot_rig(skeleton);
    let mut pose = skeleton.rest_pose().to_vec();
    let knee = joint(skeleton, HumanoidBone::LeftLowerLeg);
    let rest_knee = pose[knee].rotation;
    (from..to)
        .map(|tick| {
            let t = tick as f32 * TICK;
            pose[knee].rotation = Quat::from_rotation_x(0.3 * sin(6.0 * t)) * rest_knee;
            let place = Mat4::from_translation(Vec3::new(0.0, 0.0, 1.2 * t));
            let contacts = [sin(6.0 * t) > 0.0, sin(6.0 * t) <= 0.0];
            let ground = height_ground(|x: f32, z: f32| Some(0.1 * x + 0.03 * sin(2.0 * z)));
            let plan = placer.plant(&feet, &pose, place, contacts, TICK, ground);
            (plan, placer.digest())
        })
        .collect()
}

#[test]
fn a_scripted_walk_replays_bit_for_bit_and_a_restored_placer_continues_it() {
    let mut first = FootPlacer::new(FootSettings::default());
    let mut second = FootPlacer::new(FootSettings::default());
    let a = script(&mut first, 0, 300);
    let b = script(&mut second, 0, 300);
    assert_eq!(a, b, "two runs agree bit for bit");
    let mut original = FootPlacer::new(FootSettings::default());
    let head = script(&mut original, 0, 150);
    let saved = original.snapshot();
    let mut restored = FootPlacer::new(FootSettings::default());
    restored.restore(&saved).expect("the snapshot restores");
    assert_eq!(restored.digest(), original.digest());
    let tail = script(&mut restored, 150, 300);
    assert_eq!([head, tail].concat(), a, "save at 150, restore, replay equals the uninterrupted run");
}

#[test]
fn a_hostile_snapshot_is_refused_and_leaves_the_placer_unchanged() {
    let mut placer = FootPlacer::new(FootSettings::default());
    script(&mut placer, 0, 40);
    let digest = placer.digest();
    let good = placer.snapshot();
    let mut wrong_version = good.clone();
    wrong_version.set("version", genex_core::json::Value::from(99u32));
    let mut short = good.clone();
    short.set("feet", genex_core::json::Value::array());
    let mut nan = good.clone();
    let mut numbers = good["feet"].clone();
    if let genex_core::json::Value::Array(items) = &mut numbers {
        items[0] = genex_core::json::Value::from(f32::NAN.to_bits());
    }
    nan.set("feet", numbers);
    for (name, hostile) in [("version", wrong_version), ("short", short), ("nan", nan), ("null", genex_core::json::Value::Null)] {
        let refused = placer.restore(&hostile).expect_err(name);
        assert_eq!(refused.code, AnimationErrorCode::AssetInvalid, "{name}");
        assert_eq!(placer.digest(), digest, "{name}: unchanged");
    }
}

#[test]
fn a_rig_without_legs_has_no_foot_rig() {
    let rig = import_rig(&support::chain3().glb()).expect("the chain");
    assert!(FootRig::of(rig.skeleton(), &HumanoidMap::of(rig.skeleton())).is_none());
}

#[cfg(feature = "physics")]
mod rapier {
    //! With `physics`: the character controller's own ground ray plants the feet on a Rapier
    //! slope as the exact plane does.

    use super::*;
    use genex_anim::character::{Character, CharacterParams};
    use rapier3d::prelude::{ColliderBuilder, PhysicsWorld, Pose};

    #[test]
    fn a_rapier_ray_plants_the_same_feet_as_the_exact_plane() {
        let rig = ual_rig();
        let skeleton = rig.skeleton();
        let feet = foot_rig(skeleton);
        let rest = skeleton.rest_pose().to_vec();
        let mut world = PhysicsWorld::default();
        let normal = slope_normal(20.0);
        // A slab whose top face is the slope through the origin.
        let turn = Quat::from_rotation_arc(Vec3::Y, normal);
        let pose = Pose::from_parts(turn * Vec3::new(0.0, -0.5, 0.0), turn);
        world.insert_collider(ColliderBuilder::cuboid(20.0, 0.5, 20.0).position(pose), None);
        world.step();
        let character = Character::spawn(&mut world, Vec3::new(0.0, 5.0, 0.0), CharacterParams::default()).expect("a character");
        world.step();
        let mut exact = FootPlacer::new(FootSettings::default());
        let mut rapier = FootPlacer::new(FootSettings::default());
        let want = exact.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, plane(Vec3::ZERO, normal));
        let got = rapier.plant(&feet, &rest, Mat4::IDENTITY, [true, true], TICK, character.ground_ray(&world));
        for foot in Foot::ALL {
            let (want, got) = (want.feet[foot.index()].expect("exact"), got.feet[foot.index()].expect("rapier"));
            assert!((want.ankle - got.ankle).length() < 1e-4, "{foot:?}: {} vs {}", want.ankle, got.ankle);
            assert!(want.tilt.angle_between(got.tilt) < 1e-3);
        }
    }
}
