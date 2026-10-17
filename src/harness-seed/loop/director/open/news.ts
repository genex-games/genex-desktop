/**
 * What reaches an open Loop's lead while its turn works: news that would wake a resting lead — a
 * worker of its pool that ended or asks the person something, a job of the run that ended, the
 * project's app that stopped and what Genex did — and, once a turn, a reminder to keep a save point
 * when the last is `SAVE_REMINDER_MS` old. Each goes into the turn under way (`engine.steer`, never
 * cutting it short), once; a line the session read (`DelegateResult.steered`, settled when its call
 * ends) is not told again by a digest, and one it did not read rides the next digest as news always
 * did — a line a replaced session took included. The lines of the Loop's cap ride the same rounds
 * (cap-lines.ts, whose time's-up alone may cut a session that can't read it). The health watch looks
 * at the project's app on the same rounds. While the lead rests, the wake loop's own rounds read the
 * questions and the app.
 */
import type { DelegateResult } from "../../../types/host-api.d.ts";
import { HostMethod } from "../../host-methods.ts";
import { closeUnderWay, finishUnderWay } from "../close-latch.ts";
import { settleCapLines, steerCapLine } from "../cap-lines.ts";
import { StopReason } from "../../outage.ts";
import { minutes, SECOND_MS } from "../../time.ts";
import { RUN_POOL_WORDS } from "../../workers/prompts.ts";
import { waitingWorkers } from "../../workers/questions.ts";
import type { LoopRun, LoopRunLogEntry } from "../loop-run.ts";
import { NoteKind } from "../wake-schedule.ts";
import { type OpenClock, type OpenLoop, SAVE_REMINDER_MS } from "./contract.ts";
import { abortLead, healthWatch } from "./health.ts";
import { OPEN_NEWS } from "./prompts.ts";

/** How often a turn under way is looked at for news. */
const TURN_WATCH_MS = SECOND_MS;
/** The workers' questions are read from the chat's log at most this often. */
const QUESTIONS_POLL_MS = 5 * SECOND_MS;

/** The kinds of line a working lead hears at once. */
const MID_TURN_NEWS: ReadonlySet<string> = new Set([
  NoteKind.WorkerEnded,
  NoteKind.WorkerAsks,
  NoteKind.JobEnded,
  NoteKind.AppCrashed,
  NoteKind.AppStopping,
]);

/** When each run's workers' questions were last read. */
const questionsReadAt = new WeakMap<object, number>();

/**
 * The save point a recovery took the folder back to while the lead has not heard so (no turn took
 * the line that tells it, no message carried it), or null: a close says it, and keeps nothing over it.
 */
export function wentBackUnheard(loopRun: Pick<LoopRun, "open" | "waitSeq">): string | null {
  const open = loopRun.open;
  if (!open?.wentBack) return null;
  const seq = open.wentBackSeq;
  const heard = seq !== null && (open.heard.has(seq) || loopRun.waitSeq >= seq);
  return heard ? null : open.wentBack;
}

/** Whether a turn under way already took this line of the run's log: no digest tells it again. */
export function heardMidTurn(loopRun: Pick<LoopRun, "open">, seq: number): boolean {
  return loopRun.open?.heard.has(seq) === true;
}

/**
 * The pool's workers that newly wait on the person, each told once in the run's log as a line that
 * wakes the lead at once (`NoteKind.WorkerAsks`); read at most every `QUESTIONS_POLL_MS`.
 */
export async function noteWorkerQuestions(loopRun: LoopRun, now: number): Promise<void> {
  const open = loopRun.open;
  const records = open?.pool?.state.records ?? [];
  if (!open || !records.length || now - (questionsReadAt.get(open) ?? -Infinity) < QUESTIONS_POLL_MS) return;
  questionsReadAt.set(open, now);
  const waiting = await waitingWorkers(loopRun.ctx, loopRun.threadId).catch(() => new Map<string, string>());
  for (const [id, question] of waiting) {
    const key = `${id}:${question}`;
    if (open.asked.has(key) || !records.some((record) => record.id === id)) continue;
    open.asked.add(key);
    loopRun.note(RUN_POOL_WORDS.waiting(id, question), NoteKind.WorkerAsks);
  }
}

/** Says one thing into the turn under way, never cutting it short; whether the session took it. */
async function steer(loopRun: LoopRun, id: string, text: string): Promise<boolean> {
  const params = { threadId: loopRun.threadId, into: loopRun.run.runId, messages: [{ id, text }], interrupt: false };
  const answer = await loopRun.ctx.call(HostMethod.EngineSteer, params).catch(() => null);
  return Boolean(answer?.accepted?.includes(id));
}

/** One turn's watch: what it has tried to say, its number, and the log lines its session took, by the id they went in under. */
type TurnWatch = { turn: number; tried: Set<number>; taken: Map<string, number> };

/** The news lines of the run's log no turn has taken and this one has not been offered. */
function newsFor(loopRun: LoopRun, open: OpenLoop, watch: TurnWatch): LoopRunLogEntry[] {
  return loopRun
    .notesSince(loopRun.waitSeq)
    .filter((entry) => entry.kind && MID_TURN_NEWS.has(entry.kind) && !open.heard.has(entry.seq))
    .filter((entry) => !watch.tried.has(entry.seq));
}

/** The reminder to keep a save point, once a turn, when the last one (or the Loop's start) is old enough. */
async function remindToSave(loopRun: LoopRun, open: OpenLoop, watch: TurnWatch): Promise<void> {
  if (open.remindedTurn === watch.turn) return;
  const since = Math.max(open.journal.savePoints.at(-1)?.at ?? 0, open.since);
  const elapsed = open.clock.now() - since;
  if (elapsed < SAVE_REMINDER_MS) return;
  open.remindedTurn = watch.turn;
  await steer(loopRun, `${loopRun.run.runId}:${watch.turn}:save`, OPEN_NEWS.saveReminder(minutes(elapsed)));
}

/** Whether the Loop is closing or closed: its lead hears no more news, and no reminder. */
const closing = (loopRun: LoopRun): boolean => loopRun.state.finished || closeUnderWay(loopRun.state);

/**
 * One look at a turn under way: the app, the questions, the jobs, then the news and the reminder.
 * A Loop Genex paused, or one the person stopped, ends the session again instead (one its first abort
 * missed: the host had not seated it yet); a closing Loop's lead hears nothing more, and one whose
 * finish is checked no reminder to save.
 */
async function lookOnce(loopRun: LoopRun, open: OpenLoop, watch: TurnWatch, pollJobs: () => Promise<void>) {
  if (open.halted || loopRun.ctx.cancelled === true) return abortLead(loopRun);
  healthWatch(loopRun);
  await noteWorkerQuestions(loopRun, open.clock.now());
  await pollJobs();
  if (closing(loopRun)) return;
  for (const entry of newsFor(loopRun, open, watch)) {
    watch.tried.add(entry.seq);
    const id = `${loopRun.run.runId}:${watch.turn}:news-${entry.seq}`;
    if (!(await steer(loopRun, id, entry.text))) continue;
    // Taken in, though not yet read: no wake tells it while the turn works; its end settles it (`settle`).
    open.heard.add(entry.seq);
    watch.taken.set(id, entry.seq);
  }
  if (!finishUnderWay(loopRun.state) && !closing(loopRun)) await remindToSave(loopRun, open, watch);
  // The heads-up before the Loop's cap and the time's-up at it (cap-lines.ts).
  if (!closing(loopRun)) await steerCapLine(loopRun, open.clock.now());
}

/**
 * Whether one session call of the lead's took an act of its own: a tool call (a session that only
 * answers reports one turn; an engine that counts none is given the benefit of the doubt), or a cut
 * at its cap, which only a session at work reaches.
 */
function sessionActed(result: Partial<DelegateResult> | undefined): boolean {
  if (!result) return false;
  if (result.stopReason === StopReason.Deadline) return true;
  return typeof result.turns !== "number" || result.turns > 1;
}

/** Whether one session call of the lead's opened a session that read its message (the wake loop's `startedWorking`). */
const startedASession = (result: Partial<DelegateResult> | undefined): boolean =>
  Boolean(result?.sessionId) && (result?.turns ?? 0) > 0;

/** The lines a session took in but never read (absent from its `steered`) are news again for the next digest. */
function settleTaken(open: OpenLoop, watch: TurnWatch, result: Partial<DelegateResult> | undefined): void {
  const read = new Set(result?.steered ?? []);
  for (const [id, seq] of watch.taken) if (!read.has(id)) open.heard.delete(seq);
  watch.taken.clear();
}

/**
 * Watches one session call of an open Loop's lead (the module's header) until `stop`; `pollJobs`
 * reads the run's job ends into its log, as the resting loop does. `settle` takes the call's result:
 * what its session did not read is told again, and whether it acted is kept for the turn's end
 * (`OpenLoop.sessionActed`).
 */
export function watchOpenTurn(
  loopRun: LoopRun,
  { clock, turn, pollJobs }: { clock: OpenClock; turn: number; pollJobs: () => Promise<void> },
): { stop: () => Promise<void>; settle: (result: Partial<DelegateResult> | undefined) => void } {
  const open = loopRun.open;
  if (!open) return { stop: async () => {}, settle: () => {} };
  const watch: TurnWatch = { turn, tried: new Set(), taken: new Map() };
  open.inTurn = true;
  let over = false;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!over) {
      await lookOnce(loopRun, open, watch, pollJobs).catch(() => {});
      await Promise.race([clock.sleep(TURN_WATCH_MS), ended]);
    }
  })();
  return {
    stop: async () => {
      over = true;
      open.inTurn = false;
      end();
      await watching;
    },
    settle: (result) => {
      settleTaken(open, watch, result);
      settleCapLines(loopRun, result);
      // Every call of the turn counts: a turn cut short and resumed acted if any of its calls did.
      if (sessionActed(result)) open.sessionActed = true;
      if (startedASession(result)) open.sessionWorked = true;
    },
  };
}
