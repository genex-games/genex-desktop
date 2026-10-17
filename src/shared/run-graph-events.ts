import { CustomEvent, DELEGATED_PREFIX } from "./custom-events.ts";
import { EventKind, type EventEnvelope } from "./event-log.ts";

/** What a chat turn's graph key starts with: never a run id (`run-summary-cache.ts` reads only `[A-Za-z0-9_-]`). */
export const TURN_GRAPH_PREFIX = "turn:";

/** The key of a chat turn's own graph: the workers a chat message started, drawn apart from any run. */
export const turnGraphKey = (turn: string): string => `${TURN_GRAPH_PREFIX}${turn}`;

/** The chat turn a graph key names, or null for a run's key (or a key naming no turn). */
export function turnOfGraphKey(key: string): string | null {
  if (!key.startsWith(TURN_GRAPH_PREFIX)) return null;
  return key.slice(TURN_GRAPH_PREFIX.length) || null;
}

/** The graph a record belongs to: its run when it names one, else its chat turn's, else none. */
export function graphKeyOf(payload: { runId?: unknown; turn?: unknown }): string | null {
  if (typeof payload.runId === "string" && payload.runId) return payload.runId;
  if (typeof payload.turn === "string" && payload.turn) return turnGraphKey(payload.turn);
  return null;
}

/**
 * One worker across its records (`worker_started`, `worker_finished`): its graph and its id, so the
 * same id in two runs or two chat turns is two workers; null for a record naming no worker.
 */
export function workerKeyOf(payload: { runId?: unknown; turn?: unknown; workerId?: unknown }): string | null {
  if (typeof payload.workerId !== "string" || !payload.workerId) return null;
  return `${graphKeyOf(payload) ?? ""}\u0000${payload.workerId}`;
}

/** Whether a worker's key (`workerKeyOf`) names a worker of the graph `graphKey`. */
export const isWorkerOfGraph = (workerKey: string, graphKey: string): boolean =>
  workerKey.startsWith(`${graphKey}\u0000`);

/**
 * The queue records of the person's message a run answers: the last message the chat began
 * answering before the run's first record, as it was queued and then begun. They name no run, so a
 * run's own records leave them out; the start node reads its pictures from them.
 */
export function answeredRecords(events: readonly EventEnvelope[], runId: string): EventEnvelope[] {
  const first = events.findIndex((event) => customPayloadOf(event)?.runId === runId);
  const before = first < 0 ? [] : events.slice(0, first);
  const begun = before.findLast((event) => customTypeOf(event) === CustomEvent.CoordinatorMessageProcessing);
  const messageId = begun ? customPayloadOf(begun)?.messageId : undefined;
  if (!begun || typeof messageId !== "string") return [];
  const queued = before.findLast(
    (event) =>
      customTypeOf(event) === CustomEvent.CoordinatorMessageQueued && customPayloadOf(event)?.messageId === messageId,
  );
  return queued ? [queued, begun] : [begun];
}

const customTypeOf = (event: EventEnvelope): string | null =>
  event.data.type === EventKind.Custom ? event.data.event_type : null;
const customPayloadOf = (event: EventEnvelope): Record<string, unknown> | null =>
  event.data.type === EventKind.Custom ? (event.data.payload as Record<string, unknown>) : null;

/** Graph-only transport offsets preserve chronology when bulky trace events are omitted. */
export type RunGraphEvent = EventEnvelope & { graphSequence?: number; graphLastAt?: string };

/** Remove non-drawing traces while preserving the original custom-event positions and last timestamp. */
export function compactGraphEvents(events: EventEnvelope[]): RunGraphEvent[] {
  const compact: RunGraphEvent[] = [];
  let sequence = 0;
  let lastAt: string | undefined;
  for (const event of events) {
    if (event.data.type !== EventKind.Custom) continue;
    sequence++;
    lastAt = event.created_at;
    const kind = event.data.event_type;
    const noise =
      kind.startsWith(DELEGATED_PREFIX) || kind === CustomEvent.SessionActivity || kind === CustomEvent.ContextUsage;
    if (!noise) compact.push({ ...event, graphSequence: sequence });
  }
  const last = compact.at(-1);
  if (last && lastAt !== undefined) last.graphLastAt = lastAt;
  return compact;
}
