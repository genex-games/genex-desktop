//! Animation on the facade (AN-15), over genex-anim: a [`CharacterAsset`] from `gfx.character`
//! builds its graph and its animators, a world holds each [`Animator`] and advances it in
//! `on_update` with `animator.update(ctx.dt)`, and a draw hook draws it with `frame.character`.
//! `Animator::simple(&hero)` is the short path: `play`, `crossfade`, `play_once` and `speed` on a
//! hidden one-layer graph.
//!
//! The update rule is the facade's own: `update` takes `&mut self`, and every read hook (`on_draw`,
//! `camera`, `probe`, ...) gets `&Sim`, so an animator only moves in the simulation, by the tick's
//! `dt`. Events and root motion come from clip time, never from a pose, so they are the same on
//! every destination; [`Animator::probe`] and genex-anim's `digest` are what a probe or a checksum
//! reads. Animation needs no physics: a build with physics off keeps all of it.
//!
//! ```
//! # use genex::prelude::*;
//! # use genex::animation::{Animator, Motion};
//! # fn reset(gfx: &Gfx) -> Result<Option<Animator>, genex::AnimationError> {
//! let hero = gfx.character("hero.glb")?;
//! let (Some(idle_clip), Some(walk_clip)) = (hero.clip("Idle"), hero.clip("Walk")) else { return Ok(None) };
//! let mut g = hero.graph();
//! let speed = g.float("speed", 0.0);
//! let base = g.layer("base");
//! let idle = g.state(base, "idle", Motion::clip(idle_clip));
//! let walk = g.state(base, "walk", Motion::clip(walk_clip));
//! g.transition(idle, walk).when(speed.above(0.1)).inertialize(0.15);
//! g.transition(walk, idle).when(speed.below(0.1)).inertialize(0.2);
//! hero.animator(&g.build()?).map(Some)
//! # }
//! ```

use std::ops::{Deref, DerefMut};
use std::sync::Arc;

use genex_anim::AnimationError;
use genex_anim::animator::{AnimSet, Animator as Rig};
use genex_anim::retarget::retarget_clips;
use serde_json::Value;

use crate::frame::{Color, Material, Transform};
use crate::gfx::{CharacterAsset, Model};
use crate::math::Vec3;

pub use genex_anim::animator::{AnimEvent, AnimatorStep, Limb, LimbTarget, LookTarget};
pub use genex_anim::events::EventFilter;
pub use genex_anim::graph::{AnimGraph, AnimGraphBuilder, ClipMotion, DEFAULT_BLEND_SECONDS, Motion, TransitionBlend, TransitionBuilder};
pub use genex_anim::ids::{ClipId, EventId, JointId, LayerId, StateId};
pub use genex_anim::mask::{BodyPart, Mask};
pub use genex_anim::params::{BoolParam, Condition, FloatParam, TriggerParam, Vec2Param};
pub use genex_anim::root_motion::{MotionAxes, MotionSettings, RootMotion};
pub use genex_anim::simple::{CROSSFADE_LADDER_SECONDS, SIMPLE_CLIPS_MAX};

/// Whether this build links animation (the facade's `animation` feature; `[animation] enabled =
/// false` in a game's genex.toml leaves it out, release R-1).
pub(crate) const ANIMATION_BUILT: bool = cfg!(feature = "animation");

/// `Ok` in a build with animation. In one without, `gfx.character`, `gfx.node_clips` and every
/// animator are refused `animation-disabled`, so no rig is parsed and nothing is posed; the
/// surface stays and the game's code compiles unchanged.
pub(crate) fn built() -> Result<(), AnimationError> {
    if ANIMATION_BUILT {
        return Ok(());
    }
    Err(AnimationError::disabled("the game is built with [animation] enabled = false; turn it on in genex.toml"))
}

impl CharacterAsset {
    /// A graph builder over this character's skeleton and clips: parameters, layers, states,
    /// transitions and events (`.build()` refuses `animation-graph-invalid`).
    pub fn graph(&self) -> AnimGraphBuilder<'_> {
        let set = self.set();
        AnimGraph::builder(set.skeleton(), set.clips())
    }

    /// The clip named `name` in the file (its glTF animation name), or None.
    pub fn clip(&self, name: &str) -> Option<ClipId> {
        self.graph().clip(name)
    }

    /// The file's clip names, in file order (a [`ClipId`] is the index).
    pub fn clip_names(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.set().clips().iter().map(|clip| clip.name())
    }

    /// An animator of `graph` (built from [`CharacterAsset::graph`]) over this character, in each
    /// layer's first state. Refused `animation-graph-invalid` when `graph` was built over another
    /// character's clips or skeleton.
    pub fn animator(&self, graph: &AnimGraph) -> Result<Animator, AnimationError> {
        built()?;
        let rig = Rig::new(Arc::clone(self.set()), graph)?;
        Ok(Animator { asset: self.clone(), rig })
    }

    /// The same character with root motion extracted from its clips by `settings` (baked in place
    /// when `settings.bake`): an animator's `update` then reports how far the character moved, for
    /// `CharacterMotion::Root`. Refused `animation-asset-invalid` (a root joint the skeleton lacks).
    pub fn with_root_motion(&self, settings: &MotionSettings) -> Result<CharacterAsset, AnimationError> {
        let set = self.set();
        let moved = AnimSet::with_root_motion(set.skeleton().clone(), set.clips().to_vec(), settings)?;
        Ok(self.with_set(moved))
    }

    /// The same character with `source`'s clips retargeted onto its skeleton, after its own (a
    /// Quaternius UAL walk on a Meshy hero; genex-anim's `retarget`): each limb points where the
    /// source's does and the hips' travel scales by leg length. Extract root motion after this.
    /// Refused `animation-retarget-unmapped` when either character lacks a humanoid bone (the
    /// toes are optional), naming the bone and the character.
    pub fn with_retargeted_clips(&self, source: &CharacterAsset) -> Result<CharacterAsset, AnimationError> {
        let (set, from) = (self.set(), source.set());
        let mut clips = set.clips().to_vec();
        clips.extend(retarget_clips(from.skeleton(), from.clips(), set.skeleton())?);
        Ok(self.with_set(AnimSet::new(set.skeleton().clone(), clips)))
    }
}

/// One animated character's state, held in the world and advanced in `on_update`:
/// `animator.update(ctx.dt)` steps its graph and gives the tick's events and root motion. It
/// derefs to genex-anim's animator for the rest (`set_float`, `fire`, `jump_to`, `state_name`,
/// `socket`, `snapshot` / `restore`, `digest`, ...).
#[derive(Clone, Debug)]
pub struct Animator {
    asset: CharacterAsset,
    rig: Rig,
}

impl Animator {
    /// A simple animator of `asset`: `play(clip)`, `crossfade(clip, seconds)`, `play_once(clip)`
    /// and `speed(s)` on a hidden one-layer graph (genex-anim's `simple`), so probes, sockets, IK
    /// and root motion work as on any animator. It shows the rest pose until the first call.
    /// Refused `animation-graph-invalid` past [`SIMPLE_CLIPS_MAX`] clips.
    pub fn simple(asset: &CharacterAsset) -> Result<Animator, AnimationError> {
        asset.animator(&asset.graph().build_simple()?)
    }

    /// The character it animates.
    pub fn asset(&self) -> &CharacterAsset {
        &self.asset
    }

    /// For a probe: each layer's state, clip time and transition, and the parameters
    /// (`{"layers":[{"state":"walk",..}],"params":{"speed":2}}`).
    pub fn probe(&self) -> Value {
        Value::from(&self.rig.probe())
    }

    /// The model handle the presenter loads for it (the checker when the file is missing).
    pub(crate) fn model(&self) -> Model {
        Model::unrecorded(self.asset.path())
    }

    /// Each bone as a segment from its parent joint to itself, in world space for a character
    /// placed at `transform`: two points per bone, parents first.
    pub(crate) fn bone_segments(&self, transform: Transform) -> Vec<Vec3> {
        let skeleton = self.rig.set().skeleton();
        let model = self.rig.model_pose();
        let place = transform.matrix();
        let at = |index: usize| model.get(index).map_or(place.w_axis.truncate(), |joint| (place * *joint).w_axis.truncate());
        skeleton
            .joints()
            .filter_map(|joint| skeleton.parent(joint).map(|parent| [at(usize::from(parent.raw())), at(usize::from(joint.raw()))]))
            .flatten()
            .collect()
    }
}

impl PartialEq for Animator {
    /// The same character in the same state (genex-anim's whole-state digest).
    fn eq(&self, other: &Animator) -> bool {
        self.asset == other.asset && self.rig.digest() == other.rig.digest()
    }
}

impl Deref for Animator {
    type Target = Rig;

    fn deref(&self) -> &Rig {
        &self.rig
    }
}

impl DerefMut for Animator {
    fn deref_mut(&mut self) -> &mut Rig {
        &mut self.rig
    }
}

/// How `frame.character_with` draws a character: a tint and a material that replaces the ones
/// its GLB names.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CharacterDraw {
    tint: Option<Color>,
    material: Option<Material>,
}

impl CharacterDraw {
    /// Its GLB's own materials, untinted (what `frame.character` draws).
    pub fn new() -> CharacterDraw {
        CharacterDraw::default()
    }

    /// Multiply `tint` into its base colour.
    pub fn tint(self, tint: Color) -> CharacterDraw {
        CharacterDraw { tint: Some(tint), ..self }
    }

    /// Draw it with `material` instead of its GLB's.
    pub fn material(self, material: &Material) -> CharacterDraw {
        CharacterDraw { material: Some(material.clone()), ..self }
    }

    /// The tint (white when none was set).
    pub(crate) fn tint_or_white(&self) -> Color {
        self.tint.unwrap_or(Color::WHITE)
    }

    /// The replacing material, if any.
    pub(crate) fn replacing(&self) -> Option<&Material> {
        self.material.as_ref()
    }
}
