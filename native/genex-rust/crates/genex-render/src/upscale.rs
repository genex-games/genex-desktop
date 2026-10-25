//! Upscaling modes (lane UQ): the render scale a Live frame aims at, named as players know them
//! from DLSS, FSR and XeSS, each a share of the window a side.
//!
//! - [`UpscaleMode::Native`] renders every window pixel and still resolves through TAA (DLAA, FSR
//!   Native AA); [`UpscaleMode::Quality`], [`UpscaleMode::Balanced`] and
//!   [`UpscaleMode::Performance`] render about 67%, 58% and 50% a side and reach the window by TAA
//!   upscaling (EASU with RCAS on presets without TAA). Ultra Performance (a third a side) is not
//!   offered: the upscale's image rows do not hold there.
//! - Upscaling is on by default (the owner's call, as AAA games ship it in 2024-2026): on a native
//!   desktop the calibration picks [`calibrated_mode`], Quality, Balanced or Performance by the
//!   device class (which Studio's measured score moves) and the window's pixels, and never Native,
//!   however strong the GPU. Native is the person's or the game's explicit choice. Phones and
//!   browsers keep their class's own scale until a mode is chosen.
//! - Dynamic resolution moves within the mode's range: the class's steps times the mode's share.
//!
//! A mode is a share of the **window**; the frame's output may be smaller (presets without TAA
//! draw at most the class's reference pixels and the window present upscales the rest), so
//! [`output_scale`] turns it into the share of the output the renderer is handed.

use crate::device_class::{DeviceClass, FormFactor, TargetOs};
use crate::drs::SCALE_QUANTUM;
use crate::presets::{class_defaults, render_pixel_budget};
use crate::settings::RENDER_SCALE_MIN;

/// An upscaling mode (`UpscaleMode` on the wire): the share of the window a frame renders a side.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum UpscaleMode {
    /// Every window pixel, through TAA (DLAA, FSR Native AA).
    Native,
    /// About two thirds a side.
    Quality,
    /// About 58% a side.
    Balanced,
    /// Half a side.
    Performance,
}

/// The modes the calibration chooses among, best first: never [`UpscaleMode::Native`].
pub const CALIBRATED_MODES: [UpscaleMode; 3] = [UpscaleMode::Quality, UpscaleMode::Balanced, UpscaleMode::Performance];

/// The mode shares, a side: the industry's 2/3, 0.58 and 1/2 on the renderer's 1/32 grid, so each is
/// an exact, stable target size ([`SCALE_QUANTUM`]). Quality takes 22/32 (68.75%), not the nearer
/// 21/32: the upscale's image rows dip there (still grass SSIM 0.912 against native, mean error 3.2
/// levels, where 20/32 holds 0.946 and 22/32 0.956; 18/32 dips too), so no mode or step sits on it.
const QUALITY_SCALE: f32 = 22.0 / 32.0;
const BALANCED_SCALE: f32 = 19.0 / 32.0;
const PERFORMANCE_SCALE: f32 = 16.0 / 32.0;
/// Absorbs float rounding before a share is put on the scale grid.
const GRID_ROUNDING: f32 = 1.0e-4;

impl UpscaleMode {
    /// Every mode, finest first.
    pub const ALL: [UpscaleMode; 4] = [UpscaleMode::Native, UpscaleMode::Quality, UpscaleMode::Balanced, UpscaleMode::Performance];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            UpscaleMode::Native => "native",
            UpscaleMode::Quality => "quality",
            UpscaleMode::Balanced => "balanced",
            UpscaleMode::Performance => "performance",
        }
    }

    /// The mode spelled `wire`, if any.
    pub fn from_wire(wire: &str) -> Option<UpscaleMode> {
        UpscaleMode::ALL.into_iter().find(|mode| mode.wire() == wire)
    }

    /// The share of the window a frame of this mode renders, a side.
    pub const fn scale(self) -> f32 {
        match self {
            UpscaleMode::Native => 1.0,
            UpscaleMode::Quality => QUALITY_SCALE,
            UpscaleMode::Balanced => BALANCED_SCALE,
            UpscaleMode::Performance => PERFORMANCE_SCALE,
        }
    }
}

/// Whether `class` on `os` upscales by default: a desktop class on a native desktop (macOS,
/// Windows, Linux). Phones and browsers keep their class's own scale.
pub fn upscales_by_default(class: DeviceClass, os: TargetOs) -> bool {
    let native_desktop = matches!(os, TargetOs::MacOs | TargetOs::Windows | TargetOs::Linux);
    native_desktop && class.form == FormFactor::Desktop
}

/// The most pixels the calibrated mode of `class` renders: its reference pixels at its nominal
/// scale (the frame budgets were set there: 2560x1440 on desktop-ultra and high, 1080p on mid,
/// 1080p at 0.85 on low).
pub fn calibrated_pixel_budget(class: DeviceClass) -> u64 {
    let nominal = f64::from(class_defaults(class).nominal_scale);
    (render_pixel_budget(class) as f64 * nominal * nominal) as u64
}

/// The window's pixels at a share of `scale` a side.
fn rendered_px(window: (u32, u32), scale: f32) -> f64 {
    let pixels = f64::from(window.0.max(1)) * f64::from(window.1.max(1));
    pixels * f64::from(scale) * f64::from(scale)
}

/// The mode the calibration picks for `class` on `os` in a `window` of that many pixels: the best
/// of [`CALIBRATED_MODES`] whose render pixels fit [`calibrated_pixel_budget`], else Performance.
/// None where the class keeps its own scale ([`upscales_by_default`]).
pub fn calibrated_mode(class: DeviceClass, os: TargetOs, window: (u32, u32)) -> Option<UpscaleMode> {
    upscales_by_default(class, os).then(|| fitting_mode(class, window))
}

/// The best of [`CALIBRATED_MODES`] whose render pixels at `window` fit `class`'s budget, else
/// Performance.
fn fitting_mode(class: DeviceClass, window: (u32, u32)) -> UpscaleMode {
    let budget = calibrated_pixel_budget(class) as f64;
    let fits = |mode: &UpscaleMode| rendered_px(window, mode.scale()) <= budget;
    CALIBRATED_MODES.into_iter().find(fits).unwrap_or(UpscaleMode::Performance)
}

/// The share of `window` the calibrated mode renders a side: its mode's, and past Performance's
/// budget (a panel over 5K) the budget's own, so the default never renders more than
/// [`calibrated_pixel_budget`] (lane UP's cap).
pub fn calibrated_window_scale(class: DeviceClass, window: (u32, u32)) -> f32 {
    let mode = fitting_mode(class, window);
    let budget_side = (calibrated_pixel_budget(class) as f64 / rendered_px(window, 1.0)).sqrt() as f32;
    mode.scale().min(budget_side)
}

/// The share of `output` a frame renders a side for a share of `window_scale` of `window`: the same
/// pixels, on the scale grid at or below them, at most 1 (native at the output) and at least
/// [`RENDER_SCALE_MIN`]. `output` is the window's own pixels on a TAA-upscaling desktop, or fewer
/// where the output is capped (the window present upscales the rest).
pub fn output_scale(window_scale: f32, output: (u32, u32), window: (u32, u32)) -> f32 {
    let ratio = window.0.max(1) as f32 / output.0.max(1) as f32;
    let share = window_scale * ratio;
    let on_grid = ((share / SCALE_QUANTUM) + GRID_ROUNDING).floor() * SCALE_QUANTUM;
    on_grid.clamp(RENDER_SCALE_MIN, 1.0)
}
