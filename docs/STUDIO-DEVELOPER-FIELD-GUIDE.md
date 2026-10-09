# Studio developer field guide

Run commands from the repository root with Node 24 (`nvm use` reads `.nvmrc`). First-time setup
is in [CONTRIBUTING](../CONTRIBUTING.md#set-up). `package.json` and the lockfile own current
dependencies; install them with `npm ci` once, not before every restart or check.

## Run an owned development profile

For repeatable UI work without model calls:

```sh
npm run studio:dev -- start --profile ui-review --fixture app-basics
npm run studio:dev -- status --profile ui-review
npm run studio:dev -- restart --profile ui-review
npm run studio:dev -- stop --profile ui-review
```

Fixture windows are normally parked offscreen. For a human reviewing fixture data, set
`STUDIO_FIXTURE_INTERACTIVE=1` on start/restart. Fixtures keep provider and credential
restrictions; they do not establish authentication, model quality or hosted readiness.

A request to run the real app for manual testing authorizes a visible owned live profile.
For “no mocks”, do not substitute fixture mode. Leave the session running for the person
testing; stop it only when requested or when its agreed task is complete. Report the source
revision, build ID, profile and provider mode at handoff. Use a new named profile:

```sh
npm run studio:dev -- start --profile manual-review --providers live
npm run studio:dev -- status --profile manual-review
# When the person is finished and requests a stop:
npm run studio:dev -- stop --profile manual-review
# Reopen that retained profile after stopping it:
npm run studio:dev -- start --profile manual-review --providers live --reuse
```

To meet the app as a new account does, with no Claude Code, Codex or sign-in to borrow, add
`--fresh-machine` to the live start. That profile is disposable: its app gets an empty home in
the temporary folder as HOME (outside the checkout, where the app never takes a CLI from; it
links your login keychain, which macOS finds through HOME), the system PATH,
none of the caller's provider variables, and a Claude Code Keychain item named after the
profile's own folder ([fresh-machine.ts](../scripts/studio-dev/fresh-machine.ts)).
Machine-wide installs still count, as on a new account: Homebrew, `/usr/local/bin` and the
ChatGPT app's Codex in `/Applications`.
`shell --profile <name>` opens that account's terminal for installing and signing in by hand, and
its `npm install -g` stays in the profile. A Claude Code sign-in leaves a
`Claude Code-credentials-<hash>` item in your login keychain that neither sign-out nor `clean`
removes; delete it in Keychain Access when you like.

A live launch keeps the caller's environment except its agent session's own variables: the
keys and endpoint it routes model calls through, Claude Code's and the Agent SDK's switches, the
session's nesting, effort, context, timeout, MCP and OAuth markers, and `ELECTRON_RUN_AS_NODE`
([live-env.ts](../scripts/studio-dev/live-env.ts); the eval lanes strip the same routing names and
prefixes). `CLAUDE_CONFIG_DIR` and `CODEX_HOME` stay: they are your choice of account. A
`CLAUDE_CODE_OAUTH_TOKEN` login is not carried into a live launch (it shows in `envStripped`);
pick the account with `CLAUDE_CONFIG_DIR` instead. The start JSON names what it dropped (`envStripped`, never values). Start and status
warn (`games-root-under-claude-folder`) when the profile's games sit under a `.claude` folder,
as in a worktree under `.claude/`, where native Claude Write refuses or asks
([live acceptance](#full-regression-and-failure-evidence)).

Live profiles isolate Studio data, not all machine accounts, Keychain, quotas, local models
or compute. They do not copy credentials. Follow the [credential restriction](agent/verification.md#credentials)
for account-connected checks. Preserve active user work; inspect ownership/status before a restart.

The controller builds immutable output under `.studio-dev/builds/<id>` and returns actual
readiness and profile/build/source/runtime identity. Rebuilding does not update a running app.
Use the controller to stop owned sessions; a PID alone is not authority to signal a process.
`clean --profile <name>` removes only stopped recognized disposable state. Retained live
profiles, evidence and normal games are not disposable fixture cleanup.

See [owned sessions](agent/verification.md#owned-development-sessions) for fixtures, bounded
UI requests, desktop/game captures and diagnostics. A desktop capture does not include the
separate native game view.

## Normal profile and packaged app

`npm start` rebuilds and launches the normal profile, with your own games and accounts (agents
use it only when asked). Quit any running instance first. Closing a window may leave the process
alive. `open` can focus an existing process and is not proof of a fresh launch.

```sh
npm run package
open "out/Genex-darwin-arm64/Genex.app"
```

The package targets macOS on Apple Silicon (see [release readiness](release-readiness.md) for the platform matrix).
Packaging is needed for delivery/resource checks, not every edit. `npm run watch` rebuilds
resources, including plugins; restart an owned profile when changed host code needs reloading.
Watch and owned `--dev-build` builds bundle React's development build (StrictMode replays and
warnings); the UI clears its per-render timing measures each minute there. `npm run build`,
`npm start` and packages ship the production build.

## Data and memory locations

| Location | Purpose |
| --- | --- |
| `docs/`, `AGENTS.md` | Maintained developer knowledge and instructions |
| `.studio-dev/notes/<task>.md` | Short local note for unfinished development work |
| `.studio-dev/evidence/<task>/` | Local verification reports, screenshots and identities |
| `.studio-dev/profiles/<name>/` | Owned developer Electron, session, core and game roots |
| `~/Library/Application Support/Genex/` | Normal application profile (moved from `AI Game Studio/` on first launch) |
| Profile `workspaces/harness/` | Active editable game-building harness; upgrades preserve self-edits |
| Profile `engine-homes/`, `runs/`, `exoharness/` | Provider/plugin/runtime state, run artifacts and persisted events |
| Profile `scratch/`, `exports/` | App-managed build workspaces and export destinations |
| Profile `jobs/<game>/<id>/` | Agent jobs' records (`job.json`) and logs (`output.log`); the last 50 ended jobs per game are kept |
| Profile `opened-files/` | Read-only copies of build-only files a chat link opened in their app |
| Profile `Crashpad/` | Local crash dumps, never uploaded. Dumps hold process memory; review before sharing |
| Profile `run-sharing/` | Share build metrics' state, install identity and unsent rows (owner-only files) |
| `$GENEX_EVALS_HOME` (`~/.genex-evals`) | The eval ledger, run work folders, evidence, eval-owned builds and CLI homes ([evals](evals.md#eval-homes-and-operator-setup)) |
| `~/AI Games/` or the selected project folder | User game source; the project binding is authoritative |

Credential storage belongs to the host/provider. Never copy it into notes, games, prompts or
reports. Git SHA alone does not identify installed harness self-edits or provider/plugin versions.
[AGENTS.md](../AGENTS.md#documentation-and-prs) owns handbook updates, size limits and optional scratch notes.

## Find code and checks

Use the [product overview](agent/context.md) to select a topic and search the
[Feature Map](agent/feature-map.md) for the UI entry, required state and owning files.
Follow one operation from `src/shared/studio-api.ts` through preload and the matching main
handler to `studio-core.ts`. Engine adapters live in `src/substrate/engines`; in-app roles
live in `src/harness-seed`. Source ownership and suggested commands are listed by
`npm run review:context -- --area <id>`.

Select checks using [verification scope](agent/verification.md#choose-the-verification-scope).
A local visual edit needs rendered review; behavior needs its relevant tests and immediate
connections. Use `npm run verify` for broad integration, and packaging acceptance when delivery
changes. Reuse passing evidence while relevant inputs remain unchanged. Full-suite success,
fixture success and account-connected acceptance are separate claims.

## Plugin authoring

```sh
npm run plugin:new -- my-plugin --out /absolute/path/to/packages
npm run plugin:doctor -- /absolute/path/to/packages/my-plugin --json
npm run plugin:pack -- /absolute/path/to/packages/my-plugin /absolute/path/to/releases/my-plugin.json
```

See [Plugin guide](PLUGIN_GUIDE.md) for SDK and local debugging, [marketplace preparation](../marketplace/README.md)
for portable catalog generation, and [release readiness](release-readiness.md) for outstanding
acceptance boundaries. Historical plans, PR status snapshots and session journals are recovered
from Git only when needed; this guide describes the current workflow.

## Full regression and failure evidence

Timing-sensitive full runs require an awake machine. On macOS, `caffeinate -i npm run verify`
uses an assertion scoped to that command; it does not change power settings or prevent lid
closure. Preserve sleep/wake evidence if a deadline test crosses system sleep; do not
weaken the assertion or extend its deadline to turn that interruption into a pass.
Facet Git failures include exit code, signal, timeout and elapsed time even with empty output.

Sequential rig scenarios in `gauntlet`, `skillopt` and `facet-loop-v2` stop their
rigs in `afterEach`, after all behavioral assertions. Do not retain completed harness
processes/HTTP servers until file teardown or swallow their cleanup failures. A passing
isolated retry does not clear an aggregate failure: retain the failed log and termination
reason. Diagnose with affected files; rerun the aggregate when needed to prove an aggregate-only
failure is resolved. Resume unaffected/unrun stages without repeating already valid passes;
a focused task does not acquire a full-suite requirement merely because one check failed.
`spawn git EAGAIN` is a host
spawn refusal, not proof of a judge defect; a missing historical termination reason stays
unknown. No increased deadlines, automatic command replay or weakened assertions are part
of this cleanup correction. Git startup uses bounded admission recovery only for a
`spawn ... EAGAIN` refusal with no child PID (100/250 ms, at most three starts).
`process-start.test.ts` asserts that an executed command, signal, exit failure, missing
executable or non-spawn error is never retried; cancellation prevents another start.
Scripted director/incident/facet tests use `tests/helpers/git.ts` for real Git with the
same admission handling while retaining their caller environment and committer.

Local checkpoint acceptance must cross a configured threshold in a real Bonsai session and
retain both old requirements and later corrections. `bonsai.test.ts` separately checks that
output-limited summaries cannot replace a complete checkpoint and successful summary inference
contributes to reported resource usage. A failed live checkpoint is retained as failure evidence,
even when no files or completed actions were lost. The director-monitor regression includes
worker/results/lifecycle diagnostics on timeout; its ownership assertion and deadline stay intact.
Claude stream activity assertions include the return to thinking after a tool result. Director
monitor checks must preserve unread events between successive waits, report each once, and
retain Git porcelain path columns. Native SDK authoring checks distinguish retained process
logs (`maxOutputBytes`) from generated files (`maxAssetBytes`); doctor errors name the field.
For a real independent SDK check, author from the public kit, then exercise typed numeric
arguments, retrieval of the same completed files, changed-file refusal, active disable,
folder reload and standard settings through the custom panel. A local MCP process reading
actual game assets complements public HTTP acceptance; record its real filesystem result,
argv including spaces, project scope and same-session activation. Neither proves OAuth.

The full Electron game runner also accepts `node tests/e2e/run-electron-e2e.mjs --packaged`
after packaging; it retains the same game, capture and provider readiness assertions. The
portrait shape fixture uses a frameless window with explicit content size and permission to
exceed the screen size, so macOS title bars and work-area clamping cannot change its required
540×960 capture. Keep those pixel assertions; do not substitute the clamped window dimensions.

Codex image delivery: `engine-codex.test.ts` exercises the actual delegation/file bridge,
requiring attached inspection bytes to become readable temporary image files alongside the
response, with the inspection ID preserved and cleanup after delegation. Testing only the
`onLiveTool` callback does not prove that the native provider receives the image.

Genex asset outcomes: `genex-outcomes.test.ts` guards download versus runtime loading, matching
inspection IDs, Stop and conservative per-file audio verification. `genex-plumbing.test.ts`
checks status and image results through all provider paths with fixture engines. The Electron
self-test creates an explicitly synthetic delivered image, loads it through the real preview,
and requires observed loading plus a captured image; it does not claim semantic visual approval
or service billing. Five local WAV fixtures cover playing, silent, muted, paused and failed
media in Chromium; silent remains unverified while another file plays. Unsupported audio
paths remain unavailable. Paid account acceptance remains a separate live gate. Inspect raw failure
logs even when an isolated retry passes: sandbox-runtime's one-second executable lookup has
intermittently reported a missing bash during loaded test runs.

Unity retirement: the active app supports browser games only. The CLI, editor, bridge, Unity templates, tools and UI are archived in `archive/unity/`; no feature flag enables them. There is no Unity-specific compatibility or migration path. Ordinary browser-project validation remains. Historical Unity plans describe archived behavior; existing user work and the source archive remain preserved.

Full regression coverage: `npm run typecheck`, `npm test`, `npm run test:e2e` (real sandbox, scripted
Ollama wire, Chromium and CSS), `npm run test:build-ui` (build/history fixture, and since M1.8
part of `npm run verify` — the composer Stop control and the keep-awake blocker are
only provable in a real window).
`npm run package` followed by `npm run test:packaged` covers main/preload/resources/asar, the
packaged binary's fuses and the sandbox-runtime helpers the package carries; it finds
`out/Genex-<platform>-<arch>` (`STUDIO_PACKAGE_DIR` overrides) on macOS and Linux (under
`xvfb-run -a` there). On macOS it also requires `codesign --verify --deep --strict` and a
signature named for the bundle id, an ad-hoc build's too: macOS refuses an app whose signature does
not bind its Info.plist the Desktop and Documents without asking. `STUDIO_EXPECT_SIGNED=1` adds a
notarized Developer ID verdict from `spctl` and the signed entitlements. `npm run make -- --platform
darwin --arch arm64` also writes the dmg and zip to `out/make` (`--platform linux --arch x64`: deb,
rpm, zip). Package only in a checkout with its own `node_modules`: a symlinked one is copied as a
link and pruned in place, so the `prePackage` hook refuses it. On Windows, `node
tests/e2e/run-squirrel-install.mjs` installs `Genex-Setup.exe` for the current user, checks its
shortcuts and path lengths, then uninstalls it. CI: `package.yml` makes and smokes unsigned packages on
PRs into `main` and pushes to `main` (with that install on Windows, and there a packaged fixture chat turn:
`node tests/e2e/run-electron-e2e.mjs --packaged`), and a dispatch with `only` (`darwin`, `linux` or `win32`)
builds one platform; `release.yml` signs, notarizes, verifies and uploads to a draft release ([release operations](release-operations.md)).
Optimization UI replay additionally needs prior AG-931 result data; it is conditional, not a
clean-checkout gate. Seed-upgrade, interrupted, snapshots, sandbox, harness-host and
self-improving conformance tests protect product behavior. Native login/picker/download
verification requires separate explicit prerequisites; fixtures do not certify it.
`npm run test:computer:e2e` runs the real Electron with a fixture game: the computer tool over an
offscreen window (WebGL and WebGPU), the requested-state setup, agent screens on their Builds nodes, and a
scripted director's run end to end (worker, look, integrate, show, finish, landing).
It also checks secure contexts in Live and worker views. Register `game` and `studio-plugin`
privileges in one call before Electron is ready; a second registration loses the game's secure
context and disables WebGPU, while Three.js can silently render through its WebGL fallback.
`npm run test:shapes:e2e` is the milestone's own proof, and part of `npm run verify`. It opens
each of the five games under `tests/fixtures/games` as the user's own game — four of them with no
edit at all, the bundled one with the two-line `installStudio({ renderer, player })` — waits for
the page to report itself ready, shadow-builds the one that has a build, drives it, photographs
it and judges the evidence with the harness's own `gatherEvidence`; then drives the same five
again through the real Codex file bridge (the shim run as a child process, only the CLI scripted)
and the real in-process Claude MCP server (only the model scripted), and compares the two
observed tool surfaces. `summary.json` carries fifteen entries — five games by three transports —
each with its shape, its cameras, the milliseconds the page took to boot, the state paths that
moved and its own check list, plus two pages the runner carries for the capture rules (a canvas
with `alpha: true` over a coloured page, and a portrait window with a second canvas in the corner).
No model of any kind is started: the core is built with `engines: []`, no `--ollama-host` is
passed, and nothing installs a package — the one fixture that builds links the repository's own
`node_modules` and builds with esbuild. `--only <id>` and `--engine fixture|codex|claude` keep the
inner loop under ten seconds; the full regression gate runs the whole set.

`tests/conformance/director.test.ts` runs a whole run on the plain-Node rig, once per shape a
run can take — every `it` in its own describe block, so the list is read there rather than
counted here. They cover the finish and its landing; a game from scratch getting its base stage,
and a starting point that could not be built; the fork gate refusing a base that does not run and
exempting the run's own starting points; a game that cannot be judged until the contract is
installed, and a wiring session whose page still does not answer; a worker the lead stops
mid-round; a steer that interrupts a loop worker, a user steer addressed to one, and a steered
single session; the director's own commit becoming the head it lands; a landing that conflicts
with the user's own commits and changes nothing; a merge that carries nothing from a repository
inside the game, and a consented one whose landing is left to the user; a run whose director
dies of the engine's session limit; a run killed outright and then resumed; a reviewed plan
held for the user's go, and one the user answers in their own words; a worker's commit outliving
its worktree; the restored `.studio/DIRECTOR.md`; and a close that looks through the studio's
stand-in because the pool has none free, leaving the user's window alone. The head must be on
the run's ref, the close must look again and land on the judge's word, `landingResult` must say
what the landing may claim, the run must pause where it can be picked up, and `showBuild` /
`landBuild` must work on the head afterwards.
`tests/conformance/engine-limits.test.ts` covers limit classification, reset-time parsing and the
inherited-console rule.

The run's surface is verified by pure conformance suites and one real window.
`words.test.ts` is both a vocabulary test and a gate: it reads every `ctx.setStatus` literal
out of `src/harness-seed/loop/*.ts` (a call it cannot read fails the test rather than being
skipped) and asserts no run id, sha or ref survives translation, and that no renderer file but
words.ts holds a translation. `morning-words`/`run-graph`/`build-progress` replay synthetic director and probe fixtures (`tests/fixtures/director-loop-run.json` and
`tests/fixtures/nested-probes.json`) and pin what the morning
card, the Builds header and the stage say about it. `door.test.ts` covers the opening chat and
the run's promised clock, `stopped-round.test.ts` the grey stopped round, `sidebar.test.ts`
the ported rail's tokens, and `run-controls.test.ts` the one-Stop rule across the whole
renderer plus the keep-awake wiring in main. Behaviour that needs a window — the two chat Stop
controls, immediate thread cancellation, the blocker held past the request, the morning card
mounting — lives in the build smoke, which is why `npm run test:build-ui` is now part of `npm
run verify`. The Assets stage tab is covered by `assets-layout.test.ts`, `game-assets.test.ts` and
`canvas-view.test.ts` (grouping, deterministic non-overlapping rects, the read-only walk and join,
containment and size caps, the fit and zoom maths) and by five build-smoke checks that offer the
tab, hide the native game, render a real fixture delivery back through the contained reader, find
the delivery in the project's log and give the stage back to the game. A sixth appends the host's
own `plugin_tool_started` / `plugin_tool` pair and asserts the Builds graph draws the asset job
under the part that asked for it; `run-graph.test.ts` and `words.test.ts` pin the same payloads and
the chat's `TOOL` line without a window.

Milestones 2 and 3 added four suites of their own. `verdict.test.ts` pins the one record every
judged build leaves (`loop/verdict.ts`) and the sentence it hands the screen — including that
each pass of a real run writes one. `learning.test.ts` replays the first real run's journal
and then two rig runs on one game: the ledger's records, the lessons they add up to, the briefs
that carry them, the check that stops being written, the morning card's learned line, and what
SkillOpt sees in a director's run. `engines.test.ts` covers external Claude login wiring and explicitly injected SDK paths.
`external-cli.test.ts` covers discovery priority, spaces/symlinks, excluded project dependencies,
missing Node, incompatible commands, override persistence, update/removal, and no SDK fallback.
It also proves Stop kills an active diagnostic, both Claude SDK entry points refuse launch after
Stop during discovery, and an allocation expiring during discovery starts no builder.
Provider fixture tests preserve subscription-only billing, Stop and tool bridges.
For live Claude coding acceptance, use an ordinary project directory (for example under `~/AI Games`),
not a fixture nested under `.claude`: native Claude Write treats that ancestor as sensitive.
Require a successful native Write/Read pair; a shell fallback after a refusal is not that evidence.
Keep protected-path refusals intact. Record the explicit CLI path/version, requested/reported model,
session and actual tool result; a clean preview alone does not prove the requested write succeeded.


Milestones 2 and 3: the pure half (shapes read from evidence, adoption, sheet words, build memos,
the scoreboard, move ladder, ledger and verdict record) runs in `npm test` through the
`project-shape`, `game-build`, `snapshots`, `scoreboard`, `facet-loop-v2`, `learning`, `verdict`
and `words` suites. `director.test.ts`'s rig drives the real core and harness with scripted engines
for the nested-repository policy, plan review, interrupting steer and landing refusals; the build
smoke and `npm run test:computer:e2e` need a real window. No live account, real `npm install` or
vendor sign-in verifies M2/M3; those stay separate prerequisites.

Developer commands and acceptance coverage are described below; consult the AG-933
PR validation summary and linked evidence for actual execution results.
Do not treat an in-progress scenario as a passing capability. Source changes require rebuild
and restart for main/preload/resources; watch does not continuously copy resources. Explicit
profile reuse preserves evolved harness state; use fresh data for a clean-source assertion.

Capture desktop and game separately, inspect image content and actual postconditions. Record
per-check expected/observed, pass/fail/unverified, time and surface. Overall fail wins over
unverified; missing required evidence otherwise yields unverified. Exit codes for check runs
are 0/1/2 respectively. A successful lifecycle command is not a verification pass.

CPU profiles and V8 heaps address a selected webContents; Chromium traces are app-scoped.
They do not measure the sandboxed harness child's heap or all main/Node execution. Collect
on demand only; local dumps can contain application state. Exclude transient login data and
transport credentials from reports. No permanent monitor or performance threshold is implied.

## Owned development sessions

`npm run studio:dev -- start --profile ag-933 --fixture app-basics` builds current inputs
into `.studio-dev/builds/<build-id>`, creates fresh owned fixture state and returns actual
readiness/identity JSON. `npm run studio:dev -- fixtures` lists the named fixtures. Among them:
build-graph (two sword-in-ice runs: folded tries, an undone step, a lead-merged unjudged round),
lead-graph (two Unreal lead runs: milestone columns, save points, sub-agents with their cards, the
critic's advice on a round),
first-launch (an empty library and the welcome; Claude Code needs a sign-in, Codex is not
installed, and sign-in, links and downloads are refused as in every fixture) and notifications
(six games; about four seconds after launch a question, a plan, a plugin permission, a sign-out
and delivered, failed and stopped builds arrive as news; macOS notifications are refused) and
sandbox-setup (the window opens on "Set up the protected workspace" for a Linux machine missing
bubblewrap and socat, `[data-sandbox-setup]`; `[data-sandbox-retry]` opens the studio) and
update-ready (the sidebar offers `[data-update-restart]` for a stand-in Genex 0.2.0; the restart
itself is refused as native) and unreal-game (the game linked to a stand-in Unreal project inside
its folder with the Unreal plugin on: the chat's link line with Undo, the Unreal Live card, and the
steps card, whose rows come from the real plugin, so it stays hidden on a Mac whose Xcode is ready)
and unreal-chat (a short synthetic Unreal chat, `tests/fixtures/unreal-chat/sample-chat.json`:
connector rows in words, Worked in Unreal headings, failures, play views and a Blender delivery).
Use `--reuse` explicitly for a stopped existing profile with the same fixture/provider mode.
`--providers live` is explicit, retained, and uses existing ambient account semantics; no auth
or account copying is performed. Fixtures park background improvement but keep the real core,
event log, harness and ProcessSandbox. Native/external actions are refused in fixture sessions.

Use `status --profile ag-933`, `restart --profile ag-933`, `stop --profile ag-933`, or
`clean --profile ag-933` through that entry point. Stop authenticates the instance and awaits
core cleanup and process exit; clean only removes stopped recognized disposable state. Neither
removes a developer checkout. Evidence lives outside profile cleanup. Unknown versions,
symlink aliases, copied ownership and duplicate writers fail explicitly. A stale PID without
an authenticated endpoint is never authority to signal it. A failed launch keeps diagnostic
state; do not manually point its configuration at normal Electron data or ~/AI Games.

Requests are JSON files to avoid shell quoting:

```json
{"method":"type","params":{"selector":"[data-promptbar] textarea[aria-label=\"Prompt\"]","text":"Hello 🌿","replace":true}}
```

Send with `npm run studio:dev -- ui --profile ag-933 --request /tmp/request.json`.
`ui` and `diagnostics` take exactly one of `--request FILE`, `--request -` (stdin) or `--json '<op>'`;
`snapshot --profile P [--scope SEL] [--limit N]`, `logs --profile P [--surface S] [--cursor N] [--limit N]`
and `runs --profile P` are shortcuts. The [verify-ui-via-dev-control skill](../.agents/skills/verify-ui-via-dev-control/SKILL.md)
walks the full loop.
The request union/runtime validator is src/main/dev/protocol.ts. Operations are status,
snapshot (desktop, scope/limit), click (selector/scope), type (plus text/replace), key
(surface/key/code/modifiers), select (selector/scope/value), scroll (surface/deltas/target),
game.input (existing bounded action union), game.state, window.resize, capture, logs, runs, cpu.start/stop,
main.cpu.start/stop (a profile of the main process), heap,
trace.start/stop and stop. `graph.drag` takes bounded duration/distance/steps and returns
commit counters through release; `window.resize` takes bounded width/height deltas, steps and
duration, resizes the studio window step by step with a game in Live, and returns how far the
game view trailed its slot right after each change and before the next ([performance](performance.md));
`fixture.graph` takes `other-project-frames` or `append-round`
only in `large-build-graph`. Traces accept `toplevel` for renderer task durations.
No arbitrary eval, PID, webContents ID or output path is accepted.
Scoped DOM inspection resolves one visible enabled non-occluded target. CDP dispatches actual
pointer-down/up, keyboard and Unicode insertText to the desktop without system focus/pointer
movement. The native macOS select did not accept background keys on pinned Electron. The select
operation reports unsupported-surface if keys do not apply. Open an earlier build with its chat
card's title button, `button[data-open-build]` (scroll the conversation to it first). Game actions use the
existing GamePreview contract. Fixture and smoke windows are shown inactive, nonfocusable and
parked offscreen. Live development profiles open normally and accept keyboard focus so they
can be used for manual testing.
For human review with fixture data, launch or restart the owned fixture profile with
`STUDIO_FIXTURE_INTERACTIVE=1`. Its window opens normally and accepts keyboard focus; fixture
providers, credential isolation and native-action restrictions remain unchanged. Leave this
opt-in unset for automated acceptance.

`capture --profile ag-933 --surface desktop --name after` writes an owned surface-labelled PNG;
repeat for game. Renderer captures do not include the native game child. The capture records
image dimensions, image-pixel/CSS-pixel scale, renderer zoom, visibility, focus and time. For diagnostics use a JSON request
with `diagnostics --profile ag-933 --request FILE`. Start/stop a matching CPU profile ID; heap
needs surface/name. Trace needs traceId, durationMs (100–30000) and supported categories from
`devtools.timeline`, `v8`, `blink.user_timing`; stop flushes its buffers. Overlap, wrong IDs,
missing surfaces, detached debugger, reused artifact names and interrupted operations fail.
Do not open DevTools while the development controller owns its debugger attachment.

`runs` (no parameters) lists every open run of the profile and the newest run of the chat the
window shows: thread, project, state, journal phase and clock, worked time, its own newest record,
the last close's stop reason, integration head and landing, and `resumable` (paused with a
journal that is not done). It reads the event log and journals ([runs.ts](../src/main/dev/runs.ts))
and asks the window which chat it shows,
so like `status` and `stop` it answers on a stale build, under a sign-in sheet and while the
harness is not ready. `key` gives Enter, Escape, Tab, Backspace, the four arrows, PageUp,
PageDown, Home and End their real key codes.

### An unattended live Loop

A long live run spends the owner's subscription: get their go for that run itself, since a
live-profile request does not cover it ([credentials](connections-and-context.md#credentials)). Run from a
checkout outside any `.claude` folder (the start `warnings` say when it is not) and change no
source there until it ends: a stale build refuses every UI operation, and a restart stops the run.
Drive only through hooks: the welcome's `[data-onboarding-action="next"]`, then `"start"` (only
`"skip"` means nothing is signed in: stop and ask; never sign in yourself); the home composer's
`[aria-label="Model settings"]` role rows `[data-role]` and `[data-model-choice]`, the
`[aria-label^="Effort:"]` pill, then arrow keys on `[data-effort-slider]`, `[aria-label="Mode"]` with
`[aria-label="Loop time limit"] [data-value]`, and `textarea[aria-label="Prompt"]`. Answer a
`[data-chat-question]`, plan review or permission card only as a recorded human intervention.
Watch with `runs` and `status`; no new record for a long while, or a `lastFailure`, is the cue to
read `logs`. A run paused by an engine limit or a loop crash continues from
`[data-run-resume="<runId>"]` once the limit resets. Never restart or drive the window while the
owner is using it; leave the profile running at the end.

Transport descriptors are private local capabilities under the owned profile; never copy them
into task records. Unix sockets live in a short 0700 temporary directory, with owner-only socket
permissions. Protocol v1 uses bounded newline-delimited JSON, request IDs and one operation at
a time. A timeout is not success and does not authorize retrying a mutation blindly.

## Embedded terminal acceptance

Feature setup installs pinned xterm/fit/node-pty dependencies. After dependency installation or
an Electron version change, `npm run rebuild:terminal` explicitly rebuilds node-pty and prepares
its spawn helper. Restore missing locked dependencies only when needed for the requested work. `terminal.test.ts` covers flow bounds,
admission, disposal and managed output filtering; neighboring engines/Claude/Codex suites cover
fallback home/environment, cancellation and verified completion. Run `npm run test:terminal` for
an immutable credential-disabled fixture with a fixed `/bin/sh` script: actual PTY input/Unicode,
resize, hide/reopen, output flooding with concurrent chat, native game isolation/visibility, Stop
and stubborn-child cleanup, Settings handoff, browser action, zoom and renderer reload. Evidence
under `.studio-dev/evidence/terminal-<id>/` includes build/source/runtime/provider identities.

After `npm run package`, `node tests/e2e/run-terminal-packaged.mjs` launches the real packaged
executable and proves native addon/helper resolution, input, final output, exit and cleanup. It
accepts `STUDIO_PACKAGE_DIR` for an isolated package. `.github/workflows/terminal.yml` runs the
focused suites and real UI on macOS and Linux (Xvfb); `package.yml` the packaged terminal. These fixture checks do
not authenticate a provider, inspect user credentials or prove screen-reader assistive technology
integration; account authorization retains the explicit permission gate above.

### Appearance checks

`run-settings-ui.mjs` also asserts identical dialog width, height and position across Appearance,
Model Providers and Local Models. Decorative borders no longer have a blanket 3:1 assertion;
Appearance conformance checks draw every role as set, preserve configured edge colors and hold the built-in presets to readable text.

Use `npm test -- tests/conformance/appearance.test.ts` for color-model/schema/import changes.
`node tests/e2e/run-appearance-ui.mjs` checks the actual Settings dialog with shared components in
an isolated fixture window, including system mode, keyboard/pointer, presets, persistence,
import recovery, simulated clipboard refusal, font roles, computed contrast, resizing, 200% zoom
and reduced motion. It writes `.studio-dev/appearance-ui/report.json` and images. It does not
overwrite the user's clipboard or touch account profiles. Shared control changes also use the
existing design gallery; app/native-preview acceptance uses an owned development session.

### Acceptance follow-up regressions

`claude-telemetry.test.ts` checks optional-control timeout isolation and invalid measurements
against a CLI that answers controls one at a time, and that sessions never ask for plan usage.
`skill-inventory.test.ts` checks host-only scope, links, archives and size bounds. The plugin
registry restart cases include Connect reusing an existing token as well as explicit Unlock.
These automated cases do not establish OS credential restoration or hosted draft readiness;
record actual isolated-app restarts and staging marker checks separately.

Chat question changes: `node tests/e2e/run-chat-feedback-ui.mjs` uses the named `chat-feedback` fixture to check explicit choice submission, custom answers, restart restoration, model inheritance and compact results with learning links to Studio. `node tests/e2e/run-chat-ui.mjs` retains long-history, stream reconciliation, tool/worker and permission coverage; active runs also open Builds. `turn-loop.test.ts` checks question-to-answer provider-session continuation with successful turn endings, not only request receipt. These scripted providers do not certify live vendor behavior.

`node tests/e2e/run-operator-hooks-ui.mjs` renders the production result card, chat Resume line
and welcome, and checks the `data-run-resume` and `data-onboarding-action` hooks an operator presses.

`node tests/e2e/run-results-ui.mjs` renders the production asset tiles, model dialog,
chat outcome and learning components with local fixture media. It checks lazy model thumbnails,
cached remounts, hover/focus actions, automatic captures, modal focus restoration, corrupt-file
recovery, learning navigation callbacks, new-row versus history motion, light/dark, 200% zoom
and reduced motion. Evidence lives in `.studio-dev/evidence/results-ui/`. Pair with
`run-chat-ui.mjs` and `run-chat-feedback-ui.mjs` for real host reads, history/streaming and Studio
navigation; component fixtures do not prove account access or native game layering.

Genex account regressions: `run-genex-account-ui.mjs` renders the Genex page's own account card
and checks that a failed connect keeps its reason after the status is read again. It does not
establish real browser/Keychain authorization.
`planning-capabilities.test.ts` and the host cases in
`promptbar-redesign.test.ts` check current planning context and the tool-free boundary.

Provider-global skill inventory: `provider-skills.test.ts` covers native scopes/disabled
entries, Claude shared links, installed package identity and corrupt metadata. A real Skills
page check verifies the selected CLI profile; filesystem discovery never certifies invocation.

After explicit live-account authorization, `node tests/e2e/run-provider-live.mjs <evidence-root>
--live --packaged` runs bounded Opus 5.5 telemetry, Luna native compaction/resume and Bonsai
inference against the packaged adapters. The root must already contain a verified Bonsai
installation at `runtime/`; the runner does not download it. It creates an isolated Studio
profile, records runtime identity and never offers asset tools. Native CLIs use their existing
sign-in, so fixture encryption does not imply isolation from their account credentials. The
report separates telemetry from threshold control; it does not prove Claude custom compaction
or replace the first-response/download UI acceptance.
