//! Clip compaction: fewer keys within a hierarchical tolerance, then quantized values, so a
//! loaded clip set takes a fraction of its f32 size and still moves no joint visibly.
//!
//! The method is ozz-animation's offline `animation_optimizer` and its quantization (MIT, ported to
//! AoS glam scalar; no code copied):
//! - Each track keeps the fewest keys whose straight segments (lerp, or the sampler's short-way
//!   slerp) stay within the track's tolerance at every dropped key (a Ramer-Douglas-Peucker pass,
//!   ozz's `Decimate`). The error is a distance in model space: a translation error times the
//!   scale of the joint's parent frame; a rotation or scale error at the joint's hierarchy
//!   radius (its farthest descendant at rest, at least [`SKIN_RADIUS`], ozz's `distance`, so a
//!   leaf still holds the skin around it).
//! - A track whose keys all lie within the tolerance of its first is constant and keeps one key.
//! - Rotations are stored smallest-three (three 16-bit components and the 2-bit index of the
//!   largest, four to a byte),
//!   translations and scales as 16-bit steps over the track's own range. A key whose quantized
//!   value would move a joint more than half the tolerance keeps its f32 value.
//! - Key times are indices into one table of the clip's times: a track whose keys are a run of
//!   consecutive entries (a dense track) stores the run's start and length, any other 8-bit
//!   indices while the table has at most 256 entries (a clip of up to about 8 s at 30 Hz), 16-bit
//!   to 65,536 entries and 32-bit past that.
//!
//! The tolerance is the worst joint position error over the whole skeleton, so errors that add up
//! down a chain are checked rather than assumed: after compacting, every joint's model-space
//! position is compared with the source clip at every source key time and between them, and the
//! clip is compacted again with each track's tolerance halved (and cubic splines baked twice as
//! fine) until it holds, at most [`MAX_REFINEMENTS`] times. CubicSpline tracks are baked to
//! Linear keys at [`CUBIC_BAKE_RATE`] through the stock sampler first; Step tracks stay stepped.
//!
//! [`CompactClip::sample`] gives the same bits as [`crate::sample::sample`] over
//! [`CompactClip::to_clip`], and the same clip always compacts to the same bytes
//! ([`CompactClip::to_bytes`], [`CompactClip::digest`]) on every destination: glam runs scalar libm
//! math, and nothing here reads a clock, a thread or a hash order.

use glam::{Mat4, Quat, Vec3};

use crate::clip::{Clip, Interpolation, MAX_TRACK_KEYS, Property, Track, TrackValues};
use crate::error::AnimationError;
use crate::ids::JointId;
use crate::math::{Trs, normalize_quat, same_hemisphere};
use crate::sample::{SampleCursor, Wrap, sample, wrap_time};
use crate::skeleton::Skeleton;

/// The default worst joint position error, in metres (0.5 mm).
pub const DEFAULT_TOLERANCE: f32 = 0.0005;
/// The least radius a rotation or scale error is measured at, in metres (ozz's `distance`).
pub const SKIN_RADIUS: f32 = 0.1;
/// Keys per second a CubicSpline track is baked to before reduction (doubled per refinement).
pub const CUBIC_BAKE_RATE: f32 = 120.0;
/// Times the tolerance is halved when the checked error is over it.
pub const MAX_REFINEMENTS: u32 = 6;

/// The format version [`CompactClip::to_bytes`] writes.
const FORMAT_VERSION: u16 = 1;
/// The leading bytes of [`CompactClip::to_bytes`].
const MAGIC: [u8; 4] = *b"GXAC";
/// Quantization steps of a translation or scale component over its track's range.
const RANGE_STEPS: f32 = 65_535.0;
/// Smallest-three scale: the three smaller components of a unit quaternion lie in ±1/√2.
const ROTATION_SCALE: f32 = 32_767.0 * std::f32::consts::SQRT_2;
/// The share of a track's tolerance its quantization may take before it keeps f32 values.
const QUANTIZATION_SHARE: f32 = 0.5;
/// The most baked keys one CubicSpline segment may get.
const MAX_BAKE_STEPS: usize = 4096;

/// A clip after compaction: fewer, quantized keys on a shared time table.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactClip {
    name: String,
    duration: f32,
    times: Vec<f32>,
    tracks: Vec<CompactTrack>,
}

/// One compacted track: its keys' time indices and values.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactTrack {
    joint: JointId,
    property: Property,
    interpolation: Interpolation,
    keys: KeyIndices,
    values: KeyValues,
}

/// Indices into the clip's time table: a run of consecutive entries, or indices as narrow as the
/// table allows.
#[derive(Clone, Debug, PartialEq)]
enum KeyIndices {
    Run { first: u32, count: u32 },
    Byte(Vec<u8>),
    Narrow(Vec<u16>),
    Wide(Vec<u32>),
}

/// Stored key values.
#[derive(Clone, Debug, PartialEq)]
enum KeyValues {
    /// Translations or scales in 16-bit steps over `[min, min + extent]`.
    Ranged { min: Vec3, extent: Vec3, keys: Vec<[u16; 3]> },
    /// Rotations, smallest three: the 2-bit index of each key's dropped (largest, made positive)
    /// component, four keys to a byte, lowest bits first.
    SmallestThree { largest: Vec<u8>, keys: Vec<[i16; 3]> },
    /// Translations or scales as written.
    Vectors(Vec<Vec3>),
    /// Rotations as written.
    Rotations(Vec<Quat>),
}

impl CompactTrack {
    /// The joint it animates.
    pub fn joint(&self) -> JointId {
        self.joint
    }

    /// The property it animates.
    pub fn property(&self) -> Property {
        self.property
    }

    /// How it interpolates: Step or Linear (CubicSpline tracks are baked to Linear).
    pub fn interpolation(&self) -> Interpolation {
        self.interpolation
    }

    /// How many keys it kept.
    pub fn key_count(&self) -> usize {
        match &self.keys {
            KeyIndices::Run { count, .. } => *count as usize,
            KeyIndices::Byte(keys) => keys.len(),
            KeyIndices::Narrow(keys) => keys.len(),
            KeyIndices::Wide(keys) => keys.len(),
        }
    }

    /// The time-table index of key `k`.
    fn key_index(&self, k: usize) -> usize {
        match &self.keys {
            KeyIndices::Run { first, .. } => *first as usize + k,
            KeyIndices::Byte(keys) => usize::from(keys[k]),
            KeyIndices::Narrow(keys) => usize::from(keys[k]),
            KeyIndices::Wide(keys) => keys[k] as usize,
        }
    }

    /// Key `k` as the sampler's track would hold it, before [`Track::new`]'s normalization: a
    /// vector, or a rotation still to be normalized.
    fn stored(&self, k: usize) -> Stored {
        match &self.values {
            KeyValues::Ranged { min, extent, keys } => Stored::Vector(dequantize_range(*min, *extent, keys[k])),
            KeyValues::Vectors(keys) => Stored::Vector(keys[k]),
            KeyValues::SmallestThree { largest, keys } => Stored::Rotation(dequantize_rotation(largest_of(largest, k), keys[k])),
            KeyValues::Rotations(keys) => Stored::Rotation(keys[k]),
        }
    }

    /// Key `k` as sampled: vectors as stored, rotations normalized as [`Track::new`] does.
    fn decoded(&self, k: usize) -> Stored {
        match self.stored(k) {
            Stored::Rotation(q) => Stored::Rotation(normalize_quat(q)),
            vector => vector,
        }
    }
}

/// A stored key value.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stored {
    Vector(Vec3),
    Rotation(Quat),
}

/// Where each track of a compact clip was last sampled. A hint only: every result equals what a
/// fresh cursor gives, bit for bit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompactCursor {
    after: Vec<u32>,
}

impl CompactCursor {
    /// An empty cursor; the first sample sizes it to its clip.
    pub const fn new() -> CompactCursor {
        CompactCursor { after: Vec::new() }
    }
}

impl CompactClip {
    /// Its name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Seconds, as the source clip's.
    pub fn duration(&self) -> f32 {
        self.duration
    }

    /// Its tracks, by joint then property.
    pub fn tracks(&self) -> &[CompactTrack] {
        &self.tracks
    }

    /// The key times of track `track`, in order.
    pub fn key_times(&self, track: usize) -> Vec<f32> {
        let Some(track) = self.tracks.get(track) else { return Vec::new() };
        (0..track.key_count()).map(|k| self.times[track.key_index(k)]).collect()
    }

    /// Write the clip at `time` into `pose`, as [`crate::sample::sample`] does: only the
    /// properties its tracks animate, tracks past `pose` skipped. Allocates only when `cursor`
    /// meets a clip with more tracks than it has seen.
    pub fn sample(&self, time: f32, wrap: Wrap, cursor: &mut CompactCursor, pose: &mut [Trs]) {
        let time = wrap_time(self.duration, time, wrap);
        if cursor.after.len() != self.tracks.len() {
            cursor.after.clear();
            cursor.after.resize(self.tracks.len(), 0);
        }
        for (track, hint) in self.tracks.iter().zip(cursor.after.iter_mut()) {
            let Some(trs) = pose.get_mut(usize::from(track.joint.raw())) else { continue };
            let after = self.locate(track, time, *hint as usize);
            *hint = after as u32;
            self.write(track, after, time, trs);
        }
    }

    /// How many of `track`'s keys are at or before `time`: the hint, one step, else a search.
    fn locate(&self, track: &CompactTrack, time: f32, hint: usize) -> usize {
        let count = track.key_count();
        let at = |k: usize| self.times[track.key_index(k)];
        let settled = |after: usize| (after == 0 || at(after - 1) <= time) && (after == count || at(after) > time);
        let hint = hint.min(count);
        for after in [hint, hint + 1, hint.wrapping_sub(1)] {
            if after <= count && settled(after) {
                return after;
            }
        }
        let (mut low, mut high) = (0, count);
        while low < high {
            let middle = low + (high - low) / 2;
            if at(middle) <= time { low = middle + 1 } else { high = middle }
        }
        low
    }

    /// The sampler's segment rule (`sample.rs`'s `segment`) and its interpolation, on decoded keys.
    fn write(&self, track: &CompactTrack, after: usize, time: f32, trs: &mut Trs) {
        let count = track.key_count();
        let (a, b, s) = if after == 0 {
            (0, 0, 0.0)
        } else if after >= count {
            (count - 1, count - 1, 0.0)
        } else {
            let (a, b) = (after - 1, after);
            let (ta, tb) = (self.times[track.key_index(a)], self.times[track.key_index(b)]);
            let span = tb - ta;
            let s = if span > 0.0 && track.interpolation != Interpolation::Step { (time - ta) / span } else { 0.0 };
            (a, b, s)
        };
        match (track.decoded(a), track.decoded(b)) {
            (Stored::Vector(va), Stored::Vector(vb)) => {
                let value = if s == 0.0 { va } else { va.lerp(vb, s) };
                if track.property == Property::Scale { trs.scale = value } else { trs.translation = value }
            }
            (Stored::Rotation(qa), Stored::Rotation(qb)) => {
                trs.rotation = if s == 0.0 { qa } else { normalize_quat(qa.slerp(same_hemisphere(qb, qa), s)) };
            }
            _ => {}
        }
    }

    /// The clip with every key decoded to f32, for the stock sampler. Its duration is the last
    /// key of any track, as [`Clip::new`] computes it: the source's unless the source lasted past
    /// its last track key through skipped channels.
    pub fn to_clip(&self) -> Result<Clip, AnimationError> {
        let mut tracks = Vec::with_capacity(self.tracks.len());
        for track in &self.tracks {
            let times: Vec<f32> = (0..track.key_count()).map(|k| self.times[track.key_index(k)]).collect();
            let stored: Vec<Stored> = (0..track.key_count()).map(|k| track.stored(k)).collect();
            let values = match track.property {
                Property::Rotation => TrackValues::Rotation(stored.iter().map(|value| as_rotation(*value)).collect()),
                Property::Translation => TrackValues::Translation(stored.iter().map(|value| as_vector(*value)).collect()),
                Property::Scale => TrackValues::Scale(stored.iter().map(|value| as_vector(*value)).collect()),
            };
            tracks.push(Track::new(track.joint, track.interpolation, times, values)?);
        }
        Clip::new(self.name.clone(), tracks)
    }

    /// Its bytes, little-endian: the same clip always gives the same bytes on every destination.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.byte_size_estimate());
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&(self.name.len() as u32).to_le_bytes());
        out.extend_from_slice(self.name.as_bytes());
        out.extend_from_slice(&self.duration.to_bits().to_le_bytes());
        out.extend_from_slice(&(self.times.len() as u32).to_le_bytes());
        for time in &self.times {
            out.extend_from_slice(&time.to_bits().to_le_bytes());
        }
        out.extend_from_slice(&(self.tracks.len() as u32).to_le_bytes());
        for track in &self.tracks {
            write_track(track, &mut out);
        }
        out
    }

    /// The size of [`CompactClip::to_bytes`], what the clip takes in memory give or take its
    /// containers.
    pub fn byte_size(&self) -> usize {
        self.to_bytes().len()
    }

    /// FNV-1a 64 of [`CompactClip::to_bytes`].
    pub fn digest(&self) -> u64 {
        genex_core::digest::fnv1a64(&self.to_bytes())
    }

    fn byte_size_estimate(&self) -> usize {
        64 + self.name.len() + self.times.len() * 4 + self.tracks.iter().map(|track| 16 + track.key_count() * 10).sum::<usize>()
    }
}

fn as_rotation(value: Stored) -> Quat {
    match value {
        Stored::Rotation(q) => q,
        Stored::Vector(_) => Quat::IDENTITY,
    }
}

fn as_vector(value: Stored) -> Vec3 {
    match value {
        Stored::Vector(v) => v,
        Stored::Rotation(_) => Vec3::ZERO,
    }
}

/// One track: joint (u16), a flags byte (bits 0-1 property, bit 2 stepped, bits 3-4 index form:
/// run, 8, 16 or 32-bit, bits 5-6 value form), key count (u32), the index payload, then the values.
fn write_track(track: &CompactTrack, out: &mut Vec<u8>) {
    let property = match track.property {
        Property::Translation => 0,
        Property::Rotation => 1,
        Property::Scale => 2,
    };
    let index_form = match &track.keys {
        KeyIndices::Run { .. } => 0,
        KeyIndices::Byte(_) => 1,
        KeyIndices::Narrow(_) => 2,
        KeyIndices::Wide(_) => 3,
    };
    let value_form = match &track.values {
        KeyValues::Ranged { .. } => 0,
        KeyValues::SmallestThree { .. } => 1,
        KeyValues::Vectors(_) => 2,
        KeyValues::Rotations(_) => 3,
    };
    let stepped = u8::from(track.interpolation == Interpolation::Step);
    out.extend_from_slice(&track.joint.raw().to_le_bytes());
    out.push(property | (stepped << 2) | (index_form << 3) | (value_form << 5));
    out.extend_from_slice(&(track.key_count() as u32).to_le_bytes());
    match &track.keys {
        KeyIndices::Run { first, .. } => out.extend_from_slice(&first.to_le_bytes()),
        KeyIndices::Byte(keys) => out.extend_from_slice(keys),
        KeyIndices::Narrow(keys) => keys.iter().for_each(|k| out.extend_from_slice(&k.to_le_bytes())),
        KeyIndices::Wide(keys) => keys.iter().for_each(|k| out.extend_from_slice(&k.to_le_bytes())),
    }
    let floats = |out: &mut Vec<u8>, values: &[f32]| values.iter().for_each(|v| out.extend_from_slice(&v.to_bits().to_le_bytes()));
    match &track.values {
        KeyValues::Ranged { min, extent, keys } => {
            floats(out, &min.to_array());
            floats(out, &extent.to_array());
            keys.iter().flatten().for_each(|q| out.extend_from_slice(&q.to_le_bytes()));
        }
        KeyValues::SmallestThree { largest, keys } => {
            out.extend_from_slice(largest);
            keys.iter().flatten().for_each(|q| out.extend_from_slice(&q.to_le_bytes()));
        }
        KeyValues::Vectors(keys) => keys.iter().for_each(|v| floats(out, &v.to_array())),
        KeyValues::Rotations(keys) => keys.iter().for_each(|q| floats(out, &q.to_array())),
    }
}

/// `clip` compacted for `skeleton` at [`DEFAULT_TOLERANCE`].
pub fn compact(clip: &Clip, skeleton: &Skeleton) -> Result<CompactClip, AnimationError> {
    compact_with(clip, skeleton, DEFAULT_TOLERANCE)
}

/// `clip` compacted for `skeleton` so no joint's model-space position moves more than
/// `tolerance` metres at any source key time or between two. Refused `animation-asset-invalid`:
/// a tolerance that is not a positive finite number, or a track whose joint is past the skeleton.
pub fn compact_with(clip: &Clip, skeleton: &Skeleton, tolerance: f32) -> Result<CompactClip, AnimationError> {
    let usable = tolerance.is_finite() && tolerance > 0.0;
    if !usable {
        return Err(AnimationError::asset_invalid(format!("compaction tolerance {tolerance} is not a positive finite number")));
    }
    let joints = skeleton.joint_count();
    if let Some(track) = clip.tracks().iter().find(|track| usize::from(track.joint().raw()) >= joints) {
        return Err(AnimationError::asset_invalid(format!("a track animates joint {} of {joints}", track.joint().raw())));
    }
    let reach = Reach::of(skeleton);
    let checks = check_times(clip);
    let mut best = None;
    let mut scale = 1.0;
    for _ in 0..=MAX_REFINEMENTS {
        let candidate = compact_once(clip, &reach, tolerance * scale, CUBIC_BAKE_RATE / scale)?;
        if worst_error(clip, skeleton, &candidate, &checks) <= tolerance {
            return Ok(candidate);
        }
        best = Some(candidate);
        scale *= 0.5;
    }
    // Past the last refinement the finest result stands; the check rows say how far off it is.
    best.ok_or_else(|| AnimationError::asset_invalid("no compaction"))
}

/// Per joint: the scale of its parent frame, and the radius a rotation or scale error acts at.
struct Reach {
    frame_scale: Vec<f32>,
    radius: Vec<f32>,
}

impl Reach {
    fn of(skeleton: &Skeleton) -> Reach {
        let rest = skeleton.rest_pose();
        let count = skeleton.joint_count();
        let mut model = vec![Mat4::IDENTITY; count];
        skeleton.local_to_model(rest, &mut model);
        let frame_scale = (0..count)
            .map(|index| {
                let frame = model[index] * rest[index].matrix().inverse();
                let scale = frame.x_axis.truncate().length().max(frame.y_axis.truncate().length()).max(frame.z_axis.truncate().length());
                if scale.is_finite() && scale > 0.0 { scale } else { 1.0 }
            })
            .collect();
        let mut radius = vec![SKIN_RADIUS; count];
        for joint in skeleton.joints() {
            let position = model[usize::from(joint.raw())].w_axis.truncate();
            let mut ancestor = skeleton.parent(joint);
            while let Some(above) = ancestor {
                let index = usize::from(above.raw());
                let distance = position.distance(model[index].w_axis.truncate());
                if distance.is_finite() {
                    radius[index] = radius[index].max(distance);
                }
                ancestor = skeleton.parent(above);
            }
        }
        Reach { frame_scale, radius }
    }

    /// Metres per unit of a key error on `joint`'s `property`.
    fn weight(&self, joint: JointId, property: Property) -> f32 {
        let index = usize::from(joint.raw());
        match property {
            Property::Translation => self.frame_scale[index],
            // A rotation error is measured as the quaternion chord, which moves a point at radius
            // r by at most 2·r·chord; a scale error moves it by r·frame scale per unit.
            Property::Rotation => 2.0 * self.radius[index],
            Property::Scale => self.radius[index] * self.frame_scale[index],
        }
    }
}

/// One source track's keys as f32: its interpolation (Step or Linear), times and values.
struct Keys {
    interpolation: Interpolation,
    times: Vec<f32>,
    values: Vec<Stored>,
}

/// The source keys of `track`, a CubicSpline track baked to Linear at `bake_rate`.
fn source_keys(track: &Track, bake_rate: f32) -> Result<Keys, AnimationError> {
    if track.interpolation() != Interpolation::CubicSpline {
        let values = match track.values() {
            TrackValues::Translation(keys) | TrackValues::Scale(keys) => keys.iter().map(|v| Stored::Vector(*v)).collect(),
            TrackValues::Rotation(keys) => keys.iter().map(|q| Stored::Rotation(*q)).collect(),
        };
        return Ok(Keys { interpolation: track.interpolation(), times: track.times().to_vec(), values });
    }
    let times = bake_times(track.times(), bake_rate);
    let single = Clip::new("", vec![track.clone()])?;
    let joint = usize::from(track.joint().raw());
    let mut pose = vec![Trs::IDENTITY; joint + 1];
    let mut cursor = SampleCursor::new();
    let mut values = Vec::with_capacity(times.len());
    for &time in &times {
        sample(&single, time, Wrap::Clamp, &mut cursor, &mut pose);
        values.push(match track.property() {
            Property::Translation => Stored::Vector(pose[joint].translation),
            Property::Scale => Stored::Vector(pose[joint].scale),
            Property::Rotation => Stored::Rotation(pose[joint].rotation),
        });
    }
    Ok(Keys { interpolation: Interpolation::Linear, times, values })
}

/// The key times of a CubicSpline track baked at `rate` keys per second: every source key time
/// and evenly spaced times between.
fn bake_times(times: &[f32], rate: f32) -> Vec<f32> {
    // A long track bakes coarser, so no track bakes to more than about MAX_TRACK_KEYS keys plus
    // one per source segment.
    let span = times.last().copied().unwrap_or(0.0) - times.first().copied().unwrap_or(0.0);
    let rate = if span * rate > MAX_TRACK_KEYS as f32 { MAX_TRACK_KEYS as f32 / span } else { rate };
    let mut baked = Vec::with_capacity(times.len());
    for pair in times.windows(2) {
        let span = pair[1] - pair[0];
        let steps = ((span * rate).ceil() as usize).clamp(1, MAX_BAKE_STEPS);
        baked.extend((0..steps).map(|step| pair[0] + span * (step as f32 / steps as f32)));
    }
    baked.extend(times.last());
    baked
}

/// The error, in key units, of `value` against the interpolation of `a` and `b` at `s`.
fn interpolation_error(a: Stored, b: Stored, s: f32, value: Stored) -> f32 {
    match (a, b, value) {
        (Stored::Vector(a), Stored::Vector(b), Stored::Vector(v)) => {
            let at = if s == 0.0 { a } else { a.lerp(b, s) };
            at.distance(v)
        }
        (Stored::Rotation(a), Stored::Rotation(b), Stored::Rotation(v)) => {
            let at = if s == 0.0 { a } else { normalize_quat(a.slerp(same_hemisphere(b, a), s)) };
            chord(at, normalize_quat(v))
        }
        _ => f32::INFINITY,
    }
}

/// The distance between two unit quaternions taken in one hemisphere.
fn chord(a: Quat, b: Quat) -> f32 {
    let b = same_hemisphere(b, a);
    Vec3::new(a.x - b.x, a.y - b.y, a.z - b.z).extend(a.w - b.w).length()
}

/// The keys of `keys` to keep so every dropped key is within `tolerance` (key units).
fn reduce(keys: &Keys, tolerance: f32) -> Vec<usize> {
    let count = keys.times.len();
    let first = keys.values[0];
    if keys.values.iter().all(|value| interpolation_error(first, first, 0.0, *value) <= tolerance) {
        // Constant: one key, at the last time, so the track still ends where the source did.
        return vec![count - 1];
    }
    if keys.interpolation == Interpolation::Step {
        return reduce_steps(keys, tolerance);
    }
    let mut keep = vec![false; count];
    keep[0] = true;
    keep[count - 1] = true;
    let mut spans = vec![(0, count - 1)];
    while let Some((a, b)) = spans.pop() {
        let span = keys.times[b] - keys.times[a];
        let mut worst = (0.0, 0);
        for k in a + 1..b {
            let s = if span > 0.0 { (keys.times[k] - keys.times[a]) / span } else { 0.0 };
            let error = interpolation_error(keys.values[a], keys.values[b], s, keys.values[k]);
            if error > worst.0 {
                worst = (error, k);
            }
        }
        if worst.0 > tolerance {
            keep[worst.1] = true;
            spans.push((worst.1, b));
            spans.push((a, worst.1));
        }
    }
    (0..count).filter(|&k| keep[k]).collect()
}

/// Step keys to keep: the first, each that changes the held value past `tolerance`, the last.
fn reduce_steps(keys: &Keys, tolerance: f32) -> Vec<usize> {
    let mut kept = vec![0];
    for k in 1..keys.times.len() {
        let held = keys.values[*kept.last().unwrap_or(&0)];
        let changes = interpolation_error(held, held, 0.0, keys.values[k]) > tolerance;
        if changes || k == keys.times.len() - 1 {
            kept.push(k);
        }
    }
    kept
}

/// One compaction pass at a per-track `tolerance` (metres) and cubic `bake_rate`.
fn compact_once(clip: &Clip, reach: &Reach, tolerance: f32, bake_rate: f32) -> Result<CompactClip, AnimationError> {
    let mut kept = Vec::with_capacity(clip.tracks().len());
    for track in clip.tracks() {
        let keys = source_keys(track, bake_rate)?;
        let track_tolerance = tolerance / reach.weight(track.joint(), track.property());
        let indices = reduce(&keys, track_tolerance);
        kept.push((track, keys, indices, track_tolerance));
    }
    let mut times: Vec<f32> = kept.iter().flat_map(|(_, keys, indices, _)| indices.iter().map(|&k| keys.times[k])).collect();
    times.sort_by(f32::total_cmp);
    times.dedup_by(|a, b| a.to_bits() == b.to_bits());
    let mut tracks = Vec::with_capacity(kept.len());
    for (track, keys, indices, track_tolerance) in kept {
        let positions: Vec<u32> = indices.iter().map(|&k| times.partition_point(|&t| t.total_cmp(&keys.times[k]).is_lt()) as u32).collect();
        // A run (4 bytes) beats per-key indices from five keys on.
        let run = positions.len() > 4 && positions.windows(2).all(|pair| pair[1] == pair[0] + 1);
        let index_keys = if run {
            KeyIndices::Run { first: positions[0], count: positions.len() as u32 }
        } else if times.len() <= usize::from(u8::MAX) + 1 {
            KeyIndices::Byte(positions.iter().map(|&p| p as u8).collect())
        } else if times.len() <= usize::from(u16::MAX) + 1 {
            KeyIndices::Narrow(positions.iter().map(|&p| p as u16).collect())
        } else {
            KeyIndices::Wide(positions)
        };
        let values: Vec<Stored> = indices.iter().map(|&k| keys.values[k]).collect();
        let quantized = quantize(&values, track_tolerance * QUANTIZATION_SHARE);
        tracks.push(CompactTrack { joint: track.joint(), property: track.property(), interpolation: keys.interpolation, keys: index_keys, values: quantized });
    }
    Ok(CompactClip { name: clip.name().to_owned(), duration: clip.duration(), times, tracks })
}

/// `values` quantized, or kept as f32 when a quantized key would be off by more than `limit`
/// (key units). One key is always kept as f32.
fn quantize(values: &[Stored], limit: f32) -> KeyValues {
    let vectors: Vec<Vec3> = values.iter().filter_map(|value| if let Stored::Vector(v) = value { Some(*v) } else { None }).collect();
    if vectors.len() == values.len() {
        if vectors.len() > 1
            && let Some(ranged) = quantize_vectors(&vectors, limit)
        {
            return ranged;
        }
        return KeyValues::Vectors(vectors);
    }
    let rotations: Vec<Quat> = values.iter().map(|value| as_rotation(*value)).collect();
    if rotations.len() > 1 {
        let packed: Vec<(u8, [i16; 3])> = rotations.iter().map(|q| quantize_rotation(*q)).collect();
        let close = packed.iter().zip(&rotations).all(|((largest, keys), q)| chord(normalize_quat(dequantize_rotation(*largest, *keys)), normalize_quat(*q)) <= limit);
        if close {
            let mut largest = vec![0u8; packed.len().div_ceil(4)];
            for (k, (index, _)) in packed.iter().enumerate() {
                largest[k / 4] |= index << ((k % 4) * 2);
            }
            let keys = packed.into_iter().map(|(_, keys)| keys).collect();
            return KeyValues::SmallestThree { largest, keys };
        }
    }
    KeyValues::Rotations(rotations)
}

fn quantize_vectors(vectors: &[Vec3], limit: f32) -> Option<KeyValues> {
    let min = vectors.iter().copied().fold(Vec3::INFINITY, Vec3::min);
    let max = vectors.iter().copied().fold(Vec3::NEG_INFINITY, Vec3::max);
    let extent = max - min;
    if !extent.is_finite() {
        return None;
    }
    let keys: Vec<[u16; 3]> = vectors.iter().map(|v| quantize_range(min, extent, *v)).collect();
    let close = keys.iter().zip(vectors).all(|(q, v)| dequantize_range(min, extent, *q).distance(*v) <= limit);
    close.then_some(KeyValues::Ranged { min, extent, keys })
}

fn quantize_range(min: Vec3, extent: Vec3, value: Vec3) -> [u16; 3] {
    let step = |v: f32, m: f32, e: f32| if e > 0.0 { ((v - m) / e * RANGE_STEPS).round().clamp(0.0, RANGE_STEPS) as u16 } else { 0 };
    [step(value.x, min.x, extent.x), step(value.y, min.y, extent.y), step(value.z, min.z, extent.z)]
}

fn dequantize_range(min: Vec3, extent: Vec3, key: [u16; 3]) -> Vec3 {
    let value = |m: f32, e: f32, q: u16| m + e * (f32::from(q) / RANGE_STEPS);
    Vec3::new(value(min.x, extent.x, key[0]), value(min.y, extent.y, key[1]), value(min.z, extent.z, key[2]))
}

/// Smallest three: drop the largest component (made positive by negating the whole quaternion,
/// the same rotation) and keep the other three in 16 bits each.
fn quantize_rotation(q: Quat) -> (u8, [i16; 3]) {
    let q = normalize_quat(q).to_array();
    let mut largest = 0;
    for index in 1..4 {
        if q[index].abs() > q[largest].abs() {
            largest = index;
        }
    }
    let sign = if q[largest] < 0.0 { -1.0 } else { 1.0 };
    let mut keys = [0i16; 3];
    let mut slot = 0;
    for (index, component) in q.iter().enumerate() {
        if index != largest {
            keys[slot] = (component * sign * ROTATION_SCALE).round().clamp(-32_767.0, 32_767.0) as i16;
            slot += 1;
        }
    }
    (largest as u8, keys)
}

/// Key `k`'s largest-component index from the packed bytes.
fn largest_of(packed: &[u8], k: usize) -> u8 {
    (packed[k / 4] >> ((k % 4) * 2)) & 0b11
}

/// The quaternion of a smallest-three key, not yet normalized.
fn dequantize_rotation(largest: u8, keys: [i16; 3]) -> Quat {
    let small = keys.map(|k| f32::from(k) / ROTATION_SCALE);
    let rest = 1.0 - (small[0] * small[0] + small[1] * small[1] + small[2] * small[2]);
    let big = rest.max(0.0).sqrt();
    let mut out = [0.0; 4];
    let mut slot = 0;
    for (index, component) in out.iter_mut().enumerate() {
        if index == usize::from(largest) {
            *component = big;
        } else {
            *component = small[slot];
            slot += 1;
        }
    }
    Quat::from_array(out)
}

/// The times the error check samples: every source key time and the midpoint of each gap.
fn check_times(clip: &Clip) -> Vec<f32> {
    let mut times: Vec<f32> = clip.tracks().iter().flat_map(|track| track.times().iter().copied()).collect();
    times.push(clip.duration());
    times.sort_by(f32::total_cmp);
    times.dedup_by(|a, b| a.to_bits() == b.to_bits());
    let middles: Vec<f32> = times.windows(2).map(|pair| pair[0] + (pair[1] - pair[0]) * 0.5).collect();
    times.extend(middles);
    times.sort_by(f32::total_cmp);
    times
}

/// The worst model-space joint position difference between `clip` and `compacted` at `times`.
fn worst_error(clip: &Clip, skeleton: &Skeleton, compacted: &CompactClip, times: &[f32]) -> f32 {
    let rest = skeleton.rest_pose();
    let count = skeleton.joint_count();
    let (mut want, mut got) = (rest.to_vec(), rest.to_vec());
    let (mut want_model, mut got_model) = (vec![Mat4::IDENTITY; count], vec![Mat4::IDENTITY; count]);
    let (mut cursor, mut compact_cursor) = (SampleCursor::new(), CompactCursor::new());
    let mut worst: f32 = 0.0;
    for &time in times {
        want.copy_from_slice(rest);
        got.copy_from_slice(rest);
        sample(clip, time, Wrap::Clamp, &mut cursor, &mut want);
        compacted.sample(time, Wrap::Clamp, &mut compact_cursor, &mut got);
        skeleton.local_to_model(&want, &mut want_model);
        skeleton.local_to_model(&got, &mut got_model);
        for (a, b) in want_model.iter().zip(&got_model) {
            let distance = a.w_axis.truncate().distance(b.w_axis.truncate());
            // A non-finite pose (a hostile clip) never passes the check.
            worst = if distance.is_nan() { f32::INFINITY } else { worst.max(distance) };
        }
    }
    worst
}
