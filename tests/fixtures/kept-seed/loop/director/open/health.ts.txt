/**
 * The open Loop's health watch: while the Loop runs (its lead resting or at work), Genex asks the
 * project's app whether it is well (`health`) every `HEALTH_POLL_MS`, only when a plugin of the
 * project hooks that moment. A step that is pending (an app busy, or reopening) is no crash; a block
 * is: Genex runs the project's crash steps (`crash`, which a plugin reopens its app at) and waits
 * until the app answers, at most `MAX_REOPENS` times. Back, the lead hears what may be lost. Still
 * gone, the folder goes back to the last save point (Genex's restore, the plugins' steps around it)
 * and the lead hears that. With no save point, or when that fails too, the app is the lead's to
 * bring back (`open.appDown`): it hears the app's own reason (a build error names its file and
 * line) and works on, its turn never cut, and Genex tries the crash steps again as each turn that
 * heard it ends (`reopenAfterTurn`, beside the wake loop as a recovery), at most `MAX_HANDOFFS`
 * times between the lead's save points; then the Loop pauses for the person, in plain words, and
 * their Resume starts over (a Resume whose app doesn't open is the lead's again, `appDownAtStart`). A crash step Genex itself held back (Plan mode, the person in the app) reopened nothing: the
 * Loop pauses in Genex's words, never as an app that failed to reopen, and nothing goes back. The
 * lead hears of the crash at once.
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
import {
  HEALTH_POLL_MS,
  MAX_HANDOFFS,
  MAX_REOPENS,
  OPEN_CLOSE_MS,
  type OpenLoop,
  type OpenReopenAt,
  type OpenSavePoint,
} from "./contract.ts";
import { appLostWords, backHeldWords, crashHeldWords } from "../held-words.ts";
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
  Boolean(loopRun.open.betweenTurns);

/** How long the Loop's teardown waits for a recovery under way to stop, before its run ends anyway. */
const RECOVERY_SETTLE_MS = OPEN_CLOSE_MS / 2;

/** Whether the Loop began to close, or closed: a recovery under way stops at its next step, and says nothing. */
const closing = (loopRun: LoopRun): boolean => closeUnderWay(loopRun.state) || loopRun.state.finished;

/** Waits until the project's app answers again; why it didn't, or null once it does (or the run was stopped). */
async function answersAgain(loopRun: LoopRun, open: OpenLoop): Promise<Failed | null> {
  const until = open.clock.now() + REOPEN_WAIT_MS;
  const stopped = () => closing(loopRun);
  const ready = await waitReady(loopRun.ctx, loopRun.game, runScope(loopRun), open.clock, until, stopped);
  if (ready.ok || loopRun.ctx.cancelled || closing(loopRun)) return null;
  return { why: ready.timedOut ? MESSAGE.timedOut(minutes(REOPEN_WAIT_MS)) : ready.reason };
}

/**
 * The project's steps that bring its app back once (its crash steps, or as a held start's are, its
 * start's: `open.reopenAt`), then the wait; why the app isn't back, or null once it is.
 */
async function reopenOnce(
  loopRun: LoopRun,
  open: OpenLoop,
  on: OpenReopenAt = HookEvent.Crash,
): Promise<Failed | null> {
  const steps = await fireHooks(loopRun.ctx, loopRun.game, on, runScope(loopRun));
  // Held back by Genex: nothing reopened the app, so there is nothing to wait for.
  if (steps.blocked && holdOf(steps.blocked)) return { why: steps.blocked.reason, ...steps.blocked };
  if (steps.blocked) return { why: steps.blocked.reason };
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
  // A close under way decides how the Loop ends: a recovery that ends after it pauses nothing; a
  // pause already made (the lead's own, for the person) keeps its words; and the run's wrap-up is its
  // last turn, never cut, its close (the person's Finish, a failed turn's) keeping the folder as it is.
  if (closing(loopRun) || open.halted || loopRun.wrapping) return;
  open.halted = words;
  await loopRun.saveJournal().catch(() => {});
  if (open.inTurn) await abortLead(loopRun);
}

/**
 * Ends the lead's session under way in the folder, addressed to the session the host seated as this
 * run's lead in place: a call the host has not seated yet is missed, so the turn's watch says it
 * again while the Loop stays paused (`../news.ts`).
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

/**
 * The app answers again: whatever Genex handed the lead is over. The count of handoffs goes on until
 * the lead keeps a save point (`savePointTool`), so an app that answers only to stop again still
 * pauses for the person.
 */
function appIsBack(open: OpenLoop): void {
  open.appDown = null;
  open.reopenAt = HookEvent.Crash;
  open.journal.appLost = false;
}

/**
 * Genex couldn't bring the app back: it stays closed for the lead (`open.appDown`), which hears why at
 * once, working or resting, and Genex tries again as its turn ends (`reopenAfterTurn`). Past
 * `MAX_HANDOFFS` since the lead's last save point the Loop pauses for the person instead, in plain words.
 */
async function handToLead(loopRun: LoopRun, open: OpenLoop, why: string): Promise<void> {
  if (closing(loopRun)) return;
  // Kept on the journal: a Resume while the app still doesn't open is the lead's again (`appDownAtStart`).
  open.journal.appLost = true;
  if (open.handoffs >= MAX_HANDOFFS) return halt(loopRun, open, appLostWords());
  open.handoffs += 1;
  open.appDown = why;
  loopRun.note(OPEN_NEWS.appDown(why, MAX_HANDOFFS - open.handoffs + 1), NoteKind.AppCrashed);
  // Genex tries again only after a turn that heard this line: one that didn't had no chance at it.
  open.appDownSeq = loopRun.logSeq;
  await loopRun.saveJournal().catch(() => {});
}

/** Whether the lead has heard that the app stays closed for it: a turn that took that line, or a message that carried it. */
export const heardAppDown = (loopRun: LoopRun, open: OpenLoop): boolean => loopRun.waitSeq >= open.appDownSeq;

/**
 * Genex's try for the lead, on the folder as it left it (it may have fixed what stopped the app). A
 * look first: an app that answers, or is only busy (loading, compiling, a dialog), is waited for and
 * never reopened under it, which would end it with its work. Else the steps that bring it back run
 * once more; a held start's steps run even once it answers. Back, the lead hears it; held back by
 * Genex, the Loop pauses in Genex's words; still closed, the lead has it again (`handToLead`).
 */
async function reopenForLead(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const look = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Health, runScope(loopRun));
  // A look no step answered (the host failed to ask) says nothing of the app: the steps run.
  const answers = !look.blocked && look.ran.length > 0;
  let failed = answers ? await answersAgain(loopRun, open) : await reopenOnce(loopRun, open, open.reopenAt);
  // A held start's steps set more up than the app: they run once it answers, as at any start.
  const startSteps = answers && !failed && open.reopenAt === HookEvent.RunPrepare && !givesUp(loopRun);
  if (startSteps) failed = await reopenOnce(loopRun, open, HookEvent.RunPrepare);
  if (givesUp(loopRun)) return;
  if (!failed) {
    appIsBack(open);
    return told(loopRun, answers ? OPEN_NEWS.appAnswers : OPEN_NEWS.appReopened);
  }
  const held = crashHeldWords(failed);
  await (held ? halt(loopRun, open, held) : handToLead(loopRun, open, failed.why));
}

/** A try that threw: the app is still the lead's, with what went wrong, so its outcome still wakes the lead. */
async function tryFailed(loopRun: LoopRun, open: OpenLoop, err: unknown): Promise<void> {
  if (givesUp(loopRun)) return;
  await handToLead(loopRun, open, err instanceof Error ? err.message : String(err));
}

/**
 * Starts Genex's try at the end of a lead's turn that heard the app stays closed for it
 * (`reopenForLead`), beside the wake loop as a recovery runs (`open.recovering`): the person's words
 * still wake the lead meanwhile, a lone lead rests until it is over, and its outcome wakes it.
 */
export function reopenAfterTurn(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  if (open.recovering) return open.recovering;
  const running = reopenForLead(loopRun, open)
    .catch((err: unknown) => tryFailed(loopRun, open, err))
    .catch(() => {})
    .finally(() => {
      if (open.recovering === running) open.recovering = null;
    });
  open.recovering = running;
  return running;
}

/**
 * What came of the lead's rewind while the app is closed: Genex's own hold on its restore, whether the
 * restore happened, and why the app doesn't answer after it (a restore that failed included), or null.
 */
export type Rewound = { held: HookHeldBy | null; restored: boolean; notBack: string | null };

/**
 * What a rewind at the end of a lead's turn left of the stopped app: back, the lead has it no more;
 * a restore Genex itself held back pauses the Loop in Genex's words, as a recovery's way back does;
 * still closed, Genex's try runs on the folder as the rewind left it, as after any turn (a project's
 * steps after a restore reopen only an app they closed for it, so they can't stand for that try).
 */
export async function afterRewindWhileDown(loopRun: LoopRun, open: OpenLoop, rewound: Rewound): Promise<void> {
  if (givesUp(loopRun)) return;
  const heldWords = rewound.held ? backHeldWords(rewound.held) : null;
  if (heldWords) return halt(loopRun, open, heldWords);
  // A held start's steps set more up than the app: Genex's try runs them even once it answers.
  const back = rewound.restored && rewound.notBack === null && open.reopenAt === HookEvent.Crash;
  if (back) {
    appIsBack(open);
    return told(loopRun, OPEN_NEWS.appAnswers);
  }
  void reopenAfterTurn(loopRun, open);
}

/**
 * A Loop paused while its app was the lead's to bring back (after the lead's tries ran out, or a Stop
 * or the lead's own pause meanwhile), resumed while a plugin's step still can't open it (a build that
 * still fails): the lead's to bring back again, so the person's Resume is the agent's next try and
 * never the plugin's own error. Genex's tries run the start's steps.
 */
export function appDownAtStart(loopRun: LoopRun, why: string): Promise<void> {
  // Its start's steps (which open the app and set the rest of the start up) are the ones to try again.
  loopRun.open.reopenAt = HookEvent.RunPrepare;
  return handToLead(loopRun, loopRun.open, why);
}

/** A resumed Loop whose app was the lead's to bring back opened it as it prepared: the lead hears it is back. */
export function appUpAtStart(loopRun: LoopRun): void {
  if (!loopRun.open.journal.appLost) return;
  appIsBack(loopRun.open);
  loopRun.note(OPEN_NEWS.appAnswers, NoteKind.Folder);
}

/** The crash handled, start to end (the module's header). */
async function recover(loopRun: LoopRun, open: OpenLoop, reason: string): Promise<void> {
  // The way back is chosen among the save points there were when the crash was seen.
  const known = open.journal.savePoints.length;
  // Kept until it is back: a Stop or Genex's own hold meanwhile leaves a Resume that can't open it the lead's.
  open.journal.appLost = true;
  // A working lead hears it at once; a resting one is woken by the recovery's outcome, not this.
  loopRun.note(OPEN_NEWS.appStopping, NoteKind.AppStopping);
  const failed = await reopenInPlace(loopRun, open);
  // A Stop or a close during the crash steps or their wait: nothing is known to be back, and nothing is said.
  if (loopRun.ctx.cancelled || closing(loopRun)) return;
  open.journal.crashes += 1;
  const last = open.journal.savePoints[known - 1] ?? null;
  if (!failed) {
    appIsBack(open);
    return told(loopRun, OPEN_NEWS.appBack(last?.label ?? null));
  }
  // Genex held the crash steps back: nothing tried a reopen, so no work is given up for a way back.
  const held = crashHeldWords(failed);
  if (held) return halt(loopRun, open, held);
  // No way back: the lead's own last work stopped the app, most likely, and it is the one to fix it.
  if (!last) return handToLead(loopRun, open, failed.why || reason);
  // A Loop that began to close meanwhile keeps its folder as it is: its close keeps what is there.
  if (closing(loopRun)) return;
  // A writer in place would go on editing files the restore replaces: it stops first, and says why.
  const stopped = await stopWritersInPlace(open, OPEN_NEWS.writerStoppedWhy);
  // Its stop may take a while: a close or a Stop meanwhile leaves the folder as it is.
  if (givesUp(loopRun)) return;
  const back = await backTo(loopRun, open, last, stopped);
  // A Stop or a close took nothing back (or cut the wait): the journal still says the app is closed.
  if (givesUp(loopRun)) return;
  // Back at the save point, the app answering: the journal no longer says it is closed.
  if (!back) return appIsBack(open);
  // Back, though the app still doesn't answer: Genex's own hold pauses the Loop; anything else is the lead's to fix.
  const backHeld = backHeldWords(back);
  await (backHeld ? halt(loopRun, open, backHeld) : handToLead(loopRun, open, back.why));
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
  const under = [open.healthLook, open.recovering].filter((one): one is Promise<void> => Boolean(one));
  if (!under.length) return;
  await Promise.race([Promise.all(under), open.clock.sleep(RECOVERY_SETTLE_MS)]);
}

/**
 * The look itself: a block starts the recovery, which runs on while the look ends, unless the app is
 * the lead's to bring back (`open.appDown`); a clean answer then means the lead or the person brought
 * it back, which the lead hears with its next message.
 */
async function lookAtApp(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const health = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Health, runScope(loopRun));
  if (over(loopRun)) return;
  if (!health.blocked) {
    // Only an answer a step gave says the app is back: a look the host failed to ask says nothing,
    // and a held start's steps (more than the app) pass only at Genex's try as the turn ends.
    const back = Boolean(open.appDown) && !health.pending && health.ran.length > 0;
    if (!back || open.reopenAt === HookEvent.RunPrepare) return;
    appIsBack(open);
    loopRun.note(OPEN_NEWS.appAnswers, NoteKind.Folder);
    return;
  }
  if (!open.appDown) void recoverApp(loopRun, open, health.blocked.reason);
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
