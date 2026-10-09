/**
 * The studio's own turn loop talking to an OpenAI-compatible server through pi-ai: the message
 * conversion in both directions, the request context, the stream drain and the transport. Ollama
 * (a local server) and OpenRouter (a metered API) both complete through it; each engine keeps
 * its own provider description and its own words for a failure.
 */
import { randomUUID } from "node:crypto";
import type { Message, Usage } from "../types.ts";
import { type CompleteRequest, EngineError, type ToolDefinition } from "./types.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { EngineId } from "../../shared/providers.ts";
import { CompletionStop, STOPPED_BY_USER } from "./common.ts";

// ── message conversion (substrate ⇄ pi-ai) ─────────────────────────────────────────────────
interface PiTextContent {
  type: "text";
  text: string;
}
interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The conversation as pi-ai spells it: every system message joined into one prompt, the rest in order. */
export function toPiMessages(
  messages: Message[],
  provider: string = EngineId.Ollama,
): { systemPrompt?: string; piMessages: unknown[] } {
  const piMessages: unknown[] = [];
  let systemPrompt: string | undefined;
  for (const message of messages) {
    if (message.role === "system") {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${message.content}` : message.content;
      continue;
    }
    piMessages.push(piMessage(message, provider));
  }
  return systemPrompt !== undefined ? { systemPrompt, piMessages } : { piMessages };
}

/** A non-system message as pi-ai spells it. */
function piMessage(message: Message, provider: string): unknown {
  if (message.role === "user") return piUserMessage(message);
  if (message.role === "assistant") return piAssistantMessage(message, provider);
  // role === "tool"
  return piToolResult(message);
}

/** A user message: plain text, or text plus its stills as image parts. */
function piUserMessage(message: Message): unknown {
  const images = message.images ?? [];
  if (images.length === 0) return { role: "user", content: message.content, timestamp: Date.now() };
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const image of images) {
    if (!image.data) continue;
    content.push({ type: "image", data: image.data, mimeType: image.mimeType || "image/jpeg" });
  }
  return { role: "user", content, timestamp: Date.now() };
}

/** An assistant message: its text, then its tool calls. */
function piAssistantMessage(message: Message, provider: string): unknown {
  const content: (PiTextContent | PiToolCall)[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: (call.arguments ?? {}) as Record<string, unknown>,
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider,
    model: "",
    usage: emptyPiUsage(),
    stopReason: CompletionStop.Stop,
    timestamp: Date.now(),
  };
}

/** A tool's answer. */
function piToolResult(message: Message): unknown {
  return {
    role: "toolResult",
    toolCallId: message.tool_call_id ?? "",
    toolName: message.name ?? "tool",
    content: [{ type: "text", text: message.content }],
    isError: message.is_error === true,
    timestamp: Date.now(),
  };
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A pi-ai assistant message, the fields an engine reads. */
export interface PiAssistant {
  content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
  model?: string;
  errorMessage?: string;
}

/** The reply as the studio's message, and what it cost, accounted to `engine`. */
export function fromPiAssistant(
  assistant: PiAssistant,
  engine: string = EngineId.Ollama,
): { message: Message; usage: Usage } {
  let text = "";
  let reasoning = "";
  const toolCalls: NonNullable<Message["tool_calls"]> = [];
  for (const part of assistant.content ?? []) {
    if (part.type === "text") text += part.text ?? "";
    else if (part.type === "thinking") reasoning += part.text ?? "";
    else if (part.type === "toolCall") {
      // A call the model left unnamed still needs an id no other round repeats: its result is bound by it.
      toolCalls.push({
        id: part.id || `${engine}-${randomUUID()}`,
        name: part.name ?? "",
        arguments: part.arguments ?? {},
      });
    }
  }
  const message: Message = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning = reasoning;
  return { message, usage: piUsage(assistant, engine) };
}

/**
 * A reply's token counts and price. pi-ai prices a reply from the model's per-token cost: zero for
 * a local model (the reason unattended runs are viable), the catalog's price for a metered one.
 */
function piUsage(assistant: PiAssistant, engine: string): Usage {
  const usage = assistant.usage;
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_read_tokens: usage?.cacheRead ?? 0,
    cache_write_tokens: usage?.cacheWrite ?? 0,
    cost_usd: usage?.cost?.total ?? 0,
    ...(assistant.model ? { model: assistant.model } : {}),
    engine,
  };
}

// ── the request ────────────────────────────────────────────────────────────────────────────

/** pi-ai's streaming call, as the engines use it. */
export type PiStream = AsyncIterable<{ type: string; delta?: string }> & { result: () => Promise<unknown> };
export type PiStreamFn = (m: unknown, c: unknown, o?: unknown) => PiStream;

/** The request as pi-ai's context: one system prompt, the messages, and the tools. */
export function piContext(request: CompleteRequest, provider: string = EngineId.Ollama): Record<string, unknown> {
  const { systemPrompt, piMessages } = toPiMessages(request.messages, provider);
  return {
    ...(request.systemPrompt || systemPrompt
      ? { systemPrompt: [request.systemPrompt, systemPrompt].filter(Boolean).join("\n\n") }
      : {}),
    messages: piMessages,
    ...(request.tools?.length ? { tools: request.tools.map(toPiTool) } : {}),
  };
}

function toPiTool(tool: ToolDefinition): unknown {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Does the request carry a picture the model would have to see? */
export function needsVision(request: CompleteRequest): boolean {
  return request.messages.some((message) => Boolean(message.images?.length));
}

// ── the stream ─────────────────────────────────────────────────────────────────────────────

export function throwAborted(engineId: string): never {
  throw new EngineError(EngineFailureKind.Aborted, engineId, STOPPED_BY_USER);
}

/** Unblock a silent stream (thinking, huge tool-call buffer) the moment Stop fires. */
function whenAborted(signal: AbortSignal | undefined, engineId: string): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = (): void => reject(new EngineError(EngineFailureKind.Aborted, engineId, STOPPED_BY_USER));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Read the stream to its end, passing text on as it comes; Stop unblocks even a silent stream. */
export async function drainPiStream(stream: PiStream, request: CompleteRequest, engineId: string): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  let aborted = false;
  try {
    for (;;) {
      if (request.signal?.aborted) throwAborted(engineId);
      const step = iterator.next();
      const event = request.signal ? await Promise.race([step, whenAborted(request.signal, engineId)]) : await step;
      if (event.done) break;
      if (event.value.type === "text_delta" && event.value.delta) request.onDelta?.(event.value.delta);
    }
  } catch (err) {
    aborted = true;
    throw err;
  } finally {
    if (aborted) await iterator.return?.().catch(() => {});
  }
}

/** The HTTP status a stream error names ("429: <body>"), or null when it names none. */
export function streamHttpStatus(message: string): number | null {
  const http = /^(\d{3}):\s/.exec(message.trim());
  return http ? Number(http[1]) : null;
}

/** A connection cut mid-stream, in any of the spellings undici and the OpenAI client give it. */
export function isCutConnection(message: string): boolean {
  return /^(terminated|fetch failed|Connection error\.?|Request timed out\.?)$/i.test(message.trim());
}

// ── the transport ──────────────────────────────────────────────────────────────────────────

/**
 * Node's fetch (undici) kills any response that stays *silent* for 300 seconds
 * (`bodyTimeout`), surfacing the opaque `TypeError: terminated`. Ollama's tool-call parser
 * buffers a whole call server-side before emitting it, so while a model writes one big
 * write_file call — a 27B model authoring a full game is ~5 minutes of arguments at
 * ~10 tok/s — the wire carries nothing and the timeout fires mid-turn. Long silent phases
 * (prompt eval on a huge context, a hosted model thinking) hit the same wall. Generations are
 * legitimately long and the Stop button, not a transport default, is the clock. pi-ai lets us
 * supply the fetch it hands its OpenAI client, so completions run through one whose
 * dispatcher never times out.
 *
 * The dispatcher class is taken from Node's own lazily-created global (the well-known
 * `undici.globalDispatcher.1` symbol) rather than an npm `undici` — a separately installed
 * copy can disagree with the built-in fetch about the handler protocol.
 */
let longHaulDispatcher: object | null = null;
async function ensureLongHaulDispatcher(): Promise<object | null> {
  if (longHaulDispatcher) return longHaulDispatcher;
  const key = Symbol.for("undici.globalDispatcher.1");
  const globals = globalThis as unknown as Record<symbol, { constructor: new (opts: object) => object } | undefined>;
  if (!globals[key]) {
    // Node initialises the global dispatcher on first fetch; force that cheaply (data: URL,
    // no network) so we can borrow its constructor.
    await fetch("data:,").catch(() => {});
  }
  const current = globals[key];
  if (!current) return null;
  longHaulDispatcher = new current.constructor({ headersTimeout: 0, bodyTimeout: 0 });
  return longHaulDispatcher;
}

/** The fetch pi-ai hands its OpenAI client: the long-haul dispatcher, and the user's Stop joined in. */
export function longHaulFetch(stop: AbortSignal | undefined): typeof fetch {
  return async (input, init) => {
    const dispatcher = await ensureLongHaulDispatcher();
    // The client routes its request timeout through the signal it hands this fetch, so the
    // user's Stop has to join that signal, not replace it — replacing would mask the
    // timeout and a dead connection would hang the loop instead of erroring.
    const signals = [init?.signal, stop].filter((s): s is AbortSignal => Boolean(s));
    return fetch(input, {
      ...init,
      ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  };
}
