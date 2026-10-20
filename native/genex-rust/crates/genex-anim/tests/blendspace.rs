//! AN-8: blend spaces and phase sync. The 16-clip 8-way locomotion set at 22.5° and 3.5 m/s
//! weights only its angular and speed neighbours and sums to 1; sweeping the heading 0 to 360°
//! moves no weight more than 0.05 per degree; a 1D space clamps outside its range; walk (1.0 s)
//! and run (0.7 s) blended 50/50 keep their foot contacts within a frame when synced and drift
//! apart unsynced; and collinear cartesian points fall back to the nearest edge.

mod support;

use genex_anim::blendspace::{BlendSpace1D, BlendSpace2D, MAX_BLEND_POINTS};
use genex_anim::clip::{Clip, Interpolation, Track, TrackValues, import_clips};
use genex_anim::events::{ContactRule, EventTable, Span, crossed, foot_contacts, humanoid_feet};
use genex_anim::graph::AnimGraph;
use genex_anim::import::{Rig, import_rig};
use genex_anim::sync::{MAX_SYNC_MARKERS, SyncClip, SyncGroup, SyncMode, SyncTrack};
use genex_anim::{AnimationErrorCode, ClipId};
use glam::{Quat, Vec2, Vec3};
use support::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec, RigSpec};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;
/// The 8-way set's walk and run speeds, in metres per second.
const WALK: f32 = 2.0;
const RUN: f32 = 5.0;

fn chain() -> Rig {
    import_rig(&support::chain3().glb()).expect("the chain fixture imports")
}

/// `count` clip handles (handles come from a graph builder over that many clips).
fn clip_ids(count: usize) -> Vec<ClipId> {
    let rig = chain();
    let joint = rig.skeleton().joints().next().expect("a joint");
    let clips: Vec<Clip> = (0..count)
        .map(|k| {
            let track = Track::new(joint, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Translation(vec![Vec3::ZERO, Vec3::Y])).expect("a track");
            Clip::new(format!("c{k}"), vec![track]).expect("a clip")
        })
        .collect();
    AnimGraph::builder(rig.skeleton(), &clips).clips().map(|(id, _)| id).collect()
}

/// A velocity at `heading` degrees clockwise from forward (+y) and `speed` m/s.
fn velocity(heading: f32, speed: f32) -> Vec2 {
    Vec2::from_angle(std::f32::consts::FRAC_PI_2 - heading.to_radians()) * speed
}

/// The 16-clip 8-way set: walk then run, each at 0°, 45°, ... 315°.
fn eight_way() -> (BlendSpace2D, Vec<Vec2>) {
    let ids = clip_ids(16);
    let points: Vec<Vec2> = [WALK, RUN].iter().flat_map(|speed| (0..8).map(move |k| velocity(45.0 * k as f32, *speed))).collect();
    let pairs: Vec<(Vec2, ClipId)> = points.iter().copied().zip(ids).collect();
    (BlendSpace2D::directional(&pairs).expect("the 8-way set builds"), points)
}

fn weights_2d(space: &BlendSpace2D, at: Vec2) -> Vec<f32> {
    let mut out = vec![f32::NAN; space.len()];
    space.weights(at, &mut out);
    out
}

#[test]
fn the_8_way_set_at_22_5_degrees_and_3_5_mps_weights_only_its_neighbours_and_sums_to_1() {
    let (space, _) = eight_way();
    let w = weights_2d(&space, velocity(22.5, 3.5));
    let sum: f32 = w.iter().sum();
    assert!((sum - 1.0).abs() <= 1e-6, "sums to {sum}: {w:?}");
    // walk 0° and 45° (0, 1), run 0° and 45° (8, 9).
    let neighbours = [0, 1, 8, 9];
    for (index, weight) in w.iter().enumerate() {
        if neighbours.contains(&index) {
            assert!(*weight > 0.1, "neighbour {index} has {weight}: {w:?}");
        } else {
            assert_eq!(*weight, 0.0, "clip {index} is not a neighbour: {w:?}");
        }
    }
    // Halfway in angle and in speed, the four share equally.
    for index in neighbours {
        assert!((w[index] - 0.25).abs() < 1e-5, "{w:?}");
    }
    // On an example point, that clip alone.
    let on = weights_2d(&space, velocity(90.0, RUN));
    assert!((on[10] - 1.0).abs() < 1e-6 && on.iter().enumerate().all(|(i, x)| i == 10 || *x == 0.0), "{on:?}");
    // Equal inputs give equal bits.
    let (again, _) = eight_way();
    let a = weights_2d(&again, velocity(22.5, 3.5));
    assert_eq!(a.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), w.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
}

#[test]
fn a_0_to_360_sweep_moves_no_weight_more_than_0_05_per_degree() {
    let (space, _) = eight_way();
    for speed in [1.0, WALK, 3.5, RUN, 6.0] {
        let mut previous = weights_2d(&space, velocity(0.0, speed));
        let mut worst: f32 = 0.0;
        for tenth in 1..=3600 {
            let heading = tenth as f32 / 10.0;
            let w = weights_2d(&space, velocity(heading, speed));
            let sum: f32 = w.iter().sum();
            assert!((sum - 1.0).abs() <= 1e-5, "{speed} m/s at {heading}°: sums to {sum}");
            if tenth % 10 == 0 {
                let step = w.iter().zip(&previous).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
                worst = worst.max(step);
                previous = w;
            }
        }
        assert!(worst <= 0.05, "{speed} m/s: a weight moved {worst} in one degree");
    }
    // A cartesian set with sliver triangles has no jump either: barycentric weights on a
    // triangulation are piecewise linear, so a weight is steep across a sliver (its gradient is
    // one over the sliver's thickness) but continuous. Ten times finer steps shrink the worst
    // step with them; a jump would stay as large at every step.
    let ids = clip_ids(6);
    let sliver = [Vec2::new(-1.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(0.0, 0.02), Vec2::new(0.0, -0.02), Vec2::new(0.0, 1.0), Vec2::new(0.0, -1.0)];
    let space = BlendSpace2D::cartesian(&sliver.iter().copied().zip(ids).collect::<Vec<_>>()).expect("builds");
    for radius in [0.3, 0.9, 1.4] {
        let sweep = |steps: u32| {
            let mut previous = weights_2d(&space, Vec2::new(radius, 0.0));
            let mut worst: f32 = 0.0;
            for step in 1..=steps {
                let w = weights_2d(&space, Vec2::from_angle(std::f32::consts::TAU * step as f32 / steps as f32) * radius);
                worst = worst.max(w.iter().zip(&previous).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max));
                previous = w;
            }
            worst
        };
        let (fine, finer) = (sweep(36_000), sweep(360_000));
        assert!(fine <= 0.02 && finer <= fine / 4.0 + 1e-5, "radius {radius}: worst step {fine} per 0.01°, {finer} per 0.001°");
    }
}

#[test]
fn a_1d_space_outside_its_range_clamps() {
    let ids = clip_ids(3);
    // Declared out of order: weights follow declaration order.
    let space = BlendSpace1D::new(&[(RUN, ids[0]), (0.0, ids[1]), (WALK, ids[2])]).expect("builds");
    let weights = |x: f32| {
        let mut out = vec![f32::NAN; 3];
        space.weights(x, &mut out);
        out
    };
    assert_eq!(weights(-3.0), vec![0.0, 1.0, 0.0], "below the lowest point: idle alone");
    assert_eq!(weights(9.0), vec![1.0, 0.0, 0.0], "above the highest: run alone");
    assert_eq!(weights(f32::INFINITY), vec![1.0, 0.0, 0.0]);
    assert_eq!(weights(f32::NEG_INFINITY), vec![0.0, 1.0, 0.0]);
    assert_eq!(weights(f32::NAN), vec![0.0, 1.0, 0.0], "NaN is the lowest point");
    let mid = weights(3.5);
    assert!((mid[0] - 0.5).abs() < 1e-6 && (mid[2] - 0.5).abs() < 1e-6 && mid[1] == 0.0, "{mid:?}");
    assert_eq!(weights(WALK), vec![0.0, 0.0, 1.0]);
    let single = BlendSpace1D::new(&[(1.0, ids[0])]).expect("one point");
    let mut out = [0.0];
    single.weights(-5.0, &mut out);
    assert_eq!(out, [1.0]);
}

#[test]
fn collinear_cartesian_points_fall_back_to_the_nearest_edge() {
    let ids = clip_ids(4);
    // On one line, declared out of order: no triangle exists.
    let points = [Vec2::new(2.0, 2.0), Vec2::new(0.0, 0.0), Vec2::new(3.0, 3.0), Vec2::new(1.0, 1.0)];
    let space = BlendSpace2D::cartesian(&points.iter().copied().zip(ids.iter().copied()).collect::<Vec<_>>()).expect("collinear builds");
    assert_eq!(space.triangle_count(), 0);
    // Off the line beside the (1,1)-(2,2) edge: projected onto it.
    let w = weights_2d(&space, Vec2::new(1.0, 2.0));
    assert!((w[3] - 0.5).abs() < 1e-5 && (w[0] - 0.5).abs() < 1e-5 && w[1] == 0.0 && w[2] == 0.0, "{w:?}");
    // Past an end: that end alone.
    assert_eq!(weights_2d(&space, Vec2::new(5.0, 6.0)), vec![0.0, 0.0, 1.0, 0.0]);
    assert_eq!(weights_2d(&space, Vec2::new(-4.0, -1.0)), vec![0.0, 1.0, 0.0, 0.0]);
    // A triangulated set outside its hull projects onto the nearest hull edge too.
    let square = [Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(1.0, 1.0), Vec2::new(0.0, 1.0)];
    let space = BlendSpace2D::cartesian(&square.iter().copied().zip(ids.iter().copied()).collect::<Vec<_>>()).expect("square builds");
    assert_eq!(space.triangle_count(), 2);
    let below = weights_2d(&space, Vec2::new(0.25, -3.0));
    assert!((below[0] - 0.75).abs() < 1e-5 && (below[1] - 0.25).abs() < 1e-5 && below[2] == 0.0 && below[3] == 0.0, "{below:?}");
    // Inside, the weights reproduce the point (linear precision).
    for at in [Vec2::new(0.3, 0.6), Vec2::new(0.9, 0.1), Vec2::new(0.5, 0.5)] {
        let w = weights_2d(&space, at);
        let back: Vec2 = w.iter().zip(&square).map(|(weight, point)| *point * *weight).sum();
        assert!((back - at).length() < 1e-5, "{at} gives back {back}");
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6);
    }
}

#[test]
fn a_blend_space_that_cannot_blend_is_refused_graph_invalid() {
    let ids = clip_ids(MAX_BLEND_POINTS + 1);
    let too_many: Vec<(Vec2, ClipId)> = ids.iter().enumerate().map(|(k, id)| (Vec2::new(k as f32, (k * k) as f32), *id)).collect();
    let cases: Vec<(&str, Vec<(Vec2, ClipId)>)> = vec![
        ("no point", vec![]),
        ("too many", too_many.clone()),
        ("a NaN", vec![(Vec2::new(f32::NAN, 0.0), ids[0])]),
        ("an infinity", vec![(Vec2::new(0.0, f32::INFINITY), ids[0])]),
        ("one place twice", vec![(Vec2::ONE, ids[0]), (Vec2::ONE, ids[1])]),
    ];
    for (what, points) in &cases {
        for (kind, result) in [("cartesian", BlendSpace2D::cartesian(points)), ("directional", BlendSpace2D::directional(points))] {
            let error = result.expect_err(what);
            assert_eq!(error.code, AnimationErrorCode::GraphInvalid, "{kind}: {what}");
        }
    }
    for (what, points) in [("no point", vec![]), ("a NaN", vec![(f32::NAN, ids[0])]), ("one place twice", vec![(1.0, ids[0]), (1.0, ids[1])])] {
        assert_eq!(BlendSpace1D::new(&points).expect_err(what).code, AnimationErrorCode::GraphInvalid, "1D: {what}");
    }
    let one_d: Vec<(f32, ClipId)> = ids.iter().enumerate().map(|(k, id)| (k as f32, *id)).collect();
    assert_eq!(BlendSpace1D::new(&one_d).expect_err("too many").code, AnimationErrorCode::GraphInvalid);
    // NaN and infinite queries answer finite weights summing to 1; a short output is left alone.
    let (space, _) = eight_way();
    for at in [Vec2::NAN, Vec2::new(f32::INFINITY, 0.0), Vec2::new(1e30, -1e30), Vec2::ZERO] {
        let w = weights_2d(&space, at);
        assert!(w.iter().all(|x| x.is_finite()), "{at}: {w:?}");
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5, "{at}: {w:?}");
    }
    let mut short = [7.0; 3];
    space.weights(Vec2::ONE, &mut short);
    assert_eq!(short, [7.0; 3], "an output shorter than the space is not written");
    // Markers outside [0, 1), NaN, out of order or too many are refused too.
    for (what, markers) in [
        ("NaN", vec![f32::NAN]),
        ("one", vec![1.0]),
        ("negative", vec![-0.1]),
        ("out of order", vec![0.5, 0.2]),
        ("twice", vec![0.2, 0.2]),
        ("too many", (0..=MAX_SYNC_MARKERS).map(|k| k as f32 / 1000.0).collect()),
    ] {
        assert_eq!(SyncTrack::new(&markers).expect_err(what).code, AnimationErrorCode::GraphInvalid, "markers: {what}");
    }
}

/// The 22-bone humanoid topology on UAL's names (the events rows' rig).
const TOPOLOGY: [(Option<usize>, [f32; 3], &str); 22] = [
    (None, [0.0, 1.0, 0.0], "pelvis"),
    (Some(0), [0.0, 0.1, 0.0], "spine_01"),
    (Some(1), [0.0, 0.12, 0.0], "spine_02"),
    (Some(2), [0.0, 0.12, 0.0], "spine_03"),
    (Some(3), [0.0, 0.15, 0.0], "neck_01"),
    (Some(4), [0.0, 0.1, 0.0], "Head"),
    (Some(3), [0.06, 0.12, 0.0], "clavicle_l"),
    (Some(6), [0.12, 0.0, 0.0], "upperarm_l"),
    (Some(7), [0.26, 0.0, 0.0], "lowerarm_l"),
    (Some(8), [0.24, 0.0, 0.0], "hand_l"),
    (Some(3), [-0.06, 0.12, 0.0], "clavicle_r"),
    (Some(10), [-0.12, 0.0, 0.0], "upperarm_r"),
    (Some(11), [-0.26, 0.0, 0.0], "lowerarm_r"),
    (Some(12), [-0.24, 0.0, 0.0], "hand_r"),
    (Some(0), [0.09, -0.05, 0.0], "thigh_l"),
    (Some(14), [0.0, -0.42, 0.0], "calf_l"),
    (Some(15), [0.0, -0.42, 0.0], "foot_l"),
    (Some(16), [0.0, -0.06, 0.12], "ball_l"),
    (Some(0), [-0.09, -0.05, 0.0], "thigh_r"),
    (Some(18), [0.0, -0.42, 0.0], "calf_r"),
    (Some(19), [0.0, -0.42, 0.0], "foot_r"),
    (Some(20), [0.0, -0.06, 0.12], "ball_r"),
];

/// `sin` for the fixture, from a quaternion (glam's libm), so the test calls no std transcendental.
fn sin(x: f32) -> f32 {
    let q = Quat::from_rotation_z(x);
    2.0 * q.z * q.w
}

/// The ankle's lift over a cycle for a foot that lands at `down` and lifts at `up` (cycle
/// fractions): flat in stance, a sine arc in swing that lands with speed.
fn lift(phase: f32, down: f32, up: f32) -> f32 {
    let since = (phase - down).rem_euclid(1.0);
    let stance = (up - down).rem_euclid(1.0);
    if since < stance {
        return 0.0;
    }
    0.12 * sin(std::f32::consts::PI * (since - stance) / (1.0 - stance))
}

/// A UAL-skeleton rig with an in-place locomotion clip of `seconds`, keyed at 60 fps, whose left
/// foot lands at `left` and right at `right` of the cycle (stance 55 %).
fn gait(name: &'static str, seconds: f32, left: f32, right: f32) -> (Rig, Clip) {
    let mut spec = RigSpec::new(name);
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let root = spec.joint("root", None, [0.0; 3], Quat::IDENTITY);
    let mut bones = Vec::new();
    for (parent, offset, bone) in TOPOLOGY {
        let parent = parent.map_or(Some(root), |p| Some(bones[p]));
        bones.push(spec.joint(bone, parent, offset, Quat::IDENTITY));
    }
    let keys = (seconds * 60.0).round() as usize;
    let times: Vec<f32> = (0..=keys).map(|k| k as f32 * seconds / keys as f32).collect();
    let mut channels = Vec::new();
    for (foot, down) in [(16, left), (20, right)] {
        let values = times.iter().flat_map(|t| [0.0, -0.42 + lift(t / seconds, down, (down + 0.55).rem_euclid(1.0)), 0.0]);
        channels.push(ChannelSpec { node: bones[foot], path: ChannelPath::Translation, interpolation: ChannelInterpolation::Linear, times: times.clone(), values: values.collect() });
    }
    spec.clips.push(ClipSpec { name: name.to_owned(), channels });
    let bytes = spec.glb();
    let rig = import_rig(&bytes).expect("the gait rig imports");
    let clip = import_clips(&bytes, &rig).expect("the gait clip imports").remove(0);
    (rig, clip)
}

/// Plays walk and run at 50/50 for `seconds` under `mode` and returns, per clip, the ticks at
/// which its left foot's touchdown notify fired.
fn left_touchdowns(mode: SyncMode, seconds: f32, walk: (&Rig, &Clip), run: (&Rig, &Clip)) -> [Vec<usize>; 2] {
    let mut tracks = Vec::new();
    let mut tables = Vec::new();
    for (rig, clip) in [walk, run] {
        let feet = humanoid_feet(rig.skeleton()).expect("feet");
        let contacts = foot_contacts(rig.skeleton(), clip, &feet, true, ContactRule::default());
        assert_eq!(contacts.len(), 2, "{}: {contacts:?}", clip.name());
        tracks.push(SyncTrack::from_contacts(&contacts, clip.duration()).expect("markers"));
        let clips = vec![clip.clone()];
        let mut builder = EventTable::builder(&clips);
        let left = builder.event("left_down");
        let id = AnimGraph::builder(rig.skeleton(), &clips).clips().next().expect("a clip").0;
        builder.contacts(id, &contacts, &[(feet[0], left)]);
        tables.push((builder.build().expect("a table"), id));
    }
    let clips = [
        SyncClip { duration: walk.1.duration(), weight: 0.5, markers: Some(&tracks[0]) },
        SyncClip { duration: run.1.duration(), weight: 0.5, markers: Some(&tracks[1]) },
    ];
    let mut group = SyncGroup::new(mode, &clips);
    let mut spans = [Span::advance(0.0, 0.0, 1.0, true); 2];
    let mut out = [Vec::new(), Vec::new()];
    for tick in 0..(seconds / TICK).round() as usize {
        group.advance(TICK, &clips, &mut spans);
        for (index, (table, id)) in tables.iter().enumerate() {
            crossed(table.notifies(*id), spans[index], |_| out[index].push(tick));
        }
    }
    out
}

/// The worst distance in ticks from each touchdown of `a` to the nearest of `b`.
fn worst_gap(a: &[usize], b: &[usize]) -> usize {
    a.iter().map(|x| b.iter().map(|y| x.abs_diff(*y)).min().unwrap_or(usize::MAX)).max().unwrap_or(usize::MAX)
}

#[test]
fn walk_and_run_at_50_50_keep_foot_contacts_within_a_frame_when_synced_and_drift_unsynced() {
    // Walk 1.0 s and run 0.7 s whose contacts sit at different fractions of their cycles.
    let (walk_rig, walk) = gait("Walk", 1.0, 0.10, 0.60);
    let (run_rig, run) = gait("Run", 0.7, 0.20, 0.70);
    let synced = left_touchdowns(SyncMode::Markers, 6.0, (&walk_rig, &walk), (&run_rig, &run));
    assert!(synced[0].len() >= 6, "{synced:?}");
    let gap = worst_gap(&synced[0], &synced[1]);
    assert!(gap <= 1, "synced: left touchdowns {gap} ticks apart: {synced:?}");
    assert_eq!(synced[0].len(), synced[1].len(), "one run touchdown per walk touchdown");
    let free = left_touchdowns(SyncMode::Off, 6.0, (&walk_rig, &walk), (&run_rig, &run));
    let gap = worst_gap(&free[0], &free[1]);
    assert!(gap > 1, "unsynced the clips drift apart, yet the worst gap is {gap}: {free:?}");
    // Normalized sync lines up contacts only when they sit at equal fractions of each cycle.
    let normalized = left_touchdowns(SyncMode::Normalized, 6.0, (&walk_rig, &walk), (&run_rig, &run));
    assert!(worst_gap(&normalized[0], &normalized[1]) > 1, "contacts at 0.10 and 0.20 stay apart: {normalized:?}");
    let (even_rig, even) = gait("RunEven", 0.7, 0.10, 0.60);
    let normalized = left_touchdowns(SyncMode::Normalized, 6.0, (&walk_rig, &walk), (&even_rig, &even));
    assert!(worst_gap(&normalized[0], &normalized[1]) <= 1, "{normalized:?}");
}

#[test]
fn a_synced_group_plays_at_the_blended_cycle_and_keeps_spans_chained() {
    let a = SyncTrack::new(&[0.1, 0.6]).expect("markers");
    let b = SyncTrack::new(&[0.2, 0.7]).expect("markers");
    let clips = [SyncClip { duration: 1.0, weight: 0.5, markers: Some(&a) }, SyncClip { duration: 0.7, weight: 0.5, markers: Some(&b) }];
    let mut group = SyncGroup::new(SyncMode::Markers, &clips);
    let mut spans = [Span::advance(0.0, 0.0, 1.0, true); 2];
    let mut previous: Option<[f32; 2]> = None;
    let mut cycles = 0.0;
    let ticks = 600;
    for _ in 0..ticks {
        group.advance(TICK, &clips, &mut spans);
        if let Some(previous) = previous {
            assert_eq!(spans[0].from(), previous[0], "a span starts where the last ended");
            assert_eq!(spans[1].from(), previous[1]);
        }
        cycles += spans[0].to() - spans[0].from() + if spans[0].laps() > 0 { 1.0 } else { 0.0 };
        previous = Some([spans[0].to(), spans[1].to()]);
    }
    // 10 s at the 50/50 blended cycle of 0.85 s is about 11.76 walk cycles.
    let expected = 10.0 / 0.85;
    assert!((cycles - expected).abs() < 0.02, "{cycles} cycles, expected {expected}");
    // Weights that are all 0, NaN or negative play at the plain mean, never stall.
    let odd = [SyncClip { weight: f32::NAN, ..clips[0] }, SyncClip { weight: -1.0, ..clips[1] }];
    let mut group = SyncGroup::new(SyncMode::Markers, &odd);
    group.advance(TICK, &odd, &mut spans);
    assert!(spans[0].to() != spans[0].from());
    // A NaN or infinite dt does not move it.
    let before = spans;
    group.advance(f32::NAN, &odd, &mut spans);
    assert_eq!(spans[0].to(), before[0].to());
    group.advance(f32::INFINITY, &odd, &mut spans);
    assert_eq!(spans[0].to(), before[0].to());
    // Mismatched marker counts fall back to normalized sync for the whole group.
    let one = SyncTrack::new(&[0.3]).expect("markers");
    let mixed = [SyncClip { duration: 1.0, weight: 1.0, markers: Some(&a) }, SyncClip { duration: 0.5, weight: 0.0, markers: Some(&one) }];
    let mut group = SyncGroup::new(SyncMode::Markers, &mixed);
    group.advance(0.25, &mixed, &mut spans);
    assert!((spans[0].to() - 0.25).abs() < 1e-6 && (spans[1].to() - 0.125).abs() < 1e-6, "{spans:?}");
}

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn a_weight_evaluation_takes_at_most_a_microsecond() {
    // Advisory in the lane (budgets gate at integrates, release build, quiet machine).
    let (space, _) = eight_way();
    let mut out = vec![0.0; space.len()];
    let rounds = 20_000;
    let start = std::time::Instant::now();
    let mut checksum = 0.0;
    for k in 0..rounds {
        space.weights(std::hint::black_box(velocity(k as f32 * 0.37, 1.0 + (k % 50) as f32 * 0.1)), &mut out);
        checksum += out[0];
    }
    let per = start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds);
    let ids = clip_ids(16);
    let grid: Vec<(Vec2, ClipId)> = (0..16).map(|k| (Vec2::new((k % 4) as f32, (k / 4) as f32 + 0.01 * (k % 3) as f32), ids[k])).collect();
    let cartesian = BlendSpace2D::cartesian(&grid).expect("grid");
    let start = std::time::Instant::now();
    for k in 0..rounds {
        cartesian.weights(Vec2::new((k % 37) as f32 * 0.1 - 0.2, (k % 41) as f32 * 0.09 - 0.3), &mut out);
        checksum += out[0];
    }
    let per_cartesian = start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds);
    let one_d = BlendSpace1D::new(&ids[..5].iter().enumerate().map(|(k, id)| (k as f32, *id)).collect::<Vec<_>>()).expect("1D");
    let start = std::time::Instant::now();
    for k in 0..rounds {
        one_d.weights((k % 60) as f32 * 0.1 - 0.5, &mut out);
        checksum += out[0];
    }
    let per_1d = start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds);
    // Recorded, not asserted: lane timings are advisory (plan 4.4); the budget is 1 µs.
    println!("AN-8 budget (1 us): directional 16 {per:.3} us, cartesian 16 {per_cartesian:.3} us, 1D 5 {per_1d:.3} us (checksum {checksum})");
}
