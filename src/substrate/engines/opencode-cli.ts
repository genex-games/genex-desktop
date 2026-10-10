/**
 * What the studio reads from the `opencode` CLI outside a session: the models it can run, as
 * `opencode models --verbose` lists them, and the settings every session is started with.
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
const DEFAULT_CONTEXT_TOKENS = 32_768;
/** A reply may use this many tokens when the listing gives no output limit. */
const DEFAULT_REPLY_TOKENS = 8_192;
/** A model's line in `opencode models --verbose`: `provider/model`, alone on its line. */
const MODEL_LINE = /^([\w.@-]+)\/(\S+)$/;
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

/** The two command lines OpenCode has spoken: 1.18's, and 2.x's (a background service, `#variant`). */
export const OpenCodeDialect = {
  V1: "v1",
  V2: "v2",
} as const;
export type OpenCodeDialect = (typeof OpenCodeDialect)[keyof typeof OpenCodeDialect];

/** Why an OpenCode version is not run: unreadable, older than Genex runs, or a major Genex does not know. */
export const OpenCodeVersionProblem = {
  Unreadable: "unreadable",
  TooOld: "too-old",
  TooNew: "too-new",
} as const;
export type OpenCodeVersionProblem = (typeof OpenCodeVersionProblem)[keyof typeof OpenCodeVersionProblem];

/** OpenCode's own sign-in command: on 2.x on a private server, as every session runs, never the shared one. */
export function openCodeSignInArgs(version: string | undefined): string[] {
  const release = openCodeRelease(version);
  const v2 = "dialect" in release && release.dialect === OpenCodeDialect.V2;
  return v2 ? ["auth", "login", "--standalone"] : ["auth", "login"];
}

/** A version as its three numbers. */
type VersionNumbers = readonly [major: number, minor: number, patch: number];
/** The oldest 2.x Genex runs (the first Homebrew shipped), and the newest it has been tested on. */
const OLDEST_V2: VersionNumbers = [2, 0, 20];
const NEWEST_TESTED_V2: VersionNumbers = [2, 0, 26];
/** `1.18.35`, `opencode v2.0.20`: the first dotted triple in what `--version` prints. */
const VERSION_NUMBERS = /(\d+)\.(\d+)\.(\d+)/;

/** What an `opencode --version` line says Genex can do with that CLI. */
export type OpenCodeRelease =
  | { dialect: OpenCodeDialect; major: number; tested: boolean }
  | { problem: OpenCodeVersionProblem; major: number | null };

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b`. */
function compareVersions(a: VersionNumbers, b: VersionNumbers): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/**
 * Which command line an OpenCode CLI speaks, read from its version: 1.x is 1.18's (its flags decide
 * the rest), 2.x from 2.0.20 is 2's, newer 2.x than Genex has tested still runs. Anything else
 * is refused, never guessed: a 2.x CLI given 1.18's config would run without its deny rules.
 */
export function openCodeRelease(version: string | undefined): OpenCodeRelease {
  const match = VERSION_NUMBERS.exec(version ?? "");
  if (!match) return { problem: OpenCodeVersionProblem.Unreadable, major: null };
  const numbers: VersionNumbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [major] = numbers;
  if (major === 1) return { dialect: OpenCodeDialect.V1, major, tested: true };
  if (major > 2) return { problem: OpenCodeVersionProblem.TooNew, major };
  if (major < 2 || compareVersions(numbers, OLDEST_V2) < 0) return { problem: OpenCodeVersionProblem.TooOld, major };
  return { dialect: OpenCodeDialect.V2, major, tested: compareVersions(numbers, NEWEST_TESTED_V2) <= 0 };
}

/** One model as `opencode models --verbose` prints it: the fields the studio reads. */
interface ListedModel {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  status?: unknown;
  api?: { url?: unknown };
  cost?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  capabilities?: {
    reasoning?: unknown;
    toolcall?: unknown;
    input?: { image?: unknown };
    output?: Record<string, unknown>;
  };
  variants?: unknown;
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
 * Can the studio's builds run on it: it calls tools, is not retired, and answers with text alone
 * (an image or audio generator is no coding model, though it may call tools).
 */
function runsBuilds(listed: ListedModel): boolean {
  if (listed.capabilities?.toolcall !== true || listed.status === DEPRECATED) return false;
  const output = Object.entries(listed.capabilities.output ?? {});
  return output.every(([modality, on]) => modality === "text" || on !== true);
}

/** The hosts a provider answers on: the address its listing names, and its built-in hosts. */
function providerHosts(provider: string, url: unknown): string[] {
  const listed = apiHost(url);
  return [...new Set([...(listed ? [listed] : []), ...(PROVIDER_HOSTS[provider] ?? [])])];
}

/** The reasoning variants a model offers (`--variant`), in the order OpenCode lists them. */
function variants(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value);
}

/** What a picker row is made from, whichever listing named the model. */
interface ModelFacts {
  provider: string;
  /** The id `--model` takes after `provider/`. */
  model: string;
  name: unknown;
  context: unknown;
  output: unknown;
  vision: boolean;
  thinking: boolean;
  efforts: string[];
  inputPrice: number;
  outputPrice: number;
  url: unknown;
}

/** A model as a picker row (its id `provider/model`, what `--model` takes) and the hosts it reaches. */
function openCodeRow(facts: ModelFacts): OpenCodeModel {
  const { provider, model, efforts, inputPrice, outputPrice } = facts;
  const anonymous = provider === OWN_PROVIDER && inputPrice === 0 && outputPrice === 0;
  const row: EngineModel = {
    id: `${provider}/${model}`,
    label: typeof facts.name === "string" && facts.name ? facts.name : model,
    contextWindow: positive(facts.context) ?? DEFAULT_CONTEXT_TOKENS,
    contextSource: positive(facts.context) ? ModelContextSource.Catalog : ModelContextSource.Unknown,
    maxTokens: positive(facts.output) ?? DEFAULT_REPLY_TOKENS,
    supportsTools: true,
    supportsVision: facts.vision,
    supportsThinking: facts.thinking,
    ...(efforts.length
      ? { efforts, defaultEffort: efforts.includes(ReasoningEffort.Low) ? ReasoningEffort.Low : efforts[0] }
      : {}),
    note: priceNote(provider, inputPrice, outputPrice),
    ...(anonymous ? { free: true } : {}),
  };
  return { row, hosts: providerHosts(provider, facts.url), anonymous };
}

/**
 * One listed model as a picker row, or null for a model that cannot call tools (OpenCode's agent
 * needs them) or that OpenCode marks deprecated.
 */
export function openCodeModel(listed: ListedModel): OpenCodeModel | null {
  const provider = typeof listed.providerID === "string" ? listed.providerID : "";
  const model = typeof listed.id === "string" ? listed.id : "";
  if (!provider || !model || !runsBuilds(listed)) return null;
  return openCodeRow({
    provider,
    model,
    name: listed.name,
    context: listed.limit?.context,
    output: listed.limit?.output,
    vision: listed.capabilities?.input?.image === true,
    thinking: listed.capabilities?.reasoning === true,
    efforts: variants(listed.variants),
    inputPrice: price(listed.cost?.input),
    outputPrice: price(listed.cost?.output),
    url: listed.api?.url,
  });
}

/**
 * `opencode models --verbose`: each model's `provider/model` line, then its JSON object, the
 * object's closing brace alone at the start of a line. A listing that holds no readable model at
 * all is refused rather than read as "nothing installed".
 */
export function parseOpenCodeModels(stdout: string): OpenCodeModel[] {
  const lines = stdout.split(/\r?\n/);
  const models: OpenCodeModel[] = [];
  let found = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!MODEL_LINE.test(lines[index]?.trim() ?? "") || lines[index + 1] !== "{") continue;
    const end = lines.indexOf("}", index + 1);
    if (end < 0) break;
    found++;
    const parsed = parseObject(lines.slice(index + 1, end + 1).join("\n"));
    const model = parsed ? openCodeModel(parsed) : null;
    if (model) models.push(model);
    index = end;
  }
  if (!found && stdout.trim()) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  return models;
}

function parseObject(text: string): ListedModel | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as ListedModel) : null;
  } catch {
    return null;
  }
}

/** One model in 2.x's `GET /api/model`: the fields the studio reads. */
interface ApiModel {
  /** What `--model` takes after `provider/`; the provider's own `modelID` may differ. */
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
  status?: unknown;
  enabled?: unknown;
  settings?: { baseURL?: unknown };
  /** Prices by context tier, the base tier first. */
  cost?: Array<{ input?: unknown; output?: unknown }>;
  limit?: { context?: unknown; output?: unknown };
  capabilities?: { tools?: unknown; input?: unknown; output?: unknown };
  variants?: Array<{ id?: unknown }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The variant 2.x names for "the model's own default": no effort of its own. */
const DEFAULT_VARIANT = "default";

/** A 2.x model the studio's builds can run on: it calls tools, is on and not retired, and answers in text. */
function runsBuildsV2(listed: ApiModel): boolean {
  if (listed.capabilities?.tools !== true || listed.enabled === false || listed.status === DEPRECATED) return false;
  const output = listed.capabilities.output;
  return !Array.isArray(output) || output.every((modality) => modality === "text");
}

/** A 2.x model's reasoning variants (`--model provider/model#variant`), in the order it lists them. */
function variantIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((variant) => {
    const id = record(variant).id;
    return typeof id === "string" && id && id !== DEFAULT_VARIANT ? [id] : [];
  });
}

/** One 2.x model as a picker row, or null for one the studio's builds cannot run on. */
function openCodeApiModel(listed: ApiModel): OpenCodeModel | null {
  const provider = typeof listed.providerID === "string" ? listed.providerID : "";
  const model = typeof listed.id === "string" ? listed.id : "";
  if (!provider || !model || !runsBuildsV2(listed)) return null;
  const efforts = variantIds(listed.variants);
  const input = listed.capabilities?.input;
  return openCodeRow({
    provider,
    model,
    name: listed.name,
    context: listed.limit?.context,
    output: listed.limit?.output,
    vision: Array.isArray(input) && input.includes("image"),
    thinking: efforts.length > 0,
    efforts,
    inputPrice: price(listed.cost?.[0]?.input),
    outputPrice: price(listed.cost?.[0]?.output),
    url: listed.settings?.baseURL,
  });
}

/**
 * 2.x's `GET /api/model` (`{ location, data }`): the models its sign-ins (and its free OpenCode Zen
 * models) run. Empty output is nothing signed in; anything that is not such a listing is refused
 * rather than read as "nothing installed".
 */
export function parseOpenCodeApiModels(stdout: string): OpenCodeModel[] {
  if (!stdout.trim()) return [];
  let data: unknown;
  try {
    data = record(JSON.parse(stdout) as unknown).data;
  } catch {
    data = undefined;
  }
  if (!Array.isArray(data)) throw new CatalogError(ModelCatalogProblemCode.Malformed, MESSAGE.Malformed);
  return data.flatMap((entry) => {
    const model = openCodeApiModel(record(entry) as ApiModel);
    return model ? [model] : [];
  });
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

/** The studio bridge's command, as OpenCode's bash permission matches it. */
const BRIDGE_PATTERN = "node .studio/bridge/tool.mjs *";

/** The bash rules for each access: always allow or deny, never ask — `opencode run` has nobody to ask. */
function bashRules(access: OpenCodeAccess, bridge: boolean): string | Record<string, string> {
  if (access === OpenCodeAccess.Build) return "allow";
  if (access === OpenCodeAccess.ReadOnly && bridge) return { "*": "deny", [BRIDGE_PATTERN]: "allow" };
  return "deny";
}

/**
 * The config every session runs with (`OPENCODE_CONFIG_CONTENT`), over the person's own: no
 * question is ever asked (`run` cannot ask), no web fetch, no sharing and no self-update. A build
 * reaches nothing outside its workspace through OpenCode's own tools; a read-only session, which
 * runs from a scratch folder, may read the game it looks at by its full path, and changes nothing.
 * The studio's sandbox is the boundary either way; these rules keep the model from even trying.
 */
export function openCodeConfig(access: OpenCodeAccess, bridge: boolean): string {
  const looking = access !== OpenCodeAccess.Answer;
  const look = looking ? "allow" : "deny";
  const permission = {
    edit: access === OpenCodeAccess.Build ? "allow" : "deny",
    bash: bashRules(access, bridge),
    read: look,
    glob: look,
    grep: look,
    list: look,
    webfetch: "deny",
    websearch: "deny",
    external_directory: access === OpenCodeAccess.ReadOnly ? "allow" : "deny",
    doom_loop: "deny",
    // Genex's sessions load no skill: not the person's own (`~/.config/opencode/skills`), not a game's.
    skill: "deny",
  };
  return JSON.stringify({ permission, autoupdate: false, share: "disabled" });
}

/** One 2.x permission rule. The last rule that matches a call decides it. */
interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

/** A rule for every resource of one action. */
const rule = (action: string, effect: PermissionRule["effect"]): PermissionRule => ({ action, resource: "*", effect });

/** The agent every 2.x session runs (`--agent`): OpenCode's own builder. */
export const OPENCODE_AGENT = "build";

/** 2.x's shell rules for each access: a build runs commands, a read-only session only the studio bridge. */
function shellRulesV2(access: OpenCodeAccess, bridge: boolean): PermissionRule[] {
  if (access === OpenCodeAccess.Build) return [rule("shell", "allow")];
  if (access === OpenCodeAccess.ReadOnly && bridge)
    return [rule("shell", "deny"), { action: "shell", resource: BRIDGE_PATTERN, effect: "allow" }];
  return [rule("shell", "deny")];
}

/**
 * 2.x's config, as `openCodeConfig` is 1.18's. 2.x allows every tool it has no rule for, so the
 * rules open with a deny of everything and allow only what the access needs: a tool a later
 * OpenCode adds is denied, never asked about. They are set for the agent the session runs too,
 * after any the person's own config gives it, so theirs cannot widen them. No question is asked,
 * no web fetch, skill or subagent runs, nothing is shared and nothing updates itself.
 */
export function openCodeConfigV2(access: OpenCodeAccess, bridge: boolean): string {
  const look = access === OpenCodeAccess.Answer ? "deny" : "allow";
  const permissions: PermissionRule[] = [
    rule("*", "deny"),
    rule("edit", access === OpenCodeAccess.Build ? "allow" : "deny"),
    ...shellRulesV2(access, bridge),
    rule("read", look),
    rule("glob", look),
    rule("grep", look),
    rule("external_directory", access === OpenCodeAccess.ReadOnly ? "allow" : "deny"),
    rule("webfetch", "deny"),
    rule("websearch", "deny"),
    rule("skill", "deny"),
    rule("subagent", "deny"),
    rule("question", "deny"),
  ];
  return JSON.stringify({
    permissions,
    agents: { [OPENCODE_AGENT]: { permissions } },
    share: "disabled",
    update: "disable",
  });
}
