//! The axis mapping (CONTRACT.md §5). The core's frame is right-handed and Y-up. For `upAxis: "z"`
//! a caller vector (x, y, z) is internal (x, z, −y), and back (x, y, z) → (x, −z, y); a quaternion's
//! vector part maps the same way and `w` is unchanged. Only swaps and sign flips, so bit-exact.

use crate::types::{Axis, UpAxis};

/// A caller vector or point in the core's frame.
pub(crate) fn vec_in(up: UpAxis, v: [f32; 3]) -> [f32; 3] {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], v[2], -v[1]],
    }
}

/// A core vector or point in the caller's frame.
pub(crate) fn vec_out(up: UpAxis, v: [f32; 3]) -> [f32; 3] {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], -v[2], v[1]],
    }
}

/// A caller quaternion `[x, y, z, w]` in the core's frame.
pub(crate) fn quat_in(up: UpAxis, q: [f32; 4]) -> [f32; 4] {
    let [x, y, z] = vec_in(up, [q[0], q[1], q[2]]);
    [x, y, z, q[3]]
}

/// A core quaternion `[x, y, z, w]` in the caller's frame.
pub(crate) fn quat_out(up: UpAxis, q: [f32; 4]) -> [f32; 4] {
    let [x, y, z] = vec_out(up, [q[0], q[1], q[2]]);
    [x, y, z, q[3]]
}

/// Caller extents (half-extents, a heightfield's size) in the core's frame: the same permutation
/// as [`vec_in`] without its sign, since an extent has no direction.
pub(crate) fn extent_in(up: UpAxis, v: [f32; 3]) -> [f32; 3] {
    match up {
        UpAxis::Y => v,
        UpAxis::Z => [v[0], v[2], v[1]],
    }
}

/// A caller axis as the core's axis (a capsule is symmetric, so the sign of −y is dropped).
pub(crate) fn axis_in(up: UpAxis, axis: Axis) -> Axis {
    match (up, axis) {
        (UpAxis::Z, Axis::Y) => Axis::Z,
        (UpAxis::Z, Axis::Z) => Axis::Y,
        _ => axis,
    }
}

/// Per-axis flags of the caller (`lockRotation`) as the core's per-axis flags.
pub(crate) fn flags_in(up: UpAxis, flags: [bool; 3]) -> [bool; 3] {
    match up {
        UpAxis::Y => flags,
        UpAxis::Z => [flags[0], flags[2], flags[1]],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Finite values with awkward bits: signed zeros, subnormals, extremes and ordinary numbers.
    const AWKWARD: [f32; 10] = [
        0.0,
        -0.0,
        1.0,
        -1.5,
        f32::MIN_POSITIVE,
        -1.0e-45,
        f32::MAX,
        f32::MIN,
        0.1,
        -39.37,
    ];

    fn bits3(v: [f32; 3]) -> [u32; 3] {
        v.map(f32::to_bits)
    }

    fn bits4(q: [f32; 4]) -> [u32; 4] {
        q.map(f32::to_bits)
    }

    #[test]
    fn z_up_vectors_map_to_x_z_minus_y_and_back_bit_for_bit() {
        for &a in &AWKWARD {
            for &b in &AWKWARD {
                let v = [a, b, -a];
                let inside = vec_in(UpAxis::Z, v);
                assert_eq!(bits3(inside), bits3([v[0], v[2], -v[1]]));
                assert_eq!(bits3(vec_out(UpAxis::Z, inside)), bits3(v));
                let outside = vec_out(UpAxis::Z, v);
                assert_eq!(bits3(outside), bits3([v[0], -v[2], v[1]]));
                assert_eq!(bits3(vec_in(UpAxis::Z, outside)), bits3(v));
            }
        }
    }

    #[test]
    fn z_up_quaternions_map_the_vector_part_and_keep_w_bit_for_bit() {
        for &a in &AWKWARD {
            for &b in &AWKWARD {
                let q = [a, b, -b, a];
                let inside = quat_in(UpAxis::Z, q);
                assert_eq!(bits4(inside), bits4([q[0], q[2], -q[1], q[3]]));
                assert_eq!(bits4(quat_out(UpAxis::Z, inside)), bits4(q));
                assert_eq!(bits4(quat_in(UpAxis::Z, quat_out(UpAxis::Z, q))), bits4(q));
            }
        }
    }

    #[test]
    fn y_up_maps_nothing() {
        let v = [-0.0, 2.5, f32::MAX];
        assert_eq!(bits3(vec_in(UpAxis::Y, v)), bits3(v));
        assert_eq!(bits3(vec_out(UpAxis::Y, v)), bits3(v));
        assert_eq!(bits4(quat_in(UpAxis::Y, [1.0, -0.0, 0.5, 0.25])), bits4([1.0, -0.0, 0.5, 0.25]));
    }

    #[test]
    fn z_up_is_the_rotation_of_ninety_degrees_about_x() {
        // Caller up (0, 0, 1) is internal up (0, 1, 0); caller +y is internal −z.
        assert_eq!(vec_in(UpAxis::Z, [0.0, 0.0, 1.0]), [0.0, 1.0, 0.0]);
        assert_eq!(vec_in(UpAxis::Z, [0.0, 1.0, 0.0]), [0.0, 0.0, -1.0]);
        assert_eq!(vec_in(UpAxis::Z, [1.0, 0.0, 0.0]), [1.0, 0.0, 0.0]);
    }

    #[test]
    fn axes_and_flags_follow_the_mapping() {
        assert_eq!(axis_in(UpAxis::Z, Axis::Z), Axis::Y);
        assert_eq!(axis_in(UpAxis::Z, Axis::Y), Axis::Z);
        assert_eq!(axis_in(UpAxis::Z, Axis::X), Axis::X);
        assert_eq!(axis_in(UpAxis::Y, Axis::Y), Axis::Y);
        assert_eq!(flags_in(UpAxis::Z, [true, false, true]), [true, true, false]);
        assert_eq!(flags_in(UpAxis::Y, [true, false, true]), [true, false, true]);
    }
}
