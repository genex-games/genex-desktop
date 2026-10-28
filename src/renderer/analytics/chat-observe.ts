/**
 * What the chat's analytics hears without a press (plan §1.5, funnels I, J, K, N): the log's turn,
 * card, plan and queue records, main's stream and queue events, and the open chat changing. Each
 * pairs in `chat-memory.ts` and sends durations, counts and the app's own codes — never a thread,
 * message or request id, a tool's input, a question's words or an English error.
 *
 * Records arrive once each (`observers.ts`); durations between records use their `created_at`, so a
 * window that catches up later still reports them right.
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { PlanReviewState, SendRefusal } from "../../shared/composer.ts";
import { type CustomEventData, CustomEvent, customPayload, customRecord } from "../../shared/custom-events.ts";
import type { EngineKind } from "../../shared/engine-descriptor.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { EngineFailureKind, isLimitKind, type LimitKind } from "../../shared/engine-requests.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../shared/event-log.ts";
import { SteerDelivery } from "../../shared/message-queue.ts";
import {
  isPlanRequest,
  ToolPermissionBy,
  type ToolPermissionEvent,
  ToolPermissionState,
} from "../../shared/permissions.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { classifyTool } from "../../shared/tool-category.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { Studio } from "../state/studio.ts";
import {
  type AwaitingReply,
  type ChatMemory,
  chatMemory,
  type OpenTurn,
  openCards,
  planKey,
  questionKey,
  STOP_SETTLE_MAX_MS,
} from "./chat-memory.ts";
import { engineRef } from "./chat-properties.ts";
import {
  CardSettledBy,
  CompactTrigger,
  ContextBucket,
  LeftTo,
  RetryAfterBucket,
  SendFailStage,
  SignInFrom,
  StopEndedBy,
  TurnOutcome,
  TurnStatus,
  WaitingCardKind,
} from "./chat-vocabulary.ts";
import { guarded, track } from "./client.ts";
import type { AnalyticsEvent, AnalyticsEventProperties } from "./events.ts";
import { ChatEvent, type ChatObserverOptions, type ChatTurnEndedProperties } from "./events/chat.ts";
import type { AreaObservers } from "./observers.ts";
import { installedRef } from "./plugins-ref.ts";
import { elapsedMs, type EventProperties } from "./properties.ts";

/** How an event leaves: `track`, or a test's recorder. */
export type SendEvent = <E extends AnalyticsEvent>(
  event: E,
  properties: AnalyticsEventProperties[E] & EventProperties,
) => void;

/** What every handler reads: the memory, the clock, where events go and the plugins installed. */
interface Hearing {
  memory: ChatMemory;
  now: () => number;
  send: SendEvent;
  plugins: () => readonly PluginInfo[];
}

/** One record of a chat, as a handler reads it. */
interface Heard {
  thread: string;
  at: number;
  data: CustomEventData;
}

const OUTCOMES: ReadonlySet<string> = new Set(Object.values(TurnOutcome));
const STATUSES: ReadonlySet<string> = new Set(Object.values(TurnStatus));
const FAILURE_KINDS: ReadonlySet<string> = new Set(Object.values(EngineFailureKind));
const REVIEW_STATES: ReadonlySet<string> = new Set(Object.values(PlanReviewState));
const DELIVERIES: ReadonlySet<string> = new Set(Object.values(SteerDelivery));
const REFUSALS: ReadonlySet<string> = new Set(Object.values(SendRefusal));
/** Phases that show a reply is being worked on (the first one is `first_phase`). */
const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  ChatActivityPhase.Working,
  ChatActivityPhase.Connecting,
  ChatActivityPhase.Thinking,
  ChatActivityPhase.Responding,
  ChatActivityPhase.Tool,
  ChatActivityPhase.LoadingModel,
]);
/** Turn ends the next model pick is counted after (`after_failure`). */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set([TurnOutcome.EngineLimited, TurnOutcome.NeedsSignin]);
/** Who closed a card, as the log names them; `user` is an answer and never counted here. */
const SETTLED_BY: Readonly<Record<string, CardSettledBy>> = {
  [ToolPermissionBy.Stop]: CardSettledBy.Stop,
  [ToolPermissionBy.Turn]: CardSettledBy.Turn,
  [ToolPermissionBy.Restart]: CardSettledBy.Restart,
  [ToolPermissionBy.Timeout]: CardSettledBy.Timeout,
  [ToolPermissionBy.Mode]: CardSettledBy.Mode,
  chat: CardSettledBy.Chat,
};

const isOutcome = (value: unknown): value is TurnOutcome => typeof value === "string" && OUTCOMES.has(value);
const isStatus = (value: unknown): value is TurnStatus => typeof value === "string" && STATUSES.has(value);
const isFailureKind = (value: unknown): value is EngineFailureKind =>
  typeof value === "string" && FAILURE_KINDS.has(value);
const isReviewState = (value: unknown): value is PlanReviewState =>
  typeof value === "string" && REVIEW_STATES.has(value);
const isDelivery = (value: unknown): value is SteerDelivery => typeof value === "string" && DELIVERIES.has(value);
const isRefusal = (value: unknown): value is SendRefusal => typeof value === "string" && REFUSALS.has(value);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A turn's outcome from its record: the seed's own word, `none` without one, `other` for any other. */
export function turnOutcome(value: unknown): TurnOutcome {
  if (value === undefined || value === null) return TurnOutcome.None;
  return isOutcome(value) ? value : TurnOutcome.Other;
}

/** A failure kind from a record, when it is one of the app's. */
export const failureKind = (value: unknown): EngineFailureKind | undefined =>
  isFailureKind(value) ? value : undefined;

/** Who closed a card nobody answered, or null when the person did. */
export function settledBy(by: unknown): CardSettledBy | null {
  if (by === undefined || by === ToolPermissionBy.User) return null;
  return (typeof by === "string" && SETTLED_BY[by]) || CardSettledBy.Other;
}

/** How full the context was, bucketed. */
export function contextBucket(percent: number): ContextBucket {
  if (percent < 50) return ContextBucket.Low;
  return percent < 85 ? ContextBucket.High : ContextBucket.Full;
}

/** How long a provider said to wait, bucketed. */
export function retryAfterBucket(ms: number): RetryAfterBucket {
  if (ms < MINUTE_MS) return RetryAfterBucket.Minute;
  if (ms < HOUR_MS) return RetryAfterBucket.Hour;
  return ms < DAY_MS ? RetryAfterBucket.Day : RetryAfterBucket.Longer;
}

/** The limit a turn ended on: main's record of it, else its engine's failure when that was a limit. */
function turnLimit(
  recorded: unknown,
  failure: EngineFailureKind | undefined,
): { limit_kind: LimitKind; retry_after_bucket?: RetryAfterBucket } | null {
  const limit = recorded !== null && typeof recorded === "object" ? (recorded as Record<string, unknown>) : {};
  const kind = typeof limit.kind === "string" && isLimitKind(limit.kind) ? limit.kind : null;
  if (!kind) return failure && isLimitKind(failure) ? { limit_kind: failure } : null;
  const wait = limit.retryAfterMs;
  const known = typeof wait === "number" && Number.isFinite(wait) && wait >= 0;
  return { limit_kind: kind, ...(known ? { retry_after_bucket: retryAfterBucket(wait) } : {}) };
}

/**
 * How a turn's engine failed: the failed call of a direct engine this launch saw, else what main
 * recorded on the turn's end for a delegated one.
 */
const turnFailureKind = (turn: OpenTurn | undefined, metadata: Record<string, unknown> | undefined) =>
  failureKind(turn?.failure) ?? failureKind(metadata?.failure);

/** `chat_turn_ended`, from the turn this launch saw begin (if it did) and its closing record. */
export function turnEndedProperties(
  turn: OpenTurn | undefined,
  end: { status?: string | undefined; metadata?: Record<string, unknown> | undefined },
  at: number,
  engineKind: EngineKind | undefined,
): ChatTurnEndedProperties {
  const outcome = turnOutcome(end.metadata?.outcome);
  const failure = turnFailureKind(turn, end.metadata);
  const limit = turnLimit(end.metadata?.limit, failure);
  return {
    status: isStatus(end.status) ? end.status : TurnStatus.Ok,
    outcome,
    interrupted: end.metadata?.interrupted === true,
    ...(turn ? { duration_ms: elapsedMs(turn.at, at) } : {}),
    engine: engineRef(turn?.engine),
    ...(engineKind ? { engine_kind: engineKind } : {}),
    streamed: turn?.streamed ?? false,
    stream_failed: turn?.streamFailed ?? false,
    ...(failure ? { failure_kind: failure } : {}),
    ...limit,
    launched_build: outcome === TurnOutcome.LaunchRun,
  };
}

/** `reply_first_token_received`, from the reply a send waited for. */
export function firstTokenProperties(
  reply: AwaitingReply,
  now: number,
): AnalyticsEventProperties[typeof ChatEvent.ReplyFirstTokenReceived] {
  return {
    first_token_ms: elapsedMs(reply.at, now),
    ...(reply.activityAt === undefined ? {} : { first_activity_ms: elapsedMs(reply.at, reply.activityAt) }),
    ...(reply.processingAt === undefined ? {} : { from_processing_ms: elapsedMs(reply.processingAt, now) }),
    ...(reply.phase ? { first_phase: reply.phase } : {}),
    engine: reply.engine,
    ...(reply.engineKind ? { engine_kind: reply.engineKind } : {}),
    is_first_in_game: reply.firstInGame,
  };
}

/** When a record was written, else now. */
function recordTime(record: EventEnvelope, now: number): number {
  const at = Date.parse(record.created_at);
  return Number.isFinite(at) ? at : now;
}

// ── turns and Stop ─────────────────────────────────────────────────────────────────────────

function turnStarted(hearing: Hearing, thread: string, metadata: Record<string, unknown> | undefined, at: number) {
  const engine = text(metadata?.engine);
  // A build's or an optimization's turn names its run; only a chat's turn is the person's wait.
  if (!engine || metadata?.runId !== undefined) return;
  hearing.memory.turns.set(thread, { at, engine, streamed: false, streamFailed: false });
}

/** The work a Stop asked to stop recorded its end: how long that took. */
function settleStop(hearing: Hearing, heard: Omit<Heard, "data">, endedBy: StopEndedBy, status?: TurnStatus): void {
  const { memory, send } = hearing;
  const stoppedAt = memory.stops.get(heard.thread);
  // A record written before the press is not the end of what it stopped.
  if (stoppedAt === undefined || heard.at < stoppedAt) return;
  memory.stops.delete(heard.thread);
  if (heard.at - stoppedAt > STOP_SETTLE_MAX_MS) return;
  send(ChatEvent.ChatStopSettled, {
    latency_ms: elapsedMs(stoppedAt, heard.at),
    ended_by: endedBy,
    ...(status ? { status } : {}),
  });
}

function turnEnded(hearing: Hearing, thread: string, end: Extract<EventData, { type: "turn_ended" }>, at: number) {
  const { memory, send } = hearing;
  const status = isStatus(end.status) ? end.status : TurnStatus.Ok;
  settleStop(hearing, { thread, at }, StopEndedBy.TurnEnded, status);
  const turn = memory.turns.get(thread);
  memory.turns.delete(thread);
  const failure = turnFailureKind(turn, end.metadata);
  if (failure) memory.turnFailures.set(thread, failure);
  else memory.turnFailures.delete(thread);
  // A reply the turn never streamed is not waited for any more once its message was taken.
  if (memory.replies.get(thread)?.processingAt !== undefined) memory.replies.delete(thread);
  if (!turn && end.metadata?.interrupted !== true) return;
  const properties = turnEndedProperties(turn, end, at, turn ? memory.engineKinds.get(turn.engine) : undefined);
  const failed = properties.status === TurnStatus.Error || FAILED_OUTCOMES.has(properties.outcome);
  if (failed) memory.lastFailureAt = at;
  send(ChatEvent.ChatTurnEnded, properties);
}

function completionCall(hearing: Hearing, heard: Heard): void {
  const call = customPayload(heard.data, CustomEvent.CompletionCall);
  if (!call || call.ok !== false) return;
  const turn = hearing.memory.turns.get(heard.thread);
  if (turn) turn.failure = call.failure ?? undefined;
  hearing.memory.lastFailureAt = heard.at;
}

// ── cards ──────────────────────────────────────────────────────────────────────────────────

function closeCard(hearing: Hearing, key: string, by: CardSettledBy | null, extra: { at: number; plugin?: string }) {
  const { memory, send } = hearing;
  const card = memory.cards.get(key);
  memory.cards.delete(key);
  if (!card || by === null) return;
  send(ChatEvent.CardSettledWithoutAnswer, {
    card: card.kind,
    by,
    wait_ms: elapsedMs(card.at, extra.at),
    ...(extra.plugin ? { plugin_ref: extra.plugin } : {}),
  });
}

/** The tool's category: a shell request by its command, which is read here and never sent. */
function toolCategory(request: Partial<ToolPermissionEvent>) {
  const command = text(request.input?.command) ?? text(request.subject) ?? null;
  return classifyTool(request.tool ?? "", command);
}

function toolPermission(hearing: Hearing, heard: Heard): void {
  const request = customPayload(heard.data, CustomEvent.ToolPermission);
  if (!request?.requestId) return;
  const { memory, send } = hearing;
  const thread = request.threadId ?? heard.thread;
  if (request.state !== ToolPermissionState.Pending) {
    closeCard(hearing, request.requestId, settledBy(request.by), { at: heard.at });
    return;
  }
  const plan = isPlanRequest(request);
  memory.cards.set(request.requestId, {
    thread,
    kind: plan ? WaitingCardKind.Plan : WaitingCardKind.Permission,
    at: heard.at,
  });
  send(ChatEvent.PermissionRequested, {
    tool_category: toolCategory(request),
    is_plan: plan,
    from_worker: Boolean(request.worker),
    from_subagent: Boolean(request.agentId),
    always_offered: Boolean(request.always?.length),
    cards_waiting: openCards(memory, thread).length - 1,
  });
}

/**
 * A plugin's or connector's consent card: kept while it waits (its `consent_card_shown` is the
 * plugins area's), and counted when it closes with no answer from the person.
 */
function pluginConsent(hearing: Hearing, heard: Heard): void {
  const consent = customPayload(heard.data, CustomEvent.PluginConsent);
  if (!consent?.consentId) return;
  if (consent.state === ToolPermissionState.Pending) {
    const thread = consent.threadId ?? heard.thread;
    hearing.memory.cards.set(consent.consentId, { thread, kind: WaitingCardKind.Consent, at: heard.at });
    return;
  }
  const plugin = hearing.plugins().find((candidate) => candidate.manifest.id === consent.pluginId);
  const ref = plugin ? installedRef(plugin) : undefined;
  closeCard(hearing, consent.consentId, settledBy(consent.by), { at: heard.at, ...(ref ? { plugin: ref } : {}) });
}

/** A chat's open question closed: an answer when the person gave one, else counted with what closed it. */
function closeQuestion(hearing: Hearing, thread: string, by: CardSettledBy, at: number): void {
  const answered = hearing.memory.answered.delete(thread);
  closeCard(hearing, questionKey(thread), answered ? null : by, { at });
}

function interviewQuestion(hearing: Hearing, heard: Heard): void {
  const asked = customPayload(heard.data, CustomEvent.InterviewQuestion);
  if (!asked?.question) return;
  const { memory, send } = hearing;
  closeQuestion(hearing, heard.thread, CardSettledBy.NewQuestion, heard.at);
  memory.cards.set(questionKey(heard.thread), { thread: heard.thread, kind: WaitingCardKind.Question, at: heard.at });
  send(ChatEvent.ChatQuestionAsked, {
    choices: asked.choices?.length ?? 0,
    cards_waiting: openCards(memory, heard.thread).length - 1,
  });
}

/** A user message in the log closes the chat's open question, as the transcript does. */
function userMessage(hearing: Hearing, thread: string, data: Extract<EventData, { type: "messages" }>, at: number) {
  if (!data.messages.some((message) => message.role === "user")) return;
  closeQuestion(hearing, thread, CardSettledBy.ComposerMessage, at);
}

// ── plans ──────────────────────────────────────────────────────────────────────────────────

/** States a plan review is reported in; writing and starting are steps on the way. */
const REPORTED_REVIEW_STATES: ReadonlySet<string> = new Set([
  PlanReviewState.Waiting,
  PlanReviewState.Failed,
  PlanReviewState.Approved,
  PlanReviewState.Cancelled,
]);
/** States in which the plan card waits on the person. */
const REVIEW_WAITS: ReadonlySet<string> = new Set([PlanReviewState.Waiting, PlanReviewState.Failed]);

function planReview(hearing: Hearing, heard: Heard): void {
  const review = customPayload(heard.data, CustomEvent.PlanReview);
  if (!review?.id || !isReviewState(review.state)) return;
  const { memory, send } = hearing;
  const key = planKey(review.id);
  const progress = memory.plans.get(review.id) ?? { thread: heard.thread, revisions: 0 };
  memory.plans.set(review.id, progress);
  if (review.state === PlanReviewState.Generating) {
    if (progress.generatingAt !== undefined) progress.revisions += 1;
    progress.generatingAt = heard.at;
    memory.cards.delete(key);
    return;
  }
  if (!REPORTED_REVIEW_STATES.has(review.state)) return;
  const waits = REVIEW_WAITS.has(review.state);
  if (waits) memory.cards.set(key, { thread: heard.thread, kind: WaitingCardKind.Plan, at: heard.at });
  else memory.cards.delete(key);
  if (review.state === PlanReviewState.Failed) memory.lastFailureAt = heard.at;
  const generationMs = waits && progress.generatingAt !== undefined ? elapsedMs(progress.generatingAt, heard.at) : null;
  const failure = review.state === PlanReviewState.Failed ? failureKind(review.failure) : undefined;
  send(ChatEvent.PlanReviewChanged, {
    state: review.state,
    ...(generationMs === null ? {} : { generation_ms: generationMs }),
    revision_index: progress.revisions,
    ...(failure ? { failure_kind: failure } : {}),
  });
}

// ── queue, steering, sign-in, fallback, compaction ─────────────────────────────────────────

function messageHandled(hearing: Hearing, heard: Heard): void {
  const handled = customPayload(heard.data, CustomEvent.CoordinatorMessageHandled);
  if (!handled?.messageId) return;
  const sent = hearing.memory.sends.get(handled.messageId);
  hearing.memory.sends.delete(handled.messageId);
  const failure = hearing.memory.turnFailures.get(heard.thread);
  hearing.memory.turnFailures.delete(heard.thread);
  if (handled.failed !== true) return;
  hearing.send(ChatEvent.MessageAnswerFailed, {
    engine: sent?.engine ?? engineRef(null),
    ...(failure ? { failure_kind: failure } : {}),
  });
}

function steering(hearing: Hearing, heard: Heard): void {
  const steer = customPayload(heard.data, CustomEvent.CoordinatorMessageSteering);
  if (steer?.messageId) hearing.memory.steering.set(steer.messageId, heard.at);
}

function steered(hearing: Hearing, heard: Heard, requeued: boolean): void {
  const steer = customPayload(heard.data, [
    CustomEvent.CoordinatorMessageDelivered,
    CustomEvent.CoordinatorMessageRequeued,
  ]);
  if (!steer?.messageId) return;
  const since = hearing.memory.steering.get(steer.messageId);
  hearing.memory.steering.delete(steer.messageId);
  const how = isDelivery(steer.how) ? steer.how : undefined;
  hearing.send(ChatEvent.MessageSteered, {
    ...(how ? { how } : {}),
    requeued,
    ...(since === undefined ? {} : { steer_wait_ms: elapsedMs(since, heard.at) }),
  });
}

function sessionActivity(hearing: Hearing, heard: Heard): void {
  const activity = customPayload(heard.data, CustomEvent.SessionActivity);
  const reply = hearing.memory.replies.get(heard.thread);
  const phase = activity?.phase;
  if (!reply || reply.activityAt !== undefined || !phase || !ACTIVE_PHASES.has(phase)) return;
  if (heard.at < reply.at) return;
  reply.activityAt = heard.at;
  reply.phase = phase;
}

function needsSignIn(hearing: Hearing, heard: Heard): void {
  const needs = customPayload(heard.data, CustomEvent.NeedsSignin);
  if (needs) hearing.send(ChatEvent.ChatSignInNeeded, { engine: engineRef(needs.engine), from: SignInFrom.Turn });
}

function engineFallback(hearing: Hearing, heard: Heard): void {
  const fallback = customRecord(heard.data)?.payload ?? {};
  const kind = failureKind(fallback.kind);
  hearing.send(ChatEvent.EngineFellBack, {
    from: engineRef(text(fallback.from)),
    to: engineRef(text(fallback.to)),
    ...(kind ? { kind } : {}),
  });
}

/** How a compaction started, by the trigger its record names. */
function compactTrigger(value: unknown): CompactTrigger {
  if (value === CompactTrigger.Auto || value === CompactTrigger.Manual) return value;
  return CompactTrigger.Other;
}

function compacted(hearing: Hearing, heard: Heard, failed: boolean): void {
  const payload = customRecord(heard.data)?.payload ?? {};
  const percent = hearing.memory.context.get(heard.thread);
  hearing.memory.context.delete(heard.thread);
  const failure = failed ? failureKind(payload.failure) : undefined;
  hearing.send(ChatEvent.ChatContextCompacted, {
    trigger: compactTrigger(payload.trigger),
    native: payload.native === true,
    failed,
    ...(failure ? { failure_kind: failure } : {}),
    ...(percent === undefined ? {} : { percent_before_bucket: contextBucket(percent) }),
  });
}

/** What each custom record a chat's analytics reads does. */
const CUSTOM: Readonly<Record<string, (hearing: Hearing, heard: Heard) => void>> = {
  [CustomEvent.CompletionCall]: completionCall,
  [CustomEvent.ToolPermission]: toolPermission,
  [CustomEvent.PluginConsent]: pluginConsent,
  [CustomEvent.InterviewQuestion]: interviewQuestion,
  [CustomEvent.PlanReview]: planReview,
  [CustomEvent.CoordinatorMessageHandled]: messageHandled,
  [CustomEvent.CoordinatorMessageSteering]: steering,
  [CustomEvent.CoordinatorMessageDelivered]: (hearing, heard) => steered(hearing, heard, false),
  [CustomEvent.CoordinatorMessageRequeued]: (hearing, heard) => steered(hearing, heard, true),
  [CustomEvent.SessionActivity]: sessionActivity,
  [CustomEvent.NeedsSignin]: needsSignIn,
  [CustomEvent.EngineFallback]: engineFallback,
  [CustomEvent.Compacted]: (hearing, heard) => compacted(hearing, heard, false),
  [CustomEvent.CompactionFailed]: (hearing, heard) => compacted(hearing, heard, true),
  [CustomEvent.RunFinished]: (hearing, heard) => settleStop(hearing, heard, StopEndedBy.RunFinished),
  [CustomEvent.AutopilotPaused]: (hearing, heard) => settleStop(hearing, heard, StopEndedBy.AutopilotPaused),
};

/** One log record, newly arrived. */
export function hearRecord(hearing: Hearing, record: EventEnvelope): void {
  const thread = record.thread_id;
  const at = recordTime(record, hearing.now());
  const { data } = record;
  if (data.type === EventKind.TurnStarted) turnStarted(hearing, thread, data.metadata, at);
  else if (data.type === EventKind.TurnEnded) turnEnded(hearing, thread, data, at);
  else if (data.type === EventKind.Messages) userMessage(hearing, thread, data, at);
  else if (data.type === EventKind.Custom) CUSTOM[data.event_type]?.(hearing, { thread, at, data });
}

// ── main's events ──────────────────────────────────────────────────────────────────────────

/** The reply a chat waited for began: its first token, unless the stream started before the send. */
function firstToken(hearing: Hearing, thread: string, stream: string): void {
  const { memory } = hearing;
  if (!memory.streams.has(thread)) memory.streams.set(thread, stream);
  const turn = memory.turns.get(thread);
  if (turn) turn.streamed = true;
  const reply = memory.replies.get(thread);
  if (!reply || reply.staleStream === stream) return;
  memory.replies.delete(thread);
  hearing.send(ChatEvent.ReplyFirstTokenReceived, firstTokenProperties(reply, hearing.now()));
}

function processing(hearing: Hearing, payload: { threadId?: string; messageId?: string }): void {
  const { memory, now } = hearing;
  const sent = payload.messageId ? memory.sends.get(payload.messageId) : undefined;
  if (sent)
    hearing.send(ChatEvent.MessageQueueWaited, {
      queue_wait_ms: elapsedMs(sent.at, now()),
      ...(sent.placement ? { placement: sent.placement } : {}),
    });
  const reply = payload.threadId ? memory.replies.get(payload.threadId) : undefined;
  if (reply && reply.processingAt === undefined) reply.processingAt = now();
}

function streamEnded(hearing: Hearing, payload: { threadId: string; failed?: boolean }): void {
  hearing.memory.streams.delete(payload.threadId);
  const turn = hearing.memory.turns.get(payload.threadId);
  if (turn && payload.failed === true) turn.streamFailed = true;
}

/** A message its chat refused for what it commissions; a send that failed is counted where it was sent. */
function chatRefused(hearing: Hearing, payload: { refusal?: SendRefusal }): void {
  if (isRefusal(payload.refusal))
    hearing.send(ChatEvent.MessageSendFailed, { stage: SendFailStage.Refused, code: payload.refusal });
}

/** One of main's UI events. */
export function hearUiEvent(hearing: Hearing, event: UiEvent): void {
  if (event.type === UiEvent.CoordinatorProcessing) processing(hearing, event.payload);
  else if (event.type === UiEvent.ChatStreamStarted) {
    hearing.memory.streams.delete(event.payload.threadId);
    firstToken(hearing, event.payload.threadId, event.payload.streamId);
  } else if (event.type === UiEvent.ChatDelta) firstToken(hearing, event.payload.threadId, event.payload.streamId);
  else if (event.type === UiEvent.ChatStreamEnded) streamEnded(hearing, event.payload);
  else if (event.type === UiEvent.ChatError) chatRefused(hearing, event.payload);
  else if (event.type === UiEvent.ContextUsage) {
    const { threadId, percent } = event.payload;
    if (threadId && typeof percent === "number") hearing.memory.context.set(threadId, percent);
  }
}

// ── the open chat ──────────────────────────────────────────────────────────────────────────

/** The person left a chat with a card still waiting on them. */
export function leftChat(hearing: Hearing, thread: string, to: string | null): void {
  const cards = openCards(hearing.memory, thread);
  const first = cards[0];
  if (!first) return;
  hearing.send(ChatEvent.ChatLeftWhileWaiting, {
    card: first.kind,
    wait_ms: elapsedMs(first.at, hearing.now()),
    to: to ? LeftTo.OtherChat : LeftTo.Home,
    cards_waiting: cards.length,
  });
}

function startHearing(hearing: Hearing, app: Studio): () => void {
  const { memory } = hearing;
  const kinds = (list: readonly { id: string; kind: EngineKind }[]): void => {
    memory.engineKinds.clear();
    for (const engine of list) memory.engineKinds.set(engine.id, engine.kind);
  };
  kinds(app.engines.getState().list);
  const offEngines = app.engines.subscribe(guarded((state) => kinds(state.list)));
  hearing.plugins = () => app.plugins.getState().list;
  let active = app.threads.getState().activeThreadId;
  const offThreads = app.threads.subscribe(
    guarded((state) => {
      const left = active;
      active = state.activeThreadId;
      if (left && left !== active) leftChat(hearing, left, active);
    }),
  );
  return () => {
    offEngines();
    offThreads();
  };
}

/** The chat's observers over a memory, a clock and where events go. */
export function chatObservers(memory: ChatMemory, now: () => number, send: SendEvent = track): AreaObservers {
  const hearing: Hearing = { memory, now, send, plugins: () => [] };
  return {
    log: (record) => hearRecord(hearing, record),
    ui: (event) => hearUiEvent(hearing, event),
    start: (app) => startHearing(hearing, app),
  };
}

/**
 * What the chat area hears from the log, from main's events and from the open chat and engines.
 * It lives here, not in `events/chat.ts`, because these observers read that file's names.
 */
export function createChatObservers(options: ChatObserverOptions = {}): AreaObservers {
  return chatObservers(options.memory ?? chatMemory, options.now ?? Date.now, options.send);
}
