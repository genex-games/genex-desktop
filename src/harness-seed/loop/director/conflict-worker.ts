/**
 * A merge conflict goes to a worker (one session, lead-session.ts). The lead of a waking run is
 * its chat's own session and writes nothing while the build runs, so when `integrate` meets a
 * conflict it no longer tells the lead to merge by hand: the studio starts a single-session worker
 * from the integration branch, opens the same merge in that worker's worktree, and briefs it to
 * resolve the conflicted files keeping both sides' work. The studio commits the merge when the
 * session stops; the lead integrates that worker like any other.
 *
 * A session may stop — done, unfinished or stopped — with conflict markers still in a file: then
 * nothing of it is committed, the merge is aborted, and the worker failed naming those files
 * (`markersLeft`), so `integrate` refuses it (`unresolvedOf`) instead of landing the markers.
 *
 * A director with its own hands (the long turn, a kept older director.ts) still resolves a
 * conflict in its own worktree (integrate.ts).
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { GIT, gitExec, headOf } from "../git.ts";
import { setWorkerState, WorkerMode, WorkerState } from "../outcomes.ts";
import { slug } from "./args.ts";
import { CONFLICT_WORDS } from "./lead-session-prompts.ts";
import { BuildTarget } from "./loop-run.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { ExecResult } from "../../types/host-api.d.ts";
import type { ConflictFacts } from "./lead-session-prompts.ts";
import type { LoopRun, Worker } from "./loop-run.ts";

/**
 * The merge a conflict worker's worktree is opened on, keyed by a symbol: the arguments of a
 * `worker_start` the lead calls arrive as JSON, which cannot carry one, so only the studio asks for it.
 */
export const CONFLICT_MERGE: unique symbol = Symbol("conflict merge");

/** What a conflict worker merges: the worker whose work conflicted, and its commit. */
export interface ConflictMerge {
  of: string;
  commit: string;
  /** The files git stopped on when the merge was opened in its worktree (`mergeFirst`). */
  conflicts?: string[];
  /** The files its session left with conflict markers: nothing of it was committed (`markersLeft`). */
  unresolved?: string[];
}

/** Start arguments that may carry a conflict merge (`CONFLICT_MERGE`). */
type MergeArgs = AnyRecord & { [CONFLICT_MERGE]?: ConflictMerge };

/** A conflict worker's budget, in minutes: a merge, not a feature. */
const CONFLICT_MINUTES = 20;
/** The ids a conflict worker takes, tried in turn when an earlier one is taken. */
const MAX_CONFLICT_IDS = 20;

/** How the merge in a conflict worker's worktree went: merged cleanly, left conflicts to resolve, or failed. */
export interface OpenedMerge {
  clean: boolean;
  conflicts: string[];
  error: string | null;
}

/**
 * A whole conflict hunk git left in a file: an opening `<<<<<<<` line, a `=======` line and a
 * closing `>>>>>>>` line, in that order. The same markers the FACET WIRING merge refuses
 * (merge.ts `verifyWiringMerge`), read as a hunk so a Markdown heading underlined with `=======`
 * is not taken for one.
 */
const CONFLICT_HUNK = /^<{7}(?: .*)?$[\s\S]*?^={7}\s*$[\s\S]*?^>{7}(?: .*)?$/m;

/** Does this text still hold a conflict hunk? */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_HUNK.test(text);
}

/** A free id for the worker that merges `of`: `merge-<of>`, then `merge-<of>-2`, and so on. */
function conflictWorkerId(loopRun: LoopRun, of: string): string {
  const taken = new Set([...loopRun.state.workers.keys(), ...(loopRun.priorWorkers ?? []).map((w) => w.id)]);
  const base = slug(`merge-${of}`);
  for (let n = 1; n <= MAX_CONFLICT_IDS; n += 1) {
    const id = n === 1 ? base : slug(`${base}-${n}`);
    if (!taken.has(id)) return id;
  }
  return slug(`${base}-${Date.now().toString(36)}`);
}

/** The worker id `worker_start` answered with, when it started one. */
function startedId(answer: unknown): string | null {
  try {
    const parsed = JSON.parse(String(answer));
    return typeof parsed?.started === "string" ? parsed.started : null;
  } catch {
    return null;
  }
}

/**
 * Start the worker that resolves `worker`'s conflict with the integration branch, and answer what
 * `integrate` tells the lead: that worker's id and what to do when it ends — or why none started.
 */
export async function resolveByWorker(loopRun: LoopRun, worker: Worker, commit: string, conflicts: string[]) {
  const { note, shape, startWorker } = loopRun;
  const facts: ConflictFacts = { of: worker.id, title: worker.title, commit, conflicts };
  const id = conflictWorkerId(loopRun, worker.id);
  const merge: ConflictMerge = { of: worker.id, commit };
  const args: MergeArgs = {
    id,
    title: CONFLICT_WORDS.title(worker.title),
    brief: CONFLICT_WORDS.brief(facts),
    mode: WorkerMode.Single,
    minutes: String(CONFLICT_MINUTES),
    from: BuildTarget.Integration,
    owns: conflicts.join(","),
    owns_main: shape?.main && conflicts.includes(shape.main) ? "yes" : "no",
    [CONFLICT_MERGE]: merge,
  };
  const answer = await startWorker(args);
  if (startedId(answer) !== id) return CONFLICT_WORDS.refused(String(answer), facts);
  note(`integrate ${worker.id}: the conflict went to worker ${id}`);
  return CONFLICT_WORDS.started(id, facts);
}

/** The merge a worker record carries, when it is a conflict worker (read off its start arguments). */
export function conflictMergeOf(args: MergeArgs | null | undefined): ConflictMerge | null {
  const merge = args?.[CONFLICT_MERGE];
  return merge && typeof merge.commit === "string" ? merge : null;
}

/**
 * Open the merge in the conflict worker's own worktree before its session starts: merged cleanly
 * (the integration branch had moved), or stopped on conflicts the session resolves — never aborted,
 * so the studio's commit when the session stops is the merge commit.
 */
export async function openConflictMerge(loopRun: LoopRun, worker: Worker, merge: ConflictMerge): Promise<OpenedMerge> {
  const { ctx, run } = loopRun;
  const label = `director:${run.runId}:conflict:${worker.id}`;
  const message = `worker ${worker.id}: merge ${merge.of}`;
  const exec: Pick<ExecResult, "code" | "stdout" | "stderr"> = await gitExec(
    ctx,
    worker.worktree,
    GIT.merge(merge.commit, { message, noEdit: true }),
    {
      label,
    },
  ).catch((err: any) => ({ code: 1, stdout: "", stderr: String(err?.message ?? err) }));
  if (exec.code === 0) {
    worker.lastCommit = await headOf(ctx, worker.worktree).catch(() => null);
    return { clean: true, conflicts: [], error: null };
  }
  const unmerged = await gitExec(ctx, worker.worktree, GIT.unmerged, { label }).catch(() => ({ stdout: "" }));
  const conflicts = String(unmerged?.stdout ?? "")
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
  if (conflicts.length) return { clean: false, conflicts, error: null };
  await gitExec(ctx, worker.worktree, GIT.mergeAbort, { label }).catch(() => {});
  return { clean: false, conflicts: [], error: String(exec.stderr || exec.stdout || "the merge failed") };
}

/**
 * A conflict worker's merge, opened before its session: answers true when nothing is left for a
 * session — the merge went through on its own (the integration branch had moved), or git failed
 * before it reached a conflict — with the worker's end set; false when its session resolves it.
 */
export async function mergeFirst(loopRun: LoopRun, worker: Worker): Promise<boolean> {
  const merge = worker.merging;
  if (!merge) return false;
  const opened = await openConflictMerge(loopRun, worker, merge);
  merge.conflicts = opened.conflicts;
  if (opened.clean) {
    worker.summary = CONFLICT_WORDS.mergedCleanly(merge.of);
    setWorkerState(worker, WorkerState.Done);
    return true;
  }
  if (!opened.error) return false;
  worker.error = opened.error;
  setWorkerState(worker, WorkerState.Failed);
  return true;
}

/** The paths `git diff --diff-filter=U` names in a worktree: those still unmerged. */
async function stillUnmerged(loopRun: LoopRun, worker: Worker, label: string): Promise<string[]> {
  const unmerged = await gitExec(loopRun.ctx, worker.worktree, GIT.unmerged, { label }).catch(() => ({ stdout: "" }));
  return String(unmerged?.stdout ?? "")
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

/** Does this file of the worktree still hold a conflict hunk? A link is never read through. */
async function fileHasMarkers(worktree: string, rel: string): Promise<boolean> {
  const file = path.join(worktree, rel);
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  return hasConflictMarkers(await readFile(file, "utf8").catch(() => ""));
}

/**
 * After a conflict worker's session, whatever ended it: when a file it was to resolve — or one
 * git still lists unmerged — holds conflict markers, nothing of its work is committed, the merge
 * is aborted, and its error names those files (answers true: the caller marks it failed). Answers
 * false for a worker that merges nothing, or one whose files are clean.
 */
export async function markersLeft(loopRun: LoopRun, worker: Worker): Promise<boolean> {
  const merge = worker.merging;
  if (!merge) return false;
  const label = `director:${loopRun.run.runId}:conflict:${worker.id}`;
  const files = [...new Set([...(merge.conflicts ?? []), ...(await stillUnmerged(loopRun, worker, label))])];
  const unresolved: string[] = [];
  for (const rel of files) if (await fileHasMarkers(worker.worktree, rel)) unresolved.push(rel);
  if (!unresolved.length) return false;
  merge.unresolved = unresolved;
  await gitExec(loopRun.ctx, worker.worktree, GIT.mergeAbort, { label }).catch(() => {});
  worker.error = CONFLICT_WORDS.markersLeft(unresolved);
  return true;
}

/** What `integrate` answers about a conflict worker that left conflict markers, or null for any other worker. */
export function unresolvedOf(worker: Worker): string | null {
  const merge = worker.merging;
  if (!merge?.unresolved?.length) return null;
  return CONFLICT_WORDS.unresolved(worker.id, merge.of, merge.unresolved);
}
