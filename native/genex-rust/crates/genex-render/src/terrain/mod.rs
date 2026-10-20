//! Heightmap terrain (renderer pass 2 A.7): continuous distance-dependent level of detail (CDLOD,
//! Filip Strugar 2010, `fstrugar/CDLOD`, MIT) over a quantized height field, drawn by a built-in
//! pipeline with its own bind group, and splat materials blended per pixel from a control map
//! (after Terrain3D's index map: ideas, no code) with hex-tiling against visible repeats (Mikkelsen 2022,
//! `mmikk/hextile-demo`, MIT) on desktop `high` and `ultra`.
//!
//! - **The height field** ([`Heightfield`]): a regular grid of samples quantized to 16 bits over its
//!   own height range, at most [`MAX_TERRAIN_SAMPLES`] a side. The GPU reads it from a storage
//!   table (two samples per word) with `textureLoad`-style integer reads and filters by hand, as
//!   WebGPU core cannot filter 32-bit floats; per-texel normals are baked from it once into a
//!   pyramid ([`Heightfield::normal_levels`]) and read per pixel at the pixel's footprint
//!   (trilinear, the lost length folded into roughness), so shading never changes with the level of
//!   detail and far ground does not sparkle.
//! - **Selection** ([`TerrainTree::select`]): a min/max quadtree over the samples; each frame the CPU
//!   picks nodes by their distance from the camera (no atomics, so the drawn set is a pure function
//!   of the camera: the CPU-twin rule), every node one instance of a shared grid of
//!   [`TERRAIN_GRID`]² quads. A node whose child is out of the finer range draws that child's
//!   quarter at its own level ([`TerrainRow::quads`] half the grid), as Strugar draws a partial node.
//! - **Morph** ([`TerrainTree::vertex`], the vertex shader's CPU twin): each odd grid vertex slides
//!   onto its even neighbour as the camera distance crosses the level's morph band, so a node is
//!   exactly its parent's grid when it is replaced (no pop) and every edge it shares with a coarser
//!   node lies on that node's edge (no crack, no T-junction). The ranges are floored at build so a
//!   neighbour is never two levels apart ([`TerrainLod::range0`]).
//! - **Per view**: the selected rows are culled against each view's frustum planes (the camera,
//!   then each drawn cascade, so the terrain casts into the sun's cascades) into one row buffer.
//! - **Materials** ([`TerrainLayer`], [`ControlTexel`]): up to [`MAX_TERRAIN_LAYERS`] layers, each a
//!   base colour (+ height in alpha) and a data texture (normal xy, roughness, occlusion) from the
//!   renderer's material arrays (size classes and the `MaterialSize` rung apply: phones keep 512 px
//!   layers, [`layer_side_max`]), blended per pixel from the four control texels around it by
//!   weight and height (Mishkinis 2013), with a broad macro variation and per-texel wetness.

/// The tile atlas a streamed world's terrain draws from (game systems STR-21).
pub mod atlas;
/// The terrain's GPU resources, pipelines and draws.
pub mod gpu;

use crate::device_class::FormFactor;
use crate::error::{RenderCode, RenderError};
use crate::settings::{Quality, TextureClass};
use crate::texture::TextureId;

/// Quads per side of a node's grid: every node is one instance of this grid (a quarter node
/// draws its first half on each side).
pub const TERRAIN_GRID: u32 = 16;
/// The most samples a height field has on a side (2048 quads: 8 MB of heights, 16 MB of
/// control words and 22 MB of normal pyramid, held in one storage table under WebGPU core's 128
/// MiB binding).
pub const MAX_TERRAIN_SAMPLES: u32 = 2049;
/// The fewest samples on a side.
pub const MIN_TERRAIN_SAMPLES: u32 = 2;
/// The most levels of the normal pyramid (2049 samples a side need 12 to reach 1 x 1).
pub const MAX_NORMAL_LEVELS: usize = 12;
/// The most material layers a terrain blends (five bits of a control word name one; the layer
/// table is a uniform).
pub const MAX_TERRAIN_LAYERS: usize = 16;
/// The most levels of detail (a 2048-quad side at 16 quads a node needs 8).
pub const MAX_TERRAIN_LODS: usize = 12;
/// Where a level's morph starts between the finer range and its own (Strugar's 0.66).
pub const MORPH_START_RATIO: f32 = 0.66;
/// Where a level's morph is complete, as a share of its range: a hair inside it, so a vertex on
/// an edge shared with a coarser node (which lies wholly outside the range) is fully morphed
/// even with the GPU's rounding.
pub const MORPH_END_RATIO: f32 = 0.98;
/// The headroom over the least crack-free range ([`TerrainLod::range0`]).
const RANGE_HEADROOM: f32 = 1.02;
/// The largest layer texture side on a phone (prior art A4.7: 8 layers x 2 arrays at 1024² with
/// mips is about 90 MB uncompressed; phones take 512² layers).
pub const MOBILE_LAYER_SIDE_MAX: u32 = 512;

/// One level of the normal pyramid: its size (texels across, down) and its mean normals.
pub type NormalLevel = ((u32, u32), Vec<[f32; 3]>);

/// One level of the min/max quadtree: nodes across, nodes down, then (min, max) height per node.
type TreeLevel = (u32, u32, Vec<(f32, f32)>);

/// A height field: `samples.0` x `samples.1` heights on a regular grid starting at `origin` (world
/// x, z of sample 0, 0), `spacing` metres apart, quantized to 16 bits over `[min, max]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Heightfield {
    samples: (u32, u32),
    origin: [f32; 2],
    spacing: f32,
    min: f32,
    step: f32,
    heights: Vec<u16>,
}

impl Heightfield {
    /// The height field of `heights` (row-major, x fastest), refused `mesh-invalid` when the
    /// sample count, the spacing or a height is not usable.
    pub fn new(samples: (u32, u32), origin: [f32; 2], spacing: f32, heights: &[f32]) -> Result<Heightfield, RenderError> {
        check_samples(samples)?;
        let usable_spacing = spacing.is_finite() && spacing > 0.0;
        if !usable_spacing || !origin.iter().all(|v| v.is_finite()) {
            return Err(invalid(format!("spacing {spacing} and origin {origin:?} must be finite, the spacing positive")));
        }
        let expected = samples.0 as usize * samples.1 as usize;
        if heights.len() != expected {
            return Err(invalid(format!("{} heights for {} x {} samples", heights.len(), samples.0, samples.1)));
        }
        if let Some(bad) = heights.iter().position(|h| !h.is_finite()) {
            return Err(invalid(format!("height {bad} is not a number")));
        }
        let min = heights.iter().copied().fold(f32::INFINITY, f32::min);
        let max = heights.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let step = if max > min { (max - min) / f32::from(u16::MAX) } else { 0.0 };
        let quantized = heights
            .iter()
            .map(|h| if step > 0.0 { ((h - min) / step).round().clamp(0.0, f32::from(u16::MAX)) as u16 } else { 0 })
            .collect();
        Ok(Heightfield { samples, origin, spacing, min, step, heights: quantized })
    }

    /// The height field of `height(x, z)` sampled at every grid point.
    pub fn from_fn(samples: (u32, u32), origin: [f32; 2], spacing: f32, height: impl Fn(f32, f32) -> f32) -> Result<Heightfield, RenderError> {
        check_samples(samples)?;
        let mut heights = Vec::with_capacity(samples.0 as usize * samples.1 as usize);
        for z in 0..samples.1 {
            for x in 0..samples.0 {
                heights.push(height(origin[0] + x as f32 * spacing, origin[1] + z as f32 * spacing));
            }
        }
        Heightfield::new(samples, origin, spacing, &heights)
    }

    /// Samples per side (x, z).
    pub const fn samples(&self) -> (u32, u32) {
        self.samples
    }

    /// World x, z of sample (0, 0).
    pub const fn origin(&self) -> [f32; 2] {
        self.origin
    }

    /// Metres between samples.
    pub const fn spacing(&self) -> f32 {
        self.spacing
    }

    /// The lowest height and the height of one quantization step.
    pub const fn quantization(&self) -> (f32, f32) {
        (self.min, self.step)
    }

    /// The quantized heights, row-major.
    pub fn quantized(&self) -> &[u16] {
        &self.heights
    }

    /// The height of sample (`x`, `z`), clamped onto the grid (the GPU's `gx_terrain_sample`).
    pub fn sample(&self, x: u32, z: u32) -> f32 {
        let x = x.min(self.samples.0 - 1);
        let z = z.min(self.samples.1 - 1);
        self.min + f32::from(self.heights[(z * self.samples.0 + x) as usize]) * self.step
    }

    /// The height at fractional sample position (`x`, `z`), bilinear between the four samples
    /// around it and clamped onto the grid (`gx_terrain_height`).
    pub fn height_at_texel(&self, x: f32, z: f32) -> f32 {
        let max = [(self.samples.0 - 1) as f32, (self.samples.1 - 1) as f32];
        let x = x.clamp(0.0, max[0]);
        let z = z.clamp(0.0, max[1]);
        let (x0, z0) = (x.floor(), z.floor());
        let (fx, fz) = (x - x0, z - z0);
        let (ix, iz) = (x0 as u32, z0 as u32);
        let h00 = self.sample(ix, iz);
        let h10 = self.sample(ix + 1, iz);
        let h01 = self.sample(ix, iz + 1);
        let h11 = self.sample(ix + 1, iz + 1);
        let near = h00 + (h10 - h00) * fx;
        let far = h01 + (h11 - h01) * fx;
        near + (far - near) * fz
    }

    /// The height at world (`x`, `z`) (bilinear, clamped onto the terrain).
    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.height_at_texel((x - self.origin[0]) / self.spacing, (z - self.origin[1]) / self.spacing)
    }

    /// The unit normal at sample (`x`, `z`) from central differences (one-sided at the border).
    pub fn normal_at(&self, x: u32, z: u32) -> [f32; 3] {
        let (w, d) = self.samples;
        let (xl, xr) = (x.saturating_sub(1), (x + 1).min(w - 1));
        let (zl, zr) = (z.saturating_sub(1), (z + 1).min(d - 1));
        let dx = (self.sample(xr, z) - self.sample(xl, z)) / ((xr - xl).max(1) as f32 * self.spacing);
        let dz = (self.sample(x, zr) - self.sample(x, zl)) / ((zr - zl).max(1) as f32 * self.spacing);
        let n = [-dx, 1.0, -dz];
        let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        [n[0] / length, n[1] / length, n[2] / length]
    }

    /// The normal pyramid: level 0 each sample's unit normal, each level above it the mean of the
    /// (up to) four texels below, left unnormalized: its length is how much the normals under it
    /// agree, which the shader folds into roughness (Toksvig), so a far pixel that covers many
    /// samples shades with their spread instead of sparkling. At most [`MAX_NORMAL_LEVELS`]
    /// levels, the last 1 x 1 or the cap.
    pub fn normal_levels(&self) -> Vec<NormalLevel> {
        let (w, d) = self.samples;
        let mut base = Vec::with_capacity(w as usize * d as usize);
        for z in 0..d {
            for x in 0..w {
                base.push(self.normal_at(x, z));
            }
        }
        let sizes = normal_level_sizes(self.samples);
        let mut levels = vec![((w, d), base)];
        for &(lw, ld) in &sizes[1..] {
            let ((pw, pd), below) = levels.last().expect("level 0");
            let (pw, pd) = (*pw, *pd);
            let mut level = Vec::with_capacity(lw as usize * ld as usize);
            for j in 0..ld {
                for i in 0..lw {
                    let mut sum = [0.0f32; 3];
                    let mut n = 0.0;
                    for (x, z) in [(2 * i, 2 * j), (2 * i + 1, 2 * j), (2 * i, 2 * j + 1), (2 * i + 1, 2 * j + 1)] {
                        if x < pw && z < pd {
                            let v = below[(z * pw + x) as usize];
                            sum = [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]];
                            n += 1.0;
                        }
                    }
                    level.push([sum[0] / n, sum[1] / n, sum[2] / n]);
                }
            }
            levels.push(((lw, ld), level));
        }
        levels
    }

    /// [`Heightfield::normal_levels`] packed as the GPU reads them, level after level, each
    /// vector three 10-bit snorms in a word (x low; [`normal_level_offsets`] gives each level's
    /// first word).
    pub fn packed_normals(&self) -> Vec<u32> {
        self.normal_levels().iter().flat_map(|(_, level)| level.iter().map(|v| pack_normal(*v))).collect()
    }

    /// The quantized heights packed two to a word (sample `i` in the low half of word `i / 2`
    /// when `i` is even), as the GPU table holds them.
    pub fn packed_heights(&self) -> Vec<u32> {
        self.heights.chunks(2).map(|pair| u32::from(pair[0]) | (u32::from(pair.get(1).copied().unwrap_or(0)) << 16)).collect()
    }
}

/// The sizes of the normal pyramid's levels over `samples`: each half the one below (rounded up)
/// until 1 x 1, at most [`MAX_NORMAL_LEVELS`].
pub fn normal_level_sizes(samples: (u32, u32)) -> Vec<(u32, u32)> {
    let mut sizes = vec![samples];
    while sizes.len() < MAX_NORMAL_LEVELS {
        let (w, d) = sizes[sizes.len() - 1];
        if w == 1 && d == 1 {
            break;
        }
        sizes.push((w.div_ceil(2), d.div_ceil(2)));
    }
    sizes
}

/// Each normal pyramid level's first word, relative to level 0's.
pub fn normal_level_offsets(samples: (u32, u32)) -> Vec<u32> {
    let mut at = 0;
    normal_level_sizes(samples)
        .into_iter()
        .map(|(w, d)| {
            let first = at;
            at += w * d;
            first
        })
        .collect()
}

/// `v` (each component in -1..1) as three 10-bit snorms, x in the low bits (`gx_terrain_normal_word`).
pub fn pack_normal(v: [f32; 3]) -> u32 {
    let snorm = |c: f32| ((c.clamp(-1.0, 1.0) * 511.0).round() as i32 & 0x3ff) as u32;
    snorm(v[0]) | (snorm(v[1]) << 10) | (snorm(v[2]) << 20)
}

/// The vector [`pack_normal`] packed into `word`.
pub fn unpack_normal(word: u32) -> [f32; 3] {
    let snorm = |bits: u32| (((bits << 22) as i32) >> 22) as f32 / 511.0;
    [snorm(word & 0x3ff), snorm((word >> 10) & 0x3ff), snorm((word >> 20) & 0x3ff)]
}

fn check_samples(samples: (u32, u32)) -> Result<(), RenderError> {
    let range = MIN_TERRAIN_SAMPLES..=MAX_TERRAIN_SAMPLES;
    if !range.contains(&samples.0) || !range.contains(&samples.1) {
        return Err(invalid(format!("{} x {} samples, each side {MIN_TERRAIN_SAMPLES}..={MAX_TERRAIN_SAMPLES}", samples.0, samples.1)));
    }
    Ok(())
}

fn invalid(detail: String) -> RenderError {
    RenderError::refused(RenderCode::MeshInvalid, format!("terrain: {detail}"))
}

/// One control-map texel (Terrain3D's index map, reduced): a base layer, an overlay layer and the
/// overlay's share, and how wet the ground is. Bits: 0-4 base, 5-9 overlay, 10-17 blend, 18-25
/// wetness; 26-31 are reserved (0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ControlTexel(u32);

impl ControlTexel {
    /// Layer `base` alone.
    pub const fn layer(base: u8) -> ControlTexel {
        ControlTexel::blend(base, base, 0)
    }

    /// Layer `base` with `overlay` over it at `blend` / 255.
    pub const fn blend(base: u8, overlay: u8, blend: u8) -> ControlTexel {
        ControlTexel((base as u32 & 31) | ((overlay as u32 & 31) << 5) | ((blend as u32) << 10))
    }

    /// This texel `wetness` / 255 wet (darker and glossier: a shore, a puddle).
    pub const fn with_wetness(self, wetness: u8) -> ControlTexel {
        ControlTexel((self.0 & !(0xff << 18)) | ((wetness as u32) << 18))
    }

    /// The base layer.
    pub const fn base(self) -> u8 {
        (self.0 & 31) as u8
    }

    /// The overlay layer.
    pub const fn overlay(self) -> u8 {
        ((self.0 >> 5) & 31) as u8
    }

    /// The overlay's share, 0..=255.
    pub const fn blend_weight(self) -> u8 {
        ((self.0 >> 10) & 0xff) as u8
    }

    /// The wetness, 0..=255.
    pub const fn wetness(self) -> u8 {
        ((self.0 >> 18) & 0xff) as u8
    }

    /// The word the GPU reads.
    pub const fn bits(self) -> u32 {
        self.0
    }
}

/// One material layer: a base colour texture (sRGB, the layer's height in alpha) and a data
/// texture (normal x and y, roughness, occlusion), either missing (a flat layer: the tint, the
/// roughness, a flat normal), tiled every `tile` metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainLayer {
    /// The base colour (rgb) and height (a) texture.
    pub albedo: Option<TextureId>,
    /// The normal (rg), roughness (b) and occlusion (a) texture.
    pub data: Option<TextureId>,
    /// Multiplies the base colour (linear).
    pub tint: [f32; 3],
    /// Metres one tile of the textures covers.
    pub tile: f32,
    /// The perceptual roughness without a data texture, and the factor on its texel with one.
    pub roughness: f32,
    /// The normal map's strength (0: flat).
    pub normal_strength: f32,
    /// The grass growing on this layer (renderer pass 2 A.8, [`crate::foliage`]; None: bare).
    pub grass: Option<crate::foliage::GrassLayer>,
}

impl TerrainLayer {
    /// A flat layer of linear colour `tint`.
    pub const fn flat(tint: [f32; 3]) -> TerrainLayer {
        TerrainLayer { albedo: None, data: None, tint, tile: 4.0, roughness: 0.9, normal_strength: 1.0, grass: None }
    }

    /// A textured layer tiled every `tile` metres.
    pub const fn textured(albedo: Option<TextureId>, data: Option<TextureId>, tile: f32) -> TerrainLayer {
        TerrainLayer { albedo, data, tint: [1.0; 3], tile, roughness: 1.0, normal_strength: 1.0, grass: None }
    }

    /// This layer with `grass` growing on it.
    pub const fn with_grass(mut self, grass: crate::foliage::GrassLayer) -> TerrainLayer {
        self.grass = Some(grass);
        self
    }
}

/// The look shared by every layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainLook {
    /// How far the broad brightness variation swings the base colour (0: none).
    pub macro_variation: f32,
    /// The variation's feature size in metres.
    pub macro_scale: f32,
    /// How much a fully wet texel darkens its base colour (0..1).
    pub wet_darkening: f32,
    /// The roughness a fully wet texel shades with.
    pub wet_roughness: f32,
    /// How deep the height blend reaches (Mishkinis' depth): a layer whose height plus weight is
    /// this far below the highest is hidden.
    pub blend_depth: f32,
}

impl Default for TerrainLook {
    fn default() -> TerrainLook {
        TerrainLook { macro_variation: 0.18, macro_scale: 24.0, wet_darkening: 0.45, wet_roughness: 0.3, blend_depth: 0.18 }
    }
}

/// A terrain to draw: its height field, its control map (one texel per sample; empty: every
/// sample layer 0), its layers and its look.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainDesc {
    /// The heights.
    pub heights: Heightfield,
    /// One control texel per sample, row-major, or none.
    pub control: Vec<ControlTexel>,
    /// The material layers (at least one).
    pub layers: Vec<TerrainLayer>,
    /// The shared look.
    pub look: TerrainLook,
}

impl TerrainDesc {
    /// A terrain of `heights` with one `layer` everywhere.
    pub fn new(heights: Heightfield, layer: TerrainLayer) -> TerrainDesc {
        TerrainDesc { heights, control: Vec::new(), layers: vec![layer], look: TerrainLook::default() }
    }

    /// Refuse a control map of the wrong size, a texel naming a missing layer, too many or no
    /// layers, a layer that does not tile or grass out of range (`mesh-invalid`).
    pub fn check(&self) -> Result<(), RenderError> {
        let (w, d) = self.heights.samples();
        if self.layers.is_empty() || self.layers.len() > MAX_TERRAIN_LAYERS {
            return Err(invalid(format!("{} layers, 1..={MAX_TERRAIN_LAYERS}", self.layers.len())));
        }
        if let Some(bad) = self.layers.iter().position(|layer| !(layer.tile.is_finite() && layer.tile > 0.0)) {
            return Err(invalid(format!("layer {bad} tiles every {} m", self.layers[bad].tile)));
        }
        if !self.control.is_empty() && self.control.len() != w as usize * d as usize {
            return Err(invalid(format!("{} control texels for {w} x {d} samples", self.control.len())));
        }
        let layers = self.layers.len() as u8;
        if let Some(bad) = self.control.iter().position(|texel| texel.base() >= layers || texel.overlay() >= layers) {
            return Err(invalid(format!("control texel {bad} names a layer past the {layers} given")));
        }
        crate::foliage::check(self)
    }

    /// The control words the GPU reads (layer 0 everywhere without a map).
    pub fn control_words(&self) -> Vec<u32> {
        let (w, d) = self.heights.samples();
        if self.control.is_empty() {
            return vec![0; w as usize * d as usize];
        }
        self.control.iter().map(|texel| texel.bits()).collect()
    }
}

/// The largest layer texture side on a device of `form` (phones keep 512 px layers).
pub const fn layer_side_max(form: FormFactor) -> u32 {
    match form {
        FormFactor::Mobile => MOBILE_LAYER_SIDE_MAX,
        _ => TextureClass::S2048.side(),
    }
}

/// How a quality draws the terrain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainQuality {
    /// How far lod 0 reaches as a multiple of the least crack-free range (1 the least).
    pub detail: f32,
    /// Hex-tiling of the layers (three taps per texture): desktop `high` and `ultra`.
    pub detile: bool,
}

impl TerrainQuality {
    /// What `quality` gives the terrain: hex-tiling where the material textures reach the 2048
    /// class (desktop `high` and `ultra`, `texture::preset_textures`), a longer finest level there
    /// too; elsewhere the least crack-free ranges.
    pub fn of(quality: &Quality) -> TerrainQuality {
        let top = quality.textures.max_class == TextureClass::S2048;
        TerrainQuality { detail: if top { 1.25 } else { 1.0 }, detile: top }
    }
}

/// The levels of detail of one terrain under one quality: each level's range (distance from
/// the camera its nodes reach) and morph band.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainLod {
    /// Levels (level `lods - 1` is the top, whose nodes are always selected).
    pub lods: u32,
    /// Each level's range in metres; the top's is infinite.
    pub ranges: [f32; MAX_TERRAIN_LODS],
}

impl TerrainLod {
    /// The least crack-free lod-0 range of `tree`, times `detail` (at least 1): every node box
    /// of level `l` is shorter than `MORPH_START_RATIO` of range `l - 1`, so a node is never next
    /// to one two levels coarser and a coarser neighbour's own morph has not started on their
    /// shared edge.
    pub fn new(tree: &TerrainTree, detail: f32) -> TerrainLod {
        let least = TerrainLod::range0(tree);
        let range0 = least * detail.max(1.0);
        let mut ranges = [f32::INFINITY; MAX_TERRAIN_LODS];
        for (l, range) in ranges.iter_mut().enumerate().take(tree.lods() as usize - 1) {
            *range = range0 * (1u32 << l) as f32;
        }
        TerrainLod { lods: tree.lods(), ranges }
    }

    /// The least crack-free lod-0 range of `tree` (see [`TerrainLod::new`]). A level-`l` node box
    /// reaches at most its diagonal past range `l - 1`, where a node of level `l - 1` can still
    /// sit beside it; level `l`'s own morph starts `(2 MORPH_END_RATIO - 1) MORPH_START_RATIO` of
    /// range `l - 1` past that range, so the diagonal must stay under it.
    pub fn range0(tree: &TerrainTree) -> f32 {
        let unmorphed = (2.0 * MORPH_END_RATIO - 1.0) * MORPH_START_RATIO;
        let mut least = TERRAIN_GRID as f32 * tree.spacing;
        for l in 1..tree.lods() {
            let diagonal = tree.largest_diagonal(l);
            least = least.max(diagonal / (unmorphed * (1u32 << (l - 1)) as f32));
        }
        least * RANGE_HEADROOM
    }

    /// Level `lod`'s morph band (start, end) in metres: from [`MORPH_START_RATIO`] of the way
    /// between the finer range and its own, complete at [`MORPH_END_RATIO`] of its own.
    pub fn morph(&self, lod: u32) -> (f32, f32) {
        let range = self.ranges[lod as usize];
        if !range.is_finite() {
            return (f32::INFINITY, f32::INFINITY);
        }
        let finer = if lod == 0 { 0.0 } else { self.ranges[lod as usize - 1] };
        let end = range * MORPH_END_RATIO;
        (finer + (end - finer) * MORPH_START_RATIO, end)
    }

    /// The morph's two constants the vertex shader reads per level (Strugar's `morphConsts`):
    /// `k = 1 - clamp(c.x - distance * c.y, 0, 1)`; (1, 0) never morphs (the top level).
    pub fn morph_constants(&self, lod: u32) -> [f32; 2] {
        let (start, end) = self.morph(lod);
        if !end.is_finite() {
            return [1.0, 0.0];
        }
        let span = (end - start).max(1e-4);
        [end / span, 1.0 / span]
    }

    /// The morph of a vertex `distance` metres from the camera on a level-`lod` node (the CPU
    /// twin of `gx_terrain_morph_k`).
    pub fn morph_k(&self, lod: u32, distance: f32) -> f32 {
        let c = self.morph_constants(lod);
        1.0 - (c[0] - distance * c[1]).clamp(0.0, 1.0)
    }
}

/// One drawn node: its first sample, its level and the quads it draws a side ([`TERRAIN_GRID`],
/// or half of it for a quarter of a node drawn at its parent's level).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TerrainRow {
    /// The sample (x, z) its grid starts at.
    pub texel: [u32; 2],
    /// Its level of detail (a quad covers `2^lod` samples a side).
    pub lod: u32,
    /// Quads a side.
    pub quads: u32,
}

impl TerrainRow {
    /// Samples a side it covers.
    pub const fn span(self) -> u32 {
        self.quads << self.lod
    }

    /// The GPU row (`GxTerrainRow`).
    pub const fn gpu(self) -> [u32; 4] {
        [self.texel[0], self.texel[1], self.lod, self.quads]
    }
}

/// A node box: world min and max corners.
pub type TerrainBox = ([f32; 3], [f32; 3]);

/// The min/max quadtree over a height field: level 0's nodes are [`TERRAIN_GRID`] quads a side,
/// each level's twice its children's; the top level's nodes tile the terrain.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainTree {
    samples: (u32, u32),
    origin: [f32; 2],
    spacing: f32,
    /// Per level: nodes across, nodes down, then (min, max) height per node, row-major.
    levels: Vec<TreeLevel>,
}

impl TerrainTree {
    /// The tree over `heights`.
    pub fn new(heights: &Heightfield) -> TerrainTree {
        let (w, d) = heights.samples();
        let quads = (w - 1).max(d - 1);
        let mut lods = 1;
        while (TERRAIN_GRID << (lods - 1)) < quads && (lods as usize) < MAX_TERRAIN_LODS {
            lods += 1;
        }
        let mut levels = Vec::with_capacity(lods as usize);
        let nodes = |span: u32, samples: u32| (samples - 1).div_ceil(span).max(1);
        // Level 0 from the samples: a node covers its quads' samples, edges included.
        let (nx, nz) = (nodes(TERRAIN_GRID, w), nodes(TERRAIN_GRID, d));
        let mut leaf = Vec::with_capacity((nx * nz) as usize);
        for j in 0..nz {
            for i in 0..nx {
                let (x0, z0) = (i * TERRAIN_GRID, j * TERRAIN_GRID);
                let (x1, z1) = ((x0 + TERRAIN_GRID).min(w - 1), (z0 + TERRAIN_GRID).min(d - 1));
                let mut range = (f32::INFINITY, f32::NEG_INFINITY);
                for z in z0..=z1 {
                    for x in x0..=x1 {
                        let h = heights.sample(x, z);
                        range = (range.0.min(h), range.1.max(h));
                    }
                }
                leaf.push(range);
            }
        }
        levels.push((nx, nz, leaf));
        for l in 1..lods {
            let span = TERRAIN_GRID << l;
            let (nx, nz) = (nodes(span, w), nodes(span, d));
            let (cx, cz, children) = &levels[l as usize - 1];
            let mut level = Vec::with_capacity((nx * nz) as usize);
            for j in 0..nz {
                for i in 0..nx {
                    let mut range = (f32::INFINITY, f32::NEG_INFINITY);
                    for (ci, cj) in [(2 * i, 2 * j), (2 * i + 1, 2 * j), (2 * i, 2 * j + 1), (2 * i + 1, 2 * j + 1)] {
                        if ci < *cx && cj < *cz {
                            let child = children[(cj * cx + ci) as usize];
                            range = (range.0.min(child.0), range.1.max(child.1));
                        }
                    }
                    level.push(range);
                }
            }
            levels.push((nx, nz, level));
        }
        TerrainTree { samples: (w, d), origin: heights.origin(), spacing: heights.spacing(), levels }
    }

    /// Levels of detail.
    pub fn lods(&self) -> u32 {
        self.levels.len() as u32
    }

    /// The box of node (`i`, `j`) of level `lod`, or None past the terrain.
    pub fn node_box(&self, lod: u32, i: u32, j: u32) -> Option<TerrainBox> {
        let (nx, nz, ranges) = self.levels.get(lod as usize)?;
        if i >= *nx || j >= *nz {
            return None;
        }
        let (lo, hi) = ranges[(j * nx + i) as usize];
        let span = TERRAIN_GRID << lod;
        let x0 = i * span;
        let z0 = j * span;
        let x1 = (x0 + span).min(self.samples.0 - 1);
        let z1 = (z0 + span).min(self.samples.1 - 1);
        let world = |x: u32, z: u32| [self.origin[0] + x as f32 * self.spacing, self.origin[1] + z as f32 * self.spacing];
        let (a, b) = (world(x0, z0), world(x1, z1));
        Some(([a[0], lo, a[1]], [b[0], hi, b[1]]))
    }

    /// The longest box diagonal of level `lod`.
    fn largest_diagonal(&self, lod: u32) -> f32 {
        let (nx, nz, _) = &self.levels[lod as usize];
        let mut largest = 0.0_f32;
        for j in 0..*nz {
            for i in 0..*nx {
                if let Some((lo, hi)) = self.node_box(lod, i, j) {
                    let d = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                    largest = largest.max((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt());
                }
            }
        }
        largest
    }

    /// The nodes drawn for a camera at `camera` (CDLOD's selection without a frustum: every view
    /// culls the result itself, so the cascades see the casters behind the camera too), full
    /// nodes first in tree order, then quarters.
    pub fn select(&self, lod: &TerrainLod, camera: [f32; 3]) -> Vec<TerrainRow> {
        let mut rows = Vec::new();
        let top = self.lods() - 1;
        let (nx, nz, _) = &self.levels[top as usize];
        for j in 0..*nz {
            for i in 0..*nx {
                self.select_node(lod, camera, top, i, j, &mut rows);
            }
        }
        // Full nodes first, then the quarters: two draws per view.
        rows.sort_by_key(|row| (row.quads != TERRAIN_GRID, row.lod, row.texel[1], row.texel[0]));
        rows
    }

    /// Strugar's `LODSelect` for node (`i`, `j`) of level `l`: false when it is out of its own
    /// range (its parent draws its area at the parent's level instead).
    fn select_node(&self, lod: &TerrainLod, camera: [f32; 3], l: u32, i: u32, j: u32, rows: &mut Vec<TerrainRow>) -> bool {
        let Some(node) = self.node_box(l, i, j) else { return true };
        let top = l + 1 == self.lods();
        if !top && !sphere_touches(node, camera, lod.ranges[l as usize]) {
            return false;
        }
        let span = TERRAIN_GRID << l;
        let whole = TerrainRow { texel: [i * span, j * span], lod: l, quads: TERRAIN_GRID };
        if l == 0 || !sphere_touches(node, camera, lod.ranges[l as usize - 1]) {
            rows.push(whole);
            return true;
        }
        let half = span / 2;
        for (ci, cj) in [(2 * i, 2 * j), (2 * i + 1, 2 * j), (2 * i, 2 * j + 1), (2 * i + 1, 2 * j + 1)] {
            if self.node_box(l - 1, ci, cj).is_none() {
                continue;
            }
            if !self.select_node(lod, camera, l - 1, ci, cj, rows) {
                rows.push(TerrainRow { texel: [ci * half, cj * half], lod: l, quads: TERRAIN_GRID / 2 });
            }
        }
        true
    }

    /// The box of a drawn row (its own area's min and max heights).
    pub fn row_box(&self, row: TerrainRow) -> TerrainBox {
        let node_lod = if row.quads == TERRAIN_GRID { row.lod } else { row.lod - 1 };
        let span = TERRAIN_GRID << node_lod;
        self.node_box(node_lod, row.texel[0] / span, row.texel[1] / span).unwrap_or(([0.0; 3], [0.0; 3]))
    }

    /// Grid vertex (`gx`, `gz`) of `row` for a camera at `camera`, morphed (the vertex shader's
    /// CPU twin, `gx_terrain_vertex`): its sample, its distance to the camera, the odd indices slid
    /// onto their even neighbours by the level's morph, the height read again where it lands.
    pub fn vertex(&self, heights: &Heightfield, lod: &TerrainLod, row: TerrainRow, gx: u32, gz: u32, camera: [f32; 3]) -> [f32; 3] {
        let step = 1u32 << row.lod;
        let max = [self.samples.0 - 1, self.samples.1 - 1];
        let texel = [(row.texel[0] + gx * step).min(max[0]), (row.texel[1] + gz * step).min(max[1])];
        let unmorphed = [self.origin[0] + texel[0] as f32 * self.spacing, heights.sample(texel[0], texel[1]), self.origin[1] + texel[1] as f32 * self.spacing];
        let d = [unmorphed[0] - camera[0], unmorphed[1] - camera[1], unmorphed[2] - camera[2]];
        let k = lod.morph_k(row.lod, (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt());
        let slide = |index: u32, at: u32, last: u32| {
            let odd = (index & 1) as f32;
            ((row.texel_at(index, step, at) as f32) - odd * step as f32 * k).min(last as f32)
        };
        let mx = slide(gx, row.texel[0], max[0]);
        let mz = slide(gz, row.texel[1], max[1]);
        [self.origin[0] + mx * self.spacing, heights.height_at_texel(mx, mz), self.origin[1] + mz * self.spacing]
    }
}

impl TerrainRow {
    /// The sample of grid index `index` along an axis starting at `at`, `step` samples a quad
    /// (unclamped: the morph slides it before the clamp onto the grid).
    const fn texel_at(self, index: u32, step: u32, at: u32) -> u32 {
        at + index * step
    }
}

/// Whether box `b` touches the sphere of `radius` around `p` (an infinite radius always does).
pub fn sphere_touches(b: TerrainBox, p: [f32; 3], radius: f32) -> bool {
    !radius.is_finite() || box_distance(b, p) <= radius * radius
}

/// The squared distance from `p` to box `b` (0 inside it).
pub fn box_distance(b: TerrainBox, p: [f32; 3]) -> f32 {
    p.iter().zip(b.0.iter().zip(&b.1)).map(|(v, (lo, hi))| (v.clamp(*lo, *hi) - v) * (v.clamp(*lo, *hi) - v)).sum()
}

/// Whether box `b` is inside or crosses the frustum of inward `planes` (a zero plane, past a
/// view's active ones, passes everything).
pub fn box_in_planes(b: TerrainBox, planes: &[[f32; 4]; 6]) -> bool {
    planes.iter().all(|plane| {
        let corner = [
            if plane[0] >= 0.0 { b.1[0] } else { b.0[0] },
            if plane[1] >= 0.0 { b.1[1] } else { b.0[1] },
            if plane[2] >= 0.0 { b.1[2] } else { b.0[2] },
        ];
        plane[0] * corner[0] + plane[1] * corner[1] + plane[2] * corner[2] + plane[3] >= 0.0
    })
}

/// One frame's rows per view: the camera's, then each drawn cascade's, each view's full rows then
/// its quarters (each run nearest the camera first), and where each view's two runs start in the
/// row table.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TerrainFrame {
    /// Every view's rows, back to back.
    pub rows: Vec<TerrainRow>,
    /// Per view: (first full row, full rows, first quarter row, quarter rows).
    pub views: Vec<[u32; 4]>,
    /// Rows selected before any view's cull.
    pub selected: u32,
}

impl TerrainFrame {
    /// The rows `tree` selects for `camera`, culled by each of `views` (inward frustum planes).
    pub fn plan(tree: &TerrainTree, lod: &TerrainLod, camera: [f32; 3], views: &[[[f32; 4]; 6]]) -> TerrainFrame {
        let mut selected = tree.select(lod, camera);
        // Nearest first within each draw (full nodes, then quarters): the depth test rejects the
        // ground behind a hill before it is shaded where no prepass laid the depth down.
        let distance = |row: &TerrainRow| box_distance(tree.row_box(*row), camera);
        selected.sort_by(|a, b| (a.quads != TERRAIN_GRID).cmp(&(b.quads != TERRAIN_GRID)).then(distance(a).total_cmp(&distance(b))).then(a.cmp(b)));
        let boxes: Vec<TerrainBox> = selected.iter().map(|row| tree.row_box(*row)).collect();
        let mut frame = TerrainFrame { selected: selected.len() as u32, ..TerrainFrame::default() };
        for planes in views {
            let first = frame.rows.len() as u32;
            let mut full = 0;
            for (row, b) in selected.iter().zip(&boxes).filter(|(row, _)| row.quads == TERRAIN_GRID) {
                if box_in_planes(*b, planes) {
                    frame.rows.push(*row);
                    full += 1;
                }
            }
            let quarters_first = frame.rows.len() as u32;
            let mut quarters = 0;
            for (row, b) in selected.iter().zip(&boxes).filter(|(row, _)| row.quads != TERRAIN_GRID) {
                if box_in_planes(*b, planes) {
                    frame.rows.push(*row);
                    quarters += 1;
                }
            }
            frame.views.push([first, full, quarters_first, quarters]);
        }
        frame
    }
}

/// The grid's triangle list for `quads` quads a side over a vertex grid [`TERRAIN_GRID`] + 1
/// wide (vertex `x + z * (TERRAIN_GRID + 1)`): two triangles a quad, counter-clockwise seen from
/// above (+y), every quad split along the same diagonal, so a fully morphed node is its parent's
/// grid exactly.
pub fn grid_indices(quads: u32) -> Vec<u32> {
    let width = TERRAIN_GRID + 1;
    let mut indices = Vec::with_capacity((quads * quads * 6) as usize);
    for z in 0..quads {
        for x in 0..quads {
            let a = x + z * width;
            let b = a + 1;
            let c = a + width;
            let d = c + 1;
            // Seen from +y with x right and z down the screen, (a, c, d) and (a, d, b) wind
            // counter-clockwise; both share the a-d diagonal.
            indices.extend_from_slice(&[a, c, d, a, d, b]);
        }
    }
    indices
}

/// The budget ledger's label for the terrain's buffers ([`crate::budget::BudgetKind::Buffers`]).
pub const TERRAIN_LEDGER_LABEL: &str = "terrain";
