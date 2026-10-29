//! Plants in the wind (vegetation lane): `Model::with_wind(WindResponse::tree())` bends a model in
//! the shared wind field, the one the terrain's grass sways in, with three layers (genex-render's
//! `wind` module): the trunk leans down each gust, branches bob out of phase across the crown, and
//! leaves flutter. The weights come from each vertex's model-space height and reach over the
//! model's own extent, so any GLB sways, a CC0 tree or a `gfx.plant` alike, with no painted vertex
//! colours. It works with authored and imported levels, compounds, instance groups (each copy sways
//! in its own phase) and impostors (the card stands still: at its distance the sway is under a
//! pixel). The sway is display-only and never reaches the sim or its checksum.
//!
//! **Foliage defaults.** A part of a swaying model whose material is alpha-tested, blended or
//! double-sided is foliage: it draws cut out (glTF `MASK`, [`FOLIAGE_CUTOFF`] unless the material
//! names a cutoff), two-sided, lets the sun through as [`Subsurface::LEAF`] (keeping the share a
//! GLB's `KHR_materials_diffuse_transmission` names) unless the material carries a scattering
//! subsurface of its own, and flutters. Every other part (bark, stems) bends without
//! fluttering. A material given to the draw (`frame.model_with`) keeps its own alpha and faces.

use genex_render::pbr::Material;
use genex_render::subsurface::Subsurface;
use genex_render::wind::Sway;

/// The alpha below which a foliage part's texel is cut away, unless its material names one.
pub const FOLIAGE_CUTOFF: f32 = 0.5;
/// The strongest [`WindResponse::with_strength`] keeps (a storm).
pub const WIND_STRENGTH_MAX: f32 = 4.0;

/// How a model bends in the wind (`Model::with_wind`): each layer's size relative to the model, so
/// one response fits a 4 m sapling and a 30 m spruce. Equal and hashed by its bits (a model
/// handle's equality includes it).
#[derive(Clone, Copy, Debug)]
pub struct WindResponse {
    /// How far the top leans at full gust, as a share of the model's height.
    trunk: f32,
    /// How far a branch tip bobs, as a share of the model's reach from its trunk.
    branch: f32,
    /// How far a leaf shivers (metres for a copy of scale 1).
    flutter: f32,
    /// How fast a leaf shivers (hertz).
    flutter_hz: f32,
}

impl WindResponse {
    /// A tree: a slow lean of about 1% of its height, branches bobbing 3% of the crown's reach,
    /// leaves shivering 2 cm at 3 Hz.
    pub const fn tree() -> WindResponse {
        WindResponse { trunk: 0.012, branch: 0.03, flutter: 0.02, flutter_hz: 3.0 }
    }

    /// A shrub or a bush: stiffer stems, livelier twigs.
    pub const fn shrub() -> WindResponse {
        WindResponse { trunk: 0.03, branch: 0.05, flutter: 0.015, flutter_hz: 4.0 }
    }

    /// Grass, reeds, ferns and ground cover: the whole clump bends from its root.
    pub const fn grass() -> WindResponse {
        WindResponse { trunk: 0.15, branch: 0.04, flutter: 0.01, flutter_hz: 5.0 }
    }

    /// This response under a stronger or calmer wind: every layer times `strength` (0 still, 1 as
    /// is, up to [`WIND_STRENGTH_MAX`]); a strength that is not finite keeps the response.
    pub fn with_strength(self, strength: f32) -> WindResponse {
        if !strength.is_finite() {
            return self;
        }
        let strength = strength.clamp(0.0, WIND_STRENGTH_MAX);
        WindResponse { trunk: self.trunk * strength, branch: self.branch * strength, flutter: self.flutter * strength, ..self }
    }

    /// The renderer's sway of a model of `extent` (height above its origin, reach from its axis;
    /// metres) for a part that flutters (`leaf`) or not.
    pub(crate) fn sway(self, extent: [f32; 2], leaf: bool) -> Sway {
        let [height, reach] = extent;
        Sway {
            height,
            reach,
            trunk: self.trunk * height,
            branch: self.branch * reach,
            flutter: if leaf { self.flutter } else { 0.0 },
            flutter_hz: self.flutter_hz,
        }
    }

    /// The response's bits, for the model handle's equality and hash.
    fn bits(self) -> [u32; 4] {
        [self.trunk.to_bits(), self.branch.to_bits(), self.flutter.to_bits(), self.flutter_hz.to_bits()]
    }
}

impl PartialEq for WindResponse {
    fn eq(&self, other: &WindResponse) -> bool {
        self.bits() == other.bits()
    }
}

impl Eq for WindResponse {}

impl std::hash::Hash for WindResponse {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.bits().hash(state);
    }
}

/// Whether a part drawn with `material` is foliage: alpha-tested, blended or double-sided.
pub(crate) fn is_foliage(material: &Material) -> bool {
    material.alpha_cutoff.is_some() || material.double_sided || material.base_color[3] < u8::MAX
}

/// `material` as a part of a model swaying by `wind` over `extent` draws it: foliage takes the
/// foliage defaults when `defaults` (the part's own GLB material) and flutters; every other part
/// bends without fluttering.
pub(crate) fn swaying(material: Material, wind: WindResponse, extent: [f32; 2], defaults: bool) -> Material {
    let leaf = is_foliage(&material);
    let material = if leaf && defaults { foliage_defaults(material) } else { material };
    material.with_sway(wind.sway(extent, leaf))
}

/// A foliage material's defaults: cut out (not blended), two-sided, the sun through it as a leaf.
fn foliage_defaults(material: Material) -> Material {
    let cutoff = material.alpha_cutoff.unwrap_or(FOLIAGE_CUTOFF);
    let opaque = [material.base_color[0], material.base_color[1], material.base_color[2], u8::MAX];
    // A GLB's `KHR_materials_diffuse_transmission` brings transmission alone (no scatter
    // colour): a leaf keeps its share of light through and scatters as a leaf.
    let subsurface = match material.subsurface {
        None => Subsurface::LEAF,
        Some(own) if own.color == [0.0; 3] => Subsurface { transmission: own.transmission, ..Subsurface::LEAF },
        Some(own) => own,
    };
    Material { base_color: opaque, ..material }.with_alpha_cutoff(cutoff).with_double_sided(true).with_subsurface(subsurface)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTENT: [f32; 2] = [12.0, 4.0];

    #[test]
    fn a_response_scales_with_the_model_it_bends() {
        let small = WindResponse::tree().sway([4.0, 1.5], true);
        let tall = WindResponse::tree().sway([30.0, 8.0], true);
        assert!(tall.trunk > small.trunk * 7.0 && tall.branch > small.branch * 5.0, "a taller tree leans further: {small:?} {tall:?}");
        assert_eq!(small.flutter, tall.flutter, "a leaf is a leaf");
        assert_eq!(WindResponse::tree().sway(EXTENT, false).flutter, 0.0, "bark never flutters");
    }

    #[test]
    fn grass_bends_from_its_root_more_than_a_tree_leans() {
        let share = |response: WindResponse| response.sway([1.0, 1.0], true).trunk;
        assert!(share(WindResponse::grass()) > share(WindResponse::shrub()) && share(WindResponse::shrub()) > share(WindResponse::tree()));
    }

    #[test]
    fn strength_scales_every_layer_and_is_held() {
        let calm = WindResponse::tree().with_strength(0.0);
        assert_eq!(calm.sway(EXTENT, true).held(), None, "no wind stands still");
        let storm = WindResponse::tree().with_strength(100.0);
        assert_eq!(storm, WindResponse::tree().with_strength(WIND_STRENGTH_MAX));
        assert_eq!(WindResponse::tree().with_strength(f32::NAN), WindResponse::tree());
    }

    #[test]
    fn foliage_takes_its_defaults_and_bark_keeps_its_material() {
        let bark = Material::color([120, 100, 80, 255]);
        let drawn = swaying(bark, WindResponse::tree(), EXTENT, true);
        assert_eq!(Material { sway: None, ..drawn }, bark, "bark is drawn as it was, only swaying");
        assert_eq!(drawn.sway.map(|sway| sway.flutter), Some(0.0));

        let blended = Material::color([60, 120, 40, 200]);
        let leaves = swaying(blended, WindResponse::tree(), EXTENT, true);
        assert_eq!((leaves.alpha_cutoff, leaves.double_sided, leaves.base_color[3]), (Some(FOLIAGE_CUTOFF), true, 255), "blended leaves are cut out, two-sided");
        assert_eq!(leaves.subsurface, Some(Subsurface::LEAF));
        assert!(leaves.sway.is_some_and(|sway| sway.flutter > 0.0), "leaves flutter");

        let own = Material::color([60, 120, 40, 255]).with_alpha_cutoff(0.3).with_subsurface(Subsurface::WAX);
        let kept = swaying(own, WindResponse::tree(), EXTENT, true);
        assert_eq!((kept.alpha_cutoff, kept.subsurface), (Some(0.3), Some(Subsurface::WAX)), "a material's own cutoff and subsurface stay");

        let given = swaying(blended, WindResponse::tree(), EXTENT, false);
        assert_eq!(Material { sway: None, ..given }, blended, "a material given to the draw keeps its alpha and faces");
    }
}
