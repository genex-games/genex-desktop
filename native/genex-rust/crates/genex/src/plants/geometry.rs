//! A grown skeleton's meshes at each level of detail: stems as generalized cylinders (rings
//! carried along each stem by parallel transport, smooth normals tilted by the taper, a root
//! flare with buttress lobes, a collar where a branch leaves its parent, bark UVs square at the
//! stem's foot) and cards as bent quads or strips whose normals lean out from the crown's centre,
//! so a crown of cards shades as a volume. Coarser levels drop the finest stems, thin the rings
//! and keep a share of the cards, grown to keep the crown's cover.

use glam::{Vec2, Vec3};

use super::grow::{Branch, Card, CardKind, Skeleton, across, rotate};
use super::species::Preset;

/// One part's triangles.
#[derive(Clone, Debug, Default)]
pub(crate) struct Part {
    pub(crate) positions: Vec<Vec3>,
    pub(crate) normals: Vec<Vec3>,
    pub(crate) uvs: Vec<Vec2>,
    pub(crate) indices: Vec<u32>,
}

impl Part {
    fn vertex(&mut self, position: Vec3, normal: Vec3, uv: Vec2) -> u32 {
        self.positions.push(position);
        self.normals.push(normal);
        self.uvs.push(uv);
        (self.positions.len() - 1) as u32
    }

    /// Triangles.
    pub(crate) fn triangles(&self) -> usize {
        self.indices.len() / 3
    }
}

/// How one level of detail is cut from the full plant.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Detail {
    /// Ring sides against the full plant's.
    sides: f32,
    /// The finest stem level kept as geometry.
    finest: usize,
    /// Every how many nodes a stem keeps a ring (its foot and tip always).
    ring_step: usize,
    /// The share of cards kept, and how much each kept card grows.
    cards: f32,
    card_scale: f32,
}

/// The levels of detail, full first.
pub(crate) const DETAILS: [Detail; 3] = [
    Detail { sides: 1.0, finest: usize::MAX, ring_step: 1, cards: 1.0, card_scale: 1.0 },
    Detail { sides: 0.6, finest: 2, ring_step: 2, cards: 0.45, card_scale: 1.4 },
    Detail { sides: 0.4, finest: 1, ring_step: 3, cards: 0.18, card_scale: 2.1 },
];

/// The bark part of `skeleton` at `detail`.
pub(crate) fn bark(skeleton: &Skeleton, preset: &Preset, detail: Detail) -> Part {
    let mut part = Part::default();
    for branch in skeleton.branches.iter().filter(|b| b.level <= detail.finest) {
        tube(&mut part, branch, preset, detail);
    }
    part
}

/// The ring sides of `branch` at `detail`.
fn sides_of(branch: &Branch, preset: &Preset, detail: Detail) -> u32 {
    let full = preset.levels[branch.level].sides as f32;
    let floor = if branch.level == 0 { 5.0 } else { 3.0 };
    (full * detail.sides + 0.5).max(floor) as u32
}

/// The nodes `detail` keeps of `branch`: every `ring_step`-th, the foot and the tip.
fn kept_nodes(branch: &Branch, detail: Detail) -> Vec<usize> {
    let last = branch.nodes.len() - 1;
    let mut kept: Vec<usize> = (0..last).step_by(detail.ring_step.max(1)).collect();
    kept.push(last);
    kept
}

/// One stem as a tube, closed at its tip.
fn tube(part: &mut Part, branch: &Branch, preset: &Preset, detail: Detail) {
    let sides = sides_of(branch, preset, detail);
    let kept = kept_nodes(branch, detail);
    let nodes = &branch.nodes;
    let base_radius = nodes[0].radius.max(1e-3);
    let circumference = std::f32::consts::TAU * base_radius;
    let repeat = (circumference / preset.bark_tile + 0.5).max(1.0);
    let v_per_metre = repeat / circumference;
    let first = part.positions.len() as u32;
    let mut normal_frame = across((nodes[1].at - nodes[0].at).normalize_or(Vec3::Y));
    let mut previous_dir = (nodes[1].at - nodes[0].at).normalize_or(Vec3::Y);
    let mut walked = 0.0;
    let mut last_at = nodes[0].at;
    for (ring, &i) in kept.iter().enumerate() {
        let node = nodes[i];
        let dir = if i + 1 < nodes.len() { (nodes[i + 1].at - node.at).normalize_or(previous_dir) } else { previous_dir };
        // Parallel transport: turn the frame by the turn between the directions.
        let turn = previous_dir.cross(dir);
        if turn.length_squared() > 1e-10 {
            let angle = libm::asinf(turn.length().min(1.0));
            normal_frame = rotate(normal_frame, turn.normalize(), angle);
        }
        normal_frame = (normal_frame - dir * normal_frame.dot(dir)).normalize_or(across(dir));
        let binormal = dir.cross(normal_frame);
        previous_dir = dir;
        walked += (node.at - last_at).length();
        last_at = node.at;
        let (radius, slope) = shaped_radius(branch, preset, node.radius, walked, base_radius);
        for k in 0..=sides {
            let theta = std::f32::consts::TAU * k as f32 / sides as f32;
            let radial = normal_frame * libm::cosf(theta) + binormal * libm::sinf(theta);
            let lobe = if branch.level == 0 { lobe_at(preset, walked, base_radius, theta) } else { 1.0 };
            let at = node.at + radial * radius * lobe;
            let normal = (radial - dir * slope).normalize_or(radial);
            part.vertex(at, normal, Vec2::new(k as f32 / sides as f32 * repeat, walked * v_per_metre));
        }
        if ring > 0 {
            let row = sides + 1;
            let (a0, b0) = (first + (ring as u32 - 1) * row, first + ring as u32 * row);
            for k in 0..sides {
                part.indices.extend([a0 + k, a0 + k + 1, b0 + k + 1, a0 + k, b0 + k + 1, b0 + k]);
            }
        }
    }
    // The tip: one vertex closing the last ring.
    let tip_node = nodes[nodes.len() - 1];
    let tip = part.vertex(tip_node.at + previous_dir * tip_node.radius, previous_dir, Vec2::new(0.5 * repeat, (walked + tip_node.radius) * v_per_metre));
    let last_ring = first + (kept.len() as u32 - 1) * (sides + 1);
    for k in 0..sides {
        part.indices.extend([last_ring + k, last_ring + k + 1, tip]);
    }
}

/// A stem's radius `walked` metres up from its foot (the trunk's root flare, a branch's collar)
/// and the radius's fall a metre, which tilts the normal.
fn shaped_radius(branch: &Branch, preset: &Preset, radius: f32, walked: f32, base: f32) -> (f32, f32) {
    let (bulge, reach) = if branch.level == 0 { (preset.flare, 1.6 * base) } else { (0.45, 1.2 * base) };
    let fall = libm::expf(-walked / reach.max(1e-3));
    let shaped = radius * (1.0 + bulge * fall);
    let slope = radius * bulge * fall / reach.max(1e-3);
    (shaped, slope)
}

/// A trunk's buttress lobes near its foot: the radius's share at angle `theta`.
fn lobe_at(preset: &Preset, walked: f32, base: f32, theta: f32) -> f32 {
    if preset.lobes == 0 {
        return 1.0;
    }
    let fade = libm::expf(-walked / (1.2 * base).max(1e-3));
    1.0 + 0.18 * preset.flare * fade * libm::cosf(preset.lobes as f32 * theta)
}

/// The foliage part of `skeleton` at `detail`: the cards it keeps, grown by its scale.
pub(crate) fn foliage(skeleton: &Skeleton, detail: Detail) -> Part {
    let mut part = Part::default();
    let centre = crown_centre(&skeleton.cards);
    let mut kept = 0;
    for (at, card) in skeleton.cards.iter().enumerate() {
        // The first card always stays, so a level never loses its foliage part.
        if card.keep >= detail.cards && at > 0 {
            continue;
        }
        kept += 1;
        let size = card.size * detail.card_scale;
        match card.kind {
            CardKind::Twig => twig_card(&mut part, card, size, centre),
            CardKind::Frond => strip(&mut part, card, size, size * 0.42, 0.55, centre),
            CardKind::Blade => strip(&mut part, card, size, size * 0.5, -0.15, centre),
        }
    }
    debug_assert!(kept > 0 || skeleton.cards.is_empty());
    part
}

/// The centre the cards' normals lean out from: the mean card position.
fn crown_centre(cards: &[Card]) -> Vec3 {
    if cards.is_empty() {
        return Vec3::ZERO;
    }
    cards.iter().fold(Vec3::ZERO, |sum, card| sum + card.at + card.axis * card.size * 0.5) / cards.len() as f32
}

/// The atlas cell's UV rectangle: (left, top) and (right, bottom).
fn cell_uv(cell: u32) -> (Vec2, Vec2) {
    let (x, y) = ((cell % 2) as f32 * 0.5, (cell / 2) as f32 * 0.5);
    (Vec2::new(x, y), Vec2::new(x + 0.5, y + 0.5))
}

/// A normal between the card's own and the crown's outward one.
fn crown_normal(own: Vec3, at: Vec3, centre: Vec3) -> Vec3 {
    let out = (at - centre).normalize_or(own);
    let own = if own.dot(out) < 0.0 { -own } else { own };
    (own * 0.45 + out * 0.55).normalize_or(own)
}

/// A square twig card hung from its base, cupped along its middle.
fn twig_card(part: &mut Part, card: &Card, size: f32, centre: Vec3) {
    let (lo, hi) = cell_uv(card.cell);
    let normal = card.axis.cross(card.side).normalize_or(Vec3::Y);
    let half = card.side * size * 0.5;
    let cup = normal * size * 0.08;
    let base = card.at;
    let mid = base + card.axis * size * 0.5 + cup;
    let tip = base + card.axis * size;
    // The middle row's edges sit lower than its spine: the card cups.
    let rows = [(base, hi.y, Vec3::ZERO), (mid, (lo.y + hi.y) * 0.5, cup * 0.6), (tip, lo.y, Vec3::ZERO)];
    let first = part.positions.len() as u32;
    for (spine, v, edge_drop) in rows {
        for (offset, u) in [(-half, lo.x), (half, hi.x)] {
            let at = spine + offset - edge_drop;
            part.vertex(at, crown_normal(normal, at, centre), Vec2::new(u, v));
        }
    }
    for row in 0..2u32 {
        let (a, b) = (first + row * 2, first + row * 2 + 2);
        part.indices.extend([a, a + 1, b + 1, a, b + 1, b]);
    }
}

/// A long strip along the card's axis, `length` and `width` metres, bending `droop` (share of its
/// length; negative curls it up) across six segments.
fn strip(part: &mut Part, card: &Card, length: f32, width: f32, droop: f32, centre: Vec3) {
    const SEGMENTS: u32 = 6;
    let (lo, hi) = cell_uv(card.cell);
    let flat = Vec3::new(card.axis.x, 0.0, card.axis.z).normalize_or(card.side.cross(Vec3::Y));
    let first = part.positions.len() as u32;
    for s in 0..=SEGMENTS {
        let t = s as f32 / SEGMENTS as f32;
        let along = card.axis * t * length;
        let sag = Vec3::NEG_Y * droop * length * t * t + flat * droop.abs() * 0.15 * length * t * t;
        let spine = card.at + along + sag;
        let next = t + 1.0 / SEGMENTS as f32;
        let ahead = card.axis * next * length + Vec3::NEG_Y * droop * length * next * next;
        let tangent = (ahead - (along + sag)).normalize_or(card.axis);
        let side = (card.side - tangent * card.side.dot(tangent)).normalize_or(across(tangent));
        let half = side * width * 0.5 * libm::sqrtf(libm::sinf(std::f32::consts::PI * (0.08 + 0.92 * t)).max(0.0)).max(0.15);
        let normal = tangent.cross(side).normalize_or(Vec3::Y);
        let v = hi.y + (lo.y - hi.y) * t;
        for (offset, u) in [(-half, lo.x), (half, hi.x)] {
            let at = spine + offset;
            part.vertex(at, crown_normal(normal, at, centre), Vec2::new(u, v));
        }
    }
    for s in 0..SEGMENTS {
        let (a, b) = (first + s * 2, first + s * 2 + 2);
        part.indices.extend([a, a + 1, b + 1, a, b + 1, b]);
    }
}

/// The cards `detail` keeps of `skeleton`.
pub(crate) fn cards_kept(skeleton: &Skeleton, detail: Detail) -> usize {
    skeleton.cards.iter().enumerate().filter(|(at, card)| card.keep < detail.cards || *at == 0).count()
}

/// The stems `detail` draws as geometry.
pub(crate) fn stems_kept(skeleton: &Skeleton, detail: Detail) -> usize {
    skeleton.branches.iter().filter(|branch| branch.level <= detail.finest).count()
}
