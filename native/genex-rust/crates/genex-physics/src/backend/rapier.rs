//! The Rapier 0.36 backend (enhanced-determinism). Nothing here is public: the neutral layer hands
//! it validated values in the core's Y-up frame and reads raw state back.

use rapier3d::dynamics::{GenericJoint, GenericJointBuilder, ImpulseJointHandle, JointAxesMask, JointAxis};
use rapier3d::geometry::{Group, InteractionGroups, InteractionTestMode};
use rapier3d::pipeline::ActiveEvents;
use rapier3d::math::{Pose, Rotation, Vector};
use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{
    ColliderBuilder, IntegrationParameters, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, RigidBodyType,
};

use super::{Backend, BackendRefusal, BodyEdit, BodySpec, ColliderSpec, MassSpec, RawBodyState, ShapeSpec, StepParams};
use crate::joint::{JointSpec, JointType, ValidMotor};
use crate::types::{Axis, BodyType};

/// The Rapier version this build pins (`rapier3d = "=0.36.0"` in the workspace).
const RAPIER_VERSION: &str = "0.36.0";

/// One Rapier world.
pub(crate) struct RapierBackend {
    world: PhysicsWorld,
    /// A fixed body without colliders at the origin: the other end of a joint to the world.
    anchor: RigidBodyHandle,
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

/// The shape's builder, or `None` when Rapier cannot build it.
fn shape_builder(shape: &ShapeSpec) -> Option<ColliderBuilder> {
    match shape {
        ShapeSpec::Cuboid { half } => Some(ColliderBuilder::cuboid(half[0], half[1], half[2])),
        ShapeSpec::Ball { radius } => Some(ColliderBuilder::ball(*radius)),
        ShapeSpec::Capsule { half_height, radius, axis } => Some(match axis {
            Axis::X => ColliderBuilder::capsule_x(*half_height, *radius),
            Axis::Y => ColliderBuilder::capsule_y(*half_height, *radius),
            Axis::Z => ColliderBuilder::capsule_z(*half_height, *radius),
        }),
        ShapeSpec::Hull { points } => {
            let points: Vec<Vector> = points.iter().map(|p| vector(*p)).collect();
            ColliderBuilder::convex_hull(&points)
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
fn joint_data(spec: &JointSpec) -> GenericJoint {
    let axis = vector(spec.axis);
    let mut builder = GenericJointBuilder::new(locked_axes(spec.joint_type))
        .local_axis1(axis)
        .local_axis2(axis)
        .local_anchor1(vector(spec.anchor_a))
        .local_anchor2(vector(spec.anchor_b))
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
    }
}

impl Backend for RapierBackend {
    type Body = RigidBodyHandle;
    type Joint = ImpulseJointHandle;
    const NAME: &'static str = "rapier";
    const VERSION: &'static str = RAPIER_VERSION;
    const FEATURES: &'static str = "det";

    fn create(params: &StepParams) -> Self {
        let mut world = PhysicsWorld::new();
        world.gravity = vector(params.gravity);
        world.integration_parameters = integration_parameters(params);
        let anchor = world.insert_body(RigidBodyBuilder::fixed());
        Self { world, anchor }
    }

    fn check(&self, spec: &BodySpec) -> Result<(), BackendRefusal> {
        match spec.colliders.iter().all(|collider| collider_builder(collider).is_some()) {
            true => Ok(()),
            false => Err(BackendRefusal::BadShape),
        }
    }

    fn insert(&mut self, spec: &BodySpec) -> Result<Self::Body, BackendRefusal> {
        let colliders: Option<Vec<ColliderBuilder>> = spec.colliders.iter().map(collider_builder).collect();
        let colliders = colliders.ok_or(BackendRefusal::BadShape)?;
        let handle = self.world.insert_body(body_builder(spec));
        for collider in colliders {
            self.world.insert_collider(collider, Some(handle));
        }
        Ok(handle)
    }

    fn remove(&mut self, body: Self::Body) {
        self.world.remove_body(body);
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
    }

    /// Rapier quarantines a body whose state went non-finite (disabled, rolled back, still); the
    /// core reads that as §8.2's non-finite case.
    fn step(&mut self) -> Vec<Self::Body> {
        self.world.step();
        self.world.quarantine().bodies().to_vec()
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
    }

    fn unfreeze(&mut self, body: Self::Body, body_type: BodyType) {
        let Some(rb) = self.world.bodies.get_mut(body) else { return };
        rb.set_body_type(rapier_type(body_type), false);
        if body_type != BodyType::Fixed {
            rb.sleep();
        }
    }

    fn insert_joint(&mut self, a: Self::Body, b: Option<Self::Body>, spec: &JointSpec) -> Self::Joint {
        let other = b.unwrap_or(self.anchor);
        self.world.insert_impulse_joint(a, other, joint_data(spec))
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
}
