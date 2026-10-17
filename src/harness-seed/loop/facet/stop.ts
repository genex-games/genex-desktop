/** A round the run stopped, recorded as stopped. */
import { verdictRecord, VerdictRule, VerdictSource } from "../verdict.ts";
import { attemptRef } from "../repo.ts";
import { commitAll, updateRef } from "../git.ts";
import { StopCode, stopWith } from "../outcomes.ts";
import { RunEvent } from "../run-events.ts";
import { unjudgedMove } from "./record.ts";
import type { FacetLoop } from "./state.ts";

/** How much of a stop's reason the stopped round's commit subject keeps. */
const COMMIT_SUBJECT_CHARS = 100;

/** The stop's code on the round's records (the run's close, or the lead), when its asker gave one. */
const stopCodeOf = (stop: { code?: string }): { stopCode?: string } => (stop.code ? { stopCode: stop.code } : {});

/**
 * The round the run stopped, recorded as stopped. What is on disk is committed and bookmarked
 * on `refs/studio/runs/<run>/attempts/<facet>/<n>-stopped`, the worktree is left standing, and
 * no verdict is spent: an evidence pass would photograph a half-written game, the judge would
 * keep the incumbent, and the rollback would erase work nobody asked to lose.
 */
export async function finishStoppedRound(
  loop: FacetLoop,
  iteration: number,
  stop: { by?: string; reason: string; code?: string },
): Promise<boolean> {
  const { appendRun, ctx, facet, facetThreadId, gitOptions, gitWhere, publishIteration, result, run, worktree } = loop;
  let stoppedBranch = null;
  if (worktree) {
    try {
      // The reason reaches a shell, and the director wrote it: keep letters and punctuation.
      const subject = stop.reason
        .replace(/[^\w .,:;'()/-]/g, " ")
        .trim()
        .slice(0, COMMIT_SUBJECT_CHARS);
      await commitAll(ctx, gitWhere, `facet ${facet.id} iteration ${iteration}: stopped — ${subject}`, {
        allowEmpty: true,
        ...gitOptions,
      });
      stoppedBranch = attemptRef(run.runId, facet.id, iteration, { stopped: true });
      await updateRef(ctx, gitWhere, stoppedBranch, "HEAD", gitOptions);
    } catch {
      /* the ref is a bookmark; the edits are in the worktree either way */
    }
  }
  await appendRun(RunEvent.FacetStopped, {
    runId: run.runId,
    facetId: facet.id,
    iteration,
    by: stop.by,
    reason: stop.reason,
    attemptBranch: stoppedBranch,
    ...stopCodeOf(stop),
  });
  await publishIteration({
    runId: run.runId,
    project: run.project,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration,
    // No winner and no board: nobody looked at this build, so there is nothing to report.
    winner: null,
    satisfied: false,
    biggest_gap: loop.biggestGap,
    defects: [],
    reason: stop.reason,
    verdictSource: VerdictSource.Stopped,
    ...stopCodeOf(stop),
    partial: false,
    unmeasured: [],
    scoreboard: null,
    attemptBranch: stoppedBranch,
    followedUp: false,
    move: unjudgedMove(loop.currentMove),
    fix: null,
    liveness: null,
    spike: null,
    shots: [],
    style: null,
    pairs: [],
    flags: [],
    diffs: {},
    // A stopped round still gets a record — the one shape every judged build has — so the
    // drawer can say in a sentence that nobody judged it and nothing was thrown away.
    verdict: verdictRecord({
      pass: "round",
      worker: facet.id,
      round: iteration,
      kept: null,
      rule: VerdictRule.Stopped,
    }),
    threadId: facetThreadId,
  });
  stopWith(
    result,
    StopCode.StoppedRound,
    stop.reason + (stoppedBranch ? ` — its work so far is kept on ${stoppedBranch}` : ""),
  );
  return true;
}
