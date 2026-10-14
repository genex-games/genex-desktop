//! The soft-keyboard bridge (M5.3): what a phone's keyboard (UIKit's text input on iOS, the soft
//! input on Android, both reaching the shell as winit key events) types, turned into the
//! committed text and editing keys the HUD's egui reads on a tick, and whether the keyboard should
//! be up.
//!
//! - Typing arrives as [`TextAction`]s. Line breaks become `Enter`, a backspace character becomes
//!   `Backspace`, other control characters are dropped. Everything typed while the game has not
//!   taken it yet is bounded: at most [`NATIVE_TEXT_MAX_UNITS`] UTF-16 units of text (the host's
//!   `NATIVE_TEXT_MAX_UNITS` and genex-core's `MAX_TEXT_UNITS`, so a phone never carries more than
//!   a Studio injection may) and [`MAX_EDIT_KEYS`] editing keys; a character that does not fit
//!   whole is dropped and counted, never split.
//! - Order is kept across ticks: a batch carries at most one editing key, before its text. The
//!   facade's taps are a set, so a second key in one tick would collapse into the first (three
//!   Backspaces deleting one character) or be reordered (Enter before Backspace); and egui applies
//!   a tick's keys before its text, so a key typed after text waits for the next batch
//!   ([`ImeBridge::take`]). The shell hands the game one batch per tick.
//! - The keyboard is shown while a text field has egui's focus ([`keyboard_wanted`]) and hidden
//!   when it loses it ([`ImeBridge::sync`]); a keyboard the person dismissed stays down until the
//!   focus leaves and comes back, or they touch the screen while the field keeps it
//!   ([`ImeBridge::touched`]), so the shell never pops it up again on its own. One the platform
//!   hid (the app was suspended) comes back with the next sync ([`ImeBridge::hidden_by_platform`]).

use genex_core::input::{MAX_INJECTED_KEYS, MAX_TEXT_UNITS};
use std::collections::VecDeque;

/// Committed text the soft keyboard may hold for the game, in UTF-16 units: the host's
/// `NATIVE_TEXT_MAX_UNITS` (`src/shared/native-contract.ts`), genex-core's `MAX_TEXT_UNITS`.
pub const NATIVE_TEXT_MAX_UNITS: usize = MAX_TEXT_UNITS;
/// Editing keys the soft keyboard may hold for the game: genex-core's per-injection key cap.
pub const MAX_EDIT_KEYS: usize = MAX_INJECTED_KEYS;

/// An editing key the soft keyboard sends, by its DOM `code` (egui's widgets act on these).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKey {
    /// Delete the character before the cursor.
    Backspace,
    /// Return / Go / Done.
    Enter,
}

impl EditKey {
    /// The key's DOM `code`, as the facade's `Key` and the HUD's input name it.
    pub const fn code(self) -> &'static str {
        match self {
            EditKey::Backspace => "Backspace",
            EditKey::Enter => "Enter",
        }
    }
}

/// One thing the soft keyboard did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextAction {
    /// Committed text (a key, a word from autocorrect, a paste).
    Insert(String),
    /// An editing key.
    Key(EditKey),
    /// The person put the keyboard away (Android's back, iPad's hide key).
    Dismissed,
}

/// What the shell asks the platform to do with the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyboardCall {
    /// Show it (winit's `set_ime_allowed(true)`).
    Show,
    /// Hide it (`set_ime_allowed(false)`).
    Hide,
}

/// One tick's worth of typing: its editing key applies first, then its text (egui's order).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImeBatch {
    /// Editing keys: at most one from the bridge (a tick's taps are a set).
    pub keys: Vec<EditKey>,
    /// Committed text.
    pub text: String,
}

impl ImeBatch {
    /// Whether the batch carries nothing.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty() && self.text.is_empty()
    }
}

/// Whether the HUD wants the keyboard: a text field has egui's focus.
pub fn keyboard_wanted(ctx: &egui::Context) -> bool {
    ctx.text_edit_focused()
}

/// Whether a HUD widget holds the keyboard: any widget has egui's focus (reached with Tab, or a
/// text field tapped), so its keys (Space, Enter, arrows) are the widget's, not the game's, until
/// Escape or a click elsewhere gives the focus back.
pub fn keys_taken(ctx: &egui::Context) -> bool {
    ctx.egui_wants_keyboard_input()
}

/// The soft keyboard between the platform and the game.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ImeBridge {
    pending: VecDeque<ImeBatch>,
    units: usize,
    keys: usize,
    dropped_units: usize,
    dropped_keys: usize,
    shown: bool,
    dismissed: bool,
}

impl ImeBridge {
    /// Take in one thing the keyboard did.
    pub fn push(&mut self, action: TextAction) {
        match action {
            TextAction::Insert(text) => self.insert(&text),
            TextAction::Key(key) => self.key(key),
            TextAction::Dismissed => {
                self.shown = false;
                self.dismissed = true;
            }
        }
    }

    fn insert(&mut self, text: &str) {
        for ch in text.chars() {
            match ch {
                '\n' | '\r' => self.key(EditKey::Enter),
                '\u{8}' => self.key(EditKey::Backspace),
                ch if ch.is_control() => {}
                ch => self.character(ch),
            }
        }
    }

    fn character(&mut self, ch: char) {
        let units = ch.len_utf16();
        if self.units + units > NATIVE_TEXT_MAX_UNITS {
            self.dropped_units += units;
            return;
        }
        self.units += units;
        self.last_batch().text.push(ch);
    }

    fn key(&mut self, key: EditKey) {
        if self.keys >= MAX_EDIT_KEYS {
            self.dropped_keys += 1;
            return;
        }
        self.keys += 1;
        // One key per tick: a tick's taps are a set, so a second key would collapse into the first
        // or be reordered; and a key typed after text belongs to the next tick, since egui applies
        // keys before text.
        let starts_batch = self.pending.back().is_some_and(|batch| !batch.is_empty());
        if starts_batch {
            self.pending.push_back(ImeBatch::default());
        }
        self.last_batch().keys.push(key);
    }

    fn last_batch(&mut self) -> &mut ImeBatch {
        if self.pending.is_empty() {
            self.pending.push_back(ImeBatch::default());
        }
        let last = self.pending.len() - 1;
        &mut self.pending[last]
    }

    /// The next tick's typing, if any.
    pub fn take(&mut self) -> Option<ImeBatch> {
        let batch = self.pending.pop_front().filter(|batch| !batch.is_empty())?;
        self.units -= batch.text.encode_utf16().count();
        self.keys -= batch.keys.len();
        Some(batch)
    }

    /// UTF-16 units of text dropped because the game had not taken what came before.
    pub fn dropped_units(&self) -> usize {
        self.dropped_units
    }

    /// Editing keys dropped for the same reason.
    pub fn dropped_keys(&self) -> usize {
        self.dropped_keys
    }

    /// Whether the keyboard is up, as far as the bridge asked for it.
    pub fn shown(&self) -> bool {
        self.shown
    }

    /// The platform put the keyboard away on its own (the app was suspended): it is no longer up,
    /// and the next [`ImeBridge::sync`] raises it again while a text field has focus.
    pub fn hidden_by_platform(&mut self) {
        self.shown = false;
    }

    /// A finger came down while the HUD's wish is `wanted`: with a text field focused, the keyboard
    /// is asked for again (the person may have put it away with a key the shell never hears of,
    /// such as Android's back) and a dismissal is forgotten. Answers the call to make.
    pub fn touched(&mut self, wanted: bool) -> Option<KeyboardCall> {
        if !wanted {
            return None;
        }
        self.dismissed = false;
        self.shown = true;
        Some(KeyboardCall::Show)
    }

    /// Follow the HUD's wish (`wanted`, from [`keyboard_wanted`]); answers the call to make, only
    /// when something changes. A keyboard the person dismissed stays down until `wanted` drops.
    pub fn sync(&mut self, wanted: bool) -> Option<KeyboardCall> {
        if !wanted {
            self.dismissed = false;
        }
        let show = wanted && !self.dismissed;
        if show == self.shown {
            return None;
        }
        self.shown = show;
        Some(if show { KeyboardCall::Show } else { KeyboardCall::Hide })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(bridge: &mut ImeBridge) -> Vec<ImeBatch> {
        std::iter::from_fn(|| bridge.take()).collect()
    }

    #[test]
    fn the_cap_is_the_hosts_native_text_cap() {
        assert_eq!(NATIVE_TEXT_MAX_UNITS, 256);
    }

    #[test]
    fn typed_text_is_bounded_by_native_text_max_units_and_never_split() {
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Insert("a".repeat(NATIVE_TEXT_MAX_UNITS - 1)));
        // An emoji is two UTF-16 units: one unit is left, so it is dropped whole.
        bridge.push(TextAction::Insert("\u{1F41F}".into()));
        bridge.push(TextAction::Insert("b".into()));
        bridge.push(TextAction::Insert("c".into()));
        assert_eq!(bridge.dropped_units(), 3);
        let batches = drain(&mut bridge);
        assert_eq!(batches.len(), 1);
        let text = &batches[0].text;
        assert_eq!(text.encode_utf16().count(), NATIVE_TEXT_MAX_UNITS);
        assert!(text.ends_with('b'));
        assert!(!text.contains('\u{1F41F}'));
    }

    #[test]
    fn a_taken_batch_frees_its_room() {
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Insert("x".repeat(NATIVE_TEXT_MAX_UNITS)));
        bridge.push(TextAction::Insert("y".into()));
        assert_eq!(bridge.take().map(|batch| batch.text.len()), Some(NATIVE_TEXT_MAX_UNITS));
        bridge.push(TextAction::Insert("\u{1F41F}".into()));
        assert_eq!(bridge.take(), Some(ImeBatch { keys: vec![], text: "\u{1F41F}".into() }));
        assert_eq!(bridge.dropped_units(), 1);
    }

    #[test]
    fn editing_keys_are_bounded_too() {
        let mut bridge = ImeBridge::default();
        for _ in 0..MAX_EDIT_KEYS + 5 {
            bridge.push(TextAction::Key(EditKey::Backspace));
        }
        assert_eq!(bridge.dropped_keys(), 5);
        let batches = drain(&mut bridge);
        assert_eq!(batches.iter().map(|batch| batch.keys.len()).sum::<usize>(), MAX_EDIT_KEYS);
    }

    #[test]
    fn line_breaks_and_backspace_characters_become_keys_and_other_controls_are_dropped() {
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Insert("\u{8}hi\u{7}\r".into()));
        let batches = drain(&mut bridge);
        assert_eq!(
            batches,
            vec![
                ImeBatch { keys: vec![EditKey::Backspace], text: "hi".into() },
                ImeBatch { keys: vec![EditKey::Enter], text: String::new() },
            ]
        );
    }

    #[test]
    fn a_key_typed_after_text_waits_for_the_next_tick() {
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Key(EditKey::Backspace));
        bridge.push(TextAction::Insert("ab".into()));
        bridge.push(TextAction::Key(EditKey::Backspace));
        bridge.push(TextAction::Insert("c".into()));
        assert_eq!(bridge.take(), Some(ImeBatch { keys: vec![EditKey::Backspace], text: "ab".into() }));
        assert_eq!(bridge.take(), Some(ImeBatch { keys: vec![EditKey::Backspace], text: "c".into() }));
        assert_eq!(bridge.take(), None);
    }

    #[test]
    fn each_editing_key_gets_a_tick_of_its_own_in_the_order_typed() {
        let mut bridge = ImeBridge::default();
        for _ in 0..3 {
            bridge.push(TextAction::Key(EditKey::Backspace));
        }
        bridge.push(TextAction::Key(EditKey::Enter));
        bridge.push(TextAction::Key(EditKey::Backspace));
        let keys: Vec<Vec<EditKey>> = drain(&mut bridge).into_iter().map(|batch| batch.keys).collect();
        use EditKey::{Backspace, Enter};
        assert_eq!(keys, vec![vec![Backspace], vec![Backspace], vec![Backspace], vec![Enter], vec![Backspace]]);
    }

    #[test]
    fn a_keyboard_the_platform_hid_comes_back_and_a_touch_reopens_a_dismissed_one() {
        let mut bridge = ImeBridge::default();
        assert_eq!(bridge.sync(true), Some(KeyboardCall::Show));
        bridge.hidden_by_platform();
        assert_eq!(bridge.sync(true), Some(KeyboardCall::Show), "back after a suspend while the field keeps focus");
        bridge.push(TextAction::Dismissed);
        assert_eq!(bridge.sync(true), None);
        assert_eq!(bridge.touched(true), Some(KeyboardCall::Show), "a touch on the focused field reopens it");
        assert!(bridge.shown());
        assert_eq!(bridge.sync(true), None);
        assert_eq!(bridge.touched(false), None, "no field focused: a touch asks for nothing");
    }

    #[test]
    fn edit_keys_are_named_by_dom_code() {
        assert_eq!(EditKey::Backspace.code(), "Backspace");
        assert_eq!(EditKey::Enter.code(), "Enter");
    }

    #[test]
    fn the_keyboard_follows_the_focus_and_a_dismissal_holds_until_the_focus_leaves() {
        let mut bridge = ImeBridge::default();
        assert_eq!(bridge.sync(false), None);
        assert_eq!(bridge.sync(true), Some(KeyboardCall::Show));
        assert_eq!(bridge.sync(true), None);
        bridge.push(TextAction::Dismissed);
        assert!(!bridge.shown());
        assert_eq!(bridge.sync(true), None, "the person put it away: not popped up again");
        assert_eq!(bridge.sync(false), None);
        assert_eq!(bridge.sync(true), Some(KeyboardCall::Show), "a new focus brings it back");
        assert_eq!(bridge.sync(false), Some(KeyboardCall::Hide));
    }

    #[test]
    fn the_keyboard_is_wanted_only_while_a_text_field_has_focus() {
        let ctx = egui::Context::default();
        let mut text = String::new();
        let mut field = None;
        let pass = |ctx: &egui::Context, text: &mut String, field: &mut Option<egui::Response>| {
            let mut output = ctx.run_ui(egui::RawInput::default(), |ui| {
                *field = Some(ui.text_edit_singleline(text));
            });
            // The font atlas upload is not painted here.
            output.textures_delta.clear();
        };
        pass(&ctx, &mut text, &mut field);
        assert!(!keyboard_wanted(&ctx));
        if let Some(field) = &field {
            field.request_focus();
        }
        pass(&ctx, &mut text, &mut field);
        assert!(keyboard_wanted(&ctx));
    }
}
