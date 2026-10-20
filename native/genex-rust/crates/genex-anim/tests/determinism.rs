//! AN-13: the animator replays bit for bit. Two runs of a 3,600-tick script give the same
//! `pose_digest` every tick; a clone updated beside the original stays equal; a snapshot taken at
//! tick 1,800, restored (into a fresh animator, and through its JSON text) and replayed equals the
//! uninterrupted run; and a truncated or damaged snapshot is refused `animation-asset-invalid` with
//! the animator unchanged. (The wasm32 self-test record of `pose_digest` is wired in AN-21.)

mod support;

use std::sync::Arc;

use genex_anim::animator::{AnimSet, Animator, Limb, LimbTarget, LookTarget};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::graph::{AnimGraph, Motion};
use genex_anim::import::{Rig, import_rig};
use genex_anim::mask::{BodyPart, Mask};
use genex_anim::params::{FloatParam, TriggerParam};
use genex_anim::root_motion::MotionSettings;
use genex_anim::{AnimationErrorCode, JointId, LayerId, StateId};
use genex_core::json::{self, Value};
use glam::{Quat, Vec3};

/// `sin` and `cos` through glam's libm (the platform's are not the same bits everywhere).
fn sin(x: f32) -> f32 {
    glam::Vec2::from_angle(x).y
}

fn cos(x: f32) -> f32 {
    glam::Vec2::from_angle(x).x
}

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;
/// The scripted run's length.
const TICKS: usize = 3600;
/// Where the snapshot rows cut the run.
const CUT: usize = 1800;

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

/// Idle, a walk and a run that travel, a once-only slash for the upper body and a lean for an
/// additive layer.
fn clips(rig: &Rig) -> Vec<Clip> {
    let x = Vec3::X;
    vec![
        Clip::new("Idle", vec![swing(rig, "Spine", x, 1.0, &[0.0, 0.05, 0.0]), swing(rig, "LeftUpLeg", x, 1.0, &[-0.1, -0.1])]).expect("idle"),
        Clip::new("Walk", vec![travel(rig, 0.8, 0.96), swing(rig, "LeftUpLeg", x, 0.8, &[0.5, -0.5, 0.5]), swing(rig, "RightUpLeg", x, 0.8, &[-0.5, 0.5, -0.5])]).expect("walk"),
        Clip::new(
            "Run",
            vec![
                travel(rig, 0.6, 2.1),
                swing(rig, "LeftUpLeg", x, 0.6, &[0.9, -0.9, 0.9]),
                swing(rig, "RightUpLeg", x, 0.6, &[-0.9, 0.9, -0.9]),
                swing(rig, "LeftArm", x, 0.6, &[-0.6, 0.6, -0.6]),
            ],
        )
        .expect("run"),
        Clip::new("Slash", vec![swing(rig, "RightArm", Vec3::Z, 0.5, &[0.0, 1.4, -0.3]), swing(rig, "Spine1", Vec3::Y, 0.5, &[0.0, 0.4, 0.0])]).expect("slash"),
        Clip::new("Lean", vec![swing(rig, "Spine2", x, 1.0, &[0.0, 0.3, 0.0])]).expect("lean"),
    ]
}

/// The handles a script drives.
struct Handles {
    speed: FloatParam,
    attack: TriggerParam,
    lean: LayerId,
    idle: StateId,
}

fn build(set: &AnimSet) -> (AnimGraph, Handles) {
    let mut g = AnimGraph::builder(set.skeleton(), set.clips());
    let clip = |name: &str| set.clips().iter().position(|clip| clip.name() == name).expect("a clip");
    let ids: Vec<_> = g.clips().map(|(id, _)| id).collect();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let idle = g.state(base, "idle", Motion::clip(ids[clip("Idle")]));
    let walk = g.state(base, "walk", Motion::clip(ids[clip("Walk")]));
    let run = g.state(base, "run", Motion::clip(ids[clip("Run")]));
    g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(3.0)).crossfade(0.25);
    g.transition(run, walk).when(speed.below(3.0)).crossfade(0.25);
    g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.2);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let slash = g.state(upper, "slash", Motion::clip(ids[clip("Slash")]).once());
    g.transition(none, slash).when(attack.fired()).crossfade(0.1);
    g.transition(slash, none).at_end().crossfade(0.15);
    let lean = g.layer("lean");
    g.layer_additive(lean, ids[clip("Lean")]).layer_weight(lean, 0.5);
    g.state(lean, "lean", Motion::clip(ids[clip("Lean")]));
    g.event(ids[clip("Walk")], 0.1, "step");
    g.event(ids[clip("Walk")], 0.5, "step");
    g.event(ids[clip("Slash")], 0.3, "hit");
    (g.build().expect("the graph builds"), Handles { speed, attack, lean, idle })
}

fn set() -> Arc<AnimSet> {
    let rig = rig();
    let clips = clips(&rig);
    Arc::new(AnimSet::with_root_motion(rig.skeleton().clone(), clips, &MotionSettings::default()).expect("the set extracts"))
}

fn animator(set: &Arc<AnimSet>) -> (Animator, Handles) {
    let (graph, handles) = build(set);
    (Animator::new(set.clone(), &graph).expect("the animator builds"), handles)
}

/// Tick `tick`'s inputs: speed sweeps idle → walk → run → walk → idle, an attack every 400 ticks,
/// a hand reach, a look-at, foot targets and a lean weight that move, a hitch every 499 ticks and a
/// jump back to idle at 3,000. Returns the tick's dt.
fn drive(animator: &mut Animator, handles: &Handles, tick: usize) -> f32 {
    let t = tick as f32 * TICK;
    let speed = match tick % 1200 {
        0..200 => 0.0,
        200..500 => 1.5,
        500..800 => 4.5,
        800..1000 => 2.0,
        _ => 0.05,
    };
    animator.set_float(handles.speed, speed);
    if tick % 400 == 150 {
        animator.fire(handles.attack);
    }
    animator.set_layer_weight(handles.lean, 0.5 + 0.5 * sin(t * 0.7));
    let hand = (1000..2000).contains(&tick).then(|| LimbTarget { target: Vec3::new(0.4 + 0.05 * sin(t * 2.0), 1.2, 0.2 + 0.05 * cos(t)), pole: Vec3::new(0.0, -1.0, -1.0), weight: ((tick - 1000) as f32 / 120.0).min(1.0) });
    animator.reach(Limb::LeftArm, hand);
    let look = (500..3000).contains(&tick).then(|| LookTarget { target: Vec3::new(2.0 * sin(t * 0.3), 1.6, 3.0), weight: 0.8 });
    animator.look_at(look);
    let feet = (2200..2800).contains(&tick);
    animator.reach(Limb::LeftLeg, feet.then(|| LimbTarget { target: Vec3::new(0.09, 0.12, 0.05), pole: Vec3::Z, weight: 0.5 }));
    animator.reach(Limb::RightLeg, feet.then(|| LimbTarget { target: Vec3::new(-0.09, 0.05, -0.05), pole: Vec3::Z, weight: 0.5 }));
    if tick == 3000 {
        animator.jump_to(handles.idle);
    }
    if tick % 499 == 498 { TICK * 2.0 } else { TICK }
}

/// The pose digest after every tick of the script over `range`, with each step's root motion and
/// event count folded in.
fn run(animator: &mut Animator, handles: &Handles, range: std::ops::Range<usize>) -> Vec<(u64, u64)> {
    range
        .map(|tick| {
            let dt = drive(animator, handles, tick);
            let step = animator.update(dt);
            let motion = step.root_motion.translation.to_array().iter().chain([step.root_motion.yaw].iter()).fold(step.events.len() as u64, |hash, v| hash.rotate_left(7) ^ u64::from(v.to_bits()));
            (animator.pose_digest(), motion)
        })
        .collect()
}

#[test]
fn two_runs_of_3600_scripted_ticks_give_the_same_pose_digest_every_tick() {
    let set = set();
    let (mut first, handles) = animator(&set);
    let (mut second, _) = animator(&set);
    let a = run(&mut first, &handles, 0..TICKS);
    let b = run(&mut second, &handles, 0..TICKS);
    assert_eq!(a, b);
    assert_eq!(first.digest(), second.digest());
    // The script exercised what it claims: every base state, the slash and the IK all moved the pose.
    let distinct: std::collections::BTreeSet<u64> = a.iter().map(|(digest, _)| *digest).collect();
    assert!(distinct.len() > TICKS / 2, "only {} distinct poses in {TICKS} ticks", distinct.len());
    println!("pose_digest after {TICKS} ticks: {:016x}", a[TICKS - 1].0);
}

#[test]
fn a_clone_updated_beside_the_original_stays_equal() {
    let set = set();
    let (mut original, handles) = animator(&set);
    run(&mut original, &handles, 0..900);
    let mut clone = original.clone();
    assert_eq!(clone.pose_digest(), original.pose_digest());
    let a = run(&mut original, &handles, 900..TICKS);
    let b = run(&mut clone, &handles, 900..TICKS);
    assert_eq!(a, b);
    assert_eq!(original.digest(), clone.digest());
}

#[test]
fn a_snapshot_restored_and_replayed_equals_the_uninterrupted_run() {
    let set = set();
    let (mut uninterrupted, handles) = animator(&set);
    let whole = run(&mut uninterrupted, &handles, 0..TICKS);

    let (mut cut, _) = animator(&set);
    run(&mut cut, &handles, 0..CUT);
    let snapshot = cut.snapshot();

    // Into a fresh animator of the same set and graph.
    let (mut fresh, _) = animator(&set);
    fresh.restore(&snapshot).expect("the snapshot restores");
    assert_eq!(fresh.pose_digest(), whole[CUT - 1].0, "the restored pose is the pose at the cut");
    assert_eq!(fresh.digest(), cut.digest());
    assert_eq!(run(&mut fresh, &handles, CUT..TICKS), whole[CUT..]);

    // Through the snapshot's JSON text, into an animator that has wandered off since.
    let text = snapshot.dump();
    let parsed = json::parse(&text).expect("the snapshot text parses");
    run(&mut cut, &handles, CUT..CUT + 333);
    cut.restore(&parsed).expect("the parsed snapshot restores");
    assert_eq!(run(&mut cut, &handles, CUT..TICKS), whole[CUT..]);
    assert_eq!(cut.digest(), uninterrupted.digest());
}

/// `value` with the member `key` removed.
fn without(value: &Value, key: &str) -> Value {
    let mut out = Value::object();
    for (name, member) in value.members() {
        if name.as_slice() != key.as_bytes() {
            out.set(name.clone(), member.clone());
        }
    }
    out
}

/// `value` with `key` replaced by `with`.
fn replaced(value: &Value, key: &str, with: Value) -> Value {
    let mut out = value.clone();
    out.set(key, with);
    out
}

/// `items` with its last element dropped.
fn shorter(items: &Value) -> Value {
    let items = items.items();
    Value::Array(items[..items.len().saturating_sub(1)].to_vec())
}

#[test]
fn a_truncated_or_damaged_snapshot_is_refused_and_changes_nothing() {
    let set = set();
    let (mut animator, handles) = animator(&set);
    run(&mut animator, &handles, 0..CUT);
    let snapshot = animator.snapshot();
    let text = snapshot.dump();
    let players = snapshot.get("players").expect("players").clone();
    let first_player = players.items()[0].clone();
    let pose = first_player.get("pose").expect("a player pose").clone();
    let layers = snapshot.get("layers").expect("layers").clone();
    let bad_state = {
        let mut layer = layers.items()[0].clone();
        layer.set("state", Value::from(9999_u32));
        let mut all = layers.items().to_vec();
        all[0] = layer;
        replaced(&snapshot, "layers", Value::Array(all))
    };
    let nan_pose = {
        let mut numbers = pose.items().to_vec();
        numbers[0] = Value::from(f32::NAN.to_bits());
        let mut player = first_player.clone();
        player.set("pose", Value::Array(numbers));
        let mut all = players.items().to_vec();
        all[0] = player;
        replaced(&snapshot, "players", Value::Array(all))
    };
    let short_pose = {
        let mut player = first_player.clone();
        player.set("pose", shorter(&pose));
        let mut all = players.items().to_vec();
        all[0] = player;
        replaced(&snapshot, "players", Value::Array(all))
    };
    let cases = [
        ("the text cut in half, read as far as it parses", json::parse(&text[..text.len() / 2]).unwrap_or(Value::Null)),
        ("no players", without(&snapshot, "players")),
        ("no params", without(&snapshot, "params")),
        ("a layer missing", replaced(&snapshot, "layers", shorter(&layers))),
        ("a player missing", replaced(&snapshot, "players", shorter(&players))),
        ("a pose one number short", short_pose),
        ("a NaN in a pose", nan_pose),
        ("a state of no graph", bad_state),
        ("another version", replaced(&snapshot, "version", Value::from(99_u32))),
        ("another shape", replaced(&snapshot, "shape", Value::from("0000000000000000"))),
        ("not an object", Value::from(3_u32)),
        ("empty", Value::object()),
    ];
    let before = (animator.digest(), animator.pose_digest(), animator.snapshot().dump());
    for (what, damaged) in cases {
        let refused = animator.restore(&damaged).expect_err(what);
        assert_eq!(refused.code, AnimationErrorCode::AssetInvalid, "{what}");
        assert_eq!(refused.code.wire(), "animation-asset-invalid");
        assert_eq!((animator.digest(), animator.pose_digest(), animator.snapshot().dump()), before, "{what} changed the animator");
    }
    // A snapshot of another graph's animator (one more layer) is refused too.
    let rig = rig();
    let other = Arc::new(AnimSet::new(rig.skeleton().clone(), clips(&rig)));
    let mut g = AnimGraph::builder(other.skeleton(), other.clips());
    let only = g.layer("only");
    let id = g.clips().next().map(|(id, _)| id).expect("a clip");
    g.state(only, "idle", Motion::clip(id));
    let mut lonely = Animator::new(other.clone(), &g.build().expect("builds")).expect("an animator");
    assert_eq!(lonely.restore(&snapshot).expect_err("another graph").code, AnimationErrorCode::AssetInvalid);
    // One with the same counts whose base states are named otherwise is refused by its shape.
    let mut g = AnimGraph::builder(other.skeleton(), other.clips());
    let ids: Vec<_> = g.clips().map(|(id, _)| id).collect();
    let speed = g.float("speed", 0.0);
    let attack = g.trigger("attack");
    let base = g.layer("base");
    let stand = g.state(base, "stand", Motion::clip(ids[0]));
    let walk = g.state(base, "walk", Motion::clip(ids[1]));
    let run = g.state(base, "run", Motion::clip(ids[2]));
    g.transition(stand, walk).when(speed.above(0.1)).inertialize(0.2);
    g.transition(walk, run).when(speed.above(3.0)).crossfade(0.25);
    g.transition(run, walk).when(speed.below(3.0)).crossfade(0.25);
    g.transition(walk, stand).when(speed.below(0.1)).inertialize(0.2);
    let upper = g.layer("upper");
    g.layer_mask(upper, Mask::Humanoid(BodyPart::UpperBody));
    let none = g.state(upper, "none", Motion::Empty);
    let slash = g.state(upper, "slash", Motion::clip(ids[3]).once());
    g.transition(none, slash).when(attack.fired()).crossfade(0.1);
    g.transition(slash, none).at_end().crossfade(0.15);
    let lean = g.layer("lean");
    g.layer_additive(lean, ids[4]).layer_weight(lean, 0.5);
    g.state(lean, "lean", Motion::clip(ids[4]));
    let mut renamed = Animator::new(set.clone(), &g.build().expect("builds")).expect("an animator");
    assert_eq!(renamed.restore(&snapshot).expect_err("a graph of another shape").code, AnimationErrorCode::AssetInvalid);
    // And the original snapshot still restores.
    animator.restore(&snapshot).expect("the intact snapshot restores");
}
