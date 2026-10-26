//! The ledger: everything a command's acceptance depends on (keys, body and joint types, counts
//! and memory), kept apart from the backend so an atomic batch (§7.1) can be judged on a copy
//! before anything is applied. A command checked against the ledger cannot fail when applied.
//!
//! Memory (§11.1) is the objects' modelled bytes plus the contact pairs counted at the end of the
//! last step, so a refusal never depends on where in a batch a removal freed contacts.

use std::collections::BTreeMap;

use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::joint::JointType;
use crate::memory::WORLD_BASE_BYTES;
use crate::types::BodyType;

/// What the ledger keeps per body.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BodyFacts {
    pub body_type: BodyType,
    pub ccd: bool,
    pub triangles: usize,
    pub bytes: u64,
}

/// What the ledger keeps per joint.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JointFacts {
    pub a: String,
    pub b: Option<String>,
    pub joint_type: JointType,
    pub bytes: u64,
}

/// Keys, types, counts and memory of one world.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Ledger {
    pub bodies: BTreeMap<String, BodyFacts>,
    pub joints: BTreeMap<String, JointFacts>,
    pub triangles: usize,
    pub ccd_bodies: usize,
    pub static_pieces: usize,
    pub static_added: bool,
    /// Every object's modelled bytes, the world's base included.
    pub object_bytes: u64,
    /// The contact pairs' modelled bytes at the end of the last step.
    pub contact_bytes: u64,
}

impl Ledger {
    /// An empty world's ledger.
    pub(crate) fn new() -> Self {
        Self {
            bodies: BTreeMap::new(),
            joints: BTreeMap::new(),
            triangles: 0,
            ccd_bodies: 0,
            static_pieces: 0,
            static_added: false,
            object_bytes: WORLD_BASE_BYTES,
            contact_bytes: 0,
        }
    }

    /// The world's accounted memory (§11.1).
    pub(crate) fn memory(&self) -> u64 {
        self.object_bytes + self.contact_bytes
    }

    /// Refuses `LimitMemory` unless `bytes` more fit within `limit`.
    pub(crate) fn admit(&self, bytes: u64, limit: u32) -> Result<(), PhysicsFailure> {
        if self.memory() + bytes > u64::from(limit) {
            return fail(PhysicsError::LimitMemory, "the command would take the world past limits.memoryBytes");
        }
        Ok(())
    }

    /// A body's type, or `UnknownKey`.
    pub(crate) fn body_type(&self, key: &str) -> Result<BodyType, PhysicsFailure> {
        match self.bodies.get(key) {
            Some(facts) => Ok(facts.body_type),
            None => fail(PhysicsError::UnknownKey, "no body has that key"),
        }
    }

    /// A body's type if it is one of `allowed`, else `UnknownKey` or `WrongBodyType`.
    pub(crate) fn body_of_type(&self, key: &str, allowed: &[BodyType]) -> Result<BodyType, PhysicsFailure> {
        let body_type = self.body_type(key)?;
        if !allowed.contains(&body_type) {
            return fail(PhysicsError::WrongBodyType, format!("the command is not for a {} body", body_type.name()));
        }
        Ok(body_type)
    }

    /// A joint's facts, or `UnknownKey`.
    pub(crate) fn joint(&self, key: &str) -> Result<&JointFacts, PhysicsFailure> {
        self.joints.get(key).ok_or_else(|| PhysicsFailure::new(PhysicsError::UnknownKey, "no joint has that key"))
    }

    /// Records a new body.
    pub(crate) fn add_body(&mut self, key: &str, facts: BodyFacts) {
        self.triangles += facts.triangles;
        self.ccd_bodies += usize::from(facts.ccd);
        self.object_bytes += facts.bytes;
        self.bodies.insert(key.to_string(), facts);
    }

    /// Forgets a body and every joint that references it; returns those joints' keys, in key order.
    pub(crate) fn remove_body(&mut self, key: &str) -> Vec<String> {
        let joints: Vec<String> = self
            .joints
            .iter()
            .filter(|(_, joint)| joint.a == key || joint.b.as_deref() == Some(key))
            .map(|(joint_key, _)| joint_key.clone())
            .collect();
        for joint in &joints {
            self.remove_joint(joint);
        }
        if let Some(facts) = self.bodies.remove(key) {
            self.triangles -= facts.triangles;
            self.ccd_bodies -= usize::from(facts.ccd);
            self.object_bytes -= facts.bytes;
        }
        joints
    }

    /// Records a new joint.
    pub(crate) fn add_joint(&mut self, key: &str, facts: JointFacts) {
        self.object_bytes += facts.bytes;
        self.joints.insert(key.to_string(), facts);
    }

    /// Forgets a joint.
    pub(crate) fn remove_joint(&mut self, key: &str) {
        if let Some(facts) = self.joints.remove(key) {
            self.object_bytes -= facts.bytes;
        }
    }

    /// Records the static world: its pieces and their bytes.
    pub(crate) fn add_static(&mut self, pieces: usize, bytes: u64) {
        self.static_added = true;
        self.static_pieces = pieces;
        self.object_bytes += bytes;
    }
}
