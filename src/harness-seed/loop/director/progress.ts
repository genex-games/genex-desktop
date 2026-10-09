import { updateRef } from "../git.ts";
import { runRef } from "../repo.ts";
/** Local, recoverable progress; a checkpoint never implies landing or publication. */
import { GoalStatus } from "./goals.ts";
import { MINUTE_MS } from "../time.ts";
import type { GoalLedger } from "./goals.ts";
import type { LoopRun } from "./loop-run.ts";

const SOFT_REVIEW_MS = 30 * MINUTE_MS;
/**
 * How much working time may pass before a goal build's lead is nudged again to verify the outcomes
 * still unverified: a lead told once tends never to playtest them.
 */
const VERIFY_NUDGE_EVERY_MS = 60 * MINUTE_MS;

/** A goal build's required outcomes on the current revision: how many, how many verified, and which are not. */
export interface OutcomeTally {
  verified: number;
  required: number;
  unverified: string[];
}

/** When the lead was last nudged, and what has happened since, as `verifyNudgeDue` weighs it. */
export interface NudgeFacts {
  tally: OutcomeTally;
  /** The working time now. */
  workedMs: number;
  /** The working time of the last nudge; null before the first (counted from the start). */
  nudgedWorkedMs: number | null;
  /** The art director has reviewed the integration since the last nudge. */
  reviewedSince: boolean;
}

/**
 * The required outcomes verified on `head` — passed on that very revision, as goals.ts
 * `goalDecision` reads them — and the ids of those that are not. Optional goals never hold a finish
 * and are not counted.
 */
export function outcomeTally(ledger: GoalLedger, head: string | null): OutcomeTally {
  const required = ledger.entries.filter((goal) => goal.required);
  const verifiedOnHead = (goal: GoalLedger["entries"][number]): boolean =>
    goal.status === GoalStatus.Passed && head !== null && goal.head === head;
  const unverified = required.filter((goal) => !verifiedOnHead(goal)).map((goal) => goal.id);
  return { verified: required.length - unverified.length, required: required.length, unverified };
}

/**
 * Is the lead owed the nudge to verify its outcomes: a required one is unverified on the current
 * revision, and the art director has reviewed the build since the last nudge, or
 * `VERIFY_NUDGE_EVERY_MS` of working time has passed since it (since the start, before the first).
 */
export function verifyNudgeDue({ tally, workedMs, nudgedWorkedMs, reviewedSince }: NudgeFacts): boolean {
  if (!tally.unverified.length) return false;
  return reviewedSince || workedMs - (nudgedWorkedMs ?? 0) >= VERIFY_NUDGE_EVERY_MS;
}

/** Independently verified requirements at one immutable integration revision. */
export interface PlayableCheckpoint {
  head: string;
  at: number;
  verifiedGoals: string[];
  requiredGoals: number;
}

/** Preserve the first verified milestone and the newest recoverable one without rewriting a game. */
export async function keepCheckpoint(loopRun: LoopRun, head: string): Promise<void> {
  const goals = loopRun.state.goals;
  if (!goals) return;
  const verifiedGoals = goals.entries
    .filter((goal) => goal.head === head && goal.status === GoalStatus.Passed)
    .map((goal) => goal.id);
  if (!verifiedGoals.length) return;
  await updateRef(loopRun.ctx, { project: loopRun.run.project }, runRef(loopRun.run.runId, "checkpoints", head), head);
  const checkpoint: PlayableCheckpoint = {
    head,
    at: Date.now(),
    verifiedGoals,
    requiredGoals: goals.entries.filter((goal) => goal.required).length,
  };
  const director = loopRun.journal.director;
  const first = !director.firstVerifiedCheckpoint;
  director.firstVerifiedCheckpoint ??= checkpoint;
  director.latestVerifiedCheckpoint = checkpoint;
  loopRun.report.firstVerifiedCheckpoint = director.firstVerifiedCheckpoint;
  loopRun.report.latestVerifiedCheckpoint = checkpoint;
  if (first)
    await loopRun.decision(
      `Verified checkpoint ${head}: ${verifiedGoals.join(", ")}. Remaining requirements are not yet verified.`,
      "A verified checkpoint is saved. You can ask to show this build now; Stop keeps it recoverable without overwriting your game.",
    );
  await loopRun.saveJournal();
}

/** A soft review informs the user once; it never cancels healthy required work. */
export function progressReview(
  ledger: GoalLedger,
  head: string | null,
  elapsedMs: number,
  reviewed: boolean,
): string | null {
  if (reviewed || elapsedMs < SOFT_REVIEW_MS) return null;
  const verified = ledger.entries.filter((goal) => goal.status === GoalStatus.Passed && goal.head === head);
  const blocked = ledger.entries.filter((goal) => goal.status === GoalStatus.Blocked);
  const blockers = blocked.map((goal) => `${goal.id}: ${goal.blocker}`).join("; ");
  return `Build review: ${verified.length}/${ledger.entries.length} outcomes verified on the current revision.${blockers ? ` Blocked: ${blockers}.` : " Required work continues."} Saved checkpoints remain recoverable.`;
}

/** Durable review state survives Resume, so a paused run does not repeat its milestone. */
export async function reviewProgress(loopRun: LoopRun, now: number): Promise<void> {
  const ledger = loopRun.state.goals;
  if (!ledger) return;
  const director = loopRun.journal.director;
  const text = progressReview(
    ledger,
    loopRun.state.integrationHead,
    now - loopRun.started,
    director.softReviewAt !== undefined,
  );
  if (!text) return;
  director.softReviewAt = now;
  await loopRun.decision(text, text);
  await loopRun.saveJournal();
}
