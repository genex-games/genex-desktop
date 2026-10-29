//! Physical light units (AAA review LIT-3, gap row 17): what a light's intensity is in lux,
//! candela or lumens, an emissive surface's in nits, and an exposure in EV100, so a game lights a
//! scene from real numbers (a 100 000 lux sun, an 800 lumen bulb, a 300 nit screen) instead of
//! guessing relative ones.
//!
//! The renderer's scene units are relative and stay so; this module fixes their scale: one scene
//! unit of illuminance is [`LUX_PER_UNIT`] lux and one of luminance [`NITS_PER_UNIT`] cd/m², chosen
//! so that scene EV 0 (middle grey at exposure 1) is EV100 [`EV100_AT_EV0`]. A sunlit exterior then
//! meters about +3.5 EV and a lit room about -3 EV, both well inside auto exposure's default
//! `ev_min..=ev_max` (-8..=8), while the engine's default sun (2.5) is a bright overcast day.
//!
//! The shaders' conventions decide the conversions: a surface reflects `albedo / pi` of the sun's
//! illuminance and of a point or spot light's `intensity / distance²` (inverse-square, windowed at
//! its range), and `albedo` times the flat ambient (a sky of that luminance all round). Exposure
//! uses the reflected-light meter's calibration, `EV100 = log2(L × 100 / K)` with `K` 12.5.

/// The reflected-light meter's calibration constant (ISO 2720, the usual camera value).
pub const METER_K: f32 = 12.5;
/// Middle grey: the scene luminance auto exposure draws at exposure 1.
const KEY: f32 = 0.18;
/// The EV100 that scene EV 0 stands for.
pub const EV100_AT_EV0: f32 = 12.0;
/// cd/m² per scene unit of luminance: middle grey at EV100 12 is `2^12 × K / 100` cd/m².
pub const NITS_PER_UNIT: f32 = 4096.0 * METER_K / 100.0 / KEY;
/// Lux per scene unit of illuminance (the same scale: `L = albedo × E / pi` on both sides).
pub const LUX_PER_UNIT: f32 = NITS_PER_UNIT;

/// Scene illuminance for `lux` (a sun's or a sky's light on a surface facing it):
/// `frame.sun(direction, color, units::lux(100_000.0))`.
pub fn lux(lux: f32) -> f32 {
    lux / LUX_PER_UNIT
}

/// Scene intensity for a point or spot light of `candela` (cd: its light along one direction).
pub fn candela(candela: f32) -> f32 {
    candela / LUX_PER_UNIT
}

/// Scene intensity for a point light that sends `lumens` evenly all round (a bare bulb's rating).
pub fn lumens(lumens: f32) -> f32 {
    candela(lumens / (4.0 * core::f32::consts::PI))
}

/// Scene intensity for a spot light that sends `lumens` into its cone of `outer_degrees` (its full
/// outer angle's half, as `SpotLight::with_cone_degrees` takes it): the same bulb in a narrower
/// reflector is brighter along its axis.
pub fn spot_lumens(lumens: f32, outer_degrees: f32) -> f32 {
    let half = outer_degrees.clamp(1.0, 90.0).to_radians();
    let solid_angle = 2.0 * core::f32::consts::PI * (1.0 - libm::cosf(half));
    candela(lumens / solid_angle)
}

/// The flat ambient (`frame.ambient`) of a sky that puts `lux` on an upward surface all round.
pub fn ambient_lux(lux: f32) -> f32 {
    lux / core::f32::consts::PI / NITS_PER_UNIT
}

/// Scene radiance for an emissive surface of `nits` (cd/m²): `Material::emissive(color,
/// units::nits(300.0))` is a phone screen.
pub fn nits(nits: f32) -> f32 {
    nits / NITS_PER_UNIT
}

/// The scene EV (`ev_min`, `ev_max`, a manual `ev_compensation`'s negation) of `ev100`.
pub fn ev_from_ev100(ev100: f32) -> f32 {
    ev100 - EV100_AT_EV0
}

/// The EV100 of scene EV `ev` (what `state().__render.exposure.meteredEv` reads as on a camera).
pub fn ev100_from_ev(ev: f32) -> f32 {
    ev + EV100_AT_EV0
}

/// A manual exposure's `ev_compensation` for a scene metered at `ev100` (manual exposure draws at
/// `2^ev_compensation`, so a brighter scene takes a lower one).
pub fn manual_compensation_for_ev100(ev100: f32) -> f32 {
    -ev_from_ev100(ev100)
}

/// The sRGB colour of a blackbody at `kelvin` (1000..=40000 K), white balanced to D65 and scaled so
/// its brightest channel is 255: 1900 K a candle, 2700 K a warm bulb, 4000 K a neutral tube, 5600 K
/// daylight, 6500 K an overcast sky. Tanner Helland's fit to the CIE 1964 blackbody colours.
pub fn kelvin(kelvin: f32) -> [u8; 3] {
    let t = kelvin.clamp(1000.0, 40_000.0) / 100.0;
    let red = if t <= 66.0 { 255.0 } else { 329.698_73 * libm::powf(t - 60.0, -0.133_204_76) };
    let green = if t <= 66.0 { 99.470_8 * libm::logf(t) - 161.119_57 } else { 288.122_16 * libm::powf(t - 60.0, -0.075_514_85) };
    let blue = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_73 * libm::logf(t - 10.0) - 305.044_8
    };
    [red, green, blue].map(|channel| channel.clamp(0.0, 255.0).round() as u8)
}

/// Common light levels, each in its unit (calibration for agents; `docs/api/lighting.md` lists them).
pub mod reference {
    /// The sun outside the atmosphere (what `frame.sun` is under the physical sky), lux.
    pub const SUN_ABOVE_ATMOSPHERE_LUX: f32 = 128_000.0;
    /// Direct midday sun at the ground on a clear day, lux.
    pub const SUN_CLEAR_NOON_LUX: f32 = 100_000.0;
    /// An overcast day's light on open ground, lux.
    pub const OVERCAST_LUX: f32 = 10_000.0;
    /// A lit office or classroom's desks, lux (EN 12464-1: 300 to 500).
    pub const OFFICE_LUX: f32 = 500.0;
    /// A living room in the evening, lux.
    pub const HOME_EVENING_LUX: f32 = 100.0;
    /// A full moon's light, lux.
    pub const FULL_MOON_LUX: f32 = 0.25;
    /// A candle, lumens.
    pub const CANDLE_LUMENS: f32 = 12.0;
    /// A 60 W-equivalent bulb, lumens.
    pub const BULB_LUMENS: f32 = 800.0;
    /// A 1.2 m fluorescent or LED tube, lumens.
    pub const TUBE_LUMENS: f32 = 3_000.0;
    /// A street lamp, lumens.
    pub const STREET_LAMP_LUMENS: f32 = 12_000.0;
    /// A torch (flashlight), lumens.
    pub const TORCH_LUMENS: f32 = 300.0;
    /// A phone or monitor screen at full white, nits.
    pub const SCREEN_NITS: f32 = 300.0;
    /// A clear blue sky away from the sun, nits.
    pub const BLUE_SKY_NITS: f32 = 8_000.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32, tolerance: f32) -> bool {
        (a - b).abs() <= tolerance * b.abs().max(1e-6)
    }

    /// Scene EV of a white-ish (albedo 0.18) surface lit by `illuminance` scene units.
    fn metered_ev(illuminance: f32) -> f32 {
        libm::log2f(KEY * illuminance / core::f32::consts::PI / KEY)
    }

    #[test]
    fn scene_ev_zero_is_ev100_twelve_and_the_conversions_round_trip() {
        // Middle grey at exposure 1 is 512 cd/m², EV100 log2(512 × 100 / 12.5) = 12.
        assert!(close(KEY * NITS_PER_UNIT, 512.0, 1e-5));
        assert!(close(libm::log2f(KEY * NITS_PER_UNIT * 100.0 / METER_K), EV100_AT_EV0, 1e-5));
        assert_eq!(ev_from_ev100(15.0), 3.0);
        assert_eq!(ev100_from_ev(ev_from_ev100(9.5)), 9.5);
        assert_eq!(manual_compensation_for_ev100(15.0), -3.0, "a sunny scene drawn manually at 1/8");
        assert!(close(lumens(800.0), candela(800.0 / (4.0 * core::f32::consts::PI)), 1e-6));
        assert!(close(spot_lumens(800.0, 90.0), 2.0 * lumens(800.0), 1e-5), "a hemisphere holds twice the light along its axis");
        assert!(spot_lumens(800.0, 20.0) > spot_lumens(800.0, 40.0), "a narrower cone is brighter");
        assert!(close(ambient_lux(core::f32::consts::PI * NITS_PER_UNIT), 1.0, 1e-6));
        assert!(close(nits(NITS_PER_UNIT), 1.0, 1e-6));
    }

    #[test]
    fn sunlit_exteriors_and_lit_rooms_both_meter_inside_the_default_ev_limits() {
        let sunny = metered_ev(lux(reference::SUN_CLEAR_NOON_LUX));
        let office = metered_ev(lux(reference::OFFICE_LUX));
        let evening = metered_ev(lux(reference::HOME_EVENING_LUX));
        assert!((3.0..=4.5).contains(&sunny), "sunny {sunny}");
        assert!((-5.0..=-3.0).contains(&office), "office {office}");
        assert!((-7.5..=-5.5).contains(&evening), "evening {evening}");
        assert!([sunny, office, evening].iter().all(|ev| (-8.0..=8.0).contains(ev)));
        // The engine's default sun (2.5) is a bright overcast day.
        assert!(close(2.5 * LUX_PER_UNIT, 7_111.0, 1e-3));
        // An 800 lm bulb lights a desk 2 m below it at 16 lux.
        assert!(close(lumens(reference::BULB_LUMENS) / 4.0 * LUX_PER_UNIT, 15.9, 1e-2));
    }

    #[test]
    fn kelvin_runs_from_candle_orange_through_white_to_sky_blue() {
        assert_eq!(kelvin(6600.0), [255, 255, 255]);
        let [r, g, b] = kelvin(1900.0);
        assert!(r == 255 && g < 160 && b < 60, "candle {r} {g} {b}");
        let warm = kelvin(2700.0);
        assert!(warm[0] == 255 && warm[2] < warm[1] && warm[1] < 255, "{warm:?}");
        let sky = kelvin(10_000.0);
        assert!(sky[2] == 255 && sky[0] < 220, "{sky:?}");
        assert_eq!(kelvin(500.0), kelvin(1000.0), "held to its range");
    }
}
