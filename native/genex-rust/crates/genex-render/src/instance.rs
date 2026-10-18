//! Instance-table rows. Every drawn instance (instanced or not, rigid or skinned, opaque or
//! transparent) is one row: its model and normal matrices, its world bounding sphere for the cull
//! and its material-table index. Opaque rows are grouped by batch (one batch per mesh, one per
//! skinned draw) so a batch is one contiguous range; transparent rows follow them.

use glam::{Mat4, Vec3};

use crate::layout::GpuInstance;

/// The row for a draw of a mesh whose model-space bounding sphere is `center`/`radius`.
pub fn instance_row(model: &[f32; 16], center: [f32; 3], radius: f32, material: u32) -> GpuInstance {
    let matrix = Mat4::from_cols_array(model);
    let normal = normal_matrix(&matrix);
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

/// The normal matrix of `matrix`: its inverse-transpose (the published v1 `GxInstance::normal`),
/// the identity for a flat model. For an affine model the upper 3x3 is the cofactor matrix
/// (columns `y x z`, `z x x`, `x x y` of the model's axes) over the determinant and the bottom row
/// is minus the translation through it, the inverse's translation (the meshlet cone cull takes the
/// transpose as the model's whole inverse): three cross products instead of a scalar 4x4 inverse
/// per row (renderer pass 2 A.0, LG-07 step 1, after Filament's `cofactor(mat3)`, Apache-2.0,
/// idea only). Any other matrix takes glam's inverse-transpose.
fn normal_matrix(matrix: &Mat4) -> Mat4 {
    let det = determinant(matrix);
    if det == 0.0 {
        return Mat4::IDENTITY;
    }
    if !is_affine(matrix) {
        return matrix.inverse().transpose();
    }
    let (x, y, z) = (matrix.x_axis.truncate(), matrix.y_axis.truncate(), matrix.z_axis.truncate());
    let translation = matrix.w_axis.truncate();
    let inverse = 1.0 / det;
    let column = |c: Vec3| (c * inverse).extend(-(c * inverse).dot(translation));
    Mat4::from_cols(column(y.cross(z)), column(z.cross(x)), column(x.cross(y)), glam::Vec4::W)
}

/// Whether `matrix`'s bottom row is 0, 0, 0, 1.
fn is_affine(matrix: &Mat4) -> bool {
    matrix.x_axis.w == 0.0 && matrix.y_axis.w == 0.0 && matrix.z_axis.w == 0.0 && matrix.w_axis.w == 1.0
}

/// `matrix`'s determinant as glam's [`Mat4::determinant`] computes it, with the terms an affine
/// matrix (bottom row 0, 0, 0, 1) multiplies by zero left out: the same value for every finite
/// affine model, at a third of the work (every instance row asks; pass-1 fix, the features-off
/// CPU time). Any other matrix takes glam's.
fn determinant(matrix: &Mat4) -> f32 {
    if !is_affine(matrix) {
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

    /// Pass 2 A.0 (LG-07 step 1) characterization: every row's normal matrix is glam's 4x4
    /// inverse-transpose to within float rounding, every entry (the meshlet cull's eye transform
    /// reads its translation row), for affine models of every scale, mirrored ones included.
    #[test]
    fn the_normal_matrix_is_the_inverse_transpose_of_the_model() {
        for seed in 1..4000 {
            let v = values(seed, 12);
            let model = [v[0], v[1], v[2], 0.0, v[3], v[4], v[5], 0.0, v[6], v[7], v[8], 0.0, v[9], v[10], v[11], 1.0];
            let matrix = Mat4::from_cols_array(&model);
            if matrix.determinant().abs() < 1.0e-3 {
                continue;
            }
            let want = matrix.inverse().transpose();
            let got = Mat4::from_cols_array(&instance_row(&model, [0.0; 3], 1.0, 0).normal);
            // Every entry: the meshlet cone cull reads the transpose as the whole inverse, the
            // translation's row included.
            for (column, (g, w)) in [(got.x_axis, want.x_axis), (got.y_axis, want.y_axis), (got.z_axis, want.z_axis), (got.w_axis, want.w_axis)].into_iter().enumerate() {
                let error = (g - w).length();
                assert!(error <= 2.0e-4 * w.length().max(1.0), "seed {seed} column {column}: {g} against {w}");
            }
            let n = glam::Vec3::new(0.3, -0.8, 0.52).normalize();
            let (a, b) = (got.transform_vector3(n).normalize(), want.transform_vector3(n).normalize());
            assert!(a.dot(b) > 1.0 - 1.0e-6, "seed {seed}: the shaded normal turns ({a} against {b})");
        }
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
