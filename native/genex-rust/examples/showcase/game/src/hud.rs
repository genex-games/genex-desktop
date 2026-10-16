//! The HUD: a small card with the scene's name, the camera, the keys and a settings button that
//! opens the person's graphics panel (O does too). H hides the card.

use genex::egui;

use crate::world::{CameraMode, SHOTS, World};

/// The card's background: the evening's violet, mostly see-through.
const CARD: egui::Color32 = egui::Color32::from_rgba_premultiplied(20, 16, 30, 150);
const TITLE: egui::Color32 = egui::Color32::from_rgb(255, 214, 160);
const BODY: egui::Color32 = egui::Color32::from_rgb(232, 224, 214);
const HINT: egui::Color32 = egui::Color32::from_rgb(190, 180, 196);
/// The settings button's label (checks find it in `state().hud.items`).
pub const SETTINGS_BUTTON: &str = "Settings";
/// The graphics panel's width, in world pixels.
const PANEL_WIDTH: f32 = 300.0;
/// Clear of the screen edges.
const EDGE_MARGIN: i8 = 16;

/// Draw the card in the top-left corner and, while it is open, the graphics panel under it. The
/// area they cover is kept in the world, so a click there is not a tap on the scene.
pub fn ui(world: &mut World, ui: &mut egui::Ui) {
    let mut area: Option<egui::Rect> = None;
    if !world.hud_hidden {
        let card = egui::Frame::new().fill(CARD).corner_radius(10.0).inner_margin(egui::Margin::same(12)).outer_margin(egui::Margin::same(EDGE_MARGIN));
        let shown = card.show(ui, |ui| card_contents(world, ui));
        area = Some(shown.response.rect);
    }
    if world.settings_open {
        let margin = egui::Margin { left: EDGE_MARGIN, ..egui::Margin::ZERO };
        let panel = egui::Frame::popup(ui.style()).outer_margin(margin).show(ui, |ui| {
            ui.set_max_width(PANEL_WIDTH);
            ui.with_layout(egui::Layout::top_down(egui::Align::Min), genex::render::settings_panel);
        });
        let rect = panel.response.rect;
        area = Some(area.map_or(rect, |card| card.union(rect)));
    }
    world.hud_area = area.map(|rect| [rect.min.x, rect.min.y, rect.max.x, rect.max.y]);
}

/// The card: the scene's name, the camera, the keys and the settings button.
fn card_contents(world: &mut World, ui: &mut egui::Ui) {
    let shot = match world.mode {
        CameraMode::Tour => "Tour".to_owned(),
        CameraMode::Free => "Free camera".to_owned(),
        CameraMode::Shot(i) => format!("Shot {}: {}", i + 1, SHOTS[i.min(SHOTS.len() - 1)].name),
    };
    ui.label(egui::RichText::new("Lakeside at golden hour").color(TITLE).size(18.0).strong());
    ui.label(egui::RichText::new(format!("{shot} · {}", world.backdrop.label())).color(BODY).size(14.0));
    ui.add_space(4.0);
    let hint = if world.mode == CameraMode::Free {
        "WASD move · Q/E down/up · arrows or drag to look · Space tour"
    } else {
        "1–5 shots · Space tour · F free camera · B sky/HDRI · tap next shot · O settings · H hide"
    };
    ui.label(egui::RichText::new(hint).color(HINT).size(12.0));
    ui.add_space(4.0);
    if genex::render::settings_button(ui, SETTINGS_BUTTON).clicked() {
        world.settings_open = !world.settings_open;
    }
}
