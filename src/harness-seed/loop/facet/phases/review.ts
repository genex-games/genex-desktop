/** Code review before evidence is spent: contract violations fixed in the same session, and what is left enforced. */
import { enforceOwnership, reviewAttempt, type ReviewOutcome } from "../../review.ts";
import {
  concludeHandMerge,
  droppedByMerge,
  enforcedLists,
  HandMerge,
  restoreDropped,
  type MergeExec,
} from "../../merge-ownership.ts";
import { GIT_TIMEOUT_MS } from "../../config.ts";
import { HostMethod } from "../../host-methods.ts";
import { RunEvent } from "../../run-events.ts";
import { MINUTE_MS } from "../../time.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { Check } from "../../spec.ts";
import { STUDIO_CONTRACT, type FacetLoop, type FacetRound } from "../state.ts";
import { isStopped, RoundFlow, stoppedByUser } from "../flow.ts";
import { FOLLOWUP_MS } from "../policy.ts";
import { roundFields } from "../record.ts";
import { StopReason } from "../../outage.ts";
import { unresolvedMergeWords } from "../gate-prompts.ts";
import { ownedByFacet } from "../owned.ts";
import { integrationLine } from "../merged-heads.ts";

/** The review's fix turn is asked only with this much of the facet's clock left (or a slice of a short one). */
const REVIEW_FIX_MIN_MS = 5 * MINUTE_MS;
/** A finding the model reviewer wrote (the rest are the mechanical pass's). */
const MODEL_FINDING = "model";

/** Code review: contract violations fixed in the same session before evidence is spent, and what is left enforced. */
export async function reviewCode(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, legacy, projectDir, reviewEnabled, spec, stoppedHere, worktree } = loop;
  // ── code review: contract violations are fixed in the same session before evidence is spent ──
  round.review = null;
  round.handMergeHead = null;
  if (worktree && !round.buildFailed) await concludeBuilderMerge(loop, round, worktree);
  round.integrationHeadNow = worktree ? await integrationCandidates(loop, round) : null;
  const root = worktree ?? projectDir;
  const reviews = !round.buildFailed && reviewEnabled && !legacy;
  if (reviews && root) {
    const flow = await reviewAndFix(loop, round, root);
    if (flow) return flow;
  }
  // Checks the reviewer says are gamed: named by id in a model finding worded as forcing.
  round.gamedChecks = gamedChecks(spec.checks, round.review);
  if (round.review?.enforced?.length || round.gamedChecks.length) {
    await appendRun(RunEvent.FacetReviewEnforced, {
      ...roundFields(loop, round.iteration),
      ...enforcedLists(round.review?.enforced ?? []),
      gamed: round.gamedChecks.map((g: AnyRecord) => g.id),
    });
  }

  // Evidence is the expensive half of a round, and photographs a half-written game after a
  // stop: the round ends here instead.
  if (await stoppedHere(round.iteration)) return RoundFlow.Stop;
}

/**
 * Candidates, newest first: the head of a hand merge just concluded; the integration line from the
 * newest head the orchestrator knows (`latest`, else the head it merges from) back to the
 * incumbent — a builder the lead told to merge its fix merged a head that was no candidate, and its
 * review read the lead's fix as the builder's own edit (facet/merged-heads.ts); then the head the
 * builder was told to merge (integration may have moved on since the note), the current head, and
 * the loop's own last merge.
 */
async function integrationCandidates(loop: FacetLoop, round: FacetRound) {
  const { git, incumbentCommit, integration, mergedIntegration } = loop;
  const current = await integration?.head?.().catch(() => null);
  const latest = await integration?.latest?.().catch(() => null);
  const line = await integrationLine(git, { from: latest ?? current, incumbent: incumbentCommit }).catch(() => []);
  const candidates = [round.handMergeHead, ...line, round.notedHead, current, mergedIntegration];
  return [...new Set(candidates.filter(Boolean))];
}

/** A command run in the build's worktree, as the review's own git runs. */
function worktreeExec({ ctx, spec }: FacetLoop, worktree: string): MergeExec {
  return (command) =>
    ctx.call(HostMethod.RunExec, {
      command,
      cwd: worktree,
      timeoutMs: GIT_TIMEOUT_MS.quick,
      label: `facet:${spec.id}:review-merge`,
    });
}

/**
 * A hand merge the builder left open is committed before the review, so the merged head is an
 * ancestor and only this part's own diff is judged; its head becomes the newest candidate. One
 * left with conflicts makes the build broken: half a merge is never reviewed or judged.
 */
async function concludeBuilderMerge(loop: FacetLoop, round: FacetRound, worktree: string): Promise<void> {
  const concluded = await concludeHandMerge(worktreeExec(loop, worktree), {
    message: `facet ${loop.spec.id}: conclude the builder's merge`,
  }).catch(() => null);
  if (concluded?.state === HandMerge.Concluded) round.handMergeHead = concluded.head;
  if (concluded?.state === HandMerge.Unresolved) round.buildFailed = unresolvedMergeWords(concluded.files);
}

/** Review the attempt, and add what a merge into it dropped of another part's work. */
async function reviewWithMerges(loop: FacetLoop, round: FacetRound, root: string, model: boolean) {
  const review = await reviewAttempt(loop.ctx, reviewOptions(loop, round, root, model));
  if (!loop.worktree || !review.merged) return review;
  const dropped = await droppedByMerge(worktreeExec(loop, root), {
    incumbent: loop.incumbentCommit,
    mergedHead: review.base,
    owned: ownedByFacet(loop),
  }).catch(() => []);
  if (!dropped.length) return review;
  return {
    ...review,
    violations: [...review.violations, ...dropped],
    summary: `${review.summary}; ${dropped.length} change(s) a merge dropped`,
  };
}

/** Review the build; with violations, one fix turn in the same session and a second review whose findings are enforced. */
async function reviewAndFix(loop: FacetLoop, round: FacetRound, root: string): Promise<RoundFlow> {
  const { appendRun, ctx, delegated, facet, hasTime, modelReview, run } = loop;
  try {
    round.review = await reviewWithMerges(loop, round, root, modelReview);
  } catch (err: any) {
    if (isStopped(err, ctx)) return stoppedByUser(loop);
    round.review = null;
  }
  if (!round.review?.violations?.length) return;
  await appendRun(RunEvent.FacetReview, {
    ...roundFields(loop, round.iteration),
    violations: round.review.violations,
    summary: round.review.summary,
  });
  const canAskForAFix = delegated && loop.sessionId && hasTime(REVIEW_FIX_MIN_MS);
  if (!canAskForAFix) return;
  ctx.setStatus(`run ${run.runId} · ${facet.title} — fixing review findings`);
  const stopped = await askForReviewFix(loop, round);
  if (stopped) return stopped;
  return enforceReview(loop, round, root);
}

/** What `reviewAttempt` is asked with: the build's place, what it diffs against, and the ownership rules. */
function reviewOptions(loop: FacetLoop, round: FacetRound, root: string, model: boolean) {
  const { ownShape, ownsMain, run, shape, spec, worktree } = loop;
  return {
    run,
    spec,
    worktree: root,
    incumbentCommit: worktree ? (loop.incumbentCommit ?? "HEAD") : (loop.incumbentSnapshot?.git?.game ?? "HEAD"),
    integrationHead: round.integrationHeadNow,
    ownsMain,
    model,
    template: !ownShape,
    ...(ownShape && shape?.main ? { main: shape.main, studio: STUDIO_CONTRACT } : {}),
  };
}

/** The one fix turn, in the builder's own session. Answers the round's end when the run stopped it. */
async function askForReviewFix(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, stoppedHere } = loop;
  try {
    const fix = await round.delegate(reviewFixPrompt(round.review.violations), loop.sessionId, FOLLOWUP_MS);
    if (fix.sessionId) loop.sessionId = fix.sessionId;
    // The fix turn is a delegation of its own: an abort lands here, not on the build turn.
    if (fix.ok === false && fix.stopReason === StopReason.Stopped) {
      await stoppedHere(round.iteration, true);
      return RoundFlow.Stop;
    }
  } catch (err: any) {
    if (isStopped(err, ctx)) return stoppedByUser(loop);
  }
}

/** What the builder is asked to fix: exactly the violations, and what happens to a gamed check or a file it does not own. */
function reviewFixPrompt(violations: AnyRecord[]): string {
  return [
    `CODE REVIEW before your build is judged found contract violations. Fix exactly these, nothing else, then stop:`,
    ...violations.map((v) => `- ${v.file}${v.line ? `:${v.line}` : ""} — ${v.what}${v.fix ? ` → ${v.fix}` : ""}`),
    `A check that is satisfied by forcing its value (a probe set to what the check wants, a demo that writes the flag it reads) counts as FAILED for this build, a file outside this facet's ownership is reverted before judging, and another part's change a merge dropped is restored.`,
  ].join("\n");
}

/**
 * Teeth, without a blade (WP1b). After the one fix turn, what remains is enforced: a gaming
 * finding marks its check failed for this attempt; a file outside ownership is left alone when
 * its content arrived by merge, reverted to the diff base when it exists there, and quarantined
 * (never deleted) when it is genuinely new; another part's change a merge dropped is restored
 * from the merged head. With the edit-time hook (WP8) in front of the builder this path is a
 * fallback.
 */
async function enforceReview(loop: FacetLoop, round: FacetRound, root: string): Promise<RoundFlow> {
  const { ctx, modelReview, worktree } = loop;
  const gamingFound = round.review.violations.some(isGamingFinding);
  try {
    // The fix turn may have merged by hand too: concluded (or found half done) before the second look.
    if (worktree) await concludeBuilderMerge(loop, round, worktree);
    if (round.buildFailed) return;
    round.integrationHeadNow = worktree ? await integrationCandidates(loop, round) : null;
    const again: ReviewOutcome = await reviewWithMerges(loop, round, root, modelReview && gamingFound);
    round.review = { ...again, enforced: [] };
    if (worktree) round.review.enforced = await enforceFindings(loop, round, again);
  } catch (err: any) {
    if (isStopped(err, ctx)) return stoppedByUser(loop);
  }
}

/** Ownership enforced on the second review's findings, then what a merge dropped put back. */
async function enforceFindings(loop: FacetLoop, round: FacetRound, again: ReviewOutcome) {
  const { git } = loop;
  const owned = await enforceOwnership(git, {
    base: again.base ?? loop.incumbentCommit,
    integrationHeads: round.integrationHeadNow ?? [],
    violations: again.violations,
    iterationId: round.iterationId,
  });
  const restored = again.merged ? await restoreDropped(git, { violations: again.violations, from: again.base }) : [];
  return [...owned, ...restored];
}

/**
 * A model finding its reviewer flagged as a check made to pass without the work. The flag, not
 * the wording: a word match on "game" read every finding about a game as gaming.
 */
function isGamingFinding(v: AnyRecord): boolean {
  return v.source === MODEL_FINDING && v.gaming === true;
}

/** The checks a flagged gaming finding names by id: each one, once. */
export function gamedChecks(checks: readonly Check[], review: AnyRecord | null): Array<{ id: string; what: string }> {
  const gamed = new Map<string, { id: string; what: string }>();
  for (const v of review?.violations ?? []) {
    const finding = `${v.what} ${v.fix ?? ""}`;
    if (!isGamingFinding(v)) continue;
    for (const c of checks) {
      const named = new RegExp(`\\b${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(finding);
      if (named && !gamed.has(c.id)) gamed.set(c.id, { id: c.id, what: v.what });
    }
  }
  return [...gamed.values()];
}
