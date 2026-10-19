//! AN-3: clip compaction. A constant track keeps one key; a 30 Hz clip made of straight segments
//! keeps only its corners; the worst model-space joint position over the whole skeleton moves at
//! most the tolerance (0.5 mm) on the humanoid, Mixamo-style and 60-joint rigs; the compact sampler
//! gives the same bits as the stock sampler over the decompressed clip; the same clip compacts to
//! the same bytes (a pinned digest); and a 16-clip locomotion set fits the memory budget.
//!
//! The plan names Quaternius UAL (CC0) clips for the error row. They are not in the repository
//! yet (committing them is a fixture-size call), so the error rows run on dense 30 Hz clips baked
//! in code onto the synthetic rigs AN-1 imports: every joint turns on its own phase, the root
//! walks forward and bobs, one track is a cubic spline and one is stepped.

mod support;

use genex_anim::AnimationErrorCode;
use genex_anim::clip::{Clip, Interpolation, Property, Track, TrackValues, import_clips};
use genex_anim::compact::{CompactClip, CompactCursor, DEFAULT_TOLERANCE, compact, compact_with};
use genex_anim::ids::JointId;
use genex_anim::import::{Rig, import_rig};
use genex_anim::math::{Trs, normalize_quat, same_hemisphere};
use genex_anim::sample::{SampleCursor, Wrap, sample};
use glam::{Mat4, Quat, Vec3};

/// Keys per second of the baked clips (UAL and most DCC exports bake at 30 Hz).
const RATE: f32 = 30.0;
/// The memory budget of a 16-clip locomotion set (plan AN-3 acceptance).
const SET_BUDGET_BYTES: usize = 250_000;
/// The advisory compaction budget of that set on the M4 Max (release build).
const SET_BUDGET_MS: f64 = 20.0;
/// Samples per second the error rows check, finer than the keys so between-key error shows.
const CHECK_RATE: f32 = 240.0;

fn import(spec: &support::RigSpec) -> (Rig, Vec<Clip>) {
    let glb = spec.glb();
    let rig = import_rig(&glb).unwrap_or_else(|error| panic!("{}: {error}", spec.name));
    let clips = import_clips(&glb, &rig).unwrap_or_else(|error| panic!("{} clips: {error}", spec.name));
    (rig, clips)
}

/// A 60-joint humanoid: the 22-joint body with five fingers on each hand (three thumb joints and
/// four per finger), the joint count of UAL's and Mixamo's rigs with fingers.
fn humanoid60() -> support::RigSpec {
    let mut rig = support::humanoid22();
    rig.name = "humanoid60";
    rig.clips.clear();
    for (hand, side) in [("LeftHand", 1.0), ("RightHand", -1.0)] {
        let wrist = rig.nodes.iter().position(|node| node.name == hand).expect("a hand");
        for (finger, count, spread) in [("Thumb", 3, 0.03), ("Index", 4, 0.02), ("Middle", 4, 0.0), ("Ring", 4, -0.02), ("Pinky", 4, -0.04)] {
            let mut parent = wrist;
            for k in 0..count {
                let offset = if k == 0 { [side * 0.08, 0.0, spread] } else { [side * 0.03, 0.0, 0.0] };
                parent = rig.joint(&format!("{hand}{finger}{}", k + 1), Some(parent), offset, Quat::IDENTITY);
            }
        }
    }
    rig
}

fn key_times(seconds: f32) -> Vec<f32> {
    let keys = (seconds * RATE).round() as usize + 1;
    (0..keys).map(|k| k as f32 / RATE).collect()
}

/// A dense locomotion-like clip: every joint's rotation swings on its own phase at 30 Hz, the
/// first root walks forward and bobs, one joint's translation is a cubic spline, one scale is
/// stepped. `variant` shifts phases and speeds so a set of clips differs.
fn locomotion(rig: &Rig, seconds: f32, variant: usize) -> Clip {
    let skeleton = rig.skeleton();
    let times = key_times(seconds);
    let tau = std::f32::consts::TAU;
    let speed = 1.0 + 0.25 * variant as f32;
    let mut tracks = Vec::new();
    for (index, joint) in skeleton.joints().enumerate() {
        let rest = skeleton.rest_pose()[index];
        let phase = 0.37 * (index + variant) as f32;
        let amplitude = 0.15 + 0.05 * ((index + variant) % 4) as f32;
        let rotations = times
            .iter()
            .map(|&t| {
                let swing = amplitude * sin(tau * t / seconds * speed + phase);
                let twist = 0.3 * amplitude * sin(2.0 * tau * t / seconds + phase);
                rest.rotation * Quat::from_rotation_x(swing) * Quat::from_rotation_z(twist)
            })
            .collect();
        tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Rotation(rotations)).expect("rotation"));
        if index == 0 {
            let unit = rest.translation.length().max(1.0);
            let walk = times
                .iter()
                .map(|&t| rest.translation + Vec3::new(0.02 * sin(tau * t / seconds), 0.03 * sin(2.0 * tau * t / seconds), 1.4 * t) * unit)
                .collect();
            tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Translation(walk)).expect("walk"));
        } else {
            // Most joints carry their rest translation and scale on every key, as DCC bakes do.
            let held = vec![rest.translation; times.len()];
            tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Translation(held)).expect("held"));
        }
        let scales = vec![rest.scale; times.len()];
        tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Scale(scales)).expect("scale"));
    }
    Clip::new(format!("Locomotion{variant}"), tracks).expect("the locomotion clip")
}

/// The same clip with one joint's translation as a cubic spline and one scale stepped.
fn with_cubic_and_step(rig: &Rig, clip: &Clip) -> Clip {
    let skeleton = rig.skeleton();
    let last = joint_at(rig, skeleton.joint_count() - 1);
    let middle = joint_at(rig, skeleton.joint_count() / 2);
    let mut tracks: Vec<Track> = clip
        .tracks()
        .iter()
        .filter(|track| !((track.joint() == last && track.property() == Property::Translation) || (track.joint() == middle && track.property() == Property::Scale)))
        .cloned()
        .collect();
    let rest = skeleton.rest_pose()[usize::from(last.raw())];
    let end = clip.duration();
    let cubic = vec![
        Vec3::ZERO,
        rest.translation,
        Vec3::new(0.1, 0.0, 0.0),
        Vec3::new(0.0, 0.1, 0.0),
        rest.translation + Vec3::new(0.02, 0.01, 0.0),
        Vec3::new(0.0, -0.1, 0.0),
        Vec3::new(-0.1, 0.0, 0.0),
        rest.translation,
        Vec3::ZERO,
    ];
    tracks.push(Track::new(last, Interpolation::CubicSpline, vec![0.0, end * 0.5, end], TrackValues::Translation(cubic)).expect("cubic"));
    let step = vec![Vec3::ONE, Vec3::splat(1.02), Vec3::ONE];
    tracks.push(Track::new(middle, Interpolation::Step, vec![0.0, end * 0.3, end * 0.6], TrackValues::Scale(step)).expect("step"));
    Clip::new(format!("{}+", clip.name()), tracks).expect("the mixed clip")
}

/// Model-space joint positions of a pose.
fn positions(rig: &Rig, pose: &[Trs]) -> Vec<Vec3> {
    let skeleton = rig.skeleton();
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(pose, &mut model);
    model.iter().map(|m| m.w_axis.truncate()).collect()
}

/// The worst model-space joint position difference between `clip` and its compaction, sampled
/// at [`CHECK_RATE`] over the clip and at every key time.
fn worst_error(rig: &Rig, clip: &Clip, compacted: &CompactClip) -> f32 {
    let rest = rig.skeleton().rest_pose().to_vec();
    let steps = (clip.duration() * CHECK_RATE).ceil() as usize;
    let mut times: Vec<f32> = (0..=steps).map(|k| (k as f32 / CHECK_RATE).min(clip.duration())).collect();
    times.extend(clip.tracks().iter().flat_map(|track| track.times().iter().copied()));
    let (mut cursor, mut compact_cursor) = (SampleCursor::new(), CompactCursor::new());
    let mut worst: f32 = 0.0;
    for time in times {
        let mut want = rest.clone();
        sample(clip, time, Wrap::Clamp, &mut cursor, &mut want);
        let mut got = rest.clone();
        compacted.sample(time, Wrap::Clamp, &mut compact_cursor, &mut got);
        for (a, b) in positions(rig, &want).iter().zip(positions(rig, &got)) {
            worst = worst.max(a.distance(b));
        }
    }
    worst
}

/// The bytes the clip's keys take as stored uncompacted: f32 times and values.
fn raw_bytes(clip: &Clip) -> usize {
    clip.tracks()
        .iter()
        .map(|track| {
            let value = if track.property() == Property::Rotation { 16 } else { 12 };
            track.times().len() * 4 + track.values().len() * value
        })
        .sum()
}

fn track_of(compacted: &CompactClip, joint: JointId, property: Property) -> usize {
    compacted.tracks().iter().position(|track| track.joint() == joint && track.property() == property).expect("the track")
}

/// The `index`th joint of a rig, parents first.
fn joint_at(rig: &Rig, index: usize) -> JointId {
    rig.skeleton().joints().nth(index).expect("a joint")
}

/// The sine of `angle` through glam's libm (`f32::sin` is the platform's).
fn sin(angle: f32) -> f32 {
    glam::Vec2::from_angle(angle).y
}

fn chain_rig() -> Rig {
    import(&support::chain3()).0
}

// ---- Red row 1: a constant track stores one key ----

#[test]
fn a_constant_track_stores_one_key_and_samples_its_value() {
    let rig = chain_rig();
    let root = joint_at(&rig, 0);
    let times = key_times(2.0);
    let held = Vec3::new(0.25, 1.5, -0.75);
    // A float-noise wobble far under the tolerance still counts as constant.
    let wobble: Vec<Vec3> = (0..times.len()).map(|k| held + Vec3::splat(if k % 2 == 0 { 0.0 } else { 1e-7 })).collect();
    let rotation = Quat::from_rotation_y(0.4);
    let tracks = vec![
        Track::new(root, Interpolation::Linear, times.clone(), TrackValues::Translation(wobble)).expect("translation"),
        Track::new(root, Interpolation::Linear, times.clone(), TrackValues::Rotation(vec![rotation; times.len()])).expect("rotation"),
        Track::new(root, Interpolation::Step, times.clone(), TrackValues::Scale(vec![Vec3::ONE; times.len()])).expect("scale"),
    ];
    let clip = Clip::new("Hold", tracks).expect("clip");
    let compacted = compact(&clip, rig.skeleton()).expect("compacts");
    assert_eq!(compacted.tracks().len(), 3, "every track is kept (a held value still overwrites a pose)");
    for track in compacted.tracks() {
        assert_eq!(track.key_count(), 1, "{:?} is constant: one key", track.property());
    }
    let mut pose = vec![Trs::IDENTITY; 3];
    compacted.sample(0.77, Wrap::Loop, &mut CompactCursor::new(), &mut pose);
    assert!(pose[0].translation.distance(held) < 1e-6, "the held translation, got {:?}", pose[0].translation);
    assert!(pose[0].rotation.dot(rotation).abs() > 1.0 - 1e-6, "the held rotation");
    assert_eq!(compacted.duration(), clip.duration(), "the duration is kept");
}

// ---- Red row 2: straight segments reduce to their corners ----

/// Values on straight segments between `corners` (frame, value), keyed at 30 Hz.
fn piecewise(corners: &[(usize, Vec3)]) -> (Vec<f32>, Vec<Vec3>) {
    let frames = corners.last().expect("corners").0;
    let mut values = Vec::with_capacity(frames + 1);
    for frame in 0..=frames {
        let after = corners.iter().position(|(f, _)| *f >= frame).expect("a corner at or after");
        let value = if corners[after].0 == frame {
            corners[after].1
        } else {
            let (f0, a) = corners[after - 1];
            let (f1, b) = corners[after];
            a.lerp(b, (frame - f0) as f32 / (f1 - f0) as f32)
        };
        values.push(value);
    }
    ((0..=frames).map(|f| f as f32 / RATE).collect(), values)
}

#[test]
fn a_30_hz_clip_of_straight_segments_keeps_only_its_corners() {
    let rig = chain_rig();
    let (root, mid) = (joint_at(&rig, 0), joint_at(&rig, 1));
    let corners = [(0, Vec3::new(0.0, 0.1, 0.0)), (12, Vec3::new(0.6, 0.1, 0.0)), (30, Vec3::new(0.6, 0.4, 0.9)), (47, Vec3::new(-0.2, 0.1, 0.9)), (90, Vec3::new(-0.2, 0.1, 3.0))];
    let (times, values) = piecewise(&corners);
    // The rotation turns between corner orientations with the sampler's own slerp, so each
    // in-between key lies on the segment its corners span.
    let turns = [(0, Quat::IDENTITY), (20, Quat::from_rotation_z(0.8)), (55, Quat::from_rotation_x(-0.6) * Quat::from_rotation_z(0.8)), (90, Quat::from_rotation_y(1.1))];
    let rotations: Vec<Quat> = (0..=90)
        .map(|frame| {
            let after = turns.iter().position(|(f, _)| *f >= frame).expect("a turn");
            if turns[after].0 == frame {
                return turns[after].1;
            }
            let ((f0, a), (f1, b)) = (turns[after - 1], turns[after]);
            normalize_quat(a.slerp(same_hemisphere(b, a), (frame - f0) as f32 / (f1 - f0) as f32))
        })
        .collect();
    let tracks = vec![
        Track::new(root, Interpolation::Linear, times.clone(), TrackValues::Translation(values)).expect("translation"),
        Track::new(mid, Interpolation::Linear, times.clone(), TrackValues::Rotation(rotations)).expect("rotation"),
    ];
    let clip = Clip::new("Corners", tracks).expect("clip");
    let compacted = compact(&clip, rig.skeleton()).expect("compacts");

    let translation = track_of(&compacted, root, Property::Translation);
    let want: Vec<f32> = corners.iter().map(|(f, _)| *f as f32 / RATE).collect();
    assert_eq!(compacted.key_times(translation), want, "the translation keeps its five corners and nothing else");
    let rotation = track_of(&compacted, mid, Property::Rotation);
    let want: Vec<f32> = turns.iter().map(|(f, _)| *f as f32 / RATE).collect();
    assert_eq!(compacted.key_times(rotation), want, "the rotation keeps its four corners and nothing else");
    assert!(worst_error(&rig, &clip, &compacted) <= DEFAULT_TOLERANCE, "and nothing moved past the tolerance");
}

// ---- Red row 3: the worst joint position error stays within 0.5 mm ----

#[test]
fn the_worst_joint_position_error_stays_within_half_a_millimetre_on_every_rig() {
    assert_eq!(DEFAULT_TOLERANCE, 0.0005, "the default tolerance is 0.5 mm");
    for spec in [support::humanoid22(), humanoid60(), support::mixamo(), support::tree("tree60", 60)] {
        let (rig, _) = import(&spec);
        for variant in 0..3 {
            let clip = with_cubic_and_step(&rig, &locomotion(&rig, 1.0 + 0.5 * variant as f32, variant));
            let compacted = compact(&clip, rig.skeleton()).expect("compacts");
            let worst = worst_error(&rig, &clip, &compacted);
            println!(
                "{} {}: {} -> {} bytes, worst joint error {:.4} mm",
                spec.name,
                clip.name(),
                raw_bytes(&clip),
                compacted.byte_size(),
                worst * 1000.0
            );
            assert!(worst <= DEFAULT_TOLERANCE, "{} {}: worst joint error {worst} m over {DEFAULT_TOLERANCE}", spec.name, clip.name());
            assert!(compacted.byte_size() < raw_bytes(&clip), "{} {}: compaction shrinks the clip", spec.name, clip.name());
        }
    }
}

#[test]
fn a_tighter_tolerance_holds_too_and_keeps_more_keys() {
    let (rig, _) = import(&support::humanoid22());
    let clip = with_cubic_and_step(&rig, &locomotion(&rig, 1.0, 1));
    let loose = compact(&clip, rig.skeleton()).expect("compacts");
    let tight = compact_with(&clip, rig.skeleton(), 0.0001).expect("compacts");
    assert!(worst_error(&rig, &clip, &tight) <= 0.0001, "0.1 mm holds");
    // Keys, not bytes: a track that keeps every key stores its times as one run, which can take
    // fewer bytes than fewer keys with their own indices.
    let keys = |clip: &CompactClip| clip.tracks().iter().map(|track| track.key_count()).sum::<usize>();
    assert!(keys(&tight) > keys(&loose), "a tighter tolerance keeps more keys: {} vs {}", keys(&tight), keys(&loose));
}

#[test]
fn the_compact_sampler_gives_the_bits_of_the_stock_sampler_over_the_decompressed_clip() {
    let (rig, _) = import(&support::humanoid22());
    let clip = with_cubic_and_step(&rig, &locomotion(&rig, 1.5, 2));
    let compacted = compact(&clip, rig.skeleton()).expect("compacts");
    let decompressed = compacted.to_clip().expect("decompresses");
    assert_eq!(decompressed.duration(), clip.duration(), "the decompressed clip lasts as long");
    let rest = rig.skeleton().rest_pose().to_vec();
    let (mut cursor, mut compact_cursor) = (SampleCursor::new(), CompactCursor::new());
    // Forward, a loop wrap, backward and a jump: the cursor never changes a result.
    let mut times: Vec<f32> = (0..400).map(|k| k as f32 * 0.0123).collect();
    times.extend((0..50).rev().map(|k| k as f32 * 0.031));
    times.extend([-0.4, 7.25, 0.5, f32::NAN]);
    for time in times {
        let mut want = rest.clone();
        sample(&decompressed, time, Wrap::Loop, &mut cursor, &mut want);
        let mut got = rest.clone();
        compacted.sample(time, Wrap::Loop, &mut compact_cursor, &mut got);
        assert_eq!(bits(&got), bits(&want), "time {time}");
    }
}

fn bits(pose: &[Trs]) -> Vec<u32> {
    pose.iter()
        .flat_map(|trs| trs.translation.to_array().into_iter().chain(trs.rotation.to_array()).chain(trs.scale.to_array()))
        .map(f32::to_bits)
        .collect()
}

// ---- Red row 4: the same bytes in give the same bytes out ----

/// The digest of the humanoid's variant-0 locomotion clip, compacted. It changes only when the
/// compaction or its byte layout changes, and must be the same on every destination.
const PINNED_DIGEST: u64 = 0xfc82_8955_07ef_9e43;

#[test]
fn the_same_clip_compacts_to_the_same_bytes_and_the_pinned_digest() {
    let (rig, _) = import(&support::humanoid22());
    let clip = with_cubic_and_step(&rig, &locomotion(&rig, 1.0, 0));
    let first = compact(&clip, rig.skeleton()).expect("compacts");
    let again = compact(&clip.clone(), rig.skeleton()).expect("compacts");
    assert_eq!(first.to_bytes(), again.to_bytes(), "same bytes out");
    assert_eq!(first.digest(), again.digest());
    assert_eq!(first.byte_size(), first.to_bytes().len());
    println!("digest {:#018x}", first.digest());
    assert_eq!(first.digest(), PINNED_DIGEST, "the pinned digest (re-record and name it when the layout changes)");
}

// ---- Refusals ----

#[test]
fn a_bad_tolerance_or_a_track_off_the_skeleton_is_refused() {
    let rig = chain_rig();
    let clip = Clip::new("Empty", Vec::new()).expect("clip");
    for tolerance in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        let error = compact_with(&clip, rig.skeleton(), tolerance).expect_err("refused");
        assert_eq!(error.code, AnimationErrorCode::AssetInvalid, "tolerance {tolerance}");
    }
    let far = joint_at(&import(&support::tree("tree60", 60)).0, 40);
    let track = Track::new(far, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Translation(vec![Vec3::ZERO, Vec3::ONE])).expect("track");
    let clip = Clip::new("Off", vec![track]).expect("clip");
    let error = compact(&clip, rig.skeleton()).expect_err("a joint past the skeleton is refused");
    assert_eq!(error.code, AnimationErrorCode::AssetInvalid);
    let empty = compact(&Clip::new("Empty", Vec::new()).expect("clip"), rig.skeleton()).expect("an empty clip compacts");
    assert!(empty.tracks().is_empty());
}

// ---- Acceptance: a 16-clip locomotion set ----

// The advisory cost row reads the wall clock; the crate's simulation code never does.
#[allow(clippy::disallowed_types)]
#[test]
fn a_16_clip_locomotion_set_fits_the_memory_budget_and_its_cost_is_recorded() {
    // Gated on the 60-joint humanoid; the 22-joint body and the 60-joint tree (a 4 m spine whose
    // every joint swings, a stress case no character has) are recorded.
    for (spec, gated) in [(humanoid60(), true), (support::humanoid22(), false), (support::tree("tree60", 60), false)] {
        let (rig, _) = import(&spec);
        let clips: Vec<Clip> = (0..16).map(|variant| locomotion(&rig, 1.0, variant)).collect();
        let raw: usize = clips.iter().map(raw_bytes).sum();
        let start = std::time::Instant::now();
        let set: Vec<CompactClip> = clips.iter().map(|clip| compact(clip, rig.skeleton()).expect("compacts")).collect();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let compacted: usize = set.iter().map(CompactClip::byte_size).sum();
        let keys: usize = set.iter().flat_map(|clip| clip.tracks().iter().map(|track| track.key_count())).sum();
        println!(
            "{}: 16 clips, {} joints: raw {raw} B, compacted {compacted} B ({:.1}%), {keys} keys, {ms:.2} ms (budget {SET_BUDGET_MS} ms, advisory; {} build)",
            spec.name,
            rig.skeleton().joint_count(),
            100.0 * compacted as f64 / raw as f64,
            if cfg!(debug_assertions) { "debug" } else { "release" }
        );
        assert_eq!(rig.skeleton().joint_count(), if spec.name == "humanoid22" { 22 } else { 60 });
        if gated {
            assert!(compacted <= SET_BUDGET_BYTES, "{}: {compacted} B over the {SET_BUDGET_BYTES} B budget", spec.name);
        }
    }
}
