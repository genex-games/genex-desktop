/**
 * What the chat's analytics keeps in memory for one launch, to pair what happens with what answers
 * it: a send with its queue wait and first token, a card with its answer, a Stop with the end of the
 * work it stopped, a rewind with the next send. Ids and words stay here, and nothing here is
 * persisted; only the durations, counts and flags worked out from it leave (`events/chat.ts`).
 */
import type { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import type { EngineKind } from "../../shared/engine-descriptor.ts";
import type { EngineFailureKind } from "../../shared/engine-requests.ts";
import type { SendPlacement } from "../chat/pending-sends.ts";
import type { WaitingCardKind } from "./chat-vocabulary.ts";
import { elapsedMs } from "./properties.ts";

/** A send within this long of a Stop in its chat is `after_stop`. */
export const AFTER_STOP_MS = 30 * SECOND_MS;
/** A model picked within this long of a failed or limited turn, or a failed plan, is `after_failure`. */
export const AFTER_FAILURE_MS = 5 * MINUTE_MS;
/** A Stop whose work has not recorded its end after this long is forgotten, not settled. */
export const STOP_SETTLE_MAX_MS = 10 * MINUTE_MS;

/** A message on its way, by the composer's client id (the queue's message id). */
export interface SentMessage {
  thread: string;
  at: number;
  placement?: SendPlacement;
  engine: string;
}

/** The reply a chat waits for since its oldest unanswered send. */
export interface AwaitingReply {
  at: number;
  engine: string;
  engineKind?: EngineKind;
  firstInGame: boolean;
  processingAt?: number;
  activityAt?: number;
  phase?: ChatActivityPhase;
  /** The stream already under way when it was sent: its words answer an earlier message. */
  staleStream?: string;
}

/** A chat turn under way: when it began, on which engine, and what it went through. */
export interface OpenTurn {
  at: number;
  engine: string;
  failure?: string;
  streamed: boolean;
  streamFailed: boolean;
}

/** A card waiting on the person, by its request or consent id (or `question:` / `plan:` keys). */
export interface OpenCard {
  thread: string;
  kind: WaitingCardKind;
  at: number;
}

/** A plan review's progress: when its plan began being written, and how many times. */
export interface PlanProgress {
  thread: string;
  generatingAt?: number;
  waitingAt?: number;
  revisions: number;
}

/** Everything one launch pairs. Maps are keyed by ids that never leave. */
export interface ChatMemory {
  sends: Map<string, SentMessage>;
  replies: Map<string, AwaitingReply>;
  turns: Map<string, OpenTurn>;
  /** Chats whose reply is streaming now, and that stream. */
  streams: Map<string, string>;
  /** Chats with a Stop acted on and not yet settled, and when. */
  stops: Map<string, number>;
  /** Each chat's last Stop, for `after_stop`. */
  stoppedAt: Map<string, number>;
  /** Chats rewound since their last send. */
  rewound: Set<string>;
  cards: Map<string, OpenCard>;
  /** Chats whose open question the person answered (by a choice or in their own words). */
  answered: Set<string>;
  plans: Map<string, PlanProgress>;
  /** Messages being steered into a running turn, and since when. */
  steering: Map<string, number>;
  /** Each chat's last context percent. */
  context: Map<string, number>;
  /** Each engine's kind, from the engines store. */
  engineKinds: Map<string, EngineKind>;
  /** The last turn that failed or hit a limit, or plan that failed. */
  lastFailureAt: number | null;
  /** How each chat's last turn's engine failed, until its message is handled. */
  turnFailures: Map<string, EngineFailureKind>;
  /** Presses on a dead Send since the last message that went. */
  blockedInRow: number;
  /** The composer that just sent, and how many files it attached (they reach the chat as links in the words). */
  composed: { conversation: string | undefined; files: number } | null;
}

/** An empty memory. */
export function createChatMemory(): ChatMemory {
  return {
    sends: new Map(),
    replies: new Map(),
    turns: new Map(),
    streams: new Map(),
    stops: new Map(),
    stoppedAt: new Map(),
    rewound: new Set(),
    cards: new Map(),
    answered: new Set(),
    plans: new Map(),
    steering: new Map(),
    context: new Map(),
    engineKinds: new Map(),
    lastFailureAt: null,
    turnFailures: new Map(),
    blockedInRow: 0,
    composed: null,
  };
}

/** This launch's memory, shared by the chat's observers and the hooks that send its events. */
export const chatMemory: ChatMemory = createChatMemory();

/** The card key of a chat's open question. */
export const questionKey = (thread: string): string => `question:${thread}`;
/** The card key of a plan review. */
export const planKey = (review: string): string => `plan:${review}`;

/** The cards waiting in a chat, oldest first. */
export function openCards(memory: ChatMemory, thread: string): OpenCard[] {
  return [...memory.cards.values()].filter((card) => card.thread === thread).sort((a, b) => a.at - b.at);
}

/** How long a card has waited, when it was seen arriving. */
export function cardWait(memory: ChatMemory, key: string, now: number): number | undefined {
  const card = memory.cards.get(key);
  return card ? elapsedMs(card.at, now) : undefined;
}

/** A Stop acted on in a chat: settled by the end of its work, and the next send is `after_stop`. */
export function noteStop(memory: ChatMemory, thread: string, at: number): void {
  memory.stops.set(thread, at);
  memory.stoppedAt.set(thread, at);
}

/** Whether a chat's last Stop was within `AFTER_STOP_MS`. */
export function stoppedRecently(memory: ChatMemory, thread: string, now: number): boolean {
  const at = memory.stoppedAt.get(thread);
  return at !== undefined && now - at <= AFTER_STOP_MS;
}

/** Whether a turn failed or hit a limit, or a plan failed, within `AFTER_FAILURE_MS`. */
export function failedRecently(memory: ChatMemory, now: number): boolean {
  return memory.lastFailureAt !== null && now - memory.lastFailureAt <= AFTER_FAILURE_MS;
}

/** A rewind put a chat's words back: its next send is `after_rewind`. */
export function noteRewound(memory: ChatMemory, thread: string): void {
  memory.rewound.add(thread);
}

/** Whether a chat was rewound since its last send; reading it clears it. */
export function takeRewound(memory: ChatMemory, thread: string): boolean {
  return memory.rewound.delete(thread);
}

/** Another press on a dead Send; returns how many in a row. */
export function noteBlocked(memory: ChatMemory): number {
  memory.blockedInRow += 1;
  return memory.blockedInRow;
}

/**
 * A message went: kept for its queue wait and reply (by its client id when the chat shows its
 * bubble), and the dead-Send count starts again.
 */
export function rememberSend(
  memory: ChatMemory,
  send: { clientId?: string | undefined; reply: AwaitingReply & { thread: string }; placement?: SendPlacement },
): void {
  const { clientId, reply, placement } = send;
  memory.blockedInRow = 0;
  if (clientId)
    memory.sends.set(clientId, {
      thread: reply.thread,
      at: reply.at,
      engine: reply.engine,
      ...(placement ? { placement } : {}),
    });
  if (memory.replies.has(reply.thread)) return;
  const { thread: _thread, ...awaiting } = reply;
  memory.replies.set(reply.thread, awaiting);
}

/** A composer is sending, with this many files attached. */
export function noteComposed(memory: ChatMemory, conversation: string | undefined, files: number): void {
  memory.composed = { conversation, files };
}

/** The files the chat's own composer attached to the message it is sending now (0 for any other send). */
export function takeComposedFiles(memory: ChatMemory, conversation: string): number {
  const composed = memory.composed;
  memory.composed = null;
  return composed?.conversation === conversation ? composed.files : 0;
}

/** The person answered a chat's open question: its close is an answer, not a card left unanswered. */
export function noteQuestionAnswered(memory: ChatMemory, thread: string): void {
  if (memory.cards.has(questionKey(thread))) memory.answered.add(thread);
}
