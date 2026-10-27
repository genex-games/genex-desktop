//! Commands (CONTRACT.md §7): every verb as a value, so a batch (§7.1) and the JSON form (§7.3)
//! share one shape with the per-verb methods of [`crate::World`].

use serde_json::Value;

use crate::body::{BodyDesc, Groups};
use crate::error::{PhysicsError, PhysicsFailure};
use crate::joint::{JointDesc, Motor};
use crate::types::{Pose, Vec3};

/// `setPose` options (§7): `resetVelocity` defaults to false, `wake` to true.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetPoseOptions {
    /// Zero the body's velocities.
    pub reset_velocity: bool,
    /// Wake the body.
    pub wake: bool,
}

impl Default for SetPoseOptions {
    fn default() -> Self {
        Self { reset_velocity: false, wake: true }
    }
}

/// One command of §7, in the caller frame.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// Inserts a body and its colliders.
    Spawn(BodyDesc),
    /// Removes a body, its colliders and every joint that references it.
    Remove {
        /// The body.
        key: String,
    },
    /// Adds a joint (§6.4).
    AddJoint(JointDesc),
    /// Removes a joint.
    RemoveJoint {
        /// The joint.
        key: String,
    },
    /// A linear impulse on a dynamic body, with torque when `at` (a world point) is given.
    Impulse {
        /// The body.
        key: String,
        /// The impulse, kg · caller-unit / s.
        j: Vec3,
        /// Where it is applied, a world point.
        at: Option<Vec3>,
    },
    /// Sets a dynamic body's velocities.
    SetVelocity {
        /// The body.
        key: String,
        /// Linear velocity.
        linvel: Option<Vec3>,
        /// Angular velocity, rad/s.
        angvel: Option<Vec3>,
    },
    /// Teleports a dynamic or fixed body.
    SetPose {
        /// The body.
        key: String,
        /// Its new pose.
        pose: Pose,
        /// `resetVelocity` and `wake`.
        options: SetPoseOptions,
    },
    /// A kinematic body's pose at the end of the next step (§7.2).
    SetNextKinematicPose {
        /// The body.
        key: String,
        /// The target pose.
        pose: Pose,
    },
    /// An impulse on every dynamic body whose origin lies within `radius` of `center`.
    AreaPush {
        /// The centre, a world point.
        center: Vec3,
        /// Above 0.
        radius: f64,
        /// The impulse at the centre.
        strength: f64,
        /// At least 0.
        falloff: f64,
        /// Only bodies with a collider these groups interact with; default all.
        groups: Option<Groups>,
    },
    /// Replaces a joint's motor.
    SetMotor {
        /// The joint.
        key: String,
        /// The new motor.
        motor: Motor,
    },
    /// Wakes a body.
    Wake {
        /// The body.
        key: String,
    },
    /// Puts a body to sleep.
    Sleep {
        /// The body.
        key: String,
    },
}

impl Command {
    /// The verb's name in the JSON form (§7.3), e.g. `"setPose"`.
    pub fn verb(&self) -> &'static str {
        match self {
            Self::Spawn(_) => "spawn",
            Self::Remove { .. } => "remove",
            Self::AddJoint(_) => "addJoint",
            Self::RemoveJoint { .. } => "removeJoint",
            Self::Impulse { .. } => "impulse",
            Self::SetVelocity { .. } => "setVelocity",
            Self::SetPose { .. } => "setPose",
            Self::SetNextKinematicPose { .. } => "setNextKinematicPose",
            Self::AreaPush { .. } => "areaPush",
            Self::SetMotor { .. } => "setMotor",
            Self::Wake { .. } => "wake",
            Self::Sleep { .. } => "sleep",
        }
    }

    /// Reads a command in its JSON form (§7.3); a malformed one gives `BadCommand`.
    pub fn from_json(value: &Value) -> Result<Command, PhysicsFailure> {
        crate::json::command(value)
    }
}

/// One command's outcome in an `"each"` batch (§7.1): `Ok(())` or its code.
pub type CommandOutcome = Result<(), PhysicsError>;

/// How `apply` treats a failing command (§7.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyMode {
    /// Every command or none; a failure names the first failing index.
    Atomic,
    /// Every command that succeeds, in order, one outcome per command.
    Each,
}

impl ApplyMode {
    /// The mode by its wire name, `"atomic"` or `"each"`.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "atomic" => Some(Self::Atomic),
            "each" => Some(Self::Each),
            _ => None,
        }
    }
}
