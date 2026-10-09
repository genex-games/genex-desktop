/**
 * One facet's build⟳verify loop — HARNESS-REWORK.md §4 (the v2 policy layer).
 *
 * A facet is a slice of the game with its own typed spec (intent + checks), its own thread,
 * and — when facets run in parallel — its own git worktree and pooled observation port.
 * Per iteration:
 *
 *   spike (if an identity check keeps failing) → brief into `.studio/BRIEF.md` → build in a
 *   persistent contractor session → code review → evidence (spec cameras, eye cameras, motion
 *   strip, audio) → checks (scene/pixel/probe/demo by the harness, vision by a one-question
 *   judge, play by the playtester) → scoreboard compare → accept on "no regression and ≥1
 *   flip", with one same-session follow-up to revert a regression → blind taste veto (may
 *   block only with a named regression, which becomes a new check) → commit, or retain the
 *   attempt on `refs/studio/runs/<run>/attempts/<facet>/<n>` and roll back.
 *
 * Exit when the work it was given is done — the identity checks it was started on (a
 * director's `done` list, the planner's identity features, the harness's own) pass and the
 * taste judge says `satisfied` — or when the clock or iteration budget runs out. A facet whose
 * plan carries no checks (a prose-only planner) runs the v1 rule: blind A/B pick,
 * incumbent-only-advances.
 *
 * Two isolation modes, chosen by the orchestrator:
 *  - worktree mode (parallel, delegated engines): edits land in `worktree`, wins are committed
 *    with plain git through `run.exec`, losses are retained on a ref then reset.
 *  - live mode (sequential, direct engines): edits land in the live game folder, wins and
 *    losses use game-scope snapshots exactly like the gauntlet.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { facetNotes } from "./repo.ts";
import { StopCode, stopWith } from "./outcomes.ts";
import { RunEvent } from "./run-events.ts";
import { createFacetLoopState, resumeSnapshot } from "./facet/state.ts";
import { RoundFlow } from "./facet/flow.ts";
import type { FacetLoopOptions, FacetLoopState, FacetRound } from "./facet/state.ts";
import { lessonsPayload, unseenLessons } from "./facet/lessons.ts";
import { playRound } from "./facet/round.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";

export type { FacetLoopOptions } from "./facet/state.ts";
export {
  ITERATION_HEADROOM,
  pinFixRecipe,
  facetIsDone,
  tooLateToStart,
  stopSignal,
  stopsThisRound,
  lessonsFromNotes,
  strongFlips,
  acceptRound,
  movesThisRound,
  chooseMove,
  moveVerdict,
  grownCheckIds,
  judgeChecksToRetire,
} from "./facet/rules.ts";
export { FACET_POLICY, FACET_POLICY_RANGE, normalizeFacetPolicy, loopStateOf } from "./facet/policy.ts";
export type { FacetPolicy } from "./facet/policy.ts";
export {
  FacetStage,
  FINISH_POLISH_NOTES,
  finishDone,
  movesInStage,
  polishCountsInStage,
  stageOf,
} from "./facet/stage.ts";
export {
  MAX_PROMPT_LIST,
  MAX_PROMPT_STEERING,
  MAX_PROMPT_FAILURE,
  briefWithMovedSections,
  steerPrompt,
  promptImagesFor,
  facetPrompt,
} from "./facet/prompt.ts";
export {
  similarDefect,
  sameDefectOpening,
  suggestedProbe,
  facetVocabularyScore,
  defectsToChecks,
} from "./facet/defects.ts";
export { checkTokens } from "./spec.ts";

/** Play one facet's rounds until one of them ends the loop, and hand back what it made. */
export async function runFacetLoop(ctx: HarnessCtx, options: FacetLoopOptions): Promise<AnyRecord> {
  const loop = await createFacetLoopState(ctx, options);
  for (let iteration = loop.startIteration; iteration <= loop.maxIterations; iteration++) {
    const round: FacetRound = { iteration };
    const flow = await playRound(loop, round);
    // A round retried after a provider outage runs again under the same number.
    iteration = round.iteration;
    if (flow === RoundFlow.Stop) break;
  }
  return finishFacetLoop(loop);
}

/** The loop's result once its rounds are over: yielded with everything round two needs, or done. */
async function finishFacetLoop(loop: FacetLoopState): Promise<AnyRecord> {
  const { result } = loop;
  if (!result.stoppedBecause) stopWith(result, StopCode.IterationsSpent, "facet iteration budget exhausted");
  if (loop.worktree) result.lastCommit = loop.incumbentCommit;
  result.board = loop.board;
  result.spec = loop.spec;
  result.sessionId = loop.sessionId;
  if (result.yielded) {
    // The whole in-memory state rides back to the scheduler (never into the journal — the
    // evidence carries frames), so round two continues the session instead of restarting it.
    result.done = false;
    result.resume = resumeSnapshot(loop);
    return result;
  }
  await keepLessons(loop);
  result.done = true;
  return result;
}

/**
 * Lessons (WP8): what the builder wrote under `## Fixed by looking` and after `HARNESS:` goes to
 * SkillOpt as candidate contract lines for every future brief. Every round already logged its
 * own (facet/phases/keep.ts); this last flush logs only what no round did.
 */
async function keepLessons(loop: FacetLoopState): Promise<void> {
  if (!loop.workdir) return;
  const notes = await readFile(path.join(loop.workdir, facetNotes(loop.facet.id)), "utf8").catch(() => "");
  const learned = unseenLessons(loop, notes);
  if (learned.length) await loop.appendRun(RunEvent.FacetLessons, lessonsPayload(loop, learned));
}
