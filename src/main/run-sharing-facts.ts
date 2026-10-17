/**
 * What a finished build measured, read from its events (§9.4, M5.3): the facts a field row is built
 * from. Two kinds of build end: a game chat's turn that delegated builds and launched nothing (a
 * chat-only build), and a run the chat launched (its `run_finished`). A turn that launched a run
 * makes no row of its own; the run's end does.
 *
 * Pure: it reads typed fields of the given events and never their text. M4's instrumentation is
 * read where it exists: `build_observation`'s `durationMs`, `usage` and `ready` (the preview's
 * ready answer, M4.3) are optional fields of a registered event, and the two events M4 adds
 * (`completion_call`, M4.5, and `preview_ready`, M4.4) are read under the names in
 * `FieldEventNames` (their registered `CustomEvent` names by default); a log without them leaves
 * those measurements null or absent, never zero.
 *
 * Tokens are normalized as the eval collectors normalize them (`normalizedTokens`, Rule 13), and an
 * engine call's `by_model` adds what its main loop does not count: its own model's surplus
 * (subagents) and every other model it called (auxiliary). A delegated call's `by_model` is its own
 * share of its session's running totals (`substrate/engines/session-cost.ts`), so the calls of one
 * resumed session add up rather than counting its early turns again. Each engine call counts once:
 * a delegated turn's reply and its `build_observation` carry the same contractor report, which is
 * read from the reply (`repeatedBuildUsages`).
 */
import { SessionActivityRole } from "../shared/chat-activity.ts";
import { CustomEvent, delegatedPayload } from "../shared/custom-events.ts";
import { type ConversationRecord, EventKind, type EventEnvelope, ThreadKind } from "../shared/event-log.ts";
import {
  type CallCounts,
  EndedHow,
  LaneModeServed,
  LaunchPath,
  REPORTED_COUNTS,
  type ReportedTokens,
  TokenRole,
  type TokenUsage,
  ZERO_TOKEN_USAGE,
  normalizedTokens,
  repeatedBuildUsages,
} from "../shared/eval-lane.ts";
import { untaggedModelId } from "../shared/model-id.ts";
import { DEFAULT_PERMISSION_MODE, PermissionMode } from "../shared/permissions.ts";
import { EngineId } from "../shared/providers.ts";
import { ExecutionStatus } from "../shared/run-state.ts";
import { FIELD_MODEL_PATTERN, FIELD_STOP_CODE_PATTERN, type FieldRunFacts } from "../shared/run-sharing.ts";
import { TOOL_USE_PART, classifyTool } from "../shared/tool-category.ts";
import type { EventStore } from "../substrate/event-store.ts";
import type { FinishedBuildRef } from "./run-sharing.ts";

/** The names M4's two events are read under; null reads nothing (a test seam). */
export interface FieldEventNames {
  /** `completion_call` (M4.5): one in-app completion (judges, playtester, gates) with its `usage`. */
  completionCall: string | null;
  /** `preview_ready` (M4.4): `{ project, runId?, ms, via }`. */
  previewReady: string | null;
}

/** The registered names. */
export const FIELD_EVENT_NAMES: FieldEventNames = {
  completionCall: CustomEvent.CompletionCall,
  previewReady: CustomEvent.PreviewReady,
};

/** One game chat's events and the chat's permission mode (its thread metadata), as the log holds them. */
export interface FinishedBuildEvents {
  events: readonly EventEnvelope[];
  permissionMode: unknown;
}

type Payload = Record<string, unknown>;

const isRecord = (value: unknown): value is Payload =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const valueIn = <T extends string>(table: Record<string, T>, value: unknown): T | null =>
  (Object.values(table) as unknown[]).includes(value) ? (value as T) : null;

/** A custom record's payload when its name is `name`; null for any other event. */
function payloadOf(event: EventEnvelope, name: string | null): Payload | null {
  const { data } = event;
  if (name === null || data.type !== EventKind.Custom || data.event_type !== name) return null;
  return isRecord(data.payload) ? data.payload : {};
}

/** Every payload named `name`, in order. */
function payloads(events: readonly EventEnvelope[], name: string | null): Payload[] {
  const out: Payload[] = [];
  for (const event of events) {
    const payload = payloadOf(event, name);
    if (payload) out.push(payload);
  }
  return out;
}

/**
 * A usage record (`input_tokens`, …) as the five normalized counts for the engine that reported
 * it (Codex's input holds its cache reads); null when it counts nothing.
 */
function tokenUsage(value: unknown, engine: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const reported: ReportedTokens = {};
  for (const key of REPORTED_COUNTS) {
    const count = finite(value[key]);
    if (count !== null) reported[key] = Math.round(count);
  }
  if (Object.keys(reported).length === 0) return null;
  return normalizedTokens(reported, valueIn(EngineId, engine));
}

/** What one usage record counts: its main loop, and from its `by_model` totals what that loop does not. */
interface UsageReading {
  main: TokenUsage | null;
  /** The main model's share beyond the main loop: subagents (and compactions) on the same model. */
  subagents: TokenUsage | null;
  /** Every other model the session called, such as Claude Code's Haiku helper. */
  auxiliary: TokenUsage | null;
}

/** A model id compared across `usage.model` and `by_model` keys: lowercased, without a context-size suffix. */
const modelKey = (raw: unknown): string | null => (typeof raw === "string" ? untaggedModelId(raw) : null);

/** `total` minus `part`, field by field and never below zero; null when nothing is left. */
function surplus(total: TokenUsage | null, part: TokenUsage | null): TokenUsage | null {
  if (!total) return null;
  const base = part ?? ZERO_TOKEN_USAGE;
  const left: TokenUsage = {
    uncachedInput: Math.max(0, total.uncachedInput - base.uncachedInput),
    cacheWrite: Math.max(0, total.cacheWrite - base.cacheWrite),
    cacheRead: Math.max(0, total.cacheRead - base.cacheRead),
    output: Math.max(0, total.output - base.output),
    reasoning: Math.max(0, total.reasoning - base.reasoning),
  };
  return Object.values(left).some((n) => n > 0) ? left : null;
}

/**
 * One usage record: its main-loop counts, and its call's `by_model` split into the main model's
 * surplus and the other models. A record whose `by_model` names no share for its main
 * model adds nothing beyond its main loop: which share is the main loop's is unknown there.
 */
function readUsage(usage: unknown, engine: unknown, model: unknown): UsageReading {
  const main = tokenUsage(usage, engine);
  const byModel = isRecord(usage) && isRecord(usage.by_model) ? Object.entries(usage.by_model) : [];
  const mainKey = modelKey(model);
  const own = byModel.find(([id]) => mainKey !== null && modelKey(id) === mainKey);
  if (!own) return { main, subagents: null, auxiliary: null };
  const others = byModel.filter((entry) => entry !== own).map(([, row]) => tokenUsage(row, engine));
  return { main, subagents: surplus(tokenUsage(own[1], engine), main), auxiliary: sumUsage(others) };
}

/** A payload field's own record field, such as `usage.engine`. */
const nested = (payload: Payload, field: string, key: string): unknown => {
  const value = payload[field];
  return isRecord(value) ? value[key] : undefined;
};

/** The sum of some usages; null when none counted anything. */
function sumUsage(usages: ReadonlyArray<TokenUsage | null>): TokenUsage | null {
  const counted = usages.filter((u): u is TokenUsage => u !== null);
  if (counted.length === 0) return null;
  return counted.reduce(
    (sum, u) => ({
      uncachedInput: sum.uncachedInput + u.uncachedInput,
      cacheWrite: sum.cacheWrite + u.cacheWrite,
      cacheRead: sum.cacheRead + u.cacheRead,
      output: sum.output + u.output,
      reasoning: sum.reasoning + u.reasoning,
    }),
    ZERO_TOKEN_USAGE,
  );
}

/** A model id a row may carry: lowercased, without a context-size suffix (`[1m]`); null otherwise. */
export function fieldModel(raw: unknown): string | null {
  const model = modelKey(raw);
  return model !== null && FIELD_MODEL_PATTERN.test(model) ? model : null;
}

/** The median of some durations; null for none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

const maxOf = (values: ReadonlyArray<number | null>): number | null => {
  const measured = values.filter((v): v is number => v !== null);
  return measured.length ? Math.max(...measured) : null;
};

/** Milliseconds between two log records; null when either time does not parse. */
function between(from: EventEnvelope | undefined, to: EventEnvelope | undefined): number | null {
  if (!from || !to) return null;
  return finite(Date.parse(to.created_at) - Date.parse(from.created_at));
}

/** The chat's own model calls: every `messages` record with usage, and the engine and model they name. */
interface LeadCalls {
  engine: EngineId | null;
  model: string | null;
  /** Each call's usage, read with the engine and model that call names. */
  readings: UsageReading[];
  calls: number;
}

function leadCalls(events: readonly EventEnvelope[]): LeadCalls {
  const lead: LeadCalls = { engine: null, model: null, readings: [], calls: 0 };
  for (const { data } of events) {
    if (data.type !== EventKind.Messages || !data.usage) continue;
    lead.calls += 1;
    lead.engine = valueIn(EngineId, data.usage.engine) ?? lead.engine;
    lead.model = fieldModel(data.usage.model) ?? lead.model;
    lead.readings.push(readUsage(data.usage, data.usage.engine, data.usage.model));
  }
  return lead;
}

/** Tokens by role (only the roles that recorded any) and their total. */
function tokenFacts(
  events: readonly EventEnvelope[],
  lead: readonly UsageReading[],
  names: FieldEventNames,
): Pick<FieldRunFacts, "tokens" | "tokensByRole"> {
  // A delegated turn's reply already carries its build's engine call: that call is the lead's, once.
  const repeated = repeatedBuildUsages(events);
  const builds = payloads(
    events.filter((event) => !repeated.has(event.id)),
    CustomEvent.BuildObservation,
  );
  const workers = builds.map((p) =>
    readUsage(p.usage, nested(p, "usage", "engine"), nested(p, "usage", "model") ?? p.model),
  );
  const judges = payloads(events, names.completionCall).map((p) =>
    readUsage(p.usage, p.engine ?? nested(p, "usage", "engine"), p.model ?? nested(p, "usage", "model")),
  );
  const all = [...lead, ...workers, ...judges];
  const roles: Array<[TokenRole, TokenUsage | null]> = [
    [TokenRole.Lead, sumUsage(lead.map((r) => r.main))],
    [TokenRole.Workers, sumUsage(workers.map((r) => r.main))],
    [TokenRole.Judges, sumUsage(judges.map((r) => r.main))],
    [TokenRole.Subagents, sumUsage(all.map((r) => r.subagents))],
    [TokenRole.Auxiliary, sumUsage(all.map((r) => r.auxiliary))],
  ];
  const byRole: FieldRunFacts["tokensByRole"] = {};
  for (const [role, usage] of roles) if (usage) byRole[role] = usage;
  return { tokens: sumUsage(Object.values(byRole)) ?? ZERO_TOKEN_USAGE, tokensByRole: byRole };
}

/** Builds, their durations and first boot and preview, from the build records the window holds. */
function timingFacts(
  events: readonly EventEnvelope[],
  wallMs: number | null,
  extraBuilds: number,
  names: FieldEventNames,
): FieldRunFacts["time"] {
  const builds = payloads(events, CustomEvent.BuildObservation);
  const durations = builds.map((p) => finite(p.durationMs)).filter((ms): ms is number => ms !== null);
  const boots = builds.map((p) => finite(nested(p, "ready", "pageMs")));
  const previews = payloads(events, names.previewReady).map((p) => finite(p.ms));
  return {
    wallMs,
    firstBootMs: boots.find((ms) => ms !== null) ?? null,
    firstPreviewMs: previews.find((ms) => ms !== null) ?? null,
    delegationP50Ms: median(durations),
    builds: builds.length + extraBuilds,
  };
}

/** The lead's context peak (the planner's readings, never a worker's) and how many compactions ran. */
function contextFacts(events: readonly EventEnvelope[]): FieldRunFacts["context"] {
  const readings = payloads(events, CustomEvent.ContextUsage).filter(
    (p) => p.role === undefined || p.role === SessionActivityRole.Planner,
  );
  const peak = maxOf(readings.map((p) => finite(p.percent)));
  return {
    leadPeakPct: peak === null ? null : Math.min(100, peak),
    compactions: payloads(events, CustomEvent.Compacted).length,
  };
}

/**
 * The model calls, and the builders' tool calls as the evals count a lab run's: every `tool_use`
 * part the delegated records mirror, once per call id, by the shared category table. The chat's own
 * requests (a delegation, a launch) are not tool calls of the build.
 */
function callFacts(events: readonly EventEnvelope[], modelCalls: number): CallCounts {
  const seen = new Set<string>();
  const byCategory: CallCounts["tools"]["byCategory"] = {};
  for (const { data } of events) {
    const delegated = data.type === EventKind.Custom ? delegatedPayload(data) : null;
    for (const part of delegated?.payload.data?.parts ?? []) {
      if (part.type !== TOOL_USE_PART || !part.id || !part.name || seen.has(part.id)) continue;
      seen.add(part.id);
      const command = isRecord(part.input) && typeof part.input.command === "string" ? part.input.command : null;
      const category = classifyTool(part.name, command);
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }
  }
  return { modelCalls, tools: { total: seen.size, byCategory } };
}

const NO_SIGNALS: FieldRunFacts["inApp"] = {
  victory: null,
  executionStatus: null,
  stopCode: null,
  livenessMax: null,
  scoreboard: null,
};

/** Whether a record registers or starts a run: a turn holding one launched it. */
const startsRun = (event: EventEnvelope): boolean =>
  payloadOf(event, CustomEvent.RunRegistered) !== null || payloadOf(event, CustomEvent.RunStarted) !== null;

/** The last finished turn: from its `turn_started` to its `turn_ended`, inclusive. */
function lastTurn(events: readonly EventEnvelope[]): EventEnvelope[] | null {
  const end = events.findLastIndex((e) => e.data.type === EventKind.TurnEnded);
  if (end < 0) return null;
  const start = events.findLastIndex((e, i) => i < end && e.data.type === EventKind.TurnStarted);
  return start < 0 ? null : events.slice(start, end + 1);
}

/** How a turn ended, from its `turn_ended` status. */
function turnEnding(turn: readonly EventEnvelope[]): EndedHow {
  const data = turn.at(-1)?.data;
  const status = data?.type === EventKind.TurnEnded ? data.status : undefined;
  if (status === "cancelled") return EndedHow.Cancelled;
  if (status === "error") return EndedHow.Crash;
  return EndedHow.AgentFinished;
}

/**
 * The facts of a game chat's last turn when it was a chat-only build: it delegated at least one
 * build and launched no run. Null for a turn that only answered, one that launched a run, and one
 * whose engine or model a row cannot name.
 */
export function turnFacts(
  source: FinishedBuildEvents,
  names: FieldEventNames = FIELD_EVENT_NAMES,
): FieldRunFacts | null {
  const turn = lastTurn(source.events);
  if (!turn || turn.some(startsRun)) return null;
  const builds = payloads(turn, CustomEvent.BuildObservation);
  const lead = leadCalls(turn);
  if (builds.length === 0 || !lead.engine || !lead.model) return null;
  const lastOk = builds.at(-1)?.ok;
  // A run started earlier in this thread may still be working: its records belong to its own row.
  const own = turn.filter((event) => runIdOf(event) === null);
  return {
    engine: lead.engine,
    model: lead.model,
    modeServed: LaneModeServed.ChatOnly,
    launch: LaunchPath.None,
    permissionMode: valueIn(PermissionMode, source.permissionMode) ?? DEFAULT_PERMISSION_MODE,
    endedHow: turnEnding(turn),
    buildOk: typeof lastOk === "boolean" ? lastOk : null,
    time: timingFacts(turn, between(turn[0], turn.at(-1)), 0, names),
    ...tokenFacts(own, lead.readings, names),
    context: contextFacts(own),
    calls: callFacts(own, lead.calls),
    inApp: NO_SIGNALS,
  };
}

/** The launch tool that started the run registered at `index`: the last launch request before it. */
function launchBefore(events: readonly EventEnvelope[], index: number): LaunchPath {
  const launches = [LaunchPath.StartAutopilot, LaunchPath.StartUnattendedRun];
  for (let i = index - 1; i >= 0; i--) {
    const data = events[i]?.data;
    if (data?.type !== EventKind.ToolRequested) continue;
    const name = data.request.name;
    const launch = launches.find((path) => name === path || name.endsWith(`__${path}`));
    if (launch) return launch;
  }
  return LaunchPath.StartAutopilot;
}

/** How a run ended, from its closing record's execution status. */
function runEnding(status: ExecutionStatus | null): EndedHow {
  if (status === ExecutionStatus.Cancelled || status === ExecutionStatus.Paused) return EndedHow.Cancelled;
  if (status === ExecutionStatus.Failed) return EndedHow.Crash;
  return EndedHow.AgentFinished;
}

/** The mode a run served, from the budgets it registered. */
function runMode(start: Payload | undefined): LaneModeServed {
  const budgets = isRecord(start?.budgets) ? start.budgets : {};
  if (budgets.untilSatisfied !== true && finite(budgets.wallClockMs) !== null) return LaneModeServed.AutopilotTimed;
  return LaneModeServed.AutopilotUntilSatisfied;
}

/** The judges' signals a run closed with, as process metrics only. */
function runSignals(events: readonly EventEnvelope[], finished: Payload): FieldRunFacts["inApp"] {
  const board = payloads(events, CustomEvent.FacetIteration).at(-1)?.scoreboard;
  const passing = isRecord(board) ? finite(board.passing) : null;
  const total = isRecord(board) ? finite(board.total) : null;
  const regressions = isRecord(board) && Array.isArray(board.regressions) ? board.regressions.length : 0;
  const stopCode = typeof finished.stopCode === "string" && FIELD_STOP_CODE_PATTERN.test(finished.stopCode);
  return {
    victory: typeof finished.victory === "boolean" ? finished.victory : null,
    executionStatus: valueIn(ExecutionStatus, finished.executionStatus),
    stopCode: stopCode ? (finished.stopCode as string) : null,
    livenessMax: maxOf(payloads(events, CustomEvent.FacetLiveness).map((p) => finite(p.total))),
    scoreboard: passing !== null && total !== null ? { passing, total, regressions } : null,
  };
}

/** The first model a run's own records name: its planner's context readings, then its builds. */
function runModel(events: readonly EventEnvelope[]): string | null {
  const named = [
    ...payloads(events, CustomEvent.ContextUsage).map((p) => p.model),
    ...payloads(events, CustomEvent.BuildObservation).map((p) => p.model),
  ];
  return named.map(fieldModel).find((model) => model !== null) ?? null;
}

/**
 * The facts of a run the chat launched, once its `run_finished` is in the log: its own records
 * (those carrying its `runId`) and the launch request before it. Null while it has not finished,
 * and when its engine or model cannot be named.
 */
export function runFacts(
  source: FinishedBuildEvents,
  runId: string,
  names: FieldEventNames = FIELD_EVENT_NAMES,
): FieldRunFacts | null {
  const own = source.events.filter((event) => runIdOf(event) === runId);
  const closing = own.findLast((event) => payloadOf(event, CustomEvent.RunFinished) !== null);
  const finished = closing ? payloadOf(closing, CustomEvent.RunFinished) : null;
  const start = startOf(own);
  const engine = valueIn(EngineId, start?.engine);
  const model = runModel(own);
  if (!finished || !engine || !model) return null;
  const inApp = runSignals(own, finished);
  const wallMs = finite(finished.durationMs) ?? between(own[0], closing);
  const facetBuilds = payloads(own, CustomEvent.FacetBuildStarted).length;
  return {
    engine,
    model,
    modeServed: runMode(start),
    launch: launchBefore(source.events, source.events.indexOf(own[0] as EventEnvelope)),
    permissionMode: valueIn(PermissionMode, source.permissionMode) ?? DEFAULT_PERMISSION_MODE,
    endedHow: runEnding(inApp.executionStatus),
    buildOk: inApp.victory,
    time: timingFacts(own, wallMs, facetBuilds, names),
    ...tokenFacts(own, [], names),
    context: contextFacts(own),
    calls: callFacts(own, 0),
    inApp,
  };
}

/** The log reads the facts need: a chat's record and events, and the threads of a game. */
export type FactsStore = Pick<EventStore, "getRecord" | "listThreads" | "listEvents">;

const metadataOf = (record: ConversationRecord): Payload => record.metadata ?? {};

/**
 * The records after the queue took message `messageId` (its last `coordinator_message_processing`):
 * where that message's own turn is, if it opened one. Null when the log never shows it taken.
 */
function sinceTaken(events: readonly EventEnvelope[], messageId: string): readonly EventEnvelope[] | null {
  const taken = events.findLastIndex(
    (event) => payloadOf(event, CustomEvent.CoordinatorMessageProcessing)?.messageId === messageId,
  );
  return taken < 0 ? null : events.slice(taken + 1);
}

/**
 * The facts of a finished build, read from the log: the turn a game chat's handled message opened,
 * or a run found in the threads of its game. Null for the Studio's own chat, for a handled message
 * that opened no turn (an earlier turn is never shared again), and for anything that was no build.
 */
export async function readFinishedFacts(
  store: FactsStore,
  ref: FinishedBuildRef,
  names: FieldEventNames = FIELD_EVENT_NAMES,
): Promise<FieldRunFacts | null> {
  if ("threadId" in ref) {
    const metadata = metadataOf(await store.getRecord(ref.threadId));
    if (metadata.kind !== ThreadKind.Game) return null;
    const events = sinceTaken(await store.listEvents(ref.threadId), ref.messageId);
    return events && turnFacts({ events, permissionMode: metadata.permissionMode }, names);
  }
  const threads = (await store.listThreads()).filter((thread) => {
    const metadata = metadataOf(thread);
    return metadata.kind === ThreadKind.Game && metadata.project === ref.project;
  });
  for (const thread of threads) {
    const source = { events: await store.listEvents(thread.id), permissionMode: metadataOf(thread).permissionMode };
    const facts = runFacts(source, ref.runId, names);
    if (facts) return facts;
  }
  return null;
}

/** The run a custom record belongs to, when it names one. */
function runIdOf(event: EventEnvelope): string | null {
  const { data } = event;
  if (data.type !== EventKind.Custom || !isRecord(data.payload)) return null;
  return typeof data.payload.runId === "string" ? data.payload.runId : null;
}

/** A run's start: its `run_registered` fields overlaid by its `run_started` (the engine and budgets). */
function startOf(own: readonly EventEnvelope[]): Payload | undefined {
  const registered = payloads(own, CustomEvent.RunRegistered)[0];
  const started = payloads(own, CustomEvent.RunStarted)[0];
  return registered || started ? { ...registered, ...started } : undefined;
}
