/**
 * The open Loop's health watch: while the Loop runs (its lead resting or at work), Genex asks the
 * project's app whether it is well (`health`) every `HEALTH_POLL_MS`, only when a plugin of the
 * project hooks that moment. A step that is pending (an app busy, or reopening) is no crash; a block
 * is: Genex runs the project's crash steps (`crash`, which a plugin reopens its app at) and waits
 * until the app answers, at most `MAX_REOPENS` times. Back, the lead hears what may be lost. Still
 * gone, the folder goes back to the last save point (Genex's restore, the plugins' steps around it)
 * and the lead hears that. With no save point, or when that fails too, the Loop pauses with the
 * reason: its lead's turn under way is ended, and the person resumes it. A crash step Genex itself
 * held back (Plan mode, the person in the app) reopened nothing: the Loop pauses in Genex's words,
 * never as an app that failed to reopen, and nothing goes back. The lead hears of the crash at once.
 * A recovery runs beside the wake loop, never inside its reads: the person's words, a finish request
 * and the workers' ends still wake the lead while it runs (`open.recovering`, which the between-turns
 * work waits for; a save point and a finish are refused meanwhile). Only the way back holds the game
 * folder's git-write queue. No recovery starts once the Loop closes or its lead's finish is checked,
 * and one under way stops at its next step once the Loop begins to close (its waits for the app ask
 * no more once it does): it reopens nothing more, says nothing and keeps no journal over the close
 * (whose teardown waits for it a while, `settleRecovery`). A look at the app runs beside the wake
 * loop too, one at a time: a slow `health` step never holds up the reads of the person's words.
 */
import {
  fireHooks,
  HookEvent,
  hookBlocked,
  holdOf,
  hooksOn,
  REOPEN_WAIT_MS,
  runScope,
  waitReady,
} from "../../hooks.ts";
import type { HookHeldBy } from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import { minutes } from "../../time.ts";
import type { LoopRun } from "../loop-run.ts";
import { closeUnderWay, finishUnderWay } from "../close-latch.ts";
import { NoteKind } from "../wake-schedule.ts";
import { HEALTH_POLL_MS, MAX_REOPENS, OPEN_CLOSE_MS, type OpenLoop, type OpenSavePoint } from "./contract.ts";
import { appLostWords, backHeldWords, crashHeldWords } from "./hold-words.ts";
import { OPEN_NEWS } from "./prompts.ts";
import { stopWritersInPlace } from "./writers.ts";

/** Why a reopen or a way back failed, and Genex's own hold when it was Genex's. */
type Failed = { why: string } & HookHeldBy;

const MESSAGE = {
  timedOut: (minutes: number) => `it didn't answer within ${minutes} minutes`,
  notRestored: (label: string, why: string) => `save point "${label}" couldn't be restored (${why})`,
} as const;

/**
 * Whether the run is closing or closed, stopped, refused, its lead's finish is checked, or Genex's work
 * between its lead's turns is under way: no look starts a recovery then.
 */
const over = (loopRun: LoopRun): boolean =>
  loopRun.state.finished ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  finishUnderWay(loopRun.state) ||
  loopRun.ctx.cancelled === true ||
  Boolean(loopRun.open?.refused || loopRun.open?.betweenTurns);

/** How long the Loop's teardown waits for a recovery under way to stop, before its run ends anyway. */
const RECOVERY_SETTLE_MS = OPEN_CLOSE_MS / 2;

/** Whether the Loop began to close, or closed: a recovery under way stops at its next step, and says nothing. */
const closing = (loopRun: LoopRun): boolean => closeUnderWay(loopRun.state) || loopRun.state.finished;

/** Until when a reopened app may take to answer: `REOPEN_WAIT_MS` from now, within the run. */
const reopenUntil = (loopRun: LoopRun, open: OpenLoop): number =>
  Math.min(open.clock.now() + REOPEN_WAIT_MS, loopRun.finalDeadline);

/** Waits until the project's app answers again; why it didn't, or null once it does (or the run was stopped). */
async function answersAgain(loopRun: LoopRun, open: OpenLoop): Promise<Failed | null> {
  const until = reopenUntil(loopRun, open);
  const stopped = () => closing(loopRun);
  const ready = await waitReady(loopRun.ctx, loopRun.game, runScope(loopRun), open.clock, until, stopped);
  if (ready.ok || loopRun.ctx.cancelled || closing(loopRun)) return null;
  return { why: ready.timedOut ? MESSAGE.timedOut(minutes(REOPEN_WAIT_MS)) : ready.reason };
}

/** The project's crash steps once, then the wait; why the app isn't back, or null once it is. */
async function reopenOnce(loopRun: LoopRun, open: OpenLoop): Promise<Failed | null> {
  const crash = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Crash, runScope(loopRun));
  // Held back by Genex: nothing reopened the app, so there is nothing to wait for.
  if (crash.blocked && holdOf(crash.blocked)) return { why: crash.blocked.reason, ...crash.blocked };
  if (crash.blocked) return { why: crash.blocked.reason };
  // A Loop that began to close meanwhile waits for nothing more.
  return closing(loopRun) ? null : answersAgain(loopRun, open);
}

/** The crash steps at most `MAX_REOPENS` times; the last failure, or null once the app answers. */
async function reopenInPlace(loopRun: LoopRun, open: OpenLoop): Promise<Failed | null> {
  let last: Failed | null = null;
  for (let tries = 0; tries < MAX_REOPENS && !loopRun.ctx.cancelled && !closing(loopRun); tries += 1) {
    last = await reopenOnce(loopRun, open);
    // Asked again at once, a hold is held back alike.
    if (!last || holdOf(last)) return last;
  }
  return last;
}

/** Whether a recovery goes no further: the Loop began to close (or closed), or the person pressed Stop. */
const givesUp = (loopRun: LoopRun): boolean => closing(loopRun) || loopRun.ctx.cancelled === true;

/**
 * The folder back to a save point (Genex's restore, the plugins' steps around it, on the game
 * folder's git-write queue), told to the lead as soon as it lands, then the wait; why not, or null.
 * The restore is decided on the queue itself: one whose turn comes once the Loop began to close, or
 * after a Stop, takes nothing back (null), so a close that passed the queue never sees the folder go
 * back after it. `stopped`: the writers in place Genex stopped first.
 */
async function backTo(
  loopRun: LoopRun,
  open: OpenLoop,
  point: OpenSavePoint,
  stopped: readonly string[],
): Promise<Failed | null> {
  const params = { ...runScope(loopRun), snapshotId: point.snapshotId, reason: point.label };
  try {
    // Counted on the queue itself: a close waiting behind it there reads that the folder went back.
    const restored = await open.gitWrite(async () => {
      if (givesUp(loopRun)) return false;
      await loopRun.ctx.call(HostMethod.SnapshotRestore, params);
      open.restores += 1;
      open.wentBack = point.label;
      open.wentBackSeq = null;
      return true;
    });
    if (!restored) return null;
  } catch (err) {
    if (hookBlocked(err)) return { why: String(err.reason ?? err.message), hold: err.hold, label: err.label };
    return { why: MESSAGE.notRestored(point.label, err instanceof Error ? err.message : String(err)) };
  }
  // A working lead hears it before the wait for the app: its edits from now on land on the save point's files.
  await told(loopRun, wentBackLine(point.label, stopped), true);
  return hooksOn(loopRun.game, HookEvent.Health) ? answersAgain(loopRun, open) : null;
}

/**
 * The Loop pauses with the person's words, and the journal keeps the reason. A lead session under
 * way is ended, addressed to the session the host seated as this run's lead in place (`lead`):
 * between its sessions, or while its call waits for the folder another chat's turn holds, there is
 * none, and that other turn is never cut.
 */
async function halt(loopRun: LoopRun, open: OpenLoop, words: string): Promise<void> {
  // A close under way decides how the Loop ends: a recovery that ends after it pauses nothing.
  if (closing(loopRun)) return;
  open.halted = words;
  await loopRun.saveJournal().catch(() => {});
  if (open.inTurn) await abortLead(loopRun);
}

/**
 * Ends the lead's session under way in the folder, addressed to the session the host seated as this
 * run's lead in place: a call the host has not seated yet is missed, so the turn's watch says it
 * again while the Loop stays paused (`news.ts`).
 */
export async function abortLead(loopRun: LoopRun): Promise<void> {
  const lead = { cwd: loopRun.projectDir, lead: loopRun.run.runId };
  await loopRun.ctx.call(HostMethod.EngineAbort, lead).catch(() => {});
}

/**
 * The lead's news of a recovery that worked, kept with the crash count; nothing once the Loop closes.
 * The line that tells a way back is kept (`wentBackSeq`): until the lead hears it, a close says it.
 */
async function told(loopRun: LoopRun, line: string, wentBack = false): Promise<void> {
  if (closing(loopRun)) return;
  loopRun.note(line, NoteKind.AppCrashed);
  if (wentBack && loopRun.open) loopRun.open.wentBackSeq = loopRun.logSeq;
  await loopRun.saveJournal().catch(() => {});
}

/** What the lead hears of a way back: the save point, and the writers in place Genex stopped first. */
const wentBackLine = (label: string, stopped: readonly string[]): string =>
  [OPEN_NEWS.wentBack(label), stopped.length ? OPEN_NEWS.writersStopped(stopped) : ""].filter(Boolean).join(" ");

/** The crash handled, start to end (the module's header). */
async function recover(loopRun: LoopRun, open: OpenLoop, reason: string): Promise<void> {
  // The way back is chosen among the save points there were when the crash was seen.
  const known = open.journal.savePoints.length;
  // A working lead hears it at once; a resting one is woken by the recovery's outcome, not this.
  loopRun.note(OPEN_NEWS.appStopping, NoteKind.AppStopping);
  const failed = await reopenInPlace(loopRun, open);
  // A Stop or a close during the crash steps or their wait: nothing is known to be back, and nothing is said.
  if (loopRun.ctx.cancelled || closing(loopRun)) return;
  open.journal.crashes += 1;
  const last = open.journal.savePoints[known - 1] ?? null;
  if (!failed) return told(loopRun, OPEN_NEWS.appBack(last?.label ?? null));
  // Genex held the crash steps back: nothing tried a reopen, so no work is given up for a way back.
  const held = crashHeldWords(failed);
  if (held) return halt(loopRun, open, held);
  if (!last) return halt(loopRun, open, appLostWords(failed.why || reason));
  // A Loop that began to close meanwhile keeps its folder as it is: its close keeps what is there.
  if (closing(loopRun)) return;
  // A writer in place would go on editing files the restore replaces: it stops first, and says why.
  const stopped = await stopWritersInPlace(open, OPEN_NEWS.writerStoppedWhy);
  // Its stop may take a while: a close or a Stop meanwhile leaves the folder as it is.
  if (givesUp(loopRun)) return;
  const restoresBefore = open.restores;
  const back = await backTo(loopRun, open, last, stopped);
  if (loopRun.ctx.cancelled || !back) return;
  // Back, though the app still doesn't answer: the Resume's first message tells the lead the folder went back.
  if (open.restores > restoresBefore && !closing(loopRun)) open.journal.carried.push(wentBackLine(last.label, stopped));
  await halt(loopRun, open, backHeldWords(back) ?? appLostWords(back.why));
}

/**
 * Starts the recovery of the project's app that stopped (the module's header), once at a time: one
 * already under way is the one kept. Never awaited by the watch: `open.recovering` is what waits.
 */
export function recoverApp(loopRun: LoopRun, open: OpenLoop, reason: string): Promise<void> {
  if (open.recovering) return open.recovering;
  open.recoveries += 1;
  const running = recover(loopRun, open, reason)
    .catch(() => {})
    .finally(() => {
      if (open.recovering === running) open.recovering = null;
    });
  open.recovering = running;
  return running;
}

/**
 * The teardown's wait for a look at the app and a recovery under way (which stop at their next step
 * once the Loop closes), at most `RECOVERY_SETTLE_MS` on the Loop's clock: the run's end never comes
 * while Genex still asks or reopens the app, as far as it can help it.
 */
export async function settleRecovery(loopRun: LoopRun): Promise<void> {
  const open = loopRun.open;
  const under = [open?.healthLook, open?.recovering].filter((one): one is Promise<void> => Boolean(one));
  if (!open || !under.length) return;
  await Promise.race([Promise.all(under), open.clock.sleep(RECOVERY_SETTLE_MS)]);
}

/** The look itself: a block starts the recovery, which runs on while the look ends. */
async function lookAtApp(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const health = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Health, runScope(loopRun));
  if (!health.blocked || over(loopRun)) return;
  void recoverApp(loopRun, open, health.blocked.reason);
}

/**
 * One look at the project's app, when it is due (every `HEALTH_POLL_MS`, only when a plugin hooks
 * `health`, never while a look or a recovery runs or the Loop closes), started beside the caller and
 * never awaited by it (`open.healthLook`).
 */
export function healthWatch(loopRun: LoopRun): void {
  const open = loopRun.open;
  if (!open || open.halted || open.recovering || open.healthLook || over(loopRun)) return;
  if (!hooksOn(loopRun.game, HookEvent.Health)) return;
  const now = open.clock.now();
  if (now - open.healthAt < HEALTH_POLL_MS) return;
  open.healthAt = now;
  const look = lookAtApp(loopRun, open)
    .catch(() => {})
    .finally(() => {
      if (open.healthLook === look) open.healthLook = null;
    });
  open.healthLook = look;
}
