/**
 * How a loop ended and what a worker is doing, as codes a program reads — beside the sentence a
 * person reads, never instead of it.
 *
 * `stoppedBecause` is written for the owner ("the observation layer is down (…) — the challenger
 * is held in the worktree unjudged"), and the words change whenever someone rewords a sentence.
 * The classic pipeline used to decide which facets "died early" by matching three phrases of it
 * with a regex; a rewording would have silently turned a dead facet into a settled one. Every
 * stop now carries a `stopCode` from `StopCode` too, and code decides on the code.
 */

/** Why a loop stopped. The text stays the caller's; the code is one of these. */
export const StopCode = {
  /** The user pressed Stop (`ctx.cancelled`). */
  UserStop: "user-stop",
  /** A wrap-up somebody asked for — the user's finish, or the director's — answered between rounds. */
  FinishRequested: "finish-requested",
  /** A stop that landed inside a round: the round is committed on its `…-stopped` ref, not judged. */
  StoppedRound: "stopped-round",
  /** The loop's clock ran out. */
  Budget: "budget",
  /** What is left is less than a whole round takes: stopped early to finish cleanly. */
  TooLate: "too-late",
  /** Fair share: stepped aside while other facets waited, to continue in round two. */
  Yielded: "yielded",
  /** The work it was given is done (or, on a prose-only plan, the critic is satisfied). */
  Done: "done",
  /** The same unjudgeable cause, build after build: no third build on it. */
  CircuitBreak: "circuit-break",
  /** The builder's engine is out of usage — a cap that outlives the run. */
  UsageLimit: "usage-limit",
  /** The engine failed build turn after build turn. */
  EngineExhausted: "engine-exhausted",
  /** Nothing could be seen to judge: the observation layer is down, the build is kept unjudged. */
  ObservationDown: "observation-down",
  /** The judge could not answer, twice in a row. */
  JudgeDown: "judge-down",
  /** The sign-in the builder needs has expired; only a person can open that. */
  SignIn: "sign-in",
  /** A reference run without the stills its bar needs. */
  NoReference: "no-reference",
  /** The blind panel picked the build over the reference. */
  Victory: "victory",
  /** Every iteration the loop was given has been spent. */
  IterationsSpent: "iterations-spent",
  /** The shared base every part forks from failed, and the run could not go on from it. */
  BaseFailed: "base-failed",
  /** The integrated build could not be judged: it is broken, and rolled back when allowed. */
  NotJudgeable: "not-judgeable",
  /** The integrated build did not beat the base it forked from. */
  NoImprovement: "no-improvement",
  /** The build was accepted, and the blind panel still preferred the reference. */
  ReferenceUnbeaten: "reference-unbeaten",
  /** A lost attempt could not be kept, so it was left in place instead of rolled away unkept. */
  AttemptNotKept: "attempt-not-kept",
} as const;
/** A stop code: one of `StopCode`. */
export type StopCode = (typeof StopCode)[keyof typeof StopCode];

/** How the optimization stage ended (`result.outcome`). Persisted: never rename a value. */
export const OptimizationOutcome = {
  Improved: "improved",
  NoImprovement: "no_improvement",
  Skipped: "skipped",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;
export type OptimizationOutcome = (typeof OptimizationOutcome)[keyof typeof OptimizationOutcome];

/** How much of an unknown code or state the error that refuses it quotes. */
const UNKNOWN_VALUE_CHARS = 40;

/** Stops that end a facet before its work, where nothing it could have built would have helped. */
const DIED_EARLY = new Set<string | null>([
  StopCode.ObservationDown,
  StopCode.UsageLimit,
  StopCode.EngineExhausted,
  StopCode.AttemptNotKept,
]);

/** What a stop leaves on the record it ends: the code, and the sentence for the owner. */
export interface Stopped {
  stopCode?: string | null;
  stoppedBecause?: string | null;
}

/**
 * Record why `target` (a facet result, a run report) stopped: the sentence for the owner and the
 * code (one of `StopCode`) for everything else. Returns the target.
 */
export function stopWith<T extends object>(target: T, code: string, text: string): T {
  if (!(Object.values(StopCode) as string[]).includes(code))
    throw new Error(`unknown stop code: ${String(code).slice(0, UNKNOWN_VALUE_CHARS)}`);
  const out = target as T & Stopped;
  out.stopCode = code;
  out.stoppedBecause = text;
  return target;
}

/** A stop as the pair it is: `{ code, text }` (code `null` for a record written before codes existed). */
export function stopOf(result: Stopped | null | undefined): { code: string | null; text: string } {
  return {
    code: typeof result?.stopCode === "string" ? result.stopCode : null,
    text: typeof result?.stoppedBecause === "string" ? result.stoppedBecause : "",
  };
}

/** Did this facet end before its work for a reason no build could have fixed? */
export function diedEarly(result: Stopped | null | undefined): boolean {
  return DIED_EARLY.has(stopOf(result).code);
}

/**
 * Where a director's worker is. A worker is `running` from `worker_start` until its run settles.
 * Journals and `director_worker` records keep it: never rename a value.
 */
export const WorkerState = {
  Running: "running",
  Done: "done",
  Stopped: "stopped",
  Failed: "failed",
} as const;
export type WorkerState = (typeof WorkerState)[keyof typeof WorkerState];

/** Is this worker still at work? */
export function isRunning(worker: { state?: string } | null | undefined): boolean {
  return worker?.state === WorkerState.Running;
}

/** How a director's worker works: a loop of judged rounds on a board, or one session. */
export const WorkerMode = {
  Loop: "loop",
  Single: "single",
} as const;
export type WorkerMode = (typeof WorkerMode)[keyof typeof WorkerMode];

/** Move a worker to `state` (one of `WorkerState`); anything else is a bug, and says so. */
export function setWorkerState(worker: { state?: string }, state: string): string {
  if (!(Object.values(WorkerState) as string[]).includes(state))
    throw new Error(`unknown worker state: ${String(state).slice(0, UNKNOWN_VALUE_CHARS)}`);
  worker.state = state;
  return state;
}
