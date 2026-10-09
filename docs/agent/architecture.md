# Architecture

Technical reference for the external developer. Start with the [product overview](context.md) and
the affected product page, then read only the section you need here. Each section states the
current contract and names the code that owns it; history lives in Git and PR descriptions, not
here. When code and this page disagree, fix the one that is wrong in the same change.

The active app builds browser games only. The Unity CLI, editor, bridge, templates, tools and UI
are archived in [`archive/unity/`](../../archive/unity/); no flag enables them and there is no
migration path.

## Processes and trust boundaries

| Process | Code | Trust |
| --- | --- | --- |
| Electron main | [`src/main/`](../../src/main/) | Privileged. Owns IPC, `StudioCore`, windows, previews, secrets. |
| Preload | [`src/preload/studio-bridge.ts`](../../src/preload/studio-bridge.ts) | Sandboxed; exposes only the fixed calls of `StudioApi`. |
| Renderer | [`src/renderer/`](../../src/renderer/) | A browser; see **Renderer** below. |
| Harness child | [`src/harness-seed/`](../../src/harness-seed/), booted by [`src/harness-boot/bootstrap.mjs`](../../src/harness-boot/bootstrap.mjs) | Untrusted: the in-app agent rewrites it. Plain Node under `ProcessSandbox`. |
| Contractors (coding CLIs) | [`src/substrate/engines/`](../../src/substrate/engines/) | Vendor harnesses briefed by the studio; see [Residual risks](#residual-risks). |
| Game pages | [`src/main/preview.ts`](../../src/main/preview.ts), [`src/page/`](../../src/page/) | Untrusted web content in a closed partition. |
| Plugin backends, MCP servers | [`src/substrate/plugins/`](../../src/substrate/plugins/), [`src/substrate/mcp/`](../../src/substrate/mcp/) | Trusted native code the user approved; a process is crash isolation, not a sandbox. |
| Terminal hosts | [`src/main/terminal-host.ts`](../../src/main/terminal-host.ts) | One Electron utility process per node-pty session, as the user. |
| CLI installers | [`src/substrate/cli-installer.ts`](../../src/substrate/cli-installer.ts) | Vendor installers, unsandboxed. |
| Agent jobs | [`src/substrate/jobs.ts`](../../src/substrate/jobs.ts) | Sandboxed process groups main starts for agents (the chat's, a lead, workers); they outlive turns and harness restarts and stop on quit. |

**Renderer.** It talks to main only through the named calls in
[`src/shared/studio-api.ts`](../../src/shared/studio-api.ts); it receives no evaluation or
filesystem API. Runtime imports from renderer or shared code cannot reach Node, Electron, main,
preload or substrate, including through barrels (`npm run verify:architecture`,
[`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts)). The main window never
navigates: [`src/main/link-policy.ts`](../../src/main/link-policy.ts) (`routeStudioLink`) opens
https in the browser; a `file:` link must be contained in a game folder lexically and on real
paths, and only a regular, non-executable file with an allow-listed document or media extension
opens (`open-path`); folders, bundles, launchers and exec-bit files are revealed in Finder;
anything else is refused in words. Some IPC calls take a renderer-chosen absolute path by design
(a picked folder, a chat's file names); each validates it in main, and
`main/chat-files.ts` never links credentials or the studio's secrets.

**Harness child.** [`src/substrate/harness-host.ts`](../../src/substrate/harness-host.ts) starts
`bootstrap.mjs` with Electron's Node (`ELECTRON_RUN_AS_NODE`) through
`ProcessSandbox.spawnLongLived` over stdio; `utilityProcess` is not a substitute. The harness is
ordinary Node: it can use `node:fs` and `node:child_process`, and its containment comes from the
Seatbelt profile (on Windows, the `srt-sandbox` user and its job; see
[Windows sandbox](../windows-sandbox.md)) it and every child it starts inherit
([`src/substrate/spawn.ts`](../../src/substrate/spawn.ts), sandbox-runtime). Everything it asks the
host for arrives over the harness RPC, which is therefore an untrusted surface:

- `HarnessHost` checks a call before its handler runs. An unknown method answers `UnknownMethod`;
  a path-bearing method whose params fail its zod schema in `HARNESS_PARAM_SCHEMAS`
  ([`src/shared/harness-api.ts`](../../src/shared/harness-api.ts)) answers `InvalidParams` with one
  issue per bad field. The schemas accept `null` for optional fields and hand the handler the
  params as sent. They complement the realpath checks, never replace them. `engine.abort` and
  `engine.interrupt` are unchecked on purpose: their `cwd` is only a key into running delegations.
- Adoption, which widens the sandbox, is not on the RPC: only user-consented host flows call
  `sandbox.allowWrite`.
- Only whoever answers the person in a game chat asks them: its own Claude session, or a build's
  lead or the run's coordinator, in the chat's mode
  ([tool permissions](../tool-permissions.md)), decided from the host's records. `thread.create` takes a title only; `events.append` and
  `turn.append` refuse `tool_permission` and `plugin_consent` rows. No agent process writes a
  game's `.claude` folder; no landing or promotion brings one.
- `preview.load` and `game.attached` accept only a library game, and a `root` only when its
  realpath is strictly inside scratch or equals that game's registered folder; the preview pins
  the real path at load. `snapshot.worktree` and `snapshot.removeWorktree` refuse a symlinked
  component below scratch. `game.read`/`game.write` check the real target (a write never follows a
  link leaf; `realpathNearest` refuses a dangling link). `engine.delegate` sends a contractor only
  to the checked real path of a scratch worktree or the game's folder. `game.export` writes only
  inside the exports folder. EventStore thread and artifact ids are plain names, and
  `saveRunArtifact` resolves inside `runs/<runId>/`.
- A revision the harness names must resolve to a commit (`resolveCommit`) and reaches git after
  `--end-of-options`. Host git always runs with `HOST_GIT_CONFIG`
  (`-c core.fsmonitor= -c core.hooksPath=/dev/null`), so a repository's config cannot make the
  host run a program.
- The harness cannot choose its own rewind target; see [Snapshots and health](#snapshots-and-health).
- Main, not the harness, owns agent jobs (`StudioCore.jobs`; records and logs in
  `<userData>/jobs/<game>/`, outside every writable root).
- `app_look` ([`src/substrate/app-look.ts`](../../src/substrate/app-look.ts)) runs in main, outside
  every box, since macOS grants Screen Recording and Accessibility to the app: constant `osascript`
  scripts (the window only as arguments), `screencapture` and `sips`; never input.

`tests/conformance/rpc-authority.test.ts` holds the hostile-root table;
`tests/conformance/harness-api.test.ts` drives the parameter check over a fake child's pipes.

**Path containment** has one home, [`src/substrate/paths.ts`](../../src/substrate/paths.ts):
`isInside`/`isBelow` compare resolved paths lexically (the filesystem root contains only itself,
so a misconfigured root fails closed), and `containedReal(root, rel)` checks an untrusted relative
path's shape (`assertRelativePath`) and then its realpath strictly under the root's. The coding-CLI
resolver, the credential-home list and the ownership locks keep their own rule, because a denylist
must not change at `/`.

**Child environments** come from the pure `childEnv`
([`src/substrate/child-env.ts`](../../src/substrate/child-env.ts)). Sandboxed children (the
harness, `run.exec`, builds) get an allow-list: PATH, HOME, locale, terminal, temp and CA-cert
variables. Contractors get the app's environment minus credential-shaped names (the list
in `child-env.ts`), any URL value with a password, and the other vendor's variables, plus what
the engine sets. Probes and the Ollama server Studio starts use the same filter.
`credentialHomes()` ([`src/substrate/credential-homes.ts`](../../src/substrate/credential-homes.ts))
is the one list of coding-CLI sign-in homes that the sandbox, Claude's absolute deny rules (its own
config home [partly](../tool-permissions.md#rules-at-their-real-paths)), the Codex brief, Bonsai
and native plugin jobs deny. `ProcessSandbox`
adds its base deny-read list (`baseDenyRead` in `spawn.ts`): sign-in stores such as `~/.ssh`,
`~/.aws` and `~/Library/Keychains`, and on Linux the desktop secret stores.

**Windows sandbox.** Commands run as the local `srt-sandbox` user under Git Bash through
sandbox-runtime's srt-win backend
([`src/substrate/windows-sandbox.ts`](../../src/substrate/windows-sandbox.ts)). Its grants, deny
list and residual risks are in
[Windows sandbox](../windows-sandbox.md).

**Contractor bridge and locks.** The bridge
([`src/substrate/engines/studio-bridge.ts`](../../src/substrate/engines/studio-bridge.ts)) checks
with lstat that `.studio`, the bridge folder and `res/` are still the folders it made and writes
answers with `O_EXCL|O_NOFOLLOW`. Ownership locks
([`src/substrate/engines/ownership-locks.ts`](../../src/substrate/engines/ownership-locks.ts)) treat
the marker as hostile, change modes only on in-root regular files and restore only the write bits
they removed. Both read requests and markers with `fsx.readRegularFile`: non-blocking, no link,
regular files only, size-capped, so a planted FIFO cannot hold a libuv thread. Every no-link open
goes through `fsx.openNoFollow` (Windows, lacking `O_NOFOLLOW`, lstat-checks the name before the
open and matches device and file index after it; `O_TRUNC` waits for that). On Windows a lock is the read-only attribute. The locks' honest
scope: Codex's cover pre-existing files, never directories; the Claude hook matches
`Edit|Write|MultiEdit|NotebookEdit` only, so a Bash write is not blocked.

### Residual risks

- **A Codex contractor can read the whole disk.** `codex exec` runs under Codex's own sandbox
  (`workspace-write`, one writable root, no network), which restricts writes but not reads, and
  Studio does not wrap the CLI in `ProcessSandbox`. The studio's secrets, both CLIs' sign-in homes
  and sibling games are named off limits in the brief only; the Claude path enforces the same list
  as `Read()` deny rules, and `ProcessSandbox` enforces it for the harness and Bonsai. A
  prompt-injected Codex build could copy what it reads into its game or summary. Studio's
  own secrets are safeStorage ciphertext; the exposed material is other games, `~/.genex`, the
  borrowed Codex sign-in and the ordinary home folder. Running it under `ProcessSandbox` with
  deny-read is planned.
- **OpenCode reads its sign-ins** ([details](../connections-and-context.md#openrouter-and-opencode)).
- **An install briefly opens the npm registry to every sandboxed process.** sandbox-runtime's
  proxy filters against one process-wide allow-list, so `ProcessSandbox.run` widens it for a
  package install's length and restores it afterwards (counted, in `finally`). Two installs
  open it: the user's Install packages button and `genex__package`, a consented add of one of the
  two exact-pinned Genex SDK packages (`GENEX_GAME_PACKAGES`) that the agent cannot re-version.
- **A Genex CLI run opens `api.genex.games` to every sandboxed process** for its length, by the
  same process-wide widening. Other processes hold no Genex token (it reaches only the CLI's
  preload, on stdin), so they can reach the API but not act as the user.
- **The asset adapter still runs the pinned CLI with the user's real `HOME`** (`adapter.ts`
  asset commands). The CLI's legacy cleanup therefore deletes `genex-*` entries under
  `~/.claude/skills`, `~/.codex/skills` and `~/.cursor/skills` (and two legacy `~/.claude` files)
  on a `genex__asset` call. `genex__cli` and publishing already use a contained `HOME`; giving
  asset runs one is a follow-up.
- **Windows sandbox residuals** are listed in [Windows sandbox](../windows-sandbox.md#residual-risks).
- **A command a reply offers runs outside the sandbox.** Run starts the agent-written line with the
  user's own permissions. Only one visible line without control characters is accepted; a
  prompt-injected agent can still offer a harmful one, and the user's reading is the last check.
- **`STUDIO_DISABLE_OS_CREDENTIALS=1` is not process isolation.** It blocks SecretStore's Electron
  backend before import and on each operation; it does not sandbox external coding CLIs or
  Chromium's own storage.

## Main process layout

- [`src/main/index.ts`](../../src/main/index.ts) keeps the app lifecycle and the window and
  composes the per-domain IPC registrars in [`src/main/ipc/`](../../src/main/ipc/). Each registrar
  takes the typed `IpcHandle` ([`src/main/ipc/registrar.ts`](../../src/main/ipc/registrar.ts)) and
  its dependencies explicitly; `handle()` and `pushToRenderer` live in
  [`src/main/ipc-handle.ts`](../../src/main/ipc-handle.ts). Plugin, MCP, terminal and permission
  channels accept only the main window's top-level frame. Follow the [IPC recipe](recipes.md#ipc-channel).
- **Boot state.** The renderer first calls `bootState` (`studio:boot`, registered before any core;
  contract in [`src/shared/boot.ts`](../../src/shared/boot.ts)): the platform, which it sets as
  `data-platform` on the root, and the phase. When `ProcessSandbox` raises
  `SandboxUnavailableError` ([`src/substrate/sandbox-unavailable.ts`](../../src/substrate/sandbox-unavailable.ts):
  unsupported platform, missing Linux tools found by a PATH lookup, Windows `not_provisioned` or
  `wfp_fence_inactive` by code), main holds the boot gate
  ([`src/main/boot-gate.ts`](../../src/main/boot-gate.ts)) and opens a core-less setup window
  instead of exiting; `studio:boot.retry` creates the core again and, once it starts, replaces
  that window with the studio. On Windows, `studio:boot.setup` (native) first installs the sandbox
  with the unpacked srt-win
  ([`src/substrate/windows-sandbox-setup.ts`](../../src/substrate/windows-sandbox-setup.ts), one
  UAC prompt) and then retries; a dismissed prompt changes nothing. Other startup failures, and
  smoke and developer launches, keep the error dialog and exit (the `sandbox-setup` fixture shows
  the screen over a ready core). The window's title bar comes from
  [`src/main/window-chrome.ts`](../../src/main/window-chrome.ts): `hiddenInset` on macOS
  (lights on the headers' line), a themed 48 px `titleBarOverlay` on Windows and Linux
  (`studio:window.controls`).
- [`src/main/studio-core.ts`](../../src/main/studio-core.ts) keeps the core's lifecycle, the event
  log's front door, settings and public methods. It assembles the EventStore, snapshots,
  `GameWorkspaces`, the engine registry, the preview pool and the `HarnessHost`.
- The harness RPC handlers live in [`src/main/harness-rpc/`](../../src/main/harness-rpc/), one file
  per namespace, typed by `HarnessHostApi`; `api()` returns `HarnessHostHandlers`, so a handler
  reads only declared params and answers its declared result without a cast. Follow the
  [RPC recipe](recipes.md#harness-rpc-method).
- Behavior lives in services under [`src/main/core/`](../../src/main/core/) (previews, delegation,
  recovery, self-improvement, plugin tools, conversation, assets, game threads, the self-edit
  gate, connections, plan drafts), which reach the core's shared state through one typed
  `CoreInternals` ([`core/internals.ts`](../../src/main/core/internals.ts), in narrow groups).
- [`src/main/smoke/`](../../src/main/smoke/) holds the build smoke, selftest and acceptance drivers,
  loaded by dynamic import only when their flag is set. Acceptance drivers that need seed code load
  the shipped copy from `resources/harness-seed/` by a path computed at run time.
- [`src/main/dev/`](../../src/main/dev/) is the development controller (`control.ts`), fixture
  games (`fixtures.ts`, assembled from `fixture-kit.ts` and one `fixture-<part>.ts` per scenario
  part: engines, chat, history, build graph, notifications) and the fixture policy
  (`native-policy.ts`), which classifies
  every IPC channel fixture-safe or native; an unclassified map channel fails the typecheck. The
  controller is main-owned and absent from the ordinary preload contract.

## Shared contracts

Everything both sides of a process boundary read is typed once in
[`src/shared/`](../../src/shared/); the substrate re-exports these types, and shared and renderer
code import none from the substrate.

| Contract | File | Notes |
| --- | --- | --- |
| Renderer API | [`studio-api.ts`](../../src/shared/studio-api.ts) | The fixed named calls of `window.studio`. |
| IPC channels | [`ipc-channels.ts`](../../src/shared/ipc-channels.ts) | Ties each `studio:*` invoke channel to its call, payload and result, and each push channel (`studio:event`, `studio:terminal`, `studio:claude-login`, `studio:codex-login`) to its `on*` subscription. Preload, `handle()` and the fixture policy take their types from it. |
| UI events | [`ui-events.ts`](../../src/shared/ui-events.ts) | `studio:event` carries a `UiEvent` from `UiEventMap`. `UiEvent` names each (`UiEvent.PreviewFrame`). `StudioCore.emit` and `pushUiEvent` are checked against it; the renderer narrows on `event.type`. Harness notifications are forwarded unchanged, so harness-written fields stay optional and unknown names still arrive and are ignored. |
| Durable custom events | [`custom-events.ts`](../../src/shared/custom-events.ts) | `CustomEvent` names them (`CUSTOM_EVENT_TYPES` lists the values; `customEventData` builds a record); `CustomEventMap` types what the app reads, every field optional. Read through `customEvent`/`customPayload`, never by casting `data.payload`. |
| Event log | [`event-log.ts`](../../src/shared/event-log.ts) | Events, conversations and snapshot records. |
| Harness RPC | [`harness-api.ts`](../../src/shared/harness-api.ts) | `HarnessHostApi`, `HostMethod` (the method names), `HARNESS_PARAM_SCHEMAS`; the seed's `types/host-api.d.ts` and `loop/host-methods.ts` are generated from it (`node scripts/gen-harness-types.ts`). |
| RPC data | [`preview-contract.ts`](../../src/shared/preview-contract.ts), [`engine-requests.ts`](../../src/shared/engine-requests.ts), [`optimization.ts`](../../src/shared/optimization.ts), [`mcp.ts`](../../src/shared/mcp.ts), [`game-project.ts`](../../src/shared/game-project.ts) | Capture, pixel, input, readiness and console shapes; the serializable halves of a completion and a delegation. |
| Engines and providers | [`engine-descriptor.ts`](../../src/shared/engine-descriptor.ts), [`providers.ts`](../../src/shared/providers.ts) | What the UI knows about an engine, and the one provider table (see [Engines and providers](#engines-and-providers)). |
| Time units | [`duration.ts`](../../src/shared/duration.ts) | `SECOND_MS`, `MINUTE_MS`, `HOUR_MS` for every named wait; the seed's `loop/time.ts` is held to it. |

Add a new event or channel here first ([event recipe](recipes.md#event-type)); no payload `as`
or `as never`.

**Seed contracts.** The app never loads [`src/harness-seed/`](../../src/harness-seed/), and nothing
under `src/shared` resolves where the seed runs. A rule both apply has a typed host copy in
`src/shared` — the coordinator's tools and run reading (`coordinator.ts`), the follow-up queue
(`message-queue.ts`), the model-role tables and presets (`model-roles.ts`), SkillOpt's bounded
edits (`skill-edits.ts`) — and the seed keeps its own. `tests/conformance/seed-contracts.test.ts`
and `tests/conformance/providers.test.ts` replay the same inputs through both copies. Other
two-copy rules: the ownership glob ([`src/substrate/ownership.ts`](../../src/substrate/ownership.ts)
and the seed's `loop/review.ts`), and the engine-export refusal (`ENGINE_EXPORT_REFUSAL` in
[`shape-words.ts`](../../src/shared/shape-words.ts) and the seed's `loopRunRefusal`). See the
[seed contract recipe](recipes.md#seed-contract). `verify:architecture` fails any new import
cycle in `src`; [`scripts/boundary-allowlist.json`](../../scripts/boundary-allowlist.json) is empty
and must stay so.

## Renderer

**State.** Zustand domain stores in [`src/renderer/state/`](../../src/renderer/state/) (engines,
event log, layout, library, plugins, session, threads, toasts, agent screens, command runs) are wired once by
`createStudio(api)` in `state/studio.ts`: one `onEvent` subscription, the log poll, the bootstrap
and the commands that span stores. The app has one instance started before React mounts, so
StrictMode cannot subscribe twice. Components read through the selector hooks in `state/hooks.ts`
(`useShallow` for objects and arrays); UI-only state stays local; derivations stay in the pure
modules (`chat-entries.ts`, `run-graph.ts`, `build-progress.ts`,
[`src/shared/run-state.ts`](../../src/shared/run-state.ts)); `localStorage` keys come only from
[`src/renderer/storage.ts`](../../src/renderer/storage.ts). `tests/conformance/renderer-state.test.ts`
drives the stores with `tests/helpers/fake-studio-api.ts`. See the
[store recipe](recipes.md#zustand-store).

**Layout.** A large panel is a folder of its parts beside its entry component:
`panels/inspector/` (`RunInspector.tsx`'s sheets), `panels/run-graph/` (`RunGraph.tsx`'s nodes,
gates and camera), `panels/stage/` (`PreviewPanel.tsx`'s body and strip), `panels/plugins/` and
`panels/connectors/`. `panels/ChatPanel.tsx` keeps its parts in `chat/`: its hooks are
`chat/use-*.ts` (wired by `use-chat-panel.ts`), sending routes in `send-route.ts`, the
conversation in `ChatConversation.tsx`. First launch is `onboarding/` (pure
decisions in `state.ts`, the canvas art in `art.ts`).

**Words.** Every user-facing label derived from harness vocabulary — statuses, verdict sources,
stop reasons, tool names, the run's headline, `problemWords` — lives in
[`src/renderer/words.ts`](../../src/renderer/words.ts). No other renderer file translates a verdict
source or status literal or renders a raw harness status, run id or sha
(`tests/conformance/words.test.ts`). The ported rail files (`ui/kit.tsx`, `ui/icons.tsx`,
`panels/Sidebar.tsx`) use only classes and custom properties that
`theme.css` defines (`tests/conformance/sidebar.test.ts`). Smoke runners select by the `data-*`
hooks in the [feature map](feature-map.md); keep them and aria-labels stable.

**Shell.** `App.tsx` is the shell's composition root; its hooks and parts live in `shell/`
(`use-shell.ts` wires chrome, navigation, stage views, notifications and the keyboard;
`AppSidebar.tsx`, `Workspace.tsx` and `WorkspaceStage.tsx` draw them). It derives the workspace
from the active conversation: a game thread shows `PreviewPanel`; the Studio thread shows
`ReviewPanel`'s Activity feed beside the same mounted `ChatPanel`. Plugins is a full workspace page with navigation state separate from the active
thread; the conversation and stage stay mounted and inert behind it. `PreviewPanel` stays mounted
behind Studio and Plugins and reports zero native bounds when hidden, projectless, or covered
by a drawer or dialog; its ResizeObserver keeps reporting geometry. Settings is one modal
(`SettingsDialog`, routed by `settings-navigation.ts` to Games, Appearance, Model Providers, Local
Models, Harness and Permissions). Harness
writes `buildersMax` (1–12, default 4); main derives the preview-pool ceiling as builders + 2. An
empty, never-welcomed profile first shows the welcome (`onboarding/`), which fades into home.
Launches open home (`Room.Home`). Its first message runs `launchGame` (`state/launch.ts`):
`studio:game.name` names the game (`main/core/game-naming.ts`), `createGame` makes it, its chat
sends the message (`chat/use-launch-handover.ts`). Fixtures open their game from the sidebar. The bell (`notifications.ts`, `NotificationsMenu.tsx`, `studio:notify`, `studio:badge`) and
file tabs beside the chat (`open-beside.ts`, `FileViewer.tsx`, `main/game-file.ts`) are specified in
the [feature map](feature-map.md). A file a chat names links once main confirms it
(`renderer/chat-files.ts`, `main/chat-files.ts`); programs are only shown.

**Composer.** What the composer's controls show is specified in the
[prompt composer design](design.md#prompt-composer). Each chat keeps its own Loop
(`storageKeyFor.threadLoop`, [`loop-setting.ts`](../../src/renderer/loop-setting.ts)), pinned on open
from the last pick (`studio.composer.loop`, `studio.autopilotHours`); Mode around a build is in the
[feature map](feature-map.md) (∞ is `budgets.untilSatisfied`, its 24 h `wallClockMs` a ceiling). The
permissions pill (`ComposerPermissionMenu`) sets a Claude chat's mode. A
saved `fast` preference is dropped. One composer effort (`ComposerEffort`,
`effortScale`/`unifiedEffort` over the orchestrator's levels) is mapped per role by `nearestEffort`
into `roles.efforts`, which `roleEffort` routes to each runtime job. A game chat keeps its own
effort (`storageKeyFor.threadEffort`, then its last turn's); the effort saved per model seeds
fresh chats (roles stay per engine, preferences per model); `ComposerSendOptions`
([`src/shared/composer.ts`](../../src/shared/composer.ts)) is the send contract. Plan limits come from `studio:provider-usage`
([plan limits](../connections-and-context.md#plan-limits)), read on open, then each minute. Stop
(`studio:cancel`) aborts provider work after at most 5 s for a send on its way; the harness gets 5 s
to acknowledge, then the oldest queued message runs; Escape never cancels a build
(`composerEscapeIntent`). Wrapping up (`finish_run`, `studio:run.finish`) is not cancel. A fresh game
inherits `studio.model.last`; the Studio thread keeps `studio.studioChat.model` and its own keys,
seeded once and never written back. Studio chat's `ModelMenu` has no `onRoles`.

**Run summaries.** Preload shares watchers; main caches histories/folds by heads and evidence metadata.
Preview identity patches avoid refolds. Activity incrementally retains summaries and auxiliary records.

**Chat.** `studio:chat.page` / `EventStore.chatPage` returns the newest 160 committed events and
exclusive `before` cursors for older pages. The renderer deduplicates by event identity, windows
variable-height entries, keeps the reading anchor when prepending and caps the global event tail
at 4,000. Backfilled threads have reference-counted pins; releasing the last reader restores bounded
retention. IDs use the shared code-point comparator, independent of OS locale. `chat-entries.ts` owns event-to-transcript projection: host plugin calls pair by call
id, native tool ids are namespaced by delegation, missing results stay unknown and stopped calls
never become successful; ending a turn settles only that turn's calls.
`chat/conversation-entries.ts` groups adjacent tools, reasoning and routine notes into one activity
disclosure without moving replies, errors, decisions or outputs. The trailing active work disclosure
belongs to the shimmer status; a running build's parts are not listed under it (they are on
Builds). `StreamingReply` batches text
every 50 ms; partial text is ephemeral and scoped to its thread and delegation. Markdown escapes
raw HTML tokens after parsing; code highlighting follows the
[chat design](design.md#chat-reading-and-activity). Pending plugin and Claude permission
questions and plan reviews pin above the composer (`chat/ChatQuestion.tsx`); only explicit
confirmation calls the consent, permission or plan IPC.

**Questions and Studio chat.** `ask_user` records a durable `interview_question` through both the
direct tool registry and a Loop chat's delegated bridge; the provider turn ends, the answer arrives
through the normal message queue and resumes the same session, and a question never launches a
run by itself. Its commissioning options live in a thread artifact referenced by `intakeId`.
Explicit Studio messages bypass game coordinators: `loop/studio-chat.ts` calls `engine.complete`
with no tools, a bounded window, current attachments and host-owned `studio.context`; it never
delegates or edits games, settings or harness files, and a blank reply is a durable error.

**Stage, Live's gate and morning card.** During a run the stage stays where the user left
it, and Live changes only through the user's own loads (the renderer's IPC, and `show_build` /
`land_build` answering a still unanswered message of the person's, `ChatPermissionService.awaitsAnswer`,
while Live, holding that game, is out of sight, `PreviewService.liveOutOfSight`; otherwise a show
is offered by commit, `offerBuild`, and a landing lands and offers the folder). A harness preview call that names no window, or
the live view, reaches the stand-in (`STAND_IN_HANDLE`, a hidden window outside the lease count,
opened on first use with what Live shows, closed after two idle minutes); only a build with no
headless capability still drives Live. What the harness loads there, a checkpoint and a rewind
reach `PreviewService.offerLive` (`core/live-gate.ts`): a game folder whose print (HEAD, status,
uncommitted sizes and times) moved since Live loaded it, or a build Live is not showing (held by
its commit), emits `live.behind`; the person's Reload (`reloadLive`) applies it and any live load
that succeeded clears it. The event says which build Live shows (`shows`, whichever path
loaded it), and the stage reads the whole state on mount (`studio:live.behind`). The renderer
(`stage.ts`, `stage/live-behind.ts`) adds the run's newest healthy build Live does not show and
a shown build found broken, applies what main holds when Live is not watched, and swaps only the
empty scaffold's first healthy build by itself. Live preview candidates load in a staging preview
first; a candidate and a session never borrow Live when the pool is full, and a session never
takes Live or the stand-in by a harness-named handle: it gets an overflow lease, at most
`OVERFLOW_WINDOWS_MAX` past the pool's ceiling, and waits for a window beyond that. The morning card (`MorningCard.tsx` over `morning-words.ts`) is specified in
the [feature map](feature-map.md).

**Covers.** `GameAvatar` paints every cover with one WebGL context (`ui/cover-animation.ts`,
`ui/cover-stills.ts`; [feature map](feature-map.md)). Asset cards render thumbnails through a serialized decoder queue
and dispose their WebGL contexts.

**Appearance.** [`src/renderer/appearance/`](../../src/renderer/appearance/) owns the versioned
palette model, bounded JSON/JSONC interchange and the `studio.appearance.v1` preference; one
resolved `data-theme` drives controls and portals. Imports never execute CSS. Game pages are not
recolored. See [themes](../../design/genex/THEMES.md) and the [design workflow](design.md).

## Engines and providers

**Engines.** `Engine` ([`src/substrate/engines/types.ts`](../../src/substrate/engines/types.ts)) is
either direct (`complete`, `models`, `status`: Ollama, Bonsai) or delegated (`delegate` into a
workspace: Claude Code, Codex). Failures map to `EngineError` kinds, some still inferred from
provider message text. `EngineRegistry` ([`src/substrate/engines/registry.ts`](../../src/substrate/engines/registry.ts))
holds the registered engines, builds the `EngineDescriptor` list the UI reads (`describe`), and
answers fallbacks: a rate limit falls back only to a direct engine; context overflow and auth fall
back to nothing. `StudioCore.init` registers the engines and sets the preferred order: local first
(it cannot be rate limited), then the subscriptions.

**Provider table.** [`src/shared/providers.ts`](../../src/shared/providers.ts) `PROVIDERS` is the one
table of provider identity: id, the label a person says, whether it is a subscription, its login
kind (`terminal` for Claude, `console` for Codex, `none`), its role support (`presets`,
`sessions`, `single`) and a subscription's sign-in copy. `describe` serves the row on each
descriptor as `provider` (null for an unlisted engine). `SUBSCRIPTION_ENGINES` is derived from it
and re-exported by [`src/main/core/subscription-engines.ts`](../../src/main/core/subscription-engines.ts)
and [`src/renderer/subscription-auth.ts`](../../src/renderer/subscription-auth.ts), whose
`signInVendor` gives the sign-in card the table's words (a neutral card for an unlisted engine);
chat labels name a contractor by the table's `label`.
`tests/conformance/providers.test.ts` holds both role tables (app and seed) to it. See the
[provider recipe](recipes.md#provider-or-engine).

**Coding CLIs.** Installations are external.
[`src/substrate/engines/external-cli.ts`](../../src/substrate/engines/external-cli.ts) discovers
them in order: persisted override, login-shell PATH, standard folders (Homebrew,
`~/.local/bin`, `~/.claude/local`, npm-global, Volta, Bun, pnpm, mise, asdf, nvm, fnm, the
Claude and ChatGPT apps). On Windows there is
no login shell: the process PATH and the standard folders are searched under PATHEXT names. An
npm `.cmd` shim starts as the `node <script>` it runs, so `cmd.exe` never parses its arguments;
any other `.cmd` goes through `cmd.exe`, plain words bare, others escaped for `%*`'s reparse
([`src/substrate/command-launch.ts`](../../src/substrate/command-launch.ts); the Agent SDK gets a
spawner for it, `claudeLaunchOptions`) and stops with its whole tree (`taskkill /T /F`,
[`src/substrate/process-tree.ts`](../../src/substrate/process-tree.ts)). Studio or game-local
dependencies and packaged binaries are excluded. A persisted override that is not ready yields to a
ready automatic installation, an explicit executable never. Diagnostics share a 15-second
cache; sessions skip it but reuse the login PATH and unchanged binaries' probe answers until
Recheck. Running processes keep theirs. `main/index.ts` configures protected `engine-homes/coding-clis.json`, which no
renderer or agent channel can write. Descriptors carry `account` (login source, variable, what
signing out leaves, CLI state and version). Fixture and smoke sessions search no paths or standard
locations (`configureCodingClis`), so status checks never run a machine-installed provider or report
fixtures as account readiness.

**Sign-in.** Both subscriptions keep native CLI sign-in and account storage
([`src/main/login-controllers.ts`](../../src/main/login-controllers.ts)). A controller holds the
chosen path and environment for the attempt and its status checks. Claude's piped browser/code
flow falls back to the embedded terminal with the same executable, credential home and PATH; a
sign-in for another credential home cancels the one in progress; a zero exit still needs native
auth-status verification. Codex keeps its in-app guided console and subscription-only auth. Claude
SDK queries always get an external path; a missing CLI fails before the SDK is invoked. Managed
login output removes auth URLs, credential patterns and terminal string controls before display.

**Embedded terminal.** [`src/main/terminal-service.ts`](../../src/main/terminal-service.ts) owns at
most four sessions, each node-pty in its own utility process; xterm.js loads lazily. Project shells
resolve cwd from the library, use the account shell and login PATH (on Windows Git Bash, else
PowerShell: [`src/main/terminal-shell.ts`](../../src/main/terminal-shell.ts)) and run with the user's
normal permissions. Games, plugins and the harness get no terminal API. A command a game reply offers
runs only when the user presses Run: `studio:terminal.run` takes one command line (`runnableCommand`)
as a `command` session (`commandShell`: the shell's `-c`, or PowerShell's `-Command`) in the game
folder, one per game, the dock closed. Output stays out of React state and events (the card reads
`state/command-output.ts`); the last 20 plain, redacted lines (`terminal-command.ts`) reach the agent
as an `origin: command-result` message the transcript hides. Output
is bounded (64 Ki code units in flight, 256 Ki
queued, 16 Ki per message) with pause/resume backpressure; scrollback is 3,000 lines; nothing is
persisted. Hide keeps the process; Stop ends the shell and captured descendants with PID identity
checks (on Windows `taskkill /T`); reload, window close and quit dispose sessions.

**Roles across providers.** The orchestrator is always the run's engine. Workers and judges may run
on another ready provider the job may cross to (`crossesTo`, [local models](../local-models.md#sessions-workers-and-roles)):
`roles.engines.builder`/`judge` (`RunRoles` in
[`src/shared/protocol.ts`](../../src/shared/protocol.ts)) and `withRoles` stamps `builderEngine`
beside `judgeEngine` only when a slot is crossed. The loop never reads `run.engine` for a builder or
critic: `roleEngine(run, role)` names the engine and `modelOn`/`plannerModel` a model that engine
knows. The director, coordinator, planner, replan and scout (session engines only) stay on the
orchestrator's engine; workers, contract wiring, the base, the integrator, spikes, the gauntlet
builder and optimization go to the workers' engine; the judge, replan's vision and the playtester
(while its model can play there) go to the judges' engine. A worker's `usage_limit`/`rate_limit` becomes `state.workerLimit` (never
`state.limit`, which pauses the run), reported as `workersEngineLimit`. A reopen resolves its
message's picks with `withRoles`, planned on the session's model; the coordinator's keeps the
build's (`reopenedRun`). An unready provider's remembered pick is kept; a Loop send with it is
refused (`requireAvailableRoles`). Stored roles are versioned; another preset table's record is
replaced once. `tests/conformance/director-cross-engine.test.ts` runs a crossed run end to end.

**One engine voice.** `toolCall(engine, name)` and `toolSyntax(engine)` in the seed's
`loop/model-roles.ts` are the only place the harness branches on the engine (Claude reads
`mcp__studio__<tool>`, Codex reads `node .studio/bridge/tool.mjs <tool> --field=value`).
`tests/conformance/engine-voice.test.ts` renders every exported brief once per engine.

**Judge sessions.** Every verdict is a one-shot session with no history. Claude verdicts run in one
stable directory (`JUDGE_CWD` in
[`src/substrate/engines/claude-code.ts`](../../src/substrate/engines/claude-code.ts)) so the
unchanging prompt prefix can be cached; the frozen rubric leads the user message and pictures
come last (`claudeJudgeContent`). `sweepJudgeTranscripts` runs only when the engine is built with
`sweepOnBoot` (the app passes it, tests never do) and drops `*studio-judge*` transcripts older than
`JUDGE_TRANSCRIPT_TTL_MS`.

**Provider receipts** distinguish the requested model from the reported one; absent metadata stays
unknown, and provider telemetry stays in `claude-telemetry.ts` — the app never infers a quota
percentage from token counts. Fast and effort come from what each provider advertises; no
provider is sent a compaction point, since every one compacts on its own (Auto) and Compact now
is the manual control. Local runtimes, Bonsai sessions and
checkpoints are specified in [local models](../local-models.md) and
[connections and context](../connections-and-context.md).

## Harness runtime

The harness is TypeScript run by type stripping, dependency-free, with `.ts` import specifiers; see
the [harness runtime guide](../harness-runtime.md) and [src notes](../../src/AGENTS.md#harness-seed).
Its modes (director, autopilot, facet loop, gauntlet, spike) share primitives from `loop/git.ts`,
`evidence.ts`, `build-turn.ts`, `config.ts` and `outcomes.ts`. The two largest are folders:
`loop/director/` (the run's parts) and `loop/facet/` (the facet loop's state, policy and
scoring, one `phases/*.ts` file per round phase); model-facing text sits in sibling
`*-prompts.ts` modules.

**Seed upgrades.** `applySeed` ([`src/substrate/seed-upgrade.ts`](../../src/substrate/seed-upgrade.ts),
manifest in userData) copies the seed into the mutable workspace and keeps files the agent edited,
so a Git SHA alone does not identify runtime harness bytes. Outcomes are added, updated, kept,
moved and retired:

- The manifest keeps entries for paths the booting seed does not ship, so an older build cannot
  orphan a newer file; a file the manifest does not know is re-owned when its bytes match a
  backed-up seed vintage.
- A retired path (`RETIRED_SEED_PATHS`) is backed up and removed only when its bytes match a
  vintage; its entry stays, marked retired, and nothing retires without a backup directory. The
  one pre-manifest pass retires too and writes the entry as it removes the file.
- `SEED_MOVES` reports a kept copy of moved code as `moved`, noted in the agent's memory each boot
  (`RecoveryService.noteSeedMoves`; [harness runtime](../harness-runtime.md)).
- Retired craft checks leave an installed `library/checks.json` only where the install's own
  `library/recipes` holds the answering recipe; ids the seed still ships are refreshed in place with
  counters kept (catalogue version 2). Both user-facing surfaces report all outcomes.

**Layout migration.** `migrateHarnessLayout` (seed manifest `layoutVersion` 2) moves a
pre-TypeScript workspace once, after a validation fork of it booted; until then `applySeed` defers
the `.ts` modules ([harness runtime](../harness-runtime.md)).

**Self-edit gate.** `guardian.validate_edit`
([`src/main/core/self-edit-gate.ts`](../../src/main/core/self-edit-gate.ts)) type-checks a proposed
code change in a validation fork with the vendored TypeScript 7 compiler
([`src/substrate/type-gate.ts`](../../src/substrate/type-gate.ts), `resources/tsc/`) and boots it;
`guardian.write_self` alone changes the agent's files ([harness runtime](../harness-runtime.md)).
Keep the seed's tool descriptions accurate to it.

**Boot inbox.** At boot the harness restores its follow-up queue with the `events.inbox` RPC
([`src/main/core/inbox.ts`](../../src/main/core/inbox.ts)), not `events.list` of every
conversation: it answers only the open queue records per conversation (with the user's message id
in each, only the last pause, answered or removed messages dropped). The boot repair seeds it, so
the harness boot right after reads almost nothing. Per message, `handleUserMessage`, `runTurn` and
`runDelegatedTurn` still read a conversation's full log.

### Snapshots and health

A snapshot is healthy only by booting. Healthy code comes from `restart_studio` plus healthcheck, a
cold start that booted exactly a snapshot's harness commit, or a validation fork whose booted code
is exactly the snapshot's. A harness (or "both") snapshot the harness calls healthy is healthy for
its harness half only when it differs from the last healthy one in files that never run
(`RUNS_AS_CODE`); a "both" record keeps its game half healthy with `harness_healthy: false` until
then. Snapshots around a seed upgrade or the migration follow the same rule.

**Recovery.** `HarnessHost.start`/`restart` take `{callerRecovers}`: a death before `ready` goes only
to the caller. `core.start` stops the host on a boot failure, runs `recover()` (rewind to the newest
healthy harness snapshot) and throws only if the harness is still not ready; `main/index.ts` then
offers **Reset harness to shipped version** or Quit. If a rewind target exists but restore or
restart fails, `recover()` reseeds and restarts (`harness_reseeded`); `watchdog.failed` is emitted
only if that fails too. A self-update pending during a rewind is recorded failed and never marked
healthy. The wedge watchdog ignores time the Mac was asleep (a tick more than three intervals late
resets the silence clock) and a host call in flight; page and record calls end at their deadline
(`substrate/rpc-deadlines.ts`). Three exits in five minutes or ten silent minutes trigger recovery.

**A harness child dying mid-run** is repaired without an app restart (`onUnexpectedExit`,
[feature map](feature-map.md)): StudioCore aborts every delegation, `run.settled` per open run
frees the idle watch, and the reborn loop closes each run as paused (`openRuns`) for `core/auto-resume.ts`
([automatic resume](../harness-runtime.md#automatic-resume)). A run a quit or
crash interrupted is repaired at boot as paused, keyed on its journal artifact; its synthetic
`run_finished` claims a build only when the head moved off the base, and Resume goes on from that
journal ([the full journal](#the-run-director-workers-and-judging)). The Mac is held awake from
`run.keepawake` until `run.settled`.

**Learned changes** are applied, listed and undone by the host
([`src/main/self-changes.ts`](../../src/main/self-changes.ts)): SkillOpt's staged records (only
`skills/<skill>.md`, or `library/contract-lessons.md` for `target: "lessons"`, whole on their staged
text or replaying all their anchored edits; a planted link refuses it), the architect's, and
the agent's own. Each records `post_snapshot_id`; **Undo this change** (`studio:selfchange.undo`)
reverses its diff alone, recording `self_change_undone`. Rewinds restore `library/games`;
`rollbackTo` refuses during a run, contractor or user turn. `StudioSettings.learning` gates
automatic apply, the sweep, the architect and `studio:skillopt.start`; the harness asks `learning.enabled` first.

## The run: director, workers and judging

The harness loop in [`src/harness-seed/loop/`](../../src/harness-seed/loop/). Product behavior is in
the [builds and live product page](../product/builds-live.md); the chat's lifecycle is
[the conversation's](../conversation-coordinator.md). Every loop fix gets an incident
row in `tests/conformance/harness-incidents.test.ts` ([recipe](recipes.md#harness-incident-fix)).

**Plan review.** Composer commissions with Plan mode on are reviewed before execution by
`PlanReviewController` ([`src/main/plan-review.ts`](../../src/main/plan-review.ts)), which keeps the
request, settings, plan and versioned status in thread metadata and emits `plan_review` events. Only
`studio:plan.answer` approves; conversation text revises. There is no approval expiry and no run
clock while approval is pending; Cancel/Stop invalidates it; a waiting plan survives relaunch.
Approval dispatches the brief with the legacy `reviewPlan` flag cleared.

**Scout.** Before the plan, a read-only scout (`loop/scout.ts`) plays to the requested state and
reports a `setup` (actions or a demo, a `verify` probe), a builder count and what exists;
`decompose` folds the plan to that ceiling (`clampFacets`). Capture and the computer tool begin a game
whose `state().flow` is not in play (except `begin: false` and the playtester), then replay
`run.setup`; evidence replays, seeds, begins. Typed facets carry `requested-state`. No
scout on a completion-only engine; a failed one is a card.

**Director.** On a session-capable engine Autopilot is one session's run (`loop/director.ts`,
`loop/director/`); `run.classic` and completion-only engines take the programmed pipeline. The
director leads the integration worktree (at the base commit, or the prior integration head on a
resume) — the long turn's from inside it, a waking lead read-only (one session, below) — with its
own preview window and tools: `plan`, `goal_update`, `worker_start`, `worker_status`,
`worker_steer`, `worker_stop`, `judge`, `playtest`, `integrate`, `show`, `note`, `finish`, `look`.
The studio forwards each tool call to the harness (`HarnessHost.dispatch`, `director_tool`). Rules:

- Every declared tool but `resolve_root` first syncs the head (`headSynced`) to the integration
  head, kept on `refs/studio/runs/<runId>/integration`.
- `worker_start` refuses until `plan` was called (`autopilot_plan_review`, kept on
  `journal.director.plan`); `replaces=<id>` marks a restart. With a plan to review, the first
  `worker_start` answers at once and the user's answer or the window's end wakes the lead
  (`run.waking`). After a Resume a pre-pause worker's id is refused unless `from=` is that worker.
- The wake loop (`loop/director/wake.ts`, rules `wake-schedule.ts`, words `wake-prompts.ts`): the
  director ends its turn after each decision and the harness resumes the session with a digest
  (the user's words verbatim, what happened, where the run stands). The user, finish and a
  worker steer wake at once, worker news after 5 s; timers cover the plan window, wrap-up, the
  workers' limit and a 20-minute heartbeat; at most 30 wakes an hour. An idle run asks once,
  then wraps up (a goal build after the art director's look); each wake appends `director_continued`.
- The full journal (`loop/director/journal.ts`): each save writes the run's record on
  `journal.director` (clock with `workedMs`, plan, ledger, health, workers' limit, recent log,
  workers, wake state). A Resume gets the working time left (`loopRunClock`, paused time excluded), a
  reopen (`director/reopen.ts`) a fresh clock, and reads the rest back (`restoreLoopRun`,
  `run.priorWorkers`, `RESUMED AT`).
- `run.directorLoop: "turn"` (or `STUDIO_DIRECTOR_LOOP`) keeps the long turn until its removal
  gate ([harness runtime](../harness-runtime.md)).
- User steering reaches the director as USER SAYS once per steer and run; a steer addressed to a
  worker goes to it (`routeUserSteers`), an immediate one through `engine.interrupt {cwd}`.
- Live chat (`loop/live-chat.ts`, `director/lead-line.ts`) and one session
  (`director/lead-session.ts`, `conflict-worker.ts`, `after-loop-run.ts`, `reopen-run.ts`, the host's
  `#leadRoot`): the lead is the chat's own session, which answers again after the close
  ([live chat](../conversation-coordinator.md#live-chat-during-a-build),
  [after the build](../conversation-coordinator.md#after-the-build-the-same-session)).
- Each turn of the director's session ends with a host-written `session_activity` (`completed`,
  `interrupted` or `failed`), never a `turn_ended`, so the chat shows the build between turns.
- A monitor (`loop/director/workers.ts`) reads each running worktree (`git status --porcelain`,
  `git diff -U0`, the mechanical reviewer; no model, window or index lock) and notes only a
  change; `waitDigest` gives each worker its reviewers' ideas and the room left.
- Defects a judge names for another worker's seam route to that worker's live spec
  (`makeRouteDefect`); a finished owner's defects go to `defectsNobodyOwns`; never to
  itself.
- The director owns a worker's ladder when it gives one (`move`, `milestones`,
  `spec.moveOwner`); otherwise a named move is guidance until `polishStreakEscalate`
  polish-only rounds escalate it (`move.escalated`). Steered rungs first; a rung climbs on its
  check or the judge's word, `RUNG_MISSES` set it aside (`facet/round-judgement.ts`); reviewers
  fill the open last rung (`facet/growth.ts`), then `bigMove`. `integrate` takes a running worker's
  `lastAccepted`.
- `spec.stage = "finish"` (`facet/stage.ts`, per round, `stage=`): polish list
  (`judge/taste-finish.md`) is the work, no move or streak; a preferred, unbroken build ends it.
- `run.scope` (`loop/scope.ts`) is the user's words; `scopeLines` sits beside every goal, and
  an `adds` proposal is a decision card (`facet/beyond.ts`), never a move.
  `critic=screen` marks the screen's one owner (`loop/screen-owner.ts`).
- Two or more looping parts need `plan contract=`/`vision=` (`director/contract-gate.ts`),
  committed as `docs/MODULE-CONTRACT.md`/`VISION.md` before loop workers fork; `integrate
  worker=a,b` is a wave (one health pass, `state.waveHead`); `loop/registry.ts` refuses lost
  registrations.
- The finish mark (`budgets.ts` `finishMarkMs`), `shipLookAt` or `judge ship=yes` runs the art
  director (`director/art-direction.ts`, `loop/ship-review.ts`): defects and `doNotRegress` reach
  owners; it never vetoes ([harness runtime](../harness-runtime.md)).
- `worker_start` may override `FACET_POLICY`; `loopDigest` puts each worker's phase, streaks and
  checks in the digests.
- The session ends before the hard deadline (`wrapReserveMs`); the two closes are one function
  (`closeTheLoopRun`).

**Refs and the user's repository.** Everything a run must find later lives on the studio's refs:
`refs/studio/runs/<runId>/integration`, `.../workers/<facetId>` (moved to every accepted commit and
again before teardown), `.../attempts/<facet>/<n>` (`-stopped` for a stopped round),
`.../spikes/<facet>/<id>` and `refs/studio/snap/<id>` (`loop/repo.ts`, `snapshots.ts`). One committer
signs studio commits (`STUDIO_AS`, `GIT_ENV`). A chat keeps the game folder from before and after
each answered message the same way, on `refs/studio/chat/<thread>/before|after/<message>`, for
rewinding ([conversation lifecycle](../conversation-coordinator.md#sending-and-rewinding)). Builder
notes are `docs/notes/NOTES.<facet>.md`.
`.studio/` is gitignored; on the long turn the studio copies `.studio/DIRECTOR.md` to run and thread
artifacts and restores it on resume, clamped to `MAX_DIRECTOR_MEMORY`. Adoption writes a real `.gitignore` before
`git init`. Snapshot commits land on the user's checked-out branch with hooks disabled and are
refused during a merge, rebase, cherry-pick or revert. `SnapshotEngine.restore` runs every check
before any reset and refuses (`branch-changed`, `history-changed`, `operation-in-progress`,
`rescue-failed`) leaving the folder untouched; the mandatory rescue snapshot is named on
`workspace_restored`. Every loop shell command is built in `loop/git.ts`; model text goes through
`shellQuote` and a commit reaches a command line only when `isCommit`.

**Base stage and contract.** An empty game gets a base stage first (`autopilot_base`,
`journal.base`; a third of the time left, thirty minutes at most; none for a team,
`foundationFirst`). A brought game whose contract is `missing` gets `installContract` in the
integration worktree, verified by a full evidence pass, committed as `studio: install contract`,
which becomes `state.startEvidence`;
`journal.contract` keeps it. `worker_start` runs the health pass once per fork commit and refuses
one that does not run; the run's own starting points (`state.baseHeads`) are exempt from
blankness; inherited console errors are a warning, not a void. A worker starts a round only
when the time left covers one (`tooLateToStart`, measured `minIterationMs`); a build turn at
its mark is asked to finish cleanly in the same session (`WIND_DOWN_ASK`).

**Verdicts.** Every judged build leaves one record, `verdictRecord()` in `loop/verdict.ts`:
`{ pass, build, against, observed, measured, seen, decision, because }`, where `because` has no id,
sha or harness word. Rounds carry it on `facet_iteration.verdict`; the lead's gate, judge, health
pass and close append `director_verdict`. The Builds result panel shows the staged build's newest
record (`headVerdict`); step panels, gate tooltips, the chat and the judges' sheet print its
sentence. `run-steps.ts` decides a step's state from merges first (`mergedRounds`: a
loop's merge takes its kept rounds; a lead's merge, by log position, takes the last kept round or,
with none, every unjudged round started before it) and judges second. A flip counts as proof only when `strongFlips` (a
scene/pixel/metric/probe/demo/play check, or a vision check the plan wrote); otherwise the blind
side-by-side pick decides (`acceptRound`). A self-measuring regression counts only if a second
look reproduces it; only a judge's own gap (`judgedGap`) grows a check or THE FIX. An unmeasured vision check needs a yes at
`VISION_FLIP_CONFIDENCE` (0.7). Judge-grown questions are deduplicated (`sameDefectOpening`), a
reading defect becomes a probe suggestion, and a question hedged twice under 0.5 retires. Counts
separate planned from grown checks (`checkCounts` in `words.ts`). Questions about one camera ride
in one call (`askVisionBoard`, `visionBatch`, `MAX_BATCH_QUESTIONS`); an unanswered id is never a
pass. Health, judge and gate passes are patient (`patientEvidence`: up to three looks on a load
race). An engine limit is waited out when it resets well before the deadline; otherwise the run
closes paused, naming the limit.

**Landing.** At the close the harness stops workers, syncs the head, takes a fresh health pass,
judges it unless stopped (`judgeTheLanding`), and lands when the head moved beyond the start and
loaded or a judge passed that sha.
`report.landingResult` records `verified`, a `how` token and the morning card's `line`. A landing
blocked by commits (`could-not-land`) or uncommitted changes (`uncommitted-changes`) in the game
folder waits for **Make it live** (`landBuild`); **Play this build** is `showBuild`
([feature map](feature-map.md)). A stopped round is committed
to its `-stopped` ref and recorded `facet_stopped` with no verdict and no rollback.

**Nested repositories.** A game that arrived as its own Git repository is a gitlink. `worktreeAt`
copies the nested tree into every worktree; with the user's consent (`AdoptOptions.versionNested`)
it is converted in a deterministic commit. `landBuild` applies the same conversion before merging
([feature map](feature-map.md)). `integrate` fails when a merge still holds the path as a gitlink
(`unversionedNested`), and the run's landing stops with `nested-not-versioned`.

**Game kinds and evidence.** `loop/kinds.ts` is the one table of eight kinds, with their traits
(off until declared), probe axes, eye cameras, critic and play script;
`gameLine(run.game)` heads every judge call. `run.game` comes from the plan, then the scout, then
`studio.json`'s nested `game` block; the plan's declaration is written back once a
run. `gatherEvidence` (`proveStep`, `reachPlay`, `classifyEvidenceFailure`) is in the
[harness runtime guide](../harness-runtime.md). `library/checks.json` holds
technical checks only; craft checks are `library/recipes` entries retrieved by failing check,
named defect or plan. Own-shape games get own-shape briefs and review rules (`renderBrief`,
`reviewDiff`) and a seam per worker.

**Ledger and lessons.** `loop/ledger.ts` appends one record per outcome to
`library/games/<game>.jsonl` in the harness workspace (never the user's repo); `deriveLessons` writes
`library/games/<game>.md`, and the next run carries the top five as `LAST TIME ON THIS GAME`.
`ledgerFromEvents` backfills from an older run's log, never fatally. The ledger always
writes; SkillOpt keeps its own gate.

## Projects, builds and previews

**Project shapes.** `ProjectShape` ([`src/shared/game-project.ts`](../../src/shared/game-project.ts),
decided in [`src/substrate/project-shape.ts`](../../src/substrate/project-shape.ts)) is decided by
evidence — every `<script src>`, `package.json`, bundler config, engine runtime files — never the
entry filename, and recorded in `studio.json` on first open: `main`, `build`, `serve`, `kind`
(`three-vite`, `three-modules`, `canvas2d`, `phaser`, `engine-export`, `own-script`) and `own`. A
folder is the studio's template only with both `contractVersion` in `studio.json` and the vendored
three import map. `findGameRoot` looks one folder down. An `engine-export` game can be played and
photographed but never starts a run.

**Opening a folder.** New game's Open existing and home's Open a folder… are the UI's way in.
`studio:project.pick` and `studio:project.inspect` (candidates, preflight) write nothing. The
Open Game sheet ([`src/renderer/panels/OpenGameSheet.tsx`](../../src/renderer/panels/OpenGameSheet.tsx),
rows from `shape-words.ts` `openOptions`) lists candidates, runners, run blockers and planned
writes (`plannedWrites`); only its button calls `studio:project.adopt` with the row's `OpenChoice`. A nested game is adopted as the project;
keeping the parent passes `template: false`. Adoption never writes the template's entry or pages
beside a real entry; an own game gets `CLAUDE.md`/`NOTES.md` from `game-template/*.own.md`.
`game.upgradeContract` replaces only unedited shipped `src/studio.js`/`src/hud.js` copies older than the
template's (kept as `<name>.v<generation>.js`); an edited contract keeps its HUD, and an edited
older HUD is noted and narrows builders' HUD rule (`loop/held-hud.ts`).

**Builds.** `preview.load`/`preview.reload` build through `GameBuilds`
([`src/main/game-build.ts`](../../src/main/game-build.ts)) and serve the output. A build never runs in
a folder the user owns: the folder is mirrored into a shadow under
`scratch/builds/<project>-<hash>/` (Git's view of the project plus `.env*`, `node_modules` linked,
output kept in `last/`); a studio worktree under `scratch/` builds in place. Builds are memoised on
a tree key; the stage's **Try again** (`reloadPreview({retry: true})`) forgets the memo and
re-resolves the login shell PATH ([`src/substrate/toolchain.ts`](../../src/substrate/toolchain.ts); on
Windows the process PATH plus the registry's machine and user PATH).
The package manager comes from the lockfile; installing is the one thing that opens the network
(`registry.npmjs.org`, `studio:packages.install`, behind a button), and only the lockfile's own
install line runs (`INSTALL_COMMANDS`/`isInstallCommand`). A failed or empty build shows the last
good output with the reason (`studio:build.problem`,
[`src/shared/build-problem.ts`](../../src/shared/build-problem.ts)); a judged load still fails. Build
actions coalesce identical `showBuild` requests and serialize worktree replacement per project;
preview loads serialize per handle.

**Served page.** [`src/main/page-serve.ts`](../../src/main/page-serve.ts) holds the pure serving
decisions (`servedRelative`, `resolveServed`, `servedLocation`, `routeHttp`,
`gameRequestAllowed`, `previewNavigationAllowed`) and the only page rewrite; the input dispatch
string is in [`src/main/page-dispatch.ts`](../../src/main/page-dispatch.ts). `resolveServed` checks
lexically and then realpaths every request against the real root pinned at load: 404 for a missing
or non-regular file, 403 for an escape (including a root swapped after load), 400 for a malformed
one. The rewrite touches only the served document (`shouldRewrite`: the entry or a document/frame
fetch, never under `vendor/`, never over 8 MB, never non-HTML), never a file on disk: charset first,
the classic shim script, the page's own import map with only `three` and `three/webgpu` pointed at
the studio hook (or the studio's own map), the module hook, then the page. It is idempotent; a
blocking meta CSP gets one console line, not an edited policy. Bundled games serve as
`http://localhost:<port>/`, intercepted inside the preview's own session.

**Network policy.** The game partition is closed: `onBeforeRequest` allows only `game:`, `data:`,
`blob:`, `devtools:`, registered loopback ports and https GET/HEAD to the exact public library and
font CDN hosts in [`src/substrate/preview-network.ts`](../../src/substrate/preview-network.ts);
`#serveLoopback` answers 403 instead of fetching; navigation stays on `game://` or the loopback
origin; WebRTC is limited to proxied UDP (`confinePreviewContents`). Blocked origins are noted once
per load; `validateAt` and the Open Game sheet name hosts a page loads code from. There is no
per-game network opt-in yet.

**Game view.** Every game view (Live, facet ports, selftest, e2e fixtures) comes from
`GamePreview.create()`: its own session partition (`game-preview`, `game-preview-facet-N`),
`sandbox`, `contextIsolation`, no Node, `webSecurity`, no preload or IPC, `window.open` refused.
The session grants pointer lock (plus fullscreen on screen) and denies every other permission,
microphone and camera included. The view turns off `GAME_DISABLED_BLINK_FEATURES`
(`OnDeviceWebSpeechAvailable`, `InstallOnDeviceSpeechRecognition`): on-device speech recognition
asks for a Mojo binder only Chrome registers, and Electron kills the renderer for the bad message
(reason 123). With both off those members exist in no frame; a plain `start()` ends in
`not-allowed` and speech synthesis is untouched. The guard is engine-level: a page-world stub misses
about:blank, srcdoc and blob: documents. `page-shim.test.ts` only proves the list is applied; the
[speech selftest](verification.md#acceptance-evidence) proves it holds. Any other renderer death
sets `status().crashed` and pushes one `render process gone: <reason>` console line, source `studio:window-gone` (a cross-site
frame's death reports nothing); nothing reloads the page, a death during `load()` rejects it, and
un-raced `evaluate()` calls never settle.

**Page world.** [`src/page/`](../../src/page/) is bundled into `vendor/studio/{shim,hook,hook-entry}.js`.
`shim.ts` owns the clock (`step`, `pause`, `seed`), counts `steppedFrames` and yields a microtask
per stepped frame; `window.__studio` is a merging facade that keeps whatever the game defines. The
evidence globals (`__studioClock`, `__studioDraw`, `__studioCapture`, `__studioGl`, `__studioHook`)
are accessors with no-op setters. `hook.ts` reports renderers and reads the scene and camera off
frames the game draws; a bundled game adds `installStudio({ renderer, player })`. `capture.ts`
reads the canvas at the end of a drawn frame and composites over the page background (WebGPU reads
depend on the recorded `alphaMode`); otherwise the compositor's `capturePage()` answers. Every shot
records provenance (`stats.source`, `composited`, `drawCalls`, `provenance`, `surface`). Draw calls
are counted at the graphics API (`counters.ts`); WebGL and WebGPU are equals. `game-template`'s
`src/studio.js` is the contract every template game installs; never remove a method.

**Readiness and validation.** [`src/substrate/preview-ready.ts`](../../src/substrate/preview-ready.ts)
waits for a fact (`READY_PROBE`, `via: shim | contract | none`) and never throws. The order is
ready → gesture → setup → start, with one boot budget (`bootBudget`, 1000–60000 ms, default 15000,
`studio.json` `bootMs`). A spent budget is a note (`timedOut`), not a failure; `phase: "failed"` is
only a page's own boot failure. `validateAt` answers `loaded`, `attached` or `missing`;
`game.attached` asks the live page what the studio attached to. `preview.ready`, `preview.gesture`,
`preview.pageUi` and `game.attached` are host RPC calls, not agent tools.

**Worker windows and computer use.** Every building delegation and every looking read-only session
gets one pooled preview window for the session
([`src/main/core/session-port.ts`](../../src/main/core/session-port.ts)). `capture` reloads and
photographs; `computer` ([`src/substrate/computer-tool.ts`](../../src/substrate/computer-tool.ts)) is
the studio's own computer use with Anthropic's action vocabulary plus `camera`, `state`, `reload`
and `console`. Headless ports render offscreen. Native input is sent and synthetic copies withheld
per event type once a trusted event is seen; a mousemove always sends its synthetic copy with the
real delta, and `game-template/src/studio.js` de-duplicates. Two pool windows are never a worker's
(`workerWindows(max)` = max − 2, at least 1). A lease the harness takes carries its boot as `owner`
and is freed when that harness dies (`PreviewPool.releaseOwnedBy`). When no window is free, judge
and playtest answer *no window free*; unskippable passes look through the stand-in, never Live. `preview.capacity` reports free windows and memory. Concurrent first `state` and
`console` requests share one navigation. Each action emits
`preview.frame` and `preview.screen`.

**Native preview layering.** Modal dialogs hide the WebContentsView; popovers hide it only while
their rectangle intersects the Live slot; identical bounds do not repeat IPC.

## Plugins, MCP and Genex

Contracts for authors are in the [plugin SDK](../plugins.md) and [plugin guide](../PLUGIN_GUIDE.md);
user setup is in [connections and context](../connections-and-context.md). See the
[plugin tool recipe](recipes.md#plugin-tool).

**Plugin host.** [`src/substrate/plugins/`](../../src/substrate/plugins/) validates packages, persists
installs, pins active-session versions and owns backend processes;
[`src/plugin-sdk/backend.mjs`](../../src/plugin-sdk/backend.mjs) is the child bootstrap. Capabilities
are service checks, not an OS sandbox. Custom panels run in an opaque sandboxed frame. API versions
1–3 share the host; `validateManifest` returns a canonical manifest and version-gated fields are
refused under API 1. The registry fires `onChange` (`plugins.changed`). Install records carry an
origin (`bundled`, `local`, `catalog`, `github`, `index`) and an identity (`pluginIdentity()`); a
package whose id belongs to another identity is refused unless the user chose **Replace and erase
data** (`authorizeReplacement`, single use, ten minutes). Bundled seed ids cannot be installed from
elsewhere; removed seeds never auto-enable. Account and install actions never appear in model tool
schemas. Registry mutations are serialized.

**Consent.** A tool declaring `confirmation` waits for a consent card: `StudioCore.requestConsent`
holds the call until the user answers, it times out, or Stop or the turn's end withdraws it; only
`studio:plugins.consent` approves, both agent paths share the wrapper, and no seam fails closed
([consent model](../plugins.md#the-tool-consent-model)). A request left unanswered by a previous
process is declined once, `by: restart`, before the harness boots.

**Marketplace and scan.** [`src/substrate/plugins/marketplace.ts`](../../src/substrate/plugins/marketplace.ts)
holds the https index and the sha-pinned GitHub install (each blob checked against its git object
id and by `assertRelativePath`; symlinks and submodules refused, caps enforced, network injected).
`scan.ts`'s verdict is disclosure, not isolation, and a file it did not read is never `safe`.
Catalog downloads verify digest and manifest and run no install hooks; dependency copying resolves
the real `node_modules` and refuses anything outside it. A hot reload that changes a plugin's MCP
servers or network hosts is refused until the folder is loaded again. The app applies its own
catalog policy on every index read (`STUDIO_CATALOG_POLICY`, `applyCatalogPolicy`; the catalog
repo's `policy.json` must change with it). Rules, update cleanup and debug logs are in the plugin
SDK: [marketplace](../plugins.md#marketplace), [GitHub installs](../plugins.md#install-from-github),
[scan](../plugins.md#the-install-time-static-scan) and [hot reload](../plugins.md#hot-reload-and-debug-logs).

**Managed native jobs.** API 3 services
([`native.ts`](../../src/substrate/plugins/native.ts), `native-process.ts`) run reviewed recipes:
declared runtimes, pinned installers, fixed job recipes and limits. Agents choose only validated
inputs; only a trusted setup action installs a runtime; job processes are confined, backend code is
not. Plugin APIs grant no orchestration, judging or learning authority. The job's sandbox
(`nativeSandboxProfile`), its process-group kill and output delivery (`copyDeclaredOutput`,
`copyRuntimeTree`) are specified in [API 3 managed-native services](../plugins.md#api-3-managed-native-services).

**MCP connectors.** Studio's main process is the only MCP client. `McpRegistry`
([`src/substrate/mcp/registry.ts`](../../src/substrate/mcp/registry.ts)) owns connectors,
connections, tool caches, health and leases; revocation is immediate. A connection is per project
only for a per-project launch (`perProject`) or a connector that shares the project root; otherwise
one connection serves every game. A connection with no lease and no call in flight closes after
10 minutes (`IDLE_CLOSE_MS`; `idleCloseMs` and `schedule` are injectable) and reopens on the next
use.
`engine-homes/mcp/connectors.json` holds names only (atomic 0o600 writes in a 0o700 folder); every
value lives in a `SecretStore` under `engine-homes/mcp/secrets` and is materialized only into a
child's environment or a header at connect time. Without OS encryption the secret port is null and
the card says why values cannot be stored (`secretsLocked`, a `SecretStorageIssue` code). The agent-facing RPC has exactly `mcp.tools` and
`mcp.invoke`; people manage connectors over `studio:mcp.*` in the Connectors card.
`toolsFor(project)` connects enabled, in-scope, trusted connectors in parallel (10 s to connect,
10 s for `tools/list`), applies allow/deny, caps at 64 tools and exposes
`<connectorId>__<tool>` on the same live-tool path as plugin tools: Claude sees
`mcp__studio__<connector>__<tool>` on the one in-process server, Codex through the file bridge, the
local harness after its plugin loop. Every call is a `connector_tool` event with the answer capped
at 4 KiB. Connector tool results, call errors and stderr health messages are redacted of known
values (materialized env and headers, launch `secrets`, OAuth tokens) and then token shapes, through
[`src/shared/redact.ts`](../../src/shared/redact.ts), the one redactor for the event log, the dev
control and MCP. Collisions shorten a tool name's base so the suffixed name stays within 48
characters (`uniqueToolName`). Judges, critics, playtesters, read-only sessions, the coordinator
and optimization candidates get no connectors; the Auto chat, a Loop chat and a build's lead get them.

**Connector trust.** A stdio connector is trusted native code: `studio:mcp.save` computes a launch
digest over command, args, cwd and variable names, and a mismatch needs the native trust dialog
(`studio:mcp.trust`, blocked in every fixture profile) before `launchTrusted` starts it. The
dialog names the program that will run, resolved on the login `PATH` by `resolveExecutable`, the
same lookup Connect uses. HTTP/SSE connectors are https-only (loopback http allowed) with static
header secrets or explicit browser OAuth (`mcp/oauth.ts`). Secrets are unlocked explicitly and
leased in host memory (`mcp/session-secrets.ts`); a locked connector throws `McpSecretsLocked` and
is not started. Disconnect and remove revoke OAuth tokens at the server where it offers RFC 7009
revocation (refresh token first, 10 s limit, after the local record is deleted); remove erases every
`mcp.<id>.*` secret, and an edit that drops an env or header name erases its value. Config import
keeps a `${VAR}` placeholder as a name that still needs its value (`needsValue`). Project roots are
opt-in and are not a sandbox.

**Plugin MCP servers.** An API 2+ manifest's `mcpServers` are connectors the plugin owns: published
while it is enabled, withdrawn whenever its backend stops, never written to `connectors.json`, named
`<pluginId>-<serverId>`, trusted by the install dialog; a changed launch is a permission expansion.
The host launches `process.execPath` with `ELECTRON_RUN_AS_NODE` on a contained script, a working
directory and `HOME` under the plugin's storage, and only the declared environment.
`credential-file` passes the token down file descriptor 3 only while a host credential lease is
active: a `node` server gets `/dev/fd/3` as the variable and the bare token on the pipe
(`PluginMcpLaunch.credential()`); the virtual path and the `GENEX_TOKEN=` line
(`credentialFile()`) are for Studio's own Genex CLI (`host-cli`) only. The launch reports the token
and stored `secret:` values as `secrets`, so the connection redacts them from what the server says.
`host-cli` is reserved for id `genex` with a `bundled` source.

**Genex.** The bundled Genex plugin
([`src/plugins/genex/`](../../src/plugins/genex/)) runs the restricted asset adapter (`adapter.ts`)
in its backend; the pinned CLI owns quotes, locking, reservations and the credit ledger. Job state
lives under `engine-homes/genex/projects/<project>`. Arguments are arrays; operations, inputs and
destinations are validated; hosted initialization, domains and billing administration are not
exposed. The CLI environment is built from scratch (`genexCliEnv`, telemetry off by default). The
creator MCP (`creator-mcp.ts`) connects only to `https://mcp.genex.games/mcp`; `genex blender mcp` is
the `genex-blender` connector with `blender_export_glb` denied. Credentials use the Keychain-backed
SecretStore, start locked, and are read only by the trusted `unlock` action; the token reaches the
CLI through an anonymous descriptor read by `resources/plugins/genex/preload.mjs`, never arguments,
environment or game folders. Remember intent is recorded only after a credential exists and
revoked before deletion. `genex__asset` is offered only while Genex is enabled; agent input cannot
raise allowances or approve characters; a local Stop does not cancel or refund a remote job;
reconciliation reuses request and generation ids. A public export (the Export button, the
harness `game.export` and the Genex publish stage) refuses a file holding any value
`knownSecretValues()` returns, naming the file and never the value. `inspect_use` and `verify_use`
(`genex-outcomes.ts`, `audio-observation.ts`) record observed use of a captured version, not proof.
Publishing verifies the upload against the hosted staging revision; an unresolved upload is never
retried automatically and is settled by **Check again** or `publish-allow-upload`. Readiness or a
successful upload never certifies gameplay.

Genex account rules: `status` returns the operation catalog for every provider path; the CLI's
`allowance.enforced` is authoritative, Studio uses the pinned CLI's no-project-allowance mode and the
Genex service still enforces credit admission, which never widens a live test's spending
authorization. Deleting the credential blocks new submissions before the disk operation finishes;
HTTP 401 reports disconnected; approval claims are serialized before a paid preview or finalize;
positional generation ids cannot start with a hyphen. Inspection frames cross the Codex bridge as
temporary files (`imageFiles`) removed at delegation cleanup. Retrieval uses the remote
`generationId`; `inspect_use` and `verify_use` use the delivered Studio job `id`, and a job whose
files are not in the caller's workspace is refused before observation.

**Plugin skills.** A manifest skill is inline text or (API 3) a package `.md` file with a summary
(`PluginSkill`, `shared/plugins.ts`). `PluginRegistry.snapshot()` reads tools, guidance and the
applied plugin/skill set from one live view, so a brief's tools and skill lines agree; a file skill
contributes an index line (`skill-prompts.ts`) and the host-answered `<id>__skill` tool, which reads
only declared files through a checked handle, pages at 24,000 characters and writes nothing.
Skills are served from the installed package and never written into games. Once a session
answers, delegation records its applied set on `tool_registry_applied` by session id; resuming it
folds that back (`ConnectionService.lastApplied`) and prepends `withdrawnNotice` for withdrawals. Updates and hot reloads
diff skills (`lastSkillChange`, scan `skillDigests`) for the trust dialog and plugin page.

**Genex host tools.** A manifest tool with `host` (bundled `genex`, API 3 only) runs through the
registry's `hostTool` hook, set to `genexHostTool` in `#wirePluginServices` and gated in `index.ts`
by the native steps `studio:plugins.host-cli` / `host-package`; consent cards show
`genexHostConsent`'s summary of the validated call. `GenexCliService`
(`main/core/genex-cli.ts`, allow-list in `genex-cli-policy.ts`) runs the plugin payload's pinned
CLI (`resources/plugins/genex/node_modules/@genex-ai/cli-demo`) in ProcessSandbox, in a fresh `<userData>/genex-cli/<id>` that is also `HOME` and is
removed afterwards; never a game folder, where the CLI's skill sync and contract healing would
write `.claude`, `AGENTS.md` and ancestor contracts. Only `api.genex.games` is reachable, the
games root and every game are write-denied, the token goes on stdin, and project commands see
only `{id, slug}`. `GenexPackageService` (`genex-package.ts`) checks the name against
`GENEX_GAME_PACKAGES` and the binding folder by realpath (the game, or a registered git worktree of
it under scratch), then calls `GameBuilds.addPackages` with the toolchain's `add` command.

**Blender.** The Local Blender plugin supplies `blender__model` through the ordinary API 3 registry
with a managed local runtime; core has no special Blender tool.

## Assets

- **Ledger.** `PluginServices.onDelivered` fires after every `assets.deliver`; `StudioCore` records
  `asset_delivered` (project, plugin, job, files, worker attribution) and emits `asset.delivered`.
  [`src/main/plugin-activity.ts`](../../src/main/plugin-activity.ts) builds the
  `plugin_tool_started`/`plugin_tool` pair for both agent paths. The Builds graph joins them on
  `callId` and `jobId`.
- **Inventory.** [`src/main/game-assets.ts`](../../src/main/game-assets.ts) enumerates `assets/**` and
  `public/assets/**` read-only (lstat, symlinks skipped, capped), reads Genex `job.json`
  path-contained, and joins with the ledger by fixed precedence (ledger, job record,
  `blender_asset`, path shape, `imported`); SHA-256 joins identify renamed copies. A delivered file
  is never evidence the game uses it. The renderer never receives absolute game paths. Asset
  formats come from one table, [`src/shared/game-assets.ts`](../../src/shared/game-assets.ts)
  ([recipe](recipes.md#asset-format)).
- **Readers.** `studio:game.asset.still` reads the game folder and Genex frames only (allow-listed,
  byte-sniffed, 16 MiB) and never widens `readRunStill`. `studio:game.asset.preview`
  ([`src/main/asset-preview.ts`](../../src/main/asset-preview.ts)) takes a project and a relative
  reference inside `assets/` or `public/assets/` (or a recorded Genex output), rejects traversal,
  links, hidden and executable files, and caps reads at 100 MiB.
- **Viewers.** `AssetPreview` uses native media elements and the trusted `asset-model-viewer` for
  models and HDR/EXR/KTX2 textures; companion URIs resolve only inside the same asset root; decoders
  ship with the renderer and the CSP allows WebAssembly and blob workers, not arbitrary evaluation.
  Viewers never mutate usage evidence.
- **Checkpoints.** [`src/main/asset-checkpoints.ts`](../../src/main/asset-checkpoints.ts) commits only
  unchanged recorded assets with a separate index and re-hashes the staged blob before committing;
  the director calls `assets.checkpoint` before merging.
- **Export.** [`src/substrate/game-export.ts`](../../src/substrate/game-export.ts) stages fresh public
  files and replaces only an app-managed destination; hidden files, env files, private-key names,
  dependencies and symlinks are excluded or refused; parsed imports and references prune the
  vendor folder. Static analysis cannot classify computed URLs, so browser export checks remain
  required.

## Persistence and the event log

- **EventStore** ([`src/substrate/event-store.ts`](../../src/substrate/event-store.ts)) is
  append-only, one writer, with ids minted under the lock that always sort after the thread's head,
  so a clock set back cannot reorder history. `appendEvents` refuses a batch with a non-object or
  untyped entry; reads skip malformed bodies; crash recovery keeps (with a warning) rather than moves
  files after the head. The all-threads feed (`studio:events`) is `listAllSince(after, limit)`: it
  uses a stat-keyed record cache, snapshots heads under the lock without file reads, and returns `{events, cursor}`; `renderer/event-feed.ts` gates
  refreshes until the bootstrap has set the cursor. Old logs must keep replaying: add an old-shape
  event to the test when a shape changes ([event recipe](recipes.md#event-type)).
- **Id index.** The store keeps a derived, disposable, sorted id list per conversation: loaded by
  one directory listing under the lock, extended by its own appends, listed again when it lacks the
  head (another writer appended) or after a quarantine. Cursor, tail, page and feed reads open only
  the bodies they return, in parallel batches of 32; `listAllSince(after, limit)` merges ids across
  threads before reading, so a bounded feed reads only the newest bodies.
- **Checkpointed folds.** `EventStore.foldThread` keeps a fold's state in a file beside the thread
  record and on the next call folds only the events after it; a missing, unreadable, other-version or
  ahead-of-the-log checkpoint is rebuilt from the whole log. Two folds use it
  ([`src/main/core/recovery.ts`](../../src/main/core/recovery.ts)): `repair-state.json` (the boot
  repair's open turns, runs, questions and open inbox records) and `snapshot-records.json` (the
  Studio thread's snapshot records for the snapshot index). A launch therefore reads only what came
  after the previous launch. `turn.append` indexes the events it wrote (`TurnHandle.write`).
- **Redaction on append.** The core opens the store with a `redact` hook
  (`secretRedactor(() => core.knownSecretValues())` from
  [`src/shared/redact.ts`](../../src/shared/redact.ts)); `appendEvents` applies it to every string
  of every event (`redactDeep`) before writing, returning or announcing it. Every append path goes
  through the store: `StudioCore.append`, turns, the delegation `onEvent` path and the harness
  `events.append` RPC. `knownSecretValues()` is credential-named environment variables
  (`credentialEnvValues`), `McpRegistry.secretValues()` (materialized connector values, launch
  secrets, OAuth tokens) and `PluginRegistry.heldCredentials()` (plugin account tokens unlocked
  this session, the Genex token among them); values of eight characters or more are removed first,
  then token shapes. The same set feeds the dev control's sanitizer and the public export check.
- **Chat context.** A disposable `chat-context.json` checkpoint (version 6) keeps the current run,
  session, queued input, pending questions, consent and each session role's newest context
  reading independently of history. A missing, legacy
  or pre-rewind checkpoint is rebuilt from one read of the log without its rewound ranges, then
  extended in 256-event batches. Bootstrap carries the host thread-status map separately; a
  non-ready harness clears it.
- **Run summaries.** [`src/shared/run-summary.ts`](../../src/shared/run-summary.ts) is a pure
  reporting projection, never an execution gate; main rebuilds summaries from uncapped project
  conversations ([`src/main/run-summary-reader.ts`](../../src/main/run-summary-reader.ts)) without
  creating a chat. Unknown coverage stays unknown; while a summary is pending the UI shows no totals.
  `onRunSummary` shares one feed per run (`run-summary-feed.ts`): one fetch at a time, 250 ms
  apart, asking only for the memoized (`run-summary-cache.ts`) graph events from the held last one,
  which comes again with its compaction tail.
  The reader keeps the histories of at most four recently opened projects (LRU) plus the Studio
  conversation.
- **Studio activity.** [`src/shared/studio-activity.ts`](../../src/shared/studio-activity.ts) projects
  the whole log; `StudioCore.activityEvents()` keeps per-thread cursors and only events
  `feedsActivity` says can change the projection.
- **Game library.** `GameWorkspaces` keeps a version-1 index keyed by canonical folder: title, pin,
  removed marker, canonical thread and cover; writes are serialized. `create` always reserves a fresh
  folder: in the root, or title-named in a location `gameLocation` checks first (an alias); removal
  hides the entry and leaves files and events; rename never renames a folder.
  Covers are recipes ([`src/shared/cover-recipe.ts`](../../src/shared/cover-recipe.ts)); legacy GLSL
  covers ([`cover-shader.ts`](../../src/shared/cover-shader.ts)) still render; `set_game_cover` is a
  host tool for writable builder and director sessions only. Search is a local BM25 index
  ([`src/shared/catalog-search/`](../../src/shared/catalog-search/)).
- **Games root.** It defaults to `~/AI Games`; Settings → Games picks another in main
  (`studio:games-root.choose`, fixture-blocked), restored at boot from `userData/games-root.json`
  unless its parent is missing. Every game-named folder in the root is a game, so `changeRoot`
  accepts only a folder whose such subfolders the index knows (library or removed games), turns
  old-root games into aliases and opens the new root to the sandbox.
- **Secrets.** `SecretStore` ([`src/substrate/secrets.ts`](../../src/substrate/secrets.ts)) is
  Keychain-backed through safeStorage and fails closed, raising `SecretStorageUnavailableError` with
  a `SecretStorageIssue` code. On Linux, `basic_text` (a public key) or a backend that cannot start
  reports `NoKeyring`; startup asks for the Secret Service outside KDE (`linuxSecretStorageSwitches`).
  A value the current key cannot decrypt reads as missing; a store locked right now still throws.
  Cookie encryption uses the same store, so a session whose keyring stays locked at login prompts on
  each launch. Plaintext backends are tests only. Settings, coding-CLI override and connector files
  use atomic writes ([`src/substrate/fsx.ts`](../../src/substrate/fsx.ts)).
- **Skill inventory.** `studio:skills.list` resolves the host's harness workspace, returns bounded
  active skill text, excludes symlinks and `.best.md` archives and never takes a root from the
  renderer.

## Profiles, packaging and processes

- Normal app behavior uses Electron's default data and `~/AI Games` with the singleton lock.
  Before anything reads it, the normal profile moves `<appData>/AI Game Studio` to
  `<appData>/Genex` when the new folder is missing or empty
  ([`src/main/user-data-migration.ts`](../../src/main/user-data-migration.ts); never into data,
  never for other profiles or a `--user-data-dir`; a failed rename copies through staging and keeps
  the legacy folder; logged to `studio.log`).
  Developer tooling sets userData and sessionData before ready, keeps core state and game roots
  separate, and has one writer per profile. Fixture profiles block native IPC before handlers run
  (`native-policy.ts`), park automatic improvements and architecture checks, use mock cookie
  encryption, disable SecretStore and strip inherited tokens and live opt-ins. See
  [verification](verification.md) and the [dev fixture recipe](recipes.md#dev-fixture).
- Smoke, selftest and the plain-Node rig set both Electron paths early and inject a real
  `OllamaEngine` pointed at a scripted host.
- **Log and crash dumps.** Main keeps `<userData>/logs/studio.log`
  ([`src/main/logs.ts`](../../src/main/logs.ts)): rotated at 5 files of 5 MB, mode 0600, never
  throws, and every line passes `scrubForLog` (`redactSecrets`, email addresses as `[email]`, the
  home folder as `~` only as a whole path segment). It receives harness and core stderr, main errors
  (`appendErrorDurably`, startup failures, uncaught errors), renderer console errors,
  render-process-gone decisions and quit-step problems. `crashReporter` runs local-only
  (`uploadToServer: false`) with dumps in `<userData>/Crashpad`. Persisted writes stay immediate;
  renderer harness-log messages coalesce for 50 ms (at most 65,536 characters) and flush before
  other UI events or shutdown. Diagnostics read only a bounded log suffix.
- **Lifecycle rules.** [`src/main/app-lifecycle.ts`](../../src/main/app-lifecycle.ts) holds the
  Electron-free rules: process handlers log uncaught exceptions and rejections without exiting; the
  reload policy reloads a crashed renderer at most twice in 60 s and never after a `clean-exit`;
  `pageRecovery` notes each reload in the Studio chat and past the budget asks Reload/Quit (fixture
  and smoke sessions leave the page dead). The Dock, a second launch or Keep running revive a dead
  page; pushes skip it. `runShutdown` runs quit steps in order, each bounded (`shutdownSteps`), logs
  a failed or hung step and moves on.
  `before-quit` calls `app.exit(0)` in a `finally`. `StudioCore.stop` stops the harness, then every
  agent job, and logs a plugin lease release that fails instead of skipping what follows it.
- **Diagnostics.** [`src/main/diagnostics.ts`](../../src/main/diagnostics.ts) builds the redacted
  Settings → Harness → Copy diagnostics text (versions, OS, data and log paths, provider and CLI
  status, the last 100 log lines) served on `studio:diagnostics` (fixture-safe). The renderer's
  `ErrorBoundary` ([`src/renderer/ErrorBoundary.tsx`](../../src/renderer/ErrorBoundary.tsx)) draws
  the app's error screen ([feature map](feature-map.md)).
- Forge excludes development state and agent metadata explicitly (`.gitignore` is not a packaging
  boundary) and unpacks spawned resources and native helpers from asar; the packaged smoke checks
  the archive for private roots. Bundled license notices come from
  [`scripts/third-party-notices.mjs`](../../scripts/third-party-notices.mjs), which refuses gaps;
  none selects a license for Studio itself. Forge's `afterPrune` runs
  [`scripts/package-prune.cjs`](../../scripts/package-prune.cjs): `pruneUnreachable` removes
  `node_modules` packages reachable only through excluded dependencies (`@genex-ai/cli-demo`, which
  the plugin payload vendors, and the Claude SDK and Codex native packages); `trimNodePty` keeps only
  node-pty's `lib`, `build/Release` binaries (with Windows's `conpty/`) and the target prebuild,
  without PDBs; Windows packages node-pty's N-API prebuild instead of rebuilding it; `trimSandboxVendor` keeps only
  the target's sandbox-runtime helper (Linux `seccomp/<arch>`, Windows `srt-win/<arch>`, none on
  macOS). A `prePackage` hook refuses a symlinked `node_modules`, which the packager would prune in
  place. `package-prune.test.ts`, `package-linked-modules.test.ts` and checks in
  `run-packaged-smoke` hold it.
- Release signing ([`scripts/package-signing.cjs`](../../scripts/package-signing.cjs)) is decided by
  the environment: no `MACOS_SIGN_IDENTITY` re-signs the bundle ad-hoc (`localSigningHook`); an
  identity signs with the hardened runtime and `build/entitlements.mac.plist` (`allow-jit` only, no
  library-validation exemption, so third-party native addons do not load); the `APPLE_API_*` key
  notarizes. A signed build refuses a `local.` bundle id. Windows makes a per-user Squirrel
  `Genex-Setup.exe`, unsigned until a `WINDOWS_SIGN_*` certificate, signtool parameters or hook
  turns on `@electron/windows-sign`; Squirrel's `--squirrel-*` launches only create or remove the
  shortcuts and exit ([`src/main/windows-install.ts`](../../src/main/windows-install.ts)). Fuses (`FusesPlugin`) keep run-as-node and
  file:// privileges, turn off `NODE_OPTIONS` and `--inspect`, and require the integrity-checked
  `app.asar`. [`src/main/auto-update.ts`](../../src/main/auto-update.ts) wires `update-electron-app`
  for packaged macOS/Windows (Linux: `release-check.ts`); its header covers the sidebar's Relaunch to update and the run-safe restart.
- Sandbox preparation on macOS names `/bin/bash` explicitly and retries only sandbox-runtime's
  shell-lookup error, at most three times (`sandbox-prepare.ts`); no child is replayed.
- The snapshot Git helper's bounded `spawn git EAGAIN` retry is specified in
  [verification](verification.md#full-regression-and-failure-evidence).
- A provider stream closed after cancellation keeps its stopped or deadline provenance; stopped chat
  delegations keep edits and skip recorded launches.

## Verification pointers

Scope and commands are in [verification](verification.md). Suites that hold the contracts above:

| Contract | Suite |
| --- | --- |
| Harness RPC authority and parameter checks | `tests/conformance/rpc-authority.test.ts`, `harness-api.test.ts` |
| `api()` keys and `StudioCore` surface | `core-surface.test.ts`, `rpc-surface.test.ts` |
| UI events and custom events | `ui-events.test.ts` |
| Seed copies and the provider table | `seed-contracts.test.ts`, `providers.test.ts` |
| Engine voice and crossed roles | `engine-voice.test.ts`, `director-cross-engine.test.ts` |
| One session: the lead is the chat's session | `director-one-session.test.ts`, `after-loop-run.test.ts`, `reopen-run.test.ts`, `lead-sessions-host.test.ts` |
| Renderer stores and words | `renderer-state.test.ts`, `words.test.ts` |
| Harness loop incidents | `harness-incidents.test.ts` (`npm run verify:harness`) |
| Boundaries and import cycles | `npm run verify:architecture` |

