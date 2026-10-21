//! Gameplay UI (`genex::ui`, G6 UIS-10): the facade over genex-ui. `game.ui(UiConfig)` names the
//! locales a game offers, their fallback fonts and its UI scale; `tr` / `tr_args` look text up
//! in the active locale's Fluent catalog (`assets/lang/<locale>.ftl`) inside the update and UI
//! hooks (the `UiScope`, a thread-local like the render panel's); the kit's menus, dialogs,
//! grids, lists, bars and toasts are re-exported from genex-ui.
//!
//! - **Navigation.** With `game.ui`, the HUD's navigation buttons come from a [`UiNavSource`]
//!   function pointer, by default genex-ui's [`default_buttons`] (arrows, Enter, Escape, Tab; a
//!   standard pad's d-pad, left stick, A, B and the bumpers). A held button repeats on tick
//!   counts. A game with `game.input` and its `ui` context on navigates by its `ui_*` actions
//!   instead (the runtime asks INPUT first); this module never depends on INPUT.
//! - **Focus gating.** While a HUD widget holds focus, the pad buttons and the stick navigation
//!   consumes read neutral in the update hooks, as the keys already do.
//! - **Person layer.** The locale is the Studio session's, else the person's saved choice
//!   (`genex-settings.json`, `values."ui.language"`), else the OS locale, else the first offered.
//!   A Genex run (a run the studio started) ignores the person's choice and the OS locale, and its
//!   `UiScale::Auto` is 1, so judged runs are deterministic.
//! - **Display only.** Nothing here enters the checksum: `state().volatile.ui`,
//!   `state().hud.widgets` and `state().hud.focus` are display state.

use std::cell::RefCell;
use std::sync::Arc;

use genex_core::input::{PadState, PadStates, Pads as CorePads};
use genex_core::json::Value as CoreValue;
use genex_core::saves::Saves;
use genex_hud::LocaleFont;
use genex_ui::nav::{NavRepeat, nav_neutral};
use genex_ui::settings::scale::{OutputClass, UI_SCALE_MAX, UI_SCALE_MIN};
use genex_ui::text::catalog::Catalog;
use genex_ui::text::locale::negotiate;

use crate::game::Game;
use crate::gfx::Assets;
use crate::runtime::InstallErrorCode;

pub use genex_ui::focus::{FocusAnswer, FocusLayout, FocusScope};
pub use genex_ui::keyed::{Keyed, UI_ISSUES_MAX, UI_KEY_MAX, UiIssue, UiIssueCode, UiKey};
pub use genex_ui::kit::bar::Bar;
pub use genex_ui::kit::dialog::Dialog;
pub use genex_ui::kit::grid::{DRAG_DELAY_TICKS, GridAnswer, ItemGrid};
pub use genex_ui::kit::list::ItemList;
pub use genex_ui::kit::menu::Menu;
pub use genex_ui::kit::nine_slice::NineSlice;
pub use genex_ui::kit::toast::{TOAST_TICKS, ToastKind, Toasts};
pub use genex_ui::nav::{NAV_REPEAT_DELAY_TICKS, NAV_REPEAT_EVERY_TICKS, NavButton, NavButtons, default_buttons};
pub use genex_ui::settings::scale::UiScale;
pub use genex_ui::text::args::TextArgs;
pub use genex_ui::text::catalog::{TEXT_FILE_BYTES_MAX, TEXT_KEYS_MAX, TextErrorCode, TextIssue};
pub use genex_ui::text::locale::Locale;
pub use genex_ui::text::pseudo::PSEUDO_LOCALE;

/// `state().volatile.ui`'s key.
pub(crate) const VOLATILE_UI_KEY: &str = "ui";
/// The folder under `assets/` a locale's text is read from (`lang/<locale>.ftl`).
const TEXT_FOLDER: &str = "lang";
/// The settings file's member a person's locale choice is read from (the Language tab's option).
const PERSON_LOCALE_KEY: &str = "ui.language";
/// Where the settings file keeps its values.
const SETTINGS_VALUES_KEY: &str = "values";
/// The locale of a game whose `game.ui` lists none: every key draws as itself.
const UNLISTED_LOCALE: &str = "en";

/// Where the HUD's navigation buttons come from on a tick: one pad's state and the keyboard keys
/// held (DOM `code` names; empty while a text field takes the keys). genex-ui's
/// [`default_buttons`] by default; INPUT (or a test) replaces it through
/// `Runtime::set_ui_nav_source`.
pub type UiNavSource = fn(&PadState, &[String]) -> NavButtons;

/// What `game.ui` registers: the locales, their fallback fonts and the UI scale.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UiConfig {
    locales: Vec<String>,
    fonts: Vec<(String, String)>,
    scale: UiScale,
    pseudo: bool,
}

impl UiConfig {
    /// No locales (every key draws as itself), `UiScale::Auto`, no pseudo-locale.
    pub fn new() -> UiConfig {
        UiConfig::default()
    }

    /// The locales offered (BCP-47 tags), the first the fallback; each one's text is
    /// `assets/lang/<locale>.ftl` in the boot group.
    #[must_use]
    pub fn locales(self, locales: &[&str]) -> UiConfig {
        UiConfig { locales: locales.iter().map(|tag| (*tag).to_owned()).collect(), ..self }
    }

    /// A fallback font for `locale`: a game asset path (an OFL font the game ships).
    #[must_use]
    pub fn font(mut self, locale: &str, asset: &str) -> UiConfig {
        self.fonts.push((locale.to_owned(), asset.to_owned()));
        self
    }

    /// The UI scale (default `UiScale::Auto`: 1.5 on a phone in an export, 1 elsewhere).
    #[must_use]
    pub fn scale(self, scale: UiScale) -> UiConfig {
        UiConfig { scale, ..self }
    }

    /// Offer `xx-pseudo` (accented, padded, bracketed text that shows overflow in captures).
    #[must_use]
    pub fn pseudo_locale(self, on: bool) -> UiConfig {
        UiConfig { pseudo: on, ..self }
    }
}

impl<W> Game<W> {
    /// Register the gameplay UI: its locales, fonts and scale (`docs/api/ui.md`). Install refuses
    /// a second registration (`duplicate-ui`) and a locale that is not BCP-47 or a font named for
    /// a locale not listed (`ui-locale-invalid`).
    pub fn ui(&mut self, config: UiConfig) -> &mut Self {
        self.g6.ui.configs.push(config);
        self
    }
}

/// `game.ui`: the locales, fonts and scale the game registers.
#[derive(Debug, Default)]
pub(crate) struct Setup {
    configs: Vec<UiConfig>,
}

impl Setup {
    /// Whether the game registered `game.ui`.
    pub(crate) fn registered(&self) -> bool {
        !self.configs.is_empty()
    }

    fn config(&self) -> Option<&UiConfig> {
        self.configs.first()
    }
}

/// `install`'s `game.ui` checks: one registration, BCP-47 locales, fonts only for listed locales.
pub(crate) fn check(setup: &Setup) -> Result<(), (InstallErrorCode, String)> {
    if setup.configs.len() > 1 {
        return Err((InstallErrorCode::DuplicateUi, "game.ui is registered once".to_owned()));
    }
    let Some(config) = setup.config() else { return Ok(()) };
    let not_listable = |tag: &&String| Locale::parse(tag).is_none_or(|locale| locale.is_pseudo());
    if let Some(tag) = config.locales.iter().find(not_listable) {
        return Err((InstallErrorCode::UiLocaleInvalid, format!("{tag:?} is not a BCP-47 locale")));
    }
    if let Some((tag, _)) = config.fonts.iter().find(|(tag, _)| !config.locales.contains(tag)) {
        return Err((InstallErrorCode::UiLocaleInvalid, format!("a font is named for {tag:?}, which game.ui does not list")));
    }
    Ok(())
}

/// A Studio session's UI layer (`uiSettings`): applied at the next tick boundary, kept across
/// seeds, on top of the person's layer (and the only layer a Genex run has).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UiSession {
    /// A locale the game offers.
    pub locale: Option<String>,
    /// A fixed UI scale in `0.5..=3.0`.
    pub scale: Option<f32>,
    /// An emulated safe area `[left, top, right, bottom]` in world pixels (each finite, >= 0).
    pub safe_area: Option<[f32; 4]>,
    /// Reduced motion on or off.
    pub reduced_motion: Option<bool>,
}

/// Why a session layer was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum UiSessionCode {
    /// A scale or safe area out of range, or the game has no `game.ui`.
    BadArgument,
    /// A locale the game does not offer.
    LocaleUnknown,
}

impl UiSessionCode {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            UiSessionCode::BadArgument => "bad-argument",
            UiSessionCode::LocaleUnknown => "text-locale-unknown",
        }
    }
}

/// One UI issue for `state().volatile.ui.issues` (and, for a text file, `__render.assetIssues`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    code: &'static str,
    subject: String,
    /// The text file the issue is about, when it is one.
    file: Option<String>,
}

/// One offered locale's text and font, read at the seed.
#[derive(Debug)]
struct LocaleText {
    locale: Locale,
    bytes: Option<Arc<[u8]>>,
    font: Option<Arc<[u8]>>,
}

/// The gameplay UI's runtime state: the catalog, the layers that pick its locale and scale, the
/// navigation repeat and the issues raised since the seed.
#[derive(Debug)]
pub(crate) struct State {
    texts: Vec<LocaleText>,
    catalog: Option<Catalog>,
    pinned: bool,
    person_locale: Option<String>,
    os_locale: Option<String>,
    shell_safe_area: [f32; 4],
    output: OutputClass,
    session: UiSession,
    pending: Option<UiSession>,
    repeat: NavRepeat,
    nav_source: UiNavSource,
    last_pads: PadStates,
    issues: Vec<Record>,
    fonts_due: bool,
}

impl Default for State {
    fn default() -> State {
        State {
            texts: Vec::new(),
            catalog: None,
            pinned: false,
            person_locale: None,
            os_locale: None,
            shell_safe_area: [0.0; 4],
            output: OutputClass::Desktop,
            session: UiSession::default(),
            pending: None,
            repeat: NavRepeat::new(),
            nav_source: default_buttons,
            last_pads: PadStates::default(),
            issues: Vec::new(),
            fonts_due: false,
        }
    }
}

impl State {
    /// A new seed: menus close (the HUD's memory resets), the repeat and the issues start over.
    pub(crate) fn reset(&mut self, _setup: &Setup) {
        self.repeat.reset();
        self.issues.clear();
        self.last_pads = PadStates::default();
    }

    /// The person's saved locale from the settings file in `saves`, unless `pinned` (a Genex run,
    /// which also ignores the OS locale).
    pub(crate) fn rebase(&mut self, setup: &Setup, saves: &Saves, pinned: bool) {
        if !setup.registered() {
            return;
        }
        self.pinned = pinned;
        self.person_locale = if pinned { None } else { saves.load(genex_ui::settings::store::SETTINGS_FILE).as_deref().and_then(person_locale) };
        self.negotiate(setup);
    }

    /// The OS locale a shell read (`sys-locale`); ignored in a Genex run.
    pub(crate) fn set_os_locale(&mut self, setup: &Setup, tag: Option<&str>) {
        self.os_locale = tag.map(str::to_owned);
        self.negotiate(setup);
    }

    /// The safe area a phone shell reports, in world pixels; ignored in a Genex run.
    pub(crate) fn set_shell_safe_area(&mut self, insets: [f32; 4]) {
        self.shell_safe_area = insets.map(|inset| if inset.is_finite() { inset.max(0.0) } else { 0.0 });
    }

    /// The output class a shell reports (a phone's `UiScale::Auto` is larger in an export).
    pub(crate) fn set_output(&mut self, output: OutputClass) {
        self.output = output;
    }

    /// Replace the navigation source.
    pub(crate) fn set_nav_source(&mut self, source: UiNavSource) {
        self.nav_source = source;
    }

    /// Check a session layer and queue it for the next tick boundary.
    pub(crate) fn queue_session(&mut self, setup: &Setup, session: UiSession) -> Result<(), UiSessionCode> {
        if !setup.registered() {
            return Err(UiSessionCode::BadArgument);
        }
        let scale_ok = session.scale.is_none_or(|scale| (UI_SCALE_MIN..=UI_SCALE_MAX).contains(&scale));
        let insets_ok = session.safe_area.is_none_or(|insets| insets.iter().all(|inset| inset.is_finite() && *inset >= 0.0));
        if !scale_ok || !insets_ok {
            return Err(UiSessionCode::BadArgument);
        }
        if let Some(tag) = &session.locale {
            let offered = offered(setup);
            if negotiate(&offered, Some(tag), None).is_none_or(|answer| answer.issue().is_some()) {
                return Err(UiSessionCode::LocaleUnknown);
            }
        }
        self.pending = Some(session);
        Ok(())
    }

    /// At the seed, inside the reset window: read each offered locale's text and font (boot-group
    /// assets, so every destination has them; the asset cache keeps them across seeds) and build
    /// the catalog afresh, so a seed reports its text issues again.
    pub(crate) fn load(&mut self, setup: &Setup, assets: &Assets) {
        let Some(config) = setup.config() else { return };
        let mut texts = Vec::new();
        for locale in offered(setup).into_iter().filter(|locale| !locale.is_pseudo()) {
            let path = text_path(&locale);
            let bytes = assets.bytes(&path).ok().map(|bytes| bytes.shared());
            if bytes.is_none() {
                self.record(TextErrorCode::Missing.wire(), &path, Some(&path));
            }
            let font_asset = config.fonts.iter().find(|(tag, _)| tag == locale.tag()).map(|(_, asset)| asset.as_str());
            let font = font_asset.and_then(|asset| {
                let read = assets.bytes(asset).ok().map(|bytes| bytes.shared());
                if read.is_none() {
                    self.record(TextErrorCode::FontMissing.wire(), asset, None);
                }
                read
            });
            texts.push(LocaleText { locale, bytes, font });
        }
        self.texts = texts;
        self.catalog = None;
        self.negotiate(setup);
    }

    /// At the tick boundary: a queued session layer takes effect.
    pub(crate) fn begin_tick(&mut self, setup: &Setup) {
        if let Some(session) = self.pending.take() {
            self.session = session;
            self.negotiate(setup);
        }
    }

    /// The locale fonts the HUD should switch to, once after the locale changed.
    pub(crate) fn take_fonts(&mut self) -> Option<Vec<LocaleFont>> {
        if !std::mem::take(&mut self.fonts_due) {
            return None;
        }
        let locale = self.catalog.as_ref().map(Catalog::locale)?;
        let text = self.texts.iter().find(|text| &text.locale == locale);
        let font = text.and_then(|text| text.font.as_ref().map(|bytes| LocaleFont::new(text.locale.tag(), bytes.to_vec())));
        Some(font.into_iter().collect())
    }

    /// Pick the locale from the layers and load its text when it changed.
    fn negotiate(&mut self, setup: &Setup) {
        if !setup.registered() {
            return;
        }
        let offered = offered(setup);
        let person = if self.pinned { None } else { self.person_locale.as_deref() };
        let os = if self.pinned { None } else { self.os_locale.as_deref() };
        let choice = self.session.locale.as_deref().or(person);
        let Some(answer) = negotiate(&offered, choice, os) else {
            if self.catalog.is_none() {
                self.catalog = Locale::parse(UNLISTED_LOCALE).map(Catalog::empty);
            }
            return;
        };
        if let Some(issue) = answer.issue() {
            self.record(issue.code().wire(), issue.subject(), None);
        }
        let wanted = answer.locale().clone();
        if self.catalog.as_ref().is_some_and(|catalog| catalog.locale() == &wanted) {
            return;
        }
        self.catalog = Some(self.catalog_of(&wanted));
        self.fonts_due = true;
    }

    fn catalog_of(&self, wanted: &Locale) -> Catalog {
        if wanted.is_pseudo() {
            // Plurals and text follow the fallback locale (the first offered).
            return match self.texts.first() {
                Some(base) => Catalog::load_pseudo(base.locale.clone(), base.bytes.as_deref().unwrap_or_default()),
                None => Catalog::empty(wanted.clone()),
            };
        }
        let bytes = self.texts.iter().find(|text| &text.locale == wanted).and_then(|text| text.bytes.as_deref());
        match bytes {
            Some(bytes) => Catalog::load(wanted.clone(), bytes),
            None => Catalog::empty(wanted.clone()),
        }
    }

    /// The UI scale egui runs at: the session's, else the game's, resolved for the output.
    pub(crate) fn scale(&self, setup: &Setup) -> f32 {
        let configured = setup.config().map_or(UiScale::Auto, |config| config.scale);
        let scale = self.session.scale.map_or(configured, UiScale::Fixed);
        scale.resolve(self.output, self.pinned)
    }

    fn safe_area(&self) -> [f32; 4] {
        match self.session.safe_area {
            Some(insets) => insets,
            None if self.pinned => [0.0; 4],
            None => self.shell_safe_area,
        }
    }

    /// The navigation events for one tick: `keyboard` false while a text field takes the keys
    /// (pads only, so its arrows edit the text once).
    pub(crate) fn navigation(&mut self, pads: &PadStates, held_keys: &[String], keyboard: bool) -> Vec<egui::Event> {
        let keys: &[String] = if keyboard { held_keys } else { &[] };
        let mut buttons = (self.nav_source)(&PadState::default(), keys);
        for pad in pads.iter().filter(|pad| pad.connected) {
            buttons = buttons.union((self.nav_source)(pad, &[]));
        }
        genex_ui::nav::nav_events(self.repeat.step(buttons))
    }

    /// The pads the update hooks read while a HUD widget holds focus: what navigation consumes
    /// reads neutral, on this tick and the one before (so the gating itself makes no edge).
    pub(crate) fn gated_pads(&self, pads: &CorePads) -> CorePads {
        let mut gated = CorePads::default();
        gated.assign(pads.states().map(|pad| nav_neutral(&pad)), self.last_pads.map(|pad| nav_neutral(&pad)));
        gated
    }

    /// After the tick: remember its pads for the next gating.
    pub(crate) fn note_pads(&mut self, pads: &CorePads) {
        self.last_pads = *pads.states();
    }

    /// The issues the last UI pass raised over its keys (`ui-key-invalid`, `ui-key-duplicate`).
    pub(crate) fn note_key_issues(&mut self, issues: &[UiIssue]) {
        for issue in issues {
            self.record(issue.code.wire(), &issue.key, None);
        }
    }

    /// The HUD refused the active locale's font (too large, a bad name): the text fonts stay.
    pub(crate) fn font_refused(&mut self, detail: &str) {
        self.record(TextErrorCode::FontMissing.wire(), detail, None);
    }

    fn record(&mut self, code: &'static str, subject: &str, file: Option<&str>) {
        let record = Record { code, subject: subject.to_owned(), file: file.map(str::to_owned) };
        if self.issues.len() < UI_ISSUES_MAX && !self.issues.contains(&record) {
            self.issues.push(record);
        }
    }

    /// While alive, `tr`, `tr_args`, `locale`, `reduced_motion` and `safe_area` in this tick's
    /// update and UI hooks read this state. `None` without `game.ui`.
    pub(crate) fn enter(&mut self, setup: &Setup) -> Option<UiScope> {
        if !setup.registered() {
            return None;
        }
        let shared = Shared {
            catalog: self.catalog.take(),
            reduced_motion: self.session.reduced_motion.unwrap_or(false),
            safe_area: self.safe_area(),
            scale: self.scale(setup),
        };
        let previous = SCOPE.with_borrow_mut(|slot| slot.replace(shared));
        Some(UiScope { previous })
    }

    /// After the hooks: the catalog comes back with the text issues its lookups raised.
    pub(crate) fn leave(&mut self, scope: Option<UiScope>) {
        let Some(scope) = scope else { return };
        let shared = SCOPE.with_borrow_mut(|slot| std::mem::replace(slot, scope.previous));
        let Some(mut catalog) = shared.and_then(|shared| shared.catalog) else { return };
        let file = text_path(catalog.locale());
        for issue in catalog.take_issues() {
            self.record(issue.code().wire(), issue.subject(), Some(&file));
        }
        self.catalog = Some(catalog);
    }

    /// The text files' issues for `state().__render.assetIssues`: `(path, code)`, deduplicated.
    pub(crate) fn file_issues(&self) -> Vec<(String, &'static str)> {
        let mut found: Vec<(String, &'static str)> = Vec::new();
        for record in &self.issues {
            let Some(file) = &record.file else { continue };
            let entry = (file.clone(), record.code);
            if !found.contains(&entry) {
                found.push(entry);
            }
        }
        found
    }

    /// `state().volatile.ui`: `{locale, scale, safeArea, issues}`, only with `game.ui`.
    pub(crate) fn volatile_value(&self, setup: &Setup) -> Option<CoreValue> {
        if !setup.registered() {
            return None;
        }
        let mut value = CoreValue::object();
        let locale = self.catalog.as_ref().map(|catalog| catalog.locale().tag().to_owned());
        value.set("locale", locale.map_or(CoreValue::Null, CoreValue::from));
        value.set("scale", CoreValue::from(f64::from(self.scale(setup))));
        value.set("safeArea", CoreValue::Array(self.safe_area().iter().map(|inset| CoreValue::from(f64::from(*inset))).collect()));
        let issues = self.issues.iter().map(|record| {
            let mut entry = CoreValue::object();
            entry.set("code", CoreValue::from(record.code));
            entry.set("subject", CoreValue::from(record.subject.as_str()));
            entry
        });
        value.set("issues", CoreValue::Array(issues.collect()));
        Some(value)
    }
}

/// The locales `game.ui` offers, parsed (install refused any that do not), `xx-pseudo` last when
/// offered.
fn offered(setup: &Setup) -> Vec<Locale> {
    let Some(config) = setup.config() else { return Vec::new() };
    let mut locales: Vec<Locale> = config.locales.iter().filter_map(|tag| Locale::parse(tag)).collect();
    if config.pseudo {
        locales.push(Locale::pseudo());
    }
    locales
}

/// `lang/<locale>.ftl`.
fn text_path(locale: &Locale) -> String {
    format!("{TEXT_FOLDER}/{}.ftl", locale.tag())
}

/// The person's locale choice in a settings file's bytes: `values."ui.language"` when it is a
/// string. A file that does not parse names none (the settings menu reports it).
fn person_locale(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    value.get(SETTINGS_VALUES_KEY)?.get(PERSON_LOCALE_KEY)?.as_str().map(str::to_owned)
}

/// What the hooks of one tick read through [`tr`] and its siblings.
struct Shared {
    catalog: Option<Catalog>,
    reduced_motion: bool,
    safe_area: [f32; 4],
    scale: f32,
}

thread_local! {
    static SCOPE: RefCell<Option<Shared>> = const { RefCell::new(None) };
}

/// The UI scope of one tick (`State::enter` / `State::leave`).
pub(crate) struct UiScope {
    previous: Option<Shared>,
}

/// The text of `key` in the active locale; the key itself when it has none, which records a
/// `text-missing` issue. Outside the update and UI hooks, or without `game.ui`, the key itself.
pub fn tr(key: &str) -> String {
    SCOPE.with_borrow_mut(|slot| match slot.as_mut().and_then(|shared| shared.catalog.as_mut()) {
        Some(catalog) => catalog.tr(key),
        None => key.to_owned(),
    })
}

/// The text of `key` with `args` filled in (`TextArgs::new().num("n", 3).str("name", "Ada")`), as
/// [`tr`].
pub fn tr_args(key: &str, args: &TextArgs) -> String {
    SCOPE.with_borrow_mut(|slot| match slot.as_mut().and_then(|shared| shared.catalog.as_mut()) {
        Some(catalog) => catalog.tr_args(key, args),
        None => key.to_owned(),
    })
}

/// The active locale inside the hooks (`None` outside them or without `game.ui`).
pub fn locale() -> Option<Locale> {
    SCOPE.with_borrow(|slot| slot.as_ref().and_then(|shared| shared.catalog.as_ref().map(|catalog| catalog.locale().clone())))
}

/// Whether the person asked for reduced motion (false outside the hooks).
pub fn reduced_motion() -> bool {
    SCOPE.with_borrow(|slot| slot.as_ref().is_some_and(|shared| shared.reduced_motion))
}

/// The screen's safe area as a margin in egui points (world pixels over the UI scale): zero in a
/// Genex run unless the session emulates one, and outside the hooks.
pub fn safe_area(_ui: &egui::Ui) -> egui::Margin {
    let (insets, scale) = SCOPE.with_borrow(|slot| slot.as_ref().map_or(([0.0; 4], 1.0), |shared| (shared.safe_area, shared.scale)));
    let point = |inset: f32| (inset / scale).round().clamp(0.0, f32::from(i8::MAX)) as i8;
    egui::Margin { left: point(insets[0]), top: point(insets[1]), right: point(insets[2]), bottom: point(insets[3]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settings_file_names_the_person_locale_and_a_hostile_one_names_none() {
        assert_eq!(person_locale(br#"{"format":1,"values":{"ui.language":"fr"}}"#).as_deref(), Some("fr"));
        assert_eq!(person_locale(br#"{"format":1,"values":{"ui.language":3}}"#), None);
        assert_eq!(person_locale(b"not json"), None);
        assert_eq!(person_locale(br#"{"format":1}"#), None);
    }

    #[test]
    fn install_refuses_a_second_ui_a_non_bcp47_locale_and_a_font_for_an_unlisted_locale() {
        let setup = |configs: Vec<UiConfig>| Setup { configs };
        let code = |configs| check(&setup(configs)).map_err(|(code, _)| code);
        assert_eq!(code(vec![UiConfig::new(), UiConfig::new()]), Err(InstallErrorCode::DuplicateUi));
        assert_eq!(code(vec![UiConfig::new().locales(&["en", "not a locale"])]), Err(InstallErrorCode::UiLocaleInvalid));
        assert_eq!(code(vec![UiConfig::new().locales(&["en", "xx-pseudo"])]), Err(InstallErrorCode::UiLocaleInvalid));
        assert_eq!(code(vec![UiConfig::new().locales(&["en"]).font("ja", "fonts/ja.ttf")]), Err(InstallErrorCode::UiLocaleInvalid));
        assert_eq!(code(vec![UiConfig::new().locales(&["en", "fr-CA"]).font("fr-CA", "f.ttf")]), Ok(()));
    }
}
