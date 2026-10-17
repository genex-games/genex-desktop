/**
 * What a local server says about itself through its OpenAI-compatible API and, where it has them,
 * its own endpoints: whether it answers, which software it is, and each model's context, vision and
 * tool calling. Every request is a bounded GET (or Ollama's POST `/api/show`) to the saved address;
 * nothing here writes or downloads anything.
 *
 * The standard list (`GET {base}/models`) names models only. The rest is each server's own:
 * - llama.cpp: `meta.n_ctx` (runtime, per slot) and `architecture.input_modalities` on each entry;
 *   `/props` adds `modalities.vision` and `chat_template_caps.supports_tools`.
 * - TabbyAPI: `owned_by: "tabbyAPI"`, `meta.n_ctx` for the loaded model; `/props` as llama.cpp's.
 * - KoboldCpp: `owned_by: "koboldcpp"`; `/props` with `modalities.vision`.
 * - LM Studio: `/api/v1/models` (0.4+) or `/api/v0/models`: type, loaded context and vision.
 * - vLLM: `max_model_len` on each entry.
 * - Ollama: `/api/show` capabilities and `/api/ps` runtime context, as the Ollama engine reads them.
 */
import { OllamaClient } from "../engines/ollama.ts";
import { type EngineModel, ModelContextSource } from "../engines/types.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type FoundLocalServer, LocalServerKind } from "../../shared/local-server.ts";

/** How long one discovery request waits. */
export const DISCOVERY_TIMEOUT_MS = 10 * SECOND_MS;
/** The largest discovery answer read; a model list is a few kilobytes. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** A model whose context the server does not report is planned for this much. */
export const UNKNOWN_CONTEXT_TOKENS = 32_768;
/** A reply may use a quarter of the context, up to this many tokens. */
const MAX_REPLY_TOKENS = 32_768;
/** The statuses a server answers when it wants an API key. */
const KEY_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** What `GET {base}/models` came back as. Wire values: never rename one. */
export const ListAnswer = {
  Models: "models",
  NeedsKey: "needs_key",
  NotOpenAi: "not_openai",
  NotAnswering: "not_answering",
} as const;
export type ListAnswer = (typeof ListAnswer)[keyof typeof ListAnswer];

/** A server's address and the key to reach it with. */
export interface ServerAccess {
  url: string;
  key: string | null;
}

/** One entry of a model list: the standard fields and the servers' own. */
export interface ListedModel {
  id?: unknown;
  owned_by?: unknown;
  max_model_len?: unknown;
  context_length?: unknown;
  meta?: { n_ctx?: unknown; n_ctx_train?: unknown };
  architecture?: { input_modalities?: unknown };
}

/** The model list's answer, with the `Server` header it came with. */
export type ModelList =
  | { answer: typeof ListAnswer.Models; entries: ListedModel[]; server: string | null }
  | { answer: typeof ListAnswer.NeedsKey; server: string | null }
  | { answer: typeof ListAnswer.NotOpenAi }
  | { answer: typeof ListAnswer.NotAnswering; detail: string };

/** The headers that carry a key: the OpenAI bearer, and the `x-api-key` TabbyAPI and Jan also read. */
export function keyHeaders(key: string | null): Record<string, string> {
  return key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {};
}

/** The origin of a base URL (`http://127.0.0.1:5000/v1` → `http://127.0.0.1:5000`), where servers keep their own endpoints. */
export const originOf = (url: string): string => new URL(url).origin;

/** A response body as text, refused past `MAX_ANSWER_BYTES` so a misbehaving server cannot fill memory. */
async function cappedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** A JSON answer, or null for anything that is not one (an error page, an AirPlay receiver, a cut). */
async function jsonOf(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const text = await cappedText(response).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** GET a URL with the key, given up on after `timeoutMs`; null when nothing answers. */
async function get(url: string, key: string | null, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { headers: keyHeaders(key), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch {
    return null;
  }
}

/** GET a server's own JSON endpoint; null for no answer, a refusal or anything but JSON. */
async function getJson(url: string, key: string | null, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<unknown> {
  const response = await get(url, key, timeoutMs);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    return null;
  }
  return jsonOf(response);
}

/** Ask a server for its models: the list, a request for a key, something else, or no answer. */
export async function readModelList(access: ServerAccess, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<ModelList> {
  let response: Response;
  try {
    response = await fetch(`${access.url}/models`, {
      headers: keyHeaders(access.key),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    return { answer: ListAnswer.NotAnswering, detail: errorMessage(err) };
  }
  const server = response.headers.get("server");
  const body = await jsonOf(response);
  // Only a JSON refusal is a server asking for its key: macOS's AirPlay receiver answers 403 on port 5000.
  if (KEY_STATUSES.has(response.status))
    return body === null ? { answer: ListAnswer.NotOpenAi } : { answer: ListAnswer.NeedsKey, server };
  const data = response.ok ? (body as { data?: unknown } | null)?.data : undefined;
  if (!Array.isArray(data)) return { answer: ListAnswer.NotOpenAi };
  const entries = data.filter(
    (entry): entry is ListedModel => Boolean(entry) && typeof (entry as ListedModel).id === "string",
  );
  return { answer: ListAnswer.Models, entries, server };
}

/** The software each `owned_by` names, where it names one. Vendor spellings. */
const OWNERS: Readonly<Record<string, LocalServerKind>> = {
  tabbyAPI: LocalServerKind.TabbyApi,
  llamacpp: LocalServerKind.LlamaCpp,
  koboldcpp: LocalServerKind.KoboldCpp,
  vllm: LocalServerKind.Vllm,
};

/** The `Server` header llama-server sends on every answer, a refusal included. Vendor spelling. */
const LLAMA_CPP_HEADER = "llama.cpp";
/** What Ollama answers at its root. Vendor spelling. */
const OLLAMA_ROOT = "Ollama is running";

/** The software its model list's `owned_by` names, when every entry names the same one. */
function ownerKind(list: ModelList): LocalServerKind | null {
  if (list.answer !== ListAnswer.Models || list.entries.length === 0) return null;
  const owners = new Set(list.entries.map((entry) => entry.owned_by));
  const [owner] = owners;
  return owners.size === 1 && typeof owner === "string" && Object.hasOwn(OWNERS, owner) ? OWNERS[owner] : null;
}

/** A nested field of a JSON answer, or undefined when any step of the path is missing. */
export function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** One server's own signature: an endpoint only it answers that way. */
interface Signature {
  kind: LocalServerKind;
  matches: (origin: string, key: string | null, timeoutMs: number) => Promise<boolean>;
}

/** Each server's own signature, asked side by side; TabbyAPI and KoboldCpp come first, as both answer llama-shaped `/props`. */
const SIGNATURES: readonly Signature[] = [
  {
    kind: LocalServerKind.TabbyApi,
    matches: async (origin, key, timeoutMs) =>
      field(await getJson(`${origin}/.well-known/serviceinfo`, key, timeoutMs), "software", "name") === "TabbyAPI",
  },
  {
    kind: LocalServerKind.KoboldCpp,
    matches: async (origin, key, timeoutMs) =>
      field(await getJson(`${origin}/api/extra/version`, key, timeoutMs), "result") === "KoboldCpp",
  },
  {
    kind: LocalServerKind.LmStudio,
    matches: async (origin, key, timeoutMs) =>
      field(await getJson(`${origin}/lmstudio-greeting`, key, timeoutMs), "lmstudio") === true,
  },
  {
    kind: LocalServerKind.Ollama,
    matches: async (origin, key, timeoutMs) => (await rootText(origin, key, timeoutMs)) === OLLAMA_ROOT,
  },
];

/** The plain text a server answers at its root, trimmed; null for anything else. */
async function rootText(origin: string, key: string | null, timeoutMs: number): Promise<string | null> {
  const response = await get(`${origin}/`, key, timeoutMs);
  if (!response?.ok) return null;
  return ((await cappedText(response).catch(() => null)) ?? "").trim();
}

/**
 * Which software answers at a server: by its model list's owner, llama-server's header, then each
 * server's own signature endpoint. Null when it is none the app knows; it still runs as a server.
 */
export async function identifyServer(
  access: ServerAccess,
  list: ModelList,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<LocalServerKind | null> {
  const owner = ownerKind(list);
  if (owner) return owner;
  const header = "server" in list ? list.server : null;
  if (header?.toLowerCase().startsWith(LLAMA_CPP_HEADER)) return LocalServerKind.LlamaCpp;
  const origin = originOf(access.url);
  const found = await Promise.all(
    SIGNATURES.map((signature) => signature.matches(origin, access.key, timeoutMs).catch(() => false)),
  );
  return SIGNATURES.find((_, index) => found[index])?.kind ?? null;
}

// ── each model's context, vision and tool calling ─────────────────────────────────────────────

/** What is known of one model beyond its id; a fact nobody reported stays undefined. */
interface ModelFacts {
  label?: string;
  context?: { tokens: number; source: ModelContextSource };
  vision?: boolean;
  tools?: boolean;
  /** Not a chat model (an embedding model): left out of the list. */
  skip?: boolean;
}

/** What a row says when its server reports no context for it. */
const MESSAGE = {
  UnknownContext: "Context size not reported",
} as const;

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const runtime = (tokens: number | undefined): ModelFacts["context"] =>
  tokens ? { tokens, source: ModelContextSource.Configured } : undefined;
const maximum = (tokens: number | undefined): ModelFacts["context"] =>
  tokens ? { tokens, source: ModelContextSource.Catalog } : undefined;

/** The facts one entry of the standard list carries: its runtime context first, then the model's most. */
function entryFacts(entry: ListedModel): ModelFacts {
  const inputs = entry.architecture?.input_modalities;
  const context =
    runtime(positive(entry.meta?.n_ctx) ?? positive(entry.max_model_len) ?? positive(entry.context_length)) ??
    maximum(positive(entry.meta?.n_ctx_train));
  return { ...(context ? { context } : {}), ...(Array.isArray(inputs) ? { vision: inputs.includes("image") } : {}) };
}

/** The servers whose `/props` describes the one loaded model. */
const PROPS_SERVERS: ReadonlySet<LocalServerKind> = new Set([
  LocalServerKind.LlamaCpp,
  LocalServerKind.TabbyApi,
  LocalServerKind.KoboldCpp,
]);

/** A single-model server's `/props`: its runtime context, whether it sees, whether its template calls tools. */
async function propsFacts(access: ServerAccess): Promise<ModelFacts | null> {
  const props = await getJson(`${originOf(access.url)}/props`, access.key);
  if (props === null) return null;
  const vision = field(props, "modalities", "vision");
  const tools = field(props, "chat_template_caps", "supports_tools");
  const context = runtime(
    positive(field(props, "default_generation_settings", "n_ctx")) ?? positive(field(props, "n_ctx")),
  );
  return {
    ...(context ? { context } : {}),
    ...(typeof vision === "boolean" ? { vision } : {}),
    ...(typeof tools === "boolean" ? { tools } : {}),
  };
}

/** LM Studio's types that are not chat models. Vendor spellings. */
const LM_STUDIO_NOT_CHAT: ReadonlySet<unknown> = new Set(["embedding", "embeddings"]);

/** One model of LM Studio 0.4's `/api/v1/models`: its name, loaded context and vision. */
function lmStudioModel(model: unknown): ModelFacts {
  const instances = field(model, "loaded_instances");
  const loaded = Array.isArray(instances) ? positive(field(instances[0], "config", "context_length")) : undefined;
  const name = field(model, "display_name");
  const context = runtime(loaded) ?? maximum(positive(field(model, "max_context_length")));
  return {
    ...(typeof name === "string" && name ? { label: name } : {}),
    ...(context ? { context } : {}),
    vision: field(model, "capabilities", "vision") === true,
    skip: LM_STUDIO_NOT_CHAT.has(field(model, "type")),
  };
}

/** One model of LM Studio's older `/api/v0/models`. */
function lmStudioV0Model(model: unknown): ModelFacts {
  const context =
    runtime(positive(field(model, "loaded_context_length"))) ?? maximum(positive(field(model, "max_context_length")));
  return {
    ...(context ? { context } : {}),
    vision: field(model, "type") === "vlm",
    skip: LM_STUDIO_NOT_CHAT.has(field(model, "type")),
  };
}

/** LM Studio's own model list, newest API first, by model id. */
async function lmStudioFacts(access: ServerAccess): Promise<Map<string, ModelFacts>> {
  const origin = originOf(access.url);
  const v1 = field(await getJson(`${origin}/api/v1/models`, access.key), "models");
  if (Array.isArray(v1)) return new Map(v1.map((model) => [String(field(model, "key")), lmStudioModel(model)]));
  const v0 = field(await getJson(`${origin}/api/v0/models`, access.key), "data");
  if (Array.isArray(v0)) return new Map(v0.map((model) => [String(field(model, "id")), lmStudioV0Model(model)]));
  return new Map();
}

/** An Ollama elsewhere on the network: each model's capabilities and loaded context, as the Ollama engine reads them. */
async function ollamaFacts(access: ServerAccess, ids: string[]): Promise<Map<string, ModelFacts>> {
  const client = new OllamaClient(originOf(access.url));
  const facts = await Promise.all(
    ids.map(async (id): Promise<[string, ModelFacts]> => {
      const shown = await client.show(id).catch(() => null);
      if (!shown) return [id, {}];
      const context = await client.runtimeContext(id, shown.contextLength);
      return [
        id,
        {
          context: { tokens: context.tokens, source: context.source },
          tools: shown.capabilities.includes("tools"),
          vision: shown.capabilities.includes("vision"),
        },
      ];
    }),
  );
  return new Map(facts);
}

/** What the server's own endpoints add for each model, by the software it is. */
async function kindFacts(
  access: ServerAccess,
  kind: LocalServerKind | null,
  ids: string[],
): Promise<Map<string, ModelFacts>> {
  if (kind === LocalServerKind.LmStudio) return lmStudioFacts(access);
  if (kind === LocalServerKind.Ollama) return ollamaFacts(access, ids);
  // A router serving several models answers `/props` only per model; its list entries carry the facts.
  if (kind === null || !PROPS_SERVERS.has(kind) || ids.length !== 1) return new Map();
  const props = await propsFacts(access);
  return new Map(props ? [[ids[0], props]] : []);
}

/** Facts from two sources, the later winning wherever it reported something. */
function merged(first: ModelFacts, later: ModelFacts | undefined): ModelFacts {
  if (!later) return first;
  const known = Object.entries(later).filter(([, value]) => value !== undefined);
  return { ...first, ...Object.fromEntries(known) };
}

/** A model as a picker row: unknown context planned for, tool calling taken as given unless refused. */
function modelRow(id: string, facts: ModelFacts): EngineModel {
  const context = facts.context ?? { tokens: UNKNOWN_CONTEXT_TOKENS, source: ModelContextSource.Unknown };
  return {
    id,
    label: facts.label ?? id,
    contextWindow: context.tokens,
    contextSource: context.source,
    maxTokens: Math.min(MAX_REPLY_TOKENS, Math.floor(context.tokens / 4)),
    supportsTools: facts.tools ?? true,
    supportsVision: facts.vision ?? false,
    supportsThinking: false,
    installed: true,
    ...(facts.context ? {} : { note: MESSAGE.UnknownContext }),
  };
}

/** The server's models as picker rows, each with what the server says about its context, vision and tools. */
export async function serverModels(
  access: ServerAccess,
  kind: LocalServerKind | null,
  entries: ListedModel[],
): Promise<EngineModel[]> {
  const ids = entries.map((entry) => String(entry.id));
  const extra = await kindFacts(access, kind, ids).catch(() => new Map<string, ModelFacts>());
  return entries.flatMap((entry) => {
    const id = String(entry.id);
    const facts = merged(entryFacts(entry), extra.get(id));
    return facts.skip ? [] : [modelRow(id, facts)];
  });
}

// ── finding servers on this computer ────────────────────────────────────────────────────────

/**
 * The ports servers listen on by default: TabbyAPI and text-generation-webui, LM Studio,
 * llama.cpp (and its older default, which LocalAI shares), vLLM, KoboldCpp and Jan.
 */
export const LOCAL_SERVER_PORTS: readonly number[] = [5000, 1234, 9931, 8080, 8000, 5001, 1337];
/** How long finding waits on each port: a server on this computer answers at once. */
const FIND_TIMEOUT_MS = 1500;

/** A server answering on one port of this computer, or null for none. */
async function foundOn(port: number, timeoutMs: number): Promise<FoundLocalServer | null> {
  const access: ServerAccess = { url: `http://127.0.0.1:${port}/v1`, key: null };
  const list = await readModelList(access, timeoutMs);
  if (list.answer !== ListAnswer.Models && list.answer !== ListAnswer.NeedsKey) return null;
  const kind = await identifyServer(access, list, timeoutMs).catch(() => null);
  return {
    url: access.url,
    kind,
    needsKey: list.answer === ListAnswer.NeedsKey,
    models: list.answer === ListAnswer.Models ? list.entries.length : 0,
  };
}

/** The model servers answering on this computer's usual ports, side by side. */
export async function findServers(
  ports: readonly number[] = LOCAL_SERVER_PORTS,
  timeoutMs = FIND_TIMEOUT_MS,
): Promise<FoundLocalServer[]> {
  const found = await Promise.all(ports.map((port) => foundOn(port, timeoutMs).catch(() => null)));
  return found.filter((server): server is FoundLocalServer => server !== null);
}
