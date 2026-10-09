/**
 * Git, the one way the harness speaks it.
 *
 * Every git command line the loop hands to `run.exec` (which runs it with `/bin/sh -c`) is built
 * here, from data: a commit is checked by `commitArg` before it reaches a command line, a message,
 * a path or a model-written reason reaches it through `shellQuote`, and a ref is one of the
 * studio's own (`repo.ts`, `refs/studio/…`). There used to be four copies of the helper that
 * runs them — the director's, the classic pipeline's, a facet's and a spike's — and they had
 * drifted apart in their timeouts, their trimming and what their failures said.
 *
 * Two layers:
 *  - `GIT`, the command lines themselves, pure: for code that already has its own exec (the
 *    union merge, the reviewer, the nested-repository check), and for the tests.
 *  - the helpers that run them through `ctx.call("run.exec")` in a worktree (`cwd`) or in the
 *    live game folder (`{ project }`): `gitAt`, `headOf`, `isAncestor`, `commitAll`,
 *    `updateRef`, `mergeNoFf`, `landIntegration`, `resetClean`, `gitlinks`. A sub-agent's delivery
 *    runs its command lines (`GIT.addFolder`, `GIT.treeEntries`, `GIT.checkoutPaths`) from a module
 *    of its own (`git-delivery.ts`), so a kept older copy of this file still loads beside it.
 */
import { HostMethod } from "./host-methods.ts";
import { STUDIO_AS } from "./repo.ts";
import { commitArg, REFUSED_VALUE_CHARS, shellQuote } from "./shell.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): its
 * strays are set aside with `GIT.snapshotCommit`, which an older copy lacks, so a run seats a
 * lead only when this says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;
import { GIT_TIMEOUT_MS } from "./config.ts";
import { isRecord } from "./json.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { ExecResult } from "../types/host-api.d.ts";

/** How much of a failed git command's output its short failure keeps. */
const SHORT_FAILURE_CHARS = 2_000;

/** What `run.exec` answered, as far as a failure's wording reads it. */
export interface ExecAnswer {
  code?: number | null;
  stdout?: string;
  stderr?: string;
}
/** The error a failed command throws with. */
export type FailureWording = (exec: ExecAnswer, command?: string) => string;
export interface ExecOptions {
  label?: string | null;
  timeoutMs?: number;
}
/** A worktree, or the live game folder. */
export type Where = string | { cwd?: string; project?: string };
/** How a command's output is trimmed. */
export type Trim = "end" | "both" | "none";
/** What each way of trimming a command's answer does to it. */
const TRIMS: Record<Trim, (out: string) => string> = {
  end: (out) => out.trimEnd(),
  both: (out) => out.trim(),
  none: (out) => out,
};
/** What a merge came to. */
export type MergeOutcome =
  | { ok: true; union: boolean; resolved?: any }
  | { ok: false; error: string; conflicts: string[]; resolved: any };

/** How much of a commit a sentence for the lead or the log quotes. */
export const SHORT_SHA_LENGTH = 10;
/** How much of a commit a capture or snapshot label (`gate_<sha>`, `health_<sha>`) carries. */
export const LABEL_SHA_LENGTH = 8;

/** A commit as a line quotes it: its first `length` characters (`String(sha)`, as the lines always wrote it). */
export function shortSha(sha: unknown, length: number = SHORT_SHA_LENGTH): string {
  return String(sha).slice(0, length);
}

/**
 * A ref the studio writes. Only its own names, spelled only with what a ref name and a shell
 * word both take as plain text — a run id or a facet id that carried anything else is refused
 * before it reaches a command line.
 */
export function refArg(value: unknown): string {
  const ref = String(value ?? "");
  if (!/^refs\/studio\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes(".."))
    throw new Error(`not a studio ref: ${JSON.stringify(ref).slice(0, REFUSED_VALUE_CHARS)}`);
  return ref;
}

/** `git commit` flags, in the order the harness has always written them. */
function commitFlags({
  allowEmpty = false,
  only = null,
  noEdit = false,
}: {
  allowEmpty?: boolean;
  only?: string[] | null;
  noEdit?: boolean;
} = {}): string {
  return `-q${allowEmpty ? " --allow-empty" : ""}${only ? " --only" : ""}${noEdit ? " --no-edit" : ""}`;
}

/** The command lines, as data. Nothing here runs anything. */
export const GIT = Object.freeze({
  head: "git rev-parse HEAD",
  /** How many commits the branch holds: a game the studio just made has its one. */
  commitCount: "git rev-list --count HEAD",
  status: "git status --porcelain",
  /**
   * A look that never writes (`--no-optional-locks`, no `git add`), capped: the monitor reads a
   * running worker's worktree without taking the index lock its own commit needs.
   */
  statusReadOnly: (maxBytes: number): string =>
    `git --no-optional-locks status --porcelain | head -c ${Number(maxBytes)}`,
  diffReadOnly: (maxBytes: number): string => `git --no-optional-locks diff -U0 | head -c ${Number(maxBytes)}`,
  addAll: "git add -A",
  /** Intent-to-add: a new file shows in `git diff` without anything being staged for real. */
  intentToAddAll: "git add -A -N -- .",
  /** Stage one file; `force` stages it even where .gitignore covers it (the module contract's file). */
  addPath: (file: string, { force = false }: { force?: boolean } = {}): string =>
    `git add${force ? " -f" : ""} -- ${shellQuote(file)}`,
  commit: (message: string, options: { allowEmpty?: boolean; only?: string[] | null; noEdit?: boolean } = {}): string =>
    `git ${STUDIO_AS} commit ${commitFlags(options)} -m ${shellQuote(message)}${options.only ? ` -- ${options.only.map(shellQuote).join(" ")}` : ""}`,
  /**
   * Stage everything and write it as a commit over HEAD under the studio's name, moving no branch:
   * answers the commit's hash, for a ref to keep (the worktree still holds the changes).
   */
  snapshotCommit: (message: string): string =>
    `git add -A && git ${STUDIO_AS} commit-tree $(git write-tree) -p HEAD -m ${shellQuote(message)}`,
  /** Commit what is staged, and nothing when nothing is (`--allow-empty` would record a no-op). */
  commitIfStaged: (message: string): string =>
    `(git diff --cached --quiet || git ${STUDIO_AS} commit -q -m ${shellQuote(message)})`,
  merge: (
    commit: unknown,
    { message, noFf = true, noEdit = false }: { message: unknown; noFf?: boolean; noEdit?: boolean },
  ): string =>
    `git ${STUDIO_AS} merge${noFf ? " --no-ff" : ""}${noEdit ? " --no-edit" : ""} -m ${shellQuote(message)} ${commitArg(commit)}`,
  mergeAbort: "git merge --abort || true",
  /** The paths a failed merge left unmerged, one per line. */
  unmerged: "git diff --name-only --diff-filter=U",
  isAncestor: (commit: unknown): string =>
    `git merge-base --is-ancestor ${commitArg(commit)} HEAD && echo yes || echo no`,
  updateRef: (ref: unknown, rev: unknown): string => `git update-ref ${refArg(ref)} ${commitArg(rev)}`,
  reset: (rev: unknown): string => `git reset -q --hard ${commitArg(rev)}`,
  clean: "git clean -qfd",
  revListCount: (from: unknown, to: unknown): string => `git rev-list --count ${commitArg(from)}..${commitArg(to)}`,
  /** The first-parent line from `head` back to (not into) what `since` holds, newest first, at most `max` commits. */
  firstParentLine: (head: unknown, since: unknown, max: number): string =>
    `git rev-list --first-parent --max-count=${Number(max)} ${commitArg(head)} ^${commitArg(since)}`,
  diffStat: (base: unknown): string => `git diff --stat ${commitArg(base)} HEAD -- . ':(exclude).studio/*'`,
  /** Paths changed against `base`, restricted to `pathspec` (already-quoted shell words). */
  diffNames: (base: unknown, pathspec: string): string => `git diff --name-only ${commitArg(base)} -- ${pathspec}`,
  diff: (base: unknown, pathspec: string): string => `git diff ${commitArg(base)} -- ${pathspec}`,
  /** Does `rev:file` exist? Answers `yes` or `no` on stdout. */
  catFileExists: (rev: string, file: string): string =>
    `git cat-file -e ${shellQuote(`${rev}:${file}`)} && echo yes || echo no`,
  checkoutPath: (rev: unknown, file: string): string => `git checkout ${commitArg(rev)} -- ${shellQuote(file)}`,
  /**
   * Is the worktree's `file` byte-identical to its copy at `rev` (and does `rev` hold it at all)?
   * Answers `yes` or `no` on stdout: an untracked file never reads as the same as nothing.
   */
  sameAsRev: (rev: unknown, file: string): string =>
    `git cat-file -e ${shellQuote(`${commitArg(rev)}:${file}`)} && git diff --quiet ${commitArg(rev)} -- ${shellQuote(file)} && echo yes || echo no`,
  /** The best common ancestor of two commits. */
  mergeBase: (a: unknown, b: unknown): string => `git merge-base ${commitArg(a)} ${commitArg(b)}`,
  /** The paths that differ between two commits, one per line, renames read as a delete and an add. */
  changedBetween: (from: unknown, to: unknown): string =>
    `git diff --name-only --no-renames ${commitArg(from)} ${commitArg(to)} --`,
  /** The commit a merge in progress is merging; fails when no merge is pending. */
  mergeHead: "git rev-parse -q --verify MERGE_HEAD",
  /** Does the index hold `stage` of a conflicted path (1 base, 2 ours, 3 theirs)? Answers `yes` or `no`. */
  stageExists: (stage: 1 | 2 | 3, file: string): string =>
    `git cat-file -e ${shellQuote(`:${Number(stage)}:${file}`)} && echo yes || echo no`,
  /** Settle a conflicted path on the side being merged in. */
  takeTheirs: (file: string): string =>
    `git checkout --theirs -- ${shellQuote(file)} && git add -- ${shellQuote(file)}`,
  /** Settle a conflicted path the side being merged in deleted: deleted here too. */
  takeTheirDeletion: (file: string): string => `git rm -q -- ${shellQuote(file)}`,
  /** The paths staged against HEAD, one per line. */
  stagedNames: "git diff --cached --name-only --no-renames",
  /**
   * Of `files`, the ones on disk that still hold a conflict (a `<<<<<<<` line and a `>>>>>>>`
   * line), one per line. A link is never read through.
   */
  conflictMarked: (files: readonly string[]): string =>
    `for f in ${files.map(shellQuote).join(" ")}; do if [ -f "$f" ] && [ ! -L "$f" ] && grep -qE '^<{7}( |$)' -- "$f" && grep -qE '^>{7}( |$)' -- "$f"; then printf '%s\\n' "$f"; fi; done; true`,
  /** One stage of a conflicted path (`:1:<path>` base, `:2:` ours, `:3:` theirs). */
  show: (object: string): string => `git show ${shellQuote(object)}`,
  /** A three-way union merge of three files; the arguments are shell words the caller built. */
  mergeFileUnion: (ours: string, base: string, theirs: string): string =>
    `git merge-file -p --union ${ours} ${base} ${theirs}`,
  /** How a commit holds one path: a line starting `160000` is a nested repository's pointer. */
  lsTreePath: (rel: string): string => `git ls-tree HEAD -- ${shellQuote(rel)}`,
  /** Every path a commit holds as a nested repository's pointer (a gitlink), one per line. */
  gitlinks: (rev: unknown): string => `git ls-tree -r ${commitArg(rev)} | awk '$1 == "160000" { print $4 }'`,
  /** Stage everything under one folder (new, changed and removed files) and nothing outside it. */
  addFolder: (folder: string): string => `git add -A -- ${shellQuote(folder)}`,
  /**
   * Every entry a commit holds under `folder`, recursively, with its size, NUL-terminated:
   * `<mode> <type> <object> <size>\t<path>` (the size is `-` for what is not a blob).
   */
  treeEntries: (rev: unknown, folder: string): string =>
    `git ls-tree -r -l -z ${commitArg(rev)} -- ${shellQuote(folder)}`,
  /** These paths, as a commit holds them, checked out into the worktree and its index. */
  checkoutPaths: (rev: unknown, files: readonly string[]): string =>
    `git checkout ${commitArg(rev)} -- ${files.map(shellQuote).join(" ")}`,
});

/** Where a command runs: a worktree path, `{ cwd }`, or the live game folder `{ project }`. */
function where(at: Where): { cwd: string } | { project: string } {
  if (typeof at === "string") return { cwd: at };
  if (isRecord(at) && at.cwd) return { cwd: at.cwd };
  if (isRecord(at) && at.project) return { project: at.project };
  throw new Error("git: nowhere to run — pass a worktree path or { project }");
}

/**
 * What a failed command said, the way the harness has always reported it.
 */
export function shortFailure(exec: ExecAnswer, _command?: string): string {
  return String(exec?.stderr || exec?.stdout || "").slice(0, SHORT_FAILURE_CHARS);
}

/**
 * What a failed command said, whole.
 */
export function rawFailure(exec: ExecAnswer, _command?: string): string {
  return String(exec?.stderr || exec?.stdout || "");
}

/**
 * Run one git command and hand back what `run.exec` answered, whatever its exit code. An RPC
 * that throws still throws: that is the host failing, not git.
 */
export async function gitExec(
  ctx: HarnessCtx,
  at: Where,
  command: string,
  { label = null, timeoutMs = GIT_TIMEOUT_MS.quick }: ExecOptions = {},
): Promise<ExecResult> {
  return ctx.call(HostMethod.RunExec, { command, ...where(at), timeoutMs, ...(label ? { label } : {}) });
}

/**
 * Run one git command and answer its stdout; a non-zero exit throws. `trim: "end"` is the
 * default because porcelain status uses its leading column — removing that space truncates the
 * first path. `failure` words the error (default: the command's own output, clipped).
 */
export async function gitAt(
  ctx: HarnessCtx,
  at: Where,
  command: string,
  {
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.slow,
    trim = "end",
    failure = shortFailure,
  }: ExecOptions & { trim?: Trim; failure?: FailureWording } = {},
): Promise<string> {
  const exec = await gitExec(ctx, at, command, { label, timeoutMs });
  if (exec.code !== 0) throw new Error(failure(exec, command));
  return (TRIMS[trim] ?? TRIMS.end)(String(exec.stdout ?? ""));
}

/** The commit a worktree (or the live folder) stands on. */
export function headOf(
  ctx: HarnessCtx,
  at: Where,
  options: ExecOptions & { trim?: Trim; failure?: FailureWording } = {},
): Promise<string> {
  return gitAt(ctx, at, GIT.head, options);
}

/**
 * Is `commit` already on the branch `at` stands on? A command that fails answers no.
 */
export async function isAncestor(
  ctx: HarnessCtx,
  at: Where,
  commit: unknown,
  { label = null, timeoutMs = GIT_TIMEOUT_MS.quick }: ExecOptions = {},
): Promise<boolean> {
  try {
    const exec = await gitExec(ctx, at, GIT.isAncestor(commit), { label, timeoutMs });
    return exec?.code === 0 && String(exec.stdout ?? "").trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Stage everything and commit it under the studio's name: two commands, `git add -A` and then the
 * commit, so a failure says which. The message is quoted — a judge's reason or a worker's title
 * is model-written, and in double quotes a backtick in it still ran.
 */
export async function commitAll(
  ctx: HarnessCtx,
  at: Where,
  message: string,
  {
    allowEmpty = false,
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.slow,
    failure = shortFailure,
    trim = "end",
  }: ExecOptions & { allowEmpty?: boolean; failure?: FailureWording; trim?: Trim } = {},
): Promise<string> {
  const options = { label, timeoutMs, failure, trim };
  await gitAt(ctx, at, GIT.addAll, options);
  return gitAt(ctx, at, GIT.commit(message, { allowEmpty }), options);
}

/**
 * Point one of the studio's refs at `rev` (a hash or HEAD).
 */
export function updateRef(
  ctx: HarnessCtx,
  at: Where,
  ref: string,
  rev: unknown,
  {
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.ref,
    failure = shortFailure,
  }: ExecOptions & { failure?: FailureWording } = {},
): Promise<string> {
  return gitAt(ctx, at, GIT.updateRef(ref, rev), { label, timeoutMs, failure });
}

/**
 * Back to `rev` and nothing else on disk: `git reset --hard` then `git clean -fd`. Stops at the
 * first failure and throws, unless `bestEffort`, where each step is tried on its own and nothing
 * throws. `rev: null` skips the reset.
 */
export async function resetClean(
  ctx: HarnessCtx,
  at: Where,
  rev: string | null,
  {
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.slow,
    failure = shortFailure,
    bestEffort = false,
  }: ExecOptions & { failure?: FailureWording; bestEffort?: boolean } = {},
): Promise<void> {
  const options = { label, timeoutMs, failure };
  const steps = [
    ...(rev === null ? [] : [async () => gitAt(ctx, at, GIT.reset(rev), options)]),
    async () => gitAt(ctx, at, GIT.clean, options),
  ];
  for (const step of steps) {
    if (bestEffort) await step().catch(() => {});
    else await step();
  }
}

/**
 * The paths `rev` holds as nested repositories' pointers. A command that fails answers none.
 */
export async function gitlinks(
  ctx: HarnessCtx,
  at: Where,
  rev: unknown,
  { label = null, timeoutMs = GIT_TIMEOUT_MS.ref }: ExecOptions = {},
): Promise<string[]> {
  try {
    const exec = await gitExec(ctx, at, GIT.gitlinks(rev), { label, timeoutMs });
    return String(exec?.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Nested repositories a build does not carry. The user's own game may live in a folder that is a
 * git repository of its own; the studio versions it inside every fork when the user allowed that
 * (substrate/snapshots.ts `worktreeAt`), and this is the check that it happened. A path the
 * commit still holds as a pointer is a path whose every edit is invisible to the merge, the
 * landing and the user — a silent loss, said out loud. A plain `git status`
 * cannot see it: git does not walk into a gitlink path, which is why the loss was silent.
 *
 * `exec` runs git in the worktree being asked about; `nested` are the paths the game's history
 * holds as repositories of their own. Answers the ones this commit still holds as a pointer.
 */
export async function unversionedNested(
  exec: (command: string) => Promise<string>,
  nested: readonly string[] = [],
): Promise<string[]> {
  const lost: string[] = [];
  for (const rel of nested) {
    const listed = String((await exec(GIT.lsTreePath(rel)).catch(() => "")) ?? "").trim();
    if (listed.startsWith("160000")) lost.push(rel);
  }
  return lost;
}

/**
 * Merge `commit` into the branch `at` stands on (`--no-ff`, unless `fastForward`).
 *
 * On a failure `resolve` gets one try — the union merge of the FACET WIRING block, run by the
 * caller with its own exec — and when it cannot settle the merge the conflicted paths are read
 * (`listConflicts`) and the merge is ABORTED: a half-merged worktree is never left behind for the
 * next command to trip over.
 *
 * `rpcErrors: "fail"` reads a `run.exec` that threw — or a revision `commitArg` refused — as a
 * failed merge (the helpers that threw on a non-zero exit always did); the default lets it throw,
 * as a plain `run.exec` would. `failure` words `error` from the failed command (default: its whole
 * output); `cleanupLabel` labels the conflict listing and the abort.
 */
export async function mergeNoFf(
  ctx: HarnessCtx,
  at: Where,
  commit: unknown,
  {
    message,
    noEdit = false,
    fastForward = false,
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.slow,
    resolve = null,
    listConflicts = false,
    rpcErrors = "throw",
    failure = rawFailure,
    cleanupLabel = null,
  }: ExecOptions & {
    message?: string;
    noEdit?: boolean;
    fastForward?: boolean;
    resolve?: (() => any) | null;
    listConflicts?: boolean;
    rpcErrors?: "throw" | "fail";
    failure?: FailureWording;
    cleanupLabel?: string | null;
  } = {},
): Promise<MergeOutcome> {
  let exec: ExecResult;
  let error: string;
  try {
    const command = GIT.merge(commit, { message, noFf: !fastForward, noEdit });
    exec = await gitExec(ctx, at, command, { label, timeoutMs });
    if (exec.code === 0) return { ok: true, union: false };
    error = failure(exec, command);
  } catch (err: any) {
    if (rpcErrors !== "fail") throw err;
    error = String(err?.message ?? err);
  }
  let resolved: any = null;
  if (typeof resolve === "function") {
    resolved = await Promise.resolve()
      .then(resolve)
      .catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
    if (resolved?.ok) return { ok: true, union: true, resolved };
  }
  let conflicts: string[] = [];
  if (listConflicts) {
    const files = await gitExec(ctx, at, GIT.unmerged, { label: cleanupLabel }).catch(() => ({ stdout: "" }));
    conflicts = String(files?.stdout ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }
  await gitExec(ctx, at, GIT.mergeAbort, { label: cleanupLabel }).catch(() => {});
  return { ok: false, error, conflicts, resolved };
}

/**
 * Land a run's integrated build in the live game folder: one `--no-ff` merge, aborted on any
 * conflict. The live folder sat at the base for the whole run, so a conflict here is the user's own work;
 * nothing is ever forced over it (`git reset --hard` once was) — the build stays on its ref and
 * "Make it live" lands it once the folder is theirs to merge into.
 */
export function landIntegration(
  ctx: HarnessCtx,
  {
    project,
    head,
    message,
    label = null,
    timeoutMs = GIT_TIMEOUT_MS.slow,
  }: ExecOptions & { project: string; head: string; message: string },
): Promise<MergeOutcome> {
  return mergeNoFf(ctx, { project }, head, { message, label, timeoutMs });
}
