//! Clip sampling with a cursor cache, loops and the glTF cubic-spline rule.
//!
//! The cursor is ozz-animation's sampling context (`SamplingJob::Context`, MIT), ported to AoS:
//! one key position per track, remembered between calls, so playback that moves a tick at a time
//! takes O(1) key steps per track in either direction, and a loop's wrap costs one step through
//! the end-segment check. A position that is not settled within a few steps falls back to a
//! binary search. The cursor is only a hint: every result equals what a fresh cursor gives, bit
//! for bit, so it is never simulation state and never needs saving.
//!
//! Step and Linear follow genex-render's `skin.rs` `Animation::sample` (its oracle, within 1e-6):
//! the keys around a time are the last key at or before it and the one after; Linear lerps
//! translations and scales and slerps rotations the short way. CubicSpline evaluates the glTF
//! Hermite segment as Bevy's `gltf_curves` does (MIT OR Apache-2.0): tangents scaled by the key
//! span, rotations normalized after, and the second key put in the first one's hemisphere.

use std::ops::{Add, Mul};

use glam::{Quat, Vec3};

use crate::clip::{Clip, Interpolation, Track, TrackValues};
use crate::math::{Trs, normalize_quat, same_hemisphere};

/// Key steps a cursor walks before it tries the clip's ends and then a binary search.
const WALK_LIMIT: u32 = 4;

/// What a time outside a clip means.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Wrap {
    /// Wrap into `[0, duration)`, in both directions.
    Loop,
    /// Hold the first or the last key.
    Clamp,
}

/// Where each track of a clip was last sampled, and how much work finding it took.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SampleCursor {
    /// Per track: how many of its keys are at or before the last time sampled.
    after: Vec<u32>,
    steps: u64,
    searches: u64,
}

impl SampleCursor {
    /// An empty cursor; the first sample sizes it to its clip.
    pub const fn new() -> SampleCursor {
        SampleCursor { after: Vec::new(), steps: 0, searches: 0 }
    }

    /// Key steps taken since the cursor was made (a step moves one track by one key).
    pub fn steps(&self) -> u64 {
        self.steps
    }

    /// Binary searches taken since the cursor was made (one per track that jumped).
    pub fn searches(&self) -> u64 {
        self.searches
    }
}

/// `time` as a time inside `clip`: wrapped into `[0, duration)` for [`Wrap::Loop`], clamped to
/// `[0, duration]` for [`Wrap::Clamp`]. A NaN time, any time in a clip of no duration, and an
/// infinite time in a loop give 0.
pub fn clip_time(clip: &Clip, time: f32, wrap: Wrap) -> f32 {
    wrap_time(clip.duration(), time, wrap)
}

/// `time` as a time inside a clip of `duration`, by [`clip_time`]'s rule (compacted clips share
/// it).
pub fn wrap_time(duration: f32, time: f32, wrap: Wrap) -> f32 {
    if time.is_nan() || duration <= 0.0 {
        return 0.0;
    }
    if wrap == Wrap::Clamp {
        return time.clamp(0.0, duration);
    }
    if !time.is_finite() {
        return 0.0;
    }
    // `%` is fmod, which is exact, so every destination wraps to the same bits; `+ 0.0` turns a
    // negative zero positive.
    let wrapped = time.rem_euclid(duration) + 0.0;
    if wrapped >= duration { 0.0 } else { wrapped }
}

/// Write `clip` at `time` into `pose` (one local transform per joint): only the properties its
/// tracks animate are written, so start from the rest pose or a pose to overwrite. Tracks whose
/// joint is past `pose` are skipped. Allocates only when `cursor` meets a clip with more tracks
/// than it has seen.
pub fn sample(clip: &Clip, time: f32, wrap: Wrap, cursor: &mut SampleCursor, pose: &mut [Trs]) {
    let time = clip_time(clip, time, wrap);
    let tracks = clip.tracks();
    let SampleCursor { after, steps, searches } = cursor;
    if after.len() != tracks.len() {
        after.clear();
        after.resize(tracks.len(), 0);
    }
    for (track, hint) in tracks.iter().zip(after.iter_mut()) {
        let Some(trs) = pose.get_mut(usize::from(track.joint().raw())) else { continue };
        let found = locate(track.times(), time, *hint as usize);
        *steps += u64::from(found.steps);
        *searches += u64::from(found.searched);
        *hint = found.after as u32;
        write(track, found.after, time, trs);
    }
}

/// Where a time sits in a track's keys, and what finding it cost.
struct Located {
    /// How many keys are at or before the time.
    after: usize,
    steps: u32,
    searched: bool,
}

/// `after` is right for `time`: the keys before it are at or before `time`, the rest after.
fn settled(times: &[f32], time: f32, after: usize) -> bool {
    let below = after == 0 || times[after - 1] <= time;
    let above = after == times.len() || times[after] > time;
    below && above
}

/// One key step from `after` toward `time`.
fn step_toward(times: &[f32], time: f32, after: usize) -> usize {
    if after < times.len() && times[after] <= time {
        return after + 1;
    }
    if after > 0 && times[after - 1] > time {
        return after - 1;
    }
    after
}

/// `time` in the first or the last segment (or outside the keys): where a loop's wrap lands.
fn at_an_end(times: &[f32], time: f32) -> Option<usize> {
    let last = times.len() - 1;
    if time < times[0] {
        return Some(0);
    }
    if times.len() == 1 || times[1] > time {
        return Some(1);
    }
    if times[last] <= time {
        return Some(times.len());
    }
    (times[last - 1] <= time).then_some(last)
}

/// How many of `times` are at or before `time`, starting from the cursor's `hint`: the hint
/// itself, one step, the clip's ends, a short walk, then a binary search.
fn locate(times: &[f32], time: f32, hint: usize) -> Located {
    let mut after = hint.min(times.len());
    if settled(times, time, after) {
        return Located { after, steps: 0, searched: false };
    }
    after = step_toward(times, time, after);
    if settled(times, time, after) {
        return Located { after, steps: 1, searched: false };
    }
    if let Some(end) = at_an_end(times, time) {
        return Located { after: end, steps: 2, searched: false };
    }
    let mut steps = 1;
    while steps <= WALK_LIMIT {
        after = step_toward(times, time, after);
        steps += 1;
        if settled(times, time, after) {
            return Located { after, steps, searched: false };
        }
    }
    Located { after: times.partition_point(|&key| key <= time), steps, searched: true }
}

/// The keys around `time` and how far between them it is (0 for Step, outside the keys, or
/// two keys at one time), as `skin.rs`'s `keys_at` picks them, plus the segment's length.
fn segment(track: &Track, after: usize, time: f32) -> (usize, usize, f32, f32) {
    let times = track.times();
    if after == 0 {
        return (0, 0, 0.0, 0.0);
    }
    if after >= times.len() {
        let last = times.len() - 1;
        return (last, last, 0.0, 0.0);
    }
    let (a, b) = (after - 1, after);
    let span = times[b] - times[a];
    let s = if span > 0.0 && track.interpolation() != Interpolation::Step { (time - times[a]) / span } else { 0.0 };
    (a, b, s, span)
}

fn write(track: &Track, after: usize, time: f32, trs: &mut Trs) {
    let (a, b, s, span) = segment(track, after, time);
    let cubic = track.interpolation() == Interpolation::CubicSpline;
    match track.values() {
        TrackValues::Translation(keys) => trs.translation = vector_at(keys, cubic, a, b, s, span),
        TrackValues::Scale(keys) => trs.scale = vector_at(keys, cubic, a, b, s, span),
        TrackValues::Rotation(keys) => trs.rotation = rotation_at(keys, cubic, a, b, s, span),
    }
}

fn vector_at(keys: &[Vec3], cubic: bool, a: usize, b: usize, s: f32, span: f32) -> Vec3 {
    if !cubic {
        return if s == 0.0 { keys[a] } else { keys[a].lerp(keys[b], s) };
    }
    let value = |k: usize| keys[k * 3 + 1];
    if s == 0.0 {
        return value(a);
    }
    hermite(value(a), keys[a * 3 + 2] * span, value(b), keys[b * 3] * span, s)
}

fn rotation_at(keys: &[Quat], cubic: bool, a: usize, b: usize, s: f32, span: f32) -> Quat {
    if !cubic {
        return if s == 0.0 { keys[a] } else { normalize_quat(keys[a].slerp(same_hemisphere(keys[b], keys[a]), s)) };
    }
    let value = |k: usize| keys[k * 3 + 1];
    if s == 0.0 {
        return normalize_quat(value(a));
    }
    let (start, end) = (value(a), value(b));
    // A second key written in the other hemisphere turns with its tangent, so the curve between
    // the two takes the short way.
    let (end, in_tangent) = if start.dot(end) < 0.0 { (-end, -keys[b * 3]) } else { (end, keys[b * 3]) };
    normalize_quat(hermite(start, keys[a * 3 + 2] * span, end, in_tangent * span, s))
}

/// The cubic Hermite segment from `p0` (out-tangent `m0`) to `p1` (in-tangent `m1`) at `s` in
/// `[0, 1]`, tangents already scaled by the key span (glTF 2.0, Appendix C).
fn hermite<T: Copy + Add<Output = T> + Mul<f32, Output = T>>(p0: T, m0: T, p1: T, m1: T, s: f32) -> T {
    let (s2, s3) = (s * s, s * s * s);
    p0 * (2.0 * s3 - 3.0 * s2 + 1.0) + m0 * (s3 - 2.0 * s2 + s) + p1 * (3.0 * s2 - 2.0 * s3) + m1 * (s3 - s2)
}
