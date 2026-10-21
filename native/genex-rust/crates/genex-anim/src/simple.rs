//! The simple animator (AN-26): `play`, `crossfade`, `play_once` and `speed`, taught before the
//! graph. The four verbs follow three.js's `AnimationMixer`, Godot's `AnimationPlayer` and Unity's
//! legacy `Animation` (MIT; MIT; proprietary): ideas only, no code was taken.
//!
//! A simple animator is an ordinary [`Animator`] over a hidden one-layer graph, so probes,
//! sockets, IK, root motion, events, snapshots and digests work unchanged. The graph
//! ([`AnimGraphBuilder::build_simple`]) has:
//!
//! - state 0, `rest`, which plays nothing (the rest pose) until the first call;
//! - for each clip, a looping state named after the clip and a `once` state (`<name> once`), both
//!   at the `speed` parameter's speed;
//! - for each clip and each step of [`CROSSFADE_LADDER_SECONDS`], an any-state crossfade into the
//!   clip's looping state, taken when the `go` trigger is fired with `command` naming it;
//! - for each clip, an any-state crossfade over [`DEFAULT_BLEND_SECONDS`] into its looping state
//!   from the tick a `once` clip ends, when `back` names it.
//!
//! `play` and `play_once` cut (the machine's `jump_to`); `crossfade` fires `go`, so it starts at
//! the next update, as any graph transition does. The last call before an update wins: a cut
//! cancels a pending crossfade, and a crossfade after a cut is taken at the update. A `once` clip
//! plays to its end unless `play` or another `play_once` interrupts it: a crossfade meanwhile
//! only changes the looping clip it returns to. A graph's blend
//! times are fixed when it is built, so a crossfade's seconds round to the nearest ladder step; 0,
//! a negative time or NaN cuts. `play_once` returns to the looping clip it interrupted (or that a
//! running `once` clip would have returned to); from `rest` it holds its last frame.

use std::sync::Arc;

use crate::animator::{AnimSet, Animator};
use crate::error::AnimationError;
use crate::graph::{AnimGraph, AnimGraphBuilder, DEFAULT_BLEND_SECONDS, MAX_NAME_BYTES, MAX_STATES, MAX_TRANSITIONS, Motion};
use crate::ids::{ClipId, LayerId, ParamId, StateId};
use crate::params::{Condition, FloatParam, ParamKind, TriggerParam};

/// The crossfade lengths a simple animator blends over, in seconds; `crossfade` rounds to the
/// nearest (ties to the shorter).
pub const CROSSFADE_LADDER_SECONDS: [f32; 18] = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.25, 1.5, 2.0];

/// Transitions the hidden graph declares per clip: one crossfade per ladder step and the return.
const TRANSITIONS_PER_CLIP: usize = CROSSFADE_LADDER_SECONDS.len() + 1;

/// The most clips a simple animator takes (the graph's transition and state caps).
pub const SIMPLE_CLIPS_MAX: usize = min(MAX_TRANSITIONS / TRANSITIONS_PER_CLIP, (MAX_STATES - 1) / 2);

const fn min(a: usize, b: usize) -> usize {
    if a < b { a } else { b }
}

/// The hidden graph's parameters, in declaration order: what [`is_simple`] checks and the verbs
/// write.
const PARAM_KINDS: [ParamKind; 4] = [ParamKind::Float, ParamKind::Float, ParamKind::Trigger, ParamKind::Float];
const SPEED: FloatParam = FloatParam(ParamId(0));
const COMMAND: FloatParam = FloatParam(ParamId(1));
const GO: TriggerParam = TriggerParam(ParamId(2));
const BACK: FloatParam = FloatParam(ParamId(3));
/// The one layer.
const LAYER: LayerId = LayerId(0);
/// The entry state, which plays nothing.
const REST: StateId = StateId(0);
/// `command` and `back` when they name nothing.
const NONE: f32 = 0.0;
/// The `rest` state's name.
const REST_NAME: &str = "rest";
/// What a `once` state's name adds to its clip's.
const ONCE_SUFFIX: &str = " once";

/// What a state of the hidden graph plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Playing {
    Rest,
    Loop(usize),
    Once(usize),
}

impl AnimGraphBuilder<'_> {
    /// The simple animator's hidden graph over this builder's clips (see [`crate::simple`]),
    /// instead of [`AnimGraphBuilder::build`]: give it to an animator and drive it with `play`,
    /// `crossfade`, `play_once` and `speed`. Events declared first are kept. Refused
    /// `animation-graph-invalid` when the builder already declared a parameter, layer, state or
    /// transition, or the character has more than [`SIMPLE_CLIPS_MAX`] clips.
    pub fn build_simple(mut self) -> Result<AnimGraph, AnimationError> {
        let clips: Vec<(ClipId, String)> = self.clips().map(|(id, name)| (id, name.to_owned())).collect();
        if clips.len() > SIMPLE_CLIPS_MAX {
            return Err(AnimationError::graph_invalid(format!("{} clips, more than the simple animator's {SIMPLE_CLIPS_MAX}", clips.len())));
        }
        let used = || AnimationError::graph_invalid("build_simple needs a builder with nothing declared but events");
        let speed = self.float("speed", 1.0);
        let command = self.float("command", NONE);
        let go = self.trigger("go");
        let back = self.float("back", NONE);
        if (speed, command, go, back) != (SPEED, COMMAND, GO, BACK) {
            return Err(used());
        }
        let layer = self.layer("simple");
        if layer != LAYER || self.state(layer, REST_NAME, Motion::Empty) != REST {
            return Err(used());
        }
        let names = state_names(&clips);
        let loops: Vec<StateId> = clips.iter().zip(&names).map(|((clip, _), name)| self.state(layer, name, Motion::clip(*clip).speed_by(speed))).collect();
        for ((clip, _), name) in clips.iter().zip(&names) {
            self.state(layer, &format!("{name}{ONCE_SUFFIX}"), Motion::clip(*clip).once().speed_by(speed));
        }
        for (index, state) in loops.iter().enumerate() {
            for (step, seconds) in CROSSFADE_LADDER_SECONDS.iter().enumerate() {
                self.transition_from_any(*state).when(go.fired().and(names_value(command, command_value(index, step)))).crossfade(*seconds).priority(1);
            }
        }
        for (index, state) in loops.iter().enumerate() {
            self.transition_from_any(*state).when(Condition::state_ended().and(names_value(back, back_value(index)))).crossfade(DEFAULT_BLEND_SECONDS);
        }
        let graph = self.build()?;
        if graph.transitions().len() != clips.len() * TRANSITIONS_PER_CLIP {
            return Err(used());
        }
        Ok(graph)
    }
}

impl Animator {
    /// A simple animator over `set`: `play`, `crossfade`, `play_once` and `speed` on the hidden
    /// one-layer graph [`AnimGraphBuilder::build_simple`] builds. It shows the rest pose until
    /// the first call. Refused as `build_simple` refuses.
    pub fn simple(set: Arc<AnimSet>) -> Result<Animator, AnimationError> {
        let graph = AnimGraph::builder(set.skeleton(), set.clips()).build_simple()?;
        Animator::new(set, &graph)
    }

    /// Cut to `clip`, looping (nothing changes when it already loops). False, with nothing
    /// changed, on an animator that is not a simple one or a clip its set lacks.
    pub fn play(&mut self, clip: ClipId) -> bool {
        let Some(clips) = self.simple_clips() else { return false };
        let Some(index) = clip_index(clip, clips) else { return false };
        self.set_float(COMMAND, NONE);
        if self.playing() != Some(Playing::Loop(index)) {
            self.jump_to(loop_state(index));
        }
        true
    }

    /// Blend into `clip`, looping, over `seconds` rounded to the nearest of
    /// [`CROSSFADE_LADDER_SECONDS`], from the next update; 0, a negative time or NaN cuts as
    /// [`Animator::play`] does. A crossfade into the clip already looping changes nothing, and one
    /// while a `play_once` clip plays only changes the clip it returns to (so a game may call it
    /// every tick). False, with nothing changed, as `play` refuses.
    pub fn crossfade(&mut self, clip: ClipId, seconds: f32) -> bool {
        let Some(clips) = self.simple_clips() else { return false };
        let Some(index) = clip_index(clip, clips) else { return false };
        if seconds.is_nan() || seconds <= 0.0 {
            return self.play(clip);
        }
        if matches!(self.playing(), Some(Playing::Once(_))) {
            self.set_float(BACK, back_value(index));
            self.set_float(COMMAND, NONE);
            return true;
        }
        self.set_float(COMMAND, command_value(index, ladder_step(seconds)));
        self.fire(GO);
        true
    }

    /// Cut to `clip` played once (from its start, even when it is playing), then blend back over
    /// [`DEFAULT_BLEND_SECONDS`] into the looping clip it interrupted, from the tick it ends. From
    /// the rest pose it holds its last frame. False, with nothing changed, as `play` refuses.
    pub fn play_once(&mut self, clip: ClipId) -> bool {
        let Some(clips) = self.simple_clips() else { return false };
        let Some(index) = clip_index(clip, clips) else { return false };
        match self.playing() {
            Some(Playing::Loop(looping)) => self.set_float(BACK, back_value(looping)),
            Some(Playing::Rest) | None => self.set_float(BACK, NONE),
            Some(Playing::Once(_)) => {}
        }
        self.set_float(COMMAND, NONE);
        self.jump_to(once_state(clips, index));
        true
    }

    /// Play every clip at `speed` (1 is as authored; negative plays backwards). False, with
    /// nothing changed, on an animator that is not a simple one or a speed that is not finite.
    pub fn speed(&mut self, speed: f32) -> bool {
        if self.simple_clips().is_none() || !speed.is_finite() {
            return false;
        }
        self.set_float(SPEED, speed);
        true
    }

    /// The clip a simple animator plays (during a crossfade, the one it blends into); None at
    /// rest or on an animator that is not a simple one.
    pub fn playing_clip(&self) -> Option<ClipId> {
        match self.playing()? {
            Playing::Loop(index) | Playing::Once(index) => Some(ClipId(index as u32)),
            Playing::Rest => None,
        }
    }

    /// The clip count when this animator's graph is the hidden one `build_simple` makes over its
    /// set: one layer, its parameters, `1 + 2 × clips` states and its transitions.
    fn simple_clips(&self) -> Option<usize> {
        let clips = self.set().clips().len();
        is_simple(self.graph(), self.machine().params().values().iter().map(|value| value.kind()), clips).then_some(clips)
    }

    fn playing(&self) -> Option<Playing> {
        let clips = self.simple_clips()?;
        let state = self.state(LAYER).raw() as usize;
        Some(match state {
            0 => Playing::Rest,
            _ if state <= clips => Playing::Loop(state - 1),
            _ => Playing::Once(state - 1 - clips),
        })
    }
}

/// Whether `graph` (with parameters of `kinds`) is the hidden graph over `clips` clips.
fn is_simple(graph: &AnimGraph, kinds: impl Iterator<Item = ParamKind>, clips: usize) -> bool {
    let last_state = StateId((2 * clips) as u32);
    let shaped = graph.layers().len() == 1 && graph.transitions().len() == clips * TRANSITIONS_PER_CLIP;
    let states = graph.state_info(last_state).is_some() && graph.state_info(StateId(last_state.raw() + 1)).is_none();
    shaped && states && kinds.eq(PARAM_KINDS)
}

fn clip_index(clip: ClipId, clips: usize) -> Option<usize> {
    let index = clip.raw() as usize;
    (index < clips).then_some(index)
}

fn loop_state(index: usize) -> StateId {
    StateId((1 + index) as u32)
}

fn once_state(clips: usize, index: usize) -> StateId {
    StateId((1 + clips + index) as u32)
}

/// `command`'s value for a crossfade into clip `index` over ladder step `step` (exact in f32 for
/// every clip and step the caps allow).
fn command_value(index: usize, step: usize) -> f32 {
    (index * CROSSFADE_LADDER_SECONDS.len() + step + 1) as f32
}

fn back_value(index: usize) -> f32 {
    (index + 1) as f32
}

/// The condition that `param` holds the whole number `value`.
fn names_value(param: FloatParam, value: f32) -> Condition {
    param.above(value - 0.5).and(param.below(value + 0.5))
}

/// The ladder step nearest `seconds` (positive), ties to the shorter.
fn ladder_step(seconds: f32) -> usize {
    let mut best = 0;
    for (step, candidate) in CROSSFADE_LADDER_SECONDS.iter().enumerate() {
        if (candidate - seconds).abs() < (CROSSFADE_LADDER_SECONDS[best] - seconds).abs() {
            best = step;
        }
    }
    best
}

/// Each clip's looping state name: the clip's own, or `clip <index>` (with `#` added until it is
/// free) when it is empty, too long to take the `once` suffix, or it or its `once` name is
/// already taken (state names are unique in a layer).
fn state_names(clips: &[(ClipId, String)]) -> Vec<String> {
    let mut taken: Vec<String> = vec![REST_NAME.to_owned()];
    let mut names = Vec::with_capacity(clips.len());
    for (index, (_, name)) in clips.iter().enumerate() {
        let free = |taken: &[String], candidate: &str| {
            let once = format!("{candidate}{ONCE_SUFFIX}");
            !candidate.is_empty() && once.len() <= MAX_NAME_BYTES && !taken.iter().any(|name| name == candidate || *name == once)
        };
        let mut chosen = if free(&taken, name) { name.clone() } else { format!("clip {index}") };
        while !free(&taken, &chosen) {
            chosen.push('#');
        }
        taken.push(format!("{chosen}{ONCE_SUFFIX}"));
        taken.push(chosen.clone());
        names.push(chosen);
    }
    names
}
