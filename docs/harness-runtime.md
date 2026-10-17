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
bounded ask runs at (always "low", whatever role effort the user set), `model-roles.ts`
`roleEffort` caps a worker's and a reviewer's effort at high (`WORKER_EFFORT_CEILING`, the app's
copy in `shared/model-roles.ts`) while the lead keeps the user's (the Unreal lead too, on the main
agent's model: `unreal/lead-turn.ts` `leadEngine`), and `boundedEffort` holds a fixed
effort (the Unreal critic's, its agents') to a lower one the user chose, `outcomes.ts` gives every stop a
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
`seed-exports-pre-goals.json`, the Unreal lead's `seed-exports-pre-lead.json`, the open harness's
`seed-exports-pre-open-harness.json`, Genex's moments' `seed-exports-pre-hooks.json` and one Loop's
`seed-exports-pre-one-loop.json`; the goals',
the lead's and the moments' are kept one module at a time, the lead's and the moments' with each
module's own imports as they were, so a retired module a kept caller still imports stays as a shim:
`loop/unreal/live.ts`, `live-journal.ts`, `editor-life.ts`, `editor-wait.ts`, `editor-wait-prompts.ts`, `editor-activity.ts`). Where a kept older
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
([plugins](plugins.md#finding-and-suggesting-a-plugin)). It has no `plugin_check`, which only a
delegated chat's own session is handed.

Genex's own gates (`loop/builtin-hooks.ts`, `BUILTIN_HOOKS`) run beside the plugins' hooks, each
registered for a moment and the facts it guards, reading typed fields only. `web.ready` at
`run.prepare` reaches a web game served at the root and refuses a Loop whose page lacks the files it
needs to load, by `game.validate`'s `missing` names, in the words it always used (`loopRunRefusal`,
which still refuses an engine export of any kind); a Godot, Unreal or plugin project is never refused
for a missing `index.html`; a chat-launched web Loop's start asks `game.validate` itself, so a kept
older launch that hands no `missing` is refused all the same. The web method is a skill for web
games: a seed skill names the facts it serves (`facts: web-game`; one naming none, a copy kept from
before, is the web method's), and a Loop's brief reads only those whose facts reach the folder
(`loop/loop-skills.ts`): a web Loop's playbook is the same text as before, and an open Loop's brief
carries the workspace skills that name its folder's facts, never the web method.

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
there are several. A kind no plugin that is on covers (Unity, Blender, an Unreal plugin, a Godot or
Unreal project with its plugin off, an unknown one) calls `plugins_find` first, shows the card with
`plugins_suggest` and ends its reply, offers to write a plugin when none fits, and goes on with its
files and the shell only on the person's word (`pluginFirstRule`); a kind a plugin that is on makes
(one of `kinds` names it, as Godot's plugin does Genex's own `godot-project`) skips that. An Unreal project the game is not
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
(`firstLoopUnused`). A finished Loop on a project that isn't a web game is never reopened: it
worked in the game folder, with no copy to go on from (`finishedLoopRun` answers null for a journal
with `director.open`), so a Loop message the person sends after it is answered as before any run and
the chat's session may launch the next Loop, which builds on what the project holds
(`chat-dispatch.ts` `startsNextOpenLoop`). Not solved, by the owner's decision: a chat whose
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
build it leads. A Loop's lead has one of two seats in its game folder, each the host's own finding
(`DelegationService#leadRoot`): in a web Loop (`loopProfileOf` in `shared/project-facts.ts`: a web
game at the root beside nothing but `web-game`/`blender-assets` facts) it is read-only and leads
the run's integration worktree, and only it is lent the preview window; in any other Loop it works
in the game folder itself (`director.inPlace`, honoured only for a writing lead whose root is the
game folder by name and real path, of a run of this game started in the chat its delegation and
grant name), its plugins acting there and its run's consent covering its engine connector. A
grant it cannot place leaves the session unattended. A lead's workers, the director's builders among them, follow the chat's mode and
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
`operation-in-progress`, `rescue-failed`, or `hook_blocked` when a plugin's `restore.before` step
blocked it), leaving the folder as it is; a loop must treat that as
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
and turns on one line within `HOOK_LABEL_CHARS`; a kept `loop/host-methods.ts` without their
methods is in `SEED_CALL_CHANGES`. `observers.capture {project, runId, threadId?, observer?, withinMs?}`
runs the game's plugin observers for a run of this game (one, named `<plugin>/<id>`) and answers
one `{observer, label, images, recording, note?, problem?}` each, pictures as `{name, file,
mimeType, data}` with `data` downscaled for a prompt; the host keeps the files under the run's
folder and records `observer_capture`; a run that is not the game's or an observer it has not is
refused before anything runs, nothing runs or is kept past `withinMs`, and Stop, the harness's end
or an ended boot end it as they end the moments ([Observers](plugins.md#observers)). The seed's `loop/observers.ts` turns those and Genex's
own web preview (an evidence pass of each served web folder, its camera shots as stills and its
motion frames as the recording) into one `Capture` shape (`observeGame`, bounded by a deadline on
the caller's clock, which the host is told as `withinMs`; `pickedImages` for a reviewer's prompt;
`recordCaptures` records the preview's and the lead's proof, the host records the plugins'). The Unreal
lead's save points and autosaves are checkpoints, its rewinds restores, its rebuilds and crash
recoveries the restore and crash moments followed by `health` until it is quiet, and it fires
`run.prepare`, `run.end` and the turn moments; it names no plugin step. A chat's own turn fires
`turn.start` (a block ends it before any engine works) and `turn.end`, ends with
`endOfTurnCheckpoint` (`checkpoint.take` only if unsaved) and, after a turn that linked the game to
an engine project or switched its link, waits on `health` (`waitReady`, up to `READY_WAIT_MS`); any
other kind change goes on at once. Genex's own hold of that checkpoint or of `turn.start` is said
in the person's words (`hold`), and Plan mode says nothing; so is Genex's hold of a run's start,
its lead's turns, the Unreal lead's close, restores and C++ (`loop/director/held-words.ts`,
`loop/unreal/hold-words.ts`). A host call of the moments that fails holds a blocking moment back
with why (an older host's `UnknownMethod` is no moments at all), unless the chat's or the run's
Stop ended it: that run ends as stopped, never as held. A crash moment Genex held back rolls
nothing back (the run halts). A `locks.hold` that fails starts no writer in place. Workers fire `worker.start` before their
start record (a block starts nothing; a worker refused after it still gets `worker.end`) and
`worker.end` after their end record, in the pool, the
director's builders and the Unreal lead's typed workers; the director fires `run.prepare` (a block
closes the run before its first turn), `run.end`, each wake turn's `turn.*` and the lead's own
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
yes; the host counts the no's in a row from its own records (`rejectionsInRow`, since the run was
last opened: a reopened run starts over, a resumed one goes on), writes the outcome and answers
`stopped` at the cap. A run's start, pause or close drops its held round: a review or settle still
waiting then records nothing more and starts no reviewer. `finish_check` is a
host-only record: a harness batch carrying one is refused whole. The
host seats the reviewer in a fresh home of its own (a folder no box writes), reading the lead's folder and the run's captures, with
`app_look` and nothing else ([Tool permissions](tool-permissions.md#a-loops-reviewer)). Its pictures
are the lead's proof first, then one still of each observer in turn, then play frames, fitted to the
seat (none for a model that can't see, as many as its window holds, no picture over
`REVIEW_PICTURE_MAX_BYTES`, `REVIEW_IMAGES_MAX_BYTES` in all); a seat that can't hold the brief gets
it without the proof's excerpts, then without the hooks' notes, and only then is no reviewer. The
brief marks everything the lead, its files and the plugins wrote as data, quotes the person's own
words with what is in scope and cut (`scopeLines`) and their own messages, word for word, as the
person's word (`loop/finish-log.ts`: a steer the lead took from their message, or one whose words are
that message's), the rest as relayed by the chat's agent, labels `run.goal` as the launch wrote it,
and counts the pictures attached. A proof file is read by handle, never through a link or a FIFO, and
only while its name still leads to it inside the folder.
The lead's `remaining` (what it says is not done yet, one item a line, `remainingOf`: at most
`REMAINING_MAX` items of `REMAINING_ITEM_CHARS`) comes before its claim and is never clipped with it,
and the brief asks the reviewer to open pictures of its own choosing in the folder and to judge how
a thing looks only from a close front or side picture.
In a Loop in place, a claim that names what remains while more than `GAPS_FIRST_MIN_MS` (20 min) of
working time is left reaches no reviewer: the lead is told to work on what remains first
(`open/finish.ts` `gapsFirst`), and nothing is recorded.
It answers `{"verdict":"yes"|"no","reasons":[…],"notDone":[…]}`: yes ends the Loop, no goes back to
the lead with its reasons, and `MAX_FINISH_REJECTIONS` (3) no's in a row stop it; an answer that
says neither, a failed session or a Stop neither counts nor breaks the row. Every step is a
`finish_check` record the host writes (`checking`, then `accepted`, `rejected` or `unanswered`, with
the round, the reasons, the count and the reviewer); a claim no engine here can review, or one whose
model can't hold the brief, asks nothing and records nothing. The whole check fits inside the lead's one call (`LEAD_CALL_MS`,
the bridge's deadline, or the lead's turn when it ends first): a claim with less than
`FINISH_REVIEW_MIN_MS` left for the reviewer after the observers, the margin and the close is no
claim and records nothing (its answer says whether the call or the turn left no time). A claim on a
run already closing opens no round; a check whose run closes under it settles nothing, one whose
turn ends while the run goes on (`abandoned`) is settled as no answer, and either way the run's
reviewer is stopped (`engine.abort {reviewer}`). A yes the caller finds no longer stands (`lapsed`) is
settled as no answer, the count untouched. The caller keeps the
`FinishTally` in its journal (`tallyOf`, saved as a round starts), so a resumed Loop goes on
counting; a finished run reopened for a new ask starts its no's over, its round numbers going on;
a round's number also goes on past the newest the run's log holds, whatever journal kept the count.
Chat turns get no check.

The leads claim through `finish`. The director checks a `finish victory=yes` whenever it comes
(`director/finish-claim.ts` `checkClaim`); a Finish asked of
the run (the person's, or the chat's agent's `finish_run`) closes it with no check and so with no
victory. The check runs within the lead's turn (`turn-ends.ts`, or the run's own deadlines for a kept
wake loop), after the finish moment, the goal gate and the ship gate and before
the close; proof files the claim names that git does not track stay out of the build
(`keepProofOut`): the reviewer reads the integration worktree with the
lead's edits committed, the files named in `proof`, the finish moment's notes and pictures, and
Genex's look at the build. A yes closes and lands as before; a no is the tool's answer and the run
goes on; the third in a row closes it with `victory: false`, `stoppedBecause` "the reviewer did not
accept the finish" and what isn't done in its summary and the report's `notDone`. A claim with no
time left in the call or a working turn for a review is not counted (the lead calls again, in its
wrap-up for a turn, which says how many minutes a claim needs; the art director's review then stands
on the head, so its gate is skipped); one in the run's last turn closes as no claim, the report saying
the time ran out; one no engine here can review closes as no claim; each close without a yes tells
the lead why first. `victory=no` asks no reviewer. The lead's edits are committed before the
art director's gate. The close after a claim keeps its settle, the readers' stop, its look, its
judge when the head still owes one and the landing (`closeMsOf`); the close waits for that judge until
`claimJudgeBy` and no longer, and a close still running at the call's end (`closedBy`) answers the
lead that the run is closing and lands after it. One close and one finish run at a time
(`director/close-latch.ts`; a close that fails before its run is finished lets go, so a later close
tries again): a second finish is refused at once, a close asked while one is under way waits for it,
a run that starts closing while the gates look or the reviewer reads answers that it closed, and a yes
for a head that moved meanwhile is no answer and asks the lead to claim again. A close that joined one
that then failed tries once more, a crash's close waits for one under way, the wake loop wakes no lead
once a close has started, `integrate` merges nothing more, and a close that lands another head than
the one the reviewer read (`reviewed`) is no victory. A later close after a no (the clock's, or a
session that ended) puts the reasons in `notDone` and its summary. `LoopRunState.finishTally` is journaled beside `jobsCursor`. The
Unreal lead's own `finish` (`unreal/lead-finish.ts`) fires the finish moment, then checks the claim
on the game's folder within the turn that claims: a yes ends the run as `goal-reached`, the third no
as `not-done`, a claim no engine here can review as `no-reviewer` (each ends the lead's turn), a
time-up after a no puts the reasons in `notDone` and the summary, a run
or turn that ended while the reviewer read ends nothing more, a claim the run's last turn has no time
to review is told so (the wrap-up asks for claims early enough), and `LeadJournal.finishTally` keeps the
count. Its start says `finishCheck: true`, so its graph is a tree from the start. The critic stays
advice.

The open Loop. `runDirector(ctx, { …, profile: LoopProfile.Open })` runs the director's wake loop on a
project that isn't a web game, led in place (`loop/director/open/`). `prepareLoopRun` branches inside `director/setup.ts` (`prepareOpenLoopRun`, its state helpers
being that module's): the game as `game.list` lists it, its hours held to `MAX_RUN_HOURS`, the run's
`budgets.creditCap` set to `DEFAULT_CREDIT_CAP` (600) before `run_started` when the record names none
(less what an Unreal runner's jobs spent, on the resume that converts its journal),
`autopilot_started.profile: "open"`, Genex's snapshot of the folder before the first turn (`run
<id>: before the Loop`), `journal.director.open` (`OpenJournal`: save points, what to do between
turns, carried lines) and the run's worker pool (`runPool`, the Workers role, the run's credit cap,
one git-write queue for its merges and the lead's saves, a worker's end a `worker_ended` line). No
scaffold, contract, preview, ledger or integration worktree: `integrationWorktree` is the game folder
and the journal's `integrationHead` is null, so the host reads the folder for the run's files, and
after the Loop the chat's own session keeps `run_status` alone (`runControls.inPlace`), never a reopen.
`run.prepare` fires as for any run; a plugin's block closes the Loop before any turn with its reason
and "Then start the Loop again." (a resumed Loop stays paused, its working time as it was, also on the
app's clock through the close's `workedUntil`, and Genex's own hold says to press Resume), keeping
nothing; so does a Stop while it prepares, and a Stop before it fires no plugin's `run.prepare`. The lead is the chat's own session with `director.inPlace` and the
game folder as `root` (no `cwd`, no `readOnly`; the host's in-place seat), every delegation carrying
the run's credit cap; its brief (`openBrief`) names the goal, the time, the folder's facts, what the
plugins said at the start, `references/`, the plugins' worker types and its finish, and, when no
plugin hooks `checkpoint.before`, that Genex's save points keep the files on disk only. Its tools are
the director's `note` and `run_status` by name, the six worker tools through the pool (a copy's
`worker_mark used` merges into the game folder, refused over the lead's uncommitted edits of the same
files) and its own `finish` (`summary`, `proof`): the finish moment, then `checkFinish` on the game
folder, its review ending `OPEN_CLOSE_MS` before the call's and the turn's end (no answer when the
claim's turn ended or a recovery took the folder back meanwhile); a yes or the stopping no closes in
place inside the call, which answers that the Loop is closing should the close outlast it
(`closeInPlace`: the pool closed, the last work kept in a checkpoint when the folder changed or a
plugin saves the app, `run_finished` with `profile`, `landed` as any save point or that checkpoint
once the Loop ends, never while it is paused, `report.json`), and a Stop or a lost provider pauses it
as the director's close decides. A close first waits for a way back a recovery already queued, then,
unless the lead already heard of it (`wentBackUnheard`), keeps nothing over the folder it took back
and says so; a completed close names a rewind or restart it came before. The wake loop
counts the pool's running workers and the run's running jobs for it (`open/active-work.ts`), and
`run.end` stays the teardown's, which removes no worktree.

The open Loop's turns. A turn lasts at most `OPEN_TURN_MS` (45 minutes; `wake.ts` `turnDeadline`):
one cut there is no failure (`TurnFacts.capped`, judged when the session returned; a turn a plugin
held back never is) → `TurnEnd.Continue` and the lead is woken at once with `WakeCause.TurnCap`; a
web lead's turns keep no cap. A rate limit or an outage is waited out against the working time, on the Loop's clock, the retry
with a fresh cap. A turn that did something (`TurnFacts.worked`, from what the lead did: a rewind or
restart newly asked, a claim turned down, a worker marked, or the folder's content changed since the
turn began (a tree of it, `OpenFolderMark`, read again at the turn's start after a rest); a save point
over unchanged content is none; a change nobody else made is the lead's when its own session acted in
the turn (a tool call, `OpenLoop.sessionActed`) or it kept a save point, and at most
`MAX_FOLDER_ONLY_TURNS` in a row when its session only answered; a change made while a writer in place,
a job one of them started or a recovery may have written (`open/writers.ts`; the lead's own jobs and a
copy worker's or reader's are not; who waits on the person is read from the chat's log at each turn's
edge) counts only while none of them can still write (a writer waiting on the person can't),
`MAX_UNCLEAR_TURNS` in a row, and beside only jobs ended writers left running the lead's own save point
counts (it hears which job holds it and `job_stop`); a turn whose edges git read two ways counts as
unclear when the lead acted; a turn in which a recovery took the folder back counts only the lead's own
acts and save points; an autosave only when it kept what the turn's end didn't show; a nested
repository's own changes count (with the folder's ignore rules), and no read writes into the game's
object store: the run's reads share a store of their own in the game's git folder, removed at the close)
goes on at once (`TurnEnd.CarryOn`), the question of what next unspent; neither it nor `TurnCap` counts in the hourly
wake cap. A quiet turn is asked it, and a second wraps up, its words saying why (`openClosing` by
`WrapCause`). Under ∞ an idle lead rests until something happens instead. The person's finish reaching a resting
lead opens its last turn. A lead whose game folder
another chat's turn holds waits for it within its working time, outside the outage ladder
(`waitsForFolder`), never a failed turn; a Stop during the wait opens no session, and one before any
session of this attempt worked keeps nothing and spends none of its hours. No finish mark or art director wakes it, and its wrap-up asks for a claim only
if the goal is reached. Its wake messages are
`openDigest` (`open/digest.ts`: the person's words first, news no turn took, the lines Genex carried,
its latest save points with the rest counted, a fresh-look reminder after `FRESH_EYES_MS` with no read-only worker, its own
wrap-up and idle question). `save_point {label, summary, shows?}` is Genex's checkpoint on the git-write
queue (the plugins' steps around the snapshot; their notes in the answer, their pictures the round's
thumbnails on the "lead" part, `facet_iteration` and `integration_merge`; the host keeps them as the
observer's capture); a block or Genex's hold keeps nothing and says why. `shows` names the picture in
the folder that shows the change (a PNG or JPEG really inside it, read before the snapshot): it is
the round's `shown` picture, apart from the thumbnails; a save point without one is answered with a
reminder, and one naming no readable picture says why. `pause {why}` is for what only the person
can do (a tool, editor or app the work needs is gone, an install, a permission): it sets
`OpenLoop.halted` to the lead's words, so the Loop closes paused with them as the reason once the
turn ends, and its acts are refused meanwhile, as below. `rewind {label}` and
`restart` (offered only when a plugin hooks `restore.*`) only note what the turn's end runs (a rewind
keeps the snapshot its label named when asked; a Stop leaves it unrun, and the resumed brief says so):
`LoopRun.afterTurn` (`open/between.ts`, which the wake loop awaits; a look at the app the turn started
settles first, and no recovery starts during it) first autosaves a turn that kept no save point (the
folder changed, or `onlyIfUnsaved` where a plugin saves the app; never while a writer in place works),
then restores the save point (`snapshot.restore`, then `waitReady`; Plan mode holds it even where no
plugin hooks `restore.*`) or fires `restore.before` and `restore.after` with no file changed, both
waiting while a writer in place works, each outcome a carried line. When the turn kept a save point
(its own or the autosave) and the folder was not taken back, the judges the game's engine plugin
declares (`game.list`'s `judges`, on a game marked `editorPlay`) play it one at a time
(`open/judge-rounds.ts`): each a blind `judge_play` naming its judge, its answer recorded as a run check
and carried to the lead. A round starts only with `ROUND_MIN_MS` (3 minutes) of working time left and
no finish asked for, plays no judge past the working time, and a Stop, a hold or the close ends it
before the next judge. A game with no judges (Unreal, a web game) has no rounds; the lead's
`judge_play` is offered for any game marked `editorPlay` (an older host's: an Unreal game), naming the
game's judges by id. `finish` waits for that turn's
end and for a writer in place, and a timed Loop's claim waits for its last turn. The health
watch (`open/health.ts`) rides the wake loop's rounds and a turn's, one look at a time beside them
(never awaited): `health` every `HEALTH_POLL_MS` when hooked, never once the Loop closes or its
finish is checked; a block says so at once (`NoteKind.AppStopping`, which wakes no one),
fires `crash` and waits until the app answers (`MAX_REOPENS`), then goes back to the last save point
there was when it saw the crash (its writers in place stopped first; the lead told as the restore lands;
a close or a Stop before the restore's turn on the git-write queue takes nothing back; a merge of a
worker's copy whose turn comes once the Loop pauses or closes lands nothing),
else pauses the Loop with the reason (`OpenLoop.halted`: the lead's own session under way aborted,
`engine.abort {cwd, lead}`, again each watch round until it ends, as after a Stop; an outage wait ends
at its next step; no session opens, and `save_point`, `rewind`, `restart`, `finish`, `worker_start` and
`worker_mark` are refused, as once the Loop closes; the close paused); a crash step Genex held pauses in its hold's words and
goes back nowhere. The recovery runs beside the wake loop (`open.recovering`), counted as work at
hand (a lone lead rests until it is back): the person's words still wake the lead, `save_point` and
`finish` are refused meanwhile, the turn's end keeps and restores nothing, and only the way back takes
the git-write queue. Once the Loop begins to close it stops at its next step (its waits for the app
too), says nothing and keeps no journal; the teardown waits for it a while (`settleRecovery`). A
closing Loop's lead hears no more news. While a turn works, `open/news.ts` steers (`interrupt: false`, once each) a pool
worker's end and question (`NoteKind.WorkerAsks`), a job's end, the app's crash
(`NoteKind.AppCrashed`) and a reminder `SAVE_REMINDER_MS` after the last save point; a line the
session read (`DelegateResult.steered`) is not told again, one it never read rides the next digest:
an engine that can't read mid-turn (Codex, Bonsai) hears news only when its turn ends, at most
`OPEN_TURN_MS` later. The person's words do cut such a turn, its first included
([hearing it](conversation-coordinator.md#live-chat-during-a-build)).

One Loop for every project. Run dispatch (`conductRun`) takes the game from the list it already
read and its profile (`loopProfileOf`): a web game keeps the director on an engine that keeps a
session and classic Autopilot on a direct engine or `run.classic`; any other project runs the open
Loop on an agent engine the host seats in place (`leadsInPlace`: Claude Code, Codex, OpenCode), and on
any other (Ollama, Bonsai, OpenRouter) closes at once saying it needs one (`RunnerKind.NeedsSession`), which the chat's launch says before it promises anything
(`launchFromIntake`). Classic is a web game's internal only, and the gauntlet works on web games only
(`RunnerKind.WebOnly`). An open Loop whose parts include a kept older one without `SERVES_OPEN_LOOP`
is refused with words (the chat's launch says so before its promise, `openLoopServed`); a resume
refused at its start stays paused and keeps its earlier report (`refusedRun` writes its close over the
latest one, keeping only what was built, `KEPT_ON_REFUSAL`: never how that session stopped, its provider
limit included; a refused reopen of a landed build keeps its outcome and the chat says why). A journal the host can't read, or a game list it can't give, refuses
the run with words (a resume stays paused), and the refusals name what makes the project's Loop work
in place (`openLoopBecause`). A resume goes on in its journal's profile (`resumedProfile`): a Loop that worked in place goes on in place whatever the folder reads as
now; any other journal is a web Loop's, and on a folder that reads otherwise stays paused (a
finished one's reopen is refused before any promise, and a Loop message starts the next Loop there), its journal untouched, and
so does one the open setup can't pick up (`refuseResume`), while one no version reads closes for
good. A Loop in place runs no self-improvement pass, and Genex's `web.ready` gate reaches only a web
game's Loop. ∞ runs an open Loop until a reviewer accepts its finish, 24 hours at most: the lead may
claim at any time, an idle lead rests, and a time-out with no yes closes in the Loop's own words with
no reviewer asked. The chat's launch words and its launch promise describe the lead building in place, workers in
copies and a reviewer checking its finish (`loop/open-loop-prompts.ts`). A run the Unreal runner paused (`kind:
"unreal-lead"`) resumes in the one Loop: `director/open/older-journal.ts` turns its run, worked time,
save points, reviewer's no's and carried lines into a director journal, and closes the run at once
with words when it can't read them. For developers only, `STUDIO_UNREAL_RUNNER=lead` (handed on like
`STUDIO_DIRECTOR_LOOP`; never a run record field) still sends a new Loop on an Unreal project, and the
resume of a run that runner wrote, to the Unreal runner (`loop/loop-switch.ts`) until a live Unreal
Loop passes on the one Loop. Through the real studio (`one-loop-projects.test.ts`), a Loop on the toy
plugin's project, and on a copy of that plugin with every tool renamed, runs the plugin's steps at its
moments, its worker type and its observer, and ends on the reviewer's yes with no seed change; a Loop
on a Godot folder with its plugin off runs with Genex's own tools, lends no window and writes no web file.

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

The studio's look at a running worker (`director/workers.ts` `lookAtWorker`) reads `git status`
with every untracked file named, so a part's bench page in a new `bench/` folder (`loop/bench.ts`)
is its own file; the template's rules for game code (one seed, the step clock, tags) skip bench
files, which the game never loads. A steer that interrupts a worker's review fix or regression
revert is handed over in the same session and the turn goes on (`loop/facet/follow-up.ts`); only a
stop with no steer waiting ends the round. A round the run's own close stops (a pause, the end)
keeps its work on its `…-stopped` ref with `stopCode: run_ended` on its records; the resumed lead
hears that commit (`journal-prompts.ts`). Nobody judged it, so it goes in only once a judge prefers
it to the integration branch (`judge target=<id> against=integration`, then `integrate`:
`director/kept-judge.ts`), or inside a judged worker started from it; never by a merge by hand. Once
the build holds it the studio records an `integration_merge` for its part (`director/kept-work.ts`),
and tells the lead if it went in with no judge: Builds shows it Paused until then, Added after, Left
out only if the run ends without it. A judge's look at a part that does not own the entry, like its
own rounds' looks, reads cameras that all show one frame as a warning (`facet/camera-wiring.ts`), and
only the part that draws the HUD (critic=screen, a restart of it, or the entry's owner while no
part of the run owns the screen: `director/hud-owner.ts`) is held to the HUD's coverage and overlap.

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
worker=a,b` merges a wave in order with one health pass. Running loop workers take the newest
integration head at each round, the lead's own commits too (`director/workers.ts` `freshBase`), so a
merge never lands behind the lead's commits; while a worker's merge waits for its health pass they
keep the head before it (`director/merge-hold.ts`; after a wave a conflict stopped, until a look sees
the head load or the lead calls `wave=close`),
and a head a health pass saw fail gives way to the one the last healthy wave closed on (a healthy
integrate, or `wave=close`). A merge's health pass runs
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
Its mined tasks leave out the `build_observation`s of a game whose Loop works in place
(`loopProfileOf`: not a web game): they are what the web preview saw of its root.
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

The chat's own session, answering a turn on a delegated engine, may start workers. The harness
claims `workers` (`loop/main.ts`), opens a pool for the turn before its session starts and closes
it when the turn ends, failure and Stop included (`loop/workers/chat-workers.ts`
`withChatWorkers`). While the pool is open the turn's delegation carries `workers: { tools }`. The
host hands those tools only to the chat's own session answering that turn, only the six worker
tools, and never to a worker (depth one). Each call is forwarded as the `worker_tool` dispatch to
the pool of that turn; a call for any other turn starts nothing.

The pool (`loop/workers/pool.ts`, `pool-start.ts`, `pool-merge.ts`) runs as many workers at once
as the person's Settings allow (`preview.capacity` `workers`, the ceiling the host keeps per chat on
its workers, readers and writers alike), at most `MAX_WORKERS_AT_ONCE` (8): `worker_start`'s
description says the number, and a start past it is refused in its own answer, before anything is made. A chat turn on a local model's engine opens no pool: only a
delegated engine carries a worker's seat.

- `worker_start {title, task, isolation, type?, research?, inputs?}`: a reader (`read`) works in the
  game folder, read-only, with web search only when `research` is `yes`. A writer in a copy
  (`copy`) works in a copy made by `snapshot.worktree` after a game snapshot, under the copy
  rules and size cap above; a refused copy is answered by its code, pointing at `lock` or a
  reader. The one writer in place (`lock`) works in the game folder, one at a time per game across
  the chat's and its runs' pools: `locks.hold` takes the host's in-place lock and the game's
  plugin locks (answering their labels, written as the start record's `where`), never waiting, and
  `locks.release` at its end or the pool's close lets them go (an older host keeps one per pool). A
  `type` names a kind of worker a plugin that is on declares (`plugins.workerTypes`); it gives
  that kind's tools (`toolAllow`) and its isolation.
- Every worker's delegation carries the `worker` grant (`{id, title, turn, research}`), which the
  host honours by seating it in the chat's permission mode.
- `worker_status` and `worker_wait` (at most `MAX_WORKER_WAIT_S`) read each worker's line. A worker
  whose question waits in the chat (a pending `tool_permission` row naming it) shows as waiting for
  the person, and `worker_wait` wakes for it. An ended worker keeps its own last words
  (`WorkerRecord.report`, up to `WORKER_REPORT_CHARS`) and a copy the files its work changes
  (`changed`): `worker_status <id>` answers them in full, `worker_wait` answers them for each worker
  that ended while it waited, and the list of every worker names each by its report's first sentence.
- A worker's brief says its turn is its whole job: never ended to wait, never waiting by sleep or a
  background command. A worker's Claude Code session that a background task woke after its input
  ended (no tool call can be answered then) ends not ok, saying so, with its last words kept
  (`claude-code.ts` `wokeAfterEnd`); a lead's or the chat's session keeps its last result's verdict.
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
kept playbook or journal may say) and adds `worker_mark`. Its `worker_start` takes `task` (a kept
prompt's `brief` is still read), `isolation` and `research`: `copy`, the default, is its builder in
its own worktree; `read` starts a reader from the run's shared pool (`loop/workers/run-pool.ts`,
`director-pool.ts`) in the game folder, which never integrates, and may research the web; `lock` is
refused, because the web method never writes in the game folder itself. A web run takes no plugin
worker types. A loop worker's `minutes` are fitted to whole rounds of the game once a round has been
measured (`whole-rounds.ts` `wholeRoundsBudget`: the nearest number of rounds `tooLateToStart` will start,
at least one, within the run's time; the answer's `rounds` says how many), so no part-round at the end
goes unused. `worker_mark used` integrates the builder as
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

A Loop's hours are a soft cap, one rule for every Loop (`loop/time-cap.ts` `capClock`,
`director/cap-lines.ts`): the cap is the hours in working time, ∞ capped at `UNTIL_DONE_CAP_MS` (24
hours). `HEADS_UP_MS` (15 minutes) before it the lead hears mid-turn that little is left (none for a
Loop of 15 minutes or less); at the cap it hears that the time is up, and `worker_start` is refused
from then on. A turn whose engine reads that line goes on into `GRACE_MS` (15 minutes) of grace; one
whose engine can't is cut short (never inside a tool call or a claim's check), and its wrap-up turn
opens with the line, as does any turn that never took a line it was due. A wrap-up that began before
the cap (the person's Finish, an idle lead, a failed turn) hears no line and is never cut for it, and
a turn that may run to the grace's end is the run's last for a claim. At the grace's end Genex closes
the Loop; its report's `notDone` holds the reviewer's last no, else, when no claim reached a reviewer
since the run last opened, that no reviewer read one, which its summary says too; an open Loop keeps
its last save point. Whether the time ran out, and whether a worker may start, are read on the run's
own clock (the wake loop's). The time's-up tells the lead to call finish, claiming the goal only if it
is reached. A Resume past the cap gets the grace only; a clock
a kept older setup made (`journal.ts` `loopRunClock`, its wrap-up inside the hours) hears no lines.
A claim (`victory=yes`) is checked whenever it comes, and a yes ends the Loop; a `finish` that claims
nothing is refused while working time remains unless the user asked: Finish, or `user_asked` quoting
the user's own words from a message delivered into the run (`integrate.ts` `userQuoted`, checked
against the run inbox's steers). However a run ends — the lead's `finish`, the
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

The user asks to finish in the chat, and only the lead can tell such an ask from a question: its
card says an ask to finish, wrap up or stop adding (asked again as a question too) is `wrap_up`
first. `wrap_up` (`director/wrap-up.ts`) records the ask quoting the user's words (checked like
`user_asked`) as the same `run_control` finish the app's own door writes, once. From then
`worker_start` is refused (a conflict worker excepted), each running loop worker ends the round it
is in and stops at its next round's gate (`workers.ts` `workerStopAsk`: the user's ask, never the
director's stop), no regular art-director look comes, the digest says the run is finishing, and the
lead rests while those rounds land, woken as each ends (`afterTurn` `lastRoundsRunning`); once no
loop worker runs the wrap-up starts (`WrapCause.Finish`), and its finish stops a single session. Its
own ask is no news to it. A finish the user asked for claims nothing (no reviewer checks it, so the
wrap-up invites no claim). `finish user_asked=` still stops everything at once. An open Loop offers
`wrap_up` too, and starts no worker once anybody asked to finish; its wrap-up starts when the turn
that recorded the ask ends.

The art director is the one absolute judge (`loop/ship-review.ts`, rubric `judge/ship-review.md`):
one build, every frame the evidence pass took of a registered camera, the player's eyes and each
demo's end, then the first, middle and last motion frames and the reference (at most 14), captured
at 1600×900 on that lease only (`SHIP_VIEW`), asked "would you ship this as the user's demo
today?" with the user's scope beside the goal, at no more than high effort, as every reviewer
(deeper ones outlast its few minutes). Each defect names a plan part (kept only when it is
one of the plan's ids), a camera (kept only when the review was shown it, else the default) and a
severity (`blocker`, `visible`, `nit`); an unreadable answer is no verdict, never a "no". The lead
asks for it with `judge ship=yes`, alone (no blind comparison; an `against` other than `none` is
refused, since the other build was seen at 960×600), and its look never replaces a pick or answer
already standing on that head (`state.lastJudge`). The studio runs it itself at the
finish mark (`director/art-direction.ts`): a timed build's last 30% of working time
(`budgets.ts` `finishMarkMs`, 30 to 120 minutes, none under 90), said once (`WakeCause.FinishMark`,
journaled; a mark that finds nothing integrated leaves the lead to `judge ship=yes` itself; a mark
still unsaid once the wrap-up is due, after a sleep or a Resume, gives way to the wrap-up); a goal
build once, when its lead idles a second time or calls `finish` with no review on its head (a
blocker turns that finish back once, never twice, and never the user's own finish). A claim
(`victory=yes`) is refused while the review on its head names a blocker (`shipClaimRefusal`): a goal,
∞ included, ends once its required outcomes are verified and the art director names no blocker. That finish gate runs
inside the `finish` call: its one look also answers the close's own question, so the close does not
judge again, and when the close still owes a blind judge against the start there is no time for
both and the finish closes without the art director. The
lead is woken with the defects by part and the rule from there: no new parts, `worker_steer
stage=finish` on each owner, integrate, `judge ship=yes` again. Every later wake repeats it: the
time line says the build is past the mark, the room for workers offers only finish workers, the
idle question asks to finish what exists instead of a next feature, no worker line shows its
reviewers' next big step (a finishing worker's never does, and its line says `stage finish`), and a
timed build's card says its finish stage. A goal commission's card and brief say the art director's
blockers are required finishing; its visible flaws and nits go in the report and never start a round.
The rubric calls a defect a blocker only when the game does not do what the goal asks or reads as
broken at once, and `ship` is true when none is. Each blocker on the integration
branch becomes a director-origin vision check on its running owner's board (the part's worker, or
the running worker that replaced it; its fix is a strong flip), and its owner is told in words that
follow the verdict (it must be gone before the part is done, beside a building worker's move; from
the finish look on every owner is told as a finisher), or a ledger line under its finished
part or the lead; a visible flaw or a nit stays on the review alone. A loop worker started on that
part later (its id, `replaces` chain or goal) takes the part's ledger lines onto its board the same
way (a non-blocker shelved by an older run leaves the ledger), so a finish worker ends only once each
blocker is gone. A review with a verdict replaces the earlier reviews' questions
on running boards (one it repeats word for word keeps its id), so re-reviews never pile up. One
look is one judge verdict record, asking the ship question. `state.lastShip` is journaled and
restored on a Resume; `report.shipReview` and the `finish` answer say whether the art director
would ship the head the close stood on, how many blockers it names and how many flaws and nits are
for the report. It never vetoes a landing.
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

**Judges that play.** `loop/hands-on-judge.ts` sends a blind `judge` (computer tool only, stepped
clock, no setup script) into a build with a quest the studio checks after every move; a direct
engine plays the same tool through `preview.computer` (`loop/computer-loop.ts`), as the direct
playtester does when the host serves it. A quest is set for one question (`quest.checkId`, or the
only one asked): its "yes" passes only when `trace.reachedAt` is set and the frame it cites, read
by `preview.statsOf` from the trace row that saved it at or after that move, is lit; otherwise it
is unmeasured. Every other answer is the model's word (`model-said`). No window is unmeasured,
never a fail. The director's `playtest goal_state=…` uses it, as does the integration play when a
play check says `"reaches":"setup"` and the run's setup has a `verify` (otherwise the playtester
plays). Facet scoring escalates an unmeasured or below-0.5 picture answer to one probe per pass
(`loop/vision-escalation.ts`, at most 8 a run, counted in the journal's run): a probe has no quest,
so what it resolves is recorded `model-said` at 0.4; a confident answer is never overturned, and a
flip stands only when a second picture look at the probe's frames agrees. A verified session is
kept as a route (`loop/routes.ts`): its computer calls, replayed at the end of every leased
evidence pass one at a time through a fresh `preview.computer` session (judge, stepped, the kept
quest); an older host is reported, not replayed. A deterministic route that misses the goal fails
a check naming the step and the replay's trace, a non-deterministic one is only reported, and
three divergences retire it. The host keeps `objective: "studio-verified"` only for a trace it saw
reach its goal. A run turns all of this off with `handsOnJudges: false`.

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
and a usage cap still stops the worker with its limit for the lead. While it waits a director's
worker's clock stands still (`facet/paused-clock.ts`): its deadline moves on by what the wait took,
up to the run's working deadline, as the outage ladder's waits do. A worker the provider ended before
any round of it was judged gives its goal attempt back (`attempt-refund.ts` `refundProviderAttempt`), so a
restart is never refused for progress it never had the chance to make.

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
