//! The layered state machine stepped once per tick: Fyrox's per-layer update (MIT), with Godot's
//! priorities, any-state transitions, `at_end` and trigger consumption (MIT); the rules only, no
//! code was copied.
//!
//! Each step, layer by layer in declaration order:
//!
//! 1. A running transition's blend clock and its source state's clip advance; it ends once the
//!    blend time has passed.
//! 2. The current state's clip advances by `dt × speed`. A loop wraps (and marks a finished cycle
//!    for `at_end`); a `once` clip clamps and is ended from the tick it reaches its end.
//! 3. Unless a non-interruptible transition is running, the state's transitions are tried best
//!    first (`graph.rs`), and the first that holds switches the layer: it consumes its triggers,
//!    enters the next state at time 0 (or at the same normalized time when synced) and starts its
//!    blend. A layer switches at most once per step.
//!
//! Triggers nothing consumed are dropped at the end of the step. A `dt` that is negative or not
//! finite counts as 0, and a clip advance that would not be finite does not move the clip, so
//! every time stays finite. Everything is plain f32 arithmetic in a fixed order: the same inputs
//! give the same bits on every destination.

use genex_core::digest::fnv1a64_from;
use genex_core::json::Value;
use glam::Vec2;

use crate::graph::{AnimGraph, Motion, StateInfo, TransitionBlend};
use crate::ids::{LayerId, StateId};
use crate::params::{BoolParam, FloatParam, ParamValue, Params, StateFacts, TriggerParam, Vec2Param};

/// What a [`Machine`] answers for a state of a layer that is not in its graph.
const NO_STATE: StateId = StateId(u32::MAX);

/// A transition that is blending.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActiveTransition {
    /// Its index in [`AnimGraph::transitions`].
    pub transition: u32,
    /// The state the layer left.
    pub from: StateId,
    /// The left state's clip time, still advancing (a crossfade keeps playing it).
    pub from_time: f32,
    /// Seconds since the switch.
    pub elapsed: f32,
    /// How it blends.
    pub blend: TransitionBlend,
}

impl ActiveTransition {
    /// How far the blend has come, in `[0, 1]`.
    pub fn progress(&self) -> f32 {
        let seconds = self.blend.seconds();
        if seconds <= 0.0 { 1.0 } else { (self.elapsed / seconds).clamp(0.0, 1.0) }
    }
}

/// One layer's place in its graph (crate-visible for the animator's snapshots).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LayerState {
    pub(crate) state: StateId,
    /// Seconds since the state was entered.
    pub(crate) seconds: f32,
    /// The state's clip time.
    pub(crate) time: f32,
    /// The state's `once` clip has reached its end.
    pub(crate) ended: bool,
    /// This step finished a cycle of a loop, or the `once` clip is ended.
    pub(crate) cycle_end: bool,
    pub(crate) weight: f32,
    pub(crate) transition: Option<ActiveTransition>,
}

/// The layers that switched state in one step, as bits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Switched(u32);

impl Switched {
    /// `layer` switched.
    pub fn contains(self, layer: LayerId) -> bool {
        layer.raw() < u32::BITS && self.0 & (1 << layer.raw()) != 0
    }

    /// No layer switched.
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The bits, layer 0 lowest.
    pub fn bits(self) -> u32 {
        self.0
    }
}

/// A graph's machine: the parameters and each layer's state, clip time and running transition.
#[derive(Clone, Debug, PartialEq)]
pub struct Machine {
    graph: AnimGraph,
    pub(crate) params: Params,
    pub(crate) layers: Vec<LayerState>,
}

impl Machine {
    /// A machine at the start of `graph`: every parameter at its starting value and every layer
    /// in its first state at time 0.
    pub fn new(graph: &AnimGraph) -> Machine {
        let params = Params::new(graph.initial_params());
        let layers = graph
            .layer_infos()
            .iter()
            .map(|layer| {
                let time = graph.state_info(layer.entry).map_or(0.0, |state| entry_time(state, &params));
                LayerState { state: layer.entry, seconds: 0.0, time, ended: false, cycle_end: false, weight: layer.weight, transition: None }
            })
            .collect();
        Machine { graph: graph.clone(), params, layers }
    }

    /// The graph.
    pub fn graph(&self) -> &AnimGraph {
        &self.graph
    }

    /// The parameters.
    pub fn params(&self) -> &Params {
        &self.params
    }

    /// Set a float parameter.
    pub fn set_float(&mut self, param: FloatParam, value: f32) {
        self.params.set_float(param, value);
    }

    /// Set a vec2 parameter.
    pub fn set_vec2(&mut self, param: Vec2Param, value: Vec2) {
        self.params.set_vec2(param, value);
    }

    /// Set a bool parameter.
    pub fn set_bool(&mut self, param: BoolParam, value: bool) {
        self.params.set_bool(param, value);
    }

    /// Fire a trigger: it is pending for the next step only.
    pub fn fire(&mut self, trigger: TriggerParam) {
        self.params.fire(trigger);
    }

    /// Put `state`'s layer in it now, with no blend (a state of another graph changes nothing).
    pub fn jump_to(&mut self, state: StateId) {
        let Some(info) = self.graph.state_info(state) else { return };
        let time = entry_time(info, &self.params);
        if let Some(layer) = self.layers.get_mut(info.layer.raw() as usize) {
            *layer = LayerState { state, seconds: 0.0, time, ended: false, cycle_end: false, weight: layer.weight, transition: None };
        }
    }

    /// Set a layer's weight, clamped to `[0, 1]` (a NaN is 0).
    pub fn set_layer_weight(&mut self, layer: LayerId, weight: f32) {
        if let Some(layer) = self.layers.get_mut(layer.raw() as usize) {
            layer.weight = if weight.is_nan() { 0.0 } else { weight.clamp(0.0, 1.0) };
        }
    }

    /// Advance every layer by `dt` seconds; see the module docs.
    pub fn step(&mut self, dt: f32) -> Switched {
        let dt = if dt.is_finite() && dt > 0.0 { dt } else { 0.0 };
        let mut switched = 0;
        for index in 0..self.layers.len() {
            self.advance(index, dt);
            if let Some(transition) = self.choose(index) {
                self.switch(index, transition);
                switched |= 1 << index;
            }
        }
        self.params.drop_triggers();
        Switched(switched)
    }

    fn advance(&mut self, index: usize, dt: f32) {
        let graph = &self.graph;
        let params = &self.params;
        let layer = &mut self.layers[index];
        if let Some(transition) = &mut layer.transition {
            transition.elapsed = (transition.elapsed + dt).min(f32::MAX);
            if let Some(from) = graph.state_info(transition.from) {
                transition.from_time = advance_clip(from, transition.from_time, dt, params).time;
            }
            if transition.elapsed >= transition.blend.seconds() {
                layer.transition = None;
            }
        }
        layer.seconds = (layer.seconds + dt).min(f32::MAX);
        let Some(state) = graph.state_info(layer.state) else { return };
        let advanced = advance_clip(state, layer.time, dt, params);
        layer.time = advanced.time;
        layer.ended = !state.looping && (layer.ended || advanced.reached_end);
        layer.cycle_end = if state.looping { advanced.reached_end } else { layer.ended };
    }

    /// The transition that switches layer `index` this step, if any.
    fn choose(&self, index: usize) -> Option<u32> {
        let layer = &self.layers[index];
        let blocked = layer.transition.and_then(|running| self.graph.transition_def(running.transition)).is_some_and(|running| !running.interruptible);
        if blocked {
            return None;
        }
        let state = self.graph.state_info(layer.state)?;
        let facts = StateFacts { ended: layer.ended, seconds: layer.seconds };
        state.outgoing.iter().copied().find(|index| {
            self.graph.transition_def(*index).is_some_and(|transition| (!transition.at_end || layer.cycle_end) && transition.condition.holds(&self.params, facts))
        })
    }

    fn switch(&mut self, index: usize, transition_index: u32) {
        let Some(transition) = self.graph.transition_def(transition_index) else { return };
        let mut triggers = Vec::new();
        transition.condition.consumed_triggers(&mut triggers);
        for trigger in triggers {
            self.params.consume(trigger);
        }
        let (Some(from), Some(to)) = (self.graph.state_info(self.layers[index].state), self.graph.state_info(transition.to)) else { return };
        let layer = self.layers[index];
        let time = if transition.synced { normalized(from, layer.time) * to.length } else { entry_time(to, &self.params) };
        let blend = transition.blend;
        let running = (blend.seconds() > 0.0).then_some(ActiveTransition { transition: transition_index, from: layer.state, from_time: layer.time, elapsed: 0.0, blend });
        self.layers[index] = LayerState { state: transition.to, seconds: 0.0, time, ended: false, cycle_end: false, weight: layer.weight, transition: running };
    }

    fn layer(&self, layer: LayerId) -> Option<&LayerState> {
        self.layers.get(layer.raw() as usize)
    }

    /// A layer's current state (during a transition, the state it is moving to).
    pub fn state(&self, layer: LayerId) -> StateId {
        self.layer(layer).map_or(NO_STATE, |layer| layer.state)
    }

    /// The name of a layer's current state; empty for a layer of another graph.
    pub fn state_name(&self, layer: LayerId) -> &str {
        self.graph.state_name(self.state(layer))
    }

    /// The current state's clip time in seconds.
    pub fn clip_time(&self, layer: LayerId) -> f32 {
        self.layer(layer).map_or(0.0, |layer| layer.time)
    }

    /// The current state's clip time over its length, in `[0, 1]` (0 with no clip).
    pub fn normalized_time(&self, layer: LayerId) -> f32 {
        let Some(layer) = self.layer(layer) else { return 0.0 };
        self.graph.state_info(layer.state).map_or(0.0, |state| normalized(state, layer.time))
    }

    /// Seconds since the layer entered its current state.
    pub fn state_seconds(&self, layer: LayerId) -> f32 {
        self.layer(layer).map_or(0.0, |layer| layer.seconds)
    }

    /// The layer's weight.
    pub fn layer_weight(&self, layer: LayerId) -> f32 {
        self.layer(layer).map_or(0.0, |layer| layer.weight)
    }

    /// Whether the layer is blending into its current state.
    pub fn in_transition(&self, layer: LayerId) -> bool {
        self.transition(layer).is_some()
    }

    /// The transition the layer is blending through.
    pub fn transition(&self, layer: LayerId) -> Option<ActiveTransition> {
        self.layer(layer).and_then(|layer| layer.transition)
    }

    /// For a probe: each layer's state, normalized time, seconds in state, weight and running
    /// transition, then every parameter by name. Keys and order never change.
    pub fn probe(&self) -> Value {
        let mut layers = Value::array();
        for (id, layer) in self.graph.layers().zip(&self.layers) {
            let mut entry = Value::object();
            entry.set("layer", Value::from(self.graph.layer_name(id)));
            entry.set("state", Value::from(self.graph.state_name(layer.state)));
            entry.set("t", Value::from(self.normalized_time(id)));
            entry.set("seconds", Value::from(layer.seconds));
            entry.set("weight", Value::from(layer.weight));
            let from = layer.transition.map_or(Value::Null, |running| Value::from(self.graph.state_name(running.from)));
            entry.set("from", from);
            entry.set("blend", layer.transition.map_or(Value::Null, |running| Value::from(running.progress())));
            layers.push(entry);
        }
        let mut params = Value::object();
        for (name, value) in self.graph.param_names().zip(self.params.values()) {
            params.set(name, param_value(*value));
        }
        let mut probe = Value::object();
        probe.set("layers", layers);
        probe.set("params", params);
        probe
    }

    /// FNV-1a 64 over every layer's state, times, flags, weight and transition and every
    /// parameter's bits: equal digests mean equal machines.
    pub fn digest(&self) -> u64 {
        let mut hash = genex_core::digest::FNV_OFFSET_BASIS;
        for layer in &self.layers {
            hash = fnv1a64_from(&layer.state.raw().to_le_bytes(), hash);
            for number in [layer.seconds, layer.time, layer.weight] {
                hash = fnv1a64_from(&number.to_bits().to_le_bytes(), hash);
            }
            hash = fnv1a64_from(&[u8::from(layer.ended), u8::from(layer.cycle_end), u8::from(layer.transition.is_some())], hash);
            if let Some(running) = layer.transition {
                hash = fnv1a64_from(&running.transition.to_le_bytes(), hash);
                hash = fnv1a64_from(&running.from.raw().to_le_bytes(), hash);
                for number in [running.from_time, running.elapsed, running.blend.seconds()] {
                    hash = fnv1a64_from(&number.to_bits().to_le_bytes(), hash);
                }
            }
        }
        for value in self.params.values() {
            hash = match *value {
                ParamValue::Float(number) => fnv1a64_from(&number.to_bits().to_le_bytes(), hash),
                ParamValue::Vec2(vector) => fnv1a64_from(&[vector.x.to_bits().to_le_bytes(), vector.y.to_bits().to_le_bytes()].concat(), hash),
                ParamValue::Bool(flag) | ParamValue::Trigger(flag) => fnv1a64_from(&[u8::from(flag)], hash),
            };
        }
        hash
    }
}

fn param_value(value: ParamValue) -> Value {
    match value {
        ParamValue::Float(number) => Value::from(number),
        ParamValue::Vec2(vector) => Value::Array(vec![Value::from(vector.x), Value::from(vector.y)]),
        ParamValue::Bool(flag) | ParamValue::Trigger(flag) => Value::from(flag),
    }
}

/// A state's clip speed this tick: its fixed speed times its parameter, 0 when not finite.
fn speed(state: &StateInfo, params: &Params) -> f32 {
    let Motion::Clip(motion) = &state.motion else { return 0.0 };
    let speed = motion.fixed_speed() * motion.speed_param().map_or(1.0, |param| params.float(param));
    if speed.is_finite() { speed } else { 0.0 }
}

/// Where a state's clip starts: 0, or the end for a `once` clip playing backwards.
fn entry_time(state: &StateInfo, params: &Params) -> f32 {
    if !state.looping && speed(state, params) < 0.0 { state.length } else { 0.0 }
}

/// A clip time over its state's length, in `[0, 1]`.
fn normalized(state: &StateInfo, time: f32) -> f32 {
    if state.length > 0.0 { (time / state.length).clamp(0.0, 1.0) } else { 0.0 }
}

struct Advanced {
    time: f32,
    /// A loop crossed its end or start, or a `once` clip reached the end it plays toward.
    reached_end: bool,
}

fn advance_clip(state: &StateInfo, time: f32, dt: f32, params: &Params) -> Advanced {
    let delta = dt * speed(state, params);
    if state.length <= 0.0 || !delta.is_finite() || delta == 0.0 {
        return Advanced { time, reached_end: false };
    }
    let raw = time + delta;
    if !raw.is_finite() {
        return Advanced { time, reached_end: false };
    }
    if !state.looping {
        let time = raw.clamp(0.0, state.length);
        let reached_end = if delta > 0.0 { time >= state.length } else { time <= 0.0 };
        return Advanced { time, reached_end };
    }
    let reached_end = raw >= state.length || raw < 0.0;
    // `rem_euclid` is fmod, which is exact, so every destination wraps to the same bits (the
    // sampler's `clip_time` rule); `+ 0.0` turns a negative zero positive.
    let wrapped = raw.rem_euclid(state.length) + 0.0;
    let time = if wrapped >= state.length { 0.0 } else { wrapped };
    Advanced { time, reached_end }
}
