//! AN-10: two-bone and aim IK. A target at exactly full reach and one metre beyond give no NaN
//! and no knee snap; a reachable target is reached within 1e-4; a pole behind the knee bends it
//! backward; weight 0 returns the input pose bit for bit; and a head 0.5 / neck 0.3 / spine 0.2
//! look-at chain points the head within 1° of its target inside its limits. Four limbs plus a
//! look-at are timed (recorded, budget 4 µs per character).

mod support;

use genex_anim::JointId;
use genex_anim::ik::{AimIk, AimJoint, DEFAULT_SOFTEN, LookAt, TwoBoneChain, TwoBoneIk, apply_look_at, apply_two_bone, solve_aim, solve_two_bone};
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use glam::{Mat4, Quat, Vec3};

fn humanoid() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn joint(rig: &Rig, name: &str) -> JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

/// The rest pose and its model matrices.
fn rest(rig: &Rig) -> (Vec<Trs>, Vec<Mat4>) {
    let pose = rig.skeleton().rest_pose().to_vec();
    let mut model = vec![Mat4::IDENTITY; pose.len()];
    rig.skeleton().local_to_model(&pose, &mut model);
    (pose, model)
}

/// Model matrices of `pose`, freshly computed.
fn model_of(rig: &Rig, pose: &[Trs]) -> Vec<Mat4> {
    let mut model = vec![Mat4::IDENTITY; pose.len()];
    rig.skeleton().local_to_model(pose, &mut model);
    model
}

fn position(model: &[Mat4], joint: JointId) -> Vec3 {
    model[usize::from(joint.raw())].w_axis.truncate()
}

fn leg(rig: &Rig) -> TwoBoneChain {
    TwoBoneChain { start: joint(rig, "LeftUpLeg"), mid: joint(rig, "LeftLeg"), end: joint(rig, "LeftFoot"), mid_axis: Vec3::X }
}

fn finite(pose: &[Trs]) -> bool {
    pose.iter().all(Trs::is_finite)
}

/// The knee's interior angle, from a pose's own model matrices.
fn knee_angle(rig: &Rig, chain: &TwoBoneChain, pose: &[Trs]) -> f32 {
    let model = model_of(rig, pose);
    let (start, mid, end) = (position(&model, chain.start), position(&model, chain.mid), position(&model, chain.end));
    (start - mid).angle_between(end - mid)
}

/// The leg's full reach: thigh plus shin.
fn reach(rig: &Rig, chain: &TwoBoneChain) -> f32 {
    let (_, model) = rest(rig);
    let (start, mid, end) = (position(&model, chain.start), position(&model, chain.mid), position(&model, chain.end));
    (mid - start).length() + (end - mid).length()
}

/// Solve the leg toward a hip-relative point `distance` along `direction` from the rest pose.
fn solve_leg(rig: &Rig, chain: &TwoBoneChain, direction: Vec3, distance: f32, soften: f32) -> (Vec<Trs>, bool, Vec3) {
    let (mut pose, mut model) = rest(rig);
    let hip = position(&model, chain.start);
    let target = hip + direction.normalize() * distance;
    let ik = TwoBoneIk { soften, ..TwoBoneIk::new(target, Vec3::Z) };
    let reached = apply_two_bone(rig.skeleton(), chain, &ik, &mut pose, &mut model);
    (pose, reached, target)
}

#[test]
fn full_reach_and_a_metre_beyond_give_no_nan_and_no_knee_snap() {
    let rig = humanoid();
    let chain = leg(&rig);
    let length = reach(&rig, &chain);
    let direction = Vec3::new(0.0, -1.0, 0.2);
    let largest_step = |soften: f32| {
        let mut largest = 0.0f32;
        let mut previous: Option<f32> = None;
        // From 90 % of the reach to one metre past it, a millimetre at a time.
        let steps = ((length * 0.1 + 1.0) / 0.001) as u32;
        for k in 0..=steps {
            let distance = length * 0.9 + k as f32 * 0.001;
            let (pose, _, _) = solve_leg(&rig, &chain, direction, distance, soften);
            assert!(finite(&pose), "soften {soften}, distance {distance}: no NaN");
            let angle = knee_angle(&rig, &chain, &pose);
            assert!(angle.is_finite());
            if let Some(previous) = previous {
                largest = largest.max((angle - previous).abs());
            }
            previous = Some(angle);
        }
        largest
    };
    let softened = largest_step(DEFAULT_SOFTEN);
    let hard = largest_step(1.0);
    println!("AN-10 knee: largest change per mm {softened:.5} rad softened ({DEFAULT_SOFTEN}), {hard:.5} rad unsoftened");
    // The fastest a softened knee moves is where softening starts (slope 1 there): about
    // 0.0098 rad per mm at 0.97 of this leg's reach. Unsoftened, the last millimetre takes ~0.1.
    assert!(softened <= 0.015, "the softened knee moves at most 0.015 rad per mm of target ({softened})");
    assert!(hard > 0.05, "the row can fail: without softening the knee snaps ({hard} rad in a mm)");

    // Exactly full reach and a metre beyond: finite, and the foot points at the target.
    for distance in [length, length + 1.0] {
        let (pose, reached, target) = solve_leg(&rig, &chain, direction, distance, 1.0);
        assert!(finite(&pose));
        assert!(!reached || distance <= length, "a target beyond reach is not reported reached");
        let model = model_of(&rig, &pose);
        let hip = position(&model, chain.start);
        let aim = (position(&model, chain.end) - hip).angle_between(target - hip);
        assert!(aim < 1e-3, "distance {distance}: the straight leg points at the target ({aim} rad off)");
    }
}

#[test]
fn a_reachable_target_is_reached_within_1e_4() {
    let rig = humanoid();
    let chain = leg(&rig);
    let length = reach(&rig, &chain);
    for (direction, share, pole) in [
        (Vec3::new(0.0, -1.0, 0.0), 0.8, Vec3::Z),
        (Vec3::new(0.0, -1.0, 0.6), 0.7, Vec3::Z),
        (Vec3::new(0.5, -1.0, -0.3), 0.85, Vec3::new(0.3, 0.0, 1.0)),
        (Vec3::new(-0.2, -0.4, 1.0), 0.6, Vec3::Y),
        (Vec3::new(0.0, -1.0, 0.0), 0.3, -Vec3::Z),
    ] {
        let (mut pose, mut model) = rest(&rig);
        let target = position(&model, chain.start) + direction.normalize() * (length * share);
        let ik = TwoBoneIk::new(target, pole);
        let reached = apply_two_bone(rig.skeleton(), &chain, &ik, &mut pose, &mut model);
        let fresh = model_of(&rig, &pose);
        let miss = (position(&fresh, chain.end) - target).length();
        assert!(reached, "{direction:?} at {share} of reach is reported reached");
        assert!(miss <= 1e-4, "{direction:?} at {share}: the foot misses by {miss}");
        let refreshed = (position(&model, chain.end) - position(&fresh, chain.end)).length();
        assert!(refreshed <= 1e-5, "the chain's model matrices are refreshed in place ({refreshed})");
        assert!(finite(&pose));
    }
}

/// How far the knee sits in front of (+) or behind (-) the hip-to-target line, along +Z.
fn knee_forward(rig: &Rig, chain: &TwoBoneChain, pose: &[Trs]) -> f32 {
    let model = model_of(rig, pose);
    let (start, mid, end) = (position(&model, chain.start), position(&model, chain.mid), position(&model, chain.end));
    let line = (end - start).normalize();
    let offset = (mid - start) - line * (mid - start).dot(line);
    offset.z
}

#[test]
fn a_pole_behind_the_knee_bends_it_backward() {
    let rig = humanoid();
    let chain = leg(&rig);
    let length = reach(&rig, &chain);
    for (pole, expect_forward) in [(Vec3::Z, true), (-Vec3::Z, false), (Vec3::new(0.2, 0.0, -1.0), false)] {
        let (mut pose, mut model) = rest(&rig);
        let target = position(&model, chain.start) + Vec3::NEG_Y * (length * 0.75);
        let reached = apply_two_bone(rig.skeleton(), &chain, &TwoBoneIk::new(target, pole), &mut pose, &mut model);
        assert!(reached);
        let forward = knee_forward(&rig, &chain, &pose);
        println!("AN-10 pole {pole:?}: knee {forward:+.4} m along +Z");
        if expect_forward {
            assert!(forward > 0.05, "a pole in front bends the knee forward ({forward})");
        } else {
            assert!(forward < -0.05, "a pole behind bends the knee backward ({forward})");
        }
    }
}

#[test]
fn weight_zero_returns_the_input_bit_for_bit() {
    let rig = humanoid();
    let chain = leg(&rig);
    let (pose, model) = rest(&rig);
    let target = position(&model, chain.start) + Vec3::new(0.0, -0.5, 0.3);
    for weight in [0.0, -1.0, f32::NAN] {
        let mut posed = pose.clone();
        let mut modelled = model.clone();
        let ik = TwoBoneIk { weight, ..TwoBoneIk::new(target, Vec3::Z) };
        apply_two_bone(rig.skeleton(), &chain, &ik, &mut posed, &mut modelled);
        assert_eq!(posed, pose, "two-bone weight {weight}: the pose is untouched");
        assert_eq!(modelled, model, "two-bone weight {weight}: the model matrices are untouched");
        let look = LookAt { weight, ..look(&rig, Vec3::new(0.5, 1.7, 1.5)) };
        apply_look_at(rig.skeleton(), &head_chain(&rig, 1.0), &look, &mut posed, &mut modelled);
        assert_eq!(posed, pose, "look-at weight {weight}: the pose is untouched");
        assert_eq!(modelled, model, "look-at weight {weight}: the model matrices are untouched");
    }
    // A half weight lands between: the knee bends part of the way.
    let mut half = pose.clone();
    let mut half_model = model.clone();
    let ik = TwoBoneIk { weight: 0.5, ..TwoBoneIk::new(target, Vec3::Z) };
    apply_two_bone(rig.skeleton(), &chain, &ik, &mut half, &mut half_model);
    let (mut full, mut full_model) = (pose.clone(), model.clone());
    apply_two_bone(rig.skeleton(), &chain, &TwoBoneIk::new(target, Vec3::Z), &mut full, &mut full_model);
    let (rest_knee, half_knee, full_knee) = (knee_angle(&rig, &chain, &pose), knee_angle(&rig, &chain, &half), knee_angle(&rig, &chain, &full));
    assert!(half_knee < rest_knee.max(full_knee) && half_knee > rest_knee.min(full_knee), "half weight bends between: {rest_knee} {half_knee} {full_knee}");
}

/// Spine 0.2, neck 0.3, head 0.5, each limited to `limit` radians, base first.
fn head_chain(rig: &Rig, limit: f32) -> Vec<AimJoint> {
    vec![
        AimJoint { joint: joint(rig, "Spine2"), share: 0.2, limit },
        AimJoint { joint: joint(rig, "Neck"), share: 0.3, limit },
        AimJoint { joint: joint(rig, "Head"), share: 0.5, limit },
    ]
}

/// Eyes 8 cm up and 10 cm in front of the head, looking along its +Z with +Y up.
fn look(_rig: &Rig, target: Vec3) -> LookAt {
    LookAt { target, forward: Vec3::Z, up: Vec3::Y, offset: Vec3::new(0.0, 0.08, 0.1), pole: Vec3::Y, weight: 1.0 }
}

/// How far the head's eye ray misses `target`, in radians.
fn eye_miss(rig: &Rig, pose: &[Trs], look: &LookAt) -> f32 {
    let model = model_of(rig, pose);
    let head = model[usize::from(joint(rig, "Head").raw())];
    let eyes = head.transform_point3(look.offset);
    head.transform_vector3(look.forward).angle_between(look.target - eyes)
}

fn rotation_angle(a: Quat, b: Quat) -> f32 {
    a.angle_between(b)
}

#[test]
fn a_head_neck_spine_look_at_points_within_one_degree_inside_its_limits() {
    let rig = humanoid();
    let (pose, model) = rest(&rig);
    let target = Vec3::new(0.7, 1.9, 1.4);
    let request = look(&rig, target);
    let before = eye_miss(&rig, &pose, &request);
    let mut posed = pose.clone();
    let mut modelled = model.clone();
    let chain = head_chain(&rig, 1.2);
    let reached = apply_look_at(rig.skeleton(), &chain, &request, &mut posed, &mut modelled);
    let after = eye_miss(&rig, &posed, &request);
    println!("AN-10 look-at: {:.3}° before, {:.4}° after", before.to_degrees(), after.to_degrees());
    assert!(before > 0.5, "the target starts well off the eye line");
    assert!(reached, "inside its limits the chain reports reached");
    assert!(after <= 1f32.to_radians(), "the head points within 1° ({}°)", after.to_degrees());
    let turned: Vec<f32> = chain.iter().map(|aim| rotation_angle(pose[usize::from(aim.joint.raw())].rotation, posed[usize::from(aim.joint.raw())].rotation)).collect();
    let total: f32 = turned.iter().sum();
    println!("AN-10 look-at shares: spine {:.3}, neck {:.3}, head {:.3} of {total:.3} rad", turned[0], turned[1], turned[2]);
    assert!(turned[0] < turned[1] && turned[1] < turned[2], "the turn grows up the chain by share: {turned:?}");
    let spine_share = turned[0] / total;
    assert!((0.1..=0.3).contains(&spine_share), "the spine takes about its 0.2 share ({spine_share})");
    let refreshed = (modelled[usize::from(joint(&rig, "Head").raw())] - model_of(&rig, &posed)[usize::from(joint(&rig, "Head").raw())]).abs().to_cols_array().iter().copied().fold(0.0, f32::max);
    assert!(refreshed <= 1e-5, "the head's model matrix is refreshed in place ({refreshed})");

    // Limits hold: at 5° a joint the far target is not reached and no joint turns past its limit.
    let mut limited = pose.clone();
    let mut limited_model = model.clone();
    let tight = head_chain(&rig, 5f32.to_radians());
    let reached = apply_look_at(rig.skeleton(), &tight, &request, &mut limited, &mut limited_model);
    assert!(!reached, "past its limits the chain reports not reached");
    for aim in &tight {
        let turned = rotation_angle(pose[usize::from(aim.joint.raw())].rotation, limited[usize::from(aim.joint.raw())].rotation);
        assert!(turned <= aim.limit + 1e-4, "a joint turned {turned} past its limit {}", aim.limit);
    }
}

#[test]
fn a_single_aim_turns_the_forward_axis_onto_the_target_with_its_up_toward_the_pole() {
    let joint = Mat4::from_rotation_translation(Quat::from_rotation_y(0.4) * Quat::from_rotation_x(-0.2), Vec3::new(0.1, 1.6, 0.0));
    let target = Vec3::new(-1.0, 2.2, 2.0);
    let ik = AimIk { target, forward: Vec3::Z, up: Vec3::Y, offset: Vec3::ZERO, pole: Vec3::Y, weight: 1.0, twist: 0.0 };
    let solved = solve_aim(&joint, &ik);
    assert!(solved.reached);
    let corrected = joint * Mat4::from_quat(solved.rotation);
    let forward = corrected.transform_vector3(Vec3::Z);
    let miss = forward.angle_between(target - corrected.w_axis.truncate());
    assert!(miss < 1e-4, "forward points at the target ({miss})");
    let up = corrected.transform_vector3(Vec3::Y);
    let plane = forward.cross(Vec3::Y);
    assert!(up.dot(plane).abs() < 1e-4 && up.dot(Vec3::Y) > 0.0, "up lies in the plane of the forward axis and the pole, toward the pole");
}

#[test]
fn hostile_inputs_leave_every_pose_finite() {
    let rig = humanoid();
    let chain = leg(&rig);
    let (pose, model) = rest(&rig);
    let hip = position(&model, chain.start);
    let below = hip + Vec3::NEG_Y * 0.5;
    let cases: [(&str, TwoBoneIk); 7] = [
        ("NaN target", TwoBoneIk::new(Vec3::NAN, Vec3::Z)),
        ("infinite target", TwoBoneIk::new(Vec3::INFINITY, Vec3::Z)),
        ("target on the hip", TwoBoneIk::new(hip, Vec3::Z)),
        // The pole along the hip-to-target line leaves no bend plane (ozz before 0.17 NaNs here).
        ("pole along the target line", TwoBoneIk::new(below, Vec3::NEG_Y)),
        ("zero pole", TwoBoneIk::new(below, Vec3::ZERO)),
        ("NaN pole", TwoBoneIk::new(below, Vec3::NAN)),
        ("NaN soften and twist", TwoBoneIk { soften: f32::NAN, twist: f32::NAN, ..TwoBoneIk::new(below, Vec3::Z) }),
    ];
    for (label, ik) in cases {
        let mut posed = pose.clone();
        let mut modelled = model.clone();
        apply_two_bone(rig.skeleton(), &chain, &ik, &mut posed, &mut modelled);
        assert!(finite(&posed), "{label}: finite");
        assert!(modelled.iter().all(|m| m.is_finite()), "{label}: finite model");
    }
    // A zero-length bone and a zero mid axis solve to no correction.
    let at_hip = Mat4::from_translation(hip);
    let solved = solve_two_bone(&at_hip, &at_hip, &Mat4::from_translation(below), Vec3::X, &TwoBoneIk::new(below, Vec3::Z));
    assert!(solved.start.is_finite() && solved.mid.is_finite());
    let knee = Mat4::from_translation(hip + Vec3::NEG_Y * 0.42);
    let solved = solve_two_bone(&at_hip, &knee, &Mat4::from_translation(hip + Vec3::NEG_Y * 0.84), Vec3::ZERO, &TwoBoneIk::new(below, Vec3::Z));
    assert_eq!((solved.start, solved.mid), (Quat::IDENTITY, Quat::IDENTITY), "no bend axis, no correction");
    // Joints that are not a chain of this skeleton change nothing.
    let mut posed = pose.clone();
    let mut modelled = model.clone();
    let broken = TwoBoneChain { start: chain.start, mid: joint(&rig, "Head"), end: chain.end, mid_axis: Vec3::X };
    assert!(!apply_two_bone(rig.skeleton(), &broken, &TwoBoneIk::new(below, Vec3::Z), &mut posed, &mut modelled));
    assert_eq!(posed, pose, "a broken chain leaves the pose alone");
    let short: Vec<Trs> = pose[..3].to_vec();
    let mut short_posed = short.clone();
    let mut short_model = model[..3].to_vec();
    assert!(!apply_two_bone(rig.skeleton(), &chain, &TwoBoneIk::new(below, Vec3::Z), &mut short_posed, &mut short_model));
    assert_eq!(short_posed, short, "a pose too short for the chain is left alone");
    // Look-at toward a NaN target or with no shares changes nothing and stays finite.
    for (label, request, shares) in [("NaN target", look(&rig, Vec3::NAN), 1.0), ("no shares", look(&rig, Vec3::new(0.5, 1.7, 1.5)), 0.0)] {
        let mut posed = pose.clone();
        let mut modelled = model.clone();
        let chain: Vec<AimJoint> = head_chain(&rig, 1.0).into_iter().map(|aim| AimJoint { share: aim.share * shares, ..aim }).collect();
        assert!(!apply_look_at(rig.skeleton(), &chain, &request, &mut posed, &mut modelled), "{label}: not reached");
        assert!(finite(&posed), "{label}: finite");
    }
}

#[test]
fn the_same_inputs_give_the_same_bits() {
    let rig = humanoid();
    let chain = leg(&rig);
    let run = || {
        let (mut pose, mut model) = rest(&rig);
        let target = position(&model, chain.start) + Vec3::new(0.1, -0.6, 0.35);
        apply_two_bone(rig.skeleton(), &chain, &TwoBoneIk { twist: 0.3, ..TwoBoneIk::new(target, Vec3::new(0.2, 0.1, 1.0)) }, &mut pose, &mut model);
        apply_look_at(rig.skeleton(), &head_chain(&rig, 1.0), &look(&rig, Vec3::new(-0.4, 1.5, 1.0)), &mut pose, &mut model);
        pose.iter().flat_map(|trs| trs.rotation.to_array()).map(f32::to_bits).collect::<Vec<u32>>()
    };
    assert_eq!(run(), run());
}

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn four_limbs_and_a_look_at_are_timed() {
    let rig = humanoid();
    let (pose, model) = rest(&rig);
    let limb = |a: &str, b: &str, c: &str| TwoBoneChain { start: joint(&rig, a), mid: joint(&rig, b), end: joint(&rig, c), mid_axis: Vec3::X };
    let limbs = [
        limb("LeftUpLeg", "LeftLeg", "LeftFoot"),
        limb("RightUpLeg", "RightLeg", "RightFoot"),
        TwoBoneChain { mid_axis: Vec3::Y, ..limb("LeftArm", "LeftForeArm", "LeftHand") },
        TwoBoneChain { mid_axis: Vec3::Y, ..limb("RightArm", "RightForeArm", "RightHand") },
    ];
    let targets: Vec<TwoBoneIk> = limbs
        .iter()
        .map(|chain| {
            let start = position(&model, chain.start);
            TwoBoneIk::new(start + (position(&model, chain.end) - start) * 0.8 + Vec3::new(0.0, 0.0, 0.1), Vec3::Z)
        })
        .collect();
    let chain = head_chain(&rig, 1.0);
    let request = look(&rig, Vec3::new(0.5, 1.8, 1.5));
    const RUNS: u32 = 20_000;
    let mut posed = pose.clone();
    let mut modelled = model.clone();
    let started = std::time::Instant::now();
    for _ in 0..RUNS {
        posed.copy_from_slice(&pose);
        modelled.copy_from_slice(&model);
        for (limb, ik) in limbs.iter().zip(&targets) {
            apply_two_bone(rig.skeleton(), limb, ik, &mut posed, &mut modelled);
        }
        apply_look_at(rig.skeleton(), &chain, &request, &mut posed, &mut modelled);
    }
    let micros = started.elapsed().as_secs_f64() * 1e6 / f64::from(RUNS);
    assert!(finite(&posed));
    // Recorded, not asserted: lane timings are advisory (plan 4.4); the budget is 4 µs.
    println!("AN-10 budget: four limbs and a 3-joint look-at {micros:.3} µs per character (budget 4 µs)");
}
