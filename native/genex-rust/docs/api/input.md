# Input

A game reads actions (`jump`, `move`), never keys. One action map names them once; keys, pads and
on-screen touch controls all drive the same action, the player can rebind any of them, and a
prompt shows the button of the device in use. The types live in `genex::actions` (the prelude has
`ActionMap`, `Context`, `Binding`, `PadButton`, `Stick` and `TouchControls`). The raw devices
(`ctx.keys`, `ctx.touches`, `ctx.pads`) stay on the Ctx page.

```rust
use genex::actions::{glyph_ui, ActionId, Anchor, Condition, ContextId, ControlId, ShowWhen, StickMode};

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");
const STICK: ControlId = ControlId::new("stick");
const HOP: ControlId = ControlId::new("hop");

game.input(ActionMap::new().context(Context::new(PLAY, 0)
    .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left), Binding::Touch(STICK)])
    .button(JUMP, &[Key::Space.into(), Binding::Pad(PadButton::South), Binding::Touch(HOP)])
    .when(Condition::Press)));
game.touch_controls(TouchControls::new()
    .stick(STICK, Anchor::BottomLeft([160.0, 160.0]), 70.0, StickMode::Floating)
    .button(HOP, "Jump", Anchor::BottomRight([120.0, 120.0]), 48.0)
    .show(ShowWhen::Touch));
game.on_update(|sim, ctx| {
    sim.world.walk = ctx.actions.axis2(MOVE);
    if ctx.actions.fired(JUMP) { sim.world.jumps += 1; }
});
game.on_ui(|_sim, ui, ctx| { glyph_ui(ui, &ctx.actions.glyph(JUMP)); });
```

## The map

- **Ids.** `ActionId::new`, `ContextId::new` and `ControlId::new` take lowercase letters, digits
  and `_`, at most 32 bytes, as consts.
- **Contexts.** `Context::new(id, priority)` holds actions: `.button(..)`, `.axis1(..)` and
  `.axis2(..)` (x right, y down) each take bindings. An action that is down takes the inputs it
  reads from every lower-priority context, unless its context is `.pass_through()`.
  `.starts_off()` leaves a context off after a seed. `.when(..)` and `.modify(..)` apply to the action added last.
- **Bindings.** `Key::Space.into()`, `Binding::Pad(PadButton::South)` (by position: south, east,
  west, north, shoulders, triggers, d-pad, start, select), `Binding::Stick(Stick::Left)`,
  `Binding::WASD`, `Binding::ARROWS`, `Binding::Keys2`, `Binding::Keys4`, `Binding::Dpad`,
  `Binding::PadAxis`, `Binding::Chord` (up to three inputs together), `Binding::Touch(control)`,
  `Binding::Look` and `Binding::Wheel`. At most 64 actions, 8 contexts and 8 bindings an action.
- **Conditions** count ticks, never seconds: `Condition::Down` (the default), `Press`, `Release`,
  `Hold { ticks, one_shot }`, `Tap { max_ticks }`, `Pulse { first, every }`, `Toggle`,
  `Cooldown { ticks }` and `BlockBy(action)`. Several on one action must all fire.
- **Modifiers** shape a value in order: `Modifier::DeadZone` (radial for sticks, 0.15 by default;
  axial per axis), `Hysteresis` (an analog input pressing a button: 0.75 on, 0.65 off), `Negate`,
  `Swizzle`, `Scale` and `Curve`. All of it is libm math, the same bits everywhere.

## Reading actions

The update and UI hooks read `ctx.actions.down(..)`, `ctx.actions.pressed(..)` and
`ctx.actions.released(..)` (edges on the tick they happen), `ctx.actions.fired(..)` (the
conditions), `ctx.actions.value(..)`, `ctx.actions.axis2(..)` and `ctx.actions.held_ticks(..)`.
`ctx.actions.enable(..)` and `ctx.actions.disable(..)` switch a context from the next tick (its
actions let go without a release edge) and `ctx.actions.is_on(..)` reads it. An id the map does
not declare reads false or 0 and is listed in `state().__input.unknownReads`.

The built-in `ui` context (priority 100, off until a game enables it) holds `ui_up`, `ui_down`,
`ui_left`, `ui_right`, `ui_accept`, `ui_cancel`, `ui_next` and `ui_prev`; while it is on, the HUD's
menus move by them, so a rebind moves the menus too. On a Nintendo pad accept and cancel swap to
match the labels. Escape and the pad's home button are reserved for the system: a game context
binding them is refused `input-binding-reserved`. While a HUD text field has focus, the keyboard
drives no action.

## Prompts

`ctx.actions.device(..)` is the device the player used last (keyboard, pad or touch) and
`ctx.actions.glyph(..)` an action's prompt on it: "Space", "Cross" on a PlayStation pad, "B" on a
Nintendo pad for south. `glyph_ui(ui, &glyph)` draws it as a key cap, face button or stick shape:
the HUD's fonts have no pad symbols, and no platform logo is drawn. On a touch screen the prompt is the control's: its label, or its shape. A glyph is display text: it
follows the keyboard layout (on AZERTY `KeyW` reads "Z") and the pad in hand, while the binding
and the action read the same. Never keep a glyph's label in the world's rules, a save or a
checksummed probe; a `probe_volatile` may show what the HUD drew. A Studio run ignores layout
labels, so judged runs read the same prompts. `state().__input.hints` lists every action's labels.

## Touch controls

`game.touch_controls(TouchControls::new()..)` adds up to 12 on-screen controls: `.stick(..)`
(`StickMode::Fixed`, or `Floating`, whose base lands under the finger), `.button(..)` and
`.dpad(..)`, each at an `Anchor` corner offset in world pixels. A `touch:<id>` binding reads a
control; `ctx.actions.free_touches(..)` are the touches no control took, so a game that also reads
raw touches handles those only. `.show(..)` picks when they are drawn (`ShowWhen::Touch`, `Always`, `Never`); drawn or not, a
finger reads the same. The desktop mouse's first button (touch 0) presses a control only in a
layout shown on every device (`ShowWhen::Always`): elsewhere a click on a hidden control stays
the game's click (`ctx.actions.free_touches`). `.label("Move")` names the control added last; a
stick or d-pad without one is drawn as its shape alone and prompts "Stick" or "D-pad", a button
shows its label. A floating stick's zone is outlined only while a finger is down. Each control is
a HUD item labelled with its label (a stick or d-pad without one: its id), so a check finds and
taps it.

## Rebinding

`controls_panel(ui)` in a UI hook (or the Controls tab of `genex::settings::menu(ui)`) lists each
action's bindings: the player rebinds one, swaps a clash, sets dead zones, trigger thresholds,
inverted sticks and hold-or-toggle per button, or resets. The change applies after the tick's UI
hooks, is saved as `genex-input.json` in the game's saves and is kept across seeds. A file that
does not read keeps the defaults and is named in `state().__input.refusal`.

## Replays and determinism

The same (seed, bindings digest, `TickInput` rows) give the same actions and the same checksum
on every destination: the bindings are part of the input, so a track's header carries them. A
demo plays a recorded `InputTrack` back through its driver's `replay`; a track for another seed,
contract, world size or bindings is refused. Glyphs, layout labels and whether touch controls are
drawn never enter it. `state().__input` (only while `game.input` is registered, never hashed) shows
`bindings`, `device`, `family`, `contexts`, `down`, `hints`, `touchControls`, `refusal`,
`unknownReads` and `journal`.

## Refusals

`install` panics `duplicate-input`, `duplicate-touch-controls` or `input-invalid`; the last names
the map's own code: `input-action-invalid` (a bad id, or a condition or modifier that cannot
work), `input-action-duplicate`, `input-context-duplicate`, `input-binding-mismatch` (a stick on a
button), `input-binding-conflict` (two actions of one context read one input),
`input-binding-reserved`, `input-map-too-large` or `touch-controls-invalid` (a control outside the
world or a repeated id). The player's file answers `input-bindings-invalid`,
`input-bindings-stale` (rows for actions the map dropped; the rest apply) or
`input-access-invalid`. A track answers `input-track-invalid`, `input-track-too-large` or
`input-track-mismatch`, and a remote player's actions that do not read against the map
`input-wire-invalid`.

`native/genex-rust/examples/input-twinstick` plays with keys and mouse, a pad or touch, rebinds in
its pause menu and replays a recorded session to an equal checksum.
