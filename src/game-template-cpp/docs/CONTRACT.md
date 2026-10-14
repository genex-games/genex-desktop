# The studio contract (C++) — reference tables

`CLAUDE.md` carries the rules; this file carries the tables they point at.

## The project

| File | What it is |
| --- | --- |
| `studio.json` | `stack: "raylib-cpp"`, `targets` (any of `web`, `macos`, `windows`, `linux`), `main: "src/main.cpp"`. Destinations can be added later; the stack never changes |
| `CMakeLists.txt` | Four lines. `include("${GENEX_CMAKE}")` brings the studio's toolchain, raylib 6.0 and the flags for each destination; `genex_add_game(SOURCES src/*.cpp)` compiles every source in `src/`, new files included |
| `src/main.cpp` | The entry: builds a `studio::Game`, then `studio::install(std::move(game))`. Its FACET WIRING block is where other facets add their one line |
| `src/studio.*`, `src/platform.*`, `src/hud.*` | The runtime: window, world texture, loop, verbs, HUD, per-destination code |
| `src/{json,protocol,transport,input,clock,session,paths}.*`, `rng.h`, `digest.h` | The runtime's raylib-free parts: JSON, the verbs' envelope, the studio connection, the input merge, the fixed clock, seed/step and the meters, save folders, PCG32, FNV-1a |
| `src/frames.*`, `src/frames_wire.h` | Live's embedded frames, built only into a Mac headless game: the ring of shared surfaces Live shows, and the wire header the studio shares byte for byte |
| `web/shell.html` | The browser page: sizes the canvas, starts audio on a click, turns the runtime's exports into `window.__studio` |

The studio builds what Live shows and what judges see. With `GENEX_CMAKE` in your shell you may
compile into `build/` to read errors, never to run or ship that build. A failed studio build is
reported with its first `error:` line.

## `studio::Game` — what `install` takes

| Member | Meaning |
| --- | --- |
| `reset(seed)` | Rebuild the world from a seed. The runtime has already called `SetRandomSeed(seed)` |
| `update(dt, ctx)` | One fixed tick of 1/60 s. Reads input only from `ctx` |
| `draw(camera)` | Draw into the world texture as seen from `camera` (`BeginMode3D(camera)` … `EndMode3D()`; a 2D game ignores it). The HUD is drawn after it |
| `camera()` | The game's own view: what `draw` gets when no observer camera is placed |
| `probes()` | A `json::Value` object, one leaf per mechanic: what `state().<name>` checks read. A `volatile` object in it is left out of the checksum |
| `player()` | `{x, y, z, yaw?}` or null: where the player is |
| `cameras`, `eyes` | Named observer cameras and player-eye cameras (`{name, place}`); placing one never moves the simulation |
| `demos` | `{name, run}`: a scripted drive a generic walk cannot reach. `run` may call `studio::inject` and `studio::advance`; it ends paused and may return data |
| `worldSize` | The fixed world texture (default 960×540); the window or canvas letterboxes it |
| `background`, `title`, `saveName` | Clear colour, window title, the folder saves go under on Windows and Linux (unset: the name the studio's build gives the game) |

## Verbs

The same verbs answer the host on every destination: in the browser through `window.__studio`
(`web/shell.html` binds only the exports that exist), natively through the studio's protocol
(`{id, op, arg}` → `{id, ok, op, result}`, below). Never remove one.

| Verb | Argument → answer |
| --- | --- |
| `seed(n)` | `{seed}` → `{seed, paused: true}`. Resets on `n`, **pauses**, clears held and pending input, draws once |
| `start()` / `pause()` | → `{running}`. The game runs from the moment it loads; `seed` pauses it for judging |
| `step(ms)` | `{ms}` → `{frame, simulatedMs, steppedFrames, drawCalls}`. Runs max(1, round(ms / 16.67)) ticks, then draws once |
| `state()` | → the table below |
| `input(...)` | `{down, up, tap, look, wheel, pointer, text, pads}` or `{actions}` → `{held, ignored}` |
| `capture({camera?})` | Draws (from `camera` when named) → `{width, height, camera, drawCalls}`; the browser returns the canvas as PNG; a native run also writes the file and adds `{seq, format, digest}` (below) |
| `debugCamera(name)` | → `{ok, camera}` or `{ok: false, available}`. `default` gives the view back to the game |
| `cameras()`, `eyes()`, `demos()` | → the names |
| `demo(name)` | → `{ok, demo, result}` or `{ok: false, available}` |
| `audio({muted})` | → `{muted}` |
| `audioLevel()` (native) | → `{rms, centroid}` of what the mixer played last: rms 0 for silence and 1 for a full-scale square wave, the spectral centroid in Hz |
| `timing()` (native) | → `{frameMs, updateMs, drawMs, frames}`: means over the last 120 frames, and every frame counted |
| `front()` (native) | → `{fronted}`: raises the window; a headless run has none (`false`) |
| `visible({visible})` (native) | → `{visible}`: shows or hides the window; a headless run is never visible |
| `quit()` (native) | → `{quitting: true}`, then the game closes its window and exits 0 after the frame |
| `surface({w, h, dpr, slots, generation})` (embedded) | → `{generation, width, height, slots}`: a ring of up to 3 BGRA surfaces, `w` × `h` device pixels, replacing any older generation. Refused `bad-argument`, `stale-generation`, `no-frames-service` or `surface-failed`; a build that is not a Mac headless one answers `unknown-op` |
| `release({slot, generation})` (embedded) | → `{}`: Live gives a slot back; an older generation's slot is ignored |

## The native connection

When the studio runs a native build it passes these variables and nothing of its own environment:

| Variable | Meaning |
| --- | --- |
| `GENEX_STUDIO_FD` | Always `3`: one duplex descriptor. Without it (or without a nonce) the game opens no connection, as an exported game never does |
| `GENEX_STUDIO_NONCE` | Echoed in `ready` |
| `GENEX_STATE_DIR` | The run's `state/`: saves, and captures in `state/captures/` |
| `HOME`, `ANGLE_DEFAULT_PLATFORM` | `<state>/home`; `metal` |
| `GENEX_FRAMES_SERVICE` | An embedded run's frames service (Live), `games.genex.frames.<run id>` |

- Lines are NDJSON, at most 1 MiB each. A longer request is answered `line-too-long`, and the
  next line is still read. Requests are answered once per frame, in order, on the main thread.
- Events: `ready` once after the first reset: `{nonce, protocol: 1, contractVersion, build,
  backend: {api, device}, size, seed}`. `focus {focused}` reports a window's focus on the first
  frame and on each change. `fatal {reason}` comes right before an abnormal exit (no window, a
  raylib fatal line, terminate).
- `backend.api` is `metal-angle`, `d3d11-angle`, `vulkan-angle` or `unknown`. It comes from
  ANGLE's EGL device query, never the renderer string. A software device (SwiftShader) adds the
  HUD's CPU-fallback notice, sized and wrapped to the world: `state().hud.notice` is `cpu-fallback`.
- `capture` writes `state/captures/<seq>.bgra`: width × height × 4 bytes, BGRA, top row first,
  opaque, exactly what the window shows. `digest` is its FNV-1a 64 in hex, and the studio
  recomputes it.
- When the studio closes the descriptor, the game closes its window and exits 0.
- A headless build (`GENEX_HEADLESS`) has no window and no real input; each frame waits for the
  studio's next request, at most 1/60 s. A hidden or minimized window does the same and shows
  nothing until it is visible again; captures still draw the frame.
- Embedded in Live (a headless run with a ring), the game keeps 60 Hz and copies each new frame,
  letterboxed, into a free slot: never a queued or catch-up frame, and none while paused. Slots
  are stored bottom-up (GL rows). `input` positions with `px: true` are ring pixels from the top
  left, read as fractions of the frame.

## `state()`

| Key | Meaning |
| --- | --- |
| `version`, `contractVersion` | 1 |
| `seed`, `frame`, `simulatedMs`, `running` | The simulation: `frame` counts ticks since the last seed |
| `fps`, `volatile.fps` | Real frame rate, never compared between runs |
| `held`, `pointerLock` | Held keys (real and injected), whether the pointer is locked |
| `hud` | `{items, crosshair, flash}` of the last drawn frame |
| `camera`, `player`, `error` | The placed camera's name, `player()`, the last raylib error line |
| `__render` | `{drawCalls, triangles, tags}` counted through `studio::drawModel`, `drawModelEx` and `drawMesh` (`exact: false`); in the browser the page's own GL counters replace it |
| `assets` | Files the game loaded: through `studio::asset*`, and raylib's own load lines; never a failed load or a save. Files under this build's assets folder are labelled `/assets/<rel>` so fresh native run folders replay alike; files elsewhere keep their original path |
| `checksum` | FNV-1a 64 of `seed`, `frame` and the probes without `volatile`: equal checksums, equal simulations |
| any other key | Your probes. A probe never replaces a runtime key |

## Input — `ctx` inside `update()`

Real input is read once per rendered frame and injected input once per `input` call; both merge
into one `ctx` per tick. Edges (`pressed`, `released`), `look`, `wheel` and `text` land on the
first tick after they arrive, so a 10-tick `step` presses a key once.

| Member | What it holds |
| --- | --- |
| `ctx.keys` | `down(k)`, `pressed(k)`, `released(k)`, `held()`. Keys by DOM code (`KeyW`, `Space`, `ArrowUp`, `ShiftLeft`, `Digit1`), mouse buttons `Mouse1` (left), `Mouse2` (right), `Mouse3` (middle). `"w"` and `"KeyW"` are the same key |
| `ctx.look` | Mouse movement since the last tick, in pixels: the real mouse's only while the pointer is locked (`DisableCursor()`), and injected looks |
| `ctx.wheel` | Wheel movement since the last tick, positive downward as the DOM's `deltaY` |
| `ctx.pointer`, `ctx.pointerLock` | Cursor position as a fraction of the frame (y down), and whether it is locked |
| `ctx.pads` | Up to 4 pads, standard mapping: `connected(p)`, `down/pressed/released(p, studio::PadButton::A)`, `value(p, b)`, `axis(p, studio::PadAxis::LeftX)` |
| `ctx.text` | Text typed or composed this tick (UTF-8, at most 256 UTF-16 units), often empty |
| `ctx.rng` | PCG32 seeded by `seed`: `next()`, `unit()`, `nextInt(lo, hi)`, `nextFloat(lo, hi)`, `chance(p)` |
| `ctx.dt`, `ctx.tick` | 1/60 s; the tick number since the last seed |

## Tags, draws and the HUD

`studio::tag("roof")` names the draws that follow until the next tag; draw models and meshes
through `studio::drawModel`, `drawModelEx` and `drawMesh` so they are counted per tag. Use the
brief's tag names and short lowercase ones for the rest (`ground`, `water`, `building`, `tree`,
`prop`); `hud` is the runtime's. The HUD is immediate: call it from `draw()`.

| Call | What it draws, in world pixels |
| --- | --- |
| `studio::hud::text(str, x, y, size, color)` | Text |
| `studio::hud::bar(id, fraction, x, y, w, h, color)` | A filled bar named `id` |
| `studio::hud::crosshair(visible, size, color)` | A centred crosshair until turned off |
| `studio::hud::flash(color, alpha)` | A full-frame flash that fades |

## Assets, shaders and saves

| Call | Behaviour |
| --- | --- |
| `studio::asset(rel)`, `assetModel(rel)`, `assetSound(rel)` | Load `assets/<rel>` on every destination. `rel` is `/`-separated, no `..`; a missing texture or model is a magenta checker |
| `studio::shader(vs, fs)` | GLSL ES 3.00 without a `#version` line; the runtime adds `#version 300 es` and `precision highp float` |
| `studio::save(file, data, size)`, `studio::load(file)` | Bytes under the save folder below |

| Where the game runs | Save folder |
| --- | --- |
| In Genex | The run's own `state/` folder |
| Exported Mac app | `~/Library/Application Support/<bundle id>/` (the id in the app's Info.plist, which the studio writes) |
| Windows | `%APPDATA%\<saveName>\` |
| Linux | `$XDG_DATA_HOME/<saveName>/`, else `~/.local/share/<saveName>/` |
| Browser | `/save/` (IndexedDB when the build links IDBFS; the first `reset` runs after it is read back) |

## Facet wiring

A facet owns `src/<slug>.cpp` and exports one function, `void wire_<slug>(studio::Game& game)`,
that wraps the hooks it needs (`auto before = game.draw; game.draw = [before](const Camera3D& c)
{ before(c); … };`). Its only change to `src/main.cpp` is one line inside the FACET WIRING block:
`void wire_<slug>(studio::Game&); wire_<slug>(game);`. The harness union-merges that block.
