//! Pose blending, ported from ozz-animation's `BlendingJob` (MIT) to AoS glam scalar.
//!
//! - [`Blender::blend`] is the normalized blend: each layer adds its pose times its weight (times
//!   the joint's mask weight), rotations summed in one hemisphere and normalized, translations and
//!   scales divided by the total weight. Where the total is under the threshold, the rest pose
//!   fills the remainder, so weights summing to 0 give the rest pose and never a NaN. A joint one
//!   layer alone drives is that layer's transform, bit for bit.
//! - [`apply_additive`] adds a delta pose (built by [`additive_delta`]) as `base × delta`: the
//!   delta rotates in the base's local frame. This is ozz 0.15's order; earlier releases
//!   multiplied `delta × base`, which turns an additive yaw on a pitched base about the wrong axis.
//! - [`apply_override`] moves joints toward a layer by its weight (a Unity-style override layer).
//!
//! Every step is a pass over caller slices with no allocation once a [`Blender`] is warm.
//! A joint whose effective weight is 0 is never touched, so a masked layer leaves the joints
//! outside its mask bit-identical.

use glam::{Quat, Vec3, Vec4};

use crate::mask::{JointMask, clamp_unit};
use crate::math::{Trs, normalize_quat, same_hemisphere};

/// The total weight under which [`Blender::blend`] fills in the rest pose (ozz's default).
pub const BLEND_THRESHOLD: f32 = 0.1;

/// One input of a blend: a pose (one local transform per joint), its weight and an optional mask.
#[derive(Clone, Copy, Debug)]
pub struct Layer<'a> {
    /// The pose, parents first; joints past its end take no part.
    pub pose: &'a [Trs],
    /// The layer's weight; a negative or non-finite weight counts as 0.
    pub weight: f32,
    /// Per-joint weights multiplied into `weight`; `None` is every joint at 1.
    pub mask: Option<&'a JointMask>,
}

impl<'a> Layer<'a> {
    /// `pose` at `weight` over every joint.
    pub fn new(pose: &'a [Trs], weight: f32) -> Layer<'a> {
        Layer { pose, weight, mask: None }
    }

    /// The same layer limited to `mask`.
    pub fn masked(self, mask: &'a JointMask) -> Layer<'a> {
        Layer { mask: Some(mask), ..self }
    }

    /// The weight this layer has at joint `index`: 0 when the layer is off there.
    fn weight_at(&self, index: usize) -> f32 {
        let weight = if self.weight.is_finite() { self.weight.max(0.0) } else { 0.0 };
        match self.mask {
            Some(mask) => weight * mask.weight_at(index),
            None => weight,
        }
    }
}

/// One joint's running sums.
#[derive(Clone, Copy, Debug)]
struct Accumulator {
    translation: Vec3,
    rotation: Vec4,
    scale: Vec3,
    weight: f32,
    contributors: u32,
    first: Trs,
}

impl Accumulator {
    const EMPTY: Accumulator = Accumulator {
        translation: Vec3::ZERO,
        rotation: Vec4::ZERO,
        scale: Vec3::ZERO,
        weight: 0.0,
        contributors: 0,
        first: Trs::IDENTITY,
    };

    fn add(&mut self, transform: &Trs, weight: f32) {
        if self.contributors == 0 {
            self.first = *transform;
        }
        let rotation = Vec4::from(transform.rotation);
        let rotation = if rotation.dot(self.rotation) < 0.0 { -rotation } else { rotation };
        self.translation += transform.translation * weight;
        self.rotation += rotation * weight;
        self.scale += transform.scale * weight;
        self.weight += weight;
        self.contributors += 1;
    }

    fn finish(&self) -> Trs {
        if self.contributors == 1 {
            return self.first;
        }
        let inverse = 1.0 / self.weight;
        Trs {
            translation: self.translation * inverse,
            rotation: normalize_quat(Quat::from_vec4(self.rotation)),
            scale: self.scale * inverse,
        }
    }
}

/// The normalized blend, with its per-joint scratch kept between calls.
#[derive(Clone, Debug)]
pub struct Blender {
    threshold: f32,
    joints: Vec<Accumulator>,
}

impl Default for Blender {
    fn default() -> Blender {
        Blender::new()
    }
}

impl Blender {
    /// A blender with the default threshold, [`BLEND_THRESHOLD`].
    pub fn new() -> Blender {
        Blender::with_threshold(BLEND_THRESHOLD)
    }

    /// A blender whose rest pose fills in under `threshold` (clamped to a small positive number,
    /// so the blend never divides by zero).
    pub fn with_threshold(threshold: f32) -> Blender {
        let threshold = if threshold.is_finite() { threshold.max(f32::EPSILON) } else { BLEND_THRESHOLD };
        Blender { threshold, joints: Vec::new() }
    }

    /// The threshold under which the rest pose fills in.
    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    /// `layers` blended by weight into `out`, one transform per joint of `rest`. Only the first
    /// `min(rest.len(), out.len())` joints are written.
    pub fn blend(&mut self, rest: &[Trs], layers: &[Layer<'_>], out: &mut [Trs]) {
        let count = rest.len().min(out.len());
        self.joints.clear();
        self.joints.resize(count, Accumulator::EMPTY);
        for layer in layers {
            for (index, (joint, transform)) in self.joints.iter_mut().zip(layer.pose).enumerate() {
                let weight = layer.weight_at(index);
                if weight > 0.0 {
                    joint.add(transform, weight);
                }
            }
        }
        for ((joint, rest), out) in self.joints.iter_mut().zip(rest).zip(out.iter_mut()) {
            if joint.weight < self.threshold {
                joint.add(rest, self.threshold - joint.weight);
            }
            *out = joint.finish();
        }
    }
}

/// `layer` added onto `pose` in place: per joint at weight `w` (clamped to `[0, 1]`), the
/// rotation becomes `base × nlerp(identity, delta, w)`, translations add `delta × w` and scales
/// multiply by `lerp(1, delta, w)`.
pub fn apply_additive(pose: &mut [Trs], layer: &Layer<'_>) {
    for (index, (base, delta)) in pose.iter_mut().zip(layer.pose).enumerate() {
        let weight = clamp_unit(layer.weight_at(index));
        if weight <= 0.0 {
            continue;
        }
        let rotation = same_hemisphere(delta.rotation, Quat::IDENTITY);
        let partial = Quat::from_xyzw(rotation.x * weight, rotation.y * weight, rotation.z * weight, (rotation.w - 1.0) * weight + 1.0);
        base.rotation = normalize_quat(base.rotation * normalize_quat(partial));
        base.translation += delta.translation * weight;
        base.scale *= Vec3::ONE + (delta.scale - Vec3::ONE) * weight;
    }
}

/// The delta that [`apply_additive`] at weight 1 turns `reference` into `pose` with:
/// `inverse(reference) × pose` for rotations, the difference of translations and the ratio of
/// scales (a zero reference scale gives a delta scale of 1).
pub fn additive_delta(pose: &[Trs], reference: &[Trs], out: &mut [Trs]) {
    for ((out, pose), reference) in out.iter_mut().zip(pose).zip(reference) {
        let scale = Vec3::select(reference.scale.cmpeq(Vec3::ZERO), Vec3::ONE, pose.scale / reference.scale);
        *out = Trs {
            translation: pose.translation - reference.translation,
            rotation: normalize_quat(reference.rotation.inverse() * pose.rotation),
            scale,
        };
    }
}

/// `pose` moved toward `layer` in place: per joint at weight `w` (clamped to `[0, 1]`) the
/// translation and scale lerp and the rotation nlerps in the base's hemisphere; at weight 1 the
/// joint becomes the layer's transform.
pub fn apply_override(pose: &mut [Trs], layer: &Layer<'_>) {
    for (index, (base, over)) in pose.iter_mut().zip(layer.pose).enumerate() {
        let weight = clamp_unit(layer.weight_at(index));
        if weight <= 0.0 {
            continue;
        }
        if weight >= 1.0 {
            *base = *over;
            continue;
        }
        let rotation = same_hemisphere(over.rotation, base.rotation);
        let blended = Vec4::from(base.rotation).lerp(Vec4::from(rotation), weight);
        base.rotation = normalize_quat(Quat::from_vec4(blended));
        base.translation = base.translation.lerp(over.translation, weight);
        base.scale = base.scale.lerp(over.scale, weight);
    }
}
