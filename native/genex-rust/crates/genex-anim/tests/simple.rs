//! AN-26: the simple animator. `play_once("Slash")` returns to the looping clip on the tick the
//! slash ends; a crossfade of 0 s (or a negative or NaN one) cuts with no NaN; 600 scripted ticks
//! replay bit for bit and equal, tick by tick, the same script on a hand-built one-layer graph
//! (pose, root motion and events); it is an ordinary animator, so a snapshot restores, a reach
//! moves the arm and a probe names the clip; and a graph animator, a clip of another set or a
//! builder that already declared something is refused without a change.

mod support;

use std::sync::Arc;

use genex_anim::animator::{AnimSet, Animator, AnimatorStep, Limb, LimbTarget};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, DEFAULT_BLEND_SECONDS, Motion, TransitionBlend};
use genex_anim::params::{Condition, FloatParam, TriggerParam};
use genex_anim::import::{Rig, import_rig};
use genex_anim::root_motion::MotionSettings;
use genex_anim::simple::CROSSFADE_LADDER_SECONDS;
use genex_anim::{AnimationErrorCode, ClipId, JointId, LayerId, StateId};
use glam::{Quat, Vec3};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;
/// The scripted run's length.
const TICKS: usize = 600;

fn rig() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn joint(rig: &Rig, name: &str) -> JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

/// A looping rotation track about `axis` through `angles`, evenly spaced over `seconds`.
fn swing(rig: &Rig, name: &str, axis: Vec3, seconds: f32, angles: &[f32]) -> Track {
    let last = (angles.len() - 1) as f32;
    let times = (0..angles.len()).map(|k| seconds * k as f32 / last).collect();
    let values = angles.iter().map(|angle| Quat::from_axis_angle(axis, *angle)).collect();
    Track::new(joint(rig, name), Interpolation::Linear, times, TrackValues::Rotation(values)).expect("a track")
}

fn travel(rig: &Rig, seconds: f32, metres: f32) -> Track {
    let values = vec![Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.02, 1.03, metres * 0.5), Vec3::new(0.0, 1.0, metres)];
    Track::new(joint(rig, "Hips"), Interpolation::Linear, vec![0.0, seconds * 0.5, seconds], TrackValues::Translation(values)).expect("a travel track")
}

/// Idle, a walk and a run that travel, and a half-second slash.
fn clips(rig: &Rig) -> Vec<Clip> {
    let x = Vec3::X;
    vec![
        Clip::new("Idle", vec![swing(rig, "Spine", x, 1.0, &[0.0, 0.05, 0.0]), swing(rig, "LeftUpLeg", x, 1.0, &[-0.1, -0.1])]).expect("idle"),
        Clip::new("Walk", vec![travel(rig, 0.8, 0.96), swing(rig, "LeftUpLeg", x, 0.8, &[0.5, -0.5, 0.5]), swing(rig, "RightUpLeg", x, 0.8, &[-0.5, 0.5, -0.5])]).expect("walk"),
        Clip::new(
            "Run",
            vec![travel(rig, 0.6, 2.1), swing(rig, "LeftUpLeg", x, 0.6, &[0.9, -0.9, 0.9]), swing(rig, "RightUpLeg", x, 0.6, &[-0.9, 0.9, -0.9])],
        )
        .expect("run"),
        Clip::new("Slash", vec![swing(rig, "RightArm", Vec3::Z, 0.5, &[0.0, 1.4, -0.3]), swing(rig, "Spine1", Vec3::Y, 0.5, &[0.0, 0.4, 0.0])]).expect("slash"),
    ]
}

fn set() -> Arc<AnimSet> {
    let rig = rig();
    let clips = clips(&rig);
    Arc::new(AnimSet::with_root_motion(rig.skeleton().clone(), clips, &MotionSettings::default()).expect("the set extracts"))
}

fn clip(set: &AnimSet, name: &str) -> ClipId {
    AnimGraph::builder(set.skeleton(), set.clips()).clip(name).unwrap_or_else(|| panic!("clip {name}"))
}

/// The four clips a script names.
#[derive(Clone, Copy)]
struct Clips {
    idle: ClipId,
    walk: ClipId,
    run: ClipId,
    slash: ClipId,
}

fn named(set: &AnimSet) -> Clips {
    Clips { idle: clip(set, "Idle"), walk: clip(set, "Walk"), run: clip(set, "Run"), slash: clip(set, "Slash") }
}

/// An animator's first (for the simple animator, its only) layer.
fn base(animator: &Animator) -> LayerId {
    animator.graph().layers().next().expect("a layer")
}

fn finite(animator: &Animator) -> bool {
    animator.pose().iter().all(|joint| joint.translation.is_finite() && joint.rotation.is_finite() && joint.scale.is_finite())
}

#[test]
fn play_once_returns_to_the_looping_clip_on_the_end_tick() {
    let set = set();
    let c = named(&set);
    let mut animator = Animator::simple(set.clone()).expect("the simple animator builds");
    assert_eq!(animator.playing_clip(), None, "it shows the rest pose until the first play");
    assert!(animator.play(c.idle));
    for _ in 0..10 {
        animator.update(TICK);
    }
    assert_eq!(animator.playing_clip(), Some(c.idle));
    assert!(animator.play_once(c.slash));
    let length = set.clips()[c.slash.raw() as usize].duration();
    let mut clip_time = 0.0_f32;
    let mut end_tick = None;
    for tick in 0..120 {
        animator.update(TICK);
        assert!(finite(&animator), "tick {tick}: the pose stays finite");
        clip_time += TICK;
        if end_tick.is_none() && clip_time >= length {
            end_tick = Some(tick);
            assert_eq!(animator.playing_clip(), Some(c.idle), "tick {tick}: idle resumes on the tick the slash ends");
            assert!(animator.in_transition(base(&animator)), "the return crossfades");
            break;
        }
        assert_eq!(animator.playing_clip(), Some(c.slash), "tick {tick}: the slash plays to its end");
    }
    assert!(end_tick.is_some(), "the slash ends inside 2 s");
    let transition = animator.machine().transition(base(&animator)).expect("a return blend");
    assert_eq!(transition.blend, TransitionBlend::Crossfade(DEFAULT_BLEND_SECONDS));
}

#[test]
fn play_once_from_rest_holds_its_last_frame() {
    let set = set();
    let c = named(&set);
    let mut animator = Animator::simple(set).expect("builds");
    assert!(animator.play_once(c.slash));
    for _ in 0..90 {
        animator.update(TICK);
    }
    assert_eq!(animator.playing_clip(), Some(c.slash), "with no looping clip before it, the slash holds");
    assert_eq!(animator.normalized_time(base(&animator)), 1.0);
}

#[test]
fn crossfade_at_zero_seconds_cuts_with_no_nan() {
    let set = set();
    let c = named(&set);
    for seconds in [0.0, -1.0, f32::NAN, -0.0] {
        let mut faded = Animator::simple(set.clone()).expect("builds");
        let mut cut = Animator::simple(set.clone()).expect("builds");
        assert!(faded.play(c.idle) && cut.play(c.idle));
        for _ in 0..7 {
            faded.update(TICK);
            cut.update(TICK);
        }
        assert!(faded.crossfade(c.walk, seconds), "{seconds} s");
        assert!(cut.play(c.walk));
        for tick in 0..30 {
            let a = faded.update(TICK);
            let b = cut.update(TICK);
            assert!(finite(&faded), "{seconds} s, tick {tick}: finite");
            assert!(!faded.in_transition(base(&faded)), "{seconds} s, tick {tick}: a cut never blends");
            assert_eq!(faded.pose_digest(), cut.pose_digest(), "{seconds} s, tick {tick}: the same pose as play");
            assert_eq!(a, b);
        }
        assert_eq!(faded.playing_clip(), Some(c.walk));
    }
}

#[test]
fn a_crossfade_rounds_to_the_nearest_ladder_step_and_takes_effect_at_the_next_update() {
    let set = set();
    let c = named(&set);
    let mut animator = Animator::simple(set).expect("builds");
    assert!(animator.play(c.idle));
    animator.update(TICK);
    assert!(animator.crossfade(c.walk, 0.27));
    assert_eq!(animator.playing_clip(), Some(c.idle), "a crossfade is a transition: it starts at the next update");
    animator.update(TICK);
    assert_eq!(animator.playing_clip(), Some(c.walk));
    assert_eq!(animator.machine().transition(base(&animator)).map(|running| running.blend), Some(TransitionBlend::Crossfade(0.25)));
    assert!(animator.crossfade(c.run, 9.0));
    animator.update(TICK);
    let longest = CROSSFADE_LADDER_SECONDS[CROSSFADE_LADDER_SECONDS.len() - 1];
    assert_eq!(animator.machine().transition(base(&animator)).map(|running| running.blend), Some(TransitionBlend::Crossfade(longest)));
    assert!(animator.crossfade(c.walk, 0.001));
    animator.update(TICK);
    assert_eq!(animator.machine().transition(base(&animator)).map(|running| running.blend), Some(TransitionBlend::Crossfade(CROSSFADE_LADDER_SECONDS[0])));
}

#[test]
fn the_last_call_wins_and_a_crossfade_waits_for_a_once_clip() {
    let set = set();
    let c = named(&set);
    let mut animator = Animator::simple(set).expect("builds");
    assert!(animator.play(c.idle));
    animator.update(TICK);
    assert!(animator.crossfade(c.walk, 0.3));
    assert!(animator.play(c.run), "a play after a crossfade in the same tick cancels the crossfade");
    for _ in 0..5 {
        animator.update(TICK);
        assert_eq!(animator.playing_clip(), Some(c.run));
    }
    assert!(animator.play_once(c.slash));
    assert!(animator.crossfade(c.idle, 0.2), "a crossfade during a play_once changes where it returns");
    animator.update(TICK);
    assert_eq!(animator.playing_clip(), Some(c.slash), "the slash is not interrupted");
    for _ in 0..60 {
        assert!(animator.crossfade(c.walk, 0.2), "called every tick, as a locomotion script does");
        animator.update(TICK);
    }
    assert_eq!(animator.playing_clip(), Some(c.walk), "the slash returned into the last crossfade's clip");
    assert!(animator.play_once(c.slash));
    animator.update(TICK);
    assert!(animator.play(c.run), "play interrupts a once clip");
    animator.update(TICK);
    assert_eq!(animator.playing_clip(), Some(c.run));
}

/// One tick of the script, as both animators take it.
#[derive(Clone, Copy, Debug)]
enum Command {
    Play(ClipId),
    Crossfade(ClipId, f32),
    PlayOnce(ClipId),
    Speed(f32),
}

/// The script: idle, walk, run and back, a slash every 150 ticks (from the looping clip it
/// interrupts), a speed change, a crossfade interrupted half way and a hitch in `dt`.
fn script(c: Clips, tick: usize) -> Vec<Command> {
    let mut commands = Vec::new();
    match tick {
        0 => commands.push(Command::Play(c.idle)),
        60 => commands.push(Command::Crossfade(c.walk, 0.25)),
        130 => commands.push(Command::Crossfade(c.run, 0.5)),
        145 => commands.push(Command::Crossfade(c.walk, 0.25)),
        200 => commands.push(Command::Speed(1.25)),
        320 => commands.push(Command::Crossfade(c.idle, 0.5)),
        400 => commands.push(Command::Speed(1.0)),
        420 => commands.push(Command::Play(c.run)),
        520 => commands.push(Command::Crossfade(c.walk, 0.25)),
        _ => {}
    }
    if tick % 150 == 90 {
        commands.push(Command::PlayOnce(c.slash));
    }
    commands
}

fn tick_dt(tick: usize) -> f32 {
    if tick % 97 == 13 { TICK * 3.0 } else { TICK }
}

/// The simple animator through the script: each tick's pose digest, whole-state digest and step.
fn run_simple(set: &Arc<AnimSet>) -> Vec<(u64, u64, AnimatorStep)> {
    let c = named(set);
    let mut animator = Animator::simple(set.clone()).expect("builds");
    (0..TICKS)
        .map(|tick| {
            for command in script(c, tick) {
                let taken = match command {
                    Command::Play(clip) => animator.play(clip),
                    Command::Crossfade(clip, seconds) => animator.crossfade(clip, seconds),
                    Command::PlayOnce(clip) => animator.play_once(clip),
                    Command::Speed(speed) => animator.speed(speed),
                };
                assert!(taken, "tick {tick}: {command:?}");
            }
            let step = animator.update(tick_dt(tick));
            (animator.pose_digest(), animator.digest(), step)
        })
        .collect()
}

/// The same character on a graph a person would write for this script: a rest state, idle, walk
/// and run looping and a once-only slash, every speed scaled by one parameter, an any-state
/// crossfade into each loop on its trigger (each loop with the fade the script gives it), and the
/// slash crossfading back at its end into the loop it interrupted.
struct HandBuilt {
    animator: Animator,
    speed: FloatParam,
    back: FloatParam,
    to: [TriggerParam; 3],
    loops: [StateId; 3],
    slash: StateId,
}

fn hand_built(set: &Arc<AnimSet>) -> HandBuilt {
    let c = named(set);
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let speed = g.float("speed", 1.0);
    let back = g.float("back", 0.0);
    let to = [g.trigger("to idle"), g.trigger("to walk"), g.trigger("to run")];
    let base = g.layer("base");
    g.state(base, "rest", Motion::Empty);
    let loops = [
        g.state(base, "Idle", Motion::clip(c.idle).speed_by(speed)),
        g.state(base, "Walk", Motion::clip(c.walk).speed_by(speed)),
        g.state(base, "Run", Motion::clip(c.run).speed_by(speed)),
    ];
    let slash = g.state(base, "Slash", Motion::clip(c.slash).once().speed_by(speed));
    for (state, (trigger, seconds)) in loops.iter().zip(to.into_iter().zip([0.5, 0.25, 0.5])) {
        g.transition_from_any(*state).when(trigger.fired()).crossfade(seconds).priority(1);
    }
    for (index, state) in loops.iter().enumerate() {
        let value = (index + 1) as f32;
        g.transition(slash, *state).when(Condition::state_ended().and(back.above(value - 0.5)).and(back.below(value + 0.5))).crossfade(DEFAULT_BLEND_SECONDS);
    }
    let graph = g.build().expect("the hand-built graph builds");
    HandBuilt { animator: Animator::new(set.clone(), &graph).expect("an animator"), speed, back, to, loops, slash }
}

fn run_hand_built(set: &Arc<AnimSet>) -> Vec<(u64, AnimatorStep)> {
    let c = named(set);
    let mut hand = hand_built(set);
    let base = base(&hand.animator);
    let loop_of = |clip: ClipId| [c.idle, c.walk, c.run].iter().position(|candidate| *candidate == clip).expect("a looping clip");
    (0..TICKS)
        .map(|tick| {
            for command in script(c, tick) {
                match command {
                    Command::Play(clip) => hand.animator.jump_to(hand.loops[loop_of(clip)]),
                    Command::Crossfade(clip, _) => hand.animator.fire(hand.to[loop_of(clip)]),
                    Command::PlayOnce(_) => {
                        let current = hand.animator.state(base);
                        if let Some(index) = hand.loops.iter().position(|state| *state == current) {
                            hand.animator.set_float(hand.back, (index + 1) as f32);
                        }
                        hand.animator.jump_to(hand.slash);
                    }
                    Command::Speed(speed) => hand.animator.set_float(hand.speed, speed),
                }
            }
            let step = hand.animator.update(tick_dt(tick));
            (hand.animator.pose_digest(), step)
        })
        .collect()
}

#[test]
fn six_hundred_ticks_replay_bit_exact_and_equal_the_hand_built_one_layer_graph() {
    let set = set();
    let first = run_simple(&set);
    let second = run_simple(&set);
    assert_eq!(first, second, "two runs of the script are equal every tick");
    let hand = run_hand_built(&set);
    let mut moved = 0;
    for (tick, ((pose, _, step), (hand_pose, hand_step))) in first.iter().zip(&hand).enumerate() {
        assert_eq!(pose, hand_pose, "tick {tick}: the simple animator's pose is the hand-built graph's, bit for bit");
        assert_eq!(step, hand_step, "tick {tick}: the same root motion and events");
        if step.root_motion.translation.length() > 0.0 {
            moved += 1;
        }
    }
    assert!(moved > 300, "root motion flows through the simple animator ({moved} moving ticks)");
    let distinct: std::collections::BTreeSet<u64> = first.iter().map(|(pose, _, _)| *pose).collect();
    assert!(distinct.len() > 400, "the script animates ({} distinct poses)", distinct.len());
}

#[test]
fn it_is_an_ordinary_animator_snapshot_reach_and_probe() {
    let set = set();
    let c = named(&set);
    let mut animator = Animator::simple(set.clone()).expect("builds");
    assert!(animator.play(c.walk));
    for _ in 0..40 {
        animator.update(TICK);
    }
    let snapshot = animator.snapshot();
    let mut restored = Animator::simple(set.clone()).expect("builds");
    restored.restore(&snapshot).expect("a simple animator's snapshot restores into another");
    assert!(animator.crossfade(c.run, 0.3) && restored.crossfade(c.run, 0.3));
    for tick in 0..60 {
        assert_eq!(animator.update(TICK), restored.update(TICK), "tick {tick}");
        assert_eq!(animator.digest(), restored.digest(), "tick {tick}");
    }
    let probe = String::from_utf8(animator.probe().dump()).expect("utf-8");
    assert!(probe.contains("\"Run\""), "the probe names the playing clip's state: {probe}");
    let rig = rig();
    let hand = joint(&rig, "RightHand");
    let before = animator.model_pose()[usize::from(hand.raw())].w_axis;
    animator.reach(Limb::RightArm, Some(LimbTarget { target: Vec3::new(0.4, 1.6, 0.5), pole: Vec3::new(0.0, -1.0, -1.0), weight: 1.0 }));
    animator.update(TICK);
    let after = animator.model_pose()[usize::from(hand.raw())].w_axis;
    assert!((after - before).length() > 0.05, "IK moves the hand on a simple animator ({before} → {after})");
}

#[test]
fn a_graph_animator_and_a_clip_of_another_set_are_refused_without_a_change() {
    let set = set();
    let c = named(&set);
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let base = g.layer("base");
    g.state(base, "idle", Motion::clip(c.idle));
    let graph = g.build().expect("builds");
    let mut plain = Animator::new(set.clone(), &graph).expect("an animator");
    let digest = plain.digest();
    assert!(!plain.play(c.walk));
    assert!(!plain.crossfade(c.walk, 0.2));
    assert!(!plain.play_once(c.slash));
    assert!(!plain.speed(2.0));
    assert_eq!(plain.playing_clip(), None);
    assert_eq!(plain.digest(), digest, "a graph animator is unchanged");

    let rig = rig();
    let more: Vec<Clip> = clips(&rig).into_iter().chain(clips(&rig).into_iter().map(|clip| Clip::new("Extra", clip.tracks().to_vec()).expect("a clip"))).collect();
    let big = Arc::new(AnimSet::new(rig.skeleton().clone(), more));
    let foreign = AnimGraph::builder(big.skeleton(), big.clips()).clips().last().map(|(id, _)| id).expect("a clip");
    let mut simple = Animator::simple(set.clone()).expect("builds");
    let digest = simple.digest();
    assert!(!simple.play(foreign), "a clip the set lacks");
    assert!(!simple.speed(f32::NAN), "a NaN speed");
    assert!(!simple.speed(f32::INFINITY), "an infinite speed");
    assert_eq!(simple.digest(), digest);
}

#[test]
fn build_simple_refuses_a_builder_that_already_declared_something() {
    let set = set();
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    g.float("mine", 0.0);
    let error = g.build_simple().expect_err("a used builder is refused");
    assert_eq!(error.code, AnimationErrorCode::GraphInvalid);
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    g.layer("mine");
    assert_eq!(g.build_simple().expect_err("refused").code, AnimationErrorCode::GraphInvalid);
    let c = named(&set);
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let hit = g.event(c.slash, 0.25, "hit");
    let graph = g.build_simple().expect("events declared first are kept");
    let mut animator = Animator::new(set.clone(), &graph).expect("an animator");
    assert!(animator.play(c.idle) && animator.play_once(c.slash), "an animator of build_simple's graph is a simple animator");
    let fired = (0..40).flat_map(|_| animator.update(TICK).events).filter(|event| event.event == hit).count();
    assert_eq!(fired, 1, "the slash's hit fires once");
}

/// Advisory, not a gate (lane timings are advisory): the per-update cost of a simple animator over
/// 45 clips (the Universal Animation Library's size), against a two-state graph over the same set.
/// Run with `--release -- --ignored simple_update_cost --nocapture`.
#[test]
#[ignore = "advisory timing: run with --ignored"]
#[allow(clippy::disallowed_types, reason = "the advisory row measures the wall clock on purpose")]
fn simple_update_cost_with_45_clips() {
    let rig = rig();
    let base = clips(&rig);
    let many: Vec<Clip> = (0..45).map(|index| Clip::new(format!("Clip{index}"), base[index % base.len()].tracks().to_vec()).expect("a clip")).collect();
    let set = Arc::new(AnimSet::new(rig.skeleton().clone(), many));
    let first = AnimGraph::builder(set.skeleton(), set.clips()).clips().next().map(|(id, _)| id).expect("a clip");
    let mut simple = Animator::simple(set.clone()).expect("builds");
    assert!(simple.play(first));
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let layer = g.layer("base");
    g.state(layer, "a", Motion::clip(first));
    let mut plain = Animator::new(set.clone(), &g.build().expect("builds")).expect("an animator");
    let time = |animator: &mut Animator| {
        let start = std::time::Instant::now();
        for _ in 0..6000 {
            animator.update(TICK);
        }
        start.elapsed().as_nanos() as f64 / 6000.0
    };
    let (simple_ns, plain_ns) = (time(&mut simple), time(&mut plain));
    println!("simple (45 clips, {} transitions): {simple_ns:.0} ns per update; one-state graph: {plain_ns:.0} ns", simple.graph().transitions().len());
}
