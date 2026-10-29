//! The settings menu (`genex::settings`, G6 UIS-11, D19): one tabbed menu a game shows from its
//! `on_ui` hook with [`menu`], over genex-ui's settings schema and store.
//!
//! - **Tabs.** Graphics holds the field of view offset, brightness and motion blur
//!   (`graphics.*`) over [`crate::render::settings_panel`]. Audio holds a master
//!   volume and the five buses (`audio.*`). Controls is INPUT's [`crate::actions::controls_panel`]
//!   (only with `game.input`). Language & Accessibility holds `ui.*`: language (with `game.ui`
//!   locales), UI scale, text size, subtitles, reduced motion, screen shake and head bob. Game holds the
//!   game's own options (`game.settings`). Every tab has presets plus per-option control: the
//!   schema tabs a preset row, Graphics its quality preset, Controls INPUT's reset.
//! - **Routing.** A change applies after the tick's UI hooks, outside the simulation: `audio.*` to
//!   the mixer's person volumes, `ui.*` to the UI scope from the next tick (a Studio `uiSettings`
//!   session layer stays on top), brightness and motion blur to the renderer's live frames, and
//!   a copy to the read hooks (camera, draw, probe). Every hook reads any value with [`value`],
//!   [`number`], [`flag`] and [`comfort`]. Nothing here enters the checksum; anything that changes
//!   play belongs in the world and its save, not in settings.
//! - **Persistence.** The person's settings are `genex-settings.json` in the game's saves (a
//!   preset per tab plus only what the person moved), written after a change. Graphics stays in
//!   `genex-render.json` and bindings in INPUT's file. A hostile file is refused with
//!   `settings-invalid` in `state().volatile.settings.issues`: the defaults apply and the file is
//!   kept until the person changes something.
//! - **Pinned in Genex runs.** A run the studio started never reads the saved file, so judged runs
//!   start from the defaults; changes made during the run still apply.

use std::cell::RefCell;

use genex_audio::{AudioSettings, Bus};
use genex_core::json::Value as CoreValue;
use genex_core::saves::Saves;
use genex_ui::settings::menu::{SettingsMenu, english};
use genex_ui::settings::presets::Preset;
use genex_ui::settings::scale::{UI_SCALE_CHOICE_KEYS, UiScale};
use genex_ui::settings::schema::SettingsSchema;
use genex_ui::settings::store::SettingsStore;

use crate::g6::{G6, G6Setup};
use crate::game::Game;
use crate::runtime::InstallErrorCode;

pub use genex_ui::settings::menu::MenuAnswer;
pub use genex_ui::settings::schema::{SettingDef, SettingKind, SettingValue, SettingsErrorCode, SettingsIssue, SettingsTab};
pub use genex_ui::settings::store::{SETTINGS_BYTES_MAX, SETTINGS_FILE, SETTINGS_KEYS_MAX};

/// `state().volatile.settings`'s key.
pub(crate) const VOLATILE_SETTINGS_KEY: &str = "settings";
/// The menu's key: its widgets are keyed `settings.…` (`settings.opt.audio.music`).
const MENU_KEY: &str = "settings";
/// A bus slider's step (twenty steps from silence to full).
const VOLUME_STEP: f32 = 0.05;
/// The screen-shake slider's step.
const SHAKE_STEP: f32 = 0.1;
/// The field of view offset's range and step, degrees of vertical field of view.
const FOV_OFFSET_RANGE: (f32, f32) = (-10.0, 20.0);
const FOV_OFFSET_STEP: f32 = 1.0;
/// The brightness slider's range and step, stops of exposure (EV) added to the game's look.
const BRIGHTNESS_RANGE: (f32, f32) = (-1.5, 1.5);
const BRIGHTNESS_STEP: f32 = 0.25;
/// The built-in tabs' preset that sets nothing (every option at its default).
const DEFAULT_PRESET: &str = "default";
/// The language choice that follows the device (the OS locale in an export).
const LANGUAGE_AUTO: &str = "auto";
/// The text size choices, by index: the UI hooks' text styles scale by [`TEXT_SIZES`] (R-25).
const TEXT_SIZE_KEYS: [&str; 4] = ["text-size-100", "text-size-125", "text-size-150", "text-size-200"];
/// The text size factor of each [`TEXT_SIZE_KEYS`] choice.
const TEXT_SIZES: [f32; 4] = [1.0, 1.25, 1.5, 2.0];
/// The prefix a game's settings text key usually carries, left out of its English stand-in.
const GAME_KEY_PREFIX: &str = "settings-";

/// The built-in option keys.
mod key {
    pub(super) const MASTER: &str = "audio.master";
    pub(super) const LANGUAGE: &str = "ui.language";
    pub(super) const SCALE: &str = "ui.scale";
    pub(super) const TEXT_SIZE: &str = "ui.text_size";
    pub(super) const SUBTITLES: &str = "ui.subtitles";
    pub(super) const REDUCED_MOTION: &str = "ui.reduced_motion";
    pub(super) const SCREEN_SHAKE: &str = "ui.screen_shake";
    pub(super) const HEAD_BOB: &str = "ui.head_bob";
    pub(super) const FOV_OFFSET: &str = "graphics.fov_offset";
    pub(super) const BRIGHTNESS: &str = "graphics.brightness";
    pub(super) const MOTION_BLUR: &str = "graphics.motion_blur";
}

/// The buses' option keys, with the bus each one drives.
const BUS_KEYS: [(&str, Bus); 5] =
    [("audio.music", Bus::Music), ("audio.sfx", Bus::Sfx), ("audio.ui", Bus::Ui), ("audio.voice", Bus::Voice), ("audio.ambience", Bus::Ambience)];

/// English for the built-in text keys the shell's own table lacks, the fallback when the game's
/// catalog has none.
const ENGLISH: &[(&str, &str)] = &[
    ("settings-audio-master", "Master volume"),
    ("settings-audio-music", "Music"),
    ("settings-audio-sfx", "Effects"),
    ("settings-audio-ui", "Interface"),
    ("settings-audio-voice", "Voices"),
    ("settings-audio-ambience", "Ambience"),
    ("settings-language", "Language"),
    ("settings-ui-scale", "UI scale"),
    ("settings-text-size", "Text size"),
    ("settings-subtitles", "Subtitles"),
    ("settings-reduced-motion", "Reduced motion"),
    ("settings-screen-shake", "Screen shake"),
    ("settings-head-bob", "Head bob"),
    ("settings-fov-offset", "Field of view"),
    ("settings-brightness", "Brightness"),
    ("settings-motion-blur", "Motion blur"),
    ("default", "Default"),
    ("quiet", "Quiet"),
    ("dialogue", "Dialogue"),
    ("comfort", "Comfort"),
    ("auto", "Auto"),
    ("text-size-100", "100%"),
    ("text-size-125", "125%"),
    ("text-size-150", "150%"),
    ("text-size-200", "200%"),
];

/// The game's options and presets for the settings menu: `SettingsConfig::new().option(
/// SettingsTab::Game, SettingDef::toggle("hints", "settings-hints", true))`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettingsConfig {
    options: Vec<(SettingsTab, SettingDef)>,
    presets: Vec<Preset>,
}

impl SettingsConfig {
    /// No options of the game's own.
    pub fn new() -> SettingsConfig {
        SettingsConfig::default()
    }

    /// One of the game's options. Its tab is [`SettingsTab::Game`] (the other tabs' options are the
    /// runtime's), and its key takes no reserved prefix (`audio.`, `ui.`, `input.`, `graphics.`).
    #[must_use]
    pub fn option(mut self, tab: SettingsTab, def: SettingDef) -> SettingsConfig {
        self.options.push((tab, def));
        self
    }

    /// A preset on `tab`: its name (a text key) and the values it sets; any tab's options may be
    /// set, the game's or the runtime's (an Audio preset `"cinematic"`).
    #[must_use]
    pub fn preset(mut self, tab: SettingsTab, name_key: &str, values: &[(&str, SettingValue)]) -> SettingsConfig {
        self.presets.push(Preset::new(tab, name_key, values));
        self
    }
}

impl<W> Game<W> {
    /// Register the game's own settings: options on the menu's Game tab and presets on any tab
    /// (`docs/api/settings.md`). Install refuses a second registration, an option off the Game tab
    /// or with a reserved prefix, and a preset that does not fit (`settings-invalid`).
    pub fn settings(&mut self, config: SettingsConfig) -> &mut Self {
        self.g6.settings.configs.push(config);
        self
    }
}

/// `game.settings`: the game's options and presets.
#[derive(Debug, Default)]
pub(crate) struct Setup {
    configs: Vec<SettingsConfig>,
}

impl Setup {
    fn config(&self) -> Option<&SettingsConfig> {
        self.configs.first()
    }
}

/// `install`'s `game.settings` checks: one registration, the game's options on the Game tab, and
/// a schema genex-ui accepts with the runtime's options (no reserved prefix, fitting presets).
pub(crate) fn check(setup: &G6Setup) -> Result<(), (InstallErrorCode, String)> {
    let refused = |detail: String| (InstallErrorCode::SettingsInvalid, detail);
    if setup.settings.configs.len() > 1 {
        return Err(refused("game.settings is registered once".to_owned()));
    }
    let Some(config) = setup.settings.config() else { return Ok(()) };
    if let Some((tab, def)) = config.options.iter().find(|(tab, _)| *tab != SettingsTab::Game) {
        return Err(refused(format!("game option {} is on the {} tab; the game's options go on the game tab", def.key(), tab.wire())));
    }
    schema(setup).validate().map_err(|issue| refused(issue.to_string()))
}

/// The whole menu's schema: the runtime's options (the Language choice from `game.ui`'s locales),
/// then the game's options and presets.
fn schema(setup: &G6Setup) -> SettingsSchema {
    let schema = audio_options(graphics_options(SettingsSchema::new()));
    let schema = accessibility_options(schema, &crate::ui::offered_tags(&setup.ui));
    let Some(config) = setup.settings.config() else { return schema };
    let mut schema = schema;
    for (tab, def) in &config.options {
        schema = schema.option(*tab, def.clone());
    }
    for preset in &config.presets {
        let values: Vec<(&str, SettingValue)> = preset.values().collect();
        schema = schema.preset(preset.tab(), preset.name(), &values);
    }
    schema
}

/// The Graphics tab's rows above the render panel: the field of view offset a camera rig adds,
/// brightness (stops over the game's exposure) and motion blur (off drops the look's blur). No
/// presets: the render panel's quality preset is the tab's.
fn graphics_options(schema: SettingsSchema) -> SettingsSchema {
    let (fov_min, fov_max) = FOV_OFFSET_RANGE;
    let (dim, bright) = BRIGHTNESS_RANGE;
    schema
        .option(SettingsTab::Graphics, SettingDef::slider(key::FOV_OFFSET, "settings-fov-offset", fov_min, fov_max, FOV_OFFSET_STEP, 0.0))
        .option(SettingsTab::Graphics, SettingDef::slider(key::BRIGHTNESS, "settings-brightness", dim, bright, BRIGHTNESS_STEP, 0.0))
        .option(SettingsTab::Graphics, SettingDef::toggle(key::MOTION_BLUR, "settings-motion-blur", true))
}

/// The Audio tab: a master volume and the five buses, presets `default`, `quiet`, `dialogue`.
fn audio_options(schema: SettingsSchema) -> SettingsSchema {
    let volume = |key: &str| SettingDef::slider(key, &label_of(key), 0.0, 1.0, VOLUME_STEP, 1.0);
    let mut schema = schema.option(SettingsTab::Audio, volume(key::MASTER));
    for (bus, _) in BUS_KEYS {
        schema = schema.option(SettingsTab::Audio, volume(bus));
    }
    let number = SettingValue::Number;
    schema
        .preset(SettingsTab::Audio, DEFAULT_PRESET, &[])
        .preset(SettingsTab::Audio, "quiet", &[(key::MASTER, number(0.6)), ("audio.music", number(0.5)), ("audio.sfx", number(0.7))])
        .preset(SettingsTab::Audio, "dialogue", &[("audio.music", number(0.4)), ("audio.ambience", number(0.5)), ("audio.voice", number(1.0))])
}

/// The Language & Accessibility tab: the language among `locales` (when the game offers any), UI
/// scale, text size, subtitles, reduced motion, screen shake and head bob, presets `default` and
/// `comfort`.
fn accessibility_options(schema: SettingsSchema, locales: &[String]) -> SettingsSchema {
    let mut languages = vec![LANGUAGE_AUTO.to_owned()];
    languages.extend(locales.iter().map(|tag| tag.to_ascii_lowercase()));
    let languages: Vec<&str> = languages.iter().map(String::as_str).collect();
    let mut schema = schema;
    if languages.len() > 1 {
        schema = schema.option(SettingsTab::Accessibility, SettingDef::choice(key::LANGUAGE, "settings-language", &languages, 0));
    }
    let comfort = [
        (key::TEXT_SIZE, SettingValue::Choice(1)),
        (key::REDUCED_MOTION, SettingValue::Bool(true)),
        (key::SCREEN_SHAKE, SettingValue::Number(0.0)),
        (key::HEAD_BOB, SettingValue::Bool(false)),
    ];
    schema
        .option(SettingsTab::Accessibility, SettingDef::choice(key::SCALE, "settings-ui-scale", &UI_SCALE_CHOICE_KEYS, 0))
        .option(SettingsTab::Accessibility, SettingDef::choice(key::TEXT_SIZE, "settings-text-size", &TEXT_SIZE_KEYS, 0))
        .option(SettingsTab::Accessibility, SettingDef::toggle(key::SUBTITLES, "settings-subtitles", true))
        .option(SettingsTab::Accessibility, SettingDef::toggle(key::REDUCED_MOTION, "settings-reduced-motion", false))
        .option(SettingsTab::Accessibility, SettingDef::slider(key::SCREEN_SHAKE, "settings-screen-shake", 0.0, 1.0, SHAKE_STEP, 1.0))
        .option(SettingsTab::Accessibility, SettingDef::toggle(key::HEAD_BOB, "settings-head-bob", true))
        .preset(SettingsTab::Accessibility, DEFAULT_PRESET, &[])
        .preset(SettingsTab::Accessibility, "comfort", &comfort)
}

/// A bus option's label key: `audio.music` is `settings-audio-music`.
fn label_of(key: &str) -> String {
    format!("settings-{}", key.replace('.', "-"))
}

/// The person's settings as the runtime holds them, and the tabs the menu shows.
#[derive(Debug, Default)]
pub(crate) struct State {
    /// The store, None while the menu's hooks hold it (and before the first rebase).
    store: Option<SettingsStore>,
    tabs: Vec<SettingsTab>,
    issues: Vec<SettingsIssue>,
}

impl State {
    /// A new seed keeps the person's settings (they are not simulation state).
    pub(crate) fn reset(&mut self, _setup: &Setup) {}

    /// While alive, [`menu`], [`value`], [`number`] and [`flag`] in this tick's update and UI hooks
    /// reach the store.
    pub(crate) fn enter(&mut self) -> Option<SettingsScope> {
        let store = self.store.take()?;
        let shared = Shared { store, tabs: self.tabs.clone() };
        let previous = SCOPE.with_borrow_mut(|slot| slot.replace(shared));
        Some(SettingsScope { previous })
    }

    /// `state().volatile.settings`: `{issues}`, only while the last read refused or skipped rows.
    pub(crate) fn volatile_key(&self, state: &mut CoreValue) {
        if self.issues.is_empty() {
            return;
        }
        let issues = self.issues.iter().map(|issue| {
            let mut entry = CoreValue::object();
            entry.set("code", CoreValue::from(issue.code().wire()));
            entry.set("subject", CoreValue::from(issue.subject()));
            entry
        });
        let mut settings = CoreValue::object();
        settings.set("issues", CoreValue::Array(issues.collect()));
        let mut volatile = state[genex_core::session::VOLATILE_KEY].clone();
        volatile.set(VOLATILE_SETTINGS_KEY, settings);
        state.set(genex_core::session::VOLATILE_KEY, volatile);
    }
}

impl G6 {
    /// Read the person's settings from `saves` (never in a `pinned` Genex run) over the menu's
    /// schema and route every value: the person volumes and the UI scope's person layer.
    pub(crate) fn settings_rebase(&mut self, setup: &G6Setup, saves: &Saves, pinned: bool) {
        // Install refused a schema that does not validate.
        let Ok(mut store) = SettingsStore::new(schema(setup)) else { return };
        self.settings.issues.clear();
        if !pinned && let Some(bytes) = saves.load(SETTINGS_FILE) {
            match store.load(&bytes) {
                Ok(stale) => self.settings.issues = stale,
                Err(refused) => self.settings.issues = vec![refused],
            }
        }
        show_default_presets(&mut store);
        let _ = store.take_changed();
        self.settings.tabs = tabs(setup, &store);
        self.route(setup, &store, true);
        self.settings.store = Some(store);
    }

    /// After the tick's UI hooks: take the store back, route what changed and save it.
    pub(crate) fn settings_leave(&mut self, setup: &G6Setup, scope: Option<SettingsScope>, saves: &Saves) {
        let Some(scope) = scope else { return };
        let shared = SCOPE.with_borrow_mut(|slot| std::mem::replace(slot, scope.previous));
        let Some(Shared { mut store, .. }) = shared else { return };
        let changed = store.take_changed();
        if !changed.is_empty() {
            let ui_changed = changed.iter().any(|key| key.starts_with("ui."));
            self.route(setup, &store, ui_changed);
        }
        if let Some(bytes) = store.take_write() {
            saves.save(SETTINGS_FILE, &bytes);
        }
        self.settings.store = Some(store);
    }

    /// Hand the store's values to their owners: the audio buses always, the UI person layer when
    /// `ui` (it renegotiates the locale).
    fn route(&mut self, setup: &G6Setup, store: &SettingsStore, ui: bool) {
        let mut audio = AudioSettings { master: store.number(key::MASTER), ..self.audio.settings() };
        for (key, bus) in BUS_KEYS {
            audio = audio.with_bus(bus, store.number(key));
        }
        if audio != self.audio.settings() {
            self.audio.set_settings(audio);
        }
        if ui {
            self.ui.set_person(&setup.ui, person_layer(store));
        }
        READ.with_borrow_mut(|slot| *slot = Some(store.clone()));
    }
}

/// A tab still at its defaults with no preset chosen shows its `default` preset, not Custom; this
/// changes no value and writes nothing.
fn show_default_presets(store: &mut SettingsStore) {
    let at_defaults = |store: &SettingsStore, tab: SettingsTab| {
        store.preset(tab).is_none() && store.schema().tab_options(tab).all(|def| store.value(def.key()) == Some(def.default_value()))
    };
    let mut chose = false;
    for tab in [SettingsTab::Audio, SettingsTab::Accessibility] {
        if at_defaults(store, tab) {
            chose |= store.choose_preset(tab, DEFAULT_PRESET).is_ok();
        }
    }
    if chose {
        let _ = store.take_write();
    }
}

/// The UI scope's person layer from the store.
fn person_layer(store: &SettingsStore) -> crate::ui::PersonLayer {
    let options = store.schema().def(key::LANGUAGE).map(SettingDef::kind);
    let locale = match (options, store.value(key::LANGUAGE)) {
        (Some(SettingKind::Choice { options }), Some(SettingValue::Choice(index))) => {
            options.get(usize::from(index)).filter(|tag| *tag != LANGUAGE_AUTO).cloned()
        }
        _ => None,
    };
    let scale = match store.value(key::SCALE) {
        Some(SettingValue::Choice(index)) => UiScale::from_choice(index),
        _ => UiScale::Auto,
    };
    let text_size = match store.value(key::TEXT_SIZE) {
        Some(SettingValue::Choice(index)) => TEXT_SIZES.get(usize::from(index)).copied(),
        _ => None,
    };
    crate::ui::PersonLayer {
        locale,
        scale: (scale != UiScale::Auto).then_some(scale),
        reduced_motion: store.flag(key::REDUCED_MOTION),
        text_size,
    }
}

/// The tabs the menu shows, in menu order: Audio only in a build with sound (`[audio] enabled =
/// false` has no mixer to set, R-25), Controls only with `game.input`, Game only with the game's
/// options or presets there.
fn tabs(setup: &G6Setup, store: &SettingsStore) -> Vec<SettingsTab> {
    let schema = store.schema();
    let game_tab = schema.tab_options(SettingsTab::Game).next().is_some() || schema.presets(SettingsTab::Game).next().is_some();
    let shown = |tab: &SettingsTab| match tab {
        SettingsTab::Audio => cfg!(feature = "audio"),
        SettingsTab::Controls => setup.input.map().is_some(),
        SettingsTab::Game => game_tab,
        _ => true,
    };
    SettingsTab::ALL.iter().copied().filter(shown).collect()
}

/// What the hooks of one tick reach through [`menu`] and its siblings.
struct Shared {
    store: SettingsStore,
    tabs: Vec<SettingsTab>,
}

thread_local! {
    static SCOPE: RefCell<Option<Shared>> = const { RefCell::new(None) };
    /// The person's settings as last routed, for the read hooks (a camera hook, a draw hook):
    /// display only, never the simulation's.
    static READ: RefCell<Option<SettingsStore>> = const { RefCell::new(None) };
}

/// The settings scope of one tick (`State::enter` / `G6::settings_leave`).
pub(crate) struct SettingsScope {
    previous: Option<Shared>,
}

/// A text key in the game's catalog. The runtime's own words fall back to their English with no
/// issue (the facade's table, then the shell's); a game's key it lacks records `text-missing` and
/// reads as its words (`settings-hints` as "Hints", R-25), never as the raw key.
fn words(key: &str) -> String {
    let built_in = ENGLISH.iter().find(|(own, _)| *own == key).map(|(_, word)| (*word).to_owned());
    let shell = english(key);
    match built_in {
        Some(word) => crate::ui::tr_or(key, |_| word),
        None if shell != key => crate::ui::tr_or(key, |_| shell),
        None => {
            let text = crate::ui::tr(key);
            if text == key { key_words(key) } else { text }
        }
    }
}

/// A game's text key as words: `settings-hint_level` reads "Hint level" (the prefix left out,
/// dashes, underscores and dots as spaces, the first letter capital).
fn key_words(key: &str) -> String {
    let bare = key.strip_prefix(GAME_KEY_PREFIX).filter(|rest| !rest.is_empty()).unwrap_or(key);
    let spaced: String = bare.chars().map(|c| if matches!(c, '-' | '_' | '.') { ' ' } else { c }).collect();
    let mut chars = spaced.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => key.to_owned(),
    }
}

/// The settings menu in a UI hook: the tab row (RB and LB, or Tab and Shift+Tab, switch tabs) over
/// the open tab. A change applies after the tick's UI hooks, outside the simulation, and is saved.
/// Answers whether something changed on this pass (false outside a UI hook).
///
/// ```
/// # use genex::prelude::*;
/// # #[derive(Default)] struct World { menu: bool }
/// # let mut game = Game::new(World::default());
/// game.on_ui(|sim, ui, _| {
///     if sim.world.menu {
///         genex::settings::menu(ui);
///     }
/// });
/// ```
pub fn menu(ui: &mut egui::Ui) -> bool {
    menu_answer(ui).changed
}

/// The settings menu, answering the tab drawn, whether something changed and whether the player
/// backed out (B or Escape), so a pause menu can close it.
pub fn menu_answer(ui: &mut egui::Ui) -> MenuAnswer {
    let shown = SCOPE.with_borrow_mut(|slot| {
        let shared = slot.as_mut()?;
        let mut menu = SettingsMenu::new(MENU_KEY);
        for tab in &shared.tabs {
            menu = match tab {
                SettingsTab::Graphics => menu.schema_and_custom_tab(SettingsTab::Graphics, crate::render::settings_panel),
                SettingsTab::Controls => menu.custom_tab(SettingsTab::Controls, |ui| {
                    crate::actions::controls_panel(ui);
                    // INPUT applies and saves its own changes after the UI hooks.
                    false
                }),
                other => menu.schema_tab(*other),
            };
        }
        Some(menu.show(ui, &mut shared.store, &words))
    });
    shown.unwrap_or(MenuAnswer { tab: SettingsTab::Game, changed: false, back: false })
}

/// The option `key`'s value in any hook: the person's change, else the tab's preset, else the
/// default. The update and UI hooks see a change made in this tick's menu; the read hooks (camera,
/// draw, probe) see the settings as routed after the last tick's UI hooks. None before the game
/// runs and for an unknown key. Display only: copying a value into the world makes the
/// simulation depend on the person, so a value that changes play belongs in the world's save.
pub fn value(key: &str) -> Option<SettingValue> {
    // While the menu is being drawn it holds the scope mutably, and a read from inside it (the
    // renderer asking for the picture settings) takes the routed copy instead of panicking.
    SCOPE
        .with(|slot| slot.try_borrow().ok().and_then(|slot| slot.as_ref().map(|shared| shared.store.value(key))))
        .unwrap_or_else(|| READ.with_borrow(|slot| slot.as_ref().and_then(|store| store.value(key))))
}

/// The comfort settings a camera rig obeys (`ui.head_bob`, `ui.screen_shake`,
/// `ui.reduced_motion`, `graphics.fov_offset`), readable in any hook; [`Comfort::FULL`] before
/// the game runs.
///
/// [`Comfort::FULL`]: crate::camera::Comfort::FULL
pub fn comfort() -> crate::camera::Comfort {
    let full = crate::camera::Comfort::FULL;
    let number = |key: &str, default: f32| match value(key) {
        Some(SettingValue::Number(number)) => number,
        _ => default,
    };
    let toggle = |key: &str, default: bool| match value(key) {
        Some(SettingValue::Bool(on)) => on,
        _ => default,
    };
    crate::camera::Comfort {
        head_bob: if toggle(key::HEAD_BOB, true) { 1.0 } else { 0.0 },
        screen_shake: number(key::SCREEN_SHAKE, full.screen_shake),
        reduced_motion: toggle(key::REDUCED_MOTION, full.reduced_motion),
        fov_offset: number(key::FOV_OFFSET, full.fov_offset),
    }
}

/// The person's picture settings the renderer applies to the game's look on live frames
/// (captures keep the look as the game made it): stops of brightness, and whether motion blur
/// may show.
pub(crate) fn picture() -> (f32, bool) {
    let brightness = match value(key::BRIGHTNESS) {
        Some(SettingValue::Number(stops)) => stops,
        _ => 0.0,
    };
    (brightness, !matches!(value(key::MOTION_BLUR), Some(SettingValue::Bool(false))))
}

/// A slider's value in any hook (0 for anything else, and before the game runs).
pub fn number(key: &str) -> f32 {
    match value(key) {
        Some(SettingValue::Number(number)) => number,
        _ => 0.0,
    }
}

/// A toggle's value in any hook (false for anything else, and before the game runs).
pub fn flag(key: &str) -> bool {
    matches!(value(key), Some(SettingValue::Bool(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_schema_validates_and_every_label_has_english() {
        let schema = schema(&G6Setup::default());
        schema.validate().expect("the runtime's own schema validates");
        assert!(schema.def(key::LANGUAGE).is_none(), "no language choice without game.ui locales");
        for (_, def) in schema.options() {
            assert_ne!(words(def.label_key()), def.label_key(), "{} has an English label", def.key());
        }
        let with_locales = accessibility_options(SettingsSchema::new(), &["en".to_owned(), "fr-CA".to_owned()]);
        let Some(SettingKind::Choice { options }) = with_locales.def(key::LANGUAGE).map(SettingDef::kind) else { panic!("a language choice") };
        assert_eq!(options, &["auto", "en", "fr-ca"], "locale tags become legal option keys");
    }

    /// R-25: a game's option whose text the catalog lacks read as its raw key (`settings-hints: 1`).
    #[test]
    fn a_game_key_without_text_reads_as_words_never_as_the_raw_key() {
        let rows = [("settings-hints", "Hints"), ("settings-hint_level", "Hint level"), ("veteran", "Veteran"), ("settings-", "Settings")];
        for (key, shown) in rows {
            assert_eq!(words(key), shown, "{key}");
        }
    }

    /// R-25: the text size was recorded but never applied; each choice reaches the person layer.
    #[test]
    fn every_text_size_choice_reaches_the_person_layer() {
        let mut store = SettingsStore::new(schema(&G6Setup::default())).expect("the runtime schema");
        assert_eq!(person_layer(&store).text_size, Some(1.0), "the default choice is 100%");
        for (index, size) in TEXT_SIZES.iter().enumerate() {
            store.set(key::TEXT_SIZE, SettingValue::Choice(u16::try_from(index).expect("a choice index"))).expect("a legal choice");
            assert_eq!(person_layer(&store).text_size, Some(*size), "choice {index}");
        }
    }

    /// R-25: a build with `[audio] enabled = false` has no mixer, so no Audio tab.
    #[test]
    fn the_audio_tab_shows_only_in_a_build_with_sound() {
        let setup = G6Setup::default();
        let store = SettingsStore::new(schema(&setup)).expect("the runtime schema");
        assert_eq!(tabs(&setup, &store).contains(&SettingsTab::Audio), cfg!(feature = "audio"));
    }
}
