/**
 * What waits for the end of an open Loop's turn before the next (`LoopRun.afterTurn`, which the wake
 * loop awaits): a look at the project's app the turn started settles first; then, when the turn kept
 * no save point, Genex keeps what it left (always when the folder changed; only what is unsaved where
 * a plugin saves the project's app; nothing otherwise, nor while a worker writes in the folder in
 * place), with what the plugins' steps said of it; then the rewind the lead asked for (Genex's
 * restore of the save point, the plugins' steps around it, then a wait until the app answers) and the
 * restart (the project's restore moments with no file changed, then the wait), both waiting while a
 * worker writes in place. Nothing here reopens the app or takes the folder back unless the lead asked
 * for it. No judge plays between turns: one is the lead's to ask for (`judge_play`). Each outcome is
 * one line of the run's log the lead is told with its next message (`NoteKind.Folder`); what came of
 * a rewind or a restart the lead asked for is one that wakes it (`NoteKind.AskDone`), as a worker's
 * end does, with what the plugins' steps said around it.
 * Never under a running turn, never after the Loop closed, and no look at the app starts meanwhile.
 */
import {
  CheckpointSkip,
  fireHooks,
  HookEvent,
  hookBlocked,
  hooksOn,
  notesText,
  REOPEN_WAIT_MS,
  runScope,
  waitReady,
} from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import { momentLines } from "../../moment-lines.ts";
import type { LoopRun } from "../loop-run.ts";
import { closeUnderWay } from "../close-latch.ts";
import { NoteKind } from "../wake-schedule.ts";
import { sawAfterAsk } from "./app-look.ts";
import { folderChanged } from "./close.ts";
import { asksPending, type OpenLoop, type OpenRewind } from "./contract.ts";
import { heldForLead } from "../held-words.ts";
import { OPEN_NEWS } from "./prompts.ts";
import { checkpointNow, queued, recordSavePoint } from "./save-point.ts";
import { writersInPlace } from "./writers.ts";

const MESSAGE = {
  autosave: "Autosave",
  autosaveSummary: "Saved by Genex: the lead's turn ended with unsaved work.",
  notRestored: (why: string) => `the restore failed (${why})`,
} as const;

/** Whether the Loop is closing or closed, stopped, or paused: nothing runs between turns then. */
const over = (loopRun: LoopRun, open: OpenLoop): boolean =>
  loopRun.state.finished ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  loopRun.ctx.cancelled === true ||
  Boolean(open.halted);

/** A line the lead is told with its next message: it wakes nobody. */
const carry = (loopRun: LoopRun, line: string): void => loopRun.note(line, NoteKind.Folder);

/** What came of a rewind or a restart the lead asked for: a line that wakes it. */
const tellDone = (loopRun: LoopRun, line: string): void => loopRun.note(line, NoteKind.AskDone);

/** One line of the run's log: Genex's words, then what the plugins' steps said. */
const withLines = (line: string, lines: readonly string[]): string => [line, ...lines].join(" ");

/**
 * The turn's unsaved work, kept as an autosave: always when the folder changed (or git couldn't
 * say), only what is unsaved where a plugin saves the project's app, and nothing otherwise. A kept
 * one is said with what the plugins' steps said of it; one Genex held back or that failed is said
 * too; one that found nothing unsaved is not.
 */
async function autosave(loopRun: LoopRun): Promise<void> {
  const changed = await folderChanged(loopRun);
  const appSaved =
    hooksOn(loopRun.game, HookEvent.CheckpointBefore) || hooksOn(loopRun.game, HookEvent.CheckpointAfter);
  if (changed === false && !appSaved) return;
  const taken = await checkpointNow(loopRun, MESSAGE.autosave, changed === false);
  if ("snapshot" in taken) {
    const ask = { label: MESSAGE.autosave, summary: MESSAGE.autosaveSummary, auto: true };
    const point = await recordSavePoint(loopRun, ask, taken);
    carry(loopRun, withLines(OPEN_NEWS.autosaved(point.label), point.notes));
    return;
  }
  if ("skipped" in taken && taken.skipped === CheckpointSkip.NothingUnsaved) return;
  const why =
    "blocked" in taken ? heldForLead({ reason: taken.blocked, hold: taken.hold, label: taken.label }) : taken.reason;
  carry(loopRun, OPEN_NEWS.notAutosaved(why));
}

/** The autosave, unless a worker writes in the folder in place: it would keep that worker's half-done files. */
async function autosaveUnlessWriting(loopRun: LoopRun, writers: readonly string[]): Promise<void> {
  if (!writers.length) return autosave(loopRun);
  if ((await folderChanged(loopRun)) !== false) carry(loopRun, OPEN_NEWS.notAutosavedWriter(writers));
}

/**
 * Waits until the project's app answers again, when a plugin says whether it does; why not, or null.
 * What the wait saw is where the watch goes on from (`sawAfterAsk`): the lead hears it with its ask's line.
 */
async function answered(loopRun: LoopRun, open: OpenLoop): Promise<string | null> {
  if (!hooksOn(loopRun.game, HookEvent.Health)) return null;
  const until = open.clock.now() + REOPEN_WAIT_MS;
  const stopped = () => over(loopRun, open);
  const ready = await waitReady(loopRun.ctx, loopRun.game, runScope(loopRun), open.clock, until, stopped);
  if (loopRun.ctx.cancelled || stopped()) return null;
  sawAfterAsk(open, ready);
  return ready.ok ? null : ready.reason;
}

/** Genex's restore of a snapshot, after every git write before it; why it didn't happen (Genex's own hold worded for the lead), or null. */
async function restoreSnapshot(loopRun: LoopRun, snapshotId: string, reason: string): Promise<string | null> {
  const params = { ...runScope(loopRun), snapshotId, reason };
  try {
    await queued(loopRun, () => loopRun.ctx.call(HostMethod.SnapshotRestore, params));
    return null;
  } catch (err) {
    if (!hookBlocked(err)) return MESSAGE.notRestored(errorText(err));
    return heldForLead({ reason: String(err.reason ?? err.message), hold: err.hold, label: err.label });
  }
}

/** An error's message, or what it is. */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The lead's rewind: back to the save point it named (the snapshot its label named when it asked),
 * then the app waited for. A restore refused (a plugin's step, Genex's own hold) or failed is the
 * lead's answer: nothing went back, and the Loop goes on.
 */
async function rewind(loopRun: LoopRun, open: OpenLoop, { label, snapshotId }: OpenRewind): Promise<void> {
  open.journal.between.rewind = null;
  const failed = await restoreSnapshot(loopRun, snapshotId, label);
  if (failed) {
    tellDone(loopRun, OPEN_NEWS.noRewind(label, failed));
    return;
  }
  const notBack = await answered(loopRun, open);
  tellDone(loopRun, OPEN_NEWS.rewound(label));
  if (notBack) tellDone(loopRun, OPEN_NEWS.notAnswering(notBack));
}

/**
 * The project's restore moments with no file changed, on the git-write queue: what the steps said
 * after it, or null when a block before (a step's, Genex's own hold) left the app as it is, which the
 * lead is told. A hold at the moment after the restart is only a note.
 */
async function restartSteps(loopRun: LoopRun): Promise<string[] | null> {
  const scope = runScope(loopRun);
  const closing = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.RestoreBefore, scope);
  if (closing.blocked) {
    tellDone(loopRun, OPEN_NEWS.noRestart(heldForLead(closing.blocked)));
    return null;
  }
  const reopening = await momentLines(loopRun.ctx, loopRun.game, HookEvent.RestoreAfter, scope);
  return [...notesText(closing), ...reopening];
}

/** The lead's restart: its steps (`restartSteps`), then the app waited for outside the git-write queue. */
async function restart(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  open.journal.between.restart = false;
  const lines = await queued(loopRun, () => restartSteps(loopRun));
  if (!lines) return;
  const notBack = await answered(loopRun, open);
  tellDone(loopRun, withLines(OPEN_NEWS.restarted, lines));
  if (notBack) tellDone(loopRun, OPEN_NEWS.notAnswering(notBack));
}

/**
 * The rewind and the restart the lead asked for; both wait while a worker writes in the folder in
 * place, whose edits would land on the files the rewind put back.
 */
async function asksAtTurnEnd(loopRun: LoopRun, open: OpenLoop, writers: readonly string[]): Promise<void> {
  const { between } = open.journal;
  if (!asksPending(open.journal) || over(loopRun, open)) return;
  if (writers.length) {
    carry(loopRun, OPEN_NEWS.askWaitsForWriter(writers));
    return;
  }
  if (between.rewind) await rewind(loopRun, open, between.rewind);
  if (between.restart && !over(loopRun, open)) await restart(loopRun, open);
}

/** The between-turns work itself (the module's header). */
async function betweenTurns(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const savedInTurn = open.journal.savePoints.length > open.turnSavedFrom;
  const writers = writersInPlace(open).map((record) => record.id);
  // A turn that kept a save point left nothing for an autosave.
  if (!savedInTurn) await autosaveUnlessWriting(loopRun, writers);
  await asksAtTurnEnd(loopRun, open, writers);
  // The next turn's save points count from here.
  open.turnSavedFrom = open.journal.savePoints.length;
  await loopRun.saveJournal().catch(() => {});
}

/** The between-turns work (the module's header), for an open Loop's run. */
export async function openBetweenTurns(loopRun: LoopRun): Promise<void> {
  const open = loopRun.open;
  if (!open || over(loopRun, open)) return;
  // A look the turn started settles first: what it saw is said before what follows, never in the middle of it.
  if (open.healthLook) await open.healthLook;
  open.betweenTurns = true;
  try {
    await betweenTurns(loopRun, open);
  } finally {
    open.betweenTurns = false;
  }
}
