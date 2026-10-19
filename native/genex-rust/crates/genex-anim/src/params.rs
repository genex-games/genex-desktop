//! Graph parameters (float, vec2, bool and trigger) and the typed conditions transitions test.
//!
//! A parameter is a typed handle the graph builder hands out, so a game never names one by text:
//! `speed.above(0.1)`, `grounded.is(false)`, `attack.fired()`. Conditions combine with `and`, `or`
//! and `not` (Fyrox's `LogicNode`, MIT; the structure only, no code was copied) and read the
//! state they leave: [`Condition::state_ended`] and [`Condition::state_seconds_over`].
//!
//! A trigger is pending from [`Params::fire`] until the end of the next machine step. The
//! transition that wins consumes every pending trigger its condition names outside a `not`, so a
//! trigger fired once moves exactly one transition; one nothing consumes is dropped at the end of
//! that step rather than firing a transition later (Godot's one-shot request is consumed the same
//! way, MIT).

use glam::Vec2;

use crate::ids::ParamId;

/// The most nodes (comparisons, `and`, `or`, `not`) one condition may have.
pub const MAX_CONDITION_NODES: usize = 64;

/// A float parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FloatParam(pub(crate) ParamId);

/// A two-component parameter (a heading, a blend-space position).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Vec2Param(pub(crate) ParamId);

/// A bool parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BoolParam(pub(crate) ParamId);

/// A trigger: fired by the game, consumed by the one transition that takes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TriggerParam(pub(crate) ParamId);

/// The kind of a parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ParamKind {
    /// A float.
    Float,
    /// Two floats.
    Vec2,
    /// A bool.
    Bool,
    /// A trigger.
    Trigger,
}

/// A parameter's value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamValue {
    /// A float.
    Float(f32),
    /// Two floats.
    Vec2(Vec2),
    /// A bool.
    Bool(bool),
    /// A trigger: whether it is pending.
    Trigger(bool),
}

impl ParamValue {
    /// Its kind.
    pub const fn kind(self) -> ParamKind {
        match self {
            ParamValue::Float(_) => ParamKind::Float,
            ParamValue::Vec2(_) => ParamKind::Vec2,
            ParamValue::Bool(_) => ParamKind::Bool,
            ParamValue::Trigger(_) => ParamKind::Trigger,
        }
    }

    /// Every number in it is finite.
    pub fn is_finite(self) -> bool {
        match self {
            ParamValue::Float(value) => value.is_finite(),
            ParamValue::Vec2(value) => value.is_finite(),
            ParamValue::Bool(_) | ParamValue::Trigger(_) => true,
        }
    }
}

/// A parameter a condition, a clip speed or a setter names: its slot and the kind it must be.
pub(crate) trait Param: Copy {
    /// The kind the slot must hold.
    const KIND: ParamKind;
    /// The slot.
    fn id(self) -> ParamId;
}

macro_rules! param {
    ($handle:ident, $kind:ident) => {
        impl Param for $handle {
            const KIND: ParamKind = ParamKind::$kind;
            fn id(self) -> ParamId {
                self.0
            }
        }

        impl $handle {
            /// The raw slot, for probes and saves.
            pub const fn raw(self) -> u32 {
                self.0.raw()
            }
        }
    };
}

param!(FloatParam, Float);
param!(Vec2Param, Vec2);
param!(BoolParam, Bool);
param!(TriggerParam, Trigger);

/// A component of a [`Vec2Param`] a condition compares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Axis {
    /// The first component (strafe).
    X,
    /// The second component (forward).
    Y,
    /// The length.
    Length,
}

/// A typed predicate over the parameters and the state a transition leaves.
#[derive(Clone, Debug, PartialEq)]
pub enum Condition {
    /// Always holds (a transition with no `when`).
    Always,
    /// The float is greater than the threshold.
    Above(FloatParam, f32),
    /// The float is less than the threshold.
    Below(FloatParam, f32),
    /// A component of the vec2 is greater than the threshold.
    Vec2Above(Vec2Param, Axis, f32),
    /// A component of the vec2 is less than the threshold.
    Vec2Below(Vec2Param, Axis, f32),
    /// The bool equals the value.
    Is(BoolParam, bool),
    /// The trigger is pending.
    Fired(TriggerParam),
    /// The state's `once` clip has reached its end (never on a loop).
    StateEnded,
    /// More than this many seconds have passed since the state was entered.
    StateSecondsOver(f32),
    /// Both hold.
    And(Box<Condition>, Box<Condition>),
    /// Either holds.
    Or(Box<Condition>, Box<Condition>),
    /// It does not hold.
    Not(Box<Condition>),
}

/// What a condition reads of the state its transition leaves.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct StateFacts {
    /// The state's `once` clip has reached its end.
    pub(crate) ended: bool,
    /// Seconds since the state was entered.
    pub(crate) seconds: f32,
}

impl Condition {
    /// Always holds.
    pub const fn always() -> Condition {
        Condition::Always
    }

    /// Holds from the tick the state's `once` clip reaches its end; never on a looping clip.
    pub const fn state_ended() -> Condition {
        Condition::StateEnded
    }

    /// Holds once more than `seconds` have passed since the state was entered.
    pub const fn state_seconds_over(seconds: f32) -> Condition {
        Condition::StateSecondsOver(seconds)
    }

    /// Both this and `other` hold.
    pub fn and(self, other: Condition) -> Condition {
        Condition::And(Box::new(self), Box::new(other))
    }

    /// This or `other` holds.
    pub fn or(self, other: Condition) -> Condition {
        Condition::Or(Box::new(self), Box::new(other))
    }

    /// This does not hold.
    #[allow(clippy::should_implement_trait, reason = "the graph API reads `a.not()` without importing std::ops::Not; `!a` works too")]
    pub fn not(self) -> Condition {
        Condition::Not(Box::new(self))
    }

    /// Whether it holds for `params` and the state facts.
    pub(crate) fn holds(&self, params: &Params, state: StateFacts) -> bool {
        match self {
            Condition::Always => true,
            Condition::Above(param, threshold) => params.float(*param) > *threshold,
            Condition::Below(param, threshold) => params.float(*param) < *threshold,
            Condition::Vec2Above(param, axis, threshold) => component(params.vec2(*param), *axis) > *threshold,
            Condition::Vec2Below(param, axis, threshold) => component(params.vec2(*param), *axis) < *threshold,
            Condition::Is(param, value) => params.bool(*param) == *value,
            Condition::Fired(param) => params.pending(*param),
            Condition::StateEnded => state.ended,
            Condition::StateSecondsOver(seconds) => state.seconds > *seconds,
            Condition::And(a, b) => a.holds(params, state) && b.holds(params, state),
            Condition::Or(a, b) => a.holds(params, state) || b.holds(params, state),
            Condition::Not(a) => !a.holds(params, state),
        }
    }

    /// Every trigger it names outside a `not`, in reading order.
    pub(crate) fn consumed_triggers(&self, out: &mut Vec<TriggerParam>) {
        match self {
            Condition::Fired(param) => out.push(*param),
            Condition::And(a, b) | Condition::Or(a, b) => {
                a.consumed_triggers(out);
                b.consumed_triggers(out);
            }
            _ => {}
        }
    }

    /// How many nodes it has.
    pub(crate) fn nodes(&self) -> usize {
        match self {
            Condition::And(a, b) | Condition::Or(a, b) => 1 + a.nodes() + b.nodes(),
            Condition::Not(a) => 1 + a.nodes(),
            _ => 1,
        }
    }

    /// Whether it reads [`Condition::StateEnded`] anywhere.
    pub(crate) fn reads_state_ended(&self) -> bool {
        match self {
            Condition::StateEnded => true,
            Condition::And(a, b) | Condition::Or(a, b) => a.reads_state_ended() || b.reads_state_ended(),
            Condition::Not(a) => a.reads_state_ended(),
            _ => false,
        }
    }

    /// Each parameter it names with the kind it must be, and each threshold it compares against.
    pub(crate) fn visit(&self, out: &mut dyn FnMut(Option<(ParamId, ParamKind)>, Option<f32>)) {
        match self {
            Condition::Always | Condition::StateEnded => {}
            Condition::Above(param, threshold) | Condition::Below(param, threshold) => out(Some((param.id(), FloatParam::KIND)), Some(*threshold)),
            Condition::Vec2Above(param, _, threshold) | Condition::Vec2Below(param, _, threshold) => out(Some((param.id(), Vec2Param::KIND)), Some(*threshold)),
            Condition::Is(param, _) => out(Some((param.id(), BoolParam::KIND)), None),
            Condition::Fired(param) => out(Some((param.id(), TriggerParam::KIND)), None),
            Condition::StateSecondsOver(seconds) => out(None, Some(*seconds)),
            Condition::And(a, b) | Condition::Or(a, b) => {
                a.visit(out);
                b.visit(out);
            }
            Condition::Not(a) => a.visit(out),
        }
    }
}

impl std::ops::Not for Condition {
    type Output = Condition;

    fn not(self) -> Condition {
        Condition::Not(Box::new(self))
    }
}

fn component(value: Vec2, axis: Axis) -> f32 {
    match axis {
        Axis::X => value.x,
        Axis::Y => value.y,
        Axis::Length => value.length(),
    }
}

impl FloatParam {
    /// Holds while the value is greater than `threshold` (a NaN value never is).
    pub const fn above(self, threshold: f32) -> Condition {
        Condition::Above(self, threshold)
    }

    /// Holds while the value is less than `threshold` (a NaN value never is).
    pub const fn below(self, threshold: f32) -> Condition {
        Condition::Below(self, threshold)
    }
}

impl Vec2Param {
    /// Holds while the first component is greater than `threshold`.
    pub const fn x_above(self, threshold: f32) -> Condition {
        Condition::Vec2Above(self, Axis::X, threshold)
    }

    /// Holds while the first component is less than `threshold`.
    pub const fn x_below(self, threshold: f32) -> Condition {
        Condition::Vec2Below(self, Axis::X, threshold)
    }

    /// Holds while the second component is greater than `threshold`.
    pub const fn y_above(self, threshold: f32) -> Condition {
        Condition::Vec2Above(self, Axis::Y, threshold)
    }

    /// Holds while the second component is less than `threshold`.
    pub const fn y_below(self, threshold: f32) -> Condition {
        Condition::Vec2Below(self, Axis::Y, threshold)
    }

    /// Holds while the length is greater than `threshold`.
    pub const fn length_above(self, threshold: f32) -> Condition {
        Condition::Vec2Above(self, Axis::Length, threshold)
    }

    /// Holds while the length is less than `threshold`.
    pub const fn length_below(self, threshold: f32) -> Condition {
        Condition::Vec2Below(self, Axis::Length, threshold)
    }
}

impl BoolParam {
    /// Holds while the value equals `value`.
    pub const fn is(self, value: bool) -> Condition {
        Condition::Is(self, value)
    }
}

impl TriggerParam {
    /// Holds while the trigger is pending; the transition that wins consumes it.
    pub const fn fired(self) -> Condition {
        Condition::Fired(self)
    }
}

/// The current value of every parameter of one graph, in declaration order.
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    values: Vec<ParamValue>,
}

impl Params {
    /// The values a graph starts with.
    pub(crate) fn new(values: Vec<ParamValue>) -> Params {
        Params { values }
    }

    /// Every value, in declaration order.
    pub fn values(&self) -> &[ParamValue] {
        &self.values
    }

    fn slot<P: Param>(&self, param: P) -> Option<ParamValue> {
        self.values.get(param.id().raw() as usize).copied().filter(|value| value.kind() == P::KIND)
    }

    fn slot_mut<P: Param>(&mut self, param: P) -> Option<&mut ParamValue> {
        self.values.get_mut(param.id().raw() as usize).filter(|value| value.kind() == P::KIND)
    }

    /// A float's value; 0 for a handle of another graph.
    pub fn float(&self, param: FloatParam) -> f32 {
        match self.slot(param) {
            Some(ParamValue::Float(value)) => value,
            _ => 0.0,
        }
    }

    /// A vec2's value; zero for a handle of another graph.
    pub fn vec2(&self, param: Vec2Param) -> Vec2 {
        match self.slot(param) {
            Some(ParamValue::Vec2(value)) => value,
            _ => Vec2::ZERO,
        }
    }

    /// A bool's value; false for a handle of another graph.
    pub fn bool(&self, param: BoolParam) -> bool {
        matches!(self.slot(param), Some(ParamValue::Bool(true)))
    }

    /// Whether a trigger is pending.
    pub fn pending(&self, param: TriggerParam) -> bool {
        matches!(self.slot(param), Some(ParamValue::Trigger(true)))
    }

    /// Set a float (a handle of another graph changes nothing).
    pub fn set_float(&mut self, param: FloatParam, value: f32) {
        if let Some(slot) = self.slot_mut(param) {
            *slot = ParamValue::Float(value);
        }
    }

    /// Set a vec2 (a handle of another graph changes nothing).
    pub fn set_vec2(&mut self, param: Vec2Param, value: Vec2) {
        if let Some(slot) = self.slot_mut(param) {
            *slot = ParamValue::Vec2(value);
        }
    }

    /// Set a bool (a handle of another graph changes nothing).
    pub fn set_bool(&mut self, param: BoolParam, value: bool) {
        if let Some(slot) = self.slot_mut(param) {
            *slot = ParamValue::Bool(value);
        }
    }

    /// Fire a trigger: pending until the end of the next step. Firing it twice before a step is
    /// one trigger.
    pub fn fire(&mut self, param: TriggerParam) {
        if let Some(slot) = self.slot_mut(param) {
            *slot = ParamValue::Trigger(true);
        }
    }

    /// Consume a trigger.
    pub(crate) fn consume(&mut self, param: TriggerParam) {
        if let Some(slot) = self.slot_mut(param) {
            *slot = ParamValue::Trigger(false);
        }
    }

    /// Drop every trigger still pending: called at the end of each step.
    pub(crate) fn drop_triggers(&mut self) {
        for value in &mut self.values {
            if let ParamValue::Trigger(pending) = value {
                *pending = false;
            }
        }
    }
}
