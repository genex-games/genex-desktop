//! Rebinding, swapping, reset, listen-mode capture and the bindings file's round trip (IN-2).

use genex_core::input::{Injection, InputMerger, PadState, TickInput};
use genex_input::access::{Access, HoldMode};
use genex_input::binding::{ActionKind, Binding, KeyCode, PadAxis, PadButton, Sign, Stick};
use genex_input::blob::BLOB_FORMAT;
use genex_input::capture::{Capture, CaptureStep};
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ActionMap, Context};
use genex_input::ui::{UI, UiAction};

const PLAY: ContextId = ContextId::new("play");
const MENU: ContextId = ContextId::new("menu");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");
const FIRE: ActionId = ActionId::new("fire");
const SPRINT: ActionId = ActionId::new("sprint");
const PAUSE: ActionId = ActionId::new("pause");

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn game() -> ActionMap {
    let map = ActionMap::new()
        .context(
            Context::new(PLAY, 0)
                .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
                .button(JUMP, &[key("Space"), Binding::Pad(PadButton::South)])
                .button(FIRE, &[key("KeyF"), Binding::Pad(PadButton::RightTrigger)])
                .button(SPRINT, &[key("ShiftLeft")]),
        )
        .context(Context::new(MENU, 5).button(PAUSE, &[key("KeyP")]));
    map.validate().expect("the game map validates");
    map
}

#[test]
fn rebinding_onto_a_key_another_action_reads_refuses_with_the_clash_and_swap_succeeds() {
    let mut map = game();
    let before = map.clone();
    let refused = map.rebind(JUMP, 0, key("KeyW")).expect_err("move reads KeyW");
    assert_eq!(refused.code, InputErrorCode::BindingConflict);
    assert_eq!(refused.clash, Some(MOVE));
    assert_eq!(map, before, "a refused rebind changes nothing");

    let holder = map.rebind_swap(JUMP, 0, key("KeyW")).expect("the conflict prompt's swap");
    assert_eq!(holder, Some(MOVE));
    assert_eq!(map.bindings(JUMP)[0], key("KeyW"));
    assert_eq!(map.bindings(MOVE)[0].wire(), "keys4:Space,KeyS,KeyA,KeyD", "move takes jump's old key in W's place");
    map.validate().expect("still valid");

    let mut map = game();
    map.swap((JUMP, 0), (FIRE, 0)).expect("two button slots swap");
    assert_eq!(map.bindings(JUMP)[0], key("KeyF"));
    assert_eq!(map.bindings(FIRE)[0], key("Space"));
    let mismatch = map.swap((JUMP, 0), (MOVE, 0)).expect_err("keys4 cannot drive a button");
    assert_eq!(mismatch.code, InputErrorCode::BindingMismatch);
}

#[test]
fn rebinding_to_escape_is_reserved_outside_the_ui_context() {
    let mut map = game();
    let before = map.clone();
    let refused = map.rebind(JUMP, 0, key("Escape")).expect_err("Escape is the system menu's");
    assert_eq!(refused.code, InputErrorCode::BindingReserved);
    let home = map.rebind(JUMP, 1, Binding::Pad(PadButton::Home)).expect_err("home is the system's");
    assert_eq!(home.code, InputErrorCode::BindingReserved);
    assert_eq!(map, before);
    map.rebind(UiAction::CANCEL, 1, Binding::Pad(PadButton::Select)).expect("the ui context rebinds freely");
    assert_eq!(map.context_of(UiAction::CANCEL), Some(UI));
}

#[test]
fn rebind_appends_one_past_the_end_and_refuses_kinds_and_unknown_actions() {
    let mut map = game();
    map.rebind(SPRINT, 1, Binding::Pad(PadButton::LeftStickPress)).expect("append");
    assert_eq!(map.bindings(SPRINT).len(), 2);
    let gap = map.rebind(SPRINT, 5, key("KeyZ")).expect_err("no slot 5");
    assert_eq!(gap.code, InputErrorCode::ActionInvalid);
    let ghost = map.rebind(ActionId::new("ghost"), 0, key("KeyZ")).expect_err("not declared");
    assert_eq!(ghost.code, InputErrorCode::ActionInvalid);
    let kind = map.rebind(JUMP, 0, Binding::Stick(Stick::Right)).expect_err("a stick on a button");
    assert_eq!(kind.code, InputErrorCode::BindingMismatch);
}

#[test]
fn reset_restores_the_games_bindings_and_default_access() {
    let mut map = game();
    let pristine = map.clone();
    map.rebind(JUMP, 0, key("KeyJ")).expect("rebind");
    map.set_access(Access { swap_sticks: true, ..Access::default() }).expect("in range");
    assert_ne!(map, pristine);
    map.reset();
    assert_eq!(map, pristine);
    assert_eq!(map.digest(), pristine.digest());
}

#[test]
fn apply_blob_of_to_blob_gives_an_equal_digest() {
    let mut map = game();
    map.rebind(JUMP, 0, key("KeyJ")).expect("rebind");
    map.rebind(FIRE, 1, Binding::PadAxis(PadAxis::RightY, Sign::Positive)).expect("rebind");
    let mut access = Access::default();
    access.hold_mode.insert(SPRINT, HoldMode::Toggle);
    access.stick_dead_zone = [0.2, 0.1];
    access.trigger_press = 0.6;
    access.trigger_release = 0.4;
    access.invert_y = [false, true];
    access.slow_press_percent = 150;
    map.set_access(access).expect("in range");
    let blob = map.to_blob();
    let text = String::from_utf8(blob.clone()).expect("UTF-8");
    assert!(text.contains(BLOB_FORMAT), "{text}");
    assert!(text.contains("\"jump\":[\"key:KeyJ\",\"pad:south\"]"), "{text}");
    assert!(!text.contains("\"sprint\":["), "untouched actions are not written: {text}");

    let mut fresh = game();
    assert_ne!(fresh.digest(), map.digest());
    let report = fresh.apply_blob(&blob).expect("its own blob applies");
    assert!(report.stale.is_empty() && report.problem().is_none());
    assert_eq!(fresh.digest(), map.digest());
    assert_eq!(fresh.to_blob(), blob, "the blob is canonical");
    assert_eq!(fresh, map);
    assert_eq!(map.digest(), genex_core::digest::fnv1a64(&blob), "the digest is FNV-1a 64 of the blob");
}

#[test]
fn a_blob_with_rows_for_a_removed_action_applies_the_rest_and_reports_stale() {
    let mut map = game();
    let blob = br#"{"format":"genex-input/1","bindings":{"dash":["key:KeyX"],"jump":["key:KeyJ"]},"access":{"holdMode":{"crouch":"toggle"}}}"#;
    let report = map.apply_blob(blob).expect("the rest applies");
    assert_eq!(map.bindings(JUMP), &[key("KeyJ")]);
    assert_eq!(report.stale, vec!["dash".to_owned(), "crouch".to_owned()]);
    let problem = report.problem().expect("stale is reported");
    assert_eq!(problem.code, InputErrorCode::BindingsStale);
}

fn tick_of(merger: &mut InputMerger, injection: Injection) -> TickInput {
    merger.inject(&injection);
    merger.next_tick()
}

fn pad_with(edit: impl Fn(&mut PadState)) -> Injection {
    let mut pad = PadState { connected: true, ..PadState::default() };
    edit(&mut pad);
    Injection { pads: vec![(0, pad)], ..Injection::default() }
}

#[test]
fn capture_takes_the_next_key_pad_button_or_half_axis_and_escape_cancels() {
    let mut merger = InputMerger::default();
    let mut capture = Capture::new(ActionKind::Button);
    assert_eq!(capture.feed(&tick_of(&mut merger, Injection::default())), CaptureStep::Waiting);
    let tap = Injection { tap: vec!["KeyK".to_owned()], ..Injection::default() };
    assert_eq!(capture.feed(&tick_of(&mut merger, tap)), CaptureStep::Took(key("KeyK")));

    let mut capture = Capture::new(ActionKind::Button);
    let north = pad_with(|pad| pad.buttons[PadButton::North.index()] = 1.0);
    assert_eq!(capture.feed(&tick_of(&mut merger, north)), CaptureStep::Took(Binding::Pad(PadButton::North)));

    let mut merger = InputMerger::default();
    let mut capture = Capture::new(ActionKind::Axis1);
    let nudge = pad_with(|pad| pad.axes[PadAxis::RightY.index()] = -0.4);
    assert_eq!(capture.feed(&tick_of(&mut merger, nudge)), CaptureStep::Waiting, "0.4 is not past half travel");
    let push = pad_with(|pad| pad.axes[PadAxis::RightY.index()] = -0.7);
    let took = capture.feed(&tick_of(&mut merger, push));
    assert_eq!(took, CaptureStep::Took(Binding::PadAxis(PadAxis::RightY, Sign::Negative)));

    let mut merger = InputMerger::default();
    let mut capture = Capture::new(ActionKind::Axis2);
    let push = pad_with(|pad| pad.axes[PadAxis::LeftX.index()] = 0.9);
    assert_eq!(capture.feed(&tick_of(&mut merger, push)), CaptureStep::Took(Binding::Stick(Stick::Left)));

    let mut capture = Capture::new(ActionKind::Button);
    let both = Injection { tap: vec!["Escape".to_owned(), "KeyA".to_owned()], ..Injection::default() };
    assert_eq!(capture.feed(&tick_of(&mut merger, both)), CaptureStep::Cancelled, "Escape cancels first");
}
