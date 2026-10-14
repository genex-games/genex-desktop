//! The soft keyboard between winit and the game: genex-hud's [`ImeBridge`] fed from winit's key
//! events, and each tick's batch injected as the facade's committed text and editing keys.
//!
//! Both phones reach the shell through winit: on iOS winit's view is a `UIKeyInput`, so
//! `set_ime_allowed(true)` makes it first responder and the keyboard's `insertText:` and
//! `deleteBackward` arrive as key events; on Android `set_ime_allowed` shows the soft input and its
//! keys arrive the same way (a GameActivity build also hands its InputConnection's edits to
//! winit; the NativeActivity build has no InputConnection bridge, so composed, autocorrected and
//! swipe text does not reach the game there yet). [`key_news`] reads one such event (a gamepad
//! button, an arrow, or typing); [`batch_input`] is what one tick carries, and [`TypingFeed`]
//! hands the game one batch per tick.
//!
//! The shell raises the keyboard from the HUD's focus: the game handle's `keyboard_wanted`
//! (genex-hud's on the game's egui context) holds while a text field has focus.

use crate::mobile::gamepad::PhoneButton;
use genex::{Input, Key};
use genex_hud::{EditKey, ImeBatch, ImeBridge, TextAction};
use genex_platform_web::GameHandle;
use winit::keyboard::{Key as WinitKey, KeyCode, NamedKey, NativeKeyCode, PhysicalKey};

/// What one key event is to the shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyNews {
    /// A gamepad button the platform delivers as a key (Android's `KEYCODE_BUTTON_*`): pressed
    /// or released.
    Pad(PhoneButton, bool),
    /// An arrow key held or released: a hardware keyboard's, or an Android d-pad's, which winit
    /// names as the arrows.
    Arrow(Key, bool),
    /// The soft keyboard typed (pressed keys only).
    Typed(TextAction),
}

/// The facade arrow a physical key is, if it is one.
fn arrow_of(physical: &PhysicalKey) -> Option<Key> {
    match physical {
        PhysicalKey::Code(KeyCode::ArrowUp) => Some(Key::ArrowUp),
        PhysicalKey::Code(KeyCode::ArrowDown) => Some(Key::ArrowDown),
        PhysicalKey::Code(KeyCode::ArrowLeft) => Some(Key::ArrowLeft),
        PhysicalKey::Code(KeyCode::ArrowRight) => Some(Key::ArrowRight),
        _ => None,
    }
}

/// What a key event (`physical`, `logical`, its `text`, whether `pressed`) is, with `pad_key` the
/// platform's reading of a key winit could not name; `None` for a key the game does not hear.
pub fn key_news(
    physical: &PhysicalKey,
    logical: &WinitKey,
    text: Option<&str>,
    pressed: bool,
    pad_key: fn(&NativeKeyCode) -> Option<PhoneButton>,
) -> Option<KeyNews> {
    if let PhysicalKey::Unidentified(code) = physical
        && let Some(button) = pad_key(code)
    {
        return Some(KeyNews::Pad(button, pressed));
    }
    if let Some(arrow) = arrow_of(physical) {
        return Some(KeyNews::Arrow(arrow, pressed));
    }
    text_action(logical, text).filter(|_| pressed).map(KeyNews::Typed)
}

/// Hands the bridge's batches to the game one tick at a time: a batch is injected only once the
/// one before it was consumed by a tick, so two batches never merge into one tick (where egui
/// would apply the second's key before the first's text). A frame worth no tick (the first after
/// a resume, or a short frame on a fast panel) carries the batch in flight to the next.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TypingFeed {
    in_flight: bool,
}

impl TypingFeed {
    /// One live frame of `frame_ms`: the next batch injected unless one still waits for a tick,
    /// then the game advanced; answers the ticks run.
    pub fn live_frame(&mut self, bridge: &mut ImeBridge, game: &mut dyn GameHandle, frame_ms: f64) -> u32 {
        if !self.in_flight
            && let Some(batch) = bridge.take()
        {
            game.inject(batch_input(&batch));
            self.in_flight = true;
        }
        let ticks = game.advance_live(frame_ms);
        if ticks > 0 {
            self.in_flight = false;
        }
        ticks
    }
}

/// The soft keyboard's action in one pressed key event (`logical` and its `text`), if it types.
pub fn text_action(logical: &WinitKey, text: Option<&str>) -> Option<TextAction> {
    match logical {
        WinitKey::Named(NamedKey::Backspace) => Some(TextAction::Key(EditKey::Backspace)),
        WinitKey::Named(NamedKey::Enter) => Some(TextAction::Key(EditKey::Enter)),
        _ => text.filter(|text| !text.is_empty()).map(|text| TextAction::Insert(text.to_owned())),
    }
}

/// The facade input one batch is: its editing keys tapped, then its text.
pub fn batch_input(batch: &ImeBatch) -> Input {
    let keys = batch.keys.iter().map(|key| match key {
        EditKey::Backspace => Input::key_tap(Key::Backspace),
        EditKey::Enter => Input::key_tap(Key::Enter),
    });
    let input = keys.fold(Input::default(), Input::and);
    if batch.text.is_empty() { input } else { input.and(Input::text(&batch.text)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_hud::{ImeBridge, NATIVE_TEXT_MAX_UNITS};
    use winit::keyboard::SmolStr;

    fn character(text: &str) -> WinitKey {
        WinitKey::Character(SmolStr::new(text))
    }

    #[test]
    fn typed_characters_backspace_and_return_become_text_actions() {
        assert_eq!(text_action(&character("a"), Some("a")), Some(TextAction::Insert("a".into())));
        assert_eq!(text_action(&WinitKey::Named(NamedKey::Backspace), None), Some(TextAction::Key(EditKey::Backspace)));
        assert_eq!(text_action(&WinitKey::Named(NamedKey::Enter), Some("\r")), Some(TextAction::Key(EditKey::Enter)));
        assert_eq!(text_action(&WinitKey::Named(NamedKey::Shift), None), None);
        assert_eq!(text_action(&character("a"), Some("")), None);
    }

    #[test]
    fn a_batch_taps_its_keys_and_commits_its_text() {
        let batch = ImeBatch { keys: vec![EditKey::Backspace, EditKey::Enter], text: "hé".into() };
        let input = batch_input(&batch);
        assert_eq!(input.injection().tap, vec!["Backspace".to_owned(), "Enter".to_owned()]);
        assert_eq!(input.injection().text, "hé".as_bytes());
        assert_eq!(batch_input(&ImeBatch::default()), Input::default());
    }

    fn no_pad(_: &NativeKeyCode) -> Option<PhoneButton> {
        None
    }

    fn pad_a(code: &NativeKeyCode) -> Option<PhoneButton> {
        (*code == NativeKeyCode::Android(96)).then_some(PhoneButton::A)
    }

    #[test]
    fn an_arrow_or_a_d_pad_key_reaches_the_game_as_an_arrow_held_and_released() {
        let up = PhysicalKey::Code(KeyCode::ArrowUp);
        let named = WinitKey::Named(NamedKey::ArrowUp);
        assert_eq!(key_news(&up, &named, None, true, no_pad), Some(KeyNews::Arrow(Key::ArrowUp, true)));
        assert_eq!(key_news(&up, &named, None, false, no_pad), Some(KeyNews::Arrow(Key::ArrowUp, false)));
        let left = PhysicalKey::Code(KeyCode::ArrowLeft);
        assert_eq!(key_news(&left, &WinitKey::Named(NamedKey::ArrowLeft), None, true, no_pad), Some(KeyNews::Arrow(Key::ArrowLeft, true)));
    }

    #[test]
    fn a_pad_button_a_letter_and_a_released_letter_are_told_apart() {
        let button = PhysicalKey::Unidentified(NativeKeyCode::Android(96));
        assert_eq!(key_news(&button, &WinitKey::Unidentified(winit::keyboard::NativeKey::Android(96)), None, false, pad_a), Some(KeyNews::Pad(PhoneButton::A, false)));
        let a = PhysicalKey::Code(KeyCode::KeyA);
        assert_eq!(key_news(&a, &character("a"), Some("a"), true, pad_a), Some(KeyNews::Typed(TextAction::Insert("a".into()))));
        assert_eq!(key_news(&a, &character("a"), Some("a"), false, pad_a), None, "a release types nothing");
    }

    #[derive(Default)]
    struct Field {
        text: String,
    }

    /// A game whose world is a text field: a tick applies its Backspace, then its text (egui's order).
    fn field_game(start: &str) -> genex::Runtime<Field> {
        let mut game = genex::Game::new(Field::default());
        let start = start.to_owned();
        game.on_reset(move |sim, _, _, _| sim.world.text.clone_from(&start));
        game.on_update(|sim, ctx| {
            if ctx.keys.pressed(Key::Backspace) {
                sim.world.text.pop();
            }
            sim.world.text.push_str(ctx.text);
        });
        game.probe("text", |sim| genex::json!(sim.world.text));
        let mut runtime = genex::Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        runtime
    }

    /// Run live frames of `frames` ms through the feed, as the shell does.
    fn feed(runtime: &mut genex::Runtime<Field>, bridge: &mut ImeBridge, frames: &[f64]) {
        let mut feed = TypingFeed::default();
        for frame_ms in frames {
            feed.live_frame(bridge, runtime, *frame_ms);
        }
    }

    #[test]
    fn a_frame_worth_no_tick_never_merges_two_batches() {
        let mut runtime = field_game("xy");
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Insert("a".into()));
        bridge.push(TextAction::Key(EditKey::Backspace));
        // The first frame after a resume is worth no tick; then one tick per frame.
        feed(&mut runtime, &mut bridge, &[0.0, 0.0, genex::FIXED_STEP_MS, genex::FIXED_STEP_MS, genex::FIXED_STEP_MS]);
        assert_eq!(runtime.probes()["text"], genex::json!("xy"), "'a' typed, then deleted");
    }

    #[test]
    fn three_backspaces_delete_three_characters() {
        let mut runtime = field_game("abcd");
        let mut bridge = ImeBridge::default();
        for _ in 0..3 {
            bridge.push(TextAction::Key(EditKey::Backspace));
        }
        feed(&mut runtime, &mut bridge, &[genex::FIXED_STEP_MS; 4]);
        assert_eq!(runtime.probes()["text"], genex::json!("a"));
    }

    #[derive(Default)]
    struct Typed {
        text: String,
        backspaces: u32,
    }

    #[test]
    fn the_game_receives_the_keyboard_s_text_bounded_by_the_native_cap() {
        let mut game = genex::Game::new(Typed::default());
        game.on_update(|sim, ctx| {
            sim.world.text.push_str(ctx.text);
            sim.world.backspaces += u32::from(ctx.keys.pressed(Key::Backspace));
        });
        game.probe("typed", |sim| genex::json!([sim.world.text.encode_utf16().count(), sim.world.backspaces]));
        let mut runtime = genex::Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        let mut bridge = ImeBridge::default();
        bridge.push(TextAction::Key(EditKey::Backspace));
        bridge.push(TextAction::Insert("x".repeat(NATIVE_TEXT_MAX_UNITS + 10)));
        while let Some(batch) = bridge.take() {
            runtime.inject(batch_input(&batch));
            runtime.step(genex::FIXED_STEP_MS);
        }
        assert_eq!(runtime.probes()["typed"], genex::json!([NATIVE_TEXT_MAX_UNITS, 1]));
        assert_eq!(bridge.dropped_units(), 10);
    }
}
