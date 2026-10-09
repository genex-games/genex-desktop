/**
 * The follow-up queue as the app reads it: which messages of a conversation are queued, being
 * answered, answered or removed — or steered into the chat's running turn and read there — and
 * whether the queue is paused, all from the thread's own append-only log. The chat shows waiting messages from it, and the core words a restart notice
 * with it.
 *
 * The harness writes these records and keeps its own reader beside its queue
 * (`src/harness-seed/loop/message-queue.ts`), which the app must not load.
 * `tests/conformance/seed-contracts.test.ts` replays the same logs through both readers, so the
 * two cannot drift apart.
 */
import { CustomEvent, customRecord, type CustomEventData } from "./custom-events.ts";
import { EventKind } from "./event-log.ts";

/**
 * Where a queued message stands. `steering`: handed to the chat's running turn and not read yet;
 * `delivered`: read by that turn, which answers it (it never gets a turn of its own). Written to
 * the log: never rename a value.
 */
export const QueueState = {
  Queued: "queued",
  Processing: "processing",
  Handled: "handled",
  Removed: "removed",
  Steering: "steering",
  Delivered: "delivered",
} as const;
export type QueueState = (typeof QueueState)[keyof typeof QueueState];
/** Every state, for the contract test that holds the harness's reader to this one. */
export const QUEUE_STATES: readonly QueueState[] = Object.values(QueueState);

/**
 * How a steered message reached the session answering the chat (`coordinator_message_delivered`
 * `how`, and the host's `engine.steer` answer): in the prompt the session was about to read, read
 * mid-turn by an engine that takes input, or by interrupting the session and resuming it with the
 * message in front — or, sent while a run's lead works, handed to that lead (`lead`: `into` is
 * its run, and the lead answers it in the chat). Persisted in the log: never rename a value. The
 * seed's copy is `loop/steer-delivery.ts`.
 */
export const SteerDelivery = {
  Prompt: "prompt",
  Native: "native",
  Interrupt: "interrupt",
  Lead: "lead",
} as const;
export type SteerDelivery = (typeof SteerDelivery)[keyof typeof SteerDelivery];

/** The log records that move a message between states, and pause or resume the queue. */
export const QUEUE_EVENTS = {
  queued: CustomEvent.CoordinatorMessageQueued,
  updated: CustomEvent.CoordinatorMessageUpdated,
  processing: CustomEvent.CoordinatorMessageProcessing,
  requeued: CustomEvent.CoordinatorMessageRequeued,
  handled: CustomEvent.CoordinatorMessageHandled,
  removed: CustomEvent.CoordinatorMessageRemoved,
  steering: CustomEvent.CoordinatorMessageSteering,
  delivered: CustomEvent.CoordinatorMessageDelivered,
  paused: CustomEvent.CoordinatorQueuePaused,
  resumed: CustomEvent.CoordinatorQueueResumed,
} as const;

/** What the composer queued: the text plus whatever else it sent with it. */
export type QueuedAction = { text?: string } & Record<string, unknown>;

export interface QueuedMessage {
  messageId: string;
  /** The `messages` record that carries the user's words, when there is one. */
  eventId: string | null;
  action: QueuedAction | undefined;
  state: QueueState;
  /** How many times an answer to it began. */
  attempts?: number;
  /** Steered or delivered: the message whose turn it joined. */
  into?: string;
}

export interface QueueView {
  paused: boolean;
  messages: Map<string, QueuedMessage>;
}

type QueueRecord = { readonly id: string; readonly data: CustomEventData };

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const action = (value: unknown): QueuedAction | undefined =>
  value && typeof value === "object" ? (value as QueuedAction) : undefined;

/** The queue a conversation's log describes, in the order its messages were queued. */
export function messageQueueState(events: readonly QueueRecord[]): QueueView {
  const messages = new Map<string, QueuedMessage>();
  let paused = false;
  for (const [i, event] of events.entries()) {
    const custom = customRecord(event.data);
    if (!custom) continue;
    const { event_type, payload: p } = custom;
    if (event_type === QUEUE_EVENTS.paused) paused = true;
    if (event_type === QUEUE_EVENTS.resumed) paused = false;
    const messageId = p.messageId;
    if (event_type === QUEUE_EVENTS.queued && messageId)
      messages.set(String(messageId), queuedMessage(String(messageId), p, events[i - 1]));
    const addressable = typeof messageId === "string" || typeof messageId === "number";
    const message = addressable ? messages.get(String(messageId)) : undefined;
    if (message) applyToMessage(message, event_type, p);
  }
  return { paused, messages };
}

/** A newly queued message, bound to the user's words when the record before it carries them. */
function queuedMessage(messageId: string, p: Record<string, unknown>, before: QueueRecord | undefined): QueuedMessage {
  const eventId = text(p.eventId) ?? (before?.data.type === EventKind.Messages ? before.id : null);
  return { messageId, eventId, action: action(p.action), state: QueueState.Queued };
}

/** What one queue record does to the message it names: an edit, an answer starting, or a settle. */
function applyToMessage(message: QueuedMessage, event_type: string, p: Record<string, unknown>): void {
  if (event_type === QUEUE_EVENTS.updated) message.action = { ...message.action, text: p.text as string | undefined };
  if (event_type === QUEUE_EVENTS.processing) {
    message.state = QueueState.Processing;
    message.attempts = (message.attempts ?? 0) + 1;
  }
  if (event_type === QUEUE_EVENTS.requeued) {
    message.state = QueueState.Queued;
    delete message.into;
  }
  if (event_type === QUEUE_EVENTS.handled) message.state = QueueState.Handled;
  if (event_type === QUEUE_EVENTS.removed) message.state = QueueState.Removed;
  if (event_type === QUEUE_EVENTS.steering || event_type === QUEUE_EVENTS.delivered)
    steerMessage(message, event_type, p);
}

/**
 * Steer: handed to the chat's running turn, then read by it (`into` is the message that turn
 * answers). A delivered message is answered by the turn it joined; it never gets one of its own.
 */
function steerMessage(message: QueuedMessage, event_type: string, p: Record<string, unknown>): void {
  const into = text(p.into);
  message.state = event_type === QUEUE_EVENTS.steering ? QueueState.Steering : QueueState.Delivered;
  if (into) message.into = into;
  else if (message.state === QueueState.Steering) delete message.into;
}

/**
 * A message is answered at most this many times: once, plus one retry after a restart cut its
 * answer off. A second interruption settles it instead (the user may have quit to stop it).
 */
export const MESSAGE_ATTEMPTS = 2;

/**
 * What the chat says about a reply a restart cut off, from the thread's log before boot: whether
 * the message being answered will be retried, or was retried already and will not be. `null`
 * when no message was being answered; the caller keeps its own words then.
 */
export function interruptedReplyNotice(events: readonly QueueRecord[]): string | null {
  const answering = [...messageQueueState(events).messages.values()].filter(
    (m) => m.state === QueueState.Processing && m.action,
  );
  if (!answering.length) return null;
  return answering.some((m) => (m.attempts ?? 1) < MESSAGE_ATTEMPTS)
    ? "This response was interrupted by a restart. Studio will retry this message."
    : "This response was interrupted by a restart again, so Studio will not retry it. Send it again to continue.";
}
