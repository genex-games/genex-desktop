# Genex Play Protocol (version 3)

How the studio drives a game that runs as its own process — a native build, a Godot, Unity or
Unreal player — the way it drives a browser game in its own window: look, press, point, hold the
clock, step it, reseed it, read the game's state. The `computer` tool, its session rules and every
AI provider stay the same; only the target changes (`main/core/game-bridge-target.ts`).

An engine plugin (native/Rust, Godot, Unity, Unreal) counts as done when it passes
`tests/conformance/play-protocol.test.ts`: set `PLAY_GAME_COMMAND` to its command line (and
`PLAY_GAME_CWD` to where it runs) and run the file. The suite checks only what the engine's
`hello` declares, so an honest "none" never fails it.

The vocabulary and wire shapes live in `src/shared/play-protocol.ts`; the client in
`src/substrate/play-protocol-client.ts`.

## Declaring a game

A project opts in through its `studio.json`:

```json
{ "runtime": "bridge", "play": { "command": "bin/game", "args": ["--headless"] } }
```

`runtime` is `browser` (the default when absent) or `bridge`. `play.command` is a plain relative
path inside the project — no `..`, no absolute path, no shell character, no leading `-` — and is
resolved by real path right before launch, so a link out of the project is refused. `args` is a
list of at most 32 strings, each passed as one word. Anything unusable is dropped when the file is
read and the computer answers why instead of starting anything. The game starts in the build's
folder through the studio's ProcessSandbox, like every other process the studio spawns.

## Transport

- Newline-delimited JSON (UTF-8). The studio writes requests to the game's **stdin**; the game
  writes one reply line per request to **stdout**. Logs go to **stderr**, never stdout.
- The first stdout line is `{"event":"ready","protocol":3,...}`, or `{"event":"fatal","error":"..."}`
  and an exit. No ready line within 20 s is a failed start (`not-ready`).
- A request is `{"id":<int>,"op":"<name>",...args}`. The reply is
  `{"id":<same>,"ok":true,"op":"<name>","result":<any>}` or
  `{"id":<same>,"ok":false,"op":"<name>","error":"<sentence>","code":"<code>"}`. Put `id` first:
  a reply over the studio's size cap (24 Mi characters) is refused, and the head names its call.
- Replies may come in any order; the studio matches them by `id`. A line without an `id` is an
  event: logged, never an answer. A line that is not a JSON object is dropped.
- Each call has a deadline (10 s by default). When the process exits, every pending call fails at
  once and every later call fails without being written.
- Later: an attach transport over a localhost socket, authenticated by a per-launch token handed
  to the game in its environment, for games the studio did not start. Same messages, same order.

## Errors

| `code` | meaning |
| --- | --- |
| `unknown-op` | the op is not one the game knows; `available` may list those it does |
| `bad-args` | the op is known but its arguments are missing, of the wrong type or out of range |
| `unsupported` | the op is known but this game cannot do it (it declared so in `hello`) |

A game never crashes on a bad request: it answers it with one of these and keeps going.

## `hello`

The studio's first call. The answer:

```json
{ "protocol": 3, "name": "my-game", "view": { "width": 1280, "height": 720 },
  "capabilities": { "pointer": "absolute", "clock": "replayable", "state": "game",
                    "seed": true, "actions": ["jump", "left", "right"], "screenshot": ["jpeg", "png"] },
  "ops": ["entities", "camera"] }
```

`view` is the pixel space of every screenshot and every pointer coordinate. Capabilities are
levels, matching the studio's `TargetCapabilities`; anything missing or unknown reads as none:

| capability | levels |
| --- | --- |
| `pointer` | `none` · `relative` (look deltas only) · `absolute` (move and click at a pixel) |
| `clock` | `none` · `freeze` (pause/play) · `step-locked` (+ `step`) · `replayable` (+ same seed and inputs → same state) |
| `state` | `none` · `a11y` · `game` |
| `seed` | `true` when `reset {seed}` makes a run repeat |
| `actions` | the names `act` accepts; empty for none |
| `screenshot` | the formats it can answer in; JPEG is asked for when listed |

`ops` lists game-specific ops (an inspector's `entities`, a debug `camera`). A game extends the
protocol only there — never with a new core op.

## Core ops

| op | args | result |
| --- | --- | --- |
| `screenshot` | `format?: "jpeg"\|"png"`, `quality?` | `{format, data (base64), width, height, stats?: {meanLuma, litFraction}}`; never advances time |
| `pointer` | `x, y` (view pixels), `button?: "left"\|"middle"\|"right"`, `down?` or `click?: 1-3` | moves there; then presses, releases or clicks |
| `key` | `code` (`KeyboardEvent.code`: `KeyW`, `Space`, `ArrowLeft`), `down?` | `down: true/false` holds or releases; without it, pressed for one tick |
| `type` | `text` | the characters, as typed |
| `look` | `dx, dy` | relative look (mouse-look) |
| `wheel` | `dx, dy` | wheel at the pointer |
| `act` | `list: [{action, state: "press"\|"hold"\|"release", ticks?}]` | named actions: press is one tick, hold lasts `ticks`, release ends it |
| `pause` / `play` | | stop or run simulation time (frames may keep rendering) |
| `step` | `ms` | pause, then advance exactly that much simulated time → `{simulatedMs}` (what really ran, whole ticks) |
| `reset` | `seed` (integer ≥ 0) | recreate the game's state with that seed; clears held input → `{seed}` |
| `state` | | the game's state as JSON (below) |
| `quit` | | reply, then exit |

`state` should carry a `checksum` string that changes whenever the simulation changes, and keep
anything that is not reproduced by a replay (timings, frame counts) under `volatile`. The
conformance suite compares states with `volatile` set aside.

## How the studio maps its input

The `computer` tool's input plan (`PreviewInputAction`) becomes ops: a click is one `pointer`
with `click`, modifiers held around it with `key`; a drag is `pointer` down, move, up; a key tap
or chord is `key` down, a hold, `key` up (reverse order); `type`, `look` and `scroll` (`wheel`, at
a point when given) map one to one. A hold lets game time pass: `step {ms}` when the session has
the clock stopped, real time otherwise. A paced role (playtester, judge) pauses the game on load
and runs it only during its moves (`play`, the move, `pause`). An op the game refuses skips that
action; a process that is gone fails the whole plan. Pictures in PNG are kept as PNG and named so.

Stopping a game: `quit`, then the process tree is killed if it has not exited within two seconds.

## Changes from the native engine's protocol 2

- `hello` with capability levels replaces `capabilities`; core ops are fixed, game ops are listed.
- `pointer {x, y}` is absolute in view pixels (v2 had only relative `mouse`/`drag` input).
- `type {text}` is new.
- `screenshot` answers the picture inline (base64 JPEG or PNG) instead of writing a file.
- `step {ms}` takes milliseconds and answers `simulatedMs` (v2: `seconds`).
- `actions` is renamed `act`; `input` is split into `key`, `look`, `wheel` and `pointer`.
- Every refusal carries a `code`; requests always carry an `id`, and replies put it first.
