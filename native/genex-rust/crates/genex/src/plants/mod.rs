//! Procedural plants (vegetation lane, WP-6): `gfx.plant(&PlantSpec::new(Species::Birch,
//! Season::Winter).seed(7))` grows a tree, shrub or grass clump on the CPU in `on_reset` and hands
//! back a [`Model`] ready to draw, instance and scatter:
//!
//! - **Branches** from a parametric L-system after Weber and Penn (spiral, whorled or planar
//!   children; crown shapes; curvature; attraction up or down), meshed as smooth tapered tubes
//!   with a root flare, buttress lobes and branch collars.
//! - **Bark PBR**: tileable albedo, normal and ORM painted per species (a birch's white paper with
//!   lenticels and black patches, an oak's furrows, a pine's orange plates, a spruce's scales).
//! - **Alpha cards**: a 2 × 2 atlas of twigs with leaves, bare winter twigs (a birch's catkins),
//!   conifer sprays, palm fronds or grass blades, with a normal map, cut out and two-sided, lit
//!   through as a leaf (`KHR_materials_diffuse_transmission`, the facade's `Subsurface::LEAF`).
//! - **Levels**: three mesh levels (stems dropped, rings thinned, cards thinned and grown) and a
//!   hemi-octahedral impostor past them; the renderer crossfades between them.
//! - **Wind**: the model sways by [`WindResponse::tree`], `shrub` or `grass` (`Model::with_wind`).
//!
//! A spec grows the same bytes on every destination (integer hashes, libm, IEEE arithmetic, no
//! clock), so a seed is a plant everywhere, the web included. The same GLBs leave through
//! [`plant_glb`] for a file under `assets/` (Studio's import step then compresses its maps), and
//! the handle is one a game may still give its own levels, bias or material. The sim never sees a
//! plant's look; read its triangles with `gfx.assets().triangles(&model)` for a collider.

mod geometry;
mod glb;
mod grow;
mod png;
mod species;
mod texture;

use std::cell::RefCell;
use std::rc::Rc;

use crate::foliage::WindResponse;
use crate::gfx::Model;
use crate::lod::Impostor;

use geometry::{DETAILS, Part};
use glb::{Maps, Surface};
use species::{Form, Preset};

/// The plants a game can grow. Wire spellings (`wire`): never rename one.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Species {
    /// Silver birch: a slender white trunk, a light crown of hanging twigs.
    Birch,
    /// Norway spruce: a dark cone of whorled, drooping branches to the ground.
    Spruce,
    /// Scots pine: a tall bare orange trunk under an umbrella of upturned branches.
    Pine,
    /// English oak: a thick, flared, gnarled trunk and a broad rounded crown.
    Oak,
    /// Norway maple: a dense round crown of palmate leaves.
    Maple,
    /// White willow: a leaning furrowed trunk and long hanging strands.
    Willow,
    /// A fan of fronds on a curved, ringed stem.
    Palm,
    /// A many-stemmed bush.
    Shrub,
    /// A clump of grass blades (ground cover).
    Grass,
}

impl Species {
    /// Every species, in declaration order.
    pub const ALL: [Species; 9] = [Species::Birch, Species::Spruce, Species::Pine, Species::Oak, Species::Maple, Species::Willow, Species::Palm, Species::Shrub, Species::Grass];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Species::Birch => "birch",
            Species::Spruce => "spruce",
            Species::Pine => "pine",
            Species::Oak => "oak",
            Species::Maple => "maple",
            Species::Willow => "willow",
            Species::Palm => "palm",
            Species::Shrub => "shrub",
            Species::Grass => "grass",
        }
    }

    /// How a plant of this species bends in the wind.
    pub const fn wind(self) -> WindResponse {
        match self {
            Species::Shrub => WindResponse::shrub(),
            Species::Grass => WindResponse::grass(),
            _ => WindResponse::tree(),
        }
    }
}

/// The season a plant is grown in. Wire spellings (`wire`): never rename one.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Season {
    /// Summer leaves (conifers: fresh needles).
    Leafy,
    /// Autumn colour: a birch yellow, a maple red, an oak russet.
    Autumn,
    /// Bare twigs on broadleaves (a birch's catkins); conifers and palms keep their needles;
    /// grass turns to straw.
    Winter,
    /// Dead: lost and broken branches, bleached cracked bark, a few dry leaves.
    Dead,
}

impl Season {
    /// Every season, in declaration order.
    pub const ALL: [Season; 4] = [Season::Leafy, Season::Autumn, Season::Winter, Season::Dead];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Season::Leafy => "leafy",
            Season::Autumn => "autumn",
            Season::Winter => "winter",
            Season::Dead => "dead",
        }
    }
}

/// The smallest side (texels) of a plant's maps.
pub const PLANT_TEXTURE_MIN: u32 = 128;
/// The largest side (texels) of a plant's maps.
pub const PLANT_TEXTURE_MAX: u32 = 2048;
/// The side of a plant's maps unless its spec names one.
pub const PLANT_TEXTURE_DEFAULT: u32 = 1024;
/// The shortest plant (metres).
pub const PLANT_HEIGHT_MIN: f32 = 0.1;
/// The tallest plant (metres).
pub const PLANT_HEIGHT_MAX: f32 = 120.0;
/// Mesh levels a plant has (its impostor follows the last one).
pub const PLANT_LEVELS: usize = 3;

/// What to grow: a species in a season from a seed, optionally at a height and a map size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlantSpec {
    species: Species,
    season: Season,
    seed: u32,
    height: Option<f32>,
    texture_size: u32,
}

impl PlantSpec {
    /// A `species` in `season`, seed 0, at a height its seed picks from the species' range, with
    /// [`PLANT_TEXTURE_DEFAULT`] maps.
    pub const fn new(species: Species, season: Season) -> PlantSpec {
        PlantSpec { species, season, seed: 0, height: None, texture_size: PLANT_TEXTURE_DEFAULT }
    }

    /// This spec grown from `seed`: another seed grows another plant of the species.
    pub const fn seed(self, seed: u32) -> PlantSpec {
        PlantSpec { seed, ..self }
    }

    /// This spec grown `metres` tall (held to [`PLANT_HEIGHT_MIN`]..=[`PLANT_HEIGHT_MAX`]; a
    /// height that is not finite keeps the seed's).
    pub fn height(self, metres: f32) -> PlantSpec {
        let height = metres.is_finite().then(|| metres.clamp(PLANT_HEIGHT_MIN, PLANT_HEIGHT_MAX));
        PlantSpec { height, ..self }
    }

    /// This spec with maps `texels` a side: the next power of two, held to
    /// [`PLANT_TEXTURE_MIN`]..=[`PLANT_TEXTURE_MAX`].
    pub fn texture_size(self, texels: u32) -> PlantSpec {
        let texture_size = texels.clamp(PLANT_TEXTURE_MIN, PLANT_TEXTURE_MAX).next_power_of_two();
        PlantSpec { texture_size, ..self }
    }

    /// Its species.
    pub const fn species(&self) -> Species {
        self.species
    }

    /// Its season.
    pub const fn season(&self) -> Season {
        self.season
    }

    /// The height it grows to (metres): the spec's, else the seed's pick from the species' range.
    pub fn grown_height(&self) -> f32 {
        if let Some(height) = self.height {
            return height;
        }
        let [low, high] = species::preset(self.species).height;
        low + (high - low) * Rng::new(self.seed ^ 0x5eed_1e57).unit()
    }

    fn key(&self) -> (Species, Season, u32, Option<u32>, u32) {
        (self.species, self.season, self.seed, self.height.map(f32::to_bits), self.texture_size)
    }
}

/// What a grown plant is made of, level by level.
#[derive(Clone, Debug, PartialEq)]
pub struct PlantFacts {
    /// Its height (metres).
    pub height: f32,
    /// Triangles of each mesh level, full first.
    pub triangles: [u32; PLANT_LEVELS],
    /// Cards of each level (twigs, leaves, fronds or blades).
    pub cards: [u32; PLANT_LEVELS],
    /// Stems of each level drawn as geometry.
    pub stems: [u32; PLANT_LEVELS],
    /// Its maps' side (texels).
    pub texture_size: u32,
    /// Whether it has an impostor past its last level (every species but grass).
    pub impostor: bool,
}

/// A plant's GLBs: one a level (the first with its maps), and the distances (metres, for a copy of
/// scale 1) each coarser level draws from (`Model::with_levels`).
#[derive(Clone, Debug)]
pub struct PlantGlb {
    /// Each level's GLB, full first.
    pub levels: Vec<Vec<u8>>,
    /// Where level 1 and level 2 take over.
    pub distances: [f32; PLANT_LEVELS - 1],
    /// What it is made of.
    pub facts: PlantFacts,
}

/// Grow `spec` into its GLBs (deterministic: the same spec gives the same bytes). Write
/// `levels[0]` under `assets/` for Studio's import step, or let `gfx.plant` keep them in memory.
pub fn plant_glb(spec: &PlantSpec) -> PlantGlb {
    build(spec, &paint(spec, true))
}

/// The maps of `spec`'s species in its season at its size, as PNG files (deflated when
/// `compress`; stored for bytes decoded once in memory): every seed of one species and season
/// shares them.
fn paint(spec: &PlantSpec, compress: bool) -> Maps {
    let preset = species::preset(spec.species);
    let seed = texture_seed(spec.species, spec.season);
    let size = spec.texture_size;
    let png = |image: &texture::Image| png::encode(&image.rgba, image.size, image.size, compress);
    let branched = preset.form != Form::Clump;
    let mut pngs = Vec::with_capacity(5);
    if branched {
        let bark = texture::bark(preset.bark, spec.season, size, seed);
        pngs.extend([png(&bark.albedo), png(&bark.normal), png(&bark.orm)]);
    }
    let cards = texture::cards(preset.leaf, spec.season, preset.twig, size, seed ^ 0xca2d);
    pngs.extend([png(&cards.albedo), png(&cards.normal)]);
    Maps { pngs, bark: branched }
}

/// Grow `spec` into its GLBs, level 0 embedding `maps`.
fn build(spec: &PlantSpec, maps: &Maps) -> PlantGlb {
    let preset = species::preset(spec.species);
    let height = spec.grown_height();
    let skeleton = grow::grow(&preset, spec.season, height, spec.seed);
    let branched = preset.form != Form::Clump;
    let mut levels = Vec::with_capacity(PLANT_LEVELS);
    let mut facts = PlantFacts { height, triangles: [0; PLANT_LEVELS], cards: [0; PLANT_LEVELS], stems: [0; PLANT_LEVELS], texture_size: spec.texture_size, impostor: branched };
    for (level, detail) in DETAILS.iter().enumerate() {
        let bark_part = branched.then(|| geometry::bark(&skeleton, &preset, *detail));
        let foliage_part = geometry::foliage(&skeleton, *detail);
        let mut parts: Vec<(&Part, Surface)> = Vec::new();
        if let Some(part) = &bark_part {
            parts.push((part, Surface::Bark));
        }
        parts.push((&foliage_part, Surface::Foliage));
        facts.triangles[level] = parts.iter().map(|(part, _)| part.triangles() as u32).sum();
        facts.cards[level] = geometry::cards_kept(&skeleton, *detail) as u32;
        facts.stems[level] = geometry::stems_kept(&skeleton, *detail) as u32;
        levels.push(glb::write(&parts, (level == 0).then_some(maps)));
    }
    PlantGlb { levels, distances: level_distances(&preset, height), facts }
}

/// The seed a species' maps are painted from in a season: every plant of one species and season
/// shares its maps' texels.
fn texture_seed(species: Species, season: Season) -> u32 {
    (species as u32 + 1).wrapping_mul(0x9e37_79b9) ^ (season as u32 + 1).wrapping_mul(0x85eb_ca6b)
}

/// Where a plant's coarser levels take over (metres for a copy of scale 1): about one and a half
/// and four heights out (never nearer than 6 m and 15 m), sooner for a grass clump.
fn level_distances(preset: &Preset, height: f32) -> [f32; PLANT_LEVELS - 1] {
    if preset.form == Form::Clump {
        return [6.0, 14.0];
    }
    [(1.5 * height).max(6.0), (4.0 * height).max(15.0)]
}

/// The plants a game's resets grew, kept across seeds (each spec grows once a process), and the
/// maps each species and season painted (each painted once, whatever the seeds).
#[derive(Debug, Default)]
pub(crate) struct PlantCache {
    grown: RefCell<Vec<((Species, Season, u32, Option<u32>, u32), Model)>>,
    painted: RefCell<Vec<((Species, Season, u32), Rc<Maps>)>>,
}

impl PlantCache {
    /// The model of `spec`, grown on its first ask.
    pub(crate) fn plant(&self, spec: &PlantSpec) -> Model {
        let key = spec.key();
        if let Some((_, model)) = self.grown.borrow().iter().find(|(known, _)| *known == key) {
            return model.clone();
        }
        let maps = self.maps(spec);
        let model = model_of(spec, &maps);
        self.grown.borrow_mut().push((key, model.clone()));
        model
    }

    /// The maps of `spec`'s species and season at its size, painted on their first ask.
    fn maps(&self, spec: &PlantSpec) -> Rc<Maps> {
        let key = (spec.species, spec.season, spec.texture_size);
        if let Some((_, maps)) = self.painted.borrow().iter().find(|(known, _)| *known == key) {
            return Rc::clone(maps);
        }
        let maps = Rc::new(paint(spec, false));
        self.painted.borrow_mut().push((key, Rc::clone(&maps)));
        maps
    }
}

/// A plant's model: its levels, its impostor (not for grass) and its species' wind.
fn model_of(spec: &PlantSpec, maps: &Maps) -> Model {
    let PlantGlb { levels, distances, facts } = build(spec, maps);
    let mut handles = levels.into_iter().map(crate::mesh::built_glb);
    let full = handles.next().unwrap_or_default();
    let coarser: Vec<(Model, f32)> = handles.zip(distances).collect();
    let model = full.with_levels(&coarser);
    let model = if facts.impostor { model.with_impostor(Impostor::hemi()) } else { model };
    model.with_wind(spec.species.wind())
}

/// A small seeded generator (SplitMix64): the same seed draws the same sequence everywhere.
#[derive(Clone, Debug)]
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u32) -> Rng {
        Rng(u64::from(seed) ^ 0x2545_f491_4f6c_dd1d)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// 0..1.
    pub(crate) fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// -1..1.
    pub(crate) fn signed(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }

    /// 0..n.
    pub(crate) fn below(&mut self, n: usize) -> usize {
        ((self.next() >> 33) % n.max(1) as u64) as usize
    }
}

#[cfg(test)]
mod tests;
