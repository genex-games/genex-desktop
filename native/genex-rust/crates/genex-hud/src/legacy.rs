//! The legacy immediate HUD the C++ runtime offers (`hud.cpp`): text, named bars, a crosshair and
//! a fading flash, queued while drawing and shown for one drawn frame. Painted with epaint shapes
//! under the egui widgets.

use egui::epaint::{Color32, CornerRadius, Pos2, Rect, Shape, Stroke, StrokeKind};

/// Items one frame may queue: more than this is a HUD called from a loop by mistake.
pub(crate) const MAX_ITEMS: usize = 256;
/// How much of a text item (or a bar's id) names it in `state().hud.items`, in characters.
pub(crate) const MAX_NAME: usize = 64;
/// A flash keeps this share of its alpha each drawn frame, and is gone below FLASH_CUTOFF.
const FLASH_DECAY: f32 = 0.85;
const FLASH_CUTOFF: f32 = 0.01;
/// The dimmed track a bar is drawn on.
const BAR_TRACK: Color32 = Color32::from_rgba_premultiplied(0, 0, 0, 140);
/// A bar's outline keeps this share of its colour's alpha.
const BAR_OUTLINE_ALPHA: f32 = 0.8;

/// An RGBA colour, 8 bits a channel, straight alpha.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Color {
    /// Red.
    pub r: u8,
    /// Green.
    pub g: u8,
    /// Blue.
    pub b: u8,
    /// Alpha (255 is opaque).
    pub a: u8,
}

impl Color {
    /// Opaque white.
    pub const WHITE: Color = Color::rgb(255, 255, 255);
    /// Opaque black.
    pub const BLACK: Color = Color::rgb(0, 0, 0);
    /// Opaque red.
    pub const RED: Color = Color::rgb(230, 41, 55);
    /// Opaque green.
    pub const GREEN: Color = Color::rgb(0, 228, 48);
    /// Opaque yellow.
    pub const YELLOW: Color = Color::rgb(253, 249, 0);

    /// An opaque colour.
    pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color { r, g, b, a: 255 }
    }

    fn faded(self, alpha: f32) -> Color32 {
        let a = (f32::from(self.a) * alpha.clamp(0.0, 1.0)).round() as u8;
        Color32::from_rgba_unmultiplied(self.r, self.g, self.b, a)
    }
}

impl From<Color> for Color32 {
    fn from(color: Color) -> Color32 {
        Color32::from_rgba_unmultiplied(color.r, color.g, color.b, color.a)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Item {
    Text { name: String, text: String, at: [i32; 2], size: i32, color: Color },
    Bar { name: String, fraction: f32, rect: [i32; 4], color: Color },
}

impl Item {
    fn name(&self) -> &str {
        match self {
            Item::Text { name, .. } | Item::Bar { name, .. } => name,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Crosshair {
    visible: bool,
    size: i32,
    color: Color,
}

impl Default for Crosshair {
    fn default() -> Crosshair {
        Crosshair { visible: false, size: 10, color: Color::WHITE }
    }
}

/// The legacy HUD's state: what is queued for the next drawn frame and what the last one drew.
#[derive(Clone, Debug, Default)]
pub(crate) struct Legacy {
    queued: Vec<Item>,
    drawn: Vec<Item>,
    cross: Crosshair,
    flash_color: Option<Color>,
    flash_alpha: f32,
    drawn_flash: f32,
}

fn short_name(text: &str) -> String {
    text.chars().take(MAX_NAME).collect()
}

impl Legacy {
    pub fn text(&mut self, text: &str, at: [i32; 2], size: i32, color: Color) {
        if self.queued.len() >= MAX_ITEMS {
            return;
        }
        let item = Item::Text { name: short_name(text), text: text.to_owned(), at, size: size.max(1), color };
        self.queued.push(item);
    }

    pub fn bar(&mut self, id: &str, fraction: f32, rect: [i32; 4], color: Color) {
        if self.queued.len() >= MAX_ITEMS {
            return;
        }
        // NaN reads as empty.
        let fraction = if fraction > 0.0 { fraction.min(1.0) } else { 0.0 };
        let rect = [rect[0], rect[1], rect[2].max(0), rect[3].max(0)];
        self.queued.push(Item::Bar { name: short_name(id), fraction, rect, color });
    }

    pub fn crosshair(&mut self, visible: bool, size: i32, color: Color) {
        self.cross = Crosshair { visible, size: size.max(1), color };
    }

    pub fn flash(&mut self, color: Color, alpha: f32) {
        self.flash_color = Some(color);
        self.flash_alpha = if alpha > 0.0 { alpha.min(1.0) } else { 0.0 };
    }

    /// A frame was drawn: the queue becomes what it showed, and the flash fades one step.
    pub fn end_frame(&mut self) {
        self.drawn = std::mem::take(&mut self.queued);
        self.drawn_flash = if self.flash_alpha > FLASH_CUTOFF { self.flash_alpha } else { 0.0 };
        self.flash_alpha = if self.flash_alpha > FLASH_CUTOFF { self.flash_alpha * FLASH_DECAY } else { 0.0 };
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.drawn.iter().map(Item::name)
    }

    pub fn crosshair_visible(&self) -> bool {
        self.cross.visible
    }

    pub fn flash_alpha(&self) -> f32 {
        self.flash_alpha
    }

    /// The last drawn frame as epaint shapes over a world of `world_size` pixels; text needs the
    /// context's fonts, which it lays out with `layout`.
    pub fn shapes(&self, world_size: [u32; 2], mut layout: impl FnMut(&str, f32, Color32) -> Shape) -> Vec<Shape> {
        let mut shapes = Vec::new();
        for item in &self.drawn {
            match item {
                Item::Text { text, at, size, color, .. } => {
                    let mut shape = layout(text, *size as f32, (*color).into());
                    shape.translate(egui::vec2(at[0] as f32, at[1] as f32));
                    shapes.push(shape);
                }
                Item::Bar { fraction, rect, color, .. } => bar_shapes(&mut shapes, *fraction, *rect, *color),
            }
        }
        let [width, height] = [world_size[0] as f32, world_size[1] as f32];
        if self.cross.visible {
            let centre = Pos2::new((world_size[0] / 2) as f32, (world_size[1] / 2) as f32);
            let size = self.cross.size as f32;
            let stroke = Stroke::new(1.0, Color32::from(self.cross.color));
            shapes.push(Shape::line_segment([centre - egui::vec2(size, 0.0), centre + egui::vec2(size, 0.0)], stroke));
            shapes.push(Shape::line_segment([centre - egui::vec2(0.0, size), centre + egui::vec2(0.0, size)], stroke));
        }
        if let (Some(color), true) = (self.flash_color, self.drawn_flash > 0.0) {
            let world = Rect::from_min_size(Pos2::ZERO, egui::vec2(width, height));
            shapes.push(Shape::rect_filled(world, CornerRadius::ZERO, color.faded(self.drawn_flash)));
        }
        shapes
    }
}

fn bar_shapes(shapes: &mut Vec<Shape>, fraction: f32, rect: [i32; 4], color: Color) {
    let [x, y, width, height] = rect.map(|v| v as f32);
    let track = Rect::from_min_size(Pos2::new(x, y), egui::vec2(width, height));
    let filled = Rect::from_min_size(Pos2::new(x, y), egui::vec2((width * fraction).floor(), height));
    shapes.push(Shape::rect_filled(track, CornerRadius::ZERO, BAR_TRACK));
    shapes.push(Shape::rect_filled(filled, CornerRadius::ZERO, Color32::from(color)));
    let outline = Stroke::new(1.0, color.faded(BAR_OUTLINE_ALPHA));
    shapes.push(Shape::rect_stroke(track, CornerRadius::ZERO, outline, StrokeKind::Inside));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bar_fraction_is_clamped_and_nan_reads_empty() {
        let rows = [(f32::NAN, 0.0), (-1.0, 0.0), (0.25, 0.25), (3.0, 1.0)];
        for (input, expected) in rows {
            let mut legacy = Legacy::default();
            legacy.bar("hp", input, [0, 0, 10, 10], Color::WHITE);
            let Item::Bar { fraction, .. } = &legacy.queued[0] else { panic!("a bar") };
            assert_eq!(*fraction, expected, "{input}");
        }
    }
}
