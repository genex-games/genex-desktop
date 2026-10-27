//! The canonical rebuild (contract 1.1 draft, `canonicalize`): a fresh Rapier world holding the
//! same bodies, colliders and joints in a fixed order, each body with its state and parameters and
//! none of its history, so two worlds that hold the same bodies in the same states rebuild to the
//! same world bit for bit, whatever each did before.
//!
//! Order: the world anchor, the static pieces by tag (their key order), the core's bodies in the
//! order given (key order), then the joints in the order given, queued as joint edits as a command
//! queues them. A body is built anew from its parameters (type, pose, velocities, damping, gravity
//! scale, locks, CCD, sleep thresholds, user data) and its sleep state and timer; its colliders are
//! copied, which carry nothing a step leaves behind. Rapier's sleep check measures a body's
//! displacement since the last step from a previous pose it keeps privately; the rebuild sets that
//! pose to the body's current one, so the first step after it measures no displacement from the
//! rebuild itself.
//!
//! The static pieces are rebuilt once and kept as a template whose broad-phase tree is already
//! built, so queries see them at once and a rebuild costs only the bodies; the template is a cache
//! made again whenever the static pieces differ from the ones it holds.

use std::collections::BTreeMap;

use rapier3d::dynamics::RigidBodyActivation;
use rapier3d::geometry::Collider;
use rapier3d::math::{Pose, Rotation, Vector};
use rapier3d::pipeline::ActiveEvents;
use rapier3d::prelude::{PhysicsWorld, RigidBody, RigidBodyBuilder, RigidBodyHandle};

use super::events::collider_id;
use super::{JointEdit, RapierBackend};
use crate::backend::{RawPair, RebuiltJoint};

/// The bits of a body's `user_data` below its tag (`events::user_data`).
const TAG_SHIFT: u32 = 32;

/// The static pieces of a rebuild as a world of their own (no bodies of the core), after one
/// collision pass, so its broad-phase tree holds them.
pub(crate) struct Template {
    /// The static tags it was built from, in order.
    tags: Vec<u64>,
    /// Its world anchor.
    anchor: RigidBodyHandle,
    world: PhysicsWorld,
}

/// What Rapier's sleep state holds, field for field, with the previous pose it keeps privately;
/// written with serde and read back as a `RigidBodyActivation` (the field order is Rapier's own,
/// held to it by the test below).
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
struct ActivationImage {
    normalized_linear_threshold: f32,
    angular_threshold: f32,
    time_until_sleep: f32,
    time_since_can_sleep: f32,
    sleeping: bool,
    sleep_prev_pose: Pose,
}

/// `activation` with its previous pose set to `pose`; `None` if Rapier's form ever differs.
fn activation_at(activation: &RigidBodyActivation, pose: Pose) -> Option<RigidBodyActivation> {
    let image = ActivationImage {
        normalized_linear_threshold: activation.normalized_linear_threshold,
        angular_threshold: activation.angular_threshold,
        time_until_sleep: activation.time_until_sleep,
        time_since_can_sleep: activation.time_since_can_sleep,
        sleeping: activation.sleeping,
        sleep_prev_pose: pose,
    };
    let bytes = postcard::to_allocvec(&image).ok()?;
    postcard::from_bytes(&bytes).ok()
}

/// The pose `body` had one inner step of `dt` ago, had it moved at its current velocities:
/// Rapier's sleep check compares a body's pose with the one before its last step, which the
/// rebuild cannot know, so it estimates it from the state alone (the same on every world).
fn pose_before(body: &RigidBody, dt: f32) -> Pose {
    let pose = plus_zero_pose(body.position());
    let back = Rotation::from_scaled_axis(-plus_zero_vector(body.angvel()) * dt);
    Pose::from_parts(pose.translation - plus_zero_vector(body.linvel()) * dt, (back * pose.rotation).normalize())
}

/// `x` with −0 as +0. Rapier compares a pose it is given with the one it holds by value, so an
/// import may leave a zero's sign as the body's history left it; the rebuild writes every zero as
/// +0, so two worlds whose states are equal as numbers rebuild to the same bits.
fn plus_zero(x: f32) -> f32 {
    if x == 0.0 { 0.0 } else { x }
}

fn plus_zero_vector(v: Vector) -> Vector {
    Vector::new(plus_zero(v.x), plus_zero(v.y), plus_zero(v.z))
}

/// A body's pose with every zero +0.
fn plus_zero_pose(pose: &Pose) -> Pose {
    let q = pose.rotation;
    let rotation = Rotation::from_xyzw(plus_zero(q.x), plus_zero(q.y), plus_zero(q.z), plus_zero(q.w));
    Pose::from_parts(plus_zero_vector(pose.translation), rotation)
}

/// `body` built anew: its parameters, state and sleep timer, no history.
fn fresh_body(body: &RigidBody, dt: f32) -> RigidBody {
    let pose = plus_zero_pose(body.position());
    let mut built = RigidBodyBuilder::new(body.body_type())
        .pose(pose)
        .linvel(plus_zero_vector(body.linvel()))
        .angvel(plus_zero_vector(body.angvel()))
        .linear_damping(body.linear_damping())
        .angular_damping(body.angular_damping())
        .gravity_scale(body.gravity_scale())
        .locked_axes(body.locked_axes())
        .ccd_enabled(body.is_ccd_enabled())
        .soft_ccd_prediction(body.soft_ccd_prediction())
        .dominance_group(body.dominance_group())
        .gyroscopic_forces_enabled(body.gyroscopic_forces_enabled())
        .enabled(body.is_enabled())
        .user_data(body.user_data)
        .build();
    let old = body.activation();
    let activation = activation_at(old, pose_before(body, dt)).unwrap_or_else(|| {
        let mut fallback = RigidBodyActivation::active();
        fallback.normalized_linear_threshold = old.normalized_linear_threshold;
        fallback.angular_threshold = old.angular_threshold;
        fallback.time_until_sleep = old.time_until_sleep;
        fallback.time_since_can_sleep = old.time_since_can_sleep;
        fallback.sleeping = old.sleeping;
        fallback
    });
    *built.activation_mut() = activation;
    built
}

/// Copies body `handle` of `from` into `into` with its colliders, in their order; its new handle.
fn copy_body(from: &PhysicsWorld, into: &mut PhysicsWorld, handle: RigidBodyHandle) -> Option<RigidBodyHandle> {
    let body = from.bodies.get(handle)?;
    let copied = into.insert_body(fresh_body(body, from.integration_parameters.dt));
    for collider in body.colliders() {
        let Some(collider) = from.colliders.get(*collider) else { continue };
        into.insert_collider(collider.clone(), Some(copied));
    }
    Some(copied)
}

/// An empty world stepping as `like` does.
fn empty_like(like: &PhysicsWorld) -> PhysicsWorld {
    let mut world = PhysicsWorld::new();
    world.gravity = like.gravity;
    world.integration_parameters = like.integration_parameters;
    world
}

impl Template {
    /// A fresh world holding the template's pieces, stepping as `like` does.
    fn instance(&self, like: &PhysicsWorld) -> PhysicsWorld {
        let mut world = empty_like(like);
        world.islands = self.world.islands.clone();
        world.broad_phase = self.world.broad_phase.clone();
        world.narrow_phase = self.world.narrow_phase.clone();
        world.bodies = self.world.bodies.clone();
        world.colliders = self.world.colliders.clone();
        world.impulse_joints = self.world.impulse_joints.clone();
        world.multibody_joints = self.world.multibody_joints.clone();
        world.soft_bodies = self.world.soft_bodies.clone();
        world
    }
}

/// Whether a collider reports events (a sensor, or `events: true`).
fn reports(collider: &Collider) -> bool {
    collider.active_events().contains(ActiveEvents::COLLISION_EVENTS)
}

fn raw_pair(c1: &Collider, c2: &Collider) -> RawPair {
    RawPair { first: collider_id(c1), second: collider_id(c2), sensors: [c1.is_sensor(), c2.is_sensor()] }
}

impl RapierBackend {
    /// The static pieces of `static_tags`, rebuilt into a template.
    fn make_template(&self, static_tags: &[u64]) -> Template {
        let mut world = empty_like(&self.world);
        let anchor = world.insert_body(RigidBodyBuilder::fixed());
        let by_tag: BTreeMap<u64, RigidBodyHandle> = self
            .world
            .bodies
            .iter()
            .filter(|(handle, _)| *handle != self.anchor)
            .map(|(handle, body)| ((body.user_data >> TAG_SHIFT) as u64, handle))
            .collect();
        for tag in static_tags {
            if let Some(handle) = by_tag.get(tag) {
                copy_body(&self.world, &mut world, *handle);
            }
        }
        world.detect_collisions(&(), &());
        Template { tags: static_tags.to_vec(), anchor, world }
    }

    /// Every touching or intersecting pair that reports events.
    pub(super) fn touching_pairs(&self) -> Vec<RawPair> {
        let colliders = &self.world.colliders;
        let mut out = Vec::new();
        for pair in self.world.contact_pairs() {
            let (Some(c1), Some(c2)) = (colliders.get(pair.collider1), colliders.get(pair.collider2)) else { continue };
            if pair.has_any_active_contact() && (reports(c1) || reports(c2)) {
                out.push(raw_pair(c1, c2));
            }
        }
        for (_, c1, _, c2, intersecting) in self.world.intersection_pairs() {
            if intersecting && (reports(c1) || reports(c2)) {
                out.push(raw_pair(c1, c2));
            }
        }
        out
    }

    /// The rebuild (`Backend::rebuild`).
    pub(super) fn rebuild_world(
        &mut self,
        static_tags: &[u64],
        bodies: &[RigidBodyHandle],
        joints: &[RebuiltJoint<'_, RigidBodyHandle>],
    ) -> (Vec<RigidBodyHandle>, Vec<u64>) {
        let template = match self.template.take() {
            Some(template) if template.tags == static_tags => template,
            _ => Box::new(self.make_template(static_tags)),
        };
        let mut world = template.instance(&self.world);
        let mut moved = BTreeMap::new();
        let mut handles = Vec::with_capacity(bodies.len());
        for old in bodies {
            let Some(new) = copy_body(&self.world, &mut world, *old) else { continue };
            moved.insert(old.into_raw_parts(), new);
            handles.push(new);
        }
        let anchor = template.anchor;
        let mut edits = Vec::with_capacity(joints.len());
        let mut ids = Vec::with_capacity(joints.len());
        for (id, (a, b, spec)) in (0u64..).zip(joints) {
            let second = moved.get(&a.into_raw_parts()).copied();
            let first = b.map_or(Some(anchor), |b| moved.get(&b.into_raw_parts()).copied());
            if let (Some(first), Some(second)) = (first, second) {
                edits.push(JointEdit::Insert { id, first, second, spec: (*spec).clone() });
            }
            ids.push(id);
        }
        self.world = world;
        self.anchor = anchor;
        self.stale = handles.iter().map(|handle| (handle.into_raw_parts(), *handle)).collect();
        self.joints = BTreeMap::new();
        self.next_joint = ids.len() as u64;
        self.edits = edits;
        self.template = Some(template);
        (handles, ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_activation_image_is_rapier_s_own_form() {
        let pose = Pose::from_parts(Vector::new(1.5, -2.0, 3.25), Rotation::from_xyzw(0.0, 0.6, 0.0, 0.8));
        let mut activation = RigidBodyActivation::active();
        activation.time_since_can_sleep = 0.375;
        activation.angular_threshold = 0.25;
        let made = activation_at(&activation, pose).expect("Rapier reads the image back");
        let written = postcard::to_allocvec(&made).expect("writes");
        let read: ActivationImage = postcard::from_bytes(&written).expect("the image reads Rapier's form back");
        let expected = ActivationImage {
            normalized_linear_threshold: activation.normalized_linear_threshold,
            angular_threshold: 0.25,
            time_until_sleep: activation.time_until_sleep,
            time_since_can_sleep: 0.375,
            sleeping: false,
            sleep_prev_pose: pose,
        };
        assert_eq!(read, expected, "every field lands where Rapier keeps it, the previous pose included");
    }
}
