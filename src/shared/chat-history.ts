import { SessionActivityRole } from "./chat-activity.ts";
import { compareIds } from "./compare-ids.ts";
import { EventKind, type EventData, type EventEnvelope } from "./event-log.ts";
import { CustomEvent, customEvent, customRecord } from "./custom-events.ts";
import { ToolPermissionState } from "./permissions.ts";

export const CHAT_PAGE_SIZE = 160;
export interface ChatPage {
  events: EventEnvelope[];
  before: string | null;
  hasMore: boolean;
  /** Compact current-state facts, independent of the visible history page. */
  context: EventEnvelope[];
}

/** Current-state facts by key: the latest record that still says something about now. */
type Facts = Map<string, EventEnvelope>;
type Payload = Record<string, unknown>;
type CustomData = Extract<EventData, { type: "custom" }>;

/** Forgets every fact whose key matches. */
function forget(facts: Facts, key: RegExp): void {
  for (const factKey of facts.keys()) if (key.test(factKey)) facts.delete(factKey);
}

/** A run starting: a new run forgets the previous run's facts. */
function runStartFact(facts: Facts, event: EventEnvelope, p: Payload): void {
  facts.delete("interview:question");
  const current = facts.get("run:start");
  if (!current || customRecord(current.data)?.payload.runId !== p.runId) forget(facts, /^run:/);
  facts.set("run:start", event);
}

/** A step of the run that started last; a step of any other run is not current. */
function runStepFact(facts: Facts, event: EventEnvelope, event_type: string, p: Payload): void {
  const current = facts.get("run:start");
  const started = current ? customRecord(current.data) : null;
  if (started && started.payload.runId === p.runId) facts.set(`run:${event_type}`, event);
}

function consentFact(facts: Facts, event: EventEnvelope, p: Payload): void {
  if (p.state === "pending") facts.set(`consent:${p.consentId}`, event);
  else facts.delete(`consent:${p.consentId}`);
}

/** Claude's permission question: the first pending row is the question; a later one with its id cannot rewrite it. */
function permissionFact(facts: Facts, event: EventEnvelope, p: Payload): void {
  const key = `permission:${p.requestId}`;
  if (p.state !== ToolPermissionState.Pending) facts.delete(key);
  else if (!facts.has(key)) facts.set(key, event);
}

/** Background work still running: its line and Stop stay reachable whatever page is loaded. */
function jobFact(facts: Facts, event: EventEnvelope, event_type: string, p: Payload): void {
  if (typeof p.jobId !== "string") return;
  const key = `job:${p.jobId}`;
  if (event_type === CustomEvent.JobStarted) facts.set(key, event);
  else facts.delete(key);
}

function queuedFact(facts: Facts, event: EventEnvelope, data: CustomData, p: Payload): void {
  // Preserve identity across page/batch boundaries without keeping settled message bodies.
  const user = facts.get("queue:last-user");
  const eventId = p.eventId ?? user?.id;
  facts.set(`queued:${p.messageId}`, { ...event, data: { ...data, payload: { ...p, eventId } } });
  if (user && user.id === eventId) facts.set(`queued-user:${p.messageId}`, user);
}

/** A message answered or removed: it, and whatever was steered into its turn and read there, settle. */
function queueSettledFact(facts: Facts, event: EventEnvelope, event_type: string, p: Payload): void {
  settleReadInto(facts, p.messageId, event_type);
  settleQueued(facts, String(p.messageId), event, event_type);
}

/**
 * What was delivered into `into` settles with it: a turn answered (its message id), or a run that
 * closed (its run id) — a message handed to a run's lead is current until that run is over.
 */
function settleReadInto(facts: Facts, into: unknown, event_type: string): void {
  for (const [key, state] of [...facts]) {
    if (!key.startsWith("queued-state:")) continue;
    const read = customEvent(state, CustomEvent.CoordinatorMessageDelivered);
    if (read?.messageId && read.into === into) settleQueued(facts, read.messageId, state, event_type);
  }
}

/** One settled message: its words are no longer current, and only a sparse edit or removal stays. */
function settleQueued(facts: Facts, messageId: string, settled: EventEnvelope, event_type: string): void {
  facts.delete(`queued-user:${messageId}`);
  // Only sparse edits/removals survive completion, so older loaded pages stay truthful.
  if (event_type === CustomEvent.CoordinatorMessageRemoved || facts.has(`queued-edit:${messageId}`)) {
    facts.set(`queued-state:${messageId}`, settled);
    return;
  }
  facts.delete(`queued:${messageId}`);
  facts.delete(`queued-state:${messageId}`);
}

function customFact(facts: Facts, event: EventEnvelope, data: CustomData): void {
  const custom = customRecord(data);
  if (!custom) return;
  const { event_type, payload: p } = custom;
  switch (event_type) {
    case CustomEvent.RunRegistered:
    case CustomEvent.RunStarted:
      runStartFact(facts, event, p);
      break;
    case CustomEvent.RunFinished:
    case CustomEvent.AutopilotPaused:
      runStepFact(facts, event, event_type, p);
      settleReadInto(facts, p.runId, event_type);
      break;
    case CustomEvent.AutopilotResumed:
    case CustomEvent.RunControl:
      runStepFact(facts, event, event_type, p);
      break;
    case CustomEvent.InterviewQuestion:
      facts.set("interview:question", event);
      break;
    case CustomEvent.SessionActivity:
      facts.set(`session:${p.role ?? SessionActivityRole.Planner}:${p.facetId ?? p.engine ?? "main"}`, event);
      break;
    case CustomEvent.ContextUsage:
      // Keyed by whose session it measured: a builder or playtester on the chat's model mirrors its
      // readings into this thread, and must not evict the main session's, which the meter reads.
      facts.set(
        `context:${p.role ?? SessionActivityRole.Planner}:${p.engine ?? ""}:${p.model ?? p.requestedModel ?? ""}`,
        event,
      );
      break;
    case CustomEvent.PlanReview:
    case CustomEvent.ContractorSession:
    case CustomEvent.DelegationIncomplete:
    case CustomEvent.NeedsSignin:
    case CustomEvent.Compacted:
      facts.set(event_type, event);
      break;
    case CustomEvent.PluginConsent:
      consentFact(facts, event, p);
      break;
    case CustomEvent.ToolPermission:
      permissionFact(facts, event, p);
      break;
    case CustomEvent.CoordinatorMessageQueued:
      queuedFact(facts, event, data, p);
      break;
    case CustomEvent.CoordinatorMessageUpdated:
      facts.set(`queued-edit:${p.messageId}`, event);
      break;
    case CustomEvent.CoordinatorMessageProcessing:
    case CustomEvent.CoordinatorMessageRequeued:
    // Steered into a running turn, then read there: current until that turn is answered — a turn
    // that ends without reading it after all (a Stop, a failure) puts it back, and it keeps its bubble.
    case CustomEvent.CoordinatorMessageSteering:
    case CustomEvent.CoordinatorMessageDelivered:
      facts.set(`queued-state:${p.messageId}`, event);
      break;
    case CustomEvent.CoordinatorMessageHandled:
    case CustomEvent.CoordinatorMessageRemoved:
      queueSettledFact(facts, event, event_type, p);
      break;
    case CustomEvent.CoordinatorQueuePaused:
    case CustomEvent.CoordinatorQueueResumed:
      facts.set("queue:gate", event);
      break;
    case CustomEvent.JobStarted:
    case CustomEvent.JobEnded:
      jobFact(facts, event, event_type, p);
      break;
    case CustomEvent.ConversationRewound:
      // Permanent: an older page loaded later still needs every rewind to hide its withdrawn rows.
      facts.set(`rewind:${event.id}`, event);
      break;
  }
}

/** What one record changes about the conversation's current state. */
function applyFact(facts: Facts, event: EventEnvelope): void {
  const d = event.data;
  switch (d.type) {
    case EventKind.Messages:
      if (!d.messages.some((message) => message.role === "user")) break;
      facts.set("queue:last-user", event);
      facts.delete("interview:question");
      break;
    case EventKind.TurnStarted:
      forget(facts, /^(session:|tool:|turn:)/);
      facts.set("turn:start", event);
      break;
    case EventKind.TurnEnded:
      facts.set("turn:end", event);
      forget(facts, /^tool:/);
      break;
    case EventKind.ToolRequested:
      facts.set(`tool:${d.tool_call_id}`, event);
      break;
    case EventKind.ToolResult:
      facts.delete(`tool:${d.tool_call_id}`);
      break;
    case EventKind.Custom:
      customFact(facts, event, d);
      break;
  }
}

/** A disposable read projection. The append-only log remains authoritative. */
export function chatContext(previous: readonly EventEnvelope[], incoming: readonly EventEnvelope[]): EventEnvelope[] {
  const facts: Facts = new Map();
  for (const event of [...previous, ...incoming]) applyFact(facts, event);
  return [...new Map([...facts.values()].map((event) => [event.id, event])).values()].sort((a, b) =>
    compareIds(a.id, b.id),
  );
}

/** The batches' events once each (a later copy wins), in log order. */
export function mergeChatEvents(...batches: readonly (readonly EventEnvelope[])[]): EventEnvelope[] {
  let merged: EventEnvelope[] = [];
  for (const batch of batches) merged = mergeOrderedEvents(merged, ordered(batch));
  return merged;
}

/** Whether an incoming batch can append without inspecting retained history. */
export function followsTail(current: readonly EventEnvelope[], fresh: readonly EventEnvelope[]): boolean {
  let previous = current.at(-1)?.id;
  for (const event of fresh) {
    if (previous !== undefined && compareIds(previous, event.id) >= 0) return false;
    previous = event.id;
  }
  return true;
}

function ordered(batch: readonly EventEnvelope[]): readonly EventEnvelope[] {
  if (followsTail([], batch)) return batch;
  const unique = new Map(batch.map((event) => [event.id, event]));
  return [...unique.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** Linear merge of ordered batches; the right-hand copy wins when ids overlap. */
function mergeOrderedEvents(left: readonly EventEnvelope[], right: readonly EventEnvelope[]): EventEnvelope[] {
  const result: EventEnvelope[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const first = left[a];
    const second = right[b];
    if (!first || !second) break;
    const order = compareIds(first.id, second.id);
    if (order < 0) {
      result.push(first);
      a++;
    } else {
      result.push(second);
      b++;
      if (order === 0) a++;
    }
  }
  return result.concat(left.slice(a), right.slice(b));
}
