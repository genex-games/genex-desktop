//! The settings menu shell (G6 gameplay UI, UIS-7, D19): a row of tabs over one tab's body. A
//! schema tab draws its preset row, one row per option and a Reset row from the store; a custom
//! tab is a closure the caller draws (genex-render's Graphics panel, INPUT's Controls panel), so
//! this crate depends on neither, and the audio buses arrive as schema data.
//!
//! A pad walks it alone: RB and LB (Tab and Shift+Tab) switch tabs and wrap, up and down move
//! along the rows, left and right change the focused row (a toggle flips, a slider steps, a
//! choice or the preset row cycles), A activates (flip, step forward, Reset) and B answers back.
//! A pointer taps a row: the left half steps back, the right half forward. Each tab remembers its
//! focused row; the open tab is kept per menu key in egui memory, which the HUD forgets on seed.
//!
//! Words come from the caller's text lookup (the game's Fluent catalog); [`english`] is the
//! fallback for the shell's own keys.

use egui::{FocusDirection, Id, Response};

use crate::focus::FocusScope;
use crate::keyed::Keyed;
use crate::nav::{NavButton, pressed};
use crate::settings::schema::{SettingDef, SettingKind, SettingValue, SettingsTab};
use crate::settings::store::SettingsStore;

/// The smallest row, in world pixels (a large tap target).
pub const SETTINGS_ROW_MIN: egui::Vec2 = egui::vec2(320.0, 40.0);
/// Where a menu keeps its open tab.
const OPEN_TAB_SALT: &str = "genex-ui.settings-tab";
/// The egui memory a pass's pointer check keeps ([`pointer_moved`]).
const POINTER_SALT: &str = "genex-ui.settings-pointer";
/// Pixels the pointer must travel between passes to count as moved (rounding of a resting one).
const POINTER_MOVE_MIN_PX: f32 = 0.5;
/// A 0-to-1 slider's value times this is the percent its row shows.
const PERCENT: f32 = 100.0;

/// The text keys the shell itself draws.
pub const SHELL_KEYS: [&str; 5] = ["settings-preset", "settings-custom", "settings-reset", "settings-on", "settings-off"];

/// The shell's English words by text key, the fallback when the game's catalog has none.
const ENGLISH: &[(&str, &str)] = &[
    ("settings-preset", "Preset"),
    ("settings-custom", "Custom"),
    ("settings-reset", "Reset"),
    ("settings-on", "On"),
    ("settings-off", "Off"),
    ("settings-tab-graphics", "Graphics"),
    ("settings-tab-audio", "Audio"),
    ("settings-tab-controls", "Controls"),
    ("settings-tab-accessibility", "Language & Accessibility"),
    ("settings-tab-game", "Game"),
    ("ui-scale-auto", "Auto"),
    ("ui-scale-75", "75%"),
    ("ui-scale-100", "100%"),
    ("ui-scale-125", "125%"),
    ("ui-scale-150", "150%"),
    ("ui-scale-200", "200%"),
];

/// The shell's English word for `key`; any other key reads as itself (as a missing text does).
pub fn english(key: &str) -> String {
    ENGLISH.iter().find(|(own, _)| *own == key).map_or(key, |(_, word)| word).to_owned()
}

/// The text key of a tab's label (`settings-tab-audio`).
pub fn tab_label_key(tab: SettingsTab) -> String {
    format!("settings-tab-{}", tab.wire())
}

/// What the menu did on one pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuAnswer {
    /// The tab drawn on this pass.
    pub tab: SettingsTab,
    /// Whether a setting changed on this pass (a custom tab reports its own).
    pub changed: bool,
    /// Whether the player backed out (B, Escape).
    pub back: bool,
}

/// A custom tab's body: draws the tab and answers whether something changed.
type CustomBody<'a> = Box<dyn FnMut(&mut egui::Ui) -> bool + 'a>;

/// A tabbed settings menu: `SettingsMenu::new("settings").custom_tab(SettingsTab::Graphics, |ui|
/// panel(ui)).schema_tab(SettingsTab::Audio).show(ui, &mut store, &tr)`.
pub struct SettingsMenu<'a> {
    key: &'a str,
    tabs: Vec<(SettingsTab, Option<CustomBody<'a>>)>,
}

impl<'a> SettingsMenu<'a> {
    /// A menu keyed `key` with no tabs (its widgets are keyed `<key>.…`).
    pub fn new(key: &'a str) -> SettingsMenu<'a> {
        SettingsMenu { key, tabs: Vec::new() }
    }

    /// A tab drawn from the store's schema: presets, options, Reset.
    #[must_use]
    pub fn schema_tab(mut self, tab: SettingsTab) -> SettingsMenu<'a> {
        self.tabs.push((tab, None));
        self
    }

    /// A tab the caller draws.
    #[must_use]
    pub fn custom_tab(mut self, tab: SettingsTab, body: impl FnMut(&mut egui::Ui) -> bool + 'a) -> SettingsMenu<'a> {
        self.tabs.push((tab, Some(Box::new(body))));
        self
    }

    /// Draw the tab row and the open tab. `tr` looks up a text key (the game's catalog, or
    /// [`english`]).
    pub fn show(mut self, ui: &mut egui::Ui, store: &mut SettingsStore, tr: &dyn Fn(&str) -> String) -> MenuAnswer {
        let ctx = ui.ctx().clone();
        let reachable = ctx.memory(|m| m.allows_interaction(ui.layer_id()));
        let back = reachable && pressed(&ctx, NavButton::Cancel);
        let Some(last) = self.tabs.len().checked_sub(1) else {
            return MenuAnswer { tab: SettingsTab::Game, changed: false, back };
        };
        let memory = Id::new((OPEN_TAB_SALT, self.key));
        let mut open = ctx.data(|data| data.get_temp::<usize>(memory)).unwrap_or(0).min(last);
        let step = i32::from(reachable && pressed(&ctx, NavButton::Next)) - i32::from(reachable && pressed(&ctx, NavButton::Prev));
        if step != 0 {
            open = wrapped(open, step, self.tabs.len());
            // The shell switched tabs; egui's Tab walk must not move focus too.
            ctx.memory_mut(|m| m.move_focus(FocusDirection::None));
        }
        if let Some(clicked) = self.tab_row(ui, open, tr) {
            open = clicked;
        }
        ctx.data_mut(|data| data.insert_temp(memory, open));
        ui.separator();
        let key = self.key;
        let (tab, body) = &mut self.tabs[open];
        let changed = match body {
            Some(custom) => custom(ui),
            None => schema_body(ui, key, *tab, store, tr),
        };
        MenuAnswer { tab: *tab, changed, back }
    }

    /// The tab row; answers a tab the pointer picked.
    fn tab_row(&self, ui: &mut egui::Ui, open: usize, tr: &dyn Fn(&str) -> String) -> Option<usize> {
        let mut clicked = None;
        ui.horizontal(|ui| {
            for (index, (tab, _)) in self.tabs.iter().enumerate() {
                let button = egui::Button::selectable(index == open, tr(&tab_label_key(*tab)));
                let response = ui.add(button).key(ui, &format!("{}.tab.{}", self.key, tab.wire()));
                if response.clicked() {
                    clicked = Some(index);
                }
            }
        });
        clicked
    }
}

/// A schema tab: the preset row (when the tab has presets), one row per option, then Reset.
fn schema_body(ui: &mut egui::Ui, menu: &str, tab: SettingsTab, store: &mut SettingsStore, tr: &dyn Fn(&str) -> String) -> bool {
    let mut scope = FocusScope::new(&format!("{menu}.{}", tab.wire())).hold(true);
    let mut changed = preset_row(ui, menu, tab, store, tr, &mut scope);
    let defs: Vec<SettingDef> = store.schema().tab_options(tab).cloned().collect();
    for def in &defs {
        let value = store.value(def.key()).unwrap_or_else(|| def.default_value());
        let text = format!("{}: {}", tr(def.label_key()), value_text(def, value, tr));
        let response = row(ui, text, &format!("{menu}.opt.{}", def.key()));
        scope.item(&response);
        let direction = row_direction(ui, &response, matches!(def.kind(), SettingKind::Toggle));
        if direction != 0 {
            changed |= store.set(def.key(), def.stepped(value, direction)).unwrap_or(false);
        }
    }
    let reset = row(ui, tr("settings-reset"), &format!("{menu}.{}.reset", tab.wire()));
    scope.item(&reset);
    if reset.clicked() {
        store.reset_tab(tab);
        changed = true;
    }
    scope.end(ui.ctx());
    changed
}

/// The preset row: the chosen preset's name (or Custom); left and right cycle the tab's presets.
fn preset_row(
    ui: &mut egui::Ui,
    menu: &str,
    tab: SettingsTab,
    store: &mut SettingsStore,
    tr: &dyn Fn(&str) -> String,
    scope: &mut FocusScope,
) -> bool {
    let names: Vec<String> = store.schema().presets(tab).map(|preset| preset.name().to_owned()).collect();
    if names.is_empty() {
        return false;
    }
    let chosen = store.preset(tab).and_then(|name| names.iter().position(|own| own == name));
    let shown = chosen.map_or_else(|| tr("settings-custom"), |at| tr(&names[at]));
    let response = row(ui, format!("{}: {shown}", tr("settings-preset")), &format!("{menu}.{}.preset", tab.wire()));
    scope.item(&response);
    let direction = row_direction(ui, &response, false);
    if direction == 0 {
        return false;
    }
    let next = match chosen {
        Some(at) => wrapped(at, direction, names.len()),
        None if direction > 0 => 0,
        None => names.len() - 1,
    };
    store.choose_preset(tab, &names[next]).is_ok()
}

/// One row: a keyed button at least [`SETTINGS_ROW_MIN`] large. Its egui id comes from its key,
/// so a row of another tab drawn at the same place never inherits its focus. One row is outlined
/// at a time, the focused one: a hovered row looks like a resting one, and the pointer moving onto
/// a row gives it the focus; a resting pointer leaves the pad its walk.
fn row(ui: &mut egui::Ui, text: String, key: &str) -> Response {
    let button = |ui: &mut egui::Ui| {
        let resting = ui.visuals().widgets.inactive;
        ui.visuals_mut().widgets.hovered = resting;
        ui.add(egui::Button::new(text).min_size(SETTINGS_ROW_MIN))
    };
    let response = ui.push_id(key, button).inner.key(ui, key);
    // Checked on every pass, hovered or not, so the next pass compares with this one.
    let moved = pointer_moved(ui.ctx());
    if moved && response.hovered() && !response.has_focus() {
        response.request_focus();
    }
    response
}

/// Whether the pointer moved on the screen since the last pass. The HUD sends the pointer every
/// tick, and a UI scale change moves a resting pointer in points, so the position compared is in
/// pixels; each pass decides once, on its first row.
fn pointer_moved(ctx: &egui::Context) -> bool {
    let pass = ctx.cumulative_pass_nr();
    let id = Id::new(POINTER_SALT);
    let last = ctx.data(|data| data.get_temp::<PointerSeen>(id));
    if let Some(seen) = last.filter(|seen| seen.pass == pass) {
        return seen.moved;
    }
    let pixels = ctx.input(|input| input.pointer.latest_pos().map(|pos| pos.to_vec2() * input.pixels_per_point));
    let moved = matches!((last.and_then(|seen| seen.pixels), pixels), (Some(before), Some(now)) if (now - before).length() > POINTER_MOVE_MIN_PX);
    ctx.data_mut(|data| data.insert_temp(id, PointerSeen { pass, pixels, moved }));
    moved
}

/// The pointer as the last pass saw it: its pass, its position in pixels and whether it moved.
#[derive(Clone, Copy, Debug)]
struct PointerSeen {
    pass: u64,
    pixels: Option<egui::Vec2>,
    moved: bool,
}

/// How a row moves its value on this pass: left or right while it has focus, or a click (a tap on
/// the left half steps back unless `flip`, where either way toggles; A steps forward).
fn row_direction(ui: &egui::Ui, response: &Response, flip: bool) -> i32 {
    if response.clicked() {
        let left_half = response.interact_pointer_pos().is_some_and(|pos| pos.x < response.rect.center().x);
        return if left_half && !flip { -1 } else { 1 };
    }
    if !response.has_focus() {
        return 0;
    }
    i32::from(pressed(ui.ctx(), NavButton::Right)) - i32::from(pressed(ui.ctx(), NavButton::Left))
}

/// A value as a row shows it: On or Off, a 0-to-1 slider as a whole percent (a volume), another
/// slider's number, the option's text.
fn value_text(def: &SettingDef, value: SettingValue, tr: &dyn Fn(&str) -> String) -> String {
    match (def.kind(), value) {
        (SettingKind::Slider { min, max, .. }, SettingValue::Number(number)) if is_unit_range(*min, *max) => {
            format!("{}%", (number * PERCENT).round())
        }
        (_, SettingValue::Bool(true)) => tr("settings-on"),
        (_, SettingValue::Bool(false)) => tr("settings-off"),
        (SettingKind::Choice { options }, SettingValue::Choice(index)) => {
            options.get(usize::from(index)).map_or_else(String::new, |option| tr(option))
        }
        (_, SettingValue::Number(number)) => format!("{number}"),
        (_, SettingValue::Choice(index)) => index.to_string(),
    }
}

/// Whether a slider runs from 0 to 1 (shown as a percent).
fn is_unit_range(min: f32, max: f32) -> bool {
    min.abs() < f32::EPSILON && (max - 1.0).abs() < f32::EPSILON
}

/// `at` moved by `step` within `count`, wrapping.
fn wrapped(at: usize, step: i32, count: usize) -> usize {
    let count = i64::try_from(count.max(1)).unwrap_or(1);
    let moved = (i64::try_from(at).unwrap_or(0) + i64::from(step)).rem_euclid(count);
    usize::try_from(moved).unwrap_or(0)
}
