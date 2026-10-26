//! Joints (CONTRACT.md §6.4) as a caller describes them, and their validation into the backend's
//! spec: keys, f32 rounding, the §4.1 bounds and the z-up mapping.
//!
//! Readings the contract leaves open, stated once here:
//! - `axis` is required for `hinge` and `slider` and refused on the other types; it is normalised
//!   in f32 in the caller frame.
//! - `limits` and `motor` are for `hinge` (radians), `slider` and `rope` (caller units); a
//!   `rope` needs `limits`, `[min, max]` with `0 <= min <= max` and `max > 0`.
//! - A motor's `targetVel` is a speed a command sets (§4.1): at most `maxAngularSpeed` on a hinge,
//!   `maxSpeed` otherwise. Stiffness, damping and maxForce are at least 0; an absent maxForce is
//!   unlimited.
//! - `a` and `b` must name two different bodies.

use crate::axes::vec_in;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::key::{check_key, check_object_key};
use crate::limits::Limits;
use crate::num::{finite, finite_vec, non_negative};
use crate::types::{UpAxis, Vec3};

/// A joint type (§6.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JointType {
    /// Holds the two bodies' frames together.
    Fixed,
    /// Turns about one axis.
    Hinge,
    /// Turns about a point.
    Ball,
    /// Slides along one axis.
    Slider,
    /// Keeps the anchors within a maximum distance.
    Rope,
}

impl JointType {
    /// The wire spelling (`"fixed"`, `"hinge"`, `"ball"`, `"slider"`, `"rope"`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Hinge => "hinge",
            Self::Ball => "ball",
            Self::Slider => "slider",
            Self::Rope => "rope",
        }
    }

    /// Whether the type has one free axis that takes `limits` and a `motor`.
    pub fn has_free_axis(self) -> bool {
        matches!(self, Self::Hinge | Self::Slider | Self::Rope)
    }

    fn takes_axis(self) -> bool {
        matches!(self, Self::Hinge | Self::Slider)
    }
}

/// A joint motor's targets (§6.4); an absent value hashes as 0 (§10.1).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Motor {
    /// Target velocity, rad/s (hinge) or caller units per second.
    pub target_vel: Option<f64>,
    /// Target position, radians (hinge) or caller units.
    pub target_pos: Option<f64>,
    /// How strongly it pulls toward `target_pos`, at least 0.
    pub stiffness: Option<f64>,
    /// How strongly it pulls toward `target_vel`, at least 0.
    pub damping: Option<f64>,
    /// The largest force it applies, at least 0; absent is unlimited.
    pub max_force: Option<f64>,
}

/// A joint between two bodies, or a body and the world (§6.4).
#[derive(Clone, Debug, PartialEq)]
pub struct JointDesc {
    /// The joint's key (§3).
    pub key: String,
    /// The first body.
    pub a: String,
    /// The second body, or `None` for the world.
    pub b: Option<String>,
    /// Its type.
    pub joint_type: JointType,
    /// The anchor in `a`'s local frame (caller axes).
    pub anchor_a: Vec3,
    /// The anchor in `b`'s local frame, or a world point when `b` is `None`.
    pub anchor_b: Vec3,
    /// Hinge and slider only; non-zero.
    pub axis: Option<Vec3>,
    /// `[min, max]`: radians (hinge) or caller units (slider, rope).
    pub limits: Option<[f64; 2]>,
    /// Hinge, slider and rope only.
    pub motor: Option<Motor>,
    /// Whether the two bodies still collide; default false.
    pub collide_connected: bool,
}

impl JointDesc {
    /// A joint with no axis, limits or motor.
    pub fn new(
        key: impl Into<String>,
        a: impl Into<String>,
        b: Option<&str>,
        joint_type: JointType,
        anchor_a: Vec3,
        anchor_b: Vec3,
    ) -> Self {
        Self {
            key: key.into(),
            a: a.into(),
            b: b.map(str::to_string),
            joint_type,
            anchor_a,
            anchor_b,
            axis: None,
            limits: None,
            motor: None,
            collide_connected: false,
        }
    }
}

/// A motor with every value rounded and checked; `None` is an absent value.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct ValidMotor {
    pub target_vel: Option<f32>,
    pub target_pos: Option<f32>,
    pub stiffness: Option<f32>,
    pub damping: Option<f32>,
    pub max_force: Option<f32>,
}

impl ValidMotor {
    /// The five values in §10.1's order, an absent one as 0.
    pub(crate) fn hash_values(&self) -> [f32; 5] {
        [self.target_vel, self.target_pos, self.stiffness, self.damping, self.max_force].map(|v| v.unwrap_or(0.0))
    }
}

/// A joint in the core's frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JointSpec {
    pub joint_type: JointType,
    pub anchor_a: [f32; 3],
    pub anchor_b: [f32; 3],
    /// A unit axis in the core's frame; +x for the types without one.
    pub axis: [f32; 3],
    pub limits: Option<[f32; 2]>,
    pub motor: Option<ValidMotor>,
    pub collide_connected: bool,
}

/// A joint that passed every check that needs no world state.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ValidJoint {
    pub key: String,
    pub a: String,
    pub b: Option<String>,
    pub spec: JointSpec,
}

/// The x axis, the free axis of a joint type without `axis`.
const AXIS_X: [f32; 3] = [1.0, 0.0, 0.0];

/// Checks `desc` against everything but the world's contents.
pub(crate) fn validate_joint(desc: &JointDesc, up: UpAxis, limits: &Limits) -> Result<ValidJoint, PhysicsFailure> {
    check_object_key(&desc.key)?;
    check_key(&desc.a)?;
    if let Some(b) = &desc.b {
        check_key(b)?;
    }
    if desc.b.as_deref() == Some(desc.a.as_str()) {
        return fail(PhysicsError::OutOfRange, "a joint joins two different bodies");
    }
    let anchor_a = anchor(desc.anchor_a, "anchorA", limits)?;
    let anchor_b = anchor(desc.anchor_b, "anchorB", limits)?;
    let axis = joint_axis(desc)?;
    let range = joint_limits(desc)?;
    let motor = desc.motor.map(|m| validate_motor(&m, desc.joint_type, limits)).transpose()?;
    let spec = JointSpec {
        joint_type: desc.joint_type,
        anchor_a: vec_in(up, anchor_a),
        anchor_b: vec_in(up, anchor_b),
        axis: vec_in(up, axis),
        limits: range,
        motor,
        collide_connected: desc.collide_connected,
    };
    Ok(ValidJoint { key: desc.key.clone(), a: desc.a.clone(), b: desc.b.clone(), spec })
}

/// An anchor: finite and within `worldExtent` per axis (§4.1).
fn anchor(v: Vec3, what: &str, limits: &Limits) -> Result<[f32; 3], PhysicsFailure> {
    let value = finite_vec(v, what)?;
    if value.iter().any(|c| c.abs() > limits.world_extent) {
        return fail(PhysicsError::OutOfRange, format!("{what} lies outside limits.worldExtent"));
    }
    Ok(value)
}

/// The free axis in the caller frame, normalised in f32.
fn joint_axis(desc: &JointDesc) -> Result<[f32; 3], PhysicsFailure> {
    let takes_axis = desc.joint_type.takes_axis();
    let Some(axis) = desc.axis else {
        if takes_axis {
            return fail(PhysicsError::OutOfRange, "a hinge or slider needs an axis");
        }
        return Ok(AXIS_X);
    };
    if !takes_axis {
        return fail(PhysicsError::OutOfRange, "only a hinge or slider takes an axis");
    }
    let value = finite_vec(axis, "axis")?;
    let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
    if length == 0.0 || !length.is_finite() {
        return fail(PhysicsError::OutOfRange, "axis is zero or too long to normalise");
    }
    Ok(value.map(|c| c / length))
}

fn joint_limits(desc: &JointDesc) -> Result<Option<[f32; 2]>, PhysicsFailure> {
    let Some([lo, hi]) = desc.limits else {
        if desc.joint_type == JointType::Rope {
            return fail(PhysicsError::OutOfRange, "a rope needs limits: [min, max length]");
        }
        return Ok(None);
    };
    if !desc.joint_type.has_free_axis() {
        return fail(PhysicsError::OutOfRange, "only a hinge, slider or rope takes limits");
    }
    let (lo, hi) = (finite(lo, "limits[0]")?, finite(hi, "limits[1]")?);
    let rope_ok = desc.joint_type != JointType::Rope || (lo >= 0.0 && hi > 0.0);
    if lo > hi || !rope_ok {
        return fail(PhysicsError::OutOfRange, "limits must be [min, max] with min <= max");
    }
    Ok(Some([lo, hi]))
}

/// Checks a motor for a joint of `joint_type` (§6.4, §4.1).
pub(crate) fn validate_motor(motor: &Motor, joint_type: JointType, limits: &Limits) -> Result<ValidMotor, PhysicsFailure> {
    if !joint_type.has_free_axis() {
        return fail(PhysicsError::OutOfRange, "only a hinge, slider or rope takes a motor");
    }
    let max_speed = match joint_type {
        JointType::Hinge => limits.max_angular_speed,
        _ => limits.max_speed,
    };
    let target_vel = motor.target_vel.map(|v| finite(v, "motor.targetVel")).transpose()?;
    if target_vel.is_some_and(|v| v.abs() > max_speed) {
        return fail(PhysicsError::OutOfRange, "motor.targetVel is above its speed limit");
    }
    Ok(ValidMotor {
        target_vel,
        target_pos: motor.target_pos.map(|v| finite(v, "motor.targetPos")).transpose()?,
        stiffness: motor.stiffness.map(|v| non_negative(v, "motor.stiffness")).transpose()?,
        damping: motor.damping.map(|v| non_negative(v, "motor.damping")).transpose()?,
        max_force: motor.max_force.map(|v| non_negative(v, "motor.maxForce")).transpose()?,
    })
}

