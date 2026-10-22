import type { EventEnvelope } from "../types.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { type QueuedMessage, QueueState, SteerDelivery, messageQueueState } from "../../shared/message-queue.ts";

/**
 * The record a message's bubble moves before, by the state it is in: it reads where the agent
 * first saw it. Waiting input (queued, or steering: handed to the running turn but not read yet)
 * has none, and moves to the end. A state not listed keeps its place.
 */
const READ_AT: Partial<Record<QueueState, CustomEvent | null>> = {
  [QueueState.Queued]: null,
  [QueueState.Steering]: null,
  [QueueState.Processing]: CustomEvent.CoordinatorMessageProcessing,
  [QueueState.Handled]: CustomEvent.CoordinatorMessageProcessing,
  [QueueState.Delivered]: CustomEvent.CoordinatorMessageDelivered,
};
/** The records a bubble can move before. */
const READ_RECORDS: ReadonlySet<string> = new Set([
  CustomEvent.CoordinatorMessageProcessing,
  CustomEvent.CoordinatorMessageDelivered,
]);

/** A message told to a run's lead without being delivered to it (its wrap-up): the key of the record it was told by. */
const TOLD = "told";

/**
 * The message a run's lead was only told by this record (`run_steering`, how `lead`, `kept`: its
 * wrap-up), or null for any other record. One delivered to the lead and given back when its run
 * ended is not kept: it waits below like any other.
 */
function toldBy(event: EventEnvelope): string | null {
  const custom = customRecord(event.data);
  if (custom?.event_type !== CustomEvent.RunSteering || custom.payload.how !== SteerDelivery.Lead) return null;
  if (custom.payload.kept !== true) return null;
  const id = custom.payload.sourceMessageId;
  return typeof id === "string" && id ? id : null;
}

/**
 * The messages a run's lead was told of in its wrap-up and never delivered: the chat answers them once
 * the build closes, but the lead heard them where they were told, so that is where they read.
 */
export function toldToLead(
  events: readonly EventEnvelope[],
  messages: ReadonlyMap<string, QueuedMessage>,
): Set<string> {
  const told = new Set<string>();
  for (const event of events) {
    const id = toldBy(event);
    if (id && messages.get(id) && messages.get(id)?.state !== QueueState.Delivered) told.add(id);
  }
  return told;
}

/** A record a bubble can move before, keyed `<record>:<messageId>`; null for any other record. */
function readAt(event: EventEnvelope): string | null {
  const told = toldBy(event);
  if (told) return `${TOLD}:${told}`;
  const custom = customRecord(event.data);
  if (!custom || !READ_RECORDS.has(custom.event_type)) return null;
  const id = custom.payload.messageId;
  return typeof id === "string" && id ? `${custom.event_type}:${id}` : null;
}

/**
 * The messages that move, by the id of their user row: each waiting one (to the end), and each
 * read one whose reading is recorded (to that record).
 */
function movingMessages(
  messages: Iterable<QueuedMessage>,
  recorded: ReadonlySet<string>,
  told: ReadonlySet<string>,
): Map<string, string> {
  const moving = new Map<string, string>();
  for (const message of messages) {
    // Told to a run's lead in its wrap-up: it reads where the lead was told, whatever the chat does with it after.
    if (message.eventId && told.has(message.messageId)) {
      moving.set(message.eventId, `${TOLD}:${message.messageId}`);
      continue;
    }
    const type = READ_AT[message.state];
    if (!message.eventId || type === undefined) continue;
    const at = type ? `${type}:${message.messageId}` : `waiting:${message.messageId}`;
    if (!type || recorded.has(at)) moving.set(message.eventId, at);
  }
  return moving;
}

/**
 * A follow-up belongs where it was delivered, not where it was typed. A message still waiting
 * moves to the end (the panel shows it below the current work); one answered by a turn of its
 * own moves to the moment its processing began, so a message typed during a build reads after
 * that build; one steered into a running turn moves to where that turn read it, which may be in
 * the middle of its work. Messages without that recorded moment keep their place.
 */
export function deliveryOrder(events: EventEnvelope[], messages = messageQueueState(events).messages): EventEnvelope[] {
  const recorded = new Set<string>();
  for (const event of events) {
    const at = readAt(event);
    if (at) recorded.add(at);
  }
  const moving = movingMessages(messages.values(), recorded, toldToLead(events, messages));
  if (!moving.size) return events;
  const held = new Map<string, EventEnvelope>();
  const result: EventEnvelope[] = [];
  for (const event of events) {
    const at = moving.get(event.id);
    if (at) {
      held.set(at, event);
      continue;
    }
    const key = readAt(event);
    const message = key ? held.get(key) : undefined;
    if (key && message) {
      result.push(message);
      held.delete(key);
    }
    result.push(event);
  }
  return [...result, ...held.values()];
}
