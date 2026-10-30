/**
 * The run's record in its run journal (`autopilot_<runId>`, the harness's own and durable): what a
 * run needs to go on after a restart, a crash or a pause — its own clock and the time it has worked,
 * the integration's last health check, the log and how much of it the lead has heard, and the wake
 * loop's own state. Every save writes it (`recordLoopRun`, called by loop-run.ts `saveJournal`); a
 * resumed run reads it back (`restoreLoopRun`, called by setup.ts `prepareLoopRun`). Its functions
 * take the run explicitly; they are not bound onto it.
 */
import { tallyOf } from "../finish-check.ts";
import { MINUTE_MS } from "../time.ts";
import { DirectorLoop, WAKE_WINDOW_MS } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun, LoopRunLogEntry } from "./loop-run.ts";
import type { WakeState } from "./wake.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** How many of the run's log lines the journal keeps, the newest. */
export const JOURNAL_LOG_LINES = 60;

/** The wrap-up reserve: a tenth of the run, never less than five minutes nor more than fifteen. */
const WRAP_RESERVE_MIN_MS = 5 * MINUTE_MS;
const WRAP_RESERVE_MAX_MS = 15 * MINUTE_MS;
const WRAP_RESERVE_SHARE = 0.1;

/**
 * The run's own clock: when its working time ends and when it ends. `started` is when the run
 * would have started had it never paused, so the time it has worked is always `now - started`.
 */
export interface LoopRunClock {
  started: number;
  softDeadline: number;
  finalDeadline: number;
}

/** What the wake loop takes back from the journal on a Resume. */
export interface RestoredWake {
  idleAsked: boolean;
  wakesAt: number[];
  /** Lost sessions the run has already replaced: the allowance does not start again on a Resume. */
  freshSessions?: number;
}

/** A time for the journal: ISO, or null. */
const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** A time from the journal — ISO or milliseconds — or null when it is not one. */
function msOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A count from the journal. */
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The session ends this long before the hard deadline; a wrap-up session gets the rest. */
export function wrapReserveMs(total: number): number {
  return Math.max(WRAP_RESERVE_MIN_MS, Math.min(WRAP_RESERVE_MAX_MS, Math.round(total * WRAP_RESERVE_SHARE)));
}

/**
 * The run's clock. A new run starts one; a resumed run goes on with the working time it had left —
 * the budget less the time its journal counts it worked, never the wall clock. A run whose worked
 * time used its working time gets only its wrap-up.
 */
export function loopRunClock({ saved, now, totalMs }: { saved: unknown; now: number; totalMs: number }): LoopRunClock {
  const reserve = wrapReserveMs(totalMs);
  const workedRaw = (saved as AnyRecord | null | undefined)?.workedMs;
  const worked = typeof workedRaw === "number" && Number.isFinite(workedRaw) && workedRaw >= 0 ? workedRaw : 0;
  const started = now - worked;
  const clock = { started, softDeadline: started + totalMs - reserve, finalDeadline: started + totalMs };
  if (worked === 0 || now < clock.softDeadline) return clock;
  return { started, softDeadline: now, finalDeadline: now + reserve };
}

/** The newest lines of the run's log, as the journal keeps them. */
function logRecord(log: readonly LoopRunLogEntry[]): LoopRunLogEntry[] {
  return log.slice(-JOURNAL_LOG_LINES).map(({ at, seq, text, kind }) => ({ at, seq, text, ...(kind ? { kind } : {}) }));
}

/** The run's own clock: the one prepareLoopRun kept on it, else the one it runs on. */
function clockOf(loopRun: LoopRun): LoopRunClock {
  return (
    loopRun.clock ?? {
      started: loopRun.started,
      softDeadline: loopRun.softDeadline,
      finalDeadline: loopRun.finalDeadline,
    }
  );
}

/**
 * Put the run's record on its journal (`journal.director`), as every save does: its clock and the
 * time it has worked, the integration's last health check, the log and how much of it the lead has
 * heard, and where its job ends and its finish checks stand.
 */
export function recordLoopRun(loopRun: LoopRun, now = Date.now()): void {
  const director = loopRun.journal?.director;
  if (!director || !loopRun.state) return;
  const { state } = loopRun;
  const clock = clockOf(loopRun);
  Object.assign(director, {
    clock: {
      started: iso(clock.started),
      softDeadline: iso(clock.softDeadline),
      finalDeadline: iso(clock.finalDeadline),
      workedMs: Math.max(0, now - clock.started),
    },
    integrationHealthy: state.integrationHealthy,
    log: logRecord(state.log),
    logSeq: loopRun.logSeq,
    heardSeq: loopRun.waitSeq,
    judges: state.judges,
    jobsCursor: state.jobsCursor ?? 0,
    ...(state.finishTally ? { finishTally: state.finishTally } : {}),
  });
}

/**
 * The journal as a save compares it with what the last save wrote: all of it but the count of
 * worked time, which moves every moment. Null when it cannot be read as JSON; it is then written.
 */
export function journalText(journal: AnyRecord): string | null {
  const clock = journal?.director?.clock;
  const director = clock ? { ...journal.director, clock: { ...clock, workedMs: undefined } } : journal?.director;
  try {
    return JSON.stringify({ ...journal, director });
  } catch {
    return null;
  }
}

/** The wake loop's own state, as the journal keeps it (wake.ts `journalWake` writes it). */
export function wakeRecord(
  wake: Pick<WakeState, "idleAsked" | "wrapCause" | "wakes" | "wakesAt" | "lastWakeAt" | "asleepSince"> & {
    freshSessions?: number;
  },
): AnyRecord {
  return {
    loop: DirectorLoop.Wake,
    idleAsked: wake.idleAsked,
    freshSessions: wake.freshSessions ?? 0,
    wrapCause: wake.wrapCause,
    wakes: wake.wakes,
    wakesAt: wake.wakesAt.map(iso),
    lastWakeAt: iso(wake.lastWakeAt),
    asleepSince: iso(wake.asleepSince),
  };
}

/** Does this run pick up one its journal kept: a Resume of a Loop's run? */
export function resumedFromJournal(loopRun: Pick<LoopRun, "resume" | "priorJournal">): boolean {
  return loopRun.resume === true && Boolean(loopRun.priorJournal?.director);
}

/** The log's newest lines as the journal kept them, and how much of it the lead has heard. */
function restoreLog(loopRun: LoopRun, saved: AnyRecord): void {
  const log = (Array.isArray(saved.log) ? saved.log : []).filter(
    (entry: AnyRecord): entry is LoopRunLogEntry => typeof entry?.seq === "number" && typeof entry.text === "string",
  );
  loopRun.state.log = log;
  loopRun.logSeq = Math.max(countOf(saved.logSeq), log.at(-1)?.seq ?? 0);
  loopRun.waitSeq = Math.min(countOf(saved.heardSeq), loopRun.logSeq);
}

/**
 * A resumed run reads its journal back: the last health check, the log and how much of it the lead
 * had heard, its judges' count, its job cursor and its finish checks. The integration head comes back
 * through `startingCommits` (setup.ts), the clock through `capClock`. Called before the run writes a
 * line of its own.
 */
export function restoreLoopRun(loopRun: LoopRun): void {
  if (!resumedFromJournal(loopRun)) return;
  const saved = loopRun.priorJournal?.director ?? {};
  const { state } = loopRun;
  if (typeof saved.integrationHealthy === "boolean") state.integrationHealthy = saved.integrationHealthy;
  restoreLog(loopRun, saved);
  state.judges = Number.isInteger(saved.judges) && saved.judges > 0 ? saved.judges : 0;
  state.jobsCursor = countOf(saved.jobsCursor);
  if (saved.finishTally !== undefined) state.finishTally = tallyOf(saved.finishTally);
}

/** The wake loop's own state as the journal kept it: whether the lead was asked what next, and the wakes still in the cap's window. */
export function restoredWake(saved: unknown, now: number): RestoredWake {
  const record = (saved ?? {}) as AnyRecord;
  const wakesAt = (Array.isArray(record.wakesAt) ? record.wakesAt : [])
    .map(msOf)
    .filter((at: number | null): at is number => at !== null && at > now - WAKE_WINDOW_MS && at <= now);
  const freshSessions = Number.isInteger(record.freshSessions) && record.freshSessions > 0 ? record.freshSessions : 0;
  return { idleAsked: record.idleAsked === true, wakesAt, ...(freshSessions ? { freshSessions } : {}) };
}
