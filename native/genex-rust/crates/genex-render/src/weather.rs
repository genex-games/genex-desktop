//! Weather presets (AAA materials lane, review WP-13 and 3.5): falling snow, rain and blowing dust
//! as two camera-following particle layers each, lit by the sun through its shadows and the sky,
//! varied in size, carried by gusts, and the cover each lays on the world's materials.
//!
//! - **Near layer:** a small box around the camera (a few metres) at a high density, so flakes
//!   and drops pass close by the lens with parallax, as they do in weather.
//! - **Far layer:** a large box (tens of metres) at a low density, so the weather fills the view
//!   to the distance without the near layer's count.
//!
//! Both follow the camera ([`EmitterDesc::follow_camera`]): every particle is wrapped into its box
//! around the view, so the density holds wherever the camera goes and a game never moves an
//! emitter. The densities are particles per cubic metre of the box ([`WeatherKind::densities`]);
//! the counts stay within one emitter's [`PARTICLES_PER_EMITTER_MAX`], and phones draw every n-th
//! slot under their class's cap ([`crate::particles::particle_cap`]).
//!
//! A weather's cover ([`WeatherKind::cover_after`]) grows with the time it has fallen: snow
//! whitens what faces up, rain wets every face, dust settles on ledges ([`crate::layers::Cover`]).

use crate::layers::Cover;
use crate::limits::PARTICLES_PER_EMITTER_MAX;
use crate::particles::{DepthCollision, EmitterDesc};

/// Ticks a second (velocities are world units a tick).
const TICKS_PER_SECOND: f32 = 60.0;

/// A weather preset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeatherKind {
    /// Light snow: sparse flakes drifting down at 0.8 m/s in a faint breeze.
    LightSnow,
    /// Heavy snow: dense flakes at 1.1 m/s, a steady wind with gusts.
    HeavySnow,
    /// A blizzard: driven snow at 9 m/s across the view with strong gusts.
    Blizzard,
    /// Rain: streaks falling 9 m/s, stopped by roofs and the ground.
    Rain,
    /// Drizzle: fine short streaks falling 3.5 m/s.
    Drizzle,
    /// Blowing dust: specks carried 4 m/s by a gusting wind, and slow soft haze puffs.
    Dust,
}

impl WeatherKind {
    /// Every preset.
    pub const ALL: [WeatherKind; 6] = [WeatherKind::LightSnow, WeatherKind::HeavySnow, WeatherKind::Blizzard, WeatherKind::Rain, WeatherKind::Drizzle, WeatherKind::Dust];

    /// Its two layers' looks (near, far) as the table below them states.
    fn shape(self) -> [Layer; 2] {
        match self {
            WeatherKind::LightSnow => [Layer::snow([4.0, 3.0, 4.0], 4_000, 0.02, 0.8), Layer::snow([24.0, 10.0, 24.0], 9_000, 0.03, 0.8)],
            WeatherKind::HeavySnow => [Layer::snow([4.0, 3.0, 4.0], 12_000, 0.026, 1.1), Layer::snow([24.0, 10.0, 24.0], 16_000, 0.036, 1.1)],
            WeatherKind::Blizzard => [Layer::snow([4.0, 3.0, 4.0], 16_000, 0.02, 1.6), Layer::snow([20.0, 8.0, 20.0], 16_000, 0.028, 1.6)],
            WeatherKind::Rain => [Layer::rain([5.0, 4.0, 5.0], 9_600, 0.012, 9.0), Layer::rain([20.0, 10.0, 20.0], 12_000, 0.016, 9.0)],
            WeatherKind::Drizzle => [Layer::rain([4.0, 3.0, 4.0], 12_000, 0.005, 3.5), Layer::rain([16.0, 8.0, 16.0], 6_000, 0.007, 3.5)],
            WeatherKind::Dust => [Layer::dust([5.0, 3.0, 5.0], 3_000, 0.006), Layer::haze([24.0, 6.0, 24.0], 3_000, 0.5)],
        }
    }

    /// The wind it blows (metres a second along x and z), its gusts' peak extra speed (m/s, along
    /// the wind) and their period in seconds.
    fn wind(self) -> ([f32; 2], f32, f32) {
        match self {
            WeatherKind::LightSnow => ([0.3, 0.1], 0.6, 6.0),
            WeatherKind::HeavySnow => ([1.0, 0.3], 1.5, 5.0),
            WeatherKind::Blizzard => ([9.0, 2.0], 6.0, 4.0),
            WeatherKind::Rain => ([0.5, 0.2], 1.5, 5.0),
            WeatherKind::Drizzle => ([0.4, 0.1], 0.8, 6.0),
            WeatherKind::Dust => ([4.0, 1.0], 3.0, 3.5),
        }
    }

    /// The near and far layers, `seed` and `seed + 1` their spawn patterns: both follow the
    /// camera, lit, varied in size, carried by the wind and its gusts.
    pub fn layers(self, seed: u32) -> [EmitterDesc; 2] {
        let ([wx, wz], gust, period) = self.wind();
        let shapes = self.shape();
        std::array::from_fn(|at| {
            let layer = shapes[at];
            let mut desc = layer.desc(seed.wrapping_add(at as u32));
            desc.velocity[0] += wx / TICKS_PER_SECOND;
            desc.velocity[2] += wz / TICKS_PER_SECOND;
            let along = (wx * wx + wz * wz).sqrt().max(1e-6);
            desc.gust = [gust * wx / along / TICKS_PER_SECOND, 0.0, gust * wz / along / TICKS_PER_SECOND];
            desc.gust_period = period * TICKS_PER_SECOND;
            desc
        })
    }

    /// Particles per cubic metre of its near and far boxes.
    pub fn densities(self) -> [f32; 2] {
        self.layers(1).map(|desc| {
            let [x, y, z] = desc.extent;
            desc.slots() as f32 / (8.0 * x * y * z)
        })
    }

    /// The cover it has laid after falling for `seconds` (0 or less, or not finite: none): snow
    /// whitens what faces up to its slope, rain and drizzle wet every face, dust settles on
    /// ledges, each reaching its whole amount after [`WeatherKind::seconds_to_cover`].
    pub fn cover_after(self, seconds: f32) -> Option<Cover> {
        if !seconds.is_finite() || seconds <= 0.0 {
            return None;
        }
        let amount = (seconds / self.seconds_to_cover()).min(1.0);
        let base = match self {
            WeatherKind::LightSnow | WeatherKind::HeavySnow | WeatherKind::Blizzard => Cover::SNOW,
            WeatherKind::Rain | WeatherKind::Drizzle => Cover::WET,
            WeatherKind::Dust => Cover::DUST,
        };
        Some(Cover { amount, ..base })
    }

    /// Seconds it takes to lay its whole cover.
    pub fn seconds_to_cover(self) -> f32 {
        match self {
            WeatherKind::LightSnow => 1200.0,
            WeatherKind::HeavySnow => 360.0,
            WeatherKind::Blizzard => 180.0,
            WeatherKind::Rain => 120.0,
            WeatherKind::Drizzle => 360.0,
            WeatherKind::Dust => 1800.0,
        }
    }
}

/// One layer's look before the wind: what falls, its box and count, its size and fall speed.
#[derive(Clone, Copy, Debug)]
struct Layer {
    base: Base,
    /// Half the sides of its box around the camera.
    extent: [f32; 3],
    /// Particles alive (at most [`PARTICLES_PER_EMITTER_MAX`]).
    count: u32,
    /// Its particles' size, metres.
    size: f32,
    /// How fast they fall, metres a second.
    fall: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Base {
    Snow,
    Rain,
    Dust,
    Haze,
}

/// Ticks a weather particle lives before it is born again elsewhere in its box.
const LIFETIME_TICKS: u32 = 480;
/// Where a layer's box sits above the camera (most of the weather is above the eye).
const BOX_LIFT: f32 = 0.35;

impl Layer {
    fn snow(extent: [f32; 3], count: u32, size: f32, fall: f32) -> Layer {
        Layer { base: Base::Snow, extent, count, size, fall }
    }

    fn rain(extent: [f32; 3], count: u32, size: f32, fall: f32) -> Layer {
        Layer { base: Base::Rain, extent, count, size, fall }
    }

    fn dust(extent: [f32; 3], count: u32, size: f32) -> Layer {
        Layer { base: Base::Dust, extent, count, size, fall: 0.02 }
    }

    fn haze(extent: [f32; 3], count: u32, size: f32) -> Layer {
        Layer { base: Base::Haze, extent, count, size, fall: 0.0 }
    }

    /// The emitter: `count` alive over [`LIFETIME_TICKS`], following the camera in its box lifted
    /// by [`BOX_LIFT`] of its height.
    fn desc(self, seed: u32) -> EmitterDesc {
        let count = self.count.min(PARTICLES_PER_EMITTER_MAX);
        let rate = (count / LIFETIME_TICKS).max(1);
        let lifted = [0.0, self.extent[1] * BOX_LIFT, 0.0];
        let common = EmitterDesc {
            extent: self.extent,
            velocity: [0.0, -self.fall / TICKS_PER_SECOND, 0.0],
            gravity: [0.0; 3],
            size: self.size,
            size_end: 1.0,
            rate_per_tick: rate,
            lifetime_ticks: LIFETIME_TICKS,
            follow_camera: true,
            lit: 1.0,
            ..EmitterDesc::fountain(lifted, seed)
        };
        match self.base {
            Base::Snow => EmitterDesc {
                speed_jitter: 0.2,
                spread: 0.002,
                color_start: [240, 244, 255, 220],
                color_end: [240, 244, 255, 220],
                size_variance: 0.55,
                flutter: [0.15, 150.0],
                soft_distance: 0.1,
                near_fade: 0.3,
                collision: Some(DepthCollision { thickness: 0.8, rest_ticks: 30 }),
                ..common
            },
            Base::Rain => EmitterDesc {
                speed_jitter: 0.1,
                spread: 0.003,
                color_start: [200, 210, 225, 110],
                color_end: [200, 210, 225, 110],
                size_variance: 0.3,
                stretch: 1.6,
                soft_distance: 0.05,
                near_fade: 0.6,
                lit: 0.7,
                collision: Some(DepthCollision { thickness: 0.6, rest_ticks: 0 }),
                ..common
            },
            Base::Dust => EmitterDesc {
                speed_jitter: 0.4,
                spread: 0.004,
                color_start: [200, 172, 132, 150],
                color_end: [200, 172, 132, 150],
                size_variance: 0.6,
                flutter: [0.3, 90.0],
                soft_distance: 0.05,
                near_fade: 0.3,
                ..common
            },
            Base::Haze => EmitterDesc {
                speed_jitter: 0.3,
                spread: 0.001,
                color_start: [190, 165, 130, 26],
                color_end: [190, 165, 130, 26],
                size_variance: 0.5,
                rotation_jitter: std::f32::consts::PI,
                spin: 0.002,
                soft_distance: 1.5,
                near_fade: 2.0,
                ..common
            },
        }
    }
}
