/**
 * The open chat's transcript, split the way the panel draws it: what it reads (the conversation),
 * what waits on the user (consents and intake questions) and the follow-ups still in the queue.
 */
import { useMemo } from "react";
import type { EventEnvelope } from "../../shared/event-log.ts";
import { type QueuedMessage, QueueState, type QueueView } from "../../shared/message-queue.ts";
import { EntryKind } from "../chat-entries.ts";
import type { ConversationEntry } from "./conversation-entries.ts";
import { toldToLead } from "./delivery-order.ts";
import {
  chatReportEntryIds,
  isPendingConsent,
  isPendingPermission,
  isPendingQuestion,
  sentImages,
  transcriptEntries,
} from "./transcript.ts";

/** A card still waiting on the user: a permission or a question, which the composer holds instead. */
const asksTheUser = (entry: ConversationEntry): boolean =>
  isPendingConsent(entry) || isPendingPermission(entry) || isPendingQuestion(entry);

/** A queued follow-up's bubble is keyed by the id of the entry its event became. */
const queuedEntryId = (message: QueuedMessage): string => `${message.eventId}-0:user`;

/**
 * A message that waits below the work, reading Sending… until that work reads it. One queued to
 * an idle chat keeps its place at the end of the conversation for a moment instead
 * (`holdsInPlace`), unless the queue is paused; a steered one is never held: it reads where that
 * turn reads it.
 */
function waitsBelow(
  message: QueuedMessage,
  queue: QueueView & { told?: ReadonlySet<string> },
  holdsInPlace: (messageId: string) => boolean,
): boolean {
  if (message.state === QueueState.Steering) return true;
  // Told to a build's lead in its wrap-up: it reads where the lead heard it (`toldToLead`), never below.
  if (queue.told?.has(message.messageId)) return false;
  return message.state === QueueState.Queued && (queue.paused || !holdsInPlace(message.messageId));
}

/** A user message that is still a queued follow-up, not yet delivered. */
const isQueued = (entry: ConversationEntry, queuedByEvent: ReadonlyMap<string, QueuedMessage>): boolean =>
  entry.kind === EntryKind.User && queuedByEvent.has(entry.id);

export interface ThreadTranscript {
  entries: ConversationEntry[];
  /** The chat's follow-up queue, read from its log. */
  queue: QueueView;
  /** Waiting follow-ups (queued, or being handed to the running turn) by their transcript entry id. */
  queuedByEvent: Map<string, QueuedMessage>;
  /** Pictures sent with a message, by its entry id. */
  imagesByEntry: ReturnType<typeof sentImages>;
  /** Plugin consent questions waiting on the user. */
  pendingConsents: ConversationEntry[];
  /** Claude's own permission questions (and plans to approve) waiting on the user. */
  pendingPermissions: ConversationEntry[];
  /** Intake questions waiting on the user. */
  interviewQuestions: ConversationEntry[];
  /** Follow-ups not yet delivered, in the order they were sent. */
  waitingEntries: ConversationEntry[];
  /** The conversation as read: everything but what waits. */
  readingEntries: ConversationEntry[];
}

export function useThreadTranscript(input: {
  events: EventEnvelope[];
  stateEvents: EventEnvelope[];
  threadEvents: EventEnvelope[];
  queue: QueueView;
  /** A just-sent message that keeps its place in the conversation for now (`usePendingSends`). */
  holdsInPlace: (messageId: string) => boolean;
  activeRunId: string | null;
  studio: boolean;
}): ThreadTranscript {
  const { events, stateEvents, threadEvents, queue, holdsInPlace, activeRunId, studio } = input;
  const told = useMemo(() => toldToLead(threadEvents, queue.messages), [threadEvents, queue]);
  const queuedByEvent = useMemo(
    () =>
      new Map(
        [...queue.messages.values()]
          .filter((m) => waitsBelow(m, { ...queue, told }, holdsInPlace))
          .map((m) => [queuedEntryId(m), m] as const),
      ),
    [queue, told, holdsInPlace],
  );
  // Pictures sent with a message were saved beside it for the agent; the bubble shows them too.
  const imagesByEntry = useMemo(() => sentImages(queue.messages.values()), [queue]);
  const entries = useMemo(() => {
    // What the chat wrote itself (a command's result) went to the agent; it is not the user's bubble.
    const reports = chatReportEntryIds(queue.messages.values());
    return transcriptEntries({
      events,
      stateEvents,
      threadEvents,
      queued: queue.messages.values(),
      queue,
      activeRunId,
      studio,
    }).filter((entry) => !reports.has(entry.id));
  }, [events, stateEvents, threadEvents, queue, activeRunId, studio]);
  const pendingConsents = useMemo(() => entries.filter(isPendingConsent), [entries]);
  const pendingPermissions = useMemo(() => entries.filter(isPendingPermission), [entries]);
  const interviewQuestions = useMemo(() => entries.filter(isPendingQuestion), [entries]);
  // Follow-ups that have not been delivered wait below the current work, in the order they were sent.
  const waitingEntries = useMemo(
    () => entries.filter((entry) => isQueued(entry, queuedByEvent)),
    [entries, queuedByEvent],
  );
  const readingEntries = useMemo(
    () => entries.filter((entry) => !asksTheUser(entry) && !isQueued(entry, queuedByEvent)),
    [entries, queuedByEvent],
  );
  return {
    entries,
    queue,
    queuedByEvent,
    imagesByEntry,
    pendingConsents,
    pendingPermissions,
    interviewQuestions,
    waitingEntries,
    readingEntries,
  };
}
