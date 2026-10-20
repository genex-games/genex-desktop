//! The built-in `ui` context every map holds: menu navigation as actions, so the HUD reads
//! `ui_up` .. `ui_prev` through the same bindings, rebinding and accessibility as the game. It
//! starts off at priority 100; a menu turns it on and takes its inputs from the game below.
//!
//! On a Nintendo pad confirm is the right face button and back the bottom one, so while the
//! pad family is Nintendo this context reads South and East swapped.

use crate::binding::{Binding, ChordInput, KeyCode, PadAxis, PadButton, Sign};
use crate::condition::Condition;
use crate::id::{ActionId, ContextId};
use crate::map::Context;
use crate::modifier::Modifier;

/// The built-in menu context.
pub const UI: ContextId = ContextId::new("ui");
/// The `ui` context's priority: above every game context a game is likely to declare.
pub const UI_PRIORITY: i8 = 100;
/// Ticks a held direction waits before it repeats (UISAVE's `NAV_REPEAT_DELAY_TICKS`).
pub const UI_REPEAT_FIRST_TICKS: u16 = 24;
/// Ticks between repeats after the first (UISAVE's `NAV_REPEAT_EVERY_TICKS`).
pub const UI_REPEAT_EVERY_TICKS: u16 = 6;
/// How far a stick pushes a menu direction: half travel, released below 0.4.
const UI_STICK_PRESS: f32 = 0.5;
const UI_STICK_RELEASE: f32 = 0.4;

/// The `ui` context's actions.
#[derive(Clone, Copy, Debug)]
pub struct UiAction;

impl UiAction {
    /// Move focus up.
    pub const UP: ActionId = ActionId::new("ui_up");
    /// Move focus down.
    pub const DOWN: ActionId = ActionId::new("ui_down");
    /// Move focus left.
    pub const LEFT: ActionId = ActionId::new("ui_left");
    /// Move focus right.
    pub const RIGHT: ActionId = ActionId::new("ui_right");
    /// Activate the focused widget.
    pub const ACCEPT: ActionId = ActionId::new("ui_accept");
    /// Go back or close.
    pub const CANCEL: ActionId = ActionId::new("ui_cancel");
    /// Next tab.
    pub const NEXT: ActionId = ActionId::new("ui_next");
    /// Previous tab.
    pub const PREV: ActionId = ActionId::new("ui_prev");
    /// All eight, in declaration order.
    pub const ALL: [ActionId; 8] = [
        UiAction::UP,
        UiAction::DOWN,
        UiAction::LEFT,
        UiAction::RIGHT,
        UiAction::ACCEPT,
        UiAction::CANCEL,
        UiAction::NEXT,
        UiAction::PREV,
    ];
}

const SHIFT_TAB: Binding =
    Binding::Chord([Some(ChordInput::Key(KeyCode::of("ShiftLeft"))), Some(ChordInput::Key(KeyCode::of("Tab"))), None]);

/// The `ui` context with its defaults.
pub(crate) fn context() -> Context {
    let key = |code: &'static str| Binding::Key(KeyCode::of(code));
    let repeat = Condition::Pulse { first: UI_REPEAT_FIRST_TICKS, every: UI_REPEAT_EVERY_TICKS };
    let stick = Modifier::Hysteresis { press: UI_STICK_PRESS, release: UI_STICK_RELEASE };
    let direction = |context: Context, id, arrow, dpad, axis, sign| {
        context.button(id, &[key(arrow), Binding::Pad(dpad), Binding::PadAxis(axis, sign)]).when(repeat).modify(stick)
    };
    let mut context = Context::new(UI, UI_PRIORITY).starts_off();
    context.family_confirm = true;
    let context = direction(context, UiAction::UP, "ArrowUp", PadButton::DpadUp, PadAxis::LeftY, Sign::Negative);
    let context = direction(context, UiAction::DOWN, "ArrowDown", PadButton::DpadDown, PadAxis::LeftY, Sign::Positive);
    let context = direction(context, UiAction::LEFT, "ArrowLeft", PadButton::DpadLeft, PadAxis::LeftX, Sign::Negative);
    let context =
        direction(context, UiAction::RIGHT, "ArrowRight", PadButton::DpadRight, PadAxis::LeftX, Sign::Positive);
    context
        .button(UiAction::ACCEPT, &[key("Enter"), key("Space"), Binding::Pad(PadButton::South)])
        .when(Condition::Press)
        .button(UiAction::CANCEL, &[key("Escape"), Binding::Pad(PadButton::East)])
        .when(Condition::Press)
        .button(UiAction::NEXT, &[key("Tab"), Binding::Pad(PadButton::RightShoulder)])
        .when(Condition::Press)
        .button(UiAction::PREV, &[SHIFT_TAB, Binding::Pad(PadButton::LeftShoulder)])
        .when(Condition::Press)
}
