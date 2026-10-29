/**
 * The Claude stream collector: `claude -p --output-format stream-json --verbose`, as the lane
 * runner stored it with a receive time on every line (Rule 12), into timeline events.
 *
 * - `system/init`: the main-loop model (Rule 16), tools, MCP servers, skills and CLI version.
 * - `assistant`: one model call per `message.id` (Rule 13). The CLI writes a message once per
 *   content block and its `output_tokens` there is the value at stream start, so each field keeps
 *   its maximum across the id's lines; the authoritative totals are the `result` line's.
 *   Messages under a `parent_tool_use_id` are a sub-agent's; `<synthetic>` messages are the CLI's
 *   own error notes, not model calls.
 * - `tool_use` blocks pair with `tool_result` by id, which gives the call's end and outcome.
 * - `result`: main-loop `usage` (with thinking tokens), `modelUsage` for every model (the Haiku
 *   helper included), cost, durations, turns, `api_error_status`, `terminal_reason`,
 *   permission denials.
 * - `compact_boundary`, `api_retry` and a rejected `rate_limit_event` become their own events.
 */
import type { TokenUsage } from "../../../src/shared/eval-lane.ts";
import { untaggedModelId } from "../../../src/shared/model-id.ts";
import {
  CollectError,
  CollectErrorCode,
  arrayField,
  asRecord,
  numberField,
  parseStampedStream,
  recordField,
  stringField,
  type StampedLine,
} from "./honesty.ts";
import type { ModelCallEvent, ObservationEvent, SessionRef, ToolCallEvent } from "./observation.ts";
import type { ModelUsageReading, StreamReading } from "./observe.ts";
import { LOOK_AT_PAGE_COMMAND, classifyTool, commandHead } from "../../../src/shared/tool-category.ts";
import { addUsage, maxUsage, promptTokens } from "./usage.ts";
import {
  LifecyclePhase,
  ObservationEventKind,
  ObservationSource,
  ObservedErrorKind,
  PreviewSignal,
  ServedModelRole,
} from "../vocabulary.ts";

/** The model name Claude Code gives the error notes it writes into the stream itself. */
const SYNTHETIC_MODEL = "<synthetic>";
/** The rate-limit status that means the request was refused. */
const RATE_LIMIT_REJECTED = "rejected";
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;

/** The stream's line types and subtypes this collector reads (Claude Code's wire spelling). */
const Line = {
  System: "system",
  Assistant: "assistant",
  User: "user",
  Result: "result",
  RateLimit: "rate_limit_event",
} as const;
const Subtype = {
  Init: "init",
  CompactBoundary: "compact_boundary",
  ApiRetry: "api_retry",
} as const;
const Block = { ToolUse: "tool_use", ToolResult: "tool_result" } as const;

/** What `system/init` said. */
export interface ClaudeInit {
  model: string | null;
  tools: string[];
  mcpServers: string[];
  skills: string[];
  cliVersion: string | null;
  sessionId: string | null;
}

/** What one `result` line said. */
export interface ClaudeResult {
  subtype: string | null;
  isError: boolean;
  terminalReason: string | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  apiErrorStatus: number | null;
  permissionDenials: number;
  totalCostUsd: number | null;
}

/** The Claude stream as timeline events plus the facts its init and result lines carry. */
export interface ClaudeStreamReading extends StreamReading {
  init: ClaudeInit | null;
  results: ClaudeResult[];
}

interface ClaudeState {
  promptAtMs: number;
  calls: Map<string, ModelCallEvent>;
  tools: Map<string, ToolCallEvent>;
  events: ObservationEvent[];
  inits: ClaudeInit[];
  results: ClaudeResult[];
  resultUsage: TokenUsage | null;
  modelUsage: Record<string, ModelUsageReading>;
  assistantLines: number;
  lastAtMs: number | null;
}

const strings = (values: unknown[]): string[] => values.filter((v): v is string => typeof v === "string");
const count = (record: Record<string, unknown> | null, key: string) => numberField(record, key) ?? 0;

/** Anthropic's usage as the normalized shape: `input_tokens` excludes cached tokens (Rule 13). */
export function claudeUsage(usage: Record<string, unknown> | null): TokenUsage {
  return {
    uncachedInput: count(usage, "input_tokens"),
    cacheWrite: count(usage, "cache_creation_input_tokens"),
    cacheRead: count(usage, "cache_read_input_tokens"),
    output: count(usage, "output_tokens"),
    reasoning: count(recordField(usage, "output_tokens_details"), "thinking_tokens"),
  };
}

function sessionOf(event: Record<string, unknown>): SessionRef {
  const sessionId = stringField(event, "session_id") ?? "";
  const parent = stringField(event, "parent_tool_use_id");
  if (parent) return { sessionId: parent, parentSessionId: sessionId, role: ServedModelRole.Subagent };
  return { sessionId, parentSessionId: null, role: ServedModelRole.Main };
}

function readInit(state: ClaudeState, event: Record<string, unknown>): void {
  const servers = arrayField(event, "mcp_servers").map((server) => stringField(asRecord(server), "name"));
  state.inits.push({
    model: stringField(event, "model"),
    tools: strings(arrayField(event, "tools")),
    mcpServers: strings(servers),
    skills: strings(arrayField(event, "skills")),
    cliVersion: stringField(event, "claude_code_version"),
    sessionId: stringField(event, "session_id"),
  });
}

function readSystem(state: ClaudeState, event: Record<string, unknown>, atMs: number): void {
  const subtype = stringField(event, "subtype");
  if (subtype === Subtype.Init) readInit(state, event);
  if (subtype === Subtype.CompactBoundary) {
    state.events.push({
      kind: ObservationEventKind.Compaction,
      atMs,
      source: ObservationSource.Stream,
      session: sessionOf(event),
    });
  }
  if (subtype === Subtype.ApiRetry) {
    const attempt = numberField(event, "attempt") ?? 1;
    state.events.push({
      kind: ObservationEventKind.Retry,
      atMs,
      source: ObservationSource.Stream,
      attempt,
      session: null,
    });
  }
}

function recordCall(
  state: ClaudeState,
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  atMs: number,
) {
  const id = stringField(message, "id");
  const model = stringField(message, "model");
  if (!id || !model || model === SYNTHETIC_MODEL) return;
  const usage = claudeUsage(recordField(message, "usage"));
  const known = state.calls.get(id);
  if (known) {
    known.usage = maxUsage(known.usage, usage);
    known.contextTokens = promptTokens(known.usage);
    known.endMs = atMs;
    return;
  }
  state.calls.set(id, {
    kind: ObservationEventKind.ModelCall,
    atMs,
    source: ObservationSource.Stream,
    id,
    session: sessionOf(event),
    model,
    usage,
    contextTokens: promptTokens(usage),
    contextWindow: null,
    effortServed: null,
    endMs: atMs,
    ttftMs: null,
  });
}

function recordToolUse(state: ClaudeState, session: SessionRef, block: Record<string, unknown>, atMs: number): void {
  const id = stringField(block, "id");
  const name = stringField(block, "name");
  if (!id || !name || state.tools.has(id)) return;
  const command = stringField(recordField(block, "input"), "command");
  const category = classifyTool(name, command);
  state.tools.set(id, {
    kind: ObservationEventKind.ToolCall,
    atMs,
    source: ObservationSource.Stream,
    id,
    session,
    name,
    category,
    endMs: null,
    ok: null,
  });
  if (command !== null && commandHead(command) === LOOK_AT_PAGE_COMMAND) {
    state.events.push({
      kind: ObservationEventKind.PreviewSignal,
      atMs,
      source: ObservationSource.Stream,
      signal: PreviewSignal.LookAtPage,
    });
  }
}

function readAssistant(state: ClaudeState, event: Record<string, unknown>, atMs: number): void {
  const message = recordField(event, "message");
  if (!message) return;
  state.assistantLines += 1;
  recordCall(state, event, message, atMs);
  const session = sessionOf(event);
  for (const block of arrayField(message, "content")) {
    const record = asRecord(block);
    if (stringField(record, "type") === Block.ToolUse && record) recordToolUse(state, session, record, atMs);
  }
}

function readUser(state: ClaudeState, event: Record<string, unknown>, atMs: number): void {
  for (const block of arrayField(recordField(event, "message"), "content")) {
    const record = asRecord(block);
    if (stringField(record, "type") !== Block.ToolResult) continue;
    const call = state.tools.get(stringField(record, "tool_use_id") ?? "");
    if (!call || call.endMs !== null) continue;
    call.endMs = atMs;
    call.ok = record?.is_error !== true;
  }
}

function errorKindOf(status: number): ObservedErrorKind {
  if (status === HTTP_TOO_MANY_REQUESTS) return ObservedErrorKind.RateLimited;
  if (status === HTTP_UNAUTHORIZED) return ObservedErrorKind.AuthExpired;
  return ObservedErrorKind.ApiError;
}

function readModelUsage(state: ClaudeState, modelUsage: Record<string, unknown> | null): void {
  for (const [reported, value] of Object.entries(modelUsage ?? {})) {
    const model = untaggedModelId(reported);
    const row = asRecord(value);
    const reasoning = numberField(row, "thinkingTokens") ?? numberField(row, "reasoningOutputTokens") ?? 0;
    const usage: TokenUsage = {
      uncachedInput: count(row, "inputTokens"),
      cacheWrite: count(row, "cacheCreationInputTokens"),
      cacheRead: count(row, "cacheReadInputTokens"),
      output: count(row, "outputTokens"),
      reasoning,
    };
    const known = state.modelUsage[model];
    state.modelUsage[model] = {
      usage: known ? addUsage(known.usage, usage) : usage,
      contextWindow: numberField(row, "contextWindow") ?? known?.contextWindow ?? null,
    };
  }
}

function readResult(state: ClaudeState, event: Record<string, unknown>, atMs: number): void {
  const apiErrorStatus = numberField(event, "api_error_status");
  const usage = claudeUsage(recordField(event, "usage"));
  state.resultUsage = state.resultUsage ? addUsage(state.resultUsage, usage) : usage;
  readModelUsage(state, recordField(event, "modelUsage"));
  state.results.push({
    subtype: stringField(event, "subtype"),
    isError: event.is_error === true,
    terminalReason: stringField(event, "terminal_reason"),
    numTurns: numberField(event, "num_turns"),
    durationMs: numberField(event, "duration_ms"),
    durationApiMs: numberField(event, "duration_api_ms"),
    apiErrorStatus,
    permissionDenials: arrayField(event, "permission_denials").length,
    totalCostUsd: numberField(event, "total_cost_usd"),
  });
  state.events.push({
    kind: ObservationEventKind.Lifecycle,
    atMs,
    source: ObservationSource.Stream,
    phase: LifecyclePhase.Idle,
  });
  if (apiErrorStatus === null) return;
  state.events.push({
    kind: ObservationEventKind.Error,
    atMs,
    source: ObservationSource.Stream,
    error: errorKindOf(apiErrorStatus),
    httpStatus: apiErrorStatus,
    session: null,
  });
}

function readRateLimit(state: ClaudeState, event: Record<string, unknown>, atMs: number): void {
  if (stringField(recordField(event, "rate_limit_info"), "status") !== RATE_LIMIT_REJECTED) return;
  state.events.push({
    kind: ObservationEventKind.Error,
    atMs,
    source: ObservationSource.Stream,
    error: ObservedErrorKind.RateLimited,
    httpStatus: null,
    session: null,
  });
}

const READERS: Readonly<Record<string, (state: ClaudeState, event: Record<string, unknown>, atMs: number) => void>> = {
  [Line.System]: readSystem,
  [Line.Assistant]: readAssistant,
  [Line.User]: readUser,
  [Line.Result]: readResult,
  [Line.RateLimit]: readRateLimit,
};

function readLine(state: ClaudeState, line: StampedLine): void {
  const atMs = line.receivedAtMs - state.promptAtMs;
  state.lastAtMs = atMs;
  READERS[stringField(line.event, "type") ?? ""]?.(state, line.event, atMs);
}

function fillContextWindows(state: ClaudeState): void {
  for (const call of state.calls.values())
    call.contextWindow = state.modelUsage[untaggedModelId(call.model)]?.contextWindow ?? null;
}

/**
 * Read a stored Claude stream. `promptAtMs` is the epoch time the prompt was submitted; every
 * event's `atMs` is its receive time after it. Throws `vacuous-model-calls` when the stream had
 * assistant lines but none of them was a model call.
 */
export function readClaudeStream(text: string, promptAtMs: number): ClaudeStreamReading {
  const stream = parseStampedStream(text);
  const state: ClaudeState = {
    promptAtMs,
    calls: new Map(),
    tools: new Map(),
    events: [],
    inits: [],
    results: [],
    resultUsage: null,
    modelUsage: {},
    assistantLines: 0,
    lastAtMs: null,
  };
  for (const line of stream.lines) readLine(state, line);
  if (state.assistantLines > 0 && state.calls.size === 0)
    throw new CollectError(CollectErrorCode.VacuousModelCalls, "claude stream");
  fillContextWindows(state);
  const init = state.inits[0] ?? null;
  const costs = state.results.map((result) => result.totalCostUsd).filter((usd): usd is number => usd !== null);
  return {
    sessionId: init?.sessionId ?? null,
    events: [...state.calls.values(), ...state.tools.values(), ...state.events],
    servedMain: init?.model ?? null,
    effortServed: null,
    cliVersion: init?.cliVersion ?? null,
    streamTokens: state.resultUsage,
    cliReportedUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    modelUsage: state.modelUsage,
    trace: {
      parseFailures: stream.parseFailures,
      partialTail: stream.partialTail,
      sawTerminal: state.results.length > 0,
    },
    lastAtMs: state.lastAtMs,
    init,
    results: state.results,
  };
}
