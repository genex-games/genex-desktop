/**
 * A goal attempt nobody could make, given back: a worker the model provider ended before any round
 * of it was judged (workers.ts `runLoopWorker`). A new module, so a kept older goals.ts or
 * workers.ts never hides it.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import type { GoalLedger } from "./goals.ts";
import type { LoopRun, Worker } from "./loop-run.ts";

/** Give back an attempt nobody could make; answers whether one was. */
export function refundGoalAttempt(ledger: GoalLedger, id: string): boolean {
  const goal = ledger.entries.find((entry) => entry.id === id);
  if (!goal || goal.attempts <= 0) return false;
  goal.attempts -= 1;
  return true;
}

/**
 * A worker the model provider ended before any round of it was judged made no attempt at its goal:
 * its attempt is given back, so a restart is never refused for "no verified progress" it never had
 * the chance to make (goals.ts `goalAttemptRefusal`).
 */
export async function refundProviderAttempt(
  loopRun: Pick<LoopRun, "saveJournal" | "state">,
  worker: Pick<Worker, "goal" | "id" | "iterations">,
  result: AnyRecord,
): Promise<void> {
  const ledger = loopRun.state.goals;
  const providerEnded = Boolean(result.limit) || Boolean(result.lostToProvider);
  const judged = worker.iterations.some((round: AnyRecord) => round.stopped !== true);
  if (!ledger || !providerEnded || judged) return;
  if (refundGoalAttempt(ledger, String(worker.goal ?? worker.id))) await loopRun.saveJournal();
}
