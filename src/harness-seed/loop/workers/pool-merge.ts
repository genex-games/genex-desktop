/**
 * A copy worker's work, handed back: committed in its copy when it ends, merged into the lead's
 * folder on `worker_mark used` with the merge the director uses (conflicts aborted and named for the
 * lead), dropped on `rejected`, and kept on a ref in the game's repository when the chat turn that
 * started it closes, so a later turn can still merge it. Its own git command lines live here, so a
 * kept older `git.ts` still loads beside it.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { GIT, gitAt, gitExec, headOf, mergeNoFf, shortFailure, updateRef } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { commitArg, isCommit } from "../shell.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import { throughClaudeFolder } from "./claude-folder.ts";
import { WorkerIsolation, WorkerVerdict } from "./contract.ts";
import { poolWorkerId, recordWorkerFinished } from "./events.ts";
import { POOL_WORDS } from "./prompts.ts";
import {
  eventScope,
  gameGitWrite,
  isWorking,
  keptRef,
  type PoolState,
  persist,
  recordOf,
  type WorkerRecord,
  WorkerState,
} from "./records.ts";

/** The git command lines only the pool runs. */
const WORKER_GIT = {
  /** The paths `commit` changed since it left the branch `HEAD` stands on. */
  changedSince: (commit: unknown): string => `git diff --name-only HEAD...${commitArg(commit)}`,
  /** The same, NUL-separated and with a rename as both its sides: every path, however it is named. */
  everyPathSince: (commit: unknown): string => `git diff --name-only --no-renames -z HEAD...${commitArg(commit)}`,
} as const;

/** The verdicts the lead may give, as it sends them. */
const VERDICTS: readonly string[] = Object.values(WorkerVerdict);

/** The paths a `git status --porcelain` line names (a rename names both sides). */
function porcelainPaths(line: string): string[] {
  const rest = line.slice(3).trim();
  return rest.includes(" -> ") ? rest.split(" -> ") : [rest];
}

/**
 * Commit everything a copy worker changed, under the studio's name, and answer the commit when it
 * holds work (null when it changed nothing, or git could not commit). Asked again, it adds what
 * changed since.
 */
export async function commitCopy(state: PoolState, record: WorkerRecord): Promise<string | null> {
  const { worktree } = record;
  if (!worktree) return record.commit;
  const { ctx } = state.scope;
  try {
    await gitAt(ctx, worktree, GIT.addAll);
    await gitAt(ctx, worktree, GIT.commitIfStaged(POOL_WORDS.workCommit(record.id, record.title)));
    const head = await headOf(ctx, worktree);
    record.commit = isCommit(head) && head !== record.base ? head : record.commit;
  } catch {
    // A copy git cannot commit in keeps what it had; the lead hears it changed nothing new.
  }
  return record.commit;
}

/** Remove a worker's copy once nothing needs it: its work is in its commit. */
export async function removeCopy(state: PoolState, record: WorkerRecord): Promise<void> {
  const { worktree } = record;
  if (!worktree) return;
  record.worktree = null;
  const params = { project: state.scope.project, path: worktree };
  await state.scope.ctx.call(HostMethod.SnapshotRemoveWorktree, params).catch(() => {});
}

/** Keep a copy worker's work on its ref in the game's repository, so a later turn can still merge it. */
export async function keepWork(state: PoolState, record: WorkerRecord): Promise<void> {
  const { commit } = record;
  if (!commit) return;
  const at = { project: state.scope.project };
  await gameGitWrite(state, () => updateRef(state.scope.ctx, at, keptRef(state, record.id), commit)).catch(() => {});
}

/** The lead's uncommitted files that the worker's commit also changes: git would refuse to merge over them. */
async function dirtyOverlap(state: PoolState, commit: string): Promise<string[]> {
  const { ctx, leadFolder } = state.scope;
  const status = await gitExec(ctx, leadFolder, GIT.status);
  const dirty = new Set(
    String(status.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .flatMap(porcelainPaths),
  );
  if (!dirty.size) return [];
  const changed = await gitExec(ctx, leadFolder, WORKER_GIT.changedSince(commit));
  return String(changed.stdout ?? "")
    .split("\n")
    .map((file) => file.trim())
    .filter((file) => file && dirty.has(file));
}

/**
 * What a verdict came to: the lead's answer, whether the verdict stands (a merge that failed leaves
 * none), and whether the worker's work was merged into the lead's folder.
 */
type Marked = { text: string; settled: boolean; merged?: boolean };

/**
 * Merge a copy worker's commit into the lead's folder: merged, or why not, with the files. The look
 * at the lead's files and the merge are one git write, after the lead's own.
 */
function mergeWork(state: PoolState, record: WorkerRecord, commit: string): Promise<Marked> {
  return gameGitWrite(state, () => mergeNow(state, record, commit));
}

/**
 * The files of Claude Code's own folder the worker's commit changes, or null when git could not
 * say: what no worker's work brings into the lead's folder, as no build lands them in a game.
 */
async function claudeFolderChanges(state: PoolState, commit: string): Promise<string[] | null> {
  const { ctx, leadFolder } = state.scope;
  const changed = await gitExec(ctx, leadFolder, WORKER_GIT.everyPathSince(commit)).catch(() => null);
  if (changed?.code !== 0) return null;
  return String(changed.stdout ?? "")
    .split("\0")
    .filter((file) => file && throughClaudeFolder(file));
}

/** The merge itself, once the game folder's git is free. */
async function mergeNow(state: PoolState, record: WorkerRecord, commit: string): Promise<Marked> {
  const { ctx, leadFolder } = state.scope;
  const planted = await claudeFolderChanges(state, commit);
  if (planted === null) return { text: POOL_WORDS.unchecked(record.id), settled: false };
  if (planted.length) return { text: POOL_WORDS.claudeFolder(record.id, planted), settled: false };
  const dirty = await dirtyOverlap(state, commit);
  if (dirty.length) return { text: POOL_WORDS.dirty(record.id, dirty), settled: false };
  const merge = await mergeNoFf(ctx, leadFolder, commit, {
    message: POOL_WORDS.mergeMessage(record.id, record.title),
    noEdit: true,
    rpcErrors: "fail",
    failure: shortFailure,
    listConflicts: true,
  });
  if (merge.ok) return { text: POOL_WORDS.merged(record.id), settled: true, merged: true };
  const text = merge.conflicts.length
    ? POOL_WORDS.conflict(record.id, merge.conflicts)
    : POOL_WORDS.mergeFailed(record.id, clip(merge.error, CLIP_DETAIL));
  return { text, settled: false };
}

/** The verdict on a copy worker: used merges its work (its copy goes after a clean merge), rejected drops it. */
async function markCopy(state: PoolState, record: WorkerRecord, verdict: WorkerVerdict): Promise<Marked> {
  if (verdict === WorkerVerdict.Rejected) {
    await removeCopy(state, record);
    return { text: POOL_WORDS.rejected(record.id), settled: true };
  }
  const commit = await commitCopy(state, record);
  if (!commit) {
    await removeCopy(state, record);
    return { text: POOL_WORDS.nothingToMerge(record.id), settled: true };
  }
  const merged = await mergeWork(state, record, commit);
  if (merged.settled) await removeCopy(state, record);
  return merged;
}

/** A writer in place that finished: its work is in the game folder already, whatever the lead says of it. */
const wroteInGame = (record: WorkerRecord): boolean =>
  record.isolation === WorkerIsolation.Lock && record.state === WorkerState.Done;

/**
 * `worker_mark`: the lead's word on what a worker delivered. A merge that failed leaves no verdict;
 * a verdict given stands, and work already in the game is never marked rejected, so the chat and
 * the graph never call work in the game unused.
 */
export async function markWorker(state: PoolState, args: AnyRecord): Promise<string> {
  const record = recordOf(state, args.id);
  if (!record) return POOL_WORDS.unknown(String(args.id ?? ""));
  if (isWorking(record)) return POOL_WORDS.stillRunning(record.id);
  if (!VERDICTS.includes(String(args.verdict))) return POOL_WORDS.badVerdict;
  if (record.verdict) return POOL_WORDS.alreadyMarked(record.id, record.verdict);
  const verdict = args.verdict as WorkerVerdict;
  if (verdict === WorkerVerdict.Rejected && wroteInGame(record)) return POOL_WORDS.inGameAlready(record.id);
  const marked =
    record.isolation === WorkerIsolation.Copy
      ? await markCopy(state, record, verdict)
      : { text: POOL_WORDS.markedOnly(record.id, verdict), settled: true };
  if (marked.settled) record.verdict = verdict;
  if (marked.settled && hasText(args.note)) record.note = clip(args.note.trim(), CLIP_DETAIL);
  await persist(state);
  if (marked.settled) await recordVerdict(state, record, marked.merged === true);
  return marked.text;
}

/** The lead's verdict on the chat's log, a second end record of the worker: added to the game when merged. */
function recordVerdict(state: PoolState, record: WorkerRecord, merged: boolean): Promise<void> {
  const { id, title, verdict, note } = record;
  if (!verdict) return Promise.resolve();
  const worker = { workerId: poolWorkerId(id), title, verdict, note: note ?? null, merged };
  return recordWorkerFinished(eventScope(state, record), worker, state.scope.clock.now());
}
