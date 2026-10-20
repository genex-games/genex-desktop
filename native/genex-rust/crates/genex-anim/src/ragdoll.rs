//! Humanoid ragdolls over Rapier joints: build, follow, go limp, power, recover.
//!
//! Ported from Fyrox's `scene/ragdoll.rs` sync (MIT, logic only): while a body is animated it is a
//! kinematic body that follows its bone; once it goes limp it is a dynamic body, seeded with a
//! velocity on the activation tick, and the bone follows the body. A partial ragdoll is a limb's
//! subtree. Joints are not in Fyrox's file: they are generated here from the skeleton's rest pose
//! and a [`RagdollProfile`] (Rapier's generic joints, Apache-2.0, adopted from the lock): balls
//! with a swing cone and a twist, and hinges for knees and elbows whose bend direction is a model
//! space direction, so a rig's local axes never flip a knee. A powered body drives its joint's
//! motors toward the animated pose (hit reactions); [`Ragdoll::recover`] blends bodies back to the
//! animation over a time.
//!
//! Every ragdoll collider is in [`RAGDOLL_GROUP`] and collides with everything but that group (a
//! ragdoll's limbs do not collide with each other or with another ragdoll's), and the character
//! controller's sweeps skip the group, so a character's own ragdoll never blocks it. Bodies are
//! simulation state: a script replays to the same physics state digest bit for bit.

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use glam::{Mat4, Quat, Vec3};
use rapier3d::prelude::{
    ColliderBuilder, ColliderHandle, GenericJoint, GenericJointBuilder, Group, ImpulseJointHandle, InteractionGroups, InteractionTestMode, JointAxesMask,
    JointAxis, PhysicsWorld, Pose, RigidBodyBuilder, RigidBodyHandle, RigidBodyType,
};

use crate::animator::Animator;
use crate::error::AnimationError;
use crate::humanoid::HumanoidBone;
use crate::ids::JointId;
use crate::math::Trs;
use crate::ragdoll_profile::{RagdollJoint, RagdollProfile};

/// The collision group every ragdoll collider is in (and does not collide with).
pub const RAGDOLL_GROUP: Group = Group::GROUP_30;
/// A powered joint's motor stiffness at strength 1 (acceleration-based, 1/s²).
pub const RAGDOLL_MOTOR_STIFFNESS: f32 = 40000.0;
/// A powered joint's motor damping at strength 1 (acceleration-based, 1/s).
pub const RAGDOLL_MOTOR_DAMPING: f32 = 400.0;
/// A limp joint's damping, so limbs settle instead of swinging forever (1/s).
pub const RAGDOLL_LIMP_DAMPING: f32 = 0.5;
/// The shortest bone a body may span, metres.
const BONE_LENGTH_MIN: f32 = 1.0e-4;

/// Which bodies a call acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RagdollPart {
    /// Every body.
    Whole,
    /// The body that moves this bone and every body below it (a limb: `LeftUpperArm` is the
    /// whole left arm). A bone no body moves acts on nothing.
    Limb(HumanoidBone),
}

/// What a body is doing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RagdollMode {
    /// Kinematic, following its bone.
    Animated,
    /// Dynamic, no motor: the bone follows the body.
    Limp,
    /// Dynamic, its joint's motors chasing the animated pose at this strength.
    Powered(f32),
    /// Kinematic, blending from where it went back to its bone over `seconds`.
    Recovering {
        /// Seconds blended so far.
        elapsed: f32,
        /// Seconds the blend takes.
        seconds: f32,
    },
}

/// One body of a built ragdoll.
#[derive(Clone, Debug)]
struct Body {
    humanoid: HumanoidBone,
    joint_id: JointId,
    parent: Option<usize>,
    body: RigidBodyHandle,
    collider: ColliderHandle,
    joint: Option<ImpulseJointHandle>,
    kind: RagdollJoint,
    /// The joint frames' rotations in the parent's and in this body's frame.
    frame1: Quat,
    frame2: Quat,
    mode: RagdollMode,
    /// Where a recovery started.
    recover_from: Pose,
    /// The animated world pose at the last follow.
    target: Pose,
}

/// A humanoid ragdoll in a physics world. A world holds it; a seed makes it again.
#[derive(Clone, Debug)]
pub struct Ragdoll {
    bodies: Vec<Body>,
}

impl Ragdoll {
    /// Build the profile's bodies and joints in `physics` at the animator's current pose, every
    /// body animated (kinematic). Refused `ragdoll-profile-invalid`: a profile
    /// [`RagdollProfile::check`] refuses, a bone or tip the rig's humanoid map lacks, or a bone of
    /// (nearly) zero length.
    pub fn build(physics: &mut PhysicsWorld, animator: &Animator, model: Mat4, profile: &RagdollProfile) -> Result<Ragdoll, AnimationError> {
        profile.check()?;
        let set = animator.set();
        let skeleton = set.skeleton();
        let humanoid = set.humanoid();
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let joint_of = |bone: HumanoidBone| humanoid.joint(bone).ok_or_else(|| AnimationError::ragdoll_profile_invalid(format!("the rig has no {} bone", bone.name())));
        let mut plans = Vec::with_capacity(profile.parts().len());
        for spec in profile.parts() {
            let bone = joint_of(spec.bone)?;
            let tip = joint_of(spec.tip)?;
            let world = pose_of(model * animator.model_pose()[slot(bone)]);
            let tip_world = (model * animator.model_pose()[slot(tip)]).w_axis.truncate();
            let tip_local = world.rotation.inverse() * (tip_world - world.translation);
            let length = tip_local.length();
            if !(length.is_finite() && length > BONE_LENGTH_MIN) {
                return Err(AnimationError::ragdoll_profile_invalid(format!("{} to {} is {length} m long", spec.bone.name(), spec.tip.name())));
            }
            plans.push((bone, world, tip_local, length));
        }
        let groups = InteractionGroups::new(RAGDOLL_GROUP, Group::ALL.difference(RAGDOLL_GROUP), InteractionTestMode::And);
        let mut bodies: Vec<Body> = Vec::with_capacity(plans.len());
        for (spec, (bone, world, tip_local, length)) in profile.parts().iter().zip(plans) {
            let collider = ColliderBuilder::capsule_from_endpoints(Vec3::ZERO, tip_local, spec.radius_share * length)
                .mass(profile.mass() * spec.mass_share)
                .collision_groups(groups);
            let (body, collider) = physics.insert(RigidBodyBuilder::kinematic_position_based().pose(world), collider);
            let rest_rotation = rotation_of(rest[slot(bone)]);
            let (frame1, frame2) = match spec.parent {
                Some(parent) => joint_frames(spec.joint, rotation_of(rest[slot(bodies[parent].joint_id)]), rest_rotation, tip_local),
                None => (Quat::IDENTITY, Quat::IDENTITY),
            };
            let mut built = Body {
                humanoid: spec.bone,
                joint_id: bone,
                parent: spec.parent,
                body,
                collider,
                joint: None,
                kind: spec.joint,
                frame1,
                frame2,
                mode: RagdollMode::Animated,
                recover_from: world,
                target: world,
            };
            if let Some(parent) = spec.parent {
                let parent_pose = bodies[parent].target;
                let anchor = parent_pose.inverse_transform_point(world.translation);
                built.joint = Some(physics.insert_impulse_joint(bodies[parent].body, body, joint_for(spec.joint, anchor, frame1, frame2)));
            }
            bodies.push(built);
        }
        Ok(Ragdoll { bodies })
    }

    /// How many bodies it has.
    pub fn body_count(&self) -> usize {
        self.bodies.len()
    }

    /// The body moving `bone`: its rigid body handle (for a game's own forces and hit tests).
    pub fn body(&self, bone: HumanoidBone) -> Option<RigidBodyHandle> {
        self.bodies.iter().find(|body| body.humanoid == bone).map(|body| body.body)
    }

    /// The capsule collider of the body moving `bone`.
    pub fn collider(&self, bone: HumanoidBone) -> Option<ColliderHandle> {
        self.bodies.iter().find(|body| body.humanoid == bone).map(|body| body.collider)
    }

    /// What the body moving `bone` is doing.
    pub fn mode(&self, bone: HumanoidBone) -> Option<RagdollMode> {
        self.bodies.iter().find(|body| body.humanoid == bone).map(|body| body.mode)
    }

    /// The bodies `part` names: a limb's body and every body below it, in profile order.
    fn selected(&self, part: RagdollPart) -> Vec<bool> {
        let mut chosen = vec![false; self.bodies.len()];
        for index in 0..self.bodies.len() {
            chosen[index] = match part {
                RagdollPart::Whole => true,
                RagdollPart::Limb(bone) => self.bodies[index].humanoid == bone || self.bodies[index].parent.is_some_and(|parent| chosen[parent]),
            };
        }
        chosen
    }

    /// Read the animator's pose (after its update) into each body's target: animated bodies
    /// follow their bones at the world's next step, powered bodies' motors chase them, and
    /// recovering bodies blend toward them by one tick of the world's time step.
    pub fn follow(&mut self, physics: &mut PhysicsWorld, animator: &Animator, model: Mat4) {
        let dt = physics.integration_parameters.dt;
        for body in &mut self.bodies {
            body.target = pose_of(model * animator.model_pose()[slot(body.joint_id)]);
        }
        for index in 0..self.bodies.len() {
            let parent_target = self.bodies[index].parent.map(|parent| self.bodies[parent].target);
            let body = &mut self.bodies[index];
            match body.mode {
                RagdollMode::Animated => move_kinematic(physics, body.body, body.target),
                RagdollMode::Limp => {}
                RagdollMode::Powered(strength) => {
                    if let (Some(handle), Some(parent)) = (body.joint, parent_target) {
                        set_motors(physics, handle, body, parent, strength);
                    }
                }
                RagdollMode::Recovering { elapsed, seconds } => {
                    let done = elapsed + dt;
                    let share = if seconds > 0.0 { (done / seconds).min(1.0) } else { 1.0 };
                    let blended = Pose::from_parts(body.recover_from.translation.lerp(body.target.translation, share), body.recover_from.rotation.slerp(body.target.rotation, share));
                    move_kinematic(physics, body.body, blended);
                    body.mode = if share >= 1.0 { RagdollMode::Animated } else { RagdollMode::Recovering { elapsed: done, seconds } };
                }
            }
        }
    }

    /// Turn `part`'s bodies dynamic with no motor, each moving at `velocity` (m/s) and not
    /// spinning on this tick: the bones follow the bodies from now on.
    pub fn go_limp(&mut self, physics: &mut PhysicsWorld, part: RagdollPart, velocity: Vec3) {
        let velocity = if velocity.is_finite() { velocity } else { Vec3::ZERO };
        let selected = self.selected(part);
        for (body, chosen) in self.bodies.iter_mut().zip(selected) {
            if !chosen {
                continue;
            }
            body.mode = RagdollMode::Limp;
            if let Some(rigid) = physics.bodies.get_mut(body.body) {
                rigid.set_body_type(RigidBodyType::Dynamic, true);
                rigid.set_linvel(velocity, true);
                rigid.set_angvel(Vec3::ZERO, true);
            }
            if let Some(handle) = body.joint {
                limp_motors(physics, handle, body.kind);
            }
        }
    }

    /// Turn `part`'s bodies dynamic with their joints' motors chasing the animated pose at
    /// `strength` (0..=1, clamped): a hit pushes them and they pull back. The root body stays
    /// animated, so a powered whole body keeps its place.
    pub fn power(&mut self, physics: &mut PhysicsWorld, part: RagdollPart, strength: f32) {
        let strength = if strength.is_nan() { 0.0 } else { strength.clamp(0.0, 1.0) };
        let chosen = self.selected(part);
        for (index, &picked) in chosen.iter().enumerate() {
            let Some(parent) = self.bodies[index].parent.filter(|_| picked) else { continue };
            let parent_target = self.bodies[parent].target;
            let body = &mut self.bodies[index];
            body.mode = RagdollMode::Powered(strength);
            if let Some(rigid) = physics.bodies.get_mut(body.body) {
                rigid.set_body_type(RigidBodyType::Dynamic, true);
            }
            if let Some(handle) = body.joint {
                set_motors(physics, handle, body, parent_target, strength);
            }
        }
    }

    /// Bring `part`'s bodies back to the animation, blending from where they are over `seconds`
    /// (kinematic again; zero or less snaps at the next follow).
    pub fn recover(&mut self, physics: &mut PhysicsWorld, part: RagdollPart, seconds: f32) {
        let seconds = if seconds.is_finite() { seconds.max(0.0) } else { 0.0 };
        let selected = self.selected(part);
        for (body, chosen) in self.bodies.iter_mut().zip(selected) {
            if !chosen || matches!(body.mode, RagdollMode::Animated) {
                continue;
            }
            if let Some(rigid) = physics.bodies.get_mut(body.body) {
                body.recover_from = *rigid.position();
                rigid.set_body_type(RigidBodyType::KinematicPositionBased, true);
            }
            body.mode = RagdollMode::Recovering { elapsed: 0.0, seconds };
        }
    }

    /// The bodies' poses as the animation reads them (for drawing; read only).
    pub fn view<'a>(&'a self, physics: &'a PhysicsWorld) -> RagdollView<'a> {
        RagdollView { ragdoll: self, physics }
    }

    /// FNV-1a 64 over every body's position, rotation, linear and angular velocity bits, in
    /// profile order (replay rows).
    pub fn digest(&self, physics: &PhysicsWorld) -> u64 {
        let mut hash = FNV_OFFSET_BASIS;
        for body in &self.bodies {
            let Some(rigid) = physics.bodies.get(body.body) else { continue };
            let pose = rigid.position();
            let numbers = [pose.translation.to_array(), rigid.linvel().to_array(), rigid.angvel().to_array()];
            for number in numbers.iter().flatten().chain(pose.rotation.to_array().iter()) {
                hash = fnv1a64_from(&number.to_bits().to_le_bytes(), hash);
            }
        }
        hash
    }

    /// Take every body, collider and joint out of `physics`.
    pub fn remove(self, physics: &mut PhysicsWorld) {
        for body in self.bodies.iter().rev() {
            physics.remove_body(body.body);
        }
    }
}

/// A ragdoll's bodies as the presenter reads them.
#[derive(Clone, Copy)]
pub struct RagdollView<'a> {
    ragdoll: &'a Ragdoll,
    physics: &'a PhysicsWorld,
}

impl RagdollView<'_> {
    /// The world pose of the body moving `bone` (`None`: no body moves it).
    pub fn body_pose(&self, bone: HumanoidBone) -> Option<Trs> {
        let body = self.ragdoll.bodies.iter().find(|body| body.humanoid == bone)?;
        let pose = self.physics.bodies.get(body.body)?.position();
        Some(Trs { translation: pose.translation, rotation: pose.rotation, scale: Vec3::ONE })
    }

    /// The animator's model-space pose with the ragdoll over it: a bone whose body is limp,
    /// powered or recovering takes the body's pose (keeping its animated scale), the bones below
    /// it follow through their animated locals, and every other bone is the animated pose bit for
    /// bit. `out` holds one matrix per joint.
    pub fn apply(&self, animator: &Animator, model: Mat4, out: &mut [Mat4]) {
        let skeleton = animator.set().skeleton();
        let animated = animator.model_pose();
        let locals = animator.pose();
        let inverse_model = model.inverse();
        let mut moved = vec![false; skeleton.joint_count()];
        for (index, slot) in out.iter_mut().enumerate().take(skeleton.joint_count()) {
            *slot = animated[index];
        }
        for joint in skeleton.joints() {
            let index = slot(joint);
            if index >= out.len() {
                break;
            }
            let body = self.ragdoll.bodies.iter().find(|body| body.joint_id == joint && !matches!(body.mode, RagdollMode::Animated));
            if let Some(rigid) = body.and_then(|body| self.physics.bodies.get(body.body)) {
                let pose = rigid.position();
                let (scale, _, _) = animated[index].to_scale_rotation_translation();
                out[index] = inverse_model * Mat4::from_rotation_translation(pose.rotation, pose.translation) * Mat4::from_scale(scale);
                moved[index] = true;
                continue;
            }
            if let Some(parent) = skeleton.parent(joint).filter(|parent| moved[slot(*parent)]) {
                out[index] = out[slot(parent)] * locals[index].matrix();
                moved[index] = true;
            }
        }
    }
}

/// A joint's slot in pose arrays.
fn slot(joint: JointId) -> usize {
    usize::from(joint.raw())
}

/// A matrix's rotation and translation as a pose (its scale dropped).
fn pose_of(matrix: Mat4) -> Pose {
    let (_, rotation, translation) = matrix.to_scale_rotation_translation();
    Pose::from_parts(translation, rotation.normalize())
}

fn rotation_of(matrix: Mat4) -> Quat {
    pose_of(matrix).rotation
}

/// The joint frames' rotations in the parent's and the child's body frames, from the rest pose:
/// the frames coincide at rest, X is a ball's twist axis (along the bone) or a hinge's axis.
fn joint_frames(kind: RagdollJoint, parent_rest: Quat, child_rest: Quat, tip_local: Vec3) -> (Quat, Quat) {
    let along = tip_local.normalize();
    let frame2 = match kind {
        RagdollJoint::Hinge { toward, .. } => {
            let bone_model = child_rest * along;
            let axis_model = bone_model.cross(toward.normalize());
            let axis = if axis_model.length_squared() > 1.0e-8 { (child_rest.inverse() * axis_model).normalize() } else { Vec3::X };
            Quat::from_rotation_arc(Vec3::X, axis)
        }
        RagdollJoint::Ball { .. } | RagdollJoint::Root => Quat::from_rotation_arc(Vec3::X, along),
    };
    let frame1 = (parent_rest.inverse() * child_rest * frame2).normalize();
    (frame1, frame2)
}

/// The Rapier joint for a part: frames at the child's bone joint, limits from the profile.
fn joint_for(kind: RagdollJoint, anchor: Vec3, frame1: Quat, frame2: Quat) -> GenericJoint {
    let builder = |locked: JointAxesMask| {
        GenericJointBuilder::new(locked).local_frame1(Pose::from_parts(anchor, frame1)).local_frame2(Pose::from_parts(Vec3::ZERO, frame2)).contacts_enabled(false)
    };
    match kind {
        RagdollJoint::Hinge { max, .. } => builder(JointAxesMask::LOCKED_REVOLUTE_AXES).limits(JointAxis::AngX, [0.0, max]).build(),
        RagdollJoint::Ball { swing, twist } => builder(JointAxesMask::LOCKED_SPHERICAL_AXES)
            .limits(JointAxis::AngX, [-twist, twist])
            .limits(JointAxis::AngY, [-swing, swing])
            .limits(JointAxis::AngZ, [-swing, swing])
            .build(),
        RagdollJoint::Root => builder(JointAxesMask::LOCKED_FIXED_AXES).build(),
    }
}

/// The free angular axes of a joint kind.
fn free_axes(kind: RagdollJoint) -> &'static [JointAxis] {
    match kind {
        RagdollJoint::Hinge { .. } => &[JointAxis::AngX],
        RagdollJoint::Ball { .. } => &[JointAxis::AngX, JointAxis::AngY, JointAxis::AngZ],
        RagdollJoint::Root => &[],
    }
}

/// Motors off but a little damping, so a limp limb settles.
fn limp_motors(physics: &mut PhysicsWorld, handle: ImpulseJointHandle, kind: RagdollJoint) {
    let Some(joint) = physics.impulse_joints.get_mut(handle, true) else { return };
    for &axis in free_axes(kind) {
        joint.data.set_motor(axis, 0.0, 0.0, 0.0, RAGDOLL_LIMP_DAMPING);
    }
}

/// Motors chasing the body's animated pose relative to its parent's, at `strength`.
fn set_motors(physics: &mut PhysicsWorld, handle: ImpulseJointHandle, body: &Body, parent_target: Pose, strength: f32) {
    let relative = (body.frame1.inverse() * parent_target.rotation.inverse() * body.target.rotation * body.frame2).normalize();
    let targets = match body.kind {
        RagdollJoint::Hinge { .. } => Vec3::new(2.0 * glam::Vec2::new(relative.w, relative.x).to_angle(), 0.0, 0.0),
        _ => relative.to_scaled_axis(),
    };
    let Some(joint) = physics.impulse_joints.get_mut(handle, true) else { return };
    for (&axis, target) in free_axes(body.kind).iter().zip(targets.to_array()) {
        joint.data.set_motor(axis, target, 0.0, strength * RAGDOLL_MOTOR_STIFFNESS, strength * RAGDOLL_MOTOR_DAMPING);
    }
}

/// Send a kinematic body to `pose` at the world's next step.
fn move_kinematic(physics: &mut PhysicsWorld, handle: RigidBodyHandle, pose: Pose) {
    if let Some(rigid) = physics.bodies.get_mut(handle) {
        rigid.set_next_kinematic_position(pose);
    }
}
