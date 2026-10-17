//! Procedural scatter on the terrain (renderer pass 2 A.8, A4.9): bushes, rocks, flowers or
//! anything a game instances, placed by the CPU at a loading point (after greggman/sedon's global
//! cell hashing and the density-map rules of Horizon Zero Dawn's GPU placement talk, ideas
//! only). The output is plain transforms the game draws through its own instance groups, so the
//! instances go through the renderer's standard cull, levels of detail and shadows.
//!
//! - **One candidate per cell** of a grid the rule's density sets: every random (jitter, keep,
//!   yaw, scale) is hashed from the cell's global index and the rule's seed, so the same instance
//!   stands in the same place whichever area is asked for (two neighbouring areas share their edge
//!   exactly, and a chunk scattered again is the same chunk).
//! - **Where**: the rule's layers' weight under the point (the control map, as the grass reads it)
//!   times its density, cut where the ground is steeper than the rule allows.
//! - **A cap per device class**: past `cap`, the instances kept are those with the lowest hashed
//!   priority, so a capped scatter thins evenly over the area instead of filling its first rows.

use super::{hash, unit};
use crate::terrain::{MAX_TERRAIN_LAYERS, TerrainDesc};

/// The hash salts of a scatter cell's randoms (past the grass's).
mod salt {
    pub const JITTER_X: u32 = 16;
    pub const JITTER_Z: u32 = 17;
    pub const KEEP: u32 = 18;
    pub const YAW: u32 = 19;
    pub const SCALE: u32 = 20;
    pub const PRIORITY: u32 = 21;
}

/// The most instances one scatter returns.
pub const SCATTER_MAX: usize = 1 << 20;
/// The densest scatter (instances per square metre).
pub const SCATTER_DENSITY_MAX: f32 = 16.0;

/// What a scatter places and where.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScatterRule {
    /// Instances per square metre where the rule's layers cover the ground alone.
    pub density: f32,
    /// The terrain layers it grows on (bit `i` for layer `i`).
    pub layers: u16,
    /// The smallest and largest scale.
    pub scale: [f32; 2],
    /// The steepest ground it stands on, as the least y of the ground's normal (0: any, 1: flat only).
    pub flatness: f32,
    /// How far an instance leans with the ground (0: upright, 1: along the ground's normal).
    pub follow_ground: f32,
    /// The rule's own seed: two rules with different seeds never share places.
    pub seed: u32,
    /// The most instances kept (the lowest hashed priorities); at most [`SCATTER_MAX`].
    pub cap: usize,
}

impl ScatterRule {
    /// `density` instances a square metre on the layers of `layers` (a bit each), upright, unit
    /// scale, any slope, seed 0, capped at [`SCATTER_MAX`].
    pub const fn new(density: f32, layers: u16) -> ScatterRule {
        ScatterRule { density, layers, scale: [1.0, 1.0], flatness: 0.0, follow_ground: 0.0, seed: 0, cap: SCATTER_MAX }
    }

    /// Whether every number is usable.
    pub fn usable(&self) -> bool {
        let finite = [self.density, self.scale[0], self.scale[1], self.flatness, self.follow_ground].iter().all(|v| v.is_finite());
        finite
            && self.density > 0.0
            && self.density <= SCATTER_DENSITY_MAX
            && self.scale[0] > 0.0
            && self.scale[0] <= self.scale[1]
            && (0.0..=1.0).contains(&self.flatness)
            && (0.0..=1.0).contains(&self.follow_ground)
    }

    /// The side of a cell (metres): one candidate a cell at the rule's density.
    pub fn cell(&self) -> f32 {
        1.0 / self.density.max(1e-6).sqrt()
    }
}

/// One placed instance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scattered {
    /// Where it stands (on the ground's bilinear height).
    pub position: [f32; 3],
    /// Its turn about its up axis (radians).
    pub yaw: f32,
    /// Its scale.
    pub scale: f32,
    /// Its up axis (unit): +y eased towards the ground's normal by the rule.
    pub up: [f32; 3],
    /// The cell it came from (global x, z).
    pub cell: [i32; 2],
    priority: u32,
}

impl Scattered {
    /// Its model matrix (column-major): scale, then the yaw about +y, then +y turned onto `up`,
    /// then the position.
    pub fn model(&self) -> [f32; 16] {
        let (s, c) = (libm::sinf(self.yaw), libm::cosf(self.yaw));
        // The yawed frame: x = (c, 0, -s), z = (s, 0, c), y up.
        let yawed = [[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]];
        let turn = rotation_onto_up(self.up);
        let mut m = [0.0; 16];
        for (col, axis) in yawed.iter().enumerate() {
            let turned = mul3(&turn, axis);
            for row in 0..3 {
                m[col * 4 + row] = turned[row] * self.scale;
            }
        }
        m[12] = self.position[0];
        m[13] = self.position[1];
        m[14] = self.position[2];
        m[15] = 1.0;
        m
    }
}

/// The rotation (rows) turning +y onto unit `up` about the axis perpendicular to both.
fn rotation_onto_up(up: [f32; 3]) -> [[f32; 3]; 3] {
    let [x, y, z] = up;
    if y > 0.999_999 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    // Rodrigues about k = (z, 0, -x) / |..| by the angle whose cosine is y.
    let k = 1.0 / (1.0 + y);
    [[y + z * z * k, x, -x * z * k], [-x, y, -z], [-x * z * k, z, y + x * x * k]]
}

fn mul3(m: &[[f32; 3]; 3], v: &[f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|r| m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2])
}

/// The share of the ground at (`x`, `z`) the rule's layers cover (the four control texels around
/// it, each texel's base and overlay).
fn cover(field: &super::GrassField<'_>, layers: u16, x: f32, z: f32) -> f32 {
    field.layers_at(x, z).iter().filter(|(layer, _)| (*layer as usize) < MAX_TERRAIN_LAYERS && layers & (1 << layer) != 0).map(|(_, weight)| weight).sum()
}

/// Scatter `rule` over `desc` within the world rectangle from `min` to `max` (x, z): every kept
/// instance in cell order (rows of cells, x fastest), then capped to the rule's cap by priority
/// (the kept ones stay in cell order). A rule that is not usable places nothing.
pub fn scatter(desc: &TerrainDesc, rule: &ScatterRule, min: [f32; 2], max: [f32; 2]) -> Vec<Scattered> {
    if !rule.usable() || !(min[0] < max[0] && min[1] < max[1]) {
        return Vec::new();
    }
    let field = super::GrassField::new(desc);
    let heights = &desc.heights;
    let (w, d) = heights.samples();
    let origin = heights.origin();
    let span = [(w - 1) as f32 * heights.spacing(), (d - 1) as f32 * heights.spacing()];
    let lo = [min[0].max(origin[0]), min[1].max(origin[1])];
    let hi = [max[0].min(origin[0] + span[0]), max[1].min(origin[1] + span[1])];
    let cell = rule.cell();
    let first = [libm::floorf(lo[0] / cell) as i64, libm::floorf(lo[1] / cell) as i64];
    let last = [libm::floorf(hi[0] / cell) as i64, libm::floorf(hi[1] / cell) as i64];
    let cells = (last[0] - first[0] + 1).max(0) * (last[1] - first[1] + 1).max(0);
    if cells <= 0 || cells > (SCATTER_MAX as i64) * 64 {
        return Vec::new();
    }
    let seed = rule.seed.wrapping_mul(0x9e37_79b9);
    let mut out = Vec::new();
    for cz in first[1]..=last[1] {
        for cx in first[0]..=last[0] {
            let (x, z) = (cx as i32, cz as i32);
            let at = |s: u32| unit(x, z, s ^ seed);
            let wx = (x as f32 + at(salt::JITTER_X)) * cell;
            let wz = (z as f32 + at(salt::JITTER_Z)) * cell;
            let inside = wx >= lo[0] && wz >= lo[1] && wx < max[0].min(hi[0] + 1e-6) && wz < max[1].min(hi[1] + 1e-6);
            if !inside {
                continue;
            }
            let probability = (cover(&field, rule.layers, wx, wz) * rule.density * cell * cell).min(1.0);
            if at(salt::KEEP) >= probability {
                continue;
            }
            let normal = ground_normal(desc, wx, wz);
            if normal[1] < rule.flatness {
                continue;
            }
            let up = ease_up(normal, rule.follow_ground);
            let scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * at(salt::SCALE);
            out.push(Scattered {
                position: [wx, heights.height(wx, wz), wz],
                yaw: at(salt::YAW) * core::f32::consts::TAU,
                scale,
                up,
                cell: [x, z],
                priority: hash(x, z, salt::PRIORITY ^ seed),
            });
            if out.len() > SCATTER_MAX * 4 {
                break;
            }
        }
    }
    cap(out, rule.cap.min(SCATTER_MAX))
}

/// Keep the `cap` instances of lowest priority, in their cell order.
fn cap(mut placed: Vec<Scattered>, cap: usize) -> Vec<Scattered> {
    if placed.len() <= cap {
        return placed;
    }
    let mut priorities: Vec<(u32, [i32; 2])> = placed.iter().map(|p| (p.priority, p.cell)).collect();
    priorities.sort_unstable();
    let cut = priorities[cap - 1];
    placed.retain(|p| (p.priority, p.cell) <= cut);
    placed
}

/// The ground's unit normal at world (`x`, `z`) from the bilinear heights a quarter sample apart.
fn ground_normal(desc: &TerrainDesc, x: f32, z: f32) -> [f32; 3] {
    let e = desc.heights.spacing() * 0.5;
    let h = |x: f32, z: f32| desc.heights.height(x, z);
    let n = [h(x - e, z) - h(x + e, z), 2.0 * e, h(x, z - e) - h(x, z + e)];
    let length = libm::sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    n.map(|v| v / length)
}

/// +y eased towards `normal` by `share` (unit).
fn ease_up(normal: [f32; 3], share: f32) -> [f32; 3] {
    let v = [normal[0] * share, 1.0 + (normal[1] - 1.0) * share, normal[2] * share];
    let length = libm::sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).max(1e-6);
    v.map(|c| c / length)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_turn_onto_up_is_a_rotation_carrying_y_onto_up() {
        let up = ease_up([0.3, 0.9, -0.2], 1.0);
        let m = rotation_onto_up(up);
        let y = mul3(&m, &[0.0, 1.0, 0.0]);
        assert!((0..3).all(|i| (y[i] - up[i]).abs() < 1e-5), "{y:?} {up:?}");
        for axis in [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]] {
            let v = mul3(&m, &axis);
            assert!((v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - 1.0).abs() < 1e-5, "lengths kept");
        }
    }
}
