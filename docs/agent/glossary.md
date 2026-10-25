# Glossary

House terms for developers, one line each with the file that owns the concept. Harness paths are
under `src/harness-seed/`. User-facing wording is translated in `src/renderer/words.ts`, which
is product copy, not this glossary.

## The app and its agents

- **Studio**: the Electron app itself (`src/main/studio-core.ts` assembles it). Also the name of
  the app-wide assistant room, a tool-free chat about runs and learning (`loop/studio-chat.ts`).
- **Harness**: the in-app agent's own code, seeded from `src/harness-seed/` into an editable
  workspace and run as a sandboxed child (`src/substrate/harness-host.ts`,
  `src/harness-boot/bootstrap.mjs`). It reaches the app only through substrate RPC.
- **Substrate**: host services under the harness: event store, snapshots, workspaces, engines,
  sandbox and the RPC it calls (`src/substrate/`; the RPC handlers in `src/main/harness-rpc/`).
- **Seed / applySeed**: the shipped harness source and the upgrade that copies it into the
  editable workspace while keeping the agent's edits (`src/substrate/seed-upgrade.ts`).
- **Seed contract**: a rule both the app and the harness apply (coordinator tools, the message
  queue, model roles, skill edits). The app keeps a typed copy in `src/shared/` and never loads
  the seed's; `tests/conformance/seed-contracts.test.ts` holds the two copies together.
- **Coordinator**: a read-only session of its own that answers a game's chat for a run no lead of
  the chat's own led (the long turn, the classic pipeline, a kept older seed), or a message on
  another engine than the lead's, with the run's controls (`loop/coordinator.ts`). With Loop on
  after a finished build that seated a lead, a coordinator that answers in a session reopens that
  run through `continue_build` (**Reopen**). The fallback, which the long turn's removal keeps
  ([harness runtime](../harness-runtime.md)); the queue (`loop/message-queue.ts`) owns the
  conversation's order
  ([conversation lifecycle](../conversation-coordinator.md)).
- **Wedge**: the harness stopped sending heartbeats. The watchdog calls `recover()`, which
  rewinds the harness to its newest healthy snapshot and restarts it
  (`src/substrate/harness-host.ts` `onWedged`, `src/main/core/recovery.ts`).
- **Engine**: a model provider adapter, direct (completion) or delegated (session)
  (`src/substrate/engines/types.ts`, `registry.ts`).
- **Plugin skill / file skill**: guidance a plugin gives agents while enabled. An inline skill's
  text rides every brief; a file skill (API 3) puts only its summary there and is read on demand
  through the host-served `<plugin>__skill` tool, never copied into a game
  (`PluginSkill` in `src/shared/plugins.ts`, `src/substrate/plugins/registry.ts`).
- **Host tool**: a bundled Genex tool whose manifest `host` makes Studio run it instead of the
  backend: `genex__cli`, `genex__cli-paid`, `genex__package` (`PluginHostTool`,
  `src/main/core/genex-cli.ts`).
- **Game cover / Genex cover**: two different pictures. The game cover is Studio's own sidebar
  look for a game (a cover sphere from a recipe the builder names with `set_game_cover`, or an
  uploaded image) and never leaves this Mac (`shared/cover-recipe.ts`, `renderer/ui/GameAvatar.tsx`).
  The Genex cover is the one real 16:9 frame genex.games shows for a hosted game, staged by the game
  as its `genex-cover` demo and sent by the Genex plugin (`src/plugins/genex/cover.ts`).
- **Colour tweaker**: the developer panel for tuning colour presets live, hidden in code between
  tuning sessions (`COLOR_TWEAKER_ON` in `src/renderer/appearance/tweaker/ColorTweakerHost.tsx`;
  how to use it in [design](design.md)).
- **Item**: what a game sells for coin in genex.games' store: one SKU (name, description, picture,
  maybe a 3D model and a package, a price or Free, consumable or durable) whose id the game passes to
  `buy({ skuId })`. It has no category; the game decides what it does (`src/shared/store-items.ts`,
  [store](../play.md#the-item-store)).
- **Shared item**: a durable item its author lets other games use ("Other games can use it", the
  `shareable` field). A game that adds one sells it at the author's price and gets the selling game's
  share; turning sharing off stops new adds only.
- **Allowance**: one game's permission to sell and support a shared item, made by Create › Items'
  Add to \<game> (`itemsAddToGame`) or the game agent's `genex items add` (which also puts the
  item's `genex-items/<id>/` in the game); not a purchase or a copy. It is sold there once that game
  promotes a live build made after the add (`ItemAllowance`, `AllowanceState`).
- **Store door**: the viewer bar's Store for a web game that sells items; its Store opens in the
  game's place while the game, hidden, keeps playing ([store](../play.md#the-item-store)).
- **Listing draft card**: the chat card for an item the game's agent made, recorded by main from a
  real `genex shop add|set --json` result only (`item_drafted`, `src/main/core/item-draft.ts`); its Put
  on sale is the person's press, never the agent's.
- **Local draft**: an item made before its game is on Genex (`.genex/items/`); its card's Sell when
  published is an approval in app data (`item-approvals.ts`).

## Runs

- **Run**: one unattended build job with a `runId`, started from chat in Loop mode
  (`loop/main.ts`; summaries in `src/shared/run-summary.ts`).
- **Build**: what the Builds stage shows for one run or build turn: its graph, verdicts and
  resulting game state (`src/renderer/build-progress.ts`, `src/renderer/run-graph.ts`). Not
  `src/main/game-build.ts`, which runs a game's own build step in a shadow copy.
- **Autopilot**: the harness's name for a Loop-mode run and the classic orchestrator used on
  completion-only engines: plan facets, build a base, loop facets, merge (`loop/autopilot.ts`).
- **Director**: one delegated session that conducts a whole run on session-capable engines,
  using the harness machinery as tools (`loop/director.ts`, its parts under `loop/director/`).
- **Run**: the director's run as one explicit object (`prepareLoopRun` in
  `loop/director/setup.ts`); every function of the run takes it first (`loop/director/loop-run.ts`),
  and what needs no run is beside it: `rules.ts` (plan, monitor, landing, defect routing, worker
  spec), `args.ts`, `budgets.ts`, `briefs.ts`, `digests.ts`, `memory.ts` and `tool-specs.ts`.
- **Wake / digest**: how the director's session is driven (`loop/director/wake.ts`). The lead
  ends its turn after each decision and the harness wakes the same session when something happens
  (`wake-schedule.ts` decides when, from typed `NoteKind` lines and timers). The digest opens each
  wake: the user's words verbatim, what happened, where the run stands and a short build card
  (`wake-prompts.ts`). `run.directorLoop: "turn"` (or `STUDIO_DIRECTOR_LOOP=turn` in the studio's
  environment) keeps the older long turn with `worker_wait`.
- **Lead / one session**: a waking web run's director that is its chat's own session, leaving the
  game's changes to its workers while the build runs (`loop/director/lead-session.ts`). After the close the same
  session answers the chat with its hands back and the run's controls — `run_status`,
  `show_build`, `land_build` (`runControls`) and a paused run's recorded `resume_run`
  (`loop/after-loop-run.ts`).
- **Reopen**: a finished build whose journal seated a lead, started again as the same run when a
  Loop message asks for more: the chat's own session records `reopen_run` (workers and judges
  then take the message's picks), or the run's coordinator `continue_build` (the build's own
  models); the chat rewrites the journal with the Loop's fresh budget and completion policy, a
  Loop ∞'s required outcomes left to the lead's first plan for the ask (`loop/reopen-run.ts`,
  `loop/director/reopen.ts`).
- **Run journal**: the durable artifact `autopilot_<runId>` a run resumes from. A director run
  keeps its whole record there (`loop/director/journal.ts`): the time it has worked, so a Resume
  goes on with what the budget has left, its workers, the defects nobody owns, the plan window,
  the log and the wake loop's state.
- **Gauntlet**: the single-builder run with blind judging; also the one-facet case of Autopilot
  (`loop/gauntlet.ts`).
- **Scout**: the read-only session that looks at the running game before planning
  (`loop/scout.ts`).
- **Facet**: a planned slice of a game with its own typed spec, checks, thread and, in parallel
  runs, its own worktree (`loop/spec.ts`, `loop/facet-loop.ts`).
- **Contractor**: the persistent builder session that writes game code for a facet or turn
  (`loop/facet-loop.ts`, `loop/turn-loop.ts`; its page is `src/game-template/CLAUDE.md`).
- **Spike**: a throwaway mini-scene built in isolation when an identity check keeps failing;
  a passing spike becomes a recipe in the technique library (`loop/spike.ts`, `library/`).
- **Judge**: a fresh-context model that compares candidates blind and names defects, never a
  score (`loop/judge.ts`, prompts in `judge/`). The app calls it a reviewer; the harness and its
  prompts keep "judge" on purpose, and `words.ts` `reviewerWords` rewords the harness's sentences
  only when they are shown. Do not rename it in the seed.
- **Scoreboard**: per-iteration pass/fail of each check, compared mechanically between
  iterations (`loop/checks.ts`).
- **Round phase**: one named step of a facet loop's round (`ROUND_PHASES` in
  `loop/facet-loop.ts`), over the facet's state (`loop`) and the round's (`round`). The classic
  run (`PIPELINE_PHASES`, `loop/autopilot.ts`), a gauntlet iteration (`ITERATION_PHASES`) and
  the evidence pass (`LOOK_PHASES`) are lists of named phases the same way.
- **Stop code**: why a loop stopped, as a code from `StopCode` beside the `stoppedBecause` sentence
  (`loop/outcomes.ts`); code decides on the code, never on the sentence.
- **Evidence pass**: one look at a build — load, prove the clock, drive, photograph, read
  (`loop/evidence.ts` `gatherEvidence`), with the one classifier of why a look failed.

## The one Loop

Every project's Loop is the director's wake loop, in one of two profiles (`LoopProfile`,
`loopProfileOf` in `src/shared/project-facts.ts`).

- **Profile**: `web` for a web game at the root beside nothing but `web-game`/`blender-assets`
  facts (an integration copy, builders, judges, landing); `open` for any other project.
- **Open Loop / lead in place**: the open profile (`loop/director/open/`): the chat's own session
  writes in the game folder (`director.inPlace`), in turns of at most 45 minutes, starts workers
  from the run pool (the plugins' worker types among them) and claims `finish`, which a reviewer
  checks. Not the web run's **Lead / one session**, which leaves building to its workers.
- **Save point**: the open lead's checkpoint (`save_point`): Genex's snapshot of the game folder
  with the project's plugins' steps around it; `rewind` goes back to one and `restart` closes and
  reopens the project's app between turns (`open/save-point.ts`, `open/between.ts`). The harness
  autosaves a turn that made none.
- **Fact**: what a project folder holds, `ProjectFact {id, path, source}` (`web-game` at `site`,
  `unreal-project` at `.`; several per folder), from a bounded walk matched against the core table
  and the enabled plugins' `detect` rules, the engine link and a scaffold record
  (`src/shared/project-facts.ts`, `src/substrate/project-facts.ts`). Facts pick the profile and
  scope a plugin's tools, hooks and observers; they suggest, the person decides.
- **Hook**: a plugin's harness tool Genex runs at one of its moments (manifest `hooks`, `HookEvent`:
  `run.prepare`, `checkpoint.before`, `worker.start`…) for the games its facts reach; it may block
  with a reason, add a note or pictures, never rewrite arguments or take a snapshot
  (`src/shared/plugin-hooks.ts`, `src/main/core/plugin-hooks.ts`).
- **Lock**: one holder at a time for what a plugin guards, such as an editor (manifest `locks`
  `{id, label, per, personFirst?}`; tools say which they `need`). Its `personFirst` probe makes the
  agents wait while the person uses it ("Waiting for you to finish in <label>"); a lock grants
  nothing (`src/main/core/plugin-locks.ts`).
- **Observer**: a plugin's quiet harness tool that hands back pictures of a project by its facts
  (manifest `observers`, `src/shared/observers.ts`): evidence the reviewer reads
  (`observers.capture`, `src/main/core/observers.ts`) and the Live view Genex draws for it
  (`src/renderer/live-views.ts`). Genex's own web preview is the built-in `preview` observer.
- **Engine declaration**: a game-engine plugin's manifest `engine` `{id, label, projectFiles, fact,
  projectInFolder, play?, apps?}` (`src/substrate/plugins/engine-manifest.ts`,
  `src/shared/game-engine.ts`). The registry's catalog (`engines()`) lets a game link to it and
  read as an engine game (`isEngineGame`); the core names no engine of its own.
- **Play lane**: an engine editor's one play session, driven only by Genex's six play tools
  (`EnginePlayTool`, `src/shared/engine-play.ts`) through `computer` and `judge_play` under the
  plugin's lock; the editor's own play-driving tools stay hidden from agents.
- **Judge probe**: a plugin judge's quiet harness tool (manifest `judges[].probe`) that measures
  the play once it opens and adds its note and pictures to the judge's first answer
  (`src/main/core/editor-play-session.ts`).
- **Message checkpoint steps**: `checkpoint.before` hooks that opt in with `messages: true`, run
  before each chat message's two checkpoints inside their 30-second wait so Rewind brings back the
  engine's state too (`HookService.prepareMessageCheckpoint`, `src/main/core/rewind.ts`).
- **Bring back newer version**: the undo of a Rewind that put game files back: the files, and
  through the restore steps the engine's state, as they were just before it; the chat stays
  rewound (`ChatRewindService.undo`, `undoRewindRefusal` in `src/shared/chat-rewind.ts`).
- **Genex helper (Roblox)**: the Roblox plugin's Studio plugin (`src/plugins/roblox/helper/*.luau`,
  built into `GenexStudioHelper.rbxmx`), Edit only, talking to the backend over a loopback
  WebSocket (`helper-link.ts`): it binds a game to its Studio and carries scripts, place exports
  and loads, multiplayer tests and model imports.
- **The lead**: the chat's own session leading a Loop, as a web run's **Lead / one session** or the
  open profile's **lead in place**; the role the UI calls Main agent. Run copy says "the lead".
- **Worker**: a session the lead or the chat's session starts (`worker_start`, `worker_status`,
  `worker_stop`), depth one, in the chat's permission mode, standing in the project as a reader,
  in a copy or in place under a lock (`WorkerIsolation`, `src/shared/workers.ts`); a plugin's
  worker types give it tools (`src/main/core/worker-tools.ts`, `loop/workers/run-pool.ts`).
- **Reviewer**: the UI's word for a judge (the Reviewers role); a Loop's reviewer also answers its
  finish check, seated read-only by the host.
- **Finish check**: the lead's `finish` claim checked by a reviewer. The seed asks `finish.review`
  and settles with `finish.settle` (`loop/finish-check.ts`); only the host seats the reviewer and
  writes the `finish_check` record (`src/main/core/finish-review.ts`); three no's in a row since
  the run last opened stop it (`MAX_FINISH_REJECTIONS`, `src/shared/finish-check.ts`), except a
  timed Loop with more than `FINISH_TIME_LEFT_MS` (20 min) left, which keeps working. Builds draws
  it as Checking, Not yet, Done or Stopped (`FinishCheckState`, `FinishLook` in
  `src/renderer/run-tree.ts`).
- **Soft cap**: a timed Loop's hours (`loop/time-cap.ts`): a heads-up 15 minutes before, time's up
  at the cap (no new workers then), 15 minutes' grace (`GRACE_MS`), then Genex closes it with what
  is and isn't done ("not checked by a reviewer" when no claim reached one since it last opened);
  an ∞ Loop's cap is 24 hours. A reviewer's yes ends it early.
- **Unreal runner**: the Unreal lead from before the one Loop (`loop/unreal/lead.ts`: milestones,
  typed sub-agents, the critic, hero-camera captures), reached only through `STUDIO_UNREAL_RUNNER=lead`
  until a live Unreal Loop passes on the one Loop.

## Three meanings of "loop"

- **Loop mode**: the composer switch that makes a message start a run (after a finished build that
  seated a lead, reopen it)
  (`src/renderer/ui/ComposerModeMenu.tsx`; `src/renderer/ui/PromptBar.tsx` sends it as
  `autopilot`). UI "Auto" means Loop off. The UI calls the roles Main agent (orchestrator),
  Workers and Reviewers (judge); run copy says the lead, workers and reviewers.
- **The `loop/` folder**: the harness's policy modules (`src/harness-seed/loop/`).
- **Facet loop**: one facet's build → review → evidence → checks iteration (`loop/facet-loop.ts`).

## Data and profiles

- **Game / project**: "game" in the UI; "project" in code, the game folder's name used as the
  `project` parameter (`src/substrate/game-workspace.ts` `GameWorkspaces`,
  `src/shared/game-library.ts`).
- **Thread / conversation**: the same thing. APIs say `threadId`; the event store stores
  `conversations/<id>/events` (`src/substrate/event-store.ts`); the UI says chat.
- **Fixture profile**: a disposable `studio:dev` profile with scripted engines and native
  actions refused (`scripts/studio-dev.ts`, `src/main/dev/fixtures.ts`,
  `src/main/dev/native-policy.ts`).
- **Live profile**: a `studio:dev --providers live` profile, or the normal app, using real
  accounts. Needs explicit permission.

## Evals

The offline eval harness ([evals](../evals.md)); not the in-app judges, which steer a build.
Avoid "journal" and "scoreboard" here: both are run terms above.

- **Lane**: one way of building a case, a registry row in `evals/lanes.json` (Genex app or raw
  CLI, engine, model, effort, containment); lanes A–D are `genex-claude`, `raw-claude`,
  `raw-codex`, `genex-codex` (`scripts/evals/lanes/`). A lane id is data, never an engine id.
  Not a Genex asset lane: one `genex__asset` operation with its fixed provider and options
  (`LANE_OPTIONS`, `src/plugins/genex/request.ts`).
- **Campaign**: a planned matrix of cases × lanes × reps (× app builds) with seeded order and
  canary brackets, run per provider stream and resumable (`scripts/evals/campaign/`).
- **Exposure**: a case's label saying whether the harness was tuned on it (`none` or
  `dev-tuned (<reason>)`), in `evals/cases.md` (`CaseExposure`, `scripts/evals/cases.ts`).
- **Grader**: an eval-owned, lane-neutral judgement of a run: the prober, the two-family
  checklist grader and the pairwise judge (`scripts/evals/grade/`, `scripts/evals/prober/`),
  trusted only behind a green calibration.
- **Eval ledger**: the local append-only JSONL of closed-schema, metrics-only run, pairwise and
  human rows under `$GENEX_EVALS_HOME/ledger/` (`scripts/evals/ledger/`); only per-release exports
  are committed.
