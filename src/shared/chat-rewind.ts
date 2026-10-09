import { compareIds } from "./compare-ids.ts";
/**
 * Rewinding a chat withdraws a user message and everything after it. The log is append-only,
 * so a rewind is a projection over it: the rows stay on disk, and the chat, the model's
 * context and the harness read the log without them.
 */
import { APPROVED_PLAN_HEADING } from "./composer.ts";
import { CustomEvent, customRecord, DELEGATED_PREFIX } from "./custom-events.ts";
import { type EventEnvelope, EventKind } from "./event-log.ts";
import { messageQueueState, QueueState, type QueuedMessage } from "./message-queue.ts";
import { isExecutionEvent, RUN_START_EVENTS } from "./run-state.ts";

/** The marker a rewind appends to the chat it rewound. */
export const REWOUND_EVENT = CustomEvent.ConversationRewound;

/** One rewind: the rows it withdrew from the conversation. */
export interface ChatRewind {
  /** The queue id of the message the chat was rewound to (it left too). */
  messageId: string;
  /** That message's processing moment: every row from here through `through` left. */
  from: string;
  /** The newest row when the chat was rewound. */
  through: string;
  /** Earlier rows of the withdrawn input: the message itself and input sent after it. */
  hide: string[];
  /**
   * Rows in the range that stay: each settles something begun before it (a message's answer, a
   * turn, a build, a question, a background job) or starts a job still running, which would
   * otherwise read as open for good. Absent on rewinds
   * made before a rewind could cross a build.
   */
  keep?: string[];
}

/**
 * Rows that never belonged to the conversation: bookkeeping, the queue's hold (state, not
 * words), what a build observed (Studio still learns from it) and the rewinds themselves.
 */
const KEPT_CUSTOM = new Set<string>([
  REWOUND_EVENT,
  CustomEvent.CoordinatorQueuePaused,
  CustomEvent.CoordinatorQueueResumed,
  CustomEvent.BuildObservation,
]);

/** A custom row's name, or null for any other row. */
const customType = (event: EventEnvelope): string | null => customRecord(event.data)?.event_type ?? null;

function kept(event: EventEnvelope): boolean {
  const { type } = event.data;
  if (type === EventKind.ThreadUpdated || type === EventKind.ArtifactWritten) return true;
  return KEPT_CUSTOM.has(customType(event) ?? "");
}

/** The ids in a stored list, whatever else it holds. */
const idsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

function asRewind(value: unknown): ChatRewind | null {
  const r = value as Partial<ChatRewind> | null;
  if (!r || typeof r.from !== "string" || typeof r.through !== "string" || typeof r.messageId !== "string") return null;
  const keep = idsIn(r.keep);
  return {
    messageId: r.messageId,
    from: r.from,
    through: r.through,
    hide: idsIn(r.hide),
    ...(keep.length ? { keep } : {}),
  };
}

/** Every rewind of a chat, from its markers and from the thread record's index of them. */
export function rewindsOf(events: readonly EventEnvelope[], metadata?: unknown): ChatRewind[] {
  const found = new Map<string, ChatRewind>();
  const add = (value: unknown) => {
    const rewind = asRewind(value);
    if (rewind) found.set(`${rewind.from}|${rewind.through}`, rewind);
  };
  const indexed = (metadata as { rewinds?: unknown } | null | undefined)?.rewinds;
  if (Array.isArray(indexed)) for (const value of indexed) add(value);
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.event_type === REWOUND_EVENT) add(custom.payload);
  }
  return [...found.values()];
}

export function isRewound(event: EventEnvelope, rewinds: readonly ChatRewind[]): boolean {
  return !kept(event) && withdrawnId(event.id, rewinds);
}

/** By id alone (a history page picks files before reading them); bookkeeping rows go too. */
export function withdrawnId(id: string, rewinds: readonly ChatRewind[]): boolean {
  return rewinds.some(
    (rewind) => (id >= rewind.from && id <= rewind.through && !rewind.keep?.includes(id)) || rewind.hide.includes(id),
  );
}

export function withoutRewound<T extends EventEnvelope>(events: readonly T[], rewinds: readonly ChatRewind[]): T[] {
  return rewinds.length ? events.filter((event) => !isRewound(event, rewinds)) : [...events];
}

/**
 * The log as the harness reads it. A resumed provider session keeps its id and still holds the
 * rewound turns, so every session recorded before a rewind is forgotten there: the next turn
 * starts a fresh one from the conversation that remains. A handover or a log summary is a new
 * start the same way: the next turn opens a fresh session briefed with it instead of resuming the
 * whole history. The provider's own compaction is not (`endsChatSessions`). The sessions a run
 * mirrors into the chat are never the chat's to resume, rewound or not.
 */
export function harnessView<T extends EventEnvelope>(events: readonly T[], rewinds: readonly ChatRewind[]): T[] {
  const kept = withoutRewound(events, rewinds);
  const rewound = rewinds.reduce((latest, rewind) => (rewind.through > latest ? rewind.through : latest), "");
  const compacted = kept.findLast((event) => endsChatSessions(event.data))?.id ?? "";
  const boundary = compacted > rewound ? compacted : rewound;
  return kept.map((event) => withoutSession(event, event.id <= boundary));
}

/**
 * Does this record end the chat's provider sessions? A compaction the harness wrote (a session's
 * handover, a log summary) does: the next turn starts fresh, briefed with it. The provider's own
 * compaction (`native`) does not: it compacted the session in place, and the next turn resumes
 * it. The seed's copy is loop/compaction-log.ts `endsSessions`.
 */
export function endsChatSessions(data: EventEnvelope["data"]): boolean {
  const custom = customRecord(data);
  return custom?.event_type === CustomEvent.Compacted && custom.payload.native !== true;
}

/** The chat's own sessions: a rewind forgets the ones recorded before it. */
const CHAT_SESSIONS = new Set<string>([CustomEvent.ContractorSession, CustomEvent.DelegationIncomplete]);

/**
 * Drops the session ids a chat turn would resume. Before a rewind, all of them; always, the ones
 * a run's director, builders, scout or coordinator mirrored into the chat: those sessions work
 * elsewhere, and a chat that resumed one would carry on the run's conversation as its own.
 */
function withoutSession<T extends EventEnvelope>(event: T, rewound: boolean): T {
  const custom = customRecord(event.data);
  if (!custom) return event;
  const { event_type, payload } = custom;
  if (rewound && CHAT_SESSIONS.has(event_type) && payload.sessionId) {
    const { sessionId: _session, ...rest } = payload;
    return { ...event, data: { ...event.data, payload: rest } };
  }
  const inner = payload.data as Record<string, unknown> | undefined;
  const mirrored = (rewound || payload.runId) && event_type.startsWith(DELEGATED_PREFIX) && payload.kind === "system";
  if (mirrored && inner && (inner.session_id || inner.sessionId)) {
    const { session_id: _id, sessionId: _alias, ...rest } = inner;
    return { ...event, data: { ...event.data, payload: { ...payload, data: rest } } };
  }
  return event;
}

/** Why a chat cannot be rewound to a message. */
export const RewindRefusal = {
  NotFound: "not-found",
  NotAnswered: "not-answered",
  Busy: "busy",
} as const;
export type RewindRefusal = (typeof RewindRefusal)[keyof typeof RewindRefusal];

const REFUSAL_WORDS: Record<RewindRefusal, string> = {
  [RewindRefusal.NotFound]: "That message is no longer in this chat.",
  [RewindRefusal.NotAnswered]: "That message hasn’t been answered yet.",
  [RewindRefusal.Busy]: "Wait for this chat to finish, or press Stop, before rewinding.",
};

export function rewindRefusalWords(reason: RewindRefusal): string {
  return REFUSAL_WORDS[reason];
}

/**
 * Why only the conversation rewinds: the game files cannot go back to just before the message.
 * The first three come from the checkpoint (`main/chat-checkpoints.ts`), the rest from the chat.
 */
export const FilesStay = {
  NoCheckpoint: "no-checkpoint",
  /** HEAD moved since the checkpoint: a commit. */
  HistoryChanged: "history-changed",
  TooLarge: "too-large",
  /** A build after the message landed, or moved the game's history. */
  BuildChanged: "build-changed",
  /** A build is running: the rewind stops it first, and what it leaves stays. */
  BuildRunning: "build-running",
  /** The message joined an answer already under way: no checkpoint was taken just before it. */
  JoinedAnswer: "joined-answer",
} as const;
export type FilesStay = (typeof FilesStay)[keyof typeof FilesStay];

/** What happens to the game files when the chat is rewound to a message. */
export type RewindFiles =
  | {
      state: "restore";
      files: number;
      /** Changed since then by something other than this chat's answers (you, an editor, a delivery). */
      outside: string[];
      /** A later answer left no checkpoint, so such changes cannot be told apart. */
      outsideUnknown: boolean;
      /** Changed files too large to have been saved: they stay as they are. */
      tooLarge: number;
      /** Those files by path, present only when there are any. */
      tooLargeFiles?: string[];
      /** Nested repositories keep their own history; their files stay as they are. */
      nested: string[];
    }
  | { state: "unchanged"; nested: string[] }
  /** `tooLargeFiles` names the changed files when they were all too large to save (`FilesStay.TooLarge`). */
  | { state: "unavailable"; reason: FilesStay; tooLargeFiles?: string[] }
  | { state: "none" };
/** What left files too large to save out: a chat checkpoint, or a rewind that left them as they were. */
export const SkippedBy = {
  Checkpoint: "checkpoint",
  Rewind: "rewind",
} as const;
export type SkippedBy = (typeof SkippedBy)[keyof typeof SkippedBy];

/** One file too large to save, and its size when it was reported (0 when it was gone). */
export interface SkippedFile {
  file: string;
  bytes: number;
}

/**
 * The `checkpoint_skipped` record: files too large to save, so Rewind cannot bring them back.
 * Every field is optional: a partial record says nothing.
 */
export interface CheckpointSkippedPayload {
  project?: string;
  /** The queue id of the message whose checkpoint, or rewind, left them. */
  messageId?: string;
  by?: SkippedBy;
  /** The files, largest first (at most `CHECKPOINT_SKIPPED_FILES_LISTED` of them). */
  files?: SkippedFile[];
  /** How many files were left in all, when more than `files` lists. */
  total?: number;
  /** A single file larger than this is never saved. */
  fileLimitBytes?: number;
  /** New or changed content one checkpoint saves at most; the largest files past it are left. */
  changeLimitBytes?: number;
}

/** How many of the files a `checkpoint_skipped` record lists by name; `total` counts the rest. */
export const CHECKPOINT_SKIPPED_FILES_LISTED = 50;

export interface RewindPreview {
  files: RewindFiles;
  /** A build is running: confirming stops it first. */
  stopsBuild: boolean;
}
/**
 * What the composer gets back: the message's words (and those of follow-ups that were still
 * waiting), how many pictures it carried and how many of them the composer had attached, and
 * how many game files came back (null when none were asked for).
 */
export interface RewindResult {
  text: string;
  messageId: string;
  imageCount: number;
  pickedImages: number;
  files: number | null;
  /** Waiting follow-ups that left with it and the pictures their composer had attached. */
  held: Array<{ messageId: string; pickedImages: number }>;
}

/** A follow-up waiting in the queue when the chat is rewound: it leaves too, and its words come back. */
export interface HeldFollowUp {
  messageId: string;
  text: string;
  pickedImages: number;
}
export interface PlannedRewind {
  rewind: ChatRewind;
  /** The message's words for the composer: an approved plan gives back only the request. */
  text: string;
  /** Pictures sent with it, and how many of them the composer had attached. */
  imageCount: number;
  pickedImages: number;
  /** Queued follow-ups sent after it, oldest first. */
  held: HeldFollowUp[];
  /** Plan reviews that leave with it (every row of each is withdrawn). */
  reviews: string[];
  /** The answered messages from this one on, oldest first (for telling their file changes apart). */
  answered: string[];
  /** The builds that worked after the message (their rows leave with it unless they began before it). */
  builds: RewindBuild[];
  /** The message joined an answer already under way (read by that turn, or handed to a build's lead). */
  joined: boolean;
  /** The message has a queue record; a bubble without one never had a checkpoint taken before it. */
  queued: boolean;
}
/** A build with rows after the message. Its journal, worktrees and landed work outlive the chat. */
export interface RewindBuild {
  runId: string;
  /** It landed work in the game after the message. */
  landed: boolean;
}
export type RewindPlan = ({ ok: true } & PlannedRewind) | { ok: false; reason: RewindRefusal };

/** An approved plan is sent as the request, the plan and a closing line; the request is the user's. */
export const requestOf = (text: string): string => {
  const at = text.indexOf(APPROVED_PLAN_HEADING);
  return at < 0 ? text : text.slice(0, at);
};

/** What a queued message's saved action says about the pictures it carried. */
interface ImageCounts {
  text?: string;
  imageCount?: number;
  pickedImages?: number;
}
const imageCounts = (message: QueuedMessage): ImageCounts => (message.action ?? {}) as ImageCounts;
/** How many of a message's pictures the composer attached (never more than it carried). */
const attached = ({ pickedImages, imageCount }: ImageCounts): number =>
  Math.min(pickedImages ?? imageCount ?? 0, imageCount ?? 0);

/** A message that has a user bubble, with that bubble's id. */
type Bubbled = QueuedMessage & { eventId: string };
const hasBubble = (message: QueuedMessage): message is Bubbled => Boolean(message.eventId);
const byBubble = (a: Bubbled, b: Bubbled): number => compareIds(a.eventId, b.eventId);

/** Being answered, or being handed to the turn that answers: nothing is rewound under it. */
const ANSWERING: ReadonlySet<QueueState> = new Set<QueueState>([QueueState.Processing, QueueState.Steering]);
/** Answered by a turn of its own, or read by the one it joined: the chat can go back to it. */
const ANSWERED: ReadonlySet<QueueState> = new Set<QueueState>([QueueState.Handled, QueueState.Delivered]);

/** Does this row carry words the user sent (a bubble)? */
const isUserBubble = (event: EventEnvelope): boolean =>
  event.data.type === EventKind.Messages && event.data.messages.some((message) => message.role === "user");

/**
 * A bubble with no queue record (sent before the queue existed, a note to a build from its graph,
 * a seeded chat): it was answered, and it is rewound by its own event id.
 */
function bubbleOnly(events: readonly EventEnvelope[], eventId: string): Bubbled | undefined {
  const bubble = events.find((event) => event.id === eventId);
  if (!bubble || !isUserBubble(bubble)) return undefined;
  return { messageId: eventId, eventId, action: undefined, state: QueueState.Handled };
}

/** The message a rewind names: by its queue id, by its bubble, or the bubble alone. */
function namedMessage(
  events: readonly EventEnvelope[],
  messages: Map<string, QueuedMessage>,
  messageId: string,
): QueuedMessage | undefined {
  const byBubbleId = () => [...messages.values()].find((message) => message.eventId === messageId);
  return messages.get(messageId) ?? byBubbleId() ?? bubbleOnly(events, messageId);
}

/** A named message, with its bubble, while both are still in the chat. */
function stillInChat(
  events: readonly EventEnvelope[],
  rewinds: readonly ChatRewind[],
  target: QueuedMessage | undefined,
): { target: Bubbled; userEvent: EventEnvelope } | null {
  if (!target || !hasBubble(target)) return null;
  if (target.state === QueueState.Removed) return null;
  const userEvent = events.find((event) => event.id === target.eventId);
  return userEvent && !isRewound(userEvent, rewinds) ? { target, userEvent } : null;
}

/** The message a rewind targets, or why it cannot. */
function rewindTarget(
  events: readonly EventEnvelope[],
  rewinds: readonly ChatRewind[],
  messages: Map<string, QueuedMessage>,
  messageId: string,
): { target: Bubbled; userEvent: EventEnvelope } | { reason: RewindRefusal } {
  const found = stillInChat(events, rewinds, namedMessage(events, messages, messageId));
  if (!found) return { reason: RewindRefusal.NotFound };
  if ([...messages.values()].some((message) => ANSWERING.has(message.state))) return { reason: RewindRefusal.Busy };
  if (!ANSWERED.has(found.target.state)) return { reason: RewindRefusal.NotAnswered };
  return found;
}

/** The plan reviews with a row in what leaves: each goes whole. */
function reviewsFrom(events: readonly EventEnvelope[], rewinds: readonly ChatRewind[], from: string): Set<string> {
  const reviews = new Set<string>();
  for (const event of events) {
    if (event.id < from || isRewound(event, rewinds)) continue;
    const id = reviewOf(event);
    if (id) reviews.add(id);
  }
  return reviews;
}

const reviewOf = (event: EventEnvelope): string | undefined => {
  const custom = customRecord(event.data);
  const id = custom?.event_type === CustomEvent.PlanReview ? custom.payload.id : undefined;
  return typeof id === "string" ? id : undefined;
};

/**
 * Earlier rows that leave too: the bubbles and queue records of input sent after the message,
 * and every row of a plan review that reaches into what leaves (a half-withdrawn review would
 * read as still starting, or keep a plan nobody can see).
 */
function hiddenBefore(
  events: readonly EventEnvelope[],
  rewinds: readonly ChatRewind[],
  from: string,
  laterInput: readonly Bubbled[],
  reviews: ReadonlySet<string>,
): string[] {
  const later = new Set(laterInput.map((message) => message.messageId));
  const laterBubbles = new Set(laterInput.map((message) => message.eventId));
  const leaves = (event: EventEnvelope) =>
    laterBubbles.has(event.id) || later.has(queueRecordOf(event) ?? "") || reviews.has(reviewOf(event) ?? "");
  return events
    .filter((event) => event.id < from && !isRewound(event, rewinds) && leaves(event))
    .map((event) => event.id);
}

/** What rewinding to a message withdraws, computed from the raw log and the earlier rewinds. */
export function planRewind(
  events: readonly EventEnvelope[],
  rewinds: readonly ChatRewind[],
  messageId: string,
): RewindPlan {
  const { messages } = messageQueueState(events);
  const found = rewindTarget(events, rewinds, messages, messageId);
  if ("reason" in found) return { ok: false, reason: found.reason };
  const { target, userEvent } = found;
  // The first processing: the bubble reads there, and its checkpoint was taken there. A restart
  // mid-answer processes it again, and the interrupted attempt's rows belong to it too. A message
  // that joined another answer, or has no queue record, goes from its bubble.
  const processed = firstProcessing(events);
  const from = processed.get(target.messageId) ?? target.eventId;
  const through = events.at(-1)?.id ?? from;
  const laterInput = [...messages.values()].filter(hasBubble).filter((message) => message.eventId >= target.eventId);
  const reviews = reviewsFrom(events, rewinds, from);
  const hide = hiddenBefore(events, rewinds, from, laterInput, reviews);
  const keep = keptInRange(events, rewinds, from, leavingMessages(events, from, target, laterInput));
  const counts = imageCounts(target);
  const said = userEvent.data.type === EventKind.Messages ? userWords(userEvent.data.messages) : "";
  return {
    ok: true,
    rewind: { messageId: target.messageId, from, through, hide, ...(keep.length ? { keep } : {}) },
    text: requestOf(counts.text ?? said),
    imageCount: counts.imageCount ?? 0,
    pickedImages: attached(counts),
    held: heldFollowUps(laterInput),
    reviews: [...reviews],
    answered: answeredInOrder(laterInput, processed),
    builds: buildsFrom(events, from),
    joined: target.state === QueueState.Delivered,
    queued: messages.has(target.messageId),
  };
}

/** The messages that leave: this one, input sent after it, and anything queued once it was being answered. */
function leavingMessages(
  events: readonly EventEnvelope[],
  from: string,
  target: Bubbled,
  laterInput: readonly Bubbled[],
): Set<string> {
  const leaving = new Set([target.messageId, ...laterInput.map((message) => message.messageId)]);
  for (const event of events) {
    if (event.id >= from && customType(event) === CustomEvent.CoordinatorMessageQueued) {
      const id = queueRecordOf(event);
      if (id) leaving.add(id);
    }
  }
  return leaving;
}

/** What rows of the range settle, as the walk through it finds them begun. */
interface Begun {
  turns: Set<string>;
  runs: Set<string>;
  questions: Set<string>;
  jobs: Set<string>;
  /** Every job the log records an end for, in the range or not. */
  endedJobs: ReadonlySet<string>;
}

/** A job row's id, or null for any other row. */
function jobIdOf(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType !== CustomEvent.JobStarted && eventType !== CustomEvent.JobEnded) return null;
  return typeof payload.jobId === "string" ? payload.jobId : null;
}

/** The jobs the log records an end for. */
function endedJobs(events: readonly EventEnvelope[]): Set<string> {
  const ended = new Set<string>();
  for (const event of events) {
    const custom = customRecord(event.data);
    const jobId = custom?.event_type === CustomEvent.JobEnded ? jobIdOf(custom.event_type, custom.payload) : null;
    if (jobId) ended.add(jobId);
  }
  return ended;
}

/**
 * The rows of the range that settle something begun before it, and stay: the queue records of
 * messages that stay (the answer a withdrawn message joined), the end of a turn begun before it,
 * a build's lifecycle from before it (the close a rewind's Stop wrote), the answer to a question
 * asked before it, and a background job's end whose start stays. Withdrawn, each would read as
 * open for good: a message the harness answers again, a turn still running, a build running
 * forever, a card waiting on nobody, a job's Stop on work that ended. The start of a job that is
 * still running stays too: a rewind stops only a build's jobs (and waits for their ends), so any
 * other job goes on, and withdrawn it would run with no line and no Stop.
 */
function keptInRange(
  events: readonly EventEnvelope[],
  rewinds: readonly ChatRewind[],
  from: string,
  leaving: ReadonlySet<string>,
): string[] {
  const begun: Begun = {
    turns: new Set(),
    runs: new Set(),
    questions: new Set(),
    jobs: new Set(),
    endedJobs: endedJobs(events),
  };
  return events
    .filter((event) => event.id >= from && !isRewound(event, rewinds) && settlesEarlier(event, leaving, begun))
    .map((event) => event.id);
}

/** Does this row (in the range, in order) settle something begun before the range? */
function settlesEarlier(event: EventEnvelope, leaving: ReadonlySet<string>, begun: Begun): boolean {
  const { data } = event;
  if (data.type === EventKind.TurnStarted || data.type === EventKind.TurnEnded) return endsEarlierTurn(event, begun);
  const custom = customRecord(data);
  if (!custom) return false;
  const message = queueRecordOf(event);
  if (message !== null) return !leaving.has(message);
  if (isExecutionEvent(custom)) return stepsEarlierRun(custom.event_type, custom.payload, begun);
  const jobId = jobIdOf(custom.event_type, custom.payload);
  if (jobId) return settlesJob(custom.event_type, jobId, begun);
  return answersEarlierQuestion(custom.event_type, custom.payload, begun);
}

/** A job's end whose start came before the range, or the start of a job with no end yet. */
function settlesJob(eventType: string, jobId: string, begun: Begun): boolean {
  if (eventType === CustomEvent.JobEnded) return !begun.jobs.has(jobId);
  begun.jobs.add(jobId);
  return !begun.endedJobs.has(jobId);
}

/** A turn's end whose start came before the range. */
function endsEarlierTurn(event: EventEnvelope, begun: Begun): boolean {
  const turn = event.turn_id;
  if (!turn) return false;
  if (event.data.type === EventKind.TurnStarted) begun.turns.add(turn);
  return event.data.type === EventKind.TurnEnded && !begun.turns.has(turn);
}

/** A lifecycle row of a build that started before the range (a start or a resume inside it is the range's). */
function stepsEarlierRun(eventType: string, payload: Record<string, unknown>, begun: Begun): boolean {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) return false;
  if (RUN_START_EVENTS.has(eventType)) begun.runs.add(runId);
  return !begun.runs.has(runId);
}

/** The questions whose answer a row records, and whether it asks one. */
const QUESTIONS: Record<string, { id: string; pending: string }> = {
  [CustomEvent.ToolPermission]: { id: "requestId", pending: "pending" },
  [CustomEvent.PluginConsent]: { id: "consentId", pending: "pending" },
};

/** An answer (or a Stop's withdrawal) to a question asked before the range. */
function answersEarlierQuestion(eventType: string, payload: Record<string, unknown>, begun: Begun): boolean {
  const question = QUESTIONS[eventType];
  const id = question ? payload[question.id] : undefined;
  if (!question || typeof id !== "string") return false;
  const key = `${eventType}:${id}`;
  if (payload.state === question.pending) begun.questions.add(key);
  return payload.state !== question.pending && !begun.questions.has(key);
}

/**
 * The builds with lifecycle rows from the message on, and whether each landed there: even one an
 * earlier rewind took out of the chat changed the game after the message.
 */
function buildsFrom(events: readonly EventEnvelope[], from: string): RewindBuild[] {
  const builds = new Map<string, RewindBuild>();
  for (const event of events) {
    const custom = event.id >= from ? customRecord(event.data) : null;
    const runId = custom?.payload.runId;
    if (!custom || typeof runId !== "string" || !isExecutionEvent(custom)) continue;
    const landed = custom.event_type === CustomEvent.RunFinished && custom.payload.landed === true;
    builds.set(runId, { runId, landed: landed || builds.get(runId)?.landed === true });
  }
  return [...builds.values()];
}

const userWords = (messages: readonly { role: string; content?: unknown }[]): string => {
  const content = messages.find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : "";
};

/** Follow-ups still waiting, oldest first, with their words and the pictures they had attached. */
function heldFollowUps(laterInput: readonly Bubbled[]): HeldFollowUp[] {
  return laterInput
    .filter((message) => message.state === "queued")
    .sort(byBubble)
    .map((message) => {
      const counts = imageCounts(message);
      return {
        messageId: message.messageId,
        text: requestOf(String(counts.text ?? "")),
        pickedImages: attached(counts),
      };
    });
}

/** The answered messages, in the order their answers began. */
function answeredInOrder(laterInput: readonly Bubbled[], processed: ReadonlyMap<string, string>): string[] {
  return laterInput
    .flatMap((message) => {
      const at = processed.get(message.messageId);
      return message.state === "handled" && at ? [{ messageId: message.messageId, at }] : [];
    })
    .sort((a, b) => compareIds(a.at, b.at))
    .map((entry) => entry.messageId);
}

/** Each message's first processing moment, by queue id. */
function firstProcessing(events: readonly EventEnvelope[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.event_type !== CustomEvent.CoordinatorMessageProcessing) continue;
    const id = custom.payload.messageId;
    if (typeof id === "string" && id && !first.has(id)) first.set(id, event.id);
  }
  return first;
}

/** The queue records: every `coordinator_message_*` row names its message. */
const QUEUE_RECORD_PREFIX = "coordinator_message_";

const queueRecordOf = (event: EventEnvelope): string | null => {
  const custom = customRecord(event.data);
  if (!custom?.event_type.startsWith(QUEUE_RECORD_PREFIX)) return null;
  const id = custom.payload.messageId;
  return typeof id === "string" ? id : null;
};

/**
 * The user bubbles a chat can be rewound to, by their event id, with the id each is rewound by:
 * every one that was answered (by a turn of its own or by the one it joined), and every bubble
 * with no queue record, by its own id. Not one being answered or handed in, still waiting, or
 * taken back. The loaded rows are enough: a bubble's queue records are always loaded with it.
 */
export function rewindableMessages(events: readonly EventEnvelope[]): Map<string, string> {
  const bound = new Map<string, QueuedMessage>();
  for (const message of messageQueueState(events).messages.values()) {
    if (message.eventId) bound.set(message.eventId, message);
  }
  const result = new Map<string, string>();
  for (const event of events) {
    if (!isUserBubble(event)) continue;
    const message = bound.get(event.id);
    if (!message) result.set(event.id, event.id);
    else if (ANSWERED.has(message.state)) result.set(event.id, message.messageId);
  }
  return result;
}
