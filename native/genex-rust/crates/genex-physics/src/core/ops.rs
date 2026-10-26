//! Checking a command (§7): every refusal a command can give, judged against a [`Ledger`] only,
//! so an atomic batch can be judged on a copy. The result is an [`Op`] that cannot fail.
//!
//! Order within one command: key syntax (`InvalidKey`), then each number in argument order
//! (`NonFinite` before `OutOfRange`), then the world's checks (`UnknownKey`, `WrongBodyType`,
//! `DuplicateKey`, `Limit*`). `setMotor` names its joint before its motor, whose bounds depend on
//! the joint's type.

use super::Core;
use crate::axes::{quat_in, vec_in};
use crate::backend::{Backend, BodyEdit};
use crate::body::{BodyDesc, Groups, ValidBody, body_pose, bounded_speed, group, validate_body};
use crate::command::{Command, SetPoseOptions};
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::joint::{JointDesc, ValidJoint, ValidMotor, validate_joint, validate_motor};
use crate::key::check_key;
use crate::kinematic::RawPose;
use crate::ledger::{BodyFacts, JointFacts, Ledger};
use crate::memory::{body_bytes, joint_bytes};
use crate::num::{finite, finite_vec, non_negative, positive};
use crate::types::{BodyType, Pose, Vec3};

/// An `areaPush` with every number checked, in the caller frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AreaPush {
    pub center: [f32; 3],
    pub radius: f32,
    pub strength: f32,
    pub falloff: f32,
    /// `(member, collides)`, or `None` for every body.
    pub groups: Option<(u16, u16)>,
}

/// A command that passed every check; applying it cannot fail.
#[derive(Clone, Debug)]
pub(crate) enum Op {
    Spawn(Box<ValidBody>, BodyFacts),
    Remove(String),
    AddJoint(Box<ValidJoint>, JointFacts),
    RemoveJoint(String),
    Edit(String, BodyEdit),
    Target(String, RawPose),
    AreaPush(AreaPush),
    SetMotor(String, ValidMotor),
}

/// Records `op`'s effect on keys, counts and memory.
pub(crate) fn record(ledger: &mut Ledger, op: &Op) {
    match op {
        Op::Spawn(body, facts) => ledger.add_body(&body.key, facts.clone()),
        Op::Remove(key) => {
            ledger.remove_body(key);
        }
        Op::AddJoint(joint, facts) => ledger.add_joint(&joint.key, facts.clone()),
        Op::RemoveJoint(key) => ledger.remove_joint(key),
        Op::Edit(..) | Op::Target(..) | Op::AreaPush(_) | Op::SetMotor(..) => {}
    }
}

impl<B: Backend> Core<B> {
    /// Judges `command` against `ledger` (§7).
    pub(super) fn check(&self, ledger: &Ledger, command: &Command) -> Result<Op, PhysicsFailure> {
        match command {
            Command::Spawn(desc) => self.check_spawn(ledger, desc),
            Command::Remove { key } => {
                check_key(key)?;
                ledger.body_type(key)?;
                Ok(Op::Remove(key.clone()))
            }
            Command::AddJoint(desc) => self.check_add_joint(ledger, desc),
            Command::RemoveJoint { key } => {
                check_key(key)?;
                ledger.joint(key)?;
                Ok(Op::RemoveJoint(key.clone()))
            }
            Command::Impulse { key, j, at } => self.check_impulse(ledger, key, *j, *at),
            Command::SetVelocity { key, linvel, angvel } => self.check_velocity(ledger, key, *linvel, *angvel),
            Command::SetPose { key, pose, options } => self.check_set_pose(ledger, key, pose, *options),
            Command::SetNextKinematicPose { key, pose } => self.check_target(ledger, key, pose),
            Command::AreaPush { center, radius, strength, falloff, groups } => {
                check_area_push(*center, *radius, *strength, *falloff, *groups).map(Op::AreaPush)
            }
            Command::SetMotor { key, motor } => {
                check_key(key)?;
                let joint_type = ledger.joint(key)?.joint_type;
                let motor = validate_motor(motor, joint_type, &self.desc.limits)?;
                Ok(Op::SetMotor(key.clone(), motor))
            }
            Command::Wake { key } => self.check_any_body(ledger, key, BodyEdit::Wake),
            Command::Sleep { key } => self.check_any_body(ledger, key, BodyEdit::Sleep),
        }
    }

    fn check_spawn(&self, ledger: &Ledger, desc: &BodyDesc) -> Result<Op, PhysicsFailure> {
        let limits = self.desc.limits;
        let valid = validate_body(desc, self.desc.up_axis, &limits)?;
        if ledger.bodies.contains_key(&valid.key) {
            return fail(PhysicsError::DuplicateKey, "a body already has that key");
        }
        if ledger.bodies.len() >= limits.bodies as usize {
            return fail(PhysicsError::LimitBodies, "limits.bodies reached");
        }
        if valid.collider_keys.len() > limits.colliders_per_body as usize {
            return fail(PhysicsError::LimitColliders, "more colliders than limits.collidersPerBody");
        }
        if valid.facts.hull_points_max > limits.hull_vertices as usize {
            return fail(PhysicsError::LimitHullVertices, "a hull has more points than limits.hullVertices");
        }
        if ledger.triangles + valid.facts.triangles > limits.triangles as usize {
            return fail(PhysicsError::LimitTriangles, "limits.triangles reached");
        }
        if valid.spec.ccd && ledger.ccd_bodies >= limits.ccd_bodies as usize {
            return fail(PhysicsError::LimitCcd, "limits.ccdBodies reached");
        }
        let key_bytes = valid.key.len() + valid.collider_keys.iter().map(String::len).sum::<usize>();
        let bytes = body_bytes(valid.collider_keys.len(), key_bytes, &valid.facts);
        ledger.admit(bytes, limits.memory_bytes)?;
        if self.backend.check(&valid.spec).is_err() {
            return fail(PhysicsError::BadShape, "the backend could not build a shape");
        }
        let facts =
            BodyFacts { body_type: valid.spec.body_type, ccd: valid.spec.ccd, triangles: valid.facts.triangles, bytes };
        Ok(Op::Spawn(Box::new(valid), facts))
    }

    fn check_add_joint(&self, ledger: &Ledger, desc: &JointDesc) -> Result<Op, PhysicsFailure> {
        let limits = self.desc.limits;
        let valid = validate_joint(desc, self.desc.up_axis, &limits)?;
        if ledger.joints.contains_key(&valid.key) {
            return fail(PhysicsError::DuplicateKey, "a joint already has that key");
        }
        ledger.body_type(&valid.a)?;
        if let Some(b) = &valid.b {
            ledger.body_type(b)?;
        }
        if ledger.joints.len() >= limits.joints as usize {
            return fail(PhysicsError::LimitJoints, "limits.joints reached");
        }
        let bytes = joint_bytes(valid.key.len());
        ledger.admit(bytes, limits.memory_bytes)?;
        let facts = JointFacts { a: valid.a.clone(), b: valid.b.clone(), joint_type: valid.spec.joint_type, bytes };
        Ok(Op::AddJoint(Box::new(valid), facts))
    }

    fn check_impulse(&self, ledger: &Ledger, key: &str, j: Vec3, at: Option<Vec3>) -> Result<Op, PhysicsFailure> {
        check_key(key)?;
        let up = self.desc.up_axis;
        let j = vec_in(up, finite_vec(j, "j")?);
        let at = at.map(|point| finite_vec(point, "at").map(|p| vec_in(up, p))).transpose()?;
        ledger.body_of_type(key, &[BodyType::Dynamic])?;
        Ok(Op::Edit(key.to_string(), BodyEdit::Impulse { j, at }))
    }

    fn check_velocity(
        &self,
        ledger: &Ledger,
        key: &str,
        linvel: Option<Vec3>,
        angvel: Option<Vec3>,
    ) -> Result<Op, PhysicsFailure> {
        check_key(key)?;
        let (up, limits) = (self.desc.up_axis, self.desc.limits);
        let linvel = linvel.map(|v| bounded_speed(v, "linvel", limits.max_speed).map(|v| vec_in(up, v))).transpose()?;
        let angvel =
            angvel.map(|v| bounded_speed(v, "angvel", limits.max_angular_speed).map(|v| vec_in(up, v))).transpose()?;
        ledger.body_of_type(key, &[BodyType::Dynamic])?;
        Ok(Op::Edit(key.to_string(), BodyEdit::Velocity { linvel, angvel }))
    }

    fn check_set_pose(
        &self,
        ledger: &Ledger,
        key: &str,
        pose: &Pose,
        options: SetPoseOptions,
    ) -> Result<Op, PhysicsFailure> {
        check_key(key)?;
        let (p, q) = body_pose(pose, &self.desc.limits)?;
        ledger.body_of_type(key, &[BodyType::Dynamic, BodyType::Fixed])?;
        let up = self.desc.up_axis;
        let edit = BodyEdit::Teleport {
            translation: vec_in(up, p),
            rotation: quat_in(up, q),
            reset_velocity: options.reset_velocity,
            wake: options.wake,
        };
        Ok(Op::Edit(key.to_string(), edit))
    }

    fn check_target(&self, ledger: &Ledger, key: &str, pose: &Pose) -> Result<Op, PhysicsFailure> {
        check_key(key)?;
        let target = body_pose(pose, &self.desc.limits)?;
        ledger.body_of_type(key, &[BodyType::Kinematic])?;
        Ok(Op::Target(key.to_string(), target))
    }

    fn check_any_body(&self, ledger: &Ledger, key: &str, edit: BodyEdit) -> Result<Op, PhysicsFailure> {
        check_key(key)?;
        ledger.body_type(key)?;
        Ok(Op::Edit(key.to_string(), edit))
    }
}

fn check_area_push(
    center: Vec3,
    radius: f64,
    strength: f64,
    falloff: f64,
    groups: Option<Groups>,
) -> Result<AreaPush, PhysicsFailure> {
    let center = finite_vec(center, "center")?;
    let radius = positive(radius, "radius")?;
    let strength = finite(strength, "strength")?;
    let falloff = non_negative(falloff, "falloff")?;
    let groups = match groups {
        Some(g) => Some((group(Some(g.member), "groups.member")?, group(Some(g.collides), "groups.collides")?)),
        None => None,
    };
    Ok(AreaPush { center, radius, strength, falloff, groups })
}

