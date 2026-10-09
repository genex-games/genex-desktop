# Tests

Root rules and the L0–L5 loop are in [AGENTS.md](../AGENTS.md); the authoritative scope and layer catalog are
in [verification](../docs/agent/verification.md#test-layers).

## Runner

`node --test` on Node 24, which strips TypeScript types, so tests and sources use erasable syntax
only (no `enum`, `namespace` or parameter properties). `npm test -- <files>` runs named files;
bare `npm test` runs everything sequentially. `conformance/` holds behavior suites, `property/`
holds fast-check suites with fixed seeds, `e2e/` holds Electron runners.

`scripts/test.mjs` and `scripts/affected-tests.mjs` preload `helpers/leftover-children.ts` into
every test file's process: a file that still has a child process running after its own `after`
hooks fails by name, instead of never exiting and holding a runner slot. Stop what a test starts:
a core's `stop()` (or core-lite's `close()`), a `ProcessSandbox`'s `dispose()`. On Linux,
sandbox-runtime's socat bridges run until the last sandbox is disposed.

A test that runs the compiler spawns `packageBin('typescript', 'tsc')` from
`scripts/package-bin.ts` (TypeScript 7), not a `node_modules` path; one that builds a program
through the JS API imports `@typescript/typescript6`.

## Helpers (`helpers/`)

- `core-lite.ts`: a real `StudioCore` after `init()` without the harness or engines. Its folders
  are real paths: the development containment check refuses a games root reached through a link
  (macOS `/var` → `/private/var`), so a test passing its own `gamesRoot` hands it a `realpath`.
- `resources.ts`: the read-only resources folder a core needs. Import it, not `studio-rig.ts`,
  when you only need resources: anything that reaches the rig runs in the serial rig group.
- `studio-rig.ts`: the full rig with the harness loop; slow and sequential (L3).
- `ctx-recorder.ts`: a fake harness `ctx` that records `ctx.call` sequences
  (`conformance/loop-sequences.test.ts`). Like the real host it refuses an unknown method
  (`UnknownMethod`) and path-bearing params `HARNESS_PARAM_SCHEMAS` rejects (`InvalidParams`).
- `fake-studio-api.ts`: a renderer-side `StudioApi` fake. `conformance/renderer-state.test.ts`
  drives the Zustand stores through `createStudio` with it, with no DOM.
- `fake-ollama.ts`, `scripted-claude.ts`, `scripted-codex.ts`: scripted engines, no network.
- `snapshot-fixtures.ts`: dirty, untracked and nested user repositories.
- `unreal-lead-host.ts`: a fake host for the Unreal Loop's lead (its scripted turns calling the
  run tools, the editor's answers, the clock);
  `unreal-editor-stand-in.ts`: the editor the Unreal plugin's queue talks to.
- `project-fixtures.ts`: the synthetic project folders in `fixtures/projects/` (`copyProject`
  copies one into a test's folder and adds the files its engine writes while it runs), reads of a
  listed game's facts, a fake harness `ctx` whose `game.*` calls reach a `coreLite`, and a plugin
  registry with the toy engine plugin (`fixtures/toy-engine-plugin/`) installed.
- `worker-chat.ts`: a game chat with a run started in it, fake engines (two delegated, one local)
  that record each request, a copy of the game in that run's folder and the chat's permission rows,
  for worker seats and their questions (`worker-seats`, `worker-questions`, `dont-wait`,
  `chat-workers`), agent jobs through a `jobSpawn` the test gives it (`job-tools`), and `app_look`
  through the stub port and a recording `screenAccess` (`app-look-tool`). Its waits are on what
  happened (`untilSeen`, `nextCard`), never on a clock.
- `worker-pool-host.ts`: a fake host for the seed's worker pool (real git in a temporary game and
  its copies, worker sessions the test ends, every record the pool appends), for `worker-pool` and
  `worker-events`.
- `git.ts`, `tmp.ts`: temporary repositories and directories with cleanup. A test removes its own
  temporary folder with `removeTree` (or leaves it to `tmpDir`), not a bare `rm`: on Windows a
  sandboxed test file's srt-win entries re-propagate through all of `%TEMP%` and hold each folder
  open while they do, and a bare removal then fails with `EBUSY`. `removeTree` waits such a hold
  out.
- `claude-rules.ts`: whether Claude Code would deny a path by an absolute rule, matched as CLI
  2.1.281 does (node-ignore, case-blind) for the shapes `claude-permissions.ts` writes.
- `leftover-children.ts`: the runners' per-file check for child processes left running (above).
- `processes.ts`: `running(pid)`, whether a process still runs. A test that proves a stop left
  nothing behind asks it, not `process.kill(pid, 0)`, which also finds a process that exited but
  is not reaped yet.

Characterization so far: the `api()` keys and `StudioCore` surface (`core-surface`,
`rpc-surface`), the seed contracts the app keeps its own copy of (`seed-contracts`), spike
snapshot/worktree sequences (`loop-sequences`), snapshots of a user's own repository
(`snapshots`), which loop runs a run, the tools each lead is offered and the Unreal lead's editor
calls, events, graph and journal (`loop-survival`), and the ten use cases of any project
(`project-use-cases`; a test marked `todo` names the phase that turns it green, and a marked
test whose body passes prints `✔ … # phase N:` under `--test-reporter=spec`: that phase removes
its mark). Not yet: autopilot, gauntlet and facet-loop sequences, and golden `studio:dev`
snapshots of the `app-basics`, `chat-history` and `run-controls` fixtures; until then those paths
rely on the rig suites and the source gates in the allowlisted tests.

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
unsorted and rig entries. A POSIX-only case skips on `win32` with its reason; don't drop the
file from the list for it. The informational fast-group report (a Windows dispatch with
`backlog`) lists the files still to fix and the clean ones ready to add.

## Machine-dependent tests

Tests that read local projects or open the network are skipped unless opted in:
`STUDIO_LOCAL_FIXTURES=1` for local projects, `STUDIO_NETWORK_TESTS=1` for real network and
local Ollama probes. Never make a default test depend on this machine. `STUDIO_RIG_UNSANDBOXED=1`
runs rigs without the process sandbox, for a container where it cannot start (no user
namespaces); containment cases prove nothing there, and CI keeps the sandbox.
