# UI that fits every screen

Most Roblox players play on a phone. The same ScreenGui has to work on a small landscape phone with
a notch, a tablet, a laptop, a 4K monitor and a TV across the room. Genex's phone judge looks at the
game at phone and tablet sizes and fails a change where UI overlaps, leaves the screen or covers
Roblox's own buttons.

## Size and place with Scale

- Size and position frames with **Scale** (`UDim2.fromScale`), not Offset. Offset is for small fixed
  details (a 2-pixel border, padding).
- Keep a shape's proportions with `UIAspectRatioConstraint`, and bound it with `UISizeConstraint`
  so it is never tiny on a phone or huge on a monitor.
- Anchor to the corner or edge the element belongs to: `AnchorPoint = Vector2.new(1, 1)` with
  `Position = UDim2.fromScale(1, 1)` for a bottom-right element.
- Lay out lists and grids with `UIListLayout`, `UIGridLayout` and `UIPadding`, never by hand-placed
  positions. `AutomaticSize` lets a box grow with its text.
- For one consistent look across sizes, design at one reference size and put a `UIScale` on the
  root frame, set from the viewport:
  `scale = math.clamp(math.min(viewport.X / 1280, viewport.Y / 720), 0.6, 1.5)`, updated on
  `workspace.CurrentCamera:GetPropertyChangedSignal("ViewportSize")`.

## Safe areas

- `ScreenGui.ScreenInsets = Enum.ScreenInsets.CoreUISafeInsets` (the default) for the HUD and menus:
  it keeps them clear of the notch, the rounded corners and Roblox's top bar buttons.
- `Enum.ScreenInsets.DeviceSafeInsets` for content that may sit beside Roblox's buttons but not
  under the notch; `None` only for full-screen backgrounds and effects with nothing to read or press.
- Don't hard-code the top bar's height. Read `GuiService:GetGuiInset()` (or `GuiService.TopbarInset`
  for the free room in the top bar) when you place something near it.
- `IgnoreGuiInset` is the older switch; don't mix it with `ScreenInsets` on new UI.

## Touch

- Anything a thumb presses is at least about 44 by 44 points on a phone, and the main actions are
  bigger. Leave space between neighbouring buttons.
- Keep the bottom-left (movement thumbstick) and bottom-right (jump) of a phone screen free of your
  own buttons. Put game buttons above or beside the jump button, the way Roblox's own sit.
- Use `ContextActionService:BindAction` with `createTouchButton = true`, or your own buttons, for
  actions a keyboard player gets from a key; a phone player has no keys.
- Check the device with `UserInputService.TouchEnabled`, `KeyboardEnabled` and `GamepadEnabled`, and
  `UserInputService.LastInputTypeChanged` to switch prompts; never assume one.

## Text

- Text stays readable at phone size: scale it with the layout (`TextScaled` with a
  `UITextSizeConstraint` maximum) or set sizes from the `UIScale`, never smaller than about 14
  points on a phone.
- Leave room for longer words: other languages run longer than English. Let boxes grow
  (`AutomaticSize`) instead of clipping.
- Text a player typed goes through the server's text filter before others see it.

## Gamepad and TV

- Every button can be reached with a gamepad: `Selectable = true`, a sensible `NextSelection*`
  order, and `GuiService.SelectedObject` set when a menu opens.
- `GuiService:IsTenFootInterface()` means a TV across the room: bigger text and buttons.

## Before you call it done

- Look at the UI in Studio's device emulator (or through the play shots) at a small landscape phone,
  a tablet and a 1080p screen, and let the phone judge play it when the change touches UI.
- Nothing overlaps, nothing is cut off, nothing sits under the notch or Roblox's buttons, and every
  button is large enough to press.
