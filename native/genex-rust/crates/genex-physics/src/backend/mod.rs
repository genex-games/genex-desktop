//! The internal backend seam. The neutral layer hands a backend only validated values, already in
//! the core's Y-up frame and rounded to f32, and reads back raw state in that frame. The trait is
//! never public: a different backend is a different `buildId`, never a different API (§1.3).

pub(crate) mod rapier;

use crate::joint::JointSpec;
use crate::types::{Axis, BodyType};

/// The backend this build links.
pub(crate) type ActiveBackend = rapier::RapierBackend;

/// The world-wide settings a backend steps with.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StepParams {
    /// Gravity in the core's frame.
    pub gravity: [f32; 3],
    /// One inner step, `dt / substeps`.
    pub inner_dt: f32,
    /// Caller length units per metre, which tunes tolerances only.
    pub length_unit: f32,
    /// Solver iterations.
    pub solver_iterations: u32,
}

/// A shape in the core's frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ShapeSpec {
    /// A box by its half-extents.
    Cuboid { half: [f32; 3] },
    /// A sphere.
    Ball { radius: f32 },
    /// A capsule along an internal axis.
    Capsule { half_height: f32, radius: f32, axis: Axis },
    /// The convex hull of points.
    Hull { points: Vec<[f32; 3]> },
    /// A triangle mesh (fixed bodies only).
    Trimesh { vertices: Vec<[f32; 3]>, indices: Vec<[u32; 3]> },
    /// A heightfield grid in internal row order: `heights[r * cols + c]` is internal row r, column c;
    /// columns run along internal x, rows along internal z, heights along internal y, scaled by `scale`.
    Heightfield { rows: usize, cols: usize, heights: Vec<f32>, scale: [f32; 3] },
}

/// How a collider's mass is given.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MassSpec {
    /// kg per caller-unit³.
    Density(f32),
    /// kg.
    Mass(f32),
}

/// One collider in the core's frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ColliderSpec {
    pub shape: ShapeSpec,
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub mass: MassSpec,
    pub friction: f32,
    pub restitution: f32,
    pub member: u16,
    pub collides: u16,
    pub sensor: bool,
    pub events: bool,
}

/// One body in the core's frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BodySpec {
    pub body_type: BodyType,
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub linvel: [f32; 3],
    pub angvel: [f32; 3],
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub gravity_scale: f32,
    /// Rotation locks per internal axis.
    pub locked_rotations: [bool; 3],
    pub ccd: bool,
    pub can_sleep: bool,
    pub colliders: Vec<ColliderSpec>,
}

/// A body's state as the backend holds it, in the core's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RawBodyState {
    pub translation: [f32; 3],
    pub rotation: [f32; 4],
    pub linvel: [f32; 3],
    pub angvel: [f32; 3],
    pub sleeping: bool,
}

/// Why a backend refused a body the neutral layer accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackendRefusal {
    /// The backend could not build a shape (a hull it cannot compute).
    BadShape,
}

/// A command's effect on one body, in the core's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum BodyEdit {
    /// A linear impulse, with its torque when applied at a world point; wakes the body.
    Impulse { j: [f32; 3], at: Option<[f32; 3]> },
    /// Sets the given velocities; wakes the body.
    Velocity { linvel: Option<[f32; 3]>, angvel: Option<[f32; 3]> },
    /// A teleport.
    Teleport { translation: [f32; 3], rotation: [f32; 4], reset_velocity: bool, wake: bool },
    /// Wakes the body.
    Wake,
    /// Puts the body to sleep, its velocities zero.
    Sleep,
}

/// A physics engine under the neutral layer.
pub(crate) trait Backend: Sized {
    /// The backend's handle for one body.
    type Body: Copy + PartialEq;
    /// The backend's handle for one joint.
    type Joint: Copy;
    /// The `<backend>` part of the buildId.
    const NAME: &'static str;
    /// The `<backend version>` part.
    const VERSION: &'static str;
    /// The `<features>` part.
    const FEATURES: &'static str;

    /// An empty world.
    fn create(params: &StepParams) -> Self;
    /// Whether the backend can build every shape of `spec`; touches nothing.
    fn check(&self, spec: &BodySpec) -> Result<(), BackendRefusal>;
    /// Inserts a body and its colliders; a refusal inserts nothing.
    fn insert(&mut self, spec: &BodySpec) -> Result<Self::Body, BackendRefusal>;
    /// Removes a body, its colliders and its joints.
    fn remove(&mut self, body: Self::Body);
    /// Applies a command's effect to a simulated (not frozen) body.
    fn edit(&mut self, body: Self::Body, edit: BodyEdit);
    /// Sets a kinematic body's velocities for the next inner step.
    fn drive(&mut self, body: Self::Body, linvel: [f32; 3], angvel: [f32; 3]);
    /// Places a kinematic body exactly, keeping its velocities.
    fn place(&mut self, body: Self::Body, translation: [f32; 3], rotation: [f32; 4]);
    /// Advances one inner step; returns the bodies whose state went non-finite in it.
    fn step(&mut self) -> Vec<Self::Body>;
    /// A body's state.
    fn state(&self, body: Self::Body) -> RawBodyState;
    /// Freezes a body at a pose: velocities zero, out of the simulation, never woken (§8.2).
    fn freeze(&mut self, body: Self::Body, translation: [f32; 3], rotation: [f32; 4]);
    /// Returns a frozen body to the simulation as `body_type`, asleep and still.
    fn unfreeze(&mut self, body: Self::Body, body_type: BodyType);
    /// Joins `a` to `b`, or to the world when `b` is `None`.
    fn insert_joint(&mut self, a: Self::Body, b: Option<Self::Body>, spec: &JointSpec) -> Self::Joint;
    /// Removes a joint.
    fn remove_joint(&mut self, joint: Self::Joint);
    /// Replaces a joint's motor with the one in `spec`.
    fn set_motor(&mut self, joint: Self::Joint, spec: &JointSpec);
    /// The number of contact pairs the backend holds, for memory accounting.
    fn contact_pairs(&self) -> usize;
}
