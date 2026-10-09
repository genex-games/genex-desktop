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
- **Colour tweaker**: the developer panel for tuning colour presets live, hidden in code between
  tuning sessions (`COLOR_TWEAKER_ON` in `src/renderer/appearance/tweaker/ColorTweakerHost.tsx`;
  how to use it in [design](design.md)).

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
- **Lead / one session**: a waking run's director that is its chat's own session, leaving the
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

## The Unreal Loop

A Loop in a game that builds in Unreal ([plugins](../plugins.md#mcp-servers)): no facets, judges
or worktree merges, though the Builds graph draws it with the same records.

- **Unreal lead**: the one session that builds the whole game in the open editor, in turns of the
  same session, looking at its own captures (`loop/unreal/lead.ts`, its tools `lead-tools.ts`, its
  brief `lead-prompts.ts`). Not the web run's **Lead / one session**, which leaves building to its
  workers.
- **Save point**: the lead's own checkpoint: save all, the log's new errors, a game-folder snapshot
  under its label and the hero cameras' shots, drawn as a round it kept itself; `rewind` restores
  one (`loop/unreal/save-point.ts`, `restore.ts`). The harness autosaves a dirty turn that made none.
- **Milestone**: what the lead says it works on now; a row of the Builds graph
  (`loop/unreal/lead-graph.ts`).
- **Sub-agent**: a small job of one `AgentKind` (Blender model or prep, Genex cast, sound,
  texture, C++) the lead starts in a copy of the game, offered only its kind's plugin tools; its
  delivery lands in `assets/agents/<id>/` with a manifest (`loop/unreal/agents.ts`).
- **Critic**: fresh-eyes advice on the lead's captures against ART.md and `references/`; it
  changes nothing and is never a verdict (`loop/unreal/critic.ts`).
- **Hero cameras**: the level's `GX_Shot_*` cameras the lead places; its `capture_shot` looks
  through them, and every save point keeps their shots (the plugin's `hero-shots`).

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
