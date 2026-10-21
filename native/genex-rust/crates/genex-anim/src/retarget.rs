//! Basic humanoid retargeting between rigs that share the alias table (AN-12): a clip made for
//! one humanoid rig (a Quaternius UAL walk) baked onto another (a Meshy, Tripo or Mixamo
//! character) at load.
//!
//! Both rigs are read through their [`HumanoidMap`]s. Every profile bone but the toes must be on
//! both, or the retarget is refused `animation-retarget-unmapped`, naming the bone and the rig
//! that lacks it. Then each target joint is driven one of three ways:
//!
//! - **A humanoid bone** takes the source bone's model-space turn away from its rest, applied to
//!   the target bone's rest normalized onto the source's silhouette: `G_t = G_s × inv(R_s) × A ×
//!   R_t`, where `R` are the rest model-space rotations and `A` turns the target bone's rest
//!   direction (toward its humanoid child) onto the source's. This is Godot's BoneMap rest
//!   normalization with "Fix Silhouette" (MIT, Godot Engine contributors; the rule only), and it
//!   equals `target_rest × inv(source_rest) × source_local` in that normalized frame: each bone
//!   of the target points where the source's points, whatever its local axes and whether it rests
//!   in a T- or an A-pose. A bone with no humanoid child (head, hands, toes) keeps its humanoid
//!   parent's `A`. The local rotation is `inv(parent's model rotation) × G_t`, so joints between
//!   two humanoid bones (twists, extra spine joints) keep their rest.
//! - **The hips** also take the source hips' model-space travel from rest, scaled by the leg
//!   ratio (target thigh plus shin over the source's), added to the target's rest hips: a longer
//!   legged character bobs and steps proportionally higher and keeps its feet on the floor.
//! - **A joint both rigs name alike** that is not a humanoid bone (fingers, a `root`, props) takes
//!   the source's local turn from rest, `target_rest × inv(source_rest) × source_local`, and its
//!   local travel from rest scaled by the leg ratio. Every other joint keeps its rest.
//!
//! The clip is sampled at each of its key times (plus a 60 Hz grid when a track is a cubic
//! spline, whose curve between keys a linear key cannot keep) and written as linear keys. It is
//! plain glam math in a fixed order, so a retarget gives the same bits on every destination, and
//! retargeting a rig onto itself gives back its clip within float rounding.

use glam::{Mat4, Quat, Vec3};

use crate::clip::{Clip, Interpolation, MAX_TRACK_KEYS, Property, Track, TrackValues};
use crate::error::AnimationError;
use crate::humanoid::{HUMANOID_BONES, HumanoidBone, HumanoidMap};
use crate::ids::JointId;
use crate::math::{Trs, normalize_quat, same_hemisphere};
use crate::sample::{SampleCursor, Wrap, sample};
use crate::skeleton::Skeleton;

/// The rate a cubic-spline clip is resampled at, keys per second (beside its own keys).
pub const RETARGET_CUBIC_RATE: f32 = 60.0;

/// The profile bones a retarget does without: a rig with no toes still retargets.
pub const OPTIONAL_BONES: [HumanoidBone; 2] = [HumanoidBone::LeftToes, HumanoidBone::RightToes];

/// A direction shorter than this (metres) has no direction.
const TINY_LENGTH: f32 = 1e-6;

/// The humanoid bone a bone points toward at rest.
const fn child_of(bone: HumanoidBone) -> Option<HumanoidBone> {
    use HumanoidBone::*;
    match bone {
        Hips => Some(Spine),
        Spine => Some(Chest),
        Chest => Some(UpperChest),
        UpperChest => Some(Neck),
        Neck => Some(Head),
        LeftShoulder => Some(LeftUpperArm),
        LeftUpperArm => Some(LeftLowerArm),
        LeftLowerArm => Some(LeftHand),
        RightShoulder => Some(RightUpperArm),
        RightUpperArm => Some(RightLowerArm),
        RightLowerArm => Some(RightHand),
        LeftUpperLeg => Some(LeftLowerLeg),
        LeftLowerLeg => Some(LeftFoot),
        LeftFoot => Some(LeftToes),
        RightUpperLeg => Some(RightLowerLeg),
        RightLowerLeg => Some(RightFoot),
        RightFoot => Some(RightToes),
        Head | LeftHand | RightHand | LeftToes | RightToes => None,
    }
}

/// The humanoid bone a bone hangs from in the profile.
const fn parent_of(bone: HumanoidBone) -> Option<HumanoidBone> {
    use HumanoidBone::*;
    match bone {
        Hips => None,
        Spine | LeftUpperLeg | RightUpperLeg => Some(Hips),
        Chest => Some(Spine),
        UpperChest => Some(Chest),
        Neck | LeftShoulder | RightShoulder => Some(UpperChest),
        Head => Some(Neck),
        LeftUpperArm => Some(LeftShoulder),
        LeftLowerArm => Some(LeftUpperArm),
        LeftHand => Some(LeftLowerArm),
        RightUpperArm => Some(RightShoulder),
        RightLowerArm => Some(RightUpperArm),
        RightHand => Some(RightLowerArm),
        LeftLowerLeg => Some(LeftUpperLeg),
        LeftFoot => Some(LeftLowerLeg),
        LeftToes => Some(LeftFoot),
        RightLowerLeg => Some(RightUpperLeg),
        RightFoot => Some(RightLowerLeg),
        RightToes => Some(RightFoot),
    }
}

/// How one target joint is driven.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Drive {
    /// It keeps its rest.
    Rest,
    /// A humanoid bone: model rotation `G_s(source) × unrest × pre`; the hips also travel.
    Humanoid { source: usize, unrest: Quat, pre: Quat, hips: bool },
    /// A joint both rigs name alike: local rotation `turn × source_local`, local travel scaled.
    Named { source: usize, turn: Quat, source_rest: Vec3 },
}

/// A retarget from one humanoid rig onto another, prepared once for any number of clips.
#[derive(Clone, Debug)]
pub struct Retargeter<'a> {
    source: &'a Skeleton,
    target: &'a Skeleton,
    drives: Vec<Drive>,
    /// Per target joint: a root's non-joint ancestors' frame at rest (identity otherwise).
    frames: Vec<Mat4>,
    source_hips: usize,
    source_hips_rest: Vec3,
    target_hips_rest: Vec3,
    ratio: f32,
}

impl<'a> Retargeter<'a> {
    /// A retarget of `source`'s clips onto `target`. Refused `animation-retarget-unmapped` when
    /// either rig's humanoid map lacks a profile bone (the toes excepted), naming the first such
    /// bone and the rig.
    pub fn new(source: &'a Skeleton, target: &'a Skeleton) -> Result<Retargeter<'a>, AnimationError> {
        let (source_map, target_map) = (HumanoidMap::of(source), HumanoidMap::of(target));
        unmapped(&source_map, "source")?;
        unmapped(&target_map, "target")?;
        let (source_rest, target_rest) = (rest_model(source), rest_model(target));
        let joint_of = |map: &HumanoidMap, bone: HumanoidBone| map.joint(bone).map(|joint| usize::from(joint.raw()));
        let aligns = aligns(&source_map, &target_map, &source_rest, &target_rest);
        let mut drives = vec![Drive::Rest; target.joint_count()];
        for bone in HumanoidBone::ALL {
            let (Some(s), Some(t)) = (joint_of(&source_map, bone), joint_of(&target_map, bone)) else { continue };
            let unrest = rotation(&source_rest[s]).inverse();
            let pre = aligns[bone.index()] * rotation(&target_rest[t]);
            drives[t] = Drive::Humanoid { source: s, unrest, pre, hips: bone == HumanoidBone::Hips };
        }
        let humanoid_sources: Vec<usize> = HumanoidBone::ALL.iter().filter_map(|bone| joint_of(&source_map, *bone)).collect();
        for joint in target.joints() {
            let index = usize::from(joint.raw());
            if drives[index] != Drive::Rest {
                continue;
            }
            let Some(s) = source.find(target.name(joint)).map(|j| usize::from(j.raw())) else { continue };
            if humanoid_sources.contains(&s) {
                continue;
            }
            let (from, onto) = (source.rest_pose()[s], target.rest_pose()[index]);
            drives[index] = Drive::Named { source: s, turn: normalize_quat(onto.rotation * from.rotation.inverse()), source_rest: from.translation };
        }
        let frames = target
            .joints()
            .map(|joint| {
                let index = usize::from(joint.raw());
                if target.parent(joint).is_some() { Mat4::IDENTITY } else { target_rest[index] * target.rest_pose()[index].matrix().inverse() }
            })
            .collect();
        let hips = |map: &HumanoidMap| joint_of(map, HumanoidBone::Hips).unwrap_or(0);
        let (source_hips, target_hips) = (hips(&source_map), hips(&target_map));
        let ratio = leg_length(&target_map, &target_rest) / leg_length(&source_map, &source_rest);
        Ok(Retargeter {
            source,
            target,
            drives,
            frames,
            source_hips,
            source_hips_rest: source_rest[source_hips].w_axis.truncate(),
            target_hips_rest: target_rest[target_hips].w_axis.truncate(),
            ratio: if ratio.is_finite() && ratio > 0.0 { ratio } else { 1.0 },
        })
    }

    /// The target's legs over the source's (thigh plus shin, both sides averaged): how far the
    /// hips' travel and the alike-named joints' travel are scaled.
    pub fn leg_ratio(&self) -> f32 {
        self.ratio
    }

    /// `clip` (a clip of the source rig) baked onto the target rig: the same name and duration,
    /// a rotation track per driven joint, a translation track for the hips and for each
    /// alike-named joint the clip moves. Refused `animation-asset-invalid` only when the keys it
    /// would need pass [`MAX_TRACK_KEYS`].
    pub fn clip(&self, clip: &Clip) -> Result<Clip, AnimationError> {
        let times = key_times(clip)?;
        let animated = |joint: usize, property: Property| clip.tracks().iter().any(|track| usize::from(track.joint().raw()) == joint && track.property() == property);
        let mut rotations: Vec<Option<Vec<Quat>>> = self.drives.iter().map(|drive| (*drive != Drive::Rest).then(|| Vec::with_capacity(times.len()))).collect();
        let mut translations: Vec<Option<Vec<Vec3>>> = self
            .drives
            .iter()
            .map(|drive| {
                let moves = match drive {
                    Drive::Humanoid { hips, .. } => *hips,
                    Drive::Named { source, .. } => animated(*source, Property::Translation),
                    Drive::Rest => false,
                };
                moves.then(|| Vec::with_capacity(times.len()))
            })
            .collect();
        let mut pose = Pose::new(self.source, self.target);
        for time in &times {
            pose.sample_source(self.source, clip, *time);
            self.drive(&mut pose);
            for (index, local) in pose.target_local.iter().enumerate() {
                if let Some(keys) = &mut rotations[index] {
                    let rotation = keys.last().map_or(local.rotation, |last| same_hemisphere(local.rotation, *last));
                    keys.push(rotation);
                }
                if let Some(keys) = &mut translations[index] {
                    keys.push(local.translation);
                }
            }
        }
        let mut tracks = Vec::new();
        for joint in self.target.joints() {
            let index = usize::from(joint.raw());
            if let Some(keys) = rotations[index].take() {
                tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Rotation(keys))?);
            }
            if let Some(keys) = translations[index].take() {
                tracks.push(Track::new(joint, Interpolation::Linear, times.clone(), TrackValues::Translation(keys))?);
            }
        }
        Clip::from_parts(clip.name().to_owned(), clip.duration(), tracks, Vec::new())
    }

    /// The target's local pose (and model matrices) for the source pose `pose` holds.
    fn drive(&self, pose: &mut Pose) {
        let rest = self.target.rest_pose();
        for joint in self.target.joints() {
            let index = usize::from(joint.raw());
            let parent = self.target.parent(joint).map_or(self.frames[index], |p| pose.target_model[usize::from(p.raw())]);
            let mut local = rest[index];
            match self.drives[index] {
                Drive::Rest => {}
                Drive::Humanoid { source, unrest, pre, hips } => {
                    let model = rotation(&pose.source_model[source]) * unrest * pre;
                    local.rotation = normalize_quat(rotation(&parent).inverse() * model);
                    if hips {
                        let travel = pose.source_model[self.source_hips].w_axis.truncate() - self.source_hips_rest;
                        let at = parent.inverse().transform_point3(self.target_hips_rest + travel * self.ratio);
                        if at.is_finite() {
                            local.translation = at;
                        }
                    }
                }
                Drive::Named { source, turn, source_rest } => {
                    let from = pose.source_local[source];
                    local.rotation = normalize_quat(turn * from.rotation);
                    local.translation = rest[index].translation + (from.translation - source_rest) * self.ratio;
                }
            }
            pose.target_local[index] = local;
            pose.target_model[index] = parent * local.matrix();
        }
    }
}

/// The scratch one clip's retarget reuses.
struct Pose {
    source_local: Vec<Trs>,
    source_model: Vec<Mat4>,
    target_local: Vec<Trs>,
    target_model: Vec<Mat4>,
    cursor: SampleCursor,
}

impl Pose {
    fn new(source: &Skeleton, target: &Skeleton) -> Pose {
        Pose {
            source_local: source.rest_pose().to_vec(),
            source_model: vec![Mat4::IDENTITY; source.joint_count()],
            target_local: target.rest_pose().to_vec(),
            target_model: vec![Mat4::IDENTITY; target.joint_count()],
            cursor: SampleCursor::new(),
        }
    }

    /// The source rig in `clip` at `time` (clamped: a key time is never wrapped to 0).
    fn sample_source(&mut self, source: &Skeleton, clip: &Clip, time: f32) {
        self.source_local.copy_from_slice(source.rest_pose());
        sample(clip, time, Wrap::Clamp, &mut self.cursor, &mut self.source_local);
        source.local_to_model(&self.source_local, &mut self.source_model);
    }
}

/// Refuse a map that lacks a required bone, naming it and `which` rig.
fn unmapped(map: &HumanoidMap, which: &str) -> Result<(), AnimationError> {
    match map.missing().find(|bone| !OPTIONAL_BONES.contains(bone)) {
        Some(bone) => Err(AnimationError::retarget_unmapped(format!("the {which} rig has no {} bone (read with its {} names)", bone.name(), map.profile().wire()))),
        None => Ok(()),
    }
}

/// Model matrices of a skeleton's rest pose.
fn rest_model(skeleton: &Skeleton) -> Vec<Mat4> {
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    skeleton.local_to_model(skeleton.rest_pose(), &mut model);
    model
}

/// A model matrix's rotation.
fn rotation(matrix: &Mat4) -> Quat {
    normalize_quat(matrix.to_scale_rotation_translation().1)
}

/// Per bone in profile order, the turn that puts the target bone's rest direction on the
/// source's: toward the humanoid child both rigs have, else the humanoid parent's turn.
fn aligns(source: &HumanoidMap, target: &HumanoidMap, source_rest: &[Mat4], target_rest: &[Mat4]) -> [Quat; HUMANOID_BONES] {
    let mut out = [Quat::IDENTITY; HUMANOID_BONES];
    let at = |map: &HumanoidMap, model: &[Mat4], bone: HumanoidBone| map.joint(bone).map(|joint| model[usize::from(joint.raw())].w_axis.truncate());
    for bone in HumanoidBone::ALL {
        let inherited = parent_of(bone).map_or(Quat::IDENTITY, |parent| out[parent.index()]);
        let direction = |map: &HumanoidMap, model: &[Mat4]| -> Option<Vec3> {
            let span = at(map, model, child_of(bone)?)? - at(map, model, bone)?;
            (span.length() > TINY_LENGTH).then(|| span.normalize())
        };
        out[bone.index()] = match (direction(source, source_rest), direction(target, target_rest)) {
            (Some(from), Some(onto)) => normalize_quat(Quat::from_rotation_arc(onto, from)),
            _ => inherited,
        };
    }
    out
}

/// Thigh plus shin at rest, both sides averaged, metres.
fn leg_length(map: &HumanoidMap, rest: &[Mat4]) -> f32 {
    let at = |bone: HumanoidBone| map.joint(bone).map_or(Vec3::ZERO, |joint: JointId| rest[usize::from(joint.raw())].w_axis.truncate());
    let side = |upper: HumanoidBone, lower: HumanoidBone, foot: HumanoidBone| at(upper).distance(at(lower)) + at(lower).distance(at(foot));
    let left = side(HumanoidBone::LeftUpperLeg, HumanoidBone::LeftLowerLeg, HumanoidBone::LeftFoot);
    let right = side(HumanoidBone::RightUpperLeg, HumanoidBone::RightLowerLeg, HumanoidBone::RightFoot);
    0.5 * (left + right)
}

/// Every key time of `clip`'s tracks, ascending and each once, with a [`RETARGET_CUBIC_RATE`]
/// grid over the duration when a track is a cubic spline; `[0]` for a clip with no keys.
fn key_times(clip: &Clip) -> Result<Vec<f32>, AnimationError> {
    let mut times: Vec<f32> = clip.tracks().iter().flat_map(|track| track.times().iter().copied()).collect();
    if clip.tracks().iter().any(|track| track.interpolation() == Interpolation::CubicSpline) {
        let steps = (clip.duration() * RETARGET_CUBIC_RATE).ceil();
        if !(steps.is_finite() && steps < MAX_TRACK_KEYS as f32) {
            return Err(AnimationError::asset_invalid(format!("a {} s cubic clip needs more than {MAX_TRACK_KEYS} keys", clip.duration())));
        }
        let steps = steps as usize;
        times.extend((0..=steps).map(|k| clip.duration() * k as f32 / steps.max(1) as f32));
    }
    times.sort_by(f32::total_cmp);
    times.dedup();
    if times.is_empty() {
        times.push(0.0);
    }
    if times.len() > MAX_TRACK_KEYS {
        return Err(AnimationError::asset_invalid(format!("{} key times, more than {MAX_TRACK_KEYS}", times.len())));
    }
    Ok(times)
}

/// `clips` of `source` baked onto `target` (see [`Retargeter`]). Refused as
/// [`Retargeter::new`] and [`Retargeter::clip`] refuse.
pub fn retarget_clips(source: &Skeleton, clips: &[Clip], target: &Skeleton) -> Result<Vec<Clip>, AnimationError> {
    let retargeter = Retargeter::new(source, target)?;
    clips.iter().map(|clip| retargeter.clip(clip)).collect()
}
