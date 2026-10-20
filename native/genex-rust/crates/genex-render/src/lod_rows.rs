//! Per-instance LOD rows (game systems LOD-02): what the cull reads besides the instance row to
//! choose a level, never a draw stage. One [`GpuLodRow`] per opaque instance-table row, parallel
//! to it (cull binding 6, [`CULL_LOD_ROWS_BINDING`]), so the 160-byte instance row stays frozen.
//!
//! A row holds the sphere the instance's levels are measured from and its bias. By default the
//! sphere is the row's own bounds (what A6.9 measured from); a draw that names a model-space
//! origin ([`DrawLod::origin`]: a compound model's sphere, Bevy's `VisibilityRange::use_aabb`
//! idea) measures every part from that one sphere, so all of its parts are at the same distance
//! from the camera. The bias scales every projected error of the row's chain: 2 holds each level
//! twice as far ([`crate::mesh::lod_band`]). Rows are written wherever instance rows are: a
//! frame's draws in the plan, a retained group's once per version
//! ([`crate::retained::InstanceGroup::lod_rows`]), and uploaded over the same dirty ranges as the
//! instance rows ([`lod_row_upload_ranges`]).

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

/// The cull group's binding of the LOD row table (`lod_rows` in `shaders/cull.wgsl`).
pub const CULL_LOD_ROWS_BINDING: u32 = 6;
/// Bytes of one LOD row: 50,000 rows take 1.6 MB.
pub const LOD_ROW_BYTES: u64 = 32;
/// The bias a draw has unless it names one: every error as the chain recorded it.
pub const LOD_BIAS_DEFAULT: f32 = 1.0;
/// The far rule of a row without one ([`GpuLodRow::far_rule`]; LOD-18 numbers the rules from 1).
pub const FAR_RULE_NONE: u32 = 0;
/// Far rules a frame holds ([`crate::scene::Scene::far_rules`]); a row naming a later one has none.
pub const FAR_RULES_MAX: usize = 16;
/// The cull group's binding of the frame's far rules (`far_rules` in `shaders/cull.wgsl`, a
/// uniform of [`FAR_RULES_MAX`] rules).
pub const CULL_FAR_RULES_BINDING: u32 = 8;
/// Bytes of the far rules' uniform: every rule, used or not.
pub const FAR_RULES_BYTES: u64 = (FAR_RULES_MAX * size_of::<GpuFarRule>()) as u64;
/// The share of the keep threshold across which a thinned copy fades in or out (the grass's
/// grow-in band, [`crate::foliage::GRASS_FADE_BAND`]).
pub const FAR_FADE_BAND: f32 = crate::foliage::GRASS_FADE_BAND;
/// The most a surviving copy grows to hold the cover (a quarter kept: twice as large).
pub const FAR_GROW_MAX: f32 = 2.0;
/// Origins are hashed on a grid of this many cells a world unit (1 cm), so a copy keeps its
/// hash under any row order and any float noise below a centimetre.
const FAR_HASH_CELLS: f32 = 100.0;

/// One instance row's level-of-detail inputs (cull binding 6; `LodRow` in `shaders/cull.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuLodRow {
    /// The world sphere the levels are measured from (xyz, radius): the row's own bounds unless
    /// its draw names an origin.
    pub origin: [f32; 4],
    /// The bias every projected error of the row's chain is scaled by (1 as recorded, 2 twice as far).
    pub bias: f32,
    /// The row's far rule: [`FAR_RULE_NONE`], else 1 + its index in the frame's far rules (LOD-18).
    pub far_rule: u32,
    /// Spare words (zero).
    pub spare: [u32; 2],
}

/// One far-field rule (game systems LOD-18; `FarRule` in `shaders/cull.wgsl`): past `start` the
/// copies under it thin, the expected share drawn falling smoothly to `keep` at `end`, then to
/// none over `fade_out` past `end` (0: kept to the horizon). Survivors grow to hold the cover
/// ([`far_field`]).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuFarRule {
    /// Where thinning starts, world units from the camera.
    pub start: f32,
    /// Where it reaches `keep`.
    pub end: f32,
    /// The share kept at `end`, in [0, 1].
    pub keep: f32,
    /// The distance past `end` over which the rest fades out.
    pub fade_out: f32,
}

/// How a draw's levels are chosen (game systems LOD-02): the sphere its distance is measured from,
/// its bias and its far rule. [`crate::scene::Scene::set_lod`] sets it for the draws that follow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawLod {
    /// The model-space sphere (centre xyz, radius) every part of the drawn model measures from;
    /// `None`: each part measures from its own bounds.
    pub origin: Option<[f32; 4]>,
    /// The bias ([`GpuLodRow::bias`]); [`LOD_BIAS_DEFAULT`] unless the game asks for another.
    pub bias: f32,
    /// The far rule its copies thin by (game systems LOD-18): [`FAR_RULE_NONE`], else 1 + its index
    /// in [`crate::scene::Scene::far_rules`].
    pub far_rule: u32,
}

impl DrawLod {
    /// Each part from its own bounds, at the recorded errors, never thinned: every draw before LOD-02.
    pub const OWN: DrawLod = DrawLod { origin: None, bias: LOD_BIAS_DEFAULT, far_rule: FAR_RULE_NONE };
}

impl Default for DrawLod {
    fn default() -> DrawLod {
        DrawLod::OWN
    }
}

/// The world sphere of the model-space sphere `center`/`radius` under `model`: the centre moved by
/// the model, the radius scaled by its largest axis (what an instance row's bounds are).
pub fn world_sphere(model: &[f32; 16], center: [f32; 3], radius: f32) -> [f32; 4] {
    let matrix = Mat4::from_cols_array(model);
    let world = matrix.transform_point3(Vec3::from(center));
    let scale = matrix.x_axis.truncate().length().max(matrix.y_axis.truncate().length()).max(matrix.z_axis.truncate().length());
    [world.x, world.y, world.z, radius * scale]
}

/// The LOD row of an instance drawn under `model` whose row has world `bounds`, drawn with `lod`.
pub fn lod_row(model: &[f32; 16], bounds: [f32; 4], lod: &DrawLod) -> GpuLodRow {
    let origin = lod.origin.map_or(bounds, |[x, y, z, radius]| world_sphere(model, [x, y, z], radius));
    GpuLodRow { origin, bias: lod.bias, far_rule: lod.far_rule, spare: [0; 2] }
}

/// What a far rule makes of one copy (game systems LOD-18): whether it is past the rule's start
/// (`thinned`: drawn by its fade batch, dithered and grown), the share of its pixels drawn (0:
/// thinned away) and its growth about its origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FarField {
    /// Past the rule's start: the copy draws through its fade batch.
    pub thinned: bool,
    /// The share of its pixels drawn, in [0, 1] (the dither's fade).
    pub share: f32,
    /// Its scale about its origin, in [1, [`FAR_GROW_MAX`]].
    pub grow: f32,
}

impl FarField {
    /// A copy the rule leaves alone: nearer than its start, or under no usable rule.
    pub const NEAR: FarField = FarField { thinned: false, share: 1.0, grow: 1.0 };
}

/// Whether `rule` is one [`far_field`] applies: finite, `0 <= start < end`, `keep` in (0, 1],
/// `fade_out` at least 0. Any other rule leaves its copies alone.
pub fn far_rule_usable(rule: &GpuFarRule) -> bool {
    let finite = rule.start.is_finite() && rule.end.is_finite() && rule.fade_out.is_finite();
    finite && rule.start >= 0.0 && rule.end > rule.start && rule.keep > 0.0 && rule.keep <= 1.0 && rule.fade_out >= 0.0
}

/// The stable random in [0, 1) of a copy whose LOD row's sphere is `origin`: its centre on a 1 cm
/// grid, hashed (the grass's cell hash), so the copies a rule keeps never depend on row order.
/// `gx_far_hash` in `shaders/cull.wgsl` is its twin.
pub fn far_hash(origin: [f32; 4]) -> f32 {
    let cell = |v: f32| (v * FAR_HASH_CELLS + 0.5).floor() as i32 as u32;
    let mut h = cell(origin[0]).wrapping_mul(0x8da6_b343) ^ cell(origin[1]).wrapping_mul(0xd816_3841) ^ cell(origin[2]).wrapping_mul(0xcb1a_b31f);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    (h >> 8) as f32 / 16_777_216.0
}

/// The keep threshold whose expected drawn share is `density` (in (0, 1]): copies hash below
/// `1 - FAR_FADE_BAND`, and a copy of hash `h` draws `clamp((threshold - h) / band, 0, 1)` of its
/// pixels, so a threshold of 1 draws every copy whole and the expected share is a smooth
/// piecewise polynomial of the threshold, inverted here.
fn far_threshold(density: f32) -> f32 {
    let b = FAR_FADE_BAND;
    let room = 2.0 * b * (1.0 - b);
    let upper = 1.0 - b / (2.0 * (1.0 - b));
    let lower = b / (2.0 * (1.0 - b));
    if density >= upper {
        return 1.0 - (room * (1.0 - density)).sqrt();
    }
    if density >= lower {
        return density * (1.0 - b) + 0.5 * b;
    }
    (room * density).sqrt()
}

/// What far rule `rule` makes of a copy whose LOD row's sphere is `origin`, seen from `eye`
/// (game systems LOD-18; `gx_far_field` in `shaders/cull.wgsl` is its twin, expression for
/// expression). Nearer than `start` (measured to the sphere's centre) the copy is left alone.
/// Past it the expected share drawn is `density = lerp(1, keep, smoothstep(start, end, d))`: a
/// copy draws `clamp((threshold - h') / band, 0, 1)` of its pixels (`h'` its hash scaled below
/// `1 - band`, `threshold` the density's, [`far_threshold`]) and grows by `min(1 / sqrt(density),
/// FAR_GROW_MAX)`, so the drawn cover holds in expectation. Past `end` the threshold falls
/// linearly to 0 over `fade_out` (the grow held). Every share and size is continuous in the
/// distance, and moves at most a few hundredths a metre: a moving camera never pops a copy.
pub fn far_field(rule: &GpuFarRule, origin: [f32; 4], eye: [f32; 3]) -> FarField {
    if !far_rule_usable(rule) {
        return FarField::NEAR;
    }
    let offset = [origin[0] - eye[0], origin[1] - eye[1], origin[2] - eye[2]];
    let distance = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt();
    // A NaN or infinite distance (a hostile origin) leaves the copy alone, as the WGSL twin does
    // with the same comparisons.
    let past_start = distance > rule.start && distance <= f32::MAX;
    if !past_start {
        return FarField::NEAR;
    }
    let t = ((distance - rule.start) / (rule.end - rule.start)).clamp(0.0, 1.0);
    let eased = t * t * (3.0 - 2.0 * t);
    let density = 1.0 + (rule.keep - 1.0) * eased;
    let grow = (1.0 / density.sqrt()).min(FAR_GROW_MAX);
    let mut threshold = far_threshold(density);
    if rule.fade_out > 0.0 && distance > rule.end {
        threshold *= (1.0 - (distance - rule.end) / rule.fade_out).max(0.0);
    }
    if threshold.is_nan() || threshold <= 0.0 {
        return FarField { thinned: true, share: 0.0, grow };
    }
    let hashed = far_hash(origin) * (1.0 - FAR_FADE_BAND);
    let share = ((threshold - hashed) / FAR_FADE_BAND).clamp(0.0, 1.0);
    FarField { thinned: true, share, grow }
}

/// The LOD rows a frame of `rows` opaque rows writes when it writes `instance_rows` of its
/// instance table ([`crate::tables::instance_upload_ranges`]): the same rows, clipped to the opaque
/// ones. The LOD table is replaced exactly when the instance table is, so a retained group's
/// unchanged LOD rows are held as its instance rows are.
pub fn lod_row_upload_ranges(rows: usize, instance_rows: &[std::ops::Range<usize>]) -> Vec<std::ops::Range<usize>> {
    instance_rows.iter().map(|range| range.start.min(rows)..range.end.min(rows)).filter(|range| !range.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_is_thirty_two_bytes_and_measures_from_its_bounds_unless_an_origin_is_named() {
        assert_eq!(size_of::<GpuLodRow>() as u64, LOD_ROW_BYTES);
        let model = crate::scene::scaled([4.0, 0.0, -2.0], [2.0, 1.0, 1.0]);
        let bounds = [1.0, 2.0, 3.0, 0.5];
        assert_eq!(lod_row(&model, bounds, &DrawLod::OWN), GpuLodRow { origin: bounds, bias: 1.0, far_rule: FAR_RULE_NONE, spare: [0; 2] });
        let named = lod_row(&model, bounds, &DrawLod { origin: Some([1.0, 0.0, 0.0, 3.0]), bias: 2.0, far_rule: 3 });
        assert_eq!(named.origin, [6.0, 0.0, -2.0, 6.0], "moved and scaled by the largest axis");
        assert_eq!((named.bias, named.far_rule), (2.0, 3), "the bias and the far rule are the draw's");
        assert_eq!(world_sphere(&model, [0.0; 3], 1.0), crate::instance::instance_row(&model, [0.0; 3], 1.0, 0).bounds);
    }

    #[test]
    fn the_lod_rows_written_are_the_instance_rows_written_clipped_to_the_opaque_rows() {
        let none: Vec<std::ops::Range<usize>> = Vec::new();
        assert_eq!(lod_row_upload_ranges(10, &[0..4, 6..14]), vec![0..4, 6..10]);
        assert_eq!(lod_row_upload_ranges(10, &[2..4, 12..14]), vec![2..4], "a range past the opaque rows writes nothing");
        assert_eq!(lod_row_upload_ranges(0, &[0..3, 5..6]), none);
    }
}
