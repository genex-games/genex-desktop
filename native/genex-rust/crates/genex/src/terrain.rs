//! Heightmap terrain (renderer pass 2 A.7): a height field a game hands over once and draws every
//! frame with `frame.terrain(&terrain)`. The renderer draws it with continuous levels of detail
//! (CDLOD: finer near the camera, morphed so nothing pops or cracks), casts it into the sun's
//! cascades and shades it per pixel from up to [`TERRAIN_LAYER_MAX`] material layers blended by a
//! control map (one texel per height sample), with hex-tiling against visible repeats on desktop
//! `high` and `ultra`.
//!
//! A terrain is a cheap handle: make it in `on_reset`, keep it in the world, draw it from
//! `on_draw`. [`Terrain::height`] answers the ground's height anywhere (bilinear between samples,
//! the drawn surface's finest level), the same bits on every destination, for placing things and
//! for physics.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use genex_render::terrain::{ControlTexel, Heightfield, MAX_TERRAIN_LAYERS, MAX_TERRAIN_SAMPLES, TerrainLook};

use crate::frame::Color;
use crate::math::{Vec2, Vec3};

/// The most layers a terrain blends.
pub const TERRAIN_LAYER_MAX: usize = MAX_TERRAIN_LAYERS;
/// The most height samples on a side (2048 quads).
pub const TERRAIN_SAMPLES_MAX: u32 = MAX_TERRAIN_SAMPLES;

/// Why a terrain was refused (nothing was made).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainErrorCode {
    /// A sample count, the spacing, the origin or a height is not usable.
    HeightsInvalid,
    /// No layer, more than [`TERRAIN_LAYER_MAX`], or a layer that does not tile.
    LayersInvalid,
    /// A control map of the wrong size, or a texel naming a layer the terrain does not have.
    ControlInvalid,
}

impl TerrainErrorCode {
    /// Every code.
    pub const ALL: [TerrainErrorCode; 3] = [TerrainErrorCode::HeightsInvalid, TerrainErrorCode::LayersInvalid, TerrainErrorCode::ControlInvalid];

    /// The code's wire spelling (`terrain-heights-invalid`, `terrain-layers-invalid`,
    /// `terrain-control-invalid`).
    pub const fn wire(self) -> &'static str {
        match self {
            TerrainErrorCode::HeightsInvalid => "terrain-heights-invalid",
            TerrainErrorCode::LayersInvalid => "terrain-layers-invalid",
            TerrainErrorCode::ControlInvalid => "terrain-control-invalid",
        }
    }
}

/// A refused terrain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerrainError {
    /// What was refused.
    pub code: TerrainErrorCode,
    /// The numbers involved.
    pub detail: String,
}

impl std::fmt::Display for TerrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for TerrainError {}

fn refused(code: TerrainErrorCode, detail: String) -> TerrainError {
    TerrainError { code, detail }
}

/// One material layer: a base colour texture (its alpha the layer's height, for the blend) and a
/// data texture (normal x and y in red and green, roughness in blue, occlusion in alpha), tiled
/// every `tile` metres; or a flat colour.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainLayer {
    pub(crate) albedo: Option<String>,
    pub(crate) data: Option<String>,
    pub(crate) tint: Vec3,
    pub(crate) fallback: Color,
    pub(crate) tile: f32,
    pub(crate) roughness: f32,
    pub(crate) normal_strength: f32,
    pub(crate) grass: Option<Grass>,
}

impl TerrainLayer {
    /// A flat layer of `color`.
    pub fn flat(color: Color) -> TerrainLayer {
        TerrainLayer { albedo: None, data: None, tint: Vec3::ONE, fallback: color, tile: 4.0, roughness: 0.9, normal_strength: 1.0, grass: None }
    }

    /// A layer of the game's textures `albedo` and `data` (paths under `assets/`), one tile every
    /// `tile` metres. Without its base colour texture (not fetched, not in the assets) the layer
    /// draws flat in its fallback colour ([`TerrainLayer::with_fallback`]).
    pub fn textured(albedo: &str, data: &str, tile: f32) -> TerrainLayer {
        TerrainLayer {
            albedo: Some(albedo.to_owned()),
            data: Some(data.to_owned()),
            tint: Vec3::ONE,
            fallback: Color::rgb(128, 128, 120),
            tile,
            roughness: 1.0,
            normal_strength: 1.0,
            grass: None,
        }
    }

    /// This layer's texture colour multiplied by `tint` (linear, each factor may pass 1).
    pub fn with_tint(mut self, tint: Vec3) -> TerrainLayer {
        self.tint = tint;
        self
    }

    /// The colour this layer draws flat in without its base colour texture.
    pub fn with_fallback(mut self, color: Color) -> TerrainLayer {
        self.fallback = color;
        self
    }

    /// This layer's roughness: a flat layer's own, a factor on the data texture's otherwise.
    pub fn with_roughness(mut self, roughness: f32) -> TerrainLayer {
        self.roughness = roughness;
        self
    }

    /// How strongly the data texture's normal bends the ground (1: as stored, 0: flat).
    pub fn with_normal_strength(mut self, strength: f32) -> TerrainLayer {
        self.normal_strength = strength;
        self
    }

    /// This layer with `grass` growing on it (renderer pass 2 A.8): wherever the control map paints
    /// it, blades grow at the grass's density, thinning where the layer blends into another.
    pub fn with_grass(mut self, grass: Grass) -> TerrainLayer {
        self.grass = Some(grass);
        self
    }

    /// The grass growing on this layer, if any.
    pub fn grass(&self) -> Option<&Grass> {
        self.grass.as_ref()
    }

    /// The base colour texture's path, if any.
    pub fn albedo(&self) -> Option<&str> {
        self.albedo.as_deref()
    }

    /// The data texture's path, if any.
    pub fn data(&self) -> Option<&str> {
        self.data.as_deref()
    }

    /// The tint, the fallback colour, the tile, the roughness and the normal strength.
    pub fn look(&self) -> (Vec3, Color, f32, f32, f32) {
        (self.tint, self.fallback, self.tile, self.roughness, self.normal_strength)
    }
}

/// Grass growing on a terrain layer (renderer pass 2 A.8): blades generated on the GPU around the
/// camera, swaying in the shared wind, shadowed by the sun and lit through from behind. Desktop
/// and web `medium` and up draw it (`high` and `ultra` cast its shadows), the high phones at a
/// capped density from `high`; `low` and the low phones draw the layer's ground alone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grass {
    pub(crate) density: f32,
    pub(crate) height: (f32, f32),
    pub(crate) width: (f32, f32),
    pub(crate) root: Color,
    pub(crate) tip: Color,
    pub(crate) dry: (Color, f32),
    pub(crate) flowers: (Color, f32),
    pub(crate) transmission: f32,
}

/// The most blades a square metre of grass grows.
pub const GRASS_DENSITY_MAX: f32 = 150.0;
/// The tallest blade (metres).
pub const GRASS_HEIGHT_MAX: f32 = genex_render::foliage::GRASS_HEIGHT_MAX;

impl Grass {
    /// A meadow of `density` blades a square metre (up to [`GRASS_DENSITY_MAX`]), the tallest
    /// `height` metres (up to [`GRASS_HEIGHT_MAX`]), the shortest a third of that: green with a
    /// dark foot, a fifth of the tips dry, no flowers.
    pub fn meadow(density: f32, height: f32) -> Grass {
        Grass {
            density,
            height: (height * 0.35, height),
            width: (0.02, 0.04),
            root: Color::rgb(44, 63, 29),
            tip: Color::rgb(84, 111, 49),
            dry: (Color::rgb(149, 129, 75), 0.2),
            flowers: (Color::rgb(240, 232, 220), 0.0),
            transmission: 0.6,
        }
    }

    /// The shortest and tallest blade (metres).
    pub fn with_height(mut self, shortest: f32, tallest: f32) -> Grass {
        self.height = (shortest, tallest);
        self
    }

    /// The narrowest and widest blade at its foot (metres, up to 0.2).
    pub fn with_width(mut self, narrowest: f32, widest: f32) -> Grass {
        self.width = (narrowest, widest);
        self
    }

    /// The colours at a blade's foot and at its tip.
    pub fn with_colors(mut self, root: Color, tip: Color) -> Grass {
        self.root = root;
        self.tip = tip;
        self
    }

    /// A `share` (0..1) of the blades with dry tips of `color`.
    pub fn with_dry(mut self, color: Color, share: f32) -> Grass {
        self.dry = (color, share);
        self
    }

    /// A `share` (0..1) of the blades with a flower of `color` on the tip.
    pub fn with_flowers(mut self, color: Color, share: f32) -> Grass {
        self.flowers = (color, share);
        self
    }

    /// How much of the light reaching a blade's back passes through it (0..1; 0.6 by default).
    pub fn with_transmission(mut self, transmission: f32) -> Grass {
        self.transmission = transmission;
        self
    }

    /// The renderer's layer of this grass.
    pub fn render_layer(&self) -> genex_render::foliage::GrassLayer {
        let linear = |c: Color| [c.r, c.g, c.b].map(genex_render::texture::srgb_to_linear);
        genex_render::foliage::GrassLayer {
            density: self.density,
            height: [self.height.0, self.height.1],
            width: [self.width.0, self.width.1],
            root: linear(self.root),
            tip: linear(self.tip),
            dry: linear(self.dry.0),
            dry_share: self.dry.1,
            flower: linear(self.flowers.0),
            flower_share: self.flowers.1,
            transmission: self.transmission,
        }
    }

    /// Whether the renderer can grow it: every number finite and in range.
    fn usable(&self) -> bool {
        self.density <= GRASS_DENSITY_MAX && self.render_layer().usable()
    }
}

/// One control-map texel: a base layer, an overlay layer over it at `amount` (0..1), and how wet
/// the ground is (0..1: darker and glossier).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct TerrainTexel(ControlTexel);

impl TerrainTexel {
    /// Layer `layer` alone.
    pub fn layer(layer: u8) -> TerrainTexel {
        TerrainTexel(ControlTexel::layer(layer))
    }

    /// Layer `base` with `overlay` over it at `amount` (0..1).
    pub fn blend(base: u8, overlay: u8, amount: f32) -> TerrainTexel {
        TerrainTexel(ControlTexel::blend(base, overlay, unit_byte(amount)))
    }

    /// This texel `wetness` (0..1) wet.
    pub fn with_wetness(self, wetness: f32) -> TerrainTexel {
        TerrainTexel(self.0.with_wetness(unit_byte(wetness)))
    }

    /// The renderer's texel.
    pub fn control(self) -> ControlTexel {
        self.0
    }
}

fn unit_byte(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The ground a terrain draws: its heights, its layers, its control map and its look.
#[derive(Clone, Debug, PartialEq)]
struct TerrainInner {
    heights: Heightfield,
    layers: Vec<TerrainLayer>,
    control: Vec<ControlTexel>,
    look: TerrainLook,
    version: u64,
}

/// A heightmap terrain (see the module docs).
#[derive(Clone, Debug)]
pub struct Terrain {
    inner: Arc<TerrainInner>,
}

impl PartialEq for Terrain {
    fn eq(&self, other: &Terrain) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner) || self.inner.version == other.inner.version
    }
}

/// Terrains made so far: each new terrain or change gets the next version.
static VERSIONS: AtomicU64 = AtomicU64::new(1);

fn next_version() -> u64 {
    VERSIONS.fetch_add(1, Ordering::Relaxed)
}

impl Terrain {
    /// A terrain of `samples` heights a side (`heights` row-major, x fastest), sample (0, 0) at
    /// world (`origin.x`, `origin.y`) as x and z, `spacing` metres apart, drawn with one flat grey
    /// layer until [`Terrain::with_layers`]. Refused `terrain-heights-invalid`.
    pub fn from_heights(samples: [u32; 2], origin: Vec2, spacing: f32, heights: &[f32]) -> Result<Terrain, TerrainError> {
        let field = Heightfield::new((samples[0], samples[1]), [origin.x, origin.y], spacing, heights).map_err(|error| refused(TerrainErrorCode::HeightsInvalid, error.to_string()))?;
        Ok(Terrain::of(field))
    }

    /// A terrain of `height(x, z)` at every sample (see [`Terrain::from_heights`]).
    pub fn from_fn(samples: [u32; 2], origin: Vec2, spacing: f32, height: impl Fn(f32, f32) -> f32) -> Result<Terrain, TerrainError> {
        let field = Heightfield::from_fn((samples[0], samples[1]), [origin.x, origin.y], spacing, height).map_err(|error| refused(TerrainErrorCode::HeightsInvalid, error.to_string()))?;
        Ok(Terrain::of(field))
    }

    /// A terrain of `heights` as they are (STR-23's tiles keep their shared quantization).
    pub(crate) fn of(heights: Heightfield) -> Terrain {
        let layers = vec![TerrainLayer::flat(Color::rgb(160, 160, 150))];
        Terrain { inner: Arc::new(TerrainInner { heights, layers, control: Vec::new(), look: TerrainLook::default(), version: next_version() }) }
    }

    fn changed(&self, change: impl FnOnce(&mut TerrainInner)) -> Terrain {
        let mut inner = (*self.inner).clone();
        change(&mut inner);
        inner.version = next_version();
        Terrain { inner: Arc::new(inner) }
    }

    /// This terrain blending `layers` (1 to [`TERRAIN_LAYER_MAX`]); without a control map every
    /// sample is layer 0. Refused `terrain-layers-invalid` (or `terrain-control-invalid` when the
    /// control map names a layer past them).
    pub fn with_layers(&self, layers: Vec<TerrainLayer>) -> Result<Terrain, TerrainError> {
        if layers.is_empty() || layers.len() > TERRAIN_LAYER_MAX {
            return Err(refused(TerrainErrorCode::LayersInvalid, format!("{} layers, 1..={TERRAIN_LAYER_MAX}", layers.len())));
        }
        if let Some(bad) = layers.iter().position(|layer| !(layer.tile.is_finite() && layer.tile > 0.0)) {
            return Err(refused(TerrainErrorCode::LayersInvalid, format!("layer {bad} tiles every {} m", layers[bad].tile)));
        }
        if let Some(bad) = layers.iter().position(|layer| layer.grass.is_some_and(|grass| !grass.usable())) {
            return Err(refused(TerrainErrorCode::LayersInvalid, format!("layer {bad}: grass out of range")));
        }
        check_control(&self.inner.control, layers.len(), self.inner.heights.samples())?;
        Ok(self.changed(|inner| inner.layers = layers))
    }

    /// This terrain with one control texel per height sample (row-major, as the heights).
    /// Refused `terrain-control-invalid` for another count or a texel naming a missing layer.
    pub fn with_control(&self, texels: &[TerrainTexel]) -> Result<Terrain, TerrainError> {
        let control: Vec<ControlTexel> = texels.iter().map(|texel| texel.0).collect();
        check_control(&control, self.inner.layers.len(), self.inner.heights.samples())?;
        Ok(self.changed(|inner| inner.control = control))
    }

    /// This terrain with `look` (macro variation, wetness, the height blend's depth).
    pub fn with_look(&self, look: TerrainLook) -> Terrain {
        self.changed(|inner| inner.look = look)
    }

    /// The ground's height at world (`x`, `z`): bilinear between the samples around it, clamped
    /// onto the terrain.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.inner.heights.height(x, z)
    }

    /// The height field.
    pub fn heights(&self) -> &Heightfield {
        &self.inner.heights
    }

    /// The layers.
    pub fn layers(&self) -> &[TerrainLayer] {
        &self.inner.layers
    }

    /// The control map (empty: layer 0 everywhere).
    pub fn control(&self) -> &[ControlTexel] {
        &self.inner.control
    }

    /// The look.
    pub fn look(&self) -> TerrainLook {
        self.inner.look
    }

    /// This terrain's version: a new one for every terrain made or changed.
    pub fn version(&self) -> u64 {
        self.inner.version
    }

    /// Place `rule`'s instances on this terrain within the world rectangle from `min` to `max` (x,
    /// z), standing on the ground (renderer pass 2 A.8): the same instances in the same places for
    /// any area that covers them, so chunks scattered apart meet exactly. Draw them through an
    /// instance group. A rule out of range or an empty rectangle places nothing.
    pub fn scatter(&self, rule: &Scatter, min: Vec2, max: Vec2) -> Vec<crate::Transform> {
        let desc = genex_render::terrain::TerrainDesc {
            heights: self.inner.heights.clone(),
            control: self.inner.control.clone(),
            layers: self.inner.layers.iter().map(|_| genex_render::terrain::TerrainLayer::flat([0.0; 3])).collect(),
            look: self.inner.look,
        };
        genex_render::foliage::scatter::scatter(&desc, &rule.0, [min.x, min.y], [max.x, max.y]).iter().map(transform_of).collect()
    }
}

/// The transform of a placed instance: its scale, its yaw about +y, +y turned onto its up axis,
/// its position (quaternions built from libm's sine and cosine: the same bits everywhere).
fn transform_of(placed: &genex_render::foliage::scatter::Scattered) -> crate::Transform {
    let half = placed.yaw * 0.5;
    let yaw = crate::math::Quat::from_xyzw(0.0, libm::sinf(half), 0.0, libm::cosf(half));
    let [x, y, z] = placed.up;
    let arc = crate::math::Quat::from_xyzw(z, 0.0, -x, 1.0 + y).normalize();
    crate::Transform { translation: Vec3::from(placed.position), rotation: arc * yaw, scale: Vec3::splat(placed.scale) }
}

/// What [`Terrain::scatter`] places and where (renderer pass 2 A.8): `Scatter::new(density, layers)`
/// instances a square metre (up to 16) on the terrain layers listed, with
/// `.with_scale(smallest, largest)`, `.on_flat_ground(least_normal_y)` (0 any slope, 1 flat only),
/// `.following_ground(share)` (0 upright, 1 leaning with the ground), `.with_seed(seed)` and
/// `.with_cap(most)` (past it the kept ones thin evenly over the area: a phone's cap is a smaller
/// number).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scatter(genex_render::foliage::scatter::ScatterRule);

impl Scatter {
    /// `density` instances a square metre wherever the terrain layers `layers` cover the ground.
    pub fn new(density: f32, layers: &[u8]) -> Scatter {
        let mask = layers.iter().filter(|layer| usize::from(**layer) < TERRAIN_LAYER_MAX).fold(0u16, |mask, layer| mask | (1 << layer));
        Scatter(genex_render::foliage::scatter::ScatterRule::new(density, mask))
    }

    /// Scales from `smallest` to `largest`.
    pub fn with_scale(mut self, smallest: f32, largest: f32) -> Scatter {
        self.0.scale = [smallest, largest];
        self
    }

    /// Only where the ground's normal points up at least this much (its y, 0..1).
    pub fn on_flat_ground(mut self, least_normal_y: f32) -> Scatter {
        self.0.flatness = least_normal_y;
        self
    }

    /// Lean `share` (0..1) of the way from upright to the ground's normal.
    pub fn following_ground(mut self, share: f32) -> Scatter {
        self.0.follow_ground = share;
        self
    }

    /// The rule's seed: rules with different seeds never share places.
    pub fn with_seed(mut self, seed: u32) -> Scatter {
        self.0.seed = seed;
        self
    }

    /// Keep at most `most` instances.
    pub fn with_cap(mut self, most: usize) -> Scatter {
        self.0.cap = most;
        self
    }
}

fn check_control(control: &[ControlTexel], layers: usize, samples: (u32, u32)) -> Result<(), TerrainError> {
    if control.is_empty() {
        return Ok(());
    }
    let expected = samples.0 as usize * samples.1 as usize;
    if control.len() != expected {
        return Err(refused(TerrainErrorCode::ControlInvalid, format!("{} texels for {} x {} samples", control.len(), samples.0, samples.1)));
    }
    if let Some(bad) = control.iter().position(|texel| usize::from(texel.base()) >= layers || usize::from(texel.overlay()) >= layers) {
        return Err(refused(TerrainErrorCode::ControlInvalid, format!("texel {bad} names a layer past the {layers} given")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::vec2;

    #[test]
    fn a_terrain_answers_its_height_and_refuses_what_it_cannot_draw() {
        let terrain = Terrain::from_fn([9, 9], vec2(-4.0, -4.0), 1.0, |x, z| x + 2.0 * z).expect("terrain");
        assert!((terrain.height(0.5, 1.0) - 2.5).abs() < 1e-3);
        assert_eq!(terrain.height(-100.0, -100.0), terrain.height(-4.0, -4.0), "clamped onto the terrain");
        let codes = [
            Terrain::from_heights([1, 9], vec2(0.0, 0.0), 1.0, &[0.0; 9]).map(drop),
            Terrain::from_heights([3, 3], vec2(0.0, 0.0), 1.0, &[f32::NAN; 9]).map(drop),
            terrain.with_layers(Vec::new()).map(drop),
            terrain.with_layers(vec![TerrainLayer::flat(Color::WHITE); TERRAIN_LAYER_MAX + 1]).map(drop),
            terrain.with_layers(vec![TerrainLayer::textured("a.png", "b.png", 0.0)]).map(drop),
            terrain.with_control(&[TerrainTexel::layer(0); 80]).map(drop),
            terrain.with_control(&[TerrainTexel::blend(0, 1, 0.5); 81]).map(drop),
        ]
        .map(|result| result.expect_err("refused").code);
        use TerrainErrorCode::{ControlInvalid, HeightsInvalid, LayersInvalid};
        assert_eq!(codes, [HeightsInvalid, HeightsInvalid, LayersInvalid, LayersInvalid, LayersInvalid, ControlInvalid, ControlInvalid]);
        let two = terrain.with_layers(vec![TerrainLayer::flat(Color::WHITE), TerrainLayer::flat(Color::BLACK)]).expect("two layers");
        let mapped = two.with_control(&[TerrainTexel::blend(0, 1, 0.5).with_wetness(1.0); 81]).expect("a map");
        assert_eq!((mapped.control()[3].blend_weight(), mapped.control()[3].wetness()), (128, 255));
        assert!(mapped.version() > two.version() && two.version() > terrain.version(), "every change is a new version");
        assert!(two.with_layers(vec![TerrainLayer::flat(Color::WHITE)]).is_ok() && mapped.with_layers(vec![TerrainLayer::flat(Color::WHITE)]).is_err(), "the map names layer 1");
    }

    #[test]
    fn a_scatter_stands_on_the_ground_the_same_for_any_area() {
        let terrain = Terrain::from_fn([65, 65], vec2(-32.0, -32.0), 1.0, |x, z| 0.2 * x + 0.05 * z).expect("terrain");
        let rule = Scatter::new(0.5, &[0]).with_scale(0.5, 2.0).following_ground(1.0).with_seed(3);
        let all = terrain.scatter(&rule, vec2(-30.0, -30.0), vec2(30.0, 30.0));
        assert!(all.len() > 1000, "{}", all.len());
        let halves = terrain.scatter(&rule, vec2(-30.0, -30.0), vec2(0.0, 30.0)).len() + terrain.scatter(&rule, vec2(0.0, -30.0), vec2(30.0, 30.0)).len();
        assert_eq!(halves, all.len());
        let up = (crate::math::Vec3::new(-0.2, 1.0, -0.05)).normalize();
        for placed in all.iter().step_by(53) {
            assert!((placed.translation.y - terrain.height(placed.translation.x, placed.translation.z)).abs() < 1e-4);
            assert!((placed.rotation * crate::math::Vec3::Y - up).length() < 1e-3, "leans with the ground");
        }
        assert!(terrain.scatter(&Scatter::new(f32::NAN, &[0]), vec2(-30.0, -30.0), vec2(30.0, 30.0)).is_empty());
        assert!(terrain.scatter(&rule.with_cap(10), vec2(-30.0, -30.0), vec2(30.0, 30.0)).len() == 10);
    }
}
