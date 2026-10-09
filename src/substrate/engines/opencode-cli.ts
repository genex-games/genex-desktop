/**
 * What the studio reads from the `opencode` CLI outside a session: the models it can run, as
 * `opencode api get /api/model` lists them, and the settings every session is started with.
 *
 * OpenCode keeps its own sign-ins (`opencode auth login`) and lists exactly the models those
 * sign-ins (and its free OpenCode Zen models) can run, so the list is also how the studio knows
 * whether OpenCode is usable: the studio never reads OpenCode's credentials.
 */
import { CatalogError } from "./model-catalog.ts";
import type { EngineModel } from "./types.ts";
import { ModelContextSource } from "./types.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";

/** A model whose context the listing does not give is assumed to have this much. */
const DEFAULT_CONTEXT_TOKENS = 200_000;
/** A reply may use this many tokens when the listing gives no output limit. */
const DEFAULT_REPLY_TOKENS = 32_000;
/** The model status OpenCode marks a retired model with. */
const DEPRECATED = "deprecated";
/** OpenCode's own provider (OpenCode Zen): it lists its free models to anyone, signed in or not. */
const OWN_PROVIDER = "opencode";
/**
 * Where a built-in provider answers when OpenCode's listing names no address (its AI SDK's
 * default), plus the hosts its browser sign-in uses (a ChatGPT plan answers on chatgpt.com and
 * refreshes its token on auth.openai.com). A provider missing here reaches only its listed address.
 */
const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  "google-vertex": ["*.googleapis.com"],
  "google-vertex-anthropic": ["*.googleapis.com"],
  "amazon-bedrock": ["*.amazonaws.com"],
  azure: ["*.openai.azure.com", "*.cognitiveservices.azure.com"],
  "azure-cognitive-services": ["*.cognitiveservices.azure.com"],
  "github-copilot": ["api.github.com"],
  cerebras: ["api.cerebras.ai"],
  cohere: ["api.cohere.com"],
  deepinfra: ["api.deepinfra.com"],
  groq: ["api.groq.com"],
  mistral: ["api.mistral.ai"],
  perplexity: ["api.perplexity.ai"],
  togetherai: ["api.together.xyz"],
  xai: ["api.x.ai"],
  vercel: ["ai-gateway.vercel.sh"],
};

const MESSAGE = {
  Malformed: "OpenCode's model list could not be read.",
} as const;

/** One model in `api get /api/model`: the fields the studio reads. */
interface ApiModel {
  modelID?: unknown;
  providerID?: unknown;
  name?: unknown;
  status?: unknown;
  enabled?: unknown;
  settings?: { baseURL?: unknown };
  cost?: Array<{ input?: unknown; output?: unknown }>;
  limit?: { context?: unknown; output?: unknown };
  capabilities?: { tools?: unknown; input?: unknown; output?: unknown };
  variants?: Array<{ id?: unknown }>;
}

/** A model OpenCode can run, and the host its provider answers on (for the sandbox's network). */
export interface OpenCodeModel {
  row: EngineModel;
  /** The hosts its provider answers on (`opencode.ai`; `api.openai.com` and its sign-in's), for the sandbox. */
  hosts: string[];
  /** One of OpenCode's own free models, which it runs with no sign-in at all. */
  anonymous: boolean;
}

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const price = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The price line a picker row shows (dollars per million tokens), or "Free". */
function priceNote(provider: string, input: number, output: number): string {
  if (input === 0 && output === 0) return `${provider} · Free`;
  return `${provider} · $${input.toFixed(2)} in / $${output.toFixed(2)} out per M tokens`;
}

/** The host of a provider's API URL, or null for a missing or non-HTTPS one. */
function apiHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Can the studio's builds run on it: it calls tools, is not disabled or retired, and answers with
 * text alone (an image generator is no coding model, though it calls tools). A listing that names
 * no output keeps the documented fallback assumption of text.
 */
function runsBuilds(listed: ApiModel): boolean {
  if (listed.capabilities?.tools !== true || listed.enabled === false || listed.status === DEPRECATED) return false;
  const output = listed.capabilities?.output;
  return !Array.isArray(output) || output.every((modality) => modality === "text");
}

/** The hosts a provider answers on: the address its settings name, and its built-in hosts. */
function providerHosts(provider: string, baseURL: unknown): string[] {
  const listed = typeof baseURL === "string" ? apiHost(baseURL) : null;
  return [...new Set([...(listed ? [listed] : []), ...(PROVIDER_HOSTS[provider] ?? [])])];
}

/** A reasoning variant that disables thinking: the absence of a dial, not an effort. */
const NO_REASONING_VARIANT = "none";

/** The reasoning efforts a model offers (`--model provider/model#effort`), in the order listed. */
function variantIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((variant) => (variant && typeof variant === "object" ? (variant as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id !== NO_REASONING_VARIANT);
}

/**
 * One listed model as a picker row, or null for a model that cannot call tools (OpenCode's agent
 * needs them) or that OpenCode disables or marks deprecated. Its id is `provider/model`, what
 * `--model` takes.
 */
export function openCodeApiModel(listed: ApiModel): OpenCodeModel | null {
  const provider = typeof listed.providerID === "string" ? listed.providerID : "";
  const model = typeof listed.modelID === "string" ? listed.modelID : "";
  if (!provider || !model) return null;
  if (!runsBuilds(listed)) return null;
  const contextWindow = positive(listed.limit?.context) ?? DEFAULT_CONTEXT_TOKENS;
  const efforts = variantIds(listed.variants);
  const input = price(listed.cost?.[0]?.input);
  const output = price(listed.cost?.[0]?.output);
  const row: EngineModel = {
    id: `${provider}/${model}`,
    label: typeof listed.name === "string" && listed.name ? listed.name : model,
    contextWindow,
    contextSource: positive(listed.limit?.context) ? ModelContextSource.Catalog : ModelContextSource.Unknown,
    maxTokens: positive(listed.limit?.output) ?? DEFAULT_REPLY_TOKENS,
    supportsTools: true,
    supportsVision: Array.isArray(listed.capabilities?.input) && listed.capabilities.input.includes("image"),
    supportsThinking: efforts.length > 0,
    ...(efforts.length
      ? { efforts, defaultEffort: efforts.includes(ReasoningEffort.Low) ? ReasoningEffort.Low : efforts[0] }
      : {}),
    note: priceNote(provider, input, output),
  };
  const anonymous = provider === OWN_PROVIDER && input === 0 && output === 0;
  return { row, hosts: providerHosts(provider, listed.settings?.baseURL), anonymous };
}

/**
 * `api get /api/model`, as `{ location, data }` or a bare array. Non-object entries are skipped;
 * a value with no model array at all is refused rather than read as "nothing installed". An empty
 * listing is nothing signed in, not an error.
 */
export function parseOpenCodeApiModels(value: unknown): OpenCodeModel[] {
  const data = value && typeof value === "object" && !Array.isArray(value) ? (value as { data?: unknown }).data : value;
  if (!Array.isArray(data)) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  const models: OpenCodeModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const model = openCodeApiModel(entry as ApiModel);
    if (model) models.push(model);
  }
  return models;
}

/** `opencode api get /api/model` stdout as models: unparsable output is refused as malformed. */
export function parseOpenCodeListing(stdout: string): OpenCodeModel[] {
  if (!stdout.trim()) return [];
  try {
    return parseOpenCodeApiModels(JSON.parse(stdout) as unknown);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  }
}

/** What a session's OpenCode tools may do: edit and run commands, only look, or neither. */
export const OpenCodeAccess = {
  /** A build: edits and commands in its workspace. */
  Build: "build",
  /** A read-only session (a judge, a lead while its build runs, Plan): looks, and runs only the studio bridge. */
  ReadOnly: "read-only",
  /** A one-shot answer (`complete`): no tool at all. */
  Answer: "answer",
} as const;
export type OpenCodeAccess = (typeof OpenCodeAccess)[keyof typeof OpenCodeAccess];

/** One V2 permission rule: the last matching rule wins. */
interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

/** The studio bridge's command, as OpenCode's shell permission matches it. */
const BRIDGE_PATTERN = "node .studio/bridge/tool.mjs *";

/** The shell rules for each access: always allow or deny, never ask — `opencode run` has nobody to ask. */
function shellRules(access: OpenCodeAccess, bridge: boolean): PermissionRule[] {
  if (access === OpenCodeAccess.Build) return [{ action: "shell", resource: "*", effect: "allow" }];
  if (access === OpenCodeAccess.ReadOnly && bridge)
    return [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: BRIDGE_PATTERN, effect: "allow" },
    ];
  return [{ action: "shell", resource: "*", effect: "deny" }];
}

/**
 * The config every session runs with (`OPENCODE_CONFIG_CONTENT`), over the person's own: no
 * question is ever asked (`run` cannot ask), no web fetch, no sharing and no self-update. A build
 * reaches nothing outside its workspace through OpenCode's own tools; a read-only session, which
 * runs from a scratch folder, may read the game it looks at by its full path, and changes nothing.
 * Game-shipped plugins are switched off (`plugins: []`); the studio's sandbox is the boundary
 * either way, and the leading wildcard denies any action with no rule below it, so a future tool the
 * rules never heard of is denied rather than asked about.
 */
export function openCodeConfig(access: OpenCodeAccess, bridge: boolean): string {
  const looking = access !== OpenCodeAccess.Answer;
  const look: PermissionRule["effect"] = looking ? "allow" : "deny";
  const edit: PermissionRule["effect"] = access === OpenCodeAccess.Build ? "allow" : "deny";
  const permissions: PermissionRule[] = [
    // Closed world first: broad defaults precede exceptions, so an action with no rule below is
    // denied, never asked.
    { action: "*", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: edit },
    ...shellRules(access, bridge),
    { action: "read", resource: "*", effect: look },
    { action: "glob", resource: "*", effect: look },
    { action: "grep", resource: "*", effect: look },
    { action: "list", resource: "*", effect: look },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "skill", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: access === OpenCodeAccess.ReadOnly ? "allow" : "deny" },
  ];
  return JSON.stringify({ permissions, plugins: [], share: "manual", update: "disable" });
}
