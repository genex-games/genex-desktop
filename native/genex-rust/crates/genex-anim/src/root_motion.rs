//! Root motion: the character's own travel taken out of a clip once at load, and the delta a
//! playing clip moves the character by each tick, blended like the pose.
//!
//! The rules follow ozz-animation 0.16's `MotionExtractor` and `MotionBlendingJob` (MIT) and Godot's
//! root-motion accumulation in `AnimationMixer` (MIT); the rules only, no code was copied.
//!
//! - **Extraction** ([`extract`]) samples the root joint in model space (the character's space: the
//!   skeleton's root frames, such as a Mixamo armature at scale 0.01, included) on a 60 Hz grid
//!   joined with the root's own key times. The motion at a time is a frame `C(t)`: the root's
//!   position on the chosen axes (the ground plane by default) and its yaw about +Y (the twist of
//!   its rotation, unwrapped so a turn never jumps by a full circle). Baking rewrites the root's
//!   translation and rotation keys as `C(t)⁻¹ × root(t)`, so the clip plays over the character's
//!   origin facing forward, and `C(t) × baked(t)` is the original root.
//! - **In place.** A clip whose root goes nowhere (net travel under [`IN_PLACE_SPEED`] and never
//!   further than [`IN_PLACE_REACH`], no turn past [`IN_PLACE_TURN`]) is flagged and left as it is:
//!   its motion is exactly zero, its sway stays in the pose, and a game moves such a character by
//!   velocity instead.
//! - **Deltas** ([`MotionTrack::delta`]) read the [`Span`] a tick played, the same span events read:
//!   on a loop that crosses its end the delta is the rest of this cycle, any whole cycles, then the
//!   start of the next, never `C(to) - C(from)` (the classic wrap bug's large backward jump). A
//!   delta is in character space at the tick's start: forward is +Z whatever way the clip faced.
//! - **Blending** ([`blend`]) is the weighted mean of the deltas, weights normalized.
//!
//! Everything is f32 arithmetic and glam's libm (`to_angle`, `from_rotation_y`) in a fixed order, so
//! every destination extracts and plays the same bits.

use glam::{Mat4, Quat, Vec2, Vec3};

use crate::clip::{Clip, Interpolation, MAX_TRACK_KEYS, Property, Track, TrackValues};
use crate::error::AnimationError;
use crate::events::Span;
use crate::ids::JointId;
use crate::math::{Trs, normalize_quat, same_hemisphere};
use crate::sample::{SampleCursor, Wrap, sample};
use crate::skeleton::Skeleton;

/// Samples per second the motion grid has at least.
pub const MOTION_RATE: f32 = 60.0;
/// Net travel under this many metres per second of clip counts as in place.
pub const IN_PLACE_SPEED: f32 = 0.05;
/// A root that never strays further than this many metres from its start counts as in place.
pub const IN_PLACE_REACH: f32 = 0.1;
/// A root that never turns further than this many radians from its start counts as in place.
pub const IN_PLACE_TURN: f32 = 0.35;

/// How far a character moves in one tick, in its own space at the tick's start.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RootMotion {
    /// Metres in character space: +Z forward, +Y up.
    pub translation: Vec3,
    /// Radians turned about +Y.
    pub yaw: f32,
}

impl RootMotion {
    /// No motion.
    pub const ZERO: RootMotion = RootMotion { translation: Vec3::ZERO, yaw: 0.0 };

    /// The translation in the world, for a character facing `facing`.
    pub fn in_world(&self, facing: Quat) -> Vec3 {
        facing * self.translation
    }

    /// This motion followed by `next` (which starts where this one ends, turned by its yaw).
    pub fn then(self, next: RootMotion) -> RootMotion {
        RootMotion { translation: self.translation + Quat::from_rotation_y(self.yaw) * next.translation, yaw: self.yaw + next.yaw }
    }

    /// The same motion played backwards.
    pub fn reversed(self) -> RootMotion {
        RootMotion { translation: Quat::from_rotation_y(-self.yaw) * -self.translation, yaw: -self.yaw }
    }
}

/// Which parts of the root's motion are extracted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MotionAxes {
    /// Travel along X.
    pub x: bool,
    /// Travel along Y (up): off by default, so a walk's bob stays in the pose.
    pub y: bool,
    /// Travel along Z.
    pub z: bool,
    /// Turning about +Y.
    pub yaw: bool,
}

impl MotionAxes {
    /// The ground plane and yaw: X, Z and turning.
    pub const GROUND: MotionAxes = MotionAxes { x: true, y: false, z: true, yaw: true };

    /// `position` with the axes that are not extracted at 0.
    fn mask(self, position: Vec3) -> Vec3 {
        Vec3::new(if self.x { position.x } else { 0.0 }, if self.y { position.y } else { 0.0 }, if self.z { position.z } else { 0.0 })
    }
}

impl Default for MotionAxes {
    fn default() -> MotionAxes {
        MotionAxes::GROUND
    }
}

/// How [`extract`] treats a clip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MotionSettings {
    /// The joint whose motion is the character's; `None` is the skeleton's first root.
    pub root: Option<JointId>,
    /// What is extracted.
    pub axes: MotionAxes,
    /// Rewrite the root's keys so the clip plays in place (the default).
    pub bake: bool,
}

impl MotionSettings {
    /// The first root, the ground plane and yaw, baked.
    pub const DEFAULT: MotionSettings = MotionSettings { root: None, axes: MotionAxes::GROUND, bake: true };
}

impl Default for MotionSettings {
    fn default() -> MotionSettings {
        MotionSettings::DEFAULT
    }
}

/// A clip's root motion: the motion frame's position and yaw at each sample time.
#[derive(Clone, Debug, PartialEq)]
pub struct MotionTrack {
    times: Vec<f32>,
    positions: Vec<Vec3>,
    yaws: Vec<f32>,
    duration: f32,
    in_place: bool,
}

impl MotionTrack {
    /// The motion of a clip of `duration` seconds that goes nowhere.
    pub fn in_place_for(duration: f32) -> MotionTrack {
        let duration = if duration.is_finite() { duration.max(0.0) } else { 0.0 };
        MotionTrack { times: vec![0.0, duration], positions: vec![Vec3::ZERO; 2], yaws: vec![0.0; 2], duration, in_place: true }
    }

    /// The clip's length in seconds.
    pub fn duration(&self) -> f32 {
        self.duration
    }

    /// The clip goes nowhere: every delta is zero.
    pub fn in_place(&self) -> bool {
        self.in_place
    }

    /// Sample times, ascending, from 0 to the duration.
    pub fn times(&self) -> &[f32] {
        &self.times
    }

    /// The motion frame's position at each sample, in character space.
    pub fn positions(&self) -> &[Vec3] {
        &self.positions
    }

    /// The motion frame's yaw at each sample, unwrapped, in radians.
    pub fn yaws(&self) -> &[f32] {
        &self.yaws
    }

    /// The motion frame at `time` (clamped to the clip; NaN is the start): its position and yaw,
    /// linear between samples.
    pub fn at(&self, time: f32) -> (Vec3, f32) {
        let time = if time.is_nan() { 0.0 } else { time.clamp(0.0, self.duration) };
        let after = self.times.partition_point(|&key| key <= time);
        if after == 0 {
            return (self.positions[0], self.yaws[0]);
        }
        if after >= self.times.len() {
            let last = self.times.len() - 1;
            return (self.positions[last], self.yaws[last]);
        }
        let (a, b) = (after - 1, after);
        let span = self.times[b] - self.times[a];
        let s = if span > 0.0 { (time - self.times[a]) / span } else { 0.0 };
        (self.positions[a].lerp(self.positions[b], s), self.yaws[a] + (self.yaws[b] - self.yaws[a]) * s)
    }

    /// The motion from clip time `from` to `to` (either direction, no wrap), in character space at
    /// `from`.
    pub fn between(&self, from: f32, to: f32) -> RootMotion {
        if self.in_place {
            return RootMotion::ZERO;
        }
        let (start, start_yaw) = self.at(from);
        let (end, end_yaw) = self.at(to);
        RootMotion { translation: Quat::from_rotation_y(-start_yaw) * (end - start), yaw: end_yaw - start_yaw }
    }

    /// One whole cycle's motion, start to end.
    pub fn cycle(&self) -> RootMotion {
        self.between(0.0, self.duration)
    }

    /// The motion over the clip time `span` played; see the module docs for the wrap rule.
    pub fn delta(&self, span: &Span) -> RootMotion {
        if self.in_place {
            return RootMotion::ZERO;
        }
        let (from, to, laps) = (span.from(), span.to(), span.laps());
        if laps == 0 {
            return self.between(from, to);
        }
        let end = self.duration;
        let (first, whole, last) = if span.backwards() {
            (self.between(from, 0.0), self.cycle().reversed(), self.between(end, to))
        } else {
            (self.between(from, end), self.cycle(), self.between(0.0, to))
        };
        (1..laps).fold(first, |motion, _| motion.then(whole)).then(last)
    }

    /// The motion frame's net travel over the clip, in model space.
    pub fn displacement(&self) -> Vec3 {
        self.positions[self.positions.len() - 1] - self.positions[0]
    }
}

/// A clip with its root motion taken out.
#[derive(Clone, Debug, PartialEq)]
pub struct Extracted {
    /// The clip: baked in place, or as it was (in place already, or not baked).
    pub clip: Clip,
    /// Its root motion.
    pub motion: MotionTrack,
}

/// `clip`'s root motion on `skeleton`, and the clip baked in place; see the module docs. Refused
/// `animation-asset-invalid`: a root joint the skeleton does not have, or a clip so long its
/// motion grid would pass [`MAX_TRACK_KEYS`] samples.
pub fn extract(skeleton: &Skeleton, clip: &Clip, settings: &MotionSettings) -> Result<Extracted, AnimationError> {
    let root = settings.root.unwrap_or(JointId(0));
    let index = usize::from(root.raw());
    if index >= skeleton.joint_count() {
        return Err(AnimationError::asset_invalid(format!("root motion joint {index} is not one of the skeleton's {} joints", skeleton.joint_count())));
    }
    let duration = clip.duration();
    if !(duration.is_finite() && duration > 0.0) {
        return Ok(Extracted { clip: clip.clone(), motion: MotionTrack::in_place_for(duration) });
    }
    let times = sample_times(clip, root, duration)?;
    let frames = root_frames(skeleton, clip, index, &times);
    let motion = motion_of(&frames, &times, duration, settings.axes);
    if motion.in_place || !settings.bake {
        return Ok(Extracted { clip: clip.clone(), motion });
    }
    let baked = bake(clip, root, &frames, &motion)?;
    Ok(Extracted { clip: baked, motion })
}

/// The motion grid: at least [`MOTION_RATE`] samples a second, the root's own key times, 0 and
/// the duration, ascending with no repeats.
fn sample_times(clip: &Clip, root: JointId, duration: f32) -> Result<Vec<f32>, AnimationError> {
    let steps = (duration * MOTION_RATE).ceil();
    if !(steps.is_finite() && (steps as usize) < MAX_TRACK_KEYS) {
        return Err(AnimationError::asset_invalid(format!("a {duration} s clip needs more than {MAX_TRACK_KEYS} root motion samples")));
    }
    let steps = (steps as usize).max(1);
    let mut times: Vec<f32> = (0..=steps).map(|k| duration * (k as f32 / steps as f32)).collect();
    let moves_root = |track: &&Track| track.joint() == root && track.property() != Property::Scale;
    for track in clip.tracks().iter().filter(moves_root) {
        times.extend(track.times().iter().copied().filter(|time| *time <= duration));
    }
    times.sort_by(f32::total_cmp);
    times.dedup();
    if times.len() > MAX_TRACK_KEYS {
        return Err(AnimationError::asset_invalid(format!("{} root motion samples, more than {MAX_TRACK_KEYS}", times.len())));
    }
    Ok(times)
}

/// The root joint's sampled local transform and model matrix at one time.
struct RootFrame {
    local: Trs,
    model: Mat4,
}

fn root_frames(skeleton: &Skeleton, clip: &Clip, index: usize, times: &[f32]) -> Vec<RootFrame> {
    let rest = skeleton.rest_pose();
    let mut pose = rest.to_vec();
    let mut model = vec![Mat4::IDENTITY; index + 1];
    let mut cursor = SampleCursor::new();
    let mut frames = Vec::with_capacity(times.len());
    for &time in times {
        pose.copy_from_slice(rest);
        sample(clip, time, Wrap::Clamp, &mut cursor, &mut pose);
        // Parents come first, so the joints up to the root are all the root's model needs.
        skeleton.local_to_model(&pose[..=index], &mut model);
        frames.push(RootFrame { local: pose[index], model: model[index] });
    }
    frames
}

/// The twist of `rotation` about +Y, in `(-π, π]`.
fn yaw_of(rotation: Quat) -> f32 {
    let rotation = same_hemisphere(normalize_quat(rotation), Quat::IDENTITY);
    2.0 * Vec2::new(rotation.w, rotation.y).to_angle()
}

/// `angle` wrapped into `[-π, π)`.
fn wrap_angle(angle: f32) -> f32 {
    use core::f32::consts::{PI, TAU};
    (angle + PI).rem_euclid(TAU) - PI
}

fn motion_of(frames: &[RootFrame], times: &[f32], duration: f32, axes: MotionAxes) -> MotionTrack {
    let mut positions = Vec::with_capacity(frames.len());
    let mut yaws: Vec<f32> = Vec::with_capacity(frames.len());
    let mut previous_raw = 0.0;
    for frame in frames {
        let (_, rotation, translation) = frame.model.to_scale_rotation_translation();
        positions.push(axes.mask(translation));
        let raw = if axes.yaw { yaw_of(rotation) } else { 0.0 };
        let yaw = match yaws.last() {
            Some(last) => last + wrap_angle(raw - previous_raw),
            None => raw,
        };
        yaws.push(yaw);
        previous_raw = raw;
    }
    let reach = positions.iter().map(|p| (*p - positions[0]).length()).fold(0.0, f32::max);
    let turn = yaws.iter().map(|y| (y - yaws[0]).abs()).fold(0.0, f32::max);
    let net = (positions[positions.len() - 1] - positions[0]).length() / duration;
    let in_place = net < IN_PLACE_SPEED && reach < IN_PLACE_REACH && turn < IN_PLACE_TURN;
    if in_place {
        return MotionTrack::in_place_for(duration);
    }
    MotionTrack { times: times.to_vec(), positions, yaws, duration, in_place: false }
}

/// `clip` with the root's translation and rotation rewritten as `C(t)⁻¹ × root(t)` on the motion
/// grid (linear keys); its other tracks are kept as they were.
fn bake(clip: &Clip, root: JointId, frames: &[RootFrame], motion: &MotionTrack) -> Result<Clip, AnimationError> {
    let mut translations = Vec::with_capacity(frames.len());
    let mut rotations: Vec<Quat> = Vec::with_capacity(frames.len());
    for ((frame, position), yaw) in frames.iter().zip(&motion.positions).zip(&motion.yaws) {
        let motion_frame = Mat4::from_translation(*position) * Mat4::from_quat(Quat::from_rotation_y(*yaw));
        // The root's parent frame is `model × local⁻¹`, so the new local is
        // `local × model⁻¹ × C⁻¹ × model`.
        let local = frame.local.matrix() * frame.model.inverse() * motion_frame.inverse() * frame.model;
        let (_, rotation, translation) = local.to_scale_rotation_translation();
        let reference = rotations.last().copied().unwrap_or(frame.local.rotation);
        translations.push(translation);
        rotations.push(same_hemisphere(normalize_quat(rotation), reference));
    }
    let moved = |track: &&Track| track.joint() == root && track.property() != Property::Scale;
    let mut tracks: Vec<Track> = clip.tracks().iter().filter(|track| !moved(track)).cloned().collect();
    tracks.push(Track::new(root, Interpolation::Linear, motion.times.clone(), TrackValues::Translation(translations))?);
    tracks.push(Track::new(root, Interpolation::Linear, motion.times.clone(), TrackValues::Rotation(rotations))?);
    Clip::from_parts(clip.name().to_owned(), clip.duration(), tracks, clip.ignored_channels().to_vec())
}

/// The weighted mean of `motions`, weights normalized; NaN, negative and infinite weights count as
/// 0, no usable weight is no motion, and one usable motion comes back bit for bit.
pub fn blend(motions: &[(RootMotion, f32)]) -> RootMotion {
    let usable = |weight: f32| if weight.is_finite() && weight > 0.0 { weight } else { 0.0 };
    let mut total = 0.0;
    let mut translation = Vec3::ZERO;
    let mut yaw = 0.0;
    let mut contributors = 0;
    let mut first = RootMotion::ZERO;
    for (motion, weight) in motions {
        let weight = usable(*weight);
        if weight <= 0.0 {
            continue;
        }
        if contributors == 0 {
            first = *motion;
        }
        contributors += 1;
        total += weight;
        translation += motion.translation * weight;
        yaw += motion.yaw * weight;
    }
    match contributors {
        0 => RootMotion::ZERO,
        1 => first,
        _ => RootMotion { translation: translation / total, yaw: yaw / total },
    }
}
