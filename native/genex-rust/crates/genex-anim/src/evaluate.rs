//! The evaluation pipeline: an animator's state in, a local and model-space pose out.
//!
//! The order is ozz-animation's job chain (MIT) with Godot's modifier order for the IK
//! post-process (MIT), the rules only:
//!
//! 1. sample, 2. blend each layer, 3. apply the inertial offset: each layer's
//!    [`TransitionPlayer`] has done these when the animator updated, and holds the pose it shows;
//! 4. stack the layers in declaration order: an override layer moves the joints of its mask toward
//!    its pose by its weight, an additive layer adds its pose's difference from its reference
//!    clip's first frame. A layer in an empty state adds nothing; while it blends into or out of
//!    one, the other state plays alone at the blend's share of the weight;
//! 5. local to model;
//! 6. foot IK, 7. arm IK (two-bone chains from the humanoid map), 8. the look-at (spine, neck,
//!    head), each over the model matrices the one before left;
//! 9. the ragdoll override (AN-20, physics feature; not wired yet);
//! 10. the palette, on request ([`crate::animator::Animator::palette`]).
//!
//! The function is pure: the same animator state gives the same bits, so the simulation's
//! `socket()` and the presenter's draw agree, and no step reads a clock or a thread.

use glam::{Mat4, Vec3};

use crate::animator::{AnimSet, IkRig, Targets};
use crate::blend::{Layer, additive_delta, apply_additive, apply_override};
use crate::blendspace::MAX_BLEND_POINTS;
use crate::graph::{AnimGraph, BuiltBlend, LayerBlend, Motion};
use crate::ids::{LayerId, StateId};
use crate::ik::{DEFAULT_SOFTEN, LookAt, TwoBoneIk, apply_look_at, apply_two_bone};
use crate::inertial::{floats_digest, vec3_digest};
use crate::machine::Machine;
use crate::math::Trs;
use crate::sample::{SampleCursor, Wrap, sample};
use crate::transition::TransitionPlayer;

/// An evaluated pose and the scratch the pipeline reuses, so an evaluation allocates nothing once
/// it is warm.
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    local: Vec<Trs>,
    model: Vec<Mat4>,
    layer: Vec<Trs>,
    delta: Vec<Trs>,
    cursors: Vec<SampleCursor>,
}

impl Evaluation {
    /// An evaluation for a skeleton of `joints` joints, at identity until the first evaluation.
    pub fn new(joints: usize) -> Evaluation {
        Evaluation { local: vec![Trs::IDENTITY; joints], model: vec![Mat4::IDENTITY; joints], layer: vec![Trs::IDENTITY; joints], delta: vec![Trs::IDENTITY; joints], cursors: Vec::new() }
    }

    /// The local pose, one transform per joint, parents first.
    pub fn local(&self) -> &[Trs] {
        &self.local
    }

    /// The model-space pose, one matrix per joint.
    pub fn model(&self) -> &[Mat4] {
        &self.model
    }

    /// Sized to `joints` joints and `clips` sampling cursors.
    pub(crate) fn fit(&mut self, joints: usize, clips: usize) {
        for buffer in [&mut self.local, &mut self.layer, &mut self.delta] {
            buffer.resize(joints, Trs::IDENTITY);
        }
        self.model.resize(joints, Mat4::IDENTITY);
        self.cursors.resize_with(clips, SampleCursor::new);
    }

    /// The sampling cursors, one per clip (hints only: every sample equals a fresh cursor's).
    pub(crate) fn cursors(&mut self) -> &mut [SampleCursor] {
        &mut self.cursors
    }
}

/// Evaluate `animator`'s current state into `out`: the presenter's path. It equals the pose the
/// animator itself holds after its last update, bit for bit.
pub fn evaluate(animator: &crate::animator::Animator, out: &mut Evaluation) {
    animator.evaluate_into(out);
}

/// FNV-1a 64 over a pose's bits: per joint the translation, the rotation (xyzw) and the scale.
pub fn pose_digest(pose: &[Trs]) -> u64 {
    pose.iter().fold(genex_core::digest::FNV_OFFSET_BASIS, |hash, trs| {
        let hash = vec3_digest(trs.translation, hash);
        let hash = floats_digest(&trs.rotation.to_array(), hash);
        vec3_digest(trs.scale, hash)
    })
}

/// What the pipeline reads: the animator's state, borrowed.
pub(crate) struct Inputs<'a> {
    pub(crate) set: &'a AnimSet,
    pub(crate) machine: &'a Machine,
    pub(crate) players: &'a [TransitionPlayer],
    /// Per layer: an additive layer's reference pose (its clip's first frame over the rest pose).
    pub(crate) references: &'a [Option<Vec<Trs>>],
    pub(crate) rig: &'a IkRig,
    pub(crate) targets: &'a Targets,
}

/// `state`'s pose at its `time` written over `pose` (which the caller starts at the rest pose):
/// a clip state samples its clip (looping or clamped), a blend samples each clip with weight at
/// the shared phase and mixes them by the weights `machine`'s parameters give, an empty state
/// writes nothing.
pub(crate) fn sample_state(set: &AnimSet, machine: &Machine, state: StateId, time: f32, cursors: &mut [SampleCursor], pose: &mut [Trs]) {
    let graph = machine.graph();
    match graph.state_motion(state) {
        Some(Motion::Clip(motion)) => {
            let index = motion.clip_id().raw() as usize;
            let (Some(clip), Some(cursor)) = (set.clips().get(index), cursors.get_mut(index)) else { return };
            let wrap = if motion.looping() { Wrap::Loop } else { Wrap::Clamp };
            sample(clip, time, wrap, cursor, pose);
        }
        Some(Motion::Blend(_)) => {
            if let Some(blend) = graph.state_blend(state) {
                sample_blend(set, blend, machine, time, cursors, pose);
            }
        }
        _ => {}
    }
}

/// A blend's clips at phase `time`, mixed into `pose` one after another: each clip moves the pose
/// toward its own by its weight over the weight so far, which is the weighted mean.
fn sample_blend(set: &AnimSet, blend: &BuiltBlend, machine: &Machine, time: f32, cursors: &mut [SampleCursor], pose: &mut [Trs]) {
    let mut weights = [0.0; MAX_BLEND_POINTS];
    let weights = blend.weights(machine.params(), &mut weights);
    let rest = set.skeleton().rest_pose();
    // One scratch pose per blended sample; a clip state allocates nothing.
    let mut scratch: Vec<Trs> = Vec::new();
    let mut total = 0.0;
    for ((id, length), weight) in blend.clips().zip(weights) {
        let index = id.raw() as usize;
        let (Some(clip), Some(cursor)) = (set.clips().get(index), cursors.get_mut(index)) else { continue };
        if *weight <= 0.0 {
            continue;
        }
        total += weight;
        if total == *weight {
            sample(clip, time * length, Wrap::Loop, cursor, pose);
            continue;
        }
        scratch.clear();
        scratch.extend_from_slice(rest);
        sample(clip, time * length, Wrap::Loop, cursor, &mut scratch);
        apply_override(pose, &Layer::new(&scratch, weight / total));
    }
}

/// How much of a layer above the first shows.
enum Presence {
    /// Its player's pose, at the layer's weight.
    Full,
    /// Nothing (an empty state, or a blend between two).
    Absent,
    /// One state alone at this share of the layer's weight: the other side of the blend is empty.
    Partial { share: f32, state: StateId, time: f32 },
}

fn is_empty(graph: &AnimGraph, state: StateId) -> bool {
    matches!(graph.state_motion(state), Some(Motion::Empty) | None)
}

fn presence(machine: &Machine, layer: LayerId) -> Presence {
    let graph = machine.graph();
    let current = machine.state(layer);
    let Some(running) = machine.transition(layer) else {
        return if is_empty(graph, current) { Presence::Absent } else { Presence::Full };
    };
    match (is_empty(graph, running.from), is_empty(graph, current)) {
        (true, true) => Presence::Absent,
        (false, false) => Presence::Full,
        (true, false) => Presence::Partial { share: running.progress(), state: current, time: machine.clip_time(layer) },
        (false, true) => Presence::Partial { share: 1.0 - running.progress(), state: running.from, time: running.from_time },
    }
}

/// Steps 4 to 8 of the pipeline into `out`; see the module docs.
pub(crate) fn compose(inputs: &Inputs<'_>, out: &mut Evaluation) {
    let skeleton = inputs.set.skeleton();
    out.fit(skeleton.joint_count(), inputs.set.clips().len());
    let Some(base) = inputs.players.first() else { return };
    out.local.copy_from_slice(base.pose());
    stack_layers(inputs, out);
    skeleton.local_to_model(&out.local, &mut out.model);
    if solve_ik(inputs, out) {
        // The solvers refresh the model matrices down to each chain's end; the joints past it
        // (toes, fingers) and the arms under a turned spine catch up here.
        skeleton.local_to_model(&out.local, &mut out.model);
    }
}

fn stack_layers(inputs: &Inputs<'_>, out: &mut Evaluation) {
    let machine = inputs.machine;
    let graph = machine.graph();
    let rest = inputs.set.skeleton().rest_pose();
    let Evaluation { local, layer: scratch, delta, cursors, .. } = out;
    for (index, (info, player)) in graph.layer_infos().iter().zip(inputs.players).enumerate().skip(1) {
        let layer = LayerId(index as u32);
        let (pose, share): (&[Trs], f32) = match presence(machine, layer) {
            Presence::Absent => continue,
            Presence::Full => (player.pose(), 1.0),
            Presence::Partial { share, state, time } => {
                scratch.copy_from_slice(rest);
                sample_state(inputs.set, machine, state, time, cursors, scratch);
                (scratch.as_slice(), share)
            }
        };
        let weight = machine.layer_weight(layer) * share;
        if weight <= 0.0 {
            continue;
        }
        match (info.blend, inputs.references.get(index).and_then(Option::as_ref)) {
            (LayerBlend::Override, _) => apply_override(local, &Layer::new(pose, weight).masked(&info.mask)),
            (LayerBlend::Additive(_), Some(reference)) => {
                additive_delta(pose, reference, delta);
                apply_additive(local, &Layer::new(delta, weight).masked(&info.mask));
            }
            (LayerBlend::Additive(_), None) => {}
        }
    }
}

/// Legs, then arms, then the look-at; true when any target was set (whatever its weight).
fn solve_ik(inputs: &Inputs<'_>, out: &mut Evaluation) -> bool {
    let skeleton = inputs.set.skeleton();
    let mut solved = false;
    for (chain, target) in inputs.rig.limbs.iter().zip(&inputs.targets.limbs) {
        let (Some(chain), Some(target)) = (chain, target) else { continue };
        let ik = TwoBoneIk { target: target.target, pole: target.pole, weight: target.weight, soften: DEFAULT_SOFTEN, twist: 0.0 };
        apply_two_bone(skeleton, chain, &ik, &mut out.local, &mut out.model);
        solved = true;
    }
    if let (false, Some(look)) = (inputs.rig.look.is_empty(), inputs.targets.look) {
        let target = LookAt { target: look.target, forward: inputs.rig.look_forward, up: inputs.rig.look_up, offset: Vec3::ZERO, pole: Vec3::Y, weight: look.weight };
        apply_look_at(skeleton, &inputs.rig.look, &target, &mut out.local, &mut out.model);
        solved = true;
    }
    solved
}
