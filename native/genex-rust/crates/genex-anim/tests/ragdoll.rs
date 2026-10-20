//! AN-20: humanoid ragdolls. A limit-semantics row (knees and elbows of a collapsing ragdoll never
//! bend past their limits or the wrong way over 300 ticks, which pins Rapier's sign convention
//! against this crate's model-space hinge directions); `go_limp(Whole, v)` gives every body `v` on
//! the activation tick; a limp left arm leaves the legs bit-identical to the animated pose;
//! `power(Whole, 1.0)` holds the limbs within 10° under a 50 N push and `recover` blends back;
//! 600 ticks replay to a bit-exact physics state digest; hostile profiles are refused
//! `ragdoll-profile-invalid`.
//!
//! Every row is new behaviour (section 0 of the game systems plan): the module was a stub. The
//! module exists only with `physics`, and so does this file.

#![cfg(feature = "physics")]

mod support;

use std::sync::Arc;

use genex_anim::animator::{AnimSet, Animator};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::humanoid::HumanoidBone;
use genex_anim::import::import_rig;
use genex_anim::ragdoll::{Ragdoll, RagdollMode, RagdollPart};
use genex_anim::ragdoll_profile::{RagdollBody, RagdollJoint, RagdollProfile};
use genex_anim::skeleton::Skeleton;
use genex_anim::{AnimationErrorCode, JointId};
use glam::{Mat4, Quat, Vec3};
use rapier3d::prelude::{ColliderBuilder, PhysicsWorld};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;
/// How far past a limit an impulse solver may push a joint on a hard landing, radians, by the
/// world's solver iterations: Rapier's impulse-joint limits are solver constraints, not exact
/// clamps (measured: 0.158 at Rapier's default 4 iterations, 0.081 at 8). A flipped sign
/// convention would bend a knee the wrong way by up to its whole range (2.4).
const LIMIT_SLACK: [(usize, f32); 2] = [(4, 0.2), (8, 0.1)];
/// How close (degrees) a recovered body sits on its bone: a kinematic body reaches its next
/// position through Rapier's integration, not by copying it.
const RECOVERED_DEGREES: f32 = 0.1;

/// The humanoid fixture with one clip: the left thigh swinging, so the pose moves every tick.
fn animator() -> Animator {
    let rig = import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports");
    let thigh = rig.skeleton().find("LeftUpLeg").expect("a left thigh");
    let rest = rig.skeleton().rest_pose()[usize::from(thigh.raw())].rotation;
    let values = [0.0f32, 0.4, 0.0].iter().map(|angle| rest * Quat::from_rotation_x(*angle)).collect();
    let track = Track::new(thigh, Interpolation::Linear, vec![0.0, 0.5, 1.0], TrackValues::Rotation(values)).expect("a track");
    let clips = vec![Clip::new("Swing", vec![track]).expect("a clip")];
    let set = Arc::new(AnimSet::new(rig.skeleton().clone(), clips));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let ids: Vec<_> = g.clips().map(|(id, _)| id).collect();
    let base = g.layer("base");
    g.state(base, "swing", Motion::clip(ids[0]));
    let graph = g.build().expect("the graph builds");
    Animator::new(set, &graph).expect("the animator")
}

/// A world with a ground slab whose top is at y = 0, stepped once so it is in the broad phase.
fn ground_world() -> PhysicsWorld {
    let mut world = PhysicsWorld::default();
    world.insert_collider(ColliderBuilder::cuboid(50.0, 0.5, 50.0).translation(Vec3::new(0.0, -0.5, 0.0)), None);
    world.step();
    world
}

fn joint(animator: &Animator, bone: HumanoidBone) -> JointId {
    animator.set().humanoid().joint(bone).expect("the fixture maps every humanoid bone")
}

fn slot(joint: JointId) -> usize {
    usize::from(joint.raw())
}

/// The rest pose's model-space rotation of every joint.
fn rest_rotations(skeleton: &Skeleton) -> Vec<Quat> {
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(skeleton.rest_pose(), &mut model);
    model.iter().map(|matrix| matrix.to_scale_rotation_translation().1.normalize()).collect()
}

/// The rest pose's model-space position of every joint.
fn rest_positions(skeleton: &Skeleton) -> Vec<Vec3> {
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(skeleton.rest_pose(), &mut model);
    model.iter().map(|matrix| matrix.w_axis.truncate()).collect()
}

/// A hinge's bend from rest, signed by this crate's rule: positive moves the bone's tip toward
/// `toward` (model space). Measured from the two bodies' world rotations only.
struct Hinge {
    parent: HumanoidBone,
    child: HumanoidBone,
    /// The hinge axis in the child body's rest frame.
    axis_local: Vec3,
    /// The child's rest rotation relative to its parent's.
    rest_relative: Quat,
    max: f32,
}

fn hinge(animator: &Animator, parent: HumanoidBone, child: HumanoidBone, tip: HumanoidBone, toward: Vec3, max: f32) -> Hinge {
    let skeleton = animator.set().skeleton();
    let rotations = rest_rotations(skeleton);
    let positions = rest_positions(skeleton);
    let (p, c, t) = (slot(joint(animator, parent)), slot(joint(animator, child)), slot(joint(animator, tip)));
    let along = (positions[t] - positions[c]).normalize();
    let axis_model = along.cross(toward).normalize();
    Hinge { parent, child, axis_local: rotations[c].inverse() * axis_model, rest_relative: rotations[p].inverse() * rotations[c], max }
}

impl Hinge {
    fn bend(&self, ragdoll: &Ragdoll, world: &PhysicsWorld) -> f32 {
        let view = ragdoll.view(world);
        let parent = view.body_pose(self.parent).expect("a parent body").rotation;
        let child = view.body_pose(self.child).expect("a child body").rotation;
        let delta = (self.rest_relative.inverse() * parent.inverse() * child).normalize();
        let along = Vec3::new(delta.x, delta.y, delta.z).dot(self.axis_local);
        2.0 * glam::Vec2::new(delta.w, along).to_angle()
    }
}

#[test]
fn knees_and_elbows_of_a_collapsing_ragdoll_stay_inside_their_limits() {
    for (iterations, slack) in LIMIT_SLACK {
        collapse_within_limits(iterations, slack);
    }
}

fn collapse_within_limits(iterations: usize, slack: f32) {
    let animator = animator();
    let mut world = ground_world();
    world.integration_parameters.num_solver_iterations = iterations;
    let mut ragdoll = Ragdoll::build(&mut world, &animator, Mat4::from_translation(Vec3::new(0.0, 0.05, 0.0)), &RagdollProfile::humanoid()).expect("the humanoid builds");
    use HumanoidBone as B;
    let hinges = [
        hinge(&animator, B::LeftUpperLeg, B::LeftLowerLeg, B::LeftFoot, Vec3::NEG_Z, 2.4),
        hinge(&animator, B::RightUpperLeg, B::RightLowerLeg, B::RightFoot, Vec3::NEG_Z, 2.4),
        hinge(&animator, B::LeftUpperArm, B::LeftLowerArm, B::LeftHand, Vec3::Z, 2.5),
        hinge(&animator, B::RightUpperArm, B::RightLowerArm, B::RightHand, Vec3::Z, 2.5),
    ];
    // A shove forward and down, and the left shin kicked back: the left leg folds as it collapses.
    ragdoll.go_limp(&mut world, RagdollPart::Whole, Vec3::new(0.0, -1.0, 1.5));
    let shin = ragdoll.body(B::LeftLowerLeg).expect("a shin");
    world.bodies.get_mut(shin).expect("in the world").set_linvel(Vec3::new(0.0, 0.0, -2.0), true);
    let mut most = [0.0f32; 4];
    let mut least = [0.0f32; 4];
    for tick in 0..300 {
        world.step();
        for (index, hinge) in hinges.iter().enumerate() {
            let bend = hinge.bend(&ragdoll, &world);
            assert!(bend >= -slack && bend <= hinge.max + slack, "{iterations} iterations, tick {tick}: {:?} bent {bend} rad, its range is [0, {}]", hinge.child, hinge.max);
            most[index] = most[index].max(bend);
            least[index] = least[index].min(bend);
        }
    }
    assert!(most[0] > 0.3, "the left knee folded the anatomical way: {most:?}");
    println!("RECORD an20 hinge range over 300 ticks at {iterations} iterations: least {least:?}, most {most:?}");
}

#[test]
fn go_limp_gives_every_body_the_velocity_on_the_activation_tick() {
    let animator = animator();
    let mut world = ground_world();
    let mut ragdoll = Ragdoll::build(&mut world, &animator, Mat4::IDENTITY, &RagdollProfile::humanoid()).expect("the humanoid builds");
    assert_eq!(ragdoll.body_count(), 11);
    let velocity = Vec3::new(1.5, 2.0, -0.75);
    ragdoll.go_limp(&mut world, RagdollPart::Whole, velocity);
    for bone in RagdollProfile::humanoid().parts().iter().map(|part| part.bone) {
        let body = world.bodies.get(ragdoll.body(bone).expect("a body")).expect("in the world");
        assert_eq!(body.linvel().to_array().map(f32::to_bits), velocity.to_array().map(f32::to_bits), "{bone:?}");
        assert_eq!(body.angvel(), Vec3::ZERO, "{bone:?}");
        assert!(body.is_dynamic(), "{bone:?}");
        assert_eq!(ragdoll.mode(bone), Some(RagdollMode::Limp));
    }
}

#[test]
fn a_limp_left_arm_leaves_the_legs_bit_identical_to_the_animated_pose() {
    let mut animator = animator();
    let mut world = ground_world();
    let model = Mat4::from_translation(Vec3::new(0.0, 0.05, 0.0));
    let mut ragdoll = Ragdoll::build(&mut world, &animator, model, &RagdollProfile::humanoid()).expect("the humanoid builds");
    let skeleton = animator.set().skeleton().clone();
    let left_arm: Vec<usize> = skeleton
        .joints()
        .filter(|&j| {
            let mut cursor = Some(j);
            while let Some(c) = cursor {
                if c == joint(&animator, HumanoidBone::LeftUpperArm) {
                    return true;
                }
                cursor = skeleton.parent(c);
            }
            false
        })
        .map(slot)
        .collect();
    let mut out = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut arm_moved = false;
    for tick in 0..120 {
        animator.update(TICK);
        ragdoll.follow(&mut world, &animator, model);
        if tick == 10 {
            ragdoll.go_limp(&mut world, RagdollPart::Limb(HumanoidBone::LeftUpperArm), Vec3::ZERO);
        }
        world.step();
        ragdoll.view(&world).apply(&animator, model, &mut out);
        for (index, (posed, animated)) in out.iter().zip(animator.model_pose()).enumerate() {
            if left_arm.contains(&index) {
                arm_moved |= posed.to_cols_array().map(f32::to_bits) != animated.to_cols_array().map(f32::to_bits);
                continue;
            }
            assert_eq!(posed.to_cols_array().map(f32::to_bits), animated.to_cols_array().map(f32::to_bits), "tick {tick}: joint {index} left the animation");
        }
    }
    assert!(arm_moved, "the limp arm left the animation");
    assert_eq!(ragdoll.mode(HumanoidBone::LeftUpperLeg), Some(RagdollMode::Animated));
    assert_eq!(ragdoll.mode(HumanoidBone::LeftLowerArm), Some(RagdollMode::Limp));
}

/// The largest angle (degrees) between a body's world rotation and its bone's animated one.
fn worst_deviation(ragdoll: &Ragdoll, world: &PhysicsWorld, animator: &Animator, model: Mat4, bones: &[HumanoidBone]) -> f32 {
    let view = ragdoll.view(world);
    bones
        .iter()
        .map(|&bone| {
            let body = view.body_pose(bone).expect("a body").rotation;
            let animated = (model * animator.model_pose()[slot(joint(animator, bone))]).to_scale_rotation_translation().1.normalize();
            body.angle_between(animated).to_degrees()
        })
        .fold(0.0, f32::max)
}

#[test]
fn powered_limbs_hold_within_10_degrees_under_a_50_newton_push_and_recover_blends_back() {
    let animator = animator();
    let mut world = ground_world();
    let model = Mat4::from_translation(Vec3::new(0.0, 0.05, 0.0));
    let mut ragdoll = Ragdoll::build(&mut world, &animator, model, &RagdollProfile::humanoid()).expect("the humanoid builds");
    let limbs: Vec<HumanoidBone> = RagdollProfile::humanoid().parts().iter().skip(1).map(|part| part.bone).collect();
    ragdoll.power(&mut world, RagdollPart::Whole, 1.0);
    assert_eq!(ragdoll.mode(HumanoidBone::Hips), Some(RagdollMode::Animated), "the root stays animated");
    let forearm = ragdoll.body(HumanoidBone::LeftLowerArm).expect("a forearm");
    world.bodies.get_mut(forearm).expect("in the world").add_force(Vec3::new(0.0, 0.0, 50.0), true);
    let mut worst = 0.0f32;
    for _ in 0..120 {
        ragdoll.follow(&mut world, &animator, model);
        world.step();
        worst = worst.max(worst_deviation(&ragdoll, &world, &animator, model, &limbs));
    }
    assert!(worst <= 10.0, "a powered limb strayed {worst}° from the animation");
    world.bodies.get_mut(forearm).expect("in the world").reset_forces(true);

    ragdoll.go_limp(&mut world, RagdollPart::Whole, Vec3::ZERO);
    for _ in 0..60 {
        ragdoll.follow(&mut world, &animator, model);
        world.step();
    }
    let all: Vec<HumanoidBone> = RagdollProfile::humanoid().parts().iter().map(|part| part.bone).collect();
    let limp = worst_deviation(&ragdoll, &world, &animator, model, &all);
    assert!(limp > 10.0, "the limp body fell away from the animation ({limp}°)");
    ragdoll.recover(&mut world, RagdollPart::Whole, 0.5);
    let mut previous = f32::INFINITY;
    for tick in 1..=30 {
        ragdoll.follow(&mut world, &animator, model);
        world.step();
        let now = worst_deviation(&ragdoll, &world, &animator, model, &all);
        assert!(now <= previous + 1.0e-3, "tick {tick}: the blend moved away ({previous}° then {now}°)");
        if tick == 15 {
            assert!(now > 0.5 && now < limp, "halfway through the blend: {now}°");
        }
        previous = now;
    }
    assert!(previous < RECOVERED_DEGREES, "recovered onto the animation: {previous}°");
    assert_eq!(ragdoll.mode(HumanoidBone::LeftLowerLeg), Some(RagdollMode::Animated));
}

/// The 600-tick script: animated, a limp left arm at 60, power at 200, all limp at 300, recover
/// at 450.
fn scripted_run() -> Vec<u64> {
    let mut animator = animator();
    let mut world = ground_world();
    let model = Mat4::from_translation(Vec3::new(0.0, 0.05, 0.0));
    let mut ragdoll = Ragdoll::build(&mut world, &animator, model, &RagdollProfile::humanoid()).expect("the humanoid builds");
    (0..600)
        .map(|tick| {
            animator.update(TICK);
            ragdoll.follow(&mut world, &animator, model);
            match tick {
                60 => ragdoll.go_limp(&mut world, RagdollPart::Limb(HumanoidBone::LeftUpperArm), Vec3::new(0.0, 1.0, 0.5)),
                200 => ragdoll.power(&mut world, RagdollPart::Whole, 0.6),
                300 => ragdoll.go_limp(&mut world, RagdollPart::Whole, Vec3::new(0.5, 0.0, 2.0)),
                450 => ragdoll.recover(&mut world, RagdollPart::Whole, 0.4),
                _ => {}
            }
            world.step();
            ragdoll.digest(&world)
        })
        .collect()
}

#[test]
fn six_hundred_ticks_replay_to_a_bit_exact_physics_digest() {
    let first = scripted_run();
    let second = scripted_run();
    assert_eq!(first, second);
    let distinct: std::collections::BTreeSet<u64> = first.iter().copied().collect();
    assert!(distinct.len() > 500, "the script moves the bodies ({} distinct states)", distinct.len());
}

#[test]
fn hostile_profiles_are_refused_ragdoll_profile_invalid() {
    let animator = animator();
    let humanoid = RagdollProfile::humanoid();
    let parts = humanoid.parts().to_vec();
    let edit = |change: &dyn Fn(&mut Vec<RagdollBody>)| {
        let mut changed = parts.clone();
        change(&mut changed);
        RagdollProfile::from_parts(changed, humanoid.mass())
    };
    let rows: Vec<(&str, RagdollProfile)> = vec![
        ("no parts", RagdollProfile::from_parts(Vec::new(), 70.0)),
        ("mass 0", humanoid.clone().with_mass(0.0)),
        ("mass NaN", humanoid.clone().with_mass(f32::NAN)),
        ("second root", edit(&|p| p[1].parent = None)),
        ("parent after child", edit(&|p| p[1].parent = Some(5))),
        ("bone twice", edit(&|p| p[2].bone = HumanoidBone::Spine)),
        ("zero radius", edit(&|p| p[3].radius_share = 0.0)),
        ("shares off", edit(&|p| p[4].mass_share = 0.5)),
        ("hinge without a direction", edit(&|p| p[4].joint = RagdollJoint::Hinge { toward: Vec3::ZERO, max: 1.0 })),
        ("ball limit NaN", edit(&|p| p[3].joint = RagdollJoint::Ball { swing: f32::NAN, twist: 1.0 })),
        ("tip is its bone", edit(&|p| p[2].tip = p[2].bone)),
        ("zero-length bone", edit(&|p| p[2].tip = HumanoidBone::Neck)),
    ];
    for (name, profile) in rows {
        let mut world = PhysicsWorld::default();
        let refused = Ragdoll::build(&mut world, &animator, Mat4::IDENTITY, &profile).expect_err(name);
        assert_eq!(refused.code, AnimationErrorCode::RagdollProfileInvalid, "{name}: {}", refused.detail);
        assert_eq!(refused.code.wire(), "ragdoll-profile-invalid");
        assert_eq!(world.bodies.len(), 0, "{name}: nothing was built");
    }
    // A rig without a humanoid map.
    let rig = import_rig(&support::chain3().glb()).expect("the chain fixture imports");
    let set = Arc::new(AnimSet::new(rig.skeleton().clone(), Vec::new()));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let base = g.layer("base");
    g.state(base, "none", Motion::Empty);
    let chain = Animator::new(set.clone(), &g.build().expect("a graph")).expect("an animator");
    let mut world = PhysicsWorld::default();
    let refused = Ragdoll::build(&mut world, &chain, Mat4::IDENTITY, &humanoid).expect_err("a chain is not a humanoid");
    assert_eq!(refused.code, AnimationErrorCode::RagdollProfileInvalid);
    assert_eq!(world.bodies.len(), 0);
}

/// Advisory budget row (section 4.4): an 11-body humanoid steps in at most 0.15 ms per tick, and
/// 10 ragdolls are recorded for the phone budget (AN-23). Run in release with `--ignored`.
#[test]
#[ignore = "timing row; advisory in lanes, gated on a quiet machine"]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn budget_ragdoll_step() {
    let animator = animator();
    for count in [1usize, 10] {
        let mut world = ground_world();
        let mut ragdolls: Vec<Ragdoll> = (0..count)
            .map(|i| Ragdoll::build(&mut world, &animator, Mat4::from_translation(Vec3::new(i as f32 * 1.5, 0.3, 0.0)), &RagdollProfile::humanoid()).expect("builds"))
            .collect();
        for ragdoll in &mut ragdolls {
            ragdoll.go_limp(&mut world, RagdollPart::Whole, Vec3::new(0.0, 0.0, 1.0));
        }
        let mut samples = Vec::new();
        for _ in 0..600 {
            let started = std::time::Instant::now();
            world.step();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let mean = samples.iter().sum::<f64>() / samples.len() as f64;
        let p95 = samples[samples.len() * 95 / 100];
        println!("BUDGET an20 ragdolls x{count}: step mean {mean:.4} ms, p95 {p95:.4} ms");
    }
}

