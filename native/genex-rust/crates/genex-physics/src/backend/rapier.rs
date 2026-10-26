//! The Rapier 0.36 backend (enhanced-determinism). Nothing here is public: the neutral layer hands
//! it validated values in the core's Y-up frame and reads raw state back.

use rapier3d::dynamics::{GenericJoint, GenericJointBuilder, ImpulseJointHandle, JointAxesMask, JointAxis};
use rapier3d::geometry::{ActiveCollisionTypes, Group, InteractionGroups, InteractionTestMode};
use rapier3d::pipeline::ActiveEvents;
use rapier3d::math::{Pose, Rotation, Vector};
use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{
    ColliderBuilder, IntegrationParameters, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, RigidBodyType,
};

mod events;
mod queries;

use self::events::{Collector, PairHandle, user_data};
use super::{
    Backend, BackendRefusal, BodyEdit, BodySpec, ColliderId, ColliderSpec, InnerStep, MassSpec, RawBodyState, RawHit,
    RawQueryFilter, ShapeAt, ShapeSpec, StepParams,
};
use crate::joint::{JointSpec, JointType, ValidMotor};
use crate::types::{Axis, BodyType};

/// The Rapier version this build pins (`rapier3d = "=0.36.0"` in the workspace).
const RAPIER_VERSION: &str = "0.36.0";

/// One Rapier world.
#[derive(serde::Deserialize)]
pub(crate) struct RapierBackend {
    world: PhysicsWorld,
    /// A fixed body without colliders at the origin: the other end of a joint to the world.
    anchor: RigidBodyHandle,
    /// Bodies a command inserted, moved or froze since the last inner step: Rapier's broad phase
    /// and their colliders' world poses catch up only in the next step (see `queries`).
    stale: Vec<RigidBodyHandle>,
}

/// What `save` writes: the same fields as [`RapierBackend`], borrowed. Rapier skips its pipelines
/// (workspaces rebuilt each step); everything a step reads from one step to the next, contact
/// manifolds and warm-start impulses included, is in the sets it writes.
#[derive(serde::Serialize)]
struct Saved<'a> {
    world: &'a PhysicsWorld,
    anchor: RigidBodyHandle,
    stale: &'a [RigidBodyHandle],
}

fn vector(v: [f32; 3]) -> Vector {
    Vector::new(v[0], v[1], v[2])
}

fn rotation(q: [f32; 4]) -> Rotation {
    Rotation::from_xyzw(q[0], q[1], q[2], q[3])
}

fn pose(translation: [f32; 3], q: [f32; 4]) -> Pose {
    Pose::from_parts(vector(translation), rotation(q))
}

fn integration_parameters(params: &StepParams) -> IntegrationParameters {
    IntegrationParameters {
        dt: params.inner_dt,
        length_unit: params.length_unit,
        num_solver_iterations: params.solver_iterations as usize,
        ..IntegrationParameters::default()
    }
}

/// Rapier's body type for a contract body type. Kinematic bodies are velocity-based: without a
/// target one keeps its pose with velocity zero (§7.2), and with one the core drives it sub-step
/// by sub-step and places it exactly. A position-based one has Rapier derive its velocity from
/// `next · pose⁻¹` each step, which leaves rounding noise of about 1e-5 on a rotated body at rest.
fn rapier_type(body_type: BodyType) -> RigidBodyType {
    match body_type {
        BodyType::Dynamic => RigidBodyType::Dynamic,
        BodyType::Fixed => RigidBodyType::Fixed,
        BodyType::Kinematic => RigidBodyType::KinematicVelocityBased,
    }
}

fn body_builder(spec: &BodySpec) -> RigidBodyBuilder {
    let builder = RigidBodyBuilder::new(rapier_type(spec.body_type));
    let [lock_x, lock_y, lock_z] = spec.locked_rotations;
    builder
        .pose(pose(spec.translation, spec.rotation))
        .linvel(vector(spec.linvel))
        .angvel(vector(spec.angvel))
        .linear_damping(spec.linear_damping)
        .angular_damping(spec.angular_damping)
        .gravity_scale(spec.gravity_scale)
        .enabled_rotations(!lock_x, !lock_y, !lock_z)
        .ccd_enabled(spec.ccd)
        .can_sleep(spec.can_sleep)
}

/// The shape's builder, or `None` when Rapier cannot build it. A hull arrives as the closed mesh
/// the core computed (`hull`), so Rapier's own hull algorithm never runs.
fn shape_builder(shape: &ShapeSpec) -> Option<ColliderBuilder> {
    match shape {
        ShapeSpec::Cuboid { half } => Some(ColliderBuilder::cuboid(half[0], half[1], half[2])),
        ShapeSpec::Ball { radius } => Some(ColliderBuilder::ball(*radius)),
        ShapeSpec::Capsule { half_height, radius, axis } => Some(match axis {
            Axis::X => ColliderBuilder::capsule_x(*half_height, *radius),
            Axis::Y => ColliderBuilder::capsule_y(*half_height, *radius),
            Axis::Z => ColliderBuilder::capsule_z(*half_height, *radius),
        }),
        ShapeSpec::Hull { points, triangles } => {
            let points: Vec<Vector> = points.iter().map(|p| vector(*p)).collect();
            ColliderBuilder::convex_mesh(points, triangles)
        }
        ShapeSpec::Trimesh { vertices, indices } => {
            let vertices = vertices.iter().map(|v| vector(*v)).collect();
            ColliderBuilder::trimesh(vertices, indices.clone()).ok()
        }
        ShapeSpec::Heightfield { rows, cols, heights, scale } => {
            Some(ColliderBuilder::heightfield(column_major(*rows, *cols, heights), vector(*scale)))
        }
    }
}

/// Rapier's grid: rows along z, columns along x, stored column-major (`i + j · rows`).
fn column_major(rows: usize, cols: usize, row_major: &[f32]) -> Array2<f32> {
    let mut data = Vec::with_capacity(rows * cols);
    for col in 0..cols {
        for row in 0..rows {
            data.push(row_major.get(row * cols + col).copied().unwrap_or(0.0));
        }
    }
    Array2::new(rows, cols, data)
}

/// Sensors see every body type, so a fixed or kinematic sensor reports a kinematic body entering
/// (§6.2: sensors always report); solid colliders keep Rapier's default, which only pairs a
/// dynamic body with anything.
fn collision_types(sensor: bool) -> ActiveCollisionTypes {
    match sensor {
        true => ActiveCollisionTypes::all(),
        false => ActiveCollisionTypes::default(),
    }
}

fn collider_builder(spec: &ColliderSpec) -> Option<ColliderBuilder> {
    let builder = shape_builder(&spec.shape)?;
    let builder = match spec.mass {
        MassSpec::Density(density) => builder.density(density),
        MassSpec::Mass(mass) => builder.mass(mass),
    };
    let groups = InteractionGroups::new(
        Group::from_bits_truncate(u32::from(spec.member)),
        Group::from_bits_truncate(u32::from(spec.collides)),
        InteractionTestMode::And,
    );
    let events = if spec.sensor || spec.events { ActiveEvents::COLLISION_EVENTS } else { ActiveEvents::empty() };
    Some(
        builder
            .position(pose(spec.translation, spec.rotation))
            .friction(spec.friction)
            .restitution(spec.restitution)
            .collision_groups(groups)
            .sensor(spec.sensor)
            .active_collision_types(collision_types(spec.sensor))
            .active_events(events),
    )
}

/// The joint axis that takes a type's limits and motor: the hinge's turn, else the slide.
fn free_axis(joint_type: JointType) -> JointAxis {
    match joint_type {
        JointType::Hinge => JointAxis::AngX,
        _ => JointAxis::LinX,
    }
}

fn locked_axes(joint_type: JointType) -> JointAxesMask {
    match joint_type {
        JointType::Fixed => JointAxesMask::LOCKED_FIXED_AXES,
        JointType::Hinge => JointAxesMask::LOCKED_REVOLUTE_AXES,
        JointType::Ball => JointAxesMask::LOCKED_SPHERICAL_AXES,
        JointType::Slider => JointAxesMask::LOCKED_PRISMATIC_AXES,
        JointType::Rope => JointAxesMask::empty(),
    }
}

/// The joint: its locked axes, anchors, axis, limits and motor. A rope couples the three
/// linear axes and limits their distance, as Rapier's own rope joint does.
///
/// Rapier measures a joint's coordinate as its second body relative to its first, so the core
/// inserts `b` (or the world anchor) first and `a` second: a hinge angle, slider position and
/// motor target are `a` relative to `b`, as a caller who names the moving part `a` expects.
fn joint_data(spec: &JointSpec) -> GenericJoint {
    let axis = vector(spec.axis);
    let mut builder = GenericJointBuilder::new(locked_axes(spec.joint_type))
        .local_axis1(axis)
        .local_axis2(axis)
        .local_anchor1(vector(spec.anchor_b))
        .local_anchor2(vector(spec.anchor_a))
        .contacts_enabled(spec.collide_connected);
    if spec.joint_type == JointType::Rope {
        builder = builder.coupled_axes(JointAxesMask::LIN_AXES);
    }
    if let Some(limits) = spec.limits {
        builder = builder.limits(free_axis(spec.joint_type), limits);
    }
    let mut joint = builder.build();
    if let Some(motor) = &spec.motor {
        apply_motor(&mut joint, free_axis(spec.joint_type), motor);
    }
    joint
}

/// Sets every motor value; an absent maxForce is unlimited.
fn apply_motor(joint: &mut GenericJoint, axis: JointAxis, motor: &ValidMotor) {
    let value = |v: Option<f32>| v.unwrap_or(0.0);
    joint.set_motor(axis, value(motor.target_pos), value(motor.target_vel), value(motor.stiffness), value(motor.damping));
    joint.set_motor_max_force(axis, motor.max_force.unwrap_or(f32::MAX));
}

impl RapierBackend {
    /// Whether a loaded world was saved for `params` and has its world anchor.
    fn matches(&self, params: &StepParams) -> bool {
        let p = &self.world.integration_parameters;
        let same_params = p.dt == params.inner_dt
            && p.length_unit == params.length_unit
            && p.num_solver_iterations == params.solver_iterations as usize;
        let anchor_ok = self.world.bodies.get(self.anchor).is_some_and(|rb| rb.is_fixed() && rb.colliders().is_empty());
        let stale_ok = self.stale.iter().all(|body| self.world.bodies.contains(*body));
        same_params && self.world.gravity == vector(params.gravity) && anchor_ok && stale_ok
    }

    fn mark_stale(&mut self, body: RigidBodyHandle) {
        if !self.stale.contains(&body) {
            self.stale.push(body);
        }
    }

    /// Sets a body's replicated fields (§9.2). Rapier's `sleep` zeroes velocities, so they are set
    /// again after it: an imported sleeping body keeps the velocities it was given.
    fn import(&mut self, body: RigidBodyHandle, at: Pose, linvel: Vector, angvel: Vector, sleeping: bool) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_position(at, false);
        if sleeping {
            rb.sleep();
        }
        rb.set_linvel(linvel, false);
        rb.set_angvel(angvel, false);
        if !sleeping {
            self.wake_body(body);
        }
        self.mark_stale(body);
    }

    fn wake_body(&mut self, body: RigidBodyHandle) {
        self.world.wake_up(body, true);
    }

    fn teleport(&mut self, body: RigidBodyHandle, at: Pose, reset_velocity: bool, wake: bool) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_position(at, false);
        if reset_velocity {
            rb.set_linvel(Vector::ZERO, false);
            rb.set_angvel(Vector::ZERO, false);
        }
        if wake {
            self.wake_body(body);
        }
        self.mark_stale(body);
    }
}

impl Backend for RapierBackend {
    type Body = RigidBodyHandle;
    type Joint = ImpulseJointHandle;
    type Pair = PairHandle;
    const NAME: &'static str = "rapier";
    const VERSION: &'static str = RAPIER_VERSION;
    const FEATURES: &'static str = "det";
    /// The world anchor.
    const OWN_BODIES: usize = 1;

    fn create(params: &StepParams) -> Self {
        let mut world = PhysicsWorld::new();
        world.gravity = vector(params.gravity);
        world.integration_parameters = integration_parameters(params);
        let anchor = world.insert_body(RigidBodyBuilder::fixed());
        Self { world, anchor, stale: Vec::new() }
    }

    fn save(&self) -> Option<Vec<u8>> {
        postcard::to_allocvec(&Saved { world: &self.world, anchor: self.anchor, stale: &self.stale }).ok()
    }

    fn load(bytes: &[u8], params: &StepParams) -> Option<Self> {
        let loaded: Self = postcard::from_bytes(bytes).ok()?;
        loaded.matches(params).then_some(loaded)
    }

    fn body_count(&self) -> usize {
        self.world.bodies.len()
    }

    fn collider_count(&self, body: Self::Body) -> Option<usize> {
        self.world.bodies.get(body).map(|rb| rb.colliders().len())
    }

    fn has_joint(&self, joint: Self::Joint) -> bool {
        self.world.impulse_joints.get(joint).is_some()
    }

    fn check(&self, spec: &BodySpec) -> Result<(), BackendRefusal> {
        match spec.colliders.iter().all(|collider| collider_builder(collider).is_some()) {
            true => Ok(()),
            false => Err(BackendRefusal::BadShape),
        }
    }

    fn insert(&mut self, spec: &BodySpec, tag: u64) -> Result<Self::Body, BackendRefusal> {
        let colliders: Option<Vec<ColliderBuilder>> = spec.colliders.iter().map(collider_builder).collect();
        let colliders = colliders.ok_or(BackendRefusal::BadShape)?;
        let handle = self.world.insert_body(body_builder(spec).user_data(user_data(tag, 0)));
        for (index, collider) in (0u32..).zip(colliders) {
            self.world.insert_collider(collider.user_data(user_data(tag, index)), Some(handle));
        }
        self.mark_stale(handle);
        Ok(handle)
    }

    fn remove(&mut self, body: Self::Body) {
        self.world.remove_body(body);
        self.stale.retain(|stale| *stale != body);
    }

    fn edit(&mut self, body: Self::Body, edit: BodyEdit) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        match edit {
            BodyEdit::Impulse { j, at } => {
                match at {
                    Some(point) => rb.apply_impulse_at_point(vector(j), vector(point), true),
                    None => rb.apply_impulse(vector(j), true),
                }
                self.wake_body(body);
            }
            BodyEdit::Velocity { linvel, angvel } => {
                if let Some(v) = linvel {
                    rb.set_linvel(vector(v), true);
                }
                if let Some(w) = angvel {
                    rb.set_angvel(vector(w), true);
                }
                self.wake_body(body);
            }
            BodyEdit::Teleport { translation, rotation, reset_velocity, wake } => {
                self.teleport(body, pose(translation, rotation), reset_velocity, wake);
            }
            BodyEdit::Wake => self.wake_body(body),
            BodyEdit::Sleep => rb.sleep(),
            BodyEdit::Import { translation, rotation, linvel, angvel, sleeping } => {
                self.import(body, pose(translation, rotation), vector(linvel), vector(angvel), sleeping);
            }
        }
    }

    fn drive(&mut self, body: Self::Body, linvel: [f32; 3], angvel: [f32; 3]) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        let moving = linvel != [0.0; 3] || angvel != [0.0; 3];
        rb.set_linvel(vector(linvel), moving);
        rb.set_angvel(vector(angvel), moving);
    }

    fn place(&mut self, body: Self::Body, translation: [f32; 3], rotation: [f32; 4]) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_position(pose(translation, rotation), false);
        self.mark_stale(body);
    }

    /// Rapier quarantines a body whose state went non-finite (disabled, rolled back, still), and
    /// disables a collider whose bounds went non-finite; the core reads either as §8.2's
    /// non-finite case of the body that owns it.
    fn step(&mut self) -> InnerStep<Self::Body, Self::Pair> {
        self.stale.clear();
        let collector = Collector::default();
        self.world.step_with_events(&(), &collector);
        let quarantine = self.world.quarantine();
        let mut non_finite = quarantine.bodies().to_vec();
        let owners = quarantine.colliders().iter().filter_map(|handle| self.world.colliders.get(*handle)?.parent());
        for owner in owners {
            if !non_finite.contains(&owner) {
                non_finite.push(owner);
            }
        }
        InnerStep { non_finite, events: collector.take() }
    }

    fn pair_impulse(&self, pair: Self::Pair) -> f32 {
        self.world.contact_pair(pair.0, pair.1).map_or(0.0, |contact| contact.total_impulse_magnitude())
    }

    fn state(&self, body: Self::Body) -> RawBodyState {
        let Some(rb) = self.world.bodies.get(body) else {
            return RawBodyState {
                translation: [0.0; 3],
                rotation: [0.0, 0.0, 0.0, 1.0],
                linvel: [0.0; 3],
                angvel: [0.0; 3],
                sleeping: true,
            };
        };
        let position = rb.position();
        let q = position.rotation;
        RawBodyState {
            translation: position.translation.to_array(),
            rotation: [q.x, q.y, q.z, q.w],
            linvel: rb.linvel().to_array(),
            angvel: rb.angvel().to_array(),
            sleeping: rb.is_sleeping(),
        }
    }

    fn freeze(&mut self, body: Self::Body, translation: [f32; 3], rotation: [f32; 4]) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_enabled(true);
        rb.set_body_type(RigidBodyType::Fixed, false);
        rb.set_position(pose(translation, rotation), false);
        rb.set_linvel(Vector::ZERO, false);
        rb.set_angvel(Vector::ZERO, false);
        self.mark_stale(body);
    }

    fn unfreeze(&mut self, body: Self::Body, body_type: BodyType) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_body_type(rapier_type(body_type), false);
        if body_type != BodyType::Fixed {
            rb.sleep();
        }
    }

    fn insert_joint(&mut self, a: Self::Body, b: Option<Self::Body>, spec: &JointSpec) -> Self::Joint {
        let first = b.unwrap_or(self.anchor);
        self.world.insert_impulse_joint(first, a, joint_data(spec))
    }

    fn remove_joint(&mut self, joint: Self::Joint) {
        self.world.remove_impulse_joint(joint);
    }

    fn set_motor(&mut self, joint: Self::Joint, spec: &JointSpec) {
        let Some(motor) = &spec.motor else { return };
        let Some(handle) = self.world.impulse_joints.get_mut(joint, true) else { return };
        apply_motor(&mut handle.data, free_axis(spec.joint_type), motor);
    }

    fn contact_pairs(&self) -> usize {
        self.world.contact_pairs().count()
    }

    fn ray(&self, origin: [f32; 3], dir: [f32; 3], max_dist: f32, filter: &RawQueryFilter) -> Vec<RawHit> {
        self.query_ray(origin, dir, max_dist, filter)
    }

    fn shape_cast(
        &self,
        shape: ShapeAt<'_>,
        dir: [f32; 3],
        max_dist: f32,
        filter: &RawQueryFilter,
    ) -> Result<Vec<RawHit>, BackendRefusal> {
        self.query_cast(shape, dir, max_dist, filter)
    }

    fn overlap(&self, shape: ShapeAt<'_>, filter: &RawQueryFilter) -> Result<Vec<ColliderId>, BackendRefusal> {
        self.query_overlap(shape, filter)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> StepParams {
        StepParams { gravity: [0.0, -9.81, 0.0], inner_dt: 1.0 / 60.0, length_unit: 1.0, solver_iterations: 4 }
    }

    fn crate_spec() -> BodySpec {
        let collider = ColliderSpec {
            shape: ShapeSpec::Cuboid { half: [0.5; 3] },
            translation: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            mass: MassSpec::Density(1.0),
            friction: 0.5,
            restitution: 0.0,
            member: u16::MAX,
            collides: u16::MAX,
            sensor: false,
            events: false,
        };
        BodySpec {
            body_type: BodyType::Dynamic,
            translation: [0.0, 2.0, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            linvel: [0.0; 3],
            angvel: [0.0; 3],
            linear_damping: 0.0,
            angular_damping: 0.0,
            gravity_scale: 1.0,
            locked_rotations: [false; 3],
            ccd: false,
            can_sleep: true,
            colliders: vec![collider],
        }
    }

    #[test]
    fn a_body_whose_collider_goes_non_finite_is_reported_non_finite() {
        let mut backend = RapierBackend::create(&params());
        let body = backend.insert(&crate_spec(), 0).expect("inserts");
        assert!(backend.step().non_finite.is_empty());
        let handle = backend.world.bodies.get(body).expect("there").colliders()[0];
        let collider = backend.world.colliders.get_mut(handle).expect("there");
        collider.set_translation_wrt_parent(Vector::new(f32::NAN, 0.0, 0.0));
        let report = backend.step();
        assert_eq!(report.non_finite, vec![body], "its collider was quarantined, so the body is non-finite (§8.2)");
    }
}
