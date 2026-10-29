//! One light-and-look recipe per scene type: the sky and sun a frame draws under (`light`) and the
//! exposure, fog and grade on top of `genex.toml`'s `[render]` (`look`). Copy the two functions of
//! your scene into your game, then tune against a capture of your own level. `docs/look-recipes.md`
//! explains each number; the luma band each recipe is captured inside is `Scene::luma`.

use genex::prelude::*;
use genex::render::{Bloom, Clouds, Environment, Exposure, Fog, Grading, Metering, Moon, RenderConfig, SkyMedium, SkyParams};

/// The scene types this module has a recipe for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Scene {
    #[default]
    InteriorDay,
    InteriorNight,
    ExteriorDay,
    OvercastSnow,
    Rain,
    NightStreet,
    Forest,
    Desert,
}

impl Scene {
    /// Every scene, in the order the docs list them.
    pub const ALL: [Scene; 8] = [
        Scene::InteriorDay,
        Scene::InteriorNight,
        Scene::ExteriorDay,
        Scene::OvercastSnow,
        Scene::Rain,
        Scene::NightStreet,
        Scene::Forest,
        Scene::Desert,
    ];

    /// The scene's name, as its capture and its block in `docs/look-recipes.md` are called.
    pub fn name(self) -> &'static str {
        match self {
            Scene::InteriorDay => "interior-day",
            Scene::InteriorNight => "interior-night",
            Scene::ExteriorDay => "exterior-day",
            Scene::OvercastSnow => "overcast-snow",
            Scene::Rain => "rain",
            Scene::NightStreet => "night-street",
            Scene::Forest => "forest",
            Scene::Desert => "desert",
        }
    }

    /// Whether the scene is looked at from inside a room (its interior lights are on).
    pub fn indoors(self) -> bool {
        matches!(self, Scene::InteriorDay | Scene::InteriorNight)
    }

    /// Whether the scene is lit by night: lamps on, sun set.
    pub fn night(self) -> bool {
        matches!(self, Scene::InteriorNight | Scene::NightStreet)
    }

    /// The band (0..255, mean Rec. 709 luma of a settled ultra capture) the scene's main camera
    /// is held inside.
    pub fn luma(self) -> [f32; 2] {
        match self {
            Scene::InteriorDay => [90.0, 130.0],
            Scene::InteriorNight => [45.0, 85.0],
            Scene::ExteriorDay | Scene::Forest => [95.0, 140.0],
            Scene::OvercastSnow => [125.0, 175.0],
            Scene::Rain => [70.0, 110.0],
            Scene::NightStreet => [25.0, 65.0],
            Scene::Desert => [115.0, 160.0],
        }
    }

    /// The frame's sky, sun and flat fallbacks for this scene: call first in `on_draw`.
    pub fn light(self, frame: &mut Frame) {
        match self {
            Scene::InteriorDay => interior_day(frame),
            Scene::InteriorNight => interior_night(frame),
            Scene::ExteriorDay => exterior_day(frame),
            Scene::OvercastSnow => overcast_snow(frame),
            Scene::Rain => rain(frame),
            Scene::NightStreet => night_street(frame),
            Scene::Forest => forest(frame),
            Scene::Desert => desert(frame),
        }
    }

    /// The scene's exposure, fog and grade on top of `base` (pass `RenderConfig::from_build()`).
    pub fn look(self, base: RenderConfig) -> RenderConfig {
        match self {
            Scene::InteriorDay => interior_day_look(base),
            Scene::InteriorNight => interior_night_look(base),
            Scene::ExteriorDay => exterior_day_look(base),
            Scene::OvercastSnow => overcast_snow_look(base),
            Scene::Rain => rain_look(base),
            Scene::NightStreet => night_street_look(base),
            Scene::Forest => forest_look(base),
            Scene::Desert => desert_look(base),
        }
    }
}

// region: looks/interior-day
/// A room by day: a low sun falls in at the windows, the sky lights the rest through them.
pub fn interior_day(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 140, 160)).ambient(Color::rgb(170, 185, 210), 0.15);
    frame.sun(vec3(0.35, 0.32, 1.0), Color::WHITE, 3.0); // 17 degrees up: shafts reach the floor
    frame.environment(Environment::sky());
}

/// Auto exposure meters the room (the windows burn out, as a camera sees them), thin room fog.
pub fn interior_day_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(0.0).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.012).with_height(0.05, 0.0))
        .local_exposure(0.6, 0.8)
        .grading(Grading::NEUTRAL.with_contrast(1.05).with_saturation(0.95))
}
// endregion

// region: looks/interior-night
/// A room by night: the sun has set, the moon is up outside, the room's own lamps carry it.
pub fn interior_night(frame: &mut Frame) {
    frame.clear(Color::rgb(8, 10, 16)).ambient(Color::rgb(60, 70, 100), 0.02);
    frame.sun(vec3(0.3, -0.25, 1.0), Color::WHITE, 2.5); // below the horizon: stars come out
    let moon = Moon::new([-0.4, 0.5, 0.8]);
    frame.environment(Environment::Sky(SkyParams::default().with_moon(Some(moon))));
}

/// Auto exposure with a curve that keeps a dark meter dark, so night never reads as day.
pub fn interior_night_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Center).compensation(-1.0).range(-8.0, 8.0))
        .exposure_curve(&[(-8.0, -2.0), (-3.0, -0.8), (0.0, 0.0)])
        .fog(Fog::default().with_density(0.008).with_height(0.05, 0.0))
        .grading(Grading::NEUTRAL.with_contrast(1.08))
        .temperature(0.1, 0.0)
}
// endregion

// region: looks/exterior-day
/// Open ground at mid-morning: a high white sun, scattered cumulus, the physical sky.
pub fn exterior_day(frame: &mut Frame) {
    frame.clear(Color::rgb(130, 170, 220)).ambient(Color::rgb(180, 200, 230), 0.1);
    frame.sun(vec3(0.4, 1.0, 0.3), Color::WHITE, 2.5); // about 55 degrees up
    let clouds = Clouds::default().with_coverage(0.35);
    frame.environment(Environment::Sky(SkyParams::default().with_clouds(Some(clouds))));
}

/// A third of a stop over the meter for sunlight, a little aerial haze, a touch of vibrance.
pub fn exterior_day_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Ground).compensation(0.3).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.002).with_height(0.08, 0.0))
        .grading(Grading::NEUTRAL.with_vibrance(1.1))
}
// endregion

// region: looks/overcast-snow
/// Snow under a bright grey sky: a veiled sun, white ground (a terrain layer), falling flakes.
pub fn overcast_snow(frame: &mut Frame) {
    frame.clear(Color::rgb(200, 205, 212)).ambient(Color::rgb(210, 215, 225), 0.2);
    frame.sun(vec3(0.3, 0.6, 0.5), Color::WHITE, 2.5);
    let sky = SkyParams::overcast().with_ground_albedo([0.8, 0.82, 0.85]);
    frame.environment(Environment::Sky(sky));
}

/// Snow meters grey: open one stop over the meter so it reads white; cold, soft air.
pub fn overcast_snow_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(1.0).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.012).with_height(0.06, 0.0).with_color([0.85, 0.88, 0.92]))
        .temperature(-0.15, 0.0)
}
// endregion

// region: looks/rain
/// Rain: a dimmer overcast sky, no hard shadows, wet surfaces (low roughness) and drops.
pub fn rain(frame: &mut Frame) {
    frame.clear(Color::rgb(90, 96, 104)).ambient(Color::rgb(140, 150, 165), 0.12);
    frame.sun(vec3(-0.2, 0.7, 0.4), Color::WHITE, 2.5);
    frame.environment(Environment::Sky(SkyParams::overcast().with_intensity(0.6)));
}

/// Two thirds of a stop under the meter (a wet day is dim), thicker low fog, a cooler grade.
pub fn rain_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(-0.7).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.02).with_height(0.1, 0.0).with_color([0.6, 0.64, 0.7]))
        .grading(Grading::NEUTRAL.with_contrast(1.05).with_saturation(0.85))
        .temperature(-0.2, 0.0)
}
// endregion

// region: looks/night-street
/// A street at night: the sun well down, a moon, the street's lamps the main light.
pub fn night_street(frame: &mut Frame) {
    frame.clear(Color::rgb(4, 6, 12)).ambient(Color::rgb(40, 50, 80), 0.01);
    frame.sun(vec3(-0.3, -0.4, 1.0), Color::WHITE, 2.5);
    let moon = Moon::new([0.5, 0.6, -0.6]);
    frame.environment(Environment::Sky(SkyParams::default().with_moon(Some(moon)).with_stars(2e-5)));
}

/// A dark meter stays dark (the curve), lamps bloom a little, mist catches their light.
pub fn night_street_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(-0.2).range(-8.0, 8.0))
        .exposure_curve(&[(-8.0, -2.5), (-3.0, -1.0), (0.0, 0.0)])
        .fog(Fog::default().with_density(0.015).with_height(0.08, 0.0))
        .bloom(Bloom::new(0.06))
}
// endregion

// region: looks/forest
/// A forest clearing: a sun through broken cloud, green ground bounce, deep air.
pub fn forest(frame: &mut Frame) {
    frame.clear(Color::rgb(120, 150, 170)).ambient(Color::rgb(150, 175, 150), 0.1);
    frame.sun(vec3(0.5, 0.8, -0.2), Color::WHITE, 2.5); // about 40 degrees up
    let sky = SkyParams::default().with_ground_albedo([0.1, 0.14, 0.06]);
    frame.environment(Environment::Sky(sky.with_clouds(Some(Clouds::default().with_coverage(0.5)))));
}

/// The meter as it is (shade and sun patches sit together), volumetric air for shafts.
pub fn forest_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Average).compensation(0.3).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.015).with_height(0.1, 0.0))
        .grading(Grading::NEUTRAL.with_vibrance(1.05))
}
// endregion

// region: looks/desert
/// Desert noon: a high hard sun, warm sand bounce, a dusty horizon.
pub fn desert(frame: &mut Frame) {
    frame.clear(Color::rgb(170, 190, 215)).ambient(Color::rgb(220, 200, 170), 0.1);
    frame.sun(vec3(0.2, 1.0, 0.1), Color::WHITE, 2.8); // about 75 degrees up
    let sky = SkyParams::default().with_medium(SkyMedium::earth()).with_ground_albedo([0.45, 0.35, 0.22]);
    frame.environment(Environment::Sky(sky));
}

/// Half a stop over the meter for bright sand, warm haze far off, a warm grade.
pub fn desert_look(base: RenderConfig) -> RenderConfig {
    base.exposure(Exposure::auto().metering(Metering::Ground).compensation(0.5).range(-8.0, 8.0))
        .fog(Fog::default().with_density(0.004).with_height(0.05, 0.0).with_color([1.0, 0.92, 0.8]))
        .temperature(0.2, 0.0)
}
// endregion
