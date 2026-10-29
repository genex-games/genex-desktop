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
use genex_gpu_memory::MemoryFacts;
use crate::post::bloom::CHAIN_RESOLUTION;
use crate::post::dof::DofTier;
use crate::foliage::GrassQuality;
use crate::post::motion_blur::MotionBlurTier;
use crate::screen_inputs::ScreenInputs;
use crate::settings::{
    AntiAliasing, AoMethod, AoQuality, AoResolution, BloomQuality, EnvironmentQuality, JitterCycle, LightQuality, LodQuality, PresetChoice, Quality, QualityPreset,
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
/// A phone browser's memory budget never exceeds this, whatever the class.
pub const WEB_BUDGET_CAP_BYTES: u64 = 256 * MIB;
/// A phone browser's budget per GB of `navigator.deviceMemory`.
pub const WEB_BUDGET_PER_DEVICE_GB: u64 = 32 * MIB;
/// A desktop browser's memory budget never exceeds this (Bodycam B1: at 256 MB desktop-high's own
/// `high` at its 1440p reference dropped the froxel fog, and a forced `ultra` AO and TAA as well;
/// with its material arrays `ultra` at 1440p asks about 850 MB).
pub const WEB_DESKTOP_BUDGET_CAP_BYTES: u64 = 1024 * MIB;
/// A desktop browser's budget per GB of `deviceMemory`, whatever its class (as a native desktop's
/// follows its GPU-visible memory): Chrome reports at most 8 (512 MB: `high` keeps every feature at
/// 1440p), Studio's Electron the machine's (1 GB from 16 GB: `ultra` keeps every feature).
pub const WEB_DESKTOP_BUDGET_PER_DEVICE_GB: u64 = 64 * MIB;
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
/// The farthest a mid or low tier phone draws the sun's shadows, world units, whatever the preset
/// or the request (the legacy reach: 50 units measured +0.03 ms GPU p95 on the mobile-high proxy,
/// at its line).
pub const MOBILE_MAX_SHADOW_DISTANCE_M: u16 = 40;
/// The farthest a high or ultra tier phone draws the sun's shadows, world units: desktop `high`'s
/// reach (release R-13), so each preset keeps its own row there (`medium` 50 units, its default;
/// `high` and `ultra` 80). At 40 units an elevated game camera saw its near houses and trees past
/// the reach or inside the end fade on mobile-high (frontier, stream-valley). Raising the default
/// `medium` to 80 cost the mobile-high proxy about 1.5 ms GPU p95, so it stays the preset's.
pub const MOBILE_HIGH_SHADOW_DISTANCE_M: u16 = HIGH_REACH.distance;

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
/// The largest reflection-probe cube a desktop or browser captures (renderer pass 2 A.3,
/// `probes::probe_side`: the sky cube's side, at most this): ultra's 512 px HDRI cube is the sky's
/// alone; a probe there holds a 256 px cube (4.2 MB with its mips).
pub const PROBE_SIDE_MAX_PX: u32 = 256;
/// The largest reflection-probe cube a phone captures (1.05 MB with its mips).
pub const MOBILE_PROBE_SIDE_MAX_PX: u32 = 128;
/// Reflection probes given a cube per desktop preset (low, medium, high and ultra).
pub const PROBES_PER_PRESET: [u8; 4] = [4, 8, 16, 16];
/// The most reflection probes a phone of each tier (low, mid, high, ultra) gives a cube, whatever
/// the preset asks (plan A.3: 2 on mobile-low, 4 on mobile-mid).
pub const MOBILE_PROBES_PER_TIER: [u8; 4] = [2, 4, 8, 8];
/// Irradiance volumes baked per desktop and browser preset (low, medium, high and ultra; renderer
/// pass 2 A.4: medium and up).
pub const VOLUMES_PER_PRESET: [u8; 4] = [0, 4, 8, 8];
/// Volume cells a Live frame bakes on `ultra` (AAA review WP-12; the other presets and phones bake
/// `irradiance::CELLS_PER_FRAME`: two cells measured 0.85 ms a frame at 1080p on an M4 Max with the
/// four-cell slice, past the bake row's 0.5 ms, so high keeps two).
pub const ULTRA_CELLS_PER_FRAME: u8 = 4;
/// The most irradiance volumes a phone of each tier (low, mid, high, ultra) bakes at `high` and
/// `ultra` (plan A.4: none on mobile-low, which keeps the sky's SH9; D16: none at a phone's
/// `medium` or `low`).
pub const MOBILE_VOLUMES_PER_TIER: [u8; 4] = [0, 2, 4, 4];
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

/// The most pixels a Live frame of `class` renders when it upscales temporally to a larger output
/// (lane UP, the owner's AAA call: render at a budget, TAAU-upscale to the window's own pixels):
/// its reference resolution's, the size its ledger, work model and frame budgets were set at.
pub fn render_pixel_budget(class: DeviceClass) -> u64 {
    let (width, height) = reference_resolution(class);
    u64::from(width) * u64::from(height)
}

/// The most output pixels a Live frame of `class` upscaled to the window draws: four times its
/// render budget, where the budget's scale reaches [`RENDER_SCALE_MIN`] (a 5K panel for a
/// 2560x1440 budget). A larger window is drawn at this many pixels and the window present upscales
/// the rest.
pub fn native_output_cap_px(class: DeviceClass) -> u64 {
    let floor = f64::from(RENDER_SCALE_MIN);
    (render_pixel_budget(class) as f64 / (floor * floor)) as u64
}

/// Whether Live frames of `quality` on `class` under `os` draw at the window's own pixels (up to
/// [`native_output_cap_px`]) and reach them by TAA upscaling from at most
/// [`render_pixel_budget`] rendered pixels: a native desktop (macOS, Windows, Linux) whose quality
/// draws TAA with `taau` on the HDR scene. Elsewhere (the web's memory budget, phones, presets
/// without TAAU) Live draws at the class's reference pixels and the window present upscales.
pub fn upscales_to_native(quality: &Quality, class: DeviceClass, os: TargetOs) -> bool {
    let native_desktop = matches!(os, TargetOs::MacOs | TargetOs::Windows | TargetOs::Linux) && class.form == FormFactor::Desktop;
    let temporal = quality.hdr && quality.taau && quality.anti_aliasing == AntiAliasing::Taa;
    native_desktop && temporal
}

/// The render scale at which `output` renders at most `budget_px` pixels: the square root of their
/// ratio, a whole number of 1/32 steps at or below it, at most 1 and at least
/// [`RENDER_SCALE_MIN`].
pub fn budget_scale(output: (u32, u32), budget_px: u64) -> f32 {
    let pixels = u64::from(output.0.max(1)) * u64::from(output.1.max(1));
    if pixels <= budget_px {
        return 1.0;
    }
    let side = (budget_px as f64 / pixels as f64).sqrt() as f32;
    let quantum = crate::drs::SCALE_QUANTUM;
    ((side / quantum).floor() * quantum).clamp(RENDER_SCALE_MIN, 1.0)
}

/// The most render pixels a screen effect of `class` computes at its full resolution (lane UP):
/// past them it runs at half resolution with its upsample, so its cost stops growing with the
/// screen. A laptop panel's (1080p) on a desktop, where ultra's AO budget (1.5 ms) was measured;
/// a phone's own reference (its presets run half-resolution AO already).
pub fn screen_effect_budget_px(class: DeviceClass) -> u64 {
    let (width, height) = match class.form {
        FormFactor::Desktop => LAPTOP_REFERENCE,
        FormFactor::Mobile => reference_resolution(class),
    };
    u64::from(width) * u64::from(height)
}

/// `quality` with its screen effects held to `class`'s [`screen_effect_budget_px`] at a frame of
/// `render` pixels: full-resolution AO runs at half resolution past the budget (the joint-bilateral
/// upsample, guided by depth and normals, brings it to the render size). Everything else is as
/// asked: SSR traces at half the render size and bloom's chain starts at most 540 rows already.
pub fn effect_budgeted(quality: &Quality, class: DeviceClass, render: (u32, u32)) -> Quality {
    let mut budgeted = *quality;
    let pixels = u64::from(render.0) * u64::from(render.1);
    if quality.ao.resolution == AoResolution::Full && pixels > screen_effect_budget_px(class) {
        budgeted.ao.resolution = AoResolution::Half;
    }
    budgeted
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
/// a desktop class takes [`WEB_DESKTOP_BUDGET_PER_DEVICE_GB`] per GB of `deviceMemory` up to
/// [`WEB_DESKTOP_BUDGET_CAP_BYTES`] whatever its class's, a phone's the class's at most
/// [`WEB_BUDGET_CAP_BYTES`] and [`WEB_BUDGET_PER_DEVICE_GB`] per GB (a missing hint reads as 4 GB:
/// 256 and 128 MB). Phones keep the class's: memory pressure kills apps.
pub fn class_budget_bytes(class: DeviceClass, facts: &DeviceFacts) -> u64 {
    let budget = class_defaults(class).budget_bytes;
    match facts.os {
        TargetOs::Web => {
            let gb = f64::from(facts.web.unwrap_or_default().device_memory_gb());
            match class.form {
                FormFactor::Desktop => ((gb * WEB_DESKTOP_BUDGET_PER_DEVICE_GB as f64) as u64).min(WEB_DESKTOP_BUDGET_CAP_BYTES),
                FormFactor::Mobile => budget.min(WEB_BUDGET_CAP_BYTES).min((gb * WEB_BUDGET_PER_DEVICE_GB as f64) as u64),
            }
        }
        TargetOs::MacOs | TargetOs::Windows | TargetOs::Linux => {
            let by_memory = facts.gpu_visible_memory_bytes.map_or(0, |bytes| (bytes / DESKTOP_BUDGET_MEMORY_DIVISOR).min(DESKTOP_BUDGET_MEMORY_CAP_BYTES));
            budget.max(by_memory)
        }
        TargetOs::Ios | TargetOs::Android => budget,
    }
}

/// Streamed upload bytes a desktop frame may write, by tier: ultra, high, mid, low.
pub const STREAM_UPLOAD_DESKTOP_BYTES: [u64; 4] = [24 * MIB, 16 * MIB, 8 * MIB, 6 * MIB];
/// Streamed upload bytes a phone frame may write, by tier: high (and ultra), mid, low.
pub const STREAM_UPLOAD_PHONE_BYTES: [u64; 3] = [4 * MIB, 3 * MIB, 2 * MIB];
/// Streamed upload bytes a browser frame may write at most, whatever its class.
pub const STREAM_UPLOAD_WEB_BYTES: u64 = 8 * MIB;

/// What a frame may spend on streamed work (game systems STR-5): the soft upload queue's bytes
/// ([`crate::upload_queue::UploadQueue::drain`]) and the frame thread's finishing milliseconds
/// ([`crate::jobs::finish_budget_ms`]). Both are soft: an asset larger than the bytes still goes,
/// alone in its frame. The hard per-frame table cap, [`crate::caps::UPLOAD_MAX_BYTES_PER_FRAME`],
/// is a separate refusal and does not move.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamBudget {
    /// Streamed upload bytes per frame.
    pub upload_bytes: u64,
    /// Milliseconds of frame-thread finishing per frame.
    pub finish_ms: f64,
}

/// The stream budget of `class` on `os`: the class's row; on the web at most
/// [`STREAM_UPLOAD_WEB_BYTES`] (a phone browser keeps its smaller phone row). `mobile-ultra` takes
/// `mobile-high`'s.
pub fn stream_budget(class: DeviceClass, os: TargetOs) -> StreamBudget {
    let row = match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra) => STREAM_UPLOAD_DESKTOP_BYTES[0],
        (FormFactor::Desktop, PerformanceTier::High) => STREAM_UPLOAD_DESKTOP_BYTES[1],
        (FormFactor::Desktop, PerformanceTier::Mid) => STREAM_UPLOAD_DESKTOP_BYTES[2],
        (FormFactor::Desktop, PerformanceTier::Low) => STREAM_UPLOAD_DESKTOP_BYTES[3],
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => STREAM_UPLOAD_PHONE_BYTES[0],
        (FormFactor::Mobile, PerformanceTier::Mid) => STREAM_UPLOAD_PHONE_BYTES[1],
        (FormFactor::Mobile, PerformanceTier::Low) => STREAM_UPLOAD_PHONE_BYTES[2],
    };
    let upload_bytes = if os == TargetOs::Web { row.min(STREAM_UPLOAD_WEB_BYTES) } else { row };
    StreamBudget { upload_bytes, finish_ms: crate::jobs::finish_budget_ms(class) }
}

/// The streamed content pool of a desktop, by tier: ultra, high, mid, low (owner call S8). Ultra
/// and high grow with GPU-visible memory ([`STREAM_POOL_ULTRA_MEMORY_DIVISOR`],
/// [`STREAM_POOL_HIGH_MEMORY_DIVISOR`]) up to [`STREAM_POOL_DESKTOP_MAX_BYTES`].
pub const STREAM_POOL_DESKTOP_BYTES: [u64; 4] = [1536 * MIB, 768 * MIB, 384 * MIB, 256 * MIB];
/// The streamed content pool of a phone, by tier: high (and ultra), mid, low.
pub const STREAM_POOL_PHONE_BYTES: [u64; 3] = [320 * MIB, 192 * MIB, 96 * MIB];
/// A desktop-ultra pool may grow to this share of GPU-visible memory (one sixth)...
pub const STREAM_POOL_ULTRA_MEMORY_DIVISOR: u64 = 6;
/// ...a desktop-high pool to this share (one eighth)...
pub const STREAM_POOL_HIGH_MEMORY_DIVISOR: u64 = 8;
/// ...and neither past this ceiling (high never grows past ultra's cap).
pub const STREAM_POOL_DESKTOP_MAX_BYTES: u64 = 3 * GIB;
/// A browser's pool is at most this...
pub const STREAM_POOL_WEB_CAP_BYTES: u64 = 384 * MIB;
/// ...and this per GB of `navigator.deviceMemory`...
pub const STREAM_POOL_WEB_PER_DEVICE_GB: u64 = 48 * MIB;
/// ...or this when the browser hides `deviceMemory` (Safari, Firefox).
pub const STREAM_POOL_WEB_UNKNOWN_BYTES: u64 = 192 * MIB;
/// The share of a phone's pool it keeps under memory pressure, in percent.
pub const STREAM_POOL_PRESSURE_PERCENT: u64 = 60;

/// The streamed content pool of `class` on the device `facts` and `memory` describe (game systems
/// STR-7, owner call S8): the bytes of view-set GPU content (the mesh arena, streamed texture
/// layers and terrain tiles) the residency policy may keep. It sits beside the render budget
/// ([`class_budget_bytes`]); the sim's CPU cap is one number for every class.
/// - A desktop takes its tier's row; ultra and high grow with GPU-visible memory.
/// - A browser takes min([`STREAM_POOL_WEB_CAP_BYTES`], [`STREAM_POOL_WEB_PER_DEVICE_GB`] per GB),
///   [`STREAM_POOL_WEB_UNKNOWN_BYTES`] without `deviceMemory`, never above its desktop tier's row;
///   a phone browser (a mobile class, or hints that say phone) takes the phone pool.
/// - A phone takes its tier's row, at most Android's memory class, cut to
///   [`STREAM_POOL_PRESSURE_PERCENT`] when the OS asks it to shed memory (a trim level of
///   `RUNNING_LOW` or worse, a low-memory signal) or when iOS's headroom is below the pool.
///
/// A missing fact keeps the class default; D16 applies, so a device that cannot fit sheds the
/// view set and the pool is never raised.
pub fn stream_pool_bytes(class: DeviceClass, facts: &DeviceFacts, memory: &MemoryFacts) -> u64 {
    let phone_browser = facts.os == TargetOs::Web && facts.web.is_some_and(|hints| hints.is_mobile());
    if class.form == FormFactor::Mobile || phone_browser {
        return phone_pool_bytes(class.tier, facts.os, memory);
    }
    let row = desktop_pool_bytes(class.tier, facts.gpu_visible_memory_bytes);
    if facts.os != TargetOs::Web {
        return row;
    }
    let by_memory = match facts.web.and_then(|hints| hints.device_memory_gb) {
        Some(gb) if gb.is_finite() && gb > 0.0 => (f64::from(gb) * STREAM_POOL_WEB_PER_DEVICE_GB as f64) as u64,
        _ => STREAM_POOL_WEB_UNKNOWN_BYTES,
    };
    row.min(STREAM_POOL_WEB_CAP_BYTES).min(by_memory)
}

/// A desktop tier's pool: the row, and for ultra and high their share of GPU-visible memory up to
/// [`STREAM_POOL_DESKTOP_MAX_BYTES`].
fn desktop_pool_bytes(tier: PerformanceTier, gpu_visible: Option<u64>) -> u64 {
    let (row, divisor) = match tier {
        PerformanceTier::Ultra => (STREAM_POOL_DESKTOP_BYTES[0], Some(STREAM_POOL_ULTRA_MEMORY_DIVISOR)),
        PerformanceTier::High => (STREAM_POOL_DESKTOP_BYTES[1], Some(STREAM_POOL_HIGH_MEMORY_DIVISOR)),
        PerformanceTier::Mid => (STREAM_POOL_DESKTOP_BYTES[2], None),
        PerformanceTier::Low => (STREAM_POOL_DESKTOP_BYTES[3], None),
    };
    let grown = gpu_visible.zip(divisor).map_or(0, |(bytes, divisor)| (bytes / divisor).min(STREAM_POOL_DESKTOP_MAX_BYTES));
    row.max(grown)
}

/// A phone tier's pool on `os`: the row, at most the memory class, cut under pressure (native
/// phones only: a browser reports no pressure).
fn phone_pool_bytes(tier: PerformanceTier, os: TargetOs, memory: &MemoryFacts) -> u64 {
    let row = match tier {
        PerformanceTier::Ultra | PerformanceTier::High => STREAM_POOL_PHONE_BYTES[0],
        PerformanceTier::Mid => STREAM_POOL_PHONE_BYTES[1],
        PerformanceTier::Low => STREAM_POOL_PHONE_BYTES[2],
    };
    if os == TargetOs::Web {
        return row;
    }
    let capped = memory.memory_class_bytes().map_or(row, |class_bytes| row.min(class_bytes));
    let short_headroom = memory.available_bytes.is_some_and(|available| available < row);
    if memory.under_pressure() || short_headroom { capped * STREAM_POOL_PRESSURE_PERCENT / 100 } else { capped }
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
    // Bevy's one-pass blur (A.9); high and ultra take KinoMotion's reconstruction. The look's
    // switch decides whether either runs.
    quality.motion_blur = MotionBlurTier::Direct;
    match preset {
        QualityPreset::Low => low_row(&mut quality, form),
        QualityPreset::Medium => medium_row(&mut quality),
        QualityPreset::High => high_row(&mut quality),
        QualityPreset::Ultra => ultra_row(&mut quality, form),
    }
    // A.8: the terrain's grass (phones' caps lower it, `apply_mobile_caps`).
    quality.grass = match preset {
        QualityPreset::Low => GrassQuality::OFF,
        QualityPreset::Medium => GrassQuality::MEDIUM,
        QualityPreset::High => GrassQuality::HIGH,
        QualityPreset::Ultra => GrassQuality::ULTRA,
    };
    // Game systems LOD-06 (owner call L6): 1 px on high and ultra, coarser below (phones take
    // their tier's floor, `apply_mobile_caps`).
    quality.lod = match preset {
        QualityPreset::Low => LodQuality::LOW,
        QualityPreset::Medium => LodQuality::MEDIUM,
        QualityPreset::High | QualityPreset::Ultra => LodQuality::HIGH,
    };
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
        reflection_probes: 0,
        probe_side_max: PROBE_SIDE_MAX_PX,
        continuous_sky: false,
        irradiance_volumes: 0,
        irradiance_leak_control: true,
        irradiance_cells_per_frame: crate::irradiance::CELLS_PER_FRAME as u8,
        irradiance_relight: false,
        auto_rooms: crate::irradiance::AutoRooms::OFF,
        froxel_fog: None,
        clouds: None,
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
    LightQuality { cap, clustered: true, tile_px, shadowed_spots, shadowed_points: 0, decals: crate::decals::DESKTOP_DECALS }
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
/// The least RCAS softness (in stops) a phone's upscale sharpens with at any preset: EASU from
/// 0.6-0.75 of the output and RCAS's default 0.2 stops sharpened a far deck's sub-pixel plank seams
/// into a dot pattern (Lakeside dock on mobile-mid, 1.06% of the far deck; GA leftovers). At TAA's
/// own sharpen's softness the seams stay lines (0.42%), the picture otherwise the same.
pub const MOBILE_RCAS_SHARPNESS: f32 = TAA_SHARPEN_RCAS_SHARPNESS;
const MOBILE_LOW_ANISOTROPY: u8 = 2;

fn low_row(quality: &mut Quality, form: FormFactor) {
    quality.anti_aliasing = AntiAliasing::Msaa4;
    quality.anisotropy = LOW_ANISOTROPY;
    quality.exposure_input_divisor = 16;
    quality.environment = environment(64, (64, 36), 8, 20, false);
    quality.environment.reflection_probes = PROBES_PER_PRESET[0];
    quality.environment.irradiance_volumes = VOLUMES_PER_PRESET[0];
    // Two cascades (pass-1 gate findings 01, 01b and 02): one 1024 px cascade over 50 units has
    // 8 cm texels under a 45° camera (9 cm for a phone's 768 px over 40), so a figure's legs
    // washed out of its shadow, which stood 30 px off the feet, and a block's shadow lost a wedge
    // under its corner and came out short and stair-stepped (the normal offset and the filter
    // span a texel or more). The near cascade holds 2 cm texels over the first 11 units for one
    // more depth pass (the far one redraws every other frame on the low tier and phones,
    // `cap_shadows`). A phone's two are [`MOBILE_LOW_PRESET_SHADOW_MAP_PX`] (the weakest phone's
    // [`MOBILE_LOW_SHADOW_MAP_PX`]).
    // Desktops filter 5x5 (one hardware tap stair-steps the texels, for about 0.1 ms at 1080p, and
    // 3x3 left a straight edge 0.37 texels off its line, D22; the 5x5 reads nine gathers where
    // 3x3 read nine taps); phones keep the one tap.
    let (filter, map_size) = match form {
        FormFactor::Desktop => (ShadowFilter::Pcf5x5, 1024),
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
    // B.5: the cloud panorama from medium up (low draws a clear sky).
    quality.environment.clouds = Some(crate::clouds::MEDIUM_GRID);
    quality.environment.reflection_probes = PROBES_PER_PRESET[1];
    quality.environment.irradiance_volumes = VOLUMES_PER_PRESET[1];
    // AAA review WP-12: a declared room's probe gets its volume and its volume its probe, baked
    // once; the camera's own volume and the relight start at high.
    quality.environment.auto_rooms = crate::irradiance::AutoRooms::PAIRED;
    // 5x5 PCF (release R-13, D22): 3x3 drew a straight edge's texel staircase (0.37 texels off its
    // line against 0.16) for the same nine reads.
    quality.shadows = shadows(2, 1536, ShadowFilter::Pcf5x5, ShadowFormat::Depth32, &MEDIUM_REACH);
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
    quality.environment.reflection_probes = PROBES_PER_PRESET[2];
    quality.environment.irradiance_volumes = VOLUMES_PER_PRESET[2];
    // AAA review WP-12, dynamic probe GI: rooms paired and a volume around the camera wherever
    // no declared room holds it, baked two cells a frame and baked again for as long as they are
    // held, a relight batch every `irradiance::RELIGHT_CADENCE` frames (ultra four cells). Software
    // rays (D8) stay out: their cheapest update measured 10.9 ms on an M1-class GPU.
    quality.environment.auto_rooms = crate::irradiance::AutoRooms::ALL;
    quality.environment.irradiance_relight = true;
    // SI-02 step 2: a moving sun's cube follows it every frame (a whole rebake at the continuous
    // sample count; phones keep the time-sliced cycle).
    quality.environment.continuous_sky = true;
    // A.5: the froxel fog (sun shafts); medium keeps the analytic fog and the aerial volume.
    quality.environment.froxel_fog = Some(crate::froxel::HIGH_GRID);
    quality.environment.clouds = Some(crate::clouds::HIGH_GRID);
    quality.shadows = shadows(3, 2048, ShadowFilter::PcssLite, ShadowFormat::Depth32, &HIGH_REACH);
    quality.contact_shadows = true;
    // AAA push P3: local exposure, so a sunlit window and the corridor around it both read (ultra
    // inherits it).
    quality.local_exposure = true;
    quality.bloom = BloomQuality { enabled: true, resolution: CHAIN_RESOLUTION };
    quality.ao = AoQuality { resolution: AoResolution::Half, slices: 2, steps: 6, temporal: true };
    // B.4: the visibility bitmask (no halo behind thin objects; ultra adds its GI). Medium keeps
    // XeGTAO's horizons within its 0.6 ms; phones keep them too (`apply_mobile_caps`).
    quality.ao_method = AoMethod::Bitmask;
    // Four shadowed spots (AAA review WP-15: a room's fixtures cast shadows; was two): the atlas is
    // one layer whatever the count, so only the four maps' draws are added. One shadowed point
    // light (a bare bulb, a lantern): six faces in the point layer after the spot atlas.
    quality.lights = lights(1024, 16, 4);
    quality.lights.shadowed_points = 1;
    // Filament's ring gather (A.9; ultra inherits it): the look's switch decides whether it runs.
    quality.dof = DofTier::Ring;
    quality.motion_blur = MotionBlurTier::Reconstruction;
    // A.6: the screen inputs Stage B's water and screen-space reflections read (ultra inherits them).
    quality.screen_inputs = ScreenInputs::ALL;
    // B.9: Hi-Z screen-space reflections over those inputs (ultra takes more steps).
    quality.ssr = crate::ssr::SsrQuality::HIGH;
    // B.8: below scale 1 TAA resolves at output size (ultra inherits it).
    quality.taau = true;
    with_geometry_features(quality);
}

fn ultra_row(quality: &mut Quality, form: FormFactor) {
    high_row(quality);
    // Plain TAA, as `high` (release R-13, D9/D12): RCAS after TAA at scale 1 (`TaaSharpen`, 0.75
    // stops) lifted sub-pixel canopy specks under the shadows past the pop threshold for one frame
    // (the Lakeside's ultra pan and orbit rows: 1 and 2 px; 0 without it, and at 1.25 stops still
    // 1), and the RQ5 review had already found it turning the noise TAA cannot integrate into
    // grain. A game may still ask for `TaaSharpen`.
    quality.anti_aliasing = AntiAliasing::Taa;
    // Sixteen jitter positions (plan §2.7): a settled capture on ultra re-renders sixteen times.
    quality.taa = quality.taa.with_jitter_cycle(JitterCycle::Sixteen);
    // An HDR map's detail is worth a 512 px cube on ultra (plan §2.4); the smooth sky is not.
    quality.environment.hdri_cube_size = ULTRA_HDRI_CUBE_PX;
    quality.environment.reflection_probes = PROBES_PER_PRESET[3];
    quality.environment.irradiance_volumes = VOLUMES_PER_PRESET[3];
    quality.environment.irradiance_cells_per_frame = ULTRA_CELLS_PER_FRAME;
    quality.environment.froxel_fog = Some(crate::froxel::ULTRA_GRID);
    quality.environment.clouds = Some(crate::clouds::ULTRA_GRID);
    let map_size = if form == FormFactor::Desktop { 4096 } else { 2048 };
    quality.shadows = shadows(4, map_size, ShadowFilter::Pcss, ShadowFormat::Depth32, &ULTRA_REACH);
    // Three slices of eight steps at full resolution with history. The unbiased estimate (gate
    // finding 03: each slice measured against its unoccluded arc, every sample slid back onto its
    // slice) costs about a fifth more a step: 3 x 8 measured 1.38 ms (M4 Max, 1080p), so the owner
    // raised ultra's AO budget to 1.5 ms (2026-10-12; plan §2.5 had 1.2) rather than halve the steps.
    quality.ao = AoQuality { resolution: AoResolution::Full, slices: 3, steps: 8, temporal: true };
    // B.4's screen-space GI, the light of what the bitmask hides (look integration). Not at high:
    // its terms hold the light (`ao::target_bytes_shaped`), +18.4 MB at 1440p, and desktop-high's
    // default with its texture arrays would pass its 512 MiB budget (553.7 MB); like D16, a preset
    // fits its budget by its defaults, not by a larger budget (AAA review WP-12 tried high and the
    // integrator kept it on ultra until the owner measures a larger budget).
    quality.ao_method = AoMethod::BitmaskGi;
    // Two shadowed point lights (AAA review WP-15).
    quality.lights = lights(1024, 16, 4);
    quality.lights.shadowed_points = crate::layout::MAX_SHADOWED_POINTS as u8;
    quality.ssr = crate::ssr::SsrQuality::ULTRA;
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
/// cascades of 1536 px with 5x5 PCF in place of PCSS (the weakest phone class 512 px ones) up to
/// [`MOBILE_MAX_SHADOW_DISTANCE_M`] ([`MOBILE_HIGH_SHADOW_DISTANCE_M`] on the high and ultra
/// tiers); phones and the low tier draw `Depth16Unorm` cascades and redraw far cascades every
/// [`CHEAP_CLASS_FAR_CADENCE`]th frame. Desktop ultra, high and mid keep
/// `Depth32` and every-frame cascades.
pub fn cap_shadows(shadows: &mut ShadowQuality, class: DeviceClass) {
    let mobile = class.form == FormFactor::Mobile;
    if mobile {
        shadows.distance = shadows.distance.min(mobile_shadow_distance_max(class));
        if matches!(shadows.filter, ShadowFilter::Pcss | ShadowFilter::PcssLite) {
            shadows.filter = ShadowFilter::Pcf5x5;
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

/// The farthest `class`, a phone, draws the sun's shadows, world units: a high or ultra tier
/// phone [`MOBILE_HIGH_SHADOW_DISTANCE_M`], the others [`MOBILE_MAX_SHADOW_DISTANCE_M`].
fn mobile_shadow_distance_max(class: DeviceClass) -> u16 {
    if class.tier >= PerformanceTier::High { MOBILE_HIGH_SHADOW_DISTANCE_M } else { MOBILE_MAX_SHADOW_DISTANCE_M }
}

/// The local-light caps of `class` (plan §2.4, RQ6 review), for any preset and any request: with
/// the `clustered` switch off the per-pixel loop shades at most [`UNCLUSTERED_MAX_LIGHTS`] lights
/// ([`MOBILE_UNCLUSTERED_MAX_LIGHTS`] on a phone); phones bin at most [`MOBILE_MAX_LIGHTS`] lights
/// in tiles of at least [`MOBILE_MIN_LIGHT_TILE_PX`], shade one shadowed spot on the high and
/// ultra phone classes, none below, and draw at most `decals::MOBILE_DECALS` decals (renderer
/// pass 2 A.10). Desktops keep the preset's binned caps. The legacy renderer's
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
    // A phone draws no point light's cube (six maps; unmeasured there, D16).
    lights.shadowed_points = 0;
    lights.decals = lights.decals.min(crate::decals::MOBILE_DECALS);
}

/// Mobile and tile caps (plan §2.4), for any preset on a mobile class.
fn apply_mobile_caps(quality: &mut Quality, preset: QualityPreset, class: DeviceClass) {
    // Every phone class draws below scale 1 (0.6-0.75) and a bilinear upscale stair-steps thin
    // edges there, so phones upscale with EASU + RCAS at every preset (owner decision 2026-10-12;
    // its cost on the Mac mobile proxy is in the showcase's `metal_mobile_proxy` row). EASU and
    // RCAS run only while the render size differs from the output.
    quality.upscaler = Upscaler::Fsr1;
    quality.rcas = quality.rcas.with_sharpness(quality.rcas.sharpness.max(MOBILE_RCAS_SHARPNESS));
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
    // A.4: phones read a volume's ambient cube in three trilinear fetches, no leak control. Owner
    // decision D16: the bake's time slice alone measured +1.9 ms on the mobile-high proxy (an
    // eighth of the frame is 2.083 ms), so a phone bakes volumes only at `high` and `ultra`, a
    // person's or game's choice; its own preset (medium or low) keeps the sky's SH9.
    let tier_volumes = MOBILE_VOLUMES_PER_TIER[PerformanceTier::ALL.iter().position(|tier| *tier == class.tier).unwrap_or(0)];
    let phone_volumes = if preset >= QualityPreset::High { tier_volumes } else { 0 };
    quality.environment.irradiance_volumes = quality.environment.irradiance_volumes.min(phone_volumes);
    quality.environment.irradiance_leak_control = false;
    // AAA review WP-12: a phone pairs declared rooms but bakes no camera volume, at the desktop's
    // medium slice, and never bakes again on its own (D16: the slice alone is +1.9 ms there).
    quality.environment.auto_rooms = crate::irradiance::AutoRooms { camera: false, ..quality.environment.auto_rooms };
    quality.environment.irradiance_cells_per_frame = crate::irradiance::CELLS_PER_FRAME as u8;
    quality.environment.irradiance_relight = false;
    // A.5: phones keep the analytic fog until the froxel fog is measured on them (mobile-high only,
    // behind that measurement).
    quality.environment.froxel_fog = None;
    // B.5: no cloud panorama on phones until it is measured on them (mobile-high only, behind that
    // measurement; owner decision D16: a feature that cannot be shown to fit is off on phones).
    quality.environment.clouds = None;
    // Ten passes of Filament's ring gather are a desktop's: phones take Godot's circular gather.
    quality.dof = DofTier::Circular;
    // Phones blur in one pass, and the low-tier phone not at all (the plan's "off on mobile-low").
    quality.motion_blur = if class.tier == PerformanceTier::Low { MotionBlurTier::Off } else { MotionBlurTier::Direct };
    // Phones keep XeGTAO's horizons: the bitmask's and its GI's cost on a phone is unmeasured
    // (B.4; owner decision D16: what cannot be shown to fit is off on phones).
    quality.ao_method = AoMethod::Horizons;
    // No screen inputs on phones (B.3's water reflects the probes or the sky there).
    quality.screen_inputs = ScreenInputs::NONE;
    // Nor screen-space reflections (B.9): the probes or the sky reflect on phones.
    quality.ssr = crate::ssr::SsrQuality::OFF;
    // A.8: grass on the high phones at `high` and `ultra` only, at a capped density (overdraw is a
    // tile GPU's cost); none elsewhere on phones.
    let phone_grass = class.tier >= PerformanceTier::High && preset >= QualityPreset::High;
    quality.grass = if phone_grass { GrassQuality::MOBILE } else { GrassQuality::OFF };
    cap_lod(&mut quality.lod, class);
}

/// The LOD floor of a phone tier (owner call L6): 2, 2.5 and 3 px, and at most half, then about a
/// third, of the far-field copies. Desktops have none.
pub fn phone_lod_floor(class: DeviceClass) -> Option<LodQuality> {
    match (class.form, class.tier) {
        (FormFactor::Desktop, _) => None,
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => Some(LodQuality::MOBILE_HIGH),
        (FormFactor::Mobile, PerformanceTier::Mid) => Some(LodQuality::MOBILE_MID),
        (FormFactor::Mobile, _) => Some(LodQuality::MOBILE_LOW),
    }
}

/// `lod` held to `class`'s floor: on a phone no finer a threshold and no more far copies than its
/// tier's row ([`phone_lod_floor`]), whatever the preset; the band and impostors stay.
pub fn cap_lod(lod: &mut LodQuality, class: DeviceClass) {
    if let Some(floor) = phone_lod_floor(class) {
        lod.threshold_px = lod.threshold_px.max(floor.threshold_px);
        lod.far_density = lod.far_density.min(floor.far_density);
    }
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

/// How far a game's or a person's LOD threshold may move from the preset's, each way: half to twice
/// (the panel's "Detail distance" row spans the same).
pub const LOD_THRESHOLD_SCALE_MIN: f32 = 0.5;
/// See [`LOD_THRESHOLD_SCALE_MIN`].
pub const LOD_THRESHOLD_SCALE_MAX: f32 = 2.0;

/// A game's or a person's level-of-detail choices (game systems LOD-06, D19): the threshold, the
/// crossfade band, impostors and the far-field density. Every key is optional; a set key wins over
/// earlier sources and is held to its range ([`LodQuality::with_threshold_px`] and siblings), the
/// threshold also to half..twice the preset's ([`LOD_THRESHOLD_SCALE_MIN`]..=[`LOD_THRESHOLD_SCALE_MAX`]).
/// The `lod-fade` and `impostors` switches apply after, so either turns its feature off alone.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LodOverride {
    /// The error a drawn level may show, output pixels.
    pub threshold_px: Option<f32>,
    /// The crossfade band, a share of the threshold (0: hard switches).
    pub fade_band: Option<f32>,
    /// Whether impostors draw.
    pub impostors: Option<bool>,
    /// The share of far-field copies kept.
    pub far_density: Option<f32>,
}

impl LodOverride {
    /// No choices: the preset's row.
    pub fn new() -> LodOverride {
        LodOverride::default()
    }

    /// The choices with a threshold of `pixels` output pixels.
    pub fn threshold_px(mut self, pixels: f32) -> LodOverride {
        self.threshold_px = Some(pixels);
        self
    }

    /// The choices with a crossfade band of `band` (a share of the threshold; 0: hard switches).
    pub fn fade_band(mut self, band: f32) -> LodOverride {
        self.fade_band = Some(band);
        self
    }

    /// The choices with impostors on or off.
    pub fn impostors(mut self, on: bool) -> LodOverride {
        self.impostors = Some(on);
        self
    }

    /// The choices keeping `density` of the far-field copies.
    pub fn far_density(mut self, density: f32) -> LodOverride {
        self.far_density = Some(density);
        self
    }

    /// These choices with `later`'s set keys on top.
    pub fn over(self, later: LodOverride) -> LodOverride {
        LodOverride {
            threshold_px: later.threshold_px.or(self.threshold_px),
            fade_band: later.fade_band.or(self.fade_band),
            impostors: later.impostors.or(self.impostors),
            far_density: later.far_density.or(self.far_density),
        }
    }

    /// `lod` (the preset's, after the class's floor) with these choices applied, each held to its
    /// range; the threshold also to half..twice the preset's, then to the class's floor.
    pub fn apply(&self, lod: &mut LodQuality, class: DeviceClass) {
        let preset = *lod;
        if let Some(pixels) = self.threshold_px.filter(|pixels| !pixels.is_nan()) {
            let low = preset.threshold_px * LOD_THRESHOLD_SCALE_MIN;
            let high = preset.threshold_px * LOD_THRESHOLD_SCALE_MAX;
            *lod = lod.with_threshold_px(pixels.clamp(low, high));
        }
        if let Some(band) = self.fade_band {
            *lod = lod.with_fade_band(band);
        }
        if let Some(on) = self.impostors {
            *lod = lod.with_impostors(on);
        }
        if let Some(density) = self.far_density {
            *lod = lod.with_far_density(density);
        }
        cap_lod(lod, class);
    }
}

/// Quality overrides for one class: a `[render.class.<class>]` table, or the person's saved
/// choice on this device. Every key is optional; a set key wins over earlier sources.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClassOverride {
    /// The preset.
    pub preset: Option<QualityPreset>,
    /// The nominal render scale (clamped to [`RENDER_SCALE_MIN`]..=1): of the output, or with an
    /// upscaling mode in force ([`ClassOverride::upscale`]) of the mode's share.
    pub render_scale: Option<f32>,
    /// The frame-rate target dynamic resolution holds, one of [`crate::drs::FRAME_RATE_TARGETS`].
    pub fps: Option<u32>,
    /// The upscaling mode (lane UQ): the share of the window a frame renders.
    pub upscale: Option<crate::upscale::UpscaleMode>,
    /// Whether dynamic resolution moves the scale (off: the nominal step, and no preset demotion).
    pub dynamic_resolution: Option<bool>,
    /// Feature switches, applied in order after the preset.
    pub switches: Vec<(RenderFeature, bool)>,
    /// The sun's shadow choices (cascades, map size, filter, distance, blend band), applied after
    /// the preset and held to the class's caps.
    pub shadows: ShadowOverride,
    /// TAA's resource knobs while TAA runs (the jitter cycle, the accumulation floor, the texture
    /// LOD bias; RQ5 review): a game's code may ask for ultra's 16-position cycle at `high`, a
    /// steadier floor or sharper textures. Whether TAA runs stays the preset's and the `taa` switch.
    pub taa: Option<TaaQuality>,
    /// Level-of-detail choices (game systems LOD-06): applied after the preset and before the
    /// switches, held to their ranges and the class's floor.
    pub lod: LodOverride,
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
    // LOD choices before the switches, so `lod-fade = false` turns the crossfade off alone.
    let lod = layers.iter().flatten().fold(LodOverride::new(), |merged, layer| merged.over(layer.lod));
    lod.apply(&mut quality.lod, class);
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

/// The most compute skinning jobs (distinct poses) a desktop frame keeps, by tier: ultra, high, mid, low (game
/// systems AN-23). Desktop-high holds its budget of 100 full-rate characters on compute.
pub const SKINNED_COMPUTE_DESKTOP: [u32; 4] = [128, 100, 64, 32];
/// The most compute skinning jobs (distinct poses) a phone frame keeps, by tier: high (and ultra), mid, low.
/// Each holds two output copies of its vertices (48 B each), so 16 characters of 20,000 vertices
/// take 30.7 MB of mobile-high's 48 MB skinned cap, 8 take 15.4 MB of mobile-low's 16 MB.
pub const SKINNED_COMPUTE_PHONE: [u32; 3] = [16, 12, 8];
/// The most compute skinning jobs (distinct poses) a browser frame keeps, whatever its class (the web's budget
/// of 40 characters).
pub const SKINNED_COMPUTE_WEB_MAX: u32 = 40;

/// The most skinning jobs `class` on `os` runs by compute in one frame (game systems AN-23; a job
/// is one pose of one skin and level, however many draws share it, lane CP): past it the jobs
/// smallest on screen skin in the vertex stage (AN-18's path), which holds no skinned output. The class's row ([`SKINNED_COMPUTE_DESKTOP`], [`SKINNED_COMPUTE_PHONE`]); a browser at
/// most [`SKINNED_COMPUTE_WEB_MAX`]. `mobile-ultra` takes `mobile-high`'s.
pub fn skinned_compute_instances_max(class: DeviceClass, os: TargetOs) -> u32 {
    let row = match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra) => SKINNED_COMPUTE_DESKTOP[0],
        (FormFactor::Desktop, PerformanceTier::High) => SKINNED_COMPUTE_DESKTOP[1],
        (FormFactor::Desktop, PerformanceTier::Mid) => SKINNED_COMPUTE_DESKTOP[2],
        (FormFactor::Desktop, PerformanceTier::Low) => SKINNED_COMPUTE_DESKTOP[3],
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => SKINNED_COMPUTE_PHONE[0],
        (FormFactor::Mobile, PerformanceTier::Mid) => SKINNED_COMPUTE_PHONE[1],
        (FormFactor::Mobile, PerformanceTier::Low) => SKINNED_COMPUTE_PHONE[2],
    };
    if os == TargetOs::Web { row.min(SKINNED_COMPUTE_WEB_MAX) } else { row }
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
