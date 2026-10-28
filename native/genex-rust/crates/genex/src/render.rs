//! `genex::render`: how a game is drawn on each device, apart from what is drawn.
//!
//! A game states its **look** (tonemapper, exposure, bloom intensity: the same on every device)
//! and, optionally, its **quality** per device class through [`Game::render_settings`] with a
//! [`RenderConfig`] (or the same tables in `genex.toml` `[render]`, read with
//! [`RenderConfig::from_toml`]):
//!
//! ```
//! use genex::prelude::*;
//! use genex::render::{Exposure, RenderConfig, Tonemap};
//! # #[derive(Default)] struct World;
//! let mut game = Game::new(World);
//! game.render_settings(RenderConfig::new().tonemap(Tonemap::AgxPunchy).exposure(Exposure::auto().compensation(0.5)));
//! ```
//!
//! Every preset asks for an HDR scene (linear, pre-exposed radiance in the class's HDR format,
//! [`FrameChoice::scene_format`]) that the look's tonemapper maps to the display; a frame holding a
//! v1 custom pass in the world or a v1 material stays on the legacy LDR scene and says why in
//! `degraded` ([`RenderControl::note_ldr_reason`]). The default look keeps a game's authored
//! colours: Khronos PBR Neutral at a fixed exposure of 1.0 ([`Look::default`]);
//! [`Tonemap::AgxPunchy`], [`Tonemap::Agx`], [`Tonemap::Aces`] and auto exposure
//! ([`Exposure::auto`]) are a game's choice. Exposure is in
//! relative units: EV 0 is an exposure of 1.0, each EV doubles it, and there is no aperture,
//! shutter or ISO. Everything else adapts at runtime: the renderer probes the device,
//! picks the device class's preset, and a dynamic-resolution controller holds the class's frame
//! time by stepping the render scale.
//!
//! The quality a Live frame draws with is resolved in a fixed order, each layer overriding the one
//! before it key by key:
//!
//! 1. the device class's preset table (probed, then refined by the calibration hint);
//! 2. the game's `[render]` / [`RenderConfig`] (its preset and its `[render.class.<class>]` table);
//! 3. the person's choice in the in-game panel ([`settings_panel`]), saved per device in the
//!    game's saves, never in the simulation;
//! 4. the Studio's `renderSettings` verb (this session only): a preset, feature switches, a class
//!    to emulate ("capture it as a phone") and a render-scale lock.
//!
//! Captures (Studio, harness, conformance) are drawn on a **pinned profile** instead: the game's
//! own layer on a reference class (the class the host recorded for the adapter, else
//! [`REFERENCE_CLASS`] on every destination, so a web capture stays comparable with a native one),
//! with the verb's layer on top, at the nominal scale. They ignore the person's saved choice, the
//! probe (a capture resolves on fixed reference facts: no web preset cap, no `deviceMemory`
//! budget, one scene format), the calibration hint and dynamic resolution, so two cold boots
//! capture the same picture; the verb's class emulation is how a capture is taken "as a phone".
//! Nothing here is read by the state checksum: settings are display state.
//!
//! What is reported is what is drawn: a feature switch reads on only when its node has landed in
//! this build ([`genex_render::graph::feature_landed`]); a preset's knob that is asked for but not
//! drawn yet is listed in `degraded` as [`DegradeReason::NotLanded`] with the knob as its subject.
//!
//! [`RenderControl`] holds all of it; the runtime owns one per game and the presenter draws every
//! frame through it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use crate::game::Game;
use crate::manifest::{self, ManifestError, RenderSection};
use genex_core::saves::Saves;
use genex_render::budget::{DegradeMode, DegradeRung, MaterialClass, fit};
use genex_render::texture::{fitted_textures, material_arrays};
use genex_render::device_class::{CalibrationKey, classify, classify_calibrated};
use genex_render::budget::ledger;
use genex_render::drs::{DrsController, FRAME_RATE_TARGETS, FrameSignal, ScaleSteps, demoted_quality};
use genex_render::graph::{feature_drawn, feature_landed, not_landed};
use genex_render::presets::{
    class_defaults, default_preset, effect_budgeted, native_output_cap_px, profile, render_pixel_budget, step_size, upscales_to_native, with_world_samples,
};
use genex_render::upscale::{calibrated_mode, calibrated_window_scale, output_scale};
use genex_render::post::tonemap::MsaaResolve;
use genex_render::timing::{GpuSource, TimingWindow};
use serde_json::{Map as JsonMap, Value, json};

pub use genex_render::budget::BudgetInput;
pub use genex_render::device_class::{DeviceClass, DeviceFacts, FormFactor, PerformanceTier, ScoreLevel, TargetOs, WebHints};
pub use genex_render::presets::{ClassDefaults, ClassOverride, RenderOverrides, RenderProfile, preset_quality};
/// An upscaling mode (lane UQ): Native, Quality, Balanced or Performance, the share of the window a
/// frame renders ([`RenderConfig::upscale`], [`lock_upscale`]).
pub use genex_render::upscale::UpscaleMode;
/// A game's or a person's choices for the sun's shadows (cascades, map size, filter): see
/// [`RenderConfig::shadows_at`].
pub use genex_render::presets::ShadowOverride as ShadowConfig;
/// A game's or a person's level-of-detail choices (game systems LOD-06: the error threshold, the
/// crossfade band, impostors, the far-field density): see [`RenderConfig::lod_at`].
pub use genex_render::presets::LodOverride as LodConfig;
/// The level-of-detail quality a frame draws with (`quality.lod`).
pub use genex_render::settings::LodQuality;
pub use genex_render::settings::{
    AntiAliasing, AoQuality, AoResolution, BloomQuality, EnvironmentQuality, ExposureMode, LdrReason, LightQuality, Look, Meshlets, Metering,
    PresetChoice, Quality, QualityPreset, RenderFeature, RenderSettings, SceneFormat, ShadowFilter, ShadowFormat, ShadowQuality,
    Tonemapper, Upscaler,
};
/// TAA's resource knobs in a [`Quality`] (`quality.taa`: the jitter cycle, the accumulation floor
/// and the texture LOD bias; RQ5). Whether TAA runs is [`AntiAliasing`] and the `taa` switch.
pub use genex_render::settings::{JitterCycle, TaaQuality};
/// The look's colour grading (A.2, [`RenderConfig::grading`]): contrast about middle grey,
/// saturation, vibrance, per-section lift, gamma and gain, and a display LUT read from a `.cube`
/// ([`GradingLut::parse_cube`], then [`GradingLut::intern`]).
pub use genex_render::post::grading::{Grading, GradingLut, GradingLutError, GradingSection};
/// The look's depth of field (A.9, [`RenderConfig::depth_of_field`]): a thin lens focused at a
/// distance through an f-number, off by default. The preset picks the gather
/// ([`DofTier`]: the ring at desktop high and ultra, the circular gather elsewhere).
pub use genex_render::post::dof::{DepthOfField, DofTier};
/// The look's motion blur (A.9, [`RenderConfig::motion_blur`]): the shutter open for a share of
/// each frame, off by default (owner decision D10). The preset picks the tier
/// ([`MotionBlurTier`]: the reconstruction at desktop high and ultra, none on low phones).
pub use genex_render::post::motion_blur::{MotionBlur, MotionBlurTier};
/// What a settled capture's shot asks of the look's lens (the capture verb's `lens`): neither by
/// default, so a capture is a still of the held frame.
pub use genex_render::renderer::CaptureLens;
/// The key [`crate::Frame::id`] names a moving draw with across frames (a string or an integer),
/// so its motion vectors find where it was last frame under TAA.
pub use genex_render::motion::DrawId;
use genex_render::settings::{ADAPTATION_SPEED_MAX, EXPOSURE_EV_LIMIT, TextureQuality};
/// What lights a frame besides its lights and what is drawn behind it ([`crate::Frame::environment`],
/// RQ2): the flat colour, the physical sky ([`SkyParams`]) or an HDR map from the game's assets
/// ([`HdriEnvironment`], its sun handled by [`HdriSun`]). The same on every preset and device;
/// presets only size the bake and the sky's LUTs ([`EnvironmentQuality`]).
pub use genex_render::settings::{Environment, EnvironmentKind, HdriEnvironment, HdriSun, SkyParams};
/// The physical sky's night and air (renderer pass 2 B.2): a [`Moon`] lit by the sun with its phase
/// ([`SkyParams::with_moon`]), the stars ([`SkyParams::with_stars`]) and the air the sky is made of
/// ([`SkyMedium::earth`], [`SkyMedium::mars`] or your own, [`SkyParams::with_medium`]).
pub use genex_render::settings::{Moon, SkyMedium};
/// A layer of clouds in the physical sky (renderer pass 2 B.5, [`SkyParams::with_clouds`]): its
/// coverage, base and thickness, density and drift, drawn on desktop `medium` and up.
pub use genex_render::settings::Clouds;
/// Height and distance fog matched to the sky (RQ4): a look, the same on every preset, set with
/// [`RenderConfig::fog`] or `genex.toml` `[render.look]`'s `fog_*` keys. Off at the default density 0.
pub use genex_render::settings::Fog;
/// A spot light with its own cone or a shadow map ([`crate::Frame::spot_light_with`], RQ6), and the
/// cone [`crate::Frame::spot_light`] gives one by default; a reflection probe
/// ([`crate::Frame::reflection_probe`], A.3) and an irradiance volume
/// ([`crate::Frame::irradiance_volume`], A.4).
pub use crate::frame::{DEFAULT_SPOT_INNER_DEGREES, DEFAULT_SPOT_OUTER_DEGREES, IrradianceVolume, ReflectionProbe, SpotLight};
/// Physical light units: lux, candela, lumens, nits and EV100 in the renderer's scene units
/// (`genex::render::units::lumens(800.0)`; docs/api/lighting.md, "Physical units").
#[path = "light_units.rs"]
pub mod units;
/// A projected decal ([`crate::Frame::decal`], renderer pass 2 A.10) and its boxes' default depths.
pub use crate::decal::{DEFAULT_GROUND_DEPTH, DEFAULT_WALL_DEPTH, Decal};
/// Lake water (renderer pass 2 B.3): a water rectangle drawn with [`crate::Frame::water`].
pub use crate::water::{WATER_ABSORPTION_MAX, WATER_FOAM_MAX, WATER_REFRACTION_MAX, WATER_RIPPLE_MAX, Water};

/// The tonemapper of a game's look: how the HDR scene becomes display colour.
/// [`Tonemap::KhronosNeutral`] (the default) keeps authored colours as they are up to the
/// highlights; [`Tonemap::AgxPunchy`] is the filmic choice for bright, high-contrast scenes with
/// saturated lights (a low sun, fire, lanterns, neon): AgX's soft highlights with colour and mid
/// contrast kept. Plain [`Tonemap::Agx`] rolls off the same way but greys saturated lights and
/// flattens mid contrast; [`Tonemap::Aces`] is the punchier film curve; [`Tonemap::None`] clamps.
pub type Tonemap = Tonemapper;

/// The largest EV compensation either way (`genex.toml`'s `ev_compensation` limit).
const EV_COMPENSATION_LIMIT: f32 = manifest::EV_COMPENSATION_LIMIT as f32;
/// The slowest auto exposure adaptation a look keeps, in EV per second (genex.toml refuses 0).
const ADAPTATION_SPEED_MIN: f32 = 0.01;

/// The save file the person's graphics choices and the calibration hint are kept in, per device.
pub const SETTINGS_FILE: &str = "genex-render.json";
/// The `[render]` tables a build lane may compile in (a `genex.toml` fragment), read when the game
/// sets no [`RenderConfig`] of its own.
const BUILD_RENDER_TOML: Option<&str> = option_env!("GENEX_RENDER_TOML");
/// The title a `[render]`-only fragment is parsed under (the manifest needs a `[game]` table).
const FRAGMENT_GAME: &str = "[game]\ntitle = \"render\"\n";
/// The class captures are drawn as when the host recorded none for the adapter.
pub const REFERENCE_CLASS: DeviceClass = DeviceClass::new(FormFactor::Desktop, PerformanceTier::High);
/// A gap between Live frames longer than this is a pause (a paused game drawn by verbs, a hidden
/// page), never a missed vsync: dynamic resolution does not read it.
pub const PAUSE_INTERVAL_MS: f32 = 250.0;
/// A GPU span no longer than this multiple of the frame's CPU time is the CPU's (the GPU idled
/// while the CPU encoded): the GPU tail after the last submission is all a span adds over it.
pub const CPU_BOUND_SPAN_FACTOR: f32 = 1.1;
/// The shortest and longest frame time the verb may ask dynamic resolution to hold, in
/// milliseconds (the wire's `FRAME_BUDGET_MS_MIN..=FRAME_BUDGET_MS_MAX`).
pub const FRAME_BUDGET_MS_MIN: f32 = 1.0;
/// See [`FRAME_BUDGET_MS_MIN`].
pub const FRAME_BUDGET_MS_MAX: f32 = 100.0;
/// Settle frames a capture's provenance names before a settled capture drew: the reply then names
/// the K it drew (`genex_render::settle::settle_plan`: the jitter cycle with TAA or temporal AO).
pub const CAPTURE_SETTLE_FRAMES: u32 = 1;

/// The panel's automatic entry (the device and the game choose).
const PANEL_AUTO: &str = "Auto";
/// The panel's top preset entry: ultra drawn natively (lane UQ).
const PANEL_MAX: &str = "Max";

/// A preset's label in the settings panel (user copy).
pub fn preset_label(preset: QualityPreset) -> &'static str {
    match preset {
        QualityPreset::Low => "Low",
        QualityPreset::Medium => "Medium",
        QualityPreset::High => "High",
        QualityPreset::Ultra => "Ultra",
        _ => "Preset",
    }
}

/// The panel's preset menu: automatic first (naming what it picks now when the person has no
/// choice of their own), then every preset, then Max (ultra drawn natively) when `max` is offered.
fn panel_presets(effective: QualityPreset, person: Option<QualityPreset>, offered: &[QualityPreset], max: bool) -> Vec<String> {
    let auto = match person {
        None => format!("{PANEL_AUTO} ({})", preset_label(effective)),
        Some(_) => PANEL_AUTO.to_owned(),
    };
    let presets = offered.iter().map(|preset| preset_label(*preset).to_owned());
    std::iter::once(auto).chain(presets).chain(max.then(|| PANEL_MAX.to_owned())).collect()
}

/// An upscaling mode's label in the settings panel (user copy).
pub fn upscale_label(mode: UpscaleMode) -> &'static str {
    match mode {
        UpscaleMode::Native => "Native",
        UpscaleMode::Quality => "Quality",
        UpscaleMode::Balanced => "Balanced",
        UpscaleMode::Performance => "Performance",
        _ => "Mode",
    }
}

/// The panel's upscaling menu: automatic first (naming the calibration's mode where it picks one),
/// then every mode.
fn panel_upscales(calibrated: Option<UpscaleMode>, person: Option<UpscaleMode>) -> Vec<String> {
    let auto = match (person, calibrated) {
        (None, Some(mode)) => format!("{PANEL_AUTO} ({})", upscale_label(mode)),
        _ => PANEL_AUTO.to_owned(),
    };
    std::iter::once(auto).chain(UpscaleMode::ALL.iter().map(|mode| upscale_label(*mode).to_owned())).collect()
}

/// A frame-rate target's label in the settings panel (user copy).
fn frame_rate_label(fps: u32) -> String {
    format!("{fps} fps")
}

/// The panel's frame-rate menu: automatic first (naming the rate it holds when the person has no
/// choice of their own), then every target.
fn panel_frame_rates(effective: u32, person: Option<u32>) -> Vec<String> {
    let auto = match person {
        None => format!("{PANEL_AUTO} ({})", frame_rate_label(effective)),
        Some(_) => PANEL_AUTO.to_owned(),
    };
    std::iter::once(auto).chain(FRAME_RATE_TARGETS.iter().map(|fps| frame_rate_label(*fps))).collect()
}

/// A feature switch's label in the settings panel (user copy).
pub fn feature_label(feature: RenderFeature) -> &'static str {
    match feature {
        RenderFeature::Hdr => "HDR",
        RenderFeature::Tonemap => "Tonemapping",
        RenderFeature::Exposure => "Exposure",
        RenderFeature::Ibl => "Image-based lighting",
        RenderFeature::Sky => "Sky",
        RenderFeature::Shadows => "Shadows",
        RenderFeature::ContactShadows => "Contact shadows",
        RenderFeature::Bloom => "Bloom",
        RenderFeature::Ao => "Ambient occlusion",
        RenderFeature::Fog => "Fog",
        RenderFeature::Taa => "Temporal anti-aliasing",
        RenderFeature::Upscaler => "Upscaler",
        RenderFeature::Clustered => "Clustered lights",
        RenderFeature::Meshlets => "Meshlets",
        RenderFeature::Occlusion => "Occlusion culling",
        RenderFeature::Prepass => "Depth prepass",
        RenderFeature::TextureQuality => "Texture quality",
        RenderFeature::SpotShadows => "Spot light shadows",
        RenderFeature::LodFade => "Detail crossfade",
        RenderFeature::Impostors => "Impostors",
        _ => "Feature",
    }
}

/// The web shell's device hints from the page's JSON (`studio_boot`'s second argument):
/// `{maxTouchPoints, coarsePointer, shortSideCssPx, deviceMemoryGb, hardwareConcurrency,
/// uaMobile}`, every member optional; a member of the wrong type reads as absent. None unless
/// `hints` is an object: a page that sends none is classified as a phone (the safe default).
pub fn web_hints_from_json(hints: &Value) -> Option<WebHints> {
    if !hints.is_object() {
        return None;
    }
    let whole = |key: &str| hints[key].as_u64().and_then(|n| u32::try_from(n).ok());
    Some(WebHints {
        max_touch_points: whole("maxTouchPoints").unwrap_or(0),
        coarse_pointer: hints["coarsePointer"].as_bool().unwrap_or(false),
        short_side_css_px: whole("shortSideCssPx").unwrap_or(0),
        device_memory_gb: hints["deviceMemoryGb"].as_f64().map(|gb| gb as f32),
        hardware_concurrency: whole("hardwareConcurrency"),
        ua_mobile: hints["uaMobile"].as_bool(),
    })
}

/// Where a capture's settings came from (`SettingsSource` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SettingsSource {
    /// The game's `[render]` preset.
    Toml,
    /// The reference class the host recorded for the adapter (or the probe's uncalibrated class).
    ReferenceClass,
    /// The `renderSettings` verb in this session.
    Verb,
}

impl SettingsSource {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            SettingsSource::Toml => "toml",
            SettingsSource::ReferenceClass => "reference-class",
            SettingsSource::Verb => "verb",
        }
    }
}

/// Why a frame runs with less than asked (`DegradeReason` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DegradeReason {
    /// The preset did not fit the class's memory budget: resource knobs stepped down, one entry per
    /// rung taken with the rung's wire name as its subject (`ao`, `shadow-size`, ...). Also each
    /// feature switch dynamic resolution's preset demotion turned off for the frame-time budget,
    /// with the feature's wire name as its subject.
    Budget,
    /// A custom pass's bytes are over the budget's room.
    PassOverBudget,
    /// A pipeline-shaping change waits for the next loading point.
    PipelineChangeDeferred,
    /// The preset asks for a knob this build does not draw yet (it arrives with its tier).
    NotLanded,
    /// A custom pass at custom-pass API v1 draws in the world: the frame stays on the LDR scene.
    CustomPassV1InWorld,
    /// A Level-2 material at extension API v1 is drawn: the frame stays on the LDR scene.
    MaterialV1InHdr,
}

impl DegradeReason {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            DegradeReason::Budget => "budget",
            DegradeReason::PassOverBudget => "pass-over-budget",
            DegradeReason::PipelineChangeDeferred => "pipeline-change-deferred",
            DegradeReason::NotLanded => "not-landed",
            DegradeReason::CustomPassV1InWorld => LdrReason::CustomPassV1InWorld.wire(),
            DegradeReason::MaterialV1InHdr => LdrReason::MaterialV1InHdr.wire(),
        }
    }
}

impl From<LdrReason> for DegradeReason {
    fn from(reason: LdrReason) -> DegradeReason {
        match reason {
            LdrReason::MaterialV1InHdr => DegradeReason::MaterialV1InHdr,
            _ => DegradeReason::CustomPassV1InWorld,
        }
    }
}

/// One reason a frame runs with less than asked, and what it concerns (a pass, a knob).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Degrade {
    /// The reason.
    pub reason: DegradeReason,
    /// The pass or knob it concerns, when it says.
    pub subject: Option<String>,
}

/// A game's exposure: the [`Look`]'s exposure keys as one value, set with
/// [`RenderConfig::exposure`] and read back with [`Exposure::of`].
///
/// Units are relative (the RQ1 unit decision): EV 0 is an exposure of 1.0 and each EV doubles it.
/// A manual exposure is fixed; auto exposure meters the scene's EV (`log2(luminance / 0.18)`),
/// clamps it to `ev_min..=ev_max`, adds `ev_compensation` and adapts towards it by at most
/// `adaptation_up` (brightening) or `adaptation_down` (darkening) EV per simulated second, a fixed
/// step per tick, never wall time, so a capture of one tick is one picture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Exposure {
    /// Manual or auto.
    pub mode: ExposureMode,
    /// The fixed EV (manual), or the EV added to the metered one (auto), within ±10.
    pub ev_compensation: f32,
    /// Where auto exposure looks.
    pub metering: Metering,
    /// Auto exposure's lowest metered EV (darker scenes are not brightened further), within ±16.
    pub ev_min: f32,
    /// Auto exposure's highest metered EV, within ±16.
    pub ev_max: f32,
    /// EV per second auto exposure brightens by, in `(0, 20]`.
    pub adaptation_up: f32,
    /// EV per second auto exposure darkens by, in `(0, 20]`.
    pub adaptation_down: f32,
}

impl Default for Exposure {
    /// The default look's exposure: manual, EV 0 (an exposure of 1.0).
    fn default() -> Exposure {
        Exposure::of(&Look::default())
    }
}

impl Exposure {
    /// A fixed exposure of `ev` (0 is 1.0, 1 doubles it, -1 halves it).
    pub fn manual(ev: f32) -> Exposure {
        Exposure { mode: ExposureMode::Manual, ev_compensation: ev, ..Exposure::default() }
    }

    /// Auto exposure with the default metering (average), range (-8..=8 EV) and speeds (1 EV/s
    /// brightening when the scene gets darker, 3 EV/s darkening when it gets brighter).
    pub fn auto() -> Exposure {
        Exposure { mode: ExposureMode::Auto, ..Exposure::default() }
    }

    /// The exposure with `ev` of compensation (manual: the fixed EV).
    pub fn compensation(self, ev: f32) -> Exposure {
        Exposure { ev_compensation: ev, ..self }
    }

    /// The exposure metering with `metering`.
    pub fn metering(self, metering: Metering) -> Exposure {
        Exposure { metering, ..self }
    }

    /// The exposure metering scene EVs within `ev_min..=ev_max`.
    pub fn range(self, ev_min: f32, ev_max: f32) -> Exposure {
        Exposure { ev_min, ev_max, ..self }
    }

    /// The exposure adapting by at most `up` EV per second when the scene darkens and `down` when
    /// it brightens.
    pub fn adaptation(self, up: f32, down: f32) -> Exposure {
        Exposure { adaptation_up: up, adaptation_down: down, ..self }
    }

    /// The exposure keys of `look`.
    pub fn of(look: &Look) -> Exposure {
        Exposure {
            mode: look.exposure,
            ev_compensation: look.ev_compensation,
            metering: look.metering,
            ev_min: look.ev_min,
            ev_max: look.ev_max,
            adaptation_up: look.adaptation_up,
            adaptation_down: look.adaptation_down,
        }
    }

    /// `look` with this exposure, each value held inside the limits `genex.toml` checks (a value
    /// that is not a number keeps the default's).
    pub fn apply_to(self, look: Look) -> Look {
        let fallback = Exposure::default();
        let held = |value: f32, default: f32, min: f32, max: f32| if value.is_finite() { value.clamp(min, max) } else { default };
        let ev_min = held(self.ev_min, fallback.ev_min, -EXPOSURE_EV_LIMIT, EXPOSURE_EV_LIMIT);
        let ev_max = held(self.ev_max, fallback.ev_max, -EXPOSURE_EV_LIMIT, EXPOSURE_EV_LIMIT);
        let mut look = look;
        look.exposure = self.mode;
        look.metering = self.metering;
        look.ev_compensation = held(self.ev_compensation, fallback.ev_compensation, -EV_COMPENSATION_LIMIT, EV_COMPENSATION_LIMIT);
        (look.ev_min, look.ev_max) = (ev_min.min(ev_max), ev_min.max(ev_max));
        look.adaptation_up = held(self.adaptation_up, fallback.adaptation_up, ADAPTATION_SPEED_MIN, ADAPTATION_SPEED_MAX);
        look.adaptation_down = held(self.adaptation_down, fallback.adaptation_down, ADAPTATION_SPEED_MIN, ADAPTATION_SPEED_MAX);
        look
    }
}

/// A game's bloom: the [`Look`]'s bloom keys as one value, set with [`RenderConfig::bloom`] and
/// read back with [`Bloom::of`].
///
/// Bloom is threshold-free and energy-conserving: the tonemap blends the scene towards its own
/// blur by `intensity`, so bright things glow and nothing is added. A `threshold` above 0 is a
/// stylistic choice (only what is brighter than it, in pre-exposed scene units, glows). The blur
/// chain is sized from the output, so its glow is as wide on every preset and render scale; a
/// phone or a tight memory budget draws it at a lower resolution, never a different look.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bloom {
    /// The blend weight, `0..=1` (0.04 by default; 0 draws no bloom).
    pub intensity: f32,
    /// The stylistic threshold in pre-exposed scene units, `0..=16` (0, the default: none).
    pub threshold: f32,
    /// The spread, `0.25..=4` (1 by default): how much the wider blurs weigh against the narrower
    /// ones, so above 1 the glow reaches further and below 1 it hugs the light.
    pub radius: f32,
}

impl Default for Bloom {
    /// The default look's bloom: intensity 0.04, threshold-free, radius 1.
    fn default() -> Bloom {
        Bloom::of(&Look::default())
    }
}

impl Bloom {
    /// Threshold-free bloom blending `intensity`, with the default spread.
    pub fn new(intensity: f32) -> Bloom {
        Bloom { intensity, ..Bloom::default() }
    }

    /// No bloom (intensity 0).
    pub fn off() -> Bloom {
        Bloom::new(0.0)
    }

    /// The bloom glowing only above `threshold` (pre-exposed scene units; 0 is threshold-free).
    pub fn threshold(self, threshold: f32) -> Bloom {
        Bloom { threshold, ..self }
    }

    /// The bloom spread by `radius` (above 1 the glow reaches further, below 1 it hugs the light).
    pub fn radius(self, radius: f32) -> Bloom {
        Bloom { radius, ..self }
    }

    /// The bloom keys of `look`.
    pub fn of(look: &Look) -> Bloom {
        Bloom { intensity: look.bloom_intensity, threshold: look.bloom_threshold, radius: look.bloom_radius }
    }

    /// `look` with this bloom, each value held inside the limits `genex.toml` checks.
    pub fn apply_to(self, look: Look) -> Look {
        look.with_bloom(self.intensity, self.threshold, self.radius)
    }
}

/// The game's own render choices: its look, and its quality by preset and per device class (the
/// `genex.toml` `[render]` layer). Every key is optional; the device decides the rest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderConfig {
    /// The look, equal on every preset and device.
    pub look: Look,
    /// The preset and the per-class quality tables.
    pub quality: RenderOverrides,
    /// The game's meshlet rendering (R2): equal on every device, and only ever a narrowing of what
    /// the device's preset runs.
    pub meshlets: Meshlets,
    /// The game's upscaling mode (lane UQ), if it names one.
    pub upscale: UpscaleConfig,
}

/// A game's upscaling choice (lane UQ): [`RenderConfig::upscale`], [`RenderConfig::upscale_locked`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UpscaleConfig {
    /// The mode every device starts on, or None for the calibration's.
    pub mode: Option<UpscaleMode>,
    /// Whether the mode is the only one: the person's panel hides its row.
    pub locked: bool,
}

impl From<RenderSettings> for RenderConfig {
    /// A game's [`RenderSettings`]: its look, and its preset when it names one (`auto` and the
    /// legacy `off` leave the choice to the device).
    fn from(settings: RenderSettings) -> RenderConfig {
        let preset = match settings.preset {
            PresetChoice::Preset(preset) => Some(preset),
            _ => None,
        };
        RenderConfig { look: settings.look, quality: RenderOverrides { preset, ..RenderOverrides::default() }, meshlets: settings.meshlets, upscale: UpscaleConfig::default() }
    }
}

impl RenderConfig {
    /// No choices: the default look, the device's preset.
    pub fn new() -> RenderConfig {
        RenderConfig::default()
    }

    /// The config with `look`.
    pub fn look(mut self, look: Look) -> RenderConfig {
        self.look = look;
        self
    }

    /// The config with `tonemap` as its look's tonemapper.
    pub fn tonemap(mut self, tonemap: Tonemap) -> RenderConfig {
        self.look.tonemapper = tonemap;
        self
    }

    /// The config with `exposure` as its look's exposure ([`Exposure::apply_to`]).
    pub fn exposure(mut self, exposure: Exposure) -> RenderConfig {
        self.look = exposure.apply_to(self.look);
        self
    }

    /// The config with `fog` as its look's fog (height and distance fog lit by the sky:
    /// `Fog::default().with_density(0.02).with_height(0.3, 0.0)`).
    pub fn fog(mut self, fog: Fog) -> RenderConfig {
        self.look = self.look.with_fog(fog);
        self
    }

    /// The config with its look's white balance: linear rgb `gains` on the whole frame before the
    /// tonemap, normalised to keep its brightness (`[1.0, 0.9, 0.75]` warms it towards golden
    /// hour). The default `[1.0, 1.0, 1.0]` leaves the picture unchanged.
    pub fn white_balance(mut self, gains: [f32; 3]) -> RenderConfig {
        self.look = self.look.with_white_balance(gains);
        self
    }

    /// The config with its look's white balance as a chromatic adaptation: `temperature` warms
    /// (positive) or cools (negative) and `tint` turns magenta (positive) or green, each within
    /// `-1..=1` (0 leaves the picture unchanged). Unlike gains it keeps saturated colours' hues: a
    /// warm grade warms the neutrals while a blue sky stays blue. It composes with
    /// [`RenderConfig::white_balance`].
    pub fn temperature(mut self, temperature: f32, tint: f32) -> RenderConfig {
        self.look = self.look.with_temperature(temperature, tint);
        self
    }

    /// The config with its look's local exposure on `high` and `ultra`: regions brighter than
    /// middle grey (a sunlit yard through a window) move towards it by `highlights`, darker ones
    /// (a corridor ceiling) by `shadows`, each `0.25..=1` (lower is stronger; 1 leaves that side
    /// as it is), keeping the detail inside each region. The default is 0.6 and 0.8.
    pub fn local_exposure(mut self, highlights: f32, shadows: f32) -> RenderConfig {
        let local = genex_render::post::local_exposure::LocalExposure::new(highlights, shadows);
        self.look = self.look.with_local_exposure(local);
        self
    }

    /// The config with its look's colour grading, each knob held to its range (the neutral
    /// default changes nothing). The knobs grade the HDR scene before the tonemapper (contrast
    /// turns about middle grey, so it never shifts the exposure); a LUT grades the display colour
    /// after it: `RenderConfig::new().grading(Grading::NEUTRAL.with_contrast(1.15).with_lut(lut, 0.8))`
    /// with `let lut = GradingLut::parse_cube(include_str!("../assets/looks/warm.cube"))?.intern()?;`.
    pub fn grading(mut self, grading: Grading) -> RenderConfig {
        self.look = self.look.with_grading(grading);
        self
    }

    /// The config with auto exposure's compensation curve: `(metered EV, compensation EV)` points,
    /// piecewise linear between them and flat beyond the ends (at most 8; a point that is not a
    /// number is left out). A scene metered dark can stay dark: `[(-4.0, -2.0), (0.0, 0.0)]` keeps
    /// a dusk at EV -3 1.5 EV under middle grey and leaves daylight alone. Empty (the default)
    /// adds nothing.
    pub fn exposure_curve(mut self, points: &[(f32, f32)]) -> RenderConfig {
        self.look = self.look.with_compensation_curve(genex_render::settings::CompensationCurve::new(points));
        self
    }

    /// The config with `bloom` as its look's bloom ([`Bloom::apply_to`]).
    pub fn bloom(mut self, bloom: Bloom) -> RenderConfig {
        self.look = bloom.apply_to(self.look);
        self
    }

    /// The config with its look's depth of field, each knob held to its range:
    /// `RenderConfig::new().depth_of_field(DepthOfField::focused(3.0, 2.0))` keeps three metres
    /// sharp at f/2. It draws after TAA on frames with the depth prepass (medium and up), never
    /// on a settled capture unless the shot asks ([`CaptureLens`]). Off by default.
    pub fn depth_of_field(mut self, depth_of_field: DepthOfField) -> RenderConfig {
        self.look = self.look.with_depth_of_field(depth_of_field);
        self
    }

    /// The config with its look's motion blur: `RenderConfig::new().motion_blur(MotionBlur::shutter(0.5))`
    /// blurs what moved by half its motion each frame (a 180-degree shutter). It draws after TAA
    /// and depth of field on frames that write motion (TAA's), at the preset's tier, never on a
    /// settled capture unless the shot asks ([`CaptureLens`]). Off by default.
    pub fn motion_blur(mut self, motion_blur: MotionBlur) -> RenderConfig {
        self.look = self.look.with_motion_blur(motion_blur);
        self
    }

    /// The config with `meshlets` as the game's meshlet rendering. Big meshes (at least
    /// `min_triangles` triangles) draw as meshlets, with two-pass Hi-Z occlusion, where the
    /// device's quality runs them. No preset does by default (they measured slower on typical
    /// scenes): a game opts in per class with the `meshlets` and `occlusion` feature switches of a
    /// class table (`[render.class.desktop-high] meshlets = true`, or [`RenderConfig::class`]), and
    /// this setting only narrows what runs: opt out, drop occlusion, or cluster fewer meshes. For
    /// example `RenderConfig::new().meshlets(Meshlets::DEFAULT.with_occlusion(false))` for a scene
    /// whose meshes are never hidden behind one another. Occlusion runs only over a one-sample world
    /// pass (TAA, once it lands); under MSAA it resolves off.
    pub fn meshlets(mut self, meshlets: Meshlets) -> RenderConfig {
        self.meshlets = meshlets;
        self
    }

    /// The config with `preset` on every class without its own table preset.
    pub fn preset(mut self, preset: QualityPreset) -> RenderConfig {
        self.quality.preset = Some(preset);
        self
    }

    /// The config starting every device on upscaling `mode` (lane UQ) instead of the calibration's
    /// pick, phones and browsers too; the person's panel may still change it:
    /// `RenderConfig::from_build().upscale(UpscaleMode::Native)` for a game whose look needs every
    /// pixel. Dynamic resolution moves within the mode's range.
    pub fn upscale(mut self, mode: UpscaleMode) -> RenderConfig {
        self.upscale = UpscaleConfig { mode: Some(mode), locked: false };
        self
    }

    /// The config holding every device at upscaling `mode`: the panel hides its Upscaling row and
    /// its Max preset, and a saved choice of the person's is kept but not drawn. For a mode the game
    /// holds only for a while (a photo mode), call [`lock_upscale`] from `on_ui` instead.
    pub fn upscale_locked(mut self, mode: UpscaleMode) -> RenderConfig {
        self.upscale = UpscaleConfig { mode: Some(mode), locked: true };
        self
    }

    /// The config with `shadows` while the resolved preset is `preset`: a game that wants 4
    /// cascades at `high` writes `.shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4))`
    /// and `low` and `medium` keep their rows. The request is held to its range and then to the
    /// device class's caps (a phone draws at most 2 cascades of 1536 px, no PCSS), so one config
    /// is right on every device. A later call for the same preset wins key by key.
    pub fn shadows_at(mut self, preset: QualityPreset, shadows: ShadowConfig) -> RenderConfig {
        self.quality.shadows.push((preset, shadows));
        self
    }

    /// The config with `lod` on `class` (game systems LOD-06), kept beside the rest of that class's
    /// table: `.lod_at(DeviceClass::new(FormFactor::Mobile, PerformanceTier::Low), LodConfig::new().threshold_px(4.0))`
    /// lets the low phones' levels switch nearer. Each key is held to its range, the threshold also
    /// to half..twice the preset's, then to the class's floor (a phone never draws finer than its
    /// tier's 2, 2.5 or 3 px); a later call for the same class wins key by key.
    pub fn lod_at(mut self, class: DeviceClass, lod: LodConfig) -> RenderConfig {
        match self.quality.classes.iter_mut().find(|(named, _)| *named == class) {
            Some((_, table)) => table.lod = table.lod.over(lod),
            None => self.quality.classes.push((class, ClassOverride { lod, ..ClassOverride::default() })),
        }
        self
    }

    /// The config with `quality` on `class` (replacing that class's table).
    pub fn class(mut self, class: DeviceClass, quality: ClassOverride) -> RenderConfig {
        self.quality.classes.retain(|(named, _)| *named != class);
        self.quality.classes.push((class, quality));
        self
    }

    /// The `[render]` tables of a whole `genex.toml`, or of a fragment holding only `[render]`
    /// tables; refused with the manifest's typed code when a value is outside its vocabulary.
    pub fn from_toml(text: &str) -> Result<RenderConfig, ManifestError> {
        // A fragment has no `[game]` table (text that does not parse is refused as a whole file).
        let fragment = text.parse::<toml::Table>().is_ok_and(|table| !table.contains_key("game"));
        let manifest = if fragment { manifest::parse(&format!("{FRAGMENT_GAME}{text}"))? } else { manifest::parse(text)? };
        Ok(RenderConfig::from_section(&manifest.render))
    }

    /// The config a checked `[render]` section describes.
    pub fn from_section(section: &RenderSection) -> RenderConfig {
        let mut look = Look::default();
        let wire = &section.look;
        if let Some(tonemapper) = wire.tonemapper().and_then(|t| Tonemapper::from_wire(t.as_str())) {
            look.tonemapper = tonemapper;
        }
        if let Some(exposure) = wire.exposure().and_then(|e| ExposureMode::from_wire(e.as_str())) {
            look.exposure = exposure;
        }
        if let Some(metering) = wire.metering().and_then(|m| Metering::from_wire(m.as_str())) {
            look.metering = metering;
        }
        if let Some(ev) = wire.ev_compensation {
            look.ev_compensation = ev as f32;
        }
        if let Some(bloom) = wire.bloom_intensity {
            look.bloom_intensity = bloom as f32;
        }
        let keys = [
            (wire.ev_min, &mut look.ev_min),
            (wire.ev_max, &mut look.ev_max),
            (wire.adaptation_speed_up, &mut look.adaptation_up),
            (wire.adaptation_speed_down, &mut look.adaptation_down),
        ];
        for (value, key) in keys {
            if let Some(value) = value {
                *key = value as f32;
            }
        }
        // Bloom's threshold and spread, GTAO, the fog and the contact shadows (RQ4).
        let look = wire.apply_effects(look);
        let preset = section.preset().and_then(|p| QualityPreset::from_wire(p.as_str()));
        let classes = section.classes().into_iter().filter_map(|(class, table)| class_table(class.as_str(), table)).collect();
        let shadows = shadow_rows(&section.shadows);
        RenderConfig { look, quality: RenderOverrides { preset, classes, shadows }, meshlets: Meshlets::DEFAULT, upscale: UpscaleConfig::default() }
    }

    /// The `[render]` tables the build lane compiled in (`GENEX_RENDER_TOML`, on every
    /// destination), else none (a build outside the lane, or a game without `[render]`).
    ///
    /// # Panics
    ///
    /// When the compiled-in tables are refused: the lane compiles in only a `[render]` the host's
    /// `genex.toml` check admitted (and refuses the build otherwise), so this is a lane defect and
    /// never silently ignored.
    pub fn from_build() -> RenderConfig {
        let Some(text) = BUILD_RENDER_TOML else { return RenderConfig::default() };
        match RenderConfig::from_toml(text) {
            Ok(config) => config,
            Err(error) => panic!("the [render] tables the build lane compiled in are refused ({}): {error}", error.code().as_str()),
        }
    }
}

/// `[render.shadows]` as the same shadow choices at every preset (none when the table sets none).
fn shadow_rows(section: &manifest::ShadowsSection) -> Vec<(QualityPreset, ShadowConfig)> {
    let mut asked = ShadowConfig::new();
    if let Some(distance) = section.distance {
        asked = asked.distance(u16::try_from(distance).unwrap_or(u16::MAX));
    }
    if let Some(band) = section.blend_band {
        asked = asked.blend_band(band as f32);
    }
    if asked == ShadowConfig::new() {
        return Vec::new();
    }
    QualityPreset::ALL.into_iter().map(|preset| (preset, asked)).collect()
}

fn class_table(class: &str, table: &manifest::ClassSection) -> Option<(DeviceClass, ClassOverride)> {
    let class = DeviceClass::from_wire(class)?;
    let switches = table.switches().into_iter().filter_map(|(feature, on)| RenderFeature::from_wire(feature.as_str()).map(|f| (f, on)));
    let quality = ClassOverride {
        preset: table.preset().and_then(|p| QualityPreset::from_wire(p.as_str())),
        render_scale: table.render_scale.map(|scale| scale as f32),
        fps: table.fps.and_then(|fps| u32::try_from(fps).ok()),
        switches: switches.collect(),
        lod: class_lod(table),
        ..ClassOverride::default()
    };
    Some((class, quality))
}

/// A class table's LOD keys (game systems LOD-06; a checked table holds them in range).
fn class_lod(table: &manifest::ClassSection) -> LodConfig {
    let mut lod = LodConfig::new();
    if let Some(pixels) = table.lod_threshold_px {
        lod = lod.threshold_px(pixels as f32);
    }
    if let Some(band) = table.lod_fade_band {
        lod = lod.fade_band(band as f32);
    }
    if let Some(density) = table.far_density {
        lod = lod.far_density(density as f32);
    }
    lod
}

impl<W: Default + 'static> Game<W> {
    /// The game's look and quality choices ([`RenderConfig`], or a [`RenderSettings`]): the
    /// `genex.toml` `[render]` layer. Settings never reach the simulation.
    pub fn render_settings(&mut self, config: impl Into<RenderConfig>) -> &mut Self {
        self.render = config.into();
        self
    }
}

/// What `renderSettings {set}` changes; a member left out stays.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderChange {
    /// `Some(Some(preset))` uses `preset` (`auto`: the class's own, over the game's and the
    /// person's); `Some(None)` gives the game's and the person's choice back.
    pub preset: Option<Option<PresetChoice>>,
    /// `Some(Some(class))` emulates a class, `Some(None)` gives the probed class back.
    pub device_class: Option<Option<DeviceClass>>,
    /// Feature switches, in order.
    pub features: Vec<(RenderFeature, bool)>,
    /// Whether the switches the verb set earlier are given back before `features` apply.
    pub reset_features: bool,
    /// `Some(Some(scale))` holds the render scale, `Some(None)` lets it move again.
    pub render_scale_lock: Option<Option<f32>>,
    /// `Some(Some(ms))` makes dynamic resolution hold `ms` per frame instead of the class's frame
    /// time (a fast GPU then shows how the scale steps, as a weaker device would); `Some(None)`
    /// gives the class's back.
    pub frame_budget_ms: Option<Option<f32>>,
}

/// Why a `renderSettings` change was refused (`RenderSettingsRefusal` on the wire).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RenderRefusal {
    /// A preset outside [`QualityPreset`] (and `auto`).
    UnknownPreset,
    /// A class outside [`DeviceClass`].
    UnknownDeviceClass,
    /// A switch outside [`RenderFeature`].
    UnknownFeature,
}

impl RenderRefusal {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            RenderRefusal::UnknownPreset => "unknown-preset",
            RenderRefusal::UnknownDeviceClass => "unknown-device-class",
            RenderRefusal::UnknownFeature => "unknown-render-feature",
        }
    }
}

impl RenderChange {
    /// The change the wire spells: a preset (`auto` included; `Some(None)` gives the game's and
    /// the person's back), a class to emulate (`Some(None)` gives the probed class back), feature
    /// switches and a scale lock. A spelling outside the vocabulary is refused typed.
    pub fn from_spellings(
        preset: Option<Option<&str>>,
        device_class: Option<Option<&str>>,
        features: &[(&str, bool)],
        render_scale_lock: Option<Option<f64>>,
    ) -> Result<RenderChange, RenderRefusal> {
        let preset = match preset {
            Some(Some("auto")) => Some(Some(PresetChoice::Auto)),
            Some(Some(name)) => Some(Some(PresetChoice::Preset(QualityPreset::from_wire(name).ok_or(RenderRefusal::UnknownPreset)?))),
            Some(None) => Some(None),
            None => None,
        };
        let device_class = match device_class {
            Some(Some(name)) => Some(Some(DeviceClass::from_wire(name).ok_or(RenderRefusal::UnknownDeviceClass)?)),
            Some(None) => Some(None),
            None => None,
        };
        let features = features
            .iter()
            .map(|(name, on)| RenderFeature::from_wire(name).map(|feature| (feature, *on)).ok_or(RenderRefusal::UnknownFeature))
            .collect::<Result<Vec<_>, _>>()?;
        let render_scale_lock = render_scale_lock.map(|lock| lock.map(|scale| scale as f32));
        Ok(RenderChange { preset, device_class, features, reset_features: false, render_scale_lock, frame_budget_ms: None })
    }
}

/// Feature switches by their wire spellings.
pub fn spelled_features(features: &[(RenderFeature, bool)]) -> Vec<(&'static str, bool)> {
    features.iter().map(|(feature, on)| (feature.wire(), *on)).collect()
}

/// A requested preset's wire spelling (`auto` for anything the device decides).
pub fn requested_spelling(requested: PresetChoice) -> &'static str {
    match requested {
        PresetChoice::Preset(preset) => preset.wire(),
        _ => "auto",
    }
}

/// What `renderSettings` answers: the Live settings after the call.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderAnswer {
    /// The preset in effect.
    pub preset: QualityPreset,
    /// What was asked for (`auto` when nothing names a preset).
    pub requested: PresetChoice,
    /// The class in force (emulated or detected).
    pub device_class: DeviceClass,
    /// The class the probe and the calibration hint detected.
    pub detected_class: DeviceClass,
    /// Every feature switch in force.
    pub features: Vec<(RenderFeature, bool)>,
    /// The held render scale, if any.
    pub render_scale_lock: Option<f32>,
    /// The frame time dynamic resolution holds for the verb, if any (else the class's).
    pub frame_budget_ms: Option<f32>,
    /// The last Live frame's render scale.
    pub scale: f32,
}

/// `state().volatile.render`: what Live frames run with. Never compared.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderStatus {
    /// The class in force.
    pub device_class: DeviceClass,
    /// The preset in effect.
    pub preset: QualityPreset,
    /// The last Live frame's render scale.
    pub scale: f32,
    /// Every feature switch in force.
    pub features: Vec<(RenderFeature, bool)>,
    /// Why frames run with less than asked.
    pub degraded: Vec<Degrade>,
    /// GPU time per Live frame, p50 of the window (timestamp queries only).
    pub gpu_ms: Option<f32>,
    /// CPU encode and submit time per Live frame, p50 of the window.
    pub cpu_ms: Option<f32>,
    /// What levels of detail Live frames run with (`volatile.render.lod`, game systems LOD-16).
    pub lod: LodStatus,
    /// What the last drawn frame's characters did (`volatile.render.characters`, game systems
    /// AN-23).
    pub characters: CharactersStatus,
}

/// `state().volatile.render.characters` (game systems AN-23): the last drawn frame's characters,
/// how many were posed and held (AN-17's rate bands), and how many the renderer skinned by compute
/// and in the vertex stage under the device class's compute cap. Outside the checksum; never
/// compared.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CharactersStatus {
    /// Characters drawn skinned.
    pub drawn: u32,
    /// Of them, poses evaluated for the frame.
    pub evaluated: u32,
    /// Of them, poses held from an earlier tick.
    pub held: u32,
    /// Skinned instances the renderer skinned by compute.
    pub compute_skinned: u32,
    /// Skinned instances it skinned in the vertex stage (small on screen, or past the cap).
    pub vertex_skinned: u32,
    /// The device class's compute cap (None before the renderer knows its class).
    pub compute_max: Option<u32>,
}

impl CharactersStatus {
    /// The wire object: `{drawn, evaluated, held, computeSkinned, vertexSkinned, computeMax}`
    /// (`computeMax` null without a cap).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "drawn": self.drawn,
            "evaluated": self.evaluated,
            "held": self.held,
            "computeSkinned": self.compute_skinned,
            "vertexSkinned": self.vertex_skinned,
            "computeMax": self.compute_max,
        })
    }
}

/// `state().volatile.render.lod` (game systems LOD-16): the Live quality's level-of-detail
/// threshold and crossfade band, and the impostors baked on the renderer in use. Outside the
/// checksum; never compared.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LodStatus {
    /// The error a drawn level may show, in output pixels.
    pub threshold_px: f32,
    /// The crossfade band, as a share of the threshold.
    pub fade_band: f32,
    /// Whether impostors draw.
    pub impostors_on: bool,
    /// The most impostor species this session's atlas class holds (past it a model keeps its last
    /// mesh level).
    pub species_cap: u32,
    /// The impostors baked, in first-draw order.
    pub impostors: Vec<crate::present::ImpostorStat>,
}

impl LodStatus {
    /// The wire object: `{thresholdPx, fadeBand, impostorsOn, species, speciesCap, impostors:
    /// [{model, layout, frames, framePx, bytes, bakeMs, prebaked}]}` (`prebaked`: loaded from a
    /// build-time atlas, LOD-23).
    pub fn to_json(&self) -> serde_json::Value {
        let impostors: Vec<serde_json::Value> = self
            .impostors
            .iter()
            .map(|stat| {
                serde_json::json!({ "model": stat.model, "layout": stat.layout.wire(), "frames": stat.frames, "framePx": stat.frame_px, "bytes": stat.bytes, "bakeMs": stat.bake_ms, "prebaked": stat.prebaked })
            })
            .collect();
        serde_json::json!({
            "thresholdPx": self.threshold_px,
            "fadeBand": self.fade_band,
            "impostorsOn": self.impostors_on,
            "species": self.impostors.len(),
            "speciesCap": self.species_cap,
            "impostors": impostors,
        })
    }
}

/// A capture's `render` provenance: the pinned settings it was drawn with.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureRender {
    /// The preset.
    pub preset: QualityPreset,
    /// The class (the reference class, or the verb's emulated one).
    pub device_class: DeviceClass,
    /// Where the settings came from.
    pub source: SettingsSource,
    /// The render scale (the profile's nominal step, or the verb's lock).
    pub scale: f32,
    /// Frames re-rendered from one Sim state.
    pub settle_frames: u32,
    /// Whether the capture's temporal history started empty (always).
    pub history_reset: bool,
}

/// What one frame draws with: what the presenter hands the renderer (`set_quality`,
/// `set_render_scale`, `set_scene_format`, `set_look`) and the custom passes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameChoice {
    /// The quality.
    pub quality: Quality,
    /// The render scale.
    pub scale: f32,
    /// The scene format (the class's HDR format; HDR frames draw on it when `quality.hdr` is on).
    pub scene_format: SceneFormat,
    /// The game's look (the same on every preset and class).
    pub look: Look,
    /// The game's meshlet rendering (the same on every preset and class); what the frame draws of
    /// it is [`FrameChoice::meshlets_drawn`].
    pub meshlets: Meshlets,
}

impl FrameChoice {
    /// What this frame draws: (meshlets, Hi-Z occlusion). The quality says what the device runs and
    /// the game's [`Meshlets`] only narrows it; occlusion culls meshlet candidates, so it never runs
    /// without them.
    pub fn meshlets_drawn(&self) -> (bool, bool) {
        self.meshlets.drawn(&self.quality)
    }
}

/// The verb's session-only layer.
#[derive(Clone, Debug, Default, PartialEq)]
struct VerbLayer {
    preset: Option<PresetChoice>,
    class: Option<DeviceClass>,
    switches: Vec<(RenderFeature, bool)>,
    scale_lock: Option<f32>,
    frame_budget_ms: Option<f32>,
}

impl VerbLayer {
    fn is_empty(&self) -> bool {
        *self == VerbLayer::default()
    }
}

/// A profile with its budget-fitted quality.
#[derive(Clone, Debug, PartialEq)]
struct Resolved {
    profile: RenderProfile,
    quality: Quality,
    /// The rungs the memory budget stepped down, each once, in the ladder's order.
    budget_rungs: Vec<DegradeRung>,
}

/// The rungs of `steps`, each once, in the order first taken.
fn rungs_of(steps: &[genex_render::budget::DegradeStep]) -> Vec<DegradeRung> {
    let mut rungs: Vec<DegradeRung> = Vec::new();
    for step in steps {
        if !rungs.contains(&step.rung) {
            rungs.push(step.rung);
        }
    }
    rungs
}

/// Every render setting of one game on one device (module docs): the layers, the probe, dynamic
/// resolution and the frame-time window.
pub struct RenderControl {
    config: RenderConfig,
    /// The game's logical world size: the session's material arrays are fitted at it.
    world: (u32, u32),
    /// The size Live frames draw at (the window's pixels capped by the class, else the world).
    output: (u32, u32),
    /// The letterbox the window present fills on Live frames, when a window is known.
    window: Option<(u32, u32)>,
    /// The size captures draw at when one was asked for (`capture --size`), else the world.
    capture_output: Option<(u32, u32)>,
    facts: DeviceFacts,
    probed: bool,
    calibration: Option<ScoreLevel>,
    reference: Option<DeviceClass>,
    person: ClassOverride,
    person_dirty: bool,
    /// The save file as loaded (other devices' entries are kept when this one's is written).
    saved: Value,
    verb: VerbLayer,
    live: Resolved,
    drs: DrsController,
    /// Live's upscale scale (lane UQ): the share of the output its upscaling mode renders a side
    /// ([`RenderControl::upscale`]; 1 where none is in force). Dynamic resolution's steps, the
    /// nominal scale and the budget fit are multiplied by it.
    upscale_scale: f32,
    /// The mode the game holds for now ([`lock_upscale`]: a photo mode), this session only.
    upscale_lock: Option<UpscaleMode>,
    timing: TimingWindow,
    /// The newest GPU time that landed.
    last_gpu_ms: Option<f32>,
    scale: f32,
    pass_over_budget: Vec<String>,
    /// The impostors the presenter baked on the renderer in use (LOD-16, `volatile.render.lod`).
    impostors: Vec<crate::present::ImpostorStat>,
    /// The last drawn frame's characters (AN-23, `volatile.render.characters`).
    characters: CharactersStatus,
    pipeline_deferred: bool,
    ldr_reason: Option<LdrReason>,
    /// Whether the renderer holds the spot atlas layer (the game asked for a shadowed spot under a
    /// quality that draws them, `Renderer::uses_shadowed_spots`): the budget counts it from then on.
    spot_atlas: bool,
    /// The GPU buffers the renderer held after its last Live frame (`Renderer::buffer_ledger`,
    /// renderer pass 2 A.0 LG-13): the device's own budget counts them at its next fit.
    buffers: genex_render::budget::BudgetLedger,
    /// The session's material arrays ([`RenderControl::texture_arrays`]), resolved with the rest.
    textures: (DeviceClass, TextureQuality),
    /// Explicit settings changes so far (the probe, a saved choice loaded, the person's panel, the
    /// verb): the presenter rebuilds the world pass for a new anti-aliasing only on one of these.
    generation: u64,
    /// The samples per pixel the renderer's world pass was built with (None before the first
    /// frame): Live reports what that pass draws ([`with_world_samples`]).
    world_samples: Option<u32>,
    /// The settings generation when a Live frame last noted its world pass (None before the
    /// first): a change since then is not drawn yet and is named deferred.
    drawn_generation: Option<u64>,
}

/// The shared handle the runtime, the presenter and the panel reach the settings through.
pub type RenderHandle = Rc<RefCell<RenderControl>>;

fn same_switch(a: &(RenderFeature, bool), b: &(RenderFeature, bool)) -> bool {
    a.0 == b.0
}

fn push_switch(switches: &mut Vec<(RenderFeature, bool)>, switch: (RenderFeature, bool)) {
    switches.retain(|known| !same_switch(known, &switch));
    switches.push(switch);
}

/// The class's DRS controller over its table's steps with `nominal` among them, rising no higher
/// than `ceiling`, at `fps` (with the class's sustained rate under thermal load), demoting at most
/// to `low`.
fn controller(class: DeviceClass, preset: QualityPreset, nominal: f32, ceiling: f32, fps: u32) -> DrsController {
    budgeted_controller(class, preset, (nominal, ceiling, 1.0), fps, DrsAim { budget_ms: None, dynamic: true })
}

/// What dynamic resolution aims at besides the class's frame rate: the verb's frame budget, and
/// whether it moves at all (the person's or the game's switch, lane UQ).
#[derive(Clone, Copy, Debug, PartialEq)]
struct DrsAim {
    budget_ms: Option<f32>,
    dynamic: bool,
}

/// [`controller`], holding `aim.budget_ms` per frame instead of `fps`'s frame time when the verb
/// asks, and only the nominal step with no preset demotion when `aim.dynamic` is off; `scales` are
/// the nominal scale, the ceiling and the upscale scale every step is multiplied by (lanes UP and
/// UQ; never below [`genex_render::settings::RENDER_SCALE_MIN`]).
fn budgeted_controller(class: DeviceClass, preset: QualityPreset, scales: (f32, f32, f32), fps: u32, aim: DrsAim) -> DrsController {
    let (relative, ceiling, upscale) = scales;
    let floor = genex_render::settings::RENDER_SCALE_MIN;
    let held = |scale: f32| (scale * upscale).max(floor);
    let defaults = class_defaults(class);
    let nominal = held(relative);
    let table: Vec<f32> = if aim.dynamic { defaults.drs_steps.iter().map(|step| held(*step)).collect() } else { Vec::new() };
    let steps = ScaleSteps::table(&table, nominal).up_to(held(ceiling).max(quantized(nominal)));
    let levels = if aim.dynamic { QualityPreset::ALL.iter().position(|known| *known == preset).unwrap_or(0) } else { 0 };
    let sustained = defaults.sustained_fps.filter(|sustained| *sustained < fps);
    let frame = aim.budget_ms.map_or_else(|| Duration::from_secs(1) / fps.max(1), |ms| Duration::from_secs_f32(ms / 1000.0));
    DrsController::new(steps, nominal, frame)
        .with_max_demotion(levels as u8)
        .with_sustained_fps(sustained)
}

/// Where Live's upscaling mode comes from (lane UQ, [`RenderControl::upscale`]), first source
/// winning: the game's hold ([`lock_upscale`], then [`RenderConfig::upscale_locked`]), the person's
/// panel, the game's default ([`RenderConfig::upscale`], a class table's first), the calibration.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UpscaleSource {
    /// The calibration's pick for the device class and the window (never Native).
    Calibrated,
    /// The game's default.
    Game,
    /// The person's choice in the settings panel.
    Person,
    /// The game holds it (the panel cannot change it).
    Locked,
}

/// Whether two person layers differ only in what moves a frame's render scale (the upscaling mode,
/// the render scale, the frame-rate target, dynamic resolution): no pipeline knob, so the change
/// rebuilds nothing and warms no renderer.
fn scale_only_change(a: &ClassOverride, b: &ClassOverride) -> bool {
    let pipeline = |layer: &ClassOverride| ClassOverride { upscale: None, render_scale: None, fps: None, dynamic_resolution: None, ..layer.clone() };
    pipeline(a) == pipeline(b)
}

/// Whether a landed GPU span of `gpu_ms` over `target` is the CPU's: the frame's CPU time explains
/// it (the span is at most [`CPU_BOUND_SPAN_FACTOR`] of it). A span under the target bounds the
/// GPU's work from above, so it always counts (a calm frame may raise the scale).
fn cpu_bound_over(gpu_ms: f32, cpu_ms: Option<f32>, target: f32) -> bool {
    gpu_ms > target && cpu_ms.is_some_and(|cpu| gpu_ms <= cpu * CPU_BOUND_SPAN_FACTOR)
}

/// `scale` on the controller's quantum (an exact, stable target size).
fn quantized(scale: f32) -> f32 {
    ScaleSteps::over((scale, scale), 1).steps()[0]
}

fn unprobed_facts() -> DeviceFacts {
    DeviceFacts::new(TargetOs::current(), wgpu::Backend::Noop, wgpu::DeviceType::Other)
}

/// The device a capture of `class` resolves on (module docs): a native, OS-neutral adapter at
/// WebGPU core's limits, with no web preset cap, no `deviceMemory` budget and no optional scene
/// format, so a capture's quality is the same on every destination. A phone class keeps its MSAA
/// samples in tile memory, as every phone GPU does (plan §2.4: tile GPUs keep MSAA, which costs
/// nothing in transient tile memory); a desktop class has no transient attachments. Pass-1 gate
/// finding 02: counted as memory, mobile-low's MSAA was the first rung its 48 MB budget gave up,
/// so captures "as mobile-low" drew no anti-aliasing at all and EASU turned the far dock deck's
/// aliased seams into a regular dot pattern.
///
/// A desktop-high or desktop-ultra capture is the plan's reference Mac
/// ([`CAPTURE_DESKTOP_GPU_MEMORY_BYTES`]: the 2 GiB desktop cap), so its 1440p and 4K captures
/// draw their preset's own settings. G0 look: fitted to desktop-high's 512 MiB, 4K captures drew
/// no AA, no AO and 768 shadow maps, and 1440p ultra drew less than high.
fn capture_facts(class: DeviceClass) -> DeviceFacts {
    let mut facts = DeviceFacts::new(TargetOs::Linux, wgpu::Backend::Noop, wgpu::DeviceType::Other);
    facts.transient_saves_memory = Some(class.form == FormFactor::Mobile);
    let reference_desktop = class.form == FormFactor::Desktop && matches!(class.tier, PerformanceTier::High | PerformanceTier::Ultra);
    facts.with_gpu_visible_memory(reference_desktop.then_some(CAPTURE_DESKTOP_GPU_MEMORY_BYTES))
}

/// The GPU-visible memory of a desktop-high or desktop-ultra capture's reference device: the
/// memory whose share is the desktop cap ([`genex_render::presets::class_budget_bytes`]).
const CAPTURE_DESKTOP_GPU_MEMORY_BYTES: u64 = genex_render::presets::DESKTOP_BUDGET_MEMORY_CAP_BYTES * genex_render::presets::DESKTOP_BUDGET_MEMORY_DIVISOR;

/// The material texture arrays `textures` reserves on `class` (`texture::material_arrays`): none
/// with texture quality off, whose single 256 class grows with the game's textures.
fn texture_arrays(class: DeviceClass, textures: TextureQuality) -> Vec<MaterialClass> {
    if textures == TextureQuality::OFF {
        return Vec::new();
    }
    material_arrays(class, textures)
}

/// The surface a budget is fitted for: the output drawn and the window present's letterbox (Live
/// only, renderer pass 2, P2-0.9 step B).
#[derive(Clone, Copy, Debug, PartialEq)]
struct BudgetSurface {
    output: (u32, u32),
    window: Option<(u32, u32)>,
    /// The upscale scale every scale is multiplied by (Live's upscaling mode; 1 with none and for
    /// captures).
    upscale_scale: f32,
}

/// What the budget is fitted at for `profile` on `facts`: the class's scene format, whether its
/// MSAA colour is read by the weighted resolve (then never transient), and the widest HDR
/// environment map the class keeps (reserved: a game may name one in any frame).
fn budget_input(output: (u32, u32), scale: f32, facts: &DeviceFacts, profile: &RenderProfile) -> BudgetInput {
    let transient = facts.transient_saves_memory();
    let weighted = MsaaResolve::for_class(profile.class, transient) == MsaaResolve::Weighted;
    BudgetInput::new(output, scale, profile.scene_format, transient)
        .with_msaa_read(weighted)
        .with_environment_map(genex_render::presets::hdri_map_width(profile.class))
}

impl RenderControl {
    /// The settings of a game with `config` and a logical world of `world`, before the probe (an
    /// unknown adapter of this build's destination). Live and captures draw at the world size
    /// until the presenter says otherwise ([`RenderControl::set_live_output`],
    /// [`RenderControl::set_capture_size`]).
    pub fn new(config: RenderConfig, world: (u32, u32)) -> RenderControl {
        let facts = unprobed_facts();
        let class = classify(&facts);
        let live = Resolved { profile: profile(&facts, class, &config.quality, None), quality: Quality::off(), budget_rungs: Vec::new() };
        let mut control = RenderControl {
            drs: controller(class, live.profile.preset, 1.0, 1.0, live.profile.target_fps),
            upscale_scale: 1.0,
            upscale_lock: None,
            config,
            world,
            output: world,
            window: None,
            capture_output: None,
            facts,
            probed: false,
            calibration: None,
            reference: None,
            person: ClassOverride::default(),
            person_dirty: false,
            saved: json!({}),
            verb: VerbLayer::default(),
            live,
            timing: TimingWindow::new(),
            last_gpu_ms: None,
            scale: 1.0,
            pass_over_budget: Vec::new(),
            impostors: Vec::new(),
            characters: CharactersStatus::default(),
            pipeline_deferred: false,
            ldr_reason: None,
            spot_atlas: false,
            buffers: genex_render::budget::BudgetLedger::new(),
            textures: (class, TextureQuality::OFF),
            generation: 0,
            world_samples: None,
            drawn_generation: None,
        };
        control.resolve();
        control
    }

    /// The game's own layer.
    pub fn config(&self) -> &RenderConfig {
        &self.config
    }

    /// The game's look: what every frame, Live or captured, tonemaps and exposes with.
    pub fn look(&self) -> Look {
        self.config.look
    }

    /// Take the device's `facts` (and the cached or measured calibration hint), then resolve.
    pub fn probe(&mut self, facts: DeviceFacts, calibration: Option<ScoreLevel>) {
        self.facts = facts;
        self.calibration = calibration;
        self.probed = true;
        self.generation += 1;
        self.resolve();
    }

    /// Whether the device was probed.
    pub fn probed(&self) -> bool {
        self.probed
    }

    /// The device's facts (an unknown adapter before the probe).
    pub fn facts(&self) -> &DeviceFacts {
        &self.facts
    }

    /// Live frames draw at `output` (the window's pixels, capped by the class's reference
    /// resolution) into a window present filling `window` (renderer pass 2, P2-0.9 step B): the
    /// budget, its ceiling and dynamic resolution's upscale cost are fitted at them again when
    /// either changes. Captures never move with them. A refit whose quality draws another sample
    /// count is a pipeline change (GA round 2: the web canvas's first output dropped MSAA for the
    /// budget while the world pass kept its 4 samples, deferred until a settings change).
    pub fn set_live_output(&mut self, output: (u32, u32), window: Option<(u32, u32)>) {
        if (output, window) == (self.output, self.window) {
            return;
        }
        self.output = output;
        self.window = window;
        self.refit(false);
    }

    /// Resolve again after a change: an explicit `pipeline` change moves the settings generation (the
    /// presenter rebuilds or warms the world pass on it); any other moves it only when the refit's
    /// quality draws another sample count.
    fn refit(&mut self, pipeline: bool) {
        let samples = |control: &RenderControl| genex_render::renderer::landed_samples(control.live.quality.anti_aliasing);
        let before = samples(self);
        if pipeline {
            self.generation += 1;
        }
        self.resolve();
        if !pipeline && samples(self) != before {
            self.generation += 1;
        }
    }

    /// The size Live frames draw at (the world size until [`RenderControl::set_live_output`]).
    pub fn live_output(&self) -> (u32, u32) {
        self.output
    }

    /// The most pixels a Live frame's output may hold (lane UP): where Live upscales to the window
    /// temporally ([`genex_render::presets::upscales_to_native`]), four times the class's render
    /// budget, so it draws the window's own pixels and renders at most the budget; elsewhere the
    /// class's reference resolution's, which the window present upscales.
    pub fn live_output_cap_px(&self) -> u64 {
        let class = self.live_class();
        if self.upscales_live(&self.live.quality, class) {
            return native_output_cap_px(class);
        }
        render_pixel_budget(class)
    }

    /// Live's upscale scale (lanes UP and UQ): every Live scale is this times the class's own, the
    /// share of the output the upscaling mode in force renders a side (1 where none is).
    pub fn upscale_scale(&self) -> f32 {
        self.upscale_scale
    }

    /// The upscaling mode Live frames render with and where it comes from (lane UQ,
    /// [`UpscaleSource`]); None where no mode is in force (a phone or a browser the person and the
    /// game left to the class's own scale).
    pub fn upscale(&self) -> Option<(UpscaleMode, UpscaleSource)> {
        let class = self.live_class();
        let game_default = self.config.quality.class(class).and_then(|table| table.upscale).or(self.config.upscale.mode);
        let locked = self.upscale_lock.or(self.config.upscale.mode.filter(|_| self.config.upscale.locked));
        let chosen = [(locked, UpscaleSource::Locked), (self.person.upscale, UpscaleSource::Person), (game_default, UpscaleSource::Game)];
        if let Some((mode, source)) = chosen.into_iter().find_map(|(mode, source)| mode.map(|mode| (mode, source))) {
            return Some((mode, source));
        }
        calibrated_mode(class, self.facts.os, self.live_window()).map(|mode| (mode, UpscaleSource::Calibrated))
    }

    /// Whether the game holds the upscaling mode (the panel hides its row).
    fn upscale_held(&self) -> bool {
        self.upscale_lock.is_some() || self.config.upscale.locked
    }

    /// Hold Live at upscaling `mode` for now (a photo mode drawing every pixel natively), over the
    /// person's choice, this session only and never saved; None gives the person's and the game's
    /// back. A change rebuilds nothing: the next frame renders at the mode's scale.
    pub fn lock_upscale(&mut self, mode: Option<UpscaleMode>) {
        if mode != self.upscale_lock {
            self.upscale_lock = mode;
            self.refit(false);
        }
    }

    /// The window pixels Live's picture fills (its letterbox), else its output.
    fn live_window(&self) -> (u32, u32) {
        self.window.unwrap_or(self.output)
    }

    /// The share of the output the upscaling mode in force renders a side (1 with none): the
    /// mode's share of the window, the calibration's held to the class's pixel budget.
    fn upscale_scale_for(&self, class: DeviceClass, upscale: Option<(UpscaleMode, UpscaleSource)>) -> f32 {
        let window = self.live_window();
        match upscale {
            Some((_, UpscaleSource::Calibrated)) => output_scale(calibrated_window_scale(class, window), self.output, window),
            Some((mode, _)) => output_scale(mode.scale(), self.output, window),
            None => 1.0,
        }
    }

    /// The nominal render scale within the upscaling mode in force: the person's or the game's
    /// render scale, else all of the mode's share (the mode replaces the class's nominal scale).
    fn nominal_within_mode(&self, class: DeviceClass) -> f32 {
        let game = self.config.quality.class(class).and_then(|table| table.render_scale);
        self.person.render_scale.or(game).map_or(1.0, |scale| scale.clamp(genex_render::settings::RENDER_SCALE_MIN, 1.0))
    }

    /// Whether dynamic resolution moves Live's scale: the person's switch, else the game's class
    /// table's, else on.
    fn dynamic_resolution(&self, class: DeviceClass) -> bool {
        let game = self.config.quality.class(class).and_then(|table| table.dynamic_resolution);
        self.person.dynamic_resolution.or(game).unwrap_or(true)
    }

    /// Whether Live frames of `quality` on `class` upscale to the window temporally, as the world
    /// pass draws them ([`with_world_samples`]: an MSAA-built pass draws no TAA).
    fn upscales_live(&self, quality: &Quality, class: DeviceClass) -> bool {
        let drawn = match self.world_samples {
            Some(samples) => with_world_samples(quality, samples, class),
            None => *quality,
        };
        upscales_to_native(&drawn, class, self.facts.os)
    }

    /// Captures draw at `size` from now on (`capture --size`, the 4K/1440p plan), or at the world
    /// size again (None): the pinned profile is fitted to the class budget at that size.
    pub fn set_capture_size(&mut self, size: Option<(u32, u32)>) {
        self.capture_output = size;
    }

    /// The size captures draw at: the size asked for, else the world size.
    pub fn capture_output(&self) -> (u32, u32) {
        self.capture_output.unwrap_or(self.world)
    }

    /// What Live frames are fitted at.
    fn live_surface(&self) -> BudgetSurface {
        BudgetSurface { output: self.output, window: self.window, upscale_scale: self.upscale_scale }
    }

    /// What captures are fitted at: their own size, no window.
    fn capture_surface(&self) -> BudgetSurface {
        BudgetSurface { output: self.capture_output(), window: None, upscale_scale: 1.0 }
    }

    /// The reference class the host recorded for this adapter (captures; None:
    /// [`REFERENCE_CLASS`]).
    pub fn set_reference_class(&mut self, class: Option<DeviceClass>) {
        self.reference = class;
    }

    /// The class the probe and the calibration hint detected.
    pub fn detected_class(&self) -> DeviceClass {
        classify_calibrated(&self.facts, self.calibration)
    }

    /// The class Live frames use: the verb's emulated class, else the detected one.
    pub fn live_class(&self) -> DeviceClass {
        self.verb.class.unwrap_or_else(|| self.detected_class())
    }

    /// The class captures use: the verb's emulated class, else the host's reference class, else
    /// [`REFERENCE_CLASS`].
    pub fn capture_class(&self) -> DeviceClass {
        self.verb.class.or(self.reference).unwrap_or(REFERENCE_CLASS)
    }

    /// The verb's layer as a class override on `class` (`auto` names the class's preset).
    fn verb_layer(&self, base: &ClassOverride, class: DeviceClass) -> ClassOverride {
        let mut layer = base.clone();
        match self.verb.preset {
            Some(PresetChoice::Preset(preset)) => layer.preset = Some(preset),
            Some(PresetChoice::Auto) => layer.preset = Some(default_preset(class, self.facts.os)),
            _ => {}
        }
        for switch in &self.verb.switches {
            push_switch(&mut layer.switches, *switch);
        }
        layer
    }

    /// The material texture arrays every frame of this session draws from, Live and captured
    /// alike: the detected class's, at the texture quality the game's own layer (its preset and
    /// genex.toml tables) resolves to there, fitted to the class budget (the material rung drops
    /// the largest size class first). Never the person's choice, the verb's preset or class
    /// emulation, or the capture profile: the renderer fixes its arrays to this before its first
    /// texture and keeps them until the game reloads, so a capture's textures never depend on
    /// which frame came first, and the budget counts what is allocated.
    pub fn texture_arrays(&self) -> (DeviceClass, TextureQuality) {
        self.textures
    }

    /// The impostor atlas row every frame of this session bakes at (game systems LOD-16): the
    /// session's class (the material arrays') at the preset the game's own layer resolves to there;
    /// never Live's emulation or a capture's profile, so a capture's impostors never depend on
    /// which frame baked them.
    pub fn impostor_class(&self) -> genex_render::impostor::ImpostorClass {
        let (class, _) = self.textures;
        let preset = profile(&self.facts, class, &self.config.quality, None).preset;
        genex_render::impostor::impostor_class(preset, class)
    }

    /// [`RenderControl::texture_arrays`] computed from the probe and the game's layer.
    fn session_textures(&self) -> (DeviceClass, TextureQuality) {
        let class = self.detected_class();
        let profile = profile(&self.facts, class, &self.config.quality, None);
        let reserved = texture_arrays(class, profile.quality.textures);
        let input = budget_input(self.world, profile.quality.render_scale, &self.facts, &profile).with_materials(reserved.clone());
        let fitted = fit(&profile.quality, &input, profile.budget_bytes, DegradeMode::Boot);
        (class, fitted_textures(profile.quality.textures, &reserved, &fitted.materials))
    }

    /// The budget input of `profile` at `scale` on `facts`, with the spot atlas once the game uses
    /// it (Live only), and the material arrays it reserves. On the device itself (`own`: Live frames on
    /// the detected class) the material arrays are the session's as allocated, counted and never
    /// degraded (they are fixed); a profile for another class (the verb's emulation, a capture's
    /// reference class) reserves the arrays that class would hold, which the material rung may
    /// shrink, as that device's budget would.
    fn budget_for(&self, profile: &RenderProfile, scale: f32, facts: &DeviceFacts, own: bool, surface: BudgetSurface) -> (BudgetInput, Vec<MaterialClass>) {
        // Captures never count the spot atlas: it appears with the first frame that asks for a
        // shadowed spot, and a capture's settings must not depend on what was drawn before it.
        let held = if own { self.buffers.clone() } else { genex_render::budget::BudgetLedger::new() };
        let input = budget_input(surface.output, scale * surface.upscale_scale, facts, profile).with_spot_atlas(own && self.spot_atlas).with_window(surface.window).with_buffers(&held);
        let (class, textures) = self.textures;
        if own && profile.class == class {
            return (input.with_fixed_materials(texture_arrays(class, textures)), Vec::new());
        }
        let reserved = texture_arrays(profile.class, profile.quality.textures);
        (input.with_materials(reserved.clone()), reserved)
    }

    /// `profile` with its quality fitted to the class budget at the output size on `facts` (`own`:
    /// the device's own Live profile, see [`RenderControl::budget_for`]). On the device its
    /// texture quality is the session's arrays' ([`RenderControl::texture_arrays`]); elsewhere the
    /// size classes that survived the material rung.
    fn fitted(&self, profile: RenderProfile, facts: &DeviceFacts, own: bool, surface: BudgetSurface) -> Resolved {
        let (input, reserved) = self.budget_for(&profile, profile.quality.render_scale, facts, own, surface);
        let fitted = fit(&profile.quality, &input, profile.budget_bytes, DegradeMode::Boot);
        let mut quality = fitted.quality;
        quality.textures = if input.materials_fixed {
            self.textures.1
        } else {
            fitted_textures(profile.quality.textures, &reserved, &fitted.materials)
        };
        Resolved { quality, budget_rungs: rungs_of(&fitted.steps), profile }
    }

    /// Whether Live frames draw as the detected class (no class emulated by the verb).
    fn live_is_own(&self) -> bool {
        self.verb.class.is_none_or(|class| class == self.detected_class())
    }

    /// The highest scale of `class`'s steps whose ledger stays inside `live`'s budget: dynamic
    /// resolution never rises above it (the budget is fitted at the nominal scale).
    fn budget_ceiling(&self, class: DeviceClass, live: &Resolved) -> f32 {
        let nominal = live.quality.render_scale;
        let steps = ScaleSteps::table(class_defaults(class).drs_steps, nominal);
        let own = self.live_is_own();
        let surface = self.live_surface();
        let fits = |scale: &f32| ledger(&live.quality, &self.budget_for(&live.profile, *scale, &self.facts, own, surface).0).total() <= live.profile.budget_bytes;
        steps.steps().iter().copied().filter(|scale| *scale > nominal).take_while(fits).last().unwrap_or(nominal)
    }

    /// The GPU buffers the renderer holds now (LG-13): counted by the device's own budget from its
    /// next fit (a settings change, a resize, the spot atlas), never refitting on its own.
    pub fn note_buffers(&mut self, held: genex_render::budget::BudgetLedger) {
        self.buffers = held;
    }

    /// Whether the renderer holds the spot atlas layer (`Renderer::uses_shadowed_spots`, sticky):
    /// the first frame that does fits the budget again with the layer counted.
    pub fn note_spot_atlas(&mut self, held: bool) {
        if held && !self.spot_atlas {
            self.spot_atlas = true;
            self.resolve();
        }
    }

    /// Resolve the Live layers again; dynamic resolution starts over at the nominal step.
    fn resolve(&mut self) {
        self.textures = self.session_textures();
        let class = self.live_class();
        let top = self.verb_layer(&self.person, class);
        let mut asked = profile(&self.facts, class, &self.config.quality, Some(&top));
        let upscale = self.upscale();
        if upscale.is_some() {
            asked.quality.render_scale = self.nominal_within_mode(class);
        }
        self.upscale_scale = self.upscale_scale_for(class, upscale);
        let live = self.fitted(asked, &self.facts, self.live_is_own(), self.live_surface());
        let ceiling = self.budget_ceiling(class, &live);
        let thermal = self.drs.sustained();
        // FSR1's passes run at the output size below scale 1 (RCAS alone at 1 under TAA's
        // sharpen): costs no step changes, in the class's model (RQ5 review).
        let (below_one, at_one) = genex_render::post::fsr::upscale_costs_ms(&live.quality, class, self.output);
        let scales = (live.quality.render_scale, ceiling, self.upscale_scale);
        let aim = DrsAim { budget_ms: self.verb.frame_budget_ms, dynamic: self.dynamic_resolution(class) };
        let drs = budgeted_controller(class, live.profile.preset, scales, live.profile.target_fps, aim);
        self.drs = drs.with_upscale_ms(below_one, at_one);
        if thermal {
            self.drs.set_thermal(true, Duration::ZERO);
        }
        self.scale = self.verb.scale_lock.map_or_else(|| self.drs.scale(), quantized);
        self.live = live;
    }

    /// The pinned capture profile (module docs), resolved on [`capture_facts`], and where it came
    /// from.
    fn capture_resolved(&self) -> (Resolved, SettingsSource) {
        let class = self.capture_class();
        let top = self.verb_layer(&ClassOverride::default(), class);
        let facts = capture_facts(class);
        let resolved = self.fitted(profile(&facts, class, &self.config.quality, Some(&top)), &facts, false, self.capture_surface());
        let game_preset = self.config.quality.preset.is_some() || self.config.quality.class(class).is_some_and(|t| t.preset.is_some());
        let source = match (self.verb.is_empty(), game_preset) {
            (false, _) => SettingsSource::Verb,
            (true, true) => SettingsSource::Toml,
            (true, false) => SettingsSource::ReferenceClass,
        };
        (resolved, source)
    }

    /// The quality and scale the next Live frame draws with: [`RenderControl::live_asked`] as the
    /// renderer's world pass draws it ([`with_world_samples`]: a TAA ask over an MSAA pass draws
    /// MSAA, an MSAA ask over a one-sample pass draws TAA), which is what `volatile.render` and the
    /// answer report.
    pub fn live_frame(&self) -> FrameChoice {
        let asked = self.live_asked();
        match self.world_samples {
            Some(samples) => FrameChoice { quality: with_world_samples(&asked.quality, samples, self.live_class()), ..asked },
            None => asked,
        }
    }

    /// The quality and scale Live asks for: the resolved quality demoted by dynamic resolution's
    /// preset steps, at its scale step (or the verb's lock). The presenter builds the world pass
    /// for its anti-aliasing at boot and on each explicit change
    /// ([`RenderControl::pipeline_generation`]).
    pub fn live_asked(&self) -> FrameChoice {
        let class = self.live_class();
        let demoted = demoted_quality(&self.live.quality, self.live.profile.preset, class, self.drs.demotion());
        // The screen effects' pixel budgets (lane UP) at the nominal step's render size, so a
        // dynamic-resolution step never switches an effect's resolution.
        let nominal = self.drs.steps().steps()[self.drs.nominal_step()];
        let quality = effect_budgeted(&demoted, class, step_size(self.output, nominal));
        FrameChoice { quality, scale: self.scale, scene_format: self.live.profile.scene_format, look: self.config.look, meshlets: self.config.meshlets }
    }

    /// Explicit settings changes so far (the probe, a saved choice loaded, the person's panel, the
    /// verb). Dynamic resolution, a thermal hold and a budget refit never move it: the
    /// presenter changes the world pass's samples (a pipeline knob, a rebuild) only when it moves.
    pub fn pipeline_generation(&self) -> u64 {
        self.generation
    }

    /// The samples per pixel the renderer's world pass is built with now (the presenter's, after
    /// each frame's choice): Live reports what that pass draws.
    pub fn note_world_samples(&mut self, samples: u32) {
        self.world_samples = Some(samples);
        self.drawn_generation = Some(self.generation);
    }

    /// The quality and scale a capture draws with (the pinned profile) and its provenance.
    pub fn capture_frame(&self) -> (FrameChoice, CaptureRender) {
        let (resolved, source) = self.capture_resolved();
        let class = self.capture_class();
        let nominal = resolved.quality.render_scale;
        let nominal = controller(class, resolved.profile.preset, nominal, nominal, resolved.profile.target_fps).capture_scale();
        let scale = self.verb.scale_lock.map_or(nominal, quantized);
        let provenance = CaptureRender {
            preset: resolved.profile.preset,
            device_class: class,
            source,
            scale,
            settle_frames: CAPTURE_SETTLE_FRAMES,
            history_reset: true,
        };
        let scene_format = resolved.profile.scene_format;
        (FrameChoice { quality: resolved.quality, scale, scene_format, look: self.config.look, meshlets: self.config.meshlets }, provenance)
    }

    /// Apply the verb's `change` (this session only) and answer the settings now in force.
    pub fn apply(&mut self, change: &RenderChange) -> RenderAnswer {
        if let Some(preset) = change.preset {
            self.verb.preset = preset;
        }
        if let Some(class) = change.device_class {
            self.verb.class = class;
        }
        if change.reset_features {
            self.verb.switches.clear();
        }
        for switch in &change.features {
            push_switch(&mut self.verb.switches, *switch);
        }
        if let Some(lock) = change.render_scale_lock {
            self.verb.scale_lock = lock.map(|scale| scale.clamp(genex_render::settings::RENDER_SCALE_MIN, 1.0));
        }
        if let Some(budget) = change.frame_budget_ms {
            self.verb.frame_budget_ms = budget.map(|ms| ms.clamp(FRAME_BUDGET_MS_MIN, FRAME_BUDGET_MS_MAX));
        }
        self.generation += 1;
        self.resolve();
        self.answer()
    }

    /// What was asked for: the verb's preset, else the person's, else the game's, else `auto`.
    fn requested(&self) -> PresetChoice {
        if let Some(preset) = self.verb.preset {
            return preset;
        }
        let class = self.live_class();
        let game = self.config.quality.class(class).and_then(|table| table.preset).or(self.config.quality.preset);
        self.person.preset.or(game).map_or(PresetChoice::Auto, PresetChoice::Preset)
    }

    /// Every switch as drawn: on only when the quality asks for it and its node has landed.
    fn switches(quality: &Quality) -> Vec<(RenderFeature, bool)> {
        RenderFeature::ALL.into_iter().map(|feature| (feature, feature_drawn(quality, feature))).collect()
    }

    /// The settings in force (`renderSettings` without `set`).
    pub fn answer(&self) -> RenderAnswer {
        RenderAnswer {
            preset: self.live.profile.preset,
            requested: self.requested(),
            device_class: self.live_class(),
            detected_class: self.detected_class(),
            features: RenderControl::switches(&self.live_frame().quality),
            render_scale_lock: self.verb.scale_lock,
            frame_budget_ms: self.verb.frame_budget_ms,
            scale: self.scale,
        }
    }

    /// `state().volatile.render`.
    pub fn status(&self) -> RenderStatus {
        let mut degraded = Vec::new();
        for rung in &self.live.budget_rungs {
            degraded.push(Degrade { reason: DegradeReason::Budget, subject: Some(rung.wire().to_owned()) });
        }
        for pass in &self.pass_over_budget {
            degraded.push(Degrade { reason: DegradeReason::PassOverBudget, subject: Some(pass.clone()) });
        }
        if self.pipeline_deferred || self.change_undrawn() {
            degraded.push(Degrade { reason: DegradeReason::PipelineChangeDeferred, subject: Some("anti-aliasing".to_owned()) });
        }
        if let Some(reason) = self.ldr_reason {
            degraded.push(Degrade { reason: reason.into(), subject: None });
        }
        let quality = self.live_frame().quality;
        for knob in not_landed(&quality) {
            degraded.push(Degrade { reason: DegradeReason::NotLanded, subject: Some(knob.to_owned()) });
        }
        for feature in self.demoted_off() {
            let subject = Some(feature.wire().to_owned());
            if !degraded.iter().any(|degrade| degrade.subject == subject) {
                degraded.push(Degrade { reason: DegradeReason::Budget, subject });
            }
        }
        let summary = self.timing.summary();
        RenderStatus {
            device_class: self.live_class(),
            preset: self.live.profile.preset,
            scale: self.scale,
            features: RenderControl::switches(&quality),
            degraded,
            gpu_ms: summary.gpu_p50,
            cpu_ms: summary.cpu_p50,
            lod: LodStatus {
                threshold_px: quality.lod.threshold_px,
                fade_band: quality.lod.fade_band,
                impostors_on: quality.lod.impostors,
                species_cap: self.impostor_class().spec().species_cap,
                impostors: self.impostors.clone(),
            },
            characters: self.characters,
        }
    }

    /// Note what the last drawn frame's characters did (AN-23, `volatile.render.characters`).
    pub fn note_characters(&mut self, characters: CharactersStatus) {
        self.characters = characters;
    }

    /// Note the impostors the presenter baked on the renderer in use (LOD-16).
    pub fn note_impostors(&mut self, impostors: Vec<crate::present::ImpostorStat>) {
        self.impostors = impostors;
    }

    /// Whether an explicit change came after the last Live frame (GF round 2: right after the verb
    /// switched a phone to TAA, the last frame's findings said nothing was deferred, so a wait for
    /// the change to land returned before any frame drew it).
    fn change_undrawn(&self) -> bool {
        self.drawn_generation.is_some_and(|drawn| drawn != self.generation)
    }

    /// The feature switches the Live frame would draw without dynamic resolution's preset
    /// demotion and draws off with it (GF round 2: a phone over its frame time demoted to a
    /// preset without AO drew AO off and named nothing).
    fn demoted_off(&self) -> Vec<RenderFeature> {
        if self.drs.demotion() == 0 {
            return Vec::new();
        }
        let undemoted = match self.world_samples {
            Some(samples) => with_world_samples(&self.live.quality, samples, self.live_class()),
            None => self.live.quality,
        };
        let drawn = self.live_frame().quality;
        RenderFeature::ALL.into_iter().filter(|feature| feature_drawn(&undemoted, *feature) && !feature_drawn(&drawn, *feature)).collect()
    }

    /// The profile Live frames resolve to (before dynamic resolution).
    pub fn live_profile(&self) -> &RenderProfile {
        &self.live.profile
    }

    /// The custom passes over the budget's room, and whether a pipeline-shaping knob waits for a
    /// loading point (the presenter's findings for `degraded`).
    pub fn note_frame_findings(&mut self, over_budget: Vec<String>, pipeline_deferred: bool) {
        self.pass_over_budget = over_budget;
        self.pipeline_deferred = pipeline_deferred;
    }

    /// Why Live frames that ask for HDR draw on the legacy LDR scene (a v1 in-world custom pass, a
    /// v1 material: the presenter's `FrameConfig::ldr_reason`), or None: listed in `degraded`
    /// under its typed reason. Every other feature stays on, and nothing is refused.
    pub fn note_ldr_reason(&mut self, reason: Option<LdrReason>) {
        self.ldr_reason = reason;
    }

    /// One Live frame's measurements at `now`: its CPU time, the GPU times that landed (None when
    /// the device has no timestamp queries) and the display interval since the last Live frame.
    /// Dynamic resolution moves on them unless the verb holds the scale.
    ///
    /// The frame timer's GPU time spans the frame's submissions, so on a CPU-bound frame it also
    /// counts the GPU idling while the CPU encodes the frame's later parts. A span over the GPU
    /// target that the CPU time explains ([`cpu_bound_over`]) is kept for `volatile.render` but
    /// never drops the scale, which could not help it. A span well over the CPU time is the GPU's,
    /// whatever the target (pass-1 gate live finding 3: under the verb's 1 ms budget every frame
    /// of medium, high and ultra encoded in more than the 0.85 ms target and none reached DRS).
    pub fn observe(&mut self, cpu_ms: Option<f32>, landed: Option<&[f32]>, interval_ms: f32, now: Duration) {
        if let Some(cpu_ms) = cpu_ms {
            self.timing.push(genex_render::timing::FrameTiming { cpu_ms, gpu_ms: None, gpu_source: GpuSource::Timestamps });
        }
        for ms in landed.unwrap_or_default() {
            self.timing.push_gpu(*ms, GpuSource::Timestamps);
            self.last_gpu_ms = Some(*ms);
        }
        if let Some(lock) = self.verb.scale_lock {
            self.scale = quantized(lock);
            return;
        }
        let target = self.drs.gpu_target_ms();
        match landed {
            Some(samples) => {
                for ms in samples.iter().filter(|ms| !cpu_bound_over(**ms, cpu_ms, target)) {
                    self.drs.observe(FrameSignal::GpuMs(*ms), now);
                }
            }
            None if interval_ms > 0.0 && interval_ms <= PAUSE_INTERVAL_MS => {
                self.drs.observe(FrameSignal::IntervalOnly(interval_ms), now);
            }
            None => {}
        }
        self.scale = self.drs.scale();
    }

    /// The newest GPU frame time that landed, in milliseconds (timestamp queries only).
    pub fn last_gpu_ms(&self) -> Option<f32> {
        self.last_gpu_ms
    }

    /// The GPU target dynamic resolution holds, in milliseconds.
    pub fn gpu_target_ms(&self) -> f32 {
        self.drs.gpu_target_ms()
    }

    /// The milliseconds dynamic resolution counts below scale 1 as the upscale's, which no step
    /// changes (FSR1's EASU and RCAS at the output size in the class's model; 0 under bilinear).
    pub fn upscale_ms(&self) -> f32 {
        self.drs.fixed_ms()
    }

    /// Whether the platform reports sustained thermal load at `now` (a phone shell's thermal
    /// state): a class with a sustained rate holds it, and gets its own back after a cool spell.
    pub fn set_thermal(&mut self, loaded: bool, now: Duration) {
        self.drs.set_thermal(loaded, now);
    }

    /// The frame interval Live frames are held to now (the class's rate, or its sustained rate
    /// under thermal load).
    pub fn frame_interval(&self) -> Duration {
        self.drs.frame_interval()
    }

    /// The scales dynamic resolution moves between, lowest first (the class's table with the
    /// nominal scale, up to the budget's ceiling).
    pub fn scale_steps(&self) -> &[f32] {
        self.drs.steps().steps()
    }

    /// The person's layer (the in-game panel's saved choice on this device).
    pub fn person(&self) -> &ClassOverride {
        &self.person
    }

    /// The presets the settings panel offers on this device, lowest first: `low`, then each preset
    /// whose budget-fitted quality keeps on every feature an offered preset below it draws (on a
    /// small budget a preset's rungs can drop more than the preset below ever had, so it would
    /// draw less), and the person's own choice so the panel can name it.
    pub fn panel_offered(&self) -> Vec<QualityPreset> {
        let class = self.live_class();
        let own = self.live_is_own();
        let drawn = |preset: QualityPreset| {
            let person = ClassOverride { preset: Some(preset), ..self.person.clone() };
            let top = self.verb_layer(&person, class);
            let fitted = self.fitted(profile(&self.facts, class, &self.config.quality, Some(&top)), &self.facts, own, self.live_surface());
            RenderControl::switches(&fitted.quality).into_iter().filter(|(_, on)| *on).map(|(feature, _)| feature).collect::<Vec<_>>()
        };
        let mut offered = Vec::new();
        // What the offered presets below draw: a preset left out does not set the bar, or one
        // above it could draw less than the preset beside it in the panel.
        let mut below: Vec<RenderFeature> = Vec::new();
        for preset in QualityPreset::ALL {
            let features = drawn(preset);
            let keeps = below.iter().all(|feature| features.contains(feature));
            if preset == QualityPreset::Low || keeps || self.person.preset == Some(preset) {
                offered.push(preset);
                for feature in features {
                    if !below.contains(&feature) {
                        below.push(feature);
                    }
                }
            }
        }
        offered
    }

    /// Change the person's layer (the panel): it is saved per device after the tick.
    pub fn set_person(&mut self, person: ClassOverride) {
        if person == self.person {
            return;
        }
        // A change of what moves the scale (the upscaling mode, the frame-rate target, dynamic
        // resolution, the render scale) rebuilds nothing: the next frame renders at its new size, as
        // a dynamic-resolution step does, so it never hitches on a renderer build or a warm-up.
        let pipeline = !scale_only_change(&person, &self.person);
        self.person = person;
        self.person_dirty = true;
        self.refit(pipeline);
    }

    /// The device's save key (numbers, never names).
    fn device_key(&self) -> String {
        CalibrationKey::of(&self.facts).wire()
    }

    /// Read this device's saved choice and calibration hint from `saves` (a missing or malformed
    /// file is no choice); answers the cached calibration level.
    pub fn load_saved(&mut self, saves: &Saves) -> Option<ScoreLevel> {
        self.saved = saves.load(SETTINGS_FILE).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_else(|| json!({}));
        let entry = self.saved["devices"][self.device_key()].clone();
        self.person = person_from(&entry);
        self.person_dirty = false;
        self.generation += 1;
        self.resolve();
        entry["calibration"].as_u64().and_then(|level| u8::try_from(level).ok()).map(ScoreLevel::new)
    }

    /// Keep `level` as this device's calibration hint in the save file (written by
    /// [`RenderControl::save`]).
    pub fn remember_calibration(&mut self, level: ScoreLevel) {
        self.entry_mut().insert("calibration".to_owned(), json!(level.get()));
        self.person_dirty = true;
    }

    fn entry_mut(&mut self) -> &mut JsonMap<String, Value> {
        let key = self.device_key();
        let devices = object_at(object_at(&mut self.saved).entry("devices").or_insert(Value::Null));
        object_at(devices.entry(key).or_insert(Value::Null))
    }

    /// Write the person's choice and the calibration hint to `saves` when they changed; answers
    /// whether a write happened (and succeeded).
    pub fn save(&mut self, saves: &Saves) -> bool {
        if !std::mem::take(&mut self.person_dirty) {
            return false;
        }
        let person = person_value(&self.person);
        let entry = self.entry_mut();
        for key in ["preset", "renderScale", "features", PERSON_LOD_THRESHOLD_KEY, PERSON_UPSCALE_KEY, PERSON_FPS_KEY, PERSON_DYNAMIC_KEY] {
            entry.remove(key);
        }
        if let Value::Object(person) = person {
            entry.extend(person);
        }
        saves.save(SETTINGS_FILE, self.saved.to_string().as_bytes())
    }
}

/// `value` as an object, replacing anything else with an empty one.
fn object_at(value: &mut Value) -> &mut JsonMap<String, Value> {
    if !value.is_object() {
        *value = Value::Object(JsonMap::new());
    }
    value.as_object_mut().expect("made an object above")
}

/// The person's layer as the save file's entry members.
fn person_value(person: &ClassOverride) -> Value {
    let mut value = JsonMap::new();
    if let Some(preset) = person.preset {
        value.insert("preset".to_owned(), json!(preset.wire()));
    }
    if let Some(scale) = person.render_scale {
        value.insert("renderScale".to_owned(), json!(scale));
    }
    if !person.switches.is_empty() {
        let features: JsonMap<String, Value> = person.switches.iter().map(|(feature, on)| (feature.wire().to_owned(), json!(on))).collect();
        value.insert("features".to_owned(), Value::Object(features));
    }
    if let Some(pixels) = person.lod.threshold_px {
        value.insert(PERSON_LOD_THRESHOLD_KEY.to_owned(), json!(pixels));
    }
    if let Some(mode) = person.upscale {
        value.insert(PERSON_UPSCALE_KEY.to_owned(), json!(mode.wire()));
    }
    if let Some(fps) = person.fps {
        value.insert(PERSON_FPS_KEY.to_owned(), json!(fps));
    }
    if let Some(on) = person.dynamic_resolution {
        value.insert(PERSON_DYNAMIC_KEY.to_owned(), json!(on));
    }
    Value::Object(value)
}

/// The person's layer from a save entry; unknown values are left out.
fn person_from(entry: &Value) -> ClassOverride {
    let switches = entry["features"]
        .as_object()
        .map(|features| {
            features.iter().filter_map(|(name, on)| Some((RenderFeature::from_wire(name)?, on.as_bool()?))).collect()
        })
        .unwrap_or_default();
    ClassOverride {
        preset: entry["preset"].as_str().and_then(QualityPreset::from_wire),
        render_scale: entry["renderScale"].as_f64().map(|scale| (scale as f32).clamp(genex_render::settings::RENDER_SCALE_MIN, 1.0)),
        fps: entry[PERSON_FPS_KEY].as_u64().and_then(|fps| u32::try_from(fps).ok()).filter(|fps| FRAME_RATE_TARGETS.contains(fps)),
        switches,
        lod: person_lod(entry),
        upscale: entry[PERSON_UPSCALE_KEY].as_str().and_then(UpscaleMode::from_wire),
        dynamic_resolution: entry[PERSON_DYNAMIC_KEY].as_bool(),
        ..ClassOverride::default()
    }
}

/// The save entry's members holding the person's upscaling mode, frame-rate target and dynamic
/// resolution switch (lane UQ).
const PERSON_UPSCALE_KEY: &str = "upscale";
const PERSON_FPS_KEY: &str = "fps";
const PERSON_DYNAMIC_KEY: &str = "dynamicResolution";

/// The save entry's member holding the person's LOD threshold ("Detail distance").
const PERSON_LOD_THRESHOLD_KEY: &str = "lodThresholdPx";

/// The person's LOD choice from a save entry: the threshold the panel's "Detail distance" set
/// (held to its range and the preset's when applied).
fn person_lod(entry: &Value) -> LodConfig {
    match entry[PERSON_LOD_THRESHOLD_KEY].as_f64() {
        Some(pixels) => LodConfig::new().threshold_px(pixels as f32),
        None => LodConfig::new(),
    }
}

thread_local! {
    /// The settings the UI hooks of the running tick reach ([`settings_panel`]).
    static PANEL: RefCell<Option<RenderHandle>> = const { RefCell::new(None) };
}

/// While alive, [`settings_panel`] reaches `handle` (the runtime holds one around its UI hooks).
pub(crate) struct PanelScope {
    previous: Option<RenderHandle>,
}

impl PanelScope {
    /// Let the UI hooks of this tick reach `handle`.
    pub(crate) fn enter(handle: &RenderHandle) -> PanelScope {
        let previous = PANEL.with_borrow_mut(|slot| slot.replace(Rc::clone(handle)));
        PanelScope { previous }
    }
}

impl Drop for PanelScope {
    fn drop(&mut self) {
        let previous = self.previous.take();
        PANEL.with_borrow_mut(|slot| *slot = previous);
    }
}

/// The panel's preset menu index of the person's choice (0: automatic; past the presets, Max).
fn panel_index(person: &ClassOverride, shown: &PanelShown) -> usize {
    if shown.max && is_max(person) {
        return shown.presets.len() + 1;
    }
    person.preset.and_then(|preset| shown.presets.iter().position(|known| *known == preset)).map_or(0, |index| index + 1)
}

/// Whether the person's layer is the panel's Max: ultra drawn natively.
fn is_max(person: &ClassOverride) -> bool {
    person.preset == Some(QualityPreset::Ultra) && person.upscale == Some(UpscaleMode::Native)
}

/// A menu index past the panel's Auto entry as a choice from `choices` (0: automatic, None).
fn chosen_after_auto<T: Copy>(index: usize, choices: &[T]) -> Option<T> {
    index.checked_sub(1).and_then(|index| choices.get(index).copied())
}

/// The menu index of `chosen` among `choices`, past the Auto entry (0: automatic).
fn index_after_auto<T: PartialEq>(chosen: Option<T>, choices: &[T]) -> usize {
    chosen.and_then(|chosen| choices.iter().position(|known| *known == chosen)).map_or(0, |index| index + 1)
}

/// What the panel showed: the presets it offered (after Auto; Max after them when `max`) and its
/// feature switches.
struct PanelShown {
    presets: Vec<QualityPreset>,
    max: bool,
    features: Vec<(RenderFeature, bool)>,
    /// The LOD threshold of the preset in force, before the person's "Detail distance".
    preset_threshold: f32,
}

/// The "Detail distance" row's range: half to twice the preset's (the threshold's
/// [`genex_render::presets::LOD_THRESHOLD_SCALE_MIN`]..=`MAX`, inverted: more detail is a finer threshold).
const DETAIL_RANGE: (f32, f32) = (genex_render::presets::LOD_THRESHOLD_SCALE_MIN, genex_render::presets::LOD_THRESHOLD_SCALE_MAX);

/// The "Detail distance" a threshold of `threshold` px shows against the preset's `preset` px.
fn detail_of(preset: f32, threshold: f32) -> f32 {
    if threshold > 0.0 { (preset / threshold).clamp(DETAIL_RANGE.0, DETAIL_RANGE.1) } else { 1.0 }
}

/// The threshold a "Detail distance" of `detail` asks for against the preset's `preset` px.
fn threshold_for_detail(preset: f32, detail: f32) -> f32 {
    preset / detail.clamp(DETAIL_RANGE.0, DETAIL_RANGE.1)
}

/// The person's layer after one panel change, against what the panel showed.
fn person_after(control: &RenderControl, change: genex_hud::PanelChange, shown: &PanelShown) -> ClassOverride {
    let mut person = control.person.clone();
    match change {
        genex_hud::PanelChange::Preset(index) => {
            let max = shown.max && index == shown.presets.len() + 1;
            if max {
                person.preset = Some(QualityPreset::Ultra);
                person.upscale = Some(UpscaleMode::Native);
            } else {
                person.preset = chosen_after_auto(index, &shown.presets);
                // Leaving Max leaves its native rendering too.
                if is_max(&control.person) {
                    person.upscale = None;
                }
            }
            // A new preset brings its own switches and threshold; the person's earlier ones would mask it.
            person.switches.clear();
            person.lod = LodConfig::new();
        }
        genex_hud::PanelChange::Upscale(index) => person.upscale = chosen_after_auto(index, &UpscaleMode::ALL),
        genex_hud::PanelChange::FrameRate(index) => person.fps = chosen_after_auto(index, &FRAME_RATE_TARGETS),
        genex_hud::PanelChange::DynamicResolution(on) => person.dynamic_resolution = Some(on),
        genex_hud::PanelChange::Detail(detail) => person.lod = person.lod.threshold_px(threshold_for_detail(shown.preset_threshold, detail)),
        genex_hud::PanelChange::RenderScale(scale) => person.render_scale = Some(quantized(scale)),
        genex_hud::PanelChange::Feature(index, on) => {
            if let Some((feature, _)) = shown.features.get(index) {
                push_switch(&mut person.switches, (*feature, on));
            }
        }
        genex_hud::PanelChange::Reset => person = ClassOverride::default(),
    }
    person
}

/// The button that opens a game's settings: a drawn gear and `label` (checks find the button by
/// it), a large tap target (the HUD's fonts have no emoji, so a gear glyph would draw a box).
/// `clicked()` toggles the panel.
///
/// ```
/// # use genex::prelude::*;
/// # #[derive(Default)] struct World { menu: bool }
/// # let mut game = Game::new(World::default());
/// game.on_ui(|sim, ui, _| {
///     if genex::render::settings_button(ui, "Settings").clicked() {
///         sim.world.menu = !sim.world.menu;
///     }
/// });
/// ```
pub fn settings_button(ui: &mut egui::Ui, label: &str) -> egui::Response {
    genex_hud::settings_button(ui, label)
}

/// The in-game graphics settings panel, for a game's `on_ui` hook: the quality preset (Max is ultra
/// drawn natively), the upscaling mode (hidden while the game holds one), the frame-rate target,
/// dynamic resolution, the render scale, a switch per feature and the device class detected. A change is the person's choice on
/// this device: saved in the game's saves, never in the simulation, so it never moves the state
/// checksum. Answers whether the person changed anything this tick (false outside a UI hook).
///
/// ```
/// # use genex::prelude::*;
/// # #[derive(Default)] struct World { menu: bool }
/// # let mut game = Game::new(World::default());
/// game.on_ui(|sim, ui, _| {
///     if sim.world.menu {
///         genex::render::settings_panel(ui);
///     }
/// });
/// ```
pub fn settings_panel(ui: &mut egui::Ui) -> bool {
    let Some(handle) = PANEL.with_borrow(Clone::clone) else { return false };
    let mut control = handle.borrow_mut();
    let answer = control.answer();
    // Only switches that change the picture in this build are offered (the others arrive with their
    // tier); texture quality is the game's and the device's (the session's arrays), never the panel's.
    let offered = |feature: RenderFeature| feature_landed(feature) && feature != RenderFeature::TextureQuality;
    let features: Vec<(RenderFeature, bool)> = answer.features.iter().copied().filter(|(feature, _)| offered(*feature)).collect();
    let labels: Vec<(&str, bool)> = features.iter().map(|(feature, on)| (feature_label(*feature), *on)).collect();
    let class = DeviceClass::wire(answer.device_class);
    let detected = DeviceClass::wire(answer.detected_class);
    let defaults = class_defaults(answer.device_class);
    let offered = control.panel_offered();
    // Max is ultra drawn natively: offered with ultra, unless the game holds the upscaling mode.
    let held = control.upscale_held();
    let max = offered.contains(&QualityPreset::Ultra) && !held;
    let presets = panel_presets(answer.preset, control.person.preset, &offered, max);
    let calibrated = calibrated_mode(answer.device_class, control.facts.os, control.live_window());
    let upscales = panel_upscales(calibrated, control.person.upscale);
    let upscale_index = index_after_auto(control.person.upscale, &UpscaleMode::ALL);
    let rates = panel_frame_rates(control.live.profile.target_fps, control.person.fps);
    let rate_index = index_after_auto(control.person.fps, &FRAME_RATE_TARGETS);
    let preset_threshold = preset_quality(answer.preset, answer.device_class).lod.threshold_px;
    let shown = PanelShown { presets: offered, max, features, preset_threshold };
    let panel = genex_hud::SettingsPanel {
        presets: &presets,
        preset: panel_index(&control.person, &shown),
        upscale: (!held).then_some((upscales.as_slice(), upscale_index)),
        frame_rate: Some((rates.as_slice(), rate_index)),
        dynamic_resolution: Some(control.dynamic_resolution(answer.device_class)),
        render_scale: control.live.quality.render_scale,
        scale_range: (genex_render::settings::RENDER_SCALE_MIN, defaults.drs_range.1.max(1.0)),
        features: &labels,
        detected: &detected,
        emulated: (answer.device_class != answer.detected_class).then_some(class.as_str()),
        detail: Some((detail_of(preset_threshold, control.live.quality.lod.threshold_px), DETAIL_RANGE)),
    };
    let changes = genex_hud::settings_panel(ui, &panel);
    for change in &changes {
        let person = person_after(&control, *change, &shown);
        control.set_person(person);
    }
    !changes.is_empty()
}

/// Hold Live frames at upscaling `mode` while the game needs it (lane UQ): a photo mode drawing
/// every pixel natively calls `genex::render::lock_upscale(Some(UpscaleMode::Native))` from `on_ui`
/// while it is open and `lock_upscale(None)` after, which gives the person's choice back. Calling it
/// every tick is fine (an unchanged hold does nothing), and a change rebuilds nothing: the next
/// frame renders at the mode's scale. Outside a UI hook it does nothing; it is never saved and
/// never reaches the simulation.
///
/// ```
/// # use genex::prelude::*;
/// # use genex::render::UpscaleMode;
/// # #[derive(Default)] struct World { photo: bool }
/// # let mut game = Game::new(World::default());
/// game.on_ui(|sim, _ui, _| {
///     genex::render::lock_upscale(sim.world.photo.then_some(UpscaleMode::Native));
/// });
/// ```
pub fn lock_upscale(mode: Option<UpscaleMode>) {
    let Some(handle) = PANEL.with_borrow(Clone::clone) else { return };
    handle.borrow_mut().lock_upscale(mode);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fragment_with_only_render_tables_reads_as_the_game_layer() {
        let config = RenderConfig::from_toml("[render]\npreset = \"low\"\n[render.class.mobile-mid]\nrender_scale = 0.6\nbloom = false\n")
            .expect("a fragment");
        assert_eq!(config.quality.preset, Some(QualityPreset::Low));
        let mobile = DeviceClass::from_wire("mobile-mid").expect("class");
        let table = config.quality.class(mobile).expect("the class table");
        assert_eq!(table.render_scale, Some(0.6));
        assert_eq!(table.switches, vec![(RenderFeature::Bloom, false)]);
        let error = RenderConfig::from_toml("[render]\npreset = \"epic\"\n").expect_err("an unknown preset");
        assert_eq!(error.code().as_str(), "invalid-render-preset");
    }

    /// Game systems LOD-06 (new behaviour): a class table's LOD keys and switches reach its
    /// override, `lod_at` merges into a class's table key by key, and the person's "Detail
    /// distance" survives the save file and maps to a threshold against the preset's.
    #[test]
    fn the_lod_keys_lod_at_and_the_detail_distance_reach_the_quality() {
        let toml = "[render.class.mobile-mid]\nlod_threshold_px = 3\nlod_fade_band = 0.1\nfar_density = 0.2\nimpostors = false\n";
        let config = RenderConfig::from_toml(toml).expect("a fragment");
        let mid = DeviceClass::from_wire("mobile-mid").expect("class");
        let table = config.quality.class(mid).expect("the class table");
        assert_eq!(table.lod, LodConfig::new().threshold_px(3.0).fade_band(0.1).far_density(0.2));
        assert_eq!(table.switches, vec![(RenderFeature::Impostors, false)]);
        let refused = RenderConfig::from_toml("[render.class.mobile-mid]\nfar_density = 2\n").expect_err("out of range");
        assert_eq!(refused.code().as_str(), "invalid-render-lod");
        let merged = config.lod_at(mid, LodConfig::new().threshold_px(4.0)).lod_at(REFERENCE_CLASS, LodConfig::new().fade_band(0.0));
        assert_eq!(merged.quality.class(mid).expect("kept").lod, LodConfig::new().threshold_px(4.0).fade_band(0.1).far_density(0.2));
        assert_eq!(merged.quality.class(mid).expect("kept").switches, vec![(RenderFeature::Impostors, false)], "the rest of the table stays");
        assert_eq!(merged.quality.class(REFERENCE_CLASS).expect("added").lod, LodConfig::new().fade_band(0.0));
        let person = ClassOverride { lod: LodConfig::new().threshold_px(0.75), ..ClassOverride::default() };
        assert_eq!(person_from(&person_value(&person)), person, "the threshold survives the save file");
        assert_eq!(detail_of(1.0, 0.5), 2.0, "half the preset's threshold is twice the detail distance");
        assert_eq!(threshold_for_detail(2.5, 0.5), 5.0);
        assert_eq!(threshold_for_detail(1.0, 9.0), 0.5, "held to the row's range");
        assert_eq!(feature_label(RenderFeature::LodFade), "Detail crossfade");
        assert_eq!(feature_label(RenderFeature::Impostors), "Impostors");
    }

    #[test]
    fn the_look_tables_bloom_fog_ao_and_contact_shadow_keys_reach_the_look() {
        let toml = "[render.look]\nbloom_intensity = 0.1\nbloom_threshold = 1.5\nbloom_radius = 2.0\nao_intensity = 0.5\nao_radius = 1.25\n\
                    fog_density = 0.02\nfog_height_falloff = 0.5\nfog_base_height = 1.0\nfog_start = 4.0\nfog_max_opacity = 0.8\n\
                    fog_color = [0.9, 0.8, 0.7]\nfog_aerial_perspective = false\ncontact_shadow_length = 0.5\n";
        let look = RenderConfig::from_toml(toml).expect("a fragment").look;
        assert_eq!((look.bloom_intensity, look.bloom_threshold, look.bloom_radius), (0.1, 1.5, 2.0));
        assert_eq!((look.ao_intensity, look.ao_radius, look.contact_shadow_length), (0.5, 1.25, 0.5));
        let fog = Fog::default()
            .with_density(0.02)
            .with_height(0.5, 1.0)
            .with_range(4.0, 0.8)
            .with_color([0.9, 0.8, 0.7])
            .with_aerial_perspective(false);
        assert_eq!(look.fog, fog, "every fog key of [render.look] reaches the look");
        let untouched = RenderConfig::from_toml("[render.look]\ntonemapper = \"agx\"\n").expect("a fragment").look;
        assert_eq!((untouched.fog, untouched.bloom_radius), (Look::default().fog, Look::default().bloom_radius), "a key left out keeps the default");
    }

    #[test]
    fn the_config_sets_the_fog_and_the_bloom_held_to_their_limits() {
        let fog = Fog::default().with_density(0.03).with_height(0.4, -2.0);
        let config = RenderConfig::new().fog(fog).bloom(Bloom::new(0.08).threshold(2.0).radius(1.5));
        assert_eq!(config.look.fog, fog);
        assert_eq!((config.look.bloom_intensity, config.look.bloom_threshold, config.look.bloom_radius), (0.08, 2.0, 1.5));
        assert_eq!(Bloom::of(&config.look), Bloom::new(0.08).threshold(2.0).radius(1.5));
        let wild = RenderConfig::new().bloom(Bloom::new(7.0).threshold(-1.0).radius(100.0)).look;
        assert_eq!((wild.bloom_intensity, wild.bloom_threshold, wild.bloom_radius), (1.0, 0.0, genex_render::settings::BLOOM_RADIUS_MAX));
        assert_eq!(RenderConfig::new().bloom(Bloom::off()).look.bloom_intensity, 0.0, "a look without bloom");
    }

    #[test]
    fn web_hints_read_their_members_and_a_desktop_browser_classifies_as_desktop() {
        let desktop = json!({"maxTouchPoints": 0, "coarsePointer": false, "shortSideCssPx": 1080, "deviceMemoryGb": 8, "uaMobile": false});
        let desktop = web_hints_from_json(&desktop).expect("hints");
        assert!(!desktop.is_mobile());
        assert_eq!(desktop.device_memory_gb(), 8.0);
        let ipad = web_hints_from_json(&json!({"maxTouchPoints": 5, "coarsePointer": true, "shortSideCssPx": 1024})).expect("hints");
        assert!(ipad.is_mobile(), "iPadOS reports a desktop user agent; touch with a coarse pointer is a tablet");
        let facts = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other);
        assert_eq!(classify(&facts.clone().with_web(desktop)).form, FormFactor::Desktop);
        assert_eq!(web_hints_from_json(&json!("nonsense")), None);
        assert_eq!(classify(&facts).form, FormFactor::Mobile, "a page that sends no hints reads as a phone");
    }

    #[test]
    fn without_timestamps_missed_vsyncs_drop_the_scale_and_pauses_do_not() {
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let fresh = || {
            let mut control = RenderControl::new(RenderConfig::new(), (960, 540));
            control.probe(facts.clone(), None);
            control
        };
        let mut paused = fresh();
        let nominal = paused.live_frame().scale;
        for frame in 0..40u64 {
            paused.observe(Some(1.0), None, 2_000.0, Duration::from_secs(frame * 2));
        }
        assert_eq!(paused.live_frame().scale, nominal, "seconds between verb-drawn frames are pauses");
        let mut missing = fresh();
        for frame in 0..40u64 {
            missing.observe(Some(1.0), None, 40.0, Duration::from_millis(frame * 40));
        }
        assert!(missing.live_frame().scale < nominal, "missed vsyncs drop the scale");
    }

    #[test]
    fn a_cpu_bound_frame_s_gpu_span_never_drops_the_scale_and_a_gpu_bound_one_does() {
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let fresh = || {
            let mut control = RenderControl::new(RenderConfig::new(), (960, 540));
            control.probe(facts.clone(), None);
            control.apply(&RenderChange { device_class: Some(Some(DeviceClass::new(FormFactor::Desktop, PerformanceTier::Low))), ..RenderChange::default() });
            control
        };
        // A weak laptop whose CPU takes 20 ms to encode a frame: the GPU idles between submissions
        // and the span reads 20 ms although the GPU worked 4.
        let mut cpu_bound = fresh();
        let nominal = cpu_bound.live_frame().scale;
        for frame in 0..120u64 {
            cpu_bound.observe(Some(20.0), Some(&[20.0]), 20.0, Duration::from_millis(frame * 20));
        }
        assert_eq!(cpu_bound.live_frame().scale, nominal, "a lower resolution cannot help a CPU-bound frame");
        assert_eq!(cpu_bound.last_gpu_ms(), Some(20.0), "the span is still reported");
        let mut gpu_bound = fresh();
        for frame in 0..120u64 {
            gpu_bound.observe(Some(2.0), Some(&[20.0]), 20.0, Duration::from_millis(frame * 20));
        }
        assert!(gpu_bound.live_frame().scale < nominal, "a GPU-bound frame drops the scale");
    }

    #[test]
    fn the_verb_s_frame_budget_is_what_dynamic_resolution_holds_and_null_gives_the_class_s_back() {
        // Pass-1 gate round 3: on the M4 Max no Live frame came near the class's 16.7 ms, so the
        // scale never left 1.0 and Live could not show dynamic resolution reacting. A budget the
        // verb holds (this session only) makes the same GPU frames over budget.
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let mut control = RenderControl::new(RenderConfig::new(), (960, 540));
        control.probe(facts, None);
        let (nominal, class_target) = (control.live_frame().scale, control.gpu_target_ms());
        let frames = |control: &mut RenderControl, from: u64| {
            for frame in from..from + 120 {
                control.observe(Some(1.0), Some(&[6.0]), 16.7, Duration::from_millis(frame * 17));
            }
        };
        frames(&mut control, 0);
        assert_eq!(control.live_frame().scale, nominal, "6 ms frames sit well inside the class's {class_target} ms");
        let held = control.apply(&RenderChange { frame_budget_ms: Some(Some(4.0)), ..RenderChange::default() });
        assert_eq!(held.frame_budget_ms, Some(4.0), "the answer names the budget the verb holds");
        assert!(control.gpu_target_ms() <= 4.0, "the controller holds the verb's budget: {}", control.gpu_target_ms());
        frames(&mut control, 200);
        assert!(control.live_frame().scale < nominal, "the same frames over a 4 ms budget step the scale down");
        let released = control.apply(&RenderChange { frame_budget_ms: Some(None), ..RenderChange::default() });
        assert_eq!(released.frame_budget_ms, None);
        assert_eq!(control.gpu_target_ms(), class_target, "null gives the class's budget back");
        frames(&mut control, 400);
        assert_eq!(control.live_frame().scale, nominal, "and the scale back");
        let wild = control.apply(&RenderChange { frame_budget_ms: Some(Some(0.01)), ..RenderChange::default() });
        assert_eq!(wild.frame_budget_ms, Some(FRAME_BUDGET_MS_MIN), "a budget outside the wire's range is held to it");
    }

    /// Feed `control` `frames` Live frames from `first` on, each encoded in `cpu_ms` and costing the
    /// GPU `gpu_at(scale)` at the scale it was drawn at (a pixel-proportional load model).
    fn modelled_frames(control: &mut RenderControl, first: u64, frames: u64, cpu_ms: f32, gpu_at: impl Fn(f32) -> f32) {
        for frame in first..first + frames {
            let gpu = gpu_at(control.live_frame().scale);
            control.observe(Some(cpu_ms), Some(&[gpu]), 16.7, Duration::from_micros(16_700 * frame));
        }
    }

    #[test]
    fn under_the_verb_s_budget_the_scale_steps_down_and_back_up_at_medium_high_and_ultra() {
        // Pass-1 gate live finding 3: under `frameBudgetMs` 1-3 ms the lakeside's scale stayed 1.0
        // at medium, high and ultra (GPU 2.2-6.7 ms) and moved only at low. Their frames encode in
        // 1.4-1.6 ms on the CPU, over a 1 ms budget's 0.85 ms GPU target, and every frame whose
        // CPU time was over that target read as CPU-bound, so no GPU time ever reached DRS. A GPU
        // span well over the CPU time is the GPU's, whatever the budget.
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
            let mut control = RenderControl::new(RenderConfig::new(), (1512, 982));
            control.probe(facts.clone(), None);
            // The live readings below were taken at scale 1: Native, the person's choice (lane UQ:
            // the calibrated default renders Quality's share, where these frames are CPU-bound).
            control.set_person(ClassOverride { upscale: Some(UpscaleMode::Native), ..ClassOverride::default() });
            control.apply(&RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), frame_budget_ms: Some(Some(1.0)), ..RenderChange::default() });
            let nominal = control.live_frame().scale;
            // The live readings at a 1 ms budget: GPU 2.2-3.1 ms at scale 1, CPU 1.4-1.6 ms.
            modelled_frames(&mut control, 0, 60, 1.6, |scale| 0.2 + 2.8 * scale * scale);
            let stepped = control.live_frame().scale;
            assert!(stepped < nominal, "{preset:?}: frames over a 1 ms budget step the scale down (scale {stepped})");
            // The game's load falls: GPU frames well under the budget raise it back, step by step.
            modelled_frames(&mut control, 60, 600, 1.6, |scale| 0.1 + 0.3 * scale * scale);
            assert_eq!(control.live_frame().scale, nominal, "{preset:?}: frames under the budget give the scale back");
        }
    }

    #[test]
    fn dynamic_resolution_holds_the_gpu_target_under_a_synthetic_load_within_sixty_frames() {
        // The decision behind the Metal row of the same name, on injected frame times: a load of
        // 1.6x the class's GPU target at scale 1 (a pixel-proportional part and the output-size
        // passes) is under the target within 60 frames. The Metal row proves the timestamps reach
        // this decision; the machine's load cannot move this one.
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let mut control = RenderControl::new(RenderConfig::new(), (1920, 1080));
        control.probe(facts, None);
        let target = control.gpu_target_ms();
        let fixed = 0.6;
        let load = |scale: f32| fixed + (1.6 * target - fixed) * scale * scale;
        modelled_frames(&mut control, 0, 60, 1.0, load);
        let scale = control.live_frame().scale;
        assert!(scale < 1.0, "the scale dropped");
        assert!(load(scale) <= target * 1.1, "frame GPU time {:.2} ms within 10% of the {target:.2} ms target at scale {scale}", load(scale));
        modelled_frames(&mut control, 60, 600, 1.0, load);
        assert_eq!(control.live_frame().scale, scale, "a held load holds the step (no flapping)");
    }

    /// The features `control` draws with the person's preset at `preset`.
    fn drawn_at(control: &mut RenderControl, preset: QualityPreset) -> Vec<RenderFeature> {
        control.set_person(ClassOverride { preset: Some(preset), ..ClassOverride::default() });
        control.answer().features.into_iter().filter(|(_, on)| *on).map(|(feature, _)| feature).collect()
    }

    #[test]
    fn the_panel_never_offers_a_preset_that_draws_less_than_the_one_below_it() {
        // Pass-1 gate round 3: on a desktop-mid browser the memory budget dropped ultra's AO and
        // spot shadows (with its shadow size and format and bloom mips), so the panel's Ultra drew
        // less than High. Bodycam B1 moved the premise from an 8 GB browser to one hiding
        // deviceMemory: either is 256 MB now that a desktop browser takes 64 MB a GB.
        let hints = json!({"maxTouchPoints": 0, "coarsePointer": false, "shortSideCssPx": 1080, "uaMobile": false});
        let web = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other)
            .with_web(web_hints_from_json(&hints).expect("hints"));
        let mut browser = RenderControl::new(RenderConfig::new(), (1280, 720));
        browser.probe(web, None);
        let (high, ultra) = (drawn_at(&mut browser, QualityPreset::High), drawn_at(&mut browser, QualityPreset::Ultra));
        assert!(high.contains(&RenderFeature::Ao) && !ultra.contains(&RenderFeature::Ao), "the premise: the budget drops ultra's AO");
        browser.set_person(ClassOverride::default());
        assert_eq!(browser.panel_offered(), [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High]);
        browser.set_person(ClassOverride { preset: Some(QualityPreset::Ultra), ..ClassOverride::default() });
        assert!(browser.panel_offered().contains(&QualityPreset::Ultra), "a saved choice stays shown, so the panel can name it");
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let mut mac = RenderControl::new(RenderConfig::new(), (1280, 720));
        mac.probe(facts, None);
        let drawn: Vec<Vec<RenderFeature>> = QualityPreset::ALL.iter().map(|preset| drawn_at(&mut mac, *preset)).collect();
        assert!(drawn.windows(2).all(|pair| pair[0].iter().all(|feature| pair[1].contains(feature))), "the premise: {drawn:?}");
        mac.set_person(ClassOverride::default());
        assert_eq!(mac.panel_offered(), QualityPreset::ALL.to_vec(), "a device that holds every preset is offered all four");
    }

    #[test]
    fn a_preset_the_panel_offers_draws_every_feature_of_each_offered_one_below_it() {
        // Pass-1 gate round 3 integrator: on a Retina MacBook Pro's full-screen output (3024 x
        // 1964) the budget drops AO at high and at ultra, but medium keeps it. Ultra was offered
        // because it kept everything high drew, though high was not offered and ultra drew less
        // than medium, the preset beside it in the panel.
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let mut mac = RenderControl::new(RenderConfig::new(), (3024, 1964));
        mac.probe(facts, None);
        let (medium, ultra) = (drawn_at(&mut mac, QualityPreset::Medium), drawn_at(&mut mac, QualityPreset::Ultra));
        assert!(medium.contains(&RenderFeature::Ao) && !ultra.contains(&RenderFeature::Ao), "the premise: the budget drops ultra's AO");
        mac.set_person(ClassOverride::default());
        let offered = mac.panel_offered();
        let drawn: Vec<Vec<RenderFeature>> = offered.iter().map(|preset| drawn_at(&mut mac, *preset)).collect();
        for (at, features) in drawn.iter().enumerate().skip(1) {
            let poorer: Vec<_> = drawn[..at].iter().flatten().filter(|feature| !features.contains(feature)).collect();
            assert!(poorer.is_empty(), "{:?} is offered above {:?} but draws none of {poorer:?}", offered[at], &offered[..at]);
        }
        assert_eq!(offered, [QualityPreset::Low, QualityPreset::Medium]);
    }

    /// GA round 2 (live-app finding 2): Web Live booted at the world size, where medium's MSAA fit
    /// the browser's budget; the canvas then reported its 2000x1226 output, the refit dropped MSAA
    /// (`budget: msaa`), but the world pass kept the 4 samples its first frame was built with
    /// (`pipeline-change-deferred: anti-aliasing`) until a settings change, while dynamic resolution
    /// sat at its floor. A new output whose fitted quality draws another sample count is a
    /// pipeline change; one that keeps it is not.
    #[test]
    fn a_new_live_output_whose_budget_changes_the_world_pass_samples_is_a_pipeline_change() {
        // A browser hiding deviceMemory: the 256 MB an 8 GB one had before Bodycam B1.
        let hints = json!({"maxTouchPoints": 0, "coarsePointer": false, "shortSideCssPx": 1080, "uaMobile": false});
        let web = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other)
            .with_web(web_hints_from_json(&hints).expect("hints"));
        let mut browser = RenderControl::new(RenderConfig::new(), (960, 540));
        browser.probe(web, None);
        let samples = |control: &RenderControl| genex_render::renderer::landed_samples(control.live_asked().quality.anti_aliasing);
        let (before, generation) = (samples(&browser), browser.pipeline_generation());
        browser.set_live_output((2000, 1226), None);
        assert_ne!(samples(&browser), before, "the premise: the budget at the canvas's output draws another sample count");
        assert!(browser.pipeline_generation() > generation, "the world pass is rebuilt for the samples the budget left");
        let generation = browser.pipeline_generation();
        browser.set_live_output((2004, 1228), None);
        assert_eq!(browser.pipeline_generation(), generation, "an output that keeps the samples rebuilds nothing");
    }

    /// A Mac probed with `memory` bytes of GPU-visible memory (None: the platform did not say),
    /// drawing a world target of `output`.
    fn mac_with_memory(output: (u32, u32), memory: Option<u64>) -> RenderControl {
        let facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu)
            .with_vendor(genex_render::device_class::APPLE_VENDOR_ID, 0)
            .with_gpu_visible_memory(memory);
        let mut mac = RenderControl::new(RenderConfig::new(), output);
        mac.probe(facts, None);
        mac
    }

    /// One GiB.
    const GIB: u64 = 1024 * 1024 * 1024;
    /// What Metal recommends on a 36 GB M-series Mac (about three quarters of it).
    const LARGE_MAC_MEMORY: u64 = 27 * GIB;
    /// What Metal recommends on an 8 GB MacBook Air (two thirds of it).
    const SMALL_MAC_MEMORY: u64 = 8 * GIB / 3 * 2;
    /// The ledger and probe rows' output sizes: 720p, 1080p, a 1440p monitor and a 14" MacBook
    /// Pro's Retina full screen.
    const MAC_OUTPUTS: [(u32, u32); 4] = [(1280, 720), (1920, 1080), (2560, 1440), (3024, 1964)];

    #[test]
    fn a_large_memory_mac_keeps_ao_at_high_on_its_retina_full_screen_and_is_offered_all_four_presets() {
        // Pass-1 gate (perf-platform 4, owner decision 2026-10-12 (2)): desktop-high's fixed 512 MB
        // dropped AO at high and ultra on a 3024 x 1964 output, so the panel offered only low and
        // medium on a 36 GB Mac. Its budget now scales with the GPU-visible memory.
        let mut mac = mac_with_memory((3024, 1964), Some(LARGE_MAC_MEMORY));
        assert_eq!(mac.detected_class().wire(), "desktop-high");
        for preset in [QualityPreset::High, QualityPreset::Ultra] {
            assert!(drawn_at(&mut mac, preset).contains(&RenderFeature::Ao), "{preset:?} keeps AO");
            let degraded: Vec<_> = mac.status().degraded.into_iter().filter(|degrade| degrade.reason == DegradeReason::Budget).collect();
            assert!(degraded.is_empty(), "{preset:?} steps nothing down for the budget: {degraded:?}");
        }
        mac.set_person(ClassOverride::default());
        assert_eq!(mac.panel_offered(), QualityPreset::ALL.to_vec());
        assert_eq!(mac.live.profile.budget_bytes, 2 * GIB, "an eighth of 27 GB, at most 2 GiB");
    }

    /// Renderer pass 2, P2-0.9 step B (F1/RC-03): Live is fitted at the output it draws (the
    /// window's pixels, its window present's images counted) and captures at their own size, so a
    /// window never changes a capture's settings. A small Mac fits high at the 960x540 world without
    /// a step but not at a 3024x1964 Retina window, whose ledger is the larger one.
    #[test]
    fn live_is_fitted_at_the_window_s_output_and_captures_at_their_own_size() {
        let world = (960, 540);
        let mut mac = mac_with_memory(world, Some(SMALL_MAC_MEMORY));
        drawn_at(&mut mac, QualityPreset::High);
        let own = mac.live_is_own();
        let at = |mac: &RenderControl| ledger(&mac.live.quality, &mac.budget_for(&mac.live.profile, 1.0, &mac.facts, own, mac.live_surface()).0).total();
        let small = at(&mac);
        let capture = mac.capture_frame();
        assert_eq!(mac.live_output(), world, "Live draws the world size until a window is known");
        let retina = (3024, 1964);
        mac.set_live_output(retina, Some(retina));
        assert_eq!(mac.live_output(), retina);
        assert!(at(&mac) > small, "the ledger counts the window's output: {} vs {small}", at(&mac));
        assert_eq!(mac.capture_frame().0.quality, capture.0.quality, "a window never reaches a capture's settings");
        assert_eq!(mac.capture_output(), world, "captures draw at the world size");
        mac.set_capture_size(Some((3840, 2160)));
        assert_eq!(mac.capture_output(), (3840, 2160), "or at the size asked for");
        mac.set_capture_size(None);
        assert_eq!(mac.capture_output(), world);
    }

    /// G0 look (2026-10-14): captures at 2560x1440 and 3840x2160 were fitted to desktop-high's
    /// 512 MiB, so 4K high and ultra drew no AA, no AO and 768 shadow maps, and 1440p ultra drew
    /// less than high (AO off, 270-row bloom). A capture at either size draws its preset's own
    /// settings, the ones it draws at the world size, and ultra keeps everything high draws.
    #[test]
    fn captures_at_1440p_and_4k_draw_their_preset_s_own_settings_and_ultra_keeps_all_of_high() {
        let mut mac = mac_with_memory((1280, 720), Some(SMALL_MAC_MEMORY));
        let capture_at = |mac: &mut RenderControl, preset: QualityPreset, size: Option<(u32, u32)>| {
            mac.apply(&RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() });
            mac.set_capture_size(size);
            mac.capture_frame().0.quality
        };
        for size in [(2560, 1440), (3840, 2160)] {
            let mut drawn = Vec::new();
            for preset in [QualityPreset::High, QualityPreset::Ultra] {
                let reference = capture_at(&mut mac, preset, None);
                let quality = capture_at(&mut mac, preset, Some(size));
                assert!(quality.anti_aliasing.temporal(), "{preset:?} at {size:?} keeps TAA: {:?}", quality.anti_aliasing);
                assert_eq!(quality.ao.resolution, reference.ao.resolution, "{preset:?} at {size:?} keeps its AO");
                assert_eq!(quality.shadows, reference.shadows, "{preset:?} at {size:?} keeps its shadow maps");
                assert_eq!(quality.bloom, reference.bloom, "{preset:?} at {size:?} keeps its bloom");
                drawn.push(quality);
            }
            let (high, ultra) = (&drawn[0], &drawn[1]);
            assert!(ao_rank(ultra.ao.resolution) >= ao_rank(high.ao.resolution), "{size:?}: ultra's AO {:?} under high's {:?}", ultra.ao.resolution, high.ao.resolution);
            assert!(ultra.shadows.map_size >= high.shadows.map_size && ultra.bloom.resolution >= high.bloom.resolution, "{size:?}: ultra draws less than high");
        }
    }

    fn ao_rank(resolution: AoResolution) -> u8 {
        match resolution {
            AoResolution::Full => 2,
            AoResolution::Half => 1,
            _ => 0,
        }
    }

    /// The ledger and probe rows of a Mac at [`MAC_OUTPUTS`] with a large, a small and an unknown
    /// GPU-visible memory (printed for the evidence with `--nocapture`).
    #[test]
    fn the_mac_ledger_rows_at_each_output_with_large_small_and_unknown_memory() {
        for (label, memory) in [("large", Some(LARGE_MAC_MEMORY)), ("small", Some(SMALL_MAC_MEMORY)), ("unknown", None)] {
            for output in MAC_OUTPUTS {
                let mut mac = mac_with_memory(output, memory);
                let budget = mac.live.profile.budget_bytes;
                for preset in QualityPreset::ALL {
                    let features = drawn_at(&mut mac, preset);
                    let own = mac.live_is_own();
                    let total = ledger(&mac.live.quality, &mac.budget_for(&mac.live.profile, mac.live.quality.render_scale, &mac.facts, own, mac.live_surface()).0).total();
                    let rungs: Vec<_> = mac.live.budget_rungs.iter().map(|rung| rung.wire()).collect();
                    eprintln!(
                        "ROW memory={label} output={output:?} preset={} budget={} MiB ledger={} MiB ao={} degraded={rungs:?}",
                        preset.wire(),
                        budget / (1024 * 1024),
                        total / (1024 * 1024),
                        features.contains(&RenderFeature::Ao),
                    );
                    assert!(total <= budget, "{label} {output:?} {preset:?}: {total} over {budget}");
                    if label == "large" {
                        assert!(rungs.is_empty(), "{label} {output:?} {preset:?} steps nothing down: {rungs:?}");
                    }
                }
                mac.set_person(ClassOverride::default());
                let offered = mac.panel_offered();
                eprintln!("ROW memory={label} output={output:?} offered={offered:?}");
                if label == "large" {
                    assert_eq!(offered, QualityPreset::ALL.to_vec(), "{label} {output:?}");
                }
            }
        }
    }

    #[test]
    fn the_person_layer_round_trips_through_its_save_entry() {
        let person = ClassOverride {
            preset: Some(QualityPreset::Medium),
            render_scale: Some(0.75),
            fps: None,
            switches: vec![(RenderFeature::Shadows, false)],
            ..ClassOverride::default()
        };
        assert_eq!(person_from(&person_value(&person)), person);
        assert_eq!(person_from(&json!({"preset": "epic", "features": {"warp": true}})), ClassOverride::default());
        // Lane UQ: the upscaling mode, the frame-rate target and dynamic resolution are kept too, and
        // a value outside their vocabularies is no choice.
        let upscaled = ClassOverride { upscale: Some(UpscaleMode::Balanced), fps: Some(30), dynamic_resolution: Some(false), ..ClassOverride::default() };
        assert_eq!(person_from(&person_value(&upscaled)), upscaled);
        assert_eq!(person_value(&upscaled), json!({"upscale": "balanced", "fps": 30, "dynamicResolution": false}));
        assert_eq!(person_from(&json!({"upscale": "ultra-performance", "fps": 120, "dynamicResolution": "yes"})), ClassOverride::default());
    }

    /// A control probed as a Mac, then emulating `class` at `preset`.
    fn controlled(config: RenderConfig, class: &str, preset: QualityPreset) -> RenderControl {
        let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
        facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
        let mut control = RenderControl::new(config, (960, 540));
        control.probe(facts, None);
        control.apply(&RenderChange {
            device_class: Some(Some(DeviceClass::from_wire(class).expect("class"))),
            preset: Some(Some(PresetChoice::Preset(preset))),
            ..RenderChange::default()
        });
        control
    }

    /// Lanes UP and UQ: desktop-ultra on a Mac's 3456x2169 full screen draws Live at the window's
    /// own pixels and renders the calibrated Quality mode's share of them (0.6875 a side, within the
    /// class's 2560x1440 budget): dynamic resolution's every step is the class's step times the
    /// mode's share, never above it nor below the class floor, half-resolution AO past 1080p of
    /// render pixels, and a capture keeps its pinned scale. Flipped by lane UQ: the budget scale
    /// is now the Quality mode's (both 0.6875 at this panel), and a 1080p window, which rendered natively,
    /// renders Quality too (Native only when asked for).
    #[test]
    fn an_ultra_full_screen_renders_its_calibrated_mode_and_upscales_to_the_window() {
        let mut mac = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        let budget = genex_render::presets::render_pixel_budget(mac.live_class());
        assert_eq!(mac.live_output_cap_px(), 4 * budget, "the output may hold the window's own pixels");
        let full_screen = (3456, 2169);
        mac.set_live_output(full_screen, Some(full_screen));
        assert_eq!(mac.upscale(), Some((UpscaleMode::Quality, UpscaleSource::Calibrated)));
        assert_eq!(mac.upscale_scale(), 0.6875);
        let steps = mac.scale_steps().to_vec();
        assert_eq!(steps.last(), Some(&0.6875), "the top step is the mode's share: {steps:?}");
        assert!(steps.iter().all(|scale| *scale >= genex_render::settings::RENDER_SCALE_MIN), "{steps:?}");
        let frame = mac.live_asked();
        let (w, h) = step_size(full_screen, frame.scale);
        assert!(u64::from(w) * u64::from(h) <= budget, "renders {w}x{h}, within the budget");
        assert_eq!(frame.quality.ao.resolution, genex_render::settings::AoResolution::Half, "AO past its 1080p budget");
        assert_eq!(mac.capture_frame().1.scale, 1.0, "captures keep their pinned scale");
        let laptop = (1920, 1080);
        mac.set_live_output(laptop, Some(laptop));
        assert_eq!(mac.upscale_scale(), 0.6875);
        assert_eq!(mac.scale_steps().last(), Some(&0.6875), "a 1080p window upscales from Quality too");
        assert_eq!(mac.live_asked().quality.ao.resolution, genex_render::settings::AoResolution::Full);
    }

    /// Lane UP: where Live does not upscale temporally to the window (medium has no TAAU, a browser
    /// keeps its memory budget, a phone its panel), the output stays capped at the class's
    /// reference pixels, and phones and browsers keep the class's own scales. Flipped by lane UQ: a
    /// native desktop's medium, which rendered its whole capped output, renders the calibrated
    /// mode's share of the window (Quality's 0.6875 of 3456 is 0.90625 of the 2560 output).
    #[test]
    fn without_taa_upscaling_live_keeps_the_reference_cap_and_renders_the_mode_s_share_of_the_window() {
        let mut medium = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Medium);
        let (rw, rh) = genex_render::presets::reference_resolution(medium.live_class());
        assert_eq!(medium.live_output_cap_px(), u64::from(rw) * u64::from(rh));
        medium.set_live_output((2560, 1440), Some((3456, 2169)));
        assert_eq!((medium.upscale_scale(), medium.scale_steps().last().copied()), (0.90625, Some(0.90625)));
        let hints = json!({"maxTouchPoints": 0, "coarsePointer": false, "shortSideCssPx": 1080, "deviceMemoryGb": 8, "uaMobile": false});
        let web = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other).with_web(web_hints_from_json(&hints).expect("hints"));
        let mut browser = RenderControl::new(RenderConfig::new(), (960, 540));
        browser.probe(web, None);
        browser.apply(&RenderChange { preset: Some(Some(PresetChoice::Preset(QualityPreset::Ultra))), ..RenderChange::default() });
        let (bw, bh) = genex_render::presets::reference_resolution(browser.live_class());
        assert_eq!(browser.live_output_cap_px(), u64::from(bw) * u64::from(bh), "the web keeps its cap at ultra");
        let mut phone = controlled(RenderConfig::new(), "mobile-high", QualityPreset::High);
        let (pw, ph) = genex_render::presets::reference_resolution(phone.live_class());
        assert_eq!(phone.live_output_cap_px(), u64::from(pw) * u64::from(ph), "a phone keeps its cap");
        phone.set_live_output((786, 1704), Some((1179, 2556)));
        assert_eq!(phone.upscale_scale(), 1.0);
    }

    /// Lane UQ: the person's mode replaces the calibration's: Native renders every window pixel
    /// through TAA (DLAA), Balanced and Performance their shares; the panel's Reset gives the
    /// calibration's Quality back. Captures keep their pinned scale throughout.
    #[test]
    fn a_native_desktop_renders_native_only_when_the_person_asks_and_each_mode_s_share_otherwise() {
        let mut mac = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        let full_screen = (3456, 2169);
        mac.set_live_output(full_screen, Some(full_screen));
        for window in [(1280, 720), (1920, 1080), full_screen] {
            mac.set_live_output(window, Some(window));
            assert_eq!(mac.live_asked().scale, 0.6875, "{window:?}: Quality by default, never native");
        }
        for mode in UpscaleMode::ALL {
            mac.set_person(ClassOverride { upscale: Some(mode), ..ClassOverride::default() });
            assert_eq!(mac.upscale(), Some((mode, UpscaleSource::Person)));
            assert_eq!(mac.live_asked().scale, mode.scale(), "{mode:?}");
            assert_eq!(mac.scale_steps().last(), Some(&mode.scale()), "{mode:?}: dynamic resolution rises no higher than the mode");
            assert!(mac.live_asked().quality.anti_aliasing.temporal(), "{mode:?} resolves through TAA");
            assert_eq!(mac.capture_frame().1.scale, 1.0, "captures keep their pinned scale");
        }
        let steps = mac.scale_steps().to_vec();
        assert_eq!(steps, [0.5], "Performance sits at the floor: dynamic resolution only sheds features there");
        mac.set_person(ClassOverride { upscale: Some(UpscaleMode::Native), ..ClassOverride::default() });
        assert_eq!(mac.scale_steps().to_vec(), [0.75, 0.84375, 0.90625, 1.0], "Native moves over the class's own steps");
        mac.set_person(ClassOverride::default());
        assert_eq!(mac.upscale(), Some((UpscaleMode::Quality, UpscaleSource::Calibrated)), "a reset gives the calibration's back");
    }

    /// Lane UQ: a mode, a frame-rate target or dynamic resolution changes what the next frame's scale
    /// is and nothing else: the settings generation does not move, so the presenter neither rebuilds
    /// the world pass nor warms a renderer (no hitch, and no surface work during a warm-up, the
    /// rule of dd8a593b). A preset change still does.
    #[test]
    fn a_mode_frame_rate_or_dynamic_resolution_change_rebuilds_nothing() {
        let mut mac = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        mac.set_live_output((3456, 2169), Some((3456, 2169)));
        mac.note_world_samples(1);
        let generation = mac.pipeline_generation();
        let samples = |control: &RenderControl| genex_render::renderer::landed_samples(control.live_frame().quality.anti_aliasing);
        let changes = [
            ClassOverride { upscale: Some(UpscaleMode::Native), ..ClassOverride::default() },
            ClassOverride { upscale: Some(UpscaleMode::Performance), ..ClassOverride::default() },
            ClassOverride { upscale: Some(UpscaleMode::Performance), fps: Some(30), ..ClassOverride::default() },
            ClassOverride { upscale: Some(UpscaleMode::Balanced), fps: Some(30), dynamic_resolution: Some(false), ..ClassOverride::default() },
            ClassOverride { render_scale: Some(0.9), ..ClassOverride::default() },
            ClassOverride::default(),
        ];
        for person in changes {
            mac.set_person(person.clone());
            assert_eq!(mac.pipeline_generation(), generation, "{person:?} rebuilds nothing");
            assert_eq!(samples(&mac), 1, "{person:?} keeps TAA's one sample");
            assert!(!mac.status().degraded.iter().any(|degrade| degrade.reason == DegradeReason::PipelineChangeDeferred), "{person:?}");
        }
        mac.lock_upscale(Some(UpscaleMode::Native));
        mac.lock_upscale(None);
        assert_eq!(mac.pipeline_generation(), generation, "the game's hold rebuilds nothing either");
        mac.set_person(ClassOverride { preset: Some(QualityPreset::High), ..ClassOverride::default() });
        assert!(mac.pipeline_generation() > generation, "a preset is a pipeline change");
    }

    /// Lane UQ: dynamic resolution aims at the frame-rate target (30 holds 33.3 ms, 60 holds 16.7)
    /// within the mode's range, and turned off it holds the mode's scale and sheds no feature under
    /// a load it cannot fit.
    #[test]
    fn dynamic_resolution_aims_at_the_frame_rate_target_and_turned_off_holds_the_mode_s_scale() {
        let mut mac = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        mac.set_live_output((3456, 2169), Some((3456, 2169)));
        assert_eq!(mac.frame_interval(), Duration::from_secs(1) / 60);
        mac.set_person(ClassOverride { fps: Some(30), ..ClassOverride::default() });
        assert_eq!(mac.frame_interval(), Duration::from_secs(1) / 30, "the person's 30 fps target");
        let over = |control: &mut RenderControl| modelled_frames(control, 0, 900, 1.0, |_| 40.0);
        let mut moving = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        moving.set_live_output((3456, 2169), Some((3456, 2169)));
        over(&mut moving);
        assert!(moving.live_frame().scale < 0.6875 && moving.drs.demotion() > 0, "on: the scale drops to the floor, then features go");
        mac.set_person(ClassOverride { dynamic_resolution: Some(false), ..ClassOverride::default() });
        assert_eq!(mac.scale_steps(), [0.6875], "off: the mode's scale alone");
        over(&mut mac);
        assert_eq!(mac.live_frame().scale, 0.6875, "off: the scale holds");
        assert_eq!(mac.drs.demotion(), 0, "off: nothing is shed");
    }

    /// Lane UQ: phones and browsers keep their class's own scale until a mode is chosen; a chosen
    /// mode is a share of the window there too (the output is capped at the class's reference).
    #[test]
    fn phones_and_browsers_keep_their_class_scale_until_a_mode_is_chosen() {
        let mut phone = controlled(RenderConfig::new(), "mobile-high", QualityPreset::Medium);
        phone.set_live_output((786, 1704), Some((1179, 2556)));
        assert_eq!(phone.upscale(), None);
        assert_eq!(phone.live_asked().scale, 0.75, "mobile-high's own nominal scale");
        phone.set_person(ClassOverride { upscale: Some(UpscaleMode::Quality), ..ClassOverride::default() });
        assert_eq!(phone.upscale(), Some((UpscaleMode::Quality, UpscaleSource::Person)));
        assert_eq!(phone.live_asked().scale, 1.0, "0.6875 of the 1179 px panel is all of the 786 px output");
        let hints = json!({"maxTouchPoints": 0, "coarsePointer": false, "shortSideCssPx": 1080, "deviceMemoryGb": 8, "uaMobile": false});
        let web = DeviceFacts::new(TargetOs::Web, wgpu::Backend::BrowserWebGpu, wgpu::DeviceType::Other).with_web(web_hints_from_json(&hints).expect("hints"));
        let mut browser = RenderControl::new(RenderConfig::new(), (1920, 1080));
        browser.probe(web, None);
        browser.set_live_output((1920, 1080), Some((1920, 1080)));
        assert_eq!(browser.upscale(), None, "a desktop browser keeps its class's scale");
        assert_eq!(browser.live_asked().scale, quantized(class_defaults(browser.live_class()).nominal_scale));
    }

    /// Lane UQ: the game's default and lock, and the person's choice between them: a lock (the
    /// config's, then the runtime hold) wins over the person, the person over the game's default and
    /// a class table's mode, which win over the calibration; the panel's row hides while held.
    #[test]
    fn the_game_s_default_and_lock_and_the_person_s_choice_resolve_in_order() {
        let ultra = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
        let full_screen = (3456, 2169);
        let at = |config: RenderConfig| {
            let mut control = controlled(config, "desktop-ultra", QualityPreset::Ultra);
            control.set_live_output(full_screen, Some(full_screen));
            control
        };
        let mut game = at(RenderConfig::new().upscale(UpscaleMode::Balanced));
        assert_eq!(game.upscale(), Some((UpscaleMode::Balanced, UpscaleSource::Game)));
        game.set_person(ClassOverride { upscale: Some(UpscaleMode::Native), ..ClassOverride::default() });
        assert_eq!(game.upscale(), Some((UpscaleMode::Native, UpscaleSource::Person)), "the person's choice wins over the game's default");
        game.lock_upscale(Some(UpscaleMode::Performance));
        assert_eq!(game.upscale(), Some((UpscaleMode::Performance, UpscaleSource::Locked)));
        assert!(game.upscale_held());
        game.lock_upscale(None);
        assert_eq!(game.upscale(), Some((UpscaleMode::Native, UpscaleSource::Person)), "the hold gives the person's back");
        let table = ClassOverride { upscale: Some(UpscaleMode::Performance), ..ClassOverride::default() };
        let per_class = at(RenderConfig::new().upscale(UpscaleMode::Balanced).class(ultra, table));
        assert_eq!(per_class.upscale(), Some((UpscaleMode::Performance, UpscaleSource::Game)), "a class table's mode is that class's default");
        let mut locked = at(RenderConfig::new().upscale_locked(UpscaleMode::Native));
        locked.set_person(ClassOverride { upscale: Some(UpscaleMode::Performance), ..ClassOverride::default() });
        assert_eq!(locked.upscale(), Some((UpscaleMode::Native, UpscaleSource::Locked)), "a locked mode wins over the person's");
        assert_eq!(locked.live_asked().scale, 1.0);
        assert!(locked.upscale_held());
        let mut phone = controlled(RenderConfig::new().upscale(UpscaleMode::Quality), "mobile-high", QualityPreset::Medium);
        phone.set_live_output((786, 1704), Some((1179, 2556)));
        assert_eq!(phone.upscale(), Some((UpscaleMode::Quality, UpscaleSource::Game)), "the game's default applies on phones too");
    }

    /// Lane UQ: the panel's Max is ultra drawn natively; leaving it for another preset leaves native
    /// rendering too, and the upscaling and frame-rate menus map to the modes and the targets.
    #[test]
    fn the_panel_s_max_is_ultra_native_and_its_menus_map_to_modes_and_targets() {
        let control = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        let shown = PanelShown { presets: QualityPreset::ALL.to_vec(), max: true, features: Vec::new(), preset_threshold: 1.0 };
        let max = shown.presets.len() + 1;
        let person = person_after(&control, genex_hud::PanelChange::Preset(max), &shown);
        assert_eq!((person.preset, person.upscale), (Some(QualityPreset::Ultra), Some(UpscaleMode::Native)));
        assert_eq!(panel_index(&person, &shown), max, "the panel names it Max");
        let mut on_max = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        on_max.set_person(person);
        let high = person_after(&on_max, genex_hud::PanelChange::Preset(3), &shown);
        assert_eq!((high.preset, high.upscale), (Some(QualityPreset::High), None), "leaving Max leaves native");
        let kept = ClassOverride { upscale: Some(UpscaleMode::Balanced), ..ClassOverride::default() };
        let mut balanced = controlled(RenderConfig::new(), "desktop-ultra", QualityPreset::Ultra);
        balanced.set_person(kept);
        assert_eq!(person_after(&balanced, genex_hud::PanelChange::Preset(3), &shown).upscale, Some(UpscaleMode::Balanced), "another preset keeps the mode");
        let mode = person_after(&control, genex_hud::PanelChange::Upscale(4), &shown);
        assert_eq!(mode.upscale, Some(UpscaleMode::Performance));
        assert_eq!(person_after(&control, genex_hud::PanelChange::Upscale(0), &shown).upscale, None, "Auto");
        assert_eq!(person_after(&control, genex_hud::PanelChange::FrameRate(1), &shown).fps, Some(30));
        assert_eq!(person_after(&control, genex_hud::PanelChange::DynamicResolution(false), &shown).dynamic_resolution, Some(false));
        assert_eq!(panel_upscales(Some(UpscaleMode::Quality), None)[0], "Auto (Quality)");
        assert_eq!(panel_frame_rates(60, None), ["Auto (60 fps)", "30 fps", "60 fps"]);
        assert_eq!(panel_presets(QualityPreset::Ultra, None, &QualityPreset::ALL, true).last().map(String::as_str), Some("Max"));
    }

    /// Pass-1 gate finding 02: a capture "as a phone" keeps the MSAA a phone draws. Phones are tile
    /// GPUs whose samples live in tile memory, so the budget never gives MSAA up for them; the
    /// pinned capture facts counted it as memory, mobile-low's 48 MB dropped it first at the
    /// lakeside's 1280 x 720, and the capture drew no anti-aliasing at all (a regular dot pattern
    /// over the dock deck's seams once EASU upscaled them). Desktop classes keep counting it.
    #[test]
    fn a_capture_as_a_phone_keeps_its_msaa_in_tile_memory() {
        for class in ["mobile-low", "mobile-mid", "mobile-high"] {
            let mut control = RenderControl::new(RenderConfig::new(), (1280, 720));
            control.apply(&RenderChange { device_class: Some(Some(DeviceClass::from_wire(class).expect("class"))), ..RenderChange::default() });
            let (frame, render) = control.capture_frame();
            assert_eq!(render.device_class.wire(), class);
            assert_eq!(frame.quality.anti_aliasing, AntiAliasing::Msaa4, "{class}: the capture draws the phone's MSAA");
        }
        let mut control = RenderControl::new(RenderConfig::new(), (2560, 1440));
        let desktop_low = DeviceClass::from_wire("desktop-low").expect("class");
        control.apply(&RenderChange { device_class: Some(Some(desktop_low)), preset: Some(Some(PresetChoice::Preset(QualityPreset::Medium))), ..RenderChange::default() });
        let (frame, _) = control.capture_frame();
        assert_eq!(frame.quality.anti_aliasing, AntiAliasing::Off, "a desktop's MSAA is memory: desktop-low's 128 MB gives it up at medium");
    }

    #[test]
    fn a_games_meshlets_reach_every_frame_and_only_narrow_what_the_device_draws() {
        let default = RenderConfig::new();
        assert_eq!(default.meshlets, Meshlets::DEFAULT, "a game that says nothing gets the default");
        for (class, preset) in [("desktop-high", QualityPreset::High), ("desktop-ultra", QualityPreset::Ultra), ("mobile-high", QualityPreset::High)] {
            let control = controlled(default.clone(), class, preset);
            assert_eq!(control.live_frame().meshlets_drawn(), (false, false), "{class}: no preset defaults meshlets on (R2 review)");
        }
        // A game opts in per class in genex.toml; occlusion needs a one-sample world pass, and
        // every preset draws MSAA 4x until TAA lands, so it resolves off.
        let opted_in = RenderConfig::from_toml("[render.class.desktop-high]\nmeshlets = true\nocclusion = true\n").expect("a class table");
        let frame = controlled(opted_in.clone(), "desktop-high", QualityPreset::High).live_frame();
        assert_eq!(frame.meshlets_drawn(), (true, genex_render::post::taa::LANDED), "the class table opts meshlets in");
        assert_eq!(controlled(opted_in.clone(), "desktop-mid", QualityPreset::High).live_frame().meshlets_drawn(), (false, false), "only that class");

        let narrowed = opted_in.clone().meshlets(Meshlets::DEFAULT.with_occlusion(false).with_min_triangles(4096));
        let frame = controlled(narrowed, "desktop-high", QualityPreset::High).live_frame();
        assert_eq!((frame.meshlets.occlusion, frame.meshlets.min_triangles), (false, 4096));
        assert_eq!(frame.meshlets_drawn(), (true, false), "a game may drop occlusion and keep meshlets");

        let opted_out = opted_in.meshlets(Meshlets::DEFAULT.with_enabled(false));
        let control = controlled(opted_out, "desktop-high", QualityPreset::High);
        assert_eq!(control.live_frame().meshlets_drawn(), (false, false), "a game may opt out of meshlets");
        assert_eq!(control.capture_frame().0.meshlets_drawn(), (false, false), "captures draw the same path");
    }

    #[test]
    fn every_adapter_draws_the_instance_path_live_and_in_captures_unless_the_game_opts_in() {
        let probed = |tile_memory: Option<bool>, config: RenderConfig| {
            let mut facts = DeviceFacts::new(TargetOs::MacOs, wgpu::Backend::Metal, wgpu::DeviceType::IntegratedGpu);
            facts.vendor = genex_render::device_class::APPLE_VENDOR_ID;
            facts.transient_saves_memory = tile_memory;
            let mut control = RenderControl::new(config, (960, 540));
            control.probe(facts, None);
            control.apply(&RenderChange {
                device_class: Some(Some(DeviceClass::from_wire("desktop-high").expect("class"))),
                preset: Some(Some(PresetChoice::Preset(QualityPreset::High))),
                ..RenderChange::default()
            });
            control
        };
        let opted_in = RenderConfig::from_toml("[render.class.desktop-high]\nmeshlets = true\n").expect("a class table");
        for tile_memory in [Some(true), Some(false), None] {
            let control = probed(tile_memory, RenderConfig::new());
            assert_eq!(control.live_frame().meshlets_drawn(), (false, false), "{tile_memory:?}: the instance path Live");
            assert_eq!(control.capture_frame().0.meshlets_drawn(), (false, false), "{tile_memory:?}: and in captures");
            let control = probed(tile_memory, opted_in.clone());
            assert_eq!(control.live_frame().meshlets_drawn(), (true, false), "{tile_memory:?}: the game's opt-in Live, whatever the adapter");
            assert_eq!(control.capture_frame().0.meshlets_drawn(), (true, false), "{tile_memory:?}: and in captures");
        }
    }

    #[test]
    fn a_games_meshlets_survive_the_round_trip_through_render_settings() {
        let settings = RenderSettings::auto().with_meshlets(Meshlets::DEFAULT.with_min_triangles(8192));
        assert_eq!(RenderConfig::from(settings).meshlets.min_triangles, 8192);
    }
}
