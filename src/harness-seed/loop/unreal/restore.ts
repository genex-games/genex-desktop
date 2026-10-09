/**
 * Restores and restarts of the user's Unreal editor for the Unreal lead, always between turns and
 * always cold: an in-place restore (`reset --hard` under a running editor) left stale packages in
 * the open editor, and a hot-reloaded library outlives a rollback. A restore is Genex's restore of
 * the game folder (`snapshot.restore`), around which the plugins that are on run their steps (the
 * Unreal plugin saves the editor's work unless it is gone, waiting while it is busy, ends it before
 * the files change, and reopens it after, building the game's C++ module first); a restart is the
 * same moments without the restore (`hooks.fire`). A step that blocks before (work that couldn't be
 * saved: Unreal stays open; Unreal that couldn't be closed) stops it, and nothing is restored. Then
 * the runner waits until Genex's health check is quiet. `sourceStamp` is what Unreal was last built
 * from.
 */
import {
  fireHooks,
  HookEvent,
  type HookHold,
  hookBlocked,
  holdOf,
  type ReadyOutcome,
  REOPEN_WAIT_MS,
  runScope,
  waitReady,
} from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { type Lead, oneGitWrite, why } from "./lead-journal.ts";

/**
 * The game's C++ source as one stamp: every file's checksum, size and path, sorted, then their own
 * checksum (POSIX `cksum`); a game without Source has the stamp of nothing.
 */
const SOURCE_STAMP_COMMAND = "{ find unreal/Source -type f -exec cksum {} + 2>/dev/null || true; } | sort | cksum";

const MESSAGE = {
  StampLabel: "unreal source stamp",
  NotRestored: (label: string, why: string) => `'${label}' couldn't be restored (${why})`,
  TimeUp: "the run's time ran out while Unreal reopened",
  NotReopened: (why: string) => `the Unreal plugin didn't reopen Unreal (${why})`,
  NoReason: "no reason given",
} as const;

/** Why a restore or restart failed: the work couldn't be saved (Unreal left open), Unreal didn't close, or the rest. */
export const RestoreFailure = {
  NotSaved: "not-saved",
  NotEnded: "not-ended",
  NotRestored: "not-restored",
  NotReopened: "not-reopened",
} as const;
export type RestoreFailure = (typeof RestoreFailure)[keyof typeof RestoreFailure];

/** Genex's own hold of a restore or restart (Plan mode, the person in Unreal, another holder), and the app's label. */
export type RestoreHeld = { hold: HookHold; label: string | null };

/** How a restore or restart ended: Unreal answers again on the restored folder, or why not (`held` when Genex held it). */
export type RestoreOutcome = { ok: true } | { ok: false; failure: RestoreFailure; why: string; held?: RestoreHeld };

/**
 * What an editor restart needs from the run: its host and game, its clock and last deadline, and
 * where it records what Unreal was built from. The lead is one.
 */
export type EditorRun = Pick<Lead, "ctx" | "run" | "threadId" | "clock" | "finalDeadline"> & {
  game?: Lead["game"];
  journal: { builtStamp: string | null };
};

const failed = (failure: RestoreFailure, reason: string, held?: RestoreHeld | null): RestoreOutcome => ({
  ok: false,
  failure,
  why: reason,
  ...(held ? { held } : {}),
});

/** What Unreal was last built from: the stamp of `unreal/Source`, or null when it can't be read. */
export async function sourceStamp(lead: EditorRun): Promise<string | null> {
  const { ctx, run } = lead;
  const command = SOURCE_STAMP_COMMAND;
  const answer = await ctx.call(HostMethod.RunExec, { command, project: run.project, label: MESSAGE.StampLabel });
  return answer?.code === 0 ? String(answer.stdout).trim() : null;
}

/** Genex's health check of the game now: quiet, pending, or blocked (the game's apps can't come back by themselves). */
function healthNow(lead: EditorRun) {
  return fireHooks(lead.ctx, lead.game, HookEvent.Health, runScope(lead));
}

/** Whether Genex's health check of the game is quiet now: nothing pending, nothing blocked. */
export async function editorAnswers(lead: EditorRun): Promise<boolean> {
  const health = await healthNow(lead);
  return !health.blocked && !health.pending;
}

/** Whether the game's Unreal is gone: Genex's health check is blocked (it won't come back by itself). */
export async function editorGone(lead: EditorRun): Promise<boolean> {
  return (await healthNow(lead)).blocked !== null;
}

/**
 * Kept for an older copy of a module that imports it: the plugin saves the editor's work before a
 * restore now (`restore.before`), so this answers that nothing was left unsaved here.
 */
export async function unsavedWork(_lead: EditorRun): Promise<string | null> {
  return null;
}

/**
 * Closes the game's apps for a restart: Genex's `restore.before` moment, with no file changed. A
 * step that blocks (work that couldn't be saved, an editor that couldn't be closed) leaves them as
 * they are.
 */
export async function closeEditor(lead: EditorRun): Promise<RestoreOutcome> {
  const closing = await fireHooks(lead.ctx, lead.game, HookEvent.RestoreBefore, runScope(lead));
  if (!closing.blocked) return { ok: true };
  return failed(RestoreFailure.NotSaved, closing.blocked.reason, holdOf(closing.blocked));
}

/** Restores the game folder to a kept snapshot, the plugins' restore steps around it. */
async function restoreSnapshot(lead: EditorRun, snapshot: { id: string; label: string }): Promise<RestoreOutcome> {
  const { ctx } = lead;
  const params = { ...runScope(lead), snapshotId: snapshot.id, reason: snapshot.label };
  try {
    const restored = await oneGitWrite(lead, () => ctx.call(HostMethod.SnapshotRestore, params));
    if (restored === true) return { ok: true };
    return failed(RestoreFailure.NotRestored, MESSAGE.NotRestored(snapshot.label, ""));
  } catch (err) {
    if (hookBlocked(err)) return failed(RestoreFailure.NotSaved, String(err.reason ?? err.message), holdOf(err));
    return failed(RestoreFailure.NotRestored, MESSAGE.NotRestored(snapshot.label, why(err)));
  }
}

/** A restart: the restore moments with no file changed; why it was stopped, or null. */
async function restart(lead: EditorRun): Promise<RestoreOutcome> {
  const closed = await closeEditor(lead);
  if (!closed.ok) return closed;
  await fireHooks(lead.ctx, lead.game, HookEvent.RestoreAfter, runScope(lead));
  return { ok: true };
}

/** Why waiting for Unreal to answer again failed, in the runner's words. */
function notReady(ready: Extract<ReadyOutcome, { ok: false }>, deadlineFirst: boolean): RestoreOutcome {
  if (ready.timedOut && deadlineFirst) return failed(RestoreFailure.NotReopened, MESSAGE.TimeUp);
  return failed(RestoreFailure.NotReopened, MESSAGE.NotReopened(ready.reason || MESSAGE.NoReason));
}

/** Waits until Genex's health check of the game is quiet (unless `wait` is off: a stop does not wait). */
async function reopened(lead: EditorRun, wait: boolean): Promise<RestoreOutcome> {
  if (!wait) return { ok: true };
  const timeout = lead.clock.now() + REOPEN_WAIT_MS;
  const until = Math.min(timeout, lead.finalDeadline);
  const ready = await waitReady(lead.ctx, lead.game, runScope(lead), lead.clock, until);
  // A run stopped while Unreal reopened goes on to its close, as a stop does.
  if (ready.ok || lead.ctx.cancelled) return { ok: true };
  return notReady(ready, until < timeout);
}

/**
 * The editor's cold restart: the folder restored to `snapshot` (Genex's restore, the plugins' steps
 * around it), or, with none, the restore moments alone; then Unreal waited for until it answers.
 * Nothing changes when a step before the restore blocks. Records what it was built from. Never
 * under a running turn: the caller runs it between turns.
 */
export async function coldRestore(
  lead: EditorRun,
  options: { snapshot: { id: string; label: string } | null; wait?: boolean },
): Promise<RestoreOutcome> {
  const restored = options.snapshot ? await restoreSnapshot(lead, options.snapshot) : await restart(lead);
  if (!restored.ok && restored.failure === RestoreFailure.NotSaved) return restored;
  const ready = await reopened(lead, options.wait !== false);
  lead.journal.builtStamp = await sourceStamp(lead).catch(() => null);
  return restored.ok ? ready : restored;
}
