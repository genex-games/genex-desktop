//! Layer masks: which joints a layer moves, as one weight per joint (ozz-animation's per-joint
//! blend weights, MIT). A mask names subtree roots, as Bevy's animation mask groups do (MIT OR
//! Apache-2.0): a joint is in the mask when it or any ancestor is a root, so one pass over the
//! parent-first skeleton resolves it. Body parts come from the humanoid map.

use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::JointId;
use crate::skeleton::Skeleton;

/// A part of a humanoid body a layer can be limited to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BodyPart {
    /// The spine and everything above it: chest, neck, head, shoulders, arms and hands.
    UpperBody,
    /// Everything the upper body leaves: the hips, the legs and any other joint off the hips.
    LowerBody,
    /// The neck and the head.
    Head,
    /// The left shoulder, arm and hand.
    LeftArm,
    /// The right shoulder, arm and hand.
    RightArm,
    /// The left thigh, shin, foot and toes.
    LeftLeg,
    /// The right thigh, shin, foot and toes.
    RightLeg,
}

impl BodyPart {
    /// The bones whose subtrees make the part, the first the rig has wins (the upper body falls
    /// back to the chest, an arm to its upper arm when the rig has no clavicle).
    const fn roots(self) -> &'static [HumanoidBone] {
        match self {
            BodyPart::UpperBody | BodyPart::LowerBody => &[HumanoidBone::Spine, HumanoidBone::Chest],
            BodyPart::Head => &[HumanoidBone::Neck, HumanoidBone::Head],
            BodyPart::LeftArm => &[HumanoidBone::LeftShoulder, HumanoidBone::LeftUpperArm],
            BodyPart::RightArm => &[HumanoidBone::RightShoulder, HumanoidBone::RightUpperArm],
            BodyPart::LeftLeg => &[HumanoidBone::LeftUpperLeg],
            BodyPart::RightLeg => &[HumanoidBone::RightUpperLeg],
        }
    }
}

/// Which joints a layer moves, before it is resolved against a skeleton.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mask {
    /// Every joint.
    All,
    /// A humanoid body part (needs the skeleton's humanoid map).
    Humanoid(BodyPart),
    /// These joints and everything below them.
    Joints(Vec<JointId>),
}

impl Mask {
    /// One weight per joint of `skeleton`. `None` when the mask names a joint the skeleton does
    /// not have, or a body part whose bones the humanoid map lacks (or there is no map): the
    /// caller refuses rather than silently masking nothing.
    pub fn resolve(&self, skeleton: &Skeleton, humanoid: Option<&HumanoidMap>) -> Option<JointMask> {
        match self {
            Mask::All => Some(JointMask::all(skeleton.joint_count())),
            Mask::Joints(roots) => {
                let count = skeleton.joint_count();
                roots.iter().all(|root| usize::from(root.raw()) < count).then(|| JointMask::subtrees(skeleton, roots))
            }
            Mask::Humanoid(part) => {
                let map = humanoid?;
                let root = part.roots().iter().find_map(|bone| map.joint(*bone))?;
                let mask = JointMask::subtrees(skeleton, &[root]);
                Some(if *part == BodyPart::LowerBody { mask.inverted() } else { mask })
            }
        }
    }
}

/// A resolved mask: one weight in `[0, 1]` per joint, parents first.
#[derive(Clone, Debug, PartialEq)]
pub struct JointMask {
    weights: Vec<f32>,
}

impl JointMask {
    /// Every one of `count` joints at weight 1.
    pub fn all(count: usize) -> JointMask {
        JointMask { weights: vec![1.0; count] }
    }

    /// The subtrees under `roots` at weight 1, every other joint at 0.
    pub fn subtrees(skeleton: &Skeleton, roots: &[JointId]) -> JointMask {
        let mut weights = vec![0.0; skeleton.joint_count()];
        for joint in skeleton.joints() {
            let under_root = roots.contains(&joint);
            let under_parent = skeleton.parent(joint).is_some_and(|parent| weights[usize::from(parent.raw())] > 0.0);
            if under_root || under_parent {
                weights[usize::from(joint.raw())] = 1.0;
            }
        }
        JointMask { weights }
    }

    /// One weight per joint, clamped to `[0, 1]`; a non-finite weight is 0.
    pub fn from_weights(weights: impl IntoIterator<Item = f32>) -> JointMask {
        JointMask { weights: weights.into_iter().map(clamp_unit).collect() }
    }

    /// Every weight flipped (`1 − w`): the joints this mask leaves.
    pub fn inverted(&self) -> JointMask {
        JointMask { weights: self.weights.iter().map(|weight| 1.0 - weight).collect() }
    }

    /// A joint's weight; 0 past the mask's end.
    pub fn weight(&self, joint: JointId) -> f32 {
        self.weight_at(usize::from(joint.raw()))
    }

    /// The weight of the joint at `index`; 0 past the mask's end.
    pub fn weight_at(&self, index: usize) -> f32 {
        self.weights.get(index).copied().unwrap_or(0.0)
    }

    /// Joints with a weight above 0.
    pub fn count(&self) -> usize {
        self.weights.iter().filter(|weight| **weight > 0.0).count()
    }

    /// Every weight, parents first.
    pub fn weights(&self) -> &[f32] {
        &self.weights
    }
}

/// `weight` in `[0, 1]`, a NaN as 0.
pub(crate) fn clamp_unit(weight: f32) -> f32 {
    if weight.is_nan() { 0.0 } else { weight.clamp(0.0, 1.0) }
}
