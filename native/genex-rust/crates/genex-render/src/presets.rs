//! Quality presets and per-class defaults (plan §2.4): the preset feature table, the mobile and
//! web caps, genex.toml and person overrides, the per-class memory budget, the discrete
//! dynamic-resolution steps and the numeric work-model ceilings.
//!
//! Resolution order for one device (each later source wins, key by key):
//! 1. the class default ([`class_defaults`]; on the web the default is capped at `high`);
//! 2. genex.toml `[render] preset`, then the `[render.class.<class>]` table ([`RenderOverrides`]);
//! 3. the person's saved choice for this device ([`ClassOverride`]).
//!
//! The chosen preset becomes a [`Quality`] through the preset table and then the caps (mobile
//! caps on every mobile class, whatever the preset); per-feature switches and the render scale
//! land on top. A feature that does not fit is switched off or made cheaper, never refused.

use crate::device_class::{DeviceClass, DeviceFacts, FormFactor, PerformanceTier, TargetOs};
use crate::post::bloom::CHAIN_RESOLUTION;
use crate::post::dof::DofTier;
use crate::settings::{
    AntiAliasing, AoQuality, AoResolution, BloomQuality, EnvironmentQuality, JitterCycle, LightQuality, PresetChoice, Quality, QualityPreset,
    MAX_CASCADES, RENDER_SCALE_MIN, RenderFeature, RenderSettings, SHADOW_BLEND_BAND_MAX, SHADOW_DISTANCE_MAX_M, SHADOW_DISTANCE_MIN_M,
    SceneFormat, ShadowFilter, ShadowFormat, ShadowQuality, TAA_SHARPEN_RCAS_SHARPNESS, TaaQuality, Upscaler,
};

/// One MiB.
const MIB: u64 = 1024 * 1024;
/// One GiB.
const GIB: u64 = 1024 * MIB;
/// A native desktop's budget may grow to this share of its GPU-visible memory (one eighth)...
pub const DESKTOP_BUDGET_MEMORY_DIVISOR: u64 = 8;
/// ...up to this ceiling (owner decision 2026-10-12 (2): a 36 GB M-series Mac gets 2 GiB, an 8 GB
/// MacBook Air about 680 MiB, an 8 GB discrete PC 1 GiB).
pub const DESKTOP_BUDGET_MEMORY_CAP_BYTES: u64 = 2 * GIB;
/// The web's memory budget never exceeds this, whatever the class.
pub const WEB_BUDGET_CAP_BYTES: u64 = 256 * MIB;
/// The web's budget per GB of `navigator.deviceMemory`.
pub const WEB_BUDGET_PER_DEVICE_GB: u64 = 32 * MIB;
/// The highest preset the web defaults to (a game or the person may still pick `ultra`).
pub const WEB_DEFAULT_PRESET_CAP: QualityPreset = QualityPreset::High;

/// The smallest shadow map side a game or person may ask for, in texels.
pub const SHADOW_MAP_MIN_PX: u32 = 512;
/// The largest shadow map side a game or person may ask for, in texels (4096 desktop ultra's).
pub const SHADOW_MAP_MAX_PX: u32 = 4096;
/// Most cascades a phone draws, whatever the preset or the request.
pub const MOBILE_MAX_SHADOW_CASCADES: u8 = 2;
/// Largest cascade side a phone draws, in texels.
pub const MOBILE_MAX_SHADOW_MAP_PX: u32 = 1536;
/// Each cascade of the weakest phone class is at most this wide, in texels: its two cascades
/// stored and read each frame stay within its 20 MB off-chip ceiling (`work_limits`), as its one
/// 768 px cascade did before pass-1 gate finding 02.
pub const MOBILE_LOW_SHADOW_MAP_PX: u32 = 512;
/// Each of a phone's two `low` cascades, in texels: two 1024 px maps would pass mobile-mid's
/// 25 MB off-chip ceiling (`work_limits`).
pub const MOBILE_LOW_PRESET_SHADOW_MAP_PX: u32 = 768;
/// Far cascades redraw every this many frames on phones and the low tier (the nearest cascade
/// draws every frame), once there is more than one cascade.
pub const CHEAP_CLASS_FAR_CADENCE: u8 = 2;
/// The farthest a phone draws the sun's shadows, world units, whatever the preset or the request
/// (the legacy reach: 50 units measured +0.03 ms GPU p95 on the mobile-high proxy, at its line).
pub const MOBILE_MAX_SHADOW_DISTANCE_M: u16 = 40;

/// The shadow row of each preset (plan §2.4, RQ3 review): how far the shadows reach (world units),
/// the split's logarithmic weight (a longer reach leans more logarithmic, so the nearest cascade
/// keeps its texel size), the cascade blend band and the end fade (percent of a cascade's range).
struct ShadowReach {
    distance: u16,
    split_percent: u8,
    blend_percent: u8,
    fade_percent: u8,
}

/// `low`: two cascades over 50 units (`medium`'s reach: over 30 the far crowns took no sun shadow and
/// read frosted against `high`, pass-1 gate finding 04) at `medium`'s split, switching hard between
/// them, fading out over the last one's last 15 %.
const LOW_REACH: ShadowReach = ShadowReach { distance: 50, split_percent: 60, blend_percent: 0, fade_percent: 15 };
/// `medium`: two cascades over 50 units.
const MEDIUM_REACH: ShadowReach = ShadowReach { distance: 50, split_percent: 60, blend_percent: 10, fade_percent: 10 };
/// `high`: three cascades over 80 units.
const HIGH_REACH: ShadowReach = ShadowReach { distance: 80, split_percent: 75, blend_percent: 10, fade_percent: 10 };
/// `ultra`: four finer cascades over `high`'s 80 units (120 units measured +0.9 ms GPU p95 on the
/// lakeside at 1080p on the M4 Max, past the shadow budget).
const ULTRA_REACH: ShadowReach = ShadowReach { distance: 80, split_percent: 75, blend_percent: 10, fade_percent: 10 };

/// Reference resolutions of the ledger and work model: logical size × min(dpr, 2).
/// A desktop monitor.
pub const DESKTOP_REFERENCE: (u32, u32) = (2560, 1440);
/// A laptop panel.
pub const LAPTOP_REFERENCE: (u32, u32) = (1920, 1080);
/// An iPhone (393 × 852 logical at dpr 3, capped to 2).
pub const IPHONE_REFERENCE: (u32, u32) = (786, 1704);
/// A mid-range Android phone (412 × 915 logical at dpr 2.6, capped to 2).
pub const ANDROID_REFERENCE: (u32, u32) = (824, 1830);
/// A browser window.
pub const WEB_REFERENCE: (u32, u32) = (1920, 1080);

/// Passes the legacy renderer opens per frame in the model's count (pre-pass compute, two shadow
/// passes, the world pass): the `off` budget.
pub const OFF_RENDER_PASSES: u32 = 4;

/// The specular cube's side under an HDR map on ultra (plan §2.4: 512 for an HDRI).
pub const ULTRA_HDRI_CUBE_PX: u32 = 512;
/// The largest specular cube a phone bakes, whatever the preset.
pub const MOBILE_MAX_CUBE_PX: u32 = 256;
/// The largest radiance cube (the prefilter's source, `ibl::radiance_side`) a phone bakes: a
/// quarter of its largest specular cube. Half the side (desktop) cost mobile-mid's high row
/// 930 KB, past its 96 MiB budget without transient MSAA; a quarter costs 180 KB over the 32 px
/// cube it replaced (renderer pass 2, P2-0.11).
pub const MOBILE_MAX_RADIANCE_PX: u32 = 64;
/// The most local lights a phone bins (`LightQuality::cap`), whatever the preset asks.
pub const MOBILE_MAX_LIGHTS: u32 = 256;
/// The smallest binning tile a phone uses, in pixels (fewer tiles to bin and walk).
pub const MOBILE_MIN_LIGHT_TILE_PX: u32 = 32;
/// The most local lights a desktop shades with the `clustered` switch off: the per-pixel loop walks
/// every light at every pixel, so off is the cheaper variant only over a few (the nearest are kept,
/// `lights::legacy_lights`). RX review: 256 looped lights cost several times low's binned 1,024.
pub const UNCLUSTERED_MAX_LIGHTS: u32 = 8;
/// The most local lights a phone shades with the `clustered` switch off.
pub const MOBILE_UNCLUSTERED_MAX_LIGHTS: u32 = 4;

/// What a device class starts with (plan §2.4's class table).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClassDefaults {
    /// The preset `auto` resolves to.
    pub preset: QualityPreset,
    /// The frame rate the class holds.
    pub target_fps: u32,
    /// The rate it falls back to under sustained thermal load, if any.
    pub sustained_fps: Option<u32>,
    /// The nominal render scale.
    pub nominal_scale: f32,
    /// The dynamic-resolution range (lowest, highest scale).
    pub drs_range: (f32, f32),
    /// The discrete dynamic-resolution steps, lowest first (at most six; the nominal scale is
    /// one). Each step is its own exact target size.
    pub drs_steps: &'static [f32],
    /// Whether the scene prefers `rg11b10ufloat` when the adapter can render it.
    pub prefers_rg11b10: bool,
    /// Bytes of targets, history, IBL, shadows and material arrays the class may hold.
    pub budget_bytes: u64,
}

/// The defaults of `class`. `mobile-ultra` takes `mobile-high`'s.
pub fn class_defaults(class: DeviceClass) -> ClassDefaults {
    let defaults = |preset, fps, sustained, scale, steps: &'static [f32], rg11b10, mib: u64| ClassDefaults {
        preset,
        target_fps: fps,
        sustained_fps: sustained,
        nominal_scale: scale,
        drs_range: (steps[0], steps[steps.len() - 1]),
        drs_steps: steps,
        prefers_rg11b10: rg11b10,
        budget_bytes: mib * MIB,
    };
    match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra) => defaults(QualityPreset::Ultra, 60, None, 1.0, &[0.75, 0.85, 0.92, 1.0], false, 1024),
        (FormFactor::Desktop, PerformanceTier::High) => {
            defaults(QualityPreset::High, 60, None, 1.0, &[0.67, 0.75, 0.85, 0.92, 1.0], false, 512)
        }
        (FormFactor::Desktop, PerformanceTier::Mid) => {
            defaults(QualityPreset::Medium, 60, None, 1.0, &[0.6, 0.67, 0.75, 0.85, 1.0], false, 256)
        }
        (FormFactor::Desktop, PerformanceTier::Low) => {
            defaults(QualityPreset::Low, 60, None, 0.85, &[0.5, 0.6, 0.67, 0.75, 0.85, 1.0], true, 128)
        }
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => {
            defaults(QualityPreset::Medium, 60, None, 0.75, &[0.6, 0.67, 0.75, 0.85], true, 160)
        }
        (FormFactor::Mobile, PerformanceTier::Mid) => {
            defaults(QualityPreset::Low, 60, Some(30), 0.67, &[0.5, 0.58, 0.67, 0.75, 0.8], true, 96)
        }
        (FormFactor::Mobile, PerformanceTier::Low) => defaults(QualityPreset::Low, 30, None, 0.6, &[0.5, 0.6, 0.67, 0.75], true, 48),
    }
}

/// The reference resolution of `class` (the ledger and work-model rows).
pub fn reference_resolution(class: DeviceClass) -> (u32, u32) {
    match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra | PerformanceTier::High) => DESKTOP_REFERENCE,
        (FormFactor::Desktop, _) => LAPTOP_REFERENCE,
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => IPHONE_REFERENCE,
        (FormFactor::Mobile, _) => ANDROID_REFERENCE,
    }
}

/// The exact target size of a frame rendered at `scale` of `output` (the rule
/// [`RenderSettings::frame_config`] uses).
pub fn step_size(output: (u32, u32), scale: f32) -> (u32, u32) {
    let side = |px: u32| ((px as f32 * scale) as u32).clamp(1, px.max(1));
    (side(output.0), side(output.1))
}

/// The target size of each of `class`'s DRS steps at `output`, lowest first.
pub fn drs_step_sizes(class: DeviceClass, output: (u32, u32)) -> Vec<(u32, u32)> {
    class_defaults(class).drs_steps.iter().map(|scale| step_size(output, *scale)).collect()
}

/// The scene format of `class` on an adapter that can (or cannot) render `rg11b10ufloat`: chosen
/// once per class, never per preset.
pub fn scene_format(class: DeviceClass, rg11b10_renderable: bool) -> SceneFormat {
    if class_defaults(class).prefers_rg11b10 && rg11b10_renderable { SceneFormat::Rg11b10Ufloat } else { SceneFormat::Rgba16Float }
}

/// The preset `auto` picks for `class` on `os`: the class's, capped at `high` on the web.
pub fn default_preset(class: DeviceClass, os: TargetOs) -> QualityPreset {
    let preset = class_defaults(class).preset;
    if os == TargetOs::Web { preset.min(WEB_DEFAULT_PRESET_CAP) } else { preset }
}

/// The memory budget of `class` on the device `facts` describe: the class's; on a native desktop
/// (macOS, Windows, Linux) that reports its GPU-visible memory, at least
/// 1/[`DESKTOP_BUDGET_MEMORY_DIVISOR`] of it up to [`DESKTOP_BUDGET_MEMORY_CAP_BYTES`]; on the web
/// at most [`WEB_BUDGET_CAP_BYTES`] and [`WEB_BUDGET_PER_DEVICE_GB`] per GB of `deviceMemory` (a
/// missing hint reads as 4 GB, so 128 MB). Phones keep the class's: memory pressure kills apps.
pub fn class_budget_bytes(class: DeviceClass, facts: &DeviceFacts) -> u64 {
    let budget = class_defaults(class).budget_bytes;
    match facts.os {
        TargetOs::Web => {
            let gb = facts.web.unwrap_or_default().device_memory_gb();
            let by_memory = (f64::from(gb) * WEB_BUDGET_PER_DEVICE_GB as f64) as u64;
            budget.min(WEB_BUDGET_CAP_BYTES).min(by_memory)
        }
        TargetOs::MacOs | TargetOs::Windows | TargetOs::Linux => {
            let by_memory = facts.gpu_visible_memory_bytes.map_or(0, |bytes| (bytes / DESKTOP_BUDGET_MEMORY_DIVISOR).min(DESKTOP_BUDGET_MEMORY_CAP_BYTES));
            budget.max(by_memory)
        }
        TargetOs::Ios | TargetOs::Android => budget,
    }
}

/// The preset table (plan §2.4), before caps.
fn table_quality(preset: QualityPreset, form: FormFactor) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality.specular_aa = true;
    quality.fog = true;
    quality.lights.clustered = true;
    quality.upscaler = if preset == QualityPreset::Low { Upscaler::Bilinear } else { Upscaler::Fsr1 };
    match preset {
        QualityPreset::Low => low_row(&mut quality, form),
        QualityPreset::Medium => medium_row(&mut quality),
        QualityPreset::High => high_row(&mut quality),
        QualityPreset::Ultra => ultra_row(&mut quality, form),
    }
    quality
}

/// The environment row of a preset: the IBL cube (the same side under an HDR map, `hdri_cube_size`
/// on ultra sets its own), the sky-view LUT and the cadence both the sky LUTs and a rebake's
/// time-sliced steps follow, and the sun's rebake threshold.
fn environment(cube_size: u32, sky_lut: (u32, u32), cadence: u8, sun_rebake_tenths: u16, aerial_perspective: bool) -> EnvironmentQuality {
    EnvironmentQuality {
        ibl: true,
        cube_size,
        hdri_cube_size: cube_size,
        rebake_cadence: cadence,
        sun_rebake_tenths,
        sky: true,
        sky_lut,
        sky_cadence: cadence,
        aerial_perspective,
        radiance_side_max: 0,
    }
}

fn shadows(cascades: u8, map_size: u32, filter: ShadowFilter, format: ShadowFormat, reach: &ShadowReach) -> ShadowQuality {
    ShadowQuality {
        enabled: true,
        cascades,
        map_size,
        filter,
        format,
        far_cadence: 1,
        distance: reach.distance,
        split_percent: reach.split_percent,
        blend_percent: reach.blend_percent,
        fade_percent: reach.fade_percent,
        screen_mask: true,
    }
}

fn lights(cap: u32, tile_px: u32, shadowed_spots: u8) -> LightQuality {
    LightQuality { cap, clustered: true, tile_px, shadowed_spots }
}

/// The material sampler's anisotropy per preset and class (P2-0.12 LG-02): desktop high and ultra
/// 16, medium 8, low 4; phones at most 4, the low-tier phone 2 (its bandwidth). A resource knob.
const HIGH_ANISOTROPY: u8 = 16;
const MEDIUM_ANISOTROPY: u8 = 8;
const LOW_ANISOTROPY: u8 = 4;
const MOBILE_ANISOTROPY: u8 = 4;
/// The bloom chain's top height cap on phones (`min(output height / 2, this)`): every phone preset
/// draws the same halo, on a chain under two thirds of a desktop's rows (renderer pass 2, P5:
/// presets and classes lower the chain's resolution, never its mip count).
pub const MOBILE_BLOOM_RESOLUTION: u16 = 360;
const MOBILE_LOW_ANISOTROPY: u8 = 2;

fn low_row(quality: &mut Quality, form: FormFactor) {
    quality.anti_aliasing = AntiAliasing::Msaa4;
    quality.anisotropy = LOW_ANISOTROPY;
    quality.exposure_input_divisor = 16;
    quality.environment = environment(64, (64, 36), 8, 20, false);
    // Two cascades (pass-1 gate findings 01, 01b and 02): one 1024 px cascade over 50 units has
    // 8 cm texels under a 45° camera (9 cm for a phone's 768 px over 40), so a figure's legs
    // washed out of its shadow, which stood 30 px off the feet, and a block's shadow lost a wedge
    // under its corner and came out short and stair-stepped (the normal offset and the filter
    // span a texel or more). The near cascade holds 2 cm texels over the first 11 units for one
    // more depth pass (the far one redraws every other frame on the low tier and phones,
    // `cap_shadows`). A phone's two are [`MOBILE_LOW_PRESET_SHADOW_MAP_PX`] (the weakest phone's
    // [`MOBILE_LOW_SHADOW_MAP_PX`]).
    // Desktops filter 3x3 (one hardware tap stair-steps the texels, for about 0.1 ms at 1080p);
    // phones keep the one tap.
    let (filter, map_size) = match form {
        FormFactor::Desktop => (ShadowFilter::Pcf3x3, 1024),
        FormFactor::Mobile => (ShadowFilter::Hardware2x2, MOBILE_LOW_PRESET_SHADOW_MAP_PX),
    };
    quality.shadows = shadows(2, map_size, filter, ShadowFormat::Depth16, &LOW_REACH);
    // Off, at the chain every preset draws: a game that switches bloom on gets the same halo.
    quality.bloom = BloomQuality { enabled: false, resolution: CHAIN_RESOLUTION };
    quality.ao = AoQuality { resolution: AoResolution::Off, slices: 0, steps: 0, temporal: false };
    quality.lights = lights(64, 32, 0);
}

fn medium_row(quality: &mut Quality) {
    quality.anti_aliasing = AntiAliasing::Msaa4;
    quality.anisotropy = MEDIUM_ANISOTROPY;
    quality.exposure_input_divisor = 8;
    quality.environment = environment(128, (96, 54), 4, 10, true);
    quality.shadows = shadows(2, 1536, ShadowFilter::Pcf3x3, ShadowFormat::Depth32, &MEDIUM_REACH);
    quality.bloom = BloomQuality { enabled: true, resolution: CHAIN_RESOLUTION };
    quality.ao = AoQuality { resolution: AoResolution::Half, slices: 1, steps: 4, temporal: false };
    quality.lights = lights(256, 32, 0);
    with_geometry_features(quality);
}

fn high_row(quality: &mut Quality) {
    quality.anti_aliasing = AntiAliasing::Taa;
    quality.anisotropy = HIGH_ANISOTROPY;
    quality.exposure_input_divisor = 4;
    quality.environment = environment(256, (192, 108), 1, 5, true);
    quality.shadows = shadows(3, 2048, ShadowFilter::PcssLite, ShadowFormat::Depth32, &HIGH_REACH);
    quality.contact_shadows = true;
    quality.bloom = BloomQuality { enabled: true, resolution: CHAIN_RESOLUTION };
    quality.ao = AoQuality { resolution: AoResolution::Half, slices: 2, steps: 6, temporal: true };
    quality.lights = lights(1024, 16, 2);
    // Filament's ring gather (A.9; ultra inherits it): the look's switch decides whether it runs.
    quality.dof = DofTier::Ring;
    with_geometry_features(quality);
}

fn ultra_row(quality: &mut Quality, form: FormFactor) {
    high_row(quality);
    quality.anti_aliasing = AntiAliasing::TaaSharpen;
    // RCAS after TAA at scale 1 sharpens gently (RQ5 review: at the 0.2-stop default it doubled
    // the high-frequency energy of flat regions; noise detection is on as everywhere).
    quality.rcas = quality.rcas.with_sharpness(TAA_SHARPEN_RCAS_SHARPNESS);
    // Sixteen jitter positions (plan §2.7): a settled capture on ultra re-renders sixteen times.
    quality.taa = quality.taa.with_jitter_cycle(JitterCycle::Sixteen);
    // An HDR map's detail is worth a 512 px cube on ultra (plan §2.4); the smooth sky is not.
    quality.environment.hdri_cube_size = ULTRA_HDRI_CUBE_PX;
    let map_size = if form == FormFactor::Desktop { 4096 } else { 2048 };
    quality.shadows = shadows(4, map_size, ShadowFilter::Pcss, ShadowFormat::Depth32, &ULTRA_REACH);
    // Three slices of eight steps at full resolution with history. The unbiased estimate (gate
    // finding 03: each slice measured against its unoccluded arc, every sample slid back onto its
    // slice) costs about a fifth more a step: 3 x 8 measured 1.38 ms (M4 Max, 1080p), so the owner
    // raised ultra's AO budget to 1.5 ms (2026-10-12; plan §2.5 had 1.2) rather than halve the steps.
    quality.ao = AoQuality { resolution: AoResolution::Full, slices: 3, steps: 8, temporal: true };
    quality.lights = lights(1024, 16, 4);
}

/// Medium and up: the depth/normal prepass may run for its consumers (AO, contact shadows, the
/// `Equal` reuse, Level-3 inputs). Meshlets and Hi-Z occlusion take [`GEOMETRY_PATH_DEFAULT`].
fn with_geometry_features(quality: &mut Quality) {
    quality.prepass = true;
    quality.meshlets = GEOMETRY_PATH_DEFAULT;
    quality.occlusion = GEOMETRY_PATH_DEFAULT;
}

/// The meshlet and Hi-Z occlusion default of every preset on every class (R2 review): off. The
/// measurement decides, and it shows a loss on typical scenes. On the M4 Max (a tile GPU) at
/// `desktop-high` 1080p (`meshlet-paths-*.json`, the showcase's `metal_meshlet_paths_*` row, and
/// the `occlusion` test's stress row): meshlets alone cost 17.8% to 54% more GPU time, and
/// meshlets with occlusion cost 48% (walled scene) and 54% (forest) more. Occlusion saved 34.8%
/// only in a synthetic scene that hides every crown, and the open scene paid 8.3% more. No
/// immediate-mode GPU (most PCs) has measured a gain, and no scene signal known before drawing
/// predicts one. So every class and preset draws the instance path. A game opts in per class in
/// genex.toml (`[render.class.desktop-high] meshlets = true`, `occlusion = true`), or in code with
/// a `ClassOverride`, and the person's settings panel has the last word. Either switch stays typed
/// and drawn when asked for.
pub const GEOMETRY_PATH_DEFAULT: bool = false;

/// Whether Hi-Z occlusion can run under `quality`: it culls meshlet candidates, so meshlets must be
/// on, and its Hi-Z holds the single-sample prepass's depth at pixel centres, so the world pass
/// must draw one sample per pixel ([`crate::renderer::landed_samples`]: anti-aliasing off, or TAA
/// once it lands). Over MSAA it would cull a meshlet seen only through an edge pixel's uncovered
/// samples, and that edge would lose its background.
pub const fn occlusion_runs_with(quality: &Quality) -> bool {
    quality.meshlets && crate::renderer::landed_samples(quality.anti_aliasing) == 1
}

/// `quality` as a world pass built with `samples` per pixel draws it on `class` (RQ5 review). The
/// world pass's samples are a pipeline knob the presenter fixes at boot and changes only on an
/// explicit person or verb change, so a frame can ask for anti-aliasing the renderer was not
/// built for. Its anti-aliasing then degrades instead of disappearing: over MSAA a TAA ask draws
/// MSAA 4x (on a phone with the MSAA branch of the mobile caps: no AO, prepass or contact shadows,
/// the second geometry pass a tile GPU cannot afford), and over one sample an MSAA ask draws TAA
/// with the prepass it needs. Occlusion follows ([`occlusion_runs_with`]). A matching ask is
/// returned unchanged.
pub fn with_world_samples(quality: &Quality, samples: u32, class: DeviceClass) -> Quality {
    let mut drawn = *quality;
    if crate::renderer::landed_samples(quality.anti_aliasing) == samples {
        return drawn;
    }
    if samples > 1 {
        drawn.anti_aliasing = AntiAliasing::Msaa4;
        if class.form == FormFactor::Mobile {
            drop_second_geometry_pass(&mut drawn);
        }
    } else if crate::post::taa::LANDED {
        drawn.anti_aliasing = AntiAliasing::Taa;
        drawn.prepass = true;
    } else {
        drawn.anti_aliasing = AntiAliasing::Off;
    }
    drawn.occlusion &= occlusion_runs_with(&drawn);
    drawn
}

/// `quality` as a frame on the legacy LDR scene draws it (a v1 material or a v1 in-world pass keeps
/// an HDR-requested frame there, `LdrReason`). TAA resolves the HDR scene and never draws on the LDR
/// one, so a temporal ask takes the switch table's "taa off" variant, MSAA 4x (on a phone without
/// the second geometry pass, as [`with_world_samples`] draws it), instead of losing its edges. Any
/// other ask is returned unchanged.
pub fn on_ldr_scene(quality: &Quality, class: DeviceClass) -> Quality {
    if !quality.anti_aliasing.temporal() {
        return *quality;
    }
    with_world_samples(quality, crate::renderer::MSAA_SAMPLES, class)
}

/// A phone's MSAA frame: MSAA lives in tile memory for free, and a depth prepass would be a second
/// full geometry pass, so its consumers (AO, contact shadows) stay off.
fn drop_second_geometry_pass(quality: &mut Quality) {
    quality.ao.resolution = AoResolution::Off;
    quality.prepass = false;
    quality.contact_shadows = false;
}

/// The shadow caps of `class` (plan §2.4), for any preset and any request: phones draw at most 2
/// cascades of 1536 px with no PCSS (the weakest phone class 512 px ones) up to
/// [`MOBILE_MAX_SHADOW_DISTANCE_M`]; phones and the low tier draw `Depth16Unorm` cascades and
/// redraw far cascades every [`CHEAP_CLASS_FAR_CADENCE`]th frame. Desktop ultra, high and mid keep
/// `Depth32` and every-frame cascades.
pub fn cap_shadows(shadows: &mut ShadowQuality, class: DeviceClass) {
    let mobile = class.form == FormFactor::Mobile;
    if mobile {
        shadows.distance = shadows.distance.min(MOBILE_MAX_SHADOW_DISTANCE_M);
        if matches!(shadows.filter, ShadowFilter::Pcss | ShadowFilter::PcssLite) {
            shadows.filter = ShadowFilter::Pcf3x3;
        }
        shadows.cascades = shadows.cascades.min(MOBILE_MAX_SHADOW_CASCADES);
        shadows.map_size = shadows.map_size.min(MOBILE_MAX_SHADOW_MAP_PX);
        if class.tier == PerformanceTier::Low {
            shadows.map_size = shadows.map_size.min(MOBILE_LOW_SHADOW_MAP_PX);
        }
    }
    if mobile || class.tier == PerformanceTier::Low {
        shadows.format = ShadowFormat::Depth16;
        if shadows.cascades > 1 {
            shadows.far_cadence = shadows.far_cadence.max(CHEAP_CLASS_FAR_CADENCE);
        }
    }
}

/// The local-light caps of `class` (plan §2.4, RQ6 review), for any preset and any request: with
/// the `clustered` switch off the per-pixel loop shades at most [`UNCLUSTERED_MAX_LIGHTS`] lights
/// ([`MOBILE_UNCLUSTERED_MAX_LIGHTS`] on a phone); phones bin at most [`MOBILE_MAX_LIGHTS`] lights
/// in tiles of at least [`MOBILE_MIN_LIGHT_TILE_PX`], and shade one shadowed spot on the high and
/// ultra phone classes, none below. Desktops keep the preset's binned caps. The legacy renderer's
/// `Quality::off` is never capped here.
pub fn cap_lights(lights: &mut LightQuality, class: DeviceClass) {
    let mobile = class.form == FormFactor::Mobile;
    if !lights.clustered {
        let most = if mobile { MOBILE_UNCLUSTERED_MAX_LIGHTS } else { UNCLUSTERED_MAX_LIGHTS };
        lights.cap = lights.cap.min(most);
    }
    if !mobile {
        return;
    }
    lights.cap = lights.cap.min(MOBILE_MAX_LIGHTS);
    if lights.clustered {
        lights.tile_px = lights.tile_px.max(MOBILE_MIN_LIGHT_TILE_PX);
    }
    let spots = if class.tier >= PerformanceTier::High { 1 } else { 0 };
    lights.shadowed_spots = lights.shadowed_spots.min(spots);
}

/// Mobile and tile caps (plan §2.4), for any preset on a mobile class.
fn apply_mobile_caps(quality: &mut Quality, preset: QualityPreset, class: DeviceClass) {
    // Every phone class draws below scale 1 (0.6-0.75) and a bilinear upscale stair-steps thin
    // edges there, so phones upscale with EASU + RCAS at every preset (owner decision 2026-10-12;
    // its cost on the Mac mobile proxy is in the showcase's `metal_mobile_proxy` row). EASU and
    // RCAS run only while the render size differs from the output.
    quality.upscaler = Upscaler::Fsr1;
    quality.bloom.resolution = quality.bloom.resolution.min(MOBILE_BLOOM_RESOLUTION);
    let anisotropy = if class.tier == PerformanceTier::Low { MOBILE_LOW_ANISOTROPY } else { MOBILE_ANISOTROPY };
    quality.anisotropy = quality.anisotropy.min(anisotropy);
    let taa_allowed = class.tier >= PerformanceTier::High && preset >= QualityPreset::High;
    if quality.anti_aliasing.temporal() && !taa_allowed {
        quality.anti_aliasing = AntiAliasing::Msaa4;
    }
    if quality.ao.resolution == AoResolution::Full {
        quality.ao.resolution = AoResolution::Half;
    }
    if crate::renderer::landed_samples(quality.anti_aliasing) > 1 {
        // Keyed on the samples the world pass draws: a TAA preset (high and up on the high phone
        // classes) draws one sample and runs the prepass TAA needs, so its AO and contact shadows
        // stay. A TAA ask over a renderer built with MSAA takes this branch too
        // (`with_world_samples`).
        drop_second_geometry_pass(quality);
    }
    if class.tier == PerformanceTier::Low {
        quality.bloom.enabled = false;
    }
    quality.environment.cube_size = quality.environment.cube_size.min(MOBILE_MAX_CUBE_PX);
    quality.environment.hdri_cube_size = quality.environment.hdri_cube_size.min(MOBILE_MAX_CUBE_PX);
    quality.environment.radiance_side_max = MOBILE_MAX_RADIANCE_PX;
    let tier_probes = MOBILE_PROBES_PER_TIER[PerformanceTier::ALL.iter().position(|tier| *tier == class.tier).unwrap_or(0)];
    quality.environment.reflection_probes = quality.environment.reflection_probes.min(tier_probes);
    quality.environment.probe_side_max = MOBILE_PROBE_SIDE_MAX_PX;
    quality.environment.continuous_sky = false;
    // Ten passes of Filament's ring gather are a desktop's: phones take Godot's circular gather.
    quality.dof = DofTier::Circular;
}

/// The widest HDR environment map `class` keeps on the GPU (an equirect `width × width / 2`
/// `rgba16float` with its mips; a wider map is box-filtered down at upload,
/// `hdri::prepare_map`). Desktops keep the format's cap for the backdrop on large screens; phones
/// keep what their cube and screen can use, within their memory budget.
pub fn hdri_map_width(class: DeviceClass) -> u32 {
    match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra | PerformanceTier::High) => crate::hdri::HDRI_MAX_WIDTH,
        (FormFactor::Desktop, _) | (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => 2048,
        (FormFactor::Mobile, _) => 1024,
    }
}

/// The quality of `preset` on `class`: the preset table, the class's caps, its nominal scale and
/// its texture size classes ([`crate::texture::preset_textures`]).
pub fn preset_quality(preset: QualityPreset, class: DeviceClass) -> Quality {
    let mut quality = table_quality(preset, class.form);
    if class.form == FormFactor::Mobile {
        apply_mobile_caps(&mut quality, preset, class);
    }
    cap_shadows(&mut quality.shadows, class);
    cap_lights(&mut quality.lights, class);
    quality.render_scale = class_defaults(class).nominal_scale;
    quality.textures = crate::texture::preset_textures(preset, class);
    quality
}

/// `settings` with its preset choice resolved for `class` (`auto` takes the class's preset;
/// `off` stays the legacy renderer).
pub fn resolve(settings: &RenderSettings, class: DeviceClass) -> RenderSettings {
    let preset = match settings.preset {
        PresetChoice::Preset(preset) => preset,
        PresetChoice::Auto => class_defaults(class).preset,
        _ => return *settings,
    };
    settings.with_quality(settings.preset, preset_quality(preset, class))
}

/// A game's or a person's choices for the sun's shadows: the cascade count, the cascade side, the
/// filter, how far the shadows reach and the cascade blend band. Every key is optional; a set key
/// wins over earlier sources, is held to its range ([`MAX_CASCADES`],
/// [`SHADOW_MAP_MIN_PX`]..=[`SHADOW_MAP_MAX_PX`], [`SHADOW_DISTANCE_MIN_M`]..=[`SHADOW_DISTANCE_MAX_M`],
/// `0..=SHADOW_BLEND_BAND_MAX`) and then to the class's caps ([`cap_shadows`]): a request never
/// passes what the device class may draw. The on/off switch stays [`RenderFeature::Shadows`].
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ShadowOverride {
    /// Cascades, 1 to [`MAX_CASCADES`].
    pub cascades: Option<u8>,
    /// Each cascade's side in texels.
    pub map_size: Option<u32>,
    /// How the maps are filtered.
    pub filter: Option<ShadowFilter>,
    /// How far from the camera the shadows reach, world units.
    pub distance: Option<u16>,
    /// The share of each cascade's depth range blended into the next (0: a hard switch).
    pub blend_band: Option<f32>,
}

impl ShadowOverride {
    /// No choices: the preset's row.
    pub fn new() -> ShadowOverride {
        ShadowOverride::default()
    }

    /// The choices with `cascades` cascades.
    pub fn cascades(mut self, cascades: u8) -> ShadowOverride {
        self.cascades = Some(cascades);
        self
    }

    /// The choices with cascades `map_size` texels wide.
    pub fn map_size(mut self, map_size: u32) -> ShadowOverride {
        self.map_size = Some(map_size);
        self
    }

    /// The choices with `filter`.
    pub fn filter(mut self, filter: ShadowFilter) -> ShadowOverride {
        self.filter = Some(filter);
        self
    }

    /// The choices with shadows reaching `distance` world units from the camera.
    pub fn distance(mut self, distance: u16) -> ShadowOverride {
        self.distance = Some(distance);
        self
    }

    /// The choices with `band` of each cascade's depth range blended into the next.
    pub fn blend_band(mut self, band: f32) -> ShadowOverride {
        self.blend_band = Some(band);
        self
    }

    /// These choices with `later`'s set keys on top.
    pub fn over(self, later: ShadowOverride) -> ShadowOverride {
        ShadowOverride {
            cascades: later.cascades.or(self.cascades),
            map_size: later.map_size.or(self.map_size),
            filter: later.filter.or(self.filter),
            distance: later.distance.or(self.distance),
            blend_band: later.blend_band.or(self.blend_band),
        }
    }

    /// `shadows` with these choices applied, each held to its range (the class's caps come after,
    /// [`cap_shadows`], which also gives a second cascade on a cheap class its far cadence).
    pub fn apply(&self, shadows: &mut ShadowQuality) {
        if let Some(cascades) = self.cascades {
            shadows.cascades = cascades.clamp(1, MAX_CASCADES);
        }
        if let Some(map_size) = self.map_size {
            shadows.map_size = map_size.clamp(SHADOW_MAP_MIN_PX, SHADOW_MAP_MAX_PX);
        }
        if let Some(filter) = self.filter {
            shadows.filter = filter;
        }
        if let Some(distance) = self.distance {
            shadows.distance = distance.clamp(SHADOW_DISTANCE_MIN_M, SHADOW_DISTANCE_MAX_M);
        }
        if let Some(band) = self.blend_band.filter(|band| !band.is_nan()) {
            shadows.blend_percent = (band.clamp(0.0, SHADOW_BLEND_BAND_MAX) * 100.0).round() as u8;
        }
    }
}

/// Quality overrides for one class: a `[render.class.<class>]` table, or the person's saved
/// choice on this device. Every key is optional; a set key wins over earlier sources.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClassOverride {
    /// The preset.
    pub preset: Option<QualityPreset>,
    /// The nominal render scale (clamped to [`RENDER_SCALE_MIN`]..=1).
    pub render_scale: Option<f32>,
    /// The frame-rate target (30 or 60).
    pub fps: Option<u32>,
    /// Feature switches, applied in order after the preset.
    pub switches: Vec<(RenderFeature, bool)>,
    /// The sun's shadow choices (cascades, map size, filter, distance, blend band), applied after
    /// the preset and held to the class's caps.
    pub shadows: ShadowOverride,
    /// TAA's resource knobs while TAA runs (the jitter cycle, the accumulation floor, the texture
    /// LOD bias; RQ5 review): a game's code may ask for ultra's 16-position cycle at `high`, a
    /// steadier floor or sharper textures. Whether TAA runs stays the preset's and the `taa` switch.
    pub taa: Option<TaaQuality>,
}

/// A game's genex.toml `[render]` quality: its preset and its per-class tables.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderOverrides {
    /// `[render] preset` (every class without a table preset).
    pub preset: Option<QualityPreset>,
    /// `[render.class.<class>]` tables.
    pub classes: Vec<(DeviceClass, ClassOverride)>,
    /// Shadow choices that apply only while the resolved preset is the one named (a game asking
    /// for 4 cascades at `high` leaves `low` and `medium` alone), later rows over earlier ones.
    pub shadows: Vec<(QualityPreset, ShadowOverride)>,
}

impl RenderOverrides {
    /// The game-wide shadow choices in force at `preset`.
    pub fn shadows_at(&self, preset: QualityPreset) -> ShadowOverride {
        self.shadows.iter().filter(|(named, _)| *named == preset).fold(ShadowOverride::new(), |merged, (_, row)| merged.over(*row))
    }

    /// The table for `class`, if the game has one.
    pub fn class(&self, class: DeviceClass) -> Option<&ClassOverride> {
        self.classes.iter().find(|(named, _)| *named == class).map(|(_, table)| table)
    }
}

/// Everything a device renders with before dynamic resolution moves it.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct RenderProfile {
    /// The device class.
    pub class: DeviceClass,
    /// The preset in effect.
    pub preset: QualityPreset,
    /// The quality: preset table, caps, switches and render scale.
    pub quality: Quality,
    /// The frame rate held.
    pub target_fps: u32,
    /// The rate under sustained thermal load.
    pub sustained_fps: Option<u32>,
    /// The scene colour format (per class and adapter, never per preset).
    pub scene_format: SceneFormat,
    /// The memory budget.
    pub budget_bytes: u64,
    /// The discrete DRS steps.
    pub drs_steps: &'static [f32],
}

/// The profile of `class` on the device `facts` describe, with the game's genex.toml `game`
/// overrides and the person's `person` choice merged on top, key by key.
pub fn profile(facts: &DeviceFacts, class: DeviceClass, game: &RenderOverrides, person: Option<&ClassOverride>) -> RenderProfile {
    let defaults = class_defaults(class);
    let table = game.class(class);
    let layers = [table, person];
    let chosen = layers.iter().flatten().filter_map(|layer| layer.preset).next_back();
    let preset = chosen.or(game.preset).unwrap_or_else(|| default_preset(class, facts.os));
    let mut quality = preset_quality(preset, class);
    for (feature, on) in layers.iter().flatten().flat_map(|layer| layer.switches.iter()) {
        quality.set_feature(*feature, *on);
    }
    if let Some(taa) = layers.iter().flatten().filter_map(|layer| layer.taa).next_back() {
        quality.taa = taa;
    }
    let asked = layers.iter().flatten().fold(game.shadows_at(preset), |merged, layer| merged.over(layer.shadows));
    asked.apply(&mut quality.shadows);
    cap_shadows(&mut quality.shadows, class);
    cap_lights(&mut quality.lights, class);
    // Occlusion culls meshlet candidates: with meshlets off it has nothing to cull. Its Hi-Z is
    // built from the single-sample prepass, so over a multisampled world pass it would cull
    // meshlets seen only through an edge pixel's uncovered samples: it needs a one-sample world
    // pass ([`occlusion_runs_with`]). The settings must not claim it runs.
    quality.occlusion &= occlusion_runs_with(&quality);
    if let Some(scale) = layers.iter().flatten().filter_map(|layer| layer.render_scale).next_back() {
        quality.render_scale = scale.clamp(RENDER_SCALE_MIN, 1.0);
    }
    let target_fps = layers.iter().flatten().filter_map(|layer| layer.fps).next_back().unwrap_or(defaults.target_fps);
    RenderProfile {
        class,
        preset,
        quality,
        target_fps,
        sustained_fps: defaults.sustained_fps.filter(|fps| *fps < target_fps),
        scene_format: scene_format(class, facts.rg11b10_renderable()),
        budget_bytes: class_budget_bytes(class, facts),
        drs_steps: defaults.drs_steps,
    }
}

/// Numeric per-class ceilings of the work model (`budget::work_model`) at the class's reference
/// resolution and nominal scale.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkLimits {
    /// Off-chip bytes per frame (target stores, loads and resolves).
    pub offchip_bytes: u64,
    /// Passes that touch every pixel at render or output size.
    pub fullscreen_passes: u32,
    /// Texture taps per output pixel.
    pub taps_per_pixel: f32,
}

/// The work-model ceilings of `class`. Off-chip bytes are about 10% of the class's memory
/// bandwidth per frame at its target rate (desktop-ultra 800 GB/s … mobile-mid 15 GB/s at 60 fps:
/// 25 MB), leaving the rest to geometry, textures and thermal headroom.
pub fn work_limits(class: DeviceClass) -> WorkLimits {
    let limits = |mb: u64, fullscreen, taps| WorkLimits { offchip_bytes: mb * 1_000_000, fullscreen_passes: fullscreen, taps_per_pixel: taps };
    match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra) => limits(1333, 10, 200.0),
        (FormFactor::Desktop, PerformanceTier::High) => limits(667, 8, 140.0),
        (FormFactor::Desktop, PerformanceTier::Mid) => limits(333, 6, 80.0),
        (FormFactor::Desktop, PerformanceTier::Low) => limits(83, 3, 32.0),
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => limits(83, 4, 48.0),
        (FormFactor::Mobile, PerformanceTier::Mid) => limits(25, 2, 24.0),
        (FormFactor::Mobile, PerformanceTier::Low) => limits(20, 2, 20.0),
    }
}

/// The most passes a frame of `choice` may open: `off` today's count; `low` draws `off`'s two
/// cascades and adds the exposure compute and the tonemap, its one full-screen pass (plan §2.2:
/// "`low` adds at most one full-screen pass", which [`work_limits`] holds as `fullscreen_passes`;
/// pass-1 gate findings 01 and 02 gave `low` back its second cascade, one depth pass, not a
/// full-screen one).
pub fn render_pass_budget(choice: PresetChoice) -> u32 {
    match choice {
        PresetChoice::Preset(QualityPreset::Low) => OFF_RENDER_PASSES + 2,
        PresetChoice::Preset(QualityPreset::Medium) => OFF_RENDER_PASSES + 7,
        PresetChoice::Preset(QualityPreset::High) => OFF_RENDER_PASSES + 9,
        PresetChoice::Preset(QualityPreset::Ultra) | PresetChoice::Auto => OFF_RENDER_PASSES + 10,
        PresetChoice::Off => OFF_RENDER_PASSES,
    }
}
