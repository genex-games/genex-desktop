//! Keyed widgets (G6 gameplay UI, UIS-4): a stable key a check or play script finds a widget by,
//! written as the widget's AccessKit `author_id`, so it survives relabelling and localisation.
//!
//! A key is `[a-z0-9._-]{1,64}`. An invalid key, or a key a pass already used, is never written;
//! it becomes a UI issue (`ui-key-invalid`, `ui-key-duplicate`) the runtime lists in
//! `volatile.ui.issues`.

use egui::Id;
use std::collections::BTreeSet;

/// The longest key, in bytes.
pub const UI_KEY_MAX: usize = 64;
/// The most issues one pass records; later ones are dropped.
pub const UI_ISSUES_MAX: usize = 16;

/// Where a context keeps the current pass's keys and issues.
const LEDGER_ID: &str = "genex-ui.keys";
/// What a key's egui id is derived from.
const KEY_ID_SALT: &str = "genex-ui.key";

/// A UI issue's code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum UiIssueCode {
    /// The key is empty, longer than [`UI_KEY_MAX`] or outside `[a-z0-9._-]`.
    KeyInvalid,
    /// The key was already used in the same pass.
    KeyDuplicate,
}

impl UiIssueCode {
    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            UiIssueCode::KeyInvalid => "ui-key-invalid",
            UiIssueCode::KeyDuplicate => "ui-key-duplicate",
        }
    }
}

/// One UI issue: its code and the key (cut to [`UI_KEY_MAX`] characters).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiIssue {
    /// What went wrong.
    pub code: UiIssueCode,
    /// The key the widget asked for.
    pub key: String,
}

/// A valid widget key.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct UiKey(String);

impl UiKey {
    /// `text` as a key, or `None` when it is empty, too long or has a character outside
    /// `[a-z0-9._-]`.
    pub fn new(text: &str) -> Option<UiKey> {
        let valid = !text.is_empty() && text.len() <= UI_KEY_MAX && text.bytes().all(is_key_byte);
        valid.then(|| UiKey(text.to_owned()))
    }

    /// The key's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The egui id a keyed widget uses, the same on every pass and destination.
    pub fn id(&self) -> Id {
        Id::new((KEY_ID_SALT, self.0.as_str()))
    }
}

fn is_key_byte(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
}

/// Give a widget a stable key: `response.key(ui, "pause.resume")`.
pub trait Keyed {
    /// Write `key` as this widget's AccessKit `author_id`; an invalid or repeated key becomes a UI
    /// issue instead.
    #[must_use]
    fn key(self, ui: &egui::Ui, key: &str) -> Self;
}

impl Keyed for egui::Response {
    fn key(self, ui: &egui::Ui, key: &str) -> egui::Response {
        key_widget(ui.ctx(), self.id, key);
        self
    }
}

/// Write `key` as the AccessKit `author_id` of the widget `id` in the current pass. Answers whether
/// it was written: an invalid key or one the pass already used records an issue instead. With
/// AccessKit off the key is still checked, and nothing is written.
pub fn key_widget(ctx: &egui::Context, id: Id, key: &str) -> bool {
    let pass = ctx.cumulative_pass_nr();
    let accepted = ctx.data_mut(|data| {
        let ledger = data.get_temp_mut_or_default::<KeyLedger>(Id::new(LEDGER_ID));
        ledger.start(pass);
        ledger.admit(key)
    });
    if accepted {
        ctx.accesskit_node_builder(id, |node| node.set_author_id(key.to_owned()));
    }
    accepted
}

/// The UI issues of the last finished pass, in the order they happened (at most
/// [`UI_ISSUES_MAX`]). Empty before any pass keyed a widget, and after a pass with no issue.
pub fn ui_issues(ctx: &egui::Context) -> Vec<UiIssue> {
    let Some(ledger) = ctx.data(|data| data.get_temp::<KeyLedger>(Id::new(LEDGER_ID))) else {
        return Vec::new();
    };
    if ledger.pass.map(|pass| pass + 1) != Some(ctx.cumulative_pass_nr()) {
        return Vec::new();
    }
    ledger.issues
}

/// The keys and issues of one pass.
#[derive(Clone, Debug, Default)]
struct KeyLedger {
    pass: Option<u64>,
    keys: BTreeSet<UiKey>,
    issues: Vec<UiIssue>,
}

impl KeyLedger {
    fn start(&mut self, pass: u64) {
        if self.pass != Some(pass) {
            *self = KeyLedger { pass: Some(pass), ..KeyLedger::default() };
        }
    }

    fn admit(&mut self, key: &str) -> bool {
        let Some(valid) = UiKey::new(key) else {
            self.record(UiIssueCode::KeyInvalid, key);
            return false;
        };
        if !self.keys.insert(valid) {
            self.record(UiIssueCode::KeyDuplicate, key);
            return false;
        }
        true
    }

    fn record(&mut self, code: UiIssueCode, key: &str) {
        if self.issues.len() < UI_ISSUES_MAX {
            self.issues.push(UiIssue { code, key: key.chars().take(UI_KEY_MAX).collect() });
        }
    }
}
