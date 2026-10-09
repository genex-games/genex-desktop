/** What the round keeps: the commit or the rollback, style distances, and the attempt record. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pairImagesFor } from "../../judge.ts";
import { isMeasured } from "../../checks.ts";
import { applyRecipeOutcome, saveRecipe } from "../../library.ts";
import { learningOn } from "../../learning.ts";
import { normalizeReason, REPLAN_AFTER_SAME_REASON } from "../../replan.ts";
import { nearestReference } from "../../style.ts";
import { attemptRef, facetNotes } from "../../repo.ts";
import { GIT, commitAll, resetClean, updateRef } from "../../git.ts";
import { RunEvent } from "../../run-events.ts";
import { HostMethod } from "../../host-methods.ts";
import { CheckKind, CheckOrigin } from "../../spec.ts";
import { clip, CLIP_DETAIL } from "../../text.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { RoundFlow } from "../flow.ts";
import { StopCode, stopWith } from "../../outcomes.ts";
import { roundFields } from "../record.ts";
import { ReplanSource } from "./replans.ts";
import { lessonsPayload, unseenLessons } from "../lessons.ts";

/** The most attempts a facet remembers for its briefs, newest last. */
const MAX_ATTEMPTS = 12;
/** The tail of the builder's notes an attempt record keeps. */
const ATTEMPT_NOTES_CHARS = 600;
/** The cameras a round's pair images are made for, at most. */
const PAIR_CAMERAS = 3;
/** How much of a verdict's reason an attempt commit's subject quotes, and a lost attempt's line. */
const COMMIT_REASON_CHARS = 100;
const ATTEMPT_REASON_CHARS = 160;

/** Commit the winner, or keep the attempt on its ref (or a snapshot) and roll back. */
export async function keepOrRollBack(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  // ── commit or retain-and-roll-back ──
  round.attemptBranch = null;
  round.diffStat = "";
  // Read before a rollback takes them: a lost attempt's notes are what it tried.
  round.attemptNotes = await builderNotes(loop);
  await logRoundLessons(loop, round.attemptNotes);
  if (round.won) {
    await keepWinner(loop, round);
    return;
  }
  // The lost attempt is retained: its code on a branch (worktree mode) or a snapshot (live
  // mode), its notes committed, and its diff summary carried into the next brief. The old
  // loop erased all of this and re-attempted the same idea because it could not see it.
  const kept = loop.worktree ? await retainAttemptOnRef(loop, round) : await retainAttemptSnapshot(loop, round);
  if (kept) return;
  // Rolling back an attempt nobody kept throws it away for good: it stays where it is,
  // and the facet stops on it.
  stopWith(
    loop.result,
    StopCode.AttemptNotKept,
    `iteration ${round.iteration}'s attempt could not be kept, so it was left in place rather than thrown away`,
  );
  return RoundFlow.Stop;
}

/** The challenger won: it becomes the incumbent — committed and kept reachable, or snapshotted as healthy. */
async function keepWinner(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, facet, git, gitOptions, gitWhere, integration, keepReachable, result, run, worktree } = loop;
  // The game's declared demos (not the ones the capture happened to photograph): what
  // integration must not lose.
  result.demos = Array.isArray(round.evidence.registeredDemos) ? [...round.evidence.registeredDemos] : [];
  if (worktree) {
    await commitAll(
      ctx,
      gitWhere,
      `facet ${facet.id} iteration ${round.iteration}: accepted (${round.verdictSource})`,
      {
        allowEmpty: true,
        ...gitOptions,
      },
    );
    const head = await git(GIT.head);
    loop.incumbentCommit = head;
    await keepReachable(head);
    if (integration?.accepted)
      await integration.accepted(head, { facetId: facet.id, iteration: round.iteration }).catch(() => {});
  } else {
    loop.incumbentSnapshot = await ctx.call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId} facet ${facet.id} iteration ${round.iteration}: accepted — ${round.verdict.biggest_gap ?? ""}`,
      project: run.project,
      healthy: true,
    });
  }
  loop.incumbentEvidence = round.evidence;
  if (round.nextBoard) loop.board = round.nextBoard;
}

/**
 * Worktree mode: the lost attempt is committed and bookmarked on its ref, then the worktree goes
 * back to the incumbent. Answers whether it was kept; one that was not is not rolled back.
 */
async function retainAttemptOnRef(loop: FacetLoop, round: FacetRound): Promise<boolean> {
  const { ctx, facet, git, gitOptions, gitWhere, run } = loop;
  try {
    await commitAll(
      ctx,
      gitWhere,
      `facet ${facet.id} iteration ${round.iteration}: attempt (${round.verdictSource}) — ${clip(round.verdict.reason, COMMIT_REASON_CHARS)}`,
      { allowEmpty: true, ...gitOptions },
    );
    round.attemptBranch = attemptRef(run.runId, facet.id, round.iteration);
    await updateRef(ctx, gitWhere, round.attemptBranch, "HEAD", gitOptions);
    round.diffStat = await Promise.resolve()
      .then(() => git(GIT.diffStat(loop.incumbentCommit)))
      .catch(() => "");
  } catch {
    return false;
  }
  await resetClean(ctx, gitWhere, loop.incumbentCommit, gitOptions);
  return true;
}

/**
 * Live mode: the lost attempt is kept in a snapshot and the game restored to the incumbent's — the
 * builder's notes survive it. Answers whether it was kept; one that was not is not restored over.
 */
async function retainAttemptSnapshot(loop: FacetLoop, round: FacetRound): Promise<boolean> {
  const { ctx, facet, projectDir, run } = loop;
  const notesFile = projectDir ? path.join(projectDir, facetNotes(facet.id)) : null;
  const notes = notesFile ? await readFile(notesFile, "utf8").catch(() => null) : null;
  const attemptSnapshot = await ctx
    .call(HostMethod.SnapshotCreate, {
      scope: "game",
      reason: `run ${run.runId} facet ${facet.id} iteration ${round.iteration}: attempt (${round.verdictSource})`,
      project: run.project,
      healthy: false,
    })
    .catch(() => null);
  round.attemptBranch = attemptSnapshot?.snapshot_id ?? null;
  if (!round.attemptBranch) return false;
  await ctx.call(HostMethod.SnapshotRestore, {
    snapshotId: loop.incumbentSnapshot?.snapshot_id,
    project: run.project,
    scope: "game",
    reason: `run ${run.runId} facet ${facet.id} iteration ${round.iteration}: challenger did not win`,
  });
  // The builder's own record of what it tried survives the loss — the rollback took the
  // whole docs/notes folder with it, so it is remade before the file is written back.
  if (notesFile && notes) {
    await mkdir(path.dirname(notesFile), { recursive: true }).catch(() => {});
    await writeFile(notesFile, notes).catch(() => {});
  }
  return true;
}

/** Style distance and pair images (WP4e), for the next brief, the prompt and the report. */
export async function measureStyle(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, facet, references, run, spec } = loop;
  // ── style distance and pair images (WP4e): for the brief, the prompt and the report ──
  const measurable = references.length && !round.challengerBroken && round.evidence?.shots?.length;
  if (!measurable) return;
  // `previous` is the accepted build's distances: on a win, this build becomes the one the
  // next brief compares against; on a loss the accepted numbers stand.
  const distances = (round.evidence.shots ?? [])
    .map((shot: AnyRecord) => ({
      camera: shot.camera,
      ...(shot.stats ? (nearestReference(shot.stats, references) ?? {}) : {}),
    }))
    .filter((d: AnyRecord) => typeof d.distance === "number");
  loop.lastStyle = { previous: round.won ? distances : (loop.lastStyle?.previous ?? distances), current: distances };
  if (!pairsWanted(loop, round)) return;
  const cameraShots = spec.cameras
    .slice(0, PAIR_CAMERAS)
    .map((c) => (round.evidence.shots ?? []).find((s: AnyRecord) => s.camera === c))
    .filter(Boolean);
  try {
    loop.lastPairs = await pairImagesFor(ctx, {
      run,
      shots: cameraShots,
      refs: references,
      label: `facet_${facet.id}/iter_${round.iterationId}/pair`,
    });
  } catch {
    loop.lastPairs = [];
  }
}

/** Pair images are worth their cost after a win, a loss streak, or a failing vision or metric check. */
function pairsWanted(loop: FacetLoop, round: FacetRound): boolean {
  if (round.won || loop.loseStreak >= 1) return true;
  return (Object.values(round.attemptBoard) as AnyRecord[]).some(
    (e) => (e.kind === CheckKind.Vision || e.kind === CheckKind.Metric) && e.pass === false,
  );
}

/** Memory: the attempt record, recipe outcomes and failure streaks. */
export async function rememberAttempt(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { result } = loop;
  // ── memory: the attempt record, recipe outcomes, failure streaks ──
  round.attemptRecord = await attemptRecordOf(loop, round);
  result.attempts.push(round.attemptRecord);
  if (result.attempts.length > MAX_ATTEMPTS) result.attempts.shift();
  await recordRecipeOutcomes(loop, round);
  updateFailureStreaks(loop, round);
  if (!round.challengerBroken) result.judged = (result.judged ?? 0) + 1;
}

/**
 * The round's new lessons go to the log now, won or lost: a lost round's notes are reset away
 * next, and a facet a crash cuts short never reaches its final flush. Logging is a courtesy to
 * the next pass — a failed append never costs the round.
 */
async function logRoundLessons(loop: FacetLoop, notes: string): Promise<void> {
  const lessons = unseenLessons(loop, notes);
  if (!lessons.length) return;
  await loop.appendRun(RunEvent.FacetLessons, lessonsPayload(loop, lessons)).catch(() => {});
}

/** The builder's notes for this facet as its working folder holds them now; empty when there are none. */
async function builderNotes({ facet, workdir }: FacetLoop): Promise<string> {
  if (!workdir) return "";
  return readFile(path.join(workdir, facetNotes(facet.id)), "utf8").catch(() => "");
}

/** The round as the next brief remembers it: what flipped, what it cost, why it lost, and the builder's own notes. */
async function attemptRecordOf(loop: FacetLoop, round: FacetRound): Promise<AnyRecord> {
  const notes: string = round.attemptNotes ?? (await builderNotes(loop));
  // The demos this round's look left out, for the builder's next prompt (facet/prompt.ts).
  const skipped: string[] = Array.isArray(round.evidence?.skippedDemos) ? round.evidence.skippedDemos : [];
  return {
    iteration: round.iteration,
    won: round.won,
    branch: round.attemptBranch,
    flips: round.comparison?.flips ?? [],
    regressions: round.comparison?.regressions ?? [],
    checks: Object.fromEntries((Object.values(round.attemptBoard) as AnyRecord[]).map((e) => [e.id, e.pass])),
    why: round.won ? "" : (round.verdict.reason ?? round.verdict.biggest_gap ?? ""),
    diffStat: round.diffStat,
    summary: round.won
      ? `iteration ${round.iteration}: accepted`
      : `iteration ${round.iteration}: ${clip(round.verdict.reason, ATTEMPT_REASON_CHARS)}`,
    notes: notes.slice(-ATTEMPT_NOTES_CHARS),
    ...(skipped.length ? { skippedDemos: skipped } : {}),
  };
}

/**
 * One outcome per recipe per iteration, for the check it was retrieved for; nothing on a broken
 * build, nothing on an unmeasured check, nothing on iteration 1 (a first build flips from zero
 * whatever the brief carried — 54 recipe outcomes in a five-iteration run were mostly that).
 */
async function recordRecipeOutcomes(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, ctx, facet, run } = loop;
  const nothingToCredit = round.challengerBroken || round.iteration <= 1 || !round.injectedWithFix.length;
  if (nothingToCredit) return;
  if (!(await learningOn(ctx))) return;
  for (const { recipe, primaryCheckId, checkIds } of round.injectedWithFix) {
    const checkId = primaryCheckId ?? checkIds[0];
    const entry = checkId ? round.attemptBoard[checkId] : null;
    if (!checkId || !isMeasured(entry)) continue;
    const flipped = (round.comparison?.flips ?? []).includes(checkId);
    if (!flipped && entry.pass !== false) continue;
    applyRecipeOutcome(recipe, {
      checkId,
      flipped,
      evidence: { run: run.runId, project: run.project, facet: facet.id, iteration: round.iteration },
    });
    await saveRecipe(ctx.workspace, recipe).catch(() => {});
    await appendRun(RunEvent.RecipeOutcome, {
      ...roundFields(loop, round.iteration),
      recipe: recipe.id,
      checkId,
      flipped,
      status: recipe.status,
      stats: recipe.stats,
    });
  }
}

/**
 * Each check's run of failures. An unmeasured check leaves its streak where it was: nobody
 * looked, so nothing failed. WP5: the same failure reason on consecutive judged iterations
 * goes to the planner.
 */
function updateFailureStreaks(loop: FacetLoop, round: FacetRound): void {
  const { failureStreaks, reasonStreaks, spec } = loop;
  for (const check of spec.checks) {
    const entry = round.attemptBoard[check.id];
    if (entry?.pass === true) {
      failureStreaks[check.id] = 0;
      delete reasonStreaks[check.id];
      continue;
    }
    if (entry?.pass !== false) continue;
    failureStreaks[check.id] = (failureStreaks[check.id] ?? 0) + 1;
    if (!round.challengerBroken) countSameReason(loop, check, entry.reason);
  }
}

/** One more judged failure with this reason; every fourth in a row asks the planner to replan the check. */
function countSameReason({ reasonStreaks, replanRequests }: FacetLoop, check: AnyRecord, why: unknown): void {
  const reason = normalizeReason(why);
  const before = reasonStreaks[check.id];
  const streak = before?.reason === reason ? { reason, count: before.count + 1 } : { reason, count: 1 };
  reasonStreaks[check.id] = streak;
  const replanDue = streak.count >= REPLAN_AFTER_SAME_REASON && streak.count % REPLAN_AFTER_SAME_REASON === 0;
  if (!replanDue || check.origin === CheckOrigin.Harness) return;
  replanRequests.push({
    checkId: check.id,
    reason: `failed ${streak.count} judged iterations in a row with the same reason: ${String(why).slice(0, CLIP_DETAIL)}`,
    source: ReplanSource.Streak,
  });
}
