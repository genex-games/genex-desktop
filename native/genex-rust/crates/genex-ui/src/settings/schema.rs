//! The settings schema (G6 gameplay UI, UIS-7): typed options on the menu's tabs, each a toggle, a
//! stepped slider or a choice with a default, plus named presets per tab. The runtime registers
//! its built-in options (`audio.*` buses as data, `ui.*` accessibility, `input.*`, `graphics.*`)
//! on their own tabs; a game's options live on the Game tab and may not take those prefixes.
//!
//! Anything that changes play (difficulty, a cheat) belongs in the world and its save, not here:
//! settings are a person layer outside the simulation.

use std::fmt;

use crate::settings::presets::Preset;

/// The most options one schema declares (built-in and the game's together).
pub const SETTINGS_OPTIONS_MAX: usize = 256;
/// The longest option key, in bytes: `[a-z0-9._-]`, so `<menu>.opt.<key>` stays a UI key.
pub const SETTING_KEY_MAX: usize = 48;
/// The most options one choice offers.
pub const CHOICE_OPTIONS_MAX: usize = 32;
/// The most presets one tab offers.
pub const PRESETS_PER_TAB_MAX: usize = 8;

/// A tab of the settings menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum SettingsTab {
    /// Graphics: genex-render's panel (a custom tab), options keyed `graphics.*`.
    Graphics,
    /// Audio: the buses, options keyed `audio.*`.
    Audio,
    /// Controls: INPUT's panel (a custom tab), options keyed `input.*`.
    Controls,
    /// Language and accessibility: options keyed `ui.*`.
    Accessibility,
    /// The game's own options (no reserved prefix).
    Game,
}

impl SettingsTab {
    /// Every tab, in menu order.
    pub const ALL: &'static [SettingsTab] =
        &[SettingsTab::Graphics, SettingsTab::Audio, SettingsTab::Controls, SettingsTab::Accessibility, SettingsTab::Game];

    /// The wire spelling (`genex-settings.json` presets, UI keys, the docs).
    pub const fn wire(self) -> &'static str {
        match self {
            SettingsTab::Graphics => "graphics",
            SettingsTab::Audio => "audio",
            SettingsTab::Controls => "controls",
            SettingsTab::Accessibility => "accessibility",
            SettingsTab::Game => "game",
        }
    }

    /// The tab a wire spelling names.
    pub fn from_wire(wire: &str) -> Option<SettingsTab> {
        SettingsTab::ALL.iter().copied().find(|tab| tab.wire() == wire)
    }

    /// The key prefix the tab's built-in options take; the Game tab has none and may use none.
    pub const fn prefix(self) -> Option<&'static str> {
        match self {
            SettingsTab::Graphics => Some("graphics."),
            SettingsTab::Audio => Some("audio."),
            SettingsTab::Controls => Some("input."),
            SettingsTab::Accessibility => Some("ui."),
            SettingsTab::Game => None,
        }
    }
}

/// A setting's value.
#[derive(Clone, Copy, Debug, PartialEq)]
#[non_exhaustive]
pub enum SettingValue {
    /// A toggle.
    Bool(bool),
    /// A slider's value.
    Number(f32),
    /// A choice's option, by index.
    Choice(u16),
}

/// What kind of control an option is, with its range or options.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum SettingKind {
    /// On or off.
    Toggle,
    /// A number in `min..=max`, moved by `step`.
    Slider {
        /// The smallest value.
        min: f32,
        /// The largest value.
        max: f32,
        /// One step (left or right on a pad).
        step: f32,
    },
    /// One of named options (each a text key).
    Choice {
        /// The options' keys, in order.
        options: Vec<String>,
    },
}

/// One option: its key, the text key of its label, its kind and its default.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingDef {
    key: String,
    label_key: String,
    kind: SettingKind,
    default: SettingValue,
}

impl SettingDef {
    /// A toggle.
    pub fn toggle(key: &str, label_key: &str, default: bool) -> SettingDef {
        SettingDef { key: key.to_owned(), label_key: label_key.to_owned(), kind: SettingKind::Toggle, default: SettingValue::Bool(default) }
    }

    /// A slider from `min` to `max` in steps of `step`.
    pub fn slider(key: &str, label_key: &str, min: f32, max: f32, step: f32, default: f32) -> SettingDef {
        let kind = SettingKind::Slider { min, max, step };
        SettingDef { key: key.to_owned(), label_key: label_key.to_owned(), kind, default: SettingValue::Number(default) }
    }

    /// A choice among `options` (text keys); `default` is an index into them.
    pub fn choice(key: &str, label_key: &str, options: &[&str], default: u16) -> SettingDef {
        let kind = SettingKind::Choice { options: options.iter().map(|option| (*option).to_owned()).collect() };
        SettingDef { key: key.to_owned(), label_key: label_key.to_owned(), kind, default: SettingValue::Choice(default) }
    }

    /// The option's key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The text key of its label.
    pub fn label_key(&self) -> &str {
        &self.label_key
    }

    /// Its kind.
    pub fn kind(&self) -> &SettingKind {
        &self.kind
    }

    /// Its default.
    pub fn default_value(&self) -> SettingValue {
        self.default
    }

    /// `value` checked against the option: the right type, finite and in range, a slider's value
    /// snapped to its step. Refuses `settings-value-invalid`.
    pub fn check(&self, value: SettingValue) -> Result<SettingValue, SettingsIssue> {
        let refused = || SettingsIssue::new(SettingsErrorCode::ValueInvalid, &self.key, format!("{value:?} does not fit {}", self.key));
        match (&self.kind, value) {
            (SettingKind::Toggle, SettingValue::Bool(_)) => Ok(value),
            (SettingKind::Slider { min, max, step }, SettingValue::Number(number)) => {
                let in_range = number.is_finite() && number >= *min && number <= *max;
                if in_range { Ok(SettingValue::Number(snap(number, *min, *max, *step))) } else { Err(refused()) }
            }
            (SettingKind::Choice { options }, SettingValue::Choice(index)) if usize::from(index) < options.len() => Ok(value),
            _ => Err(refused()),
        }
    }

    /// The value one step from `value` (`direction` -1 or +1): a toggle flips, a slider moves a
    /// step within its range, a choice moves to the neighbouring option and wraps.
    pub fn stepped(&self, value: SettingValue, direction: i32) -> SettingValue {
        match (&self.kind, value) {
            (SettingKind::Toggle, SettingValue::Bool(on)) => SettingValue::Bool(!on),
            (SettingKind::Slider { min, max, step }, SettingValue::Number(number)) => {
                let moved = number + step * direction as f32;
                SettingValue::Number(snap(moved.clamp(*min, *max), *min, *max, *step))
            }
            (SettingKind::Choice { options }, SettingValue::Choice(index)) => {
                let count = options.len().max(1) as i64;
                let next = (i64::from(index) + i64::from(direction)).rem_euclid(count);
                SettingValue::Choice(u16::try_from(next).unwrap_or(0))
            }
            _ => self.default,
        }
    }

    /// The option's own checks: key, label, range, options, default.
    fn validate(&self) -> Result<(), SettingsIssue> {
        let refused = |detail: String| SettingsIssue::new(SettingsErrorCode::Invalid, &self.key, detail);
        if !key_ok(&self.key) {
            return Err(refused(format!("option key {:?} is not 1 to {SETTING_KEY_MAX} bytes of a-z, 0-9, '.', '_' or '-'", self.key)));
        }
        if self.label_key.is_empty() || self.label_key.len() > SETTING_KEY_MAX * 2 {
            return Err(refused(format!("option {} has no label key", self.key)));
        }
        match &self.kind {
            SettingKind::Slider { min, max, step } => {
                let finite = min.is_finite() && max.is_finite() && step.is_finite();
                let unusable = !finite || min >= max || *step <= 0.0;
                if unusable {
                    return Err(refused(format!("slider {} needs finite min < max and a step above 0", self.key)));
                }
            }
            SettingKind::Choice { options } => {
                let repeated = options.iter().enumerate().any(|(at, option)| options[..at].contains(option));
                let bad_option = options.iter().any(|option| option.is_empty() || option.len() > SETTING_KEY_MAX);
                let unusable = options.is_empty() || options.len() > CHOICE_OPTIONS_MAX || repeated || bad_option;
                if unusable {
                    return Err(refused(format!("choice {} needs 1 to {CHOICE_OPTIONS_MAX} distinct option keys", self.key)));
                }
            }
            SettingKind::Toggle => {}
        }
        let default_ok = self.check(self.default).is_ok_and(|checked| checked == self.default);
        if !default_ok {
            return Err(refused(format!("option {}'s default {:?} does not fit it", self.key, self.default)));
        }
        Ok(())
    }
}

/// `number` on the nearest step from `min`, kept in range. The bounds and step are read as the
/// decimals they were written as (an f32's shortest spelling) and the step is taken in f64, so
/// 0.8 + 0.1 is 0.9 and not 0.90000004.
fn snap(number: f32, min: f32, max: f32, step: f32) -> f32 {
    let (low, stride) = (decimal(min), decimal(step));
    let steps = ((decimal(number) - low) / stride).round();
    let snapped = (low + steps * stride) as f32;
    snapped.clamp(min, max)
}

/// The f64 of an f32's shortest decimal spelling (`0.1f32` reads 0.1, not 0.10000000149).
fn decimal(value: f32) -> f64 {
    value.to_string().parse().unwrap_or(f64::from(value))
}

/// Whether `key` is a legal option key.
pub fn key_ok(key: &str) -> bool {
    let legal = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-');
    !key.is_empty() && key.len() <= SETTING_KEY_MAX && key.bytes().all(legal)
}

/// Why the settings refused something, in its exact wire spelling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SettingsErrorCode {
    /// A schema that cannot work, or a `genex-settings.json` that is not a format-1 file within
    /// the caps (the defaults are kept and nothing is written).
    Invalid,
    /// A key or preset the schema does not declare (a stale row is skipped, the rest applies).
    KeyUnknown,
    /// A value of the wrong type or out of range for its option.
    ValueInvalid,
}

impl SettingsErrorCode {
    /// Every code, in declaration order.
    pub const ALL: &'static [SettingsErrorCode] = &[SettingsErrorCode::Invalid, SettingsErrorCode::KeyUnknown, SettingsErrorCode::ValueInvalid];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            SettingsErrorCode::Invalid => "settings-invalid",
            SettingsErrorCode::KeyUnknown => "settings-key-unknown",
            SettingsErrorCode::ValueInvalid => "settings-value-invalid",
        }
    }

    /// The code a wire spelling names.
    pub fn from_wire(wire: &str) -> Option<SettingsErrorCode> {
        SettingsErrorCode::ALL.iter().copied().find(|code| code.wire() == wire)
    }
}

impl fmt::Display for SettingsErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.wire())
    }
}

/// A settings refusal or skipped row: the code, what it was about and a detail for a person
/// (never matched on).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsIssue {
    code: SettingsErrorCode,
    subject: String,
    detail: String,
}

impl SettingsIssue {
    /// An issue about `subject` (an option key, `tab:preset`, or the file).
    pub fn new(code: SettingsErrorCode, subject: &str, detail: impl Into<String>) -> SettingsIssue {
        SettingsIssue { code, subject: subject.chars().take(SETTING_KEY_MAX * 2).collect(), detail: detail.into() }
    }

    /// Why.
    pub fn code(&self) -> SettingsErrorCode {
        self.code
    }

    /// What it is about.
    pub fn subject(&self) -> &str {
        &self.subject
    }

    /// For a person.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for SettingsIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for SettingsIssue {}

/// Every option and preset of the menu:
/// `SettingsSchema::new().option(SettingsTab::Game, SettingDef::toggle("hints", "settings-hints", true))`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettingsSchema {
    options: Vec<(SettingsTab, SettingDef)>,
    presets: Vec<Preset>,
}

impl SettingsSchema {
    /// No options.
    pub fn new() -> SettingsSchema {
        SettingsSchema::default()
    }

    /// Add an option to `tab`.
    #[must_use]
    pub fn option(mut self, tab: SettingsTab, def: SettingDef) -> SettingsSchema {
        self.options.push((tab, def));
        self
    }

    /// Add a preset to `tab`: its name (a text key) and the values it sets; keys it leaves keep
    /// their defaults.
    #[must_use]
    pub fn preset(mut self, tab: SettingsTab, name_key: &str, values: &[(&str, SettingValue)]) -> SettingsSchema {
        self.presets.push(Preset::new(tab, name_key, values));
        self
    }

    /// Every option with its tab, in declaration order.
    pub fn options(&self) -> impl Iterator<Item = (SettingsTab, &SettingDef)> + '_ {
        self.options.iter().map(|(tab, def)| (*tab, def))
    }

    /// Every option with its tab, as a slice (the store indexes it).
    pub(crate) fn option_list(&self) -> &[(SettingsTab, SettingDef)] {
        &self.options
    }

    /// The options of one tab, in declaration order.
    pub fn tab_options(&self, tab: SettingsTab) -> impl Iterator<Item = &SettingDef> + '_ {
        self.options.iter().filter(move |(on, _)| *on == tab).map(|(_, def)| def)
    }

    /// The option `key`.
    pub fn def(&self, key: &str) -> Option<&SettingDef> {
        self.options.iter().find(|(_, def)| def.key == key).map(|(_, def)| def)
    }

    /// The tab of the option `key`.
    pub fn tab_of(&self, key: &str) -> Option<SettingsTab> {
        self.options.iter().find(|(_, def)| def.key == key).map(|(tab, _)| *tab)
    }

    /// The presets of one tab, in declaration order.
    pub fn presets(&self, tab: SettingsTab) -> impl Iterator<Item = &Preset> + '_ {
        self.presets.iter().filter(move |preset| preset.tab() == tab)
    }

    /// The preset `name` of `tab`.
    pub fn find_preset(&self, tab: SettingsTab, name: &str) -> Option<&Preset> {
        self.presets(tab).find(|preset| preset.name() == name)
    }

    /// Check the schema: at most [`SETTINGS_OPTIONS_MAX`] legal options with distinct keys, each
    /// with its tab's prefix (none on the Game tab), and presets that set their own tab's options
    /// to fitting values. Refuses `settings-invalid`.
    pub fn validate(&self) -> Result<(), SettingsIssue> {
        if self.options.len() > SETTINGS_OPTIONS_MAX {
            let detail = format!("{} options, at most {SETTINGS_OPTIONS_MAX}", self.options.len());
            return Err(SettingsIssue::new(SettingsErrorCode::Invalid, "schema", detail));
        }
        for (at, (tab, def)) in self.options.iter().enumerate() {
            def.validate()?;
            check_prefix(*tab, &def.key)?;
            if self.options[..at].iter().any(|(_, earlier)| earlier.key == def.key) {
                return Err(SettingsIssue::new(SettingsErrorCode::Invalid, &def.key, format!("option {} is declared twice", def.key)));
            }
        }
        for (at, preset) in self.presets.iter().enumerate() {
            preset.validate(self, &self.presets[..at])?;
        }
        Ok(())
    }
}

/// A built-in tab's options take its prefix; the Game tab's options take no reserved prefix.
fn check_prefix(tab: SettingsTab, key: &str) -> Result<(), SettingsIssue> {
    let reserved = SettingsTab::ALL.iter().filter_map(|other| other.prefix()).find(|prefix| key.starts_with(prefix));
    let fits = match tab.prefix() {
        Some(prefix) => key.starts_with(prefix),
        None => reserved.is_none(),
    };
    if fits {
        return Ok(());
    }
    let detail = match tab.prefix() {
        Some(prefix) => format!("option {key} on the {} tab must start with {prefix}", tab.wire()),
        None => format!("game option {key} takes a reserved prefix"),
    };
    Err(SettingsIssue::new(SettingsErrorCode::Invalid, key, detail))
}
