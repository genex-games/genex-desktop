# Tests

Root rules and the L0–L5 loop are in [AGENTS.md](../AGENTS.md); the authoritative scope and layer catalog are
in [verification](../docs/agent/verification.md#test-layers).

## Runner

`node --test` on Node 24, which strips TypeScript types, so tests and sources use erasable syntax
only (no `enum`, `namespace` or parameter properties). `npm test -- <files>` runs named files
without building the affected graph. Bare `npm test` runs all non-rig files with two workers,
then all rig files serially, including after non-rig failures. `conformance/` holds behavior suites, `property/`
holds fast-check suites with fixed seeds, `e2e/` holds Electron runners.

`scripts/test.mjs`, `scripts/affected-tests.mjs` and the Windows suite (`scripts/test-windows.mjs`)
preload `helpers/leftover-children.ts` into every test file's process: a file that still has a
child process running after its own `after` hooks fails by name, instead of never exiting and
holding a runner slot. Stop what a test starts:
a core's `stop()` (or core-lite's `close()`), a `ProcessSandbox`'s `dispose()`. On Linux,
sandbox-runtime's socat bridges run until the last sandbox is disposed.

Each batch also runs with `TMPDIR`, `TMP` and `TEMP` set to a folder of its own (`/tmp/gt-…` off
Windows, or in the inherited temp folder where `/tmp` is not writable), removed when the batch
ends, so what a test leaves in the temp folder does not pile up.

CI partitions literal test groups with direct callbacks. Ordinary groups stay whole; the large
`harness incidents` suite is split into direct test subtrees, with each test's runtime descendants
and per-case hooks intact. It may not gain once-only parent hooks or dynamic direct registration.
Seed groups stay whole; their short `seed upgrade` root uses its direct case names to avoid matching
other roots with the same prefix. Unsupported or ambiguous shapes fail planning instead of losing coverage.

A test that runs the compiler spawns `packageBin('typescript', 'tsc')` from
`scripts/package-bin.ts` (TypeScript 7), not a `node_modules` path; one that builds a program
through the JS API imports `@typescript/typescript6`.

## Helpers (`helpers/`)

- `core-lite.ts`: a real `StudioCore` after `init()` without the harness or engines. Its folders
  are real paths: the development containment check refuses a games root reached through a link
  (macOS `/var` → `/private/var`), so a test passing its own `gamesRoot` hands it a `realpath`.
- `resources.ts`: the read-only resources folder a core needs. Import it, not `studio-rig.ts`,
  when you only need resources: anything that reaches the rig runs in the serial rig group.
  `sharedResources()` assembles one read-only tree per test process for rig/core-lite defaults;
  `makeResources()` always creates a fresh mutable tree, including compiler-off fixtures.
- `studio-rig.ts`: the full rig with the harness loop; slow and sequential (L3).
- `ctx-recorder.ts`: a fake harness `ctx` that records `ctx.call` sequences
  (`conformance/loop-sequences.test.ts`). Like the real host it refuses an unknown method
  (`UnknownMethod`) and path-bearing params `HARNESS_PARAM_SCHEMAS` rejects (`InvalidParams`).
- `fake-studio-api.ts`: a renderer-side `StudioApi` fake. `conformance/renderer-state.test.ts`
  drives the Zustand stores through `createStudio` with it, with no DOM.
- `fake-ollama.ts`, `scripted-claude.ts`, `scripted-codex.ts`: scripted engines, no network.
  `fake-anthropic.ts`: enough of Anthropic's Messages API for the real Claude Code CLI to run one
  scripted worker command (`ANTHROPIC_BASE_URL`, a dummy OAuth token, nothing billed).
  `fake-openai-responses.ts`: the same for the real Codex CLI over OpenAI's Responses API (a custom
  model provider, no sign-in).
- `snapshot-fixtures.ts`: dirty, untracked and nested user repositories.
- `unreal-lead-host.ts`: a fake host for the Unreal runner's lead (its scripted turns calling the
  run tools, the editor's answers, the clock), whose moments run on `unreal-moment-bus.ts`, a fake
  of Genex's hook bus that plans each moment from a plugin manifest;
  `unreal-editor-stand-in.ts`: the editor the Unreal plugin's queue talks to;
  `unreal-fake-engine.ts`: a small fake Unreal (the Blank template and Epic's three plugin
  templates) and the Unreal plugin's backend on it in an open game, launches and host calls recorded,
  a game link kept as the host keeps it, and stand-in programs for a plugin's build, tests and package.
- `godot-fake-engine.ts`: a fake Mac with Godot apps where the test puts them, a runner that
  records each Godot job and answers with Godot's recorded words (`fixtures/godot-cli/`), and the
  Godot plugin's backend on both in an open game, its host calls recorded.
- `unity-editor-stand-in.ts`: a Unity project folder, the descriptor Unity's Pipeline package
  keeps in it while an editor has it open, and a stand-in for that editor's HTTP server (scripted
  answers, every request recorded, a clock only `sleep` moves) as the Unity plugin's `PipelineDeps`;
  a Mac's folders with editors installed as Unity Hub lays them out (`macEnv`, `fakeEditor`), a
  process table whose signals a test decides (`processTable`, `editorRow`), and a call's binding as
  the host hands it to the plugin's backend (`pluginContext`). `unity-backend.ts`: the Unity
  plugin's backend on all of those in a game folder (`backendOn`: its tools by `call`, its panel's
  actions by `act`), with launches recorded and an opened editor started as a process with its
  descriptor.
- `loop-host.ts`: a fake host for the one Loop (`runDirector` on a project of any kind): a real git
  repository as the game folder, the moments a plugin manifest hooks on `unreal-moment-bus.ts`, and
  the lead's scripted turns, the pool's workers and the reviewer as three kinds of delegation, on
  the test's clock; `dispatch()` starts the run through the run's start instead, on the wall clock.
- `observe-windows.ts`: fake preview windows for a plugin's `observe` with a `still` or a `clip`
  (Live and the pooled windows, each logging what it was asked, over a page the test scripts), a
  real core over them (`observeHost`) and budgets on a clock the test holds (`heldClock`).
- `director-run.ts`: a director's run without a rig (`fakeLoopRun`, `fakeClock`, `lead`).
- `play-viewer-rig.ts`: Play's viewer over recording fakes (the game's view, the bar's layer, the
  gallery, comments, the coin client, the sign-in, the browser) on a clock the test moves, every call
  in `log`; `sheet()` is the purchase sheet as last drawn.
- `project-fixtures.ts`: the synthetic project folders in `fixtures/projects/` (`copyProject`
  copies one into a test's folder and adds the files its engine writes while it runs), reads of a
  listed game's facts, a fake harness `ctx` whose `game.*` calls reach a `coreLite`, and a plugin
  registry with the toy engine plugin (`fixtures/toy-engine-plugin/`) installed.
- `roblox-helper.ts`: stand-ins for the Roblox plugin's helper link: Roblox Studio as StudioMCP lists
  it (each Studio with the helper's session marker), a clock the test moves by hand, and the Genex
  helper over an in-memory connection or a real WebSocket.
- `roblox-mac.ts`: a fake Mac for the Roblox plugin's backend (Studio's app a stand-in; home, storage
  and games real temporary folders; Studio's running, answering and open places set by the test)
  and `hostFor`, Genex's side of a plugin call in one game, keeping links as the host does.
- `roblox-models.ts`: small synthetic glTF models for the Roblox plugin's asset gate (a GLB writer, a
  cube made of grids, a real grey PNG of any size) and the builders of `fixtures/roblox-models/`,
  each model failing the gate for one reason; `writeModelFixtures` writes them again.
- `engines.ts`: the Unreal plugin's and the toy engine's `engine` declarations, read from their
  manifests, and a catalog of both (what `PluginRegistry.engines()` answers), for linking games.
- `plugin-author.ts`: the Genex plugin's plugin-author skill read as an agent reads it (`genex__skill`,
  page by page) and its example plugin written into a project where the skill says.
- `worker-chat.ts`: a game chat with a run started in it, fake engines (two delegated, one local)
  that record each request, a copy of the game in that run's folder and the chat's permission rows,
  for worker seats and their questions (`worker-seats`, `worker-questions`,
  `chat-workers`), agent jobs through a `jobSpawn` the test gives it (`job-tools`), and `app_look`
  through the stub port and a recording `screenAccess` (`app-look-tool`). Its waits are on what
  happened (`untilSeen`, `nextCard`), never on a clock.
- `worker-pool-host.ts`: a fake host for the seed's worker pool (real git in a temporary game and
  its copies, worker sessions the test ends, every record the pool appends), for `worker-pool` and
  `worker-events`.
- `isolated-import.ts`: imports a module in a worker thread of its own and answers with its
  exports' types or the error that stopped it linking. Node never frees a linked module, so a test
  that loads a whole harness from one fresh workspace after another (`seed-upgrade`) links each in
  a worker; otherwise every copy stays in the file's heap and a CI runner's heap runs out.
- `git.ts`, `tmp.ts`: temporary repositories and directories with cleanup. A test removes its own
  temporary folder with `removeTree` (or leaves it to `tmpDir`), not a bare `rm`: on Windows a
  sandboxed test file's srt-win entries re-propagate through all of `%TEMP%` and hold each folder
  open while they do, and a bare removal then fails with `EBUSY`. `removeTree` waits such a hold
  out.
- `seed-upgrade-fixture.ts`: a per-process initialized snapshot for immutable vintage inputs;
  each upgrade case gets independent physical workspace and manifest copies and unique import paths.
- `claude-rules.ts`: whether Claude Code would deny a path by an absolute rule, matched as CLI
  2.1.281 does (node-ignore, case-blind) for the shapes `claude-permissions.ts` writes.
- `leftover-children.ts`: the runners' per-file check for child processes left running (above).
- `pe-image.ts`: minimal Windows PE images naming the DLLs a test gives (import and delay-load
  tables, a machine type), for the package's Visual C++ runtime checks.
- `processes.ts`: `running(pid)`, whether a process still runs. A test that proves a stop left
  nothing behind asks it, not `process.kill(pid, 0)`, which also finds a process that exited but
  is not reaped yet.

Characterization so far: the `api()` keys and `StudioCore` surface (`core-surface`, `rpc-surface`),
the seed contracts the app keeps its own copy of (`seed-contracts`), spike snapshot/worktree
sequences (`loop-sequences`), snapshots of a user's own repository (`snapshots`), which loop runs a
run, the tools each lead is offered and the one Loop's and the Unreal runner's calls, events, graph
and journal (`loop-survival`), the one Loop on a project that isn't a web game (`one-loop`), which
Loop a run gets (`one-loop-dispatch`), a whole Loop through the real studio on a plugin's project
and on a folder with no plugin (`one-loop-projects`, L3), and the ten use cases of any project
(`project-use-cases`; a test marked `todo` names the phase that turns it green, and a marked test
whose body passes prints `✔ … # phase N:` under `--test-reporter=spec`: that phase removes its
mark). Not yet: autopilot, gauntlet and facet-loop sequences, and golden `studio:dev` snapshots of
the `app-basics`, `chat-history` and `run-controls` fixtures; until then those paths rely on the rig
suites and the source gates in the allowlisted tests.

## Fixtures (`fixtures/`)

`harness-ok/` is a minimal harness, `games/` holds code-shape samples, `projects/` holds the
kinds of project Genex opens, `toy-engine-plugin/` holds a made-up engine's plugin,
`asset-previews/` holds format samples, `transcripts/` holds recorded provider streams. Keep
fixtures small and synthetic.

## Electron runners (`e2e/`)

`run-*.mjs` runners need a logged-in macOS GUI session and take 2–12 minutes. Run one with
`npm run test:ui -- <name>` (for example `build-smoke`, `shapes-e2e`, `studio-ui`); most need
`npm run build` first. They use disposable fixture profiles. `run-provider-live.mjs`,
`run-bonsai-live.mjs` and `run-clean-provider-profiles.mjs` touch live providers or accounts:
run them only with explicit permission. Evidence goes to `.studio-dev/evidence/`.

## Windows suite

`tests/windows-suite.json` is the Windows CI's required suite
([verification](../docs/agent/verification.md#test-layers)). When a test file is meaningful on
Windows and passes there, add it, sorted; `windows-suite.test.ts` refuses missing, duplicate,
unsorted and rig entries. A file that changes the whole machine (a reservation of the sandbox's
proxy ports) is listed in `RUN_ALONE` in `scripts/test-windows.mjs`, which runs it after the rest,
one at a time. A POSIX-only case skips on `win32` with its reason; don't drop the
file from the list for it. The informational fast-group report (a Windows dispatch with
`backlog`) lists the files still to fix and the clean ones ready to add.

## Machine-dependent tests

Tests that read local projects or open the network are skipped unless opted in:
`STUDIO_LOCAL_FIXTURES=1` for local projects, `STUDIO_NETWORK_TESTS=1` for real network and
local Ollama probes (on Windows also Local Blender's real download and a sandboxed job,
`blender-windows-live.test.ts`), `STUDIO_GODOT_LIVE=1` for the Godot plugin against this Mac's own Godot
(`godot-live.test.ts`), `STUDIO_CLAUDE_CLI_TESTS=1` for the real Claude Code CLI against
`fake-anthropic.ts` (`claude-studio-shell-cli.test.ts`, `claude-tool-loading.test.ts`),
`STUDIO_CODEX_CLI_TESTS=1` for the real Codex CLI against `fake-openai-responses.ts`
(`codex-sandbox-cli.test.ts`). Never make a default test depend on this machine. `STUDIO_RIG_UNSANDBOXED=1`
runs rigs without the process sandbox, for a container where it cannot start (no user
namespaces); containment cases prove nothing there, and CI keeps the sandbox.
