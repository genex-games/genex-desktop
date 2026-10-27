//! The Rapier 0.36 backend (enhanced-determinism). Nothing here is public: the neutral layer hands
//! it validated values in the core's Y-up frame and reads raw state back.

use std::collections::BTreeMap;

use rapier3d::dynamics::{GenericJoint, GenericJointBuilder, ImpulseJointHandle, JointAxesMask, JointAxis};
use rapier3d::geometry::{ActiveCollisionTypes, Group, InteractionGroups, InteractionTestMode};
use rapier3d::pipeline::ActiveEvents;
use rapier3d::math::{Pose, Rotation, Vector};
use rapier3d::parry::utils::Array2;
use rapier3d::prelude::{
    ColliderBuilder, IntegrationParameters, PhysicsWorld, RigidBodyBuilder, RigidBodyHandle, RigidBodyType,
};

mod canonical;
mod events;
mod queries;

use self::events::{Collector, PairHandle, user_data};
use super::{
    Backend, BackendRefusal, BodyEdit, BodySpec, ColliderId, ColliderSpec, InnerStep, MassSpec, RawBodyState, RawHit,
    RawPair, RawQueryFilter, RebuiltJoint, ShapeAt, ShapeSpec, StepParams,
};
use crate::joint::{JointSpec, JointType, ValidMotor};
use crate::types::{Axis, BodyType};

/// The Rapier version this build pins (`rapier3d = "=0.36.0"` in the workspace).
const RAPIER_VERSION: &str = "0.36.0";

/// A joint edit a command made, applied to Rapier at the start of the next step.
///
/// Rapier queues the island links and unlinks a joint insertion, removal or mutable access makes
/// in fields it does not serialise, to be consumed by its next step. A snapshot taken between a
/// joint command and that step would lose them, and the restored world's islands (and so its
/// sleep) would differ (§9.3). Keeping the edits here, where a snapshot carries them, and handing
/// them to Rapier only right before it steps, means Rapier never holds a pending one at a snapshot.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
enum JointEdit {
    /// Join `second` to `first` (the joint's coordinate is `second` relative to `first`).
    Insert { id: u64, first: RigidBodyHandle, second: RigidBodyHandle, spec: JointSpec },
    /// Remove an inserted joint.
    Remove { id: u64 },
    /// Replace an inserted joint's motor.
    Motor { id: u64, spec: JointSpec },
    /// Remove a body that still had joints in Rapier when the command removed it (Rapier would
    /// queue their unlinks too).
    RemoveBody { body: RigidBodyHandle },
}

/// One Rapier world.
#[derive(serde::Deserialize)]
pub(crate) struct RapierBackend {
    world: PhysicsWorld,
    /// A fixed body without colliders at the origin: the other end of a joint to the world.
    anchor: RigidBodyHandle,
    /// Bodies a command inserted, moved or froze since the last inner step, by their handle's raw
    /// parts: Rapier's broad phase and their colliders' world poses catch up only in the next step
    /// (see `queries`). A map, so a query tests each candidate in log time however many bodies a
    /// tick teleported or imported.
    stale: BTreeMap<(u32, u32), RigidBodyHandle>,
    /// Each joint the core holds by its id, once Rapier holds it.
    joints: BTreeMap<u64, ImpulseJointHandle>,
    /// The id the next joint gets.
    next_joint: u64,
    /// Joint edits not yet handed to Rapier, in command order.
    edits: Vec<JointEdit>,
    /// The static pieces of the last rebuild as a world of their own, its broad-phase tree built,
    /// for the next rebuild to start from (`canonical`). A cache: a snapshot does not carry it,
    /// and a rebuild makes it again from the pieces whenever it is missing or stale.
    #[serde(skip)]
    template: Option<Box<canonical::Template>>,
}

/// What `save` writes: the same fields as [`RapierBackend`], borrowed. Rapier skips its pipelines
/// (workspaces rebuilt each step); everything a step reads from one step to the next, contact
/// manifolds and warm-start impulses included, is in the sets it writes, and the joint edits it
/// would not write are still in `edits`.
#[derive(serde::Serialize)]
struct Saved<'a> {
    world: &'a PhysicsWorld,
    anchor: RigidBodyHandle,
    stale: &'a BTreeMap<(u32, u32), RigidBodyHandle>,
    joints: &'a BTreeMap<u64, ImpulseJointHandle>,
    next_joint: u64,
    edits: &'a [JointEdit],
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
/// (§6.2: sensors always report), and so does a solid collider with `events: true` (§6.2: the
/// opt-in is per collider), so an opted-in kinematic player reports touching a static piece or
/// another kinematic body. Rapier computes those contacts without any solver response, as neither
/// body is dynamic. Other solid colliders keep Rapier's default, which pairs a dynamic body with
/// anything.
fn collision_types(spec: &ColliderSpec) -> ActiveCollisionTypes {
    match spec.sensor || spec.events {
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
            .active_collision_types(collision_types(spec))
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
        let stale_ok = self.stale.iter().all(|(key, body)| *key == body.into_raw_parts() && self.world.bodies.contains(*body));
        let joints_ok = self.joints.iter().all(|(id, joint)| *id < self.next_joint && self.world.impulse_joints.contains(*joint));
        let edits_ok = self.edits.iter().all(|edit| self.edit_fits(edit));
        let structure_ok = stale_ok && joints_ok && edits_ok;
        same_params && self.world.gravity == vector(params.gravity) && anchor_ok && structure_ok
    }

    /// Whether a loaded edit names bodies Rapier holds and joints it holds (or will).
    fn edit_fits(&self, edit: &JointEdit) -> bool {
        let body = |handle: &RigidBodyHandle| self.world.bodies.contains(*handle);
        match edit {
            JointEdit::Insert { id, first, second, .. } => *id < self.next_joint && body(first) && body(second),
            JointEdit::Remove { id } | JointEdit::Motor { id, .. } => self.joints.contains_key(id),
            JointEdit::RemoveBody { body: handle } => body(handle),
        }
    }

    /// Hands every queued joint edit to Rapier, in order, right before it steps.
    fn apply_joint_edits(&mut self) {
        for edit in std::mem::take(&mut self.edits) {
            match edit {
                JointEdit::Insert { id, first, second, spec } => {
                    let handle = self.world.insert_impulse_joint(first, second, joint_data(&spec));
                    self.joints.insert(id, handle);
                }
                JointEdit::Remove { id } => {
                    if let Some(handle) = self.joints.remove(&id) {
                        self.world.remove_impulse_joint(handle);
                    }
                }
                JointEdit::Motor { id, spec } => self.apply_motor_now(id, &spec),
                JointEdit::RemoveBody { body } => {
                    self.world.remove_body(body);
                }
            }
        }
    }

    fn apply_motor_now(&mut self, id: u64, spec: &JointSpec) {
        let Some(motor) = &spec.motor else { return };
        let Some(handle) = self.joints.get(&id) else { return };
        let Some(joint) = self.world.impulse_joints.get_mut(*handle, true) else { return };
        apply_motor(&mut joint.data, free_axis(spec.joint_type), motor);
    }

    /// The queued insertion of joint `id`, if it has not reached Rapier yet.
    fn queued_insert(&mut self, id: u64) -> Option<&mut JointSpec> {
        self.edits.iter_mut().find_map(|edit| match edit {
            JointEdit::Insert { id: queued, spec, .. } if *queued == id => Some(spec),
            _ => None,
        })
    }

    /// Bodies whose removal is queued.
    fn queued_removals(&self) -> usize {
        self.edits.iter().filter(|edit| matches!(edit, JointEdit::RemoveBody { .. })).count()
    }

    fn mark_stale(&mut self, body: RigidBodyHandle) {
        self.stale.insert(body.into_raw_parts(), body);
    }

    /// Whether a command moved `body` since the last inner step.
    fn is_stale_body(&self, body: RigidBodyHandle) -> bool {
        self.stale.contains_key(&body.into_raw_parts())
    }

    /// Sets a body's replicated fields (§9.2). Rapier's `sleep` zeroes velocities, so they are set
    /// again after it: an imported sleeping body keeps the velocities it was given.
    fn import(&mut self, body: RigidBodyHandle, at: Pose, linvel: Vector, angvel: Vector, sleeping: bool, rest: Option<f32>) {
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
        if let Some(rest) = rest
            && let Some(rb) = self.world.bodies.get_mut(body)
        {
            rb.activation_mut().time_since_can_sleep = rest;
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
    type Joint = u64;
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
        Self { world, anchor, stale: BTreeMap::new(), joints: BTreeMap::new(), next_joint: 0, edits: Vec::new(), template: None }
    }

    fn save(&self) -> Option<Vec<u8>> {
        let saved = Saved {
            world: &self.world,
            anchor: self.anchor,
            stale: &self.stale,
            joints: &self.joints,
            next_joint: self.next_joint,
            edits: &self.edits,
        };
        postcard::to_allocvec(&saved).ok()
    }

    fn load(bytes: &[u8], params: &StepParams) -> Option<Self> {
        let loaded: Self = postcard::from_bytes(bytes).ok()?;
        loaded.matches(params).then_some(loaded)
    }

    fn body_count(&self) -> usize {
        self.world.bodies.len() - self.queued_removals()
    }

    fn collider_count(&self, body: Self::Body) -> Option<usize> {
        self.world.bodies.get(body).map(|rb| rb.colliders().len())
    }

    fn has_joint(&self, joint: Self::Joint) -> bool {
        let queued = self.edits.iter().any(|edit| matches!(edit, JointEdit::Insert { id, .. } if *id == joint));
        queued || self.joints.contains_key(&joint)
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

    /// Removes a body now, or at the start of the next step when Rapier still holds joints on it
    /// (the core queued their removal just before), so their unlinks never wait in Rapier.
    fn remove(&mut self, body: Self::Body) {
        self.stale.remove(&body.into_raw_parts());
        if self.world.impulse_joints.attached_joints(body).next().is_some() {
            self.edits.push(JointEdit::RemoveBody { body });
            return;
        }
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
            BodyEdit::Import { translation, rotation, linvel, angvel, sleeping, rest } => {
                self.import(body, pose(translation, rotation), vector(linvel), vector(angvel), sleeping, rest);
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
        self.apply_joint_edits();
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
                rest: 0.0,
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
            rest: rb.activation().time_since_can_sleep,
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

    /// Queues the joint (see [`JointEdit`]); Rapier holds it from the next step.
    fn insert_joint(&mut self, a: Self::Body, b: Option<Self::Body>, spec: &JointSpec) -> Self::Joint {
        let id = self.next_joint;
        self.next_joint += 1;
        let first = b.unwrap_or(self.anchor);
        self.edits.push(JointEdit::Insert { id, first, second: a, spec: spec.clone() });
        id
    }

    /// Drops a joint still queued, else queues its removal.
    fn remove_joint(&mut self, joint: Self::Joint) {
        let queued = |edit: &JointEdit| matches!(edit, JointEdit::Insert { id, .. } | JointEdit::Motor { id, .. } if *id == joint);
        if self.queued_insert(joint).is_some() {
            self.edits.retain(|edit| !queued(edit));
            return;
        }
        self.edits.push(JointEdit::Remove { id: joint });
    }

    /// Changes a queued joint's motor in place, else queues the change.
    fn set_motor(&mut self, joint: Self::Joint, spec: &JointSpec) {
        if let Some(queued) = self.queued_insert(joint) {
            *queued = spec.clone();
            return;
        }
        self.edits.push(JointEdit::Motor { id: joint, spec: spec.clone() });
    }

    fn contact_pairs(&self) -> usize {
        self.world.contact_pairs().count()
    }

    fn touching(&self) -> Vec<RawPair> {
        self.touching_pairs()
    }

    fn rebuild(
        &mut self,
        static_tags: &[u64],
        bodies: &[Self::Body],
        joints: &[RebuiltJoint<'_, Self::Body>],
    ) -> (Vec<Self::Body>, Vec<Self::Joint>) {
        self.rebuild_world(static_tags, bodies, joints)
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
