/**
 * A model server the person runs themselves: TabbyAPI (ExLlamaV3 on an NVIDIA card), LM Studio,
 * llama.cpp, vLLM, KoboldCpp or an Ollama elsewhere on the network, reached through its
 * OpenAI-compatible API on this computer or the local network.
 *
 * A direct engine on the same pi-ai path as Ollama and OpenRouter (`pi-completions.ts`): the
 * studio's own turn loop drives the model and runs the tools itself, and a game chat or a build
 * runs as a Genex session (`LocalSessions`), as Bonsai's and OpenRouter's do, so Loop's workers and
 * reviewers can run on it too. The address is saved in the engine's home (`local-server/settings.ts`);
 * an optional API key is kept in the OS secret store (`provider-keys.ts`), read here, in main, when a
 * request is sent, and never leaves this process. The server is local, so it costs nothing per
 * token and the app may fall back to it on its own.
 */
import path from "node:path";
import {
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  EngineError,
  type EngineModel,
  type EngineStatus,
  ModelContextSource,
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
import { CatalogError, ModelCatalog } from "./model-catalog.ts";
import { LocalSessions } from "./local-session.ts";
import { DEFAULT_OLLAMA_HOST } from "./ollama.ts";
import { CompletionStop, DEFAULT_COMPACTION_PERCENT, STOPPED_BY_USER } from "./common.ts";
import type { ApiKeyStore } from "../provider-keys.ts";
import { SecretStorageUnavailableError } from "../secrets.ts";
import { type HostLookup, localServerAddress } from "../local-server/address.ts";
import {
  findServers,
  identifyServer,
  keyHeaders,
  ListAnswer,
  type ModelList,
  readModelList,
  type ServerAccess,
  serverModels,
} from "../local-server/discovery.ts";
import { answerDeltas, splitInlineThinking } from "../local-server/inline-thinking.ts";
import type { SavedServer, ServerSettings } from "../local-server/settings.ts";
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { ContextSource } from "../../shared/context.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import {
  type FoundLocalServer,
  LOCAL_SERVER_NAMES,
  type LocalServerConnectResult,
  type LocalServerInfo,
  LocalServerKind,
  LocalServerProblem,
} from "../../shared/local-server.ts";
import { ModelCatalogProblemCode, ModelCatalogSource } from "../../shared/model-catalog.ts";
import { EngineId } from "../../shared/providers.ts";
import { errorMessage } from "../../shared/errors.ts";
import { redactSecrets, redactValues } from "../../shared/redact.ts";

/** How long a checked status stays checked before `status()` asks the server again. */
const STATUS_FRESH_MS = 15 * SECOND_MS;
/** How long a status check waits: a server on this network answers at once, or is busy loading. */
const STATUS_TIMEOUT_MS = 3 * SECOND_MS;
/** Ceiling on one completion: long enough for a whole build turn on a slow card, finite so a dead connection errors. */
export const LOCAL_SERVER_COMPLETION_TIMEOUT_MS = HOUR_MS;
/** Characters per token when no tokenizer is at hand: low, so the estimate errs towards compacting early. */
const CHARS_PER_TOKEN = 3;
/** Tokens set aside for each picture, which the server counts in its own way. */
const IMAGE_RESERVE_TOKENS = 1_600;
/** Tokens set aside for the server's chat template around the messages and tools. */
const TEMPLATE_SLACK_TOKENS = 512;
/** What a pasted key may hold: printable characters, no space or newline, of a sane length. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;
/** pi-ai needs some key to call a provider configured; a server without auth ignores it. */
const NO_KEY = "local-server";
/** The typed code llama.cpp (and the servers built on it) give a request that does not fit. Vendor spelling. */
const CONTEXT_EXCEEDED = "exceed_context_size_error";
/** The hosts that are this computer, so one spelling of the app's own Ollama matches another. */
const THIS_COMPUTER: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** What this engine says to the person. */
const MESSAGE = {
  NotSetUp: "No local server is connected.",
  SetUpRemedy: "Connect your server in Settings › Model Providers.",
  NotAnswering: (where: string) => `Nothing answers at ${where}.`,
  StartRemedy: "Start your server, then check again.",
  NeedsKey: (who: string) => `${who} asks for an API key.`,
  KeyRemedy: "Add its API key in Settings › Model Providers.",
  NotOpenAi: (where: string) => `Something answers at ${where}, but not as a model server.`,
  AddressRemedy: "Check the address in Settings › Model Providers.",
  NoModels: (who: string) => `${who} lists no models.`,
  LoadRemedy: "Load a model in your server, then check again.",
  Ready: (who: string, count: number) => `${who}, ${count} ${count === 1 ? "model" : "models"}`,
  Locked: (detail: string) => `The OS secret store is locked, so the server's API key cannot be read. ${detail}`,
  NoModel: "Pick a model from your local server for this chat.",
  UnknownModel: (model: string, who: string) => `${who} does not list ${model}. Load it there, or pick another model.`,
  NoTools: "this model cannot call tools",
  NoVision: "this model cannot see images",
  Cut: (where: string) =>
    `the connection to ${where} was cut mid-reply — the partial turn was lost; check that the server is still running and send the message again`,
  Overflow: (required: number, window: number) =>
    `The request needs about ${required} tokens including the reply; this model's context is ${window}.`,
  Threshold: (required: number, threshold: number, percent: number) =>
    `The request needs about ${required} tokens including the reply; the compaction threshold is ${threshold} (${percent}%).`,
  ListFailed: (where: string) => `${where} did not list its models.`,
} as const;

/** Failures that are a connection cut mid-reply: the engine asks whether the server is still there. */
const CUT_CONNECTIONS = new WeakSet<EngineError>();

/** `127.0.0.1:5000`: the server as a person reads it. */
const where = (url: string): string => new URL(url).host;

/** "TabbyAPI at 127.0.0.1:5000", or the address alone for software the app does not know. */
function serverName(saved: SavedServer): string {
  const host = where(saved.url);
  return saved.kind ? `${LOCAL_SERVER_NAMES[saved.kind]} at ${host}` : `The server at ${host}`;
}

/** The key as pasted, trimmed; null for none, and `false` for something that cannot be a key. */
function pastedKey(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key) return null;
  return KEY_SHAPE.test(key) ? key : false;
}

/** Do two addresses reach the same server on this computer (`localhost` and `127.0.0.1` alike)? */
function sameServer(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  const host = (url: URL) => (THIS_COMPUTER.has(url.hostname) ? "this-computer" : url.hostname);
  const port = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
  return host(left) === host(right) && port(left) === port(right);
}

/** About how many tokens a request holds, from its characters; pictures and the reply are reserved apart. */
function estimatedPromptTokens(request: CompleteRequest): number {
  const text = JSON.stringify([
    request.systemPrompt ?? "",
    request.messages.map(({ images: _images, ...message }) => message),
    request.tools ?? [],
  ]);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const refused = (problem: LocalServerProblem): LocalServerConnectResult => ({ ok: false, problem });

export interface LocalServerEngineOptions {
  /** The engine's home: its sessions live under it. */
  root: string;
  scratchRoot?: string;
  protectedPaths?: string[];
  toolPath?: () => Promise<string>;
  /** Where the server's address is saved. */
  settings: ServerSettings;
  /** Where its API key is kept. */
  keys: ApiKeyStore;
  /** The Ollama the app already reaches as its own provider, which is never connected twice. */
  ollamaHost?: string;
  /** Looks a typed host name up; tests answer from a table. */
  lookup?: HostLookup;
  /** The ports `find()` asks on this computer; tests name their fake server's. */
  findPorts?: readonly number[];
  onModelsChanged?: () => void;
  now?: () => number;
  /** Injected in tests so the timeout path is reachable without waiting an hour. */
  timeoutMs?: number;
}

export class LocalServerEngine implements Engine {
  readonly id = EngineId.LocalServer;
  readonly label = "Local server";
  readonly kind = EngineKind.Direct;
  readonly supportsSessions = true;
  readonly sessions: LocalSessions;
  readonly #settings: ServerSettings;
  readonly #keys: ApiKeyStore;
  readonly #catalog: ModelCatalog;
  readonly #ollamaHost: string;
  readonly #lookup: HostLookup | undefined;
  readonly #findPorts: readonly number[] | undefined;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #status: { at: number; value: EngineStatus } | null = null;
  #models: unknown = null;

  constructor(options: LocalServerEngineOptions) {
    this.#settings = options.settings;
    this.#keys = options.keys;
    this.#ollamaHost = options.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    this.#lookup = options.lookup;
    this.#findPorts = options.findPorts;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? LOCAL_SERVER_COMPLETION_TIMEOUT_MS;
    this.#catalog = new ModelCatalog(options.onModelsChanged, this.#now);
    this.sessions = new LocalSessions({
      engine: EngineId.LocalServer,
      root: path.join(options.root, "sessions"),
      scratchRoot: options.scratchRoot,
      protectedPaths: options.protectedPaths ?? [options.root],
      complete: (r) => this.complete(r),
      contextWindow: (model) => this.#row(model)?.contextWindow ?? 0,
      toolPath: options.toolPath,
    });
  }

  // ── the saved server ──────────────────────────────────────────────────────────────────────

  /** The saved server for Settings: its address and software, and whether a key is kept (never the key). */
  async server(): Promise<LocalServerInfo | null> {
    const saved = await this.#settings.read();
    if (!saved) return null;
    const hasKey = await this.#keys
      .read()
      .then(Boolean)
      .catch(() => false);
    return { url: saved.url, kind: saved.kind, hasKey };
  }

  /**
   * Connect a server: its address must be on this computer or the local network, and it must list
   * its models with the key given (or, for the server already saved, the one kept for it). Only
   * then are the address and key saved; a refusal saves nothing and says why. A kept key never
   * goes to another server, and is forgotten once another is connected without one.
   */
  async connect(input: { url?: unknown; key?: unknown }): Promise<LocalServerConnectResult> {
    const address = await localServerAddress(input.url, this.#lookup);
    if (!address.ok) return refused(address.problem);
    const pasted = pastedKey(input.key);
    if (pasted === false) return refused(LocalServerProblem.BadKey);
    const saved = await this.#settings.read();
    const sameAsSaved = saved !== null && sameServer(saved.url, address.baseUrl);
    const kept = sameAsSaved ? await this.#keys.read().catch(() => null) : null;
    const key = pasted ?? kept;
    const access: ServerAccess = { url: address.baseUrl, key };
    const list = await readModelList(access);
    const problem = this.#listProblem(list);
    if (problem) return problem;
    const kind = await identifyServer(access, list);
    if (list.answer === ListAnswer.NeedsKey)
      return { ok: false, problem: key ? LocalServerProblem.KeyRefused : LocalServerProblem.NeedsKey, kind };
    if (kind === LocalServerKind.Ollama && sameServer(access.url, this.#ollamaHost))
      return refused(LocalServerProblem.OwnOllama);
    const stored = await this.#storeKey(pasted, sameAsSaved);
    if (stored) return stored;
    await this.#settings.write({ url: access.url, kind });
    this.#forgetStatus();
    await this.refreshModels(true).catch(() => {});
    return { ok: true, status: await this.status() };
  }

  /**
   * Keep the pasted key, or forget the kept one when another server is connected without a key: a
   * key belongs to its server. A locked store refuses the connection; null when the key is in place.
   */
  async #storeKey(pasted: string | null, sameAsSaved: boolean): Promise<LocalServerConnectResult | null> {
    try {
      if (pasted) await this.#keys.write(pasted);
      else if (!sameAsSaved) await this.#keys.clear();
      return null;
    } catch (err) {
      if (err instanceof SecretStorageUnavailableError) return refused(LocalServerProblem.StoreLocked);
      throw err;
    }
  }

  /** Why a server's model list refuses a connection outright, or null when it answers as a model server. */
  #listProblem(list: ModelList): LocalServerConnectResult | null {
    if (list.answer === ListAnswer.NotAnswering) return refused(LocalServerProblem.NotAnswering);
    if (list.answer === ListAnswer.NotOpenAi) return refused(LocalServerProblem.NotOpenAi);
    return null;
  }

  /** Forget the saved server and its key; the engine then needs connecting again. */
  async forget(): Promise<EngineStatus> {
    await this.#settings.clear();
    this.#catalog.invalidate();
    this.#catalog.publish({ models: [], source: ModelCatalogSource.Provider });
    this.#forgetStatus();
    await this.#keys.clear();
    return this.status();
  }

  /** The model servers answering on this computer's usual ports, for Settings to offer. */
  async find(): Promise<FoundLocalServer[]> {
    const found = await findServers(this.#findPorts);
    return found.filter(
      (server) => !(server.kind === LocalServerKind.Ollama && sameServer(server.url, this.#ollamaHost)),
    );
  }

  #forgetStatus(): void {
    this.#status = null;
  }

  /** The saved key, or null for none; a locked store says so as a sign-in failure. */
  async #key(): Promise<string | null> {
    try {
      return await this.#keys.read();
    } catch (err) {
      throw new EngineError(EngineFailureKind.Auth, this.id, MESSAGE.Locked(errorMessage(err)));
    }
  }

  // ── status and models ─────────────────────────────────────────────────────────────────────

  async status(): Promise<EngineStatus> {
    const cached = this.#status;
    if (cached && this.#now() - cached.at < STATUS_FRESH_MS) return cached.value;
    const value = await this.#readStatus();
    this.#status = { at: this.#now(), value };
    return value;
  }

  async #readStatus(): Promise<EngineStatus> {
    const saved = await this.#settings.read();
    if (!saved) return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.NotSetUp, remedy: MESSAGE.SetUpRemedy };
    let key: string | null;
    try {
      key = await this.#keys.read();
    } catch (err) {
      if (err instanceof SecretStorageUnavailableError)
        return { code: EngineStatusCode.Error, detail: MESSAGE.Locked(err.message) };
      throw err;
    }
    const list = await readModelList({ url: saved.url, key }, STATUS_TIMEOUT_MS);
    const who = serverName(saved);
    if (list.answer === ListAnswer.NotAnswering)
      return {
        code: EngineStatusCode.NotRunning,
        detail: MESSAGE.NotAnswering(where(saved.url)),
        remedy: MESSAGE.StartRemedy,
      };
    if (list.answer === ListAnswer.NeedsKey)
      return { code: EngineStatusCode.NeedsLogin, detail: MESSAGE.NeedsKey(who), remedy: MESSAGE.KeyRemedy };
    if (list.answer === ListAnswer.NotOpenAi)
      return {
        code: EngineStatusCode.Error,
        detail: MESSAGE.NotOpenAi(where(saved.url)),
        remedy: MESSAGE.AddressRemedy,
      };
    if (list.entries.length === 0)
      return { code: EngineStatusCode.NotInstalled, detail: MESSAGE.NoModels(who), remedy: MESSAGE.LoadRemedy };
    return { code: EngineStatusCode.Ready, detail: MESSAGE.Ready(who, list.entries.length) };
  }

  catalogSnapshot = () => this.#catalog.snapshot();

  async models(): Promise<EngineModel[]> {
    void this.refreshModels().catch(() => {});
    return this.#catalog.models();
  }

  /** Read the server's models again (at most once a minute unless forced); a forced read rechecks its status too. */
  async refreshModels(force = false): Promise<void> {
    if (force) this.#forgetStatus();
    const saved = await this.#settings.read();
    await this.#catalog.refresh(saved?.url ?? "", () => this.#readCatalog(saved), force);
  }

  async #readCatalog(saved: SavedServer | null): Promise<{ models: EngineModel[]; source: ModelCatalogSource }> {
    if (!saved) return { models: [], source: ModelCatalogSource.Provider };
    const access: ServerAccess = { url: saved.url, key: await this.#keys.read().catch(() => null) };
    const list = await readModelList(access);
    if (list.answer !== ListAnswer.Models)
      throw new CatalogError(ModelCatalogProblemCode.Provider, MESSAGE.ListFailed(serverName(saved)));
    const kind = (await identifyServer(access, list)) ?? saved.kind;
    // The software can change behind one address (LM Studio stopped, llama.cpp started on its port).
    if (kind !== saved.kind) await this.#settings.write({ url: saved.url, kind });
    return { models: await serverModels(access, kind, list.entries), source: ModelCatalogSource.Provider };
  }

  /** The first model the server lists: a local model costs nothing, so the app may pick it. */
  async defaultModel(): Promise<string | null> {
    return this.#catalog.models().find((model) => model.supportsTools)?.id ?? this.#catalog.models()[0]?.id ?? null;
  }

  #row(model: string): EngineModel | undefined {
    return this.#catalog.models().find((row) => row.id === model);
  }

  /** The listed row for `model`, reading the list again once if the server has a model it did not list before. */
  async #knownRow(model: string, saved: SavedServer): Promise<EngineModel> {
    if (!this.#row(model)) await this.refreshModels(true).catch(() => {});
    const row = this.#row(model);
    if (!row)
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.UnknownModel(model, serverName(saved)));
    return row;
  }

  /** The saved server, or a failure that says to connect one. */
  async #saved(): Promise<SavedServer> {
    const saved = await this.#settings.read();
    if (!saved)
      throw new EngineError(EngineFailureKind.Unavailable, this.id, `${MESSAGE.NotSetUp} ${MESSAGE.SetUpRemedy}`);
    return saved;
  }

  /** The model a request names, or the server's first when it names none. */
  async #modelFor(requested: string | undefined): Promise<string> {
    const model = requested ?? (await this.defaultModel());
    if (!model) throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoModel);
    return model;
  }

  // ── running ───────────────────────────────────────────────────────────────────────────────

  async delegate(request: DelegateRequest): Promise<DelegateResult> {
    const saved = await this.#saved();
    const model = await this.#modelFor(request.model);
    await this.#knownRow(model, saved);
    return this.sessions.run(request, model);
  }

  async complete(request: CompleteRequest): Promise<CompleteResponse> {
    const saved = await this.#saved();
    const modelId = await this.#modelFor(request.model);
    const row = await this.#knownRow(modelId, saved);
    if (request.tools?.length && !row.supportsTools)
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoTools);
    if (needsVision(request) && !row.supportsVision)
      throw new EngineError(EngineFailureKind.Unavailable, this.id, MESSAGE.NoVision);
    const maxTokens = Math.min(request.maxTokens ?? row.maxTokens, row.maxTokens);
    this.#preflight(request, row, maxTokens);
    const key = await this.#key();
    const { models, model } = await this.#provider(saved, row, key);
    try {
      const stream = (models as { stream: PiStreamFn }).stream(model, piContext(request, this.id), {
        fetch: longHaulFetch(request.signal),
        timeoutMs: Math.min(request.timeoutMs ?? this.#timeoutMs, this.#timeoutMs),
        maxTokens,
        headers: keyHeaders(key),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      await drainPiStream(stream, { ...request, onDelta: answerDeltas(request.onDelta) }, this.id);
      const assistant = (await stream.result()) as PiAssistant;
      if (assistant.stopReason === CompletionStop.Aborted)
        throw new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
      if (assistant.stopReason === CompletionStop.Error)
        throw this.#streamFailure(assistant.errorMessage ?? "model stream failed", saved, key);
      return this.#response(assistant, modelId);
    } catch (err) {
      throw await this.#failure(err, request, saved, key);
    }
  }

  /** The finished reply, its inline thinking (when the server left it in the answer) kept apart. */
  #response(assistant: PiAssistant, modelId: string): CompleteResponse {
    const { message, usage } = fromPiAssistant(assistant, this.id);
    if (!message.reasoning) {
      const split = splitInlineThinking(message.content);
      message.content = split.answer;
      if (split.thinking) message.reasoning = split.thinking;
    }
    return { message, usage, stopReason: assistant.stopReason ?? CompletionStop.Stop, model: modelId, engine: this.id };
  }

  /**
   * Refuse a request that cannot fit before the server spends minutes reading it. There is no
   * tokenizer for every model, so the count is an estimate from characters that errs towards
   * compacting early. A model whose context the server does not report is only compacted at the
   * planned budget, never refused: the server's own limit decides.
   */
  #preflight(request: CompleteRequest, row: EngineModel, maxTokens: number): void {
    const images = request.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    const promptTokens = estimatedPromptTokens(request);
    const required = promptTokens + images * IMAGE_RESERVE_TOKENS + maxTokens + TEMPLATE_SLACK_TOKENS;
    const window = row.contextWindow;
    const percent =
      request.contextPolicy?.mode === "custom"
        ? Number(request.contextPolicy.thresholdPercent)
        : DEFAULT_COMPACTION_PERCENT;
    const threshold = Math.floor((window * percent) / 100);
    request.onContext?.({
      engine: this.id,
      model: row.id,
      requestedModel: row.id,
      promptTokens,
      contextWindow: window,
      reservedOutputTokens: maxTokens,
      imageReserveTokens: images * IMAGE_RESERVE_TOKENS,
      source: ContextSource.Estimated,
      thresholdTokens: request.contextPolicy ? threshold : undefined,
      phase: "preflight",
    });
    if (required > window && row.contextSource !== ModelContextSource.Unknown)
      throw new EngineError(EngineFailureKind.ContextOverflow, this.id, MESSAGE.Overflow(required, window));
    if (request.contextPolicy && required > threshold)
      throw new EngineError(
        EngineFailureKind.ContextThreshold,
        this.id,
        MESSAGE.Threshold(required, threshold, percent),
      );
  }

  /** pi-ai's provider for one request, holding the key only for as long as the request needs it. */
  async #provider(
    saved: SavedServer,
    row: EngineModel,
    key: string | null,
  ): Promise<{ models: unknown; model: unknown }> {
    const { createModels, createProvider } = await import("@earendil-works/pi-ai");
    const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");
    if (!this.#models) this.#models = createModels();
    const model = this.#piModel(saved, row);
    (this.#models as { setProvider: (p: unknown) => void }).setProvider(
      createProvider({
        id: this.id,
        name: this.label,
        baseUrl: saved.url,
        auth: {
          apiKey: {
            name: "Local server API key",
            resolve: async () => ({ auth: { apiKey: key ?? NO_KEY }, source: key ? "Settings" : "none" }),
          },
        } as never,
        models: [model] as never,
        api: openAICompletionsApi(),
      }) as never,
    );
    return { models: this.#models, model };
  }

  /**
   * pi-ai's description of one served model. The request is the plain OpenAI shape every local
   * server reads: the system role, `max_tokens`, no `store`, no strict tool schemas and no reasoning
   * dial, which servers either reject or read in their own ways.
   */
  #piModel(saved: SavedServer, row: EngineModel): Record<string, unknown> {
    return {
      id: row.id,
      name: row.label,
      api: "openai-completions",
      provider: this.id,
      baseUrl: saved.url,
      reasoning: false,
      supportsTools: row.supportsTools,
      input: row.supportsVision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    };
  }

  /** What the server said, with the key taken out and any other secret redacted. */
  #redacted(said: string, key: string | null): string {
    return redactSecrets(redactValues(said, key ? [key] : []));
  }

  /** An HTTP failure: a request too long for the model's context by its typed code, else by its status. */
  #httpFailure(status: number, message: string): EngineError {
    if (message.includes(CONTEXT_EXCEEDED)) return new EngineError(EngineFailureKind.ContextOverflow, this.id, message);
    return classifyHttpFailure(this.id, status, message);
  }

  /**
   * A failure that arrived through the stream: an HTTP status it names, a cut connection, or as
   * said. Whatever the server said is redacted first: no key ever rides an error into a log.
   */
  #streamFailure(said: string, saved: SavedServer, key: string | null): EngineError {
    const message = this.#redacted(said, key);
    const status = streamHttpStatus(message);
    if (status !== null) return this.#httpFailure(status, message);
    if (!isCutConnection(message)) return new EngineError(EngineFailureKind.Other, this.id, message);
    const cut = new EngineError(EngineFailureKind.Other, this.id, MESSAGE.Cut(where(saved.url)));
    CUT_CONNECTIONS.add(cut);
    return cut;
  }

  /** Any failure as an engine error: one already, an HTTP status the client threw, or the stream's words. */
  #engineError(err: unknown, saved: SavedServer, key: string | null): EngineError {
    if (err instanceof EngineError) return err;
    const error = err as Error & { status?: number };
    if (error.status) return this.#httpFailure(error.status, this.#redacted(error.message, key));
    return this.#streamFailure(error.message, saved, key);
  }

  /**
   * What a failed completion throws, as an engine error the run policy can act on. A cut whose
   * server no longer answers at all is the server stopped: a failure another engine can take over.
   */
  async #failure(err: unknown, request: CompleteRequest, saved: SavedServer, key: string | null): Promise<EngineError> {
    // An abort wins over whatever error it caused — a stop must never read as a failure.
    if (request.signal?.aborted) return new EngineError(EngineFailureKind.Aborted, this.id, STOPPED_BY_USER);
    const failure = this.#engineError(err, saved, key);
    if (!CUT_CONNECTIONS.has(failure)) return failure;
    const list = await readModelList({ url: saved.url, key }, STATUS_TIMEOUT_MS);
    if (list.answer !== ListAnswer.NotAnswering) return failure;
    return new EngineError(
      EngineFailureKind.Unavailable,
      this.id,
      `${MESSAGE.NotAnswering(where(saved.url))} ${MESSAGE.StartRemedy}`,
    );
  }
}
