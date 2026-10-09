import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { BonsaiRuntime } from "../bonsai/runtime.ts";
import { BONSAI_MODELS, bonsaiModel } from "../bonsai/manifest.ts";
import { LocalSessions } from "./local-session.ts";
import type { Message, ToolCall } from "../types.ts";
import {
  EngineError,
  classifyHttpFailure,
  type Engine,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type EngineStatus,
} from "./types.ts";
import { errorMessage } from "../../shared/errors.ts";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { ContextSource } from "../../shared/context.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { EngineId } from "../../shared/providers.ts";
import { DEFAULT_COMPACTION_PERCENT } from "./common.ts";
/** FIFO generation queue. Tool execution happens OUTSIDE this lease, so a waiting director
 * never holds the slot needed by its own workers. Aborted waiters leave immediately. */
export class InferenceQueue {
  #busy = false;
  #waiting: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (e: unknown) => void;
    abort: () => void;
  }> = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.#busy) {
      this.#busy = true;
      return () => this.#release();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        abort: () => {
          this.#waiting = this.#waiting.filter((e) => e !== entry);
          reject(signal.reason);
        },
      };
      this.#waiting.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
    });
  }
  #release() {
    const next = this.#waiting.shift();
    if (!next) {
      this.#busy = false;
      return;
    }
    next.signal.removeEventListener("abort", next.abort);
    next.resolve(() => this.#release());
  }
}
export function openAiMessages(messages: Message[], systemPrompt?: string): unknown[] {
  return [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
          ]
        : m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls?.length
        ? {
            tool_calls: m.tool_calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            })),
          }
        : {}),
    })),
  ];
}
/** Tokens a local reply may use when the request sets no cap. */
const DEFAULT_REPLY_TOKENS = 4096;
/** Room kept for each image: its embedding is not text tokens, so the tokenizer cannot count it. */
const IMAGE_RESERVE_TOKENS = 2048;
/** Headroom for the chat template's own framing beyond the counted prompt. */
const TEMPLATE_SLACK_TOKENS = 256;
/** Past this working context, a cold prefill needs the longer completion ceiling. */
const LONG_CONTEXT_TOKENS = 32_768;
const LONG_CONTEXT_TIMEOUT_MS = 25 * MINUTE_MS;
const SHORT_CONTEXT_TIMEOUT_MS = 10 * MINUTE_MS;
/** How much of a context error the engine error quotes. */
const ERROR_BODY_CHARS = 500;
/** Bonsai's recommended sampling. */
const BONSAI_SAMPLING = { top_p: 0.95, top_k: 20, min_p: 0 } as const;
/** Thinking tokens per reasoning effort; -1 lets the model think as long as it likes. */
const REASONING_BUDGET: Record<string, number> = { low: 512, medium: 2048, high: 8192, max: -1 };
/** The efforts a Bonsai model offers, and where it starts. */
const BONSAI_EFFORTS: string[] = [
  ReasoningEffort.Low,
  ReasoningEffort.Medium,
  ReasoningEffort.High,
  ReasoningEffort.Max,
];

/** What this engine says to the user. */
const MESSAGE = {
  AppleSiliconOnly: "Bonsai requires Apple Silicon",
  Ready: "Bonsai installed · starts on demand",
  NotDownloaded: "Download Bonsai 2 to build locally",
  DownloadRemedy: "Choose PQ2_0 (recommended) or PTQ1_0 in Model setup.",
  DownloadFirst: "Download Bonsai first",
  NoTokens: "Runtime tokenizer returned no tokens",
  EmptyResponse: "Empty inference response",
  StreamEnded: "Inference stream ended before completion",
  Stopped: "Local generation stopped",
  TimedOut: "Local generation timed out",
} as const;

/** The OpenAI-style streaming request body one completion posts. */
type CompletionBody = ReturnType<typeof completionBody>;
/** POST a JSON body to the running model server. */
type Post = (route: string, value: unknown) => Promise<Response>;

export class BonsaiEngine implements Engine {
  readonly id = EngineId.Bonsai;
  readonly label = "Bonsai · on this Mac";
  readonly kind = EngineKind.Direct;
  readonly supportsSessions = true;
  readonly runtime: BonsaiRuntime;
  readonly sessions: LocalSessions;
  #queue = new InferenceQueue();
  constructor(options: {
    root: string;
    scratchRoot?: string;
    protectedPaths?: string[];
    toolPath?: () => Promise<string>;
    runtime?: BonsaiRuntime;
  }) {
    this.runtime = options.runtime ?? new BonsaiRuntime(path.join(options.root, "runtime"));
    this.sessions = new LocalSessions({
      root: path.join(options.root, "sessions"),
      scratchRoot: options.scratchRoot,
      protectedPaths: options.protectedPaths ?? [options.root],
      complete: (r) => this.complete(r),
      contextWindow: this.runtime.contextWindow,
      toolPath: options.toolPath,
    });
  }
  async status(): Promise<EngineStatus> {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.AppleSiliconOnly };
    if ((await this.models()).length) return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready };
    return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.NotDownloaded, remedy: MESSAGE.DownloadRemedy };
  }
  async models() {
    const found = [];
    for (const model of BONSAI_MODELS)
      if (await this.runtime.installed(model.id))
        found.push({
          id: model.id,
          label: model.label,
          contextWindow: this.runtime.contextWindow,
          maxTokens: DEFAULT_REPLY_TOKENS,
          supportsTools: true,
          supportsVision: true,
          supportsThinking: true,
          efforts: [...BONSAI_EFFORTS],
          defaultEffort: ReasoningEffort.Low,
          installed: true,
          sizeBytes: model.file.bytes,
        });
    return found;
  }
  async defaultModel() {
    return (await this.models())[0]?.id ?? null;
  }
  removeModel(id: string): Promise<void> {
    return this.runtime.remove(id);
  }
  async delegate(request: DelegateRequest) {
    const model = request.model ?? (await this.defaultModel());
    if (!model) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.DownloadFirst);
    bonsaiModel(model);
    return this.sessions.run(request, model);
  }
  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    const model = request.model ?? (await this.defaultModel());
    if (!model) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.DownloadFirst);
    bonsaiModel(model);
    // Cold long-context prefill can exceed ten minutes on an M2 Max. The caller
    // signal still enforces the enclosing build/session deadline and cancellation.
    const ceilingMs =
      this.runtime.contextWindow > LONG_CONTEXT_TOKENS ? LONG_CONTEXT_TIMEOUT_MS : SHORT_CONTEXT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(request.timeoutMs ?? ceilingMs);
    const signal = AbortSignal.any([timeout, ...(request.signal ? [request.signal] : [])]);
    let release: (() => void) | undefined;
    try {
      request.onActivity?.(ChatActivityPhase.Queued);
      release = await this.#lease(signal);
      request.onActivity?.(ChatActivityPhase.LoadingModel);
      const host = await this.runtime.start(model, signal);
      const body = completionBody(request, model);
      const post: Post = (route, value) =>
        fetch(`${host}${route}`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", ...this.runtime.authHeaders },
          body: JSON.stringify(value),
        });
      await this.#preflight(request, model, body, post);
      request.onActivity?.(ChatActivityPhase.Thinking);
      return await this.#generate(request, model, body, post);
    } catch (err) {
      throw this.#failure(err, signal, request);
    } finally {
      release?.();
    }
  }

  /** The queue's turn, which also keeps the server from its idle stop until released. */
  async #lease(signal: AbortSignal): Promise<() => void> {
    const release = await this.#queue.acquire(signal);
    const letGo = this.runtime.hold();
    return () => {
      letGo();
      release();
    };
  }

  /**
   * Count the request exactly before sending it, and refuse one that cannot fit.
   *
   * CONTEXT-MANAGER INTEGRATION: keep this provider-specific budget check even when
   * history policy moves to a shared manager. Use runtime.contextWindow, NOT the GGUF
   * training maximum (262144) or a character estimate. Count the final rendered system,
   * messages and tool schemas, then reserve images + reply + template headroom.
   * Surface context_overflow to the session owner; this layer must not discard user
   * requirements or replay tools. See docs/local-models.md#future-context-manager-integration.
   * Use the pinned runtime's own chat template and tokenizer, including tool schemas.
   * Image embeddings are not text tokens; reserve room for each image separately and
   * retain the server overflow guard for image-size-dependent expansion.
   */
  async #preflight(request: CompleteRequest, model: string, body: CompletionBody, post: Post): Promise<void> {
    const imageCount = request.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    const tokens = await this.#countPromptTokens(request, body, post);
    const contextWindow = this.runtime.contextWindow;
    const required = tokens + imageCount * IMAGE_RESERVE_TOKENS + body.max_tokens + TEMPLATE_SLACK_TOKENS;
    const percent =
      request.contextPolicy?.mode === "custom"
        ? Number(request.contextPolicy.thresholdPercent)
        : DEFAULT_COMPACTION_PERCENT;
    const threshold = Math.floor((contextWindow * percent) / 100);
    request.onContext?.({
      engine: this.id,
      model,
      requestedModel: model,
      promptTokens: tokens,
      contextWindow,
      reservedOutputTokens: body.max_tokens,
      imageReserveTokens: imageCount * IMAGE_RESERVE_TOKENS,
      source: ContextSource.NativeTokenizer,
      thresholdTokens: request.contextPolicy ? threshold : undefined,
      phase: "preflight",
    });
    if (required > contextWindow)
      throw new EngineError(
        EngineFailureKind.ContextOverflow,
        this.id,
        `Local request needs ${required} tokens including reply/image reserve; working context is ${contextWindow}.`,
      );
    if (request.contextPolicy && required > threshold)
      throw new EngineError(
        EngineFailureKind.ContextThreshold,
        this.id,
        `Local request needs ${required} tokens including output/image reserves; configured compaction threshold is ${threshold} (${percent}%).`,
      );
  }

  /** The prompt's exact token count, through the runtime's own chat template and tokenizer. */
  async #countPromptTokens(request: CompleteRequest, body: CompletionBody, post: Post): Promise<number> {
    const textMessages = openAiMessages(
      request.messages.map(({ images: _images, ...m }) => m),
      request.systemPrompt,
    );
    const templated = await post("/apply-template", { ...body, messages: textMessages, stream: false });
    if (!templated.ok) throw classifyHttpFailure(this.id, templated.status, await templated.text());
    const { prompt } = (await templated.json()) as { prompt: string };
    const tokenized = await post("/tokenize", { content: prompt, add_special: true, parse_special: true });
    if (!tokenized.ok) throw classifyHttpFailure(this.id, tokenized.status, await tokenized.text());
    const { tokens } = (await tokenized.json()) as { tokens: unknown[] };
    if (!Array.isArray(tokens)) throw new EngineError(EngineFailureKind.Other, this.id, MESSAGE.NoTokens);
    return tokens.length;
  }

  /** Stream the completion and assemble the assistant message it spells out. */
  async #generate(
    request: CompleteRequest,
    model: string,
    body: CompletionBody,
    post: Post,
  ): Promise<CompleteResponse> {
    const response = await post("/v1/chat/completions", body);
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 && /context|too many tokens/i.test(text))
        throw new EngineError(EngineFailureKind.ContextOverflow, this.id, text.slice(0, ERROR_BODY_CHARS));
      throw classifyHttpFailure(this.id, response.status, text);
    }
    if (!response.body) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.EmptyResponse);
    const stream = newStreamState(model);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of Readable.fromWeb(response.body as never)) {
      const lines = `${buffer}${decoder.decode(bytes, { stream: true })}`.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.#readLine(line.trimEnd(), stream, request.onDelta);
    }
    buffer += decoder.decode();
    if (buffer.trim()) this.#readLine(buffer.trimEnd(), stream, request.onDelta);
    if (!stream.stopReason) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.StreamEnded);
    const tool_calls = toolCallsOf(stream);
    return {
      engine: this.id,
      model: stream.reportedModel,
      stopReason: stream.stopReason,
      usage: { input_tokens: stream.input, output_tokens: stream.output, model: stream.reportedModel, engine: this.id },
      message: {
        role: "assistant",
        content: stream.content,
        ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
        ...(tool_calls.length ? { tool_calls } : {}),
      },
    };
  }

  /** One server-sent line of the completion stream, folded into what the reply has said so far. */
  #readLine(line: string, stream: StreamState, onDelta: CompleteRequest["onDelta"]): void {
    if (!line.startsWith("data:")) return;
    const raw = line.slice("data:".length).trim();
    if (raw === "[DONE]" || !raw) return;
    const item = JSON.parse(raw);
    if (item.error)
      throw new EngineError(EngineFailureKind.Other, this.id, item.error.message ?? JSON.stringify(item.error));
    if (item.model) stream.reportedModel = item.model;
    if (item.usage) {
      stream.input = item.usage.prompt_tokens ?? stream.input;
      stream.output = item.usage.completion_tokens ?? stream.output;
    }
    const choice = item.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) stream.stopReason = choice.finish_reason;
    readDelta(choice.delta ?? {}, stream, onDelta);
  }

  /** What a failed completion throws: the caller's stop, the ceiling, or the failure itself as an engine error. */
  #failure(err: unknown, signal: AbortSignal, request: CompleteRequest): EngineError {
    if (signal.aborted) {
      const stopped = request.signal?.aborted;
      return stopped
        ? new EngineError(EngineFailureKind.Aborted, this.id, MESSAGE.Stopped)
        : new EngineError(EngineFailureKind.Timeout, this.id, MESSAGE.TimedOut);
    }
    if (err instanceof EngineError) return err;
    if (err instanceof SyntaxError)
      return new EngineError(EngineFailureKind.Other, this.id, `Invalid model response: ${err.message}`);
    return new EngineError(EngineFailureKind.Unavailable, this.id, errorMessage(err));
  }

  async dispose() {
    await this.runtime.dispose();
  }
}

/** The streaming chat-completion request for one call: messages, sampling, thinking budget, tools. */
function completionBody(request: CompleteRequest, model: string) {
  const budget = REASONING_BUDGET[request.effort ?? ReasoningEffort.Low] ?? REASONING_BUDGET.low;
  return {
    model,
    messages: openAiMessages(request.messages, request.systemPrompt),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens ?? DEFAULT_REPLY_TOKENS,
    temperature: request.temperature ?? 1,
    ...BONSAI_SAMPLING,
    reasoning_budget_tokens: budget,
    ...(request.tools?.length
      ? { tools: request.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
      : {}),
  };
}

/** What the completion stream has said so far. */
interface StreamState {
  content: string;
  reasoning: string;
  stopReason: string;
  reportedModel: string;
  input: number;
  output: number;
  /** Tool calls by index, their name and arguments arriving in pieces. */
  calls: Map<number, { id: string; name: string; args: string }>;
}

function newStreamState(model: string): StreamState {
  return { content: "", reasoning: "", stopReason: "", reportedModel: model, input: 0, output: 0, calls: new Map() };
}

/** One choice delta: text for the user, reasoning for the record, pieces of tool calls. */
function readDelta(
  delta: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
  },
  stream: StreamState,
  onDelta: CompleteRequest["onDelta"],
): void {
  if (delta.content) {
    stream.content += delta.content;
    onDelta?.(delta.content);
  }
  stream.reasoning += delta.reasoning_content ?? delta.reasoning ?? "";
  for (const c of delta.tool_calls ?? []) {
    const index = c.index ?? 0;
    const entry = stream.calls.get(index) ?? { id: "", name: "", args: "" };
    if (c.id) entry.id = c.id;
    if (c.function?.name) entry.name += c.function.name;
    if (c.function?.arguments) entry.args += c.function.arguments;
    stream.calls.set(index, entry);
  }
}

/**
 * The reply's tool calls, parsed. A length-limited tool batch is not an executable request. Even
 * an earlier, syntactically complete call in that batch must wait for a complete response. Keep
 * usage/termination so the session owner can request a smaller edit.
 */
function toolCallsOf(stream: StreamState): ToolCall[] {
  if (stream.stopReason === StopReason.Length) return [];
  return [...stream.calls.values()].map((c) => ({
    // A call the server left unnamed gets an id no other round repeats: the session answers
    // interrupted calls by id across its whole history.
    id: c.id || `local-${randomUUID()}`,
    name: c.name,
    arguments: parsedArguments(c.args),
  }));
}

/**
 * A call's arguments as JSON, or the text as sent when it is not JSON. One bad quote is the
 * model's mistake to correct (the session answers it as a tool error), not a failed completion
 * that ends the whole session after every good turn before it.
 */
function parsedArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return text;
  }
}
