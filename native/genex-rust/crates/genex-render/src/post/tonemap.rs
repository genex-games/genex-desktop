//! The tonemap (graph node 21, RQ1.1): the pre-exposed HDR scene mapped to display colour by the
//! look's [`Tonemapper`] (the pipeline's `GX_TONEMAPPER` override is [`Tonemapper::shader_id`]),
//! sRGB-encoded into the world target with a frame-keyed dither of at most half a level
//! ([`DITHER_AMPLITUDE`]), or into the [`INTERMEDIATE_FORMAT`] intermediate an upscale reads (no
//! dither there: the final world-target write adds it). Below scale 1 the bilinear upscale is fused
//! into the same pass ([`TonemapSource::Bilinear`]); medium and above tonemap into FSR1's
//! intermediate at render size and EASU and RCAS upscale it (RQ5.6, [`crate::post::fsr`]). The
//! sharpened variant ([`TonemapSource::Sharpen`]) is the stand-in a build without FSR1 draws.
//!
//! MSAA on the HDR path resolves by device class ([`MsaaResolve::for_class`]): phones and weaker
//! tile GPUs keep the world pass's hardware resolve; desktop GPUs, and high or ultra desktop tile
//! GPUs (Apple silicon Macs), resolve with a luminance weight, each sample
//! weighted by 1 / (1 + luma) and the mean mapped back, so a blinding sample does not whiten a dark
//! edge pixel. The tonemap fuses that resolve when nothing reads the resolved scene first
//! ([`TonemapSource::Msaa`]); [`ResolveNode`] is the standalone pass otherwise.
//!
//! Bloom (RQ4.2) composites here: once [`TonemapNode::set_bloom`] hands the node a frame's
//! [`BloomSettings`], each pass first records the chain from the same input the tonemap reads (the
//! 1x scene or the samples) and both bind groups carry the chain's top at
//! [`crate::post::bloom::TONEMAP_BLOOM_BINDING`] (with the filtering sampler); without bloom they
//! carry a neutral 1x1 black texture. `GpuTonemapParams::shape.z` holds the look's intensity (0
//! without bloom: the shader skips the composite, so the picture is byte for byte the bloom-free
//! one) and `shape.w` the chain's scale (1: its weights sum to 1); the composite is `mix(scene, bloom, intensity)`, or,
//! under the look's stylistic threshold (`bloom.x`, its knee `bloom.y`),
//! `scene + (bloom - soft_threshold(scene)) * intensity` ([`crate::post::bloom::composite`]), so the
//! scene below the threshold keeps its light.
//!
//! The curves are ported from three.js 0.185's tonemapping shader chunk (MIT): Khronos PBR Neutral,
//! AgX and Stephen Hill's ACES fit. AgX punchy is Godot 4.7.2's AgX (MIT): the allenwp curve
//! ([`AgxCurve`], its parameters computed here as Godot's `environment_storage.cpp` computes them)
//! between Blender AgX's combined inset and outset matrices, at contrast [`AGX_PUNCHY_CONTRAST`]
//! with scene 0.18 kept at the display grey plain AgX draws it at ([`AGX_GREY_OUT`]), then
//! saturation [`AGX_PUNCHY_SATURATION`]. [`tonemap_cpu`] is the CPU reference the shader is held to.
//!
//! Grading (A.2, [`crate::post::grading`]) runs in the same pass: once [`TonemapNode::set_grading`]
//! hands the node the look's [`Grading`], the pipelines take its `GX_GRADING` bits (the graded
//! variants of every pipeline made so far are made there, never mid-pass), the uniform its rows
//! and binding [`GRADING_LUT_BINDING`] its LUT (a neutral 1x1x1 texel without one).
//!
//! Local exposure (AAA push P3, [`crate::post::local_exposure`]) runs in the same pass too: once
//! [`TonemapNode::set_local_exposure`] hands the node the frame's [`LocalExposure`], each pass first
//! records the grid from the input the tonemap reads and binds it at
//! [`crate::post::local_exposure::TONEMAP_GRID_BINDING`] and
//! [`crate::post::local_exposure::TONEMAP_MEAN_BINDING`] (the neutral LUT texel and the neutral
//! bloom texel without it, and the uniform's `local.z` 0: the shader skips it).
//!
//! Shaders: [`crate::shaders::TONEMAP`], [`crate::shaders::RESOLVE_HDR`].

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, PipelineLayout, Queue, RenderPipeline, Sampler, ShaderModule, TextureFormat, TextureView};

use crate::capture::Capture;
use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::post::grading::{GRADING_LUT_BINDING, Grading, GradingLut, LUT_FORMAT, ShaderGrading, lut_side_max};
use crate::post::local_exposure::{GridOutput, GridSource, LocalExposure, LocalExposureNode, TONEMAP_GRID_BINDING, TONEMAP_MEAN_BINDING};
use crate::post::bloom::{BloomInput, BloomNode, BloomOutput, BloomSettings, BloomSource, TONEMAP_BLOOM_BINDING, TONEMAP_SAMPLER_BINDING};
use crate::readback::map_read_blocking;
use crate::settings::Tonemapper;
use crate::tables::{buffer, pipeline_layout};

/// The dither's amplitude in encoded units: at most half an 8-bit level either way.
pub const DITHER_AMPLITUDE: f32 = 0.5 / 255.0;
/// The most 8-bit levels the dither moves a pixel by.
pub const DITHER_LEVELS: u8 = 1;
/// The encoded intermediate between the tonemap and an upscale (EASU + RCAS, RQ5): 10 bits a channel.
pub const INTERMEDIATE_FORMAT: TextureFormat = TextureFormat::Rgb10a2Unorm;
/// The sharpened upscale's sharpness: RCAS's 0.2 stops (exp2(-0.2)), its usual default.
pub const UPSCALE_SHARPNESS: f32 = 0.870_55;
/// The largest radiance the HDR scene stores (`GX_SCENE_RADIANCE_MAX` in lighting/output.wgsl):
/// the curve reads anything above it, inf included, as it.
pub const SCENE_RADIANCE_MAX: f32 = 64512.0;
/// The frame index the dither noise repeats after.
const DITHER_CYCLE: u64 = 64;

/// How the HDR scene's MSAA samples become one colour.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MsaaResolve {
    /// The world pass's hardware resolve (a linear average): tile classes, where the samples never
    /// leave tile memory.
    Hardware,
    /// The luminance-weighted resolve: desktop classes.
    Weighted,
}

impl MsaaResolve {
    /// The resolve a device of `form` uses: the weighted one only on a desktop whose GPU is not a
    /// tile renderer (`tile_gpu`: the adapter keeps attachments in tile memory, as Apple silicon
    /// and mobile GPUs do). On a tile GPU the weighted resolve would store all four HDR samples to
    /// memory and read them back (4x the scene's bandwidth: on the M4 Max at 1080p +0.10 ms at p50
    /// against +0.05 ms for the in-pass resolve), so it keeps the hardware resolve.
    pub const fn for_device(form: FormFactor, tile_gpu: bool) -> MsaaResolve {
        match form {
            FormFactor::Desktop if !tile_gpu => MsaaResolve::Weighted,
            _ => MsaaResolve::Hardware,
        }
    }

    /// The resolve a device of `class` uses: [`MsaaResolve::for_device`], except that a desktop
    /// tile GPU of the high or ultra tier (an Apple silicon Mac with the bandwidth to spare) takes
    /// the weighted resolve too, so bright edges against the sky, windows and lanterns stay
    /// antialiased after the tonemap. Phones and weaker laptops keep their samples in tile memory.
    pub const fn for_class(class: DeviceClass, tile_gpu: bool) -> MsaaResolve {
        match (class.form, class.tier) {
            (FormFactor::Desktop, PerformanceTier::High | PerformanceTier::Ultra) => MsaaResolve::Weighted,
            (form, _) => MsaaResolve::for_device(form, tile_gpu),
        }
    }
}

/// Where the tonemap reads the scene and how it covers its target.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TonemapSource {
    /// The 1x scene, one texel per pixel (scale 1).
    Scene,
    /// The multisampled scene through the luminance-weighted resolve (scale 1, desktop MSAA).
    Msaa,
    /// The 1x scene stretched bilinearly (below scale 1 on `low`).
    Bilinear,
    /// The multisampled scene, weighted-resolved per texel and stretched bilinearly.
    BilinearMsaa,
    /// Five bilinear taps through the curve and a contrast-adaptive sharpen (below scale 1 above `low`).
    Sharpen,
}

impl TonemapSource {
    const fn entry(self) -> &'static str {
        match self {
            TonemapSource::Scene => "fs_tonemap",
            TonemapSource::Msaa => "fs_tonemap_msaa",
            TonemapSource::Bilinear => "fs_tonemap_bilinear",
            TonemapSource::BilinearMsaa => "fs_tonemap_bilinear_msaa",
            TonemapSource::Sharpen => "fs_tonemap_sharpen",
        }
    }

    /// Whether it reads the multisampled scene.
    pub const fn multisampled(self) -> bool {
        matches!(self, TonemapSource::Msaa | TonemapSource::BilinearMsaa)
    }

    /// The source for a scene read from `multisampled` samples, `upscaled` over a larger target,
    /// `sharpened` or not. A sharpened upscale reads the 1x scene (its five taps would be twenty
    /// over raw samples): the caller resolves first.
    pub const fn pick(multisampled: bool, upscaled: bool, sharpened: bool) -> TonemapSource {
        match (multisampled, upscaled, sharpened) {
            (_, true, true) => TonemapSource::Sharpen,
            (true, true, false) => TonemapSource::BilinearMsaa,
            (false, true, false) => TonemapSource::Bilinear,
            (true, false, _) => TonemapSource::Msaa,
            (false, false, _) => TonemapSource::Scene,
        }
    }
}

/// The tonemap's uniform (`GxTonemapParams` in tonemap.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuTonemapParams {
    /// xy: the source's size in texels; zw: 1 / it.
    pub source: [f32; 4],
    /// xy: the target's size in pixels; zw: 1 / it.
    pub output: [f32; 4],
    /// x: the dither amplitude (0: none); y: the sharpness; z: bloom's intensity (0: no bloom);
    /// w: the bloom chain's scale (1: its weights sum to 1).
    pub shape: [f32; 4],
    /// x: the frame index the dither is keyed to.
    pub frame: [u32; 4],
    /// x: bloom's stylistic threshold (0: none, the energy-conserving lerp); y: its soft knee
    /// ([`crate::post::bloom::THRESHOLD_KNEE`]); zw: reserved.
    pub bloom: [f32; 4],
    /// The look's white balance as a 3x3 matrix on linear rgb, three columns of xyz with w
    /// reserved (`mat3x3<f32>` in WGSL, 16-byte column stride): today the diagonal of
    /// [`crate::settings::Look::white_balance_gains`] ([`balance_columns`]); a chromatic-adaptation
    /// matrix baked on the CPU from temperature and tint takes its place without a layout change.
    pub balance: [[f32; 4]; 3],
    /// AgX punchy's curve ([`AgxCurve::row`]): contrast, the toe's a, the shoulder's slope and w.
    pub curve: [f32; 4],
    /// Grading ([`Grading`]'s rows): x contrast, y saturation, z vibrance, w the LUT's intensity.
    pub grade: [f32; 4],
    /// xy: the midtones' level range; z: the LUT's side; w reserved.
    pub grade_range: [f32; 4],
    /// Each section's saturation: x shadows, y midtones, z highlights; w reserved.
    pub section_saturation: [f32; 4],
    /// Each section's contrast.
    pub section_contrast: [f32; 4],
    /// Each section's gamma.
    pub section_gamma: [f32; 4],
    /// Each section's gain.
    pub section_gain: [f32; 4],
    /// Each section's lift.
    pub section_lift: [f32; 4],
    /// Local exposure ([`crate::post::local_exposure::tonemap_rows`]): x the highlights' contrast,
    /// y the shadows', z 1 when on (0: skipped), w the plain mean's share of the base.
    pub local: [f32; 4],
    /// xy: the scene's uv to the grid's; zw: one grid cell in grid uv.
    pub local_grid: [f32; 4],
}

/// The scene value where the allenwp curve's toe and shoulder meet (Godot's `awp_crossover_point`).
pub const AGX_CROSSOVER: f32 = 0.18;
/// The display-linear value the crossover maps to: where plain AgX draws scene 0.18 (sRGB 128), so
/// punchy's contrast pivots about middle grey and never shifts the exposure (Godot maps the
/// crossover to itself, sRGB 118).
pub const AGX_GREY_OUT: f32 = 0.2145;
/// AgX punchy's contrast: the toe's power (Godot's default 1.25 approximates Blender's AgX). 1.4,
/// not the plan's 1.5: it keeps a sky-lit shadow readable and amplifies a wobble of shadow
/// radiance (PCF, PCSS, AO or TAA noise) 1.4 times on screen, against 2.3 under pass 1's punchy,
/// and AO steps between presets stay within the showcase's cabin-wall bound.
pub const AGX_PUNCHY_CONTRAST: f32 = 1.4;
/// AgX punchy's white: the scene value the shoulder reaches display white at (Blender AgX's
/// 2^6.5 x 0.18).
pub const AGX_PUNCHY_WHITE: f32 = 16.29;
/// AgX punchy's saturation about Rec. 709 luminance, after the curve (grey stays grey).
pub const AGX_PUNCHY_SATURATION: f32 = 1.4;
/// The display encoding punchy's saturation is applied in (gamma 2.2, pass 1's sigmoid output).
const PUNCHY_SATURATION_GAMMA: f32 = 2.2;

/// The allenwp tonemapping curve's parameters (Godot 4.7.2 `environment_storage.cpp`
/// `environment_get_tonemap_parameters`, MIT), solved for a crossover at [`AGX_CROSSOVER`] that
/// maps to [`AGX_GREY_OUT`]: the toe `t = x^contrast / (x^contrast + toe_a)` passes through it, the
/// shoulder starts with the toe's slope there and reaches display white at `white`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AgxCurve {
    /// The toe's power.
    pub contrast: f32,
    /// The toe's denominator offset.
    pub toe_a: f32,
    /// The shoulder's slope at the crossover (the toe's).
    pub slope: f32,
    /// The shoulder's w: where it reaches display white.
    pub w: f32,
}

impl AgxCurve {
    /// The curve of `contrast` reaching display white at scene `white` (above the crossover).
    pub fn new(contrast: f32, white: f32) -> AgxCurve {
        let shoulder_max = 1.0 - AGX_GREY_OUT;
        let crossover_c = libm::powf(AGX_CROSSOVER, contrast);
        let toe_a = crossover_c * (1.0 / AGX_GREY_OUT - 1.0);
        let denominator = crossover_c + toe_a;
        let slope = contrast * libm::powf(AGX_CROSSOVER, contrast - 1.0) * toe_a / (denominator * denominator);
        let reach = white.max(AGX_CROSSOVER * 2.0) - AGX_CROSSOVER;
        AgxCurve { contrast, toe_a, slope, w: reach * reach / shoulder_max * slope }
    }

    /// AgX punchy's curve.
    pub fn punchy() -> AgxCurve {
        AgxCurve::new(AGX_PUNCHY_CONTRAST, AGX_PUNCHY_WHITE)
    }

    /// The uniform's row (`GpuTonemapParams::curve`).
    pub fn row(&self) -> [f32; 4] {
        [self.contrast, self.toe_a, self.slope, self.w]
    }

    /// The curve at scene value `x` (one channel, `x >= 0`): the shader's `gx_tm_awp`.
    pub fn at(&self, x: f32) -> f32 {
        if x < AGX_CROSSOVER {
            let t = libm::powf(x, self.contrast);
            return t / (t + self.toe_a);
        }
        let s = x - AGX_CROSSOVER;
        let slope_s = self.slope * s;
        slope_s * (1.0 + s / self.w) / (1.0 + slope_s / (1.0 - AGX_GREY_OUT)) + AGX_GREY_OUT
    }
}

/// A column-major 3x3 matrix on linear rgb (`m[column][row]`).
pub type ColorMatrix = [[f32; 3]; 3];

/// The identity colour matrix (no white balance).
pub const COLOR_MATRIX_IDENTITY: ColorMatrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// `matrix` as the uniform's three columns.
pub fn balance_columns(matrix: &ColorMatrix) -> [[f32; 4]; 3] {
    matrix.map(|[x, y, z]| [x, y, z, 0.0])
}

fn size_row(size: (u32, u32)) -> [f32; 4] {
    let (w, h) = (size.0.max(1) as f32, size.1.max(1) as f32);
    [w, h, 1.0 / w, 1.0 / h]
}

/// The sRGB transfer of one display-linear channel (pbr.wgsl's `linear_to_srgb`).
pub fn encode_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * libm::powf(c, 1.0 / 2.4) - 0.055 }
}

type Mat3 = [[f32; 3]; 3];

/// `m` (columns, as the shader's `mat3x3`) times `v`.
fn mul(m: &Mat3, v: [f32; 3]) -> [f32; 3] {
    std::array::from_fn(|row| m[0][row] * v[0] + m[1][row] * v[1] + m[2][row] * v[2])
}

fn clamp01(v: [f32; 3]) -> [f32; 3] {
    v.map(|c| c.clamp(0.0, 1.0))
}

const ACES_INPUT: Mat3 = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
const ACES_OUTPUT: Mat3 = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
const SRGB_TO_REC2020: Mat3 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const REC2020_TO_SRGB: Mat3 = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
#[allow(clippy::excessive_precision, reason = "the constants as three.js publishes them")]
const AGX_INSET: Mat3 = [
    [0.856_627_15, 0.137_318_97, 0.111_898_21],
    [0.095_121_24, 0.761_241_99, 0.076_799_42],
    [0.048_251_606, 0.101_439_04, 0.811_302_37],
];
#[allow(clippy::excessive_precision, reason = "the constants as three.js publishes them")]
const AGX_OUTSET: Mat3 = [
    [1.127_100_6, -0.141_329_76, -0.141_329_76],
    [-0.110_606_64, 1.157_823_7, -0.110_606_64],
    [-0.016_493_939, -0.016_493_939, 1.251_936_4],
];
const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;
const NEUTRAL_START: f32 = 0.76;
const NEUTRAL_DESATURATION: f32 = 0.15;

fn aces(color: [f32; 3]) -> [f32; 3] {
    let v = mul(&ACES_INPUT, color.map(|c| c / 0.6));
    let fitted = v.map(|v| (v * (v + 0.024_578_6) - 0.000_090_537) / (v * (0.983_729 * v + 0.432_951) + 0.238_081));
    clamp01(mul(&ACES_OUTPUT, fitted))
}

fn agx(color: [f32; 3]) -> [f32; 3] {
    let inset = mul(&AGX_INSET, mul(&SRGB_TO_REC2020, color));
    let encoded = inset.map(|c| ((libm::log2f(c.max(1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)).clamp(0.0, 1.0));
    let contrast = encoded.map(|x| {
        let (x2, x4) = (x * x, x * x * x * x);
        15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
    });
    let linear = mul(&AGX_OUTSET, contrast).map(|c| libm::powf(c.max(0.0), 2.2));
    clamp01(mul(&REC2020_TO_SRGB, linear))
}

/// Godot's combined Rec. 709 -> Rec. 2020 -> AgX inset matrix (columns).
#[allow(clippy::excessive_precision, reason = "the constants as Godot publishes them")]
const AGX_GODOT_INSET: Mat3 = [
    [0.544_814_746_488_245, 0.140_416_948_464_053, 0.088_810_419_614_909_6],
    [0.373_787_398_372_697, 0.754_137_554_567_394, 0.178_871_756_420_858],
    [0.081_397_855_139_058_1, 0.105_445_496_968_552, 0.732_317_823_964_232],
];
/// Godot's combined AgX outset -> Rec. 2020 -> Rec. 709 matrix (columns).
#[allow(clippy::excessive_precision, reason = "the constants as Godot publishes them")]
const AGX_GODOT_OUTSET: Mat3 = [
    [1.964_887_411_694_89, -0.299_313_364_904_742, -0.164_352_742_528_393],
    [-0.855_988_495_690_215, 1.326_397_964_619_80, -0.238_183_969_428_088],
    [-0.108_898_916_004_672, -0.027_084_599_715_057_1, 1.402_536_711_956_48],
];

/// AgX punchy: Godot's AgX through `curve`, then [`AGX_PUNCHY_SATURATION`] about luminance on
/// display-encoded values.
fn agx_punchy(color: [f32; 3], curve: &AgxCurve) -> [f32; 3] {
    let shaped = mul(&AGX_GODOT_INSET, color).map(|c| curve.at(c).min(1.0));
    let c = mul(&AGX_GODOT_OUTSET, shaped);
    // Saturated on display-encoded values (gamma 2.2), as the shader does (G0 leftovers).
    let e = c.map(|v| libm::powf(v.max(0.0), 1.0 / PUNCHY_SATURATION_GAMMA));
    let luma = e[0] * 0.2126 + e[1] * 0.7152 + e[2] * 0.0722;
    clamp01(e.map(|v| luma + AGX_PUNCHY_SATURATION * (v - luma))).map(|v| libm::powf(v, PUNCHY_SATURATION_GAMMA))
}

fn neutral(color: [f32; 3]) -> [f32; 3] {
    let x = color[0].min(color[1]).min(color[2]);
    let offset = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    let c = color.map(|v| v - offset);
    let peak = c[0].max(c[1]).max(c[2]);
    if peak < NEUTRAL_START {
        return clamp01(c);
    }
    let d = 1.0 - NEUTRAL_START;
    let new_peak = 1.0 - d * d / (peak + d - NEUTRAL_START);
    let g = 1.0 - 1.0 / (NEUTRAL_DESATURATION * (peak - new_peak) + 1.0);
    clamp01(c.map(|v| v * (new_peak / peak) * (1.0 - g) + new_peak * g))
}

/// The CPU reference of the shader's curve: pre-exposed linear radiance to display-linear colour
/// in `[0, 1]` (encode it with [`encode_srgb`]).
pub fn tonemap_cpu(tonemapper: Tonemapper, rgb: [f32; 3]) -> [f32; 3] {
    // `max` first: a NaN reads as 0, as the shader's does.
    let c = rgb.map(|v| v.max(0.0).clamp(0.0, SCENE_RADIANCE_MAX));
    match tonemapper {
        Tonemapper::Agx => agx(c),
        Tonemapper::AgxPunchy => agx_punchy(c, &AgxCurve::punchy()),
        Tonemapper::Aces => aces(c),
        Tonemapper::None => clamp01(c),
        _ => neutral(c),
    }
}

/// A half float's bits of `value` (round to nearest even; overflow to infinity).
pub fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x007f_ffff;
    if exponent == 0xff {
        return sign | 0x7c00 | if mantissa != 0 { 0x200 } else { 0 };
    }
    let half_exponent = exponent - 127 + 15;
    if half_exponent >= 0x1f {
        return sign | 0x7c00;
    }
    if half_exponent <= 0 {
        if half_exponent < -10 {
            return sign;
        }
        let full = mantissa | 0x0080_0000;
        let shift = (14 - half_exponent) as u32;
        let rounded = (full + (1 << (shift - 1)) - 1 + ((full >> shift) & 1)) >> shift;
        return sign | rounded as u16;
    }
    let rounded = mantissa + 0x0fff + ((mantissa >> 13) & 1);
    let (half_exponent, rounded) = if rounded & 0x0080_0000 != 0 { (half_exponent + 1, 0) } else { (half_exponent, rounded) };
    if half_exponent >= 0x1f {
        return sign | 0x7c00;
    }
    sign | ((half_exponent as u16) << 10) | (rounded >> 13) as u16
}

/// The value of half-float bits.
pub fn f16_to_f32(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let mantissa = f32::from(bits & 0x3ff);
    match exponent {
        0 => sign * mantissa * libm::exp2f(-24.0),
        0x1f if mantissa == 0.0 => sign * f32::INFINITY,
        0x1f => f32::NAN,
        _ => sign * (1.0 + mantissa / 1024.0) * libm::exp2f((exponent - 15) as f32),
    }
}

/// What one tonemap pass reads and writes.
pub(crate) struct TonemapPass<'a> {
    /// How the scene is read.
    pub source: TonemapSource,
    /// The scene: the 1x view, or the multisampled one for a multisampled source.
    pub input: &'a TextureView,
    /// The target (the world target, or the intermediate).
    pub target: &'a TextureView,
    /// Its format.
    pub format: TextureFormat,
    /// The curve.
    pub tonemapper: Tonemapper,
    /// The scene's size (the render size).
    pub source_size: (u32, u32),
    /// The target's size.
    pub target_size: (u32, u32),
    /// The output's size (the world target's): the bloom chain is sized from it, so a DRS step
    /// keeps the halo's width (renderer pass 2, P5).
    pub output_size: (u32, u32),
    /// Whether to dither (the final world-target write).
    pub dither: bool,
    /// The frame index the dither is keyed to.
    pub frame_index: u64,
    /// The input's identity: the bind group is rebuilt when it changes (the pool's generation).
    pub generation: u64,
    /// The look's white balance, a matrix on the scene's linear rgb before the curve
    /// ([`crate::settings::Look::white_balance_matrix`]).
    pub balance: ColorMatrix,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PipelineKey {
    tonemapper: u32,
    source: TonemapSource,
    format: TextureFormat,
    grading: ShaderGrading,
}

/// The look's LUT on the GPU: the texture's view, keyed by the interned LUT and the class's side.
struct NodeLut {
    key: (usize, u32),
    view: TextureView,
    side: u32,
}

impl NodeLut {
    fn new(device: &Device, queue: &Queue, lut: &'static GradingLut, side_max: u32) -> NodeLut {
        let upload = lut.upload(side_max);
        let side = upload.side();
        let size = wgpu::Extent3d { width: side, height: side, depth_or_array_layers: side };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("grading lut"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: LUT_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(side * 8), rows_per_image: Some(side) };
        queue.write_texture(texture.as_image_copy(), bytemuck::cast_slice(&upload.texels()), layout, size);
        NodeLut { key: (std::ptr::from_ref(lut) as usize, side_max), view: texture.create_view(&Default::default()), side }
    }
}

/// The tonemap node: one module, a pipeline per (curve, source, target format) made on first use,
/// the uniform and the bind group of the current input.
/// What a tonemap bind group was made for: the input's generation, whether it is multisampled,
/// the bloom chain's, the LUT's and local exposure's grid's generations.
type GroupKey = (u64, bool, u64, u64, u64);

pub(crate) struct TonemapNode {
    module: ShaderModule,
    scene_layout: BindGroupLayout,
    msaa_layout: BindGroupLayout,
    scene_pipeline_layout: PipelineLayout,
    msaa_pipeline_layout: PipelineLayout,
    sampler: Sampler,
    params: Buffer,
    pipelines: Vec<(PipelineKey, Compiled<RenderPipeline>)>,
    group: Option<(GroupKey, BindGroup)>,
    /// The 1x1 black texture bound for bloom until the chain runs (WebGPU zero-initializes it).
    neutral_bloom: TextureView,
    /// The bloom the next passes draw (None: the neutral input).
    bloom: Option<BloomSettings>,
    /// The bloom chain's node, made when a frame first asks for bloom.
    bloom_node: Option<BloomNode>,
    /// The look's grading (held), from [`TonemapNode::set_grading`].
    grading: Grading,
    /// The look's LUT on the GPU (None: the neutral texel).
    lut: Option<NodeLut>,
    /// The 1x1x1 neutral LUT texel (no change; WebGPU zero-initializes it).
    neutral_lut: TextureView,
    /// Bumped whenever the bound LUT changes (the bind group is rebuilt).
    lut_generation: u64,
    /// The local exposure the next passes draw (None: off, the neutral texels).
    local: Option<LocalExposure>,
    /// Local exposure's grid pass, made when a frame first asks for it.
    local_node: Option<LocalExposureNode>,
}

/// A filterable 2D float texture binding of the fragment stage (the scene, the bloom chain).
fn filterable_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D2,
        multisampled: false,
    };
    layout_entry(binding, ty)
}

/// The grading LUT's binding: a 3D float texture read with `textureLoad`.
fn lut_entry() -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D3,
        multisampled: false,
    };
    layout_entry(GRADING_LUT_BINDING, ty)
}

/// The neutral LUT: one zero `rgba16float` texel.
fn neutral_lut(device: &Device) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("grading lut neutral"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: LUT_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&Default::default())
}

/// Local exposure's grid binding: a filterable 3D float texture.
fn grid_entry() -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: true },
        view_dimension: wgpu::TextureViewDimension::D3,
        multisampled: false,
    };
    layout_entry(TONEMAP_GRID_BINDING, ty)
}

fn sampler_entry() -> wgpu::BindGroupLayoutEntry {
    layout_entry(TONEMAP_SAMPLER_BINDING, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering))
}

/// The neutral bloom input: one black `rgba16float` texel.
fn neutral_bloom(device: &Device) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("bloom neutral"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: crate::post::bloom::CHAIN_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&Default::default())
}

fn layout_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn uniform_entry() -> wgpu::BindGroupLayoutEntry {
    layout_entry(2, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None })
}

fn multisampled_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture {
        sample_type: wgpu::TextureSampleType::Float { filterable: false },
        view_dimension: wgpu::TextureViewDimension::D2,
        multisampled: true,
    };
    layout_entry(binding, ty)
}

/// A full-screen pipeline of `module`'s `fragment` writing `format`.
fn fullscreen(device: &Device, label: &str, layout: &PipelineLayout, module: &ShaderModule, entries: (&str, &str), format: TextureFormat, constants: &[(&str, f64)]) -> Compiled<RenderPipeline> {
    let compilation_options = wgpu::PipelineCompilationOptions { constants, ..Default::default() };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some(entries.0), compilation_options: compilation_options.clone(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entries.1),
            compilation_options,
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl TonemapNode {
    pub(crate) fn new(device: &Device) -> Result<TonemapNode, RenderError> {
        let module = crate::shaders::module(device, "tonemap", crate::shaders::TONEMAP)?;
        let scene_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tonemap"),
            entries: &[filterable_entry(0), sampler_entry(), uniform_entry(), filterable_entry(TONEMAP_BLOOM_BINDING), lut_entry(), grid_entry(), filterable_entry(TONEMAP_MEAN_BINDING)],
        });
        let msaa_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tonemap msaa"),
            entries: &[sampler_entry(), uniform_entry(), multisampled_entry(3), filterable_entry(TONEMAP_BLOOM_BINDING), lut_entry(), grid_entry(), filterable_entry(TONEMAP_MEAN_BINDING)],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("tonemap"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let params = buffer(device, "tonemap params", size_of::<GpuTonemapParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(TonemapNode {
            scene_pipeline_layout: pipeline_layout(device, "tonemap", &[&scene_layout]),
            msaa_pipeline_layout: pipeline_layout(device, "tonemap msaa", &[&msaa_layout]),
            module,
            scene_layout,
            msaa_layout,
            sampler,
            params,
            pipelines: Vec::new(),
            group: None,
            neutral_bloom: neutral_bloom(device),
            bloom: None,
            bloom_node: None,
            grading: Grading::NEUTRAL,
            lut: None,
            neutral_lut: neutral_lut(device),
            lut_generation: 0,
            local: None,
            local_node: None,
        })
    }

    /// The bytes of the 3D grading LUT this node holds (`side³` rgba16f texels; 0: none), the
    /// budget ledger's [`crate::budget::GRADING_LUT_LABEL`] entry (`Renderer::buffer_ledger`).
    pub(crate) fn grading_lut_bytes(&self) -> u64 {
        self.lut.as_ref().map_or(0, |lut| u64::from(lut.side).pow(3) * 8)
    }

    /// Draw `grading` from the next pass on, its LUT sized for `class` ([`lut_side_max`]). The LUT
    /// is uploaded when it or the class's side changed; when what the shader draws changed, the
    /// graded variant of every pipeline made so far is made here, never mid-pass.
    pub(crate) fn set_grading(&mut self, device: &Device, queue: &Queue, grading: &Grading, class: DeviceClass) {
        let before = self.shader_grading();
        let grading = grading.held();
        let side_max = lut_side_max(class);
        let lut = grading.lut.filter(|_| grading.shader().lut());
        let wanted = lut.map(|lut| (std::ptr::from_ref(lut) as usize, side_max));
        if wanted != self.lut.as_ref().map(|held| held.key) {
            self.lut = lut.map(|lut| NodeLut::new(device, queue, lut, side_max));
            self.lut_generation += 1;
        }
        self.grading = grading;
        let after = self.shader_grading();
        if after == before {
            return;
        }
        let made: Vec<PipelineKey> = self.pipelines.iter().map(|(key, _)| *key).filter(|key| key.grading == before).collect();
        for key in made {
            self.pipeline_of(device, PipelineKey { grading: after, ..key });
        }
    }

    /// What the passes draw of the look's grading: its LUT only once uploaded.
    fn shader_grading(&self) -> ShaderGrading {
        let shader = self.grading.shader();
        if self.lut.is_some() { shader } else { shader.without_lut() }
    }

    /// Draw `bloom` from the next pass on (each pass records the chain, then composites it), or
    /// none (`None`: the neutral black input, the composite skipped). The chain's pipelines are made
    /// here, on the frame that first asks, never mid-pass.
    pub(crate) fn set_bloom(&mut self, device: &Device, bloom: Option<BloomSettings>) -> Result<(), RenderError> {
        if bloom.is_some() && self.bloom_node.is_none() {
            self.bloom_node = Some(BloomNode::new(device)?);
        }
        self.bloom = bloom;
        Ok(())
    }

    /// Draw `local` exposure from the next pass on (each pass records the grid, then slices it), or
    /// none (`None`, or a look with both contrasts at 1: the neutral texels, skipped). The grid's
    /// pipelines are made here, on the frame that first asks, never mid-pass.
    pub(crate) fn set_local_exposure(&mut self, device: &Device, local: Option<LocalExposure>) -> Result<(), RenderError> {
        let local = local.filter(LocalExposure::is_on);
        if local.is_some() && self.local_node.is_none() {
            self.local_node = Some(LocalExposureNode::new(device)?);
        }
        self.local = local;
        Ok(())
    }

    /// The pipeline of `tonemapper` reading `source` into `format`, made once (a pipeline-shaping
    /// change prewarms it at the frame that asks).
    pub(crate) fn pipeline(&mut self, device: &Device, tonemapper: Tonemapper, source: TonemapSource, format: TextureFormat) -> Compiled<RenderPipeline> {
        let key = PipelineKey { tonemapper: tonemapper.shader_id(), source, format, grading: self.shader_grading() };
        self.pipeline_of(device, key)
    }

    fn pipeline_of(&mut self, device: &Device, key: PipelineKey) -> Compiled<RenderPipeline> {
        if let Some((_, pipeline)) = self.pipelines.iter().find(|(held, _)| *held == key) {
            return pipeline.clone();
        }
        let layout = if key.source.multisampled() { &self.msaa_pipeline_layout } else { &self.scene_pipeline_layout };
        let constants = [("GX_TONEMAPPER", f64::from(key.tonemapper)), ("GX_GRADING", f64::from(key.grading.shader_id()))];
        let pipeline = fullscreen(device, "tonemap", layout, &self.module, ("vs_tonemap", key.source.entry()), key.format, &constants);
        self.pipelines.push((key, pipeline.clone()));
        pipeline
    }

    /// Pipelines made so far (diagnostics: a frame that makes one stalls on the compile).
    pub(crate) fn pipelines_made(&self) -> usize {
        self.pipelines.len()
    }

    fn bind_group(&mut self, device: &Device, input: &TextureView, multisampled: bool, generation: u64, (bloom, local): (Option<&BloomOutput>, Option<&GridOutput>)) -> BindGroup {
        let key = (generation, multisampled, bloom.map_or(0, |output| output.chain), self.lut_generation, local.map_or(0, |grid| grid.generation));
        if let Some((held, group)) = &self.group
            && *held == key
        {
            return group.clone();
        }
        let params = wgpu::BindGroupEntry { binding: 2, resource: self.params.as_entire_binding() };
        let sampler = wgpu::BindGroupEntry { binding: TONEMAP_SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&self.sampler) };
        let chain = bloom.map_or(&self.neutral_bloom, |output| &output.view);
        let bloom = wgpu::BindGroupEntry { binding: TONEMAP_BLOOM_BINDING, resource: wgpu::BindingResource::TextureView(chain) };
        let lut_view = self.lut.as_ref().map_or(&self.neutral_lut, |lut| &lut.view);
        let lut = wgpu::BindGroupEntry { binding: GRADING_LUT_BINDING, resource: wgpu::BindingResource::TextureView(lut_view) };
        // Without local exposure the shader never reads these: the neutral LUT and bloom texels
        // stand in (a 3D and a 2D float texture, as the bindings ask).
        let (grid_view, mean_view) = local.map_or((&self.neutral_lut, &self.neutral_bloom), |grid| (&grid.grid, &grid.mean));
        let grid = wgpu::BindGroupEntry { binding: TONEMAP_GRID_BINDING, resource: wgpu::BindingResource::TextureView(grid_view) };
        let mean = wgpu::BindGroupEntry { binding: TONEMAP_MEAN_BINDING, resource: wgpu::BindingResource::TextureView(mean_view) };
        let group = if multisampled {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("tonemap msaa"),
                layout: &self.msaa_layout,
                entries: &[sampler, params, wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(input) }, bloom, lut, grid, mean],
            })
        } else {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("tonemap"),
                layout: &self.scene_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(input) }, sampler, params, bloom, lut, grid, mean],
            })
        };
        self.group = Some((key, group.clone()));
        group
    }

    /// Record the bloom chain from the pass's input when the node draws bloom.
    fn encode_bloom(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, pass: &TonemapPass<'_>) -> Option<BloomOutput> {
        let settings = self.bloom?;
        let node = self.bloom_node.as_mut()?;
        let source = if pass.source.multisampled() { BloomSource::Msaa(pass.input) } else { BloomSource::Scene(pass.input) };
        let input = BloomInput { source, render: pass.source_size, output: pass.output_size, settings: &settings, generation: pass.generation };
        node.encode(device, queue, encoder, input)
    }

    /// Record local exposure's grid from the pass's input when the node draws it.
    fn encode_local(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, pass: &TonemapPass<'_>) -> Option<GridOutput> {
        self.local?;
        let node = self.local_node.as_mut()?;
        let source = if pass.source.multisampled() { GridSource::Msaa(pass.input) } else { GridSource::Scene(pass.input) };
        node.encode(device, encoder, source, pass.source_size)
    }

    /// Record one tonemap pass (after the bloom chain, when the node draws bloom): a full-screen
    /// triangle over `pass.target`. Answers the render passes it opened, the chain's included.
    pub(crate) fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, pass: &TonemapPass<'_>) -> u32 {
        self.encode_timed(device, queue, encoder, pass, None)
    }

    /// [`TonemapNode::encode`] with the tonemap pass's own `timestamps` (the grading cost row).
    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        pass: &TonemapPass<'_>,
        timestamps: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) -> u32 {
        let bloom = self.encode_bloom(device, queue, encoder, pass);
        let local = self.encode_local(device, encoder, pass);
        let passes = 1 + bloom.as_ref().map_or(0, |output| output.passes);
        let [local_row, local_grid] = crate::post::local_exposure::tonemap_rows(self.local.filter(|_| local.is_some()), pass.source_size);
        let (intensity, scale, threshold) = bloom.as_ref().map_or((0.0, 0.0, 0.0), |output| (output.intensity, output.scale, output.threshold));
        let [grade, grade_range, section_saturation, section_contrast, section_gamma, section_gain, section_lift] =
            self.grading.rows(self.lut.as_ref().map_or(1, |lut| lut.side));
        let params = GpuTonemapParams {
            source: size_row(pass.source_size),
            output: size_row(pass.target_size),
            shape: [if pass.dither { DITHER_AMPLITUDE } else { 0.0 }, UPSCALE_SHARPNESS, intensity, scale],
            frame: [(pass.frame_index % DITHER_CYCLE) as u32, 0, 0, 0],
            bloom: [threshold, crate::post::bloom::THRESHOLD_KNEE, 0.0, 0.0],
            balance: balance_columns(&pass.balance),
            curve: AgxCurve::punchy().row(),
            grade,
            grade_range,
            section_saturation,
            section_contrast,
            section_gamma,
            section_gain,
            section_lift,
            local: local_row,
            local_grid,
        };
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&params));
        let pipeline = self.pipeline(device, pass.tonemapper, pass.source, pass.format);
        let group = self.bind_group(device, pass.input, pass.source.multisampled(), pass.generation, (bloom.as_ref(), local.as_ref()));
        let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("tonemap"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: pass.target,
                depth_slice: None,
                resolve_target: None,
                // The triangle covers every pixel: nothing to load.
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            timestamp_writes: timestamps,
            ..Default::default()
        });
        render.set_pipeline(&pipeline);
        render.set_bind_group(0, &group, &[]);
        render.draw(0..3, 0..1);
        drop(render);
        passes
    }
}

/// The standalone luminance-weighted resolve (graph node 16 on desktop classes, when something
/// reads the resolved scene before the tonemap): the multisampled scene into the 1x scene.
pub(crate) struct ResolveNode {
    module: ShaderModule,
    layout: BindGroupLayout,
    pipeline_layout: PipelineLayout,
    pipelines: Vec<(TextureFormat, Compiled<RenderPipeline>)>,
    group: Option<(u64, BindGroup)>,
}

impl ResolveNode {
    pub(crate) fn new(device: &Device) -> Result<ResolveNode, RenderError> {
        let module = crate::shaders::module(device, "resolve hdr", crate::shaders::RESOLVE_HDR)?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("resolve hdr"), entries: &[multisampled_entry(0)] });
        Ok(ResolveNode { pipeline_layout: pipeline_layout(device, "resolve hdr", &[&layout]), module, layout, pipelines: Vec::new(), group: None })
    }

    /// The resolve pipeline writing `format`, made once.
    pub(crate) fn pipeline(&mut self, device: &Device, format: TextureFormat) -> Compiled<RenderPipeline> {
        if let Some((_, pipeline)) = self.pipelines.iter().find(|(held, _)| *held == format) {
            return pipeline.clone();
        }
        let made = fullscreen(device, "resolve hdr", &self.pipeline_layout, &self.module, ("vs_resolve_hdr", "fs_resolve_hdr"), format, &[]);
        self.pipelines.push((format, made.clone()));
        made
    }

    /// Pipelines made so far (diagnostics).
    pub(crate) fn pipelines_made(&self) -> usize {
        self.pipelines.len()
    }

    /// Record the resolve of `msaa` into `target` (`format`); `generation` names the inputs.
    pub(crate) fn encode(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, msaa: &TextureView, target: &TextureView, format: TextureFormat, generation: u64) {
        let pipeline = self.pipeline(device, format);
        let group = match &self.group {
            Some((held, group)) if *held == generation => group.clone(),
            _ => {
                let made = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("resolve hdr"),
                    layout: &self.layout,
                    entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(msaa) }],
                });
                self.group = Some((generation, made.clone()));
                made
            }
        };
        let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("resolve hdr"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        render.set_pipeline(&pipeline);
        render.set_bind_group(0, &group, &[]);
        render.draw(0..3, 0..1);
    }
}

/// Tonemap a `width` × `height` image of pre-exposed linear radiance (`texels`, row by row, read
/// as `rgba16float` like the HDR scene) with `tonemapper` into a `Bgra8Unorm` capture, through the
/// node the renderer draws with, dithered as the world target is when `dither` (frame 0). The way
/// to check a curve on the GPU against [`tonemap_cpu`].
pub fn tonemap_image(gpu: &Gpu, tonemapper: Tonemapper, width: u32, height: u32, texels: &[[f32; 4]], dither: bool) -> Result<Capture, RenderError> {
    upscale_image(gpu, tonemapper, TonemapSource::Scene, (width, height), texels, (width, height), dither)
}

/// [`tonemap_image`] through `source` (a single-sampled one: [`TonemapSource::Scene`],
/// [`TonemapSource::Bilinear`] or [`TonemapSource::Sharpen`]) from a `size` image onto a `target`
/// of another size: the fused tonemap and upscale a frame below scale 1 draws.
pub fn upscale_image(
    gpu: &Gpu,
    tonemapper: Tonemapper,
    source: TonemapSource,
    size: (u32, u32),
    texels: &[[f32; 4]],
    target: (u32, u32),
    dither: bool,
) -> Result<Capture, RenderError> {
    tonemap_through(gpu, tonemapper, source, (size, texels), target, dither, None)
}

/// [`upscale_image`] with the look's `grading` (its LUT sized for `class`): the tonemap pass a
/// graded frame draws, over a `size` image of pre-exposed radiance (`texels`) onto a `target`.
#[allow(clippy::too_many_arguments, reason = "the pass's own inputs: upscale_image's plus the grading and the class")]
pub fn grade_image(
    gpu: &Gpu,
    tonemapper: Tonemapper,
    source: TonemapSource,
    image: ((u32, u32), &[[f32; 4]]),
    target: (u32, u32),
    grading: &Grading,
    class: DeviceClass,
    dither: bool,
) -> Result<Capture, RenderError> {
    draw_tonemap_image(gpu, (tonemapper, source), image, target, (dither, None, None), Some((grading, class)))
}

/// [`tonemap_image`] with `bloom` composited (None: no bloom, the bloom-free picture): the chain
/// and the tonemap the renderer records, over a `size` image of pre-exposed radiance onto a target
/// of the same size, dithered at frame 0 when `dither`.
pub fn bloom_image(gpu: &Gpu, tonemapper: Tonemapper, size: (u32, u32), texels: &[[f32; 4]], bloom: Option<BloomSettings>, dither: bool) -> Result<Capture, RenderError> {
    tonemap_through(gpu, tonemapper, TonemapSource::Scene, (size, texels), size, dither, bloom)
}

fn tonemap_through(
    gpu: &Gpu,
    tonemapper: Tonemapper,
    source: TonemapSource,
    image: ((u32, u32), &[[f32; 4]]),
    target: (u32, u32),
    dither: bool,
    bloom: Option<BloomSettings>,
) -> Result<Capture, RenderError> {
    draw_tonemap_image(gpu, (tonemapper, source), image, target, (dither, bloom, None), None)
}

/// [`tonemap_image`] under `local` exposure (None: off, the picture before it): the grid and the
/// tonemap the renderer records, over a `size` image of pre-exposed radiance onto a target of the
/// same size, undithered.
pub fn local_exposure_image(gpu: &Gpu, tonemapper: Tonemapper, size: (u32, u32), texels: &[[f32; 4]], local: Option<LocalExposure>) -> Result<Capture, RenderError> {
    draw_tonemap_image(gpu, (tonemapper, TonemapSource::Scene), (size, texels), size, (false, None, local), None)
}

fn draw_tonemap_image(
    gpu: &Gpu,
    (tonemapper, source): (Tonemapper, TonemapSource),
    (size, texels): ((u32, u32), &[[f32; 4]]),
    target: (u32, u32),
    (dither, bloom, local): (bool, Option<BloomSettings>, Option<LocalExposure>),
    grading: Option<(&Grading, DeviceClass)>,
) -> Result<Capture, RenderError> {
    let (width, height) = size;
    crate::capture::check_capture_size(width, height)?;
    crate::capture::check_capture_size(target.0, target.1)?;
    if texels.len() != (width * height) as usize || source.multisampled() {
        return Err(crate::readback::capture_failed(format!("{} texels for a {width}x{height} image through {source:?}", texels.len())));
    }
    let device = &gpu.device;
    let texture = |label, (width, height): (u32, u32), format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let scene = texture("tonemap image", size, TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    let halves: Vec<u16> = texels.iter().flat_map(|texel| texel.map(f32_to_f16)).collect();
    gpu.queue.write_texture(
        scene.as_image_copy(),
        bytemuck::cast_slice(&halves),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 8), rows_per_image: Some(height) },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    let world_format = crate::renderer::WORLD_FORMAT;
    let output_texture = texture("tonemap target", target, world_format, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let (input, output) = (scene.create_view(&Default::default()), output_texture.create_view(&Default::default()));
    let mut node = TonemapNode::new(device)?;
    node.set_bloom(device, bloom)?;
    node.set_local_exposure(device, local)?;
    if let Some((grading, class)) = grading {
        node.set_grading(device, &gpu.queue, grading, class);
    }
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tonemap image") });
    let pass = TonemapPass {
        source,
        input: &input,
        target: &output,
        format: world_format,
        tonemapper,
        source_size: size,
        target_size: target,
        output_size: target,
        dither,
        frame_index: 0,
        generation: 0,
        balance: COLOR_MATRIX_IDENTITY,
    };
    node.encode(device, &gpu.queue, &mut encoder, &pass);
    let (width, height) = target;
    let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = buffer(device, "tonemap readback", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    encoder.copy_texture_to_buffer(
        output_texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) },
        },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
    Capture::from_padded_rows(width, height, padded, &data)
}

/// Resolves of a timed batch's stamps before the grading timing gives up on stale ones.
const TIMING_RESOLVE_ATTEMPTS: u32 = 8;

/// Times a batch of tonemap passes from its first pass's start to its last pass's end
/// ([`grading_pass_ms`]).
struct BatchTimer {
    queries: wgpu::QuerySet,
    resolve: Buffer,
    staging: Buffer,
    period_ms: f64,
    /// The last pair of stamps read (a stale resolve reads it again).
    last: Option<(u64, u64)>,
}

impl BatchTimer {
    fn new(gpu: &Gpu) -> Result<BatchTimer, RenderError> {
        let device = &gpu.device;
        Ok(BatchTimer {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("grading timing"), ty: wgpu::QueryType::Timestamp, count: 2 }),
            resolve: buffer(device, "grading timing resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?,
            staging: buffer(device, "grading timing readback", 16, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?,
            period_ms: f64::from(gpu.queue.get_timestamp_period()) / 1.0e6,
            last: None,
        })
    }

    /// `passes` passes of `node` drawing `pass` in one command buffer: the GPU time a pass.
    fn pass_ms(&mut self, gpu: &Gpu, node: &mut TonemapNode, pass: &TonemapPass<'_>, passes: u32) -> Result<f32, RenderError> {
        let device = &gpu.device;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("grading timing") });
        for k in 0..passes {
            let (begin, end) = ((k == 0).then_some(0), (k + 1 == passes).then_some(1));
            let timestamps = (begin.is_some() || end.is_some())
                .then_some(wgpu::RenderPassTimestampWrites { query_set: &self.queries, beginning_of_pass_write_index: begin, end_of_pass_write_index: end });
            node.encode_timed(device, &gpu.queue, &mut encoder, pass, timestamps);
        }
        gpu.queue.submit([encoder.finish()]);
        // Metal writes stage-boundary samples after its command buffer: resolve in a submission of
        // its own, and again while the pair is stale (the last batch's) or inverted
        // (`device_class`'s calibration does the same).
        for _ in 0..TIMING_RESOLVE_ATTEMPTS {
            let mut resolving = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("grading timing resolve") });
            resolving.resolve_query_set(&self.queries, 0..2, &self.resolve, 0);
            resolving.copy_buffer_to_buffer(&self.resolve, 0, &self.staging, 0, 16);
            gpu.queue.submit([resolving.finish()]);
            let data = map_read_blocking(gpu, &self.staging, 16)?;
            let [begin, end] = [0, 8].map(|at| data.get(at..at + 8).and_then(|b| b.try_into().ok()).map_or(0, u64::from_le_bytes));
            if end > begin && Some((begin, end)) != self.last {
                self.last = Some((begin, end));
                return Ok(((end - begin) as f64 * self.period_ms / f64::from(passes)) as f32);
            }
        }
        Err(crate::readback::capture_failed("the grading timing's stamps stayed stale"))
    }
}

/// The GPU time of one tonemap pass over a `size` image of `texels` onto a target of the same
/// size, without grading and with `grading` (its LUT sized for `class`), in milliseconds a pass:
/// `batches` pairs of batches, one of each, each batch `passes` passes in its own command buffer
/// timed from its first pass's start to its last pass's end and waited for before the next (the
/// order alternates each pair). A pass's own timestamps on a tile-based GPU overlap its
/// neighbours' (Apple M4 Max: single passes read 0 to 2.2 ms), a batch's span does not. None
/// without timestamp queries (the grading cost row).
pub fn grading_pass_ms(gpu: &Gpu, (size, texels): ((u32, u32), &[[f32; 4]]), (grading, class): (&Grading, DeviceClass), (passes, batches): (u32, u32)) -> Result<Option<Vec<[f32; 2]>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) || passes == 0 || batches == 0 {
        return Ok(None);
    }
    let (width, height) = size;
    crate::capture::check_capture_size(width, height)?;
    if texels.len() != (width * height) as usize {
        return Err(crate::readback::capture_failed(format!("{} texels for a {width}x{height} image", texels.len())));
    }
    let extent = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
    let texture = |label, format, usage| {
        device.create_texture(&wgpu::TextureDescriptor { label: Some(label), size: extent, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] })
    };
    let scene = texture("grading timing scene", TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    let halves: Vec<u16> = texels.iter().flat_map(|texel| texel.map(f32_to_f16)).collect();
    let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 8), rows_per_image: Some(height) };
    gpu.queue.write_texture(scene.as_image_copy(), bytemuck::cast_slice(&halves), layout, extent);
    let world_format = crate::renderer::WORLD_FORMAT;
    let target = texture("grading timing target", world_format, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let (input, output) = (scene.create_view(&Default::default()), target.create_view(&Default::default()));
    let mut nodes = [TonemapNode::new(device)?, TonemapNode::new(device)?];
    nodes[1].set_grading(device, &gpu.queue, grading, class);
    let pass = TonemapPass {
        source: TonemapSource::Scene,
        input: &input,
        target: &output,
        format: world_format,
        tonemapper: Tonemapper::AgxPunchy,
        source_size: size,
        target_size: size,
        output_size: size,
        dither: true,
        frame_index: 0,
        generation: 0,
        balance: COLOR_MATRIX_IDENTITY,
    };
    let mut timer = BatchTimer::new(gpu)?;
    let mut spans = Vec::with_capacity(batches as usize);
    for batch in 0..batches {
        let order = if batch % 2 == 0 { [0usize, 1] } else { [1, 0] };
        let mut pair = [0.0f32; 2];
        for k in order {
            pair[k] = timer.pass_ms(gpu, &mut nodes[k], &pass, passes)?;
        }
        spans.push(pair);
    }
    Ok(Some(spans))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_round_trip_and_hold_the_limits() {
        for value in [0.0f32, 1.0, 0.5, 0.1, 3.75, 1000.0, 65504.0, 6.0e-5, 2.0e-7, -2.5] {
            let back = f16_to_f32(f32_to_f16(value));
            assert!((back - value).abs() <= value.abs() * 1e-3 + 1e-7, "{value} -> {back}");
        }
        assert_eq!(f16_to_f32(f32_to_f16(1.0e6)), f32::INFINITY, "past 65504 is infinite");
        assert_eq!(f32_to_f16(1.0), 0x3c00);
        assert_eq!(f32_to_f16(65504.0), 0x7bff);
    }

    #[test]
    fn the_source_follows_the_scene_and_the_scale() {
        assert_eq!(TonemapSource::pick(false, false, false), TonemapSource::Scene);
        assert_eq!(TonemapSource::pick(true, false, true), TonemapSource::Msaa, "scale 1 never sharpens");
        assert_eq!(TonemapSource::pick(true, true, false), TonemapSource::BilinearMsaa);
        assert_eq!(TonemapSource::pick(false, true, false), TonemapSource::Bilinear);
        assert_eq!(TonemapSource::pick(true, true, true), TonemapSource::Sharpen, "the caller resolves first");
        assert_eq!(MsaaResolve::for_device(FormFactor::Mobile, false), MsaaResolve::Hardware);
        assert_eq!(MsaaResolve::for_device(FormFactor::Desktop, false), MsaaResolve::Weighted);
        assert_eq!(MsaaResolve::for_device(FormFactor::Desktop, true), MsaaResolve::Hardware, "a tile GPU resolves in the pass");
    }

    #[test]
    fn a_capable_desktop_tile_gpu_resolves_weighted_and_phones_and_weak_laptops_in_the_pass() {
        use crate::device_class::{DeviceClass, PerformanceTier};
        for tier in PerformanceTier::ALL {
            let desktop = DeviceClass::new(FormFactor::Desktop, tier);
            let mobile = DeviceClass::new(FormFactor::Mobile, tier);
            assert_eq!(MsaaResolve::for_class(desktop, false), MsaaResolve::Weighted, "{tier:?}: a desktop GPU");
            assert_eq!(MsaaResolve::for_class(mobile, true), MsaaResolve::Hardware, "{tier:?}: a phone keeps its samples in tile memory");
            assert_eq!(MsaaResolve::for_class(mobile, false), MsaaResolve::Hardware);
        }
        // Apple silicon Macs: bright edges stay antialiased where the bandwidth is there.
        let tile_desktop = |tier| MsaaResolve::for_class(DeviceClass::new(FormFactor::Desktop, tier), true);
        assert_eq!(tile_desktop(PerformanceTier::High), MsaaResolve::Weighted);
        assert_eq!(tile_desktop(PerformanceTier::Ultra), MsaaResolve::Weighted);
        assert_eq!(tile_desktop(PerformanceTier::Mid), MsaaResolve::Hardware);
        assert_eq!(tile_desktop(PerformanceTier::Low), MsaaResolve::Hardware);
    }
}
