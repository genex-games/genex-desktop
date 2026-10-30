/**
 * A worker's stopped round, and what `integrate` does with it: it takes it as it is (Loop phase 4) —
 * the merge's health pass looks at what it brings, and no judge has to prefer it first. A judge the
 * lead asks about it (`judge target=<id> against=integration`) informs the lead and decides nothing.
 * A new module, so a kept older kept-work.ts or integrate.ts never stands between it and its callers.
 */
import { isRunning } from "../outcomes.ts";
import { isCommit } from "../shell.ts";
import type { Worker } from "./loop-run.ts";

/** An ended worker's stopped round not in the build yet: its kept commit, or null. */
function keptOutside(worker: Pick<Worker, "state" | "keptCommit" | "keptInBuild">): string | null {
  const outside = !isRunning(worker as Worker) && isCommit(worker.keptCommit) && !worker.keptInBuild;
  return outside ? String(worker.keptCommit) : null;
}

/** The stopped round `integrate` takes for `worker`: its kept commit while the build does not hold it yet. */
export function keptToMerge(
  worker: Pick<Worker, "state" | "keptCommit" | "keptInBuild" | "keptJudged">,
): string | null {
  return keptOutside(worker);
}

/**
 * What `integrate` says of a stopped round it left out for want of a judge: nothing, any more. The
 * name stays for a kept older integrate.ts that still asks.
 */
export function keptLeftOut(
  _worker: Pick<Worker, "id" | "state" | "keptCommit" | "keptInBuild" | "keptJudged">,
): string | null {
  return null;
}

/**
 * A judge the lead asked looked at a worker's kept work (`head`): recorded, so the build's record can
 * say a judge looked at it. A look that reached no verdict (`null`) leaves the last one standing.
 */
export function noteKeptJudged(
  worker: Pick<Worker, "keptCommit" | "keptJudged">,
  head: string | null,
  preferredToIntegration: boolean | null,
): void {
  // A look that reached no verdict says nothing either way.
  if (preferredToIntegration === null) return;
  if (!head || head !== worker.keptCommit) return;
  worker.keptJudged = preferredToIntegration ? head : null;
}
