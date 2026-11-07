/**
 * The run's record in its run journal (`autopilot_<runId>`, the harness's own and durable): what a
 * run needs to go on after a restart, a crash or a pause — the log and how much of it the lead has
 * heard, and the wake loop's own state. Every save writes it (`recordLoopRun`, called by loop-run.ts `saveJournal`); a
 * resumed run reads it back (`restoreLoopRun`, called by setup.ts `prepareLoopRun`). Its functions
 * take the run explicitly; they are not bound onto it.
 */
import { tallyOf } from "../finish-check.ts";
import { NoteKind } from "./wake-schedule.ts";
import { workedMs } from "./work-time.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun, LoopRunLogEntry } from "./loop-run.ts";
import type { WakeState } from "./wake.ts";

/** How many of the run's log lines the journal keeps, the newest. */
export const JOURNAL_LOG_LINES = 60;

/** What the wake loop takes back from the journal on a Resume. */
export interface RestoredWake {
  /** Lost sessions the run has already replaced: the allowance does not start again on a Resume. */
  freshSessions?: number;
}

/** A count from the journal. */
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The newest lines of the run's log, as the journal keeps them. */
function logRecord(log: readonly LoopRunLogEntry[]): LoopRunLogEntry[] {
  return log.slice(-JOURNAL_LOG_LINES).map(({ at, seq, text, kind }) => ({ at, seq, text, ...(kind ? { kind } : {}) }));
}

/**
 * Put the run's record on its journal (`journal.director`), as every save does: the log and how much
 * of it the lead has heard, where its job ends and its finish checks stand, and how long it has worked.
 */
export function recordLoopRun(loopRun: LoopRun): void {
  const director = loopRun.journal?.director;
  if (!director || !loopRun.state) return;
  const { state } = loopRun;
  Object.assign(director, {
    log: logRecord(state.log),
    logSeq: loopRun.logSeq,
    heardSeq: loopRun.waitSeq,
    judges: state.judges,
    jobsCursor: state.jobsCursor ?? 0,
    worked: workedMs(loopRun),
    ...(state.finishTally ? { finishTally: state.finishTally } : {}),
  });
}

/** The journal as a save compares it with what the last save wrote; null when it cannot be read as JSON (it is then written). */
export function journalText(journal: AnyRecord): string | null {
  try {
    return JSON.stringify(journal);
  } catch {
    return null;
  }
}

/** The wake loop's own state, as the journal keeps it (wake.ts `journalWake` writes it). */
export function wakeRecord(wake: Pick<WakeState, "freshSessions">): AnyRecord {
  return { freshSessions: wake.freshSessions };
}

/** Does this run pick up one its journal kept: a Resume of a Loop's run? */
export function resumedFromJournal(loopRun: Pick<LoopRun, "resume" | "priorJournal">): boolean {
  return loopRun.resume === true && Boolean(loopRun.priorJournal?.director);
}

/** The log's newest lines as the journal kept them, and how much of it the lead has heard. */
function restoreLog(loopRun: LoopRun, saved: AnyRecord): void {
  // A line about the person's time spoke for the session that wrote it: the resume's first line says
  // what is left now, and an old "wrap up" would close the Loop the person just resumed.
  const log = (Array.isArray(saved.log) ? saved.log : []).filter(
    (entry: AnyRecord): entry is LoopRunLogEntry =>
      typeof entry?.seq === "number" && typeof entry.text === "string" && entry.kind !== NoteKind.WorkTime,
  );
  loopRun.state.log = log;
  loopRun.logSeq = Math.max(countOf(saved.logSeq), log.at(-1)?.seq ?? 0);
  loopRun.waitSeq = Math.min(countOf(saved.heardSeq), loopRun.logSeq);
}

/**
 * A resumed run reads its journal back: the log and how much of it the lead had heard, its judges'
 * count, its job cursor and its finish checks. Called before the run writes a line of its own.
 */
export function restoreLoopRun(loopRun: LoopRun): void {
  if (!resumedFromJournal(loopRun)) return;
  const saved = loopRun.priorJournal?.director ?? {};
  const { state } = loopRun;
  restoreLog(loopRun, saved);
  state.judges = Number.isInteger(saved.judges) && saved.judges > 0 ? saved.judges : 0;
  state.jobsCursor = countOf(saved.jobsCursor);
  if (saved.finishTally !== undefined) state.finishTally = tallyOf(saved.finishTally);
}

/** The wake loop's own state as the journal kept it: the fresh sessions used. */
export function restoredWake(saved: unknown): RestoredWake {
  const record = (saved ?? {}) as AnyRecord;
  const freshSessions = Number.isInteger(record.freshSessions) && record.freshSessions > 0 ? record.freshSessions : 0;
  return freshSessions ? { freshSessions } : {};
}
