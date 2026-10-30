/**
 * The gauntlet — one unattended run (PLAN.md §8.1).
 *
 * Faithful to gauntlet-loop's rules, which exist to stop an agent from congratulating itself for
 * hours:
 *   - a **fresh-context critic** looks at the actual output next to the actual reference;
 *   - the comparison is **blind** — labels stripped, order shuffled;
 *   - the critic returns **a pick and the single biggest remaining gap**, never a score
 *     ("scores out of 10 drift upward every round");
 *   - the run exits on a blind win, not on a round count.
 *
 * Our addition, because gauntlet-loop has no tie or regression handling: **the incumbent only
 * advances on a clear win.** A tie, a judge error, or a broken build all keep the incumbent and
 * roll the workspace back, so a run of work can never end below where it started.
 */
import { roleEffort, roleEngine, RoleKey } from "./model-roles.ts";
import { buildTurn } from "./build-turn.ts";
import { Side } from "./judge.ts";
import { EngineFailure } from "./outage.ts";
import { Against, againstWords, observedFrom, VerdictPass, verdictRecord, VerdictRule } from "./verdict.ts";
import { StopCode, stopWith } from "./outcomes.ts";
import { appendRun, EventKind, RunEvent, RunMode } from "./run-events.ts";
import { HostMethod } from "./host-methods.ts";
import { ProjectStarter } from "./folder-facts.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS, sleepUnlessCancelled } from "./time.ts";
import { BriefPhase, buildBrief } from "./gauntlet-prompts.ts";
import { gatherEvidence, observationOnlyFailure, withObservationPatience } from "./evidence.ts";
import { RoundFlow } from "./facet/flow.ts";
import { PAGE_SEED } from "./config.ts";
import { clip, CLIP_REASON } from "./text.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { Evidence, Shot } from "./evidence.ts";

// Engine failures come in bursts — a dead login, an hour-long throttle. After this many build
// turns in a row lost to the engine itself, another retry is denial, not persistence.
const MAX_ENGINE_FAILURES = 3;

/** Observation outages in a row that mean the observation layer is down, not blinking. */
const MAX_OBSERVATION_OUTAGES = 2;
/** How many earlier gaps ride into a brief. */
const GAP_HISTORY_LENGTH = 4;
/** A rate limit's wait when the engine names none. */
const RATE_LIMIT_WAIT_MS = MINUTE_MS;
/** The share of the wall clock left at which the run stops adding and starts integrating. */
const INTEGRATION_SHARE = 0.15;
/** Why a run the user asked to finish stopped, as the chat reads it. */
const FINISHED_AT_REQUEST = "finished the current attempts at the user's request";

/**
 * Everything the classic run shares with the other modes about LOOKING at a build — the evidence
 * pass, its failure classifier, the patience around it, the setup replay and the page probes —
 * lives in evidence.ts. It is exported from here too, under the names it always had here: a
 * harness file the in-app agent edited before the move still imports it from this module.
 */
export {
  EMPTY_SCENE_PROBE,
  MISSING_CONTRACT,
  STEP_WITNESS,
  applySetup,
  classifyEvidenceFailure,
  consoleProblems,
  gatherEvidence,
  observationOnlyFailure,
  proveStep,
  withObservationPatience,
} from "./evidence.ts";
/** Nested repositories a build does not carry: git.ts, exported here for the files that import it from here. */
export { unversionedNested } from "./git.ts";
/** The builder's brief: gauntlet-prompts.ts, exported here for the files that import it from here. */
export { buildBrief } from "./gauntlet-prompts.ts";

/**
 * The classic run's state across iterations: its constants (ctx, run, deadline, report, …)
 * beside what every iteration changes (incumbent, incumbentEvidence, biggestGap, the outage
 * counts). runGauntlet documents each field where it sets it.
 */
type GauntletLoop = AnyRecord;
/** One iteration's own state: its number and what its phases hand on to each other. */
type GauntletRound = AnyRecord & { iteration: number };
/** What the run hands its caller at the end, before the report is published. */
export interface GauntletFinal {
  report: AnyRecord;
  incumbent: AnyRecord | null;
  incumbentEvidence: Evidence | null;
  startingSnapshot: AnyRecord | null;
  startingEvidence: Evidence | null;
}
/** How a classic run is started: fresh, or resumed from the progress an earlier process saved. */
export interface GauntletOptions {
  threadId: string;
  run: Run;
  beforeFinalPublication?: ((final: GauntletFinal) => Promise<void>) | null;
  origin?: string | null;
  creativeDeadline?: number | null;
  resumeState?: AnyRecord | null;
  onProgress?: ((progress: AnyRecord) => unknown) | null;
}

/** A classic run's wall clock when its budget names none: shorter than a director's or autopilot's day. */
const CLASSIC_WALL_CLOCK_MS = 4 * HOUR_MS;
/** A classic run's iteration budget when its budget names none. */
const DEFAULT_MAX_ITERATIONS = 200;

/**
 * Run the classic gauntlet: build, look, and keep the build when it runs (Loop phase 4: no blind
 * judge picks between it and the incumbent, and no panel judges it against the reference). A kept
 * build is the run's: its builder's turn decided when it was done.
 */
export async function runGauntlet(ctx: HarnessCtx, options: GauntletOptions): Promise<AnyRecord> {
  const { threadId, run, origin = null, creativeDeadline = null } = options;
  const resumeState = options.resumeState ?? null;
  const started = Date.now();
  const report: AnyRecord = resumeState?.report ?? {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    reference: run.reference?.name ?? "unnamed",
    iterations: [],
    victory: false,
    stoppedBecause: "",
  };

  await announceRunStart(ctx, threadId, run, origin);
  // Ensure the project exists and is on screen before anything is judged.
  await ctx.call(HostMethod.GameScaffold, {
    name: run.project as string,
    title: run.project,
    kind: ProjectStarter.Web,
  });
  await ctx.call(HostMethod.PreviewLoad, { project: run.project });

  const loop = await openGauntletLoop(ctx, options, { started, report, creativeDeadline });
  for (let iteration = (report.iterations?.length ?? 0) + 1; iteration <= loop.maxIterations; iteration++) {
    const round: GauntletRound = { iteration };
    const flow = await playIteration(loop, round);
    iteration = round.iteration;
    if (flow === RoundFlow.Stop) break;
  }
  return finishGauntlet(loop);
}

/** The `run_started` record: what the run is, who builds and judges it, and its reference and budgets. */
async function announceRunStart(ctx: HarnessCtx, threadId: string, run: Run, origin: string | null): Promise<void> {
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.RunStarted,
        payload: {
          runId: run.runId,
          goal: run.goal,
          project: run.project,
          ...(run.engine ? { engine: run.engine } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.roles ? { roles: run.roles } : {}),
          ...(run.judgeModel ? { judgeModel: run.judgeModel } : {}),
          ...(run.builderEngine ? { builderEngine: run.builderEngine } : {}),
          ...(run.judgeEngine ? { judgeEngine: run.judgeEngine } : {}),
          reference: {
            name: run.reference?.name,
            shots: run.reference?.shots ?? [],
            notes: run.reference?.notes,
            kind: run.reference?.kind,
            frameCount: run.reference?.frames?.length ?? 0,
          },
          budgets: run.budgets,
          ...(origin ? { mode: RunMode.Autopilot, origin } : {}),
        },
      },
    ],
  });
}

/** Stamp when the run finished and how long it took. */
function finishReport(report: AnyRecord, started: number): void {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
}

/** The `run_finished` record, carrying the report. */
async function announceRunFinished(ctx: HarnessCtx, threadId: string, report: AnyRecord): Promise<void> {
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report }],
  });
}

/**
 * The run's own state across iterations: what the run set up, and what every iteration
 * changes. A resumed run takes its incumbent and its starting point from the saved progress.
 */
async function openGauntletLoop(
  ctx: HarnessCtx,
  options: GauntletOptions,
  { started, report, creativeDeadline }: { started: number; report: AnyRecord; creativeDeadline: number | null },
): Promise<GauntletLoop> {
  const { threadId, run, beforeFinalPublication = null, origin = null, onProgress = null } = options;
  const resumeState = options.resumeState ?? null;
  const loop: GauntletLoop = {};
  loop.incumbent =
    resumeState?.incumbent ??
    (await ctx.call(HostMethod.SnapshotCreate, {
      scope: "both",
      reason: `run ${run.runId}: starting point`,
      project: run.project,
    }));
  // The judge must never compare against a ghost. The first run's judge saw one side described
  // as "snapshot: <id>" and nothing else — so probe the starting build once, and from then on
  // carry the accepted build's evidence forward with the snapshot.
  loop.incumbentEvidence = resumeState ? (resumeState.incumbentEvidence ?? null) : await startingEvidenceOf(ctx, run);
  loop.biggestGap = run.reference?.notes ?? "no analysis yet — start from the reference";
  // A broken iteration is reported to the next brief as a failure, never as the creative gap:
  // "Request timed out." is not a design verdict, and a builder told to "close" it will drift.
  loop.lastFailure = null;
  // Build turns lost to the engine itself, counted consecutively — one recovered turn proves
  // the engine is alive and earns it a fresh allowance.
  loop.engineFailures = 0;
  loop.observationOutages = 0;
  // Judge calls lost to outage, counted consecutively across both judge modes — any real
  // verdict proves the judge is alive and clears the count.
  loop.judgeOutages = 0;
  loop.firstOutageIteration = 0;
  // Everything the iterations share, on the run's own object: its constants beside what the
  // iterations change (`loop.incumbent`, `loop.incumbentEvidence`, …).
  Object.assign(loop, {
    ctx,
    threadId,
    run,
    beforeFinalPublication,
    origin,
    creativeDeadline,
    resumeState,
    onProgress,
    started,
    deadline: creativeDeadline ?? started + (run.budgets?.wallClockMs ?? CLASSIC_WALL_CLOCK_MS),
    maxIterations: run.budgets?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    seed: PAGE_SEED,
    report,
    startingSnapshot: resumeState?.startingSnapshot ?? loop.incumbent,
    startingEvidence: resumeState?.startingEvidence ?? loop.incumbentEvidence,
    // The last few real gaps ride into every brief: one sentence of memory per iteration makes a
    // builder overcorrect back and forth (too warm → too dark → too warm) instead of converging.
    gapHistory: [] as Array<{ iteration: number; gap: string }>,
  });
  return loop;
}

/** The starting build's evidence, or null when it could not be looked at. */
async function startingEvidenceOf(ctx: HarnessCtx, run: Run): Promise<Evidence | null> {
  try {
    const evidence = await gatherEvidence(ctx, { run, iterationId: "000", seed: PAGE_SEED });
    return evidence.ok ? evidence : null;
  } catch {
    /* an unprobeable starting state just means iteration 1 argues against nothing — honestly */
    return null;
  }
}

/** Close the run: say why it stopped, hand the final state to the caller, then publish the report. */
async function finishGauntlet(loop: GauntletLoop): Promise<AnyRecord> {
  const { ctx, threadId, run, report, started, beforeFinalPublication } = loop;
  if (!report.stoppedBecause) stopWith(report, StopCode.IterationsSpent, "iteration budget exhausted");
  finishReport(report, started);
  report.finalSnapshot = loop.incumbent.snapshot_id;
  if (beforeFinalPublication)
    await beforeFinalPublication({
      report,
      incumbent: loop.incumbent,
      incumbentEvidence: loop.incumbentEvidence,
      startingSnapshot: loop.startingSnapshot,
      startingEvidence: loop.startingEvidence,
    });
  await announceRunFinished(ctx, threadId, report);
  await ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: "report.json",
    base64: Buffer.from(JSON.stringify(report, null, 2)).toString("base64"),
  });
  return report;
}

/**
 * What one iteration of the classic run does, in order. Each phase reads and writes the run's
 * state (`loop`) and this iteration's (`round`), and answers `RoundFlow.Stop` to end the run,
 * `RoundFlow.Next` to go on to the next iteration, or nothing to hand on to the next phase.
 */
const ITERATION_PHASES = [
  openIteration,
  buildIteration,
  lookAtChallenger,
  judgeChallenger,
  keepOrRestore,
  recordIteration,
  endOnAKeptBuild,
  checkEngineHealth,
];

/** Play one iteration: its phases in order, until one of them ends it. */
async function playIteration(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  for (const phase of ITERATION_PHASES) {
    const flow = await phase(loop, round);
    if (flow) return flow;
  }
  return null;
}

/** The iteration's gate — the user's wrap-up, a stop, the clock — and its brief. */
async function openIteration(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, deadline, gapHistory, report, run, started } = loop;
  if (await ctx.runInbox?.finishing()) {
    stopWith(report, StopCode.FinishRequested, FINISHED_AT_REQUEST);
    return RoundFlow.Stop;
  }
  if (ctx.cancelled) {
    stopWith(report, StopCode.UserStop, "stopped by the user");
    return RoundFlow.Stop;
  }
  if (Date.now() > deadline) {
    stopWith(report, StopCode.Budget, "wall-clock budget exhausted");
    return RoundFlow.Stop;
  }

  ctx.setStatus(`run ${run.runId} · iteration ${round.iteration} — building`);
  round.iterationId = String(round.iteration).padStart(3, "0");
  round.phase = briefPhase({ iteration: round.iteration, started, deadline, wallClockMs: run.budgets?.wallClockMs });
  round.guidance = (await ctx.runInbox?.steering()) ?? [];

  // Keep the worker task independent of user messages arriving in the parent chat.
  round.taskBrief =
    (round.guidance.length ? `USER STEERING:\n${round.guidance.join("\n")}\n\n` : "") +
    buildBrief({
      run,
      iteration: round.iteration,
      biggestGap: loop.biggestGap,
      phase: round.phase,
      lastFailure: loop.lastFailure,
      gapHistory,
      acceptedShots: (loop.incumbentEvidence?.shots ?? []).map((shot: Shot) => shot.path).filter(Boolean),
    });
}

/** The build turn on the thread; a sign-in that expired, a stop or the clock ends the run here. */
async function buildIteration(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, deadline, report, run, threadId } = loop;
  round.buildFailed = null;
  round.buildEngineError = null;
  round.buildOutcome = null;
  try {
    // The thread's own turn, opened and closed by buildTurn (closed as an error when it fails).
    round.buildOutcome = await buildTurn(ctx, {
      delegated: false,
      engine: roleEngine(run, RoleKey.Builder),
      prompt: round.taskBrief,
      project: run.project,
      threadId,
      runId: run.runId,
      model: run.model,
      // The builder works on exactly the run's model and effort — no silent "low" floor.
      effort: roleEffort(run, RoleKey.Builder),
      metadata: { runId: run.runId, iteration: round.iteration, phase: "build" },
      // A delegated build must not outlive the run: its time budget is whatever is left on
      // this run's clock.
      deadlineMs: deadline,
      turn: {
        text: round.taskBrief,
        iteration: round.iteration,
        // The requested state: the builder's window opens where the run is about.
        ...(run.setup ? { setup: run.setup } : {}),
      },
    });
  } catch (err: any) {
    round.buildFailed = err?.message ?? String(err);
    // The engine's own failures are the run's problem, not the challenger's — kept apart so
    // the health policy below never bills a broken build to the engine. An abort is the
    // user's stop, already handled on its own path.
    round.buildEngineError = typeof err?.kind === "string" && err.kind !== EngineFailure.Aborted ? err : null;
  }
  // An expired sign-in fails every later delegation the same way — the next iteration would
  // walk into the same wall, and only a human can open it.
  if (round.buildOutcome?.stopped === "needs_signin") {
    stopWith(report, StopCode.SignIn, "Claude sign-in expired — sign in and press Start again");
    return RoundFlow.Stop;
  }
  // A stop that landed mid-build must not spend minutes probing and judging a build the
  // user has already walked away from.
  if (ctx.cancelled) {
    stopWith(report, StopCode.UserStop, "stopped by the user");
    return RoundFlow.Stop;
  }
  // The loop head last read the clock before the build began — a long turn can overshoot
  // the whole budget by its own length. Look again before minutes go into judging.
  if (Date.now() > deadline) {
    stopWith(report, StopCode.Budget, "wall-clock budget exhausted");
    return RoundFlow.Stop;
  }
}

/** Evidence, with patience for a blind camera: an observation outage holds the build unjudged, twice stops the run. The attempt is snapshotted before any verdict. */
async function lookAtChallenger(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, run } = loop;
  // ── evidence: the build must at least load and keep the contract ──
  ctx.setStatus(`run ${run.runId} · iteration ${round.iteration} — judging blind`);
  round.evidence = await challengerEvidence(loop, round);
  // A camera still blind after the backoff is an observation outage, not a losing build:
  // hold the challenger on disk unjudged and let the next iteration's working camera decide.
  // Two outages in a row mean the observation layer is down, not blinking — stop honestly
  // rather than spending paid build turns nobody can judge.
  const onlyTheCameraFailed =
    !round.buildFailed && !round.evidence.ok && observationOnlyFailure(round.evidence.problems);
  if (onlyTheCameraFailed) return holdForObservationOutage(loop, round);
  loop.observationOutages = 0;
  round.challengerBroken = Boolean(round.buildFailed) || !round.evidence.ok;
  // Snapshot the attempt *before* the verdict so a losing challenger is still playable in
  // the morning. Restore after a loss wipes the working tree; the stills alone are not a game.
  round.attemptSnapshot = await snapshotAttempt(ctx, run, round.iteration);
  // Capture the incumbent's stills before a win overwrites the carried-forward evidence.
  round.incumbentShots = loggedShots(loop.incumbentEvidence?.shots);
}

/**
 * The challenger's evidence, with patience for a blind camera. A dead preview (window closed,
 * renderer gone) must cost this iteration, not the run: an uncaught throw here would skip
 * run_finished and report.json entirely.
 */
async function challengerEvidence(loop: GauntletLoop, round: GauntletRound): Promise<AnyRecord> {
  const { ctx, deadline, run, seed } = loop;
  return withObservationPatience(
    ctx,
    async () => {
      try {
        return await gatherEvidence(ctx, { run, iterationId: round.iterationId, seed });
      } catch (err: any) {
        return {
          ok: false,
          problems: [`evidence pass failed: ${err?.message ?? err}`],
          shots: [],
          state: null,
          stateEarly: null,
          consoleErrors: [],
          gpuErrors: [],
        };
      }
    },
    // run.classic is frozen: no race backoff here, so this pass is behaviourally what it was.
    { deadline, delays: run.budgets?.observationDelays, raceDelays: [] },
  );
}

/** An observation outage: the build stays on disk unjudged; the second in a row stops the run. */
async function holdForObservationOutage(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, report, run, threadId } = loop;
  await appendRun(ctx, threadId, RunEvent.ObservationOutage, {
    runId: run.runId,
    iteration: round.iteration,
    problems: round.evidence.problems,
  });
  loop.lastFailure = null;
  loop.engineFailures = 0;
  loop.observationOutages += 1;
  if (loop.observationOutages < MAX_OBSERVATION_OUTAGES) return RoundFlow.Next;
  // The sentence the owner reads at the close is a sentence, not a diagnosis: the problem
  // itself is on the `observation_outage` event above and in the report.
  report.observationOutage = { problem: clip(round.evidence.problems[0], CLIP_REASON) };
  stopWith(
    report,
    StopCode.ObservationDown,
    "the studio could not see the game to judge it, so it stopped instead of building blind — the last build is kept on disk",
  );
  return RoundFlow.Stop;
}

/** A game-scope snapshot of the attempt, unhealthy until it wins; null when it could not be taken. */
async function snapshotAttempt(ctx: HarnessCtx, run: Run, iteration: number): Promise<AnyRecord | null> {
  try {
    return await ctx.call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId} iteration ${iteration}: challenger attempt`,
      project: run.project,
      healthy: false,
    });
  } catch {
    return null;
  }
}

/** The verdict a broken challenger gets without a judge: the incumbent, and why. */
function brokenVerdict(round: GauntletRound): AnyRecord {
  return {
    pick: Side.Incumbent,
    confidence: "high",
    biggest_gap: round.buildFailed
      ? `the build turn failed: ${round.buildFailed}`
      : `the build does not run: ${round.evidence.problems.join("; ")}`,
    reason: "challenger did not produce a judgeable build",
  };
}

/** A broken build keeps the incumbent; a build that runs is kept — no judge is asked (Loop phase 4). */
async function judgeChallenger(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  round.verdict = round.challengerBroken
    ? brokenVerdict(round)
    : {
        pick: Side.Challenger,
        confidence: "high",
        biggest_gap: loop.biggestGap,
        reason: "the build runs, so it is kept — nobody judges it",
      };
}

/** A kept build is the new incumbent; a broken build restores the incumbent. The gap and the failure the next brief carries. */
async function keepOrRestore(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, gapHistory, run } = loop;
  round.challengerWon = round.verdict.pick === Side.Challenger;
  if (round.challengerWon) {
    loop.incumbent = await ctx.call(HostMethod.SnapshotCreate, {
      scope: "both",
      reason: `run ${run.runId} iteration ${round.iteration}: the build runs and is kept`,
      project: run.project,
      healthy: true,
    });
    loop.incumbentEvidence = round.evidence;
  } else {
    // BROKEN ⇒ KEEP INCUMBENT. Nothing is ever lost: the attempt stays in the log and in git
    // history, the working tree goes back to the best known version.
    // Game scope only: losing a round is a verdict about the game, not about the coder —
    // rewinding the harness with it would erase self-edits the round never judged. The run's
    // starting-point snapshot stays scope "both"; that one is the morning catastrophe anchor.
    await ctx.call(HostMethod.SnapshotRestore, {
      snapshotId: loop.incumbent.snapshot_id,
      project: run.project,
      scope: "game",
      reason: `run ${run.runId} iteration ${round.iteration}: challenger did not win`,
    });
    // The restore above must surface loudly if it fails — a run that cannot roll back is
    // broken. The reload is only the user's view of it: with the window closed it throws,
    // and the next evidence pass reloads anyway.
    try {
      await ctx.call(HostMethod.PreviewReload, {});
    } catch {
      /* a dead preview costs nothing here */
    }
  }
  // The carried gap stays a creative verdict: a broken iteration's reason goes into
  // lastFailure for the next brief, and the log keeps it on the iteration record.
  if (round.challengerBroken) {
    loop.lastFailure = round.verdict.biggest_gap ?? null;
  } else {
    loop.lastFailure = null;
    if (round.verdict.biggest_gap && round.verdict.biggest_gap !== loop.biggestGap) {
      gapHistory.unshift({ iteration: round.iteration, gap: round.verdict.biggest_gap, won: round.challengerWon });
      if (gapHistory.length > GAP_HISTORY_LENGTH) gapHistory.pop();
    }
    loop.biggestGap = round.verdict.biggest_gap ?? loop.biggestGap;
  }
}

/** The iteration's record: the artifact, the event, the notify and the progress callback. */
async function recordIteration(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { ctx, onProgress, report, run, startingEvidence, startingSnapshot, threadId } = loop;
  round.record = {
    iteration: round.iteration,
    iterationId: round.iterationId,
    runId: run.runId,
    project: run.project,
    winner: round.challengerWon ? Side.Challenger : Side.Incumbent,
    biggest_gap: round.verdict.biggest_gap ?? loop.biggestGap,
    reason: round.verdict.reason ?? "",
    // No judge is asked any more; an older record may name one.
    judgeCall: null,
    snapshot: loop.incumbent.snapshot_id,
    attemptSnapshot: round.attemptSnapshot?.snapshot_id ?? null,
    shots: loggedShots(round.evidence.shots),
    incumbentShots: round.incumbentShots,
    state: round.evidence.state,
    consoleErrors: round.evidence.consoleErrors,
    gpuErrors: round.evidence.gpuErrors,
    // Its rounds reach the same cards as a worker's: it writes the same record, so nothing on
    // screen has to know which ran.
    verdict: verdictRecord({
      pass: VerdictPass.Round,
      round: round.iteration,
      against: againstWords(round.iteration === 1 ? Against.Start : Against.Round),
      ...observedFrom(round.evidence),
      pick: round.verdict.pick ?? null,
      judgeCalls: 0,
      kept: round.challengerWon,
      rule: iterationRule(round),
      gap: round.verdict.biggest_gap ?? "",
    }),
  };
  report.iterations.push(round.record);
  await ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: `iter_${round.iterationId}/verdict.json`,
    base64: Buffer.from(JSON.stringify(round.record, null, 2)).toString("base64"),
  });
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.RunIteration, payload: round.record }],
  });
  ctx.notify("run.iteration", round.record);
  if (onProgress)
    await onProgress({
      report,
      incumbent: loop.incumbent,
      incumbentEvidence: loop.incumbentEvidence,
      startingSnapshot,
      startingEvidence,
    });
}

/**
 * A kept build ends the run: its builder's turn decided it was done, and no judge or panel asks for
 * another round (Loop phase 4). A broken one goes on to the next iteration.
 */
async function endOnAKeptBuild(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  if (!round.challengerWon || round.challengerBroken) return;
  // The user asked to finish while it built: the run ends at their request, and says so.
  if (await loop.ctx.runInbox?.finishing()) stopWith(loop.report, StopCode.FinishRequested, FINISHED_AT_REQUEST);
  else stopWith(loop.report, StopCode.Done, "the build runs and is kept: nobody judges it");
  return RoundFlow.Stop;
}

/** The rule a classic iteration's verdict record names. */
function iterationRule(round: GauntletRound): VerdictRule {
  return round.challengerBroken ? VerdictRule.Broken : VerdictRule.NoRegression;
}

/** Engine health: a throttled or dead engine must not eat the run one lost turn at a time. */
async function checkEngineHealth(loop: GauntletLoop, round: GauntletRound): Promise<RoundFlow> {
  const { report } = loop;
  // ── engine health: a throttled or dead engine must not eat the run one lost turn at a
  // time ──
  if (!round.buildEngineError) {
    loop.engineFailures = 0;
    return;
  }
  // A weekly/session usage cap outlives the run — no strikes, no backoff, honest stop.
  if (round.buildEngineError.kind === EngineFailure.UsageLimit) {
    stopWith(report, StopCode.UsageLimit, `the engine is out of usage: ${round.buildFailed}`);
    return RoundFlow.Stop;
  }
  loop.engineFailures += 1;
  if (loop.engineFailures >= MAX_ENGINE_FAILURES) {
    stopWith(
      report,
      StopCode.EngineExhausted,
      `the engine failed ${loop.engineFailures} build turns in a row — last: ${round.buildFailed}`,
    );
    return RoundFlow.Stop;
  }
  if (round.buildEngineError.kind === EngineFailure.RateLimit) await backOff(loop, round);
}

/**
 * Wait out a rate limit. The engine's own "come back later" beats a guess (same policy as the
 * judge), and the wait never outlives the run's clock. The pause is logged — a silent hour of
 * sleep reads as a wedge — and sliced so a Stop still lands within moments.
 */
async function backOff(loop: GauntletLoop, round: GauntletRound): Promise<void> {
  const { ctx, deadline, run, threadId } = loop;
  const waitMs = Math.min(round.buildEngineError.retryAfterMs ?? RATE_LIMIT_WAIT_MS, deadline - Date.now());
  if (waitMs <= 0) return;
  ctx.setStatus(`run ${run.runId} · rate limited — retrying in ${Math.ceil(waitMs / SECOND_MS)}s`);
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.RunBackoff,
        payload: { runId: run.runId, iteration: round.iteration, waitMs, message: round.buildFailed },
      },
    ],
  });
  await sleepUnlessCancelled(ctx, waitMs);
}

/** Which brief an iteration gets: the first playable, the last stretch's integration pass, or the next gap. */
function briefPhase({
  iteration,
  started,
  deadline,
  wallClockMs,
}: {
  iteration: number;
  started: number;
  deadline: number;
  wallClockMs?: number | null;
}): string {
  if (iteration === 1) return BriefPhase.First;
  const remaining = deadline - Date.now();
  const total = wallClockMs ?? deadline - started;
  const closingIn = iteration > 1 && total > 0 && remaining < total * INTEGRATION_SHARE;
  if (closingIn) return BriefPhase.Integrate;
  return BriefPhase.Gap;
}

/** Paths, sizes and pixel stats — the JPEG itself stays out of the event log. */
function loggedShots(
  shots: readonly Shot[] | null | undefined,
): Array<Pick<Shot, "camera" | "path" | "bytes"> & { stats: Shot["stats"] | null }> {
  return (shots ?? []).map(({ camera, path, bytes, stats }) => ({ camera, path, bytes, stats: stats ?? null }));
}
