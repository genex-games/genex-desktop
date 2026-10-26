//! The Rapier 0.36 backend (enhanced-determinism). Nothing here is public: the neutral layer hands
//! it validated values in the core's Y-up frame and reads raw state back.

use rapier3d::geometry::{Group, InteractionGroups, InteractionTestMode};
use rapier3d::pipeline::ActiveEvents;
use rapier3d::math::{Pose, Rotation, Vector};
use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{
    ColliderBuilder, IntegrationParameters, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, RigidBodyType,
};

use super::{Backend, BackendRefusal, BodySpec, ColliderSpec, MassSpec, RawBodyState, ShapeSpec, StepParams};
use crate::types::{Axis, BodyType};

/// The Rapier version this build pins (`rapier3d = "=0.36.0"` in the workspace).
const RAPIER_VERSION: &str = "0.36.0";

/// One Rapier world.
pub(crate) struct RapierBackend {
    world: PhysicsWorld,
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

fn body_builder(spec: &BodySpec) -> RigidBodyBuilder {
    let builder = match spec.body_type {
        BodyType::Dynamic => RigidBodyBuilder::dynamic(),
        BodyType::Fixed => RigidBodyBuilder::fixed(),
        // Velocity-based: without a target a kinematic body keeps its pose with velocity zero
        // (§7.2). A position-based one has Rapier derive its velocity from `next · pose⁻¹` each
        // step, which leaves rounding noise of about 1e-5 on a rotated body at rest.
        BodyType::Kinematic => RigidBodyBuilder::kinematic_velocity_based(),
    };
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

impl Backend for RapierBackend {
    type Body = RigidBodyHandle;
    const NAME: &'static str = "rapier";
    const VERSION: &'static str = RAPIER_VERSION;
    const FEATURES: &'static str = "det";

    fn create(params: &StepParams) -> Self {
        let mut world = PhysicsWorld::new();
        world.gravity = vector(params.gravity);
        world.integration_parameters = integration_parameters(params);
        Self { world }
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

    fn step(&mut self) {
        self.world.step();
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

    fn contact_pairs(&self) -> usize {
        self.world.contact_pairs().count()
    }
}
