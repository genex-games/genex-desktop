# Harness runtime guide

Read this when changing the in-app game-building harness. External developer memory is
owned by [AGENTS.md](../AGENTS.md); this page describes product behavior.

What the harness may assume of any served page (studio-ultra M4). Every page the studio serves
carries the studio's own shim before the game's first line, so `window.__studio` answers on a game
that never heard of the contract, the studio owns the clock, `seed(n)` is reproducible, draw calls
are counted at the graphics API, and readiness is a fact the page reports rather than a wait. That
holds for any Three.js game of any shape — inline, ES modules with an import map, a Vite bundle
(which adds the two-line `installStudio({ renderer, player })` and nothing else), WebGL or WebGPU.
It does not hold for Phaser, plain canvas 2D or an engine export: those are out of scope, and a
folder whose kind is `engine-export` can be played and photographed but can never start a run.

The kind of game (`loop/kinds.ts`). Eight kinds — first-person, third-person, top-down, side-2d,
racing, flight, static-board, free-camera. Each names the traits it implies, the state axes its
look and move probes read, the eye cameras it wants, its critic and its play script. Every trait is
OFF until the planner, the director or `studio.json`'s nested `game` block declares it, so a game
nobody described carries no harness input check at all; a declared kind supplies its traits and an
explicit boolean beside it wins. The harness drives that kind's play script before every
judgement (racing and flight then hold W/ArrowUp through the rest of the drive, `cruise`, steered by
the game's racing line when it has one and released before the cameras; a declared script holds
nothing; a front-end kept for its owner, `begin:false`, is pressed by nothing, not even a declared
script), and `gameLine(run.game)` is the first line of
every judge call (for a kept front-end it says nothing was pressed and `[dead-input]` does not apply). A game with a title and no `__studio.begin()` may declare `start.keys`. Two critics, not one:
`place` for a world a player walks through and `screen` for a board, a puzzle or a builder.

Malformed facet ballots hold the current build and report an unmeasured comparison. A
faceted vote needs all four explicit A/B/tie answers; an invalid legacy facet pick cannot
declare satisfaction or contribute observed defects. Genuine ties retain their existing rules.
A judge reply with no JSON is asked again, twice at most; one that stays garbled is `unusable`
(a tie pick and no `biggest_gap`), which no caller may read as a tie, a defect or a failure: the
autopilot's global judge then closes the run `judge-down` with the build kept unjudged.
Every A/B verdict (`blindCompare`, `facetCompare`, `tasteVeto`) carries `judged`
(`loop/judge-provenance.ts`): the system prompt's SHA-256, `parse` valid or invalid, the
challenger's placement (`challenger-a` or `challenger-b`, from an injectable `random` shuffle), the
engine, the requested and served model, and whether it fell back. It also carries `judgeCall`,
the call's audit: the model that answered, a SHA-256 of the whole ask (rubric and evidence), the
reply's first 4,000 characters, usage, the image count and how many asks it took. An unusable
answer or an unreadable ballot is `invalid`: not a tie, no defects, and the incumbent is kept.
An evaluation profile may pin the judge with `judge/pin.json` in the harness workspace
(`{engine?, model?, fallback?}`); a missing, invalid, oversized or symlinked pin is no pin, and
`"fallback": false` forbids moving a throttled judge to its fallback engine. Each direct model call is recorded by the host as `completion_call`
with the caller's role (judge, playtester or SkillOpt gate). An autopilot close carries its
`stopCode`, including `base-failed`, `not-judgeable`, `no-improvement` and `reference-unbeaten`
(the landing-conflict and integration-stage Stop closes keep only their sentence); a kept older `outcomes.ts` leaves only the sentence. The [evals](evals.md)
read these signals.

Where learning goes. Four places, and they are not interchangeable: a check earned into
`library/checks.json` (five technical checks ship; a planner's check earns its place by being
used), a craft recipe in `library/recipes` (opinions about how a thing should look — retrieved
when a check fails or a judge names the defect, never imposed), a skill file (how an agent works),
and a prompt (what a role is). `library/games/<game>.jsonl` and `.md` hold what a run learned
about one game and belong to the harness workspace, never the user's repository.

What the loop's code is. The seed is TypeScript that Node runs by stripping its types — under
Electron's own Node (`ELECTRON_RUN_AS_NODE`) in the app, with no build step — so it uses
erasable syntax only (no `enum`, `namespace` or parameter properties) and imports its siblings
by their `.ts` names. It is type-checked as its own project (`src/harness-seed/tsconfig.json`,
strict; `npm run typecheck` runs it through `tsconfig.harness.json`). The host calls it may make
are typed in `types/host-api.d.ts` and named in `loop/host-methods.ts` (`HostMethod`), both
generated from `src/shared/harness-api.ts` by `scripts/gen-harness-types.ts` (the build writes
fresh copies into the seed it ships, and `harness-types.test.ts` holds the committed copies to
the contract); the ctx a loop function is
handed is `types/harness.d.ts`. The game page's own verbs that `preview.call` names, and the
words `game.validate` and `game.attached` use for a game's studio contract, are spelled once in
`loop/page-contract.ts` (`PageMethod`, `StudioContract`, `AttachedContract`). The bootstrap imports `loop/main.ts`, and a workspace from
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
The architect's fork (`SelfImprovementService.runArchitectJob`) uses the same fork, type check and
boot, plus the loop self-test.

How the loop's code is laid out. The modes keep their own control flow — `director.ts` (the
run, with its parts under `loop/director/`: `setup.ts` builds the run as one explicit object,
`workers.ts`, `tools.ts`, `integrate.ts`, `loop-run.ts` for the run's shared functions, `rules.ts`
for what needs no run, the wake loop that drives the lead's session — `wake.ts` (its turns),
`wake-schedule.ts` (when it is woken, a pure leaf) and `wake-prompts.ts` (what it is told) — and
the full journal — `journal.ts` (the run's record every save writes to the run journal, the
clock a Resume keeps, and what a resumed run reads back) and `journal-prompts.ts` (the resumed
lead's first digest) — and one session — `lead-session.ts` (whose session the lead is, and the
chat's bookmark), `lead-session-prompts.ts` (the chat's own session as lead, building in the integration worktree) and `conflict-worker.ts`
(the worker a merge conflict goes to) — and a finished build reopened — `reopen.ts` (the journal
the chat rewrites, where the run forks) and `reopen-prompts.ts` (its words) — the parts never import `director.ts`, which re-exports it), `autopilot.ts` (a run is a list of named phases, `PIPELINE_PHASES`, over one `pipeline`
object), `facet-loop.ts` (a round is a list of named phases, `ROUND_PHASES`, over the facet's
state and the round's; the phases are `loop/facet/phases/*.ts`, beside the facet's `state.ts`,
`policy.ts`, `scoring.ts`, `round.ts` and `round-judgement.ts`, what a judged round may claim: a
rung already built or set aside, a regression a second look reproduces, a gap a judge named),
`gauntlet.ts` (`ITERATION_PHASES`) and `spike.ts` — and share
primitives instead of copies of them: `git.ts` builds and runs every git command line (a
conformance test finds no other), `evidence.ts` is the evidence pass (named phases too, inside
the `finally` that hands the game back running) with its one failure classifier and the window
leases, `build-turn.ts` is one
build turn on either kind of engine, `config.ts` holds the shared waits and the light effort a
bounded ask runs at (always "low", whatever role effort the user set), `outcomes.ts` gives every stop a
code beside its sentence (`stopCode`; the classic pipeline decides which facets died early on the
code) and the director's worker states, `run-events.ts` writes a run's events and journal and
logs a failed write to the harness's stderr, at most once a minute per kind, instead of dropping
it, and `prompts-build.ts` holds the briefs two modes build. A seed upgrade keeps a file the
agent edited, so a module that code moved out of still exports every name it had
(`tests/fixtures/seed-exports-2e-pre.json`), a kept older file keeps loading against the new
siblings, and a name an existing module newly needs comes from a new module, never from another
existing one that the agent may have kept at an older vintage (the wake loop's, the journal's,
live chat's, one session's, the after-run chat's, the reopen's and goal-directed generation's
vintages are `seed-exports-pre-wake.json`, `seed-exports-pre-journal.json`,
`seed-exports-pre-live.json`, `seed-exports-pre-one-session.json`,
`seed-exports-pre-after-loop-run.json`, `seed-exports-pre-reopen.json`,
`seed-exports-pre-goals.json`, the Unreal lead's `seed-exports-pre-lead.json` and the open harness's
`seed-exports-pre-open-harness.json`; the goals' and the lead's are kept
one module at a time, the lead's with each module's own imports as they were, so a retired module a
kept caller still imports stays as a shim: `loop/unreal/live.ts`, `live-journal.ts`). Where a kept older
part would contradict a newer one, the loop asks before it relies on it: a waking run seats its
chat's session as its lead only when every part that lead depends on exports
`SERVES_LEAD` (`director.ts` `seatsLead`), and otherwise a director with its own hands leads, as
before; the chat after that lead's run goes to the same session only when its runner, turn and
brief (`turn-loop.ts`, `delegated-turn.ts`, `chat-session.ts`) export `SERVES_AFTER_LOOP_RUN`
(`chat-dispatch.ts` `ownSessionAfterLoopRun`), and otherwise to the coordinator; and a Loop message
after a finished build reopens the same run only when the parts that answer it export
`SERVES_REOPEN` — the session's runner, turn, note and start (`turn-loop.ts`, `delegated-turn.ts`,
`after-loop-run-prompts.ts`, `run-dispatch.ts`; `chat-dispatch.ts` `ownSessionReopens`), or the
coordinator, its prompt and the start (`coordinator.ts`, `coordinator-prompts.ts`,
`run-dispatch.ts`; `coordinatorReopens`) — and is otherwise answered as with Loop off. The run's
own parts need no such mark for a reopen: the chat rewrites the journal
(`director/reopen.ts` `reopenedJournal`) without the clock and wake state, which every vintage of
`setup.ts`, `wake.ts` and `journal.ts` reads as a new run's. An edit the agent made to a moved
function in a kept file still serves that file's own callers; the rest of the loop uses the new
home. The upgrade does not hold the callers back (that would freeze every shipped fix to them for
as long as the file stays edited); it says so instead. `SEED_MOVES` in `substrate/seed-upgrade.ts`
lists what moved where, and `applySeed` reports a kept file that still defines moved code which
other files now import from the new home (`moved`: names, new home, callers). The
`seed_upgraded` chat card and Studio activity name it, and every boot keeps one note per such
file in the agent's memory (`RecoveryService.noteSeedMoves`), taken back once the kept file no
longer defines the moved code. A host call whose shape changed works the same way:
`SEED_CALL_CHANGES` names the files whose copies must carry it (`plugins.invoke`'s `step: true` in
`loop/delegated-turn.ts`), `applySeed` reports a kept copy without it (`outdatedCalls`), and the
boot notes it in the agent's memory until the copy carries it. A renamed name or module
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
checked. A kept copy of any of these from before is in `SEED_CALL_CHANGES`. Its `plugins_find` and `plugins_suggest`
(`tools/plugin-finder.ts`) call `plugins.find` and `plugins.suggest`; a shown card ends the turn
([plugins](plugins.md#finding-and-suggesting-a-plugin)).

A builder's brief is written from the game's facts (`buildContractorBrief`'s `facts`; an older
caller that names only the engine keeps the engine's rules). Every brief opens with Genex's
identity (`appIdentity`, `loop/project-prompts.ts`) from the game's facts: the chat's, a local
turn's, the director's, the Unreal lead's, and every worker's (the pool's, the director's single,
conflict, base and facet builders, the Unreal lead's typed workers; `loop/workers/identity.ts`). A
classic Autopilot's builders keep their own brief. A folder with no
kind yet is told to start web with `start_web_game` or find a plugin with `plugins_find` (a folder of
notes is told to read them first); with an engine plugin's kind on offer (`plugins.tools`'s
`kinds`) every fresh brief until it has a kind asks with the question card, and a brief without the
card (a local turn's too) names each kind's tool for a request that names that engine. A folder of its own files of a kind no
rule knows is told to look through them first. Each kind gets its own rules, named by folder when
there are several. A kind no plugin covers (Godot, Unity, Blender, an Unreal plugin, an Unreal project
with the plugin off, an unknown one) calls `plugins_find` first, shows the card with
`plugins_suggest` and ends its reply, offers to write a plugin when none fits, and goes on with its
files and the shell only on the person's word (`pluginFirstRule`). An Unreal project the game is not
linked to is never worked on through the Unreal tools: they reach the Unreal panel's project until
`use-project` links it. A local turn's
operating rules are split: `prompts/operating-rules.md` for every turn and
`prompts/operating-rules-web.md` only for a web game; a kept agent-edited `operating-rules.md` from
before the split still carries the web rules, so a web game then reads them twice; it, a kept
`loop/prompt.ts` that reads no `operating-rules-web.md` and a kept `loop/chat-session.ts` that never
names `start_web_game` are in `SEED_CALL_CHANGES`.

Scheduled for removal: the long turn (`directorLoop: "turn"`, `STUDIO_DIRECTOR_LOOP=turn`, its
`worker_wait` tool, continuation prompts and `.studio/DIRECTOR.md` memory), the way back from the wake
loop. Its gate is the first release that ships the lead as the chat's own session and the chat
after its run. A later PR deletes it once that release's own build has passed, live
(L5, with the owner's permission), on Claude Code and on Codex each: a waking run led by the
chat's own session is stopped with Stop, resumed from the chat, and after its close answers a
question and makes a change in the same session — no run on the long turn, no coordinator
session. The removal PR's validation summary records, per engine, the build, profile and provider
identity and each step's outcome; the raw thread log and journal stay in
`.studio-dev/evidence/after-run-gate/<engine>/`.

Not removed at that gate: the run's coordinator (`loop/coordinator.ts`, `coordinator-prompts.ts`,
the host's `coordinator` delegation and `continue_build`) and the `SERVES_LEAD` and
`SERVES_AFTER_LOOP_RUN` checks. The coordinator answers after every classic-pipeline run — on a model
without sessions it is the only answerer there is (its tool rounds, `answerWithTools`) — after a
run of a kept older seed whose parts lack those marks or of a lead that was a session of its own,
and a message on another engine than the lead's
([the coordinator, a fallback](conversation-coordinator.md#the-coordinator-a-fallback)). With Loop
on after a finished build whose journal seated a lead, a coordinator that answers in a session is
told so (`coordinatorReopenRules`), and its `continue_build` reopens that same run for the Loop's
time on the build's own models once the reply ends (`reopen-run.ts` `finishedLoopRun`), instead of
one builder turn. A finished build no Loop can go on from — no lead seated (the long turn, a kept
pre-lead director, the classic pipeline, a gauntlet), a coordinator without sessions, a kept older
part — is answered as with Loop off, and the chat says so once per build while the loop lives
(`firstLoopUnused`). A game built in Unreal is never reopened (its Unreal Loop's journal is the
lead's own, `kind: "unreal-lead"`, not a director's, which is all `finishedLoopRun` reopens): a Loop
message the person sends after its finished run is answered as before any run, so the chat's
session may launch the next Unreal Loop, which builds on what the game holds
(`chat-dispatch.ts` `startsNextUnrealLoop`). Not solved, by the owner's decision: a chat whose
build ran on the classic pipeline or a gauntlet (as on a local model without sessions) has no way
to start another timed build in it since "Start a new build" was removed. Nothing replaces the
coordinator for the cases it answers yet; it goes only once something does, in work of its own.

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
metadata. A waking run's lead answering its chat, and the coordinator of a run started in that
chat, get `leadAsks` instead: Claude Code's tools in the chat's Auto, Accept edits or Bypass, else
in Manual, switched by the permission picker while they run, no sandbox, limited only by the chat's
mode and saved rules as the chat's own session (the studio's fence spares a lead the integration
worktree it builds in); each question answered for that mode or carded (withdrawn after five
minutes), and every call but a read or a studio tool screened by the host ahead of every allow rule
(a PreToolUse hook) only to ask first while the chat is in a mode the session could not be switched
to. A lead also has the chat's own session's plugins and connectors, its plugins acting on the
build it leads. A lead's workers, the director's builders among them, follow the chat's mode and
ask in it, boxed and never reaching the never-touch list in any mode
([workers](tool-permissions.md#workers)); a classic Autopilot's builders, the playtester, scouts
and judges are unattended: `acceptEdits`, a sandboxed shell auto-allowed inside the workspace,
and no questions. A harness edit can make a
session ask only about a message the person sent that is still unanswered, and never chooses its
mode or answers a card: `thread.create` takes only a title and `events.append`/`turn.append`
refuse `tool_permission` and `plugin_consent` rows. Nor does it write a game's `.claude` folder,
whose settings and hooks the person's session loads. Deny rules name
absolute paths (`absoluteRule`: `//abs/path`, on Windows `//c/...`), because Claude Code reads a
rule's `/x` relative to the settings root. A worktree's session still reads its own game, and a
folder's neighbours are denied only inside the games root or scratch
([tool permissions](tool-permissions.md)). A Claude Code chat,
long-turn director and builder may use WebSearch and WebFetch; judges (`complete()`), read-only
sessions (the coordinator, playtester, scout and a waking run's lead; the lead and coordinator
only by asking) and performance-optimization candidates may not, and an unattended
shell keeps its sandboxed network. Every delegated Claude session asks for thinking summaries
(`showThinkingSummaries`); the chat shows a chat or lead session's non-empty summary under the
work disclosure's Thinking details, never a builder's or judge's. Codex keeps its CLI's own web
search default.

Connector tools are host-owned and arrive from one list. Studio main is the only MCP client: the
connector registry connects each enabled connector, namespaces its tools `<connector>__<tool>` and
appends them to the same `liveTools` every path already carries, so Claude Code gets them on the
in-process `studio` server, Codex through the file bridge and the local harness over `mcp.tools` /
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
So is `app_look`, look-only and in every mode, which a seated reader worker gets as its one host
tool ([looking at apps](tool-permissions.md#looking-at-apps)).

A run's job (its lead's or a worker's) that ends reaches its lead. The harness reads the run's ends
with `jobs.list` (read-only: no paths, no start, no stop) after an end number the run's journal
keeps (`jobsCursor`, in the director's loop run (`loop-run.ts`) and the Unreal lead's journal), so a resumed run
reads on from there and hears no end twice (`loop/jobs/watch.ts`, polled at most every 5 seconds).
A resting director is woken soon by a `job_ended` line; the Unreal lead is steered mid-turn, and an
end no steer reached is in its next digest. An end the agent itself caused (`job_stop`) wakes
nobody. A kept older wake loop, wake rules, loop run (`loop-run.ts`) or journal is in `SEED_CALL_CHANGES`.

What the evidence pass proves before it gathers. It waits for the page and records
`readyAfterMs`; it proves the studio owns the clock (two steps, `steppedFrames` — a base fails
where an iteration warns); it replays the run's `setup` before the seed; a game that reports
`state().flow` (a title, menu or countdown; template `config.flow`/`config.begin`) is then taken into
play — `__studio.begin()`, else its start keys, then stepped until `flow.playing` for at most 12
simulated seconds, a warning when it never gets there, never when `setup.begin === false` keeps the
front-end for its own worker — and the live view is reseeded to its first screen afterwards; a game
with no flow is driven call for call as before. It then drives the kind's play script; it photographs
the game's own cameras, falling back to the view the game renders when it registered none (with a
warning, never a void), and the page as well when the page has UI; and when `ok` is false it always
says why. Frames that ran and drew nothing are a verdict on a base with content in it and a warning
on an empty scaffold — the same exemption the blank-pixel rule already had, settled by inspection
(`EMPTY_SCENE_PROBE`) rather than by the game's own word. One classifier answers for every caller: `none`, `observation`, `race` or `build` — an
observation failure is not a build defect, and "evidence pass failed" is not a race.
`preview.status` says why a dead window's renderer went (`gone`, a `loop/preview-gone.ts` code beside
`crashed`; `killed` and `oom` are the machine's: the pass records `machineKilled`, reading the status
again at its end, and the classifier calls such a look an observation outage, retried with patience;
the host's own `render process gone` line has `source` `studio:window-gone` and is never counted as
the build's console error), and `preview.viewport` puts one leased window at
another size (clamped to 1920×1200) until its release, never Live, the stand-in or a computer session's window:
handing the lease to a session puts it back at the facet size, so size it again afterwards
(`preview.status` `viewSize` is the size it is at now); a pass given `viewport` sizes its leased window
before it loads. Every pass records the cameras the game registers (`registeredCameras`).

What a drive shows the judges (`loop/evidence.ts`). A held throttle steers by the game's own
racing line when the template's `config.steer` exists (`__studio.assist`, recorded as `drive`);
otherwise nothing steers, as before. A racer's drive watches `player.yaw` after its third step and
photographs the first turn faster than 20°/s as `drive:corner` (`loop/pass-frames.ts`), a frame
every camera list keeps (`corner` records it or why there is none). A look runs every demo a check
names — a vision check on `demo:<name>` included — and at most 12 more, demos the compared build
lacks first; the judge and the builder's next prompt name any it left out (`demoCap`), never as a
defect. A pass asked for `challenge` (a board carrying `throttle-bot-loses`, every round, or the
art director's look) races a bot that holds only the kind's throttle, steered by the line, never
braking, from `seed` in 5 s steps until `race.finished` or six simulated minutes; the probe
(`after`, `loop/throttle-bot.ts`) reads the state it ends on, and a game reporting no
`race.position` is not asked. Judges read the steering, corner and race as fact lines
(`loop/judge-facts.ts`).

What a probe reads. The studio bounds `__studio.state()` by structure, never by cutting its text
(`main/preview-page-scripts.ts` `boundStudioState`): a state whose JSON fits 48,000 characters
arrives byte for byte; past that, the largest lists, then the object holding the bulk (cut whole
when its weight is spread over many medium lists), become `{__elided, length, chars}` stubs, the
root names them under `__cut`, and any `keep` paths a `preview.state` caller sends are cut last
(`loop/state-shape.ts` `statePathsNamedByChecks` names a board's; the facet's look, its rebaseline
and a spike send them as `gatherEvidence` `keepPaths`, and the pass warns naming what was cut).
`len()`, `has()`, truthiness, `!= null` and a list's or string's `.length` read a stub as the value
it stands for. Any other read of a stub or inside one — in the late state, or in the early state a
`delta()` reads — and any probe over an older studio's text-cut `{__truncated}` state, is
unmeasured with `stateTooLarge`: it still blocks "satisfied", and it never says the build does not
report the path.

What a rollback may assume of a game folder. `snapshot.restore` on a game commits a rescue
snapshot first and may refuse with a typed `code` (`branch-changed`, `history-changed`,
`operation-in-progress`, `rescue-failed`), leaving the folder as it is; a loop must treat that as
"stop or pause", never retry around it with raw git, and never report a rollback that was refused
(autopilot's `rollBackGame` sets `report.rolledBack`). A loop snapshots its attempt before rolling
back and skips the rollback when that snapshot fails (the live spike does). Model or judge text
that reaches `/bin/sh` — a commit message, a worker title — goes through `loop/shell.ts`
`shellQuote`, never a `"` replacement, and the command line is built by `loop/git.ts`. A director land whose final-edits commit fails is refused
as `final-commit-failed`. A landing that git refuses over uncommitted changes in the game folder,
or one into a folder with something staged or a merge of its own under way (which the failed
merge's abort would undo, so it is not tried), is refused as `uncommitted-changes` and names them
without blaming anyone; a conflict with commits there, or a hook or lock that refuses the merge,
stays `could-not-land` with git's words.

One seam per worker. In a game the user brought, a worker is given a path, a folder or a glob to
own (`*` and `?` stop at a slash, `**` crosses them; a glob must be quoted in the tool call), and
`worker_start` refuses a second worker in such a game with no seam of its own — a game's entry is
owned whole, because two workers in one entry file get union-merged and the merge has no seam to
follow. `src/substrate/ownership.ts` and `loop/review.ts` are two copies of that one rule, held in
step by a conformance test, because the seed runs outside the app, where nothing under `src/` resolves.

Ownership is judged on the worker's own diff, never on what arrived by merge (`loop/merge-ownership.ts`).
Each round's merge of the integration head is settled by ownership: another part's conflicted file
takes the integration side, the template entry's wiring block is union-merged, and only a conflict
in the worker's own files goes to its builder, whose note names just those files (and the entry,
when its wiring conflicts too). A hand merge the builder left uncommitted is committed before the
review; one with any path still unmerged, or staged with conflict markers, makes the build broken. Enforcement keeps an unowned file that matches an integration head, and a merge that kept
the worker's side of another part's file is a `merge-dropped` finding, restored from the merged
head. `facet_review_enforced` lists `reverted`, `kept`, `quarantined` and `restored` files.
The review's diff base is the newest integration commit the worktree holds: it walks the
integration line from the lead's latest head (`loopIntegration().latest`) back to the incumbent
(`loop/facet/merged-heads.ts`), so a lead's fix the builder was told to merge before its wave
closed is never the builder's edit. A clean merge that changes a part's own files (other than a
template entry's wiring) tells its builder, in the brief's Integration section, that they are the
lead's changes to keep; the lead's brief and `skills/director.md` send a fix in a running worker's
files to that worker (`worker_steer now=yes`).

A plan whose parts loop two or more (a part marked `"mode":"single"` does not count) needs a
module contract before its loop workers start: `plan contract=` names each module's file, owner
part, API, and the shared files one part owns (`director/module-contract.ts`); a convention or API
line is kept up to 400 characters and cut only at a word, with an ellipsis. The file's header says
what it freezes (interfaces and conventions, with ranges for content) and what it does not
(content, layout, scale). The harness commits it as `docs/MODULE-CONTRACT.md` on the integration branch (its own file: a game's `docs/ARCHITECTURE.md` is never touched); a loop worker starts only from a commit that holds
it, with its own modules there (stubs the lead writes and commits in the integration worktree itself, or a single worker), and a seam that leaves
other parts' modules alone. With no seam named it owns its contract modules (`director/contract-gate.ts`).
After two refusals for a missing contract the harness writes one from the plan's seams. The
contract's commit stands where its parent stood: on the run's starting point it is a starting point
too (a blank base stage passes the fork gate), and the close lands nothing beyond it. A build
resumed from a journal written before this gate (no `contractGate` mark) starts its loop workers as
it always did until its lead commits a contract. `integrate
worker=a,b` merges a wave in order with one health pass; a healthy integrate, or `wave=close`, moves
the head running workers merge, so they take integration once per wave. A merge's health pass runs
the demos workers' checks name (and at most one more); the close runs every demo. A round, or a
merge, that loses a camera, demo or probe another facet's checks use is a regression
(`loop/registry.ts`). Only cameras the page registers count, never the harness's own `default`
view; a merge compares state paths only with a health pass under the same setup.

The vision (`loop/vision.ts`) is where the world's ambition lives, apart from the contract: `plan
vision=` gives the world's scale, what the player sees past the nearest building, two or three
set-pieces and the headroom, each section cut at a word, the whole under 6,000 characters. A re-plan
without one keeps the last; it rides on the plan and on `run.vision`, so a Resume reads it back. Under
a plan of two or more looping parts it is committed beside the contract, in the same commit, as
`docs/VISION.md`, and a loop worker is refused until it is there (the refusal names whether the
contract, the vision or both are missing); after two refusals the build goes on without one and
the lead hears it. Every worker brief (the facet opening prompt and a single worker's brief) and
the taste judge, liveness critic and ship review read a bounded excerpt (`loop/vision-prompts.ts`)
as the direction to grow toward: growth toward its headroom deepens the ask.

A game from scratch whose run has an hour of working time and room for two loop workers at once
(`director/foundation.ts` `foundationFirst`) gets no starting scene: `journal.base` records the skip,
a decision card says so, and the lead's brief (THE FOUNDATION IS YOURS) asks for the contract, the
vision and crude playable stubs in about twelve minutes, the content left to each part's owner. A
shorter run or a pool of one still builds the starting scene, now a crude playable skeleton of the
user's scope.

What a run builds. Its scope (`loop/scope.ts`, `run.scope`) is the user's own words from the
chat's log since the last run, stamped at launch with what is in scope and what is cut; a Resume or
a reopen reads it back, and a run without one behaves as before. Every agent that reads the goal
reads `scopeLines(run)` beside it (`loop/scope-prompts.ts`: judges add `SCOPE_RULE`, the lead's
rules `DIRECTOR_SCOPE_RULE`), and every proposal — a taste judge's or player's `bigMove`, the
planner's move, a liveness fix (`adds`) — carries a typed `scope`, `deepens` or `adds`: a vista,
skyline, water, landmark or set-piece serving the mood the user asked for deepens, and only a new
system, mechanic or mode adds (the lead's rule cuts systems and deepens the world). An `adds`
proposal is never a move: it becomes a decision card (`loop/facet/beyond.ts`, at most
`BEYOND_CARDS_PER_PART` per part), and only a user steer answering one widens the scope. `plan cut=`
joins the cut list; `added=` and a part marked `added:true` are cards too. One part owns the screen
(`critic=screen`; `worker_start` refuses a second running one): while it runs, another template part
that draws through the contract HUD is a `screen-owner` finding (`loop/screen-owner.ts`); each
part's brief and opening prompt (and a direct engine's resumed one) say who owns the screen, and a
finishing non-owner hands HUD polish to the owner (`loop/screen-owner-prompts.ts`). A check
asking that how much the build draws (HUD items, per-kind counts such as `hud.kinds.bar`, draw
calls, triangles, vertices) be large is
refused where checks are validated (`loop/check-lint.ts`, `draw-count-floor`); a ceiling or an
existence test passes, and a board stored before the lint scores as it did.

Where a round's move comes from (`loop/facet/rules.ts` `chooseMove`). A director's ladder goes
first, steered rungs ahead, and ends with one open rung (`loop/facet/growth.ts`: `worker_start`
and `worker_steer move=` append it; a lead's `{"open":true}` only marks it). When reached it is
filled with the reviewers' best step inside the ask — a liveness principle short of 3 with an
in-scope fix for `STUCK_PRINCIPLE_CARDS` (3) critic cards running, else the taste judge's
`bigMove`, else the critic's `biggest` (a grow principle below 3), else its other grow gaps —
written onto the ladder with a decision card, and mandatory like the lead's rungs; with none it
is passed over. A stuck principle also joins its card's `grow` or `polish` list by kind. Past the
ladder the reviewer's `bigMove` is guidance; with no director ladder the same candidates, then the
planner, name the move.

Two stages. A worker's `spec.stage` is `build` (the default) or `finish` (`loop/facet/stage.ts`;
`worker_start stage=`, never on a single session, or `worker_steer stage=` from its next round;
and `worker_steer move=` puts a finisher back to building). A finish round has no move, ladder or
polish streak: its brief works the taste judge's polish list (up to eight; `judge/taste-finish.md`
is appended to the taste rubric) and the defect ledger, it wins on the blind pick, a regression
still rolls it back, and the worker ends once a preferred, unbroken build holds every identity
check. The art director's finish mark (below) is when the lead turns owners to it.

The build block. A director's new loop worker (not a restart: `replaces=` or an id from before a
pause) whose window holds `BUILD_BLOCK_MIN_WINDOW_MS` (two hours) opens with one long round on a
session engine in its own worktree (`loop/facet/build-block.ts`): its turns never run past
`BUILD_BLOCK_MAX_MS` (90 min), and a builder that ends its turn before `BUILD_BLOCK_MIN_MS` (60 min)
is asked in the same session to keep going in a screenshot-and-fix loop on its bench page (at most
`BUILD_BLOCK_TURNS` asks). The block is
kept on the checks alone — broken, regressed, lost-registry and unchanged builds are still refused
on the board — and the taste judge looks once for notes, never a verdict; blind A/B starts at round
two. A finisher and the classic pipeline have no block. Its build time seeds neither the worker's
round estimate nor the run's median (`facet_iteration.buildBlock`).

Kept fixes. A round the judge preferred that missed a mandatory move is kept when it flipped any of
the judge's own defect questions (`rules.ts acceptRound`): the move stays owed and its rung is not
climbed. A judged round undone with flips leaves them, with its attempt ref, in
`carriedFixes` (`loop/facet/carried-fixes.ts`); every next brief's CARRY OVER section tells the
builder to re-apply them until the accepted build passes them. A round the judge did not prefer is
recorded as a taste loss, not `no-move`.

Manual SkillOpt resolves the most recent run's model through `modelOn`, as the post-run path does.
Its mined tasks leave out the `build_observation`s of a game that now builds in Unreal: they are
what the web preview saw of its notes folder.
A cross-provider run stores its builder model alongside its orchestrator engine, so those two raw
fields must not be passed together to a completion call. Skill gates compare instruction texts against saved task descriptions; they do not execute
candidate builds or establish better future game outcomes. The analyst sees every other mined task and
the gate judges only the rest, with the candidate changing sides between its three votes; a skill with
no held-out task is not analysed. The pass stages proposals and never writes a skill itself: the host
applies them (see Architecture, learned changes). Lessons distilled from builders' `## Fixed by looking`
and `HARNESS:` notes (logged every round, won or lost; distilled even when no round was judged) are staged the same way, ungated, for
`library/contract-lessons.md`; a refused lesson is not proposed again. Anything that learns asks `learningOn(ctx)` first:
with the user's Self-improvement switch off it records what happened and changes nothing. The idle code architect remains a separate
opt-in and preserves fork validation, snapshots and rollback.

### Worker sessions

A facet worker keeps one provider session from round to round, however large its context grows:
Claude Code and Codex compact it themselves at their own point (about 967K on a 1M Claude model,
about 90% of the window on Codex), and Studio sends neither a threshold nor a handover of its own.
A refused resume (`facet_session_reset`) and a context overflow start a fresh session on the full
prompt.

A worker's copy of the game (`snapshot.worktree`, `harness-rpc/snapshot.ts`) holds every file the
commit tracks; of what it receives outside history, the files of the game's nested repositories, it
leaves out the game's ignore and `copySkip` rules (only the ignore rules when the copy versions those
repositories). A copy larger than `WRITER_COPY_MAX_BYTES` (2 GB, `substrate/snapshots.ts`) is
refused before anything is made (`SnapshotRefusal.CopyTooLarge`), with its size and largest
folders; every caller gets that answer, the director's integration and play copies included, in
words that fit each: the game is too large to copy, so the work belongs in the game folder.

### Workers in a chat

The chat's own session, answering a turn on a delegated engine, may start workers. The harness
claims `workers` (`loop/main.ts`), opens a pool for the turn before its session starts and closes
it when the turn ends, failure and Stop included (`loop/workers/chat-workers.ts`
`withChatWorkers`). While the pool is open the turn's delegation carries `workers: { tools }`. The
host hands those tools only to the chat's own session answering that turn, only the six worker
tools, and never to a worker (depth one). Each call is forwarded as the `worker_tool` dispatch to
the pool of that turn; a call for any other turn starts nothing.

The pool (`loop/workers/pool.ts`, `pool-start.ts`, `pool-merge.ts`) runs up to
`MAX_WORKERS_AT_ONCE` (8) at once, under the Settings ceiling the host keeps per chat on its
workers, readers and writers alike. A chat turn on a local model's engine opens no pool: only a
delegated engine carries a worker's seat.

- `worker_start {title, task, isolation, type?, research?, inputs?}`: a reader (`read`) works in the
  game folder, read-only, with web search only when `research` is `yes`. A writer in a copy
  (`copy`) works in a copy made by `snapshot.worktree` after a game snapshot, under the copy
  rules and size cap above; a refused copy is answered by its code, pointing at `lock` or a
  reader. The one writer in place (`lock`) works in the game folder, one at a time per game. A
  `type` names a kind of worker a plugin that is on declares (`plugins.workerTypes`); it gives
  that kind's tools (`toolAllow`) and its isolation.
- Every worker's delegation carries the `worker` grant (`{id, title, turn, research}`), which the
  host honours by seating it in the chat's permission mode.
- `worker_status` and `worker_wait` (at most `MAX_WORKER_WAIT_S`) read each worker's line. A worker
  whose question waits in the chat (a pending `tool_permission` row naming it) shows as waiting for
  the person, and `worker_wait` wakes for it.
- `worker_steer` interrupts that worker alone (`engine.interrupt {cwd, worker}`) and resumes its
  session with the words in front; `worker_stop` aborts it alone (`engine.abort {cwd, worker}`),
  sent again while the host finds no session to stop (one still being seated), and a stopped
  worker takes no further leg.
- `worker_mark used` merges a copy's commit into the game folder with the director's merge
  (`mergeNoFf`, conflicts listed and the merge aborted). Conflicts, and the lead's uncommitted
  files the work also changes, go back to the lead with their names; `rejected` drops the copy.
  A verdict stands once given, and a writer in place that finished is in the game already, so it
  is never marked rejected: the chat and the graph never call work in the game unused.
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
kept playbook or journal may say) and adds `worker_mark`. Its `worker_start` takes `task` (a kept
prompt's `brief` is still read), `isolation` and `research`: `copy`, the default, is its builder in
its own worktree; `read` starts a reader from the run's shared pool (`loop/workers/run-pool.ts`,
`director-pool.ts`) in the game folder, which never integrates, and may research the web; `lock` is
refused, because the web method never writes in the game folder itself. A web run takes no plugin
worker types. `worker_mark used` integrates the builder as
`integrate` does; `rejected` stops its news in every digest and `worker_wait`, and is refused for a
builder already integrated. A conflict worker's records name the work it fits in, in plain words
(`FIT_IN_WORDS`), with no summary of Genex's own. Every builder's
delegation, a conflict worker's included, carries `worker {id, title, runId}` (`director/workers.ts`,
and `facet/phases/build.ts` only when the facet loop runs for a director; a classic Autopilot's
builders carry none), so the host seats it in the mode of the chat the run was started in. A
builder that waits on the person (a pending `tool_permission` row naming it, read by
`loop/workers/questions.ts`) is told once in the run's log, which wakes `worker_wait`, and its
line says `waitingForPerson`; a builder the chat has no room for yet (`too_many_workers`) waits for
room until its deadline (`withWorkerRoom`) rather than failing its round, and a stop of it ends the
wait before its turn. While the run's chat
plans, the host holds its lead's writer starts and `worker_mark used` as for the chat's own
session. The run's close stops its readers.

The Unreal lead's tools are the same six (`loop/unreal/lead-workers.ts`): a `type` the plugins that
are on declare runs one of its typed workers, and no type runs a generic worker from the run's
shared pool; see [plugins](plugins.md). A run's pool keeps its records in the run's own artifact
(`run-workers-<run>`) and a copy's work on `refs/studio/runs/<run>/pool/<id>`; a resumed run opens it
from that artifact on the first call naming one of its workers. Its snapshots, merges and kept refs
in the game folder wait for the lead's own git writes there (`oneGitWrite`), and a generic worker's
end joins the lead's news with its typed workers' (`unreal/pool-news.ts`). A typed worker always
works in a copy: a start that asks it for another isolation is refused. A typed worker waiting on the
person shows so in the Unreal lead's status, and its `worker_wait` wakes once for each question.
Kept copies of the director's files from before this are in `SEED_CALL_CHANGES`.

### What a round costs

A loop worker's round first waits while the machine has less than `ROUND_MIN_FREE_MB` free
(`loop/facet/admission.ts`, one `facet_machine_pressure` per wait; a failed `preview.capacity`
never holds it). While it waits, its status line and its loop's phase (`waiting for memory`, in
the director's `run_status`) say why, and a stop, a wrap-up or a cancel ends the wait at the next
poll. `.studio/BRIEF.md` stays within `BRIEF_MAX_CHARS` (12,000) with the moved
sections in (`loop/brief-budget.ts`, `facet/brief-fit.ts`): six review violations and a count,
liveness and integration cut at a word, notes kept as their newest words, and over budget the
lessons, style distances, diff stats, recipe text and optional polish leave in that order. The
goal and scope, steering, move or finish, THE FIX, the checks, Done means and the rules always
stay, the rules ahead of the earlier rounds. A delegated builder's retrieved recipes are written
whole to `.studio/RECIPES.md`; the brief keeps their titles and intents, and only THE FIX's recipe
keeps its sketch inline. Retrieval keeps to the run's game kind (a recipe's optional `kinds`; none
means every kind), needs `CRAFT_ADOPT_SCORE` unless the recipe is the check's own, and takes exact
matches only for a first round's unscored checks, and THE FIX's recipe keeps to the game kind
too. A builder's `capture` (Claude Code, Codex and local sessions alike) shoots its part's own
cameras unless it names others, and `page=bench/<part>.html` loads a bench page (an existing `.html`
file inside the workspace, by real path; anything else, or any page of a game served from its
build output, is refused and nothing loads) through the served root with no setup. A rebaseline
after an integration merge takes the motion strip only for a play or demo check or a facet the
taste judge watches move (`loop/motion-intent.ts`), and always the audio probe, so both sides of
the next blind A/B carry the same evidence; the taste judge shows motion strips only when both
builds have one.

## Acceptance evidence

`npm run test:agentic-readiness` prepares two disposable local Git checkouts with shared
read-only-in-practice node_modules, then boots their fixture profiles plus a separate owned
sentinel. It exercises navigation/filter/model menu, Unicode/keyboard, coordinator Send,
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
unfocused; a delayed real Stop aborted its pending fixture coordinator and produced a durable
turn end. The existing coordinator records an aborted delegated turn as error; the fixture
asserts the explicit abort cause, without changing coordinator semantics. A sent Stop during
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
(`studio-playtest-`, `studio-judge-` — a playtester and every judge call run there, in nobody's
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
`census.test.ts`, `engine-voice.test.ts` (every exported brief rendered once per engine: no bridge
command in a Claude render, no `mcp__` name in a Codex render), `check-grammar.test.ts`,
`facet-loop-v2.test.ts` and `evidence.test.ts`. `npm run verify:architecture` now walks `src/page`
as well as `src/renderer` and `src/shared`, following the `/vendor/studio/*.js` specifier back to
the `src/page/*.ts` file it is built from, so the page world cannot reach main, preload or substrate either.

`node tests/e2e/run-preview-visibility.mjs` exercises real Electron windows with forced
capture failures: hidden/minimized windows remain hidden, failed evidence stays unavailable,
and parallel private previews retain input, capture and reload without show/focus/restore events.
Reports include timestamped native events under `.studio-dev/evidence/preview-visibility`.
`STUDIO_PACKAGE_DIR="out/Genex-darwin-arm64" node tests/e2e/run-computer-smoke.mjs`
runs the existing scripted worker/playtester checks against the packaged application.

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

Until-satisfied director runs treat the clock as a safety ceiling; explicit duration runs retain
their working window and user Finish override. The lead's `finish` is refused while working time
remains unless the user asked: Finish, or `user_asked` quoting the user's own words from a message
delivered into the run (`integrate.ts` `userQuoted`, checked against the run inbox's steers). However a run ends — the lead's `finish`, the
clock, the user's Finish — the close judges the head it is about to make live
(`director/tools.ts` `judgeTheLanding`, from `integrate.ts`): blind against the build the user had,
or, for a new game or one whose start nobody could photograph, a yes-or-no on the goal
(`close-prompts.ts`). A lead's own blind judge of that head against the start, whichever build it
picked, stands in for it. The judge borrows the studio's window, and its model calls must be done
four minutes after it starts (judge.ts's per-call deadline, for engines that honour a request's
timeout), because the close runs inside the lead's ten-minute `finish` call; an answer it was not
surer of than a coin flip counts as none. A head that never moved beyond the start is not judged,
and a Stop before or during the close lands nothing. The verdict is reported, not a veto: the build
lands when the close's look loaded it or a judge saw it load, the close's own included.
`landingResult` says what the landing may claim (`judge-pick`; `judge-answered-yes` or
`judge-answered-no` for a sure answer to the goal question; otherwise the health tokens), and
`finish` tells the lead. A workspace that kept an agent-edited older `integrate.ts` keeps its older
close; one that kept an older `tools.ts` lands as before and notes that it did not judge.

The art director is the one absolute judge (`loop/ship-review.ts`, rubric `judge/ship-review.md`):
one build, every frame the evidence pass took of a registered camera, the player's eyes and each
demo's end, then the first, middle and last motion frames and the reference (at most 14), captured
at 1600×900 on that lease only (`SHIP_VIEW`), asked "would you ship this as the user's demo
today?" with the user's scope beside the goal. Each defect names a plan part (kept only when it is
one of the plan's ids), a camera (kept only when the review was shown it, else the default) and a
severity (`blocker`, `visible`, `nit`); an unreadable answer is no verdict, never a "no". The lead
asks for it with `judge ship=yes`, alone (no blind comparison; an `against` other than `none` is
refused, since the other build was seen at 960×600), and its look never replaces a pick or answer
already standing on that head (`state.lastJudge`). The studio runs it itself at the
finish mark (`director/art-direction.ts`): a timed build's last 30% of working time
(`budgets.ts` `finishMarkMs`, 30 to 120 minutes, none under 90), said once (`WakeCause.FinishMark`,
journaled; a mark that finds nothing integrated leaves the lead to `judge ship=yes` itself; a mark
still unsaid once the wrap-up is due, after a sleep or a Resume, gives way to the wrap-up); a goal
build once, when its lead idles a second time or calls `finish` with no review on its head (a "no"
turns that finish back once, never twice, and never the user's own finish). That finish gate runs
inside the `finish` call: its one look also answers the close's own question, so the close does not
judge again, and when the close still owes a blind judge against the start there is no time for
both and the finish closes without the art director. The
lead is woken with the defects by part and the rule from there: no new parts, `worker_steer
stage=finish` on each owner, integrate, `judge ship=yes` again. Every later wake repeats it: the
time line says the build is past the mark, the room for workers offers only finish workers, the
idle question asks to finish what exists instead of a next feature, no worker line shows its
reviewers' next big step (a finishing worker's never does, and its line says `stage finish`), and a
timed build's card says its finish stage. A goal commission's card and brief say the art director's
blocker and visible defects are required finishing, not the optional polish it skips. Each defect on the integration
branch becomes a director-origin vision check on its running owner's board (the part's worker, or
the running worker that replaced it; its fix is a strong flip), and its owner is told in words that
follow the verdict and severity (a nit is optional polish; a blocker or visible defect must be gone
before the part is done, beside a building worker's move; from the finish look on every owner is
told as a finisher), or a ledger line under its finished
part or the lead. A loop worker started on that part later (its id, `replaces` chain or goal) takes
the part's ledger lines onto its board the same way, so a finish worker ends only once each
blocker or visible defect is gone. A review with a verdict replaces the earlier reviews' questions
on running boards (one it repeats word for word keeps its id), so re-reviews never pile up. One
look is one judge verdict record, asking the ship question. `state.lastShip` is journaled and
restored on a Resume; `report.shipReview` and the `finish` answer say whether the art director
would ship the head the close stood on and how many defects are left. It never vetoes a landing.
When the lead names no cameras, a blind judge shows every view both builds have, cut alike.

The art director also looks on the studio's own schedule while loop workers build, in every run
(timed, goal, ∞), however busy the lead is (`art-direction.ts` `shipLookAt`, `WakeCause.ShipLook`,
an uncapped wake the loop answers with `shipLookPass` before the lead's turn): once the first wave
is in — every running loop worker has had kept work merged (`integrate.ts` marks `integrated`) — or
after `SHIP_LOOK_EVERY_MS` (90 minutes) of working time, then every 90 working minutes on a head no
review stands on. A review the lead asked for, the mark's or the finish gate's resets that clock; a
look that gave no review is tried again 30 minutes later (`SHIP_LOOK_GAP_MS`), and no regular look
comes within 30 minutes before an unsaid finish mark, whose own look takes its place. A wake that
carries the user's words leaves the look for the next wake. The cadence is journaled in working
time (`nextShipLookWorkedMs`). The regular look only routes defects: owners are told as building
workers (beside their move), the wake says it is not the finish mark, and the finish stage still
begins at the mark or a goal build's idle or finish look. Each review
also names up to eight short things that already work (`doNotRegress`, cut at a word; an older
rubric's `strengths` stand in). A review with a verdict puts the list on every running loop
worker's spec and a loop worker started later takes the latest; its brief shows it ("Do not
regress") and its round's taste judge is told that the accepted build losing one is a regression
to name. `state.lastShip` and `report.shipReview` keep the list; an unreadable review keeps the last.

A goal or ∞ build's wake digest names its required outcomes on every wake while some are
unverified (`required outcomes: N/M verified on this revision`, `progress.ts` `outcomeTally`), and
every 60 working minutes (`VERIFY_NUDGE_EVERY_MS`) and after each ship review adds VERIFY THE
OUTCOMES, asking for `playtest goal=<id>` on each one still unverified (journaled as
`verifyNudgedWorkedMs`; never in the wrap-up).

The initial plan freezes required acceptance scenarios in the versioned director journal. A
reopened build is a goal commission, the Loop's hours or ∞ its ceiling (`reopen-run.ts`
`reopenBudgets`), and takes none of the finished run's outcomes: its journal records
`goals: null` (`director/reopen.ts` `reopenedJournal`); its lead's first plan taken for the ask posts the plan card and freezes new ones (a refused plan sets
none), and until then `worker_start` asks for that plan (`workers.ts` `goalRefusal`). A Resume
before it plans keeps waiting: `restoreLoopRun` takes outcomes from the plan only for a journal from
before they were kept, and `reopen.ts` `outcomesAwaitPlan` sets aside any a kept older
`journal.ts` rebuilt. Renaming workers does not reset an
unresolved goal's attempt allowance. Independent integration playtests record acceptance on
an exact revision; a new revision requires fresh evidence before victory. Typed external
blockers retain the integration ref and pause once no independent required work remains.
A user Resume revisits the prerequisite without granting package or publishing permission.
An initial plan part requiring Genex online play declares `multiplayer: true`. Before delegation,
`plugins.preflightMultiplayer` checks a regular game manifest, the pinned SDK installation tool,
unlocked Genex account and consented publishing capability. Missing capabilities block the goal;
readiness never grants installation/publication consent or claims remote authentication or hosted
play passed. Actual SDK installs still use the consolidated consent card.

Worker plugin approvals are recorded in the run owner's conversation, resolved from host
call attribution and persisted run starts. The original worker remains the cancellation
scope. Ambiguous or mismatched run ownership is never guessed from a project name.
Codex ownership recovery metadata lives beside the Codex engine home, never inside it (a folder
there would read as a sign-in), rather than appearing as an untracked game edit; legacy in-game
records remain recoverable with hostile-path checks.
The first independently verified milestone and latest checkpoint are retained in the journal
and report, with immutable Git refs so later integration and cleanup cannot discard them. A one-time 30-minute review reports verified outcomes and blockers without ending
healthy work. A reopen earns the checkpoints and the review anew. Existing Show build and safe
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
(`engines/common.ts` `isAccessLost`), also when the result's subtype says success. A lead turn a lost provider ended — a sign-in, a limit it will not wait out,
an outage the patience ladder could not outlast, a 529 the session returned included — pauses the
run (`afterTurn`'s `providerLost`, `state.limit`): no wrap-up, the workers stopped, nothing landed
or judged (`NotLandedReason.Paused`), `run_finished.limit` naming its kind, and no learning pass
until the run ends. A sign-in, cap or reset-naming limit opens that engine's circuit for the run
(`loop/provider-loss.ts`): judge, critic and ship-review calls to it fail at once with its kind
until the run starts again or the limit resets (ten minutes at most for a loss that names no end),
and a sign-in any engine of the run lost pauses the run at the lead's next turn or wake. A worker
round the provider failed (`facet/provider.ts`) is recorded as `facet_provider_outage` with
`lost`, never judged, struck or rolled back: its build or
verification waits for the provider and runs again, a run's stop keeps it on its `…-stopped` ref,
and a usage cap still stops the worker with its limit for the lead.

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
`resumeAutopilot`, after a host-only `run_auto_resumed` (`cause`, `attempt`) that bounds it. None
happens after `AUTO_RESUMES_MAX` (2) automatic resumes of the run, after the user's Stop (in that
chat, or of the run through `studio:run.stop`, `StudioCore.stopRun`) or a Finish since the run last
started, once a newer run started in that chat or another run is running (`superseded`), with under
ten minutes of working time left, for a
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
