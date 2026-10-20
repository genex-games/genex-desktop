//! UIS-8: what the gameplay UI kit needs from the HUD. Modifiers and extra (navigation) events reach
//! egui, the UI scale keeps a widget's recorded rect and its click hit in agreement, a widget's
//! stable key and focus are recorded, locale fallback fonts render, and the graphics panel's words
//! come from the caller.

use genex_hud::egui::{self, FontId, Modifiers, epaint::TextureId};
use genex_hud::{FontRefusal, Hud, HudInput, HudWidget, LocaleFont, PanelWords, SettingsPanel, raw_input, settings_panel_with_words};
use genex_ui::keyed::Keyed as _;
use genex_ui::nav::{NavButton, NavButtons, nav_events};

const WORLD: [u32; 2] = [320, 180];
const TICK_SECONDS: f64 = 1.0 / 60.0;

/// Three keyed buttons stacked in the top-left corner; answers which were clicked.
fn menu(ui: &mut egui::Ui, clicked: &mut Vec<&'static str>) {
    for (key, label) in [("menu.start", "Start"), ("menu.options", "Options"), ("menu.quit", "Quit")] {
        if ui.button(label).key(ui, key).clicked() {
            clicked.push(key);
        }
    }
}

struct Session {
    hud: Hud,
    tick: u64,
    clicked: Vec<&'static str>,
}

impl Session {
    fn new() -> Session {
        Session { hud: Hud::new(), tick: 0, clicked: Vec::new() }
    }

    fn tick(&mut self, input: &HudInput) {
        let clicked = &mut self.clicked;
        self.hud.run(WORLD, self.tick as f64 * TICK_SECONDS, input, |ui| menu(ui, clicked));
        self.tick += 1;
    }

    fn widget(&self, label: &str) -> HudWidget {
        let found = self.hud.widgets().iter().find(|w| w.label == label).cloned();
        found.unwrap_or_else(|| panic!("no widget {label:?} in {:?}", self.hud.widgets()))
    }

    fn focused(&self) -> Vec<String> {
        self.hud.widgets().iter().filter(|w| w.focused).map(|w| w.label.clone()).collect()
    }

    fn keys(&mut self, keys: &[&str], modifiers: Modifiers) {
        let pressed_keys = keys.iter().map(|key| (*key).to_owned()).collect();
        self.tick(&HudInput { pressed_keys, modifiers, ..HudInput::default() });
    }
}

#[test]
fn the_new_fields_default_to_todays_behaviour() {
    let input = HudInput::default();
    assert_eq!(input.modifiers, Modifiers::NONE);
    assert!(input.extra_events.is_empty());
    assert_eq!(input.ui_scale, 1.0);
    let raw = raw_input(WORLD, 0.5, &input);
    assert_eq!(raw.screen_rect.map(|r| (r.width(), r.height())), Some((320.0, 180.0)), "one point per world pixel");
    assert!(raw.viewports.values().all(|viewport| viewport.native_pixels_per_point.is_none()), "no scale is announced");
}

/// Characterization flip: `raw_input` sent `Modifiers::NONE` for Shift+Tab, so focus could only
/// move forwards. Shift now passes through and Shift+Tab walks back.
#[test]
fn shift_tab_passes_shift_through_and_walks_focus_back() {
    let raw = raw_input(WORLD, 0.0, &HudInput { pressed_keys: vec!["Tab".to_owned()], modifiers: Modifiers::SHIFT, ..HudInput::default() });
    let shifted = raw.events.iter().any(|event| matches!(event, egui::Event::Key { key: egui::Key::Tab, modifiers, .. } if modifiers.shift));
    assert!(shifted, "{:?}", raw.events);

    let mut session = Session::new();
    session.tick(&HudInput::default());
    session.keys(&["Tab"], Modifiers::NONE);
    session.keys(&["Tab"], Modifiers::NONE);
    session.tick(&HudInput::default());
    assert_eq!(session.focused(), ["Options"]);
    session.keys(&["Tab"], Modifiers::SHIFT);
    session.tick(&HudInput::default());
    assert_eq!(session.focused(), ["Start"], "Shift+Tab moves focus back");
}

#[test]
fn a_widget_records_its_stable_key_and_whether_it_has_focus() {
    let mut session = Session::new();
    session.tick(&HudInput::default());
    let start = session.widget("Start");
    assert_eq!(start.key.as_deref(), Some("menu.start"), "the key comes from the AccessKit author_id");
    assert!(!start.focused, "nothing has focus yet");
    session.keys(&["Tab"], Modifiers::NONE);
    session.tick(&HudInput::default());
    assert!(session.widget("Start").focused, "TreeUpdate.focus names the focused widget");
    assert!(!session.widget("Options").focused);
    assert_eq!(session.widget("Quit").key.as_deref(), Some("menu.quit"));
}

#[test]
fn extra_events_reach_egui_after_the_tick_input() {
    let mut session = Session::new();
    session.tick(&HudInput::default());
    let next = nav_events(NavButtons::NONE.with(NavButton::Next, true));
    session.tick(&HudInput { extra_events: next.clone(), ..HudInput::default() });
    session.tick(&HudInput { extra_events: next, ..HudInput::default() });
    session.tick(&HudInput::default());
    assert_eq!(session.focused(), ["Options"], "two navigation Next presses move focus twice");
    let accept = nav_events(NavButtons::NONE.with(NavButton::Accept, true));
    session.tick(&HudInput { extra_events: accept, ..HudInput::default() });
    assert_eq!(session.clicked, ["menu.options"], "Accept activates the focused button");
}

/// Red row: at `ui_scale` 2.0 the widget is twice as large in world pixels, and a click aimed at
/// its recorded rect's centre lands on it (a zoom of the paint alone moves the hit away).
#[test]
fn at_ui_scale_two_a_buttons_world_rect_and_its_click_hit_agree() {
    let mut plain = Session::new();
    plain.tick(&HudInput::default());
    let one = plain.widget("Options").rect;

    let scaled_input = |input: HudInput| HudInput { ui_scale: 2.0, ..input };
    let mut session = Session::new();
    session.tick(&scaled_input(HudInput::default()));
    let two = session.widget("Options").rect;
    for (scaled, plain) in two.iter().zip(one) {
        assert!((scaled - plain * 2.0).abs() < 0.01, "the rect doubles: {two:?} against {one:?}");
    }
    let pointer = session.widget("Options").center_fraction(WORLD);
    session.tick(&scaled_input(HudInput { pointer, primary_pressed: true, primary_released: true, ..HudInput::default() }));
    assert_eq!(session.clicked, ["menu.options"], "the click aimed at the recorded rect hits the button");

    let paint = session.hud.paint(1.5);
    assert_eq!(paint.pixels_per_point, 3.0, "the display ratio times the UI scale");
}

#[test]
fn hostile_ui_scales_read_as_one_or_the_bound() {
    for (scale, points) in [(f32::NAN, 320.0), (f32::INFINITY, 320.0), (0.0, 320.0), (-2.0, 320.0), (0.1, 640.0), (9.0, 320.0 / 3.0)] {
        let raw = raw_input(WORLD, 0.0, &HudInput { ui_scale: scale, ..HudInput::default() });
        let width = raw.screen_rect.map(|r| r.width()).unwrap_or_default();
        assert!((width - points).abs() < 0.01, "{scale}: {width} points wide, wanted {points}");
    }
}

/// NotoEmoji (OFL, in egui's font crate) stands in for a locale font: Ubuntu Light and Hack have no
/// glyph for it, so without the locale font egui draws its replacement box.
const LOCALE_TEXT: &str = "\u{1F600}";

fn noto() -> LocaleFont {
    LocaleFont::new("noto-emoji", epaint_default_fonts::NOTO_EMOJI_REGULAR)
}

fn has_locale_glyphs(hud: &Hud) -> bool {
    hud.context().fonts_mut(|fonts| fonts.has_glyphs(&FontId::proportional(14.0), LOCALE_TEXT))
}

#[test]
fn a_locale_font_added_at_seed_renders_without_boxes_and_its_atlas_lands_the_same_tick() {
    let mut hud = Hud::new();
    let label = |ui: &mut egui::Ui| {
        ui.label(LOCALE_TEXT);
    };
    hud.run(WORLD, 0.0, &HudInput::default(), label);
    assert!(!has_locale_glyphs(&hud), "the HUD's text fonts lack the glyph");
    drop(hud.paint(1.0));

    hud.set_locale_fonts(&[noto()]).expect("a valid font");
    hud.reset();
    hud.run(WORLD, 0.0, &HudInput::default(), label);
    assert!(has_locale_glyphs(&hud), "the locale font is a fallback after a seed");
    let mut paint = hud.paint(1.0);
    let delta = std::mem::take(&mut paint.textures_delta);
    assert!(delta.set.iter().any(|(id, _)| *id == TextureId::default()), "the font atlas uploads on the tick that drew it");
    let mut delta = delta;
    delta.clear();
}

#[test]
fn hostile_locale_fonts_are_refused_and_change_nothing() {
    let mut hud = Hud::new();
    let garbage = LocaleFont::new("garbage", &b"not a font at all, just some bytes"[..]);
    let truncated = LocaleFont::new("truncated", &epaint_default_fonts::NOTO_EMOJI_REGULAR[..20]);
    let shadow = LocaleFont::new("Ubuntu-Light", epaint_default_fonts::NOTO_EMOJI_REGULAR);
    let rows = [
        (vec![garbage], FontRefusal::Invalid),
        (vec![truncated], FontRefusal::Invalid),
        (vec![LocaleFont::new("", epaint_default_fonts::NOTO_EMOJI_REGULAR)], FontRefusal::BadName),
        (vec![shadow], FontRefusal::BadName),
        (vec![noto(), noto()], FontRefusal::BadName),
        ((0..9).map(|n| LocaleFont::new(&format!("font-{n}"), epaint_default_fonts::NOTO_EMOJI_REGULAR)).collect(), FontRefusal::TooMany),
    ];
    for (fonts, refusal) in rows {
        assert_eq!(hud.set_locale_fonts(&fonts), Err(refusal), "{:?}", fonts.iter().map(|f| f.name.clone()).collect::<Vec<_>>());
    }
    hud.run(WORLD, 0.0, &HudInput::default(), |ui| {
        ui.label("still drawn");
    });
    assert!(!has_locale_glyphs(&hud), "no refused font was installed");
}

fn panel(presets: &[String]) -> SettingsPanel<'_> {
    SettingsPanel {
        presets,
        preset: 0,
        render_scale: 1.0,
        scale_range: (0.5, 1.0),
        features: &[("Shadows", true)],
        detected: "desktop-high",
        emulated: Some("phone"),
    }
}

#[test]
fn the_settings_panel_words_come_from_the_caller_and_english_stays_byte_identical() {
    let english = PanelWords::ENGLISH;
    assert_eq!(
        [english.heading, english.quality, english.render_scale, english.features, english.device, english.emulated, english.reset],
        ["Graphics", "Quality", "Render scale", "Features", "Device", "emulating", "Reset graphics settings"],
    );
    let german = PanelWords {
        heading: "Grafik",
        quality: "Qualität",
        render_scale: "Renderskalierung",
        features: "Funktionen",
        device: "Gerät",
        emulated: "emuliert",
        reset: "Grafik zurücksetzen",
    };
    let presets = vec!["Auto".to_owned()];
    let mut hud = Hud::new();
    hud.run(WORLD, 0.0, &HudInput::default(), |ui| {
        settings_panel_with_words(ui, &panel(&presets), &german);
    });
    let labels: Vec<&str> = hud.widgets().iter().map(|w| w.label.as_str()).collect();
    for word in ["Grafik", "Qualität", "Funktionen", "Gerät: desktop-high (emuliert phone)", "Grafik zurücksetzen"] {
        assert!(labels.contains(&word), "{word:?} not in {labels:?}");
    }
    assert!(!labels.contains(&"Graphics"), "no English word is left: {labels:?}");

    let mut english_hud = Hud::new();
    english_hud.run(WORLD, 0.0, &HudInput::default(), |ui| {
        genex_hud::settings_panel(ui, &panel(&presets));
    });
    let english_labels: Vec<&str> = english_hud.widgets().iter().map(|w| w.label.as_str()).collect();
    assert!(english_labels.contains(&"Device: desktop-high (emulating phone)"), "{english_labels:?}");
}

