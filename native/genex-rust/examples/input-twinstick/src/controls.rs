//! The game's actions, contexts and on-screen touch controls: everything input-twinstick reads,
//! declared once. Gameplay reads these action ids only, never a key, so a rebind in the Controls
//! panel, a pad or a finger on the screen all drive the same rules.

use genex::actions::{ActionId, ActionMap, Anchor, Binding, Condition, Context, ContextId, ControlId, PadButton, ShowWhen, Stick, StickMode, TouchControls};
use genex::prelude::*;

/// Moving and fighting: off while the pause menu is open.
pub const PLAY: ContextId = ContextId::new("play");
/// Opening and closing the pause menu: always on.
pub const SYSTEM: ContextId = ContextId::new("system");

/// Walk (a 2D axis, x right and y down on the screen).
pub const MOVE: ActionId = ActionId::new("move");
/// Aim with the right stick or the touch aim stick (a 2D axis); pushed past [`AIM_FIRES`] it fires.
pub const AIM: ActionId = ActionId::new("aim");
/// Fire toward the aim (the mouse button aims at the pointer).
pub const FIRE: ActionId = ActionId::new("fire");
/// A short burst of speed, at most once every [`DASH_COOLDOWN_TICKS`].
pub const DASH: ActionId = ActionId::new("dash");
/// Open or close the pause menu.
pub const PAUSE: ActionId = ActionId::new("pause");

/// The touch stick that walks (floating: its base lands under the finger).
pub const MOVE_STICK: ControlId = ControlId::new("move");
/// The touch stick that aims and fires.
pub const AIM_STICK: ControlId = ControlId::new("aim");
/// The touch dash button.
pub const DASH_BUTTON: ControlId = ControlId::new("dash");
/// The touch pause button.
pub const PAUSE_BUTTON: ControlId = ControlId::new("pause");

/// Ticks between two dashes (counted in ticks, never seconds).
pub const DASH_COOLDOWN_TICKS: u16 = 45;
/// How far the aim stick must be pushed to fire.
pub const AIM_FIRES: f32 = 0.3;

/// The move stick's centre, in world pixels from the bottom-left corner.
pub const MOVE_STICK_AT: [f32; 2] = [160.0, 160.0];
/// The move stick's radius, in world pixels (its floating zone is twice that).
pub const MOVE_STICK_RADIUS: f32 = 70.0;
/// The aim stick's centre, in world pixels from the bottom-right corner.
pub const AIM_STICK_AT: [f32; 2] = [140.0, 140.0];
/// The aim stick's radius, in world pixels.
pub const AIM_STICK_RADIUS: f32 = 70.0;
/// The dash button's centre, in world pixels from the bottom-right corner.
pub const DASH_BUTTON_AT: [f32; 2] = [290.0, 80.0];
/// The dash button's radius, in world pixels.
pub const DASH_BUTTON_RADIUS: f32 = 42.0;
/// The pause button's centre, in world pixels from the top-right corner.
pub const PAUSE_BUTTON_AT: [f32; 2] = [50.0, 50.0];
/// The pause button's radius, in world pixels.
pub const PAUSE_BUTTON_RADIUS: f32 = 30.0;

/// The action map: `play` (walk, aim, fire, dash) and `system` (pause). The built-in `ui`
/// context, off until the pause menu opens, drives the menu.
pub fn action_map() -> ActionMap {
    let play = Context::new(PLAY, 0)
        .axis2(MOVE, &[Binding::WASD, Binding::ARROWS, Binding::Stick(Stick::Left), Binding::Touch(MOVE_STICK)])
        .axis2(AIM, &[Binding::Stick(Stick::Right), Binding::Touch(AIM_STICK)])
        .button(FIRE, &[Key::Mouse1.into(), Binding::Pad(PadButton::RightTrigger)])
        .button(DASH, &[Key::Space.into(), Binding::Pad(PadButton::South), Binding::Touch(DASH_BUTTON)])
        .when(Condition::Cooldown { ticks: DASH_COOLDOWN_TICKS });
    let system = Context::new(SYSTEM, 1)
        .button(PAUSE, &[Key::KeyP.into(), Binding::Pad(PadButton::Start), Binding::Touch(PAUSE_BUTTON)])
        .when(Condition::Press);
    ActionMap::new().context(play).context(system)
}

/// The on-screen layout, shown only while the player is on a touch screen (whether it is shown
/// never changes what the game reads).
pub fn touch_layout() -> TouchControls {
    TouchControls::new()
        .stick(MOVE_STICK, Anchor::BottomLeft(MOVE_STICK_AT), MOVE_STICK_RADIUS, StickMode::Floating)
        .stick(AIM_STICK, Anchor::BottomRight(AIM_STICK_AT), AIM_STICK_RADIUS, StickMode::Fixed)
        .button(DASH_BUTTON, "Dash", Anchor::BottomRight(DASH_BUTTON_AT), DASH_BUTTON_RADIUS)
        .button(PAUSE_BUTTON, "Pause", Anchor::TopRight(PAUSE_BUTTON_AT), PAUSE_BUTTON_RADIUS)
        .show(ShowWhen::Touch)
}

/// A control's centre in world pixels, from its corner anchor: where a demo puts a finger.
pub fn bottom_left(at: [f32; 2], world: [u32; 2]) -> [f32; 2] {
    [at[0], world[1] as f32 - at[1]]
}

/// See [`bottom_left`].
pub fn bottom_right(at: [f32; 2], world: [u32; 2]) -> [f32; 2] {
    [world[0] as f32 - at[0], world[1] as f32 - at[1]]
}
