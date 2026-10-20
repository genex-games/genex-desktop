//! Ragdoll profiles: the humanoid part table and its limits.
//!
//! A part is one rigid body: a capsule from its bone's joint to its tip bone's joint, a share of
//! the total mass and a joint to its parent part. Joints are balls (a swing cone and a twist about
//! the bone) or hinges (knees and elbows) that bend toward a direction in the character's model
//! space (+Z forward, +Y up), so a hinge's sign never depends on how a rig orients its joints'
//! local axes. Limits are relative to the skeleton's rest pose.
//!
//! [`RagdollProfile::humanoid`] is the one table: 11 bodies and 10 joints (pelvis, torso, head,
//! upper and lower arms, upper and lower legs), with mass shares and ranges from common game
//! ragdoll setups. Non-humanoid ragdolls are a non-goal (game systems plan AN-20).

use glam::Vec3;

use crate::error::AnimationError;
use crate::humanoid::HumanoidBone;

/// The most parts a profile may have.
pub const RAGDOLL_PARTS_MAX: usize = 32;
/// The default total mass of a humanoid ragdoll, kilograms.
pub const RAGDOLL_DEFAULT_MASS: f32 = 70.0;
/// The largest total mass a profile may name, kilograms.
const RAGDOLL_MASS_MAX: f32 = 100_000.0;

/// How a part hangs from its parent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RagdollJoint {
    /// The root part: no parent, no joint.
    Root,
    /// A ball joint: the bone swings up to `swing` radians off its rest direction (about both
    /// axes across the bone) and twists up to `twist` radians about itself, either way.
    Ball {
        /// Swing limit, radians.
        swing: f32,
        /// Twist limit, radians.
        twist: f32,
    },
    /// A hinge: the bone bends from its rest angle (0) up to `max` radians, only toward
    /// `toward` (model space: knees toward -Z, elbows toward +Z).
    Hinge {
        /// The model-space direction the bone's tip moves as it bends.
        toward: Vec3,
        /// The largest bend, radians.
        max: f32,
    },
}

/// One rigid body of a ragdoll.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RagdollBody {
    /// The bone whose joint the body sits on; the body moves this bone.
    pub bone: HumanoidBone,
    /// The bone whose joint ends the capsule.
    pub tip: HumanoidBone,
    /// The parent part's index in the profile (`None` for the root).
    pub parent: Option<usize>,
    /// The capsule's radius as a share of the bone's length.
    pub radius_share: f32,
    /// The share of the total mass this body carries.
    pub mass_share: f32,
    /// The joint to the parent.
    pub joint: RagdollJoint,
}

/// A ragdoll's parts and total mass.
#[derive(Clone, Debug, PartialEq)]
pub struct RagdollProfile {
    parts: Vec<RagdollBody>,
    mass: f32,
}

/// Indices of the humanoid profile's bodies.
pub mod body {
    /// The pelvis (root).
    pub const PELVIS: usize = 0;
    /// The torso, spine to neck.
    pub const TORSO: usize = 1;
    /// The head.
    pub const HEAD: usize = 2;
    /// The left upper arm.
    pub const LEFT_UPPER_ARM: usize = 3;
    /// The left forearm.
    pub const LEFT_LOWER_ARM: usize = 4;
    /// The right upper arm.
    pub const RIGHT_UPPER_ARM: usize = 5;
    /// The right forearm.
    pub const RIGHT_LOWER_ARM: usize = 6;
    /// The left thigh.
    pub const LEFT_UPPER_LEG: usize = 7;
    /// The left shin.
    pub const LEFT_LOWER_LEG: usize = 8;
    /// The right thigh.
    pub const RIGHT_UPPER_LEG: usize = 9;
    /// The right shin.
    pub const RIGHT_LOWER_LEG: usize = 10;
}

impl RagdollProfile {
    /// The humanoid table: 11 bodies, 10 joints, 70 kg.
    pub fn humanoid() -> RagdollProfile {
        use HumanoidBone as B;
        let ball = |swing: f32, twist: f32| RagdollJoint::Ball { swing, twist };
        let elbow = RagdollJoint::Hinge { toward: Vec3::Z, max: 2.5 };
        let knee = RagdollJoint::Hinge { toward: Vec3::NEG_Z, max: 2.4 };
        let parts = vec![
            RagdollBody { bone: B::Hips, tip: B::Spine, parent: None, radius_share: 1.2, mass_share: 0.15, joint: RagdollJoint::Root },
            RagdollBody { bone: B::Spine, tip: B::Neck, parent: Some(body::PELVIS), radius_share: 0.35, mass_share: 0.3, joint: ball(0.5, 0.4) },
            RagdollBody { bone: B::Neck, tip: B::Head, parent: Some(body::TORSO), radius_share: 1.0, mass_share: 0.08, joint: ball(0.6, 0.6) },
            RagdollBody { bone: B::LeftUpperArm, tip: B::LeftLowerArm, parent: Some(body::TORSO), radius_share: 0.2, mass_share: 0.03, joint: ball(1.4, 0.8) },
            RagdollBody { bone: B::LeftLowerArm, tip: B::LeftHand, parent: Some(body::LEFT_UPPER_ARM), radius_share: 0.18, mass_share: 0.02, joint: elbow },
            RagdollBody { bone: B::RightUpperArm, tip: B::RightLowerArm, parent: Some(body::TORSO), radius_share: 0.2, mass_share: 0.03, joint: ball(1.4, 0.8) },
            RagdollBody { bone: B::RightLowerArm, tip: B::RightHand, parent: Some(body::RIGHT_UPPER_ARM), radius_share: 0.18, mass_share: 0.02, joint: elbow },
            RagdollBody { bone: B::LeftUpperLeg, tip: B::LeftLowerLeg, parent: Some(body::PELVIS), radius_share: 0.18, mass_share: 0.1, joint: ball(1.2, 0.5) },
            RagdollBody { bone: B::LeftLowerLeg, tip: B::LeftFoot, parent: Some(body::LEFT_UPPER_LEG), radius_share: 0.14, mass_share: 0.085, joint: knee },
            RagdollBody { bone: B::RightUpperLeg, tip: B::RightLowerLeg, parent: Some(body::PELVIS), radius_share: 0.18, mass_share: 0.1, joint: ball(1.2, 0.5) },
            RagdollBody { bone: B::RightLowerLeg, tip: B::RightFoot, parent: Some(body::RIGHT_UPPER_LEG), radius_share: 0.14, mass_share: 0.085, joint: knee },
        ];
        RagdollProfile { parts, mass: RAGDOLL_DEFAULT_MASS }
    }

    /// A profile of these parts (checked when a ragdoll is built).
    pub fn from_parts(parts: Vec<RagdollBody>, mass: f32) -> RagdollProfile {
        RagdollProfile { parts, mass }
    }

    /// The same profile with a total mass of `kg`.
    pub fn with_mass(mut self, kg: f32) -> RagdollProfile {
        self.mass = kg;
        self
    }

    /// The parts, parents before children.
    pub fn parts(&self) -> &[RagdollBody] {
        &self.parts
    }

    /// The total mass, kilograms.
    pub fn mass(&self) -> f32 {
        self.mass
    }

    /// The part whose body moves `bone`, if any.
    pub fn part_of(&self, bone: HumanoidBone) -> Option<usize> {
        self.parts.iter().position(|part| part.bone == bone)
    }

    /// Refused `ragdoll-profile-invalid`: no part or more than [`RAGDOLL_PARTS_MAX`], a mass that
    /// is not a positive finite number (or above 100 t), a first part that is not the only root, a
    /// parent at or after its child, a bone used twice, a share or limit that is not a positive
    /// finite number, a hinge direction of zero length, or mass shares that do not sum to 1
    /// within 1e-3.
    pub fn check(&self) -> Result<(), AnimationError> {
        let fail = |detail: String| Err(AnimationError::ragdoll_profile_invalid(detail));
        if self.parts.is_empty() || self.parts.len() > RAGDOLL_PARTS_MAX {
            return fail(format!("{} parts, a profile has 1 to {RAGDOLL_PARTS_MAX}", self.parts.len()));
        }
        if !(self.mass.is_finite() && self.mass > 0.0 && self.mass <= RAGDOLL_MASS_MAX) {
            return fail(format!("mass {} kg is not in (0, {RAGDOLL_MASS_MAX}]", self.mass));
        }
        let mut shares = 0.0;
        for (index, part) in self.parts.iter().enumerate() {
            check_part(index, part, &self.parts[..index])?;
            shares += part.mass_share;
        }
        if (shares - 1.0f32).abs() > 1.0e-3 {
            return fail(format!("mass shares sum to {shares}, not 1"));
        }
        Ok(())
    }
}

/// One part against the parts before it.
fn check_part(index: usize, part: &RagdollBody, before: &[RagdollBody]) -> Result<(), AnimationError> {
    let fail = |detail: String| Err(AnimationError::ragdoll_profile_invalid(format!("part {index} ({}): {detail}", part.bone.name())));
    let is_root = matches!(part.joint, RagdollJoint::Root);
    match part.parent {
        None if index == 0 && is_root => {}
        None => return fail("only the first part is the root, and it has no joint".to_owned()),
        Some(parent) if parent >= index => return fail(format!("its parent {parent} does not come before it")),
        Some(_) if is_root => return fail("a jointed part names the Root joint".to_owned()),
        Some(_) => {}
    }
    if before.iter().any(|other| other.bone == part.bone) {
        return fail("its bone is used twice".to_owned());
    }
    if part.tip == part.bone {
        return fail("its tip is its own bone".to_owned());
    }
    let positive = |value: f32| value.is_finite() && value > 0.0;
    if !positive(part.radius_share) || !positive(part.mass_share) {
        return fail(format!("radius share {} and mass share {} must be positive", part.radius_share, part.mass_share));
    }
    match part.joint {
        RagdollJoint::Ball { swing, twist } if !(positive(swing) && positive(twist)) => fail(format!("ball limits {swing}, {twist} must be positive")),
        RagdollJoint::Hinge { toward, max } if !(positive(max) && toward.is_finite() && toward.length_squared() > 1.0e-6) => {
            fail(format!("hinge toward {toward} and max {max} must be a direction and a positive angle"))
        }
        _ => Ok(()),
    }
}
