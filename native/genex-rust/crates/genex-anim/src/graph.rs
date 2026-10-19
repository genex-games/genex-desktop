//! The animation graph builder: parameters, layers, states and transitions, checked once at
//! `build` into an immutable [`AnimGraph`] that every animator of a character shares.
//!
//! The structure follows Fyrox's layered machine (`machine/{layer,state,transition,parameter}.rs`,
//! MIT): each layer has its own states, weight and mask, and a transition joins two states of one
//! layer. Godot's `AnimationNodeStateMachine` (MIT) adds what Fyrox lacks: priorities, any-state
//! transitions, `at_end` and synced switches. Only the structure and rules were taken; no code was
//! copied.
//!
//! Handles are typed (`LayerId`, `StateId`, `FloatParam`, ...). Names exist for probes and
//! refusals and never decide behaviour. The builder hands out handles without failing; `build`
//! reports the first problem as `animation-graph-invalid`.
//!
//! Choosing a transition: of the transitions out of the current state and the any-state
//! transitions into another state of the layer, the first whose condition holds in the order
//! (higher priority, then earlier declaration) wins. That order is computed here, once per state.

use std::sync::Arc;

use glam::Vec2;

use crate::clip::Clip;
use crate::error::AnimationError;
use crate::humanoid::HumanoidMap;
use crate::ids::{ClipId, LayerId, ParamId, StateId};
use crate::mask::{JointMask, Mask};
use crate::params::{BoolParam, Condition, FloatParam, MAX_CONDITION_NODES, Param, ParamKind, ParamValue, TriggerParam, Vec2Param};
use crate::skeleton::Skeleton;

/// Layers one graph may have (a step reports switched layers as bits of a `u32`).
pub const MAX_LAYERS: usize = 32;
/// States one graph may have, over every layer.
pub const MAX_STATES: usize = 1024;
/// Transitions one graph may have.
pub const MAX_TRANSITIONS: usize = 4096;
/// Parameters one graph may have.
pub const MAX_PARAMS: usize = 256;
/// The longest name of a parameter, layer or state, in bytes.
pub const MAX_NAME_BYTES: usize = 64;
/// How long a transition blends when the builder names no blend (an inertialization).
pub const DEFAULT_BLEND_SECONDS: f32 = 0.2;

/// How a transition moves from one state's pose to the next one's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransitionBlend {
    /// Both states play and their poses are mixed over this many seconds.
    Crossfade(f32),
    /// The next state plays alone and the pose offset at the switch decays over this many seconds.
    Inertialize(f32),
}

impl TransitionBlend {
    /// The blend's length in seconds; 0 is a cut.
    pub const fn seconds(self) -> f32 {
        match self {
            TransitionBlend::Crossfade(seconds) | TransitionBlend::Inertialize(seconds) => seconds,
        }
    }
}

/// What a state plays.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Motion {
    /// Nothing: the layer adds no pose while it is here.
    Empty,
    /// One clip.
    Clip(ClipMotion),
}

impl Motion {
    /// `clip`, looping at speed 1 (chain `.once()`, `.speed(s)`, `.speed_by(param)`).
    pub const fn clip(clip: ClipId) -> ClipMotion {
        ClipMotion { clip, looping: true, speed: 1.0, speed_by: None }
    }
}

/// One clip played by a state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipMotion {
    clip: ClipId,
    looping: bool,
    speed: f32,
    speed_by: Option<FloatParam>,
}

impl ClipMotion {
    /// Play to the end and hold the last frame, instead of looping.
    pub const fn once(self) -> ClipMotion {
        ClipMotion { looping: false, ..self }
    }

    /// Play at `speed` (negative plays backwards).
    pub const fn speed(self, speed: f32) -> ClipMotion {
        ClipMotion { speed, ..self }
    }

    /// Multiply the speed by a float parameter's value each tick.
    pub const fn speed_by(self, param: FloatParam) -> ClipMotion {
        ClipMotion { speed_by: Some(param), ..self }
    }

    /// The clip.
    pub const fn clip_id(&self) -> ClipId {
        self.clip
    }

    /// Whether it loops.
    pub const fn looping(&self) -> bool {
        self.looping
    }

    /// Its fixed speed.
    pub const fn fixed_speed(&self) -> f32 {
        self.speed
    }

    /// The parameter its speed is multiplied by.
    pub const fn speed_param(&self) -> Option<FloatParam> {
        self.speed_by
    }
}

impl From<ClipMotion> for Motion {
    fn from(motion: ClipMotion) -> Motion {
        Motion::Clip(motion)
    }
}

/// How a layer's pose joins the layers before it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LayerBlend {
    /// Moves the joints in its mask toward its pose by its weight.
    Override,
    /// Adds its pose's difference from this clip's first frame (`base × delta`).
    Additive(ClipId),
}

/// A transition as declared.
#[derive(Clone, Debug, PartialEq)]
pub struct TransitionDef {
    /// The state it leaves; `None` for an any-state transition.
    pub from: Option<StateId>,
    /// The state it enters.
    pub to: StateId,
    /// What must hold.
    pub condition: Condition,
    /// It waits for the state's clip to end (a `once` clip) or to finish a cycle (a loop).
    pub at_end: bool,
    /// The next state starts at the normalized time the last one had.
    pub synced: bool,
    /// How it blends.
    pub blend: TransitionBlend,
    /// Higher wins over lower when several hold.
    pub priority: u8,
    /// Another transition may start while this one blends.
    pub interruptible: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct ParamDef {
    name: String,
    initial: ParamValue,
}

#[derive(Clone, Debug, PartialEq)]
struct LayerDef {
    name: String,
    mask: Mask,
    weight: f32,
    blend: LayerBlend,
}

#[derive(Clone, Debug, PartialEq)]
struct StateDef {
    name: String,
    layer: LayerId,
    motion: Motion,
}

/// A checked layer.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LayerInfo {
    pub(crate) name: String,
    pub(crate) mask: JointMask,
    pub(crate) weight: f32,
    pub(crate) blend: LayerBlend,
    pub(crate) entry: StateId,
}

/// A checked state, with what the machine reads each tick precomputed.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StateInfo {
    pub(crate) name: String,
    pub(crate) layer: LayerId,
    pub(crate) motion: Motion,
    /// The motion's length in seconds (0 for `Empty`).
    pub(crate) length: f32,
    pub(crate) looping: bool,
    /// The transitions to try, best first.
    pub(crate) outgoing: Vec<u32>,
}

#[derive(Debug, PartialEq)]
struct GraphDef {
    params: Vec<ParamDef>,
    layers: Vec<LayerInfo>,
    states: Vec<StateInfo>,
    transitions: Vec<TransitionDef>,
}

/// A checked animation graph: cheap to clone (an `Arc`), shared by every animator built from it.
#[derive(Clone, Debug)]
pub struct AnimGraph {
    def: Arc<GraphDef>,
}

impl PartialEq for AnimGraph {
    fn eq(&self, other: &AnimGraph) -> bool {
        Arc::ptr_eq(&self.def, &other.def) || self.def == other.def
    }
}

impl AnimGraph {
    /// A builder over a character's skeleton (for layer masks) and clips (for state motions).
    pub fn builder<'a>(skeleton: &'a Skeleton, clips: &'a [Clip]) -> AnimGraphBuilder<'a> {
        AnimGraphBuilder { skeleton, clips, params: Vec::new(), layers: Vec::new(), states: Vec::new(), transitions: Vec::new(), problems: Vec::new() }
    }

    /// Layers, in declaration order (the order they are evaluated and stacked).
    pub fn layers(&self) -> impl ExactSizeIterator<Item = LayerId> + '_ {
        (0..self.def.layers.len() as u32).map(LayerId)
    }

    /// The layer with this name.
    pub fn layer(&self, name: &str) -> Option<LayerId> {
        self.def.layers.iter().position(|layer| layer.name == name).map(|index| LayerId(index as u32))
    }

    /// A layer's name; empty for a layer of another graph.
    pub fn layer_name(&self, layer: LayerId) -> &str {
        self.layer_info(layer).map_or("", |info| &info.name)
    }

    /// A layer's mask, one weight per joint.
    pub fn layer_mask(&self, layer: LayerId) -> Option<&JointMask> {
        self.layer_info(layer).map(|info| &info.mask)
    }

    /// How a layer joins the layers before it.
    pub fn layer_blend(&self, layer: LayerId) -> Option<LayerBlend> {
        self.layer_info(layer).map(|info| info.blend)
    }

    /// A layer's weight when an animator starts.
    pub fn layer_weight(&self, layer: LayerId) -> f32 {
        self.layer_info(layer).map_or(0.0, |info| info.weight)
    }

    /// The state a layer starts in: its first declared state.
    pub fn entry(&self, layer: LayerId) -> Option<StateId> {
        self.layer_info(layer).map(|info| info.entry)
    }

    /// The state of `layer` with this name.
    pub fn state(&self, layer: LayerId, name: &str) -> Option<StateId> {
        self.def.states.iter().position(|state| state.layer == layer && state.name == name).map(|index| StateId(index as u32))
    }

    /// A state's name; empty for a state of another graph.
    pub fn state_name(&self, state: StateId) -> &str {
        self.state_info(state).map_or("", |info| &info.name)
    }

    /// The layer a state belongs to.
    pub fn state_layer(&self, state: StateId) -> Option<LayerId> {
        self.state_info(state).map(|info| info.layer)
    }

    /// What a state plays.
    pub fn state_motion(&self, state: StateId) -> Option<&Motion> {
        self.state_info(state).map(|info| &info.motion)
    }

    /// The length of a state's motion in seconds (0 for `Empty`).
    pub fn state_length(&self, state: StateId) -> f32 {
        self.state_info(state).map_or(0.0, |info| info.length)
    }

    /// Every transition, in declaration order.
    pub fn transitions(&self) -> &[TransitionDef] {
        &self.def.transitions
    }

    /// Parameter names, in declaration order.
    pub fn param_names(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.def.params.iter().map(|param| param.name.as_str())
    }

    pub(crate) fn initial_params(&self) -> Vec<ParamValue> {
        self.def.params.iter().map(|param| param.initial).collect()
    }

    pub(crate) fn layer_info(&self, layer: LayerId) -> Option<&LayerInfo> {
        self.def.layers.get(layer.raw() as usize)
    }

    pub(crate) fn layer_infos(&self) -> &[LayerInfo] {
        &self.def.layers
    }

    pub(crate) fn state_info(&self, state: StateId) -> Option<&StateInfo> {
        self.def.states.get(state.raw() as usize)
    }

    pub(crate) fn transition_def(&self, index: u32) -> Option<&TransitionDef> {
        self.def.transitions.get(index as usize)
    }
}

/// Builds an [`AnimGraph`]; see the module docs.
#[derive(Debug)]
pub struct AnimGraphBuilder<'a> {
    skeleton: &'a Skeleton,
    clips: &'a [Clip],
    params: Vec<ParamDef>,
    layers: Vec<LayerDef>,
    states: Vec<StateDef>,
    transitions: Vec<TransitionDef>,
    problems: Vec<String>,
}

impl<'a> AnimGraphBuilder<'a> {
    /// The clip with exactly this name.
    pub fn clip(&self, name: &str) -> Option<ClipId> {
        self.clips.iter().position(|clip| clip.name() == name).map(|index| ClipId(index as u32))
    }

    /// Every clip with its name, in order.
    pub fn clips(&self) -> impl ExactSizeIterator<Item = (ClipId, &str)> + '_ {
        self.clips.iter().enumerate().map(|(index, clip)| (ClipId(index as u32), clip.name()))
    }

    fn param(&mut self, name: &str, initial: ParamValue) -> ParamId {
        self.params.push(ParamDef { name: name.to_owned(), initial });
        ParamId((self.params.len() - 1) as u32)
    }

    /// A float parameter.
    pub fn float(&mut self, name: &str, initial: f32) -> FloatParam {
        FloatParam(self.param(name, ParamValue::Float(initial)))
    }

    /// A vec2 parameter.
    pub fn vec2(&mut self, name: &str, initial: Vec2) -> Vec2Param {
        Vec2Param(self.param(name, ParamValue::Vec2(initial)))
    }

    /// A bool parameter.
    pub fn bool(&mut self, name: &str, initial: bool) -> BoolParam {
        BoolParam(self.param(name, ParamValue::Bool(initial)))
    }

    /// A trigger, consumed by the transition that takes it.
    pub fn trigger(&mut self, name: &str) -> TriggerParam {
        TriggerParam(self.param(name, ParamValue::Trigger(false)))
    }

    /// A layer over every joint at weight 1, overriding the layers before it. The first layer is
    /// the base pose.
    pub fn layer(&mut self, name: &str) -> LayerId {
        self.layers.push(LayerDef { name: name.to_owned(), mask: Mask::All, weight: 1.0, blend: LayerBlend::Override });
        LayerId((self.layers.len() - 1) as u32)
    }

    fn layer_def(&mut self, layer: LayerId) -> Option<&mut LayerDef> {
        let found = self.layers.get_mut(layer.raw() as usize);
        if found.is_none() {
            self.problems.push(format!("layer {} is not a layer of this graph", layer.raw()));
        }
        found
    }

    /// Limit a layer to the joints of `mask`.
    pub fn layer_mask(&mut self, layer: LayerId, mask: Mask) -> &mut Self {
        if let Some(def) = self.layer_def(layer) {
            def.mask = mask;
        }
        self
    }

    /// Make a layer additive: it adds its pose's difference from `reference`'s first frame.
    pub fn layer_additive(&mut self, layer: LayerId, reference: ClipId) -> &mut Self {
        if let Some(def) = self.layer_def(layer) {
            def.blend = LayerBlend::Additive(reference);
        }
        self
    }

    /// A layer's starting weight, clamped to `[0, 1]`.
    pub fn layer_weight(&mut self, layer: LayerId, weight: f32) -> &mut Self {
        if let Some(def) = self.layer_def(layer) {
            def.weight = weight;
        }
        self
    }

    /// A state of `layer`; the first state of a layer is where it starts.
    pub fn state(&mut self, layer: LayerId, name: &str, motion: impl Into<Motion>) -> StateId {
        self.states.push(StateDef { name: name.to_owned(), layer, motion: motion.into() });
        StateId((self.states.len() - 1) as u32)
    }

    /// A transition from `from` to `to` (both of one layer), inertialized over
    /// [`DEFAULT_BLEND_SECONDS`] and always holding until `when` says otherwise.
    pub fn transition(&mut self, from: StateId, to: StateId) -> TransitionBuilder<'_> {
        self.push_transition(Some(from), to)
    }

    /// A transition into `to` from whichever other state its layer is in.
    pub fn transition_from_any(&mut self, to: StateId) -> TransitionBuilder<'_> {
        self.push_transition(None, to)
    }

    fn push_transition(&mut self, from: Option<StateId>, to: StateId) -> TransitionBuilder<'_> {
        self.transitions.push(TransitionDef {
            from,
            to,
            condition: Condition::Always,
            at_end: false,
            synced: false,
            blend: TransitionBlend::Inertialize(DEFAULT_BLEND_SECONDS),
            priority: 0,
            interruptible: true,
        });
        let last = self.transitions.len() - 1;
        TransitionBuilder { def: &mut self.transitions[last] }
    }

    /// The checked graph. Refused `animation-graph-invalid`: no layer, a layer with no state, more
    /// than the caps ([`MAX_LAYERS`], [`MAX_STATES`], [`MAX_TRANSITIONS`], [`MAX_PARAMS`],
    /// [`MAX_CONDITION_NODES`]), an empty or over-long name, a parameter or layer name used twice,
    /// a state name used twice in one layer, a handle of another graph (a layer, a state, a clip,
    /// or a parameter of the wrong kind), a transition across layers, a NaN, infinite or negative
    /// blend time, a NaN threshold, a non-finite starting value, clip speed or layer weight, a
    /// mask the skeleton cannot resolve, an additive first layer, or `at_end`/`state_ended` out of
    /// a state with no clip.
    pub fn build(self) -> Result<AnimGraph, AnimationError> {
        if let Some(problem) = self.problems.first() {
            return Err(AnimationError::graph_invalid(problem.clone()));
        }
        self.check_counts().map_err(AnimationError::graph_invalid)?;
        self.check_params().map_err(AnimationError::graph_invalid)?;
        let layers = self.check_layers().map_err(AnimationError::graph_invalid)?;
        let mut states = self.check_states().map_err(AnimationError::graph_invalid)?;
        self.check_transitions(&states).map_err(AnimationError::graph_invalid)?;
        for (index, state) in states.iter_mut().enumerate() {
            state.outgoing = self.outgoing(StateId(index as u32), state.layer);
        }
        let params = self.params;
        let transitions = self.transitions;
        Ok(AnimGraph { def: Arc::new(GraphDef { params, layers, states, transitions }) })
    }

    fn check_counts(&self) -> Result<(), String> {
        let counts = [
            ("layers", self.layers.len(), MAX_LAYERS),
            ("states", self.states.len(), MAX_STATES),
            ("transitions", self.transitions.len(), MAX_TRANSITIONS),
            ("parameters", self.params.len(), MAX_PARAMS),
        ];
        if let Some((what, count, cap)) = counts.into_iter().find(|(_, count, cap)| count > cap) {
            return Err(format!("{count} {what}, more than {cap}"));
        }
        if self.layers.is_empty() {
            return Err("the graph has no layer".to_owned());
        }
        Ok(())
    }

    fn check_params(&self) -> Result<(), String> {
        for (index, param) in self.params.iter().enumerate() {
            check_name("parameter", &param.name)?;
            if self.params[..index].iter().any(|earlier| earlier.name == param.name) {
                return Err(format!("parameter {:?} is declared twice", param.name));
            }
            if !param.initial.is_finite() {
                return Err(format!("parameter {:?} starts at a non-finite value", param.name));
            }
        }
        Ok(())
    }

    fn check_layers(&self) -> Result<Vec<LayerInfo>, String> {
        let humanoid = HumanoidMap::of(self.skeleton);
        let mut layers = Vec::with_capacity(self.layers.len());
        for (index, layer) in self.layers.iter().enumerate() {
            check_name("layer", &layer.name)?;
            if self.layers[..index].iter().any(|earlier| earlier.name == layer.name) {
                return Err(format!("layer {:?} is declared twice", layer.name));
            }
            let entry = self.states.iter().position(|state| state.layer.raw() as usize == index);
            let entry = entry.ok_or_else(|| format!("layer {:?} has no state", layer.name))?;
            if layer.weight.is_nan() {
                return Err(format!("layer {:?} has a NaN weight", layer.name));
            }
            let mask = layer.mask.resolve(self.skeleton, Some(&humanoid)).ok_or_else(|| format!("layer {:?}'s mask names joints the skeleton lacks", layer.name))?;
            if let LayerBlend::Additive(reference) = layer.blend {
                if index == 0 {
                    return Err(format!("the first layer {:?} has nothing to add onto", layer.name));
                }
                self.check_clip(reference)?;
            }
            layers.push(LayerInfo { name: layer.name.clone(), mask, weight: layer.weight.clamp(0.0, 1.0), blend: layer.blend, entry: StateId(entry as u32) });
        }
        Ok(layers)
    }

    fn check_clip(&self, clip: ClipId) -> Result<&Clip, String> {
        self.clips.get(clip.raw() as usize).ok_or_else(|| format!("clip {} is not one of the graph's {} clips", clip.raw(), self.clips.len()))
    }

    fn check_param<P: Param>(&self, param: P) -> Result<(), String> {
        self.check_param_kind(param.id(), P::KIND)
    }

    fn check_param_kind(&self, id: ParamId, kind: ParamKind) -> Result<(), String> {
        match self.params.get(id.raw() as usize) {
            Some(param) if param.initial.kind() == kind => Ok(()),
            Some(param) => Err(format!("parameter {:?} is a {:?}, read as a {kind:?}", param.name, param.initial.kind())),
            None => Err(format!("parameter {} is not a parameter of this graph", id.raw())),
        }
    }

    fn check_states(&self) -> Result<Vec<StateInfo>, String> {
        let mut states = Vec::with_capacity(self.states.len());
        for (index, state) in self.states.iter().enumerate() {
            check_name("state", &state.name)?;
            if (state.layer.raw() as usize) >= self.layers.len() {
                return Err(format!("state {:?} is in layer {}, not a layer of this graph", state.name, state.layer.raw()));
            }
            if self.states[..index].iter().any(|earlier| earlier.layer == state.layer && earlier.name == state.name) {
                return Err(format!("state {:?} is declared twice in one layer", state.name));
            }
            let (length, looping) = match &state.motion {
                Motion::Empty => (0.0, false),
                Motion::Clip(motion) => {
                    let clip = self.check_clip(motion.clip)?;
                    if !motion.speed.is_finite() {
                        return Err(format!("state {:?} plays at a non-finite speed", state.name));
                    }
                    if let Some(param) = motion.speed_by {
                        self.check_param(param)?;
                    }
                    (clip.duration(), motion.looping)
                }
            };
            states.push(StateInfo { name: state.name.clone(), layer: state.layer, motion: state.motion.clone(), length, looping, outgoing: Vec::new() });
        }
        Ok(states)
    }

    fn check_transitions(&self, states: &[StateInfo]) -> Result<(), String> {
        for transition in &self.transitions {
            let to = states.get(transition.to.raw() as usize).ok_or_else(|| format!("state {} is not a state of this graph", transition.to.raw()))?;
            if let Some(from) = transition.from {
                let from = states.get(from.raw() as usize).ok_or_else(|| format!("state {} is not a state of this graph", from.raw()))?;
                if from.layer != to.layer {
                    return Err(format!("{:?} → {:?} crosses from layer {} to layer {}", from.name, to.name, from.layer.raw(), to.layer.raw()));
                }
                let reads_end = transition.at_end || transition.condition.reads_state_ended();
                if reads_end && matches!(from.motion, Motion::Empty) {
                    return Err(format!("{:?} → {:?} waits for the end of a state with no clip", from.name, to.name));
                }
            }
            let seconds = transition.blend.seconds();
            if !seconds.is_finite() || seconds < 0.0 {
                return Err(format!("a transition into {:?} blends over {seconds} s", to.name));
            }
            self.check_condition(&transition.condition)?;
        }
        Ok(())
    }

    fn check_condition(&self, condition: &Condition) -> Result<(), String> {
        let nodes = condition.nodes();
        if nodes > MAX_CONDITION_NODES {
            return Err(format!("a condition has {nodes} nodes, more than {MAX_CONDITION_NODES}"));
        }
        let mut problem = None;
        condition.visit(&mut |param, threshold| {
            if problem.is_some() {
                return;
            }
            if threshold.is_some_and(f32::is_nan) {
                problem = Some("a condition compares against NaN".to_owned());
            } else if let Some((id, kind)) = param {
                problem = self.check_param_kind(id, kind).err();
            }
        });
        problem.map_or(Ok(()), Err)
    }

    /// The transitions to try out of `state`, best first: its own and the any-state ones into
    /// another state of its layer, by priority (higher first) and then declaration.
    fn outgoing(&self, state: StateId, layer: LayerId) -> Vec<u32> {
        let applies = |transition: &TransitionDef| match transition.from {
            Some(from) => from == state,
            None => transition.to != state && self.states[transition.to.raw() as usize].layer == layer,
        };
        let mut outgoing: Vec<u32> = (0..self.transitions.len() as u32).filter(|index| applies(&self.transitions[*index as usize])).collect();
        outgoing.sort_by_key(|index| (std::cmp::Reverse(self.transitions[*index as usize].priority), *index));
        outgoing
    }
}

fn check_name(what: &str, name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_NAME_BYTES {
        return Err(format!("a {what} name of {} bytes (1 to {MAX_NAME_BYTES})", name.len()));
    }
    Ok(())
}

/// Shapes one transition as it is declared.
#[derive(Debug)]
pub struct TransitionBuilder<'b> {
    def: &'b mut TransitionDef,
}

impl TransitionBuilder<'_> {
    /// It needs `condition` to hold (a second `when` must hold too).
    pub fn when(self, condition: Condition) -> Self {
        let current = std::mem::replace(&mut self.def.condition, Condition::Always);
        self.def.condition = match current {
            Condition::Always => condition,
            earlier => earlier.and(condition),
        };
        self
    }

    /// It waits for the state's `once` clip to end, or a looping clip to finish a cycle (Godot's
    /// `AtEnd`).
    pub fn at_end(self) -> Self {
        self.def.at_end = true;
        self
    }

    /// The next state starts at the normalized time the last one had (Godot's `Sync`).
    pub fn synced(self) -> Self {
        self.def.synced = true;
        self
    }

    /// Both states play and mix over `seconds` (0 cuts).
    pub fn crossfade(self, seconds: f32) -> Self {
        self.def.blend = TransitionBlend::Crossfade(seconds);
        self
    }

    /// The next state plays alone and the pose offset decays over `seconds` (the default, over
    /// [`DEFAULT_BLEND_SECONDS`]; 0 cuts).
    pub fn inertialize(self, seconds: f32) -> Self {
        self.def.blend = TransitionBlend::Inertialize(seconds);
        self
    }

    /// Of several transitions that hold, the higher priority wins (the default is 0).
    pub fn priority(self, priority: u8) -> Self {
        self.def.priority = priority;
        self
    }

    /// Whether another transition may start while this one blends (the default is true).
    pub fn interruptible(self, yes: bool) -> Self {
        self.def.interruptible = yes;
        self
    }
}
