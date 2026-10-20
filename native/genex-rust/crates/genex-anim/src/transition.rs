//! Transitions on the pose side: what a layer shows while its machine (`machine.rs`) switches
//! state, with crossfades, inertialization, cuts and interruption.
//!
//! A [`TransitionPlayer`] follows one layer of a [`Machine`]. Each tick it reads the layer's state,
//! clip time and running transition, asks the caller's sampler for the poses it needs (each call
//! is one counted evaluation), and keeps the pose the layer shows:
//!
//! - **No transition, or a cut** (a 0-second blend or `jump_to`): the current state's pose, one
//!   evaluation. A cut also drops any running offset or frozen source.
//! - **Crossfade** (Godot's xfade, linear, MIT; the rule only): the left state, still playing,
//!   mixed with the next one by the blend's progress; two evaluations a tick.
//! - **Inertialize** (`inertial.rs`, Holden, MIT): on the switch the offset from the next state to
//!   the pose the layer was showing is taken, and from then on only the next state is evaluated
//!   and the decaying offset added; one evaluation a tick.
//! - **Interruption.** A switch while a blend is still visible starts from the pose the layer was
//!   showing, never from the machine's `from` state alone (Fyrox cannot interrupt). An inertialized
//!   switch takes its offset from that pose, carried one tick on by its velocity. A crossfade
//!   freezes it as its source and carries it on with a fading velocity (Holden's dead blending),
//!   so it costs one evaluation instead of the two the lost blend would need.
//!
//! Everything is plain f32 arithmetic and glam's libm in a fixed order: one script gives the same
//! bits on every destination. The player is simulation state (cloneable, digestible).

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};

use crate::blend::{Blender, Layer};
use crate::graph::TransitionBlend;
use crate::ids::{LayerId, StateId};
use crate::inertial::{InertialOffset, JointVelocity, extrapolate, fade_velocities, floats_digest, vec3_digest, velocities};
use crate::machine::{ActiveTransition, Machine, Switched};
use crate::math::Trs;

/// A crossfade's source after an interrupt: the pose the layer was showing, carried on by a
/// fading velocity.
#[derive(Clone, Debug, PartialEq)]
struct Frozen {
    pose: Vec<Trs>,
    velocity: Vec<JointVelocity>,
}

/// What one layer shows across its machine's switches; see the module docs.
#[derive(Clone, Debug)]
pub struct TransitionPlayer {
    rest: Vec<Trs>,
    pose: Vec<Trs>,
    previous: Vec<Trs>,
    velocity: Vec<JointVelocity>,
    /// A pose has been shown since the player was made or reset.
    shown: bool,
    /// The state the last update showed.
    state: Option<StateId>,
    /// The last update was inside a crossfade.
    crossfading: bool,
    offset: InertialOffset,
    frozen: Option<Frozen>,
    evaluations: u64,
    source: Vec<Trs>,
    target: Vec<Trs>,
    blender: Blender,
}

/// The longest step the pose side carries a velocity or decays an offset over, in seconds: a
/// longer one (a hitch, a resumed game) lands where a second would.
pub const MAX_STEP_SECONDS: f32 = 1.0;

/// `dt` as a pose step: positive and finite, at most [`MAX_STEP_SECONDS`], otherwise 0.
fn step_seconds(dt: f32) -> f32 {
    if dt.is_finite() && dt > 0.0 { dt.min(MAX_STEP_SECONDS) } else { 0.0 }
}

/// The running transition when it is a crossfade.
fn crossfade(running: Option<ActiveTransition>) -> Option<ActiveTransition> {
    running.filter(|running| matches!(running.blend, TransitionBlend::Crossfade(_)))
}

impl TransitionPlayer {
    /// A player for a skeleton with this rest pose, showing the rest pose until its first update.
    pub fn new(rest: &[Trs]) -> TransitionPlayer {
        TransitionPlayer {
            rest: rest.to_vec(),
            pose: rest.to_vec(),
            previous: rest.to_vec(),
            velocity: vec![JointVelocity::ZERO; rest.len()],
            shown: false,
            state: None,
            crossfading: false,
            offset: InertialOffset::new(),
            frozen: None,
            evaluations: 0,
            source: rest.to_vec(),
            target: rest.to_vec(),
            blender: Blender::new(),
        }
    }

    /// Back to the rest pose with no history, as a new seed starts.
    pub fn reset(&mut self) {
        *self = TransitionPlayer { evaluations: self.evaluations, ..TransitionPlayer::new(&self.rest) };
    }

    /// Show `layer` of `machine` after a step that returned `switched` and took `dt` seconds.
    /// `sample(state, time, pose)` writes a state's pose at a clip time into `pose`, which starts
    /// as the rest pose; each call counts one evaluation. A state change the step did not report
    /// (`jump_to`) is a cut. Returns the pose the layer shows.
    pub fn update(&mut self, machine: &Machine, layer: LayerId, switched: Switched, dt: f32, mut sample: impl FnMut(StateId, f32, &mut [Trs])) -> &[Trs] {
        let dt = step_seconds(dt);
        let state = machine.state(layer);
        let time = machine.clip_time(layer);
        let running = machine.transition(layer);
        let entered = switched.contains(layer) || self.state != Some(state);
        let target_ready = if entered && self.shown {
            self.begin(running, dt, &mut |pose: &mut [Trs]| sample(state, time, pose))
        } else {
            self.offset.update(dt);
            false
        };
        let crossfade = crossfade(running);
        if crossfade.is_none() {
            self.frozen = None;
        }
        self.previous.copy_from_slice(&self.pose);
        if !target_ready {
            self.evaluations += 1;
            self.target.copy_from_slice(&self.rest);
            sample(state, time, &mut self.target);
        }
        match crossfade {
            Some(running) => self.show_crossfade(running, dt, &mut sample),
            None => {
                self.pose.copy_from_slice(&self.target);
                self.offset.apply(&mut self.pose);
            }
        }
        if self.shown && dt > 0.0 {
            velocities(&self.previous, &self.pose, dt, &mut self.velocity);
        }
        self.shown = true;
        self.state = Some(state);
        self.crossfading = crossfade.is_some();
        &self.pose
    }

    /// Start a switch; true when it already sampled the next state into `target`.
    fn begin(&mut self, running: Option<ActiveTransition>, dt: f32, sample_target: &mut dyn FnMut(&mut [Trs])) -> bool {
        let interrupting = self.crossfading || self.offset.is_active() || self.frozen.is_some();
        self.frozen = None;
        match running.map(|running| running.blend) {
            Some(TransitionBlend::Inertialize(seconds)) => {
                self.source.copy_from_slice(&self.pose);
                extrapolate(&mut self.source, &self.velocity, dt);
                self.evaluations += 1;
                self.target.copy_from_slice(&self.rest);
                sample_target(&mut self.target);
                self.offset.start(&self.source, &self.velocity, &self.target, InertialOffset::halflife_for(seconds));
                true
            }
            Some(TransitionBlend::Crossfade(_)) if interrupting => {
                self.offset.clear();
                self.frozen = Some(Frozen { pose: self.pose.clone(), velocity: self.velocity.clone() });
                false
            }
            _ => {
                self.offset.clear();
                false
            }
        }
    }

    /// The crossfade's source mixed with `target` by its progress, into `pose`.
    fn show_crossfade(&mut self, running: ActiveTransition, dt: f32, sample: &mut impl FnMut(StateId, f32, &mut [Trs])) {
        match &mut self.frozen {
            Some(frozen) => {
                extrapolate(&mut frozen.pose, &frozen.velocity, dt);
                fade_velocities(&mut frozen.velocity, dt);
                self.source.copy_from_slice(&frozen.pose);
            }
            None => {
                self.evaluations += 1;
                self.source.copy_from_slice(&self.rest);
                sample(running.from, running.from_time, &mut self.source);
            }
        }
        let progress = running.progress();
        let layers = [Layer::new(&self.source, 1.0 - progress), Layer::new(&self.target, progress)];
        self.blender.blend(&self.rest, &layers, &mut self.pose);
    }

    /// The pose the layer showed on the last update (the rest pose before the first).
    pub fn pose(&self) -> &[Trs] {
        &self.pose
    }

    /// Poses the sampler has been asked for since the player was made.
    pub fn evaluations(&self) -> u64 {
        self.evaluations
    }

    /// The running inertialization offset.
    pub fn offset(&self) -> &InertialOffset {
        &self.offset
    }

    /// The last update was inside a crossfade.
    pub fn crossfading(&self) -> bool {
        self.crossfading
    }

    /// A crossfade is running from a frozen, interrupted pose.
    pub fn interrupted(&self) -> bool {
        self.frozen.is_some()
    }

    /// FNV-1a 64 over the shown pose, its velocity, the state, the offset and any frozen source
    /// (the evaluation counter is not state): equal digests mean equal players.
    pub fn digest(&self) -> u64 {
        let mut hash = fnv1a64_from(&self.state.map_or(u32::MAX, StateId::raw).to_le_bytes(), FNV_OFFSET_BASIS);
        hash = fnv1a64_from(&[u8::from(self.shown), u8::from(self.crossfading), u8::from(self.frozen.is_some())], hash);
        hash = pose_digest(&self.pose, hash);
        hash = velocity_digest(&self.velocity, hash);
        hash = self.offset.digest_from(hash);
        if let Some(frozen) = &self.frozen {
            hash = pose_digest(&frozen.pose, hash);
            hash = velocity_digest(&frozen.velocity, hash);
        }
        hash
    }
}

/// A pose's bits folded into an FNV-1a 64 `hash`.
fn pose_digest(pose: &[Trs], hash: u64) -> u64 {
    pose.iter().fold(hash, |hash, trs| {
        let hash = vec3_digest(trs.translation, hash);
        let hash = floats_digest(&trs.rotation.to_array(), hash);
        vec3_digest(trs.scale, hash)
    })
}

fn velocity_digest(velocity: &[JointVelocity], hash: u64) -> u64 {
    velocity.iter().fold(hash, |hash, velocity| vec3_digest(velocity.scale, vec3_digest(velocity.angular, vec3_digest(velocity.translation, hash))))
}
