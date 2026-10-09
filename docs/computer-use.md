# Computer use

How agents play and look at what they build: one tool, one referee, swappable targets.

## The layers

| Layer | What | Code |
| --- | --- | --- |
| 0 · delivery | How a provider's CLI receives the tool: Claude Code as an in-process MCP tool, Codex and OpenCode through the file bridge (`studio-bridge.ts`, the fallback) or their native routes where enabled, Bonsai and OpenRouter in `LocalSessions`, Ollama through `preview.computer` | `src/substrate/engines/*` |
| 1 · tool | One `computer` tool: Anthropic's `computer_toolset_20260801` actions, the studio verbs (`camera`, `state`, `reload`, `console`), `batch` and `observe`. Its description and action list are built from the target's capabilities, so a verb the target lacks is never offered and calling it gets a sentence, not a silent no-op | `src/substrate/computer-tool.ts`, `computer-tool-prompts.ts`, `computer-vocabulary.ts` |
| 2 · session | The referee: parse, refuse what the target cannot do, keep the action budget, pace the clock, answer, check a goal, write the trace | `src/main/core/computer-session.ts`, `src/substrate/computer-trace.ts` |
| 3 · targets | A `ComputerTarget` with graded capabilities: the browser preview today, a game speaking the Genex Play Protocol, later a window, desktop or VM | `src/substrate/computer-target.ts`, `src/shared/computer-target.ts`, `src/main/core/browser-preview-target.ts` |

A new target is a new `ComputerTarget` and a `TargetSource` (how it loads, where its frames go).
Nothing in the tool, the session or any engine changes for it.

## Capabilities

`TargetCapabilities` declares levels, never yes/no: `pointer` none | relative | absolute, `clock`
none | freeze | step-locked | replayable, `state` none | a11y | game, plus `seed`, `reload`,
`cameras`, `console`, `zoom`, `surfaces` and `actions`. The browser preview is
`BROWSER_CAPABILITIES` (everything, step-locked). Every input records its `InputRoute` (`browser`,
`bridge`, `os-background`, `os-foreground`) in the trace: evidence from outside the game is weaker
than evidence from inside it.

## The session's rules

- **Observe.** Input actions, `wait` and `batch` take `observe=screenshot|canvas|none`; the picture
  comes back with the answer. It is on by default for the roles that play to judge (playtester,
  judge) and off for builders. A picture that cannot be taken is said in the answer; the move
  still counts.
- **Batch.** Up to `MAX_BATCH_STEPS` (8) input actions and waits in one call, at most
  `MAX_INPUT_ACTIONS` (24) input events, stopping at the first that fails with its step named.
- **Aliases.** cua's and OpenAI's action names (`click{button}`, `type_text`, `hotkey`,
  `keypress{keys}`, `drag{path}`, `scroll{scroll_x,scroll_y}` …) are read as the studio's own and
  never advertised.
- **Budget.** `maxActions` counts moves (input actions, waits, batch steps) on the host; looking is
  free. A spent budget is a refusal sentence.
- **Pacing.** `running` (builders, scouts, the lead), `paced` (the clock runs only during a move, on
  wall time: playtesters), `stepped` (seeded on load, then exact `step(ms)` after every move:
  judges). A target that cannot step falls back to pacing and its trace says `deterministic:false`.
  A target whose clock cannot be held is never paused, and its paced role is told so.
- **Quest.** A grant may carry `quest {id, until}`. After every move the session checks the game's
  own state with `setupReached`; the first time it holds, the answer says `GOAL REACHED
  (studio-verified)` and the trace row is marked `reached`.
- **Trace.** `trace.jsonl` beside the session's frames: one row per action with its arguments,
  route, frame, cursor, simulated milliseconds, and `refused`/`reached` marks. The delegation's
  result carries the summary (`DelegateResult.trace`).

## Who holds it

Builders (unless `computer: false`), the director, playtesters and scouts hold `computer` on a
pooled window of their own, never Live. A **judge** (`DelegatePlaytestGrant.role: "judge"`) holds
`computer` alone: it is blind (`DelegateRequest.blind` — Claude Code disallows file, shell, edit and
question tools; local sessions get no file tools; every engine starts in the empty
`scratch/blind-judge` folder and reads only its own frames), plays on a stepped clock, and starts
past the front-end. Its interaction evidence carries `source: hands-on-judge` and
`objective: studio-verified` only when the quest held; a model's "yes" without it is incomplete.

`preview.computer` runs the same session on a window the harness leased, for engines whose tool loop
is the harness's own (Ollama). It refuses Live and the stand-in, and accepts only the game's folder
or a build under this run's `scratch/autopilot/<runId>`, checked by real path. One session per leased
window, forgotten on `preview.release`.

Codex's own computer use and browsers (`computer_use`, `in_app_browser`, `browser_use`,
`browser_use_external`) are disabled on every launch: they would drive the person's real screen past
the studio's consent.

## Game engines and other targets

A game engine joins through the Genex Play Protocol ([play-protocol.md](play-protocol.md)): a small
plugin inside the game answers about a dozen JSON commands (hello, screenshot, pointer, key, type,
look, act, pause, play, step, reset, state). A project declares it in `studio.json`
(`"runtime": "bridge"`, `"play": {"command", "args"}`, the command resolved by real path inside the
project); the delegation then gives every role a `GameBridgeTarget`
([`src/main/core/game-bridge-target.ts`](../src/main/core/game-bridge-target.ts)) whose game runs in
the `ProcessSandbox`. The playtest shorthands are not offered there; its moves are drawn on the
worker's agent screen like a browser game's (`targetFramePort`). Every plugin is held to the shared
conformance suite (`tests/conformance/play-protocol.test.ts`, run against
`tests/fixtures/fake-play-game.mjs`; `PLAY_GAME_COMMAND` points it at another game).
Window, desktop and VM targets (cua-driver, outside the window) plug into the same interface at a
lower trust level: they cannot hold the clock or read game state.
