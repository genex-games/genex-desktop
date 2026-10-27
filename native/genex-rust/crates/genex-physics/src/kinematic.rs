//! Kinematic interpolation (CONTRACT.md §7.2), computed by the neutral layer in f32 in the caller
//! frame, so a z-up world and its y-up turn get the same bits: over a step of `n` sub-steps a
//! kinematic body is at `lerp(p0, target, k/n)` and `nlerp(q0, target, k/n)` (shorter arc) after
//! sub-step k. The last sub-step lands on the target exactly, as given.
//!
//! The backend moves the body with the velocity that covers each sub-step's motion, then the core
//! places it on the interpolated pose exactly. The angular velocity uses libm's `atan2f`, the same
//! bits on every target.

/// A pose in the caller frame, as f32s.
pub(crate) type RawPose = ([f32; 3], [f32; 4]);

/// `a · (1 − f) + b · f`, exact at `f = 0` and `f = 1`.
fn lerp(a: f32, b: f32, f: f32) -> f32 {
    a * (1.0 - f) + b * f
}

fn dot4(a: [f32; 4], b: [f32; 4]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/// The pose after sub-step `k` of `n` from `start` toward `target` (§7.2): `start` itself at 0,
/// `target` itself at `n`.
pub(crate) fn pose_at(start: RawPose, target: RawPose, k: u32, n: u32) -> RawPose {
    if k == 0 {
        return start;
    }
    if k >= n {
        return target;
    }
    let f = k as f32 / n as f32;
    let (p0, q0) = start;
    let (p1, q1) = target;
    let p = [0, 1, 2].map(|i| lerp(p0[i], p1[i], f));
    let sign = if dot4(q0, q1) < 0.0 { -1.0 } else { 1.0 };
    let q = [0, 1, 2, 3].map(|i| lerp(q0[i], sign * q1[i], f));
    let norm = dot4(q, q).sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return (p, q0);
    }
    (p, q.map(|c| c / norm))
}

/// The linear and angular velocity that take `from` to `to` in `h` seconds (world frame).
pub(crate) fn velocity_between(from: RawPose, to: RawPose, h: f32) -> ([f32; 3], [f32; 3]) {
    let linvel = [0, 1, 2].map(|i| (to.0[i] - from.0[i]) / h);
    (linvel, angular_velocity(from.1, to.1, h))
}

/// The angular velocity of the rotation `dq = to · from⁻¹` spread over `h`, on its shorter arc.
fn angular_velocity(from: [f32; 4], to: [f32; 4], h: f32) -> [f32; 3] {
    let [ax, ay, az, aw] = to;
    let [bx, by, bz, bw] = [-from[0], -from[1], -from[2], from[3]];
    let mut dq = [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ];
    if dq[3] < 0.0 {
        dq = dq.map(|c| -c);
    }
    let sin_half = (dq[0] * dq[0] + dq[1] * dq[1] + dq[2] * dq[2]).sqrt();
    if sin_half == 0.0 || !sin_half.is_finite() {
        return [0.0; 3];
    }
    let angle = 2.0 * libm::atan2f(sin_half, dq[3]);
    let scale = angle / (sin_half * h);
    [dq[0] * scale, dq[1] * scale, dq[2] * scale]
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

    #[test]
    fn positions_interpolate_linearly_and_land_on_the_target() {
        let start = ([0.0, 0.0, 0.0], IDENTITY);
        let target = ([3.0, -6.0, 9.0], IDENTITY);
        assert_eq!(pose_at(start, target, 1, 3).0, [1.0, -2.0, 3.0]);
        assert_eq!(pose_at(start, target, 2, 3).0, [2.0, -4.0, 6.0]);
        assert_eq!(pose_at(start, target, 3, 3), target);
    }

    #[test]
    fn rotations_take_the_shorter_arc() {
        // +90° about z, written as its negated quaternion: halfway is still +45° about z.
        let half = std::f32::consts::FRAC_1_SQRT_2;
        let quarter_back = [0.0, 0.0, -half, -half];
        let (_, q) = pose_at(([0.0; 3], IDENTITY), ([0.0; 3], quarter_back), 1, 2);
        let expected = [0.0, 0.0, 0.382_683_43, 0.923_879_5];
        for i in 0..4 {
            assert!((q[i] - expected[i]).abs() < 1e-6, "{q:?}");
        }
    }

    #[test]
    fn the_angular_velocity_covers_the_rotation() {
        let half = std::f32::consts::FRAC_1_SQRT_2;
        let quarter_about_y = [0.0, half, 0.0, half];
        let (linvel, angvel) = velocity_between(([0.0; 3], IDENTITY), ([1.0, 0.0, 0.0], quarter_about_y), 0.5);
        assert_eq!(linvel, [2.0, 0.0, 0.0]);
        assert!((angvel[1] - std::f32::consts::PI).abs() < 1e-5 && angvel[0] == 0.0 && angvel[2] == 0.0, "{angvel:?}");
        assert_eq!(velocity_between(([0.0; 3], IDENTITY), ([0.0; 3], IDENTITY), 0.1).1, [0.0; 3]);
    }
}
