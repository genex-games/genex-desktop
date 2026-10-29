//! Animation on the facade (AN-15), over genex-anim: a [`CharacterAsset`] from `gfx.character`
//! builds its graph and its animators, a world holds each [`Animator`] and advances it in
//! `on_update` with `animator.update(ctx.dt)`, and a draw hook draws it with `frame.character`.
//! `Animator::simple(&hero)` is the short path: `play`, `crossfade`, `play_once` and `speed` on a
//! hidden one-layer graph. `animator.plant_feet(model, ground)` after the update keeps the feet on
//! slopes and steps (release R-22, over genex-anim's `FootPlacer`).
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
use genex_anim::character::GroundHit;
use genex_anim::clip::import_clips_by_name;
use genex_anim::evaluate::pose_digest;
use genex_anim::foot::{FootPlacer, FootRig, FootSettings, apply_plan};
use genex_anim::math::Trs;
use genex_anim::retarget::retarget_clips;
use genex_core::digest::fnv1a64_from;
use genex_core::json::Value as CoreValue;
use serde_json::Value;

use crate::frame::{Color, Material, Transform};
use crate::gfx::{Assets, CharacterAsset, Model};
use crate::math::{Mat4, Vec3};

pub use genex_anim::animator::{AnimEvent, AnimatorStep, Limb, LimbTarget, LookTarget};
pub use genex_anim::events::EventFilter;
pub use genex_anim::foot::{Foot, FootGoal, FootPlan, height_ground};
pub use genex_anim::graph::{AnimGraph, AnimGraphBuilder, BlendMotion, ClipMotion, DEFAULT_BLEND_SECONDS, Motion, TransitionBlend, TransitionBuilder};
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

    /// How fast `clip` carries the character over the ground, metres per second: its root
    /// motion's net horizontal travel over its length. None for a clip the character lacks or
    /// before [`CharacterAsset::with_root_motion`] extracted it. Put each clip of a speed blend
    /// at its own ground speed (`Motion::blend1d(speed, &[(walk_speed, walk), (run_speed, run)])`)
    /// and feed the body's speed, so the feet move with the ground.
    pub fn clip_ground_speed(&self, clip: ClipId) -> Option<f32> {
        let track = self.set().motion(clip)?;
        let travel = track.displacement();
        let duration = track.duration();
        (duration > 0.0).then(|| (travel.x * travel.x + travel.z * travel.z).sqrt() / duration)
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
        Ok(Animator { asset: self.clone(), rig, dt: 0.0, feet: None, revision: next_revision() })
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

    /// The same character with clips from other files, after its own (B8): for each `(name,
    /// path)`, the first animation of the GLB at `assets/<path>` under `name`. A clip file is a
    /// skeleton-only GLB (Uthana delivers one per clip) or any GLB whose nodes carry this rig's
    /// joint names: each channel drives the joint of its node's name, the rest are skipped, and
    /// nothing is retargeted. Read in `on_reset` as [`Assets::bytes`] reads. Extract root motion
    /// after this. Refused `animation-asset-invalid`: a file the build does not have or cannot
    /// read now, one that is not a valid GLB, or a name a clip already has; `animation-clip-missing`:
    /// a file with no animation, or none whose channels name a joint of this rig.
    ///
    /// ```
    /// # use genex::prelude::*;
    /// # fn wire(game: &mut Game<Option<genex::CharacterAsset>>) {
    /// game.on_reset(|sim, _, _, gfx| {
    ///     let Ok(gunman) = gfx.character("gunman/rig.glb") else { return };
    ///     let clips = [("Idle", "gunman/idle.glb"), ("Fire", "gunman/fire.glb")];
    ///     sim.world = gunman.with_clip_files(gfx.assets(), &clips).ok();
    /// });
    /// # }
    /// ```
    pub fn with_clip_files(&self, assets: &Assets, files: &[(&str, &str)]) -> Result<CharacterAsset, AnimationError> {
        let set = self.set();
        let mut clips = set.clips().to_vec();
        for &(name, path) in files {
            let refused = |error: AnimationError| AnimationError { code: error.code, detail: format!("{path}: {}", error.detail) };
            if clips.iter().any(|clip| clip.name() == name) {
                return Err(AnimationError::asset_invalid(format!("{path}: the character already has a clip named {name:?}")));
            }
            let bytes = assets.bytes(path).map_err(|error| AnimationError::asset_invalid(format!("{path}: {error}")))?;
            let added = import_clips_by_name(&bytes, self.rig()).map_err(refused)?;
            let Some(first) = added.into_iter().next() else { return Err(refused(AnimationError::clip_missing("the file has no animation"))) };
            clips.push(first.renamed(name));
        }
        Ok(self.with_set(AnimSet::new(set.skeleton().clone(), clips)))
    }
}

/// One animated character's state, held in the world and advanced in `on_update`:
/// `animator.update(ctx.dt)` steps its graph and gives the tick's events and root motion, and
/// `animator.plant_feet(model, ground)` after it keeps the feet on uneven ground. It derefs to
/// genex-anim's animator for the rest (`set_float`, `fire`, `jump_to`, `state_name`, ...).
#[derive(Clone, Debug)]
pub struct Animator {
    asset: CharacterAsset,
    rig: Rig,
    /// The last update's `dt`, which the next `plant_feet` eases its locks by.
    dt: f32,
    /// Foot placement, from the first `plant_feet` on (release R-22).
    feet: Option<Box<Feet>>,
    /// A number no other state of any animator in the process carries (lane CP): taken afresh by
    /// every `&mut` access, kept by a clone. Two animators with one revision are one state, so a
    /// frame copies each drawn animator once. Never part of the state, its digest or a snapshot.
    revision: u64,
}

/// The last revision handed out ([`Animator::revision`]).
static REVISIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A revision no animator has carried yet.
fn next_revision() -> u64 {
    REVISIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// One character's planted feet: its legs, the placer's locks and the pose with the last plan.
#[derive(Clone, Debug, PartialEq)]
struct Feet {
    /// The legs; `None` for a rig without a humanoid's hips, thighs, shins and feet.
    rig: Option<FootRig>,
    placer: FootPlacer,
    /// The animator's pose with the last plan applied, until the next update.
    posed: Option<Posed>,
    /// The furthest the pelvis drops before the character counts as in the air, model space.
    max_drop: f32,
}

impl Feet {
    /// No locks yet, over `set`'s legs.
    fn new(set: &AnimSet, placer: FootPlacer) -> Box<Feet> {
        let skeleton = set.skeleton();
        let rig = FootRig::of(skeleton, set.humanoid());
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let hips = rig.as_ref().and_then(|legs| rest.get(usize::from(legs.pelvis().raw()))).map_or(0.0, |pelvis| pelvis.w_axis.y.max(0.0));
        Box::new(Feet { rig, placer, posed: None, max_drop: AIRBORNE_DROP_SHARE * hips })
    }
}

/// A planted pose: local transforms and model matrices.
#[derive(Clone, Debug, PartialEq)]
struct Posed {
    local: Vec<Trs>,
    model: Vec<Mat4>,
}

/// The share of the hips' rest height the pelvis may drop to reach the ground; a deeper drop means
/// the character is in the air (a jump, a ledge), and `plant_feet` leaves its legs as animated.
const AIRBORNE_DROP_SHARE: f32 = 0.35;

/// The snapshot key the facade adds for the feet's locks.
const FEET_KEY: &str = "feet";

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

    /// Advance by `dt` seconds (pass `ctx.dt`): genex-anim's `update`, which gives the tick's
    /// events and root motion. The feet stand where the animation puts them until the next
    /// [`Animator::plant_feet`].
    pub fn update(&mut self, dt: f32) -> AnimatorStep {
        self.revision = next_revision();
        self.dt = dt;
        if let Some(feet) = &mut self.feet {
            feet.posed = None;
        }
        self.rig.update(dt)
    }

    /// Keep the feet on the ground (release R-22, call it in `on_update` after
    /// [`Animator::update`]): for a character drawn at `model`, cast `ground(from, to)` under each
    /// ankle (world space; `character.ground_ray(&sim.physics)` with physics, or
    /// `height_ground(|x, z| Some(terrain.height(x, z)))`), bend each leg onto the ground, turn
    /// each foot to its slope (at most 30°), drop the pelvis by the lower foot's offset and hold a
    /// planted foot where it stands until the animation lifts it. A foot is down while its ankle
    /// is within 3 cm of its rest height. The planted pose is what `socket`, `pose`, `palette`
    /// and `frame.character` show until the next update; the locks are simulation state, carried
    /// by `snapshot` / `restore`. A rig without a humanoid's legs, a probe that finds no ground,
    /// or ground so far below that the pelvis would drop more than a third of the hips' height
    /// (the character is in the air: its locks go) leaves the pose as it is ([`FootPlan::NONE`]).
    ///
    /// ```
    /// # use genex::prelude::*;
    /// use genex::animation::{FootPlan, height_ground};
    ///
    /// #[derive(Default)]
    /// struct World { hero: Option<Animator>, terrain: Option<genex::Terrain>, at: Transform, feet: FootPlan }
    ///
    /// # fn wire(game: &mut Game<World>) {
    /// game.on_update(|sim, ctx| {
    ///     let World { hero: Some(hero), terrain: Some(terrain), at, feet } = &mut sim.world else { return };
    ///     hero.update(ctx.dt);
    ///     *feet = hero.plant_feet(*at, height_ground(|x, z| Some(terrain.height(x, z))));
    /// });
    /// // A probe a check reads: both feet found the ground, and how far the pelvis dropped.
    /// game.probe("feet", |sim| json!({ "planted": sim.world.feet.feet.iter().flatten().count(), "pelvisDrop": -sim.world.feet.pelvis.y }));
    /// # }
    /// ```
    pub fn plant_feet(&mut self, model: Transform, ground: impl FnMut(Vec3, Vec3) -> Option<GroundHit>) -> FootPlan {
        self.revision = next_revision();
        let set = Arc::clone(self.rig.set());
        let feet = self.feet.get_or_insert_with(|| Feet::new(&set, FootPlacer::new(FootSettings::default())));
        let Some(legs) = &feet.rig else { return FootPlan::NONE };
        let contacts = legs.contacts(self.rig.model_pose());
        let plan = feet.placer.plant(legs, self.rig.pose(), model.matrix(), contacts, self.dt, ground);
        if plan.pelvis.length() > feet.max_drop {
            // In the air: the legs stay as animated and the locks go, so a landing locks afresh.
            feet.placer.clear();
            feet.posed = None;
            return FootPlan::NONE;
        }
        let mut posed = Posed { local: self.rig.pose().to_vec(), model: self.rig.model_pose().to_vec() };
        let skeleton = set.skeleton();
        if apply_plan(skeleton, legs, &plan, &mut posed.local, &mut posed.model) {
            // The toes below each foot catch up.
            skeleton.local_to_model(&posed.local, &mut posed.model);
        }
        feet.posed = Some(posed);
        plan
    }

    /// The planted pose, when `plant_feet` ran since the last update.
    fn posed(&self) -> Option<&Posed> {
        self.feet.as_ref().and_then(|feet| feet.posed.as_ref())
    }

    /// The local pose as drawn: planted after `plant_feet`, otherwise genex-anim's evaluation.
    pub fn pose(&self) -> &[Trs] {
        self.posed().map_or_else(|| self.rig.pose(), |posed| &posed.local)
    }

    /// The model-space pose as drawn, one matrix per joint.
    pub fn model_pose(&self) -> &[Mat4] {
        self.posed().map_or_else(|| self.rig.model_pose(), |posed| &posed.model)
    }

    /// A joint's world transform for a character placed at `model` (`model` itself for a joint
    /// the skeleton lacks): the drawn pose's, planted feet included.
    pub fn socket(&self, joint: JointId, model: Mat4) -> Mat4 {
        self.model_pose().get(usize::from(joint.raw())).map_or(model, |joint| model * *joint)
    }

    /// The skinning palette of the drawn pose into `palette`, in skin order: in the skinned mesh
    /// node's space, which `skeleton().mesh_frame()` places under the character's transform.
    pub fn palette(&self, palette: &mut [[f32; 16]]) {
        self.rig.set().skeleton().palette(self.model_pose(), palette);
    }

    /// The drawn pose's palette when `plant_feet` planted it since the last update: the
    /// presenter's path, which otherwise evaluates the animator's state itself.
    pub(crate) fn planted_palette(&self) -> Option<Vec<[f32; 16]>> {
        let posed = self.posed()?;
        let skeleton = self.rig.set().skeleton();
        let mut palette = vec![Mat4::IDENTITY.to_cols_array(); skeleton.skin_order().len()];
        skeleton.palette(&posed.model, &mut palette);
        Some(palette)
    }

    /// FNV-1a 64 over the drawn local pose's bits.
    pub fn pose_digest(&self) -> u64 {
        pose_digest(self.pose())
    }

    /// FNV-1a 64 over the whole state: genex-anim's digest, then the feet's locks once
    /// `plant_feet` has run.
    pub fn digest(&self) -> u64 {
        let hash = self.rig.digest();
        self.feet.as_ref().map_or(hash, |feet| fnv1a64_from(&feet.placer.digest().to_le_bytes(), hash))
    }

    /// The whole state as a value (genex-anim's snapshot, plus the feet's locks under `"feet"`
    /// once `plant_feet` has run). [`Animator::restore`] continues exactly where this one is.
    pub fn snapshot(&self) -> CoreValue {
        let mut out = self.rig.snapshot();
        if let Some(feet) = &self.feet {
            out.set(FEET_KEY, feet.placer.snapshot());
        }
        out
    }

    /// Restore a [`Animator::snapshot`]. Refused `animation-asset-invalid`, with the animator
    /// unchanged: genex-anim's refusals, or feet that are not a foot snapshot. A snapshot without
    /// feet drops the locks; the feet stand as animated until the next `plant_feet`.
    pub fn restore(&mut self, snapshot: &CoreValue) -> Result<(), AnimationError> {
        self.revision = next_revision();
        let mut placer = FootPlacer::new(FootSettings::default());
        let saved = snapshot.get(FEET_KEY);
        if let Some(saved) = saved {
            placer.restore(saved)?;
        }
        self.rig.restore(snapshot)?;
        self.feet = saved.map(|_| Feet::new(self.rig.set(), placer));
        Ok(())
    }

    /// For a probe: each layer's state, clip time and transition, and the parameters
    /// (`{"layers":[{"state":"walk",..}],"params":{"speed":2}}`).
    pub fn probe(&self) -> Value {
        Value::from(&self.rig.probe())
    }

    /// Its revision: the same for two animators only while they hold one state (a clone that
    /// neither has changed since).
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    /// The model handle the presenter loads for it (the checker when the file is missing).
    pub(crate) fn model(&self) -> Model {
        Model::unrecorded(self.asset.path())
    }

    /// Each bone as a segment from its parent joint to itself, in world space for a character
    /// placed at `transform`: two points per bone, parents first.
    pub(crate) fn bone_segments(&self, transform: Transform) -> Vec<Vec3> {
        let skeleton = self.rig.set().skeleton();
        let model = self.model_pose();
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
    /// The same character in the same state (the whole-state digest, feet included).
    fn eq(&self, other: &Animator) -> bool {
        self.asset == other.asset && self.digest() == other.digest()
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
        self.revision = next_revision();
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
