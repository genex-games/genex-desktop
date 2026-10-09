# Tool permissions in game chats

A game chat's own Claude session follows Claude Code's permission modes and asks the person with
Allow / Deny cards in the chat, as Claude Code asks in a terminal; so do a build's lead and the
run's coordinator, in the chat's mode. Workers of the chat's lead follow the chat's mode too, their
questions waiting in the chat under the worker's name, and never reach a sign-in, Genex's own data
or another game in any mode ([Workers](#workers)). A chat on another engine follows the modes that
engine can honour ([Other engines](#other-engines)). Everything else the studio delegates (the
playtester, scouts, judges, candidates, a classic Autopilot's builders) stays unattended and
sandboxed. The [architecture](agent/architecture.md#processes-and-trust-boundaries)
points here; the [feature map](agent/feature-map.md) lists the selectors and the
[Models and context](product/models-context.md#permissions) page the visible behaviour.

## Who asks

[`src/shared/permissions.ts`](../src/shared/permissions.ts) is the contract: the five modes
(`auto` for a chat that never chose, `default` shown as Manual, `acceptEdits`, `plan`,
`bypassPermissions`), the modes each engine honours (`permissionModesFor`, `engineMode`), the
`tool_permission` event, the answers and the grants "always" keeps. An engine that asks about every
call, reads beyond its folders included, sets `permissionPrompts` (Claude Code).

The host alone decides, from what it recorded itself, never from anything the harness says
([`src/main/core/delegation.ts`](../src/main/core/delegation.ts) `#personSession`, then
[`src/main/core/chat-permissions.ts`](../src/main/core/chat-permissions.ts) `forSession`). A
delegation asks only when all of these hold:

- the brief has no narrower job: not read-only, no
  director, coordinator, playtest, worker `ownership`, optimization candidate, own `cwd`, run
  self-capture, own `timeoutMs` or improvement class, and it is the chat's own session
  (`isChatsOwnSession`), not a lead's turn;
- it works in its game's own folder and answers a chat turn (`chatTurn`) whose message id the
  person sent on this thread: `ConversationService` notes each composer send
  (`notePersonMessage`) before it dispatches, and the note ends when the queue records the message
  handled or removed, when a Stop ends it (`stopPersonMessages`: the message being answered and
  those its turn took in, never one still queued, which the queue answers next), or when the app
  quits (a message replayed after a restart runs unattended);
- the thread is this game's open chat: metadata `kind: game`, `project` the brief's, not archived.

While a Loop run is going, the person's messages go to the build's lead (live chat), and a read-only
coordinator answers where no lead takes the chat. Both ask from their own seat
(`DelegationService#leadSession`, then `ChatPermissionService.forLead`), handed `leadAsks`, never
`permissions`, when:

- the engine asks about every call (`permissionPrompts`), and the seat is the host's finding: this
  game's lead of a run (`#seatOf`) that
  was started in this chat (`#runOfChat`), answering the chat (`chatTurn` is its run id), or the
  coordinator of such a run answering a message (`chatTurn`, else `coordinator.messageId`);
- the thread is this game's open chat.

A lead or coordinator is the chat's main agent, so only the chat's mode and the rules the person
saved limit it, as the chat's own session: the host adds no restriction of its own. Its session
runs in its chat's Auto, Accept edits or Bypass, so Claude Code decides as for the chat's own
session, or in Manual (`default`) for Manual and Plan (`leadModeFor`; `LeadAsks.mode` when it
starts). The picker switches it while it runs, as it switches the chat's own session: `#live` holds
every running session of a chat (its own, a lead, the coordinator), and a pick switches each; so
does a mode an answer on the chat's own card sets (a plan approved, "always" with a mode), which
the asking session takes itself. A lead switches one switch after another (`#switchLead`), each to
`leadModeFor` the chat's mode when it runs, so a later pick wins; a pick made while a lead starts is
applied once its control arrives. Each question is routed by the host (`#leadAsk`) for the chat's
mode at that moment, whether or not the person is talking to it: Bypass allows one running in
another mode, or one its screen asked first (by `toolUseId`), Plan denies (a build is approved work), Auto, Manual and Accept edits
card, withdrawn when nobody answers within `LEAD_ASK_TIMEOUT_MS` (five minutes); an archived
chat's is denied at once. Every call but a read (Read, Glob, Grep, LS, NotebookRead), the
session's own bookkeeping (ToolSearch, TodoWrite) and the studio's `mcp__studio__*` tools passes
the host's screen first (`#screenLeadCall`, a PreToolUse hook, which Claude Code runs before its
deny, ask and allow rules and in every mode): while the session runs in Auto, Accept edits or
Bypass and the chat is in another mode (a switch that failed, or one still on its way; Accept
edits in an Auto chat excepted), it asks first ("The chat switched from Auto to …"), so the chat's
mode answers, not the session's, a saved allow rule or the game's own `.claude/settings.json`. A
lead's failed switch is never the picker's error; Auto refused records its model as without Auto,
and tells the picker. A message
handed to a lead never makes the chat's own session ask. A worker the host found (its `worker`
grant) runs in the chat's mode ([Workers](#workers)); builders a classic Autopilot starts, the
playtester, scouts, judges and a director with its own hands (in its worktree) stay unattended. A plan
approved in the studio's plan review is dispatched without a composer id, so its build runs
unattended. A harness that shapes a brief or writes queue records can make the chat's own session
or the coordinator ask only about a message the person sent that is still unanswered, and a lead
ask only for a run started in this chat; it never chooses the session's mode or answers a card.
The coordinator's seat is such a message (`awaitsAnswer`), and a lead or coordinator reads only
the folders the host derived and those the chat recorded (`chatReads`), never a folder the brief
names: one it reads is one Accept edits writes without asking.

## The harness cannot forge it

- `thread.create` takes a title and nothing else: no id, kind, game or mode.
- `events.append` and `turn.append` refuse `tool_permission` and `plugin_consent` rows
  (`refuseHostQuestions`); the host appends both.
- A session a person answers reads beyond its game only the folders the thread records
  (`metadata.extraReads`, set from the person's own messages) and the host's frame folders. A
  rewind may narrow those folders, never widen them (`readsAfterRewind`).
- The mode, the answers and the saved rules are reached only over `studio:permissions.*`, which
  is main-frame guarded like `studio:plugins.*`; the RPC table has none of it. A harness
  `ui.notify` named `tool.permission` or `permissions.changed` only makes the renderer read again.

## The session

With permissions, [`src/substrate/engines/claude-permissions.ts`](../src/substrate/engines/claude-permissions.ts)
launches Claude Code in the chat's mode with `allowDangerouslySkipPermissions` (the picker can
reach Bypass mid-turn) and `canUseTool`, no `sandbox` key, no blanket `Bash`, `AskUserQuestion`
and `EnterPlanMode` disallowed (ExitPlanMode brings a plan back for approval), no sibling-folder
deny list, and the saved allow rules plus the folders granted in the chat. A read-only brief stays
read-only. `askPerson` translates Claude Code's suggestions (`permissionGrants`: allow rules scoped
chat or game by destination, a mode, a folder; never a whole `Bash`, `Edit`, `Write` or `Read`)
and points the kept updates at `session`, so the CLI never writes `.claude/settings.local.json`
into the game. A plan approved into Auto leaves Plan for Manual and then asks for Auto through
the CLI's own gate. The mode the session reports (init and status messages) says whether Auto is
available for its model; `liveControl` hands the picker `setPermissionMode` until the session's
input closes (a pick made while the session starts is applied once that control arrives:
`ChatPermissionService#onControl`), and a refusal comes back as `ModeSwitchFailure.AutoUnavailable`, the only case the
host shows beside the picker.

No session gets Claude Code's own sub-agents (`Agent`, `Task`), in any mode or seat: Genex runs the
workers, under the person's ceiling and the chat's mode (`disallowedToolsFor`).

A session's own background shells end a minute after its turn goes idle
(`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`); something that must keep running (a long build, a server,
a headless run) is a job (see Jobs below).

A lead or coordinator with `leadAsks` (`leadAskingOptions`) starts in its chat's Auto, Accept edits
or Bypass (what Claude Code asks in any mode, such as a dangerous `rm`, is carded as for the chat's
own session), or in Manual (`default`), where every edit and command reaches `canUseTool` and the
host. It is launched with `allowDangerouslySkipPermissions`, as the chat's own session, so the
picker can switch it to Bypass mid-turn; `liveControl` hands the host its `setPermissionMode` as
for the chat's own session, and nothing else moves its mode. No `sandbox` key, no blanket `Bash`,
and its read-only brief keeps what the chat's own session keeps: edit, shell and web (still no
messaging, Claude Code's own sub-agents, `AskUserQuestion` or `EnterPlanMode`). Its one PreToolUse hook, with no
matcher, carries every call but the unscreened ones to `LeadAsks.screen` (`leadScreenHook`); a
screen that fails refuses. `askLead` refuses AskUserQuestion, EnterPlanMode and ExitPlanMode
without asking the host and drops mode grants. Its settings carry the saved allow rules, the chat's
granted folders and the person's fence (`protectWrites` included), with no sibling-folder deny
list, as the chat's own session. The lead's prompt still leaves the game's changes to its builders
while the build runs.

Every session the person answers on an engine that asks about every call (the chat's own, a lead,
the coordinator: `SessionReach.reachesMac`) reads, right after its brief, the host's
`mainAgentReachNote` ([`delegation-prompts.ts`](../src/main/core/delegation-prompts.ts)): it is the
chat's main agent on the person's Mac, looks and works anywhere on it when asked (their Downloads,
other folders, what fills the disk), and only the chat's mode decides each call. The brief
(`loop/chat-session.ts`) says where the game's work goes, never that the session may not read
other folders. The note is the host's, so neither an agent-edited seed kept on upgrade nor a resumed
transcript that holds an older brief narrows it. An unattended session reads none of it.

A run's sub-agent (a worktree session the Unreal lead starts for one small job) is narrowed by its
delegation's `toolAllow`: it is offered only the plugin tools and connectors whose names start
with one of the entries, and the guidance, skills and skill reader of only the plugins those
belong to (`substrate/plugins/tool-allow.ts`, `PluginRegistry.snapshot`). A call to any other host
tool is refused as unknown before any consent, record or backend; an allowlist that is not a list
of names offers nothing, and an empty entry allows nothing. Its `attribution` (`runId`,
`agentId`) makes it a builder of its own part: its plugin calls, deliveries and activity are
recorded under the run with the agent id as `facetId`, so its asset cards land on its node and
its words never stream as the chat's reply.

A lead also has the chat's own session's plugins, connectors and cover, whether or not it asks
(`hostToolsEligible`): its brief's `readOnly` marks its seat in the game folder (`#leadRoot`), and
the host's own finding of that seat (`seat.leads`) decides, never the brief; a read-only session
that leads nothing, the playtester and the coordinator get none. Its plugin calls act on the
worktree it leads (`DelegationSession.leads` as the binding's directory), as a director's in its
worktree, so a delivery is recorded as the build's and reaches the game when the run lands, and
its brief says so without naming the build's path (`leadToolsNote`); a connector that shares the project root works on
the game folder, as for every session (`resolveProject`). They are auto-allowed studio tools, as for
the chat's own session: a plugin tool that declares `confirmation` waits on its consent card
(`plugin_consent`, nine minutes; one nobody answers settles as "Nobody answered", and the agent
reads that the person may be away, that it is not a no, and to carry on and ask again later; for
any session's later ask it never counts as a decline), asked
each time rather than declined by an earlier answer in its run (`priorConsentDecline`), and a connector waits on its card unless its exact tool is saved as
always allowed or the chat is in Bypass (`ChatPermissionService.bypassing`), which asks nothing
first. A connector's card ("Let the agent use <name>?") offers Allow once, Always allow and Don't
allow; Always allow saves that exact tool (`McpRegistry.alwaysAllow`): the person's own connector
in connectors.json, where its card's checkbox shows it, and a plugin's in `always-allowed.json`
beside it, listed on the plugin's page under Connections with **Ask every time** to take it back.
A plugin tool's own card never offers it. While the chat is in Plan, no plugin or connector action runs for anyone in it (the
chat's session, its lead, a run's workers; a run's plugin call answers to the chat the run was
started in), saved grants included; reading a plugin's skill still does, and so do the harness's own reads (the
editor's state, log and results, its polls and waits). Its writing steps wait: a chat checkpoint's save, and the Unreal
Loop runner's saves, shots, play checks, editor end and reopen, module and helper steps (`checkpoint: true`;
`PluginToolService`, `ChatPermissionService.planning`), so the runner's save points and autosaves
save nothing and take no snapshot while the chat plans. The lead is not the chat's turn: another
turn ending leaves its consent cards and connector calls going (`outlivesTurn` in `PluginConsent`
and `activeConnectorCalls`), and its own session's end, a Stop, the answer or the timeout end them. A director's turn writes no Connecting activity, so the build card reads as
planning between parts.

## Workers

A lead runs its workers with a `worker` grant on `engine.delegate` (`HarnessDelegateParams.worker`:
`id`, `title`, the `runId` or chat `turn` it belongs to, and `research`). The host honours it only on
its own finding ([`delegation.ts`](../src/main/core/delegation.ts) `#workerSeat`), on a delegated
engine, never for a coordinator or a candidate:

- a run worker: its run is running by the host's records (`activityItems`) and was started in
  exactly one chat, this game's open chat, naming no other game (`#runChat`); the delegation names
  that chat or a thread that is no game chat (the run's own); and it works in the game folder or a
  copy of this game's repository inside that run's own folder under scratch;
- a turn worker: the delegation's thread is this game's open chat, whose own session is in flight
  answering exactly that `turn`; it works in the game folder or a copy of the game under scratch.

The chat's own session starts turn workers through the worker tools, which the host hands it only
while it answers a turn on a harness that serves them (`HarnessDelegateParams.workers`,
[`worker-tools.ts`](../src/main/core/worker-tools.ts)). In Plan the host answers a writer's start
(`copy`, `lock`, or no isolation said) itself and forwards nothing: no snapshot, copy or delegation
is made until the plan is approved, while a reader starts and reads in Plan.

A run's lead starts run workers: the director's builders (its conflict worker included) and
readers, and the Unreal lead's typed and generic workers, each delegated with
`worker {id, title, runId}` (`loop/director/workers.ts`, `loop/facet/phases/build.ts`,
`loop/unreal/agents.ts`, `loop/workers/run-pool.ts`), so they follow the mode of the chat the run
was started in. A classic Autopilot's builders carry none.

A grant the host cannot confirm runs unattended exactly as before, so forging its absence only
boxes a session. An honoured worker is depth one (`workerBrief`): its `director`, `runControls`,
`interviewTools`, `coordinator`, `chatTurn` and `workers` are dropped, it is never the chat's own session (no
bookmark, no person's card, no checkpoint), and Claude Code's own sub-agents are off. A chat runs at
most the Settings ceiling (`buildersMax`) of workers at once, readers and writers alike: past it the delegation is refused with
`too_many_workers` (`DelegationRefusal.TooManyWorkers`, the seed's `WorkerRefusal`) before any lock
is taken. A worker in the game folder runs under its own lock (`workerLockKey`, `<cwd>#worker:<id>`),
beside the chat's own session; `engine.abort` and `engine.interrupt` with `{ cwd, worker }` reach
that worker alone (`delegationAt`), and a worker in its own copy, or one the host did not seat, by
its folder and the id its grant named (`askedWorker`). Making a build live waits while anyone,
an in-place worker included, works in the game folder (`delegationsIn`). A worker, seated or not,
is never handed a connector its game's kind brings (an engine's live editor, `kindServers: false`):
the lead drives that editor alone.

Its seat (`WorkerSeat`, `#workerReach`) carries:

- the chat's mode, as its engine honours it (`engineMode`), and Plan whenever the chat plans, fixed
  for the session: no picker reaches it, and while the chat is in a stricter mode than the one it
  runs in, its screen asks first (`#screenLeadCall`), as a lead's;
- its write roots: its working folder, the folders the person granted the chat
  (`ChatPermissionService.chatDirs`) and the enabled plugins' `folders`
  (`PluginRegistry.workerFolders`), by their real paths; a folder that does not exist yet is left
  out, and so is one that is, holds or sits in a never-touch root (`writableRoots`);
- the never-touch list ([`never-touch-list.ts`](../src/main/core/never-touch-list.ts)): the sign-ins
  (each coding CLI's whole home, the stores every agent's box denies (`baseDenyRead`: `~/.ssh`,
  `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/Library/Keychains`), `~/.genex`, Genex's secrets and
  engine homes), Genex's own data (this profile's data folder and the other profiles the app names
  at start, `StudioCoreOptions.neverTouch`: the normal profile's and a developer build's
  `.studio-dev/profiles`), and every other game's folder (the normal profile's `~/AI Games` too when
  this launch keeps its games elsewhere, `neverTouchGames`); its own folder, its run's capture folders,
  its game's folder and the folders of its own run its harness hands it to read (spike and base
  worktrees) stay open inside those, and a Claude Code worker also keeps what its own Claude home
  hands its session (`sessionHomeOpen`: its working folder's projects, and for reading only the
  plans, shell snapshots, environment and todos every session of that home sources);
- what it reads beyond its folder: the host's own folders, its run's own folders and those the chat
  recorded, with no sibling-folder deny list (the never-touch list replaces it);
- `research`: it may use the web as a reader (on Codex, its `web_search` is live for a research
  worker or a writer and off otherwise).

| Chat mode | A Claude Code worker |
| --- | --- |
| Bypass | `bypassPermissions`, in a box that writes the home folder and its roots, every command in it unasked, none leaving it |
| Auto | `auto`, in a box that writes only its roots and runs its sandboxed commands unasked |
| Accept edits | `acceptEdits`, in that box, asking about each command |
| Manual | `default`, in that box, asking about each edit and command |
| Plan | read-only: no edits, no shell, the web only when it researches |

In every mode, Bypass included, a PreToolUse hook screens each call first, reads included
(`neverTouchHook`): a file tool by its paths (a search also by the folder it walks; Grep's regex is
no path), a command by the paths its words name (`~`, `~user`, `$HOME`, `$PWD` and `$USER` expanded,
`$'…'` and `$"…"` read as the shell quotes them, a glob or another variable by its fixed folder, a
relative path against the folder a `cd` moved to and, once one moved (a bare `cd` or `cd --` goes
home), every argument as a path from there, `sh -c`, `eval`, `$(…)` and backticks followed;
on Windows drive, share and Git Bash paths; a lone `/` given to `tr` or as a search's pattern is
text) and any `security` call, each path also as its links lead. A word reaches what it names and
all below it, so `rm -rf ~/.codex`, `cd ..` from a game and `ls ~` are refused alike; a call it
cannot read (`${HOME:-…}`, `$OLDPWD`) is refused, and a call that writes is refused in a folder open
only for reading. In every mode, Bypass included, the box denies the same roots at the OS boundary,
and Claude Code's own folder (`.claude`) in its folder and each write root, for every command that
stays in it; the text screen is the second net, for what a program builds
as it runs. The sandbox takes no network wildcard, so a Bypass worker's command that reaches the
network is allowed by its mode. A Codex worker cannot ask, so it is always boxed: its writable
roots are its write roots, and the network is on only in a Bypass chat. Only a delegated engine
(Claude Code, Codex) carries a seat: a local model's work stays unattended, and its chat session is
offered no worker tools.

Plan holds writers on the host (`heldInPlan`): a copy or in-place writer's start and
`worker_mark used` wait for the plan's approval, from the chat's own session and from a run's lead,
and so do a director's `integrate` and a `finish` that lands the build (`finish land=no` goes on),
so no snapshot, copy or merge is made; a reader starts. A start that names a worker type stands as
that type declares, whatever isolation it asks for (a type the host does not know writes). A run's lead is judged by the chats the
host's own records say the run was started in, and the grant's chat if it names one of this game's:
any of them planning holds it, and a run whose chat the host cannot find holds it with that reason.
A typed worker started before the chat switched to Plan may still land its delivery.
A run's own workers (the director's builders, the Unreal lead's typed workers) that wait on the
person are read from the chat's log too (`loop/workers/questions.ts`): their lead's status says so
and its `worker_wait` wakes. A run's builder, the director's single worker and the Unreal lead's
typed worker refused for room under the Settings ceiling wait for room until their deadline
(`withWorkerRoom`); a pool's worker so refused ends with the host's words, and its lead may wait
(`worker_wait`) and start it again.

Its questions go to the chat ([`chat-permissions.ts`](../src/main/core/chat-permissions.ts)
`forWorker`, `#workerAsk`): a chat closed since denies at once, Bypass allows one running in another
mode, Plan denies, and anything else is a `tool_permission` card naming the worker
(`ToolPermissionEvent.worker`; the card reads "Scene builder wants to …") with no timeout. Only the
person's answer, a Stop, the worker's end or, for a turn worker, its turn's end settles it; a run
worker's card outlives the chat's turns. "Always" keeps grants as for the chat's own session (never a
mode), so the next worker and the chat's own session stand on them. No agent's message answers a
card: the harness cannot write `tool_permission` rows (`refuseHostRecords`), and a steered message
saying "approved" is a message, not an answer.

**Don't wait for me.** By default a worker's question waits. The person, and only the person, can
switch "Don't wait for me" on: from the Loop menu's switch while the Loop is on (during a run the
menu opens read-only to reach it, on and off, `modeMenuReach`), or with the button
on a card an agent showed (`offer_dont_wait`, a project tool of the chat's own session and of a
run's lead, whose card shows in the chat its run was started in; it only appends `dont_wait_offer`). Both reach the host over `studio:loop.dontWait`, main-frame guarded like
`studio:permissions.*` and named by no RPC; the harness can write neither `dont_wait_offer` nor
`dont_wait_set` (`refuseHostRecords`). A switch reaches the run started in the chat that is going now
(`DelegationService.runOfChatNow`), else the chat's next run, and is recorded in the chat as
`dont_wait_set` ("You turned on Don't wait for me for this run"). The setting is kept on the run in
[`src/main/run-settings.ts`](../src/main/run-settings.ts) (`engine-homes/run-settings.json`, atomic
and serialized; a store that could not be read fails the call and is never written over, and the
question then waits): a next-run setting made before a run started is taken by that run and cleared.
With it on, a run worker's question is refused at once (`#workerAsk`): the chat gets its pending and
settled rows together (`by: not_waited`, naming the worker; "Not asked: you said not to wait"), and
the worker reads a deny telling it to carry on. Bypass, Plan and a closed chat answer first, as
above; a worker the chat's own turn started always waits.

A run worker's plugin calls are recorded under its run with its id as the part (`workerAttribution`),
and its plugin and connector calls answer to the Plan mode and Bypass of the chat the run was
started in (`ConnectorCallOptions.runId`), not to the thread it reports on.

## Jobs

A job is a long command the app runs in the background for an agent and owns
([`src/main/core/job-tools.ts`](../src/main/core/job-tools.ts), the registry in
[`src/substrate/jobs.ts`](../src/substrate/jobs.ts)): `job_start {title, command, cwd?, hours?}`,
`job_status {id?}`, `job_tail {id, lines?, contains?}`, `job_stop {id}`. The chat's own session, a
run's lead and a worker the host seated that writes get them, on an engine that carries a seat
(`jobToolsFor`); a reader worker, a playtester, the coordinator, a builder no host seated, a judge
and a local model's session get none. A plugin tool of the same name is refused.

A start reads the chat's mode at the moment of the call (`ChatPermissionService.modeOf`, `jobGate`),
never the mode the session began in:

| Chat's mode | A job's start |
| --- | --- |
| Plan | Not started: the answer says jobs wait until the plan is approved, before anything is checked or asked |
| Accept edits, Manual | A card in the chat, then the box of its write roots; a declined card starts nothing |
| Auto | Started unasked in the box of its write roots: the box is the check |
| Bypass | Started unasked in the Bypass worker's box: the home folder and its write roots writable |

Before that, its `cwd` must be a folder inside the session's own (relative, no `..` out, no link out,
existing), and its command passes the never-touch screen the worker hook runs (`neverTouchScreen`):
a hit, or a command the screen cannot read, is refused with nothing started, in every mode, Bypass
included, whoever starts it. The keychain tool is stopped here, since a file deny cannot reach it.

The box (`jobPolicy`, through `ProcessSandbox.spawnLongLived`) writes its starter's write roots:
a worker's seat's, or for the chat's own session and a lead the folder its jobs run in, the chat's
granted folders and the plugins' folders, filtered by the never-touch list (`writableRoots`). It
denies the never-touch list (reads fenced around the open folders, writes around the open ones),
Claude Code's own folder in each write root, and, outside Bypass, the game's folder when no write
root holds it (a copy's job never writes the game). The base sandbox's protected paths stay denied.
No job reaches the outbound network (`allowedDomains: []`; the sandbox's domain list is shared by
every sandboxed process); it may serve on localhost.

A worker's job runs in its own folder; a lead's where its plugin calls act (`session.leads ??
workCwd`: a web lead's in the build it leads, never the game folder it sits in; the Unreal lead's
in the game folder); the chat's own session's in the game folder. A session sees and stops only its
chat's jobs; a worker only its own of its run or turn.

The card (`askForJob`, `tool: "Job"`) follows the asker's terms: the chat's own session's ends with
its turn, a lead's waits `LEAD_ASK_TIMEOUT_MS` and outlives the turn, a worker's names the worker,
waits with no timeout and is refused at once in a run whose person said "Don't wait for me". Its
question is plain words ("Scene builder wants to run Unreal build in the background"); the command
sits only in the row's `input` (`{title, command, folder}`), folded under Details. No "always".

A job ends by itself, by `job_stop`, at its time limit (`hours`, 2 by default, at most 24), when
its run settles (the harness's own `run.settled`: its lead's and its workers' jobs), when the chat
turn that started its worker returns, and when Genex quits. A harness crash or restart ends none.
The chat's own session's jobs outlive its turns, and its next turn is told which ended
(`jobNotice`); a run's lead hears its run's ends through `jobs.list`, the harness's one read of the
registry ([harness runtime](harness-runtime.md)). Each start and end is a host record in its chat
(`job_started`, `job_ended`, which the harness cannot write), and the harness can neither start nor
stop a job.

The chat shows each job as one line ("In the background: Unreal build · 4 min") whose **Stop** is the
person's (`studio:jobs.stop`, fixture-safe, Studio's main frame only; `stoppedBy: person`):
`jobNotice`, `job_status` and the lead's line say the person stopped it, and the notice and the
lead's line add not to start it again unless asked. A running job's start is a current-state fact of its chat, so the line and Stop stay whatever page
is loaded; what a rewind keeps of them is in [the coordinator](conversation-coordinator.md).

## Looking at apps

`app_look {app?, window?}` ([`src/main/core/app-look-tool.ts`](../src/main/core/app-look-tool.ts),
the port in [`src/substrate/app-look.ts`](../src/substrate/app-look.ts)) lets an agent see an app
window: without arguments it lists the windows on screen (app, title, id); with an app name or
bundle id, or a window id or words of its title, it answers that window's screenshot (JPEG, longest
edge 1568 px) and its accessibility tree (roles, titles, values; at most 300 elements, 10 levels and
12,000 characters). It only looks: it sends no input, so it runs in every mode, Plan included, with
no card. The chat's own session, a lead and every worker the host seated get it, a reader too (its
one host tool); a playtester, the coordinator, a builder no host seated and a local model's session
do not. A plugin tool of the same name is refused.

The app runs it host-side, never inside an agent's box: Core Graphics' window list and the tree
(through System Events) by `osascript` JavaScript for Automation scripts that are constants, the
window's pid, title and place passed only as arguments; the picture by `screencapture -l`, shrunk by
`sips` in a fresh folder of Genex's scratch, read and removed. It never looks at a password
manager's window (Keychain Access, Passwords, 1Password, Bitwarden, LastPass, Dashlane), and leaves
them out of the list.

macOS asks the person for Screen Recording and Accessibility. Genex asks once, at the first look that
finds either missing (`<engine homes>/app-look-access.json` remembers it asked); the first tree read
also brings macOS's own Automation prompt for System Events. While access is missing the agent is
told what the person must turn on and not to retry, and the chat gets one `app_look_access` line per
app session (a host record the harness cannot write), with **Open Privacy settings**
(`studio:app-look.open-settings`, native), which opens only that System Settings pane. Fixture
profiles look at a stub window; other systems answer that it works on macOS only for now.

## Other engines

Every engine's chat has the pill. `permissionModesFor` lists what each one's chat session honours;
the composer greys the rest with the reason (`unavailableModeReason`), and the session runs in
`engineMode`: the chat's own mode where its engine honours it, else Auto, its own contract. The
thread keeps the mode the person picked, so a chat moved back to Claude Code finds it again.

| Engine | Modes | How |
| --- | --- | --- |
| Claude Code | all five | asks mid-turn ([The session](#the-session)) |
| Bonsai | Auto, Manual, Accept edits, Plan | the studio runs its tools and asks before each change |
| Codex | Auto, Plan, Bypass | `codex exec` cannot ask mid-turn; the mode picks its sandbox |
| Ollama, a new engine | Auto | its harness tool loop keeps its sandbox |

The chat's own session on any engine is handed `permissions` (`#personSession`, no
`permissionPrompts` needed); only an engine with `permissionPrompts` gets the person's reach
(`reachesMac`: no sibling-folder deny list, `mainAgentReachNote`) and a lead's or coordinator's
`leadAsks`. Another engine's chat session keeps the unattended fence and the same denied paths.

Bonsai ([`local-session-permissions.ts`](../src/substrate/engines/local-session-permissions.ts)
`permitCall`) asks before `edit_file` and `write_file` in Manual and before `run_command` in Manual
and Accept edits, as Claude's `Edit`, `Write` and `Bash` cards; a deny never runs the call and the
model reads why. Plan offers only `read_file`, `list_files` and the studio's own tools and refuses
any change unasked; a local model's `start_web_game` sends its chat with `game.start`, which writes
nothing while that chat is in Plan (a harness that names no chat is not checked, as with a kept older
`tools/game-tools.ts`). Its commands always run in the studio's sandbox, so it has no Bypass. The picker
switches a running session (`onControl`): the next call is decided in the new mode, and the model
reads of it at its next round.

Codex runs Auto as before (`workspace-write` in the game folder, no network, never asks), Bypass
with `--dangerously-bypass-approvals-and-sandbox`, and Plan from a folder of its own (`startsElsewhere`,
as a read-only session) where only the studio's bridge is writable, told it plans
(`planModeNote`). A pick applies to its next turn. Every `codex exec` runs with Codex's own
sub-agents (`multi_agent`, `multi_agent_v2`) and its screen and browser hands (`computer_use`,
`in_app_browser`, `browser_use`, `browser_use_external`) disabled, all of which Codex turns on by
default (`CODEX_SUBAGENT_FEATURES`, `CODEX_SCREEN_FEATURES`).

A plan on an engine that ends its turn with it (`plansByTurn`: Bonsai, Codex) is approved by the
host ([`plan-approval.ts`](../src/main/core/plan-approval.ts) `withPlanApproval`): a Plan reply
with words, a session id and no studio tool call becomes the `ExitPlanMode` card. Approved, the same
session resumes in the chosen mode (`planApprovedNote`), which the permission service keeps on the
chat; sent back with words, it plans again (`planRevisionNote`); a bare deny, a withdrawn card or a
Stop ends the turn with the plan. The card offers only modes the engine honours
(`planContinuations`).

On every engine that honours Plan, Claude Code included, a build the chat's own session recorded to
start (`BuildLaunch`: a Loop launch, `reopen_run`, `resume_run`) while the chat is still in Plan at
the turn's end (`ChatPermissionService.planning`, so a plan approved mid-turn lets it go) waits
behind the same card, which shows the reply and what the build would build. Approved, it starts as
recorded; sent back with words, it is dropped and the session plans again; any other ending, a
question beside it or a failed turn drops it. The harness starts a recorded build once the reply
ends, so the host is what holds it. While the chat is in Plan the coordinator's `continue_build`,
`resume_run` and `land_build` (and the chat's own `land_build` run control) answer that they did
not run (`conversation.ts` `BUILD_CHANGES`).

## Auto's classifier

Every session that asks (the chat's own, a lead, the coordinator), in any mode since the picker can
move it to Auto mid-turn, carries the studio's `autoMode` settings
([`src/substrate/engines/claude-auto-mode.ts`](../src/substrate/engines/claude-auto-mode.ts)
`autoModeRules`), which Auto's classifier (and Plan, run with Auto's semantics) reads on top of
Claude Code's own: `environment` and `allow` start with `"$defaults"`, and `soft_deny` and
`hard_deny` are not set, so the CLI's blocks, and a CLI update's new ones, stand unchanged. The CLI
reads `autoMode` only from user, flag and managed settings (never a game's `.claude` files) and
sends it to the server-side classifier too. The environment says the session runs on the person's
own Mac with the person in the chat; for the chat's own session, that the game folder's files git
does not ignore are checkpointed before each message (`main/chat-checkpoints.ts`: not `.env*`,
nested repos or files over 50 MB) and Rewind restores them while HEAD stays put; for a lead or the
coordinator, that the build's workers change the game in worktrees of their own and its own edits
there are not checkpointed. Public registries and asset
sites are download sources, not trusted destinations. The carve-outs narrow the built-in blocks
that ordinary game work trips, each naming what stays blocked: changes and deletions of
checkpointed files, build output and caches in the game folder (chat's own session only; not other
ignored files, `.git`, nested repos or large files), well-known packages, scaffolders and headless
browsers, dev servers and directory servers on 127.0.0.1 (LAN only when the person asks) and
stopping the agent's own or its dev port's listener, looking for an asset the person described in
their folders (no sweeps of whole home folders), the game's own agent notes, and local production
builds. The rules stay under `AUTO_MODE_BUDGET` (3,000 characters): they travel in the same
command-line argument as every other setting. When the classifier cannot answer (an API
overload), Claude Code denies the call ("Classifier unavailable") and the model may retry.

## Rules at their real paths

Claude Code reads a rule's `/path` relative to the settings that carry it; only `//path` is the
filesystem root. `absoluteRule` writes every rule that way, in every session, as the CLI converts
a path itself: forward slashes, and on Windows the drive as the first folder (`C:\Users\me` is
`//c/Users/me`, a share `\\server\share` is `///server/share`, which the CLI's parser reads from
`/`); glob and rule characters stay literal, except in a name the matcher cannot spell (a `?`, a
trailing `*` or whitespace), which is left out of the fence and named in the session's log. `protectedTargets` fences the protected folders whole,
except the session's own Claude home, whatever the login (the studio's `CLAUDE_CONFIG_DIR`, the
one the environment names, or the person's `~/.claude`): siblings on the way are fenced whole,
`.credentials.json` is unreadable and the settings files (`settings.json`, `settings.local.json`,
`.claude.json`) are never edited. That is all a person's session fences there: other projects'
transcripts and `history.jsonl` are reached as Claude Code reaches them in a terminal (a read
outside the working folders asks in Manual and Accept edits, Auto's classifier decides, Bypass
allows), which is parity, not a gap.

An unattended session, which nobody answers, reaches in that home only what the CLI hands it
(`homeFence`): `plans/`, `shell-snapshots/`, `session-env/`, `todos/` and, in `projects/`, this
working folder's own project (named as the CLI names it: `claudeProjectDirName`, both spellings,
a cut name with any hash; one not made yet stays reachable). Every other top-level entry has a
rule. Other projects share a few globs instead of a rule each: the SDK passes all settings as one
command-line argument, and one rule per folder once came to 13,692 characters (Windows allows 8,191
through a `.cmd` shim). The CLI (2.1.281) matches with node-ignore, case-blind, where `[!x]` means
`!` or `x`, so the globs branch off the own name `O`: for each place `i` where an existing folder
first leaves it, `projects/<O's first i characters>[<name characters but O[i]>]*`; past it,
`projects/O?*`; and a folder that stops short of it, by name. The rules never pass
`HOME_FENCE_BUDGET` (4,000 characters, broadest first); the session's log names what stayed
readable.

Unattended sessions get `Read()` rules for that fence and for the workspace deny list, which now
leaves the delegation's own game readable (a worktree's `node_modules` link and git point there)
and scans a folder's neighbours only under the games root or scratch. A person's session also gets
`Edit()` rules for every studio file in userData (`#hostFiles` walks it; the games, the chat's
folder, secrets and engine homes excepted) and the permission store. A build's lead is also spared
the integration worktree it leads (its seat's checked real path, `LeadSessionAsk.leads`), where it
builds with its own hands; its run's other worktrees, other runs and `runs/` stay fenced.

## Questions and answers

`#ask` appends a pending `tool_permission` row (input digest bounded, plan ≤32k characters),
emits `tool.permission` and waits on `ToolPermissions`
([`src/main/tool-permissions.ts`](../src/main/tool-permissions.ts)): the plugin consent ledger
without a timeout (a worker's card included), except a lead's or coordinator's card, withdrawn after `LEAD_ASK_TIMEOUT_MS`
(5 minutes, `by: timeout`, "Withdrawn: nobody answered"; Claude reads "Nobody answered within 5
minutes…"). The person's answer, Stop (`stopThread`, `engine.abort`, harness death, app
stop), the session's abort or the end of the turn settles it; a lead's or coordinator's card is not
the chat's turn (`outlivesTurn`), so another turn ending (a picture or slash command answered on its
own) leaves it waiting. A withdrawn request reaches Claude as a deny in the host's own words ("The user stopped this work before answering."), never as words
the person typed: the answer carries `withdrawn`, which only the host sets (`permissionAnswer`
builds each Studio UI answer afresh). An answer that does not fit (Allow for a plan) is refused. "Always" keeps game rules in
[`src/main/permission-store.ts`](../src/main/permission-store.ts) (`engine-homes/permissions.json`,
atomic and serialized; a failed read is retried, never written over; Plan, Bypass and whole-tool
rules are not believed), chat rules and folders in memory, and a mode on the thread. The boot
repair denies a request left pending (`by: restart`).

## A game's own Claude settings

A game's `.claude` folder is Claude Code's project settings (`settingSources: ["project"]`): its
allow rules and hooks load into the person's own session there, which has no sandbox. The harness
never writes it: `game.write` refuses a path through a `.claude` folder at any depth, in any case
and as Windows reads a name, checked as named and as it really lands (a link inside the game
included), for a game and an optimization candidate. Landing a build (`landBuild`, the person's
button and the coordinator's call) and promoting a candidate refuse a commit that changes one.
The sandbox denies every agent process (the harness, `run.exec`, builds) writing a game's
`.claude` folder (`claudeFolderDenyWrites`).

## For the next Loop run

Unattended deny rules now actually apply (they were relative before and guarded nothing). A real
Loop run must confirm the two known changes: builders can no longer read sibling worktrees under
`scratch/autopilot/<run>/`, and optimization candidates now read the live game.

## Residual risks

- Codex cannot ask mid-turn: Manual and Accept edits are unavailable for it until it runs over a
  protocol that asks (`codex app-server`), and a chat in either runs Codex in Auto's sandbox. Its
  Bypass has no sandbox at all, as the CLI's own flag. Bonsai and Codex ask about no read, and their
  "always" offers no standing grant.

- One card can hold a lead's turn for up to five minutes, and the coordinator's own five-minute
  budget can cut its card short. In Manual a run nobody watches waits that long on each question;
  Auto or Bypass keep it going.
- A lead or coordinator has no sandbox: whatever its chat's mode allows runs with the person's
  access, as in the chat's own session, edits and commands in the game folder included, so it can
  change the live game under the run. Its prompt has it build in the integration worktree and
  leave the game folder alone. A landing that git refuses over uncommitted changes there, or into a
  folder with something staged or a merge under way, lands nothing and names them without blaming
  anyone (`uncommitted-changes`); Make it live refuses while the folder shows uncommitted changes.
  Changes the landing does not touch stay uncommitted after it; a lead that closes with `finish` is
  told to leave them, and every landing names them (`landingResult.leftInGame`).
- A lead or coordinator whose session will not switch (the CLI refuses, or Auto is unavailable for
  its model) stays in the mode it runs in: in Manual it keeps carding in an Auto or Accept edits
  chat, and in another mode it asks first for each call while the chat is elsewhere (except Accept
  edits in an Auto chat), until a later pick switches it or its next session starts. A call screened
  while a switch is on its way asks first too.
- A lead's plugins act on the build it leads: what they deliver is committed before each worker's
  merge, and what is left at the close is committed with its final edits and lands with the run.
  A run with nothing beyond its starting point (no worker's merge, no commit of the lead's) lands
  nothing (`nothing-new`), deliveries included. What else a plugin writes there (a package install)
  is set aside with the lead's other leftovers at the next merge, or lands with the final edits
  after the last one.
- A plugin's consent card holds a lead's call for up to nine minutes, the plugins' own timeout
  rather than `LEAD_ASK_TIMEOUT_MS`. A lead nobody answers through (another engine, a turn that is
  not the chat's) has its plugins and connectors too, acting on its build as a director's in its
  worktree: read-only for its engine, not writing nothing.
- A director with its own hands, a builder and the other run sessions carry the chat's thread in
  their plugin bindings: another turn of the chat ending still withdraws their consent cards and
  aborts their connector calls. Only a lead's outlive the chat's turns.
- A lead's seat rests on run records the harness writes: an edited harness can start a lead for a
  run started in this chat, acting in the chat's mode with nobody there.
- A run's close commits what is uncommitted in the integration worktree as its final edits, which
  can include what a lead left there. A lead's commit made after its last run tool and before a
  Stop is not on the run's integration ref (`syncHead` runs before each tool and at the landing).

- The never-touch hook reads a command's words: a path built while it runs from a variable other
  than `$HOME`, or a `cd` into a folder that only names itself at run time, escapes it. A command a
  worker runs outside its box (approved by Auto's classifier, or by the person in Accept edits and
  Manual) is held by the hook alone, as every command in Bypass is. The box names the roots holding
  a worker's own folders by walking them when the session starts, so an entry made later is held by
  the hook alone until the next session.
- Codex's box never stops reads, so the never-touch list holds a Codex worker's writes only (its
  brief names the roots it never reads).
- A Bypass job writes the whole home folder outside the never-touch list, as a Bypass worker does.
  Jobs have no outbound network in any mode: a download stays with the session's own shell or the
  "Install packages" button. A job's command is screened by its words, as a worker's; its box holds
  what the screen cannot see.
- The Unreal Loop's lead takes its first snapshot at its first save point, so an in-place worker it
  starts before then has only the chat's checkpoints behind it.
- A worker's seat rests on run and queue records the harness writes: an edited harness can make an
  unattended job ask in the chat for a run started there, in the chat's mode, never beyond it.
- A harness `game.start` that names no chat is not held in Plan: an edited harness, or a kept older
  `tools/game-tools.ts`, can write the web starter while the chat plans (the boot reports the kept
  copy).
- A worker's card waits with no timeout: a run nobody watches in Manual waits on it until the person
  answers or stops the work, unless they switched on "Don't wait for me" for it.
- A person's session has no sandbox: its shell runs with the person's access. Manual asks before
  each command, Auto leaves it to Claude Code's classifier, Bypass runs it. The fence binds Claude
  Code's file tools, not commands.
- Inside an unattended session's Claude home, `plans/`, `todos/`, `shell-snapshots/` and
  `session-env/` are shared by every session of that home, so one session can read another's plan
  or todo list; an entry made after a session starts is fenced from the next one (a new project
  folder from the same one only when it branches where an existing folder already does).
- The sandbox inherits the home fence's `Read()` rules as `denyRead`. On macOS they become profile
  regexes (case-sensitive; the globs use the session's own spelling). On Linux and Windows the
  sandbox code expands globs by walking the folder; neither has been checked in a live session.
- A project folder that differs from the session's own only in case (possible on Linux) cannot be
  fenced by the case-blind matcher without fencing the session's own, and stays readable.
- The harness's sandbox names each game's `.claude` folder at launch or adoption. On macOS a
  case-blind glob covers a folder not made yet and any new game under the games folder; a `[` in
  the game's path is escaped, and a `*`, `?` or ASCII control character matches any one-byte
  character, so the deny can also cover a neighbour's `.claude`. On Windows and Linux only folders
  that exist are named (srt-win would create a missing one), and Linux's sandbox drops a path
  holding `[`, `]`, `*` or `?`, so there the host's own refusals stand alone for a folder made
  later or so named. A game adopted, or created anywhere but directly in the games folder, while
  the harness runs is denied to the harness process itself from its next start.
- The `.claude` deny matches paths, so an agent that can write a game's parent can move the game
  away, write its `.claude` and move it back. sandbox-runtime locks only the folder above the
  deny's first glob character against moves: a plain game kept elsewhere is locked itself, a game
  in the games folder only through that folder, and one whose path holds a glob character only
  above that character.
- The Windows rule form (a drive, a network share) follows the CLI's own conversion and parser and
  is covered by a unit test, not yet by a live Windows session.
