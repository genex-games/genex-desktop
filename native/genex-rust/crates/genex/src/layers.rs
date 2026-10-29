//! Layered materials and weather (AAA materials lane): what a [`crate::Material`] may carry on top
//! of its maps, and the weather that lays a cover on the world.
//!
//! - [`Cover`]: snow, dust, moss or wetness on whatever faces up, by material
//!   ([`crate::Material::with_cover`]) or on every draw at once ([`crate::Frame::cover_world`]).
//!   Props get snow this way, never from white boxes laid on top of them.
//! - [`Layer`]: a second set of maps height-blended in by a mask ([`crate::Material::with_layer`]).
//! - [`Weather`]: snow, rain or dust falling around the camera in two lit layers with gusts, and
//!   the cover it lays as it falls ([`crate::Frame::weather`]).
//!
//! ```
//! use genex::{Color, Cover, Frame, Material, Transform, Weather};
//!
//! let stone = Material::color(Color::rgb(110, 105, 98)).with_roughness(0.85);
//! let bench = stone.clone().with_cover(Cover::snow(0.9, 50.0, 0.3));
//! let mut frame = Frame::default();
//! frame.cube_with(Transform::IDENTITY, &bench);
//! // Or snow everything the frame draws, from the weather that is falling:
//! let snow = Weather::heavy_snow();
//! frame.weather(&snow, 240.0);
//! ```

use std::sync::Arc;

use crate::Color;
use crate::particles::Particles;
use genex_render::weather::WeatherKind;

pub use genex_render::layers::LayerMask;

/// What lies on a surface where it faces up: snow, dust, moss or water. Its amount (0..1) is how
/// much of what may hold it is covered; its slope the steepest face, in degrees from flat, that
/// still holds it (90 is a wall); its noise (0..1) how much a world-space noise breaks it into
/// patches. The surface's normal map counts, so snow sits on the up-facing bumps of a brick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cover(pub(crate) genex_render::layers::Cover);

impl Cover {
    /// Fresh snow: bright, rough, filling the normal map's grooves. `Cover::snow(1.0, 50.0, 0.3)`
    /// is a full winter cover on everything up to 50° steep; `0.4` a dusting on the flattest tops.
    pub fn snow(amount: f32, slope: f32, noise: f32) -> Cover {
        Cover(genex_render::layers::Cover::SNOW.shaped(amount, slope, noise))
    }

    /// Dust and dirt: a warm grey laid thinly on ledges (`Cover::dust(0.6, 60.0, 0.5)`).
    pub fn dust(amount: f32, slope: f32, noise: f32) -> Cover {
        Cover(genex_render::layers::Cover::DUST.shaped(amount, slope, noise))
    }

    /// Moss in clumps on tops and leaning faces (`Cover::moss(0.7, 75.0, 0.6)`).
    pub fn moss(amount: f32, slope: f32, noise: f32) -> Cover {
        Cover(genex_render::layers::Cover::MOSS.shaped(amount, slope, noise))
    }

    /// Rain-wet: a darker base colour under a near-mirror film. Give it a slope of 180 for every
    /// face (walls stay wet too): `Cover::wet(1.0, 180.0, 0.2)`.
    pub fn wet(amount: f32, slope: f32, noise: f32) -> Cover {
        Cover(genex_render::layers::Cover::WET.shaped(amount, slope, noise))
    }

    /// No cover: on a material, it keeps [`crate::Frame::cover_world`] off that material (a
    /// roofed shelter's inside, a heated pane).
    pub fn none() -> Cover {
        Cover(genex_render::layers::Cover { amount: 0.0, ..genex_render::layers::Cover::SNOW })
    }

    /// This cover in `color` (sRGB): grey slush, red dust, a lighter moss.
    pub fn with_color(self, color: Color) -> Cover {
        let linear = |c: u8| genex_render::texture::srgb_to_linear(c);
        Cover(genex_render::layers::Cover { color: [linear(color.r), linear(color.g), linear(color.b)], ..self.0 })
    }

    /// This cover with another roughness where it lies (0..1).
    pub fn with_roughness(self, roughness: f32) -> Cover {
        Cover(genex_render::layers::Cover { roughness, ..self.0 })
    }

    /// This cover at another amount (0..1): the weather's growing snow.
    pub fn with_amount(self, amount: f32) -> Cover {
        Cover(genex_render::layers::Cover { amount, ..self.0 })
    }

    /// How much of what may hold it is covered (0..1).
    pub fn amount(&self) -> f32 {
        self.0.amount
    }

    /// The renderer's cover.
    pub fn render(&self) -> genex_render::layers::Cover {
        self.0
    }
}

/// A second set of maps blended in over a material's own by a mask, through both layers' heights
/// where they have height maps (mortar first fills the joints, moss the low parts of a stone):
/// [`crate::Material::with_layer`].
#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub(crate) base: Option<Arc<str>>,
    pub(crate) normal: Option<Arc<str>>,
    pub(crate) orm: Option<Arc<str>>,
    pub(crate) height: Option<Arc<str>>,
    pub(crate) tint: Color,
    pub(crate) roughness: f32,
    pub(crate) tiles: f32,
    pub(crate) mask: LayerMask,
    pub(crate) mask_metres: f32,
    pub(crate) blend_depth: f32,
}

impl Layer {
    /// A layer of the game's textures (paths under `assets/`; a missing one is left out): base
    /// colour (sRGB), normal map and ORM (red occlusion, green roughness, blue metallic), repeating
    /// `tiles` times per tile of the material's own maps. Masked by a world noise of 2 m patches
    /// until [`Layer::masked_by`] says otherwise.
    pub fn textured(base: &str, normal: &str, orm: &str, tiles: f32) -> Layer {
        Layer { base: Some(Arc::from(base)), normal: Some(Arc::from(normal)), orm: Some(Arc::from(orm)), tiles, ..Layer::color(Color::WHITE) }
    }

    /// A flat layer of `color` (no maps).
    pub fn color(color: Color) -> Layer {
        Layer {
            base: None,
            normal: None,
            orm: None,
            height: None,
            tint: color,
            roughness: 1.0,
            tiles: 1.0,
            mask: LayerMask::Noise,
            mask_metres: 2.0,
            blend_depth: 0.2,
        }
    }

    /// This layer with a height map (`assets/<path>`, red, white high): the blend follows it.
    pub fn with_height(self, path: &str) -> Layer {
        Layer { height: Some(Arc::from(path)), ..self }
    }

    /// This layer blended in by `mask`: [`LayerMask::Noise`] in patches of `metres`,
    /// [`LayerMask::Up`] where the surface faces up.
    pub fn masked_by(self, mask: LayerMask, metres: f32) -> Layer {
        Layer { mask, mask_metres: metres, ..self }
    }

    /// This layer's colour multiplied in (sRGB; white keeps its texture's).
    pub fn with_tint(self, tint: Color) -> Layer {
        Layer { tint, ..self }
    }

    /// This layer's roughness factor (times its ORM's green).
    pub fn with_roughness(self, roughness: f32) -> Layer {
        Layer { roughness, ..self }
    }

    /// How soft the line between the layers is (0.01 crisp along the heights, 1 a wide fade).
    pub fn with_blend_depth(self, depth: f32) -> Layer {
        Layer { blend_depth: depth, ..self }
    }

    /// The texture paths it names: base colour, normal, ORM, height.
    pub fn textures(&self) -> [Option<&str>; 4] {
        [self.base.as_deref(), self.normal.as_deref(), self.orm.as_deref(), self.height.as_deref()]
    }
}

/// Weather falling around the camera (snow, rain, dust): a near layer of a few metres at a high
/// density and a far layer of tens of metres at a low one, both following the camera, lit by the
/// sun through its shadows and by the sky, varied in size, carried by a wind and its gusts. Draw it
/// each frame with [`crate::Frame::weather`], which also lays its cover as it falls. Densities
/// (particles per m³, near and far): light snow 10 and 0.19, heavy snow 31 and 0.34, blizzard 41
/// and 0.62, rain 12 and 0.38, drizzle 31 and 0.35, dust 4.8 and 0.10.
#[derive(Clone, Debug, PartialEq)]
pub struct Weather {
    kind: WeatherKind,
    layers: [Particles; 2],
}

impl Weather {
    fn of(kind: WeatherKind) -> Weather {
        Weather { kind, layers: kind.layers(1).map(Particles::of) }
    }

    /// Light snow drifting down at 0.8 m/s in a faint breeze; whitens the world over 20 minutes.
    pub fn light_snow() -> Weather {
        Weather::of(WeatherKind::LightSnow)
    }

    /// Heavy snow at 1.1 m/s in a gusting wind; whitens the world over 6 minutes.
    pub fn heavy_snow() -> Weather {
        Weather::of(WeatherKind::HeavySnow)
    }

    /// A blizzard: snow driven 9 m/s across the view in strong gusts; whitens it over 3 minutes.
    /// Pair it with a thick fog.
    pub fn blizzard() -> Weather {
        Weather::of(WeatherKind::Blizzard)
    }

    /// Rain falling 9 m/s, stopped by roofs and the ground; wets every face over 2 minutes.
    pub fn rain() -> Weather {
        Weather::of(WeatherKind::Rain)
    }

    /// Drizzle: fine short streaks at 3.5 m/s; wets every face over 6 minutes.
    pub fn drizzle() -> Weather {
        Weather::of(WeatherKind::Drizzle)
    }

    /// Blowing dust carried 4 m/s by a gusting wind, with slow haze; settles over 30 minutes.
    pub fn dust() -> Weather {
        Weather::of(WeatherKind::Dust)
    }

    /// Which preset it is.
    pub fn kind(&self) -> WeatherKind {
        self.kind
    }

    /// Its near and far layers (drawn by [`crate::Frame::weather`]).
    pub fn layers(&self) -> &[Particles; 2] {
        &self.layers
    }

    /// The cover it has laid after falling `seconds` (none before it starts).
    pub fn cover_after(&self, seconds: f32) -> Option<Cover> {
        self.kind.cover_after(seconds).map(Cover)
    }
}

/// What a facade material layers over its maps, its textures as paths (resolved when drawn).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Layering {
    pub(crate) cover: Option<Cover>,
    pub(crate) detail: Option<DetailMaps>,
    pub(crate) layer: Option<Layer>,
    /// The height map's path and the parallax depth in tiles.
    pub(crate) parallax: Option<(Arc<str>, f32)>,
    pub(crate) lobes: genex_render::layers::Lobes,
}

/// [`crate::Material::with_detail`]'s maps and strengths.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DetailMaps {
    pub(crate) albedo: Option<Arc<str>>,
    pub(crate) normal: Option<Arc<str>>,
    pub(crate) tiles: f32,
    pub(crate) albedo_strength: f32,
    pub(crate) normal_strength: f32,
    pub(crate) fade_metres: f32,
}

impl Layering {
    /// Every texture path it names with whether it is a colour map (else data or a normal map:
    /// `(path, color, normal)`).
    pub(crate) fn textures(&self) -> Vec<(&str, bool, bool)> {
        let mut paths = Vec::new();
        if let Some(detail) = &self.detail {
            paths.extend(detail.albedo.as_deref().map(|p| (p, true, false)));
            paths.extend(detail.normal.as_deref().map(|p| (p, false, true)));
        }
        if let Some(layer) = &self.layer {
            let [base, normal, orm, height] = layer.textures();
            paths.extend(base.map(|p| (p, true, false)));
            paths.extend(normal.map(|p| (p, false, true)));
            paths.extend(orm.map(|p| (p, false, false)));
            paths.extend(height.map(|p| (p, false, false)));
        }
        paths.extend(self.parallax.as_ref().map(|(p, _)| (&**p, false, false)));
        paths
    }
}

/// A path or none for an empty one.
pub(crate) fn path(value: &str) -> Option<Arc<str>> {
    (!value.is_empty()).then(|| Arc::from(value))
}
