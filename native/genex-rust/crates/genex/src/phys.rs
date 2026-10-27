//! Genex Physics on the facade (shared physics P4): `sim.physics` is a [`Physics`], one Genex
//! Physics world (`genex-physics`, contract 1.0) that the runtime steps once per tick, after the
//! update and UI hooks. Bodies, colliders and joints are named by the game's own string keys;
//! commands and queries answer a typed [`PhysicsFailure`] instead of panicking, and the world is
//! deterministic per build (`state_hash`).
//!
//! The vocabulary is the contract's: [`BodyDesc`], [`ColliderDesc`], [`Shape`], [`JointDesc`],
//! [`Pose`] with `[f64; 3]` vectors and `[x, y, z, w]` quaternions. [`xyz`], [`pose`], [`vec3_of`]
//! and [`quat_of`] convert from and to the glam types the rest of the facade uses.
//!
//! The world a game gets is y-up, in metres, stepping at the fixed tick (1/60 s, one sub-step)
//! with gravity 9.81 m/s² down and the contract's default limits; `game.physics_world(desc)`
//! changes gravity, sub-steps, solver iterations and limits.
//!
//! Raw Rapier (deprecated): with the facade's `physics-raw` feature (on by default for one release)
//! `sim.physics` also dereferences to Rapier's `PhysicsWorld`, a second world the runtime steps
//! beside this one, so a game written against `genex::physics` / `genex::rapier3d` keeps compiling.
//! The two worlds never touch. The character controller, ragdolls, streamed colliders, terrain
//! tile colliders, navigation's collider input and audio occlusion still live in the raw world
//! (`docs/api/physics.md`, "What stays raw").

pub use genex_physics::{
    Axis, BodyDesc, BodyFilter, BodyState, BodyType, CONTRACT_VERSION, ChangedExport, ColliderDesc, Command, CommandOutcome, EXPORT_STRIDE, Groups, Hit,
    JointDesc, JointType, LimitsDesc, Motor, NetBodyState, PhysicsError, PhysicsEvent, PhysicsFailure, Pose, QUAT_IDENTITY, Query, QueryAnswer, QueryFilter,
    SetPoseOptions, Shape, SolverDesc, StaticWorld, Stats, StepResult, UpAxis, WorldDesc,
};

/// Numbers in one save row of a body (`Physics::export_row`): p(3), q(4), v(3), w(3).
pub const BODY_ROW_LEN: usize = 13;

/// Gravity of the world a game gets without `game.physics_world`, m/s² along -y.
pub const DEFAULT_GRAVITY: f64 = 9.81;

/// The world description a game gets without `game.physics_world`: y-up, metres, the fixed tick
/// (1/60 s) in one sub-step, gravity [`DEFAULT_GRAVITY`] down and the contract's default limits.
pub fn default_world() -> WorldDesc {
    WorldDesc::new(crate::FIXED_STEP_MS / 1000.0, 1.0, [0.0, -DEFAULT_GRAVITY, 0.0], UpAxis::Y, 1.0)
}

/// A glam vector as the contract's `[x, y, z]`.
pub fn xyz(v: glam::Vec3) -> [f64; 3] {
    [f64::from(v.x), f64::from(v.y), f64::from(v.z)]
}

/// A pose at `at` turned by `rotation` (glam), in the contract's form.
pub fn pose(at: glam::Vec3, rotation: glam::Quat) -> Pose {
    Pose { p: xyz(at), q: [f64::from(rotation.x), f64::from(rotation.y), f64::from(rotation.z), f64::from(rotation.w)] }
}

/// The contract's `[x, y, z]` as a glam vector (every number the core answers is an f32 value).
pub fn vec3_of(v: [f64; 3]) -> glam::Vec3 {
    glam::Vec3::new(v[0] as f32, v[1] as f32, v[2] as f32)
}

/// The contract's `[x, y, z, w]` as a glam quaternion.
pub fn quat_of(q: [f64; 4]) -> glam::Quat {
    glam::Quat::from_xyzw(q[0] as f32, q[1] as f32, q[2] as f32, q[3] as f32)
}

/// A box shape by its half extents.
pub fn cuboid(half: glam::Vec3) -> Shape {
    Shape::Box { half: xyz(half) }
}

/// A sphere shape.
pub fn ball(radius: f32) -> Shape {
    Shape::Sphere { radius: f64::from(radius) }
}

/// The physics every [`crate::Sim`] carries: one Genex Physics world (and, with `physics-raw`,
/// Rapier's world beside it). Empty after every seed; the runtime steps it once per tick.
pub struct Physics {
    world: genex_physics::World,
    last: StepResult,
    failure: Option<PhysicsFailure>,
    #[cfg(feature = "physics-raw")]
    raw: rapier3d::prelude::PhysicsWorld,
}

/// The step result before any step.
fn no_step() -> StepResult {
    StepResult { tick: 0, events: Vec::new(), overflowed: false, escaped: Vec::new(), memory_exceeded: false }
}

impl Physics {
    /// An empty world of `desc`; refused as the core refuses it (`World::create`).
    pub(crate) fn new(desc: &WorldDesc) -> Result<Physics, PhysicsFailure> {
        let world = genex_physics::World::create(desc)?;
        Ok(Physics { world, last: no_step(), failure: None, #[cfg(feature = "physics-raw")] raw: raw_world() })
    }

    /// One tick: the Genex world steps (and, with `physics-raw`, Rapier's world beside it). A step
    /// the core refuses (`internal`, a failed world) is kept in [`Physics::failure`].
    pub(crate) fn step(&mut self) {
        #[cfg(feature = "physics-raw")]
        self.raw.step();
        match self.world.step() {
            Ok(result) => self.last = result,
            Err(failure) => {
                self.last = StepResult { tick: self.world.tick(), ..no_step() };
                self.failure = Some(failure);
            }
        }
    }

    /// Why the last step failed (`internal`: the world is unusable until the next seed), or None.
    pub fn failure(&self) -> Option<&PhysicsFailure> {
        self.failure.as_ref()
    }

    /// The last step's contact and trigger events, in the contract's order (§8.1).
    pub fn events(&self) -> &[PhysicsEvent] {
        &self.last.events
    }

    /// Whether the last step dropped events past `limits.eventsPerStep`.
    pub fn events_overflowed(&self) -> bool {
        self.last.overflowed
    }

    /// Bodies that left `limits.worldExtent` (or went non-finite) on the last step: frozen until
    /// removed or put back with `set_pose` (§8.2).
    pub fn escaped(&self) -> &[String] {
        &self.last.escaped
    }

    /// Whether the last step ended over `limits.memoryBytes`.
    pub fn memory_exceeded(&self) -> bool {
        self.last.memory_exceeded
    }

    /// The resolved world description, every default filled.
    pub fn desc(&self) -> &genex_physics::ResolvedWorldDesc {
        self.world.desc()
    }

    /// Steps since the seed.
    pub fn tick(&self) -> u64 {
        self.world.tick()
    }

    /// Inserts a body and its colliders.
    pub fn spawn(&mut self, desc: &BodyDesc) -> Result<(), PhysicsFailure> {
        self.world.spawn(desc)
    }

    /// Removes a body, its colliders and every joint on it.
    pub fn remove(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.world.remove(key)
    }

    /// Adds a joint.
    pub fn add_joint(&mut self, desc: &JointDesc) -> Result<(), PhysicsFailure> {
        self.world.add_joint(desc)
    }

    /// Removes a joint.
    pub fn remove_joint(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.world.remove_joint(key)
    }

    /// A linear impulse on a dynamic body (kg·m/s), with torque when `at` is a world point; wakes it.
    pub fn impulse(&mut self, key: &str, j: [f64; 3], at: Option<[f64; 3]>) -> Result<(), PhysicsFailure> {
        self.world.impulse(key, j, at)
    }

    /// Sets a dynamic body's velocities; wakes it.
    pub fn set_velocity(&mut self, key: &str, linvel: Option<[f64; 3]>, angvel: Option<[f64; 3]>) -> Result<(), PhysicsFailure> {
        self.world.set_velocity(key, linvel, angvel)
    }

    /// Teleports a dynamic or fixed body.
    pub fn set_pose(&mut self, key: &str, pose: Pose, options: SetPoseOptions) -> Result<(), PhysicsFailure> {
        self.world.set_pose(key, pose, options)
    }

    /// Where a kinematic body is at the end of the next step.
    pub fn set_next_kinematic_pose(&mut self, key: &str, pose: Pose) -> Result<(), PhysicsFailure> {
        self.world.set_next_kinematic_pose(key, pose)
    }

    /// An impulse on every dynamic body whose origin is within `radius` of `center`:
    /// `strength · (1 − d/radius)^falloff` away from the centre, in key order.
    pub fn area_push(&mut self, center: [f64; 3], radius: f64, strength: f64, falloff: f64, groups: Option<Groups>) -> Result<(), PhysicsFailure> {
        self.world.area_push(center, radius, strength, falloff, groups)
    }

    /// Replaces a joint's motor.
    pub fn set_motor(&mut self, key: &str, motor: Motor) -> Result<(), PhysicsFailure> {
        self.world.set_motor(key, motor)
    }

    /// Wakes a body.
    pub fn wake(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.world.wake(key)
    }

    /// Puts a body to sleep.
    pub fn sleep(&mut self, key: &str) -> Result<(), PhysicsFailure> {
        self.world.sleep(key)
    }

    /// Applies one command.
    pub fn command(&mut self, command: &Command) -> Result<(), PhysicsFailure> {
        self.world.command(command)
    }

    /// Applies commands in order, all or none: a failure names its index.
    pub fn apply_atomic(&mut self, commands: &[Command]) -> Result<(), PhysicsFailure> {
        self.world.apply_atomic(commands)
    }

    /// Applies commands in order, each on its own: one outcome per command.
    pub fn apply_each(&mut self, commands: &[Command]) -> Vec<CommandOutcome> {
        self.world.apply_each(commands)
    }

    /// Adds PROTOCOL §17.7's static world (z-up worlds only).
    pub fn add_static_world(&mut self, world: &StaticWorld) -> Result<(), PhysicsFailure> {
        self.world.add_static_world(world)
    }

    /// One body's state, or None for a key no body has.
    pub fn body(&self, key: &str) -> Option<BodyState> {
        self.world.body(key)
    }

    /// The bodies `filter` names, in key order.
    pub fn bodies(&self, filter: &BodyFilter) -> Vec<BodyState> {
        self.world.bodies(filter)
    }

    /// The bodies changed after `since_tick`, flat: [`EXPORT_STRIDE`] numbers each.
    pub fn export_changed(&self, since_tick: u64) -> ChangedExport {
        self.world.export_changed(since_tick)
    }

    /// A body's replicated fields (pose, velocities, sleep).
    pub fn export_body_state(&self, key: &str) -> Option<NetBodyState> {
        self.world.export_body_state(key)
    }

    /// Sets a dynamic or kinematic body's replicated fields.
    pub fn import_body_state(&mut self, key: &str, state: &NetBodyState) -> Result<(), PhysicsFailure> {
        self.world.import_body_state(key, state)
    }

    /// A body's save row: p(3), q(4), v(3), w(3) from `export_body_state`, the 13 numbers a save
    /// section keeps per body.
    pub fn export_row(&self, key: &str) -> Option<[f32; BODY_ROW_LEN]> {
        let state = self.world.export_body_state(key)?;
        let numbers = state.p.iter().chain(&state.q).chain(&state.v).chain(&state.w);
        let mut row = [0.0; BODY_ROW_LEN];
        for (slot, number) in row.iter_mut().zip(numbers) {
            *slot = *number as f32;
        }
        Some(row)
    }

    /// Puts a body back from its save row (`import_body_state`), awake.
    pub fn import_row(&mut self, key: &str, row: &[f32; BODY_ROW_LEN]) -> Result<(), PhysicsFailure> {
        let at = |index: usize| f64::from(row[index]);
        let state = NetBodyState {
            p: [at(0), at(1), at(2)],
            q: [at(3), at(4), at(5), at(6)],
            v: [at(7), at(8), at(9)],
            w: [at(10), at(11), at(12)],
            sleeping: false,
            rest: None,
        };
        self.world.import_body_state(key, &state)
    }

    /// The world's counters.
    pub fn stats(&self) -> Stats {
        self.world.stats()
    }

    /// The nearest hit along a ray; counts toward `limits.queriesPerStep`.
    pub fn ray(&mut self, origin: [f64; 3], dir: [f64; 3], max_dist: f64, filter: &QueryFilter) -> Result<Option<Hit>, PhysicsFailure> {
        self.world.ray(origin, dir, max_dist, filter)
    }

    /// The first hit of a swept box, sphere, capsule or hull; counts toward `queriesPerStep`.
    pub fn shape_cast(&mut self, shape: &Shape, pose: Pose, dir: [f64; 3], max_dist: f64, filter: &QueryFilter) -> Result<Option<Hit>, PhysicsFailure> {
        self.world.shape_cast(shape, pose, dir, max_dist, filter)
    }

    /// The bodies a shape overlaps, in key order; counts toward `queriesPerStep`.
    pub fn overlap(&mut self, shape: &Shape, pose: Pose, filter: &QueryFilter) -> Result<Vec<String>, PhysicsFailure> {
        self.world.overlap(shape, pose, filter)
    }

    /// Runs one query.
    pub fn query(&mut self, query: &Query) -> Result<QueryAnswer, PhysicsFailure> {
        self.world.query(query)
    }

    /// The world's state hash (tick, bodies, joint motors), the same for the same calls.
    pub fn state_hash(&self) -> u64 {
        self.world.state_hash()
    }

    /// [`Physics::state_hash`] as 16 lowercase hex digits.
    pub fn state_hash_hex(&self) -> String {
        self.world.state_hash_hex()
    }

    /// The hash of the build and the resolved world description.
    pub fn physics_hash(&self) -> String {
        self.world.physics_hash()
    }

    /// The whole world as bytes, solver caches included: `restore` steps on bit for bit.
    pub fn snapshot(&self) -> Result<Vec<u8>, PhysicsFailure> {
        self.world.snapshot()
    }

    /// Replaces the whole world with a snapshot of this build; on failure nothing changes.
    pub fn restore(&mut self, bytes: &[u8]) -> Result<(), PhysicsFailure> {
        self.world.restore(bytes)
    }

    /// The deprecated raw Rapier world beside this one (`physics-raw`).
    #[cfg(feature = "physics-raw")]
    pub fn raw(&self) -> &rapier3d::prelude::PhysicsWorld {
        &self.raw
    }

    /// The deprecated raw Rapier world, mutably (`physics-raw`).
    #[cfg(feature = "physics-raw")]
    pub fn raw_mut(&mut self) -> &mut rapier3d::prelude::PhysicsWorld {
        &mut self.raw
    }
}

/// An empty raw Rapier world stepping at the fixed tick.
#[cfg(feature = "physics-raw")]
fn raw_world() -> rapier3d::prelude::PhysicsWorld {
    let mut physics = rapier3d::prelude::PhysicsWorld::default();
    physics.integration_parameters.dt = crate::runtime::FIXED_STEP_SECONDS;
    physics
}

/// A game written against raw Rapier keeps compiling for one release: `sim.physics.bodies`,
/// `sim.physics.insert(..)` and `&mut sim.physics` as a `&mut PhysicsWorld` reach the raw world.
#[cfg(feature = "physics-raw")]
impl std::ops::Deref for Physics {
    type Target = rapier3d::prelude::PhysicsWorld;

    fn deref(&self) -> &Self::Target {
        &self.raw
    }
}

#[cfg(feature = "physics-raw")]
impl std::ops::DerefMut for Physics {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.raw
    }
}

/// The description a game registered with `game.physics_world`, checked at install: once, at the
/// fixed tick, and a world the core makes.
pub(crate) fn check_registrations(descs: &[WorldDesc]) -> Result<(), (crate::InstallErrorCode, String)> {
    if descs.len() > 1 {
        return Err((crate::InstallErrorCode::DuplicatePhysicsWorld, "game.physics_world is registered once".to_owned()));
    }
    let Some(desc) = descs.first() else { return Ok(()) };
    let tick = default_world().dt as f32;
    if desc.dt as f32 != tick {
        let detail = format!("dt {} is not the runtime's fixed tick {tick} s", desc.dt);
        return Err((crate::InstallErrorCode::PhysicsWorldInvalid, detail));
    }
    match genex_physics::World::create(desc) {
        Ok(_) => Ok(()),
        Err(failure) => Err((crate::InstallErrorCode::PhysicsWorldInvalid, format!("{}: {}", failure.code.code(), failure.detail))),
    }
}

/// The world every seed starts from: the registered description, else [`default_world`].
pub(crate) fn fresh(descs: &[WorldDesc]) -> Physics {
    let registered = descs.first().and_then(|desc| Physics::new(desc).ok());
    registered.unwrap_or_else(|| Physics::new(&default_world()).unwrap_or_else(|failure| panic!("the default physics world is refused: {failure:?}")))
}

impl<W> crate::Game<W> {
    /// The physics world every seed starts from (gravity, sub-steps, solver iterations, limits):
    /// `dt` must be the fixed tick, `crate::FIXED_STEP_MS / 1000`. Registered once: a second call
    /// is the install refusal `duplicate-physics-world`, a description the core refuses (or another
    /// `dt`) `physics-world-invalid`. Without it a seed gets [`default_world`].
    pub fn physics_world(&mut self, desc: WorldDesc) -> &mut Self {
        self.physics_worlds.push(desc);
        self
    }
}
