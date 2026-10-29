//! Camera rigs (review WP-3, LOC-1..6): the motion a first-person or third-person view adds to
//! the eye, built so that no game can make it sickening.
//!
//! A rig is two halves. Its state advances in `on_update` from what the simulation already knows
//! (the body's velocity, the tick's turn, the `CharacterStep` a drive answered, a shot's recoil):
//! a pure function of the seed and the input, the same on every destination and every person.
//! Its view is applied in the camera hook, where the person's comfort settings scale it
//! ([`Comfort`]: `ui.head_bob`, `ui.screen_shake`, `ui.reduced_motion`, `graphics.fov_offset`).
//! The settings never reach the state, and a rig is never probed by default, so nothing the
//! person picks enters the checksum.
//!
//! The motion's rules, each a hard cap the rig enforces whatever the game asks:
//!
//! - **Cadence from a stride.** A step's length grows with speed (`0.45 + 0.28 × speed` metres),
//!   so the step rate rises slowly and never passes [`CADENCE_MAX_HZ`]: the vertical bob, one
//!   cycle per step, stays below 3 Hz at a sprint. Sway and roll run at half the step rate.
//! - **Smooth bob.** Every term is a sine of a continuous phase (no `|cos|` cusp at a footfall),
//!   and its size follows a smoothed speed, so starting a sprint grows it over about a third of a
//!   second instead of in one frame.
//! - **Caps.** Bob at most [`BOB_PEAK_TO_PEAK_MAX`] peak to peak, bob roll at most
//!   [`BOB_ROLL_MAX_DEG`], all roll together at most [`ROLL_TOTAL_MAX_DEG`], the sprint's field
//!   of view kick at most [`FOV_KICK_MAX_DEG`].
//! - **Springs** (closed-form, critically damped, the same at any `dt`) for a landing's dip, a
//!   shot's recoil, a turn's lean and the step up a stair (`CharacterStep` smoothing).
//! - **Low-frequency noise only.** Handheld drift and an explosion's shake are sums of sines at
//!   most [`NOISE_MAX_HZ`]; nothing is random per tick.

use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use super::Camera;
use crate::character::CharacterStep;
use crate::math;

/// The fastest step rate the bob runs at, steps per second (the vertical bob's frequency).
pub const CADENCE_MAX_HZ: f32 = 2.8;
/// The most the eye rises and falls over a step, metres peak to peak.
pub const BOB_PEAK_TO_PEAK_MAX: f32 = 0.028;
/// The most the walk rolls the view, degrees either way.
pub const BOB_ROLL_MAX_DEG: f32 = 1.2;
/// The most every roll together tilts the view, degrees either way.
pub const ROLL_TOTAL_MAX_DEG: f32 = 2.0;
/// The most a sprint widens the vertical field of view, degrees.
pub const FOV_KICK_MAX_DEG: f32 = 4.0;
/// The highest frequency any shake or drift term has, hertz.
pub const NOISE_MAX_HZ: f32 = 8.0;
/// What reduced motion leaves of the bob and the shake.
pub const REDUCED_MOTION_SHARE: f32 = 0.1;

/// A step's length at standstill and how much it grows per metre per second.
const STEP_BASE_M: f32 = 0.45;
const STEP_PER_MPS: f32 = 0.28;
/// Bob, sway, roll and nod per metre per second of speed, before their caps.
const BOB_PER_MPS: f32 = 0.005;
const SWAY_PER_MPS: f32 = 0.0035;
const SWAY_MAX_M: f32 = 0.018;
const ROLL_PER_MPS_DEG: f32 = 0.22;
const NOD_PER_MPS_DEG: f32 = 0.1;
const NOD_MAX_DEG: f32 = 0.5;
/// Degrees of lean per radian per second of turn, and the most a turn leans.
const TURN_LEAN_DEG: f32 = 0.6;
const TURN_LEAN_MAX_DEG: f32 = 0.8;
/// How much steeper than 45° a tick's rise must be to count as a step up or down (metres of rise
/// beyond one per metre walked).
const SLOPE_RISE_PER_M: f32 = 1.0;
/// The furthest a smoothed step or a landing holds the eye from the body, metres.
const STEP_OFFSET_MAX_M: f32 = 0.5;
const LAND_DIP_MAX_M: f32 = 0.06;
/// Metres per second of dip per metre per second of fall, and the fall that dips the most.
const LAND_GAIN: f32 = 0.012;
const LAND_FALL_MAX_MPS: f32 = 12.0;
/// The most recoil and shake together turn the view, degrees.
const SHAKE_MAX_DEG: f32 = 1.5;
/// Handheld drift at standstill, degrees, and how fast an impulse's shake fades (per second).
const DRIFT_DEG: f32 = 0.06;
const SHAKE_FADE_PER_S: f32 = 3.0;
/// Each spring's natural frequency, radians per second (all well under 8 Hz).
const SPEED_OMEGA: f32 = 9.0;
const LEAN_OMEGA: f32 = 10.0;
const STEP_OMEGA: f32 = 14.0;
const LAND_OMEGA: f32 = 11.0;
const RECOIL_OMEGA: f32 = 18.0;
/// The phase wraps every gait cycle (two steps), so it keeps its precision for hours.
const STEPS_PER_CYCLE: f32 = 2.0;
/// The drift's and shake's sines: (hertz, phase) for pitch and for yaw.
const DRIFT_PITCH: [(f32, f32); 3] = [(0.37, 0.0), (0.91, 1.7), (2.3, 4.1)];
const DRIFT_YAW: [(f32, f32); 3] = [(0.29, 2.2), (0.73, 0.4), (1.9, 5.3)];
const SHAKE_PITCH: [(f32, f32); 2] = [(5.3, 0.9), (7.1, 3.3)];
const SHAKE_YAW: [(f32, f32); 2] = [(4.7, 2.5), (6.4, 0.2)];
/// The narrowest and widest vertical field of view a comfort offset may reach, degrees.
const FOVY_RANGE: (f32, f32) = (30.0, 110.0);
/// The rig's time wraps after this many seconds (a multiple of every drift period it matters for).
const TIME_WRAP_S: f32 = 10_000.0;

/// The person's comfort settings a rig's view obeys. [`Comfort::current`] reads them from the
/// settings menu in any hook, the camera hook included; a test passes its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Comfort {
    /// How much of the walk's bob, sway, roll and field of view kick shows, 0 to 1 (`ui.head_bob`).
    pub head_bob: f32,
    /// How much of recoil, landings, drift and shake shows, 0 to 1 (`ui.screen_shake`).
    pub screen_shake: f32,
    /// Everything at most [`REDUCED_MOTION_SHARE`] (`ui.reduced_motion`).
    pub reduced_motion: bool,
    /// Degrees added to the vertical field of view (`graphics.fov_offset`).
    pub fov_offset: f32,
}

impl Comfort {
    /// Every motion at full size, no field of view offset: the defaults a Genex run judges.
    pub const FULL: Comfort = Comfort { head_bob: 1.0, screen_shake: 1.0, reduced_motion: false, fov_offset: 0.0 };

    /// The person's settings now (the defaults outside a running game).
    pub fn current() -> Comfort {
        crate::settings::comfort()
    }

    fn reduced(&self) -> f32 {
        if self.reduced_motion { REDUCED_MOTION_SHARE } else { 1.0 }
    }

    /// The share of the walk's motion that shows.
    pub fn bob_share(&self) -> f32 {
        self.head_bob.clamp(0.0, 1.0) * self.reduced()
    }

    /// The share of the shake that shows.
    pub fn shake_share(&self) -> f32 {
        self.screen_shake.clamp(0.0, 1.0) * self.reduced()
    }
}

impl Default for Comfort {
    fn default() -> Comfort {
        Comfort::FULL
    }
}

/// What the body did this tick, for [`FirstPersonRig::update`]: `RigStep { velocity, turn,
/// ..RigStep::from(step) }` with the `CharacterStep` a drive answered.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RigStep {
    /// The body's velocity, metres per second (`character.velocity()`).
    pub velocity: Vec3,
    /// How far the view turned this tick, radians, + to the right (the mouse moved right): the
    /// view leans into the turn.
    pub turn: f32,
    /// Standing on ground after the move.
    pub grounded: bool,
    /// It touched down this tick.
    pub landed: bool,
    /// The feet's rise this tick, metres (`CharacterStep::moved.y`).
    pub rise: f32,
    /// How far it walked this tick, metres (`CharacterStep::moved`'s horizontal length).
    pub walked: f32,
}

impl From<&CharacterStep> for RigStep {
    fn from(step: &CharacterStep) -> RigStep {
        let walked = (step.moved.x * step.moved.x + step.moved.z * step.moved.z).sqrt();
        RigStep { grounded: step.grounded, landed: step.landed, rise: step.moved.y, walked, ..RigStep::default() }
    }
}

impl From<CharacterStep> for RigStep {
    fn from(step: CharacterStep) -> RigStep {
        RigStep::from(&step)
    }
}

/// A rig's motion at one moment, before the person's comfort scales it: offsets in the view's
/// frame (metres) and turns (degrees).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RigPose {
    /// The walk's sideways sway (+ right) and bob (+ up), metres.
    pub bob: [f32; 2],
    /// The walk's roll, degrees (+ tilts the top to the right).
    pub bob_roll: f32,
    /// The walk's nod, degrees (+ up).
    pub nod: f32,
    /// A turn's lean, degrees.
    pub lean: f32,
    /// The eye's offset from the body while a step up or down eases in, metres (+ up; never
    /// scaled away: it removes motion).
    pub step: f32,
    /// A landing's dip, metres (+ down).
    pub land: f32,
    /// Recoil, drift and shake: pitch (+ up) and yaw (+ left), degrees.
    pub shake: [f32; 2],
    /// The sprint's widening of the vertical field of view, degrees.
    pub fov_kick: f32,
}

impl RigPose {
    /// The roll the view shows under `comfort`, degrees, within [`ROLL_TOTAL_MAX_DEG`].
    pub fn roll(&self, comfort: &Comfort) -> f32 {
        ((self.bob_roll + self.lean) * comfort.bob_share()).clamp(-ROLL_TOTAL_MAX_DEG, ROLL_TOTAL_MAX_DEG)
    }
}

/// One critically damped spring toward 0, advanced in closed form.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Spring {
    at: f32,
    rate: f32,
}

impl Spring {
    /// Advance `dt` seconds toward `target` at natural frequency `omega` (radians per second).
    fn step(&mut self, target: f32, omega: f32, dt: f32) {
        let offset = self.at - target;
        let j1 = self.rate + omega * offset;
        let decay = math::exp(-omega * dt);
        self.at = target + (offset + j1 * dt) * decay;
        self.rate = (self.rate - omega * j1 * dt) * decay;
    }
}

/// A first-person camera's motion: walk bob, sway and roll from a speed-scaled stride, a turn's
/// lean, a landing's dip, recoil, low-frequency drift and shake, the step up a stair eased in and a
/// sprint's field of view kick, every one capped. Keep it in the world, advance it in `on_update`
/// and make the camera from it in the camera hook:
///
/// ```
/// # use genex::prelude::*;
/// use genex::camera::{FirstPersonRig, RigStep};
///
/// #[derive(Default)]
/// struct World { rig: FirstPersonRig, eye: Vec3, forward: Vec3, turned: f32, velocity: Vec3 }
///
/// # fn wire(game: &mut Game<World>) {
/// game.on_update(|sim, ctx| {
///     let world = &mut sim.world;
///     // With a Character: `RigStep { velocity, turn, ..RigStep::from(&step) }`.
///     let step = RigStep { velocity: world.velocity, turn: world.turned, grounded: true, ..RigStep::default() };
///     world.rig.update(ctx.dt, step);
/// });
/// // The person's head-bob, screen-shake, reduced-motion and field of view settings apply here.
/// game.camera(|sim| sim.world.rig.camera(sim.world.eye, sim.world.forward, 72.0));
/// # }
/// ```
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FirstPersonRig {
    walk_speed: f32,
    sprint_speed: f32,
    /// Steps taken, wrapped every two (the gait's phase).
    steps: f32,
    /// The rig's own clock, seconds (the drift's time).
    time: f32,
    speed: Spring,
    lean: Spring,
    step: Spring,
    land: Spring,
    recoil: Spring,
    /// An impulse's shake, 0 to 1, fading.
    shake: f32,
    /// The fall speed before this tick, for a landing.
    falling: f32,
}

impl Default for FirstPersonRig {
    fn default() -> FirstPersonRig {
        FirstPersonRig::new()
    }
}

impl FirstPersonRig {
    /// A rig at rest for a body that walks at 3 m/s and sprints at 5.5 m/s.
    pub fn new() -> FirstPersonRig {
        FirstPersonRig {
            walk_speed: 3.0,
            sprint_speed: 5.5,
            steps: 0.0,
            time: 0.0,
            speed: Spring::default(),
            lean: Spring::default(),
            step: Spring::default(),
            land: Spring::default(),
            recoil: Spring::default(),
            shake: 0.0,
            falling: 0.0,
        }
    }

    /// The game's walking and sprinting speeds (m/s): the field of view kick grows between them.
    #[must_use]
    pub fn with_speeds(self, walk: f32, sprint: f32) -> FirstPersonRig {
        let walk = if walk.is_finite() { walk.max(0.1) } else { 3.0 };
        let sprint = if sprint.is_finite() { sprint.max(walk + 0.1) } else { walk + 2.5 };
        FirstPersonRig { walk_speed: walk, sprint_speed: sprint, ..self }
    }

    /// Advance by `dt` seconds (pass `ctx.dt`) with what the body did this tick.
    pub fn update(&mut self, dt: f32, step: RigStep) {
        let dt = if dt.is_finite() && dt > 0.0 { dt } else { return };
        let planar = (step.velocity.x * step.velocity.x + step.velocity.z * step.velocity.z).sqrt();
        let planar = if planar.is_finite() { planar } else { 0.0 };
        let target = if step.grounded { planar } else { 0.0 };
        self.speed.step(target, SPEED_OMEGA, dt);
        let speed = self.speed.at.max(0.0);
        self.steps = (self.steps + cadence(speed) * dt) % STEPS_PER_CYCLE;
        self.time = (self.time + dt) % TIME_WRAP_S;
        let turn_rate = if step.turn.is_finite() { step.turn / dt } else { 0.0 };
        self.lean.step((turn_rate * TURN_LEAN_DEG).clamp(-TURN_LEAN_MAX_DEG, TURN_LEAN_MAX_DEG), LEAN_OMEGA, dt);
        self.ease_step(&step, dt);
        if step.landed {
            let fall = self.falling.clamp(0.0, LAND_FALL_MAX_MPS);
            self.land.rate += fall * LAND_GAIN * LAND_OMEGA;
        }
        self.land.step(0.0, LAND_OMEGA, dt);
        self.recoil.step(0.0, RECOIL_OMEGA, dt);
        self.shake *= math::exp(-SHAKE_FADE_PER_S * dt);
        self.falling = if step.grounded { 0.0 } else { (-step.velocity.y).max(0.0) };
    }

    /// A step up or down a stair moves the body in one tick; the eye takes it over a few.
    fn ease_step(&mut self, step: &RigStep, dt: f32) {
        let snapped = step.grounded && !step.landed && step.rise.is_finite();
        if snapped {
            let slope = step.walked.max(0.0) * SLOPE_RISE_PER_M;
            let snap = step.rise.signum() * (step.rise.abs() - slope).max(0.0);
            self.step.at = (self.step.at - snap).clamp(-STEP_OFFSET_MAX_M, STEP_OFFSET_MAX_M);
        }
        self.step.step(0.0, STEP_OMEGA, dt);
    }

    /// Kick the view up by about `degrees` (a shot), easing back over a fifth of a second.
    pub fn recoil(&mut self, degrees: f32) {
        if degrees.is_finite() {
            self.recoil.rate += degrees.clamp(-SHAKE_MAX_DEG, SHAKE_MAX_DEG) * RECOIL_OMEGA * std::f32::consts::E;
        }
    }

    /// Shake the view by `strength` (0 to 1: an explosion nearby), fading over about a second.
    pub fn impulse(&mut self, strength: f32) {
        if strength.is_finite() {
            self.shake = (self.shake + strength.max(0.0)).min(1.0);
        }
    }

    /// The motion now, before comfort scales it.
    pub fn pose(&self) -> RigPose {
        let speed = self.speed.at.max(0.0);
        let cycle = self.steps * std::f32::consts::PI;
        let bob = (speed * BOB_PER_MPS).min(BOB_PEAK_TO_PEAK_MAX);
        let sway = (speed * SWAY_PER_MPS).min(SWAY_MAX_M);
        let roll = (speed * ROLL_PER_MPS_DEG).min(BOB_ROLL_MAX_DEG);
        let nod = (speed * NOD_PER_MPS_DEG).min(NOD_MAX_DEG);
        let (half_sin, _) = math::sin_cos(cycle);
        let step_cos = math::cos(cycle * 2.0);
        let drift = DRIFT_DEG + self.shake * SHAKE_MAX_DEG * 0.5;
        let shake = [
            self.recoil.at + drift * sines(&DRIFT_PITCH, self.time) + self.shake * sines(&SHAKE_PITCH, self.time),
            drift * sines(&DRIFT_YAW, self.time) + self.shake * sines(&SHAKE_YAW, self.time),
        ];
        RigPose {
            bob: [half_sin * sway, -step_cos * bob * 0.5],
            bob_roll: half_sin * roll,
            nod: -step_cos * nod * 0.5,
            lean: self.lean.at,
            step: self.step.at,
            land: self.land.at.clamp(0.0, LAND_DIP_MAX_M),
            shake: shake.map(|degrees| degrees.clamp(-SHAKE_MAX_DEG, SHAKE_MAX_DEG)),
            fov_kick: FOV_KICK_MAX_DEG * smooth01((speed - self.walk_speed) / (self.sprint_speed - self.walk_speed)),
        }
    }

    /// The step rate now, steps per second (the vertical bob's frequency).
    pub fn cadence(&self) -> f32 {
        cadence(self.speed.at.max(0.0))
    }

    /// The camera at `eye` looking along `forward` with vertical field of view `fovy`, moved by the
    /// rig under the person's settings now ([`Comfort::current`]). Call it in the camera hook.
    pub fn camera(&self, eye: Vec3, forward: Vec3, fovy: f32) -> Camera {
        self.camera_with(eye, forward, fovy, &Comfort::current())
    }

    /// [`FirstPersonRig::camera`] under `comfort`.
    pub fn camera_with(&self, eye: Vec3, forward: Vec3, fovy: f32, comfort: &Comfort) -> Camera {
        let pose = self.pose();
        let forward = forward.try_normalize().unwrap_or(Vec3::NEG_Z);
        let right = forward.cross(Vec3::Y).try_normalize().unwrap_or(Vec3::X);
        let up = right.cross(forward);
        let (bob, shake) = (comfort.bob_share(), comfort.shake_share());
        let lift = pose.bob[1] * bob - pose.land * shake + pose.step;
        let position = eye + right * (pose.bob[0] * bob) + up * lift;
        let pitch = (pose.nod * bob + pose.shake[0] * shake).to_radians();
        let yaw = (pose.shake[1] * shake).to_radians();
        let turn = Quat::from_axis_angle(Vec3::Y, yaw) * Quat::from_axis_angle(right, pitch);
        let look = turn * forward;
        let roll = Quat::from_axis_angle(look, pose.roll(comfort).to_radians());
        let fovy = (fovy + comfort.fov_offset + pose.fov_kick * bob).clamp(FOVY_RANGE.0, FOVY_RANGE.1);
        Camera { up: roll * (turn * up), fovy, ..Camera::look_at(position, position + look) }
    }

    /// For a probe or a comfort check: the unscaled pose's bob, roll, nod, cadence and kick
    /// (`{"bobM":..,"rollDeg":..,"cadenceHz":..}`), the same for every person.
    pub fn probe(&self) -> serde_json::Value {
        let pose = self.pose();
        serde_json::json!({
            "bobM": pose.bob[1],
            "swayM": pose.bob[0],
            "rollDeg": pose.roll(&Comfort::FULL),
            "nodDeg": pose.nod,
            "cadenceHz": self.cadence(),
            "fovKickDeg": pose.fov_kick,
            "stepM": pose.step,
            "landM": pose.land,
        })
    }
}

/// Steps per second at `speed`: the speed over a stride that grows with it, at most
/// [`CADENCE_MAX_HZ`].
fn cadence(speed: f32) -> f32 {
    (speed / (STEP_BASE_M + STEP_PER_MPS * speed)).min(CADENCE_MAX_HZ)
}

/// A sum of unit sines at (hertz, phase), normalised to at most 1.
fn sines(terms: &[(f32, f32)], time: f32) -> f32 {
    let sum: f32 = terms.iter().map(|(hertz, phase)| math::sin(std::f32::consts::TAU * hertz * time + phase)).sum();
    sum / terms.len().max(1) as f32
}

/// 0 below 0, 1 above 1, and a smooth S between.
fn smooth01(x: f32) -> f32 {
    let x = if x.is_finite() { x.clamp(0.0, 1.0) } else { 0.0 };
    x * x * (3.0 - 2.0 * x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_drift_and_shake_term_is_at_most_eight_hertz() {
        for (hertz, _) in DRIFT_PITCH.iter().chain(&DRIFT_YAW).chain(&SHAKE_PITCH).chain(&SHAKE_YAW) {
            assert!(*hertz <= NOISE_MAX_HZ, "{hertz} Hz");
        }
        for omega in [SPEED_OMEGA, LEAN_OMEGA, STEP_OMEGA, LAND_OMEGA, RECOIL_OMEGA] {
            assert!(omega / std::f32::consts::TAU < NOISE_MAX_HZ, "a spring at {omega} rad/s");
        }
    }

    #[test]
    fn a_spring_lands_on_its_target_at_any_step() {
        for dt in [1.0 / 120.0, 1.0 / 60.0, 1.0 / 30.0, 0.25] {
            let mut spring = Spring { at: 1.0, rate: 0.0 };
            for _ in 0..((3.0 / dt) as usize) {
                spring.step(0.0, 10.0, dt);
            }
            assert!(spring.at.abs() < 1e-3, "dt {dt}: {}", spring.at);
        }
    }
}
