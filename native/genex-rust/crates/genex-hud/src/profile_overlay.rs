//! The player profile overlay (G6 PROFILE, PROF-8): a small panel in the window's top-right corner
//! with the frame times, the hitch count, the heaviest scopes (the game's marked) and the game's
//! counters, read from the profiler's summary (`state().volatile.profile`).
//!
//! It has its own egui context and its own painter, and it is painted over a window present only:
//! after the world and the HUD, outside the tick. So it is never in a capture, never in
//! `state().hud.items` or `hud.widgets`, and toggling it changes neither the checksum nor what the
//! next tick's HUD sees. The runtime's dev flavour toggles it with Ctrl+Shift+P ([`ProfileOverlay::note_keys`]).

use egui::{Align2, Color32, FontId, Pos2, Rect, Stroke, vec2};

use crate::hud::HudPaint;
use crate::paint::HudPainter;

/// The heaviest scopes the panel lists.
pub const PROFILE_OVERLAY_TOP_ROWS: usize = 5;
/// The counters the panel lists (by name).
pub const PROFILE_OVERLAY_COUNTER_ROWS: usize = 4;
/// The keys of the toggle chord, by DOM `code`: either Control, either Shift, and P.
const CHORD_CONTROL: [&str; 2] = ["ControlLeft", "ControlRight"];
const CHORD_SHIFT: [&str; 2] = ["ShiftLeft", "ShiftRight"];
const CHORD_KEY: &str = "KeyP";
/// Sizes in points: the text, a line, the panel's width, its inner margin and its gap from the
/// window's corner.
const TEXT_POINTS: f32 = 12.0;
const LINE_POINTS: f32 = 16.0;
const PANEL_WIDTH: f32 = 230.0;
const MARGIN: f32 = 8.0;
const CORNER_GAP: f32 = 8.0;
/// A window this many pixels tall draws the panel at one pixel per point; taller ones scale it up
/// (to at most [`PANEL_SCALE_MAX`]), so it reads the same on any world size.
const REFERENCE_HEIGHT: f32 = 540.0;
const PANEL_SCALE_MAX: f32 = 3.0;
/// The panel's fill and its words, sRGB.
const PANEL_FILL: Color32 = Color32::from_rgba_premultiplied(8, 10, 16, 210);
const PANEL_EDGE: Color32 = Color32::from_rgb(70, 78, 96);
const TEXT: Color32 = Color32::from_rgb(232, 234, 240);
const DIM: Color32 = Color32::from_rgb(160, 166, 180);
const GAME_SCOPE: Color32 = Color32::from_rgb(127, 178, 236);
const HITCH: Color32 = Color32::from_rgb(240, 160, 90);

/// What the panel shows: the summary's numbers, or nothing while no profiler runs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProfileView {
    /// The frames the percentiles cover.
    pub frames: u64,
    /// CPU frame time, median and 95th percentile, in milliseconds.
    pub cpu_ms: [f64; 2],
    /// GPU frame time, median and 95th percentile, when the GPU lane has any.
    pub gpu_ms: Option<[f64; 2]>,
    /// Hitches so far.
    pub hitches: u64,
    /// The heaviest scopes: name, whether the game named it, its p95 in milliseconds.
    pub top: Vec<(String, bool, f64)>,
    /// The game's counters: name and last value.
    pub counters: Vec<(String, f64)>,
}

impl ProfileView {
    /// The view of a `state().volatile.profile` summary's JSON; None when it does not parse.
    pub fn from_summary(json: &[u8]) -> Option<ProfileView> {
        let summary = genex_core::json::parse(json).ok()?;
        let pair = |value: &genex_core::json::Value| [value["p50"].as_f64(), value["p95"].as_f64()];
        let gpu = summary.get("gpu").filter(|gpu| !gpu.is_null()).map(pair);
        let top = summary["top"].items().iter().take(PROFILE_OVERLAY_TOP_ROWS);
        let counters = summary["counters"].members().iter().take(PROFILE_OVERLAY_COUNTER_ROWS);
        Some(ProfileView {
            frames: summary["frames"].as_f64() as u64,
            cpu_ms: pair(&summary["cpu"]),
            gpu_ms: gpu,
            hitches: summary["hitches"]["count"].as_f64() as u64,
            top: top.map(|row| (row["scope"].as_str().to_owned(), row["game"].as_bool(), row["p95"].as_f64())).collect(),
            counters: counters.map(|(name, value)| (String::from_utf8_lossy(name).into_owned(), value.as_f64())).collect(),
        })
    }
}

/// The overlay: shown or hidden, the last view, its own egui context and its painter (made for the
/// window's format on first use).
pub struct ProfileOverlay {
    ctx: egui::Context,
    painter: Option<(wgpu::TextureFormat, HudPainter)>,
    shown: bool,
    view: Option<ProfileView>,
    /// Whether the chord was held on the last frame (the toggle is its press).
    chord_held: bool,
}

impl Default for ProfileOverlay {
    fn default() -> Self {
        ProfileOverlay::new()
    }
}

impl std::fmt::Debug for ProfileOverlay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileOverlay").field("shown", &self.shown).field("view", &self.view).finish_non_exhaustive()
    }
}

impl ProfileOverlay {
    /// A hidden overlay with no painter yet.
    pub fn new() -> ProfileOverlay {
        let ctx = egui::Context::default();
        crate::fonts::install_fonts(&ctx);
        ProfileOverlay { ctx, painter: None, shown: false, view: None, chord_held: false }
    }

    /// Whether it is shown.
    pub fn shown(&self) -> bool {
        self.shown
    }

    /// Show or hide it.
    pub fn set_shown(&mut self, shown: bool) {
        self.shown = shown;
    }

    /// The keys held on a window frame (DOM `code` names): pressing Ctrl+Shift+P toggles the
    /// overlay. Answers whether it toggled.
    pub fn note_keys(&mut self, held: &[String]) -> bool {
        let down = |codes: &[&str]| held.iter().any(|key| codes.contains(&key.as_str()));
        let chord = down(&CHORD_CONTROL) && down(&CHORD_SHIFT) && down(&[CHORD_KEY]);
        let pressed = chord && !self.chord_held;
        self.chord_held = chord;
        if pressed {
            self.shown = !self.shown;
        }
        pressed
    }

    /// The numbers to show (None: no profiler runs).
    pub fn set_view(&mut self, view: Option<ProfileView>) {
        self.view = view;
    }

    /// Its egui context (its own, never the HUD's).
    pub fn context(&self) -> &egui::Context {
        &self.ctx
    }

    /// The panel's shapes for a window of `size` pixels at `pixels_per_point`; None while hidden.
    pub fn tessellate(&mut self, size: [u32; 2], pixels_per_point: f32) -> Option<HudPaint> {
        if !self.shown {
            return None;
        }
        let scale = if pixels_per_point.is_finite() && pixels_per_point > 0.0 { pixels_per_point } else { 1.0 };
        let screen = Rect::from_min_size(Pos2::ZERO, vec2(size[0] as f32 / scale, size[1] as f32 / scale));
        let input = egui::RawInput { screen_rect: Some(screen), focused: false, ..egui::RawInput::default() };
        let lines = lines(self.view.as_ref());
        let output = self.ctx.run_ui(input, |ui| draw(ui.painter(), screen, &lines));
        Some(HudPaint { primitives: self.ctx.tessellate(output.shapes, scale), textures_delta: output.textures_delta, pixels_per_point: scale })
    }

    /// The pixels per point the panel is painted at in a window of `size` pixels.
    pub fn window_scale(size: [u32; 2]) -> f32 {
        (size[1] as f32 / REFERENCE_HEIGHT).clamp(1.0, PANEL_SCALE_MAX)
    }

    /// Paint the panel over `target` (`size` pixels of `format`, loaded, never cleared) at
    /// [`ProfileOverlay::window_scale`] when shown; the commands go to `queue` at once. Answers the
    /// primitives drawn (0 while hidden).
    pub fn paint(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::TextureView, format: wgpu::TextureFormat, size: [u32; 2]) -> usize {
        let Some(mut paint) = self.tessellate(size, ProfileOverlay::window_scale(size)) else { return 0 };
        let painter = match &mut self.painter {
            Some((made_for, painter)) if *made_for == format => painter,
            slot => &mut slot.insert((format, HudPainter::new(device, format))).1,
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("profile overlay") });
        let drawn = painter.draw(device, queue, &mut encoder, target, size, &mut paint);
        queue.submit([encoder.finish()]);
        drawn
    }
}

/// One line of the panel: its words and colour.
type Line = (String, Color32);

/// The panel's lines for `view`.
fn lines(view: Option<&ProfileView>) -> Vec<Line> {
    let mut lines = vec![("Profile".to_owned(), TEXT)];
    let Some(view) = view else {
        lines.push(("The profiler is not running".to_owned(), DIM));
        return lines;
    };
    let [cpu50, cpu95] = view.cpu_ms;
    lines.push((format!("CPU {cpu50:.2} ms · p95 {cpu95:.2}"), TEXT));
    let gpu = view.gpu_ms.map_or_else(|| "GPU –".to_owned(), |[p50, p95]| format!("GPU {p50:.2} ms · p95 {p95:.2}"));
    lines.push((gpu, TEXT));
    let hitch_colour = if view.hitches > 0 { HITCH } else { DIM };
    lines.push((format!("Hitches {} · {} frames", view.hitches, view.frames), hitch_colour));
    for (scope, game, p95) in &view.top {
        let colour = if *game { GAME_SCOPE } else { DIM };
        lines.push((format!("{scope} {p95:.2} ms"), colour));
    }
    for (name, value) in &view.counters {
        lines.push((format!("{name} = {value}"), DIM));
    }
    lines
}

/// The panel in the top-right corner of `screen`, a line under the next.
fn draw(painter: &egui::Painter, screen: Rect, lines: &[Line]) {
    let height = MARGIN * 2.0 + LINE_POINTS * lines.len() as f32;
    let min = Pos2::new(screen.right() - CORNER_GAP - PANEL_WIDTH, screen.top() + CORNER_GAP);
    let panel = Rect::from_min_size(min, vec2(PANEL_WIDTH, height));
    painter.rect_filled(panel, 4.0, PANEL_FILL);
    painter.rect_stroke(panel, 4.0, Stroke::new(1.0, PANEL_EDGE), egui::StrokeKind::Inside);
    for (at, (words, colour)) in lines.iter().enumerate() {
        let y = panel.top() + MARGIN + LINE_POINTS * at as f32;
        painter.text(Pos2::new(panel.left() + MARGIN, y), Align2::LEFT_TOP, words, FontId::monospace(TEXT_POINTS), *colour);
    }
}
