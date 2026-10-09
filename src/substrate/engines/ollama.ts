/**
 * Local-model engine (Ollama is v1's primary workhorse,
 * because an unlimited unattended loop at zero marginal cost is the whole point of local).
 *
 * Two pieces:
 *  - {@link OllamaClient}: the management API (detect, list, pull with progress, capabilities).
 *    Detect-first: if the user already runs Ollama we reuse it, sharing `~/.ollama/models` — no
 *    second copy of a 20 GB model.
 *  - {@link OllamaEngine}: the studio's *own* turn loop talking to it through pi-ai's
 *    OpenAI-compatible provider, so the same code path serves any future provider.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  type CompleteRequest,
  type CompleteResponse,
  type Engine,
  EngineError,
  type EngineModel,
  ModelContextSource,
  type EngineStatus,
  classifyHttpFailure,
} from "./types.ts";
import {
  drainPiStream,
  fromPiAssistant,
  isCutConnection,
  longHaulFetch,
  needsVision,
  type PiAssistant,
  piContext,
  type PiStreamFn,
  streamHttpStatus,
} from "./pi-completions.ts";
import { supersededBy } from "../hardware.ts";
import { childEnv } from "../child-env.ts";
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { StudioPlatform } from "../../shared/boot.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { EngineId } from "../../shared/providers.ts";
import { CompletionStop, STOPPED_BY_USER } from "./common.ts";

/** The conversion helpers live with the pi-ai transport every API engine shares; kept here for importers. */
export { fromPiAssistant };
export { toPiMessages } from "./pi-completions.ts";

/** The port Ollama serves on when its host names none. */
const DEFAULT_OLLAMA_PORT = "11434";
export const DEFAULT_OLLAMA_HOST = `http://127.0.0.1:${DEFAULT_OLLAMA_PORT}`;

/** How long `version()` waits for a server to answer before calling it not running. */
const VERSION_PROBE_TIMEOUT_MS = 2 * SECOND_MS;
/** A model whose context the server does not report is assumed to have this much. */
const DEFAULT_CONTEXT_TOKENS = 8192;
/** A reply may use a quarter of the context, up to this many tokens. */
const MAX_REPLY_TOKENS = 32_768;
/** The status Ollama answers for a model it does not have. */
const HTTP_NOT_FOUND = 404;
/** How long `ensureRunning` waits for a started server, and how often it asks. */
const SIDECAR_START_TIMEOUT_MS = 15 * SECOND_MS;
const SIDECAR_POLL_MS = 400;

/** What this engine says to the user. */
const MESSAGE = {
  StartRemedy: "Install or start Ollama, then try again.",
  PullRemedy: "Pull a recommended model from the Models tab.",
  NoModel: "no local model is installed",
  NoVision: "vision input is not supported by this model's reported capabilities",
  NoTools: "tool calling is not supported by this model's reported capabilities",
  EstimatedContext: "Runtime context is unknown; 8K is an estimated planning budget. Load the model to measure it.",
  NotAnswering: (host: string) =>
    `Ollama is not running at ${host} (it no longer answers). Start Ollama and try again.`,
  NotRunningForDownload: (host: string) =>
    `Ollama is not running at ${host}. Install or start Ollama, then download again.`,
  ModelMissing: (model: string) =>
    `the model ${model} is not installed in Ollama — pull it from the Models tab or pick another`,
  NotInstalled: (model: string) => `${model || "This model"} is not installed in Ollama.`,
} as const;

/** A reply may use a quarter of its context, never more than the cap. */
function maxReplyTokens(contextWindow: number): number {
  return Math.min(MAX_REPLY_TOKENS, Math.floor(contextWindow / 4));
}

export interface OllamaTag {
  name: string;
  size: number;
  digest: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export class OllamaClient {
  readonly host: string;
  constructor(host = DEFAULT_OLLAMA_HOST) {
    this.host = host.replace(/\/$/, "");
  }

  async version(signal?: AbortSignal): Promise<string | null> {
    try {
      const response = await fetch(`${this.host}/api/version`, {
        signal: signal ?? AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return ((await response.json()) as { version: string }).version;
    } catch {
      return null;
    }
  }

  async tags(): Promise<OllamaTag[]> {
    const response = await fetch(`${this.host}/api/tags`);
    if (!response.ok) throw classifyHttpFailure(EngineId.Ollama, response.status, await response.text());
    return ((await response.json()) as { models: OllamaTag[] }).models ?? [];
  }

  /** `capabilities` gates agentic use: no `"tools"`, no tool calling. */
  async show(model: string): Promise<{ capabilities: string[]; contextLength: number }> {
    const response = await fetch(`${this.host}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!response.ok) throw classifyHttpFailure(EngineId.Ollama, response.status, await response.text());
    const body = (await response.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    const info = body.model_info ?? {};
    const contextKey = Object.keys(info).find((key) => key.endsWith(".context_length"));
    return {
      capabilities: body.capabilities ?? [],
      contextLength: positiveContext(contextKey ? info[contextKey] : undefined) ?? DEFAULT_CONTEXT_TOKENS,
    };
  }

  /** Streaming NDJSON pull. Resumable; concurrent pulls of the same model share progress. */
  async *pull(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
    const response = await fetch(`${this.host}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      ...(signal ? { signal } : {}),
    }).catch((err: unknown) => this.#rethrowUnlessGone(err));
    if (!response.ok || !response.body) {
      throw classifyHttpFailure(EngineId.Ollama, response.status, await response.text().catch(() => ""));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read().catch((err: unknown) => this.#rethrowUnlessGone(err));
      if (done) break;
      const lines = `${buffer}${decoder.decode(value, { stream: true })}`.split("\n");
      // The last piece has no newline yet: it is a line still arriving.
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line) yield JSON.parse(line) as PullProgress;
      }
    }
  }

  /**
   * A download whose connection failed: with no server answering, that is Ollama missing or
   * stopped, said so instead of the fetch's own "fetch failed"; any other failure stays as it was.
   */
  async #rethrowUnlessGone(err: unknown): Promise<never> {
    if (await this.version()) throw err;
    throw new EngineError(EngineFailureKind.Unavailable, EngineId.Ollama, MESSAGE.NotRunningForDownload(this.host));
  }

  async remove(model: string): Promise<void> {
    const response = await fetch(`${this.host}/api/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!response.ok) throw classifyHttpFailure(EngineId.Ollama, response.status, await response.text());
  }

  async loaded(): Promise<Array<{ name: string; context_length?: number; size_vram: number; expires_at: string }>> {
    const response = await fetch(`${this.host}/api/ps`);
    if (!response.ok) return [];
    return (
      (
        (await response.json()) as {
          models: Array<{ name: string; context_length?: number; size_vram: number; expires_at: string }>;
        }
      ).models ?? []
    );
  }

  /** Runtime capacity is distinct from a model's theoretical maximum. Unknown loads stay conservative. */
  async runtimeContext(model: string, maximum: number): Promise<{ tokens: number; source: ModelContextSource }> {
    const loaded = await this.loaded().catch(() => []);
    const context = loaded.find((entry) => entry.name === model)?.context_length;
    const measured = positiveContext(context);
    return {
      tokens: Math.min(maximum, measured ?? DEFAULT_CONTEXT_TOKENS),
      source: measured ? ModelContextSource.Configured : ModelContextSource.Unknown,
    };
  }
}

/** Only a positive integer is usable as a context capacity. */
function positiveContext(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Ceiling on a single completion request. The long-haul dispatcher above only lifts undici's
 * transport timeouts — the OpenAI client underneath pi-ai still applies its own 10-minute
 * default, and that is the wall the 01:26 build turn died on at exactly 600s of silence.
 * An hour clears any turn a local model has actually produced (a 43-minute build fits) while
 * staying finite, so a genuinely dead connection surfaces as an error instead of hanging the
 * loop until the watchdog gives up on the whole harness.
 */
export const OLLAMA_COMPLETION_TIMEOUT_MS = HOUR_MS;

/**
 * A connection cut mid-stream surfaces as undici's bare `TypeError: terminated` (sometimes
 * wrapped as "Connection error." by the OpenAI client, or arriving via pi-ai's
 * stopReason "error" instead of a throw). The client's request timeout is the same story in
 * another spelling: "Request timed out." after an hour of silence is a dead connection, not
 * an answer. Translate every spelling into something a person can act on; everything else
 * passes through unchanged.
 */
function translateStreamFailure(
  engineId: string,
  message: string,
  cause?: { message?: string; code?: string },
  attempt: StreamAttempt = { model: "" },
): EngineError {
  // An HTTP failure that arrives through the stream ("429: <body>") is the same failure as one
  // that arrives before it — without this, a throttled server reads as "other" and every
  // rate-limit policy above (backoff, direct-only fallback) is unreachable for this engine.
  const status = streamHttpStatus(message);
  if (status !== null) return httpFailure(engineId, status, message, attempt.model);
  if (!isCutConnection(message)) return new EngineError(EngineFailureKind.Other, engineId, message);
  const detail = cause?.message ?? cause?.code;
  return cutConnection(
    engineId,
    `the connection to Ollama was cut mid-generation${detail ? ` (${detail})` : ""} — the partial turn was lost; check that Ollama is still running and send the message again`,
  );
}

/** What a failed completion had asked for. */
interface StreamAttempt {
  model: string;
}

/** Failures that are a connection cut: the engine asks whether the server is still there. */
const CUT_CONNECTIONS = new WeakSet<EngineError>();

/** A connection cut before the reply was whole: the partial turn is lost. */
function cutConnection(engineId: string, message: string): EngineError {
  const failure = new EngineError(EngineFailureKind.Other, engineId, message);
  CUT_CONNECTIONS.add(failure);
  return failure;
}

/** An HTTP failure; a 404 is Ollama saying it does not have the model. */
function httpFailure(engineId: string, status: number, body: string, model: string): EngineError {
  if (status === HTTP_NOT_FOUND && model)
    return new EngineError(EngineFailureKind.Unavailable, engineId, MESSAGE.ModelMissing(model));
  return classifyHttpFailure(engineId, status, body);
}

// ── the engine ──────────────────────────────────────────────────────────────────────────────
export interface OllamaEngineOptions {
  host?: string;
  /** Overrides the catalog/hardware default. */
  defaultModel?: string;
  /** Injected in tests to avoid depending on what the user happens to have installed. */
  client?: OllamaClient;
  /** Injected in tests so the timeout path can be exercised without waiting an hour. */
  timeoutMs?: number;
}

export class OllamaEngine implements Engine {
  readonly id = EngineId.Ollama;
  readonly label = "Local model (Ollama)";
  readonly kind = EngineKind.Direct;
  readonly client: OllamaClient;
  readonly host: string;
  #defaultModel: string | null;
  #models: unknown = null;
  #providerModels = new Map<string, unknown>();
  readonly #timeoutMs: number;

  constructor(options: OllamaEngineOptions = {}) {
    this.host = options.host ?? DEFAULT_OLLAMA_HOST;
    this.client = options.client ?? new OllamaClient(this.host);
    this.#defaultModel = options.defaultModel ?? null;
    this.#timeoutMs = options.timeoutMs ?? OLLAMA_COMPLETION_TIMEOUT_MS;
  }

  async status(): Promise<EngineStatus> {
    const version = await this.client.version();
    if (!version) {
      return {
        code: EngineStatusCode.NotRunning,
        detail: `no Ollama at ${this.host}`,
        remedy: MESSAGE.StartRemedy,
      };
    }
    const tags = await this.client.tags().catch(() => []);
    if (tags.length === 0) {
      return {
        code: EngineStatusCode.NotInstalled,
        detail: `Ollama ${version} is running but has no models installed`,
        remedy: MESSAGE.PullRemedy,
      };
    }
    return { code: EngineStatusCode.Ready, detail: `Ollama ${version}, ${tags.length} model(s) installed` };
  }

  async models(): Promise<EngineModel[]> {
    const tags = await this.client.tags().catch(() => []);
    const out: EngineModel[] = [];
    for (const tag of tags) {
      let capabilities: string[] = [];
      let contextLength = DEFAULT_CONTEXT_TOKENS;
      let contextSource: ModelContextSource = ModelContextSource.Unknown;
      try {
        const shown = await this.client.show(tag.name);
        capabilities = shown.capabilities;
        const runtime = await this.client.runtimeContext(tag.name, shown.contextLength);
        contextLength = runtime.tokens;
        contextSource = runtime.source;
      } catch {
        /* a model we cannot introspect is still listed, just conservatively */
      }
      const replacement = supersededBy(tag.name);
      out.push({
        id: tag.name,
        label: tag.name,
        contextWindow: contextLength,
        contextSource,
        maxTokens: maxReplyTokens(contextLength),
        supportsTools: capabilities.includes("tools"),
        supportsVision: capabilities.includes("vision"),
        supportsThinking: capabilities.includes("thinking"),
        sizeBytes: tag.size,
        installed: true,
        ...(contextSource === ModelContextSource.Unknown ? { note: MESSAGE.EstimatedContext } : {}),
        ...(replacement ? { stale: true, note: `superseded by ${replacement}` } : {}),
      });
    }
    return out;
  }

  async defaultModel(): Promise<string | null> {
    if (this.#defaultModel) return this.#defaultModel;
    const models = await this.models();
    // Prefer a tool-capable model: without tool calling the studio's own loop cannot build.
    const agentic = models.find((m) => m.supportsTools && !m.stale) ?? models.find((m) => m.supportsTools);
    this.#defaultModel = agentic?.id ?? models[0]?.id ?? null;
    return this.#defaultModel;
  }

  /** Delete a model Ollama lists; any other name is refused before Ollama is asked to delete. */
  async removeModel(id: string): Promise<void> {
    const tags = await this.client.tags();
    if (!tags.some((tag) => tag.name === id)) throw new Error(MESSAGE.NotInstalled(id));
    await this.client.remove(id);
    this.#providerModels.delete(id);
    // A default that named the deleted model is chosen again from what is still installed.
    if (this.#defaultModel === id) this.#defaultModel = null;
  }

  /** Lazily build pi-ai's provider around this host. */
  async #ensureProvider(modelId: string): Promise<{ models: never; model: never; thinking: boolean; tools: boolean }> {
    const { createModels, createProvider } = await import("@earendil-works/pi-ai");
    const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");

    if (!this.#models) this.#models = createModels();
    const model = await this.#providerModel(modelId);
    this.#providerModels.set(modelId, model);
    (this.#models as { setProvider: (p: unknown) => void }).setProvider(
      createProvider({
        id: EngineId.Ollama,
        name: "Ollama",
        baseUrl: `${this.host}/v1`,
        // Keyless local provider. pi-ai requires *some* api-key auth to consider a provider
        // configured, and Ollama's OpenAI-compatible endpoint ignores the value, so we resolve a
        // constant placeholder. No secret exists, so none can leak.
        auth: {
          apiKey: {
            name: "Ollama (local, keyless)",
            resolve: async () => ({ auth: { apiKey: "ollama-local" }, source: "local (no key required)" }),
          },
        } as never,
        models: [...this.#providerModels.values()] as never,
        api: openAICompletionsApi(),
      }) as never,
    );
    const thinking = Boolean((model as { reasoning?: boolean }).reasoning);
    return { models: this.#models as never, model: model as never, thinking, tools: Boolean(model.supportsTools) };
  }

  /** pi-ai's description of one installed model, from what the server says about it. */
  async #providerModel(modelId: string): Promise<Record<string, unknown>> {
    let contextWindow = DEFAULT_CONTEXT_TOKENS;
    let thinking = false;
    let vision = false;
    let tools = false;
    try {
      const shown = await this.client.show(modelId);
      contextWindow = (await this.client.runtimeContext(modelId, shown.contextLength)).tokens;
      thinking = shown.capabilities.includes("thinking");
      vision = shown.capabilities.includes("vision");
      tools = shown.capabilities.includes("tools");
    } catch {
      /* fall back to a safe default */
    }
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: EngineId.Ollama,
      baseUrl: `${this.host}/v1`,
      // A thinking-capable model gets the reasoning_effort knob — Ollama's OpenAI-compatible
      // endpoint maps it to the model's think level. Without it the newest locals default
      // deep and an unattended loop meditates instead of iterating.
      reasoning: thinking,
      supportsTools: tools,
      input: vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: maxReplyTokens(contextWindow),
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: thinking },
    };
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    const modelId = request.model ?? (await this.defaultModel());
    if (!modelId) {
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoModel);
    }
    const { models, model, thinking, tools } = await this.#ensureProvider(modelId);
    if (request.tools?.length && !tools) {
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoTools);
    }
    this.#checkVision(request, model);
    const context = piContext(request);
    const attempt: StreamAttempt = { model: modelId };

    try {
      const stream = (models as unknown as { stream: PiStreamFn }).stream(model, context, {
        fetch: longHaulFetch(request.signal),
        // Without this, the OpenAI client's 10-minute default cuts long builds mid-turn.
        timeoutMs: Math.min(request.timeoutMs ?? this.#timeoutMs, this.#timeoutMs),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        ...(thinking && request.effort ? { reasoningEffort: normalizeEffort(request.effort) } : {}),
      });
      await drainPiStream(stream, request, this.id);
      const assistant = (await stream.result()) as PiAssistant;
      if (assistant.stopReason === CompletionStop.Aborted) {
        throw new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
      }
      if (assistant.stopReason === CompletionStop.Error) {
        throw translateStreamFailure(this.id, assistant.errorMessage ?? "model stream failed", undefined, attempt);
      }
      const { message, usage } = fromPiAssistant(assistant);
      return {
        message,
        usage,
        stopReason: assistant.stopReason ?? CompletionStop.Stop,
        model: modelId,
        engine: this.id,
      };
    } catch (err) {
      throw await this.#unlessServerGone(this.#failure(err, request, attempt));
    }
  }

  /**
   * A cut connection with the server no longer answering at all is Ollama not running — nothing
   * a partial turn lost, and a failure another engine can take over.
   */
  async #unlessServerGone(failure: EngineError): Promise<EngineError> {
    if (!CUT_CONNECTIONS.has(failure)) return failure;
    if ((await this.client.version()) !== null) return failure;
    return new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NotAnswering(this.host));
  }

  /** Refuse unsupported images before any inference request. */
  #checkVision(request: CompleteRequest, model: { input: string[] }): void {
    if (needsVision(request) && !model.input.includes("image")) {
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoVision);
    }
  }

  /** What a failed completion throws, as an engine error the run policy can act on. */
  #failure(err: unknown, request: CompleteRequest, attempt: StreamAttempt): EngineError {
    if (err instanceof EngineError) return err;
    // An abort wins over whatever error it caused — a stop must never read as a failure.
    if (request.signal?.aborted) return new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
    const error = err as Error & { status?: number; cause?: { message?: string; code?: string } };
    if (error.status) return httpFailure(this.id, error.status, error.message, attempt.model);
    return translateStreamFailure(this.id, error.message, error.cause, attempt);
  }
}

/** Ollama's endpoint understands low/medium/high; clamp the wider scale into that range. */
function normalizeEffort(
  effort: string,
): typeof ReasoningEffort.Low | typeof ReasoningEffort.Medium | typeof ReasoningEffort.High {
  if (effort === ReasoningEffort.Minimal || effort === ReasoningEffort.Low) return ReasoningEffort.Low;
  if (effort === ReasoningEffort.Medium) return ReasoningEffort.Medium;
  return ReasoningEffort.High;
}

// ── sidecar ─────────────────────────────────────────────────────────────────────────────────
export interface SidecarStatus {
  running: boolean;
  version: string | null;
  managed: boolean;
  host: string;
  detail: string;
}

/**
 * Detect-first sidecar management. We never fight the user's own Ollama: if one
 * answers on the port we use it, sharing its model store. Only when nothing answers do we start
 * a copy ourselves, and only that copy do we stop on quit.
 */
export class OllamaSidecar {
  readonly client: OllamaClient;
  readonly host: string;
  #managed = false;
  #child: import("node:child_process").ChildProcess | null = null;
  readonly #spawnBinary: string | null;

  constructor(options: { host?: string; binary?: string | null } = {}) {
    this.host = options.host ?? DEFAULT_OLLAMA_HOST;
    this.client = new OllamaClient(this.host);
    this.#spawnBinary = options.binary ?? null;
  }

  async status(): Promise<SidecarStatus> {
    const version = await this.client.version();
    return {
      running: version !== null,
      version,
      managed: this.#managed,
      host: this.host,
      detail: this.#detail(version),
    };
  }

  /** Whose server is answering: the studio's own copy, the user's, or none. */
  #detail(version: string | null): string {
    if (!version) return "not running";
    if (this.#managed) return `started by the studio (${version})`;
    return `using the Ollama already running on this Mac (${version})`;
  }

  /** Returns true if a server is reachable afterwards. */
  async ensureRunning(timeoutMs = SIDECAR_START_TIMEOUT_MS): Promise<boolean> {
    if (await this.client.version()) return true;
    if (!this.#spawnBinary) return false;
    const url = new URL(this.host);
    // Its own process group on macOS and Linux, so `stop` reaches the model runners it starts;
    // Windows ends the tree by parent id instead, and `detached` there would open a console.
    const { spawnCommand } = await import("../command-launch.ts");
    this.#child = spawnCommand(this.#spawnBinary, ["serve"], {
      // M6: the model server needs its own settings (OLLAMA_MODELS, proxies), no credential and
      // no coding CLI's variables.
      env: childEnv(process.env, {
        base: "contractor",
        vendor: "none",
        set: { OLLAMA_HOST: `${url.hostname}:${url.port || DEFAULT_OLLAMA_PORT}` },
      }),
      stdio: "ignore",
      detached: process.platform !== StudioPlatform.Windows,
    });
    this.#managed = true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.version()) return true;
      await delay(SIDECAR_POLL_MS);
    }
    return false;
  }

  /** Only ever stops a server this process started. */
  async stop(): Promise<void> {
    if (!this.#managed || !this.#child) return;
    const child = this.#child;
    if (child.exitCode === null && child.signalCode === null) {
      const { killProcessTree } = await import("../process-tree.ts");
      await killProcessTree(child.pid, { signal: "SIGTERM" });
    }
    this.#child = null;
    this.#managed = false;
  }
}
