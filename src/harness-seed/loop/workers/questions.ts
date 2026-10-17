/**
 * The questions workers wait on the person with, read from the chat's log: each one's
 * `tool_permission` row names the worker (`worker.id`), and a pending row stays pending until the
 * person answers (a worker's card has no timeout). The shared pool reads its own workers' rows;
 * a run's own workers (the director's builders, the Unreal lead's typed workers) are read here, so
 * their lead is told one waits on the person and can stop it or work around it.
 */
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { EventEnvelope } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { EventKind } from "../run-events.ts";
import { WORKER_QUESTION_EVENT, WORKER_QUESTION_PENDING, type WorkerQuestion } from "./contract.ts";

/** A worker's question in the chat's log, or null for any other row. */
export function questionOf(event: EventEnvelope): WorkerQuestion | null {
  const data = event.data as AnyRecord;
  if (data?.type !== EventKind.Custom || data.event_type !== WORKER_QUESTION_EVENT) return null;
  const payload = data.payload as WorkerQuestion | null;
  return typeof payload?.requestId === "string" && typeof payload.worker?.id === "string" ? payload : null;
}

/** What a question asks, in a few words: the engine's sentence, the thing to decide on, or its id. */
export function questionText(question: WorkerQuestion): string {
  return question.title || question.subject || question.requestId;
}

/** One chat's log as read so far: where the last read ended, and the questions still pending, by request. */
interface Reading {
  cursor: string | null;
  pending: Map<string, WorkerQuestion>;
}

/** Each chat's reading, kept between calls so the log is read once. */
const readings = new Map<string, Reading>();

/**
 * The workers of a chat that wait on the person now, by worker id, with what each asks. Reads the
 * log since the last call; a log that cannot be read leaves what was known.
 */
export async function waitingWorkers(ctx: HarnessCtx, threadId: string): Promise<Map<string, string>> {
  const reading = readings.get(threadId) ?? { cursor: null, pending: new Map<string, WorkerQuestion>() };
  readings.set(threadId, reading);
  const after = reading.cursor ?? undefined;
  const events: EventEnvelope[] = await ctx.call(HostMethod.EventsList, { threadId, after }).catch(() => []);
  for (const event of events) {
    reading.cursor = event.id;
    const question = questionOf(event);
    if (!question) continue;
    if (question.state === WORKER_QUESTION_PENDING) reading.pending.set(question.requestId, question);
    else reading.pending.delete(question.requestId);
  }
  const waiting = new Map<string, string>();
  for (const question of reading.pending.values())
    if (question.worker?.id) waiting.set(question.worker.id, questionText(question));
  return waiting;
}
