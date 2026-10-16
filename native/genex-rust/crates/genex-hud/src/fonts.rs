//! The HUD's fonts and the settings button's gear (renderer pass 2, owner decision D11): egui's
//! text fonts only (Ubuntu Light for text, Hack for monospace), never its two emoji fonts, which
//! were 457 KB of every web build's gzip (12% of the 4 MB budget) for one gear glyph. The gear is
//! drawn with shapes instead ([`settings_button`]); any other glyph the fonts lack shows egui's
//! replacement box, so HUD text keeps to letters, digits and punctuation.
//!
//! The workspace builds egui without its `default_fonts` feature, so every context the HUD makes
//! gets these definitions first ([`install_fonts`]).

use egui::{FontData, FontDefinitions, FontFamily, Pos2, Rect, Response, Shape, Stroke, Ui, Vec2, emath::Rot2, vec2};
use std::sync::Arc;

/// The text font, and the monospace one.
const TEXT_FONT: &str = "Ubuntu-Light";
const MONO_FONT: &str = "Hack";
/// The settings button's smallest size (a large tap target) and the gear's size in points.
const BUTTON_MIN: Vec2 = vec2(120.0, 44.0);
const GEAR_POINTS: f32 = 16.0;
/// The gear's teeth, their length and width (shares of its radius), its hub hole and the gap
/// between the gear and the label.
const GEAR_TEETH: usize = 8;
const TOOTH_LENGTH: f32 = 0.32;
const TOOTH_WIDTH: f32 = 0.38;
const HUB_HOLE: f32 = 0.38;
const ICON_GAP: f32 = 8.0;

/// egui's text fonts without its emoji fonts: Ubuntu Light for proportional text (Hack behind it
/// for symbols), Hack for monospace (Ubuntu Light behind it, as egui's own order).
pub fn fonts() -> FontDefinitions {
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert(MONO_FONT.to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::HACK_REGULAR)));
    fonts.font_data.insert(TEXT_FONT.to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    fonts.families.insert(FontFamily::Proportional, vec![TEXT_FONT.to_owned(), MONO_FONT.to_owned()]);
    fonts.families.insert(FontFamily::Monospace, vec![MONO_FONT.to_owned(), TEXT_FONT.to_owned()]);
    fonts
}

/// Give `ctx` the HUD's fonts (before its first pass lays out any text).
pub fn install_fonts(ctx: &egui::Context) {
    ctx.set_fonts(fonts());
}

/// The settings button: a drawn gear and `label` (checks find it in `state().hud.items`), at least
/// a large tap target. Answers its response (`clicked()` toggles a game's panel).
pub fn settings_button(ui: &mut Ui, label: &str) -> Response {
    let response = ui.add(egui::Button::new(label).min_size(BUTTON_MIN));
    let color = ui.style().interact(&response).text_color();
    let font = egui::TextStyle::Button.resolve(ui.style());
    let galley_width = ui.ctx().fonts_mut(|fonts| fonts.layout_no_wrap(label.to_owned(), font, color).size().x);
    // The gear sits left of the centred label, inside the button.
    let centre_x = response.rect.center().x - galley_width / 2.0 - ICON_GAP - GEAR_POINTS / 2.0;
    let gear = Rect::from_center_size(Pos2::new(centre_x.max(response.rect.left() + GEAR_POINTS), response.rect.center().y), Vec2::splat(GEAR_POINTS));
    ui.painter().extend(gear_shapes(gear, color));
    response.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// A gear filling `rect`: a ring with its teeth around a hub hole, in `color`.
pub fn gear_shapes(rect: Rect, color: egui::Color32) -> Vec<Shape> {
    let radius = rect.width().min(rect.height()) / 2.0;
    let centre = rect.center();
    let body = radius * (1.0 - TOOTH_LENGTH);
    let ring = body - radius * HUB_HOLE;
    let mut shapes = vec![Shape::circle_stroke(centre, body - ring / 2.0, Stroke::new(ring, color))];
    for tooth in 0..GEAR_TEETH {
        let turn = Rot2::from_angle(std::f32::consts::TAU * tooth as f32 / GEAR_TEETH as f32);
        let half = radius * TOOTH_WIDTH / 2.0;
        let corners = [vec2(-half, -radius), vec2(half, -radius), vec2(half, -body + 0.5), vec2(-half, -body + 0.5)];
        let points = corners.iter().map(|corner| centre + turn * *corner).collect();
        shapes.push(Shape::convex_polygon(points, color, Stroke::NONE));
    }
    shapes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Owner decision D11: the HUD links egui's text fonts only; the two emoji fonts are gone.
    #[test]
    fn the_hud_fonts_are_text_fonts_only() {
        let fonts = fonts();
        let names: Vec<&str> = fonts.font_data.keys().map(String::as_str).collect();
        assert_eq!(names, [MONO_FONT, TEXT_FONT]);
        for family in [FontFamily::Proportional, FontFamily::Monospace] {
            assert!(fonts.families[&family].iter().all(|name| !name.contains("moji")), "{family:?}");
        }
        assert!(FontDefinitions::default().font_data.is_empty(), "egui is built without its default (emoji) fonts");
    }

    #[test]
    fn the_settings_button_is_labelled_and_draws_its_gear() {
        let ctx = egui::Context::default();
        install_fonts(&ctx);
        let input = egui::RawInput { screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(400.0, 200.0))), ..Default::default() };
        let mut rect = Rect::NOTHING;
        let mut output = ctx.run_ui(input, |ui| rect = settings_button(ui, "Settings").rect);
        // Handled: epaint asserts a delta is applied before it drops.
        output.textures_delta.clear();
        assert!(rect.width() >= BUTTON_MIN.x && rect.height() >= BUTTON_MIN.y, "a large tap target: {rect:?}");
        let shapes = output.shapes.len();
        assert!(shapes >= GEAR_TEETH + 2, "the gear's teeth, its ring and the label: {shapes}");
        assert_eq!(gear_shapes(Rect::from_center_size(Pos2::ZERO, Vec2::splat(16.0)), egui::Color32::WHITE).len(), GEAR_TEETH + 1);
    }
}
