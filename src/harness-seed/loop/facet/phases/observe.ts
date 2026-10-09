/** Evidence for the round, with patience for a blind camera, and whether the build it saw can be judged at all. */
import { gatherEvidence, observationOnlyFailure, withObservationPatience } from "../../evidence.ts";
import { demosNamedByChecks } from "../../spec.ts";
import { racesThrottleBot } from "../../throttle-bot.ts";
import { statePathsNamedByChecks } from "../../state-shape.ts";
import { normalizeReason } from "../../replan.ts";
import { GIT, commitAll, shortSha } from "../../git.ts";
import { StopCode, stopWith } from "../../outcomes.ts";
import { RunEvent } from "../../run-events.ts";
import { CLIP_REASON } from "../../text.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import { FacetRole, type FacetLoop, type FacetRound } from "../state.ts";
import { RoundFlow } from "../flow.ts";
import { BuildFailure } from "./build.ts";
import { MOTION_FRAMES } from "../policy.ts";
import { brokenStreakWords } from "../rules.ts";
import { roundFields } from "../record.ts";

/** Observation outages in a row that stop the facet: the challenger is held in the worktree, unjudged. */
const OUTAGES_TO_STOP = 2;
/** The WebGL errors a broken build's report quotes. */
const GPU_ERRORS_QUOTED = 3;

/** Evidence, with patience for a blind camera: an observation outage holds the challenger unjudged; a broken build is said in its own errors. */
export async function gatherRoundEvidence(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { budgets, ctx, deadline, emitLoopState, facet, run, stoppedHere } = loop;
  // ── evidence, under the preview lock when facets share one view ──
  ctx.setStatus(`run ${run.runId} · ${facet.title} — verifying`);
  emitLoopState("verifying", round.iteration);
  round.gatherOnce = () => gatherOnce(loop, round);
  round.evidence = await withObservationPatience(ctx, round.gatherOnce, {
    deadline,
    delays: budgets.observationDelays,
  });

  // A camera that stayed blind through the backoff indicts the observation layer, not the
  // build: hold the challenger unjudged — no verdict, no commit, no reset.
  const blind = !round.evidence.ok && observationOnlyFailure(round.evidence.problems);
  if (!round.buildFailed && blind) return holdUnjudged(loop, round);
  loop.observationOutages = 0;
  await notePartialWork(loop, round);
  judgeBrokenness(loop, round);

  // No verdict is spent on a round the run has already stopped — and none is needed: the
  // judge would keep the incumbent and the rollback would erase what the builder wrote.
  if (await stoppedHere(round.iteration)) return RoundFlow.Stop;
}

/** One evidence pass over the challenger, under the preview lock; a pass that throws is a failed pass, never a crash. */
async function gatherOnce(loop: FacetLoop, round: FacetRound): Promise<AnyRecord> {
  const { baseConsole, ctx, facet, facetSetup, handle, legacy, previewLock, role, run, seed, spec, worktree } = loop;
  const release = await previewLock();
  try {
    return await gatherEvidence(ctx, {
      run,
      iterationId: round.iterationId,
      seed,
      ...(handle ? { handle } : {}),
      ...(worktree ? { root: worktree } : {}),
      labelPrefix: `facet_${facet.id}/iter_${round.iterationId}`,
      cameras: legacy ? null : spec.cameras,
      eyes: true,
      motion: legacy ? 0 : MOTION_FRAMES,
      audio: !legacy,
      // Every demo a check names runs; the integration facet — the only judgeable build of
      // the merged game — runs all of them. Under the cap, a demo this challenger added runs
      // before the ones the accepted build already showed.
      requiredDemos: demosNamedByChecks(spec.checks),
      knownDemos: loop.incumbentEvidence?.registeredDemos ?? null,
      // A board that carries `throttle-bot-loses` races the throttle-only bot (evidence.ts).
      challenge: racesThrottleBot(spec.checks),
      // The paths the board reads are cut last when the state is over the studio's budget.
      keepPaths: statePathsNamedByChecks(spec.checks),
      ...(role === FacetRole.Integration ? { maxDemos: Infinity } : {}),
      setup: facetSetup,
      // An error the incumbent (or the base, before any incumbent) already logs is the
      // build's, not this challenger's: one shader line in a base nobody owns must not cost
      // every worker its first iteration.
      // `consoleBaseline` is every message the incumbent logged; `consoleErrors` is the last
      // five a prompt shows — a baseline built from five forgives the wrong ones.
      inheritedConsole: [
        ...(loop.incumbentEvidence?.consoleBaseline ?? loop.incumbentEvidence?.consoleErrors ?? []),
        ...(Array.isArray(baseConsole) ? baseConsole : []),
      ],
    });
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
  } finally {
    release();
  }
}

/** The observation layer is down: the challenger is held unjudged, and a second outage in a row stops the facet with it kept. */
async function holdUnjudged(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, result } = loop;
  await appendRun(RunEvent.FacetObservationOutage, {
    ...roundFields(loop, round.iteration),
    problems: round.evidence.problems,
  });
  loop.lastFailure = null;
  loop.engineFailures = 0;
  loop.observationOutages += 1;
  if (loop.observationOutages < OUTAGES_TO_STOP) return RoundFlow.Next;
  stopWith(
    result,
    StopCode.ObservationDown,
    `the observation layer is down (${round.evidence.problems[0]}) — the challenger is held in the worktree unjudged`,
  );
  if (loop.worktree) await keepHeldChallenger(loop, round);
  return RoundFlow.Stop;
}

/** The held challenger, committed and kept reachable, and the stop reason says where it is. */
async function keepHeldChallenger(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, facet, git, gitOptions, gitWhere, keepReachable, result } = loop;
  try {
    await commitAll(
      ctx,
      gitWhere,
      `facet ${facet.id} iteration ${round.iteration}: held challenger — observation outage, unjudged`,
      { allowEmpty: true, ...gitOptions },
    );
    const held = await git(GIT.head);
    await keepReachable(held);
    result.stoppedBecause += ` (preserved as commit ${shortSha(held)})`;
  } catch {
    /* preservation is best-effort; the stop reason above still tells the truth */
  }
}

/**
 * A build turn the clock cut short still left its edits on disk. If that build boots, it is
 * evaluated like any other — partial work can win instead of being discarded as broken.
 */
async function notePartialWork(loop: FacetLoop, round: FacetRound): Promise<void> {
  const cutByClock = Boolean(round.buildFailed) && round.buildEngineError?.kind === BuildFailure.Deadline;
  round.partialWork = cutByClock && round.evidence.ok;
  if (!round.partialWork) return;
  await loop.appendRun(RunEvent.FacetPartialEvaluated, {
    ...roundFields(loop, round.iteration),
    reason: round.buildFailed,
  });
}

/** WP1d: a build that cannot be judged says so in its own errors, and the same cause twice ends the facet. */
function judgeBrokenness(loop: FacetLoop, round: FacetRound): void {
  const { policy } = loop;
  round.challengerBroken = (Boolean(round.buildFailed) && !round.partialWork) || !round.evidence.ok;
  round.brokenDetail = null;
  if (!round.challengerBroken) {
    loop.brokenStreak = { reason: null, count: 0 };
    return;
  }
  round.brokenDetail = brokenDetailOf(round);
  const { evidence } = round;
  const reason = normalizeReason(
    round.buildFailed ?? evidence.consoleErrors?.[0] ?? evidence.problems?.[0] ?? "unjudgeable",
  );
  const count = loop.brokenStreak.reason === reason ? loop.brokenStreak.count + 1 : 1;
  loop.brokenStreak = { reason, count };
  if (count >= policy.brokenStreakLimit)
    loop.circuitBreak = `${brokenStreakWords(policy.brokenStreakLimit)} with the same cause: ${reason}`;
}

/** The actual errors of a build that cannot be judged, for the next brief. */
function brokenDetailOf(round: FacetRound): string {
  const { buildFailed, evidence } = round;
  return [
    buildFailed ? `build turn: ${buildFailed}` : "",
    evidence.problems?.length ? `problems: ${evidence.problems.join("; ")}` : "",
    evidence.consoleErrors?.length ? `console errors: ${evidence.consoleErrors.join(" | ")}` : "",
    evidence.state?.error ? `window.__studio_error: ${String(evidence.state.error).slice(0, CLIP_REASON)}` : "",
    evidence.gpuErrors?.length ? `WebGL: ${evidence.gpuErrors.slice(0, GPU_ERRORS_QUOTED).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
