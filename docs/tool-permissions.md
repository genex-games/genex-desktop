# Tool permissions in game chats

A game chat's own Claude session follows Claude Code's permission modes and asks the person with
Allow / Deny cards in the chat, as Claude Code asks in a terminal; so do a build's lead and the
run's coordinator, in the chat's mode. A chat on another engine follows the modes that engine can
honour ([Other engines](#other-engines)). Everything else the studio delegates stays unattended and
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
handed to a lead never makes the chat's own session ask. Builders, workers, the playtester,
scouts, judges and a director with its own hands (in its worktree) stay unattended. A plan
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

A lead or coordinator with `leadAsks` (`leadAskingOptions`) starts in its chat's Auto, Accept edits
or Bypass (what Claude Code asks in any mode, such as a dangerous `rm`, is carded as for the chat's
own session), or in Manual (`default`), where every edit and command reaches `canUseTool` and the
host. It is launched with `allowDangerouslySkipPermissions`, as the chat's own session, so the
picker can switch it to Bypass mid-turn; `liveControl` hands the host its `setPermissionMode` as
for the chat's own session, and nothing else moves its mode. No `sandbox` key, no blanket `Bash`,
and its read-only brief keeps what the chat's own session keeps: edit, shell, web and subagents
(still no messaging, `AskUserQuestion` or `EnterPlanMode`). Its one PreToolUse hook, with no
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

A lead also has the chat's own session's plugins, connectors and cover, whether or not it asks
(`hostToolsEligible`): its brief's `readOnly` marks its seat in the game folder (`#leadRoot`), and
the host's own finding of that seat (`seat.leads`) decides, never the brief; a read-only session
that leads nothing, the playtester and the coordinator get none. Its plugin calls act on the
worktree it leads (`DelegationSession.leads` as the binding's directory), as a director's in its
worktree, so a delivery is recorded as the build's and reaches the game when the run lands, and
its brief says so without naming the build's path (`leadToolsNote`); a connector that shares the project root works on
the game folder, as for every session (`resolveProject`). They are auto-allowed studio tools, as for
the chat's own session: a plugin tool that declares `confirmation` waits on its consent card
(`plugin_consent`, nine minutes), asked each time rather than declined by an earlier answer in its
run (`priorConsentDecline`), and a connector waits on its card unless its exact tool is saved as
always allowed. While the chat is in Plan, no plugin or connector action runs for anyone in it (the
chat's session, its lead, a run's workers), saved grants included; reading a plugin's skill still
does (`PluginToolService`, `ChatPermissionService.planning`). The lead is not the chat's turn: another
turn ending leaves its consent cards and connector calls going (`outlivesTurn` in `PluginConsent`
and `activeConnectorCalls`), and its own session's end, a Stop, the answer or the timeout end them. A director's turn writes no Connecting activity, so the build card reads as
planning between parts.

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
any change unasked. Its commands always run in the studio's sandbox, so it has no Bypass. The picker
switches a running session (`onControl`): the next call is decided in the new mode, and the model
reads of it at its next round.

Codex runs Auto as before (`workspace-write` in the game folder, no network, never asks), Bypass
with `--dangerously-bypass-approvals-and-sandbox`, and Plan from a folder of its own (`startsElsewhere`,
as a read-only session) where only the studio's bridge is writable, told it plans
(`planModeNote`). A pick applies to its next turn.

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
without a timeout, except a lead's or coordinator's card, withdrawn after `LEAD_ASK_TIMEOUT_MS`
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
