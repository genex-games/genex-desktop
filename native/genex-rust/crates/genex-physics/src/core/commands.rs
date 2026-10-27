//! Applying commands (§7): one at a time, in an atomic or an each batch (§7.1), and the static
//! world (§6.5). Every command is checked before anything changes, so a refusal changes nothing.
//!
//! An escaped body stays frozen (§8.2): an impulse, velocity, wake or sleep on it is accepted and
//! changes nothing; only `setPose` (always inside `worldExtent`) returns it to the simulation,
//! asleep and still, then woken unless `wake: false`. `importBodyState` (§9.2) returns it the same
//! way, then sets every field it is given.

use super::ops::{AreaPush, Op, record};
use super::{Core, Entry, JointEntry};
use crate::axes::{vec_in, vec_out};
use crate::backend::{Backend, BodyEdit};
use crate::body::ValidBody;
use crate::command::Command;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::joint::{ValidJoint, ValidMotor};
use crate::memory::body_bytes;
use crate::static_world::{StaticWorld, validate_static};
use crate::types::{BodyType, UpAxis};

impl<B: Backend> Core<B> {
    /// Checks and applies one command; a refusal changes nothing.
    pub(crate) fn run(&mut self, command: &Command) -> Result<(), PhysicsFailure> {
        let op = self.check(&self.ledger, command)?;
        self.commit(op)
    }

    /// Applies every command or none (§7.1); a failure names the first failing index, whether the
    /// command there could not be read (its `Err`) or was refused.
    pub(crate) fn apply_atomic<'a>(
        &mut self,
        commands: impl IntoIterator<Item = Result<&'a Command, PhysicsFailure>>,
    ) -> Result<(), PhysicsFailure> {
        let mut shadow = self.ledger.clone();
        let mut ops = Vec::new();
        for (index, command) in commands.into_iter().enumerate() {
            let op = command.and_then(|command| self.check(&shadow, command)).map_err(|failure| failure.at(index))?;
            record(&mut shadow, &op);
            ops.push(op);
        }
        ops.into_iter().try_for_each(|op| self.commit(op))
    }

    /// Records `op` in the ledger and applies it.
    fn commit(&mut self, op: Op) -> Result<(), PhysicsFailure> {
        record(&mut self.ledger, &op);
        match op {
            Op::Spawn(body, _) => self.insert_body(*body)?,
            Op::Remove(key) => self.remove_body(&key),
            Op::AddJoint(joint, _) => self.insert_joint(*joint),
            Op::RemoveJoint(key) => self.remove_joint(&key),
            Op::Edit(key, edit) => self.edit_body(&key, edit),
            Op::Target(key, pose) => {
                if let Some(entry) = self.bodies.get_mut(&key) {
                    entry.target = Some(pose);
                }
            }
            Op::AreaPush(push) => self.area_push(&push),
            Op::SetMotor(key, motor) => self.set_motor(&key, motor),
        }
        Ok(())
    }

    fn insert_body(&mut self, valid: ValidBody) -> Result<(), PhysicsFailure> {
        let tag = self.new_tag(&valid.key);
        let Ok(handle) = self.backend.insert(&valid.spec, tag) else {
            self.names.remove(&tag);
            return fail(PhysicsError::Internal, "the backend refused a body it had accepted");
        };
        let body_type = valid.spec.body_type;
        let groups = valid.spec.colliders.iter().map(|c| (c.member, c.collides)).collect();
        let entry = Entry {
            handle,
            tag,
            colliders: valid.collider_keys,
            kind: valid.kind,
            body_type,
            escaped: false,
            groups,
            target: None,
            last: self.net_state(handle, body_type, false),
            changed_mark: self.command_mark(),
        };
        self.bodies.insert(valid.key, entry);
        Ok(())
    }

    /// Removes a body, its colliders and every joint that references it (joints in key order).
    fn remove_body(&mut self, key: &str) {
        let joints: Vec<String> = self
            .joints
            .iter()
            .filter(|(_, joint)| joint.a == key || joint.b.as_deref() == Some(key))
            .map(|(joint_key, _)| joint_key.clone())
            .collect();
        for joint in joints {
            self.remove_joint(&joint);
        }
        if let Some(entry) = self.bodies.remove(key) {
            self.backend.remove(entry.handle);
            self.names.remove(&entry.tag);
        }
        self.carried.retain(|pair| !pair.names_body(key));
    }

    fn insert_joint(&mut self, valid: ValidJoint) {
        let Some(a) = self.bodies.get(&valid.a).map(|e| e.handle) else { return };
        let b = valid.b.as_ref().and_then(|key| self.bodies.get(key)).map(|e| e.handle);
        let handle = self.backend.insert_joint(a, b, &valid.spec);
        self.joints.insert(valid.key, JointEntry { handle, a: valid.a, b: valid.b, spec: valid.spec });
    }

    fn remove_joint(&mut self, key: &str) {
        if let Some(joint) = self.joints.remove(key) {
            self.backend.remove_joint(joint.handle);
        }
    }

    fn set_motor(&mut self, key: &str, motor: ValidMotor) {
        let Some(joint) = self.joints.get_mut(key) else { return };
        joint.spec.motor = Some(motor);
        self.backend.set_motor(joint.handle, &joint.spec);
    }

    pub(super) fn edit_body(&mut self, key: &str, edit: BodyEdit) {
        let Some(entry) = self.bodies.get_mut(key) else { return };
        let teleport = matches!(edit, BodyEdit::Teleport { .. } | BodyEdit::Import { .. });
        if entry.escaped && !teleport {
            return;
        }
        if entry.escaped {
            self.backend.unfreeze(entry.handle, entry.body_type);
            entry.escaped = false;
        }
        let sleep_edit = matches!(edit, BodyEdit::Wake | BodyEdit::Sleep);
        if !(sleep_edit && entry.body_type == BodyType::Fixed) {
            self.backend.edit(entry.handle, edit);
        }
        self.touch(key);
    }

    /// `areaPush` (§7): `strength · (1 − d/radius)^falloff` along centre → origin, in key order.
    /// Distances are computed in f32 in the caller frame, so both frames push the same bits.
    fn area_push(&mut self, push: &AreaPush) {
        let up = self.desc.up_axis;
        let mut pushed = Vec::new();
        for (key, entry) in &self.bodies {
            let selectable = entry.body_type == BodyType::Dynamic && !entry.escaped;
            if !selectable || !groups_match(&entry.groups, push.groups) {
                continue;
            }
            let origin = vec_out(up, self.backend.state(entry.handle).translation);
            if let Some(j) = push_impulse(push, origin) {
                pushed.push((key.clone(), entry.handle, vec_in(up, j)));
            }
        }
        for (key, handle, j) in pushed {
            self.backend.edit(handle, BodyEdit::Impulse { j, at: None });
            self.touch(&key);
        }
    }

    /// Imports PROTOCOL §17.7's world once (§6.5); a refusal changes nothing.
    pub(crate) fn add_static_world(&mut self, world: &StaticWorld) -> Result<(), PhysicsFailure> {
        if self.desc.up_axis != UpAxis::Z {
            return fail(PhysicsError::OutOfRange, "addStaticWorld needs upAxis \"z\"");
        }
        let valid = validate_static(world)?;
        if self.ledger.static_added {
            return fail(PhysicsError::DuplicateKey, "the world already has its static world");
        }
        let limits = self.desc.limits;
        if valid.pieces.len() > limits.static_pieces as usize {
            return fail(PhysicsError::LimitStatic, "more pieces than limits.staticPieces");
        }
        let bytes: u64 = valid.pieces.iter().map(|piece| body_bytes(1, 2 * piece.key.len(), &piece.facts)).sum();
        self.ledger.admit(bytes, limits.memory_bytes)?;
        if valid.pieces.iter().any(|piece| self.backend.check(&piece.spec).is_err()) {
            return fail(PhysicsError::BadShape, "the backend could not build a static piece");
        }
        for piece in &valid.pieces {
            let tag = self.new_tag(&piece.key);
            self.static_tags.insert(piece.key.clone(), tag);
            if self.backend.insert(&piece.spec, tag).is_err() {
                return fail(PhysicsError::Internal, "the backend refused a piece it had accepted");
            }
        }
        self.ledger.add_static(valid.pieces.len(), bytes);
        self.static_canon = Some(valid.canon);
        self.static_world = Some(world.clone());
        Ok(())
    }
}

/// Whether a body with colliders of `groups` interacts with the push's `filter` (§6.2's rule:
/// each side's member groups meet the other's collides groups); no filter selects every body.
fn groups_match(groups: &[(u16, u16)], filter: Option<(u16, u16)>) -> bool {
    let Some((member, collides)) = filter else { return true };
    groups.iter().any(|(m, c)| m & collides != 0 && member & c != 0)
}

/// The impulse on a body at `origin`, or `None` outside the radius or at the centre exactly.
fn push_impulse(push: &AreaPush, origin: [f32; 3]) -> Option<[f32; 3]> {
    let delta = [0, 1, 2].map(|i| origin[i] - push.center[i]);
    let distance = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
    if distance == 0.0 || distance > push.radius {
        return None;
    }
    let magnitude = push.strength * libm::powf(1.0 - distance / push.radius, push.falloff);
    Some(delta.map(|d| d / distance * magnitude))
}
