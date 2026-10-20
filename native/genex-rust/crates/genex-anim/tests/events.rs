//! AN-6: notifies and foot contacts. An event at 0.0 on a looping clip fires once per loop and
//! never twice at the wrap; reverse playback fires it; a state at weight 0.05 is filtered at the
//! default threshold 0.1 and kept under `All`; the walk's foot contacts are found twice per cycle
//! within one frame of their labelled times; and events read only clip time, so evaluating poses
//! at a lower rate (pose LOD) never changes them.

mod support;

use genex_anim::clip::{Clip, Interpolation, Track, TrackValues};
use genex_anim::events::{
    ContactRule, EVENT_THRESHOLD, EventFilter, EventTable, Fired, FootContact, MAX_EVENT_NAME_BYTES, MAX_LAPS_PER_SPAN, Notify, Played, Span, collect, crossed, foot_contacts, humanoid_feet,
    read_event_extras,
};
use genex_anim::import::{Rig, import_rig};
use genex_anim::graph::AnimGraph;
use genex_anim::sample::{SampleCursor, Wrap, sample, wrap_time};
use genex_anim::{AnimationErrorCode, ClipId};
use genex_core::json::{self, Value};
use genex_core::rng::Pcg32;
use glam::{Quat, Vec3};
use support::{ChannelInterpolation, ChannelPath, ChannelSpec, ClipSpec, RigSpec};

/// One tick of a 60 Hz game.
const TICK: f32 = 1.0 / 60.0;

/// A clip of `seconds` that moves the first joint of `rig`.
fn clip(rig: &Rig, name: &str, seconds: f32) -> Clip {
    let joint = rig.skeleton().joints().next().expect("a joint");
    let track = Track::new(joint, Interpolation::Linear, vec![0.0, seconds], TrackValues::Translation(vec![Vec3::ZERO, Vec3::Y])).expect("a track");
    Clip::new(name, vec![track]).expect("a clip")
}

/// The handle of clip `index` (handles come from a graph builder over that many clips).
fn clip_id(index: usize) -> ClipId {
    let rig = chain();
    let clips: Vec<Clip> = (0..=index).map(|k| clip(&rig, &format!("c{k}"), 1.0)).collect();
    AnimGraph::builder(rig.skeleton(), &clips).clips().nth(index).map(|(id, _)| id).expect("a clip id")
}

fn chain() -> Rig {
    import_rig(&support::chain3().glb()).expect("the chain fixture imports")
}

/// The events one clip fires over a span, as (event, time).
fn fired(notifies: &[Notify], span: Span) -> Vec<(u32, f32)> {
    let mut out = Vec::new();
    crossed(notifies, span, |notify| out.push((notify.event.raw(), notify.time)));
    out
}

/// A table of one clip with `notifies` as (name, time).
fn table(clips: &[Clip], clip: usize, notifies: &[(&str, f32)]) -> EventTable {
    let mut builder = EventTable::builder(clips);
    for (name, time) in notifies {
        let event = builder.event(name);
        builder.at(clip_id(clip), *time, event);
    }
    builder.build().expect("the table builds")
}

/// Ticks a looping clip of `length` from 0 at `dt × speed` per tick the way the machine does
/// (`time + delta` wrapped by fmod) and returns, per tick, the events fired.
fn play(notifies: &[Notify], length: f32, looping: bool, speed: f32, dt: f32, ticks: usize) -> Vec<Vec<(u32, f32)>> {
    let mut time = if !looping && speed < 0.0 { length } else { 0.0 };
    let mut out = Vec::with_capacity(ticks);
    for _ in 0..ticks {
        let span = Span::advance(time, dt * speed, length, looping);
        out.push(fired(notifies, span));
        time = span.to();
    }
    out
}

#[test]
fn an_event_at_zero_on_a_loop_fires_once_per_loop_never_twice_at_the_wrap() {
    let rig = chain();
    let clips = vec![clip(&rig, "Walk", 1.0)];
    let events = table(&clips, 0, &[("step", 0.0)]);
    let notifies = events.notifies(clip_id(0));
    // dt = 0.25 lands exactly on the wrap; 1/60 accumulates rounding; 0.3 never divides the loop.
    for dt in [0.25, TICK, 0.3, 0.7] {
        let ticks = (10.0 / dt).round() as usize;
        let per_tick = play(notifies, 1.0, true, 1.0, dt, ticks);
        let total: usize = per_tick.iter().map(Vec::len).sum();
        assert_eq!(total, 10, "dt {dt}: one fire per loop over 10 loops");
        assert!(per_tick.iter().all(|tick| tick.len() <= 1), "dt {dt}: never twice in one tick");
        assert_eq!(per_tick[0], vec![(0, 0.0)], "dt {dt}: the first tick plays time 0");
        // Two fires are always a loop apart (in ticks, within the rounding of one tick).
        let fires: Vec<usize> = per_tick.iter().enumerate().filter(|(_, tick)| !tick.is_empty()).map(|(index, _)| index).collect();
        for pair in fires.windows(2) {
            let gap = (pair[1] - pair[0]) as f32 * dt;
            assert!((gap - 1.0).abs() <= dt + 1e-4, "dt {dt}: fires {gap} s apart");
        }
    }
    // A tick that ends exactly on the loop end does not play it; the next tick does, once.
    let landing = Span::advance(0.75, 0.25, 1.0, true);
    assert_eq!(landing.to(), 0.0);
    assert_eq!(fired(notifies, landing), vec![]);
    assert_eq!(fired(notifies, Span::advance(landing.to(), 0.25, 1.0, true)), vec![(0, 0.0)]);
    // An event at the loop's end is the same point as its start: it fires once per loop too.
    let at_end = table(&clips, 0, &[("end", 1.0)]);
    let per_tick = play(at_end.notifies(clip_id(0)), 1.0, true, 1.0, TICK, 600);
    assert_eq!(per_tick.iter().map(Vec::len).sum::<usize>(), 10);
}

#[test]
fn reverse_playback_fires_it() {
    let rig = chain();
    let clips = vec![clip(&rig, "Walk", 1.0)];
    let events = table(&clips, 0, &[("step", 0.0), ("swing", 0.3)]);
    let notifies = events.notifies(clip_id(0));
    for dt in [TICK, 0.25, 0.3] {
        let ticks = (10.0 / dt).round() as usize;
        let per_tick = play(notifies, 1.0, true, -1.0, dt, ticks);
        let step = per_tick.iter().flatten().filter(|(event, _)| *event == 0).count();
        let swing = per_tick.iter().flatten().filter(|(event, _)| *event == 1).count();
        assert_eq!((step, swing), (10, 10), "dt {dt}: each once per loop backwards");
    }
    // Within one tick, backwards plays later times first.
    assert_eq!(fired(notifies, Span::advance(0.4, -0.5, 1.0, true)), vec![(1, 0.3), (0, 0.0)]);
    // A `once` clip played backwards starts at its end and stops at 0, firing 0 once.
    let per_tick = play(notifies, 1.0, false, -1.0, TICK, 180);
    assert_eq!(per_tick.iter().flatten().copied().collect::<Vec<_>>(), vec![(1, 0.3), (0, 0.0)]);
    // Forward, a `once` clip fires an event at its very end once and never while it holds there.
    let ends = table(&clips, 0, &[("done", 1.0)]);
    let per_tick = play(ends.notifies(clip_id(0)), 1.0, false, 1.0, TICK, 180);
    assert_eq!(per_tick.iter().map(Vec::len).sum::<usize>(), 1);
    // A reversal at an event never fires it twice: forward up to 0.3 (not played), then back.
    let forward = Span::advance(0.2, 0.1, 1.0, true);
    assert_eq!(fired(notifies, forward), vec![]);
    assert_eq!(fired(notifies, Span::advance(forward.to(), -0.1, 1.0, true)), vec![(1, 0.3)]);
}

#[test]
fn a_state_at_weight_005_is_filtered_at_the_default_threshold_and_kept_under_all() {
    let rig = chain();
    let clips = vec![clip(&rig, "Walk", 1.0), clip(&rig, "Run", 0.6)];
    let mut builder = EventTable::builder(&clips);
    let step = builder.event("step");
    builder.at(clip_id(0), 0.5, step).at(clip_id(1), 0.3, step);
    let events = builder.build().expect("the table builds");
    let played = [
        Played { clip: clip_id(0), span: Span::advance(0.45, 0.1, 1.0, true), weight: 0.95 },
        Played { clip: clip_id(1), span: Span::advance(0.25, 0.1, 0.6, true), weight: 0.05 },
    ];
    assert_eq!(EVENT_THRESHOLD, 0.1);
    assert_eq!(EventFilter::default(), EventFilter::AtLeast(EVENT_THRESHOLD));
    let run = |filter: EventFilter| {
        let mut out = Vec::new();
        collect(&events, &played, filter, &mut out);
        out
    };
    let walk = Fired { event: step, clip: clip_id(0), time: 0.5, weight: 0.95 };
    let faint = Fired { event: step, clip: clip_id(1), time: 0.3, weight: 0.05 };
    assert_eq!(run(EventFilter::default()), vec![walk], "0.05 is under 0.1");
    assert_eq!(run(EventFilter::All), vec![walk, faint], "All keeps it");
    assert_eq!(run(EventFilter::Heaviest), vec![walk], "only the heaviest clip");
    assert_eq!(run(EventFilter::AtLeast(0.05)), vec![walk, faint], "at the threshold is kept");
    // A weight that is NaN, negative or infinite counts as 0; `All` still keeps it.
    let odd = [Played { weight: f32::NAN, ..played[0] }, Played { weight: -1.0, ..played[1] }];
    let mut out = Vec::new();
    collect(&events, &odd, EventFilter::default(), &mut out);
    assert!(out.is_empty());
    collect(&events, &odd, EventFilter::All, &mut out);
    assert_eq!(out.iter().map(|fired| fired.weight).collect::<Vec<_>>(), vec![0.0, 0.0]);
    assert_eq!(events.name(step), "step");
    assert_eq!(events.event("step"), Some(step));
}

/// The 22-bone humanoid topology (`HumanoidBone` order): parent and rest offset in metres. The
/// ankles rest 0.11 m above the model origin.
const TOPOLOGY: [(Option<usize>, [f32; 3]); 22] = [
    (None, [0.0, 1.0, 0.0]),
    (Some(0), [0.0, 0.1, 0.0]),
    (Some(1), [0.0, 0.12, 0.0]),
    (Some(2), [0.0, 0.12, 0.0]),
    (Some(3), [0.0, 0.15, 0.0]),
    (Some(4), [0.0, 0.1, 0.0]),
    (Some(3), [0.06, 0.12, 0.0]),
    (Some(6), [0.12, 0.0, 0.0]),
    (Some(7), [0.26, 0.0, 0.0]),
    (Some(8), [0.24, 0.0, 0.0]),
    (Some(3), [-0.06, 0.12, 0.0]),
    (Some(10), [-0.12, 0.0, 0.0]),
    (Some(11), [-0.26, 0.0, 0.0]),
    (Some(12), [-0.24, 0.0, 0.0]),
    (Some(0), [0.09, -0.05, 0.0]),
    (Some(14), [0.0, -0.42, 0.0]),
    (Some(15), [0.0, -0.42, 0.0]),
    (Some(16), [0.0, -0.06, 0.12]),
    (Some(0), [-0.09, -0.05, 0.0]),
    (Some(18), [0.0, -0.42, 0.0]),
    (Some(19), [0.0, -0.42, 0.0]),
    (Some(20), [0.0, -0.06, 0.12]),
];

/// Quaternius UAL's skeleton is the UE mannequin's (AN-4's look-alike row).
const UAL_NAMES: [&str; 22] = [
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "thigh_l",
    "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r",
];

/// The ankle's height above its stance height over a walk cycle, for a foot that lands at
/// `down` and lifts at `up` (cycle fractions): flat in stance, a 1 cm heel lift over the last
/// 6 % of the cycle before lifting, and a 12 cm sine arc in swing that meets the ground with
/// speed (a heel strike), as captured walks do.
fn ankle_lift(phase: f32, down: f32, up: f32) -> f32 {
    let since_down = (phase - down).rem_euclid(1.0);
    let stance = (up - down).rem_euclid(1.0);
    if since_down < stance {
        let heel = since_down - (stance - 0.06);
        return if heel > 0.0 { 0.01 * heel / 0.06 } else { 0.0 };
    }
    let swing = 1.0 - stance;
    let u = (since_down - stance) / swing;
    0.01 + (0.12 - 0.01 * u) * sin(std::f32::consts::PI * u)
}

/// `sin` for the fixture (test-side; the crate never calls std transcendentals).
fn sin(x: f32) -> f32 {
    Quat::from_rotation_z(x).z * 2.0 * Quat::from_rotation_z(x).w
}

/// A UE-mannequin rig with an in-place walk of `seconds`, keyed at 30 fps: the pelvis bobs and
/// each ankle follows [`ankle_lift`]. Left lands at 0.10 and lifts at 0.62 of the cycle; right
/// lands at 0.60 and lifts at 0.12.
fn walk_rig(seconds: f32) -> (Rig, Clip) {
    let mut spec = RigSpec::new("ual-walk");
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let root = spec.joint("root", None, [0.0; 3], Quat::IDENTITY);
    let mut bones = Vec::new();
    for (index, (parent, offset)) in TOPOLOGY.iter().enumerate() {
        let parent = parent.map_or(Some(root), |p| Some(bones[p]));
        bones.push(spec.joint(UAL_NAMES[index], parent, *offset, Quat::IDENTITY));
    }
    let keys = (seconds * 30.0).round() as usize;
    let times: Vec<f32> = (0..=keys).map(|k| k as f32 * seconds / keys as f32).collect();
    let bob = |phase: f32| 0.02 * sin(4.0 * std::f32::consts::PI * phase);
    let mut channels = vec![ChannelSpec {
        node: bones[0],
        path: ChannelPath::Translation,
        interpolation: ChannelInterpolation::Linear,
        times: times.clone(),
        values: times.iter().flat_map(|t| [0.0, 1.0 + bob(t / seconds), 0.0]).collect(),
    }];
    for (foot, down, up) in [(16, 0.10, 0.62), (20, 0.60, 0.12)] {
        // The ankle's model height is pelvis + thigh + calf + foot offsets (no rotations), so the
        // foot's local y carries the designed height minus the bob.
        let values = times.iter().flat_map(|t| {
            let phase = t / seconds;
            let height = 0.11 + ankle_lift(phase, down, up);
            [0.0, height - (1.0 + bob(phase)) + 0.05 + 0.42, 0.0]
        });
        channels.push(ChannelSpec { node: bones[foot], path: ChannelPath::Translation, interpolation: ChannelInterpolation::Linear, times: times.clone(), values: values.collect() });
    }
    spec.clips.push(ClipSpec { name: "Walk_Loop".to_owned(), channels });
    let bytes = spec.glb();
    let rig = import_rig(&bytes).expect("the walk rig imports");
    let clip = genex_anim::clip::import_clips(&bytes, &rig).expect("the walk clip imports").remove(0);
    (rig, clip)
}

#[test]
fn the_walks_foot_contacts_are_found_twice_per_cycle_within_one_frame() {
    // The curated Quaternius UAL pack is held (C-22), so this is a synthetic walk on UAL's
    // skeleton; the real UAL walk row runs once the pack is fetched by sha256.
    for seconds in [1.0, 1.2, 0.8] {
        let (rig, walk) = walk_rig(seconds);
        let feet = humanoid_feet(rig.skeleton()).expect("UAL's feet map");
        assert_eq!(rig.skeleton().name(feet[0]), "foot_l");
        assert_eq!(rig.skeleton().name(feet[1]), "foot_r");
        let rule = ContactRule::default();
        let contacts = foot_contacts(rig.skeleton(), &walk, &feet, true, rule);
        assert_eq!(contacts.len(), 2, "{seconds} s: two contacts per cycle, got {contacts:?}");
        let frame = 1.0 / rule.rate;
        for (foot, labelled) in [(feet[0], 0.10), (feet[1], 0.60)] {
            let found: Vec<&FootContact> = contacts.iter().filter(|contact| contact.foot == foot).collect();
            assert_eq!(found.len(), 1, "{seconds} s: one touchdown per foot");
            // Labelled as a person would on the keyed clip: the first 30 fps key at or after the
            // designed touchdown (keys between are interpolated, so the foot plants on a key).
            let labelled = (labelled * seconds * 30.0 - 1e-3).ceil() / 30.0;
            let error = (found[0].start - labelled).abs();
            assert!(error <= frame + 1e-5, "{seconds} s: {} lands at {} s, labelled {labelled} s", rig.skeleton().name(foot), found[0].start);
        }
        // Ordered by touchdown; the right stance wraps the loop end (it lifts at 0.12).
        assert!(contacts[0].start < contacts[1].start);
        let right = contacts.iter().find(|contact| contact.foot == feet[1]).expect("right");
        assert!(right.end < right.start, "the right stance crosses the loop end: {right:?}");
        // Contacts become notifies: one event per foot at its touchdown.
        let clips = vec![walk.clone()];
        let mut builder = EventTable::builder(&clips);
        let left_down = builder.event("foot_l_down");
        let right_down = builder.event("foot_r_down");
        builder.contacts(clip_id(0), &contacts, &[(feet[0], left_down), (feet[1], right_down)]);
        let events = builder.build().expect("the table builds");
        let notifies = events.notifies(clip_id(0));
        assert_eq!(notifies.iter().map(|notify| notify.event).collect::<Vec<_>>(), vec![left_down, right_down]);
    }
}

#[test]
fn a_still_or_empty_clip_has_no_footsteps_and_hostile_rules_do_not_panic() {
    let (rig, walk) = walk_rig(1.0);
    let feet = humanoid_feet(rig.skeleton()).expect("feet");
    // Standing (the rest pose): one contact per foot lasting the whole clip.
    let root = rig.skeleton().joints().next().expect("a joint");
    let hold = Track::new(root, Interpolation::Linear, vec![0.0, 1.0], TrackValues::Translation(vec![Vec3::ZERO, Vec3::ZERO])).expect("a track");
    let still = Clip::new("Still", vec![hold]).expect("a clip");
    let contacts = foot_contacts(rig.skeleton(), &Clip::new("Empty", vec![]).expect("empty"), &feet, true, ContactRule::default());
    assert!(contacts.is_empty(), "a clip of no length has no contacts");
    let standing = foot_contacts(rig.skeleton(), &still, &feet, true, ContactRule::default());
    assert!(standing.iter().all(|contact| contact.start == 0.0), "{standing:?}");
    // A joint past the skeleton, a NaN rate, a zero rate and a negative band answer, never panic.
    let hostile = [
        ContactRule { rate: f32::NAN, ..ContactRule::default() },
        ContactRule { rate: 0.0, ..ContactRule::default() },
        ContactRule { rate: 1e9, ..ContactRule::default() },
        ContactRule { height_band: -1.0, ..ContactRule::default() },
        ContactRule { max_vertical_speed: f32::INFINITY, ..ContactRule::default() },
    ];
    for rule in hostile {
        let _ = foot_contacts(rig.skeleton(), &walk, &feet, true, rule);
    }
    let far = import_rig(&support::tree("tree60", 60).glb()).expect("tree");
    let past = far.skeleton().joints().last().expect("a joint");
    assert!(foot_contacts(rig.skeleton(), &walk, &[past], true, ContactRule::default()).is_empty());
    // The chain has no humanoid feet.
    assert!(humanoid_feet(chain().skeleton()).is_none());
}

/// For the oracle: how many times the point `t` (in `[0, length]`, `length` ≡ 0 on a loop) lies
/// in the half-open played interval from `from` by `delta` (unwrapped), in f64.
fn occurrences(t: f32, from: f64, delta: f64, length: f64) -> usize {
    let t = if f64::from(t) >= length { 0.0 } else { f64::from(t) };
    let (low, high) = if delta >= 0.0 { (from, from + delta) } else { (from + delta, from) };
    // Points t + k·length in [low, high) going forward, (low, high] going backward.
    let mut count = 0;
    let first = ((low - t) / length).floor() as i64 - 1;
    for k in first..first + 64 {
        let point = t + k as f64 * length;
        let inside = if delta >= 0.0 { point >= low && point < high } else { point > low && point <= high };
        count += usize::from(inside);
    }
    count
}

#[test]
fn every_notify_fires_once_per_occurrence_and_never_reads_a_pose() {
    let rig = chain();
    let mut rng = Pcg32::seeded(6);
    for case in 0..200 {
        let length = rng.range_f32(0.2, 2.0);
        let clips = vec![clip(&rig, "Clip", length)];
        let count = 1 + rng.below(6) as usize;
        let names: Vec<String> = (0..count).map(|index| format!("e{index}")).collect();
        let mut builder = EventTable::builder(&clips);
        for name in &names {
            let event = builder.event(name);
            let time = if rng.chance(0.2) { 0.0 } else { rng.range_f32(0.0, length) };
            builder.at(clip_id(0), time, event);
        }
        let events = builder.build().expect("the table builds");
        let notifies = events.notifies(clip_id(0)).to_vec();
        // A script of speeds (some backwards) and tick lengths, played twice: once evaluating
        // the pose every tick, once every `lod` ticks (pose LOD). The events must not differ.
        let script: Vec<(f32, f32)> = (0..240).map(|_| (if rng.chance(0.2) { -rng.range_f32(0.2, 2.5) } else { rng.range_f32(0.0, 2.5) }, rng.range_f32(0.004, 0.05))).collect();
        let lod = 2 + rng.below(6) as usize;
        let mut runs = Vec::new();
        for rate in [1, lod] {
            let mut pose = rig.skeleton().rest_pose().to_vec();
            let mut cursor = SampleCursor::new();
            let mut time = 0.0;
            let mut out = Vec::new();
            for (tick, (speed, dt)) in script.iter().enumerate() {
                let span = Span::advance(time, dt * speed, length, true);
                let mut fired = Vec::new();
                crossed(&notifies, span, |notify| fired.push(notify));
                let expected: usize = notifies.iter().map(|n| occurrences(n.time, f64::from(time), f64::from(dt * speed), f64::from(length))).sum();
                // The f64 oracle can disagree only for a notify within rounding of an end.
                let near_end = notifies.iter().any(|n| (n.time - time).abs() < 1e-5 || (n.time - span.to()).abs() < 1e-5 || (length - n.time) < 1e-5);
                if !near_end && f64::from((dt * speed).abs()) < f64::from(length) * f64::from(MAX_LAPS_PER_SPAN) {
                    assert_eq!(fired.len(), expected, "case {case} tick {tick}: from {time} by {} over {length}", dt * speed);
                }
                out.push(fired);
                time = span.to();
                if tick % rate == 0 {
                    sample(&clips[0], time, Wrap::Loop, &mut cursor, &mut pose);
                }
            }
            assert_eq!(time, wrap_time(length, time, Wrap::Loop), "times stay inside the clip");
            runs.push(out);
        }
        assert_eq!(runs[0], runs[1], "case {case}: pose LOD {lod} changed the events");
    }
}

#[test]
fn spans_chain_like_the_machine_and_hostile_spans_fire_nothing() {
    let rig = chain();
    let clips = vec![clip(&rig, "Walk", 1.0)];
    let events = table(&clips, 0, &[("a", 0.0), ("b", 0.1), ("c", 0.9)]);
    let notifies = events.notifies(clip_id(0));
    // The machine's arithmetic: 0.9 + 0.2 wraps to fmod(1.1, 1.0), and the next span starts
    // there, so 0.1 fires in exactly one of the two ticks whatever the rounding.
    let first = Span::advance(0.9, 0.2, 1.0, true);
    assert_eq!(first.to(), (0.9f32 + 0.2).rem_euclid(1.0));
    let second = Span::advance(first.to(), 0.2, 1.0, true);
    let both: Vec<(u32, f32)> = [fired(notifies, first), fired(notifies, second)].concat();
    assert_eq!(both.iter().filter(|(event, _)| *event == 1).count(), 1);
    // Between two wrapped times, at most one lap.
    assert_eq!(fired(notifies, Span::between(0.85, 0.05, 1.0, true, false)), vec![(2, 0.9), (0, 0.0)]);
    assert_eq!(fired(notifies, Span::between(0.05, 0.85, 1.0, true, true)), vec![(0, 0.0), (2, 0.9)]);
    assert_eq!(fired(notifies, Span::between(0.5, 0.5, 1.0, true, false)), vec![]);
    // Many laps in one tick fire each lap, capped.
    let laps = Span::advance(0.5, 3.0, 1.0, true);
    assert_eq!(fired(notifies, laps).len(), 9, "three laps of three notifies");
    let capped = Span::advance(0.0, 1e30, 1.0, true);
    assert!(fired(notifies, capped).len() <= notifies.len() * (MAX_LAPS_PER_SPAN as usize + 1));
    // NaN, infinite or zero movement, a NaN start and a clip of no length fire nothing.
    for span in [
        Span::advance(0.5, f32::NAN, 1.0, true),
        Span::advance(0.5, f32::INFINITY, 1.0, true),
        Span::advance(f32::NAN, 0.1, 1.0, true),
        Span::advance(0.5, 0.0, 1.0, true),
        Span::advance(0.5, 0.1, 0.0, true),
        Span::advance(0.5, 0.1, f32::NAN, false),
    ] {
        assert_eq!(fired(notifies, span), vec![], "{span:?}");
        assert!(span.to().is_finite());
    }
}

/// Declares notifies on a builder for one refusal case.
type Declare = Box<dyn Fn(&mut genex_anim::events::EventTableBuilder<'_>)>;

#[test]
fn a_table_that_cannot_fire_is_refused_graph_invalid_and_builds_nothing() {
    let rig = chain();
    let clips = vec![clip(&rig, "Walk", 1.0)];
    let long = "x".repeat(MAX_EVENT_NAME_BYTES + 1);
    let foreign = {
        let mut other = EventTable::builder(&clips);
        (0..41).map(|k| other.event(&format!("f{k}"))).last().expect("an event")
    };
    let cases: Vec<(&str, Declare)> = vec![
        ("NaN time", Box::new(|b| {
            let e = b.event("e");
            b.at(clip_id(0), f32::NAN, e);
        })),
        ("negative time", Box::new(|b| {
            let e = b.event("e");
            b.at(clip_id(0), -0.1, e);
        })),
        ("past the clip", Box::new(|b| {
            let e = b.event("e");
            b.at(clip_id(0), 1.5, e);
        })),
        ("another clip", Box::new(|b| {
            let e = b.event("e");
            b.at(clip_id(7), 0.5, e);
        })),
        ("another table's event", Box::new(move |b| {
            b.at(clip_id(0), 0.5, foreign);
        })),
        ("an empty name", Box::new(|b| {
            let e = b.event("");
            b.at(clip_id(0), 0.5, e);
        })),
        ("a long name", Box::new(move |b| {
            let e = b.event(&long);
            b.at(clip_id(0), 0.5, e);
        })),
        ("declared twice", Box::new(|b| {
            let e = b.event("e");
            b.at(clip_id(0), 0.5, e).at(clip_id(0), 0.5, e);
        })),
        ("too many on a clip", Box::new(|b| {
            let e = b.event("e");
            for k in 0..=genex_anim::events::MAX_NOTIFIES_PER_CLIP {
                b.at(clip_id(0), k as f32 / 1000.0, e);
            }
        })),
        ("too many names", Box::new(|b| {
            for k in 0..=genex_anim::events::MAX_EVENTS {
                b.event(&format!("e{k}"));
            }
        })),
    ];
    for (what, declare) in &cases {
        let mut builder = EventTable::builder(&clips);
        declare(&mut builder);
        let error = builder.build().expect_err(what);
        assert_eq!(error.code, AnimationErrorCode::GraphInvalid, "{what}");
        assert_eq!(error.code.wire(), "animation-graph-invalid");
    }
    // The same name twice is one event.
    let mut builder = EventTable::builder(&clips);
    assert_eq!(builder.event("step"), builder.event("step"));
}

/// The walk GLB with `extras` set on its first animation.
fn walk_with_extras(extras: Value) -> Vec<u8> {
    let mut spec = RigSpec::new("events-extras");
    spec.mesh_node = spec.node("Body", None, [0.0; 3], Quat::IDENTITY, [1.0; 3]);
    let root = spec.joint("root", None, [0.0; 3], Quat::IDENTITY);
    spec.clips.push(ClipSpec {
        name: "Walk".to_owned(),
        channels: vec![ChannelSpec { node: root, path: ChannelPath::Translation, interpolation: ChannelInterpolation::Linear, times: vec![0.0, 1.0], values: vec![0.0; 6] }],
    });
    let (text, bin) = spec.json_and_bin();
    let mut root_json = json::parse(text.as_bytes()).expect("the fixture JSON parses");
    let animations = root_json.get("animations").expect("animations").clone();
    let mut animations = animations.items().to_vec();
    animations[0].set("extras", extras);
    root_json.set("animations", Value::Array(animations));
    support::glb(&String::from_utf8(root_json.dump()).expect("utf-8"), &bin)
}

fn events_extras(entries: &[(&str, f64)]) -> Value {
    let mut list = Value::array();
    for (name, time) in entries {
        let mut entry = Value::object();
        entry.set("name", Value::from(*name));
        entry.set("time", Value::from(*time));
        list.push(entry);
    }
    let mut extras = Value::object();
    extras.set("genex_events", list);
    extras
}

#[test]
fn the_genex_events_extras_reader_reads_its_fixture_and_refuses_hostile_extras() {
    let bytes = walk_with_extras(events_extras(&[("foot_l_down", 0.1), ("foot_r_down", 0.6)]));
    let rig = import_rig(&bytes).expect("imports");
    let clips = genex_anim::clip::import_clips(&bytes, &rig).expect("clips");
    let authored = read_event_extras(&bytes).expect("the extras read");
    assert_eq!(authored.len(), 1, "one list per animation");
    assert_eq!(authored[0].iter().map(|a| (a.name.as_str(), a.time)).collect::<Vec<_>>(), vec![("foot_l_down", 0.1), ("foot_r_down", 0.6)]);
    let mut builder = EventTable::builder(&clips);
    builder.authored(clip_id(0), &authored[0]);
    let events = builder.build().expect("the table builds");
    assert_eq!(events.notifies(clip_id(0)).len(), 2);
    // No extras is no events.
    let mut plain = Value::object();
    plain.set("other", Value::from(1.0));
    assert_eq!(read_event_extras(&walk_with_extras(plain)).expect("reads"), vec![vec![]]);
    // Hostile extras refuse `animation-asset-invalid`.
    let not_list = {
        let mut extras = Value::object();
        extras.set("genex_events", Value::from("step"));
        extras
    };
    let no_time = {
        let mut entry = Value::object();
        entry.set("name", Value::from("step"));
        let mut list = Value::array();
        list.push(entry);
        let mut extras = Value::object();
        extras.set("genex_events", list);
        extras
    };
    let name_not_text = {
        let mut entry = Value::object();
        entry.set("name", Value::from(3.0));
        entry.set("time", Value::from(0.5));
        let mut list = Value::array();
        list.push(entry);
        let mut extras = Value::object();
        extras.set("genex_events", list);
        extras
    };
    let many: Vec<(String, f64)> = (0..=genex_anim::events::MAX_NOTIFIES_PER_CLIP).map(|k| (format!("e{k}"), 0.0)).collect();
    let many: Vec<(&str, f64)> = many.iter().map(|(n, t)| (n.as_str(), *t)).collect();
    for (what, extras) in [
        ("not a list", not_list),
        ("no time", no_time),
        ("a name that is not text", name_not_text),
        ("a negative time", events_extras(&[("step", -1.0)])),
        ("a huge time", events_extras(&[("step", 1e300)])),
        ("too many", events_extras(&many)),
    ] {
        let error = read_event_extras(&walk_with_extras(extras)).expect_err(what);
        assert_eq!(error.code, AnimationErrorCode::AssetInvalid, "{what}");
    }
    assert_eq!(read_event_extras(b"not a glb").expect_err("not a GLB").code, AnimationErrorCode::AssetInvalid);
    // A time past the clip reads, and the table refuses it.
    let bytes = walk_with_extras(events_extras(&[("late", 2.0)]));
    let authored = read_event_extras(&bytes).expect("reads");
    let mut builder = EventTable::builder(&clips);
    builder.authored(clip_id(0), &authored[0]);
    assert_eq!(builder.build().expect_err("past the clip").code, AnimationErrorCode::GraphInvalid);
}
