/** Verify: diffs, checks, vision, play → the scoreboard, a same-session follow-up on a regression, then the acceptance rule and the taste judge. */
import { withObservationPatience } from "../../evidence.ts";
import { facetCompare, Side } from "../../judge.ts";
import { compareScoreboards, isInvisibleDiff } from "../../checks.ts";
import { isTransientProviderError, outageDelays, StopReason } from "../../outage.ts";
import { RunEvent } from "../../run-events.ts";
import { MINUTE_MS, SECOND_MS } from "../../time.ts";
import { CLIP_DETAIL, CLIP_REASON } from "../../text.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { isStopped, RoundFlow, stoppedByUser } from "../flow.ts";
import { FOLLOWUP_MS } from "../policy.ts";
import { VerdictSource } from "../../verdict.ts";
import { diffAgainstIncumbent, scoreEvidence } from "../scoring.ts";
import { noisyRegressions, remeasurable } from "../round-judgement.ts";
import { OutagePhase, recordDecision, roundFields } from "../record.ts";
import { tasteVerdict } from "./taste.ts";
import { lostProviderOf, waitForProvider } from "../provider.ts";
import { registryRefusal } from "../../registry.ts";
import { FacetStage, isZeroDiff, roundStage } from "../stage.ts";

/** A regression is followed up in the builder's session only with this much of the facet's clock left (or a slice of a short one). */
const FOLLOW_UP_MIN_MS = 5 * MINUTE_MS;
/** Verification passes over one build: the first, and one more after a follow-up on a regression. */
const VERIFY_PASSES = 2;
/** A regression is looked at again only with this much of the facet's clock left: one more evidence pass. */
const LOOK_AGAIN_MIN_MS = 3 * MINUTE_MS;

/** Verify: diffs, checks, vision, play → the scoreboard, a same-session follow-up on a regression, then the acceptance rule and the taste judge. */
export async function verifyChallenger(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  // ── verify: diffs, checks, vision, play → scoreboard; then the acceptance rule ──
  round.verdict = undefined;
  round.nextBoard = null;
  round.comparison = null;
  round.diffs = {};
  round.verdictSource = VerdictSource.Checks;
  round.taste = null;
  round.followedUp = false;
  if (round.challengerBroken) brokenVerdict(round);
  else if (loop.legacy) {
    const flow = await legacyVerdict(loop, round);
    if (flow) return flow;
  } else {
    const flow = await scoreboardVerdict(loop, round);
    if (flow) return flow;
  }
  round.won = round.verdict.pick === Side.Challenger;
  round.attemptBoard = round.nextBoard ?? (loop.legacy ? {} : loop.board);
}

/** The challenger did not produce a judgeable build: the incumbent stands, and the verdict says why. */
function brokenVerdict(round: FacetRound): void {
  round.verdict = {
    pick: Side.Incumbent,
    satisfied: false,
    biggest_gap: round.buildFailed
      ? `the build turn failed: ${round.buildFailed}`
      : `the build does not run: ${round.evidence.problems.join("; ")}`,
    reason: "challenger did not produce a judgeable build",
    defects: [],
  };
  round.verdictSource = VerdictSource.Broken;
}

/**
 * A prose-only plan (the v1 rule): the blind A/B facet judge picks, and a judge that cannot answer
 * ties — unless its provider is lost: then the round waits for it (`waitForJudge`).
 */
async function legacyVerdict(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, facet, run } = loop;
  for (;;) {
    try {
      round.verdict = await facetCompare(ctx, {
        run,
        facet,
        challenger: round.evidence,
        incumbentEvidence: loop.incumbentEvidence,
        iterationId: round.iterationId,
      });
      break;
    } catch (err: any) {
      if (isStopped(err, ctx)) return stoppedByUser(loop);
      const waited = await waitForJudge(loop, round, err);
      if (waited?.again) continue;
      if (waited) return waited.flow;
      round.verdict = autoTie(loop, `facet judge unavailable — auto-tie: ${err?.message ?? err}`);
      break;
    }
  }
  round.verdictSource = VerdictSource.Legacy;
}

/** A verdict nobody could give: the incumbent stands and the gap is the one already known. */
function autoTie(loop: FacetLoop, reason: string): AnyRecord {
  return { pick: Side.Incumbent, satisfied: false, biggest_gap: loop.biggestGap, reason, defects: [] };
}

/** What waiting for a judge's lost provider came to: verify again, or the round's end. */
type JudgeWait = { again: true } | { again: false; flow: RoundFlow };

/**
 * A judge (or a follow-up, or a playtester) whose provider is lost — its sign-in, a limit, an
 * outage past the ladder — is no verdict: the round waits for it (facet/provider.ts) and is
 * verified again once it is back, never auto-tied. Null for any other failure, which keeps its own
 * policy.
 */
async function waitForJudge(loop: FacetLoop, round: FacetRound, err: unknown): Promise<JudgeWait | null> {
  const lost = lostProviderOf(loop, err, loop.engineId);
  if (!lost) return null;
  const flow = await waitForProvider(loop, round, lost, OutagePhase.Verify);
  return flow ? { again: false, flow } : { again: true };
}

/**
 * The scoreboard verdict, retried while the judge is overloaded. A judge that answered 529 is
 * waited for, not auto-tied: an auto-tie rolls a good build back and retains it on a branch
 * nobody merges. A judge whose provider is lost is waited for too (`waitForJudge`).
 */
async function scoreboardVerdict(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  let verifyOutages = 0;
  for (;;) {
    try {
      if (await verifyPasses(loop, round)) return RoundFlow.Stop;
      await decideOnBoard(loop, round);
      return;
    } catch (err: any) {
      const next = await afterFailedVerification(loop, round, err, verifyOutages);
      if (!next.again) return next.flow;
      if (next.outage) verifyOutages += 1;
    }
  }
}

/**
 * A verification that threw: a stop ends the round, an overloaded judge is waited out on the
 * ladder, a lost provider is waited for, and anything else is an auto-tie on the record.
 */
async function afterFailedVerification(
  loop: FacetLoop,
  round: FacetRound,
  err: AnyRecord,
  outages: number,
): Promise<JudgeWait & { outage?: boolean }> {
  const { ctx } = loop;
  if (isStopped(err, ctx)) return { again: false, flow: stoppedByUser(loop) };
  if (await waitOutOutage(loop, round, err, outages)) {
    if (ctx.cancelled) return { again: false, flow: outageTie(loop, round, err) };
    return { again: true, outage: true };
  }
  return (await waitForJudge(loop, round, err)) ?? { again: false, flow: outageTie(loop, round, err) };
}

/** Verification that could not finish: an auto-tie, on the record as an outage. */
function outageTie(loop: FacetLoop, round: FacetRound, err: AnyRecord): RoundFlow {
  round.verdict = autoTie(loop, `verification unavailable — auto-tie: ${err?.message ?? err}`);
  round.verdictSource = VerdictSource.Outage;
  return null;
}

/**
 * An overloaded judge is waited for when the run's outage ladder has a step left and the wait
 * ends before the deadline. Answers whether it waited.
 */
async function waitOutOutage(loop: FacetLoop, round: FacetRound, err: AnyRecord, outages: number): Promise<boolean> {
  const { deadline, run, sleepFor } = loop;
  const wait = isTransientProviderError(err) ? outageDelays(run)[outages] : undefined;
  if (wait === undefined || Date.now() + wait >= deadline) return false;
  await announceVerifyOutage(loop, round, { err, wait, attempt: outages + 1 });
  await sleepFor(wait);
  return true;
}

/** The judge is overloaded: on the record, and on the status line with how long the loop waits. */
async function announceVerifyOutage(
  loop: FacetLoop,
  round: FacetRound,
  { err, wait, attempt }: { err: AnyRecord; wait: number; attempt: number },
): Promise<void> {
  const { appendRun, ctx, facet, run } = loop;
  await appendRun(RunEvent.FacetProviderOutage, {
    ...roundFields(loop, round.iteration),
    phase: OutagePhase.Verify,
    wait,
    attempt,
    error: String(err?.message ?? err).slice(0, CLIP_REASON),
  });
  ctx.setStatus(
    `run ${run.runId} · ${facet.title} — judge overloaded, retrying verification in ${Math.round(wait / SECOND_MS)}s`,
  );
}

/**
 * One verification pass, repeated once after a same-session follow-up on a regression. True
 * when the follow-up turn was stopped: the round ends there, recorded as stopped.
 */
async function verifyPasses(loop: FacetLoop, round: FacetRound): Promise<boolean> {
  const { appendRun, budgets, ctx, deadline, facet, run, stoppedHere } = loop;
  for (let pass = 0; pass < VERIFY_PASSES; pass++) {
    await scoreOnce(loop, round);
    if (pass === 0) await lookAgainAtRegressions(loop, round);
    if (!needsFollowUp(loop, round)) break;
    // Regression: not merged, but not a lost iteration either — the builder is asked in
    // the same session to keep the flips and undo the regression, then re-verified.
    round.followedUp = true;
    ctx.setStatus(`run ${run.runId} · ${facet.title} — reverting a regression`);
    await appendRun(RunEvent.FacetFollowup, {
      ...roundFields(loop, round.iteration),
      flips: round.comparison.flips,
      regressions: round.comparison.regressions,
    });
    const fix = await round.delegate(followUpPrompt(round), loop.sessionId, FOLLOWUP_MS);
    if (fix.sessionId) loop.sessionId = fix.sessionId;
    // The follow-up is a delegation of its own: an abort lands here, not on the build turn.
    if (fix.ok === false && fix.stopReason === StopReason.Stopped) {
      await stoppedHere(round.iteration, true);
      return true;
    }
    round.evidence = await withObservationPatience(ctx, round.gatherOnce, {
      deadline,
      delays: budgets.observationDelays,
    });
    if (!round.evidence.ok) break;
  }
  return false;
}

/** Diffs against the incumbent, the whole scoreboard, the reviewer's gamed checks marked failed, and the comparison. */
async function scoreOnce(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, facet, handle, run } = loop;
  round.diffs = await diffAgainstIncumbent(ctx, {
    run,
    evidence: round.evidence,
    incumbentEvidence: loop.incumbentEvidence,
    handle,
    label: `facet_${facet.id}/iter_${round.iterationId}/diff`,
  });
  const scored = await scoreEvidence(ctx, {
    run,
    spec: loop.spec,
    evidence: round.evidence,
    incumbentEvidence: loop.incumbentEvidence,
    incumbentBoard: loop.board,
    diffs: round.diffs,
    handle,
    role: loop.role,
    worktree: loop.worktree,
    projectDir: loop.projectDir,
    deadline: loop.deadline,
    budgetMs: loop.budgetMs,
    iteration: round.iteration,
    iterationId: round.iterationId,
    facetId: facet.id,
    withPreview: loop.previewLock,
    references: loop.references,
    wobbles: loop.wobbles,
    stucks: loop.stucks,
  });
  round.nextBoard = scored.board;
  for (const gamed of round.gamedChecks) {
    if (round.nextBoard[gamed.id])
      round.nextBoard[gamed.id] = {
        ...round.nextBoard[gamed.id],
        pass: false,
        gamed: true,
        reason: `gamed — code review: ${gamed.what.slice(0, CLIP_DETAIL)}`,
      };
  }
  round.comparison = compareScoreboards(loop.board, round.nextBoard);
}

/**
 * A regression of a check that measures itself must reproduce before it costs the round: the same
 * build is observed once more, the regressed checks are scored again on that look, and one that
 * passes was the frame, not the build. A vision question has its own patience (wobbles), and a
 * playtest is a whole session: neither is looked at again here.
 */
async function lookAgainAtRegressions(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { budgets, ctx, deadline, facet, run } = loop;
  const regressed = remeasurable(round.comparison.regressions, round.nextBoard);
  if (!regressed.length || !loop.hasTime(LOOK_AGAIN_MIN_MS)) return;
  const again = await withObservationPatience(ctx, round.gatherOnce, {
    deadline,
    delays: budgets.observationDelays,
  }).catch(() => null);
  if (!again?.ok) return;
  const checks = loop.spec.checks.filter((c) => regressed.includes(c.id));
  const second = await scoreEvidence(ctx, {
    run,
    spec: { ...loop.spec, checks },
    evidence: again,
    incumbentEvidence: loop.incumbentEvidence,
    incumbentBoard: loop.board,
    diffs: round.diffs,
    handle: loop.handle,
    role: loop.role,
    worktree: loop.worktree,
    projectDir: loop.projectDir,
    deadline,
    budgetMs: loop.budgetMs,
    iteration: round.iteration,
    iterationId: `${round.iterationId}-again`,
    facetId: facet.id,
    withPreview: loop.previewLock,
    references: loop.references,
    wobbles: loop.wobbles,
    stucks: loop.stucks,
  });
  const noise = noisyRegressions(regressed, second.board);
  if (!noise.length) return;
  for (const id of noise)
    round.nextBoard[id] = {
      ...second.board[id],
      reason: "regressed on one look and passed on a second at the same build",
    };
  round.comparison = compareScoreboards(loop.board, round.nextBoard);
  await recordDecision(
    loop,
    `${facet.id}: ${noise.join(", ")} regressed on one look and passed on a second at the same build — the frame, not the build; not a regression`,
  );
}

/** A regression is followed up once, in the builder's own session, when there is time for it. */
function needsFollowUp(loop: FacetLoop, round: FacetRound): boolean {
  if (round.comparison.regressions.length === 0 || round.followedUp) return false;
  return loop.delegated && Boolean(loop.sessionId) && loop.hasTime(FOLLOW_UP_MIN_MS);
}

/** What the builder is told after a regression: what flipped, what regressed, and to keep the one and restore the other. */
function followUpPrompt(round: FacetRound): string {
  const { flips, regressions } = round.comparison;
  return [
    `VERIFICATION of your build: ${flips.length ? `flipped to pass: ${flips.join(", ")}.` : "nothing flipped to pass yet."}`,
    `REGRESSED (passed on the accepted build, fails on yours): ${regressions.map((id: string) => `${id} — ${round.nextBoard[id]?.reason ?? ""}`).join("; ")}.`,
    `Keep what flipped, restore what regressed, touch nothing else, then stop.`,
  ].join("\n");
}

/** The verdict the board gives: a broken follow-up, a regression, no visible change — or, past all three, the taste judge's. */
async function decideOnBoard(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { comparison, evidence } = round;
  const refuse = (source: string, biggestGap: string, reason: string) => {
    round.verdict = { pick: Side.Incumbent, satisfied: false, biggest_gap: biggestGap, reason, defects: [] };
    round.verdictSource = source;
  };
  if (!evidence.ok) {
    const gap = `after the follow-up the build does not run: ${evidence.problems.join("; ")}`;
    refuse(VerdictSource.Broken, gap, "follow-up broke the build");
    return;
  }
  if (comparison.regressions.length > 0) {
    const regressed = comparison.regressions.join(", ");
    refuse(VerdictSource.Checks, `regressed ${regressed}`, `checks regressed: ${regressed}`);
    return;
  }
  // A camera, demo or probe another facet's checks depend on is a regression too, though no check
  // on this board measures it: that facet's board would only find out once it merged this build.
  const lost = registryRefusal({
    facetId: loop.facet.id,
    facets: loop.facets,
    incumbent: loop.incumbentEvidence,
    challenger: evidence,
  });
  if (lost) {
    refuse(VerdictSource.Checks, lost.gap, lost.reason);
    return;
  }
  // A finishing round's polish can sit under the build stage's "no visible change" line at the
  // judge's window size: it is refused unseen only when nothing at all was redrawn.
  const finishing = roundStage(round, loop.spec) === FacetStage.Finish;
  const invisible = finishing ? isZeroDiff(round.diffs) : isInvisibleDiff(round.diffs);
  if (comparison.flips.length === 0 && invisible) {
    const reason = "no visible change — every camera reads identical to the accepted build (no judge call spent)";
    refuse(VerdictSource.Invisible, loop.biggestGap, reason);
    return;
  }
  await tasteVerdict(loop, round);
}
