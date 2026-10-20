//! Clips: per-joint tracks with Step, Linear and CubicSpline keys, read from a GLB's animations
//! onto a rig's skeleton or built in code.
//!
//! A track animates one property (translation, rotation or scale) of one skeleton joint. Its keys
//! are checked once here, so sampling never meets a bad one: at least one key, times finite,
//! non-negative and never decreasing, values finite, one value per key (three for CubicSpline:
//! in-tangent, value, out-tangent, as glTF stores them) and no zero-length rotation key. Step and
//! Linear rotation keys are stored normalized; cubic-spline keys stay as written, because their
//! tangents are relative to them.
//!
//! A glTF channel the joint-only skeleton cannot follow is skipped and named in
//! [`Clip::ignored_channels`] with its reason: a node that is not a joint or between two
//! ([`IgnoredChannelReason::OutsideSkeleton`]), a non-joint ancestor of a root joint, such as a
//! Mixamo "Armature", whose rest transform the skeleton folds into the root's fixed frame
//! ([`IgnoredChannelReason::FoldedAncestor`]), and morph-target weights
//! ([`IgnoredChannelReason::MorphWeights`]).

use glam::{Quat, Vec3};
use gltf::accessor::{DataType, Dimensions};
use gltf::animation::util::ReadOutputs;

use crate::error::AnimationError;
use crate::ids::JointId;
use crate::import::{Rig, check_accessor, open};
use crate::math::normalize_quat;

/// Keys one track may hold (over an hour at 240 Hz).
pub const MAX_TRACK_KEYS: usize = 1 << 20;

/// Values a CubicSpline key carries: in-tangent, value, out-tangent.
const CUBIC_VALUES_PER_KEY: usize = 3;

/// How a track interpolates between its keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Interpolation {
    /// Hold each key until the next.
    Step,
    /// Lerp translations and scales, slerp rotations the short way.
    Linear,
    /// glTF's cubic Hermite spline: tangents scaled by the key span, rotations normalized.
    CubicSpline,
}

/// The property a track animates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Property {
    /// The joint's local translation.
    Translation,
    /// The joint's local rotation.
    Rotation,
    /// The joint's local scale.
    Scale,
}

/// A track's key values; CubicSpline tracks hold three per key (in-tangent, value, out-tangent).
#[derive(Clone, Debug, PartialEq)]
pub enum TrackValues {
    /// Translation keys.
    Translation(Vec<Vec3>),
    /// Rotation keys.
    Rotation(Vec<Quat>),
    /// Scale keys.
    Scale(Vec<Vec3>),
}

impl TrackValues {
    /// The property these values animate.
    pub fn property(&self) -> Property {
        match self {
            TrackValues::Translation(_) => Property::Translation,
            TrackValues::Rotation(_) => Property::Rotation,
            TrackValues::Scale(_) => Property::Scale,
        }
    }

    /// How many values there are.
    pub fn len(&self) -> usize {
        match self {
            TrackValues::Translation(values) | TrackValues::Scale(values) => values.len(),
            TrackValues::Rotation(values) => values.len(),
        }
    }

    /// There are no values.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The index of the first non-finite value.
    fn first_non_finite(&self) -> Option<usize> {
        match self {
            TrackValues::Translation(values) | TrackValues::Scale(values) => values.iter().position(|v| !v.is_finite()),
            TrackValues::Rotation(values) => values.iter().position(|q| !q.is_finite()),
        }
    }
}

/// One animated property of one joint.
#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    joint: JointId,
    interpolation: Interpolation,
    times: Vec<f32>,
    values: TrackValues,
}

impl Track {
    /// A track of `joint`, checked. Refused `animation-asset-invalid`: no keys or more than
    /// [`MAX_TRACK_KEYS`], a time that is not finite, negative or earlier than the one before, a
    /// value count other than one per key (three for CubicSpline), a non-finite value, or a
    /// rotation key of zero length.
    pub fn new(joint: JointId, interpolation: Interpolation, times: Vec<f32>, values: TrackValues) -> Result<Track, AnimationError> {
        check_times(&times)?;
        let per_key = if interpolation == Interpolation::CubicSpline { CUBIC_VALUES_PER_KEY } else { 1 };
        if values.len() != times.len() * per_key {
            return Err(AnimationError::asset_invalid(format!("{} values for {} keys, {per_key} per key", values.len(), times.len())));
        }
        if let Some(index) = values.first_non_finite() {
            return Err(AnimationError::asset_invalid(format!("value {index} is not finite")));
        }
        let values = match values {
            TrackValues::Rotation(keys) => TrackValues::Rotation(rotation_keys(keys, interpolation)?),
            other => other,
        };
        Ok(Track { joint, interpolation, times, values })
    }

    /// The joint it animates.
    pub fn joint(&self) -> JointId {
        self.joint
    }

    /// How it interpolates.
    pub fn interpolation(&self) -> Interpolation {
        self.interpolation
    }

    /// The property it animates.
    pub fn property(&self) -> Property {
        self.values.property()
    }

    /// Key times in seconds, never decreasing.
    pub fn times(&self) -> &[f32] {
        &self.times
    }

    /// Key values (three per key for CubicSpline).
    pub fn values(&self) -> &TrackValues {
        &self.values
    }

    /// Its last key time.
    pub fn end(&self) -> f32 {
        self.times.last().copied().unwrap_or(0.0)
    }
}

/// Times a track may have: 1 to [`MAX_TRACK_KEYS`], finite, non-negative and never decreasing.
fn check_times(times: &[f32]) -> Result<(), AnimationError> {
    if times.is_empty() || times.len() > MAX_TRACK_KEYS {
        return Err(AnimationError::asset_invalid(format!("{} keys, between 1 and {MAX_TRACK_KEYS}", times.len())));
    }
    if let Some(index) = times.iter().position(|t| !t.is_finite() || *t < 0.0) {
        return Err(AnimationError::asset_invalid(format!("key time {index} is not a finite non-negative number")));
    }
    if let Some(index) = times.windows(2).position(|pair| pair[1] < pair[0]) {
        return Err(AnimationError::asset_invalid(format!("key time {} is earlier than the one before", index + 1)));
    }
    Ok(())
}

/// Rotation keys with no zero-length value; Step and Linear keys normalized.
fn rotation_keys(keys: Vec<Quat>, interpolation: Interpolation) -> Result<Vec<Quat>, AnimationError> {
    let cubic = interpolation == Interpolation::CubicSpline;
    let is_value = |index: usize| !cubic || index % CUBIC_VALUES_PER_KEY == 1;
    let zero = keys.iter().enumerate().position(|(index, q)| is_value(index) && q.length_squared() <= f32::MIN_POSITIVE);
    if let Some(index) = zero {
        return Err(AnimationError::asset_invalid(format!("rotation key {index} has zero length")));
    }
    if cubic {
        return Ok(keys);
    }
    Ok(keys.into_iter().map(normalize_quat).collect())
}

/// Why a glTF channel is not one of a clip's tracks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum IgnoredChannelReason {
    /// The node is neither a joint nor a node between two joints (the skinned mesh node, a prop).
    OutsideSkeleton,
    /// The node is a non-joint ancestor of a root joint; the skeleton holds it at rest.
    FoldedAncestor,
    /// Morph-target weights, which no skeleton joint carries.
    MorphWeights,
}

/// A glTF channel a clip skips.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct IgnoredChannel {
    /// The file node it targets.
    pub node: usize,
    /// Why it is skipped.
    pub reason: IgnoredChannelReason,
}

/// A clip: tracks sorted by joint, then property, at most one per pair.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    name: String,
    duration: f32,
    tracks: Vec<Track>,
    ignored: Vec<IgnoredChannel>,
}

impl Clip {
    /// A clip of `tracks`, lasting until the last key of any. Refused `animation-asset-invalid`
    /// when two tracks animate the same property of the same joint.
    pub fn new(name: impl Into<String>, tracks: Vec<Track>) -> Result<Clip, AnimationError> {
        let duration = tracks.iter().map(Track::end).fold(0.0, f32::max);
        Clip::from_parts(name.into(), duration, tracks, Vec::new())
    }

    /// A clip from its parts as an importer or the root-motion bake has them: the duration and
    /// skipped channels are kept as given.
    pub(crate) fn from_parts(name: String, duration: f32, mut tracks: Vec<Track>, ignored: Vec<IgnoredChannel>) -> Result<Clip, AnimationError> {
        tracks.sort_by_key(|track| (track.joint, track.property()));
        if let Some(pair) = tracks.windows(2).find(|pair| (pair[0].joint, pair[0].property()) == (pair[1].joint, pair[1].property())) {
            let (joint, property) = (pair[0].joint.raw(), pair[0].property());
            return Err(AnimationError::asset_invalid(format!("joint {joint}'s {property:?} is animated twice")));
        }
        Ok(Clip { name, duration, tracks, ignored })
    }

    /// Its name in the file (empty when it has none).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Seconds from 0 to the last key of any channel, skipped ones included.
    pub fn duration(&self) -> f32 {
        self.duration
    }

    /// Its tracks, by joint then property.
    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    /// The file's channels this clip skips, in file order.
    pub fn ignored_channels(&self) -> &[IgnoredChannel] {
        &self.ignored
    }
}

/// The clips of a GLB, in file order, on `rig` (imported from the same bytes). Refused
/// `animation-asset-invalid`: anything [`crate::import::import_rig`] refuses in the container, a
/// key-time accessor that is not 1 to [`MAX_TRACK_KEYS`] floats inside its view, a value accessor
/// that is not one float VEC3 (VEC4 for rotations) per key (three for CubicSpline) inside its
/// view, anything [`Track::new`] refuses, or one property of one joint animated twice. A rig
/// from other bytes gives wrong tracks, never a panic.
pub fn import_clips(bytes: &[u8], rig: &Rig) -> Result<Vec<Clip>, AnimationError> {
    let gltf = open(bytes)?;
    check_targets(gltf.document.as_json())?;
    let folded = folded_ancestors(&gltf, rig);
    gltf.animations().map(|animation| read_clip(&gltf, &animation, rig, &folded)).collect()
}

/// Every channel's target, which `gltf`'s validation leaves unchecked and its accessors unwrap: a
/// node inside the node list and a known property.
fn check_targets(root: &gltf::json::Root) -> Result<(), AnimationError> {
    let nodes = root.nodes.len();
    for (index, animation) in root.animations.iter().enumerate() {
        for target in animation.channels.iter().map(|channel| &channel.target) {
            if target.node.value() >= nodes {
                return Err(AnimationError::asset_invalid(format!("animation {index} targets node {} of {nodes}", target.node.value())));
            }
            if matches!(target.path, gltf::json::validation::Checked::Invalid) {
                return Err(AnimationError::asset_invalid(format!("animation {index} targets an unknown property")));
            }
        }
    }
    Ok(())
}

/// A channel as read: a track, or a skipped channel. Either way its last key time.
enum Channel {
    Track(Track),
    Ignored(IgnoredChannel, f32),
}

fn read_clip(gltf: &gltf::Gltf, animation: &gltf::Animation<'_>, rig: &Rig, folded: &[bool]) -> Result<Clip, AnimationError> {
    let name = animation.name().unwrap_or_default();
    let detail = |error: AnimationError| AnimationError::asset_invalid(format!("clip {name:?}: {}", error.detail));
    let mut tracks = Vec::new();
    let mut ignored = Vec::new();
    let mut duration: f32 = 0.0;
    for channel in animation.channels() {
        match read_channel(gltf, &channel, rig, folded).map_err(detail)? {
            Channel::Track(track) => {
                duration = duration.max(track.end());
                tracks.push(track);
            }
            Channel::Ignored(skipped, end) => {
                duration = duration.max(end);
                ignored.push(skipped);
            }
        }
    }
    Clip::from_parts(name.to_owned(), duration, tracks, ignored).map_err(detail)
}

fn read_channel(gltf: &gltf::Gltf, channel: &gltf::animation::Channel<'_>, rig: &Rig, folded: &[bool]) -> Result<Channel, AnimationError> {
    let blob = gltf.blob.as_deref();
    let blob_len = blob.map_or(0, <[u8]>::len);
    let sampler = channel.sampler();
    check_accessor(&sampler.input(), blob_len, (DataType::F32, Dimensions::Scalar), 1..=MAX_TRACK_KEYS)?;
    let reader = channel.reader(|_| blob);
    let times: Vec<f32> = reader.read_inputs().into_iter().flatten().collect();
    check_times(&times)?;
    let end = times.last().copied().unwrap_or(0.0);
    let node = channel.target().node().index();
    let property = channel.target().property();
    if property == gltf::animation::Property::MorphTargetWeights {
        return Ok(Channel::Ignored(IgnoredChannel { node, reason: IgnoredChannelReason::MorphWeights }, end));
    }
    let Some(joint) = rig.joint_of_node(node) else {
        let reason = if folded.get(node).copied().unwrap_or(false) { IgnoredChannelReason::FoldedAncestor } else { IgnoredChannelReason::OutsideSkeleton };
        return Ok(Channel::Ignored(IgnoredChannel { node, reason }, end));
    };
    let interpolation = match sampler.interpolation() {
        gltf::animation::Interpolation::Step => Interpolation::Step,
        gltf::animation::Interpolation::Linear => Interpolation::Linear,
        gltf::animation::Interpolation::CubicSpline => Interpolation::CubicSpline,
    };
    let per_key = if interpolation == Interpolation::CubicSpline { CUBIC_VALUES_PER_KEY } else { 1 };
    let count = times.len() * per_key;
    let dimensions = if property == gltf::animation::Property::Rotation { Dimensions::Vec4 } else { Dimensions::Vec3 };
    check_accessor(&sampler.output(), blob_len, (DataType::F32, dimensions), count..=count)?;
    let values = match reader.read_outputs() {
        Some(ReadOutputs::Translations(keys)) => TrackValues::Translation(keys.map(Vec3::from).collect()),
        Some(ReadOutputs::Scales(keys)) => TrackValues::Scale(keys.map(Vec3::from).collect()),
        Some(ReadOutputs::Rotations(keys)) => TrackValues::Rotation(keys.into_f32().map(Quat::from_array).collect()),
        Some(ReadOutputs::MorphTargetWeights(_)) | None => return Err(AnimationError::asset_invalid(format!("channel on node {node} has no readable values"))),
    };
    Track::new(joint, interpolation, times, values).map(Channel::Track)
}

/// Which file nodes are non-joint ancestors of a root joint. The walk up is capped at the node
/// count, so a cycle (which [`crate::import::import_rig`] refuses) cannot hang a foreign rig.
fn folded_ancestors(gltf: &gltf::Gltf, rig: &Rig) -> Vec<bool> {
    let nodes = gltf.nodes().len();
    let mut parents = vec![usize::MAX; nodes];
    for node in gltf.nodes() {
        for child in node.children() {
            if let Some(slot) = parents.get_mut(child.index()) {
                *slot = node.index();
            }
        }
    }
    let mut folded = vec![false; nodes];
    let skeleton = rig.skeleton();
    for joint in skeleton.joints().filter(|&joint| skeleton.parent(joint).is_none()) {
        let mut at = parents.get(rig.node_of_joint(joint)).copied().unwrap_or(usize::MAX);
        for _ in 0..nodes {
            let Some(slot) = folded.get_mut(at) else { break };
            *slot = true;
            at = parents[at];
        }
    }
    folded
}
