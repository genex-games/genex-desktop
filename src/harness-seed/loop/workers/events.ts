/**
 * The records a worker leaves on its chat's log, whichever lead started it (a chat turn's pool, a
 * run's pool, the director's builders, the Unreal lead's typed workers): `worker_started` when it
 * starts, `worker_finished` when it ends, and a second `worker_finished` with the lead's verdict.
 * A run's worker is stamped with its run; a chat turn's names its turn and the person's request.
 * Every record is a courtesy to the log: a write that fails is logged, never the lead's.
 */
import type { HarnessCtx } from "../../types/harness.d.ts";
import type { GameEngine } from "../game-engine.ts";
import { appendRun } from "../run-events.ts";
import { clip, hasText } from "../text.ts";
import { clipWords } from "../word-clip.ts";
import {
  POOL_WORKER_PREFIX,
  WORKER_ASK_CHARS,
  WORKER_SUMMARY_CHARS,
  WORKER_TASK_CHARS,
  type WorkerEnd,
  WorkerEvent,
  type WorkerIsolation,
  type WorkerStopCode,
  type WorkerVerdict,
} from "./contract.ts";
import { WORKER_WHERE_CHARS } from "./where.ts";

/** Where a worker's records go: its chat, and its run or the chat turn (with the request) that started it. */
export interface WorkerEventScope {
  ctx: HarnessCtx;
  threadId: string;
  project?: string;
  runId?: string;
  turn?: string | null;
  /** The person's request the turn answers: kept on a chat turn's start records only. */
  ask?: string;
}

/** A worker as its start record names it. */
export interface WorkerStart {
  workerId: string;
  title: string;
  isolation: WorkerIsolation;
  task: string;
  type?: string | null;
  /** The engine it works in, when it works in place in the game folder of one. */
  in?: GameEngine;
  /** The app it works in place in, by the label of the plugin lock it holds ("Unreal"). */
  where?: string;
}

/** A worker's end (`state`), or the lead's verdict on it (`verdict`, with no `state`). */
export interface WorkerFinish {
  workerId: string;
  title: string;
  state?: WorkerEnd;
  stoppedBecause?: string | null;
  /** Why it stopped short, as the code the app words: `stoppedBecause` is for the lead. */
  stopCode?: WorkerStopCode | null;
  summary?: string | null;
  delivered?: boolean;
  /** It finished work it wrote in place in the game folder: that work is in the game already. */
  inGame?: boolean;
  verdict?: WorkerVerdict;
  note?: string | null;
  merged?: boolean;
}

/** A pool worker's id in its records: apart from every id a lead names itself. */
export const poolWorkerId = (id: string): string => `${POOL_WORKER_PREFIX}${id}`;

/** The end of a sentence: its stop and the space (or the end of the text) after it. */
const SENTENCE_END = /[.!?](?=\s|$)/;
/** A markdown heading's marks at the start of a line. */
const HEADING = /^#{1,6}(\s+|$)/;
/** A markdown rule: a line of dashes, stars or underscores. */
const RULE = /^([-*_]\s*){3,}$/;
/** What a markdown line opens with: quote marks, a list's bullet or number. */
const LINE_MARKS = /^(>\s*)*([-*+]\s+|\d+[.)]\s+)?/;
/** Emphasis and code marks inside a line; underscores stay, as names in code carry them. */
const INLINE_MARKS = /[*`]+/g;

/** A line of a report as plain words: its markdown marks taken off. */
const plainLine = (line: string): string =>
  line.replace(HEADING, "").replace(LINE_MARKS, "").replace(INLINE_MARKS, "").replace(/\s+/g, " ").trim();

/** The report's first line that says something: a heading only when nothing else does. */
function firstLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !RULE.test(line));
  const said = lines.find((line) => !HEADING.test(line)) ?? lines[0] ?? "";
  return plainLine(said);
}

/** The first sentence of a worker's own summary (its first plain line, at most), cut at a word; "" for none. */
export function firstSentence(text: unknown): string {
  const line = firstLine(String(text ?? ""));
  const end = SENTENCE_END.exec(line);
  return clipWords(end ? line.slice(0, end.index + 1) : line, WORKER_SUMMARY_CHARS).trim();
}

/** What every record of the scope says: its game, and its turn when it has no run. */
function scopeFields(scope: WorkerEventScope): { project?: string; turn?: string } {
  const turn = !scope.runId && hasText(scope.turn) ? { turn: scope.turn } : {};
  return { ...(scope.project ? { project: scope.project } : {}), ...turn };
}

/** The `worker_started` record of a worker. */
export function workerStartedPayload(scope: WorkerEventScope, worker: WorkerStart, at: number): object {
  const ask = !scope.runId && hasText(scope.ask) ? { ask: clip(scope.ask.trim(), WORKER_ASK_CHARS) } : {};
  const { project, turn } = scopeFields(scope);
  return {
    ...(project ? { project } : {}),
    workerId: worker.workerId,
    title: worker.title,
    isolation: worker.isolation,
    ...(worker.type ? { type: worker.type } : {}),
    task: clip(worker.task, WORKER_TASK_CHARS),
    ...(worker.in ? { in: worker.in } : {}),
    ...(hasText(worker.where) ? { where: clip(worker.where.trim(), WORKER_WHERE_CHARS) } : {}),
    ...(turn ? { turn } : {}),
    ...ask,
    at: new Date(at).toISOString(),
  };
}

/** The `worker_finished` record of a worker's end or of the lead's verdict: only what it says. */
export function workerFinishedPayload(scope: WorkerEventScope, worker: WorkerFinish, at: number): object {
  const summary = firstSentence(worker.summary);
  const { project, turn } = scopeFields(scope);
  return {
    ...(project ? { project } : {}),
    workerId: worker.workerId,
    title: worker.title,
    ...(worker.state ? { state: worker.state } : {}),
    ...(hasText(worker.stoppedBecause) ? { stoppedBecause: worker.stoppedBecause } : {}),
    ...(worker.stopCode ? { stopCode: worker.stopCode } : {}),
    ...(summary ? { summary } : {}),
    ...(worker.delivered ? { delivered: true } : {}),
    ...(worker.inGame ? { inGame: true } : {}),
    ...(worker.verdict ? { verdict: worker.verdict } : {}),
    ...(hasText(worker.note) ? { note: worker.note } : {}),
    ...(worker.merged ? { merged: true } : {}),
    ...(turn ? { turn } : {}),
    at: new Date(at).toISOString(),
  };
}

/** Record a worker's start on its chat's log; never throws. */
export async function recordWorkerStarted(
  scope: WorkerEventScope,
  worker: WorkerStart,
  at: number = Date.now(),
): Promise<void> {
  const payload = workerStartedPayload(scope, worker, at);
  await appendRun(scope.ctx, scope.threadId, WorkerEvent.Started, payload, { runId: scope.runId ?? null });
}

/** Record a worker's end, or the lead's verdict on it, on its chat's log; never throws. */
export async function recordWorkerFinished(
  scope: WorkerEventScope,
  worker: WorkerFinish,
  at: number = Date.now(),
): Promise<void> {
  const payload = workerFinishedPayload(scope, worker, at);
  await appendRun(scope.ctx, scope.threadId, WorkerEvent.Finished, payload, { runId: scope.runId ?? null });
}
