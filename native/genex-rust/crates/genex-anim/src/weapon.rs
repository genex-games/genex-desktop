//! Weapon sockets and two-handed holds. A [`WeaponSockets`] names the two points a weapon is held
//! by (the primary grip and the support grip) as offsets on a rig's hand bones, found through the
//! humanoid map so any humanoid rig has them. [`hold_weapon`] then bends both arms, with the
//! two-bone solver, so each hand's grip point lands on the weapon's grip point wherever the
//! animation left the body; a clip no longer has to hold the weapon right, only roughly.

use glam::{Mat4, Vec3};

use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::JointId;
use crate::ik::{TwoBoneChain, TwoBoneIk, apply_two_bone};
use crate::math::Trs;
use crate::skeleton::Skeleton;

/// A grip's distance from its wrist, as a share of the forearm's length: the middle of the palm.
const PALM_SHARE: f32 = 0.35;
/// How many times an arm is solved: the grip sits off the wrist and swings as the arm turns, so
/// each pass re-aims at what the last one left.
const HOLD_PASSES: usize = 4;
/// A hand this close to its grip counts as holding it, metres.
pub const HOLD_TOLERANCE: f32 = 0.02;

/// One grip: a hand joint and the point on it that holds the weapon.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Socket {
    /// The hand joint.
    pub joint: JointId,
    /// The grip's offset in the hand joint's own frame.
    pub offset: Vec3,
}

impl Socket {
    /// The grip's model-space position under `model`.
    pub fn position(&self, model: &[Mat4]) -> Option<Vec3> {
        model.get(usize::from(self.joint.raw())).map(|m| m.transform_point3(self.offset))
    }
}

/// The two grips of a rig: the right hand holds the weapon, the left supports it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeaponSockets {
    /// The firing hand's grip.
    pub primary: Socket,
    /// The support hand's grip.
    pub support: Socket,
    right: Arm,
    left: Arm,
}

/// The joints of one arm.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Arm {
    upper: JointId,
    lower: JointId,
    hand: JointId,
}

/// Where the weapon's grips are, model space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WeaponHold {
    /// Where the firing hand's grip goes.
    pub primary: Vec3,
    /// Where the support hand's grip goes.
    pub support: Vec3,
    /// How much of the correction to apply, `[0, 1]`.
    pub weight: f32,
}

/// What a hold achieved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoldResult {
    /// The firing hand's grip is within [`HOLD_TOLERANCE`] of its point.
    pub primary: bool,
    /// The support hand's grip is within [`HOLD_TOLERANCE`] of its point.
    pub support: bool,
}

impl WeaponSockets {
    /// The sockets of a humanoid rig, in the palm: none when an arm lacks a bone.
    pub fn of(skeleton: &Skeleton, map: &HumanoidMap) -> Option<WeaponSockets> {
        let arm = |upper, lower, hand| Some(Arm { upper: map.joint(upper)?, lower: map.joint(lower)?, hand: map.joint(hand)? });
        let right = arm(HumanoidBone::RightUpperArm, HumanoidBone::RightLowerArm, HumanoidBone::RightHand)?;
        let left = arm(HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand)?;
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let socket = |arm: Arm| {
            let at = |joint: JointId| rest[usize::from(joint.raw())];
            let forearm = (at(arm.hand).w_axis.truncate() - at(arm.lower).w_axis.truncate()).length();
            // The palm lies along the forearm's line, past the wrist, in the hand's own frame.
            let along = at(arm.hand).inverse().transform_vector3((at(arm.hand).w_axis - at(arm.lower).w_axis).truncate().normalize_or_zero());
            Socket { joint: arm.hand, offset: along * forearm * PALM_SHARE }
        };
        Some(WeaponSockets { primary: socket(right), support: socket(left), right, left })
    }
}

/// Bend both arms so each grip meets its point. `model` must be current for `pose`; the arm
/// joints' rotations change and `model` is rewritten from the shoulders down to the hands.
pub fn hold_weapon(skeleton: &Skeleton, sockets: &WeaponSockets, hold: &WeaponHold, pose: &mut [Trs], model: &mut [Mat4]) -> HoldResult {
    let reach = |arm: Arm, socket: Socket, goal: Vec3, pose: &mut [Trs], model: &mut [Mat4]| {
        let position = |model: &[Mat4], joint: JointId| model[usize::from(joint.raw())].w_axis.truncate();
        let chain = TwoBoneChain { start: arm.upper, mid: arm.lower, end: arm.hand, mid_axis: Vec3::X };
        for _ in 0..HOLD_PASSES {
            let grip = socket.position(model).unwrap_or(goal);
            // The hand joint must move by what the grip is away from its point.
            let hand_goal = position(model, arm.hand) + (goal - grip);
            let pole = (position(model, arm.lower) - position(model, arm.upper)).normalize_or_zero();
            let ik = TwoBoneIk { weight: hold.weight, ..TwoBoneIk::new(hand_goal, pole) };
            apply_two_bone(skeleton, &chain, &ik, pose, model);
            skeleton.local_to_model(pose, model);
        }
        socket.position(model).is_some_and(|now| now.distance(goal) <= HOLD_TOLERANCE)
    };
    let primary = reach(sockets.right, sockets.primary, hold.primary, pose, model);
    let support = reach(sockets.left, sockets.support, hold.support, pose, model);
    HoldResult { primary, support }
}
