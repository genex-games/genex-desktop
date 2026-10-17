//! The shared wind (renderer pass 2, B.7; A.8's A4.3 wind field builds on it): one gust and one
//! flutter field over the world, a function of a plant's root and simulated seconds only, so a
//! vertex animation evaluates it at this frame's time and at last frame's and draws its own motion
//! vectors ([`crate::custom_pass::PassFrame::motion_draws`]). [`WIND_WGSL`] is the GPU side (in the
//! v2 custom-pass tables, [`crate::custom_pass::TABLES_V2_WGSL`]); [`wind`] is its CPU twin.

/// The WGSL of the shared wind (`gx_wind`, `GxWind`, `GX_WIND_DIR`).
pub const WIND_WGSL: &str = include_str!("../shaders/wind.wgsl");

/// The wind's direction over the ground (unit, y 0): `GX_WIND_DIR`.
pub const WIND_DIR: [f32; 3] = [0.552_380_4, 0.0, 0.833_592_2];

/// The wind at one plant at one time: `GxWind`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wind {
    /// The slow gust, 0.0..1.0 (0.5 on average): how far the wind leans a stem.
    pub gust: f32,
    /// The fast flutter, -1.0..1.0: a stem's quick shiver.
    pub flutter: f32,
}

/// `gx_wind`: the wind at a plant rooted at `root`, `t` simulated seconds in.
pub fn wind(root: [f32; 3], t: f32) -> Wind {
    let [x, _, z] = root;
    let gust = 0.5 + 0.3 * libm::sinf(t * 1.6 + x * 0.21 + z * 0.13) + 0.2 * libm::sinf(t * 0.55 + x * 0.045 - z * 0.03);
    let flutter = libm::sinf(t * 4.0 + x * 1.7 + z * 1.3);
    Wind { gust, flutter }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wind_direction_is_a_unit_vector_along_the_ground() {
        let [x, y, z] = WIND_DIR;
        assert_eq!(y, 0.0);
        assert!((x * x + z * z - 1.0).abs() < 1e-6);
        assert!(WIND_WGSL.contains("vec3<f32>(0.55238038, 0.0, 0.83359218)"), "the WGSL constant is the CPU one");
    }

    #[test]
    fn the_gust_stays_within_its_range_and_moves_with_time() {
        let root = [3.0, 0.0, -7.0];
        let samples: Vec<Wind> = (0..600).map(|tick| wind(root, tick as f32 / 60.0)).collect();
        assert!(samples.iter().all(|w| (0.0..=1.0).contains(&w.gust) && (-1.0..=1.0).contains(&w.flutter)));
        assert_ne!(samples[0], samples[1], "the wind moves from one tick to the next");
        assert_eq!(wind(root, 2.5), wind(root, 2.5), "a function of root and time only");
    }
}
