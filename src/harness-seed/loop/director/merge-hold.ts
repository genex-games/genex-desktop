/**
 * Running loop workers' hold on the head before a worker's merge (`LoopRunState.headBeforeMerge`,
 * read by workers.ts `freshBase`): taken when a merge lands, let go once anybody sees the integration
 * head load — its health pass, a judge, a fork gate — or the lead closes the wave by hand. A new
 * module, so a kept older integrate.ts, tools.ts or workers.ts never hides it from the others.
 */
import type { LoopRunState } from "./loop-run.ts";

/** What the hold reads and moves on the run. */
type HoldState = Pick<LoopRunState, "headBeforeMerge" | "integrationHead" | "integrationHealthy">;

/**
 * Hold running loop workers on the head before a merge until it is seen to load; answers whether
 * this merge took the hold — a wave a conflict stopped before anybody looked keeps an earlier one.
 */
export function holdBaseForMerge(state: HoldState, previousHead: string | null): boolean {
  if (state.headBeforeMerge) return false;
  state.headBeforeMerge = previousHead;
  return true;
}

/**
 * A merge that stopped before its health pass (a conflict, or nothing to merge). What merged before
 * it is on the branch and nobody has looked at it: its health is unknown, and the hold stays until a
 * look. With nothing merged, this merge's hold is let go.
 */
export function unlookedAfterMerge(state: HoldState, held: boolean, mergedAny: boolean): void {
  if (mergedAny) state.integrationHealthy = null;
  else if (held) state.headBeforeMerge = null;
}

/** A look answered for `head`: once the integration head is seen to load, workers take it. */
export function headLooked(state: HoldState, head: string | null, loads: boolean): void {
  if (!loads || !head) return;
  if (head === state.integrationHead) state.headBeforeMerge = null;
}

/** The health pass answered, or the lead closed the wave by hand: workers take the head as it stands. */
export function releaseMergeHold(state: HoldState): void {
  state.headBeforeMerge = null;
}
