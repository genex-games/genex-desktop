//! AN-2: clips and their sampling. Step and Linear agree with genex-render's `skin.rs` sampler
//! through the oracle files its dump test records (`tests/fixtures/oracle/*.json`); CubicSpline
//! is the glTF Hermite curve (`skin.rs` drops the tangents); a looping clip wraps where `skin.rs`
//! clamps; quaternion keys in opposite hemispheres take the short way; a cursor makes forward and
//! backward playback O(1) key steps per track and never changes a result; hostile clips are
//! refused `animation-asset-invalid` without a panic.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use genex_anim::AnimationErrorCode;
use genex_anim::clip::{Clip, IgnoredChannelReason, Interpolation, Track, TrackValues, import_clips};
use genex_anim::ids::JointId;
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::Trs;
use genex_anim::sample::{SampleCursor, Wrap, clip_time, sample};
use glam::{Mat4, Quat, Vec3};
use support::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec};

/// Allocations, per thread, so parallel tests do not count each other.
struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = ALLOCATIONS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Allocations made on this thread while `run` runs.
fn allocations(run: impl FnOnce()) -> u64 {
    let before = ALLOCATIONS.with(Cell::get);
    run();
    ALLOCATIONS.with(Cell::get) - before
}

/// Step and Linear agree with the oracle to this much per palette element.
const PALETTE_TOLERANCE: f32 = 1e-6;
/// The cubic-spline defect: the Hermite value and `skin.rs`'s lerp of the key values differ by more.
const CUBIC_DEFECT: f32 = 1e-3;
/// Sampling a 60-joint clip at a forward cursor, desktop (advisory in a lane; AN-23 gates it).
const SAMPLE_60_BUDGET_NS: f64 = 5_000.0;
/// One simulation tick.
const TICK: f32 = 1.0 / 60.0;
/// Ticks of the cursor rows: ten seconds.
const TICKS: usize = 600;

fn oracle(name: &str) -> genex_core::json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/oracle").join(format!("{name}.json"));
    let text = std::fs::read(&path).unwrap_or_else(|error| panic!("{path:?}: {error}; genex-render's skin_oracle_dump test writes it"));
    genex_core::json::parse_with_depth(&text, 8).expect("the oracle parses")
}

fn matrices(value: &genex_core::json::Value) -> Vec<[f32; 16]> {
    value.items().iter().map(|m| std::array::from_fn(|k| m.items()[k].as_f64() as f32)).collect()
}

fn import(spec: &support::RigSpec) -> (Rig, Vec<Clip>) {
    let glb = spec.glb();
    let rig = import_rig(&glb).unwrap_or_else(|error| panic!("{}: {error}", spec.name));
    let clips = import_clips(&glb, &rig).unwrap_or_else(|error| panic!("{} clips: {error}", spec.name));
    (rig, clips)
}

fn palette_of(rig: &Rig, locals: &[Trs]) -> Vec<[f32; 16]> {
    let skeleton = rig.skeleton();
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut palette = vec![[0.0; 16]; skeleton.skin_joint_count()];
    skeleton.local_to_model(locals, &mut model);
    skeleton.palette(&model, &mut palette);
    palette
}

/// The largest per-element difference of two palettes.
fn palette_delta(got: &[[f32; 16]], want: &[[f32; 16]]) -> f32 {
    assert_eq!(got.len(), want.len(), "palette length");
    got.iter().zip(want).flat_map(|(g, w)| g.iter().zip(w).map(|(a, b)| (a - b).abs())).fold(0.0, f32::max)
}

/// The pose of `clip` at `time` from the rest pose, with a fresh cursor.
fn pose_at(rig: &Rig, clip: &Clip, time: f32, wrap: Wrap) -> Vec<Trs> {
    let mut pose = rig.skeleton().rest_pose().to_vec();
    sample(clip, time, wrap, &mut SampleCursor::new(), &mut pose);
    pose
}

fn uses_cubic(clip: &Clip) -> bool {
    clip.tracks().iter().any(|track| track.interpolation() == Interpolation::CubicSpline)
}

fn joint(rig: &Rig, name: &str) -> JointId {
    rig.skeleton().find(name).unwrap_or_else(|| panic!("joint {name}"))
}

/// Bits of a pose, for exact comparisons.
fn bits(pose: &[Trs]) -> Vec<u32> {
    pose.iter()
        .flat_map(|trs| trs.translation.to_array().into_iter().chain(trs.rotation.to_array()).chain(trs.scale.to_array()))
        .map(f32::to_bits)
        .collect()
}

/// The glTF cubic Hermite segment, written out independently of the crate.
fn hermite(p0: Vec3, out_tangent: Vec3, p1: Vec3, in_tangent: Vec3, span: f32, s: f32) -> Vec3 {
    let (s2, s3) = (s * s, s * s * s);
    p0 * (2.0 * s3 - 3.0 * s2 + 1.0) + out_tangent * span * (s3 - 2.0 * s2 + s) + p1 * (-2.0 * s3 + 3.0 * s2) + in_tangent * span * (s3 - s2)
}

fn cubic_channel(node: usize, keys: [(Vec3, Vec3, Vec3); 2], times: [f32; 2]) -> ChannelSpec {
    ChannelSpec {
        node,
        path: ChannelPath::Translation,
        interpolation: ChannelInterpolation::CubicSpline,
        times: times.to_vec(),
        values: keys.iter().flat_map(|(a, v, b)| a.to_array().into_iter().chain(v.to_array()).chain(b.to_array())).collect(),
    }
}

// ---- Red row 1: CubicSpline is the Hermite curve, not skin.rs's lerp of the values ----

#[test]
fn a_cubic_spline_clip_between_keys_is_the_hermite_value_and_the_renderers_lerp_misses_it() {
    // chain3's "Cubic" clip, recorded by the oracle as skin.rs samples it (linear on the values).
    let spec = support::chain3();
    let (rig, clips) = import(&spec);
    let cubic = clips.iter().find(|clip| clip.name() == "Cubic").expect("the Cubic clip");
    let recorded = oracle(spec.name);
    let oracle_clip = recorded["clips"].items().iter().find(|clip| clip["name"].as_str() == "Cubic").expect("the oracle's Cubic clip");
    let channel = &spec.clips.iter().find(|clip| clip.name == "Cubic").expect("spec").channels[0];
    let key = |k: usize| Vec3::from_slice(&channel.values[k * 3..k * 3 + 3]);
    let root = joint(&rig, "root");
    let mut worst_vs_renderer: f32 = 0.0;
    for sampled in oracle_clip["samples"].items() {
        let time = sampled["time"].as_f64() as f32;
        let ours = pose_at(&rig, cubic, time, Wrap::Clamp);
        let expected = hermite(key(1), key(2), key(4), key(3), 1.0, time);
        let got = ours[usize::from(root.raw())].translation;
        assert!((got - expected).abs().max_element() <= 1e-6, "t={time}: {got} vs Hermite {expected}");
        worst_vs_renderer = worst_vs_renderer.max(palette_delta(&palette_of(&rig, &ours), &matrices(&sampled["palette"])));
    }
    assert!(worst_vs_renderer > CUBIC_DEFECT, "skin.rs's lerp of the values should miss the Hermite curve, worst {worst_vs_renderer}");

    // At the exact middle of a segment with unequal tangents the two differ too.
    let mut skewed = support::chain3();
    let node = skewed.joints[0];
    skewed.clips = vec![ClipSpec {
        name: "Skewed".to_owned(),
        channels: vec![cubic_channel(
            node,
            [(Vec3::ZERO, Vec3::new(0.0, 0.1, 0.0), Vec3::new(3.0, 0.0, 1.0)), (Vec3::new(-1.0, 0.5, 0.0), Vec3::new(1.0, 0.1, 0.0), Vec3::ZERO)],
            [0.2, 0.6],
        )],
    }];
    let (rig, clips) = import(&skewed);
    let mid = pose_at(&rig, &clips[0], 0.4, Wrap::Clamp)[usize::from(joint(&rig, "root").raw())].translation;
    let expected = hermite(Vec3::new(0.0, 0.1, 0.0), Vec3::new(3.0, 0.0, 1.0), Vec3::new(1.0, 0.1, 0.0), Vec3::new(-1.0, 0.5, 0.0), 0.4, 0.5);
    let lerp = Vec3::new(0.0, 0.1, 0.0).lerp(Vec3::new(1.0, 0.1, 0.0), 0.5);
    assert!((mid - expected).abs().max_element() <= 1e-6, "mid-key {mid} vs Hermite {expected} (tangents × the key span)");
    assert!((mid - lerp).abs().max_element() > CUBIC_DEFECT, "mid-key {mid} must differ from the lerp {lerp}");
}

#[test]
fn a_cubic_spline_rotation_is_normalized() {
    let mut spec = support::chain3();
    let node = spec.joints[1];
    let (q0, q1) = (Quat::from_rotation_z(0.1), Quat::from_rotation_z(1.2));
    let tangent = [0.4, -0.3, 0.9, 0.2];
    let mut values = Vec::new();
    for q in [q0, q1] {
        values.extend(tangent);
        values.extend(q.to_array());
        values.extend(tangent);
    }
    spec.clips = vec![ClipSpec {
        name: "Turn".to_owned(),
        channels: vec![ChannelSpec { node, path: ChannelPath::Rotation, interpolation: ChannelInterpolation::CubicSpline, times: vec![0.0, 1.0], values }],
    }];
    let (rig, clips) = import(&spec);
    for k in 0..=20 {
        let rotation = pose_at(&rig, &clips[0], k as f32 / 20.0, Wrap::Clamp)[usize::from(joint(&rig, "mid").raw())].rotation;
        assert!((rotation.length() - 1.0).abs() <= 1e-6, "t={}: |q| = {}", k as f32 / 20.0, rotation.length());
    }
}

// ---- Red row 2: a looping clip wraps where skin.rs clamps ----

#[test]
fn a_looping_clip_past_its_end_wraps_and_a_clamped_one_holds() {
    let spec = support::chain3();
    let (rig, clips) = import(&spec);
    let wave = clips.iter().find(|clip| clip.name() == "Armature|Wave").expect("the Wave clip");
    assert_eq!(wave.duration(), 1.0);
    let quarter = bits(&pose_at(&rig, wave, 0.25, Wrap::Loop));
    assert_eq!(bits(&pose_at(&rig, wave, 1.25, Wrap::Loop)), quarter, "duration + 0.25 loops to 0.25");
    assert_eq!(bits(&pose_at(&rig, wave, 3.25, Wrap::Loop)), quarter, "three loops + 0.25");
    assert_eq!(bits(&pose_at(&rig, wave, -0.75, Wrap::Loop)), quarter, "backward past the start wraps to the end");
    assert_eq!(bits(&pose_at(&rig, wave, 1.25, Wrap::Clamp)), bits(&pose_at(&rig, wave, 1.0, Wrap::Clamp)), "clamped holds the last key");
    assert_ne!(bits(&pose_at(&rig, wave, 1.25, Wrap::Loop)), bits(&pose_at(&rig, wave, 1.25, Wrap::Clamp)), "loop and clamp differ past the end");

    assert_eq!(clip_time(wave, 1.25, Wrap::Loop), 0.25);
    assert_eq!(clip_time(wave, 1.0, Wrap::Loop), 0.0, "a loop is half-open: its end is its start");
    assert_eq!(clip_time(wave, 1.0, Wrap::Clamp), 1.0);
    assert_eq!(clip_time(wave, -0.5, Wrap::Clamp), 0.0);
    assert_eq!(clip_time(wave, f32::NAN, Wrap::Loop), 0.0, "a NaN time samples the start");
    assert_eq!(clip_time(wave, f32::INFINITY, Wrap::Loop), 0.0, "an infinite time samples the start");
    for k in 0..1000 {
        let time = -5.0 + k as f32 * 0.0137;
        let local = clip_time(wave, time, Wrap::Loop);
        assert!((0.0..1.0).contains(&local), "{time} wraps into [0, 1), got {local}");
    }
}

// ---- Red row 3: opposite-hemisphere quaternion keys take the short way ----

/// The angle between two rotations (glam's `angle_between` uses a coarse acos approximation).
// A test-side measurement with the platform acos; the crate's own code never calls it.
#[allow(clippy::disallowed_methods)]
fn angle(a: Quat, b: Quat) -> f32 {
    2.0 * a.dot(b).abs().min(1.0).acos()
}

#[test]
fn quaternion_keys_in_opposite_hemispheres_take_the_short_way() {
    let mut spec = support::chain3();
    let node = spec.joints[1];
    let (a, b) = (Quat::from_rotation_z(0.2), -Quat::from_rotation_z(0.6));
    assert!(a.dot(b) < 0.0, "the keys are written in opposite hemispheres");
    let linear = ChannelSpec {
        node,
        path: ChannelPath::Rotation,
        interpolation: ChannelInterpolation::Linear,
        times: vec![0.0, 1.0],
        values: a.to_array().into_iter().chain(b.to_array()).collect(),
    };
    let zero = [0.0; 4];
    let cubic = ChannelSpec {
        interpolation: ChannelInterpolation::CubicSpline,
        values: [zero, a.to_array(), zero, zero, b.to_array(), zero].concat(),
        ..linear.clone()
    };
    spec.clips = vec![ClipSpec { name: "Linear".to_owned(), channels: vec![linear] }, ClipSpec { name: "Cubic".to_owned(), channels: vec![cubic] }];
    let (rig, clips) = import(&spec);
    let mid = usize::from(joint(&rig, "mid").raw());
    for clip in &clips {
        for k in 0..=10 {
            let s = k as f32 / 10.0;
            let rotation = pose_at(&rig, clip, s, Wrap::Clamp)[mid].rotation;
            // On the short arc the distances to both ends add up to the 0.4 rad between them.
            let detour = angle(rotation, Quat::from_rotation_z(0.2)) + angle(rotation, Quat::from_rotation_z(0.6));
            assert!(detour <= 0.4 + 1e-3, "{} at {s}: {rotation:?} is {detour} rad from both ends, off the short way", clip.name());
        }
        let half = pose_at(&rig, clip, 0.5, Wrap::Clamp)[mid].rotation;
        assert!(angle(half, Quat::from_rotation_z(0.4)) <= 1e-3, "{} at 0.5: {half:?}", clip.name());
    }
}

// ---- Red row 4: cursors make playback O(1) key steps and never change a result ----

/// A clip on every joint of `rig`: rotation keys at 30 Hz over `seconds`, a two-key translation
/// and a two-key step scale, as a 30 Hz Mixamo-style export carries.
fn dense_clip(rig: &Rig, seconds: f32) -> Clip {
    let keys = (seconds * 30.0) as usize + 1;
    let times: Vec<f32> = (0..keys).map(|k| k as f32 / 30.0).collect();
    let mut tracks = Vec::new();
    for (index, joint) in rig.skeleton().joints().enumerate() {
        let rest = rig.skeleton().rest_pose()[index];
        // A triangle wave of ±0.3 rad, so neighbouring keys always differ.
        let swing = |k: usize| 0.1 * ((k + index) % 7) as f32 - 0.3;
        let rotations = (0..keys).map(|k| rest.rotation * Quat::from_rotation_x(swing(k))).collect();
        tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Rotation(rotations)).expect("rotation track"));
        let lift = vec![rest.translation, rest.translation + Vec3::new(0.0, 0.05, 0.0)];
        tracks.push(Track::new(joint, Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(lift)).expect("translation track"));
        let scale = vec![Vec3::ONE, Vec3::splat(1.01)];
        tracks.push(Track::new(joint, Interpolation::Step, vec![0.0, seconds * 0.5], TrackValues::Scale(scale)).expect("scale track"));
    }
    Clip::new("Dense", tracks).expect("the dense clip")
}

#[test]
fn forward_and_backward_playback_take_constant_key_steps_and_match_a_fresh_cursor_bit_for_bit() {
    let (rig, _) = import(&support::tree("tree60", 60));
    let clip = dense_clip(&rig, 2.0);
    let tracks = clip.tracks().len() as u64;
    for direction in [1.0_f32, -1.0] {
        let mut cursor = SampleCursor::new();
        let mut pose = rig.skeleton().rest_pose().to_vec();
        let mut worst_tick: u64 = 0;
        for tick in 0..TICKS {
            let time = direction * tick as f32 * TICK;
            let before = cursor.steps();
            sample(&clip, time, Wrap::Loop, &mut cursor, &mut pose);
            worst_tick = worst_tick.max(cursor.steps() - before);
            assert_eq!(bits(&pose), bits(&pose_at(&rig, &clip, time, Wrap::Loop)), "direction {direction}, tick {tick}: the cursor changed the pose");
        }
        // 30 Hz keys at 60 ticks a second: at most one key per tick and track, plus one step per
        // track at each of the five wraps.
        assert!(worst_tick <= 2 * tracks, "direction {direction}: {worst_tick} key steps in one tick over {tracks} tracks");
        assert!(cursor.steps() <= (TICKS as u64 + 5) * tracks, "direction {direction}: {} key steps over {TICKS} ticks", cursor.steps());
        assert_eq!(cursor.searches(), 0, "direction {direction}: playback never falls back to a binary search");
    }
}

#[test]
fn a_jump_searches_once_and_any_cursor_gives_the_same_bits() {
    let (rig, _) = import(&support::tree("tree60", 60));
    let clip = dense_clip(&rig, 2.0);
    let tracks = clip.tracks().len() as u64;
    let mut cursor = SampleCursor::new();
    let mut pose = rig.skeleton().rest_pose().to_vec();
    let mut state: u32 = 0x2545_F491;
    for _ in 0..200 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let time = (state % 4000) as f32 / 1000.0 - 1.0;
        let before = cursor.searches();
        sample(&clip, time, Wrap::Loop, &mut cursor, &mut pose);
        assert!(cursor.searches() - before <= tracks, "t={time}: at most one search per track");
        assert_eq!(bits(&pose), bits(&pose_at(&rig, &clip, time, Wrap::Loop)), "t={time}: a warm cursor changed the pose");
    }
    assert!(cursor.searches() > 0, "random jumps do search");
    // A cursor sized for another clip is a hint like any other: the result is unchanged.
    let (other_rig, other_clips) = import(&support::chain3());
    let mut shared = SampleCursor::new();
    let mut scratch = other_rig.skeleton().rest_pose().to_vec();
    sample(&other_clips[0], 0.7, Wrap::Loop, &mut shared, &mut scratch);
    sample(&clip, 1.3, Wrap::Loop, &mut shared, &mut pose);
    assert_eq!(bits(&pose), bits(&pose_at(&rig, &clip, 1.3, Wrap::Loop)), "a cursor from another clip");
}

// The advisory cost row reads the wall clock; the crate's simulation code never does.
#[allow(clippy::disallowed_types)]
#[test]
fn sampling_a_60_joint_clip_at_a_forward_cursor_allocates_nothing_and_its_cost_is_recorded() {
    let (rig, _) = import(&support::tree("tree60", 60));
    let clip = dense_clip(&rig, 2.0);
    let mut cursor = SampleCursor::new();
    let mut pose = rig.skeleton().rest_pose().to_vec();
    sample(&clip, 0.0, Wrap::Loop, &mut cursor, &mut pose);
    let made = allocations(|| {
        for tick in 0..TICKS {
            sample(&clip, tick as f32 * TICK, Wrap::Loop, &mut cursor, &mut pose);
        }
    });
    assert_eq!(made, 0, "sampling with a warm cursor allocates nothing");

    // Advisory cost row (lane timings are not gated): ns per 60-joint sample at a forward cursor.
    let rounds: u32 = 20_000;
    let start = std::time::Instant::now();
    for k in 0..rounds {
        sample(&clip, std::hint::black_box(k as f32 * TICK), Wrap::Loop, &mut cursor, &mut pose);
        std::hint::black_box(&pose[k as usize % pose.len()]);
    }
    let ns = start.elapsed().as_nanos() as f64 / f64::from(rounds);
    println!("sample 60 joints, {} tracks: {ns:.0} ns (budget {SAMPLE_60_BUDGET_NS:.0} ns, advisory)", clip.tracks().len());
}

// ---- Red row 5: Step and Linear agree with skin.rs's sampler ----

#[test]
fn step_and_linear_clips_agree_with_the_renderers_sampler_on_every_oracle_rig() {
    let mut compared = 0;
    for spec in support::oracle_rigs() {
        let (rig, clips) = import(&spec);
        let recorded = oracle(spec.name);
        let oracle_clips = recorded["clips"].items();
        assert_eq!(clips.len(), oracle_clips.len(), "{}: clip count", spec.name);
        for (clip, recorded_clip) in clips.iter().zip(oracle_clips) {
            assert_eq!(clip.name(), recorded_clip["name"].as_str(), "{}: clips in file order", spec.name);
            assert_eq!(clip.duration(), recorded_clip["duration"].as_f64() as f32, "{} {}: duration", spec.name, clip.name());
            if uses_cubic(clip) {
                continue;
            }
            for sampled in recorded_clip["samples"].items() {
                let time = sampled["time"].as_f64() as f32;
                let palette = palette_of(&rig, &pose_at(&rig, clip, time, Wrap::Clamp));
                let delta = palette_delta(&palette, &matrices(&sampled["palette"]));
                assert!(delta <= PALETTE_TOLERANCE, "{} {} at {time}: |Δ| {delta:e}", spec.name, clip.name());
                compared += 1;
            }
        }
    }
    assert!(compared >= 24, "{compared} oracle samples compared");
}

// ---- Channels the skeleton cannot follow ----

#[test]
fn channels_off_the_skeleton_are_skipped_and_named_with_their_reason() {
    let mut spec = support::mixamo();
    let armature = 0;
    let prop = spec.node("Prop", None, [1.0, 0.0, 0.0], Quat::IDENTITY, [1.0; 3]);
    let turn = [Quat::IDENTITY, Quat::from_rotation_y(1.0)].iter().flat_map(|q| q.to_array()).collect::<Vec<f32>>();
    let on = |node: usize| ChannelSpec {
        node,
        path: ChannelPath::Rotation,
        interpolation: ChannelInterpolation::Linear,
        times: vec![0.0, 1.0],
        values: turn.clone(),
    };
    spec.clips[0].channels.push(on(armature));
    spec.clips[0].channels.push(on(spec.mesh_node));
    spec.clips[0].channels.push(on(prop));
    let (rig, clips) = import(&spec);
    let ignored: Vec<(usize, IgnoredChannelReason)> = clips[0].ignored_channels().iter().map(|c| (c.node, c.reason)).collect();
    assert_eq!(
        ignored,
        vec![
            (armature, IgnoredChannelReason::FoldedAncestor),
            (spec.mesh_node, IgnoredChannelReason::OutsideSkeleton),
            (prop, IgnoredChannelReason::OutsideSkeleton),
        ]
    );
    assert_eq!(clips[0].tracks().len(), 1, "the arm channel stays");
    assert!(pose_at(&rig, &clips[0], 0.5, Wrap::Clamp).iter().all(Trs::is_finite));
}

// ---- Hostile clips ----

fn assert_refused(name: &str, glb: &[u8]) {
    let result = catch_unwind(AssertUnwindSafe(|| import_rig(glb).and_then(|rig| import_clips(glb, &rig))))
        .unwrap_or_else(|_| panic!("{name}: import panicked"));
    let error = result.expect_err(name);
    assert_eq!(error.code, AnimationErrorCode::AssetInvalid, "{name}: {error}");
}

/// chain3 with its "Step" clip's one channel edited.
fn edited(edit: impl FnOnce(&mut ChannelSpec)) -> Vec<u8> {
    let mut spec = support::chain3();
    edit(&mut spec.clips[1].channels[0]);
    spec.glb()
}

fn with_json(edit: impl FnOnce(String) -> String) -> Vec<u8> {
    let (json, bin) = support::chain3().json_and_bin();
    support::glb(&edit(json), &bin)
}

#[test]
fn hostile_clips_are_refused_without_a_panic() {
    assert_refused("times go backwards", &edited(|c| c.times = vec![0.0, 0.8, 0.4]));
    assert_refused("a negative time", &edited(|c| c.times = vec![-0.5, 0.4, 0.8]));
    assert_refused("a NaN time", &edited(|c| c.times = vec![0.0, f32::NAN, 0.8]));
    assert_refused("a NaN value", &edited(|c| c.values[4] = f32::NAN));
    assert_refused("an infinite value", &edited(|c| c.values[0] = f32::INFINITY));
    assert_refused("fewer values than times", &edited(|c| c.values.truncate(6)));
    assert_refused("a cubic channel without three values per key", &edited(|c| c.interpolation = ChannelInterpolation::CubicSpline));
    assert_refused("a zero rotation key", &edited(|c| {
        c.path = ChannelPath::Rotation;
        c.values = [[0.0, 0.0, 0.0, 1.0], [0.0; 4], [0.0, 0.0, 0.0, 1.0]].concat();
    }));
    assert_refused("rotation keys as VEC3", &edited(|c| c.path = ChannelPath::Rotation));
    let mut twice = support::chain3();
    let again = twice.clips[0].channels[0].clone();
    twice.clips[0].channels.push(again);
    assert_refused("one target animated twice", &twice.glb());
    assert_refused("an input accessor past the list", &with_json(|j| j.replacen(r#"{"input":"#, r#"{"input":999,"was":"#, 1)));
    assert_refused("an input accessor of VEC3", &with_json(|j| j.replacen(r#"{"input":"#, r#"{"input":0,"was":"#, 1)));
    assert_refused("a sampler past the list", &with_json(|j| j.replacen(r#"{"sampler":0,"#, r#"{"sampler":9,"#, 1)));
}

#[test]
fn every_truncation_and_bit_flip_of_a_clip_glb_refuses_or_imports_without_a_panic() {
    let glb = support::chain3().glb();
    let rig = import_rig(&glb).expect("chain3");
    let mut panics = 0;
    let mut try_both = |bytes: &[u8]| {
        let own = catch_unwind(AssertUnwindSafe(|| import_rig(bytes).and_then(|r| import_clips(bytes, &r))));
        let foreign = catch_unwind(AssertUnwindSafe(|| import_clips(bytes, &rig)));
        panics += u32::from(own.is_err()) + u32::from(foreign.is_err());
    };
    for cut in 0..glb.len() {
        try_both(&glb[..cut]);
    }
    let mut state: u64 = 0xD1B5_4A32_D192_ED03;
    for _ in 0..4000 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let mut flipped = glb.clone();
        let at = (state % glb.len() as u64) as usize;
        flipped[at] ^= 1 << ((state >> 32) % 8);
        try_both(&flipped);
    }
    assert_eq!(panics, 0, "panics over every truncation and 4000 bit flips");
}

// ---- Building clips in code ----

#[test]
fn tracks_built_in_code_are_checked_like_imported_ones() {
    let (rig, _) = import(&support::chain3());
    let root = joint(&rig, "root");
    let v = |n: usize| TrackValues::Translation(vec![Vec3::ZERO; n]);
    let refused = |result: Result<Track, genex_anim::AnimationError>, what: &str| {
        assert_eq!(result.expect_err(what).code, AnimationErrorCode::AssetInvalid, "{what}");
    };
    refused(Track::new(root, Interpolation::Linear, vec![], v(0)), "no keys");
    refused(Track::new(root, Interpolation::Linear, vec![0.0, 1.0], v(3)), "value count");
    refused(Track::new(root, Interpolation::CubicSpline, vec![0.0, 1.0], v(2)), "cubic needs three per key");
    refused(Track::new(root, Interpolation::Linear, vec![1.0, 0.0], v(2)), "times go backwards");
    let zero = TrackValues::Rotation(vec![Quat::IDENTITY, Quat::from_xyzw(0.0, 0.0, 0.0, 0.0)]);
    refused(Track::new(root, Interpolation::Linear, vec![0.0, 1.0], zero), "zero rotation");
    let track = Track::new(root, Interpolation::Linear, vec![0.0, 2.0], v(2)).expect("a good track");
    let twice = Clip::new("Twice", vec![track.clone(), track.clone()]);
    assert_eq!(twice.expect_err("one target twice").code, AnimationErrorCode::AssetInvalid);
    let clip = Clip::new("Once", vec![track]).expect("a clip");
    assert_eq!(clip.duration(), 2.0);
    assert!(clip.ignored_channels().is_empty());
}

#[test]
fn a_clip_with_no_tracks_or_one_key_samples_without_dividing_by_zero() {
    let (rig, _) = import(&support::chain3());
    let empty = Clip::new("Empty", vec![]).expect("an empty clip");
    assert_eq!(empty.duration(), 0.0);
    assert_eq!(bits(&pose_at(&rig, &empty, 0.5, Wrap::Loop)), bits(rig.skeleton().rest_pose()));
    let root = joint(&rig, "root");
    let still = Track::new(root, Interpolation::Linear, vec![0.0], TrackValues::Translation(vec![Vec3::X])).expect("one key");
    let still = Clip::new("Still", vec![still]).expect("a one-key clip");
    for wrap in [Wrap::Loop, Wrap::Clamp] {
        assert_eq!(pose_at(&rig, &still, 3.0, wrap)[usize::from(root.raw())].translation, Vec3::X);
    }
}
