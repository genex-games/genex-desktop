/**
 * What the chat shows, derived from the loaded page and the thread's current state: the
 * transcript entries, the questions waiting on the user, the follow-ups waiting in the queue, and
 * the plan under review. Pure, so ChatPanel only draws it.
 */
import { conversationThrough, finishRequested } from "../../shared/coordinator.ts";
import { mergeChatEvents } from "../../shared/chat-history.ts";
import { isPlanReviewRecord, type PlanReviewRecord } from "../../shared/composer.ts";
import { CustomEvent, customEvent, customPayload, customRecord, delegatedPayload } from "../../shared/custom-events.ts";
import { HOUR_MS } from "../../shared/duration.ts";
import { EventKind, type EventEnvelope } from "../../shared/event-log.ts";
import {
  type QueuedMessage as QueueRecord,
  QueueState,
  type QueueView,
  messageQueueState,
} from "../../shared/message-queue.ts";
import { isChatReport } from "../../shared/protocol.ts";
import {
  executionActivity,
  executionStep,
  isExecutionEvent,
  type RecordedRunLoop,
  recordedRunLoop,
  type RunExecution,
  type RunWorked,
  workStart,
} from "../../shared/run-state.ts";
import type { RunSummary } from "../../shared/run-summary.ts";
import { isStudioRecord } from "../../shared/studio-activity.ts";
import { EntryAction, EntryKind, toEntries } from "../chat-entries.ts";
import type { LoopSetting } from "../loop-setting.ts";
import {
  ActivityItemKind,
  conversationEntries,
  type ActivityItem,
  type ConversationEntry,
} from "./conversation-entries.ts";
import { deliveryOrder } from "./delivery-order.ts";
import { TaskState } from "./task-state.ts";
import type { PluginConsentEvent } from "../../shared/plugins.ts";
import { ToolPermissionState } from "../../shared/permissions.ts";

type QueuedMessage = { eventId?: string | null; messageId: string; state: string };

/** Input still waiting for the agent to read it: queued, or steered into the running turn and not read yet. */
const isWaiting = (message: QueuedMessage): boolean =>
  message.state === QueueState.Queued || message.state === QueueState.Steering;

/** A plugin's question that still waits on the user. */
const CONSENT_PENDING: PluginConsentEvent["state"] = "pending";
/** A plugin tool's records, traces of the worker that called it. */
const WORKER_TOOL_EVENTS: ReadonlySet<string> = new Set([CustomEvent.PluginToolStarted, CustomEvent.PluginTool]);

/** A Claude permission question still waiting: the first pending row per request id is the question. */
function notePermission(pending: Map<string | undefined, EventEnvelope>, event: EventEnvelope): void {
  const request = customEvent(event, CustomEvent.ToolPermission);
  if (!request) return;
  const key = `permission:${request.requestId}`;
  if (request.state !== ToolPermissionState.Pending) pending.delete(key);
  else if (!pending.has(key)) pending.set(key, event);
}

/**
 * The questions still waiting on the user: plugins' consents keyed by consent id, and Claude's
 * permission requests keyed `permission:<request id>`.
 */
function pendingConsents(stateEvents: readonly EventEnvelope[]): Map<string | undefined, EventEnvelope> {
  const pending = new Map<string | undefined, EventEnvelope>();
  for (const event of stateEvents) {
    notePermission(pending, event);
    const consent = customEvent(event, CustomEvent.PluginConsent);
    if (!consent) continue;
    if (consent.state === CONSENT_PENDING) pending.set(consent.consentId, event);
    else pending.delete(consent.consentId);
  }
  return pending;
}

/** Does this record answer an open intake question: a user message, or a build that started? */
function endsInterview(event: EventEnvelope): boolean {
  if (event.data.type === EventKind.Messages) return event.data.messages.some((m) => m.role === "user");
  return customEvent(event, [CustomEvent.RunStarted, CustomEvent.RunRegistered]) !== null;
}

/** The intake question still open in this thread, if any. */
function openInterview(threadEvents: readonly EventEnvelope[]): EventEnvelope | undefined {
  let interview: EventEnvelope | undefined;
  for (const event of threadEvents) {
    if (customEvent(event, CustomEvent.InterviewQuestion)) interview = event;
    else if (endsInterview(event)) interview = undefined;
  }
  return interview;
}

/**
 * Is this record a worker's trace of the build running now? A running build's workers live in
 * its task rows, from the first paint (not after its summary loads).
 */
function isRunningWorkerTrace(event: EventEnvelope, activeRunId: string | null): boolean {
  const custom = customRecord(event.data);
  if (!custom || !activeRunId) return false;
  const p = custom.payload;
  const workerTrace = delegatedPayload(event.data) !== null || WORKER_TOOL_EVENTS.has(custom.event_type);
  return workerTrace && p?.runId === activeRunId && Boolean(p?.facetId);
}

/**
 * The transcript: the loaded page, plus what must stay reachable whatever page is loaded (a
 * plugin's pending question, an intake question not yet answered), in delivery order.
 */
export function transcriptEntries(input: {
  /** The loaded page and its live tail. */
  events: EventEnvelope[];
  /** Current-state facts, independent of the loaded page. */
  stateEvents: EventEnvelope[];
  /** This thread's slice of `stateEvents`. */
  threadEvents: EventEnvelope[];
  queued: Iterable<QueuedMessage>;
  queue?: QueueView;
  activeRunId: string | null;
  studio: boolean;
}): ConversationEntry[] {
  const queue = input.queue ?? messageQueueState(input.threadEvents);
  const pending = pendingConsents(input.stateEvents);
  // Current-state context keeps an intake question reachable even when its history page is unloaded.
  const interview = openInterview(input.threadEvents);
  if (interview) pending.set("interview", interview);
  const loadedIds = new Set(input.events.map((event) => event.id));
  // Waiting input keeps its bubble whatever page is loaded: queued, or being handed to the running turn.
  for (const message of input.queued) if (isWaiting(message) && message.eventId) loadedIds.add(message.eventId);
  const transcript = conversationThrough(input.threadEvents, undefined, queue).filter((event) => {
    if (!loadedIds.has(event.id)) return false;
    // Studio's own records (learning, restores, updates) are shown in Activity beside this chat.
    if (input.studio && isStudioRecord(event)) return false;
    return !isRunningWorkerTrace(event, input.activeRunId);
  });
  // Merging sorts by id; delivery order is applied to the merged log so it is not undone.
  return conversationEntries(
    toEntries(deliveryOrder(mergeChatEvents([...pending.values()], transcript), queue.messages)),
  );
}

export const isPendingConsent = (entry: ConversationEntry): boolean =>
  entry.kind === EntryKind.Action && entry.action === EntryAction.Consent && Boolean(entry.pending);
/** Claude's own permission question, still waiting: pinned above the composer, not in the reading order. */
export const isPendingPermission = (entry: ConversationEntry): boolean =>
  entry.kind === EntryKind.Action && entry.action === EntryAction.Permission && Boolean(entry.pending);
export const isPendingQuestion = (entry: ConversationEntry): boolean =>
  entry.kind === EntryKind.Question && entry.pending;

/** The newest plan review this thread holds, when it is one the composer can answer. */
export function pendingPlanReview(threadEvents: readonly EventEnvelope[]): PlanReviewRecord | null {
  const event = threadEvents.findLast((e) => customEvent(e, CustomEvent.PlanReview) !== null);
  const review = event ? customEvent(event, CustomEvent.PlanReview) : null;
  return review && isPlanReviewRecord(review) ? review : null;
}

/** The run's tool rows of the parts that are building right now, then the chat's own trailing work. */
export function currentWorkItems(
  stateEvents: readonly EventEnvelope[],
  outcome: RunSummary | null,
  activeRunId: string | null,
  trailing: ActivityItem[],
): ActivityItem[] {
  const activeTasks = new Set(outcome?.tasks.filter((task) => task.state === TaskState.Running).map((task) => task.id));
  /** A record of a part of the active run that is building right now. */
  const fromBuildingPart = (event: EventEnvelope): boolean => {
    const payload = customRecord(event.data)?.payload;
    if (payload === undefined || payload.runId !== activeRunId) return false;
    return Boolean(payload.facetId && activeTasks.has(payload.facetId));
  };
  const tools = toEntries(stateEvents.filter(fromBuildingPart)).flatMap((entry) =>
    entry.kind === EntryKind.Tools
      ? entry.rows.map((tool) => ({ kind: ActivityItemKind.Tool, id: tool.key, tool }))
      : [],
  );
  return [...tools, ...trailing];
}

/** A build is finishing: the chat asked this running build to wrap up since it last (re)started. */
export function finishingRun(threadEvents: readonly EventEnvelope[], runId: string | null): boolean {
  return runId ? finishRequested(threadEvents, runId) : false;
}

/**
 * The user entries of messages the chat wrote itself (a command's result): sent to the agent,
 * never drawn as the user's bubble.
 */
export function chatReportEntryIds(messages: Iterable<QueueRecord>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    if (message.eventId && isChatReport(message.action)) ids.add(`${message.eventId}-0:user`);
  return ids;
}

/**
 * Pictures sent with a message were saved beside it for the agent; its bubble shows them too.
 * Keyed by the message's user entry, with how many there are when the log recorded it.
 */
export function sentImages(messages: Iterable<QueueRecord>): Map<string, { messageId: string; count?: number }> {
  const byEntry = new Map<string, { messageId: string; count?: number }>();
  for (const message of messages) {
    if (!message.eventId || !message.action?.attachmentsArtifact) continue;
    const count = message.action.imageCount;
    byEntry.set(`${message.eventId}-0:user`, {
      messageId: message.messageId,
      ...(typeof count === "number" ? { count } : {}),
    });
  }
  return byEntry;
}

/** The records that start a run and keep the budget it was given. */
const RUN_BUDGET_EVENTS = [CustomEvent.RunRegistered, CustomEvent.RunStarted] as const;

/**
 * The Loop run `runId`'s start records kept: the last one that kept any, so a restart that carries
 * no budgets (a resumed build's finalization) never erases an earlier one.
 */
function latestRecordedLoop(threadEvents: readonly EventEnvelope[], runId: string): RecordedRunLoop | null {
  let loop: RecordedRunLoop | null = null;
  for (const event of threadEvents) {
    const payload = customPayload(event.data, RUN_BUDGET_EVENTS);
    if (!payload || payload.runId !== runId) continue;
    loop = recordedRunLoop(payload.budgets) ?? loop;
  }
  return loop;
}

/** The Loop a build was given, as Mode shows it while the build runs or is paused, or null when none was kept. */
export function runLoopSetting(threadEvents: readonly EventEnvelope[], runId: string | null): LoopSetting | null {
  if (!runId) return null;
  const loop = latestRecordedLoop(threadEvents, runId);
  return loop ? { on: true, hours: loop.hours } : null;
}

/**
 * The time a running build was given (the composer's hours), in ms, as its start records kept it,
 * or null: an ∞ build has only a safety ceiling, so its row shows the elapsed clock instead.
 */
export function runBudgetMs(threadEvents: readonly EventEnvelope[], runId: string | null): number | null {
  const hours = runLoopSetting(threadEvents, runId)?.hours;
  return typeof hours === "number" ? hours * HOUR_MS : null;
}

/**
 * Where a running build's clock starts, in ms: when it would have started had it never paused, so
 * the clock says the time it has worked (run-state.ts `RunWorked`). Its recorded summary's working
 * time while that says it is working, else its own records — a summary from before a resume has
 * no stretch under way. A finished build reopened counts from the reopen, a resumed pause goes on
 * from the time it worked, and the hours the app was closed under it never count. A closed build
 * has no running clock.
 */
export function runStartedAt(
  threadEvents: readonly EventEnvelope[],
  runId: string | null,
  recorded: RunWorked | null | undefined,
): number | undefined {
  if (!runId) return undefined;
  const worked = recorded?.since ? recorded : recordedExecution(threadEvents, runId)?.worked;
  return (worked && workStart(worked)) ?? undefined;
}

/** A run's execution, as its own records in the conversation say it, with the signs that it was working. */
function recordedExecution(threadEvents: readonly EventEnvelope[], runId: string): RunExecution | null {
  let execution: RunExecution | null = null;
  for (const event of threadEvents) {
    const custom = customRecord(event.data);
    if (custom?.payload.runId !== runId) continue;
    execution = isExecutionEvent(custom)
      ? executionStep(execution, runId, {
          event_type: custom.event_type,
          payload: custom.payload,
          at: event.created_at,
        })
      : executionActivity(execution, event.created_at);
  }
  return execution;
}
