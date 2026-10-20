//! AN-9: root motion. A looping walk that crosses its end gives one cycle's forward travel and never
//! the classic wrap bug's large negative jump; blended deltas equal the weighted deltas; an in-place
//! clip gives exactly zero and is flagged; the deltas over one cycle sum to the root's displacement
//! within 1e-5; extraction is deterministic and `RootMotion` is in character space (a Mixamo
//! centimetre armature turned 90° gives metres along the character's forward axis).

mod support;

use genex_anim::clip::{Clip, Interpolation, Property, Track, TrackValues};
use genex_anim::events::Span;
use genex_anim::import::{Rig, import_rig};
use genex_anim::root_motion::{Extracted, MotionAxes, MotionSettings, MotionTrack, RootMotion, blend, extract};
use genex_anim::sample::{SampleCursor, Wrap, sample};
use genex_anim::{AnimationErrorCode, JointId};
use glam::{Mat4, Quat, Vec3};

/// `sin` and `cos` through glam's libm (the platform's are not the same bits everywhere).
fn sin(x: f32) -> f32 {
    glam::Vec2::from_angle(x).y
}

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

fn humanoid() -> Rig {
    import_rig(&support::humanoid22().glb()).expect("the humanoid fixture imports")
}

fn mixamo() -> Rig {
    import_rig(&support::mixamo().glb()).expect("the mixamo fixture imports")
}

fn joint(rig: &Rig, name: &str) -> JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

fn translation(joint: JointId, times: &[f32], values: &[Vec3]) -> Track {
    Track::new(joint, Interpolation::Linear, times.to_vec(), TrackValues::Translation(values.to_vec())).expect("a translation track")
}

fn rotation(joint: JointId, times: &[f32], values: &[Quat]) -> Track {
    Track::new(joint, Interpolation::Linear, times.to_vec(), TrackValues::Rotation(values.to_vec())).expect("a rotation track")
}

/// A 1 s walk: the hips travel 1.2 m along +Z, bob 4 cm, sway 3 cm side to side; the left thigh
/// swings so the clip has more than root tracks.
fn walk(rig: &Rig) -> Clip {
    let hips = joint(rig, "Hips");
    let times = [0.0, 0.25, 0.5, 0.75, 1.0];
    let path = [Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.03, 1.04, 0.3), Vec3::new(0.0, 1.0, 0.6), Vec3::new(-0.03, 1.04, 0.9), Vec3::new(0.0, 1.0, 1.2)];
    let thigh = rotation(joint(rig, "LeftUpLeg"), &[0.0, 0.5, 1.0], &[Quat::from_rotation_x(0.5), Quat::from_rotation_x(-0.5), Quat::from_rotation_x(0.5)]);
    Clip::new("Walk", vec![translation(hips, &times, &path), thigh]).expect("walk")
}

/// A 0.7 s run: 2.8 m along +Z with a slight drift to +X.
fn run(rig: &Rig) -> Clip {
    let hips = joint(rig, "Hips");
    Clip::new("Run", vec![translation(hips, &[0.0, 0.7], &[Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.1, 1.0, 2.8)])]).expect("run")
}

/// An in-place walk: the hips bob 4 cm and sway 2 cm but go nowhere.
fn walk_in_place(rig: &Rig) -> Clip {
    let hips = joint(rig, "Hips");
    let times = [0.0, 0.25, 0.5, 0.75, 1.0];
    let path = [Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.02, 1.04, 0.0), Vec3::new(0.0, 1.0, 0.0), Vec3::new(-0.02, 1.04, 0.0), Vec3::new(0.0, 1.0, 0.0)];
    let thigh = rotation(joint(rig, "LeftUpLeg"), &[0.0, 0.5, 1.0], &[Quat::from_rotation_x(0.5), Quat::from_rotation_x(-0.5), Quat::from_rotation_x(0.5)]);
    Clip::new("WalkInPlace", vec![translation(hips, &times, &path), thigh]).expect("walk in place")
}

/// A 2 s turning walk: the hips curve through an S in the ground plane while their yaw follows the
/// path, ending turned by 0.9 rad.
fn curve(rig: &Rig) -> Clip {
    let hips = joint(rig, "Hips");
    let times: Vec<f32> = (0..=8).map(|k| k as f32 * 0.25).collect();
    let path: Vec<Vec3> = times.iter().map(|t| Vec3::new(0.4 * sin(t * 1.7), 1.0 + 0.02 * sin(t * 6.0), 1.1 * t)).collect();
    let turns: Vec<Quat> = times.iter().map(|t| Quat::from_rotation_y(0.45 * t) * Quat::from_rotation_x(0.08)).collect();
    Clip::new("Curve", vec![translation(hips, &times, &path), rotation(hips, &times, &turns)]).expect("curve")
}

/// A lunge: 0.5 m forward and back again in 1 s (net zero, but it moves).
fn lunge(rig: &Rig) -> Clip {
    let hips = joint(rig, "Hips");
    Clip::new("Lunge", vec![translation(hips, &[0.0, 0.5, 1.0], &[Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 0.9, 0.5), Vec3::new(0.0, 1.0, 0.0)])]).expect("lunge")
}

fn extracted(rig: &Rig, clip: &Clip) -> Extracted {
    extract(rig.skeleton(), clip, &MotionSettings::default()).expect("the clip extracts")
}

/// The root joint's model transform in `clip` at `time` (clamped), over the rest pose.
fn root_model(rig: &Rig, clip: &Clip, root: JointId, time: f32) -> Mat4 {
    let skeleton = rig.skeleton();
    let mut pose = skeleton.rest_pose().to_vec();
    sample(clip, time, Wrap::Clamp, &mut SampleCursor::new(), &mut pose);
    let mut model = vec![Mat4::IDENTITY; pose.len()];
    skeleton.local_to_model(&pose, &mut model);
    model[usize::from(root.raw())]
}

/// Plays `track` as a looping clip for `ticks` ticks of `dt` from time 0, returning each delta.
fn play(track: &MotionTrack, dt: f32, ticks: usize) -> Vec<RootMotion> {
    let mut time = 0.0;
    let mut deltas = Vec::with_capacity(ticks);
    for _ in 0..ticks {
        let span = Span::advance(time, dt, track.duration(), true);
        deltas.push(track.delta(&span));
        time = span.to();
    }
    deltas
}

/// Deltas accumulated into a world position, starting at `position` facing `facing` radians.
fn accumulate(deltas: &[RootMotion], position: Vec3, facing: f32) -> (Vec3, f32) {
    deltas.iter().fold((position, facing), |(position, facing), delta| (position + delta.in_world(Quat::from_rotation_y(facing)), facing + delta.yaw))
}

#[test]
fn a_looping_walk_that_crosses_its_end_travels_one_cycle_forward_never_back() {
    let rig = humanoid();
    let motion = extracted(&rig, &walk(&rig)).motion;
    assert!(!motion.in_place(), "a 1.2 m/s walk is not in place");
    // Three cycles at 60 Hz: every tick moves forward about 2 cm, the wrap ticks included.
    let deltas = play(&motion, TICK, 180);
    for (tick, delta) in deltas.iter().enumerate() {
        assert!(delta.translation.z > 0.015 && delta.translation.z < 0.025, "tick {tick} moved {:?}", delta.translation);
    }
    // Ticks that land off the cycle (dt 0.07 never divides 1 s) wrap mid-tick and still move dt × 1.2.
    for (tick, delta) in play(&motion, 0.07, 100).iter().enumerate() {
        assert!((delta.translation.z - 0.07 * 1.2).abs() < 1e-4, "tick {tick} of 0.07 s moved {:?}", delta.translation);
    }
    // One huge tick of 2.5 s crosses the end twice: 2.5 cycles' travel, and the wrap bug would give
    // 0.6 - 0.0 = 0.6 m (or a negative jump when it starts late in the cycle).
    let span = Span::advance(0.9, 2.5, 1.0, true);
    assert_eq!(span.laps(), 3);
    let delta = motion.delta(&span);
    assert!((delta.translation.z - 3.0).abs() < 1e-5, "2.5 s from 0.9 travelled {:?}", delta.translation);
    // Backwards play crosses the start and travels back by the same amount.
    let back = motion.delta(&Span::advance(0.1, -0.2, 1.0, true));
    assert!((back.translation.z + 0.24).abs() < 1e-5, "backwards over the start travelled {:?}", back.translation);
}

#[test]
fn blended_deltas_equal_the_weighted_deltas() {
    let rig = humanoid();
    let walk = extracted(&rig, &walk(&rig)).motion;
    let run = extracted(&rig, &run(&rig)).motion;
    let a = walk.delta(&Span::advance(0.95, TICK * 3.0, walk.duration(), true));
    let b = run.delta(&Span::advance(0.1, TICK * 3.0, run.duration(), true));
    let mixed = blend(&[(a, 0.3), (b, 0.7)]);
    let expected = a.translation * 0.3 + b.translation * 0.7;
    assert!((mixed.translation - expected).abs().max_element() < 1e-6, "{:?} vs {expected:?}", mixed.translation);
    assert!((mixed.yaw - (a.yaw * 0.3 + b.yaw * 0.7)).abs() < 1e-6);
    // Weights are normalized: 0.6 and 1.4 mean the same.
    let unnormalized = blend(&[(a, 0.6), (b, 1.4)]);
    assert!((unnormalized.translation - expected).abs().max_element() < 1e-6);
    // NaN, negative and infinite weights count as 0; one usable input comes back bit for bit.
    assert_eq!(blend(&[(a, f32::NAN), (b, 0.4), (a, -1.0), (a, f32::INFINITY)]), b);
    assert_eq!(blend(&[(a, 1.0)]), a);
    assert_eq!(blend(&[(a, 0.0), (b, 0.0)]), RootMotion::ZERO);
    assert_eq!(blend(&[]), RootMotion::ZERO);
}

#[test]
fn an_in_place_clip_gives_zero_and_is_flagged() {
    let rig = humanoid();
    let clip = walk_in_place(&rig);
    let result = extracted(&rig, &clip);
    assert!(result.motion.in_place(), "a clip that bobs and sways in place is flagged");
    assert_eq!(result.clip, clip, "an in-place clip is not baked: its sway stays in the pose");
    for dt in [TICK, 0.07, 0.5, 2.3] {
        for delta in play(&result.motion, dt, 50) {
            assert_eq!(delta, RootMotion::ZERO, "an in-place clip moves nothing at dt {dt}");
        }
    }
    assert!(!extracted(&rig, &walk(&rig)).motion.in_place());
    assert!(!extracted(&rig, &lunge(&rig)).motion.in_place(), "a lunge goes nowhere net but moves");
    assert!(!extracted(&rig, &curve(&rig)).motion.in_place());
}

#[test]
fn deltas_over_one_cycle_sum_to_the_root_displacement() {
    let rig = humanoid();
    let hips = joint(&rig, "Hips");
    for clip in [walk(&rig), run(&rig)] {
        let motion = extracted(&rig, &clip).motion;
        let start = root_model(&rig, &clip, hips, 0.0).w_axis.truncate();
        let end = root_model(&rig, &clip, hips, clip.duration()).w_axis.truncate();
        let displacement = Vec3::new(end.x - start.x, 0.0, end.z - start.z);
        for steps in [60_usize, 37, 7] {
            let dt = clip.duration() / steps as f32;
            let sum = play(&motion, dt, steps).iter().fold(Vec3::ZERO, |sum, delta| sum + delta.translation);
            assert!((sum - displacement).abs().max_element() < 1e-5, "{}: {steps} steps sum to {sum:?}, the root moved {displacement:?}", clip.name());
        }
        let cycle = motion.cycle();
        assert!((cycle.translation - displacement).abs().max_element() < 1e-5);
    }
    // A turning clip accumulated in the world from its first frame lands on its last.
    let clip = curve(&rig);
    let motion = extracted(&rig, &clip).motion;
    let first = root_model(&rig, &clip, hips, 0.0);
    let last = root_model(&rig, &clip, hips, clip.duration());
    let yaw_of = |m: &Mat4| {
        let forward = m.transform_vector3(Vec3::Z);
        glam::Vec2::new(forward.z, forward.x).to_angle()
    };
    let start = Vec3::new(first.w_axis.x, 0.0, first.w_axis.z);
    let (position, facing) = accumulate(&play(&motion, TICK, 120), start, yaw_of(&first));
    let target = Vec3::new(last.w_axis.x, 0.0, last.w_axis.z);
    assert!((position - target).abs().max_element() < 1e-5, "the curve lands at {position:?}, its root ends at {target:?}");
    assert!((facing - yaw_of(&last)).abs() < 1e-5, "facing {facing} vs {}", yaw_of(&last));
}

#[test]
fn extraction_is_deterministic_and_motion_is_in_character_space() {
    let rig = humanoid();
    let clip = curve(&rig);
    let first = extracted(&rig, &clip);
    let second = extracted(&rig, &clip);
    assert_eq!(first, second);
    let bits = |m: &MotionTrack| m.positions().iter().flat_map(|p| p.to_array()).chain(m.yaws().iter().copied()).map(f32::to_bits).collect::<Vec<_>>();
    assert_eq!(bits(&first.motion), bits(&second.motion));
    assert_eq!(play(&first.motion, TICK, 240), play(&second.motion, TICK, 240));

    // A Mixamo armature (turned 90° about X, scale 0.01) whose hips walk 120 cm along their local
    // +Y: the character walks 1.2 m along its forward axis (+Z), in metres.
    let rig = mixamo();
    let hips = joint(&rig, "Hips");
    let rest = rig.skeleton().rest_pose()[usize::from(hips.raw())].translation;
    let clip = Clip::new("mixamo.com", vec![translation(hips, &[0.0, 1.0], &[rest, rest + Vec3::new(0.0, 120.0, 0.0)])]).expect("a mixamo walk");
    let motion = extracted(&rig, &clip).motion;
    let cycle = motion.cycle();
    assert!((cycle.translation - Vec3::new(0.0, 0.0, 1.2)).abs().max_element() < 1e-5, "{:?}", cycle.translation);

    // Hips that face +X (yaw 90°) and walk along +X: in character space the walk is forward (+Z),
    // and in the world it goes wherever the character faces.
    let rig = humanoid();
    let hips = joint(&rig, "Hips");
    let facing = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
    let sideways = Clip::new("Sideways", vec![translation(hips, &[0.0, 1.0], &[Vec3::new(0.0, 1.0, 0.0), Vec3::new(1.0, 1.0, 0.0)]), rotation(hips, &[0.0, 1.0], &[facing, facing])])
        .expect("a sideways walk");
    let delta = extracted(&rig, &sideways).motion.delta(&Span::advance(0.2, 0.1, 1.0, true));
    assert!((delta.translation - Vec3::new(0.0, 0.0, 0.1)).abs().max_element() < 1e-5, "{:?}", delta.translation);
    assert!(delta.yaw.abs() < 1e-6);
    assert!((delta.in_world(Quat::from_rotation_y(-std::f32::consts::FRAC_PI_2)) - Vec3::new(-0.1, 0.0, 0.0)).abs().max_element() < 1e-5);
}

#[test]
fn the_baked_clip_and_its_motion_rebuild_the_original_root() {
    let rig = humanoid();
    let hips = joint(&rig, "Hips");
    for clip in [walk(&rig), curve(&rig), run(&rig)] {
        let result = extracted(&rig, &clip);
        let baked = &result.clip;
        assert!((baked.duration() - clip.duration()).abs() < 1e-6);
        assert_eq!(baked.tracks().len(), clip.tracks().len() + usize::from(!clip.tracks().iter().any(|t| t.joint() == hips && t.property() == Property::Rotation)));
        for &time in result.motion.times() {
            let original = root_model(&rig, &clip, hips, time);
            let in_place = root_model(&rig, baked, hips, time);
            let (position, yaw) = result.motion.at(time);
            let frame = Mat4::from_translation(position) * Mat4::from_quat(Quat::from_rotation_y(yaw));
            let rebuilt = frame * in_place;
            let error = (rebuilt.to_cols_array().iter().zip(original.to_cols_array())).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
            assert!(error < 1e-5, "{} at {time}: rebuilt root off by {error}", clip.name());
            // The baked root stays over the character's origin, facing forward.
            assert!(in_place.w_axis.x.abs() < 1e-5 && in_place.w_axis.z.abs() < 1e-5, "{} at {time}: baked root at {:?}", clip.name(), in_place.w_axis);
        }
    }
    // Without baking the clip comes back as it was, with the same motion.
    let clip = walk(&rig);
    let kept = extract(rig.skeleton(), &clip, &MotionSettings { bake: false, ..MotionSettings::default() }).expect("extracts");
    assert_eq!(kept.clip, clip);
    assert_eq!(kept.motion, extracted(&rig, &clip).motion);
}

#[test]
fn axes_choose_what_is_extracted() {
    let rig = humanoid();
    let clip = curve(&rig);
    let translation_only = extract(rig.skeleton(), &clip, &MotionSettings { axes: MotionAxes { yaw: false, ..MotionAxes::GROUND }, ..MotionSettings::default() }).expect("extracts");
    assert!(translation_only.motion.yaws().iter().all(|yaw| *yaw == 0.0));
    let vertical = extract(rig.skeleton(), &walk(&rig), &MotionSettings { axes: MotionAxes { y: true, ..MotionAxes::GROUND }, ..MotionSettings::default() }).expect("extracts");
    let bob = vertical.motion.positions().iter().map(|p| p.y).fold(f32::MIN, f32::max) - vertical.motion.positions().iter().map(|p| p.y).fold(f32::MAX, f32::min);
    assert!((bob - 0.04).abs() < 1e-5, "the vertical bob is extracted: {bob}");
}

#[test]
fn hostile_inputs_refuse_or_move_nothing() {
    let rig = humanoid();
    let clip = walk(&rig);
    let outside = MotionSettings { root: Some(rig.skeleton().joints().last().map(|_| bad_joint(&rig)).expect("a joint")), ..MotionSettings::default() };
    let refused = extract(rig.skeleton(), &clip, &outside).expect_err("a root outside the skeleton is refused");
    assert_eq!(refused.code, AnimationErrorCode::AssetInvalid);
    assert_eq!(refused.code.wire(), "animation-asset-invalid");

    // A clip of no length is in place.
    let hips = joint(&rig, "Hips");
    let still = Clip::new("Still", vec![translation(hips, &[0.0], &[Vec3::new(0.0, 1.0, 0.0)])]).expect("a still clip");
    let result = extracted(&rig, &still);
    assert!(result.motion.in_place());
    assert_eq!(result.motion.delta(&Span::advance(0.0, 1.0, 0.0, true)), RootMotion::ZERO);

    // Spans with NaN or infinite input play nothing, and times outside the clip clamp.
    let motion = extracted(&rig, &clip).motion;
    for span in [Span::advance(f32::NAN, TICK, 1.0, true), Span::advance(0.2, f32::NAN, 1.0, true), Span::advance(0.2, f32::INFINITY, 1.0, true)] {
        assert_eq!(motion.delta(&span), RootMotion::ZERO);
    }
    assert_eq!(motion.at(f32::NAN), motion.at(0.0));
    assert_eq!(motion.at(-5.0), motion.at(0.0));
    assert_eq!(motion.at(9.0), motion.at(1.0));
    // A `once` clip held at its end moves nothing more.
    let held = motion.delta(&Span::advance(1.0, TICK, 1.0, false));
    assert_eq!(held, RootMotion::ZERO);
}

/// A joint handle one past the humanoid's last joint (handles come from a bigger rig).
fn bad_joint(rig: &Rig) -> JointId {
    let big = import_rig(&support::tree("tree60", 60).glb()).expect("the tree imports");
    big.skeleton().joints().nth(rig.skeleton().joint_count()).expect("a joint past the humanoid's end")
}
