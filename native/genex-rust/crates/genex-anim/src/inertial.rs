//! Inertialization: the offset decay that hides a pose switch.
//!
//! Ported from Daniel Holden's Spring-It-On (`springdamper.c`, `inertialization.c`,
//! `deadblending.c`) and Motion-Matching (`controller.cpp`, `spring.h`), MIT, Copyright (c) 2021
//! Daniel Holden; altered for AoS glam scalar Rust. On a switch the offset is the visible pose
//! minus the next state's pose, moving at the visible pose's velocity; every tick after that the
//! offset decays as a critically damped spring of half-life `h` (`decay_spring_damper_exact`) and
//! is added onto the next state's pose. Only the next state is evaluated, so a switch costs one
//! pose a tick where a crossfade costs two, and a switch in the middle of another one folds the
//! old offset into the new one.
//!
//! Translations and scales offset by difference, rotations by `offset × next = visible` in the
//! parent's frame (Holden's order), kept as a scaled axis so the spring is linear. The next
//! state's velocity at the switch is taken as zero, as Bollo's inertialization does, so the
//! switch tick evaluates the next state once and never twice. `fast_negexp` is Holden's rational
//! approximation of `exp(-x)`: plain arithmetic, so every destination decays to the same bits.

use genex_core::digest::fnv1a64_from;
use glam::{Quat, Vec3};

use crate::math::{Trs, normalize_quat, same_hemisphere};

/// A blend's half-life per second of its length: when the blend's seconds have passed, a still
/// offset is under 3 % of where it started, and it keeps decaying from there with no step.
pub const HALFLIFE_PER_BLEND_SECOND: f32 = 0.25;

/// An offset whose every part (metres, radians, scale units and their velocities) is under this
/// is cleared: the step it leaves is below anything a frame shows.
pub const SETTLED: f32 = 1e-4;

/// How fast a dead-blended velocity fades: its half-life in seconds.
pub const DEAD_BLEND_HALFLIFE: f32 = 0.05;

/// The fastest a joint part is taken to move (metres, radians or scale units per second): a pose
/// that jumps further in one tick is a cut, not a motion to carry on.
pub const MAX_SPEED: f32 = 100.0;

/// The shortest step a velocity is measured over, in seconds; a shorter one keeps the last
/// velocity rather than dividing a rounding error by almost nothing.
pub const MIN_VELOCITY_STEP: f32 = 1e-4;

/// Holden's `halflife_to_damping` epsilon: a half-life of 0 still gives a finite damping.
const DAMPING_EPSILON: f32 = 1e-5;

/// The damping of a critically damped spring with half-life `halflife` seconds (Holden).
pub fn halflife_to_damping(halflife: f32) -> f32 {
    4.0 * core::f32::consts::LN_2 / (halflife.max(0.0) + DAMPING_EPSILON)
}

/// Holden's rational approximation of `exp(-x)` for `x >= 0`: in `(0, 1]`, 1 at 0.
pub fn fast_negexp(x: f32) -> f32 {
    1.0 / (1.0 + x + 0.48 * x * x + 0.235 * x * x * x)
}

/// One critically damped step of `dt` seconds toward zero (Holden's `decay_spring_damper_exact`).
/// A step so long that nothing stays finite has decayed to rest.
pub fn decay_spring(x: &mut Vec3, v: &mut Vec3, halflife: f32, dt: f32) {
    let y = halflife_to_damping(halflife) / 2.0;
    let j1 = *v + *x * y;
    let eydt = fast_negexp(y * dt);
    let next = ((*x + j1 * dt) * eydt, (*v - j1 * (y * dt)) * eydt);
    (*x, *v) = if next.0.is_finite() && next.1.is_finite() { next } else { (Vec3::ZERO, Vec3::ZERO) };
}

/// `dt` is a step the springs can take: positive and finite.
fn usable(dt: f32) -> bool {
    dt.is_finite() && dt > 0.0
}

/// How one joint's local transform moves per second.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JointVelocity {
    /// Metres per second.
    pub translation: Vec3,
    /// Radians per second as a scaled axis in the parent's frame.
    pub angular: Vec3,
    /// Scale units per second.
    pub scale: Vec3,
}

impl JointVelocity {
    /// Not moving.
    pub const ZERO: JointVelocity = JointVelocity { translation: Vec3::ZERO, angular: Vec3::ZERO, scale: Vec3::ZERO };

    fn is_finite(&self) -> bool {
        self.translation.is_finite() && self.angular.is_finite() && self.scale.is_finite()
    }
}

/// The rotation from `from` to `to` in the parent's frame (`delta × from = to`), the short way,
/// as a scaled axis.
pub fn rotation_delta(from: Quat, to: Quat) -> Vec3 {
    let delta = normalize_quat(to * from.inverse());
    same_hemisphere(delta, Quat::IDENTITY).to_scaled_axis()
}

/// Each joint's velocity from `previous` to `current` over `dt` seconds, into `out`, each part
/// held to [`MAX_SPEED`]. A `dt` that is not positive and finite, or a velocity that would not be
/// finite, writes zero; a step shorter than [`MIN_VELOCITY_STEP`] leaves `out` as it was.
pub fn velocities(previous: &[Trs], current: &[Trs], dt: f32, out: &mut [JointVelocity]) {
    if usable(dt) && dt < MIN_VELOCITY_STEP {
        return;
    }
    for ((out, previous), current) in out.iter_mut().zip(previous).zip(current) {
        if !usable(dt) {
            *out = JointVelocity::ZERO;
            continue;
        }
        let inverse = 1.0 / dt;
        let velocity = JointVelocity {
            translation: ((current.translation - previous.translation) * inverse).clamp_length_max(MAX_SPEED),
            angular: (rotation_delta(previous.rotation, current.rotation) * inverse).clamp_length_max(MAX_SPEED),
            scale: ((current.scale - previous.scale) * inverse).clamp_length_max(MAX_SPEED),
        };
        *out = if velocity.is_finite() { velocity } else { JointVelocity::ZERO };
    }
}

/// `pose` carried `dt` seconds forward by `velocity`, in place (a joint that would stop being
/// finite keeps its transform).
pub fn extrapolate(pose: &mut [Trs], velocity: &[JointVelocity], dt: f32) {
    if !usable(dt) {
        return;
    }
    for (trs, velocity) in pose.iter_mut().zip(velocity) {
        let moved = Trs {
            translation: trs.translation + velocity.translation * dt,
            rotation: normalize_quat(Quat::from_scaled_axis(velocity.angular * dt) * trs.rotation),
            scale: trs.scale + velocity.scale * dt,
        };
        if moved.is_finite() {
            *trs = moved;
        }
    }
}

/// Velocities faded by one dead-blending step of `dt` seconds (Holden's `deadblending.c`), with
/// half-life [`DEAD_BLEND_HALFLIFE`].
pub fn fade_velocities(velocity: &mut [JointVelocity], dt: f32) {
    if !usable(dt) {
        return;
    }
    let keep = fast_negexp(core::f32::consts::LN_2 / DEAD_BLEND_HALFLIFE * dt);
    for velocity in velocity {
        velocity.translation *= keep;
        velocity.angular *= keep;
        velocity.scale *= keep;
    }
}

/// One joint's offset and its velocity.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JointOffset {
    /// Translation offset, metres.
    pub translation: Vec3,
    /// Its velocity.
    pub translation_velocity: Vec3,
    /// Rotation offset as a scaled axis in the parent's frame.
    pub rotation: Vec3,
    /// Its velocity.
    pub angular_velocity: Vec3,
    /// Scale offset.
    pub scale: Vec3,
    /// Its velocity.
    pub scale_velocity: Vec3,
}

impl JointOffset {
    fn parts(&self) -> [Vec3; 6] {
        [self.translation, self.translation_velocity, self.rotation, self.angular_velocity, self.scale, self.scale_velocity]
    }

    fn settled(&self) -> bool {
        self.parts().iter().all(|part| part.abs().max_element() < SETTLED)
    }

    fn is_finite(&self) -> bool {
        self.parts().iter().all(|part| part.is_finite())
    }
}

/// A pose's offset decaying toward zero: the state of an inertialized switch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InertialOffset {
    joints: Vec<JointOffset>,
    halflife: f32,
    active: bool,
}

impl InertialOffset {
    /// No offset.
    pub fn new() -> InertialOffset {
        InertialOffset::default()
    }

    /// The half-life for a blend of `seconds` ([`HALFLIFE_PER_BLEND_SECOND`]); 0 for a blend
    /// that is not positive and finite.
    pub fn halflife_for(seconds: f32) -> f32 {
        if seconds.is_finite() { seconds.max(0.0) * HALFLIFE_PER_BLEND_SECOND } else { 0.0 }
    }

    /// Start a switch from the visible pose `source`, moving at `velocity`, onto `target`, the
    /// next state's pose this tick: right after, `apply` on `target` gives `source` back. A
    /// half-life that is not positive and finite clears instead (a cut), and a joint whose offset
    /// would not be finite gets none.
    pub fn start(&mut self, source: &[Trs], velocity: &[JointVelocity], target: &[Trs], halflife: f32) {
        self.clear();
        if !usable(halflife) {
            return;
        }
        for (index, (source, target)) in source.iter().zip(target).enumerate() {
            let velocity = velocity.get(index).copied().unwrap_or(JointVelocity::ZERO);
            let offset = JointOffset {
                translation: source.translation - target.translation,
                translation_velocity: velocity.translation,
                rotation: rotation_delta(target.rotation, source.rotation),
                angular_velocity: velocity.angular,
                scale: source.scale - target.scale,
                scale_velocity: velocity.scale,
            };
            self.joints.push(if offset.is_finite() { offset } else { JointOffset::default() });
        }
        self.halflife = halflife;
        self.active = true;
    }

    /// Decay every joint's offset by `dt` seconds; once every part is under [`SETTLED`] the offset
    /// clears.
    pub fn update(&mut self, dt: f32) {
        if !self.active || !usable(dt) {
            return;
        }
        let halflife = self.halflife;
        for joint in &mut self.joints {
            decay_spring(&mut joint.translation, &mut joint.translation_velocity, halflife, dt);
            decay_spring(&mut joint.rotation, &mut joint.angular_velocity, halflife, dt);
            decay_spring(&mut joint.scale, &mut joint.scale_velocity, halflife, dt);
        }
        if self.joints.iter().all(JointOffset::settled) {
            self.clear();
        }
    }

    /// Add the offset onto `pose` in place; with no offset the pose is untouched, bit for bit.
    pub fn apply(&self, pose: &mut [Trs]) {
        if !self.active {
            return;
        }
        for (trs, offset) in pose.iter_mut().zip(&self.joints) {
            trs.translation += offset.translation;
            trs.rotation = normalize_quat(Quat::from_scaled_axis(offset.rotation) * trs.rotation);
            trs.scale += offset.scale;
        }
    }

    /// Drop the offset.
    pub fn clear(&mut self) {
        self.joints.clear();
        self.halflife = 0.0;
        self.active = false;
    }

    /// An offset is decaying.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// The decay's half-life in seconds (0 with no offset).
    pub fn halflife(&self) -> f32 {
        self.halflife
    }

    /// Each joint's offset (empty with no offset).
    pub fn joints(&self) -> &[JointOffset] {
        &self.joints
    }

    /// The largest translation, rotation or scale part of any joint's offset (0 with none).
    pub fn magnitude(&self) -> f32 {
        let largest = |joint: &JointOffset| joint.translation.abs().max_element().max(joint.rotation.abs().max_element()).max(joint.scale.abs().max_element());
        self.joints.iter().map(largest).fold(0.0, f32::max)
    }

    /// The offset's bits folded into an FNV-1a 64 `hash`.
    pub fn digest_from(&self, hash: u64) -> u64 {
        let mut hash = fnv1a64_from(&[u8::from(self.active)], hash);
        hash = fnv1a64_from(&self.halflife.to_bits().to_le_bytes(), hash);
        for joint in &self.joints {
            for part in joint.parts() {
                hash = vec3_digest(part, hash);
            }
        }
        hash
    }
}

/// A vector's bits folded into an FNV-1a 64 `hash`.
pub(crate) fn vec3_digest(vector: Vec3, hash: u64) -> u64 {
    floats_digest(&vector.to_array(), hash)
}

/// Floats' bits, little-endian, folded into an FNV-1a 64 `hash` (byte by byte, so equal to
/// hashing them concatenated).
pub(crate) fn floats_digest(values: &[f32], hash: u64) -> u64 {
    values.iter().fold(hash, |hash, value| fnv1a64_from(&value.to_bits().to_le_bytes(), hash))
}
