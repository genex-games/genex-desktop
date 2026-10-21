//! The presenter's characters (game systems AN-17): a `frame.character` draws its GLB skinned in
//! its animator's pose.
//!
//! - **Upload.** The first frame naming a character's GLB uploads it once as a skinned model (every
//!   skinned primitive, one part per material, AN-16a). Its materials and textures come from the
//!   same file's model load, part by part in first-use order. A file the presenter does not have
//!   draws the magenta checker; a file the renderer refuses as skinned draws its model in bind
//!   pose (the AN-15 behaviour), logged once.
//! - **Pose.** The presenter evaluates the animator's state (genex-anim's pure pipeline, IK
//!   included) into the joint palette in skin order and hands it to the renderer's skinned draw.
//!   The draw reads a clone of the animator, so nothing the presenter does reaches the simulation.
//! - **Rate LOD (Live only).** [`AssetCache::pose_characters`] keeps each character's last palette
//!   by `(asset path, draw id, ordinal)`. A character re-evaluates when its [`RateBand`] interval of
//!   ticks has passed; in between, Live draws the held palette, and the renderer then runs no skin
//!   job for it (AN-16b). The band reads LOD's screen-size metric
//!   ([`genex_render::scene::screen_height_px`]) from the game camera, never from an observer or a
//!   player eye. A capture always evaluates at full rate and leaves the Live cache as it was. An
//!   entry is evicted after two frames in which it was not drawn.
//!
//! A frame no [`AssetCache::pose_characters`] posed (a scene bridge, a shell drawing without a
//! view) draws every character at full rate.

use std::sync::Arc;

use genex_anim::evaluate::{Evaluation, evaluate};
use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use genex_render::motion::DrawId;
use genex_render::scene::{Material, Scene, screen_height_px};
use genex_render::skin::{SkinId, SkinnedModel};
use genex_render::{ImmediateFrame, RenderCode, RenderError};

use super::{AssetCache, ModelSource, Presenter, Uploads, WorldSink, camera_desc, push_shape, rgba, surface};
use crate::animation::Animator;
use crate::camera::Camera;
use crate::frame::{Color, Frame, Shape, Transform};

/// The projected height (LOD's screen-size metric, pixels of a 1080-pixel output) at and above
/// which a character evaluates every tick: a 1.8 m character nearer than about 10 m.
pub const RATE_FULL_PX: f32 = 240.0;
/// At and above this it evaluates every 2nd tick (about 20 m for 1.8 m).
pub const RATE_HALF_PX: f32 = 120.0;
/// At and above this every 4th tick (about 40 m for 1.8 m); below it every 8th.
pub const RATE_QUARTER_PX: f32 = 60.0;
/// Frames a cached pose may go undrawn before it is evicted.
const EVICT_AFTER_FRAMES: u64 = 2;

/// How often a character's pose is evaluated in Live, chosen by its projected height
/// ([`rate_band`]); captures are always [`RateBand::Full`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateBand {
    /// Every tick.
    Full,
    /// Every 2nd tick.
    Half,
    /// Every 4th tick.
    Quarter,
    /// Every 8th tick.
    Eighth,
}

impl RateBand {
    /// The band of a projected height of `pixels` ([`RATE_FULL_PX`] and the two below it).
    pub fn of_height(pixels: f32) -> RateBand {
        if pixels >= RATE_FULL_PX {
            return RateBand::Full;
        }
        if pixels >= RATE_HALF_PX {
            return RateBand::Half;
        }
        if pixels >= RATE_QUARTER_PX {
            return RateBand::Quarter;
        }
        RateBand::Eighth
    }

    /// The ticks between two evaluations (1, 2, 4 or 8).
    pub fn interval(self) -> u64 {
        match self {
            RateBand::Full => 1,
            RateBand::Half => 2,
            RateBand::Quarter => 4,
            RateBand::Eighth => 8,
        }
    }
}

/// The rate band of a character whose world bounding sphere is `sphere` (centre xyz, radius), seen
/// from `camera` (the game camera): LOD's screen-size metric, banded.
pub fn rate_band(camera: &Camera, sphere: [f32; 4]) -> RateBand {
    RateBand::of_height(screen_height_px(&camera_desc(camera), sphere))
}

/// FNV-1a 64 over the bits of `palettes`, in order: the poses a frame draws.
pub fn palette_digest(palettes: &[Vec<[f32; 16]>]) -> u64 {
    palettes.iter().flatten().flatten().fold(FNV_OFFSET_BASIS, |hash, value| fnv1a64_from(&value.to_bits().to_le_bytes(), hash))
}

/// What the last [`AssetCache::pose_characters`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CharacterStats {
    /// Characters drawn skinned.
    pub drawn: u32,
    /// Of them, poses evaluated this frame.
    pub evaluated: u32,
    /// Of them, poses held from an earlier tick (Live rate LOD).
    pub held: u32,
    /// Poses the Live cache holds after the frame.
    pub cached: u32,
    /// [`palette_digest`] of the poses drawn, in draw order.
    pub palette_digest: u64,
}

/// A character's GLB on the renderer as a skinned model.
#[derive(Clone, Copy, Debug, PartialEq)]
struct LoadedSkin {
    skin: SkinId,
    /// The bind-pose mesh's bounding sphere in model space (centre, radius).
    center: [f32; 3],
    radius: f32,
    triangles: u32,
}

/// One character's place in the Live cache across frames: its asset, its draw id and its place
/// among the frame's characters of both.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PoseKey {
    path: String,
    id: Option<DrawId>,
    ordinal: u32,
}

/// A held pose: the tick it was evaluated at and the last frame it was drawn in.
#[derive(Clone, Debug, PartialEq)]
struct HeldPose {
    key: PoseKey,
    tick: u64,
    seen: u64,
    palette: Vec<[f32; 16]>,
}

/// The presenter's characters: skins by path, the Live pose cache and the frame's poses.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Characters {
    skins: Vec<(String, Option<LoadedSkin>)>,
    held: Vec<HeldPose>,
    /// The poses the last [`AssetCache::pose_characters`] chose, by the drawn animator (each
    /// frame's `Arc`, kept so its address names it for the frame).
    posed: Vec<(Arc<Animator>, Vec<[f32; 16]>)>,
    frames: u64,
    stats: CharacterStats,
}

impl Characters {
    /// Upload every character GLB `frame` draws that was never tried, skinned. A lost device stops
    /// the load and leaves the rest to be tried again.
    pub(super) fn load(&mut self, frame: &Frame, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<(), RenderError> {
        for draw in frame.draws() {
            let Shape::Character { animator, .. } = &draw.shape else { continue };
            let path = animator.asset().path();
            if self.skins.iter().any(|(known, _)| known == path) {
                continue;
            }
            let loaded = load_skin(path, source, uploads, log)?;
            self.skins.push((path.to_owned(), loaded));
        }
        Ok(())
    }

    /// Forget the skins (and held poses) of every path `touched` names, so the next load skins
    /// them again (a dev build's `reloadAssets`, C-18). The old skin stays on the device until it
    /// is re-created, as a reloaded texture's slot does.
    pub(super) fn forget(&mut self, touched: impl Fn(&str) -> bool) {
        self.skins.retain(|(path, _)| !touched(path));
        self.held.retain(|held| !touched(&held.key.path));
    }

    fn skin(&self, path: &str) -> Option<&LoadedSkin> {
        self.skins.iter().find(|(known, _)| known == path).and_then(|(_, loaded)| loaded.as_ref())
    }

    /// The palette chosen for `animator` this frame, if the frame was posed.
    fn posed(&self, animator: &Arc<Animator>) -> Option<&[[f32; 16]]> {
        self.posed.iter().find(|(drawn, _)| Arc::ptr_eq(drawn, animator)).map(|(_, palette)| palette.as_slice())
    }

    /// Choose every skinned character's pose for `frame` at `tick` (see the module docs).
    fn pose(&mut self, frame: &Frame, game_camera: &Camera, tick: u64, live: bool) {
        self.frames += 1;
        self.posed.clear();
        let mut stats = CharacterStats::default();
        let mut keys: Vec<PoseKey> = Vec::new();
        for draw in frame.draws() {
            let Shape::Character { animator, transform, .. } = &draw.shape else { continue };
            let path = animator.asset().path();
            let Some(skin) = self.skin(path).copied() else { continue };
            let ordinal = keys.iter().filter(|key| key.path == path && key.id == draw.id).count() as u32;
            let key = PoseKey { path: path.to_owned(), id: draw.id, ordinal };
            keys.push(key.clone());
            let palette = if live { self.live_pose(key, animator, band_of(&skin, *transform, game_camera), tick, &mut stats) } else { full_rate(animator, &mut stats) };
            self.posed.push((Arc::clone(animator), palette));
            stats.drawn += 1;
        }
        let frames = self.frames;
        self.held.retain(|held| frames - held.seen < EVICT_AFTER_FRAMES);
        let palettes: Vec<Vec<[f32; 16]>> = self.posed.iter().map(|(_, palette)| palette.clone()).collect();
        stats.palette_digest = palette_digest(&palettes);
        stats.cached = self.held.len() as u32;
        self.stats = stats;
    }

    /// `key`'s Live pose at `tick`: the held one while its band's interval has not passed, else a
    /// fresh evaluation, which the cache then holds.
    fn live_pose(&mut self, key: PoseKey, animator: &Animator, band: RateBand, tick: u64, stats: &mut CharacterStats) -> Vec<[f32; 16]> {
        let frames = self.frames;
        let joints = animator.set().skeleton().skin_order().len();
        if let Some(held) = self.held.iter_mut().find(|held| held.key == key) {
            held.seen = frames;
            let fresh = held.palette.len() == joints && tick >= held.tick && tick - held.tick < band.interval();
            if fresh {
                stats.held += 1;
                return held.palette.clone();
            }
            held.palette = full_rate(animator, stats);
            held.tick = tick;
            return held.palette.clone();
        }
        let palette = full_rate(animator, stats);
        self.held.push(HeldPose { key, tick, seen: frames, palette: palette.clone() });
        palette
    }
}

/// The rate band of a character drawn under `transform` (its bind-pose sphere, placed).
fn band_of(skin: &LoadedSkin, transform: Transform, game_camera: &Camera) -> RateBand {
    let sphere = genex_render::lod_rows::world_sphere(&transform.to_cols_array(), skin.center, skin.radius);
    rate_band(game_camera, sphere)
}

/// `animator`'s pose evaluated now, as the skinning palette in skin order.
fn full_rate(animator: &Animator, stats: &mut CharacterStats) -> Vec<[f32; 16]> {
    stats.evaluated += 1;
    evaluated_palette(animator)
}

/// genex-anim's evaluation of `animator`'s state (IK from its stored targets) as the palette.
fn evaluated_palette(animator: &Animator) -> Vec<[f32; 16]> {
    let skeleton = animator.set().skeleton();
    let mut evaluation = Evaluation::new(skeleton.joint_count());
    evaluate(animator, &mut evaluation);
    let mut palette = vec![glam::Mat4::IDENTITY.to_cols_array(); skeleton.skin_order().len()];
    skeleton.palette(evaluation.model(), &mut palette);
    palette
}

/// `path` uploaded as a skinned model; None (logged) when the file is not there (its model load
/// says so) or the GLB or the renderer refuses it. A lost device is passed on.
fn load_skin(path: &str, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Option<LoadedSkin>, RenderError> {
    let Some(bytes) = source.model_bytes(path) else { return Ok(None) };
    let model = match SkinnedModel::from_glb(&bytes) {
        Ok(model) => model,
        Err(error) => {
            log(&format!("character {path:?} drawn in bind pose: {error}"));
            return Ok(None);
        }
    };
    match uploads.add_skinned_model(&model) {
        Ok(skin) => {
            let (center, radius) = model.data.mesh.bounds();
            let triangles = u32::try_from(model.data.mesh.indices.len() / 3).unwrap_or(u32::MAX);
            Ok(Some(LoadedSkin { skin, center, radius, triangles }))
        }
        Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
        Err(error) => {
            log(&format!("character {path:?} drawn in bind pose: {error}"));
            Ok(None)
        }
    }
}

/// What a sink takes a skinned draw as: the renderer's scene and the presenter's frame.
pub(super) trait SkinSink {
    /// One skinned draw posed by `joints`, each part with its material.
    fn skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, materials: Vec<Material>);
}

impl SkinSink for Scene {
    fn skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, materials: Vec<Material>) {
        self.draw_skinned_parts(skin, model, joints, materials);
    }
}

impl SkinSink for ImmediateFrame {
    fn skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, materials: Vec<Material>) {
        self.skinned_parts(skin, model, joints, materials);
    }
}

/// A character as `frame.character` drew it.
pub(super) struct CharacterShape<'a> {
    pub(super) animator: &'a Arc<Animator>,
    pub(super) transform: Transform,
    pub(super) tint: Color,
    pub(super) material: Option<&'a crate::Material>,
}

/// Add one character to `sink`: skinned in its pose when its skin is held, else its file's model
/// (bind pose, or the checker when missing). Answers its triangles.
pub(super) fn push(sink: &mut impl WorldSink, assets: &AssetCache, missing: &mut Vec<String>, character: CharacterShape<'_>) -> u32 {
    let CharacterShape { animator, transform, tint, material } = character;
    let path = animator.asset().path();
    let skinned = assets.characters.skin(path).filter(|skin| skin.skin.joint_count() as usize == animator.set().skeleton().skin_order().len());
    let Some(skin) = skinned else {
        let model = Shape::Model { model: animator.model(), transform, tint, material: material.cloned() };
        return push_shape(sink, assets, missing, &model);
    };
    let joints = assets.characters.posed(animator).map_or_else(|| evaluated_palette(animator), <[_]>::to_vec);
    let loaded = assets.model(path);
    let materials = (0..skin.skin.part_count() as usize)
        .map(|part| match (material, loaded.and_then(|model| model.parts.get(part)).and_then(|part| part.material.as_ref())) {
            (Some(material), _) => surface(material, tint, assets),
            (None, Some(glb)) => glb.to_material(rgba(tint)),
            (None, None) => surface(&crate::Material::color(tint), Color::WHITE, assets),
        })
        .collect();
    sink.skinned(skin.skin, transform.to_cols_array(), joints, materials);
    skin.triangles
}

impl AssetCache {
    /// The skinned model held for character GLB `path`; None when it was refused, is missing or
    /// was never drawn.
    pub fn skin(&self, path: &str) -> Option<SkinId> {
        self.characters.skin(path).map(|loaded| loaded.skin)
    }

    /// Choose the pose every character in `frame` draws at `tick`: in Live (`live`) by its rate
    /// band from `game_camera`, held in between; in a capture, evaluated now (module docs). The
    /// next [`super::to_scene`] or presenter frame of `frame` draws them.
    pub fn pose_characters(&mut self, frame: &Frame, game_camera: &Camera, tick: u64, live: bool) {
        self.characters.pose(frame, game_camera, tick, live);
    }

    /// What the last [`AssetCache::pose_characters`] did.
    pub fn character_stats(&self) -> CharacterStats {
        self.characters.stats
    }
}

impl Presenter {
    /// What the last drawn view's characters did (`volatile.render.characters`).
    pub fn character_stats(&self) -> CharacterStats {
        self.assets.character_stats()
    }

    /// `volatile.render.characters` for the last drawn frame (game systems AN-23): its characters'
    /// poses and the renderer's skinned instances on each path under the class's compute cap.
    pub fn characters_status(&self) -> crate::render::CharactersStatus {
        let stats = self.assets.character_stats();
        let skinned = self.resilient.renderer().renderer().last_skinned_instances();
        crate::render::CharactersStatus {
            drawn: stats.drawn,
            evaluated: stats.evaluated,
            held: stats.held,
            compute_skinned: skinned.compute,
            vertex_skinned: skinned.vertex,
            compute_max: skinned.compute_max,
        }
    }
}
