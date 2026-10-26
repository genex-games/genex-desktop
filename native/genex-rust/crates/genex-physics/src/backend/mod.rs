//! The internal backend seam. The neutral layer hands a backend only validated values, already in
//! the core's Y-up frame and rounded to f32, and reads back raw state in that frame. The trait is
//! never public: a different backend is a different `buildId`, never a different API (§1.3).

pub(crate) mod rapier;

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

/// A physics engine under the neutral layer.
pub(crate) trait Backend: Sized {
    /// The backend's handle for one body.
    type Body: Copy;
    /// The `<backend>` part of the buildId.
    const NAME: &'static str;
    /// The `<backend version>` part.
    const VERSION: &'static str;
    /// The `<features>` part.
    const FEATURES: &'static str;

    /// An empty world.
    fn create(params: &StepParams) -> Self;
    /// Inserts a body and its colliders; a refusal inserts nothing.
    fn insert(&mut self, spec: &BodySpec) -> Result<Self::Body, BackendRefusal>;
    /// Removes a body and its colliders.
    fn remove(&mut self, body: Self::Body);
    /// Advances one inner step.
    fn step(&mut self);
    /// A body's state.
    fn state(&self, body: Self::Body) -> RawBodyState;
    /// Freezes a body at a pose: velocities zero, out of the simulation, never woken (§8.2).
    fn freeze(&mut self, body: Self::Body, translation: [f32; 3], rotation: [f32; 4]);
    /// The number of contact pairs the backend holds, for memory accounting.
    fn contact_pairs(&self) -> usize;
}
