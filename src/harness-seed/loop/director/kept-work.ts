/**
 * Work a worker kept without a verdict: a round the run's close or the lead stopped, committed on
 * its `…-stopped` ref (facet/stop.ts). Nobody judged it, so it goes into the build only once a
 * judge prefers it to the integration branch (`judge target=<id> against=integration`, then
 * `integrate`) — or through a worker started from it, judged the same way. The studio puts it on the
 * record (an `integration_merge` for its part) once the build holds it, so the Builds graph shows
 * that work added, never left out; one that went in unjudged is said to the lead.
 */
import { headOf, isAncestor } from "../git.ts";
import { isCommit } from "../shell.ts";
import { RunEvent } from "../run-events.ts";
import { isRunning } from "../outcomes.ts";
import { KEPT_WORDS } from "./kept-work-prompts.ts";
import type { LoopRun, Worker } from "./loop-run.ts";

/** Who records the build holding kept work: the director's own integration. */
const KEPT_STAGE = "director";

/** Kept work the record has not yet seen reach the build, whether a judge let it in, and how to mark it seen. */
interface PendingKept {
  id: string;
  commit: string;
  judged: boolean;
  seen: () => void;
}

/**
 * What an ended worker kept beyond its last accepted commit: its worktree's head when that is a
 * commit of its own (its stopped round's), else null. Read once the worker has ended.
 */
export async function keptWorkOf(loopRun: LoopRun, worker: Worker): Promise<string | null> {
  if (!worker.worktree) return null;
  const head = await headOf(loopRun.ctx, worker.worktree).catch(() => null);
  if (!isCommit(head) || head === worker.lastCommit || head === worker.from) return null;
  return head;
}

/** This session's ended workers and the ones from before the pause whose kept work is not on the record yet. */
function pendingKept(loopRun: LoopRun): PendingKept[] {
  const { journal, state } = loopRun;
  const own = [...state.workers.values()]
    .filter((worker) => !isRunning(worker) && isCommit(worker.keptCommit) && !worker.keptInBuild)
    .map((worker) => ({
      id: worker.id,
      commit: String(worker.keptCommit),
      judged: worker.keptJudged === worker.keptCommit,
      seen: () => {
        worker.keptInBuild = true;
      },
    }));
  const prior = (loopRun.priorWorkers ?? [])
    .filter((worker) => isCommit(worker.kept) && !worker.keptInBuild && !state.workers.has(worker.id))
    .map((worker) => ({
      id: worker.id,
      commit: String(worker.kept),
      judged: false,
      seen: () => {
        worker.keptInBuild = true;
        const record = journal?.director?.workers?.[worker.id];
        if (record) record.keptInBuild = true;
      },
    }));
  return [...own, ...prior];
}

/**
 * Put on the record each kept work the build at `head` now holds: one `integration_merge` for its
 * part, once. Called whenever the integration head moves (the lead's own commits, a worker's merge).
 * Work no judge let in is said to the lead — the build now holds something nobody looked at — unless
 * a worker's merge brought it (`throughMerge`): `integrate` takes only judged work, so a worker
 * started from kept work was judged on top of it.
 */
export async function noteKeptWork(loopRun: LoopRun, head: string | null, throughMerge = false): Promise<void> {
  const { appendRun, ctx, integrationWorktree, note, run } = loopRun;
  if (!isCommit(head)) return;
  const label = `director:${run.runId}:kept-work`;
  let noted = 0;
  for (const kept of pendingKept(loopRun)) {
    if (!(await isAncestor(ctx, integrationWorktree, kept.commit, { label }))) continue;
    kept.seen();
    noted += 1;
    if (!kept.judged && !throughMerge) note?.(KEPT_WORDS.inUnjudged(kept.id, kept.commit));
    await appendRun(RunEvent.IntegrationMerge, {
      facetId: kept.id,
      commit: kept.commit,
      head,
      conflict: false,
      stage: KEPT_STAGE,
    }).catch(() => {});
  }
  // Saved at once, so a pause right after never records the same work twice.
  if (noted) await loopRun.saveJournal().catch(() => {});
}
