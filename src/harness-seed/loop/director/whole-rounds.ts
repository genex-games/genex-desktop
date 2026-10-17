/**
 * A loop worker's time in whole rounds of its game (workers.ts `startWorker`). A new module, so a
 * kept older budgets.ts never hides it from its caller.
 */
import { ITERATION_HEADROOM } from "../facet/rules.ts";

/**
 * A worker's budget fitted to whole rounds of this game (`medianMs`, the run's median round, its
 * judging included): the nearest number of rounds the loop will start — it wants a quarter of a
 * round to spare before each (`tooLateToStart`) — at least one, and no more than the run has time
 * for. A budget that ends part-way through a round leaves that part unused, since no round starts
 * that cannot finish. Unmeasured (no round on this game yet), or with no room for even one round,
 * the budget stands as asked (`rounds: null`).
 */
export function wholeRoundsBudget(
  budgetMs: number,
  medianMs: number | null,
  remainingMs: number,
): { budgetMs: number; rounds: number | null } {
  if (!medianMs || medianMs <= 0) return { budgetMs, rounds: null };
  const spare = ITERATION_HEADROOM - 1;
  const wanted = Math.max(1, Math.round(budgetMs / medianMs - spare));
  const rounds = Math.min(wanted, Math.floor(remainingMs / medianMs - spare));
  if (rounds < 1) return { budgetMs, rounds: null };
  return { budgetMs: Math.min(remainingMs, Math.ceil((rounds + spare) * medianMs)), rounds };
}
