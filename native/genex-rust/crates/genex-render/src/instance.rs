//! Instance-table rows. Every drawn instance (instanced or not, rigid or skinned, opaque or
//! transparent) is one row: its model and normal matrices, its world bounding sphere for the cull
//! and its material-table index. Opaque rows are grouped by batch (one batch per mesh, one per
//! skinned draw) so a batch is one contiguous range; transparent rows follow them.

use glam::{Mat4, Vec3};

use crate::layout::GpuInstance;

/// The row for a draw of a mesh whose model-space bounding sphere is `center`/`radius`.
pub fn instance_row(model: &[f32; 16], center: [f32; 3], radius: f32, material: u32) -> GpuInstance {
    let matrix = Mat4::from_cols_array(model);
    let normal = if determinant(&matrix) == 0.0 { Mat4::IDENTITY } else { matrix.inverse().transpose() };
    let world_center = matrix.transform_point3(Vec3::from(center));
    let scale = matrix.x_axis.truncate().length().max(matrix.y_axis.truncate().length()).max(matrix.z_axis.truncate().length());
    GpuInstance {
        model: *model,
        normal: normal.to_cols_array(),
        bounds: [world_center.x, world_center.y, world_center.z, radius * scale],
        material,
        pad: [0; 3],
    }
}

/// `matrix`'s determinant as glam's [`Mat4::determinant`] computes it, with the terms an affine
/// matrix (bottom row 0, 0, 0, 1) multiplies by zero left out: the same value for every finite
/// affine model, at a third of the work (every instance row asks; pass-1 fix, the features-off
/// CPU time). Any other matrix takes glam's.
fn determinant(matrix: &Mat4) -> f32 {
    let affine = matrix.x_axis.w == 0.0 && matrix.y_axis.w == 0.0 && matrix.z_axis.w == 0.0 && matrix.w_axis.w == 1.0;
    if !affine {
        return matrix.determinant();
    }
    let (m00, m01, m02) = (matrix.x_axis.x, matrix.x_axis.y, matrix.x_axis.z);
    let (m10, m11, m12) = (matrix.y_axis.x, matrix.y_axis.y, matrix.y_axis.z);
    let (m20, m21, m22) = (matrix.z_axis.x, matrix.z_axis.y, matrix.z_axis.z);
    m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small deterministic generator (xorshift) for the matrices below.
    fn values(seed: u32, n: usize) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32) * 8.0 - 4.0
            })
            .collect()
    }

    #[test]
    fn the_affine_determinant_is_glams_to_the_bit_and_other_matrices_take_glams() {
        for seed in 1..2000 {
            let v = values(seed, 12);
            let affine = Mat4::from_cols_array(&[v[0], v[1], v[2], 0.0, v[3], v[4], v[5], 0.0, v[6], v[7], v[8], 0.0, v[9], v[10], v[11], 1.0]);
            let (ours, glams) = (determinant(&affine), affine.determinant());
            assert!(ours == glams && (ours == 0.0 || ours.to_bits() == glams.to_bits()), "seed {seed}: {ours} against {glams}");
        }
        let rows = [Mat4::from_scale(glam::Vec3::new(0.0, 1.0, 1.0)), Mat4::from_rotation_y(0.7) * Mat4::from_scale(glam::Vec3::splat(3.0)), Mat4::IDENTITY];
        for matrix in rows {
            assert_eq!(determinant(&matrix).to_bits(), matrix.determinant().to_bits());
        }
        let projective = Mat4::from_cols_array(&[1.0, 0.0, 0.0, 0.5, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(determinant(&projective).to_bits(), projective.determinant().to_bits(), "not affine: glam's");
        assert_eq!(instance_row(&Mat4::from_scale(glam::Vec3::ZERO).to_cols_array(), [0.0; 3], 1.0, 0).normal, Mat4::IDENTITY.to_cols_array(), "a flat model keeps the identity normal matrix");
    }
}
