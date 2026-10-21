//! A model's levels of detail as the game names them (game systems LOD-07): authored levels
//! (`Model::with_levels`), a bias (`Model::with_lod_bias`) and compound models
//! (`Assets::compound`). The options ride in an `Arc` on the [`crate::Model`] handle, which stays
//! a cheap `Clone + Eq + Hash` value; nothing here touches the simulation or its checksum.
//!
//! Authored levels become the renderer's level chain at load: level k's mesh is appended to the
//! model's part k-wise and its switch distance becomes an object-space error, so the renderer's
//! band, fades, shadows and per-class threshold apply as they do to an imported chain. A refused
//! option never crashes and has no side effect: the model draws whole (its own parts) and
//! `state().__render.lodRefused` names it with its code.

use std::sync::Arc;

use crate::Model;

/// The most authored levels a model takes past itself.
pub const LOD_LEVELS_MAX: usize = 3;
/// The lowest level-of-detail bias (`Model::with_lod_bias`): each level switches at a quarter of
/// its distance.
pub const LOD_BIAS_MIN: f32 = 0.25;
/// The highest bias: each level holds four times as far.
pub const LOD_BIAS_MAX: f32 = 4.0;
/// The bias a model has unless it names one (genex-render's `LOD_BIAS_DEFAULT`).
pub const LOD_BIAS_DEFAULT: f32 = genex_render::lod_rows::LOD_BIAS_DEFAULT;
/// The vertical field of view, in degrees, at which an authored level's switch distance holds
/// exactly (with `LOD_NOMINAL_HEIGHT` rows and the one-pixel threshold); a sharper view or a
/// bigger copy switches later.
pub const LOD_NOMINAL_FOV_DEGREES: f32 = 60.0;

/// Why a level-of-detail option was refused (`state().__render.lodRefused[].code`). Wire codes:
/// never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum LodRefusalCode {
    /// No levels, more than [`LOD_LEVELS_MAX`], a distance that is not finite and positive or not
    /// increasing, a missing level (an unsafe path included), or a level that has levels of its
    /// own or is a compound.
    LevelsInvalid,
    /// A level's GLB has another part count than the model's (or does not open): the model draws
    /// whole.
    LevelsMismatch,
    /// No members, a missing member, or a member that is a compound itself.
    CompoundInvalid,
    /// An impostor on an empty model (a missing model, or a GLB with no triangles to bake, game
    /// systems LOD-16): the model draws whole, its last mesh level to the horizon.
    ImpostorInvalid,
}

impl LodRefusalCode {
    /// Every code, in declaration order.
    pub const ALL: [LodRefusalCode; 4] = [LodRefusalCode::LevelsInvalid, LodRefusalCode::LevelsMismatch, LodRefusalCode::CompoundInvalid, LodRefusalCode::ImpostorInvalid];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LodRefusalCode::LevelsInvalid => "levels-invalid",
            LodRefusalCode::LevelsMismatch => "levels-mismatch",
            LodRefusalCode::CompoundInvalid => "compound-invalid",
            LodRefusalCode::ImpostorInvalid => "impostor-invalid",
        }
    }
}

/// A model's level-of-detail options. Distances and the bias are kept as bits so the handle
/// stays `Eq + Hash`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ModelLod {
    /// Authored levels, coarser and coarser: each level's model and its switch distance's bits.
    pub(crate) levels: Vec<(Model, u32)>,
    /// The bias's bits ([`LOD_BIAS_DEFAULT`] unless set).
    pub(crate) bias: u32,
    /// A compound's members (empty for any other model).
    pub(crate) members: Vec<Model>,
    /// Why an option was refused; the model then draws whole.
    pub(crate) refused: Option<LodRefusalCode>,
    /// The presenter's cache key: the path for a model whose parts are its GLB's, else a key
    /// naming every file and distance (never a safe asset path, so it meets no real file).
    pub(crate) key: Option<Arc<str>>,
    /// Its impostor (game systems LOD-16), past its last mesh level.
    pub(crate) impostor: Option<Impostor>,
}

impl Default for ModelLod {
    fn default() -> ModelLod {
        ModelLod { levels: Vec::new(), bias: LOD_BIAS_DEFAULT.to_bits(), members: Vec::new(), refused: None, key: None, impostor: None }
    }
}

/// How an impostor is laid out (`Impostor::hemi`, `Impostor::sphere`). Wire spellings
/// (`volatile.render.lod.impostors[].layout`): never rename one.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImpostorLayout {
    /// Seen from the side and above (trees, bushes, buildings).
    Hemi,
    /// Seen from every side, below too (rocks, props on slopes, flying views).
    Sphere,
}

impl ImpostorLayout {
    /// Every layout, in declaration order.
    pub const ALL: [ImpostorLayout; 2] = [ImpostorLayout::Hemi, ImpostorLayout::Sphere];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ImpostorLayout::Hemi => "hemi",
            ImpostorLayout::Sphere => "sphere",
        }
    }

    /// The renderer's layout.
    pub(crate) const fn render(self) -> genex_render::impostor::ImpostorLayout {
        match self {
            ImpostorLayout::Hemi => genex_render::impostor::ImpostorLayout::Hemi,
            ImpostorLayout::Sphere => genex_render::impostor::ImpostorLayout::Sphere,
        }
    }
}

/// A model's impostor (`Model::with_impostor`, game systems LOD-16): past its last mesh level the
/// model draws as a camera-facing card baked from its own parts on the GPU, sized by the device
/// class. The distance is kept as bits so the handle stays `Eq + Hash`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Impostor {
    layout: ImpostorLayout,
    not_before: u32,
}

impl Impostor {
    /// Hemi-octahedral: seen from the side and above (the default for foliage and buildings).
    pub const fn hemi() -> Impostor {
        Impostor { layout: ImpostorLayout::Hemi, not_before: 0 }
    }

    /// Full octahedral: seen from every side.
    pub const fn sphere() -> Impostor {
        Impostor { layout: ImpostorLayout::Sphere, not_before: 0 }
    }

    /// Never before `metres` from the camera (nominal view, as `Model::with_levels` measures),
    /// even when its error allows it; a distance that is not finite and positive keeps none.
    pub fn not_before(self, metres: f32) -> Impostor {
        let usable = metres.is_finite() && metres > 0.0;
        Impostor { not_before: if usable { metres.to_bits() } else { 0 }, ..self }
    }

    /// Its layout.
    pub const fn layout(self) -> ImpostorLayout {
        self.layout
    }

    /// The nearest it draws, in metres (0: wherever its error allows).
    pub fn not_before_m(self) -> f32 {
        f32::from_bits(self.not_before)
    }
}

/// The separator of a derived cache key: refused by the asset-path rule, so no file is named so.
const KEY_SEPARATOR: char = '\\';

impl ModelLod {
    /// The bias.
    pub(crate) fn bias(&self) -> f32 {
        f32::from_bits(self.bias)
    }

    /// Whether the presenter loads this model differently from its GLB alone (authored levels
    /// that were not refused).
    pub(crate) fn chained(&self) -> bool {
        self.refused.is_none() && !self.levels.is_empty()
    }

    /// The impostor drawn past the last mesh level, unless refused.
    pub(crate) fn drawn_impostor(&self) -> Option<Impostor> {
        self.impostor.filter(|_| self.refused != Some(LodRefusalCode::ImpostorInvalid))
    }

    /// The switch distances, in metres.
    pub(crate) fn distances(&self) -> impl Iterator<Item = f32> + '_ {
        self.levels.iter().map(|(_, bits)| f32::from_bits(*bits))
    }
}

/// Why `levels` cannot be `base`'s authored levels, if they cannot.
pub(crate) fn levels_refusal(base: &Model, levels: &[(Model, f32)]) -> Option<LodRefusalCode> {
    let count_ok = !levels.is_empty() && levels.len() <= LOD_LEVELS_MAX;
    let base_ok = base.lod_options().is_none_or(|lod| lod.levels.is_empty() && lod.members.is_empty());
    let levels_ok = levels.iter().all(|(level, _)| !level.is_missing() && level.lod_options().is_none_or(|lod| lod.levels.is_empty() && lod.members.is_empty()));
    let distances_ok = increasing_distances(levels.iter().map(|(_, metres)| *metres));
    let usable = count_ok && base_ok && levels_ok && distances_ok;
    (!usable).then_some(LodRefusalCode::LevelsInvalid)
}

/// Whether every distance is finite, above zero and above the one before.
fn increasing_distances(distances: impl Iterator<Item = f32>) -> bool {
    let mut last = 0.0_f32;
    for metres in distances {
        let usable = metres.is_finite() && metres > last;
        if !usable {
            return false;
        }
        last = metres;
    }
    true
}

/// Why `members` cannot form a compound, if they cannot.
pub(crate) fn compound_refusal(members: &[&Model]) -> Option<LodRefusalCode> {
    let usable = !members.is_empty() && members.iter().all(|member| !member.is_missing() && member.lod_options().is_none_or(|lod| lod.members.is_empty()));
    (!usable).then_some(LodRefusalCode::CompoundInvalid)
}

/// The cache key of `path` with authored `levels`.
pub(crate) fn levels_key(path: &str, levels: &[(Model, f32)]) -> Arc<str> {
    let mut key = String::from(path);
    for (level, metres) in levels {
        key.push(KEY_SEPARATOR);
        key.push_str(&format!("{}={}", metres.to_bits(), level.path().unwrap_or_default()));
    }
    Arc::from(key)
}

/// The cache key of a compound of `members` (each by its own key).
pub(crate) fn compound_key(members: &[&Model]) -> Arc<str> {
    let mut key = String::from("compound");
    for member in members {
        key.push(KEY_SEPARATOR);
        key.push('[');
        key.push_str(member.key().unwrap_or_default());
        key.push(']');
    }
    Arc::from(key)
}

/// The object-space error at which a level switches `metres` from the camera for a copy of scale
/// 1 at the nominal view: `metres * threshold / pixels_per_unit`, with the nominal view's pixels
/// a world unit at distance 1 (half the nominal height over the tangent of half the nominal
/// field of view). The renderer's rule picks the level from that distance on (measured to the
/// nearest point of the part's bounding sphere), scaled by the copy's size.
pub(crate) fn switch_error(metres: f32) -> f32 {
    let half_fov = (LOD_NOMINAL_FOV_DEGREES * 0.5).to_radians();
    let pixels_per_unit = genex_render::mesh::LOD_NOMINAL_HEIGHT as f32 * 0.5 / libm::tanf(half_fov);
    metres * genex_render::mesh::LOD_THRESHOLD_PX / pixels_per_unit
}
