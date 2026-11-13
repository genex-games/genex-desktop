# Tests

Root rules and the test-first loop are in [AGENTS.md](../AGENTS.md); the authoritative scope table and the
L0–L5 layer catalog are in [verification](../docs/agent/verification.md#test-layers).

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
sandbox-runtime's socat bridges run until the last sandbox is disposed. Node runs a file's root
`after` hooks once the tests registered so far have ended, so the check also waits for tests a
file registers after a top-level await (it follows `node:test`'s `node.test` trace).

Each batch also runs with `TMPDIR`, `TMP` and `TEMP` set to a folder of its own (`/tmp/gt-<pid>-…`
off Windows, or in the inherited temp folder where `/tmp` is not writable), removed when the batch
ends, so what a test leaves in the temp folder does not pile up. A file run directly with
`node --test` puts its `tmpDir`s in a `gt-<pid>-…` folder of its own the same way. A run killed
before its cleanup leaves its folder: each batch first removes every `gt-` folder whose owner
process is gone, or that sat unchanged for a day (`scripts/test-tmp.mjs`).

CI partitions literal test groups with direct callbacks. Ordinary groups stay whole; the large
`harness incidents` suite is split into direct test subtrees, with each test's runtime descendants
and per-case hooks intact. It may not gain once-only parent hooks or dynamic direct registration.
Seed groups stay whole; their short `seed upgrade` root uses its direct case names to avoid matching
other roots with the same prefix. Unsupported or ambiguous shapes fail planning instead of losing coverage.

A test that runs the compiler spawns `packageBin('typescript', 'tsc')` from
`scripts/package-bin.ts` (TypeScript 7), not a `node_modules` path; one that builds a program
through the JS API imports `@typescript/typescript6`.

## Helpers (`helpers/`)

Before writing a helper, list `tests/helpers/` and read [its catalogue](helpers/README.md): what
each helper stands in for and which tests use it. The catalogue is not complete, so the folder
listing wins. Three rules from it apply to every test:

- Import `resources.ts`, not `studio-rig.ts`, when you only need resources: anything that reaches
  the rig runs in the serial rig group.
- A test that passes its own `gamesRoot` to `core-lite.ts` hands it a `realpath`: the development
  containment check refuses a games root reached through a link (macOS `/var` → `/private/var`).
- Remove a temporary folder with `removeTree` (or leave it to `tmpDir`), not a bare `rm`, and ask
  `running(pid)` from `processes.ts`, not `process.kill(pid, 0)`, whether a process still runs.

Characterization so far: the `api()` keys and `StudioCore` surface (`core-surface`, `rpc-surface`),
the seed contracts the app keeps its own copy of (`seed-contracts`), a chat turn, Stop and the
build a chat turn launched (`loop-sequences`), snapshots of a user's own repository (`snapshots`), which loop runs a
run and the one Loop's calls, events, graph and journal on an Unreal game (`loop-survival`), the one Loop on a project of any kind (`one-loop`), which
Loop a run gets (`one-loop-dispatch`), a whole Loop through the real studio on a plugin's project
and on a folder with no plugin (`one-loop-projects`, L3), and the ten use cases of any project
(`project-use-cases`; a test marked `todo` names the phase that turns it green, and a marked test
whose body passes prints `✔ … # phase N:` under `--test-reporter=spec`: that phase removes its
mark). Not yet: golden `studio:dev` snapshots of the `app-basics`, `chat-history` and
`run-controls` fixtures; until then those paths rely on the rig suites and the source gates in the
allowlisted tests.

## Fixtures (`fixtures/`)

`harness-ok/` is a minimal harness, `games/` holds code-shape samples, `projects/` holds the
kinds of project Genex opens, `toy-engine-plugin/` holds a made-up engine's plugin,
`asset-previews/` holds format samples, `transcripts/` holds recorded provider streams,
`kept-seed/` holds Loop modules of an earlier seed as an agent may have kept them (`.txt`, so
nothing checks them as this tree's code). Keep fixtures small and synthetic.

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
local Ollama probes (on Windows also Local Blender's and Godot's real downloads and sandboxed
jobs, `blender-windows-live.test.ts` and `godot-windows-live.test.ts`, and a Play game's reach to
Genex's API, `windows-game-live.test.ts`), `STUDIO_GODOT_LIVE=1` for the Godot plugin against this Mac's own Godot
(`godot-live.test.ts`), `STUDIO_CLAUDE_CLI_TESTS=1` for the real Claude Code CLI against
`fake-anthropic.ts` (`claude-studio-shell-cli.test.ts`, `claude-tool-loading.test.ts`, `claude-steer-cli.test.ts`),
`STUDIO_CODEX_CLI_TESTS=1` for the real Codex CLI against `fake-openai-responses.ts`
(`codex-sandbox-cli.test.ts`), `STUDIO_GROK_CLI_TESTS=1` for the real Grok Build CLI in the real
sandbox against `fake-xai-responses.ts` (`grok-cli-live.test.ts`; `STUDIO_GROK_BIN` names one, which
must sit outside `~/.grok`: the test's sandbox denies the person's own Grok home). `STUDIO_ANTIGRAVITY_CLI_TESTS=1`
runs the real Antigravity CLI in the real sandbox on the Google account it is signed in to
(`antigravity-cli-live.test.ts`; it uses that account's plan, so only with permission). Never make a default test depend on this machine. `STUDIO_RIG_UNSANDBOXED=1`
runs rigs without the process sandbox, for a container where it cannot start (no user
namespaces); containment cases prove nothing there, and CI keeps the sandbox.
