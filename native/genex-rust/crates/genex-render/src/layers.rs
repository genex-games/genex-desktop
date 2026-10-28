//! Layered materials and the extra shading lobes (AAA materials lane, review WP-7 and WP-15): what
//! a [`crate::pbr::Material`] may carry on top of its metallic-roughness maps, written into the
//! extension rows after `tiling` ([`layer_rows`]) and shaded by `shaders/lighting/layers.wgsl`
//! (cover, detail, second layer, parallax) and the lobes in `shaders/pbr.wgsl` (clearcoat, sheen,
//! anisotropy) and the forward pass (transmission).
//!
//! - **Cover** ([`Cover`]): snow, dust, moss or wetness laid on whatever faces up, by the
//!   surface's world-up normal (its normal map included, so snow sits on the up-facing bumps of a
//!   brick), with a world-space noise breaking its edge. It replaces the base colour, roughness and
//!   metallic where it lies and flattens the normal map under it: props get snow by material, never
//!   by slab boxes laid on them (review 3.5).
//! - **Detail** ([`Detail`]): a second, finer-tiled albedo (an overlay around mid-grey) and normal
//!   map, faded out with distance: close-up grain no base map's resolution holds.
//! - **Second layer** ([`MaterialLayer`]): another set of maps blended in by a mask (world noise
//!   or world-up) through both layers' heights (Mishkinis 2013): mortar and moss filling the low
//!   parts of a wall first.
//! - **Parallax** ([`Parallax`]): parallax occlusion mapping of the base layer's height map
//!   (a steep search, then one secant step), so bricks and cobbles look deep at grazing angles.
//! - **Lobes** ([`Lobes`]): `KHR_materials_clearcoat`, `_sheen`, `_anisotropy` and `_transmission`
//!   factors, shaded by every light and the environment.
//!
//! Every part is optional and a material with none of them writes [`LAYER_ROWS_NONE`] and shades
//! exactly as before. Which parts a frame draws is the preset's [`MaterialLayers`] tier: phones
//! and the web keep the cheaper path ([`crate::settings::Quality::material_layers`]).

use crate::texture::{TextureId, TextureKind};

/// Extension-row flag (`params.z`): the material carries a [`Cover`].
pub const MATERIAL_EXT_FLAG_COVER: u32 = 8;
/// Extension-row flag: the material carries a [`Detail`].
pub const MATERIAL_EXT_FLAG_DETAIL: u32 = 16;
/// Extension-row flag: the material carries a [`MaterialLayer`].
pub const MATERIAL_EXT_FLAG_LAYER: u32 = 32;
/// Extension-row flag: the material carries [`Parallax`].
pub const MATERIAL_EXT_FLAG_PARALLAX: u32 = 64;
/// Extension-row flag: the material carries a clearcoat, sheen or anisotropy lobe ([`Lobes`]).
pub const MATERIAL_EXT_FLAG_LOBES: u32 = 128;

/// A texture reference as a layer row holds it: `class * 65536 + layer`, exact in an `f32`.
pub const LAYER_TEXTURE_CLASS_STEP: f32 = 65_536.0;
/// A layer row's missing texture.
pub const LAYER_NO_TEXTURE: f32 = -1.0;

/// The largest parallax depth a row holds, in tiles of the base layer's maps.
pub const PARALLAX_DEPTH_MAX: f32 = 0.25;
/// The fewest steps a parallax search takes.
pub const PARALLAX_STEPS_MIN: u32 = 4;
/// The most steps a parallax search takes.
pub const PARALLAX_STEPS_MAX: u32 = 64;
/// The narrowest softness a cover's slope edge keeps, in cosine units (a step would alias).
pub const COVER_EDGE_MIN: f32 = 0.02;
/// The shortest noise patch a cover or layer mask keeps, in metres.
pub const MASK_METRES_MIN: f32 = 0.02;
/// The longest noise patch a cover or layer mask keeps, in metres.
pub const MASK_METRES_MAX: f32 = 1.0e3;
/// The most a detail map repeats per base tile.
pub const DETAIL_TILES_MAX: f32 = 256.0;

/// What lies on a surface where it faces up: snow, dust, moss or water (review 3.5, WP-7).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cover {
    /// Its colour, linear rgb `0..=1` (unused by wetness, whose `opacity` is 0).
    pub color: [f32; 3],
    /// How much of the surface it covers, `0..=1`: 0 none, 1 every face its slope allows (a noise
    /// still leaves holes where `noise` is high). Weather drives it frame by frame.
    pub amount: f32,
    /// The steepest tilt from flat that still holds it, degrees (0..=180: 90 is a wall, above 90
    /// overhangs too, as wetness runs everywhere).
    pub slope: f32,
    /// How many degrees its edge fades over below `slope`.
    pub softness: f32,
    /// How much a world-space noise breaks it into patches, `0..=1`.
    pub noise: f32,
    /// The noise's patch size, metres.
    pub noise_metres: f32,
    /// The perceptual roughness where it lies.
    pub roughness: f32,
    /// How much it flattens the normal map under it, `0..=1` (snow fills a brick's joints).
    pub flatten: f32,
    /// How much its colour replaces the base colour, `0..=1` (wetness: 0, keeping the colour).
    pub opacity: f32,
    /// How much it darkens the base colour where it lies, `0..=1` (wetness darkens, snow 0).
    pub darken: f32,
}

impl Cover {
    /// Fresh snow: bright, rough, filling the normal map, on anything up to 55° steep.
    pub const SNOW: Cover = Cover {
        color: [0.80, 0.83, 0.88],
        amount: 1.0,
        slope: 55.0,
        softness: 12.0,
        noise: 0.3,
        noise_metres: 0.6,
        roughness: 0.62,
        flatten: 0.85,
        opacity: 1.0,
        darken: 0.0,
    };
    /// Dust and dirt: a warm grey laid thinly on ledges and tops.
    pub const DUST: Cover = Cover {
        color: [0.36, 0.31, 0.25],
        amount: 1.0,
        slope: 60.0,
        softness: 20.0,
        noise: 0.45,
        noise_metres: 0.35,
        roughness: 0.95,
        flatten: 0.3,
        opacity: 0.7,
        darken: 0.0,
    };
    /// Moss: deep green in small clumps, on tops and the upper side of what leans.
    pub const MOSS: Cover = Cover {
        color: [0.07, 0.14, 0.03],
        amount: 1.0,
        slope: 75.0,
        softness: 25.0,
        noise: 0.55,
        noise_metres: 0.25,
        roughness: 0.9,
        flatten: 0.4,
        opacity: 1.0,
        darken: 0.0,
    };
    /// Rain-wet: darker base colour, a near-mirror film, the normal map's grain partly filled, on
    /// every face (walls stay wet too).
    pub const WET: Cover = Cover {
        color: [0.0; 3],
        amount: 1.0,
        slope: 180.0,
        softness: 30.0,
        noise: 0.25,
        noise_metres: 1.5,
        roughness: 0.1,
        flatten: 0.55,
        opacity: 0.0,
        darken: 0.45,
    };

    /// This cover at `amount`, holding on faces up to `slope` degrees from flat, broken by `noise`.
    pub fn shaped(self, amount: f32, slope: f32, noise: f32) -> Cover {
        Cover { amount, slope, noise, ..self }
    }

    /// The three extension rows: colour and amount; the slope edge (cosine and width), roughness
    /// and flatten; noise strength and patch, darken and opacity. Every value finite and in range.
    fn rows(self) -> [[f32; 4]; 3] {
        let slope = unit_or(self.slope / 180.0, 0.0) * 180.0;
        let softness = finite_or(self.softness, 0.0).clamp(0.0, slope);
        let cos_limit = libm::cosf(slope.to_radians());
        let edge = (libm::cosf((slope - softness).to_radians()) - cos_limit).max(COVER_EDGE_MIN);
        let [r, g, b] = self.color.map(|c| unit_or(c, 0.0));
        [
            [r, g, b, unit_or(self.amount, 0.0)],
            [cos_limit, edge, unit_or(self.roughness, 1.0), unit_or(self.flatten, 0.0)],
            [unit_or(self.noise, 0.0), metres(self.noise_metres), unit_or(self.darken, 0.0), unit_or(self.opacity, 1.0)],
        ]
    }
}

/// A finer second albedo and normal map, tiled `tiles` times per base tile (WP-7).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detail {
    /// An sRGB albedo overlay around mid-grey (128 leaves the base colour as it is), or none.
    pub albedo: Option<TextureId>,
    /// A tangent-space normal map added to the base one, or none.
    pub normal: Option<TextureId>,
    /// Repeats per base tile.
    pub tiles: f32,
    /// How strongly the albedo overlay applies, `0..=1`.
    pub albedo_strength: f32,
    /// How strongly the normal map tilts, `0..=2`.
    pub normal_strength: f32,
    /// The distance it has faded out by, metres (0: never fades).
    pub fade_metres: f32,
}

/// What blends a [`MaterialLayer`] in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerMask {
    /// A world-space noise of patches about `metres` across (its [`MaterialLayer::mask_metres`]).
    Noise,
    /// How much the surface faces up (moss on tops, a different stone on the floor).
    Up,
}

impl LayerMask {
    /// The row's code: 0 noise, 1 up (2 and up are kept for a vertex colour's channels).
    fn code(self) -> f32 {
        match self {
            LayerMask::Noise => 0.0,
            LayerMask::Up => 1.0,
        }
    }
}

/// A second set of maps height-blended over the base (WP-7).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MaterialLayer {
    /// Its base colour map (sRGB), or none (its `tint` alone).
    pub base: Option<TextureId>,
    /// Its normal map, or none.
    pub normal: Option<TextureId>,
    /// Its ORM map (red occlusion, green roughness, blue metallic), or none.
    pub orm: Option<TextureId>,
    /// Its height map (red, white high), or none (flat at half height).
    pub height: Option<TextureId>,
    /// Multiplies its base colour, linear rgb.
    pub tint: [f32; 3],
    /// Its roughness factor (times the ORM's green), `0..=1`.
    pub roughness: f32,
    /// Repeats of its maps per base tile.
    pub tiles: f32,
    /// What blends it in.
    pub mask: LayerMask,
    /// The noise mask's patch size, metres.
    pub mask_metres: f32,
    /// How deep the height blend reaches (Mishkinis' depth, `0.01..=1`): small is a crisp line
    /// along the heights, large a soft fade.
    pub blend_depth: f32,
}

/// Parallax occlusion mapping of the base layer's height map (WP-7).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parallax {
    /// The height map (red channel; white is the surface, black the deepest point).
    pub height: TextureId,
    /// How deep black is, in tiles of the base maps (0.02..0.08 for bricks and cobbles).
    pub depth: f32,
    /// The most search steps at a grazing view (fewer face on).
    pub steps: u32,
}

/// The `KHR_materials_*` lobes beyond metallic-roughness (WP-15), factors only.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Lobes {
    /// Clearcoat strength, `0..=1` (car paint, varnish).
    pub clearcoat: f32,
    /// The clearcoat's perceptual roughness.
    pub clearcoat_roughness: f32,
    /// Sheen colour, linear rgb (velvet, cloth); black is none.
    pub sheen_color: [f32; 3],
    /// The sheen's perceptual roughness.
    pub sheen_roughness: f32,
    /// Anisotropy strength, `-1..=1` (brushed metal, hair): positive stretches highlights along
    /// the tangent.
    pub anisotropy: f32,
    /// The anisotropy direction's turn from the tangent, radians.
    pub anisotropy_rotation: f32,
    /// The share of light let straight through, `0..=1` (`KHR_materials_transmission`: glass);
    /// above 0 the material draws blended.
    pub transmission: f32,
}

impl Lobes {
    /// Whether any lobe beyond transmission shades.
    pub fn any(&self) -> bool {
        self.clearcoat > 0.0 || self.sheen_color.iter().any(|c| *c > 0.0) || self.anisotropy != 0.0
    }

    /// Its transmission held to `0..=1` (0 when not finite).
    pub fn transmission(&self) -> f32 {
        unit_or(self.transmission, 0.0)
    }
}

/// Everything layered on one material; each part `None` (or zero lobes) by default.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MaterialLayers {
    /// Snow, dust, moss or wetness on what faces up.
    pub cover: Option<Cover>,
    /// Close-up detail maps.
    pub detail: Option<Detail>,
    /// A second, height-blended layer.
    pub layer: Option<MaterialLayer>,
    /// Parallax occlusion mapping.
    pub parallax: Option<Parallax>,
    /// Clearcoat, sheen, anisotropy and transmission.
    pub lobes: Lobes,
}

/// How many extension rows the layers take after `tiling`.
pub const LAYER_ROW_COUNT: usize = 11;

/// The words of a material's layer key ([`MaterialLayers::key`]): its rows, flags and transmission.
pub(crate) const LAYER_KEY_WORDS: usize = LAYER_ROW_COUNT * 4 + 2;

/// The layer rows of a material with no layers: every texture missing, everything else 0.
pub const LAYER_ROWS_NONE: [[f32; 4]; LAYER_ROW_COUNT] = {
    let none = LAYER_NO_TEXTURE;
    [[0.0; 4], [0.0; 4], [0.0; 4], [none, none, 0.0, 0.0], [0.0; 4], [none; 4], [0.0; 4], [0.0; 4], [none, 0.0, 0.0, 0.0], [0.0; 4], [0.0; 4]]
};

/// Which layered parts a preset draws (WP-7: the web and phones keep a cheaper path); the
/// pipelines' `GX_MATERIAL_LAYERS` constant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LayerTier {
    /// Cover only, without its noise: no extra texture fetch (the low presets).
    #[default]
    Cover,
    /// Cover with its noise, detail maps, the second layer and the lobes.
    Layers,
    /// Everything, parallax occlusion mapping included (desktop high and ultra).
    Parallax,
}

impl LayerTier {
    /// The pipelines' `GX_MATERIAL_LAYERS` constant (0, 1, 2).
    pub fn constant(self) -> f64 {
        match self {
            LayerTier::Cover => 0.0,
            LayerTier::Layers => 1.0,
            LayerTier::Parallax => 2.0,
        }
    }
}

/// `value` if finite, else `fallback`.
fn finite_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value } else { fallback }
}

/// `value` held to `0..=1`, `fallback` when not finite.
fn unit_or(value: f32, fallback: f32) -> f32 {
    finite_or(value, fallback).clamp(0.0, 1.0)
}

/// A noise patch size held to [`MASK_METRES_MIN`]..=[`MASK_METRES_MAX`] (1 when not finite).
fn metres(value: f32) -> f32 {
    finite_or(value, 1.0).clamp(MASK_METRES_MIN, MASK_METRES_MAX)
}

/// A texture's reference as a layer row holds it, when it is in `kind`'s arrays.
fn reference(texture: Option<TextureId>, kind: TextureKind) -> f32 {
    let parts = texture.filter(|t| t.kind().array() == kind).and_then(|t| crate::layout::texture_ref_parts(t.reference()));
    parts.map_or(LAYER_NO_TEXTURE, |(class, layer)| class as f32 * LAYER_TEXTURE_CLASS_STEP + layer as f32)
}

/// A repeat count held to `1/256..=256` (1 when not finite or not positive).
fn tiles(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 { value.clamp(1.0 / DETAIL_TILES_MAX, DETAIL_TILES_MAX) } else { 1.0 }
}

impl MaterialLayers {
    /// The extension rows after `tiling` (`cover`, `cover_shape`, `cover_look`, `detail`,
    /// `detail_look`, `layer`, `layer_shape`, `layer_tint`, `parallax`, `lobes`, `sheen`; see
    /// `GxMaterialExt`) and the flag bits the material's `params.z` gains. With no layers,
    /// [`LAYER_ROWS_NONE`] and no flag. Transmission rides in the `transmission` row's `w`
    /// ([`Lobes::transmission`]).
    pub fn rows(&self) -> ([[f32; 4]; LAYER_ROW_COUNT], u32) {
        let mut rows = LAYER_ROWS_NONE;
        let mut flags = 0;
        if let Some(cover) = self.cover.filter(|c| c.amount.is_finite() && c.amount > 0.0) {
            [rows[0], rows[1], rows[2]] = cover.rows();
            flags |= MATERIAL_EXT_FLAG_COVER;
        }
        if let Some(detail) = self.detail {
            let albedo = reference(detail.albedo, TextureKind::Color);
            let normal = reference(detail.normal, TextureKind::Data);
            if albedo >= 0.0 || normal >= 0.0 {
                rows[3] = [albedo, normal, tiles(detail.tiles), unit_or(detail.albedo_strength, 1.0)];
                rows[4] = [finite_or(detail.normal_strength, 1.0).clamp(0.0, 2.0), finite_or(detail.fade_metres, 0.0).max(0.0), 0.0, 0.0];
                flags |= MATERIAL_EXT_FLAG_DETAIL;
            }
        }
        if let Some(layer) = self.layer {
            rows[5] = [
                reference(layer.base, TextureKind::Color),
                reference(layer.normal, TextureKind::Data),
                reference(layer.orm, TextureKind::Data),
                reference(layer.height, TextureKind::Data),
            ];
            rows[6] = [layer.mask.code(), finite_or(layer.blend_depth, 0.2).clamp(0.01, 1.0), metres(layer.mask_metres), tiles(layer.tiles)];
            let [r, g, b] = layer.tint.map(|c| finite_or(c, 1.0).max(0.0));
            rows[7] = [r, g, b, unit_or(layer.roughness, 1.0)];
            flags |= MATERIAL_EXT_FLAG_LAYER;
        }
        if let Some(parallax) = self.parallax {
            let height = reference(Some(parallax.height), TextureKind::Data);
            let depth = finite_or(parallax.depth, 0.0).clamp(0.0, PARALLAX_DEPTH_MAX);
            if height >= 0.0 && depth > 0.0 {
                rows[8] = [height, depth, parallax.steps.clamp(PARALLAX_STEPS_MIN, PARALLAX_STEPS_MAX) as f32, 0.0];
                flags |= MATERIAL_EXT_FLAG_PARALLAX;
            }
        }
        let lobes = self.lobes;
        if lobes.any() {
            let rotation = finite_or(lobes.anisotropy_rotation, 0.0) % std::f32::consts::TAU;
            rows[9] = [unit_or(lobes.clearcoat, 0.0), unit_or(lobes.clearcoat_roughness, 0.0), finite_or(lobes.anisotropy, 0.0).clamp(-1.0, 1.0), rotation];
            let [r, g, b] = lobes.sheen_color.map(|c| unit_or(c, 0.0));
            rows[10] = [r, g, b, unit_or(lobes.sheen_roughness, 0.0)];
            flags |= MATERIAL_EXT_FLAG_LOBES;
        }
        (rows, flags)
    }

    /// The bits of its rows, for the material-table key.
    pub(crate) fn key(&self) -> [u32; LAYER_KEY_WORDS] {
        let (rows, flags) = self.rows();
        let mut bits = [0; LAYER_KEY_WORDS];
        for (at, value) in rows.iter().flatten().enumerate() {
            bits[at] = value.to_bits();
        }
        bits[LAYER_ROW_COUNT * 4] = flags;
        bits[LAYER_ROW_COUNT * 4 + 1] = self.lobes.transmission().to_bits();
        bits
    }
}
