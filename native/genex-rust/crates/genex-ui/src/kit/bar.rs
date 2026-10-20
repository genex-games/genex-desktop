//! A bar (G6 gameplay UI, UIS-5): a keyed, labelled meter (health, stamina, loading) that AccessKit
//! reads as a progress indicator with its fraction as the value.

use crate::keyed::key_widget;

/// A bar's size when the game names none, in world pixels.
pub const BAR_DEFAULT: egui::Vec2 = egui::vec2(200.0, 16.0);
/// The bar's corner radius, in world pixels.
const BAR_RADIUS: f32 = 3.0;

/// A bar: `Bar::new("hp", 0.75).label("Health").fill(color).show(ui)`.
#[derive(Clone, Copy, Debug)]
pub struct Bar<'a> {
    key: &'a str,
    fraction: f32,
    label: Option<&'a str>,
    fill: Option<egui::Color32>,
    size: egui::Vec2,
}

impl<'a> Bar<'a> {
    /// A bar keyed `key`, `fraction` full (clamped to 0..=1; NaN reads as empty).
    pub fn new(key: &'a str, fraction: f32) -> Bar<'a> {
        let fraction = if fraction.is_nan() { 0.0 } else { fraction.clamp(0.0, 1.0) };
        Bar { key, fraction, label: None, fill: None, size: BAR_DEFAULT }
    }

    /// The bar's name for AccessKit and `hud.items` (default: its key).
    #[must_use]
    pub fn label(self, label: &'a str) -> Bar<'a> {
        Bar { label: Some(label), ..self }
    }

    /// The fill colour (default: the selection colour).
    #[must_use]
    pub fn fill(self, fill: egui::Color32) -> Bar<'a> {
        Bar { fill: Some(fill), ..self }
    }

    /// The bar's size in world pixels.
    #[must_use]
    pub fn size(self, size: egui::Vec2) -> Bar<'a> {
        Bar { size: size.max(egui::Vec2::splat(1.0)), ..self }
    }

    /// The fraction drawn.
    pub fn fraction(&self) -> f32 {
        self.fraction
    }

    /// Draw the bar.
    pub fn show(self, ui: &mut egui::Ui) -> egui::Response {
        let (rect, response) = ui.allocate_exact_size(self.size, egui::Sense::hover());
        let visuals = ui.visuals();
        let fill = self.fill.unwrap_or(visuals.selection.bg_fill);
        ui.painter().rect_filled(rect, BAR_RADIUS, visuals.extreme_bg_color);
        let filled = egui::Rect::from_min_size(rect.min, egui::vec2(rect.width() * self.fraction, rect.height()));
        if filled.width() > 0.0 {
            ui.painter().rect_filled(filled, BAR_RADIUS, fill);
        }
        let label = self.label.unwrap_or(self.key);
        let fraction = f64::from(self.fraction);
        response.widget_info(|| egui::WidgetInfo { value: Some(fraction), ..egui::WidgetInfo::labeled(egui::WidgetType::ProgressIndicator, true, label) });
        key_widget(ui.ctx(), response.id, self.key);
        response
    }
}
