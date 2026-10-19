# Ctx

`ctx.keys` (`down`, `pressed`, `released` by `Key`, the DOM code names), `ctx.touches`,
`ctx.pads`, `ctx.pointer` (fraction of the frame, y down), `ctx.look`, `ctx.wheel`,
`ctx.text`, `ctx.rng` (the only randomness), `ctx.dt` (1/60), `ctx.tick` (ticks since the last
seed), `ctx.world_size`, and `ctx.save(file, bytes)` / `ctx.load(file)` for the game's own save
folder (a safe relative name; a folder the studio gives each run). On Vulkan the renderer keeps
its pipeline cache in the same folder (`genex-pipeline-cache/<adapter>.bin`): leave that name alone.

`world_size` is the game's logical size on every screen: touches, the pointer, the HUD's points
and a capture's default size are measured in it. It is not the resolution: Live frames are drawn
at the window's own pixels (capped per device class), so a larger window is sharper, never a
stretched picture, and a capture is drawn at the world size unless a check asks for another.

Edges fire on the first tick after input arrives, so a long step never presses a key twice.
`Input::key_tap(Key::Space)`, `Input::key_down`, `Input::key_up`, `Input::click_at(x, y)`,
`Input::pointer`, `Input::look`, `Input::wheel` and `Input::text` build injections;
`a.and(b)` combines them.

**Touch** is the first-class pointer on phones and tablets, and every destination delivers it
the same way. `ctx.touches.all()` lists the fingers this tick, each a `Touch` with a stable
`id`, a world position in pixels (y down, the game's own `world_size` before any letterbox) and a
phase: `Began`, `Held`, `Ended` or `Tapped` (down and up between two ticks). `tapped()` and
`began()` answer for any finger. The mouse's first button arrives as touch 0, so one code path
serves a desktop and a phone: do not also read `ctx.pointer` for the same action. Multi-touch
needs only the list. `Input::touch_start(id, x, y)`, `Input::touch_move(id, x, y)` and
`Input::touch_end(id, x, y)` inject a finger (the `touch` input kind; the others are `gamepad`,
`text`), which is how a demo and the checks play a touch game.
