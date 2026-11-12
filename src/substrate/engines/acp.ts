/**
 * The Agent Client Protocol (ACP, version 1) as the studio speaks it to an agent it starts:
 * JSON-RPC 2.0, one message per line, over the agent's stdin and stdout. The studio is the client:
 * it asks (`initialize`, `session/new`, `session/prompt`, …), the agent answers, tells what it does
 * (`session/update`) and asks back before a tool runs (`session/request_permission`).
 *
 * `AcpConnection` is the wire alone: it pairs each answer with its question and hands the agent's
 * own messages to whoever runs the session. It starts no process and knows no agent; Antigravity
 * (`antigravity.ts`) is the one agent that uses it.
 */

/** The protocol version the studio speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The methods the studio calls or answers. ACP's wire spelling: never rename a value. */
export const AcpMethod = {
  Initialize: "initialize",
  SessionNew: "session/new",
  SessionLoad: "session/load",
  SessionPrompt: "session/prompt",
  SessionCancel: "session/cancel",
  SessionSetMode: "session/set_mode",
  /** Antigravity's own: the session's model, by an id its `models.availableModels` lists. */
  SessionSetModel: "session/set_model",
  SessionSetConfigOption: "session/set_config_option",
  SessionUpdate: "session/update",
  RequestPermission: "session/request_permission",
} as const;
export type AcpMethod = (typeof AcpMethod)[keyof typeof AcpMethod];

/** The kinds of `session/update` the studio reads. ACP's wire spelling: never rename a value. */
export const AcpUpdate = {
  AgentMessageChunk: "agent_message_chunk",
  AgentThoughtChunk: "agent_thought_chunk",
  ToolCall: "tool_call",
  ToolCallUpdate: "tool_call_update",
} as const;
export type AcpUpdate = (typeof AcpUpdate)[keyof typeof AcpUpdate];

/** A tool call's states. ACP's wire spelling: never rename a value. */
export const AcpToolStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
  Failed: "failed",
} as const;
export type AcpToolStatus = (typeof AcpToolStatus)[keyof typeof AcpToolStatus];

/** What a tool call does, as the agent classes it. ACP's wire spelling: never rename a value. */
export const AcpToolKind = {
  Read: "read",
  Edit: "edit",
  Delete: "delete",
  Move: "move",
  Search: "search",
  Execute: "execute",
  Think: "think",
  Fetch: "fetch",
  Other: "other",
} as const;
export type AcpToolKind = (typeof AcpToolKind)[keyof typeof AcpToolKind];

/** The kinds of answer a permission question offers. ACP's wire spelling: never rename a value. */
export const AcpPermissionKind = {
  AllowOnce: "allow_once",
  AllowAlways: "allow_always",
  RejectOnce: "reject_once",
  RejectAlways: "reject_always",
} as const;
export type AcpPermissionKind = (typeof AcpPermissionKind)[keyof typeof AcpPermissionKind];

/** How a prompt turn ended. ACP's wire spelling: never rename a value. */
export const AcpStopReason = {
  EndTurn: "end_turn",
  MaxTokens: "max_tokens",
  MaxTurnRequests: "max_turn_requests",
  Refusal: "refusal",
  Cancelled: "cancelled",
} as const;
export type AcpStopReason = (typeof AcpStopReason)[keyof typeof AcpStopReason];

/** The error codes the studio reacts to: JSON-RPC's own, and ACP's "sign in first". */
export const AcpErrorCode = {
  AuthRequired: -32000,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
} as const;
export type AcpErrorCode = (typeof AcpErrorCode)[keyof typeof AcpErrorCode];

/** What a connection that closed says to every question still waiting. */
const MESSAGE = {
  Closed: "the agent closed the connection",
  NoHandler: (method: string) => `the client does not answer ${method}`,
} as const;

/** An error the agent answered a question with: its code is what the studio acts on. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

type Json = Record<string, unknown>;

/** What the agent says or asks on its own, as the session's runner takes it. */
export interface AcpHandlers {
  /** A message that wants no answer (`session/update`). */
  notification(method: string, params: Json): void;
  /** A question the agent waits on; what this resolves with is its answer, and a throw is its error. */
  request(method: string, params: Json): Promise<unknown>;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line as a JSON-RPC message, or null for a line that is not one (a stray log line). */
function parseLine(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One ACP connection: `send` writes a line to the agent, `receive` takes each line it prints.
 * A question the studio asks resolves with the agent's result or rejects with its `AcpError`; once
 * the connection closes, every question still open rejects with why.
 */
export class AcpConnection {
  readonly #send: (line: string) => void;
  readonly #handlers: AcpHandlers;
  readonly #waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  #nextId = 1;
  #closed: Error | null = null;

  constructor(send: (line: string) => void, handlers: AcpHandlers) {
    this.#send = send;
    this.#handlers = handlers;
  }

  /** Ask the agent and wait for its answer. */
  request(method: string, params: Json): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const answer = new Promise<unknown>((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.#write({ jsonrpc: "2.0", id, method, params });
    return answer;
  }

  /** Tell the agent something it does not answer (`session/cancel`). */
  tell(method: string, params: Json): void {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params });
  }

  /** One line the agent printed. */
  receive(line: string): void {
    const message = parseLine(line);
    if (!message) return;
    if (typeof message.method === "string") this.#incoming(message.method, message);
    else this.#answered(message);
  }

  /** The agent is gone (or the turn was stopped): nothing more is sent, and every open question fails. */
  close(reason?: Error): void {
    if (this.#closed) return;
    this.#closed = reason ?? new Error(MESSAGE.Closed);
    for (const waiter of this.#waiting.values()) waiter.reject(this.#closed);
    this.#waiting.clear();
  }

  #write(message: Json): void {
    this.#send(JSON.stringify(message));
  }

  /** The agent's answer to one of the studio's questions. */
  #answered(message: Json): void {
    const waiter = typeof message.id === "number" ? this.#waiting.get(message.id) : undefined;
    if (!waiter || typeof message.id !== "number") return;
    this.#waiting.delete(message.id);
    if (!isRecord(message.error)) {
      waiter.resolve(message.result);
      return;
    }
    const { code, message: words, data } = message.error;
    waiter.reject(new AcpError(typeof code === "number" ? code : AcpErrorCode.Internal, String(words ?? ""), data));
  }

  /** The agent's own message: a notification, or a question answered through the handlers. */
  #incoming(method: string, message: Json): void {
    const params = isRecord(message.params) ? message.params : {};
    const id = message.id;
    if (id === undefined || id === null) {
      this.#handlers.notification(method, params);
      return;
    }
    void this.#handlers.request(method, params).then(
      (result) => this.#closed || this.#write({ jsonrpc: "2.0", id, result: result ?? {} }),
      (err: unknown) => this.#closed || this.#write({ jsonrpc: "2.0", id, error: errorBody(method, err) }),
    );
  }
}

/** The JSON-RPC error a failed handler answers with. */
function errorBody(method: string, err: unknown): Json {
  if (err instanceof AcpError) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : MESSAGE.NoHandler(method);
  return { code: AcpErrorCode.Internal, message };
}
