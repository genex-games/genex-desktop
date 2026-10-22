/**
 * One Codex delegation turn on the app server (`codex app-server`, JSON-RPC over stdio), with the
 * studio's tools declared as Codex dynamic tools (`codex-dynamic-tools.ts`) instead of the file
 * bridge. Opt-in and experimental: `codex.ts` chooses it, and falls back to `codex exec` and the
 * bridge whenever it cannot be had.
 *
 * Opening a turn is the handshake: `initialize` with the experimental API (the capability
 * `dynamicTools` is gated on), `initialized`, then `thread/start` carrying the tools. A refusal
 * there (an older or differently built CLI) is reported, never thrown, so the caller can fall
 * back before anything has run. Running it is `turn/start` and the conversation after: each
 * `item/tool/call` is answered by the studio's handler, every other server request is declined,
 * and the notifications are written as the very events `codex exec --json` prints
 * (`codex-exec-events.ts`), so one translation reads both paths. A stop sends `turn/interrupt`
 * and closes the server; closing it is what ends the process.
 *
 * Wire shapes as `codex app-server generate-json-schema --experimental` prints them for CLI 0.159.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { AppServerMethod, CLIENT_INFO, type CodexAppServerConnection } from "./codex-app-server.ts";
import { CodexEvent, CodexItem, CodexItemStatus } from "./codex-exec-events.ts";
import {
  type DynamicToolCall,
  type DynamicToolCallResponse,
  type DynamicToolSpec,
  dynamicToolResponse,
  parseDynamicToolCall,
} from "./codex-dynamic-tools.ts";
import type { LiveToolResult } from "./types.ts";

/** The id of each request a turn sends: one of each, in this order. */
const TurnRequestId = {
  Initialize: 1,
  ThreadStart: 2,
  TurnStart: 3,
  TurnInterrupt: 4,
} as const;

/** JSON-RPC's code for a method the receiver does not handle. */
const METHOD_NOT_FOUND = -32601;
/**
 * How long the handshake (initialize and thread/start) may take before the server counts as
 * refusing: it runs before any deadline of the delegation's own, and a server that cannot answer
 * it is not going to run a turn.
 */
export const HANDSHAKE_TIMEOUT_MS = 30 * SECOND_MS;

/** The thread's sandbox mode on `thread/start`, as the app server spells it (`SandboxMode`). */
const SandboxMode = {
  WorkspaceWrite: "workspace-write",
  DangerFullAccess: "danger-full-access",
} as const;

/** A turn's sandbox policy type on `turn/start`, as the app server spells it (`SandboxPolicy`). */
const SandboxPolicyType = {
  WorkspaceWrite: "workspaceWrite",
  DangerFullAccess: "dangerFullAccess",
} as const;

/** The parts of a turn's input the studio sends (`UserInput`). */
const UserInputType = {
  Text: "text",
  LocalImage: "localImage",
} as const;

/** Nobody is there to approve: a command the sandbox refuses fails honestly (`AskForApproval`). */
const APPROVAL_NEVER = "never";

/** A turn's status on `turn/completed`, as the app server spells it. */
const TurnStatus = {
  Completed: "completed",
  Interrupted: "interrupted",
  Failed: "failed",
} as const;

/** A thread item's status, as the app server spells it. */
const ItemStatus = {
  InProgress: "inProgress",
  Completed: "completed",
  Failed: "failed",
  Declined: "declined",
} as const;

/** The thread item types a turn mirrors, as the app server spells them. */
const AppServerItem = {
  AgentMessage: "agentMessage",
  Reasoning: "reasoning",
  CommandExecution: "commandExecution",
  FileChange: "fileChange",
  McpToolCall: "mcpToolCall",
  DynamicToolCall: "dynamicToolCall",
  WebSearch: "webSearch",
} as const;

/**
 * How each approval the server might ask for is declined. The thread runs with `never`, so none
 * should come; one that does is answered "no" in its own vocabulary, never left hanging.
 */
const DECLINES: Partial<Record<AppServerMethod, Record<string, unknown>>> = {
  [AppServerMethod.CommandApproval]: { decision: "decline" },
  [AppServerMethod.FileChangeApproval]: { decision: "decline" },
  [AppServerMethod.ExecCommandApproval]: { decision: "denied" },
  [AppServerMethod.ApplyPatchApproval]: { decision: "denied" },
  [AppServerMethod.Elicitation]: { action: "decline" },
};

const MESSAGE = {
  Closed: "Codex's app server closed before it answered",
  ClosedMidTurn: "Codex's app server closed before the turn finished",
  NoThread: "Codex's app server started no thread",
  Refused: "Codex's app server refused the request",
  TurnFailed: "the contractor stopped",
  Interrupted: "Codex interrupted the turn",
  NotHandled: (method: string) => `Genex does not answer ${method}`,
  ToolFailed: (name: string, why: string) => `${name} failed: ${why}`,
} as const;

/** A message on the wire. */
type Message = Record<string, unknown>;
/** The studio's handler for one tool call. */
export type CodexToolHandler = (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>;

/** What a turn needs from the engine: the thread to start (tools included), its tool names, the stop. */
export interface CodexTurnSetup {
  /** `thread/start` params: cwd, model, sandbox, approvals and `dynamicTools`. */
  thread: Record<string, unknown>;
  /** The names declared in `dynamicTools`: the only tools a call may name. */
  tools: ReadonlySet<string>;
  signal: AbortSignal;
  /** The handshake's ceiling; {@link HANDSHAKE_TIMEOUT_MS} when unset. A test seam. */
  handshakeTimeoutMs?: number;
}

/** What decides a turn's thread and sandbox: where it runs, on which model, how confined, with what tools. */
export interface TurnPolicy {
  /** The folder the session starts in, and the one folder a confined session may write. */
  cwd: string;
  model?: string | undefined;
  /** The person's Bypass for their chat: no sandbox, no approvals. */
  bypass: boolean;
}

/**
 * `thread/start` for a turn with the studio's tools: the same confinement `codex exec` gets for
 * the request (a workspace-write sandbox that never asks, or the person's Bypass), and the tools.
 */
export function threadStartParams(policy: TurnPolicy & { tools: DynamicToolSpec[] }): Record<string, unknown> {
  return {
    cwd: policy.cwd,
    ...(policy.model ? { model: policy.model } : {}),
    approvalPolicy: APPROVAL_NEVER,
    sandbox: policy.bypass ? SandboxMode.DangerFullAccess : SandboxMode.WorkspaceWrite,
    dynamicTools: policy.tools,
  };
}

/**
 * `turn/start`'s params besides the thread: the brief, the stills as local images, and the
 * sandbox exec's `-c` config spells (one writable root, no network), restated for this turn.
 */
export function turnStartParams(
  policy: TurnPolicy,
  prompt: string,
  images: readonly string[],
): Record<string, unknown> {
  const sandboxPolicy = policy.bypass
    ? { type: SandboxPolicyType.DangerFullAccess }
    : { type: SandboxPolicyType.WorkspaceWrite, writableRoots: [policy.cwd], networkAccess: false };
  return {
    input: [
      { type: UserInputType.Text, text: prompt },
      ...images.map((file) => ({ type: UserInputType.LocalImage, path: file })),
    ],
    approvalPolicy: APPROVAL_NEVER,
    sandboxPolicy,
  };
}

/** A thread open on the app server with the studio's tools, ready for its one turn. */
export interface CodexDynamicTurn {
  readonly threadId: string;
  /** Every tool call the model made, in order: the record interview tools are read from. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** `turn/start` with these params, as the events `codex exec --json` would have printed. */
  run(turn: Record<string, unknown>, onToolCall: CodexToolHandler): AsyncIterable<Message>;
  /** Close the server, which ends its process. Safe to call twice. */
  close(): void;
}

/** An open turn, or why the app server would not open one (nothing ran). */
export type CodexTurnOpening = { ok: true; turn: CodexDynamicTurn } | { ok: false; error: string };

/** One connection as a turn holds it: one reader for its whole life, and whether it is closed. */
interface Link {
  server: CodexAppServerConnection;
  messages: AsyncIterator<Message>;
  closed: boolean;
  /** The turn in progress, once `turn/start` answered: what a stop interrupts. */
  turnId: string | null;
  threadId: string | null;
  stop: () => void;
}

/** What one running turn reads its messages against. */
interface TurnContext {
  threadId: string;
  tools: ReadonlySet<string>;
  calls: CodexDynamicTurn["calls"];
  onToolCall: CodexToolHandler;
}

/** What a turn has heard so far: the reply text by item, and the latest token count. */
interface TurnState {
  replies: Map<string, string>;
  usage: Message | null;
}

const isRecord = (value: unknown): value is Message =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown): Message => (isRecord(value) ? value : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function request(id: number, method: string, params: Record<string, unknown>): Message {
  return { id, method, params };
}

function send(link: Link, message: Message): void {
  if (!link.closed) link.server.send(message);
}

function closeLink(link: Link, signal: AbortSignal): void {
  signal.removeEventListener("abort", link.stop);
  if (link.closed) return;
  link.closed = true;
  link.server.close();
}

async function nextMessage(link: Link): Promise<Message | null> {
  if (link.closed) return null;
  const step = await link.messages.next();
  return step.done ? null : step.value;
}

/** A request the server sent the client: it has a method and an id to answer to. */
function isServerRequest(message: Message): boolean {
  const hasId = message.id !== undefined && message.id !== null;
  return hasId && typeof message.method === "string";
}

/** Every server request but a tool call, answered "no" in its own vocabulary or as not handled. */
function declineRequest(link: Link, message: Message): void {
  const method = String(message.method);
  const decline = DECLINES[method as AppServerMethod];
  if (decline) send(link, { id: message.id, result: decline });
  else send(link, { id: message.id, error: { code: METHOD_NOT_FOUND, message: MESSAGE.NotHandled(method) } });
}

/** Waits for the answer to request `id`, declining whatever the server asks meanwhile. */
async function awaitResponse(link: Link, id: number): Promise<Message | null> {
  for (;;) {
    const message = await nextMessage(link);
    if (!message) return null;
    if (isServerRequest(message)) declineRequest(link, message);
    else if (message.id === id) return message;
  }
}

/** Why an answer is not a success: closed, or the server's own words; null when it succeeded. */
function responseError(message: Message | null): string | null {
  if (!message) return MESSAGE.Closed;
  if (message.error === undefined) return null;
  return text(record(message.error).message) || MESSAGE.Refused;
}

/**
 * Opens a thread with the studio's tools: the handshake opts into the experimental API, then
 * `thread/start`. A refusal, a closed server or a stop closes the server and says so; nothing ran.
 */
export async function openCodexTurn(
  server: CodexAppServerConnection,
  setup: CodexTurnSetup,
): Promise<CodexTurnOpening> {
  const link: Link = {
    server,
    messages: server.messages[Symbol.asyncIterator](),
    closed: false,
    turnId: null,
    threadId: null,
    stop: () => {},
  };
  link.stop = () => stopTurn(link, setup.signal);
  if (setup.signal.aborted) link.stop();
  else setup.signal.addEventListener("abort", link.stop, { once: true });
  // A server that never answers is closed, which ends its stream: the handshake reads as refused.
  const ceiling = setTimeout(() => closeLink(link, setup.signal), setup.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  try {
    return await handshake(link, setup);
  } finally {
    clearTimeout(ceiling);
  }
}

/** `initialize` (opting into the experimental API), `initialized`, then `thread/start`. */
async function handshake(link: Link, setup: CodexTurnSetup): Promise<CodexTurnOpening> {
  const capabilities = { experimentalApi: true };
  send(link, request(TurnRequestId.Initialize, AppServerMethod.Initialize, { clientInfo: CLIENT_INFO, capabilities }));
  const initError = responseError(await awaitResponse(link, TurnRequestId.Initialize));
  if (initError) return refused(link, setup.signal, initError);
  send(link, { method: AppServerMethod.Initialized });
  send(link, request(TurnRequestId.ThreadStart, AppServerMethod.ThreadStart, setup.thread));
  const started = await awaitResponse(link, TurnRequestId.ThreadStart);
  const startError = responseError(started);
  if (startError) return refused(link, setup.signal, startError);
  const threadId = text(record(record(started?.result).thread).id);
  if (!threadId) return refused(link, setup.signal, MESSAGE.NoThread);
  link.threadId = threadId;
  return { ok: true, turn: dynamicTurn(link, threadId, setup) };
}

function refused(link: Link, signal: AbortSignal, error: string): CodexTurnOpening {
  closeLink(link, signal);
  return { ok: false, error };
}

/** A stop: the turn in progress is interrupted, then the server is closed. */
function stopTurn(link: Link, signal: AbortSignal): void {
  if (link.turnId && link.threadId) {
    const params = { threadId: link.threadId, turnId: link.turnId };
    send(link, request(TurnRequestId.TurnInterrupt, AppServerMethod.TurnInterrupt, params));
  }
  closeLink(link, signal);
}

function dynamicTurn(link: Link, threadId: string, setup: CodexTurnSetup): CodexDynamicTurn {
  const calls: CodexDynamicTurn["calls"] = [];
  return {
    threadId,
    calls,
    run: (turn, onToolCall) => turnEvents(link, { threadId, tools: setup.tools, calls, onToolCall }, turn),
    close: () => closeLink(link, setup.signal),
  };
}

/**
 * The turn, as `codex exec --json` events: the thread first, then every mirrored notification,
 * ending at `turn/completed`. A server that closes mid-turn, unless the studio closed it, throws.
 */
async function* turnEvents(link: Link, ctx: TurnContext, params: Record<string, unknown>): AsyncGenerator<Message> {
  yield { type: CodexEvent.ThreadStarted, thread_id: ctx.threadId };
  send(link, request(TurnRequestId.TurnStart, AppServerMethod.TurnStart, { ...params, threadId: ctx.threadId }));
  const state: TurnState = { replies: new Map(), usage: null };
  for (;;) {
    const message = await nextMessage(link);
    if (!message) break;
    const outcome = readTurnMessage(link, ctx, state, message);
    yield* outcome.events;
    if (outcome.done) return;
  }
  if (!link.closed) throw new Error(MESSAGE.ClosedMidTurn);
}

/** One message of a running turn: the events it mirrors, and whether the turn is over. */
function readTurnMessage(
  link: Link,
  ctx: TurnContext,
  state: TurnState,
  message: Message,
): { events: Message[]; done: boolean } {
  if (isServerRequest(message)) {
    void answerRequest(link, ctx, message);
    return { events: [], done: false };
  }
  if (message.id === TurnRequestId.TurnStart) return turnStarted(link, message);
  const params = record(message.params);
  const elsewhere = params.threadId !== undefined && params.threadId !== ctx.threadId;
  const mirror = NOTIFICATIONS[String(message.method)];
  if (elsewhere || !mirror) return { events: [], done: false };
  const done = message.method === AppServerMethod.TurnCompleted && isThisTurn(link, params);
  return { events: mirror(params, state), done };
}

/** The answer to `turn/start`: the turn's id, or the refusal that ends it before it began. */
function turnStarted(link: Link, message: Message): { events: Message[]; done: boolean } {
  const error = responseError(message);
  if (error) return { events: [{ type: CodexEvent.TurnFailed, error: { message: error } }], done: true };
  link.turnId = text(record(record(message.result).turn).id) || null;
  return { events: [], done: false };
}

/** Whether a `turn/completed` is this turn's (or names none, before `turn/start` answered). */
function isThisTurn(link: Link, params: Message): boolean {
  const id = text(record(params.turn).id);
  return !link.turnId || !id || id === link.turnId;
}

/** A server request in a running turn: a tool call the studio answers, or anything else declined. */
async function answerRequest(link: Link, ctx: TurnContext, message: Message): Promise<void> {
  if (message.method !== AppServerMethod.ToolCall) {
    declineRequest(link, message);
    return;
  }
  const parsed = parseDynamicToolCall(message.params, { threadId: ctx.threadId, tools: ctx.tools });
  if (!parsed.ok) {
    send(link, { id: message.id, result: parsed.refusal });
    return;
  }
  ctx.calls.push({ name: parsed.call.name, args: parsed.call.args });
  send(link, { id: message.id, result: await toolAnswer(ctx, parsed.call) });
}

/** The studio's answer to one call. A broken tool answers in words; it never ends the turn. */
async function toolAnswer(ctx: TurnContext, call: DynamicToolCall): Promise<DynamicToolCallResponse> {
  try {
    return dynamicToolResponse(await ctx.onToolCall(call.name, call.args));
  } catch (err) {
    return dynamicToolResponse({ text: MESSAGE.ToolFailed(call.name, errorMessage(err)), isError: true });
  }
}

// ── notifications → `codex exec --json` events ──────────────────────────────────────────────

/** An item's status as `codex exec` spells it: a declined change reads as a failed one. */
function execStatus(status: unknown): string {
  if (status === ItemStatus.InProgress) return CodexItemStatus.InProgress;
  if (status === ItemStatus.Completed) return CodexItemStatus.Completed;
  return CodexItemStatus.Failed;
}

/** The app server's item types → the item `codex exec` prints for the same thing. */
const ITEMS: Record<string, (item: Message) => Message> = {
  [AppServerItem.AgentMessage]: (item) => ({ id: item.id, type: CodexItem.AgentMessage, text: text(item.text) }),
  [AppServerItem.Reasoning]: (item) => ({ id: item.id, type: CodexItem.Reasoning, text: reasoningText(item) }),
  [AppServerItem.CommandExecution]: (item) => ({
    id: item.id,
    type: CodexItem.CommandExecution,
    command: text(item.command),
    aggregated_output: text(item.aggregatedOutput),
    ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}),
    status: execStatus(item.status),
  }),
  [AppServerItem.FileChange]: (item) => ({
    id: item.id,
    type: CodexItem.FileChange,
    changes: (Array.isArray(item.changes) ? item.changes : []).map((change: unknown) => ({
      path: text(record(change).path),
      kind: text(record(record(change).kind).type),
    })),
    status: execStatus(item.status),
  }),
  [AppServerItem.McpToolCall]: (item) => ({
    id: item.id,
    type: CodexItem.McpToolCall,
    server: item.server,
    tool: item.tool,
    arguments: item.arguments,
    result: item.result ?? null,
    error: item.error ?? null,
    status: execStatus(item.status),
  }),
  [AppServerItem.DynamicToolCall]: (item) => ({
    id: item.id,
    type: CodexItem.DynamicToolCall,
    tool: item.tool,
    arguments: item.arguments,
    content_items: Array.isArray(item.contentItems) ? item.contentItems : [],
    success: item.success ?? null,
    status: execStatus(item.status),
  }),
  [AppServerItem.WebSearch]: (item) => ({ id: item.id, type: CodexItem.WebSearch, query: text(item.query) }),
};

/** A reasoning item's words: its summary, or its raw content when it has no summary. */
function reasoningText(item: Message): string {
  const lines = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean).join("\n") : "");
  return lines(item.summary) || lines(item.content);
}

/** An item notification as the exec event of the same name; an item exec never prints is skipped. */
function itemEvents(type: string, item: unknown): Message[] {
  const shape = ITEMS[text(record(item).type)];
  return shape ? [{ type, item: shape(record(item)) }] : [];
}

/** A chunk of a reply: exec re-sends an agent message's whole text so far, so this does too. */
function replyDelta(params: Message, state: TurnState): Message[] {
  const id = text(params.itemId);
  if (!id) return [];
  const sofar = `${state.replies.get(id) ?? ""}${text(params.delta)}`;
  state.replies.set(id, sofar);
  return [{ type: CodexEvent.ItemUpdated, item: { id, type: CodexItem.AgentMessage, text: sofar } }];
}

/**
 * The turn's end. Its tokens are the thread's running total: the turn runs on a thread it started,
 * so the total is this turn's (a resumed thread would need the difference).
 */
function turnEnded(params: Message, state: TurnState): Message[] {
  const turn = record(params.turn);
  if (turn.status === TurnStatus.Completed) return [{ type: CodexEvent.TurnCompleted, usage: execUsage(state.usage) }];
  if (turn.status === TurnStatus.Interrupted) {
    return [{ type: CodexEvent.TurnFailed, error: { message: MESSAGE.Interrupted } }];
  }
  if (turn.status !== TurnStatus.Failed) return [];
  const message = text(record(turn.error).message) || MESSAGE.TurnFailed;
  return [{ type: CodexEvent.TurnFailed, error: { message } }];
}

/** The app server's token breakdown in exec's spelling; a count it did not send stays absent. */
function execUsage(usage: Message | null): Message {
  if (!usage) return {};
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
  };
}

/** An error notice: one Codex retries is progress, one it does not is exec's `error` event. */
function errorNotice(params: Message): Message[] {
  if (params.willRetry === true) return [];
  return [{ type: CodexEvent.Error, message: text(record(params.error).message) || MESSAGE.TurnFailed }];
}

/** The notifications a turn mirrors, and the exec events each becomes. Everything else is skipped. */
const NOTIFICATIONS: Record<string, (params: Message, state: TurnState) => Message[]> = {
  [AppServerMethod.ItemStarted]: (params) => itemEvents(CodexEvent.ItemStarted, params.item),
  [AppServerMethod.ItemCompleted]: (params, state) => {
    state.replies.delete(text(record(params.item).id));
    return itemEvents(CodexEvent.ItemCompleted, params.item);
  },
  [AppServerMethod.AgentMessageDelta]: replyDelta,
  [AppServerMethod.TokenUsageUpdated]: (params, state) => {
    state.usage = record(record(params.tokenUsage).total);
    return [];
  },
  [AppServerMethod.Error]: errorNotice,
  [AppServerMethod.TurnCompleted]: turnEnded,
};
