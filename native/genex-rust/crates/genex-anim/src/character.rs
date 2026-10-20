//! The character controller: a capsule that walks, climbs steps, slides down steep ground, jumps
//! and lands, driven each tick by root motion, a wished velocity or a mix of both.
//!
//! Two movers share one state and one motion model:
//!
//! - [`Character::drive`] (behind `physics`) sweeps a kinematic capsule through a Rapier world
//!   with Rapier's `KinematicCharacterController` (autostep, snap to ground, slope limits, slide
//!   along walls; Apache-2.0, adopted from the lock). The capsule is a kinematic body in that
//!   world, so dynamic bodies feel it.
//! - [`Character::drive_on`] needs no physics: it follows a height function such as
//!   `terrain.height`, with the same step, snap, slope and jump rules, so a game built without
//!   physics still walks its characters.
//!
//! The motion model (accel, decel, turn rate, gravity, jump) takes its defaults from the measured
//! parameter set of Genex's earlier C++ character helper (ideas only). Everything is f32
//! arithmetic and glam's libm in a fixed order, so a script replays bit for bit on every
//! destination; [`Character::snapshot`] / [`Character::restore`] carry the whole state (floats as
//! their bits), and a restored kinematic character replays the uninterrupted run.
#![cfg_attr(
    not(feature = "physics"),
    doc = "\nThe physics calls are not in a build without `physics`:\n\n```compile_fail\nlet mut world = rapier3d::prelude::PhysicsWorld::default();\nlet _ = genex_anim::character::Character::spawn(&mut world, glam::Vec3::ZERO, Default::default());\n```"
)]

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use genex_core::json::Value;
use glam::{Quat, Vec2, Vec3};

use crate::math::Trs;
use crate::root_motion::RootMotion;

/// The snapshot format [`Character::snapshot`] writes and [`Character::restore`] reads.
pub const SNAPSHOT_VERSION: u32 = 1;
/// The gap the capsule keeps from what it touches, in metres (Rapier's controller `offset`).
pub const CHARACTER_SKIN: f32 = 0.01;
/// The fastest a character falls, in metres per second.
pub const TERMINAL_FALL_SPEED: f32 = 60.0;
/// A wish or root motion shorter than this (metres per tick) does not turn the character.
const TURN_EPSILON: f32 = 1.0e-6;
/// The span of the one-sided differences [`Character::drive_on`] takes the ground's slope with.
const SLOPE_PROBE: f32 = 0.05;
/// The largest step a parameter set may name, in metres.
const STEP_HEIGHT_MAX: f32 = 2.0;
/// The largest radius or height a parameter set may name, in metres.
const SIZE_MAX: f32 = 100.0;

/// Why a character call refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum CharacterErrorCode {
    /// A capsule or parameter set that cannot move: a value that is not finite, a radius or
    /// height of zero or less (or above 100 m), a height below twice the radius, a slope outside
    /// (0°, 90°), a step outside [0, 2] m, a negative snap, gravity, jump, accel, decel or turn
    /// rate, feet that are not finite, or a snapshot of another version or parameter set.
    ShapeInvalid,
}

impl CharacterErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [CharacterErrorCode; 1] = [CharacterErrorCode::ShapeInvalid];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            CharacterErrorCode::ShapeInvalid => "character-shape-invalid",
        }
    }
}

/// A refused character call: the code and what was wrong, for a person to read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterError {
    /// What was refused.
    pub code: CharacterErrorCode,
    /// The detail (values, field names), never matched on.
    pub detail: String,
}

impl CharacterError {
    /// A `character-shape-invalid` refusal.
    pub fn shape_invalid(detail: impl Into<String>) -> CharacterError {
        CharacterError { code: CharacterErrorCode::ShapeInvalid, detail: detail.into() }
    }
}

impl std::fmt::Display for CharacterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for CharacterError {}

/// A character's capsule and motion model.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CharacterParams {
    /// Capsule radius, metres.
    pub radius: f32,
    /// Capsule height from feet to crown, metres (at least twice the radius).
    pub height: f32,
    /// The steepest ground it walks up, degrees; steeper ground slides it down.
    pub max_slope_degrees: f32,
    /// The highest step it climbs without jumping, metres.
    pub step_height: f32,
    /// How far down it sticks to the ground while walking (down stairs and slopes), metres.
    pub snap_to_ground: f32,
    /// Downward acceleration, metres per second squared.
    pub gravity: f32,
    /// Upward speed a jump starts with, metres per second.
    pub jump_speed: f32,
    /// How fast the planar velocity reaches a faster wish, metres per second squared.
    pub accel: f32,
    /// How fast the planar velocity drops to a slower wish, metres per second squared.
    pub decel: f32,
    /// How fast it turns toward the wished direction, radians per second.
    pub turn_rate: f32,
}

impl Default for CharacterParams {
    /// The C++ helper's measured set: radius 0.35, height 1.8, slope 45°, step 0.3, snap 0.2,
    /// gravity 22, jump 7, accel 24, decel 30, turn 12 rad/s.
    fn default() -> Self {
        CharacterParams {
            radius: 0.35,
            height: 1.8,
            max_slope_degrees: 45.0,
            step_height: 0.3,
            snap_to_ground: 0.2,
            gravity: 22.0,
            jump_speed: 7.0,
            accel: 24.0,
            decel: 30.0,
            turn_rate: 12.0,
        }
    }
}

impl CharacterParams {
    /// `Ok` when the capsule and the motion model can move (see [`CharacterErrorCode::ShapeInvalid`]).
    pub fn check(&self) -> Result<(), CharacterError> {
        let numbers = self.numbers();
        if let Some((name, value)) = PARAM_NAMES.iter().zip(numbers).find(|(_, value)| !value.is_finite()) {
            return Err(CharacterError::shape_invalid(format!("{name} is {value}, not a finite number")));
        }
        if !(self.radius > 0.0 && self.radius <= SIZE_MAX) {
            return Err(CharacterError::shape_invalid(format!("radius {} is outside (0, {SIZE_MAX}] m", self.radius)));
        }
        if !(self.height >= 2.0 * self.radius && self.height <= SIZE_MAX) {
            return Err(CharacterError::shape_invalid(format!("height {} is below twice the radius {} or above {SIZE_MAX} m", self.height, self.radius)));
        }
        if !(self.max_slope_degrees > 0.0 && self.max_slope_degrees < 90.0) {
            return Err(CharacterError::shape_invalid(format!("max_slope_degrees {} is outside (0, 90)", self.max_slope_degrees)));
        }
        if !(0.0..=STEP_HEIGHT_MAX).contains(&self.step_height) {
            return Err(CharacterError::shape_invalid(format!("step_height {} is outside [0, {STEP_HEIGHT_MAX}] m", self.step_height)));
        }
        if let Some((name, value)) = PARAM_NAMES.iter().zip(numbers).skip(4).find(|(_, value)| *value < 0.0) {
            return Err(CharacterError::shape_invalid(format!("{name} is {value}, below zero")));
        }
        Ok(())
    }

    /// The fields in declaration order (a snapshot's shape).
    fn numbers(&self) -> [f32; 10] {
        [self.radius, self.height, self.max_slope_degrees, self.step_height, self.snap_to_ground, self.gravity, self.jump_speed, self.accel, self.decel, self.turn_rate]
    }

    /// The steepest walkable slope, radians.
    fn max_slope(&self) -> f32 {
        self.max_slope_degrees.to_radians()
    }

    /// Half the length of the capsule's straight part.
    #[cfg_attr(not(feature = "physics"), allow(dead_code))]
    fn half_segment(&self) -> f32 {
        0.5 * self.height - self.radius
    }
}

/// [`CharacterParams`]' field names in declaration order.
const PARAM_NAMES: [&str; 10] = ["radius", "height", "max_slope_degrees", "step_height", "snap_to_ground", "gravity", "jump_speed", "accel", "decel", "turn_rate"];

/// What moves the character this tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CharacterMotion {
    /// The animation's root motion (character space, +Z forward): the clip moves the capsule.
    Root(RootMotion),
    /// A wished planar velocity in the world (its y is ignored), reached at the accel and decel
    /// rates; the character turns toward it. `jump` jumps when standing on walkable ground.
    Velocity {
        /// Metres per second in the world.
        wish: Vec3,
        /// Jump this tick.
        jump: bool,
    },
    /// Both: `root_share` (0..=1) of the root motion plus the rest of the velocity's move (nav
    /// steering with clip-driven feet).
    Mixed {
        /// The animation's root motion.
        root: RootMotion,
        /// Metres per second in the world.
        wish: Vec3,
        /// Jump this tick.
        jump: bool,
        /// How much of the move the root motion makes, clamped to 0..=1.
        root_share: f32,
    },
}

/// What one drive did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CharacterStep {
    /// The feet's move this tick, metres.
    pub moved: Vec3,
    /// Standing on ground after the move.
    pub grounded: bool,
    /// On ground steeper than the max slope, sliding down it.
    pub sliding: bool,
    /// It touched down this tick.
    pub landed: bool,
    /// It left the ground this tick (a jump, a ledge).
    pub left_ground: bool,
}

/// The walker numbers a navigation bake must share with this controller: the capsule, the
/// highest climb and the steepest slope. The facade turns them into genex-nav's `NavConfig`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavFit {
    /// Capsule radius, metres.
    pub radius: f32,
    /// Capsule height, metres.
    pub height: f32,
    /// The highest step it climbs, metres.
    pub climb: f32,
    /// The steepest walkable slope, degrees.
    pub slope_degrees: f32,
}

/// Where a ground probe met the ground.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroundHit {
    /// The point on the ground, world space.
    pub point: Vec3,
    /// The ground's unit normal there.
    pub normal: Vec3,
}

/// One character's controller state. A world holds it; a seed makes it again.
#[derive(Clone, Debug, PartialEq)]
pub struct Character {
    params: CharacterParams,
    feet: Vec3,
    yaw: f32,
    /// Planar velocity, metres per second (y is always 0).
    planar: Vec3,
    /// Vertical speed, metres per second (up is positive).
    vertical: f32,
    grounded: bool,
    sliding: bool,
    /// Spawned and not driven yet: its world may not have stepped since its level was built.
    settling: bool,
    #[cfg(feature = "physics")]
    body: Option<physics::Body>,
}

/// The planar part of a tick's move and whether it asked to jump.
struct Planned {
    planar: Vec3,
    jump: bool,
}

impl Character {
    /// A character standing at `feet`, facing +Z, with no physics world: it moves with
    /// [`Character::drive_on`]. Refused `character-shape-invalid` for parameters that cannot move
    /// or feet that are not finite.
    pub fn on_ground(feet: Vec3, params: CharacterParams) -> Result<Character, CharacterError> {
        params.check()?;
        if !feet.is_finite() {
            return Err(CharacterError::shape_invalid(format!("feet {feet} are not finite")));
        }
        Ok(Character {
            params,
            feet,
            yaw: 0.0,
            planar: Vec3::ZERO,
            vertical: 0.0,
            grounded: true,
            sliding: false,
            settling: false,
            #[cfg(feature = "physics")]
            body: None,
        })
    }

    /// The parameters it was made with.
    pub fn params(&self) -> CharacterParams {
        self.params
    }

    /// Where its feet are (the bottom of the capsule, less the skin).
    pub fn feet(&self) -> Vec3 {
        self.feet
    }

    /// Its heading about +Y, radians in [-π, π] (0 faces +Z).
    pub fn yaw(&self) -> f32 {
        self.yaw
    }

    /// Its heading as a rotation about +Y.
    pub fn facing(&self) -> Quat {
        Quat::from_rotation_y(self.yaw)
    }

    /// Feet and facing as a transform, for drawing and for the animator's model space.
    pub fn transform(&self) -> Trs {
        Trs { translation: self.feet, rotation: self.facing(), scale: Vec3::ONE }
    }

    /// Its velocity: planar plus vertical, metres per second.
    pub fn velocity(&self) -> Vec3 {
        Vec3::new(self.planar.x, self.vertical, self.planar.z)
    }

    /// Standing on ground.
    pub fn grounded(&self) -> bool {
        self.grounded
    }

    /// On ground steeper than the max slope, sliding down it.
    pub fn sliding(&self) -> bool {
        self.sliding
    }

    /// The climb and slope a navigation bake must use so its paths are walkable by this
    /// controller (the facade's `Character::nav_config()`).
    pub fn nav_fit(&self) -> NavFit {
        NavFit { radius: self.params.radius, height: self.params.height, climb: self.params.step_height, slope_degrees: self.params.max_slope_degrees }
    }

    /// Move over `ground(x, z) -> height` with no physics: climbs rises up to the step height,
    /// sticks to drops up to the snap distance, slides down ground steeper than the max slope,
    /// jumps and falls under gravity. There are no walls: a game without physics blocks movement
    /// itself (or uses navigation).
    pub fn drive_on(&mut self, ground: impl Fn(f32, f32) -> f32, motion: CharacterMotion, dt: f32) -> CharacterStep {
        let dt = sanitize_dt(dt);
        let was_grounded = self.grounded;
        let start = self.feet;
        let plan = self.plan(motion, dt);
        let jumped = self.start_vertical(plan.jump, dt);
        let here = ground(start.x, start.z);
        let slope_here = ground_slope(&ground, start.x, start.z);
        self.sliding = self.grounded && !jumped && slope_here.angle > self.params.max_slope();
        let planar = if self.sliding { plan.planar + slope_here.downhill * (-self.vertical * dt) } else { plan.planar };
        let mut target = Vec3::new(start.x + planar.x, start.y, start.z + planar.z);
        let there = ground(target.x, target.z);
        let too_steep = there > here && ground_slope(&ground, target.x, target.z).angle > self.params.max_slope() && !self.sliding;
        let blocked = self.grounded && !jumped && (there - start.y > self.params.step_height || too_steep);
        if blocked {
            target.x = start.x;
            target.z = start.z;
        }
        let floor = if blocked { here } else { there };
        self.settle_on(floor, &mut target, jumped, dt);
        self.feet = target;
        self.finish(start, was_grounded)
    }

    /// Where a height-function mover ends vertically: on the floor, snapped to it, or in the air.
    fn settle_on(&mut self, floor: f32, target: &mut Vec3, jumped: bool, dt: f32) {
        let walking = self.grounded && !jumped && !self.sliding;
        if walking && floor >= target.y - self.params.snap_to_ground {
            target.y = floor;
            self.vertical = 0.0;
            return;
        }
        if self.sliding && floor <= target.y + self.params.step_height {
            target.y = floor;
            return;
        }
        target.y += self.vertical * dt;
        let touched = self.vertical <= 0.0 && target.y <= floor;
        if touched {
            target.y = floor;
            self.vertical = 0.0;
        }
        self.grounded = touched;
        self.sliding = false;
    }

    /// The tick's planar move and jump wish; turns the character and updates its planar velocity.
    fn plan(&mut self, motion: CharacterMotion, dt: f32) -> Planned {
        match motion {
            CharacterMotion::Root(root) => {
                let moved = planar_of(self.root_move(root, 1.0));
                self.planar = moved * (1.0 / dt);
                Planned { planar: moved, jump: false }
            }
            CharacterMotion::Velocity { wish, jump } => Planned { planar: self.velocity_move(wish, dt), jump },
            CharacterMotion::Mixed { root, wish, jump, root_share } => {
                let share = if root_share.is_nan() { 0.0 } else { root_share.clamp(0.0, 1.0) };
                let steered = self.velocity_move(wish, dt);
                let rooted = planar_of(self.root_move(root, share));
                Planned { planar: rooted * share + steered * (1.0 - share), jump }
            }
        }
    }

    /// Root motion at `share`: its translation from the tick's starting heading, then its turn.
    fn root_move(&mut self, root: RootMotion, share: f32) -> Vec3 {
        let moved = self.facing() * finite_or_zero(root.translation);
        let yaw = if root.yaw.is_finite() { root.yaw } else { 0.0 };
        self.yaw = wrap_angle(self.yaw + yaw * share);
        moved
    }

    /// Accelerate the planar velocity toward `wish`, turn toward it, and return this tick's move.
    fn velocity_move(&mut self, wish: Vec3, dt: f32) -> Vec3 {
        let target = planar_of(finite_or_zero(wish));
        let difference = target - self.planar;
        let rate = if target.length_squared() >= self.planar.length_squared() { self.params.accel } else { self.params.decel };
        let reach = rate * dt;
        let distance = difference.length();
        self.planar = if distance <= reach { target } else { self.planar + difference * (reach / distance) };
        if target.length() * dt > TURN_EPSILON {
            self.turn_toward(target, dt);
        }
        self.planar * dt
    }

    /// Turn toward `direction` (planar) by at most the turn rate.
    fn turn_toward(&mut self, direction: Vec3, dt: f32) {
        let wanted = Vec2::new(direction.z, direction.x).to_angle();
        let delta = wrap_angle(wanted - self.yaw);
        let step = self.params.turn_rate * dt;
        self.yaw = if delta.abs() <= step { wanted } else { wrap_angle(self.yaw + step.copysign(delta)) };
    }

    /// Start the tick's vertical speed: a jump from walkable ground, a stop on it, or gravity in
    /// the air or on a slide. Returns whether it jumped.
    fn start_vertical(&mut self, jump: bool, dt: f32) -> bool {
        let standing = self.grounded && !self.sliding;
        if standing && jump {
            self.vertical = self.params.jump_speed;
            self.grounded = false;
            return true;
        }
        if standing {
            self.vertical = 0.0;
        }
        self.vertical = (self.vertical - self.params.gravity * dt).max(-TERMINAL_FALL_SPEED);
        false
    }

    /// The step report from where the tick started.
    fn finish(&self, start: Vec3, was_grounded: bool) -> CharacterStep {
        CharacterStep {
            moved: self.feet - start,
            grounded: self.grounded,
            sliding: self.sliding,
            landed: self.grounded && !was_grounded,
            left_ground: was_grounded && !self.grounded,
        }
    }

    /// FNV-1a 64 over the whole state's bits (replay rows).
    pub fn digest(&self) -> u64 {
        let mut hash = FNV_OFFSET_BASIS;
        for number in self.numbers() {
            hash = fnv1a64_from(&number.to_bits().to_le_bytes(), hash);
        }
        fnv1a64_from(&[u8::from(self.grounded), u8::from(self.sliding)], hash)
    }

    /// The state's floats in snapshot order: feet, yaw, planar x and z, vertical.
    fn numbers(&self) -> [f32; 7] {
        [self.feet.x, self.feet.y, self.feet.z, self.yaw, self.planar.x, self.planar.z, self.vertical]
    }

    /// The whole controller state as a value, every float as its bits. [`Character::restore`] on a
    /// character of the same parameters continues exactly where this one is.
    pub fn snapshot(&self) -> Value {
        let mut out = Value::object();
        out.set("version", Value::from(SNAPSHOT_VERSION));
        out.set("params", bits_value(&self.params.numbers()));
        out.set("state", bits_value(&self.numbers()));
        out.set("grounded", Value::from(self.grounded));
        out.set("sliding", Value::from(self.sliding));
        out
    }

    /// Restore a [`Character::snapshot`]. Refused `character-shape-invalid`, with the character
    /// unchanged: not a snapshot of this version, taken with other parameters, a field missing or
    /// of the wrong kind, or a float that is not finite. A physics body follows at the next drive.
    pub fn restore(&mut self, snapshot: &Value) -> Result<(), CharacterError> {
        let fail = |problem: &str| CharacterError::shape_invalid(format!("character snapshot: {problem}"));
        if !matches!(snapshot, Value::Object(_)) {
            return Err(fail("not an object"));
        }
        let version = snapshot.get("version").map_or(-1.0, |value| value.as_f64_or(-1.0));
        if version != f64::from(SNAPSHOT_VERSION) {
            return Err(fail(&format!("version {version}, this build reads {SNAPSHOT_VERSION}")));
        }
        let params = read_bits::<10>(snapshot.get("params")).ok_or_else(|| fail("params are not ten float bits"))?;
        if params.map(f32::to_bits) != self.params.numbers().map(f32::to_bits) {
            return Err(fail("taken from a character with other parameters"));
        }
        let state = read_bits::<7>(snapshot.get("state")).ok_or_else(|| fail("state is not seven float bits"))?;
        if state.iter().any(|number| !number.is_finite()) {
            return Err(fail("a state float is not finite"));
        }
        let (Some(Value::Bool(grounded)), Some(Value::Bool(sliding))) = (snapshot.get("grounded"), snapshot.get("sliding")) else {
            return Err(fail("grounded or sliding is not a boolean"));
        };
        self.feet = Vec3::new(state[0], state[1], state[2]);
        self.yaw = state[3];
        self.planar = Vec3::new(state[4], 0.0, state[5]);
        self.vertical = state[6];
        self.grounded = *grounded;
        self.sliding = *sliding;
        self.settling = false;
        Ok(())
    }
}

/// A tick length that moves nothing when it is not a positive finite number.
fn sanitize_dt(dt: f32) -> f32 {
    if dt.is_finite() && dt > 0.0 { dt } else { f32::MIN_POSITIVE }
}

fn finite_or_zero(vector: Vec3) -> Vec3 {
    if vector.is_finite() { vector } else { Vec3::ZERO }
}

fn planar_of(vector: Vec3) -> Vec3 {
    Vec3::new(vector.x, 0.0, vector.z)
}

/// `angle` in [-π, π] (libm through glam, so every destination agrees).
fn wrap_angle(angle: f32) -> f32 {
    Vec2::from_angle(angle).to_angle()
}

/// The ground's steepness at a point and the planar direction down it.
struct Slope {
    angle: f32,
    downhill: Vec3,
}

/// The ground's slope from one-sided differences of the height function: the gentler of the
/// forward and the backward slope, so the edge of a step (flat on one side) is a step, never a
/// steep slope.
fn ground_slope(ground: &impl Fn(f32, f32) -> f32, x: f32, z: f32) -> Slope {
    let here = ground(x, z);
    let forward = Vec2::new(ground(x + SLOPE_PROBE, z) - here, ground(x, z + SLOPE_PROBE) - here) / SLOPE_PROBE;
    let backward = Vec2::new(here - ground(x - SLOPE_PROBE, z), here - ground(x, z - SLOPE_PROBE)) / SLOPE_PROBE;
    let gradient = if forward.length_squared() <= backward.length_squared() { forward } else { backward };
    let rise = gradient.length();
    let angle = Vec2::new(1.0, rise).to_angle();
    let downhill = if rise > 0.0 && rise.is_finite() { Vec3::new(-gradient.x / rise, 0.0, -gradient.y / rise) } else { Vec3::ZERO };
    Slope { angle, downhill }
}

fn bits_value(numbers: &[f32]) -> Value {
    Value::Array(numbers.iter().map(|number| Value::from(number.to_bits())).collect())
}

fn read_bits<const N: usize>(value: Option<&Value>) -> Option<[f32; N]> {
    let Value::Array(items) = value? else { return None };
    if items.len() != N {
        return None;
    }
    let mut out = [0.0; N];
    for (slot, item) in out.iter_mut().zip(items) {
        let Value::Number(number) = item else { return None };
        let in_range = number.fract() == 0.0 && *number >= 0.0 && *number <= f64::from(u32::MAX);
        if !in_range {
            return None;
        }
        *slot = f32::from_bits(*number as u32);
    }
    Some(out)
}

#[cfg(feature = "physics")]
mod physics {
    //! The Rapier side: the kinematic capsule and the sweep.

    use glam::Vec3;
    use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
    use rapier3d::parry::shape::Capsule;
    use rapier3d::prelude::{
        ColliderBuilder, ColliderHandle, Group, InteractionGroups, InteractionTestMode, PhysicsWorld, Pose, QueryFilter, Ray, RigidBodyBuilder, RigidBodyHandle, ShapeCastHit,
    };

    use crate::ragdoll::RAGDOLL_GROUP;
    use rapier3d::parry::query::details::ShapeCastOptions;

    use super::{CHARACTER_SKIN, Character, CharacterError, CharacterMotion, CharacterParams, CharacterStep, GroundHit, sanitize_dt};

    /// A vertical move held back by more than this (metres) met the ground or a ceiling.
    const BLOCK_EPSILON: f32 = 1.0e-4;
    /// The free width a step must offer after climbing it, as a share of the radius.
    const STEP_WIDTH_SHARE: f32 = 0.5;
    /// How far the capsule rises before its planar sweep, metres: a sweep that grazes the ground
    /// at exactly the skin distance loses its move in Rapier's shape cast, so the planar move runs
    /// clear of the ground and a vertical sweep (with gravity and snap) puts the feet back down.
    const LIFT: f32 = 2.0 * CHARACTER_SKIN;
    /// A ray hit whose normal's up component is above this can carry the bottom sphere.
    const FACE_UP: f32 = 0.5;
    /// The most a drop by ray may differ from the shape cast's and still be the same face: past
    /// the cast's error, and well inside the skin, so an edge the cast met first is never pierced.
    const FACE_AGREEMENT: f32 = 0.2 * CHARACTER_SKIN;

    /// The capsule's body and collider in its world.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(super) struct Body {
        pub(super) body: RigidBodyHandle,
        pub(super) collider: ColliderHandle,
    }

    /// What one sweep did.
    struct Swept {
        moved: Vec3,
    }

    /// What every query of a character skips: its own body, sensors and ragdoll bodies (a
    /// character's own ragdoll stands where it does).
    fn query_filter<'a>(body: Option<Body>) -> QueryFilter<'a> {
        let groups = InteractionGroups::new(Group::ALL, Group::ALL.difference(RAGDOLL_GROUP), InteractionTestMode::And);
        let filter = QueryFilter::default().exclude_sensors().groups(groups);
        match body {
            Some(body) => filter.exclude_rigid_body(body.body),
            None => filter,
        }
    }

    impl Character {
        /// A character standing at `feet`, facing +Z, as a kinematic capsule in `physics`. Rapier's
        /// queries see a collider only after the world's next step, so a character spawned in the
        /// reset that built its level finds no ground at its first drive: that drive keeps it
        /// standing instead of letting it fall. Refused `character-shape-invalid` for parameters
        /// that cannot move or feet that are not finite.
        pub fn spawn(physics: &mut PhysicsWorld, feet: Vec3, params: CharacterParams) -> Result<Character, CharacterError> {
            let mut character = Character::on_ground(feet, params)?;
            let center = character.center(feet);
            let (body, collider) =
                physics.insert(RigidBodyBuilder::kinematic_position_based().translation(center), ColliderBuilder::capsule_y(params.half_segment(), params.radius));
            character.body = Some(Body { body, collider });
            character.settling = true;
            Ok(character)
        }

        /// Its body in the physics world (`None` for a character made with
        /// [`Character::on_ground`]).
        pub fn body(&self) -> Option<RigidBodyHandle> {
            self.body.map(|body| body.body)
        }

        /// Its capsule collider in the physics world.
        pub fn collider(&self) -> Option<ColliderHandle> {
            self.body.map(|body| body.collider)
        }

        /// Move through `physics` with Rapier's kinematic controller: walls stop and slide it,
        /// steps up to the step height are climbed, steep slopes slide it down, and the capsule's
        /// kinematic body follows at the world's next step. A character made with
        /// [`Character::on_ground`] moves over flat ground at its own height instead.
        ///
        /// Each tick the capsule rises clear of the ground, makes its planar move (Rapier's sweep
        /// with autostep and slope limits), then comes down: a walking character drops straight
        /// onto the ground below (within the snap distance), anything else sweeps down under
        /// gravity and slides on steep ground. A ray down from the capsule's centre tells walkable
        /// ground from a slope too steep to stand on (a step's edge under the capsule's rim is
        /// walkable).
        pub fn drive(&mut self, physics: &mut PhysicsWorld, motion: CharacterMotion, dt: f32) -> CharacterStep {
            let Some(body) = self.body else {
                let floor = self.feet.y;
                return self.drive_on(|_, _| floor, motion, dt);
            };
            let dt = sanitize_dt(dt);
            let was_grounded = self.grounded;
            let start = self.feet;
            self.sync_body(physics, body);
            let plan = self.plan(motion, dt);
            let jumped = self.start_vertical(plan.jump, dt);
            let walking = self.grounded && !self.sliding && !jumped;
            // Only a ceiling limits the lift: a wall the capsule leans on grazes the cast at once.
            let ceiling = self.cast(physics, body, start, Vec3::Y, LIFT).filter(|hit| hit.normal1.y < -FACE_UP);
            let lift = Vec3::Y * ceiling.map_or(LIFT, |hit| hit.time_of_impact);
            let planar = if plan.planar == Vec3::ZERO { Vec3::ZERO } else { self.sweep(physics, body, start + lift, plan.planar, dt).moved };
            let raised = lift + planar;
            let at = start + raised;
            let floor = if walking { self.drop_onto_ground(physics, body, at, raised.y + self.params.snap_to_ground) } else { None };
            let settling = std::mem::take(&mut self.settling);
            match floor {
                Some(drop) => {
                    self.feet = at - Vec3::Y * drop;
                    self.grounded = true;
                }
                None if settling && walking => self.feet = at - Vec3::Y * raised.y,
                None => self.fall(physics, body, at, raised.y, jumped, dt),
            }
            let walkable_up = glam::Vec2::from_angle(self.params.max_slope()).x;
            let support = if self.grounded { self.support_up(physics, body) } else { None };
            self.sliding = self.grounded && support.is_some_and(|up| up < walkable_up);
            if self.grounded && !self.sliding {
                self.vertical = 0.0;
            }
            if let Some(rigid) = physics.bodies.get_mut(body.body) {
                rigid.set_next_kinematic_translation(self.center(self.feet));
            }
            self.finish(start, was_grounded)
        }

        /// Sweep down under gravity from `at` (raised `raised` metres this tick): lands when the
        /// ground holds the fall, stops rising at a ceiling, slides along steep ground.
        fn fall(&mut self, physics: &PhysicsWorld, body: Body, at: Vec3, raised: f32, jumped: bool, dt: f32) {
            let desired = self.vertical * dt - raised;
            let swept = self.sweep(physics, body, at, Vec3::Y * desired, dt);
            self.feet = at + swept.moved;
            let held_up = swept.moved.y - desired > BLOCK_EPSILON;
            let held_down = desired - swept.moved.y > BLOCK_EPSILON;
            if held_down && self.vertical > 0.0 {
                self.vertical = 0.0;
            }
            self.grounded = !jumped && self.vertical <= 0.0 && held_up;
        }

        /// How far the capsule standing at `feet` drops straight down onto the ground, within
        /// `reach` metres (`None`: no ground that close).
        fn drop_onto_ground(&self, physics: &PhysicsWorld, body: Body, feet: Vec3, reach: f32) -> Option<f32> {
            let filter = query_filter(Some(body));
            let swept = self.cast(physics, body, feet, Vec3::NEG_Y, reach)?.time_of_impact;
            // The shape cast's time of impact is a root find (about 1e-5 m off). When the ground
            // straight below the bottom sphere is a face that the sphere rests on, a ray gives the
            // same drop exactly: the sphere's centre stops (radius + skin) / normal.y above it.
            let sphere = feet + Vec3::Y * (CHARACTER_SKIN + self.params.radius);
            let ray_reach = reach + 2.0 * (self.params.radius + CHARACTER_SKIN);
            let exact = physics.cast_ray_and_get_normal(&Ray::new(sphere, Vec3::NEG_Y), ray_reach, true, filter).and_then(|(_, hit)| {
                let up = hit.normal.y;
                (up > FACE_UP).then(|| hit.time_of_impact - (self.params.radius + CHARACTER_SKIN) / up)
            });
            Some(exact.filter(|drop| (drop - swept).abs() < FACE_AGREEMENT).unwrap_or(swept))
        }

        /// How far the capsule standing at `feet` moves along `direction` before it comes within
        /// the skin of something, within `reach`, and the hit (`None`: nothing that close).
        fn cast(&self, physics: &PhysicsWorld, body: Body, feet: Vec3, direction: Vec3, reach: f32) -> Option<ShapeCastHit> {
            let filter = query_filter(Some(body));
            let shape = Capsule::new_y(self.params.half_segment(), self.params.radius);
            let options = ShapeCastOptions { target_distance: CHARACTER_SKIN, stop_at_penetration: false, max_time_of_impact: reach, compute_impact_geometry_on_penetration: true };
            let (_, hit) = physics.query_pipeline_with_filter(filter).cast_shape(&Pose::from_translation(self.center(feet)), direction, &shape, options)?;
            Some(hit)
        }

        /// The up component of the ground's normal straight below the capsule's centre, within
        /// a step and a snap below the feet (`None`: nothing there, as on a step's edge).
        fn support_up(&self, physics: &PhysicsWorld, body: Body) -> Option<f32> {
            let filter = query_filter(Some(body));
            let center = self.center(self.feet);
            let reach = center.y - self.feet.y + self.params.step_height + self.params.snap_to_ground;
            let (_, hit) = physics.cast_ray_and_get_normal(&Ray::new(center, Vec3::NEG_Y), reach, true, filter)?;
            Some(hit.normal.y)
        }

        /// One KCC sweep of the capsule standing at `feet` by `desired`, excluding its own body and
        /// sensors.
        fn sweep(&self, physics: &PhysicsWorld, body: Body, feet: Vec3, desired: Vec3, dt: f32) -> Swept {
            let filter = query_filter(Some(body));
            let queries = physics.query_pipeline_with_filter(filter);
            let shape = Capsule::new_y(self.params.half_segment(), self.params.radius);
            let pose = Pose::from_translation(self.center(feet));
            let movement = self.controller().move_shape(dt, &queries, &shape, &pose, desired, |_| {});
            Swept { moved: movement.translation }
        }

        /// Rapier's controller with this character's numbers (it never snaps: the drop does).
        fn controller(&self) -> KinematicCharacterController {
            let params = self.params;
            KinematicCharacterController {
                offset: CharacterLength::Absolute(CHARACTER_SKIN),
                slide: true,
                autostep: Some(CharacterAutostep {
                    max_height: CharacterLength::Absolute(params.step_height),
                    min_width: CharacterLength::Absolute(params.radius * STEP_WIDTH_SHARE),
                    include_dynamic_bodies: false,
                }),
                max_slope_climb_angle: params.max_slope(),
                min_slope_slide_angle: params.max_slope(),
                snap_to_ground: None,
                ..KinematicCharacterController::default()
            }
        }

        /// The capsule's centre for feet at `feet`.
        fn center(&self, feet: Vec3) -> Vec3 {
            feet + Vec3::Y * (CHARACTER_SKIN + self.params.radius + self.params.half_segment())
        }

        /// Put the body where the state says (after a restore); a no-op when it is already there.
        fn sync_body(&self, physics: &mut PhysicsWorld, body: Body) {
            let center = self.center(self.feet);
            if let Some(rigid) = physics.bodies.get_mut(body.body)
                && rigid.translation().to_array().map(f32::to_bits) != center.to_array().map(f32::to_bits)
            {
                rigid.set_translation(center, false);
            }
        }

        /// A probe for foot placement: a ray from `from` to `to` against everything but this
        /// character and sensors.
        pub fn ground_ray<'a>(&self, physics: &'a PhysicsWorld) -> impl FnMut(Vec3, Vec3) -> Option<GroundHit> + 'a {
            let filter = query_filter(self.body);
            move |from: Vec3, to: Vec3| {
                let span = to - from;
                let length = span.length();
                if !(length.is_finite() && length > 0.0 && from.is_finite()) {
                    return None;
                }
                let ray = Ray::new(from, span / length);
                let (_, hit) = physics.cast_ray_and_get_normal(&ray, length, true, filter)?;
                Some(GroundHit { point: ray.point_at(hit.time_of_impact), normal: hit.normal })
            }
        }

        /// Take the capsule out of `physics`.
        pub fn remove(self, physics: &mut PhysicsWorld) {
            if let Some(body) = self.body {
                physics.remove_body(body.body);
            }
        }
    }
}
