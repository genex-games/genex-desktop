//! Drawing input on screen with egui: the on-screen touch controls and a prompt glyph's cap.
//!
//! [`paint_touch_controls`] draws a layout over the world (the caller decides whether it is shown,
//! `TouchControls::visible`): a stick's ring and knob (a floating stick's ring where its finger
//! came down), a button that lights while held, a d-pad with its pushed arrows lit. Each control is
//! also an AccessKit node labelled with its label and with its zone as its rect, so a play script
//! finds it by label and touches its rect. The painter only shows what `evaluate_touch` decided
//! from `ctx.touches`; it takes no pointer input, so drawing the controls or not never changes
//! what the game reads.
//!
//! [`glyph_ui`] draws a [`Glyph`] as a cap of its shape with its label: shapes and letters only,
//! no platform logo. Both read colours from the egui style and no clock.

use egui::{Align2, Color32, FontId, Pos2, Rect, Sense, Shape, Stroke, Ui, Vec2};

use crate::glyph::{Glyph, GlyphShape};
use crate::touch::{Control, ControlKind, StickMode, TouchControls, TouchFrame, TouchState};

/// How opaque a resting control is (0..255): the world stays visible through it.
const REST_ALPHA: u8 = 90;
/// How opaque a held control is.
const HELD_ALPHA: u8 = 170;
/// A stick's knob radius, of the stick's radius.
const KNOB_SCALE: f32 = 0.45;
/// A control's label size, of its radius (in points).
const LABEL_SCALE: f32 = 0.35;
/// A d-pad arrow's length, of the d-pad's half side.
const ARROW_SCALE: f32 = 0.35;
/// The smallest arrow push that lights it.
const ARROW_LIT: f32 = 0.5;
/// The line width of rings and outlines, in points.
const OUTLINE_WIDTH: f32 = 2.0;
/// A glyph cap's height, of the body text height.
const GLYPH_HEIGHT_SCALE: f32 = 1.6;
/// The padding each side of a glyph's label, of the cap's height.
const GLYPH_PADDING_SCALE: f32 = 0.3;

/// Where the world is shown: a world of `world` pixels drawn over `rect` (in egui points).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchArea {
    /// The world's size, in pixels (the layout's units).
    pub world: [u32; 2],
    /// The rect it is drawn over.
    pub rect: Rect,
}

impl TouchArea {
    /// Points per world pixel, per axis.
    fn scale(&self) -> Vec2 {
        let world = Vec2::new(self.world[0].max(1) as f32, self.world[1].max(1) as f32);
        self.rect.size() / world
    }

    /// A world point in egui points.
    fn point(&self, at: [f32; 2]) -> Pos2 {
        self.rect.min + Vec2::new(at[0], at[1]) * self.scale()
    }

    /// A world-pixel `[min x, min y, max x, max y]` in egui points.
    fn rect_of(&self, zone: [f32; 4]) -> Rect {
        Rect::from_min_max(self.point([zone[0], zone[1]]), self.point([zone[2], zone[3]]))
    }

    /// A world length in points (the smaller axis scale, so circles stay round and inside).
    fn length(&self, pixels: f32) -> f32 {
        let scale = self.scale();
        pixels * scale.x.min(scale.y)
    }
}

/// Draw `controls` over `area` as `frame` and `state` left them; one hover-only response per
/// control, in layout order (its AccessKit node: its label, its zone as its rect).
pub fn paint_touch_controls(
    ui: &mut Ui,
    controls: &TouchControls,
    area: TouchArea,
    state: &TouchState,
    frame: &TouchFrame,
) -> Vec<egui::Response> {
    controls
        .controls()
        .iter()
        .map(|control| {
            let rect = area.rect_of(control.zone(area.world));
            let id = ui.id().with(("genex-touch", control.id.name()));
            let response = ui.interact(rect, id, Sense::hover());
            response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, &control.label));
            let value = frame.value(control.id);
            match control.kind {
                ControlKind::Stick(mode) => paint_stick(ui, control, mode, area, state, value),
                ControlKind::Button => paint_button(ui, control, area, value),
                ControlKind::Dpad => paint_dpad(ui, control, area, value),
            }
            response
        })
        .collect()
}

/// The fill of a control, lit while held.
fn fill(ui: &Ui, held: bool) -> Color32 {
    let visuals = ui.visuals();
    let (base, alpha) = if held {
        (visuals.selection.bg_fill, HELD_ALPHA)
    } else {
        (visuals.widgets.inactive.bg_fill, REST_ALPHA)
    };
    Color32::from_rgba_unmultiplied(base.r(), base.g(), base.b(), alpha)
}

fn outline(ui: &Ui) -> Stroke {
    Stroke::new(OUTLINE_WIDTH, ui.visuals().widgets.inactive.fg_stroke.color)
}

fn paint_label(ui: &Ui, at: Pos2, text: &str, radius: f32) {
    let font = FontId::proportional((radius * LABEL_SCALE).max(1.0));
    ui.painter().text(at, Align2::CENTER_CENTER, text, font, ui.visuals().text_color());
}

fn paint_stick(ui: &Ui, control: &Control, mode: StickMode, area: TouchArea, state: &TouchState, value: [f32; 2]) {
    let painter = ui.painter();
    let radius = area.length(control.radius);
    let held = state.finger(control.id).is_some();
    if mode == StickMode::Floating && !held {
        // The zone a finger may begin in, outlined while no finger is down.
        let zone = area.rect_of(control.zone(area.world));
        painter.rect_stroke(zone, 0.0, Stroke::new(OUTLINE_WIDTH / 2.0, outline(ui).color), egui::StrokeKind::Inside);
    }
    let base = match (mode, state.origin(control.id)) {
        (StickMode::Floating, Some(origin)) => area.point(origin),
        _ => area.point(control.centre(area.world)),
    };
    painter.circle(base, radius, fill(ui, false), outline(ui));
    let knob = base + Vec2::new(value[0], value[1]) * radius;
    painter.circle_filled(knob, radius * KNOB_SCALE, fill(ui, held));
    paint_label(ui, base, &control.label, radius);
}

fn paint_button(ui: &Ui, control: &Control, area: TouchArea, value: [f32; 2]) {
    let centre = area.point(control.centre(area.world));
    let radius = area.length(control.radius);
    let held = value[0] > 0.0;
    ui.painter().circle(centre, radius, fill(ui, held), outline(ui));
    paint_label(ui, centre, &control.label, radius);
}

fn paint_dpad(ui: &Ui, control: &Control, area: TouchArea, value: [f32; 2]) {
    let painter = ui.painter();
    let zone = area.rect_of(control.zone(area.world));
    painter.rect(zone, 0.0, fill(ui, false), outline(ui), egui::StrokeKind::Inside);
    let centre = zone.center();
    let half = zone.width().min(zone.height()) / 2.0;
    let arrows = [
        (Vec2::new(0.0, -1.0), -value[1]),
        (Vec2::new(0.0, 1.0), value[1]),
        (Vec2::new(-1.0, 0.0), -value[0]),
        (Vec2::new(1.0, 0.0), value[0]),
    ];
    for (direction, push) in arrows {
        let tip = centre + direction * half * (1.0 - ARROW_SCALE / 2.0);
        let back = centre + direction * half * (1.0 - ARROW_SCALE * 1.5);
        let side = Vec2::new(-direction.y, direction.x) * half * ARROW_SCALE / 2.0;
        let colour = fill(ui, push >= ARROW_LIT);
        painter.add(Shape::convex_polygon(vec![tip, back + side, back - side], colour, outline(ui)));
    }
}

/// Draw `glyph` as a cap of its shape with its label; its AccessKit label is the glyph's label.
/// A stick or d-pad cap carries a small icon of its shape before the label.
pub fn glyph_ui(ui: &mut Ui, glyph: &Glyph) -> egui::Response {
    let font = egui::TextStyle::Body.resolve(ui.style());
    let galley = ui.painter().layout_no_wrap(glyph.label.clone(), font, ui.visuals().text_color());
    let height = ui.text_style_height(&egui::TextStyle::Body) * GLYPH_HEIGHT_SCALE;
    let padding = height * GLYPH_PADDING_SCALE;
    let icon = if has_icon(glyph.shape) { height } else { 0.0 };
    let width = (icon + galley.size().x + 2.0 * padding).max(height);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Label, true, &glyph.label));
    if ui.is_rect_visible(rect) {
        paint_cap(ui, rect, glyph.shape);
        let text = Rect::from_min_max(rect.min + Vec2::new(icon, 0.0), rect.max);
        ui.painter().galley(text.center() - galley.size() / 2.0, galley, ui.visuals().text_color());
    }
    response
}

/// Whether a cap draws an icon of its shape before the label.
fn has_icon(shape: GlyphShape) -> bool {
    matches!(shape, GlyphShape::Stick | GlyphShape::Dpad)
}

/// The cap behind a glyph's label: a key cap, a round face button (a pill when its label is long),
/// a pill for shoulders and triggers, and a stick ring or d-pad cross as an icon.
fn paint_cap(ui: &Ui, rect: Rect, shape: GlyphShape) {
    let painter = ui.painter();
    let (fill, stroke) = (ui.visuals().widgets.inactive.bg_fill, outline(ui));
    let radius = rect.height() / 2.0;
    let corner = match shape {
        GlyphShape::FaceButton | GlyphShape::Touch | GlyphShape::Stick | GlyphShape::Shoulder | GlyphShape::Trigger => {
            radius
        }
        GlyphShape::Key | GlyphShape::Mouse | GlyphShape::Chord | GlyphShape::Dpad => radius / 2.0,
    };
    painter.rect(rect, corner, fill, stroke, egui::StrokeKind::Inside);
    let inset = rect.height() * GLYPH_PADDING_SCALE / 1.5;
    let icon = Rect::from_min_size(rect.min, Vec2::splat(rect.height())).shrink(inset);
    match shape {
        GlyphShape::Stick => {
            painter.circle_stroke(icon.center(), icon.height() / 2.0, stroke);
            painter.circle_filled(icon.center(), icon.height() / 2.0 * KNOB_SCALE, stroke.color);
        }
        GlyphShape::Dpad => {
            let arm = icon.height() / 3.0;
            let across = Rect::from_center_size(icon.center(), Vec2::new(icon.width(), arm));
            let down = Rect::from_center_size(icon.center(), Vec2::new(arm, icon.height()));
            painter.rect_filled(across, 0.0, stroke.color);
            painter.rect_filled(down, 0.0, stroke.color);
        }
        _ => {}
    }
}
