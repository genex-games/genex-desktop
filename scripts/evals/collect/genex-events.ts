/**
 * The Genex collector: the eval profile's append-only event log (`<userData>/exoharness`), read
 * through the app's own `EventStore` without opening it for writing (the constructor, never
 * `open()`, which would create folders), the run projection `summarizeRun`, and the typed
 * custom-event accessors (`customPayload`, `delegatedPayload`), never a cast of a payload.
 *
 * It yields the timeline events only the app knows: chat delegations (`delegate_to_contractor`
 * from request to result) and facet builds (`facet_build_started` → the matching
 * `facet_iteration`), `context_usage` samples and compactions, questions, the first checkpoint or
 * studio capture (the first-preview proxy), the first `preview_ready` (M4.4), the judges' direct
 * model calls (`completion_call`, M4.5), the contractors' tool calls, provider errors, every model's
 * totals the chat's, the builds' and the judges' usage records hold (`Usage.by_model`, each engine
 * call once: a build record repeating its delegated turn's reply is skipped); and the
 * in-app signals a Genex row reports: the registered budgets, victory, execution status, the
 * autopilot's stop code, liveness, the scoreboard and whether the build landed.
 */
import { ContextSource } from "../../../src/shared/context.ts";
import { DELEGATE_TOOL } from "../../../src/shared/coordinator.ts";
import {
  CompletionRole,
  CustomEvent,
  customPayload,
  customRecord,
  delegatedPayload,
  isCompletionRole,
  type CustomEventData,
  type RecordedRunBudgets,
  StopCode,
} from "../../../src/shared/custom-events.ts";
import { EventKind, type EventEnvelope, type Usage } from "../../../src/shared/event-log.ts";
import { PlanReviewState } from "../../../src/shared/composer.ts";
import { untaggedModelId } from "../../../src/shared/model-id.ts";
import { QuestionKind, repeatedBuildUsages } from "../../../src/shared/eval-lane.ts";
import { CompletionPolicy, ExecutionStatus } from "../../../src/shared/run-state.ts";
import { summarizeRun } from "../../../src/shared/run-summary.ts";
import { EventStore } from "../../../src/substrate/event-store.ts";
import { StudioTool, studioToolName } from "../../../src/substrate/engines/studio-tool-prompts.ts";
import { epochMs, stringField, asRecord, recordField, type TraceReading } from "./honesty.ts";
import type { BuildSpanEvent, ObservationEvent, SessionRef, ToolCallEvent } from "./observation.ts";
import type { ModelUsageReading } from "./observe.ts";
import { TOOL_USE_PART, classifyTool } from "../../../src/shared/tool-category.ts";
import { addUsage, appUsageTokens, modelRowTokens, promptTokens } from "./usage.ts";
import {
  BuildSpanKind,
  ObservationEventKind,
  ObservationSource,
  ObservedErrorKind,
  PreviewSignal,
  ServedModelRole,
} from "../vocabulary.ts";

/** The chat's delegation tool, as the harness seed logs it; the app's typed copy. */
export { DELEGATE_TOOL };
/** The event store's agent id for the studio's log. */
const STUDIO_AGENT = "studio";
const TOOL_RESULT_PART = "tool_result";

/** The preview proxies, by the studio tool name a contractor calls them by. */
const PREVIEW_TOOLS: ReadonlyMap<string, PreviewSignal> = new Map([
  [studioToolName(StudioTool.Checkpoint), PreviewSignal.Checkpoint],
  [studioToolName(StudioTool.Capture), PreviewSignal.StudioCapture],
]);

/** The context meter's session roles as served roles. */
const CONTEXT_ROLE: Readonly<Record<string, ServedModelRole>> = {
  planner: ServedModelRole.Main,
  builder: ServedModelRole.Worker,
  judge: ServedModelRole.Judge,
};

/** Who asked for a direct model call, as a served role: every caller today is a judge of some kind. */
const COMPLETION_ROLE: Readonly<Record<CompletionRole, ServedModelRole>> = {
  [CompletionRole.Judge]: ServedModelRole.Judge,
  [CompletionRole.Playtester]: ServedModelRole.Judge,
  [CompletionRole.SkilloptGate]: ServedModelRole.Judge,
};

const STOP_CODES: ReadonlySet<unknown> = new Set(Object.values(StopCode));
const isStopCode = (value: unknown): value is StopCode => STOP_CODES.has(value);

const EXECUTION_STATUSES: ReadonlySet<string> = new Set(Object.values(ExecutionStatus));
const isExecutionStatus = (value: string): value is ExecutionStatus => EXECUTION_STATUSES.has(value);

/** The custom events that are a provider error, by the kind they report. */
const ERROR_EVENTS: ReadonlyMap<string, ObservedErrorKind> = new Map([
  [CustomEvent.NeedsSignin, ObservedErrorKind.AuthExpired],
  [CustomEvent.EngineFallback, ObservedErrorKind.Fallback],
]);

/** A run launched until satisfied is goal-bound; one with a wall clock is duration-bound. */
function completionPolicyOf(budgets: RecordedRunBudgets): RegisteredBudgets["completionPolicy"] {
  if (budgets.untilSatisfied) return CompletionPolicy.Goal;
  return typeof budgets.wallClockMs === "number" ? CompletionPolicy.Duration : null;
}

/** The budgets the agent registered for the run it launched, with the completion policy they imply. */
export interface RegisteredBudgets extends RecordedRunBudgets {
  completionPolicy: CompletionPolicy | null;
}

/** The in-app judge signals of the last run the chat launched (§8.7); typed fields only. */
export interface InAppSignals {
  runIds: string[];
  budgets: RegisteredBudgets | null;
  victory: boolean | null;
  executionStatus: ExecutionStatus | null;
  /** The run close's typed `stopCode` (autopilot closes carry one); the free-text `stoppedBecause` is never read. */
  stopCode: StopCode | null;
  livenessMax: number | null;
  scoreboard: { passing: number; total: number; regressions: number } | null;
  landed: boolean | null;
}

/** What the event log says about one Genex run. */
export interface GenexEventsReading {
  events: ObservationEvent[];
  /** Every model's totals across the run's engine calls, from their `Usage.by_model` (Claude's `modelUsage`). */
  modelUsage: Record<string, ModelUsageReading>;
  inApp: InAppSignals;
  trace: TraceReading;
  eventCount: number;
}

interface Reading {
  promptAtMs: number;
  events: ObservationEvent[];
  delegations: Map<string, BuildSpanEvent>;
  facets: Map<string, BuildSpanEvent[]>;
  tools: Map<string, ToolCallEvent>;
  previewSeen: boolean;
  previewReadySeen: boolean;
  reviews: Set<string>;
  inApp: InAppSignals;
  projects: Map<string, string>;
  modelUsage: Record<string, ModelUsageReading>;
  /** Build records whose usage a delegated turn's reply already carries (`repeatedBuildUsages`). */
  repeated: ReadonlySet<string>;
}

const atOf = (reading: Reading, event: EventEnvelope) =>
  (epochMs(event.created_at) ?? reading.promptAtMs) - reading.promptAtMs;
const numberOr = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function span(reading: Reading, id: string, kind: BuildSpanKind, atMs: number): BuildSpanEvent {
  const event: BuildSpanEvent = {
    kind: ObservationEventKind.BuildSpan,
    atMs,
    source: ObservationSource.EventLog,
    id,
    span: kind,
    endMs: null,
    ok: null,
  };
  reading.events.push(event);
  return event;
}

function readToolEvent(reading: Reading, event: EventEnvelope, atMs: number): void {
  const data = event.data;
  if (data.type === EventKind.ToolRequested && data.request.name === DELEGATE_TOOL) {
    reading.delegations.set(data.tool_call_id, span(reading, data.tool_call_id, BuildSpanKind.ChatDelegation, atMs));
    return;
  }
  if (data.type !== EventKind.ToolResult) return;
  const delegation = reading.delegations.get(data.tool_call_id);
  if (!delegation || delegation.endMs !== null) return;
  delegation.endMs = atMs;
  delegation.ok = data.result.ok;
}

function readFacet(reading: Reading, data: CustomEventData, atMs: number): void {
  const started = customPayload(data, CustomEvent.FacetBuildStarted);
  if (started) {
    const key = `${started.runId ?? ""}/${started.facetId ?? ""}`;
    const open = reading.facets.get(key) ?? [];
    open.push(span(reading, `${key}/${started.iteration ?? open.length}`, BuildSpanKind.Facet, atMs));
    reading.facets.set(key, open);
    return;
  }
  const iteration = customPayload(data, CustomEvent.FacetIteration);
  if (!iteration) return;
  const pending = reading.facets
    .get(`${iteration.runId ?? ""}/${iteration.facetId ?? ""}`)
    ?.find((s) => s.endMs === null);
  if (pending) pending.endMs = atMs;
  const board = iteration.scoreboard;
  if (board && typeof board.total === "number" && typeof board.passing === "number")
    reading.inApp.scoreboard = {
      passing: board.passing,
      total: board.total,
      regressions: board.regressions?.length ?? 0,
    };
}

function readContext(reading: Reading, data: CustomEventData, atMs: number): void {
  const usage = customPayload(data, CustomEvent.ContextUsage);
  const compacted = customPayload(data, CustomEvent.Compacted);
  const measured = usage ?? compacted;
  if (!measured) return;
  const session: SessionRef = {
    sessionId: measured.sessionId ?? "",
    parentSessionId: null,
    role: CONTEXT_ROLE[measured.role ?? ""] ?? ServedModelRole.Main,
  };
  const source = ObservationSource.EventLog;
  if (compacted) {
    reading.events.push({ kind: ObservationEventKind.Compaction, atMs, source, session });
    return;
  }
  reading.events.push({
    kind: ObservationEventKind.ContextSample,
    atMs,
    source,
    session,
    tokens: numberOr(measured.promptTokens),
    percent: numberOr(measured.percent),
    contextSource: measured.source ?? ContextSource.Unavailable,
  });
}

/** An interview question, or a plan review the first time it waits for an answer (a review is re-recorded per state). */
function questionOf(reading: Reading, event: EventEnvelope): { id: string; question: QuestionKind } | null {
  if (customPayload(event.data, CustomEvent.InterviewQuestion)) return { id: event.id, question: QuestionKind.AskUser };
  const review = customPayload(event.data, CustomEvent.PlanReview);
  if (review?.state !== PlanReviewState.Waiting || !review.id || reading.reviews.has(review.id)) return null;
  reading.reviews.add(review.id);
  return { id: review.id, question: QuestionKind.PlanReview };
}

function readQuestion(reading: Reading, event: EventEnvelope, atMs: number): void {
  const asked = questionOf(reading, event);
  if (asked)
    reading.events.push({ kind: ObservationEventKind.Question, atMs, source: ObservationSource.EventLog, ...asked });
}

function readRunStart(reading: Reading, data: CustomEventData): void {
  const start = customPayload(data, [CustomEvent.RunRegistered, CustomEvent.RunStarted]);
  if (!start?.runId) return;
  if (!reading.inApp.runIds.includes(start.runId)) reading.inApp.runIds.push(start.runId);
  if (start.project) reading.projects.set(start.runId, start.project);
  const budgets = start.budgets;
  if (!budgets || reading.inApp.budgets) return;
  reading.inApp.budgets = { ...budgets, completionPolicy: completionPolicyOf(budgets) };
}

function readRunEnd(reading: Reading, data: CustomEventData): void {
  const finished = customPayload(data, CustomEvent.RunFinished);
  if (finished) {
    reading.inApp.victory = typeof finished.victory === "boolean" ? finished.victory : reading.inApp.victory;
    reading.inApp.landed = typeof finished.landed === "boolean" ? finished.landed : reading.inApp.landed;
    const status = finished.executionStatus;
    if (status && isExecutionStatus(status)) reading.inApp.executionStatus = status;
    if (isStopCode(finished.stopCode)) reading.inApp.stopCode = finished.stopCode;
  }
  const liveness = customPayload(data, CustomEvent.FacetLiveness);
  const total = numberOr(liveness?.total);
  if (total !== null) reading.inApp.livenessMax = Math.max(reading.inApp.livenessMax ?? total, total);
}

function readErrors(reading: Reading, data: CustomEventData, atMs: number): void {
  const source = ObservationSource.EventLog;
  const outage = customPayload(data, [CustomEvent.AutopilotProviderOutage, CustomEvent.FacetProviderOutage]);
  if (outage) {
    reading.events.push({
      kind: ObservationEventKind.Retry,
      atMs,
      source,
      attempt: numberOr(outage.attempt) ?? 1,
      session: null,
    });
    return;
  }
  const kind = ERROR_EVENTS.get(customRecord(data)?.event_type ?? "");
  if (kind)
    reading.events.push({
      kind: ObservationEventKind.Error,
      atMs,
      source,
      error: kind,
      httpStatus: null,
      session: null,
    });
}

function delegatedSession(payload: {
  runId?: string;
  delegationId?: string;
  data?: { session_id?: string };
}): SessionRef {
  return {
    sessionId: payload.data?.session_id ?? payload.delegationId ?? "",
    parentSessionId: null,
    role: payload.runId ? ServedModelRole.Worker : ServedModelRole.Main,
  };
}

function readToolPart(reading: Reading, part: Record<string, unknown>, session: SessionRef, atMs: number): void {
  const id = stringField(part, "id");
  const name = stringField(part, "name");
  if (!id || !name || reading.tools.has(id)) return;
  const call: ToolCallEvent = {
    kind: ObservationEventKind.ToolCall,
    atMs,
    source: ObservationSource.EventLog,
    id,
    session,
    name,
    category: classifyTool(name, stringField(recordField(part, "input"), "command")),
    endMs: null,
    ok: null,
  };
  reading.tools.set(id, call);
  reading.events.push(call);
  const signal = PREVIEW_TOOLS.get(name);
  if (!signal || reading.previewSeen) return;
  reading.previewSeen = true;
  reading.events.push({ kind: ObservationEventKind.PreviewSignal, atMs, source: ObservationSource.EventLog, signal });
}

function readResultPart(reading: Reading, part: Record<string, unknown>, atMs: number): void {
  const call = reading.tools.get(stringField(part, "tool_use_id") ?? "");
  if (!call || call.endMs !== null) return;
  call.endMs = atMs;
  call.ok = part.is_error !== true;
}

function readDelegated(reading: Reading, data: CustomEventData, atMs: number): void {
  const delegated = delegatedPayload(data);
  if (!delegated) return;
  const session = delegatedSession(delegated.payload);
  for (const value of delegated.payload.data?.parts ?? []) {
    const part = asRecord(value);
    const type = stringField(part, "type");
    if (part && type === TOOL_USE_PART) readToolPart(reading, part, session, atMs);
    if (part && type === TOOL_RESULT_PART) readResultPart(reading, part, atMs);
  }
}

/** The first `preview_ready` (M4.4): the persisted first-preview signal, beside the checkpoint/capture proxy. */
function readPreviewReady(reading: Reading, data: CustomEventData, atMs: number): void {
  if (reading.previewReadySeen || !customPayload(data, CustomEvent.PreviewReady)) return;
  reading.previewReadySeen = true;
  reading.events.push({
    kind: ObservationEventKind.PreviewSignal,
    atMs,
    source: ObservationSource.EventLog,
    signal: PreviewSignal.PreviewReady,
  });
}

/** One judge's direct model call (`completion_call`, M4.5), written when it ended: `latencyMs` dates its start. */
function readCompletion(reading: Reading, event: EventEnvelope, data: CustomEventData, atMs: number): void {
  const call = customPayload(data, CustomEvent.CompletionCall);
  if (!call?.model || !call.usage) return;
  const usage = appUsageTokens(call.usage, call.engine);
  const latency = numberOr(call.latencyMs);
  reading.events.push({
    kind: ObservationEventKind.ModelCall,
    atMs: latency === null ? atMs : atMs - latency,
    source: ObservationSource.EventLog,
    id: event.id,
    session: {
      sessionId: call.runId ?? "",
      parentSessionId: null,
      role: isCompletionRole(call.role) ? COMPLETION_ROLE[call.role] : ServedModelRole.Judge,
    },
    model: call.model,
    usage,
    contextTokens: promptTokens(usage),
    contextWindow: null,
    effortServed: null,
    endMs: atMs,
    ttftMs: null,
    ...(call.engine ? { engine: call.engine } : {}),
  });
}

/**
 * The usage record an event holds for one engine call: the chat's turn (`messages`), a build
 * (`build_observation`) or a judge's call (`completion_call`), the records the app's own run facts
 * add up; its `by_model` is that call's totals. A build record repeating its turn's reply is
 * skipped by the caller, so each call's totals count once.
 */
function engineCallUsage(event: EventEnvelope): Usage | null {
  const data = event.data;
  if (data.type === EventKind.Messages) return data.usage ?? null;
  if (data.type !== EventKind.Custom) return null;
  return (
    customPayload(data, CustomEvent.BuildObservation)?.usage ??
    customPayload(data, CustomEvent.CompletionCall)?.usage ??
    null
  );
}

function readModelTotals(reading: Reading, event: EventEnvelope): void {
  if (reading.repeated.has(event.id)) return;
  for (const [reported, row] of Object.entries(engineCallUsage(event)?.by_model ?? {})) {
    const model = untaggedModelId(reported);
    const known = reading.modelUsage[model];
    const usage = modelRowTokens(row);
    reading.modelUsage[model] = {
      usage: known ? addUsage(known.usage, usage) : usage,
      contextWindow: known?.contextWindow ?? row.context_window ?? null,
    };
  }
}

function readEvent(reading: Reading, event: EventEnvelope): void {
  const atMs = atOf(reading, event);
  readToolEvent(reading, event, atMs);
  readModelTotals(reading, event);
  if (event.data.type !== EventKind.Custom) return;
  const data = event.data;
  readPreviewReady(reading, data, atMs);
  readCompletion(reading, event, data, atMs);
  readFacet(reading, data, atMs);
  readContext(reading, data, atMs);
  readQuestion(reading, event, atMs);
  readRunStart(reading, data);
  readRunEnd(reading, data);
  readErrors(reading, data, atMs);
  readDelegated(reading, data, atMs);
}

function emptyInApp(): InAppSignals {
  return {
    runIds: [],
    budgets: null,
    victory: null,
    executionStatus: null,
    stopCode: null,
    livenessMax: null,
    scoreboard: null,
    landed: null,
  };
}

/** The last launched run's execution status from the app's own projection, when the log says more than `run_finished`. */
function summarizedStatus(events: EventEnvelope[], reading: Reading): ExecutionStatus | null {
  const runId = reading.inApp.runIds.at(-1);
  if (!runId) return null;
  const execution = summarizeRun(events, reading.projects.get(runId) ?? "", runId).execution;
  return isExecutionStatus(execution) ? execution : null;
}

/** One Genex run's facts from its events, oldest first. Pure: `promptAtMs` is the epoch time the brief was sent. */
export function genexEventsOf(events: EventEnvelope[], promptAtMs: number): GenexEventsReading {
  const reading: Reading = {
    promptAtMs,
    events: [],
    delegations: new Map(),
    facets: new Map(),
    tools: new Map(),
    previewSeen: false,
    previewReadySeen: false,
    reviews: new Set(),
    inApp: emptyInApp(),
    projects: new Map(),
    modelUsage: {},
    repeated: repeatedBuildUsages(events),
  };
  const ordered = [...events].sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
  for (const event of ordered) readEvent(reading, event);
  reading.inApp.executionStatus = summarizedStatus(ordered, reading) ?? reading.inApp.executionStatus;
  return {
    events: reading.events,
    modelUsage: reading.modelUsage,
    inApp: reading.inApp,
    trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
    eventCount: ordered.length,
  };
}

/**
 * Every event of every thread in an eval profile's log (`<userData>/exoharness`), read without
 * writing: the store is constructed, never opened, and only its read methods are called.
 */
export async function readEventLog(eventLogDir: string): Promise<EventEnvelope[]> {
  const store = new EventStore(eventLogDir, STUDIO_AGENT, { warn: () => {} });
  const events: EventEnvelope[] = [];
  for (const thread of await store.listThreads()) events.push(...(await store.listEvents(thread.id)));
  return events;
}

/** One Genex run's facts from its eval profile's event log. */
export async function readGenexEvents(eventLogDir: string, promptAtMs: number): Promise<GenexEventsReading> {
  return genexEventsOf(await readEventLog(eventLogDir), promptAtMs);
}
