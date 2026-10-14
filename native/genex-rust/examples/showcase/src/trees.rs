//! The lakeside's trees, grown procedurally into `game/assets/`: broadleaf trees (a trunk forking
//! into limbs, branches and twigs, leaf clusters at their tips) and pines (a tapering trunk with
//! whorls of drooping branches clothed in needle sprays). Each species has variants and three
//! levels of detail ([`LOD_COUNT`]) the draw hook picks by distance; every level shares the
//! skeleton and the clusters' places, so the crown keeps its shape as the level changes. The wood
//! is one mesh (bark texture coordinates: wrapped around, metres along) and the foliage another
//! (each leaf two-sided, its normal bent out of the crown so the crown shades as one soft volume).
//! A unit tree is about seven metres tall; the draw hook scales it per tree.

use genex::Pcg32;
use genex::math::{self, Quat, Vec3, vec2, vec3};

use crate::layout::{TreeLod, tree_asset};
use crate::meshgen::{Mesh, tube};

/// Broadleaf variants.
pub const BROADLEAF_VARIANTS: u32 = 3;
/// Pine variants.
pub const PINE_VARIANTS: u32 = 2;
/// Levels of detail per variant.
pub const LOD_COUNT: usize = 3;
/// The bark textures' real sizes: the broadleaf bark repeats every metre, the pine bark every two.
const BROADLEAF_BARK_METRES: f32 = 1.0;
const PINE_BARK_METRES: f32 = 2.0;
/// Where a broadleaf crown's foliage normals point out from.
const CROWN_CENTER: Vec3 = vec3(0.0, 4.5, 0.0);
const PINE_AXIS_TOP: f32 = 7.4;
/// How much a leaf's own facing shows in its normal against the crown's outward direction.
const LEAF_FACING_SHARE: f32 = 0.35;

/// One branch of a skeleton: its points and radii, and its order (0 the trunk).
struct Branch {
    spine: Vec<(Vec3, f32)>,
    order: u32,
}

/// What a level of detail draws.
#[derive(Clone, Copy)]
struct Detail {
    /// Tube sides per branch order (0: not drawn).
    sides: [u32; 4],
    /// Leaves per cluster and their size against the full level's.
    leaves: u32,
    leaf_scale: f32,
}

const BROADLEAF_DETAIL: [Detail; LOD_COUNT] = [
    Detail { sides: [10, 7, 5, 3], leaves: 26, leaf_scale: 1.0 },
    Detail { sides: [7, 5, 3, 0], leaves: 9, leaf_scale: 1.7 },
    Detail { sides: [5, 4, 0, 0], leaves: 4, leaf_scale: 2.55 },
];
const PINE_DETAIL: [Detail; LOD_COUNT] = [
    Detail { sides: [9, 4, 0, 0], leaves: 2, leaf_scale: 1.0 },
    Detail { sides: [6, 3, 0, 0], leaves: 1, leaf_scale: 1.4 },
    Detail { sides: [5, 0, 0, 0], leaves: 1, leaf_scale: 2.0 },
];
/// How much a branch of each order wanders from its heading per point (the trunk barely).
const WANDER: [f32; 4] = [0.035, 0.15, 0.2, 0.25];
/// Clusters that fill a broadleaf crown between its branch tips, and their reach in the crown.
const CROWN_FILL: u32 = 70;
const CROWN_RADII: Vec3 = vec3(2.3, 1.75, 2.3);

/// A point `along` (0..1) a branch, by its points' spacing.
fn point_along(spine: &[(Vec3, f32)], along: f32) -> (Vec3, f32, Vec3) {
    let last = spine.len() - 1;
    let at = (along.clamp(0.0, 1.0) * last as f32).min(last as f32 - 1e-3);
    let k = at as usize;
    let t = at - k as f32;
    let (a, b) = (spine[k], spine[k + 1]);
    (a.0.lerp(b.0, t), a.1 + (b.1 - a.1) * t, (b.0 - a.0).normalize_or(Vec3::Y))
}

/// A curved branch from `start` heading `heading` for `length`, bending towards `bend` (per unit
/// length) and wandering by `rng`, tapering from `r0` to `r1` over `points` points.
#[expect(clippy::too_many_arguments, reason = "one branch's shape")]
fn grow(rng: &mut Pcg32, start: Vec3, heading: Vec3, length: f32, bend: Vec3, r0: f32, r1: f32, points: u32, order: u32) -> Branch {
    let mut spine = vec![(start, r0)];
    let mut dir = heading.normalize_or(Vec3::Y);
    let mut at = start;
    let step = length / (points - 1) as f32;
    for k in 1..points {
        let wander = vec3(rng.range_f32(-1.0, 1.0), rng.range_f32(-0.5, 0.5), rng.range_f32(-1.0, 1.0)) * WANDER[order as usize];
        dir = (dir + bend * step + wander).normalize_or(Vec3::Y);
        at += dir * step;
        let t = k as f32 / (points - 1) as f32;
        spine.push((at, r0 + (r1 - r0) * t));
    }
    Branch { spine, order }
}

/// A direction turned from `dir` by `angle` towards a side `around` radians about it.
fn splay(dir: Vec3, angle: f32, around: f32) -> Vec3 {
    let side = dir.any_orthonormal_vector();
    let tilted = Quat::from_axis_angle(side, angle) * dir;
    (Quat::from_axis_angle(dir, around) * tilted).normalize()
}

/// A broadleaf tree's skeleton and its leaf clusters (centre, radius).
fn broadleaf_skeleton(variant: u32) -> (Vec<Branch>, Vec<(Vec3, f32)>) {
    let mut rng = Pcg32::seeded(0x7ee0_b10a + u64::from(variant) * 977);
    let fork = vec3(rng.range_f32(-0.2, 0.2), rng.range_f32(2.4, 2.9), rng.range_f32(-0.2, 0.2));
    let trunk = grow(&mut rng, vec3(0.0, -0.4, 0.0), fork - vec3(0.0, -0.4, 0.0), fork.y + 0.4, Vec3::ZERO, 0.26, 0.17, 5, 0);
    let mut branches = vec![trunk];
    let mut clusters = Vec::new();
    let limbs = 3 + variant % 2 + u32::from(rng.chance(0.5));
    let turn = rng.range_f32(0.0, math::TAU);
    for k in 0..limbs {
        let azimuth = turn + math::TAU * k as f32 / limbs as f32 + rng.range_f32(-0.35, 0.35);
        let elevation = rng.range_f32(0.72, 1.12);
        let heading = vec3(math::cos(elevation) * math::cos(azimuth), math::sin(elevation), math::cos(elevation) * math::sin(azimuth));
        let length = rng.range_f32(2.0, 2.7);
        let limb = grow(&mut rng, fork, heading, length, vec3(0.0, 0.12, 0.0), 0.15, 0.05, 6, 1);
        for s in 0..5 {
            let along = 0.3 + 0.17 * s as f32 + rng.range_f32(-0.05, 0.05);
            let (start, radius, dir) = point_along(&limb.spine, along);
            let out = splay(dir, rng.range_f32(0.55, 1.05), rng.range_f32(0.0, math::TAU));
            let up = (out + vec3(0.0, 0.25, 0.0)).normalize();
            let length = rng.range_f32(0.9, 1.5) * (1.0 - 0.3 * along);
            let branch = grow(&mut rng, start, up, length, vec3(0.0, 0.05, 0.0), radius.min(0.06), 0.018, 4, 2);
            for t in 0..3 {
                let (twig_start, twig_radius, twig_dir) = point_along(&branch.spine, 0.35 + 0.3 * t as f32);
                let heading = splay(twig_dir, rng.range_f32(0.5, 0.9), rng.range_f32(0.0, math::TAU));
                let twig_length = rng.range_f32(0.35, 0.6);
                let twig = grow(&mut rng, twig_start, heading, twig_length, Vec3::ZERO, twig_radius.min(0.02), 0.007, 3, 3);
                clusters.push((twig.spine[2].0, rng.range_f32(0.45, 0.62)));
                clusters.push((twig.spine[1].0.lerp(twig.spine[2].0, 0.5), rng.range_f32(0.38, 0.5)));
                branches.push(twig);
            }
            clusters.push((branch.spine[3].0, rng.range_f32(0.5, 0.66)));
            clusters.push((branch.spine[2].0, rng.range_f32(0.42, 0.55)));
            branches.push(branch);
        }
        clusters.push((limb.spine[5].0, 0.62));
        clusters.push((limb.spine[4].0, 0.55));
        branches.push(limb);
    }
    // Fill the crown between the tips: clusters towards its outer shell, none in the bare middle.
    for _ in 0..CROWN_FILL {
        let dir = vec3(rng.range_f32(-1.0, 1.0), rng.range_f32(-0.55, 1.0), rng.range_f32(-1.0, 1.0)).normalize_or(Vec3::Y);
        let shell = rng.range_f32(0.62, 0.95);
        clusters.push((CROWN_CENTER + dir * CROWN_RADII * shell, rng.range_f32(0.42, 0.6)));
    }
    (branches, clusters)
}

/// A pine's skeleton and its needle sprays (centre, length): each spray lies along its branch.
fn pine_skeleton(variant: u32) -> (Vec<Branch>, Vec<(Vec3, Vec3, f32)>) {
    let mut rng = Pcg32::seeded(0x9_1e00 + u64::from(variant) * 1307);
    let lean = vec3(rng.range_f32(-0.12, 0.12), 1.0, rng.range_f32(-0.12, 0.12));
    let trunk = grow(&mut rng, vec3(0.0, -0.4, 0.0), lean, PINE_AXIS_TOP + 0.4, Vec3::ZERO, 0.24, 0.025, 9, 0);
    let mut branches = Vec::new();
    let mut sprays = Vec::new();
    let mut y = 1.0 + rng.range_f32(0.0, 0.2);
    while y < PINE_AXIS_TOP - 0.25 {
        let up = (y - 1.0) / (PINE_AXIS_TOP - 1.0);
        let reach = 2.25 * math::pow(1.0 - up, 0.85) + 0.22;
        let count = 6 + rng.below(3);
        let turn = rng.range_f32(0.0, math::TAU);
        let (axis, radius, _) = point_along(&trunk.spine, (y + 0.4) / (PINE_AXIS_TOP + 0.4));
        for k in 0..count {
            let azimuth = turn + math::TAU * k as f32 / count as f32 + rng.range_f32(-0.3, 0.3);
            let droop = rng.range_f32(-0.38, -0.05) * (1.0 - up);
            let heading = vec3(math::cos(azimuth) * math::cos(droop), math::sin(droop), math::sin(azimuth) * math::cos(droop));
            let length = reach * rng.range_f32(0.8, 1.1);
            let branch = grow(&mut rng, axis + heading * radius * 0.8, heading, length, vec3(0.0, 0.16, 0.0), 0.04 * (1.0 - up * 0.6), 0.008, 4, 1);
            let sprays_here = ((length / 0.2).ceil() as u32).max(2);
            for s in 0..sprays_here {
                let (center, _, dir) = point_along(&branch.spine, (s as f32 + 0.6) / (sprays_here as f32 + 0.4));
                sprays.push((center, dir, rng.range_f32(0.42, 0.56)));
            }
            branches.push(branch);
        }
        y += rng.range_f32(0.28, 0.38);
    }
    branches.push(trunk);
    (branches, sprays)
}

/// The wood: every branch whose order the level draws, as a tube.
fn wood(branches: &[Branch], detail: Detail, bark_metres: f32) -> Mesh {
    let mut mesh = Mesh::default();
    for branch in branches {
        let sides = detail.sides[branch.order as usize];
        if sides == 0 {
            continue;
        }
        let girth = math::TAU * branch.spine[0].1;
        let wraps = (girth / bark_metres).round().max(1.0);
        tube(&mut mesh, &branch.spine, sides, wraps, bark_metres);
    }
    mesh
}

/// One two-sided leaf: from `base` along `tip` (its length and direction), `width` across `side`,
/// folded along its midrib by `fold`, its normal bent towards `outward`.
fn leaf(mesh: &mut Mesh, base: Vec3, tip: Vec3, side: Vec3, fold: Vec3, outward: Vec3) {
    let corners = [(base, vec2(0.5, 1.0)), (base + tip * 0.5 + side + fold, vec2(1.0, 0.5)), (base + tip, vec2(0.5, 0.0)), (base + tip * 0.5 - side + fold, vec2(0.0, 0.5))];
    let facing = tip.cross(side).normalize_or(Vec3::Y);
    let front = (facing * LEAF_FACING_SHARE + outward * (1.0 - LEAF_FACING_SHARE)).normalize_or(outward);
    let ids: Vec<u32> = corners.iter().map(|(p, uv)| mesh.vertex(*p, front, *uv)).collect();
    // The front faces along `facing`, the back the other way over the same vertices: both sides
    // shade with the crown's outward normal, the soft-volume foliage look.
    let up = (Vec3::from(mesh.positions[ids[1] as usize]) - base).cross(Vec3::from(mesh.positions[ids[2] as usize]) - base).dot(facing) > 0.0;
    let (a, b) = if up { ([0, 1, 2], [0, 2, 3]) } else { ([0, 2, 1], [0, 3, 2]) };
    mesh.indices.extend(a.map(|k| ids[k]).into_iter().chain(b.map(|k| ids[k])));
    mesh.indices.extend([a[0], a[2], a[1]].map(|k| ids[k]).into_iter().chain([b[0], b[2], b[1]].map(|k| ids[k])));
}

/// A broadleaf crown's leaves at `detail`: each cluster's leaves scattered in it, facing mostly up
/// and out.
fn broadleaf_leaves(clusters: &[(Vec3, f32)], detail: Detail, variant: u32) -> Mesh {
    let mut rng = Pcg32::seeded(0x1eaf_0000 + u64::from(variant) * 31);
    let mut mesh = Mesh::default();
    for (center, radius) in clusters {
        for _ in 0..detail.leaves {
            let offset = vec3(rng.range_f32(-1.0, 1.0), rng.range_f32(-0.7, 0.7), rng.range_f32(-1.0, 1.0)) * *radius;
            let at = *center + offset;
            let outward = ((at - CROWN_CENTER) * vec3(1.0, 1.3, 1.0)).normalize_or(Vec3::Y);
            let facing = (outward + vec3(rng.range_f32(-0.7, 0.7), 0.6, rng.range_f32(-0.7, 0.7))).normalize();
            let length = rng.range_f32(0.2, 0.3) * detail.leaf_scale;
            let along = facing.any_orthonormal_vector();
            let tip = (Quat::from_axis_angle(facing, rng.range_f32(0.0, math::TAU)) * along) * length;
            let side = tip.cross(facing).normalize_or(Vec3::X) * length * 0.38;
            leaf(&mut mesh, at - tip * 0.5, tip, side, facing * length * 0.12, outward);
        }
    }
    mesh
}

/// A pine's needles at `detail`: each spray a serrated frond along its branch, two crossed at the
/// fullest level.
fn pine_needles(sprays: &[(Vec3, Vec3, f32)], detail: Detail, variant: u32) -> Mesh {
    let mut rng = Pcg32::seeded(0x0ee_d1e5 + u64::from(variant) * 17);
    let mut mesh = Mesh::default();
    let keep = match detail.leaves {
        2 => 1,
        _ if detail.leaf_scale < 2.0 => 2,
        _ => 3,
    };
    for (k, (center, dir, length)) in sprays.iter().enumerate() {
        let skip = rng.below(keep) != 0;
        if skip {
            continue;
        }
        let axis_out = vec3(center.x, 0.0, center.z).normalize_or(Vec3::X);
        let outward = (axis_out + vec3(0.0, 0.35 + center.y / PINE_AXIS_TOP * 0.4, 0.0)).normalize();
        let length = length * detail.leaf_scale;
        let roll = rng.range_f32(-0.4, 0.4) + if k % 2 == 0 { 0.0 } else { 0.3 };
        for plane in 0..detail.leaves {
            let flat = (dir.cross(Vec3::Y).normalize_or(Vec3::X)) * math::cos(roll + plane as f32 * 1.2) + Vec3::Y * math::sin(roll + plane as f32 * 1.2);
            frond(&mut mesh, *center - *dir * length * 0.5, *dir * length, flat * length * 0.42, outward);
        }
    }
    mesh
}

/// A serrated frond (a needle spray seen as one shape): teeth along `tip` reaching `side` on both
/// sides, drooping a little, two-sided.
fn frond(mesh: &mut Mesh, base: Vec3, tip: Vec3, side: Vec3, outward: Vec3) {
    const TEETH: u32 = 4;
    let droop = vec3(0.0, -tip.length() * 0.12, 0.0);
    for sign in [-1.0_f32, 1.0] {
        for t in 0..TEETH {
            let (a, b) = (t as f32 / TEETH as f32, (t + 1) as f32 / TEETH as f32);
            let taper = 1.0 - (a + b) * 0.35;
            let apex = base + tip * (a + b) * 0.5 + tip * 0.18 / TEETH as f32 + side * sign * taper + droop * (a + b) * 0.5;
            leaf_triangle(mesh, base + tip * a, base + tip * b, apex, outward);
        }
    }
}

/// One two-sided triangle with the normal `outward`.
fn leaf_triangle(mesh: &mut Mesh, a: Vec3, b: Vec3, c: Vec3, outward: Vec3) {
    let ids = [(a, vec2(0.5, 1.0)), (b, vec2(0.5, 0.0)), (c, vec2(1.0, 0.5))].map(|(p, uv)| mesh.vertex(p, outward, uv));
    mesh.indices.extend(ids);
    mesh.indices.extend([ids[0], ids[2], ids[1]]);
}

/// Every tree asset as (file name, mesh): per species, variant and level, its wood and foliage.
pub fn assets() -> Vec<(String, Mesh)> {
    let mut out = Vec::new();
    for variant in 0..BROADLEAF_VARIANTS {
        let (branches, clusters) = broadleaf_skeleton(variant);
        for (lod, detail) in BROADLEAF_DETAIL.iter().enumerate() {
            let lod = TreeLod::ALL[lod];
            out.push((tree_asset(false, variant, lod, false), wood(&branches, *detail, BROADLEAF_BARK_METRES)));
            out.push((tree_asset(false, variant, lod, true), broadleaf_leaves(&clusters, *detail, variant)));
        }
    }
    for variant in 0..PINE_VARIANTS {
        let (branches, sprays) = pine_skeleton(variant);
        for (lod, detail) in PINE_DETAIL.iter().enumerate() {
            let lod = TreeLod::ALL[lod];
            out.push((tree_asset(true, variant, lod, false), wood(&branches, *detail, PINE_BARK_METRES)));
            out.push((tree_asset(true, variant, lod, true), pine_needles(&sprays, *detail, variant)));
        }
    }
    out
}
