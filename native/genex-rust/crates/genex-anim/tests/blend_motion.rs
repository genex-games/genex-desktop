//! Blend states (review gap 14, WP-15): `Motion::blend1d`, `Motion::blend2d` and
//! `Motion::directional` play their clips in step, one shared phase over the weighted mean of the
//! clips' lengths, so a walk blending into a run changes its stride rate smoothly, both clips plant
//! together, root motion at an authored point is that clip's own (no slide) and `speed_by` scales
//! the whole blend. Before this the graph had only `Empty | Clip` and the blend spaces were unwired.

mod support;

use std::sync::Arc;

use genex_anim::animator::{AnimSet, Animator};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::import::{Rig, import_rig};
use genex_anim::params::{FloatParam, Vec2Param};
use genex_anim::root_motion::MotionSettings;
use genex_anim::{AnimationErrorCode, ClipId, JointId, LayerId};
use glam::{Vec2, Vec3};

const TICK: f32 = 1.0 / 60.0;
/// The walk lasts 1 s and travels 1.4 m; the run lasts 0.6 s and travels 2.4 m (4 m/s).
const WALK_SECONDS: f32 = 1.0;
const WALK_SPEED: f32 = 1.4;
const RUN_SECONDS: f32 = 0.6;
const RUN_SPEED: f32 = 4.0;
/// How high each clip lifts the marker joint over one cycle.
const WALK_LIFT: f32 = 1.0;
const RUN_LIFT: f32 = 2.0;

fn rig() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

/// The skeleton's root (its root motion) and a joint below it the clips lift (the marker).
fn joints(rig: &Rig) -> (JointId, JointId) {
    let mut all = rig.skeleton().joints();
    let root = all.next().expect("a root");
    let marker = all.next().expect("a second joint");
    (root, marker)
}

fn line(joint: JointId, seconds: f32, to: Vec3) -> Track {
    Track::new(joint, Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(vec![Vec3::ZERO, to])).expect("a track")
}

/// A clip of `seconds` whose root travels `speed × seconds` forward and whose marker rises `lift`.
fn gait(rig: &Rig, name: &str, seconds: f32, speed: f32, lift: f32) -> Clip {
    let (root, marker) = joints(rig);
    Clip::new(name, vec![line(root, seconds, Vec3::new(0.0, 0.0, speed * seconds)), line(marker, seconds, Vec3::new(0.0, lift, 0.0))]).expect("a clip")
}

fn set() -> Arc<AnimSet> {
    let rig = rig();
    let clips = vec![
        gait(&rig, "Walk", WALK_SECONDS, WALK_SPEED, WALK_LIFT),
        gait(&rig, "Run", RUN_SECONDS, RUN_SPEED, RUN_LIFT),
        gait(&rig, "Left", WALK_SECONDS, WALK_SPEED, 3.0),
        gait(&rig, "Right", WALK_SECONDS, WALK_SPEED, 4.0),
        gait(&rig, "Back", WALK_SECONDS, WALK_SPEED, 5.0),
    ];
    Arc::new(AnimSet::with_root_motion(rig.skeleton().clone(), clips, &MotionSettings::default()).expect("the set extracts"))
}

fn clip(set: &AnimSet, name: &str) -> ClipId {
    AnimGraph::builder(set.skeleton(), set.clips()).clip(name).unwrap_or_else(|| panic!("clip {name}"))
}

/// A locomotion graph: one blend state over `speed` (walk at 1.4, run at 4) scaled by `rate`.
fn locomotion(set: &AnimSet) -> (AnimGraph, FloatParam, FloatParam) {
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let speed = g.float("speed", WALK_SPEED);
    let rate = g.float("rate", 1.0);
    let base = g.layer("base");
    g.state(base, "move", Motion::blend1d(speed, &[(WALK_SPEED, clip(set, "Walk")), (RUN_SPEED, clip(set, "Run"))]).speed_by(rate));
    (g.build().expect("the graph builds"), speed, rate)
}

fn marker_height(set: &AnimSet, animator: &Animator) -> f32 {
    let marker = set.skeleton().joints().nth(1).expect("a second joint");
    animator.pose()[usize::from(marker.raw())].translation.y
}

#[test]
fn the_phase_advances_over_the_weighted_cycle_and_the_pose_is_the_weighted_mean() {
    let set = set();
    let (graph, speed, _) = locomotion(&set);
    let mut animator = Animator::new(set.clone(), &graph).expect("an animator");
    let halfway = (WALK_SPEED + RUN_SPEED) * 0.5;
    animator.set_float(speed, halfway);
    let cycle = 0.5 * WALK_SECONDS + 0.5 * RUN_SECONDS;
    for tick in 1..=30 {
        animator.update(TICK);
        let phase = (tick as f32 * TICK / cycle) % 1.0;
        let time = animator.normalized_time(LayerId(0));
        assert!((time - phase).abs() < 1e-4, "tick {tick}: phase {time}, expected {phase}");
        // Both clips sit at the same phase, mixed half and half.
        let expected = phase * (0.5 * WALK_LIFT + 0.5 * RUN_LIFT);
        let height = marker_height(&set, &animator);
        assert!((height - expected).abs() < 1e-3, "tick {tick}: marker at {height}, expected {expected}");
    }
}

#[test]
fn root_motion_at_an_authored_point_is_that_clips_own_and_speed_by_scales_it() {
    let set = set();
    let (graph, speed, rate) = locomotion(&set);
    let travelled = |at: f32, scale: f32| {
        let mut animator = Animator::new(set.clone(), &graph).expect("an animator");
        animator.set_float(speed, at);
        animator.set_float(rate, scale);
        let ticks = 120;
        (0..ticks).map(|_| animator.update(TICK).root_motion.translation.z).sum::<f32>() / (ticks as f32 * TICK)
    };
    let walk = travelled(WALK_SPEED, 1.0);
    let run = travelled(RUN_SPEED, 1.0);
    assert!((walk - WALK_SPEED).abs() < 0.02, "at the walk's point the feet move at the walk's speed: {walk}");
    assert!((run - RUN_SPEED).abs() < 0.05, "at the run's point, the run's: {run}");
    let between: Vec<f32> = [1.4, 2.0, 2.7, 3.4, 4.0].iter().map(|at| travelled(*at, 1.0)).collect();
    assert!(between.windows(2).all(|pair| pair[1] >= pair[0] - 1e-3), "faster as the speed rises: {between:?}");
    let doubled = travelled(WALK_SPEED, 2.0);
    assert!((doubled - 2.0 * WALK_SPEED).abs() < 0.05, "speed_by doubles the cadence and the travel: {doubled}");
}

#[test]
fn a_directional_blend_weighs_only_the_velocitys_neighbours() {
    let set = set();
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let velocity: Vec2Param = g.vec2("velocity", Vec2::new(0.0, WALK_SPEED));
    let base = g.layer("base");
    let points = [
        (Vec2::new(0.0, WALK_SPEED), clip(&set, "Walk")),
        (Vec2::new(-WALK_SPEED, 0.0), clip(&set, "Left")),
        (Vec2::new(WALK_SPEED, 0.0), clip(&set, "Right")),
        (Vec2::new(0.0, -WALK_SPEED), clip(&set, "Back")),
    ];
    g.state(base, "strafe", Motion::directional(velocity, &points));
    let mut animator = Animator::new(set.clone(), &g.build().expect("builds")).expect("an animator");
    for _ in 0..15 {
        animator.update(TICK);
    }
    let phase = animator.normalized_time(LayerId(0));
    assert!((marker_height(&set, &animator) - phase * WALK_LIFT).abs() < 1e-3, "straight ahead plays the forward clip alone");
    animator.set_vec2(velocity, Vec2::new(WALK_SPEED, 0.0));
    animator.update(TICK);
    let phase = animator.normalized_time(LayerId(0));
    assert!((marker_height(&set, &animator) - phase * 4.0).abs() < 1e-3, "to the right plays the right clip alone");
}

#[test]
fn a_blend_that_does_not_fit_is_refused_graph_invalid() {
    let set = set();
    let refused = |build: &dyn Fn(&mut genex_anim::graph::AnimGraphBuilder<'_>)| {
        let mut g = AnimGraph::builder(set.skeleton(), set.clips());
        build(&mut g);
        g.build().err().map(|error| error.code)
    };
    let walk = clip(&set, "Walk");
    // A clip id past this set's clips: the sixth clip of a larger set.
    let rig = rig();
    let more: Vec<Clip> = (0..6).map(|index| gait(&rig, &format!("Clip{index}"), 1.0, 1.0, 1.0)).collect();
    let foreign = AnimGraph::builder(rig.skeleton(), &more).clip("Clip5").expect("a sixth clip");
    let invalid = Some(AnimationErrorCode::GraphInvalid);
    assert_eq!(
        refused(&|g| {
            let speed = g.float("speed", 0.0);
            let base = g.layer("base");
            g.state(base, "move", Motion::blend1d(speed, &[]));
        }),
        invalid,
        "no point"
    );
    assert_eq!(
        refused(&|g| {
            let speed = g.float("speed", 0.0);
            let base = g.layer("base");
            g.state(base, "move", Motion::blend1d(speed, &[(1.0, walk), (1.0, walk)]));
        }),
        invalid,
        "two clips at one position"
    );
    assert_eq!(
        refused(&|g| {
            let speed = g.float("speed", 0.0);
            let base = g.layer("base");
            g.state(base, "move", Motion::blend1d(speed, &[(0.0, walk), (1.0, foreign)]));
        }),
        invalid,
        "a clip the graph lacks"
    );
    assert_eq!(
        refused(&|g| {
            let speed = g.float("speed", 0.0);
            let base = g.layer("base");
            g.state(base, "move", Motion::blend1d(speed, &[(0.0, walk), (1.0, walk)]).speed(f32::NAN));
        }),
        invalid,
        "a non-finite speed"
    );
}

#[test]
fn a_blend_replays_from_a_snapshot_bit_for_bit() {
    let set = set();
    let (graph, speed, _) = locomotion(&set);
    let mut animator = Animator::new(set.clone(), &graph).expect("an animator");
    let script = |animator: &mut Animator, from: usize, to: usize| {
        for tick in from..to {
            animator.set_float(speed, 1.0 + (tick as f32 * 0.05) % 3.5);
            animator.update(TICK);
        }
    };
    script(&mut animator, 0, 50);
    let saved = animator.snapshot();
    let mut copy = Animator::new(set.clone(), &graph).expect("an animator");
    copy.restore(&saved).expect("restores");
    script(&mut animator, 50, 200);
    script(&mut copy, 50, 200);
    assert_eq!(animator.digest(), copy.digest());
    assert_eq!(animator.pose_digest(), copy.pose_digest());
}
