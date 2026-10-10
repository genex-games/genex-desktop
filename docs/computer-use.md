# Computer use

How agents play and look at what they build: one tool, one referee, swappable targets.

## The layers

| Layer | What | Code |
| --- | --- | --- |
| 0 · delivery | How a provider's CLI receives the tool: Claude Code as an in-process MCP tool, OpenCode as a local MCP server relayed over the file bridge (`studio-mcp-shim.ts`, pictures inline), Codex through the file bridge (`studio-bridge.ts`, the fallback) or app-server dynamic tools where enabled, Bonsai and OpenRouter in `LocalSessions`, Ollama through `preview.computer` | `src/substrate/engines/*` |
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
- **Look and act.** `look dx dy` turns the view (mouse-look) on any target with a pointer;
  `act text [duration]` presses or holds a game's own named action on a target that declares them
  (a Play Protocol game), for that much game time on a stepped clock.
- **Aliases.** cua's and OpenAI's action names (`click{button}`, `type_text`, `hotkey`,
  `keypress{keys}`, `drag{path}`, `scroll{scroll_x,scroll_y}` …) are read as the studio's own and
  never advertised.
- **Budget.** `maxActions` counts moves (input actions, waits, batch steps) on the host; looking is
  free. A spent budget is a refusal sentence.
- **Pacing.** `running` (builders, scouts, the lead), `paced` (the clock runs only during a move, on
  wall time: playtesters), `stepped` (seeded on load, then exact game time: judges). What the target
  can do is read on every load from the loaded target, so a Play Protocol game is paced by what its
  `hello` declares. On a stepped clock every key stroke is its down, a few frames of game time and
  its up (`computer-steps.ts`), a held key holds for that much game time, and a long wait is stepped
  in chunks. The first time the target cannot step, the session paces on wall time and its trace
  says `deterministic:false`; a target with no seed is never called replayable. A clock that cannot
  be held is never paused, and its paced role is told so.
- **Refusals and partial moves.** An action the target cannot do — or any step of a batch — is
  refused in a sentence, before the load against what such a target may do and after it against
  what the loaded one says. A move the target took only in part says `PARTLY` with the count; a
  batch stops where the game refused everything. An action that throws is answered as an error and
  still written to the trace.
- **Quest.** A grant may carry `quest {id, until}`, read by the host (`normalizeSetup`: a plain
  dotted path, own fields only, never `__proto__`/`constructor`). After every move the session
  checks the game's own state; the first time it holds, the answer says `GOAL REACHED
  (studio-verified)` and the trace row is marked `reached`. A goal that already held before the first
  move never counts until it has stopped holding and holds again.
- **Trace.** `trace.jsonl` beside the session's frames (a second session in the same folder writes
  `trace-2.jsonl`, and frames are numbered on, so none overwrites another's): one row per action with
  its arguments, route, frame, cursor, simulated milliseconds, input taken of planned, and
  `refused`/`failed`/`reached` marks. The delegation's result carries the summary
  (`DelegateResult.trace`), including every input route used.
- **Studio-verified is the host's word.** A session that reaches its goal registers the trace
  (`verified-traces.ts`); when the harness records an interaction as `studio-verified`,
  `events.append` keeps that word only for a registered trace and records anything else as
  `model-said` (`harness-events.ts` `vouchedInteractions`).

## Who holds it

Builders (unless `computer: false`), the director, playtesters and scouts hold `computer` on a
pooled window of their own, never Live. A **judge** (`DelegatePlaytestGrant.role: "judge"`) holds
`computer` alone, is never offered the game's `state` or `console` and reads no state in its
answers (the builder wrote both), plays on a stepped clock, and meets the game at its first screen.
It is blind (`DelegateRequest.blind`), enforced where the engine can enforce it: Claude Code
disallows every file, shell, edit and question tool; OpenCode denies every file tool; local
sessions get no file tool. Codex reads the whole disk, so a Codex judge is only told to judge by
playing (`BLIND_JUDGE_NOTE`) — the studio's goal check does not rest on that, but its other
answers do. Every engine starts in the empty `scratch/blind-judge` folder and is never told the
build's path. Its interaction evidence carries `source: hands-on-judge` and
`objective: studio-verified` only when the quest held; a model's "yes" without it is incomplete.

`preview.computer` runs the same session on a window the harness leased, for engines whose tool loop
is the harness's own (Ollama). It refuses Live and the stand-in, and accepts only the game's folder
or a build under this game's run folder: the run id is a plain name, its folder is checked by real
path, and the host's own records must say the run is this game's. One session per leased window and
round (run, part, iteration, role, goal); `fresh` starts a new one; a replaced or released session
stops what it started.

Codex's own computer use and browsers (`computer_use`, `in_app_browser`, `browser_use`,
`browser_use_external`) are disabled on every launch: they would drive the person's real screen past
the studio's consent. Only features the installed CLI lists (`codex features list`) are named, since a
CLI refuses a feature flag it does not know.

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
