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

/// One far-field rule (game systems LOD-18 binds them; declared here with the row that names it):
/// the share of a group kept past `start`, falling to `keep` at `end`, then to none over `fade_out`.
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

/// How a draw's levels are chosen (game systems LOD-02): the sphere its distance is measured from
/// and its bias. [`crate::scene::Scene::set_lod`] sets it for the draws that follow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawLod {
    /// The model-space sphere (centre xyz, radius) every part of the drawn model measures from;
    /// `None`: each part measures from its own bounds.
    pub origin: Option<[f32; 4]>,
    /// The bias ([`GpuLodRow::bias`]); [`LOD_BIAS_DEFAULT`] unless the game asks for another.
    pub bias: f32,
}

impl DrawLod {
    /// Each part from its own bounds, at the recorded errors: every draw before LOD-02.
    pub const OWN: DrawLod = DrawLod { origin: None, bias: LOD_BIAS_DEFAULT };
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
    GpuLodRow { origin, bias: lod.bias, far_rule: FAR_RULE_NONE, spare: [0; 2] }
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
        let named = lod_row(&model, bounds, &DrawLod { origin: Some([1.0, 0.0, 0.0, 3.0]), bias: 2.0 });
        assert_eq!(named.origin, [6.0, 0.0, -2.0, 6.0], "moved and scaled by the largest axis");
        assert_eq!(named.bias, 2.0);
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
