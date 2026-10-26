//! [`World`]: one physics world, the Rust binding's entry point (CONTRACT.md §15). Every method
//! returns a value; none panics on any input (§1.5).

use serde_json::Value;

use crate::backend::ActiveBackend;
use crate::body::{BodyDesc, Groups, Shape};
use crate::command::{Command, CommandOutcome, SetPoseOptions};
use crate::core::Core;
use crate::error::{PhysicsError, PhysicsFailure, fail};
use crate::hash::hex16;
use crate::joint::{JointDesc, Motor};
use crate::query::{Hit, Query, QueryAnswer, QueryFilter};
use crate::state::{BodyFilter, BodyState, ChangedExport, NetBodyState, Stats, StepResult};
use crate::static_world::StaticWorld;
use crate::types::{Pose, Vec3};
use crate::world_desc::{ResolvedWorldDesc, WorldDesc};

/// One physics world: single-threaded, deterministic per `buildId`, addressed by caller keys.
pub struct World {
    core: Core<ActiveBackend>,
    /// The binding's own measure of the last step's wall time, for `stats().stepMs` only (§11.4).
    step_ms: f64,
}


impl World {
    /// Validates `desc` and makes a world (§4); a failure creates nothing.
    pub fn create(desc: &WorldDesc) -> Result<World, PhysicsFailure> {
        let resolved = ResolvedWorldDesc::resolve(desc)?;
        Ok(World { core: Core::new(resolved), step_ms: 0.0 })
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
        self.core.run(&Command::Spawn(desc.clone()))
    }

    /// Removes a body, its colliders and every joint that references it (§7).
    pub fn remove(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::Remove { key: key.to_string() })
    }

    /// Adds a joint (§6.4, §7).
    pub fn add_joint(&mut self, desc: &JointDesc) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::AddJoint(desc.clone()))
    }

    /// Removes a joint (§7).
    pub fn remove_joint(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::RemoveJoint { key: key.to_string() })
    }

    /// A linear impulse on a dynamic body, with torque when `at` (a world point) is given; wakes it.
    pub fn impulse(&mut self, key: &str, j: Vec3, at: Option<Vec3>) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::Impulse { key: key.to_string(), j, at })
    }

    /// Sets a dynamic body's velocities; wakes it.
    pub fn set_velocity(&mut self, key: &str, linvel: Option<Vec3>, angvel: Option<Vec3>) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::SetVelocity { key: key.to_string(), linvel, angvel })
    }

    /// Teleports a dynamic or fixed body (§7); puts an escaped body back (§8.2).
    pub fn set_pose(&mut self, key: &str, pose: Pose, options: SetPoseOptions) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::SetPose { key: key.to_string(), pose, options })
    }

    /// A kinematic body's target pose at the end of the next step (§7.2).
    pub fn set_next_kinematic_pose(&mut self, key: &str, pose: Pose) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::SetNextKinematicPose { key: key.to_string(), pose })
    }

    /// An impulse on every dynamic body whose origin lies within `radius` of `center` (§7).
    pub fn area_push(
        &mut self,
        center: Vec3,
        radius: f64,
        strength: f64,
        falloff: f64,
        groups: Option<Groups>,
    ) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::AreaPush { center, radius, strength, falloff, groups })
    }

    /// Replaces a joint's motor (§7).
    pub fn set_motor(&mut self, key: &str, motor: Motor) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::SetMotor { key: key.to_string(), motor })
    }

    /// Wakes a body (§7).
    pub fn wake(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::Wake { key: key.to_string() })
    }

    /// Puts a body to sleep (§7).
    pub fn sleep(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.core.run(&Command::Sleep { key: key.to_string() })
    }

    /// Applies one command (§7).
    pub fn command(&mut self, command: &Command) -> Result<(), PhysicsFailure> {
        self.core.run(command)
    }

    /// Applies every command or none (§7.1); a failure names the first failing index.
    pub fn apply_atomic(&mut self, commands: &[Command]) -> Result<(), PhysicsFailure> {
        self.core.apply_atomic(commands)
    }

    /// Applies every command that succeeds, in order, one outcome per command (§7.1).
    pub fn apply_each(&mut self, commands: &[Command]) -> Vec<CommandOutcome> {
        self.core.apply_each(commands)
    }

    /// [`World::apply_atomic`] over a JSON array of commands (§7.3); a malformed command fails
    /// the batch with `BadCommand` at its index, and a non-array with `BadCommand` alone.
    pub fn apply_json_atomic(&mut self, commands: &Value) -> Result<(), PhysicsFailure> {
        let items = json_items(commands)?;
        let parsed = items.iter().enumerate().map(|(index, item)| Command::from_json(item).map_err(|f| f.at(index)));
        let commands = parsed.collect::<Result<Vec<_>, _>>()?;
        self.core.apply_atomic(&commands)
    }

    /// [`World::apply_each`] over a JSON array of commands (§7.3); a malformed command's outcome
    /// is `BadCommand`, and a non-array fails with `BadCommand` alone.
    pub fn apply_json_each(&mut self, commands: &Value) -> Result<Vec<CommandOutcome>, PhysicsFailure> {
        let items = json_items(commands)?;
        let mut run = |item: &Value| Command::from_json(item).and_then(|command| self.core.run(&command));
        Ok(items.iter().map(|item| run(item).map_err(|failure| failure.code)).collect())
    }

    /// Imports PROTOCOL §17.7's static world, once, in a z-up world (§6.5).
    pub fn add_static_world(&mut self, world: &StaticWorld) -> Result<(), PhysicsFailure> {
        self.core.add_static_world(world)
    }

    /// The number of joints.
    pub fn joint_count(&self) -> usize {
        self.core.joint_count()
    }

    /// Advances `dt` in `substeps` inner steps (§8). Fails only with `internal` (§11.3).
    pub fn step(&mut self) -> Result<StepResult, PhysicsFailure> {
        Ok(self.core.step())
    }

    /// Records the wall time a binding measured around the last `step()`, which `stats().stepMs`
    /// reports for display (§11.4). The core never reads a clock, so it is 0 until a binding
    /// records one; a negative or non-finite value is refused and changes nothing.
    pub fn record_step_ms(&mut self, ms: f64) -> Result<(), PhysicsFailure> {
        if !ms.is_finite() {
            return fail(PhysicsError::NonFinite, "stepMs is not finite");
        }
        if ms < 0.0 {
            return fail(PhysicsError::OutOfRange, "stepMs is negative");
        }
        self.step_ms = ms;
        Ok(())
    }

    /// One body's state in the caller frame, or `None` (§9.1).
    pub fn body(&self, key: &str) -> Option<BodyState> {
        self.core.body(key)
    }

    /// The bodies `filter` selects, in key order (§9.1).
    pub fn bodies(&self, filter: &BodyFilter) -> Vec<BodyState> {
        self.core.bodies(filter)
    }

    /// The bodies changed after `since_tick`, flat: 14 numbers per body in key order (§9.1).
    pub fn export_changed(&self, since_tick: u64) -> ChangedExport {
        self.core.export_changed(since_tick)
    }

    /// A body's replicated fields (§9.2), or `None`.
    pub fn export_body_state(&self, key: &str) -> Option<NetBodyState> {
        self.core.export_body_state(key)
    }

    /// Sets a dynamic or kinematic body's replicated fields and its sleep state (§9.2).
    pub fn import_body_state(&mut self, key: &str, state: &NetBodyState) -> Result<(), PhysicsFailure> {
        self.core.import_body_state(key, state)
    }

    /// The world's counters (§11).
    pub fn stats(&self) -> Stats {
        self.core.stats(self.step_ms)
    }

    /// The nearest hit along a ray (§13); counts toward `limits.queriesPerStep`.
    pub fn ray(&mut self, origin: Vec3, dir: Vec3, max_dist: f64, filter: &QueryFilter) -> Result<Option<Hit>, PhysicsFailure> {
        self.core.ray(origin, dir, max_dist, filter)
    }

    /// The first hit of a swept box, sphere, capsule or hull (§13).
    pub fn shape_cast(
        &mut self,
        shape: &Shape,
        pose: Pose,
        dir: Vec3,
        max_dist: f64,
        filter: &QueryFilter,
    ) -> Result<Option<Hit>, PhysicsFailure> {
        self.core.shape_cast(shape, &pose, dir, max_dist, filter)
    }

    /// The bodies a shape overlaps, in key order, each once (§13).
    pub fn overlap(&mut self, shape: &Shape, pose: Pose, filter: &QueryFilter) -> Result<Vec<String>, PhysicsFailure> {
        self.core.overlap(shape, &pose, filter)
    }

    /// Runs one query (§13).
    pub fn query(&mut self, query: &Query) -> Result<QueryAnswer, PhysicsFailure> {
        match query {
            Query::Ray { origin, dir, max_dist, filter } => self.ray(*origin, *dir, *max_dist, filter).map(QueryAnswer::Hit),
            Query::ShapeCast { shape, pose, dir, max_dist, filter } => {
                self.shape_cast(shape, *pose, *dir, *max_dist, filter).map(QueryAnswer::Hit)
            }
            Query::Overlap { shape, pose, filter } => self.overlap(shape, *pose, filter).map(QueryAnswer::Keys),
        }
    }

    /// Runs one query in its JSON form (§13); a malformed one gives `BadCommand`.
    pub fn query_json(&mut self, query: &Value) -> Result<QueryAnswer, PhysicsFailure> {
        let query = Query::from_json(query)?;
        self.query(&query)
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

fn json_items(commands: &Value) -> Result<&Vec<Value>, PhysicsFailure> {
    match commands.as_array() {
        Some(items) => Ok(items),
        None => fail(PhysicsError::BadCommand, "a batch is a JSON array of commands"),
    }
}
