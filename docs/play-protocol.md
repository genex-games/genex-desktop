# Genex Play Protocol (version 3)

How the studio drives a game that runs as its own process — a native build, a Godot, Unity or
Unreal player — the way it drives a browser game in its own window: look, press, point, hold the
clock, step it, reseed it, read the game's state. The `computer` tool, its session rules and every
AI provider stay the same; only the target changes (`main/core/game-bridge-target.ts`).

This page is the specification an engine plugin implements. **Must**, **should** and **may** are
meant literally. The vocabulary and wire shapes live in `src/shared/play-protocol.ts`; the client in
`src/substrate/play-protocol-client.ts`.

An engine plugin (native/Rust, Godot, Unity, Unreal) counts as done when it passes
`tests/conformance/play-protocol.test.ts`: set `PLAY_GAME_COMMAND` to its command line (and
`PLAY_GAME_CWD` to where it runs) and run the file. The suite checks only what the engine's
`hello` declares, so an honest "none" never fails it; the fake game runs it twice, whole and with
`--reduced` (a game that declares less).

## Which games use it

- A **web game** runs in the studio's browser preview and is driven through `window.__studio`
  (the game template's `src/studio.js`). It does not speak this protocol.
- A **native game** speaks this protocol. An engine that has both a web and a native build
  implements the protocol in its native player; its web build still runs in the browser preview.
- The studio plays only games it starts. There is no attach transport yet (see Transport).

### Declaring a game

A project opts in through its `studio.json`:

```json
{ "runtime": "bridge", "play": { "command": "bin/play", "args": ["--headless"] } }
```

`runtime` is `browser` (the default when absent) or `bridge`. `play.command` must be a file inside
the project: a plain relative path — no `..`, no absolute path, no shell character, no leading `-`
— resolved by real path right before launch, so a link out of the project is refused. `args` is a
list of at most 32 strings, each passed as one word. Anything unusable is dropped when the file is
read and the computer answers why instead of starting anything. The game starts in the build's
folder through the studio's ProcessSandbox, like every other process the studio spawns.

An engine whose player lives outside the project (`godot`, a Unity player, `UnrealEditor -game`)
is started by a wrapper script committed in the project, which the play command names:

```sh
#!/bin/sh
# bin/play — start the exported player with the project's own Play Protocol plugin enabled.
exec godot --path . --headless -- --play-protocol "$@"
```

## Versioning

`protocol` (in the ready line and in `hello`) is the **major** version, an integer. The studio
refuses a game whose `hello` names another major version: the load answers a problem saying both
versions, and the game is stopped, never driven. Additions within a major version are optional:
new fields a reader does not know are ignored, and new ops arrive as optional ops a game declares
in `hello` — the studio never sends an op the game did not declare, beyond the core ops below.

## Transport

- Newline-delimited JSON (UTF-8). The studio writes requests to the game's **stdin**; the game
  writes one reply line per request to **stdout**. Logs go to **stderr**, never stdout.
- The studio reads stderr for as long as the game runs, so a game may log freely. It keeps the last
  8 KiB and names the last lines in the problem when a start or a call fails.
- The first stdout line is `{"event":"ready","protocol":3,...}`, or `{"event":"fatal","error":"..."}`
  and an exit. No ready line within 20 s is a failed start (`not-ready`).
- A request is `{"id":<int>,"op":"<name>",...args}`. The reply is
  `{"id":<same>,"ok":true,"op":"<name>","result":<any>}` or
  `{"id":<same>,"ok":false,"op":"<name>","error":"<sentence>","code":"<code>"}`. Put `id` first:
  a reply over the studio's size cap (24 Mi characters) is refused, and the head names its call.
- The studio may send a request before an earlier one is answered. A game **must apply ops in the
  order it received them**; its replies may come in any order, and the studio matches them by `id`.
- A line without an `id` is an event: logged, never an answer. A line that is not a JSON object is
  dropped.
- Each call has a deadline: 10 s by default, 5 s for `hello`, and for `step` 10 s plus twice the
  simulated time, at most 3 min. When the process exits, every pending call fails at once and
  every later call fails without being written.
- Later: an attach transport over a localhost socket, authenticated by a per-launch token handed
  to the game in its environment, for games the studio did not start. Same messages, same order.

## Errors

A game never crashes on a bad request: it answers it with one of these codes and keeps going.

| `code` | when |
| --- | --- |
| `unknown-op` | `op` is not a core op and not one of the game's `hello.ops` — including a wrong case, an empty or a non-string `op`. `available` may list the ops it knows |
| `unsupported` | a core op the game's `hello` says it lacks (below), whatever its arguments |
| `bad-args` | an op the game does, with an argument missing, of the wrong type or out of range — including a key `code` it does not know and a `step` longer than it takes |

## `hello`

The studio's first call. The answer:

```json
{ "protocol": 3, "name": "my-game", "view": { "width": 1280, "height": 720 },
  "build": { "id": "2026.10.10-7f3c2a1", "sourceHash": "7f3c2a1e" },
  "capabilities": { "pointer": "absolute", "clock": "replayable", "state": "game",
                    "seed": true, "actions": ["jump", "left", "right"], "screenshot": ["jpeg", "png"] },
  "ops": ["entities", "camera"], "unsupported": ["type"] }
```

`view` is the pixel space of every screenshot and every pointer coordinate, origin top-left. It
is fixed for the life of the process: no core op changes it (a future resize would be an optional
op declared in `hello`). `build` is optional: the game's own id for the binary and, when it knows
it, the hash of the source it was built from; the studio names it in the load's note, so a judge's
trace and answer say which binary it played. Capabilities are levels, matching the studio's
`TargetCapabilities`; anything missing or unknown reads as none:

| capability | levels |
| --- | --- |
| `pointer` | `none` · `relative` (look deltas only) · `absolute` (move and click at a pixel, and look) |
| `clock` | `none` · `freeze` (pause/play) · `step-locked` (+ `step`) · `replayable` (+ same seed and inputs → same state) |
| `state` | `none` · `a11y` · `game` |
| `seed` | `true` when `reset {seed}` makes a run repeat |
| `actions` | the names `act` accepts; empty for none |
| `screenshot` | the formats it can answer in; JPEG is asked for when listed |

A game lacks — and answers `unsupported` to — `pointer` and `wheel` without an absolute pointer,
`look` without any pointer, `pause` and `play` without a clock, `step` without a step-locked one,
`reset` without a seed, `act` without actions, `state` without state, and every core op it lists
in `unsupported` (a game with no text entry lists `type`). `hello`, `screenshot` and `quit` are
never optional. `ops` lists game-specific ops (an inspector's `entities`, a debug `camera`); a game
extends the protocol only there — never with a new core op.

## Time and input

The simulation advances in whole **ticks** of a fixed length the game chooses.

- While the clock runs, input is applied at the start of the next tick.
- While it is stopped (`pause`, or after a `step`), input does not change the simulation: it is
  queued in arrival order and applied at the start of the first tick the next `step` (or `play`)
  runs. The input echo in `state` (below) may show it at once.
- `key` with `down` holds or releases from that tick on. `key` without `down` is a press: down for
  exactly the next tick, released after it. A `down` and an `up` queued while stopped are both
  applied at the start of the same tick, so the game never sees the key held — send a press instead.
- A `pointer` click is pressed and released on the next tick. `act`'s `press` lasts one tick and
  `hold` lasts `ticks` ticks, counted from the next tick.
- `step {ms}` pauses, then runs `ms` rounded to the nearest whole number of ticks, at least one, and
  stays paused. A game must take any `ms` above 0 up to 60 000 (`PLAY_MAX_STEP_MS`); the studio
  sends a longer hold as several steps. The answer's `simulatedMs` is the ticks run times the tick.
- `screenshot` renders the current simulation state — after every tick already run — and never
  advances time. Its `width` and `height` must equal `view`: an engine on a HiDPI display renders
  at its backing scale and downscales to `view`.
- `reset {seed}` restores the state as it was at launch, with that seed: the simulation and its
  random numbers, no keys, buttons or actions held or queued, the input echo cleared and the
  pointer where it starts. It does not change whether the clock is paused, nor the view.

## Core ops

| op | args | result |
| --- | --- | --- |
| `screenshot` | `format?: "jpeg"\|"png"`, `quality?` (1–100) | `{format, data (base64), width, height, stats?: {meanLuma, litFraction}}` |
| `pointer` | `x, y` (view pixels), `button?: "left"\|"middle"\|"right"`, `down?: boolean` or `click?: 1-3` | moves there; then presses, releases or clicks |
| `key` | `code` (below), `down?: boolean` | holds, releases or presses |
| `type` | `text` (Unicode, at most 2 000 characters) | the characters, delivered as text input (as an IME commits them), not as key presses |
| `look` | `dx, dy` | relative motion in view pixels, as a locked mouse moved that far; +x right, +y down |
| `wheel` | `dx, dy` | wheel at the pointer, in pixels as a browser's wheel event; +dy scrolls down |
| `act` | `list: [{action, state: "press"\|"hold"\|"release", ticks?}]` | named actions |
| `pause` / `play` | | stop or run simulation time (frames may keep rendering) |
| `step` | `ms` (0 < ms ≤ 60 000) | `{simulatedMs}` |
| `reset` | `seed` (integer ≥ 0) | `{seed}` |
| `state` | | the game's state as JSON (below) |
| `quit` | | reply, then exit |

`state` should carry a `checksum` string that changes whenever the simulation changes (and only
then: not with the input echo), and keep anything that is not reproduced by a replay (timings,
frame counts) under `volatile`. It should carry an input echo — what the game received, so a
judge can see its input landed:
`"input": {"pointer": {"x", "y", "buttons": []}, "keys": [], "typed": "", "look": {"dx", "dy"}, "wheel": {"dx", "dy"}}`
with `look` and `wheel` summed since launch or reset. The conformance suite compares states with
`volatile` set aside and checks the echo when it is there.

### Key codes

`key` takes `KeyboardEvent.code` names. The studio sends these: `KeyA`–`KeyZ`, `Digit0`–`Digit9`,
`F1`–`F24`, `Space`, `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `Insert`, `Home`, `End`,
`PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Minus`, `Equal`,
`Comma`, `Period`, `Slash`, and the modifiers `ShiftLeft`, `ControlLeft`, `AltLeft`, `MetaLeft`
(held around a click or chord). A name the model typed that the studio does not know can arrive
as it was written (`;`, `Numpad1`): a game that does not know it answers `bad-args`.

## How the studio maps its input

The `computer` tool's input plan (`PreviewInputAction`) becomes ops: a click is one `pointer`
with `click`, modifiers held around it with `key`; a drag is `pointer` down, move, up; a key tap
or chord is `key` down, a hold, `key` up (reverse order); `type`, `look` and `scroll` (`wheel`, at
a point when given) map one to one. A hold lets game time pass: `step {ms}` when the session has
the clock stopped, real time otherwise. A paced role (playtester, judge) pauses the game on load
and runs it only during its moves (`play`, the move, `pause`). Pictures in PNG are kept as PNG and
named so.

An op the game refuses ends that action: keys and buttons it pressed are released, the action is
not counted as applied, and the refusal is kept for the session to report (`refusals()`). A
refused `step` answers the session's clock as "cannot step". A process that is gone, or a call
that timed out, fails the whole plan.

Stopping a game: `quit`, then the process tree is killed if it has not exited within two seconds.

## Changes from the native engine's protocol 2

- `hello` with capability levels replaces `capabilities`; core ops are fixed, game ops are listed,
  and core ops a game lacks are declared.
- `hello.build` keeps v2's build identity, now optional.
- `pointer {x, y}` is absolute in view pixels (v2 had only relative `mouse`/`drag` input).
- `type {text}` is new.
- `screenshot` answers the picture inline (base64 JPEG or PNG) instead of writing a file.
- `step {ms}` takes milliseconds and answers `simulatedMs` (v2: `seconds`).
- `actions` is renamed `act`; `input` is split into `key`, `look`, `wheel` and `pointer`.
- Every refusal carries a `code`; requests always carry an `id`, and replies put it first.
