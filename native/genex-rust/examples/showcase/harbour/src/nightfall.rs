//! Harbour Street's time of day (renderer pass 2 B.12, plan section 6's day and night toggle): the
//! dusk after the rain it was made for (the default), a clear day with the sun high over the
//! roofs, and the night, the street still wet, a full moon low over its far end and the stars over
//! the roofs. N steps through them. Each is only the sky's sun and moon: the frame's sun is the sun
//! wherever it stands (under the horizon at night), and the physical sky lights the street with the
//! brighter of the sun and the moon, so at night the neon, the festoons, the street lamps and the
//! café's pendants carry the picture and the wet asphalt and the puddles hold their light.

use genex::math::{Vec3, vec3};
use genex::prelude::Color;
use genex::render::{Environment, Moon, SkyParams};

use crate::harbour::World;
use crate::street::{Surfaces, Weather, WeatherColors};

/// The clear day's sun: the dusk sun's azimuth, 55 degrees up.
pub const DAY_SUN_DIR: Vec3 = vec3(0.057, 0.819, -0.571);
/// The full moon low over the street's far end, 15 degrees up, where the street-wide shot looks:
/// the sun stands opposite it under the horizon, so it is full.
pub const MOON_DIR: Vec3 = vec3(0.95, 0.26, 0.17);
/// The night's sun: opposite the moon, 15 degrees under the horizon.
pub const NIGHT_SUN_DIR: Vec3 = vec3(-0.95, -0.26, -0.17);
/// The moon's disk, in degrees of angular radius: larger than the real one (0.26) so it reads over
/// the roofs, as a long lens draws it.
const MOON_DEGREES: f32 = 0.9;
/// The full moon's light as a share of the sun's (the renderer's default, about 8 EV under it):
/// the street's own lights outshine it.
const MOONLIGHT: f32 = 0.004;
/// The star field's mean radiance: a city's sky, fainter than the country's.
const STARS: f32 = 2e-5;
/// The flat fill (where the device's quality turns image-based light off) against the dusk's.
const DAY_AMBIENT: f32 = 1.6;
const NIGHT_AMBIENT: f32 = 0.08;
/// Auto exposure's compensation curve, `(metered EV, compensation EV)`: the dusk, the day and the
/// café's lamplit room meter above EV -4 and are left alone; the night meters far under it and is
/// lifted only part of the way, so the street stays dark between its lights.
pub const EXPOSURE_CURVE: [(f32, f32); 2] = [(-10.0, -4.0), (-4.0, 0.0)];

/// The night's weather colours: the dusk's drizzle and steam are the light the picture shows, so
/// against the night's darker street they drew as a glowing white column and a bright veil; at
/// night they take about half the dusk's light.
pub const NIGHT_WEATHER: WeatherColors = WeatherColors { rain: Color::rgba(42, 46, 56, 40), steam_start: Color::rgba(28, 29, 33, 22), steam_end: Color::rgba(24, 25, 29, 0) };

/// The street's steam and drizzle in the night's colours ([`NIGHT_WEATHER`]).
#[derive(Clone, Debug)]
pub struct NightWeather(pub Weather);

impl Default for NightWeather {
    fn default() -> NightWeather {
        NightWeather(Weather::colored(NIGHT_WEATHER))
    }
}

/// The night's street: it rained again, so the asphalt's and the pavement's scanned roughness are
/// lowered further than the dusk's (0.55 and 0.8): the lamps, the festoons and the neon draw long
/// highlights down the wet road.
const SOAKED_ASPHALT: f32 = 0.3;
const SOAKED_PAVING: f32 = 0.55;

/// The street's surfaces at night ([`SOAKED_ASPHALT`], [`SOAKED_PAVING`]).
#[derive(Clone, Debug)]
pub struct NightSurfaces(pub Surfaces);

impl Default for NightSurfaces {
    fn default() -> NightSurfaces {
        NightSurfaces(Surfaces::soaked(SOAKED_ASPHALT, SOAKED_PAVING))
    }
}

/// Harbour Street's time of day.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeOfDay {
    /// A clear day, the sun high.
    Day,
    /// The dusk after the rain (the default).
    #[default]
    Dusk,
    /// The night after the rain.
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

    /// The direction towards the sun (under the horizon at night).
    pub fn sun_dir(self) -> Vec3 {
        match self {
            TimeOfDay::Day => DAY_SUN_DIR,
            TimeOfDay::Dusk => crate::street::SUN_DIR,
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

    /// The weather `world` draws at this time.
    pub fn weather(self, world: &World) -> &Weather {
        match self {
            TimeOfDay::Night => &world.night_weather.0,
            TimeOfDay::Day | TimeOfDay::Dusk => &world.weather,
        }
    }

    /// The surfaces `world` draws at this time.
    pub fn surfaces(self, world: &World) -> &Surfaces {
        match self {
            TimeOfDay::Night => &world.night_surfaces.0,
            TimeOfDay::Day | TimeOfDay::Dusk => &world.surfaces,
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

/// `sky` with the full moon over the street and the stars.
fn night_sky(sky: SkyParams) -> SkyParams {
    let moon = Moon::new(MOON_DIR.to_array()).with_angular_radius_degrees(MOON_DEGREES).with_moonlight(MOONLIGHT);
    sky.with_moon(Some(moon)).with_stars(STARS)
}
