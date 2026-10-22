import { PlanReviewState } from "../../shared/composer.ts";
import { CustomEvent, customPayload } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { QueueState } from "../../shared/message-queue.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { EventEnvelope } from "../types.ts";

/** Where a sent message first shows: at the end of the conversation, or waiting below current work. */
export const SendPlacement = { Transcript: "transcript", Waiting: "waiting" } as const;
export type SendPlacement = (typeof SendPlacement)[keyof typeof SendPlacement];

/** A message the composer just sent, shown before its durable row reaches the chat. */
export interface PendingSend {
  /** Also the queue's message id, so the durable row is matched exactly. */
  clientId: string;
  threadId: string;
  text: string;
  /** Newest event of the chat when it was sent: its durable row can only come after this. */
  after: string | null;
  placement: SendPlacement;
  /** The pictures attached to it, shown above it as its durable row will show them. */
  frames?: ReferenceFrame[];
  /** When the send was acknowledged; its row may still be on the way. */
  settledAt?: number;
  /** When its bubble began to show (`performance.now()`): its saved row carries the opening on. */
  shownAt?: number;
}

interface QueueMessage {
  messageId: string;
  eventId: string | null;
  state: QueueState;
}
interface QueueView {
  paused: boolean;
  messages: ReadonlyMap<string, QueueMessage>;
}

/** Queue states that mean the chat has input to answer before a new message (a steered one being handed in, too). */
const PENDING_STATES: ReadonlySet<QueueState> = new Set<QueueState>([
  QueueState.Queued,
  QueueState.Steering,
  QueueState.Processing,
]);
/** How a note sent to a build is stored: the harness reads this prefix (reply-about.ts). */
const FEEDBACK_PREFIX = "[USER FEEDBACK] ";

/** An id the queue accepts (`[\w-]{1,80}`); `crypto.randomUUID` needs a secure context. */
export function newClientId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0"));
  return `msg_${Date.now().toString(36)}_${random.join("")}`;
}

/** How long an acknowledged send may wait for its row before the placeholder gives way. */
export const PENDING_SEND_GRACE_MS = 10 * SECOND_MS;

/** What a slash command starts with: words to the chat's session, never to a build's lead. */
const SLASH = "/";

/**
 * Whether a running build's lead takes this send at once, as the harness hands one over (the
 * seed's `loop/live-chat.ts` `forTheLead`): anything but a slash command, to a lead that takes the
 * chat. Pictures go too: the chat saves them in the game for the lead. Not after Finish: the lead's
 * line shuts as the build lands, with no record the chat could read, so such a send waits below.
 */
export function leadTakesSend(text: string, lead: { listens: boolean; finishing: boolean }): boolean {
  return lead.listens && !lead.finishing && !text.trim().startsWith(SLASH);
}

/**
 * Whether a send waits below what is under way: the chat's own work, or a running build that does
 * not take it at once. One the build's lead takes at once joins the conversation above the
 * build's card, as one to an idle chat does.
 */
export function waitsBehindWork(work: { chatWorking: boolean; runId: string | null; leadTakes: boolean }): boolean {
  return work.chatWorking || (work.runId !== null && !work.leadTakes);
}

/** A follow-up waits below the current work; an idle chat answers at once. */
export function sendPlacement(working: boolean, queue: QueueView): SendPlacement {
  if (working || queue.paused) return SendPlacement.Waiting;
  for (const message of queue.messages.values()) if (PENDING_STATES.has(message.state)) return SendPlacement.Waiting;
  return SendPlacement.Transcript;
}

const userIndex = (event: EventEnvelope): number =>
  event.data.type === EventKind.Messages ? event.data.messages.findIndex((message) => message.role === "user") : -1;

/** The transcript's id for the user bubble of a `messages` event (chat-entries.ts). */
export const userEntryId = (event: EventEnvelope): string | null => {
  const index = userIndex(event);
  return index < 0 ? null : `${event.id}-${index}:user`;
};

/** Whether a `messages` event carries these words from the user, as sent or as a note to the build. */
function saysText(event: EventEnvelope, text: string): boolean {
  if (event.data.type !== EventKind.Messages) return false;
  return event.data.messages.some(
    (message) => message.role === "user" && [text, `${FEEDBACK_PREFIX}${text}`].includes(message.content.trim()),
  );
}

const newerThan = (event: EventEnvelope, after: string | null): boolean => !after || event.id > after;

/** What a reconcile pass shares: the rows, the queue's own rows, and what earlier sends claimed. */
interface Matching {
  events: readonly EventEnvelope[];
  byId: ReadonlyMap<string, EventEnvelope>;
  queue: QueueView;
  queued: ReadonlySet<string>;
  claimed: Set<string>;
  taken: ReadonlySet<string>;
}

/**
 * The entry id of a send's durable row: the row the queue recorded under its id, else (a row
 * written without the queue) the first unclaimed newer row with its words.
 */
function durableEntry(send: PendingSend, match: Matching): string | null {
  const recorded = match.queue.messages.get(send.clientId);
  const exact = recorded?.eventId ? match.byId.get(recorded.eventId) : undefined;
  if (exact) return userEntryId(exact);
  if (recorded) return null;
  const text = send.text.trim();
  const loose = match.events.find(
    (event) =>
      newerThan(event, send.after) &&
      !match.queued.has(event.id) &&
      !match.claimed.has(event.id) &&
      !match.taken.has(userEntryId(event) ?? "") &&
      saysText(event, text),
  );
  if (!loose) return null;
  match.claimed.add(loose.id);
  return userEntryId(loose);
}

/**
 * Main routed it to plan review after all: its request shows in the plan, not as a bubble. Only
 * a plan this send asked for counts (its request ends with the send's words, or has none when the
 * send was pictures alone).
 */
function wentToPlanReview(send: PendingSend, events: readonly EventEnvelope[]): boolean {
  const text = send.text.trim();
  return events.some((event) => {
    if (!newerThan(event, send.after)) return false;
    const review = customPayload(event.data, CustomEvent.PlanReview);
    if (review?.state !== PlanReviewState.Generating) return false;
    const request = String(review.text ?? "").trim();
    return text ? request.endsWith(text) : request === "";
  });
}

/**
 * Pairs each placeholder with its durable row, in the render that row first appears. The queue
 * records the message under the placeholder's id; a row written without the queue (an older
 * harness, or a send the host refused after saving the text) is matched by its text instead.
 */
export function reconcilePendingSends(
  pending: readonly PendingSend[],
  events: readonly EventEnvelope[],
  queue: QueueView,
  now: number,
  /** Rows already adopted by earlier placeholders (entry ids): never matched again by text. */
  taken: ReadonlySet<string> = new Set(),
): {
  shown: PendingSend[];
  /** clientId → transcript entry id of the durable row. */
  adopted: Map<string, string>;
  /** Acknowledged sends whose row will not come as a user message (plan review) or never came. */
  expired: string[];
} {
  const queued = new Set<string>();
  for (const message of queue.messages.values()) if (message.eventId) queued.add(message.eventId);
  const match: Matching = {
    events,
    byId: new Map(events.map((event) => [event.id, event])),
    queue,
    queued,
    claimed: new Set(),
    taken,
  };
  const adopted = new Map<string, string>();
  const expired: string[] = [];
  const shown: PendingSend[] = [];
  for (const send of pending) {
    const entry = durableEntry(send, match);
    if (entry) {
      adopted.set(send.clientId, entry);
      continue;
    }
    const overdue = send.settledAt !== undefined && now - send.settledAt > PENDING_SEND_GRACE_MS;
    if (overdue || wentToPlanReview(send, events)) expired.push(send.clientId);
    else shown.push(send);
  }
  return { shown, adopted, expired };
}
