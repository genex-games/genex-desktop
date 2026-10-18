//! The sky's night (renderer pass 2 B.2): a moon with its phase and earthshine, the sky it lights,
//! and a procedural star field. The sky's background draws them (`sky/sky_draw.wgsl`) and the
//! environment cube takes the moonlit sky and the stars (`cs_sky_cube`), so reflections and the
//! night's ambient light see them; they take no forward binding.
//!
//! Built from the ideas of Filament's analytic skybox sample (`simulated_skybox.mat`, Apache-2.0):
//! a moon whose lit part follows the sun, a dark side lit by earthshine, and hashed stars. No star
//! catalogue is shipped (takram's `stars.bin` has no stated provenance): the field is a jittered
//! grid on the cube's faces, one star at most per cell, its brightness drawn from a power law
//! (about three times as many stars per magnitude), each a Gaussian at least a pixel wide whose flux
//! does not depend on the resolution, so a star neither flickers under jitter nor sparkles as the
//! camera turns.
//!
//! The moon is lit by the sun: under the sky keep the sun's intensity and let it set; the planet
//! hides it. Its disk is as bright as the physical moon (a grey Lommel-Seeliger sphere of albedo
//! [`MOON_ALBEDO`]), so by day it is pale against the blue. Its light, the moonlit sky and the light
//! the moon casts on the ground, is the sun's times [`Moon::moonlight`] (an art choice: the real
//! moon is about 19 EV under the sun, too dark to play in) times its phase, and fades in as the sun
//! sets ([`night_factor`]): by day nothing of the night is drawn, so a day frame is byte-identical
//! to one without a moon or stars.

use bytemuck::{Pod, Zeroable};

/// The moon's default angular radius, in degrees (the real moon's).
pub const DEFAULT_MOON_ANGULAR_RADIUS_DEG: f32 = 0.26;
/// The largest angular radius a moon may take, in degrees.
pub const MOON_ANGULAR_RADIUS_MAX_DEG: f32 = 5.0;
/// The default moonlight: the full moon's light as a share of the sun's (about 8 EV under it).
pub const DEFAULT_MOONLIGHT: f32 = 0.004;
/// The largest moonlight share.
pub const MOONLIGHT_MAX: f32 = 1.0;
/// The default tint on the moon's light (a cool moonlit night; the disk stays grey).
pub const DEFAULT_MOON_TINT: [f32; 3] = [0.8, 0.9, 1.0];
/// The default earthshine: the dark side's radiance as a share of the full moon's.
pub const DEFAULT_EARTHSHINE: f32 = 0.003;
/// The moon's albedo (its disk's radiance at full phase is `albedo × E_sun / π`).
pub const MOON_ALBEDO: f32 = 0.12;
/// The star field's default mean radiance, in scene units (beside the default sun of 2.5).
pub const DEFAULT_STARS: f32 = 2e-5;
/// The largest star-field mean radiance.
pub const STARS_MAX: f32 = 1.0;
/// Star cells per side of each cube face (one star at most per cell).
pub const STAR_CELLS_PER_FACE: u32 = 128;
/// The sine of the sun's depression below the horizon over which the night fades in (0 at the
/// horizon, whole about 6 degrees below it: civil dusk).
pub const NIGHT_FADE_SINE: f32 = 0.1;

/// A moon in the physical sky ([`crate::settings::SkyParams::with_moon`]): where it is, how big,
/// how much light it gives and how bright its dark side is. The sun lights it, so its phase follows
/// the angle between the two.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Moon {
    /// Unit direction towards the moon.
    pub direction: [f32; 3],
    /// Its disk's angular radius, in radians.
    pub angular_radius: f32,
    /// The full moon's light as a share of the sun's (`0..=MOONLIGHT_MAX`).
    pub moonlight: f32,
    /// A tint on the moon's light (linear rgb, each `0..=1`).
    pub tint: [f32; 3],
    /// The dark side's radiance as a share of the full moon's (`0..=1`).
    pub earthshine: f32,
}

impl Moon {
    /// A moon towards `direction` (normalised; a zero or non-finite one points straight up) with the
    /// defaults: the real moon's size, [`DEFAULT_MOONLIGHT`], [`DEFAULT_MOON_TINT`] and
    /// [`DEFAULT_EARTHSHINE`].
    pub fn new(direction: [f32; 3]) -> Moon {
        Moon {
            direction: unit_direction(direction),
            angular_radius: DEFAULT_MOON_ANGULAR_RADIUS_DEG.to_radians(),
            moonlight: DEFAULT_MOONLIGHT,
            tint: DEFAULT_MOON_TINT,
            earthshine: DEFAULT_EARTHSHINE,
        }
    }

    /// The moon with a disk `degrees` in angular radius (clamped to `0..=MOON_ANGULAR_RADIUS_MAX_DEG`).
    pub fn with_angular_radius_degrees(mut self, degrees: f32) -> Moon {
        let degrees = if degrees.is_nan() { DEFAULT_MOON_ANGULAR_RADIUS_DEG } else { degrees.clamp(0.0, MOON_ANGULAR_RADIUS_MAX_DEG) };
        self.angular_radius = degrees.to_radians();
        self
    }

    /// The moon giving `share` of the sun's light at full phase (clamped to `0..=MOONLIGHT_MAX`).
    pub fn with_moonlight(mut self, share: f32) -> Moon {
        self.moonlight = if share.is_nan() { DEFAULT_MOONLIGHT } else { share.clamp(0.0, MOONLIGHT_MAX) };
        self
    }

    /// The moon's light tinted `tint` (each channel clamped to `0..=1`).
    pub fn with_tint(mut self, tint: [f32; 3]) -> Moon {
        self.tint = tint.map(unit);
        self
    }

    /// The moon's dark side at `share` of the full moon's radiance (clamped to `0..=1`).
    pub fn with_earthshine(mut self, share: f32) -> Moon {
        self.earthshine = unit(share);
        self
    }
}

fn unit(value: f32) -> f32 {
    if value.is_nan() { 0.0 } else { value.clamp(0.0, 1.0) }
}

fn unit_direction(direction: [f32; 3]) -> [f32; 3] {
    let length = libm::sqrtf(direction.iter().map(|c| c * c).sum());
    if !length.is_finite() || length <= f32::MIN_POSITIVE {
        return [0.0, 1.0, 0.0];
    }
    direction.map(|c| c / length)
}

/// The star field's mean radiance for `stars` (clamped to `0..=STARS_MAX`, a NaN is none).
pub fn star_radiance(stars: f32) -> f32 {
    if stars.is_nan() { 0.0 } else { stars.clamp(0.0, STARS_MAX) }
}

/// How much of the night is drawn for a sun towards `sun_dir`: 0 with the sun at or above the
/// horizon, 1 once it is [`NIGHT_FADE_SINE`] (by the sine of its elevation) below, smooth between
/// (`sky_night_factor` in the sky's shaders).
pub fn night_factor(sun_dir: [f32; 3]) -> f32 {
    let t = (-unit_direction(sun_dir)[1] / NIGHT_FADE_SINE).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The moon's phase towards `moon_dir` lit from `sun_dir`: the share of the full moon's light it
/// gives (1 full, with the sun behind the camera; 0 new), a Lambert sphere's phase integral
/// `(sin α + (π − α) cos α) / π` at phase angle `α`.
pub fn moon_phase(moon_dir: [f32; 3], sun_dir: [f32; 3]) -> f32 {
    let (moon, sun) = (unit_direction(moon_dir), unit_direction(sun_dir));
    // The phase angle: between the directions from the moon to the sun and to the camera.
    let cos_alpha = -(moon[0] * sun[0] + moon[1] * sun[1] + moon[2] * sun[2]);
    let alpha = libm::acosf(cos_alpha.clamp(-1.0, 1.0));
    ((libm::sinf(alpha) + (core::f32::consts::PI - alpha) * libm::cosf(alpha)) / core::f32::consts::PI).clamp(0.0, 1.0)
}

/// The moon's light outside the atmosphere for a sun of `sun_color` (linear rgb with its intensity)
/// towards `sun_dir`: the sun's times the moonlight share, the tint, the phase and the
/// [`night_factor`]. Zero by day.
pub fn moon_light(moon: &Moon, sun_dir: [f32; 3], sun_color: [f32; 3]) -> [f32; 3] {
    let scale = moon.moonlight * moon_phase(moon.direction, sun_dir) * night_factor(sun_dir);
    [0, 1, 2].map(|c| sun_color[c] * moon.tint[c] * scale)
}

fn luminance(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/// The light that lights the ground under `sky` for a camera `camera_height_km` up and the scene's
/// sun towards `sun_dir` with `sun_color` (outside the atmosphere): the brighter of the sun and the
/// moon, each through the sky's medium ([`crate::sky::sun_transmittance_in`]), as (direction,
/// colour). The moon takes over only once it outshines the setting sun, so the light's luminance
/// never jumps (its direction turns where both are equally faint).
pub fn ground_light(sky: &crate::settings::SkyParams, camera_height_km: f32, sun_dir: [f32; 3], sun_color: [f32; 3]) -> ([f32; 3], [f32; 3]) {
    let through = crate::sky::sun_transmittance_in(&sky.medium, camera_height_km, sun_dir, sky.sun_angular_radius);
    let sun = [0, 1, 2].map(|c| sun_color[c] * through[c]);
    let Some(moon) = sky.moon.as_ref() else { return (sun_dir, sun) };
    let light = moon_light(moon, sun_dir, sun_color);
    let through = crate::sky::sun_transmittance_in(&sky.medium, camera_height_km, moon.direction, moon.angular_radius);
    let moonlit = [0, 1, 2].map(|c| light[c] * through[c]);
    if luminance(moonlit) > luminance(sun) { (moon.direction, moonlit) } else { (sun_dir, sun) }
}

/// The sky's night as its shaders read it (`NightSky` in `sky/sky_draw.wgsl` and
/// `sky/sky_view.wgsl`, held to one layout by `tests/sky.rs`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuNightSky {
    /// xyz: unit direction towards the moon; w: its angular radius (0: no moon).
    pub moon_dir: [f32; 4],
    /// x: the moon's albedo; y: its earthshine share; z: the night factor the moonlit sky-view LUT
    /// was computed at (0: none, not sampled); w: star cells per side of a cube face.
    pub moon: [f32; 4],
    /// x: the star field's mean radiance (0: none); y, z, w: reserved.
    pub stars: [f32; 4],
}

/// The night of `sky` for a sun towards `sun_dir`, as the shaders read it.
pub fn gpu_night(sky: &crate::settings::SkyParams, sun_dir: [f32; 3]) -> GpuNightSky {
    let night = night_factor(sun_dir);
    let cells = STAR_CELLS_PER_FACE as f32;
    let stars = [star_radiance(sky.stars), 0.0, 0.0, 0.0];
    let Some(moon) = sky.moon.as_ref() else { return GpuNightSky { moon: [MOON_ALBEDO, 0.0, 0.0, cells], stars, ..GpuNightSky::default() } };
    let [x, y, z] = moon.direction;
    // The moonlit sky is computed only where it is drawn (a moon that gives light, at night).
    let lit = moon.moonlight * moon_phase(moon.direction, sun_dir) > 0.0;
    GpuNightSky { moon_dir: [x, y, z, moon.angular_radius], moon: [MOON_ALBEDO, moon.earthshine, if lit { night } else { 0.0 }, cells], stars }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_night_fades_in_only_once_the_sun_is_down() {
        assert_eq!(night_factor([0.0, 0.5, -1.0]), 0.0, "a day sun");
        assert_eq!(night_factor([0.0, 0.0, -1.0]), 0.0, "the sun on the horizon");
        assert_eq!(night_factor([0.0, -1.0, 0.0]), 1.0, "midnight");
        let dusk = night_factor([0.0, -0.05, -1.0]);
        assert!(dusk > 0.0 && dusk < 1.0, "civil dusk is part night: {dusk}");
    }

    #[test]
    fn the_moon_is_full_opposite_the_sun_and_new_beside_it() {
        assert!((moon_phase([0.0, 0.3, 1.0], [0.0, -0.3, -1.0]) - 1.0).abs() < 1e-5, "opposite: full");
        assert!(moon_phase([0.0, 0.3, 1.0], [0.0, 0.3, 1.0]) < 1e-5, "together: new");
        let quarter = moon_phase([0.0, 0.0, 1.0], [1.0, 0.0, 0.0]);
        assert!((quarter - 1.0 / core::f32::consts::PI).abs() < 1e-5, "a quarter moon gives 1/π of the full's light: {quarter}");
    }

    #[test]
    fn the_moon_s_builders_hold_their_ranges() {
        let moon = Moon::new([0.0, 0.0, 0.0]).with_angular_radius_degrees(90.0).with_moonlight(f32::NAN).with_tint([2.0, -1.0, 0.5]).with_earthshine(3.0);
        assert_eq!(moon.direction, [0.0, 1.0, 0.0]);
        assert_eq!(moon.angular_radius, MOON_ANGULAR_RADIUS_MAX_DEG.to_radians());
        assert_eq!(moon.moonlight, DEFAULT_MOONLIGHT);
        assert_eq!(moon.tint, [1.0, 0.0, 0.5]);
        assert_eq!(moon.earthshine, 1.0);
        assert_eq!(star_radiance(f32::NAN), 0.0);
        assert_eq!(star_radiance(5.0), STARS_MAX);
    }
}
