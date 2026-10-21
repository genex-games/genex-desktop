//! Foot placement on slopes and foot locking (AN-11).
//!
//! Two halves, so the simulation and the pose agree:
//!
//! - [`FootPlacer::plant`] runs in the simulation after the animator's update. It evaluates only
//!   the leg chains of the local pose (the feet's ancestors: at most [`PLANT_JOINTS_MAX`] joints,
//!   counted by [`FootPlacer::sampled`]), casts the game's `ground` probe under each ankle, and
//!   keeps each foot's lock. It returns a [`FootPlan`]: an ankle goal and a tilt per foot and a
//!   pelvis offset, all in character (model) space.
//! - [`apply_plan`] is the evaluation's step 6 (foot IK) over a full pose: it lowers the pelvis,
//!   bends each leg onto its goal with the two-bone solver ([`crate::ik`]), and turns each foot
//!   onto the ground.
//!
//! The rules:
//!
//! - A foot's goal keeps its animated clearance over the ground, measured along the ground's
//!   normal: the ankle sits `h / cos(slope)` above the hit straight below it, where `h` is its
//!   animated height over the model's floor. A planted foot (animated at its rest height) then
//!   has its sole on the slope, and on flat ground at the floor the goal is the animated ankle.
//! - The foot turns from the character's up to the ground's normal, clamped to
//!   [`FootSettings::max_tilt`] (30° by default), eased in and out with the contact.
//! - The pelvis drops by the lower foot's offset, never by the higher one's, and never rises:
//!   the controller holds the capsule on the ground, so only the lower foot needs more reach.
//! - Foot locking is Daniel Holden's (Motion-Matching `controller.cpp`, `contact_update`, MIT,
//!   Copyright (c) 2021 Daniel Holden; altered for AoS glam scalar Rust): when a contact turns on,
//!   the foot locks where it stands; while locked its goal stays there in the world; when the
//!   contact lifts, or the animated foot moves past [`FootSettings::unlock_radius`] from the lock,
//!   it lets go. Each switch starts an inertialized offset (source minus destination, with the
//!   velocities) that decays as a critically damped spring ([`crate::inertial::decay_spring`]),
//!   so the goal never jumps.
//!
//! A probe that finds nothing (or answers a point or normal that is not finite, or a normal that
//! does not face up) leaves that foot alone and drops its lock; with neither foot found the plan
//! is [`FootPlan::NONE`] and [`apply_plan`] changes nothing, bit for bit. Everything is plain
//! arithmetic over glam's libm and Holden's `fast_negexp`, so a placer replays to the same bits on
//! every destination, and [`FootPlacer::snapshot`] / [`FootPlacer::restore`] carry its state.

use genex_core::digest::FNV_OFFSET_BASIS;
use genex_core::json::Value;
use glam::{Mat4, Quat, Vec3};

use crate::character::GroundHit;
use crate::error::AnimationError;
use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::JointId;
use crate::ik::{DEFAULT_SOFTEN, TwoBoneChain, TwoBoneIk, apply_two_bone};
use crate::inertial::{decay_spring, fast_negexp, floats_digest};
use crate::math::{Trs, normalize_quat};
use crate::skeleton::Skeleton;

/// The most joints [`FootPlacer::plant`] evaluates: the feet's ancestors on a humanoid rig (UE
/// mannequin and UAL: root, pelvis, then thigh, calf and foot per side, 8; Mixamo: 7).
pub const PLANT_JOINTS_MAX: usize = 12;

/// The steepest a foot turns to the ground by default: 30°, in radians.
pub const MAX_FOOT_TILT: f32 = core::f32::consts::FRAC_PI_6;

/// The half-life of the lock's offset and of the tilt's easing, in seconds.
pub const DEFAULT_LOCK_HALFLIFE: f32 = 0.1;

/// How far the animated foot may move from its lock before the lock lets go, in metres
/// (Holden's `ik_unlock_radius`).
pub const DEFAULT_UNLOCK_RADIUS: f32 = 0.2;

/// How far above the ankle the ground probe starts, in metres.
pub const DEFAULT_PROBE_UP: f32 = 0.5;

/// How far below the ankle the ground probe reaches, in metres.
pub const DEFAULT_PROBE_DOWN: f32 = 1.0;

/// The step [`height_ground`] takes each side of a point to find the slope, in metres.
pub const HEIGHT_NORMAL_STEP: f32 = 0.05;

/// The snapshot format [`FootPlacer::snapshot`] writes and [`FootPlacer::restore`] reads.
pub const FOOT_SNAPSHOT_VERSION: u32 = 1;

/// A ground normal whose up component is at most this does not carry a foot.
const MIN_GROUND_FACING: f32 = 1e-3;

/// Holden's epsilon on the finite-difference velocity's step.
const VELOCITY_EPSILON: f32 = 1e-8;

/// Floats one foot's state holds: the lock point, the last input, the offset and its velocity
/// (3 each), the tilt weight, then the contact, locked and primed flags as 0 or 1.
const FOOT_NUMBERS: usize = 16;

/// A foot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Foot {
    /// The left foot.
    Left,
    /// The right foot.
    Right,
}

impl Foot {
    /// Both feet, left first: the order of every per-foot array here.
    pub const ALL: [Foot; 2] = [Foot::Left, Foot::Right];

    /// The foot's slot in per-foot arrays.
    pub const fn index(self) -> usize {
        match self {
            Foot::Left => 0,
            Foot::Right => 1,
        }
    }

    const fn bones(self) -> [HumanoidBone; 3] {
        match self {
            Foot::Left => [HumanoidBone::LeftUpperLeg, HumanoidBone::LeftLowerLeg, HumanoidBone::LeftFoot],
            Foot::Right => [HumanoidBone::RightUpperLeg, HumanoidBone::RightLowerLeg, HumanoidBone::RightFoot],
        }
    }
}

/// How feet are placed and locked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FootSettings {
    /// The steepest a foot turns to the ground, radians.
    pub max_tilt: f32,
    /// The half-life of the lock's offset and the tilt's easing, seconds.
    pub lock_halflife: f32,
    /// How far the animated foot may move from its lock before it lets go, metres.
    pub unlock_radius: f32,
    /// How far above the ankle the probe starts, metres.
    pub probe_up: f32,
    /// How far below the ankle the probe reaches, metres.
    pub probe_down: f32,
}

impl Default for FootSettings {
    fn default() -> FootSettings {
        FootSettings {
            max_tilt: MAX_FOOT_TILT,
            lock_halflife: DEFAULT_LOCK_HALFLIFE,
            unlock_radius: DEFAULT_UNLOCK_RADIUS,
            probe_up: DEFAULT_PROBE_UP,
            probe_down: DEFAULT_PROBE_DOWN,
        }
    }
}

/// A rig's legs, found once from its humanoid map: shared by every placer of the rig.
#[derive(Clone, Debug, PartialEq)]
pub struct FootRig {
    legs: [TwoBoneChain; 2],
    pelvis: JointId,
    /// The feet's ancestors and the feet, parents first, each once.
    path: Vec<JointId>,
    /// Per joint of `path`: its parent joint, or for a root its non-joint ancestors' frame at rest.
    parents: Vec<PathParent>,
    /// Joints in the skeleton (the scratch's length).
    joint_count: usize,
    ankle_heights: [f32; 2],
}

/// What a path joint's model matrix starts from.
#[derive(Clone, Copy, Debug, PartialEq)]
enum PathParent {
    /// Its parent joint's model matrix (an earlier path joint).
    Joint(usize),
    /// A root's frame at rest.
    Frame(Mat4),
}

impl FootRig {
    /// The legs of `skeleton` under `humanoid`; `None` when the map lacks the hips or a thigh,
    /// shin or foot, or a foot is not below its shin and thigh.
    pub fn of(skeleton: &Skeleton, humanoid: &HumanoidMap) -> Option<FootRig> {
        let pelvis = humanoid.joint(HumanoidBone::Hips)?;
        let leg = |foot: Foot| -> Option<TwoBoneChain> {
            let [start, mid, end] = foot.bones().map(|bone| humanoid.joint(bone));
            Some(TwoBoneChain { start: start?, mid: mid?, end: end?, mid_axis: Vec3::X })
        };
        let legs = [leg(Foot::Left)?, leg(Foot::Right)?];
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let mut path = Vec::new();
        for chain in &legs {
            let ancestors = lineage(skeleton, chain.end);
            if !ancestors.contains(&chain.start) || !ancestors.contains(&chain.mid) {
                return None;
            }
            path.extend(ancestors);
        }
        path.sort_unstable();
        path.dedup();
        let parents = path
            .iter()
            .map(|joint| {
                let index = usize::from(joint.raw());
                match skeleton.parent(*joint) {
                    Some(parent) => PathParent::Joint(usize::from(parent.raw())),
                    None => PathParent::Frame(rest[index] * skeleton.rest_pose()[index].matrix().inverse()),
                }
            })
            .collect();
        let ankle_heights = legs.map(|chain| rest[usize::from(chain.end.raw())].w_axis.y.max(0.0));
        Some(FootRig { legs, pelvis, path, parents, joint_count: skeleton.joint_count(), ankle_heights })
    }

    /// The joints [`FootPlacer::plant`] evaluates, parents first.
    pub fn path(&self) -> &[JointId] {
        &self.path
    }

    /// A foot's ankle joint.
    pub fn ankle(&self, foot: Foot) -> JointId {
        self.legs[foot.index()].end
    }

    /// The hips.
    pub fn pelvis(&self) -> JointId {
        self.pelvis
    }

    /// How high a foot's ankle stands over the model's floor at rest: over its sole, for a rig
    /// modelled standing on its origin.
    pub fn ankle_height(&self, foot: Foot) -> f32 {
        self.ankle_heights[foot.index()]
    }
}

/// `joint` and its ancestors, root first.
fn lineage(skeleton: &Skeleton, joint: JointId) -> Vec<JointId> {
    let mut chain = vec![joint];
    let mut current = joint;
    while let Some(parent) = skeleton.parent(current) {
        chain.push(parent);
        current = parent;
    }
    chain.reverse();
    chain
}

/// Where one foot should go, character (model) space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FootGoal {
    /// The ankle's goal.
    pub ankle: Vec3,
    /// The turn onto the ground, applied to the foot's animated model-space rotation.
    pub tilt: Quat,
    /// The goal is a lock (the foot holds its place in the world).
    pub locked: bool,
}

/// What [`FootPlacer::plant`] decided, for [`apply_plan`]: character (model) space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FootPlan {
    /// How far the pelvis moves (down the character's up, or zero).
    pub pelvis: Vec3,
    /// Each foot's goal, by [`Foot::index`]; `None` where the probe found no ground.
    pub feet: [Option<FootGoal>; 2],
}

impl FootPlan {
    /// No placement: the pose is left as it is.
    pub const NONE: FootPlan = FootPlan { pelvis: Vec3::ZERO, feet: [None, None] };

    /// Nothing to place.
    pub fn is_empty(&self) -> bool {
        self.feet.iter().all(Option::is_none) && self.pelvis == Vec3::ZERO
    }
}

impl Default for FootPlan {
    fn default() -> FootPlan {
        FootPlan::NONE
    }
}

/// One foot's lock, world space (Holden's contact state).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct FootLock {
    /// The contact the last plant saw.
    contact: bool,
    /// The foot holds `point`.
    locked: bool,
    /// The lock point.
    point: Vec3,
    /// The last input goal (for its velocity), once `primed`.
    input: Vec3,
    primed: bool,
    /// The inertialized offset added to the goal, and its velocity.
    offset: Vec3,
    offset_velocity: Vec3,
    /// How much of the tilt shows, eased toward the contact.
    tilt: f32,
}

impl FootLock {
    fn numbers(&self) -> [f32; FOOT_NUMBERS] {
        let flag = |on: bool| if on { 1.0 } else { 0.0 };
        let [p, i, o, v] = [self.point, self.input, self.offset, self.offset_velocity].map(|vector| vector.to_array());
        [p[0], p[1], p[2], i[0], i[1], i[2], o[0], o[1], o[2], v[0], v[1], v[2], self.tilt, flag(self.contact), flag(self.locked), flag(self.primed)]
    }

    fn from_numbers(n: &[f32]) -> Result<FootLock, String> {
        if n.len() != FOOT_NUMBERS {
            return Err(format!("{} numbers for a foot, not {FOOT_NUMBERS}", n.len()));
        }
        if !(0.0..=1.0).contains(&n[12]) {
            return Err("the tilt weight is outside 0..1".to_owned());
        }
        let vector = |at: usize| Vec3::new(n[at], n[at + 1], n[at + 2]);
        Ok(FootLock {
            point: vector(0),
            input: vector(3),
            offset: vector(6),
            offset_velocity: vector(9),
            tilt: n[12],
            contact: flag(n[13], "contact")?,
            locked: flag(n[14], "locked")?,
            primed: flag(n[15], "primed")?,
        })
    }

    /// Forget everything: no lock, no offset.
    fn release(&mut self) {
        *self = FootLock::default();
    }

    /// Holden's `contact_update` over one tick: `input` is where the animation puts the foot on
    /// the ground, world space; the answer is the goal (the lock or the input, plus the offset).
    fn update(&mut self, input: Vec3, contact: bool, settings: &FootSettings, dt: f32) -> Vec3 {
        let first = !self.primed;
        let input_velocity = if first { Vec3::ZERO } else { (input - self.input) / (dt + VELOCITY_EPSILON) };
        self.input = input;
        self.primed = true;
        decay_spring(&mut self.offset, &mut self.offset_velocity, settings.lock_halflife, dt);
        let held = if self.locked { self.point } else { input };
        let position = held + self.offset;
        let too_far = self.locked && self.point.distance(input) > settings.unlock_radius;
        if !self.contact && contact {
            // Lock where the foot stands now; the offset carries the input's motion into the stop.
            self.locked = true;
            self.point = position;
            self.transition(input, input_velocity, self.point, Vec3::ZERO);
        } else if (self.locked && self.contact && !contact) || too_far {
            self.locked = false;
            self.transition(self.point, Vec3::ZERO, input, input_velocity);
        }
        self.contact = contact;
        self.ease_tilt(contact, settings.lock_halflife, dt, first);
        let held = if self.locked { self.point } else { input };
        held + self.offset
    }

    /// Ease the tilt's weight toward 1 in contact and 0 out of it; a first plant takes it as is.
    fn ease_tilt(&mut self, contact: bool, halflife: f32, dt: f32, first: bool) {
        let weight = if contact { 1.0 } else { 0.0 };
        if first {
            self.tilt = weight;
            return;
        }
        let keep = fast_negexp(core::f32::consts::LN_2 / halflife.max(f32::MIN_POSITIVE) * dt);
        self.tilt = (weight + (self.tilt - weight) * keep).clamp(0.0, 1.0);
    }

    /// Holden's `inertialize_transition`: the offset absorbs the step from source to destination.
    fn transition(&mut self, source: Vec3, source_velocity: Vec3, destination: Vec3, destination_velocity: Vec3) {
        self.offset += source - destination;
        self.offset_velocity += source_velocity - destination_velocity;
    }
}

/// A snapshot flag: 0 or 1.
fn flag(value: f32, what: &str) -> Result<bool, String> {
    match value {
        0.0 => Ok(false),
        1.0 => Ok(true),
        _ => Err(format!("the {what} flag is not 0 or 1")),
    }
}

/// One character's foot placement state: each foot's lock and the last plan. A world holds it
/// beside the animator; it is simulation state, saved with [`FootPlacer::snapshot`].
#[derive(Clone, Debug, PartialEq)]
pub struct FootPlacer {
    settings: FootSettings,
    locks: [FootLock; 2],
    plan: FootPlan,
    /// Model matrices of the rig's path joints (other slots are stale), reused every plant.
    model: Vec<Mat4>,
    sampled: usize,
}

impl FootPlacer {
    /// A placer with no lock.
    pub fn new(settings: FootSettings) -> FootPlacer {
        FootPlacer { settings, locks: [FootLock::default(); 2], plan: FootPlan::NONE, model: Vec::new(), sampled: 0 }
    }

    /// Its settings.
    pub fn settings(&self) -> &FootSettings {
        &self.settings
    }

    /// The last plan.
    pub fn plan(&self) -> &FootPlan {
        &self.plan
    }

    /// Joints the last [`FootPlacer::plant`] evaluated.
    pub fn sampled(&self) -> usize {
        self.sampled
    }

    /// The foot holds a lock.
    pub fn is_locked(&self, foot: Foot) -> bool {
        self.locks[foot.index()].locked
    }

    /// Drop both locks and offsets (after a teleport or a seed).
    pub fn clear(&mut self) {
        self.locks = [FootLock::default(); 2];
        self.plan = FootPlan::NONE;
    }

    /// Plan the feet of a character placed at `model` (character to world) whose local pose is
    /// `pose`, one tick of `dt` after the last plan: see the module docs. `contacts` says which
    /// feet the animation has down (AN-6's foot contacts); `ground(from, to)` answers where the
    /// segment meets the ground, world space (`Character::ground_ray` with `physics`, or
    /// [`height_ground`] over a terrain's height). Samples only the rig's path joints.
    pub fn plant(&mut self, rig: &FootRig, pose: &[Trs], model: Mat4, contacts: [bool; 2], dt: f32, mut ground: impl FnMut(Vec3, Vec3) -> Option<GroundHit>) -> FootPlan {
        let dt = if dt.is_finite() && dt > 0.0 { dt } else { 0.0 };
        self.plan = FootPlan::NONE;
        self.sample(rig, pose);
        let up_world = model.transform_vector3(Vec3::Y);
        let scale = up_world.length();
        let inverse = model.inverse();
        if !(scale.is_finite() && scale > 0.0 && inverse.is_finite()) {
            self.locks.iter_mut().for_each(FootLock::release);
            return self.plan;
        }
        let up = up_world / scale;
        let turn = model.to_scale_rotation_translation().1;
        let mut lowest = 0.0f32;
        for foot in Foot::ALL {
            let ankle = self.model[usize::from(rig.ankle(foot).raw())].w_axis.truncate();
            let world = model.transform_point3(ankle);
            let lock = &mut self.locks[foot.index()];
            let Some(hit) = usable_hit(ground(world + up * self.settings.probe_up, world - up * self.settings.probe_down), up) else {
                lock.release();
                continue;
            };
            let input = hit.point + up * (ankle.y * scale / hit.normal.dot(up));
            let goal = lock.update(input, contacts[foot.index()], &self.settings, dt);
            lowest = lowest.min((goal - world).dot(up));
            let tilt = Quat::IDENTITY.slerp(clamped_turn(up, hit.normal, self.settings.max_tilt), lock.tilt);
            let ankle_goal = inverse.transform_point3(goal);
            self.plan.feet[foot.index()] = Some(FootGoal { ankle: ankle_goal, tilt: normalize_quat(turn.inverse() * tilt * turn), locked: lock.locked });
        }
        if self.plan.feet.iter().any(Option::is_some) {
            self.plan.pelvis = inverse.transform_vector3(up * lowest);
        }
        self.plan
    }

    /// The model matrices of the rig's path joints from `pose`, into the scratch.
    fn sample(&mut self, rig: &FootRig, pose: &[Trs]) {
        self.model.resize(rig.joint_count, Mat4::IDENTITY);
        self.sampled = 0;
        for (joint, parent) in rig.path.iter().zip(&rig.parents) {
            let index = usize::from(joint.raw());
            let Some(local) = pose.get(index) else { continue };
            let parent = match parent {
                PathParent::Joint(parent) => self.model[*parent],
                PathParent::Frame(frame) => *frame,
            };
            self.model[index] = parent * local.matrix();
            self.sampled += 1;
        }
    }

    /// FNV-1a 64 over the state a save carries: both feet's locks (the plan is the last plant's
    /// answer, made again by the next one).
    pub fn digest(&self) -> u64 {
        self.locks.iter().fold(FNV_OFFSET_BASIS, |hash, lock| floats_digest(&lock.numbers(), hash))
    }

    /// Both feet's locks as a value, every float as its bits. The plan is not saved: the next
    /// plant makes it again from the restored locks.
    pub fn snapshot(&self) -> Value {
        let mut out = Value::object();
        out.set("version", Value::from(FOOT_SNAPSHOT_VERSION));
        out.set("feet", Value::Array(self.locks.iter().flat_map(FootLock::numbers).map(|number| Value::from(number.to_bits())).collect()));
        out
    }

    /// Restore a [`FootPlacer::snapshot`]. Refused `animation-asset-invalid`, with the placer
    /// unchanged: another version, a count other than both feet's, a number that is not finite,
    /// or a flag that is not 0 or 1. The plan is empty until the next plant.
    pub fn restore(&mut self, snapshot: &Value) -> Result<(), AnimationError> {
        let locks = read_locks(snapshot).map_err(|detail| AnimationError::asset_invalid(format!("foot snapshot: {detail}")))?;
        self.locks = locks;
        self.plan = FootPlan::NONE;
        Ok(())
    }
}

fn read_locks(snapshot: &Value) -> Result<[FootLock; 2], String> {
    match snapshot.get("version") {
        Some(Value::Number(number)) if *number == f64::from(FOOT_SNAPSHOT_VERSION) => {}
        _ => return Err(format!("not version {FOOT_SNAPSHOT_VERSION}")),
    }
    let Some(Value::Array(items)) = snapshot.get("feet") else { return Err("no feet".to_owned()) };
    if items.len() != 2 * FOOT_NUMBERS {
        return Err(format!("{} numbers, not {}", items.len(), 2 * FOOT_NUMBERS));
    }
    let mut numbers = Vec::with_capacity(items.len());
    for item in items {
        let bits = match item {
            Value::Number(number) if number.fract() == 0.0 && *number >= 0.0 && *number <= f64::from(u32::MAX) => *number as u32,
            _ => return Err("a number is not a whole u32".to_owned()),
        };
        let number = f32::from_bits(bits);
        if !number.is_finite() {
            return Err("a number is not finite".to_owned());
        }
        numbers.push(number);
    }
    Ok([FootLock::from_numbers(&numbers[..FOOT_NUMBERS])?, FootLock::from_numbers(&numbers[FOOT_NUMBERS..])?])
}

/// `hit` when it can carry a foot: a finite point and a finite normal facing `up`, normalized.
fn usable_hit(hit: Option<GroundHit>, up: Vec3) -> Option<GroundHit> {
    let hit = hit?;
    let normal = hit.normal.normalize_or_zero();
    let carries = hit.point.is_finite() && normal.is_finite() && normal.dot(up) > MIN_GROUND_FACING;
    carries.then_some(GroundHit { point: hit.point, normal })
}

/// The shortest turn from `up` to `normal`, at most `limit` radians.
fn clamped_turn(up: Vec3, normal: Vec3, limit: f32) -> Quat {
    let turn = Quat::from_rotation_arc(up, normal);
    let (axis, angle) = turn.to_axis_angle();
    let limit = if limit.is_finite() { limit.max(0.0) } else { 0.0 };
    if angle <= limit { turn } else { Quat::from_axis_angle(axis, limit) }
}

/// The evaluation's foot IK (step 6): apply `plan` to `pose`, whose model matrices `model` must
/// be current. The pelvis moves by `plan.pelvis`, each leg with a goal bends onto it (the knee
/// keeps the side the animation gave it), and each foot with a goal turns by its tilt from its
/// animated rotation. True when anything changed; the joints below the feet (toes) catch up at
/// the caller's next local-to-model. An empty plan changes nothing.
pub fn apply_plan(skeleton: &Skeleton, rig: &FootRig, plan: &FootPlan, pose: &mut [Trs], model: &mut [Mat4]) -> bool {
    let count = skeleton.joint_count();
    if plan.is_empty() || pose.len() < count || model.len() < count {
        return false;
    }
    if plan.pelvis != Vec3::ZERO && plan.pelvis.is_finite() {
        let pelvis = usize::from(rig.pelvis.raw());
        let frame = model[pelvis] * pose[pelvis].matrix().inverse();
        let moved = frame.inverse().transform_vector3(plan.pelvis);
        if moved.is_finite() {
            pose[pelvis].translation += moved;
            skeleton.local_to_model(pose, model);
        }
    }
    for foot in Foot::ALL {
        let Some(goal) = plan.feet[foot.index()] else { continue };
        let chain = rig.legs[foot.index()];
        let end = usize::from(chain.end.raw());
        let animated = model[end].to_scale_rotation_translation().1;
        let ik = TwoBoneIk { target: goal.ankle, pole: knee_side(model, &chain), weight: 1.0, soften: DEFAULT_SOFTEN, twist: 0.0 };
        apply_two_bone(skeleton, &chain, &ik, pose, model);
        let solved = model[end].to_scale_rotation_translation().1;
        let correction = normalize_quat(solved.inverse() * goal.tilt * animated);
        let frame = model[end] * pose[end].matrix().inverse();
        if frame.is_finite() && correction.is_finite() {
            pose[end].rotation = normalize_quat(pose[end].rotation * correction);
            model[end] = frame * pose[end].matrix();
        }
    }
    true
}

/// The way the knee points: from the hip-to-ankle line to the knee, or the character's forward
/// (+Z) when the leg is straight.
fn knee_side(model: &[Mat4], chain: &TwoBoneChain) -> Vec3 {
    let at = |joint: JointId| model[usize::from(joint.raw())].w_axis.truncate();
    let (hip, knee, ankle) = (at(chain.start), at(chain.mid), at(chain.end));
    let line = (ankle - hip).normalize_or_zero();
    let side = ((knee - hip) - line * (knee - hip).dot(line)).normalize_or_zero();
    if side == Vec3::ZERO { Vec3::Z } else { side }
}

/// A ground probe over a height function (a terrain's `height(x, z)`, world space): the point is
/// the height straight below the probe's start, the normal from central differences
/// [`HEIGHT_NORMAL_STEP`] each side. `None` where any of the five heights is `None` or not
/// finite, or the point is outside the probe's span.
pub fn height_ground(height: impl Fn(f32, f32) -> Option<f32>) -> impl FnMut(Vec3, Vec3) -> Option<GroundHit> {
    move |from: Vec3, to: Vec3| {
        let at = |x: f32, z: f32| height(x, z).filter(|h| h.is_finite());
        let y = at(from.x, from.z)?;
        if !(from.y.min(to.y)..=from.y.max(to.y)).contains(&y) {
            return None;
        }
        let step = HEIGHT_NORMAL_STEP;
        let (east, west) = (at(from.x + step, from.z)?, at(from.x - step, from.z)?);
        let (north, south) = (at(from.x, from.z + step)?, at(from.x, from.z - step)?);
        let normal = Vec3::new(west - east, 2.0 * step, south - north).normalize_or_zero();
        Some(GroundHit { point: Vec3::new(from.x, y, from.z), normal })
    }
}
