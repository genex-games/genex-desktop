//! Species presets: the numbers each plant grows from. Branching follows Weber and Penn's
//! "Creation and Rendering of Realistic Trees" (SIGGRAPH 1995; the parameter model, no code):
//! a crown shape, then per level a child count, where children start, their length, down angle,
//! spiral, curvature and attraction up or down, taper and ring sides. Values were tuned by eye
//! against the species' silhouettes; every one is a starting point a game may override through
//! `PlantSpec` (height, seed).

use super::Species;

/// How a branch level's children lie around their parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Spread {
    /// A spiral (the golden angle by default).
    Spiral,
    /// Whorls of this many at one height (conifers).
    Whorl(u32),
    /// Left and right in the horizontal plane (a spruce's flat sprays).
    Planar,
}

/// The crown's outline (Weber–Penn shapes): a first-level branch's length by where it starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Crown {
    Conical,
    Spherical,
    Hemispherical,
    TendFlame,
    Cylindrical,
}

impl Crown {
    /// The length share at `ratio` (1 at the crown's foot, 0 at the top).
    pub(crate) fn share(self, ratio: f32) -> f32 {
        let pi = std::f32::consts::PI;
        match self {
            Crown::Conical => 0.2 + 0.8 * ratio,
            Crown::Spherical => 0.2 + 0.8 * libm::sinf(pi * ratio),
            Crown::Hemispherical => 0.2 + 0.8 * libm::sinf(0.5 * pi * ratio),
            Crown::TendFlame if ratio <= 0.7 => 0.5 + 0.5 * ratio / 0.7,
            Crown::TendFlame => 0.5 + 0.5 * (1.0 - ratio) / 0.3,
            Crown::Cylindrical => 1.0,
        }
    }
}

/// One branch level's numbers (angles in degrees).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Level {
    /// Children a parent of full length carries (fewer on a shorter one).
    pub(crate) children: u32,
    /// Where along the parent children begin (share of its length).
    pub(crate) start: f32,
    /// Length: of the tree's height for the first level, of the parent's after.
    pub(crate) length: f32,
    pub(crate) length_var: f32,
    /// The angle from the parent's axis.
    pub(crate) down: f32,
    pub(crate) down_var: f32,
    /// How children lie around the parent, and the spiral's step.
    pub(crate) spread: Spread,
    pub(crate) rotate: f32,
    /// The bend over the whole branch (upward positive) and the wiggle a segment.
    pub(crate) curve: f32,
    pub(crate) curve_var: f32,
    /// Attraction up (positive) or down (negative) a segment.
    pub(crate) up: f32,
    pub(crate) segments: u32,
    /// The base radius against the pipe model's (1: area-preserving), and the tip's share.
    pub(crate) radius: f32,
    pub(crate) taper: f32,
    /// Ring sides at full detail.
    pub(crate) sides: u32,
}

/// Where the cards grow and how they hang.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Twigs {
    /// The lowest level that carries cards (that level and every finer one).
    pub(crate) from_level: usize,
    /// Cards a metre of branch.
    pub(crate) per_metre: f32,
    /// Where along a branch they begin.
    pub(crate) start: f32,
    /// The card's side (metres), smallest and largest.
    pub(crate) size: [f32; 2],
    /// The angle off the branch (degrees).
    pub(crate) angle: f32,
    /// How much a card hangs (0 none, 1 straight down).
    pub(crate) hang: f32,
    /// Cards lie flat about the horizontal (conifer sprays).
    pub(crate) flat: bool,
}

/// The bark a species wears.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BarkKind {
    Birch,
    Furrowed,
    Interlaced,
    Shallow,
    Plates,
    Scaly,
    Fibrous,
    Smooth,
}

/// What its cards show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeafKind {
    Birch,
    Oak,
    Maple,
    Willow,
    Shrub,
    Spruce,
    Pine,
    Palm,
    Grass,
}

/// How the plant is built besides branches: a tree, a palm's crown of fronds, a grass clump.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Form {
    Branched,
    Palm,
    Clump,
}

/// One species' preset.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Preset {
    pub(crate) form: Form,
    /// Height range (metres).
    pub(crate) height: [f32; 2],
    /// The trunk's base radius over the height.
    pub(crate) girth: f32,
    /// Root flare (share of the radius at the foot) and its buttress lobes.
    pub(crate) flare: f32,
    pub(crate) lobes: u32,
    /// Stems from the ground (shrubs) and how far they lean out (degrees).
    pub(crate) stems: u32,
    pub(crate) stem_lean: f32,
    /// The bare share of the trunk below the crown.
    pub(crate) base: f32,
    pub(crate) crown: Crown,
    /// The trunk, then each branch level.
    pub(crate) levels: [Level; 4],
    /// Levels in use (the trunk counts).
    pub(crate) depth: usize,
    pub(crate) twigs: Twigs,
    pub(crate) bark: BarkKind,
    /// The bark texture's tile around a stem (metres).
    pub(crate) bark_tile: f32,
    pub(crate) leaf: LeafKind,
    /// The twigs' colour on the cards (linear).
    pub(crate) twig: [f32; 3],
}

const NONE: Level = Level {
    children: 0,
    start: 0.0,
    length: 0.0,
    length_var: 0.0,
    down: 0.0,
    down_var: 0.0,
    spread: Spread::Spiral,
    rotate: 137.5,
    curve: 0.0,
    curve_var: 0.0,
    up: 0.0,
    segments: 1,
    radius: 1.0,
    taper: 0.1,
    sides: 4,
};

const fn trunk(segments: u32, curve: f32, curve_var: f32, sides: u32) -> Level {
    Level { segments, curve, curve_var, sides, taper: 0.05, ..NONE }
}

/// The preset of `species`.
pub(crate) fn preset(species: Species) -> Preset {
    match species {
        Species::Birch => Preset {
            form: Form::Branched,
            height: [14.0, 20.0],
            girth: 0.012,
            flare: 0.25,
            lobes: 0,
            stems: 1,
            stem_lean: 4.0,
            base: 0.28,
            crown: Crown::TendFlame,
            levels: [
                trunk(14, 6.0, 4.0, 14),
                Level { children: 34, start: 0.0, length: 0.3, length_var: 0.08, down: 42.0, down_var: 12.0, curve: -18.0, curve_var: 10.0, up: -0.2, segments: 7, radius: 0.9, taper: 0.15, sides: 8, ..NONE },
                Level { children: 9, start: 0.2, length: 0.45, length_var: 0.15, down: 50.0, down_var: 15.0, curve: -30.0, curve_var: 15.0, up: -1.0, segments: 5, radius: 0.9, taper: 0.2, sides: 5, ..NONE },
                Level { children: 6, start: 0.15, length: 0.5, length_var: 0.15, down: 40.0, down_var: 15.0, curve: -20.0, curve_var: 20.0, up: -1.6, segments: 3, radius: 0.9, taper: 0.3, sides: 4, ..NONE },
            ],
            depth: 4,
            twigs: Twigs { from_level: 3, per_metre: 9.0, start: 0.1, size: [0.36, 0.52], angle: 30.0, hang: 0.55, flat: false },
            bark: BarkKind::Birch,
            bark_tile: 0.5,
            leaf: LeafKind::Birch,
            twig: [0.09, 0.045, 0.035],
        },
        Species::Spruce => Preset {
            form: Form::Branched,
            height: [18.0, 28.0],
            girth: 0.013,
            flare: 0.3,
            lobes: 0,
            stems: 1,
            stem_lean: 1.0,
            base: 0.06,
            crown: Crown::Conical,
            levels: [
                trunk(16, 0.0, 1.5, 12),
                Level { children: 90, start: 0.0, length: 0.26, length_var: 0.05, down: 88.0, down_var: 8.0, spread: Spread::Whorl(5), curve: 22.0, curve_var: 5.0, up: -0.25, segments: 6, radius: 0.55, taper: 0.1, sides: 6, ..NONE },
                Level { children: 14, start: 0.15, length: 0.32, length_var: 0.1, down: 65.0, down_var: 10.0, spread: Spread::Planar, curve: 0.0, curve_var: 8.0, up: -0.9, segments: 3, radius: 0.8, taper: 0.2, sides: 4, ..NONE },
                NONE,
            ],
            depth: 3,
            twigs: Twigs { from_level: 1, per_metre: 7.5, start: 0.1, size: [0.65, 0.95], angle: 15.0, hang: 0.25, flat: true },
            bark: BarkKind::Scaly,
            bark_tile: 0.45,
            leaf: LeafKind::Spruce,
            twig: [0.12, 0.08, 0.05],
        },
        Species::Pine => Preset {
            form: Form::Branched,
            height: [15.0, 24.0],
            girth: 0.016,
            flare: 0.25,
            lobes: 0,
            stems: 1,
            stem_lean: 5.0,
            base: 0.55,
            crown: Crown::Hemispherical,
            levels: [
                trunk(14, 10.0, 6.0, 12),
                Level { children: 21, start: 0.0, length: 0.28, length_var: 0.08, down: 62.0, down_var: 14.0, spread: Spread::Whorl(3), curve: 25.0, curve_var: 12.0, up: 0.1, segments: 6, radius: 0.75, taper: 0.15, sides: 7, ..NONE },
                Level { children: 8, start: 0.25, length: 0.45, length_var: 0.12, down: 45.0, down_var: 15.0, curve: 15.0, curve_var: 15.0, up: 0.4, segments: 4, radius: 0.85, taper: 0.25, sides: 5, ..NONE },
                NONE,
            ],
            depth: 3,
            twigs: Twigs { from_level: 2, per_metre: 9.0, start: 0.3, size: [0.5, 0.7], angle: 35.0, hang: 0.0, flat: false },
            bark: BarkKind::Plates,
            bark_tile: 0.55,
            leaf: LeafKind::Pine,
            twig: [0.16, 0.10, 0.06],
        },
        Species::Oak => Preset {
            form: Form::Branched,
            height: [14.0, 22.0],
            girth: 0.032,
            flare: 0.55,
            lobes: 5,
            stems: 1,
            stem_lean: 5.0,
            base: 0.24,
            crown: Crown::Spherical,
            levels: [
                trunk(10, 12.0, 8.0, 16),
                Level { children: 15, start: 0.0, length: 0.5, length_var: 0.12, down: 58.0, down_var: 18.0, curve: 25.0, curve_var: 25.0, up: 0.0, segments: 8, radius: 0.85, taper: 0.15, sides: 10, ..NONE },
                Level { children: 9, start: 0.2, length: 0.5, length_var: 0.15, down: 48.0, down_var: 20.0, curve: 20.0, curve_var: 30.0, up: 0.15, segments: 5, radius: 0.85, taper: 0.2, sides: 6, ..NONE },
                Level { children: 6, start: 0.2, length: 0.45, length_var: 0.15, down: 42.0, down_var: 18.0, curve: 0.0, curve_var: 30.0, up: 0.1, segments: 3, radius: 0.85, taper: 0.3, sides: 4, ..NONE },
            ],
            depth: 4,
            twigs: Twigs { from_level: 3, per_metre: 11.0, start: 0.1, size: [0.55, 0.75], angle: 40.0, hang: 0.1, flat: false },
            bark: BarkKind::Furrowed,
            bark_tile: 0.6,
            leaf: LeafKind::Oak,
            twig: [0.13, 0.10, 0.07],
        },
        Species::Maple => Preset {
            form: Form::Branched,
            height: [13.0, 20.0],
            girth: 0.022,
            flare: 0.35,
            lobes: 3,
            stems: 1,
            stem_lean: 3.0,
            base: 0.3,
            crown: Crown::Spherical,
            levels: [
                trunk(10, 6.0, 5.0, 14),
                Level { children: 20, start: 0.0, length: 0.45, length_var: 0.1, down: 45.0, down_var: 14.0, curve: 12.0, curve_var: 15.0, up: 0.3, segments: 7, radius: 0.85, taper: 0.15, sides: 9, ..NONE },
                Level { children: 8, start: 0.2, length: 0.45, length_var: 0.12, down: 45.0, down_var: 15.0, curve: 10.0, curve_var: 18.0, up: 0.2, segments: 5, radius: 0.85, taper: 0.2, sides: 6, ..NONE },
                Level { children: 5, start: 0.2, length: 0.42, length_var: 0.12, down: 40.0, down_var: 15.0, curve: 0.0, curve_var: 20.0, up: 0.1, segments: 3, radius: 0.85, taper: 0.3, sides: 4, ..NONE },
            ],
            depth: 4,
            twigs: Twigs { from_level: 3, per_metre: 12.0, start: 0.1, size: [0.55, 0.75], angle: 35.0, hang: 0.05, flat: false },
            bark: BarkKind::Shallow,
            bark_tile: 0.55,
            leaf: LeafKind::Maple,
            twig: [0.14, 0.10, 0.07],
        },
        Species::Willow => Preset {
            form: Form::Branched,
            height: [11.0, 16.0],
            girth: 0.032,
            flare: 0.45,
            lobes: 4,
            stems: 1,
            stem_lean: 8.0,
            base: 0.22,
            crown: Crown::Spherical,
            levels: [
                trunk(9, 14.0, 8.0, 14),
                Level { children: 13, start: 0.0, length: 0.48, length_var: 0.12, down: 52.0, down_var: 15.0, curve: -20.0, curve_var: 15.0, up: 0.4, segments: 7, radius: 0.85, taper: 0.15, sides: 9, ..NONE },
                Level { children: 13, start: 0.25, length: 0.7, length_var: 0.15, down: 40.0, down_var: 15.0, curve: -10.0, curve_var: 6.0, up: -2.6, segments: 7, radius: 0.8, taper: 0.2, sides: 4, ..NONE },
                NONE,
            ],
            depth: 3,
            twigs: Twigs { from_level: 2, per_metre: 10.0, start: 0.1, size: [0.55, 0.8], angle: 15.0, hang: 0.85, flat: false },
            bark: BarkKind::Interlaced,
            bark_tile: 0.6,
            leaf: LeafKind::Willow,
            twig: [0.24, 0.20, 0.07],
        },
        Species::Palm => Preset {
            form: Form::Palm,
            height: [7.0, 13.0],
            girth: 0.022,
            flare: 0.3,
            lobes: 0,
            stems: 1,
            stem_lean: 10.0,
            base: 1.0,
            crown: Crown::Cylindrical,
            levels: [trunk(16, 22.0, 3.0, 12), NONE, NONE, NONE],
            depth: 1,
            twigs: Twigs { from_level: 0, per_metre: 0.0, start: 1.0, size: [2.6, 4.2], angle: 0.0, hang: 0.0, flat: false },
            bark: BarkKind::Fibrous,
            bark_tile: 0.5,
            leaf: LeafKind::Palm,
            twig: [0.18, 0.20, 0.08],
        },
        Species::Shrub => Preset {
            form: Form::Branched,
            height: [1.2, 2.2],
            girth: 0.012,
            flare: 0.1,
            lobes: 0,
            stems: 6,
            stem_lean: 28.0,
            base: 0.15,
            crown: Crown::Spherical,
            levels: [
                trunk(5, 10.0, 8.0, 6),
                Level { children: 7, start: 0.0, length: 0.45, length_var: 0.12, down: 42.0, down_var: 15.0, curve: 10.0, curve_var: 15.0, up: 0.25, segments: 4, radius: 0.85, taper: 0.2, sides: 4, ..NONE },
                Level { children: 5, start: 0.2, length: 0.5, length_var: 0.15, down: 42.0, down_var: 15.0, curve: 0.0, curve_var: 20.0, up: 0.2, segments: 3, radius: 0.85, taper: 0.3, sides: 3, ..NONE },
                NONE,
            ],
            depth: 3,
            twigs: Twigs { from_level: 1, per_metre: 16.0, start: 0.15, size: [0.26, 0.38], angle: 40.0, hang: 0.0, flat: false },
            bark: BarkKind::Smooth,
            bark_tile: 0.3,
            leaf: LeafKind::Shrub,
            twig: [0.12, 0.09, 0.06],
        },
        Species::Grass => Preset {
            form: Form::Clump,
            height: [0.45, 0.8],
            girth: 0.0,
            flare: 0.0,
            lobes: 0,
            stems: 9,
            stem_lean: 28.0,
            base: 0.0,
            crown: Crown::Cylindrical,
            levels: [NONE; 4],
            depth: 0,
            twigs: Twigs { from_level: 0, per_metre: 0.0, start: 0.0, size: [0.7, 1.0], angle: 0.0, hang: 0.0, flat: false },
            bark: BarkKind::Smooth,
            bark_tile: 0.3,
            leaf: LeafKind::Grass,
            twig: [0.1, 0.16, 0.04],
        },
    }
}
