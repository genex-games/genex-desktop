//! Growing a plant's skeleton from its preset and seed: stems as polylines of nodes with radii,
//! children spawned along their parents (a parametric L-system after Weber and Penn: spiral,
//! whorled or planar), then the cards (twigs, leaves, needle sprays, fronds, blades) on the
//! finest branches. Every step draws from one seeded generator in a fixed order, so a seed grows
//! one plant.

use glam::Vec3;

use super::species::{Form, Level, Preset, Spread};
use super::{Rng, Season};

/// One node of a stem: where it is and how thick.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Node {
    pub(crate) at: Vec3,
    pub(crate) radius: f32,
}

/// One stem: its level (0 the trunk) and nodes from its foot.
#[derive(Clone, Debug)]
pub(crate) struct Branch {
    pub(crate) level: usize,
    pub(crate) nodes: Vec<Node>,
}

/// What a card is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CardKind {
    /// A square card hung from its base (twigs, leaves, sprays).
    Twig,
    /// A long strip bending under its weight (a palm frond).
    Frond,
    /// A strip curving out from the ground (a grass blade).
    Blade,
}

/// One card: its base, its long axis, its side, its size and the atlas cell it shows.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Card {
    pub(crate) kind: CardKind,
    pub(crate) at: Vec3,
    pub(crate) axis: Vec3,
    pub(crate) side: Vec3,
    pub(crate) size: f32,
    pub(crate) cell: u32,
    /// 0..1, fixed per card: coarser levels keep the cards under their share.
    pub(crate) keep: f32,
}

/// A grown plant.
pub(crate) struct Skeleton {
    pub(crate) branches: Vec<Branch>,
    pub(crate) cards: Vec<Card>,
    pub(crate) height: f32,
}

/// `v` turned about the unit `axis` by `angle` radians (Rodrigues).
pub(crate) fn rotate(v: Vec3, axis: Vec3, angle: f32) -> Vec3 {
    let (s, c) = (libm::sinf(angle), libm::cosf(angle));
    v * c + axis.cross(v) * s + axis * axis.dot(v) * (1.0 - c)
}

/// A unit vector across `v`, horizontal when `v` is not vertical.
pub(crate) fn across(v: Vec3) -> Vec3 {
    let side = v.cross(Vec3::Y);
    if side.length_squared() > 1e-6 { side.normalize() } else { Vec3::X }
}

fn radians(degrees: f32) -> f32 {
    degrees * std::f32::consts::PI / 180.0
}

/// The point and direction `t` (0..1 of its length) along `branch`.
fn along(branch: &Branch, t: f32) -> (Vec3, Vec3, f32) {
    let nodes = &branch.nodes;
    let lengths: Vec<f32> = nodes.windows(2).map(|w| (w[1].at - w[0].at).length()).collect();
    let total: f32 = lengths.iter().sum();
    let mut target = t.clamp(0.0, 1.0) * total;
    for (i, length) in lengths.iter().enumerate() {
        if target <= *length || i == lengths.len() - 1 {
            let k = if *length > 0.0 { (target / length).min(1.0) } else { 0.0 };
            let at = nodes[i].at.lerp(nodes[i + 1].at, k);
            let dir = (nodes[i + 1].at - nodes[i].at).normalize_or(Vec3::Y);
            return (at, dir, nodes[i].radius + (nodes[i + 1].radius - nodes[i].radius) * k);
        }
        target -= length;
    }
    (nodes[0].at, Vec3::Y, nodes[0].radius)
}

/// A branch's length.
fn length_of(branch: &Branch) -> f32 {
    branch.nodes.windows(2).map(|w| (w[1].at - w[0].at).length()).sum()
}

struct Grower<'a> {
    preset: &'a Preset,
    season: Season,
    rng: Rng,
    height: f32,
    branches: Vec<Branch>,
}

impl Grower<'_> {
    /// One stem of `level` from `origin` along `dir`, then its children.
    fn stem(&mut self, level: usize, origin: Vec3, dir: Vec3, length: f32, radius: f32) {
        let params = self.preset.levels[level];
        let segments = params.segments.max(1);
        let mut bend_axis = across(dir);
        let mut d = dir;
        let mut nodes = vec![Node { at: origin, radius }];
        let mut walked = 0.0;
        for s in 1..=segments {
            // The trunk's nodes crowd its foot, where the flare turns.
            let t = if level == 0 { libm::powf(s as f32 / segments as f32, 1.35) } else { s as f32 / segments as f32 };
            let step = length * t - walked;
            walked = length * t;
            let wiggle = radians(params.curve_var) * self.rng.signed() / libm::sqrtf(segments as f32);
            d = rotate(d, bend_axis, -radians(params.curve) / segments as f32 + wiggle);
            let twist = across(d).cross(d).normalize_or(Vec3::Z);
            d = rotate(d, twist, 0.5 * radians(params.curve_var) * self.rng.signed() / libm::sqrtf(segments as f32));
            if params.up != 0.0 {
                d = (d + Vec3::Y * (0.12 * params.up)).normalize_or(d);
            }
            bend_axis = across(d);
            let at = nodes[s as usize - 1].at + d * step;
            let taper = 1.0 + (params.taper - 1.0) * t;
            nodes.push(Node { at, radius: radius * taper });
        }
        let branch = Branch { level, nodes };
        let this = self.branches.len();
        self.branches.push(branch);
        if level + 1 < self.preset.depth {
            self.children(this, level + 1, length);
        }
    }

    /// The children of branch `parent` at `level`.
    fn children(&mut self, parent: usize, level: usize, parent_length: f32) {
        let params: Level = self.preset.levels[level];
        let trunk_child = level == 1;
        let nominal = if trunk_child { self.height } else { self.height * self.preset.levels[level - 1].length.max(0.05) };
        let share = (parent_length / nominal).clamp(0.2, 1.0);
        let count = ((params.children as f32 * if trunk_child { 1.0 } else { share }) + 0.5) as u32;
        let start = if trunk_child { self.preset.base.max(params.start) } else { params.start };
        let per_whorl = match params.spread {
            Spread::Whorl(n) => n.max(1),
            _ => 1,
        };
        let whorls = count.div_ceil(per_whorl).max(1);
        let mut azimuth = self.rng.unit() * std::f32::consts::TAU;
        let mut side = 1.0;
        for w in 0..whorls {
            let t = start + (1.0 - start) * (w as f32 + 0.3 + 0.4 * self.rng.unit()) / whorls as f32;
            let (at, dir, radius_at) = along(&self.branches[parent], t);
            for k in 0..per_whorl {
                // A dead plant has lost some of its branches.
                if self.season == Season::Dead && self.rng.unit() < 0.3 {
                    continue;
                }
                let radial = match params.spread {
                    Spread::Planar => {
                        side = -side;
                        across(dir) * side
                    }
                    Spread::Whorl(n) => rotate(across(dir), dir, azimuth + std::f32::consts::TAU * k as f32 / n as f32),
                    Spread::Spiral => rotate(across(dir), dir, azimuth),
                };
                let down = radians(params.down + params.down_var * self.rng.signed());
                let child_dir = (dir * libm::cosf(down) + radial * libm::sinf(down)).normalize_or(radial);
                let crown_ratio = 1.0 - (t - start) / (1.0 - start).max(1e-3);
                let base_length = if trunk_child { self.height * self.preset.crown.share(crown_ratio) } else { parent_length * (1.0 - 0.5 * t) };
                let mut length = base_length * params.length * (1.0 + params.length_var * self.rng.signed());
                let broken = self.season == Season::Dead && level > 1 && self.rng.unit() < 0.3;
                if broken {
                    length *= 0.35;
                }
                let pipe = radius_at * libm::powf((length / parent_length.max(1e-3)).clamp(0.0, 1.0), 0.75) * params.radius;
                let radius = pipe.min(radius_at * 0.85).max(0.003);
                if length > 0.02 {
                    self.stem(level, at, child_dir, length, radius);
                }
            }
            azimuth += match params.spread {
                Spread::Whorl(_) => radians(params.rotate * 0.3 + 20.0 * self.rng.signed()),
                _ => radians(params.rotate + 12.0 * self.rng.signed()),
            };
        }
    }
}

/// Twig cards along the card-bearing branches.
fn twig_cards(preset: &Preset, season: Season, branches: &[Branch], rng: &mut Rng) -> Vec<Card> {
    let twigs = preset.twigs;
    let mut cards = Vec::new();
    let finest = preset.depth.saturating_sub(1);
    for branch in branches.iter().filter(|b| b.level >= twigs.from_level.min(finest) && b.level > 0) {
        let length = length_of(branch);
        // Coarser card-bearing levels carry cards only near their tips.
        let start = if branch.level < finest { twigs.start.max(0.6) } else { twigs.start };
        let mut count = (length * (1.0 - start) * twigs.per_metre + rng.unit()) as usize;
        if season == Season::Dead {
            count = (count as f32 * 0.4) as usize;
        }
        for i in 0..count {
            let t = start + (1.0 - start) * (i as f32 + rng.unit()) / count.max(1) as f32;
            let (at, dir, _) = along(branch, t);
            let azimuth = rng.unit() * std::f32::consts::TAU;
            let radial = rotate(across(dir), dir, azimuth);
            let off = radians(twigs.angle * (0.5 + rng.unit()));
            let mut axis = (dir * libm::cosf(off) + radial * libm::sinf(off)).normalize_or(dir);
            axis = (axis * (1.0 - twigs.hang) + Vec3::NEG_Y * twigs.hang).normalize_or(axis);
            let side = if twigs.flat { across(axis) } else { rotate(across(axis), axis, rng.signed() * 1.2) };
            let size = twigs.size[0] + (twigs.size[1] - twigs.size[0]) * rng.unit();
            cards.push(Card { kind: super::grow::CardKind::Twig, at, axis, side, size, cell: rng.below(4) as u32, keep: rng.unit() });
        }
    }
    cards
}

/// A palm's crown: fronds from the trunk's top, young ones up, old ones drooping.
fn fronds(preset: &Preset, season: Season, trunk: &Branch, rng: &mut Rng) -> Vec<Card> {
    let top = trunk.nodes[trunk.nodes.len() - 1].at;
    let count = if season == Season::Dead { 9 } else { 16 };
    (0..count)
        .map(|i| {
            let azimuth = i as f32 * radians(137.5) + 0.2 * rng.signed();
            let age = i as f32 / count as f32;
            let elevation = radians(if season == Season::Dead { -55.0 } else { 60.0 - 95.0 * age }) + 0.15 * rng.signed();
            let out = Vec3::new(libm::cosf(azimuth), 0.0, libm::sinf(azimuth));
            let axis = (out * libm::cosf(elevation) + Vec3::Y * libm::sinf(elevation)).normalize();
            let size = preset.twigs.size[0] + (preset.twigs.size[1] - preset.twigs.size[0]) * rng.unit();
            Card { kind: CardKind::Frond, at: top, axis, side: across(axis), size, cell: rng.below(4) as u32, keep: rng.unit() }
        })
        .collect()
}

/// A grass clump: blades from a small disc, leaning out.
fn blades(preset: &Preset, height: f32, rng: &mut Rng) -> Vec<Card> {
    (0..preset.stems + rng.below(4) as u32)
        .map(|i| {
            let azimuth = i as f32 * radians(137.5) + 0.3 * rng.signed();
            let out = Vec3::new(libm::cosf(azimuth), 0.0, libm::sinf(azimuth));
            let lean = radians(preset.stem_lean * (0.4 + 0.8 * rng.unit()));
            let axis = (Vec3::Y * libm::cosf(lean) + out * libm::sinf(lean)).normalize();
            let at = out * 0.06 * rng.unit();
            let side = rotate(across(axis), axis, rng.signed() * 0.8);
            let size = height * (preset.twigs.size[0] + (preset.twigs.size[1] - preset.twigs.size[0]) * rng.unit());
            Card { kind: CardKind::Blade, at, axis, side, size, cell: rng.below(4) as u32, keep: rng.unit() }
        })
        .collect()
}

/// Grow a plant of `preset` in `season`, `height` metres tall, from `seed`.
pub(crate) fn grow(preset: &Preset, season: Season, height: f32, seed: u32) -> Skeleton {
    let mut rng = Rng::new(seed);
    if preset.form == Form::Clump {
        let cards = blades(preset, height, &mut rng);
        return Skeleton { branches: Vec::new(), cards, height };
    }
    let mut grower = Grower { preset, season, rng, height, branches: Vec::new() };
    let radius = (height * preset.girth).max(0.01);
    for stem in 0..preset.stems {
        let azimuth = stem as f32 * radians(137.5) + 0.4 * grower.rng.signed();
        let out = Vec3::new(libm::cosf(azimuth), 0.0, libm::sinf(azimuth));
        let lean = radians(preset.stem_lean * if preset.stems > 1 { 0.5 + grower.rng.unit() } else { grower.rng.unit() });
        let dir = (Vec3::Y * libm::cosf(lean) + out * libm::sinf(lean)).normalize();
        let foot = if preset.stems > 1 { out * radius * 3.0 } else { Vec3::ZERO };
        let stem_height = if preset.stems > 1 { height * (0.7 + 0.3 * grower.rng.unit()) } else { height };
        grower.stem(0, foot, dir, stem_height, radius);
    }
    let Grower { mut rng, branches, .. } = grower;
    let cards = match preset.form {
        Form::Palm => fronds(preset, season, &branches[0], &mut rng),
        _ => twig_cards(preset, season, &branches, &mut rng),
    };
    Skeleton { branches, cards, height }
}
