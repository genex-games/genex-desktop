# Harness runtime guide

Read this when changing the in-app game-building harness. External developer memory is
owned by [AGENTS.md](../AGENTS.md); this page describes product behavior.

What the harness may assume of a served page: nothing. The studio observes a page from outside — it
serves it, takes page screenshots (the compositor's, DOM included), reads the console's errors, and agents
drive the game with real input through the `computer` tool or scripts of their own — so any game of any
shape works, and a folder whose kind is `engine-export` can be played and photographed but can never
start a run.

The Loop. A Loop is its lead's session and the workers the lead may start, in the game's own
folder, whatever the project is (a web game's too). The lead plans or not, starts workers or not
(`worker_start`, Genex's one worker pool: a worker gets a task and the lead's tools, works and ends),
merges (`worker_mark used` merges a copy worker's work into the folder) and finishes (`finish`, which
closes the Loop in place). When a web game's lead finishes, Genex runs one health check of its page
(`loop/health-check.ts`, from `director/open/finish.ts`), by what the folder holds then and never on
an engine's game (`folder-facts.ts` `pageChecked`: one linked to or holding an engine's project): it serves the game folder in a window of
its own, loaded once with `?genex-shot=1` on its address (`preview.load` `shot`; a game may read
it), and asks the host's own check, `preview.observe` — the page loads, it throws no uncaught error,
its frame is not blank; nothing is asked of the game's code. A failing check answers the finish with
what is wrong (the host's own words, `findings` beside them) and the Loop goes on; a check that
could not be made holds nothing. An engine that keeps no session of its own (Ollama's tool loop) leads no Loop: its chat is
plain chat, and a run started on it closes at once with `refusal: "needs_session"` on its
`run_finished` report (`run-dispatch.ts` `LoopRefusal`) beside the words the chat reads.

Second opinions. No judge decides anything on its own. The lead may ask one with `judge`
(`loop/second-opinion.ts`): the pictures it names (PNG or JPEG inside the project's folder, read by
real path, at most six of 8 MB each) and a question it chooses, go to the Reviewers role (`run.judgeEngine`, `judgeModel`) as one
`engine.complete`, and its words come back as advice. Motion goes as frames with their times
(`loop/judge-frames.ts`, which takes from the judge only names every shipped one has): `strip` names a
motion strip's poses file, whose frames (at most 24, each inside the folder; one that never landed is
left out) go first at full size, and `times` gives each picture a game time. When any picture has a time, the question is
followed by every picture's place, game time and gap (`loop/judge-frames-prompts.ts`), since an engine
sends a picture without its label; frames past 20 MB together are left out from the end, and the
answer says how many. `finish review=yes` asks a reviewer the same
way (the finish check below): its yes closes the Loop, its no comes back with its reasons and stops
nothing.
Every direct model call is recorded by the host as `completion_call` with the caller's role.

Learned data and kept edits are archived, never read. The seed writes no lessons, checks catalogue,
recipes, memory of the user's taste or staged skill edits, and reads none: a workspace that still
holds them works without them. On an install's upgrade into the archive epoch (`ARCHIVE_EPOCH` 2,
the app's `substrate/seed-archive.ts`: every install whose manifest records a lower `archiveEpoch`
archives once more) they move to `<harness workspace>/archive/<YYYY-MM-DD>/` at
the same relative paths — `library/games/`, `library/contract-lessons.md`, `library/checks.json`,
`library/recipe-stats.json` — beside the agent's own edits of seed files this seed removed or changed
incompatibly, which are archived the same way and replaced by the seed's copies; the boot writes the
`memory` and `skillopt_staged` artifacts to `archive/<date>/artifacts/<id>.json` and clears them.

What the loop's code is. The seed is TypeScript that Node runs by stripping its types — under
Electron's own Node (`ELECTRON_RUN_AS_NODE`) in the app, with no build step — so it uses
erasable syntax only (no `enum`, `namespace` or parameter properties) and imports its siblings
by their `.ts` names. It is type-checked as its own project (`src/harness-seed/tsconfig.json`,
strict; `npm run typecheck` runs it through `tsconfig.harness.json`). The host calls it may make
are typed in `types/host-api.d.ts` and named in `loop/host-methods.ts` (`HostMethod`), both
generated from `src/shared/harness-api.ts` by `scripts/gen-harness-types.ts` (the build writes
fresh copies into the seed it ships, and `harness-types.test.ts` holds the committed copies to
the contract); the ctx a loop function is
handed is `types/harness.d.ts`. The seed asks nothing of a game page's own code: Genex looks
at a page only from outside. The bootstrap imports `loop/main.ts`, and a workspace from
before the conversion that has only `loop/main.mjs` still boots from that. The tool registry
loads `tools/*.ts` and a legacy `tools/*.mjs`, and when both `x.ts` and `x.mjs` are there `x.ts`
wins and `x.mjs` is not loaded; `install_tool` takes a `.ts` file name (`.mjs` still passes).

How an existing workspace becomes TypeScript. The seed manifest records a layout
(`layoutVersion`: absent or 1 is JavaScript, 2 is TypeScript). While a workspace still has an
`x.mjs` the seed now ships as `x.ts`, `applySeed` holds that `.ts` back (`deferred`), so the
bootstrap keeps running the JavaScript tree and an agent-edited `loop/main.mjs` is never
shadowed by a new `main.ts`. At start, before the harness boots, `RecoveryService.migrateHarnessLayout`
takes a snapshot, runs `migrateHarnessLayout` in a validation fork of it, type-checks and
boots the fork, and only then runs the same migration on the live workspace and snapshots it
again: an untouched `x.mjs` (its bytes are what the manifest last applied, or a backed-up seed
vintage) is backed up and replaced by the shipped `x.ts`; an edited one is renamed to `x.ts` with
its content kept (the original goes to `updates/harness-edits-*`, outside the seed vintages); a
deleted one keeps its `x.ts` deleted; an edited one beside an existing `x.ts`, which wins, is
backed up the same way and removed (`stranded`); an edited `tools/index.mjs`, which imports only
`.mjs` tools and so would register none, is backed up and the shipped `index.ts` laid down
(`replaced`); and every relative `.mjs` specifier whose module is now a `.ts` is repointed, the
agent's own `.mjs` tools included. Type errors in the renamed files never block the boot: the
`harness_layout_migrated` record (Studio activity) carries them, and a note in the agent's memory
tells it they are there to fix (and names replaced or stranded edits). Neither snapshot, nor the
`seed upgrade baseline`, is healthy for being taken, since each may hold a last-session edit that
never ran. Each is healthy when its code equals an already-healthy snapshot's, or once the live
boot that follows answers (`vouchForBootedSelf`). A migrated self that booted in its fork
but fails live is therefore no rewind target: the rewind goes back to the JavaScript tree or an
older healthy self, and the attempt is recorded. A fork that does not boot leaves the live
JavaScript tree in place, records `ok: false`, and the attempt is retried only when the seed or the
workspace's `.mjs` modules change. A rewind to a snapshot from before the migration brings `.mjs`
files back and the next start migrates again; one from before the upgrade also took the files only
the TypeScript layout has (modules with no `.mjs` predecessor, `types/`, `tsconfig.json`), which
that migration lays down again (`restored`) rather than reading their absence as the agent's
deletion. The crash-recovery reseed and the user's reset remove the `.mjs` modules the seed
replaced (backed up to `updates/reseed-backup-*`). Every manifest write stamps `writer` (layout and
app version); a manifest an older app rewrote has none while still carrying `.ts` entries or
retired `.mjs` modules, and the next start records `harness_downgraded` with the JavaScript edits
the agent made meanwhile, which the migration strands.

The self-edit gate. `write_own_file`, `write_skill` and `install_tool` change the agent's own
files only through `guardian.write_self`: the host tries the change as `guardian.validate_edit`
does, and only a pass is written, between two host snapshots, with a record the host writes
(`self_edit`, `skill_edited`, `tool_installed`; the harness may not append these). The record
keeps the agent's reason and, bounded by the host, the plain `title` and `summary` it wrote for the
person. Activity lists each one until it is undone, and Undo reverts exactly its file. `prompts/` and `skills/` are
write-denied to every agent process, like `judge/`, so nothing else changes them.
`guardian.validate_edit`: the host makes a validation fork (a worktree of the harness at its
current commit plus the live uncommitted files), writes the change into it, runs the vendored
TypeScript 7 compiler (`resources/tsc`, `substrate/type-gate.ts`) as `tsc --noEmit -p
tsconfig.json` inside ProcessSandbox with the fork denied for writing and a time limit, then boots
the fork and asks its healthcheck. The fork's `tsconfig.json` is first replaced by the app's own
(`resources/harness-seed/tsconfig.json`): the workspace's is the agent's to edit ungated, and a
loosened one (`noCheck`, a narrowed `include`) would otherwise switch the check off. `run.exec`
denies writes to the harness's code (`loop/`, `tools/`, `memory/`, `types/`, `tsconfig.json`,
`package.json`), so a shell cannot change it around the gate. A change may not add type errors: errors the self already had
(counted by file, code and message, since an edit moves lines) do not block it, so a migrated file
can be fixed a piece at a time, and every error it adds is reported. A refusal
reaches the agent as the tool result with the compiler's lines (bounded), and nothing is written or
snapshotted. A missing compiler, a timeout or a compiler failure refuses too; nothing reads them as
a pass. A passing fork's code is remembered by fingerprint, and the after-snapshot the tool asks to
be healthy is healthy when the live code is exactly that code — a rewind target without a restart.

How the loop's code is laid out. The modes keep their own control flow — `director.ts` (the
run, with its parts under `loop/director/`: `setup.ts` builds the run as one explicit object and opens its worker pool,
`loop-run.ts` for the run's shared functions, `rules.ts`
for what needs no run, the wake loop that drives the lead's session — `wake.ts` (its turns),
`wake-schedule.ts` (when it is woken, a pure leaf), `news.ts` (what reaches the lead: the chat's
words on its line and Genex's lines of the run's log, at rest or mid-turn) and `wake-prompts.ts`
(Genex's own lines: the Loop's start and the wrap-up) — and the full journal — `journal.ts` (the
run's record every save writes to the run journal, and what a resumed run reads back) — and one session — `lead-session.ts` (whose session the lead is, and the
chat's bookmark), and `lead-session-prompts.ts` (the chat's own session as lead), with the Loop's tools, finish, close, save points and health watch in `director/open/` — the parts never import `director.ts`) — and share
primitives instead of copies of them: `git.ts` builds and runs every git command line (a
conformance test finds no other), `health-check.ts` is the one health check (the host's `preview.observe`, in a window of its own),
`config.ts` holds the shared waits and the light effort a
bounded ask runs at (always "low", whatever role effort the user set), `model-roles.ts`
`roleEffort` caps a worker's and a reviewer's effort at high (`WORKER_EFFORT_CEILING`, the app's
copy in `shared/model-roles.ts`) while the lead keeps the user's, `outcomes.ts` gives every stop a
code beside its sentence (`stopCode`), `run-events.ts` writes a run's events and journal and
logs a failed write to the harness's stderr, at most once a minute per kind, instead of dropping
it. A seed upgrade keeps a file the
agent edited (unless this seed removed it or changed it incompatibly: then the edit is archived and
the seed's copy laid down, see above). A change that would break a kept older file bumps
`ARCHIVE_EPOCH` (`substrate/seed-archive.ts`).
An edit the agent made to a moved
function in a kept file still serves that file's own callers; the rest of the loop uses the new
home. The upgrade does not hold the callers back (that would freeze every shipped fix to them for
as long as the file stays edited); it says so instead. `SEED_MOVES` in `substrate/seed-upgrade.ts`
lists what moved where, and `applySeed` reports a kept file that still defines moved code which
other files now import from the new home (`moved`: names, new home, callers). The
`seed_upgraded` chat card and Studio activity name it, and every boot keeps one note per such
file in the agent's memory (`RecoveryService.noteSeedMoves`), taken back once the kept file no
longer defines the moved code. A host call whose shape changed needs no report: it ships with an
archive epoch (`substrate/seed-archive.ts`), which archives every kept copy of a file the seed
changes. A renamed name or module
(`substrate/seed-renames.ts`) is not reported but carried into the agent's files: before the pass, a
kept or agent-written module has its old names rewritten, the original backed up, and an edited copy
of a renamed module moves to its new path; `applySeed` lists them (`renamed`). An old name that is also an English word changes only in code,
never in a comment, string or pattern, so the agent's own prose comes through every boot as written.

New projects start empty. `game.scaffold` with no `kind` makes a folder with Genex's bookkeeping
only (studio.json, the ignore rules, a repository with its first commit) and no facts: its first
message picks what it becomes; on a folder that already holds anything it writes nothing. `kind: "web"` (or an older caller's `"studio-template"`) writes the
three.js starter; any other kind is refused. `game.start {project, starter: "web"}` writes the
starter into a game with no kind yet and refuses one that has a kind, or a link in its folder
where the starter would write (never written through). A game with no facts lists
what its folder holds (`holds`: `nothing`, `notes`, `own-files` or `unreadable`); only an empty
folder or one of notes has no kind yet (`kindPending`); what Genex's asset tools deliver into
`assets/` (or `public/assets/`) is not the folder's own. A folder of somebody's own files of a kind
no rule knows (a Pygame project, say) is never handed a starter: `game.start` and `start_web_game`
refuse it, and a Loop on it stops and says it needs a kind. A Loop's launch scaffolds a
new game as web, and a Loop on a game with no kind starts it as web before its runner is chosen
(`startWebIfPending`, `loop/folder-facts.ts`); the web runners scaffold with `kind: "web"`. A local
model's `new_game` takes `kind`, and its `start_web_game` calls `game.start` with its chat
(`threadId`): while that chat (this game's) is in Plan mode the host writes nothing and answers the
same Plan blocker as the chat's own `start_web_game`; a thread of no chat or another game's lends
no Plan answer, and a call with no thread (a Loop's start, which runs only once approved) is not
checked. Its `plugins_find` and `plugins_suggest`
(`tools/plugin-finder.ts`) call `plugins.find` and `plugins.suggest`; a shown card ends the turn
([plugins](plugins.md#finding-and-suggesting-a-plugin)). It has no `plugin_check`, which only a
delegated chat's own session is handed, and no `show_design` ([design board](design-board.md#when-the-agent-uses-it)).

Genex's own gates (`loop/builtin-hooks.ts`, `BUILTIN_HOOKS`) run beside the plugins' hooks, each
registered for a moment and the facts it guards, reading typed fields only. `web.ready` at
`run.prepare` reaches a web game served at the root: the files its page lacks to load, by
`game.validate`'s `missing` names, are a line its Loop's lead reads first ("moth's page is missing
index.html."), never a refusal of the launch (`moment-lines.ts` `gateLines`, which the director's
start asks for); a Godot, Unreal or plugin project is never told of a missing `index.html`. Only an
engine export of any kind is refused (`loopRunRefusal`).

The chat's own session reads the person's words as they wrote them (`from: person`), on its first
turn and every later one; pictures go as image blocks. What it knows of Genex is its system text,
`chatContext` (`loop/chat-session.ts`), sent as `engine.delegate`'s `system` on every turn, the same
text for the chat's whole life, the lead's turns included (`director.ts` `seatTheLead`). A resumed
session keeps the system text it started with (Claude Code 2.1.314 until a compaction, `codex exec
resume`), so it holds only what no turn changes: Genex's identity (`appIdentity`,
`loop/project-prompts.ts`: the folder, that Genex shows a web game in Live and what a Genex plugin
is, never what the folder holds), that the person may not be a programmer, the language rule,
whose plan the work follows (what the latest message asks, at the stage the project is in; a
project's own notes such as a `HANDOFF.md` are the plan; building, packaging, publishing or a
finished game only when asked), that it asks before it designs or builds a new game, or a large new part of one (at most four
short questions, one at a time, on what the person's words leave open, each with up to three
answers and its pick first, with `ask_user` where the session has it and in its reply where it
does not; a game named only by a likeness or a genre, "a game like GunZ", is open; then the design
on the Design tab where it has `show_design`, and the build once the person agrees to it; only an
ask to just build, or a small game their words give whole, "make me Pong", builds at once, and
nothing the project's notes or the chat already answer is asked), that the agent checks its own
work before it reports it, and the
chat's Run button. What the folder holds is the session's to see: a game's own `CLAUDE.md` names
the build Genex runs before every preview, and a plugin's guidance says how its kind is built and
linked; a turn that changes the kind tells the session in Genex's line (`factsReadyNotice`). The Loop's start,
workers, the checkpoint, the kind tools, `start_web_game` and `plugins_find` are tools, never
restated: Genex's own project and worker tools load with the prompt on Claude Code
(`LiveToolSpec.alwaysLoad`), and the question card (`ask_user`) is bridged while the folder has no
kind. `ask_user` asks one question with up
to three answers; one of a short run of questions names its place in `step` and `of` (whole
numbers, 1 ≤ step ≤ of ≤ 4, as numbers or their digits), which its `interview_question` record
keeps and the card shows as a counter; any other count is dropped and the question is asked
without one (`loop/interview-question.ts`; the app reads it with `questionStepOf`,
`shared/custom-events.ts`). The Loop's start says a build starts once the game's direction is
settled, by the person's words or their answers. A session that starts in a chat that
began before it (a resume that failed, another engine) is told the chat so far as one Genex notice
(`chat-continuity.ts` `historyNotice`: the last compaction's handover, then the newest messages
that fit, `brief-window.ts`), beside the same words. Every other brief still opens with Genex's
identity: a local turn's, the director's, and every worker's (the pool's, the director's single,
conflict, base and facet builders; `loop/workers/identity.ts`). A classic Autopilot's builders keep
their own brief. A local turn's prompt (`loop/prompt.ts`) tells a folder with no kind yet to start web
with `start_web_game` or find a plugin with `plugins_find`, naming each kind's tool, and one of its
own files to look through them first; only it lists the workspace's skills (`formatSkillIndex`): a
session's turn, a Loop lead's included, is told none. A local turn's operating rules are split:
`prompts/operating-rules.md` for every turn and `prompts/operating-rules-web.md` only for a web
game.

Every game chat message is the chat's own turn: its build's lead's while that build runs, the chat's
own session otherwise, which keeps the run's status (`run_status`, and `resume_run` after a pause
of a Loop that worked in place) after a closed Loop run whose journal seated a lead
([after the build](conversation-lifecycle.md#after-the-build-the-same-session)). Not solved, by the
owner's decision: a chat whose build ran on the classic pipeline or a gauntlet (as on a local model
without sessions) has no way to start another timed build in it since "Start a new build" was
removed.

`src/harness-seed/prompts/` is the LOCAL-ENGINE game chat path only (`loop/prompt.ts`): the delegated
engines get their instructions from the briefs the loop renders, not from those files. Trimming
them changes the local game chat and the readiness fixture, and nothing a run does.
Studio's tool-free instructions live in `loop/studio-chat.ts` for every provider.

Session permissions, web research and thinking summaries (`substrate/engines/claude-code.ts`,
`claude-permissions.ts`). Only the Claude Code session answering a message the person sent in a
game's own chat is interactive: the host, never the loop, hands it `DelegateRequest.permissions`,
so it runs in the mode the person picked, without the studio's sandbox or a blanket Bash allow,
and asks them (`canUseTool`) whatever Claude Code would ask. The host decides from its own records:
the brief's shape, the message id it dispatched on that thread (`chatTurn`) and the thread's
metadata. A waking run's lead answering its chat gets `leadAsks` instead: Claude Code's tools in the chat's Auto, Accept edits or Bypass, else
in Manual, switched by the permission picker while they run, no sandbox, limited only by the chat's
mode and saved rules as the chat's own session; each question answered for that mode or carded (withdrawn after five
minutes), and every call but a read or a studio tool screened by the host ahead of every allow rule
(a PreToolUse hook) only to ask first while the chat is in a mode the session could not be switched
to. A lead also has the chat's own session's plugins and connectors. A Loop's lead has one seat,
the host's own finding (`DelegationService#inPlaceRoot`): it works in the game folder itself, a web
game's too (honoured only for a writing lead whose `director.root` is the game folder by name and
real path, of a run of this game started in the chat its delegation and grant name), its plugins
acting there and its run's consent covering its engine connector; on a game Genex sees it has the
window its chat's turns have (the capture and computer tools), beside its run tools. A grant it
cannot place leaves the session unattended. A lead's workers, the director's builders among them, follow the chat's mode and
ask in it, boxed and never reaching the never-touch list in any mode
([workers](tool-permissions.md#workers)); a reviewer and a second opinion are unattended: `acceptEdits`, a sandboxed shell auto-allowed inside the workspace,
and no questions. A harness edit can make a
session ask only about a message the person sent that is still unanswered, and never chooses its
mode or answers a card: it makes no threads, and `events.append`/`turn.append`
refuse `tool_permission` and `plugin_consent` rows. Nor does it write a game's `.claude` folder,
whose settings and hooks the person's session loads. Deny rules name
absolute paths (`absoluteRule`: `//abs/path`, on Windows `//c/...`), because Claude Code reads a
rule's `/x` relative to the settings root. A worktree's session still reads its own game, and a
folder's neighbours are denied only inside the games root or scratch
([tool permissions](tool-permissions.md)). A Claude Code chat,
lead and worker may use WebSearch and WebFetch; second opinions (`complete()`) and read-only
sessions may not, and an unattended
shell keeps its sandboxed network. Every delegated Claude session asks for thinking summaries
(`showThinkingSummaries`); the chat shows a chat or lead session's non-empty summary under the
work disclosure's Thinking details, never a builder's or judge's. Codex keeps its CLI's own web
search default.

Connector tools are host-owned and arrive from one list. Studio main is the only MCP client: the
connector registry connects each enabled connector, namespaces its tools `<connector>__<tool>` and
appends them to the same `liveTools` every path already carries, so Claude Code gets them on the
in-process `studio` server, Codex through the file bridge (or, opted in, as app-server dynamic
tools: [Model setup and activity](connections-and-context.md#model-setup-and-activity)) and the local harness over `mcp.tools` /
`mcp.invoke`. The harness never speaks MCP itself, and it never learns a connector's name from a
prompt file: guidance is one short paragraph the registry composes for whatever was in scope (the
user's own connectors and those a plugin brings in separate blocks), tool
schemas travel as `inputSchema` beside the flat `parameters`, and a name collision with a plugin
tool throws rather than resolving. Nothing on the agent side can add, change or enable a connector.

The job tools (`job_start`, `job_status`, `job_tail`, `job_stop`) are host-owned the same way, on
the same `liveTools`: the chat's own session, a lead and a seated writing worker get them on a
delegated engine. Main, not the harness, owns every job (`src/substrate/jobs.ts`), so a job
outlives its session's turn and a harness restart, and stops when its run settles (the harness's
`run.settled`), when its worker's chat turn returns, or when Genex quits. The harness neither starts
one nor writes its `job_started` / `job_ended` records; a start follows the chat's mode at the call
([tool permissions](tool-permissions.md#jobs)).
Job output pauses both pipes when the log writer is full, resumes when it drains, and keeps
draining without retaining output after the size cap. A normal exit waits for buffered output
before closing the log; the orphan-pipe deadline still ends an idle or already-capped pipe.
A failed writer reports its error and releases its pipes rather than leaving a paused job behind.
So is `app_look`, look-only and in every mode, which a seated reader worker gets as its one host
tool ([looking at apps](tool-permissions.md#looking-at-apps)).

A run's job (its lead's or a worker's) that ends reaches its lead. The harness reads the run's ends
with `jobs.list` (read-only: no paths, no start, no stop) after an end number the run's journal
keeps (`jobsCursor`, in the director's loop run, `loop-run.ts`), so a resumed run reads on from
there and hears no end twice (`loop/jobs/watch.ts`, polled at most every 5 seconds). A resting
director is woken soon by a `job_ended` line. An end the agent itself caused (`job_stop`) wakes
nobody.

A chat's own job wakes the chat the same way, from the host (`main/core/job-wake.ts`), whatever
its engine: a `job_start` job of the chat's own session that finished, failed or ran out of time
starts the chat's next turn, or joins its running one, with one hidden message
(`MessageOrigin.JobEnded`) naming it, and counts as told; one someone stopped, or one an earlier
Genex left running, is told only by the next turn's notice. A plugin tool whose manifest names a
`jobStatus` ([plugins](plugins.md#manifest-reference)) is watched the same way: once the chat's own session's
call answers `{started: true}`, Genex reads the status tool every 15 seconds, with the call's
arguments it declares, until it answers `jobRunning: false`, then sends that message naming both
tools (an Unreal package: "read `unreal__package-status`, tell the person, then go on"). The agent's
own read answering `false`, a new start or a stop ends the watch with no message, as do three reads
in a row that say neither and three hours of watching. A run's lead and workers follow their jobs
themselves.

What a rollback may assume of a game folder. `snapshot.restore` on a game commits a rescue
snapshot first and may refuse with a typed `code` (`branch-changed`, `history-changed`,
`operation-in-progress`, `rescue-failed`, or `hook_blocked` when a plugin's `restore.before` step
blocked it), leaving the folder as it is; a loop must treat that as
"stop or pause", never retry around it with raw git, and never report a rollback that was refused
(autopilot's `rollBackGame` sets `report.rolledBack`). A loop snapshots its attempt before rolling
back and skips the rollback when that snapshot fails (the live spike does). Model or judge text
that reaches `/bin/sh` — a commit message, a worker title — goes through `loop/shell.ts`
`shellQuote`, never a `"` replacement, and the command line is built by `loop/git.ts`. A web Loop an
earlier Genex ran recorded its landing's refusals (`final-commit-failed`, `uncommitted-changes`,
`could-not-land`); no Loop lands a copy now, and the chat reads those words from its old records.

Genex's moments. Every restore of a game folder (`snapshot.restore` naming the game, and the
person's file Rewind) runs the enabled plugins' `restore.before` and `restore.after` steps around
it (`main/core/plugin-hooks.ts`); a `snapshot.restore` that names its chat and run (`threadId?`,
`runId?`) waits for that chat's plan. `checkpoint.take {project, threadId?, runId?, label,
onlyIfUnsaved?}` is a checkpoint: the `checkpoint.before` steps, a game snapshot named
`checkpoint: <label>`, then the `checkpoint.after` steps, answering `{snapshot, notes, images}`,
`{blocked}` or `{skipped: nothing_unsaved | cant_tell, reason}`. `hooks.fire {project, threadId?,
runId?, on, turn?, label?, worker?}` runs one moment the harness announces and answers the
`HookReport` (`blocked`, `pending`, `notes`, `images`, `ran`); the checkpoint and tool moments are
the host's own and refused there, and a `restore.*` it announces is a restart in which no file
changes. The run's or the chat's Stop (`engine.abort`) ends these three calls while they wait or run
their steps. A game no plugin hooks (`GameProject.hookEvents` absent) has no steps: both answer as if
nothing ran. The seed asks for them through `loop/hooks.ts` (`fireHooks`, `takeCheckpoint`,
`waitReady`), which makes no call for a moment the game's descriptor doesn't list and sends labels
and turns on one line within `HOOK_LABEL_CHARS`. `observers.capture {project, runId, threadId?, observer?, withinMs?}`
runs the game's plugin observers for a run of this game (one, named `<plugin>/<id>`) and answers
one `{observer, label, images, recording, note?, problem?}` each, pictures as `{name, file,
mimeType, data}` with `data` downscaled for a prompt; the host keeps the files under the run's
folder and records `observer_capture`; a run that is not the game's or an observer it has not is
refused before anything runs, nothing runs or is kept past `withinMs`, and Stop, the harness's end
or an ended boot end it as they end the moments ([Observers](plugins.md#observers)). The seed's `loop/observers.ts` turns those and Genex's
own web preview (the health check of each served web folder, its page screenshot as the one still) into one `Capture` shape (`observeGame`, bounded by a deadline on
the caller's clock, which the host is told as `withinMs`; `pickedImages` for a reviewer's prompt;
`recordCaptures` records the preview's and the lead's proof, the host records the plugins'). The Unreal
lead's save points and autosaves are checkpoints, its rewinds restores, its rebuilds (its `restart`)
the restore moments followed by `health` until it is quiet, its watch on the editor `health`, and it
fires `run.prepare`, `run.end` and the turn moments; it names no plugin step and fires no `crash`. A chat's own turn fires
`turn.start` (what its steps said, a block or Genex's hold among it, is one Genex notice on the
turn's first leg, `moment-lines.ts` `momentLines`: nothing ends the turn) and `turn.end`, ends with
`endOfTurnCheckpoint` (`checkpoint.take` only if unsaved) and, after a turn that linked the game to
an engine project or switched its link, waits on `health` (`waitReady`, up to `READY_WAIT_MS`); any
other kind change goes on at once. When the app never gets ready (a step blocks, or the cap passes)
the chat says why once and the same session goes on, told Genex's line with the reason
(`factsReadyNotice`'s `notReady`, a fact and nothing more): the agent opens, reopens or waits for the
app itself. Only Genex's
own hold for the person using the app keeps it from going on. Genex's own hold of that checkpoint, and in `turn.start`'s
notice, is in the person's words (`hold`), and Plan mode says nothing of the checkpoint; Genex's hold of a save
point, rewind or restart a Loop's lead asked for is worded for the lead from its hold too (`loop/director/held-words.ts`
`heldForLead`). A host call of the moments that fails refuses a blocking moment's call
with why and is Genex's note at any other moment (an older host's `UnknownMethod` is no moments at
all), unless the chat's or the run's Stop ended it: a blocking moment's call is refused as stopped,
any other moment is one no step ran at, and that run ends as stopped, never as held. No Loop fires `crash`. A `locks.hold` that fails starts no writer in place. Workers fire `worker.start` before their
start record (what its steps said, a block among it, joins `worker_start`'s answer: no step holds a
worker back; a worker refused after it still gets `worker.end`) and `worker.end` after their end
record (what its steps said joins the end line a run's lead is woken with), in the pool and the
director's builders; the director fires `run.prepare` (what its steps said, a block among it, is
a line of the lead's first message), `run.end`, each wake turn's `turn.*` and the lead's own
`finish` (a block is the tool's answer; the run goes on). Every one waits on `hooksOn`, so a web
game's run and chat make no new call. See [Hooks](plugins.md#hooks-genexs-moments).

The finish check. A lead's claim that a Loop's goal is reached goes to `checkFinish`
(`loop/finish-check.ts`): it captures the game (`observeGame`, at least `FINISH_OBSERVE_MS`, more when
the call spares it beside a full review), reads
the files the lead names as proof inside its folder (`loop/finish-proof.ts` `readProof`: relative or a
full path inside it, by real path,
at most `MAX_PROOF_FILES`, pictures kept as run artifacts and text clipped, anything else a one-line
refusal; an Unreal plugin's proof is the three paths `unreal__plugin-status` lists: the test summary,
the package note and the window's picture) and the run's ended jobs (`jobLines`: title, end, exit code
and minutes, never the command),
then asks Genex for a review: the Reviewers role's engine and model when it holds sessions, else the
run's own (`reviewerSeat`), through `finish.review`. The verdict is the app's
(`main/core/finish-review.ts`): the host checks the run is a running run of this game with no round
held, records the round's `checking` step, runs the reviewer as `engine.delegate` runs one with
`readOnly` and `reviewer {runId, reads}`, reads its yes or no (`reviewerVerdict`,
`shared/finish-check.ts`) and holds it until the harness settles the round (`finish.settle`). The
harness may settle a held answer as no answer (a yes that lapsed, a turn that ended), never as a
yes; the host counts the no's in a row from its own records (`rejectionsInRow`; a resumed run goes
on counting), writes the outcome, and no row of no's stops a Loop; a settle names no time. A run's start, pause or close drops its held round: a review or settle still
waiting then records nothing more and starts no reviewer. `finish_check` is a
host-only record: a harness batch carrying one is refused whole. The
host seats the reviewer in a fresh home of its own (a folder no box writes), reading the lead's folder and the run's captures, with
`app_look` and nothing else ([Tool permissions](tool-permissions.md#a-loops-reviewer)). Its pictures
are the lead's proof first, then one still of each observer in turn, then play frames, fitted to the
seat (none for a model that can't see, as many as its window holds, no picture over
`REVIEW_PICTURE_MAX_BYTES`, `REVIEW_IMAGES_MAX_BYTES` in all); a seat that can't hold the brief gets
it without the proof's excerpts, then without the hooks' notes, and only then is no reviewer. The
brief marks everything the lead, its files and the plugins wrote as data, quotes the person's own messages, word for word, as the
person's word (`loop/finish-log.ts`: a steer the lead took from their message, or one whose words are
that message's), the rest as relayed by the chat's agent, labels `run.goal` as the launch wrote it,
and counts the pictures attached. A proof file is read by handle, never through a link or a FIFO, and
only while its name still leads to it inside the folder.
The lead's `remaining` (what it says is not done yet, one item a line, `remainingOf`: at most
`REMAINING_MAX` items of `REMAINING_ITEM_CHARS`) comes before its claim and is never clipped with it,
and the brief asks the reviewer to open pictures of its own choosing in the folder and to judge how
a thing looks only from a close front or side picture.
It answers `{"verdict":"yes"|"no","reasons":[…],"done":[…],"notDone":[…]}`: `reasons` say what it
checked and found, met or not, `done` and `notDone` are short checklist items of what the proof shows
and what it doesn't show yet; they stay apart in the record and the answer, and only `notDone` is
what is still to fix on the "Almost there" card, in Builds' "Final look" and in the report
(`notDoneOf`; a record that names none falls back to its reasons). The chat says nothing per round.
Every Loop's close that is neither a yes nor a pause writes `run_finished.stillToFix` (`stillToFixOf`):
the last no's `done` and `notDone` and why it stopped (`StopWhy`: the person's Stop or another end;
`time` with its `hours`, and `stuck`, only on a record an earlier version wrote). The chat's card
reads only that, so a page that lost the run's start still shows it. A Stop pauses every Loop, and a
pause keeps its own reason and Resume. Keep
building is offered on the
chat's newest card until the person writes again, and on Builds' newest ended build, while nothing runs
or waits paused. It sends what the build left undone as an ordinary message (`keep-building.ts`
`keepBuildingAsk`), and goes once it went out; the chat's own session answers it as any message, so
it may start a new Loop or make the change itself. A review
is asked only with `review=yes`: yes ends the Loop, and a no goes back to the lead with both and
decides nothing (the host still counts the no's, which close nothing); after `MAX_FINISH_REJECTIONS`
(3) in a row, a review asked on proof that names no file made since the last no is turned back before
any review (`freshProofIn`), and nothing is recorded. An answer
that says neither, a failed session or a Stop neither counts nor breaks the row. Every step is a
`finish_check` record the host writes (`checking`, then `accepted`, `rejected` or `unanswered`, with
the round, the reasons, the count and the reviewer); a claim no engine here can review, or one whose
model can't hold the brief, asks nothing and records nothing. The whole check fits inside the lead's one call (`LEAD_CALL_MS`,
the bridge's deadline): a claim with less than `FINISH_REVIEW_MIN_MS` left for the reviewer after
the observers, the margin and the close is no claim and records nothing. A claim on a
run already closing opens no round; a check whose run closes under it settles nothing, one whose
turn ends while the run goes on (`abandoned`) is settled as no answer, and either way the run's
reviewer is stopped (`engine.abort {reviewer}`). A yes the caller finds no longer stands (`lapsed`) is
settled as no answer, the count untouched. The caller keeps the
`FinishTally` in its journal (`tallyOf`, saved as a round starts), so a resumed Loop goes on
counting; a round's number also goes on past the newest the run's log holds, whatever journal kept the count.
Chat turns get no check.

The lead claims through `finish` (`director/open/finish.ts`), which needs a summary and closes the
Loop in place on the lead's word; a web game's page gets one health check first, and a failing one
answers what is wrong while the Loop goes on. With `review=yes` it asks a reviewer first: a yes ends
the run as `goal-reached`, a no is advice and the run goes on, and a review no engine here can hold
is said so and ends nothing. A Finish asked of the run (the person's Wrap up, or the lead's
`wrap_up`) closes it as it stands at the next `finish` or at the end of its wrap-up turn, and claims
nothing; `wrap_up`'s own description is the one place the rule is said. One close and one finish
run at a time (`director/close-latch.ts`): a second finish is refused at once, and a close asked
while one is under way waits for it; from the finish's close on, `worker_start` is refused and
starts nothing. No row of no's stops a Loop.

The Loop in place (once "the open Loop"). `runDirector(ctx, { threadId, run, resume, clock })` runs
the director's wake loop on a project of any kind, led in place (`loop/director/open/`).
`prepareLoopRun` (`director/setup.ts`) takes the game as `game.list` lists it, the run's
`budgets.creditCap` set to `DEFAULT_CREDIT_CAP` (600) before `run_started` when the record names none,
`autopilot_started.profile: "open"`, Genex's snapshot of the folder before the first turn (`run
<id>: before the Loop`), `journal.director.open` (`OpenJournal`: save points, what to do between
turns) and the run's worker pool (`runPool`, the Workers role, the run's credit cap,
one git-write queue for its merges and the lead's saves, a worker's end a `worker_ended` line). No
scaffold, contract, preview, ledger or integration worktree: the host reads the game folder for the
run's files, and after the Loop the chat's own session keeps `run_status` alone
(`runControls.inPlace`), and starts a new Loop for more work.
Every start is its lead's, fresh or resumed: `run.prepare` fires as for any run, Genex's `web.ready`
gate looks at the folder, and where a plugin watches the app Genex looks at it once (`health`,
`director/open/app-look.ts`, the watch's baseline); what they found (a step's note or block, the
page's missing files, an app that doesn't answer or isn't ready yet) is a line of the lead's first
message, and nothing holds the start back. A Stop while it prepares keeps nothing (adding no worked
time on the app's clock through the close's `workedUntil`), and a Stop before it fires no plugin's
`run.prepare`. The lead is the chat's own session with `director.inPlace` and the
game folder as `root` (no `cwd`, no `readOnly`; the host's in-place seat), every delegation carrying
the run's credit cap; its first message is Genex's line that the Loop started, with its goal ([what
wakes a Loop's lead](#what-wakes-a-loops-lead)). Its tools say the rest: `worker_start` names the
plugins' worker types, `save_point` says it keeps the files on disk only when no plugin hooks
`checkpoint.before`, and `restart` that it rebuilds the game's C++ on a project with an Unreal
project in it. Its tools are
the director's `note` and `run_status` by name, the six worker tools through the pool (a copy's
`worker_mark used` merges into the game folder, refused over the lead's uncommitted edits of the same
files) and its own `finish` (`summary`, `proof`): the finish moment, then `checkFinish` on the game
folder, its review ending `OPEN_CLOSE_MS` before the call's end (no answer when the
claim's turn ended meanwhile); a yes or the stopping no closes in
place inside the call, which answers that the Loop is closing should the close outlast it
(`closeInPlace`: the pool closed, the last work kept in a checkpoint when the folder changed or a
plugin saves the app, `run_finished` with `profile`, `landed` as any save point or that checkpoint
once the Loop ends, never while it is paused, `report.json`), and a Stop or a lost provider pauses it
as the director's close decides. A close first waits for the git writes already queued (a worker's
merge, a save point); a completed close names a rewind or restart it came before. The wake loop
counts the pool's running workers and the run's running jobs for it (`open/active-work.ts`), and
`run.end` stays the teardown's, which removes no worktree.

The open Loop's turns, as every Loop's (see [What ends a Loop](#what-ends-a-loop)): a turn has no time
limit, and an outage is waited out on the Loop's clock. A turn that ends with nothing at work (no
worker's run, no running job: `hasWorkAtHand`) and nothing to wake
the lead for pauses the Loop for the person's next word; with something at work the lead rests until it ends, the person speaks or
asks to finish, or a rewind or restart it asked for has run at the turn's end (`NoteKind.AskDone`):
nothing asks it what next. The person's finish reaching a resting lead opens its last turn. A lead whose game
folder another chat's turn holds waits for it until it is free, outside the outage ladder
(`waitsForFolder`), never a failed turn; a Stop during the wait opens no session, and one before any
session of this attempt worked keeps nothing. `save_point {label, summary, shows?}` is Genex's checkpoint on the git-write
queue (the plugins' steps around the snapshot; their notes in the answer, their pictures the round's
thumbnails on the "lead" part (its `facet_iteration` record) and `integration_merge`; the host keeps them as the
observer's capture); a step's block is a note the save point keeps (the app saved nothing first,
say), steps Genex skipped while the person used the app leave a snapshot of the files on disk alone,
said in the answer (`APP_NEWS.notSavedFirst`), and Plan mode keeps nothing and says why. `shows` names the picture in
the folder that shows the change (a PNG or JPEG really inside it, read before the snapshot): it is
the round's `shown` picture, apart from the thumbnails; a save point without one is fine, and one naming no readable picture says why.
A web game's save point left with no picture from its steps or `shows` gets Genex's own: the page
loaded once with `genex-shot` in a pooled window, as the finish's health check loads it
(`pagePicture`, `loop/page-look.ts`), filed as the `default` camera's thumbnail. `pause {why}` is for what only the person
can do (a tool, editor or app the work needs is gone, an install, a permission): it sets
`OpenLoop.halted` to the lead's words, so the Loop closes paused with them as the reason once the
turn ends, and its acts are refused meanwhile, as below. `rewind {label}` and
`restart` (offered only when a plugin hooks `restore.*`) only note what the turn's end runs (a rewind
keeps the snapshot its label named when asked; a Stop leaves it unrun, and a line of Genex's tells the
resumed lead so, `settledAcrossPause`):
`LoopRun.afterTurn` (`open/between.ts`, which the wake loop awaits; a look at the app the turn started
settles first, and no look starts during it) first autosaves a turn that kept no save point (the
folder changed, or `onlyIfUnsaved` where a plugin saves the app; never while a writer in place works),
then restores the save point (`snapshot.restore`, then `waitReady`; Plan mode holds it even where no
plugin hooks `restore.*`) or fires `restore.before` and `restore.after` with no file changed, both
waiting while a writer in place works; what came of the rewind or the restart is a line that wakes
the lead (`NoteKind.AskDone`; a restart's with what its steps said, a hold at `restore.after` among
it), and the autosave's, with what its steps said, or why there was none, is one told with its next
message (`NoteKind.Folder`, which wakes no one). No judge plays between turns
(Loop phase 4); no judge plays the game for the lead. `finish` waits for that turn's
end and for a writer in place. The health
watch (`open/app-look.ts`, which `open/health.ts` passes on for an agent's kept modules) rides the
wake loop's rounds and a turn's, one look at a time beside them (never awaited): `health` every
`HEALTH_POLL_MS` when hooked, never while the Loop is paused or closes, its finish is checked or the
between-turns work runs; the start's own look, and the wait after the lead's `rewind` or `restart`
(whose line already says whether the app answers), are its baseline (`OpenLoop.appSeen`). It only informs, once per change: a block
is one line with the plugin's reason (a C++ build error names its file and line), `APP_NEWS.notAnswering`
as `NoteKind.AppCrashed`, which reaches a working lead at its next step, its turn never cut, and wakes
a resting one at once, counted in `OpenJournal.crashes` (`run_status`'s `crashes`); an answer a step
gave after that is `OPEN_NEWS.appAnswers` (`NoteKind.Folder`); a pending step, or a look the host
failed to ask, says nothing. Genex fires no `crash`, reopens, restarts or compiles nothing by itself,
takes the folder back only for the lead's `rewind` or the person's Rewind, and pauses no Loop:
`save_point`, `finish` and the turn's end go on as ever, and what to do about the app is the lead's
(its plugin's tools, `restart`, `rewind`, `pause`). A merge of a worker's copy whose turn on the
git-write queue comes once the Loop pauses or closes lands nothing. `OpenLoop.halted` is set by the
lead's `pause` alone: once the pause call has answered, the lead has 30 seconds to end its turn with
its words for the person (`PAUSE_END_MS`), then its session under way is aborted (`engine.abort {cwd,
lead}`, again each watch round until it ends, as after a Stop); a call of Genex's tools still
answering, the pause's own included, holds that off up to 2 minutes from the pause (`PAUSE_CALLS_MS`; an abort under a call made Claude Code answer the lead's own pause
"The user doesn't want to take this action right now", which the lead told the person as their
refusal; every session's context says such an answer is a cut-off, never the person's no), an outage wait ends at its next step, no session opens, and
`save_point`, `rewind`, `restart`, `finish`, `worker_start` and `worker_mark` are refused, as once the
Loop closes; the close is paused, and a Resume starts over. A look under way once the Loop begins to
close says nothing; the teardown waits for it a while (`settleRecovery`). A
closing Loop's lead hears no more news. What happens while a turn works reaches it at its next step,
as for every Loop ([what wakes a Loop's lead](#what-wakes-a-loops-lead)).

One Loop for every project. Run dispatch (`conductRun`) runs the Loop in place on any project and
any engine that keeps a session, which the host seats in place (`leadsInPlace`: Claude Code, Codex,
OpenCode, and a local model's session — Bonsai, OpenRouter, a local server — alike), and on one with
no session of its own (Ollama) closes at once saying it needs one (`RunnerKind.NeedsSession`). A
resume refused at its start stays paused and keeps its earlier report (`refusedRun` writes its close
over the latest one, keeping only what was built, `KEPT_ON_REFUSAL`: never how that session
stopped, its provider limit included). A journal the host can't read, or a game list it can't give,
refuses the run with words (a resume stays paused). A resume goes on by its journal
(`resumedRoute`): a Loop that worked in place (`director.open`) goes on in place whatever the folder
reads as now; a web game's Loop an earlier Genex paused in its integration worktree (`director`, no
`open`) is refused and stays paused, its words naming the git ref that holds its work
(`refs/studio/runs/<runId>/integration`, `OPEN_LOOP_REFUSAL.webLoopBefore`), which the chat's own
session reads in `run_status` and brings in when the person asks (its card says the work is kept in
git, as cards name no ref, and the chat offers no `resume_run` after it); any other journal (the classic pipeline's, the Unreal
runner's `kind: "unreal-lead"`) closes as it stood (`closingOlderBuild`). A Loop runs no
self-improvement pass, and Genex's `web.ready` gate reaches a game by its facts: a web game at its
root. The chat's launch words and its launch promise describe the lead building in place, workers in
copies and a reviewer checking its finish (`loop/open-loop-prompts.ts`). Through the real studio (`one-loop-projects.test.ts`), a Loop on the toy
plugin's project, and on a copy of that plugin with every tool renamed, runs the plugin's steps at its
moments, its worker type and its observer, and ends on the lead's claim with no seed change; a Loop
on a Godot folder with its plugin off runs with Genex's own tools, lends no window and writes no web file.

### Worker sessions

A worker's copy of the game (`snapshot.worktree`, `harness-rpc/snapshot.ts`) holds every file the
commit tracks. Each regular file the game folder still holds as committed is cloned from there
(`worktreeAt`, `substrate/snapshots.ts`: `cp -c` on macOS, an APFS clone that shares the blocks, a
reflink on Linux) and git writes the rest; git then records every file's stat and writes again any
clone that does not read as committed, so the copy is exactly the commit's. A large project's
content (an Unreal `Content/`) costs a copy neither the time of writing it again nor its disk;
Windows checks every file out. Of what it receives outside history, the files of the game's nested
repositories, it leaves out the game's ignore and `copySkip` rules (only the ignore rules when the copy versions those
repositories). A copy larger than `WRITER_COPY_MAX_BYTES` (2 GB, `substrate/snapshots.ts`) is
refused before anything is made (`SnapshotRefusal.CopyTooLarge`), with its size and largest
folders; every caller gets that answer, the director's integration and play copies included, in
words that fit each: the game is too large to copy, so the work belongs in the game folder.

### Workers in a chat

The chat's own session, answering a turn on an engine that keeps a session (a delegated agent, or a
local model's session: `hasSessionRoles`), may start workers. The harness
claims `workers` (`loop/main.ts`), opens a pool for the turn before its session starts and closes
it when the turn ends, failure and Stop included (`loop/workers/chat-workers.ts`
`withChatWorkers`). While the pool is open the turn's delegation carries `workers: { tools }`. The
host hands those tools only to the chat's own session answering that turn, only the six worker
tools, and never to a worker (depth one). Each call is forwarded as the `worker_tool` dispatch to
the pool of that turn; a call for any other turn starts nothing.

The pool (`loop/workers/pool.ts`, `pool-start.ts`, `pool-merge.ts`) runs as many workers at once
as the person's Settings allow (`preview.capacity` `workers`, the ceiling the host keeps per chat on
its workers, readers and writers alike), at most `MAX_WORKERS_AT_ONCE` (8): `worker_start`'s
description says the number, and a start past it is refused in its own answer, before anything is made. Every
engine that keeps a session carries a worker's seat and runs the same six worker tools, Bonsai,
OpenRouter and a local server too (local-session.ts honours the seat's mode, write roots and
never-touch list); only Ollama's tool loop, which keeps no session, opens no pool.

- `worker_start {title, task, isolation, type?, research?, inputs?}`: a reader (`read`) works in the
  game folder, read-only, with web search only when `research` is `yes`. A writer in a copy
  (`copy`) works in a copy made by `snapshot.worktree` after a game snapshot, under the copy
  rules and size cap above; a refused copy is answered by its code, pointing at `lock` or a
  reader. The one writer in place (`lock`) works in the game folder, one at a time per game across
  the chat's and its runs' pools: `locks.hold` takes the host's in-place lock and the game's
  plugin locks (answering their labels, written as the start record's `where`), never waiting, and
  `locks.release` at its end or the pool's close lets them go (an older host keeps one per pool). A
  `type` names a kind of worker a plugin that is on declares (`plugins.workerTypes`); it gives
  that kind's know-how (its brief's line) and its isolation, never a tool fence: every writing worker
  has every enabled plugin's tools and the connectors its lead has, an engine's editor included.
- Every worker's delegation carries the `worker` grant (`{id, title, turn, research}`), which the
  host honours by seating it in the chat's permission mode.
- `worker_status` and `worker_wait` (at most `MAX_WORKER_WAIT_S`) read each worker's line. A worker
  whose question waits in the chat (a pending `tool_permission` row naming it) shows as waiting for
  the person, and `worker_wait` wakes for it. An ended worker keeps its own last words
  (`WorkerRecord.report`, up to `WORKER_REPORT_CHARS`) and a copy the files its work changes
  (`changed`): `worker_status <id>` answers them in full, `worker_wait` answers them for each worker
  that ended while it waited, and the list of every worker names each by its report's first sentence.
- A worker's brief says its turn is its whole job: never ended to wait, never waiting by sleep or a
  background command. A Claude Code session's input stays open while its background tasks run
  (conversation lifecycle), so the turn a finished task wakes goes on as its own, and that turn's
  answer is a worker's delivery. A worker's session that a task woke after its input had ended
  anyway (a task that outran its hold; no tool call can be answered then) ends not ok, saying so,
  with its last words kept (`claude-code.ts` `wokeAfterEnd`); a lead's or the chat's session keeps
  its last result's verdict.
- `worker_steer` interrupts that worker alone (`engine.interrupt {cwd, worker}`) and resumes its
  session with the words in front; `worker_stop` aborts it alone (`engine.abort {cwd, worker}`),
  sent again while the host finds no session to stop (one still being seated), and a stopped
  worker takes no further leg.
- `worker_mark used` merges a copy's commit into the game folder with the director's merge
  (`mergeNoFf`, conflicts listed and the merge aborted); a clean merge names the pictures the work
  changed, for the lead to look at before building on them. Conflicts, and the lead's uncommitted
  files the work also changes, go back to the lead with their names; `rejected` drops the copy.
  A verdict stands once given, and a writer in place that finished and changed the game folder is
  in the game already (`WorkerRecord.changedGame`, from a fingerprint of the folder's working tree
  at its start and end through a throwaway index, `workers/game-change.ts`, both ends within the
  same time limit; the end record's `inGame`), so it is never marked rejected, nor is one whose
  change git couldn't tell: the chat and the graph never call work in the game unused. The
  fingerprint sees the folder, not who wrote it.
  Work that changes Claude Code's own folder (`.claude` at any depth, in any case,
  `workers/claude-folder.ts`) is never merged, as no build lands it in a game.

Plan holds writers: the host answers a `copy` or `lock` start (or one that names no isolation), and
`worker_mark used`, in a planning chat without dispatching it, so no snapshot, copy, delegation or
merge is made; a reader runs, read-only. When the turn ends, however it ends, running workers stop.
A copy's work is committed, kept on `refs/studio/chat/<thread>/workers/<id>` unless the lead marked
it, and its copy removed; a copy whose session is still writing is handed back once it ends. The
records persist in the chat's artifact `chat-workers`, so `worker_mark` in a later turn still
merges from the ref.

Every worker leaves records on the chat's log (`loop/workers/events.ts`): `worker_started` when it
starts and `worker_finished` when it ends (with `stopCode` when it stopped short, which the app
words itself) and again with the lead's verdict. A run's worker names its `runId`; a chat turn's
names its `turn` and the request (`ask`). The Builds graph draws them as a tree under the lead and
the chat gives each one line (`renderer/run-graph-workers.ts`, `chat/worker-lines.ts`); a director
builder that ends done with a commit of its own says `delivered`, and the run's clean
`integration_merge` of it reads as added on both. The next pool to open ends a worker an earlier
scope left without an end (its harness restarted, or its session outlived the close's wait).

### Workers in a run

A run's lead offers the same six worker tools; a director's `autopilot_started` says
`workerRecords: true`, so Builds draws its run as a tree from the start. The director (`loop/director/tool-specs.ts`) names
its wait `worker_wait` (`WorkerTool.Wait`; the handler still answers the old name `wait`, which a
kept playbook or journal may say) and adds `worker_mark`. A waking lead is offered `worker_wait`
too: it may go on with its own work, start more workers, wait explicitly (its wait ends for the
person's words, which its turn reads at its next step) or end its turn and be woken. `worker_start` never waits on the commit a worker forks from: it answers at
once, and the fork gate (`forkGate`) looks at that commit in the background before the worker's
session (`gatedRun`); a fork that does not run ends the worker naming the problems, its goal attempt
given back, its end waking the lead. A worker's or a job's end reaches the lead's turn under way at
its next step, as every Loop's ([what wakes a Loop's lead](#what-wakes-a-loops-lead)). Its `worker_start` takes `task` (a kept
prompt's `brief` is still read), `isolation` and `research`: `copy`, the default, is its builder in
its own worktree; `read` starts a reader from the run's shared pool (`loop/workers/run-pool.ts`,
`director-pool.ts`) in the game folder, which never integrates, and may research the web; `lock`
writes in the game folder itself. A loop worker's `minutes` are fitted to whole rounds of the game once a round has been
measured (`whole-rounds.ts` `wholeRoundsBudget`: the nearest number of rounds `tooLateToStart` will start,
at least one, within the run's time; the answer's `rounds` says how many), so no part-round at the end
goes unused. `worker_mark used` integrates the builder as
`integrate` does; `rejected` stops its news and `worker_wait`, and is refused for a
builder already integrated. A conflict worker's records name the work it fits in, in plain words
(`FIT_IN_WORDS`), with no summary of Genex's own. Every builder's
delegation, a conflict worker's included, carries `worker {id, title, runId}` (`director/workers.ts`,
and `facet/phases/build.ts` only when the facet loop runs for a director; a classic Autopilot's
builders carry none), so the host seats it in the mode of the chat the run was started in. A
builder that waits on the person (a pending `tool_permission` row naming it, read by
`loop/workers/questions.ts`) says so on its line (`waitingForPerson`); the person answers its card,
and no wake of the lead's carries the question. While the run's chat
plans, the host holds its lead's writer starts and `worker_mark used` as for the chat's own
session. The run's close stops its readers.

A run's pool keeps its records in the run's own artifact (`run-workers-<run>`) and a copy's work on
`refs/studio/runs/<run>/pool/<id>`; the run opens it at its start, a resumed run from that
artifact.

## Acceptance evidence

`npm run test:agentic-readiness` prepares two disposable local Git checkouts with shared
read-only-in-practice node_modules, then boots their fixture profiles plus a separate owned
sentinel. It exercises navigation/filter/model menu, Unicode/keyboard, Send to the chat's own session,
Stop's real pending AbortSignal, history buttons/graph, distinct game input/image, diagnostics,
identity failures, stale builds, preserved runtime self-edits, restart and cleanup isolation.
It writes `.studio-dev/evidence/accept-<time>/report.json` and selected artifacts. Read the
current report: required check statuses, not the existence of this command, establish support.
The runner never alters/prunes existing developer worktrees or stops the real main app.

`npm run verify` checks Node 24, then includes context, architecture, typecheck, all Node tests,
general Electron e2e, Build UI, Shapes and agentic readiness. It builds once before invoking
the three Electron runners that share `dist`; standalone `test:e2e`, `test:build-ui` and
`test:shapes:e2e` still build their own current output. Readiness keeps its separate immutable
builds because it tests isolation. Add packaged checks when that surface changes. The
source/document ownership areas in knowledge-map.json route changes to maintained topic docs.
`verify:context` checks links, documented commands, source ownership and Git artifact policy.
It is read-only and stores no per-edit fingerprints. Review prose against changed behavior
and summarize that review in the PR; a structural pass does not certify semantic accuracy.
The new conformance tests deliberately corrupt temporary inputs/imports/ownership/request
shapes and compile an incompatible canonical API method; they do not break app source.

Background interaction was checked initially on Electron 43.4.1: Unicode input and Send worked
unfocused; a delayed real Stop aborted its pending fixture session and produced a durable
turn end. A sent Stop during
the composer's short ignore guard is not evidence of cancellation. Capture content must still
be reviewed by the task's developer. Native IME, vendor authorization, every graph geometry,
and a real packaged-main plus development OS identity combination remain unverified.

Implementation references for debugger input: [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)
and [Chromium Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/). Runtime
acceptance on the pinned version, rather than current online API descriptions, defines coverage.

The app smoke suite now explicitly checks early Electron/session path isolation, forwarded
local-model host, and absence of the developer controller in ordinary builds. The shared
Node rig injects its scripted local provider before startup. Two existing asynchronous tests
now wait for the first turn's completion and rendezvous of parallel delegates respectively;
they retain the original assertions without a fixed overlap timing window. Fixture native
guards and missing game compositor bounds fail explicitly; interrupted transport responses
are tested as failures, never successful captures.

Finished base capture fixtures use the run-level `base/screenshots/default.jpg` path. Click
the card header for details: once a thumbnail has loaded, its center opens the image viewer.
Acceptance checks `naturalWidth` and completion of the saved image before recording success.
The automatic-animation selftest waits up to five seconds for an observed frame advance; it
never starts or steps the game to satisfy that assertion. The on-device speech selftest loads a
page and a cross-site frame that call the Web Speech members which used to kill a game renderer;
it is the real-Electron guard for `GAME_DISABLED_BLINK_FEATURES`, whose names Chromium would
ignore silently after an Electron upgrade. Packaged smoke also attempts a
developer launch flag in test mode and requires rejection before profile initialization.

Forge has an explicit exclusion for `.studio-dev`, `.claude`, `.codex`, `.agents` and agent
guidance. Git ignore rules alone do not exclude packaging inputs. Packaged smoke inspects
the actual asar file and fails if private development roots appear in it. This also prevents
packaging from racing active fixture writes or bundling local controller capabilities.

`npm run census` (`scripts/transcript-census.ts`) counts what the roles spend: per role, how many
sessions, how long the brief was, how many turns and how many tokens, and which tools were called.
It reads Claude Code's own transcripts under the studio's engine home and Codex's rollouts, and
normalises both onto the same numbers — Codex reports a running `total_token_usage` where Claude
reports per message, a Codex `node .studio/bridge/tool.mjs preview_ready` is counted as the same
tool as a Claude `mcp__studio__preview_ready`, and a turn is ONE MODEL RESPONSE on both sides: one
per deduplicated assistant `message.id` for Claude, and for Codex the run of response items
between two tool outputs, so a rollout of ninety tool calls does not read as one turn in the
column that holds a Claude session's ninety. It is read-only by construction: the only
writes are the two files `--json` and `--md` name, an output path inside the app directory or
either engine's home is refused ("refusing to write inside the studio's own data"), and no
transcript text reaches the output — counts, byte lengths, role labels and tool names only. A role
exists only when the sentence that identifies it is a real literal in the harness seed
(`tests/conformance/census.test.ts` asserts every one of them, so a reworded brief fails the suite
instead of quietly emptying a row); everything else is `other`, and the report says what share of
the corpus that is. The default run prints where it looked and what it found for each engine,
because this machine has no isolated Codex home and a silent zero is indistinguishable from a bug;
`--system-codex` is opt-in and keeps only the sessions the studio itself started: the ones that ran
in a game folder, and the ones that ran in a scratch folder the studio named under the temp root
(`studio-playtest-`, `studio-judge-` — a Codex read-only session and every judge call run there, in nobody's
game, and filtering on the game roots alone emptied those rows silently). What the filter drops is
said in the where-I-looked line, not swallowed. `--system-claude` does the same for `~/.claude`,
where a chat signed in with this Mac's own Claude Code writes the studio's transcripts beside the
owner's. Every request is priced at its own model's row of `evals/prices.json` and reported by
billing type (fresh input, cache write, cache read, output), with the share of cache writes at the
1-hour TTL, each role's largest single-request context (`peak input max`, what a long session
re-reads on every turn) and each tool's failed results (Claude marks them; Codex does not); a
request on a model the table has no price for is counted, never guessed. `--baseline <json>` adds
the change against an earlier run, cost included — run it before a diet and again after.

Milestone 4's own suites, all in `npm test`: `page-serve.test.ts` (where the studio's tags land in
a page it did not write), `page-shim.test.ts` (the clock, the seed, the merging facade, and the
game view's sandbox and disabled Blink features),
`attach.test.ts` (renderer discovery and the world choice), `capture.test.ts` and
`draw-counters.test.ts` (how a frame becomes a picture, and the counters at the graphics API),
`shapes-fixtures.test.ts` (the five checked-in games are what their manifests say they are),
`census.test.ts` and `engine-voice.test.ts` (every exported brief rendered once per engine: no
bridge command in a Claude render, no `mcp__` name in a Codex render). `npm run verify:architecture` now walks `src/page`
as well as `src/renderer` and `src/shared`, following the `/vendor/studio/*.js` specifier back to
the `src/page/*.ts` file it is built from, so the page world cannot reach main, preload or substrate either.

`node tests/e2e/run-preview-visibility.mjs` exercises real Electron windows with forced
capture failures: hidden/minimized windows remain hidden, failed evidence stays unavailable,
and parallel private previews retain input, capture and reload without show/focus/restore events.
A window nothing was loaded into (the stand-in of a game whose build failed is served no page)
refuses every script, capture and input call at once with its load error: Electron holds a
script until a load stops, and none is coming, so each call would wait out its whole deadline.
Reports include timestamped native events under `.studio-dev/evidence/preview-visibility`.
`STUDIO_PACKAGE_DIR="out/Genex-darwin-arm64" node tests/e2e/run-computer-smoke.mjs`
runs the scripted computer-tool and Loop checks against the packaged application.

`Options.skills` is a CONTEXT FILTER, not a sandbox. The studio's judge sessions run with
`skills: []` (`ClaudeCodeEngineOptions.skills.judge`, default `[]`): a bundled skill's frontmatter
is prompt weight a judge pays on every verdict, and it can only make two verdicts that should be
the same differ. For the same reason a judge runs with `tools: []`: refusing the built-in tools
(`disallowedTools`) still sent every one's definition on each verdict. Delegations send no `skills` key at all unless one is set, so a builder keeps the
CLI's own behaviour and a project skill still earns its keep.

## Build outcome reporting acceptance

Run `tests/conformance/run-summary.test.ts` with graph, build-progress, chat and director
conformance; `run-summary-feed.test.ts` covers incremental graph replies and shared live feeds. The sanitized village metadata fixture proves six integrations, three accepted and
one rejected evaluated attempts, stopped follow-ups, explicit replacements and final negative
visual evidence coexisting with structural passes. It is not a new gameplay-quality evaluation.
The build UI smoke additionally checks shared chat/graph totals, stopped follow-ups hanging
below the line, failed-question visibility and learning separation in Electron. Inspect screenshots for layout;
semantic assertions do not prove readability. `STUDIO_PACKAGE_DIR` may point both packaged
smoke runners at an isolated Forge output directory so verification does not overwrite the user's
running app bundle. Fixture checks need no paid assets, real CLIs or credentials.

Build actions regression: real Git showBuild requests overlap in director conformance; Electron
Build smoke overlaps two showBuild IPC requests with loadPreview, repeats Play, and checks
live work staying in view, Jump to now and graph cursors. run-steps tests own step folding,
merge-first state, gates and layout. No production game is used as a fixture.

The Build UI smoke also controls pending/failing bootstrap and selected-thread IPC reads to
assert the startup loader, no premature Ready or empty games, explicit errors, and successful Retry.
Smoke read gates are unset in ordinary sessions and only consulted by fixture smoke handlers.
Injected read failures persist until the test explicitly retries: development React's StrictMode
replays mount effects, so a one-shot rejection can be consumed by a disposed effect and hide the
intended error. Keep StrictMode and all loading/error assertions enabled. Only watch and owned
`--dev-build` builds bundle development React; `npm run build` (so `npm start`) bundles production
React, and package/make/publish add `--release` (minified, no eager three.js, 6 MB dev / 3 MB
release static-graph budgets), as `renderer-build.test.ts` pins. Packaged smoke checks the bundle
report.

Owned fixture snapshots expose Profiler counters. Diagnostics add IPC/push totals, startup marks,
GPU/process status and loop delay; normal launches require `--studio-diagnostics` for counters.
`studio:performance.mark` accepts fixed journey names. Compare build-graph, large-build-graph
(1,000 steps/five workers), chat-history and game-surface traces. macOS evidence does not certify
Windows/Linux.


### Goal completion and worker approvals

#### What ends a Loop

A Loop has no clock of Genex's own, one rule for every Loop (`director/wake.ts`, `wake-schedule.ts`
`afterTurn`): no time limit of Genex's ends a turn, wakes the lead or closes the run, and a lead's turn
is delegated with no `timeoutMs`. Only a time the person asked for counts (below). The lead's `finish` ends it. A lead turn that ends with nothing at work
(no worker's run, no running job of the run: `hasWorkAtHand`) and
nothing to wake it for pauses it, as a bare agent's turn ends and waits for the person: their next
word that asks for more of its goal goes on with it (`director.ts` `closeLeftOpen`; the
chat's own session holds `resume_run`). Its last message is the summary, with no wrap-up turn after
it, and the pause says so ("the lead's turn ended with nothing at work"). With
workers or jobs at work the lead rests, and Genex wakes it when one ends. The run's jobs are read at
once after each turn, then every 5 seconds (`activeWork`); a read the host could not answer counts as
work, so only one that says no job runs pauses the Loop, and a job's end is read again at once before
it does, so none is missed. The person's Finish, and a
failed turn, give the lead its one wrap-up turn at once, opened with Genex's one line
(`LOOP_WORDS.finishAsked`, or `turnFailed` with the failure: the Loop closes when this turn ends;
`WRAP_UP_SPEC` holds the stop/finish rule), and the Loop closes after it. The person's Stop ends
it at once (paused, for a Resume). A lead's rate limit, an outage past the ladder, a lost sign-in and
the lead's `pause` pause it; the host's auto-resume resumes a limit's pause at its reset, every time
([automatic resume](#automatic-resume)). A Loop an
earlier seed paused resumes with no clock: its journal's `director.clock`, its run's old hours ceiling
and a wrap-up begun at its old working deadline are read by nothing.

A time the person asked for ("work 3h on that") is the one exception (`loop/work-time.ts`,
`director/work-time.ts`). The chat's session names it as `hours`/`minutes` on `start_autopilot` or
`resume_run`, only from the person's words, and the run's budgets carry it (`workMinutes`,
`workFromMs`, `completionPolicy: "duration"`). It counts the run's worked time: its earlier sessions
(the journal's `director.worked`) and this one on the Loop's clock, so a pause or a closed app adds
nothing, and a resume's new time counts from where the run stands. The lead's first message says the
time and what is left, as does a fresh session's when the old one is lost; a resume drops the time
lines of the session before it. Before it is worked, the lead's `finish` is refused with what is left
(`WORK_WORDS.tooSoon`), and a turn that ends with nothing at work wakes the lead to go on
(`NoteKind.WorkTime`) instead of pausing, until two such wakes in a row leave the game folder as it was (its
commit's tree and what is uncommitted) and start no worker (`MAX_IDLE_KEEPS`; a refused `finish` or a
save point of an unchanged folder is no work): then it pauses as above. Only the person ends it sooner (Finish, Stop,
the lead's `wrap_up` for them), or the lead's `pause`; a failed turn's wrap-up may still claim the goal. Once the time is up, a lead at work is told at
its next step, a resting one at once, and its next turn is the wrap-up (`WrapCause.Time`); a close
tells the lead how long the Loop worked for its summary (`WORK_WORDS.worked`). A resume with no new
time after the time was worked goes on with none (`settleWorkAsk`). Before, a lead that closed on its
own word ran 2 h 20 min of three hours asked, three times, and said it had run "the 3-hour loop". The run's own clock (`loop-run.ts`
`keepRunClock`, `runNow`) stays injectable for what reads the time outside the wake loop (`wrap_up`
stamps the person's ask with it).

#### What wakes a Loop's lead

One channel, for every Loop (`director/news.ts`): the person's messages on the lead's line, as they
wrote them, and Genex's own lines of the run's log, each one fact typed by `NoteKind` (a worker or a
job that ended, a worker's with what the plugins' steps said at its end; the project's app that
stopped answering, in its plugin's words, or answers again; what the plugins' steps found as a lead's
turn starts (`turn.start`), which that turn's message carries; a rewind or restart the lead asked for
that ran; what Genex did with the folder). A worker's line is `worker w1 "Sky" ended: done.`, a job's
`job j1 "Light bake" (… started by you) failed (exit 3) after 4 min.`: what ended and how, no
instruction after it. The lead's first message is Genex's line that the Loop started, with its goal
as the chat's session wrote it into `start_autopilot`, and a line per thing its start found (a note
or block the plugins gave at `run.prepare`, what `web.ready` found, the app's look), `from: genex`:
the chat's session already holds the person's words, and Genex's context is its system text. A resting lead is woken by the person's message at once — the leading unheard messages of one sender joined as written, pictures as
image blocks, `from: person`, Genex's untold lines beside them as a notice — or, with no message
waiting, by Genex's untold lines alone, `from: genex`: an app that stopped at once, a worker's or a
job's end `WAKE_DEBOUNCE_MS` after the first of them, a folder line never (`wake-schedule.ts`
`nextWake`). No hourly cap, no digest, no reasons record: the lead calls `run_status` for where the
run stands. While a turn works, one watch (`watchTurn`) says each new line into it (`engine.steer`,
`interrupt: false`, `from: genex`) and hands it each message the person sends as written. When the
turn may be cut (a session to resume, its first turn included, outside a tool call, not the wrap-up)
the person's message cuts it at its next step on every engine (`interrupt`, `native: false`), and
the same session goes on with it as its own turn: read mid-turn beside a tool's result, a Claude
Code lead could build on past it with no word back. A turn the person's words open carries Genex's
line that they wait in the chat for its answer, said last before their words (`LOOP_WORDS.personWaits`):
deep in a Loop, a lead that read their question still built on without a word to them. Otherwise it is read mid-turn, as a message
Genex wrote in the chat is, which cuts only an engine that takes no input mid-turn. The lines its
own message carries, and a line or a message the session took, count as heard while it works, and
what it never read (`DelegateResult.steered`) is told again with its next message. A line it did not take (no session takes input yet: the call waits
for the folder, or out an outage) goes in again with the next one, before it. A turn the
person's words cut short resumes at once with those words, and Genex's own lines of a message no turn
worked on (its start, its wrap-up) go beside them. What the lead heard is kept in two places only:
the line, which records each message heard (`run_steering_delivered` how `lead`) and gives the chat
back its own messages never heard when the run ends, and the run's `waitSeq`, which the journal keeps
(a Resume tells what is past it). The person's notes about a build (a reply to a build, main's
`runFeedback`) reach the run's inbox and no queue, so the watch hands each to the line once as it
comes, and one never heard stays with the run for its Resume; a resumed run's line is handed the
messages its lead took and never heard before the app quit. A steer a `run_steering_delivered`
names (by its id, or by the chat message it came from) is never handed again, an older seed's
hand-over record included. A fresh session for a lost one is asked the turn's own message, with
Genex's line that the earlier session was lost (`LEAD_FRESH_START`) and how the Loop began beside it, and the chat so far for a session new to the
chat (`freshChat`).

#### Claims, the person's finish and worker approvals

A claim (`finish` with its `summary`) may come whenever the goal is reached and closes the Loop on the lead's
word (Loop phase 4); with `review=yes` a reviewer reads it first (`open/finish.ts`): a yes closes it as reviewed, while a no, no answer, no time or no reviewer to seat
goes back to the lead and decides nothing (no row of no's closes a run). No judge's word turns a
claim back. However a run ends — the lead's `finish`, a turn with nothing at work, the user's Finish
— the close asks no judge and lands nothing: it closes in the game folder (`open/close.ts`), keeping
the last work in Genex's checkpoint.

The user asks to finish in the chat, and only the lead can tell such an ask from a question:
`wrap_up`'s own description, the one place the rule is said, makes an ask to stop or finish the
build `wrap_up` first. `wrap_up` (`director/wrap-up.ts`) records the ask quoting the user's words
(`userQuoted`, checked against the run inbox's steers) as the same `run_control` finish the app's
own door writes, once. From then
`worker_start` is refused (a conflict worker excepted), each running loop worker ends the round it
is in and stops at its next round's gate (`workers.ts` `workerStopAsk`: the user's ask, never the
director's stop), and the
lead rests while those rounds land, woken as each ends (`afterTurn` `lastRoundsRunning`); once no
loop worker runs the wrap-up starts (`WrapCause.Finish`), and its finish stops a single session. Its
own ask is no news to it. A finish the user asked for claims nothing (no reviewer checks it, so the
wrap-up invites no claim). A `finish` after it stops everything at once. A Loop starts no worker
once anybody asked to finish; its wrap-up starts when the turn that recorded the ask ends.

An ask to stop and start a new Loop is `wrap_up` with `next_goal`:
the new Loop rides on the same `run_control` record (`next-loop-record.ts`), and once the run has
closed `handleRunStart` starts it on the same game with the run's engine, model and roles, as a
launch from the chat would (`next-loop.ts`); a Stop pressed since starts nothing. Outside a run, the
chat's own turn holds the Loop's start on the person's words (`loop/start-autopilot.ts`,
`delegated-turn.ts` `launches`), after a run it led too, finished or paused. Its description says what
a build is, work toward the goal the person set, and when one starts: as the agent sets to making a
game or a change of many steps the person asked for, instead of doing that work in its reply. A build
does only what was asked, at the stage the project is in (packaging, publishing or a finished game
only when asked), and a question, a look, a choice the person makes or a quick fix needs none. A
paused build is gone on with (`resume_run`) for more of its goal, and a new one starts only when
needed (the last one finished, or the person starts over). The lead's first line says its goal is
all of the Loop's work (`director/wake-prompts.ts`). The agent decides, and every Loop it starts goes until its lead finishes it, paused
whenever a turn ends with nothing at work.

Worker plugin approvals are recorded in the run owner's conversation, resolved from host
call attribution and persisted run starts. The original worker remains the cancellation
scope. Ambiguous or mismatched run ownership is never guessed from a project name.
Genex takes no ownership locks any more; the records an older build's locks left (beside the
Codex engine home, never inside it, where a folder would read as a sign-in, or legacy in-game
markers) are released before a session starts in that folder, with hostile-path checks.
The first independently verified milestone and latest checkpoint are retained in the journal
and report, with immutable Git refs so later integration and cleanup cannot discard them. A one-time 30-minute review reports verified outcomes and blockers without ending
healthy work. Existing Show build and safe
landing operations can recover the saved commit;
Stop does not overwrite the game folder.

Wake payloads report their estimated token size against an 8k budget, excluding user messages,
attachments and provider-managed history. Unchanged build cards and routine goal-plan
replacements are not repeated. Host-call and director-tool durations use a monotonic clock;
local timing history is bounded, survives Resume and records any omitted spans. Monotonic clock
origins keep within-process wall-clock corrections out of elapsed unions. Concurrent work totals are
separate from wall-time union; neither is a measured model-speed improvement.

### A lost provider

A provider that stops answering is no verdict on anybody's work: the run pauses rather than wrap
up and land a build nobody could check. The engines call a revoked or disabled access a sign-in
failure (`auth`): Claude Code from the CLI's own error code on the reply (`authentication_failed`,
`oauth_org_not_allowed`, `account_on_hold`, `billing_error`) or the access words both engines share
(`engines/common.ts` `isAccessLost`), also when the result's subtype says success. A lead turn a lost provider ended — a sign-in, a limit,
an outage the patience ladder could not outlast, a 529 or an unreachable network (`ENOTFOUND`) the session returned included — pauses the
run (`afterTurn`'s `providerLost`, `state.limit`): no wrap-up, the workers stopped, nothing landed
or judged (`NotLandedReason.Paused`), `run_finished.limit` naming its kind, and no learning pass
until the run ends. A sign-in, cap or reset-naming limit opens that engine's circuit for the run
(`loop/provider-loss.ts`): judge, critic and ship-review calls to it fail at once with its kind
until the run starts again or the limit resets (ten minutes at most for a loss that names no end),
and a sign-in any engine of the run lost pauses the run at the lead's next turn or wake. A worker
round the provider failed (`facet/provider.ts`) is recorded as `facet_provider_outage` with
`lost`, never judged, struck or rolled back: its build or
verification waits for the provider and runs again, a run's stop keeps it on its `…-stopped` ref,
and a usage cap still stops the worker with its limit for the lead. A worker the provider ended before
any round of it was judged gives its goal attempt back (`attempt-refund.ts` `refundProviderAttempt`), so a
restart is never refused for progress it never had the chance to make.

### A workers' engine that cannot run its sandbox

A worker always runs its commands in a sandbox, never without it: Claude Code's worker box keeps
`failIfUnavailable: true`, because its sandboxed commands run unasked and the CLI itself is not inside
ProcessSandbox. On Windows, where Claude Code's own sandbox cannot start, a worker (and an unattended
builder) runs its commands in Genex's instead: the session gets no box of Claude Code's and none of
its process-starting built-ins (`Bash`, `PowerShell`, `Monitor`, `REPL`: an allowlist), and runs each
command through the studio's `run_command` in a `ProcessSandbox` made for the session on its first
command (`engines/claude-code.ts` `studioShell`, `engines/session-commands.ts`). That box is the one
Claude Code's would have been: the worker's roots (in Bypass the home folder too), the sign-in homes
and the never-touch list denied, no network. The host reads the tool as `Bash` (its question card,
the never-touch screen, the log). Its commands run under Git Bash, one at a time, nothing in the
background, and a saved "always allow" rule for `Bash` does not cover them. A chat's session runs
its commands in Bash on a turn the person answers and through `run_command` on an unattended one;
the turn's tool list is what says which shell it has. Where a CLI still refuses
its box, it refuses the session before the model says anything, and the engine reports it
as `StopReason.SandboxUnavailable` with the CLI's own words (`engines/claude-code.ts`
`sandboxRefusal`); a session that already replied keeps its ordinary failure. The refusal holds that
engine for an hour across every pool and Loop of the harness (`loop/workers/sandbox-refusal.ts`): a
director's builder facet stops on its first build (`StopCode.SandboxUnavailable`: no judge, strike,
outage wait or rollback, its goal attempt given back), a pool worker ends with
`WorkerStopCode.SandboxUnavailable`, and every later `worker_start` on that engine starts nothing and
tells the lead to do the work itself, naming the other workers' engine when the host reports it
signed in. A Loop's person is told once on a decision card, with that engine offered for Workers.

### Automatic resume

A paused build is the user's to resume, with three exceptions the host takes itself
(`main/core/auto-resume.ts`) while Settings → Harness **Resume builds automatically** is on (the
default). A director run closed on an engine limit (`run_finished.limit`: `rate_limit` or
`usage_limit` with `retryAfterMs`, counted from `limit.at` when the close has it) resumes two
minutes after the limit resets. Both engines read that wait from the limit's own text
(`engines/limit-reset.ts`: Claude Code's "resets 9:50pm", Codex's "try again in 1 hour 30
minutes" or "try again at 3:45 PM"); a limit that names no reset is the user's to resume. One a
provider outage paused (`unavailable`) is tried again 15 minutes after it (`provider-outage`). One
paused on a lost sign-in (`auth`) is the user's to fix and resume (`access-lost`). A run the loop's
crash paused (the host saw the harness exit with it open, `onHarnessDied`, and the reborn loop's
close came after) resumes once the harness is ready. The pure planner `autoResumePlan` reads typed
fields only, never a close's words. A resume goes through the Resume button's own
`resumeAutopilot`, after a host-only `run_auto_resumed` (`cause`, `attempt`) that bounds it. A limit
resets on its own, so its pause is resumed at every reset; none other happens after `AUTO_RESUMES_MAX`
(2) automatic resumes of the run for a crash or an outage. None happens after the user's Stop (in that
chat, or of the run through `studio:run.stop`, `StudioCore.stopRun`) or a Finish since the run last
started, once a newer run started in that chat or another run is running (`superseded`), for a
reset more than 12 hours away, or after ten minutes past its time without a ready harness or 1 GB
of free memory (read only once the resume is due). While a resume waits, main holds the Mac awake
with its own blocker (`onAutoResumePending`, apart from the run-active `keepAwake`), and a quit or a
relaunch into an update names the planned time and asks first (`quitQuestion`), since either drops
it. The wait is a chain of timers of at most `AUTO_RESUME_RECHECK_MAX_MS` (5 min), each planned again
against the wall clock, because a Node timer does not count the time a closed lid sleeps. The switch
applies to pauses after it is turned on. A user Resume cancels the planned one. Activity lists `run_auto_resumed` beside the run (`ActivityIndex`
keeps every record with an item reader). A cold start (the app itself quit or died)
and a crash loop the watchdog rewound stay the user's click (`recovery.ts` `closeInterruptedRun`).

## Provider model defaults

Unset model roles defer to the selected coding CLI under Genex settings. An explicit main-model
pick fills unset roles with that same request ID; there is no version-specific planner/worker
split. Persisted role selections and user-edited harness files remain authoritative. Catalog
discovery belongs to the host; the seed never maintains a list of available provider models.
