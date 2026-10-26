//! [`World`]: one physics world, the Rust binding's entry point (CONTRACT.md §15). Every method
//! returns a value; none panics on any input (§1.5).

use crate::backend::ActiveBackend;
use crate::body::BodyDesc;
use crate::core::Core;
use crate::error::PhysicsFailure;
use crate::hash::hex16;
use crate::state::{BodyFilter, BodyState, StepResult};
use crate::world_desc::{ResolvedWorldDesc, WorldDesc};

/// One physics world: single-threaded, deterministic per `buildId`, addressed by caller keys.
pub struct World {
    core: Core<ActiveBackend>,
}

impl World {
    /// Validates `desc` and makes a world (§4); a failure creates nothing.
    pub fn create(desc: &WorldDesc) -> Result<World, PhysicsFailure> {
        let resolved = ResolvedWorldDesc::resolve(desc)?;
        Ok(World { core: Core::new(resolved) })
    }

    /// The resolved description, every default filled (§4).
    pub fn desc(&self) -> &ResolvedWorldDesc {
        self.core.desc()
    }

    /// The tick counter: 0 until the first step.
    pub fn tick(&self) -> u64 {
        self.core.tick()
    }

    /// Inserts a body and its colliders (§6.1, §7).
    pub fn spawn(&mut self, desc: &BodyDesc) -> Result<(), PhysicsFailure> {
        self.core.spawn(desc)
    }

    /// Removes a body and its colliders (§7).
    pub fn remove(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.core.remove(key)
    }

    /// Advances `dt` in `substeps` inner steps (§8). Fails only with `internal` (§11.3).
    pub fn step(&mut self) -> Result<StepResult, PhysicsFailure> {
        Ok(self.core.step())
    }

    /// One body's state in the caller frame, or `None` (§9.1).
    pub fn body(&self, key: &str) -> Option<BodyState> {
        self.core.body(key)
    }

    /// The bodies `filter` selects, in key order (§9.1).
    pub fn bodies(&self, filter: &BodyFilter) -> Vec<BodyState> {
        self.core.bodies(filter)
    }

    /// The state hash (§10.1).
    pub fn state_hash(&self) -> u64 {
        self.core.state_hash()
    }

    /// The state hash as 16 lowercase hex digits, its JSON form (§10.1).
    pub fn state_hash_hex(&self) -> String {
        hex16(self.core.state_hash())
    }

    /// The canonical JSON `physicsHash` covers (§10.2).
    pub fn physics_json(&self) -> String {
        self.core.physics_json()
    }

    /// `physicsHash` (§10.2): 16 lowercase hex digits.
    pub fn physics_hash(&self) -> String {
        self.core.physics_hash()
    }

    /// The world's accounted memory in bytes (§11.1), as `stats().memoryBytes` reports it.
    pub fn memory_bytes(&self) -> u64 {
        self.core.memory_bytes()
    }
}
