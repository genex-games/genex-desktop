//! The loading screen a native window shows from its first frame until the game's first lit frame
//! (renderer pass 2, owner decision D11): the game's colours (`genex.toml` `[render.loading]`,
//! the host's `src/shared/loading-style.ts`), its title, a spinner that turns with the display's
//! own frames and a bar with the stage in words, painted with egui over a clear of the background.
//! The web shell draws the same screen in HTML (`src/game-template-rust/web/shell.html`).
//!
//! Display only and cheap to compile (egui's one pipeline), so it is up long before the game's own
//! pipelines; nothing here reads a clock: the shell hands over the seconds its frames advanced.

use crate::hud::HudPaint;
use crate::paint::HudPainter;
use egui::{Align2, Color32, FontId, Pos2, Rect, Shape, Stroke, emath::Rot2, vec2};

/// The spinner turns once in this many seconds.
const SPIN_SECONDS: f32 = 0.9;
/// Points along the spinner's arc, and the share of a turn it covers.
const ARC_POINTS: usize = 24;
const ARC_TURN: f32 = 0.75;
/// Sizes in points (one point is `pixels_per_point` device pixels): the title, the stage, the
/// spinner's radius and stroke, the bar's width and height, and the gaps between them.
const TITLE_POINTS: f32 = 28.0;
const STAGE_POINTS: f32 = 15.0;
const SPINNER_RADIUS: f32 = 18.0;
const SPINNER_STROKE: f32 = 3.0;
const BAR_WIDTH: f32 = 280.0;
const BAR_HEIGHT: f32 = 4.0;
const GAP: f32 = 18.0;
/// The bar's track and the spinner's ring are the text colour at this opacity.
const TRACK_ALPHA: u8 = 36;
/// The stage's words are the text colour at this opacity.
const STAGE_ALPHA: u8 = 185;
/// The share of the window's width the bar takes at most (a narrow window).
const BAR_MAX_SHARE: f32 = 0.7;

/// How the screen looks: the game's title and colours, sRGB.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadingLook {
    /// What the screen names (the game's title unless `[render.loading] title` says otherwise).
    pub title: String,
    /// The screen's colour.
    pub background: [u8; 3],
    /// The spinner and the bar.
    pub accent: [u8; 3],
    /// The title and the stage.
    pub text: [u8; 3],
}

impl LoadingLook {
    /// The default colours (`LOADING_DEFAULTS` in `src/shared/loading-style.ts`) around `title`.
    pub fn new(title: impl Into<String>) -> LoadingLook {
        LoadingLook { title: title.into(), background: [0x1b, 0x22, 0x33], accent: [0x7f, 0xb2, 0xec], text: [0xec, 0xea, 0xe4] }
    }
}

/// `#rrggbb` as its three bytes; None for anything else.
pub fn parse_hex_color(value: &str) -> Option<[u8; 3]> {
    let digits = value.strip_prefix('#').filter(|digits| digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let byte = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

/// Where the boot is, as the screen shows it: the stage in words and how far along the bar is.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadingProgress {
    /// The stage's words, with its count when it has one ("Preparing shaders · 12 of 40").
    pub words: String,
    /// The bar's fill, 0..=1.
    pub fill: f32,
}

/// The screen: its egui context and its painter (made for the target's format on first use).
pub struct LoadingScreen {
    ctx: egui::Context,
    painter: Option<(wgpu::TextureFormat, HudPainter)>,
    /// The seconds the shell's frames advanced, which turn the spinner.
    seconds: f32,
}

impl Default for LoadingScreen {
    fn default() -> Self {
        LoadingScreen::new()
    }
}

impl std::fmt::Debug for LoadingScreen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadingScreen").field("seconds", &self.seconds).finish_non_exhaustive()
    }
}

impl LoadingScreen {
    /// A screen with no painter yet.
    pub fn new() -> LoadingScreen {
        let ctx = egui::Context::default();
        crate::fonts::install_fonts(&ctx);
        LoadingScreen { ctx, painter: None, seconds: 0.0 }
    }

    /// The spinner's turn so far, 0..1 (tests and the shells' rows).
    pub fn turn(&self) -> f32 {
        (self.seconds / SPIN_SECONDS).fract()
    }

    /// Advance the spinner by the `seconds` the shell's frame took.
    pub fn advance(&mut self, seconds: f32) {
        if seconds.is_finite() && seconds > 0.0 {
            self.seconds += seconds;
        }
    }

    /// Clear `target` (`size` pixels of `format`) to the look's background and paint the title,
    /// the spinner, the bar and the stage over it at `pixels_per_point`; the commands go to
    /// `queue` at once. Answers the primitives drawn.
    #[expect(clippy::too_many_arguments, reason = "the target, its format and size, the display's ratio and what to show")]
    pub fn paint(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        size: [u32; 2],
        pixels_per_point: f32,
        look: &LoadingLook,
        progress: &LoadingProgress,
    ) -> usize {
        let mut paint = self.tessellate(size, pixels_per_point, look, progress);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("loading screen") });
        clear(&mut encoder, target, background_of(look.background, format));
        let painter = match &mut self.painter {
            Some((made_for, painter)) if *made_for == format => painter,
            slot => &mut slot.insert((format, HudPainter::new(device, format))).1,
        };
        let drawn = painter.draw(device, queue, &mut encoder, target, size, &mut paint);
        queue.submit([encoder.finish()]);
        drawn
    }

    /// The screen's shapes for a target of `size` pixels, tessellated at one point per pixel
    /// (sizes are scaled by `pixels_per_point`, so text is rasterized at the display's own size).
    pub fn tessellate(&mut self, size: [u32; 2], pixels_per_point: f32, look: &LoadingLook, progress: &LoadingProgress) -> HudPaint {
        let screen = Rect::from_min_size(Pos2::ZERO, vec2(size[0] as f32, size[1] as f32));
        let input = egui::RawInput { screen_rect: Some(screen), focused: false, ..egui::RawInput::default() };
        let scale = if pixels_per_point.is_finite() && pixels_per_point > 0.0 { pixels_per_point } else { 1.0 };
        let turn = self.turn();
        let output = self.ctx.run_ui(input, |ui| {
            draw(ui.painter(), screen, scale, turn, look, progress);
        });
        HudPaint { primitives: self.ctx.tessellate(output.shapes, 1.0), textures_delta: output.textures_delta, pixels_per_point: 1.0 }
    }
}

/// The title above the spinner above the bar above the stage, centred on `screen`.
fn draw(painter: &egui::Painter, screen: Rect, scale: f32, turn: f32, look: &LoadingLook, progress: &LoadingProgress) {
    let text = rgb(look.text, u8::MAX);
    let accent = rgb(look.accent, u8::MAX);
    let track = rgb(look.text, TRACK_ALPHA);
    let gap = GAP * scale;
    let radius = SPINNER_RADIUS * scale;
    let block = TITLE_POINTS * scale + radius * 2.0 + BAR_HEIGHT * scale + STAGE_POINTS * scale + gap * 3.0;
    let mut y = screen.center().y - block / 2.0;
    let x = screen.center().x;
    painter.text(Pos2::new(x, y), Align2::CENTER_TOP, &look.title, FontId::proportional(TITLE_POINTS * scale), text);
    y += TITLE_POINTS * scale + gap + radius;
    let centre = Pos2::new(x, y);
    painter.circle_stroke(centre, radius, Stroke::new(SPINNER_STROKE * scale, track));
    let start = Rot2::from_angle(turn * std::f32::consts::TAU);
    let arc: Vec<Pos2> = (0..=ARC_POINTS)
        .map(|step| {
            let along = Rot2::from_angle(ARC_TURN * std::f32::consts::TAU * step as f32 / ARC_POINTS as f32);
            centre + (start * along) * vec2(0.0, -radius)
        })
        .collect();
    painter.add(Shape::line(arc, Stroke::new(SPINNER_STROKE * scale, accent)));
    y += radius + gap;
    let width = (BAR_WIDTH * scale).min(screen.width() * BAR_MAX_SHARE);
    let bar = Rect::from_min_size(Pos2::new(x - width / 2.0, y), vec2(width, BAR_HEIGHT * scale));
    painter.rect_filled(bar, BAR_HEIGHT * scale / 2.0, track);
    let fill = progress.fill.clamp(0.0, 1.0);
    if fill > 0.0 {
        let done = Rect::from_min_size(bar.min, vec2(width * fill, bar.height()));
        painter.rect_filled(done, BAR_HEIGHT * scale / 2.0, accent);
    }
    y += BAR_HEIGHT * scale + gap;
    painter.text(Pos2::new(x, y), Align2::CENTER_TOP, &progress.words, FontId::proportional(STAGE_POINTS * scale), rgb(look.text, STAGE_ALPHA));
}

fn rgb([r, g, b]: [u8; 3], alpha: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(r, g, b, alpha)
}

/// The background as the clear colour a target of `format` stores: an sRGB target takes linear
/// values (the hardware encodes them), any other the sRGB bytes as they are.
fn background_of([r, g, b]: [u8; 3], format: wgpu::TextureFormat) -> wgpu::Color {
    let channel = |byte: u8| {
        let value = f64::from(byte) / 255.0;
        if !format.is_srgb() {
            return value;
        }
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    };
    wgpu::Color { r: channel(r), g: channel(g), b: channel(b), a: 1.0 }
}

fn clear(encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, color: wgpu::Color) {
    let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("loading screen clear"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(color), store: wgpu::StoreOp::Store },
        })],
        ..wgpu::RenderPassDescriptor::default()
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hex_colour_is_its_bytes_and_anything_else_is_refused() {
        assert_eq!(parse_hex_color("#1b2233"), Some([0x1b, 0x22, 0x33]));
        assert_eq!(parse_hex_color("#7FB2EC"), Some([0x7f, 0xb2, 0xec]));
        for bad in ["1b2233", "#abc", "#1b22334", "#gg0000", "red", "#+12233", ""] {
            assert_eq!(parse_hex_color(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_spinner_turns_with_the_frames_the_shell_hands_over() {
        let mut screen = LoadingScreen::new();
        assert_eq!(screen.turn(), 0.0);
        screen.advance(SPIN_SECONDS / 4.0);
        assert!((screen.turn() - 0.25).abs() < 1e-5);
        screen.advance(f32::NAN);
        screen.advance(-1.0);
        assert!((screen.turn() - 0.25).abs() < 1e-5, "a broken frame time never turns it back");
        screen.advance(SPIN_SECONDS);
        assert!((screen.turn() - 0.25).abs() < 1e-4, "a whole turn later it is where it was");
    }

    #[test]
    fn the_screen_draws_the_title_the_spinner_the_bar_and_the_stage() {
        let mut screen = LoadingScreen::new();
        let look = LoadingLook::new("Harbour Nights");
        let progress = LoadingProgress { words: "Preparing shaders · 12 of 40".to_owned(), fill: 0.3 };
        let paint = screen.tessellate([960, 540], 2.0, &look, &progress);
        assert!(!paint.primitives.is_empty(), "something is drawn");
        assert!(!paint.textures_delta.set.is_empty(), "the font atlas goes up with the first paint");
        let empty = LoadingProgress { words: String::new(), fill: 0.0 };
        let without = screen.tessellate([960, 540], 2.0, &LoadingLook::new(""), &empty);
        let vertices = |paint: &HudPaint| -> usize {
            paint
                .primitives
                .iter()
                .map(|primitive| match &primitive.primitive {
                    egui::epaint::Primitive::Mesh(mesh) => mesh.vertices.len(),
                    egui::epaint::Primitive::Callback(_) => 0,
                })
                .sum()
        };
        assert!(vertices(&paint) > vertices(&without), "the title, the fill and the words add geometry");
        // Handled: epaint asserts a delta is applied before it drops.
        for mut done in [paint, without] {
            done.textures_delta.clear();
        }
    }

    #[test]
    fn the_background_is_stored_as_given_or_linearized_for_an_srgb_target() {
        let plain = background_of([255, 128, 0], wgpu::TextureFormat::Bgra8Unorm);
        assert!((plain.g - 128.0 / 255.0).abs() < 1e-9);
        let linear = background_of([255, 128, 0], wgpu::TextureFormat::Bgra8UnormSrgb);
        assert!((linear.r - 1.0).abs() < 1e-9 && linear.b == 0.0);
        assert!(linear.g < plain.g, "mid grey is darker in linear values: {}", linear.g);
    }
}
