//! The animator: what a game holds in its world for one animated character. It owns the graph's
//! [`Machine`] (parameters, states, transitions), one [`TransitionPlayer`] per layer (the pose side
//! of each switch), the IK targets and the evaluated pose, and shares the character's [`AnimSet`]
//! (skeleton, clips, root motion) by `Arc`.
//!
//! Each [`Animator::update`]:
//!
//! 1. steps the machine by `dt`;
//! 2. reads the clip time each playing clip covered (the same [`Span`] rule events use), and from
//!    it the events that fired and the root motion, with the clips' blend weights: events and root
//!    motion come from clip time only, never from a pose;
//! 3. advances each layer's player, which samples the states it shows;
//! 4. runs the evaluation pipeline ([`crate::evaluate`]): layers, IK, the model-space pose.
//!
//! Root motion is the first layer's, blended across a crossfade by its progress; a later override
//! layer whose mask covers the motion root blends its own over it by its weight (an additive layer
//! adds none). Events carry the clip's blend weight times the layer's weight and pass the
//! animator's [`EventFilter`].
//!
//! The pose side runs every update because an inertialized switch starts from the pose the layer
//! was showing, which is simulation state. IK targets are in character (model) space and take
//! effect at the next update. Everything is deterministic: the same script gives the same bits on
//! every destination, a clone continues exactly as the original, and [`Animator::snapshot`] /
//! [`Animator::restore`] carry the whole state (floats as their bits) so a restored run replays
//! the uninterrupted one.

use std::sync::Arc;

use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from, hex64};
use genex_core::json::Value;
use glam::{Mat4, Vec2, Vec3};

use crate::clip::Clip;
use crate::error::AnimationError;
use crate::evaluate::{Evaluation, Inputs, compose, pose_digest, sample_state};
use crate::events::{EventFilter, Fired, Played, Span, collect};
use crate::graph::{AnimGraph, LayerBlend, Motion, TransitionBlend};
use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::{ClipId, EventId, JointId, LayerId, StateId};
use crate::ik::{AimJoint, TwoBoneChain};
use crate::inertial::{InertialOffset, JointOffset, JointVelocity, floats_digest};
use crate::machine::{ActiveTransition, LayerState, Machine, Switched};
use crate::math::Trs;
use crate::params::{BoolParam, FloatParam, ParamValue, Params, TriggerParam, Vec2Param};
use crate::root_motion::{MotionSettings, MotionTrack, RootMotion, blend, extract};
use crate::sample::{SampleCursor, Wrap, sample};
use crate::skeleton::Skeleton;
use crate::transition::{Frozen, TransitionPlayer};

/// The snapshot format [`Animator::snapshot`] writes and [`Animator::restore`] reads.
pub const SNAPSHOT_VERSION: u32 = 1;

/// The most a look-at turns the spine, the neck and the head, in radians.
const LOOK_LIMITS: [f32; 3] = [0.35, 0.6, 0.8];
/// The share of a look-at's turn the spine, the neck and the head take.
const LOOK_SHARES: [f32; 3] = [0.2, 0.3, 0.5];
/// The axis an elbow or knee bends about when its chain is straight, in its own frame.
const LIMB_BEND_AXIS: Vec3 = Vec3::X;

/// A character's animation data: its skeleton, its clips (baked in place when they carry root
/// motion) with their root motion, and its humanoid map. Shared by `Arc` among its animators.
#[derive(Clone, Debug)]
pub struct AnimSet {
    skeleton: Skeleton,
    clips: Vec<Clip>,
    motions: Vec<MotionTrack>,
    humanoid: HumanoidMap,
    motion_root: JointId,
}

impl AnimSet {
    /// `clips` on `skeleton`, played as they are: no root motion.
    pub fn new(skeleton: Skeleton, clips: Vec<Clip>) -> AnimSet {
        let motions = clips.iter().map(|clip| MotionTrack::in_place_for(clip.duration())).collect();
        let humanoid = HumanoidMap::of(&skeleton);
        AnimSet { skeleton, clips, motions, humanoid, motion_root: JointId(0) }
    }

    /// `clips` on `skeleton` with their root motion extracted by `settings` (and baked when it
    /// says so). Refused as [`extract`] refuses.
    pub fn with_root_motion(skeleton: Skeleton, clips: Vec<Clip>, settings: &MotionSettings) -> Result<AnimSet, AnimationError> {
        let mut baked = Vec::with_capacity(clips.len());
        let mut motions = Vec::with_capacity(clips.len());
        for clip in &clips {
            let extracted = extract(&skeleton, clip, settings)?;
            baked.push(extracted.clip);
            motions.push(extracted.motion);
        }
        let humanoid = HumanoidMap::of(&skeleton);
        Ok(AnimSet { skeleton, clips: baked, motions, humanoid, motion_root: settings.root.unwrap_or(JointId(0)) })
    }

    /// The skeleton.
    pub fn skeleton(&self) -> &Skeleton {
        &self.skeleton
    }

    /// The clips, in order (a graph built over them names them by index).
    pub fn clips(&self) -> &[Clip] {
        &self.clips
    }

    /// A clip's root motion (in place for a clip without any).
    pub fn motion(&self, clip: ClipId) -> Option<&MotionTrack> {
        self.motions.get(clip.raw() as usize)
    }

    /// The humanoid map of the skeleton.
    pub fn humanoid(&self) -> &HumanoidMap {
        &self.humanoid
    }

    /// The joint whose motion is the character's.
    pub fn motion_root(&self) -> JointId {
        self.motion_root
    }
}

/// A two-bone limb the animator can aim.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Limb {
    /// Thigh, shin, foot.
    LeftLeg,
    /// Thigh, shin, foot.
    RightLeg,
    /// Upper arm, forearm, hand.
    LeftArm,
    /// Upper arm, forearm, hand.
    RightArm,
}

impl Limb {
    /// Every limb, in the order the pipeline solves them: legs, then arms.
    pub const ALL: [Limb; 4] = [Limb::LeftLeg, Limb::RightLeg, Limb::LeftArm, Limb::RightArm];

    const fn index(self) -> usize {
        match self {
            Limb::LeftLeg => 0,
            Limb::RightLeg => 1,
            Limb::LeftArm => 2,
            Limb::RightArm => 3,
        }
    }

    const fn bones(self) -> [HumanoidBone; 3] {
        match self {
            Limb::LeftLeg => [HumanoidBone::LeftUpperLeg, HumanoidBone::LeftLowerLeg, HumanoidBone::LeftFoot],
            Limb::RightLeg => [HumanoidBone::RightUpperLeg, HumanoidBone::RightLowerLeg, HumanoidBone::RightFoot],
            Limb::LeftArm => [HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand],
            Limb::RightArm => [HumanoidBone::RightUpperArm, HumanoidBone::RightLowerArm, HumanoidBone::RightHand],
        }
    }
}

/// Where a limb's end (foot, hand) should reach, in character (model) space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimbTarget {
    /// The goal.
    pub target: Vec3,
    /// The direction the knee or elbow should point.
    pub pole: Vec3,
    /// How much of the correction to apply, `[0, 1]`; 0 or NaN changes nothing.
    pub weight: f32,
}

/// What the head should look at, in character (model) space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LookTarget {
    /// The point.
    pub target: Vec3,
    /// How much of the look to apply, `[0, 1]`.
    pub weight: f32,
}

/// The IK targets an animator holds.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Targets {
    /// By [`Limb::index`].
    pub(crate) limbs: [Option<LimbTarget>; 4],
    pub(crate) look: Option<LookTarget>,
}

/// The skeleton's IK chains, found once from the humanoid map.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IkRig {
    /// By [`Limb::index`]; `None` where the map lacks a bone.
    pub(crate) limbs: [Option<TwoBoneChain>; 4],
    /// Spine, neck, head (empty when the map lacks one).
    pub(crate) look: Vec<AimJoint>,
    /// The head's forward and up axes in its own frame (model +Z and +Y at rest).
    pub(crate) look_forward: Vec3,
    pub(crate) look_up: Vec3,
}

impl IkRig {
    fn of(skeleton: &Skeleton, humanoid: &HumanoidMap) -> IkRig {
        let limbs = Limb::ALL.map(|limb| {
            let [start, mid, end] = limb.bones().map(|bone| humanoid.joint(bone));
            Some(TwoBoneChain { start: start?, mid: mid?, end: end?, mid_axis: LIMB_BEND_AXIS })
        });
        let spine = [HumanoidBone::UpperChest, HumanoidBone::Chest, HumanoidBone::Spine].iter().find_map(|bone| humanoid.joint(*bone));
        let joints = [spine, humanoid.joint(HumanoidBone::Neck), humanoid.joint(HumanoidBone::Head)];
        let look = match joints {
            [Some(spine), Some(neck), Some(head)] => [spine, neck, head].iter().zip(LOOK_SHARES).zip(LOOK_LIMITS).map(|((joint, share), limit)| AimJoint { joint: *joint, share, limit }).collect(),
            _ => Vec::new(),
        };
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let head = humanoid.joint(HumanoidBone::Head).and_then(|head| rest.get(usize::from(head.raw()))).copied().unwrap_or(Mat4::IDENTITY);
        let inverse = head.inverse();
        IkRig { limbs, look, look_forward: inverse.transform_vector3(Vec3::Z).normalize_or_zero(), look_up: inverse.transform_vector3(Vec3::Y).normalize_or_zero() }
    }
}

/// An event that fired in an update.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnimEvent {
    /// The event (compare with the handle `AnimGraphBuilder::event` returned).
    pub event: EventId,
    /// The layer whose state played it.
    pub layer: LayerId,
    /// The clip whose notify it was.
    pub clip: ClipId,
    /// The clip's blend weight times the layer's weight.
    pub weight: f32,
}

/// What one update produced.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnimatorStep {
    /// How far the character moved, in its own space at the update's start.
    pub root_motion: RootMotion,
    /// The events that fired, layer by layer, each in the order it played.
    pub events: Vec<AnimEvent>,
}

/// A layer as the update found it, before the machine stepped.
#[derive(Clone, Copy, Debug)]
struct Before {
    state: StateId,
    time: f32,
    transition: Option<ActiveTransition>,
}

/// One animated character's state; see the module docs.
#[derive(Clone, Debug)]
pub struct Animator {
    set: Arc<AnimSet>,
    machine: Machine,
    players: Vec<TransitionPlayer>,
    references: Vec<Option<Vec<Trs>>>,
    rig: IkRig,
    targets: Targets,
    filter: EventFilter,
    evaluation: Evaluation,
    before: Vec<Before>,
    played: Vec<Played>,
    fired: Vec<Fired>,
}

impl Animator {
    /// An animator of `graph` over `set`, in each layer's first state and showing its pose.
    /// Refused `animation-graph-invalid` when the graph was built over other data: a state or an
    /// additive layer naming a clip the set lacks or one of another length, or a layer mask sized
    /// for another skeleton.
    pub fn new(set: Arc<AnimSet>, graph: &AnimGraph) -> Result<Animator, AnimationError> {
        check_graph(&set, graph).map_err(AnimationError::graph_invalid)?;
        let skeleton = set.skeleton();
        let rest = skeleton.rest_pose();
        let references = graph
            .layer_infos()
            .iter()
            .map(|layer| match layer.blend {
                LayerBlend::Additive(reference) => {
                    let mut pose = rest.to_vec();
                    sample(&set.clips()[reference.raw() as usize], 0.0, Wrap::Clamp, &mut SampleCursor::new(), &mut pose);
                    Some(pose)
                }
                LayerBlend::Override => None,
            })
            .collect();
        let layers = graph.layer_infos().len();
        let rig = IkRig::of(skeleton, set.humanoid());
        let mut animator = Animator {
            machine: Machine::new(graph),
            players: vec![TransitionPlayer::new(rest); layers],
            references,
            rig,
            targets: Targets::default(),
            filter: EventFilter::default(),
            evaluation: Evaluation::new(skeleton.joint_count()),
            before: Vec::with_capacity(layers),
            played: Vec::new(),
            fired: Vec::new(),
            set,
        };
        animator.show(Switched::default(), 0.0);
        Ok(animator)
    }

    /// The character's data.
    pub fn set(&self) -> &Arc<AnimSet> {
        &self.set
    }

    /// The graph.
    pub fn graph(&self) -> &AnimGraph {
        self.machine.graph()
    }

    /// The machine: states, clip times, transitions and parameters.
    pub fn machine(&self) -> &Machine {
        &self.machine
    }

    /// Set a float parameter.
    pub fn set_float(&mut self, param: FloatParam, value: f32) {
        self.machine.set_float(param, value);
    }

    /// Set a vec2 parameter.
    pub fn set_vec2(&mut self, param: Vec2Param, value: Vec2) {
        self.machine.set_vec2(param, value);
    }

    /// Set a bool parameter.
    pub fn set_bool(&mut self, param: BoolParam, value: bool) {
        self.machine.set_bool(param, value);
    }

    /// Fire a trigger for the next update.
    pub fn fire(&mut self, trigger: TriggerParam) {
        self.machine.fire(trigger);
    }

    /// Put `state`'s layer in it now, with no blend (shown at the next update).
    pub fn jump_to(&mut self, state: StateId) {
        self.machine.jump_to(state);
    }

    /// Set a layer's weight, clamped to `[0, 1]`.
    pub fn set_layer_weight(&mut self, layer: LayerId, weight: f32) {
        self.machine.set_layer_weight(layer, weight);
    }

    /// Which playing clips' events fire (by default those at weight 0.1 or more).
    pub fn set_event_filter(&mut self, filter: EventFilter) {
        self.filter = filter;
    }

    /// Aim `limb` at `target` from the next update on (`None` lets it go). A limb the skeleton's
    /// humanoid map lacks is never solved.
    pub fn reach(&mut self, limb: Limb, target: Option<LimbTarget>) {
        self.targets.limbs[limb.index()] = target;
    }

    /// Look at `target` from the next update on (`None` stops looking).
    pub fn look_at(&mut self, target: Option<LookTarget>) {
        self.targets.look = target;
    }

    /// A layer's current state.
    pub fn state(&self, layer: LayerId) -> StateId {
        self.machine.state(layer)
    }

    /// The name of a layer's current state.
    pub fn state_name(&self, layer: LayerId) -> &str {
        self.machine.state_name(layer)
    }

    /// A layer's clip time over its length, in `[0, 1]`.
    pub fn normalized_time(&self, layer: LayerId) -> f32 {
        self.machine.normalized_time(layer)
    }

    /// Whether a layer is blending into its state.
    pub fn in_transition(&self, layer: LayerId) -> bool {
        self.machine.in_transition(layer)
    }

    /// Advance by `dt` seconds (pass `ctx.dt`); see the module docs. A `dt` that is negative or
    /// not finite counts as 0.
    pub fn update(&mut self, dt: f32) -> AnimatorStep {
        let dt = if dt.is_finite() && dt > 0.0 { dt } else { 0.0 };
        self.before.clear();
        for layer in self.machine.graph().layers() {
            self.before.push(Before { state: self.machine.state(layer), time: self.machine.clip_time(layer), transition: self.machine.transition(layer) });
        }
        let speeds: Vec<(f32, Option<f32>)> = self.before.iter().map(|before| (clip_speed(&self.machine, before.state), before.transition.map(|running| clip_speed(&self.machine, running.from)))).collect();
        let switched = self.machine.step(dt);
        let mut step = AnimatorStep::default();
        for (index, speeds) in speeds.into_iter().enumerate() {
            let layer = LayerId(index as u32);
            self.played_by(index, dt, speeds, switched.contains(layer));
            let motion = blend(&self.played.iter().map(|played| (self.clip_motion(played), played.weight)).collect::<Vec<_>>());
            self.blend_root_motion(&mut step.root_motion, index, motion);
            self.events_of(layer, &mut step.events);
        }
        self.show(switched, dt);
        step
    }

    /// Fill `played` with the clips layer `index` played over this update, at their weights in
    /// the layer.
    fn played_by(&mut self, index: usize, dt: f32, speeds: (f32, Option<f32>), switched: bool) {
        self.played.clear();
        let before = self.before[index];
        let graph = self.machine.graph();
        let layer = LayerId(index as u32);
        let after = self.machine.transition(layer);
        let progress = after.map_or(1.0, |running| running.progress());
        let crossfading = !switched && after.is_some_and(|running| matches!(running.blend, TransitionBlend::Crossfade(_)));
        let current = if crossfading { progress } else { 1.0 };
        if let Some(played) = played_clip(graph, before.state, before.time, dt * speeds.0, current) {
            self.played.push(played);
        }
        let source = before.transition.zip(speeds.1).filter(|_| crossfading);
        if let Some((running, speed)) = source
            && let Some(played) = played_clip(graph, running.from, running.from_time, dt * speed, 1.0 - progress)
        {
            self.played.push(played);
        }
    }

    fn clip_motion(&self, played: &Played) -> RootMotion {
        self.set.motion(played.clip).map_or(RootMotion::ZERO, |motion| motion.delta(&played.span))
    }

    /// Fold layer `index`'s root motion into `total`: the first layer's is the base; a later
    /// override layer blends its own over it by its weight at the motion root.
    fn blend_root_motion(&self, total: &mut RootMotion, index: usize, motion: RootMotion) {
        if index == 0 {
            *total = motion;
            return;
        }
        let Some(info) = self.machine.graph().layer_infos().get(index) else { return };
        let present: f32 = self.played.iter().map(|played| played.weight).sum();
        let share = self.machine.layer_weight(LayerId(index as u32)) * info.mask.weight(self.set.motion_root()) * present.min(1.0);
        if matches!(info.blend, LayerBlend::Override) && share > 0.0 {
            *total = blend(&[(*total, 1.0 - share.min(1.0)), (motion, share.min(1.0))]);
        }
    }

    fn events_of(&mut self, layer: LayerId, out: &mut Vec<AnimEvent>) {
        let weight = self.machine.layer_weight(layer);
        for played in &mut self.played {
            played.weight *= weight;
        }
        self.fired.clear();
        collect(self.machine.graph().events(), &self.played, self.filter, &mut self.fired);
        out.extend(self.fired.iter().map(|fired| AnimEvent { event: fired.event, layer, clip: fired.clip, weight: fired.weight }));
    }

    /// Advance every layer's player after a step, then evaluate the pose.
    fn show(&mut self, switched: Switched, dt: f32) {
        let Animator { set, machine, players, evaluation, .. } = self;
        evaluation.fit(set.skeleton().joint_count(), set.clips().len());
        for (index, player) in players.iter_mut().enumerate() {
            let cursors = evaluation.cursors();
            player.update(machine, LayerId(index as u32), switched, dt, |state, time, pose| sample_state(set, machine.graph(), state, time, cursors, pose));
        }
        let mut out = std::mem::replace(&mut self.evaluation, Evaluation::new(0));
        self.evaluate_into(&mut out);
        self.evaluation = out;
    }

    /// The pipeline over this animator's state into `out` (the presenter's path).
    pub(crate) fn evaluate_into(&self, out: &mut Evaluation) {
        let inputs = Inputs { set: &self.set, machine: &self.machine, players: &self.players, references: &self.references, rig: &self.rig, targets: &self.targets };
        compose(&inputs, out);
    }

    /// The evaluated local pose, one transform per joint, parents first.
    pub fn pose(&self) -> &[Trs] {
        self.evaluation.local()
    }

    /// The evaluated model-space pose, one matrix per joint.
    pub fn model_pose(&self) -> &[Mat4] {
        self.evaluation.model()
    }

    /// The skinning palette of the evaluated pose into `palette`, in skin order.
    pub fn palette(&self, palette: &mut [[f32; 16]]) {
        self.set.skeleton().palette(self.evaluation.model(), palette);
    }

    /// A joint's world transform for a character placed at `model`: `model` times the evaluated
    /// model-space joint (`model` itself for a joint the skeleton lacks).
    pub fn socket(&self, joint: JointId, model: Mat4) -> Mat4 {
        self.evaluation.model().get(usize::from(joint.raw())).map_or(model, |joint| model * *joint)
    }

    /// For a probe: the machine's layers and parameters.
    pub fn probe(&self) -> Value {
        self.machine.probe()
    }

    /// FNV-1a 64 over the evaluated local pose's bits (conformance and cross-target rows).
    pub fn pose_digest(&self) -> u64 {
        pose_digest(self.evaluation.local())
    }

    /// FNV-1a 64 over the whole state: the machine, every player and the IK targets.
    pub fn digest(&self) -> u64 {
        let mut hash = fnv1a64_from(&self.machine.digest().to_le_bytes(), FNV_OFFSET_BASIS);
        for player in &self.players {
            hash = fnv1a64_from(&player.digest().to_le_bytes(), hash);
        }
        floats_digest(&targets_numbers(&self.targets), hash)
    }

    /// FNV-1a 64 over what a snapshot must agree with: the joint and clip counts and the graph's
    /// layer, state and parameter names (with each state's layer and each parameter's kind) and
    /// its transitions' ends.
    fn shape(&self) -> u64 {
        let graph = self.machine.graph();
        let mut hash = fnv1a64_from(&(self.set.skeleton().joint_count() as u64).to_le_bytes(), FNV_OFFSET_BASIS);
        hash = fnv1a64_from(&(self.set.clips().len() as u64).to_le_bytes(), hash);
        for layer in graph.layers() {
            hash = fnv1a64_from(graph.layer_name(layer).as_bytes(), fnv1a64_from(&[0xff], hash));
        }
        let mut index = 0;
        while let Some(state) = graph.state_info(StateId(index)) {
            hash = fnv1a64_from(state.name.as_bytes(), fnv1a64_from(&state.layer.raw().to_le_bytes(), hash));
            index += 1;
        }
        for (name, value) in graph.param_names().zip(self.machine.params.values()) {
            hash = fnv1a64_from(name.as_bytes(), fnv1a64_from(&[value.kind() as u8], hash));
        }
        for transition in graph.transitions() {
            let from = transition.from.map_or(u32::MAX, StateId::raw);
            hash = fnv1a64_from(&[from.to_le_bytes(), transition.to.raw().to_le_bytes()].concat(), hash);
        }
        hash
    }

    /// Poses the players have sampled since the animator was made.
    pub fn evaluations(&self) -> u64 {
        self.players.iter().map(TransitionPlayer::evaluations).sum()
    }

    /// The whole state as a value: parameters, layers, players, IK targets and the event filter,
    /// every float as its bits. [`Animator::restore`] on an animator of the same set and graph
    /// continues exactly where this one is.
    pub fn snapshot(&self) -> Value {
        let mut out = Value::object();
        out.set("version", Value::from(SNAPSHOT_VERSION));
        out.set("shape", Value::from(hex64(self.shape())));
        out.set("params", Value::Array(self.machine.params.values().iter().map(param_value).collect()));
        out.set("layers", Value::Array(self.machine.layers.iter().map(layer_value).collect()));
        out.set("players", Value::Array(self.players.iter().map(player_value).collect()));
        out.set("targets", bits_value(&targets_numbers(&self.targets)));
        out.set("filter", filter_value(self.filter));
        out
    }

    /// Restore a [`Animator::snapshot`]. Refused `animation-asset-invalid`, with the animator
    /// unchanged: not a snapshot of this version, a field missing or of the wrong kind, a count
    /// that does not match the graph or the skeleton, a state or transition the graph lacks, or a
    /// float that is not finite.
    pub fn restore(&mut self, snapshot: &Value) -> Result<(), AnimationError> {
        let restored = self.restored(snapshot).map_err(|problem| AnimationError::asset_invalid(format!("animator snapshot: {problem}")))?;
        *self = restored;
        Ok(())
    }

    fn restored(&self, snapshot: &Value) -> Result<Animator, String> {
        if !matches!(snapshot, Value::Object(_)) {
            return Err("not an object".to_owned());
        }
        let version = read_u32(snapshot.get("version"), "version")?;
        if version != SNAPSHOT_VERSION {
            return Err(format!("version {version}, this build reads {SNAPSHOT_VERSION}"));
        }
        if snapshot.get("shape").map(Value::as_str) != Some(hex64(self.shape()).as_str()) {
            return Err("taken from an animator of another graph or skeleton".to_owned());
        }
        let mut next = self.clone();
        next.machine.params = read_params(&self.machine, snapshot.get("params"))?;
        next.machine.layers = read_layers(&self.machine, snapshot.get("layers"))?;
        let players = read_array(snapshot.get("players"), "players", self.players.len())?;
        for (index, (player, value)) in next.players.iter_mut().zip(players).enumerate() {
            read_player(&self.machine, LayerId(index as u32), self.set.skeleton().joint_count(), value, player).map_err(|problem| format!("player {index}: {problem}"))?;
        }
        next.targets = read_targets(snapshot.get("targets"))?;
        next.filter = read_filter(snapshot.get("filter"))?;
        let mut out = std::mem::replace(&mut next.evaluation, Evaluation::new(0));
        next.evaluate_into(&mut out);
        next.evaluation = out;
        Ok(next)
    }
}

/// What `graph` must agree with in `set`; see [`Animator::new`].
fn check_graph(set: &AnimSet, graph: &AnimGraph) -> Result<(), String> {
    let joints = set.skeleton().joint_count();
    let clip = |id: ClipId| set.clips().get(id.raw() as usize).ok_or_else(|| format!("clip {} is not one of the set's {} clips", id.raw(), set.clips().len()));
    for layer in graph.layer_infos() {
        if layer.mask.weights().len() != joints {
            return Err(format!("layer {:?}'s mask covers {} joints, the skeleton has {joints}", layer.name, layer.mask.weights().len()));
        }
        if let LayerBlend::Additive(reference) = layer.blend {
            clip(reference)?;
        }
    }
    let mut index = 0;
    while let Some(state) = graph.state_info(StateId(index)) {
        if let Motion::Clip(motion) = &state.motion {
            let found = clip(motion.clip_id())?;
            if found.duration().to_bits() != state.length.to_bits() {
                return Err(format!("state {:?} plays a {} s clip, the set's lasts {} s", state.name, state.length, found.duration()));
            }
        }
        index += 1;
    }
    Ok(())
}

/// A state's clip speed this tick, as the machine computes it.
fn clip_speed(machine: &Machine, state: StateId) -> f32 {
    let Some(Motion::Clip(motion)) = machine.graph().state_motion(state) else { return 0.0 };
    let speed = motion.fixed_speed() * motion.speed_param().map_or(1.0, |param| machine.params().float(param));
    if speed.is_finite() { speed } else { 0.0 }
}

/// The clip `state` played from `time` over `delta` seconds of clip time, at `weight`.
fn played_clip(graph: &AnimGraph, state: StateId, time: f32, delta: f32, weight: f32) -> Option<Played> {
    let Some(Motion::Clip(motion)) = graph.state_motion(state) else { return None };
    let length = graph.state_length(state);
    Some(Played { clip: motion.clip_id(), span: Span::advance(time, delta, length, motion.looping()), weight })
}

// Snapshot encoding: every float is its bits as an integer, so a value written as JSON text and
// read back restores exactly.

fn bits_value(numbers: &[f32]) -> Value {
    Value::Array(numbers.iter().map(|number| Value::from(number.to_bits())).collect())
}

fn trs_numbers(pose: &[Trs]) -> Vec<f32> {
    pose.iter().flat_map(|trs| trs.translation.to_array().into_iter().chain(trs.rotation.to_array()).chain(trs.scale.to_array())).collect()
}

fn velocity_numbers(velocity: &[JointVelocity]) -> Vec<f32> {
    velocity.iter().flat_map(|v| v.translation.to_array().into_iter().chain(v.angular.to_array()).chain(v.scale.to_array())).collect()
}

fn offset_numbers(joints: &[JointOffset]) -> Vec<f32> {
    joints.iter().flat_map(|joint| joint_offset_parts(joint).into_iter().flat_map(|part| part.to_array())).collect()
}

fn joint_offset_parts(joint: &JointOffset) -> [Vec3; 6] {
    [joint.translation, joint.translation_velocity, joint.rotation, joint.angular_velocity, joint.scale, joint.scale_velocity]
}

/// The targets as numbers: per limb a presence flag, target, pole and weight; then the look.
fn targets_numbers(targets: &Targets) -> Vec<f32> {
    let mut numbers = Vec::with_capacity(4 * 8 + 5);
    for limb in &targets.limbs {
        match limb {
            Some(limb) => numbers.extend([1.0, limb.target.x, limb.target.y, limb.target.z, limb.pole.x, limb.pole.y, limb.pole.z, limb.weight]),
            None => numbers.extend([0.0; 8]),
        }
    }
    match targets.look {
        Some(look) => numbers.extend([1.0, look.target.x, look.target.y, look.target.z, look.weight]),
        None => numbers.extend([0.0; 5]),
    }
    numbers
}

fn param_value(value: &ParamValue) -> Value {
    let (kind, numbers): (u32, Vec<u32>) = match *value {
        ParamValue::Float(number) => (0, vec![number.to_bits()]),
        ParamValue::Vec2(vector) => (1, vec![vector.x.to_bits(), vector.y.to_bits()]),
        ParamValue::Bool(flag) => (2, vec![u32::from(flag)]),
        ParamValue::Trigger(flag) => (3, vec![u32::from(flag)]),
    };
    Value::Array(std::iter::once(kind).chain(numbers).map(Value::from).collect())
}

fn layer_value(layer: &LayerState) -> Value {
    let mut out = Value::object();
    out.set("state", Value::from(layer.state.raw()));
    out.set("numbers", bits_value(&[layer.seconds, layer.time, layer.weight]));
    out.set("ended", Value::from(layer.ended));
    out.set("cycleEnd", Value::from(layer.cycle_end));
    let transition = layer.transition.map_or(Value::Null, |running| {
        let mut entry = Value::object();
        entry.set("index", Value::from(running.transition));
        entry.set("from", Value::from(running.from.raw()));
        entry.set("numbers", bits_value(&[running.from_time, running.elapsed]));
        entry
    });
    out.set("transition", transition);
    out
}

fn player_value(player: &TransitionPlayer) -> Value {
    let mut out = Value::object();
    out.set("pose", bits_value(&trs_numbers(&player.pose)));
    out.set("velocity", bits_value(&velocity_numbers(&player.velocity)));
    out.set("shown", Value::from(player.shown));
    out.set("state", player.state.map_or(Value::Null, |state| Value::from(state.raw())));
    out.set("crossfading", Value::from(player.crossfading));
    let offset = if player.offset.active {
        let mut entry = Value::object();
        entry.set("halflife", Value::from(player.offset.halflife.to_bits()));
        entry.set("joints", bits_value(&offset_numbers(&player.offset.joints)));
        entry
    } else {
        Value::Null
    };
    out.set("offset", offset);
    let frozen = player.frozen.as_ref().map_or(Value::Null, |frozen| {
        let mut entry = Value::object();
        entry.set("pose", bits_value(&trs_numbers(&frozen.pose)));
        entry.set("velocity", bits_value(&velocity_numbers(&frozen.velocity)));
        entry
    });
    out.set("frozen", frozen);
    out
}

fn filter_value(filter: EventFilter) -> Value {
    let (kind, bits) = match filter {
        EventFilter::AtLeast(threshold) => (0_u32, threshold.to_bits()),
        EventFilter::Heaviest => (1, 0),
        EventFilter::All => (2, 0),
    };
    Value::Array(vec![Value::from(kind), Value::from(bits)])
}

fn read_u32(value: Option<&Value>, what: &str) -> Result<u32, String> {
    match value {
        Some(Value::Number(number)) if number.fract() == 0.0 && *number >= 0.0 && *number <= f64::from(u32::MAX) => Ok(*number as u32),
        _ => Err(format!("{what} is not a whole number")),
    }
}

fn read_bool(value: Option<&Value>, what: &str) -> Result<bool, String> {
    match value {
        Some(Value::Bool(flag)) => Ok(*flag),
        _ => Err(format!("{what} is not true or false")),
    }
}

fn read_array<'a>(value: Option<&'a Value>, what: &str, count: usize) -> Result<&'a [Value], String> {
    match value {
        Some(Value::Array(items)) if items.len() == count => Ok(items),
        Some(Value::Array(items)) => Err(format!("{what} has {} entries, not {count}", items.len())),
        _ => Err(format!("{what} is missing")),
    }
}

/// `count` finite floats written as bits.
fn read_bits(value: Option<&Value>, what: &str, count: usize) -> Result<Vec<f32>, String> {
    let items = read_array(value, what, count)?;
    items
        .iter()
        .map(|item| {
            let number = f32::from_bits(read_u32(Some(item), what)?);
            if number.is_finite() { Ok(number) } else { Err(format!("{what} holds a number that is not finite")) }
        })
        .collect()
}

fn read_state(machine: &Machine, layer: LayerId, value: Option<&Value>, what: &str) -> Result<StateId, String> {
    let state = StateId(read_u32(value, what)?);
    if machine.graph().state_layer(state) != Some(layer) {
        return Err(format!("{what} {} is not a state of layer {}", state.raw(), layer.raw()));
    }
    Ok(state)
}

fn read_params(machine: &Machine, value: Option<&Value>) -> Result<Params, String> {
    let current = machine.params.values();
    let items = read_array(value, "params", current.len())?;
    let mut values = Vec::with_capacity(items.len());
    for (index, (item, known)) in items.iter().zip(current).enumerate() {
        let what = format!("parameter {index}");
        let Value::Array(parts) = item else { return Err(format!("{what} is not a list")) };
        let kind = read_u32(parts.first(), &what)?;
        let number = |at: usize| -> Result<f32, String> {
            let bits = f32::from_bits(read_u32(parts.get(at), &what)?);
            if bits.is_finite() { Ok(bits) } else { Err(format!("{what} is not finite")) }
        };
        let flag = || -> Result<bool, String> {
            match read_u32(parts.get(1), &what)? {
                0 => Ok(false),
                1 => Ok(true),
                _ => Err(format!("{what} is not 0 or 1")),
            }
        };
        let value = match (kind, parts.len()) {
            (0, 2) => ParamValue::Float(number(1)?),
            (1, 3) => ParamValue::Vec2(Vec2::new(number(1)?, number(2)?)),
            (2, 2) => ParamValue::Bool(flag()?),
            (3, 2) => ParamValue::Trigger(flag()?),
            _ => return Err(format!("{what} has an unknown shape")),
        };
        if value.kind() != known.kind() {
            return Err(format!("{what} is a {:?}, the graph's is a {:?}", value.kind(), known.kind()));
        }
        values.push(value);
    }
    Ok(Params::new(values))
}

fn read_layers(machine: &Machine, value: Option<&Value>) -> Result<Vec<LayerState>, String> {
    let items = read_array(value, "layers", machine.layers.len())?;
    let mut layers = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let layer = LayerId(index as u32);
        let what = format!("layer {index}");
        let state = read_state(machine, layer, item.get("state"), &what)?;
        let [seconds, time, weight] = <[f32; 3]>::try_from(read_bits(item.get("numbers"), &what, 3)?).map_err(|_| format!("{what} numbers"))?;
        let transition = match item.get("transition") {
            Some(Value::Null) => None,
            Some(entry) => Some(read_transition(machine, layer, state, entry).map_err(|problem| format!("{what}: {problem}"))?),
            None => return Err(format!("{what} has no transition entry")),
        };
        let ended = read_bool(item.get("ended"), &what)?;
        let cycle_end = read_bool(item.get("cycleEnd"), &what)?;
        layers.push(LayerState { state, seconds, time, ended, cycle_end, weight, transition });
    }
    Ok(layers)
}

fn read_transition(machine: &Machine, layer: LayerId, state: StateId, entry: &Value) -> Result<ActiveTransition, String> {
    let index = read_u32(entry.get("index"), "transition")?;
    let def = machine.graph().transition_def(index).ok_or_else(|| format!("transition {index} is not in the graph"))?;
    if def.to != state {
        return Err(format!("transition {index} does not enter state {}", state.raw()));
    }
    let from = read_state(machine, layer, entry.get("from"), "transition source")?;
    let [from_time, elapsed] = <[f32; 2]>::try_from(read_bits(entry.get("numbers"), "transition", 2)?).map_err(|_| "transition numbers".to_owned())?;
    Ok(ActiveTransition { transition: index, from, from_time, elapsed, blend: def.blend })
}

fn trs_from(numbers: &[f32]) -> Vec<Trs> {
    numbers
        .as_chunks::<10>()
        .0
        .iter()
        .map(|n| Trs { translation: Vec3::new(n[0], n[1], n[2]), rotation: glam::Quat::from_xyzw(n[3], n[4], n[5], n[6]), scale: Vec3::new(n[7], n[8], n[9]) })
        .collect()
}

fn velocity_from(numbers: &[f32]) -> Vec<JointVelocity> {
    numbers
        .as_chunks::<9>()
        .0
        .iter()
        .map(|n| JointVelocity { translation: Vec3::new(n[0], n[1], n[2]), angular: Vec3::new(n[3], n[4], n[5]), scale: Vec3::new(n[6], n[7], n[8]) })
        .collect()
}

fn read_player(machine: &Machine, layer: LayerId, joints: usize, value: &Value, player: &mut TransitionPlayer) -> Result<(), String> {
    player.pose = trs_from(&read_bits(value.get("pose"), "pose", joints * 10)?);
    player.velocity = velocity_from(&read_bits(value.get("velocity"), "velocity", joints * 9)?);
    player.shown = read_bool(value.get("shown"), "shown")?;
    player.crossfading = read_bool(value.get("crossfading"), "crossfading")?;
    player.state = match value.get("state") {
        Some(Value::Null) => None,
        state => Some(read_state(machine, layer, state, "state")?),
    };
    player.offset = match value.get("offset") {
        Some(Value::Null) => InertialOffset::new(),
        Some(entry) => {
            let halflife = f32::from_bits(read_u32(entry.get("halflife"), "halflife")?);
            if !(halflife.is_finite() && halflife > 0.0) {
                return Err("the offset's half-life is not a positive number".to_owned());
            }
            let numbers = read_bits(entry.get("joints"), "offset", joints * 18)?;
            let parts = numbers.as_chunks::<3>().0.iter().map(|n| Vec3::from_array(*n)).collect::<Vec<_>>();
            let joints = parts
                .as_chunks::<6>()
                .0
                .iter()
                .map(|p| JointOffset { translation: p[0], translation_velocity: p[1], rotation: p[2], angular_velocity: p[3], scale: p[4], scale_velocity: p[5] })
                .collect();
            InertialOffset { joints, halflife, active: true }
        }
        None => return Err("no offset entry".to_owned()),
    };
    player.frozen = match value.get("frozen") {
        Some(Value::Null) => None,
        Some(entry) => Some(Frozen { pose: trs_from(&read_bits(entry.get("pose"), "frozen pose", joints * 10)?), velocity: velocity_from(&read_bits(entry.get("velocity"), "frozen velocity", joints * 9)?) }),
        None => return Err("no frozen entry".to_owned()),
    };
    Ok(())
}

fn read_targets(value: Option<&Value>) -> Result<Targets, String> {
    let numbers = read_bits(value, "targets", 4 * 8 + 5)?;
    let mut targets = Targets::default();
    for (slot, n) in targets.limbs.iter_mut().zip(numbers.as_chunks::<8>().0) {
        *slot = (n[0] != 0.0).then(|| LimbTarget { target: Vec3::new(n[1], n[2], n[3]), pole: Vec3::new(n[4], n[5], n[6]), weight: n[7] });
    }
    let look = &numbers[32..];
    targets.look = (look[0] != 0.0).then(|| LookTarget { target: Vec3::new(look[1], look[2], look[3]), weight: look[4] });
    Ok(targets)
}

fn read_filter(value: Option<&Value>) -> Result<EventFilter, String> {
    let items = read_array(value, "filter", 2)?;
    let bits = read_u32(items.get(1), "filter")?;
    match read_u32(items.first(), "filter")? {
        0 => {
            let threshold = f32::from_bits(bits);
            if threshold.is_finite() { Ok(EventFilter::AtLeast(threshold)) } else { Err("the filter's threshold is not finite".to_owned()) }
        }
        1 => Ok(EventFilter::Heaviest),
        2 => Ok(EventFilter::All),
        _ => Err("the filter is of an unknown kind".to_owned()),
    }
}
