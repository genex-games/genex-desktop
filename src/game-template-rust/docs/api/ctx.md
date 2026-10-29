# Ctx

A tick's input, randomness, clock and save folder, read in `on_update` and `on_ui`. Every type
and call in one line:

```rust
use genex::prelude::*;                                      // Ctx, Key, Touch, Input, Pcg32, Fit (Game::fit)
use genex::TouchPhase;                                      // Began | Held | Ended | Tapped
ctx.keys.down(Key::KeyW); ctx.keys.pressed(Key::Space); ctx.keys.released(key); // -> bool
ctx.touches.all();                                          // -> &[Touch]: Touch { id: u32, position: Vec2, phase }
ctx.touches.tapped(); ctx.touches.began();                  // -> bool, any finger
ctx.pads.down(pad, button); ctx.pads.value(pad, button); ctx.pads.axis(pad, axis); // -> bool, f32, f32
ctx.pointer; ctx.look; ctx.wheel; ctx.text;                 // Vec2, Vec2, Vec2, &str
ctx.rng.f32(); ctx.rng.range(lo, hi); ctx.rng.range_i32(lo, hi); // -> f32, f32, i32; a reset's Pcg32 the same
ctx.rng.unit(); ctx.rng.range_f32(lo, hi);                  // -> f32 in [0, 1), f32 in [lo, hi): what f32 and range alias
ctx.rng.below(n); ctx.rng.chance(p); ctx.rng.next_u32();    // -> u32, bool, u32
ctx.dt; ctx.tick; ctx.world_size;                           // f32, u64, [u32; 2]
ctx.save("progress.json", &bytes); ctx.load("progress.json"); // -> bool, Option<Vec<u8>>
ui.ctx().content_rect();                                    // the whole window in on_ui (not screen_rect: docs/api/ui.md)
Game::new(world).fit(Fit::Expand);                          // or Fit::Letterbox, the default
Input::key_tap(Key::Space).and(Input::click_at(x, y));      // also key_down, key_up, pointer, look, wheel, text
Input::touch_start(id, x, y); Input::touch_move(id, x, y); Input::touch_end(id, x, y);
```

`ctx.actions` is `docs/api/input.md` and `ctx.audio` is `docs/api/audio.md`.

`ctx.keys` (`down`, `pressed`, `released` by `Key`, the DOM code names), `ctx.touches`,
`ctx.pads`, `ctx.pointer` (fraction of the frame, y down), `ctx.look`, `ctx.wheel`,
`ctx.text`, `ctx.rng` (the only randomness: `ctx.rng.f32()` in `[0, 1)`, `ctx.rng.range(lo, hi)`
for an `f32` in `[lo, hi)`, `ctx.rng.range_i32(lo, hi)` inclusive, `ctx.rng.below(n)`,
`ctx.rng.chance(p)`, `ctx.rng.next_u32()`; `unit()` and `range_f32(lo, hi)` are the names
`f32()` and `range` alias; a reset's `Pcg32` has the same calls), `ctx.dt`
(1/60), `ctx.tick` (ticks since the last
seed), `ctx.world_size`, and `ctx.save(file, bytes)` / `ctx.load(file)` for the game's own save
folder (a safe relative name; a folder the studio gives each run). One save holds at most 16 MiB
and all of a game's saves 64 MiB together; `ctx.save` answers false past either. On Vulkan the
renderer keeps its pipeline cache in the same folder (`genex-pipeline-cache/<adapter>.bin`): leave
that name alone. The pipeline cache counts toward the 64 MiB. The `.sav` suffix is reserved for
genex's slot bodies, which load lazily on the web, so name your own files otherwise.

`world_size` is the game's logical size on every screen: touches, the pointer, the HUD's points
and a capture's default size are measured in it (at most 4096 a side, so a manifest loads in a
browser too). It is not the resolution. On a native desktop at `high` or `ultra` (TAA) Live
draws the window's own pixels, up to 8192 a side, rendering a share of them and upscaling the
rest; at `low` and `medium` (MSAA), in a browser and on a phone it draws the class's reference
pixels (1080p or 1440p, a phone's screen at 0.6-0.75) and the window stretches them. A capture is
drawn at the world size unless a check asks for another (`capture --size`, up to 8192 natively).
`resolution.md` has the table.

`Game::fit` says how the world meets a window of another aspect (keep `genex.toml` `[game] fit`
the same; another word is refused `invalid-fit`). `Fit::Letterbox`, the default, keeps black bars.
`Fit::Expand` fills the window: the world stays whole and centred where the letterbox would put
it, and the view grows past it on the window's long side, more scene at the sides of a wide
window (the vertical field of view kept) and above and below a tall one (widened to keep the
world's width). The simulation, `ctx.world_size`, the pointer and touches, the HUD and captures
at the world size never see the window, so replays and goldens do not change with it. Over the
margin past the world the pointer and touches hold at its nearest edge and the 2D layer goes on
in world pixels (draw a 2D backdrop wider than the world); keep a fixed-aspect picture on letterbox.

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

**Input actions.** Read a game's own controls as actions, not keys: `game.input(..)` and
`ctx.actions` are `docs/api/input.md` (the action map, contexts, on-screen touch controls,
rebinding, prompts and replays). The raw devices above stay for what an action map does not
cover, such as a finger the touch controls did not take.
