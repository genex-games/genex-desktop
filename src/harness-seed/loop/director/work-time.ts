/**
 * A Loop's working time against the time the person asked for (../work-time.ts): how long the run has
 * worked (its earlier sessions, which its journal keeps as `director.worked`, and this one on the
 * Loop's clock since it took the project up), and what that means for its lead. Its finish is refused
 * before the time is worked: only the person ends a timed Loop sooner (their Finish or Stop, or the
 * lead's pause for something only they can do). A turn that ends with nothing at work is woken to go
 * on, and once the time is up the lead is told to wrap up (wake.ts). Its functions take the run
 * explicitly; they are not bound onto it.
 */
import { askedMs, dueMs, spanWords, type WorkAsk, workAskOf, withoutWork } from "../work-time.ts";
import { WORK_WORDS } from "../work-time-prompts.ts";
import { gitAt } from "../git.ts";
import { FOLDER_GIT } from "./open/folder-git.ts";
import { NoteKind } from "./wake-schedule.ts";
import type { AnyRecord, Run } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/**
 * How many wakes in a row to go on its lead may answer with nothing done (the game folder as it was,
 * no worker started) before its Loop pauses as any Loop whose turn ends with nothing at work does.
 */
export const MAX_IDLE_KEEPS = 2;

/** The run as its time is read: its budgets, its earlier worked time, its clock and whether its wrap-up began. */
type TimedRun = Pick<LoopRun, "run" | "workedBefore" | "open" | "wrapping">;

/** Where the run stands against the person's time: what they asked, what it has worked, and what is left (below zero once over). */
export interface WorkClock {
  ask: WorkAsk;
  worked: number;
  left: number;
}

/** What the wake loop keeps of its wakes to go on (wake.ts): the lead's work mark at the last one, and the idle ones in a row. */
export interface KeepState {
  keptAt: string | null;
  idleKeeps: number;
  /** The lead was told mid-turn that the time is up. */
  timeUpSaid: boolean;
}

/** A wake loop's keep state before any wake to go on. */
export const newKeepState = (): KeepState => ({ keptAt: null, idleKeeps: 0, timeUpSaid: false });

/** The worked time an earlier session of the run kept in its journal (`director.worked`), or none. */
export function workedBefore(priorJournal: AnyRecord | null | undefined): number {
  const worked = priorJournal?.director?.worked;
  return typeof worked === "number" && Number.isFinite(worked) && worked > 0 ? worked : 0;
}

/** How long the run has worked: its earlier sessions, and this one since the Loop took the project up. */
export function workedMs(loopRun: Pick<LoopRun, "workedBefore" | "open">): number {
  const before = loopRun.workedBefore ?? 0;
  const open = loopRun.open;
  // A run whose Loop has not taken the project up yet (or one a test builds by hand) has no clock.
  const clock = open?.clock;
  return clock ? before + Math.max(0, clock.now() - open.since) : before;
}

/** The run against the person's time, or null when they asked for none. */
export function workClock(loopRun: TimedRun): WorkClock | null {
  const ask = workAskOf(loopRun.run?.budgets);
  if (!ask) return null;
  const worked = workedMs(loopRun);
  return { ask, worked, left: dueMs(ask) - worked };
}

/** Whether the person's time is up: false when they asked for none. */
export function timeIsUp(loopRun: TimedRun): boolean {
  const clock = workClock(loopRun);
  return clock !== null && clock.left <= 0;
}

/** The worked time the person's time counts, from when they asked: what a line says the Loop "worked". */
const workedOfAsk = (clock: WorkClock): number => Math.max(0, clock.worked - clock.ask.fromMs);

/**
 * A resumed run whose time is spent goes on with none, unless the person named a new one with the
 * resume (`resume_run` writes it on the journal first): the spent time leaves its budgets.
 */
export function settleWorkAsk(run: Run, worked: number): void {
  const ask = workAskOf(run.budgets);
  if (ask && worked >= dueMs(ask)) run.budgets = withoutWork(run.budgets);
}

/** The line beside the Loop's first one: the person's time and what is left of it now; null when they asked for none. */
export function workStartLine(loopRun: TimedRun): string | null {
  const clock = workClock(loopRun);
  if (!clock) return null;
  return WORK_WORDS.asked(spanWords(askedMs(clock.ask)), spanWords(Math.max(0, clock.left)));
}

/**
 * The Loop's first lines with the time line after the first, read as they are sent: a session opened
 * fresh late in the run hears what is left then, not at the Loop's start.
 */
export function withWorkLine(loopRun: TimedRun, lines: readonly string[]): string[] {
  const time = workStartLine(loopRun);
  if (!time || !lines.length) return [...lines];
  return [lines[0] ?? "", time, ...lines.slice(1)];
}

/**
 * Why the lead's finish is turned back for time, or null: the person's time has some left, nobody
 * asked the Loop to finish (`finishAsked`: the person's ask, or the lead's `wrap_up` for them, ends it
 * sooner), and this is not the run's last turn (`wrapping`: a failed turn's wrap-up closes the Loop
 * when it ends, so its lead may still claim the goal in it).
 */
export function finishTooSoon(loopRun: TimedRun, finishAsked: boolean): string | null {
  const clock = workClock(loopRun);
  if (!clock || clock.left <= 0 || finishAsked || loopRun.wrapping === true) return null;
  const asked = spanWords(askedMs(clock.ask));
  return WORK_WORDS.tooSoon(asked, spanWords(workedOfAsk(clock)), spanWords(clock.left));
}

/** What a close of a timed Loop tells its lead beside its own words: the time it worked; null with no time asked. */
export function workedLine(loopRun: TimedRun): string | null {
  const clock = workClock(loopRun);
  if (!clock) return null;
  return WORK_WORDS.worked(spanWords(askedMs(clock.ask)), spanWords(workedOfAsk(clock)));
}

/** The wrap-up turn's line once the person's time is up. */
export function timeUpWrapLine(loopRun: TimedRun): string {
  const clock = workClock(loopRun);
  if (!clock) return "";
  return WORK_WORDS.wrapUp(spanWords(askedMs(clock.ask)), spanWords(workedOfAsk(clock)));
}

/**
 * The lead's work so far as a mark: what the game folder holds (a change saved, autosaved, committed
 * or merged moves it) and the workers it started. A call of Genex's tools alone is no work, nor is a
 * save point of an unchanged folder: a lead that answered each wake with a finish Genex refused was
 * woken again and again until the time ran out. Null when git can't read the folder.
 */
async function workMark(loopRun: LoopRun): Promise<string | null> {
  const { ctx, run } = loopRun;
  const label = `open:${run.runId}:work-mark`;
  const folder = await gitAt(ctx, { project: run.project }, FOLDER_GIT.content, { label }).catch(() => null);
  return folder === null ? null : `${folder}/${loopRun.open.pool?.state.records.length ?? 0}`;
}

/**
 * A lead whose turn ended with nothing at work while the person's time has some left is told how much,
 * in a line that wakes it at once. False when no time is asked or left, or when it has answered
 * `MAX_IDLE_KEEPS` such wakes in a row with nothing done: then the Loop pauses as any does.
 */
export async function keepsWorking(loopRun: LoopRun, keep: KeepState): Promise<boolean> {
  const clock = workClock(loopRun);
  if (!clock || clock.left <= 0) return false;
  // A folder git can't read leaves the mark as it was: a read that fails now and then neither wakes
  // an idle lead for ever nor counts as its work.
  const mark = (await workMark(loopRun)) ?? keep.keptAt ?? "";
  keep.idleKeeps = keep.keptAt === mark ? keep.idleKeeps + 1 : 0;
  if (keep.idleKeeps >= MAX_IDLE_KEEPS) return false;
  keep.keptAt = mark;
  const asked = spanWords(askedMs(clock.ask));
  loopRun.note(WORK_WORDS.keepWorking(asked, spanWords(workedOfAsk(clock)), spanWords(clock.left)), NoteKind.WorkTime);
  return true;
}

/** Once the person's time is up, a lead at work is told, once, in a line it reads at its next step. */
export function sayTimeUp(loopRun: LoopRun, keep: KeepState): void {
  if (keep.timeUpSaid) return;
  const clock = workClock(loopRun);
  if (!clock || clock.left > 0) return;
  keep.timeUpSaid = true;
  loopRun.note(WORK_WORDS.timeUp(spanWords(askedMs(clock.ask)), spanWords(workedOfAsk(clock))), NoteKind.WorkTime);
}
