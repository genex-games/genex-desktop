//! The lakeside's time of day (renderer pass 2 B.12): the golden hour it was made for (the default),
//! a clear day with the sun high over the lake, and a moonlit night under the stars. N steps through
//! them. Each is only the sky's sun and moon: the frame's sun is the sun wherever it stands (below
//! the horizon at night, where the planet hides it), and the physical sky lights the ground with
//! the brighter of the sun and the moon, so at night the full moon over the lake lights the meadow
//! and casts the trees' shadows, and the lanterns, the windows and the hearth carry the picture.

use genex::math::{Vec3, vec3};
use genex::render::{Environment, Moon, SkyParams};

/// The clear day's sun: the golden hour's azimuth, 50 degrees up.
pub const DAY_SUN_DIR: Vec3 = vec3(0.514, 0.766, 0.386);
/// The moon low over the lake's far shore, 7 degrees up, where both wide shots look across the
/// water: the sun stands opposite it under the horizon, so it is full.
pub const MOON_DIR: Vec3 = vec3(0.993, 0.122, 0.0);
/// The night's sun: opposite the moon, 7 degrees under the horizon (the night is wholly drawn
/// from about 6 degrees under it).
pub const NIGHT_SUN_DIR: Vec3 = vec3(-0.993, -0.122, 0.0);
/// The moon's disk, in degrees of angular radius: larger than the real one (0.26) so it reads in a
/// wide shot, as a camera's long lens would draw it.
const MOON_DEGREES: f32 = 0.9;
/// The full moon's light as a share of the sun's: a bright moonlit night (the renderer's default
/// 0.004 is about 8 EV under the sun; this is about 6.4).
const MOONLIGHT: f32 = 0.012;
/// The moonlight's tint: the low moon's light crosses much of the air and reaches the meadow
/// reddened, so it is cooled further than the renderer's default (0.8, 0.9, 1.0) to read as
/// moonlight.
const MOON_TINT: [f32; 3] = [0.55, 0.72, 1.0];
/// The star field's mean radiance: a clear country sky.
const STARS: f32 = 4e-5;
/// The flat fill (where the device's quality turns image-based light off) against the dusk's: the
/// day's sky is brighter, the night's far darker.
const DAY_AMBIENT: f32 = 1.6;
const NIGHT_AMBIENT: f32 = 0.06;
/// Auto exposure's compensation curve, `(metered EV, compensation EV)`: the golden hour, the day
/// and the cabin's lamplit room meter above EV -4 and are left alone; the moonlit night meters far
/// under it and is lifted only part of the way, so it stays a night (a free exposure drew it as a
/// dim grey day).
pub const EXPOSURE_CURVE: [(f32, f32); 2] = [(-10.0, -4.0), (-4.0, 0.0)];

/// The lakeside's time of day.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeOfDay {
    /// A clear day, the sun high.
    Day,
    /// The golden hour the scene was made for (the default).
    #[default]
    Dusk,
    /// The moonlit night.
    Night,
}

impl TimeOfDay {
    /// Its name for the HUD, the `view` probe and the captures.
    pub fn label(self) -> &'static str {
        match self {
            TimeOfDay::Day => "day",
            TimeOfDay::Dusk => "dusk",
            TimeOfDay::Night => "night",
        }
    }

    /// The next one (N).
    pub fn next(self) -> TimeOfDay {
        match self {
            TimeOfDay::Dusk => TimeOfDay::Night,
            TimeOfDay::Night => TimeOfDay::Day,
            TimeOfDay::Day => TimeOfDay::Dusk,
        }
    }

    /// The direction towards the sun (below the horizon at night).
    pub fn sun_dir(self) -> Vec3 {
        match self {
            TimeOfDay::Day => DAY_SUN_DIR,
            TimeOfDay::Dusk => crate::layout::SUN_DIR,
            TimeOfDay::Night => NIGHT_SUN_DIR,
        }
    }

    /// The flat fill's intensity against the dusk's `dusk`.
    pub fn ambient(self, dusk: f32) -> f32 {
        match self {
            TimeOfDay::Day => dusk * DAY_AMBIENT,
            TimeOfDay::Dusk => dusk,
            TimeOfDay::Night => dusk * NIGHT_AMBIENT,
        }
    }

    /// `environment` at this time: the physical sky gains the moon and the stars at night (an HDR
    /// map is drawn as it is).
    pub fn environment(self, environment: Environment) -> Environment {
        match (self, environment) {
            (TimeOfDay::Night, Environment::Sky(sky)) => Environment::Sky(night_sky(sky)),
            (_, environment) => environment,
        }
    }
}

/// `sky` with the full moon over the lake and the stars.
fn night_sky(sky: SkyParams) -> SkyParams {
    let moon = Moon::new(MOON_DIR.to_array()).with_angular_radius_degrees(MOON_DEGREES).with_moonlight(MOONLIGHT).with_tint(MOON_TINT);
    sky.with_moon(Some(moon)).with_stars(STARS)
}
