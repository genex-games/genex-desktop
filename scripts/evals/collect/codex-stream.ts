/**
 * The Codex stream collector: `codex exec --json`, as the lane runner stored it with a receive
 * time on every line (Rule 12), into timeline events.
 *
 * - `thread.started` names the main thread, which `codex-subagents.ts` chains rollouts to.
 * - `turn.completed` carries the turn's usage. Codex's `input_tokens` INCLUDES the cached tokens
 *   (Anthropic's does not), so the normalized shape takes them out; `reasoning_output_tokens` is
 *   already inside `output_tokens` and is recorded, never added (Rule 13).
 * - `item.*`: `command_execution` (classified after `unwrapShell`), `file_change`,
 *   `mcp_tool_call`, `web_search` and `todo_list` are tool calls; `reasoning` and
 *   `agent_message` are not. A started item pairs with its completion by item id.
 * - `error` and `turn.failed` are typed errors; their message text is never matched.
 *
 * The stream names no model and carries no per-response usage: the main-loop model and the model
 * calls come from the rollouts (`codex-subagents.ts`).
 */
import type { TokenUsage } from "../../../src/shared/eval-lane.ts";
import { numberField, parseStampedStream, recordField, stringField, type StampedLine } from "./honesty.ts";
import type { ObservationEvent, SessionRef, ToolCallEvent } from "./observation.ts";
import type { StreamReading } from "./observe.ts";
import { classifyTool, isLookAtPage } from "../../../src/shared/tool-category.ts";
import { addUsage } from "./usage.ts";
import {
  LifecyclePhase,
  ObservationEventKind,
  ObservationSource,
  ObservedErrorKind,
  PreviewSignal,
  ServedModelRole,
  ToolCategory,
} from "../vocabulary.ts";

export { unwrapShell } from "../../../src/shared/tool-category.ts";

/** The stream's event types (Codex's wire spelling). */
const StreamEvent = {
  ThreadStarted: "thread.started",
  TurnCompleted: "turn.completed",
  TurnFailed: "turn.failed",
  Error: "error",
  ItemStarted: "item.started",
  ItemUpdated: "item.updated",
  ItemCompleted: "item.completed",
} as const;

/** The item types that are tool calls, and the tool name each is recorded under. */
const ItemType = {
  CommandExecution: "command_execution",
  FileChange: "file_change",
  McpToolCall: "mcp_tool_call",
  WebSearch: "web_search",
  TodoList: "todo_list",
} as const;
const TOOL_ITEMS: ReadonlySet<string> = new Set(Object.values(ItemType));
const FAILED_STATUS = "failed";

interface CodexState {
  promptAtMs: number;
  threadId: string | null;
  tools: Map<string, ToolCallEvent>;
  events: ObservationEvent[];
  usage: TokenUsage | null;
  sawTerminal: boolean;
  lastAtMs: number | null;
}

const count = (record: Record<string, unknown> | null, key: string) => numberField(record, key) ?? 0;

/** Codex usage as the normalized shape: cached tokens are taken out of `input_tokens` (Rule 13). */
export function codexUsage(usage: Record<string, unknown> | null): TokenUsage {
  const input = count(usage, "input_tokens");
  const cached = count(usage, "cached_input_tokens");
  return {
    uncachedInput: Math.max(0, input - cached),
    cacheWrite: count(usage, "cache_write_input_tokens"),
    cacheRead: cached,
    output: count(usage, "output_tokens"),
    reasoning: count(usage, "reasoning_output_tokens"),
  };
}

const mainSession = (state: CodexState): SessionRef => ({
  sessionId: state.threadId ?? "",
  parentSessionId: null,
  role: ServedModelRole.Main,
});

function toolName(item: Record<string, unknown>): string {
  const type = stringField(item, "type") ?? "";
  if (type !== ItemType.McpToolCall) return type;
  return `mcp__${stringField(item, "server") ?? "unknown"}__${stringField(item, "tool") ?? "unknown"}`;
}

function itemFailed(item: Record<string, unknown>): boolean {
  const exit = numberField(item, "exit_code");
  if (exit !== null) return exit !== 0;
  return stringField(item, "status") === FAILED_STATUS || item.error != null;
}

function startTool(state: CodexState, item: Record<string, unknown>, id: string, atMs: number): ToolCallEvent {
  const command = stringField(item, "command");
  const name = toolName(item);
  const call: ToolCallEvent = {
    kind: ObservationEventKind.ToolCall,
    atMs,
    source: ObservationSource.Stream,
    id,
    session: mainSession(state),
    name,
    category: name === ItemType.WebSearch ? ToolCategory.Web : classifyTool(name, command),
    endMs: null,
    ok: null,
  };
  state.tools.set(id, call);
  if (command !== null && isLookAtPage(command)) {
    state.events.push({
      kind: ObservationEventKind.PreviewSignal,
      atMs,
      source: ObservationSource.Stream,
      signal: PreviewSignal.LookAtPage,
    });
  }
  return call;
}

function readItem(state: CodexState, event: Record<string, unknown>, atMs: number): void {
  const item = recordField(event, "item");
  const id = stringField(item, "id");
  if (!item || !id || !TOOL_ITEMS.has(stringField(item, "type") ?? "")) return;
  const call = state.tools.get(id) ?? startTool(state, item, id, atMs);
  if (stringField(event, "type") !== StreamEvent.ItemCompleted) return;
  call.endMs = atMs;
  call.ok = !itemFailed(item);
}

function pushError(state: CodexState, atMs: number): void {
  state.events.push({
    kind: ObservationEventKind.Error,
    atMs,
    source: ObservationSource.Stream,
    error: ObservedErrorKind.ApiError,
    httpStatus: null,
    session: null,
  });
}

function readLine(state: CodexState, line: StampedLine): void {
  const atMs = line.receivedAtMs - state.promptAtMs;
  state.lastAtMs = atMs;
  const type = stringField(line.event, "type");
  if (type === StreamEvent.ThreadStarted) state.threadId = stringField(line.event, "thread_id");
  if (type === StreamEvent.TurnCompleted) {
    const usage = codexUsage(recordField(line.event, "usage"));
    state.usage = state.usage ? addUsage(state.usage, usage) : usage;
    state.sawTerminal = true;
    state.events.push({
      kind: ObservationEventKind.Lifecycle,
      atMs,
      source: ObservationSource.Stream,
      phase: LifecyclePhase.Idle,
    });
  }
  if (type === StreamEvent.TurnFailed) state.sawTerminal = true;
  if (type === StreamEvent.TurnFailed || type === StreamEvent.Error) pushError(state, atMs);
  const isItem =
    type === StreamEvent.ItemStarted || type === StreamEvent.ItemUpdated || type === StreamEvent.ItemCompleted;
  if (isItem) readItem(state, line.event, atMs);
}

/**
 * Read a stored Codex stream. `promptAtMs` is the epoch time the prompt was submitted. Usage is
 * summed over the stream's `turn.completed` lines.
 */
export function readCodexStream(text: string, promptAtMs: number): StreamReading {
  const stream = parseStampedStream(text);
  const state: CodexState = {
    promptAtMs,
    threadId: null,
    tools: new Map(),
    events: [],
    usage: null,
    sawTerminal: false,
    lastAtMs: null,
  };
  for (const line of stream.lines) readLine(state, line);
  for (const call of state.tools.values()) call.session = mainSession(state);
  return {
    sessionId: state.threadId,
    events: [...state.tools.values(), ...state.events],
    servedMain: null,
    effortServed: null,
    cliVersion: null,
    streamTokens: state.usage,
    cliReportedUsd: null,
    modelUsage: {},
    trace: { parseFailures: stream.parseFailures, partialTail: stream.partialTail, sawTerminal: state.sawTerminal },
    lastAtMs: state.lastAtMs,
  };
}
