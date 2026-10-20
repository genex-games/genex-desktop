//! The HUD's fonts and the settings button's gear (renderer pass 2, owner decision D11): egui's
//! text fonts only (Ubuntu Light for text, Hack for monospace), never its two emoji fonts, which
//! were 457 KB of every web build's gzip (12% of the 4 MB budget) for one gear glyph. The gear is
//! drawn with shapes instead ([`settings_button`]); any other glyph the fonts lack shows egui's
//! replacement box, so HUD text keeps to letters, digits and punctuation.
//!
//! The workspace builds egui without its `default_fonts` feature, so every context the HUD makes
//! gets these definitions first ([`install_fonts`]).
//!
//! A locale whose script those fonts lack (CJK, Arabic, Devanagari, ...) brings its own fallback
//! fonts, game assets that are never in the default bundle ([`LocaleFont`], UIS-8). They go behind
//! the text fonts in both families, so Latin text never changes face. Their bytes are checked
//! before egui sees them: egui panics on a font it cannot parse.

use egui::{FontData, FontDefinitions, FontFamily, Pos2, Rect, Response, Shape, Stroke, Ui, Vec2, emath::Rot2, vec2};
use std::borrow::Cow;
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
/// The most locale fonts a HUD holds.
pub const MAX_LOCALE_FONTS: usize = 8;
/// The largest locale font, in bytes (a full CJK face is about 20 MB).
pub const MAX_LOCALE_FONT_BYTES: usize = 32 * 1024 * 1024;
/// The longest locale font name, in bytes.
pub const MAX_LOCALE_FONT_NAME: usize = 64;
/// The OpenType table directory: its header, one table record, and the sfnt versions a single
/// face starts with (TrueType outlines, CFF outlines, Apple's `true`), as the font reader checks.
const SFNT_HEADER_BYTES: usize = 12;
const SFNT_TABLE_RECORD_BYTES: usize = 16;
const SFNT_VERSIONS: [[u8; 4]; 3] = [[0, 1, 0, 0], *b"OTTO", *b"true"];

/// A fallback font a locale needs: its name (unique, never one of the HUD's own) and its bytes,
/// one OpenType or TrueType face (not a collection).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocaleFont {
    /// The font's name in egui's definitions.
    pub name: String,
    /// The font file.
    pub data: Cow<'static, [u8]>,
}

impl LocaleFont {
    /// A locale font named `name` from `data`.
    pub fn new(name: &str, data: impl Into<Cow<'static, [u8]>>) -> LocaleFont {
        LocaleFont { name: name.to_owned(), data: data.into() }
    }
}

/// Why a list of locale fonts was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum FontRefusal {
    /// More than [`MAX_LOCALE_FONTS`].
    TooMany,
    /// A name that is empty, longer than [`MAX_LOCALE_FONT_NAME`], one of the HUD's own fonts or
    /// given twice.
    BadName,
    /// Bytes that are not one font face, or more than [`MAX_LOCALE_FONT_BYTES`].
    Invalid,
}

/// Check `locale_fonts` before egui sees them.
pub(crate) fn check_locale_fonts(locale_fonts: &[LocaleFont]) -> Result<(), FontRefusal> {
    if locale_fonts.len() > MAX_LOCALE_FONTS {
        return Err(FontRefusal::TooMany);
    }
    for (index, font) in locale_fonts.iter().enumerate() {
        let reserved = [TEXT_FONT, MONO_FONT].contains(&font.name.as_str());
        let repeated = locale_fonts[..index].iter().any(|earlier| earlier.name == font.name);
        let bad_length = font.name.is_empty() || font.name.len() > MAX_LOCALE_FONT_NAME;
        if reserved || repeated || bad_length {
            return Err(FontRefusal::BadName);
        }
        if font.data.len() > MAX_LOCALE_FONT_BYTES || !is_font_face(&font.data) {
            return Err(FontRefusal::Invalid);
        }
    }
    Ok(())
}

/// Whether `data` starts with a whole table directory of one font face: a known sfnt version and
/// every table record inside the bytes. This is what the font reader egui uses checks before
/// it reads any table (it reads tables defensively after that).
fn is_font_face(data: &[u8]) -> bool {
    let Some(header) = data.get(..SFNT_HEADER_BYTES) else { return false };
    let known = SFNT_VERSIONS.iter().any(|version| header[..4] == *version);
    let tables = usize::from(u16::from_be_bytes([header[4], header[5]]));
    known && SFNT_HEADER_BYTES + tables * SFNT_TABLE_RECORD_BYTES <= data.len()
}

/// egui's text fonts without its emoji fonts: Ubuntu Light for proportional text (Hack behind it
/// for symbols), Hack for monospace (Ubuntu Light behind it, as egui's own order).
pub fn fonts() -> FontDefinitions {
    fonts_with(&[])
}

/// [`fonts`] with `locale_fonts` behind the text fonts in both families, in the order given.
/// The caller has checked them ([`crate::Hud::set_locale_fonts`]).
pub(crate) fn fonts_with(locale_fonts: &[LocaleFont]) -> FontDefinitions {
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert(MONO_FONT.to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::HACK_REGULAR)));
    fonts.font_data.insert(TEXT_FONT.to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    let mut proportional = vec![TEXT_FONT.to_owned(), MONO_FONT.to_owned()];
    let mut monospace = vec![MONO_FONT.to_owned(), TEXT_FONT.to_owned()];
    for font in locale_fonts {
        let data = match &font.data {
            Cow::Borrowed(bytes) => FontData::from_static(bytes),
            Cow::Owned(bytes) => FontData::from_owned(bytes.clone()),
        };
        fonts.font_data.insert(font.name.clone(), Arc::new(data));
        proportional.push(font.name.clone());
        monospace.push(font.name.clone());
    }
    fonts.families.insert(FontFamily::Proportional, proportional);
    fonts.families.insert(FontFamily::Monospace, monospace);
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
