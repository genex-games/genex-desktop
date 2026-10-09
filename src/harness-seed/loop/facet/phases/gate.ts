/** The round's gate and opening, continuous integration, and the re-baseline it may call for. */
import { gatherEvidence } from "../../evidence.ts";
import { isMeasured, runDeterministicChecks, toScoreboard } from "../../checks.ts";
import { CheckKind, demosNamedByChecks } from "../../spec.ts";
import { statePathsNamedByChecks } from "../../state-shape.ts";
import { resolveByOwnership } from "../../merge-ownership.ts";
import { isCommit } from "../../shell.ts";
import { GIT, isAncestor, mergeNoFf, shortSha } from "../../git.ts";
import { GIT_TIMEOUT_MS } from "../../config.ts";
import { StopCode, stopWith } from "../../outcomes.ts";
import { RunEvent } from "../../run-events.ts";
import { HostMethod } from "../../host-methods.ts";
import { CLIP_REASON } from "../../text.ts";
import type { Scoreboard } from "../../checks.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { handMergeNote } from "../gate-prompts.ts";
import { ownedByFacet } from "../owned.ts";
import { othersChangesToOwnFiles } from "../merged-heads.ts";
import { leadChangesNote } from "../merged-heads-prompts.ts";
import { RoundFlow } from "../flow.ts";
import { stopSignal, tooLateToStart } from "../rules.ts";
import { MOTION_FRAMES } from "../policy.ts";
import { roundFields } from "../record.ts";
import { admitRound } from "../admission.ts";
import { judgedOnMotion } from "../../motion-intent.ts";
import type { Check } from "../../spec.ts";

/** The round's gate — a stop, the clock, a round that would not fit, fair share — and its opening: the status, the event, the user's steering. */
export async function openRound(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { appendRun, ctx, deadline, facet, finishRequested, result, roundEstimate, run, steering } = loop;
  if (ctx.cancelled) {
    stopWith(result, StopCode.UserStop, "stopped by the user");
    return RoundFlow.Stop;
  }
  // Memory first: a machine short of it waits here, and the gates below then see the clock it
  // cost. A stop ends the wait at its next poll, so the cancel and finish gates answer it.
  await admitRound(loop, round.iteration);
  if (ctx.cancelled) {
    stopWith(result, StopCode.UserStop, "stopped by the user");
    return RoundFlow.Stop;
  }
  round.finishing = stopSignal(await finishRequested(loop.iterationsThisRound));
  if (round.finishing) {
    stopWith(result, StopCode.FinishRequested, round.finishing.reason);
    return RoundFlow.Stop;
  }
  if (Date.now() > deadline) {
    stopWith(result, StopCode.Budget, "facet budget exhausted");
    return RoundFlow.Stop;
  }
  // Enough time for a whole round, not merely to begin one. A round this worker cannot finish
  // is worth less than the accepted build it already has: the turn is cut mid-edit, the judge
  // sees half a game, and the round is lost. Stopping here keeps what it made and says so.
  round.tooLate = tooLateToStart({ leftMs: deadline - Date.now(), ...roundEstimate() });
  if (round.tooLate) {
    stopWith(result, StopCode.TooLate, round.tooLate);
    return RoundFlow.Stop;
  }
  // Fair share (WP6): a facet at its round cap steps aside while others are still waiting
  // for a slot; it returns with everything it needs to continue where it stopped.
  if (yieldsNow(loop)) {
    result.yielded = true;
    stopWith(
      result,
      StopCode.Yielded,
      `yielded after ${loop.iterationsThisRound} iterations this round (other facets waiting)`,
    );
    return RoundFlow.Stop;
  }
  loop.iterationsThisRound += 1;
  result.iterations = round.iteration;
  round.iterationId = String(round.iteration).padStart(3, "0");
  ctx.setStatus(`run ${run.runId} · ${facet.title} — iteration ${round.iteration}`);
  await appendRun(RunEvent.FacetBuildStarted, {
    runId: run.runId,
    facetId: facet.id,
    facetTitle: facet.title,
    iteration: round.iteration,
    deadlineMs: deadline,
  });
  round.userSteering = (await steering()).filter(Boolean);
}

/** Fair share (WP6): has this facet played its round cap while other facets wait for a slot? */
function yieldsNow({ softCap, shouldYield, iterationsThisRound }: FacetLoop): boolean {
  if (!softCap || iterationsThisRound < softCap) return false;
  return typeof shouldYield === "function" && shouldYield();
}

/** Continuous integration: take the other facets' accepted work at the round's boundary (a union merge on the wiring block, else a note for the builder). */
export async function takeIntegration(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, gitOptions, gitWhere, integration, worktree } = loop;
  loop.integrationNote = null;
  round.notedHead = null;
  round.rebaseline = false;
  if (!worktree || !integration?.head) return;
  const head = await integration.head().catch(() => null);
  const isNews = isCommit(head) && head !== loop.mergedIntegration && head !== loop.incumbentCommit;
  if (!isNews) return;
  if (await isAncestor(ctx, gitWhere, head, gitOptions)) {
    loop.mergedIntegration = head;
    return;
  }
  await mergeIntegration(loop, round, head, worktree);
}

/**
 * Merge the integration head into the worktree. A conflict is settled by ownership: another
 * part's file takes the integration side and the wiring block is union-merged (WP1c); a conflict
 * in this part's own files is aborted and handed to the builder, naming only those files.
 */
async function mergeIntegration(loop: FacetLoop, round: FacetRound, head: string, worktree: string): Promise<void> {
  const { appendRun, ctx, facet, git, gitOptions, gitWhere, ownShape, shape } = loop;
  const merge = await mergeNoFf(ctx, gitWhere, head, {
    message: `facet ${facet.id}: take integration ${shortSha(head)}`,
    noEdit: true,
    fastForward: true,
    label: gitOptions.label,
    timeoutMs: gitOptions.timeoutMs,
    failure: gitOptions.failure,
    rpcErrors: "fail",
    cleanupLabel: gitOptions.label,
    resolve: () =>
      resolveByOwnership(
        (command) =>
          ctx.call(HostMethod.RunExec, {
            command,
            cwd: worktree,
            timeoutMs: GIT_TIMEOUT_MS.quick,
            label: `facet:${facet.id}:union-merge`,
          }),
        {
          owned: ownedByFacet(loop),
          message: `facet ${facet.id}: take integration ${shortSha(head)} (resolved by ownership)`,
          wiring: !ownShape,
          ...(ownShape && shape?.main ? { main: shape.main } : {}),
        },
      ),
  });
  const merged = { ...roundFields(loop, round.iteration), head };
  if (!merge.ok) {
    round.notedHead = head;
    loop.integrationNote = handMergeNote({
      head,
      reason: String(merge.resolved?.reason ?? merge.error),
      ...namedFiles(merge.resolved),
    });
    await appendRun(RunEvent.IntegrationMerge, {
      ...merged,
      conflict: true,
      error: String(merge.error).slice(0, CLIP_REASON),
    });
    return;
  }
  const before = loop.incumbentCommit;
  loop.incumbentCommit = await git(GIT.head);
  loop.mergedIntegration = head;
  await appendRun(RunEvent.IntegrationMerge, { ...merged, conflict: false, ...resolvedFields(merge.resolved) });
  round.rebaseline = true;
  await noteLeadChanges(loop, { before, after: loop.incumbentCommit, head });
}

/**
 * A clean merge that brought edits to this part's own files — the lead's integration fixes — tells
 * the builder they are the lead's to keep, so an owner never undoes them as an accident.
 * Best-effort: a git that refuses says nothing.
 */
async function noteLeadChanges(
  loop: FacetLoop,
  { before, after, head }: { before: string | null; after: string | null; head: string },
): Promise<void> {
  const { git, ownShape, shape } = loop;
  const files = await othersChangesToOwnFiles(git, {
    before,
    after,
    owned: ownedByFacet(loop),
    template: !ownShape,
    main: shape?.main ?? null,
  }).catch(() => []);
  if (files.length) loop.integrationNote = leadChangesNote(files, head);
}

/**
 * The files a resolver said are whose. A resolver that names none (a kept older module, or one that
 * threw) leaves them unknown, and the builder's note then keeps both sides as it always did.
 */
function namedFiles(resolved: AnyRecord | null | undefined): { left?: string[]; theirs?: string[] } {
  return {
    ...(Array.isArray(resolved?.left) ? { left: resolved.left } : {}),
    ...(Array.isArray(resolved?.theirs) ? { theirs: resolved.theirs } : {}),
  };
}

/** What a merge the harness settled records: a union on the wiring block, and the files that took the integration side. */
function resolvedFields(resolved: AnyRecord | null | undefined): AnyRecord {
  if (!resolved) return {};
  const theirs = Array.isArray(resolved.theirs) && resolved.theirs.length ? { theirs: resolved.theirs } : {};
  // A resolver from before ownership (a kept older module) answers no `union`: it only unions.
  const unioned = resolved.union === true || resolved.theirs === undefined;
  return { ...(unioned ? { union: true, duplicates: resolved.duplicates ?? 0 } : {}), ...theirs };
}

/** Re-baseline: the incumbent just changed under this facet, so its evidence and board are looked at again once. */
export async function rebaselineIncumbent(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { legacy, previewLock, worktree } = loop;
  // ── re-baseline: the incumbent just changed under this facet ──
  // Other facets' work is in the worktree now; the accepted evidence and board predate it.
  // Judged against stale evidence, a regression they caused would be this facet's loss and
  // a fix they landed would be this facet's flip. Look at the merged incumbent once.
  const needsLook = round.rebaseline && !legacy && loop.incumbentEvidence;
  if (!needsLook || !worktree) return;
  const release = await previewLock();
  try {
    await lookAtMergedIncumbent(loop, round, worktree);
  } catch {
    /* a failed re-look keeps the old baseline; the next verdict is at worst the old unfairness */
  } finally {
    release();
  }
}

/**
 * What a re-look over the merged incumbent records beyond the frames. The motion strip only for a
 * facet judged on play or a demo, or one the taste judge watches move (loop/motion-intent.ts):
 * every re-baseline used to drive a strip whatever the facet was judged on. The new evidence is
 * the incumbent's side of the next blind A/B, so it keeps whatever the challenger's side will
 * show there — the strip for a facet about feel, and the audio probe (one page call after the
 * drive), whose line the judge reads for both builds.
 */
function mergedLookExtras(loop: FacetLoop): { motion: number; audio: boolean } {
  const { board, facet, spec } = loop;
  const checks: readonly Check[] = spec.checks;
  const moving = checks.some((check) => check.kind === CheckKind.Play || check.kind === CheckKind.Demo);
  const watched = judgedOnMotion(facet, board) || judgedOnMotion(spec, board);
  return {
    motion: moving || watched || demosNamedByChecks(checks).length > 0 ? MOTION_FRAMES : 0,
    audio: true,
  };
}

/** One evidence pass over the merged incumbent, and its measured checks laid over the board. */
async function lookAtMergedIncumbent(loop: FacetLoop, round: FacetRound, worktree: string): Promise<void> {
  const { appendRun, ctx, facet, facetSetup, handle, references, run, seed, spec } = loop;
  const merged = await gatherEvidence(ctx, {
    run,
    iterationId: `${round.iterationId}m`,
    seed,
    ...(handle ? { handle } : {}),
    root: worktree,
    labelPrefix: `facet_${facet.id}/iter_${round.iterationId}/merged-incumbent`,
    cameras: spec.cameras,
    eyes: true,
    ...mergedLookExtras(loop),
    requiredDemos: demosNamedByChecks(spec.checks),
    keepPaths: statePathsNamedByChecks(spec.checks),
    setup: facetSetup,
  });
  if (!merged.ok) return;
  loop.incumbentEvidence = merged;
  const { results } = await runDeterministicChecks(ctx, { spec, evidence: merged, diffs: {}, handle, references });
  const rescored = Object.values(toScoreboard(results)).filter((entry) => isMeasured(entry));
  const changed = rescored
    .filter((entry) => isMeasured(loop.board[entry.id]) && loop.board[entry.id].pass !== entry.pass)
    .map((entry) => entry.id);
  const measured: Scoreboard = Object.fromEntries(rescored.map((entry) => [entry.id, entry]));
  loop.board = { ...loop.board, ...measured };
  await appendRun(RunEvent.FacetRebaselined, {
    ...roundFields(loop, round.iteration),
    head: loop.mergedIntegration,
    changed,
  });
}
