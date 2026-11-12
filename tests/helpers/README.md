# Test helpers

What each helper in this folder stands in for, and which tests use it. Names without a folder are
files here; `conformance/…` and `fixtures/…` are under `tests/`. The list is not complete: the
folder listing wins. Rules for tests are in [tests/AGENTS.md](../AGENTS.md).

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
  model provider, no sign-in), a command that may ask to run outside the sandbox, and a one-shot
  answer (`startFakeAnswer`, an Auto check's verdict). `fake-xai-responses.ts`: the same for the real Grok Build CLI over
  xAI's (Grok's session service stood in for, signed in with a made-up token in a test's own home).
- `snapshot-fixtures.ts`: dirty, untracked and nested user repositories.
- `unreal-moment-bus.ts`: a fake of Genex's hook bus that plans each moment from a plugin manifest;
  `unreal-editor-stand-in.ts`: the editor the Unreal plugin's queue talks to;
  `unreal-fake-engine.ts`: a small fake Unreal, the release new games are made with (the Blank
  template and Epic's three plugin templates; with `older`, the oldest Unreal a game may stay on
  installed beside it) and the Unreal plugin's backend on it in an open game, launches and host calls
  recorded, a game link kept as the host keeps it (`linkProject` gives the game a project naming an
  engine), and stand-in programs for a plugin's build, tests and package; `engineByGame` is a tool's
  `engine` dep on a computer with two engines.
- `godot-fake-engine.ts`: a fake Mac with Godot apps where the test puts them, a runner that
  records each Godot job and answers with Godot's recorded words (`fixtures/godot-cli/`), and the
  Godot plugin's backend on both in an open game, its host calls recorded; and a fake Windows PC
  (`fakeWindows`, `godotWindowsFixture`) whose host plays the sandbox jobs and the pinned Godot.
- `unity-editor-stand-in.ts`: a Unity project folder, the descriptor Unity's Pipeline package
  keeps in it while an editor has it open, and a stand-in for that editor's HTTP server (scripted
  answers, every request recorded, a clock only `sleep` moves) as the Unity plugin's `PipelineDeps`;
  a Mac's folders with editors installed as Unity Hub lays them out (`macEnv`, `fakeEditor`), a
  process table whose signals a test decides (`processTable`, `editorRow`), and a call's binding as
  the host hands it to the plugin's backend (`pluginContext`). `unity-backend.ts`: the Unity
  plugin's backend on all of those in a game folder (`backendOn`: its tools by `call`, its panel's
  actions by `act`), with launches recorded and an opened editor started as a process with its
  descriptor.
- `loop-host.ts`: a fake host for the one Loop (`runDirector` on a project of any kind, a web
  game's too): a real git repository as the game folder, the moments a plugin manifest hooks on `unreal-moment-bus.ts`, and
  the lead's scripted turns, the pool's workers and the reviewer as three kinds of delegation, on
  the test's clock; `dispatch()` starts the run through the run's start instead, on the wall clock.
- `observe-windows.ts`: fake preview windows for a plugin's `observe` with a `still` or a `clip`
  (Live and the pooled windows, each logging what it was asked, over a page the test scripts), a
  real core over them (`observeHost`) and budgets on a clock the test holds (`heldClock`).
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
- `changes.ts`: how a test waits on what happened: a fake tells a `Changes` of each thing a test
  may wait for, and `until` reads the state again on each. Use it instead of a wait on a clock or
  on a count of event-loop turns, which fails at random on a busy machine (`worker-chat.ts`,
  `chat-permissions`, `project-use-cases`, `delegation-in-place-lead`, `unreal-first-use`).
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
  2.1.281 does (node-ignore, case-blind) for the shapes `src/substrate/engines/claude-permissions.ts` writes.
- `leftover-children.ts`: the runners' per-file check for child processes left running
  ([tests/AGENTS.md](../AGENTS.md#runner)).
- `pe-image.ts`: minimal Windows PE images naming the DLLs a test gives (import and delay-load
  tables, a machine type), for the package's Visual C++ runtime checks.
- `chunk-store.ts`: chunked native builds made by hand (a manifest and stored chunks cut at a fixed
  size, from a list of entries or a folder on disk) and a fetch serving their chunk folders that
  keeps what it was asked; `chunk-hostile.ts`: every way a manifest or a stored chunk can break
  the `genex-chunks` contract, each with the install failure it must end as. For the chunked
  native installer's suites.
- `mac-app.ts`: a minimal Mac app made and signed ad hoc with macOS's own tools, for the native
  installer's Mac tests.
- `failure-codes.ts`: the analytics failure-code suites' hostile inputs (words, paths, Node codes
  and ids that must never reach an event property, thrown values that must read as no code) and
  `crossed`, a failure carried across IPC as the app carries it (main's `handle`, then the preload).
- `processes.ts`: `running(pid)`, whether a process still runs. A test that proves a stop left
  nothing behind asks it, not `process.kill(pid, 0)`, which also finds a process that exited but
  is not reaped yet.
