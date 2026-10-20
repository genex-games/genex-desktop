//! AN-7: transitions on the pose side. A 0-second transition cuts with no NaN; a transition
//! interrupted at 40 % continues from the blended pose it had reached, with no tick moving the
//! pose more than twice a clip's own per-tick motion; an inertialized switch evaluates one pose a
//! tick where a crossfade evaluates two; the idle → run switch passes the pop metric (on a
//! synthetic humanoid: no UAL clip is in the repository); and the player replays bit for bit.

mod support;

use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, AnimGraphBuilder, Motion, TransitionBuilder};
use genex_anim::import::{Rig, import_rig};
use genex_anim::inertial::{
    HALFLIFE_PER_BLEND_SECOND, InertialOffset, JointVelocity, SETTLED, decay_spring, fast_negexp, halflife_to_damping, velocities,
};
use genex_anim::machine::{Machine, Switched};
use genex_anim::math::Trs;
use genex_anim::params::FloatParam;
use genex_anim::sample::{SampleCursor, Wrap, sample};
use genex_anim::transition::TransitionPlayer;
use genex_anim::{ClipId, LayerId, StateId};
use glam::{Quat, Vec3};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

fn humanoid() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn joint(rig: &Rig, name: &str) -> genex_anim::JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

/// A looping rotation track about X through `angles`, evenly spaced over `seconds`.
fn swing(rig: &Rig, name: &str, seconds: f32, angles: &[f32]) -> Track {
    let last = (angles.len() - 1) as f32;
    let times = (0..angles.len()).map(|k| seconds * k as f32 / last).collect();
    let values = angles.iter().map(|angle| Quat::from_rotation_x(*angle)).collect();
    Track::new(joint(rig, name), Interpolation::Linear, times, TrackValues::Rotation(values)).expect("a track")
}

/// Idle (1 s) holds the legs back and sways the spine; walk (0.8 s) swings the legs ±0.5 rad;
/// run (0.6 s) swings legs ±0.9 and arms ±0.6 rad.
fn clips(rig: &Rig) -> Vec<Clip> {
    let idle = Clip::new(
        "Idle",
        vec![swing(rig, "LeftUpLeg", 1.0, &[-0.6, -0.6]), swing(rig, "RightUpLeg", 1.0, &[-0.6, -0.6]), swing(rig, "Spine", 1.0, &[0.0, 0.05, 0.0])],
    )
    .expect("idle");
    let walk = Clip::new("Walk", vec![swing(rig, "LeftUpLeg", 0.8, &[0.5, -0.5, 0.5]), swing(rig, "RightUpLeg", 0.8, &[-0.5, 0.5, -0.5])]).expect("walk");
    let run = Clip::new(
        "Run",
        vec![
            swing(rig, "LeftUpLeg", 0.6, &[0.9, -0.9, 0.9]),
            swing(rig, "RightUpLeg", 0.6, &[-0.9, 0.9, -0.9]),
            swing(rig, "LeftArm", 0.6, &[-0.6, 0.6, -0.6]),
            swing(rig, "RightArm", 0.6, &[0.6, -0.6, 0.6]),
        ],
    )
    .expect("run");
    vec![idle, walk, run]
}

/// How a test's transitions blend.
type Blend = fn(TransitionBuilder<'_>) -> TransitionBuilder<'_>;

fn named(g: &AnimGraphBuilder<'_>, name: &str) -> ClipId {
    g.clip(name).unwrap_or_else(|| panic!("clip {name}"))
}

/// A clip's pose at `time` (looping), over the rest pose.
fn clip_pose(rig: &Rig, clip: &Clip, time: f32) -> Vec<Trs> {
    let mut pose = rig.skeleton().rest_pose().to_vec();
    sample(clip, time, Wrap::Loop, &mut SampleCursor::new(), &mut pose);
    pose
}

/// What a state shows at `time`: its clip over the rest pose, or the rest pose.
fn state_pose(rig: &Rig, graph: &AnimGraph, clips: &[Clip], state: StateId, time: f32, pose: &mut [Trs]) {
    pose.copy_from_slice(rig.skeleton().rest_pose());
    if let Some(Motion::Clip(motion)) = graph.state_motion(state) {
        sample(&clips[motion.clip_id().raw() as usize], time, Wrap::Loop, &mut SampleCursor::new(), pose);
    }
}

/// The largest move of any joint between two poses: metres of translation or radians of rotation.
fn pose_delta(a: &[Trs], b: &[Trs]) -> f32 {
    a.iter().zip(b).map(|(a, b)| (a.translation - b.translation).length().max(a.rotation.angle_between(b.rotation))).fold(0.0, f32::max)
}

/// The largest per-tick move a clip makes on its own, over one loop.
fn clip_tick_delta(rig: &Rig, clip: &Clip) -> f32 {
    let ticks = (clip.duration() / TICK).ceil() as u32 + 1;
    (0..ticks).map(|k| pose_delta(&clip_pose(rig, clip, k as f32 * TICK), &clip_pose(rig, clip, (k + 1) as f32 * TICK))).fold(0.0, f32::max)
}

fn finite(pose: &[Trs]) -> bool {
    pose.iter().all(Trs::is_finite)
}

/// A machine, its player and what drives them.
struct Rigged {
    rig: Rig,
    clips: Vec<Clip>,
    graph: AnimGraph,
    machine: Machine,
    player: TransitionPlayer,
    layer: LayerId,
}

impl Rigged {
    fn new(rig: Rig, clips: Vec<Clip>, graph: AnimGraph, layer: LayerId) -> Rigged {
        let machine = Machine::new(&graph);
        let player = TransitionPlayer::new(rig.skeleton().rest_pose());
        Rigged { rig, clips, graph, machine, player, layer }
    }

    /// Step the machine and the player one tick; the player's pose.
    fn tick(&mut self, dt: f32) -> Vec<Trs> {
        let switched = self.machine.step(dt);
        self.show(switched, dt)
    }

    fn show(&mut self, switched: Switched, dt: f32) -> Vec<Trs> {
        let Rigged { rig, clips, graph, machine, player, layer } = self;
        player.update(machine, *layer, switched, dt, |state, time, pose| state_pose(rig, graph, clips, state, time, pose)).to_vec()
    }

    /// What the current state alone shows now.
    fn current(&self) -> Vec<Trs> {
        let mut pose = self.rig.skeleton().rest_pose().to_vec();
        let state = self.machine.state(self.layer);
        state_pose(&self.rig, &self.graph, &self.clips, state, self.machine.clip_time(self.layer), &mut pose);
        pose
    }
}

/// idle → walk when `go` passes 0.5 and walk → run when it passes 1.5, each with `blend`.
fn locomotion(blend: Blend) -> (Rigged, FloatParam, [StateId; 3]) {
    let rig = humanoid();
    let clips = clips(&rig);
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let go = g.float("go", 0.0);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let walk = g.state(base, "walk", Motion::clip(named(&g, "Walk")));
    let run = g.state(base, "run", Motion::clip(named(&g, "Run")));
    blend(g.transition(idle, walk).when(go.above(0.5)));
    blend(g.transition(walk, run).when(go.above(1.5)));
    blend(g.transition(idle, run).when(go.above(2.5)));
    let graph = g.build().expect("the graph builds");
    (Rigged::new(rig, clips, graph, base), go, [idle, walk, run])
}

/// The largest per-tick move any of the three clips makes on its own.
fn clip_bound(rigged: &Rigged) -> f32 {
    rigged.clips.iter().map(|clip| clip_tick_delta(&rigged.rig, clip)).fold(0.0, f32::max)
}

#[test]
fn a_zero_second_transition_cuts_with_no_nan() {
    for (label, blend) in [
        ("crossfade(0)", (|t| t.crossfade(0.0)) as Blend),
        ("inertialize(0)", |t| t.inertialize(0.0)),
    ] {
        let (mut rigged, go, [_, walk, _]) = locomotion(blend);
        for _ in 0..20 {
            rigged.tick(TICK);
        }
        rigged.machine.set_float(go, 1.0);
        let before = rigged.player.evaluations();
        let pose = rigged.tick(TICK);
        assert_eq!(rigged.machine.state(rigged.layer), walk, "{label}: the switch happened");
        assert!(!rigged.machine.in_transition(rigged.layer), "{label}: nothing blends");
        assert!(finite(&pose), "{label}: no NaN on the switch tick (Fyrox divides by the 0-second length here)");
        assert_eq!(pose, rigged.current(), "{label}: the switch tick shows the next state alone, bit for bit");
        assert_eq!(rigged.player.evaluations() - before, 1, "{label}: a cut evaluates one pose");
        assert!(!rigged.player.offset().is_active(), "{label}: a cut leaves no offset");
        for _ in 0..10 {
            let pose = rigged.tick(TICK);
            assert_eq!(pose, rigged.current(), "{label}: and stays on it");
        }
    }
}

#[test]
fn hostile_steps_keep_every_pose_finite() {
    let (mut rigged, go, _) = locomotion(|t| t.inertialize(0.2));
    rigged.tick(TICK);
    rigged.machine.set_float(go, 1.0);
    for dt in [TICK, f32::NAN, -1.0, f32::INFINITY, 0.0, f32::MAX, 1e-30, TICK] {
        let pose = rigged.tick(dt);
        assert!(finite(&pose), "dt {dt}: the pose stays finite");
    }
    rigged.machine.set_float(go, 2.0);
    for dt in [0.0, 0.0, TICK, f32::NAN] {
        let pose = rigged.tick(dt);
        assert!(finite(&pose), "dt {dt}: a switch on a zero step stays finite");
    }
}

/// Run idle for half a second, start idle → walk, and at `interrupt_at` of its blend start
/// walk → run. Every tick's pose move, the move on the interrupt tick, and what a player that
/// forgot the blend (walk → run from walk alone) would have shown there.
fn interrupt(blend: Blend, seconds: f32, interrupt_at: f32) -> (Rigged, Vec<f32>, f32, f32) {
    let (mut rigged, go, [_, walk, run]) = locomotion(blend);
    let mut previous = rigged.tick(TICK);
    let mut deltas = Vec::new();
    for _ in 0..30 {
        let pose = rigged.tick(TICK);
        deltas.push(pose_delta(&previous, &pose));
        previous = pose;
    }
    rigged.machine.set_float(go, 1.0);
    let blend_ticks = (seconds * interrupt_at / TICK).round() as u32;
    for _ in 0..blend_ticks {
        let pose = rigged.tick(TICK);
        deltas.push(pose_delta(&previous, &pose));
        previous = pose;
    }
    assert_eq!(rigged.machine.state(rigged.layer), walk);
    assert!(rigged.machine.in_transition(rigged.layer), "still blending into walk");
    rigged.machine.set_float(go, 2.0);
    let pose = rigged.tick(TICK);
    assert_eq!(rigged.machine.state(rigged.layer), run, "the interrupt switched to run");
    let at_interrupt = pose_delta(&previous, &pose);
    deltas.push(at_interrupt);
    // A player that knew only the machine's `from` (walk) would start the new blend from walk.
    let mut forgetful = rigged.rig.skeleton().rest_pose().to_vec();
    let from = rigged.machine.transition(rigged.layer).map_or(walk, |running| running.from);
    let from_time = rigged.machine.transition(rigged.layer).map_or(0.0, |running| running.from_time);
    state_pose(&rigged.rig, &rigged.graph, &rigged.clips, from, from_time, &mut forgetful);
    let forgetful_pop = pose_delta(&previous, &forgetful);
    previous = pose;
    for _ in 0..90 {
        let pose = rigged.tick(TICK);
        deltas.push(pose_delta(&previous, &pose));
        previous = pose;
    }
    (rigged, deltas, at_interrupt, forgetful_pop)
}

#[test]
fn a_crossfade_interrupted_at_40_percent_continues_from_the_blended_pose() {
    let (rigged, deltas, at_interrupt, forgetful_pop) = interrupt(|t| t.crossfade(0.5), 0.5, 0.4);
    let bound = 2.0 * clip_bound(&rigged);
    let worst = deltas.iter().copied().fold(0.0, f32::max);
    println!("AN-7 interrupt crossfade: worst tick {worst:.4} rad, at interrupt {at_interrupt:.4}, forgetful {forgetful_pop:.4}, bound {bound:.4}");
    assert!(forgetful_pop > bound, "the row can fail: starting from walk alone pops {forgetful_pop} past {bound}");
    assert!(at_interrupt <= bound, "the interrupt tick moves {at_interrupt}, over {bound}");
    assert!(worst <= bound, "a tick moved {worst}, over twice the clips' own per-tick motion {bound}");
}

#[test]
fn an_inertialization_interrupted_at_40_percent_continues_from_the_visible_pose() {
    let (rigged, deltas, at_interrupt, _) = interrupt(|t| t.inertialize(0.5), 0.5, 0.4);
    let bound = 2.0 * clip_bound(&rigged);
    let worst = deltas.iter().copied().fold(0.0, f32::max);
    println!("AN-7 interrupt inertialize: worst tick {worst:.4} rad, at interrupt {at_interrupt:.4}, bound {bound:.4}");
    assert!(at_interrupt <= bound, "the interrupt tick moves {at_interrupt}, over {bound}");
    assert!(worst <= bound, "a tick moved {worst}, over twice the clips' own per-tick motion {bound}");
}

#[test]
fn an_inertialized_switch_evaluates_one_pose_a_tick_and_a_crossfade_two() {
    for (label, blend, during) in [
        ("inertialize", (|t| t.inertialize(0.3)) as Blend, 1),
        ("crossfade", |t| t.crossfade(0.3), 2),
    ] {
        let (mut rigged, go, _) = locomotion(blend);
        let start = rigged.player.evaluations();
        rigged.tick(TICK);
        assert_eq!(rigged.player.evaluations() - start, 1, "{label}: one state, one pose");
        rigged.machine.set_float(go, 1.0);
        let mut blending_ticks = 0;
        for _ in 0..60 {
            let before = rigged.player.evaluations();
            rigged.tick(TICK);
            let used = rigged.player.evaluations() - before;
            if rigged.machine.in_transition(rigged.layer) {
                blending_ticks += 1;
                assert_eq!(used, during, "{label}: a tick inside the blend evaluates {during}");
            } else {
                assert_eq!(used, 1, "{label}: after the blend, one pose a tick");
            }
        }
        assert!(blending_ticks >= 17, "{label}: the 0.3 s blend lasted {blending_ticks} ticks");
    }
}

#[test]
fn the_idle_to_run_switch_passes_the_pop_metric() {
    // The plan's row is on the UAL idle → run; no UAL clip is in the repository (C-22 holds the
    // download), so the synthetic humanoid's idle and run stand in. The cut proves the metric
    // can fail.
    for (label, blend, pops) in [
        ("inertialize(0.2)", (|t| t.inertialize(0.2)) as Blend, false),
        ("crossfade(0.2)", |t| t.crossfade(0.2), false),
        ("cut", |t| t.crossfade(0.0), true),
    ] {
        let (mut rigged, go, [_, _, run]) = locomotion(blend);
        let bound = 2.0 * clip_bound(&rigged);
        let mut previous = rigged.tick(TICK);
        for _ in 0..20 {
            previous = rigged.tick(TICK);
        }
        rigged.machine.set_float(go, 3.0);
        let mut worst = 0.0f32;
        for _ in 0..40 {
            let pose = rigged.tick(TICK);
            worst = worst.max(pose_delta(&previous, &pose));
            previous = pose;
        }
        assert_eq!(rigged.machine.state(rigged.layer), run, "{label}: reached run");
        println!("AN-7 pop metric idle → run {label}: worst tick {worst:.4} rad, bound {bound:.4}");
        if pops {
            assert!(worst > bound, "{label}: the cut pops ({worst} over {bound}), so the metric can fail");
        } else {
            assert!(worst <= bound, "{label}: worst tick {worst} over {bound}");
        }
        assert!(finite(&previous), "{label}: finite");
    }
}

#[test]
fn an_inertialized_switch_lands_on_the_next_state_once_settled() {
    let (mut rigged, go, _) = locomotion(|t| t.inertialize(0.2));
    for _ in 0..20 {
        rigged.tick(TICK);
    }
    rigged.machine.set_float(go, 3.0);
    rigged.tick(TICK);
    assert!(rigged.player.offset().is_active(), "the switch left an offset");
    let start = rigged.player.offset().magnitude();
    // 0.2 s later a still offset would be under 3 % of where it started
    // (HALFLIFE_PER_BLEND_SECOND); this one also carries idle's velocity, so allow 10 %.
    for _ in 0..12 {
        rigged.tick(TICK);
    }
    let at_blend_end = rigged.player.offset().magnitude();
    assert!(at_blend_end < 0.1 * start, "at the blend's end the offset is {at_blend_end} of {start}");
    let mut settled_at = None;
    for k in 0..240 {
        let pose = rigged.tick(TICK);
        if !rigged.player.offset().is_active() {
            settled_at = Some(k);
            assert_eq!(pose, rigged.current(), "settled: the next state alone, bit for bit");
            break;
        }
    }
    assert!(settled_at.is_some(), "the offset settles and clears within four seconds");
}

#[test]
fn jump_to_cuts_through_a_running_offset() {
    let (mut rigged, go, [idle, _, _]) = locomotion(|t| t.inertialize(0.5));
    for _ in 0..10 {
        rigged.tick(TICK);
    }
    rigged.machine.set_float(go, 3.0);
    for _ in 0..5 {
        rigged.tick(TICK);
    }
    assert!(rigged.player.offset().is_active());
    rigged.machine.set_float(go, 0.0);
    rigged.machine.jump_to(idle);
    let pose = rigged.show(Switched::default(), 0.0);
    assert_eq!(pose, rigged.current(), "a jump shows the new state alone");
    assert!(!rigged.player.offset().is_active(), "and drops the offset");
}

/// A scripted 600-tick session: `go` changes on a fixed pseudo-random schedule.
fn scripted(rigged: &mut Rigged, go: FloatParam, ticks: u32, from: u32, digests: &mut Vec<u64>) {
    let mut seed = 0x2545_f491_u32.wrapping_add(from);
    for tick in from..from + ticks {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        if tick % 7 == 0 {
            rigged.machine.set_float(go, (seed >> 24) as f32 / 64.0);
        }
        let pose = rigged.tick(TICK);
        assert!(finite(&pose), "tick {tick}: finite");
        digests.push(rigged.player.digest());
    }
}

#[test]
fn the_player_replays_bit_for_bit_and_a_clone_continues_identically() {
    let (mut first, go, _) = locomotion(|t| t.inertialize(0.25));
    let (mut second, _, _) = locomotion(|t| t.inertialize(0.25));
    let mut a = Vec::new();
    let mut b = Vec::new();
    scripted(&mut first, go, 300, 0, &mut a);
    scripted(&mut second, go, 300, 0, &mut b);
    assert_eq!(a, b, "two runs of one script give equal digests every tick");
    let mut clone = Rigged {
        rig: humanoid(),
        clips: first.clips.clone(),
        graph: first.graph.clone(),
        machine: first.machine.clone(),
        player: first.player.clone(),
        layer: first.layer,
    };
    let mut c = Vec::new();
    let mut d = Vec::new();
    scripted(&mut first, go, 300, 300, &mut c);
    scripted(&mut clone, go, 300, 300, &mut d);
    assert_eq!(c, d, "a clone taken mid-run continues bit for bit");
    assert!(first.player.evaluations() >= 600, "every tick evaluated at least one pose");
}

#[test]
#[allow(clippy::disallowed_methods, reason = "the closed form is checked against platform exp on purpose; nothing replays it")]
fn an_offset_starts_at_the_visible_pose_and_decays_by_its_half_life() {
    let rig = humanoid();
    let clips = clips(&rig);
    let source = clip_pose(&rig, &clips[0], 0.3);
    let target = clip_pose(&rig, &clips[2], 0.1);
    let mut offset = InertialOffset::new();
    let still = vec![JointVelocity::ZERO; source.len()];
    offset.start(&source, &still, &target, InertialOffset::halflife_for(0.2));
    assert!(offset.is_active());
    assert_eq!(offset.halflife(), 0.2 * HALFLIFE_PER_BLEND_SECOND);
    let mut shown = target.clone();
    offset.apply(&mut shown);
    assert!(pose_delta(&shown, &source) < 1e-5, "on the switch the offset shows the source pose");

    // A still offset follows the critically damped closed form x(t) = (1 + y t) e^{-y t} x0,
    // y = damping / 2, up to `fast_negexp`'s approximation.
    let h = 0.1;
    let y = halflife_to_damping(h) / 2.0;
    let mut x = Vec3::X;
    let mut v = Vec3::ZERO;
    for _ in 0..6 {
        decay_spring(&mut x, &mut v, h, TICK);
    }
    let t = 6.0 * TICK;
    let exact = (1.0 + y * t) * (-y * t).exp();
    assert!((x.x - exact).abs() < 2e-3, "six steps follow the critically damped closed form: {} vs {exact}", x.x);
    assert!(fast_negexp(0.0) == 1.0 && fast_negexp(50.0) > 0.0 && fast_negexp(50.0) < 1e-3, "negexp stays in (0, 1]");

    // A half-life of 0 is a cut, and a non-finite source leaves a finite (zero) offset.
    offset.start(&source, &still, &target, 0.0);
    assert!(!offset.is_active(), "a 0 half-life is a cut");
    let mut hostile = source.clone();
    hostile[3].translation = Vec3::NAN;
    offset.start(&hostile, &still, &target, 0.05);
    let mut shown = target.clone();
    offset.apply(&mut shown);
    assert!(finite(&shown), "a NaN source never reaches the pose");

    // Velocities of a still pose are zero; a zero dt gives zero, never a NaN.
    let mut out = vec![JointVelocity::ZERO; source.len()];
    velocities(&source, &target, 0.0, &mut out);
    assert!(out.iter().all(|velocity| *velocity == JointVelocity::ZERO));
    velocities(&source, &source, TICK, &mut out);
    assert!(out.iter().all(|velocity| velocity.translation == Vec3::ZERO && velocity.angular.length() < 1e-6));
    // An offset a little over the settle threshold decays, clears, and then leaves poses alone.
    let mut nudged = target.clone();
    nudged[0].translation.x += 4.0 * SETTLED;
    offset.start(&nudged, &still, &target, 0.05);
    assert!(offset.is_active(), "an offset over the threshold runs");
    let ticks = (0..120).take_while(|_| {
        offset.update(TICK);
        offset.is_active()
    });
    assert!(ticks.count() < 119, "it settles within two seconds");
    let mut shown = target.clone();
    offset.apply(&mut shown);
    assert_eq!(shown, target, "a settled offset applies nothing, bit for bit");
}
