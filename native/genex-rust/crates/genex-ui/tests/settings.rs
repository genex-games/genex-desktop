//! UIS-7 rows: the settings model (typed options, presets, the `genex-settings.json` store with its
//! caps and hostile table), the tabbed menu shell with custom tabs walked by pad alone, and UI
//! scale resolution. Every row is new behaviour: before UIS-7 the settings modules were stubs.

use egui::accesskit::{NodeId, TreeUpdate};
use egui::{FontData, FontDefinitions, FontFamily, Pos2};
use genex_ui::keyed::Keyed;
use genex_ui::nav::{NavButton, NavButtons, nav_events};
use genex_ui::settings::menu::{MenuAnswer, SettingsMenu, english};
use genex_ui::settings::scale::{AUTO_PHONE_SCALE, OutputClass, UI_SCALE_CHOICES, UI_SCALE_MAX, UiScale};
use genex_ui::settings::schema::{SETTINGS_OPTIONS_MAX, SettingDef, SettingValue, SettingsErrorCode, SettingsSchema, SettingsTab};
use genex_ui::settings::store::{SETTINGS_BYTES_MAX, SETTINGS_KEYS_MAX, SettingsStore};
use std::num::NonZeroUsize;
use std::sync::Arc;

/// A schema like a game's: the audio buses arrive as data (no genex-audio), an accessibility
/// block, and the game's own options.
fn schema() -> SettingsSchema {
    let bus = |key: &str, label: &str| SettingDef::slider(key, label, 0.0, 1.0, 0.1, 0.8);
    SettingsSchema::new()
        .option(SettingsTab::Audio, bus("audio.master", "settings-audio-master"))
        .option(SettingsTab::Audio, bus("audio.music", "settings-audio-music"))
        .option(SettingsTab::Audio, bus("audio.sfx", "settings-audio-sfx"))
        .preset(
            SettingsTab::Audio,
            "quiet",
            &[("audio.master", SettingValue::Number(0.4)), ("audio.music", SettingValue::Number(0.2))],
        )
        .preset(SettingsTab::Audio, "dialogue", &[("audio.music", SettingValue::Number(0.3)), ("audio.sfx", SettingValue::Number(0.5))])
        .option(SettingsTab::Accessibility, SettingDef::toggle("ui.subtitles", "settings-subtitles", false))
        .option(SettingsTab::Accessibility, SettingDef::choice("ui.scale", "settings-ui-scale", &["auto", "small", "large"], 0))
        .option(SettingsTab::Game, SettingDef::choice("difficulty_hint", "settings-hints", &["off", "some", "all"], 1))
        .option(SettingsTab::Game, SettingDef::toggle("camera.shake", "settings-shake", true))
}

fn store() -> SettingsStore {
    SettingsStore::new(schema()).expect("the schema validates")
}

fn defaults() -> Vec<(String, Option<SettingValue>)> {
    snapshot(&store())
}

fn snapshot(store: &SettingsStore) -> Vec<(String, Option<SettingValue>)> {
    store.schema().options().map(|(_, def)| (def.key().to_owned(), store.value(def.key()))).collect()
}

#[test]
fn a_hostile_settings_file_refuses_settings_invalid_keeps_the_defaults_and_writes_nothing() {
    let big = format!("{{\"format\":1,\"presets\":{{}},\"values\":{{\"camera.shake\":true}}, \"pad\":\"{}\"}}", "x".repeat(10 * 1024 * 1024));
    let mut many = String::from("{\"format\":1,\"presets\":{},\"values\":{");
    for index in 0..300 {
        many.push_str(&format!("{}\"k{index}\":true", if index == 0 { "" } else { "," }));
    }
    many.push_str("}}");
    let deep = format!("{{\"format\":1,\"presets\":{{}},\"values\":{}1{}}}", "[".repeat(40), "]".repeat(40));
    let rows: Vec<(&str, Vec<u8>)> = vec![
        ("10 MB", big.into_bytes()),
        ("300 keys", many.into_bytes()),
        ("format 2", br#"{"format":2,"presets":{},"values":{}}"#.to_vec()),
        ("format as a string", br#"{"format":"1","presets":{},"values":{}}"#.to_vec()),
        ("unknown top-level key", br#"{"format":1,"presets":{},"values":{},"cheats":true}"#.to_vec()),
        ("missing values", br#"{"format":1,"presets":{}}"#.to_vec()),
        ("not JSON", b"format=1".to_vec()),
        ("not an object", b"[1,2,3]".to_vec()),
        ("trailing bytes", br#"{"format":1,"presets":{},"values":{}} x"#.to_vec()),
        ("a repeated key", br#"{"format":1,"presets":{},"values":{"camera.shake":true,"camera.shake":false}}"#.to_vec()),
        ("too deep", deep.into_bytes()),
        ("a bool slider", br#"{"format":1,"presets":{},"values":{"audio.music":true}}"#.to_vec()),
        ("a number toggle", br#"{"format":1,"presets":{},"values":{"camera.shake":1}}"#.to_vec()),
        ("a slider out of range", br#"{"format":1,"presets":{},"values":{"audio.music":7.5}}"#.to_vec()),
        ("an unknown choice", br#"{"format":1,"presets":{},"values":{"difficulty_hint":"cheat"}}"#.to_vec()),
        ("a choice by index", br#"{"format":1,"presets":{},"values":{"difficulty_hint":2}}"#.to_vec()),
        ("presets not an object", br#"{"format":1,"presets":["quiet"],"values":{}}"#.to_vec()),
        ("a preset for an unknown tab", br#"{"format":1,"presets":{"cheats":"quiet"},"values":{}}"#.to_vec()),
        ("a preset name not a string", br#"{"format":1,"presets":{"audio":3},"values":{}}"#.to_vec()),
        ("a lone surrogate", br#"{"format":1,"presets":{},"values":{"\ud800":true}}"#.to_vec()),
        ("invalid UTF-8", b"{\"format\":1,\"presets\":{},\"values\":{\"\xff\":true}}".to_vec()),
    ];
    for (name, bytes) in rows {
        let mut store = store();
        let refused = store.load(&bytes).expect_err(name);
        assert_eq!(refused.code(), SettingsErrorCode::Invalid, "{name}: {}", refused.detail());
        assert_eq!(snapshot(&store), defaults(), "{name}: the defaults are kept");
        assert_eq!(store.take_write(), None, "{name}: nothing is written");
    }
    // A hostile file after the person changed something leaves that change, all or nothing.
    let mut changed = store();
    changed.set("camera.shake", SettingValue::Bool(false)).expect("a legal change");
    let before = snapshot(&changed);
    assert!(changed.load(br#"{"format":2}"#).is_err());
    assert_eq!(snapshot(&changed), before);
    assert_eq!(SETTINGS_BYTES_MAX, 64 * 1024);
    assert_eq!(SETTINGS_KEYS_MAX, 256);
}

#[test]
fn a_preset_then_an_override_persists_the_preset_plus_a_delta_and_reset_returns_to_defaults() {
    let mut store = store();
    store.choose_preset(SettingsTab::Audio, "quiet").expect("a declared preset");
    assert_eq!(store.value("audio.master"), Some(SettingValue::Number(0.4)));
    assert_eq!(store.value("audio.music"), Some(SettingValue::Number(0.2)));
    assert_eq!(store.value("audio.sfx"), Some(SettingValue::Number(0.8)), "a key the preset leaves keeps its default");
    store.set("audio.music", SettingValue::Number(0.6)).expect("in range");
    store.set("difficulty_hint", SettingValue::Choice(2)).expect("a declared option");
    let written = store.take_write().expect("a change writes");
    assert_eq!(
        String::from_utf8(written.clone()).expect("UTF-8"),
        r#"{"format":1,"presets":{"audio":"quiet"},"values":{"audio.music":0.6,"difficulty_hint":"all"}}"#,
        "the preset and only the delta"
    );
    assert_eq!(store.take_write(), None, "written once");
    let mut reloaded = SettingsStore::new(schema()).expect("schema");
    assert_eq!(reloaded.load(&written), Ok(Vec::new()));
    assert_eq!(snapshot(&reloaded), snapshot(&store), "the file reads back to the same values");
    assert_eq!(reloaded.preset(SettingsTab::Audio), Some("quiet"));
    assert_eq!(reloaded.take_write(), None, "loading writes nothing");
    // Moving an override back onto the preset's value drops it from the delta.
    reloaded.set("audio.music", SettingValue::Number(0.2)).expect("in range");
    let text = String::from_utf8(reloaded.to_bytes()).expect("UTF-8");
    assert_eq!(text, r#"{"format":1,"presets":{"audio":"quiet"},"values":{"difficulty_hint":"all"}}"#);
    // Choosing a preset again clears that tab's overrides, never another tab's.
    store.choose_preset(SettingsTab::Audio, "dialogue").expect("declared");
    assert_eq!(store.value("audio.music"), Some(SettingValue::Number(0.3)));
    assert_eq!(store.value("difficulty_hint"), Some(SettingValue::Choice(2)));
    store.reset();
    assert_eq!(snapshot(&store), defaults(), "reset returns every option to its default");
    assert_eq!(store.preset(SettingsTab::Audio), None);
    assert_eq!(String::from_utf8(store.take_write().expect("reset writes")).expect("UTF-8"), r#"{"format":1,"presets":{},"values":{}}"#);
}

#[test]
fn a_change_is_reported_once_for_routing_and_reset_tab_touches_one_tab() {
    let mut store = store();
    store.set("audio.sfx", SettingValue::Number(0.5)).expect("in range");
    store.set("ui.subtitles", SettingValue::Bool(true)).expect("bool");
    assert_eq!(store.take_changed(), vec!["audio.sfx".to_owned(), "ui.subtitles".to_owned()]);
    assert!(store.take_changed().is_empty());
    store.reset_tab(SettingsTab::Audio);
    assert_eq!(store.value("audio.sfx"), Some(SettingValue::Number(0.8)));
    assert_eq!(store.value("ui.subtitles"), Some(SettingValue::Bool(true)), "another tab keeps its change");
    assert_eq!(store.take_changed(), vec!["audio.sfx".to_owned()]);
}

#[test]
fn a_stale_key_or_preset_applies_the_rest_and_reports_settings_key_unknown() {
    let mut store = store();
    let file = br#"{"format":1,"presets":{"audio":"loud"},"values":{"camera.shake":false,"removed.option":true}}"#;
    let issues = store.load(file).expect("stale rows are not hostile");
    let codes: Vec<(SettingsErrorCode, &str)> = issues.iter().map(|issue| (issue.code(), issue.subject())).collect();
    assert_eq!(codes, vec![(SettingsErrorCode::KeyUnknown, "audio:loud"), (SettingsErrorCode::KeyUnknown, "removed.option")]);
    assert_eq!(store.value("camera.shake"), Some(SettingValue::Bool(false)), "the rest applied");
    assert_eq!(store.preset(SettingsTab::Audio), None);
}

#[test]
fn set_refuses_unknown_keys_and_bad_values_and_snaps_sliders_to_their_step() {
    let mut store = store();
    let before = snapshot(&store);
    let unknown = store.set("audio.voice", SettingValue::Number(0.5)).expect_err("undeclared");
    assert_eq!(unknown.code(), SettingsErrorCode::KeyUnknown);
    let rows = [
        ("audio.music", SettingValue::Bool(true)),
        ("audio.music", SettingValue::Number(f32::NAN)),
        ("audio.music", SettingValue::Number(1.5)),
        ("camera.shake", SettingValue::Number(1.0)),
        ("difficulty_hint", SettingValue::Choice(3)),
    ];
    for (key, value) in rows {
        let refused = store.set(key, value).expect_err(key);
        assert_eq!(refused.code(), SettingsErrorCode::ValueInvalid, "{key} = {value:?}");
    }
    assert_eq!(snapshot(&store), before);
    assert_eq!(store.take_write(), None, "a refused change writes nothing");
    store.set("audio.music", SettingValue::Number(0.33)).expect("in range");
    assert_eq!(store.value("audio.music"), Some(SettingValue::Number(0.3)), "snapped to the 0.1 step");
    assert_eq!(store.choose_preset(SettingsTab::Audio, "loud").map_err(|issue| issue.code()), Err(SettingsErrorCode::KeyUnknown));
    assert!((store.number("audio.music") - 0.3).abs() < 1e-6 && store.flag("camera.shake") && !store.flag("nope"));
}

#[test]
fn slider_steps_land_on_the_decimal_a_person_writes() {
    // Found by the lane's menu capture: 0.8 stepped up read "0.90000004" (f32 step error).
    let def = SettingDef::slider("audio.music", "music", 0.0, 1.0, 0.1, 0.0);
    let mut value = SettingValue::Number(0.0);
    for tenth in 1..=10u8 {
        value = def.stepped(value, 1);
        assert_eq!(value, SettingValue::Number(f32::from(tenth) / 10.0), "{tenth} steps up");
    }
    for tenth in (0..10u8).rev() {
        value = def.stepped(value, -1);
        assert_eq!(value, SettingValue::Number(f32::from(tenth) / 10.0), "back down to {tenth}");
    }
    let fine = SettingDef::slider("ui.text", "text", 0.75, 2.0, 0.05, 1.0);
    assert_eq!(fine.stepped(SettingValue::Number(1.0), 1), SettingValue::Number(1.05));
    assert_eq!(fine.check(SettingValue::Number(1.849_999_9)), Ok(SettingValue::Number(1.85)));
}

#[test]
fn an_invalid_schema_refuses_settings_invalid() {
    let slider = |key: &str| SettingDef::slider(key, "label", 0.0, 1.0, 0.1, 0.5);
    let mut too_many = SettingsSchema::new();
    for index in 0..=SETTINGS_OPTIONS_MAX {
        too_many = too_many.option(SettingsTab::Game, SettingDef::toggle(&format!("opt{index}"), "label", false));
    }
    let rows: Vec<(&str, SettingsSchema)> = vec![
        ("duplicate keys", SettingsSchema::new().option(SettingsTab::Game, slider("speed")).option(SettingsTab::Game, slider("speed"))),
        ("reserved prefix on the game tab", SettingsSchema::new().option(SettingsTab::Game, slider("audio.cheat"))),
        ("a prefix of another tab", SettingsSchema::new().option(SettingsTab::Audio, slider("ui.volume"))),
        ("an unprefixed built-in option", SettingsSchema::new().option(SettingsTab::Audio, slider("volume"))),
        ("a key with capitals", SettingsSchema::new().option(SettingsTab::Game, slider("Speed"))),
        ("an empty key", SettingsSchema::new().option(SettingsTab::Game, slider(""))),
        ("an empty label key", SettingsSchema::new().option(SettingsTab::Game, SettingDef::toggle("shake", "", true))),
        ("min not below max", SettingsSchema::new().option(SettingsTab::Game, SettingDef::slider("speed", "l", 1.0, 1.0, 0.1, 1.0))),
        ("a zero step", SettingsSchema::new().option(SettingsTab::Game, SettingDef::slider("speed", "l", 0.0, 1.0, 0.0, 0.5))),
        ("a NaN bound", SettingsSchema::new().option(SettingsTab::Game, SettingDef::slider("speed", "l", f32::NAN, 1.0, 0.1, 0.5))),
        ("a default out of range", SettingsSchema::new().option(SettingsTab::Game, SettingDef::slider("speed", "l", 0.0, 1.0, 0.1, 2.0))),
        ("a choice with no options", SettingsSchema::new().option(SettingsTab::Game, SettingDef::choice("mode", "l", &[], 0))),
        ("a choice default past its options", SettingsSchema::new().option(SettingsTab::Game, SettingDef::choice("mode", "l", &["a", "b"], 2))),
        ("a repeated choice option", SettingsSchema::new().option(SettingsTab::Game, SettingDef::choice("mode", "l", &["a", "a"], 0))),
        ("a preset of an unknown key", SettingsSchema::new().option(SettingsTab::Game, slider("speed")).preset(SettingsTab::Game, "fast", &[("nope", SettingValue::Number(1.0))])),
        ("a preset of another tab's key", schema().preset(SettingsTab::Game, "odd", &[("audio.music", SettingValue::Number(0.1))])),
        ("a preset with a bad value", schema().preset(SettingsTab::Audio, "odd", &[("audio.music", SettingValue::Bool(true))])),
        ("a repeated preset name", schema().preset(SettingsTab::Audio, "quiet", &[])),
        ("too many options", too_many),
    ];
    for (name, schema) in rows {
        let refused = schema.validate().expect_err(name);
        assert_eq!(refused.code(), SettingsErrorCode::Invalid, "{name}: {}", refused.detail());
        assert!(SettingsStore::new(schema).is_err(), "{name}: no store over an invalid schema");
    }
    assert!(schema().validate().is_ok());
    assert_eq!(SettingsErrorCode::Invalid.wire(), "settings-invalid");
    for code in SettingsErrorCode::ALL {
        assert_eq!(SettingsErrorCode::from_wire(code.wire()), Some(*code));
    }
    for tab in SettingsTab::ALL {
        assert_eq!(SettingsTab::from_wire(tab.wire()), Some(*tab));
    }
}

#[test]
fn ui_scale_auto_is_1_5_on_a_phone_class_output_and_1_0_when_pinned() {
    let phone = OutputClass::of([390.0, 844.0]);
    let desktop = OutputClass::of([1280.0, 720.0]);
    assert_eq!(phone, OutputClass::Phone);
    assert_eq!(desktop, OutputClass::Desktop);
    assert_eq!(OutputClass::of([844.0, 390.0]), OutputClass::Phone, "a phone in landscape is still a phone");
    assert_eq!(UiScale::Auto.resolve(phone, false), AUTO_PHONE_SCALE);
    assert_eq!(AUTO_PHONE_SCALE, 1.5);
    assert_eq!(UiScale::Auto.resolve(phone, true), 1.0, "pinned (a Genex run): Auto is 1.0 on any output");
    assert_eq!(UiScale::Auto.resolve(desktop, false), 1.0);
    assert_eq!(UiScale::Fixed(2.0).resolve(phone, true), 2.0, "a fixed scale is the game's own choice");
    assert_eq!(UiScale::Fixed(9.0).resolve(desktop, false), UI_SCALE_MAX);
    assert_eq!(UiScale::Fixed(0.1).resolve(desktop, false), 0.5);
    assert_eq!(UiScale::Fixed(f32::NAN).resolve(desktop, false), 1.0);
    assert_eq!(UiScale::Fixed(f32::INFINITY).resolve(desktop, false), 1.0);
    assert_eq!(UI_SCALE_CHOICES[0], UiScale::Auto);
    assert_eq!(UiScale::from_choice(1), UI_SCALE_CHOICES[1]);
    assert_eq!(UiScale::from_choice(99), UiScale::Auto);
    assert_eq!(UiScale::default(), UiScale::Auto);
}

// ---- the menu, walked with a pad -------------------------------------------------------------

fn context() -> egui::Context {
    let ctx = egui::Context::default();
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert("text".to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    fonts.families.insert(FontFamily::Proportional, vec!["text".to_owned()]);
    fonts.families.insert(FontFamily::Monospace, vec!["text".to_owned()]);
    ctx.set_fonts(fonts);
    ctx.options_mut(|options| options.max_passes = NonZeroUsize::MIN);
    ctx.enable_accesskit();
    ctx
}

fn raw(tick: u64, events: Vec<egui::Event>) -> egui::RawInput {
    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, egui::vec2(1280.0, 720.0))),
        time: Some(tick as f64 / 60.0),
        predicted_dt: 1.0 / 60.0,
        focused: true,
        events,
        ..egui::RawInput::default()
    }
}

fn press(button: NavButton) -> Vec<egui::Event> {
    nav_events(NavButtons::NONE.with(button, true))
}

fn node_key(update: &TreeUpdate, id: NodeId) -> Option<String> {
    update.nodes.iter().find(|(node_id, _)| *node_id == id).and_then(|(_, node)| node.author_id().map(str::to_owned))
}

fn label_of(update: &TreeUpdate, key: &str) -> Option<String> {
    update
        .nodes
        .iter()
        .find(|(_, node)| node.author_id() == Some(key))
        .map(|(_, node)| node.label().or_else(|| node.value()).unwrap_or_default().to_owned())
}

/// The menu on a pad: a custom Graphics tab (a closure, like genex-render's panel), the schema's
/// Audio, Accessibility and Game tabs.
struct Walk {
    ctx: egui::Context,
    store: SettingsStore,
    tick: u64,
    graphics_clicks: u32,
}

impl Walk {
    fn new() -> Walk {
        Walk { ctx: context(), store: store(), tick: 0, graphics_clicks: 0 }
    }

    /// One tick: the answer, the focused widget's key and the tree.
    fn step(&mut self, events: Vec<egui::Event>) -> (MenuAnswer, Option<String>, TreeUpdate) {
        let mut answer = None;
        let clicks = &mut self.graphics_clicks;
        let store = &mut self.store;
        let mut output = self.ctx.run_ui(raw(self.tick, events), |ui| {
            let menu = SettingsMenu::new("settings")
                .custom_tab(SettingsTab::Graphics, |ui: &mut egui::Ui| {
                    let response = ui.button("Shadows: High").key(ui, "settings.graphics.shadows");
                    let mut scope = genex_ui::focus::FocusScope::new("settings.graphics").hold(true);
                    scope.item(&response);
                    scope.end(ui.ctx());
                    if response.clicked() {
                        *clicks += 1;
                    }
                    response.clicked()
                })
                .schema_tab(SettingsTab::Audio)
                .schema_tab(SettingsTab::Accessibility)
                .schema_tab(SettingsTab::Game);
            answer = Some(menu.show(ui, store, &english));
        });
        output.textures_delta.clear();
        self.tick += 1;
        let update = output.platform_output.accesskit_update.expect("AccessKit is on");
        (answer.expect("the menu ran"), node_key(&update, update.focus), update)
    }

    /// Press a button, then let a quiet tick settle focus; answers the press tick's answer and the
    /// settled focus.
    fn press(&mut self, button: NavButton) -> (MenuAnswer, Option<String>, TreeUpdate) {
        let (answer, _, _) = self.step(press(button));
        let (_, focus, update) = self.step(Vec::new());
        (answer, focus, update)
    }
}

#[test]
fn a_pad_alone_walks_every_tab_and_changes_options() {
    let mut walk = Walk::new();
    walk.step(Vec::new());
    let (answer, focus, update) = walk.step(Vec::new());
    assert_eq!(answer.tab, SettingsTab::Graphics, "the first tab opens");
    assert_eq!(focus.as_deref(), Some("settings.graphics.shadows"), "the custom tab's widget takes focus");
    for tab in ["graphics", "audio", "accessibility", "game"] {
        assert!(label_of(&update, &format!("settings.tab.{tab}")).is_some(), "tab {tab} is keyed");
    }
    assert_eq!(label_of(&update, "settings.tab.audio").as_deref(), Some("Audio"));
    walk.press(NavButton::Accept);
    assert_eq!(walk.graphics_clicks, 1, "A activates the custom tab's widget");

    // RB: the Audio tab, its preset row first, then each bus, then Reset.
    let (_, focus, update) = walk.press(NavButton::Next);
    assert_eq!(focus.as_deref(), Some("settings.audio.preset"));
    assert_eq!(label_of(&update, "settings.audio.preset").as_deref(), Some("Preset: Custom"));
    assert_eq!(label_of(&update, "settings.opt.audio.music").as_deref(), Some("settings-audio-music: 0.8"));
    // Right on the preset row picks the first preset.
    let (answer, _, update) = walk.press(NavButton::Right);
    assert!(answer.changed, "choosing a preset is a change");
    assert_eq!(walk.store.preset(SettingsTab::Audio), Some("quiet"));
    assert_eq!(label_of(&update, "settings.audio.preset").as_deref(), Some("Preset: quiet"));
    let mut seen = Vec::new();
    for _ in 0..4 {
        let (_, focus, _) = walk.press(NavButton::Down);
        seen.push(focus.unwrap_or_default());
    }
    assert_eq!(seen, ["settings.opt.audio.master", "settings.opt.audio.music", "settings.opt.audio.sfx", "settings.audio.reset"]);
    // Up to music, Right steps it by 0.1 over the preset's 0.2.
    walk.press(NavButton::Up);
    walk.press(NavButton::Up);
    let (answer, focus, _) = walk.step(press(NavButton::Right));
    assert!(answer.changed, "a step is a change");
    assert_eq!(focus.as_deref(), Some("settings.opt.audio.music"));
    assert!((walk.store.number("audio.music") - 0.3).abs() < 1e-6);

    // RB: Accessibility; A flips subtitles, Right cycles the scale choice.
    let (_, focus, _) = walk.press(NavButton::Next);
    assert_eq!(focus.as_deref(), Some("settings.opt.ui.subtitles"), "a tab with no presets starts at its first option");
    walk.press(NavButton::Accept);
    assert!(walk.store.flag("ui.subtitles"));
    walk.press(NavButton::Down);
    let (_, _, update) = walk.press(NavButton::Right);
    assert_eq!(walk.store.value("ui.scale"), Some(SettingValue::Choice(1)));
    assert_eq!(label_of(&update, "settings.opt.ui.scale").as_deref(), Some("settings-ui-scale: small"));

    // RB: Game; walk to Reset and press A: only this tab returns to its defaults.
    walk.press(NavButton::Next);
    walk.press(NavButton::Right);
    assert_eq!(walk.store.value("difficulty_hint"), Some(SettingValue::Choice(2)));
    walk.press(NavButton::Up);
    let (_, focus, _) = walk.press(NavButton::Up);
    assert_eq!(focus.as_deref(), Some("settings.opt.camera.shake"));
    let (_, focus, _) = walk.press(NavButton::Down);
    assert_eq!(focus.as_deref(), Some("settings.game.reset"));
    walk.press(NavButton::Accept);
    assert_eq!(walk.store.value("difficulty_hint"), Some(SettingValue::Choice(1)));
    assert!(walk.store.flag("ui.subtitles"), "Reset on Game leaves Accessibility");

    // RB wraps to Graphics, LB goes back to Game; Game remembered its focused row.
    let (answer, focus, _) = walk.press(NavButton::Next);
    assert_eq!(answer.tab, SettingsTab::Graphics, "the press tick already draws the next tab");
    assert_eq!(focus.as_deref(), Some("settings.graphics.shadows"));
    let (_, focus, _) = walk.press(NavButton::Prev);
    assert_eq!(focus.as_deref(), Some("settings.game.reset"));
    // B leaves the menu.
    let (answer, _, _) = walk.press(NavButton::Cancel);
    assert!(answer.back, "B answers back");
    let written = String::from_utf8(walk.store.take_write().expect("the walk changed settings")).expect("UTF-8");
    assert_eq!(written, r#"{"format":1,"presets":{"audio":"quiet"},"values":{"audio.music":0.3,"ui.subtitles":true,"ui.scale":"small"}}"#);
}

#[test]
fn every_menu_row_is_keyed_and_labelled_and_words_come_from_the_caller() {
    let ctx = context();
    let mut store = store();
    let shout = |key: &str| english(key).to_uppercase();
    let mut update = None;
    for tick in 0..2 {
        let mut output = ctx.run_ui(raw(tick, Vec::new()), |ui| {
            SettingsMenu::new("menu").schema_tab(SettingsTab::Audio).show(ui, &mut store, &shout);
        });
        output.textures_delta.clear();
        update = output.platform_output.accesskit_update;
    }
    let update = update.expect("AccessKit is on");
    for key in ["menu.tab.audio", "menu.audio.preset", "menu.opt.audio.master", "menu.opt.audio.music", "menu.opt.audio.sfx", "menu.audio.reset"] {
        let label = label_of(&update, key).unwrap_or_default();
        assert!(!label.is_empty(), "{key} is keyed and labelled");
        assert_eq!(label, label.to_uppercase(), "{key}: words come from the caller's lookup");
    }
    assert!(genex_ui::keyed::ui_issues(&ctx).is_empty(), "no key issue");
}
