/**
 * The finish check of the Builds graph (`run-graph.ts`): a run's `finish_check` records folded by
 * round, and where the newest round leaves the check in the owner's four looks. A round's later
 * record wins over its earlier one, but keeps the claim its checking record named. A round still
 * checking when a close of its run follows (finished or paused) had no answer: no reviewer is at
 * work after it, and the chat says the same (`narrateRunFinishSettled`). A finished run reopened for
 * a new ask counts its check afresh: the rounds before stay listed, but neither the look nor the
 * no's in a row read them.
 */
import { FinishCheckStep, type FinishRecord } from "../shared/finish-check.ts";

/** Where the finish check stands: not yet run, checking, done, or stopped the run's claim. */
export const FinishCheckState = {
  NotYet: "not_yet",
  Checking: "checking",
  Done: "done",
  Stopped: "stopped",
} as const;
export type FinishCheckState = (typeof FinishCheckState)[keyof typeof FinishCheckState];

/** One round of a finish check: how far it got, the reviewer's reasons or why it had no answer, and the lead's claim. */
export interface FinishRound {
  round: number;
  step: FinishCheckStep;
  reasons: string[];
  why: string | null;
  claim: string | null;
  /** this no was the last one the Loop takes: it stopped */
  stopped: boolean;
}

/** What the finish check's node says, from its rounds. */
export interface FinishCheckFields {
  state: FinishCheckState;
  /** the newest round's reasons */
  reasons: string[];
  /** the newest round, null before any */
  round: number | null;
  /** the reviewer's no's in a row */
  rejections: number;
  /** why the newest round had no answer */
  why: string | null;
  /** every round, oldest first */
  rounds: FinishRound[];
  /** the run no longer waits for its check: no further round will come */
  over: boolean;
}

/** A run's finish check rounds as they are read, by round. */
export type FinishLedger = Map<number, FinishRound>;

/** A round's record onto its round: the later record wins, keeping the claim an earlier one named. */
export function foldFinishRecord(ledger: FinishLedger, record: FinishRecord): void {
  const prior = ledger.get(record.round);
  ledger.set(record.round, {
    round: record.round,
    step: record.step,
    reasons: record.reasons,
    why: record.why,
    claim: record.claim ?? prior?.claim ?? null,
    stopped: record.step === FinishCheckStep.Rejected && record.stopped,
  });
}

/** A close of the run: every round still checking had no answer (a later record of it still wins). */
export function settleOpenRounds(ledger: FinishLedger): void {
  for (const [round, entry] of ledger)
    if (entry.step === FinishCheckStep.Checking) ledger.set(round, { ...entry, step: FinishCheckStep.Unanswered });
}

/** The reviewer's no's in a row, newest first: a yes ends the row, a round with no answer or still checking neither counts nor breaks it. */
function rejectionsInARow(rounds: FinishRound[]): number {
  let count = 0;
  for (const round of [...rounds].reverse()) {
    if (round.step === FinishCheckStep.Accepted) break;
    if (round.step === FinishCheckStep.Rejected) count += 1;
  }
  return count;
}

/** The look of the newest round: checking, done after a yes, stopped by the last no, else not yet. */
function stateOf(newest: FinishRound | undefined): FinishCheckState {
  if (newest?.step === FinishCheckStep.Checking) return FinishCheckState.Checking;
  if (newest?.step === FinishCheckStep.Accepted) return FinishCheckState.Done;
  if (newest?.stopped) return FinishCheckState.Stopped;
  return FinishCheckState.NotYet;
}

/** A round still checking when its run is over had no answer: no reviewer is at work any more. */
function settledRound(round: FinishRound, over: boolean): FinishRound {
  return over && round.step === FinishCheckStep.Checking ? { ...round, step: FinishCheckStep.Unanswered } : round;
}

/**
 * The finish check's node fields from a run's rounds; with none, the place it waits in. `over`: the
 * run no longer waits for its check (it finished, and is not paused), so a round it left checking
 * reads as one with no answer. `from`: the first round of the run's current ask (a reopened run's);
 * earlier rounds are listed only.
 */
export function finishCheckFields(ledger: FinishLedger, over = false, from = 0): FinishCheckFields {
  const rounds = [...ledger.values()].sort((a, b) => a.round - b.round).map((round) => settledRound(round, over));
  const current = rounds.filter((round) => round.round >= from);
  const newest = current.at(-1);
  return {
    state: stateOf(newest),
    reasons: newest?.reasons ?? [],
    round: newest?.round ?? null,
    rejections: rejectionsInARow(current),
    why: newest?.step === FinishCheckStep.Unanswered ? newest.why : null,
    rounds,
    over,
  };
}
