//! The in-game graphics settings panel: an egui widget a game shows from its `on_ui` hook
//! (through `genex::render::settings_panel`, which fills it from the renderer's settings). It
//! knows nothing about the renderer: it shows the [`SettingsPanel`] it is given (a row of quality
//! presets, a render-scale slider, one switch per feature and the device class detected) and answers
//! what the person changed as [`PanelChange`]s. The caller applies them outside the simulation.
//!
//! Like every HUD widget it runs inside the tick from the tick's merged input, so a play script
//! can drive it by label; what it changes is display state, never something the checksum reads.

use egui::Ui;

/// The panel's words (user copy).
const MESSAGE: Message = Message {
    heading: "Graphics",
    quality: "Quality",
    render_scale: "Render scale",
    features: "Features",
    device: "Device",
    emulated: "emulating",
    reset: "Reset graphics settings",
};

struct Message {
    heading: &'static str,
    quality: &'static str,
    render_scale: &'static str,
    features: &'static str,
    device: &'static str,
    emulated: &'static str,
    reset: &'static str,
}

/// The slider's step: render scales are coarse (each is an exact target size).
const SCALE_STEP: f64 = 0.05;

/// What the panel shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SettingsPanel<'a> {
    /// The preset choices, by label (the caller's first is usually "Auto").
    pub presets: &'a [String],
    /// The entry chosen.
    pub preset: usize,
    /// The render scale in force (of the output size).
    pub render_scale: f32,
    /// The range the slider moves over.
    pub scale_range: (f32, f32),
    /// One switch per feature: its label and whether it is on.
    pub features: &'a [(&'a str, bool)],
    /// The device class the probe detected, by label.
    pub detected: &'a str,
    /// The class in force when it differs (an emulated class), by label.
    pub emulated: Option<&'a str>,
}

/// One change the person made in the panel this tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PanelChange {
    /// A preset choice, by index.
    Preset(usize),
    /// A new render scale.
    RenderScale(f32),
    /// A feature switch, by index, and its new state.
    Feature(usize, bool),
    /// Back to the game's and the device's defaults.
    Reset,
}

/// Show `panel` in `ui`; answers the changes the person made this tick, in the order made.
///
/// Everything is drawn inside the panel's own rect (no popup), so a game that keeps its taps off
/// the panel's rect never sees a click meant for it, and every control is reachable from the
/// keyboard (Tab to it, Space or Enter). The body scrolls when the panel is given less height than
/// it needs (a small world with the switches open), so the reset button is never cut off.
pub fn settings_panel(ui: &mut Ui, panel: &SettingsPanel<'_>) -> Vec<PanelChange> {
    let mut changes = Vec::new();
    ui.group(|ui| {
        let height = ui.available_height();
        egui::ScrollArea::vertical().max_height(height).show(ui, |ui| {
            ui.heading(MESSAGE.heading);
            preset_choice(ui, panel, &mut changes);
            scale_slider(ui, panel, &mut changes);
            feature_switches(ui, panel, &mut changes);
            device_line(ui, panel);
            if ui.button(MESSAGE.reset).clicked() {
                changes.push(PanelChange::Reset);
            }
        });
    });
    changes
}

/// The presets as a row of choices (wrapping on a narrow panel), each its own focusable button.
fn preset_choice(ui: &mut Ui, panel: &SettingsPanel<'_>, changes: &mut Vec<PanelChange>) {
    let mut chosen = panel.preset;
    ui.label(MESSAGE.quality);
    ui.horizontal_wrapped(|ui| {
        for (index, label) in panel.presets.iter().enumerate() {
            ui.selectable_value(&mut chosen, index, label.as_str());
        }
    });
    if chosen != panel.preset {
        changes.push(PanelChange::Preset(chosen));
    }
}

fn scale_slider(ui: &mut Ui, panel: &SettingsPanel<'_>, changes: &mut Vec<PanelChange>) {
    let (low, high) = (f64::from(panel.scale_range.0), f64::from(panel.scale_range.1.max(panel.scale_range.0)));
    let before = f64::from(panel.render_scale).clamp(low, high);
    let mut scale = before;
    ui.add(egui::Slider::new(&mut scale, low..=high).step_by(SCALE_STEP).text(MESSAGE.render_scale));
    if scale != before {
        changes.push(PanelChange::RenderScale(scale as f32));
    }
}

/// The switches fold under one header (closed until the person opens it), so the panel stays
/// small on a phone's world.
fn feature_switches(ui: &mut Ui, panel: &SettingsPanel<'_>, changes: &mut Vec<PanelChange>) {
    egui::CollapsingHeader::new(MESSAGE.features).default_open(false).show(ui, |ui| {
        for (index, (label, on)) in panel.features.iter().enumerate() {
            let mut state = *on;
            if ui.checkbox(&mut state, *label).changed() {
                changes.push(PanelChange::Feature(index, state));
            }
        }
    });
}

fn device_line(ui: &mut Ui, panel: &SettingsPanel<'_>) {
    let line = match panel.emulated {
        Some(emulated) => format!("{}: {} ({} {emulated})", MESSAGE.device, panel.detected, MESSAGE.emulated),
        None => format!("{}: {}", MESSAGE.device, panel.detected),
    };
    ui.label(line);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(panel: &SettingsPanel<'_>, input: egui::RawInput) -> (Vec<PanelChange>, egui::FullOutput) {
        let ctx = egui::Context::default();
        let mut changes = Vec::new();
        let mut output = ctx.run_ui(input, |ui| {
            changes = settings_panel(ui, panel);
        });
        // Nothing paints these here (epaint asserts a delta is taken).
        output.textures_delta.clear();
        (changes, output)
    }

    const FEATURES: [(&str, bool); 2] = [("Shadows", true), ("Bloom", false)];

    fn presets() -> Vec<String> {
        ["Auto", "Low", "High"].map(str::to_owned).to_vec()
    }

    fn panel(presets: &[String]) -> SettingsPanel<'_> {
        SettingsPanel {
            presets,
            preset: 0,
            render_scale: 1.0,
            scale_range: (0.5, 1.0),
            features: &FEATURES,
            detected: "desktop-high",
            emulated: None,
        }
    }

    #[test]
    fn an_untouched_panel_changes_nothing() {
        let presets = presets();
        let (changes, output) = run(&panel(&presets), egui::RawInput::default());
        assert!(changes.is_empty(), "{changes:?}");
        assert!(!output.shapes.is_empty(), "the panel draws");
    }

    /// egui's input for one frame of a `size` screen with these key presses.
    fn keys(size: [f32; 2], pressed: &[egui::Key]) -> egui::RawInput {
        let events = pressed
            .iter()
            .map(|key| egui::Event::Key { key: *key, physical_key: None, pressed: true, repeat: false, modifiers: egui::Modifiers::NONE })
            .collect();
        egui::RawInput { screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size.into())), events, ..egui::RawInput::default() }
    }

    /// Pass-1 gate: the quality menu's popup could not be driven from the keyboard, so a person
    /// (or a check) without a mouse could not change the preset in Native Live.
    #[test]
    fn a_quality_preset_is_chosen_from_the_keyboard_with_tab_and_space() {
        let presets = presets();
        let ctx = egui::Context::default();
        let mut chosen = Vec::new();
        // Tab to the first focusable widget, Tab again to the next, then Space on it.
        for pressed in [&[egui::Key::Tab][..], &[egui::Key::Tab], &[egui::Key::Space], &[]] {
            let mut output = ctx.run_ui(keys([640.0, 480.0], pressed), |ui| chosen.extend(settings_panel(ui, &panel(&presets))));
            output.textures_delta.clear();
        }
        assert_eq!(chosen, vec![PanelChange::Preset(1)], "Tab, Tab, Space chooses the second entry");
    }

    /// Pass-1 gate: with Features open the panel ran off the bottom of a small world, cutting the
    /// device line and the reset button. It never grows past the height it is given.
    #[test]
    fn the_panel_never_grows_past_the_height_it_is_given() {
        let presets = presets();
        let ctx = egui::Context::default();
        let mut bottom = 0.0;
        let mut output = ctx.run_ui(keys([640.0, 120.0], &[]), |ui| {
            settings_panel(ui, &panel(&presets));
            bottom = ui.min_rect().max.y;
        });
        output.textures_delta.clear();
        assert!(bottom <= 120.0, "the panel ends at {bottom}, past the 120 px it was given");
    }

    #[test]
    fn a_scale_outside_the_range_is_shown_clamped_and_not_reported_as_a_change() {
        let presets = presets();
        let mut low = panel(&presets);
        low.render_scale = 0.2;
        let (changes, _) = run(&low, egui::RawInput::default());
        assert!(changes.is_empty(), "{changes:?}");
    }
}
