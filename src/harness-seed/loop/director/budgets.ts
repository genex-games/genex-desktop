/**
 * The run's budgets and clocks: how long a session, a worker, a wait and a close may take, how
 * many workers and windows a run may have, and how often the studio looks at a running worker.
 * Plain numbers and pure functions, with no run of their own.
 */
import { PAGE_SEED, PLAN_REVIEW_WAIT_MS } from "../config.ts";
import { ITERATION_HEADROOM } from "../facet-loop.ts";
import { MINUTE_MS, minutes, SECOND_MS } from "../time.ts";
import { durationCommission } from "./commission.ts";
import type { Run } from "../../types/harness.d.ts";

/**
 * What a run was commissioned to do, under the names a harness file of the first goal-directed
 * vintage imported them by from here. The rest of the loop imports them from commission.ts, which
 * no part the agent kept can shadow (SEED_MOVES).
 */
export { durationCommission, goalCommission } from "./commission.ts";

/**
 * The page seed (`PAGE_SEED`, config.ts) under the name director files imported it by before it
 * had one home: a file the agent kept may still import it from here or from rules.ts.
 */
export const SEED = PAGE_SEED;
/**
 * How long a close waits for the workers it just stopped. Both roads out of a run — the
 * director's own `finish` and the harness's clock path — wait the same, because both then look
 * at the head the worktree stands on and both may land it: a worker still committing while the
 * close reads HEAD is a build landed without its last accepted round.
 */
export const CLOSE_SETTLE_MS = 90 * SECOND_MS;
/** Too little time left in the session to be worth a worker — and too little to spend waiting. */
export const WORKER_FLOOR_MS = 3 * MINUTE_MS;
/** A `wait` answers within this, whatever it was waiting for (the Codex bridge shim waits ten minutes). */
export const MAX_WAIT_S = 240;
/** Workers alive at once, whatever the pool says — twelve windows is already a machine on its knees. */
export const MAX_WORKERS = 12;
/** A worker window needs at least this much free memory to open (a big game's window is over a gigabyte). */
export const MIN_FREE_MB = 1_024;
/** A running worker's round needs less (loop/facet/admission.ts waits for it at the round's boundary). */
export { ROUND_MIN_FREE_MB } from "../facet/admission.ts";
/** The longest the studio goes without looking at a running loop worker. */
export const MONITOR_TICK_MS = 3 * MINUTE_MS;
/** Looks it takes over a worker's whole budget, so a short worker is looked at oftener. */
const MONITOR_LOOKS = 15;
/** The most often the studio looks at one worker, however short its budget. */
const MONITOR_MIN_MS = 10 * SECOND_MS;
/** A round that has written nothing for this long is worth saying once. */
export const SILENT_ROUND_MIN = 12;
/** Defects nobody can be handed any more, kept for the director's next integration. */
export const MAX_LEDGER = 16;
/** The longest one `worker_start` blocks inside a single call (the bridge shim waits ten minutes). */
export const PLAN_HOLD_SLICE_MS = MAX_WAIT_S * SECOND_MS;
/** Parts a plan may name: past this it is a list, not a run. */
export const MAX_PLAN_WORKERS = 12;

/** The wrap-up reserve: a tenth of the run, never less than five minutes nor more than fifteen. */
const WRAP_RESERVE_MIN_MS = 5 * MINUTE_MS;
const WRAP_RESERVE_MAX_MS = 15 * MINUTE_MS;
const WRAP_RESERVE_SHARE = 0.1;
/** Preparation may take a third of what is left, and never more than half an hour. */
const PREPARATION_MAX_MS = 30 * MINUTE_MS;
const PREPARATION_SHARE = 3;
/** A preparation budget below this is not worth a session: the lead builds directly instead. */
const PREPARATION_FLOOR_MS = MINUTE_MS;
/** The pool windows a run keeps for the director itself (its own look, and every pass's lease). */
const DIRECTOR_WINDOWS = 2;
/**
 * The finish mark: the share of a timed build's working time kept for finishing what exists,
 * never less than half an hour nor more than two, and none for a build under an hour and a half.
 */
const FINISH_MARK_SHARE = 0.3;
const FINISH_MARK_MIN_MS = 30 * MINUTE_MS;
const FINISH_MARK_MAX_MS = 120 * MINUTE_MS;
const FINISH_MARK_FLOOR_MS = 90 * MINUTE_MS;

/** The director's session ends this long before the hard deadline; a wrap-up session gets the rest. */
export function wrapReserveMs(total: number): number {
  return Math.max(WRAP_RESERVE_MIN_MS, Math.min(WRAP_RESERVE_MAX_MS, Math.round(total * WRAP_RESERVE_SHARE)));
}

/** Only an explicit duration commission must spend its working budget. */
export function timedWorkRemaining(
  run: Pick<Run, "reference"> & { budgets?: Run["budgets"] },
  softDeadline: number,
  now = Date.now(),
  finishing = false,
): boolean {
  return durationCommission(run) && !finishing && now < softDeadline;
}

/**
 * How long before the end of its working time a timed build reaches its finish mark: from there
 * the art director looks at the whole game and the owners finish their parts, with no new parts.
 * Null for a goal build (it is reviewed when its lead idles or finishes) and for one too short to
 * split.
 */
export function finishMarkMs(
  run: Pick<Run, "reference"> & { budgets?: Run["budgets"] },
  workingMs: number,
): number | null {
  if (!durationCommission(run) || !(workingMs >= FINISH_MARK_FLOOR_MS)) return null;
  return Math.max(FINISH_MARK_MIN_MS, Math.min(FINISH_MARK_MAX_MS, Math.round(workingMs * FINISH_MARK_SHARE)));
}

/** Preparation must leave the lead time to build, recover and inspect before wrap-up.
 * A 15-minute run used to spend all ten working minutes on its starting point. */
export function preparationBudgetMs(remaining: number): number {
  const budget = Math.min(PREPARATION_MAX_MS, Math.floor(remaining / PREPARATION_SHARE));
  return budget >= PREPARATION_FLOOR_MS ? budget : 0;
}

/**
 * How many of the pool's windows a run may hand to workers.
 *
 * Two of them are the director's own: the window its session looks through for the whole run (`look`,
 * the computer tool) and the one every judge, health and close pass leases for a moment. The
 * first real run gave five of six windows to workers and took the sixth for its session, so
 * `preview.acquire` threw for every evidence pass after that and each one silently fell through
 * to the user's live window. A pool of two or three still runs one worker — the director shares
 * its own window there, and the borrow says so out loud rather than happening in silence.
 */
export function workerWindows(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(1, Math.round(max) - DIRECTOR_WINDOWS);
}

/**
 * A worker given less time than a round on this game has been taking. The loop refuses a round it
 * cannot finish with a quarter to spare (`tooLateToStart`), and that gate runs before the first
 * one — so such a worker ends with no rounds at all, after a worktree, a window lease and (on an
 * unproven fork point) a whole evidence pass have been spent on it. Said at `worker_start`, where
 * the decision is still the lead's, and never a refusal: the median is the run's, not this seam's,
 * and a last short session on one known fix is a fair thing to ask for.
 *
 * @param {number} budgetMs  what this worker is being given
 * @param {number | null} medianMs  the median round this run has actually measured
 * @returns {string | null}
 */
export function shortBudgetWarning(budgetMs: number, medianMs: number | null): string | null {
  if (!medianMs || !(budgetMs < medianMs * ITERATION_HEADROOM)) return null;
  return `a round on this game has been taking about ${minutes(medianMs)} min and this worker has ${minutes(budgetMs)} — it will very likely stop before its first round. Give it at least ${minutes(Math.ceil(medianMs * ITERATION_HEADROOM))} min, or finish instead.`;
}

/**
 * How often the studio looks at a running loop worker: fifteen times over its budget, never
 * more than three minutes apart and never more often than ten seconds. A forty-five minute
 * worker is looked at every three minutes; a short one, oftener — its whole life is shorter.
 */
export function monitorEveryMs(budgetMs: unknown): number {
  return Math.max(MONITOR_MIN_MS, Math.min(MONITOR_TICK_MS, Math.round((Number(budgetMs) || 0) / MONITOR_LOOKS)));
}

/**
 * How long the first worker may wait for a user who asked to read the plan. Zero unless they
 * asked, zero on a resume (they reviewed it the first time), never past the window and never
 * into the time a worker needs to be worth starting: an unanswered run must still build.
 */
export function planReviewWaitMs({
  reviewPlan = false,
  resume = false,
  sessionMsLeft = 0,
}: {
  reviewPlan?: boolean;
  resume?: boolean;
  sessionMsLeft?: number;
} = {}): number {
  if (!reviewPlan || resume) return 0;
  return Math.max(0, Math.min(PLAN_REVIEW_WAIT_MS, Math.round(sessionMsLeft) - WORKER_FLOOR_MS));
}

/**
 * The middle of a set of measured milliseconds, in whole minutes — null until something has
 * been measured. A run used to size every worker on the assumption that a round takes eight
 * minutes; the rounds of one real run took nine to forty-six, so every second-round worker
 * began a round it could not finish. This is what a round actually costs on this game.
 */
export function medianMinutes(samples: readonly number[] | null | undefined): number | null {
  const sorted = [...(samples ?? [])].filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  return sorted.length ? minutes(sorted[Math.floor(sorted.length / 2)]) : null;
}
