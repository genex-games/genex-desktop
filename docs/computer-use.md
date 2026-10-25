# Computer use

How agents play and look at what they build: one tool, one referee, swappable targets.

## The layers

| Layer | What | Code |
| --- | --- | --- |
| 0 · delivery | How a provider's CLI receives the tool: Claude Code as an in-process MCP tool (deferred behind its tool search, like every live and connector tool, while the studio's `checkpoint`, `capture`, `run_command` and a chat's interview tools load with the prompt), OpenCode as a local MCP server relayed over the file bridge (`studio-mcp-shim.ts`, pictures inline), Codex through the file bridge (`studio-bridge.ts`, the fallback) or app-server dynamic tools where enabled, Bonsai and OpenRouter in `LocalSessions`, Ollama through `preview.computer` | `src/substrate/engines/*` |
| 1 · tool | One `computer` tool: Anthropic's `computer_toolset_20260801` actions, the studio verbs (`camera`, `state`, `reload`, `console`), `batch` and `observe`. Its description and action list are built from the target's capabilities, so a verb the target lacks is never offered and calling it gets a sentence, not a silent no-op | `src/substrate/computer-tool.ts`, `computer-tool-prompts.ts`, `computer-vocabulary.ts` |
| 2 · session | The referee: parse, refuse what the target cannot do, keep the action budget, pace the clock, answer, check a goal, write the trace | `src/main/core/computer-session.ts`, `src/substrate/computer-trace.ts` |
| 3 · targets | A `ComputerTarget` with graded capabilities: the browser preview, a game speaking the Genex Play Protocol, and the person's desktop or a VM (cua-driver) | `src/substrate/computer-target.ts`, `src/shared/computer-target.ts`, `src/main/core/browser-preview-target.ts` |

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
  `trace-2.jsonl`, and frames are numbered on past what the folder already holds, even after a
restart, so none overwrites another's): one row per action with
  its arguments, route, frame, cursor, simulated milliseconds, input taken of planned, and
  `refused`/`failed`/`reached` marks. The delegation's result carries the summary
  (`DelegateResult.trace`), including every input route used.
- **Studio-verified is the host's word.** A session that reaches its goal registers the trace and
  the goal (`verified-traces.ts`); when the harness records an interaction as `studio-verified`,
  `events.append` keeps that word for one record per registered trace, stamps it with the goal
  (`quest`), and records anything else as `model-said` (`harness-events.ts` `vouchedInteractions`).

## Who holds it

Builders (unless `computer: false`), the director, playtesters and scouts hold `computer` on a
pooled window of their own, never Live. A **judge** (`DelegatePlaytestGrant.role: "judge"`) holds
`computer` alone, is never offered the game's `state` or `console` and reads no state in its
answers (the builder wrote both), plays on a stepped clock, and meets the game at its first screen.
It is blind (`DelegateRequest.blind`), enforced where the engine can enforce it: Claude Code is
offered no built-in but tool search (`tools`, an allowlist, so a built-in it adds later never
arrives) and disallows every file, shell, edit and question tool; OpenCode denies every file tool; local
sessions get no file tool. Codex reads the whole disk, so a Codex judge is only told to judge by
playing (`BLIND_JUDGE_NOTE`) — the studio's goal check does not rest on that, but its other
answers do. Every engine starts in the empty `scratch/blind-judge` folder and is never told the
build's path. Its interaction evidence carries `source: hands-on-judge` and
`objective: studio-verified` only when the quest held; a model's "yes" without it is incomplete.

**A judge for the chat (`judge_play`).** The chat's own session on a game the studio plays in a
window is offered `judge_play` where the harness claims `chat-judge` (`judge-play-tool.ts`,
`#offerJudge` in delegation; the harness's own loop calls `judge.play`, which answers only for a
chat of that game). It takes one yes/no `ask`
and an optional `goal_state`, and the host dispatches `chat_judge` to the harness, which runs the
same `runHandsOnJudge` a build uses (`loop/chat-judge.ts`) on a leased hidden window, never Live or
the desktop, so it needs no consent card. The judge plays the folder as it is: a blind, read-only
judge takes its own folder lock (`judgeLockKey`), so it plays beside the session that holds the
folder, while a playtester or any other session is still refused. The harness writes no evidence;
the host keeps "verified by the studio" only when `takeVerified` vouches for the returned trace,
and records one `chat_judge_result` row (host-only), drawn as one chat line in the checks list's
words. Nothing changes unless the tool is called; an older kept seed without `SERVES_CHAT_JUDGE`
claims no capability and the tool is not offered.

`preview.computer` runs the same session on a window the harness leased, for engines whose tool loop
is the harness's own (Ollama). It refuses Live and the stand-in, and accepts only the game's folder
or a build under this game's run folder: the run id is a plain name, its folder is checked by real
path, and the host's own records must say the run is this game's. One session per leased window and
round (run, part, iteration, role, goal, entry, setup); a `describe` or `fresh` starts a new one, so
the next player on a window never inherits a spent budget; calls on one window build one session at
a time, and a replaced or released session stops what it started. A harness that ends (a crash or a
restart) never sends its `preview.release`, so the host forgets the sessions on the windows it gives
back for it (`releaseHarnessLeases`): a Play Protocol game's process stops and an editor's play is let go.

Codex's own computer use and browsers (`computer_use`, `in_app_browser`, `browser_use`,
`browser_use_external`) are disabled on every launch: they would drive the person's real screen past
the studio's consent. Only features the installed CLI lists (`codex features list`) are named, since a
CLI refuses a feature flag it does not know; a listing that fails is asked for again on the next launch.

## Game engines and other targets

A game engine joins through the Genex Play Protocol ([play-protocol.md](play-protocol.md)): a small
plugin inside the game answers about a dozen JSON commands (hello, screenshot, pointer, key, type,
look, act, pause, play, step, reset, state). A project declares it in `studio.json`
(`"runtime": "bridge"`, `"play": {"command", "args", "engine"?}`, the command resolved by real path
inside the project, the engine a runtime an enabled plugin declares and the studio starts in its
native-job sandbox with the GPU, as Godot needs to draw); the delegation then gives every role a `GameBridgeTarget`
([`src/main/core/game-bridge-target.ts`](../src/main/core/game-bridge-target.ts)) whose game runs in
the `ProcessSandbox`. Handing a session its computer starts nothing (every chat turn is handed one):
the game starts on the session's first move and stops at its release, and until it runs the tool
offers what a conforming game may do. The playtest shorthands are not offered there; its moves are drawn on the
worker's agent screen like a browser game's (`targetFramePort`). Every plugin is held to the shared
conformance suite (`tests/conformance/play-protocol.test.ts`, run against
`tests/fixtures/fake-play-game.mjs`; `PLAY_GAME_COMMAND` points it at another game).

A game played in its engine's editor is the `editor` runtime
([`editor-play-target.ts`](../src/main/core/editor-play-target.ts)): the target calls its engine
plugin's play tools ([`shared/engine-play.ts`](../src/shared/engine-play.ts): `play-open`,
`play-input`, `play-shot`, `play-state`, `play-pause`, `play-close`, harness-only, each needing the
plugin's editor lock for its call, the person first). Unreal provides them
([`plugins/unreal/computer-play.ts`](../src/plugins/unreal/computer-play.ts)): Play In Editor through
the Genex editor helper the editor queue already uses, keys held on the game's own clock (web key
codes, named as Unreal names them: `KeyW` is `W`; the mouse buttons as `MouseLeft`… are
`LeftMouseButton`…), one frame of the player's mouse for `look` and the wheel (Unreal's `Mouse2D` and
`MouseWheelAxis`, held still a frame before they are let go, since letting go of a forced analog key
injects its opposite), the player's view by `capture_play`, and `player_state` as the state goals
are checked against. A session joins a play that already runs and ends only one it started; a play
it starts warms up 2 game seconds before the first look and is marked as the agent's
(`agent-play.ts`), so the lock's person-first probe does not read it as the person playing, and a
session whose plugin restarted takes over the play that mark still claims. While the editor queue
still has a part or a play-check of the game, a session is refused (`busy`). Capabilities
(`EDITOR_CAPABILITIES`): a relative pointer (`look`, the clicks pressing where the view is aimed —
`aimedClicks` — and the wheel; no point, drag or cursor), a clock the studio can stand still but not
step (`Freeze`: the play's own pause, held between a judge's or playtester's moves, so a run never
claims to replay), game state, input route `editor`. Who holds it: any session the studio hands a
computer for a game whose enabled engine plugin provides every play tool and matches its link or facts —
the chat's own ([`editor-play-session.ts`](../src/main/core/editor-play-session.ts)), and a judge's or
playtester's through `_computerToolsFor`; `judge_play` is offered to such a chat, and the Unreal
Loop's lead has its own (`loop/unreal/lead-judge.ts`). Nothing starts until the agent first uses it,
and the session's end ends the play it started, never leaving a game paused. On a Mac, Unreal's
background throttle is lifted only for an editor without hardware ray tracing (UE 5.8 hangs the GPU
rendering a ray-traced level at full speed behind another app); see [plugins](plugins.md).

What an editor play can do is its engine's declaration (`engine.play` in the plugin's manifest, read
by `editorCapabilities`): `players` 1–8, `clock` (at most `freeze`: the play tools pause, never
step), `pointer` and `state`. Unreal declares none and keeps `EDITOR_CAPABILITIES`, as does Unity,
which declares no engine. The declaration is known before play opens, so the tool is described
from it; `play-open`'s answer (`players` joined,
`capabilities` in the declaration's shape) can only narrow it. A session opens the players its grant
asks for (`players` on a playtest or judge grant; one when absent, never more than declared). With
more than one the tool offers `player=<n>`, which addresses that player's view, keys and state from
then on (`selectPlayer`), and the target sends `player` to `play-input`, `play-shot` and
`play-state` only above 1, so a one-player engine sees the wire it always did. `play-shot` answers
base64 `data` with its `mime` (`image/jpeg` or `image/png`; anything else is read as PNG, and `png`
is still read), refused in plain words over `MAX_PLAY_SHOT_BYTES` (1 MB). An engine refuses what it
cannot do at all with `unsupported`: a pause is then asked once and the clock is known to run on;
Unreal answers it for more than one player. The toy engine fixture (`tests/fixtures/toy-engine-plugin`)
plays three players this way.

Roblox Studio declares `players` 8, `clock` `none`, `pointer` and `state`, and its play tools
([`plugins/roblox/computer-play.ts`](../src/plugins/roblox/computer-play.ts)) go through Studio's own
MCP server under the `studio` lock. One player is Play Solo (`start_stop_play`) in the game's own
Studio, which plays as the signed-in account. More players is the Genex helper's multiplayer test:
Studio opens a server and a window per client, and its MCP server lists each as a nameless Studio; a
client answers its Client data model as test player `Player<k>` (UserId `-k`), which is player k, and
the server answers only its Server data model. Starting a multiplayer test brings Studio to the
front; Play Solo does not. Keys are held in one `user_keyboard_input` call (down, wait, up, named by
[`keys.ts`](../src/plugins/roblox/keys.ts): `KeyW` is `W`, `Enter` is `Return`), the mouse buttons
(left and right only) and wheel through `user_mouse_input` at the player's aim, which `dx`/`dy` moves.
A shot is `screen_capture` on the player's Studio (a JPEG of that player's view; a test's server has
none), shrunk past 1 MB and refused when it can't be. The state is the client's and the server's
view of the players (position, velocity, health, leaderstats, attributes) with the player's last
output lines. No pause holds a client's clock, so `play-pause` answers `unsupported`. `play-open`
always asks the server once whether the live saved data can be reached (`liveData`; the link's ids
can't say, as the person's first publish in Studio doesn't update them, and a server that doesn't
answer counts as reachable) and keeps the answer for the Set up panel. A play the session starts is
marked as the agent's (`agent-marks.ts`) from just before it starts until `play-close` ends it, or
until a play tool finds it stopped (the person ended it); a test the session joins counts as the
agent's only when the mark claimed it already, and its close leaves it running. Before starting a
play, the game's script changes still on their way to Studio are sent.

Unity provides the same six play tools through its Pipeline package
([`plugins/unity/computer-play.ts`](../src/plugins/unity/computer-play.ts)). Its project stays inside
the game's folder: no engine link is needed. Without an engine binding, the host
selects a single enabled plugin whose six harness play tools each explicitly match the game's
facts (`unity-project` for Unity); missing or ambiguous matches expose no editor computer.
The chat, judges and playtesters then use the same editor target and `judge_play` path.
Unity captures the Game view, including its HUD, and waits for Play mode to finish starting before
playing. Keyboard and mouse input require the installed, active Unity Input System; legacy
`UnityEngine.Input` is unsupported, and this integration installs no packages. Fixed host-owned
Pipeline code supplies relative mouse input and reads the game clock and player state. Pausing is
idempotent, input is released after each move, and closing a session ends only agent-owned play.
A fresh judge play never restarts a game the person started. A judge's or a playtester's play is
asked for `fresh` only where the plugin's `play-open` declares that parameter (Unreal, Unity); an
engine whose `play-open` does not (Roblox) is joined as it runs.

A judge's grant may name one of the judges the engine plugin declares (`judge`;
[plugins](plugins.md#judges)): its session opens that judge's players, and `play-open`'s source runs
one step right after the play first opens (`afterOpen`), the judge's probe, through the plugin's
tool call under the play's locks. The first answer after that carries the probe's note and pictures,
and a play that reaches the live game's saved data (`liveData: true` on `play-open`) says so there;
later answers carry neither. A judge named for a game no engine plugin plays in its editor is
refused.

Roblox Studio's three judges ([plugins](plugins.md#judges)) open with these probes, each a harness
tool under the `studio` lock that reads the play the play tools hold (`plugins/roblox/probes.ts`).
`players-state` takes a picture from each player and compares what each client sees of every
player (who is there, leaderstats, attributes) with the server. `cheat-remotes` runs the package's
`cheat-remotes.luau` in the player's Client data model: it lists every RemoteEvent,
UnreliableRemoteEvent and RemoteFunction the client reaches and sends each one hostile values (no
values, wrong types, negative, huge and broken numbers, a 50 000-character string, other players'
and the world's instances, then a burst of 60), reading the server's leaderstats, player attributes
and ServerStorage's attributes before and after each; it starts no remote past `CHEAT_MAX_MS`
(2 minutes) and sends nothing when the play reaches live saved data. `phone-check` runs
`phone-check.luau` in the Client data model, which can set Studio's Device Simulator during a play
(the Edit data model can't be reached then): four sizes (`PHONE_SIZES`), a picture each, overlaps
between pressable elements or with Roblox's jump button and move stick, elements off the screen,
outside the device's safe area or under Roblox's top-bar buttons, and the place's memory (Studio's
own memory kinds left out) against `PHONE_MEMORY_BUDGET_MB` (600). The simulator keeps its device
after a play ends, so the probe always puts back the device shown before.

## The person's computer

The desktop and a VM are targets too ([`desktop-target.ts`](../src/main/core/desktop-target.ts)),
driven by [cua-driver](https://github.com/trycua/cua) (MIT). On a Mac and on Windows the driver ships
inside the app and runs **embedded** (cua's `EMBEDDING.md`;
[`cua-embedded.ts`](../src/substrate/cua-embedded.ts)): the app starts `cua-driver serve --embedded`
itself, as its direct child, and talks MCP to it through `cua-driver mcp --embedded --socket <path>`.
On a Mac the endpoint is a socket in a private folder; a child the app spawns stays in the app's
macOS responsibility chain, so Accessibility and Screen Recording are **Genex's own** grants: one
entry in System Settings, no second app, no driver prompt. The daemon runs with `DO_NOT_TRACK=1` and
`CUA_DRIVER_RS_UPDATE_CHECK=0` (no product telemetry, no update check) and starts on first use. It
stops 30 s after the last desktop session lets go (a quick next session reuses it); the stop
shortcut and quitting stop it at once. On a Mac its grants are checked without a prompt; a daemon
without them is restarted once (macOS keeps a process's old answer), and still without them Genex
asks macOS itself: the Accessibility prompt, then System Settings at Screen Recording
(`desktop-control-host.ts`).

On Windows the endpoint is a named pipe with a fresh random name, which the embedded daemon lets
only the person's own account open (so no sandboxed agent, which runs as another account, can reach
it). Windows asks no grant, so none is checked: cua's own check takes no `prompt` there. The daemon
runs in the person's session because Genex started it, with no console window, and a minimal
environment of Windows' own folders and the person's profile (`driverEnv`). On both systems its
stdin is the app's lifetime pipe (`CUA_DRIVER_PARENT_LIVENESS_STDIN`), so a crashed app takes its
daemon with it. Elevated (administrator) apps refuse the driver's input, and it says so. cua spells
forward delete `delete` there, and the client translates; it never presses the Windows key (the
shell's: Start, Run and Search start any program), nor a key name cua does not know (cua would press
its first letter).

cua's Windows window list holds windows a click passes through (windows on other virtual desktops,
transparent overlays such as a game overlay over the whole screen) and its app listing rescans every
installed app, so the studio asks Windows itself through the window probe
([`windows-window-probe.ts`](../src/substrate/windows-window-probe.ts)): Windows PowerShell running a
fixed script, handed over as `-EncodedCommand` (no file, so no execution policy), that uses only .NET's
UI Automation, Windows Forms, process reads and user32's `GetWindowLongW` declared in memory
(Reflection.Emit): nothing compiled and no cmdlet, as a first cmdlet
makes PowerShell prepare every installed module for first use (over 20 s on a fresh machine). It answers which app is in front
and whether its focused field is a password field (UI Automation's `IsPassword`, or, for a Win32
edit control, its own `ES_PASSWORD` style: .NET's UI Automation names a Windows Forms password box a
Pane with no password flag; asked again a moment later when focus is on no text field, as
Chromium's accessibility wakes on first asking), and which
app a click at a point reaches (the element there, up to its top-level window), with its window's
handle so the tree fallback skips cua's slow window list. It says its view of the primary screen
when ready, and click points are scaled to it, whatever DPI awareness PowerShell has. An app is its
executable in lower case (`windowsAppId`: `notepad.exe`), shown by its file description (Notepad); a
window no process can be read for is no app, which is refused. A probe that cannot start (PowerShell
blocked by policy) stops the session from connecting, saying the stage it reached; one that does not
answer in 5 s is ended, and the action refused.

A VM's driver is reached as
`ssh -T lume@<ip> cua-driver mcp` when `GENEX_COMPUTER_VM` names the guest, where the guest's
CuaDriver.app holds the grants; the driver's own cursor overlay is never "the app under a point"
([`cua-driver-client.ts`](../src/substrate/cua-driver-client.ts)). Every action targets the whole
display in the foreground, because background clicks into a canvas are rerouted and reported as
success (cua #4350). The driver is a host helper started with fixed arguments and a minimal
environment, outside the ProcessSandbox, which would deny it the screen.

- **Where the driver comes from.** Every macOS and Windows release build downloads the pinned cua
  release (version and SHA-256 per system in [`vendor-cua-driver.ts`](../scripts/vendor-cua-driver.ts);
  an archive with any other digest is refused), takes only the driver's executable and puts it in
  `dist/resources/cua-driver` with cua's license and notices (`build/cua-driver/`). On macOS it is
  thinned to the app's architecture and the packager signs it with the app's identity; on Windows
  `cua-driver.exe` (x64) is taken from the zip by 7-Zip and ships as cua signed it (Cua AI, Inc.),
  which the packaged smoke checks. A development build takes it with `GENEX_VENDOR_CUA_DRIVER=1`, else
  runs an installed driver (`~/.local/bin/cua-driver` and the usual paths, or cua's Windows install
  folder `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`), embedded the same way.
  Moving to a newer driver: change both pins and the notices, then verify the web and desktop
  scenarios live on both systems.
- **The setting.** Settings → Permissions → **Let agents control your computer** (`computerControl`
  in the studio's `settings.json`) is off for every install, new or existing; only an explicit on
  turns it on, and only macOS and Windows offer it (`computerControlOffered`,
  [`shared/computer-control.ts`](../src/shared/computer-control.ts)). Off, no session is handed the `desktop` tool, no consent card
  shows, the driver is never looked for or started, and `desktop.computer` answers that computer
  control is off in Settings (an answer, never an error). Turning it off stops every running driver
  (`stopAll`, as ⌃⌥⌘Esc) and a session already holding the tool reads the same answer on its next
  call; turned on, the next call or session works as below.
- **Who holds it.** With the setting on, the chat's own session on every engine is handed a `desktop`
  tool (the computer vocabulary under its own name, so it sits beside a game's `computer`), where a
  driver is found (`desktop-session.ts`). The harness's own loop (Ollama) gets the same tool through
  `desktop.computer` and the seed's `tools/desktop-tools.ts`. Unattended sessions never hold it.
- **Consent.** Nothing moves before the person answers a consent card in the chat (the studio's own,
  `studio-desktop`): once for the session, then once for each app the agent reaches. Inside a VM the
  session's yes covers every app. A yes stands while the driver fails to connect (missing grants, no
  driver): the next call retries without a new card. A stop ends it, and the next call asks again.
- **Never driven.** The studio itself (so an agent cannot answer its own card), password managers,
  System Settings, Keychain Access and the system's password prompts; on Windows the same by
  executable (`NEVER_DRIVEN_WINDOWS_APPS`), every packaged app's frame (`ApplicationFrameHost.exe`,
  which holds Settings and Windows Security among others, and from which the studio cannot tell the
  app), the shell (Explorer, which is also the desktop and the taskbar, Start and Search: each can
  start any program) and the driver's own cursor overlay. Nothing is typed into a password field (macOS's secure input on a
  Mac, UI Automation's password flag on Windows; where neither can say, a text field labelled as a
  password in the front window's tree, `AXTextField` or Windows' `Edit`). A click is checked against the app whose window is under the point, and a point no
  window covers is refused, never put down to the app in front; a drag is checked at both ends, so
  dropping onto a refused or unasked app moves nothing. A refusal ends the plan and its reason is the
  answer. `app_look`, which only looks and so needs no setting ([tool permissions](tool-permissions.md#looking-at-apps)),
  never looks at these apps or Genex's own windows either.
- **Never building or play-testing.** The apps an enabled engine plugin declares for this system
  (`engine.apps.mac` or `engine.apps.windows`, its editor) are refused in plain words ("use the engine's own tools", and a
  setup click or a publish goes through its plugin's tool) before
  the person is asked about them, unless the chat holds that plugin's setup assist; the tool's own
  description says so too. While an assist holds the chat, every app outside its grant is refused.
  The apps the studio never drives stay refused whatever a grant names (`engineAppRefusal`), and so
  do the apps an enabled engine's games are played in (`engine.playerApps`, such as Roblox's
  player): no agent plays in a live server, not even in a setup assist.
- **Do it for me** ([`desktop-assist.ts`](../src/main/core/desktop-assist.ts), the plugin service
  `game.engine.assist`). Setup clicks and publishing the person approved, only: a switch or dialog
  only the engine's window offers. The person starts one, by a plugin action they pressed or a tool
  call whose own card they approved (`confirmed` on the call, set by the host); a plugin that came
  with Genex may also start one from its own tools for the setup it knows (never from a Genex
  moment or an observer, and never while the chat's own assist is under way: `in-assist`, since
  the turn answering it does the clicking); a plugin from a folder or the marketplace shows the task on a card first, and with the setting off the studio's
  card `studio-computer-setting` offers to turn it on for every chat. It posts "<plugin> asks:
  <task>" to the game's chat and grants the turn answering that message (the turn it started, or the
  running turn it was steered into; never another turn of the chat building beside it) the
  plugin's declared apps until it ends, and never past 20 minutes; a session with no turn the host
  can follow holds it for those 20 minutes. That chat's own session then works as below, with its session and app
  cards. A computer with no driver (Linux, a development build without one) answers `unavailable`,
  and `game.engine.canAssist` tells a plugin so beforehand, so it shows its click path instead of the button. Unreal's
  install card hands the install of Unreal 5.8 in Epic's launcher this way: its `engine.apps` names
  Epic's launcher, never Unreal's editor ([plugins](plugins.md)). Roblox Studio's
  publishing is the one assist that is not a setup click ([plugins](plugins.md)): the person
  presses Publish to Roblox or Publish an update (no card: the press is the go-ahead), or approves the agent's `first-publish` card
  (the game's name, editable on it) or `publish-update` card, and the turn answering the task
  clicks File › Publish to Roblox in their Studio itself, keeping Studio's privacy and settings and stopping at any age, ID,
  two-step, terms or payment question (elsewhere the answer gives that click path). Genex then
  links the game to the published place by itself.
- **Stopping.** The chat's Stop, the session's end, the stop shortcut (⌃⌥⌘Esc on a Mac,
  Ctrl+Alt+Shift+Esc on Windows, where there is no Command key and Ctrl+Shift+Esc is Task Manager's;
  registered from the moment a driver starts until the last session lets go) and quitting all stop
  the driver (`desktop-control.ts`). A
  stop while the session's card waits or the driver starts cancels that call: a later yes connects
  nothing, a driver that arrives after it is closed unused, and nothing moves. A harness that ends
  (a crash or a restart) stops its `desktop.computer` sessions, and the next harness's first call asks
  again.
- **What it cannot do.** No clock, seed or replay; `state` is the accessibility tree of the app in
  front. A judge's "studio-verified" is never claimed on it.
- **Web pages** (`dom` capability, [`desktop-web.ts`](../src/main/core/desktop-web.ts),
  [`cua-web.ts`](../src/substrate/cua-web.ts)). `web_open`, `web_read`, `web_click` and `web_type` drive
  pages by their structure:
  - **The browser.** A separate, clean Chromium that cua-driver launches on first use
    (`browser_prepare` `isolated_new`): no cookies, no logins, none of the person's tabs. It closes with
    the driver connection.
  - **Reading.** The page reads in document order, each control (link, button, field) with its ref inline.
    The answer is that text; the tab's picture goes to the model only with `observe=screenshot` (a
    picture each move overflowed a small local model's context), while the agent's screen and the
    trace still get it.
  - **Consent.** Per app, as for any app: one card for the browser covers every site.
  - **Refused:**
    - addresses other than http and https;
    - refs the page does not list;
    - typing into a field that asks for a secret. A password input is found in the page's DOM
      (`dom_refs_v1`, read before each snapshot) and matched to its field by aria-label or
      placeholder; a password, PIN or card-number name counts too. When the page has a password
      input no name places, every field no name places is refused as well (the username on most
      login pages). The page text marks these fields.
  - **A closed browser.** When the person closes it, the next verb says so and `web_open`
    launches a fresh one.
  - **From cua-driver 0.34 on a real Mac** (unchanged on 0.35.2):
    - every connection carries its own `session` label, and each snapshot supersedes the refs of
      the one before;
    - `semantic_v2` gives a password input as a plain `textbox`, so its type comes from the DOM read;
    - a launched browser can show a transient second window that cannot be bound, so each window
      is tried;
    - links are followed through the DOM (`dom_event`), because a trusted click can land without
      following;
    - other controls are clicked in the foreground;
    - `effect: refused` and `status: refused` are errors even without `isError`; the refusal
      code travels with the error.
