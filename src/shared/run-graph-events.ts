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
 * The queue records of the person's messages a run answers: the last message the chat began
 * answering before the run's first record, as it was queued and then begun, and each message the
 * chat went on with the run for (a `run_steering` of it names one), as it was queued. They name no
 * run, so a run's own records leave them out; its start reads their pictures from them.
 */
export function answeredRecords(events: readonly EventEnvelope[], runId: string): EventEnvelope[] {
  const first = events.findIndex((event) => customPayloadOf(event)?.runId === runId);
  if (first < 0) return [];
  const asked = firstAsked(events.slice(0, first));
  return [...asked, ...steeredMessages(events, runId).filter((queued) => !asked.includes(queued))];
}

/** The last message the chat began answering in `before`: its queue record, then its start. */
function firstAsked(before: readonly EventEnvelope[]): EventEnvelope[] {
  const begun = before.findLast((event) => customTypeOf(event) === CustomEvent.CoordinatorMessageProcessing);
  const messageId = begun ? customPayloadOf(begun)?.messageId : undefined;
  if (!begun || typeof messageId !== "string") return [];
  const queued = before.findLast(
    (event) =>
      customTypeOf(event) === CustomEvent.CoordinatorMessageQueued && customPayloadOf(event)?.messageId === messageId,
  );
  return queued ? [queued, begun] : [begun];
}

/** The queue record of each message a steer of the run names (`sourceMessageId`), in the log's order. */
function steeredMessages(events: readonly EventEnvelope[], runId: string): EventEnvelope[] {
  const named = new Set<string>();
  for (const event of events) {
    const payload = customTypeOf(event) === CustomEvent.RunSteering ? customPayloadOf(event) : null;
    if (payload?.runId === runId && typeof payload.sourceMessageId === "string") named.add(payload.sourceMessageId);
  }
  if (named.size === 0) return [];
  return events.filter((event) => {
    const messageId = customPayloadOf(event)?.messageId;
    return (
      customTypeOf(event) === CustomEvent.CoordinatorMessageQueued &&
      typeof messageId === "string" &&
      named.has(messageId)
    );
  });
}

const customTypeOf = (event: EventEnvelope): string | null =>
  event.data.type === EventKind.Custom ? event.data.event_type : null;
const customPayloadOf = (event: EventEnvelope): Record<string, unknown> | null =>
  event.data.type === EventKind.Custom ? (event.data.payload as Record<string, unknown>) : null;

/** Graph-only transport offsets preserve chronology when bulky trace events are omitted. */
export type RunGraphEvent = EventEnvelope & { graphSequence?: number };

/**
 * A custom record the run graph never draws: a builder's mirrored trace, session activity, context
 * use. They are most of a long run's records.
 */
export function isGraphTrace(eventType: string): boolean {
  return (
    eventType.startsWith(DELEGATED_PREFIX) ||
    eventType === CustomEvent.SessionActivity ||
    eventType === CustomEvent.ContextUsage
  );
}

/**
 * Remove non-drawing traces while preserving the original custom-event positions. Nothing is
 * stamped with the latest trace's time: a summary whose drawn records did not change stays the
 * same summary, so a builder's trace does not make every view of the run fold it again.
 */
export function compactGraphEvents(events: EventEnvelope[]): RunGraphEvent[] {
  const compact: RunGraphEvent[] = [];
  let sequence = 0;
  for (const event of events) {
    if (event.data.type !== EventKind.Custom) continue;
    sequence++;
    if (!isGraphTrace(event.data.event_type)) compact.push({ ...event, graphSequence: sequence });
  }
  return compact;
}
