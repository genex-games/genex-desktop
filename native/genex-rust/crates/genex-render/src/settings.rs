//! Render settings (plan §2.1 principles 5, 7 and 8; §2.4): what a game, a preset, a device class
//! or the person chooses about how frames are drawn, apart from what is drawn.
//!
//! - [`Look`] is per game (genex.toml `[render.look]` and the facade) and equal on every preset and
//!   device: tonemapper, exposure mode and metering, EV compensation, bloom (intensity, optional
//!   threshold, radius), GTAO's intensity and radius, height and distance [`Fog`] and the contact
//!   shadows' length (RQ4). Presets only switch these features on or off and size them.
//! - [`Environment`] is per game too (RQ2): the flat colour (legacy), the physical sky
//!   (Hillaire, one model on every preset) or an HDR map from the game's assets. It is kept apart
//!   from the `Copy` look because a map names its file.
//! - [`Meshlets`] is per game too (R2): whether the game's big meshes draw as meshlets, from how
//!   many triangles, and whether Hi-Z occlusion culls them. The preset's `meshlets` and
//!   `occlusion` switches say whether the device runs them; both must agree ([`Meshlets::drawn`]).
//! - [`Quality`] is what a preset changes: resolutions, sample, slice and step counts, cadence and
//!   on/off, as one switch struct per feature. Every knob is classified ([`QualityKnob::kind`]):
//!   a [`KnobKind::Resource`] knob may change at runtime (dynamic resolution, preset demotion); a
//!   [`KnobKind::Pipeline`] knob changes the pipeline set and so only at boot, on an explicit
//!   person or verb change, or at a loading point ([`Quality::pipeline_key`]).
//! - [`RenderSettings::off`] is the renderer as it was before the renderer follow-up, exactly: LDR,
//!   MSAA 4x, two 1024 px cascades with 3x3 PCF, no post work. Existing goldens are drawn with it.
//! - [`FrameConfig`] is what one frame derives from the settings: render versus output size,
//!   samples, the frame index temporal effects are keyed to, whether history was reset and TAA's
//!   sub-pixel jitter (zero unless TAA is drawn).
//! - [`TaaQuality`] and [`RcasQuality`] (RQ5) are resource knobs beside the pipeline-shaping
//!   [`AntiAliasing`] and [`Upscaler`]: TAA's jitter cycle, its accumulation floor and texture LOD
//!   bias, and RCAS's sharpness (for FSR1 and for TAA's sharpen on ultra).
//!
//! Wire spellings are the host vocabulary's (`src/shared/render-quality.ts`) and never change once
//! shipped. Every enum here is `#[non_exhaustive]`: tiers append values.

use wgpu::TextureFormat;

use crate::layout::{MAX_LIGHTS, SHADOW_CASCADES};
use crate::renderer::MSAA_SAMPLES;
use crate::shadow::SHADOW_MAP_PX;

/// Most shadow cascades any preset uses (plan goal 3; [`crate::layout::MAX_CASCADES`]).
pub const MAX_CASCADES: u8 = crate::layout::MAX_CASCADES as u8;
/// The smallest render scale a device class steps down to.
pub const RENDER_SCALE_MIN: f32 = 0.5;
/// Samples per pixel with MSAA on (where the formats take it).
pub const MSAA_SAMPLE_COUNT: u32 = MSAA_SAMPLES;

/// A quality preset (`QualityPreset` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum QualityPreset {
    /// Weak laptops, mid-range phones.
    Low,
    /// Mid desktops, recent phones (with mobile caps).
    Medium,
    /// Good desktops.
    High,
    /// High-end desktops.
    Ultra,
}

impl QualityPreset {
    /// Every preset, cheapest first.
    pub const ALL: [QualityPreset; 4] = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            QualityPreset::Low => "low",
            QualityPreset::Medium => "medium",
            QualityPreset::High => "high",
            QualityPreset::Ultra => "ultra",
        }
    }

    /// The preset spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<QualityPreset> {
        QualityPreset::ALL.into_iter().find(|preset| preset.wire() == wire)
    }
}

/// Where a frame's quality comes from: a fixed preset, the device class's default (`auto`), or
/// the renderer before the follow-up (`off`: goldens and the perf baseline, never in genex.toml).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PresetChoice {
    /// Exactly the legacy renderer.
    Off,
    /// The device class's default preset, resolved at boot.
    Auto,
    /// A fixed preset.
    Preset(QualityPreset),
}

impl PresetChoice {
    /// The wire spelling (`off`, `auto` or the preset's).
    pub const fn wire(self) -> &'static str {
        match self {
            PresetChoice::Off => "off",
            PresetChoice::Auto => "auto",
            PresetChoice::Preset(preset) => preset.wire(),
        }
    }

    /// The choice spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<PresetChoice> {
        match wire {
            "off" => Some(PresetChoice::Off),
            "auto" => Some(PresetChoice::Auto),
            other => QualityPreset::from_wire(other).map(PresetChoice::Preset),
        }
    }
}

/// How HDR scene colour becomes display colour (`tonemapper` look key).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Tonemapper {
    /// Khronos PBR Neutral: near-identity for in-range authored colours (the legacy-preserving default).
    #[default]
    KhronosNeutral,
    /// AgX: hue-stable highlight roll-off, but flatter and less saturated than authored colours
    /// (no look).
    Agx,
    /// Hill's ACES fit.
    Aces,
    /// A clamp: no curve.
    None,
    /// AgX with a punchy look: Godot 4.7's AgX (the allenwp curve between Blender AgX's inset and
    /// outset matrices) at contrast 1.4 with middle grey held where plain AgX draws it, then
    /// saturation 1.4 about luminance. Deeper contrast and richer lights and emissives than AgX,
    /// with no exposure shift: scene 0.18 still draws at display middle grey.
    AgxPunchy,
}

impl Tonemapper {
    /// Every tonemapper.
    pub const ALL: [Tonemapper; 5] = [Tonemapper::KhronosNeutral, Tonemapper::Agx, Tonemapper::Aces, Tonemapper::None, Tonemapper::AgxPunchy];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Tonemapper::KhronosNeutral => "khronos-neutral",
            Tonemapper::Agx => "agx",
            Tonemapper::Aces => "aces",
            Tonemapper::None => "none",
            Tonemapper::AgxPunchy => "agx-punchy",
        }
    }

    /// The tonemapper spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<Tonemapper> {
        Tonemapper::ALL.into_iter().find(|tonemapper| tonemapper.wire() == wire)
    }

    /// The tonemap shader's `GX_TONEMAPPER` override value (one pipeline per tonemapper). Never
    /// renumbered: tests/layout.rs emits each variant through every back end.
    pub const fn shader_id(self) -> u32 {
        match self {
            Tonemapper::KhronosNeutral => 0,
            Tonemapper::Agx => 1,
            Tonemapper::Aces => 2,
            Tonemapper::None => 3,
            Tonemapper::AgxPunchy => 4,
        }
    }
}

/// How exposure is chosen (`exposure` look key).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ExposureMode {
    /// A fixed EV: `ev_compensation` (0 = exposure 1.0).
    #[default]
    Manual,
    /// Adapted from the scene's luminance histogram, plus `ev_compensation`.
    Auto,
}

impl ExposureMode {
    /// Every mode.
    pub const ALL: [ExposureMode; 2] = [ExposureMode::Manual, ExposureMode::Auto];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ExposureMode::Manual => "manual",
            ExposureMode::Auto => "auto",
        }
    }

    /// The mode spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<ExposureMode> {
        ExposureMode::ALL.into_iter().find(|mode| mode.wire() == wire)
    }
}

/// Which pixels auto exposure weighs (`metering` look key).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Metering {
    /// Every pixel alike.
    #[default]
    Average,
    /// Centre-weighted.
    Center,
    /// The centre spot only.
    Spot,
    /// Sky-aware: the frame's lower rows weigh more (the top row 1/16 of the bottom's), so an open
    /// sky above the horizon does not pull the ground it lights into the dark.
    Ground,
}

impl Metering {
    /// Every metering.
    pub const ALL: [Metering; 4] = [Metering::Average, Metering::Center, Metering::Spot, Metering::Ground];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Metering::Average => "average",
            Metering::Center => "center",
            Metering::Spot => "spot",
            Metering::Ground => "ground",
        }
    }

    /// The metering spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<Metering> {
        Metering::ALL.into_iter().find(|metering| metering.wire() == wire)
    }
}

/// The game's look: identical on every preset and device (`[render.look]`).
///
/// **Units (RQ1 decision):** scene units are relative. Today's light intensities keep their
/// meaning (the default sun is 2.5) and EV 0 is an exposure of 1.0, so the default look draws
/// in-range authored colours as before. Exposure is a manual EV or auto exposure plus EV
/// compensation; there is no aperture, shutter or ISO. Auto exposure meters the scene's EV
/// (`log2(luminance / 0.18)`), clamps it to `ev_min..=ev_max` and adapts towards it by at most
/// `adaptation_up` (brightening) or `adaptation_down` (darkening) EV per second of simulated
/// time, a fixed step per tick, never wall time.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// The tonemapper.
    pub tonemapper: Tonemapper,
    /// Manual or auto exposure.
    pub exposure: ExposureMode,
    /// Auto exposure's metering.
    pub metering: Metering,
    /// EV added to the exposure (the fixed EV in manual mode).
    pub ev_compensation: f32,
    /// Bloom's energy-conserving blend weight (threshold-free).
    pub bloom_intensity: f32,
    /// Auto exposure: the lowest scene EV it meters (darker scenes are not brightened further).
    pub ev_min: f32,
    /// Auto exposure: the highest scene EV it meters.
    pub ev_max: f32,
    /// Auto exposure: EV per second it adapts by when the scene gets darker (the image brightens).
    pub adaptation_up: f32,
    /// Auto exposure: EV per second it adapts by when the scene gets brighter (the image darkens).
    pub adaptation_down: f32,
    /// Auto exposure: within this many EV of the target the adaptation slows exponentially
    /// instead of stepping at full speed (0: linear all the way), so the small target changes a
    /// moving camera meters do not make the frame breathe.
    pub adaptation_transition: f32,
    /// Auto exposure: EV added to the exposure as a function of the metered scene EV (empty, the
    /// default, adds nothing). A dusk or night scene keeps its darkness with it, without an EV
    /// floor of its own.
    pub compensation_curve: CompensationCurve,
    /// Bloom's optional threshold in pre-exposed scene units, a stylistic choice: 0 (the default)
    /// is threshold-free, every pixel blooms by the energy-conserving blend.
    pub bloom_threshold: f32,
    /// Bloom's spread: how much each wider blur of the chain weighs against the one below it
    /// (1, the default, weighs every mip alike; 2 doubles each wider mip's share), so a wider
    /// spread glows further out while the filter stays one texel wide
    /// ([`crate::post::bloom::mip_weights`]).
    pub bloom_radius: f32,
    /// Ambient occlusion's strength, `0..=1` (GTAO, the one AO algorithm on every preset).
    pub ao_intensity: f32,
    /// Ambient occlusion's world-space radius.
    pub ao_radius: f32,
    /// Height and distance fog (off at the default density 0).
    pub fog: Fog,
    /// Contact shadows' ray length in world units (the sun's screen-space shadows, high and ultra).
    pub contact_shadow_length: f32,
    /// The look's white balance: linear gains on the scene before the curve, normalised so they
    /// keep its Rec. 709 luminance ([`Look::white_balance_gains`]). `[1, 1, 1]` (the default)
    /// leaves the picture unchanged. Art direction for the whole frame (a golden-hour warmth), so
    /// a fog or light tint need not carry it. HDR scene only: the legacy LDR scene has no curve.
    pub white_balance: [f32; 3],
    /// The look's white balance as a chromatic adaptation, `-1..=1`: positive warms, negative
    /// cools (0, the default, changes nothing). A von Kries transform in CIECAT16 cone space
    /// ([`Look::white_balance_matrix`]): neutrals warm while a blue sky stays blue, which
    /// per-channel gains cannot do.
    pub temperature: f32,
    /// The chromatic adaptation's tint, `-1..=1`: positive turns magenta, negative green (0, the
    /// default, changes nothing).
    pub tint: f32,
    /// Colour grading (A.2): parametric knobs on the white-balanced scene before the curve and a
    /// `.cube` LUT on the display colour after it ([`crate::post::grading::Grading`]; neutral, the
    /// default, draws nothing). HDR scene only, as the white balance.
    pub grading: crate::post::grading::Grading,
    /// Depth of field (A.9): a thin lens focused at a distance, blurring the HDR scene after TAA
    /// ([`crate::post::dof::DepthOfField`]; off, the default, draws nothing). Settled captures draw
    /// without it unless the shot asks.
    pub depth_of_field: crate::post::dof::DepthOfField,
    /// Motion blur (A.9): the HDR scene blurred along its motion over the shutter's share of the
    /// frame, after depth of field ([`crate::post::motion_blur::MotionBlur`]; off, the default,
    /// draws nothing). Settled captures draw without it unless the shot asks.
    pub motion_blur: crate::post::motion_blur::MotionBlur,
}

/// Rec. 709 linear rgb to CIE XYZ (columns; Filament v1.78 `ColorSpaceUtils.h` `sRGB_to_XYZ`,
/// Apache-2.0).
#[allow(clippy::excessive_precision, reason = "the constants as Filament publishes them")]
const RGB_TO_XYZ: [[f32; 3]; 3] = [[0.412_456_0, 0.212_673_0, 0.019_333_9], [0.357_576_0, 0.715_152_0, 0.119_192_0], [0.180_438_0, 0.072_175_0, 0.950_304_0]];
/// CIE XYZ to Rec. 709 linear rgb (columns; Filament's `XYZ_to_sRGB`).
#[allow(clippy::excessive_precision, reason = "the constants as Filament publishes them")]
const XYZ_TO_RGB: [[f32; 3]; 3] = [[3.240_454_2, -0.969_266_0, 0.055_643_4], [-1.537_138_5, 1.876_010_8, -0.204_025_9], [-0.498_531_4, 0.041_556_0, 1.057_225_2]];
/// CIE XYZ to CIECAT16 cone responses (columns; Filament's `XYZ_to_CIECAT16`).
const XYZ_TO_CAT16: [[f32; 3]; 3] = [[0.401_288, -0.250_268, -0.002_079], [0.650_173, 1.204_414, 0.048_952], [-0.051_461, 0.045_854, 0.953_127]];
/// CIECAT16 cone responses to CIE XYZ (columns; Filament's `CIECAT16_to_XYZ`).
const CAT16_TO_XYZ: [[f32; 3]; 3] = [[1.862_068, 0.387_527, -0.015_841], [-1.011_255, 0.621_447, -0.034_123], [0.149_187, -0.008_974, 1.049_964]];
/// Illuminant D65 in CIECAT16 cone space (Filament's `ILLUMINANT_D65_LMS_CAT16`).
const D65_CAT16: [f32; 3] = [0.975_533, 1.016_483, 1.084_837];
/// Illuminant D65's CIE 1931 x chromaticity.
const D65_X: f32 = 0.31271;

/// `a × b` for column-major 3x3 matrices (`m[column][row]`).
fn mat3_mul(a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    std::array::from_fn(|column| std::array::from_fn(|row| (0..3).map(|k| a[k][row] * b[column][k]).sum()))
}

/// The von Kries chromatic adaptation of `temperature` and `tint` (each `-1..=1`) as one matrix on
/// Rec. 709 linear rgb: the white point moved along the daylight locus by `temperature` (positive
/// assumes a bluer light, so the picture warms) and off it by `tint`, adapted to D65 in CIECAT16
/// cone space. Filament v1.78 `ColorGrading.cpp` `adaptationTransform` (Apache-2.0), in Rec. 709
/// instead of Rec. 2020.
pub fn chromatic_adaptation(temperature: f32, tint: f32) -> [[f32; 3]; 3] {
    let x = D65_X - temperature * if temperature < 0.0 { 0.0214 } else { 0.066 };
    // The CIE daylight locus y(x), plus the tint.
    let y = 2.87 * x - 3.0 * x * x - 0.275 + tint * 0.066;
    let xyz = [x / y.max(1e-5), 1.0, (1.0 - x - y) / y.max(1e-5)];
    let lms: [f32; 3] = std::array::from_fn(|row| (0..3).map(|k| XYZ_TO_CAT16[k][row] * xyz[k]).sum());
    let scale = [[D65_CAT16[0] / lms[0], 0.0, 0.0], [0.0, D65_CAT16[1] / lms[1], 0.0], [0.0, 0.0, D65_CAT16[2] / lms[2]]];
    let to_cone = mat3_mul(&XYZ_TO_CAT16, &RGB_TO_XYZ);
    let from_cone = mat3_mul(&XYZ_TO_RGB, &CAT16_TO_XYZ);
    mat3_mul(&from_cone, &mat3_mul(&scale, &to_cone))
}

/// Most points an auto exposure [`CompensationCurve`] holds.
pub const COMPENSATION_CURVE_POINTS_MAX: usize = 8;
/// The largest compensation a [`CompensationCurve`] point adds either way, in EV (the host's
/// `ev_compensation` limit).
pub const COMPENSATION_CURVE_EV_LIMIT: f32 = 10.0;

/// Auto exposure's compensation curve ([`Look::compensation_curve`]): the EV added to the
/// exposure as a piecewise-linear function of the metered scene EV, through up to
/// [`COMPENSATION_CURVE_POINTS_MAX`] `(metered EV, compensation EV)` points and flat beyond the
/// first and last. Empty (the default) adds nothing. After Bevy 0.20's
/// `AutoExposureCompensationCurve` (MIT OR Apache-2.0), as a table instead of a texture.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CompensationCurve {
    points: [[f32; 2]; COMPENSATION_CURVE_POINTS_MAX],
    len: u8,
}

impl CompensationCurve {
    /// No compensation.
    pub const NONE: CompensationCurve = CompensationCurve { points: [[0.0; 2]; COMPENSATION_CURVE_POINTS_MAX], len: 0 };

    /// The curve through `points` (metered EV, compensation EV): sorted by metered EV, a point that
    /// is not finite or repeats a metered EV left out, metered EVs held to
    /// ±[`EXPOSURE_EV_LIMIT`] and compensations to ±[`COMPENSATION_CURVE_EV_LIMIT`], and the
    /// first [`COMPENSATION_CURVE_POINTS_MAX`] of what remains kept.
    pub fn new(points: &[(f32, f32)]) -> CompensationCurve {
        let mut kept: Vec<[f32; 2]> = points
            .iter()
            .filter(|(ev, compensation)| ev.is_finite() && compensation.is_finite())
            .map(|&(ev, compensation)| {
                [ev.clamp(-EXPOSURE_EV_LIMIT, EXPOSURE_EV_LIMIT), compensation.clamp(-COMPENSATION_CURVE_EV_LIMIT, COMPENSATION_CURVE_EV_LIMIT)]
            })
            .collect();
        kept.sort_by(|a, b| a[0].total_cmp(&b[0]));
        kept.dedup_by(|a, b| a[0] == b[0]);
        kept.truncate(COMPENSATION_CURVE_POINTS_MAX);
        let mut curve = CompensationCurve::NONE;
        curve.points[..kept.len()].copy_from_slice(&kept);
        curve.len = kept.len() as u8;
        curve
    }

    /// Its points, in metered-EV order.
    pub fn points(&self) -> &[[f32; 2]] {
        &self.points[..usize::from(self.len)]
    }

    /// Whether it adds nothing anywhere (no points).
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The compensation at metered scene EV `ev` (the adaptation shader's `gx_compensation`,
    /// expression for expression).
    pub fn at(&self, ev: f32) -> f32 {
        let points = self.points();
        let Some((first, last)) = points.first().zip(points.last()) else { return 0.0 };
        if ev <= first[0] {
            return first[1];
        }
        if ev >= last[0] {
            return last[1];
        }
        let upper = points.iter().position(|point| ev < point[0]).unwrap_or(points.len() - 1);
        let (a, b) = (points[upper - 1], points[upper]);
        let t = (ev - a[0]) / (b[0] - a[0]);
        a[1] + (b[1] - a[1]) * t
    }
}

/// Height and distance fog (a look: the same on every preset). Its in-scatter comes from the
/// environment, so the horizon fog matches the sky: the sky-view LUT or the map's irradiance in the
/// view direction plus the sun's lobe, times [`Fog::color`]; under the flat-colour environment the
/// in-scatter is [`Fog::color`] itself. On medium and above the aerial-perspective volume adds the
/// sky's own scattering when [`Fog::aerial_perspective`] allows it. Fog needs no depth target.
///
/// The optical depth along a view ray is `density * ∫ exp(-height_falloff * (y(t) - base_height))
/// dt` from `start` to the surface; the fog's opacity is `1 - exp(-depth)`, at most `max_opacity`
/// (`crate::fog`'s CPU reference).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fog {
    /// Extinction per world unit at `base_height` (0: no fog, the default).
    pub density: f32,
    /// How fast the fog thins with height, per world unit (0: uniform distance fog).
    pub height_falloff: f32,
    /// The height where `density` holds.
    pub base_height: f32,
    /// The distance from the camera where fog starts.
    pub start: f32,
    /// The most the fog hides a surface, `0..=1`.
    pub max_opacity: f32,
    /// Linear rgb: a tint on what is behind the scene, the in-scatter (the environment's horizon
    /// radiance, or under the flat-colour environment the frame's clear colour).
    pub color: [f32; 3],
    /// Whether the aerial-perspective volume adds the sky's scattering where the quality has it on.
    pub aerial_perspective: bool,
    /// Whether the fog is drawn as a lit volume where the quality has the froxel fog on (renderer
    /// pass 2 A.5): the sun's shadows carve shafts out of it and local lights glow in it. Off, the
    /// fog is the analytic height fog on every preset.
    pub volumetric: bool,
}

/// Bloom's default spread.
pub const DEFAULT_BLOOM_RADIUS: f32 = 1.0;
/// The highest bloom threshold a look may ask for, in pre-exposed scene units.
pub const BLOOM_THRESHOLD_MAX: f32 = 16.0;
/// The narrowest bloom spread.
pub const BLOOM_RADIUS_MIN: f32 = 0.25;
/// The widest bloom spread.
pub const BLOOM_RADIUS_MAX: f32 = 4.0;
/// Ambient occlusion's default strength.
pub const DEFAULT_AO_INTENSITY: f32 = 1.0;
/// The strongest ambient occlusion.
pub const AO_INTENSITY_MAX: f32 = 1.0;
/// Ambient occlusion's default radius in world units (XeGTAO's default effect radius).
pub const DEFAULT_AO_RADIUS: f32 = 0.5;
/// The largest ambient occlusion radius, in world units.
pub const AO_RADIUS_MAX: f32 = 8.0;
/// The densest fog, per world unit.
pub const FOG_DENSITY_MAX: f32 = 1.0;
/// Fog's default height falloff, per world unit.
pub const DEFAULT_FOG_HEIGHT_FALLOFF: f32 = 0.2;
/// The steepest fog height falloff, per world unit.
pub const FOG_HEIGHT_FALLOFF_MAX: f32 = 10.0;
/// The largest fog base height either way and fog start distance, in world units.
pub const FOG_DISTANCE_LIMIT: f32 = 100_000.0;
/// The brightest fog colour channel (linear, scene units).
pub const FOG_COLOR_MAX: f32 = 16.0;
/// Contact shadows' default ray length in world units.
pub const DEFAULT_CONTACT_SHADOW_LENGTH: f32 = 0.25;
/// The longest contact-shadow ray, in world units.
pub const CONTACT_SHADOW_LENGTH_MAX: f32 = 2.0;

/// The default fog, as a constant ([`Fog::default`]): off.
const DEFAULT_FOG: Fog = Fog {
    density: 0.0,
    height_falloff: DEFAULT_FOG_HEIGHT_FALLOFF,
    base_height: 0.0,
    start: 0.0,
    max_opacity: 1.0,
    color: [1.0; 3],
    aerial_perspective: true,
    volumetric: true,
};

impl Default for Fog {
    /// No fog (density 0), with the other parameters ready for a game that turns it on.
    fn default() -> Self {
        DEFAULT_FOG
    }
}

impl Fog {
    /// Whether the fog hides anything: a density and an opacity above 0.
    pub fn is_on(&self) -> bool {
        self.density > 0.0 && self.max_opacity > 0.0
    }

    /// The fog with `density` per world unit (held to `0..=FOG_DENSITY_MAX`; NaN is 0).
    pub fn with_density(mut self, density: f32) -> Fog {
        self.density = held(density, 0.0, 0.0, FOG_DENSITY_MAX);
        self
    }

    /// The fog thinning by `height_falloff` per world unit above `base_height`.
    pub fn with_height(mut self, height_falloff: f32, base_height: f32) -> Fog {
        self.height_falloff = held(height_falloff, DEFAULT_FOG_HEIGHT_FALLOFF, 0.0, FOG_HEIGHT_FALLOFF_MAX);
        self.base_height = held(base_height, 0.0, -FOG_DISTANCE_LIMIT, FOG_DISTANCE_LIMIT);
        self
    }

    /// The fog starting `start` world units from the camera and hiding at most `max_opacity`.
    pub fn with_range(mut self, start: f32, max_opacity: f32) -> Fog {
        self.start = held(start, 0.0, 0.0, FOG_DISTANCE_LIMIT);
        self.max_opacity = held(max_opacity, 1.0, 0.0, 1.0);
        self
    }

    /// The fog tinted `color` (linear rgb, each channel `0..=FOG_COLOR_MAX`; NaN is 1).
    pub fn with_color(mut self, color: [f32; 3]) -> Fog {
        self.color = color.map(|c| held(c, 1.0, 0.0, FOG_COLOR_MAX));
        self
    }

    /// The fog with the aerial-perspective volume allowed or not.
    pub fn with_aerial_perspective(mut self, on: bool) -> Fog {
        self.aerial_perspective = on;
        self
    }

    /// The fog drawn as a lit volume (sun shafts) where the quality has the froxel fog, or not.
    pub fn with_volumetric(mut self, on: bool) -> Fog {
        self.volumetric = on;
        self
    }
}

/// `value` within `min..=max`, `fallback` when it is not a number.
fn held(value: f32, fallback: f32, min: f32, max: f32) -> f32 {
    if value.is_nan() { fallback } else { value.clamp(min, max) }
}

/// Bloom's default blend weight.
pub const DEFAULT_BLOOM_INTENSITY: f32 = 0.04;
/// Auto exposure's default metering floor, in EV.
pub const DEFAULT_EV_MIN: f32 = -8.0;
/// Auto exposure's default metering ceiling, in EV.
pub const DEFAULT_EV_MAX: f32 = 8.0;
/// Auto exposure's default brightening speed (the scene got darker), in EV per second: slow, as
/// an eye adjusts to the dark.
pub const DEFAULT_ADAPTATION_UP: f32 = 1.0;
/// Auto exposure's default darkening speed (the scene got brighter), in EV per second: fast, so
/// stepping into sunlight does not leave the picture blown out for long.
pub const DEFAULT_ADAPTATION_DOWN: f32 = 3.0;
/// Auto exposure's default exponential transition, in EV (Bevy 0.20's
/// `exponential_transition_distance`): within it the step is the remaining distance times the
/// speed over it, so the exposure eases onto a moving target instead of chasing every wobble.
/// Half an EV, not Bevy's 1.5: it already cuts a wobbling target's effect by three quarters, and a
/// step into sunlight (+8 EV at the default 3 EV/s) still lands within 1/32 EV in 3 s (1.5 would
/// leave it 0.28 EV bright).
pub const DEFAULT_ADAPTATION_TRANSITION: f32 = 0.5;
/// The widest exponential transition a look may ask for, in EV.
pub const ADAPTATION_TRANSITION_MAX: f32 = 8.0;
/// The largest auto exposure limit either way, in EV (`EXPOSURE_EV_LIMIT` on the host).
pub const EXPOSURE_EV_LIMIT: f32 = 16.0;
/// The fastest adaptation, in EV per second (`ADAPTATION_SPEED_MAX` on the host).
pub const ADAPTATION_SPEED_MAX: f32 = 20.0;
/// Bins of the auto exposure histogram: fixed on every preset (quality varies only the input
/// downsample, [`Quality::exposure_input_divisor`]), so one 128-entry workgroup array fits core's
/// 16 KB of shared memory.
pub const EXPOSURE_HISTOGRAM_BINS: u32 = 128;

/// The smallest white-balance gain a channel may have (before the luminance normalisation): a
/// tint, never a channel switched off.
pub const WHITE_BALANCE_MIN: f32 = 0.25;
/// The largest white-balance gain a channel may have (before the luminance normalisation).
pub const WHITE_BALANCE_MAX: f32 = 4.0;

/// The default look, as a constant ([`Look::default`]).
const DEFAULT_LOOK: Look = Look {
    tonemapper: Tonemapper::KhronosNeutral,
    exposure: ExposureMode::Manual,
    metering: Metering::Average,
    ev_compensation: 0.0,
    bloom_intensity: DEFAULT_BLOOM_INTENSITY,
    ev_min: DEFAULT_EV_MIN,
    ev_max: DEFAULT_EV_MAX,
    adaptation_up: DEFAULT_ADAPTATION_UP,
    adaptation_down: DEFAULT_ADAPTATION_DOWN,
    adaptation_transition: DEFAULT_ADAPTATION_TRANSITION,
    compensation_curve: CompensationCurve::NONE,
    bloom_threshold: 0.0,
    bloom_radius: DEFAULT_BLOOM_RADIUS,
    ao_intensity: DEFAULT_AO_INTENSITY,
    ao_radius: DEFAULT_AO_RADIUS,
    fog: DEFAULT_FOG,
    contact_shadow_length: DEFAULT_CONTACT_SHADOW_LENGTH,
    white_balance: [1.0; 3],
    temperature: 0.0,
    tint: 0.0,
    grading: crate::post::grading::Grading::NEUTRAL,
    depth_of_field: crate::post::dof::DepthOfField::OFF,
    motion_blur: crate::post::motion_blur::MotionBlur::OFF,
};

impl Default for Look {
    /// The legacy-preserving look: Khronos PBR Neutral at a fixed exposure of 1.0.
    fn default() -> Self {
        DEFAULT_LOOK
    }
}

impl Look {
    /// The manual exposure multiplier: `2^ev_compensation` (EV 0 is 1.0).
    pub fn manual_exposure(&self) -> f32 {
        libm::exp2f(self.ev_compensation)
    }

    /// The look with bloom blending `intensity` (`0..=1`), an optional `threshold` (0: none) and
    /// spread `radius`, each held inside the limits genex.toml checks.
    pub fn with_bloom(mut self, intensity: f32, threshold: f32, radius: f32) -> Look {
        self.bloom_intensity = held(intensity, DEFAULT_BLOOM_INTENSITY, 0.0, 1.0);
        self.bloom_threshold = held(threshold, 0.0, 0.0, BLOOM_THRESHOLD_MAX);
        self.bloom_radius = held(radius, DEFAULT_BLOOM_RADIUS, BLOOM_RADIUS_MIN, BLOOM_RADIUS_MAX);
        self
    }

    /// The look with ambient occlusion of `intensity` (`0..=1`) over `radius` world units.
    pub fn with_ao(mut self, intensity: f32, radius: f32) -> Look {
        self.ao_intensity = held(intensity, DEFAULT_AO_INTENSITY, 0.0, AO_INTENSITY_MAX);
        self.ao_radius = held(radius, DEFAULT_AO_RADIUS, AO_RADIUS_MIN, AO_RADIUS_MAX);
        self
    }

    /// The look with white-balance `gains` (linear rgb, each held to
    /// [`WHITE_BALANCE_MIN`]..=[`WHITE_BALANCE_MAX`]; a non-finite gain is 1).
    pub fn with_white_balance(mut self, gains: [f32; 3]) -> Look {
        self.white_balance = gains.map(|gain| held(gain, 1.0, WHITE_BALANCE_MIN, WHITE_BALANCE_MAX));
        self
    }

    /// The gains the tonemap multiplies the scene by: [`Look::white_balance`] divided by its Rec. 709
    /// luminance, so a balance tints the frame without brightening or darkening it (exactly
    /// `[1, 1, 1]` for the default).
    pub fn white_balance_gains(&self) -> [f32; 3] {
        let [r, g, b] = self.white_balance;
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if luminance <= 0.0 || self.white_balance == [1.0; 3] {
            return [1.0; 3];
        }
        self.white_balance.map(|gain| gain / luminance)
    }

    /// The matrix the tonemap applies to the scene's linear rgb before its curve: the chromatic
    /// adaptation of [`Look::temperature`] and [`Look::tint`] ([`chromatic_adaptation`]) times the
    /// diagonal of [`Look::white_balance_gains`]. At temperature and tint 0 it is exactly that
    /// diagonal (the identity for the default look), so every existing look draws as before.
    pub fn white_balance_matrix(&self) -> crate::post::tonemap::ColorMatrix {
        let [r, g, b] = self.white_balance_gains();
        let gains = [[r, 0.0, 0.0], [0.0, g, 0.0], [0.0, 0.0, b]];
        if self.temperature == 0.0 && self.tint == 0.0 {
            return gains;
        }
        mat3_mul(&chromatic_adaptation(self.temperature, self.tint), &gains)
    }

    /// The look with a chromatic-adaptation white balance of `temperature` and `tint` (each held
    /// to `-1..=1`; a value that is not a number is 0).
    pub fn with_temperature(mut self, temperature: f32, tint: f32) -> Look {
        self.temperature = held(temperature, 0.0, -1.0, 1.0);
        self.tint = held(tint, 0.0, -1.0, 1.0);
        self
    }

    /// The look with `grading`, each knob held to its range.
    pub fn with_grading(mut self, grading: crate::post::grading::Grading) -> Look {
        self.grading = grading.held();
        self
    }

    /// The look with `depth_of_field`, each knob held to its range.
    pub fn with_depth_of_field(mut self, depth_of_field: crate::post::dof::DepthOfField) -> Look {
        self.depth_of_field = depth_of_field.held();
        self
    }

    /// The look with `motion_blur`, its shutter held to its range.
    pub fn with_motion_blur(mut self, motion_blur: crate::post::motion_blur::MotionBlur) -> Look {
        self.motion_blur = motion_blur.held();
        self
    }

    /// The look adapting exponentially within `transition` EV of its target (held to
    /// `0..=ADAPTATION_TRANSITION_MAX`; 0 is linear all the way; NaN is the default).
    pub fn with_adaptation_transition(mut self, transition: f32) -> Look {
        self.adaptation_transition = held(transition, DEFAULT_ADAPTATION_TRANSITION, 0.0, ADAPTATION_TRANSITION_MAX);
        self
    }

    /// The look with auto exposure's compensation `curve`.
    pub fn with_compensation_curve(mut self, curve: CompensationCurve) -> Look {
        self.compensation_curve = curve;
        self
    }

    /// The look with `fog`.
    pub fn with_fog(mut self, fog: Fog) -> Look {
        self.fog = fog;
        self
    }

    /// The look with contact-shadow rays `length` world units long.
    pub fn with_contact_shadow_length(mut self, length: f32) -> Look {
        self.contact_shadow_length = held(length, DEFAULT_CONTACT_SHADOW_LENGTH, CONTACT_SHADOW_LENGTH_MIN, CONTACT_SHADOW_LENGTH_MAX);
        self
    }
}

/// The smallest ambient occlusion radius a look keeps (genex.toml refuses 0 and below).
pub const AO_RADIUS_MIN: f32 = 0.01;
/// The shortest contact-shadow ray a look keeps (genex.toml refuses 0 and below).
pub const CONTACT_SHADOW_LENGTH_MIN: f32 = 0.01;

/// The sun's angular radius in degrees by default (the real sun's, about 0.27°): the sun disk's
/// size in the sky and the analytic sun's penumbra.
pub const DEFAULT_SUN_ANGULAR_RADIUS_DEG: f32 = 0.27;
/// The largest sun angular radius a game may ask for, in degrees.
pub const SUN_ANGULAR_RADIUS_MAX_DEG: f32 = 5.0;
/// The ground's albedo under the default sky (Hillaire's: what the lower hemisphere reflects).
pub const DEFAULT_GROUND_ALBEDO: f32 = 0.3;
/// The strongest environment intensity (a multiplier on the sky's or the map's radiance).
pub const ENVIRONMENT_INTENSITY_MAX: f32 = 64.0;

/// What kind of environment lights the scene (`EnvironmentKind` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum EnvironmentKind {
    /// The flat ambient colour and the clear colour behind the scene: the legacy renderer.
    #[default]
    Color,
    /// The physical sky (Hillaire), one model on every preset.
    Sky,
    /// An equirectangular HDR environment map (`.hdr`) from the game's assets.
    Hdri,
}

impl EnvironmentKind {
    /// Every kind.
    pub const ALL: [EnvironmentKind; 3] = [EnvironmentKind::Color, EnvironmentKind::Sky, EnvironmentKind::Hdri];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            EnvironmentKind::Color => "color",
            EnvironmentKind::Sky => "sky",
            EnvironmentKind::Hdri => "hdri",
        }
    }

    /// The kind spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<EnvironmentKind> {
        EnvironmentKind::ALL.into_iter().find(|kind| kind.wire() == wire)
    }
}

/// What an HDR environment map does with the sun it holds (`HdriSun` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum HdriSun {
    /// The map's brightest region (found deterministically) is clamped out of the map and becomes
    /// the scene's sun: the renderer replaces the frame's sun direction and colour with the
    /// region's (turned with the map, times its intensity), so the map's sun casts the shadows and
    /// is not counted twice. A map without a sun keeps the frame's sun.
    #[default]
    Analytic,
    /// The map lights the scene as it is; the game's own sun stays as the game set it.
    Off,
}

impl HdriSun {
    /// Every choice.
    pub const ALL: [HdriSun; 2] = [HdriSun::Analytic, HdriSun::Off];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            HdriSun::Analytic => "analytic",
            HdriSun::Off => "off",
        }
    }

    /// The choice spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<HdriSun> {
        HdriSun::ALL.into_iter().find(|sun| sun.wire() == wire)
    }
}

/// The physical sky's parameters (Hillaire's model, Earth's atmosphere unless the medium says
/// otherwise; the sun's direction and colour are the scene's sun).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyParams {
    /// The ground's albedo (linear rgb, 0..=1).
    pub ground_albedo: [f32; 3],
    /// The sun disk's angular radius, in radians.
    pub sun_angular_radius: f32,
    /// A multiplier on the sky's radiance.
    pub intensity: f32,
    /// The air the sky is made of (renderer pass 2 B.2; Earth's by default).
    pub medium: SkyMedium,
    /// A moon (renderer pass 2 B.2; none by default).
    pub moon: Option<Moon>,
    /// The star field's mean radiance at night, scene units (renderer pass 2 B.2; 0: none).
    pub stars: f32,
}

/// The sky's air (renderer pass 2 B.2): see [`crate::sky::SkyMedium`].
pub use crate::sky::SkyMedium;
/// A moon in the sky (renderer pass 2 B.2): see [`crate::night_sky::Moon`].
pub use crate::night_sky::Moon;

/// The default sky, as a constant ([`SkyParams::default`]).
const DEFAULT_SKY: SkyParams = SkyParams {
    ground_albedo: [DEFAULT_GROUND_ALBEDO; 3],
    sun_angular_radius: DEFAULT_SUN_ANGULAR_RADIUS_DEG * core::f32::consts::PI / 180.0,
    intensity: 1.0,
    medium: SkyMedium::EARTH,
    moon: None,
    stars: crate::night_sky::DEFAULT_STARS,
};

impl Default for SkyParams {
    fn default() -> Self {
        DEFAULT_SKY
    }
}

impl SkyParams {
    /// The sky with `albedo` for the ground (each channel clamped to 0..=1).
    pub fn with_ground_albedo(mut self, albedo: [f32; 3]) -> SkyParams {
        self.ground_albedo = albedo.map(unit);
        self
    }

    /// The sky with a sun disk `degrees` in angular radius (clamped to the largest).
    pub fn with_sun_angular_radius_degrees(mut self, degrees: f32) -> SkyParams {
        self.sun_angular_radius = sun_radius(degrees);
        self
    }

    /// The sky with its radiance times `intensity` (clamped to `0..=ENVIRONMENT_INTENSITY_MAX`).
    pub fn with_intensity(mut self, intensity: f32) -> SkyParams {
        self.intensity = environment_intensity(intensity);
        self
    }

    /// The sky made of `medium` (held to what the LUTs take, [`SkyMedium::validated`]).
    pub fn with_medium(mut self, medium: SkyMedium) -> SkyParams {
        self.medium = medium.validated();
        self
    }

    /// The sky with `moon` (None: no moon).
    pub fn with_moon(mut self, moon: Option<Moon>) -> SkyParams {
        self.moon = moon;
        self
    }

    /// The sky with a star field of mean radiance `stars` at night (0: none; clamped to
    /// `0..=night_sky::STARS_MAX`).
    pub fn with_stars(mut self, stars: f32) -> SkyParams {
        self.stars = crate::night_sky::star_radiance(stars);
        self
    }
}

/// An HDR environment map from the game's assets.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct HdriEnvironment {
    /// The `.hdr` file, relative to the game's assets.
    pub path: String,
    /// A multiplier on the map's radiance.
    pub intensity: f32,
    /// The map's rotation about the world's up axis, in radians.
    pub rotation: f32,
    /// What the map's sun does.
    pub sun: HdriSun,
}

impl HdriEnvironment {
    /// The map at `path`, unrotated at intensity 1, its sun analytic.
    pub fn new(path: impl Into<String>) -> HdriEnvironment {
        HdriEnvironment { path: path.into(), intensity: 1.0, rotation: 0.0, sun: HdriSun::default() }
    }

    /// The map times `intensity` (clamped to `0..=ENVIRONMENT_INTENSITY_MAX`).
    pub fn with_intensity(mut self, intensity: f32) -> HdriEnvironment {
        self.intensity = environment_intensity(intensity);
        self
    }

    /// The map turned `degrees` about the up axis (a non-finite angle is no rotation).
    pub fn with_rotation_degrees(mut self, degrees: f32) -> HdriEnvironment {
        let degrees = if degrees.is_finite() { degrees % 360.0 } else { 0.0 };
        self.rotation = degrees.to_radians();
        self
    }

    /// The map with its sun handled by `sun`.
    pub fn with_sun(mut self, sun: HdriSun) -> HdriEnvironment {
        self.sun = sun;
        self
    }
}

/// What lights the scene besides its lights, and what is drawn behind it (per game: the same on
/// every preset and device; the facade's `frame.environment`). [`Environment::Color`], the
/// default, is the legacy renderer exactly: the flat ambient colour and the clear colour. A sky or
/// a map lights the scene by image-based lighting (a prefiltered specular cube, SH9 irradiance and
/// the split-sum BRDF LUT, baked on the GPU) where the quality turns IBL on, and is drawn behind
/// it where the quality turns the sky on; elsewhere the scene keeps the flat ambient term.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Environment {
    /// The flat ambient colour (the legacy renderer).
    #[default]
    Color,
    /// The physical sky.
    Sky(SkyParams),
    /// An HDR environment map.
    Hdri(HdriEnvironment),
}

impl Environment {
    /// The default physical sky.
    pub fn sky() -> Environment {
        Environment::Sky(SkyParams::default())
    }

    /// The HDR environment map at `path`, with the defaults of [`HdriEnvironment::new`].
    pub fn hdri(path: impl Into<String>) -> Environment {
        Environment::Hdri(HdriEnvironment::new(path))
    }

    /// Its kind.
    pub fn kind(&self) -> EnvironmentKind {
        match self {
            Environment::Color => EnvironmentKind::Color,
            Environment::Sky(_) => EnvironmentKind::Sky,
            Environment::Hdri(_) => EnvironmentKind::Hdri,
        }
    }

    /// Whether it lights the scene by image-based lighting (a sky or a map, not the flat colour).
    pub fn lights_scene(&self) -> bool {
        self.kind() != EnvironmentKind::Color
    }

    /// The sun's angular radius in radians: the sky's, else the real sun's (the default); the
    /// size of the light PCSS's penumbra grows with ([`ShadowSettings::sun_angular_radius`]).
    pub fn sun_angular_radius(&self) -> f32 {
        match self {
            Environment::Sky(sky) => sky.sun_angular_radius,
            _ => DEFAULT_SKY.sun_angular_radius,
        }
    }
}

fn unit(value: f32) -> f32 {
    if value.is_nan() { 0.0 } else { value.clamp(0.0, 1.0) }
}

fn environment_intensity(value: f32) -> f32 {
    if value.is_nan() { 1.0 } else { value.clamp(0.0, ENVIRONMENT_INTENSITY_MAX) }
}

fn sun_radius(degrees: f32) -> f32 {
    let degrees = if degrees.is_nan() { DEFAULT_SUN_ANGULAR_RADIUS_DEG } else { degrees.clamp(0.0, SUN_ANGULAR_RADIUS_MAX_DEG) };
    degrees.to_radians()
}

/// The fewest triangles a mesh needs to draw as meshlets: smaller meshes draw whole, where one
/// indexed draw is cheaper than culling their parts (R2's default).
pub const DEFAULT_MESHLET_MIN_TRIANGLES: u32 = 2048;
/// The smallest `min_triangles` a game may set: one full meshlet.
pub const MESHLET_MIN_TRIANGLES_FLOOR: u32 = crate::meshlet::MESHLET_MAX_TRIANGLES;

/// A game's meshlet rendering (R2): equal on every preset and device, like the look. The device's
/// quality switches the path on or off ([`Quality::meshlets`], [`Quality::occlusion`]); a game may
/// only narrow it (opt out, or cluster fewer meshes), never force it on a device whose preset has
/// it off.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Meshlets {
    /// Whether the game's meshes may draw as meshlets.
    pub enabled: bool,
    /// The fewest triangles a mesh needs to be clustered (at least [`MESHLET_MIN_TRIANGLES_FLOOR`]).
    pub min_triangles: u32,
    /// Whether two-pass Hi-Z occlusion may cull the meshlets.
    pub occlusion: bool,
}

impl Meshlets {
    /// Meshlets on for meshes of [`DEFAULT_MESHLET_MIN_TRIANGLES`] triangles or more, occlusion on.
    pub const DEFAULT: Meshlets = Meshlets { enabled: true, min_triangles: DEFAULT_MESHLET_MIN_TRIANGLES, occlusion: true };

    /// The setting with meshlets on or off.
    pub const fn with_enabled(mut self, on: bool) -> Meshlets {
        self.enabled = on;
        self
    }

    /// The setting clustering meshes of `triangles` or more (raised to the floor).
    pub const fn with_min_triangles(mut self, triangles: u32) -> Meshlets {
        self.min_triangles = if triangles < MESHLET_MIN_TRIANGLES_FLOOR { MESHLET_MIN_TRIANGLES_FLOOR } else { triangles };
        self
    }

    /// The setting with occlusion on or off.
    pub const fn with_occlusion(mut self, on: bool) -> Meshlets {
        self.occlusion = on;
        self
    }

    /// Whether a mesh of `triangles` triangles is clustered when meshlets are on.
    pub const fn clusters(&self, triangles: u32) -> bool {
        self.enabled && triangles >= self.min_triangles
    }

    /// Whether `other` clusters exactly the meshes this setting clusters: both off, or both on
    /// from the same triangle count. Occlusion moves no cluster.
    pub const fn same_clusters(&self, other: &Meshlets) -> bool {
        match (self.enabled, other.enabled) {
            (false, false) => true,
            (true, true) => self.min_triangles == other.min_triangles,
            _ => false,
        }
    }

    /// What a frame of `quality` draws: (meshlets, occlusion). Occlusion culls meshlet
    /// candidates, so it runs only where meshlets do.
    pub const fn drawn(&self, quality: &Quality) -> (bool, bool) {
        let meshlets = self.enabled && quality.meshlets;
        (meshlets, meshlets && self.occlusion && quality.occlusion)
    }
}

impl Default for Meshlets {
    fn default() -> Self {
        Meshlets::DEFAULT
    }
}

/// The scene colour target's format: chosen once per device class, never per preset.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SceneFormat {
    /// The legacy LDR scene: the world target's sRGB-encoded `Bgra8Unorm`.
    Ldr,
    /// `rgba16float` (WebGPU core).
    Rgba16Float,
    /// `rg11b10ufloat` (with the renderer-owned `RG11B10UFLOAT_RENDERABLE`).
    Rg11b10Ufloat,
}

impl SceneFormat {
    /// The texture format.
    pub const fn texture_format(self) -> TextureFormat {
        match self {
            SceneFormat::Ldr => TextureFormat::Bgra8Unorm,
            SceneFormat::Rgba16Float => TextureFormat::Rgba16Float,
            SceneFormat::Rg11b10Ufloat => TextureFormat::Rg11b10Ufloat,
        }
    }

    /// The HDR scene format of a device class: `rg11b10ufloat` when the class prefers the smaller
    /// target and the adapter offers `RG11B10UFLOAT_RENDERABLE`, `rgba16float` (core) otherwise.
    /// Chosen once per session (`presets::scene_format` applies it per class).
    pub const fn hdr_format(prefers_rg11b10: bool, rg11b10_renderable: bool) -> SceneFormat {
        if prefers_rg11b10 && rg11b10_renderable { SceneFormat::Rg11b10Ufloat } else { SceneFormat::Rgba16Float }
    }

    /// Whether the scene holds linear, pre-exposed HDR values (the tonemap maps them to display).
    pub const fn is_hdr(self) -> bool {
        !matches!(self, SceneFormat::Ldr)
    }

    /// Whether the scene keeps an alpha channel (`rg11b10ufloat` has none: a pass that needs
    /// scene alpha asks for `rgba16float`).
    pub const fn has_alpha(self) -> bool {
        !matches!(self, SceneFormat::Rg11b10Ufloat)
    }
}

/// Why an HDR-requested frame is drawn on the legacy LDR scene (sRGB-encoded `Bgra8Unorm`) with
/// standard Z instead (`state().volatile.render.degraded`; the host's `DegradeReason`). Nothing is
/// refused: every other feature stays on.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LdrReason {
    /// A Level-3 pass at custom-pass API v1 draws in the world (`after-opaque`,
    /// `after-transparent`): it expects the sRGB-encoded world target.
    CustomPassV1InWorld,
    /// A Level-2 material at extension API v1 draws in the frame: it returns sRGB-encoded colour.
    MaterialV1InHdr,
}

impl LdrReason {
    /// Every reason.
    pub const ALL: [LdrReason; 2] = [LdrReason::CustomPassV1InWorld, LdrReason::MaterialV1InHdr];

    /// The wire spelling (a `DegradeReason`).
    pub const fn wire(self) -> &'static str {
        match self {
            LdrReason::CustomPassV1InWorld => "custom-pass-v1-in-world",
            LdrReason::MaterialV1InHdr => "material-v1-in-hdr",
        }
    }
}

/// How edges are anti-aliased.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum AntiAliasing {
    /// None (1 sample, no history).
    Off,
    /// 4x MSAA (the legacy renderer; free in tile memory on tile GPUs).
    #[default]
    Msaa4,
    /// Temporal anti-aliasing (MSAA off).
    Taa,
    /// TAA followed by RCAS sharpening.
    TaaSharpen,
}

impl AntiAliasing {
    /// Samples per pixel of the world pass.
    pub const fn samples(self) -> u32 {
        match self {
            AntiAliasing::Msaa4 => MSAA_SAMPLE_COUNT,
            _ => 1,
        }
    }

    /// Whether a TAA history is kept.
    pub const fn temporal(self) -> bool {
        matches!(self, AntiAliasing::Taa | AntiAliasing::TaaSharpen)
    }
}

/// How a scene rendered below output size is upscaled.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Upscaler {
    /// Bilinear (fused into the tonemap on low).
    #[default]
    Bilinear,
    /// FSR1-style EASU edge-adaptive upscale plus RCAS sharpening.
    Fsr1,
}

/// How many frames TAA's Halton(2, 3) jitter runs before it repeats (plan §2.7): 8, or 16 on
/// ultra. A settled capture re-renders one whole cycle ([`crate::jitter`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum JitterCycle {
    /// Eight positions (high).
    #[default]
    Eight,
    /// Sixteen positions (ultra).
    Sixteen,
}

impl JitterCycle {
    /// Every cycle, shortest first.
    pub const ALL: [JitterCycle; 2] = [JitterCycle::Eight, JitterCycle::Sixteen];

    /// The positions in one cycle.
    pub const fn frames(self) -> u32 {
        match self {
            JitterCycle::Eight => 8,
            JitterCycle::Sixteen => 16,
        }
    }
}

/// TAA's accumulation floor by default: the current frame's weight never drops below it, so
/// history converges in about 1 / it frames and a stale texel fades within that (the colour clip
/// fades most sooner). 0.04 (pass-1 gate finding 05; was 0.1): the floor's running average of the
/// jittered frames kept 1.3% of a still camera's pixels flickering by more than 3 levels, and it
/// also makes ultra's sixteen-frame settled capture an exact box over its jitter cycle.
pub const DEFAULT_TAA_ALPHA_MIN: f32 = 0.04;
/// The smallest accumulation floor a quality may hold (lower ghosts for too long).
pub const TAA_ALPHA_MIN_FLOOR: f32 = 0.02;
/// The extra mip bias materials sample with under TAA, beside `log2(render_scale)`: the jitter
/// recovers the detail a sharper mip would alias (plan RQ5.2).
pub const DEFAULT_TAA_LOD_BIAS: f32 = -0.5;
/// The most negative total texture LOD bias TAA (or FSR1's upscale, [`frame_texture_lod_bias`])
/// may ask for (beyond it, textures shimmer).
pub const TAA_LOD_BIAS_MIN: f32 = -2.0;

/// The mip bias material textures sample with on one frame at its `render_scale` (renderer pass
/// 2, P2-0.8b T-06): TAA's ([`TaaQuality::texture_lod_bias`]) when TAA resolves the frame
/// (`temporal`), else `log2(scale)` when FSR1's EASU upscales it (`easu`; FSR1 asks for the
/// negative mip bias `log2(render / display)`, without the temporal upscalers' extra -1, so a
/// texture is sampled at the mip the display would take), never below [`TAA_LOD_BIAS_MIN`], else
/// 0. Taken from the frame's own scale, so a dynamic-resolution step moves it.
pub fn frame_texture_lod_bias(taa: &TaaQuality, temporal: bool, easu: bool, render_scale: f32) -> f32 {
    if temporal {
        return taa.texture_lod_bias(render_scale);
    }
    if !easu {
        return 0.0;
    }
    libm::log2f(held_render_scale(render_scale)).max(TAA_LOD_BIAS_MIN)
}

/// `render_scale` held to `RENDER_SCALE_MIN..=1` (NaN: 1), as the mip biases read it.
fn held_render_scale(render_scale: f32) -> f32 {
    if render_scale.is_nan() { 1.0 } else { render_scale.clamp(RENDER_SCALE_MIN, 1.0) }
}

/// TAA's resource knobs (RQ5): equal pipelines whatever their values, so DRS and demotion may
/// move them. Whether TAA runs at all, and whether RCAS sharpens after it, is
/// [`AntiAliasing`] (a pipeline knob).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaaQuality {
    /// The jitter's cycle (also a settled capture's re-renders).
    pub jitter_cycle: JitterCycle,
    /// The current frame's least weight: accumulation is `max(1 / (n + 1), alpha_min)` after the
    /// history's `n`-th frame since its reset.
    pub alpha_min: f32,
    /// The texture LOD bias added to `log2(render_scale)` while TAA runs (negative: sharper).
    pub lod_bias: f32,
}

impl TaaQuality {
    /// Cycle 8, [`DEFAULT_TAA_ALPHA_MIN`], [`DEFAULT_TAA_LOD_BIAS`].
    pub const DEFAULT: TaaQuality = TaaQuality { jitter_cycle: JitterCycle::Eight, alpha_min: DEFAULT_TAA_ALPHA_MIN, lod_bias: DEFAULT_TAA_LOD_BIAS };

    /// The quality with `cycle` instead.
    pub const fn with_jitter_cycle(mut self, cycle: JitterCycle) -> TaaQuality {
        self.jitter_cycle = cycle;
        self
    }

    /// The quality with an accumulation floor of `alpha_min`, held to `TAA_ALPHA_MIN_FLOOR..=1`
    /// (NaN keeps the default).
    pub fn with_alpha_min(mut self, alpha_min: f32) -> TaaQuality {
        self.alpha_min = held(alpha_min, DEFAULT_TAA_ALPHA_MIN, TAA_ALPHA_MIN_FLOOR, 1.0);
        self
    }

    /// The quality with an extra LOD bias of `bias`, held to `TAA_LOD_BIAS_MIN..=0` (NaN keeps
    /// the default).
    pub fn with_lod_bias(mut self, bias: f32) -> TaaQuality {
        self.lod_bias = held(bias, DEFAULT_TAA_LOD_BIAS, TAA_LOD_BIAS_MIN, 0.0);
        self
    }

    /// The mip bias materials sample with under TAA at `render_scale`: `log2(scale) + lod_bias`,
    /// never below [`TAA_LOD_BIAS_MIN`] (libm's `log2f`, the same bits on every target).
    pub fn texture_lod_bias(&self, render_scale: f32) -> f32 {
        (libm::log2f(held_render_scale(render_scale)) + self.lod_bias).max(TAA_LOD_BIAS_MIN)
    }
}

impl Default for TaaQuality {
    fn default() -> Self {
        TaaQuality::DEFAULT
    }
}

/// RCAS's sharpness by default, in AMD's stops (0 is the sharpest; each stop halves it).
pub const DEFAULT_RCAS_SHARPNESS: f32 = 0.2;
/// The softest RCAS a quality may ask for, in stops.
pub const RCAS_SHARPNESS_MAX: f32 = 2.0;
/// RCAS's sharpness after TAA alone at scale 1 on ultra ([`AntiAliasing::TaaSharpen`], RQ5 review):
/// softer than the upscale's, since a resolved full-size frame needs little sharpening and the
/// default near-maximum strength turned the noise TAA cannot integrate into visible grain.
pub const TAA_SHARPEN_RCAS_SHARPNESS: f32 = 0.75;

/// RCAS's resource knob (RQ5): how hard the FSR1 upscale ([`Upscaler::Fsr1`]) and TAA's sharpen
/// ([`AntiAliasing::TaaSharpen`]) sharpen. Whether RCAS runs is those pipeline knobs'.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RcasQuality {
    /// Sharpness in stops, `0..=RCAS_SHARPNESS_MAX` (0 sharpest).
    pub sharpness: f32,
    /// Whether RCAS's noise detection (FSR1's `FSR_RCAS_DENOISE`) softens the lobe where the plus
    /// neighbourhood looks like noise, not an edge (RQ5 review: on by default, so per-pixel noise
    /// a frame's sources did not key to the frame is not sharpened into grain).
    pub denoise: bool,
}

impl RcasQuality {
    /// [`DEFAULT_RCAS_SHARPNESS`], noise detection on.
    pub const DEFAULT: RcasQuality = RcasQuality { sharpness: DEFAULT_RCAS_SHARPNESS, denoise: true };

    /// The quality with noise detection `on` or off.
    pub const fn with_denoise(mut self, on: bool) -> RcasQuality {
        self.denoise = on;
        self
    }

    /// The quality with `stops` of sharpness, held to `0..=RCAS_SHARPNESS_MAX` (NaN keeps the
    /// default).
    pub fn with_sharpness(mut self, stops: f32) -> RcasQuality {
        self.sharpness = held(stops, DEFAULT_RCAS_SHARPNESS, 0.0, RCAS_SHARPNESS_MAX);
        self
    }
}

impl Default for RcasQuality {
    fn default() -> Self {
        RcasQuality::DEFAULT
    }
}

/// How shadow maps are filtered.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ShadowFilter {
    /// One hardware 2x2 comparison tap.
    Hardware2x2,
    /// 3x3 comparison PCF (the legacy renderer).
    #[default]
    Pcf3x3,
    /// PCSS-lite: 8 blocker and 16 PCF taps.
    PcssLite,
    /// PCSS: 16 blocker and 32 PCF taps.
    Pcss,
    /// 5x5 comparison PCF (RQ3.0): softer than 3x3 without a blocker search.
    Pcf5x5,
}

impl ShadowFilter {
    /// Every filter, in shader-id order.
    pub const ALL: [ShadowFilter; 5] =
        [ShadowFilter::Hardware2x2, ShadowFilter::Pcf3x3, ShadowFilter::Pcf5x5, ShadowFilter::PcssLite, ShadowFilter::Pcss];

    /// The sun chunk's `GX_SHADOW_FILTER` pipeline constant (shaders/lighting/sun.wgsl): a
    /// pipeline knob, so a change rebuilds the forward pipelines ([`QualityKnob::ShadowFilter`]).
    pub const fn shader_id(self) -> u32 {
        match self {
            ShadowFilter::Hardware2x2 => 0,
            ShadowFilter::Pcf3x3 => 1,
            ShadowFilter::Pcf5x5 => 2,
            ShadowFilter::PcssLite => 3,
            ShadowFilter::Pcss => 4,
        }
    }

    /// Whether the filter searches for blockers first (PCSS: a penumbra that widens with the
    /// receiver's distance to its blocker), through the non-filtering
    /// [`crate::layout::SHADOW_BLOCKER_SAMPLER`].
    pub const fn searches_blockers(self) -> bool {
        matches!(self, ShadowFilter::PcssLite | ShadowFilter::Pcss)
    }
}

/// The shadow map depth format.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ShadowFormat {
    /// `depth16unorm`.
    Depth16,
    /// `depth32float` (the legacy renderer).
    #[default]
    Depth32,
}

impl ShadowFormat {
    /// The shadow maps' texture format. Both are WebGPU core depth formats that take comparison
    /// sampling; `depth16unorm` halves the bytes (low and mobile classes).
    pub const fn texture_format(self) -> TextureFormat {
        match self {
            ShadowFormat::Depth16 => TextureFormat::Depth16Unorm,
            ShadowFormat::Depth32 => TextureFormat::Depth32Float,
        }
    }
}

/// The weight of the logarithmic cascade split against the uniform one by default (the practical
/// split; the legacy renderer's).
pub const DEFAULT_SHADOW_SPLIT_LAMBDA: f32 = 0.5;
/// The cascade blend band by default: a hard switch between cascades (the legacy renderer's).
pub const DEFAULT_SHADOW_BLEND_BAND: f32 = 0.0;
/// The widest cascade blend band, as a fraction of a cascade's depth range.
pub const SHADOW_BLEND_BAND_MAX: f32 = 0.5;
/// The widest end fade, as a fraction of the last cascade's depth range.
pub const SHADOW_END_FADE_MAX: f32 = 0.5;
/// The legacy renderer's shadow distance in world units (`Quality::off()`'s).
pub const LEGACY_SHADOW_DISTANCE_M: u16 = 40;
/// The shortest and longest shadow distance a preset, a game or a person may ask for, world units.
pub const SHADOW_DISTANCE_MIN_M: u16 = 10;
/// The longest shadow distance (see [`SHADOW_DISTANCE_MIN_M`]).
pub const SHADOW_DISTANCE_MAX_M: u16 = 400;

/// What one frame's sun shadows are drawn with (RQ3.0): the preset's [`ShadowQuality`] (cascades,
/// map size, filter, format, cadence, distance, split, blend band and end fade; a scene's own
/// shadow distance wins over the preset's), and the sun's angular radius from the game's
/// [`Environment`] (PCSS's light size). [`ShadowSettings::legacy`] is today's shadows exactly.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowSettings {
    /// Cascades, 1 to [`MAX_CASCADES`].
    pub cascades: u8,
    /// Each cascade's side in texels.
    pub map_px: u32,
    /// How far from the camera the sun's shadows reach, in world units.
    pub distance: f32,
    /// The weight of the logarithmic split against the uniform one, 0..=1.
    pub split_lambda: f32,
    /// The filter.
    pub filter: ShadowFilter,
    /// The fraction of each cascade's depth range blended into the next, `0..=SHADOW_BLEND_BAND_MAX`.
    pub blend_band: f32,
    /// The fraction of the last cascade's depth range over which the shadows fade out before the
    /// shadow distance, `0..=SHADOW_END_FADE_MAX` (0: a hard end).
    pub end_fade: f32,
    /// The sun's angular radius in radians (from the environment's sun).
    pub sun_angular_radius: f32,
    /// The shadow maps' depth format.
    pub format: ShadowFormat,
    /// Far cascades are redrawn every this many frames (1: every frame); the nearest cascade
    /// draws every frame and a settled capture draws every cascade.
    pub far_cadence: u8,
}

impl ShadowSettings {
    /// The shadows the legacy renderer draws up to `distance` (0: its 40 units): two 1024 px
    /// `depth32float` cascades at the practical split, 3x3 PCF with a hard switch and a hard end,
    /// every frame.
    pub fn legacy(distance: f32) -> ShadowSettings {
        ShadowSettings::from_quality(&Quality::off().shadows, distance, DEFAULT_SKY.sun_angular_radius)
    }

    /// The shadows of `quality` up to the scene's `distance` (0, the scene default, or a NaN: the
    /// quality's [`ShadowQuality::distance`]), under a sun `sun_angular_radius` radians wide, each
    /// value held to its range (a NaN radius keeps the default).
    pub fn from_quality(quality: &ShadowQuality, distance: f32, sun_angular_radius: f32) -> ShadowSettings {
        let distance = if distance.is_finite() && distance > 0.0 { distance } else { f32::from(quality.distance.max(1)) };
        let radius = if sun_angular_radius.is_nan() { DEFAULT_SKY.sun_angular_radius } else { sun_angular_radius };
        let percent = |value: u8, max: f32| (f32::from(value) / 100.0).clamp(0.0, max);
        ShadowSettings {
            cascades: quality.cascades.clamp(1, MAX_CASCADES),
            map_px: quality.map_size.max(1),
            distance,
            split_lambda: percent(quality.split_percent, 1.0),
            filter: quality.filter,
            blend_band: percent(quality.blend_percent, SHADOW_BLEND_BAND_MAX),
            end_fade: percent(quality.fade_percent, SHADOW_END_FADE_MAX),
            sun_angular_radius: radius.clamp(0.0, SUN_ANGULAR_RADIUS_MAX_DEG.to_radians()),
            format: quality.format,
            far_cadence: quality.far_cadence.max(1),
        }
    }

    /// The settings with the logarithmic split weighted `lambda` (clamped to 0..=1; NaN keeps it).
    pub fn with_split_lambda(mut self, lambda: f32) -> ShadowSettings {
        self.split_lambda = held(lambda, self.split_lambda, 0.0, 1.0);
        self
    }

    /// The settings with a cascade blend band of `band` (clamped to `0..=SHADOW_BLEND_BAND_MAX`).
    pub fn with_blend_band(mut self, band: f32) -> ShadowSettings {
        self.blend_band = held(band, self.blend_band, 0.0, SHADOW_BLEND_BAND_MAX);
        self
    }

    /// The settings with an end fade of `fade` (clamped to `0..=SHADOW_END_FADE_MAX`).
    pub fn with_end_fade(mut self, fade: f32) -> ShadowSettings {
        self.end_fade = held(fade, self.end_fade, 0.0, SHADOW_END_FADE_MAX);
        self
    }

    /// The shadow maps' texture format.
    pub const fn texture_format(&self) -> TextureFormat {
        self.format.texture_format()
    }

    /// Whether `cascade` is redrawn on frame `frame_index` (the frame index temporal effects key
    /// to): cascade 0 every frame; far cascade `c` on the frames where `frame_index` is
    /// `c - 1` modulo the cadence, so at most one far cascade redraws per frame at a cadence of
    /// at least the far cascades' count; every cascade when `settled` (a settled capture, a
    /// history reset) or at a cadence of 1. A cascade that is not redrawn keeps last frame's map
    /// and matrix.
    pub const fn cascade_redrawn(&self, cascade: u8, frame_index: u64, settled: bool) -> bool {
        if settled || cascade == 0 || self.far_cadence <= 1 {
            return true;
        }
        let cadence = self.far_cadence as u64;
        frame_index % cadence == (cascade as u64 - 1) % cadence
    }
}

/// Sun shadows.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ShadowQuality {
    /// Whether the sun casts shadows at all.
    pub enabled: bool,
    /// Cascades, 1 to [`MAX_CASCADES`].
    pub cascades: u8,
    /// Each cascade's side in pixels.
    pub map_size: u32,
    /// The filter.
    pub filter: ShadowFilter,
    /// The depth format.
    pub format: ShadowFormat,
    /// The farthest cascade is redrawn every this many frames (1 = every frame).
    pub far_cadence: u8,
    /// How far from the camera the sun's shadows reach, in world units, when the scene does not
    /// set its own distance (`Lighting::shadow_distance` of 0).
    pub distance: u16,
    /// The weight of the logarithmic cascade split against the uniform one, in percent (50: the
    /// practical split).
    pub split_percent: u8,
    /// The share of each cascade's depth range blended into the next, in percent (0: a hard
    /// switch; at most 50).
    pub blend_percent: u8,
    /// The share of the last cascade's depth range over which the shadows fade out before the
    /// shadow distance, in percent (0: a hard end; at most 50).
    pub fade_percent: u8,
    /// Whether a soft filter's sun shadows may come from the screen mask where its key lets it
    /// run (renderer pass 2, B.7; `post::sun_mask::key`). A resource knob: the degrade ladder's
    /// `sun-mask` rung turns it off, and the forward pass then shades the sun inline.
    pub screen_mask: bool,
}

/// Bloom. The chain is sized from the output, never the render size, and keeps one mip count
/// ([`crate::post::bloom::CHAIN_MIPS`]) on every preset, so its halo is as wide at every preset
/// and DRS step; a preset or the degrade ladder lowers only its resolution.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BloomQuality {
    /// Whether bloom runs.
    pub enabled: bool,
    /// The chain's top height cap in texels: the chain starts at `min(output height / 2, this)`
    /// rows (0: no chain).
    pub resolution: u16,
}

/// Ambient occlusion's resolution (GTAO).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum AoResolution {
    /// No AO.
    #[default]
    Off,
    /// Half resolution.
    Half,
    /// Full resolution.
    Full,
}

/// Ambient occlusion.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AoQuality {
    /// Resolution (off disables it).
    pub resolution: AoResolution,
    /// GTAO slices.
    pub slices: u8,
    /// Steps per slice.
    pub steps: u8,
    /// Whether AO keeps a temporal history.
    pub temporal: bool,
}

impl AoQuality {
    /// Whether GTAO also integrates a bent normal for specular occlusion: with two or more slices
    /// (high and ultra), where the estimate is stable enough to steer the reflection.
    pub const fn bent_normals(&self) -> bool {
        self.slices >= 2 && !matches!(self.resolution, AoResolution::Off)
    }
}

/// Image-based lighting and the sky.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EnvironmentQuality {
    /// Whether IBL shades the scene.
    pub ibl: bool,
    /// The specular cube's side in pixels.
    pub cube_size: u32,
    /// The specular cube's side in pixels under an HDR map (a map holds detail the smooth sky
    /// lacks: ultra bakes it larger).
    pub hdri_cube_size: u32,
    /// A rebake runs one time-sliced step every this many frames (frame-indexed; 1: every frame).
    pub rebake_cadence: u8,
    /// How far the sun turns, in tenths of a degree, before the sky is rebaked into the
    /// environment.
    pub sun_rebake_tenths: u16,
    /// Whether the procedural sky draws.
    pub sky: bool,
    /// The sky-view LUT size.
    pub sky_lut: (u32, u32),
    /// The sky LUTs are refreshed every this many frames.
    pub sky_cadence: u8,
    /// Whether the aerial-perspective volume is used.
    pub aerial_perspective: bool,
    /// The largest radiance cube (the prefilter's source, `ibl::radiance_side`) in pixels; 0
    /// keeps it at half the specular side. Phones cap it (`presets::MOBILE_MAX_RADIANCE_PX`).
    pub radiance_side_max: u32,
    /// Most reflection probes given a captured cube (renderer pass 2 A.3, `probes`): the first
    /// this many a frame declares; 0 shades none (the sky alone). A resource knob.
    pub reflection_probes: u8,
    /// The largest probe cube side in pixels (`probes::probe_side`: the sky cube's side, at most
    /// this; 0: no cap). A resource knob.
    pub probe_side_max: u32,
    /// Whether a moving sun rebakes the sky's cube whole on every frame it turns past
    /// `ibl::CONTINUOUS_SUN_DEGREES` (renderer pass 2 A.3, SI-02 step 2: desktop and web `high`
    /// and `ultra`), instead of over a time-sliced cycle once it turned `sun_rebake_tenths`.
    pub continuous_sky: bool,
    /// Most irradiance volumes baked (renderer pass 2 A.4, `irradiance`): the first this many a
    /// frame declares; 0 bakes none (the sky's SH9 alone). A resource knob.
    pub irradiance_volumes: u8,
    /// Whether a volume's lookup hides the cells a point is behind a wall from (eight hand-weighed
    /// cells, `irradiance::grid_irradiance`) instead of the sampler's three trilinear fetches.
    pub irradiance_leak_control: bool,
    /// The froxel fog's grid (renderer pass 2 A.5, [`crate::froxel`]): the height fog lit per
    /// froxel by the shadowed sun and the binned lights (sun shafts), bound in the aerial volume's
    /// place; None keeps the analytic fog. Desktop and web `high` and `ultra`. A resource knob.
    pub froxel_fog: Option<crate::froxel::FroxelGrid>,
}

/// Local lights.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LightQuality {
    /// Most local lights shaded.
    pub cap: u32,
    /// Whether lights are binned per tile (clustered) instead of looped per fragment.
    pub clustered: bool,
    /// The binning tile's side in pixels.
    pub tile_px: u32,
    /// Spot lights with shadow maps.
    pub shadowed_spots: u8,
    /// Most projected decals drawn (renderer pass 2 A.10, `decals::held_decals`: nearest first,
    /// the last ones faded towards the cut); 0 draws none. Decals are binned with the lights, so
    /// only a `clustered` quality draws them.
    pub decals: u32,
}

/// A material texture size class (RQ6): the side of the texture arrays a texture is stored in.
/// Each class is its own pair of arrays (`layout::TEXTURE_SIZE_CLASSES`); a texture goes in the
/// smallest class that holds its source size, capped at [`TextureQuality::max_class`].
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TextureClass {
    /// 256 texels: today's arrays (every texture is resampled to it).
    S256,
    /// 512 texels.
    S512,
    /// 1024 texels.
    S1024,
    /// 2048 texels.
    S2048,
}

impl TextureClass {
    /// Every class, smallest first.
    pub const ALL: [TextureClass; 4] = [TextureClass::S256, TextureClass::S512, TextureClass::S1024, TextureClass::S2048];

    /// The class index a material texture reference carries (`layout::texture_ref`).
    pub const fn index(self) -> u32 {
        match self {
            TextureClass::S256 => 0,
            TextureClass::S512 => 1,
            TextureClass::S1024 => 2,
            TextureClass::S2048 => 3,
        }
    }

    /// The arrays' side in texels.
    pub const fn side(self) -> u32 {
        crate::layout::TEXTURE_SIZE_CLASSES[self.index() as usize]
    }
}

/// Material texture quality (RQ6.4).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TextureQuality {
    /// The largest size class textures are stored in (the budget's degrade step drops the largest
    /// class first). [`TextureClass::S256`] is today's: every texture resampled to 256.
    pub max_class: TextureClass,
    /// Whether normal-map mips are renormalized with the lost length folded into roughness
    /// (Toksvig); off keeps today's mips.
    pub toksvig: bool,
}

impl TextureQuality {
    /// Today's textures: one 256 class, today's mips.
    pub const OFF: TextureQuality = TextureQuality { max_class: TextureClass::S256, toksvig: false };
}

/// Shadowed spots the `spot-shadows` switch grants where the preset had none (high's count).
pub const SPOT_SHADOWS_SWITCHED_ON: u8 = 2;

/// `textures` with the texture-quality switch `on`: off is [`TextureQuality::OFF`]; on keeps a
/// quality that is on, else holds sources up to 1024 with Toksvig mips.
const fn textures_switched(textures: TextureQuality, on: bool) -> TextureQuality {
    if !on {
        return TextureQuality::OFF;
    }
    if textures.toksvig || !matches!(textures.max_class, TextureClass::S256) {
        return textures;
    }
    TextureQuality { max_class: TextureClass::S1024, toksvig: true }
}

/// `spots` shadowed spots with the spot-shadows switch `on`.
const fn spots_switched(spots: u8, on: bool) -> u8 {
    match (on, spots) {
        (false, _) => 0,
        (true, 0) => SPOT_SHADOWS_SWITCHED_ON,
        (true, spots) => spots,
    }
}

/// The per-preset quality: one switch struct per feature (plan §2.4).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quality {
    /// Whether the scene renders to an HDR target with tonemapping.
    pub hdr: bool,
    /// Whether the look's tonemapper is applied (a clamp otherwise).
    pub tonemap: bool,
    /// Whether the look's exposure is applied (1.0 otherwise).
    pub exposure: bool,
    /// The exposure histogram's input is 1 / this of the render size per side.
    pub exposure_input_divisor: u8,
    /// Anti-aliasing.
    pub anti_aliasing: AntiAliasing,
    /// The nominal render scale (output size × scale; dynamic resolution steps around it).
    pub render_scale: f32,
    /// The upscaler used below scale 1.
    pub upscaler: Upscaler,
    /// TAA's jitter cycle, accumulation floor and LOD bias (used while TAA runs).
    pub taa: TaaQuality,
    /// RCAS's sharpness (used while FSR1 or TAA's sharpen runs).
    pub rcas: RcasQuality,
    /// Sun shadows.
    pub shadows: ShadowQuality,
    /// Contact shadows.
    pub contact_shadows: bool,
    /// Bloom.
    pub bloom: BloomQuality,
    /// Ambient occlusion.
    pub ao: AoQuality,
    /// Height and distance fog.
    pub fog: bool,
    /// IBL and sky.
    pub environment: EnvironmentQuality,
    /// Local lights.
    pub lights: LightQuality,
    /// Material texture size classes and normal-map mips (RQ6.4: every preset holds sources up to
    /// its largest class with Toksvig mips, `texture::preset_textures`; [`TextureQuality::OFF`] is
    /// the legacy single 256 class). A boot knob: the renderer's arrays keep the quality of its
    /// first texture.
    pub textures: TextureQuality,
    /// Whether the depth/normal prepass may run for its consumers.
    pub prepass: bool,
    /// Meshlet rendering.
    pub meshlets: bool,
    /// Two-pass Hi-Z occlusion culling.
    pub occlusion: bool,
    /// Specular anti-aliasing (roughness from normal variance).
    pub specular_aa: bool,
    /// The material sampler's anisotropic filtering, 1..=16 (`anisotropy_clamp`; P2-0.12 LG-02):
    /// a resource knob (a new sampler and frame group, no pipeline). 1 is plain trilinear.
    pub anisotropy: u8,
    /// The depth-of-field gather where the look turns it on (A.9): Filament's ring gather on
    /// desktop and web `high` and `ultra`, Godot's circular gather elsewhere. A pipeline knob.
    pub dof: crate::post::dof::DofTier,
    /// The motion blur where the look turns it on (A.9): KinoMotion's reconstruction on desktop
    /// and web `high` and `ultra`, Bevy's direct blur on `low`, `medium` and phones, none on the
    /// low-tier phone or the legacy renderer. A pipeline knob.
    pub motion_blur: crate::post::motion_blur::MotionBlurTier,
    /// The screen inputs Stage B's water and screen-space reflections may ask for (A.6): the
    /// opaque copy, the previous frame's colour pyramid and the prepass's normal and roughness on
    /// desktop and web `high` and `ultra`, none elsewhere. A resource knob (targets and passes run
    /// only for a consumer that asks; the prepass's second target is its consumer's pipeline).
    pub screen_inputs: crate::screen_inputs::ScreenInputs,
    /// The terrain's grass (A.8): its density, reach, blade segments and casting. A resource knob
    /// (uniforms and buffer sizes, never a pipeline); off on `low`, the low phones and the legacy
    /// renderer.
    pub grass: crate::foliage::GrassQuality,
}

impl Quality {
    /// The legacy renderer: LDR, MSAA 4x, the legacy shadows, nothing else.
    pub const fn off() -> Quality {
        Quality {
            hdr: false,
            tonemap: false,
            exposure: false,
            exposure_input_divisor: 16,
            anti_aliasing: AntiAliasing::Msaa4,
            render_scale: 1.0,
            upscaler: Upscaler::Bilinear,
            taa: TaaQuality::DEFAULT,
            rcas: RcasQuality::DEFAULT,
            shadows: ShadowQuality {
                enabled: true,
                cascades: SHADOW_CASCADES as u8,
                map_size: SHADOW_MAP_PX,
                filter: ShadowFilter::Pcf3x3,
                format: ShadowFormat::Depth32,
                far_cadence: 1,
                distance: LEGACY_SHADOW_DISTANCE_M,
                split_percent: 50,
                blend_percent: 0,
                fade_percent: 0,
                screen_mask: true,
            },
            contact_shadows: false,
            bloom: BloomQuality { enabled: false, resolution: 0 },
            ao: AoQuality { resolution: AoResolution::Off, slices: 0, steps: 0, temporal: false },
            fog: false,
            environment: EnvironmentQuality {
                ibl: false,
                cube_size: 0,
                hdri_cube_size: 0,
                rebake_cadence: 1,
                sun_rebake_tenths: 5,
                sky: false,
                sky_lut: (0, 0),
                sky_cadence: 1,
                aerial_perspective: false,
                radiance_side_max: 0,
                reflection_probes: 0,
                probe_side_max: 0,
                continuous_sky: false,
                irradiance_volumes: 0,
                irradiance_leak_control: false,
                froxel_fog: None,
            },
            lights: LightQuality { cap: MAX_LIGHTS as u32, clustered: false, tile_px: 0, shadowed_spots: 0, decals: 0 },
            textures: TextureQuality::OFF,
            prepass: false,
            meshlets: false,
            occlusion: false,
            specular_aa: false,
            anisotropy: 1,
            dof: crate::post::dof::DofTier::Circular,
            motion_blur: crate::post::motion_blur::MotionBlurTier::Off,
            screen_inputs: crate::screen_inputs::ScreenInputs::NONE,
            grass: crate::foliage::GrassQuality::OFF,
        }
    }

    /// Whether `feature`'s switch is on.
    pub fn feature(&self, feature: RenderFeature) -> bool {
        match feature {
            RenderFeature::Hdr => self.hdr,
            RenderFeature::Tonemap => self.tonemap,
            RenderFeature::Exposure => self.exposure,
            RenderFeature::Ibl => self.environment.ibl,
            RenderFeature::Sky => self.environment.sky,
            RenderFeature::Shadows => self.shadows.enabled,
            RenderFeature::ContactShadows => self.contact_shadows,
            RenderFeature::Bloom => self.bloom.enabled,
            RenderFeature::Ao => self.ao.resolution != AoResolution::Off,
            RenderFeature::Fog => self.fog,
            RenderFeature::Taa => self.anti_aliasing.temporal(),
            RenderFeature::Upscaler => self.upscaler == Upscaler::Fsr1,
            RenderFeature::Clustered => self.lights.clustered,
            RenderFeature::Meshlets => self.meshlets,
            RenderFeature::Occlusion => self.occlusion,
            RenderFeature::Prepass => self.prepass,
            RenderFeature::TextureQuality => self.textures != TextureQuality::OFF,
            RenderFeature::SpotShadows => self.lights.shadowed_spots > 0,
        }
    }

    /// Turn `feature`'s switch on or off (the person's or genex.toml's per-feature override).
    /// Turning AO on picks half resolution; turning TAA off returns to MSAA 4x; turning texture
    /// quality on keeps the preset's classes, or holds sources up to [`TextureClass::S1024`] with
    /// Toksvig mips where it was off; turning spot shadows on keeps the preset's slots, or grants
    /// [`SPOT_SHADOWS_SWITCHED_ON`] where it had none (the device class's caps apply after).
    pub fn set_feature(&mut self, feature: RenderFeature, on: bool) {
        match feature {
            RenderFeature::Hdr => self.hdr = on,
            RenderFeature::Tonemap => self.tonemap = on,
            RenderFeature::Exposure => self.exposure = on,
            RenderFeature::Ibl => self.environment.ibl = on,
            RenderFeature::Sky => self.environment.sky = on,
            RenderFeature::Shadows => self.shadows.enabled = on,
            RenderFeature::ContactShadows => self.contact_shadows = on,
            RenderFeature::Bloom => self.bloom.enabled = on,
            RenderFeature::Ao => self.ao.resolution = if on { AoResolution::Half } else { AoResolution::Off },
            RenderFeature::Fog => self.fog = on,
            RenderFeature::Taa => self.anti_aliasing = if on { AntiAliasing::Taa } else { AntiAliasing::Msaa4 },
            RenderFeature::Upscaler => self.upscaler = if on { Upscaler::Fsr1 } else { Upscaler::Bilinear },
            RenderFeature::Clustered => self.lights.clustered = on,
            RenderFeature::Meshlets => self.meshlets = on,
            RenderFeature::Occlusion => self.occlusion = on,
            RenderFeature::Prepass => self.prepass = on,
            RenderFeature::TextureQuality => self.textures = textures_switched(self.textures, on),
            RenderFeature::SpotShadows => self.lights.shadowed_spots = spots_switched(self.lights.shadowed_spots, on),
        }
    }

    /// The pipeline-shaping knobs: two qualities with equal keys use the same pipelines, so
    /// switching between them is a resource change (allowed at runtime).
    pub fn pipeline_key(&self) -> PipelineKey {
        PipelineKey {
            hdr: self.hdr,
            tonemap: self.tonemap,
            exposure: self.exposure,
            anti_aliasing: self.anti_aliasing,
            upscaler: self.upscaler,
            shadow_filter: self.shadows.filter,
            shadow_format: self.shadows.format,
            contact_shadows: self.contact_shadows,
            ao_temporal: self.ao.temporal,
            ao_slices: self.ao.slices,
            ao_steps: self.ao.steps,
            fog: self.fog,
            ibl: self.environment.ibl,
            sky: self.environment.sky,
            aerial_perspective: self.environment.aerial_perspective,
            clustered: self.lights.clustered,
            prepass: self.prepass,
            meshlets: self.meshlets,
            occlusion: self.occlusion,
            specular_aa: self.specular_aa,
        }
    }

    /// Whether moving from `self` to `other` changes resource knobs only.
    pub fn resource_change_only(&self, other: &Quality) -> bool {
        self.pipeline_key() == other.pipeline_key()
    }
}

impl Default for Quality {
    fn default() -> Self {
        Quality::off()
    }
}

/// The pipeline-shaping part of a [`Quality`] (see [`Quality::pipeline_key`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PipelineKey {
    /// [`Quality::hdr`].
    pub hdr: bool,
    /// [`Quality::tonemap`].
    pub tonemap: bool,
    /// [`Quality::exposure`].
    pub exposure: bool,
    /// [`Quality::anti_aliasing`] (the sample count).
    pub anti_aliasing: AntiAliasing,
    /// [`Quality::upscaler`].
    pub upscaler: Upscaler,
    /// [`ShadowQuality::filter`].
    pub shadow_filter: ShadowFilter,
    /// [`ShadowQuality::format`].
    pub shadow_format: ShadowFormat,
    /// [`Quality::contact_shadows`].
    pub contact_shadows: bool,
    /// [`AoQuality::temporal`].
    pub ao_temporal: bool,
    /// [`AoQuality::slices`] (an override constant).
    pub ao_slices: u8,
    /// [`AoQuality::steps`] (an override constant).
    pub ao_steps: u8,
    /// [`Quality::fog`].
    pub fog: bool,
    /// [`EnvironmentQuality::ibl`].
    pub ibl: bool,
    /// [`EnvironmentQuality::sky`].
    pub sky: bool,
    /// [`EnvironmentQuality::aerial_perspective`].
    pub aerial_perspective: bool,
    /// [`LightQuality::clustered`].
    pub clustered: bool,
    /// [`Quality::prepass`].
    pub prepass: bool,
    /// [`Quality::meshlets`].
    pub meshlets: bool,
    /// [`Quality::occlusion`].
    pub occlusion: bool,
    /// [`Quality::specular_aa`].
    pub specular_aa: bool,
}

/// A per-feature switch id (`RenderFeature` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RenderFeature {
    /// HDR scene target.
    Hdr,
    /// Tonemapping.
    Tonemap,
    /// Exposure.
    Exposure,
    /// Image-based lighting.
    Ibl,
    /// Procedural sky.
    Sky,
    /// Sun shadows.
    Shadows,
    /// Screen-space contact shadows.
    ContactShadows,
    /// Bloom.
    Bloom,
    /// Ambient occlusion.
    Ao,
    /// Fog.
    Fog,
    /// Temporal anti-aliasing.
    Taa,
    /// EASU + RCAS upscaling.
    Upscaler,
    /// Clustered (binned) local lights.
    Clustered,
    /// Meshlets.
    Meshlets,
    /// Hi-Z occlusion culling.
    Occlusion,
    /// Depth/normal prepass.
    Prepass,
    /// Texture size classes above 256 and Toksvig normal-map mips (RQ6.4). A boot knob: the
    /// material arrays keep the texture quality they were made with until the game reloads.
    TextureQuality,
    /// Shadow maps for spot lights that ask for one (RQ6.5).
    SpotShadows,
}

impl RenderFeature {
    /// Every feature switch, in wire order.
    pub const ALL: [RenderFeature; 18] = [
        RenderFeature::Hdr,
        RenderFeature::Tonemap,
        RenderFeature::Exposure,
        RenderFeature::Ibl,
        RenderFeature::Sky,
        RenderFeature::Shadows,
        RenderFeature::ContactShadows,
        RenderFeature::Bloom,
        RenderFeature::Ao,
        RenderFeature::Fog,
        RenderFeature::Taa,
        RenderFeature::Upscaler,
        RenderFeature::Clustered,
        RenderFeature::Meshlets,
        RenderFeature::Occlusion,
        RenderFeature::Prepass,
        RenderFeature::TextureQuality,
        RenderFeature::SpotShadows,
    ];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            RenderFeature::Hdr => "hdr",
            RenderFeature::Tonemap => "tonemap",
            RenderFeature::Exposure => "exposure",
            RenderFeature::Ibl => "ibl",
            RenderFeature::Sky => "sky",
            RenderFeature::Shadows => "shadows",
            RenderFeature::ContactShadows => "contact-shadows",
            RenderFeature::Bloom => "bloom",
            RenderFeature::Ao => "ao",
            RenderFeature::Fog => "fog",
            RenderFeature::Taa => "taa",
            RenderFeature::Upscaler => "upscaler",
            RenderFeature::Clustered => "clustered",
            RenderFeature::Meshlets => "meshlets",
            RenderFeature::Occlusion => "occlusion",
            RenderFeature::Prepass => "prepass",
            RenderFeature::TextureQuality => "texture-quality",
            RenderFeature::SpotShadows => "spot-shadows",
        }
    }

    /// The feature spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<RenderFeature> {
        RenderFeature::ALL.into_iter().find(|feature| feature.wire() == wire)
    }
}

/// When a knob may change.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KnobKind {
    /// A resource size, count or cadence: changeable at runtime (DRS, preset demotion).
    Resource,
    /// Shapes the pipeline set: only at boot, on an explicit change or at a loading point.
    Pipeline,
}

/// Every quality knob, for its classification ([`QualityKnob::kind`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum QualityKnob {
    /// [`Quality::hdr`].
    Hdr,
    /// [`Quality::tonemap`].
    Tonemap,
    /// [`Quality::exposure`].
    Exposure,
    /// [`Quality::exposure_input_divisor`].
    ExposureInput,
    /// [`Quality::anti_aliasing`].
    AntiAliasing,
    /// [`Quality::render_scale`].
    RenderScale,
    /// [`Quality::upscaler`].
    Upscaler,
    /// [`ShadowQuality::enabled`].
    Shadows,
    /// [`ShadowQuality::cascades`].
    ShadowCascades,
    /// [`ShadowQuality::map_size`].
    ShadowMapSize,
    /// [`ShadowQuality::filter`].
    ShadowFilter,
    /// [`ShadowQuality::format`].
    ShadowFormat,
    /// [`ShadowQuality::far_cadence`].
    ShadowCadence,
    /// [`ShadowQuality::distance`].
    ShadowDistance,
    /// [`ShadowQuality::split_percent`].
    ShadowSplit,
    /// [`ShadowQuality::blend_percent`].
    ShadowBlend,
    /// [`ShadowQuality::fade_percent`].
    ShadowFade,
    /// [`Quality::contact_shadows`].
    ContactShadows,
    /// [`BloomQuality::enabled`].
    Bloom,
    /// [`BloomQuality::resolution`].
    BloomResolution,
    /// [`AoQuality::resolution`].
    AoResolution,
    /// [`AoQuality::slices`].
    AoSlices,
    /// [`AoQuality::steps`].
    AoSteps,
    /// [`AoQuality::temporal`].
    AoTemporal,
    /// [`Quality::fog`].
    Fog,
    /// [`EnvironmentQuality::ibl`].
    Ibl,
    /// [`EnvironmentQuality::cube_size`].
    IblCubeSize,
    /// [`EnvironmentQuality::hdri_cube_size`].
    IblHdriCubeSize,
    /// [`EnvironmentQuality::rebake_cadence`].
    IblRebakeCadence,
    /// [`EnvironmentQuality::sun_rebake_tenths`].
    IblSunRebake,
    /// [`EnvironmentQuality::sky`].
    Sky,
    /// [`EnvironmentQuality::sky_lut`].
    SkyLut,
    /// [`EnvironmentQuality::sky_cadence`].
    SkyCadence,
    /// [`EnvironmentQuality::aerial_perspective`].
    AerialPerspective,
    /// [`LightQuality::cap`].
    LightCap,
    /// [`LightQuality::clustered`].
    Clustered,
    /// [`LightQuality::tile_px`].
    LightTile,
    /// [`LightQuality::shadowed_spots`].
    ShadowedSpots,
    /// [`Quality::prepass`].
    Prepass,
    /// [`Quality::meshlets`].
    Meshlets,
    /// [`Quality::occlusion`].
    Occlusion,
    /// [`Quality::specular_aa`].
    SpecularAa,
}

impl QualityKnob {
    /// Every knob.
    pub const ALL: [QualityKnob; 42] = [
        QualityKnob::Hdr,
        QualityKnob::Tonemap,
        QualityKnob::Exposure,
        QualityKnob::ExposureInput,
        QualityKnob::AntiAliasing,
        QualityKnob::RenderScale,
        QualityKnob::Upscaler,
        QualityKnob::Shadows,
        QualityKnob::ShadowCascades,
        QualityKnob::ShadowMapSize,
        QualityKnob::ShadowFilter,
        QualityKnob::ShadowFormat,
        QualityKnob::ShadowCadence,
        QualityKnob::ShadowDistance,
        QualityKnob::ShadowSplit,
        QualityKnob::ShadowBlend,
        QualityKnob::ShadowFade,
        QualityKnob::ContactShadows,
        QualityKnob::Bloom,
        QualityKnob::BloomResolution,
        QualityKnob::AoResolution,
        QualityKnob::AoSlices,
        QualityKnob::AoSteps,
        QualityKnob::AoTemporal,
        QualityKnob::Fog,
        QualityKnob::Ibl,
        QualityKnob::IblCubeSize,
        QualityKnob::IblHdriCubeSize,
        QualityKnob::IblRebakeCadence,
        QualityKnob::IblSunRebake,
        QualityKnob::Sky,
        QualityKnob::SkyLut,
        QualityKnob::SkyCadence,
        QualityKnob::AerialPerspective,
        QualityKnob::LightCap,
        QualityKnob::Clustered,
        QualityKnob::LightTile,
        QualityKnob::ShadowedSpots,
        QualityKnob::Prepass,
        QualityKnob::Meshlets,
        QualityKnob::Occlusion,
        QualityKnob::SpecularAa,
    ];

    /// When the knob may change. Shadow, bloom and AO on/off and the AO resolution are resource
    /// knobs (plan §2.5's degrade order steps them at runtime); a feature whose pipelines differ
    /// when on (TAA, HDR, filters, override constants) is a pipeline knob.
    pub const fn kind(self) -> KnobKind {
        match self {
            QualityKnob::ExposureInput
            | QualityKnob::RenderScale
            | QualityKnob::Shadows
            | QualityKnob::ShadowCascades
            | QualityKnob::ShadowMapSize
            | QualityKnob::ShadowCadence
            | QualityKnob::ShadowDistance
            | QualityKnob::ShadowSplit
            | QualityKnob::ShadowBlend
            | QualityKnob::ShadowFade
            | QualityKnob::Bloom
            | QualityKnob::BloomResolution
            | QualityKnob::AoResolution
            | QualityKnob::IblCubeSize
            | QualityKnob::IblHdriCubeSize
            | QualityKnob::IblRebakeCadence
            | QualityKnob::IblSunRebake
            | QualityKnob::SkyLut
            | QualityKnob::SkyCadence
            | QualityKnob::LightCap
            | QualityKnob::LightTile
            | QualityKnob::ShadowedSpots => KnobKind::Resource,
            _ => KnobKind::Pipeline,
        }
    }
}

/// Everything about how frames are drawn: where the quality came from, the game's look and the
/// resolved quality.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderSettings {
    /// The preset choice the quality was resolved from.
    pub preset: PresetChoice,
    /// The game's look.
    pub look: Look,
    /// The quality knobs in effect.
    pub quality: Quality,
    /// The game's meshlet rendering (R2).
    pub meshlets: Meshlets,
}

impl RenderSettings {
    /// The renderer before the follow-up, exactly: every existing golden is drawn with it.
    pub const fn off() -> RenderSettings {
        RenderSettings {
            preset: PresetChoice::Off,
            look: DEFAULT_LOOK,
            quality: Quality::off(),
            meshlets: Meshlets::DEFAULT,
        }
    }

    /// The device class's default preset with the default look. The quality stays `off` until
    /// the device probe resolves the preset at boot (`presets::resolve`).
    pub fn auto() -> RenderSettings {
        RenderSettings { preset: PresetChoice::Auto, ..RenderSettings::off() }
    }

    /// The settings with `look` instead.
    pub fn with_look(mut self, look: Look) -> RenderSettings {
        self.look = look;
        self
    }

    /// The settings with the game's `meshlets` instead.
    pub fn with_meshlets(mut self, meshlets: Meshlets) -> RenderSettings {
        self.meshlets = meshlets;
        self
    }

    /// The settings with `quality` (resolved from `preset`) instead.
    pub fn with_quality(mut self, preset: PresetChoice, quality: Quality) -> RenderSettings {
        self.preset = preset;
        self.quality = quality;
        self
    }

    /// What one frame derives from the settings at `output` size (the world target), with the
    /// frame index temporal effects are keyed to and whether their history was reset. The jitter
    /// is TAA's position for `frame_index` when this build draws TAA, else zero.
    pub fn frame_config(&self, output: (u32, u32), scale: f32, frame_index: u64, history_reset: bool) -> FrameConfig {
        let scale = scale.clamp(RENDER_SCALE_MIN, 1.0);
        let side = |px: u32| ((px as f32 * scale) as u32).clamp(1, px.max(1));
        let taa = crate::graph::feature_drawn(&self.quality, RenderFeature::Taa);
        let jitter = if taa { crate::jitter::offset_px(frame_index, self.quality.taa.jitter_cycle) } else { crate::jitter::NO_JITTER };
        FrameConfig {
            output_size: output,
            render_size: (side(output.0), side(output.1)),
            scale,
            samples: self.quality.anti_aliasing.samples(),
            hdr: self.quality.hdr,
            depth_reversed: self.quality.hdr,
            ldr_reason: None,
            frame_index,
            history_reset,
            settle: None,
            jitter,
        }
    }
}

impl Default for RenderSettings {
    fn default() -> Self {
        RenderSettings::off()
    }
}

/// What one frame draws with, derived from [`RenderSettings`] ([`RenderSettings::frame_config`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameConfig {
    /// The world target's size (captures, Live, the HUD).
    pub output_size: (u32, u32),
    /// The scene's size: output × scale, at a dynamic-resolution step.
    pub render_size: (u32, u32),
    /// The scale in effect.
    pub scale: f32,
    /// Samples per pixel of the world pass.
    pub samples: u32,
    /// Whether the scene is HDR (linear, pre-exposed, tonemapped at the end).
    pub hdr: bool,
    /// Whether camera views draw reverse-Z (reversed projection, `Greater`, depth cleared to 0):
    /// on the HDR path only. The legacy path and an LDR-degraded frame keep standard Z, so their
    /// pictures stay byte-identical to the renderer before the follow-up.
    pub depth_reversed: bool,
    /// Why an HDR-requested frame is drawn LDR instead (the first reason found), if it is.
    pub ldr_reason: Option<LdrReason>,
    /// Frames drawn since the last history reset (temporal sequences key to it).
    pub frame_index: u64,
    /// Whether temporal history starts over this frame.
    pub history_reset: bool,
    /// For a settled capture: (this re-render's index, re-renders in all).
    pub settle: Option<(u32, u32)>,
    /// TAA's sub-pixel offset of this frame's projection, in render pixels within
    /// `(-0.5, 0.5)` (x right, y down; [`crate::jitter::offset_ndc`] converts it). Zero unless TAA
    /// is drawn: never on shadows or cull planes.
    pub jitter: [f32; 2],
}

impl FrameConfig {
    /// The frame drawn on the legacy LDR scene with standard Z for `reason` (a v1 material or v1
    /// in-world pass in an HDR-requested frame). The first reason is kept; a frame that is LDR
    /// already has nothing to degrade and is returned as it is.
    pub fn degraded_to_ldr(self, reason: LdrReason) -> FrameConfig {
        if !self.hdr {
            return self;
        }
        FrameConfig { hdr: false, depth_reversed: false, ldr_reason: Some(reason), ..self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_is_the_legacy_renderer() {
        let off = RenderSettings::off();
        assert_eq!(off.preset, PresetChoice::Off);
        assert_eq!(off.quality.anti_aliasing.samples(), MSAA_SAMPLE_COUNT);
        assert_eq!(off.quality.shadows.cascades as usize, SHADOW_CASCADES);
        assert_eq!(off.quality.shadows.map_size, SHADOW_MAP_PX);
        assert_eq!(off.quality.shadows.filter, ShadowFilter::Pcf3x3);
        assert_eq!(off.quality.lights.cap as usize, MAX_LIGHTS);
        assert_eq!(off.quality.textures, TextureQuality::OFF, "one 256 class and today's mips");
        let on: Vec<RenderFeature> = RenderFeature::ALL.into_iter().filter(|f| off.quality.feature(*f)).collect();
        assert_eq!(on, vec![RenderFeature::Shadows], "only the legacy sun shadows are on");
        assert_eq!(RenderSettings::default(), off);
        assert_eq!(RenderSettings::auto().quality, off.quality, "auto is unresolved until the probe");
    }

    #[test]
    fn texture_classes_are_the_layout_sizes_smallest_first() {
        let sides: Vec<u32> = TextureClass::ALL.iter().map(|class| class.side()).collect();
        assert_eq!(sides, crate::layout::TEXTURE_SIZE_CLASSES);
        assert!(TextureClass::ALL.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(TextureClass::ALL.map(TextureClass::index), [0, 1, 2, 3]);
    }

    #[test]
    fn every_feature_switch_round_trips_and_spells_its_wire() {
        for feature in RenderFeature::ALL {
            assert_eq!(RenderFeature::from_wire(feature.wire()), Some(feature));
            let mut quality = Quality::off();
            quality.set_feature(feature, true);
            assert!(quality.feature(feature), "{} on", feature.wire());
            quality.set_feature(feature, false);
            assert!(!quality.feature(feature), "{} off", feature.wire());
        }
        assert_eq!(RenderFeature::from_wire("raytracing"), None);
    }

    #[test]
    fn resource_knobs_keep_the_pipeline_key_and_pipeline_knobs_change_it() {
        let off = Quality::off();
        let mut smaller = off;
        smaller.shadows.map_size = 768;
        smaller.shadows.cascades = 1;
        smaller.render_scale = 0.67;
        smaller.bloom.resolution = 270;
        smaller.lights.cap = 64;
        assert!(off.resource_change_only(&smaller), "DRS and demotion knobs never change pipelines");
        let mut taa = off;
        taa.set_feature(RenderFeature::Taa, true);
        assert!(!off.resource_change_only(&taa), "the sample count is pipeline-shaping");
        let mut pcss = off;
        pcss.shadows.filter = ShadowFilter::Pcss;
        assert!(!off.resource_change_only(&pcss));
        assert_eq!(QualityKnob::ShadowMapSize.kind(), KnobKind::Resource);
        assert_eq!(QualityKnob::AntiAliasing.kind(), KnobKind::Pipeline);
        // RQ2 review: the HDR map's cube, the rebake cadence and the sun's rebake threshold are
        // resource knobs too (16 -> 19); RQ3 review: the shadow distance, split, blend band and end
        // fade (19 -> 23). P2-0.13 flipped (named in the log): bloom's mips and half-resolution start
        // are one knob, its chain's resolution (23 -> 22).
        assert_eq!(QualityKnob::ALL.iter().filter(|k| k.kind() == KnobKind::Resource).count(), 22);
        let mut reach = off;
        (reach.shadows.distance, reach.shadows.split_percent, reach.shadows.blend_percent, reach.shadows.fade_percent) = (120, 80, 10, 10);
        assert!(off.resource_change_only(&reach), "the shadows' reach never changes pipelines");
    }

    #[test]
    fn wire_spellings_round_trip() {
        for preset in QualityPreset::ALL {
            assert_eq!(QualityPreset::from_wire(preset.wire()), Some(preset));
            assert_eq!(PresetChoice::from_wire(preset.wire()), Some(PresetChoice::Preset(preset)));
        }
        assert_eq!(PresetChoice::from_wire("auto"), Some(PresetChoice::Auto));
        assert_eq!(PresetChoice::from_wire("off"), Some(PresetChoice::Off));
        assert_eq!(PresetChoice::from_wire("epic"), None);
        for tonemapper in Tonemapper::ALL {
            assert_eq!(Tonemapper::from_wire(tonemapper.wire()), Some(tonemapper));
        }
        assert_eq!(Tonemapper::default().wire(), "khronos-neutral");
        for mode in ExposureMode::ALL {
            assert_eq!(ExposureMode::from_wire(mode.wire()), Some(mode));
        }
        for metering in Metering::ALL {
            assert_eq!(Metering::from_wire(metering.wire()), Some(metering));
        }
    }

    #[test]
    fn the_tonemappers_and_their_shader_ids_are_fixed() {
        let ids: Vec<(&str, u32)> = Tonemapper::ALL.iter().map(|t| (t.wire(), t.shader_id())).collect();
        assert_eq!(ids, [("khronos-neutral", 0), ("agx", 1), ("aces", 2), ("none", 3), ("agx-punchy", 4)]);
    }

    #[test]
    fn the_default_look_is_legacy_preserving_with_auto_exposure_limits_ready() {
        let look = Look::default();
        assert_eq!((look.tonemapper, look.exposure), (Tonemapper::KhronosNeutral, ExposureMode::Manual));
        assert_eq!(look.manual_exposure(), 1.0, "EV 0 is exposure 1.0: today's intensities keep their meaning");
        let brighter = Look { ev_compensation: 1.0, ..look };
        assert_eq!(brighter.manual_exposure(), 2.0);
        assert!(look.ev_min < look.ev_max, "auto exposure clamps the metered EV");
        assert!(look.adaptation_up > 0.0 && look.adaptation_down > 0.0);
        assert_eq!(EXPOSURE_HISTOGRAM_BINS, 128, "fixed: quality varies only the input downsample");
        assert_eq!(RenderSettings::off().look, look, "off draws with the default look");
    }

    #[test]
    fn the_default_look_draws_rq4_effects_as_before_and_holds_their_limits() {
        let look = Look::default();
        assert_eq!((look.bloom_intensity, look.bloom_threshold, look.bloom_radius), (0.04, 0.0, 1.0), "threshold-free, energy-conserving");
        assert_eq!((look.ao_intensity, look.ao_radius), (DEFAULT_AO_INTENSITY, DEFAULT_AO_RADIUS));
        assert!(!look.fog.is_on(), "no fog unless a game asks: the legacy picture");
        assert!(look.fog.aerial_perspective && look.fog.color == [1.0; 3] && look.fog.max_opacity == 1.0);
        assert_eq!(look.contact_shadow_length, DEFAULT_CONTACT_SHADOW_LENGTH);
        let wild = look.with_bloom(f32::NAN, 1e9, 0.0).with_ao(-1.0, 1e9).with_contact_shadow_length(0.0);
        assert_eq!((wild.bloom_intensity, wild.bloom_threshold, wild.bloom_radius), (DEFAULT_BLOOM_INTENSITY, BLOOM_THRESHOLD_MAX, BLOOM_RADIUS_MIN));
        assert_eq!((wild.ao_intensity, wild.ao_radius, wild.contact_shadow_length), (0.0, AO_RADIUS_MAX, CONTACT_SHADOW_LENGTH_MIN));
        let fog = Fog::default().with_density(5.0).with_height(f32::NAN, -1e9).with_range(-3.0, 2.0).with_color([f32::NAN, -1.0, 99.0]);
        assert_eq!((fog.density, fog.height_falloff, fog.base_height), (FOG_DENSITY_MAX, DEFAULT_FOG_HEIGHT_FALLOFF, -FOG_DISTANCE_LIMIT));
        assert_eq!((fog.start, fog.max_opacity, fog.color), (0.0, 1.0, [1.0, 0.0, FOG_COLOR_MAX]));
        assert!(fog.is_on() && !fog.with_range(0.0, 0.0).is_on());
    }

    #[test]
    fn bent_normals_come_with_two_or_more_gtao_slices() {
        let mut ao = Quality::off().ao;
        assert!(!ao.bent_normals());
        ao.resolution = AoResolution::Half;
        ao.slices = 1;
        assert!(!ao.bent_normals(), "medium: one slice is too noisy to steer reflections");
        ao.slices = 2;
        assert!(ao.bent_normals());
    }

    #[test]
    fn a_frame_is_hdr_with_reverse_z_only_when_quality_asks_and_nothing_degrades_it() {
        let off = RenderSettings::off().frame_config((64, 64), 1.0, 0, false);
        assert_eq!((off.hdr, off.depth_reversed, off.ldr_reason), (false, false, None), "the legacy renderer: LDR, standard Z");
        let mut hdr = RenderSettings::off();
        hdr.quality.set_feature(RenderFeature::Hdr, true);
        let frame = hdr.frame_config((64, 64), 1.0, 0, false);
        assert_eq!((frame.hdr, frame.depth_reversed), (true, true), "the HDR path draws reverse-Z");
        for reason in LdrReason::ALL {
            let degraded = frame.degraded_to_ldr(reason);
            assert_eq!((degraded.hdr, degraded.depth_reversed, degraded.ldr_reason), (false, false, Some(reason)));
            assert_eq!(degraded.degraded_to_ldr(LdrReason::CustomPassV1InWorld).ldr_reason, Some(reason), "the first reason stays");
        }
        assert_eq!(off.degraded_to_ldr(LdrReason::MaterialV1InHdr).ldr_reason, None, "an LDR frame has nothing to degrade");
    }

    #[test]
    fn the_scene_format_falls_back_to_rgba16float_and_is_hdr_unless_legacy() {
        assert_eq!(SceneFormat::hdr_format(true, true), SceneFormat::Rg11b10Ufloat);
        assert_eq!(SceneFormat::hdr_format(true, false), SceneFormat::Rgba16Float, "rg11b10 only where renderable");
        assert_eq!(SceneFormat::hdr_format(false, true), SceneFormat::Rgba16Float, "only classes that prefer it");
        assert!(!SceneFormat::Ldr.is_hdr() && SceneFormat::Rgba16Float.is_hdr() && SceneFormat::Rg11b10Ufloat.is_hdr());
        assert!(!SceneFormat::Rg11b10Ufloat.has_alpha() && SceneFormat::Rgba16Float.has_alpha());
    }

    #[test]
    fn the_environment_defaults_to_the_legacy_colour_and_spells_its_wire() {
        assert_eq!(Environment::default(), Environment::Color);
        assert!(!Environment::Color.lights_scene());
        assert!(Environment::sky().lights_scene() && Environment::hdri("env/sky.hdr").lights_scene());
        for kind in EnvironmentKind::ALL {
            assert_eq!(EnvironmentKind::from_wire(kind.wire()), Some(kind));
        }
        assert_eq!(EnvironmentKind::ALL.map(EnvironmentKind::wire), ["color", "sky", "hdri"]);
        assert_eq!(HdriSun::ALL.map(HdriSun::wire), ["analytic", "off"]);
        assert_eq!(HdriSun::from_wire("baked"), None);
        assert_eq!(HdriSun::default(), HdriSun::Analytic, "a map's sun drives the analytic sun unless asked otherwise");
    }

    #[test]
    fn the_sky_and_the_map_keep_their_parameters_in_range() {
        let sky = SkyParams::default();
        assert!((sky.sun_angular_radius - 0.27_f32.to_radians()).abs() < 1e-7, "the real sun's 0.27 degrees");
        assert_eq!(sky.ground_albedo, [DEFAULT_GROUND_ALBEDO; 3]);
        assert_eq!(sky.intensity, 1.0);
        let clamped = sky.with_ground_albedo([-1.0, 2.0, f32::NAN]).with_sun_angular_radius_degrees(90.0).with_intensity(1e9);
        assert_eq!(clamped.ground_albedo, [0.0, 1.0, 0.0]);
        assert_eq!(clamped.sun_angular_radius, SUN_ANGULAR_RADIUS_MAX_DEG.to_radians());
        assert_eq!(clamped.intensity, ENVIRONMENT_INTENSITY_MAX);
        let map = HdriEnvironment::new("env/field.hdr").with_rotation_degrees(450.0).with_intensity(f32::NAN).with_sun(HdriSun::Off);
        assert_eq!((map.path.as_str(), map.intensity, map.sun), ("env/field.hdr", 1.0, HdriSun::Off));
        assert!((map.rotation - 90.0_f32.to_radians()).abs() < 1e-6);
        assert_eq!(HdriEnvironment::new("a.hdr").with_rotation_degrees(f32::INFINITY).rotation, 0.0);
    }

    #[test]
    fn a_frame_config_scales_the_render_size_and_keeps_the_output() {
        let settings = RenderSettings::off();
        let full = settings.frame_config((1280, 720), 1.0, 0, true);
        assert_eq!((full.render_size, full.output_size, full.samples), ((1280, 720), (1280, 720), 4));
        assert!(full.history_reset);
        let scaled = settings.frame_config((1280, 720), 0.75, 7, false);
        assert_eq!(scaled.render_size, (960, 540));
        assert_eq!(scaled.frame_index, 7);
        let floor = settings.frame_config((100, 3), 0.1, 0, false);
        assert_eq!(floor.scale, RENDER_SCALE_MIN, "never below the class floor");
        assert_eq!(floor.render_size, (50, 1));
    }

    #[test]
    fn taa_and_rcas_knobs_default_and_hold_their_ranges() {
        let off = Quality::off();
        assert_eq!(off.taa, TaaQuality::DEFAULT);
        assert_eq!((off.taa.jitter_cycle.frames(), off.taa.alpha_min, off.taa.lod_bias), (8, DEFAULT_TAA_ALPHA_MIN, DEFAULT_TAA_LOD_BIAS));
        assert_eq!(JitterCycle::Sixteen.frames(), 16);
        assert_eq!(off.rcas.sharpness, DEFAULT_RCAS_SHARPNESS);
        let wild = TaaQuality::DEFAULT.with_alpha_min(0.0).with_lod_bias(5.0);
        assert_eq!((wild.alpha_min, wild.lod_bias), (TAA_ALPHA_MIN_FLOOR, 0.0));
        let nan = TaaQuality::DEFAULT.with_alpha_min(f32::NAN).with_lod_bias(f32::NAN);
        assert_eq!(nan, TaaQuality::DEFAULT);
        assert_eq!(RcasQuality::DEFAULT.with_sharpness(-1.0).sharpness, 0.0);
        assert_eq!(RcasQuality::DEFAULT.with_sharpness(9.0).sharpness, RCAS_SHARPNESS_MAX);
        assert_eq!(RcasQuality::DEFAULT.with_sharpness(f32::NAN), RcasQuality::DEFAULT);
    }

    #[test]
    fn taa_knobs_are_resource_knobs() {
        let off = Quality::off();
        let mut moved = off;
        moved.taa = TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen).with_alpha_min(0.05).with_lod_bias(-1.0);
        moved.rcas = RcasQuality::DEFAULT.with_sharpness(1.0);
        assert!(off.resource_change_only(&moved), "jitter cycle, accumulation floor, LOD bias and sharpness are uniforms");
    }

    #[test]
    fn the_texture_lod_bias_under_taa_follows_the_render_scale() {
        let taa = TaaQuality::DEFAULT;
        assert_eq!(taa.texture_lod_bias(1.0), -0.5);
        assert_eq!(taa.texture_lod_bias(0.5), -1.5);
        assert_eq!(taa.texture_lod_bias(0.1), -1.5, "the scale is held to the class floor");
        assert_eq!(taa.texture_lod_bias(f32::NAN), -0.5);
        assert_eq!(TaaQuality::DEFAULT.with_lod_bias(-2.0).texture_lod_bias(0.5), TAA_LOD_BIAS_MIN);
    }

    #[test]
    fn a_frames_texture_lod_bias_is_taas_under_taa_and_the_upscales_under_easu_alone() {
        let taa = TaaQuality::DEFAULT;
        assert_eq!(frame_texture_lod_bias(&taa, true, true, 0.5), -1.5, "TAA's, whatever the upscale");
        assert_eq!(frame_texture_lod_bias(&taa, false, true, 0.5), -1.0, "EASU alone: log2(render / display)");
        assert_eq!(frame_texture_lod_bias(&taa, false, true, 0.75), libm::log2f(0.75));
        assert_eq!(frame_texture_lod_bias(&taa, false, false, 0.5), 0.0, "no upscale, no bias");
        assert_eq!(frame_texture_lod_bias(&taa, false, true, 0.1), libm::log2f(RENDER_SCALE_MIN), "held to the class floor");
        assert_eq!(frame_texture_lod_bias(&taa, false, true, f32::NAN), 0.0);
        assert!(frame_texture_lod_bias(&taa, false, true, 0.1) >= TAA_LOD_BIAS_MIN);
    }

    #[test]
    fn a_games_meshlets_only_narrow_what_the_quality_runs() {
        let settings = RenderSettings::off();
        assert_eq!(settings.meshlets, Meshlets::DEFAULT, "the legacy settings keep the game default");
        assert_eq!(Meshlets::DEFAULT.drawn(&settings.quality), (false, false), "the off quality draws no meshlets");
        let mut quality = Quality::off();
        quality.set_feature(RenderFeature::Meshlets, true);
        quality.set_feature(RenderFeature::Occlusion, true);
        assert_eq!(Meshlets::DEFAULT.drawn(&quality), (true, true));
        assert_eq!(Meshlets::DEFAULT.with_occlusion(false).drawn(&quality), (true, false));
        assert_eq!(Meshlets::DEFAULT.with_enabled(false).drawn(&quality), (false, false), "no occlusion without meshlets");
        quality.set_feature(RenderFeature::Meshlets, false);
        assert_eq!(Meshlets::DEFAULT.drawn(&quality), (false, false), "a game cannot force meshlets on");
        assert!(Meshlets::DEFAULT.clusters(DEFAULT_MESHLET_MIN_TRIANGLES) && !Meshlets::DEFAULT.clusters(DEFAULT_MESHLET_MIN_TRIANGLES - 1));
        assert_eq!(Meshlets::DEFAULT.with_min_triangles(1).min_triangles, MESHLET_MIN_TRIANGLES_FLOOR);
        assert!(!settings.with_meshlets(Meshlets::DEFAULT.with_enabled(false)).meshlets.enabled);
    }
}
