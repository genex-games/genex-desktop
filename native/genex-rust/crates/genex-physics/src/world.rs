//! [`World`]: one physics world, the Rust binding's entry point (CONTRACT.md §15). Every method
//! returns a value; none panics on any input (§1.5).
//!
//! # If the core fails (§11.3)
//!
//! Every call runs inside `catch_unwind`. Should the backend ever panic (a bug), a native build
//! catches it, poisons the world and returns `internal`; from then on every call that returns a
//! `Result` returns `internal`, [`World::check`] says so, and the reads with no error channel
//! (`body`, `bodies`, `export_changed`, `export_body_state`, `stats`, the hashes) return their
//! empty forms without touching the failed core. A WASM build aborts on a panic instead, and the
//! binding answers `internal` for the instance. A snapshot that panics the backend while it is
//! read back is `BadSnapshot`, and the world is unchanged.
//!
//! # Memory (§11.1)
//!
//! Each world holds an account with [`crate::accounting`]: its calls that change the world (create,
//! every command, `step`, queries, `restore`) charge their allocations to it. When the binary
//! installed [`crate::accounting::CountingAllocator`], `memory_bytes`, `stats().memoryBytes` and
//! `memoryExceeded` report the bytes the world's live allocations asked for. A native binary that
//! did not install it reports the core's fixed per-object model (`memory`), the same on every
//! target. `LimitMemory` refusals follow the model in both (see the crate docs).

use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};

use serde_json::Value;

use crate::accounting::Account;
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
    /// Set when the core panicked: every later call is `internal` (§11.3).
    poisoned: Cell<bool>,
    /// The world's allocator account (§11.1). Declared last, so it is given back after the core's
    /// memory has been freed and credited to it.
    account: Account,
}

fn internal(detail: &str) -> PhysicsFailure {
    PhysicsFailure::new(PhysicsError::Internal, detail)
}

const POISONED: &str = "the world failed earlier and is unusable (§11.3)";

impl World {
    /// Validates `desc` and makes a world (§4); a failure creates nothing.
    pub fn create(desc: &WorldDesc) -> Result<World, PhysicsFailure> {
        let resolved = ResolvedWorldDesc::resolve(desc)?;
        let account = Account::open();
        let core = {
            let _scope = account.enter();
            catch_unwind(|| Core::new(resolved)).map_err(|_| internal("the backend failed to make a world"))?
        };
        Ok(World { core, step_ms: 0.0, poisoned: Cell::new(false), account })
    }

    /// `internal` when the world failed earlier (§11.3), else `Ok`.
    pub fn check(&self) -> Result<(), PhysicsFailure> {
        match self.poisoned.get() {
            true => Err(internal(POISONED)),
            false => Ok(()),
        }
    }

    /// Runs `f` on the core as one call that may change the world: charged to the world's account,
    /// and caught if it panics. A panic or an `internal` failure
    /// (a backend that refused what it had accepted) poisons the world (§11.3).
    fn call<T>(&mut self, f: impl FnOnce(&mut Core<ActiveBackend>) -> Result<T, PhysicsFailure>) -> Result<T, PhysicsFailure> {
        self.check()?;
        let _scope = self.account.enter();
        let core = &mut self.core;
        let outcome = catch_unwind(AssertUnwindSafe(move || f(core)));
        let result = outcome.unwrap_or_else(|_| Err(internal("the backend failed; the world is now unusable (§11.3)")));
        if result.as_ref().is_err_and(|failure| failure.code == PhysicsError::Internal) {
            self.poisoned.set(true);
        }
        result
    }

    /// Runs a read that has no error channel: `empty` once the world is poisoned or if it panics.
    fn read<T>(&self, empty: T, f: impl FnOnce(&Core<ActiveBackend>) -> T) -> T {
        if self.poisoned.get() {
            return empty;
        }
        match catch_unwind(AssertUnwindSafe(|| f(&self.core))) {
            Ok(value) => value,
            Err(_) => {
                self.poisoned.set(true);
                empty
            }
        }
    }

    /// The resolved description, every default filled (§4). It is fixed when the world is made (or
    /// restored), so it stays readable on a poisoned world, the one read exempt from §11.3.
    pub fn desc(&self) -> &ResolvedWorldDesc {
        self.core.desc()
    }

    /// The tick counter: 0 until the first step, and 0 on a poisoned world.
    pub fn tick(&self) -> u64 {
        self.read(0, Core::tick)
    }

    /// Inserts a body and its colliders (§6.1, §7).
    pub fn spawn(&mut self, desc: &BodyDesc) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::Spawn(desc.clone())))
    }

    /// Removes a body, its colliders and every joint that references it (§7).
    pub fn remove(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::Remove { key: key.to_string() }))
    }

    /// Adds a joint (§6.4, §7).
    pub fn add_joint(&mut self, desc: &JointDesc) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::AddJoint(desc.clone())))
    }

    /// Removes a joint (§7).
    pub fn remove_joint(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::RemoveJoint { key: key.to_string() }))
    }

    /// A linear impulse on a dynamic body, with torque when `at` (a world point) is given; wakes it.
    pub fn impulse(&mut self, key: &str, j: Vec3, at: Option<Vec3>) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::Impulse { key: key.to_string(), j, at }))
    }

    /// Sets a dynamic body's velocities; wakes it.
    pub fn set_velocity(&mut self, key: &str, linvel: Option<Vec3>, angvel: Option<Vec3>) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::SetVelocity { key: key.to_string(), linvel, angvel }))
    }

    /// Teleports a dynamic or fixed body (§7); puts an escaped body back (§8.2).
    pub fn set_pose(&mut self, key: &str, pose: Pose, options: SetPoseOptions) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::SetPose { key: key.to_string(), pose, options }))
    }

    /// A kinematic body's target pose at the end of the next step (§7.2).
    pub fn set_next_kinematic_pose(&mut self, key: &str, pose: Pose) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::SetNextKinematicPose { key: key.to_string(), pose }))
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
        self.call(|core| core.run(&Command::AreaPush { center, radius, strength, falloff, groups }))
    }

    /// Replaces a joint's motor (§7).
    pub fn set_motor(&mut self, key: &str, motor: Motor) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::SetMotor { key: key.to_string(), motor }))
    }

    /// Wakes a body (§7).
    pub fn wake(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::Wake { key: key.to_string() }))
    }

    /// Puts a body to sleep (§7).
    pub fn sleep(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(&Command::Sleep { key: key.to_string() }))
    }

    /// Applies one command (§7).
    pub fn command(&mut self, command: &Command) -> Result<(), PhysicsFailure> {
        self.call(|core| core.run(command))
    }

    /// Applies every command or none (§7.1); a failure names the first failing index.
    pub fn apply_atomic(&mut self, commands: &[Command]) -> Result<(), PhysicsFailure> {
        self.call(|core| core.apply_atomic(commands.iter().map(Ok)))
    }

    /// Applies every command that succeeds, in order, one outcome per command (§7.1).
    pub fn apply_each(&mut self, commands: &[Command]) -> Vec<CommandOutcome> {
        commands.iter().map(|command| self.command(command).map_err(|failure| failure.code)).collect()
    }

    /// [`World::apply_atomic`] over a JSON array of commands (§7.3); the batch fails at its first
    /// failing index, with `BadCommand` for a malformed command there, and a non-array fails with
    /// `BadCommand` alone.
    pub fn apply_json_atomic(&mut self, commands: &Value) -> Result<(), PhysicsFailure> {
        self.check()?;
        let items = json_items(commands)?;
        let parsed: Vec<Result<Command, PhysicsFailure>> = items.iter().map(Command::from_json).collect();
        self.call(|core| core.apply_atomic(parsed.iter().map(|command| command.as_ref().map_err(Clone::clone))))
    }

    /// [`World::apply_each`] over a JSON array of commands (§7.3); a malformed command's outcome
    /// is `BadCommand`, and a non-array fails with `BadCommand` alone.
    pub fn apply_json_each(&mut self, commands: &Value) -> Result<Vec<CommandOutcome>, PhysicsFailure> {
        self.check()?;
        let items = json_items(commands)?;
        let mut run = |item: &Value| Command::from_json(item).and_then(|command| self.command(&command));
        Ok(items.iter().map(|item| run(item).map_err(|failure| failure.code)).collect())
    }

    /// Imports PROTOCOL §17.7's static world, once, in a z-up world (§6.5).
    pub fn add_static_world(&mut self, world: &StaticWorld) -> Result<(), PhysicsFailure> {
        self.call(|core| core.add_static_world(world))
    }

    /// The number of joints.
    pub fn joint_count(&self) -> usize {
        self.read(0, Core::joint_count)
    }

    /// Advances `dt` in `substeps` inner steps (§8). Fails only with `internal` (§11.3).
    /// `memoryExceeded` compares the same bytes `memory_bytes` reports.
    pub fn step(&mut self) -> Result<StepResult, PhysicsFailure> {
        let mut result = self.call(|core| Ok(core.step()))?;
        if let Some(measured) = self.account.live_bytes() {
            result.memory_exceeded = measured > u64::from(self.core.desc().limits.memory_bytes);
        }
        Ok(result)
    }

    /// The whole world as bytes (§9.4): the GXPH header, then the resolved description, the static
    /// world and every body, collider and joint, solver caches included. Restoring it, on any
    /// target of the same build, steps on bit for bit.
    pub fn snapshot(&self) -> Result<Vec<u8>, PhysicsFailure> {
        self.check()?;
        self.read(Err(internal(POISONED)), Core::snapshot)
    }

    /// Replaces the whole world, its description and limits included, from a snapshot (§9.4):
    /// `BadSnapshot` for a wrong magic, a truncated input, a bad checksum or a payload no world
    /// could hold, `BuildMismatch` for another build, `LimitMemory` when the world would not fit its
    /// own `limits.memoryBytes`. On failure the world is unchanged.
    pub fn restore(&mut self, bytes: &[u8]) -> Result<(), PhysicsFailure> {
        self.call(|core| {
            let restored = catch_unwind(AssertUnwindSafe(|| Core::restore(bytes)));
            *core = restored.map_err(|_| PhysicsFailure::new(PhysicsError::BadSnapshot, "the snapshot's state could not be read"))??;
            Ok(())
        })?;
        self.step_ms = 0.0;
        Ok(())
    }

    /// Records the wall time a binding measured around the last `step()`, which `stats().stepMs`
    /// reports for display (§11.4). The core never reads a clock, so it is 0 until a binding
    /// records one; a negative or non-finite value is refused and changes nothing.
    pub fn record_step_ms(&mut self, ms: f64) -> Result<(), PhysicsFailure> {
        self.check()?;
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
        self.read(None, |core| core.body(key))
    }

    /// The bodies `filter` selects, in key order (§9.1).
    pub fn bodies(&self, filter: &BodyFilter) -> Vec<BodyState> {
        self.read(Vec::new(), |core| core.bodies(filter))
    }

    /// The bodies changed after `since_tick`, flat: 14 numbers per body in key order (§9.1).
    pub fn export_changed(&self, since_tick: u64) -> ChangedExport {
        let empty = ChangedExport { keys: Vec::new(), data: Vec::new() };
        self.read(empty, |core| core.export_changed(since_tick))
    }

    /// A body's replicated fields (§9.2), or `None`.
    pub fn export_body_state(&self, key: &str) -> Option<NetBodyState> {
        self.read(None, |core| core.export_body_state(key))
    }

    /// Sets a dynamic or kinematic body's replicated fields and its sleep state (§9.2).
    pub fn import_body_state(&mut self, key: &str, state: &NetBodyState) -> Result<(), PhysicsFailure> {
        self.call(|core| core.import_body_state(key, state))
    }

    /// The world's counters (§11); `memoryBytes` as [`World::memory_bytes`] reports it.
    pub fn stats(&self) -> Stats {
        let mut stats = self.read(Stats::default(), |core| core.stats(self.step_ms));
        stats.memory_bytes = self.memory_bytes();
        stats
    }

    /// The nearest hit along a ray (§13); counts toward `limits.queriesPerStep`.
    pub fn ray(&mut self, origin: Vec3, dir: Vec3, max_dist: f64, filter: &QueryFilter) -> Result<Option<Hit>, PhysicsFailure> {
        self.call(|core| core.ray(origin, dir, max_dist, filter))
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
        self.call(|core| core.shape_cast(shape, &pose, dir, max_dist, filter))
    }

    /// The bodies a shape overlaps, in key order, each once (§13).
    pub fn overlap(&mut self, shape: &Shape, pose: Pose, filter: &QueryFilter) -> Result<Vec<String>, PhysicsFailure> {
        self.call(|core| core.overlap(shape, &pose, filter))
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
        self.check()?;
        let query = Query::from_json(query)?;
        self.query(&query)
    }

    /// The state hash (§10.1).
    pub fn state_hash(&self) -> u64 {
        self.read(0, Core::state_hash)
    }

    /// The state hash as 16 lowercase hex digits, its JSON form (§10.1).
    pub fn state_hash_hex(&self) -> String {
        hex16(self.state_hash())
    }

    /// The canonical JSON `physicsHash` covers (§10.2).
    pub fn physics_json(&self) -> String {
        self.read(String::new(), Core::physics_json)
    }

    /// `physicsHash` (§10.2): 16 lowercase hex digits.
    pub fn physics_hash(&self) -> String {
        self.read(String::new(), Core::physics_hash)
    }

    /// Whether a counting allocator measures this world's memory (§11.1): `false` in a binary that
    /// did not install [`crate::accounting::CountingAllocator`], or past
    /// [`crate::accounting::ACCOUNT_SLOTS`] worlds at once, where `memory_bytes` is the model.
    pub fn memory_is_measured(&self) -> bool {
        self.account.live_bytes().is_some()
    }

    /// The world's accounted memory in bytes (§11.1), as `stats().memoryBytes` reports it: measured
    /// when the binary installed the counting allocator, else the core's model.
    pub fn memory_bytes(&self) -> u64 {
        self.account.live_bytes().unwrap_or_else(|| self.read(0, Core::memory_bytes))
    }
}

fn json_items(commands: &Value) -> Result<&Vec<Value>, PhysicsFailure> {
    match commands.as_array() {
        Some(items) => Ok(items),
        None => fail(PhysicsError::BadCommand, "a batch is a JSON array of commands"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::ColliderDesc;
    use crate::state::NetBodyState;
    use crate::types::{BodyType, UpAxis};

    fn crate_at(key: &str, y: f64) -> BodyDesc {
        let shape = Shape::Box { half: [0.5; 3] };
        BodyDesc::new(key, BodyType::Dynamic, Pose::at([0.0, y, 0.0]), vec![ColliderDesc::new("c", shape)])
    }

    fn is_internal<T: std::fmt::Debug>(result: Result<T, PhysicsFailure>) -> bool {
        matches!(result, Err(PhysicsFailure { code: PhysicsError::Internal, .. }))
    }

    /// The fault injection: a backend call that panics inside the world's guard, as a backend bug would.
    fn fail_inside(world: &mut World) -> Result<(), PhysicsFailure> {
        world.call(|_core| -> Result<(), PhysicsFailure> { panic!("an injected backend failure") })
    }

    #[test]
    fn a_backend_panic_poisons_the_world_and_every_later_call_is_internal() {
        let mut world = World::create(&WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)).expect("world");
        world.spawn(&crate_at("a", 2.0)).expect("spawns");
        world.step().expect("steps");
        let snapshot = world.snapshot().expect("snapshots");
        world.check().expect("healthy before the failure");

        assert!(is_internal(fail_inside(&mut world)), "the panic is caught and reported as internal");
        assert!(is_internal(world.check()));
        let net = NetBodyState { p: [0.0; 3], q: [0.0, 0.0, 0.0, 1.0], v: [0.0; 3], w: [0.0; 3], sleeping: false };
        let filter = QueryFilter::default();
        assert!(is_internal(world.spawn(&crate_at("b", 4.0))));
        assert!(is_internal(world.remove("a")));
        assert!(is_internal(world.step()));
        assert!(is_internal(world.wake("a")));
        assert!(is_internal(world.apply_atomic(&[Command::Remove { key: "a".into() }])));
        assert_eq!(world.apply_each(&[Command::Remove { key: "a".into() }]), vec![Err(PhysicsError::Internal)]);
        assert!(is_internal(world.import_body_state("a", &net)));
        assert!(is_internal(world.ray([0.0, 5.0, 0.0], [0.0, -1.0, 0.0], 10.0, &filter)));
        assert!(is_internal(world.add_static_world(&StaticWorld::default())));
        assert!(is_internal(world.record_step_ms(1.0)));
        assert!(is_internal(world.snapshot()));
        assert!(is_internal(world.restore(&snapshot)), "not even a good snapshot revives it");
        assert!(world.body("a").is_none() && world.bodies(&BodyFilter::default()).is_empty());
        assert!(world.export_body_state("a").is_none() && world.export_changed(0).keys.is_empty());
        assert_eq!((world.state_hash(), world.physics_hash(), world.joint_count()), (0, String::new(), 0));
        assert_eq!(world.stats().bodies, 0);
        assert!(is_internal(world.apply_json_atomic(&serde_json::json!("not a batch"))), "internal before parsing");
        assert!(is_internal(world.apply_json_each(&serde_json::json!([{ "nope": {} }]))));
        assert!(is_internal(world.query_json(&serde_json::json!({ "nope": {} }))));
        assert_eq!(world.tick(), 0, "tick is a read with no error channel");
    }

    #[test]
    fn a_backend_refusal_after_its_check_poisons_the_world_as_a_panic_does() {
        let mut world = World::create(&WorldDesc::new(1.0 / 60.0, 1.0, [0.0, -9.81, 0.0], UpAxis::Y, 1.0)).expect("world");
        let refused = world.call(|_core| fail::<()>(PhysicsError::Internal, "an injected refusal"));
        assert!(is_internal(refused));
        assert!(is_internal(world.check()), "an internal failure leaves the world unusable (§11.3)");
        assert!(is_internal(world.spawn(&crate_at("a", 1.0))));
    }
}
