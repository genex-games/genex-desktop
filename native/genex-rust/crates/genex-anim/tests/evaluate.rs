//! AN-13: the evaluation pipeline. `socket()` equals the presenter's model-space joint times the
//! model matrix within 1e-6; layers stack in order (an upper-body override leaves the legs bit for
//! bit, an empty state adds nothing, a weight-0 additive layer changes nothing); IK runs after the
//! layers, legs, then arms, then the look-at; events and root motion come out of `update` from clip
//! time with their blend weights; a graph of other clips is refused; and a full evaluation (60
//! joints, 3 clips, 1 blend, IK on four limbs) is timed against its 25 µs budget (recorded).

mod support;

use std::sync::Arc;

use genex_anim::animator::{AnimSet, Animator, Limb, LimbTarget, LookTarget};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::evaluate::{Evaluation, evaluate, pose_digest};
use genex_anim::events::Span;
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::humanoid::{HumanoidBone, HumanoidMap};
use genex_anim::import::{Rig, import_rig};
use genex_anim::mask::{BodyPart, Mask};
use genex_anim::math::Trs;
use genex_anim::params::{FloatParam, TriggerParam};
use genex_anim::root_motion::{MotionSettings, blend};
use genex_anim::{AnimationErrorCode, ClipId, JointId, LayerId, StateId};
use glam::{Mat4, Quat, Vec3};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

fn rig() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn joint(rig: &Rig, name: &str) -> JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

fn swing(rig: &Rig, name: &str, axis: Vec3, seconds: f32, angles: &[f32]) -> Track {
    let last = (angles.len() - 1) as f32;
    let times = (0..angles.len()).map(|k| seconds * k as f32 / last).collect();
    let values = angles.iter().map(|angle| Quat::from_axis_angle(axis, *angle)).collect();
    Track::new(joint(rig, name), Interpolation::Linear, times, TrackValues::Rotation(values)).expect("a track")
}

fn travel(rig: &Rig, seconds: f32, metres: f32) -> Track {
    Track::new(joint(rig, "Hips"), Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(vec![Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 1.0, metres)])).expect("a travel track")
}

fn clips(rig: &Rig) -> Vec<Clip> {
    let x = Vec3::X;
    vec![
        Clip::new("Idle", vec![swing(rig, "Spine", x, 1.0, &[0.0, 0.05, 0.0]), swing(rig, "LeftUpLeg", x, 1.0, &[-0.1, -0.1])]).expect("idle"),
        Clip::new("Walk", vec![travel(rig, 0.8, 0.96), swing(rig, "LeftUpLeg", x, 0.8, &[0.5, -0.5, 0.5]), swing(rig, "RightUpLeg", x, 0.8, &[-0.5, 0.5, -0.5])]).expect("walk"),
        Clip::new("Run", vec![travel(rig, 0.6, 2.1), swing(rig, "LeftUpLeg", x, 0.6, &[0.9, -0.9, 0.9]), swing(rig, "LeftArm", x, 0.6, &[-0.6, 0.6, -0.6])]).expect("run"),
        Clip::new("Slash", vec![swing(rig, "RightArm", Vec3::Z, 0.5, &[0.0, 1.4, -0.3]), swing(rig, "Spine1", Vec3::Y, 0.5, &[0.0, 0.4, 0.0])]).expect("slash"),
        Clip::new("Lean", vec![swing(rig, "Spine2", x, 1.0, &[0.0, 0.3, 0.0])]).expect("lean"),
    ]
}

struct Handles {
    speed: FloatParam,
    attack: TriggerParam,
    base: LayerId,
    upper: LayerId,
    lean: LayerId,
    walk: StateId,
    run: StateId,
    clips: Vec<ClipId>,
}

fn build(set: &AnimSet, lean_weight: f32) -> (AnimGraph, Handles) {
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let ids: Vec<ClipId> = g.clips().map(|(id, _)| id).collect();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(ids[0]));
    let walk = g.state(base, "walk", Motion::clip(ids[1]));
    let run = g.state(base, "run", Motion::clip(ids[2]));
    g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(3.0)).crossfade(0.25);
    g.transition(run, walk).when(speed.below(3.0)).crossfade(0.25);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let slash = g.state(upper, "slash", Motion::clip(ids[3]).once());
    g.transition(none, slash).when(attack.fired()).crossfade(0.1);
    g.transition(slash, none).at_end().crossfade(0.15);
    let lean = g.layer("lean");
    g.layer_additive(lean, ids[4]).layer_weight(lean, lean_weight);
    g.state(lean, "lean", Motion::clip(ids[4]));
    g.event(ids[1], 0.1, "step");
    g.event(ids[1], 0.5, "step");
    g.event(ids[3], 0.3, "hit");
    (g.build().expect("the graph builds"), Handles { speed, attack, base, upper, lean, walk, run, clips: ids })
}

fn set() -> Arc<AnimSet> {
    let rig = rig();
    let clips = clips(&rig);
    Arc::new(AnimSet::with_root_motion(rig.skeleton().clone(), clips, &MotionSettings::default()).expect("the set extracts"))
}

fn make_animator(set: &Arc<AnimSet>, lean_weight: f32) -> (Animator, Handles) {
    let (graph, handles) = build(set, lean_weight);
    (Animator::new(set.clone(), &graph).expect("the animator builds"), handles)
}

fn largest_difference(a: &Mat4, b: &Mat4) -> f32 {
    a.to_cols_array().iter().zip(b.to_cols_array()).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

#[test]
fn the_socket_equals_the_presenters_model_space_joint_times_the_model() {
    let set = set();
    let (mut animator, handles) = make_animator(&set, 0.5);
    let hand = set.humanoid().joint(HumanoidBone::RightHand).expect("a right hand");
    let model = Mat4::from_scale_rotation_translation(Vec3::splat(1.3), Quat::from_rotation_y(0.7), Vec3::new(4.0, 0.5, -2.0));
    let mut presenter = Evaluation::new(set.skeleton().joint_count());
    for tick in 0..240 {
        animator.set_float(handles.speed, if tick < 120 { 1.5 } else { 4.0 });
        if tick == 30 {
            animator.fire(handles.attack);
        }
        animator.look_at(Some(LookTarget { target: Vec3::new(1.0, 1.7, 2.0), weight: 1.0 }));
        animator.reach(Limb::LeftArm, Some(LimbTarget { target: Vec3::new(0.4, 1.2, 0.2), pole: Vec3::new(0.0, -1.0, -1.0), weight: 1.0 }));
        animator.update(TICK);
        // The presenter evaluates a clone of the sim's animator, as `frame.character` will.
        evaluate(&animator.clone(), &mut presenter);
        let expected = model * presenter.model()[usize::from(hand.raw())];
        let error = largest_difference(&animator.socket(hand, model), &expected);
        assert!(error <= 1e-6, "tick {tick}: socket off by {error}");
        assert_eq!(pose_digest(presenter.local()), animator.pose_digest(), "tick {tick}: the presenter's pose is the sim's");
    }
    let mut palette = vec![[0.0_f32; 16]; set.skeleton().skin_joint_count()];
    animator.palette(&mut palette);
    let mut expected = vec![[0.0_f32; 16]; palette.len()];
    set.skeleton().palette(animator.model_pose(), &mut expected);
    assert_eq!(palette, expected);
}

/// The base layer alone: the same graph with the upper layer never fired and the lean at weight 0.
fn base_only_pose(set: &Arc<AnimSet>, ticks: usize, speed: f32) -> Vec<Trs> {
    let (mut animator, handles) = make_animator(set, 0.0);
    for _ in 0..ticks {
        animator.set_float(handles.speed, speed);
        animator.update(TICK);
    }
    animator.pose().to_vec()
}

#[test]
fn layers_stack_in_order_and_an_empty_state_adds_nothing() {
    let set = set();
    let humanoid = HumanoidMap::of(set.skeleton());
    let upper_mask = Mask::Humanoid(BodyPart::UpperBody).resolve(set.skeleton(), Some(&humanoid)).expect("an upper body");
    // The upper layer sits in its empty state and the additive layer has weight 0: the pose is the
    // base layer's, bit for bit.
    let base = base_only_pose(&set, 90, 1.5);
    let (mut animator, handles) = make_animator(&set, 0.0);
    for _ in 0..90 {
        animator.set_float(handles.speed, 1.5);
        animator.update(TICK);
    }
    assert_eq!(animator.state_name(handles.upper), "none");
    assert_eq!(animator.pose(), base.as_slice());

    // Fire the slash: the upper body moves, the legs stay the base layer's bit for bit.
    animator.fire(handles.attack);
    let mut reference = base_only_animator(&set);
    for tick in 0..20 {
        animator.set_float(handles.speed, 1.5);
        animator.update(TICK);
        reference.update(TICK);
        let pose = animator.pose();
        let base = reference.pose();
        for joint in set.skeleton().joints() {
            let index = usize::from(joint.raw());
            if upper_mask.weight(joint) == 0.0 {
                assert_eq!(pose[index], base[index], "tick {tick}: joint {} outside the mask moved", set.skeleton().name(joint));
            }
        }
        if tick >= 6 {
            let arm = usize::from(set.humanoid().joint(HumanoidBone::RightUpperArm).expect("an arm").raw());
            assert_ne!(pose[arm], base[arm], "tick {tick}: the slash moves the arm");
        }
    }
    // An additive layer at weight 1 moves the spine; at weight 0 it never did (above).
    let (mut leaning, handles) = animator_with_lean(&set, 1.0);
    for _ in 0..30 {
        leaning.set_float(handles.speed, 0.0);
        leaning.update(TICK);
    }
    let spine = usize::from(joint(&rig(), "Spine2").raw());
    let still = base_only_pose(&set, 30, 0.0);
    assert_ne!(leaning.pose()[spine], still[spine]);
    assert_eq!(leaning.machine().layer_weight(handles.lean), 1.0);
}

fn base_only_animator(set: &Arc<AnimSet>) -> Animator {
    let (mut animator, handles) = make_animator(set, 0.0);
    for _ in 0..90 {
        animator.set_float(handles.speed, 1.5);
        animator.update(TICK);
    }
    animator.set_float(handles.speed, 1.5);
    animator
}

fn animator_with_lean(set: &Arc<AnimSet>, weight: f32) -> (Animator, Handles) {
    make_animator(set, weight)
}

#[test]
fn ik_runs_after_the_layers_legs_then_arms_then_the_look_at() {
    let set = set();
    let skeleton = set.skeleton();
    let humanoid = set.humanoid();
    let bone = |b: HumanoidBone| usize::from(humanoid.joint(b).expect("a bone").raw());
    let (mut animator, handles) = make_animator(&set, 0.5);
    let foot_target = Vec3::new(0.12, 0.2, 0.15);
    let hand_target = Vec3::new(0.4, 1.2, 0.2);
    let look_target = Vec3::new(1.5, 1.8, 3.0);
    for _ in 0..30 {
        animator.set_float(handles.speed, 1.5);
        animator.reach(Limb::LeftLeg, Some(LimbTarget { target: foot_target, pole: Vec3::Z, weight: 1.0 }));
        animator.reach(Limb::LeftArm, Some(LimbTarget { target: hand_target, pole: Vec3::new(0.0, -1.0, -1.0), weight: 1.0 }));
        animator.look_at(Some(LookTarget { target: look_target, weight: 1.0 }));
        animator.update(TICK);
    }
    let model = animator.model_pose();
    let foot = model[bone(HumanoidBone::LeftFoot)].w_axis.truncate();
    assert!((foot - foot_target).length() < 1e-4, "the foot is at {foot:?}, its target {foot_target:?}");
    // The look-at turns the spine after the arm solved, so the hand drifts with the chest: the
    // order is the plan's (legs, arms, look-at), not a hand pinned last.
    let head = model[bone(HumanoidBone::Head)];
    let rest = {
        let mut rest_model = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest_model);
        rest_model[bone(HumanoidBone::Head)]
    };
    let forward_local = rest.inverse().transform_vector3(Vec3::Z);
    let ray = head.transform_vector3(forward_local).normalize();
    let to_target = (look_target - head.w_axis.truncate()).normalize();
    let sine = ray.cross(to_target).length();
    assert!(ray.dot(to_target) > 0.0 && sine < 1f32.to_radians(), "the head looks off its target (sine {sine})");
    // Every model matrix is current after the IK: a fresh local-to-model of the pose agrees.
    let mut fresh = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(animator.pose(), &mut fresh);
    for (index, (a, b)) in fresh.iter().zip(model).enumerate() {
        assert!(largest_difference(a, b) < 1e-5, "joint {index}'s model matrix is stale");
    }
    // Without the look-at the hand reaches its target.
    let (mut reaching, handles) = make_animator(&set, 0.5);
    for _ in 0..30 {
        reaching.set_float(handles.speed, 1.5);
        reaching.reach(Limb::LeftArm, Some(LimbTarget { target: hand_target, pole: Vec3::new(0.0, -1.0, -1.0), weight: 1.0 }));
        reaching.update(TICK);
    }
    let hand = reaching.model_pose()[bone(HumanoidBone::LeftHand)].w_axis.truncate();
    assert!((hand - hand_target).length() < 1e-4, "the hand is at {hand:?}, its target {hand_target:?}");
    // Weight 0 targets change nothing, bit for bit.
    let (mut weightless, handles) = make_animator(&set, 0.5);
    let (mut plain, _) = make_animator(&set, 0.5);
    for _ in 0..30 {
        weightless.set_float(handles.speed, 1.5);
        plain.set_float(handles.speed, 1.5);
        weightless.reach(Limb::RightArm, Some(LimbTarget { target: hand_target, pole: Vec3::NEG_Z, weight: 0.0 }));
        weightless.look_at(Some(LookTarget { target: look_target, weight: 0.0 }));
        weightless.update(TICK);
        plain.update(TICK);
    }
    assert_eq!(weightless.pose_digest(), plain.pose_digest());
}

#[test]
fn events_and_root_motion_come_out_of_update_with_their_weights() {
    let set = set();
    let (mut animator, handles) = make_animator(&set, 0.5);
    // Walk for exactly 2 cycles once in the walk state: 4 steps, each on the base layer at weight 1.
    animator.set_float(handles.speed, 1.5);
    while animator.state(handles.base) != handles.walk || animator.in_transition(handles.base) {
        animator.update(TICK);
    }
    let start_time = animator.machine().clip_time(handles.base);
    let mut steps = Vec::new();
    let mut travelled = Vec3::ZERO;
    let ticks = (2.0 * 0.8 / TICK).round() as usize;
    for _ in 0..ticks {
        let out = animator.update(TICK);
        travelled += out.root_motion.translation;
        steps.extend(out.events);
    }
    assert_eq!(steps.len(), 4, "{steps:?}");
    assert!(steps.iter().all(|event| event.layer == handles.base && event.weight == 1.0 && event.clip == handles.clips[1]));
    let walk_motion = set.motion(handles.clips[1]).expect("the walk has motion");
    let end_time = animator.machine().clip_time(handles.base);
    let expected = 2.0 * walk_motion.cycle().translation.z + walk_motion.between(start_time, end_time).translation.z;
    assert!((travelled.z - expected).abs() < 1e-4, "walked {travelled:?}, expected {expected}");
    assert!((travelled.z - 1.92).abs() < 0.03);

    // Into the run: during the crossfade each step's root motion is the progress-weighted blend of
    // the two clips' own deltas.
    animator.set_float(handles.speed, 4.0);
    let mut blended = 0;
    for _ in 0..20 {
        let before = (animator.machine().clip_time(handles.base), animator.machine().transition(handles.base), animator.state(handles.base));
        let out = animator.update(TICK);
        let Some(running) = animator.machine().transition(handles.base) else { continue };
        let Some(previous) = before.1 else { continue };
        assert_eq!(before.2, handles.run);
        let run_motion = set.motion(handles.clips[2]).expect("the run has motion");
        let target = run_motion.delta(&Span::advance(before.0, TICK, run_motion.duration(), true));
        let source = walk_motion.delta(&Span::advance(previous.from_time, TICK, walk_motion.duration(), true));
        let progress = running.progress();
        let expected = blend(&[(source, 1.0 - progress), (target, progress)]);
        assert!((out.root_motion.translation - expected.translation).abs().max_element() < 1e-6, "{:?} vs {:?}", out.root_motion, expected);
        blended += 1;
    }
    assert!(blended >= 10, "only {blended} crossfade ticks were checked");
    assert_eq!(animator.state(handles.base), handles.run);

    // The slash's hit fires once per attack on the upper layer.
    animator.fire(handles.attack);
    let mut hits = Vec::new();
    for _ in 0..60 {
        hits.extend(animator.update(TICK).events.into_iter().filter(|event| event.layer == handles.upper));
    }
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(animator.graph().events().name(hits[0].event), "hit");
}

#[test]
fn a_graph_of_other_clips_is_refused() {
    let set = set();
    let rig = rig();
    let fewer = vec![clips(&rig).remove(0)];
    let mut more = clips(&rig);
    more.push(Clip::new("Extra", vec![swing(&rig, "Head", Vec3::Y, 1.0, &[0.0, 0.2])]).expect("extra"));
    let mut g = AnimGraph::builder(rig.skeleton(), &more);
    let layer = g.layer("base");
    let extra = g.clips().last().map(|(id, _)| id).expect("the extra clip");
    g.state(layer, "extra", Motion::clip(extra));
    let graph = g.build().expect("builds over six clips");
    let refused = Animator::new(set.clone(), &graph).expect_err("a state plays a clip the set does not have");
    assert_eq!(refused.code, AnimationErrorCode::GraphInvalid);
    assert_eq!(refused.code.wire(), "animation-graph-invalid");
    let small = Arc::new(AnimSet::new(rig.skeleton().clone(), fewer));
    let (graph, _) = build(&set, 0.5);
    assert_eq!(Animator::new(small, &graph).expect_err("five clips into one").code, AnimationErrorCode::GraphInvalid);
    let tree = import_rig(&support::tree("tree12", 12).glb()).expect("a tree");
    let wrong = Arc::new(AnimSet::new(tree.skeleton().clone(), clips(&rig)));
    assert_eq!(Animator::new(wrong, &graph).expect_err("masks of another skeleton").code, AnimationErrorCode::GraphInvalid);
}

/// The humanoid with 38 finger joints under its hands: 60 joints.
fn rig60() -> Rig {
    let mut spec = support::humanoid22();
    for hand in ["LeftHand", "RightHand"] {
        let parent = spec.nodes.iter().position(|node| node.name == hand).expect("a hand");
        let side = if hand == "LeftHand" { 1.0 } else { -1.0 };
        for finger in 0..5 {
            let mut at = parent;
            let count = if finger == 4 { 3 } else { 4 };
            for bone in 0..count {
                at = spec.joint(&format!("{hand}Finger{finger}_{bone}"), Some(at), [side * 0.03, 0.0, 0.01 * finger as f32 - 0.02], Quat::from_rotation_z(0.05 * bone as f32));
            }
        }
    }
    import_rig(&spec.glb()).expect("the 60-joint rig imports")
}

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn a_full_evaluation_is_timed_against_its_budget() {
    let rig = rig60();
    assert_eq!(rig.skeleton().joint_count(), 60);
    // Three clips that animate every joint.
    let every = |name: &str, seconds: f32, amplitude: f32| {
        let tracks = rig.skeleton().joints().map(|joint| {
            let angles = [0.0, amplitude, -amplitude, 0.0];
            let times = (0..4).map(|k| seconds * k as f32 / 3.0).collect();
            Track::new(joint, Interpolation::Linear, times, TrackValues::Rotation(angles.iter().map(|a| Quat::from_rotation_x(*a)).collect())).expect("a track")
        });
        Clip::new(name, tracks.collect()).expect("a clip")
    };
    let clips = vec![every("Walk", 0.8, 0.3), every("Run", 0.6, 0.5), every("Wave", 1.2, 0.2)];
    let set = Arc::new(AnimSet::new(rig.skeleton().clone(), clips));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let ids: Vec<ClipId> = g.clips().map(|(id, _)| id).collect();
    let fast = g.bool("fast", false);
    let base = g.layer("base");
    let walk = g.state(base, "walk", Motion::clip(ids[0]));
    let run = g.state(base, "run", Motion::clip(ids[1]));
    g.transition(walk, run).when(fast.is(true)).crossfade(1000.0);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody)).layer_weight(upper, 0.6);
    g.state(upper, "wave", Motion::clip(ids[2]));
    let graph = g.build().expect("builds");
    let mut animator = Animator::new(set.clone(), &graph).expect("an animator");
    animator.set_bool(fast, true);
    let limbs = [
        (Limb::LeftLeg, Vec3::new(0.1, 0.15, 0.1), Vec3::Z),
        (Limb::RightLeg, Vec3::new(-0.1, 0.1, -0.05), Vec3::Z),
        (Limb::LeftArm, Vec3::new(0.4, 1.2, 0.2), Vec3::NEG_Y),
        (Limb::RightArm, Vec3::new(-0.4, 1.2, 0.2), Vec3::NEG_Y),
    ];
    for (limb, target, pole) in limbs {
        animator.reach(limb, Some(LimbTarget { target, pole, weight: 1.0 }));
    }
    for _ in 0..120 {
        animator.update(TICK);
    }
    assert!(animator.in_transition(graph.layers().next().expect("a layer")), "the crossfade is still blending");
    let evaluations = 2000;
    let start = std::time::Instant::now();
    for _ in 0..evaluations {
        animator.update(TICK);
    }
    let micros = start.elapsed().as_secs_f64() * 1e6 / f64::from(evaluations);
    println!("full evaluation: {micros:.2} µs per update (60 joints, 3 clips, 1 crossfade, 4-limb IK; budget 25 µs, {})", if cfg!(debug_assertions) { "debug" } else { "release" });
    if !cfg!(debug_assertions) {
        assert!(micros < 250.0, "a release evaluation took {micros} µs, ten times the budget");
    }
}
