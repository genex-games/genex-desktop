//! AN-5: the layered state machine, its parameters and conditions. Of two transitions that both
//! hold, the higher priority and then the earlier declaration wins; a trigger fired once is
//! consumed by exactly one transition; `state_ended` never holds on a looping clip and holds from
//! the tick a `once` clip ends; a graph that crosses layers or names a state twice is refused
//! `animation-graph-invalid`; and 10,000 ticks of scripted parameters replay bit for bit.

mod support;

use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, AnimGraphBuilder, Motion, TransitionBlend};
use genex_anim::import::{Rig, import_rig};
use genex_anim::machine::Machine;
use genex_anim::mask::{BodyPart, Mask};
use genex_anim::params::Condition;
use genex_anim::{AnimationError, AnimationErrorCode, LayerId, StateId};
use genex_core::json::Value;
use glam::{Vec2, Vec3};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

fn humanoid() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn tree() -> Rig {
    import_rig(&support::tree("tree12", 12).glb()).expect("the tree fixture imports")
}

/// A clip lasting `seconds` that moves the first joint.
fn clip(rig: &Rig, name: &str, seconds: f32) -> Clip {
    let joint = rig.skeleton().joints().next().expect("a joint");
    let track = Track::new(joint, Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(vec![Vec3::ZERO, Vec3::Y])).expect("a track");
    Clip::new(name, vec![track]).expect("a clip")
}

/// The clips every graph below draws from: idle 1 s, walk 0.8 s, run 0.6 s, slash 0.5 s, wave 1.5 s.
fn clips(rig: &Rig) -> Vec<Clip> {
    vec![clip(rig, "Idle", 1.0), clip(rig, "Walk", 0.8), clip(rig, "Run", 0.6), clip(rig, "Slash", 0.5), clip(rig, "Wave", 1.5)]
}

fn named(g: &AnimGraphBuilder<'_>, name: &str) -> genex_anim::ClipId {
    g.clip(name).unwrap_or_else(|| panic!("clip {name}"))
}

fn refusal(result: Result<AnimGraph, AnimationError>) -> AnimationError {
    match result {
        Ok(_) => panic!("the graph was accepted"),
        Err(error) => error,
    }
}

fn step_until_switch(machine: &mut Machine, layer: LayerId, dt: f32, ticks: u32) -> Option<u32> {
    (1..=ticks).find(|_| machine.step(dt).contains(layer))
}

#[test]
fn the_higher_priority_then_the_earlier_declaration_wins() {
    let rig = humanoid();
    let clips = clips(&rig);
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let go = g.bool("go", false);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let walk = g.state(base, "walk", Motion::clip(named(&g, "Walk")));
    let run = g.state(base, "run", Motion::clip(named(&g, "Run")));
    let wave = g.state(base, "wave", Motion::clip(named(&g, "Wave")));
    // Declared first at the default priority, then a higher one, then a tie at that priority, then
    // an any-state transition at the same priority declared last.
    g.transition(idle, walk).when(go.is(true));
    g.transition(idle, run).when(go.is(true)).priority(2);
    g.transition(idle, wave).when(go.is(true)).priority(2);
    g.transition_from_any(walk).when(go.is(true)).priority(2);
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);
    assert_eq!(machine.state(base), idle, "the first state of a layer is its entry");
    machine.step(TICK);
    assert_eq!(machine.state(base), idle, "nothing holds yet");
    machine.set_bool(go, true);
    assert!(machine.step(TICK).contains(base));
    assert_eq!(machine.state(base), run, "priority 2 beats the earlier priority-0 transition, and run was declared before wave");
    assert_eq!(machine.state_name(base), "run");

    // An any-state transition declared before a state's own at the same priority wins the tie.
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let go = g.bool("go", false);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let walk = g.state(base, "walk", Motion::clip(named(&g, "Walk")));
    let run = g.state(base, "run", Motion::clip(named(&g, "Run")));
    g.transition_from_any(run).when(go.is(true)).priority(1);
    g.transition(idle, walk).when(go.is(true)).priority(1);
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);
    machine.set_bool(go, true);
    machine.step(TICK);
    assert_eq!(machine.state(base), run, "declaration order spans any-state and own transitions");
    // An any-state transition never re-enters the state it leads to.
    let entered = machine.state_seconds(base);
    machine.step(TICK);
    assert_eq!(machine.state(base), run);
    assert!(machine.state_seconds(base) > entered, "run kept playing instead of restarting");
}

#[test]
fn a_trigger_fired_once_is_consumed_by_exactly_one_transition() {
    let rig = humanoid();
    let clips = clips(&rig);
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let slash = g.state(base, "slash", Motion::clip(named(&g, "Slash")).once());
    g.transition(idle, slash).when(attack.fired()).crossfade(0.0);
    g.transition(slash, idle).when(attack.fired()).crossfade(0.0);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let wave = g.state(upper, "wave", Motion::clip(named(&g, "Wave")));
    g.transition(none, wave).when(attack.fired());
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);

    machine.fire(attack);
    machine.fire(attack);
    let switched = machine.step(TICK);
    assert!(switched.contains(base), "the first layer takes the trigger");
    assert!(!switched.contains(upper), "a second layer listening to it sees it consumed");
    assert_eq!((machine.state(base), machine.state(upper)), (slash, none));
    // Firing twice before a step is one trigger: slash does not bounce straight back to idle.
    assert!(machine.step(TICK).is_empty());
    assert_eq!(machine.state(base), slash);

    // A trigger nothing consumes lasts one step: it is gone by the tick after.
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let attack = g.trigger("attack");
    let ready = g.bool("ready", false);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let slash = g.state(base, "slash", Motion::clip(named(&g, "Slash")));
    g.transition(idle, slash).when(attack.fired().and(ready.is(true)));
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);
    machine.fire(attack);
    machine.step(TICK);
    machine.set_bool(ready, true);
    machine.step(TICK);
    assert_eq!(machine.state(base), idle, "a stale trigger never fires a later transition");
    machine.fire(attack);
    machine.step(TICK);
    assert_eq!(machine.state(base), slash);

    // A trigger named only under `not` is read but never consumed.
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let walk = g.state(base, "walk", Motion::clip(named(&g, "Walk")));
    let upper = g.layer("upper");
    let none = g.state(upper, "none", Motion::Empty);
    let wave = g.state(upper, "wave", Motion::clip(named(&g, "Wave")));
    g.transition(idle, walk).when(attack.fired().not().or(Condition::always()));
    g.transition(none, wave).when(attack.fired());
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);
    machine.fire(attack);
    let switched = machine.step(TICK);
    assert!(switched.contains(base) && switched.contains(upper), "the negated read left the trigger for the upper layer");
    assert_eq!((machine.state(base), machine.state(upper)), (walk, wave));
}

#[test]
fn state_ended_never_holds_on_a_loop_and_holds_from_the_tick_a_once_clip_ends() {
    let rig = humanoid();
    let clips = clips(&rig);
    let build = |once: bool, at_end: bool| {
        let mut g = AnimGraph::builder(rig.skeleton(), &clips);
        let base = g.layer("base");
        let motion = Motion::clip(named(&g, "Slash"));
        let slash = g.state(base, "slash", if once { motion.once() } else { motion });
        let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
        if at_end {
            g.transition(slash, idle).at_end();
        } else {
            g.transition(slash, idle).when(Condition::state_ended());
        }
        (g.build().expect("the graph builds"), base, idle)
    };

    // A looping 0.5 s clip for 600 ticks (10 s, 20 loops): never ended.
    let (graph, base, _) = build(false, false);
    let mut machine = Machine::new(&graph);
    assert_eq!(step_until_switch(&mut machine, base, TICK, 600), None, "state_ended held on a looping clip");
    assert!(machine.state_seconds(base) > 9.9);

    // A once clip at a tick that divides it exactly: ends on tick 4 of 0.125 s, not tick 3.
    let (graph, base, idle) = build(true, false);
    let mut machine = Machine::new(&graph);
    assert_eq!(step_until_switch(&mut machine, base, 0.125, 10), Some(4));
    assert_eq!(machine.state(base), idle);

    // At 60 Hz the end tick is the first whose accumulated f32 time reaches 0.5 s.
    let mut time = 0.0f32;
    let expected = (1..).find(|_| {
        time += TICK;
        time >= 0.5
    });
    let (graph, base, _) = build(true, false);
    let mut machine = Machine::new(&graph);
    assert_eq!(step_until_switch(&mut machine, base, TICK, 120), expected);

    // `at_end` on a loop leaves on the tick a cycle completes; on a once clip, the tick it ends.
    let (graph, base, _) = build(false, true);
    let mut machine = Machine::new(&graph);
    assert_eq!(step_until_switch(&mut machine, base, 0.125, 10), Some(4));
    let (graph, base, _) = build(true, true);
    let mut machine = Machine::new(&graph);
    assert_eq!(step_until_switch(&mut machine, base, 0.125, 10), Some(4));

    // A once clip holds its last frame after it ends; the normalized time stays 1.
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let base = g.layer("base");
    g.state(base, "slash", Motion::clip(named(&g, "Slash")).once());
    let graph = g.build().expect("the graph builds");
    let mut machine = Machine::new(&graph);
    for _ in 0..10 {
        machine.step(0.125);
    }
    assert_eq!((machine.clip_time(base), machine.normalized_time(base)), (0.5, 1.0));
}

#[test]
fn a_cross_layer_transition_and_a_duplicate_state_name_are_refused() {
    let rig = humanoid();
    let clips = clips(&rig);
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    let upper = g.layer("upper");
    let wave = g.state(upper, "wave", Motion::clip(named(&g, "Wave")));
    g.transition(idle, wave);
    let error = refusal(g.build());
    assert_eq!(error.code, AnimationErrorCode::GraphInvalid);
    assert_eq!(error.code.wire(), "animation-graph-invalid");

    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let base = g.layer("base");
    g.state(base, "idle", Motion::clip(named(&g, "Idle")));
    g.state(base, "idle", Motion::clip(named(&g, "Walk")));
    assert_eq!(refusal(g.build()).code, AnimationErrorCode::GraphInvalid);

    // The same state name in two layers is two states.
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let base = g.layer("base");
    g.state(base, "none", Motion::Empty);
    let upper = g.layer("upper");
    g.state(upper, "none", Motion::Empty);
    assert!(g.build().is_ok());
}

/// Every hostile graph shape, refused `animation-graph-invalid` (never a panic).
#[test]
fn hostile_graphs_are_refused_graph_invalid() {
    let rig = humanoid();
    let clips = clips(&rig);
    let other_clips = vec![clip(&rig, "Only", 1.0)];
    type Shape = fn(&mut AnimGraphBuilder<'_>, &[Clip]);
    let shapes: [(&str, Shape); 20] = [
        ("no layer", |_, _| {}),
        ("a layer with no state", |g, _| {
            let base = g.layer("base");
            g.state(base, "idle", Motion::Empty);
            g.layer("empty");
        }),
        ("a duplicate layer name", |g, _| {
            let a = g.layer("base");
            g.state(a, "a", Motion::Empty);
            let b = g.layer("base");
            g.state(b, "b", Motion::Empty);
        }),
        ("a duplicate parameter name across kinds", |g, _| {
            g.float("speed", 0.0);
            g.bool("speed", false);
            let base = g.layer("base");
            g.state(base, "idle", Motion::Empty);
        }),
        ("a NaN crossfade", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).crossfade(f32::NAN);
        }),
        ("a negative inertialization", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).inertialize(-0.1);
        }),
        ("an infinite crossfade", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).crossfade(f32::INFINITY);
        }),
        ("a NaN threshold", |g, _| {
            let speed = g.float("speed", 0.0);
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).when(speed.above(f32::NAN));
        }),
        ("a NaN state time", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).when(Condition::state_seconds_over(f32::NAN));
        }),
        ("a NaN initial float", |g, _| {
            g.float("speed", f32::NAN);
            let base = g.layer("base");
            g.state(base, "a", Motion::Empty);
        }),
        ("an infinite initial vec2", |g, _| {
            g.vec2("move", Vec2::new(f32::INFINITY, 0.0));
            let base = g.layer("base");
            g.state(base, "a", Motion::Empty);
        }),
        ("a NaN clip speed", |g, clips| {
            let base = g.layer("base");
            let idle = g.clip(clips[0].name()).expect("idle");
            g.state(base, "a", Motion::clip(idle).speed(f32::NAN));
        }),
        ("a NaN layer weight", |g, _| {
            let base = g.layer("base");
            g.state(base, "a", Motion::Empty);
            g.layer_weight(base, f32::NAN);
        }),
        ("at_end out of a state with no clip", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).at_end();
        }),
        ("state_ended on a transition out of a state with no clip", |g, _| {
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            g.transition(a, b).when(Condition::state_ended());
        }),
        ("an additive first layer", |g, clips| {
            let base = g.layer("base");
            g.state(base, "a", Motion::Empty);
            let idle = g.clip(clips[0].name()).expect("idle");
            g.layer_additive(base, idle);
        }),
        ("more layers than the cap", |g, _| {
            for index in 0..=genex_anim::graph::MAX_LAYERS {
                let layer = g.layer(&format!("l{index}"));
                g.state(layer, "a", Motion::Empty);
            }
        }),
        ("a condition deeper than the cap", |g, _| {
            let go = g.bool("go", true);
            let base = g.layer("base");
            let a = g.state(base, "a", Motion::Empty);
            let b = g.state(base, "b", Motion::Empty);
            let mut condition = go.is(true);
            for _ in 0..genex_anim::params::MAX_CONDITION_NODES {
                condition = condition.and(go.is(true));
            }
            g.transition(a, b).when(condition);
        }),
        ("a too-long name", |g, _| {
            let base = g.layer("base");
            g.state(base, &"x".repeat(genex_anim::graph::MAX_NAME_BYTES + 1), Motion::Empty);
        }),
        ("an empty name", |g, _| {
            let base = g.layer("");
            g.state(base, "a", Motion::Empty);
        }),
    ];
    for (shape, build) in shapes {
        let mut g = AnimGraph::builder(rig.skeleton(), &clips);
        build(&mut g, &clips);
        let error = refusal(g.build());
        assert_eq!(error.code, AnimationErrorCode::GraphInvalid, "{shape}: {error}");
    }
    // The tree rig has no humanoid map: a body-part mask refuses.
    let tree = tree();
    let tree_clips = vec![clip(&tree, "Idle", 1.0)];
    let mut g = AnimGraph::builder(tree.skeleton(), &tree_clips);
    let base = g.layer("base");
    g.state(base, "a", Motion::Empty);
    let upper = g.layer("upper");
    g.state(upper, "b", Motion::Empty);
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    assert_eq!(refusal(g.build()).code, AnimationErrorCode::GraphInvalid, "a humanoid mask on a tree");

    // Handles from another graph: a state, a parameter of another kind, a clip past the list.
    let mut foreign = AnimGraph::builder(rig.skeleton(), &other_clips);
    let foreign_flag = foreign.bool("flag", false);
    let foreign_float = foreign.float("x", 0.0);
    let foreign_base = foreign.layer("base");
    let foreign_states: Vec<StateId> = (0..5).map(|k| foreign.state(foreign_base, &format!("s{k}"), Motion::Empty)).collect();
    let foreign_clip = foreign.clip("Only").expect("only");
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    let speed = g.float("speed", 0.0);
    let base = g.layer("base");
    let a = g.state(base, "a", Motion::Empty);
    g.transition(a, foreign_states[4]);
    assert_eq!(refusal(g.build()).code, AnimationErrorCode::GraphInvalid, "a state of another graph");
    let mut g = AnimGraph::builder(rig.skeleton(), &clips);
    g.float("speed", 0.0);
    let base = g.layer("base");
    let a = g.state(base, "a", Motion::Empty);
    let b = g.state(base, "b", Motion::Empty);
    g.transition(a, b).when(foreign_flag.is(true));
    assert_eq!(refusal(g.build()).code, AnimationErrorCode::GraphInvalid, "a float slot read as a bool");
    let mut g = AnimGraph::builder(rig.skeleton(), &other_clips);
    let base = g.layer("base");
    g.state(base, "a", Motion::clip(named(&AnimGraph::builder(rig.skeleton(), &clips), "Wave")));
    assert_eq!(refusal(g.build()).code, AnimationErrorCode::GraphInvalid, "a clip past the graph's clips");
    let _ = (speed, foreign_float, foreign_clip);
}

/// A 3-layer, 12-state graph over every parameter kind and condition shape.
fn locomotion(rig: &Rig, clips: &[Clip]) -> (AnimGraph, Handles) {
    let mut g = AnimGraph::builder(rig.skeleton(), clips);
    let speed = g.float("speed", 0.0);
    let heading = g.vec2("move", Vec2::ZERO);
    let grounded = g.bool("grounded", true);
    let attack = g.trigger("attack");
    let (idle_clip, walk_clip, run_clip, slash_clip, wave_clip) = (named(&g, "Idle"), named(&g, "Walk"), named(&g, "Run"), named(&g, "Slash"), named(&g, "Wave"));

    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(idle_clip));
    let walk = g.state(base, "walk", Motion::clip(walk_clip).speed_by(speed));
    let run = g.state(base, "run", Motion::clip(run_clip).speed(1.25));
    let air = g.state(base, "air", Motion::clip(wave_clip));
    let land = g.state(base, "land", Motion::clip(slash_clip).once());
    g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.15);
    g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(3.0)).synced().crossfade(0.2);
    g.transition(run, walk).when(speed.below(2.5)).synced().crossfade(0.2).interruptible(false);
    g.transition_from_any(air).when(grounded.is(false)).crossfade(0.1).priority(5);
    g.transition(air, land).when(grounded.is(true)).inertialize(0.12);
    g.transition(land, idle).at_end().crossfade(0.15);

    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let slash = g.state(upper, "slash", Motion::clip(slash_clip).once());
    let wave = g.state(upper, "wave", Motion::clip(wave_clip));
    g.transition(none, slash).when(attack.fired()).crossfade(0.08);
    g.transition(slash, none).when(Condition::state_ended()).crossfade(0.15);
    g.transition(none, wave).when(Condition::state_seconds_over(2.0).and(grounded.is(true)));
    g.transition(wave, none).when(attack.fired().or(Condition::state_seconds_over(1.5)));

    let lean = g.layer("lean");
    g.layer_additive(lean, idle_clip).layer_weight(lean, 0.5).layer_mask(lean, Mask::Humanoid(BodyPart::Head));
    let still = g.state(lean, "still", Motion::Empty);
    let tilt = g.state(lean, "tilt", Motion::clip(walk_clip).speed(-1.0));
    let sway = g.state(lean, "sway", Motion::clip(run_clip));
    let rest = g.state(lean, "rest", Motion::Empty);
    g.transition(still, tilt).when(heading.x_above(0.5));
    g.transition(tilt, sway).when(heading.y_below(-0.5).not());
    g.transition(sway, rest).when(Condition::state_seconds_over(0.75));
    g.transition(rest, still).when(heading.x_below(0.5));
    let graph = g.build().expect("the locomotion graph builds");
    (graph, Handles { speed, heading, grounded, attack, layers: [base, upper, lean] })
}

struct Handles {
    speed: genex_anim::params::FloatParam,
    heading: genex_anim::params::Vec2Param,
    grounded: genex_anim::params::BoolParam,
    attack: genex_anim::params::TriggerParam,
    layers: [LayerId; 3],
}

/// A tiny deterministic script source (an LCG; no rand crate).
struct Script(u64);

impl Script {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn unit(&mut self) -> f32 {
        (self.next() % 10_000) as f32 / 10_000.0
    }
}

/// Drive `machine` for `ticks` with scripted parameters; every tick's digest.
fn run(machine: &mut Machine, handles: &Handles, script: &mut Script, ticks: u32) -> Vec<u64> {
    let mut digests = Vec::with_capacity(ticks as usize);
    for _ in 0..ticks {
        match script.next() % 8 {
            0 => machine.set_float(handles.speed, script.unit() * 6.0),
            1 => machine.set_vec2(handles.heading, Vec2::new(script.unit() * 2.0 - 1.0, script.unit() * 2.0 - 1.0)),
            2 => machine.set_bool(handles.grounded, !script.next().is_multiple_of(5)),
            // Rare enough that the upper layer sometimes idles past 2 s and waves.
            3 if script.next().is_multiple_of(16) => machine.fire(handles.attack),
            4 => machine.set_layer_weight(handles.layers[2], script.unit()),
            _ => {}
        }
        machine.step(TICK);
        digests.push(machine.digest());
    }
    digests
}

#[test]
fn ten_thousand_scripted_ticks_replay_bit_for_bit() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let mut first = Machine::new(&graph);
    let mut second = Machine::new(&graph);
    let a = run(&mut first, &handles, &mut Script(7), 10_000);
    let b = run(&mut second, &handles, &mut Script(7), 10_000);
    assert_eq!(a, b, "two runs of one script differ");
    assert_eq!(first, second);
    // The run visits every state of every layer, so the replay covers each transition shape.
    let distinct: std::collections::BTreeSet<u64> = a.iter().copied().collect();
    assert!(distinct.len() > 9_000, "{} distinct digests", distinct.len());

    // A clone taken mid-run continues exactly as the original.
    let mut original = Machine::new(&graph);
    let mut script = Script(7);
    run(&mut original, &handles, &mut script, 5_000);
    let mut copy = original.clone();
    let mut copy_script = Script(script.0);
    assert_eq!(run(&mut original, &handles, &mut script, 5_000), run(&mut copy, &handles, &mut copy_script, 5_000));
    assert_eq!(original.digest(), first.digest());

    // Every tick's digest, folded and pinned: a change to the machine's arithmetic or order shows
    // here even when the runs meet again later (the machine forgets everything but each layer's
    // state), and a wasm32 self-test can compare the same number.
    let bytes: Vec<u8> = a.iter().flat_map(|digest| digest.to_le_bytes()).collect();
    assert_eq!(genex_core::digest::hex64(genex_core::digest::fnv1a64(&bytes)), REPLAY_DIGEST);
}

/// The fold of every tick's digest in `ten_thousand_scripted_ticks_replay_bit_for_bit`.
const REPLAY_DIGEST: &str = "6478a3b6b08dcaea";

#[test]
fn every_state_of_the_locomotion_graph_is_reached() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let mut machine = Machine::new(&graph);
    let mut script = Script(7);
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..10_000 {
        run(&mut machine, &handles, &mut script, 1);
        for layer in handles.layers {
            seen.insert(machine.state_name(layer).to_owned());
        }
    }
    assert_eq!(seen.len(), 12, "states reached: {seen:?}");
}

#[test]
fn a_running_transition_is_reported_and_interrupted_only_when_interruptible() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let base = handles.layers[0];
    let mut machine = Machine::new(&graph);
    machine.set_float(handles.speed, 1.0);
    machine.step(TICK);
    assert_eq!(machine.state_name(base), "walk");
    let transition = machine.transition(base).expect("an inertialized switch is running");
    assert_eq!(transition.blend, TransitionBlend::Inertialize(0.15));
    assert_eq!(machine.graph().state_name(transition.from), "idle");
    assert!(machine.in_transition(base));
    let ticks = (1..=12).find(|_| {
        machine.step(TICK);
        !machine.in_transition(base)
    });
    assert!(matches!(ticks, Some(9 | 10)), "0.15 s at 60 Hz ends after 9 or 10 more ticks: {ticks:?}");

    // Synced: run starts at walk's normalized time.
    machine.set_float(handles.speed, 4.0);
    let before = machine.normalized_time(base);
    machine.step(TICK);
    assert_eq!(machine.state_name(base), "run");
    let walk_after = before + TICK * 4.0 / 0.8;
    let walk_after = walk_after - walk_after.floor();
    assert!((machine.normalized_time(base) - walk_after).abs() < 1e-6, "{} vs {walk_after}", machine.normalized_time(base));

    // run → walk is not interruptible: while it runs, the any-state jump to air waits.
    for _ in 0..30 {
        machine.step(TICK);
    }
    machine.set_float(handles.speed, 1.0);
    machine.step(TICK);
    assert_eq!(machine.state_name(base), "walk");
    machine.set_bool(handles.grounded, false);
    machine.step(TICK);
    assert_eq!(machine.state_name(base), "walk", "a non-interruptible crossfade finishes first");
    let ticks = (1..=14).find(|_| {
        machine.step(TICK);
        machine.state_name(base) == "air"
    });
    assert!(matches!(ticks, Some(11 | 12)), "air waits for the 0.2 s crossfade: {ticks:?}");

    // jump_to cuts with no blend; a zero-second crossfade is a cut too (no NaN anywhere).
    machine.jump_to(graph.state(base, "idle").expect("idle"));
    assert!(!machine.in_transition(base));
    assert_eq!(machine.state_name(base), "idle");
    assert_eq!(machine.state_seconds(base), 0.0);
}

#[test]
fn bad_inputs_never_poison_the_machine() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let mut machine = Machine::new(&graph);
    machine.set_float(handles.speed, f32::NAN);
    machine.set_layer_weight(handles.layers[2], f32::INFINITY);
    for dt in [f32::NAN, f32::INFINITY, -1.0, 0.0, 1e30] {
        machine.step(dt);
        for layer in handles.layers {
            assert!(machine.normalized_time(layer).is_finite() && machine.clip_time(layer).is_finite(), "dt {dt}");
            assert!(machine.state_seconds(layer).is_finite());
        }
    }
    assert_eq!(machine.layer_weight(handles.layers[2]), 1.0, "an infinite weight clamps to 1");
    assert_eq!(machine.state_name(handles.layers[0]), "idle", "a NaN speed compares false both ways");
}

#[test]
fn the_probe_is_stable_json() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let mut machine = Machine::new(&graph);
    machine.set_float(handles.speed, 1.5);
    machine.set_vec2(handles.heading, Vec2::new(0.75, 0.25));
    machine.step(0.25);
    machine.step(0.25);
    let probe = machine.probe();
    let text = String::from_utf8(probe.dump()).expect("utf-8");
    assert_eq!(text, PROBE);
    assert_eq!(probe, machine.clone().probe(), "a clone probes the same");
    assert!(matches!(probe.get("layers"), Some(Value::Array(layers)) if layers.len() == 3));
}

/// The probe of `the_probe_is_stable_json` after two 0.25 s steps.
const PROBE: &str = concat!(
    r#"{"layers":[{"layer":"base","state":"walk","t":0.46875,"seconds":0.25,"weight":1,"from":null,"blend":null},"#,
    r#"{"layer":"upper","state":"none","t":0,"seconds":0.5,"weight":1,"from":null,"blend":null},"#,
    r#"{"layer":"lean","state":"sway","t":0,"seconds":0,"weight":0.5,"from":"tilt","blend":0}],"#,
    r#""params":{"speed":1.5,"move":[0.75,0.25],"grounded":true,"attack":false}}"#
);

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn stepping_a_three_layer_twelve_state_graph_fits_the_budget() {
    let rig = humanoid();
    let clips = clips(&rig);
    let (graph, handles) = locomotion(&rig, &clips);
    let mut machine = Machine::new(&graph);
    let mut script = Script(11);
    run(&mut machine, &handles, &mut script, 1_000);
    const TICKS: u32 = 100_000;
    let started = std::time::Instant::now();
    for _ in 0..TICKS {
        machine.set_float(handles.speed, script.unit() * 6.0);
        machine.step(TICK);
    }
    let micros = started.elapsed().as_secs_f64() * 1e6 / f64::from(TICKS);
    // Recorded, not asserted: lane timings are advisory (plan 4.4); the budget is 2 µs per tick.
    println!("AN-5 budget: 3-layer 12-state step {micros:.3} µs (budget 2 µs)");
    assert!(machine.digest() != 0);
}
